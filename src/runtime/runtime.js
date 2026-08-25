// runtime.js — the machine the emitted code runs on, plus the libc subset it links against.
//
// This is the layer that buys "no source modification": the game's own code is compiled untouched
// and everything it CALLS lives here. Only what a program actually references gets implemented —
// the unresolved-symbol list is the worklist, never anticipation.

import { Module, isFuncPtr, funcIndex } from '../link/module.js';

export class Trap extends Error {}
export class ExitCalled extends Error {
  constructor(code) { super(`exit(${code})`); this.code = code; }
}

export function makeMachine(mod = new Module()) {
  const M = {
    mod,
    u8: mod.u8,
    dv: mod.dv,
    sp: mod.stackTop,
    heap: 0,                    // set after linking, when the static area is final
    heapEnd: 0,
    stdout: [],
    randState: 1,            // see rt.rand — deterministic on purpose
    clockTicks: 0,           // the deterministic clock, see rt.clock
    uclockTicks: 0n,         // ~1/60 s per call at the PIT rate
    funcs: mod.funcTable,
    rt: null,                   // the libc surface, installed below

    zero(addr, n) { M.u8.fill(0, addr, addr + n); },
    copy(dst, src, n) { M.u8.copyWithin(dst, src, src + n); return dst; },

    /** An indirect call through a function pointer. */
    icall(p, args) {
      if (!isFuncPtr(p)) throw new Trap(`call through a non-function pointer 0x${(p >>> 0).toString(16)}`);
      const f = M.funcs[funcIndex(p)];
      if (!f) throw new Trap(`call through an unbound function pointer (index ${funcIndex(p)})`);
      return f(...args);
    },

    cstr(addr) { return mod.cstr(addr); },
    write(s) { M.stdout.push(s); },
    output() { return M.stdout.join(''); },
  };

  M.rt = makeLibc(M);
  return M;
}

/** Start the heap above the last static byte, once every global has been placed. */
export function finalizeHeap(M) {
  M.heap = Math.ceil(M.mod.brk / 16) * 16;
  M.heapEnd = M.heap;
  M.heapTop = M.mod.stackLimit - 64 * 1024;
}

