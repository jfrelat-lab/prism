// gate-bits16.mjs — the BYTE IMAGE of a 16-bit DOS struct, against a real DOS run.
//
// WHAT THIS CHECKS THAT gate-abi16 CANNOT, and it is not a refinement -- it is the half that gate
// structurally cannot reach. `gate-abi16.mjs` asks the OBJECT FILE for sizeof and for the offset of
// every plain member, and its own comment concedes the gap:
//
//     offsetof is illegal on a bitfield, so only plain members are asked -- the bitfield PLACEMENT
//     is pinned by the size of the struct and by the offsets of the plain members around it.
//
// "Pinned by the size" pins WHICH UNIT a bitfield lands in and nothing about WHERE IN IT. Flip the
// allocation order inside every unit -- put the first field in the high bits instead of the low --
// and all ~4,970 of that gate's checks still pass. `layoutStruct` commits to an order all the same:
// `bitOffset = unitAt * 8 + unitUsed`, with `unitUsed` growing from zero. That is an assumption
// wearing the clothes of a measurement, and it is exactly the shape of a check that cannot fail.
//
// So this gate asks the only question that can fail it: give the compiler an INITIALISED object and
// read its bytes back. Nothing here can infer them -- a byte is a byte.
//
// It costs a real DOS execution, which is why it is a second gate rather than more cases in the
// first one: `oracle.watcomRun16` builds a DOS executable with Open Watcom in the container and runs
// it under headless DOSBox-X. One run covers every case, because a DOSBox session costs seconds and
// a struct costs nothing.
//
// The first run of it settled the order in one line -- `struct B { int a:3; int b:5; }` with {5, 9}
// is `4D`, which is 01001_101: field a in bits 0-2, field b above it. LSB-first, measured.
//
//   node tools/gate-bits16.mjs [count] [seed]

import { watcomRun16, version } from './oracle.mjs';
import { modelTypes, layoutStruct } from '../src/sema/abi.js';

const COUNT = +(process.argv[2] ?? 60);
const SEED = +(process.argv[3] ?? 20250909);
const T = modelTypes('dos16');

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
 * The integer types a bitfield may be declared with here, and the plain scalars a case may hold.
 * `float` and `double` are plain-only (C forbids a floating bitfield) and they are in because their
 * byte image is a fact about the compiler too: Watcom's DOS double is IEEE 754 little-endian, which
 * this gate asserts rather than assumes.
 */
const INTS = ['char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int',
  'long', 'unsigned long'];
const PLAIN = [...INTS, 'float', 'double'];

/*
 * VALUES, chosen to be ASYMMETRIC. A field holding 0xFF or 0 proves nothing about where its bits
 * went; 0b101 in three bits and 0b01001 in five land in distinguishable places whichever end the
 * allocator starts from. Every value is derived from the field's index so a failure is reproducible
 * and a case prints as it was asked.
 */
const bitPattern = (width, index, signed) => {
  // A run of alternating bits, offset by the field index so neighbours differ.
  let v = 0n;
  for (let i = 0; i < width; i++) if (((i + index) % 3) !== 0) v |= 1n << BigInt(i);
  if (!signed || width < 2) return v & ((1n << BigInt(width)) - 1n);
  // Half the signed fields carry a NEGATIVE value, because a sign bit in the wrong place is a
  // different defect from a magnitude in the wrong place.
  if (index % 2 === 0) return v & ((1n << BigInt(width)) - 1n);
  return -((v & ((1n << BigInt(width - 1)) - 1n)) + 1n);
};

const plainValue = (cname, index) => {
  if (cname === 'float') return { c: `${(index % 8) + 1}.25F`, num: (index % 8) + 1.25 };
  if (cname === 'double') return { c: `${(index % 8) + 1}.75`, num: (index % 8) + 1.75 };
  const size = T.scalar(cname).size;
  const base = size === 1 ? 0x11 : size === 2 ? 0x1234 : 0x12345678;
  // Kept inside the SIGNED range of the type whatever its signedness, so no case depends on an
  // implementation-defined conversion -- this gate is about placement, not about conversion.
  const v = (base + index * 7) % (2 ** (size * 8 - 1));
  return { c: size === 4 ? `0x${v.toString(16)}L` : `0x${v.toString(16)}`, num: BigInt(v) };
};

/* ------------------------------------------------------------------ the cases */

const cases = [];
const hand = (name, fields) => cases.push({ name, fields });
/** name, C type spelling, bit width (undefined = a plain member, 0 = the unit-closing `int :0`) */
const f = (n, c, bits) => ({ name: n, c, type: T.scalar(c), ...(bits === undefined ? {} : { bits }) });

