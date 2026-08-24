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

import { makeControl, controlViews, makeKeyboard, wake, KEY_HOLD_FRAMES, SLOT, STATE }
  from '../src/env/webhost.js';
import { scancodeForEvent } from '../src/env/scancodes.js';
import { VRAM_TEXT, TEXT_COLS, TEXT_ROWS } from '../src/link/module.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const cx = canvas.getContext('2d', { alpha: false });

let worker = null, views = null, guest = null;
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

function paintText() {
  const W = TEXT_COLS * CELL_W, H = TEXT_ROWS * CELL_H;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; canvas.height = H;
    textImage = null;
  }
  if (!textImage) {
    textImage = cx.createImageData(W, H);
    textU32 = new Uint32Array(textImage.data.buffer);
  }
  if (!font || !guest) { cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H); return; }

  blink++;
  for (let row = 0; row < TEXT_ROWS; row++) {
    for (let col = 0; col < TEXT_COLS; col++) {
      const at = VRAM_TEXT + (row * TEXT_COLS + col) * 2;
      const ch = guest[at], attr = guest[at + 1];
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
  // The cursor, from the BIOS data area the console maintains: an underline on the bottom two rows.
  const ccol = guest[0x450], crow = guest[0x451];
  if ((blink >> 4) & 1 && crow < TEXT_ROWS && ccol < TEXT_COLS) {
    const fg = TEXT_PALETTE[guest[VRAM_TEXT + (crow * TEXT_COLS + ccol) * 2 + 1] & 0x0f];
    for (let y = CELL_H - 3; y < CELL_H - 1; y++) {
      let o = (crow * CELL_H + y) * W + ccol * CELL_W;
      for (let x = 0; x < CELL_W; x++) textU32[o++] = fg;
    }
  }
  cx.putImageData(textImage, 0, 0);
}

// ---------------------------------------------------------------- program discovery
let programs = {};
async function discover() {
  const { files } = await (await fetch('/__ls?dir=web/programs')).json();
  for (const f of files.filter(f => f.endsWith('.json'))) {
    programs[f.replace(/\.json$/, '')] = await (await fetch(`/web/programs/${f}`)).json();
  }
  const sel = $('program');
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(programs)) {
    const o = document.createElement('option');
    o.value = id; o.textContent = p.title || id;
    sel.append(o);
  }
  describe();
}

function current() { return programs[$('program').value]; }

function describe() {
  const p = current();
  if (!p) return;
  $('subtitle').textContent = p.subtitle || '';
  $('args').value = p.args || '';
  $('args').placeholder = p.argsHint || 'arguments passed to main()';
  $('dataRow').style.display = p.needsData ? '' : 'none';
  $('controls').innerHTML = (p.controls || [])
    .map(([k, what]) => `<kbd>${k}</kbd> ${what}`).join(' · ');
  $('controls').style.display = (p.controls || []).length ? '' : 'none';
}
$('program').onchange = describe;

// ---------------------------------------------------------------- the shell's own log
function log(line, kind = 'info') {
  const el = document.createElement('div');
  el.className = `line ${kind}`;
  el.textContent = line;
  $('log').append(el);
  $('log').scrollTop = $('log').scrollHeight;
}

// ---------------------------------------------------------------- data files
let dataFiles = {};
$('data').onchange = async (e) => {
  dataFiles = {};
  for (const f of e.target.files) dataFiles[f.name] = new Uint8Array(await f.arrayBuffer());
  $('dataNote').textContent = `${Object.keys(dataFiles).length} files chosen`;
};

/**
 * The opt-in server-side data directory (serve.mjs --data=<dir>): the same constraint as the file
 * picker — a directory the user named — but it survives a reload, which the picker does not.
 */
$('loadServer').onclick = async () => {
  try {
    const r = await fetch('/__data/');
    if (!r.ok) throw new Error(await r.text());
    const { files } = await r.json();
    dataFiles = {};
    await Promise.all(files.map(async (f) => {
      // Keep the relative path as the key. MAME asks for "pacman/pacman.6e", and flattening it to
      // "pacman.6e" left only a case-insensitive basename match to save it — which also lets one
      // game's file answer for another's when two ROM sets share a filename.
      dataFiles[f] = new Uint8Array(await (await fetch(`/__data/${f}`)).arrayBuffer());
    }));
    $('dataNote').textContent = `${files.length} files from --data`;
  } catch (e) {
    log(`no server data directory: ${e.message} (start serve.mjs with --data=<dir>)`, 'warn');
  }
};

// ---------------------------------------------------------------- keyboard
//
// Two distinct questions, answered separately, exactly as MIRAGE does it: which keys are HELD (a byte
// per scan code, what a game polls every frame) and which characters were TYPED (an ordered queue,
// what getchar reads once each). Answering the second with the first reports Enter as pressed for as
// long as the finger is down.
let keyboard = null;

addEventListener('keydown', (e) => {
  if (!views || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
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
    keyboard.push(sc, ascii);
  }
  e.preventDefault();
});
addEventListener('keyup', (e) => {
  if (!views) return;
  const sc = scancodeForEvent(e);
  if (!sc) return;
  views.keys[sc] = 0;
  // A guest parked inside `while (osd_key_pressed(k));` is waiting for exactly this, so tell it now
  // rather than leaving it to notice on its next timeout.
  wake(views.ctrl);
  e.preventDefault();
});
// A lost focus must release everything, or the program keeps walking left for ever.
addEventListener('blur', () => { if (views) views.keys.fill(0); });

