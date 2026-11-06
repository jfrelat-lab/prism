// msvc-rt.js — the machine state MSVC inline assembly (src/asm/msvc.js) runs against: the eight MMX
// registers and their operations, and the flags of the integer instructions.
//
// THE MMX REGISTERS ARE THE PROGRAM'S, not a function's. .kkrieger's Bitmap_Inner leaves nothing in
// them for later, but nothing in the architecture forbids a block from reading what another block, in
// another function, left there -- and EMMS is the program saying when it is done. So there is ONE
// register file per machine (M.x86), as there is one on the chip.
//
// The semantics are the Intel SDM's (vol. 2, the MMX instructions, and the integer instructions SSE
// added to them), lane by lane over typed views of one buffer; register 8 is a scratch a memory
// operand is loaded into, so every operation reads two registers. The model is the one MIRAGE
// (github.com/jfrelat-lab/mirage-x86, src/mmx.js) runs against Docker i386; it is re-derived here,
// not imported -- MIRAGE is a processor and emits against a CPU object, PRISM compiles C.
//
// The x87 aliasing is not modelled: an MMX register's value is not visible through the x87 stack.
// No program of the period stores x87 registers to read MMX ones back.

export const MM_SCRATCH = 8;

/*
 * A result rounded to 24 significant bits as the x87 does at single precision: the SIGNIFICAND only. The
 * exponent stays the register's, 15 bits, so 1e-73 is a 24-bit number there, where Math.fround -- a
 * float's exponent too -- makes it 0 (sFPow(x, 64) in .kkrieger's Bitmap_Bump, against QEMU's
 * floatx80). Outside a float's range the value is scaled into it by an exact power of two and back.
 */
export function sig24(v) {
  const a = Math.abs(v);
  if (a === 0 || !Number.isFinite(a) || (a >= 1.1754943508222875e-38 && a < 3.4e38)) return Math.fround(v);
  const k = Math.floor(Math.log2(a)), h = k >> 1;                  // two steps: 2^1074 is not a double
  return Math.fround(v * 2 ** -h * 2 ** -(k - h)) * 2 ** h * 2 ** (k - h);
}

const s8 = (v) => (v < -128 ? -128 : v > 127 ? 127 : v);
const u8s = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const s16 = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const u16s = (v) => (v < 0 ? 0 : v > 65535 ? 65535 : v);

