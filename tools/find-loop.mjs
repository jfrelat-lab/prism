// WHICH loop is spinning?
//
// program.F wrappers are the wrong tool here: PRISM emits direct calls, so a loop that calls nothing
// the rebinder reached is invisible to them -- which is exactly why hooking GetMessage, and a dozen
// other candidates, produced nothing. Safepoints are the right one: with `safepoints` on, every loop
// back-edge decrements M.spBudget and calls M.sp_(id) when it runs out, and mod.safepoints[id] names
// the FUNCTION the loop is in. That works no matter what the loop calls, because it is inside it.
//
//   node tools/find-loop.mjs <target[:variant]> [samples] [every] [--data=<dir>] [program args...]
//
// --data matters more than it looks: a game that cannot find its own files never reaches the loop
// you are trying to name. Quake stops at "couldn't load gfx.wad" and every sample lands in its
// error path, which is a true answer to the wrong question.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const spec = process.argv[2];
if (!spec) { console.error('need a target, e.g. targets/putty.json:tel'); process.exit(2); }
const [file, variant = null] = spec.split(':');
const rest = process.argv.slice(3).filter(a => !a.startsWith('--data='));
const SAMPLES = +(rest[0] ?? 40);
const EVERY = +(rest[1] ?? 2000000);
const args = rest.slice(2).filter(a => a !== '--');

const dataArg = process.argv.find(a => a.startsWith('--data='))?.slice(7);
const files = {};
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

const target = loadTarget(join(ROOT, file), variant);
target.compile = { ...(target.compile ?? {}), safepoints: true };
const { program } = buildTarget(target, {
  root: ROOT,
  envExtra: { stdio: { files }, pit: { micros: () => performance.now() * 1000 } },
});

const M = program.M;
const names = program.mod.safepoints;
const hits = [];
let n = 0;
M.spBudget = EVERY;
M.sp_ = (id) => {
  hits.push(names[id] ?? `#${id}`);
  if (++n >= SAMPLES) throw new Error('__sampled');
  M.spBudget = EVERY;
};

let err = null;
try { program.run([target.name, ...args]); }
catch (e) { if (e.message !== '__sampled') err = e; }

const by = new Map();
for (const h of hits) by.set(h, (by.get(h) ?? 0) + 1);
console.log(`${hits.length} samples, one every ${EVERY.toLocaleString()} loop iterations:`);
for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log(`\nlast ten in order:\n  ${hits.slice(-10).join('\n  ')}`);
if (err) console.log(`\nstopped by: ${err.message}`);
