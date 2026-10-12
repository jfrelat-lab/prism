// gates.mjs — run every tools/gate-*.mjs and say, of each, PASS, SKIP or FAIL.
//
// Three verdicts, because two kept failing to mean anything: a gate that could not run for want of
// something the repository does not ship (a corpus, game data, a container package) exits 77 through
// tools/gate-skip.mjs and is counted as SKIPPED, never as red. Before this, two gates were red on
// every run for weeks -- one wanted Quake's data, one had a real failure -- and "50 of 52" became a
// number nobody read. Now the exit status is non-zero only when a gate that ran said no.
//
//   node tools/gates.mjs [substring...]          run all, or those whose name contains one of them
//   node tools/gates.mjs --jobs=6                six gates at a time (default: half the cores, at most 6)
//   node tools/gates.mjs --skip=lua              all but those whose name contains a --skip value
//                                                (gate-lua alone is about eight minutes of the run)
//   PRISM_QUAKE_DATA=<dir with id1/> node tools/gates.mjs     let gate-pixels run
//   PRISM_QUAKE3_DATA=<dir with baseq3/> ...                  add Quake III to gate-webgl-stream
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
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

/*
 * IN PARALLEL. The gates are independent processes: each writes its own names in the oracle's
 * shared directory (compileRun names its files by pid), so several run at once. Two things are
 * scheduled rather than left to chance:
 *
 *   the LONGEST FIRST, by the durations the last run recorded (dist/gate-times.json): the run cannot
 *   end before its longest gate does, so that one has to start at once, not last;
 *   the MAME gates ONE AT A TIME: each builds a program of 12,000-23,000 functions in a heap of up
 *   to 12 GB, and two of them together are what this machine's memory would not hold.
 *
 * Results print as gates finish; the summary is in name order.
 */
const TIMES = join(ROOT, 'dist/gate-times.json');
let times = {};
try { times = JSON.parse(readFileSync(TIMES, 'utf8')); } catch { /* first run: name order */ }
const jobsArg = args.find((a) => a.startsWith('--jobs='));
const JOBS = Math.max(1, jobsArg ? +jobsArg.slice(7) : Math.min(6, Math.floor(cpus().length / 2)));
const HEAVY = (g) => /^gate-mame/.test(g);
/*
 * PROGRESS (--progress, and always with --jobs=1): each gate announces itself with how long it took
 * last time and how much is left, and its own `ok` / `FAIL` lines are shown as they come rather than
 * after it ends -- a long run that can be watched, and stopped knowing where it was.
 */
const PROGRESS = args.includes('--progress') || JOBS === 1;
let started = 0, leftSecs = gates.reduce((t, g) => t + (times[g] ?? 60), 0);
const mmss = (secs) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}`;
const queue = [...gates].sort((x, y) => (times[y] ?? 0) - (times[x] ?? 0));
const rows = [];
const t0 = Date.now();
let running = 0, heavyRunning = 0;
await new Promise((resolve) => {
  const next = () => {
    if (!queue.length && !running) { resolve(); return; }
    while (running < JOBS && queue.length) {
      const i = queue.findIndex((g) => !HEAVY(g) || !heavyRunning);
      if (i < 0) break;
      const [g] = queue.splice(i, 1);
      running++; if (HEAVY(g)) heavyRunning++;
      const t = Date.now();
      let out = '';
      if (PROGRESS) {
        started++;
        console.log(`> [${started}/${gates.length}] ${g}  (last ${times[g] ? mmss(times[g]) : '?'}, about ${mmss(leftSecs)} left)`);
        leftSecs -= times[g] ?? 60;
      }
      const child = spawn('node', [join(ROOT, 'tools', g)], { cwd: ROOT });
      let pending = '';
      const show = (d) => {
        if (!PROGRESS) return;
        pending += d;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const l of lines) if (/^(ok|FAIL)\b/.test(l.trim()) || /^ {5,}\S/.test(l)) console.log(`    ${l.trim().slice(0, 140)}`);
      };
      child.stdout.on('data', (d) => { out += d; show(d); });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (status) => {
        running--; if (HEAVY(g)) heavyRunning--;
        const secs = (Date.now() - t) / 1000;
        const lines = out.trim().split('\n');
        const verdict = status === 0 ? 'PASS' : status === SKIP_CODE ? 'SKIP' : 'FAIL';
        const line = verdict === 'SKIP' ? (lines.find((l) => l.startsWith('SKIP:')) ?? '').slice(6) : lines.at(-1) ?? '';
        rows.push({ g, verdict, secs, line });
        if (verdict !== 'SKIP') times[g] = Math.round(secs);
        console.log(`${verdict} ${g.padEnd(30)} ${secs.toFixed(0).padStart(4)}s  ${line.length > 96 ? `${line.slice(0, 95)}…` : line}`);
        next();
      });
    }
  };
  next();
});
rows.sort((x, y) => x.g.localeCompare(y.g));
mkdirSync(dirname(TIMES), { recursive: true });
writeFileSync(TIMES, JSON.stringify(times, null, 1) + '\n');
const busy = rows.reduce((t, r) => t + r.secs, 0);
console.log(`\n${JOBS} at a time: ${((Date.now() - t0) / 1000).toFixed(0)} s for ${busy.toFixed(0)} s of gates`);
const n = (v) => rows.filter((r) => r.verdict === v).length;
console.log(`\n${rows.length} gates: ${n('PASS')} pass, ${n('SKIP')} skipped, ${n('FAIL')} FAILED`);
for (const r of rows.filter((x) => x.verdict === 'FAIL')) console.log(`  FAILED ${r.g}`);
process.exit(n('FAIL') ? 1 : 0);
