// borland-lib.js — the parts of Borland C++'s runtime library a real-mode program calls by name.
//
// Measured on Keen Dreams, and nothing beyond it: every function below is one its C calls, every
// constant one it names.
//
//   ltoa, ultoa, itoa          stdlib.h   scores, timers and memory figures printed as text
//   coreleft, farcoreleft,     alloc.h    id_mm.c grabs BOTH heaps whole at start-up:
//   farmalloc, farfree                    malloc(coreleft()), farmalloc(farcoreleft())
//   _fmemcpy, _fmemset         mem.h      copies between far buffers
//   S_IREAD, S_IWRITE          sys/stat.h the mode argument of open()
//   EINVFMT, ENOMEM, ENOENT    errno.h    compared against errno by the error reporter
//   findfirst                  dir.h      "does KDREAMS.CMP exist"
//   clrscr, textcolor          conio.h    the text screen at exit -- called WITHOUT conio.h
//                                         ("we can't include CONIO because of a name conflict")
//   struct date, getdate       dos.h      declared in GameFinale
//   bioskey                    bios.h     the BIOS keyboard, answered through int 16h
//
// NOT here, on purpose: sys_errlist. Its strings are Borland's own wording, which is not available
// to transcribe; a program that indexes it stays refused by name rather than printing invented text.
//
// Headers that already exist in PRISM (stdlib.h, string.h, sys/stat.h) are EXTENDED, not replaced:
// the base text first, Borland's additions after it.
//
// ERRNO NUMBERS ARE DOS ERROR CODES in Borland's library -- Keen itself writes `errno = _AX` after a
// failed int 21h -- so the ones declared here are exactly the DOS table's first eighteen, which are
// certain. Borland's others (EINVAL, EDOM, ERANGE, EEXIST...) are left UNDECLARED rather than typed
// in from memory: a program that names one is refused by name instead of compared against a guess.
// (PRISM's file layer does not set errno yet, in any model; findfirst below is the one that does.)
import { HEADERS } from './headers.js';
import * as T from '../sema/types.js';

const STDLIB_ADD = `
#ifndef __PRISM_BORLAND_STDLIB_H
#define __PRISM_BORLAND_STDLIB_H
char *ltoa(long value, char *string, int radix);
char *ultoa(unsigned long value, char *string, int radix);
#endif
`;

const STRING_ADD = `
#ifndef __PRISM_BORLAND_FMEM_H
#define __PRISM_BORLAND_FMEM_H
void far *_fmemcpy(void far *dest, const void far *src, size_t n);
void far *_fmemset(void far *s, int c, size_t n);
void movedata(unsigned srcseg, unsigned srcoff, unsigned dstseg, unsigned dstoff, size_t n);
#endif
`;

const STAT_ADD = `
#ifndef __PRISM_BORLAND_STAT_H
#define __PRISM_BORLAND_STAT_H
#define S_IREAD  0x0100
#define S_IWRITE 0x0080
#define S_IEXEC  0x0040
#endif
`;

