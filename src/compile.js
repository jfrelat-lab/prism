// compile.js — the driver: preprocess, parse, place, emit, link, run.
//
// This is the whole pipeline in one file so the seams are visible. Everything it does is tier-0.

import { Preprocessor } from './cpp/cpp.js';
import { parse } from './parse/parser.js';
import * as T from './sema/types.js';
import { Module } from './link/module.js';
import { makeMachine, finalizeHeap, ExitCalled, Trap } from './runtime/runtime.js';
import { FunctionEmitter, EmitError , jsIdent } from './backend/emit.js';
import { HEADERS } from './env/headers.js';
import { allegroBuiltins } from './env/allegro.js';
import { watcomBuiltins } from './env/watcom.js';
import { go32Builtins } from './env/go32.js';
import { dlBuiltins } from './env/dl.js';
import { installStdio } from './env/stdio.js';
import { installQuake } from './env/quake.js';
import { installPorts } from './env/ports.js';
import { installPIT } from './env/pit.js';
import { installConsole } from './env/console.js';

/**
 * Target macros a DJGPP-targeted source expects to find.
 *
 * The TYPE macros are not decoration: gcc's own torture suite opens with
 * `typedef __SIZE_TYPE__ size_t;` rather than including a header, and without the macro that reads
 * as `typedef ;`. Measured: 60 of 1575 torture programs failed on exactly that, making it the
 * largest single parse-error cluster — and it is a table, not a feature.
 */
/**
 * Merge the caller's defines over the target's, where a value of `null` means UNDEFINE.
 *
 * A build sometimes has to switch off a macro the target legitimately sets. Quake is the case that
 * forced this: `__i386__` is defined because the target IS i386, and real code tests it for
 * alignment and byte order — but Quake reads it as "the 21 hand-written .s files are available",
 * which for PRISM they are not. Quake's own answer on a non-x86 machine is that `__i386__` is absent
 * and `id386` becomes 0, selecting the portable C equivalent of every assembly routine. Expressing
 * that needs a way to say "not defined", which no amount of `{ __i386__: '0' }` can express: the
 * test is `#if defined __i386__`.
 */
