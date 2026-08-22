// gate-cpp.mjs — PRISM's preprocessor vs `gcc -E`. Bar: identical token stream.
//
// The comparison is on TOKENS, not text: `gcc -E` makes its own whitespace and line decisions that
// carry no meaning, and the compiler downstream consumes tokens. gcc's output is re-lexed with
// PRISM's own lexer, which also exercises the lexer on a second, independent input.
//
// Cases are self-contained (no #include, no system headers) so that this gate tests the
// preprocessor and nothing else. Names avoid anything gcc predefines.
//
//   node tools/gate-cpp.mjs [--verbose] [filter]

import { sh, put, SCRATCH, version } from './oracle.mjs';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Preprocessor, CppError } from '../src/cpp/cpp.js';
import { tokenize } from '../src/cpp/lexer.js';
import { EOF } from '../src/cpp/token.js';

const VERBOSE = process.argv.includes('--verbose');
const FILTER = process.argv.slice(2).find(a => !a.startsWith('--')) ?? null;

// ---------------------------------------------------------------- cases

const cases = [];
const C = (name, src, headers = null) => cases.push({ name, src, headers });

C('object-simple', `
#define AAA 1
#define BBB AAA + AAA
BBB
`);

C('self-reference', `
#define fooo fooo
fooo
#define aaa aaa bbb
aaa
`);

C('mutual-recursion', `
#define AY BEE
#define BEE AY
AY
BEE
`);

C('funlike-not-called', `
#define ff(x) x + 1
ff
ff (2)
ff(3)
`);

C('prosser', `
#define ff(a) a*gg
#define gg(a) ff(a)
ff(2)(9)
`);

// The canonical example from C99 6.10.3.5p5. If this passes, most of phase 4 is right.
C('std-6.10.3.5-example3', `
#define xx 3
#define ff(a) ff(xx * (a))
#undef xx
#define xx 2
#define gg ff
#define zz zz[0]
#define hh gg(~
#define mm(a) a(ww)
#define ww 0,1
#define tt(a) a
#define pp() int
#define qq(x) x
#define rr(x,y) x ## y
#define strr(x) # x
ff(y+1) + ff(ff(zz)) % tt(tt(gg)(0) + tt)(1);
gg(xx+(3,4)-ww) | hh 5) & mm
    (ff)^mm(mm);
pp() i[qq()] = { qq(1), rr(2,3), rr(4,), rr(,5), rr(,) };
char cc[2][6] = { strr(hello), strr() };
`);

// C99 6.10.3.5p6 — the `#` `##` construction.
C('std-hash-hash-spelling', `
#define hash_hash # ## #
#define mkstr(a) # a
#define in_between(a) mkstr(a)
#define joinn(c, d) in_between(c hash_hash d)
char pp[] = joinn(xx, yy);
`);

C('stringize', `
#define S(x) #x
#define S2(x) S(x)
#define VAL 42
S(VAL)
S2(VAL)
S(a   +   b)
S("quoted \\" and \\\\ back")
S('c')
S(  leading and trailing  )
`);

C('paste-basic', `
#define CAT(a,b) a##b
#define XCAT(a,b) CAT(a,b)
#define NN 1
CAT(x,y)
CAT(NN,NN)
XCAT(NN,NN)
CAT(1,2)
CAT(1,e+2)
CAT(+,+)
`);

C('paste-empty', `
#define CAT(a,b) a##b
#define TWO(a,b) a b
CAT(,)
CAT(x,)
CAT(,y)
TWO(,)
`);

C('paste-chain', `
#define A3(a,b,c) a##b##c
A3(x,y,z)
A3(,y,)
A3(1,2,3)
`);

C('variadic', `
#define EP(...) fp(stderr, __VA_ARGS__)
#define EP2(fmt, ...) fp(fmt, __VA_ARGS__)
EP(1)
EP(1,2,3)
EP2("f", 1, 2)
`);

C('variadic-gnu-comma-paste', `
#define E3(fmt, ...) pf(fmt, ## __VA_ARGS__)
E3("x")
E3("x", 1)
E3("x", 1, 2)
`);

C('variadic-gnu-named', `
#define NAMED(args...) fn(args)
#define NAMED2(a, rest...) fn(a, ## rest)
NAMED(1,2)
NAMED()
NAMED2(1)
NAMED2(1,2)
`);

C('varargs-commas-in-arg', `
#define ONE(x) [x]
ONE((a,b))
#define VA(...) [__VA_ARGS__]
VA((a,b),c)
`);

C('object-parenthesized', `
#define NOTFN (x)
NOTFN
#define ISFN(x) (x)
ISFN(1)
`);

C('empty-macro', `
#define NOTHING
#define WRAP(x) [x]
NOTHING
WRAP(NOTHING)
a NOTHING b
`);

