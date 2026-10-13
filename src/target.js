// target.js — a program described by DATA instead of by a tool.
//
// Every harness in tools/ grew the same six decisions in its own hand-written form: which files are
// translation units, which extra C the linker and the assembler would have provided, which macros
// select which platform, how an #include is resolved on a case-sensitive filesystem, how much
// memory, and which environment to install. Five programs, five copies, and each copy free to drift.
//
// A target file states those six things and nothing else. The schema is not invented: every field
// below exists because one of the existing harnesses already needed it, and the comment on each says
// which one and why.
//
// The BOUNDARY, stated rather than blurred: a target describes the BUILD and the ENVIRONMENT. It
// does not describe instrumentation. Quake's frame cap and key script, Doom's fire trigger, the
// audio drain -- those wrap the program's own functions to watch it run, and they belong in a tool.
// Putting them in JSON would move game logic into a config file and call it generic.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { toolchainCompile } from './toolchain.js';
import { join, basename, dirname, resolve as resolvePath } from 'node:path';
import { compileProgram, bindLateBuiltins, loadSnapshot, snapshotProgram } from './compile.js';
import { cacheEnabled, buildKey, recordingResolver, loadCached, storeCached } from './build-cache.js';
import { HEADERS } from './env/headers.js';
import { bindWin32Exports } from './env/dl.js';
import { buildEnv, envVars, envHeaders, envBuiltins } from './env/registry.js';
import { installAsm } from './asm/link.js';
import { asmText } from './asm/gas.js';
import { tasmModules, tasmExternData, installTasm, dataObjectBlocks } from './asm/tasm-link.js';

/**
 * @typedef {object} Target
 * @property {string}  name       what to call it in output.
 * @property {string}  dir        the source tree, relative to the repo root.
 * @property {object}  units      how to find the translation units -- see unitNames().
 * @property {object=} variants   named alternatives, e.g. Quake's null vs DOS platform. A variant
 *                                may set `units` outright or `addUnits` to extend the base list.
 * @property {string[]=} generated  extra .c files (repo-relative) supplying what the LINKER and the
 *                                  ASSEMBLER provide in a real build: MAME's OSD_VARS, Heretic's
 *                                  I_IBM_A.ASM exports, Quake's sys_dosa.s.
 * @property {object=} defines    program-wide macros; `null` as a value means UNDEFINE.
 * @property {object=} unitDefines  per-unit overrides, keyed by the unit's lower-case path as listed
 *                                  (a basename in a flat tree like Heretic's). Heretic's
 *                                  R_DRAW.C is the whole reason this exists: its C rendering loops
 *                                  live behind `#ifndef __WATCOMC__`, and nothing else in the
 *                                  program may have that macro undefined.
 * @property {object=} compile    { memory, pack, c89, model, signedChar, longDouble, collect, safepoints, directCalls }.
 * @property {boolean=} caseInsensitive  resolve #includes case-insensitively. Raven's trees write
 *                                       `DoomDef.h` for `DOOMDEF.H`; DOS never had to care.
 * @property {(string[]|object)=} env  the environment, by the names in src/env/registry.js.
 */

/**
 * The translation units, by one of three rules -- all three already in use:
 *
 *  - `{ list: [...] }`      an explicit, ordered set. Quake: the engine plus one platform.
 *  - `{ glob: "*.c" }`      everything, sorted. Doom: `readdirSync().filter(endsWith('.c')).sort()`.
 *  - `{ fromMakefile: "MAKEFILE" }`  the program's OWN object list. Heretic and Hexen, and the best
 *    of the three when it is available, because it is the build the authors actually ran.
 */
