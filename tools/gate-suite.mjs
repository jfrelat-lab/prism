// gate-suite.mjs — PRISM against a real external C test corpus.
//
// The hand-written gates test what I thought of. This one runs somebody else's suite, which is the
// only way to find out what a C compiler is actually asked to do — and, just as importantly, to RANK
// the gaps by how often real code hits them instead of by my intuition.
//
// The gcc side is captured ONCE into tools/suite-baseline.json and committed, so day-to-day runs are
// pure JS and take seconds. Same pattern as MIRAGE's golden-baseline.json and its Unicorn capture.
//
//   node tools/gate-suite.mjs                 # compare against the committed capture
//   node tools/gate-suite.mjs --capture       # re-run gcc over the corpus and rewrite the capture
//   node tools/gate-suite.mjs --gaps          # just the ranked list of what PRISM cannot do yet
//   node tools/gate-suite.mjs --limit=50
//
// Corpus (gitignored, fetched):
//   curl -sL https://github.com/c-testsuite/c-testsuite/archive/refs/heads/master.tar.gz \
//     | tar xz -C .oracle/suites

import { sh, SCRATCH, version } from './oracle.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Two corpora, one gate. They differ in how a program reports success: c-testsuite prints and
 * returns 0, gcc's torture suite is SELF-CHECKING — it calls abort() on failure and returns 0
 * otherwise — so for torture the exit status alone is the oracle and no expected output is needed.
 */
const SUITES = {
  cts: {
    dir: join(SCRATCH, 'suites', 'c-testsuite-master', 'tests', 'single-exec'),
    rel: 'suites/c-testsuite-master/tests/single-exec',
    baseline: join(ROOT, 'tools', 'suite-baseline.json'),
    std: 'gnu99',
    label: 'c-testsuite single-exec',
    fetch: 'curl -sL https://github.com/c-testsuite/c-testsuite/archive/refs/heads/master.tar.gz | tar xz -C .oracle/suites',
  },
  torture: {
    dir: join(SCRATCH, 'suites', 'execute'),
    rel: 'suites/execute',
    baseline: join(ROOT, 'tools', 'torture-baseline.json'),
    std: 'gnu89',
    label: "gcc.c-torture/execute",
    selfChecking: true,      // abort() on failure, exit 0 on success — the exit status IS the oracle
    fetch: 'curl -sL https://ftp.gnu.org/gnu/gcc/gcc-12.2.0/gcc-12.2.0.tar.xz -o /tmp/gcc.tar.xz && '
      + 'tar xJf /tmp/gcc.tar.xz -C .oracle/suites --strip-components=4 gcc-12.2.0/gcc/testsuite/gcc.c-torture/execute',
  },
};

const WHICH = process.argv.find(a => a.startsWith('--suite='))?.slice(8) ?? 'cts';
const S = SUITES[WHICH];
if (!S) { console.error(`unknown suite '${WHICH}' (have: ${Object.keys(SUITES).join(', ')})`); process.exit(2); }
const SUITE = S.dir;
const BASELINE = S.baseline;

const RUNNER = join(ROOT, 'tools', 'run-one.mjs');
const TIMEOUT = +(process.argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? 5000);

const CAPTURE = process.argv.includes('--capture');
const GAPS_ONLY = process.argv.includes('--gaps');
const LIMIT = +(process.argv.find(a => a.startsWith('--limit='))?.slice(8) ?? 0);

if (!existsSync(SUITE)) {
  console.error(`corpus missing: ${SUITE}\nFetch it with:\n  ${S.fetch}`);
  process.exit(2);
}

const tests = readdirSync(SUITE).filter(f => f.endsWith('.c')).sort();
const active = LIMIT ? tests.slice(0, LIMIT) : tests;

// ---------------------------------------------------------------- the gcc capture

