// compile.js — the driver: preprocess, parse, place, emit, link, run.
//
// This is the whole pipeline in one file so the seams are visible. Everything it does is tier-0.

import { Preprocessor } from './cpp/cpp.js';
import { cxxToC, CXX_DEFINES, unitLanguage, checkCxxOption } from './cxx/index.js';
import { parse } from './parse/parser.js';
import * as T from './sema/types.js';
import { Module } from './link/module.js';
import { makeMachine, finalizeHeap, ExitCalled, Trap, vaReader } from './runtime/runtime.js';
import { FunctionEmitter, EmitError , jsIdent, flexibleExtra, setPaged, setWindow } from './backend/emit.js';
import { compileAux, AuxError } from './asm/pragma-aux.js';
import { HEADERS } from './env/headers.js';
import { allegroBuiltins } from './env/allegro.js';
import { djBuiltins } from './env/dj.js';
import { installMemMap } from './env/memmap.js';
import { wsockBuiltins } from './env/wsock.js';
import { watcomBuiltins } from './env/watcom.js';
import { go32Builtins } from './env/go32.js';
import { dlBuiltins } from './env/dl.js';
import { svgalibBuiltins } from './env/svgalib.js';
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

  /*
   * gcc's own name for the variadic type, which programs typedef rather than including stdarg.h:
   * `typedef __builtin_va_list va_list;`. On i386 System V the variadic arguments sit contiguously
   * and a va_list is a pointer, which is what src/env/headers.js already says -- so this is that
   * same statement, spelled the way the compiler is expected to spell it.
   */
  __builtin_va_list: 'char *',

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
const FLT = T.scalar('float'), USHRT = T.scalar('unsigned short');
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
  /* What GLQuake's GLX layer adds (gl_vidlinuxglx.c); see src/env/x11.js. */
  XGrabKeyboard: { ret: I, params: [P, U, I, I, I, U] },
  XUngrabKeyboard: { ret: I, params: [P, U] },
  XMoveWindow: { ret: I, params: [P, U, I, I] },
  XRaiseWindow: { ret: I, params: [P, U] },
  XLookupKeysym: { ret: U, params: [P, I] },
  XWarpPointer: { ret: I, params: [P, U, U, I, I, U, U, I, I] },
  XSelectInput: { ret: I, params: [P, U, I] },
  XStoreName: { ret: I, params: [P, U, P] },
  /* ICCCM, which Quake's SUN driver uses and its Linux one does not; see src/env/x11.js. */
  XInternAtom: { ret: U, params: [P, P, I] },
  XChangeProperty: { ret: I, params: [P, U, U, U, I, I, P, I] },
  XSetWMProperties: { ret: V, params: [P, U, P, P, P, I, P, P, P] },
  XSetWMProtocols: { ret: I, params: [P, U, P, I] },
  XConfigureWindow: { ret: I, params: [P, U, U, P] },
  XUndefineCursor: { ret: I, params: [P, U] },
  XAllocWMHints: { ret: P, params: [] },
  XAllocSizeHints: { ret: P, params: [] },
  XPeekEvent: { ret: I, params: [P, P] }, XEventsQueued: { ret: I, params: [P, I] },
  XSetErrorHandler: { ret: P, params: [P] }, XGetErrorText: { ret: I, params: [P, I, P, I] },
  XGetPointerControl: { ret: I, params: [P, P, P, P] }, XChangePointerControl: { ret: I, params: [P, I, I, I, I, I] },
  XInitThreads: { ret: I, params: [] }, XConnectionNumber: { ret: I, params: [P] },
  XBlackPixel: { ret: U, params: [P, I] }, XWhitePixel: { ret: U, params: [P, I] },
  tcgetattr: { ret: I, params: [I, P] }, tcsetattr: { ret: I, params: [I, I, P] },
  getpwuid: { ret: P, params: [U] }, getpwnam: { ret: P, params: [P] }, ctime: { ret: P, params: [P] }, XSetWMNormalHints: { ret: V, params: [P, U, P] },
  XAllocClassHint: { ret: P, params: [] },
  XFree: { ret: I, params: [P] },
  XLoadQueryFont: { ret: P, params: [P, P] },
  XFreeFont: { ret: I, params: [P, P] },
  ScreenOfDisplay: { ret: P, params: [P, I] },
  WidthOfScreen: { ret: I, params: [P] },
  HeightOfScreen: { ret: I, params: [P] },
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
  fileno: { ret: I, params: [P] },
  /*
   * mkstemp and fdopen, which go together: the first makes a temporary and the second reopens its
   * descriptor as a stream. They are one pair because `fileno` above is the identity in this
   * runtime -- a descriptor and a FILE* are the same number -- so fdopen has nothing to convert.
   * Jump 'n Bump's SDL 2 port is what asked: it writes its music to a temporary and hands the path
   * to the mixer.
   */
  mkstemp: { ret: I, params: [P] },
  fdopen: { ret: P, params: [I, P] },
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
  /*
   * MSVC's spellings. A runtime function needs THREE things to exist for a program: a declaration in
   * a header, an implementation in the runtime, and an entry here. This session managed to get each
   * of the three wrong in turn on the same two names before getting all three right, which is worth
   * one line of comment so the next one costs nobody a diagnosis.
   */
  _stricmp: { ret: I, params: [P, P] },
  _strnicmp: { ret: I, params: [P, P, U] },
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
  // Not ISO C, but DJGPP and MSVC both offer it and a DOS program formats numbers with it.
  itoa: { ret: P, params: [I, P, I] },
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
  strtoll: { ret: T.LLONG, params: [P, P, I] }, modf: { ret: D, params: [D, P] }, finite: { ret: I, params: [D] }, isnan: { ret: I, params: [D] }, isinf: { ret: I, params: [D] }, realpath: { ret: P, params: [P, P] }, rewinddir: { ret: V, params: [P] },
  mknod: { ret: I, params: [P, U, I] }, mkfifo: { ret: I, params: [P, U] }, endgrent: { ret: V, params: [] },
  recv: { ret: I, params: [I, P, U, I] }, send: { ret: I, params: [I, P, U, I] }, accept: { ret: I, params: [I, P, P] },
  strtoull: { ret: T.ULLONG, params: [P, P, I] },
  strtoimax: { ret: T.LLONG, params: [P, P, I] }, strtoumax: { ret: T.ULLONG, params: [P, P, I] },
  cosh: { ret: D, params: [D] }, sinh: { ret: D, params: [D] }, tanh: { ret: D, params: [D] }, hypot: { ret: D, params: [D, D] },
  gmtime_r: { ret: P, params: [P, P] }, localtime_r: { ret: P, params: [P, P] }, tzset: { ret: V, params: [] },
  pipe: { ret: I, params: [P] }, fork: { ret: I, params: [] }, dup: { ret: I, params: [I] }, dup2: { ret: I, params: [I, I] },
  symlink: { ret: I, params: [P, P] }, link: { ret: I, params: [P, P] }, chown: { ret: I, params: [P, I, I] }, execvp: { ret: I, params: [P, P] },
  wait: { ret: I, params: [P] }, waitpid: { ret: I, params: [I, P, I] }, utime: { ret: I, params: [P, P] }, uname: { ret: I, params: [P] },
  getgrnam: { ret: P, params: [P] }, getgrgid: { ret: P, params: [U] }, getpwent: { ret: P, params: [] }, setpwent: { ret: V, params: [] }, endpwent: { ret: V, params: [] },
  getsockopt: { ret: I, params: [I, I, I, P, P] }, getpeername: { ret: I, params: [I, P, P] }, getsockname: { ret: I, params: [I, P, P] },
  listen: { ret: I, params: [I, I] }, connect: { ret: I, params: [I, P, U] },
  gethostbyaddr: { ret: P, params: [P, U, I] }, getservbyname: { ret: P, params: [P, P] },
  cfgetispeed: { ret: U, params: [P] }, cfgetospeed: { ret: U, params: [P] }, cfsetispeed: { ret: I, params: [P, U] }, cfsetospeed: { ret: I, params: [P, U] },
  tcflush: { ret: I, params: [I, I] }, tcdrain: { ret: I, params: [I] },
  strtod: { ret: D, params: [P, P] }, strtof: { ret: FLT, params: [P, P] },
  localeconv: { ret: P, params: [] }, setlocale: { ret: P, params: [I, P] },
  mktime: { ret: T.LONG, params: [P] }, difftime: { ret: D, params: [T.LONG, T.LONG] },
  strftime: { ret: U, params: [P, U, P, P] },
  asctime: { ret: P, params: [P] },
  freopen: { ret: P, params: [P, P, P] }, tmpfile: { ret: P, params: [] },
  tmpnam: { ret: P, params: [P] }, system: { ret: I, params: [P] },
  strtoul: { ret: T.ULONG, params: [P, P, I] },
  abs: { ret: I, params: [I] },
  random: { ret: T.LONG, params: [] },
  srandom: { ret: V, params: [U] },
  labs: { ret: T.LONG, params: [T.LONG] },
  strlen: { ret: U, params: [P] }, strnlen: { ret: U, params: [P, U] },
  strcpy: { ret: P, params: [P, P] },
  strncpy: { ret: P, params: [P, P, U] },
  strcat: { ret: P, params: [P, P] },
  strcmp: { ret: I, params: [P, P] },
  strncmp: { ret: I, params: [P, P, U] },
  strchr: { ret: P, params: [P, I] },
  strncat: { ret: P, params: [P, P, U] },
  strcoll: { ret: I, params: [P, P] },
  strdup: { ret: P, params: [P] },
  strpbrk: { ret: P, params: [P, P] },
  strtok: { ret: P, params: [P, P] },
  qsort: { ret: T.VOID, params: [P, U, U, P] },
  bsearch: { ret: P, params: [P, P, U, U, P] },
  memcpy: { ret: P, params: [P, P, U] },
  memmove: { ret: P, params: [P, P, U] },
  memset: { ret: P, params: [P, I, U] },
  memcmp: { ret: I, params: [P, P, U] },
  sqrt: { ret: D, params: [D] }, sin: { ret: D, params: [D] }, cos: { ret: D, params: [D] },
  tan: { ret: D, params: [D] }, atan: { ret: D, params: [D] }, atan2: { ret: D, params: [D, D] },
  asin: { ret: D, params: [D] }, acos: { ret: D, params: [D] },
  round: { ret: D, params: [D] }, trunc: { ret: D, params: [D] },
  lround: { ret: T.LONG, params: [D] },

  exp: { ret: D, params: [D] }, log: { ret: D, params: [D] }, log10: { ret: D, params: [D] },
  pow: { ret: D, params: [D, D] }, floor: { ret: D, params: [D] }, ceil: { ret: D, params: [D] },
  fabs: { ret: D, params: [D] }, fmod: { ret: D, params: [D, D] },
  /*
   * The float family, declared as taking and returning FLOAT. That is not cosmetic: PRISM rounds a
   * float store with Math.fround, and a builtin declared in double would keep the extra precision
   * through the call -- which is exactly the kind of divergence csmith exists to find.
   */
  sqrtf: { ret: FLT, params: [FLT] }, sinf: { ret: FLT, params: [FLT] },
  log2f: { ret: FLT, params: [FLT] }, log2: { ret: D, params: [D] },
  cosf: { ret: FLT, params: [FLT] }, tanf: { ret: FLT, params: [FLT] },
  atanf: { ret: FLT, params: [FLT] }, atan2f: { ret: FLT, params: [FLT, FLT] },
  roundf: { ret: FLT, params: [FLT] }, truncf: { ret: FLT, params: [FLT] },
  expf: { ret: FLT, params: [FLT] }, logf: { ret: FLT, params: [FLT] },
  log10f: { ret: FLT, params: [FLT] }, powf: { ret: FLT, params: [FLT, FLT] },
  floorf: { ret: FLT, params: [FLT] }, ceilf: { ret: FLT, params: [FLT] },
  lrintf: { ret: I, params: [FLT] }, lrint: { ret: I, params: [D] },
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
  // gcc's own pair. Same contract, and the same buffer: a program that uses them never includes
  // <setjmp.h> and declares the buffer itself, usually as `void *buf[5]`.
  __builtin_setjmp: { ret: I, params: [P], setjmp: true },
  __builtin_longjmp: { ret: V, params: [P, I], impl: 'longjmp' },
  __prism_setjmp: { ret: I, params: [P, P, I] },
  __prism_va_start: { ret: P, params: [], vaStart: true },
  __prism_va_next: { ret: P, params: [P, U] },
  clock: { ret: T.ULONG, params: [] },
  uclock: { ret: T.ULLONG, params: [] },
  time: { ret: T.LONG, params: [P] },
  strrchr: { ret: P, params: [P, I] },
  strstr: { ret: P, params: [P, P] },
  memchr: { ret: P, params: [P, I, U] },

  /*
   * The rest of the __builtin_ aliases the torture suite reaches for, plus the handful that are
   * FUNCTIONS rather than aliases. Ranked by how many programs each unblocks, which is the only
   * reason to add any of them -- the surface is unbounded and the corpus is not.
   */
  __builtin_strncpy: { ret: P, params: [P, P, U], impl: 'strncpy' },
  __builtin_strncmp: { ret: I, params: [P, P, U], impl: 'strncmp' },
  __builtin_strcat: { ret: P, params: [P, P], impl: 'strcat' },
  __builtin_strncat: { ret: P, params: [P, P, U], impl: 'strncat' },
  __builtin_strchr: { ret: P, params: [P, I], impl: 'strchr' },
  __builtin_strrchr: { ret: P, params: [P, I], impl: 'strrchr' },
  __builtin_strstr: { ret: P, params: [P, P], impl: 'strstr' },
  __builtin_strdup: { ret: P, params: [P], impl: 'strdup' },
  __builtin_memchr: { ret: P, params: [P, I, U], impl: 'memchr' },
  __builtin_sprintf: { ret: I, params: [P, P], variadic: true, impl: 'sprintf' },
  __builtin_snprintf: { ret: I, params: [P, U, P], variadic: true, impl: 'snprintf' },
  __builtin_fprintf: { ret: I, params: [P, P], variadic: true, impl: 'fprintf' },
  __builtin_calloc: { ret: P, params: [U, U], impl: 'calloc' },
  __builtin_realloc: { ret: P, params: [P, U], impl: 'realloc' },
  __builtin_labs: { ret: T.LONG, params: [T.LONG], impl: 'labs' },
  __builtin_trap: { ret: V, params: [], impl: 'abort' },
  /* mempcpy is memcpy that returns the END of the copy -- a GNU extension, not an alias. */
  mempcpy: { ret: P, params: [P, P, U], impl: 'mempcpy' },
  __builtin_mempcpy: { ret: P, params: [P, P, U], impl: 'mempcpy' },
  __builtin_stpcpy: { ret: P, params: [P, P], impl: 'stpcpy' },
  stpcpy: { ret: P, params: [P, P], impl: 'stpcpy' },

  /* The bit-counting family. Every one of these is defined only for a NON-ZERO argument except
   * popcount and parity, and gcc's own tests never pass zero -- so the runtime answers 0 there
   * rather than inventing a value. */
  __builtin_ffs: { ret: I, params: [I], impl: '__builtin_ffs' },
  __builtin_ffsl: { ret: I, params: [T.LONG], impl: '__builtin_ffs' },
  __builtin_clz: { ret: I, params: [U], impl: '__builtin_clz' },
  __builtin_clzl: { ret: I, params: [T.ULONG], impl: '__builtin_clz' },
  __builtin_ctz: { ret: I, params: [U], impl: '__builtin_ctz' },
  __builtin_ctzl: { ret: I, params: [T.ULONG], impl: '__builtin_ctz' },
  __builtin_popcount: { ret: I, params: [U], impl: '__builtin_popcount' },
  __builtin_popcountl: { ret: I, params: [T.ULONG], impl: '__builtin_popcount' },
  __builtin_parity: { ret: I, params: [U], impl: '__builtin_parity' },
  __builtin_bswap16: { ret: USHRT, params: [USHRT], impl: '__builtin_bswap16' },
  __builtin_bswap32: { ret: U, params: [U], impl: '__builtin_bswap32' },
  __builtin_bswap64: { ret: T.ULLONG, params: [T.ULLONG], impl: '__builtin_bswap64' },

  /* Floating-point classification, which is arithmetic rather than a library call. */
  __builtin_signbit: { ret: I, params: [D], impl: '__builtin_signbit' },
  __builtin_signbitf: { ret: I, params: [FLT], impl: '__builtin_signbit' },
  __builtin_isinf: { ret: I, params: [D], impl: '__builtin_isinf' },
  __builtin_isinff: { ret: I, params: [FLT], impl: '__builtin_isinf' },
  __builtin_isnan: { ret: I, params: [D], impl: '__builtin_isnan' },
  __builtin_isnanf: { ret: I, params: [FLT], impl: '__builtin_isnan' },
  __builtin_copysign: { ret: D, params: [D, D], impl: 'copysign' },
  __builtin_copysignf: { ret: FLT, params: [FLT, FLT], impl: 'copysignf' },
  __builtin_fabs: { ret: D, params: [D], impl: 'fabs' },
  __builtin_fabsf: { ret: FLT, params: [FLT], impl: 'fabsf' },
  __builtin_sqrt: { ret: D, params: [D], impl: 'sqrt' },
  __builtin_sqrtf: { ret: FLT, params: [FLT], impl: 'sqrtf' },
  copysign: { ret: D, params: [D, D] },
  copysignf: { ret: FLT, params: [FLT, FLT] },
  signbit: { ret: I, params: [D], impl: '__builtin_signbit' },
  /* The host's millisecond clock; see src/runtime/runtime.js. */
  prism_now_ms: { ret: D, params: [] },

  /* The complex family: the emitter builds these, because their argument and result are complex
     and only it knows how a complex value travels. */
  __builtin_conj: { ret: I, cx: 'conj' }, __builtin_conjf: { ret: I, cx: 'conj' },
  __builtin_conjl: { ret: I, cx: 'conj' },
  __builtin_creal: { ret: D, cx: 'real' }, __builtin_crealf: { ret: FLT, cx: 'real' },
  __builtin_cimag: { ret: D, cx: 'imag' }, __builtin_cimagf: { ret: FLT, cx: 'imag' },

  /* Answered entirely from the argument's TYPE, and its value is never computed -- gcc does not
     evaluate it either. */
  __builtin_classify_type: { ret: I, classify: true },

  /* Type-generic, so the emitter builds the call. Named rather than numbered: `overflow: 0`
     for add is FALSY, and `rt?.overflow` then skipped the whole path. */
  __builtin_add_overflow: { ret: I, overflow: 'add' },
  __builtin_sub_overflow: { ret: I, overflow: 'sub' },
  __builtin_mul_overflow: { ret: I, overflow: 'mul' },
  __builtin_sadd_overflow: { ret: I, overflow: 'add' },
  __builtin_ssub_overflow: { ret: I, overflow: 'sub' },
  __builtin_smul_overflow: { ret: I, overflow: 'mul' },
  __builtin_saddl_overflow: { ret: I, overflow: 'add' },
  __builtin_ssubl_overflow: { ret: I, overflow: 'sub' },
  __builtin_smull_overflow: { ret: I, overflow: 'mul' },
  __builtin_saddll_overflow: { ret: I, overflow: 'add' },
  __builtin_ssubll_overflow: { ret: I, overflow: 'sub' },
  __builtin_smulll_overflow: { ret: I, overflow: 'mul' },
  __builtin_uadd_overflow: { ret: I, overflow: 'add' },
  __builtin_usub_overflow: { ret: I, overflow: 'sub' },
  __builtin_umul_overflow: { ret: I, overflow: 'mul' },
  __builtin_uaddl_overflow: { ret: I, overflow: 'add' },
  __builtin_usubl_overflow: { ret: I, overflow: 'sub' },
  __builtin_umull_overflow: { ret: I, overflow: 'mul' },
  __builtin_uaddll_overflow: { ret: I, overflow: 'add' },
  __builtin_usubll_overflow: { ret: I, overflow: 'sub' },
  __builtin_umulll_overflow: { ret: I, overflow: 'mul' },
}));