function unitNames(target, dir) {
  const u = target.units ?? {};
  if (u.list) return { names: u.list, asm: [] };
  if (u.glob) {
    const re = new RegExp('^' + u.glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
    return { names: readdirSync(dir).filter(f => re.test(f)).sort(), asm: [] };
  }
  if (u.fromMakefile) {
    /*
     * Read from the WHOLE makefile, not just its object variables. Heretic's link rule is
     *     tic.exe : $(LOCOBJS) $(GLOBOBJS) i_ibm.obj
     * so the one file holding every machine dependency -- and `main` -- is named nowhere else.
     * The `.c.obj :` suffix rules are skipped: they are patterns, not objects.
     */
    const mk = readFileSync(join(dir, u.fromMakefile), 'latin1');
    const lines = mk.split('\n').filter(l => !/^\.[A-Za-z]+\.[A-Za-z]+\s*:/.test(l));
    const objs = [...new Set(lines.join('\n').match(/[a-z0-9_]+\.obj/gi) ?? [])];
    const files = readdirSync(dir);
    const names = [], asm = [];
    for (const o of objs) {
      const stem = o.replace(/\.obj$/i, '');
      const hit = files.find(f => f.toLowerCase() === `${stem}.c`);
      if (hit) names.push(hit); else asm.push(stem);
    }
    return { names, asm };
  }
  throw new Error(`target '${target.name}': units needs one of list, glob, fromMakefile`);
}

/**
 * A module-definition file's export list, which is the program's OWN statement of what crosses the
 * boundary. `ref_soft/ref_soft.def` is four words -- `EXPORTS` then `GetRefAPI` -- and `game.def` is
 * the same shape. Reading it beats writing the list here for the same reason reading a MAKEFILE
 * beats listing units here.
 */
/**
 * What each module makes visible to the main program, from the program's own statement of it.
 *
 * Exported because the page needs the same answer and cannot read a .def file: the shell's server
 * computes it here and sends it, rather than the browser growing a second reader of the same format.
 */
export function moduleExportsOf(target, dir) {
  const out = {};
  for (const [name, m] of Object.entries(target.modules ?? {})) {
    if (name.startsWith('_')) continue;
    out[name] = m.exportsFrom ? exportsFromDef(resolvePath(dir, m.exportsFrom)) : (m.exports ?? []);
  }
  return out;
}

function exportsFromDef(path) {
  const text = readFileSync(path, 'latin1');
  const out = [];
  let inExports = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    if (/^EXPORTS$/i.test(line)) { inExports = true; continue; }
    if (/^[A-Z]+$/.test(line) && !inExports) continue;
    if (inExports) out.push(line.split(/\s+/)[0]);
  }
  return out;
}

