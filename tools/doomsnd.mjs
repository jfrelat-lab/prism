// doomsnd.mjs — Doom and its sound server, as two programs.
//
// Doom's own source delegates sound to a separate process:
//
//     #define SNDSERV  1                                    // doomdef.h:84
//     sndserver = popen("./sndserver ", "w");               // i_sound.c
//     fprintf(sndserver, "p%2.2x%2.2x%2.2x%2.2x\n", …);
//
// So making Doom audible was never an audio problem. `corpus/DOOM/sndserv/` compiles and mixes
// correctly on its own (tools/sndserv.mjs proves that); what was missing was two address spaces and
// a pipe. This runs Doom in this thread and the server in a worker, connected by
// src/env/pipe.js, with the mixed result landing in the audio ring the browser page already reads.
//
// Neither program is modified, neither is interleaved, and neither knows the other is not a process.
//
//   node tools/doomsnd.mjs --data=<dir with DOOM1.WAD> [--frames=400] [--wav=/tmp/doom.wav]

import { Worker } from 'node:worker_threads';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram } from '../src/compile.js';
import { installStdio } from '../src/env/stdio.js';
import { installX11 } from '../src/env/x11.js';
import { installPopen } from '../src/env/popen.js';
import { makePipe, pipeReader, pipeWriter } from '../src/env/pipe.js';
import { makeControl, controlViews, SLOT } from '../src/env/webhost.js';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOOM = join(ROOT, 'corpus/DOOM/linuxdoom-1.10');
const SNDSERV = join(ROOT, 'corpus/DOOM/sndserv');
const opt = (n, d = null) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;

if (!existsSync(SNDSERV)) { console.error(`corpus missing: ${SNDSERV}`); process.exit(2); }

const dataArg = opt('data');
const files = {};
if (dataArg) {
  for (const f of readdirSync(dataArg)) {
    const full = join(dataArg, f);
    if (statSync(full).isFile()) files[f] = new Uint8Array(readFileSync(full));
  }
}
console.log(`data: ${Object.keys(files).length} files`);

// --- the shared memory the two programs meet in
const pipeSab = makePipe();
const controlSab = makeControl();
const views = controlViews(controlSab);

// --- the second process
const worker = new Worker(join(ROOT, 'tools/sndserv-worker.mjs'), {
  workerData: {
    src: SNDSERV, pipeSab, controlSab, quiet: !process.argv.includes('--verbose-snd'),
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)])),
  },
});
worker.on('message', (m) => console.log(`  [sndserver] ${m.line}`));
worker.on('error', (e) => console.log(`  [sndserver] threw: ${e.message}`));
worker.unref();

// --- Doom
const resolve = (name) => {
  const local = join(DOOM, basename(name));
  if (existsSync(local) && statSync(local).isFile()) return { path: local, text: readFileSync(local, 'latin1') };
  const std = HEADERS[name] ?? HEADERS[basename(name)];
  return std === undefined ? { path: `<missing:${name}>`, text: '' } : { path: `<${name}>`, text: std };
};
const units = readdirSync(DOOM).filter(f => f.endsWith('.c')).sort()
  .map(f => ({ file: join(DOOM, f), source: readFileSync(join(DOOM, f), 'latin1') }));
const prog = compileProgram(units, {
  defines: { NORMALUNIX: '1', LINUX: '1' }, resolve, memory: 128 * 1024 * 1024, collect: true,
});
console.log(`doom: ${Object.keys(prog.F).length} functions`);

installStdio(prog.M, { files });
// Live output: I_InitSound reports what it found on stderr, and that is the only place a failed
// popen announces itself.
const write = prog.M.write.bind(prog.M);
prog.M.write = (str) => { process.stdout.write(str); write(str); };
/*
 * `./sndserver` is the command Doom builds -- possibly with $DOOMWADDIR in front of it -- and the
 * pipe is the one the worker is reading. Nothing is started here: the process already exists.
 */
const pop = installPopen(prog.M, { pipes: [{ match: /sndserver/, sab: pipeSab }] });
/*
 * A trigger, because a Doom standing still makes no sound.
 *
 * The shareware WAD's demos will not play (`Demo is from a different game version!`), so with
 * `-warp 1 1` the player spawns and does nothing. Ctrl is fire: one keypress produces a pistol shot,
 * which is what sends the first line down the pipe. Delivered through Xlib's event queue, which is
 * where a key really arrives for an X client.
 */
const CTRL = 29;                                    // set-1 scan code; x11.js maps it to XK_Control_L
let keyFrame = +(opt('fire') ?? 40);
const keyEvents = [];
const x11 = installX11(prog.M, {
  keyboard: { pending: () => keyEvents.length, next: () => keyEvents.shift() ?? null },
});

