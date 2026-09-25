// gate-borlandlib.mjs — the parts of Borland's runtime library Keen Dreams calls (src/env/borland-lib.js).
//
// No Borland library is available to diff against, so each function is held to what its manual
// promises and what the program relies on, executed:
//
//   * ltoa/ultoa/itoa: the digits, a minus only in base 10, and itoa at the width of a 16-bit int
//   * the near heap: malloc(coreleft()) succeeds whole, and leaves nothing -- which is exactly how
//     id_mm.c takes it; under dos16m this failed outright before, because the heap's top sat 64K
//     below the stack and so below the heap's own start
//   * the far heap: farmalloc(farcoreleft()) takes everything above the far statics, farfree gives it
//     back, and two freed neighbours coalesce
//   * _fmemcpy/_fmemset across far addresses; movedata by segment:offset
//   * findfirst/findnext over the file store, DOS wildcards, case-insensitive; errno ENOFILE/ENMFILE
//   * getdate from PRISM's fixed clock; clrscr/textcolor into the B800 text buffer, called with no
//     prototype as Keen calls them
//   * bioskey through int 16h: ZF answers "is a key waiting"
//   * the constants: errno numbers are DOS error codes, S_IREAD/S_IWRITE, ffblk's offsets
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';
import { installStdio } from '../src/env/stdio.js';
import { installBorland, BORLAND_DOS_H, BORLAND_VARS, BORLAND_BUILTINS } from '../src/env/borland.js';
import { installBorlandLib, BORLAND_LIB_HEADERS, BORLAND_LIB_BUILTINS } from '../src/env/borland-lib.js';

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(58)} ${detail}`);
};

const SRC = `#include <stdlib.h>
#include <string.h>
#include <alloc.h>
#include <mem.h>
#include <dir.h>
#include <dos.h>
#include <bios.h>
#include <errno.h>
#include <sys/stat.h>
char buf[40];
int t_ltoa(void) { return strcmp(ltoa(-123456L, buf, 10), "-123456") == 0; }
int t_ltoa16(void) { return strcmp(ltoa(-1L, buf, 16), "ffffffff") == 0; }
int t_ultoa(void) { return strcmp(ultoa(4000000000UL, buf, 10), "4000000000") == 0; }
int t_itoa(void) { return strcmp(itoa(-1, buf, 16), "ffff") == 0 && strcmp(itoa(-32767 - 1, buf, 10), "-32768") == 0; }
int t_itoa2(void) { return strcmp(itoa(5, buf, 2), "101") == 0; }
/* Near heap: medium takes it whole with malloc, as id_mm.c does; free gives it back. */
unsigned t_near(void) {
#ifndef __PRISM_FARDATA__
  unsigned n = coreleft();
  char *p = malloc(n);
  int ok = p != 0 && n > 1000 && coreleft() < 16;
  free(p);
  return ok && coreleft() == n;
#else
  /* Large: coreleft is an unsigned long, and the heap is taken with farmalloc. */
  unsigned long n = coreleft();
  char far *p = farmalloc(n);
  int ok = p != 0 && n > 70000L && coreleft() < 16;
  farfree(p);
  return ok && coreleft() == n;
#endif
}
long t_far(void) {
  unsigned long n = farcoreleft();
  char far *p = farmalloc(n);
  char far *q;
  int ok = p != 0 && farcoreleft() == 0;
  farfree(p);
  ok = ok && farcoreleft() == n;
  p = farmalloc(1000);
  q = farmalloc(1000);
  farfree(p);
  farfree(q);
  return ok && farcoreleft() == n;
}
int t_fmem(void) {
  char far *a = farmalloc(64);
  char far *b = farmalloc(64);
  _fmemset(a, 'x', 64);
  _fmemcpy(b, a, 64);
  return b[0] == 'x' && b[63] == 'x';
}
int t_movedata(void) {
  char far *a = (char far *)MK_FP(0x7000, 0x10);
  a[0] = 'q';
  movedata(0x7000, 0x10, 0x7001, 0x10, 1);
  return *(char far *)MK_FP(0x7001, 0x10) == 'q';
}
int t_find(void) {
  struct ffblk f;
  int n = 0, first;
  if (findfirst("*.CMP", &f, 0) != 0) return -1;
  first = (strcmp(f.ff_name, "KDREAMS.CMP") == 0) * 100 + (f.ff_fsize == 5L) * 1000;
  n++;
  while (findnext(&f) == 0) n++;
  return first + n * 10 + (errno == ENMFILE);
}
int t_find_none(void) { struct ffblk f; return findfirst("NOPE.*", &f, 0) == -1 && errno == ENOFILE; }
int t_date(void) { struct date d; getdate(&d); return d.da_year == 1997 && d.da_mon == 1 && d.da_day == 1; }
int t_clrscr(void) { textcolor(14); clrscr(); return 0; }
int t_bios(void) { return (bioskey(1) == 0x1c0d) * 10 + (bioskey(0) == 0x1c0d); }
int t_consts(void) {
  struct ffblk f;
  return EINVFMT == 11 && ENOMEM == 8 && ENOENT == 2 && ENMFILE == 18 && S_IREAD == 0x100 && S_IWRITE == 0x80
    && sizeof(f) == 44 && (char *)&f.ff_name - (char *)&f == 30 && (char *)&f.ff_fsize - (char *)&f == 26;
}
`;
/* clrscr and textcolor are called WITHOUT conio.h, as Keen calls them: t_clrscr has no prototype. */

const headers = { ...BORLAND_LIB_HEADERS, 'dos.h': BORLAND_DOS_H };
const build = (model) => compileProgram(
  [{ file: 'lib.c', source: SRC }, { file: 'prism-borland-vars.c', source: BORLAND_VARS }],
  { resolve: builtinHeaderResolver(headers), memory: 8 << 20, collect: true, model, c89: true,
    extraBuiltins: new Map(Object.entries({ ...BORLAND_LIB_BUILTINS, ...BORLAND_BUILTINS })) });

for (const model of ['dos16m', 'dos16l']) {
  const p = build(model);
  const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
  installStdio(p.M, { files: { 'KDREAMS.CMP': new Uint8Array(5), 'other.cmp': new Uint8Array(3), 'x.txt': new Uint8Array(1) } });
  const keys = [];
  installBorlandLib(p.M);
  installBorland(p.M, { services: { 0x16: (r) => { keys.push(r.ax >> 8); if ((r.ax >> 8) === 1) r.zf = 0; r.ax = 0x1c0d; } } });
  p.M.heapEnd = p.M.heap;                     // the heap as main() would find it
  const run = (fn) => {
    if (failed.has(fn)) return `refused: ${failed.get(fn).slice(0, 60)}`;
    try { return p.F[fn](); } catch (e) { return `threw: ${e.message.slice(0, 60)}`; }
  };
  const eq = (fn, want, what) => { const got = run(fn); report(got === want, `${model}: ${what}`, `${got}`); };
  eq('t_ltoa', 1, 'ltoa(-123456, 10)');
  eq('t_ltoa16', 1, 'ltoa(-1, 16): no minus outside base 10');
  eq('t_ultoa', 1, 'ultoa(4000000000, 10)');
  eq('t_itoa', 1, 'itoa at 16 bits: -1 is ffff, -32768 in base 10');
  eq('t_itoa2', 1, 'itoa(5, 2) is 101');
  eq('t_near', 1, 'the near heap taken whole, and given back by free');
  eq('t_far', 1, 'farmalloc(farcoreleft()) whole; farfree gives it back; coalescing');
  eq('t_fmem', 1, '_fmemset/_fmemcpy on far blocks');
  eq('t_movedata', 1, 'movedata by segment:offset');
  eq('t_find', 1121, 'findfirst/findnext: 2 matches, KDREAMS.CMP, 5 bytes, ENMFILE');
  eq('t_find_none', 1, 'findfirst with no match: -1, errno ENOFILE');
  eq('t_date', 1, 'getdate from the fixed clock: 1997-01-01');
  run('t_clrscr');
  const u8 = p.M.mod.u8;
  report(u8[0xb8000] === 0x20 && u8[0xb8001] === 0x0e && u8[0xb8000 + 3998] === 0x20 && u8[0xb8000 + 3999] === 0x0e,
    `${model}: clrscr fills B800 with the textcolor attribute`, `attr 0x${u8[0xb8001].toString(16)}`);
  eq('t_bios', 11, 'bioskey(1) answers from ZF, bioskey(0) the key');
  report(keys.join(',') === '1,0', `${model}: bioskey is int 16h with AH = cmd`, keys.join(','));
  eq('t_consts', 1, 'errno = DOS codes; S_IREAD/S_IWRITE; ffblk offsets');
}

console.log(bad ? `\n${bad} WRONG` : '\nBorland\'s library, as far as Keen Dreams calls it.');
process.exit(bad ? 1 : 0);