/*
 * Allegro, SEAL and the DJGPP memory helpers: the libraries MAME 0.1's OWN src/msdos/msdos.c links
 * against. Kept next to their implementation in src/env/allegro.js.
 */
/*
 * REGISTERED THROUGH ONE DOOR, so an entry cannot arrive incomplete without saying so.
 *
 * A builtin's `ret` is what the emitter gives a call's result (see #call), and an entry that omits
 * it hands back a value with NO TYPE. Nothing notices while the result is ignored; the moment a
 * program puts it in an expression, decay() is asked for the kind of `undefined` and the CALLER
 * becomes unemittable -- pointing at the caller, which is innocent.
 *
 * That is not hypothetical. src/sema/types.js exported no SHORT, USHORT or UCHAR, while sdl2.js and
 * allegro.js were already writing T.SHORT and T.USHORT in their tables: a missing export reads as
 * `undefined`, so nine entries recorded no return type at all and stayed that way until
 * `SDL_JoystickGetAxis(joys[3], 0) < -3200` in corpus/jumpnbump-sdl12 tripped over one. Refusing
 * here turns a silent wrong answer into a loud one at startup, which is the whole trade.
 */
function registerBuiltins(env, table) {
  for (const [name, entry] of Object.entries(table)) {
    if (!entry || entry.ret === undefined) {
      // A plain Error, not CompileError: this runs at module scope, above that class's declaration,
      // and a guard that throws a ReferenceError on the one day it fires is worse than none.
      throw new Error(`builtin '${name}' from ${env} has no return type. A call to it would ` +
        `produce a value with no type, and the first expression that used the result would make ` +
        `its CALLER unemittable. Give the entry a ret — a missing T.<NAME> reads as undefined.`);
    }
    BUILTINS.set(name, entry);
  }
}

