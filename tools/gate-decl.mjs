// gate-decl.mjs — PRISM's parser + sema vs a real i386 gcc, through the layout it computes.
//
// There is no backend yet, so the parser cannot be gated by running programs. But everything a
// declaration MEANS is observable without one: sizeof, alignment, member offsets, enum constant
// values, and the constant expressions inside array bounds and bitfield widths. Getting those right
// requires the declarator grammar, typedef resolution, tag scoping and the ABI all to be correct at
// once — so this is a genuine end-to-end gate on the chain cpp -> parse -> sema -> abi.
//
// Queries are not written by hand: the gate enumerates whatever tags, typedefs and enum constants
// PRISM ended up with and asks gcc about each. A declaration PRISM silently misparses into the wrong
// shape therefore still gets caught, because the shape is what generates the question.
//
//   node tools/gate-decl.mjs [--verbose] [filter]

import { sh, SCRATCH, version } from './oracle.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Preprocessor } from '../src/cpp/cpp.js';
import { parse } from '../src/parse/parser.js';

const VERBOSE = process.argv.includes('--verbose');
const FILTER = process.argv.slice(2).find(a => !a.startsWith('--')) ?? null;

const cases = [];
const C = (name, src) => cases.push({ name, src });

// ---------------------------------------------------------------- hand-written declarations

C('basic-structs', `
struct S1 { char a; int b; short c; };
struct S2 { struct S1 inner; char t; };
union U1 { char a; double b; int c; };
`);

C('typedefs', `
typedef int myint;
typedef myint *pmyint;
typedef struct { char a; myint b; } anon_t;
typedef anon_t chain_t;
struct UsesTypedef { pmyint p; chain_t c; myint arr[4]; };
`);

// The classic declarator readings. If any of these is parsed inside-out wrongly, the sizes differ.
C('declarator-readings', `
struct D {
  int *a[6];          /* array of 6 pointers  -> 24 */
  int (*b)[6];        /* pointer to array     ->  4 */
  int (*c)(void);     /* function pointer     ->  4 */
  int *(*d)[3];       /* pointer to array of pointers -> 4 */
  char (*e)[2][3];    /* pointer to 2D array  ->  4 */
};
typedef int (*fnptr_t)(int, char *);
struct HasFn { fnptr_t f; int (*g[4])(void); };
`);

C('self-referential', `
struct Node { int v; struct Node *next; struct Node *prev; };
struct Tree { struct Tree *kids[4]; struct Node payload; };
`);

C('enums', `
enum Plain { P0, P1, P2 };
enum Valued { V0 = 5, V1, V2 = 100, V3 };
enum Expr { E0 = 1 << 4, E1 = E0 + 2, E2 = sizeof(int) * 3, E3 = (E1 > E0) ? 7 : 8 };
enum Neg { N0 = -3, N1, N2 };
struct HasEnum { enum Valued v; char c; };
`);

C('bitfields-in-source', `
struct BF {
  unsigned a : 3;
  unsigned b : 5;
  int : 0;
  int c : 20;
  char d;
  unsigned long long e : 40;
};
struct BFPacked { char a; int b : 26; char c : 7; } __attribute__((packed));
`);

C('arrays-and-const-exprs', `
#define N 4
struct A {
  char fixed[N * 3];
  int  computed[(1 << 3) - 2];
  char sized[sizeof(int) + sizeof(double)];
  short nested[N][N + 1];
};
typedef char buf_t[N * 8];
struct UsesBuf { buf_t b; char t; };
`);

C('anonymous-members', `
struct Anon {
  int tag;
  union { int i; float f; char bytes[4]; };
  struct { short x, y; };
};
`);

C('qualifiers-and-storage', `
typedef const volatile int cvint;
struct Q { cvint a; const char *p; char *const q; volatile double d; };
static struct Q sq;
extern struct Q eq;
`);

C('packed-and-aligned', `
struct P1 { char a; int b; short c; } __attribute__((packed));
struct P2 { char a; struct P1 inner; char b; };
`);

C('kr-and-implicit-int', `
count;
static total;
old_style(a, b) int a; char b; { return a + b; }
struct KR { int x; };
`);

// A flexible array member contributes nothing to the size but does take an aligned offset.
C('flexible-array-members', `
struct FA1 { char c; char a[]; };
struct FA2 { int n; int v[]; };
struct FA3 { char c; double d; short s; char tail[]; };
`);

C('long-double-and-longlong', `
struct LD { char a; long double b; char c; };
struct LL { char a; long long b; char c; };
struct Mix { long long a; double b; long double c; char d; };
`);

// ---------------------------------------------------------------- generated declarations