function captureWithGcc(names) {
  console.log(`capturing ${names.length} programs with gcc (this is the slow path)…`);
  const rel = S.rel;
  // Four at a time: the container is emulated, so gcc dominates and the host has cores to spare.
  const script = `cd ${rel} && printf '%s\\n' ${names.map(n => `'${n}'`).join(' ')} | ` +
    `xargs -P 4 -I{} sh -c '` +
    `out=$(gcc -std=${S.std} -w -o /tmp/{}.bin {} -lm 2>&1) || { echo "===T {}"; echo "===COMPILEFAIL"; echo "===E {}"; exit 0; }; ` +
    `res=$(/tmp/{}.bin 2>&1); rc=$?; echo "===T {}"; echo "$res"; echo "===RC $rc"; echo "===E {}"' `;
  const r = sh(script, { timeout: 1800000 });

  const out = new Map();
  let cur = null, buf = [];
  for (const line of r.stdout.split('\n')) {
    let m = line.match(/^===T (.+)$/);
    if (m) { cur = m[1]; buf = []; continue; }
    m = line.match(/^===E (.+)$/);
    if (m) {
      if (cur) {
        const text = buf.join('\n');
        if (text.trim() === '===COMPILEFAIL') out.set(cur, { skip: 'gcc rejected it' });
        else {
          const rcm = text.match(/===RC (\d+)\s*$/);
          out.set(cur, { rc: rcm ? +rcm[1] : null, out: text.replace(/\n?===RC \d+\s*$/, '') });
        }
      }
      cur = null; continue;
    }
    if (cur !== null) buf.push(line);
  }
  return out;
}

if (CAPTURE) {
  const captured = captureWithGcc(active);
  const obj = {};
  for (const [k, v] of captured) obj[k] = v;
  writeFileSync(BASELINE, JSON.stringify({
    suite: S.label,
    gcc: version().split('\n')[0],
    count: Object.keys(obj).length,
    results: obj,
  }, null, 1) + '\n');
  console.log(`captured ${Object.keys(obj).length} results into tools/suite-baseline.json`);
}

