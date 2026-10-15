// sndworker.js — Doom's sound server, as a second process, in the browser.
//
// The Node counterpart is tools/sndserv-worker.mjs and this is deliberately the same shape: a worker
// thread rather than an interleaved coroutine, because neither program's `main` ever returns. Doom
// spins in D_DoomLoop and the server spins in `while (!done)`; interleaving them would mean calling
// their internals instead of running them, which is the one thing PRISM does not do.
//
// The only real difference from the Node version is where the source comes from. That one reads it
// off the disk; this one fetches it, because a browser has no disk -- so the compile is async at the
// edges and synchronous in the middle, exactly as in web/worker.js.
//
// Everything else is shared memory: the pipe carrying Doom's commands, and the control block whose
// audio ring the page is already reading. Nothing is posted back except log lines.

import { at } from './endpoints.js';
import { compileProgram } from '../src/compile.js';
import { installStdio } from '../src/env/stdio.js';
import { installDsp } from '../src/env/dsp.js';
import { pipeReader } from '../src/env/pipe.js';
import { controlViews } from '../src/env/webhost.js';
import { HEADERS } from '../src/env/headers.js';

const say = (line, kind = 'info') => self.postMessage({ type: 'log', line, kind });

self.onmessage = async (e) => {
  if (e.data.type !== 'start') return;
  try {
    await start(e.data);
  } catch (err) {
    say(String(err && err.stack || err), 'error');
  }
};

async function start({ dir, pipeSab, control, files }) {
  /*
   * The four units, named rather than globbed. sndserv/ also holds `sounds.h` and a Makefile, and on
   * some checkouts a `linux.c` that is the only one of the four that is optional -- so a listing is
   * filtered by what the build actually contains, the same list tools/sndserv-worker.mjs uses.
   */
  const WANT = ['soundsrv.c', 'linux.c', 'wadread.c', 'sounds.c'];
  /*
   * The listing comes from serve.mjs. A static export has no /__ls, and ships sndserv/'s sources at
   * their paths: then the names are the units above and the headers they include.
   */
  const listing = await fetch(at(`__ls?dir=${encodeURIComponent(dir)}`)).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    ?? { files: [...WANT, 'sounds.h', 'soundsrv.h', 'soundst.h', 'wadread.h'] };
  const present = new Set(listing.files.map(f => f.toLowerCase()));

  const tree = new Map();
  await Promise.all(listing.files
    .filter(f => /\.(c|h)$/i.test(f))
    .map(async (f) => {
      const r = await fetch(at(`${dir}/${f}`));
      if (r.ok) tree.set(f.toLowerCase(), await r.text());
    }));

  const missing = new Set();
  const resolve = (name) => {
    const base = name.replace(/^.*\//, '').toLowerCase();
    if (tree.has(base)) return { path: base, text: tree.get(base) };
    const std = HEADERS[name] ?? HEADERS[name.replace(/^.*\//, '')];
    if (std !== undefined) return { path: `<${name}>`, text: std };
    missing.add(name);
    return { path: `<missing:${name}>`, text: '' };
  };

  const units = WANT.filter(f => present.has(f))
    .map(f => ({ file: f, source: tree.get(f) }));
  if (!units.length) throw new Error(`no sound server sources under ${dir}`);

  const prog = compileProgram(units, { resolve, memory: 64 * 1024 * 1024, collect: true });
  say(`sound server: ${units.length} units, ${Object.keys(prog.F).length} functions` +
    (missing.size ? ` · headers stubbed: ${[...missing].join(' ')}` : ''));

  /*
   * The pipe IS stdin. The server reads it two ways -- a zero-timeout `select` to ask whether
   * anything is waiting, then `read(0, …)` to take it -- so both are answered from one reader.
   */
  const rd = pipeReader(pipeSab);
  const data = {};
  for (const [name, bytes] of Object.entries(files)) data[name] = new Uint8Array(bytes);
  installStdio(prog.M, {
    files: data,
    readChar: () => { const b = rd.read(1); return b.length ? b[0] : -1; },
    stdinPending: () => rd.pending > 0,
  });

  const views = controlViews(control);
  /*
   * blockWhenFull: the page's audio consumer is this server's only clock. A sound server has no
   * timer of its own -- `write` to a real /dev/dsp blocks until the card has room, and that is what
   * paces it. Free-running, it produced four hundred submits and lost most of the samples.
   */
  installDsp(prog.M, { publish: { ctrl: views.ctrl, audio: views.audio }, blockWhenFull: true });

  /*
   * Its stdout, a LINE at a time. `M.write` is called per character, so posting each one produced a
   * message per letter -- thirty-three of them to spell one sentence.
   */
  let pending = '';
  prog.M.write = (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trimEnd();
      pending = pending.slice(nl + 1);
      if (line) say(line);
    }
  };

  say('sound server running');
  try {
    prog.run(['sndserver', '-quiet']);
    say('the sound server returned');
  } catch (err) {
    say(`sound server stopped: ${err.message}`, 'error');
  }
}
