// gate-x87pc.mjs — compile({ x87Precision: true }) against Visual C++'s x87 code.
//
// Visual C++ compiles double arithmetic to the x87, whose precision control rounds every fadd, fsub,
// fmul, fdiv and fsqrt. .kkrieger's sFloatFix selects SINGLE precision before its textures are made,
// so its doubles are 24-bit there -- Bitmap_Normals' sqrt of a 2.7e8 sum, rounded to an integer,
// lands on the other side of .5 now and then, and PRISM's IEEE doubles did not.
//
// One program reads its operands from volatile doubles (so nothing is folded at compile time), sets the
// control word with fldcw, and prints the bits of +, -, *, /, sqrt, 1/sqrt and a two-step expression,
// at the default 53-bit precision and at 24. The reference is Visual C++ Toolkit 2003 (cl 13.10.3077,
// .kkrieger's) under Wine: PRISM with x87Precision must print the same bits, and PRISM without it must
// print the 53-bit lines (which are IEEE double's). Then the runtime is MUTATED and must turn red.
//
//   node tools/gate-x87pc.mjs              against goldens/x87pc.json
//   node tools/gate-x87pc.mjs --capture    rebuild the golden with Visual C++ (needs .oracle/msvc/wcl.sh)
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'x87pc.json');
const WCL = join(ROOT, '.oracle', 'msvc', 'wcl.sh');

// Pairs chosen so a 24-bit result differs from a 53-bit one, plus .kkrieger's own kind of operand
// (Bitmap_Normals: an int near 0x3fff squared).
const PAIRS = [['1.0', '3.0'], ['2.0', '3.0'], ['0.1', '0.7'], ['268402689.0', '7.0'], ['16383.0', '16381.0'],
  ['1e10', '3.3'], ['123456789.0', '0.001'], ['268435455.0', '1.0'], ['5.0', '0.0001']];
const MODES = [['pc53', 0x027f], ['pc24', 0x007f]];

const SOURCE = String.raw`#include <stdio.h>
#include <math.h>
static void cw(unsigned short w) { __asm fldcw w }
static volatile double A[] = { ${PAIRS.map(([a]) => a).join(', ')} };
static volatile double B[] = { ${PAIRS.map(([, b]) => b).join(', ')} };
static void bits(volatile double *v) { unsigned *u = (unsigned *)v; printf(" %08x%08x", u[1], u[0]); }
int main()
{
  static const unsigned short W[] = { ${MODES.map(([, w]) => `0x${w.toString(16)}`).join(', ')} };
  static const char *N[] = { ${MODES.map(([n]) => `"${n}"`).join(', ')} };
  int m, i;
  for (m = 0; m < 2; m++) {
    for (i = 0; i < ${PAIRS.length}; i++) {
      volatile double a = A[i], b = B[i], r[7];
      cw(W[m]);
      r[0] = a + b; r[1] = a - b; r[2] = a * b; r[3] = a / b; r[4] = sqrt(a); r[5] = 1.0 / sqrt(a); r[6] = a * b + a / b;
      cw(0x027f);
      printf("%s %d", N[m], i);
      { int k; for (k = 0; k < 7; k++) bits(&r[k]); }
      printf("\n");
    }
  }
  return 0;
}
`;

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(60)} ${detail}`);
};

const build = (x87Precision) => {
  const p = compileProgram([{ file: 'x87pc.cpp', source: SOURCE }], {
    resolve: builtinHeaderResolver({}), cxx: { compiler: 'msvc' }, collect: true, ...(x87Precision ? { x87Precision } : {}),
  });
  for (const f of p.failures ?? []) report(false, `PRISM refuses ${f.fn}`, String(f.message).slice(0, 80));
  return p;
};
const lines = (p) => p.run().stdout.trim().split('\n');

function msvc() {
  const dir = join(ROOT, '.oracle', 'msvc', 'x87pc');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'x87pc.cpp'), SOURCE);
  const run = (...args) => {
    const r = spawnSync(WCL, [dir, ...args], { encoding: 'utf8' });
    return (r.stdout + r.stderr).replace(/\r/g, '').split('\n').filter((l) => !/XDG_RUNTIME|configuration directory/.test(l)).join('\n');
  };
  // .kkrieger's own optimisation (/O1 /Og ...) would do; /O2 is the harder case for spills.
  const out = run('cl.exe', '/nologo', '/O2', '/ML', 'x87pc.cpp');
  if (!existsSync(join(dir, 'x87pc.exe'))) throw new Error(`cl failed:\n${out}`);
  return run('x87pc.exe').trim().split('\n');
}

if (process.argv.includes('--capture')) {
  if (!existsSync(WCL)) { console.log(`--capture needs ${WCL}`); process.exit(1); }
  const golden = { compiler: 'Visual C++ Toolkit 2003, cl 13.10.3077, /O2 /ML', lines: msvc() };
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`);
  console.log(`goldens/x87pc.json: ${golden.lines.length} lines`);
  process.exit(0);
}
if (!existsSync(GOLDEN)) { console.log('no goldens/x87pc.json: run with --capture first'); process.exit(1); }
const want = JSON.parse(readFileSync(GOLDEN, 'utf8')).lines;

