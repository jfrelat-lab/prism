// fpu.js — a minimal x87 FPU coprocessor, attached as a modular device.
//
// The 8087 register file is a stack of eight 80-bit reals addressed relative to
// TOP (ST(0)..ST(7)); we model the values as JS float64 (more than enough for
// demos) with a faithful TOP pointer so push/pop wrap exactly like the hardware.
// We implement the full systematic memory-operand grid (load/store/arith over
// f32/f64/i16/i32) plus the common register-form ops. That is enough to run real
// 256-byte intros — HellMood's "Memories", for instance, needs only fild/fidivr/
// fstp, but the broader set means transcendental intros work too.

import { CF, PF, AF, ZF, SF, OF } from './cpu.js';

/** A result at PRECISION CONTROL = single: the x87 rounds the SIGNIFICAND to 24 bits (to nearest)
 *  and keeps its own 15-bit exponent, so a value below FLT_MIN or above FLT_MAX neither becomes a
 *  float denormal nor underflows or overflows, as Math.fround alone would make it (kkrieger's sFPow
 *  of x^64 is about 1e-73). Inside float's normal range the two agree, and that test is the fast
 *  path. Outside it the value is scaled by 2^-k into it, rounded, and scaled back exactly: an
 *  off-by-one floor of log2 at a power of two only leaves the scaled value in [0.5,1) or [2,4), still
 *  normal, so the rounding is the same. 2^k is split in two halves so neither overflows a double.
 *  A result beyond double's own exponent range (a double denormal, or past 2^1024) is out of scope. */
export function sig24(v) {
  const a = Math.abs(v);
  if (a === 0 || !(a < Infinity) || (a >= 1.1754943508222875e-38 && a < 3.4e38)) return Math.fround(v);
  const k = Math.floor(Math.log2(a)), h = k >> 1;
  return Math.fround(v * 2 ** -h * 2 ** -(k - h)) * 2 ** h * 2 ** (k - h);
}

