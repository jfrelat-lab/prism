// app.js — the shell: a canvas, a console, and a keyboard.
//
// This file contains no knowledge of any program. It paints whatever 8-bit framebuffer the guest's
// platform layer publishes, at whatever size the guest asked for, through whatever palette the guest
// built — and it forwards scan codes. A program that runs under PRISM runs here with no shell change.

import { PROGRAMS } from './programs.js';
import { makeControl, controlViews, KEY_HOLD_FRAMES, SLOT, STATE } from '../src/env/webhost.js';
import { scancodeForEvent } from '../src/env/scancodes.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const cx = canvas.getContext('2d', { alpha: false });

let worker = null, views = null, guest = null, imageData = null, lut = null, palGen = -1;
let painted = 0, lastFpsAt = 0, lastFrame = 0;

// --- program picker
for (const [id, p] of Object.entries(PROGRAMS)) {
  const opt = document.createElement('option');
  opt.value = id; opt.textContent = p.title;
  $('program').append(opt);
}
function currentProgram() { return PROGRAMS[$('program').value]; }

function describe() {
  const p = currentProgram();
  $('hint').textContent = p.needsData ? p.needsData.hint : '';
  $('controls').innerHTML = (p.controls || [])
    .map(([k, what]) => `<kbd>${k}</kbd> ${what}`).join(' · ');
}
$('program').onchange = describe;
describe();

// --- log pane
function log(line, kind = 'info') {
  const el = document.createElement('div');
  el.className = `line ${kind}`;
  el.textContent = line;
  $('log').append(el);
  $('log').scrollTop = $('log').scrollHeight;
}
function out(text) {
  // The program's own stdout, kept visually distinct from the shell's reporting.
  const last = $('log').lastElementChild;
  if (last && last.classList.contains('stdout')) { last.textContent += text; }
  else { const el = document.createElement('pre'); el.className = 'line stdout'; el.textContent = text; $('log').append(el); }
  $('log').scrollTop = $('log').scrollHeight;
}

// --- the data files the program reads. Chosen by the user; nothing is downloaded.
let dataFiles = {};
$('data').onchange = async (e) => {
  dataFiles = {};
  for (const f of e.target.files) {
    dataFiles[f.name] = new Uint8Array(await f.arrayBuffer());
  }
  const names = Object.keys(dataFiles);
  $('dataNote').textContent = names.length ? `${names.length} files: ${names.join(' ')}` : '';
};

/**
 * The opt-in server-side data directory (serve.mjs --data=<dir>). Same files, same constraint — a
 * directory the user named on the command line — but it survives a reload, which the file picker
 * does not.
 */
