// live/worker.js — compile and run ONE program that was typed into the page.
//
// The shell's worker (web/worker.js) fetches a corpus, resolves a target, installs a platform layer
// and hands the guest a framebuffer. None of that applies here: there is no program on disk, no
// machine, and nothing to draw. What is left is the compiler and libc, which is the whole claim
// being demonstrated — so this file is deliberately the SMALL one, and its smallness is the point.
//
// Two things it does share with the shell, because they are the same problems:
//
//   * the control block, for stop and for stdin. `prog.run()` never returns, so the worker's event
//     loop is gone from the moment the program starts: a keystroke posted as a message would be
//     delivered to nobody. It arrives through shared memory instead, exactly as it does for a game.
//   * postMessage for OUTPUT, which works in the other direction while the thread is blocked —
//     sending does not need this worker's loop, only the page's.

import { compileProgram } from '../../src/compile.js';
import { installStdio } from '../../src/env/stdio.js';
import { controlViews, makeKeyboard, SLOT, STATE } from '../../src/env/webhost.js';

const post = (type, data = {}) => self.postMessage({ type, ...data });

self.onmessage = async (e) => {
  if (e.data.type !== 'start') return;
  try {
    await run(e.data);
  } catch (err) {
    post('diag', { message: String(err && err.message || err) });
    post('done', { code: -1 });
  }
};

async function run({ files, argv, control, stdinText, language }) {
  const views = controlViews(control);
  const { ctrl } = views;
  const keyboard = makeKeyboard(views);
  Atomics.store(ctrl, SLOT.STATE, STATE.COMPILING);

  /*
   * WHICH FILES ARE UNITS. A .c is compiled; a .h is only ever reached through an #include, and
   * compiling it as a unit would define its contents twice. The distinction is the file name, which
   * is exactly how a makefile makes it.
   */
  const UNIT = /\.(c|cpp|cc|cxx)$/i;
  const units = files.filter(f => UNIT.test(f.name))
    .map(f => ({ file: f.name, source: f.source }));
  if (!units.length) throw new Error('nothing to compile: no .c or .cpp file');
  /*
   * TWO DEFINITIONS OF main IS NOT A BIGGER PROGRAM. A real linker refuses it; PRISM's placement
   * pass simply lets the last one win, which means one of the two files you can see silently does
   * not run. Said out loud here rather than left as a mystery about which file is live.
   */
  const mains = units.filter(u => /^[^#\n]*\bmain\s*\(/m.test(u.source)).map(u => u.file);
  if (mains.length > 1) {
    throw new Error(`${mains.length} files define main (${mains.join(', ')}) — a program has one. ` +
      `Remove one, or rename it to something the other calls.`);
  }

  // The headers the person wrote, for #include "…". The standard ones come from PRISM's own set,
  // which compileProgram installs when no resolver is given.
  const includes = Object.fromEntries(files.filter(f => !UNIT.test(f.name))
    .map(f => [f.name, f.source]));

  const t0 = performance.now();
  const prog = compileProgram(units, {
    includes,
    memory: 64 * 1024 * 1024,
    collect: true,               // report every gap in one build rather than dying on the first
    // The language choice of the page: by file name (absent), or every unit as C or as C++.
    cxx: language === 'c' || language === 'c++' ? { language: { '*': language } } : undefined,
  });
  const ms = performance.now() - t0;

  post('built', {
    ms,
    units: units.length,
    lines: units.reduce((n, u) => n + u.source.split('\n').length, 0),
    functions: Object.keys(prog.F).length,
    bytes: prog.src.length,
    /*
     * The functions that could NOT be emitted, named. They do not stop the build -- each throws if
     * it is called -- and hiding them would turn "PRISM cannot do this yet" into a mysterious
     * exception halfway through someone's program.
     */
    failures: prog.failures.map(f => f.message),
  });
  // The emitted JavaScript, for the pane that shows it. It is what the compiler produced, not a
  // rendering of it -- so it is also the thing to paste into a bug report.
  post('emitted', { source: prog.src });

  /*
   * stdin, from the page's own field through the same shared queue a game's keyboard uses. Enter
   * arrives as 13 because that is what a PC's BIOS buffer holds; a C program reading a line wants
   * 10, and `fgets` looks for nothing else.
   */
  installStdio(prog.M, {
    readChar: () => {
      const c = keyboard.read();
      return c === 13 ? 10 : c;
    },
    stdinPending: () => keyboard.pending() > 0,
  });
  if (stdinText) for (const ch of stdinText) keyboard.push(0, ch.charCodeAt(0) & 0xff);

  /*
   * WHAT THE PROGRAM PRINTS, as it prints it. `prog.run` never returns, so this cannot be collected
   * at the end: a program that prints a line and then loops for ever would show nothing at all, and
   * the loop is exactly when you want to see the line.
   */
  const write = prog.M.write;
  prog.M.write = (text) => { post('out', { text: String(text) }); return write(text); };

  Atomics.store(ctrl, SLOT.STATE, STATE.RUNNING);
  const t1 = performance.now();
  let code = 0;
  try {
    code = prog.run(argv && argv.length ? argv : ['prog']).code;
  } catch (err) {
    post('threw', { message: String(err && err.message || err) });
    Atomics.store(ctrl, SLOT.STATE, STATE.ERROR);
    post('done', { code: -1, ms: performance.now() - t1 });
    return;
  }
  Atomics.store(ctrl, SLOT.STATE, STATE.EXITED);
  post('done', { code, ms: performance.now() - t1 });
}