// The rules this gate exists for, one case each, so a failure names the rule rather than a seed.
hand('ORDER', [f('a', 'int', 3), f('b', 'int', 5)]);              // 4D: LSB-first, the whole point
hand('SIGNBIT', [f('a', 'int', 5), f('b', 'int', 11)]);           // a negative field's sign bit
hand('FAMILY', [f('a', 'int', 3), f('b', 'unsigned int', 8)]);    // signedness stripped: one unit
hand('SPLIT', [f('a', 'unsigned int', 3), f('b', 'unsigned short', 11)]);  // NOT one unit
hand('CLOSE', [f('a', 'int', 5), f(null, 'int', 0), f('b', 'int', 5)]);    // `int :0` closes it
hand('BYTES', [f('a', 'char', 3), f('b', 'char', 6)]);            // two char units, not one
hand('WIDE', [f('a', 'long', 20), f('b', 'long', 20)]);           // a 32-bit unit, twice
hand('MIXED', [f('a', 'char'), f('b', 'int', 12), f('c', 'char')]);
hand('LONGNEG', [f('a', 'long', 28)]);
hand('FLOATS', [f('a', 'char'), f('b', 'float'), f('c', 'double')]);       // IEEE, little-endian

for (let i = 0; i < COUNT; i++) {
  const n = rint(2, 5);
  const fields = [];
  for (let k = 0; k < n; k++) {
    const r = rnd();
    if (r < 0.55) {
      const c = pick(INTS);
      const max = T.scalar(c).size * 8;
      fields.push(f(`f${k}`, c, rint(1, max)));
    } else if (r < 0.62 && k > 0) {
      fields.push(f(null, 'int', 0));
    } else {
      fields.push(f(`f${k}`, pick(PLAIN)));
    }
  }
  // A struct of nothing but a zero-width bitfield has no initialiser and nothing to compare.
  if (fields.every((x) => x.name === null)) { i--; continue; }
  cases.push({ name: `G${i}`, fields });
}

/* ------------------------------------------------------------------ the C program */

const declOf = (c) => `struct ${c.name} { ` + c.fields.map((x) =>
  (x.bits === undefined ? `${x.c} ${x.name};` : `${x.c} ${x.name ?? ''}:${x.bits};`)).join(' ') + ' };';

// Values are attached to the case so the C initialiser and PRISM's byte image are the SAME numbers.
let fieldIndex = 0;
for (const c of cases) {
  for (const fld of c.fields) {
    if (fld.name === null) continue;                 // `int :0` takes no initialiser
    const i = fieldIndex++;
    if (fld.bits === undefined) {
      const v = plainValue(fld.c, i);
      fld.init = v.c; fld.value = v.num;
    } else {
      const signed = !/^unsigned/.test(fld.c) && fld.c !== 'char' ? true : fld.c === 'char';
      const v = bitPattern(fld.bits, i, signed);
      fld.value = v;
      fld.init = T.scalar(fld.c).size === 4 ? `${v}L` : `${v}`;
    }
  }
}

const initOf = (c) => `struct ${c.name} ${c.name.toLowerCase()} = { ` +
  c.fields.filter((x) => x.name !== null).map((x) => x.init).join(', ') + ' };';

const source = `#include <stdio.h>
${cases.map(declOf).join('\n')}
${cases.map(initOf).join('\n')}
struct probe { char *name; unsigned size; unsigned char *at; };
struct probe probes[] = {
${cases.map((c) => `  { "${c.name}", sizeof(struct ${c.name}), (unsigned char *)&${c.name.toLowerCase()} }`).join(',\n')}
};
int main(void)
{
    unsigned i, j;
    for (i = 0; i < sizeof(probes) / sizeof(probes[0]); i++) {
        printf("%s %u", probes[i].name, probes[i].size);
        for (j = 0; j < probes[i].size; j++) printf(" %02X", probes[i].at[j]);
        printf("\\n");
    }
    return 0;
}
`;

/* ------------------------------------------------------------------ PRISM's byte image */

/**
 * Write one case's fields into a byte image, the way `layoutStruct`'s answer says they go.
 *
 * This is the INTERPRETATION of that answer, and it is the thing under test: `offset` and `size` for
 * a plain member, `bitOffset` and `width` for a bitfield, little-endian throughout and LSB-first
 * within the unit. Every byte not covered by a field is predicted ZERO, because the object has
 * static storage duration and the compiler emits its whole image -- padding included.
 *
 * Returns { bytes, covered } where `covered` marks the bits a field actually claims, so a
 * disagreement in padding can be reported as padding rather than as a misplaced field.
 */