/** An #include resolver over one source tree plus PRISM's own headers. */
export function makeResolver(dir, { caseInsensitive = false, include = null } = {}, missing, dosPaths,
  envTable = {}, casePaths = null) {
  /*
   * PRISM's OWN headers, by lower-cased name, for a caseInsensitive target.
   *
   * caseInsensitive used to reach the program's tree and stop there. Keen Dreams' id_heads.h writes
   * <STDIO.H>, <STDLIB.H>, <STRING.H>, <DOS.H> in capitals, PRISM supplies every one of them in lower
   * case, and so all eleven were stubbed empty: NULL went undeclared in three units, two of which
   * stopped on it. Only <ctype.h>, written in lower case, resolved. DOS never distinguished the two
   * spellings, and a target that says it is a DOS tree is saying so about its system headers too.
   *
   * Two spellings that fold to one name are never chosen between: that include stays missing and is
   * reported, which is a gap; picking one would be a guess.
   */
  const folded = new Map();
  if (caseInsensitive) {
    for (const k of new Set([...Object.keys(envTable), ...Object.keys(HEADERS)])) {
      const low = k.toLowerCase();
      folded.set(low, [...(folded.get(low) ?? []), k]);
    }
  }
  const foldBuiltin = (n) => {
    const keys = folded.get(n.toLowerCase());
    if (!keys || keys.length !== 1) return null;
    return { key: keys[0], text: envTable[keys[0]] ?? HEADERS[keys[0]] };
  };
  // Where to look, in order. `include` exists because MAME's tree is not flat: its makefile passes
  // -Isrc -Isrc/Z80 -Isrc/msdos and its units live in per-driver subdirectories.
  const dirs = [dir, ...(include ?? []).map(d => join(dir, d))];
  const find = (want, from) => {
    // A QUOTED include is relative to the including file first. That is the standard's rule, not a
    // MAME accommodation, and src/pacman/driver.c depends on it.
    const cands = from ? [dirname(from), ...dirs] : dirs;
    for (const d of cands) {
      const p = join(d, want);
      if (existsSync(p) && statSync(p).isFile()) return p;
      if (!caseInsensitive || !existsSync(d)) continue;
      const hit = readdirSync(d).find(f => f.toLowerCase() === want.toLowerCase());
      if (hit && statSync(join(d, hit)).isFile()) return join(d, hit);
    }
    return null;
  };
  /*
   * One spelling of the name, tried in full. Order matters, and OpenDUNE is what proved it.
   *
   * The path as WRITTEN comes first -- `Z80/Z80.h` is a real relative path, and a quoted include
   * resolves against the including file before anything else. Then the STANDARD header by its full
   * name, and only after that the basename fallback.
   *
   * Letting the basename fallback run before the standard table means `<sys/types.h>` reduces to
   * `types.h` and finds OpenDUNE's `include/types.h`, so `ssize_t` never gets declared and PRISM's
   * own unistd.h fails to parse. A header in the tree may shadow a standard one when the program
   * asks for it BY THAT NAME, never by accident of its basename.
   */
  const lookup = (name, from) => {
    const path = find(name, from);
    if (path) return { path, text: readFileSync(path, 'latin1') };
    // An environment's own headers sit in FRONT of the standard table and behind the program's own
    // tree: naming `sdl2` is what decides that "SDL.h" means SDL2's, and a header the game ships
    // under that name still wins, exactly as before.
    const env = envTable[name] ?? HEADERS[name];
    if (env !== undefined) return { path: `<${name}>`, text: env };
    const want = basename(name);
    const loose = find(want, from);
    if (loose) return { path: loose, text: readFileSync(loose, 'latin1') };
    const std = envTable[want] ?? HEADERS[want];
    if (std !== undefined) return { path: `<${name}>`, text: std };
    // LAST, like the backslash retry below: running only after every exact spelling has failed, it
    // cannot change an include that resolves today. It DOES change a unit whose include was missing
    // and stubbed empty -- that header now arrives with real declarations -- which is the point.
    const byCase = caseInsensitive ? (foldBuiltin(name) ?? foldBuiltin(want)) : null;
    if (byCase) { casePaths?.add(name); return { path: `<${byCase.key}>`, text: byCase.text }; }
    return null;
  };

  return function resolver(name, angled, fromFile) {
    const from = angled ? null : fromFile;
    let hit = lookup(name, from);

    /*
     * A BACKSLASH IS A PATH SEPARATOR, on the second attempt only.
     *
     * Period Windows and DOS sources write their includes the DOS way -- 59 of them in this corpus,
     * across four programs: `#include "..\ref_soft\r_local.h"` in Quake II's Win32 layer,
     * `#include "editor\editor.h"` throughout Descent's, and `<sys\types.h>`, `<sys\stat.h>`,
     * `<SYS\STAT.H>` for headers that are standard. C99 6.4.7p3 makes a backslash in a
     * q-char-sequence UNDEFINED precisely so that an implementation may read it as a separator, and
     * a compiler targeting Windows does. PRISM compiles Windows translation units, so it does too.
     *
     * WHY A FALLBACK RATHER THAN AN OPTION. Retrying only after the literal spelling has failed
     * cannot change any translation unit that resolves today, so there is nothing for a flag to
     * protect -- and a flag would have to be set by whoever already knew the answer. No file in this
     * corpus has a backslash in its name, so there is no ambiguity for a switch to resolve either.
     *
     * The basename fallback above was written FOR this case -- its comment used to name
     * `sys\types.h` -- and could never reach it: POSIX basename() leaves a DOS path untouched, so
     * `sys\types.h` stayed one long filename and was stubbed empty. Measured, not assumed.
     */
    if (!hit && name.includes('\\')) {
      const posix = name.replace(/\\/g, '/');
      hit = lookup(posix, from);
      if (hit) dosPaths?.add(name);
    }
    if (hit) return hit;

    // Stub and record, so ONE run reports every absent header instead of dying on the first.
    // Printed by the caller, never silent.
    missing.add(name);
    return { path: `<missing:${name}>`, text: '' };
  };
}

