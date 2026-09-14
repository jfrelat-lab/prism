// app.js — the shell.
//
// It knows nothing about any program. It compiles C in a worker, shows the program on ONE surface —
// a text screen until the program creates a display, its framebuffer afterwards — and forwards
// keystrokes as PC scan codes. Programs are data: web/programs/*.json, discovered at start-up, so
// the genericity is structural rather than asserted.
//
// What the surface is NOT: an emulated VGA. PRISM supplies libc, not hardware, so a program's output
// arrives through `printf` and there is no 0xB8000 to read. The text screen is a faithful
// PRESENTATION of that output, on the same surface the graphics mode uses, because a program that
// prints a banner and then goes graphical did both on one screen. When a DJGPP program eventually
// writes to video memory directly, its platform layer maps that onto this same surface.
//
// The shell's own reporting — compile timings, stubbed headers, functions it could not emit — stays
// in the side pane. A DOS screen never showed "894 functions in 700 ms".

import { makeControl, controlViews, makeKeyboard, makeMouse, wake, KEY_HOLD_FRAMES, AUDIO_RING,
  KBD_EXTENDED, SLOT, STATE } from '../src/env/webhost.js';
import { scancodeForEvent, extendedForEvent } from '../src/env/scancodes.js';
import { makePipe } from '../src/env/pipe.js';
import { VRAM_TEXT, TEXT_COLS, TEXT_ROWS } from '../src/link/module.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const cx = canvas.getContext('2d', { alpha: false });

let worker = null, views = null, guest = null;
let soundWorker = null;
let audioCtx = null, audioNode = null;
let imageData = null, lut = null, palGen = -1;
let statTimer = 0, lastStatAt = 0, lastFrame = 0;

// ---------------------------------------------------------------- the text surface
//
// A REAL text mode, not a canvas-text approximation: the guest keeps an 80x25 character+attribute
// buffer at 0xB8000 (see src/env/console.js) and this draws it with the IBM VGA 8x16 ROM font, one
// pixel at a time into an ImageData — the same way MIRAGE's video.js does it, because it is the same
// problem and MIRAGE already got the details right.
//
// Why bother, when fillText looked almost fine: it wasn't. A proportional fallback font drifts, the
// columns of an ASCII drawing stop lining up, and CP437's box-drawing characters — which every DOS
// program's UI is made of — simply do not exist in a web font. The ROM font has all 256 glyphs and
// each is 8 pixels wide by construction.
const CELL_W = 8, CELL_H = 16;

// The canonical VGA 16-colour text palette. Written out rather than read from a DAC dump because at
// mode 3 an attribute goes through the attribute-controller palette before the DAC, and that mapping
// has a famous irregularity (attribute 6 lands on DAC 20 to make brown rather than dark yellow).
// These sixteen values are the result, exactly, and they need no asset to be right.
const TEXT_PALETTE = new Uint32Array([
  0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa,
  0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff,
].map(rgb => 0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)));

let font = null;                       // 4096 bytes: 256 glyphs x 16 rows, MSB = leftmost pixel
let textImage = null, textU32 = null;
let blink = 0;

fetch('/assets/vga-rom-8x16.bin')
  .then(r => r.arrayBuffer())
  .then(b => { font = new Uint8Array(b); })
  .catch(() => log('could not load assets/vga-rom-8x16.bin — text mode will be blank', 'error'));

/**
 * An 80x25 character+attribute buffer, drawn with the ROM font.
 *
 * TWO callers, and that is the whole point of the parameter: the GUEST's screen at 0xB8000 while a
 * program is running, and the SHELL's own screen before one is. A DOS box did not have a picker
 * drawn over its terminal -- it had the terminal, and you typed at it -- so the machine's prompt and
 * the program that replaces it are the same 640x400 surface, scaled the same way, in the same place.
 */
function paintTextFrom(mem, base, curCol, curRow) {
  const W = TEXT_COLS * CELL_W, H = TEXT_ROWS * CELL_H;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; canvas.height = H;
    textImage = null;
  }
  if (!textImage) {
    textImage = cx.createImageData(W, H);
    textU32 = new Uint32Array(textImage.data.buffer);
  }
  if (!font) { cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H); return; }

  blink++;
  for (let row = 0; row < TEXT_ROWS; row++) {
    for (let col = 0; col < TEXT_COLS; col++) {
      const at = base + (row * TEXT_COLS + col) * 2;
      const ch = mem[at], attr = mem[at + 1];
      const bg = TEXT_PALETTE[(attr >> 4) & 0x07];
      // Bit 7 of the attribute is blink in text mode, which is what DOS programs use for emphasis.
      const hidden = (attr & 0x80) && !((blink >> 4) & 1);
      const fg = hidden ? bg : TEXT_PALETTE[attr & 0x0f];
      const glyph = ch * CELL_H;
      for (let y = 0; y < CELL_H; y++) {
        const bits = font[glyph + y];
        let o = (row * CELL_H + y) * W + col * CELL_W;
        for (let x = 0; x < CELL_W; x++) textU32[o++] = (bits & (0x80 >> x)) ? fg : bg;
      }
    }
  }
  // The cursor: an underline on the bottom two rows, blinking, as a VGA text cursor does.
  if ((blink >> 4) & 1 && curRow < TEXT_ROWS && curCol < TEXT_COLS) {
    const fg = TEXT_PALETTE[mem[base + (curRow * TEXT_COLS + curCol) * 2 + 1] & 0x0f];
    for (let y = CELL_H - 3; y < CELL_H - 1; y++) {
      let o = (curRow * CELL_H + y) * W + curCol * CELL_W;
      for (let x = 0; x < CELL_W; x++) textU32[o++] = fg;
    }
  }
  cx.putImageData(textImage, 0, 0);
}

/** The guest's text screen, and the BIOS data area's cursor, which src/env/console.js maintains. */
function paintGuestText() {
  if (!guest) { cx.fillStyle = '#000'; cx.fillRect(0, 0, canvas.width, canvas.height); return; }
  paintTextFrom(guest, VRAM_TEXT, guest[0x450], guest[0x451]);
}

// ---------------------------------------------------------------- the shell's own terminal
//
// A REAL prompt, not a picture of one. The listing is printed, the cursor blinks after it, and what
// you type is what runs -- `HEXEN -devparm`, `./quake -width 640`, `dir`, `cls`. It exists because
// the alternative was a menu wearing a terminal's colours: you clicked a row and then reached for a
// Run button somewhere else on the page, which is not how any of these machines worked and not how
// anybody expects a prompt to behave.
//
// Same buffer shape as the guest's, so the same renderer draws both and the picture never jumps.
const shellVram = new Uint8Array(TEXT_COLS * TEXT_ROWS * 2);
let shellCol = 0, shellRow = 0, shellAttr = 0x07;
let cmdline = '';                 // what has been typed at the prompt, not yet entered
let promptCol = 0, promptRow = 0; // where the typed text begins, so editing can redraw just that
// NOT `history`: that is the browser's, and shadowing it made publishQuery's replaceState throw
// the moment a program was started from the prompt -- the run died before it began, silently.
let cmdHistory = [], historyAt = 0;

/*
 * A TOP MARGIN, for a machine whose console lived inside a window. OpenWindows drew a frame around
 * everything on a Sun, and it is most of what that screen looked like -- so row 0 is its title bar,
 * in reverse video, and the terminal starts underneath and scrolls underneath.
 */
let termTop = 0;

function termClear() {
  for (let i = 0; i < shellVram.length; i += 2) { shellVram[i] = 32; shellVram[i + 1] = shellAttr; }
  shellCol = 0; shellRow = termTop;
  if (machine?.frame) {
    const title = ` ${machine.frame}`;
    const host = `${machine.host || machine.name} `;
    const bar = (title + ' '.repeat(Math.max(1, TEXT_COLS - title.length - host.length)) + host)
      .slice(0, TEXT_COLS);
    for (let c = 0; c < TEXT_COLS; c++) {
      shellVram[c * 2] = bar.charCodeAt(c) & 0xff;
      shellVram[c * 2 + 1] = 0x70;              // black on light grey: a title bar with focus
    }
  }
}

function termScroll() {
  const from = termTop * TEXT_COLS * 2;
  shellVram.copyWithin(from, from + TEXT_COLS * 2);
  const last = (TEXT_ROWS - 1) * TEXT_COLS * 2;
  for (let i = last; i < shellVram.length; i += 2) { shellVram[i] = 32; shellVram[i + 1] = shellAttr; }
  shellRow = TEXT_ROWS - 1;
}

