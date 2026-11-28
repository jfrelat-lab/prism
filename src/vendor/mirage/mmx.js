// mmx.js — the MMX register file and its instructions (Pentium MMX, 1997): eight 64-bit registers
// and the integer SIMD operations on them, packed bytes, words and doublewords, wrapping or
// saturating, as Intel's Software Developer's Manual (vol. 2, the MMX instructions) defines each.
// Heaven Seven (Exceed, 2000) needs it: its DOS version says "MMX instruction set required!".
//
// One ArrayBuffer of 9 x 8 bytes, typed views over it; register 8 is a scratch the recompiler loads
// a memory operand into, so every operation sees two registers. The x87 side of the architecture:
// an MMX instruction makes the x87 stack's top 0 and every tag valid, EMMS makes every tag empty
// (cpu.ftop, cpu.focc, which FNSTENV and FSAVE publish). The registers' VALUES are kept here, not in
// the x87 registers' significands they alias on the chip: a program that stores the x87 registers to
// read back MMX ones (FSAVE after MMX code) sees its x87 values, which no program of the time relied on.

export const MM_SCRATCH = 8;

// Operation codes: the second opcode byte (0F xx) where it names one operation; the shifts by an
// immediate (0F 71/72/73) are their register-count twins' codes, with the count as `imm`.
export const MMX = {
  PUNPCKLBW: 0x60, PUNPCKLWD: 0x61, PUNPCKLDQ: 0x62, PACKSSWB: 0x63, PCMPGTB: 0x64, PCMPGTW: 0x65,
  PCMPGTD: 0x66, PACKUSWB: 0x67, PUNPCKHBW: 0x68, PUNPCKHWD: 0x69, PUNPCKHDQ: 0x6a, PACKSSDW: 0x6b,
  MOVQ: 0x6f, PCMPEQB: 0x74, PCMPEQW: 0x75, PCMPEQD: 0x76,
  PSRLW: 0xd1, PSRLD: 0xd2, PSRLQ: 0xd3, PMULLW: 0xd5, PSUBUSB: 0xd8, PSUBUSW: 0xd9, PAND: 0xdb,
  PADDUSB: 0xdc, PADDUSW: 0xdd, PANDN: 0xdf, PSRAW: 0xe1, PSRAD: 0xe2, PMULHW: 0xe5, PSUBSB: 0xe8,
  PSUBSW: 0xe9, POR: 0xeb, PADDSB: 0xec, PADDSW: 0xed, PXOR: 0xef, PSLLW: 0xf1, PSLLD: 0xf2,
  PSLLQ: 0xf3, PMADDWD: 0xf5, PSUBB: 0xf8, PSUBW: 0xf9, PSUBD: 0xfa, PADDB: 0xfc, PADDW: 0xfd, PADDD: 0xfe,
  // SSE's additions on the MMX registers (Pentium III): .kkrieger's texture generator uses PMAXSW and its kin.
  PMINUB: 0xda, PMAXUB: 0xde, PAVGB: 0xe0, PAVGW: 0xe3, PMULHUW: 0xe4, PMINSW: 0xea, PMAXSW: 0xee, PSADBW: 0xf6,
};
export const MMX_OPS = new Set(Object.values(MMX));

const s8 = (v) => (v < -128 ? -128 : v > 127 ? 127 : v);
const u8s = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const s16 = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const u16s = (v) => (v < 0 ? 0 : v > 65535 ? 65535 : v);

