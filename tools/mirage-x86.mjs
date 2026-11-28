// mirage-x86.mjs — MIRAGE's CPU as PRISM's executor for x86 a program writes at run time.
//
// PRISM translates source; it cannot translate bytes that do not exist until the program runs.
// Wolf3D's WL_SCALE.C compiles one scaler per wall height (BuildCompScale: `mov al,[si+n]` /
// `mov es:[di+ofs],al` ... `retf`) and enters it with a far call (P11.4). src/asm/farcall.js routes
// a far transfer to a segment nothing translated owns to M.x86exec; this installs MIRAGE there --
// MIRAGE's own CPU and dynamic recompiler (https://github.com/jfrelat-lab/mirage, a sibling
// checkout), so PRISM itself depends on nothing: a harness opts in.
//
// ONE MEMORY. dos16m's image is the first megabyte at linear addresses, which is also MIRAGE's
// real-mode memory, so MIRAGE runs on PRISM's buffer itself: what the C wrote is what the CPU reads.
// The A000h window goes through PRISM's VGA (M.win, src/env/ega.js), as PRISM's own stores do.
//
// THE RETURN. The caller left FROM_C:0 (FFFF:0) on the stack; a HLT sits at linear FFFF0, so the
// callee's RETF lands on it and the CPU stops there. Control that leaves for anything else -- C, a
// translated module -- is refused by name: a scaler does neither.
//
// STALE CODE. MIRAGE invalidates a translation when a write it sees lands on its code; PRISM's C
// writes the scalers, and MIRAGE does not see those writes. So the harness names the functions that
// build code (`builders`), and every translation is dropped when one of them returns. Wolf3D's are
// SetupScaling (it builds, then locks every scaler in place with MM_SetLock).
import { join } from 'node:path';
import { FROM_C } from '../src/asm/farcall.js';

const HLT = 0xf4;

export async function installMirageX86(program, { mirage = process.env.PRISM_MIRAGE ?? join(process.env.HOME ?? '', 'Projects', 'mirage'), builders = [] } = {}) {
  const M = program.M;
  if (M.mod.model !== 'dos16m' && M.mod.model !== 'dos16l') throw new Error(`mirage-x86: a real-mode image is needed, not ${M.mod.model}`);
  const { Machine } = await import(join(mirage, 'src', 'machine.js'));
  const mach = new Machine({ memSize: 1 << 20 });
  const mem = mach.mem, cpu = mach.cpu;
  if (M.mod.u8.length !== mem.size) throw new Error('mirage-x86: the image is not one megabyte');
  mem.buffer = M.mod.buffer; mem.u8 = M.mod.u8; mem.dv = M.mod.dv;
  // The VGA window: PRISM's device, byte by byte.
  mem.vga = { readByte: (a) => M.win.r8(a), writeByte: (a, v) => M.win.w8(a, v), rebuildShadow() {} };
  mem.setPlanar(true);
  mach.rec.reset();
  M.mod.u8[(FROM_C << 4) & 0xfffff] = HLT;

  const stats = { calls: 0, blocks: 0, flushes: 0 };
  const flush = () => { mach.rec.reset(); stats.flushes++; };
  for (const name of builders) {
    const f = program.F[name];
    if (!f) throw new Error(`mirage-x86: no function '${name}' to watch`);
    const wrapped = (...a) => { try { return f(...a); } finally { flush(); } };
    program.F[name] = wrapped;
    program.mod.bindFunc(name, wrapped);
  }

  // ScaleLine plants a RETF in a scaler before each call and lifts it after: the target names it in
  // compile.codeWriters, so each of its stores arrives here and MIRAGE drops the blocks it overlaps.
  M.codeWritten = (addr, len) => mach.rec.invalidate(addr, len);

  const W = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
  M.x86exec = (R) => {
    stats.calls++;
    W.forEach((r, i) => { cpu.reg[i] = R[r] & 0xffff; });
    cpu.setSeg(0, R.es); cpu.setSeg(1, R.cs); cpu.setSeg(2, R.ss); cpu.setSeg(3, R.ds);
    cpu.eip = R.ip & 0xffff;
    cpu.flags = (R.flags & ~0x200) | 2;          // no interrupt while a scaler runs here
    cpu.halted = false;
    for (let guard = 0; ; guard++) {
      stats.blocks += mach.runSlice(10000);
      if (cpu.halted) break;
      if (guard > 1000) throw new Error(`mirage-x86: ${R.cs.toString(16)}:${R.ip.toString(16)} ran 10 million blocks without returning`);
    }
    const cs = cpu.seg[1], eip = cpu.eip & 0xffff;              // at the HLT, or just past it
    if (cs !== FROM_C || (eip !== 0 && eip !== 1)) throw new Error(`mirage-x86: halted at ${cs.toString(16)}:${eip.toString(16)}, not at the return`);
    W.forEach((r, i) => { R[r] = cpu.reg[i] & 0xffff; });
    R.es = cpu.seg[0]; R.ss = cpu.seg[2]; R.ds = cpu.seg[3];
    R.flags = (cpu.flags & 0xffff & ~0x200) | (R.flags & 0x200);
    R.cs = FROM_C; R.ip = 0;
  };
  return stats;
}
