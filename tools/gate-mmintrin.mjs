// gate-mmintrin.mjs — PRISM's <mmintrin.h> and <xmmintrin.h> (src/env/headers-mmx.js) against gcc's.
//
// One C program applies every intrinsic the headers declare to edge and random operands -- lanes at
// 0, 1, -1, the signed and unsigned limits, shifts at and past the lane width and with a count whose
// high half is set -- and prints each result. gcc runs it in the oracle container with its OWN
// headers (-mmmx -msse, the instructions themselves); PRISM runs it with its own. Every line must
// agree.
//
// Then the headers are MUTATED -- a product shifted by 15, an arithmetic shift that stops clamping its
// count, an unsigned pack that saturates as a signed one -- and each mutation must turn the gate red.
//
//   node tools/gate-mmintrin.mjs
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';
import { MMINTRIN_H, XMMINTRIN_H } from '../src/env/headers-mmx.js';
import { compileRun } from './oracle.mjs';

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(56)} ${detail}`);
};

// Operands: lane patterns at the edges, then a seeded LCG.
const VALUES = [
  0n, 0xffffffffffffffffn, 0x0001000100010001n, 0x7fff7fff7fff7fffn, 0x8000800080008000n, 0x7fff8000ffff0001n,
  0x807f01ff00fe7f80n, 0x7fffffff80000000n, 0x00ff00ff00ff00ffn, 0x0000000100000020n, 0x0000000000000040n,
];
let s = 0x2545f491;
while (VALUES.length < 18) {
  const w = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return BigInt(s); };
  VALUES.push((w() << 32n) | w());
}
const BIN = ['_mm_add_pi8', '_mm_add_pi16', '_mm_add_pi32', '_mm_adds_pi8', '_mm_adds_pi16', '_mm_adds_pu8', '_mm_adds_pu16',
  '_mm_sub_pi8', '_mm_sub_pi16', '_mm_sub_pi32', '_mm_subs_pi8', '_mm_subs_pi16', '_mm_subs_pu8', '_mm_subs_pu16',
  '_mm_mullo_pi16', '_mm_mulhi_pi16', '_mm_madd_pi16', '_mm_and_si64', '_mm_andnot_si64', '_mm_or_si64', '_mm_xor_si64',
  '_mm_cmpeq_pi8', '_mm_cmpeq_pi16', '_mm_cmpeq_pi32', '_mm_cmpgt_pi8', '_mm_cmpgt_pi16', '_mm_cmpgt_pi32',
  '_mm_packs_pi16', '_mm_packs_pu16', '_mm_packs_pi32', '_mm_unpacklo_pi8', '_mm_unpacklo_pi16', '_mm_unpacklo_pi32',
  '_mm_unpackhi_pi8', '_mm_unpackhi_pi16', '_mm_unpackhi_pi32',
  '_mm_max_pi16', '_mm_min_pi16', '_mm_max_pu8', '_mm_min_pu8', '_mm_avg_pu8', '_mm_avg_pu16', '_mm_mulhi_pu16', '_mm_sad_pu8',
  // Shifts by a count held in an __m64: the operand table supplies counts past every width.
  '_mm_sll_pi16', '_mm_sll_pi32', '_mm_sll_si64', '_mm_srl_pi16', '_mm_srl_pi32', '_mm_srl_si64', '_mm_sra_pi16', '_mm_sra_pi32'];
const SHIFT_IMM = ['_mm_slli_pi16', '_mm_slli_pi32', '_mm_slli_si64', '_mm_srli_pi16', '_mm_srli_pi32', '_mm_srli_si64',
  '_mm_srai_pi16', '_mm_srai_pi32'];
const COUNTS = [0, 1, 7, 15, 16, 17, 31, 32, 33, 63, 64, 65, 200];
// Counts for the __m64 forms, as operands of their own.
const COUNT_VALUES = [...COUNTS.map(BigInt), 0x100000000n, 0xffffffffffffffffn];

function program() {
  const v = VALUES.map((x) => `0x${x.toString(16)}ULL`).join(', ');
  const cv = COUNT_VALUES.map((x) => `0x${x.toString(16)}ULL`).join(', ');
  const lines = [];
  for (const f of BIN) {
    const counts = /_s(ll|rl|ra)_/.test(f);
    lines.push(`  for (i = 0; i < NV; i++) for (j = 0; j < ${counts ? 'NC' : 'NV'}; j++) P("${f}", ${f}(M(V[i]), M(${counts ? 'C[j]' : 'V[j]'})));`);
  }
  for (const f of SHIFT_IMM) {
    lines.push(`  for (i = 0; i < NV; i++) { ${COUNTS.map((c) => `P("${f}", ${f}(M(V[i]), ${c}));`).join(' ')} }`);
  }
  // Immediates gcc wants as constants: unrolled.
  for (const n of [0, 0x1b, 0x4e, 0xe4, 0xff, 0x93, 0x00, 0x39]) lines.push(`  for (i = 0; i < NV; i++) P("_mm_shuffle_pi16", _mm_shuffle_pi16(M(V[i]), ${n}));`);
  for (const n of [0, 1, 2, 3]) {
    lines.push(`  for (i = 0; i < NV; i++) printf("_mm_extract_pi16 %d\\n", _mm_extract_pi16(M(V[i]), ${n}));`);
    lines.push(`  for (i = 0; i < NV; i++) P("_mm_insert_pi16", _mm_insert_pi16(M(V[i]), (int)V[(i + 3) % NV], ${n}));`);
  }
  lines.push('  for (i = 0; i < NV; i++) printf("_mm_movemask_pi8 %d\\n", _mm_movemask_pi8(M(V[i])));');
  lines.push('  for (i = 0; i < NV; i++) printf("_mm_cvtsi64_si32 %d\\n", _mm_cvtsi64_si32(M(V[i])));');
  lines.push('  for (i = 0; i < NV; i++) P("_mm_cvtsi32_si64", _mm_cvtsi32_si64((int)V[i]));');
  lines.push('  for (i = 0; i < NV; i++) { unsigned long long x = V[i];'
    + ' P("_mm_set_pi32", _mm_set_pi32((int)(x >> 32), (int)x));'
    + ' P("_mm_setr_pi32", _mm_setr_pi32((int)(x >> 32), (int)x));'
    + ' P("_mm_set_pi16", _mm_set_pi16((short)(x >> 48), (short)(x >> 32), (short)(x >> 16), (short)x));'
    + ' P("_mm_setr_pi16", _mm_setr_pi16((short)(x >> 48), (short)(x >> 32), (short)(x >> 16), (short)x));'
    + ' P("_mm_set_pi8", _mm_set_pi8((char)(x >> 56), (char)(x >> 48), (char)(x >> 40), (char)(x >> 32), (char)(x >> 24), (char)(x >> 16), (char)(x >> 8), (char)x));'
    + ' P("_mm_setr_pi8", _mm_setr_pi8((char)(x >> 56), (char)(x >> 48), (char)(x >> 40), (char)(x >> 32), (char)(x >> 24), (char)(x >> 16), (char)(x >> 8), (char)x));'
    + ' P("_mm_set1_pi32", _mm_set1_pi32((int)x)); P("_mm_set1_pi16", _mm_set1_pi16((short)x)); P("_mm_set1_pi8", _mm_set1_pi8((char)x)); }');
  lines.push('  P("_mm_setzero_si64", _mm_setzero_si64()); _mm_empty();');
  return `#include <stdio.h>
