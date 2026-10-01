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
import { toolchainCompile } from '../src/toolchain.js';
import { installRealClock, installSpinDamping } from '../src/runtime/runtime.js';
/*
 * The registry and the assembler, both pure JS. The planar branch below builds its devices from the
 * TARGET'S OWN env list through buildEnv rather than naming them one by one, which is the same rule
 * the DOS branch's comment states and did not follow.
 */
import { buildEnv, envHeaders, envBuiltins } from '../src/env/registry.js';
import { installAsm } from '../src/asm/link.js';
import { tasmModules, tasmExternData, installTasm, dataObjectBlocks } from '../src/asm/tasm-link.js';
import { installAllegro } from '../src/env/allegro.js';
import { installStdio } from '../src/env/stdio.js';
import { installPorts } from '../src/env/ports.js';
import { installQuake } from '../src/env/quake.js';
import { installX11 } from '../src/env/x11.js';
import { installGL } from '../src/env/gl.js';
import { installGlx } from '../src/env/glx.js';
import { installDsp } from '../src/env/dsp.js';
import { installPopen } from '../src/env/popen.js';
import { installConsole } from '../src/env/console.js';
import { VRAM_TEXT, TEXT_COLS, TEXT_ROWS } from '../src/link/module.js';
import { installPorts as installPortMachine } from '../src/env/ports.js';
import { installCrtStatus } from '../src/env/crtstatus.js';
import { installVgaDac } from '../src/env/vgadac.js';
import { installKbd8042 } from '../src/env/kbd8042.js';
import { installPIT } from '../src/env/pit.js';
import { installGo32 } from '../src/env/go32.js';
import { installSvgalib } from '../src/env/svgalib.js';
import { installWatcom } from '../src/env/watcom.js';
import { installVgaFont } from '../src/env/vgafont.js';
import { installWsock } from '../src/env/wsock.js';
import { installDl } from '../src/env/dl.js';
import { HEADERS } from '../src/env/headers.js';
import { controlViews, makeKeyReader, makePacer, makeKeyboard, makeMouse, makeParker, SLOT, STATE }
  from '../src/env/webhost.js';
import { sleepingClock } from '../src/env/clock.js';

const post = (type, data) => self.postMessage({ type, ...data });
const log = (line, kind = 'info') => post('log', { line, kind });

/** How many lines of the PROGRAM's own output reach the page log before only its screen has them. */
const GUEST_LOG_LINES = 400;

/** `a/b/../c` -> `a/c`. An include dir may point out of the tree and back into a sibling. */
const normaliseRepoPath = (p) => {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
};

self.onmessage = async (e) => {
  if (e.data.type !== 'start') return;
  try {
    await start(e.data);
  } catch (err) {
    log(String(err && err.stack || err), 'error');
    post('failed', { message: String(err && err.message || err) });
  }
};

