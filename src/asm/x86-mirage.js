// x86-mirage.js — MIRAGE's CPU as PRISM's executor for x86 a program writes at run time.
//
// PRISM translates source; it cannot translate bytes that do not exist until the program runs.
// Wolf3D's WL_SCALE.C compiles one scaler per wall height (BuildCompScale: `mov al,[si+n]` /
// `mov es:[di+ofs],al` ... `retf`) and enters it with a far call (P11.4). src/asm/farcall.js routes
// a far transfer to a segment nothing translated owns to M.x86exec; this installs MIRAGE there.
//
// MIRAGE IS A SIBLING PROJECT (https://github.com/jfrelat-lab/mirage). Its CPU core is vendored in
// src/vendor/mirage by tools/vendor-mirage.mjs, verbatim and at a recorded commit, and loaded only
// when a target asks (`x86: { executor: "mirage" }`). THIS FILE IS THE BRIDGE: everything PRISM
// touches of MIRAGE is here, so a change on either side has one place to land. It uses
//   new Machine({ memSize })                     a bare machine: CPU, recompiler, memory, no devices
//   mem.buffer / u8 / dv / size, mem.vga, mem.setPlanar(true)
//                                                the memory it runs on, and its A000h window
//   rec.reset(), rec.invalidate(addr, len)       dropping translations, all or byte-precise
//   cpu.reg[], cpu.setSeg(i, v), cpu.seg[], cpu.eip, cpu.flags, cpu.halted, runSlice(n)
//
// ONE MEMORY. dos16m's image is the first megabyte at linear addresses, which is also MIRAGE's
// real-mode memory, so MIRAGE runs on PRISM's buffer itself: what the C wrote is what the CPU reads.
// The A000h window goes through PRISM's VGA (M.win, src/env/ega.js), as PRISM's own stores do.
//
// THE RETURN. The caller left FROM_C:0 (FFFF:0) on the stack; a HLT sits at linear FFFF0, so the
// callee's RETF lands on it and the CPU stops there. Control that leaves for anything else -- C, a
// translated module -- is refused by name: a scaler does neither.
//
// STALE CODE. MIRAGE invalidates a translation when a write IT sees lands on its code; PRISM's C
// writes the scalers, and MIRAGE does not see those writes. Two seams say so: `builders` are the
// functions that build code, and every translation is dropped when one returns (Wolf3D's
// SetupScaling); and a target's compile.codeWriters report each inline-asm store to M.codeWritten,
// which drops only the blocks it overlaps (ScaleLine plants a RETF in a scaler and lifts it after).
import { FROM_C } from './farcall.js';

const HLT = 0xf4;

/**
 * Install MIRAGE as `program`'s x86 executor. `Machine` is MIRAGE's class -- the vendored one unless
 * a caller passes another (a MIRAGE checkout under development). Returns live counters.
 */
export async function installX86Mirage(program, { builders = [], Machine = null } = {}) {
  const M = program.M;
  if (M.mod.model !== 'dos16m' && M.mod.model !== 'dos16l') throw new Error(`x86-mirage: a real-mode image is needed, not ${M.mod.model}`);
  if (!Machine) ({ Machine } = await import('../vendor/mirage/machine.js'));
  const mach = new Machine({ memSize: 1 << 20 });
  const mem = mach.mem, cpu = mach.cpu;
  if (M.mod.u8.length !== mem.size) throw new Error('x86-mirage: the image is not one megabyte');
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
    if (!f) throw new Error(`x86-mirage: no function '${name}' to watch`);
    const wrapped = (...a) => { try { return f(...a); } finally { flush(); } };
    program.F[name] = wrapped;
    program.mod.bindFunc(name, wrapped);
  }
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
      if (guard > 1000) throw new Error(`x86-mirage: ${R.cs.toString(16)}:${R.ip.toString(16)} ran 10 million blocks without returning`);
    }
    const cs = cpu.seg[1], eip = cpu.eip & 0xffff;              // at the HLT, or just past it
    if (cs !== FROM_C || (eip !== 0 && eip !== 1)) throw new Error(`x86-mirage: halted at ${cs.toString(16)}:${eip.toString(16)}, not at the return`);
    W.forEach((r, i) => { R[r] = cpu.reg[i] & 0xffff; });
    R.es = cpu.seg[0]; R.ss = cpu.seg[2]; R.ds = cpu.seg[3];
    R.flags = (cpu.flags & 0xffff & ~0x200) | (R.flags & 0x200);
    R.cs = FROM_C; R.ip = 0;
  };
  return stats;
}

/** A target's `x86` entry, installed: `{ executor: "mirage", builders: [...] }`. Null when it has none. */
export async function installTargetX86(program, x86, opts = {}) {
  if (!x86) return null;
  if (x86.executor !== 'mirage') throw new Error(`no x86 executor '${x86.executor}' (only "mirage")`);
  return installX86Mirage(program, { builders: x86.builders ?? [], ...opts });
}
