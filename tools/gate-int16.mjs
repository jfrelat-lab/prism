// gate-int16.mjs — integer arithmetic and conversions at the WIDTHS of a 16-bit model, against Watcom.
//
// Under dos16/dos16m/dos16l an int is two bytes. A value of type int must therefore be a 16-bit value
// -- `(int)0xBEEF` is -16657, `32767 + 1` is -32768, `(unsigned)-1` is 65535 -- and nothing about
// JavaScript numbers or `|0` makes that happen by itself: before this gate existed, every one of those
// came out as its 32-bit answer.
//
// THE ORACLE is Open Watcom's 16-bit compiler, asked for constant expressions (tools/oracle.mjs
// watcom16): it folds them by the rules of ITS int, and writes the answer into the object file.
// PRISM gets the SAME expressions over VARIABLES holding the same values, so nothing is folded and
// every operator is executed, and the result is stored into a global of the expression's width and
// read back as raw bytes. The expressions are random trees over signed and unsigned char, short,
// int, unsigned, long and unsigned long: + - * / % << >> & | ^ ~ unary minus, the comparisons,
// ! && || ?:, and casts between all of them.
//
// CAPTURE ONCE, REPLAY FOREVER: `--capture` needs the oracle container and writes goldens/int16.json;
// a replay needs neither Docker nor Watcom.
//
//   node tools/gate-int16.mjs --capture
//   node tools/gate-int16.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'int16.json');
const CAPTURE = process.argv.includes('--capture');
const CASES = 600;

/*
 * NO `unsigned short`, and the reason is the oracle's, not PRISM's. Watcom's CONSTANT FOLDER promotes
 * an unsigned short to a signed int -- `(unsigned short)65535 > (signed char)-76` folds to 0 -- while
 * its CODE GENERATOR, on variables, sign-extends the char (cbw) and compares UNSIGNED (jna): 1, which
 * is also what C says when short and int are the same size, and what PRISM computes. The folder is
 * what this gate asks, so the type it gets wrong is left out; `unsigned` has the same width and the
 * same promotion, and keeps every path covered. (Its unary `+` has the same fault, see capture().)
 */
const TYPES = [
  { c: 'signed char', size: 1, signed: true }, { c: 'unsigned char', size: 1, signed: false },
  { c: 'short', size: 2, signed: true },
  { c: 'int', size: 2, signed: true }, { c: 'unsigned', size: 2, signed: false },
  { c: 'long', size: 4, signed: true }, { c: 'unsigned long', size: 4, signed: false },
];

function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s >>> 8; };
  const int = (n) => next() % n;
  return { int, pick: (a) => a[int(a.length)] };
}

/** A value for a type, biased to the edges where widths show. */
function leafValue(r, t) {
  const bits = t.size * 8;
  const max = t.signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const min = t.signed ? -(2 ** (bits - 1)) : 0;
  const edges = [0, 1, 2, max, max - 1, min, min + 1, t.signed ? -1 : max >> 1, 0x7f, 0x80, 0xff, 0x100];
  const v = r.int(3) ? r.pick(edges) : min + r.int(Math.min(max - min + 1, 0x7fffffff));
  return Math.max(min, Math.min(max, v));
}
/*
 * A type's minimum is written as `(-32767-1)`, never `-32768`: 32768 does not fit a 16-bit int, so
 * that literal is a LONG, and Watcom's folder then mishandles it -- `1 ? (unsigned char)((int)-32768)
 * : (unsigned)127` folds to 32768, where its generated code (mov al,dl / xor ah,ah) gives 0, as
 * PRISM does. Same value, no long on the way.
 */
const lit = (v, t) => {
  const suffix = t.size === 4 ? (t.signed ? 'L' : 'UL') : '';
  const min = t.signed ? -(2 ** (t.size * 8 - 1)) : null;
  if (v === min) return `(${v + 1}${suffix}-1)`;
  return `${v}${suffix}`;
};