export const BORLAND_LIB_HEADERS = {
  'stdlib.h': HEADERS['stdlib.h'] + STDLIB_ADD,
  'string.h': HEADERS['string.h'] + STRING_ADD,
  'mem.h': `#include <string.h>\n`,
  'sys/stat.h': HEADERS['sys/stat.h'] + STAT_ADD,
  'alloc.h': `
#ifndef __PRISM_BORLAND_ALLOC_H
#define __PRISM_BORLAND_ALLOC_H
#include <stdlib.h>
#ifdef __PRISM_FARDATA__
unsigned long coreleft(void);
#else
unsigned coreleft(void);
#endif
unsigned long farcoreleft(void);
void far *farmalloc(unsigned long nbytes);
void far *farcalloc(unsigned long nunits, unsigned long unitsz);
void farfree(void far *block);
#endif
`,
  'errno.h': `
#ifndef __PRISM_BORLAND_ERRNO_H
#define __PRISM_BORLAND_ERRNO_H
int errno;
int _doserrno;
#define EZERO    0
#define EINVFNC  1
#define ENOFILE  2
#define ENOENT   2
#define ENOPATH  3
#define EMFILE   4
#define EACCES   5
#define EBADF    6
#define ECONTR   7
#define ENOMEM   8
#define EINVMEM  9
#define EINVENV 10
#define EINVFMT 11
#define EINVACC 12
#define EINVDAT 13
#define EINVDRV 15
#define ECURDIR 16
#define ENOTSAM 17
#define ENMFILE 18
#endif
`,
  'dir.h': `
#ifndef __PRISM_BORLAND_DIR_H
#define __PRISM_BORLAND_DIR_H
/* Borland's layout, byte-aligned there; with alignment 2 the OFFSETS are the same and only the size
   rounds up from 43 to 44. */
struct ffblk {
  char     ff_reserved[21];
  char     ff_attrib;
  unsigned ff_ftime;
  unsigned ff_fdate;
  long     ff_fsize;
  char     ff_name[13];
};
#define FA_RDONLY 0x01
#define FA_HIDDEN 0x02
#define FA_SYSTEM 0x04
#define FA_LABEL  0x08
#define FA_DIREC  0x10
#define FA_ARCH   0x20
int findfirst(const char *pathname, struct ffblk *ffblk, int attrib);
int findnext(struct ffblk *ffblk);
#endif
`,
  'bios.h': `
#ifndef __PRISM_BORLAND_BIOS_H
#define __PRISM_BORLAND_BIOS_H
int bioskey(int cmd);
#endif
`,
  'conio.h': `
#ifndef __PRISM_BORLAND_CONIO_H
#define __PRISM_BORLAND_CONIO_H
void clrscr(void);
void textcolor(int newcolor);
void textbackground(int newcolor);
void textattr(int newattr);
#endif
`,
};

/** The dos.h additions: the date and time structures and their two calls. */
export const DOS_DATE_ADD = `
struct date { int da_year; char da_day; char da_mon; };
struct time { unsigned char ti_min; unsigned char ti_hour; unsigned char ti_hund; unsigned char ti_sec; };
void getdate(struct date *datep);
void gettime(struct time *timep);
`;

const PROTO = Object.freeze({ proto: true });
/*
 * Typed by the prototypes in the headers above -- except the conio calls, which Keen makes with NO
 * prototype in scope and so need a signature of their own. Those take only an int or nothing and
 * return nothing, so the shared (i386) int is a safe way to spell it: the argument converts the same.
 */
export const BORLAND_LIB_BUILTINS = {
  ...Object.fromEntries(['ltoa', 'ultoa', 'coreleft', 'farcoreleft', 'farmalloc', 'farcalloc', 'farfree',
    '_fmemcpy', '_fmemset', 'movedata', 'findfirst', 'findnext', 'getdate', 'gettime', 'bioskey'].map((n) => [n, PROTO])),
  clrscr: { ret: T.VOID, params: [] },
  textcolor: { ret: T.VOID, params: [T.INT] },
  textbackground: { ret: T.VOID, params: [T.INT] },
  textattr: { ret: T.VOID, params: [T.INT] },
};

/** Digits of an unsigned value in a radix, as Borland's itoa family writes them: lower case. */
const digits = (u, radix) => (radix >= 2 && radix <= 36 ? u.toString(radix) : null);

