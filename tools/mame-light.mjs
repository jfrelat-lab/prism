// mame-light.mjs — MAME 0.34 built for ONE of the makefile's archives instead of all sixty-two.
//
// The release's makefile already cuts the drivers into libraries -- obj/pacman.a, obj/midw8080.a,
// obj/capcom.a ... -- and links every one of them because src/driver.c names every game. A light
// build keeps the makefile's OBJS (the core, the CPU cores, the sound chips, the DOS layer), takes
// the ONE archive that holds the game asked for, and replaces src/driver.c by a table that lists
// that archive's games, in driver.c's own order. Replacing a unit is what the platform layer
// already is, and what MAME's own later tiny.mak does; no source is edited.
//
// An archive is not always closed: a driver may use a routine that lives in another library. The
// whole build resolves that through the linker, so this does the same -- it builds, reads what was
// left unresolved, and adds the archives that define those names until nothing is missing.
//
//   node tools/mame-light.mjs --game=invaders            what it is made of, and what it costs
//   node tools/mame-light.mjs --list                     the archives and how many games each holds
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPUS = join(ROOT, 'corpus', 'mame034');
const SELF = fileURLToPath(import.meta.url);
export const FULL = JSON.parse(readFileSync(join(ROOT, 'targets', 'mame034.json'), 'utf8'));

/** Source text less what the compiler never sees: comments, and blocks parked under `#if 0`. */
const visible = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')
  .replace(/^[ \t]*#[ \t]*if[ \t]+0\b[\s\S]*?^[ \t]*#[ \t]*endif/gm, ' ');

// ---- the makefile's archives, as source units spelled the way the disk spells them
const disk = new Map();
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p); else disk.set(relative(CORPUS, p).toLowerCase(), relative(CORPUS, p));
  }
})(join(CORPUS, 'src'));
const unitOf = (obj) => disk.get(`src/${obj.replace(/^obj\//, '').replace(/\.o$/, '')}.c`.toLowerCase()) ?? null;
const mk = readFileSync(join(CORPUS, 'makefile'), 'latin1').replace(/\r/g, '').replace(/\\\n/g, ' ');
/** archive name ("midw8080") -> its units */
export const ARCHIVES = new Map([...mk.matchAll(/^obj\/(\w+)\.a:\s*(.*)$/gm)]
  .map((m) => [m[1], m[2].split(/\s+/).filter(Boolean).map(unitOf).filter(Boolean)]));
const archived = new Set([...ARCHIVES.values()].flat());
/** Everything in the full build that belongs to no archive: OBJS and the DOS layer. */
export const CORE = FULL.units.list.filter((u) => !archived.has(u) && u.toLowerCase() !== 'src/driver.c');

