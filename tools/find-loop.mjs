// WHICH loop is spinning?
//
// program.F wrappers are the wrong tool here: PRISM emits direct calls, so a loop that calls nothing
// the rebinder reached is invisible to them -- which is exactly why hooking GetMessage, and a dozen
// other candidates, produced nothing. Safepoints are the right one: with `safepoints` on, every loop
// back-edge decrements M.spBudget and calls M.sp_(id) when it runs out, and mod.safepoints[id] names
// the FUNCTION the loop is in. That works no matter what the loop calls, because it is inside it.
//
//   node tools/find-loop.mjs <target[:variant]> [samples] [every] [-- program args]
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const spec = process.argv[2];
if (!spec) { console.error('need a target, e.g. targets/putty.json:tel'); process.exit(2); }
const [file, variant = null] = spec.split(':');
const SAMPLES = +(process.argv[3] ?? 40);
const EVERY = +(process.argv[4] ?? 2000000);

const target = loadTarget(join(ROOT, file), variant);
target.compile = { ...(target.compile ?? {}), safepoints: true };
const { program } = buildTarget(target, { root: ROOT });

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
try { program.run([target.name, ...process.argv.slice(5)]); }
catch (e) { if (e.message !== '__sampled') err = e; }

const by = new Map();
for (const h of hits) by.set(h, (by.get(h) ?? 0) + 1);
console.log(`${hits.length} samples, one every ${EVERY.toLocaleString()} loop iterations:`);
for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log(`\nlast ten in order:\n  ${hits.slice(-10).join('\n  ')}`);
if (err) console.log(`\nstopped by: ${err.message}`);