function makeLibc(M) {
  const u8 = () => M.mod.u8;
  const dv = () => M.mod.dv;

  // A bump allocator with a free list good enough for programs that malloc and free in patterns.
  // Real code casts pointers to integers and relies on distinct allocations not overlapping, which
  // is the only property promised here.
  const blocks = new Map();     // addr -> size

  const malloc = (n) => {
    n = (n | 0) >>> 0;
    if (n === 0) n = 1;
    const size = Math.ceil((n + 8) / 16) * 16;
    if (M.heapEnd + size > M.heapTop) throw new Trap('out of memory in malloc');
    const addr = M.heapEnd + 8;
    M.heapEnd += size;
    dv().setUint32(addr - 8, n, true);
    blocks.set(addr, n);
    return addr;
  };

  const free = (p) => { if (p) blocks.delete(p); };

  const realloc = (p, n) => {
    if (!p) return malloc(n);
    const old = blocks.get(p) ?? dv().getUint32(p - 8, true);
    if (n <= old) return p;
    const q = malloc(n);
    M.copy(q, p, old);
    free(p);
    return q;
  };

  const strlenAt = (p) => { let n = 0; while (u8()[p + n] !== 0) n++; return n; };

  const lib = {
    // --- stdio
    printf: (fmt, args) => { const s = format(M, fmt, args ?? []); M.write(s); return s.length; },
    puts: (p) => { M.write(M.cstr(p) + '\n'); return 1; },
    putchar: (c) => { M.write(String.fromCharCode(c & 0xff)); return c & 0xff; },
    fputs: (p, _stream) => { M.write(M.cstr(p)); return 1; },
    fputc: (c, _stream) => { M.write(String.fromCharCode(c & 0xff)); return c & 0xff; },
    fprintf: (_stream, fmt, args) => { const s = format(M, fmt, args ?? []); M.write(s); return s.length; },

    /*
     * The `v` family: same formatter, arguments read from a va_list instead of a packed array. Quake
     * needs these badly — `Con_Printf`, `Sys_Error`, `Sys_Printf` and `va()` are all built on
     * vsprintf, and eleven of its functions failed to emit without them.
     */
    vprintf: (fmt, ap) => { const s = format(M, fmt, vaReader(M, ap)); M.write(s); return s.length; },
    vfprintf: (_stream, fmt, ap) => { const s = format(M, fmt, vaReader(M, ap)); M.write(s); return s.length; },
    vsprintf: (dst, fmt, ap) => {
      const s = format(M, fmt, vaReader(M, ap));
      const bytes = new TextEncoder().encode(s);
      u8().set(bytes, dst); u8()[dst + bytes.length] = 0;
      return bytes.length;
    },
    vsnprintf: (dst, n, fmt, ap) => {
      const s = format(M, fmt, vaReader(M, ap));
      const bytes = new TextEncoder().encode(s);
      const take = Math.max(0, Math.min(bytes.length, (n | 0) - 1));
      if (n | 0) { u8().set(bytes.subarray(0, take), dst); u8()[dst + take] = 0; }
      return bytes.length;
    },
    sprintf: (dst, fmt, args) => {
      const s = format(M, fmt, args ?? []);
      const bytes = new TextEncoder().encode(s);
      u8().set(bytes, dst); u8()[dst + bytes.length] = 0;
      return bytes.length;
    },
    snprintf: (dst, n, fmt, args) => {
      const s = format(M, fmt, args ?? []);
      const bytes = new TextEncoder().encode(s).subarray(0, Math.max(0, n - 1));
      u8().set(bytes, dst); u8()[dst + bytes.length] = 0;
      return s.length;
    },

    // --- stdlib
    malloc, free, realloc,
    calloc: (n, sz) => { const p = malloc(Math.imul(n, sz)); M.zero(p, Math.imul(n, sz)); return p; },
    exit: (code) => { throw new ExitCalled(code | 0); },
    abort: () => { throw new Trap('abort() called'); },
    atoi: (p) => (parseInt(M.cstr(p), 10) | 0) || 0,
    atol: (p) => (parseInt(M.cstr(p), 10) | 0) || 0,
    labs: (v) => Math.abs(v | 0) | 0,
    abs: (v) => Math.abs(v | 0) | 0,

    // --- string
    strlen: (p) => strlenAt(p) | 0,
    strcpy: (d, s) => { let i = 0; for (; u8()[s + i]; i++) u8()[d + i] = u8()[s + i]; u8()[d + i] = 0; return d; },
    strncpy: (d, s, n) => {
      let i = 0;
      for (; i < n && u8()[s + i]; i++) u8()[d + i] = u8()[s + i];
      for (; i < n; i++) u8()[d + i] = 0;
      return d;
    },
    strcat: (d, s) => { const e = d + strlenAt(d); lib.strcpy(e, s); return d; },
    strcmp: (a, b) => {
      for (let i = 0; ; i++) {
        const x = u8()[a + i], y = u8()[b + i];
        if (x !== y) return x < y ? -1 : 1;
        if (x === 0) return 0;
      }
    },
    strncmp: (a, b, n) => {
      for (let i = 0; i < n; i++) {
        const x = u8()[a + i], y = u8()[b + i];
        if (x !== y) return x < y ? -1 : 1;
        if (x === 0) return 0;
      }
      return 0;
    },
    strchr: (p, c) => {
      c &= 0xff;
      for (let i = 0; ; i++) {
        if (u8()[p + i] === c) return p + i;
        if (u8()[p + i] === 0) return 0;
      }
    },
    memcpy: (d, s, n) => { M.copy(d, s, n); return d; },
    memmove: (d, s, n) => { M.copy(d, s, n); return d; },
    memset: (d, v, n) => { u8().fill(v & 0xff, d, d + n); return d; },
    memcmp: (a, b, n) => {
      for (let i = 0; i < n; i++) {
        const x = u8()[a + i], y = u8()[b + i];
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    },

    strrchr: (p, c) => { c &= 0xff; let last = 0; for (let i = 0; ; i++) { const b = u8()[p + i]; if (b === c) last = p + i; if (b === 0) return last; } },
    strstr: (h, n) => {
      const hs = M.cstr(h), ns = M.cstr(n);
      const i = hs.indexOf(ns);
      return i < 0 ? 0 : h + i;
    },
    /*
     * A DETERMINISTIC PRNG, the ANSI C sample generator that DJGPP also shipped. It must not read
     * host entropy: the same run has to produce the same frames, which is what makes a golden
     * fingerprint possible. Lived in MAME's platform shim until Quake asked for it — the same
     * mis-filing as fopen, and for the same reason: this is ISO C, not one program's.
     */
    rand: () => { M.randState = (Math.imul(M.randState, 1103515245) + 12345) | 0; return (M.randState >>> 16) & 0x7fff; },
    srand: (seed) => { M.randState = seed | 0; },

    // ctype, C locale. EOF (-1) must answer false everywhere except tolower/toupper, which pass it
    // through -- a program looping on getchar() relies on exactly that.
    isalnum: (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0,
    isalpha: (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0,
    iscntrl: (c) => (c >= 0 && c < 32) || c === 127 ? 1 : 0,
    isdigit: (c) => (c >= 48 && c <= 57) ? 1 : 0,
    isgraph: (c) => (c > 32 && c < 127) ? 1 : 0,
    islower: (c) => (c >= 97 && c <= 122) ? 1 : 0,
    isprint: (c) => (c >= 32 && c < 127) ? 1 : 0,
    ispunct: (c) => (c > 32 && c < 127 &&
      !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) ? 1 : 0,
    isspace: (c) => c === 32 || (c >= 9 && c <= 13) ? 1 : 0,
    isupper: (c) => (c >= 65 && c <= 90) ? 1 : 0,
    isxdigit: (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) ? 1 : 0,
    tolower: (c) => (c >= 65 && c <= 90) ? c + 32 : c,
    toupper: (c) => (c >= 97 && c <= 122) ? c - 32 : c,

    /*
     * gcc's byte-swap builtins. Real code reaches for them instead of writing the shifts, and SQLite
     * does it in the hot path of every page read.
     */
    // Count leading zeros of a 64-bit value. Undefined for zero in C, and SQLite never passes zero.
    __builtin_clzll: (v) => {
      let x = BigInt.asUintN(64, typeof v === 'bigint' ? v : BigInt(v | 0));
      if (x === 0n) return 64;
      let n = 0;
      while (x < 0x8000000000000000n) { x <<= 1n; n++; }
      return n;
    },
    __builtin_clz: (v) => (v >>> 0) === 0 ? 32 : Math.clz32(v >>> 0),
    __builtin_ctz: (v) => { const u = v >>> 0; if (!u) return 32; let n = 0; let x = u; while (!(x & 1)) { x >>>= 1; n++; } return n; },
    utimes: () => 0,
    gmtime: () => 0,
    nanosleep: () => 0,

    __builtin_bswap16: (v) => ((v & 0xff) << 8 | (v >>> 8) & 0xff) & 0xffff,
    __builtin_bswap32: (v) => (((v & 0xff) << 24) | ((v & 0xff00) << 8) |
                               ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) | 0,

    /*
     * The atomics are PLAIN loads and stores here, and that is not a shortcut: the guest is one
     * thread on one core, so there is nothing to order against. If PRISM ever runs guest code on
     * more than one thread, these become wrong and must be revisited — recorded here rather than
     * discovered then.
     */
    __atomic_load_n: (p, _order) => M.mod.dv.getInt32(p, true),
    __atomic_store_n: (p, v, _order) => { M.mod.dv.setInt32(p, v | 0, true); },
    __atomic_fetch_add: (p, v) => {
      const old = M.mod.dv.getInt32(p, true);
      M.mod.dv.setInt32(p, (old + (v | 0)) | 0, true);
      return old;
    },

    strspn: (sPtr, acceptPtr) => {
      const accept = new Set([...M.mod.cstr(acceptPtr)].map(c => c.charCodeAt(0)));
      let n = 0;
      while (M.u8[sPtr + n] && accept.has(M.u8[sPtr + n])) n++;
      return n;
    },
    strcspn: (sPtr, rejectPtr) => {
      const reject = new Set([...M.mod.cstr(rejectPtr)].map(c => c.charCodeAt(0)));
      let n = 0;
      while (M.u8[sPtr + n] && !reject.has(M.u8[sPtr + n])) n++;
      return n;
    },

    atof: (p) => { const v = parseFloat(M.mod.cstr(p)); return Number.isNaN(v) ? 0 : v; },
    atol: (p) => { const v = parseInt(M.mod.cstr(p), 10); return Number.isNaN(v) ? 0 : v | 0; },

    /*
     * POSIX file descriptors, the three calls Quake's Con_DebugLog uses and nothing more. They ride
     * on the same store as stdio (see src/env/stdio.js), so a file written through a descriptor is
     * readable through `fopen` — which is what a program that mixes the two expects.
     */
    memchr: (p, c, n) => { c &= 0xff; for (let i = 0; i < n; i++) if (u8()[p + i] === c) return p + i; return 0; },

    /**
     * Walk a va_list. Each argument occupies a whole number of 4-byte slots, which is how i386
     * lays varargs on the stack; the OLD position is returned so `*(type *)` reads this argument
     * and the list already points at the next one.
     */
    __prism_va_next: (pp, size) => {
      const cur = dv().getInt32(pp, true);
      // A zero-sized argument advances by ZERO, not by one slot: the `|| 1` fallback here disagreed
      // with the caller's packing, which desynchronised every argument after a `struct { char x[0]; }`
      // (gcc's va-arg-22.c passes 21 structs by value, the first of them empty).
      const step = Math.ceil((size | 0) / 4) * 4;
      dv().setInt32(pp, (cur + step) | 0, true);
      return cur;
    },

    /**
     * A DETERMINISTIC clock — the default, and what every gate runs against. Reading the host's real
     * time would destroy the property the whole test strategy rests on: the same input must yield
     * byte-identical state, which is what makes a golden fingerprint possible at all (MIRAGE keeps
     * the same rule: no Date, no Math.random).
     *
     * The increments are one frame's worth per call — 16667 µs and 19886 PIT ticks are 1/60 s — which
     * has a consequence worth stating out loud rather than leaving as a happy accident. MAME 0.1
     * throttles itself with
     *
     *     do { curr = uclock(); } while ((curr - prev) < UCLOCKS_PER_SEC/drv->frames_per_second);
     *
     * and against this clock that loop exits after exactly ONE call. The program believes it waited;
     * it did not. Determinism is bought by neutralising the program's own timing, and something else
     * then has to do the pacing. See `installRealClock` for the interactive answer.
     */
    clock: () => { M.clockTicks = (M.clockTicks + 16667) >>> 0; return M.clockTicks; },
    // uclock returns a 64-bit count, so a BigInt — see the i64 note in emit.js.
    uclock: () => { M.uclockTicks += 19886n; return M.uclockTicks; },
    time: (p) => { const t = 852076800; if (p) dv().setInt32(p, t, true); return t; },

    /**
     * setjmp/longjmp. The buffer records the shadow-stack frame that called setjmp and the resume
     * point inside that function; longjmp throws, and the frame's own dispatch loop recognises its
     * own fp and resumes. A longjmp into a frame that has already returned is undefined in C, and
     * here it simply finds no catcher and surfaces as an error rather than corrupting anything.
     */
    __prism_setjmp: (env, fp, pc) => {
      dv().setInt32(env, fp | 0, true);
      dv().setInt32(env + 4, pc | 0, true);
      return 0;
    },
    longjmp: (env, val) => {
      const fp = dv().getInt32(env, true);
      const pc = dv().getInt32(env + 4, true);
      // C says longjmp(env, 0) makes setjmp return 1.
      throw { __prismJmp: fp, pc, val: (val | 0) === 0 ? 1 : (val | 0) };
    },

    // --- gcc builtins that are not library calls
    __builtin_expect: (v, _expected) => v,
    __builtin_prefetch: () => {},
    // A stub that returns 0 here does not "not support" the builtin, it LIES: the caller compares
    // the result and its own check fails, turning a clean refusal into a miscompile
    // (frame-address.c). Refusing is the honest answer until there is a real call stack to report.
    __builtin_return_address: () => { throw new Trap('__builtin_return_address is not supported'); },
    // A compiler is always allowed to answer 0 here; PRISM has not folded the argument, so it must.
    __builtin_constant_p: () => 0,
    /**
     * alloca: bump the shadow stack DOWN. The caller's epilogue restores M.sp to its frame top,
     * which frees it at function exit — exactly alloca's contract.
     */
    alloca: (n) => {
      const size = Math.ceil(((n | 0) + 15) / 16) * 16;
      M.sp = (M.sp - size) | 0;
      if (M.sp < M.mod.stackLimit) throw new Trap('shadow stack overflow in alloca');
      return M.sp;
    },

    // --- math (double in, double out; the emitter has already coerced)
    sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan,
    atan2: Math.atan2, exp: Math.exp, log: Math.log, log10: Math.log10, pow: Math.pow,
    floor: Math.floor, ceil: Math.ceil, fabs: Math.abs,
    fmod: (a, b) => a % b,
  };
  return lib;
}

/**
 * printf. Written out rather than delegated because the format quirks are observable and the gate
 * compares stdout byte for byte against glibc's.
 */
/**
 * Where a formatting call's arguments come from. Two sources, one interface.
 *
 * `printf` is emitted with its extras packed into a JS array, one slot per argument. `vsprintf` is
 * handed a `va_list`, which on i386 is a plain pointer into the caller's packed buffer — so the
 * arguments have to be read out of GUEST MEMORY at their real widths: 4 bytes for an int or a
 * pointer, 8 for a double (varargs promote float) or a `long long`.
 *
 * Splitting the reader is what lets one formatter serve both. The conversion tells us the width, so
 * the reader never has to guess.
 */
function arrayReader(args) {
  let i = 0;
  return { i32: () => args[i++], f64: () => args[i++], i64: () => args[i++] };
}

function vaReader(M, ap) {
  let p = ap | 0;
  const dv = M.mod.dv;
  return {
    i32: () => { const v = dv.getInt32(p, true); p += 4; return v; },
    f64: () => { const v = dv.getFloat64(p, true); p += 8; return v; },
    i64: () => { const v = dv.getBigInt64(p, true); p += 8; return v; },
  };
}

export function format(M, fmtPtr, args) {
  const fmt = M.cstr(fmtPtr);
  const src = Array.isArray(args) ? arrayReader(args) : args;
  let out = '';
  const nextArg = () => src.i32();

  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') { out += c; continue; }
    i++;
    if (fmt[i] === '%') { out += '%'; continue; }

    let flags = '';
    while ('-+ #0'.includes(fmt[i])) flags += fmt[i++];
    let width = '';
    if (fmt[i] === '*') { width = String(nextArg() | 0); i++; }
    else while (/[0-9]/.test(fmt[i])) width += fmt[i++];
    let prec = null;
    if (fmt[i] === '.') {
      i++; prec = '';
      if (fmt[i] === '*') { prec = String(nextArg() | 0); i++; }
      else while (/[0-9]/.test(fmt[i])) prec += fmt[i++];
    }
    // The length modifier MATTERS on i386 for one case: `ll` is 64 bits, and the emitter hands a
    // BigInt for those. Everything else is 32 bits, `l` included.
    let len = '';
    while ('hlLqjzt'.includes(fmt[i])) len += fmt[i++];
    const wide64 = len.includes('ll') || len === 'q' || len === 'j';

    const conv = fmt[i];
    let body;
    switch (conv) {
      case 'd': case 'i': body = String(intArg(wide64 ? src.i64() : src.i32(), wide64, true)); break;
      case 'u': body = String(intArg(wide64 ? src.i64() : src.i32(), wide64, false)); break;
      case 'x': body = intArg(wide64 ? src.i64() : src.i32(), wide64, false).toString(16); break;
      case 'X': body = intArg(wide64 ? src.i64() : src.i32(), wide64, false).toString(16).toUpperCase(); break;
      case 'o': body = intArg(wide64 ? src.i64() : src.i32(), wide64, false).toString(8); break;
      case 'c': body = String.fromCharCode(nextArg() & 0xff); break;
      case 's': {
        const p = nextArg() | 0;
        body = p === 0 ? '(null)' : M.cstr(p);
        if (prec !== null && prec !== '') body = body.slice(0, +prec);
        break;
      }
      case 'p': {
        const v = (nextArg() | 0) >>> 0;
        body = v === 0 ? '(nil)' : '0x' + v.toString(16);
        break;
      }
      case 'f': case 'F': body = fixed(src.f64(), prec === null || prec === '' ? 6 : +prec); break;
      case 'e': case 'E': {
        const p = prec === null || prec === '' ? 6 : +prec;
        body = src.f64().toExponential(p);
        // C writes at least two exponent digits; JS writes one.
        body = body.replace(/e([-+])(\d)$/, 'e$10$2');
        if (conv === 'E') body = body.toUpperCase();
        break;
      }
      case 'g': case 'G': {
        const p = prec === null || prec === '' ? 6 : Math.max(1, +prec);
        const v = src.f64();
        body = String(Number(v.toPrecision(p)));
        if (conv === 'G') body = body.toUpperCase();
        break;
      }
      default:
        out += '%' + flags + width + (prec !== null ? '.' + prec : '') + (conv ?? '');
        continue;
    }

    // Zero-padding and precision on integers, then width.
    const numeric = 'diuxXo'.includes(conv);
    if (numeric) {
      let neg = body.startsWith('-');
      if (neg) body = body.slice(1);
      if (prec !== null && prec !== '' && body.length < +prec) body = '0'.repeat(+prec - body.length) + body;
      if (flags.includes('#') && (conv === 'x' || conv === 'X') && body !== '0') body = (conv === 'x' ? '0x' : '0X') + body;
      if (neg) body = '-' + body;
      else if (flags.includes('+')) body = '+' + body;
      else if (flags.includes(' ')) body = ' ' + body;
      if (width && body.length < +width) {
        if (flags.includes('-')) body = body.padEnd(+width);
        else if (flags.includes('0') && prec === null) {
          const sign = /^[-+ ]/.test(body) ? body[0] : '';
          const rest = sign ? body.slice(1) : body;
          body = sign + '0'.repeat(+width - body.length) + rest;
        } else body = body.padStart(+width);
      }
    } else if (width) {
      body = flags.includes('-') ? body.padEnd(+width) : body.padStart(+width);
    }
    out += body;
  }
  return out;
}

/**
 * One integer argument, at the width the conversion asks for. Returns a Number for 32-bit and a
 * BigInt for 64-bit, because neither JS type converts to the other implicitly — `nextArg() | 0` on a
 * BigInt throws outright, which is how `%lld` announced itself.
 */
function intArg(v, wide64, signed) {
  if (wide64) {
    const b = typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v) || 0));
    return signed ? BigInt.asIntN(64, b) : BigInt.asUintN(64, b);
  }
  const n = typeof v === 'bigint' ? Number(BigInt.asIntN(32, v)) : (v | 0);
  return signed ? (n | 0) : (n >>> 0);
}

