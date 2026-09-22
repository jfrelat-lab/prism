// gate-realmode.mjs — real-mode far pointers: where 16-bit data lives, and what FP_SEG/FP_OFF mean.
//
// A far pointer under a 16-bit model is its linear address, seg*16+off, decomposed NORMALISED: the
// segment takes every whole paragraph, the offset stays below 16. Three things have to hold for that
// to be a representation rather than a hope, and each part goes red on its own:
//
//   A. The data is in conventional memory. A real-mode segment stops at 0xFFFF, so anything FP_SEG is
//      applied to must sit below the first megabyte; dos16l once took the i386 map, statics at
//      0x100000, where every FP_SEG of program data would have truncated silently. Data now runs from
//      0x10000 to 0xA0000 -- the 640K of DOS -- and running out is refused before the video windows.
//
//   B. The arithmetic. i386 is the one model that executes, so the real-mode macros are run there with
//      __PRISM_REALMODE__ forced: MK_FP(0xB800, 0x10) is 0xB8010; FP_SEG*16+FP_OFF gives the pointer
//      back; FP_OFF is below 16; and Keen Dreams' own paragraph formula, FP_SEG+(FP_OFF+15)/16, lands
//      on the first aligned paragraph. And WITHOUT the macro the flat DJGPP meaning stays, because
//      Heretic's DPMI calls depend on it.
//
//   C. The choice is made by the model: compiling for dos16l predefines __PRISM_REALMODE__, compiling
//      for i386 does not.
import { Module } from '../src/link/module.js';
import { Preprocessor } from '../src/cpp/cpp.js';
import { compileProgram, builtinHeaderResolver, modelDefines } from '../src/compile.js';

let bad = 0;
const report = (ok, what, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(48)} ${detail}`);
};
const hex = (n) => `0x${n.toString(16)}`;

// --- A. conventional memory
{
  const m = new Module({ memory: 16 << 20, model: 'dos16l' });
  report(m.size === 0x100000, 'dos16l image is the first megabyte', hex(m.size));
  report(m.brk >= 0x10000 && m.brk < 0xA0000, 'dos16l statics start in conventional memory', hex(m.brk));
  report(m.stackTop < 0xA0000, 'dos16l stack tops out below the video windows', hex(m.stackTop));
  let last = 0, msg = '(never ran out)';
  try { for (;;) last = m.alloc(4096, 16) + 4096; } catch (e) { msg = e.message; }
  report(last <= 0xA0000 && msg.includes('static storage exhausted'),
    'dos16l data ends before 0xA0000, by name', `last byte ${hex(last)}; ${msg.slice(0, 34)}`);
}

// --- B. the arithmetic, executed
const PROBE = `#include <dos.h>
int main(void) {
  int bad = 0;
  unsigned long p;
  if ((unsigned long)MK_FP(0xB800, 0x10) != 0xB8010UL) bad |= 1;
  for (p = 0x10000UL; p < 0x9F000UL; p += 0x1234UL) {
    void *q = (void *)p;
    if ((unsigned long)FP_SEG(q) * 16 + FP_OFF(q) != p) bad |= 2;
    if (FP_OFF(q) >= 16) bad |= 4;
    if ((unsigned long)(FP_SEG(q) + (FP_OFF(q) + 15) / 16) * 16 != ((p + 15) & ~15UL)) bad |= 8;
  }
  return bad;
}`;
const FLAT = `#include <dos.h>
int main(void) {
  void *q = (void *)0x12345;
  return (FP_SEG(q) != 0) | ((FP_OFF(q) != (unsigned)0x12345) << 1) | (((unsigned long)MK_FP(7, 9) != 9) << 2);
}`;
const run = (source, defines) => compileProgram([{ file: 'rm.c', source }],
  { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, defines }).run(['rm']).code;
{
  const code = run(PROBE, { __PRISM_REALMODE__: '1' });
  report(code === 0, 'real-mode FP_SEG/FP_OFF/MK_FP, executed', `exit ${code} (bits: 1 MK_FP, 2 round trip, 4 FP_OFF<16, 8 paragraph)`);
  const flat = run(FLAT, {});
  report(flat === 0, 'without it, the flat DJGPP meaning stays', `exit ${flat}`);
}

// --- C. the model chooses
for (const [model, want] of [['dos16l', true], ['dos16', true], ['i386', false]]) {
  const text = new Preprocessor({ defines: modelDefines(model), resolve: builtinHeaderResolver() })
    .run('#include <dos.h>\nFP_SEG(x)\n', 'c.c').map((t) => t.v).join(' ');
  const real = text.includes('>> 4');
  report(real === want, `${model} gets the ${want ? 'real-mode' : 'flat'} FP_SEG`, real ? 'seg*16+off' : 'flat');
}

console.log(bad ? `\n${bad} WRONG` : '\nreal-mode far pointers: conventional memory, exact arithmetic, chosen by the model.');
process.exit(bad ? 1 : 0);
