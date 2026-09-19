// gate-segmodel.mjs — a 16-bit segmented pointer must never reach an answer.
//
// The parser accepts Borland's `_seg` and `huge` so a 16-bit program can be surveyed, and gives
// the pointer the flat placeholder size of 4 because every path expects a pointer to have one.
// This gate is what makes that placeholder safe: every way a function can reach such a pointer
// -- sizeof, a parameter, a struct member, a local, a CALL to a function that takes one -- must
// come back refused by name. The plain function must still emit and `huge` must still be usable
// as an ordinary identifier, or the refusal is too eager. Remove the refusal and five cases go red.
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
int plain(void)              { return huge + 1; }
`;

const want = {
  by_sizeof: 'refused', by_param: 'refused', by_member: 'refused',
  by_local: 'refused', by_call: 'refused', plain: 'emits',
};

let p;
try {
  p = compileProgram([{ file: 'seg.c', source }], {
    resolve: builtinHeaderResolver({}), memory: 8 * 1024 * 1024, collect: true,
  });
} catch (e) {
  console.log(`the whole compile stopped: ${e.message}`);
  process.exit(1);
}

const failed = new Map((p.failures ?? []).map(f => [f.fn ?? f.name ?? f.function, f.message]));
let bad = 0;
for (const [fn, expect] of Object.entries(want)) {
  const got = failed.has(fn) ? 'refused' : 'emits';
  const ok = got === expect;
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${fn.padEnd(10)} ${got}${failed.has(fn) ? `  — ${failed.get(fn)}` : ''}`);
}
console.log(bad ? `\n${bad} WRONG` : '\nall six behave');
if (!failed.size) console.log('(failure records: none at all — check the field names before trusting this)');
else console.log(`(failure record keys: ${Object.keys(p.failures[0]).join(', ')})`);
process.exit(bad ? 1 : 0);
