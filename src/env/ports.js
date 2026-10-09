// ports.js — I/O ports, and the seam where MIRAGE's devices can plug into PRISM.
//
// A port write is the universal low-level verb. MIRAGE reaches it by emulating `out dx, al`; PRISM
// reaches it because a DJGPP program calls `outportb(port, value)`, which is an ordinary function
// call once PRISM supplies `pc.h`. The device on the other side cannot tell the difference — and that
// is the whole basis for the two projects meeting in the middle: MIRAGE owns the low level, PRISM
// owns the high level, and this is the boundary.
//
// The contract is MIRAGE's, deliberately copied rather than invented:
//
//     machine.onPortWrite(port, (port, size, value) => void)
//     machine.onPortRead (port, (port, size) => value)
//     machine.mem                                   // the guest's memory views
//
// so that `installVGA(machine)` and its siblings install into PRISM unchanged. What PRISM cannot
// offer is the other half of MIRAGE's model: a CPU that traps MEMORY as well as ports. Ports are a
// function call and cost nothing to intercept; a write to the 0xA0000 window is a plain store into
// the guest image, which is free for a linear mode like 13h and needs a write barrier for a planar
// one. That asymmetry decides how far the collaboration reaches, and it is measured, not assumed.

import { checkLeash } from '../runtime/runtime.js';

/**
 * A port with no device answers 0xFF on read and swallows writes — which is what an ISA bus does
 * with nothing driving it, and what a program probing for absent hardware expects to see.
 */
const FLOATING = 0xff;

export function installPorts(M, { trace = false } = {}) {
  const readers = new Map();
  const writers = new Map();
  const seen = trace ? new Map() : null;

  const machine = {
    // Devices reach the guest's memory through this. MIRAGE's devices also use `mem.planar`,
    // `mem.shadow` and `mem.vga`; those appear here when a device that needs them is actually
    // installed, not before.
    mem: { u8: M.u8, dv: M.mod.dv },

    onPortRead(port, fn) { readers.set(port & 0xffff, fn); },
    onPortWrite(port, fn) { writers.set(port & 0xffff, fn); },

    /*
     * THE RUN LEASH IS CHECKED HERE, and it took a hang to learn why it has to be.
     *
     * `--seconds` sets M.leashDeadline, and runtime.js tests it at safepoints and when the clock
     * advances. A DOS-era spin loop reaches NEITHER -- it polls a port and calls nothing else -- so
     * the one mechanism meant to bound a hang could not see the hang. Measured on Jump 'n Bump,
     * stuck in `while (key_pressed(1) == 1) dj_mix();`: a 40 s leash was still not enforced three
     * minutes later and the process had to be killed from outside.
     *
     * A port poll is the one thing every loop of this class does, which is what makes this the right
     * place: a compare against a number, on a path a program in trouble is already hammering, and
     * free (checkLeash returns at once) for every program that never asked for a leash.
     */
    read(port, size = 1) {
      checkLeash(M);
      const p = port & 0xffff;
      if (seen) seen.set(`r${p.toString(16)}`, (seen.get(`r${p.toString(16)}`) || 0) + 1);
      const fn = readers.get(p);
      if (!fn) return FLOATING;
      const v = fn(p, size);
      return size === 4 ? v >>> 0 : v & (size === 2 ? 0xffff : 0xff);
    },

    write(port, size, value) {
      const p = port & 0xffff;
      if (seen) seen.set(`w${p.toString(16)}`, (seen.get(`w${p.toString(16)}`) || 0) + 1);
      const fn = writers.get(p);
      if (fn) fn(p, size, value & (size === 2 ? 0xffff : 0xff));
    },

    /** What a program actually touched — the only honest way to know which device to write next. */
    traffic() { return seen ? Object.fromEntries(seen) : null; },
  };

  /*
   * DJGPP's own pc.h defines these as inline assembly, because on real hardware they ARE two
   * instructions. PRISM supplies pc.h, and declares them as functions instead — the same move as
   * supplying stdio.h, and it is what removes inline-asm support from the critical path entirely.
   * Measured before deciding: neither MAME's msdos.c nor Quake's sys_dos.c contains a single asm
   * statement of its own; every port access in both goes through this header.
   */
  Object.assign(M.rt, {
    inportb: (p) => machine.read(p, 1) & 0xff,
    inportw: (p) => machine.read(p, 2) & 0xffff,
    outportb: (p, v) => { machine.write(p, 1, v | 0); },
    outportw: (p, v) => { machine.write(p, 2, v | 0); },
    inportl: (p) => machine.read(p, 4) >>> 0,
    outportl: (p, v) => { machine.write(p, 4, v | 0); },
    // The text screen of pc.h. There is none here -- the page shows the program's output as a stream --
    // so clearing it and moving its cursor have nothing to act on.
    ScreenClear: () => {},
    ScreenSetCursor: () => {},
    // DJGPP spells them both ways; a program may use either.
    inp: (p) => machine.read(p, 1) & 0xff,
    outp: (p, v) => { machine.write(p, 1, v | 0); return v | 0; },
  });

  M.machine = machine;
  return machine;
}
