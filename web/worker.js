// worker.js — the guest's thread.
//
// Everything here blocks: fetching the sources blocks, compiling blocks, and then the program's own
// main loop blocks until it decides to exit. That is the point. The page stays responsive because
// this is a worker, and it stays informative because the guest's memory is shared — the page reads
// pixels out of it while this thread is deep inside the program's inner loop.
//
// The only messages sent back are things the page cannot read for itself: log lines, and the one-off
// handoff of the shared image.

import { compileProgram } from '../src/compile.js';
import { installOSD } from '../src/env/osd.js';
import { installConsole } from '../src/env/console.js';
import { HEADERS } from '../src/env/headers.js';
import { controlViews, makeKeyReader, makePacer, makeKeyboard, SLOT, STATE } from '../src/env/webhost.js';

const post = (type, data) => self.postMessage({ type, ...data });
const log = (line, kind = 'info') => post('log', { line, kind });

self.onmessage = async (e) => {
  if (e.data.type !== 'start') return;
  try {
    await start(e.data);
  } catch (err) {
    log(String(err && err.stack || err), 'error');
    post('failed', { message: String(err && err.message || err) });
  }
};

async function start({ program, control, data, argv }) {
  const views = controlViews(control);
  const { ctrl, pal } = views;
  const reader = makeKeyReader(views);
  // The program's own frame rate, from its descriptor. MAME's drivers carry frames_per_second and
  // Pac-Man's is 60; a program that never presents a frame never waits.
  const pace = makePacer(ctrl, program.fps || 60);
  const keyboard = makeKeyboard(views);
  const setState = (s) => Atomics.store(ctrl, SLOT.STATE, s);

  // --- 1. the sources.
  //
  // The compiler resolves #include synchronously, so every header must be in hand before compiling
  // starts. The whole tree is fetched up front rather than on demand: it is a few hundred kilobytes
  // of C, and the alternative — an async resolver — would mean an async parser.
  setState(STATE.FETCHING);
  const t0 = performance.now();
  const listing = await (await fetch(`/__ls?dir=${encodeURIComponent(program.root)}`)).json();
  const wanted = listing.files.filter(f => /\.(c|h)$/i.test(f));
  const tree = new Map();
  await Promise.all(wanted.map(async (f) => {
    const r = await fetch(`/${program.root}/${f}`);
    if (r.ok) tree.set(f.toLowerCase(), await r.text());
  }));
  log(`fetched ${tree.size} source files (${(performance.now() - t0).toFixed(0)} ms)`);

  /** The include search, over the fetched tree: the program's own -I list, then PRISM's headers. */
  const dirOf = (p) => p.includes('/') ? p.replace(/\/[^/]*$/, '') : '';
  const missing = new Set();
  function resolve(name, angled, fromFile) {
    const tryPath = (p) => {
      const key = p.replace(/^\.\//, '').replace(/[^/]+\/\.\.\//g, '').toLowerCase();
      return tree.has(key) ? { path: key, text: tree.get(key) } : null;
    };
    if (!angled && fromFile) {
      const hit = tryPath(dirOf(fromFile) ? `${dirOf(fromFile)}/${name}` : name);
      if (hit) return hit;
    }
    for (const d of program.includeDirs || []) {
      const hit = tryPath(`${d}/${name}`);
      if (hit) return hit;
    }
    const std = HEADERS[name] ?? HEADERS[name.replace(/^.*\//, '')];
    if (std !== undefined) return { path: `<${name}>`, text: std };
    // Stub and record, so one build reports every absent header rather than dying on the first.
    // Printed, never silent.
    missing.add(name);
    return { path: `<missing:${name}>`, text: '' };
  }

  // --- 2. compile.
  setState(STATE.COMPILING);
  const units = [];
  for (const u of program.units) {
    const text = tree.get(u.toLowerCase());
    if (text === undefined) throw new Error(`missing translation unit ${u}`);
    units.push({ file: u, source: text });
  }
  for (const [name, source] of Object.entries(program.extraUnits || {})) {
    units.push({ file: name, source });
  }
  const loc = units.reduce((n, u) => n + u.source.split('\n').length, 0);
  log(`compiling ${units.length} translation units, ${loc.toLocaleString('en')} lines`);

  const t1 = performance.now();
  const prog = compileProgram(units, {
    defines: program.defines || {},
    resolve,
    memory: program.memory,
    shared: true,                    // the page reads pixels straight out of this image
    collect: true,                   // report every gap in one build, not the first one
  });
  const compileMs = performance.now() - t1;
  if (missing.size) log(`headers stubbed (empty): ${[...missing].join(' ')}`, 'warn');
  if (prog.failures.length) {
    const causes = new Map();
    for (const f of prog.failures) {
      const k = f.message.slice(0, 90);
      causes.set(k, (causes.get(k) || 0) + 1);
    }
    log(`${prog.failures.length} functions could not be emitted; they throw if called:`, 'warn');
    for (const [k, n] of [...causes].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      log(`  ${n}x ${k}`, 'warn');
    }
  }
  log(`compiled in ${compileMs.toFixed(0)} ms: ${Object.keys(prog.F).length} functions, ` +
    `${(prog.src.length / 1024 / 1024).toFixed(2)} MB of JavaScript`);

  // --- 3. the platform layer.
  const files = {};
  for (const [name, bytes] of Object.entries(data || {})) files[name] = new Uint8Array(bytes);
  log(`${Object.keys(files).length} data files visible to the program`);
  log(`argv: ${(argv || []).join(' ')}`);

  installOSD(prog.M, {
    files,
    publish: { ctrl, pal },
    /*
     * A held key is a byte in shared memory, so this read is what the guest sees at the instant it
     * asks — no event queue, no latency beyond one frame of pacing.
     *
     * STOP is answered as Esc because that is how the program's OWN quit path works. Killing the
     * worker instead would skip whatever the program does on the way out.
     */
    keys: (k) => (Atomics.load(ctrl, SLOT.STOP) && k === 1 ? 1 : reader.read(k)),
    // The frame boundary: retire the key latches, then hold the guest until its frame is due.
    onPresent: () => { reader.endFrame(); pace(); },
  });

  /*
   * The console writes into the guest's own text video RAM, and the page renders that. No output is
   * posted to the page at all any more: a program that prints and a program that pokes 0xB8000 must
   * end up in the same place, and they do because that place is guest memory.
   *
   * stdin now blocks. MAME prints "Press <ENTER> to continue." and calls getchar(); until this
   * existed, getchar returned EOF and the program asked a question it then ignored.
   */
  installConsole(prog.M, { readChar: () => keyboard.read() });

  post('ready', { image: prog.mod.buffer });

  // --- 4. run. This call returns when the program's main() does.
  setState(STATE.RUNNING);
  Atomics.notify(ctrl, SLOT.STATE);
  const t2 = performance.now();
  let code = 0;
  try {
    const r = prog.run(argv && argv.length ? argv : ['prog']);
    code = r.code;
  } catch (err) {
    log(`the program threw: ${String(err && err.message || err)}`, 'error');
    Atomics.store(ctrl, SLOT.EXITCODE, -1);
    setState(STATE.ERROR);
    return;
  }
  const runS = (performance.now() - t2) / 1000;
  const frames = Atomics.load(ctrl, SLOT.FRAME);
  log(`exit ${code} after ${runS.toFixed(1)} s and ${frames} frames ` +
    `(${(frames / runS).toFixed(1)} fps)`);
  Atomics.store(ctrl, SLOT.EXITCODE, code);
  setState(STATE.EXITED);
}