/** The register file and one function per operation: `op(d, s)` with d, s register numbers. */
export function makeX86() {
  const buf = new ArrayBuffer(8 * 9);
  const u8 = new Uint8Array(buf), i8 = new Int8Array(buf), u16 = new Uint16Array(buf), i16 = new Int16Array(buf);
  const u32 = new Uint32Array(buf), i32 = new Int32Array(buf);
  const T = new ArrayBuffer(8);
  const Tu8 = new Uint8Array(T), Tu16 = new Uint16Array(T), Ti16 = new Int16Array(T), Tu32 = new Uint32Array(T);
  const keep = (d) => { u32[d * 2] = Tu32[0]; u32[d * 2 + 1] = Tu32[1]; };

  // Lane-wise ops: `f(a, b)` over the lanes of one view, written back through the same view (a typed
  // array store wraps, which is the wrapping form; the saturating forms clamp first).
  const lanes = (view, n, f) => (d, s) => {
    const D = d * n, S = s * n;
    for (let k = 0; k < n; k++) view[D + k] = f(view[D + k], view[S + k]);
  };
  const cmp = (view, n, f) => (d, s) => {
    const D = d * n, S = s * n, all = n === 8 ? 0xff : n === 4 ? 0xffff : 0xffffffff;
    for (let k = 0; k < n; k++) view[D + k] = f(view[D + k], view[S + k]) ? all : 0;
  };
  /** The 64-bit count of a shift: an immediate, or the low quadword of a register. */
  const count = (s, imm) => (s < 0 ? imm : (u32[s * 2 + 1] ? 0xffffffff : u32[s * 2]));
  const shift = (view, n, bits, dir, arith) => (d, s, imm) => {
    const c = count(s, imm), D = d * n;
    for (let k = 0; k < n; k++) {
      if (c >= bits) view[D + k] = arith ? (view[D + k] < 0 ? -1 : 0) : 0;
      else view[D + k] = dir < 0 ? view[D + k] << c : arith ? view[D + k] >> c : view[D + k] >>> c;
    }
  };
  const q = (d) => (BigInt(u32[d * 2 + 1]) << 32n) | BigInt(u32[d * 2]);
  const setq = (d, v) => { u32[d * 2] = Number(v & 0xffffffffn); u32[d * 2 + 1] = Number((v >> 32n) & 0xffffffffn); };
  /** Interleave the low (hi=0) or high (hi=1) halves of d and s, in lanes of `size` bytes. */
  const unpack = (size, hi) => (d, s) => {
    const half = 8 / size / 2;
    for (let k = 0; k < half; k++) {
      for (let b = 0; b < size; b++) {
        Tu8[2 * k * size + b] = u8[d * 8 + (hi * half + k) * size + b];
        Tu8[(2 * k + 1) * size + b] = u8[s * 8 + (hi * half + k) * size + b];
      }
    }
    keep(d);
  };

  // Bit views shared by the x87's memory formats.
  const P = new ArrayBuffer(16);
  const Pf32 = new Float32Array(P), Pf64 = new Float64Array(P), Pu32 = new Uint32Array(P), Pu16 = new Uint16Array(P);

  const X = {
    buf, u8, u16, i16, u32, i32,
    /** Parity of a byte, for PF: 1 when its count of set bits is even. */
    par: PARITY,
    /** The time-stamp counter: virtual, a fixed step per read, so a run is reproducible. */
    tsc: 0,
    rdtsc() { X.tsc += 1000; return X.tsc; },
    /** Memory into the scratch register, as two 32-bit halves the emitter read through its own path. */
    ld: (lo, hi) => { u32[MM_SCRATCH * 2] = lo >>> 0; u32[MM_SCRATCH * 2 + 1] = hi >>> 0; },
    lo: (r) => u32[r * 2], hi: (r) => u32[r * 2 + 1],
    movdIn: (d, v) => { u32[d * 2] = v >>> 0; u32[d * 2 + 1] = 0; },
    movq: (d, s) => { u32[d * 2] = u32[s * 2]; u32[d * 2 + 1] = u32[s * 2 + 1]; },
    emms: () => {},

    paddb: lanes(u8, 8, (a, b) => a + b), paddw: lanes(u16, 4, (a, b) => a + b), paddd: lanes(u32, 2, (a, b) => a + b),
    paddsb: lanes(i8, 8, (a, b) => s8(a + b)), paddsw: lanes(i16, 4, (a, b) => s16(a + b)),
    paddusb: lanes(u8, 8, (a, b) => u8s(a + b)), paddusw: lanes(u16, 4, (a, b) => u16s(a + b)),
    psubb: lanes(u8, 8, (a, b) => a - b), psubw: lanes(u16, 4, (a, b) => a - b), psubd: lanes(u32, 2, (a, b) => a - b),
    psubsb: lanes(i8, 8, (a, b) => s8(a - b)), psubsw: lanes(i16, 4, (a, b) => s16(a - b)),
    psubusb: lanes(u8, 8, (a, b) => u8s(a - b)), psubusw: lanes(u16, 4, (a, b) => u16s(a - b)),
    pmullw: lanes(i16, 4, (a, b) => Math.imul(a, b)),
    pmulhw: lanes(i16, 4, (a, b) => Math.imul(a, b) >> 16),
    pmulhuw: lanes(u16, 4, (a, b) => (a * b) >>> 16),
    pmaddwd: (d, s) => {
      for (let k = 0; k < 2; k++) {
        Tu32[k] = Math.imul(i16[d * 4 + 2 * k], i16[s * 4 + 2 * k]) + Math.imul(i16[d * 4 + 2 * k + 1], i16[s * 4 + 2 * k + 1]);
      }
      keep(d);
    },
    pand: lanes(u32, 2, (a, b) => a & b), por: lanes(u32, 2, (a, b) => a | b), pxor: lanes(u32, 2, (a, b) => a ^ b),
    pandn: lanes(u32, 2, (a, b) => ~a & b),
    pcmpeqb: cmp(u8, 8, (a, b) => a === b), pcmpeqw: cmp(u16, 4, (a, b) => a === b), pcmpeqd: cmp(u32, 2, (a, b) => a === b),
    pcmpgtb: cmp(i8, 8, (a, b) => a > b), pcmpgtw: cmp(i16, 4, (a, b) => a > b), pcmpgtd: cmp(i32, 2, (a, b) => a > b),

    psllw: shift(u16, 4, 16, -1), pslld: shift(u32, 2, 32, -1),
    psrlw: shift(u16, 4, 16, 1), psrld: shift(u32, 2, 32, 1),
    psraw: shift(i16, 4, 16, 1, true), psrad: shift(i32, 2, 32, 1, true),
    psllq: (d, s, imm) => { const c = count(s, imm); setq(d, c >= 64 ? 0n : (q(d) << BigInt(c)) & 0xffffffffffffffffn); },
    psrlq: (d, s, imm) => { const c = count(s, imm); setq(d, c >= 64 ? 0n : q(d) >> BigInt(c)); },

    punpcklbw: unpack(1, 0), punpcklwd: unpack(2, 0), punpckldq: unpack(4, 0),
    punpckhbw: unpack(1, 1), punpckhwd: unpack(2, 1), punpckhdq: unpack(4, 1),
    // The destination's lanes fill the low half and the source's the high one.
    packsswb: (d, s) => { for (let k = 0; k < 4; k++) { Tu8[k] = s8(i16[d * 4 + k]); Tu8[4 + k] = s8(i16[s * 4 + k]); } keep(d); },
    packuswb: (d, s) => { for (let k = 0; k < 4; k++) { Tu8[k] = u8s(i16[d * 4 + k]); Tu8[4 + k] = u8s(i16[s * 4 + k]); } keep(d); },
    packssdw: (d, s) => { for (let k = 0; k < 2; k++) { Ti16[k] = s16(i32[d * 2 + k]); Ti16[2 + k] = s16(i32[s * 2 + k]); } keep(d); },

    // The integer MMX instructions SSE added (a Pentium III's; .kkrieger's genbitmap uses pmaxsw).
    pminsw: lanes(i16, 4, (a, b) => (a < b ? a : b)), pmaxsw: lanes(i16, 4, (a, b) => (a > b ? a : b)),
    pminub: lanes(u8, 8, (a, b) => (a < b ? a : b)), pmaxub: lanes(u8, 8, (a, b) => (a > b ? a : b)),
    pavgb: lanes(u8, 8, (a, b) => (a + b + 1) >> 1), pavgw: lanes(u16, 4, (a, b) => (a + b + 1) >> 1),
    psadbw: (d, s) => {
      let sum = 0;
      for (let k = 0; k < 8; k++) sum += Math.abs(u8[d * 8 + k] - u8[s * 8 + k]);
      u32[d * 2] = sum; u32[d * 2 + 1] = 0;
    },
    pshufw: (d, s, imm) => { for (let k = 0; k < 4; k++) Tu16[k] = u16[s * 4 + ((imm >> (2 * k)) & 3)]; keep(d); },
    pinsrw: (d, v, imm) => { u16[d * 4 + (imm & 3)] = v; },
    pextrw: (s, imm) => u16[s * 4 + (imm & 3)],
    pmovmskb: (s) => { let m = 0; for (let k = 0; k < 8; k++) m |= (u8[s * 8 + k] >> 7) << k; return m; },
  };
  X.f = makeX87(Pf32, Pf64, Pu32, Pu16);
  return X;
}

