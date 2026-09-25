// gate-borland-int16.mjs — integer arithmetic under Keen Dreams' compiler options, EXECUTED by Borland.
//
// gate-int16 asks Watcom to fold constants, and Watcom's folder has faults (it promotes unsigned
// short to a signed int; it loses a narrowing cast inside ?:), so that gate steps round them. This
// one asks nothing to fold: random expressions over variables of the integer types -- plain char
// included, which -K makes unsigned -- are compiled by Borland C++ 2.0, Keen's own compiler (the
// archive.org borland-cpp-2.0-german floppies), with Keen's options (-mm -a -K,
// goldens/borland-prj.json) and RUN in DOSBox-X (tools/oracle-borland.mjs); PRISM compiles the same
// expressions with the Keen target's options and runs them. Every result is read back as
// (unsigned long)((e) + 0).
//
// Divisors are forced positive: an 8086 `idiv` of INT_MIN by -1 raises the divide-error interrupt
// and would end the batch -- a trap, not a value, and PRISM has no interrupt 0 to raise.
//
//   node tools/gate-borland-int16.mjs --capture [--bc=/path/to/BC31]
//   node tools/gate-borland-int16.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'borland-int16.json');
const CASES = 600, BATCH = 150;

/*
 * NO `unsigned short`. Borland C++ 2.0 -- Keen's own compiler, which these goldens are captured from
 * -- promotes it to a SIGNED int: `us <= i` compiles to cmp + jg, where 3.1 (and C, short and int
 * being one size) compares unsigned with ja. Keen declares no unsigned short (a scan of its units
 * under its options finds none), so the type is left out rather than answered from 2.0's rule.
 */
