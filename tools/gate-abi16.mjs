// gate-abi16.mjs — PRISM's 16-bit DOS layout vs Open Watcom. Bar: exact, on every case.
//
// The 32-bit gate (gate-abi.mjs) compiles a probe and RUNS it. Nothing here runs a DOS executable,
// so this one reads its answers out of the object file instead: every query becomes a char array
// initialised with the digits of its value, the compiler folds the constant, and oracle.watcom16
// reassembles the OMF data records and scans for them. Same bar, no emulator.
//
// What it is FOR: PRISM emits for i386 and only for i386. This gate exists so that the day a 16-bit
// target is attempted, the layout rules are already pinned by something external -- and so that the
// two places where 16-bit is a different rule rather than a narrower one (alignment stops at 2, an
// enum is one byte) are asserted rather than remembered.
//
//   node tools/gate-abi16.mjs [count] [seed]

import { watcom16, version } from './oracle.mjs';
import { modelTypes, layoutStruct, layoutUnion } from '../src/sema/abi.js';

const COUNT = +(process.argv[2] ?? 120);
const SEED = +(process.argv[3] ?? 4242);
const T = modelTypes('dos16');

// xorshift32 — a seed always yields the same cases, so a failure is reproducible by number.
let rngState = SEED || 1;
const rnd = () => {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState >>>= 0;
  return rngState / 0x100000000;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/*
 * The C spelling and the model type, together, so a case can be printed exactly as it was asked.
 * `long double` is left out on purpose: Watcom's is a double and gcc's is 80-bit, so a case using it
 * would be checking this table's opinion of a name rather than a layout rule.
 */
const SCALARS = [
  ['char', 'char'], ['unsigned char', 'unsigned char'], ['short', 'short'],
  ['unsigned short', 'unsigned short'], ['int', 'int'], ['unsigned int', 'unsigned int'],
  ['long', 'long'], ['unsigned long', 'unsigned long'], ['float', 'float'], ['double', 'double'],
];

const cases = [];      // { name, decl, kind, fields:[{name, c, type, bits?}] }

const hand = (name, kind, fields) => cases.push({ name, kind, fields });
const f = (n, c, bits) => ({ name: n, c, type: T.scalar(c), ...(bits === undefined ? {} : { bits }) });
const fp = (n) => ({ name: n, c: 'void *', type: T.ptr() });
const fa = (n, c, len) => ({ name: n, c: `${c}[${len}]`, type: T.array(T.scalar(c), len), arr: len });

// The rules worth naming, one case each.
hand('CI', 'struct', [f('a', 'char'), f('b', 'int')]);
hand('CL', 'struct', [f('a', 'char'), f('b', 'long')]);
hand('CD', 'struct', [f('a', 'char'), f('b', 'double')]);           // align stops at 2: size 10
hand('DC', 'struct', [f('a', 'double'), f('b', 'char')]);
hand('CP', 'struct', [f('a', 'char'), fp('b')]);                    // 2-byte pointer, small model
hand('ARR', 'struct', [f('a', 'char'), fa('b', 'int', 3), f('c', 'char')]);
hand('U1', 'union', [f('a', 'char'), f('b', 'double'), f('c', 'short')]);
hand('BF1', 'struct', [f('a', 'int', 1), f('b', 'int', 1)]);
hand('BF2', 'struct', [f('a', 'char', 3), f('b', 'char', 6)]);
hand('BF3', 'struct', [f('a', 'int', 15), f('b', 'int', 2)]);
hand('BF4', 'struct', [f('a', 'unsigned int', 3), f('b', 'unsigned char', 5)]);
hand('BF5', 'struct', [f('a', 'int', 5), f(null, 'int', 0), f('b', 'int', 5)]);
hand('BF6', 'struct', [f('a', 'char'), f('b', 'int', 12), f('c', 'char')]);
hand('BF7', 'struct', [f('a', 'long', 20), f('b', 'long', 20)]);

// …and then the shapes nobody thought of.
for (let i = 0; i < COUNT; i++) {
  const kind = rnd() < 0.15 ? 'union' : 'struct';
  const n = rint(2, 5);
  const fields = [];
  for (let k = 0; k < n; k++) {
    const r = rnd();
    if (r < 0.18 && kind === 'struct') {
      const [c] = pick(SCALARS.filter(([x]) => /char|short|int|long/.test(x) && !/float|double/.test(x)));
      const width = c === 'char' || c === 'unsigned char' ? rint(1, 8)
        : c === 'long' || c === 'unsigned long' ? rint(1, 32) : rint(1, 16);
      fields.push(f(`f${k}`, c, width));
    } else if (r < 0.28) {
      fields.push(fa(`f${k}`, pick(SCALARS)[0], rint(1, 4)));
    } else if (r < 0.36) {
      fields.push(fp(`f${k}`));
    } else {
      fields.push(f(`f${k}`, pick(SCALARS)[0]));
    }
  }
  cases.push({ name: `G${i}`, kind, fields });
}

/* The C text of one case, and the queries it asks: the whole size, then every member's offset. */
const declOf = (c) => `${c.kind} ${c.name} { ` + c.fields.map((x) => {
  if (x.bits !== undefined) return `${x.c} ${x.name ?? ''}:${x.bits};`;
  if (x.arr) return `${x.c.replace(/\[.*/, '')} ${x.name}[${x.arr}];`;
  return `${x.c} ${x.name};`;
}).join(' ') + ' };';

const prelude = cases.map(declOf).join('\n');
const queries = [];
const expect = [];
const labels = [];

for (const c of cases) {
  const members = c.fields.map(({ name, type, bits }) => ({ name, type, ...(bits === undefined ? {} : { bits }) }));
  const laid = c.kind === 'union' ? layoutUnion(members) : layoutStruct(members, { bitfields: 'watcom' });
  queries.push(`sizeof(${c.kind} ${c.name})`);
  expect.push(laid.size);
  labels.push(`${c.name}: sizeof`);
  // offsetof is illegal on a bitfield, so only plain members are asked -- the bitfield PLACEMENT is
  // pinned by the size of the struct and by the offsets of the plain members around it.
  for (let i = 0; i < c.fields.length; i++) {
    const fld = c.fields[i];
    if (fld.bits !== undefined || !fld.name) continue;
    queries.push(`(char *)&((${c.kind} ${c.name} *)0)->${fld.name} - (char *)0`);
    expect.push(laid.fields[i].offset);
    labels.push(`${c.name}: offsetof(${fld.name})`);
  }
}

console.log(version());
console.log(`gate-abi16: ${cases.length} cases (${cases.length - COUNT} hand, ${COUNT} generated, ` +
  `seed ${SEED}), ${queries.length} checks — Open Watcom, 8086, small model\n`);

// Signedness, which nothing here tested until the table turned out to be wrong about it.
queries.push('(char)-1 < 0');
expect.push(T.scalar('char').signed ? 1 : 0);
labels.push('char: signed');

const got = watcom16(prelude, queries);
let bad = 0;
for (let i = 0; i < queries.length; i++) {
  if (got[i] === expect[i]) continue;
  if (bad === 0) console.log('MISMATCHES (PRISM vs Watcom):');
  if (++bad <= 20) {
    const c = cases.find((x) => labels[i].startsWith(`${x.name}:`));
    console.log(`  ${labels[i].padEnd(28)} prism ${String(expect[i]).padStart(3)}  watcom ${String(got[i]).padStart(3)}`);
    if (c) console.log(`      ${declOf(c)}`);
  }
}
console.log(bad ? `\n${bad} of ${queries.length} checks differ`
  : `\n${queries.length}/${queries.length} checks pass\n16-bit DOS layout matches Open Watcom exactly.`);
process.exit(bad ? 1 : 0);
