// gate-farobj.mjs — an object declared `far` lives outside DGROUP.
//
// Under the medium model a near pointer is an offset in DGROUP, placed at linear 0, so everything a
// near pointer reaches -- statics, the near heap, the stack -- must fit below 0x10000. An object
// declared `far` is not reached that way: `mmblocktype far mmblocks[MAXBLOCKS]` sits in a far data
// segment and is addressed with far pointers. Keen Dreams' seven defined far objects are its biggest
// buffers, and left in DGROUP they overflow it.
//
// So: under dos16m a far object is placed from 0x10000 up, a plain one below; together they can
// exceed 64K and still build; the far segment running out is refused by name; the far mark survives
// an earlier `extern` declaration; and under i386, where `far` says nothing, nothing moves.
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

let bad = 0;
const report = (ok, what, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(46)} ${detail}`);
};
const build = (source, model) => {
  try {
    const p = compileProgram([{ file: 'f.c', source }],
      { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model });
    return { mod: p.M.mod };
  } catch (e) { return { err: e.message.split('\n')[0] }; }
};
const addr = (b, n) => b.mod?.symbols.get(n)?.addr;
const hex = (n) => (n === undefined ? '(none)' : `0x${n.toString(16)}`);

const SRC = `extern char far later[16];
char far big[40000];
char near_one[30000];
char far later[16];
int f(void) { return big[0] + near_one[0] + later[0]; }`;

{
  const b = build(SRC, 'dos16m');
  report(!b.err, 'dos16m: 70,000 bytes of statics build', b.err ?? 'built');
  report(addr(b, 'big') >= 0x10000, 'dos16m: the far object is outside DGROUP', hex(addr(b, 'big')));
  report(addr(b, 'near_one') < 0x10000, 'dos16m: the plain one is inside it', hex(addr(b, 'near_one')));
  report(addr(b, 'later') >= 0x10000, 'dos16m: far survives an earlier extern', hex(addr(b, 'later')));
}
{
  const b = build('char far huge1[400000]; char far huge2[400000]; int f(void) { return 0; }', 'dos16m');
  report(!!b.err && b.err.includes('far storage exhausted'), 'dos16m: far segment exhausted, by name',
    (b.err ?? 'built').slice(0, 60));
}
{
  const b = build(SRC, 'i386');
  report(!b.err && addr(b, 'big') < addr(b, 'near_one'), 'i386: far says nothing, declaration order holds',
    `${hex(addr(b, 'big'))} < ${hex(addr(b, 'near_one'))}`);
}

console.log(bad ? `\n${bad} WRONG` : '\nfar objects live outside DGROUP, and only where a model has one.');
process.exit(bad ? 1 : 0);