export function installMMX(cpu) {
  const buf = new ArrayBuffer(8 * 9);
  const u8 = new Uint8Array(buf), i8 = new Int8Array(buf), u16 = new Uint16Array(buf), i16 = new Int16Array(buf);
  const u32 = new Uint32Array(buf), i32 = new Int32Array(buf);
  cpu.mm = { buf, u8, i8, u16, i16, u32, i32 };
  const T = new Uint8Array(8), Tu16 = new Uint16Array(T.buffer), Ti16 = new Int16Array(T.buffer), Tu32 = new Uint32Array(T.buffer);

  // The x87 stack as MMX leaves it. Already so, as it is from the second instruction of a run of MMX
  // code on: the eight tags read as two words, not written again -- writing them took a fifth of AVS's
  // time (Winamp's visualizer, MMX throughout).
  let occ = null, occ32 = null;
  const enter = () => {
    const f = cpu.focc;
    if (!f) { cpu.ftop = 0; return; }
    if (f !== occ) { occ = f; occ32 = new Uint32Array(f.buffer, f.byteOffset, 2); }
    if (cpu.ftop === 0 && occ32[0] === 0x01010101 && occ32[1] === 0x01010101) return;
    cpu.ftop = 0; f.fill(1);
  };
  cpu.emms = () => { if (cpu.focc) cpu.focc.fill(0); };
  cpu.mmEnter = enter;

  // A memory operand inside one page of plain RAM the fast tables already map (memory.js rdOfs/wrOfs:
  // -1 for a device, a page not walked yet, or one holding translated code) moves as one copy; any
  // other goes byte by byte through the accessors, which translate, fault and fill those tables.
  cpu.mmLoad = (lin, len) => {
    const m = cpu.mem, b = MM_SCRATCH * 8;
    lin >>>= 0;
    if (m.paged && (lin & 4095) <= 4088) {
      const o = m.rdOfs[lin >>> 12];
      if (o !== -1) { const q = (o + lin) >>> 0; for (let k = 0; k < 8; k++) u8[b + k] = k < len ? m.u8[q + k] : 0; return; }
    }
    for (let k = 0; k < 8; k++) u8[b + k] = k < len ? m.r8((lin + k) >>> 0) : 0;
  };
  cpu.mmStore = (lin, reg) => {
    enter(); const m = cpu.mem;
    lin >>>= 0;
    if (m.paged && (lin & 4095) <= 4088) {
      const o = m.wrOfs[lin >>> 12];
      if (o !== -1) { m.u8.set(u8.subarray(reg * 8, reg * 8 + 8), (o + lin) >>> 0); return; }
    }
    for (let k = 0; k < 8; k++) m.w8((lin + k) >>> 0, u8[reg * 8 + k]);
  };
  cpu.mmMovdIn = (reg, v) => { enter(); u32[reg * 2] = v >>> 0; u32[reg * 2 + 1] = 0; };
  cpu.mmMovdOut = (reg) => { enter(); return u32[reg * 2]; };

  // PSHUFW: the source's words in the order imm8 names, two bits a word; PINSRW, PEXTRW: one word in
  // or out; PMOVMSKB: the top bit of each byte, as a byte.
  cpu.mmShufw = (d, s, imm) => { enter(); for (let k = 0; k < 4; k++) Tu16[k] = u16[s * 4 + ((imm >> (2 * k)) & 3)]; u8.set(T, d * 8); };
  cpu.mmInsrw = (d, v, imm) => { enter(); u16[d * 4 + (imm & 3)] = v & 0xffff; };
  cpu.mmExtrw = (s, imm) => { enter(); return u16[s * 4 + (imm & 3)]; };
  cpu.mmMovmskb = (s) => { enter(); let m = 0; for (let k = 0; k < 8; k++) m |= (u8[s * 8 + k] >> 7) << k; return m; };

  /** One operation: `d` the destination register, `s` the source one (or MM_SCRATCH), `imm` a count. */
  cpu.mmx = (op, d, s, imm) => {
    enter();
    const D = d * 8, S = s * 8, D2 = d * 4, S2 = s * 4, D4 = d * 2, S4 = s * 2;
    switch (op) {
      case MMX.MOVQ: u32[D4] = u32[S4]; u32[D4 + 1] = u32[S4 + 1]; return;
      case MMX.PADDB: for (let k = 0; k < 8; k++) u8[D + k] = u8[D + k] + u8[S + k]; return;
      case MMX.PADDW: for (let k = 0; k < 4; k++) u16[D2 + k] = u16[D2 + k] + u16[S2 + k]; return;
      case MMX.PADDD: for (let k = 0; k < 2; k++) u32[D4 + k] = u32[D4 + k] + u32[S4 + k]; return;
      case MMX.PSUBB: for (let k = 0; k < 8; k++) u8[D + k] = u8[D + k] - u8[S + k]; return;
      case MMX.PSUBW: for (let k = 0; k < 4; k++) u16[D2 + k] = u16[D2 + k] - u16[S2 + k]; return;
      case MMX.PSUBD: for (let k = 0; k < 2; k++) u32[D4 + k] = u32[D4 + k] - u32[S4 + k]; return;
      case MMX.PADDSB: for (let k = 0; k < 8; k++) i8[D + k] = s8(i8[D + k] + i8[S + k]); return;
      case MMX.PADDSW: for (let k = 0; k < 4; k++) i16[D2 + k] = s16(i16[D2 + k] + i16[S2 + k]); return;
      case MMX.PSUBSB: for (let k = 0; k < 8; k++) i8[D + k] = s8(i8[D + k] - i8[S + k]); return;
      case MMX.PSUBSW: for (let k = 0; k < 4; k++) i16[D2 + k] = s16(i16[D2 + k] - i16[S2 + k]); return;
      case MMX.PADDUSB: for (let k = 0; k < 8; k++) u8[D + k] = u8s(u8[D + k] + u8[S + k]); return;
      case MMX.PADDUSW: for (let k = 0; k < 4; k++) u16[D2 + k] = u16s(u16[D2 + k] + u16[S2 + k]); return;
      case MMX.PSUBUSB: for (let k = 0; k < 8; k++) u8[D + k] = u8s(u8[D + k] - u8[S + k]); return;
      case MMX.PSUBUSW: for (let k = 0; k < 4; k++) u16[D2 + k] = u16s(u16[D2 + k] - u16[S2 + k]); return;
      case MMX.PMULLW: for (let k = 0; k < 4; k++) i16[D2 + k] = Math.imul(i16[D2 + k], i16[S2 + k]); return;
      case MMX.PMULHW: for (let k = 0; k < 4; k++) i16[D2 + k] = Math.imul(i16[D2 + k], i16[S2 + k]) >> 16; return;
      case MMX.PMADDWD: {
        const a = Math.imul(i16[D2], i16[S2]) + Math.imul(i16[D2 + 1], i16[S2 + 1]);
        const b = Math.imul(i16[D2 + 2], i16[S2 + 2]) + Math.imul(i16[D2 + 3], i16[S2 + 3]);
        i32[D4] = a; i32[D4 + 1] = b; return;                // 8000h x 8000h twice wraps to 80000000h, as the chip gives
      }
      case MMX.PAND: u32[D4] &= u32[S4]; u32[D4 + 1] &= u32[S4 + 1]; return;
      case MMX.PANDN: u32[D4] = ~u32[D4] & u32[S4]; u32[D4 + 1] = ~u32[D4 + 1] & u32[S4 + 1]; return;
      case MMX.POR: u32[D4] |= u32[S4]; u32[D4 + 1] |= u32[S4 + 1]; return;
      case MMX.PXOR: u32[D4] ^= u32[S4]; u32[D4 + 1] ^= u32[S4 + 1]; return;
      case MMX.PCMPEQB: for (let k = 0; k < 8; k++) u8[D + k] = u8[D + k] === u8[S + k] ? 0xff : 0; return;
      case MMX.PCMPEQW: for (let k = 0; k < 4; k++) u16[D2 + k] = u16[D2 + k] === u16[S2 + k] ? 0xffff : 0; return;
      case MMX.PCMPEQD: for (let k = 0; k < 2; k++) u32[D4 + k] = u32[D4 + k] === u32[S4 + k] ? 0xffffffff : 0; return;
      case MMX.PCMPGTB: for (let k = 0; k < 8; k++) u8[D + k] = i8[D + k] > i8[S + k] ? 0xff : 0; return;
      case MMX.PCMPGTW: for (let k = 0; k < 4; k++) u16[D2 + k] = i16[D2 + k] > i16[S2 + k] ? 0xffff : 0; return;
      case MMX.PCMPGTD: for (let k = 0; k < 2; k++) u32[D4 + k] = i32[D4 + k] > i32[S4 + k] ? 0xffffffff : 0; return;
      // Packs: the destination's elements narrowed into the low half, the source's into the high one.
      case MMX.PACKSSWB: for (let k = 0; k < 4; k++) { T[k] = s8(i16[D2 + k]) & 255; T[k + 4] = s8(i16[S2 + k]) & 255; } u8.set(T, D); return;
      case MMX.PACKUSWB: for (let k = 0; k < 4; k++) { T[k] = u8s(i16[D2 + k]); T[k + 4] = u8s(i16[S2 + k]); } u8.set(T, D); return;
      case MMX.PACKSSDW: for (let k = 0; k < 2; k++) { Ti16[k] = s16(i32[D4 + k]); Ti16[k + 2] = s16(i32[S4 + k]); } u8.set(T, D); return;
      // Unpacks: the low (or high) halves of the two, interleaved, the destination's element first.
      case MMX.PUNPCKLBW: for (let k = 0; k < 4; k++) { T[2 * k] = u8[D + k]; T[2 * k + 1] = u8[S + k]; } u8.set(T, D); return;
      case MMX.PUNPCKHBW: for (let k = 0; k < 4; k++) { T[2 * k] = u8[D + 4 + k]; T[2 * k + 1] = u8[S + 4 + k]; } u8.set(T, D); return;
      case MMX.PUNPCKLWD: for (let k = 0; k < 2; k++) { Tu16[2 * k] = u16[D2 + k]; Tu16[2 * k + 1] = u16[S2 + k]; } u8.set(T, D); return;
      case MMX.PUNPCKHWD: for (let k = 0; k < 2; k++) { Tu16[2 * k] = u16[D2 + 2 + k]; Tu16[2 * k + 1] = u16[S2 + 2 + k]; } u8.set(T, D); return;
      case MMX.PUNPCKLDQ: Tu32[0] = u32[D4]; Tu32[1] = u32[S4]; u8.set(T, D); return;
      case MMX.PUNPCKHDQ: Tu32[0] = u32[D4 + 1]; Tu32[1] = u32[S4 + 1]; u8.set(T, D); return;
      case MMX.PMINUB: for (let k = 0; k < 8; k++) u8[D + k] = Math.min(u8[D + k], u8[S + k]); return;
      case MMX.PMAXUB: for (let k = 0; k < 8; k++) u8[D + k] = Math.max(u8[D + k], u8[S + k]); return;
      case MMX.PMINSW: for (let k = 0; k < 4; k++) i16[D2 + k] = Math.min(i16[D2 + k], i16[S2 + k]); return;
      case MMX.PMAXSW: for (let k = 0; k < 4; k++) i16[D2 + k] = Math.max(i16[D2 + k], i16[S2 + k]); return;
      case MMX.PAVGB: for (let k = 0; k < 8; k++) u8[D + k] = (u8[D + k] + u8[S + k] + 1) >> 1; return;
      case MMX.PAVGW: for (let k = 0; k < 4; k++) u16[D2 + k] = (u16[D2 + k] + u16[S2 + k] + 1) >> 1; return;
      case MMX.PMULHUW: for (let k = 0; k < 4; k++) u16[D2 + k] = (u16[D2 + k] * u16[S2 + k]) >>> 16; return;
      case MMX.PSADBW: { let t = 0; for (let k = 0; k < 8; k++) t += Math.abs(u8[D + k] - u8[S + k]); u32[D4] = t; u32[D4 + 1] = 0; return; }
    }
    // Shifts: the count is the source register's whole quadword, or the immediate (imm >= 0).
    const n = imm >= 0 ? imm : (u32[S4 + 1] !== 0 ? 64 : u32[S4]);
    switch (op) {
      case MMX.PSLLW: for (let k = 0; k < 4; k++) u16[D2 + k] = n > 15 ? 0 : u16[D2 + k] << n; return;
      case MMX.PSRLW: for (let k = 0; k < 4; k++) u16[D2 + k] = n > 15 ? 0 : u16[D2 + k] >>> n; return;
      case MMX.PSRAW: for (let k = 0; k < 4; k++) i16[D2 + k] = i16[D2 + k] >> (n > 15 ? 15 : n); return;
      case MMX.PSLLD: for (let k = 0; k < 2; k++) u32[D4 + k] = n > 31 ? 0 : u32[D4 + k] << n; return;
      case MMX.PSRLD: for (let k = 0; k < 2; k++) u32[D4 + k] = n > 31 ? 0 : u32[D4 + k] >>> n; return;
      case MMX.PSRAD: for (let k = 0; k < 2; k++) i32[D4 + k] = i32[D4 + k] >> (n > 31 ? 31 : n); return;
      // The quadword shifts on its two halves: BigInt arithmetic made each a few hundred nanoseconds,
      // and AVS shifts half a million quadwords a second.
      case MMX.PSLLQ: {
        const lo = u32[D4], hi = u32[D4 + 1];
        if (n > 63) { u32[D4] = 0; u32[D4 + 1] = 0; } else if (n >= 32) { u32[D4 + 1] = lo << (n - 32); u32[D4] = 0; }
        else if (n > 0) { u32[D4 + 1] = (hi << n) | (lo >>> (32 - n)); u32[D4] = lo << n; }
        return;
      }
      case MMX.PSRLQ: {
        const lo = u32[D4], hi = u32[D4 + 1];
        if (n > 63) { u32[D4] = 0; u32[D4 + 1] = 0; } else if (n >= 32) { u32[D4] = hi >>> (n - 32); u32[D4 + 1] = 0; }
        else if (n > 0) { u32[D4] = (lo >>> n) | (hi << (32 - n)); u32[D4 + 1] = hi >>> n; }
        return;
      }
    }
    throw new Error(`mmx: operation 0F ${op.toString(16)} is not implemented`);
  };
}

