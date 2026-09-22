// gate-abi16l.mjs — the 16-bit LARGE model, against the same oracle as the small one.
//
// dos16l is dos16 with two entries changed: a pointer is four bytes, and char is unsigned. It would
// be easy to argue that everything else follows -- the layout algorithm is shared and gate-abi16
// already holds it over ~4,970 checks in the small model -- but "follows" is a deduction, and the
// place a four-byte pointer changes an answer is inside a struct, where it moves every field after
// it. So this asks Open Watcom directly, with `wcc -bt=dos -0 -ml`.
//
// The alignment is the part worth watching: a four-byte pointer aligns to TWO, because alignment
// stops at 2 in 16-bit DOS. A struct { char; void*; } is therefore 6 bytes and not 8, which is what
// an i386 habit would predict.
import { modelTypes, layoutStruct } from '../src/sema/abi.js';
import { watcom16, version } from './oracle.mjs';

const T = modelTypes('dos16l');

/** name -> the C members, in order. */
const CASES = {
  CP: [['c', 'char'], ['p', 'void *']],
  PC: [['p', 'void *'], ['c', 'char']],
  CPI: [['c', 'char'], ['p', 'void *'], ['i', 'int']],
  PP: [['p', 'void *'], ['q', 'char *']],
  ICP: [['i', 'int'], ['c', 'char'], ['p', 'void *']],
  LP: [['l', 'long'], ['p', 'void *']],
  CDP: [['c', 'char'], ['d', 'double'], ['p', 'void *']],
};

const typeOf = (c) => (c.endsWith('*') ? T.ptr(null) : T.scalar(c));

const prelude = Object.entries(CASES)
  .map(([n, fs]) => `struct ${n} { ${fs.map(([m, c]) => `${c} ${m};`).join(' ')} };`).join('\n');

const queries = [];
const expect = [];
const labels = [];
for (const [n, fs] of Object.entries(CASES)) {
  const lay = layoutStruct(fs.map(([m, c]) => ({ name: m, type: typeOf(c) })), {});
  queries.push(`sizeof(struct ${n})`);
  expect.push(lay.size);
  labels.push(`${n}: sizeof`);
  for (const f of fs) {
    queries.push(`(int)&((struct ${n}*)0)->${f[0]}`);
    expect.push(lay.fields.find((x) => x.name === f[0]).offset);
    labels.push(`${n}.${f[0]}: offset`);
  }
}
// The two entries that make this model a different one.
queries.push('sizeof(void*)'); expect.push(4); labels.push('sizeof(void*)');
queries.push('(char)-1 < 0'); expect.push(T.scalar('char').signed ? 1 : 0); labels.push('char: signed');

console.log(version());
console.log(`gate-abi16l: ${Object.keys(CASES).length} structs, ${queries.length} checks ` +
  '— Open Watcom, 8086, LARGE model\n');

const got = watcom16(prelude, queries, { model: 'ml' });
let bad = 0;
for (let i = 0; i < queries.length; i++) {
  if (got[i] === expect[i]) continue;
  if (bad === 0) console.log('MISMATCHES (PRISM vs Watcom):');
  if (++bad <= 20) {
    console.log(`  ${labels[i].padEnd(20)} prism ${String(expect[i]).padStart(3)}  watcom ${String(got[i]).padStart(3)}`);
  }
}
console.log(bad ? `\n${bad} of ${queries.length} checks differ`
  : `\n${queries.length}/${queries.length} checks pass\n16-bit DOS LARGE layout matches Open Watcom exactly.`);
process.exit(bad ? 1 : 0);
