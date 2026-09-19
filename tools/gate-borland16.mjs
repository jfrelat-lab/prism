// gate-borland16.mjs — Borland 16-bit constructs are parsed, and never answered.
//
// PRISM emits for i386 and only for i386. To SURVEY a 16-bit program (targets/keendreams.json) the
// parser accepts two Borland constructs it cannot give meaning to, and this gate is what keeps that
// acceptance from ever becoming a wrong answer:
//
//   _seg / huge pointers    given the flat placeholder size of 4, because every path expects a
//                           pointer to have one (types.js segPtr says why it cannot be left out)
//   asm <instruction>       Borland's statement form of inline assembly, kept as text
//
// Every way a function can reach either must come back REFUSED BY NAME: sizeof, a parameter, a
// struct member, a local, a call to a function that takes one, an asm line, an asm block. And the
// refusal must not be too eager: a plain function still emits, `huge` is still an ordinary
// identifier, and GNU `asm("")` / `asm volatile("")` -- the other meaning of the same keyword --
// still emit. Disable either refusal in the emitter and its cases go red -- checked, not assumed.
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const source = `
typedef void _seg *memptr;
typedef char huge *hptr;
struct S { memptr a; int b; };
int huge;                                   /* an ordinary variable called huge */

int by_sizeof(void)          { return sizeof(memptr); }
int by_param(memptr m)       { return 0; }
int by_member(struct S *s)   { return s->b; }
int by_local(void)           { hptr h = 0; return 0; }
int by_call(void)            { return by_param(0); }
int by_asmline(void)         {
  asm mov ax,1
  return 0;
}
int by_asmblock(void)        {
  asm {
    mov ax,1
    mov bx,2
  }
  return 0;
}
int gnu_asm(void)            { asm(""); return 1; }
int gnu_volatile(void)       { asm volatile(""); return 1; }
int plain(void)              { return huge + 1; }
`;

// A refusal must be the NAMED one, not merely a refusal: with the emitter's asm check disabled,
// the statement switch still refuses an unknown node ("statement 'asmborland'"), so a gate that
// only asked "refused?" stayed green under that mutation and tested nothing. The survey counts
// functions BY REASON, which is the other reason the reason has to be right.
const SEG = '16-bit', ASM = 'Borland inline assembly';
const want = {
  by_sizeof: SEG, by_param: SEG, by_member: SEG, by_local: SEG, by_call: SEG,
  by_asmline: ASM, by_asmblock: ASM,
  gnu_asm: 'emits', gnu_volatile: 'emits', plain: 'emits',
};

let p;
try {
  p = compileProgram([{ file: 'borland16.c', source }], {
    resolve: builtinHeaderResolver({}), memory: 8 * 1024 * 1024, collect: true,
  });
} catch (e) {
  console.log(`the whole compile stopped: ${e.message}`);
  process.exit(1);
}

const failed = new Map((p.failures ?? []).map(f => [f.fn, f.message]));
if (!(p.failures ?? []).every(f => 'fn' in f)) {
  console.log('failure records carry no `fn` -- this gate cannot tell refused from emitted');
  process.exit(1);
}
let bad = 0;
for (const [fn, expect] of Object.entries(want)) {
  const msg = failed.get(fn);
  const got = msg === undefined ? 'emits' : 'refused';
  const ok = expect === 'emits' ? got === 'emits' : (got === 'refused' && msg.includes(expect));
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${fn.padEnd(13)} ${got}` +
    (failed.has(fn) ? `  — ${failed.get(fn).replace('tier-0 does not support ', '')}` : ''));
}
console.log(bad ? `\n${bad} of ${Object.keys(want).length} WRONG`
  : `\nBorland 16-bit constructs are parsed and never answered: ${Object.keys(want).length}/${Object.keys(want).length}`);
process.exit(bad ? 1 : 0);