/*
 * Allegro, SEAL and the DJGPP memory helpers: the libraries MAME 0.1's OWN src/msdos/msdos.c links
 * against. Kept next to their implementation in src/env/allegro.js.
 */
registerBuiltins('allegro', allegroBuiltins(T));
// dj, Jump n Bump's DOS sound library; see src/env/dj.js.
registerBuiltins('dj', djBuiltins(T));
// The Watcom/DOS4GW runtime Heretic and Hexen call; see src/env/watcom.js.
registerBuiltins('watcom', watcomBuiltins(T));
/* The socket thread's six primitives; see src/env/wsock.js. */
registerBuiltins('wsock', wsockBuiltins(T));
// DJGPP's DPMI floor, which Quake's dos_v2.c builds all of dosisms.h on; see src/env/go32.js.
registerBuiltins('go32', go32Builtins(T));
registerBuiltins('dl', dlBuiltins(T));
registerBuiltins('svgalib', svgalibBuiltins(T));
/*
 * SDL2's builtins are NOT registered here. They travel on the `sdl2` environment instead
 * (src/env/registry.js), for the reason its headers do: two versions of one library cannot share a
 * table. Registered globally, they answered for an SDL 1.2 program too -- corpus/jumpnbump-sdl12
 * resolved SDL_Init, SDL_PollEvent, SDL_CreateRGBSurface, SDL_MapRGB and SDL_JoystickGetAxis
 * against SDL2's implementations without naming that environment at all. SDL_PollEvent is the one
 * that would have hurt: it fills an SDL2 event into a buffer the guest reads with 1.2 offsets,
 * where `type` is a Uint8 rather than a Uint32 and the keysym sits elsewhere. That does not crash,
 * it invents keystrokes.
 */