async function start({ program, control, data, argv, pipeSab = null, screen = null, options = {} }) {
  /*
   * A descriptor may carry the BUILD or merely name a target that does.
   *
   * targets/*.json is the one description Node already builds from; the server resolves it -- unit
   * rules, per-unit defines, generated units -- and hands back the answer, so the page does not grow
   * a second copy of rules that would drift from the first. A descriptor with no `target` is the
   * older kind and keeps working unchanged.
   */
  if (program.target) {
    const r = await fetch(`/__target?name=${encodeURIComponent(program.target)}`);
    if (!r.ok) throw new Error(`no target '${program.target}': ${(await r.json()).error ?? r.status}`);
    const t = await r.json();
    program = {
      ...program,
      root: t.dir,
      /*
       * A unit under the target's own directory is named RELATIVE to it, because that is the tree
       * this worker fetches. One outside it -- a `generated` file such as src/env/win32.c, which is
       * PRISM's and not the game's -- keeps its repo-relative path and is fetched on its own.
       *
       * Slicing the directory prefix off every unit is what broke this: an absolute-in-the-repo path
       * that does not start with the target's directory came out as the EMPTY STRING, and the build
       * failed with "missing translation unit " and nothing after it.
       */
      units: t.units.filter(u => u.source === undefined)
        .map(u => (u.file.startsWith(`${t.dir}/`) ? u.file.slice(t.dir.length + 1) : u.file)),
      /*
       * WHICH MODULE each unit belongs to. A program of this era is often several shared objects
       * that do not see each other's globals -- Quake II is an engine, a renderer and a game
       * library -- and the tag is what keeps their namespaces apart. The server has always sent it;
       * this side dropped it, so the renderer compiled into the engine's namespace, `dlsym` found
       * nothing, and the first call through the returned pointer was a call through zero.
       */
      unitModules: Object.fromEntries(t.units.filter(u => u.source === undefined && u.module)
        .map(u => [(u.file.startsWith(`${t.dir}/`) ? u.file.slice(t.dir.length + 1) : u.file)
          .toLowerCase(), u.module])),
      moduleExports: t.moduleExports ?? {},
      /* soname -> module, for dlopen: sys_linux.c asks for the string its own makefile built. */
      sonames: Object.fromEntries(Object.entries(t.modules ?? {})
        .filter(([, m]) => m.soname).map(([k, m]) => [m.soname, k])),
      outsideRoot: t.units.filter(u => u.source === undefined)
        .map(u => u.file).filter(f => !f.startsWith(`${t.dir}/`)),
      unitDefines: Object.fromEntries(t.units.filter(u => u.defines)
        .map(u => [(u.file.startsWith(`${t.dir}/`) ? u.file.slice(t.dir.length + 1) : u.file)
          .toLowerCase(), u.defines])),
      extraUnits: Object.fromEntries(t.units.filter(u => u.source !== undefined)
        .map(u => [u.file, u.source])),
      /*
       * The include list stays as REPO paths, and the fetch below keys every file both ways. Slicing
       * the target's directory off each one is the same mistake the units comment above describes,
       * and it cost two things here: `corpus/putty/../putty-generated` -- an include dir that leaves
       * the tree -- came out as `../putty-generated` and matched nothing, and the target's OWN root
       * was never in the search at all, so PuTTY's `#include "defs.h"` from windows/platform.h found
       * nothing and was stubbed empty. The parse then failed 488 lines later on a type that header
       * defines, which is a long way from the cause.
       */
      includeDirs: [t.dir, ...t.include.map(normaliseRepoPath)],
      defines: t.defines,
      memory: (t.compile.memory ?? 64) * 1024 * 1024,
      pack: t.compile.pack ?? null,
      caseInsensitive: t.caseInsensitive,
      title: program.title ?? t.title,
      // The resolved variant's host wins: the descriptor names a GAME, the variant a PLATFORM.
      host: t.host ?? program.host,
      // ...and which devices it asked for, so the branch below installs what the build wants
      // rather than what its host usually implies.
      env: t.env ?? [],
      /* Files the INSTALLATION provides -- see targets/*.json's `files`. */
      installFiles: t.files ?? {},
      /*
       * The program's OWN assembly, as repo paths to fetch and translate here. src/asm/ imports
       * nothing from Node, so the browser runs the same parser and translator the Node build does
       * and the .S file is the artefact -- there is nothing pre-built to keep in step.
       */
      asmTranslate: t.asmTranslate ?? [],
      /*
       * The compiler options Node's build passes (src/target.js) and this side used to drop: the
       * ABI model, C89, the sign of char, the size of enums, a stated sizeof for #if, the device
       * window. An i386 target states none of them and compiles as before; a 16-bit one cannot be
       * built without them.
       */
      compile: t.compile ?? {},
      // Turbo Assembler modules and the object files the project links -- see src/asm/tasm-link.js.
      tasm: t.tasm ?? [],
      tasmFiles: t.tasmFiles ?? [],
      dataObjects: t.dataObjects ?? [],
    };
  }

  const views = controlViews(control);
  const { ctrl, pal, audio } = views;
  const reader = makeKeyReader(views);
  // The program's own frame rate, from its descriptor. MAME's drivers carry frames_per_second and
  // Pac-Man's is 60; a program that never presents a frame never waits.
  const pace = makePacer(ctrl, program.fps || 60);
  const keyboard = makeKeyboard(views);
  const mouse = makeMouse(views);
  const park = makeParker(ctrl);
  const setState = (s) => Atomics.store(ctrl, SLOT.STATE, s);

  // --- 1. the sources.
  //
  // The compiler resolves #include synchronously, so every header must be in hand before compiling
  // starts. The whole tree is fetched up front rather than on demand: it is a few hundred kilobytes
  // of C, and the alternative — an async resolver — would mean an async parser.
  setState(STATE.FETCHING);
  const t0 = performance.now();
  const listing = await (await fetch(`/__ls?dir=${encodeURIComponent(program.root)}`)).json();
  // Not just .c and .h. Quake's progdefs.h includes "progdefs.q1", generated by the QuakeC compiler,
  // and a resolver that never fetched it stubbed it silently — which surfaced 20 lines later as
  // "progs.h:46: expected ';' but found 'v'", the typedef it defines having vanished. Node reads
  // whatever the include names off the disk, so the failure existed only in the browser.
  /*
   * `.xpm` is in this list because an XPM file IS C -- a `char *name[] = { ... }` an X11 program
   * #includes to embed an image. sdl/gfx.c does exactly that for its window icon, and leaving the
   * extension out cost a whole function: the include resolved to an empty stub, `jumpnbump64_xpm`
   * was never declared, and open_screen could not be emitted. Node reads the tree off disk and so
   * never met this filter at all -- which is how the two hosts disagreed about the same program.
   */
  const SOURCE_EXT = /\.(c|h|q1|q2|inc|def|xpm)$/i;
  const wanted = listing.files.filter(f => SOURCE_EXT.test(f));
  const tree = new Map();
  /* Both keys: units are named relative to the root, includes are searched by repo path. */
  const put = (relKey, text) => {
    tree.set(relKey.toLowerCase(), text);
    tree.set(`${program.root}/${relKey}`.toLowerCase(), text);
  };
  await Promise.all(wanted.map(async (f) => {
    const r = await fetch(`/${program.root}/${f}`);
    if (r.ok) put(f, await r.text());
  }));
  /*
   * Include directories that are NOT under the target's root -- PuTTY's generated tree is a sibling
   * of the source tree -- are fetched the same way and keyed by their repo path.
   */
  for (const d of program.includeDirs ?? []) {
    if (d === program.root || d.startsWith(`${program.root}/`)) continue;
    const out = await (await fetch(`/__ls?dir=${encodeURIComponent(d)}`)).json().catch(() => ({ files: [] }));
    await Promise.all((out.files ?? []).filter(f => SOURCE_EXT.test(f)).map(async (f) => {
      const r = await fetch(`/${d}/${f}`);
      if (r.ok) tree.set(`${d}/${f}`.toLowerCase(), await r.text());
    }));
  }
  /* The units that live outside the target's tree, each fetched from the repository root. */
  for (const f of program.outsideRoot ?? []) {
    const r = await fetch(`/${f}`);
    if (r.ok) tree.set(f.toLowerCase(), await r.text());
  }
  /*
   * The assembly to translate, read as LATIN-1 rather than as text. `Response.text()` decodes UTF-8
   * and replaces any byte that is not valid UTF-8 with U+FFFD, which would silently corrupt a
   * comment or a string in a file written in 1998 -- the Node build reads these with 'latin1' for
   * the same reason.
   */
  const asmSources = [];
  for (const f of program.asmTranslate ?? []) {
    const r = await fetch(`/${f}`);
    if (!r.ok) throw new Error(`missing assembly ${f}: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    asmSources.push({ file: f, text });
  }
  /*
   * Turbo Assembler sources, read as LATIN-1 for the reason given above, keyed by their file name
   * because a module INCLUDEs by name. And the data objects: from the player's own data when it
   * brings a file of that name -- a data set may carry the headers that match it, as Keen Dreams
   * 1.13 does (tools/keen-static.mjs) -- else from the source tree.
   */
  const latin1 = (bytes) => { let t = ''; for (let i = 0; i < bytes.length; i++) t += String.fromCharCode(bytes[i]); return t; };
  const tasmText = new Map();
  await Promise.all((program.tasmFiles ?? []).map(async (f) => {
    const r = await fetch(`/${f}`);
    if (r.ok) tasmText.set(f.replace(/^.*\//, '').toLowerCase(), latin1(new Uint8Array(await r.arrayBuffer())));
  }));
  const dataBytes = new Map();
  await Promise.all((program.dataObjects ?? []).map(async (o) => {
    const name = o.object ?? o.file;
    const own = Object.entries(data || {}).find(([k]) => k.toLowerCase() === name.toLowerCase());
    if (own) { dataBytes.set(name, new Uint8Array(own[1])); return; }
    if (!o.path) throw new Error(`data object ${name} is in neither the source tree nor the data`);
    const r = await fetch(`/${o.path}`);
    if (!r.ok) throw new Error(`missing data object ${o.path}: ${r.status}`);
    dataBytes.set(name, new Uint8Array(await r.arrayBuffer()));
  }));
  const tasmMods = tasmModules(program.tasm ?? [], (n) => tasmText.get(String(n).toLowerCase()) ?? null);
  const externData = [
    ...tasmExternData(tasmMods),
    ...dataObjectBlocks(program.dataObjects ?? [], (o) => dataBytes.get(o.object ?? o.file)),
  ];
  log(`fetched ${tree.size} source files` +
    (tasmMods.length ? `, ${tasmMods.length} TASM module(s) and ${dataBytes.size} data object(s)` : '') +
    (asmSources.length ? ` and ${asmSources.length} assembly file(s)` : '') +
    ` (${(performance.now() - t0).toFixed(0)} ms)`);

  /*
   * The platform's own data, not the program's: the 8x16 ROM font a Win32 build rasterises text
   * with. Fetched here because this worker has no filesystem, and passed to installVgaFont rather
   * than read by it.
   */
  let vgaFont = null;
  try {
    const r = await fetch('/assets/vga-rom-8x16.bin');
    if (r.ok) vgaFont = new Uint8Array(await r.arrayBuffer());
  } catch { /* a build that does not draw text will never ask for it */ }

  /** The include search, over the fetched tree: the program's own -I list, then PRISM's headers. */
  const dirOf = (p) => p.includes('/') ? p.replace(/\/[^/]*$/, '') : '';
  const missing = new Set();
  // Built here, before the resolver runs, so a target that names two versions of one library is
  // refused with the same message Node gives rather than quietly taking whichever was spread last.
  const envTable = envHeaders(program.env ?? []);
  /*
   * PRISM's OWN headers by lower-cased name, for a caseInsensitive target -- the rule src/target.js
   * makeResolver applies. Keen Dreams writes <STDIO.H> and <DOS.H>; DOS never distinguished the
   * spellings, and a target that says it is a DOS tree says so about its system headers too. Two
   * spellings that fold to one name are not chosen between: that include stays missing and is
   * reported. Without this the page stubbed eleven of Keen's headers empty and the build failed on
   * NULL, where Node's build of the same target is whole.
   */
  const foldTable = new Map();
  if (program.caseInsensitive) {
    for (const k of new Set([...Object.keys(envTable), ...Object.keys(HEADERS)])) {
      const low = k.toLowerCase();
      foldTable.set(low, [...(foldTable.get(low) ?? []), k]);
    }
  }
  const folded = (name) => {
    for (const n of [name, name.replace(/^.*\//, '')]) {
      const keys = foldTable.get(n.toLowerCase());
      if (keys?.length === 1) return envTable[keys[0]] ?? HEADERS[keys[0]];
    }
    return undefined;
  };
  function resolve(name, angled, fromFile) {
    const tryPath = (p) => {
      /*
       * `./x`, `a/./x` and `a/b/../x` are all names for one file, and the tree is keyed by the name
       * the server listed. The embedded `/./` was NOT collapsed here, only a leading one, so
       * `#include "./env.h"` from a unit in a subdirectory looked for `libbenly/src/./env.h`, found
       * nothing, and was stubbed empty -- the parse then died on a type that header declares.
       */
      const key = p.replace(/^\.\//, '').replace(/\/\.\//g, '/')
        .replace(/[^/]+\/\.\.\//g, '').toLowerCase();
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
    // The environments' headers in front of the standard table, as src/target.js does it -- so the
    // page and Node hand the same program the same declarations. Without this the browser would
    // still give every build SDL2's "SDL.h" whatever its env list says.
    const std = envTable[name] ?? envTable[name.replace(/^.*\//, '')]
      ?? HEADERS[name] ?? HEADERS[name.replace(/^.*\//, '')] ?? folded(name);
    if (std !== undefined) return { path: `<${name}>`, text: std };
    // A DOS path -- Keen Dreams' <SYS\STAT.H> -- is tried again with slashes, as Node's resolver does
    // (src/target.js makeResolver), and only after the name as written has missed.
    if (name.includes('\\')) return resolve(name.replace(/\\/g, '/'), angled, fromFile);
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
    const over = (program.unitDefines || {})[u.toLowerCase()];
    const mod = (program.unitModules || {})[u.toLowerCase()];
    units.push({ file: u, source: text, ...(over ? { defines: over } : {}), ...(mod ? { module: mod } : {}) });
  }
  for (const [name, source] of Object.entries(program.extraUnits || {})) {
    units.push({ file: name, source });
  }
  const loc = units.reduce((n, u) => n + u.source.split('\n').length, 0);
  log(`compiling ${units.length} translation units, ${loc.toLocaleString('en')} lines`);

  const t1 = performance.now();
  /*
   * Report the stubs BEFORE compiling, not after. They were only printed on success, so a build that
   * died because of a missing header showed the parse error and hid the cause.
   */
  const reportStubs = () => {
    if (missing.size) log(`headers stubbed (empty): ${[...missing].join(' ')}`, 'warn');
  };

  let prog;
  try {
    prog = compileProgram(units, {
      defines: program.defines || {},
      /* What each module makes visible to the main program, read from its own .def by the server. */
      exports: program.moduleExports || {},
      resolve,
      pack: program.pack ?? null,
      /*
       * A PAGED image, when the build wants one. Naming vgaplanar is what asks for it: a planar
       * window means an address no longer denotes one place, so the emitted code has to go through
       * the translation tables rather than straight at the heap. Same rule as src/target.js, read
       * from the same env list, so Node and the browser cannot disagree about it.
       */
      paged: program.compile?.paged ?? (program.env ?? []).includes('vgaplanar'),
    memory: program.memory,
      shared: true,                    // the page reads pixels straight out of this image
      /*
       * Safepoints, when the descriptor asks for them. They cost a decrement and a compare on every
       * iteration of every loop, so this is per-program and not a default -- see the descriptor's
       * safepointsNote for why MAME needs them and Doom does not.
       */
      safepoints: !!(program.safepoints || program.compile?.safepoints),
      c89: !!program.compile?.c89,
      model: program.compile?.model ?? 'i386',
      signedChar: program.compile?.signedChar,
      argOrder: program.compile?.argOrder ?? toolchainCompile(program.env).argOrder,
      enums: program.compile?.enums,
      ppSizeof: program.compile?.ppSizeof ?? null,
      window: program.compile?.window ?? (program.env ?? []).includes('ega'),
      externData,
      // The environments' builtin signatures, as src/target.js passes them -- so a program compiled
      // in the page links against the same library version it would in Node.
      extraBuiltins: envBuiltins(program.env ?? []),
      collect: true,                 // report every gap in one build, not the first one
    });
  } catch (err) {
    reportStubs();
    throw err;
  }
  const compileMs = performance.now() - t1;
  reportStubs();
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

  /*
   * SYMBOLS THE BUILD NEVER RESOLVED, said at the start rather than discovered by crashing.
   *
   * Node's build report has always printed these; the page did not, so the first sign of one was the
   * program throwing in the middle of something. Quake's DOS build is the case that matters:
   * VGA_UpdatePlanarScreen is defined only in d_copy.s, and it is the ONE routine in that build with
   * no C equivalent behind `id386=0`. Nothing calls it until somebody picks a mode-X resolution from
   * the video menu -- and then the game dies naming a function whose absence was knowable before it
   * started.
   */
  // A TASM module's public PROCs are bound after this, by the host (installTasm), so they are not
  // missing -- counting them made Keen Dreams report its own seventeen assembly routines as absent.
  const tasmPublics = new Set(tasmMods.flatMap(({ mod }) => [...mod.publics].map(p => (mod.model?.includes('c') ? p : p.replace(/^_/, '')))));
  const unresolved = (prog.undefined ?? []).filter(u => !tasmPublics.has(u.name));
  if (unresolved.length) {
    const names = unresolved.map(u => u.name.split('$').pop());
    log(`${names.length} symbol${names.length === 1 ? '' : 's'} the build never resolved; anything ` +
      `that calls one throws: ${names.slice(0, 12).join(' ')}` +
      (names.length > 12 ? ` … and ${names.length - 12} more` : ''), 'warn');
  }



  // --- 3. the platform layer.
  const files = {};
  /*
   * The installation's files first, the player's data over them: a real machine has both, and if the
   * two ever named the same path the one the person supplied is the one they meant.
   */
  const enc = new TextEncoder();
  for (const [name, text] of Object.entries(program.installFiles || {})) {
    files[name] = enc.encode(`${text}\n`);
  }
  for (const [name, bytes] of Object.entries(data || {})) files[name] = new Uint8Array(bytes);
  const biggest = Object.entries(files).sort((a, b) => b[1].length - a[1].length)[0];
  log(`${Object.keys(files).length} data files visible to the program` +
    (biggest ? ` (largest: ${biggest[0]}, ${biggest[1].length.toLocaleString('en')} bytes)` : ''));
  log(`argv: ${(argv || []).join(' ')}`);

  /*
   * The platform layer the descriptor names. They differ in KIND, not in detail: MAME's boundary is
   * eighteen callbacks, so its layer implements functions; Quake draws into a 320x200 array it
   * already owns, so its layer only publishes addresses and implements nothing.
   */
  /*
   * Which shell branch presents this build. It comes from the resolved TARGET VARIANT when there is
   * one -- Quake has four platform layers over one engine -- and from the descriptor otherwise.
   */
  const platform = program.host ?? program.platform ?? 'allegro';
  if (platform === 'x11') {
    /*
     * A UNIX host: the program is an X client, and Xlib is shimmed at the library boundary. Doom
     * draws into the XImage buffer it asked Xlib for, so the page reads that address directly —
     * the same "publish what the program already writes" move as Quake's vid_buffer.
     */
    installStdio(prog.M, { files, readChar: () => keyboard.read() });
    /*
     * dlopen, for a program that is several shared objects. Nothing is LOADED -- every module is
     * already linked into the same image -- so this answers dlopen/dlsym out of PRISM's own symbol
     * table, keyed by the soname the program's makefile built and its source asks for.
     */
    if ((program.env ?? []).includes('dl')) installDl(prog.M, { modules: program.sonames ?? {} });
    /*
     * A second PROGRAM, when the descriptor names one.
     *
     * Doom's own source delegates sound to a separate process -- `sndserver = popen("./sndserver ",
     * "w")` in i_sound.c -- so this is not an audio feature, it is a second address space and a pipe.
     * Both already exist: src/env/pipe.js is a byte pipe in a SharedArrayBuffer, and the audio ring
     * the server publishes into is the one the page has been reading for MAME all along.
     *
     * Nothing is interleaved and neither program knows the other is not a process.
     */
    /*
     * The sound server is a second PROGRAM, and the PAGE starts it -- see web/app.js.
     *
     * Not this worker, though this worker is where the pipe is used. The reason is the thing that
     * makes it a process at all: `prog.run` below never returns, so from that moment this thread's
     * event loop is gone, and a child created here would have been talking to a listener that would
     * never run again. Its compile succeeded, its server ran, and not one of its messages was ever
     * delivered. The page's loop stays free, so the page owns the child and this end owns the pipe.
     */
    if (pipeSab) installPopen(prog.M, { pipes: [{ match: /sndserver/, sab: pipeSab }] });
    /*
     * Sound, when the BUILD asks for it. Quake's X11 client mmaps /dev/dsp and mixes into the DMA
     * buffer (see src/env/dsp.js); Doom writes to it through a separate program. Reading the target's
     * own env list is what keeps this from being a guess about what an X11 program usually wants.
     */
    if ((program.env ?? []).includes('dsp')) {
      installDsp(prog.M, { publish: { ctrl, audio } });
    }
    installX11(prog.M, {
      publish: { ctrl, pal },
      keyboard: {
        pending: () => keyboard.pending(),
        next: () => keyboard.nextEvent(),
      },
      /* The same channel the DOS host reads through INT 33h, delivered here as X events instead. */
      mouse,
      onFrame: () => { reader.endFrame(); pace(); },
    });
  } else if (platform === 'glx') {
    /*
     * AN X CLIENT THAT DRAWS WITH GL: GLQuake's gl_vidlinuxglx.c. Everything an X11 host has -- the
     * files, dlopen for its extension probe, /dev/dsp, keys and the mouse as X events -- and the
     * picture from src/env/gl.js instead of an XImage: WebGL2 on an OffscreenCanvas when the worker
     * has one (?gl=soft for the software rasteriser gate-glquake holds to Mesa), read back at every
     * glXSwapBuffers into a guest buffer the page reads as it reads an SDL 2 texture. GL and GLX come
     * after X11 because GLX takes the window's size from the program's own XCreateWindow.
     */
    installStdio(prog.M, { files, readChar: () => keyboard.read() });
    if ((program.env ?? []).includes('dl')) installDl(prog.M, { modules: program.sonames ?? {} });
    if ((program.env ?? []).includes('dsp')) installDsp(prog.M, { publish: { ctrl, audio } });
    installX11(prog.M, {
      keyboard: { pending: () => keyboard.pending(), next: () => keyboard.nextEvent() },
      mouse,
    });
    const backend = options.gl === 'soft' || typeof OffscreenCanvas === 'undefined' ? 'soft' : 'webgl';
    installGL(prog.M, { backend });
    let out = 0, since = performance.now(), count = 0;
    installGlx(prog.M, {
      onSwap: (_n, gl) => {
        // The frame rate, said every five seconds: GLX has no other place a person could read it.
        count++;
        const now = performance.now();
        if (now - since >= 5000) { log(`${count} frames in ${((now - since) / 1000).toFixed(1)} s = ${(count * 1000 / (now - since)).toFixed(1)} fps (${gl.backend})`); since = now; count = 0; }
        const { width: w, height: h } = gl.state;
        if (!out) {
          out = prog.M.rt.malloc(w * h * 4);
          Atomics.store(ctrl, SLOT.WIDTH, w);
          Atomics.store(ctrl, SLOT.HEIGHT, h);
          Atomics.store(ctrl, SLOT.PIXELS, out);
          Atomics.store(ctrl, SLOT.PIXFMT, 32);
          Atomics.store(ctrl, SLOT.TEXTMODE, 0);
          log(`GLX display ${w}x${h}, ${gl.backend === 'webgl' ? 'WebGL2' : 'software rasteriser'}`);
        }
        const px = gl.readPixels(), u8 = prog.M.u8;
        for (let i = 0; i < w * h; i++) {
          u8[out + 4 * i] = px[4 * i + 2]; u8[out + 4 * i + 1] = px[4 * i + 1];
          u8[out + 4 * i + 2] = px[4 * i]; u8[out + 4 * i + 3] = 255;
        }
        reader.endFrame();
        pace();
      },
    });
  } else if (platform === 'quake') {
    installQuake(prog.M, {
      publish: { ctrl },
      F: prog.F,
      onFrame: () => { reader.endFrame(); pace(); },
    });
    // compile.js installed stdio with no files; re-install with the ones the page supplied.
    installStdio(prog.M, { files, readChar: () => keyboard.read() });
  } else if (platform === 'watcom') {
    /*
     * A WATCOM/DOS4GW host: Heretic, Hexen and OpenDUNE. One branch for three games, because what
     * they have in common is not a library but a MACHINE -- three devices and a clock.
     *
     * Nothing here implements a graphics API. Mode 13h is a linear framebuffer at 0xA0000, which
     * PRISM already has because the low megabyte is reserved, so the page is told an ADDRESS and the
     * program keeps writing where it always wrote. The palette arrives through the VGA DAC at
     * 0x3C8/0x3C9 because that is where the program sends it.
     */
    installStdio(prog.M, { files, readChar: () => keyboard.read() });
    const machine = installPortMachine(prog.M);
    installCrtStatus(machine);                       // the retrace bit these games spin on
    installVgaDac(machine, {
      // Published when a DAC entry completes, rather than polled: the program writes 256 triples in
      // a burst and the page should see the whole palette, not a torn one.
      onChange: (palette) => { pal.set(palette); Atomics.add(ctrl, SLOT.PALGEN, 1); },
    });
    prog.M.kbd = installKbd8042(machine);
    /*
     * A real clock for the PIT. installRealClock runs LATER in this file, so reading M.realClock
     * here read undefined -- the whole build died on `Cannot read properties of undefined (reading
     * 'micros')` after compiling 763 functions perfectly well. performance.now() is the same source
     * installRealClock draws from, so the timer does not wait for it.
     */
    installPIT(machine, prog.M, { micros: () => performance.now() * 1000 });
    const host = installWatcom(prog.M, {
      publish: { ctrl, pal },
      keys: (k) => reader.read(k),
      onPresent: () => { reader.endFrame(); pace(); },
    });

    /*
     * The safepoint, and the reason these games need one at all.
     *
     * Their time comes from an interrupt, and they wait for it inside a loop of their OWN C --
     * Heretic's TryRunTics spins on `ticcount`, which only the ISR writes, calling no service and
     * reading no port. A safepoint is the only place this runtime can reach into such a loop. Drive
     * nothing and the game waits for ever, which looks exactly like a hang; that cost an hour and a
     * bisection before I read tools/raven.mjs, which had reached the same conclusion first.
     *
     * The rate is counted in safepoint hits rather than in seconds because that is what is available
     * deterministically here, and it is what makes a run reproducible.
     */
    /*
     * The tic rate comes from the CLOCK, not from a count of safepoints.
     *
     * Counting safepoint hits is what tools/raven.mjs does, and it is right there: a headless run
     * wants determinism, not real time. In front of a person the opposite is true -- Heretic's world
     * advances one tic per interrupt, so N tics per second IS the speed of the game, and a rate tied
     * to how fast the host happens to run made it play far too fast.
     */
    const TIC_HZ = program.ticHz || 35;
    const BUDGET = program.safepointBudget || 20000;
    const usPerTic = 1e6 / TIC_HZ;
    let nextTic = 0;
    prog.M.spBudget = BUDGET;
    prog.M.sp_ = () => {
      prog.M.spBudget = BUDGET;
      if (Atomics.load(ctrl, SLOT.STOP)) throw new Error('__stopped');
      const now = performance.now() * 1000;
      if (now < nextTic) return;
      // Catch up at most a few tics: a page that was in a background tab must not then run the game
      // at a thousand tics a second to make up for it.
      if (nextTic === 0 || now - nextTic > 10 * usPerTic) nextTic = now;
      nextTic += usPerTic;
      host.deliverTimer();
      /*
       * A keypress arrives while the game is inside that same loop, so it is delivered from the same
       * place -- as a scan code through the 8042, which is where the program looks for one.
       *
       * The release bit is part of the SCAN CODE, not a separate argument: deliverKeyboard's second
       * parameter is the keyboard object, and passing `down` there made the game throw
       * "kbd.push is not a function" the moment a key was pressed.
       */
      for (let e = keyboard.nextEvent(); e; e = keyboard.nextEvent()) {
        if (e.scan) host.deliverKeyboard(e.down ? e.scan : (e.scan | 0x80));
      }
    };
  } else if (platform === 'mgl') {
    /*
     * A WIN32 host: WinQuake. src/env/win32.c and src/env/mgl.c are compiled INTO the program, so
     * this branch installs no library at all -- it publishes an address and posts keystrokes.
     *
     * Where the picture is comes from the program, as everywhere else here, but through four plain
     * integers rather than a symbol lookup: `surface` and `mi.bytesPerLine` live inside MGL's
     * publicDevCtx_t, and this side must not know that struct's layout. mgl.c writes them out on
     * every blit for exactly this reason.
     */
    installStdio(prog.M, { files, readChar: () => keyboard.read() });
    const sym = (n) => prog.mod.symbols.get(n)?.addr ?? 0;
    const at = {
      surface: sym('prism_mgl_surface'), width: sym('prism_mgl_width'),
      height: sym('prism_mgl_height'), pitch: sym('prism_mgl_pitch'),
      palette: sym('prism_mgl_palette'),
    };
    const key = prog.F.prism_win32_key;
    if (!at.surface || !key) throw new Error('this build has no MGL/Win32 layer compiled in');
    /*
     * The mouse, through the shim's own entry point. WinQuake reads it with GetCursorPos and centres
     * it with SetCursorPos (in_win.c:673), so the position lives in src/env/win32.c and this only
     * has to say how far it moved and which buttons are down.
     */
    const mouseIn = prog.F.prism_win32_mouse;
    const activate = prog.F.prism_win32_activate;

    /*
     * The program's OWN frame counter, so the status line can answer "is it running?".
     *
     * mgl.c increments prism_mgl_frames on every blit. Without this the page had no counter for this
     * host at all and printed `running · 320x240` for a program that was flying and for one that had
     * stopped alike -- which is precisely the question somebody asks when a mode change goes wrong.
     */
    const framesAt = sym('prism_mgl_frames');
    if (framesAt) Atomics.store(ctrl, SLOT.FRAME_ADDR, framesAt);

    /*
     * The window, published from the program and driven back into it. src/env/win32.c keeps the
     * rectangle because the PROGRAM moves and resizes it; the page draws a frame around the picture
     * and, when somebody drags that frame, writes the new position here for the guest to apply.
     * GetWindowRect then reports it, which is how Quake learns it moved -- exactly what a window
     * manager does.
     */
    const win = {
      x: sym('prism_win32_x'), y: sym('prism_win32_y'),
      w: sym('prism_win32_w'), h: sym('prism_win32_h'),
      title: sym('prism_win32_title'),
    };
    const move = prog.F.prism_win32_move, closeWin = prog.F.prism_win32_close;
    let lastDrag = 0, lastTitle = '', lastButtons = 0, lastFocus = 1;
    Atomics.store(ctrl, SLOT.WIN_HAS, win.x ? 1 : 0);

    const pumpWindow = () => {
      if (!win.x) return;
      const dvv = prog.mod.dv;
      Atomics.store(ctrl, SLOT.WIN_X, dvv.getInt32(win.x, true));
      Atomics.store(ctrl, SLOT.WIN_Y, dvv.getInt32(win.y, true));
      Atomics.store(ctrl, SLOT.WIN_W, dvv.getInt32(win.w, true));
      Atomics.store(ctrl, SLOT.WIN_H, dvv.getInt32(win.h, true));
      let title = '';
      for (let i = 0; i < 127 && prog.M.u8[win.title + i]; i++) {
        title += String.fromCharCode(prog.M.u8[win.title + i]);
      }
      if (title !== lastTitle) { lastTitle = title; post('window', { title }); }

      const gen = Atomics.load(ctrl, SLOT.DRAG_GEN);
      if (gen !== lastDrag && move) {
        lastDrag = gen;
        move(Atomics.load(ctrl, SLOT.DRAG_X), Atomics.load(ctrl, SLOT.DRAG_Y));
      }
      if (Atomics.load(ctrl, SLOT.WIN_CLOSE) && closeWin) {
        Atomics.store(ctrl, SLOT.WIN_CLOSE, 0);
        closeWin();
      }
    };

    /*
     * MGL's palette_t is BGRA and holds the FULL 0..255 -- vid_win.c writes `pal[i].red =
     * palette[i*3]` with no shift. Scaling it as if it were the DAC's six bits made the first
     * capture four times too bright, which is the kind of mistake that looks like a gamma setting.
     */
    const publishPalette = () => {
      for (let i = 0; i < 256; i++) {
        pal[i * 3 + 0] = prog.M.u8[at.palette + i * 4 + 2];
        pal[i * 3 + 1] = prog.M.u8[at.palette + i * 4 + 1];
        pal[i * 3 + 2] = prog.M.u8[at.palette + i * 4 + 0];
      }
      Atomics.add(ctrl, SLOT.PALGEN, 1);
    };

    const dv = prog.mod.dv;
    /*
     * THE FRAME BOUNDARY IS BOTH BLITS, and missing the second one looked exactly like a freeze.
     *
     * FlipScreen (vid_win.c) presents through `MGL_bitBltCoord` normally and through
     * `MGL_stretchBltCoord` when `vid_stretched` is set -- which is what Quake's 2x windowed modes
     * are. Wrapping only the first meant that the moment somebody chose one of those modes from the
     * video menu, this host stopped publishing the surface, stopped delivering keystrokes and
     * stopped pacing, while the game went on rendering at full speed into a buffer nobody read. The
     * picture stood still and the keyboard died: a frozen program by every visible sign, and a
     * perfectly healthy one underneath.
     *
     * The page still reads the SOURCE surface, so a stretched mode arrives as the 320x240 the game
     * actually drew and the canvas scales it -- which is better than the doubled copy, not worse.
     */
    const wrapped = function (inner, ...a) {
      const r = inner.apply(this, a);
      const surface = dv.getInt32(at.surface, true);
      if (surface) {
        Atomics.store(ctrl, SLOT.WIDTH, dv.getInt32(at.width, true));
        Atomics.store(ctrl, SLOT.HEIGHT, dv.getInt32(at.height, true));
        Atomics.store(ctrl, SLOT.PIXELS, surface);
        Atomics.store(ctrl, SLOT.TEXTMODE, 0);
        publishPalette();
      }
      /*
       * The keystrokes go in HERE, at the frame boundary, and through the program's own message
       * queue -- prism_win32_key posts a real WM_KEYDOWN, which leaves through PeekMessage and comes
       * back into Quake's MainWndProc. Handing them to its input code directly would have been
       * shorter and would have tested nothing.
       */
      for (let e = keyboard.nextEvent(); e; e = keyboard.nextEvent()) key(e.scan, e.down ? 1 : 0);
      /*
       * Focus, forwarded as WM_ACTIVATE. A game that has lost the focus must let go of the mouse --
       * that is what the program does with it, and it is why alt-tab works on a real machine.
       */
      if (activate) {
        const f = Atomics.load(ctrl, SLOT.FOCUS);
        if (f !== lastFocus) { activate(f); lastFocus = f; }
      }
      if (mouseIn) {
        const { dx, dy } = mouse.take();
        const b = mouse.state();
        // Sent when there is anything to say, and when a button changed with no movement.
        if (dx || dy || b !== lastButtons) { mouseIn(dx, dy, b); lastButtons = b; }
      }
      pumpWindow();
      reader.endFrame();
      pace();
      return r;
    };
    for (const name of ['MGL_bitBltCoord', 'MGL_stretchBltCoord']) {
      const inner = prog.F[name];
      if (!inner) continue;
      const w = function (...a) { return wrapped.call(this, inner, ...a); };
      prog.F[name] = w;
      prog.mod.bindFunc(name, w);
    }

  } else if (platform === 'gdi' || platform === 'win32') {
    /*
     * A WIN32 GUI host: PuTTY. The target calls this platform `win32` and the page called it `gdi`
     * while it was being written; both names arrive here, because a build that names its own
     * platform should not have to know what the shell called the branch.
     *
     * Same platform layer as WinQuake -- src/env/win32.c is compiled in --
     * but the picture arrives the other way. Quake owns a display and blits it; a GUI program draws
     * through GDI whenever Windows tells it to, so there is no blit to hook and no palette at all:
     * win32-gui.c rasterises into a 32-bit surface and the page reads that.
     *
     * The frame boundary is MsgWaitForMultipleObjects, which is where win32.c parks a program with
     * nothing to do. It is the only moment in a GUI program's life that is guaranteed to come round
     * again, which makes it the right place to publish the surface, deliver keystrokes and pace.
     */
    installStdio(prog.M, { files, readChar: () => keyboard.read() });
    /*
     * The two libraries this platform's C is compiled against: the 8x16 ROM font it rasterises with,
     * and Winsock. The socket layer is installed even here, where there are no sockets -- the program
     * CALLS it, so leaving it out is not "no network", it is a missing function and a crash at the
     * first connect. Installed, it fails the way a refused connection fails, which PuTTY handles.
     */
    installVgaFont(prog.M, { bytes: vgaFont });
    installWsock(prog.M);
    const sym = (n) => prog.mod.symbols.get(n)?.addr ?? 0;
    const at = { surface: sym('prism_gdi_surface'), w: sym('prism_gdi_w'), h: sym('prism_gdi_h') };
    const key = prog.F.prism_win32_key;
    if (!at.surface) throw new Error('this build has no Win32 GDI layer compiled in');

    const win = {
      x: sym('prism_win32_x'), y: sym('prism_win32_y'),
      w: sym('prism_win32_w'), h: sym('prism_win32_h'), title: sym('prism_win32_title'),
    };
    const move = prog.F.prism_win32_move, closeWin = prog.F.prism_win32_close;
    let lastDrag = 0, lastTitle = '';
    Atomics.store(ctrl, SLOT.WIN_HAS, win.x ? 1 : 0);

    const dv = prog.mod.dv;
    const publish = () => {
      const surface = dv.getInt32(at.surface, true);
      const w = dv.getInt32(at.w, true), h = dv.getInt32(at.h, true);
      if (surface && w > 0 && h > 0) {
        Atomics.store(ctrl, SLOT.WIDTH, w);
        Atomics.store(ctrl, SLOT.HEIGHT, h);
        Atomics.store(ctrl, SLOT.PIXELS, surface);
        Atomics.store(ctrl, SLOT.PIXFMT, 32);
        Atomics.store(ctrl, SLOT.TEXTMODE, 0);
      }
      if (win.x) {
        Atomics.store(ctrl, SLOT.WIN_X, dv.getInt32(win.x, true));
        Atomics.store(ctrl, SLOT.WIN_Y, dv.getInt32(win.y, true));
        Atomics.store(ctrl, SLOT.WIN_W, dv.getInt32(win.w, true));
        Atomics.store(ctrl, SLOT.WIN_H, dv.getInt32(win.h, true));
        let title = '';
        for (let i = 0; i < 127 && prog.M.u8[win.title + i]; i++) {
          title += String.fromCharCode(prog.M.u8[win.title + i]);
        }
        if (title !== lastTitle) { lastTitle = title; post('window', { title }); }
        const gen = Atomics.load(ctrl, SLOT.DRAG_GEN);
        if (gen !== lastDrag && move) {
          lastDrag = gen;
          move(Atomics.load(ctrl, SLOT.DRAG_X), Atomics.load(ctrl, SLOT.DRAG_Y));
        }
        if (Atomics.load(ctrl, SLOT.WIN_CLOSE) && closeWin) {
          Atomics.store(ctrl, SLOT.WIN_CLOSE, 0);
          closeWin();
        }
      }
      if (key) for (let e = keyboard.nextEvent(); e; e = keyboard.nextEvent()) key(e.scan, e.down ? 1 : 0);
      reader.endFrame();
    };

    const wait = prog.F.MsgWaitForMultipleObjects;
    if (!wait) throw new Error('this build has no message loop to pace from');
    const wrapped = function (...a) {
      publish();
      pace();
      return wait.apply(this, a);
    };
    prog.F.MsgWaitForMultipleObjects = wrapped;
    prog.mod.bindFunc('MsgWaitForMultipleObjects', wrapped);

  } else if (platform === 'dos') {
    /*
     * A DJGPP/DOS host: Quake's own DOS build. The same three devices the Raven games need, plus
     * DJGPP's DPMI floor -- and no CRTC emulation, because Quake's default video mode programs no
     * VGA registers at all (`vgavidmodes[0]` carries an empty register set), which leaves the
     * framebuffer as ordinary memory at 0xA0000.
     *
     * tools/quake.mjs reached this arrangement first; this is the same one, which is the point of
     * the environment being a list in the target rather than code in each harness.
     */
    installStdio(prog.M, { files, readChar: () => keyboard.read() });
    const machine = installPortMachine(prog.M);
    installCrtStatus(machine);                       // VGA_WaitVsync spins on bit 3 of 0x3DA
    installVgaDac(machine, {
      onChange: (palette) => { pal.set(palette); Atomics.add(ctrl, SLOT.PALGEN, 1); },
    });
    prog.M.kbd = installKbd8042(machine);            // in_dos.c's handler reads port 0x60
    installPIT(machine, prog.M, { micros: () => performance.now() * 1000 });
    /*
     * The mouse, which is what turns `No mouse found` into a game you can aim in. Quake's DOS build
     * asks INT 33h for three services and go32.js answers them from this channel; the page fills it
     * under Pointer Lock.
     */
    const dosHost = installGo32(prog.M, { mouse });

    Atomics.store(ctrl, SLOT.WIDTH, 320);
    Atomics.store(ctrl, SLOT.HEIGHT, 200);
    Atomics.store(ctrl, SLOT.PIXELS, 0xa0000);
    Atomics.store(ctrl, SLOT.TEXTMODE, 0);

    /*
     * VID_Update is the frame boundary AND the only moment this host has to deliver an interrupt: a
     * DOS program's asynchronous events arrive while it is inside a loop of its own C. A press and a
     * release are one interrupt each, because that is what the hardware sends.
     */
    const inner = prog.F.VID_Update;
    const w = function (...a) {
      const r = inner.apply(this, a);
      for (let e = keyboard.nextEvent(); e; e = keyboard.nextEvent()) {
        prog.M.kbd.push(e.down ? e.scan : (e.scan | 0x80));
        dosHost.deliver(0x09);
      }
      reader.endFrame();
      pace();
      return r;
    };
    prog.F.VID_Update = w;
    prog.mod.bindFunc('VID_Update', w);

  } else if (platform === 'borland16') {
    /*
     * A 16-BIT DOS PROGRAM ON THE BARE MACHINE -- Keen Dreams. Borland C++, its own TASM modules,
     * and no library underneath: it installs its own timer interrupt, reads the keyboard from its own
     * int 9 handler and writes the EGA's registers itself. The devices come from the target's env
     * list through buildEnv, as in Node (tools/keen.mjs), so the two install the same machine.
     *
     * TIME. src/env/pcirq.js counts VIRTUAL microseconds, one per backward branch, and sets the
     * safepoint budget to the edges left before the next interrupt, so M.sp_ runs exactly when one is
     * due. Headless that runs as fast as the host can; in front of a person the virtual clock must
     * not run ahead of the wall. So the safepoint is wrapped: pcirq does its work, then the worker
     * sleeps for as long as virtual time is ahead. The interrupts stay where virtual time puts them
     * -- deterministic -- and only the rate at which that time passes is tied to the real one.
     */
    buildEnv(prog.M, program.env ?? [], { stdio: { files, readChar: () => keyboard.read() } });
    const bound = tasmMods.length ? installTasm(prog, tasmMods) : [];
    log(`Turbo Assembler routines bound: ${bound.length}` +
      (bound.refused?.length ? `; ${bound.refused.length} instruction(s) refused where they stand` : ''));
    const ega = prog.M.ega, clock = prog.M.vclock;
    if (!ega || !clock) throw new Error("host 'borland16' needs the ega and pcirq environments in the target's env list");

    /*
     * THE PICTURE is planes, not memory, so it is composed: palette indices into a buffer of this
     * host's own, the attribute palette's sixteen colours into the page's palette. Text mode is the
     * guest's own 0xB8000, which the page already draws.
     *
     * The buffer lives at 0xD0000, the upper-memory block where a PC keeps option ROMs: this machine
     * puts none there and a 16-bit program's far data ends at 0xA0000 (src/link/module.js), while its
     * whole space is the one megabyte. Not in the program's heap: under dos16m rt.malloc is DGROUP's
     * near heap, 64K for everything, and the first frame's 64,000 bytes took it ("out of memory in
     * malloc" on the first key).
     */
    const VIEW_AT = 0xd0000;
    if (prog.M.u8.length < VIEW_AT + 320 * 200) throw new Error("host 'borland16': the guest image is too small for the display buffer");
    let view = 0, graphics = false;
    const lastPal = new Uint8Array(48);
    const compose = () => {
      if (ega.mode !== 0x0d) {
        if (graphics) { Atomics.store(ctrl, SLOT.TEXTMODE, 1); graphics = false; }
        return;
      }
      view = VIEW_AT;
      const f = ega.indexed(prog.M.u8.subarray(view, view + 320 * 200));
      if (!graphics) {
        Atomics.store(ctrl, SLOT.WIDTH, 320);
        Atomics.store(ctrl, SLOT.HEIGHT, 200);
        Atomics.store(ctrl, SLOT.PIXELS, view);
        Atomics.store(ctrl, SLOT.TEXTMODE, 0);
        graphics = true;
      }
      let changed = false;
      f.palette.forEach(([r, g, b], i) => {
        if (lastPal[3 * i] !== r || lastPal[3 * i + 1] !== g || lastPal[3 * i + 2] !== b) changed = true;
        lastPal[3 * i] = r; lastPal[3 * i + 1] = g; lastPal[3 * i + 2] = b;
      });
      if (changed) { pal.set(lastPal); Atomics.add(ctrl, SLOT.PALGEN, 1); }
      Atomics.add(ctrl, SLOT.FRAME, 1);
    };

    /*
     * THE KEYBOARD is a scancode through port 60h and IRQ1, scheduled at the CURRENT virtual time
     * (pcirq latches one per interrupt, in order). An extended key is the two bytes the hardware
     * sends. A release arriving in the same drain as its press is held back one drain, so a quick tap
     * leaves a moment at which the program can see the key down -- the planar host found that.
     */
    const heldBack = [];
    const drainKeys = () => {
      const now = clock.us / 1000;
      const send = (e) => {
        const codes = e.extended ? [0xe0] : [];
        codes.push(e.down ? e.scan : (e.scan | 0x80));
        prog.M.keyboard.at(now, ...codes);
      };
      for (const e of heldBack) send(e);
      heldBack.length = 0;
      const pressedNow = new Set();
      for (let e = keyboard.nextEvent(); e; e = keyboard.nextEvent()) {
        if (!e.down && pressedNow.has(e.scan)) { heldBack.push(e); continue; }
        if (e.down) pressedNow.add(e.scan);
        send(e);
      }
    };

    const innerSp = prog.M.sp_;
    let t0 = null, lastShow = 0;
    prog.M.sp_ = (...a) => {
      innerSp(...a);
      if (Atomics.load(ctrl, SLOT.STOP)) throw new Error('__stopped');
      while (Atomics.load(ctrl, SLOT.PAUSE) && park(50)) t0 = null;
      const now = performance.now();
      const pct = Atomics.load(ctrl, SLOT.SPEED);
      const virt = clock.us / 1000 * (pct ? 100 / pct : 0);
      if (t0 === null) t0 = now - virt;
      const ahead = virt - (now - t0);
      if (pct && ahead > 1) park(ahead);
      else if (ahead < -250) t0 = now - virt;      // a slow host: resync rather than race to catch up
      if (now - lastShow >= 16) { lastShow = now; drainKeys(); compose(); }
    };

  } else if (platform === 'planar') {
    /*
     * A DOS HOST WITH UNCHAINED PLANAR VGA -- mode X. Jump 'n Bump.
     *
     * Two things make it different from the `dos` branch above rather than a variant of it.
     *
     * THE PICTURE IS NOT A BUFFER. In unchained VGA four consecutive pixels live in four different
     * planes at the same offset, so there is no linear framebuffer to publish: pixel (x, y) is
     * plane x&3 at start + y*rowBytes + x/4. The page reads w*h bytes at one address, so the frame
     * is DE-INTERLEAVED into a buffer of this host's own each time the program flips a page.
     *
     * THE FRAME BOUNDARY IS A REGISTER WRITE. There is no VID_Update to wrap: the program makes a
     * page visible by writing the CRTC start address, and src/env/vgaplanar.js fires onFrame there.
     *
     * The devices come from the TARGET'S OWN env list through buildEnv -- stdio, go32, ports, dj,
     * vgadac, crtstatus, kbd8042, vgaplanar -- so this branch names no device the target did not
     * ask for, and Node's build and this one install the same set from the same line.
     */
    const env = buildEnv(prog.M, program.env ?? [], {
      stdio: { files, readChar: () => keyboard.read() },
      vgadac: {
        onChange: (palette) => { pal.set(palette); Atomics.add(ctrl, SLOT.PALGEN, 1); },
      },
      go32: { mouse },
    });
    const dosHost = env.go32 ?? null;

    /*
     * The program's own assembly. Jump 'n Bump defines get_block and put_block nowhere but
     * dos/gfx.S -- no C twin anywhere in the tree -- so without this the two routines that draw
     * every sprite are missing and their CALLERS cannot be emitted either. After buildEnv, because
     * a routine that does `out` needs the port seam to exist.
     */
    if (asmSources.length) {
      const bound = installAsm(prog, { sources: asmSources, machine: prog.M.machine ?? null });
      log(`assembly translated and bound: ${bound.map((b) => b.name).join(" ")}`);
    }

    /*
     * The de-interleaved frame. Allocated on the first flip rather than up front, because the
     * geometry is read from the registers the PROGRAM wrote -- width from the Offset register,
     * height from Vertical Display End and the character height -- and none of them are set until
     * it has chosen its mode.
     */
    const view = { addr: 0, w: 0, h: 0 };
    const heldBack = [];                 // releases deferred one frame; see the drain below
    const vga = prog.M.vga;
    if (!vga) {
      throw new Error("host 'planar' needs the vgaplanar environment — it is the device that makes " +
        'the 0xA0000 window four planes. Name it in the target\'s env list.');
    }
    const u8 = prog.M.u8;
    const composeFrame = () => {
      const g = vga.geometry();
      if (!g.width || !g.height) return;
      if (g.width !== view.w || g.height !== view.h) {
        view.addr = prog.M.rt.malloc(g.width * g.height);
        view.w = g.width; view.h = g.height;
        Atomics.store(ctrl, SLOT.WIDTH, g.width);
        Atomics.store(ctrl, SLOT.HEIGHT, g.height);
        Atomics.store(ctrl, SLOT.PIXELS, view.addr);
        Atomics.store(ctrl, SLOT.TEXTMODE, 0);
        log(`planar display ${g.width}x${g.height}, ${g.rowBytes} bytes a row per plane`);
      }
      const start = vga.start, rb = g.rowBytes, planes = vga.planes;
      for (let y = 0; y < view.h; y++) {
        const row = view.addr + y * view.w, src = start + y * rb;
        for (let x = 0; x < view.w; x++) {
          u8[row + x] = u8[planes + ((x & 3) << 16) + src + (x >> 2)];
        }
      }
    };

    /*
     * THE KEYBOARD IS AN INTERRUPT, so it must not depend on the program drawing.
     *
     * An EXTENDED key is sent as the two bytes the hardware sends, 0xE0 then the code, each its own
     * interrupt -- the guest's handler reads one byte per interrupt and carries `extended` in a
     * static between them. Without the prefix the arrows land in keyb[0x48] and the game reads
     * keyb[0xc8], so player one could never jump.
     *
     * A RELEASE THAT ARRIVES IN THE SAME DRAIN AS ITS PRESS IS HELD BACK. The drain runs between two
     * of the guest's own instructions, so delivering both leaves no moment at which the program can
     * look and find the key down -- a quick tap is simply lost. Measured on this page: tapping
     * Escape did nothing, holding it 400 ms quit the game as its menu says it should.
     */
    const drainKeys = () => {
      if (!dosHost || !prog.M.kbd) return;
      const send = (e) => {
        if (e.extended) { prog.M.kbd.push(0xe0); dosHost.deliver(0x09); }
        prog.M.kbd.push(e.down ? e.scan : (e.scan | 0x80));
        dosHost.deliver(0x09);
      };
      for (const e of heldBack) send(e);
      heldBack.length = 0;
      const pressedNow = new Set();
      for (let e = keyboard.nextEvent(); e; e = keyboard.nextEvent()) {
        if (!e.down && pressedNow.has(e.scan)) { heldBack.push(e); continue; }
        if (e.down) pressedNow.add(e.scan);
        send(e);
      }
    };

    vga.onFrame = () => {
      composeFrame();
      drainKeys();
      reader.endFrame();
      pace();
    };

    /*
     * ...AND THE SAME TWO THINGS ON A BACK EDGE, because a screen that never flips pages otherwise
     * gets neither.
     *
     * Jump 'n Bump's scoreboard -- the screen Escape in play leads to -- draws once and then loops on
     * the palette and the retrace without ever writing the CRTC start address. With the page flip as
     * the only hook, the picture stopped updating AND the keyboard went dead together: the program
     * reached `while (key_pressed(1) == 1) dj_mix();` (main.c:656) waiting for Escape to be released,
     * and the release could never be delivered, because delivering it needed a page flip that would
     * only happen after the release. tools/find-loop.mjs named that loop; 100% of samples after the
     * freeze were in it. The real game, under DOSBox-X, unwinds and exits -- so this was ours.
     *
     * A back edge is the one thing every loop has, which is why the leash is caught here too
     * (src/runtime/runtime.js). Throttled by wall time rather than by a count: composing a frame is
     * real work and a spin loop reaches this far more often than a display changes.
     */
    const innerSp = prog.M.sp_;
    let lastPoll = 0;
    /*
     * THE INITIAL BUDGET, which matters as much as the hook. spBudget starts at 1<<30, so the FIRST
     * safepoint call is about a billion back edges away: measured on the hang this fixes, a 40 s run
     * reached this handler 0 times and the release was never delivered. The refill below keeps it
     * responsive; this is what makes the first one arrive at all.
     */
    prog.M.spBudget = 1 << 18;
    prog.M.sp_ = (id) => {
      innerSp.call(prog.M, id);
      // AFTER the default handler, which refills with 1<<30 when no leash is armed -- and none is
      // here. Refilling ourselves is what keeps the hook alive past its first call.
      prog.M.spBudget = 1 << 18;
      const t = performance.now();
      if (t - lastPoll < 16) return;              // ~60 Hz, the rate a display would change anyway
      lastPoll = t;
      drainKeys();
      composeFrame();
    };

  } else if (platform === 'sdl2') {
    /*
     * AN SDL 2 HOST. The same game as the `sdl` branch below, and the difference is the one thing
     * SDL2 changed for a program like this: it draws into a surface, converts, uploads through
     * SDL_UpdateTexture and presents. So what the page reads is the TEXTURE, already 32-bit B,G,R,A,
     * and the palette stops being something to publish -- the conversion has already applied it.
     */
    const env = buildEnv(prog.M, program.env ?? [], {
      stdio: { files, readChar: () => keyboard.read() },
      /*
       * The guest's OWN frame limiter, which runs inside a frame and so below anything pace() can
       * see. Served on the parker's wait channel -- one notify from the page still releases it --
       * because a limiter written as "sleep a little, ask again" spins when the sleep does nothing,
       * and this one asked 487 million times over 200 frames of OpenTyrian.
       */
      sdl2: { clock: sleepingClock((ms) => { park(ms); }) },
    });
    const sdl = prog.M.sdl;
    if (!sdl) {
      throw new Error("host 'sdl2' needs the sdl2 environment — it is what supplies the texture " +
        "the page reads. Name it in the target's env list.");
    }

    /*
     * SDL_RenderPresent is where the PROGRAM says a frame is finished, so it is wrapped rather than
     * timed. Wrapping the entry point needs nothing from the shim, which is why this branch differs
     * in shape from the SDL 1.2 one without differing in what it means.
     */
    const innerPresent = prog.M.rt.SDL_RenderPresent;
    let published = 0;
    prog.M.rt.SDL_RenderPresent = function (...a) {
      const r = innerPresent.apply(this, a);
      const tex = [...sdl.textures.values()].pop();
      if (tex && tex.w && tex.h) {
        if (published !== tex.pixels) {
          published = tex.pixels;
          Atomics.store(ctrl, SLOT.WIDTH, tex.w);
          Atomics.store(ctrl, SLOT.HEIGHT, tex.h);
          Atomics.store(ctrl, SLOT.PIXELS, tex.pixels);
          Atomics.store(ctrl, SLOT.PIXFMT, 32);      // B,G,R,A in memory, as the page expects
          Atomics.store(ctrl, SLOT.TEXTMODE, 0);
          log(`SDL 2 display ${tex.w}x${tex.h}, 32-bit texture`);
        }
        // One key event per present, through the shim's own door.
        for (let e = keyboard.nextEvent(); e; e = keyboard.nextEvent()) {
          if (env.sdl2?.pushKey) env.sdl2.pushKey(e.scan, e.down);
        }
        reader.endFrame();
        pace();
      }
      return r;
    };

  } else if (platform === 'glut') {
    /*
     * A GLUT PROGRAM ON PRISM'S GL (src/env/gl.js, glut.js). The picture is gl.js's framebuffer --
     * the software rasteriser gate-gears holds to Mesa -- copied at every glutSwapBuffers into a
     * buffer in guest memory, top row first and B,G,R,A, which is the layout the page already reads
     * for SDL 2. GLUT_ELAPSED_TIME is real time here, so the program animates at its own speed.
     */
    const t0 = performance.now();
    let out = 0;
    // WebGL2 on an OffscreenCanvas when the worker has one; ?gl=soft asks for the software rasteriser.
    const backend = options.gl === 'soft' || typeof OffscreenCanvas === 'undefined' ? 'soft' : 'webgl';
    // ?glcheck=0,25,50: the fixed 40 ms schedule gate-gears uses, and those frames posted back.
    const check = options.glcheck ? options.glcheck.split(',').map(Number) : null;
    const env = buildEnv(prog.M, program.env ?? [], {
      stdio: { files, readChar: () => keyboard.read() },
      gl: { backend },
      glut: {
        now: check ? null : () => performance.now() - t0,
        frames: check,
        onFrame: check ? (n, rgba, w, h) => post('diag', { glframe: n, w, h, rgba, backend }) : null,
        stop: () => Atomics.load(ctrl, SLOT.STOP) !== 0,
        onSwap: (_n, gl) => {
          const { width: w, height: h } = gl.state;
          if (!out) {
            out = prog.M.rt.malloc(w * h * 4);
            Atomics.store(ctrl, SLOT.WIDTH, w);
            Atomics.store(ctrl, SLOT.HEIGHT, h);
            Atomics.store(ctrl, SLOT.PIXELS, out);
            Atomics.store(ctrl, SLOT.PIXFMT, 32);
            Atomics.store(ctrl, SLOT.TEXTMODE, 0);
            log(`GL display ${w}x${h}, ${gl.backend === 'webgl' ? 'WebGL2' : 'software rasteriser'}`);
          }
          const px = gl.readPixels(), u8 = prog.M.u8;
          for (let i = 0; i < w * h; i++) {
            u8[out + 4 * i] = px[4 * i + 2]; u8[out + 4 * i + 1] = px[4 * i + 1];
            u8[out + 4 * i + 2] = px[4 * i]; u8[out + 4 * i + 3] = 255;
          }
          reader.endFrame();
          pace();
        },
      },
    });
    if (!env.glut) throw new Error("host 'glut' needs the gl and glut environments. Name them in the target's env list.");

  } else if (platform === 'sdl') {
    /*
     * AN SDL 1.2 HOST. The simplest display path in this file, and deliberately so: the program
     * asks for an 8-bit surface, writes every pixel of it, and flips. There is nothing to
     * de-interleave as in the planar branch and no stride to undo as in the DIB one -- the page can
     * read the surface where it lies, which is the same "publish what the program already writes"
     * move x11.js makes.
     *
     * Devices come from the target's own env list, so this branch names none of them.
     */
    const env = buildEnv(prog.M, program.env ?? [], {
      stdio: { files, readChar: () => keyboard.read() },
      sdl12: {
        onPalette: (palette) => { pal.set(palette); Atomics.add(ctrl, SLOT.PALGEN, 1); },
        /*
         * The guest's OWN frame limiter, which runs inside a frame and so below anything pace() can
         * see. Served on the parker's wait channel -- one notify from the page still releases it --
         * because a limiter written as "sleep a little, ask again" spins when the sleep does
         * nothing, and this one asked 487 million times over 200 frames of OpenTyrian.
         */
        clock: sleepingClock((ms) => { park(ms); }),
      },
    });
    void env;
    const sdl = prog.M.sdl;
    if (!sdl) {
      throw new Error("host 'sdl' needs the sdl12 environment — it is what supplies the surface " +
        "the page reads. Name it in the target's env list.");
    }

    /*
     * One page event becomes one SDL event, and `extended` has to survive the trip: the arrows and
     * the numeric keypad share scan code 72, SDL 1.2 gives them different symbols, and this game
     * binds them to two different players. Dropping the flag would merge their controls silently.
     */
    sdl.state.keyboard = {
      next: () => {
        const e = keyboard.nextEvent();
        return e ? { scan: e.scan, extended: !!e.extended, down: e.down, ascii: 0 } : null;
      },
    };

    let published = 0;
    sdl.state.onPresent = () => {
      const { width: w, height: h, pixels } = sdl.state;
      if (!w || !h || !pixels) return;
      // Republished only when the mode actually changes; the surface does not move per frame.
      if (published !== pixels) {
        published = pixels;
        Atomics.store(ctrl, SLOT.WIDTH, w);
        Atomics.store(ctrl, SLOT.HEIGHT, h);
        Atomics.store(ctrl, SLOT.PIXELS, pixels);
        Atomics.store(ctrl, SLOT.TEXTMODE, 0);
        log(`SDL 1.2 display ${w}x${h}, 8-bit`);
      }
      reader.endFrame();
      pace();
    };

  } else if (platform === 'svgalib') {
    /*
     * A LINUX CONSOLE host: the same machine as x11, the other display path. svgalib is shimmed at
     * the library boundary like Xlib is, and it is the easiest of the three input surfaces in the
     * corpus -- its keyboard hands the client a raw PC scan code and its mouse hands it relative
     * deltas, which are exactly the two channels the control block already carries.
     */
    installStdio(prog.M, { files, readChar: () => keyboard.read() });
    installPortMachine(prog.M);                      // the game programs the VGA planes itself
    installSvgalib(prog.M, {
      publish: { ctrl, pal },
      keyboard: { next: () => keyboard.nextEvent() },
      mouse,
    });
    /*
     * The frame boundary is the game's own VID_Update: this driver writes straight into the
     * framebuffer it was handed, so unlike X11 there is no library call left to hook.
     */
    const inner = prog.F.VID_Update;
    const wrapped = function (...a) {
      const r = inner.apply(this, a);
      reader.endFrame();
      pace();
      return r;
    };
    prog.F.VID_Update = wrapped;
    prog.mod.bindFunc('VID_Update', wrapped);

  } else if (platform === 'console') {
    /*
     * NO PLATFORM AT ALL: libc, a text screen, and the keyboard as stdin.
     *
     * Lua and clangsay ask for nothing else -- no display, no devices, no clock -- and that is
     * exactly why they are on the shelf: they are the case where PRISM's claim is only about C. The
     * text console and the real clock are installed for every program further down, so this branch
     * has one line in it, and the fact that it does is the point.
     */
    /*
     * ECHO, which is the TERMINAL's job and not the program's. Lua prints a prompt and reads a line;
     * it never prints what you type, because on a real machine the tty driver did. The text screen
     * here is that terminal, so this is the layer that owes you the character back -- and without it
     * you type into a black rectangle and only find out what you wrote when the answer comes.
     */
    /*
     * ...plus whatever the BUILD asked for. A console program is not always only libc: Quake II's
     * Solaris port is a dedicated server, and its server dlopens the game library exactly as the
     * client's does. Reading the target's own env list is what keeps this from being a guess about
     * what a text program usually wants.
     */
    if ((program.env ?? []).includes('dl')) installDl(prog.M, { modules: program.sonames ?? {} });
    installStdio(prog.M, {
      files,
      readChar: () => {
        const c = keyboard.read();
        if (c > 0) prog.M.write(c === 13 ? '\r\n' : String.fromCharCode(c));
        /*
         * And Enter is a NEWLINE on this side of the wire. The keyboard reports 13, because that is
         * what a PC's BIOS buffer holds and what every DOS program in the shelf expects; a Unix
         * program reads a tty in canonical mode and gets 10. fgets looks for 10 and nothing else, so
         * without this Lua's REPL reads a line that never ends and answers nothing at all.
         */
        return c === 13 ? 10 : c;
      },
    });

  } else if (platform !== 'allegro') {
    /*
     * An unknown platform, said out loud.
     *
     * This chain used to end in an `else` that installed Allegro, so a build whose platform had no
     * branch here got MAME's environment and failed somewhere far away. Now that the page can PICK a
     * platform, that matters: `quake:dos` and `quake:win` are real builds Node runs today and the
     * shell has no branch for yet, and saying which is missing is more useful than a stack trace
     * from a program that was handed the wrong world.
     */
    throw new Error(`the shell has no branch for platform '${platform}' yet -- ` +
      `it presents x11, svgalib, mgl, gdi, dos, planar, sdl, sdl2, watcom, console and allegro. This build runs in Node: ` +
      `node tools/build.mjs targets/<name>.json:<variant> --run`);
  } else {
    /*
     * A DOS host: MAME's own src/msdos/msdos.c is compiled, and what is installed is the libraries it
     * links -- Allegro, SEAL, and DJGPP's memory helpers (src/env/allegro.js). The eighteen
     * osdepend.h functions are the game's own code again, which is what P1.7 was for.
     */
    installStdio(prog.M, { files, readChar: () => keyboard.read() });
    installPorts(prog.M);
    const allegro = installAllegro(prog.M, {
      // `audio` is the ring the page's AudioWorklet reads -- the same move as pixels, one dimension
      // down: the guest's sound library writes into shared memory and nothing is handed over.
      publish: { ctrl, pal, audio },
      /*
       * STOP is answered as Esc because that is how the program's OWN quit path works. Killing the
       * worker instead would skip whatever the program does on the way out.
       */
      keys: (k) => (Atomics.load(ctrl, SLOT.STOP) && k === 1 ? 1 : reader.read(k)),
      readKey: () => keyboard.readKey(),
      // The frame boundary: retire the key latches, then hold the guest until its frame is due.
      onPresent: () => {
        reader.endFrame();
        pace();
        const f = Atomics.load(ctrl, SLOT.FRAME);
        if (f % 60 === 0) post('diag', { spin: prog.M.spinDamping, clockUs: prog.M.realClock.micros() });
      },
    });
    allegro.bindGlobals(prog);

    /*
     * The safepoint handler, and the reason this program asks for safepoints at all.
     *
     * `while (osd_key_pressed(OSD_KEY_TAB));` is now a loop in the game's own C reading an array in
     * memory. It calls nothing, so spin damping cannot see it and the key it waits for would never
     * change. Refreshing key[] here is the faithful answer rather than a workaround: on a real DOS
     * machine that array is written by a keyboard INTERRUPT, and a safepoint is the only place this
     * runtime can be interrupted.
     *
     * The budget is deliberately coarse. It is not a sampling rate -- it is how many loop iterations
     * a program may run before the outside world is allowed to change under it, and one millisecond
     * of iterations is far below any latency a person can feel.
     */
    if (program.safepoints) {
      const BUDGET = 200000;
      prog.M.spBudget = BUDGET;
      let idle = 0;
      let lastFrame = 0;
      prog.M.sp_ = () => {
        prog.M.spBudget = BUDGET;
        allegro.refreshKeys();
        const f = Atomics.load(ctrl, SLOT.FRAME);
        // No frame since the last safepoint means the program is waiting, not working -- the same
        // judgement spin damping makes about a service, made about a loop.
        if (f === lastFrame) { if (++idle > 2) park(); } else { idle = 0; lastFrame = f; }
      };
    }
  }

  /*
   * The console writes into the guest's own text video RAM, and the page renders that. No output is
   * posted to the page at all any more: a program that prints and a program that pokes 0xB8000 must
   * end up in the same place, and they do because that place is guest memory.
   *
   * stdin now blocks. MAME prints "Press <ENTER> to continue." and calls getchar(); until this
   * existed, getchar returned EOF and the program asked a question it then ignored.
   */
  installConsole(prog.M, { readChar: () => keyboard.read() });

  /*
   * THE TERMINAL THE PROGRAM WAS STARTED FROM, carried into its own screen.
   *
   * installConsole clears the text page, so without this every program began on a blank screen and
   * its first printf appeared with nothing above it -- the command you had just typed, and the
   * listing you typed it from, were gone. That is not what a terminal does: output continues under
   * the command line. The shell hands over the 80x25 page it had drawn and the cursor it left, and
   * the program's first line lands on the next row.
   */
  if (screen) {
    prog.M.u8.set(new Uint8Array(screen.vram), VRAM_TEXT);
    prog.M.u8[0x450] = screen.col | 0;
    prog.M.u8[0x451] = screen.row | 0;
  }

  /*
   * A REAL clock, so the program's own frame throttle does the pacing at the rate the program itself
   * chose rather than at a rate declared for it in a JSON file. The speed control works by scaling
   * time — lying about it, as DOSBox does with cycles — instead of fighting the program's loop from
   * outside.
   *
   * This is where reproducibility is traded for faithfulness, which is why it is the browser only:
   * every gate keeps the deterministic clock, and the frame-for-frame differential against a native
   * build stays meaningful because MAME uses the clock to decide WHEN, never WHAT.
   */
  installRealClock(prog.M, {
    speed: () => Atomics.load(ctrl, SLOT.SPEED),
    paused: () => Atomics.load(ctrl, SLOT.PAUSE) !== 0,
  });

  /*
   * And the reason a real clock does not cost a whole core: every service a program polls in a tight
   * loop parks instead of spinning once it is clear the program is waiting rather than working.
   * One mechanism for the clock and for the three key-release loops in MAME alike.
   */
  installSpinDamping(prog.M, {
    park,
    frame: () => Atomics.load(ctrl, SLOT.FRAME),
    sleepMs: 1,
    /*
     * Per-service thresholds, both measured (`node tools/mame.mjs --probe-polls`, 400 frames of
     * Pac-Man): legitimate polling of `osd_key_pressed` peaks at 21 per frame, so 256 is a tenfold
     * margin, while a program asks the clock once or twice a frame. Sharing the keyboard's threshold
     * with the clock left thousands of clock calls spinning before every frame's wait — ~0.6 ms of
     * overhead per frame, which is what held the rate at 58 fps instead of 60.
     *
     * The 64 on the clock is where a timing-CALIBRATION loop would be cut short and read the machine
     * as slower than it is. Nothing in MAME calibrates; if something later does, the honest fix is a
     * per-program exemption, not a cleverer guess.
     */
    services: { uclock: 64, clock: 64, osd_key_pressed: 256 },
  });

  /*
   * WHAT THE PROGRAM PRINTS, in the log as well as on its screen -- installed HERE, after the
   * platform layer, because installConsole and installStdio each claim M.write and the last one to
   * do so wins. Wrapped before the compile it was simply overwritten.
   *
   * The text console is 80x25 and it scrolls, so a program that fails after a page of output leaves
   * only the last screenful -- and the useful line is the FIRST one. Quake II's "recursive shutdown"
   * is exactly that shape: the error you can see is the second one. Capped, because a game that
   * prints per frame would otherwise fill the page.
   */
  let mirrored = 0, partial = '';
  const guestWrite = prog.M.write;
  prog.M.write = (text) => {
    if (mirrored < GUEST_LOG_LINES) {
      partial += String(text);
      let nl;
      while ((nl = partial.indexOf('\n')) >= 0 && mirrored < GUEST_LOG_LINES) {
        const line = partial.slice(0, nl).replace(/[\r\x00-\x08\x0b-\x1f]/g, '');
        partial = partial.slice(nl + 1);
        if (line.trim()) log(line, 'guest');
        if (++mirrored === GUEST_LOG_LINES) log('  … further output only on the program\'s screen', 'warn');
      }
    }
    return guestWrite(text);
  };

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