/** A random expression: { text(leafRender) } over leaves numbered in `leaves`. */
function expr(r, leaves, depth) {
  if (depth === 0 || r.int(4) === 0) {
    const t = r.pick(TYPES);
    const k = leaves.length;
    leaves.push({ t, v: leafValue(r, t) });
    return (render) => render(k);
  }
  const kind = r.int(10);
  const a = expr(r, leaves, depth - 1);
  if (kind === 0) { const op = r.pick(['-', '~', '!']); return (R) => `(${op}${a(R)})`; }
  if (kind === 1) { const t = r.pick(TYPES); return (R) => `((${t.c})${a(R)})`; }
  const b = expr(r, leaves, depth - 1);
  // The arms are written `(x + 0)`: the same value, since C converts both to their common type,
  // and it steps round a Watcom FOLDING fault -- `1 ? (unsigned char)((int)(-32767-1)) :
  // (unsigned)127` folds to 32768, while the arm with `+ 0` folds to 0, as its code generator and
  // PRISM compute.
  if (kind === 2) { const c = expr(r, leaves, depth - 1); return (R) => `(${a(R)} ? (${b(R)} + 0) : (${c(R)} + 0))`; }
  const op = r.pick(['+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^', '<', '>', '<=', '>=', '==', '!=', '&&', '||']);
  // No division by zero, and shift counts in range for the promoted left operand.
  if (op === '/' || op === '%') return (R) => `(${a(R)} ${op} ((${b(R)}) | 1))`;
  if (op === '<<' || op === '>>') return (R) => `(${a(R)} ${op} ((${b(R)}) & 15))`;
  return (R) => `(${a(R)} ${op} ${b(R)})`;
}

function makeCases() {
  const cases = [];
  for (let k = 0; k < CASES; k++) {
    const r = rng(0x16b17 + k * 104729);
    const leaves = [];
    const e = expr(r, leaves, 1 + r.int(3));
    cases.push({
      leaves: leaves.map((l) => ({ c: l.t.c, v: l.v })),
      oracle: e((i) => `((${leaves[i].t.c})${lit(leaves[i].v, leaves[i].t)})`),
      prism: e((i) => `v${i}`),
    });
  }
  return cases;
}

function capture() {
  const { watcom16 } = awaitImport();
  const cases = makeCases();
  // Four questions per case: the width, then the unsigned bits in three decimal chunks.
  const qs = [];
  for (const c of cases) {
    // Read back WIDENED, never narrowed: `(unsigned long)((e) + 0)` promotes a char and sign- or
    // zero-extends by the expression's own type. Storing into a 2-byte global instead masked the
    // answer on the way out, and an int arithmetic that never wrapped still read back right --
    // 583 of 600 "agreed" before anything had been fixed.
    //
    // `+ 0` and not unary `+`: Watcom's folding promotes `+(unsigned short)65535` to a SIGNED int
    // (`+(unsigned short)65535 < 0` is 1), where C -- short and int being the same size -- makes
    // it unsigned, and binary `+`, `-`, `~` and the shifts all get that right in Watcom too.
    const e = `((${c.oracle}) + 0)`;
    const u = `((unsigned long)${e})`;
    qs.push(`sizeof(${e})`, `(${u} % 10000UL)`, `((${u} / 10000UL) % 10000UL)`, `(${u} / 100000000UL)`);
  }
  const ans = [];
  for (let i = 0; i < qs.length; i += 400) ans.push(...watcom16('', qs.slice(i, i + 400), { model: 'mm' }));
  const golden = {
    _doc: 'Open Watcom wcc -mm, constant-folding each expression by its own 16-bit rules (tools/gate-int16.mjs '
      + '--capture). `size` is sizeof the promoted expression, `bits` it as unsigned long.',
    cases: cases.map((c, k) => {
      const [size, lo, mid, hi] = ans.slice(k * 4, k * 4 + 4);
      return { leaves: c.leaves, prism: c.prism, oracle: c.oracle, size, bits: hi * 1e8 + mid * 1e4 + lo };
      // (sizeof of the PROMOTED expression: 2 or 4, never 1.)
    }),
  };
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  console.log(`captured ${cases.length} expressions -> goldens/int16.json`);
}
let oracleMod = null;
function awaitImport() { return oracleMod; }

