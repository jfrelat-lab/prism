// gates.mjs — run every tools/gate-*.mjs and say, of each, PASS, SKIP or FAIL.
//
// Three verdicts, because two kept failing to mean anything: a gate that could not run for want of
// something the repository does not ship (a corpus, game data, a container package) exits 77 through
// tools/gate-skip.mjs and is counted as SKIPPED, never as red. Before this, two gates were red on
// every run for weeks -- one wanted Quake's data, one had a real failure -- and "50 of 52" became a
// number nobody read. Now the exit status is non-zero only when a gate that ran said no.
//
//   node tools/gates.mjs [substring...]          run all, or those whose name contains one of them
//   node tools/gates.mjs --skip=lua              all but those whose name contains a --skip value
//                                                (gate-lua alone is about eight minutes of the run)
//   PRISM_QUAKE_DATA=<dir with id1/> node tools/gates.mjs     let gate-pixels run
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SKIP_CODE } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const filters = args.filter((a) => !a.startsWith('--'));
const skips = args.filter((a) => a.startsWith('--skip=')).flatMap((a) => a.slice(7).split(',')).filter(Boolean);
const gates = readdirSync(join(ROOT, 'tools'))
  .filter((f) => /^gate-.*\.mjs$/.test(f) && f !== 'gate-skip.mjs')
  .filter((f) => !filters.length || filters.some((s) => f.includes(s)))
  .filter((f) => !skips.some((s) => f.includes(s)))
  .sort();
if (skips.length) console.log(`not run, by request: every gate matching ${skips.join(', ')}\n`);

const rows = [];
for (const g of gates) {
  const t = Date.now();
  const r = spawnSync('node', [join(ROOT, 'tools', g)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const secs = ((Date.now() - t) / 1000).toFixed(0);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n');
  const verdict = r.status === 0 ? 'PASS' : r.status === SKIP_CODE ? 'SKIP' : 'FAIL';
  const line = verdict === 'SKIP' ? (out.find((l) => l.startsWith('SKIP:')) ?? '').slice(6) : out.at(-1) ?? '';
  rows.push({ g, verdict, secs, line });
  console.log(`${verdict} ${g.padEnd(30)} ${secs.padStart(4)}s  ${line.slice(0, 96)}`);
}
const n = (v) => rows.filter((r) => r.verdict === v).length;
console.log(`\n${rows.length} gates: ${n('PASS')} pass, ${n('SKIP')} skipped, ${n('FAIL')} FAILED`);
for (const r of rows.filter((x) => x.verdict === 'FAIL')) console.log(`  FAILED ${r.g}`);
process.exit(n('FAIL') ? 1 : 0);