/** The unbiased binary exponent of a finite nonzero double, as the x87 sees it. */
function exponent(v) {
  let e = Math.floor(Math.log2(Math.abs(v)));
  if (2 ** e > Math.abs(v)) e--; else if (2 ** (e + 1) <= Math.abs(v)) e++;
  return e;
}

const PARITY = new Uint8Array(256).map((_, b) => { let p = b; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1; return (p & 1) ^ 1; });

/*
 * THE x87, as Visual C++ programs drive it: eight registers as a stack, a control word and a status
 * word, the machine's (a program sets its precision once -- .kkrieger's sFloatFix -- and every
 * function after it computes under it).
 *
 * A register holds a JavaScript double, not the 80-bit extended format. That is exact for what a
 * period program means by its control word: Visual C++'s runtime starts the FPU at 0x027F, PRECISION
 * 53 BITS, where an add, a multiply or a square root rounds to exactly what IEEE double gives, and
 * .kkrieger lowers it to 24 bits, where the double result rounded to single is again exact (53 >= 2
 * x 24 + 2). What a double cannot be is the 64-bit precision (PC = 3) and the extended exponent range
 * beyond a double's: under those this is an approximation, as MIRAGE's x87 is.
 *
 * PRECISION CONTROL IS APPLIED WHERE INTEL APPLIES IT: the results of add, subtract, multiply, divide
 * and square root -- not of a load, a transcendental, fscale, fprem or frndint (SDM vol. 1, 8.1.5.2).
 * The transcendentals are computed in double: their last bit can differ from a Pentium's, whose own
 * results were never correctly rounded either.
 *
 * Stack faults are the masked response the default control word asks for: a push onto a full
 * register or a read of an empty one gives the QNaN indefinite and sets C1 for an overflow.
 */