let frames = 0;
const FRAMES = +(opt('frames') ?? 400);
const putImage = prog.M.rt.XPutImage;
prog.M.rt.XPutImage = (...a) => {
  const r = putImage(...a);
  if (++frames >= FRAMES) throw new Error('__frames_done');
  return r;
};

/*
 * Drain the audio ring as the page would.
 *
 * This thread is the consumer, so it must publish what it has taken -- src/env/dsp.js stops writing
 * when the ring is full, exactly as it does for a browser that has stopped painting. Draining from
 * inside XPutImage means it happens once per frame, which is when a page would repaint.
 */
const wav = [];
const drain = () => {
  const written = Atomics.load(views.ctrl, SLOT.AUDIO_WRITE);
  let read = Atomics.load(views.ctrl, SLOT.AUDIO_READ);
  const ch = Atomics.load(views.ctrl, SLOT.AUDIO_CHANNELS) || 2;
  const frames_ = views.audio.length / ch;
  while (read < written) {
    const i = (read % frames_) * ch;
    for (let c = 0; c < ch; c++) wav.push(views.audio[i + c]);
    read++;
  }
  Atomics.store(views.ctrl, SLOT.AUDIO_READ, read);
  Atomics.notify(views.ctrl, SLOT.AUDIO_READ);   // the server may be waiting on exactly this
};
const putImage2 = prog.M.rt.XPutImage;
prog.M.rt.XPutImage = (...a) => {
  drain();
  // Fire, then release two frames later: a held key is not a shot.
  if (frames === keyFrame) keyEvents.push({ type: 2, down: true, scan: CTRL });
  if (frames === keyFrame + 2) { keyEvents.push({ type: 3, down: false, scan: CTRL }); keyFrame += 30; }
  return putImage2(...a);
};

if (process.argv.includes('--trace-sound')) {
  for (const n of ['I_StartSound', 'S_StartSound', 'I_SubmitSound', 'I_UpdateSound']) {
    const inner = prog.F[n];
    if (typeof inner !== 'function') { console.log(`(no ${n})`); continue; }
    let count = 0;
    const w = function (...a) { if (++count <= 3) console.log(`[trace] ${n} #${count}`); return inner.apply(this, a); };
    prog.F[n] = w; prog.mod.bindFunc(n, w);
  }
}

/*
 * --inject=1a,20,7f,80 writes one command straight into the pipe, in Doom's own format.
 *
 * It isolates the two halves: if the server mixes this, the pipe and the second process work and any
 * silence left is Doom not asking for a sound. Testing them together makes one failure look like the
 * other.
 */
const inject = opt('inject');
if (inject) {
  const f = inject.split(',').map(x => x.trim().padStart(2, '0')).join('');
  const line = `p${f}\n`;
  pipeWriter(pipeSab).write(new TextEncoder().encode(line));
  console.log(`injected ${JSON.stringify(line)} into the pipe`);
}

const t0 = performance.now();
try {
  prog.run(['doom', ...(opt('args') ?? '').split(/\s+/).filter(Boolean)]);
} catch (e) {
  if (e.message !== '__frames_done') console.log(`doom threw: ${e.message}`);
}
drain();
const secs = (performance.now() - t0) / 1000;

const rate = Atomics.load(views.ctrl, SLOT.AUDIO_RATE);
const ch = Atomics.load(views.ctrl, SLOT.AUDIO_CHANNELS) || 2;
let peak = 0, energy = 0;
for (const v of wav) { const a = Math.abs(v); if (a > peak) peak = a; energy += v * v; }
console.log(`\n${frames} frames in ${secs.toFixed(1)} s`);
console.log(`popen: ${pop.open.length} open — ${pop.open.map(o => `"${o.cmd.trim()}" ${o.bytes}B`).join(', ') || 'none'}`);
const rd = pipeReader(pipeSab);
console.log(`pipe: ${Atomics.load(new Int32Array(pipeSab, 0, 2), 0)} bytes written by Doom, ` +
  `${rd.pending} still unread`);
console.log(`audio: ${(wav.length / ch)} frames at ${rate} Hz x${ch} · peak ${peak} · ` +
  `rms ${(wav.length ? Math.sqrt(energy / wav.length) : 0).toFixed(0)}`);

const wavPath = opt('wav');
if (wavPath && wav.length) {
  const n = wav.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(rate || 11025, 24);
  buf.writeUInt32LE((rate || 11025) * 2 * ch, 28); buf.writeUInt16LE(2 * ch, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(wav[i], 44 + i * 2);
  writeFileSync(wavPath, buf);
  console.log(`wrote ${wavPath}`);
}
// Let the worker's queued messages land before leaving: this thread ran Doom synchronously, so
// nothing it posted has been delivered yet.
setTimeout(() => process.exit(0), 200);
