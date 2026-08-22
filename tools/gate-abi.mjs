// gate-abi.mjs — PRISM's struct layout vs a real i386 gcc. Bar: exact, on every case.
//
// Two kinds of case, following MIRAGE's x86-gen lesson ("the generator does not think"): a battery
// of hand-written shapes for the rules I know about, plus seeded random structs for the corners I
// did not think of. Everything is batched into ONE C program, so the whole gate costs one compile.
//
// Bitfields are checked by OBSERVATION, not by offsetof (which C forbids on a bitfield): the probe
// zeroes the struct, writes all-ones into one field, and dumps the bytes. The resulting bit pattern
// pins the exact placement — the only ground truth there is.
//
//   node tools/gate-abi.mjs [count] [seed]

import { compileRun, version } from './oracle.mjs';
import { scalar, ptr, array, layoutStruct, layoutUnion } from '../src/sema/abi.js';
import { withAlign, withExactAlign } from '../src/sema/types.js';

const COUNT = +(process.argv[2] ?? 300);
const SEED = +(process.argv[3] ?? 12345);

// xorshift32 — deterministic, so a seed always yields the same cases (no Math.random anywhere).
let rngState = SEED || 1;
const rnd = () => {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState >>>= 0;
  return rngState / 0x100000000;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const SCALAR_NAMES = ['char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int',
  'long', 'long long', 'float', 'double', 'long double'];
const BITFIELD_NAMES = ['char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'long', 'long long', 'unsigned long long'];

// ---------------------------------------------------------------- cases

/** A case = {tag, cdecl, layout, kind}. `layout` is PRISM's answer, to be diffed. */
const cases = [];
let uid = 0;

function addStruct(tag, members, { union = false, packed = false, aligned = 0 } = {}) {
  // members: [{name, ctype, bits?, arr?, aligned?}]
  const decl = members.map(m => {
    const nm = m.name ?? '';
    const bits = [];
    if (m.mpacked) bits.push('packed');
    if (m.aligned) bits.push(`aligned(${m.aligned})`);
    const at = bits.length ? ` __attribute__((${bits.join(',')}))` : '';
    if (m.bits !== undefined) return `  ${m.ctype} ${nm}:${m.bits}${at};`;
    if (m.arr) return `  ${m.ctype} ${nm}[${m.arr}]${at};`;
    return `  ${m.ctype} ${nm}${at};`;
  }).join('\n');
  const kw = union ? 'union' : 'struct';
  const attr = (packed ? ' __attribute__((packed))' : '') + (aligned ? ` __attribute__((aligned(${aligned})))` : '');
  const cdecl = `${kw} ${tag} {\n${decl}\n}${attr};`;

  const fields = members.map(m => {
    let type = m.ctype === 'void *' ? ptr() : scalar(m.ctype);
    if (m.arr) type = array(type, m.arr);
    if (m.mpacked) type = withExactAlign(type, 1);
    if (m.aligned) type = withExactAlign(type, m.aligned);
    return m.bits !== undefined ? { name: m.name, type, bits: m.bits } : { name: m.name, type };
  });
  let layout = (union ? layoutUnion : layoutStruct)(fields, { packed });
  if (aligned) layout = withAlign(layout, aligned);
  cases.push({ tag, cdecl, members, layout, union, packed, aligned });
}

// --- hand-written: the rules I believe I know
addStruct('h_ci', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'int' }]);
addStruct('h_cs', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'short' }]);
addStruct('h_cll', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'long long' }]);
addStruct('h_cd', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'double' }]);
addStruct('h_dc', [{ name: 'a', ctype: 'double' }, { name: 'b', ctype: 'char' }]);
addStruct('h_cld', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'long double' }]);
addStruct('h_arr', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'int', arr: 3 }, { name: 'c', ctype: 'char' }]);
addStruct('h_pk', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'int' }], { packed: true });
addStruct('h_pk2', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'double' }, { name: 'c', ctype: 'short' }], { packed: true });
addStruct('h_un', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'double' }, { name: 'c', ctype: 'short' }], { union: true });
// A bitfield in a UNION starts at bit 0 but still needs its placement recorded; the generator
// never produced one, so the whole class was untested until gcc's bitfld-6.c failed.
addStruct('h_ub1', [{ name: 'a', ctype: 'int' }, { name: 'b', ctype: 'unsigned int', bits: 20 }], { union: true });
addStruct('h_ub2', [{ name: 'a', ctype: 'char', bits: 5 }, { name: 'b', ctype: 'short', bits: 12 }], { union: true });
addStruct('h_mp1', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'double', mpacked: true }]);
addStruct('h_mp2', [{ name: 'a', ctype: 'short', mpacked: true, aligned: 2 }, { name: 'b', ctype: 'double', mpacked: true, aligned: 2 }]);
addStruct('h_mp3', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'int', mpacked: true, aligned: 8 }]);
addStruct('h_al1', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'int', aligned: 16 }]);
addStruct('h_al2', [{ name: 'a', ctype: 'int', aligned: 8 }]);
addStruct('h_al3', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'short' }], { aligned: 32 });
addStruct('h_al4', [{ name: 'a', ctype: 'char', aligned: 4 }, { name: 'b', ctype: 'char' }]);
addStruct('h_bf1', [{ name: 'a', ctype: 'int', bits: 1 }, { name: 'b', ctype: 'int', bits: 1 }]);
addStruct('h_bf2', [{ name: 'a', ctype: 'char', bits: 3 }, { name: 'b', ctype: 'char', bits: 6 }]);
addStruct('h_bf3', [{ name: 'a', ctype: 'int', bits: 31 }, { name: 'b', ctype: 'int', bits: 2 }]);
addStruct('h_bf4', [{ name: 'a', ctype: 'unsigned int', bits: 3 }, { name: 'b', ctype: 'unsigned char', bits: 5 }]);
addStruct('h_bf5', [{ name: 'a', ctype: 'int', bits: 5 }, { name: null, ctype: 'int', bits: 0 }, { name: 'b', ctype: 'int', bits: 5 }]);
addStruct('h_bf6', [{ name: 'a', ctype: 'char' }, { name: 'b', ctype: 'int', bits: 20 }, { name: 'c', ctype: 'char' }]);
addStruct('h_bf7', [{ name: 'a', ctype: 'short', bits: 9 }, { name: 'b', ctype: 'short', bits: 9 }, { name: 'c', ctype: 'char', bits: 3 }]);

