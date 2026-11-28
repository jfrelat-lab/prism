// sse.js — the XMM register file and the SSE/SSE2/SSE4.1 operations MIRAGE implements.
//
// Scope is deliberately the set real DOS software reaches for, not the whole ISA: Chrome Revenge
// (Abaddon, 1K, Assembly 2020) is an SSE raytracer that draws in VESA 640x480x32, and its published
// source names exactly sixteen XMM instructions. Everything here was transcribed from that list and
// from the Intel semantics for each opcode — not guessed from the mnemonic.
//
// One ArrayBuffer, three views. A lane is (reg * 4 + i): `f` reads it as float32, `i` as int32, `u8`
// as bytes. Slot 8 is a scratch register the recompiler loads a memory operand into, so every
// operation below sees two REGISTERS and never has to care where its source came from.

export const XMM_SCRATCH = 8;                 // one past the eight architectural registers

// Operation codes. The recompiler bakes these in as constants, so the switch below is the only
// place the encoding-to-semantics mapping lives.
export const SSE = {
  MOVAPS_LD: 0, MOVAPS_ST: 1, MOVSS_LD: 2, MOVSS_LD_M: 3, MOVSS_ST: 4,
  ADDPS: 5, SUBPS: 6, MULPS: 7, XORPS: 8, RSQRTPS: 9, SHUFPS: 10,
  CVTDQ2PS: 11, CVTPS2DQ: 12, PCMPEQD: 13, PACKUSWB: 14, PACKSSDW: 15, PAVGB: 16,
  PMOVSXWD: 17, PMOVZXBD: 18, INSERTPS: 19, DPPS: 20,
  // The rest of SSE and the SSE2 a compiler of 2005-2010 emits for floating point (MSVC's /arch:SSE
  // and /arch:SSE2): scalar and packed arithmetic in single and double precision, the logic, the
  // half-register moves and unpacks, conversions, compares, and SSE2's integer basics on XMM.
  ADDSS: 21, SUBSS: 22, MULSS: 23, DIVSS: 24, MINSS: 25, MAXSS: 26, SQRTSS: 27, RCPSS: 28, RSQRTSS: 29,
  DIVPS: 30, MINPS: 31, MAXPS: 32, SQRTPS: 33, RCPPS: 34, ANDPS: 35, ANDNPS: 36, ORPS: 37,
  ADDSD: 38, SUBSD: 39, MULSD: 40, DIVSD: 41, MINSD: 42, MAXSD: 43, SQRTSD: 44,
  ADDPD: 45, SUBPD: 46, MULPD: 47, DIVPD: 48, MINPD: 49, MAXPD: 50, SQRTPD: 51,
  MOVSD_LD: 52, MOVSD_LD_M: 53, MOVLO: 54, MOVHI: 55, MOVHLPS: 56, MOVLHPS: 57, HI2LO: 58, MOVQ_LD: 59,
  UNPCKLPS: 60, UNPCKHPS: 61, UNPCKLPD: 62, UNPCKHPD: 63, SHUFPD: 64,
  CVTSS2SD: 65, CVTSD2SS: 66, CVTPS2PD: 67, CVTPD2PS: 68, CVTTPS2DQ: 69, CVTDQ2PD: 70, CVTTPD2DQ: 71,
  CMPPS: 72, CMPSS: 73, CMPPD: 74, CMPSD: 75,
  PAND: 76, PANDN: 77, POR: 78, PADDD: 79, PSUBD: 80, PADDQ: 81, PSUBQ: 82, PSHUFD: 83,
  PSLLD: 84, PSRLD: 85, PSRAD: 86, PSLLQ: 87, PSRLQ: 88, PSLLDQ: 89, PSRLDQ: 90,
  PUNPCKLDQ: 91, PUNPCKHDQ: 92, PUNPCKLQDQ: 93, PUNPCKHQDQ: 94, PCMPGTD: 95, PADDW: 96, PSUBW: 97,
  PMULLW: 98, PUNPCKLBW: 99, PUNPCKLWD: 100, PSRAW: 101, PSRLW: 102, PSLLW: 103, PMULUDQ: 104,
  // SSE2 bytes and words: the C runtime's string functions (strchr, strlen, memchr of Visual C++ 2015+).
  PCMPEQB: 105, PCMPEQW: 106, PCMPGTB: 107, PCMPGTW: 108, PMINUB: 109, PMAXUB: 110, PADDB: 111, PSUBB: 112, PUNPCKHBW: 113, PUNPCKHWD: 114,
};

/**
 * The operations whose register and memory forms are the same, by mandatory prefix ('' none, '66',
 * 'F3', 'F2') and second opcode byte: [operation, bytes of a memory source, 1 when an imm8 follows].
 * The recompiler (decode0F) looks here first; moves and stores whose forms differ are its own.
 */
