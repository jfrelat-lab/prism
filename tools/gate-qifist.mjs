// gate-qifist.mjs — compile({ floatToInt: 'fist' }), Visual C++'s /QIfist, against Visual C++ itself.
//
// /QIfist drops the _ftol helper for an integer of 32 bits or fewer: the value goes through a bare
// fistp of eight bytes, so the x87 control word's rounding decides and the low dword is kept (the
// integer indefinite's, 0, when it does not fit). A 64-bit integer still goes through _ftol and is
// truncated -- the oracle said so, not the documentation. .kkrieger
// is built so, and its sFloatFix leaves the FPU at round-to-nearest -- a conversion PRISM truncated
// the C way was one off for every positive .5 and more.
//
// One program converts edge values (halves, both signs, past every integer width, infinities, NaN)
// from float and double to char, short, int, unsigned, __int64 and unsigned __int64, under each of the
// four rounding modes it loads with fldcw, and prints every result. The reference is Visual C++
// Toolkit 2003 (cl 13.10.3077, the compiler of .kkrieger's vcproj) run under Wine:
// - with /QIfist, every line, which floatToInt 'fist' must reproduce;
// - without it, the default rounding mode's in-range lines, which floatToInt 'trunc' (the default)
//   must reproduce -- C defines nothing else.
// Then the runtime is MUTATED (rounding ignored, truncation, the indefinite as the low dword) and each
// mutation must turn the gate red.
//
//   node tools/gate-qifist.mjs              against goldens/qifist.json
//   node tools/gate-qifist.mjs --capture    rebuild the golden with Visual C++ (needs .oracle/msvc/wcl.sh:
//                                           the toolkit, the Platform SDK and Wine in Docker; see the script)
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'qifist.json');
const WCL = join(ROOT, '.oracle', 'msvc', 'wcl.sh');

const VALUES = ['0.0', '0.5', '1.5', '2.5', '-0.5', '-1.5', '-2.5', '2.7', '-2.7', '0.49999997', '-1e-30',
  '127.5', '128.5', '-128.5', '255.5', '32767.5', '65535.5', '-32768.5', '2147483647.0', '2147483648.0',
  '-2147483648.0', '-2147483649.0', '4294967295.0', '4294967296.0', '1e10', '-1e10', '9.2e18', '1e19', '-1e19',
  '1.8e19', '1e30', 'INF', '-INF', 'NAN'];
// The control word's rounding field: nearest, down, up, toward zero (precision and masks as Windows's).
const MODES = [['near', 0x027f], ['down', 0x067f], ['up', 0x0a7f], ['chop', 0x0e7f]];

const SOURCE = String.raw`#include <stdio.h>
typedef __int64 i64;
typedef unsigned __int64 u64;
static void cw(unsigned short w) { __asm fldcw w }
static double V[] = { ${VALUES.map((v) => (v === 'INF' || v === '-INF' || v === 'NAN' ? '0.0' : v)).join(', ')} };
static void hex64(u64 v) { printf(" %08x%08x", (unsigned)(v >> 32), (unsigned)v); }
static void row(const char *mode, const char *from, int i, float f, double d)
{
  if (from[0] == 'f') {
    printf("%s %s %d %d %d %d %u", mode, from, i, (int)(char)f, (int)(short)f, (int)f, (unsigned)f);
    hex64((u64)(i64)f); hex64((u64)f);
  } else {
    printf("%s %s %d %d %d %d %u", mode, from, i, (int)(char)d, (int)(short)d, (int)d, (unsigned)d);
    hex64((u64)(i64)d); hex64((u64)d);
  }
  printf("\n");
}
int main()
{
  static const unsigned short W[] = { ${MODES.map(([, w]) => `0x${w.toString(16)}`).join(', ')} };
  static const char *N[] = { ${MODES.map(([n]) => `"${n}"`).join(', ')} };
  volatile double zero = 0.0;
  int m, i, n = sizeof(V) / sizeof(V[0]);
  V[n - 3] = 1.0 / zero; V[n - 2] = -1.0 / zero; V[n - 1] = zero / zero;
  for (m = 0; m < 4; m++) {
    for (i = 0; i < n; i++) {
      volatile float f; volatile double d;
      /* The float is rounded before the mode changes: an x87 store to float obeys the rounding
         control too, and PRISM's float is round-to-nearest (Math.fround) -- not this gate's subject. */
      cw(W[0]); f = (float)V[i]; d = V[i];
      cw(W[m]);
      row(N[m], "f", i, f, d);
      row(N[m], "d", i, f, d);
    }
  }
  cw(0x027f);
  return 0;
}
`;

