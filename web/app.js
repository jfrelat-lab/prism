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

import { makeControl, controlViews, KEY_HOLD_FRAMES, SLOT, STATE } from '../src/env/webhost.js';
import { scancodeForEvent } from '../src/env/scancodes.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const cx = canvas.getContext('2d', { alpha: false });

let worker = null, views = null, guest = null;
let imageData = null, lut = null, palGen = -1;
let statTimer = 0, lastStatAt = 0, lastFrame = 0;

// ---------------------------------------------------------------- the text surface
//
// 80x25 because that is what a DOS program assumes, and 9x16 cells because that is the VGA text cell
// — the proportions matter more than the exact glyphs for this to read as a console.
const COLS = 80, ROWS = 25, CELL_W = 9, CELL_H = 16;
const text = { cells: new Uint8Array(COLS * ROWS).fill(32), col: 0, row: 0, dirty: true };

function textClear() { text.cells.fill(32); text.col = 0; text.row = 0; text.dirty = true; }
function textScroll() {
  text.cells.copyWithin(0, COLS);
  text.cells.fill(32, COLS * (ROWS - 1));
  text.row = ROWS - 1;
}
function textNewline() { text.col = 0; if (++text.row >= ROWS) textScroll(); }
function textWrite(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) { textNewline(); continue; }            // \n
    if (c === 13) { text.col = 0; continue; }             // \r
    if (c === 8) { if (text.col > 0) text.col--; continue; }
    if (c === 9) { text.col = Math.min(COLS - 1, (text.col + 8) & ~7); continue; }
    if (c === 7) continue;                                // bell: nothing to ring
    if (text.col >= COLS) textNewline();
    text.cells[text.row * COLS + text.col] = (c < 32 || c > 126) ? 32 : c;
    text.col++;
  }
  text.dirty = true;
}
function paintText() {
  if (canvas.width !== COLS * CELL_W || canvas.height !== ROWS * CELL_H) {
    canvas.width = COLS * CELL_W; canvas.height = ROWS * CELL_H;
    text.dirty = true;
  }
  if (!text.dirty) return;
  cx.fillStyle = '#000';
  cx.fillRect(0, 0, canvas.width, canvas.height);
  // Sized so the glyph actually fits the cell. A 14px monospace glyph in a 9px cell overlapped its
  // neighbours and an ASCII drawing became mud.
  cx.font = `${CELL_H - 4}px ui-monospace, Menlo, monospace`;
  cx.textBaseline = 'top';
  cx.fillStyle = '#c8c8c8';
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) line += String.fromCharCode(text.cells[r * COLS + c]);
    line = line.replace(/\s+$/, '');
    // Per-character placement, not one fillText for the line: a proportional fallback font would
    // otherwise drift and the columns of an ASCII drawing would not line up.
    for (let c = 0; c < line.length; c++) {
      if (line[c] !== ' ') cx.fillText(line[c], c * CELL_W, r * CELL_H);
    }
  }
  text.dirty = false;
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
      dataFiles[f.replace(/^.*\//, '')] =
        new Uint8Array(await (await fetch(`/__data/${f}`)).arrayBuffer());
    }));
    $('dataNote').textContent = `${files.length} files from --data`;
  } catch (e) {
    log(`no server data directory: ${e.message} (start serve.mjs with --data=<dir>)`, 'warn');
  }
};

// ---------------------------------------------------------------- keyboard
addEventListener('keydown', (e) => {
  if (!views || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
  const sc = scancodeForEvent(e);
  if (!sc) return;
  views.keys[sc] = 1;
  views.latch[sc] = KEY_HOLD_FRAMES;   // so a brief tap survives long enough to be sampled
  e.preventDefault();
});
addEventListener('keyup', (e) => {
  if (!views) return;
  const sc = scancodeForEvent(e);
  if (!sc) return;
  views.keys[sc] = 0;
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
  textClear();
  if (program.needsData) {
    const have = new Set(Object.keys(dataFiles).map(n => n.toLowerCase()));
    const absent = (program.needsData.names || []).filter(n => !have.has(n.toLowerCase()));
    if (absent.length) log(`no data file for: ${absent.join(' ')} — the program will say so itself`, 'warn');
  }

  const control = makeControl();
  views = controlViews(control);
  Atomics.store(views.ctrl, SLOT.SPEED, +$('speed').value);
  Atomics.store(views.ctrl, SLOT.TEXTMODE, 1);

  // argv[0] is the program's own name, as a C program is entitled to expect.
  const argv = [$('program').value, ...tokenise($('args').value)];

  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'log') log(m.line, m.kind);
    else if (m.type === 'out') textWrite(m.text);
    else if (m.type === 'ready') guest = new Uint8Array(m.image);
    else if (m.type === 'failed') log(`build failed: ${m.message}`, 'error');
  };
  worker.onerror = (e) => log(`worker error: ${e.message}`, 'error');
  worker.postMessage({ type: 'start', program, control, data: dataFiles, argv });

  // A debug seam: everything the shell knows, reachable from the console. A display bug and a guest
  // bug look identical from the outside, and this is what tells them apart.
  window.PRISM = { views, program, argv, text, get guest() { return guest; }, paint, SLOT, STATE };

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
    Atomics.notify(views.ctrl, SLOT.STOP);
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
  Atomics.notify(views.ctrl, SLOT.PAUSE);
  $('pause').textContent = now ? 'Resume' : 'Pause';
};

$('speed').onchange = () => {
  if (!views) return;
  Atomics.store(views.ctrl, SLOT.SPEED, +$('speed').value);
  Atomics.notify(views.ctrl, SLOT.STOP);     // wake a guest asleep until its next frame is due
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
      text.dirty = true;                     // so a return to text mode repaints from scratch
    }
    const gen = Atomics.load(ctrl, SLOT.PALGEN);
    if (gen !== palGen) {
      lut = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        lut[i] = (255 << 24) | (pal[i * 3 + 2] << 16) | (pal[i * 3 + 1] << 8) | pal[i * 3];
      }
      palGen = gen;
    }
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

function stats() {
  if (!views) return;
  const { ctrl } = views;
  const state = Atomics.load(ctrl, SLOT.STATE);
  const frame = Atomics.load(ctrl, SLOT.FRAME);
  const w = Atomics.load(ctrl, SLOT.WIDTH), h = Atomics.load(ctrl, SLOT.HEIGHT);
  const graphics = w > 0 && !Atomics.load(ctrl, SLOT.TEXTMODE);
  const now = performance.now();
  const fps = (frame - lastFrame) * 1000 / (now - lastStatAt);
  const target = Atomics.load(ctrl, SLOT.FPS) / 1000;
  $('stats').textContent = (STATE_NAME[state] || state) +
    (graphics ? ` · ${w}x${h} · ${Atomics.load(ctrl, SLOT.PENS)} pens` : ` · text ${COLS}x${ROWS}`) +
    (frame ? ` · frame ${frame} · ${fps.toFixed(1)} of ${target || 60} fps` : '');
  lastFrame = frame; lastStatAt = now;
  if (state === STATE.EXITED || state === STATE.ERROR) {
    $('run').disabled = false; $('stopBtn').disabled = true;
    clearInterval(statTimer); statTimer = 0;
  }
}

paintText();
discover().catch(e => log(`could not list web/programs: ${e.message}`, 'error'));
