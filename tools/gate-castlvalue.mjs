// gate-castlvalue.mjs — a cast as an lvalue: Borland's extension, and gcc's until 4.0.
//
//     (long)pcSound = 0;                                   // Keen Dreams, id_sd.c:300
//     *((char far *)*(char far **)outfile)++ = data;       // jam_io.c, WritePtr
//
// It means `*(T *)&obj`: the object's own bytes, read and written as T. So it is accepted where that
// is meaningful -- an integer, enum or pointer of the SAME size -- and refused by name where it is
// not. No compiler here still speaks it (gcc dropped it in 4.0; Borland is not available), so these
// are the documented semantics, executed: plain assignment, compound assignment, pre- and
// post-increment, a local (which has to be pinned to memory for its bytes to exist), a parameter, a
// far pointer set to 0 through `(long)`, the value of the expression, and the refusals.
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(58)} ${detail}`);
};

const SRC16 = `
char far *pcSound = (char far *)0x12345L;
char buf[4];
int t_farzero(void) { (long)pcSound = 0; return pcSound == 0; }
int t_local(void) { int i = 5; (unsigned)i = 65535; return i; }
int t_compound(void) { int i = 32767; (unsigned)i += 1; return i; }
int t_post(void) { unsigned u = 7; int old = ((int)u)++; return old * 100 + u; }
int t_pre(void) { unsigned u = 0; return --((int)u); }
int t_param(int p) { (unsigned)p = 40000; return p; }
int t_value(void) { int i; return ((unsigned)i = 65535) == 65535u; }
int t_sign(void) { unsigned u = 0; return ((int)u = 65535) < 0; }
int t_sign_post(void) { unsigned u = 65535; return ((int)u)++ < 0; }
int t_ptr(void) {
  char far *q = (char far *)buf;
  char far **pp = &q;
  *((char far *)*(char far **)pp)++ = 'A';
  *((char far *)*(char far **)pp)++ = 'B';
  return buf[0] == 'A' && buf[1] == 'B' && q == (char far *)(buf + 2);
}
int r_size(void) { int i = 0; (long)i = 1; return i; }
int r_float(void) { long l = 0; (float)l = 1.0f; return 0; }
`;
const SRC32 = `int t_i386(void) { int i = 0; (unsigned)i = 0xffffffffu; return i; }`;

const build = (source, model) => compileProgram([{ file: 'c.c', source }],
  { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model });

const p = build(SRC16, 'dos16m');
const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
const run = (fn, ...a) => {
  if (failed.has(fn)) return `refused: ${failed.get(fn).slice(0, 60)}`;
  try { return p.F[fn](...a); } catch (e) { return `threw: ${e.message}`; }
};
const eq = (fn, want, what, args = []) => { const got = run(fn, ...args); report(got === want, what, `${got}`); };

eq('t_farzero', 1, '(long)farptr = 0 makes it null');
eq('t_local', -1, '(unsigned)i = 65535 leaves the int -1 (a pinned local)');
eq('t_compound', -32768, '(unsigned)i += 1 on 32767: the bytes of 32768');
eq('t_post', 708, '((int)u)++ yields the old value and increments u');
eq('t_pre', -1, '--((int)u) on 0 is -1 as an int');
eq('t_param', -25536, 'a parameter: (unsigned)p = 40000 reads back -25536');
eq('t_value', 1, 'the expression\'s value has the cast\'s type');
eq('t_sign', 1, '((int)u = 65535) is an int: less than 0');
eq('t_sign_post', 1, '((int)u)++ on 65535 yields the int -1');
eq('t_ptr', 1, 'jam_io.c\'s pointer post-increment through casts');
for (const [fn, want] of [['r_size', 'differ in size'], ['r_float', 'a cast as an lvalue from']]) {
  const m = failed.get(fn) ?? '';
  report(m.includes(want), `${fn} refused by name`, m.replace('tier-0 does not support ', '').slice(0, 60) || 'emitted');
}
{
  const q = build(SRC32, 'i386');
  let got;
  try { got = q.F.t_i386(); } catch (e) { got = e.message; }
  report(got === -1, 'i386: (unsigned)i = 0xffffffff leaves the int -1', `${got}`);
}

console.log(bad ? `\n${bad} WRONG` : '\na cast is an lvalue where it names the same bytes, and refused where it cannot.');
process.exit(bad ? 1 : 0);