const compare = (got, keep = () => true) => {
  const w = want.filter(keep), g = got.filter(keep);
  let diff = 0, first = null;
  for (let i = 0; i < Math.max(w.length, g.length); i++) if (w[i] !== g[i]) { diff++; first ??= `want "${w[i]}" got "${g[i]}"`; }
  return { n: w.length, diff, first };
};
const pc24 = (l) => l.startsWith('pc24');
// The positive control: at 24 bits the reference must differ from IEEE double, or the gate proves nothing.
const distinct = want.filter(pc24).filter((l, i) => l.slice(5) !== want.filter((x) => !pc24(x))[i].slice(5)).length;
report(distinct > 0, `the reference's 24-bit lines differ from its 53-bit ones`, `${distinct} of ${PAIRS.length}`);

// The reference runs on QEMU's x87 (Wine in an i386 container), which ROUNDS an fld m64 at single
// precision where the SDM leaves loads exact: a 24-bit line attests PRISM only when both operands are
// floats already. (0.1 - 0.7 is where they part: QEMU prints float(0.1) - float(0.7).)
const exactLoads = (l) => { const i = +l.split(' ')[1]; return PAIRS[i].every((s) => Math.fround(Number(s)) === Number(s)); };
const attested = (l) => !pc24(l) || exactLoads(l);
const on = compare(lines(build(true)), attested);
report(!on.diff && on.n >= PAIRS.length + 3, `x87Precision = cl, ${on.n} lines (24-bit ones with float operands)`, on.first ?? '');
const off = compare(lines(build(false)), (l) => !pc24(l));
report(!off.diff, `without it, the 53-bit lines = cl (IEEE double)`, off.first ?? '');

