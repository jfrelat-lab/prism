// farcall.js — far control transfers between the code a 16-bit program is made of, routed by segment.
//
// A Borland real-mode program is C, Turbo Assembler modules and, in id's 3-D games, x86 the program
// WRITES AT RUN TIME (Wolf3D's WL_SCALE.C compiles one scaler per wall height and enters it with
// `call DWORD PTR [bp]`). In PRISM those are three kinds of code: compiled JavaScript, a translated
// module (src/asm/tasm16.js), and bytes in memory nothing has translated. A far CALL, JMP or RET
// names a CS:IP, and this file hands control to whatever owns that segment:
//
//   FROM_C       the C caller that entered the machine: done.
//   a module     its translated machine (tasm-link.js registers each module's code segment).
//   C_SEG        a C function: a PRISM code pointer (FUNC_TAG | index) read as seg:off. Its arguments
//                are read off SS:SP as its prototype lays them out, its value goes to AX / DX:AX,
//                and the return is emulated: RETF, or IRET for a vector the machine's BIOS answers
//                (a JS function with no C type: `pushf; call [t0OldService]` chains to the BIOS
//                timer exactly as INT 8 would).
//   anything     M.x86exec -- an x86 executor the harness supplies (MIRAGE's CPU and recompiler, on the
//   else         same memory). It runs from CS:IP until control leaves for a segment it does not
//                own, which is how a compiled scaler's RETF comes back here. With none supplied the
//                transfer is refused by name: PRISM translates source, and these bytes have none.
//
// Registers travel in one object R between owners, so a C function called from assembly that calls
// back into assembly gets its own R and leaves the outer one as the 8086 would see it: SI, DI, BP,
// DS and SS preserved (Borland's C saves them), AX and DX the result.
import { FUNC_TAG } from '../link/module.js';

/** The return address pushed for a call from C: a code segment nothing is loaded at. */
export const FROM_C = 0xffff;
/** The segment a PRISM code pointer reads as. */
export const C_SEG = (FUNC_TAG >>> 16) & 0xffff;