// ---------------------------------------------------------------- run / stop
/** Split a command line the way a shell would, so a quoted argument survives as one. */
function tokenise(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/^["']|["']$/g, ''));
}

$('run').onclick = () => {
  const program = current();
  if (!program) return;
  if (typeof SharedArrayBuffer === 'undefined') {
    log('SharedArrayBuffer is unavailable — serve this page with tools/serve.mjs, which sends the ' +
      'COOP/COEP headers the browser requires.', 'error');
    return;
  }
  stop(true);
  $('log').innerHTML = '';
  // Only "you loaded nothing at all". WHICH files are needed depends on the arguments — MAME asks
  // for a different ROM set per driver — so a fixed list in the descriptor was wrong for four of the
  // five games and warned about Pac-Man's files while Lady Bug was starting. The program names the
  // file it cannot open, precisely, and that is the better message.
  if (program.needsData && !Object.keys(dataFiles).length) {
    log(`no data files loaded — ${program.needsData.hint}`, 'warn');
  }

  const control = makeControl();
  views = controlViews(control);
  keyboard = makeKeyboard(views);
  Atomics.store(views.ctrl, SLOT.SPEED, +$('speed').value);
  Atomics.store(views.ctrl, SLOT.TEXTMODE, 1);

  // argv[0] is the program's own name, as a C program is entitled to expect.
  const argv = [$('program').value, ...tokenise($('args').value)];
  publishQuery();

  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'log') log(m.line, m.kind);
    else if (m.type === 'ready') guest = new Uint8Array(m.image);
    else if (m.type === 'failed') log(`build failed: ${m.message}`, 'error');
    else if (m.type === 'diag') window.PRISM_DIAG = m;
  };
  worker.onerror = (e) => log(`worker error: ${e.message}`, 'error');
  worker.postMessage({ type: 'start', program, control, data: dataFiles, argv });

  // A debug seam: everything the shell knows, reachable from the console. A display bug and a guest
  // bug look identical from the outside, and this is what tells them apart.
  window.PRISM = { views, program, argv, get guest() { return guest; }, paint, keyboard, SLOT, STATE };

  $('run').disabled = true; $('stopBtn').disabled = false;
  lastFrame = 0; lastStatAt = performance.now(); palGen = -1;
  requestAnimationFrame(paint);
  clearInterval(statTimer);
  // On a timer as well as on rAF, because rAF does not fire in a hidden tab and a status line that
  // goes silent reads as a crash. The PROGRAM is no longer paced by any of this: it keeps its own
  // time, so a hidden tab no longer stalls it.
  statTimer = setInterval(stats, 250);
};

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
  clearInterval(statTimer); statTimer = 0;
  if (!quiet) log('stopped');
  $('run').disabled = false; $('stopBtn').disabled = true;
  guest = null;
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

function paint() {
  if (!views) return;
  const { ctrl, pal } = views;
  const pixels = Atomics.load(ctrl, SLOT.PIXELS);
  const w = Atomics.load(ctrl, SLOT.WIDTH), h = Atomics.load(ctrl, SLOT.HEIGHT);

  // One surface, two modes, exactly as the program sees it: text until it creates a display, its
  // framebuffer while it has one, and back to text if it closes it.
  if (guest && pixels && w > 0 && h > 0 && !Atomics.load(ctrl, SLOT.TEXTMODE)) {
    if (!imageData || imageData.width !== w || imageData.height !== h) {
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
    if (!lut) return requestAnimationFrame(paint);
    // Read WHILE the guest writes. A tear is possible and accepted: the alternative is a double
    // buffer the guest would have to swap, and the guest is synchronous C that never yields.
    const dst = new Uint32Array(imageData.data.buffer);
    for (let i = 0, n = w * h; i < n; i++) dst[i] = lut[guest[pixels + i]];
    cx.putImageData(imageData, 0, 0);
  } else {
    paintText();
  }
  requestAnimationFrame(paint);
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
    (graphics ? ` · ${w}x${h} · ${Atomics.load(ctrl, SLOT.PENS)} pens` : ` · text ${TEXT_COLS}x${TEXT_ROWS}`) +
    (frame ? ` · frame ${frame} · ${fps.toFixed(1)} fps` : '') +
    (frame && $('speed').value !== '100' ? ` · ${$('speed').value === '0' ? 'unlimited' : $('speed').value + '%'}` : '');
  lastFrame = frame; lastStatAt = now;
  if (state === STATE.EXITED || state === STATE.ERROR) {
    $('run').disabled = false; $('stopBtn').disabled = true;
    clearInterval(statTimer); statTimer = 0;
  }
}

/**
 * Query parameters, the way MIRAGE takes them: ?program=…&args=…&speed=…&run=1
 *
 * The point is not convenience, it is that a run becomes a LINK — reproducible, and reportable. "It
 * is too fast" and "?program=mame-0.1&args=pengo&speed=50" are not the same bug report.
 */
function applyQuery() {
  const q = new URLSearchParams(location.search);
  const want = q.get('program') || q.get('p');
  if (want && programs[want]) { $('program').value = want; describe(); }
  const args = q.get('args');
  if (args !== null) $('args').value = args;
  const speed = q.get('speed');
  if (speed !== null && [...$('speed').options].some(o => o.value === speed)) $('speed').value = speed;
  if (q.get('run') === '1' || q.get('autorun') === '1') $('run').click();
}

/** Keep the address bar describing what is actually running, so a reload repeats it. */
function publishQuery() {
  const q = new URLSearchParams();
  q.set('program', $('program').value);
  if ($('args').value.trim()) q.set('args', $('args').value.trim());
  if ($('speed').value !== '100') q.set('speed', $('speed').value);
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

discover()
  .then(applyQuery)
  .catch(e => log(`could not list web/programs: ${e.message}`, 'error'));