function replay() {
  if (!existsSync(GOLDEN)) { console.log('no goldens/int16.json: run with --capture first'); process.exit(1); }
  const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  let bad = 0, pass = 0;
  const first = [];
  const BATCH = 150;
  for (let from = 0; from < g.cases.length; from += BATCH) {
    const part = g.cases.slice(from, from + BATCH);
    const src = part.map((c, j) => {
      const k = from + j;
      const decl = c.leaves.map((l, i) => `${l.c} c${k}_v${i} = ${lit(l.v, TYPES.find((t) => t.c === l.c))};`).join('\n');
      const body = c.prism.replace(/\bv(\d+)\b/g, `c${k}_v$1`);
      return `${decl}\nunsigned long r${k};\nvoid e${k}(void) { r${k} = (unsigned long)((${body}) + 0); }`;
    }).join('\n');
    const p = compileProgram([{ file: 'int16.c', source: src }],
      { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model: 'dos16m' });
    const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
    for (let j = 0; j < part.length; j++) {
      const k = from + j, c = part[j];
      let got;
      if (failed.has(`e${k}`)) got = `refused: ${failed.get(`e${k}`)}`;
      else {
        try {
          p.F[`e${k}`]();
          const a = p.mod.symbols.get(`r${k}`).addr;
          got = p.mod.dv.getUint32(a, true);
        } catch (e) { got = `threw: ${e.message}`; }
      }
      if (got === c.bits) pass++;
      else { bad++; if (first.length < 6) first.push({ k, got, want: c.bits, size: c.size, e: c.oracle }); }
    }
  }
  console.log(`${bad === 0 ? '  ok ' : ' BAD '} A. dos16m: ${pass}/${g.cases.length} expressions agree with Watcom -mm`);
  for (const f of first) console.log(`       #${f.k} (${f.size} bytes) got ${f.got} want ${f.want}:  ${f.e.slice(0, 150)}`);
  const b = partB() + partC();
  const ok = bad === 0 && b === 0;
  console.log(ok ? '\nintegers are as wide as the model says.' : `\n${bad + b} WRONG`);
  process.exit(ok ? 0 : 1);
}

/*
 * B. What a constant expression cannot hold: assignment, compound assignment, ++ and --, a parameter
 * and a return. Written by hand, each answer stated next to its reason. Where C leaves a SIGNED
 * overflow undefined (++ at 32767, *= past it, <<= into the sign bit) the answer is the one every
 * 16-bit compiler's add/imul/shl gives, two's-complement wrap. INT_MIN / -1 is not here: an 8086
 * `idiv` traps on it rather than wrapping, and PRISM has no divide-error interrupt to raise.
 */
const PART_B = [
  ['int x = 32767; x++; return x;', -32768, 'int overflow wraps on ++ (as the hardware does)'],
  ['unsigned u = 0; u--; return u;', 65535, 'unsigned wraps on --'],
  ['int x = 200; x *= 200; return x;', -25536, '40000 does not fit: *= wraps'],
  ['unsigned u = 65535; u += 2; return u;', 1, 'unsigned += wraps'],
  ['int x = 1; x <<= 15; return x;', -32768, '<<= reaches the sign bit'],
  ['unsigned u = 0x8000; u >>= 15; return u;', 1, 'unsigned >>= is logical'],
  ['unsigned char c = 255; c += 1; return c;', 0, 'an unsigned char += wraps at 8'],
  ['return pass16(40000L);', -25536, 'a long argument is converted to the int parameter'],
  ['return ret16();', -25536, 'return converts to the function\'s int'],
  ['int x = 0; unsigned u = x - 1; return u > 0;', 1, 'int -1 converted to unsigned is 65535'],
  ['long l = 32767; l += 1; return l > 0;', 1, 'long is still four bytes'],
  ['unsigned u = 65535; return (u + 1) ? 1 : 2;', 2, 'a sum that wraps to 0 is false'],
  ['unsigned u = 65535; return !(u + 1);', 1, '... and ! of it is true'],
  ['unsigned u = 0xffff; return (~u) ? 1 : 2;', 2, '~0xFFFF is 0 in 16 bits'],
  ['unsigned u = 0x8000; return (u << 1) ? 1 : 2;', 2, '0x8000 << 1 wraps to 0'],
  ['enum colour { red = 1 } c = 65536L; return c ? 1 : 2;', 2, 'an enum is two bytes: 65536 converts to 0'],
];