export function installBorlandLib(M) {
  const u8 = () => M.mod.u8, dv = () => M.mod.dv;
  const putStr = (p, s) => { for (let i = 0; i < s.length; i++) u8()[p + i] = s.charCodeAt(i); u8()[p + s.length] = 0; return p; };
  const cstr = (p) => M.mod.cstr(p);
  const setErrno = (v) => { const s = M.mod.symbols.get('errno'); if (s) dv().setInt16(s.addr, v, true); };
  const layout = M.mod.layout ?? {};
  const fatData = M.mod.model === 'dos16l';

  /*
   * THE FAR HEAP, where a model has far data apart from DGROUP (dos16m): from the paragraph after
   * the last far static up to the end of conventional memory. First-fit over a list of free ranges,
   * coalesced on free, paragraph-aligned -- id_mm.c takes FP_SEG+(FP_OFF+15)/16 of what it gets, so
   * any address would do, and a paragraph is what Borland's farmalloc hands back in practice. Where
   * there is no separate far data (dos16l, where every pointer is far) it is simply the heap malloc
   * uses.
   */
  const separate = M.mod.farBrk !== null && M.mod.farBrk !== undefined && layout.farEnd;
  const free = separate ? [[Math.ceil(M.mod.farBrk / 16) * 16, layout.farEnd]] : null;
  const used = new Map();
  const largest = () => free.reduce((m, [a, b]) => Math.max(m, b - a), 0);
  const farmalloc = (n) => {
    n = Number(n) >>> 0;
    if (!separate) { try { return M.rt.malloc(n); } catch { return 0; } }
    const need = Math.max(16, Math.ceil(n / 16) * 16);
    const i = free.findIndex(([a, b]) => b - a >= need);
    if (i < 0) return 0;
    const [a, b] = free[i];
    if (b - a === need) free.splice(i, 1); else free[i] = [a + need, b];
    used.set(a, need);
    return a;
  };
  const farfree = (p) => {
    p >>>= 0;
    if (!p) return;
    if (!separate) { M.rt.free(p); return; }
    const n = used.get(p);
    if (n === undefined) return;          // not ours: leave it alone rather than guess its size
    used.delete(p);
    free.push([p, p + n]);
    free.sort((x, y) => x[0] - y[0]);
    for (let i = 0; i + 1 < free.length;) {
      if (free[i][1] === free[i + 1][0]) { free[i][1] = free[i + 1][1]; free.splice(i + 1, 1); } else i++;
    }
  };
  /** What malloc can still hand out whole: its blocks carry an 8-byte header and round to 16. */
  const nearLeft = () => Math.max(0, Math.floor((M.heapTop - M.heapEnd) / 16) * 16 - 8);

  const conio = { attr: 0x07 };

  // A findfirst/findnext search in progress, keyed by the ffblk it fills.
  const searches = new Map();
  const wild = (pat) => new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  const fillFfblk = (blk, key) => {
    const bytes = M.files.store.get(key);
    const name = key.replace(/^.*\//, '').toUpperCase().slice(0, 12);
    u8().fill(0, blk, blk + 43);
    u8()[blk + 21] = 0x20;                                  // FA_ARCH
    dv().setInt32(blk + 26, bytes?.length ?? 0, true);      // ff_fsize
    putStr(blk + 30, name);
  };

  const api = {
    ltoa: (v, p, radix) => {
      v |= 0;
      const s = radix === 10 && v < 0 ? `-${digits(-v, 10)}` : digits(v >>> 0, radix);
      return putStr(p, s ?? '');
    },
    ultoa: (v, p, radix) => putStr(p, digits(v >>> 0, radix) ?? ''),
    // itoa at the width of THIS int: 16 bits, so itoa(-1, buf, 16) is "ffff" and not "ffffffff".
    itoa: (v, p, radix) => {
      const s16 = (v << 16) >> 16;
      const s = radix === 10 && s16 < 0 ? `-${digits(-s16, 10)}` : digits(s16 & 0xffff, radix);
      return putStr(p, s ?? '');
    },
    coreleft: () => (fatData ? nearLeft() : Math.min(nearLeft(), 0xffff)),
    farcoreleft: () => (separate ? largest() : nearLeft()),
    farmalloc,
    farcalloc: (n, sz) => {
      const bytes = (Number(n) >>> 0) * (Number(sz) >>> 0);
      const p = farmalloc(bytes);
      if (p) u8().fill(0, p, p + bytes);
      return p;
    },
    farfree,
    // Through the device window when a range touches it (M.winCopy/winFill, runtime.js).
    _fmemcpy: (d, s, n) => { M.blockCopy(d, s, n & 0xffff); return d; },
    _fmemset: (d, c, n) => { M.rt.memset(d, c, n & 0xffff); return d; },
    movedata: (ss, so, ds, dof, n) => { M.blockCopy(((ds & 0xffff) << 4) + (dof & 0xffff), ((ss & 0xffff) << 4) + (so & 0xffff), n & 0xffff); },

    findfirst: (pathPtr, blk, _attrib) => {
      if (!M.files) throw new Error('Borland findfirst: no file store (the stdio environment)');
      const pat = cstr(pathPtr).replace(/\\/g, '/').replace(/^.*\//, '');
      const re = wild(pat);
      const hits = [...M.files.store.keys()].filter((k) => re.test(k.replace(/^.*\//, ''))).sort();
      if (!hits.length) { setErrno(2); return -1; }      // ENOFILE
      fillFfblk(blk, hits[0]);
      searches.set(blk, hits.slice(1));
      return 0;
    },
    findnext: (blk) => {
      const rest = searches.get(blk) ?? [];
      if (!rest.length) { setErrno(18); return -1; }     // ENMFILE
      fillFfblk(blk, rest.shift());
      return 0;
    },

    /*
     * The date from PRISM's clock -- time(), which is fixed, so a run is reproducible -- as Borland's
     * struct date: da_year an int, then day and month as chars.
     */
    getdate: (p) => {
      const d = new Date(M.rt.time(0) * 1000);
      dv().setInt16(p, d.getUTCFullYear(), true);
      u8()[p + 2] = d.getUTCDate();
      u8()[p + 3] = d.getUTCMonth() + 1;
    },
    gettime: (p) => {
      const d = new Date(M.rt.time(0) * 1000);
      u8()[p] = d.getUTCMinutes(); u8()[p + 1] = d.getUTCHours(); u8()[p + 2] = 0; u8()[p + 3] = d.getUTCSeconds();
    },

    /*
     * bioskey IS int 16h with AH = cmd, so it goes to the same place a geninterrupt(0x16) would: the
     * handler the program installed, else a harness service, else a refusal by name. Commands 1 and
     * 0x11 ask "is a key waiting" and answer in ZF -- 0 when it is set, the key otherwise.
     */
    bioskey: (cmd) => {
      if (!M.interrupt) throw new Error('Borland bioskey: no interrupt dispatcher installed (the borland environment)');
      const regs = { ax: (cmd & 255) << 8, bx: 0, cx: 0, dx: 0, si: 0, di: 0, bp: 0, ds: 0, es: 0, cf: 0, zf: 0, sf: 0 };
      M.interrupt(0x16, regs);
      if ((cmd & 0xef) === 1) return regs.zf ? 0 : regs.ax & 0xffff;
      return regs.ax & 0xffff;
    },

    /*
     * The text screen, written the way Borland's conio writes it by default (directvideo): straight
     * into the 80x25 colour text buffer at B800:0000, character then attribute. The cursor, which
     * conio moves through the BIOS, is not moved: there is no BIOS.
     */
    clrscr: () => {
      for (let i = 0; i < 80 * 25; i++) { u8()[0xb8000 + i * 2] = 0x20; u8()[0xb8000 + i * 2 + 1] = conio.attr; }
    },
    textcolor: (c) => { conio.attr = (conio.attr & 0x70) | (c & 0x8f); },
    textbackground: (c) => { conio.attr = (conio.attr & 0x8f) | ((c & 7) << 4); },
    textattr: (a) => { conio.attr = a & 0xff; },
  };

  Object.assign(M.rt, api);
  return { conio, farFree: free, used };
}