// --- generated: the corners I did not think of
for (let i = 0; i < COUNT; i++) {
  const union = rnd() < 0.15;
  const packed = !union && rnd() < 0.2;
  const aligned = !packed && rnd() < 0.15 ? [2, 4, 8, 16, 32][rint(0, 4)] : 0;
  const n = rint(2, 5);
  const members = [];
  for (let j = 0; j < n; j++) {
    const bf = rnd() < (union ? 0.25 : 0.45);
    if (bf) {
      const ctype = pick(BITFIELD_NAMES);
      const maxw = ({ 'char': 8, 'unsigned char': 8, 'short': 16, 'unsigned short': 16, 'long long': 64, 'unsigned long long': 64 })[ctype] ?? 32;
      // Zero-width bitfields must be unnamed, and only make sense between two others.
      if (rnd() < 0.08 && j > 0 && j < n - 1) members.push({ name: null, ctype, bits: 0 });
      else members.push({ name: `f${j}`, ctype, bits: rint(1, maxw) });
    } else {
      const ctype = pick(SCALAR_NAMES);
      if (rnd() < 0.15) members.push({ name: `f${j}`, ctype, arr: rint(1, 4) });
      else members.push({ name: `f${j}`, ctype });
    }
  }
  if (!members.some(m => m.name)) members.push({ name: 'f9', ctype: 'int' });
  addStruct(`g_${uid++}`, members, { union, packed, aligned });
}

// ---------------------------------------------------------------- the probe program