/**
 * `%.*f`. Not `toFixed`: C rounds a tie to EVEN (IEEE round-to-nearest-even), JS rounds a tie away
 * from zero. `printf("%.0f", 2.5)` is therefore "2" in C and "3" from toFixed — measured against
 * glibc, not assumed.
 */
function fixed(v, p) {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  const neg = v < 0 || Object.is(v, -0);
  const a = Math.abs(v);
  const scale = 10 ** p;
  const x = a * scale;
  let n;
  if (Math.abs(x - Math.trunc(x)) === 0.5) {
    const t = Math.trunc(x);
    n = t % 2 === 0 ? t : t + 1;          // the tie goes to the even neighbour
  } else {
    n = Math.round(x);
  }
  const digits = String(n).padStart(p + 1, '0');
  const int = p ? digits.slice(0, -p) : digits;
  const frac = p ? digits.slice(-p) : '';
  return (neg ? '-' : '') + int + (p ? '.' + frac : '');
}

/**
 * Replace the deterministic clock with a real, scalable one that does not spin.
 *
 * A DOS program of this era paces itself by busy-waiting on a clock, and MAME 0.1 does exactly that
 * (machine.c, `Z80_Interrupt`). Two ways to host that, both wrong on their own:
 *
 *   * a deterministic per-call counter — the wait exits immediately, the program's own timing is
 *     neutralised, and the host has to impose a frame rate from outside. Reproducible, unfaithful.
 *   * a real clock — the wait becomes a genuine spin loop that burns a whole core for the rest of
 *     every frame. Faithful, and exactly what the program did on real hardware, which is precisely
 *     why it is wasteful here.
 *
 * This is the third option: the clock returns real elapsed time, and when it is being polled in a
 * tight loop it SLEEPS before answering. The program sees monotonic real time and its own throttle
 * does the pacing, at the rate the program itself chose; nothing spins. The trick is only possible
 * because the clock is a function call into the runtime — there is no instruction stream to watch.
 *
 * `speed` scales it, which is how a speed control should work: lie about time, the way DOSBox does,
 * rather than fight the program's throttle from outside. At 200% the program's wait is satisfied
 * twice as fast. At 0 (unlimited) time races ahead so no wait is ever satisfied slowly.
 *
 * NOT the default, and never in the gates: this is where reproducibility is traded for faithfulness,
 * and that trade belongs to an interactive host only.
 */