/*
 * What the ASSEMBLY files export, in the two syntaxes this corpus uses.
 *
 *   GAS       .globl C(VGA_UpdatePlanarScreen)     — Quake's C() macro adds the leading underscore
 *   MASM/TASM PUBLIC R_DrawColumn_                 — Watcom's convention puts it at the END
 *
 * So a name is normalised by stripping the C(...) wrapper and one underscore at either end. That is
 * not a guess about naming: `PUBLIC _joystickx` and `PUBLIC I_ReadJoystick_` sit in the same file,
 * which is what Watcom's data-versus-function convention looks like.
 *
 * The point of the list is not documentation. Crossed with the symbols that are declared, called and
 * never defined, it answers the only question worth asking before writing an assembler: for THIS
 * target, how many symbols would one actually buy?
 */
const ASM_EXT = /\.(s|S|asm|ASM|inc)$/;

function scanAssembly(dir, depth = 3) {
  const out = [];
  const walk = (d, left) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const full = join(d, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (left > 0) walk(full, left - 1); continue; }
      if (!ASM_EXT.test(e) || e.endsWith('.inc')) continue;
      const text = readFileSync(full, 'latin1');
      const names = new Set();
      for (const m of text.matchAll(/^\s*\.glob(?:a)?l\s+([A-Za-z_0-9$().]+)/gm)) names.add(m[1]);
      for (const m of text.matchAll(/^\s*(?:PUBLIC|GLOBAL)\s+([A-Za-z_0-9$@?]+)/gim)) names.add(m[1]);
      if (names.size) out.push({ file: full.slice(dir.length + 1), names: [...names].map(normaliseAsmName) });
    }
  };
  walk(dir, depth);
  return out;
}

/** `C(foo)` -> foo, `_foo` -> foo, `foo_` -> foo. */
function normaliseAsmName(n) {
  let v = n.replace(/^C\((.*)\)$/, '$1');
  v = v.replace(/^_+/, '').replace(/_+$/, '');
  return v;
}

/** Load a target file and fold in one of its named variants. */
export function loadTarget(file, variant = null) {
  const target = JSON.parse(readFileSync(file, 'utf8'));
  if (!variant) return target;
  const v = target.variants?.[variant];
  if (!v) {
    const have = Object.keys(target.variants ?? {}).join(' ') || 'none';
    throw new Error(`target '${target.name}': no variant '${variant}' (have: ${have})`);
  }
  return {
    ...target, ...v,
    name: `${target.name}/${variant}`,
    /*
     * A variant usually ADDS to the base set rather than restating it: Quake's two platforms differ
     * by a dozen files out of seventy. `addUnits` keeps the shared list in one place, which is the
     * whole point of describing a build instead of writing it out.
     */
    units: v.units ?? (v.addUnits
      ? { ...target.units, list: [...(target.units?.list ?? []), ...v.addUnits] }
      : target.units),
    defines: { ...(target.defines ?? {}), ...(v.defines ?? {}) },
    unitDefines: { ...(target.unitDefines ?? {}), ...(v.unitDefines ?? {}) },
    compile: { ...(target.compile ?? {}), ...(v.compile ?? {}) },
    generated: [...(target.generated ?? []), ...(v.generated ?? [])],
    env: v.env ?? target.env,
  };
}

