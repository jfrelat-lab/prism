// sndserv-worker.mjs — Doom's sound server, as a second process.
//
// A worker thread rather than an interleaved coroutine, because neither program's `main` ever
// returns: Doom spins in D_DoomLoop and the server spins in `while (!done)`. Interleaving them would
// mean calling their internals instead of running them, which is the one thing PRISM does not do.
// Two threads and a shared pipe cost nothing conceptually and the programs stay whole.
//
// Everything this thread needs arrives as SharedArrayBuffers: the pipe carrying Doom's commands, and
// the audio ring the mixed result goes into. Nothing is posted back — the other side reads memory,
// exactly as the browser page does.

import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { compileProgram } from '../src/compile.js';
import { installStdio } from '../src/env/stdio.js';
import { installDsp } from '../src/env/dsp.js';
import { pipeReader } from '../src/env/pipe.js';
import { controlViews } from '../src/env/webhost.js';
import { HEADERS } from '../src/env/headers.js';

const { src, pipeSab, controlSab, files } = workerData;
const say = (line) => parentPort.postMessage({ type: 'log', line });

const resolve = (name) => {
  const p = join(src, basename(name));
  if (existsSync(p) && statSync(p).isFile()) return { path: p, text: readFileSync(p, 'latin1') };
  const std = HEADERS[name] ?? HEADERS[basename(name)];
  return std === undefined ? { path: `<missing:${name}>`, text: '' } : { path: `<${name}>`, text: std };
};

const units = ['soundsrv.c', 'linux.c', 'wadread.c', 'sounds.c']
  .filter(f => existsSync(join(src, f)))
  .map(f => ({ file: join(src, f), source: readFileSync(join(src, f), 'latin1') }));

const prog = compileProgram(units, { resolve, memory: 64 * 1024 * 1024, collect: true });
say(`compiled ${Object.keys(prog.F).length} functions`);

/*
 * The pipe IS stdin. The server reads it two ways -- a zero-timeout `select` to ask whether anything
 * is there, then `read(0, …)` to take it -- so both are answered from the same reader.
 */
const rd = pipeReader(pipeSab);
const data = {};
for (const [name, bytes] of Object.entries(files)) data[name] = new Uint8Array(bytes);
installStdio(prog.M, {
  files: data,
  readChar: () => { const b = rd.read(1); return b.length ? b[0] : -1; },
  stdinPending: () => rd.pending > 0,
});

const views = controlViews(controlSab);
// blockWhenFull: the consumer is this server's only clock. See src/env/dsp.js.
const dsp = installDsp(prog.M, { publish: { ctrl: views.ctrl, audio: views.audio }, blockWhenFull: true });
/*
 * Report from inside the write path, not from a timer: this thread never returns to its event loop
 * once the guest starts, which is the whole reason the guest needed a thread of its own.
 */
dsp.wav = [];
{
  const inner = prog.M.rt.write;
  let n = 0;
  prog.M.rt.write = (fd, src, len) => {
    const r = inner(fd, src, len);
    if (++n % 200 === 0) {
      let peak = 0;
      for (const v of dsp.wav) { const a = Math.abs(v); if (a > peak) peak = a; }
      say(`submit ${n}: ${dsp.wav.length} samples mixed, peak ${peak}, ${dsp.dropped} dropped by the ring`);
      dsp.wav.length = 0;
    }
    return r;
  };
}
prog.M.write = (s) => say(s.replace(/\n$/, ''));

say('running');
try {
  prog.run(['sndserver', ...(workerData.quiet === false ? [] : ['-quiet'])]);
  say('the sound server returned');
} catch (e) {
  say(`the sound server threw: ${e.message}`);
}