export function installRealClock(M, { now, speed = () => 100, paused = () => false } = {}) {
  const clockNow = now || (() => performance.now());
  let wall = clockNow();          // host time at the last advance
  let micros = 0;                 // guest time elapsed, in microseconds

  function advance() {
    const t = clockNow();
    const pct = speed();
    if (paused()) { wall = t; return micros; }        // a paused program's clock must not run on
    if (pct <= 0) {
      // Unlimited: hand out a large jump, so any "has enough time passed" test says yes at once and
      // the program's own throttle never waits.
      micros += 1e6;
    } else {
      micros += (t - wall) * 1000 * pct / 100;
    }
    wall = t;
    return micros;
  }

  M.rt.clock = () => (advance() >>> 0);
  M.rt.uclock = () => BigInt(Math.round(advance() * 1.19318));   // µs -> PIT ticks at 1193180 Hz
  M.realClock = { micros: () => micros };
}

/**
 * Turn the guest's spin-wait loops into sleeping waits, without knowing anything about the loops.
 *
 * A DOS program of this era waits by polling. MAME 0.1 alone has
 *
 *     do { curr = uclock(); } while ((curr - prev) < UCLOCKS_PER_SEC/drv->frames_per_second);
 *     while (osd_key_pressed(OSD_KEY_P));            // wait for key release, three times over
 *
 * The runtime cannot see a loop — but it does see every call into a service, and that is enough. A
 * service called over and over with NO FRAME PRESENTED in between is a program that is waiting, not
 * a program making progress: in normal play `osd_key_pressed` is asked a dozen times per frame and
 * the frame counter moves; inside a release-wait it is asked thousands of times and nothing moves.
 *
 * Past the threshold each call parks for a millisecond, so the loop runs about a thousand times a
 * second instead of millions, and the core goes idle. The program's own logic is untouched — it is
 * still polling, it still decides when to stop.
 *
 * The threshold has to be MEASURED, not chosen. Too low and a timer-calibration loop — the kind that
 * counts iterations per tick — concludes the machine is a thousand times slower than it is, which is
 * the trap MIRAGE hit with Wolf3D. Too high and the core burns for longer than it needs to.
 *
 * What this deliberately does NOT catch: a loop that never calls the runtime at all, `while (1);`
 * being the honest example. Nothing here can see it, because nothing here is called. The only recourse
 * is terminating the worker, and the general fix would be a safepoint on loop back-edges in the
 * emitted code — which MIRAGE measured as a real cost on emitted-code speed, so it waits until
 * something needs it.
 */
