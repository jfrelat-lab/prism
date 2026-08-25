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
  msync: { ret: I, params: [P, U, I] },
  chmod: { ret: I, params: [P, U] },
  umask: { ret: U, params: [U] },
  fsync: { ret: I, params: [I] },
  fdatasync: { ret: I, params: [I] },
  sysconf: { ret: I, params: [I] },
  getenv: { ret: P, params: [P] },
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
  abort: { ret: V, params: [] },
  atoi: { ret: I, params: [P] },
  atol: { ret: T.LONG, params: [P] },
  abs: { ret: I, params: [I] },
  labs: { ret: T.LONG, params: [T.LONG] },
  strlen: { ret: U, params: [P] },
  strcpy: { ret: P, params: [P, P] },
  strncpy: { ret: P, params: [P, P, U] },
  strcat: { ret: P, params: [P, P] },
  strcmp: { ret: I, params: [P, P] },
  strncmp: { ret: I, params: [P, P, U] },
  strchr: { ret: P, params: [P, I] },
  memcpy: { ret: P, params: [P, P, U] },
  memmove: { ret: P, params: [P, P, U] },
  memset: { ret: P, params: [P, I, U] },
  memcmp: { ret: I, params: [P, P, U] },
  sqrt: { ret: D, params: [D] }, sin: { ret: D, params: [D] }, cos: { ret: D, params: [D] },
  tan: { ret: D, params: [D] }, atan: { ret: D, params: [D] }, atan2: { ret: D, params: [D, D] },
  exp: { ret: D, params: [D] }, log: { ret: D, params: [D] }, log10: { ret: D, params: [D] },
  pow: { ret: D, params: [D, D] }, floor: { ret: D, params: [D] }, ceil: { ret: D, params: [D] },
  fabs: { ret: D, params: [D] }, fmod: { ret: D, params: [D, D] },

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

export class CompileError extends Error {}

/**
 * Compile one translation unit.
 * @returns {{M, F, src, run: (argv?: string[]) => {code: number, stdout: string}}}
 */
export function compile(source, { file = 'main.c', defines = {}, resolve = null, memory, shared = false, safepoints = false } = {}) {
  const pp = new Preprocessor({
    defines: mergeDefines(TARGET_DEFINES, defines),
    resolve: resolve ?? builtinHeaderResolver(),
  });
  const tokens = pp.run(source, file);
  const { unit, scope } = parse(tokens, { file });

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
  const ctx = { globals, funcs, builtins: BUILTINS, safepoints };
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
    `${emitted.map(n => `F[${JSON.stringify(n)}]=${jsIdent(n)};`).join('\n')}\n};`;

  let factory;
  try {
    factory = new Function(src)();
  } catch (e) {
    throw new CompileError(`emitted JavaScript did not compile: ${e.message}\n${numbered(src)}`);
  }
  const F = Object.create(null);
  factory(M, F, mod.dv);
  for (const name of emitted) mod.bindFunc(name, F[name]);
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

export function compileProgram(units, { defines = {}, resolve = null, memory, includes = {}, collect = false, shared = false, safepoints = false } = {}) {
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
    const pp = new Preprocessor({ defines: mergeDefines(TARGET_DEFINES, defines), resolve: resolver });
    const tokens = pp.run(u.source, u.file);
    const { unit, scope } = parse(tokens, { file: u.file });
    parsed.push({ ...u, unit, scope, tag: tagOf(u.file) });
  }

  // Pass 1: place every name. A static gets a private linkage name; the rest are shared.
  const sharedGlobals = new Map(), sharedFuncs = new Map();
  for (const p of parsed) {
    p.globals = new Map();
    p.funcs = new Map();
    for (const d of p.unit.decls) {
      const internal = d.storage === 'static';
      if (d.n === 'vardecl') {
        const link = internal ? `${p.tag}$${d.name}` : d.name;
        if (d.type.k === 'func') {
          (internal ? p.funcs : sharedFuncs).set(d.name, mod.defineFunc(link, d.type));
          continue;
        }
        // `extern int x;` with no initialiser declares; it does not define.
        if (d.storage === 'extern' && !d.init) continue;
        const sym = mod.defineGlobal(link, d.type);
        (internal ? p.globals : sharedGlobals).set(d.name, { addr: sym.addr, type: d.type });
      } else if (d.n === 'func') {
        const link = internal ? `${p.tag}$${d.name}` : d.name;
        const fn = mod.defineFunc(link, d.type);
        // A DEFINITION, not just a prototype: the distinction decides whether a call reaches the
        // program's own code or a runtime builtin of the same name.
        fn.defined = true;
        (internal ? p.funcs : sharedFuncs).set(d.name, fn);
      }
    }
  }

  // Pass 2: emit, with each unit's statics shadowing the shared names.
  const pieces = [], emitted = [];
  // Shared across units: a builtin whose address is taken in ONE unit still needs binding once.
  const builtinRefs = new Set();

  for (const p of parsed) {
    const ctx = {
      safepoints,
      builtinRefs,
      globals: overlay(sharedGlobals, p.globals),
      funcs: overlay(sharedFuncs, p.funcs),
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
    emitted.map(n => `F[${JSON.stringify(n)}]=${jsIdent(n)};`).join('\n') + '\n};';

  let factory;
  try {
    factory = new Function(src)();
  } catch (e) {
    throw new CompileError(`emitted JavaScript did not compile: ${e.message}`);
  }
  const F = Object.create(null);
  factory(M, F, mod.dv);
  for (const name of emitted) mod.bindFunc(name, F[name]);
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

  return { M, F, src, mod, failures, run: makeRunner(M, F, mod) };
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