C('multiline-invocation', `
#define ADD(a,b) ((a)+(b))
ADD(1,
    2)
ADD(
  3
  ,
  4
)
`);

C('cond-basic', `
#if 1
one
#endif
#if 0
two
#else
three
#endif
#if 0
a
#elif 0
b
#elif 1
c
#else
d
#endif
`);

C('cond-nested-skip', `
#if 0
#if 1
hidden
#endif
#define SHOULD_NOT_EXIST 1
#endif
#ifdef SHOULD_NOT_EXIST
bad
#else
good
#endif
`);

C('cond-arithmetic-64bit', `
#if 0x7fffffff + 1 > 0
wide_ok
#endif
#if -1 < 0u
minus_one_less
#else
unsigned_wins
#endif
#if (1 << 40) > 0
shift40
#endif
#if 7 / 2 == 3 && -7 / 2 == -3 && -7 % 2 == -1
trunc_ok
#endif
`);

C('cond-char', `
#if 'A' == 65
aa
#endif
#if '\\xff' < 0
char_is_signed
#else
char_is_unsigned
#endif
#if '\\n' == 10
nl
#endif
`);

C('cond-defined', `
#define DEF1 1
#if defined DEF1 && defined(DEF1) && !defined NOPE
ok
#endif
#ifndef NOPE
nope_undef
#endif
#if defined NOPE
bad
#endif
`);

C('cond-undefined-ident', `
#if UNDEFINED_THING
bad
#else
undef_is_zero
#endif
#if UNDEFINED_THING == 0
eq_zero
#endif
`);

C('cond-ternary', `
#if (1 ? 2 : 3) == 2
tern
#endif
#if (0 ? 1/0 : 5) == 5
tern2
#endif
`);

C('line-splice', `
#define LONG_MAC(a, \\
                 b) a + b
LONG_MAC(1, 2)
int spli\\
ced = 1;
`);

C('comments', `
#define CM 1 /* comment */ + 2
CM
a /* multi
     line */ b
c // line comment
d
/* comment
*/ #define AFTER_BLOCK_COMMENT 7
AFTER_BLOCK_COMMENT
`);

C('pp-number', `
#define P(x) [x]
P(0x1p+3)
P(1.2e-5f)
P(1e+2)
P(0xFFul)
P(.5)
`);

C('nested-expansion-order', `
#define OUTER(x) INNER(x)
#define INNER(x) [x]
#define ARG 1
OUTER(ARG)
#define REC(x) OUTER(x)
REC(ARG)
`);

C('arg-used-twice', `
#define TWICE(x) x + x
#define BUMP 1
TWICE(BUMP)
TWICE(TWICE(BUMP))
`);

C('undef-redefine', `
#define RD 1
RD
#undef RD
#define RD 2
RD
#undef NEVER_DEFINED
`);

C('null-directive', `
#
#define NUL 1
#
NUL
`);

// --- the rules the GENERATOR found; pinned so a regression cannot slip back in

// An empty argument next to `##` is a PLACEMARKER, not nothing. Without one, the paste reaches the
// token before the parameter: `zz p0 ## p1` with p0 empty produced `zzbb` instead of `zz bb`.
C('paste-placemarker-with-prefix', `
#define PM1(a,b) zz a ## b
#define PM2(a,b) a ## b zz
#define PM3(a,b,c) x a ## b c
PM1(,yy)
PM1(xx,)
PM1(,)
PM2(,yy)
PM3(,, w)
`);

// The GNU comma-paste deletes the comma only when the variadic list is ABSENT. Present-but-empty
// keeps it: VE("a") drops the comma, VE("a", ) does not.
C('variadic-absent-vs-empty', `
#define VE(fmt, ...) fn(fmt, ## __VA_ARGS__)
VE("a")
VE("a", )
VE("a", 1)
VE("a", , )
#define VE2(p0, ...) # p0 , ## __VA_ARGS__ p0 , ## __VA_ARGS__
VE2(bb)
VE2(bb, )
VE2(bb, 1)
`);

// --- #include, with headers supplied per case

C('include-quoted', `
#include "h1.h"
FROM_H1
`, { 'd0/h1.h': '#define FROM_H1 111\n' });

C('include-angled-and-nested', `
#include <h2.h>
FROM_H2 FROM_H1
`, { 'd0/h1.h': '#define FROM_H1 111\n', 'd0/h2.h': '#include "h1.h"\n#define FROM_H2 222\n' });

C('include-guard', `
#include "g.h"
#include "g.h"
COUNTED
`, { 'd0/g.h': '#ifndef G_H\n#define G_H\n#define COUNTED once\n#endif\n' });

