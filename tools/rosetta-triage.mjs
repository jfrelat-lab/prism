// rosetta-triage.mjs — why a Rosetta Code program prints something else under PRISM than under cc.
//
//   node tools/rosetta-triage.mjs              the self-contained blocks tools/rosetta.mjs found differing
//   node tools/rosetta-triage.mjs --show=<task>   the two outputs of one task's blocks, line by line
//
// Each block is run again on both sides, in .oracle/rosetta/run/, and the native build TWICE: a program
// whose own two runs differ (a seed from the clock, a pointer printed, a timing) says nothing about
// the compiler, and that is decided by running it, not by guessing from its source. The rest is
// sorted by the shape of the difference, cheapest explanation first, and written to
// dist/rosetta/triage.json with both outputs in .oracle/rosetta/diff/ (Rosetta's output is
// Rosetta's code's, so it stays out of the repository like the code).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE = join(ROOT, '.oracle', 'rosetta');
const RUN = join(CACHE, 'run'), DIFF = join(CACHE, 'diff');
mkdirSync(RUN, { recursive: true }); mkdirSync(DIFF, { recursive: true });
const flag = (n) => process.argv.includes(`--${n}`);
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const slug = (t) => t.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) + '-' + createHash('sha1').update(t).digest('hex').slice(0, 8);

// As in tools/rosetta.mjs: PRISM's JSON is read as UTF-8, a native program runs as `prog`.
function child(cmd, args, ms, { json = false } = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: RUN, argv0: json ? undefined : 'prog', stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let size = 0, timedOut = false;
    c.stdout.on('data', (d) => { if ((size += d.length) < 64 << 20) out.push(d); });
    c.stderr.on('data', (d) => err.push(d));
    const t = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, ms);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, timedOut, stdout: Buffer.concat(out).toString(json ? 'utf8' : 'latin1'), stderr: Buffer.concat(err).toString('latin1') }); });
  });
}
async function prism(file) {
  const r = await child(process.execPath, [join(ROOT, 'tools', 'rosetta.mjs'), '--one', file], 20000, { json: true });
  try { const j = JSON.parse(r.stdout); return j.phase === 'ran' ? j.stdout : null; } catch { return null; }
}

const index = JSON.parse(readFileSync(join(ROOT, 'dist', 'rosetta', 'index.json'), 'utf8'));
const show = arg('show');
const rows = index.results.filter((r) => (show ? r.task === show : r.status === 'output-differs' && !r.input));

const NUM = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;
/** The shape of a difference, the cheapest explanation first. */
function classify(p, n, n2, code, nErr = '') {
  if (n !== n2) return 'nondeterministic';                        // cc's own two runs disagree
  /*
   * PRISM's runtime writes stdout and stderr to ONE stream, in program order; the native side's are
   * apart. Taking each of the native stderr lines out of PRISM's output once, what is left must be
   * the native stdout: then the difference is the two streams, not the program.
   */
  if (nErr) {
    const left = p.split('\n');
    for (const l of nErr.split('\n').filter(Boolean)) { const k = left.indexOf(l); if (k >= 0) left.splice(k, 1); }
    if (left.join('\n').replace(/\s+$/, '') === n.replace(/\s+$/, '')) return 'stderr-merged';
  }
  // Allowed to differ by the libraries, not the compiler: each libc has its own rand(), and headless
  // PRISM runs on a fixed date with an empty environment, on purpose (the gates must repeat).
  if (/\b(s?rand|random|srandom|[dlm]rand48|arc4random)\s*\(/.test(code)) return 'libc-random';
  if (/\b(time|clock|localtime|gmtime|ctime|getenv|getpid)\s*\(/.test(code)) return 'clock-or-environment';
  if (p.replace(/\s+$/, '') === n.replace(/\s+$/, '')) return 'trailing-whitespace';
  if (n.startsWith(p)) return 'prism-output-cut';                  // PRISM stopped early
  if (p.startsWith(n)) return 'prism-output-longer';
  const pl = p.split('\n'), nl = n.split('\n');
  if (pl.length === nl.length) {
    const strip = (s) => s.replace(NUM, '#');
    if (pl.every((l, i) => strip(l) === strip(nl[i]))) {
      // Same text, different numbers: in the last digits only, or really different values?
      const close = pl.every((l, i) => {
        const a = l.match(NUM) ?? [], b = nl[i].match(NUM) ?? [];
        return a.every((x, k) => { const u = +x, v = +b[k]; return u === v || Math.abs(u - v) <= 1e-6 * Math.max(1, Math.abs(v)); });
      });
      return close ? 'float-last-digits' : 'numbers-differ';
    }
    return 'text-differs';
  }
  return 'lines-differ';
}
const firstDiff = (p, n) => {
  const pl = p.split('\n'), nl = n.split('\n');
  for (let i = 0; i < Math.max(pl.length, nl.length); i++) if (pl[i] !== nl[i]) return { line: i + 1, prism: (pl[i] ?? '<end>').slice(0, 160), cc: (nl[i] ?? '<end>').slice(0, 160) };
  return null;
};

const out = [];
let done = 0;
const JOBS = Math.max(1, availableParallelism() - 2);
const queue = [...rows];
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (queue.length) {
    const r = queue.shift();
    const file = join(CACHE, 'blocks', `${slug(r.task)}-${r.block}.c`);
    const exe = file.replace(/\.c$/, '.native');
    if (!existsSync(file) || !existsSync(exe)) { out.push({ task: r.task, block: r.block, kind: 'missing' }); continue; }
    const [p, a, b] = await Promise.all([prism(file), child(exe, [], 10000), child(exe, [], 10000)]);
    const kind = p === null ? 'prism-failed-now' : a.timedOut || b.timedOut ? 'native-timeout' : classify(p, a.stdout, b.stdout, readFileSync(file, 'latin1'), a.stderr);
    const tag = `${slug(r.task)}-${r.block}`;
    if (p !== null) { writeFileSync(join(DIFF, `${tag}.prism.txt`), p, 'latin1'); writeFileSync(join(DIFF, `${tag}.cc.txt`), a.stdout, 'latin1'); }
    out.push({ task: r.task, block: r.block, kind, first: p !== null ? firstDiff(p, a.stdout) : null, file: `.oracle/rosetta/blocks/${tag}.c` });
    process.stdout.write(`\r${++done}/${rows.length}`);
  }
}));
console.log();