function makeX87(f32, f64, w32, w16) {
  const st = new Float64Array(8), empty = new Uint8Array(8).fill(1);
  // The QNaN indefinite is NEGATIVE; a NaN JavaScript makes (0/0, Math.sqrt(-1)) is positive.
  const INDEF = (() => { f64[0] = 0; w32[1] = 0xfff80000; return f64[0]; })();
  const F = {
    st, empty, top: 0, cw: 0x027f, sw: 0,
    /** C0..C3 as the status word holds them: bits 8, 9, 10, 14. */
    setC(c0, c1, c2, c3) { F.sw = (F.sw & ~0x4700) | (c0 << 8) | (c1 << 9) | (c2 << 10) | (c3 << 14); },
    status() { return (F.sw & ~0x3800) | (F.top << 11); },
    /** A quotient; a finite nonzero dividend over zero raises ZE (the status word reports it). */
    dv(a, b) { if (b === 0 && a === a && a !== 0 && Number.isFinite(a)) F.sw |= 4; return a / b; },
    /** The result of an arithmetic operation, rounded to the precision control's width. */
    r(v) { return ((F.cw >> 8) & 3) === 0 ? sig24(v) : v; },
    /** A result made a NaN from operands that were not: the indefinite. A NaN operand propagates as is. */
    g(v, a, b = 0) { return v === v || a !== a || b !== b ? v : INDEF; },
    get(i) { const k = (F.top + i) & 7; if (empty[k]) { F.sw |= 0x41; return INDEF; } return st[k]; },
    set(i, v) { const k = (F.top + i) & 7; st[k] = v; empty[k] = 0; },
    push(v) {
      F.top = (F.top - 1) & 7;
      if (!empty[F.top]) { F.sw |= 0x241; st[F.top] = INDEF; return; }
      st[F.top] = v; empty[F.top] = 0;
    },
    pop() { const v = F.get(0); empty[F.top] = 1; F.top = (F.top + 1) & 7; return v; },
    free(i) { empty[(F.top + i) & 7] = 1; },
    init() { F.top = 0; empty.fill(1); F.cw = 0x037f; F.sw = 0; },
    clex() { F.sw &= 0x7f00; },
    emms() { empty.fill(1); },
    xch(i) { const a = F.get(0), b = F.get(i); F.set(0, b); F.set(i, a); },

    // The memory formats, from and to the bits the emitter moved through its own memory path.
    fromF32(b) { w32[0] = b; return f32[0]; },
    fromF64(lo, hi) { w32[0] = lo; w32[1] = hi; return f64[0]; },
    /** An 80-bit extended value: the significand's two halves and the sign-and-exponent word. */
    fromF80(lo, hi, se) {
      // The halves arrive as the emitter loaded them, which may be signed.
      lo >>>= 0; hi >>>= 0;
      const e = se & 0x7fff, s = se & 0x8000 ? -1 : 1;
      const m = hi * 4294967296 + lo;                          // rounded to a double's 53 bits
      if (e === 0) return s * m * 2 ** (-16382 - 63);
      if (e === 0x7fff) return (hi & 0x7fffffff) || lo ? NaN : s * Infinity;
      return s * m * 2 ** (e - 16383 - 63);
    },
    // A NaN is stored as the QNaN indefinite, NEGATIVE, which is the only NaN this model makes; a
    // JavaScript NaN would store the positive one.
    // A NaN keeps its sign (fchs flips the indefinite's) but not its payload: it is stored quiet, bare.
    toF32(v) { if (v !== v) { f64[0] = v; return w32[1] & 0x80000000 ? 0xffc00000 : 0x7fc00000; } f32[0] = F.round32(v); return w32[0]; },
    toF64lo(v) { if (v !== v) return 0; f64[0] = v; return w32[0]; },
    toF64hi(v) { if (v !== v) { f64[0] = v; return w32[1] & 0x80000000 ? 0xfff80000 : 0x7ff80000; } f64[0] = v; return w32[1]; },
    /** The three words of an 80-bit extended value, [lo, hi, se]: a double fits exactly. */
    toF80(v) {
      if (v === 0) return [0, 0, Object.is(v, -0) ? 0x8000 : 0];
      if (Number.isNaN(v)) { f64[0] = v; return [0, 0xc0000000, w32[1] & 0x80000000 ? 0xffff : 0x7fff]; }
      if (!Number.isFinite(v)) return [0, 0x80000000, v < 0 ? 0xffff : 0x7fff];
      const s = v < 0 ? 0x8000 : 0;
      let a = Math.abs(v), e = Math.floor(Math.log2(a));
      if (2 ** e > a) e--; else if (2 ** (e + 1) <= a) e++;
      const m = a / 2 ** (e - 63);                            // in [2^63, 2^64), exact
      const hi = Math.floor(m / 4294967296), lo = m - hi * 4294967296;
      return [lo >>> 0, hi >>> 0, s | (e + 16383)];
    },

    /** A float store, rounded by the rounding control. */
    round32(v) {
      const f = Math.fround(v), rc = (F.cw >> 10) & 3;
      if (rc === 0 || f === v || !Number.isFinite(v)) return f;
      f32[0] = f;
      const step = (d) => { w32[0] += (f > 0) === (d > 0) ? 1 : -1; return f32[0]; };
      if (rc === 1 && f > v) return f === 0 ? -1.401298464324817e-45 : step(-1);
      if (rc === 2 && f < v) return f === 0 ? 1.401298464324817e-45 : step(1);
      if (rc === 3 && Math.abs(f) > Math.abs(v)) return step(f > 0 ? -1 : 1);
      return f;
    },
    /** To an integer by the rounding control, as frndint and fist do. */
    rint(v) {
      if (!Number.isFinite(v)) return v;
      switch ((F.cw >> 10) & 3) {
        case 0: { const r = Math.round(v); return (r - v === 0.5 && r % 2 !== 0) ? r - 1 : r; }
        case 1: return Math.floor(v);
        case 2: return Math.ceil(v);
        default: return Math.trunc(v);
      }
    },
    /** fist of `bytes`: the integer, or the integer indefinite (the invalid exception, masked). */
    ist(v, bytes) {
      const r = F.rint(v), lim = bytes === 2 ? 32768 : 2147483648;
      if (Number.isNaN(r) || r < -lim || r >= lim) { F.sw |= 1; return bytes === 2 ? 0x8000 : 0x80000000; }
      return r;
    },
    /** fistp of eight bytes, as [lo, hi]. */
    ist64(v) {
      const r = F.rint(v);
      if (Number.isNaN(r) || r < -(2 ** 63) || r >= 2 ** 63) { F.sw |= 1; return [0, 0x80000000]; }
      const b = BigInt.asUintN(64, BigInt(r));
      return [Number(b & 0xffffffffn), Number(b >> 32n)];
    },
    /** fcom, fucom and ftst: C3 C2 C0 = 000 above, 001 below, 100 equal, 111 unordered. */
    com(a, b) {
      if (Number.isNaN(a) || Number.isNaN(b)) F.setC(1, 0, 1, 1);
      else F.setC(a < b ? 1 : 0, 0, 0, a === b ? 1 : 0);
    },
    /**
     * fprem: the remainder of a TRUNCATED quotient, exact (JavaScript's % is that operation), its
     * three low quotient bits in C0 C3 C1. When the exponents are 64 or more apart the x87 reduces
     * only PARTLY and sets C2, and a program loops on it (fstsw; sahf; jp): the exponent drops by
     * D - N with N in 32..63 implementation-dependent -- the SDM's pseudo-code, with N = 32 + D % 32.
     */
    prem() {
      const a = F.get(0), b = F.get(1);
      if (a !== a || b !== b) { F.set(0, a !== a ? a : b); F.setC(0, 0, 0, 0); return; }
      if (!Number.isFinite(a) || b === 0) { F.set(0, INDEF); F.setC(0, 0, 0, 0); F.sw |= 1; return; }
      if (!Number.isFinite(b) || a === 0) { F.setC(0, 0, 0, 0); return; }
      const D = exponent(a) - exponent(b);
      if (D >= 64) {
        const N = 32 + (D % 32);
        F.set(0, a % (b * 2 ** (D - N)));
        F.setC((F.sw >> 8) & 1, (F.sw >> 9) & 1, 1, (F.sw >> 14) & 1);
        return;
      }
      const r = a % b;
      // The quotient's three low bits, exactly even past 2^53: the remainder modulo 8b, in units of b.
      const q = Math.abs(Math.round((a % (8 * b) - r) / b));
      F.set(0, r);
      F.setC(Math.floor(q / 4) % 2, q % 2, 0, Math.floor(q / 2) % 2);
    },
    /** fscale: ST(0) times two to the power of ST(1) truncated. */
    scale() { const n = Math.trunc(F.get(1)); F.set(0, F.get(0) * 2 ** n); },
    /** fxtract would go here; nothing uses it. fsin, fcos, fsincos, fptan leave operands past 2^63 alone, C2 set. */
    trig(f) {
      const a = F.get(0);
      if (Math.abs(a) >= 2 ** 63) { F.setC(0, 0, 1, 0); return false; }
      F.setC((F.sw >> 8) & 1, 0, 0, (F.sw >> 14) & 1);
      f(a);
      return true;
    },
  };
  return F;
}

/** The MMX operations taking (d, s): everything in makeX86() a two-register instruction names. */
export const MMX_BINARY = new Set(['paddb', 'paddw', 'paddd', 'paddsb', 'paddsw', 'paddusb', 'paddusw', 'psubb', 'psubw',
  'psubd', 'psubsb', 'psubsw', 'psubusb', 'psubusw', 'pmullw', 'pmulhw', 'pmulhuw', 'pmaddwd', 'pand', 'por', 'pxor',
  'pandn', 'pcmpeqb', 'pcmpeqw', 'pcmpeqd', 'pcmpgtb', 'pcmpgtw', 'pcmpgtd', 'punpcklbw', 'punpcklwd', 'punpckldq',
  'punpckhbw', 'punpckhwd', 'punpckhdq', 'packsswb', 'packuswb', 'packssdw', 'pminsw', 'pmaxsw', 'pminub', 'pmaxub',
  'pavgb', 'pavgw', 'psadbw']);
/** The MMX shifts: by a register or by an immediate. */
export const MMX_SHIFT = new Set(['psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad']);