function termChar(code, attr = shellAttr) {
  if (code === 10) { shellCol = 0; shellRow++; }
  else {
    const at = (shellRow * TEXT_COLS + shellCol) * 2;
    shellVram[at] = code; shellVram[at + 1] = attr;
    if (++shellCol >= TEXT_COLS) { shellCol = 0; shellRow++; }
  }
  if (shellRow >= TEXT_ROWS) termScroll();
}

/** CP437 is what the font holds, so a character outside it is written as the glyph it is not. */
function termWrite(text, attr = shellAttr) {
  for (const ch of String(text)) termChar(ch === '\n' ? 10 : (ch.charCodeAt(0) & 0xff), attr);
}
const termLine = (text = '', attr = shellAttr) => { termWrite(text, attr); termChar(10); };

// ---------------------------------------------------------------- the shelf
//
// FOUR MACHINES, and a machine is chosen before a program is. That is not presentation: it is the
// choice the compiler makes. `quake:dos`, `quake:x11`, `quake:sun` and `quake:win` are four platform
// layers over one engine, and while this page had a "program" dropdown and a "host" dropdown beside
// it, the second one was a word with no meaning attached -- you had to already know that `mgl` was
// the Windows build to pick it.
//
// web/machines.json says which machine runs what; web/programs/*.json says what each program IS.
// Everything on the screen below comes from one of those two, or from the server's own resolution of
// targets/*.json -- so a unit count on a DIR listing is a number the build would produce, not a
// number somebody typed into a mockup.
let programs = {};        // id -> the descriptor in web/programs/
let machines = [];        // web/machines.json, in order
let targetInfo = {};      // target name -> { present, variants }
let machine = null;       // the machine we are sitting at
let chosen = 0;           // which of its programs is selected
let argsFor = null;       // the entry the argument field's contents belong to
let lastArgsWritten = ''; // ...and exactly what was written, so typing is told apart from a refill

async function discover() {
  const cfg = await (await fetch('./machines.json')).json();
  machines = cfg.machines.filter(m => !m.id.startsWith('_'));

  // Which corpora are actually cloned. A program whose sources are absent is shown and NOT offered:
  // "it is not here" is a different fact from "it is not supported", and a build that dies fetching
  // an empty listing tells you neither.
  try {
    const { targets } = await (await fetch('/__targets')).json();
    for (const t of targets) targetInfo[t.name] = t;
  } catch { /* an older server: everything is assumed present, as it was before this existed */ }

  const ids = [...new Set(machines.flatMap(m => m.programs.map(x => x.program)))];
  await Promise.all(ids.map(async (id) => {
    try { programs[id] = await (await fetch(`./programs/${id}.json`)).json(); }
    catch (e) { log(`no descriptor for '${id}': ${e.message}`, 'warn'); }
  }));

  // Every entry, resolved once: the descriptor it names, the target it builds, whether that target
  // is present, and its unit count straight from the server's own resolution.
  for (const m of machines) {
    m.programs = m.programs.filter(x => programs[x.program]);
    for (const x of m.programs) {
      const p = programs[x.program];
      x.desc = p;
      x.name = p.title || x.program;
      x.target = x.variant ? `${(p.target || '').split(':')[0]}:${x.variant}` : (p.target ?? null);
      const base = (x.target || '').split(':')[0];
      x.present = base ? (targetInfo[base]?.present ?? true) : true;
      // A descriptor of the older kind carries its own unit list (Doom does), and that is a real
      // count too -- countUnits() only has a server to ask when there is a target to resolve.
      if (Array.isArray(p.units)) x.units = p.units.length;
      x.file = x.file || x.program;
    }
  }
  renderMachines();
  pick(machines[0], 0);
  countUnits();                       // asynchronous: the listing fills in as answers arrive
}

/*
 * How many translation units each program is, asked of the SERVER rather than stated in a file.
 *
 * /__target applies the unit rules -- a list, a glob, or the program's own MAKEFILE -- and hands
 * back the answer, which is the same answer `node tools/build.mjs` gets. A number in a JSON file
 * beside it would be a second copy of a fact that changes whenever a variant does, and the two would
 * disagree within a week. Failures are silent on purpose: an absent corpus already says so, and a
 * missing count costs a column, not a session.
 */
async function countUnits() {
  const seen = new Map();
  await Promise.all(machines.flatMap(m => m.programs).map(async (x) => {
    if (!x.target || !x.present) return;
    if (!seen.has(x.target)) {
      seen.set(x.target, fetch(`/__target?name=${encodeURIComponent(x.target)}`)
        .then(r => (r.ok ? r.json() : null)).catch(() => null));
    }
    const t = await seen.get(x.target);
    if (t) { x.units = t.units.length; x.variantArgs = t.args ?? null; }
  }));
  // The counts arrive after the first draw, and the line under the screen names the same program the
  // listing does -- so both are redrawn, or the two disagree until you click something.
  renderChooser();
  describe();
}

/** The selected entry, and the descriptor behind it. */
function current() { return machine?.programs[chosen]?.desc ?? null; }
function entry() { return machine?.programs[chosen] ?? null; }

/** The target this program builds from, with the machine's variant already chosen for it. */
function chosenTarget() { return entry()?.target ?? null; }

function renderMachines() {
  const rail = $('machines');
  rail.innerHTML = '';
  for (const m of machines) {
    const b = document.createElement('button');
    b.className = 'machine';
    b.setAttribute('role', 'tab');
    b.innerHTML = `<span class="mname"><span class="dot"></span>${m.name}</span>` +
                  `<span class="msub">${m.sub}</span>`;
    b.onclick = () => { switchAway('machine'); pick(m, 0); };
    m.el = b;
    rail.append(b);
  }
}

/** Sit down at a machine, at one of its programs. */
function pick(m, i) {
  const changed = m !== machine;
  machine = m; chosen = i;
  if (changed) clearScreen();
  for (const x of machines) x.el.setAttribute('aria-selected', String(x === m));
  $('vmName').textContent = m.name;
  $('vmSpec').textContent = m.spec || '';
  // describe() first: it fills the argument field, and the prompt on the machine's own screen shows
  // the command line those arguments make. Drawing the screen first left the prompt one program
  // behind -- the SUN listing said `./quake +host_framerate` while the field already said `-zone 512`.
  describe();
  renderChooser();
}

/*
 * THE MACHINE'S OWN SCREEN. Two idioms, because there were two: a terminal you TYPE AT (DOS's
 * prompt, a Unix shell, the same shell inside an OpenWindows frame) and a desktop you point at.
 *
 * The terminal is drawn on the canvas, in the same 80x25 text mode the running program will use, so
 * the surface never changes underneath you. The desktop is DOM, because it is a GUI and drawing
 * one glyph at a time would be pretending a Windows desktop was a text screen.
 */
function renderChooser() {
  const box = $('chooser');
  if (!machine) { box.innerHTML = ''; return; }
  // A desktop machine IS its desktop, running or not: a program opens a window over the icons.
  $('stage').classList.toggle('desktop', machine.kind === 'desktop');
  if (machine.kind === 'desktop') {
    box.hidden = false;
    box.innerHTML = desktopScreen(machine);
    for (const el of box.querySelectorAll('[data-i]')) {
      const i = +el.dataset.i;
      el.onclick = () => { switchAway('program'); pick(machine, i); };
      // A desktop LAUNCHES on a double-click. Selecting and launching are two different acts there,
      // which is exactly why Windows made them two different gestures.
      el.ondblclick = () => { pick(machine, i); startRun(); };
    }
    return;
  }
  box.hidden = true;
  box.innerHTML = '';
  termBanner();
  termListing();
  termPrompt();
}

const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Attributes, in the VGA text sense: bright white for what a machine emphasised, grey for the rest. */
const A_DIM = 0x07, A_BRIGHT = 0x0f, A_LIT = 0x0e, A_ERR = 0x0c;

function termBanner() {
  shellAttr = A_DIM;
  termTop = machine.frame ? 1 : 0;
  termClear();
  if (machine.kind === 'dos') {
    termLine('PRISM DOS session   640K conventional, 512M extended', A_BRIGHT);
    termLine('Type a program name and press Enter.  DIR lists, CLS clears.');
  } else {
    termLine(`Last login: on ttyp0`, A_DIM);
    termLine(`${machine.host || 'prism'}% type a program name and press Enter.  ` +
             `ls lists, clear clears.`, A_DIM);
  }
  termChar(10);
}