export function installFPU(cpu) {
  const st = new Float64Array(8);
  cpu.fst = st;
  cpu.ftop = 0;            // TOP: ST(i) is physical register (TOP + i) & 7
  cpu.fsw = 0;             // condition-code bits C3 C2 C1 C0 of the status word
  cpu.fcw = 0x037f;        // control word: all exceptions masked, PC=extended, RC=nearest
  // Which PHYSICAL registers hold a value. The tag word is DERIVED from this plus the value itself
  // (00 valid, 01 zero, 10 special, 11 empty) rather than stored: the recompiler writes st[] inline
  // all over the place, so a stored tag would need every one of those sites to maintain it, while
  // occupancy changes in exactly four places — push, pop, FFREE and FNINIT. A typed array rather than
  // a bitmask on `cpu`: the emitted blocks alias it as a local, and a read-modify-write of a property
  // on the CPU object cost 4% of `tube` where an indexed store costs nothing measurable.
  cpu.focc = new Uint8Array(8);   // 1 = this physical register holds a value
  cpu.focc32 = new Uint32Array(cpu.focc.buffer);   // the eight tags as two words: MMX's test that all are 1 (src/mmx.js)
  const dv = cpu.mem.dv;
  // The address mask is read PER ACCESS, not captured once. It changes when A20 opens, and this
  // module is installed while A20 is still closed — so a captured copy pinned every x87 memory
  // access to the first megabyte for the rest of the run. Quake's float formatter reloads an 80-bit
  // temporary on its protected-mode stack at 0xBD9EC0; the load read 0xD9EC0 and the store wrote
  // there too, so the value it normalised was whatever sat in low memory (it decoded as zero), the
  // exponent search took all 13 bits, and the routine emitted 8191 leading zeros down through its
  // own stack. This is the fallback path — the recompiler inlines the hot forms and takes its mask
  // from Recompiler.setMask — so a property read here costs nothing that matters.
  const msk = () => cpu.mem.mask;

  const ST = (i) => st[(cpu.ftop + i) & 7];
  const setST = (i, v) => { st[(cpu.ftop + i) & 7] = v; };
  const push = (v) => { cpu.ftop = (cpu.ftop - 1) & 7; st[cpu.ftop] = v; cpu.focc[cpu.ftop] = 1; };
  const pop = () => { cpu.focc[cpu.ftop] = 0; cpu.ftop = (cpu.ftop + 1) & 7; };

  // UNDER PAGING an operand address is LINEAR. These helpers indexed the physical DataView with it,
  // so every x87 load and store of a real, or of a 64-bit integer, went to the wrong place once a
  // DPMI host turned paging on: xcom144's `fistp qword` (a loop bound) was never written where the
  // program read it back, and it spun for ever on two stale stack addresses. Paged accesses now go
  // through the page tables — xlat for an operand inside one page (one walk, the restartable #PF,
  // A/D bits), byte by byte when it straddles two. Without paging nothing changes.
  const pscratch = new DataView(new ArrayBuffer(16));
  /** [view, offset] holding `len` bytes at linear `a`, read through paging. */
  const prd = (a, len) => {
    const mem = cpu.mem; a >>>= 0;
    // A page an access has reached is filled in the recompiler's fast table (memory.js _afterAccess),
    // as an integer access does: a page only floats are read from -- Warcraft III's vertices -- stayed
    // on this path after every CR3 load otherwise, a translation and an array per load.
    if ((a & 0xfff) + len <= 0x1000) { const t = mem.xlat(a, false); if (t >= 0) mem._afterAccess(a >>> 12); return [dv, t]; }
    for (let i = 0; i < len; i++) pscratch.setUint8(i, mem.r8((a + i) >>> 0));
    return [pscratch, 0];
  };
  /** Store `len` bytes at linear `a` through paging: `fill(view, off)` writes them. */
  const pwr = (a, len, fill) => {
    const mem = cpu.mem; a >>>= 0;
    if ((a & 0xfff) + len <= 0x1000) {
      const t = mem.xlat(a, true);
      fill(dv, t);
      if (t >= 0) mem._afterAccess(a >>> 12);
      if (mem.codePage[a >>> 12]) mem._dirty(a, len);
      return;
    }
    mem.xlat(a, true); mem.xlat((a + len - 1) >>> 0, true);   // both pages writable before any byte moves
    fill(pscratch, 0);
    for (let i = 0; i < len; i++) mem.w8((a + i) >>> 0, pscratch.getUint8(i));
  };
  const pl = (a, len, get) => { const [v, o] = prd(a, len); return get(v, o); };

  const f32l = (a) => cpu.mem.paged ? pl(a, 4, (v, o) => v.getFloat32(o, true)) : dv.getFloat32(a & msk(), true);
  const f64l = (a) => cpu.mem.paged ? pl(a, 8, (v, o) => v.getFloat64(o, true)) : dv.getFloat64(a & msk(), true);
  // Float stores must honour the SMC dirty check like the integer w8/w16/w32 do —
  // a program that FSTs into a page holding compiled code must invalidate those blocks.
  const cp = cpu.mem.codePage;
  const f32s = (a, v) => { if (cpu.mem.paged) return pwr(a, 4, (w, o) => w.setFloat32(o, v, true));
    a &= msk(); dv.setFloat32(a, v, true); if (cp[a >>> 12] || cp[((a + 3) & msk()) >>> 12]) cpu.mem._dirty(a, 4); };
  const f64s = (a, v) => { if (cpu.mem.paged) return pwr(a, 8, (w, o) => w.setFloat64(o, v, true));
    a &= msk(); dv.setFloat64(a, v, true); if (cp[a >>> 12] || cp[((a + 7) & msk()) >>> 12]) cpu.mem._dirty(a, 8); };
  const i16 = (a) => cpu.mem.paged ? pl(a, 2, (v, o) => v.getInt16(o, true)) : dv.getInt16(a & msk(), true);
  const i32 = (a) => cpu.mem.paged ? pl(a, 4, (v, o) => v.getInt32(o, true)) : dv.getInt32(a & msk(), true);
  // 64-bit integers and 80-bit extended reals. Both forms were missing entirely, so the instruction
  // was a silent no-op: Borland's __ftol is `fistp qword`, so every float-to-long cast in a Borland
  // program returned whatever was already in the caller's stack slot. Wolf3D got SetupScaling(925)
  // instead of (360) that way and exhausted its heap building 462 scalers.
  const i64big = (a) => (cpu.mem.paged ? pl(a, 8, (v, o) => v.getBigInt64(o, true)) : dv.getBigInt64(a & msk(), true));
  const i64 = (a) => Number(i64big(a));
  // A 64-bit integer as the x87 holds it: exactly, in its 64-bit significand -- which a float64 register
  // cannot, beyond 2^53. Programs of the Pentium's time copied memory eight bytes at a time through the
  // FPU (FILD m64, FISTP m64: Jazz Jackrabbit 2's video, a frame's rows), and rounded, the lowest byte
  // of every eight came back wrong: a column in eight of the picture. So FILD m64 keeps the integer
  // beside the register it loads, with the double it put there, and FISTP m64 stores that integer
  // while the register still holds that double (moved by nothing, or by an exact operation that left
  // it unchanged); anything else -- the register rewritten -- and the double is stored, as before.
  // FXCH moves them with their values (the copy loops exchange two loads before storing them); x64n,
  // how many there are, spares every other FXCH the call.
  const x64 = new Array(8).fill(null), x64v = new Float64Array(8);
  const x64s = cpu.fx64 = { n: 0, swap: (p, q) => { const n = x64[p], v = x64v[p]; x64[p] = x64[q]; x64v[p] = x64v[q]; x64[q] = n; x64v[q] = v; } };
  const fild64 = (a) => { const n = i64big(a), v = Number(n); push(v); x64set(cpu.ftop, BigInt(v) === n ? null : n, v); };
  const fistp64 = (a) => {
    const p = cpu.ftop;
    if (x64[p] !== null && st[p] === x64v[p]) i64store(a, x64[p]); else i64s(a, toInt(st[p]));
    x64set(p, null, 0); pop();
  };
  const x64set = (p, n, v) => { if ((x64[p] === null) !== (n === null)) x64s.n += n === null ? -1 : 1; x64[p] = n; x64v[p] = v; };
  const i64store = (a, n) => {
    if (cpu.mem.paged) return pwr(a, 8, (w, o) => w.setBigInt64(o, n, true));
    a &= msk();
    dv.setBigInt64(a, n, true);
    if (cp[a >>> 12] || cp[((a + 7) & msk()) >>> 12]) cpu.mem._dirty(a, 8);
  };
  const INDEF64 = -(2n ** 63n);   // x87's "integer indefinite", stored when the value will not fit
  const i64s = (a, v) => {
    const fits = v >= -9223372036854775808 && v < 9223372036854775808;   // false for NaN
    if (!fits) cpu.fsw |= 0x01;                                          // IE: invalid operation
    i64store(a, fits ? BigInt(Math.trunc(v)) : INDEF64);
  };
  /** 80-bit extended: an explicit 64-bit mantissa (no hidden bit) and a 15-bit exponent biased by
   *  16383. This model's registers are float64, so a store rounds to 53 bits of mantissa and a load
   *  back is exact; only a value that came from real 80-bit silicon loses its low bits. */
  const f80l = (a) => {
    let v80 = dv;
    if (cpu.mem.paged) [v80, a] = prd(a, 10); else a &= msk();
    const m = v80.getBigUint64(a, true), se = v80.getUint16(a + 8, true);
    const sign = se & 0x8000 ? -1 : 1, exp = se & 0x7fff;
    if (exp === 0x7fff) return (m & 0x7fffffffffffffffn) === 0n ? sign * Infinity : NaN;
    // 2^-15360 and 2^+15360: HotSpot's strictfp bias. Its interpreter multiplies a product or quotient by
    // the one, then by the other (StubRoutines' fpu_subnormal_bias1 and 2), so that the 80-bit register
    // rounds as a double would. Here a register is a double already, and they were 0 and Infinity:
    // 0 x Infinity, and Math.toRadians was NaN -- Java2Demo's rotated text a "bad path". The pair cancels;
    // each is 1.
    if (m === 0x8000000000000000n && Math.abs(exp - 16383) === 15360) return sign;
    return sign * Number(m) * Math.pow(2, exp - 16383 - 63);
  };
  const f80s = (a, v) => {
    // Masked only where the address is physical, as the stores above are: under paging it is LINEAR,
    // and masking it to the size of RAM moved a store to the stack at BFFFFFA8h onto 03FFFFA8h —
    // musl's printf keeps its long double argument there (MIRAGE-LINUX, tools/linux/fpu80.asm).
    let se = 0, m = 0n;
    if (Number.isNaN(v)) { se = 0x7fff; m = 0xc000000000000000n; }
    else {
      if (v < 0 || Object.is(v, -0)) { se = 0x8000; v = -v; }
      if (v === Infinity) { se |= 0x7fff; m = 0x8000000000000000n; }
      else if (v !== 0) {
        let e = Math.floor(Math.log2(v)), f = v / Math.pow(2, e);
        if (f >= 2) { e++; f /= 2; } else if (f < 1) { e--; f *= 2; }
        m = BigInt(Math.round(f * 9223372036854775808));
        if (m >= 1n << 64n) { m >>= 1n; e++; }
        se |= (e + 16383) & 0x7fff;
      }
    }
    if (cpu.mem.paged) return pwr(a, 10, (w, o) => { w.setBigUint64(o, m, true); w.setUint16(o + 8, se, true); });
    a &= msk();
    dv.setBigUint64(a, m, true); dv.setUint16(a + 8, se, true);
    if (cp[a >>> 12] || cp[((a + 9) & msk()) >>> 12]) cpu.mem._dirty(a, 10);
  };

  /** Census of x87 encodings this model does NOT implement. An unimplemented form is a SILENT
   *  no-op here — it leaves memory and the stack untouched instead of faulting — so nothing marks
   *  it as it goes past. FISTP m64 (Borland's __ftol) sat like that until a Wolf3D heap exhaustion
   *  four layers downstream led back to it. tools/survey-gaps.mjs sweeps the corpus and reports
   *  this alongside the unimplemented INT vectors, so the next such hole is found by measurement.
   *  Keyed "d9/6 mem" for a memory form and "db/e4" for a register/no-operand one. */
  const misses = cpu.fpuMisses = new Map();
  const miss = (k) => misses.set(k, (misses.get(k) || 0) + 1);
  const missMem = (op, reg) => miss(`${op.toString(16)}/${reg} mem`);
  const missReg = (op, b) => miss(`${op.toString(16)}/${b.toString(16)}`);

  /** Round to integer under the control word's ROUNDING CONTROL (bits 10-11): 00 nearest-even,
   *  01 down, 10 up, 11 truncate toward zero. This was hardcoded to nearest, so a compiler that sets
   *  RC=truncate around a cast — which is what most of them do — got the wrong integer, and only for
   *  the values where the two modes disagree. Every float-to-int path goes through here, including
   *  FRNDINT and the recompiler's inline emission (which calls it as cpu.f2i). */
  const toInt = (x) => {
    switch ((cpu.fcw >> 10) & 3) {
      case 1: return Math.floor(x);
      case 2: return Math.ceil(x);
      case 3: return Math.trunc(x);
      default: { const fl = Math.floor(x), d = x - fl; return d < 0.5 ? fl : d > 0.5 ? fl + 1 : (fl % 2 === 0 ? fl : fl + 1); }
    }
  };

  /** FIST/FISTP to a word or a doubleword: a value that does not fit once rounded, or a NaN or an
   *  infinity, stores the "integer indefinite" (the most negative integer) and raises IE, as the
   *  64-bit form does (i64s). They wrapped instead: 140721282326 stored as 0xc3a45d16, where Docker
   *  i386 stores 0x80000000. The recompiler's inline emission calls them as cpu.fi32/cpu.fi16. */
  const toIntN = (x, lim) => {
    const r = toInt(x);
    if (r >= -lim && r < lim) return r;                // false for NaN
    cpu.fsw |= 0x01;
    return -lim;
  };
  cpu.fi32 = (x) => toIntN(x, 2147483648);
  cpu.fi16 = (x) => toIntN(x, 32768);

  /** PRECISION CONTROL (bits 8-9): 00 rounds every result to single precision. 10 (double) and 11
   *  (extended) are both this model's native float64 — we cannot be more precise than we are, and
   *  say so rather than pretending. One predictable branch, called from the arithmetic paths. */
  cpu.fprec = (v) => ((cpu.fcw & 0x300) === 0 ? sig24(v) : v);
  cpu.sig24 = sig24;                               // for the recompiler's blocks translated at PC=single
  const f64 = new Float64Array(1), f64u = new Uint32Array(f64.buffer);
  const f64bits = (x) => { f64[0] = x; return f64u[1]; };          // the high word: sign, exponent, top of the significand

  /** The tag word FNSTENV/FNSAVE publish: two bits per PHYSICAL register, register 0 in bits 0-1. */
  const tagWord = () => {
    let t = 0;
    for (let p = 0; p < 8; p++) {
      const v = st[p];
      const tag = !cpu.focc[p] ? 3 : v === 0 ? 1 : Number.isFinite(v) ? 0 : 2;
      t |= tag << (p * 2);
    }
    return t;
  };
  cpu.ftagWord = tagWord;

  /** FXAM classifies ST(0) into C3/C2/C0 and puts its SIGN in C1 — the one x87 compare that reports
   *  on a register rather than on a relation, and the only way a program can ask "is this slot even
   *  occupied". It was a no-op in both copies, commented "cc omitted". */
  cpu.fxam = () => {
    const v = ST(0), sign = (v < 0 || Object.is(v, -0)) ? 0x0200 : 0;
    let cc;
    if (!cpu.focc[cpu.ftop]) cc = 0x4100;                     // empty:    C3=1 C0=1
    else if (Number.isNaN(v)) cc = 0x0100;                    // NaN:      C0=1
    else if (!Number.isFinite(v)) cc = 0x0500;                // infinity: C2=1 C0=1
    else if (v === 0) cc = 0x4000;                            // zero:     C3=1
    else cc = 0x0400;                                         // normal:   C2=1
    cpu.fsw = (cpu.fsw & ~0x4700) | cc | sign;
  };

  /** FTST compares ST(0) against +0.0 into the status word. Also a no-op before this, and it passed
   *  its only positive-value case by accident: for x > 0 every condition code is 0 either way. */
  cpu.ftst = () => setcc(ST(0), 0);

  /** FPTAN, FSIN, FCOS, FSINCOS: C2 clear when the operand is in range (|x| < 2^63), set otherwise, and C1
   *  clear. Microsoft's C runtime tests C2 right after FPTAN (`fnstsw ax; sahf; jp reduce`): left as an
   *  earlier instruction had it, tan() took the out-of-range path, and Half-Life's R_ViewChanged, under
   *  Quake's single precision, got NaN for its projection and drew nothing. (Out of range, a real x87
   *  also leaves the stack as it was; that case computes here as in range.) */
  cpu.ftrigCC = (x) => { cpu.fsw = (cpu.fsw & ~0x0600) | (Math.abs(x) >= 9223372036854775808 ? 0x0400 : 0); };
  cpu.ffree = (i) => { cpu.focc[(cpu.ftop + i) & 7] = 0; };
  /** A change to PRECISION CONTROL is folded into the emitted code at translation time (see the
   *  recompiler's FPREC24), so the blocks compiled under the old setting have to go. Rounding control
   *  is read at run time and needs no such thing. */
  cpu.fldcw = (v) => {
    const before = cpu.fcw;
    cpu.fcw = v & 0xffff;
    if (((before ^ cpu.fcw) & 0x300) && cpu.onFcwPrecChange) cpu.onFcwPrecChange();   // none by default (see machine.js)
  };

  /** Division sets the zero-divide flag, which FXAM and FNSTSW report. `x/y` alone does not. */
  cpu.fdiv = (x, y) => {
    if (y === 0 && x !== 0 && !Number.isNaN(x)) cpu.fsw |= 0x04;
    return cpu.fprec(x / y);
  };

  /** FNSTENV writes the 14-byte real-mode environment: control, status and tag words, then the FPU
   *  instruction and data pointers. We keep no such pointers and write zeros — the oracle cases
   *  declare those eight bytes uncomparable rather than letting them look equal. */
  cpu.fnstenv = (a) => {
    cpu.mem.w16(a, cpu.fcw); cpu.mem.w16(a + 2, cpu.fpuStatus()); cpu.mem.w16(a + 4, tagWord());
    for (let k = 6; k < 14; k += 2) cpu.mem.w16(a + k, 0);
  };
  cpu.fldenv = (a) => {
    cpu.fcw = cpu.mem.r16(a); const sw = cpu.mem.r16(a + 2);
    cpu.fsw = sw & 0x47ff; cpu.ftop = (sw >> 11) & 7;
    const tw = cpu.mem.r16(a + 4);
    for (let p = 0; p < 8; p++) cpu.focc[p] = ((tw >> (p * 2)) & 3) !== 3 ? 1 : 0;
  };

  // set condition codes from a compare (C3,C2,C0 in status word bits 14,10,8)
  // FCOMI/FUCOMI (P6) write EFLAGS DIRECTLY, unlike every other x87 compare, which writes the status
  // word: unordered -> ZF=PF=CF=1, less -> CF, equal -> ZF, and OF/SF/AF cleared. They are the only
  // x87 compare a Jcc can read without an FNSTSW/SAHF round trip, so leaving them as no-ops does not
  // fail loudly — the branch just reads whatever flags happened to be there. Chrome Revenge gates its
  // whole ray/sphere test on three of them and drew a black screen for exactly that reason.
  const cmpi = (a, b) => {
    let fl = cpu.flags & ~(CF | PF | AF | ZF | SF | OF);
    if (Number.isNaN(a) || Number.isNaN(b)) fl |= CF | PF | ZF;
    else if (a < b) fl |= CF;
    else if (a === b) fl |= ZF;
    cpu.flags = fl;
  };

  // FCMOVcc (P6): move ST(i) into ST(0) when an EFLAGS condition holds. DA C0..DF are the plain
  // forms (B / E / BE / U) and DB C0..DF their negations. Like FCOMI these read or write EFLAGS
  // rather than the status word, and like FCOMI doing nothing is silent: the value simply never
  // arrives. qblove draws its entire logo through two of them.
  const fcmov = (b, negated) => {
    const fl = cpu.flags, k = (b >> 3) & 3;
    const cond = k === 0 ? !!(fl & CF) : k === 1 ? !!(fl & ZF)
      : k === 2 ? !!(fl & (CF | ZF)) : !!(fl & PF);
    if (cond !== negated) setST(0, ST(b & 7));
  };

  // ---- three operations that were wrong or absent, each found by the x87 oracle ----
  const dvx = new DataView(new ArrayBuffer(8));

  /** FXTRACT: exponent into ST(0), then PUSH the significand (1 <= |m| < 2). Split on the BITS —
   *  going through log2 puts the exponent one too high for a value just under a power of two. What
   *  was here before split integer from fraction, which is a different operation entirely, and it
   *  was labelled "fxtract-ish" in both copies. */
  cpu.fxtract = () => {
    const x = ST(0);
    if (x === 0) { setST(0, -Infinity); push(x); return; }              // hardware also raises #Z
    if (!Number.isFinite(x)) { setST(0, Number.isNaN(x) ? x : Infinity); push(x); return; }
    let v = x, bias = 0;
    dvx.setFloat64(0, v);
    if (((dvx.getUint32(0) >>> 20) & 0x7ff) === 0) {                     // denormal: normalise first
      v = x * 0x10000000000000; bias = -52; dvx.setFloat64(0, v);
    }
    const e = (((dvx.getUint32(0) >>> 20) & 0x7ff) - 1023) + bias;
    dvx.setUint32(0, (dvx.getUint32(0) & 0x800fffff) | (1023 << 20));    // force the exponent to 2^0
    const m = dvx.getFloat64(0);
    setST(0, e); push(m);
  };

  /** FPREM1 is the IEEE remainder: its quotient rounds to NEAREST, ties to even, where FPREM's
   *  truncates toward zero. JS `%` is FPREM exactly, which is why that one was already right — and
   *  why reusing it for FPREM1 (or leaving FPREM1 out, as here) is silently wrong. */
  cpu.frem1 = (a, b) => {
    if (b === 0 || !Number.isFinite(a)) return NaN;
    const q = a / b, f = Math.floor(q), d = q - f;
    const n = d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
    return a - b * n;
  };

  /** FPREM: the remainder of a truncating division, and the quotient's three low bits in C0 (Q2), C3
   *  (Q1) and C1 (Q0), C2 clear. When the exponents are 64 or more apart the x87 reduces only part of
   *  the way and sets C2, and the program loops (`fstsw ax; sahf; jp again`): ST0 % (ST1 * 2^(D-N)),
   *  N = 32 + D mod 32 of the SDM's 32..63 (PRISM's choice too). JS `%` is exact, as the x87 is. */
  const expo = (x) => { const e = (f64bits(x) >>> 20) & 0x7ff; return e ? e - 1023 : Math.floor(Math.log2(Math.abs(x))); };
  cpu.fprem = (a, b) => {
    cpu.fsw &= ~0x4700;
    if (b === 0 || !Number.isFinite(a) || Number.isNaN(b)) { cpu.fsw |= 0x01; return NaN; }
    if (a === 0 || !Number.isFinite(b)) return a;
    const d = expo(a) - expo(b);
    if (d >= 64) { const s = 2 ** (d - (32 + d % 32)); cpu.fsw |= 0x0400; return a % (b * s); }
    const r = a % b, ab = Math.abs(b), q = Math.round((Math.abs(a) % (8 * ab) - Math.abs(r)) / ab);
    cpu.fsw |= (q & 4 ? 0x0100 : 0) | (q & 2 ? 0x4000 : 0) | (q & 1 ? 0x0200 : 0);
    return r;
  };

  /** log2(1+x). FYL2XP1 exists precisely because it is accurate for x near 0, so it goes through
   *  log1p rather than log2(1+x). It was absent entirely: the instruction left ST unchanged. */
  cpu.flog2p1 = (x) => Math.log1p(x) / Math.LN2;

  const setcc = (a, b) => {
    cpu.fsw &= ~0x4500;
    if (Number.isNaN(a) || Number.isNaN(b)) cpu.fsw |= 0x4500;
    else if (a < b) cpu.fsw |= 0x0100;          // C0
    else if (a === b) cpu.fsw |= 0x4000;        // C3
  };

  cpu.fpuStatus = () => (cpu.fsw & 0x47ff) | ((cpu.ftop & 7) << 11);

  // Exposed so the recompiler can call them from inlined FPU code: the
  // round-to-integer (banker's rounding) and compare/condition-code helpers. Keeping
  // them as monomorphic functions lets V8 inline them while the emitted blocks stay small.
  cpu.f2i = toInt;
  // The memory operands' slow path for the recompiler's inline x87 under paging (emitFPUMemPaged):
  // a page the fast table does not cover, a straddling access, a page holding translated code.
  cpu.fRd32 = f32l; cpu.fRd64 = f64l; cpu.fWr32 = f32s; cpu.fWr64 = f64s;
  cpu.fcmp = setcc;

  // ---- memory-operand forms (op = D8..DF, reg = modrm.reg field) -----------
  cpu.fpuMem = (op, reg, a) => {
    switch (op) {
      case 0xd9:                                            // f32 load/store + control
        if (reg === 0) push(f32l(a));
        else if (reg === 2) f32s(a, ST(0));
        else if (reg === 3) { f32s(a, ST(0)); pop(); }
        else if (reg === 4) cpu.fldenv(a);                  // fldenv
        else if (reg === 5) cpu.fldcw(cpu.mem.r16(a));      // fldcw
        else if (reg === 6) cpu.fnstenv(a);                 // fnstenv
        else if (reg === 7) cpu.mem.w16(a, cpu.fcw);        // fnstcw
        else missMem(op, reg);
        return;
      case 0xdd:                                            // f64 load/store
        if (reg === 0) push(f64l(a));
        else if (reg === 2) f64s(a, ST(0));
        else if (reg === 3) { f64s(a, ST(0)); pop(); }
        else if (reg === 7) cpu.mem.w16(a, cpu.fpuStatus()); // fnstsw mem
        else missMem(op, reg);                              // 4 frstor, 6 fnsave
        return;
      case 0xdb:                                            // i32 load/store
        if (reg === 0) push(i32(a));
        else if (reg === 2) cpu.mem.w32(a, cpu.fi32(ST(0)) >>> 0);
        else if (reg === 3) { cpu.mem.w32(a, cpu.fi32(ST(0)) >>> 0); pop(); }
        else if (reg === 5) push(f80l(a));                  // fld m80
        else if (reg === 7) { f80s(a, ST(0)); pop(); }      // fstp m80
        else missMem(op, reg);
        return;
      case 0xdf:                                            // i16 load/store
        if (reg === 0) push(i16(a));
        else if (reg === 2) cpu.mem.w16(a, cpu.fi16(ST(0)) & 0xffff);
        else if (reg === 3) { cpu.mem.w16(a, cpu.fi16(ST(0)) & 0xffff); pop(); }
        else if (reg === 5) fild64(a);                      // fild m64, exactly beside its register
        else if (reg === 7) fistp64(a);                     // fistp m64 — Borland's __ftol
        else missMem(op, reg);                              // 4 fbld, 6 fbstp (packed BCD)
        return;
    }
    // arithmetic with a memory source: D8=f32, DC=f64, DA=i32, DE=i16
    const v = op === 0xd8 ? f32l(a) : op === 0xdc ? f64l(a) : op === 0xda ? i32(a) : i16(a);
    const x = ST(0);
    switch (reg) {
      case 2: setcc(x, v); break;                           // fcom / ficom
      case 3: setcc(x, v); pop(); break;                    // fcomp / ficomp
      default: setST(0, arith(reg, x, v)); break;           // the same operand order as the reg form
    }
  };

  // ---- register / no-operand forms -----------------------------------------
  cpu.fpuReg = (op, reg, rm) => {
    const b = 0xc0 | (reg << 3) | rm;                       // the full second byte (mod=3, so >= 0xC0)
    switch (op) {
      case 0xd9:
        if (b < 0xc8) { push(ST(rm)); return; }             // fld st(i)  (reads pre-push ST)
        if (b < 0xd0) { const t = ST(0); setST(0, ST(rm)); setST(rm, t); if (x64s.n) x64s.swap(cpu.ftop, (cpu.ftop + rm) & 7); return; } // fxch
        switch (b) {
          case 0xe0: setST(0, -ST(0)); return;              // fchs
          case 0xe1: setST(0, Math.abs(ST(0))); return;     // fabs
          case 0xe4: cpu.ftst(); return;                    // ftst
          case 0xe5: cpu.fxam(); return;                    // fxam
          case 0xe8: push(1); return;                       // fld1
          case 0xe9: push(Math.log2(10)); return;           // fldl2t
          case 0xea: push(Math.LOG2E); return;              // fldl2e
          case 0xeb: push(Math.PI); return;                 // fldpi
          case 0xec: push(Math.log10(2)); return;           // fldlg2
          case 0xed: push(Math.LN2); return;                // fldln2
          case 0xee: push(0); return;                       // fldz
          case 0xf0: setST(0, Math.expm1(ST(0) * Math.LN2)); return; // f2xm1: expm1, exact near 0 where 2^x-1 cancels
          case 0xf1: setST(1, ST(1) * Math.log2(ST(0))); pop(); return; // fyl2x
          case 0xf2: { cpu.ftrigCC(ST(0)); const t = Math.tan(ST(0)); setST(0, t); push(1); return; } // fptan
          case 0xf3: { const r = Math.atan2(ST(1), ST(0)); setST(1, r); pop(); return; } // fpatan
          case 0xf4: cpu.fxtract(); return;                 // fxtract
          case 0xf5: setST(0, cpu.frem1(ST(0), ST(1))); return;   // fprem1 (IEEE remainder)
          case 0xf8: setST(0, cpu.fprem(ST(0), ST(1))); return;   // fprem (truncating quotient, C0-C3)
          case 0xf9: setST(1, ST(1) * cpu.flog2p1(ST(0))); pop(); return;   // fyl2xp1
          case 0xfa: setST(0, cpu.fprec(Math.sqrt(ST(0)))); return;    // fsqrt, rounded to the precision control as FADD is (SDM 8.1.5.2)
          case 0xfb: { const x = ST(0); cpu.ftrigCC(x); setST(0, Math.sin(x)); push(Math.cos(x)); return; } // fsincos → ST0=cos, ST1=sin
          case 0xf6: cpu.ftop = (cpu.ftop - 1) & 7; return; // fdecstp (tags untouched)
          case 0xf7: cpu.ftop = (cpu.ftop + 1) & 7; return; // fincstp
          case 0xfc: setST(0, toInt(ST(0))); return;        // frndint
          case 0xfd: setST(0, ST(0) * Math.pow(2, Math.trunc(ST(1)))); return; // fscale
          case 0xfe: cpu.ftrigCC(ST(0)); setST(0, Math.sin(ST(0))); return;     // fsin
          case 0xff: cpu.ftrigCC(ST(0)); setST(0, Math.cos(ST(0))); return;     // fcos
        }
        if (b !== 0xd0) missReg(op, b);                     // d0 is FNOP; the rest are reserved
        return;
      case 0xd8: { const i = rm; const x = ST(0), y = ST(i); setST(0, arith(reg, x, y)); if (reg === 2 || reg === 3) setcc(x, y); if (reg === 3) pop(); return; }
      // DC/DE write ST(i): their reg-form sub/div are REVERSED vs D8 (the classic
      // x87 quirk) — feed arith as (ST(0), ST(i)) so reg4/6 reverse, reg5/7 are plain.
      case 0xdc: { const i = rm; if (reg === 2 || reg === 3) { setcc(ST(0), ST(i)); if (reg === 3) pop(); return; } setST(i, arith(reg, ST(0), ST(i))); return; }
      case 0xde:                                            // arithmetic + pop (faddp etc.)
        if (b === 0xd9) { setcc(ST(0), ST(1)); pop(); pop(); return; } // fcompp
        setST(rm, arith(reg, ST(0), ST(rm))); pop(); return;
      case 0xdd:
        if (b < 0xc8) { cpu.ffree(rm); return; }            // ffree st(i)
        if (b < 0xd8) { setST(rm, ST(0)); return; }         // fst st(i)
        if (b < 0xe0) { setST(rm, ST(0)); pop(); return; }  // fstp st(i)
        setcc(ST(0), ST(rm)); if (b >= 0xe8) pop(); return; // fucom / fucomp
      // DA had no arm at all: its whole register space was a no-op, FUCOMPP included — and that one
      // must POP TWICE, so the x87 stack drifted every time a program used it.
      case 0xda:
        if (b < 0xe0) return fcmov(b, false);                                // fcmovb/e/be/u
        if (b === 0xe9) { setcc(ST(0), ST(1)); pop(); return pop(); }        // fucompp
        missReg(op, b);
        return;
      case 0xdb:
        if (b < 0xe0) return fcmov(b, true);                                 // fcmovnb/ne/nbe/nu
        if (b === 0xe3) { cpu.ftop = 0; cpu.fsw = 0; cpu.fcw = 0x037f; cpu.focc.fill(0); st.fill(0); if (x64s.n) { x64.fill(null); x64s.n = 0; } return; }   // fninit (lattice runs it constantly: nothing more unless needed)
        if (b >= 0xe8 && b <= 0xef) return cmpi(ST(0), ST(b - 0xe8));        // fucomi st0,st(i)
        if (b >= 0xf0 && b <= 0xf7) return cmpi(ST(0), ST(b - 0xf0));        // fcomi  st0,st(i)
        if (b === 0xe2) { cpu.fsw &= ~0xff; return; }        // fnclex: the exception flags, ES and SF
        if (b < 0xe0 || b > 0xe4) missReg(op, b);           // e0, e1, e4 feni/fdisi/fsetpm: genuine no-ops
        return;
      case 0xdf:
        // FFREEP ST(i): undocumented, but every x87 implementation has it and compilers emit it as
        // the one-instruction "drop ST(0)". Found by the fpuMisses census — endless.com executes it
        // 242k times, and as a no-op the stack never popped.
        if (b < 0xc8) { cpu.ffree(rm); pop(); return; }                      // ffreep st(i)
        if (b === 0xe0) { cpu.ax = cpu.fpuStatus(); return; }                // fnstsw ax
        if (b >= 0xe8 && b <= 0xef) { cmpi(ST(0), ST(b - 0xe8)); return pop(); }   // fucomip
        if (b >= 0xf0 && b <= 0xf7) { cmpi(ST(0), ST(b - 0xf0)); return pop(); }   // fcomip
        missReg(op, b);
        return;
    }
  };

  // fadd/fmul/fcom/fcomp/fsub/fsubr/fdiv/fdivr selector for register arithmetic
  function arith(reg, x, y) {
    switch (reg) {
      case 0: return cpu.fprec(x + y); case 1: return cpu.fprec(x * y);
      case 4: return cpu.fprec(x - y); case 5: return cpu.fprec(y - x);
      case 6: return cpu.fdiv(x, y);   case 7: return cpu.fdiv(y, x);
    }
    return x;   // 2/3 are compares, handled by the caller
  }
}