// A line is in range for C when the value, truncated, fits every type the line converts to. The
// default mode is the only one C has; the others are /QIfist's alone.
const inRange = (line) => {
  const [mode, from, i] = line.split(' ');
  if (mode !== 'near') return false;
  const s = VALUES[+i], v = from === 'f' ? Math.fround(Number(s)) : Number(s);
  if (!Number.isFinite(v)) return false;
  const t = Math.trunc(v);
  return t >= 0 && t <= 127;                                   // char is signed; unsigned wants >= 0
};

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(60)} ${detail}`);
};

function prism(floatToInt) {
  const p = compileProgram([{ file: 'qifist.cpp', source: SOURCE }], {
    resolve: builtinHeaderResolver({}), cxx: { compiler: 'msvc' }, collect: true, ...(floatToInt ? { floatToInt } : {}),
  });
  for (const f of p.failures ?? []) report(false, `PRISM refuses ${f.fn}`, String(f.message).slice(0, 80));
  return p.run().stdout.trim().split('\n');
}

function msvc(qifist) {
  const dir = join(ROOT, '.oracle', 'msvc', 'qifist');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'qifist.cpp'), SOURCE);
  const run = (...args) => {
    const r = spawnSync(WCL, [dir, ...args], { encoding: 'utf8' });
    return (r.stdout + r.stderr).replace(/\r/g, '').split('\n').filter((l) => !/XDG_RUNTIME|configuration directory/.test(l)).join('\n');
  };
  const out = run('cl.exe', '/nologo', '/O2', '/ML', ...(qifist ? ['/QIfist'] : []), 'qifist.cpp');
  if (!existsSync(join(dir, 'qifist.exe'))) throw new Error(`cl failed:\n${out}`);
  return run('qifist.exe').trim().split('\n');
}

if (process.argv.includes('--capture')) {
  if (!existsSync(WCL)) { console.log(`--capture needs ${WCL}`); process.exit(1); }
  const golden = { compiler: 'Visual C++ Toolkit 2003, cl 13.10.3077, /O2 /ML', qifist: msvc(true), plain: msvc(false) };
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`);
  console.log(`goldens/qifist.json: ${golden.qifist.length} /QIfist lines, ${golden.plain.length} plain lines`);
  process.exit(0);
}
if (!existsSync(GOLDEN)) { console.log('no goldens/qifist.json: run with --capture first'); process.exit(1); }
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));

const compare = (got, want, keep = () => true) => {
  const w = want.filter(keep), g = got.filter(keep);
  let diff = 0, first = null;
  for (let i = 0; i < Math.max(w.length, g.length); i++) if (w[i] !== g[i]) { diff++; first ??= `want "${w[i]}" got "${g[i]}"`; }
  return { n: w.length, diff, first };
};

const fist = compare(prism('fist'), golden.qifist);
report(!fist.diff && fist.n === MODES.length * VALUES.length * 2, `floatToInt 'fist' = cl /QIfist, ${fist.n} lines`, fist.first ?? '');
const plain = compare(prism(), golden.plain, inRange);
report(!plain.diff && plain.n > 10, `floatToInt 'trunc' = cl, ${plain.n} in-range lines`, plain.first ?? '');

// The mutations: each is a wrong /QIfist, and must not pass.
const MUTANTS = [
  ['truncates (C, not fistp)', (rt) => { rt.fist = (v) => (Number.isFinite(v) ? Math.trunc(v) | 0 : 0); }],
  ['rounds to nearest whatever the control word', (rt) => { const f = rt.fist; rt.fist = function (v) { const x = this.x86.f, cw = x.cw; x.cw &= ~0xc00; try { return f.call(this, v); } finally { x.cw = cw; } }; }],
  ['stores the 32-bit indefinite, not the 64-bit one\'s low dword', (rt) => { const f = rt.fist; rt.fist = function (v) { const r = this.x86.f.rint(v); return r >= -(2 ** 63) && r < 2 ** 63 ? f.call(this, v) : 0x80000000 | 0; }; }],
  ['rounds a 64-bit integer too', (rt) => { rt.ftol64 = function (v) { const r = this.x86.f.rint(v); return r >= -(2 ** 63) && r < 2 ** 63 ? BigInt(r) : -(2n ** 63n); }; }],
];
for (const [what, mutate] of MUTANTS) {
  const p = compileProgram([{ file: 'qifist.cpp', source: SOURCE }], { resolve: builtinHeaderResolver({}), cxx: { compiler: 'msvc' }, collect: true, floatToInt: 'fist' });
  mutate(p.M);
  const r = compare(p.run().stdout.trim().split('\n'), golden.qifist);
  report(r.diff > 0, `mutation turns it red: ${what}`, `${r.diff} lines differ`);
}

console.log(bad ? `\ngate-qifist: ${bad} BAD` : '\ngate-qifist: all ok');
process.exit(bad ? 1 : 0);