if (!existsSync(BASELINE)) {
  console.error('no capture yet — run: node tools/gate-suite.mjs --capture');
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

// ---------------------------------------------------------------- compare

/** Collapse a PRISM error into a bucket, so the gaps can be ranked rather than listed. */
function bucket(msg) {
  const m = msg.replace(/\n[\s\S]*$/, '');
  const pats = [
    [/tier-0 does not support (.+?) yet/, (x) => `unsupported: ${x[1]}`],
    [/does not support goto/, () => 'unsupported: goto'],
    [/undeclared identifier '(.+?)'/, (x) => `missing symbol: ${x[1]}`],
    [/call to undeclared function '(.+?)'/, (x) => `missing libc: ${x[1]}`],
    [/No such file or directory/, () => 'missing header'],
    [/cannot emit expression '(.+?)'/, (x) => `unimplemented expression: ${x[1]}`],
    [/'(.+?)' is not an lvalue/, (x) => `lvalue: ${x[1]}`],
    [/statement '(.+?)'/, (x) => `unimplemented statement: ${x[1]}`],
    [/emitted JavaScript did not compile/, () => 'emitted JS is invalid'],
    [/expected '(.+?)' but found/, (x) => `parse error near '${x[1]}'`],
    [/expected an identifier/, () => 'parse error: expected identifier'],
    [/unexpected '(.+?)' in expression/, (x) => `parse error: unexpected '${x[1]}'`],
    [/Offset is outside the bounds/, () => 'memory access out of bounds'],
    [/not a constant initialiser/, () => 'non-constant static initialiser'],
    [/has no member '(.+?)'/, () => 'member lookup failed'],
    [/no main\(\)/, () => 'no main'],
  ];
  for (const [re, f] of pats) { const x = m.match(re); if (x) return f(x); }
  return `other: ${m.slice(0, 70)}`;
}

/**
 * Tests that depend on unspecified or undefined behaviour. Each is a real gcc test but a bad
 * oracle: it pins what gcc chose, not what a conforming compiler must do.
 */
const UB_TESTS = {
  '20031003-1.c': 'float->int out of range is undefined; the test pins gcc\'s saturation',
  '20021127-1.c': 'defines `llabs`, a reserved library name (C 7.1.3); the test pins gcc\'s builtin folding',
};

let pass = 0, skipped = 0, wrong = 0, errored = 0, badRef = 0;
const ubExcluded = [];
const gaps = new Map();
const wrongCases = [];
const miscompiled = [];

for (const name of active) {
  const ref = baseline.results[name];
  if (!ref) { skipped++; continue; }
  if (ref.skip) { skipped++; continue; }
  // A SELF-CHECKING corpus is only an oracle where the reference build passes. gcc's torture suite
  // is driven by its own harness over a matrix of options, and several tests fail under a plain
  // `gcc -O0` — memchr-1.c exits 244, strlen-2.c exits 2 at every level, and return-addr.c prints
  // real return addresses so its exit code differs per build. Comparing against those reported
  // ten "wrong answers" that said nothing about PRISM. Counted, never hidden.
  if (S.selfChecking && ref.rc !== 0) { badRef++; continue; }
  // A handful of corpus tests enshrine behaviour the standard does not define, so they measure a
  // compiler's CHOICE rather than its correctness. Excluding them by name, with the reason, is the
  // same rule as refusing to compare on argument evaluation order in gate-run.
  if (UB_TESTS[name]) { ubExcluded.push(`${name} (${UB_TESTS[name]})`); continue; }

  // Each program runs in its OWN process with a wall-clock limit. In-process there is no way to
  // stop one that loops for ever, and the torture corpus contains both deliberately long tests and
  // — when the compiler is wrong — accidental infinite loops. The first torture run hung the gate
  // for over ten minutes with no output at all before this existed.
  const r0 = spawnSync(process.execPath, [RUNNER, join(SUITE, name)],
    { encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 1 << 26 });
  let got;
  if (r0.error?.code === 'ETIMEDOUT' || r0.signal) {
    errored++;
    gaps.set('TIMEOUT / did not terminate', (gaps.get('TIMEOUT / did not terminate') ?? []).concat(name));
    continue;
  }
  let parsed;
  try { parsed = JSON.parse(r0.stdout); }
  catch {
    errored++;
    const b = bucket((r0.stderr || 'runner produced no JSON').split('\n').find(Boolean) ?? 'runner crashed');
    gaps.set(b, (gaps.get(b) ?? []).concat(name));
    continue;
  }
  if (!parsed.ok) {
    // `abort()` is NOT a gap. In a self-checking corpus it means the program's own assertion failed,
    // i.e. PRISM compiled it and produced a wrong value — a defect, and it belongs with the wrong
    // answers rather than hidden among the refusals it was first bucketed with.
    if (/abort\(\) called/.test(parsed.err)) {
      wrong++;
      miscompiled.push(name);
      continue;
    }
    errored++;
    const b = bucket(parsed.err);
    gaps.set(b, (gaps.get(b) ?? []).concat(name));
    continue;
  }
  got = { code: parsed.code, stdout: parsed.stdout };
  // The capture went through `$(cmd)`, which strips EVERY trailing newline; strip both sides the
  // same way or a program whose output ends in a blank line looks like a defect.
  const a = got.stdout.replace(/\n+$/, '');
  const b = (ref.out ?? '').replace(/\n+$/, '');
  if (a === b && got.code === ref.rc) { pass++; continue; }
  wrong++;
  wrongCases.push({ name, ours: a, theirs: b, oc: got.code, rc: ref.rc });
}

const total = active.length - skipped - badRef - ubExcluded.length;
console.log(`\n${S.label}: ${pass}/${total} pass  (${errored} refused, ${wrong} wrong answer, ` +
  `${skipped} skipped${badRef ? `, ${badRef} excluded: the gcc reference build fails them too` : ''}` +
  `${ubExcluded.length ? `, ${ubExcluded.length} excluded as undefined behaviour` : ''})`);
if (ubExcluded.length && !GAPS_ONLY) {
  console.log(`\nExcluded as UNDEFINED/UNSPECIFIED behaviour — a bad oracle, not a PRISM result:`);
  for (const u of ubExcluded) console.log(`  ${u}`);
}

if (miscompiled.length) {
  console.log(`\n⚠️  MISCOMPILED — the program's own check called abort(), so PRISM produced a wrong` +
    ` value (${miscompiled.length}):\n  ${miscompiled.slice(0, 25).join(' ')}` +
    (miscompiled.length > 25 ? ` … and ${miscompiled.length - 25} more` : ''));
}

if (wrongCases.length && !GAPS_ONLY) {
  console.log(`\n⚠️  WRONG ANSWERS — these matter more than the refusals, because PRISM claimed success:`);
  for (const w of wrongCases.slice(0, 12)) {
    console.log(`  ${w.name}: exit ${w.oc} vs ${w.rc}` +
      (w.ours !== w.theirs ? `\n      prism: ${JSON.stringify(w.ours.slice(0, 90))}\n      gcc  : ${JSON.stringify(w.theirs.slice(0, 90))}` : ''));
  }
}

const ranked = [...gaps.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`\nGaps, ranked by how many programs hit them (${errored} programs, ${ranked.length} distinct causes):\n`);
for (const [b, names] of ranked) {
  console.log(`  ${String(names.length).padStart(3)}  ${b}`);
  if (GAPS_ONLY) console.log(`       e.g. ${names.slice(0, 6).join(' ')}`);
}

// A wrong answer is a defect; a refusal is a known gap. Only the first fails the gate.
if (wrong > 0) process.exit(1);
