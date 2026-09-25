// gate-segptr.mjs — Borland `_seg` pointers under a 16-bit model.
//
// A `_seg` pointer holds a SEGMENT and nothing else: two bytes, a paragraph number, and the object it
// names is at linear seg*16 (the offset is implicitly 0). Keen Dreams' memory manager is built on
// them -- `typedef void _seg *memptr`, 110 `seg->field`, 37 `&seg` handed to MM_GetPtr, 21 casts to
// a _seg type. What Borland documents, and what this gate holds:
//
//   size           sizeof is 2 in every 16-bit model
//   dereference    p->f, *p and p[i] reach seg*16 (+ the member / the element)
//   conversion     _seg -> any other pointer multiplies by 16; any other pointer -> _seg divides by
//                  16; to and from an INTEGER the number is kept -- `(memptr)0x1000` is paragraph
//                  0x1000, and `(unsigned)p` reads the paragraph back
//   FP_SEG/FP_OFF  of a _seg pointer: the segment, and 0
//   storage        a _seg variable is two bytes; storing through `&seg` touches only those two
//   null           p == 0 and !p are about the paragraph being 0
//   p + n, p - n   Borland's one arithmetic on a _seg pointer, and its result is a FAR pointer,
//                  seg:n*sizeof -- Keen reaches map cells as `mapsegs[0]+offset`; n + p likewise
//   comparison     against another kind of pointer, addresses are compared
//   the rest       p - q, ++p, --p, p += n are refused by name: their result would have to become
//                  a paragraph again, and nothing in the corpus asks for it
//   elsewhere      under i386 `_seg` still means nothing and is still refused (gate-borland16), and
//                  `huge` stays refused there too
//
// No compiler oracle speaks _seg -- Watcom has __segment/:> instead and the Borland compiler is not
// here -- so the semantics are the documented ones and the checks EXECUTE them. run() refuses a
// 16-bit model (it builds an i386 argv), so each probe is called directly: a function with no
// arguments, returning an int, whose body is exactly the code under test.
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

let bad = 0;
const report = (ok, what, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(50)} ${detail}`);
};
const build = (source, model) => compileProgram([{ file: 'seg.c', source }],
  { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model });

const PROBES = `#include <dos.h>
typedef struct { int a, b; } rec;
typedef rec _seg *recptr;
typedef void _seg *memptr;
unsigned guard1;
memptr slot;
unsigned guard2;