const decls = [];
const stmts = [];
for (const c of cases) {
  const kw = c.union ? 'union' : 'struct';
  decls.push(c.cdecl);
  // size, and the ABI alignment measured the way a struct actually experiences it: the offset a
  // char forces the struct to inside an enclosing struct. __alignof__ would answer the *preferred*
  // alignment, which is a different question (it reports 8 for double on i386).
  decls.push(`struct probe_${c.tag} { char pad; ${kw} ${c.tag} inner; };`);
  stmts.push(`  printf("${c.tag}|size=%u|abialign=%u", (unsigned)sizeof(${kw} ${c.tag}),` +
    ` (unsigned)__builtin_offsetof(struct probe_${c.tag}, inner));`);
  for (const m of c.members) {
    if (m.bits !== undefined || !m.name) continue;
    stmts.push(`  printf("|o.${m.name}=%u", (unsigned)__builtin_offsetof(${kw} ${c.tag}, ${m.name}));`);
  }
  stmts.push(`  printf("\\n");`);

  // Bitfield placement, by observation.
  for (const m of c.members) {
    if (m.bits === undefined || m.bits === 0 || !m.name) continue;
    stmts.push(`  { ${kw} ${c.tag} v; memset(&v, 0, sizeof v); v.${m.name} = ~0;` +
      ` printf("${c.tag}.${m.name}|"); dump(&v, sizeof v); }`);
  }
}

const program = `#include <stdio.h>
#include <string.h>
static void dump(const void *p, unsigned n) {
  unsigned i; for (i = 0; i < n; i++) printf("%02x", ((const unsigned char *)p)[i]);
  printf("\\n");
}
${decls.join('\n')}
int main(void) {
${stmts.join('\n')}
  return 0;
}
`;

// ---------------------------------------------------------------- compare

/** The byte pattern PRISM predicts for "this bitfield set to all ones". */
function predictBytes(c, field) {
  const f = c.layout.byName[field];
  const bytes = new Uint8Array(c.layout.size);
  for (let b = 0; b < f.width; b++) {
    const bit = f.bitOffset + b;                    // little-endian bit numbering within the struct
    bytes[bit >> 3] |= 1 << (bit & 7);
  }
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

console.log(version());
console.log(`gate-abi: ${cases.length} cases (${cases.length - COUNT} hand, ${COUNT} generated, seed ${SEED})`);

const r = compileRun(program, { std: 'gnu99' });
if (r.code !== 0) {
  console.error('probe program failed to compile/run:\n' + r.stderr.split('\n').slice(0, 20).join('\n'));
  process.exit(2);
}

const byTag = new Map(cases.map(c => [c.tag, c]));
const fails = [];
let checks = 0;

for (const line of r.stdout.trim().split('\n')) {
  const parts = line.split('|');
  const head = parts[0];

  if (head.includes('.')) {                          // a bitfield byte dump
    const [tag, field] = head.split('.');
    const c = byTag.get(tag);
    const got = parts[2] ?? parts[1];
    const want = predictBytes(c, field);
    checks++;
    if (got !== want) fails.push({ tag, what: `bitfield ${field} placement`, want, got, c });
    continue;
  }

  const c = byTag.get(head);
  if (!c) continue;
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=');
    const n = +v;
    checks++;
    if (k === 'size') {
      if (c.layout.size !== n) fails.push({ tag: head, what: 'size', want: c.layout.size, got: n, c });
    } else if (k === 'abialign') {
      if (c.layout.align !== n) fails.push({ tag: head, what: 'align', want: c.layout.align, got: n, c });
    } else if (k.startsWith('o.')) {
      const fn = k.slice(2);
      const off = c.layout.byName[fn]?.offset;
      if (off !== n) fails.push({ tag: head, what: `offset ${fn}`, want: off, got: n, c });
    }
  }
}

console.log(`${checks - fails.length}/${checks} checks pass`);
if (fails.length) {
  console.log(`\n${fails.length} divergence(s) — first 10, gcc is right by construction:\n`);
  for (const f of fails.slice(0, 10)) {
    console.log(f.c.cdecl);
    console.log(`  ${f.what}: prism=${f.want}  gcc=${f.got}\n`);
  }
  process.exit(1);
}
console.log('ABI layout matches i386 gcc exactly.');