/** Read a target's translation units off disk, generated ones included. */
export function targetUnits(target, root) {
  const dir = resolvePath(root, target.dir);
  if (!existsSync(dir)) {
    // code PRISM_MISSING: the corpus is fetched, not shipped, so a gate reports this as SKIP.
    throw Object.assign(new Error(`target '${target.name}': source tree missing: ${dir} (see the target's "fetch" line)`), { code: 'PRISM_MISSING' });
  }
  const { names, asm } = unitNames(target, dir);
  // Zero units is a target-file mistake -- a glob pointing at the wrong directory, almost always --
  // and it used to surface as "Cannot read properties of undefined (reading 'globals')" from inside
  // the linker.
  if (!names.length) {
    throw new Error(`target '${target.name}': no translation units under ${dir} ` +
      `(units: ${JSON.stringify(target.units)})`);
  }
  const perUnit = target.unitDefines ?? {};
  const units = names.map((f) => {
    const full = join(dir, f);
    if (!existsSync(full)) throw new Error(`target '${target.name}': missing unit ${f}`);
    const over = perUnit[f.toLowerCase()];
    return { file: full, source: readFileSync(full, 'latin1'), ...(over ? { defines: over } : {}) };
  });
  /*
   * Extra MODULES: a program that is several shared objects in a real build stays several here, each
   * with its own external namespace. Quake II is three -- the engine, ref_soft, game -- and each
   * defines its own Com_Printf.
   */
  for (const [name, m] of Object.entries(target.modules ?? {})) {
    if (name.startsWith('_')) continue;
    for (const f of m.units ?? []) {
      const full = join(dir, f);
      if (!existsSync(full)) throw new Error(`target '${target.name}': module ${name} missing unit ${f}`);
      // A module's `defines` are its build's own (ET's SConscript.cgame adds CGAMEDLL to every unit).
      units.push({ file: full, source: readFileSync(full, 'latin1'), module: name, ...(m.defines ? { defines: m.defines } : {}) });
    }
  }
  for (const { name, source } of envVars(target.env)) {
    units.push({ file: `prism-${name}-vars.c`, source });
  }
  /*
   * `inline`: a declaration short enough that a separate file would hide it rather than explain it.
   * Quake's `isDedicated` is the case -- quakedef.h declares it and every real platform's sys_*.c
   * defines it, except sys_null.c, the one id ships for exactly this situation. So it falls to
   * whoever supplies the platform.
   */
  for (const [file, source] of Object.entries(target.inline ?? {})) units.push({ file, source });
  for (const g of target.generated ?? []) {
    const p = resolvePath(root, g);
    if (!existsSync(p)) throw new Error(`target '${target.name}': generated unit missing: ${p}`);
    units.push({ file: p, source: readFileSync(p, 'latin1') });
  }
  return { units, dir, asm };
}

/**
 * Build a target: compile its units, then install its environment.
 *
 * `envExtra` is how a tool passes what JSON cannot hold -- a clock function, a keyboard queue, a
 * publish callback. Merged over the target's own options, per environment name.
 */
/**
 * A target from a STATIC BUNDLE instead of from its sources (P13.1): the program is loaded from a
 * snapshot and its environment installed around it, as buildTarget does after compiling. No source
 * is read and nothing is compiled. What a bundle does not carry yet is refused by name rather than
 * skipped: translated assembly, TASM modules, shared modules.
 */
export function loadTargetBundle(target, snapshot, { envExtra = {}, shared = false } = {}) {
  for (const k of ['asmTranslate', 'tasm', 'modules']) {
    if (target[k] && Object.keys(target[k]).length) throw new Error(`a bundle of '${target.name}' would need its '${k}', which bundles do not carry yet`);
  }
  const program = loadSnapshot(snapshot, { shared });
  const env = buildEnv(program.M, target.env ?? ['stdio'], { ...envExtra, dl: { modules: {}, ...(envExtra.dl ?? {}) } });
  bindLateBuiltins(program);
  return { program, env };
}