/**
 * The builtin table an environment's own entries see, layered over the global one.
 *
 * Returns BUILTINS itself when nothing is added, so every build that names no such environment
 * pays nothing and behaves exactly as before.
 */
function withEnvBuiltins(extra) {
  if (!extra || (extra instanceof Map ? extra.size === 0 : Object.keys(extra).length === 0)) {
    return BUILTINS;
  }
  const out = new Map(BUILTINS);
  for (const [k, v] of (extra instanceof Map ? extra : Object.entries(extra))) out.set(k, v);
  return out;
}

export class CompileError extends Error {}

/**
 * Fill the function-table slot of a library function whose ADDRESS a program took, so a call through
 * the pointer lands where a direct call would.
 *
 * A VARIADIC builtin needs an adapter. The runtime takes its extras as one array -- `printf(fmt,
 * [args])` -- because that is the convention the emitter uses at a direct call, and an indirect call
 * site has no idea it is calling a variadic function, so it passes them flat. The adapter puts them
 * back together. c-testsuite's 00189 exists for exactly this: it calls fprintf ONLY through a
 * pointer, so nothing else would notice.
 */
/**
 * Bind the function-table slots of library functions whose address was taken but whose
 * implementation did not exist yet at link time. An ENVIRONMENT's functions are installed after the
 * program is compiled (src/target.js buildEnv, web/worker.js), so a slot for one of them stays empty
 * -- and Quake II's qgl_linux.c takes the address of all 336 GL 1.1 entry points before calling any.
 * Call once the environments are in place; a slot already bound, or a name nothing implements, is
 * left alone (an unimplemented one still throws when called through).
 */