$('loadServer').onclick = async () => {
  try {
    const r = await fetch('/__data/');
    if (!r.ok) throw new Error(await r.text());
    const { files } = await r.json();
    dataFiles = {};
    await Promise.all(files.map(async (f) => {
      const b = await (await fetch(`/__data/${f}`)).arrayBuffer();
      dataFiles[f.replace(/^.*\//, '')] = new Uint8Array(b);
    }));
    $('dataNote').textContent = `${files.length} files from the server's data dir`;
    log(`loaded ${files.length} data files from the --data directory`);
  } catch (e) {
    log(`no server data directory: ${e.message} (start serve.mjs with --data=<dir>)`, 'warn');
  }
};

// --- keyboard.
//
// A held key is one byte in shared memory. preventDefault on every key the guest recognises, or the
// arrows scroll the page out from under the game and Tab walks the focus ring away.
addEventListener('keydown', (e) => {
  if (!views || document.activeElement === $('program')) return;
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
// A lost focus must release everything, or the game keeps walking left forever.
addEventListener('blur', () => { if (views) views.keys.fill(0); });

// --- start / stop
$('start').onclick = () => {
  const program = currentProgram();
  if (typeof SharedArrayBuffer === 'undefined') {
    log('SharedArrayBuffer is unavailable: serve this page with tools/serve.mjs, which sends the ' +
      'COOP/COEP headers the browser requires.', 'error');
    return;
  }
  stop(true);
  $('log').innerHTML = '';
  dataWarning(program);

  const control = makeControl();
  views = controlViews(control);
  Atomics.store(views.ctrl, SLOT.SPEED, +$('speed').value);

  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'log') log(m.line, m.kind);
    else if (m.type === 'out') out(m.text);
    else if (m.type === 'ready') { guest = new Uint8Array(m.image); }
    else if (m.type === 'failed') log(`build failed: ${m.message}`, 'error');
  };
  worker.onerror = (e) => log(`worker error: ${e.message}`, 'error');
  worker.postMessage({ type: 'start', program, control, data: dataFiles }, []);

  // A debug seam. Everything the shell knows is reachable from the console, because a display bug
  // and a guest bug look identical from the outside and this is what tells them apart.
  window.PRISM = { views, program, get guest() { return guest; }, SLOT, STATE, paint };

  $('start').disabled = true; $('stop').disabled = false;
  painted = 0; lastFrame = 0; lastFpsAt = performance.now(); palGen = -1;
  requestAnimationFrame(paint);
  // Acknowledgement is on a TIMER, not on paint. requestAnimationFrame does not fire in a hidden
  // tab, and pacing off it deadlocked the guest the moment the tab lost focus — it sat at frame 2
  // forever. A background tab now throttles the program instead of freezing it.
  clearInterval(ackTimer);
  ackTimer = setInterval(ack, 16);
};

let ackTimer = 0;
function ack() {
  if (!views) return;
  const { ctrl } = views;
  const frame = Atomics.load(ctrl, SLOT.FRAME);
  if (Atomics.load(ctrl, SLOT.ACK) !== frame) {
    Atomics.store(ctrl, SLOT.ACK, frame);
    Atomics.notify(ctrl, SLOT.ACK);
  }
  // Reported from here rather than from paint(), for the same reason: a hidden tab still runs the
  // program, and a status line that goes silent looks like a crash.
  const now = performance.now();
  if (now - lastFpsAt > 500) {
    const state = Atomics.load(ctrl, SLOT.STATE);
    const w = Atomics.load(ctrl, SLOT.WIDTH), h = Atomics.load(ctrl, SLOT.HEIGHT);
    const fps = (frame - lastFrame) * 1000 / (now - lastFpsAt);
    $('stats').textContent = `${STATE_NAME[state] || state}` +
      (w ? ` \u00b7 ${w}x${h} \u00b7 ${Atomics.load(ctrl, SLOT.PENS)} pens` : '') +
      ` \u00b7 frame ${frame} \u00b7 ${fps.toFixed(1)} fps`;
    lastFpsAt = now; lastFrame = frame;
    if (state === STATE.EXITED || state === STATE.ERROR) {
      $('start').disabled = false; $('stop').disabled = true;
    }
  }
}

function dataWarning(program) {
  if (!program.needsData) return;
  const have = new Set(Object.keys(dataFiles).map(n => n.toLowerCase()));
  const absent = program.needsData.names.filter(n => !have.has(n.toLowerCase()));
  if (absent.length) {
    log(`no data file for: ${absent.join(' ')} — the program will report them itself`, 'warn');
  }
}

$('stop').onclick = () => stop(false);
function stop(quiet) {
  if (views) {
    // Ask through the program's own quit path first, then take the thread back. A program that is
    // wedged before its next present call would never see the flag, so the terminate is not
    // optional — but it is second, not first.
    Atomics.store(views.ctrl, SLOT.STOP, 1);
    Atomics.notify(views.ctrl, SLOT.ACK);
  }
  if (worker) setTimeout(() => { worker && worker.terminate(); worker = null; }, 120);
  clearInterval(ackTimer); ackTimer = 0;
  if (!quiet) log('stopped');
  $('start').disabled = false; $('stop').disabled = true;
  guest = null;
}

$('pause').onclick = () => {
  if (!views) return;
  const now = Atomics.load(views.ctrl, SLOT.PAUSE) ? 0 : 1;
  Atomics.store(views.ctrl, SLOT.PAUSE, now);
  Atomics.notify(views.ctrl, SLOT.ACK);
  $('pause').textContent = now ? 'Resume' : 'Pause';
};

$('speed').onchange = () => {
  if (views) Atomics.store(views.ctrl, SLOT.SPEED, +$('speed').value);
  Atomics.notify(views.ctrl, SLOT.ACK);
};

// --- the paint loop.
//
// It reads the guest's memory WHILE the guest writes it. A tear is possible and accepted: the
// alternative is a double buffer the guest would have to swap, and the guest is synchronous C that
// never yields. In practice a tear is invisible, and correctness is unaffected — this is a display,
// not a measurement.
const STATE_NAME = ['starting', 'fetching sources', 'compiling', 'running', 'exited', 'error'];

function paint() {
  if (!views) return;
  const { ctrl, pal } = views;
  const w = Atomics.load(ctrl, SLOT.WIDTH), h = Atomics.load(ctrl, SLOT.HEIGHT);
  const pixels = Atomics.load(ctrl, SLOT.PIXELS);

  if (guest && pixels && w > 0 && h > 0) {
    if (!imageData || imageData.width !== w || imageData.height !== h) {
      canvas.width = w; canvas.height = h;
      imageData = cx.createImageData(w, h);
    }
    const gen = Atomics.load(ctrl, SLOT.PALGEN);
    if (gen !== palGen) {
      // One RGBA word per pen, so the inner loop is a single indexed store.
      lut = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        lut[i] = (255 << 24) | (pal[i * 3 + 2] << 16) | (pal[i * 3 + 1] << 8) | pal[i * 3];
      }
      palGen = gen;
    }
    const dst = new Uint32Array(imageData.data.buffer);
    for (let i = 0, n = w * h; i < n; i++) dst[i] = lut[guest[pixels + i]];
    cx.putImageData(imageData, 0, 0);
  }

  ack();
  painted++;
  requestAnimationFrame(paint);
}