const SS = 4, SD = 8, X = 16;
export const SSE_TABLE = {
  // SSE: packed single not already above, and the scalar forms (F3)
  14: [SSE.UNPCKLPS, X], 15: [SSE.UNPCKHPS, X], 51: [SSE.SQRTPS, X], 53: [SSE.RCPPS, X], 54: [SSE.ANDPS, X], 55: [SSE.ANDNPS, X],
  56: [SSE.ORPS, X], '5a': [SSE.CVTPS2PD, SD], '5d': [SSE.MINPS, X], '5e': [SSE.DIVPS, X], '5f': [SSE.MAXPS, X], c2: [SSE.CMPPS, X, 1],
  F351: [SSE.SQRTSS, SS], F352: [SSE.RSQRTSS, SS], F353: [SSE.RCPSS, SS], F358: [SSE.ADDSS, SS], F359: [SSE.MULSS, SS], F35c: [SSE.SUBSS, SS],
  F35d: [SSE.MINSS, SS], F35e: [SSE.DIVSS, SS], F35f: [SSE.MAXSS, SS], F35a: [SSE.CVTSS2SD, SS], F35b: [SSE.CVTTPS2DQ, X], F3e6: [SSE.CVTDQ2PD, SD],
  F3c2: [SSE.CMPSS, SS, 1],
  // SSE2: double precision, packed (66) and scalar (F2)
  F251: [SSE.SQRTSD, SD], F258: [SSE.ADDSD, SD], F259: [SSE.MULSD, SD], F25c: [SSE.SUBSD, SD], F25d: [SSE.MINSD, SD], F25e: [SSE.DIVSD, SD],
  F25f: [SSE.MAXSD, SD], F25a: [SSE.CVTSD2SS, SD], F2c2: [SSE.CMPSD, SD, 1],
  6614: [SSE.UNPCKLPD, X], 6615: [SSE.UNPCKHPD, X], 6651: [SSE.SQRTPD, X], 6654: [SSE.ANDPS, X], 6655: [SSE.ANDNPS, X], 6656: [SSE.ORPS, X],
  6657: [SSE.XORPS, X], 6658: [SSE.ADDPD, X], 6659: [SSE.MULPD, X], '665a': [SSE.CVTPD2PS, X], '665c': [SSE.SUBPD, X], '665d': [SSE.MINPD, X],
  '665e': [SSE.DIVPD, X], '665f': [SSE.MAXPD, X], '66c2': [SSE.CMPPD, X, 1], '66c6': [SSE.SHUFPD, X, 1], '66e6': [SSE.CVTTPD2DQ, X],
  // SSE2: integers on XMM
  '66db': [SSE.PAND, X], '66df': [SSE.PANDN, X], '66eb': [SSE.POR, X], '66ef': [SSE.XORPS, X], '66fe': [SSE.PADDD, X], '66fa': [SSE.PSUBD, X],
  '66d4': [SSE.PADDQ, X], '66fb': [SSE.PSUBQ, X], '66fd': [SSE.PADDW, X], '66f9': [SSE.PSUBW, X], '66d5': [SSE.PMULLW, X], 6666: [SSE.PCMPGTD, X],
  '6674': [SSE.PCMPEQB, X], '6675': [SSE.PCMPEQW, X], '6664': [SSE.PCMPGTB, X], '6665': [SSE.PCMPGTW, X], '66da': [SSE.PMINUB, X],
  '66de': [SSE.PMAXUB, X], '66fc': [SSE.PADDB, X], '66f8': [SSE.PSUBB, X], '6668': [SSE.PUNPCKHBW, X], '6669': [SSE.PUNPCKHWD, X],
  '66f4': [SSE.PMULUDQ, X], 6660: [SSE.PUNPCKLBW, X], 6661: [SSE.PUNPCKLWD, X], 6662: [SSE.PUNPCKLDQ, X], '666a': [SSE.PUNPCKHDQ, X],
  '666c': [SSE.PUNPCKLQDQ, X], '666d': [SSE.PUNPCKHQDQ, X], 6670: [SSE.PSHUFD, X, 1],
  '66d1': [SSE.PSRLW, X], '66d2': [SSE.PSRLD, X], '66d3': [SSE.PSRLQ, X], '66e1': [SSE.PSRAW, X], '66e2': [SSE.PSRAD, X],
  '66f1': [SSE.PSLLW, X], '66f2': [SSE.PSLLD, X], '66f3': [SSE.PSLLQ, X],
};

// VEX-encoded operations (AVX, AVX2): the Linux sizecoding intros of the 2020s reach for a handful —
// Outline 2021-2023's 256-byte intros by The Orz (VPADDUSB, VPSHUFD, VMOVD, VPSRAVD, VPMOVZXBD, VMOVDQU
// on YMM). The YMM registers are the XMM ones and an upper half each (cpu.ymmHi): a legacy SSE
// operation leaves that half alone, a VEX.128 one zeroes it, a VEX.256 one works on all 32 bytes.
export const VEX = {
  MOVDQU_LD: 0, PMOVZXBD: 1, PSRAVD: 2, PADDUSB: 3, MOVD_LD: 4, PSHUFD: 5, PBROADCASTB: 6, BROADCASTSS: 7,
};

const sat8u = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const sat16s = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);