const TYPES = [
  { c: 'char', size: 1, signed: false },            // -K
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
function leafValue(r, t) {
  const bits = t.size * 8;
  const max = t.signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const min = t.signed ? -(2 ** (bits - 1)) : 0;
  const edges = [0, 1, 2, max, max - 1, min, min + 1, t.signed ? -1 : max >> 1, 0x7f, 0x80, 0xff, 0x100];
  const v = r.int(3) ? r.pick(edges) : min + r.int(Math.min(max - min + 1, 0x7fffffff));
  return Math.max(min, Math.min(max, v));
}
const lit = (v, t) => {
  const suffix = t.size === 4 ? (t.signed ? 'L' : 'UL') : '';
  const min = t.signed ? -(2 ** (t.size * 8 - 1)) : null;
  if (v === min) return `(${v + 1}${suffix}-1)`;
  return `${v}${suffix}`;
};
function expr(r, leaves, depth) {
  if (depth === 0 || r.int(4) === 0) {
    const t = r.pick(TYPES);
    const k = leaves.length;
    leaves.push({ t, v: leafValue(r, t) });
    return `v${k}`;
  }
  const kind = r.int(10);
  const a = expr(r, leaves, depth - 1);
  if (kind === 0) return `(${r.pick(['-', '~', '!'])}${a})`;
  if (kind === 1) return `((${r.pick(TYPES).c})${a})`;
  const b = expr(r, leaves, depth - 1);
  if (kind === 2) return `(${a} ? ${b} : ${expr(r, leaves, depth - 1)})`;
  const op = r.pick(['+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^', '<', '>', '<=', '>=', '==', '!=', '&&', '||']);
  if (op === '/' || op === '%') return `(${a} ${op} (((${b}) & 0x7ff) | 1))`;
  if (op === '<<' || op === '>>') return `(${a} ${op} ((${b}) & 15))`;
  // Borland (2.0 and 3.1 alike) works on two chars of DIFFERENT signedness in 8 bits, unsigned,
  // where C promotes each to int first: & | ^ (`or al,[b]` / `mov ah,0`: (signed char)-127 |
  // (unsigned char)0 gives 129, not -127) and the comparisons (`cmp al,[b]` / `jbe`:
  // (unsigned char)127 > (signed char)-1 is false). A defect of the oracle, stepped round the way
  // gate-int16 steps round Watcom's folder: `+ 0` promotes both operands, the same value in C. Keen
  // has no such operation (a scan of its units under its options finds none).
  if (['&', '|', '^', '<', '>', '<=', '>=', '==', '!='].includes(op)) return `((${a}) + 0 ${op} (${b}) + 0)`;
  return `(${a} ${op} ${b})`;
}
function makeCases() {
  const cases = [];
  for (let k = 0; k < CASES; k++) {
    const r = rng(0xb0c1 + k * 7907);
    const leaves = [];
    const e = expr(r, leaves, 1 + r.int(3));
    cases.push({ leaves: leaves.map((l) => ({ c: l.t.c, v: l.v })), e });
  }
  return cases;
}
/** One batch as C: the leaves as globals (so nothing folds), one result per case. */
function batchSource(cases, from, withMain) {
  const decls = [], bodies = [];
  cases.forEach((c, j) => {
    const k = from + j;
    c.leaves.forEach((l, i) => decls.push(`${l.c} c${k}_v${i} = ${lit(l.v, TYPES.find((t) => t.c === l.c))};`));
    bodies.push({ k, e: c.e.replace(/\bv(\d+)\b/g, `c${k}_v$1`) });
  });
  if (withMain) {
    return `#include <stdio.h>\n${decls.join('\n')}\nint main(void)\n{\n${bodies.map(({ k, e }) =>
      `  printf("${k} %lu\\n", (unsigned long)((${e}) + 0));`).join('\n')}\n  return 0;\n}\n`;
  }
  return `${decls.join('\n')}\n${bodies.map(({ k, e }) => `unsigned long r${k};\nvoid e${k}(void) { r${k} = (unsigned long)((${e}) + 0); }`).join('\n')}\n`;
}

async function capture() {
  const { bccRun, bccVersion, BC_DEFAULT } = await import('./oracle-borland.mjs');
  const bc = process.argv.find((a) => a.startsWith('--bc='))?.slice(5) ?? BC_DEFAULT;
  const prj = JSON.parse(readFileSync(join(ROOT, 'goldens', 'borland-prj.json'), 'utf8'));
  const options = prj.keendreams.filter((o) => /^-(m.|a|a-|K|b-?)$/.test(o));
  const cases = makeCases();
  const programs = [];
  for (let from = 0; from < cases.length; from += BATCH) {
    programs.push({ name: `INT${from / BATCH}`, source: batchSource(cases.slice(from, from + BATCH), from, true) });
  }
  const results = bccRun(programs, { bc, options });
  const want = new Array(cases.length).fill(null);
  for (const r of results) {
    if (!r.compiled) { console.log(r.compileLog); process.exit(1); }
    for (const line of r.stdout.split('\n')) {
      const m = /^(\d+) (\d+)$/.exec(line.trim());
      if (m) want[+m[1]] = +m[2];
    }
  }
  const missing = want.findIndex((v) => v === null);
  if (missing >= 0) throw new Error(`no Borland answer for case ${missing}`);
  const golden = {
    _doc: `${bccVersion({ bc })}, options ${options.join(' ')}, compiling and RUNNING each expression in DOSBox-X `
      + '(tools/gate-borland-int16.mjs --capture). `want` is (unsigned long)((e) + 0) as Borland printed it.',
    options,
    cases: cases.map((c, i) => ({ ...c, want: want[i] })),
  };
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  console.log(`captured ${cases.length} expressions -> goldens/borland-int16.json`);
}

if (process.argv.includes('--capture')) await capture();
if (!existsSync(GOLDEN)) { console.log('no goldens/borland-int16.json: run with --capture first'); process.exit(1); }
const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
const t = JSON.parse(readFileSync(join(ROOT, 'targets', 'keendreams.json'), 'utf8')).compile;
let pass = 0;
const first = [];
for (let from = 0; from < g.cases.length; from += BATCH) {
  const part = g.cases.slice(from, from + BATCH);
  const p = compileProgram([{ file: 'bint.c', source: batchSource(part, from, false) }],
    { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model: t.model,
      signedChar: t.signedChar, enums: t.enums, pack: t.pack ?? null });
  const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
  part.forEach((c, j) => {
    const k = from + j;
    let got;
    if (failed.has(`e${k}`)) got = `refused: ${failed.get(`e${k}`)}`;
    else {
      try { p.F[`e${k}`](); got = p.mod.dv.getUint32(p.mod.symbols.get(`r${k}`).addr, true); } catch (e) { got = `threw: ${e.message}`; }
    }
    if (got === c.want) pass++;
    else if (first.length < 6) first.push(`#${k} got ${got} want ${c.want}: ${c.e.slice(0, 120)}  [${c.leaves.map((l) => `${l.c}=${l.v}`).join(', ')}]`.slice(0, 260));
  });
}
const ok = pass === g.cases.length;
console.log(`${ok ? '  ok ' : ' BAD '} ${pass}/${g.cases.length} expressions agree with Borland ${g.options.join(' ')}, executed`);
for (const f of first) console.log(`       ${f}`);
console.log(ok ? '\nKeen Dreams\' integers behave as Borland compiled them.' : `\n${g.cases.length - pass} WRONG`);
process.exit(ok ? 0 : 1);