function partB() {
  const src = `int pass16(int a) { return a; }
int ret16(void) { long l = 40000L; return l; }
${PART_B.map(([body], i) => `long b${i}(void) { ${body} }`).join('\n')}`;
  const p = compileProgram([{ file: 'b.c', source: src }],
    { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model: 'dos16m' });
  const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
  let bad = 0;
  PART_B.forEach(([body, want, why], i) => {
    let got;
    if (failed.has(`b${i}`)) got = `refused: ${failed.get(`b${i}`)}`;
    else { try { got = p.F[`b${i}`](); } catch (e) { got = `threw: ${e.message}`; } }
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? '  ok ' : ' BAD '} B. ${why.padEnd(52)} ${got}${ok ? '' : ` (want ${want})`}`);
  });
  return bad;
}

/*
 * C. Enums, whose width 16-bit Watcom takes from their constants: the first of signed char, unsigned
 * char, int, unsigned, long that holds them all. Every expected value below was MEASURED with
 * wcc -mm (watcom16), not derived: sizes, the signedness a conversion shows, and the layout of a
 * struct holding one.
 */
const PART_C = [
  ['sizeof(enum a)', 1, '{1}: one byte'],
  ['sizeof(enum b)', 2, '{1000}: two bytes'],
  ['sizeof(enum c)', 1, '{-1}: one byte'],
  ['sizeof(enum d)', 1, '{200}: one byte'],
  ['sizeof(enum e)', 2, '{40000}: two bytes'],
  ['sizeof(enum h)', 2, '{-1, 200}: two bytes, no byte holds both'],
  ['sizeof(enum i)', 4, '{70000}: four bytes'],
  ['(int)(enum d)300', 44, '{200} is an UNSIGNED byte: 300 converts to 44'],
  ['(int)(enum g)200', -56, '{127} is a SIGNED byte: 200 converts to -56'],
  ['(long)(enum e)40000', 40000, '{40000} is unsigned: 40000 stays 40000'],
  ['sizeof(struct s1)', 4, 'char + {1000}: the enum aligns to 2'],
  ['sizeof(struct s2)', 3, 'char + {1} + char: no padding'],
  ['sizeof(struct s3)', 6, 'char + {70000}: aligned to 2, not 4'],
];
const PART_C_DECLS = `enum a { x = 1 }; enum b { y = 1000 }; enum c { z = -1 }; enum d { w = 200 };
enum e { v = 40000 }; enum g { m = 127 }; enum h { k = -1, j = 200 }; enum i { big = 70000 };
struct s1 { char c; enum b e; }; struct s2 { char c; enum a e; char d; }; struct s3 { char c; enum i e; };`;

function partC() {
  const src = `${PART_C_DECLS}\n${PART_C.map(([e], i) => `long c${i}(void) { return ${e}; }`).join('\n')}`;
  const p = compileProgram([{ file: 'c.c', source: src }],
    { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model: 'dos16m' });
  const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
  let bad = 0;
  PART_C.forEach(([, want, why], i) => {
    let got;
    if (failed.has(`c${i}`)) got = `refused: ${failed.get(`c${i}`)}`;
    else { try { got = p.F[`c${i}`](); } catch (e) { got = `threw: ${e.message}`; } }
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? '  ok ' : ' BAD '} C. ${why.padEnd(52)} ${got}${ok ? '' : ` (want ${want})`}`);
  });
  return bad;
}

if (CAPTURE) {
  oracleMod = await import('./oracle.mjs');
  capture();
}
replay();
