// pit.js — the 8253 timer, counter 0, as the first device on PRISM's port seam.
//
// It is here because Quake's DOS build reads the clock through it, and reads it exactly the way DOS
// programs did (sys_dos.c, Sys_FloatTime):
//
//     t    = *(unsigned short *)real2ptr(0x46c) * 65536;   // the BIOS tick count
//     dos_outportb(0x43, 0);                               // latch counter 0
//     r    = dos_inportb(0x40);                            // low byte
//     r   |= dos_inportb(0x40) << 8;                       // high byte
//     tick = *(unsigned short *)real2ptr(0x46c) * 65536;   // and again, to catch a wrap
//
// Two things are worth noticing about that. It needs **no interrupt**: the program polls, so PRISM
// needs a counter, not an interrupt controller. And it reads the BIOS tick straight out of memory at
// 0x46C — which works only because PRISM reserves the PC's low megabyte, so that address is real.
//
// The semantics are MIRAGE's, copied so the two agree when its own PIT is eventually shared: counter
// 0 counts DOWN from its reload at 1.193182 MHz, reads return LSB then MSB per the access mode, and a
// latch command freezes the value the next reads see. What differs is the time source. MIRAGE derives
// the count from emulated CPU cycles, because that is what it has; PRISM derives it from a clock,
// because that is what IT has. Same observable device, different foundation.

import { BDA } from '../link/module.js';

const PIT_HZ = 1193182;
const TICK_HZ = PIT_HZ / 65536;          // 18.2065 Hz, the BIOS tick rate
const BDA_TICKS = BDA + 0x6c;            // 0040:006C, the count since midnight

/**
 * `micros` supplies elapsed time in microseconds. The default advances a fixed step per QUERY rather
 * than reading a clock, which keeps a headless run reproducible — the same rule the rest of the
 * runtime follows, and it still makes time move for a program that polls, which is the only thing a
 * polling program needs.
 */
export function installPIT(machine, M, { micros = null } = {}) {
  let synthetic = 0;
  const clock = micros ?? (() => (synthetic += 100));

  const pit = {
    reload: 0x10000,        // 0 means 65536, and that is the BIOS default: 18.2 Hz
    access: 3,              // 1 = LSB, 2 = MSB, 3 = LSB then MSB
    hiNext: false,          // writing a reload, low byte first
    readHi: false,          // reading a count, low byte first
    lo: 0,
    latched: -1,            // >= 0 while a latch command's value is pending
  };

  /** The live countdown, derived from elapsed time rather than from CPU cycles. */
  function count() {
    const elapsed = clock() / 1e6;                       // seconds
    const pulses = Math.floor(elapsed * PIT_HZ);
    return (pit.reload - (pulses % pit.reload)) & 0xffff;
  }

  /*
   * The BIOS tick lives in MEMORY, and PRISM cannot trap a memory read — so it is refreshed whenever
   * the program touches the timer's ports, which is exactly when a program that cares is looking.
   * Stated as the limitation it is: a program that reads 0x46C and never touches a port would see a
   * frozen clock. Quake latches the counter between its two reads of 0x46C, so it sees a fresh one.
   */
  function refreshBdaTick() {
    const ticks = Math.floor((clock() / 1e6) * TICK_HZ) & 0xffff;
    M.mod.dv.setUint16(BDA_TICKS, ticks, true);
  }

  machine.onPortWrite(0x43, (_p, _s, v) => {
    v &= 0xff;
    if (((v >> 6) & 3) !== 0) return;                    // counters 1 and 2 do not drive anything here
    pit.readHi = false;                                   // any command to counter 0 re-aligns reads
    const access = (v >> 4) & 3;
    if (access === 0) { pit.latched = count(); refreshBdaTick(); return; }   // latch for reading
    pit.access = access;
    pit.hiNext = false;
  });

  machine.onPortWrite(0x40, (_p, _s, v) => {
    v &= 0xff;
    let reload;
    if (pit.access === 1) reload = v;
    else if (pit.access === 2) reload = v << 8;
    else {
      if (!pit.hiNext) { pit.lo = v; pit.hiNext = true; return; }
      reload = (v << 8) | pit.lo;
      pit.hiNext = false;
    }
    pit.reload = reload === 0 ? 0x10000 : reload;
  });

  machine.onPortRead(0x40, () => {
    refreshBdaTick();
    const c = pit.latched >= 0 ? pit.latched : count();
    if (pit.access === 1) { pit.latched = -1; return c & 0xff; }
    if (pit.access === 2) { pit.latched = -1; return (c >> 8) & 0xff; }
    const b = pit.readHi ? (c >> 8) & 0xff : c & 0xff;
    pit.readHi = !pit.readHi;
    if (!pit.readHi) pit.latched = -1;                   // both halves read: the latch is spent
    return b;
  });

  refreshBdaTick();
  M.pit = pit;
  return pit;
}
