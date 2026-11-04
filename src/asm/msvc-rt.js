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

  const X = {
    buf, u8, u16, i16, u32, i32,
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
  return X;
}

/** The MMX operations taking (d, s): everything in makeX86() a two-register instruction names. */
export const MMX_BINARY = new Set(['paddb', 'paddw', 'paddd', 'paddsb', 'paddsw', 'paddusb', 'paddusw', 'psubb', 'psubw',
  'psubd', 'psubsb', 'psubsw', 'psubusb', 'psubusw', 'pmullw', 'pmulhw', 'pmulhuw', 'pmaddwd', 'pand', 'por', 'pxor',
  'pandn', 'pcmpeqb', 'pcmpeqw', 'pcmpeqd', 'pcmpgtb', 'pcmpgtw', 'pcmpgtd', 'punpcklbw', 'punpcklwd', 'punpckldq',
  'punpckhbw', 'punpckhwd', 'punpckhdq', 'packsswb', 'packuswb', 'packssdw', 'pminsw', 'pmaxsw', 'pminub', 'pmaxub',
  'pavgb', 'pavgw', 'psadbw']);
/** The MMX shifts: by a register or by an immediate. */
export const MMX_SHIFT = new Set(['psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad']);
