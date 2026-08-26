// csmith-diff.mjs — the oracle that does not think.
//
// Every other gate here is a corpus somebody wrote: c-testsuite, gcc.c-torture, thirty hand programs.
// They are finite, and worse, they are finite in a shape a person imagined. Csmith generates C
// programs at random — a few thousand lines each, full of the type punning, integer promotion,
// bitfield packing and struct-by-value passing that real code does by accident — and every program
// ends by printing a checksum over its whole global state. Two compilers that agree on that number
// agree about everything the program touched.
//
// This is the `test386.asm` of C, and the same discipline applies: the reference is EXTERNAL. PRISM
// is never asked what it thinks the answer is.
//
//   node tools/csmith-diff.mjs 100              # 100 programs from seed 1
//   node tools/csmith-diff.mjs 100 --start=500
//   node tools/csmith-diff.mjs 20 --keep        # leave failing programs in .oracle/ for reduction
//   node tools/csmith-diff.mjs --seed=1234      # one program, verbosely
//
// A DIVERGENCE IS NOT AUTOMATICALLY A PRISM BUG. Csmith programs are only guaranteed free of
// undefined behaviour if the generator says so, so the first thing this checks is that gcc agrees
// with ITSELF at -O0 and -O2. A program where it does not is thrown out before PRISM ever sees it:
// that is either UB csmith let through or a gcc bug, and neither is evidence about PRISM.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram } from '../src/compile.js';
import { HEADERS } from '../src/env/headers.js';
import * as oracle from '../tools/oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INC = join(oracle.SCRATCH, 'csmith-inc');

const args = process.argv.slice(2);
const opt = (n, d = null) => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const has = (n) => args.includes(`--${n}`);
const one = opt('seed') !== null ? +opt('seed') : null;
const count = one !== null ? 1 : +(args.find(a => /^\d+$/.test(a)) ?? 25);
const start = one !== null ? one : +(opt('start') ?? 1);

/*
 * Csmith's runtime headers live inside the oracle container; PRISM has to read them from the host.
 * Copied out once through the bind mount rather than vendored, so the headers always match the
 * generator that produced the program.
 */
function ensureHeaders() {
  if (existsSync(join(INC, 'csmith.h'))) return;
  mkdirSync(INC, { recursive: true });
  const r = oracle.sh('mkdir -p /work/csmith-inc && cp /usr/include/csmith/*.h /work/csmith-inc/');
  if (r.code !== 0) throw new Error(`could not extract csmith headers: ${r.stderr}`);
}

function resolver(name) {
  const p = join(INC, basename(name));
  if (existsSync(p)) return { path: p, text: readFileSync(p, 'latin1') };
  const std = HEADERS[name] ?? HEADERS[basename(name)];
  return std === undefined ? { path: `<missing:${name}>`, text: '' } : { path: `<${name}>`, text: std };
}

const CHECKSUM = /checksum = ([0-9A-Fa-f]+)/;

/** Compile and run one program under PRISM. Never throws — a failure is a result. */
function runPrism(source) {
  let program;
  try {
    program = compileProgram([{ file: 'cs.c', source }], {
      resolve: resolver, collect: true, memory: 96 * 1024 * 1024,
    });
  } catch (e) {
    return { how: 'compile', detail: String(e.message).split('\n')[0] };
  }
  // A function that could not be emitted is only a problem if the program CALLS it, and it will
  // throw if it does — so it is reported alongside a run failure rather than instead of one.
  const unemitted = program.failures.map(f => f.message.split('\n')[0]);
  try {
    const r = program.run(['cs']);
    const m = CHECKSUM.exec(r.stdout);
    if (!m) return { how: 'nochecksum', detail: r.stdout.trim().slice(0, 120), unemitted };
    return { checksum: m[1].toUpperCase(), unemitted };
  } catch (e) {
    return { how: 'run', detail: String(e.message).split('\n')[0], unemitted };
  }
}

ensureHeaders();
console.log(oracle.version());
console.log(`${count} program${count === 1 ? '' : 's'} from seed ${start}\n`);

const results = { agree: 0, ubSkipped: 0, noRef: 0, mismatch: [], failed: [] };
const t0 = performance.now();

for (let i = 0; i < count; i++) {
  const seed = start + i;
  const source = oracle.csmith(seed);

  // Step 1: does gcc agree with itself? -O0 against -O2 is the cheapest possible UB detector, and
  // it costs the same two runs the differential needs anyway.
  const o0 = oracle.csmithRun(source, '-O0');
  const o2 = oracle.csmithRun(source, '-O2');
  if (o0.code !== 0 || !o0.checksum) {
    results.noRef++;
    console.log(`seed ${seed}: gcc produced no checksum (exit ${o0.code}) — skipped, no reference`);
    continue;
  }
  if (o0.checksum !== o2.checksum) {
    results.ubSkipped++;
    console.log(`seed ${seed}: gcc -O0 ${o0.checksum} != -O2 ${o2.checksum} — UB or a gcc bug, skipped`);
    continue;
  }

  // Step 2: PRISM, against the number gcc agreed on with itself.
  const got = runPrism(source);
  if (got.checksum === o0.checksum) {
    results.agree++;
    if (one !== null || has('verbose')) console.log(`seed ${seed}: ${got.checksum} ✓`);
    if (got.unemitted?.length) {
      console.log(`  (${got.unemitted.length} functions not emitted, none of them called)`);
      for (const u of new Set(got.unemitted)) console.log(`    ${u.slice(0, 100)}`);
    }
    continue;
  }

  const lines = source.split('\n').length;
  if (got.how) {
    results.failed.push({ seed, ...got, lines });
    console.log(`seed ${seed}: PRISM ${got.how} failure — ${got.detail}`);
    for (const u of new Set(got.unemitted ?? [])) console.log(`    not emitted: ${u.slice(0, 100)}`);
  } else {
    results.mismatch.push({ seed, got: got.checksum, want: o0.checksum, lines });
    console.log(`seed ${seed}: ✗ WRONG ANSWER — PRISM ${got.checksum}, gcc ${o0.checksum}`);
  }
  if (has('keep')) {
    const p = join(oracle.SCRATCH, `csmith-${seed}.c`);
    writeFileSync(p, source);
    console.log(`    kept ${p} (${lines} lines)`);
  }
}

const secs = (performance.now() - t0) / 1000;
// The two kinds of skip are different facts and were reported as one, which read as "gcc is
// inconsistent" when what actually happened was "gcc produced no reference at all".
console.log(`\n${results.agree}/${count} agree with gcc · ${results.ubSkipped} skipped (gcc -O0 != -O2) · ` +
  `${results.noRef} skipped (no gcc reference) · ${results.failed.length} PRISM could not run · ` +
  `${results.mismatch.length} WRONG ANSWERS`);
console.log(`${secs.toFixed(0)} s, ${(secs / count).toFixed(1)} s per program`);

if (results.mismatch.length) {
  console.log('\nA wrong answer is the serious kind: PRISM ran the program and produced a different');
  console.log('state from gcc. Re-run one with --seed=N --keep and reduce it.');
  for (const m of results.mismatch) console.log(`  --seed=${m.seed}  (${m.lines} lines)`);
}
if (results.failed.length) {
  const byCause = new Map();
  for (const f of results.failed) {
    const k = `${f.how}: ${f.detail}`;
    byCause.set(k, (byCause.get(k) ?? 0) + 1);
  }
  console.log('\nCould not run, by cause:');
  for (const [k, n] of [...byCause].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${k}`);
}

process.exit(results.mismatch.length ? 1 : 0);