/**
 * The JavaScript the recompiler emits for an operation it makes inline (cpu.mmEnter() before it), or
 * null for those left to cpu.mmx: the moves, the logic, the wrapping additions and subtractions, the
 * low multiply, the unpacks of the low halves and the shifts by an immediate -- what AVS (Winamp's
 * visualizer) runs ten million times a second, one call and one switch each before. `d`, `s` registers
 * (s may be MM_SCRATCH, a memory operand loaded), `imm` a shift's count or -1. Each as cpu.mmx computes
 * it; an unpack writes from the top down, so a register unpacked with itself reads its low half first.
 */
/** What the recompiler emits before an MMX instruction: cpu.mmEnter() only when the x87 top is not 0
 *  or a tag is not 1 -- a call per instruction was a twentieth of AVS's time. */
export const MM_ENTER = 'if(cpu.ftop!==0||cpu.focc32[0]!==16843009||cpu.focc32[1]!==16843009)cpu.mmEnter();';

/**
 * The paged fast forms of an MMX memory operand (the recompiler's paged strategy: rdo/wro, _po/_pw, dv
 * in scope): `len` bytes at linear `t` into the scratch register, or register `reg` to `t`, as one
 * copy when the page is plain mapped RAM, else cpu.mmLoad/mmStore.
 */