/** What `dir` or `ls -l` answered. The unit counts are the server's, from targets/*.json. */
function termListing() {
  const dos = machine.kind === 'dos';
  termLine(`${machine.prompt} ${machine.listing}`, A_BRIGHT);
  termChar(10);
  if (dos) {
    termLine(` Volume in drive C is ${machine.volume || 'PRISM'}`);
    termLine(' Directory of C:\\');
    termChar(10);
  }
  machine.programs.forEach((x, i) => {
    const name = dos ? `${x.file.padEnd(8)} ${(x.ext || '').padEnd(3)}`
      : `-rwxr-xr-x  ${x.file.padEnd(12)}`;
    const units = x.units ? `${String(x.units).padStart(3)} units` : '         ';
    const state = x.present ? '' : '  (sources not cloned)';
    // The SELECTED row is bright, because the argument field and the line under the screen describe
    // that one -- and if the screen did not say which, they would look like they described any of them.
    termLine(`${dos ? '' : ' '}${name}  ${units}  ${(x.date || '').padEnd(12)}${state}`,
      x.present ? (i === chosen ? A_BRIGHT : A_DIM) : A_DIM);
  });
  termChar(10);
  if (dos) { termLine(`        ${machine.programs.length} File(s)`); termChar(10); }
}

/** The prompt, and everything typed after it. */
function termPrompt() {
  shellAttr = A_DIM;
  if (shellCol) termChar(10);
  termWrite(`${machine.prompt} `, A_BRIGHT);
  promptCol = shellCol; promptRow = shellRow;
  termWrite(cmdline, A_LIT);
}

/** Redraw the typed text in place -- one line, no scrolling, so editing does not repaint the screen. */
function termRedrawLine() {
  shellCol = promptCol; shellRow = promptRow;
  termWrite(cmdline, A_LIT);
  // and blank whatever the previous, longer line left behind
  let col = shellCol, row = shellRow;
  while (row < TEXT_ROWS && (row * TEXT_COLS + col) < TEXT_ROWS * TEXT_COLS) {
    const at = (row * TEXT_COLS + col) * 2;
    if (shellVram[at] === 32) break;
    shellVram[at] = 32; shellVram[at + 1] = A_DIM;
    if (++col >= TEXT_COLS) { col = 0; row++; }
  }
}

/** A line from the SHELL rather than from a program: loading progress, an error, a refusal. */
function termNote(text, attr = A_DIM) {
  if (!machine || machine.kind === 'desktop') return;
  if (shellCol) termChar(10);
  termLine(text, attr);
}
const termPromptIfTerminal = () => { if (machine && machine.kind !== 'desktop') termPrompt(); };

/**
 * The program's screen becomes the shell's again, with the prompt under whatever it printed.
 *
 * This is the other half of handing the terminal over: the program inherited the page the shell had
 * drawn, so when it ends the shell takes back the page the PROGRAM left. Redrawing the banner and
 * the listing instead would wipe out the very output you stopped it to read.
 */
function termResume() {
  if (!machine || machine.kind === 'desktop') { renderChooser(); return; }
  if (guest) {
    shellVram.set(guest.subarray(VRAM_TEXT, VRAM_TEXT + shellVram.length));
    shellCol = guest[0x450]; shellRow = guest[0x451];
    if (shellRow >= TEXT_ROWS) { shellRow = TEXT_ROWS - 1; }
  }
  shellAttr = A_DIM;
  termPrompt();
}

/*
 * WHAT A TYPED LINE MEANS.
 *
 * A program name runs it; the rest of the line is its arguments, and they replace whatever the
 * variant filled in -- if you typed them, you meant them. `dir`/`ls` reprint the listing and
 * `cls`/`clear` clear, because a prompt that answers nothing but program names is still a menu.
 */