export function bindLateBuiltins(program) {
  let n = 0;
  for (const [name, f] of program.mod.funcs) {
    // Inside a module an external name carries the module's prefix (`ref_gl$glGetString`); the
    // library function is the unprefixed one.
    const base = name.slice(name.lastIndexOf('$') + 1);
    const impl = program.M.rt[base];
    if (f.fn || typeof impl !== 'function') continue;
    const b = BUILTINS.get(base);
    if (b?.variadic) {
      const fixed = b.params?.length ?? 0;
      program.mod.bindFunc(name, (...args) => impl(...args.slice(0, fixed), vaReader(program.M, args[fixed])));
    } else program.mod.bindFunc(name, impl);
    n++;
  }
  return n;
}

function bindBuiltinAddr(mod, M, name) {
  const b = BUILTINS.get(name);
  const impl = M.rt[b?.impl ?? name];
  if (typeof impl !== 'function') return;
  if (!b?.variadic) { mod.bindFunc(name, impl); return; }
  /*
   * Through a POINTER the tail does not arrive flat: an indirect call packs it into the caller-owned
   * va buffer and passes its address, because that is what every variadic callee here expects. So
   * the adapter reads the buffer -- `vaReader` is the same thing vfprintf uses -- and hands the
   * runtime the list it wants.
   */
  const fixed = b.params?.length ?? 0;
  mod.bindFunc(name, (...args) => impl(...args.slice(0, fixed), vaReader(M, args[fixed])));
}

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

/**
 * The tokens the C parser reads for one unit. A C++ unit (by its file name as gcc decides, or as
 * the `cxx` option says -- see src/cxx/index.js) is preprocessed with __cplusplus defined, lowered
 * to C by src/cxx, and that C is tokenised.
 */
function unitTokens(pp, source, file, cxx) {
  if (unitLanguage(file, cxx) !== 'c++') return pp.run(source, file);
  for (const [k, v] of Object.entries(CXX_DEFINES)) pp.defineText(k, v);
  const c = cxxToC(pp.run(source, file), { file });
  return new Preprocessor({}).run(c, file);
}

export function compile(source, { file = 'main.c', defines = {}, resolve = null, memory, shared = false, safepoints = false, directCalls = true, pack = null, c89 = false, model = 'i386', signedChar, enums, longDouble, ppSizeof = null, extraBuiltins = null, cxx } = {}) {
  checkCxxOption(cxx);
  const pp = new Preprocessor({
    ppSizeof,
    defines: mergeDefines(mergeDefines(TARGET_DEFINES, { ...modelDefines(model, signedChar), ...longDoubleDefines(longDouble) }), defines),
    resolve: resolve ?? builtinHeaderResolver(),
  });
  const tokens = unitTokens(pp, source, file, cxx);
  // `enums` shapes types, and types are the parser's: the emitter never builds an enum of its own.
  const { unit, scope } = parse(tokens, { file, pack, c89, model, signedChar, enums, longDouble });

  const mod = new Module({ ...(memory ? { memory } : {}), shared, model });
  const M = makeMachine(mod);
  // A text console in guest memory from the start, so stdout has somewhere real to land. The host
  // replaces `readChar` with a blocking one; headless, stdin is simply at EOF.
  installConsole(M);

  // Pass 1: give every file-scope name an address BEFORE any body is emitted, because a body may
  // reference a global or take a function's address before its definition appears.
  const globals = new Map();
  const funcs = new Map();
  // `__attribute__((alias("a")))` names an object that already exists, and the object it names may
  // be declared further down the file -- so the aliases are resolved once every name has an address.
  const aliases = [];
  for (const d of unit.decls) {
    if (d.n === 'vardecl') {
      if (d.alias) { aliases.push(d); continue; }
      if (d.type.k === 'func') { funcs.set(d.name, mod.defineFunc(d.name, d.type)); continue; }
      if (d.storage === 'extern' && !d.init) continue;
      // A definition that fills a flexible array member is LARGER than its type says; the extra
      // storage has to be reserved here, before the next global takes the address after it.
      const sym = mod.defineGlobal(d.name, d.type, d.type.size + flexibleExtra(d.type, d.init), { far: !!d.far });
      globals.set(d.name, { addr: sym.addr, type: d.type });
    } else if (d.n === 'func') {
      const f0 = mod.defineFunc(d.name, d.type);
      f0.defined = true;                      // a body, not just a prototype
      funcs.set(d.name, f0);
    }
  }

  for (const d of aliases) {
    if (d.type.k === 'func') {
      const target = funcs.get(d.alias);
      if (!target) throw new CompileError(`__attribute__((alias("${d.alias}"))) names no function`);
      funcs.set(d.name, target);
    } else {
      const target = globals.get(d.alias);
      if (!target) throw new CompileError(`__attribute__((alias("${d.alias}"))) names no object`);
      globals.set(d.name, { addr: target.addr, type: d.type });
    }
  }

  // Pass 2: emit. Static initialisers are written straight into the image where they are constant.
  const ctx = { globals, funcs, builtins: withEnvBuiltins(extraBuiltins), safepoints, directCalls, model, signedChar };
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
  for (const name of ctx.builtinRefs ?? []) bindBuiltinAddr(mod, M, name);

  installStdio(M);
  installPIT(installPorts(M), M);

  return { M, F, src, mod, run: makeRunner(M, F, mod, model) };
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

/** The function declarations inside a body, at any depth. Types are not walked: they are not statements. */
function blockFuncDecls(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const x of node) blockFuncDecls(x, out, seen); return out; }
  if (node.n === 'vardecl' && node.type?.k === 'func') out.push(node);
  for (const [k, v] of Object.entries(node)) if (k !== 'type' && v && typeof v === 'object') blockFuncDecls(v, out, seen);
  return out;
}

/**
 * Leaving the program, as exit() and a return from main do (C99 7.20.4.3 and 5.1.2.2.3): the atexit
 * handlers in the REVERSE order they were registered, each once, then every stream flushed. It used
 * to do neither -- atexit recorded its handlers and the comment beside it said "rt.exit runs the
 * list", which nothing did. A handler that calls exit itself ends the list with that status; the
 * standard leaves it undefined, and stopping is the answer that cannot loop.
 */
function leave(M, status) {
  const list = M.atexitList ?? [];
  while (list.length) {
    const fn = list.pop();
    try { M.icall(fn, []); } catch (e) {
      if (e instanceof ExitCalled) { status = e.code; if (e.quick) return status; list.length = 0; break; }
      throw e;
    }
  }
  M.flushAll?.();
  return status;
}