export function installFarCall(M, { funcType = () => null } = {}) {
  if (M.farRoute) return M;
  const D = () => M.mod.dv;
  const owners = new Map();                 // code segment -> run(R)
  let byIndex = null;
  const funcAt = (i) => {
    if (!byIndex?.has(i)) byIndex = new Map([...M.mod.funcs.values()].map((f) => [f.index, f]));
    return byIndex.get(i);
  };
  const readArgs = (params, sp, name) => {
    const dv = D();
    let at = (sp + 4) & 0xffff;
    return params.map((q) => {
      const t = q.type;
      if (!t) throw new Error(`farcall: ${name} takes an argument with no prototype in scope`);
      const w0 = dv.getUint16(at, true);
      if (t.size === 4) {
        const w1 = dv.getUint16((at + 2) & 0xffff, true);
        at = (at + 4) & 0xffff;
        if (t.k === 'ptr' && !(t.segoff && t.to?.k !== 'func') && !t.to?.k?.startsWith?.('func')) return ((w1 << 4) + w0) >>> 0;
        return t.signed === false || t.k === 'ptr' ? ((w1 << 16) | w0) >>> 0 : (w1 << 16) | w0;
      }
      at = (at + 2) & 0xffff;
      if (t.size === 1) return t.signed ? (w0 << 24) >> 24 : w0 & 0xff;
      return t.signed === false || t.k === 'ptr' ? w0 : (w0 << 16) >> 16;
    });
  };
  const toRegs = (t, v, R) => {
    if (!t || t.k === 'void' || t.name === 'void' || v === undefined) return;
    const n = Number(v);
    if (t.k === 'ptr' && t.size === 4 && !(t.segoff && t.to?.k !== 'func') && !t.to?.k?.startsWith?.('func')) { R.ax = n & 15; R.dx = (n >>> 4) & 0xffff; return; }
    R.ax = n & 0xffff;
    if (t.size === 4) R.dx = (n >>> 16) & 0xffff;
  };
  const callC = (R) => {
    const dv = D();
    const p = ((R.cs << 16) | R.ip) >>> 0;
    const f = funcAt(p & ~FUNC_TAG);
    if (!f || !f.fn) throw new Error(`farcall: a far call to ${R.cs.toString(16)}:${R.ip.toString(16)}, a C function nothing binds`);
    const ft = f.type ?? funcType(f.name) ?? null;
    const args = ft ? readArgs(ft.params ?? [], R.sp, f.name) : [];
    const keep = { si: R.si, di: R.di, bp: R.bp, ds: R.ds, ss: R.ss, sp: R.sp };
    const outerSp = M.sp;
    M.sp = R.sp & ~1;                    // the C frame goes below the assembly's stack
    M.cpu.if = (R.flags >>> 9) & 1;
    let v;
    try { v = M.icall(p, args); } finally { M.sp = outerSp; }
    Object.assign(R, keep);
    R.flags = (R.flags & ~0x200) | (M.cpu.if << 9);
    toRegs(ft?.ret, v, R);
    R.ip = dv.getUint16(R.sp, true);
    R.cs = dv.getUint16((R.sp + 2) & 0xffff, true);
    if (!ft) { R.flags = dv.getUint16((R.sp + 4) & 0xffff, true); R.sp = (R.sp + 6) & 0xffff; }
    else R.sp = (R.sp + 4) & 0xffff;
  };

  /** Run from R.cs:R.ip until control comes back to FROM_C. */
  M.farRoute = (R) => {
    for (;;) {
      // A harness may keep the last transfers (M.farTrace = []): where a run went wrong is where it went.
      if (M.farTrace) { M.farTrace.push(`${R.cs.toString(16)}:${R.ip.toString(16)} sp=${R.sp.toString(16)}`); if (M.farTrace.length > 40) M.farTrace.shift(); }
      if (R.cs === FROM_C) return R;
      const run = owners.get(R.cs);
      if (run) { run(R); continue; }
      if (R.cs === C_SEG) { callC(R); continue; }
      if (M.x86exec) { M.x86exec(R, owners); continue; }
      throw new Error(`farcall: a far transfer to ${R.cs.toString(16)}:${R.ip.toString(16)}, code no module or C function owns `
        + '(bytes the program wrote at run time need an x86 executor: M.x86exec)');
    }
  };
  /** Claim a code segment for a translated module. */
  M.farOwn = (cs, run) => {
    if (cs === FROM_C || cs === C_SEG) throw new Error(`farcall: code segment ${cs.toString(16)} is reserved`);
    owners.set(cs, run);
  };
  /**
   * A far CALL from code that has no stack of its own in memory (Borland inline asm keeps PUSH/POP
   * in a JS array): a return address FROM_C:0 is pushed below C's stack, and `regs` -- the inline
   * asm's register file -- goes in and comes back.
   */
  M.farCall = (seg, off, regs) => {
    const dv = D();
    const sp = ((M.sp & ~1) - 64 - 4) & 0xffff;
    dv.setUint16(sp, 0, true);
    dv.setUint16(sp + 2, FROM_C, true);
    const flags = 2 | ((regs.cf & 1)) | ((regs.zf & 1) << 6) | ((regs.sf & 1) << 7) | (M.cpu.if << 9) | ((regs.of & 1) << 11);
    const R = { ax: regs.ax, bx: regs.bx, cx: regs.cx, dx: regs.dx, si: regs.si, di: regs.di, bp: regs.bp,
      sp, ds: regs.ds, es: regs.es, ss: 0, cs: seg & 0xffff, ip: off & 0xffff, flags };
    const outerSp = M.sp;
    M.sp = sp;                           // below the frame, for an interrupt delivered meanwhile
    try { M.farRoute(R); } finally { M.sp = outerSp; }
    for (const r of ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'ds', 'es']) regs[r] = R[r] & 0xffff;
    regs.cf = R.flags & 1; regs.zf = (R.flags >> 6) & 1; regs.sf = (R.flags >> 7) & 1; regs.of = (R.flags >> 11) & 1;
    const was = M.cpu.if;
    M.cpu.if = (R.flags >>> 9) & 1;
    if (!was && M.cpu.if) M.irqPoll?.();
  };
  return M;
}