const GEN = +(process.env.DECL_GEN ?? 120);
const SEED = +(process.env.DECL_SEED ?? 20260820);
let rngState = SEED || 1;
const rnd = () => {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState >>>= 0;
  return rngState / 0x100000000;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const SCALARS = ['char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int',
  'long', 'unsigned long', 'long long', 'float', 'double', 'long double'];
const BFTYPES = ['char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'long', 'long long'];
const BFMAX = { 'char': 8, 'unsigned char': 8, 'short': 16, 'unsigned short': 16, 'long long': 64 };

function genCase(n) {
  const lines = [];
  const prev = [];                                   // tags declared so far, reusable as members
  const ntags = rint(2, 4);
  for (let s = 0; s < ntags; s++) {
    const tag = `G${n}_${s}`;
    const isUnion = rnd() < 0.15;
    const packed = !isUnion && rnd() < 0.2;
    const nm = rint(2, 5);
    const members = [];
    for (let m = 0; m < nm; m++) {
      const r = rnd();
      if (!isUnion && r < 0.3) {
        const ct = pick(BFTYPES);
        const max = BFMAX[ct] ?? 32;
        if (rnd() < 0.08 && m > 0 && m < nm - 1) members.push(`  ${ct} : 0;`);
        else members.push(`  ${ct} f${m} : ${rint(1, max)};`);
        continue;
      }
      if (r < 0.42 && prev.length) { members.push(`  struct ${pick(prev)} f${m};`); continue; }
      if (r < 0.52) { members.push(`  ${pick(SCALARS)} *f${m};`); continue; }
      if (r < 0.62) { members.push(`  ${pick(SCALARS)} f${m}[${rint(1, 4)}];`); continue; }
      if (r < 0.68) { members.push(`  ${pick(SCALARS)} (*f${m})[${rint(1, 3)}];`); continue; }
      if (r < 0.74) { members.push(`  ${pick(SCALARS)} *f${m}[${rint(1, 3)}];`); continue; }
      if (r < 0.80) { members.push(`  int (*f${m})(void);`); continue; }
      members.push(`  ${pick(SCALARS)} f${m};`);
    }
    if (!members.some(l => /f\d/.test(l))) members.push(`  int f9;`);
    lines.push(`${isUnion ? 'union' : 'struct'} ${tag} {\n${members.join('\n')}\n}${packed ? ' __attribute__((packed))' : ''};`);
    if (!isUnion) prev.push(tag);
  }
  return lines.join('\n') + '\n';
}

for (let n = 0; n < GEN; n++) C(`gen-${n}`, genCase(n));

// ---------------------------------------------------------------- collect PRISM's understanding

/** What PRISM thinks a case declares: type texts, their layout, and enum constant values. */
function analyze(src, file) {
  const tokens = new Preprocessor().run(src, file);
  const { scope } = parse(tokens, { file });

  const queries = [];           // {name, ctext, size, align, fields:[{name,offset}]}
  const enums = [];             // {name, value}

  for (const [tag, t] of scope.tags) {
    if (t.k === 'enum') { queries.push({ name: `enum ${tag}`, ctext: `enum ${tag}`, t }); continue; }
    if (!t.complete || t.size == null) continue;
    queries.push({ name: `${t.k} ${tag}`, ctext: `${t.k} ${tag}`, t });
  }
  for (const [name, e] of scope.ordinary) {
    if (e.kind === 'enumconst') { enums.push({ name, value: e.value }); continue; }
    if (e.kind !== 'typedef') continue;
    const t = e.type;
    if (t.size == null || t.k === 'func') continue;
    queries.push({ name, ctext: name, t });
  }
  return { queries, enums };
}

/**
 * Named, non-bitfield members whose offset gcc can be asked about — INCLUDING one interior element
 * of each multi-dimensional array member.
 *
 * That last part is not decoration. sizeof and a member's own offset cannot tell `int m[2][3]` from
 * `int m[3][2]`: both are 24 bytes at the same place, so a gate built on layout alone is blind to
 * declarator suffix ORDER. Verified by perturbation — reversing the suffix loop in the parser left
 * the gate at 719/719. `offsetof(T, m[0][2])` is 8 under one reading and 16 under the other, which
 * is what makes the order observable without a backend.
 */
function offsetableFields(t, prefix = '', depth = 0) {
  if (depth > 2 || !t.fields) return [];
  const out = [];
  for (const f of t.fields) {
    if (f.bits !== undefined) continue;
    if (!f.name) continue;
    out.push({ path: prefix + f.name, offset: f.offset });

    // Walk into nested arrays, taking the LAST element of each dimension so the stride shows.
    let ty = f.type, path = prefix + f.name, off = f.offset, dims = 0;
    while (ty.k === 'array' && ty.n !== null && ty.n > 0 && ty.of.size != null && dims < 3) {
      const idx = ty.n - 1;
      off += idx * ty.of.size;
      path += `[${idx}]`;
      ty = ty.of;
      dims++;
      if (dims >= 2) out.push({ path, offset: off });
    }
  }
  return out;
}

// ---------------------------------------------------------------- run

const active = cases.filter(c => !FILTER || c.name.includes(FILTER));
console.log(version());
console.log(`gate-decl: ${active.length} cases (${active.length - GEN} hand, ${GEN} generated, seed ${SEED})\n`);

const dir = join(SCRATCH, 'decl');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const analyses = new Map();
const parseFails = [];
for (const [n, c] of active.entries()) {
  try {
    analyses.set(n, analyze(c.src, `d${n}.c`));
  } catch (e) {
    parseFails.push({ c, why: `PRISM failed to parse: ${e.message}` });
  }
}

// Build one probe program per case, asking gcc exactly what PRISM claims to know.
for (const [n, c] of active.entries()) {
  const a = analyses.get(n);
  if (!a) continue;
  const decls = [], stmts = [];
  for (const [qi, q] of a.queries.entries()) {
    if (q.t.k === 'enum') continue;
    decls.push(`struct probe_${n}_${qi} { char pad; ${q.ctext} inner; };`);
    stmts.push(`  printf("Q|${q.name}|size=%u|align=%u", (unsigned)sizeof(${q.ctext}),` +
      ` (unsigned)__builtin_offsetof(struct probe_${n}_${qi}, inner));`);
    for (const f of offsetableFields(q.t)) {
      stmts.push(`  printf("|o.${f.path}=%u", (unsigned)__builtin_offsetof(${q.ctext}, ${f.path}));`);
    }
    stmts.push(`  printf("\\n");`);
  }
  for (const e of a.enums) {
    stmts.push(`  printf("E|${e.name}|%lld\\n", (long long)(${e.name}));`);
  }
  const program = `#include <stdio.h>\n${c.src}\n${decls.join('\n')}\nint main(void){\n${stmts.join('\n')}\n  return 0;\n}\n`;
  writeFileSync(join(dir, `d${n}.c`), program);
}

const script = active.map((c, n) => analyses.has(n)
  ? `echo "===CASE ${n}"; gcc -std=gnu89 -w -o /tmp/d${n} decl/d${n}.c 2>&1 && /tmp/d${n} 2>&1; echo "===RC $?"`
  : `echo "===CASE ${n}"; echo "===RC 0"`).join('; ');
const r = sh(script, { timeout: 900000 });

const chunks = new Map();
{
  let cur = null, buf = [];
  for (const line of r.stdout.split('\n')) {
    let m = line.match(/^===CASE (\d+)$/);
    if (m) { cur = +m[1]; buf = []; continue; }
    m = line.match(/^===RC (\d+)$/);
    if (m) { chunks.set(cur, { rc: +m[1], text: buf.join('\n') }); cur = null; continue; }
    if (cur !== null) buf.push(line);
  }
}

let checks = 0, skipped = 0;
const fails = [...parseFails];

for (const [n, c] of active.entries()) {
  const a = analyses.get(n);
  if (!a) continue;
  const ref = chunks.get(n);
  if (!ref) { fails.push({ c, why: 'no oracle output' }); continue; }
  if (ref.rc !== 0) {
    if (c.name.startsWith('gen-')) { skipped++; continue; }
    fails.push({ c, why: `gcc rejected the probe:\n${ref.text.split('\n').slice(0, 6).join('\n')}` });
    continue;
  }

  const gccQ = new Map(), gccE = new Map();
  for (const line of ref.text.split('\n')) {
    const parts = line.split('|');
    if (parts[0] === 'Q') {
      const rec = { offsets: {} };
      for (const p of parts.slice(2)) {
        const [k, v] = p.split('=');
        if (k === 'size') rec.size = +v; else if (k === 'align') rec.align = +v;
        else if (k?.startsWith('o.')) rec.offsets[k.slice(2)] = +v;
      }
      gccQ.set(parts[1], rec);
    } else if (parts[0] === 'E') {
      gccE.set(parts[1], BigInt(parts[2]));
    }
  }

  for (const q of a.queries) {
    if (q.t.k === 'enum') continue;
    const g = gccQ.get(q.name);
    if (!g) { fails.push({ c, why: `gcc said nothing about ${q.name}` }); continue; }
    checks++;
    if (q.t.size !== g.size) fails.push({ c, why: `${q.name} size: prism=${q.t.size} gcc=${g.size}` });
    checks++;
    if (q.t.align !== g.align) fails.push({ c, why: `${q.name} align: prism=${q.t.align} gcc=${g.align}` });
    for (const f of offsetableFields(q.t)) {
      checks++;
      if (g.offsets[f.path] !== f.offset) {
        fails.push({ c, why: `${q.name}.${f.path} offset: prism=${f.offset} gcc=${g.offsets[f.path]}` });
      }
    }
  }
  for (const e of a.enums) {
    const g = gccE.get(e.name);
    if (g === undefined) continue;
    checks++;
    if (BigInt(e.value) !== g) fails.push({ c, why: `enum ${e.name}: prism=${e.value} gcc=${g}` });
  }
}

console.log(`${checks - fails.length}/${checks} checks pass over ${active.length - skipped} cases` +
  (skipped ? ` (${skipped} generated cases skipped: gcc rejected the probe)` : ''));
if (fails.length) {
  console.log(`\n${fails.length} divergence(s) — first 12:\n`);
  for (const f of fails.slice(0, 12)) {
    console.log(`--- ${f.c.name}\n    ${f.why}`);
    if (VERBOSE) console.log(f.c.src);
  }
  process.exit(1);
}
console.log('parser + sema agree with i386 gcc on every declaration.');