export function installSSE(cpu) {
  const buf = new ArrayBuffer(16 * 9);        // 8 architectural registers + the scratch slot
  const f = new Float32Array(buf);
  const i32 = new Int32Array(buf);
  const u8 = new Uint8Array(buf);
  const d64 = new Float64Array(buf), u16 = new Uint16Array(buf), i16 = new Int16Array(buf), u32 = new Uint32Array(buf);
  // What SSE adds lives on cpu.xmm, not on the CPU object: its shape is what every recompiled block's
  // cpu.* reads go through, and three more properties on it cost Chrome Revenge 1.5%.
  const X = cpu.xmm = { buf, f, i32, u8, d: d64, mxcsr: 0x1f80, comi: null, op: null };   // MXCSR: every exception masked, round to nearest
  /** A conversion to an integer as MXCSR's rounding control says (bits 13-14): to nearest even, down, up, toward
   *  zero. Unreal Tournament's Pentium III code sets it so and converts with CVTPS2PI. */
  X.round = (v) => {
    switch ((X.mxcsr >> 13) & 3) {
      case 1: return Math.floor(v);
      case 2: return Math.ceil(v);
      case 3: return Math.trunc(v);
      default: { let t = Math.floor(v); if (v - t > 0.5 || (v - t === 0.5 && (t % 2) !== 0)) t++; return t; }
    }
  };
  const T = new Int32Array(4), Tf = new Float32Array(T.buffer), Td = new Float64Array(T.buffer);
  // MINSS/MAXSS and their kin return the SOURCE when the comparison is false — either operand a NaN,
  // or both zeros of either sign (Intel's pseudocode: DEST := (DEST < SRC) ? DEST : SRC).
  // The bits are copied, not the value: a NaN written through the float view would lose its own.
  const minS = (i, j) => { if (!(f[i] < f[j])) i32[i] = i32[j]; }, maxS = (i, j) => { if (!(f[i] > f[j])) i32[i] = i32[j]; };
  const minD = (i, j) => { if (!(d64[i] < d64[j])) { i32[2 * i] = i32[2 * j]; i32[2 * i + 1] = i32[2 * j + 1]; } };
  const maxD = (i, j) => { if (!(d64[i] > d64[j])) { i32[2 * i] = i32[2 * j]; i32[2 * i + 1] = i32[2 * j + 1]; } };
  // CMPPS's eight predicates: EQ, LT, LE, UNORD, NEQ, NLT, NLE, ORD.
  const cmp = (a, b, p) => { switch (p & 7) { case 0: return a === b; case 1: return a < b; case 2: return a <= b;
    case 3: return a !== a || b !== b; case 4: return !(a === b); case 5: return !(a < b); case 6: return !(a <= b); default: return a === a && b === b; } };
  // A NaN result as the processor makes it: the first operand's NaN made quiet, else the second's,
  // else (an invalid operation: 0 * inf, sqrt of a negative) the default NaN, negative -- JavaScript
  // would hand back its own canonical one. `i`, `j`: float lanes (bs) or double lanes (bd); the
  // operands' bits are read before the result is written, so d and s may be the same register.
  // ps(i, j, r): lane i takes r, computed from lanes i and j, which are still unwritten when r is NaN.
  const nanS = (i, j) => { i32[i] = f[i] !== f[i] ? i32[i] | 0x400000 : f[j] !== f[j] ? i32[j] | 0x400000 : 0xffc00000 | 0; };
  const ps = (i, j, r) => { if (r === r) f[i] = r; else nanS(i, j); };
  const bs = (i, j, fn) => ps(i, j, fn(f[i], f[j]));
  const us = (i, j, fn) => { const y = f[j], yi = i32[j], r = fn(y); if (r === r) f[i] = r; else i32[i] = y !== y ? yi | 0x400000 : 0xffc00000 | 0; };
  const bd = (i, j, fn) => {
    const x = d64[i], y = d64[j], xl = i32[2 * i], xh = i32[2 * i + 1], yl = i32[2 * j], yh = i32[2 * j + 1], r = fn(x, y);
    if (r === r) d64[i] = r;
    else if (x !== x) { i32[2 * i] = xl; i32[2 * i + 1] = xh | 0x80000; }
    else if (y !== y) { i32[2 * i] = yl; i32[2 * i + 1] = yh | 0x80000; }
    else { i32[2 * i] = 0; i32[2 * i + 1] = 0xfff80000 | 0; }
  };
  const ud = (i, j, fn) => {
    const y = d64[j], yl = i32[2 * j], yh = i32[2 * j + 1], r = fn(y);
    if (r === r) d64[i] = r; else if (y !== y) { i32[2 * i] = yl; i32[2 * i + 1] = yh | 0x80000; } else { i32[2 * i] = 0; i32[2 * i + 1] = 0xfff80000 | 0; }
  };
  const add = (a, b) => a + b, sub = (a, b) => a - b, mul = (a, b) => a * b, div = (a, b) => a / b, sqrt = Math.sqrt, rcp = (a) => 1 / a;
  const rsq = (a) => 1 / Math.fround(Math.sqrt(a));
  // Float to int32 conversions: out of range or NaN give 80000000h, the integer indefinite.
  const toI32 = (v) => (v !== v || v >= 2147483648 || v < -2147483648 ? -2147483648 : v | 0);
  /** COMISS/UCOMISS/COMISD/UCOMISD: ZF, PF, CF as the comparison of the low lanes says (all three
   *  when unordered); OF, SF, AF cleared. Returns the flags to OR in after clearing 0x8d5. */
  X.comi = (d, s, dbl) => {
    const a = dbl ? d64[d * 2] : f[d * 4], b = dbl ? d64[s * 2] : f[s * 4];
    return a !== a || b !== b ? 0x45 : a < b ? 0x01 : a === b ? 0x40 : 0;
  };

  /** Load 16 bytes of guest memory into the scratch register. `len` lets MOVSS/PMOVZXBD read less
   *  without touching memory they are not entitled to — a 4-byte read at the end of a segment must
   *  not fault on the 16 bytes an unconditional load would take. */
  cpu.xmmLoad = (lin, len) => {
    const m = cpu.mem, base = XMM_SCRATCH * 16;
    for (let k = 0; k < 16; k++) u8[base + k] = k < len ? m.r8((lin + k) >>> 0) : 0;
  };
  cpu.xmmStore = (lin, reg, len) => {
    const m = cpu.mem, base = reg * 16;
    for (let k = 0; k < len; k++) m.w8((lin + k) >>> 0, u8[base + k]);
  };

  // ---- VEX: the YMM upper halves and the operations on them ----
  const hi = new Uint8Array(16 * 9);
  cpu.ymmHi = hi;
  const Y = new Uint8Array(32), Yv = new Uint8Array(32), Ys = new Uint8Array(32);   // working copies
  const yI = new Int32Array(Y.buffer), yvI = new Int32Array(Yv.buffer), ysI = new Int32Array(Ys.buffer);
  const get = (reg, to) => { to.set(u8.subarray(reg * 16, reg * 16 + 16), 0); to.set(hi.subarray(reg * 16, reg * 16 + 16), 16); };
  /** Up to 32 bytes of guest memory into the scratch register (low half, then upper). */
  cpu.vexLoad = (lin, len) => {
    const m = cpu.mem, b = XMM_SCRATCH * 16;
    for (let k = 0; k < 32; k++) { const v = k < len ? m.r8((lin + k) >>> 0) : 0; if (k < 16) u8[b + k] = v; else hi[b + k - 16] = v; }
  };
  cpu.vexStore = (lin, reg, len) => {
    const m = cpu.mem, b = reg * 16;
    for (let k = 0; k < len; k++) m.w8((lin + k) >>> 0, k < 16 ? u8[b + k] : hi[b + k - 16]);
  };
  /** One VEX operation: `L` 0 for 128 bits (the upper half zeroed), 1 for 256; `d` the destination,
   *  `v` the first source (VEX.vvvv), `s` the second (ModRM.rm, or the scratch slot), `imm` its byte. */
  cpu.vex = (code, L, d, v, s, imm) => {
    get(v, Yv); get(s, Ys); Y.fill(0);
    const n = L ? 32 : 16;
    switch (code) {
      case VEX.MOVDQU_LD: Y.set(Ys.subarray(0, n)); break;
      case VEX.PMOVZXBD: for (let k = 0; k < n / 4; k++) yI[k] = Ys[k]; break;          // bytes to dwords, zero-extended
      // Each dword shifted right arithmetically by its own count; 32 or more fills it with its sign.
      case VEX.PSRAVD: for (let k = 0; k < n / 4; k++) { const c = ysI[k] >>> 0; yI[k] = yvI[k] >> (c > 31 ? 31 : c); } break;
      case VEX.PADDUSB: for (let k = 0; k < n; k++) Y[k] = sat8u(Yv[k] + Ys[k]); break;
      case VEX.MOVD_LD: yI[0] = imm | 0; break;                                            // the dword comes as `imm`
      // Within each 128-bit lane, dword k takes the source's dword (imm >> 2k) & 3 of that lane.
      case VEX.PSHUFD: for (let k = 0; k < n / 4; k++) yI[k] = ysI[(k & ~3) + ((imm >> ((k & 3) * 2)) & 3)]; break;
      case VEX.PBROADCASTB: Y.fill(Ys[0], 0, n); break;
      case VEX.BROADCASTSS: for (let k = 0; k < n / 4; k++) yI[k] = ysI[0]; break;          // the source's low dword everywhere                                   // the source's low byte everywhere
      default: throw new Error(`mirage: VEX operation ${code} not implemented`);
    }
    u8.set(Y.subarray(0, 16), d * 16); hi.set(Y.subarray(16, 32), d * 16);
  };

  /** Every operation, on two register slots. `d` and `s` are register indices; `imm` is the
   *  immediate byte for the three instructions that take one. */
  cpu.sse = (code, d, s, imm) => {
    const D = d * 4, S = s * 4;
    switch (code) {
      case SSE.MOVAPS_LD: case SSE.MOVAPS_ST:
        i32[D] = i32[S]; i32[D + 1] = i32[S + 1]; i32[D + 2] = i32[S + 2]; i32[D + 3] = i32[S + 3]; return;
      // Register form keeps the upper three lanes; the memory form zeroes them. Two codes, because
      // by the time we are here the operand has already become a register either way.
      case SSE.MOVSS_LD: i32[D] = i32[S]; return;
      case SSE.MOVSS_LD_M: i32[D] = i32[S]; i32[D + 1] = 0; i32[D + 2] = 0; i32[D + 3] = 0; return;
      case SSE.MOVSS_ST: i32[D] = i32[S]; return;
      // A NaN in any lane takes the slow way (ps), which writes the processor's NaN.
      case SSE.ADDPS: { const r0 = f[D] + f[S], r1 = f[D + 1] + f[S + 1], r2 = f[D + 2] + f[S + 2], r3 = f[D + 3] + f[S + 3];
        if (r0 === r0 && r1 === r1 && r2 === r2 && r3 === r3) { f[D] = r0; f[D + 1] = r1; f[D + 2] = r2; f[D + 3] = r3; }
        else { ps(D, S, r0); ps(D + 1, S + 1, r1); ps(D + 2, S + 2, r2); ps(D + 3, S + 3, r3); } return; }
      case SSE.SUBPS: { const r0 = f[D] - f[S], r1 = f[D + 1] - f[S + 1], r2 = f[D + 2] - f[S + 2], r3 = f[D + 3] - f[S + 3];
        if (r0 === r0 && r1 === r1 && r2 === r2 && r3 === r3) { f[D] = r0; f[D + 1] = r1; f[D + 2] = r2; f[D + 3] = r3; }
        else { ps(D, S, r0); ps(D + 1, S + 1, r1); ps(D + 2, S + 2, r2); ps(D + 3, S + 3, r3); } return; }
      case SSE.MULPS: { const r0 = f[D] * f[S], r1 = f[D + 1] * f[S + 1], r2 = f[D + 2] * f[S + 2], r3 = f[D + 3] * f[S + 3];
        if (r0 === r0 && r1 === r1 && r2 === r2 && r3 === r3) { f[D] = r0; f[D + 1] = r1; f[D + 2] = r2; f[D + 3] = r3; }
        else { ps(D, S, r0); ps(D + 1, S + 1, r1); ps(D + 2, S + 2, r2); ps(D + 3, S + 3, r3); } return; }
      case SSE.XORPS: for (let k = 0; k < 4; k++) i32[D + k] ^= i32[S + k]; return;
      // Silicon gives a 12-bit approximation (relative error < 1.5*2^-12) and any result inside that
      // band is architecturally legal, so there is no single right answer here. We match the ORACLE
      // we check against — QEMU computes float32(1 / float32(sqrt x)), rounding the square root to
      // single precision BEFORE the divide. Rounding only at the end differs by an ulp, which is how
      // this arm came to exist.
      case SSE.RSQRTPS: for (let k = 0; k < 4; k++) f[D + k] = Math.fround(1 / Math.fround(Math.sqrt(f[S + k]))); return;
      case SSE.SHUFPS: {
        const a0 = f[D + (imm & 3)], a1 = f[D + ((imm >> 2) & 3)];
        const b0 = f[S + ((imm >> 4) & 3)], b1 = f[S + ((imm >> 6) & 3)];
        f[D] = a0; f[D + 1] = a1; f[D + 2] = b0; f[D + 3] = b1; return;   // low two from dst, high two from src
      }
      case SSE.CVTDQ2PS: for (let k = 0; k < 4; k++) f[D + k] = Math.fround(i32[S + k]); return;
      // Round to nearest, ties to even — the default MXCSR rounding mode, which nothing here changes.
      case SSE.CVTPS2DQ: for (let k = 0; k < 4; k++) {
        const v = f[S + k], r = Math.round(v);
        i32[D + k] = (Math.abs(v - Math.trunc(v)) === 0.5 && (r & 1)) ? r - Math.sign(v) : r;
      } return;
      case SSE.PCMPEQD: for (let k = 0; k < 4; k++) i32[D + k] = i32[D + k] === i32[S + k] ? -1 : 0; return;
      // Pack with saturation: the destination's own halves come first, then the source's.
      case SSE.PACKUSWB: {
        const t = new Uint8Array(16);
        for (let k = 0; k < 8; k++) t[k] = sat8u((i32[D + (k >> 1)] << (k & 1 ? 0 : 16)) >> 16);
        for (let k = 0; k < 8; k++) t[8 + k] = sat8u((i32[S + (k >> 1)] << (k & 1 ? 0 : 16)) >> 16);
        for (let k = 0; k < 16; k++) u8[D * 4 + k] = t[k];
        return;
      }
      case SSE.PACKSSDW: {
        const w = [sat16s(i32[D]), sat16s(i32[D + 1]), sat16s(i32[D + 2]), sat16s(i32[D + 3]),
                   sat16s(i32[S]), sat16s(i32[S + 1]), sat16s(i32[S + 2]), sat16s(i32[S + 3])];
        for (let k = 0; k < 4; k++) i32[D + k] = ((w[k * 2 + 1] & 0xffff) << 16) | (w[k * 2] & 0xffff);
        return;
      }
      case SSE.PAVGB: for (let k = 0; k < 16; k++) u8[D * 4 + k] = (u8[D * 4 + k] + u8[S * 4 + k] + 1) >> 1; return;
      // The sign/zero-extending moves read only the LOW half (PMOVSXWD) or quarter (PMOVZXBD) of the
      // source, so they must be evaluated before the destination is written — same register is legal.
      case SSE.PMOVSXWD: {
        const w = [i32[S] << 16 >> 16, i32[S] >> 16, i32[S + 1] << 16 >> 16, i32[S + 1] >> 16];
        for (let k = 0; k < 4; k++) i32[D + k] = w[k];
        return;
      }
      case SSE.PMOVZXBD: {
        const b = [u8[S * 4], u8[S * 4 + 1], u8[S * 4 + 2], u8[S * 4 + 3]];
        for (let k = 0; k < 4; k++) i32[D + k] = b[k];
        return;
      }
      case SSE.INSERTPS: {
        const src = f[S + ((imm >> 6) & 3)];
        f[D + ((imm >> 4) & 3)] = src;
        for (let k = 0; k < 4; k++) if (imm & (1 << k)) i32[D + k] = 0;   // the zero mask runs after
        return;
      }
      case SSE.DPPS: {
        let sum = 0;
        for (let k = 0; k < 4; k++) if (imm & (0x10 << k)) sum = Math.fround(sum + Math.fround(f[D + k] * f[S + k]));
        for (let k = 0; k < 4; k++) f[D + k] = (imm & (1 << k)) ? sum : 0;
        return;
      }
    }
  };

  /** The operations from ADDSS on (codes 21 and up): cpu.xmm.op, a function of its own, so that cpu.sse, which
   *  the recompiled blocks of the SSE intros call in their inner loops, stays small enough to inline. */
  X.op = (code, d, s, imm) => {
    const D = d * 4, S = s * 4;
    switch (code) {
      // ---- scalar single: the low lane; the others kept ----
      case SSE.ADDSS: ps(D, S, f[D] + f[S]); return;
      case SSE.SUBSS: ps(D, S, f[D] - f[S]); return;
      case SSE.MULSS: ps(D, S, f[D] * f[S]); return;
      case SSE.DIVSS: ps(D, S, f[D] / f[S]); return;
      case SSE.MINSS: minS(D, S); return;
      case SSE.MAXSS: maxS(D, S); return;
      case SSE.SQRTSS: us(D, S, sqrt); return;
      case SSE.RCPSS: us(D, S, rcp); return;                  // QEMU's: the exact reciprocal, rounded
      case SSE.RSQRTSS: us(D, S, rsq); return;
      // ---- packed single ----
      case SSE.DIVPS: for (let k = 0; k < 4; k++) ps(D + k, S + k, f[D + k] / f[S + k]); return;
      case SSE.MINPS: for (let k = 0; k < 4; k++) minS(D + k, S + k); return;
      case SSE.MAXPS: for (let k = 0; k < 4; k++) maxS(D + k, S + k); return;
      case SSE.SQRTPS: for (let k = 0; k < 4; k++) us(D + k, S + k, sqrt); return;
      case SSE.RCPPS: for (let k = 0; k < 4; k++) us(D + k, S + k, rcp); return;
      case SSE.ANDPS: case SSE.PAND: for (let k = 0; k < 4; k++) i32[D + k] &= i32[S + k]; return;
      case SSE.ANDNPS: case SSE.PANDN: for (let k = 0; k < 4; k++) i32[D + k] = ~i32[D + k] & i32[S + k]; return;
      case SSE.ORPS: case SSE.POR: for (let k = 0; k < 4; k++) i32[D + k] |= i32[S + k]; return;
      // ---- double precision: lanes of eight bytes, d64[reg * 2 + k] ----
      case SSE.ADDSD: bd(D / 2, S / 2, add); return;
      case SSE.SUBSD: bd(D / 2, S / 2, sub); return;
      case SSE.MULSD: bd(D / 2, S / 2, mul); return;
      case SSE.DIVSD: bd(D / 2, S / 2, div); return;
      case SSE.MINSD: minD(D / 2, S / 2); return;
      case SSE.MAXSD: maxD(D / 2, S / 2); return;
      case SSE.SQRTSD: ud(D / 2, S / 2, sqrt); return;
      case SSE.ADDPD: for (let k = 0; k < 2; k++) bd(D / 2 + k, S / 2 + k, add); return;
      case SSE.SUBPD: for (let k = 0; k < 2; k++) bd(D / 2 + k, S / 2 + k, sub); return;
      case SSE.MULPD: for (let k = 0; k < 2; k++) bd(D / 2 + k, S / 2 + k, mul); return;
      case SSE.DIVPD: for (let k = 0; k < 2; k++) bd(D / 2 + k, S / 2 + k, div); return;
      case SSE.MINPD: for (let k = 0; k < 2; k++) minD(D / 2 + k, S / 2 + k); return;
      case SSE.MAXPD: for (let k = 0; k < 2; k++) maxD(D / 2 + k, S / 2 + k); return;
      case SSE.SQRTPD: for (let k = 0; k < 2; k++) ud(D / 2 + k, S / 2 + k, sqrt); return;
      // ---- moves of halves (the memory forms arrive as the scratch register, loaded with 8 bytes) ----
      case SSE.MOVSD_LD: i32[D] = i32[S]; i32[D + 1] = i32[S + 1]; return;                        // xmm, xmm: the low quadword
      case SSE.MOVSD_LD_M: case SSE.MOVQ_LD: i32[D] = i32[S]; i32[D + 1] = i32[S + 1]; i32[D + 2] = 0; i32[D + 3] = 0; return;
      case SSE.MOVLO: i32[D] = i32[S]; i32[D + 1] = i32[S + 1]; return;                           // MOVLPS/MOVLPD xmm, m64
      case SSE.MOVHI: i32[D + 2] = i32[S]; i32[D + 3] = i32[S + 1]; return;                       // MOVHPS/MOVHPD xmm, m64
      case SSE.MOVHLPS: i32[D] = i32[S + 2]; i32[D + 1] = i32[S + 3]; return;
      case SSE.MOVLHPS: i32[D + 2] = i32[S]; i32[D + 3] = i32[S + 1]; return;
      case SSE.HI2LO: i32[D] = i32[S + 2]; i32[D + 1] = i32[S + 3]; return;                       // for MOVHPS m64, xmm
      // ---- unpacks and shuffles: the source read before the destination is written ----
      case SSE.UNPCKLPS: case SSE.PUNPCKLDQ: { const a = [i32[D], i32[S], i32[D + 1], i32[S + 1]]; for (let k = 0; k < 4; k++) i32[D + k] = a[k]; return; }
      case SSE.UNPCKHPS: case SSE.PUNPCKHDQ: { const a = [i32[D + 2], i32[S + 2], i32[D + 3], i32[S + 3]]; for (let k = 0; k < 4; k++) i32[D + k] = a[k]; return; }
      case SSE.UNPCKLPD: case SSE.PUNPCKLQDQ: i32[D + 2] = i32[S]; i32[D + 3] = i32[S + 1]; return;
      case SSE.UNPCKHPD: case SSE.PUNPCKHQDQ: { const a = [i32[D + 2], i32[D + 3], i32[S + 2], i32[S + 3]]; for (let k = 0; k < 4; k++) i32[D + k] = a[k]; return; }
      case SSE.PUNPCKLBW: { const a = u8.slice(D * 4, D * 4 + 8), b = u8.slice(S * 4, S * 4 + 8); for (let k = 0; k < 8; k++) { u8[D * 4 + 2 * k] = a[k]; u8[D * 4 + 2 * k + 1] = b[k]; } return; }
      case SSE.PUNPCKLWD: { const a = u16.slice(D * 2, D * 2 + 4), b = u16.slice(S * 2, S * 2 + 4); for (let k = 0; k < 4; k++) { u16[D * 2 + 2 * k] = a[k]; u16[D * 2 + 2 * k + 1] = b[k]; } return; }
      case SSE.SHUFPD: { const a = D + 2 * (imm & 1), b = S + 2 * ((imm >> 1) & 1); T[0] = i32[a]; T[1] = i32[a + 1]; T[2] = i32[b]; T[3] = i32[b + 1]; for (let k = 0; k < 4; k++) i32[D + k] = T[k]; return; }
      case SSE.PSHUFD: { for (let k = 0; k < 4; k++) T[k] = i32[S + ((imm >> (2 * k)) & 3)]; for (let k = 0; k < 4; k++) i32[D + k] = T[k]; return; }
      // ---- conversions ----
      case SSE.CVTSS2SD: d64[D / 2] = f[S]; return;
      case SSE.CVTSD2SS: f[D] = d64[S / 2]; return;
      case SSE.CVTPS2PD: { const a = f[S], b = f[S + 1]; d64[D / 2] = a; d64[D / 2 + 1] = b; return; }
      case SSE.CVTPD2PS: { const a = d64[S / 2], b = d64[S / 2 + 1]; f[D] = a; f[D + 1] = b; i32[D + 2] = 0; i32[D + 3] = 0; return; }
      case SSE.CVTTPS2DQ: for (let k = 0; k < 4; k++) i32[D + k] = toI32(Math.trunc(f[S + k])); return;
      case SSE.CVTDQ2PD: { const a = i32[S], b = i32[S + 1]; d64[D / 2] = a; d64[D / 2 + 1] = b; return; }
      case SSE.CVTTPD2DQ: { const a = toI32(Math.trunc(d64[S / 2])), b = toI32(Math.trunc(d64[S / 2 + 1])); i32[D] = a; i32[D + 1] = b; i32[D + 2] = 0; i32[D + 3] = 0; return; }
      // ---- compares to masks ----
      case SSE.CMPPS: for (let k = 0; k < 4; k++) i32[D + k] = cmp(f[D + k], f[S + k], imm) ? -1 : 0; return;
      case SSE.CMPSS: i32[D] = cmp(f[D], f[S], imm) ? -1 : 0; return;
      case SSE.CMPPD: for (let k = 0; k < 2; k++) { const r = cmp(d64[D / 2 + k], d64[S / 2 + k], imm) ? -1 : 0; i32[D + 2 * k] = r; i32[D + 2 * k + 1] = r; } return;
      case SSE.CMPSD: { const r = cmp(d64[D / 2], d64[S / 2], imm) ? -1 : 0; i32[D] = r; i32[D + 1] = r; return; }
      // ---- SSE2 integer on XMM ----
      case SSE.PADDD: for (let k = 0; k < 4; k++) i32[D + k] = (i32[D + k] + i32[S + k]) | 0; return;
      case SSE.PSUBD: for (let k = 0; k < 4; k++) i32[D + k] = (i32[D + k] - i32[S + k]) | 0; return;
      case SSE.PADDW: for (let k = 0; k < 8; k++) u16[D * 2 + k] = u16[D * 2 + k] + u16[S * 2 + k]; return;
      case SSE.PSUBW: for (let k = 0; k < 8; k++) u16[D * 2 + k] = u16[D * 2 + k] - u16[S * 2 + k]; return;
      case SSE.PMULLW: for (let k = 0; k < 8; k++) i16[D * 2 + k] = Math.imul(i16[D * 2 + k], i16[S * 2 + k]); return;
      case SSE.PCMPGTD: for (let k = 0; k < 4; k++) i32[D + k] = i32[D + k] > i32[S + k] ? -1 : 0; return;
      case SSE.PADDQ: case SSE.PSUBQ: for (let k = 0; k < 2; k++) {
        const a = BigInt.asUintN(64, (BigInt(u32[D + 2 * k + 1]) << 32n) | BigInt(u32[D + 2 * k])), b = BigInt.asUintN(64, (BigInt(u32[S + 2 * k + 1]) << 32n) | BigInt(u32[S + 2 * k]));
        const r = BigInt.asUintN(64, code === SSE.PADDQ ? a + b : a - b); u32[D + 2 * k] = Number(r & 0xffffffffn); u32[D + 2 * k + 1] = Number(r >> 32n);
      } return;
      case SSE.PCMPEQB: for (let k = 0; k < 16; k++) u8[D * 4 + k] = u8[D * 4 + k] === u8[S * 4 + k] ? 255 : 0; return;
      case SSE.PCMPEQW: for (let k = 0; k < 8; k++) u16[D * 2 + k] = u16[D * 2 + k] === u16[S * 2 + k] ? 0xffff : 0; return;
      case SSE.PCMPGTB: for (let k = 0; k < 16; k++) u8[D * 4 + k] = (u8[D * 4 + k] << 24 >> 24) > (u8[S * 4 + k] << 24 >> 24) ? 255 : 0; return;
      case SSE.PCMPGTW: for (let k = 0; k < 8; k++) u16[D * 2 + k] = i16[D * 2 + k] > i16[S * 2 + k] ? 0xffff : 0; return;
      case SSE.PMINUB: for (let k = 0; k < 16; k++) u8[D * 4 + k] = Math.min(u8[D * 4 + k], u8[S * 4 + k]); return;
      case SSE.PMAXUB: for (let k = 0; k < 16; k++) u8[D * 4 + k] = Math.max(u8[D * 4 + k], u8[S * 4 + k]); return;
      case SSE.PADDB: for (let k = 0; k < 16; k++) u8[D * 4 + k] = u8[D * 4 + k] + u8[S * 4 + k]; return;
      case SSE.PSUBB: for (let k = 0; k < 16; k++) u8[D * 4 + k] = u8[D * 4 + k] - u8[S * 4 + k]; return;
      case SSE.PUNPCKHBW: { const a = u8.slice(D * 4 + 8, D * 4 + 16), b = u8.slice(S * 4 + 8, S * 4 + 16); for (let k = 0; k < 8; k++) { u8[D * 4 + 2 * k] = a[k]; u8[D * 4 + 2 * k + 1] = b[k]; } return; }
      case SSE.PUNPCKHWD: { const a = u16.slice(D * 2 + 4, D * 2 + 8), b = u16.slice(S * 2 + 4, S * 2 + 8); for (let k = 0; k < 4; k++) { u16[D * 2 + 2 * k] = a[k]; u16[D * 2 + 2 * k + 1] = b[k]; } return; }
      case SSE.PMULUDQ: for (let k = 0; k < 2; k++) {
        const r = BigInt(u32[D + 2 * k]) * BigInt(u32[S + 2 * k]); u32[D + 2 * k] = Number(r & 0xffffffffn); u32[D + 2 * k + 1] = Number(r >> 32n);
      } return;
      // Shifts: by an immediate (`s` is -1) or by the source's low quadword; a count past the width
      // clears (logical) or fills with the sign (arithmetic).
      case SSE.PSLLD: case SSE.PSRLD: case SSE.PSRAD: case SSE.PSLLW: case SSE.PSRLW: case SSE.PSRAW: case SSE.PSLLQ: case SSE.PSRLQ: {
        const n = s < 0 ? imm : (u32[S + 1] ? 64 : u32[S]);
        if (code === SSE.PSLLD || code === SSE.PSRLD || code === SSE.PSRAD) for (let k = 0; k < 4; k++) {
          const v = i32[D + k]; i32[D + k] = code === SSE.PSRAD ? v >> (n > 31 ? 31 : n) : n > 31 ? 0 : code === SSE.PSLLD ? v << n : v >>> n;
        } else if (code === SSE.PSLLW || code === SSE.PSRLW || code === SSE.PSRAW) for (let k = 0; k < 8; k++) {
          const v = i16[D * 2 + k]; i16[D * 2 + k] = code === SSE.PSRAW ? v >> (n > 15 ? 15 : n) : n > 15 ? 0 : code === SSE.PSLLW ? v << n : (v & 0xffff) >>> n;
        } else for (let k = 0; k < 2; k++) {
          const a = (BigInt(u32[D + 2 * k + 1]) << 32n) | BigInt(u32[D + 2 * k]);
          const r = n > 63 ? 0n : BigInt.asUintN(64, code === SSE.PSLLQ ? a << BigInt(n) : a >> BigInt(n));
          u32[D + 2 * k] = Number(r & 0xffffffffn); u32[D + 2 * k + 1] = Number(r >> 32n);
        }
        return;
      }
      // Byte shifts of the whole register (the count an immediate, in bytes).
      case SSE.PSLLDQ: case SSE.PSRLDQ: {
        const a = u8.slice(D * 4, D * 4 + 16), n = imm > 16 ? 16 : imm;
        for (let k = 0; k < 16; k++) { const j = code === SSE.PSLLDQ ? k - n : k + n; u8[D * 4 + k] = j >= 0 && j < 16 ? a[j] : 0; }
        return;
      }
      default: throw new Error(`mirage: SSE operation ${code} not implemented`);
    }
  };

  cpu.sseReset = () => { for (let k = 0; k < i32.length; k++) i32[k] = 0; };
}