// ---- which games a unit defines, and the order src/driver.c lists them in
const driverC = visible(readFileSync(join(CORPUS, 'src', 'driver.c'), 'latin1'));
const LISTED = [...driverC.slice(driverC.indexOf('drivers[]')).matchAll(/&\s*(\w+)\s*,/g)].map((m) => m[1]);
const structsIn = (unit) => {
  const text = visible(readFileSync(join(CORPUS, unit), 'latin1'));
  return [...text.matchAll(/struct\s+GameDriver\s+(\w+)\s*=\s*\{\s*__FILE__\s*,\s*(?:&\s*\w+|0)\s*,\s*"([^"]+)"/g)]
    .map((m) => ({ struct: m[1], game: m[2] }));
};
const byArchive = new Map([...ARCHIVES].map(([name, units]) =>
  [name, units.filter((u) => /\/drivers\//i.test(u)).flatMap(structsIn).filter((s) => LISTED.includes(s.struct))]));
/** The games of an archive, by name, in driver.c's order. */
export const gamesOf = (archive) => (byArchive.get(archive) ?? []).map((s) => s.game);
/** The archive that holds a game, by the game's own name ("invaders"). */
export const archiveOf = (game) => [...byArchive].find(([, s]) => s.some((x) => x.game === game))?.[0] ?? null;

/*
 * THE CPU CORES, which are where the weight is: measured on the midw8080 build, the thirteen cores
 * are 9.9 MB of 12.4 MB of emitted JavaScript, and src/cpuintrf.c names every one of them in its
 * table whatever the game. So a light build also leaves out the cores no linked driver asks for.
 * Which ones a driver asks for is in its own MachineDriver, as CPU_* constants; src/driver.h gives
 * each a number (and aliases: CPU_8080 is CPU_8085A), and the number names the directory.
 *
 * The table rows of a core left out stay unresolved, which PRISM binds lazily: calling one throws
 * and says its name. Nothing calls them -- cpuintrf.c indexes its table by the machine's own CPU
 * types -- and the light build is held to the same frames as the whole one to prove it.
 */
const CORE_DIR = { 1: 'Z80', 2: 'I8085', 3: 'M6502', 4: 'I86', 5: 'I8039', 6: 'M6808', 7: 'M6805', 8: 'M6809',
  9: 'M68000', 10: 'T11', 11: 'S2650', 12: 'TMS34010', 13: 'TMS9900' };
const cpuNumber = (() => {
  const text = visible(readFileSync(join(CORPUS, 'src', 'driver.h'), 'latin1'));
  const raw = new Map([...text.matchAll(/^[ \t]*#[ \t]*define[ \t]+(CPU_\w+)[ \t]+(\w+)/gm)].map((m) => [m[1], m[2]]));
  return (name) => { let v = raw.get(name); while (v && raw.has(v)) v = raw.get(v); return /^\d+$/.test(v ?? '') ? +v : null; };
})();
const coreDirOf = (u) => { const d = /^src\/([^/]+)\//.exec(u)?.[1]; return Object.values(CORE_DIR).includes(d) ? d : null; };
/** The CPU core directories the drivers of these archives name. */
export function coresOf(archives) {
  const dirs = new Set();
  for (const u of archives.flatMap((a) => ARCHIVES.get(a))) {
    for (const m of visible(readFileSync(join(CORPUS, u), 'latin1')).matchAll(/\bCPU_\w+/g)) {
      const n = cpuNumber(m[0]);
      if (n !== null && n >= 1 && n <= 13) dirs.add(CORE_DIR[n]);
    }
  }
  return dirs;
}

/** The target of a light build over these archives: the full one with fewer units and its own table. */
export function lightTarget(archives, { allCores = false, extraCores = [] } = {}) {
  const cores = new Set([...coresOf(archives), ...extraCores]);
  const core = CORE.filter((u) => allCores || !coreDirOf(u) || cores.has(coreDirOf(u)));
  const structs = new Set(archives.flatMap((a) => byArchive.get(a).map((s) => s.struct)));
  const listed = LISTED.filter((s) => structs.has(s));
  const table = [
    '/* src/driver.c, for a build that links only some of the makefile\'s archives: the same table, in the',
    `   same order, less the games whose drivers are not linked. Archives: ${archives.join(', ')}. */`,
    '#include "driver.h"',
    ...listed.map((s) => `extern struct GameDriver ${s};`),
    'const struct GameDriver *drivers[] =', '{',
    ...listed.map((s) => `\t&${s},`),
    '\t0', '};', '',
    /*
     * The one driver the CORE names: usrintrf.c, cheat.c and fronthlp.c compare a game's clone_of
     * with &neogeo_bios. Without the Neo Geo archive that name must still be an object of its own
     * -- left unresolved its address is 0, and every game that is nobody's clone would pass for a
     * Neo Geo game. Pulling the archive in for a pointer comparison costs the 68000 core.
     */
    ...(archives.includes('neogeo') ? [] : [
      '/* Not linked here. Its address is all the core asks of it (clone_of == &neogeo_bios). */',
      'struct GameDriver neogeo_bios;', '']),
  ].join('\n');
  return {
    ...FULL,
    name: `mame034-${archives[0]}`,
    units: { list: [...core, ...archives.flatMap((a) => ARCHIVES.get(a))] },
    inline: { ...(FULL.inline ?? {}), 'prism-driver-table.c': table },
    games: listed.length,
    cores: [...cores],
    // What the cores left out define: unresolved by design, and not a reason to pull an archive.
    droppedCoreUnits: CORE.filter((u) => !core.includes(u)),
  };
}

/*
 * WHERE A NAME IS DEFINED, read once per unit: a function with a body, or an object at file scope.
 * A prototype ends in `;` and defines nothing -- 8080bw.c DECLARES astinvad_videoram_w, z80bw.c has
 * it. Only what another unit can link to counts: a definition that starts in column 0 and is not
 * `static`. Without that rule a file-static called `bitmap` in one archive answered for an extern
 * of the same name in another, and Namco's build came out with Capcom Bowling and a PDP-11 in it.
 */
const sources = new Map();
const sourceOf = (u) => sources.get(u) ?? sources.set(u, visible(readFileSync(join(CORPUS, u), 'latin1')).replace(/^\s*extern\b.*$/gm, '')).get(u);
const defined = new Map();
const definedIn = (u) => {
  if (defined.has(u)) return defined.get(u);
  const text = sourceOf(u), names = new Set();
  for (const m of text.matchAll(/^(?!static\b|typedef\b)(?:[A-Za-z_][\w \t\*]*?[ \t\*])?([A-Za-z_]\w*)[ \t]*\([^;{}]*\)\s*\{/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^(?!static\b|typedef\b)[A-Za-z_][\w \t\*]*?[ \t\*]([A-Za-z_]\w*)[ \t]*(?:\[[^\]]*\][ \t]*)*(?:=|;)/gm)) names.add(m[1]);
  defined.set(u, names);
  return names;
};
const definingArchive = (name) => [...ARCHIVES].find(([, units]) => units.some((u) => definedIn(u).has(name)))?.[0] ?? null;
/** ...and among core units a build left out: the CPU core directory that defines it, or null. */
const definingCore = (name, units) => coreDirOf(units.find((u) => definedIn(u).has(name)) ?? '') ?? null;
/** Every identifier a unit mentions. */
const mentioned = new Map();
const mentions = (u) => mentioned.get(u) ?? mentioned.set(u, new Set(sourceOf(u).match(/[A-Za-z_]\w*/g) ?? [])).get(u);

/**
 * Build the light target for a game, adding archives until the link is closed.
 * Returns { target, archives, program, build: the buildTarget result, seconds }.
 */
export async function buildLight(game, { envExtra = {}, compile = {}, allCores = false, mutate = (t) => t } = {}) {
  const { buildTarget } = await import('../src/target.js');
  const first = archiveOf(game);
  if (!first) throw new Error(`no archive of the makefile holds a game called '${game}'`);
  const archives = [first], extraCores = [];
  for (;;) {
    const target = lightTarget(archives, { allCores, extraCores });
    const t0 = Date.now();
    const build = buildTarget(mutate(target), { root: ROOT, envExtra, compile });
    /*
     * Everything left unresolved, three ways: functions that are called, objects that are read,
     * and functions whose ADDRESS is taken and nothing more -- a memory map's handler, which the
     * compiler's two lists do not hold because no call names it. Exterminator's map does exactly
     * that with a routine from another archive, and found it at run time.
     */
    const p = build.program;
    const missing = [...new Set([
      ...(p.undefined ?? []).map((u) => u.name), ...(p.undefinedVars ?? []).map((u) => u.name),
      ...[...p.mod.funcs.values()].filter((f) => !f.fn).map((f) => f.name),
    ])];
    /*
     * Only what a LINKED DRIVER asks for pulls another archive in. The core reaches into drivers
     * too -- usrintrf.c calls NeoMVSDrawGfx, when the running game is a Neo Geo one -- and following
     * that would put the Neo Geo archive and the 68000 in every build. Those stay unresolved, as the
     * rows of the cores left out do: bound lazily, a call says its name.
     */
    const linked = archives.flatMap((a) => ARCHIVES.get(a)).map(mentions);
    const asked = missing.filter((n) => linked.some((set) => set.has(n)));
    const more = [...new Set(asked.map(definingArchive).filter((a) => a && !archives.includes(a)))];
    // A driver may also call a CPU core it does not list in its MachineDriver (Z80_GetRegs from a
    // machine/ file): then the core comes back too.
    const cores = [...new Set(asked.map((n) => definingCore(n, target.droppedCoreUnits)).filter(Boolean))];
    if (!more.length && !cores.length) {
      // What is left of `asked` is defined in no unit of the release at all -- the whole build
      // leaves it unresolved too (a sound routine a table still names) -- so it is not this cut's.
      return { target, archives, program: build.program, build, seconds: (Date.now() - t0) / 1000,
        notLinked: missing.filter((n) => !asked.includes(n)), nowhere: asked };
    }
    archives.push(...more);
    extraCores.push(...cores);
  }
}

/*
 * THE CLOSURES, written down: targets/mame034-light.json. Closing an archive's links takes a build
 * (two, when it pulls another archive in), and a page that is about to start a game should not make
 * one to find out what to compile. `--write` closes all sixty-two once and records, per archive,
 * the archives and CPU cores its build is made of; `lightFor` then answers from the file.
 */
export const CLOSURES = join(ROOT, 'targets', 'mame034-light.json');
let closures = null;
/** The light target for a game, from the recorded closures; null when the game or the file is unknown. */
export function lightFor(game) {
  closures ??= existsSync(CLOSURES) ? JSON.parse(readFileSync(CLOSURES, 'utf8')) : { archives: {} };
  const c = closures.archives[archiveOf(game) ?? ''];
  if (!c) return null;
  const t = lightTarget(c.archives, { extraCores: c.cores });
  return { ...t, lightOf: { archives: c.archives, cores: t.cores, games: t.games, units: t.units.list.length, of: FULL.units.list.length } };
}

if (process.argv[1] === SELF) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  if (process.argv.includes('--write')) {
    const { writeFileSync } = await import('node:fs');
    const out = { _doc: [
      'MAME 0.34, one light build per archive of its makefile (tools/mame-light.mjs --write): the archives a',
      'build needs for its links to close, the CPU cores its drivers use, and what it weighs. Written from',
      'builds, not by hand. `js` is megabytes of emitted JavaScript; the whole build is 19.2.',
    ], archives: {} };
    for (const [a, structs] of byArchive) {
      if (!structs.length) continue;                       // no listed game: nothing to start
      const r = await buildLight(structs[0].game);
      out.archives[a] = { archives: r.archives, cores: r.target.cores, games: r.target.games,
        units: r.target.units.list.length, js: +(r.program.src.length / 1e6).toFixed(2) };
      console.log(`${a.padEnd(10)} ${String(r.target.units.list.length).padStart(3)} units ${out.archives[a].js.toFixed(2).padStart(6)} MB  ${r.target.cores.join(' ')}${r.archives.length > 1 ? `  (+ ${r.archives.slice(1).join(' ')})` : ''}`);
    }
    writeFileSync(CLOSURES, `${JSON.stringify(out, null, 1)}\n`);
    const js = Object.values(out.archives).map((x) => x.js).sort((x, y) => x - y);
    console.log(`\n${js.length} archives in ${CLOSURES}: ${js[0]} to ${js.at(-1)} MB, median ${js[js.length >> 1]}`);
    process.exit(0);
  }
  if (process.argv.includes('--list')) {
    for (const [a, units] of ARCHIVES) console.log(`${a.padEnd(10)} ${String(units.length).padStart(3)} units  ${String(byArchive.get(a).length).padStart(3)} games`);
    console.log(`\ncore: ${CORE.length} units; ${ARCHIVES.size} archives, ${archived.size} units; ${LISTED.length} games listed in src/driver.c`);
    process.exit(0);
  }
  const game = arg('game');
  if (!game || !existsSync(CORPUS)) { console.error('usage: node tools/mame-light.mjs --game=<name> | --list'); process.exit(2); }
  const r = await buildLight(game);
  const full = FULL.units.list.length;
  console.log(`${game}: archive${r.archives.length > 1 ? 's' : ''} ${r.archives.join(' + ')} -- ${r.target.games} games`);
  console.log(`  CPU cores   ${r.target.cores.join(' ')}  (of 13)`);
  console.log(`  units       ${r.target.units.list.length} of ${full}`);
  console.log(`  functions   ${Object.keys(r.program.F).length}`);
  console.log(`  JavaScript  ${(r.program.src.length / 1e6).toFixed(2)} MB`);
  console.log(`  compiled in ${r.seconds.toFixed(1)} s`);
  console.log('  unresolved  nothing a linked driver asks for that some unit of the release defines');
  console.log(`              (${r.nowhere.length} names the drivers mention are defined nowhere in the release; ${r.notLinked.length} more only the core mentions)`);
}