#include <string.h>
#include <xmmintrin.h>
static const unsigned long long V[] = { ${v} };
static const unsigned long long C[] = { ${cv} };
#define NV ${VALUES.length}
#define NC ${COUNT_VALUES.length}
static __m64 M(unsigned long long v) { __m64 m; memcpy(&m, &v, 8); return m; }
static void P(const char *f, __m64 m) { unsigned long long u; memcpy(&u, &m, 8); printf("%s %016llx\\n", f, u); }
int main(void) {
  int i, j;
${lines.join('\n')}
  return 0;
}
`;
}

function prism(src, headers = {}) {
  const p = compileProgram([{ file: 'mm.c', source: src }], { resolve: builtinHeaderResolver(headers) });
  p.run();
  return p.M.stdout.join('');
}

/** The first line two outputs disagree on, or null. */
function diff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let n = 0, first = null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) { n++; first ??= `line ${i + 1}: ${x[i]} | gcc ${y[i]}`; }
  return n ? { n, first } : null;
}

const src = program();
const g = compileRun(src, { std: 'gnu99', extra: '-mmmx -msse' });
if (g.code !== 0) { console.log(g.stderr); process.exit(1); }
const want = g.stdout;
const mine = prism(src);
const lines = want.split('\n').length - 1;
const d = diff(mine, want);
const names = new Set(want.split('\n').map((l) => l.split(' ')[0]).filter(Boolean));
report(!d, `${names.size} intrinsics, ${lines} results, as gcc -mmmx -msse`, d ? `${d.n} differ; first ${d.first}` : '');

const MUTATIONS = [
  ['mulhi_pi16 shifts by 15', 'mm', '(short)((a.m64_i16[k] * b.m64_i16[k]) >> 16)', '(short)((a.m64_i16[k] * b.m64_i16[k]) >> 15)'],
  ['srai stops clamping its count', 'mm', '>> (u >= bits ? bits - 1 : u)', '>> (u & (bits - 1))'],
  ['packs_pu16 saturates as signed', 'mm', 'r.m64_u8[k] = __prism_us8(a.m64_i16[k])', 'r.m64_u8[k] = __prism_ss8(a.m64_i16[k])'],
  ['madd_pi16 drops the second product', 'mm', '+ (unsigned int)(a.m64_i16[2 * k + 1] * b.m64_i16[2 * k + 1])', ''],
  ['avg_pu8 rounds down', 'xmm', '(unsigned char)((a.m64_u8[k] + b.m64_u8[k] + 1) >> 1)', '(unsigned char)((a.m64_u8[k] + b.m64_u8[k]) >> 1)'],
  ['unpackhi takes the low half', 'mm', 'r.view[2 * k] = a.view[n / 2 + k]', 'r.view[2 * k] = a.view[k]'],
];
for (const [what, which, from, to] of MUTATIONS) {
  const base = which === 'mm' ? MMINTRIN_H : XMMINTRIN_H;
  if (!base.includes(from)) { report(false, `mutation '${what}' applies`, 'its text is not in the header'); continue; }
  const headers = which === 'mm' ? { 'mmintrin.h': base.replace(from, to) } : { 'xmmintrin.h': base.replace(from, to) };
  const m = diff(prism(src, headers), want);
  report(!!m, `   mutation '${what}' is caught`, m ? `${m.n} lines red` : '');
}

console.log(bad ? `\n${bad} check(s) failed` : '\nall checks pass');
process.exit(bad ? 1 : 0);
