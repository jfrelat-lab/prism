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
import { join, basename, dirname, resolve as resolvePath } from 'node:path';
import { compileProgram } from './compile.js';
import { HEADERS } from './env/headers.js';
import { buildEnv, envVars } from './env/registry.js';

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
 * @property {object=} unitDefines  per-unit overrides, keyed by lower-case basename. Heretic's
 *                                  R_DRAW.C is the whole reason this exists: its C rendering loops
 *                                  live behind `#ifndef __WATCOMC__`, and nothing else in the
 *                                  program may have that macro undefined.
 * @property {object=} compile    { memory, pack, collect, safepoints, directCalls }.
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
function makeResolver(dir, { caseInsensitive = false, include = null } = {}, missing) {
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
  return function resolver(name, angled, fromFile) {
    const want = basename(name);
    const from = angled ? null : fromFile;
    /*
     * Order matters, and OpenDUNE is what proved it.
     *
     * The path as WRITTEN comes first -- `Z80/Z80.h` is a real relative path, and a quoted include
     * resolves against the including file before anything else. Then the STANDARD header by its full
     * name, and only after that the basename fallback, which exists for DOS trees that write
     * `sys\types.h`.
     *
     * Letting the basename fallback run before the standard table means `<sys/types.h>` reduces to
     * `types.h` and finds OpenDUNE's `include/types.h`, so `ssize_t` never gets declared and PRISM's
     * own unistd.h fails to parse. A header in the tree may shadow a standard one when the program
     * asks for it BY THAT NAME, never by accident of its basename.
     */
    const path = find(name, from);
    if (path) return { path, text: readFileSync(path, 'latin1') };
    if (HEADERS[name] !== undefined) return { path: `<${name}>`, text: HEADERS[name] };
    const loose = find(want, from);
    if (loose) return { path: loose, text: readFileSync(loose, 'latin1') };
    const std = HEADERS[want];
    if (std !== undefined) return { path: `<${name}>`, text: std };
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
  if (!existsSync(dir)) throw new Error(`target '${target.name}': source tree missing: ${dir}`);
  const { names, asm } = unitNames(target, dir);
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
      units.push({ file: full, source: readFileSync(full, 'latin1'), module: name });
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
export function buildTarget(target, { root, envExtra = {}, compile: overrides = {} } = {}) {
  const { units, dir, asm } = targetUnits(target, root);
  const missing = new Set();
  const c = { ...(target.compile ?? {}), ...overrides };
  // What each extra module makes visible to the main one, from the program's own .def file.
  const moduleExports = {};
  for (const [name, m] of Object.entries(target.modules ?? {})) {
    if (name.startsWith('_')) continue;
    moduleExports[name] = m.exportsFrom
      ? exportsFromDef(resolvePath(dir, m.exportsFrom))
      : (m.exports ?? []);
  }
  const program = compileProgram(units, {
    exports: moduleExports,
    defines: target.defines ?? {},
    resolve: makeResolver(dir, target, missing),
    memory: (c.memory ?? 64) * 1024 * 1024,
    pack: c.pack ?? null,
    collect: c.collect ?? true,
    safepoints: !!c.safepoints,
    ...(c.directCalls === undefined ? {} : { directCalls: c.directCalls }),
  });
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
    program, env, units, dir, asm, asmExports, asmWanted, missingHeaders: [...missing],
  };
}