export function buildTarget(target, { root, envExtra = {}, compile: overrides = {}, onProgram = null } = {}) {
  const { units, dir, asm } = targetUnits(target, root);
  const missing = new Set();
  const dosPaths = new Set();
  const casePaths = new Set();
  const c = { ...toolchainCompile(target.env), ...(target.compile ?? {}), ...overrides };
  // What each extra module makes visible to the main one, from the program's own .def file.
  const moduleExports = moduleExportsOf(target, dir);
  /*
   * OTHER OBJECT FILES THE BUILD LINKS, placed before the C is emitted so its externs resolve to
   * them: Turbo Assembler modules (`tasm`, see src/asm/tasm-link.js) and MakeOBJ resources
   * (`dataObjects`: a file's bytes as one object, near in DGROUP or in a far segment of its own, with
   * a public name at its start -- what static/makeobj.c's `c` and `f` modes write).
   */
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const readIn = (name) => {
    const f = names.find((x) => x.toLowerCase() === String(name).toLowerCase());
    return f ? readFileSync(join(dir, f), 'latin1') : null;
  };
  const tasm = tasmModules(target.tasm ?? [], readIn);
  const externData = [
    ...tasmExternData(tasm),
    // Relative to the source tree, or absolute: a data set may bring the headers that match it.
    ...dataObjectBlocks(target.dataObjects ?? [], (o) => {
      const name = o.object ?? o.file;
      const found = o.object ? (names.find((x) => x.toLowerCase() === name.toLowerCase()) ?? name) : name;
      return new Uint8Array(readFileSync(resolvePath(dir, found)));
    }),
  ];
  // The environments' own headers, which override the global table for the names they claim --
  // and which refuse rather than resolve when two of them claim one name differently.
  const resolve = makeResolver(dir, target, missing, dosPaths, envHeaders(target.env), casePaths);
  const options = {
    defines: target.defines ?? {},
    memory: (c.memory ?? 64) * 1024 * 1024,
    pack: c.pack ?? null,
    // The language the program was written in, which is a compiler option and not a source change:
    // `inline` is a C99 keyword, and a C89 program is free to call a variable that.
    c89: !!c.c89,
    // ...and the ABI it was compiled for. 'i386' or 'dos16'; the second parses and cannot yet be
    // emitted, which compile.js says in as many words.
    model: c.model ?? 'i386',
    // ...and whether its compiler made plain char signed. Absent means "what the model's oracle
    // measured"; see types.js makeTypes.
    signedChar: c.signedChar,
    longDouble: c.longDouble,
    // ...and the order its code evaluates a call's arguments in, which C leaves unspecified. 'rtl'
    // is Watcom's (see backend/emit.js #callArgs); absent is left to right.
    argOrder: c.argOrder,
    // ...and whether it sized enums as ints (Borland's -b) or by their constants (the model's rule).
    enums: c.enums,
    // ...and, for a compiler that could answer sizeof inside #if, the sizes it would have given.
    ppSizeof: c.ppSizeof ?? null,
    // ...and whether it let an invalid token paste through, as gcc 2.x did (src/cpp/cpp.js).
    lenientPaste: !!c.lenientPaste,
    cxx: c.cxx,
    collect: c.collect ?? true,
    safepoints: !!c.safepoints,
    /*
     * PAGED IS OPT-IN, and it stays opt-in even for a DOS program. A target asks for it by naming
     * the `vgaplanar` environment -- the one thing that needs an address to mean somewhere other
     * than itself -- or by setting compile.paged outright. MAME is DOS and does NOT want it: its
     * tweaked modes leave Chain-4 set, so its window is linear and it would pay for nothing. A
     * target that asks for neither emits, byte for byte, what it emitted before any of this.
     */
    paged: c.paged ?? (target.env ?? []).includes('vgaplanar'),
    // ...and a DEVICE WINDOW for the EGA (env `ega`): every integer access tests for A000h (emit.js).
    window: c.window ?? (target.env ?? []).includes('ega'),
    ...(c.directCalls === undefined ? {} : { directCalls: c.directCalls }),
  };
  const compileWith = (res) => compileProgram(units, {
    externData,
    exports: moduleExports,
    ...options,
    resolve: res,
    // ...and the signatures from the same environments, for the same reason: a call's result type
    // belongs to the library the program was compiled against, not to a table everyone shares.
    extraBuiltins: envBuiltins(target.env),
  });
  /*
   * THE BUILD CACHE (src/build-cache.js): what compileProgram made, kept under a key of PRISM's own
   * source, the target, its units and these options, and used again while every header the compile
   * read still reads the same. Builds that link anything a snapshot does not carry compile as before.
   */
  const cacheable = cacheEnabled() && !onProgram && !tasm.length && !externData.length && !options.paged
    && !target.asmTranslate?.length && !Object.keys(target.modules ?? {}).some((k) => !k.startsWith('_'));
  let program;
  if (cacheable) {
    const key = buildKey(target, units, options);
    const hit = loadCached(root, key, resolve);
    if (hit) {
      program = loadSnapshot({ meta: hit.meta, image: hit.image, src: hit.src });
      Object.assign(program, hit.reports, { bundled: false, cached: true });
    } else {
      const rec = recordingResolver(resolve);
      program = compileWith(rec);
      const plain = (list) => (list ?? []).map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))));
      let snap = null;
      try { snap = snapshotProgram(program); } catch { /* a build a snapshot does not record: not kept */ }
      if (snap) storeCached(root, key, snap, { failures: plain(program.failures), duplicates: plain(program.duplicates), undefined: plain(program.undefined), undefinedVars: plain(program.undefinedVars) }, rec.seen);
    }
  } else program = compileWith(resolve);
  // The one moment a static bundle can be taken: linked, and nothing installed or run yet.
  onProgram?.(program);
  /*
   * A module's SONAME is what the program asks dlopen for -- linux/Makefile.i386 builds
   * `gamei386.$(SHLIBEXT)` and sys_linux.c requests exactly that string. Passed to the `dl`
   * environment so it can answer without the target repeating itself.
   */
  const sonames = {};
  for (const [name, m] of Object.entries(target.modules ?? {})) {
    if (!name.startsWith('_') && m.soname) sonames[m.soname] = name;
  }
  const env = buildEnv(program.M, target.env ?? ['stdio'],
    { ...envExtra, dl: { modules: sonames, ...(envExtra.dl ?? {}) } });
  // Slots of environment functions whose address the program took, now that they exist.
  bindLateBuiltins(program);
  /*
   * And the same answer for a Win32 program, through the table src/env/win32-app.c already walks.
   * A no-op unless the image actually declares `prism_extra_exports`, so every other target is
   * untouched: with no modules there is no table and LoadLibrary keeps returning NULL.
   */
  const win32Exports = bindWin32Exports(program, target.modules ?? {}, moduleExports);
  /*
   * ASSEMBLY THE PROGRAM'S OWN BUILD REQUIRES. Listed in the target rather than discovered, because
   * a file being present is not a reason to translate it -- every other game here ships a C twin
   * its build selects, and P5.2 measured that an assembler buys exactly one symbol corpus-wide.
   * Jump 'n Bump is the exception: its tree defines get_block and put_block nowhere else.
   *
   * After buildEnv, because a routine that does `out` needs the port seam to exist.
   */
  const tasmBound = tasm.length ? installTasm(program, tasm) : [];
  // What the modules supplied is no longer missing: the report was made before they were bound.
  if (tasmBound.length) {
    const got = new Set(tasmBound.map((b) => b.name));
    program.undefined = program.undefined.filter((u) => !got.has(u.name));
  }
  const asmBound = target.asmTranslate?.length
    ? installAsm(program, {
      sources: target.asmTranslate.map((e) => {
        const f = typeof e === 'string' ? e : e.file;
        // A header the assembly includes and the tree lacks is an error here, not an empty stub: qasm.h
        // is where `id386` is decided, and without it the whole file preprocesses to nothing.
        const lost = new Set();
        const text = asmText(typeof e === 'string' ? e : { ...e, file: join(dir, f) }, readFileSync(join(dir, f), 'latin1'), makeResolver(dir, target, lost, new Set()));
        if (lost.size) throw new Error(`${f}: missing include(s) ${[...lost].join(', ')}`);
        return { file: f, text };
      }),
      symbols: program.globalAddrs ?? {},
      machine: program.M.machine ?? null,
    })
    : [];
  // Likewise for the translated NASM: what it supplied is no longer missing.
  if (asmBound.length) {
    const got = new Set(asmBound.map((b) => b.name));
    program.undefined = program.undefined.filter((u) => !got.has(u.name));
  }
  /*
   * The cross-reference: every assembly export, and whether the program still lacks it. A name that
   * appears here AND in program.undefined is one an assembler would buy; one that appears only here
   * is already covered -- by a C fallback the source ships, or by a generated unit.
   */
  const asmExports = scanAssembly(dir);
  const undef = new Set((program.undefined ?? []).map(u => u.name.split('$').pop()));
  const asmWanted = [];
  for (const f of asmExports) {
    for (const n of f.names) if (undef.has(n)) asmWanted.push({ name: n, file: f.file });
  }
  return {
    program, env, units, dir, asm, asmExports, asmWanted, missingHeaders: [...missing], dosPaths: [...dosPaths], casePaths: [...casePaths],
    win32Exports, asmBound, tasmBound,
  };
}