// Part B: the SDM's rule itself, executed exactly -- the exact result of two doubles, rounded ONCE to
// 24 bits (nearest, ties to even) -- against M.pcAdd/Sub/Mul/Div/Sqrt at single precision. Cases built
// on a midpoint between two floats, nudged past it by less than a double can hold, are where rounding
// the JS double instead rounds twice; random pairs are the rest.
const toExact = (x) => {
  const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x);
  const b = d.getBigUint64(0), e = Number((b >> 52n) & 0x7ffn), f = b & 0xfffffffffffffn;
  const m = e ? f | 0x10000000000000n : f;
  return { m: b >> 63n ? -m : m, e: (e || 1) - 1075 };
};
// num/den * 2^e, rounded once to a 24-bit significand (normal range only).
const round24 = (num, den, e) => {
  if (num === 0n) return 0;
  const neg = (num < 0n) !== (den < 0n); let n = num < 0n ? -num : num; const dd = den < 0n ? -den : den;
  let s = 0;
  while ((n << BigInt(Math.max(0, -s))) / dd < (1n << 26n) && s > -2000) s--;
  while ((n >> BigInt(Math.max(0, s))) / dd >= (1n << 27n) && s < 2000) s++;
  const scaled = s < 0 ? n << BigInt(-s) : n, q = scaled / (s > 0 ? dd << BigInt(s) : dd), sticky = scaled % (s > 0 ? dd << BigInt(s) : dd) !== 0n;
  const bits = q.toString(2).length, drop = bits - 24;
  let m = q >> BigInt(drop); const rest = q & ((1n << BigInt(drop)) - 1n), half = 1n << BigInt(drop - 1);
  if (rest > half || (rest === half && (sticky || (m & 1n)))) m++;
  const v = Number(m) * 2 ** (e + s + drop);
  return neg ? -v : v;
};
const exactAdd = (a, b) => { const x = toExact(a), y = toExact(b), e = Math.min(x.e, y.e); return round24((x.m << BigInt(x.e - e)) + (y.m << BigInt(y.e - e)), 1n, e); };
const exactMul = (a, b) => { const x = toExact(a), y = toExact(b); return round24(x.m * y.m, 1n, x.e + y.e); };
const exactDiv = (a, b) => { const x = toExact(a), y = toExact(b); return round24(x.m, y.m, x.e - y.e); };
// Newton's method from above: floor(sqrt(n)).
const isqrt = (n) => {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2)), y = (x + n / x) >> 1n;
  while (y < x) { x = y; y = (x + n / x) >> 1n; }
  return x;
};
const exactSqrt = (a) => {
  const x = toExact(a); let m = x.m, e = x.e;
  if (e & 1) { m <<= 1n; e--; }
  m <<= 120n; e -= 120;                                            // 60 more bits of root than needed
  const r = isqrt(m);
  return round24(r * 2n + (r * r !== m ? 1n : 0n), 2n, e / 2);       // the sticky bit below the root
};
let seed = 0x1234567;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
const CASES = [];
for (let i = 0; i < 200; i++) {
  const f = Math.fround((rnd() + 0.5) * 2 ** Math.floor(rnd() * 40 - 20)), ulp = Math.fround(f * (1 + 2 ** -23)) - f;
  // A midpoint between two floats (exactly a double), and exact results off it by LESS than a double
  // can hold, so the JS double is the midpoint itself and its tie goes to even, wherever the exact
  // value lies: mid +- mid*2^-60; (1+2^-27) * mid*(1-2^-27) = mid*(1-2^-54); sqrt of the doubles
  // either side of mid^2 (exact: mid^2 has 50 bits).
  const mid = f + ulp / 2, sq = mid * mid, up = sq * (1 + 2 ** -52), down = sq * (1 - 2 ** -53);
  CASES.push(['+', mid, mid * 2 ** -60], ['+', mid, -mid * 2 ** -60], ['*', 1 + 2 ** -27, mid * (1 - 2 ** -27)],
    ['sqrt', up], ['sqrt', down]);
  const a = (rnd() - 0.5) * 2 ** Math.floor(rnd() * 60 - 30), b = (rnd() - 0.5) * 2 ** Math.floor(rnd() * 60 - 30);
  CASES.push(['+', a, b], ['-', a, b], ['*', a, b], ['/', a, b], ['sqrt', Math.abs(a)]);
}
const model = { '+': exactAdd, '-': (a, b) => exactAdd(a, -b), '*': exactMul, '/': exactDiv, sqrt: exactSqrt };
const partB = (M) => {
  M.x86.f.cw = 0x007f;                                             // single precision, nearest
  const F = { '+': (a, b) => M.pcAdd(a, b), '-': (a, b) => M.pcSub(a, b), '*': (a, b) => M.pcMul(a, b), '/': (a, b) => M.pcDiv(a, b), sqrt: (a) => M.pcSqrt(a) };
  let diff = 0, first = null, twice = 0;
  for (const [op, a, b] of CASES) {
    const want2 = model[op](a, b), got = F[op](a, b);
    const naive = Math.fround(op === 'sqrt' ? Math.sqrt(a) : op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b);
    if (naive !== want2) twice++;
    if (got !== want2 && !(Number.isNaN(got) && Number.isNaN(want2))) { diff++; first ??= `${op} ${a} ${b ?? ''}: want ${want2} got ${got}`; }
  }
  M.x86.f.cw = 0x027f;
  return { diff, first, twice };
};
const b0 = partB(build(true).M);
report(b0.twice > 0, `part B's midpoint cases do round wrong twice`, `${b0.twice} of ${CASES.length}`);
report(!b0.diff, `part B: x87Precision = the exact rule, ${CASES.length} operations`, b0.first ?? '');

const MUTANTS = [
  ['ignores the precision control', (M) => { for (const k of ['pcAdd', 'pcMul', 'pcDiv']) M[k] = { pcAdd: (a, b) => a + b, pcMul: (a, b) => a * b, pcDiv: (a, b) => a / b }[k]; M.pcSqrt = Math.sqrt; }],
  ['rounds at 53 bits too', (M) => { const pc = M.pc24; M.pc24 = () => true; void pc; }],
  ['rounds twice (the JS double, then to float)', (M) => {
    const on = () => M.pc24();
    M.pcAdd = (a, b) => (on() ? Math.fround(a + b) : a + b); M.pcMul = (a, b) => (on() ? Math.fround(a * b) : a * b);
    M.pcDiv = (a, b) => (on() ? Math.fround(a / b) : a / b); M.pcSqrt = (a) => (on() ? Math.fround(Math.sqrt(a)) : Math.sqrt(a));
  }],
];
for (const [what, mutate] of MUTANTS) {
  const p = build(true);
  mutate(p.M);
  const r = compare(lines(p), attested), rb = partB(p.M);
  report(r.diff + rb.diff > 0, `mutation turns it red: ${what}`, `${r.diff} lines, ${rb.diff} operations differ`);
}

console.log(bad ? `\ngate-x87pc: ${bad} BAD` : '\ngate-x87pc: all ok');
process.exit(bad ? 1 : 0);