int p_size(void)    { return sizeof(recptr) * 100 + sizeof(memptr) * 10 + sizeof(slot); }
int p_int(void)     { recptr s = (recptr)0x2000; return (unsigned)s == 0x2000; }
int p_deref(void)   {
  recptr s = (recptr)0x2000;
  rec far *r = (rec far *)MK_FP(0x2000, 0);
  r->a = 111; r->b = 222;
  return s->a == 111 && s->b == 222 && (*s).b == 222;
}
int p_write(void)   {
  recptr s = (recptr)0x2001;
  unsigned char far *raw = (unsigned char far *)MK_FP(0x2001, 0);
  s->b = 0x1234;
  return raw[2] == 0x34 && raw[3] == 0x12 && raw[0] == 0 && raw[1] == 0;
}
int p_index(void)   {
  recptr s = (recptr)0x2002;
  rec far *r = (rec far *)MK_FP(0x2002, 0);
  r[3].b = 77;
  return s[3].b == 77 && s[0].b == 0;
}
int p_toptr(void)   {
  recptr s = (recptr)0x2003;
  char far *c = (char far *)s;
  return c == (char far *)MK_FP(0x2003, 0);
}
int p_fromptr(void) {
  rec far *r = (rec far *)MK_FP(0x2004, 0);
  recptr s = (recptr)r;
  return (unsigned)s == 0x2004;
}
int p_fpseg(void)   {
  recptr s = (recptr)0x2005;
  return FP_SEG(s) == 0x2005 && FP_OFF(s) == 0;
}
int p_addr(void)    {
  memptr *pp = &slot;
  guard1 = 0xAAAA; guard2 = 0x5555;
  *pp = (memptr)0x2006;
  return (unsigned)slot == 0x2006 && guard1 == 0xAAAA && guard2 == 0x5555;
}
int p_add(void)     {
  unsigned _seg *m = (unsigned _seg *)0x2008;
  unsigned far *cell;
  unsigned far *base = (unsigned far *)MK_FP(0x2008, 0);
  base[5] = 4321; base[2] = 1234; base[3] = 777;
  cell = m + 5;
  return *cell == 4321 && *(3 + m) == 777 && *((m + 7) - 5) == 1234 && sizeof(m + 1) == 4
    && cell == base + 5;
}
int p_cmp(void)     {
  recptr s = (recptr)0x2009;
  rec far *r = (rec far *)MK_FP(0x2009, 0);
  return s == (recptr)r && (char far *)s == (char far *)r && s == r && r == s && !(r != s);
}
int p_null(void)    {
  recptr z = 0, s = (recptr)0x2007;
  return z == 0 && !z && s != 0 && !!s;
}
`;
const PROBE_NAMES = ['p_size', 'p_int', 'p_deref', 'p_write', 'p_index', 'p_toptr', 'p_fromptr', 'p_fpseg',
  'p_addr', 'p_add', 'p_cmp', 'p_null'];

for (const model of ['dos16m', 'dos16l']) {
  let p;
  try { p = build(PROBES, model); } catch (e) {
    report(false, `${model}: the probes compile`, e.message.split('\n')[0]);
    continue;
  }
  const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
  for (const name of PROBE_NAMES) {
    if (failed.has(name)) { report(false, `${model}: ${name}`, `refused -- ${failed.get(name).slice(0, 60)}`); continue; }
    const want = name === 'p_size' ? 222 : 1;
    let got;
    try { got = p.F[name](); } catch (e) { got = `threw ${e.message.slice(0, 40)}`; }
    report(got === want, `${model}: ${name}`, `returned ${got}${got === want ? '' : `, want ${want}`}`);
  }
}

// Arithmetic is refused by NAME; the survey counts functions by reason.
const ARITH = `typedef struct { int a; } rec;
typedef rec _seg *recptr;
int a_diff(recptr s, recptr t) { return s - t; }
int a_inc(recptr s)            { s++; return s->a; }
int a_pre(recptr s)            { --s; return s->a; }
int a_addeq(recptr s)          { s += 2; return s->a; }
int a_plain(recptr s)          { return s->a + (s + 1)->a + (s - 1)->a; }
`;
{
  const p = build(ARITH, 'dos16m');
  const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
  for (const fn of ['a_diff', 'a_inc', 'a_pre', 'a_addeq']) {
    const m = failed.get(fn);
    report(!!m && m.includes('arithmetic on a _seg pointer'), `dos16m: ${fn} refused by name`, m ? m.slice(0, 60) : 'emitted');
  }
  report(!failed.has('a_plain'), 'dos16m: a_plain (seg + n, seg - n) emits', failed.get('a_plain') ?? 'emits');
}

// Where _seg has no meaning it keeps its refusal; `huge` is gate-huge's.
{
  const src = 'typedef void _seg *memptr;\ntypedef char huge *hptr;\n'
    + 'int s(memptr m) { return m != 0; }\nint h(void) { hptr q = 0; return q != 0; }\n';
  const i386 = new Map((build(src, 'i386').failures ?? []).map((f) => [f.fn, f.message]));
  report((i386.get('s') ?? '').includes('seg pointer'), 'i386: _seg still refused', i386.get('s')?.slice(0, 50) ?? 'emitted');
  const m16 = new Map((build(src, 'dos16m').failures ?? []).map((f) => [f.fn, f.message]));
  report(!m16.has('s'), 'dos16m: the same _seg function emits', m16.get('s') ?? 'emits');
}

console.log(bad ? `\n${bad} WRONG` : '\n_seg pointers: a paragraph, two bytes, addressed at seg*16, arithmetic only as a far pointer.');
process.exit(bad ? 1 : 0);