/*
 * --i386: the suspects against the reference that has PRISM's data model. cc on this host is LP64
 * (long and pointers 64-bit) and PRISM is i386 (ILP32), so a sum kept in a long overflows under
 * PRISM and not under cc -- right on both sides. gcc in the linux/386 oracle container
 * (tools/oracle.mjs) is the build PRISM must match. It runs emulated, so only the suspects go.
 */
const DISMISSED = ['nondeterministic', 'trailing-whitespace', 'stderr-merged', 'libc-random', 'clock-or-environment', 'missing', 'prism-failed-now', 'native-timeout'];
if (flag('i386')) {
  const oracle = await import('./oracle.mjs');
  const suspects = out.filter((r) => !DISMISSED.includes(r.kind));
  console.log(`${suspects.length} suspects against gcc -m32 (linux/386, emulated)`);
  for (const [i, r] of suspects.entries()) {
    const tag = `${slug(r.task)}-${r.block}`, rel = `rosetta/blocks/${tag}.c`;
    const g = oracle.sh(`cd rosetta/run && gcc -std=gnu11 -O0 -w -o /tmp/r386 ../blocks/${tag}.c -lm && timeout 60 /tmp/r386 </dev/null`, { timeout: 120000 });
    const p = existsSync(join(DIFF, `${tag}.prism.txt`)) ? readFileSync(join(DIFF, `${tag}.prism.txt`), 'latin1') : null;
    const ref = Buffer.from(g.stdout, 'utf8').toString('latin1');
    r.i386 = g.code === 124 ? 'timeout' : /error:/.test(g.stderr) && !g.stdout ? 'does-not-build' : p === ref ? 'agrees' : 'differs';
    if (r.i386 === 'differs') r.firstI386 = firstDiff(p ?? '', ref);
    process.stdout.write(`\r${i + 1}/${suspects.length}`);
  }
  console.log();
}
out.sort((a, b) => a.kind.localeCompare(b.kind) || a.task.localeCompare(b.task));
if (!show) writeFileSync(join(ROOT, 'dist', 'rosetta', 'triage.json'), JSON.stringify(out, null, 1));
const by = out.reduce((m, r) => (m[r.kind] = (m[r.kind] ?? 0) + 1, m), {});
console.log(Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join('\n'));
for (const r of out.filter((x) => show || !DISMISSED.includes(x.kind))) {
  console.log(`\n[${r.kind}]${r.i386 ? ` [i386: ${r.i386}]` : ''} ${r.task} #${r.block}  ${r.file}`);
  if (r.firstI386) console.log(`  vs i386, line ${r.firstI386.line}\n    prism: ${r.firstI386.prism}\n    i386:  ${r.firstI386.cc}`);
  if (r.first) console.log(`  line ${r.first.line}\n    prism: ${r.first.prism}\n    cc:    ${r.first.cc}`);
}