export function mergeDefines(target, extra) {
  const out = { ...target };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export const TARGET_DEFINES = {
  __i386__: '1', i386: '1', __GNUC__: '4', __GNUC_MINOR__: '9',
  __STDC__: '1', __STDC_HOSTED__: '1', __CHAR_BIT__: '8', __ILP32__: '1',
  __SIZEOF_SHORT__: '2', __SIZEOF_INT__: '4', __SIZEOF_LONG__: '4', __SIZEOF_LONG_LONG__: '8',
  __SIZEOF_FLOAT__: '4', __SIZEOF_DOUBLE__: '8', __SIZEOF_LONG_DOUBLE__: '12',
  __SIZEOF_POINTER__: '4', __SIZEOF_SIZE_T__: '4', __SIZEOF_PTRDIFF_T__: '4',
  __SIZEOF_WCHAR_T__: '4',

  __SIZE_TYPE__: 'unsigned int',
  __PTRDIFF_TYPE__: 'int',
  __WCHAR_TYPE__: 'int',
  __WINT_TYPE__: 'unsigned int',
  __INTPTR_TYPE__: 'int',
  __UINTPTR_TYPE__: 'unsigned int',
  __INT8_TYPE__: 'signed char', __UINT8_TYPE__: 'unsigned char',
  __INT16_TYPE__: 'short', __UINT16_TYPE__: 'unsigned short',
  __INT32_TYPE__: 'int', __UINT32_TYPE__: 'unsigned int',
  __INT64_TYPE__: 'long long', __UINT64_TYPE__: 'unsigned long long',
  __INTMAX_TYPE__: 'long long', __UINTMAX_TYPE__: 'unsigned long long',

  __SCHAR_MAX__: '127', __SHRT_MAX__: '32767', __INT_MAX__: '2147483647',
  __LONG_MAX__: '2147483647L', __LONG_LONG_MAX__: '9223372036854775807LL',
  __INTMAX_MAX__: '9223372036854775807LL', __SIZE_MAX__: '4294967295U',
  __WCHAR_MAX__: '2147483647', __WCHAR_MIN__: '(-2147483647 - 1)',
  __FLT_MANT_DIG__: '24', __DBL_MANT_DIG__: '53',

  // Endianness. Leaving these out is not neutral: `#if __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__`
  // with both macros undefined compares 0 == 0 and takes the BIG-endian branch (widechar-3.c).
  __ORDER_LITTLE_ENDIAN__: '1234', __ORDER_BIG_ENDIAN__: '4321', __ORDER_PDP_ENDIAN__: '3412',
  __BYTE_ORDER__: '1234',

  /*
   * __DATE__ and __TIME__ are FIXED, not the wall clock. A compiler that stamps the real time makes
   * every build different, and this project's whole test strategy rests on the same input producing
   * the same output. gcc has -Wdate-time and SOURCE_DATE_EPOCH for the same reason. Quake prints
   * these in its banner, so the value is visible but constant.
   */
  __DATE__: '"Jan  1 1996"',
  __TIME__: '"00:00:00"',

  // gcc predefines the memory-order constants alongside the __atomic builtins.
  __ATOMIC_RELAXED: '0', __ATOMIC_CONSUME: '1', __ATOMIC_ACQUIRE: '2',
  __ATOMIC_RELEASE: '3', __ATOMIC_ACQ_REL: '4', __ATOMIC_SEQ_CST: '5',

  __PRISM__: '1',
};

/**
 * The libc surface the emitter may call directly. `params` are the FIXED parameter types; a
 * variadic entry takes its extras as one JS array. Nothing is listed here speculatively — every
 * entry exists because a gate case referenced it.
 */
const P = T.ptr(T.CHAR), I = T.INT, U = T.UINT, D = T.DOUBLE, V = T.VOID;
const FLT = T.scalar('float');
export const BUILTINS = new Map(Object.entries({
  printf: { ret: I, params: [P], variadic: true },
  fprintf: { ret: I, params: [P, P], variadic: true },
  sprintf: { ret: I, params: [P, P], variadic: true },
  snprintf: { ret: I, params: [P, U, P], variadic: true },
  vprintf: { ret: I, params: [P, P] },
  vfprintf: { ret: I, params: [P, P, P] },
  vsprintf: { ret: I, params: [P, P, P] },
  vsnprintf: { ret: I, params: [P, U, P, P] },

  // Files. ISO C, so every program gets them — they used to live inside MAME's platform shim, which
  // was the wrong home twice over. See src/env/stdio.js.
  fopen: { ret: P, params: [P, P] },
  fclose: { ret: I, params: [P] },
  fread: { ret: U, params: [P, U, U, P] },
  fwrite: { ret: U, params: [P, U, U, P] },
  fseek: { ret: I, params: [P, I, I] },
  ftell: { ret: I, params: [P] },
  rewind: { ret: V, params: [P] },
  fgetc: { ret: I, params: [P] },
  getc: { ret: I, params: [P] },
  ungetc: { ret: I, params: [I, P] },
  fgets: { ret: P, params: [P, I, P] },
  putc: { ret: I, params: [I, P] },
  feof: { ret: I, params: [P] },
  ferror: { ret: I, params: [P] },
  clearerr: { ret: V, params: [P] },
  fflush: { ret: I, params: [P] },
  unlink: { ret: I, params: [P] },
  remove: { ret: I, params: [P] },
  rename: { ret: I, params: [P, P] },
  strerror: { ret: P, params: [I] },
  select: { ret: I, params: [I, P, P, P, P] },
  fscanf: { ret: I, params: [P, P], variadic: true },
  sscanf: { ret: I, params: [P, P], variadic: true },
  scanf: { ret: I, params: [P], variadic: true },
  /*
   * Xlib. Doom's only published source is its Linux/X11 tree, so being a UNIX host means being an X
   * client — see src/env/x11.js, which shims the LIBRARY and not the protocol.
   */
  XOpenDisplay: { ret: P, params: [P] },
  XCloseDisplay: { ret: I, params: [P] },
  XSync: { ret: I, params: [P, I] },
  XFlush: { ret: I, params: [P] },
  XSynchronize: { ret: I, params: [P, I] },
  XDefaultScreen: { ret: I, params: [P] },
  XRootWindow: { ret: U, params: [P, I] },
  XCreateColormap: { ret: U, params: [P, U, P, I] },
  XCreateGC: { ret: P, params: [P, U, U, P] },
  XFreeGC: { ret: I, params: [P, P] },
  XCreatePixmap: { ret: U, params: [P, U, U, U, U] },
  XFreePixmap: { ret: I, params: [P, U] },
  XCreatePixmapCursor: { ret: U, params: [P, U, U, P, P, U, U] },
  XDefineCursor: { ret: I, params: [P, U, U] },
  XFillRectangle: { ret: I, params: [P, U, P, I, I, U, U] },
  XGrabPointer: { ret: I, params: [P, U, I, U, I, I, U, U, U] },
  XUngrabPointer: { ret: I, params: [P, U] },
  XWarpPointer: { ret: I, params: [P, U, U, I, I, U, U, I, I] },
  XSelectInput: { ret: I, params: [P, U, I] },
  XStoreName: { ret: I, params: [P, U, P] },
  XSetWindowColormap: { ret: I, params: [P, U, U] },
  XAutoRepeatOn: { ret: I, params: [P] },
  XAutoRepeatOff: { ret: I, params: [P] },
  XMapWindow: { ret: I, params: [P, U] },
  XVisualIDFromVisual: { ret: U, params: [P] },
  XMatchVisualInfo: { ret: I, params: [P, I, I, I, P] },
  XGetVisualInfo: { ret: P, params: [P, T.LONG, P, P] },
  XDefaultVisual: { ret: P, params: [P, I] },
  XDestroyWindow: { ret: I, params: [P, P] },
  XFreeColormap: { ret: I, params: [P, P] },
  XCreateWindow: { ret: U, params: [P, U, I, I, U, U, U, I, U, P, U, P] },
  XCreateImage: { ret: P, params: [P, P, U, I, I, P, U, U, I, I] },
  XPutImage: { ret: I, params: [P, U, P, P, I, I, I, I, U, U] },
  XStoreColors: { ret: I, params: [P, U, P, I] },
  XPending: { ret: I, params: [P] },
  XNextEvent: { ret: I, params: [P, P] },
  XKeycodeToKeysym: { ret: U, params: [P, U, I] },
  XLookupString: { ret: I, params: [P, P, I, P, P] },
  XShmQueryExtension: { ret: I, params: [P] },
  XShmGetEventBase: { ret: I, params: [P] },
  XShmCreateImage: { ret: P, params: [P, P, U, I, P, P, U, U] },
  XShmAttach: { ret: I, params: [P, P] },
  XShmDetach: { ret: I, params: [P, P] },
  XShmPutImage: { ret: I, params: [P, U, P, P, I, I, I, I, U, U, I] },
  shmget: { ret: I, params: [I, U, I] },
  shmat: { ret: P, params: [I, P, I] },
  shmdt: { ret: I, params: [P] },
  shmctl: { ret: I, params: [I, I, P] },
  socket: { ret: I, params: [I, I, I] },
  bind: { ret: I, params: [I, P, U] },
  sendto: { ret: I, params: [I, P, U, I, P, U] },
  recvfrom: { ret: I, params: [I, P, U, I, P, P] },
  setsockopt: { ret: I, params: [I, I, I, P, U] },
  htons: { ret: U, params: [U] },
  ntohs: { ret: U, params: [U] },
  htonl: { ret: U, params: [U] },
  ntohl: { ret: U, params: [U] },
  inet_addr: { ret: U, params: [P] },
  inet_ntoa: { ret: P, params: [U] },
  gethostbyname: { ret: P, params: [P] },
  signal: { ret: P, params: [I, P] },
  raise: { ret: I, params: [I] },
  setitimer: { ret: I, params: [I, P, P] },
  getitimer: { ret: I, params: [I, P, P] },
  alloca: { ret: P, params: [U] },

  // I/O ports — see src/env/ports.js, the seam MIRAGE's devices plug into.
  inportb: { ret: I, params: [I] },
  inportw: { ret: I, params: [I] },
  outportb: { ret: V, params: [I, I] },
  outportw: { ret: V, params: [I, I] },
  inp: { ret: I, params: [I] },
  outp: { ret: I, params: [I, I] },

  rand: { ret: I, params: [] },
  srand: { ret: V, params: [U] },
  isalnum: { ret: I, params: [I] },
  isalpha: { ret: I, params: [I] },
  iscntrl: { ret: I, params: [I] },
  isdigit: { ret: I, params: [I] },
  isgraph: { ret: I, params: [I] },
  islower: { ret: I, params: [I] },
  isprint: { ret: I, params: [I] },
  ispunct: { ret: I, params: [I] },
  isspace: { ret: I, params: [I] },
  isupper: { ret: I, params: [I] },
  isxdigit: { ret: I, params: [I] },
  tolower: { ret: I, params: [I] },
  toupper: { ret: I, params: [I] },
  // POSIX, taken from SQLite's own syscall table (its unix VFS lists every call it makes) and from
  // Doom's i_system.c. See src/env/stdio.js — they all ride on the one file store.
  access: { ret: I, params: [P, I] },
  getcwd: { ret: P, params: [P, U] },
  stat: { ret: I, params: [P, P] },
  lstat: { ret: I, params: [P, P] },
  fstat: { ret: I, params: [I, P] },
  ftruncate: { ret: I, params: [I, I] },
  fcntl: { ret: I, params: [I, I], variadic: true },
  pread: { ret: I, params: [I, P, U, I] },
  pwrite: { ret: I, params: [I, P, U, I] },
  fchmod: { ret: I, params: [I, U] },
  fchown: { ret: I, params: [I, U, U] },
  fallocate: { ret: I, params: [I, I, I, I] },
  mkdir: { ret: I, params: [P, U] },
  _mkdir: { ret: I, params: [P] },
  _rmdir: { ret: I, params: [P] },
  rmdir: { ret: I, params: [P] },
  chdir: { ret: I, params: [P] },
  rmdir: { ret: I, params: [P] },
  geteuid: { ret: I, params: [] },
  getuid: { ret: I, params: [] },
  getgid: { ret: I, params: [] },
  getpid: { ret: I, params: [] },
  getpagesize: { ret: I, params: [] },
  readlink: { ret: I, params: [P, P, U] },
  ioctl: { ret: I, params: [I, U], variadic: true },
  usleep: { ret: I, params: [U] },
  sleep: { ret: U, params: [U] },
  isatty: { ret: I, params: [I] },
  mmap: { ret: P, params: [P, U, I, I, I, I] },
  mremap: { ret: P, params: [P, U, U, I] },
  munmap: { ret: I, params: [P, U] },
  mprotect: { ret: I, params: [P, U, I] },
  setmntent: { ret: P, params: [P, P] },
  getmntent: { ret: P, params: [P] },
  endmntent: { ret: I, params: [P] },
  msync: { ret: I, params: [P, U, I] },
  chmod: { ret: I, params: [P, U] },
  umask: { ret: U, params: [U] },
  fsync: { ret: I, params: [I] },
  fdatasync: { ret: I, params: [I] },
  sysconf: { ret: I, params: [I] },
  getenv: { ret: P, params: [P] },
  opendir: { ret: P, params: [P] },
  readdir: { ret: P, params: [P] },
  closedir: { ret: I, params: [P] },
  putenv: { ret: I, params: [P] },
  sigaction: { ret: I, params: [I, P, P] },
  sigemptyset: { ret: I, params: [P] }, sigfillset: { ret: I, params: [P] },
  sigaddset: { ret: I, params: [P, I] },
  getuid: { ret: I, params: [] }, geteuid: { ret: I, params: [] },
  getgid: { ret: I, params: [] }, getegid: { ret: I, params: [] },
  setuid: { ret: I, params: [I] }, seteuid: { ret: I, params: [I] },
  setgid: { ret: I, params: [I] }, setegid: { ret: I, params: [I] },
  setreuid: { ret: I, params: [I, I] }, setregid: { ret: I, params: [I, I] },
  setenv: { ret: I, params: [P, P, I] },
  __builtin_clzll: { ret: I, params: [T.LLONG ?? U] },
  __builtin_clz: { ret: I, params: [U] },
  __builtin_ctz: { ret: I, params: [U] },
  utimes: { ret: I, params: [P, P] },
  gmtime: { ret: P, params: [P] },
  nanosleep: { ret: I, params: [P, P] },
  __builtin_bswap16: { ret: U, params: [U] },
  __builtin_bswap32: { ret: U, params: [U] },
  __atomic_load_n: { ret: I, params: [P, I] },
  __atomic_store_n: { ret: V, params: [P, I, I] },
  __atomic_fetch_add: { ret: I, params: [P, I, I] },
  strcasecmp: { ret: I, params: [P, P] },
  strncasecmp: { ret: I, params: [P, P, U] },
  perror: { ret: V, params: [P] },
  setbuf: { ret: V, params: [P, P] },
  setvbuf: { ret: I, params: [P, P, I, U] },
  popen: { ret: P, params: [P, P] },
  pclose: { ret: I, params: [P] },
  gethostname: { ret: I, params: [P, U] },
  strspn: { ret: U, params: [P, P] },
  strcspn: { ret: U, params: [P, P] },
  lseek: { ret: I, params: [I, I, I] },
  localtime: { ret: P, params: [P] },
  gettimeofday: { ret: I, params: [P, P] },
  atof: { ret: D, params: [P] },
  atol: { ret: I, params: [P] },
  open: { ret: I, params: [P, I], variadic: true },
  close: { ret: I, params: [I] },
  write: { ret: I, params: [I, P, U] },
  read: { ret: I, params: [I, P, U] },
  puts: { ret: I, params: [P] },
  putchar: { ret: I, params: [I] },
  gets: { ret: P, params: [P] },
  getchar: { ret: I, params: [] },
  fputs: { ret: I, params: [P, P] },
  fputc: { ret: I, params: [I, P] },
  malloc: { ret: P, params: [U] },
  calloc: { ret: P, params: [U, U] },
  realloc: { ret: P, params: [P, U] },
  free: { ret: V, params: [P] },
  exit: { ret: V, params: [I] },
  _exit: { ret: V, params: [I] },
  abort: { ret: V, params: [] },
  atoi: { ret: I, params: [P] },
  atol: { ret: T.LONG, params: [P] },
  // Watcom #pragma aux intrinsics; see src/runtime/runtime.js. A program's own definition wins.
  FixedMul: { ret: I, params: [I, I] },
  FixedDiv2: { ret: I, params: [I, I] },
  stricmp: { ret: I, params: [P, P] },
  strcmpi: { ret: I, params: [P, P], impl: 'stricmp' },
  strnicmp: { ret: I, params: [P, P, U] },
  strupr: { ret: P, params: [P] },
  strlwr: { ret: P, params: [P] },
  getche: { ret: I, params: [] },
  getwd: { ret: P, params: [P] },
  atexit: { ret: I, params: [P] },
  sbrk: { ret: P, params: [I] },
  strtol: { ret: T.LONG, params: [P, P, I] },
  strtoul: { ret: T.ULONG, params: [P, P, I] },
  abs: { ret: I, params: [I] },
  random: { ret: T.LONG, params: [] },
  srandom: { ret: V, params: [U] },
  labs: { ret: T.LONG, params: [T.LONG] },
  strlen: { ret: U, params: [P] },
  strcpy: { ret: P, params: [P, P] },
  strncpy: { ret: P, params: [P, P, U] },
  strcat: { ret: P, params: [P, P] },
  strcmp: { ret: I, params: [P, P] },
  strncmp: { ret: I, params: [P, P, U] },
  strchr: { ret: P, params: [P, I] },
  strncat: { ret: P, params: [P, P, U] },
  strdup: { ret: P, params: [P] },
  strpbrk: { ret: P, params: [P, P] },
  strtok: { ret: P, params: [P, P] },
  qsort: { ret: T.VOID, params: [P, U, U, P] },
  memcpy: { ret: P, params: [P, P, U] },
  memmove: { ret: P, params: [P, P, U] },
  memset: { ret: P, params: [P, I, U] },
  memcmp: { ret: I, params: [P, P, U] },
  sqrt: { ret: D, params: [D] }, sin: { ret: D, params: [D] }, cos: { ret: D, params: [D] },
  tan: { ret: D, params: [D] }, atan: { ret: D, params: [D] }, atan2: { ret: D, params: [D, D] },
  asin: { ret: D, params: [D] }, acos: { ret: D, params: [D] },
  exp: { ret: D, params: [D] }, log: { ret: D, params: [D] }, log10: { ret: D, params: [D] },
  pow: { ret: D, params: [D, D] }, floor: { ret: D, params: [D] }, ceil: { ret: D, params: [D] },
  fabs: { ret: D, params: [D] }, fmod: { ret: D, params: [D, D] },
  /*
   * The float family, declared as taking and returning FLOAT. That is not cosmetic: PRISM rounds a
   * float store with Math.fround, and a builtin declared in double would keep the extra precision
   * through the call -- which is exactly the kind of divergence csmith exists to find.
   */
  sqrtf: { ret: FLT, params: [FLT] }, sinf: { ret: FLT, params: [FLT] },
  cosf: { ret: FLT, params: [FLT] }, tanf: { ret: FLT, params: [FLT] },
  atanf: { ret: FLT, params: [FLT] }, atan2f: { ret: FLT, params: [FLT, FLT] },
  expf: { ret: FLT, params: [FLT] }, logf: { ret: FLT, params: [FLT] },
  log10f: { ret: FLT, params: [FLT] }, powf: { ret: FLT, params: [FLT, FLT] },
  floorf: { ret: FLT, params: [FLT] }, ceilf: { ret: FLT, params: [FLT] },
  fabsf: { ret: FLT, params: [FLT] }, fmodf: { ret: FLT, params: [FLT, FLT] },
  ldexp: { ret: D, params: [D, I] }, ldexpf: { ret: FLT, params: [FLT, I] },
  frexp: { ret: D, params: [D, P] },

  // gcc's torture suite calls the __builtin_ spelling rather than the library name — 124 programs
  // use __builtin_abort alone, which made it the single largest gap in the corpus. These are
  // aliases, not new behaviour.
  __builtin_abort: { ret: V, params: [], impl: 'abort' },
  __builtin_exit: { ret: V, params: [I], impl: 'exit' },
  __builtin_memcpy: { ret: P, params: [P, P, U], impl: 'memcpy' },
  __builtin_memmove: { ret: P, params: [P, P, U], impl: 'memmove' },
  __builtin_memset: { ret: P, params: [P, I, U], impl: 'memset' },
  __builtin_memcmp: { ret: I, params: [P, P, U], impl: 'memcmp' },
  __builtin_strlen: { ret: U, params: [P], impl: 'strlen' },
  __builtin_strcpy: { ret: P, params: [P, P], impl: 'strcpy' },
  __builtin_strcmp: { ret: I, params: [P, P], impl: 'strcmp' },
  __builtin_malloc: { ret: P, params: [U], impl: 'malloc' },
  __builtin_free: { ret: V, params: [P], impl: 'free' },
  __builtin_printf: { ret: I, params: [P], variadic: true, impl: 'printf' },
  __builtin_puts: { ret: I, params: [P], impl: 'puts' },
  __builtin_putchar: { ret: I, params: [I], impl: 'putchar' },
  __builtin_abs: { ret: I, params: [I], impl: 'abs' },
  __builtin_expect: { ret: T.LONG, params: [T.LONG, T.LONG], impl: '__builtin_expect' },
  __builtin_prefetch: { ret: V, params: [P], variadic: true, impl: '__builtin_prefetch' },
  __builtin_return_address: { ret: P, params: [U], impl: '__builtin_return_address' },
  __builtin_frame_address: { ret: P, params: [U], impl: '__builtin_return_address' },
  __builtin_constant_p: { ret: I, params: [I], impl: '__builtin_constant_p' },
  __builtin_unreachable: { ret: V, params: [], impl: 'abort' },
  alloca: { ret: P, params: [U], impl: 'alloca' },
  __builtin_alloca: { ret: P, params: [U], impl: 'alloca' },
  // The variadic pair. __prism_va_start is intercepted by the emitter (it must resolve to the
  // current function's hidden buffer parameter); __prism_va_next is an ordinary runtime call.
  // setjmp is intercepted by the emitter: it must become a resume point in the function's state
  // machine, which a plain call cannot express. longjmp is an ordinary runtime call that throws.
  setjmp: { ret: I, params: [P], setjmp: true },
  longjmp: { ret: V, params: [P, I] },
  __prism_setjmp: { ret: I, params: [P, P, I] },
  __prism_va_start: { ret: P, params: [], vaStart: true },
  __prism_va_next: { ret: P, params: [P, U] },
  clock: { ret: T.ULONG, params: [] },
  uclock: { ret: T.ULLONG, params: [] },
  time: { ret: T.LONG, params: [P] },
  strrchr: { ret: P, params: [P, I] },
  strstr: { ret: P, params: [P, P] },
  memchr: { ret: P, params: [P, I, U] },
}));

/*
 * Allegro, SEAL and the DJGPP memory helpers: the libraries MAME 0.1's OWN src/msdos/msdos.c links
 * against. Kept next to their implementation in src/env/allegro.js.
 */
for (const [k, v] of Object.entries(allegroBuiltins(T))) BUILTINS.set(k, v);
// The Watcom/DOS4GW runtime Heretic and Hexen call; see src/env/watcom.js.
for (const [k, v] of Object.entries(watcomBuiltins(T))) BUILTINS.set(k, v);
// DJGPP's DPMI floor, which Quake's dos_v2.c builds all of dosisms.h on; see src/env/go32.js.
for (const [k, v] of Object.entries(go32Builtins(T))) BUILTINS.set(k, v);
for (const [k, v] of Object.entries(dlBuiltins(T))) BUILTINS.set(k, v);

export class CompileError extends Error {}

/**
 * Compile one translation unit.
 * @returns {{M, F, src, run: (argv?: string[]) => {code: number, stdout: string}}}
 */
/*
 * The module epilogue: every emitted function published on `F`, plus a rebinder.
 *
 * `F` is how every harness in tools/ instruments a program -- replace `prog.F["R_DrawColumn"]` and
 * the next call goes to the wrapper. A DIRECT call cannot see that: it names the emitted function's
 * own binding, which is exactly why it is 2-2.5x faster than a property load off a thousand-property
 * object V8 keeps in dictionary mode. So the module hands back a function that assigns to that
 * binding, and `F`'s properties become accessors that drive it. Instrumentation keeps working,
 * unchanged, and the calls stay direct.
 *
 * A function DECLARATION creates a MUTABLE binding, in strict mode too, so `foo = wrapper` is legal
 * and no `let` is needed. A switch rather than an object of setters: the latter would allocate one
 * closure per function at start-up, a cost every program pays to serve the few that instrument.
 */
const moduleEpilogue = (emitted) =>
  emitted.map(n => `F[${JSON.stringify(n)}]=${jsIdent(n)};`).join('\n') +
  '\nreturn function(n,fn){switch(n){\n' +
  emitted.map(n => `case ${JSON.stringify(n)}:${jsIdent(n)}=fn;return true;`).join('\n') +
  '\n}\nreturn false;};\n';

/** Make `prog.F[name] = fn` reach the module-scope binding a direct call resolves to. */
function wireRebind(F, mod, emitted, rebind) {
  if (typeof rebind !== 'function') return;
  mod.rebindEmitted = rebind;
  for (const name of emitted) {
    let cur = F[name];
    Object.defineProperty(F, name, {
      configurable: true, enumerable: true,
      get: () => cur,
      set: (fn) => { cur = fn; rebind(name, fn); mod.bindFunc(name, fn); },
    });
  }
}

export function compile(source, { file = 'main.c', defines = {}, resolve = null, memory, shared = false, safepoints = false, directCalls = true, pack = null } = {}) {
  const pp = new Preprocessor({
    defines: mergeDefines(TARGET_DEFINES, defines),
    resolve: resolve ?? builtinHeaderResolver(),
  });
  const tokens = pp.run(source, file);
  const { unit, scope } = parse(tokens, { file, pack });

  const mod = new Module({ ...(memory ? { memory } : {}), shared });
  const M = makeMachine(mod);
  // A text console in guest memory from the start, so stdout has somewhere real to land. The host
  // replaces `readChar` with a blocking one; headless, stdin is simply at EOF.
  installConsole(M);

  // Pass 1: give every file-scope name an address BEFORE any body is emitted, because a body may
  // reference a global or take a function's address before its definition appears.
  const globals = new Map();
  const funcs = new Map();
  for (const d of unit.decls) {
    if (d.n === 'vardecl') {
      if (d.type.k === 'func') { funcs.set(d.name, mod.defineFunc(d.name, d.type)); continue; }
      if (d.storage === 'extern' && !d.init) continue;
      const sym = mod.defineGlobal(d.name, d.type);
      globals.set(d.name, { addr: sym.addr, type: d.type });
    } else if (d.n === 'func') {
      const f0 = mod.defineFunc(d.name, d.type);
      f0.defined = true;                      // a body, not just a prototype
      funcs.set(d.name, f0);
    }
  }

  // Pass 2: emit. Static initialisers are written straight into the image where they are constant.
  const ctx = { globals, funcs, builtins: BUILTINS, safepoints, directCalls };
  const pieces = [];
  const emitted = [];
  for (const d of unit.decls) {
    if (d.n === 'vardecl' && globals.has(d.name) && d.init) {
      staticInit(mod, globals.get(d.name).addr, d.type, d.init, ctx);
      continue;
    }
    if (d.n !== 'func') continue;
    const fe = new FunctionEmitter(mod, d, ctx);
    pieces.push(fe.emit());
    emitted.push(d.name);
  }

  finalizeHeap(M);

  const src = `"use strict";\nreturn function(M,F,D){\n${pieces.join('\n')}\n` +
    // The KEY is the C name; the value is the JavaScript identifier, which differs whenever the C
    // name is a JS reserved word (`in`, `new`, `class`…).
    `${moduleEpilogue(emitted)}};`;

  let factory;
  try {
    factory = new Function(src)();
  } catch (e) {
    throw new CompileError(`emitted JavaScript did not compile: ${e.message}\n${numbered(src)}`);
  }
  const F = Object.create(null);
  const rebind = factory(M, F, mod.dv);
  for (const name of emitted) mod.bindFunc(name, F[name]);
  wireRebind(F, mod, emitted, rebind);
  // A builtin whose ADDRESS was taken needs its table slot filled with the runtime's own function,
  // so a call through the pointer lands where a direct call would.
  for (const name of ctx.builtinRefs ?? []) {
    const impl = M.rt[BUILTINS.get(name)?.impl ?? name];
    if (typeof impl === 'function') mod.bindFunc(name, impl);
  }

  installStdio(M);
  installPIT(installPorts(M), M);

  return { M, F, src, mod, run: makeRunner(M, F, mod) };
}


export { installConsole };
export { installStdio };
export { installQuake };
export { installPorts, installPIT };

/**
 * Compile and link SEVERAL translation units into one module.
 *
 * The only real subtlety is C's internal linkage: a file-scope `static` is private to its unit, so
 * two files may each have their own `static int errorlog`, and MAME's Z80.c alone has hundreds of
 * statics. Those names are mangled per unit; everything with external linkage is shared, which is
 * what lets a game driver call into the CPU core across a file boundary.
 *
 * @param units [{file, source}]
 */
// Reported in diagnostics only. Spelled out rather than imported from node:path, because src/
// must stay loadable in a browser: the web shell imports these modules directly, unbundled.
const basename = (p) => String(p).replace(/\\/g, '/').replace(/^.*\//, '');

export function compileProgram(units, { defines = {}, resolve = null, memory, includes = {}, collect = false, shared = false, safepoints = false, directCalls = true, pack = null, exports: moduleExports = {} } = {}) {
  // moduleExports: module name -> the names it makes visible to the main module. See `visible` below.
  const exportsOf = new Map(Object.entries(moduleExports).map(([k, v]) => [k, new Set(v)]));
  const failures = [];
  const mod = new Module({ ...(memory ? { memory } : {}), shared });
  const M = makeMachine(mod);
  // A text console in guest memory from the start, so stdout has somewhere real to land. The host
  // replaces `readChar` with a blocking one; headless, stdin is simply at EOF.
  installConsole(M);
  const resolver = resolve ?? builtinHeaderResolver(includes);

  // Parse every unit first: pass 1 must see all declarations before any body is emitted.
  const parsed = [];
  for (const u of units) {
    /*
     * Per-unit defines, layered over the program's.
     *
     * A makefile compiles some files differently -- Heretic's own compiles `i_ibm.c` with a
     * different option line from every other file -- so one `defines` for a whole program is not
     * how these builds actually work. `null` UNDEFINES, which is what selects a source's C fallback
     * where the compiler's own identity macro selects assembly.
     */
    const pp = new Preprocessor({
      defines: mergeDefines(mergeDefines(TARGET_DEFINES, defines), u.defines ?? {}),
      resolve: resolver,
    });
    const tokens = pp.run(u.source, u.file);
    const { unit, scope } = parse(tokens, { file: u.file, pack });
    parsed.push({ ...u, unit, scope, tag: tagOf(u.file) });
  }

  /*
   * Pass 1: place every name.
   *
   * A static gets a private linkage name. The rest are shared -- but shared WITHIN A MODULE, not
   * across the program, because a program of this era is often several shared objects and they do
   * not see each other's globals.
   *
   * Quake II is the case that forced this. qcommon/common.c, game/g_main.c and ref_soft/r_main.c
   * each define Com_Printf, routed through their own import struct, because in a real build they
   * are three .so files that never meet. Flattened into one namespace they collide and the last one
   * silently wins -- the engine ends up printing through a refimport_t full of zeros.
   *
   * The visibility rule below is ELF's, not an invention: a shared object sees its own symbols and
   * the executable's globals, and everything else it needs arrives through the struct of function
   * pointers the program hands it. A module's EXPORTS -- read from the program's own .def file --
   * are the only names that travel the other way.
   */
  const moduleNames = [...new Set(parsed.map(p => p.module ?? 'main'))];
  const MAIN = moduleNames[0];
  const perModule = new Map(moduleNames.map(m => [m, { globals: new Map(), funcs: new Map() }]));
  const sharedGlobals = perModule.get(MAIN).globals, sharedFuncs = perModule.get(MAIN).funcs;

  /*
   * The objects LIBC provides, defined whether or not any translation unit declares them.
   *
   * `errno` is the whole list, and it earns its place: it is an object in libc, not in a header, and
   * C89 programs are entitled to declare it themselves. Doom's sound server does exactly that --
   * `extern int errno;` inside myioctl, with no #include <errno.h> anywhere -- which resolved to
   * nothing and killed the one function every ioctl goes through. PRISM's errno.h carries a
   * tentative definition, so a program that DOES include it merges with this one under the same
   * common-symbol rule that already merges tentative definitions between units.
   */
  sharedGlobals.set('errno', { addr: mod.defineGlobal('errno', T.INT).addr, type: T.INT });
  const duplicates = [];
  for (const p of parsed) {
    p.globals = new Map();
    p.funcs = new Map();
    const home = perModule.get(p.module ?? 'main');
    // A non-main module's external names are qualified, so two modules may each define Com_Printf
    // and each get its own body -- which is what the separate .so files of a real build give them.
    const qualify = (n) => ((p.module ?? 'main') === MAIN ? n : `${p.module}\u0024${n}`);
    for (const d of p.unit.decls) {
      const internal = d.storage === 'static';
      if (d.n === 'vardecl') {
        const link = internal ? `${p.tag}$${d.name}` : qualify(d.name);
        if (d.type.k === 'func') {
          (internal ? p.funcs : home.funcs).set(d.name, mod.defineFunc(link, d.type));
          continue;
        }
        /*
         * `extern int x;` with no initialiser declares; it does not define. But it does state the
         * TYPE this unit will use, which is not always the type the defining unit used.
         *
         * OpenDUNE is the case. src/script/script.c defines `struct Team *g_scriptCurrentTeam;`
         * without ever including team.h, so its struct Team is incomplete; src/script/team.c
         * declares the same object with team.h in scope and writes `g_scriptCurrentTeam->members`.
         * Both are legal C -- a linker matches NAMES, and each translation unit compiles against the
         * declaration in front of it. Making every unit inherit the definer's type made the member
         * access fail in the unit that could see the members.
         */
        if (d.storage === 'extern' && !d.init) { (p.externDecls ??= []).push(d); continue; }
        const sym = mod.defineGlobal(link, d.type);
        (internal ? p.globals : home.globals).set(d.name, { addr: sym.addr, type: d.type });
      } else if (d.n === 'func') {
        /*
         * A definition with NO storage class keeps the INTERNAL linkage of a prior static
         * declaration in the same unit -- C99 6.2.2p4. Heretic writes exactly that:
         *
         *     static void DrawMainBar(void);      // SB_BAR.C:39
         *     void DrawMainBar(void)              // SB_BAR.C:909
         *
         * Treating the definition as external gave the name TWO objects, `SB_BAR$DrawMainBar` and
         * `DrawMainBar`, and every call in the file resolved to the static one -- which nothing
         * defined. It compiled and then threw when called. Quake II's qmenu.c does the same for
         * eight of its own drawing routines.
         */
        const priorStatic = d.storage !== 'extern' && p.funcs.has(d.name);
        const isInternal = internal || priorStatic;
        const link = isInternal ? `${p.tag}$${d.name}` : qualify(d.name);
        const fn = mod.defineFunc(link, d.type);
        /*
         * A SECOND definition of an external name, which a real linker refuses and this silently
         * took the last of. Worth catching rather than tolerating: emitted functions all share one
         * JavaScript scope, so a duplicate `function foo(){}` shadows the earlier one and every call
         * in the program -- including calls emitted before it -- goes to the wrong body.
         *
         * Quake II is what found this. qcommon/common.c, game/g_main.c and ref_soft/r_main.c each
         * define Com_Printf, routed to their own import struct, because in a real build they are
         * three separate shared objects that never meet. Flattened into one program, the renderer's
         * won, so the engine printed through a refimport_t that was still zero.
         */
        if (!isInternal && fn.defined) {
          duplicates.push({ name: d.name, unit: basename(p.file), module: p.module ?? MAIN });
        }
        // A DEFINITION, not just a prototype: the distinction decides whether a call reaches the
        // program's own code or a runtime builtin of the same name.
        fn.defined = true;
        (isInternal ? p.funcs : home.funcs).set(d.name, fn);
      }
    }
  }

  // Pass 2: emit, with each unit's statics shadowing the shared names.
  const pieces = [], emitted = [];
  // Shared across units: a builtin whose address is taken in ONE unit still needs binding once.
  const builtinRefs = new Set();
  // name -> the units that CALL it, for every name declared here and defined nowhere.
  const undefinedCalls = new Map();

  /*
   * What each module can SEE, built once.
   *
   * A module sees its own externals, then the main module's -- ELF's rule, where a shared object
   * resolves against the executable's globals for anything it does not define itself. The main
   * module sees, in addition, the names other modules EXPORT: `EXPORTS GetRefAPI` in
   * ref_soft/ref_soft.def and `EXPORTS GetGameAPI` in game/game.def, one symbol each. That export
   * list is the program's own file, not a list written here.
   */
  const visible = new Map();
  /*
   * A DECLARATION must not shadow a DEFINITION from further out.
   *
   * ref_soft includes q_shared.h, which prototypes Swap_Init, so pass 1 gave ref_soft a
   * module-qualified name for a function whose only body is in the main module. Overlaying blindly
   * made every ref_soft call reach `ref_soft$Swap_Init`, which nothing defines. A prototype claims
   * nothing; only a body does.
   */
  const preferDefined = (outer, inner) => {
    const m = new Map(outer);
    for (const [k, v] of inner) {
      if (v?.defined || !(outer.get(k)?.defined)) m.set(k, v);
    }
    return m;
  };
  for (const m of moduleNames) {
    const own = perModule.get(m), main = perModule.get(MAIN);
    if (m !== MAIN) {
      visible.set(m, {
        globals: overlay(main.globals, own.globals),
        funcs: preferDefined(main.funcs, own.funcs),
      });
      continue;
    }
    // The main module additionally sees what the others EXPORT -- unless it defines the name itself.
    const globals = new Map(own.globals), exported = new Map();
    for (const other of moduleNames) {
      if (other === MAIN) continue;
      for (const name of exportsOf.get(other) ?? []) {
        const f = perModule.get(other).funcs.get(name);
        if (f) exported.set(name, f);
        const g = perModule.get(other).globals.get(name);
        if (g && !globals.has(name)) globals.set(name, g);
      }
    }
    visible.set(m, { globals, funcs: preferDefined(own.funcs, exported) });
  }

  /*
   * Each unit's own declarations of objects it does not define: same address, its own type. Done
   * after `visible`, because that is when every definition has an address to point at.
   */
  for (const p of parsed) {
    const seen = visible.get(p.module ?? MAIN);
    for (const d of p.externDecls ?? []) {
      if (d.type?.k === 'func' || p.globals.has(d.name)) continue;
      const shared = seen.globals.get(d.name);
      if (shared) p.globals.set(d.name, { addr: shared.addr, type: d.type });
    }
  }

  for (const p of parsed) {
    const seen = visible.get(p.module ?? MAIN);
    const ctx = {
      safepoints,
      directCalls,
      builtinRefs,
      undefinedCalls,
      unit: basename(p.file),
      globals: overlay(seen.globals, p.globals),
      funcs: overlay(seen.funcs, p.funcs),
      builtins: BUILTINS,
    };
    for (const d of p.unit.decls) {
      if (d.n === 'vardecl') {
        if (!d.init) continue;
        const g = ctx.globals.get(d.name);
        if (g) staticInit(mod, g.addr, d.type, d.init, ctx);
        continue;
      }
      if (d.n !== 'func') continue;
      const link = ctx.funcs.get(d.name)?.name ?? d.name;
      try {
        pieces.push(new FunctionEmitter(mod, { ...d, name: link }, ctx).emit());
      } catch (err) {
        // With `collect`, a function that cannot be emitted becomes a stub that throws IF CALLED, so
        // one build reports every gap instead of dying on the first. Porting a 45 000-line program
        // one error per rebuild is not a workflow. Never silent: the list is returned.
        if (!collect) throw err;
        failures.push({ unit: basename(p.file), fn: d.name, message: String(err.message) });
        pieces.push(`function ${jsIdent(link)}(){ throw new Error(${JSON.stringify('unimplemented: ' + d.name)}); }`);
      }
      emitted.push(link);
    }
  }

  finalizeHeap(M);
  const src = '"use strict";\nreturn function(M,F,D){\n' + pieces.join('\n') + '\n' +
    moduleEpilogue(emitted) + '};';

  let factory;
  try {
    factory = new Function(src)();
  } catch (e) {
    throw new CompileError(`emitted JavaScript did not compile: ${e.message}`);
  }
  const F = Object.create(null);
  const rebind = factory(M, F, mod.dv);
  for (const name of emitted) mod.bindFunc(name, F[name]);
  wireRebind(F, mod, emitted, rebind);
  // A builtin whose ADDRESS was taken needs its table slot filled with the runtime's own function,
  // so a call through the pointer lands where a direct call would.
  for (const name of builtinRefs) {
    const impl = M.rt[BUILTINS.get(name)?.impl ?? name];
    if (typeof impl === 'function') mod.bindFunc(name, impl);
  }

  // After emission, because it fills in the program's own `stdin`/`stdout`/`stderr` globals and those
  // addresses do not exist until the units have been linked.
  installStdio(M);
  installPIT(installPorts(M), M);

  /*
   * Sorted by name so a rebuild produces the same list, and carrying the units that call each one --
   * which is what says whether a gap is one file's problem or the program's.
   */
  const undefined_ = [...undefinedCalls].map(([name, units]) => ({ name, units: [...units].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { M, F, src, mod, failures, duplicates, undefined: undefined_, run: makeRunner(M, F, mod) };
}

/** A per-unit view: the unit's own statics shadow the shared names. */
function overlay(shared, own) {
  const m = new Map(shared);
  for (const [k, v] of own) m.set(k, v);
  return m;
}

/** A JS-identifier-safe tag, so src/pacman/driver.c and src/pengo/driver.c do not collide. */
const tagOf = (file) => file.replace(/\.[cC]$/, '').replace(/[^A-Za-z0-9_]/g, '_');

/** The entry point, shared by compile() and compileProgram(). */
function makeRunner(M, F, mod) {
  return function run(argv = ['prog']) {
    M.stdout.length = 0;
    const main = F.main;
    if (!main) throw new CompileError('no main()');
    // argv lives in the image, because main may keep the pointers.
    const ptrs = argv.map(a => mod.intern([...new TextEncoder().encode(a)]));
    const vec = mod.alloc(4 * (ptrs.length + 1), 4);
    ptrs.forEach((p, i) => mod.dv.setInt32(vec + i * 4, p, true));
    mod.dv.setInt32(vec + ptrs.length * 4, 0, true);
    finalizeHeap(M);
    try {
      const code = main.length === 0 ? main() : main(ptrs.length, vec);
      return { code: (code | 0) & 0xff, stdout: M.output() };
    } catch (e) {
      if (e instanceof ExitCalled) return { code: e.code & 0xff, stdout: M.output() };
      throw e;
    }
  };
}


/**
 * Write a constant static initialiser directly into the image.
 * The REAL ctx must be threaded in: an address constant (`int *p = &x;`) can only be folded if the
 * emitter can see the symbol table. Passing empty maps here silently disabled the whole path.
 */
function staticInit(mod, addr, type, init, ctx) {
  const fe = new FunctionEmitter(mod, { name: '__static', type: T.func(T.VOID, []), body: { n: 'block', items: [] } }, ctx);
  fe.initStatic(addr, type, init);
}

export function builtinHeaderResolver(extra = {}) {
  const table = { ...HEADERS, ...extra };
  return (name) => {
    const text = table[name] ?? table[name.replace(/^.*\//, '')];
    return text === undefined ? null : { path: `<${name}>`, text };
  };
}

const numbered = (s) => s.split('\n').map((l, i) => `${String(i + 1).padStart(4)} ${l}`).join('\n');
export { EmitError, Trap };
