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
     * A DETERMINISTIC clock. Reading the host's real time would destroy the property the whole test
     * strategy rests on — the same input must yield byte-identical state, which is what makes a
     * golden fingerprint possible at all (MIRAGE keeps the same rule: no Date, no Math.random).
     * A program that measures frame times therefore sees a steady, reproducible rate.
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
export function format(M, fmtPtr, args) {
  const fmt = M.cstr(fmtPtr);
  let out = '';
  let ai = 0;
  const nextArg = () => args[ai++];

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
      case 'd': case 'i': body = String(intArg(nextArg(), wide64, true)); break;
      case 'u': body = String(intArg(nextArg(), wide64, false)); break;
      case 'x': body = intArg(nextArg(), wide64, false).toString(16); break;
      case 'X': body = intArg(nextArg(), wide64, false).toString(16).toUpperCase(); break;
      case 'o': body = intArg(nextArg(), wide64, false).toString(8); break;
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
      case 'f': case 'F': body = fixed(+nextArg(), prec === null || prec === '' ? 6 : +prec); break;
      case 'e': case 'E': {
        const p = prec === null || prec === '' ? 6 : +prec;
        body = (+nextArg()).toExponential(p);
        // C writes at least two exponent digits; JS writes one.
        body = body.replace(/e([-+])(\d)$/, 'e$10$2');
        if (conv === 'E') body = body.toUpperCase();
        break;
      }
      case 'g': case 'G': {
        const p = prec === null || prec === '' ? 6 : Math.max(1, +prec);
        const v = +nextArg();
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
