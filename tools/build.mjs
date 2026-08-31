// build.mjs — build any target in targets/, from its JSON alone.
//
//   node tools/build.mjs targets/quake.json                       # compile only, report
//   node tools/build.mjs targets/quake.json:null                  # a named variant
//   node tools/build.mjs targets/heretic.json --run --data=<dir>
//   node tools/build.mjs --list
//
// This replaces the BUILD half of quake.mjs, raven.mjs, mame.mjs and doomsnd.mjs: four hand-written
// copies of the same six decisions. What it does not replace is the other half of those tools --
// each program's own instrumentation. Quake's frame cap and key script, Doom's fire trigger, the
// audio drain: those wrap the program's functions to watch it run, and a JSON file describing them
// would be game logic in a config file.
//
// So the honest split is: every target COMPILES here, and a target with nothing program-specific to
// do also RUNS here. The rest keep their tool, which now calls buildTarget() instead of restating
// the build.

import { readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGETS = join(ROOT, 'targets');
const argv = process.argv.slice(2);
const opt = (n, d = null) => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const flag = (n) => argv.includes(`--${n}`);

if (flag('list') || argv.length === 0) {
  console.log('targets:');
  for (const f of readdirSync(TARGETS).filter(f => f.endsWith('.json')).sort()) {
    const t = JSON.parse(readFileSync(join(TARGETS, f), 'utf8'));
    const vs = Object.keys(t.variants ?? {}).filter(k => !k.startsWith('_'));
    const have = existsSync(join(ROOT, t.dir)) ? '' : '  (source tree absent)';
    console.log(`  targets/${f.padEnd(16)} ${t.title ?? t.name}${vs.length ? `  [${vs.join(' ')}]` : ''}${have}`);
  }
  process.exit(0);
}

// `path.json:variant` -- one argument, because the variant is part of naming the target.
const [file, variant] = argv[0].split(':');
let target;
try {
  target = loadTarget(file.includes('/') ? join(ROOT, file) : join(TARGETS, file), variant ?? null);
  if (!variant && target.default) target = loadTarget(join(ROOT, file), target.default);
} catch (e) {
  console.error(String(e.message));
  process.exit(2);
}

if (!existsSync(join(ROOT, target.dir))) {
  console.error(`source tree absent: ${target.dir}`);
  if (target.fetch) console.error(`fetch it with:\n  ${target.fetch}`);
  process.exit(2);
}

/*
 * The data directory, read from a directory the USER names and nowhere else. No tool here fetches
 * game data, and none of it enters the repository.
 */
const files = {};
const dataArg = opt('data');
if (dataArg) {
  const walk = (d, prefix = '') => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${e}/`);
      else files[`${prefix}${e}`] = new Uint8Array(readFileSync(full));
    }
  };
  walk(dataArg);
}

const t0 = performance.now();
let built;
try {
  built = buildTarget(target, {
    root: ROOT,
    compile: { safepoints: flag('safepoints'), ...(opt('memory') ? { memory: +opt('memory') } : {}) },
    envExtra: {
      stdio: { files },
      // A real clock, because a program that times itself with a fake one measures fiction.
      pit: { micros: () => performance.now() * 1000 },
    },
  });
} catch (e) {
  console.error(`${target.name}: ${e.message}`);
  process.exit(1);
}
const { program, env, units, asm, missingHeaders, asmExports, asmWanted } = built;
const secs = ((performance.now() - t0) / 1000).toFixed(1);

const loc = units.reduce((n, u) => n + u.source.split('\n').length, 0);
console.log(`${target.title ?? target.name} — ${units.length} translation units, ` +
  `${loc.toLocaleString('en')} lines, ${Object.keys(program.F).length} functions in ${secs} s`);
if (asm?.length) console.log(`  ${asm.length} assembly objects skipped: ${asm.join(' ')}`);
if (missingHeaders.length) console.log(`  headers stubbed: ${missingHeaders.join(' ')}`);
/*
 * A duplicate external definition is not a warning to skim past: every emitted function shares one
 * JavaScript scope, so the last one wins and calls emitted BEFORE it also go to it.
 */
if (program.duplicates?.length) {
  console.log(`  ${program.duplicates.length} duplicate external definitions -- the LAST one wins ` +
    `for the whole program:`);
  for (const d of program.duplicates) console.log(`    ${d.name}  (redefined in ${d.unit})`);
}
/*
 * Undefined symbols, which a linker names and this used to swallow. They compile; they fail when
 * called. Nearly always they are what an ASSEMBLY file was providing, so the list beside the skipped
 * .asm objects above is the whole answer to "what does this build still need?".
 */
if (program.undefined?.length) {
  console.log(`  ${program.undefined.length} symbols declared and called but NEVER DEFINED ` +
    `(they fail when called):`);
  for (const u of program.undefined.slice(0, 20)) {
    console.log(`    ${u.name.padEnd(32)} called from ${u.units.join(' ')}`);
  }
  if (program.undefined.length > 20) console.log(`    … and ${program.undefined.length - 20} more`);
}
if (program.failures?.length) {
  const by = new Map();
  for (const f of program.failures) by.set(f.message, (by.get(f.message) ?? 0) + 1);
  console.log(`  ${program.failures.length} functions could not be emitted (they throw IF CALLED):`);
  for (const [m, n] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(n).padStart(4)}  ${m}`);
  }
}
/*
 * What compiling the assembly would actually buy HERE. The interesting number is not how many
 * symbols the .s files export -- most are covered by a C fallback the source itself ships, which is
 * the whole point of id386=0 and `#ifndef __WATCOMC__` -- but how many are still missing.
 */
if (asmExports?.length) {
  const total = asmExports.reduce((n, f) => n + f.names.length, 0);
  console.log(`  assembly: ${asmExports.length} files export ${total} symbols; ` +
    `${asmWanted.length} of them are still undefined here` +
    (asmWanted.length ? ':' : ' — an assembler would buy nothing for this target.'));
  for (const w of asmWanted.slice(0, 12)) console.log(`    ${w.name.padEnd(28)} ${w.file}`);
}
console.log(`  environment: ${Object.keys(env).filter(k => k !== 'machine').join(' ')}`);
console.log(`  data: ${Object.keys(files).length} files from ${dataArg ?? '(none given)'}`);

const dumpTo = opt('dump');
if (dumpTo) { writeFileSync(dumpTo, program.src); console.log(`  wrote ${dumpTo} (${(program.src.length / 1e6).toFixed(1)} MB of JavaScript)`); }

if (!flag('run')) process.exit(0);

/*
 * Running with no instrumentation at all: the program gets its argv and goes. A program that never
 * returns needs a tool that knows where to interrupt it -- which is exactly the program-specific
 * half that stays in tools/.
 */
const args = (opt('args') ?? '').split(/\s+/).filter(Boolean);
console.log(`\nrunning: ${target.name} ${args.join(' ')}`);
/*
 * What the program SAYS. Its stdout goes into an in-memory buffer -- the page reads it there -- so a
 * console run showed nothing at all, which for a program whose whole output is text reads as a
 * program that did nothing.
 */
const write = program.M.write.bind(program.M);
program.M.write = (str) => { process.stdout.write(str); write(str); };
try {
  program.run([target.name, ...args]);
} catch (e) {
  console.log(`exited: ${e.message}`);
}