function imageOf(c, laid) {
  const bytes = new Uint8Array(laid.size);
  const covered = new Uint8Array(laid.size * 8);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < c.fields.length; i++) {
    const fld = c.fields[i];
    const at = laid.fields[i];
    if (fld.name === null) continue;
    if (fld.bits === undefined) {
      const size = fld.type.size;
      if (fld.c === 'float') dv.setFloat32(at.offset, Number(fld.value), true);
      else if (fld.c === 'double') dv.setFloat64(at.offset, Number(fld.value), true);
      else {
        let v = BigInt(fld.value) & ((1n << BigInt(size * 8)) - 1n);
        for (let b = 0; b < size; b++) { bytes[at.offset + b] = Number(v & 0xffn); v >>= 8n; }
      }
      for (let b = 0; b < size * 8; b++) covered[at.offset * 8 + b] = 1;
      continue;
    }
    const v = BigInt(fld.value) & ((1n << BigInt(fld.bits)) - 1n);
    for (let b = 0; b < fld.bits; b++) {
      const bit = at.bitOffset + b;
      if ((v >> BigInt(b)) & 1n) bytes[bit >> 3] |= 1 << (bit & 7);
      covered[bit] = 1;
    }
  }
  return { bytes, covered };
}

/* ------------------------------------------------------------------ run and compare */

console.log(version());
console.log(`gate-bits16: ${cases.length} cases (${cases.length - COUNT} hand, ${COUNT} generated, ` +
  `seed ${SEED}) — Open Watcom 8086 small model, run under DOSBox-X\n`);

const run = watcomRun16(source, { timeout: 60 });
const observed = new Map();
for (const line of run.stdout.split(/\r?\n/)) {
  const m = line.trim().match(/^(\w+) (\d+)((?: [0-9A-F]{2})*)$/);
  if (m) observed.set(m[1], { size: +m[2], bytes: m[3].trim() ? m[3].trim().split(' ').map((x) => parseInt(x, 16)) : [] });
}
if (observed.size !== cases.length) {
  console.log(run.stdout.slice(0, 2000));
  throw new Error(`gate-bits16: the DOS run reported ${observed.size} of ${cases.length} cases`);
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
let badSize = 0, badField = 0, badPad = 0, bits = 0;
const report = [];

for (const c of cases) {
  const laid = layoutStruct(
    c.fields.map(({ name, type, bits }) => ({ name, type, ...(bits === undefined ? {} : { bits }) })),
    { bitfields: 'watcom' });
  const got = observed.get(c.name);
  if (got.size !== laid.size) {
    badSize++;
    if (report.length < 20) report.push(`  ${c.name}: sizeof  prism ${laid.size}  watcom ${got.size}\n      ${declOf(c)}`);
    continue;                                  // a different size makes a byte diff meaningless
  }
  const { bytes, covered } = imageOf(c, laid);
  let fieldBad = false, padBad = false;
  for (let b = 0; b < laid.size * 8; b++) {
    const mine = (bytes[b >> 3] >> (b & 7)) & 1;
    const theirs = (got.bytes[b >> 3] >> (b & 7)) & 1;
    if (mine === theirs) continue;
    if (covered[b]) fieldBad = true; else padBad = true;
  }
  bits += laid.size * 8;
  if (fieldBad) badField++; else if (padBad) badPad++;
  if ((fieldBad || padBad) && report.length < 20) {
    report.push(`  ${c.name}: ${fieldBad ? 'FIELD BITS' : 'padding only'}\n` +
      `      ${declOf(c)}\n` +
      `      ${initOf(c)}\n` +
      `      prism  ${hex(bytes)}\n      watcom ${hex(got.bytes)}`);
  }
}

if (report.length) { console.log('MISMATCHES (PRISM vs Watcom):'); console.log(report.join('\n')); console.log(); }
const bad = badSize + badField + badPad;
console.log(`${cases.length - bad}/${cases.length} cases byte-identical, ${bits} bits compared` +
  (badSize ? `, ${badSize} wrong size` : '') +
  (badField ? `, ${badField} with a field bit in the wrong place` : '') +
  (badPad ? `, ${badPad} differing only in padding` : ''));
if (!bad) {
  console.log('16-bit DOS bitfield ALLOCATION ORDER, byte order and padding match Open Watcom exactly.');
}
process.exit(bad ? 1 : 0);