export function installSpinDamping(M, {
  park = () => {}, frame, now = () => performance.now(),
  threshold = 256, sleepMs = 1, landingMs = 1.2, services,
} = {}) {
  /*
   * `services` may be a list (all sharing `threshold`) or a map of name -> threshold. Per-service is
   * not fussiness: the thresholds differ by two orders of magnitude for a measured reason. A frame's
   * legitimate polling of `osd_key_pressed` peaked at 21 over 400 frames of Pac-Man, but a program
   * asks the clock once or twice a frame — so a threshold high enough for the keyboard left 4096
   * clock calls spinning before every single frame's wait, which measured as ~0.6 ms of pure
   * overhead per frame and held the rate to 58 fps.
   */
  const limit = Array.isArray(services)
    ? Object.fromEntries(services.map(n => [n, threshold]))
    : services;
  let lastName = '', run = 0, lastFrame = -1, runStart = 0, lastAt = 0;
  // maxRun per service CALIBRATES the threshold: the longest run of consecutive calls seen inside one
  // frame, so the threshold has to sit above the largest legitimate one.
  const stats = { parks: 0, spins: 0, calls: 0, maxRun: Object.create(null), learned: Object.create(null) };

  for (const name of Object.keys(limit)) {
    const inner = M.rt[name];
    if (typeof inner !== 'function') continue;
    stats.maxRun[name] = 0;
    stats.learned[name] = 0;

    M.rt[name] = function (...args) {
      const f = frame();
      if (name !== lastName || f !== lastFrame) {
        // A run just ended: remember how long it took, because that is the program's own deadline,
        // observed rather than declared. This is the only source for it — the loop's exit condition
        // is invisible from here.
        // `lastAt`, not `now()`: the run ended at its LAST CALL, and we only notice here — which can
        // be a whole frame of emulation later. Measuring to this moment learned the frame PERIOD
        // (~17.5 ms) instead of the wait (~16 ms), so the landing window sat past the deadline and
        // the rate stayed stuck at 57 fps.
        // `>=`, not `>`: the run counter is CLAMPED to the limit once damping starts, so a strict
        // comparison was never true and this never recorded anything. The landing window silently did
        // nothing for three measurements — `spins` stayed at 0 and every `learned` at 0, which is how
        // it was caught.
        if (lastName && run >= limit[lastName]) stats.learned[lastName] = lastAt - runStart;
        lastName = name; lastFrame = f; run = 0; runStart = now();
      }
      run++;
      if (run > stats.maxRun[name]) stats.maxRun[name] = run;

      if (run > limit[name]) {
        run = limit[name];                          // stay damped for as long as it keeps asking
        const elapsed = now() - runStart;
        const target = stats.learned[name];
        /*
         * Park, except in a narrow window around the moment this wait ended LAST time, where we let
         * the calls through and let the loop spin.
         *
         * The reason is measured: Atomics.wait does not honour a sub-millisecond timeout — asking for
         * 0.25 ms still costs about one — so parking right up to the deadline overshoots it and the
         * frame rate came out at 55-59 instead of 60. Sleeping through the bulk of the wait and
         * spinning only the last millisecond lands on it, and costs about 6% of one core rather than
         * a whole one.
         *
         * Outside that window it parks, which is what keeps an UNPREDICTABLE wait — a key release,
         * which lasts as long as a finger does — from spinning at all.
         */
        const landing = target > landingMs && elapsed > target - landingMs && elapsed < target + landingMs;
        if (landing) stats.spins++;
        else { stats.parks++; park(sleepMs); }
      }
      stats.calls++;
      lastAt = now();
      return inner.apply(this, args);
    };
  }

  M.spinDamping = stats;
}