/**
 * `paged` is a PLATFORM property, not a per-game favour: on DOS the low megabyte has devices in it.
 * It is a module-level flag inside the emitter (26 call sites would otherwise each need an extra
 * argument), so it is set here and cleared in a finally -- a compilation that throws must not leave
 * it on for the next one, and a gate compiles hundreds in a row.
 */
export function compileProgram(units, opts = {}) {
  setPaged(!!opts.paged);
  setWindow(!!opts.window);
  try { return compileProgramInner(units, opts); }
  finally { setPaged(false); setWindow(false); }
}

function compileProgramInner(units, { defines = {}, resolve = null, memory, includes = {}, collect = false, shared = false, safepoints = false, directCalls = true, pack = null, c89 = false, model = 'i386', signedChar, argOrder, enums, longDouble, ppSizeof = null, lenientPaste = false, paged = false, window = false, exports: moduleExports = {}, extraBuiltins = null, externData = [], cxx } = {}) {
  checkCxxOption(cxx);
  // moduleExports: module name -> the names it makes visible to the main module. See `visible` below.
  const exportsOf = new Map(Object.entries(moduleExports).map(([k, v]) => [k, new Set(v)]));
  // The builtins this build sees: the global table, plus whatever its environments add. Computed
  // once, because it is read per unit.
  const envTable = withEnvBuiltins(extraBuiltins);
  const failures = [];
  const mod = new Module({ ...(memory ? { memory } : {}), shared, model });
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
      ppSizeof,
      lenientPaste,
      defines: mergeDefines(mergeDefines(mergeDefines(TARGET_DEFINES, { ...modelDefines(model, signedChar), ...longDoubleDefines(longDouble) }),
        defines), u.defines ?? {}),
      resolve: resolver,
    });
    const tokens = unitTokens(pp, u.source, u.file, cxx);
    const { unit, scope } = parse(tokens, { file: u.file, pack, c89, model, signedChar, enums, longDouble });
    // The module is part of a static's identity: ET builds game/bg_sscript.c into cgame AND qagame,
    // and one tag per path let cgame's calls reach qagame's copy (and its syscall table).
    parsed.push({ ...u, unit, scope, tag: u.module ? `${u.module}_${tagOf(u.file)}` : tagOf(u.file) });
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
        if (d.alias) { (p.aliasDecls ??= []).push(d); continue; }
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
        const sym = mod.defineGlobal(link, d.type, d.type.size + flexibleExtra(d.type, d.init), { far: !!d.far });
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
    /*
     * A function DECLARED ONLY INSIDE A BLOCK still names the external function (C89 3.1.2.2): its
     * linkage is the file's even though its scope is not. Catacomb 3-D's jabhack declares
     * `extern int far CheckIs386(void);` in its body and nowhere else -- the definition is in
     * JABHACK.ASM -- so the name reached no function table and the call was refused as undeclared.
     */
    for (const d of p.unit.decls) {
      if (d.n !== 'func') continue;
      for (const b of blockFuncDecls(d.body)) {
        if (b.storage === 'static' || p.funcs.has(b.name) || home.funcs.has(b.name)) continue;
        home.funcs.set(b.name, mod.defineFunc(qualify(b.name), b.type));
      }
    }
  }

  // Pass 2: emit, with each unit's statics shadowing the shared names.
  // Shared across units: a builtin whose address is taken in ONE unit still needs binding once.
  const builtinRefs = new Set();
  // name -> the units that CALL it, for every name declared here and defined nowhere.
  const undefinedCalls = new Map();

  /*
   * `#pragma aux` routines: an assembly body for a name the C declares and never defines.
   *
   * Collected across every unit, because the pragma lives in a header (Heretic's DOOMDEF.H) and is
   * therefore parsed once per unit that includes it. Resolved BEFORE pass 2 so that a call reaches
   * the compiled routine directly, exactly as a call to any other defined function does.
   */
  const pieces = [], emitted = [];
  const auxPieces = [];
  const auxSeen = new Set();
  for (const p of parsed) {
    for (const aux of p.unit.aux ?? []) {
      if (auxSeen.has(aux.name)) continue;
      const home = perModule.get(p.module ?? MAIN);
      const f = home.funcs.get(aux.name) ?? perModule.get(MAIN).funcs.get(aux.name);
      // Only where the C defines nothing. A program that ships both a pragma and a C body has
      // chosen the C body, and this must not overrule it.
      if (!f || f.defined) continue;
      try {
        auxPieces.push(compileAux(aux, jsIdent(f.name)));
        f.defined = true;
        auxSeen.add(aux.name);
        emitted.push(f.name);
      } catch (e) {
        if (!(e instanceof AuxError)) throw e;
        // Refused by name, never guessed at: a wrong instruction here is a wrong number in a
        // renderer. It stays undefined, and the undefined-symbol report says so.
        failures.push({ unit: basename(p.file), fn: aux.name, message: String(e.message) });
      }
    }
  }

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
  /*
   * DATA OTHER OBJECT FILES DEFINE: an assembly module's _DATA, a MakeOBJ'd resource, an assembly
   * module's code segment. Each is ONE block, placed near (DGROUP) or far like the object it stands
   * for, with its public names at their offsets -- one block and not one allocation per name,
   * because the assembly walks its own tables across its labels. Placed before the C's extern
   * declarations are resolved, so `extern int px;` finds the assembly's px rather than getting
   * zeroed storage of its own.
   */
  const externPlaced = new Map();       // block name -> linear base
  const externNames = new Set();
  for (const b of externData) {
    const base = b.far ? mod.allocFar(b.size, b.align ?? 16) : mod.alloc(b.size, b.align ?? 2);
    if (b.bytes) mod.u8.set(b.bytes, base);
    externPlaced.set(b.name, base);
    for (const pub of b.publics ?? []) {
      if (mod.symbols.has(pub.name)) throw new CompileError(`${b.name}: '${pub.name}' is also defined in C`);
      mod.symbols.set(pub.name, { name: pub.name, addr: base + pub.offset, size: 0, type: null, kind: 'var' });
      externNames.add(pub.name);
    }
  }
  const undefinedData = new Map();      // extern variables nobody defines
  for (const p of parsed) {
    const seen = visible.get(p.module ?? MAIN);
    /*
     * An ALIAS is a second name for an object or function that already exists -- one address, two
     * spellings. Resolved here, with everything else that borrows an address, and against the unit's
     * own names first: `static int a; extern int b __attribute__((alias("a")));` aliases the static.
     */
    for (const d of p.aliasDecls ?? []) {
      if (d.type?.k === 'func') {
        const target = p.funcs.get(d.alias) ?? seen.funcs.get(d.alias);
        if (target) p.funcs.set(d.name, target);
        continue;
      }
      const target = p.globals.get(d.alias) ?? seen.globals.get(d.alias);
      if (target) p.globals.set(d.name, { addr: target.addr, type: d.type });
    }
    for (const d of p.externDecls ?? []) {
      if (d.type?.k === 'func' || p.globals.has(d.name)) continue;
      const shared = seen.globals.get(d.name);
      if (shared) { p.globals.set(d.name, { addr: shared.addr, type: d.type }); continue; }
      /*
       * Declared and never defined -- and it STILL has an address.
       *
       * That is not a courtesy, it is what the name means: `extern const GUID GUID_XAxis;` is a
       * promise that some other object file holds it, and a program may legally take its address in
       * a static initialiser without ever reading it. WinQuake does exactly that -- its DirectInput
       * data-format table is thirteen rows of `{ &GUID_XAxis, FIELD_OFFSET(...), ... }` -- and the
       * definitions live in dxguid.lib, which is a binary and is not here.
       *
       * So it gets zeroed storage, which is what an unresolved data symbol reads as, and its name
       * goes into the report beside the undefined FUNCTIONS, which have worked this way all along.
       * Refusing instead would be stricter than a linker on a program that never dereferences it.
       */
      // The BARE name, deliberately: two units declaring the same missing symbol must get
      // the same object, which is what a linker gives them. defineGlobal returns the
      // existing entry when the name is already taken, so the sharing is free.
      const sym = mod.defineGlobal(d.name, d.type);
      p.globals.set(d.name, { addr: sym.addr, type: d.type });
      if (externNames.has(d.name)) continue;
      if (!undefinedData.has(d.name)) undefinedData.set(d.name, new Set());
      undefinedData.get(d.name).add(basename(p.file));
    }
  }

  for (const p of parsed) {
    const seen = visible.get(p.module ?? MAIN);
    const ctx = {
      safepoints,
      directCalls,
      model,              // this ctx carried neither, so every target's emitter typed for i386
      signedChar,
      argOrder,
      builtinRefs,
      undefinedCalls,
      unit: basename(p.file),
      globals: overlay(seen.globals, p.globals),
      funcs: overlay(seen.funcs, p.funcs),
      builtins: envTable,
    };
    /*
     * A unit's own declaration of a name wins over ANOTHER KIND of thing by that name elsewhere.
     * Keen Dreams' lzhuf.c has `static void update(int c)` and id_rf.c a global
     * `byte update[2][UPDATESIZE]` that lzhuf.c never declares; the program-wide globals map made
     * `update(c)` in DecodeChar a call through the array.
     */
    for (const name of p.funcs.keys()) if (!p.globals.has(name)) ctx.globals.delete(name);
    for (const name of p.globals.keys()) if (!p.funcs.has(name)) ctx.funcs.delete(name);
    /*
     * A FUNCTION is typed, in each unit, by THAT unit's declaration of it -- as an extern object
     * already is (see externDecls above). The function's record is one for the whole program and
     * carried the type of whichever unit declared it last: Tcl's tclUtf.c sees
     * `struct tm *TclpGetDate()` through tclInt.h without ever including <time.h>, so its struct tm
     * is incomplete, and that type reached tclDate.c, which writes `TclpGetDate(...)->tm_isdst` with
     * the members in plain sight. A view of the record with this unit's type, sharing everything else.
     */
    for (const d of p.unit.decls) {
      if (!(d.n === 'func' || (d.n === 'vardecl' && d.type.k === 'func'))) continue;
      const f = ctx.funcs.get(d.name);
      if (!f || f.type === d.type) continue;
      const base = Object.getPrototypeOf(f) === Object.prototype ? f : Object.getPrototypeOf(f);
      ctx.funcs.set(d.name, Object.assign(Object.create(base), { type: d.type }));
    }
    for (const d of p.unit.decls) {
      if (d.n === 'vardecl') {
        if (!d.init) continue;
        const g = ctx.globals.get(d.name);
        /*
         * Name the object and the unit. A refusal here used to say only what SHAPE it could not
         * emit -- "a static union <anon>" -- which is the one thing you cannot grep for, and finding
         * the declaration meant bisecting a 135-unit build by hand.
         */
        if (g) {
          try { staticInit(mod, g.addr, d.type, d.init, ctx); }
          catch (err) {
            if (!(err instanceof EmitError)) throw err;
            throw new EmitError(`${basename(p.file)}: initialising '${d.name}': ${err.message}`);
          }
        }
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

  pieces.push(...auxPieces);

  finalizeHeap(M);
  /*
   * The module takes two extra names ONLY when the platform is paged, so a target that is not pays
   * nothing and -- more usefully -- emits a byte-for-byte identical program. That is checked rather
   * than trusted: MAME, Quake II/win32 and Jump 'n Bump all hash the same with this code present.
   */
  // The device window's accessors (emit.js setWindow): plain DataView calls outside A0000h-AFFFFh,
  // M.win inside it -- looked up at each access, since the device is installed after this runs.
  const WIN = window ? [
    'const _iw=(a)=>a>=655360&&a<720896&&M.win;',
    'const _r8u=(a)=>_iw(a)?M.win.r8(a):D.getUint8(a);',
    'const _r8s=(a)=>_iw(a)?(M.win.r8(a)<<24>>24):D.getInt8(a);',
    'const _r16u=(a)=>_iw(a)?(M.win.r8(a)|(M.win.r8(a+1)<<8)):D.getUint16(a,1);',
    'const _r16s=(a)=>_iw(a)?((M.win.r8(a)|(M.win.r8(a+1)<<8))<<16>>16):D.getInt16(a,1);',
    'const _r32=(a)=>_iw(a)?(M.win.r8(a)|(M.win.r8(a+1)<<8)|(M.win.r8(a+2)<<16)|(M.win.r8(a+3)<<24)):D.getInt32(a,1);',
    'const _w8=(a,v)=>{if(_iw(a))M.win.w8(a,v&255);else D.setInt8(a,v);};',
    'const _w16=(a,v)=>{if(_iw(a)){M.win.w8(a,v&255);M.win.w8(a+1,(v>>>8)&255);}else D.setUint16(a,v&65535,1);};',
    'const _w32=(a,v)=>{if(_iw(a)){for(let k=0;k<4;k++)M.win.w8(a+k,(v>>>(8*k))&255);}else D.setInt32(a,v,1);};',
  ].join('\n') + '\n' : '';
  const src = `"use strict";\nreturn function(M,F,D${paged ? ',xr,xw' : ''}){\n` + WIN + pieces.join('\n') + '\n' +
    moduleEpilogue(emitted) + '};';

  let factory;
  try {
    factory = new Function(src)();
  } catch (e) {
    /*
     * Attach the source, as the single-unit path already does. A whole-program build that emits
     * JavaScript the engine will not parse is a defect in the EMITTER, and "Unexpected token 'case'"
     * with nothing to look at is a guessing game -- it cost several wrong minimal repros before I
     * added this line.
     */
    const err = new CompileError(`emitted JavaScript did not compile: ${e.message}`);
    err.src = src;
    throw err;
  }
  const F = Object.create(null);
  /*
   * THE MAP BELONGS TO THE IMAGE, which is why it is built here rather than by the environment: the
   * environment is installed after this returns, and the emitted code needs its two translations at
   * the moment the module is instantiated. Every page starts as itself, so a paged program with no
   * device claiming anything behaves exactly like an unpaged one -- it merely pays for the lookup.
   * Devices claim their ranges later, through M.memmap.
   */
  const memmap = paged ? installMemMap(M) : null;
  const rebind = paged ? factory(M, F, mod.dv, memmap.xr, memmap.xw) : factory(M, F, mod.dv);
  for (const name of emitted) mod.bindFunc(name, F[name]);
  wireRebind(F, mod, emitted, rebind);
  // A builtin whose ADDRESS was taken needs its table slot filled with the runtime's own function,
  // so a call through the pointer lands where a direct call would.
  for (const name of builtinRefs) bindBuiltinAddr(mod, M, name);

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
  /* Undefined DATA, reported the same way and separately: a missing variable and a missing
     function fail differently -- one reads as zero, the other throws when called. */
  const undefinedVars = [...undefinedData].map(([name, units]) => ({ name, units: [...units].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // The declared type of every function the main module knows, defined or not: what a binding for
  // a function another object file defines needs, to lay its arguments out as the C pushes them.
  const funcTypes = new Map([...perModule.get(MAIN).funcs].map(([n, f]) => [n, f.type]));
  // Where each of the main module's globals lives: what an assembly file's `extern` names resolve to.
  const globalAddrs = Object.fromEntries([...perModule.get(MAIN).globals].map(([n, g]) => [n, g.addr]));
  return { M, F, src, mod, failures, duplicates, undefined: undefined_, undefinedVars,
           externPlaced, funcTypes, globalAddrs, run: makeRunner(M, F, mod, model) };
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
function makeRunner(M, F, mod, model = 'i386') {
  return function run(argv = ['prog']) {
    /*
     * A 16-BIT MODEL RUNS, since the pieces that execute a whole program are sized by it: argv here,
     * the variadic buffer in emit.js (int-sized slots, and the printf family reading each conversion
     * at its own width), and the runtime's stores of pointers and ints through M.loadPtr/storePtr and
     * loadInt/storeInt. What still assumes i386 refuses by name where it lives -- struct stat, tm and
     * fd_set in stdio, mktime/strftime, printf's %p -- and tools/gate-dos16-run.mjs holds whole
     * programs to Borland C++ 2.0 running the same source.
     */
    if (!['i386', 'dos16', 'dos16m', 'dos16l'].includes(model)) {
      throw new CompileError(`compiled for '${model}', which run() does not know`);
    }
    M.stdout.length = 0;
    const main = F.main;
    if (!main) throw new CompileError('no main()');
    // C++ units: the dynamic initialisation of their globals, unit by unit, before main (src/cxx).
    for (const name of Object.keys(F)) if (/(^|\$)__prism_cxx_init_/.test(name)) F[name]();
    // argv lives in the image, because main may keep the pointers -- each one the model's data pointer.
    const ptrs = argv.map(a => mod.intern([...new TextEncoder().encode(a)]));
    const w = M.abi.ptr;
    const vec = mod.alloc(w * (ptrs.length + 1), w);
    ptrs.forEach((p, i) => M.storePtr(vec + i * w, p));
    M.storePtr(vec + ptrs.length * w, 0);
    finalizeHeap(M);
    try {
      const code = main.length === 0 ? main() : main(ptrs.length, vec);
      const status = leave(M, code | 0);
      return { code: status & 0xff, stdout: M.output() };
    } catch (e) {
      if (e instanceof ExitCalled) {
        const status = e.quick ? e.code : leave(M, e.code);
        return { code: status & 0xff, stdout: M.output() };
      }
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

/**
 * What a compiler predefines about its own char, which is how <limits.h> knows. gcc defines
 * __CHAR_UNSIGNED__ when char is unsigned and nothing when it is signed; PRISM's limits.h reads it,
 * so CHAR_MIN and CHAR_MAX follow compile.signedChar instead of being a second copy of the answer.
 */
/** What gcc's -mlong-double-64 changes in the predefined macros PRISM sets: the size, nothing else. */
export function longDoubleDefines(longDouble) {
  return longDouble === 64 ? { __SIZEOF_LONG_DOUBLE__: '8' } : {};
}

export function charDefines(model = 'i386', signedChar) {
  return T.makeTypes(model, { signedChar }).CHAR.signed ? {} : { __CHAR_UNSIGNED__: '1' };
}

/**
 * Everything a compiler predefines about the ABI it targets: its char, and whether a far pointer is
 * a real-mode seg*16+off. dos.h reads __PRISM_REALMODE__ to choose between the flat DJGPP meaning of
 * FP_SEG/FP_OFF/MK_FP, which Heretic's DPMI calls rely on, and the real-mode one a 16-bit program
 * computes paragraphs with.
 */
export function modelDefines(model = 'i386', signedChar) {
  const realMode = model === 'dos16' || model === 'dos16m' || model === 'dos16l';
  return {
    ...charDefines(model, signedChar),
    ...(realMode ? { __PRISM_REALMODE__: '1' } : {}),
    // Data pointers are four bytes: the large model. A header that declares a width by model reads it
    // (Borland's coreleft returns an unsigned long there, an unsigned in small and medium).
    ...(model === 'dos16l' ? { __PRISM_FARDATA__: '1' } : {}),
  };
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
