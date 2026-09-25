// gate-huge.mjs — Borland `huge` pointers under a 16-bit model.
//
// A huge pointer is a far pointer whose ARITHMETIC IS NORMALISED: stepping past offset 0xFFFF moves
// into the next segment instead of wrapping, and pointers in different segments compare and subtract
// by their full address. Keen Dreams uses them for buffers larger than 64K -- the Huffman and RLEW
// expanders in id_ca.c, the Sound Blaster sample in id_sd.c.
//
// PRISM's far pointer is already a linear address with unwrapped arithmetic, so huge is represented
// exactly as far. What is checked, executed under dos16m and dos16l:
//
//   * four bytes, like far
//   * ++ past 1000:FFFF lands on 2000:0000 -- normalised, as FP_SEG/FP_OFF show it
//   * indexing 70000 bytes ahead reaches the byte a far pointer built at that address reaches
//   * a difference across segments is the whole distance, typed long (an int for far and near --
//     Watcom -mm: sizeof(hp - hp) is 4), and < compares whole addresses
//   * a far pointer converts to huge and back unchanged (Keen: `*(unsigned huge *)bigbuffer = n`)
//
// Under i386 `huge` has no meaning and stays refused (gate-borland16).
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(56)} ${detail}`);
};

const SRC = `#include <dos.h>
int h_size(void) { return sizeof(char huge *) * 10 + sizeof(unsigned huge *); }
int h_step(void) {
  char huge *p = (char huge *)MK_FP(0x3000, 0xFFFF);
  p++;
  return FP_SEG(p) == 0x4000 && FP_OFF(p) == 0;
}
int h_index(void) {
  char huge *p = (char huge *)MK_FP(0x3000, 0);
  char far *q = (char far *)MK_FP(0x3000 + 0x1117, 0);   /* 0x11170 = 70000 bytes on */
  p[70000L] = 42;
  return *q == 42;
}
long h_diff(void) {
  char huge *p = (char huge *)MK_FP(0x3000, 0x10);
  char huge *q = p + 70000L;
  return q - p;
}
int h_difftype(void) {
  char huge *hp = 0; char far *fp = 0; char *np = 0;
  return sizeof(hp - hp) * 100 + sizeof(fp - fp) * 10 + sizeof(np - np);
}
int h_less(void) {
  char huge *p = (char huge *)MK_FP(0x3000, 0xFFF0);
  char huge *q = (char huge *)MK_FP(0x4000, 0x0010);
  return p < q && !(q < p);
}
int h_convert(void) {
  unsigned far *big = (unsigned far *)MK_FP(0x3800, 0);
  *(unsigned huge *)big = 0x1234;
  ((unsigned huge *)big)[1] = 0x5678;
  return big[0] == 0x1234 && big[1] == 0x5678;
}
`;

for (const model of ['dos16m', 'dos16l']) {
  const p = compileProgram([{ file: 'h.c', source: SRC }],
    { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model });
  const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
  const run = (fn) => {
    if (failed.has(fn)) return `refused: ${failed.get(fn).slice(0, 60)}`;
    try { return p.F[fn](); } catch (e) { return `threw: ${e.message}`; }
  };
  const eq = (fn, want, what) => { const got = run(fn); report(got === want, `${model}: ${what}`, `${got}`); };
  eq('h_size', 44, 'four bytes, like far');
  eq('h_step', 1, '++ past 3000:FFFF is 4000:0000');
  eq('h_index', 1, 'p[70000] crosses into the next segments');
  eq('h_diff', 70000, 'a difference across segments is the whole distance');
  eq('h_difftype', 422, 'a huge difference is a long, far and near an int (Watcom)');
  eq('h_less', 1, '< compares whole addresses');
  eq('h_convert', 1, 'far converts to huge and back unchanged');
}

console.log(bad ? `\n${bad} WRONG` : '\nhuge pointers: linear, normalised, and four bytes.');
process.exit(bad ? 1 : 0);