C('include-pragma-once', `
#include "o.h"
#include "o.h"
ONCE_VAL
`, { 'd0/o.h': '#pragma once\n#define ONCE_VAL 9\n' });

// #include_next: the same header name in two directories; the first chains to the second.
C('include-next', `
#include <n.h>
FIRST SECOND
`, {
  'd0/n.h': '#define FIRST 1\n#include_next <n.h>\n',
  'd1/n.h': '#define SECOND 2\n',
});

// A computed include — the file name comes out of a macro.
C('include-computed', `
#define WHICH "h1.h"
#include WHICH
FROM_H1
`, { 'd0/h1.h': '#define FROM_H1 111\n' });

// ---------------------------------------------------------------- generated cases
//
// The hand cases above test the rules I know about. The generator does not think: it walks the
// grid of macro shapes — object/function, variadic, stringize, paste, nested invocation — and asks
// gcc. That is how the ABI gate found three bitfield rules the hand cases missed.

const GEN = +(process.env.CPP_GEN ?? 60);
const GEN_SEED = +(process.env.CPP_SEED ?? 20260820);

let rngState = GEN_SEED || 1;
const rnd = () => {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState >>>= 0;
  return rngState / 0x100000000;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const ATOMS = ['aa', 'bb', 'cc', '1', '2', '7', '+', '-', '*', '(', ')', ','];
const IDENTS = ['aa', 'bb', 'cc', 'dd'];

function genCase(n) {
  const nmac = rint(2, 6);
  const names = Array.from({ length: nmac }, (_, i) => `M${n}_${i}`);
  const lines = [];

  for (let i = 0; i < nmac; i++) {
    const fn = rnd() < 0.65;
    if (!fn) {
      lines.push(`#define ${names[i]} ${genBody([], names, i, 0)}`);
      continue;
    }
    const np = rint(1, 3);
    const params = Array.from({ length: np }, (_, k) => `p${k}`);
    const variadic = rnd() < 0.25;
    const plist = variadic ? [...params, '...'].join(', ') : params.join(', ');
    const usable = variadic ? [...params, '__VA_ARGS__'] : params;
    lines.push(`#define ${names[i]}(${plist}) ${genBody(usable, names, i, 0, variadic)}`);
  }

  // Invoke each macro once, with arguments that are themselves sometimes invocations.
  for (let i = 0; i < nmac; i++) {
    const def = lines[i];
    const m = def.match(/^#define (\S+?)\((.*?)\)/);
    if (!m) { lines.push(names[i]); continue; }
    const plist = m[2].split(',').map(s => s.trim()).filter(Boolean);
    const nargs = plist[plist.length - 1] === '...' ? plist.length - 1 + rint(0, 2) : plist.length;
    const args = Array.from({ length: Math.max(nargs, 0) }, () => genArg(names, i));
    lines.push(`${names[i]}(${args.join(', ')})`);
  }
  return lines.join('\n') + '\n';
}

function genBody(params, names, self, depth, variadic = false) {
  const n = rint(1, 5);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (params.length && r < 0.3) out.push(pick(params));
    else if (params.length && r < 0.38) out.push(`# ${pick(params.filter(p => p !== '__VA_ARGS__')) ?? params[0]}`);
    else if (params.length >= 2 && r < 0.48) {
      // Paste two parameters — restricted to parameters so the result is usually a valid token.
      out.push(`${params[0]} ## ${params[1]}`);
    } else if (variadic && r < 0.55) out.push(`, ## __VA_ARGS__`);
    else if (r < 0.7 && self > 0) out.push(pick(names.slice(0, self)));
    else if (r < 0.8 && depth < 2) out.push(`( ${genBody(params, names, self, depth + 1, variadic)} )`);
    else out.push(pick(ATOMS));
  }
  // `##` may not sit at either end of a replacement list, and a stray `,##__VA_ARGS__` at the
  // start has nothing to attach to.
  let body = out.join(' ').trim();
  body = body.replace(/^(,\s*##\s*__VA_ARGS__)/, 'zz $1');
  if (/^##/.test(body)) body = 'zz ' + body;
  if (/##$/.test(body)) body = body + ' zz';
  return body || 'zz';
}

function genArg(names, self) {
  const r = rnd();
  if (r < 0.2 && self > 0) {
    // A nested invocation of an earlier macro — only object-like ones are safe to name bare.
    return pick(IDENTS);
  }
  if (r < 0.35) return `( ${pick(IDENTS)} , ${rint(0, 9)} )`;
  if (r < 0.5) return String(rint(0, 99));
  if (r < 0.7) return pick(IDENTS);
  if (r < 0.8) return '';
  return `${pick(IDENTS)} + ${rint(0, 9)}`;
}

for (let n = 0; n < GEN; n++) C(`gen-${n}`, genCase(n));

// ---------------------------------------------------------------- run

const active = cases.filter(c => !FILTER || c.name.includes(FILTER));
console.log(version());
console.log(`gate-cpp: ${active.length} cases\n`);

// Batch every case into the oracle in one exec.
const dir = join(SCRATCH, 'cpp');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const [n, c] of active.entries()) {
  writeFileSync(join(dir, `c${n}.c`), c.src);
  // A case's headers go into per-case directories d0, d1, ... which become the include path in
  // that order — which is what makes #include_next testable at all.
  for (const [rel, text] of Object.entries(c.headers ?? {})) {
    const full = join(dir, `h${n}`, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}
const incFlags = (c, n) => Object.keys(c.headers ?? {})
  .map(k => k.split('/')[0])
  .filter((d, i, a) => a.indexOf(d) === i)
  .sort()
  .map(d => `-Icpp/h${n}/${d}`).join(' ');
const script = active.map((c, n) =>
  `echo "===CASE ${n}"; gcc -E -P -std=gnu89 ${incFlags(c, n)} cpp/c${n}.c 2>&1; echo "===RC $?"`).join('; ');
const r = sh(script, { timeout: 600000 });

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

/**
 * The same search gcc does: for a quoted include, the directory of the including file first, then
 * the -I list in order. `#include_next` restarts AFTER the directory the current file came from,
 * which is the whole point of the two-directory `include-next` case.
 */
function makeResolve(c, n) {
  const dirs = Object.keys(c.headers ?? {}).map(k => k.split('/')[0])
    .filter((d, i, a) => a.indexOf(d) === i).sort()
    .map(d => join(dir, `h${n}`, d));
  return (name, angled, fromFile, isNext) => {
    let search = dirs;
    if (isNext) {
      const here = dirs.findIndex(d => fromFile && fromFile.startsWith(d));
      search = here < 0 ? dirs : dirs.slice(here + 1);
    } else if (!angled && fromFile) {
      search = [dirname(fromFile), ...dirs];
    }
    for (const d of search) {
      const full = join(d, name);
      if (existsSync(full)) return { path: full, text: readFileSync(full, 'utf8') };
    }
    return null;
  };
}

const toks = (text, file) => tokenize(text, { file }).tokens.filter(t => t.k !== EOF)
  .map(t => `${t.k}:${t.raw ?? t.v}`);

let pass = 0, skipped = 0;
const fails = [];

for (const [n, c] of active.entries()) {
  const ref = chunks.get(n);
  if (!ref) { fails.push({ c, why: 'no oracle output' }); continue; }
  if (ref.rc !== 0) {
    // A GENERATED case may simply be an invalid program — that is the generator's business, not a
    // defect. A hand-written case that gcc rejects is a bug in the case and must be seen.
    if (c.name.startsWith('gen-')) {
      // ...unless PRISM accepts what gcc rejects, which is a real divergence.
      let threw = false;
      try { new Preprocessor({ resolve: makeResolve(c, n) }).run(c.src, join(dir, `c${n}.c`)); } catch { threw = true; }
      if (!threw) fails.push({ c, why: `gcc rejected it, PRISM accepted it:\n${ref.text.split('\n').slice(0, 4).join('\n')}` });
      else skipped++;
      continue;
    }
    fails.push({ c, why: `gcc rejected the case:\n${ref.text}` });
    continue;
  }

  let ours;
  try {
    const pp = new Preprocessor({ resolve: makeResolve(c, n) });
    ours = pp.run(c.src, join(dir, `c${n}.c`));
  } catch (e) {
    fails.push({ c, why: `PRISM threw: ${e.message}` });
    continue;
  }

  const a = ours.filter(t => t.k !== EOF).map(t => `${t.k}:${t.raw ?? t.v}`);
  const b = toks(ref.text, `c${n}.c`);

  if (a.length === b.length && a.every((x, k) => x === b[k])) {
    pass++;
    if (VERBOSE) console.log(`  ok   ${c.name}`);
    continue;
  }
  let at = 0;
  while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++;
  fails.push({
    c, why: `token ${at} of ${Math.max(a.length, b.length)}:\n` +
      `    prism: ${a.slice(Math.max(0, at - 3), at + 6).join(' ')}\n` +
      `    gcc  : ${b.slice(Math.max(0, at - 3), at + 6).join(' ')}`,
  });
}

console.log(`${pass}/${active.length - skipped} cases match gcc -E exactly` +
  (skipped ? ` (${skipped} generated cases skipped: gcc rejected them and so did PRISM)` : ''));
if (fails.length) {
  console.log(`\n${fails.length} failing:\n`);
  for (const f of fails) console.log(`--- ${f.c.name}\n${f.why}\n`);
  process.exit(1);
}