function termEnter() {
  const text = cmdline.trim();
  cmdline = '';
  termRedrawLine();
  termChar(10);
  if (text) { cmdHistory.push(text); historyAt = cmdHistory.length; }
  const [word, ...rest] = tokenise(text);
  const cmd = (word || '').toLowerCase();

  if (!word) { termPrompt(); return; }
  if (cmd === 'dir' || cmd === 'ls') { termListing(); termPrompt(); return; }
  if (cmd === 'cls' || cmd === 'clear') { termClear(); termPrompt(); return; }
  if (cmd === 'help' || cmd === '?') {
    termLine('Type the name of one of the programs above, with any arguments after it.');
    termLine('DIR / ls reprints the listing.  CLS / clear clears the screen.');
    termPrompt();
    return;
  }

  // A program, by the name this machine calls it: HEXEN, HEXEN.EXE, ./quake or quake all match.
  const want = cmd.replace(/^\.\//, '');
  const i = machine.programs.findIndex((x) => {
    const f = x.file.toLowerCase();
    return want === f || want === `${f}.${(x.ext || '').toLowerCase()}` ||
           want === f.replace(/\.exe$/, '');
  });
  if (i < 0) {
    termLine(machine.kind === 'dos' ? 'Bad command or file name' : `${word}: command not found`, A_ERR);
    termPrompt();
    return;
  }
  if (!machine.programs[i].present) {
    termLine(`${word}: its sources are not cloned into corpus/`, A_ERR);
    termPrompt();
    return;
  }
  pick(machine, i);
  // What was typed wins over what the variant filled in -- but a build REQUIREMENT is not a
  // preference, so a variant's own flags survive unless the same flag was typed.
  if (rest.length) $('args').value = mergeArgs(machine.programs[i].variantArgs, rest.join(' '));
  startRun(word);
}

/** Tab completes a program name, which is the one thing a prompt with a fixed list can always do. */
function termComplete() {
  const typed = cmdline.trim().toLowerCase();
  if (!typed || /\s/.test(cmdline.trim())) return;
  const hits = machine.programs
    .map(x => (machine.kind === 'dos' ? x.file : `./${x.file}`))
    .filter(n => n.toLowerCase().replace(/^\.\//, '').startsWith(typed.replace(/^\.\//, '')));
  if (hits.length === 1) { cmdline = `${hits[0]} `; termRedrawLine(); }
  else if (hits.length > 1) {
    termChar(10);
    termLine(hits.join('   '));
    termPrompt();
  }
}

/**
 * A keystroke at the prompt. Returns true when it was the terminal's, so the caller knows not to
 * hand it to a program as well.
 */
function termKey(e) {
  if (!machine || machine.kind === 'desktop' || worker) return false;
  if (e.key === 'Enter') { termEnter(); return true; }
  if (e.key === 'Backspace') { cmdline = cmdline.slice(0, -1); termRedrawLine(); return true; }
  if (e.key === 'Tab') { termComplete(); return true; }
  if (e.key === 'Escape') { cmdline = ''; termRedrawLine(); return true; }
  /*
   * Ctrl+C at a prompt abandons the line and gives you a new one -- it does not clear the screen and
   * it does not run anything. That is what every shell does with it, and it is the reason a half-typed
   * command is never something you have to delete character by character.
   */
  if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
    cmdline = '';
    termWrite('^C', A_DIM);
    termChar(10);
    termPrompt();
    return true;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    historyAt = Math.min(cmdHistory.length, Math.max(0, historyAt + (e.key === 'ArrowUp' ? -1 : 1)));
    cmdline = cmdHistory[historyAt] ?? '';
    termRedrawLine();
    return true;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    cmdline += e.key;
    termRedrawLine();
    return true;
  }
  return false;
}

function desktopScreen(m) {
  const icons = m.programs.map((x, i) =>
    `<button class="shortcut ${x.present ? '' : 'absent'}" aria-selected="${i === chosen}" ` +
    `data-i="${x.present ? i : ''}" title="double-click to run">` +
    /* The program's OWN .ico, straight out of its source tree: a browser decodes the format
       natively, so there is no conversion step and no build artefact to keep in step with it. */
    (x.icon ? `<img src="/${x.icon}" alt="">` : '<img alt="">') +
    `<span>${esc(x.name)}</span></button>`).join('');
  const task = worker ? esc(m.programs[chosen]?.name ?? '') : '';
  return `<div class="desktop"><div class="icons">${icons}</div>` +
    `<div class="taskbar"><span class="start"><span class="flag"></span>Start</span>` +
    `<span class="task">${task}</span><span class="tray">${esc(m.spec || '')}</span></div></div>`;
}

/**
 * The BUILD's arguments under the PROGRAM's, without saying anything twice.
 *
 * Both are real and neither subsumes the other: `quake:dos` needs `-nosound` and the Quake
 * descriptor suggests `+host_framerate 0.0138`. But `putty:tel` names `-telnet localhost` and so
 * does its descriptor, and concatenating gave `-telnet localhost -telnet localhost` -- which PuTTY
 * parsed, argued with, and exited over. A flag already present in the program's own arguments is
 * dropped from the variant's, along with the value that follows it.
 */
function mergeArgs(variantArgs, programArgs) {
  const mine = tokenise(programArgs || '');
  const flags = new Set(mine.filter(t => /^[-+]/.test(t)));
  const out = [];
  const theirs = tokenise(variantArgs || '');
  for (let i = 0; i < theirs.length; i++) {
    if (!/^[-+]/.test(theirs[i])) { out.push(theirs[i]); continue; }
    if (!flags.has(theirs[i])) { out.push(theirs[i]); continue; }
    while (i + 1 < theirs.length && !/^[-+]/.test(theirs[i + 1])) i++;   // and its value
  }
  return [...out, ...mine].join(' ').trim();
}

function describe() {
  const x = entry(), p = current();
  if (!p) return;

  /*
   * The arguments a BUILD requires, from the variant, under the ones the program suggests. Quake's
   * DOS build will not start without `-nosound` and its SUN build will not start without
   * `-zone 512` -- vid_sunx.c takes its framebuffer out of the zone, which is 49,152 bytes by
   * default against a 64,000-byte frame. Neither is a preference, so neither should be something
   * you have to know to type.
   */
  /*
   * The arguments field belongs to whoever last set it FOR THIS PROGRAM. describe() runs again when
   * the unit counts arrive from the server -- asynchronously, a beat after the page loads -- and it
   * used to refill the field unconditionally, which quietly threw away what `?args=` had put there
   * and what somebody had typed in the meantime.
   */
  /*
   * Refill when the field is still exactly what this function last wrote -- not merely when the
   * program changed. `variantArgs` arrives from the server a beat AFTER the first draw, and guarding
   * on the entry alone meant the second describe() declined to add it: `quake:dos` lost its
   * mandatory `-nosound` and threw on GUS_Init before drawing a pixel. Anything you typed is still
   * safe, because then the field no longer matches what was written.
   */
  const want = mergeArgs(x.variantArgs, p.args);
  if (argsFor !== x || $('args').value === lastArgsWritten) {
    argsFor = x;
    lastArgsWritten = want;
    $('args').value = want;
  }
  $('args').placeholder = p.argsHint || 'arguments passed to main()';
  $('run').disabled = !!worker || !x.present;
}

/*
 * The panel is closed by default in a page whose whole point is the machine's own screen, and the
 * choice is remembered. An error opens it whatever you chose, because a build that failed behind a
 * closed panel is a page that simply did nothing.
 */
function showPanel(on) {
  $('main-panel-host').classList.toggle('nopanel', !on);
  try { localStorage.setItem('prism.panel', on ? '1' : '0'); } catch {}
}
$('panel').onclick = () => showPanel($('main-panel-host').classList.contains('nopanel'));

/* Retyping the command line as the arguments change: the prompt is the one place both are visible. */
$('args').oninput = () => { if (!worker) renderChooser(); };

/*
 * Changing the machine or the program STOPS what is running.
 *
 * Otherwise the shelf stops describing what is on screen: pick the X11 build while the DOS one is
 * still going and the listing says one thing, the canvas shows another, and the next Run competes
 * with a worker that never went away. The last frame is cleared too -- a stale picture from the
 * previous platform is exactly the kind of evidence that gets read as a result.
 */
function switchAway(what) {
  if (!worker) return;
  stop(true);
  log(`${what} changed — stopped the running program`);
}

/** Forget the screen, so nothing from the last program is mistaken for the next one. */
function clearScreen() {
  imageData = null; lut = null; palGen = -1;
  // The title too: it belongs to the program that set it, and a stale one on the next program's
  // window is exactly the confusion this whole frame caused when it was hard-coded.
  $('wincaption').textContent = '';
  $('winframe').classList.remove('windowed');
  $('stage').classList.remove('running');
  cx.fillStyle = '#000';
  cx.fillRect(0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------- the shell's own log
/*
 * A REPEATED LINE IS COUNTED, not repeated.
 *
 * Doom prints "S_StartSoundAtVolume: 16bit and not pre-cached - wtf?" on every single sound, and
 * that is its own source doing it: doomdef.h defines SNDSERV, s_sound.c guards the warning on
 * SNDSRV -- a name that appears once in the whole tree and is defined nowhere. A real linuxdoom
 * prints it too, so it is not ours to fix and not ours to hide. What IS ours is a pane where one
 * line, printed four hundred times, buries everything else the run had to say.
 */
let lastLine = null, lastEl = null, lastCount = 0;

/*
 * WHOSE MESSAGE IS IT. The program's output is the program's: it is already on the machine's own
 * screen, under the command that started it, and it goes to the browser's console as well -- which
 * is where you can filter it, keep it across a reload, and copy it out. What stays in PRISM's panel
 * is what PRISM has to say about itself.
 */
function log(line, kind = 'info') {
  if (kind === 'guest') { console.log('%c[guest]', 'color:#8b929e', line); return; }
  if (kind === 'error') showPanel(true);      // a build failure must never be behind a closed panel
  if (line === lastLine && lastEl) {
    lastEl.textContent = `${line}   ×${++lastCount}`;
    $('log').scrollTop = $('log').scrollHeight;
    return;
  }
  const el = document.createElement('div');
  el.className = `line ${kind}`;
  el.textContent = line;
  $('log').append(el);
  $('log').scrollTop = $('log').scrollHeight;
  lastLine = line; lastEl = el; lastCount = 1;
}

// ---------------------------------------------------------------- data files
//
// A PROGRAM'S DATA ARRIVES WITH THE PROGRAM, and it is the program's own.
//
// The page used to make you load data before running anything: a file picker, or one button that
// fetched every file the server could see -- roughly 150 MB of it, most of it another game's. That
// was wrong twice over. It made "did you remember to press the button?" part of starting a program,
// and it put five games' files in front of each of them, which is how Quake's DOS build came to ask
// for pak0.pak and be told, correctly, that there were two files by that name and neither could be
// meant.
//
// So each descriptor names its data ROOT (`needsData.dir`) -- a directory under the one given to
// `serve.mjs --games=` -- and starting the program fetches that root and nothing else. Cached, so a
// second run of the same game starts at once.
let dataFiles = {};
const dataCache = new Map();               // root -> { name: Uint8Array }

/**
 * One data root, fetched once. Progress goes to the machine's own screen, because that is where you
 * are looking: a 50 MB pak takes a moment and a page that simply sits there looks broken.
 */
async function loadData(root, say) {
  if (dataCache.has(root)) return dataCache.get(root);
  const r = await fetch(`/__data/?root=${encodeURIComponent(root)}`);
  if (!r.ok) throw new Error(`no data directory '${root}' — start serve.mjs with --games=<dir>`);
  const { files } = await r.json();
  if (!files.length) throw new Error(`the data directory '${root}' is empty`);
  say?.(`loading ${files.length} data file${files.length === 1 ? '' : 's'} from ${root}/…`);
  const out = {};
  await Promise.all(files.map(async (f) => {
    // The relative path IS the key. MAME asks for "pacman/pacman.6e", and flattening that to
    // "pacman.6e" leaves only a basename match to save it -- which also lets one game's file answer
    // for another's when two ROM sets share a filename.
    out[f] = new Uint8Array(await (await fetch(`/__data/${f}`)).arrayBuffer());
  }));
  dataCache.set(root, out);
  return out;
}

// ---------------------------------------------------------------- keyboard
//
// Two distinct questions, answered separately, exactly as MIRAGE does it: which keys are HELD (a byte
// per scan code, what a game polls every frame) and which characters were TYPED (an ordered queue,
// what getchar reads once each). Answering the second with the first reports Enter as pressed for as
// long as the finger is down.
let keyboard = null;
let mouse = null;

/*
 * Fullscreen, on the STAGE rather than the canvas: see the CSS for why. Keyboard input keeps working
 * because the handler is on the window, not on an element that loses focus -- but the focus does
 * have to leave the args field, which is why it is blurred here. A keystroke swallowed by a text
 * input is exactly what made the first browser run look like a dead keyboard.
 */
$('fullscreen').onclick = () => {
  const stage = $('stage');
  if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
  (stage.requestFullscreen?.() ?? Promise.reject(new Error('no fullscreen API')))
    .then(() => document.activeElement?.blur?.())
    .catch((e) => log(`fullscreen refused: ${e.message}`, 'warn'));
};
addEventListener('fullscreenchange', () => {
  $('fullscreen').textContent = document.fullscreenElement ? 'Windowed' : 'Fullscreen';
});

/*
 * Whether a keystroke belongs to the PAGE rather than to the program. The one case is a text field
 * with focus, where the user is editing the command line.
 *
 * It has to be asked the same way for a press and for a release, and it wasn't: keydown checked and
 * keyup did not. So a program whose menu never opened had nonetheless been handed the RELEASE of the
 * key meant to open it -- an unpaired break code, which Doom's xlatekey translated faithfully and
 * M_Responder ignored, exactly as it should. An asymmetric guard does not drop input; it corrupts it.
 *
 * A <select> is deliberately NOT in the list, though it was. It is where the focus sits after
 * choosing a program from the menu, so counting it as typing left the keyboard dead for precisely
 * the users who had just picked a game.
 */
const typing = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');

/**
 * Let go of every held key. A program only learns of a release from a break code, so dropping the
 * held-key ARRAY without sending them leaves it walking left for ever -- which is what the window's
 * blur handler used to do.
 */
/*
 * Which held keys are the 0xE0-prefixed ones. The scan code alone cannot say -- ArrowUp and Numpad8
 * are both 72 -- and the RELEASE has to carry the same prefix as the press, or a host feeding port
 * 0x60 files the press under 0xc8 and the release under 0x48 and the key is held for ever.
 */
const heldExtended = new Set();

function releaseAll() {
  if (!views) return;
  for (let sc = 0; sc < views.keys.length; sc++) {
    if (!views.keys[sc]) continue;
    views.keys[sc] = 0;
    keyboard?.push(sc | 0x80, 0, heldExtended.has(sc) ? KBD_EXTENDED : 0);
  }
  heldExtended.clear();
  wake(views.ctrl);
}

addEventListener('keydown', (e) => {
  if (typing()) return;
  /*
   * THE PROMPT FIRST. With nothing running, a keystroke is being typed at the machine's own
   * terminal -- that is what a terminal is -- and only a running program takes the keyboard away
   * from it. Tab and Enter are the ones that would otherwise be the browser's, so this has to come
   * before the guard below rather than after it.
   */
  if (termKey(e)) { e.preventDefault(); return; }
  /*
   * Ctrl+C INTERRUPTS a program that is still on the text screen, and only that one.
   *
   * The test is the display, not the descriptor, because that is the honest distinction: a program
   * showing a text screen is a console program, and on any of these machines Ctrl+C ended it. A
   * program that has taken the display is a game, and there Ctrl is the FIRE BUTTON -- Quake's
   * default binding, MAME's too -- so intercepting it would make the page eat the one key you press
   * most.
   *
   * The mechanism is the one Stop already uses: SLOT.STOP makes the guest's next read of the
   * keyboard return -1, which a C program reads as EOF on stdin and handles itself. Lua's REPL exits
   * cleanly, prints nothing, and the shell takes its screen back.
   */
  if (views && worker && e.ctrlKey && (e.key === 'c' || e.key === 'C') &&
      Atomics.load(views.ctrl, SLOT.TEXTMODE)) {
    e.preventDefault();
    Atomics.store(views.ctrl, SLOT.STOP, 1);
    wake(views.ctrl);
    log('^C — interrupt sent; the program sees end-of-file on stdin');
    return;
  }
  // A desktop launches what is selected on Enter, as double-clicking its icon does.
  if (!worker && machine?.kind === 'desktop' && e.key === 'Enter') {
    e.preventDefault(); startRun(); return;
  }
  if (!views) return;
  const sc = scancodeForEvent(e);
  if (!sc) return;
  views.keys[sc] = 1;
  views.latch[sc] = KEY_HOLD_FRAMES;   // so a brief tap survives long enough to be sampled
  if (keyboard) {
    // The keystroke, for whoever reads the queue: the scan code AND the character, as a BIOS buffer
    // holds them. `key` is right here where `code` was right above — a program reading text wants
    // what the layout produced, not which key the finger was on.
    let ascii = 0;
    if (e.key === 'Enter') ascii = 13;
    else if (e.key === 'Backspace') ascii = 8;
    else if (e.key === 'Tab') ascii = 9;
    else if (e.key === 'Escape') ascii = 27;
    else if (e.key && e.key.length === 1) ascii = e.key.charCodeAt(0);
    const ext = extendedForEvent(e);
    if (ext) heldExtended.add(sc); else heldExtended.delete(sc);
    keyboard.push(sc, ascii, ext ? KBD_EXTENDED : 0);
  }
  e.preventDefault();
});
addEventListener('keyup', (e) => {
  if (!views || typing() || !worker) return;
  const sc = scancodeForEvent(e);
  if (!sc) return;
  views.keys[sc] = 0;
  // A release, in the PC's break-code convention, so a program that wants key-up events gets them.
  // The prefix flag has to match the press: filing a press under 0xc8 and its release under 0x48
  // leaves the key held for ever.
  const ext = extendedForEvent(e);
  heldExtended.delete(sc);
  if (keyboard) keyboard.push(sc | 0x80, 0, ext ? KBD_EXTENDED : 0);
  // A guest parked inside `while (osd_key_pressed(k));` is waiting for exactly this, so tell it now
  // rather than leaving it to notice on its next timeout.
  wake(views.ctrl);
  e.preventDefault();
});
// ---------------------------------------------------------------- the mouse
//
// RELATIVE MOTION, which is the only kind these programs want. Quake's DOS build reads INT 33h
// AX=000B ("read motion counters"), an X client differences successive MotionNotify positions around
// a warp, and a Win32 game reads WM_MOUSEMOVE the same way -- all three want "how far since last
// time", and none of them wants a cursor position inside a web page.
//
// A browser only gives that under POINTER LOCK. Without it, `movementX` is still reported but the
// pointer stops at the edge of the window, so a turn to the left ends after a few hundred pixels;
// with it, the pointer has no position at all and the motion is unbounded, which is what a
// first-person game has always assumed.
//
// So capture is a deliberate act -- click the screen -- and Esc gives it back, because that is the
// browser's own contract and fighting it would be worse than following it.
const stage = $('stage');

/*
 * Whether motion is being taken at all. Pointer lock is the good case; the fallback below is the
 * honest one, and they are told apart because they behave differently at the edge of the window.
 */
let capturing = false;

stage.addEventListener('click', () => {
  // Only while something is running: locking the pointer over a machine's prompt would take the
  // mouse away from the page for nothing.
  if (!worker || document.pointerLockElement === stage) return;
  const p = stage.requestPointerLock?.();
  /*
   * POINTER LOCK CAN BE REFUSED, and it is refused in some embeddings -- an iframe without
   * `allow="pointer-lock"` among them. Falling back to plain `movementX` is not the same thing and
   * must not pretend to be: the deltas are identical, but the pointer still has a position, so it
   * stops at the edge of the window and a long turn ends there. Better than nothing, worse than
   * lock, and said out loud rather than left to be discovered mid-turn.
   */
  Promise.resolve(p).catch(() => {
    if (capturing) return;
    capturing = true;
    stage.classList.add('captured');
    log('pointer lock refused — mouse still works, but the pointer stops at the window edge', 'warn');
  });
});

document.addEventListener('pointerlockchange', () => {
  const on = document.pointerLockElement === stage;
  capturing = on;
  stage.classList.toggle('captured', on);
  if (!on && mouse) mouse.buttons(0);      // a released capture holds no buttons down
  log(on ? 'mouse captured — Esc to release' : 'mouse released');
});

addEventListener('mousemove', (e) => {
  if (!mouse || !capturing) return;
  /*
   * `movementX` is already the delta, in the same unit a DOS driver called a mickey. Quake scales it
   * by `sensitivity` itself, so nothing is scaled here -- a host that pre-multiplied would be
   * silently overriding the game's own setting.
   */
  mouse.move(e.movementX | 0, e.movementY | 0);
});

/*
 * Buttons as a LEVEL, not as edges. INT 33h AX=0003 and X11's `state` mask both report which buttons
 * are down right now, and Quake turns that into presses and releases itself (in_dos.c:206) -- so the
 * page must not do it too, or every click would arrive twice.
 */
let mouseButtons = 0;
for (const [type, down] of [['mousedown', true], ['mouseup', false]]) {
  addEventListener(type, (e) => {
    if (!mouse || !capturing) return;
    // The DOM numbers them 0 left, 1 middle, 2 right; INT 33h wants bit 0 left, 1 right, 2 middle.
    const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0;
    mouseButtons = down ? (mouseButtons | bit) : (mouseButtons & ~bit);
    mouse.buttons(mouseButtons);
    e.preventDefault();
  });
}
// A right-click inside a captured screen is the game's, not the browser's context menu.
stage.addEventListener('contextmenu', (e) => { if (document.pointerLockElement === stage) e.preventDefault(); });

// A lost focus must release everything, or the program keeps walking left for ever.
addEventListener('blur', releaseAll);
/*
 * ...and the program is told, because a Win32 game reads it: WinQuake's IN_Move does nothing while
 * `ActiveApp` is false, which is what makes alt-tabbing away release the mouse on a real machine.
 */
for (const [type, on] of [['focus', 1], ['blur', 0]]) {
  addEventListener(type, () => { if (views) Atomics.store(views.ctrl, SLOT.FOCUS, on); });
}
// And so must clicking into the command line: from here on its keys are the page's, so the ones
// still down would never get their break code.
addEventListener('focusin', () => { if (typing()) releaseAll(); });

// ---------------------------------------------------------------- the window, when there is one
//
// The page is the WINDOW MANAGER here, and that is not a metaphor: src/env/win32.c keeps the
// rectangle because the program moves and resizes it, `GetWindowRect` reports it back, and
// VID_UpdateWindowStatus writes the position into Quake's archived `vid_window_x` / `vid_window_y`.
// So dragging this frame does not move a div -- it tells the program where its window now is, and
// the program agrees on the next frame. A resolution change resizes it from the other direction.
let dragging = null, dragGen = 0;

function paintWindow() {
  const frame = $('winframe');
  // A CLASS, not the `hidden` attribute: the canvas lives inside this element, so switching the
  // whole frame off would switch the picture off with it. Only the chrome comes and goes.
  if (!views) {
    frame.classList.remove('windowed');
    // ...and the size the last window asked for. Leaving it behind meant the machine's own terminal
    // was afterwards drawn at whatever resolution WinQuake had been resized to.
    if (canvas.style.width) canvas.style.width = canvas.style.height = '';
    return;
  }
  const has = Atomics.load(views.ctrl, SLOT.WIN_HAS) === 1;
  frame.classList.toggle('windowed', has);
  /*
   * The SIZE is the guest's too, and the page used to ignore it.
   *
   * Pick 640x480 from WinQuake's video menu and it really does resize its window -- prism_win32_w
   * and _h say 640x480 afterwards -- but it goes on RENDERING 320x240 and asks MGL to double it on
   * the way to the screen (that is what MGL_stretchBltCoord is). The page reads the source buffer,
   * so the canvas stays 320x240, which is right; what was wrong is that the canvas was also DRAWN
   * 320 pixels wide, so the window never grew and choosing a bigger mode appeared to do nothing.
   *
   * Sizing the element from the guest's window and leaving the buffer alone is the same division of
   * labour as everywhere else here: the program owns the pixels, the page owns the presentation.
   */
  if (has) {
    const w = Atomics.load(views.ctrl, SLOT.WIN_W), h = Atomics.load(views.ctrl, SLOT.WIN_H);
    if (w > 0 && h > 0) { canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; }
  } else if (canvas.style.width) {
    canvas.style.width = canvas.style.height = '';
  }
  if (!has || dragging) return;
  // Position is the guest's to give; while a drag is in flight the page owns it for that moment.
  const x = Atomics.load(views.ctrl, SLOT.WIN_X), y = Atomics.load(views.ctrl, SLOT.WIN_Y);
  frame.style.left = `${Math.max(0, x)}px`;
  frame.style.top = `${Math.max(0, y)}px`;
}

$('wintitle').onpointerdown = (e) => {
  if (e.target === $('winclose') || !views) return;
  const frame = $('winframe');
  const r = frame.getBoundingClientRect();
  dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  $('wintitle').setPointerCapture(e.pointerId);
};
$('wintitle').onpointermove = (e) => {
  if (!dragging || !views) return;
  const stage = $('stage').getBoundingClientRect();
  const x = Math.round(e.clientX - stage.left - dragging.dx);
  const y = Math.round(e.clientY - stage.top - dragging.dy);
  $('winframe').style.left = `${x}px`;
  $('winframe').style.top = `${y}px`;
  Atomics.store(views.ctrl, SLOT.DRAG_X, x);
  Atomics.store(views.ctrl, SLOT.DRAG_Y, y);
  Atomics.store(views.ctrl, SLOT.DRAG_GEN, ++dragGen);
};
$('wintitle').onpointerup = () => { dragging = null; };

/*
 * The close button posts WM_CLOSE into the guest's own message queue, which is what a real one does.
 * Quake's MainWndProc handles it and quits through its own path; terminating the worker instead
 * would skip everything the program does on the way out.
 */
$('winclose').onclick = () => {
  if (!views) return;
  Atomics.store(views.ctrl, SLOT.WIN_CLOSE, 1);
  log('close requested — WM_CLOSE posted to the program');
};

// ---------------------------------------------------------------- run / stop
/** Split a command line the way a shell would, so a quoted argument survives as one. */
function tokenise(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/^["']|["']$/g, ''));
}

$('run').onclick = () => startRun();

/**
 * Start what is selected. `typedAs` is the name the person actually used at the prompt, and it
 * becomes argv[0] -- a program is entitled to see the name it was invoked by, and some read it
 * (Quake takes its basedir from argv[0]'s directory).
 */
async function startRun(typedAs = null) {
  const program = current();
  if (!program || !entry()?.present || worker) return;
  if (typeof SharedArrayBuffer === 'undefined') {
    log('SharedArrayBuffer is unavailable — serve this page with tools/serve.mjs, which sends the ' +
      'COOP/COEP headers the browser requires.', 'error');
    return;
  }
  stop(true);
  $('log').innerHTML = '';
  lastLine = null; lastEl = null; lastCount = 0;

  /*
   * THE PROGRAM'S OWN DATA, fetched now and not before. See loadData: the descriptor names one root
   * and this fetches that one. A program with no data root gets an empty filesystem, which is the
   * truthful answer for Lua.
   */
  dataFiles = {};
  if (program.needsData?.dir) {
    const busy = worker;                              // nothing may have started in the meantime
    try {
      dataFiles = await loadData(program.needsData.dir, (m) => { termNote(m); log(m); });
    } catch (e) {
      termNote(e.message, A_ERR);
      termPromptIfTerminal();
      log(`${e.message} — ${program.needsData.hint}`, 'error');
      return;
    }
    if (busy !== worker) return;                      // stopped or restarted while we were fetching
    const n = Object.keys(dataFiles).length;
    termNote(`${n} file${n === 1 ? '' : 's'} ready`);
    log(`${n} data files from ${program.needsData.dir}/`);
  }
  // Only "you loaded nothing at all". WHICH files are needed depends on the arguments — MAME asks
  // for a different ROM set per driver — so a fixed list in the descriptor was wrong for four of the
  // five games and warned about Pac-Man's files while Lady Bug was starting. The program names the
  // file it cannot open, precisely, and that is the better message.

  const control = makeControl();
  views = controlViews(control);
  keyboard = makeKeyboard(views);
  mouse = makeMouse(views);
  /*
   * The machine HAS a mouse from the moment it starts, and capture is a separate question.
   *
   * Quake probes once, in IN_StartupMouse, and remembers the answer for the whole run -- so if this
   * said "no mouse" until somebody clicked, the probe would fail and there would be no mouse for the
   * rest of the session however much you clicked afterwards. A mouse that is plugged in and not
   * being touched reports no movement; that is what an uncaptured page is.
   */
  mouse.present(true);
  Atomics.store(views.ctrl, SLOT.SPEED, +$('speed').value);
  Atomics.store(views.ctrl, SLOT.TEXTMODE, 1);
  Atomics.store(views.ctrl, SLOT.FOCUS, document.hasFocus() ? 1 : 0);

  // argv[0] is the program's own name, as a C program is entitled to expect -- and the name is the
  // one the MACHINE would have used: QUAKE.EXE on DOS, ./quake on a Unix box. Some programs read it
  // (Quake takes its basedir from argv[0]'s directory), so it is not decoration.
  const argv = [typedAs || entry().file, ...tokenise($('args').value)];
  publishQuery();

  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'log') log(m.line, m.kind);
    // The window's caption comes from the program: CreateWindowEx's name, or SetWindowText later.
    else if (m.type === 'window') { if (m.title) $('wincaption').textContent = m.title; }
    else if (m.type === 'ready') {
      /*
       * The guest's memory, and paint() will not draw a single pixel without it -- the graphics
       * branch tests `guest && pixels && w`. A run where this message never arrived showed
       * `running · 320x200` in the status line and a text-mode canvas underneath, which reads as a
       * geometry bug and is not one. Logged so the two cases are told apart on sight.
       */
      guest = new Uint8Array(m.image);
      log(`guest memory: ${(guest.length / 1048576).toFixed(0)} MB shared with the page`);
    }
    else if (m.type === 'failed') log(`build failed: ${m.message}`, 'error');
    else if (m.type === 'diag') window.PRISM_DIAG = m;
  };
  worker.onerror = (e) => log(`worker error: ${e.message}`, 'error');
  /*
   * A program whose descriptor names a second one gets it, with a byte pipe between them.
   *
   * Doom's own source delegates sound to a separate process -- `popen("./sndserver ", "w")` in
   * i_sound.c -- so this was never an audio feature; it is a second address space and a pipe. Both
   * ends are started HERE rather than by the first worker, because that worker's `run` never
   * returns: a child created there would post its messages to an event loop that had stopped.
   */
  let pipeSab = null;
  if (program.soundServer) {
    pipeSab = makePipe();
    soundWorker?.terminate();
    soundWorker = new Worker(new URL('./sndworker.js', import.meta.url), { type: 'module' });
    soundWorker.onmessage = (e) => { if (e.data?.type === 'log') log(`[sound] ${e.data.line}`, e.data.kind); };
    soundWorker.onerror = (e) => log(`[sound] ${e.message || 'failed to start'}`, 'error');
    soundWorker.postMessage({ type: 'start', dir: program.soundServer, pipeSab, control, files: dataFiles });
  }
  worker.postMessage({ type: 'start', program: { ...program, target: chosenTarget() ?? program.target },
                       control, data: dataFiles, argv, pipeSab,
                       /* The machine's own screen, so the program's output continues under the
                          command line instead of starting on a blank page. */
                       screen: machine.kind === 'desktop' ? null
                         : { vram: shellVram.slice(), col: shellCol, row: shellRow } });
  /*
   * The keys are the program's from now on. Without this the whole keyboard depended on which
   * control the user had touched last: type an argument and the focus stays in the field, and every
   * press goes to the field instead of the game.
   */
  document.activeElement?.blur?.();
  startAudio(control);

  // A debug seam: everything the shell knows, reachable from the console. A display bug and a guest
  // bug look identical from the outside, and this is what tells them apart.
  // `data` is here because "the program cannot find its file" and "the page never loaded it" look
  // identical from the outside, and that is exactly the question this seam exists to answer.
  window.PRISM = { views, program, argv, get guest() { return guest; }, paint, keyboard, mouse, SLOT, STATE,
                   get data() { return dataFiles; } };

  $('run').disabled = true; $('stopBtn').disabled = false;
  // The screen belongs to the program from here: the machine's own chooser gives way to the canvas,
  // and the taskbar (on a machine that has one) gets a task in it.
  $('stage').classList.add('running');
  $('vmState').textContent = 'running'; $('vmState').className = 'pill on';
  renderChooser();
  lastFrame = 0; lastStatAt = performance.now(); palGen = -1;
  clearInterval(statTimer);
  // On a timer as well as on rAF, because rAF does not fire in a hidden tab and a status line that
  // goes silent reads as a crash. The PROGRAM is no longer paced by any of this: it keeps its own
  // time, so a hidden tab no longer stalls it.
  statTimer = setInterval(stats, 250);
}

/*
 * Sound. Started here rather than lazily when the guest first publishes a rate, because a browser
 * only lets an AudioContext start from a user gesture -- and the Run button IS that gesture. A page
 * that waited for the program to make a noise would find the context suspended by then.
 *
 * If it fails, the program still runs. Sound is not a precondition for anything.
 */
async function startAudio(control) {
  try {
    stopAudio();
    audioCtx = new AudioContext();
    await audioCtx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
    audioNode = new AudioWorkletNode(audioCtx, 'guest-audio', {
      numberOfInputs: 0, outputChannelCount: [2],
      processorOptions: { control, ringSamples: AUDIO_RING },
    });
    audioNode.connect(audioCtx.destination);
    await audioCtx.resume();
    /*
     * The guest names its own output rate and the page does not resample. Say so when they differ:
     * the sound is then played at the wrong pitch, which is a real defect and one that is very easy
     * to mistake for the emulation being slow.
     */
    log(`audio: ${audioCtx.sampleRate} Hz output`);
  } catch (e) {
    log(`no audio: ${e.message}`, 'warn');
  }
}

function stopAudio() {
  if (audioNode) { audioNode.disconnect(); audioNode = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}

$('stopBtn').onclick = () => stop(false);
function stop(quiet) {
  if (views) {
    // Through the program's own quit path first — Esc, for a program that reads Esc — then take the
    // thread back. A program wedged before its next present call would never see the flag, so the
    // terminate is not optional; but it is second, not first.
    Atomics.store(views.ctrl, SLOT.STOP, 1);
    wake(views.ctrl);
  }
  if (worker) { const w = worker; worker = null; setTimeout(() => w.terminate(), 150); }
  /*
   * And the second program, if there is one. It is parked in Atomics.wait inside its own write --
   * the ring is its clock and nobody is draining it any more -- so nothing short of terminate will
   * bring it back, and leaving it would keep a thread and 64 MB alive across every later run.
   */
  if (soundWorker) { const s = soundWorker; soundWorker = null; setTimeout(() => s.terminate(), 150); }
  clearInterval(statTimer); statTimer = 0;
  stopAudio();
  if (!quiet) log('stopped');
  // The status line described the frame that was on screen when the program went away, and went on
  // describing it -- `running · 224x288 · 60 fps` over a machine sitting at its prompt.
  $('stats').textContent = 'idle';
  $('run').disabled = !entry()?.present; $('stopBtn').disabled = true;
  $('stage').classList.remove('running');
  $('vmState').textContent = 'powered on'; $('vmState').className = 'pill';
  /*
   * The machine gets its screen back, and on a terminal that means the page the PROGRAM left, with a
   * fresh prompt under it. Done BEFORE `guest` is dropped, because that page is in guest memory.
   */
  termResume();
  /*
   * And then the control block goes too. The paint loop chooses between the guest's screen and the
   * machine's by asking whether `views` exists, so leaving it behind after a Stop meant the loop
   * kept painting a guest that was gone -- a black rectangle where the prompt should have come back,
   * which reads as the shell having crashed.
   */
  views = null; keyboard = null; guest = null;
}

$('pause').onclick = () => {
  if (!views) return;
  const now = Atomics.load(views.ctrl, SLOT.PAUSE) ? 0 : 1;
  Atomics.store(views.ctrl, SLOT.PAUSE, now);
  wake(views.ctrl);
  $('pause').textContent = now ? 'Resume' : 'Pause';
};

$('speed').onchange = () => {
  if (!views) return;
  Atomics.store(views.ctrl, SLOT.SPEED, +$('speed').value);
  wake(views.ctrl);                          // a guest asleep until its next frame is due
};

// ---------------------------------------------------------------- painting
const STATE_NAME = ['starting', 'fetching sources', 'compiling', 'running', 'exited', 'error'];

/*
 * ONE LOOP, always running. It used to start on Run and stop when the program did, which was fine
 * while the screen belonged to a program -- but the machine's own terminal is on that same canvas
 * now, and its cursor blinks whether or not anything is running.
 */
function frame() {
  if (views) { paint(); } else {
    // The chrome first even with nothing running: that is where a window's leftover size is cleared,
    // and paint() is not called at all in this state.
    paintWindow();
    paintTextFrom(shellVram, 0, shellCol, shellRow);
  }
  requestAnimationFrame(frame);
}

function paint() {
  if (!views) return;
  /*
   * The CHROME first, and unconditionally. It used to be painted after the picture, which meant
   * every early return in the pixel path took the window with it -- a program whose palette was not
   * ready yet had a window the page never drew, and the two failures look identical from outside.
   */
  paintWindow();
  const { ctrl, pal } = views;
  const pixels = Atomics.load(ctrl, SLOT.PIXELS);
  const w = Atomics.load(ctrl, SLOT.WIDTH), h = Atomics.load(ctrl, SLOT.HEIGHT);

  // One surface, two modes, exactly as the program sees it: text until it creates a display, its
  // framebuffer while it has one, and back to text if it closes it.
  if (guest && pixels && w > 0 && h > 0 && !Atomics.load(ctrl, SLOT.TEXTMODE)) {
    /*
     * THE CANVAS, not just the ImageData. These two went out of sync and the result was the picture
     * drawn 1:1 into the top-left corner of a screen four times too big, with the program's previous
     * screen still visible around it.
     *
     * Every DOS game bounces between text and graphics at startup -- it prints, goes graphical,
     * prints again -- and the text path resizes the canvas to 720x400 on its own. Coming back to
     * graphics, `imageData` still matched 320x200, so this test said there was nothing to do and
     * putImageData wrote 320x200 into a canvas that was still 720x400. Whatever the canvas held
     * outside that rectangle stayed on screen, which is why Heretic's title sat in the corner of its
     * own loading screen and Pac-Man showed a fraction of itself.
     */
    if (!imageData || imageData.width !== w || imageData.height !== h ||
        canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      imageData = cx.createImageData(w, h);
      textImage = null;                      // so a return to text mode reallocates its own image
    }
    /*
     * The palette comes either from the control block, filled in by a platform layer that intercepts
     * the program's palette calls (MAME), or straight out of guest memory for a program that keeps
     * its own (Quake). The second costs 256 reads a frame and saves a layer.
     */
    const palAddr = Atomics.load(ctrl, SLOT.PAL_ADDR);
    if (palAddr) {
      const at = Atomics.load(ctrl, SLOT.PAL_INDIRECT)
        ? new DataView(guest.buffer).getInt32(palAddr, true) : palAddr;
      if (!lut) lut = new Uint32Array(256);
      if (at) {
        for (let i = 0; i < 256; i++) {
          lut[i] = (255 << 24) | (guest[at + i * 3 + 2] << 16) | (guest[at + i * 3 + 1] << 8) | guest[at + i * 3];
        }
      }
    } else {
      const gen = Atomics.load(ctrl, SLOT.PALGEN);
      if (gen !== palGen) {
        lut = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
          lut[i] = (255 << 24) | (pal[i * 3 + 2] << 16) | (pal[i * 3 + 1] << 8) | pal[i * 3];
        }
        palGen = gen;
      }
    }
    const dst = new Uint32Array(imageData.data.buffer);
    /*
     * A DIRECT-COLOUR surface: the Win32 GDI shim and SDL2 both hand over B,G,R,A in memory order,
     * and a canvas wants R first, so the two bytes are swapped here rather than anywhere the guest
     * could see. No palette is involved, which is why this runs before the lut check below.
     */
    if (Atomics.load(ctrl, SLOT.PIXFMT) === 32) {
      for (let i = 0, n = w * h, p = pixels; i < n; i++, p += 4) {
        dst[i] = (255 << 24) | (guest[p] << 16) | (guest[p + 1] << 8) | guest[p + 2];
      }
      cx.putImageData(imageData, 0, 0);
      return;
    }
    if (!lut) return;
    // Read WHILE the guest writes. A tear is possible and accepted: the alternative is a double
    // buffer the guest would have to swap, and the guest is synchronous C that never yields.
    for (let i = 0, n = w * h; i < n; i++) dst[i] = lut[guest[pixels + i]];
    cx.putImageData(imageData, 0, 0);
  } else {
    paintGuestText();
  }
}

/** The guest's frame number: its own counter where it keeps one, ours where it does not. */
function guestFrame() {
  const { ctrl } = views;
  const at = Atomics.load(ctrl, SLOT.FRAME_ADDR);
  if (at && guest) return new DataView(guest.buffer).getInt32(at, true);
  return Atomics.load(ctrl, SLOT.FRAME);
}

function stats() {
  if (!views) return;
  const { ctrl } = views;
  const state = Atomics.load(ctrl, SLOT.STATE);
  const frame = guestFrame();
  const w = Atomics.load(ctrl, SLOT.WIDTH), h = Atomics.load(ctrl, SLOT.HEIGHT);
  const graphics = w > 0 && !Atomics.load(ctrl, SLOT.TEXTMODE);
  const now = performance.now();
  const fps = (frame - lastFrame) * 1000 / (now - lastStatAt);
  // The MEASURED rate only. There used to be a "of N fps" target here, taken from the descriptor —
  // and it became a lie the moment the program started pacing itself from its own
  // drv->frames_per_second. A number the host cannot know should not be printed as if it did.
  $('stats').textContent = (STATE_NAME[state] || state) +
    /*
     * Show the geometry even when the page is in TEXT mode. It used to print `text 80x25` and
     * nothing else, which hid the one case worth seeing: a program that HAS published a framebuffer
     * while TEXTMODE is still 1 -- the canvas then keeps the text size and the game lands in a
     * corner at 1:1. The numbers that decide it should be on screen.
     */
    (graphics ? ` · ${w}x${h} · ${Atomics.load(ctrl, SLOT.PENS)} pens`
      : ` · text ${TEXT_COLS}x${TEXT_ROWS}` +
        (w > 0 ? ` · guest ${w}x${h} @0x${Atomics.load(ctrl, SLOT.PIXELS).toString(16)} (textmode still on)` : '')) +
    (frame ? ` · frame ${frame} · ${fps.toFixed(1)} fps` : '') +
    (frame && $('speed').value !== '100' ? ` · ${$('speed').value === '0' ? 'unlimited' : $('speed').value + '%'}` : '');
  lastFrame = frame; lastStatAt = now;
  if (state === STATE.EXITED || state === STATE.ERROR) finish(state);
}

/**
 * A program ENDED BY ITSELF, which is not the same as being stopped and was not being handled.
 *
 * `exit` came back, the pill said so, Run went live again -- and the machine never got its screen
 * back. On a terminal that left Lua's last page with no prompt under it and a keyboard that went
 * nowhere, because the keys still belonged to a program that had finished; on the Windows desktop it
 * left the dead program's window sitting over the icons.
 *
 * The teardown is the same one Stop performs, so it is the same code: hand the terminal back with a
 * prompt under whatever the program printed, release the control block, close the window. Only the
 * label differs, because "it finished" and "I stopped it" are different facts and the pill is where
 * you read which.
 */
function finish(state) {
  const faulted = state === STATE.ERROR;
  stop(true);
  $('vmState').textContent = faulted ? 'faulted' : 'exited';
  $('stats').textContent = faulted ? 'faulted' : 'exited';
}

/**
 * Query parameters, the way MIRAGE takes them: ?machine=…&program=…&args=…&speed=…&run=1
 *
 * The point is not convenience, it is that a run becomes a LINK — reproducible, and reportable. "It
 * is too fast" and "?machine=dos&program=mame-0.4&args=pengo&speed=50" are not the same bug report.
 * The MACHINE is in it because the same program on two machines is two different builds.
 */
function applyQuery() {
  const q = new URLSearchParams(location.search);
  const want = q.get('program') || q.get('p');
  const wantMachine = q.get('machine') || q.get('m');
  const m = machines.find(x => x.id === wantMachine)
    ?? (want ? machines.find(x => x.programs.some(e => e.program === want)) : null);
  if (m) {
    const i = Math.max(0, m.programs.findIndex(e => e.program === want));
    pick(m, i);
  }
  const args = q.get('args');
  if (args !== null) $('args').value = args;
  const speed = q.get('speed');
  if (speed !== null && [...$('speed').options].some(o => o.value === speed)) $('speed').value = speed;
  if (q.get('run') === '1' || q.get('autorun') === '1') $('run').click();
}

/** Keep the address bar describing what is actually running, so a reload repeats it. */
function publishQuery() {
  const q = new URLSearchParams();
  q.set('machine', machine.id);
  q.set('program', entry().program);
  if ($('args').value.trim()) q.set('args', $('args').value.trim());
  if ($('speed').value !== '100') q.set('speed', $('speed').value);
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

/* Whatever was chosen last time; closed the first time, because the machine's screen is the point. */
try { showPanel(localStorage.getItem('prism.panel') === '1'); } catch { showPanel(false); }

requestAnimationFrame(frame);

discover()
  .then(applyQuery)
  .catch(e => log(`could not read the shelf (web/machines.json): ${e.message}`, 'error'));