export const mmLoadPaged = (t, len) => `if((${t}&4095)<4089&&(_po=rdo[${t}>>>12])!==-1){var _mmu32=cpu.mm.u32;_mmu32[${MM_SCRATCH * 2}]=dv.getUint32((_po+${t})>>>0,true);`
  + `_mmu32[${MM_SCRATCH * 2 + 1}]=${len === 8 ? `dv.getUint32((_po+${t}+4)>>>0,true)` : '0'};}else cpu.mmLoad(${t},${len});`;
export const mmStorePaged = (t, reg) => `if((${t}&4095)<4089&&(_pw=wro[${t}>>>12])!==-1){${MM_ENTER}var _mmu32=cpu.mm.u32;dv.setUint32((_pw+${t})>>>0,_mmu32[${reg * 2}],true);`
  + `dv.setUint32((_pw+${t}+4)>>>0,_mmu32[${reg * 2 + 1}],true);}else cpu.mmStore(${t},${reg});`;

export function mmxInline(op, d, s, imm) {
  // One name per array type (_mmu8, _mmi16...): a block that mixes them keeps each variable one type.
  const js = inline(op, d, s, imm), t = js && /cpu\.mm\.(\w+)/.exec(js);
  return t ? js.replaceAll('_mm', '_mm' + t[1]) : js;
}
function inline(op, d, s, imm) {
  const L = (n, f) => Array.from({ length: n }, (_, k) => f(k)).join('');
  const D8 = d * 8, S8 = s * 8, D2 = d * 4, S2 = s * 4, D4 = d * 2, S4 = s * 2;
  const u8 = 'var _mm=cpu.mm.u8;', u16 = 'var _mm=cpu.mm.u16;', i16 = 'var _mm=cpu.mm.i16;', u32 = 'var _mm=cpu.mm.u32;', i32 = 'var _mm=cpu.mm.i32;';
  if (imm < 0) switch (op) {
    case MMX.MOVQ: return `${u32}_mm[${D4}]=_mm[${S4}];_mm[${D4 + 1}]=_mm[${S4 + 1}];`;
    case MMX.PAND: return `${u32}_mm[${D4}]&=_mm[${S4}];_mm[${D4 + 1}]&=_mm[${S4 + 1}];`;
    case MMX.POR: return `${u32}_mm[${D4}]|=_mm[${S4}];_mm[${D4 + 1}]|=_mm[${S4 + 1}];`;
    case MMX.PXOR: return `${u32}_mm[${D4}]^=_mm[${S4}];_mm[${D4 + 1}]^=_mm[${S4 + 1}];`;
    case MMX.PANDN: return `${u32}_mm[${D4}]=~_mm[${D4}]&_mm[${S4}];_mm[${D4 + 1}]=~_mm[${D4 + 1}]&_mm[${S4 + 1}];`;
    case MMX.PADDB: return u8 + L(8, (k) => `_mm[${D8 + k}]+=_mm[${S8 + k}];`);
    case MMX.PSUBB: return u8 + L(8, (k) => `_mm[${D8 + k}]-=_mm[${S8 + k}];`);
    case MMX.PADDW: return u16 + L(4, (k) => `_mm[${D2 + k}]+=_mm[${S2 + k}];`);
    case MMX.PSUBW: return u16 + L(4, (k) => `_mm[${D2 + k}]-=_mm[${S2 + k}];`);
    case MMX.PADDD: return u32 + L(2, (k) => `_mm[${D4 + k}]+=_mm[${S4 + k}];`);
    case MMX.PSUBD: return u32 + L(2, (k) => `_mm[${D4 + k}]-=_mm[${S4 + k}];`);
    case MMX.PMULLW: return i16 + L(4, (k) => `_mm[${D2 + k}]=Math.imul(_mm[${D2 + k}],_mm[${S2 + k}]);`);
    case MMX.PUNPCKLBW: return u8 + L(4, (j) => { const k = 3 - j; return `_mm[${D8 + 2 * k + 1}]=_mm[${S8 + k}];_mm[${D8 + 2 * k}]=_mm[${D8 + k}];`; });
    case MMX.PUNPCKLWD: return u16 + L(2, (j) => { const k = 1 - j; return `_mm[${D2 + 2 * k + 1}]=_mm[${S2 + k}];_mm[${D2 + 2 * k}]=_mm[${D2 + k}];`; });
    case MMX.PUNPCKLDQ: return `${u32}_mm[${D4 + 1}]=_mm[${S4}];`;
    default: return null;
  }
  const n = imm;
  switch (op) {
    case MMX.PSRLW: return u16 + L(4, (k) => (n > 15 ? `_mm[${D2 + k}]=0;` : `_mm[${D2 + k}]>>>=${n};`));
    case MMX.PSLLW: return u16 + L(4, (k) => (n > 15 ? `_mm[${D2 + k}]=0;` : `_mm[${D2 + k}]<<=${n};`));
    case MMX.PSRAW: return i16 + L(4, (k) => `_mm[${D2 + k}]>>=${n > 15 ? 15 : n};`);
    case MMX.PSRLD: return u32 + L(2, (k) => (n > 31 ? `_mm[${D4 + k}]=0;` : `_mm[${D4 + k}]>>>=${n};`));
    case MMX.PSLLD: return u32 + L(2, (k) => (n > 31 ? `_mm[${D4 + k}]=0;` : `_mm[${D4 + k}]<<=${n};`));
    case MMX.PSRAD: return i32 + L(2, (k) => `_mm[${D4 + k}]>>=${n > 31 ? 31 : n};`);
    case MMX.PSRLQ:
      if (n > 63) return `${u32}_mm[${D4}]=0;_mm[${D4 + 1}]=0;`;
      if (n >= 32) return `${u32}_mm[${D4}]=_mm[${D4 + 1}]>>>${n - 32};_mm[${D4 + 1}]=0;`;
      if (n === 0) return '';
      return `${u32}_mm[${D4}]=(_mm[${D4}]>>>${n})|(_mm[${D4 + 1}]<<${32 - n});_mm[${D4 + 1}]>>>=${n};`;
    case MMX.PSLLQ:
      if (n > 63) return `${u32}_mm[${D4}]=0;_mm[${D4 + 1}]=0;`;
      if (n >= 32) return `${u32}_mm[${D4 + 1}]=_mm[${D4}]<<${n - 32};_mm[${D4}]=0;`;
      if (n === 0) return '';
      return `${u32}_mm[${D4 + 1}]=(_mm[${D4 + 1}]<<${n})|(_mm[${D4}]>>>${32 - n});_mm[${D4}]<<=${n};`;
    default: return null;
  }
}
