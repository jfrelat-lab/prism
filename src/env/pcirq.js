// pcirq.js — hardware interrupts for a real-mode program: a virtual clock, the 8253's counter 0 as
// the source of IRQ0, an 8259 that holds it until the handler acknowledges it, and delivery to
// whatever the vector table holds for int 8 -- the program's own handler, or the BIOS's.
//
// TIME IS COUNTED IN BACK EDGES. PRISM executes no instructions it could count, but every loop --
// in compiled C, in Borland inline assembly, in a translated TASM module -- decrements M.spBudget on
// its back edge, and each one is `usPerEdge` virtual microseconds (default 1). The budget is set to
// the number of edges left until the next PIT expiry, so M.sp_ runs exactly when IRQ0 is due and
// the check costs a decrement the rest of the time. This is a MODEL, chosen once and stated: a
// program that calibrates itself against the timer -- Keen Dreams' SDL_InitDelay counts `loop`
// iterations per millisecond -- measures this clock, and gets a consistent, reproducible answer that
// is not a 1991 PC's. Straight-line code costs nothing; only iterations do.
//
// DELIVERY is what an 8086 does at an instruction boundary with IF set: the interrupt gate clears IF,
// the handler runs, IRET restores the flags. The interrupted code's registers are handed to the
// handler as its entry registers (M.isrRegs), which is what a Borland `interrupt` function sees after
// its prologue pushes them -- SDL_TimingService reads the interrupted loop's CX that way. Delivery
// happens only at back edges, so an interrupt waits at most one loop iteration: a program cannot tell
// the difference from the instruction boundary it would have come at.
//
// THE PIC is the part of an 8259 these programs use: IRQ0 raised by the PIT, held until an EOI (OUT
// 20h,20h) while one is in service, maskable through port 21h. Nothing else is modelled; a write to
// its other registers is ignored as the initialisation it would be.

import { BDA } from '../link/module.js';
import { checkLeash } from '../runtime/runtime.js';

const PIT_HZ = 1193182;
const BDA_TICKS = BDA + 0x6c;

/*
 * THE KEYBOARD is the 8042's data port and IRQ1: the harness gives scancodes with the virtual time
 * they arrive at (`keys: [{ ms, scan }]`, or M.keyboard.at(ms, ...scans) later), each is latched into
 * port 60h when the previous one has been taken, and IRQ1 raised for it. The program's int 9 handler
 * reads 60h and acknowledges on 61h and 20h, as Keen Dreams' INL_KeyService does; with no handler of
 * its own, the BIOS's int 9 puts the key in the queue int 16h answers from (src/env/dos.js).
 */
// Make codes to ASCII, unshifted, for the BIOS's own int 9: enough for "press a key".
const SCAN_ASCII = { 0x01: 27, 0x1c: 13, 0x39: 32, 0x0e: 8, 0x0f: 9,
  ...Object.fromEntries([...'1234567890'].map((c, k) => [0x02 + k, c.charCodeAt(0)])),
  ...Object.fromEntries([...'qwertyuiop'].map((c, k) => [0x10 + k, c.charCodeAt(0)])),
  ...Object.fromEntries([...'asdfghjkl'].map((c, k) => [0x1e + k, c.charCodeAt(0)])),
  ...Object.fromEntries([...'zxcvbnm'].map((c, k) => [0x2c + k, c.charCodeAt(0)])) };

export function installPcIrq(M, { usPerEdge = 1, keys = [] } = {}) {
  const machine = M.machine;
  if (!machine) throw new Error('pcirq: no port seam (installPorts) on this machine');
  const dv = () => M.mod.dv;
  M.cpu ??= { if: 1 };
  const clock = M.vclock = { us: 0, usPerEdge };
  const pic = { imr: 0, irr: 0, isr: 0 };
  const pit = { reload: 0x10000, access: 3, hiNext: false, readHi: false, lo: 0, latched: -1 };
  const periodUs = () => pit.reload * 1e6 / PIT_HZ;
  let due = periodUs();
  const kbd = { script: [...keys].map((k) => ({ us: k.ms * 1000, scan: k.scan & 0xff })).sort((a, b) => a.us - b.us),
    data: 0, full: false, port61: 0 };
  M.keyboard = {
    at: (ms, ...scans) => { for (const scan of scans) kbd.script.push({ us: ms * 1000, scan: scan & 0xff }); kbd.script.sort((a, b) => a.us - b.us); schedule(); },
    pending: () => kbd.script.length + (kbd.full ? 1 : 0),
  };
  // A due scancode is latched once the port is free, and raises IRQ1.
  const keyboardDue = () => {
    if (!kbd.full && kbd.script.length && kbd.script[0].us <= clock.us) {
      kbd.data = kbd.script.shift().scan; kbd.full = true; pic.irr |= 2;
    }
  };
  // Bring the clock up to date with the edges spent since the budget was last set; every reader of
  // time goes through here, so a port access between two safepoints sees the time of that access.
  const sync = () => {
    clock.us += ((M.spSet ?? M.spBudget) - M.spBudget) * clock.usPerEdge;
    M.spSet = M.spBudget;
    while (clock.us >= due) { pic.irr |= 1; due += periodUs(); }
    keyboardDue();
  };

  // --- the 8253, counter 0
  const count = () => {
    sync();
    const left = Math.max(0, due - clock.us);
    return Math.min(pit.reload, Math.ceil(left * PIT_HZ / 1e6)) & 0xffff;
  };
  machine.onPortWrite(0x43, (_p, _s, v) => {
    v &= 0xff;
    if (((v >> 6) & 3) !== 0) return;
    pit.readHi = false;
    const access = (v >> 4) & 3;
    if (access === 0) { pit.latched = count(); return; }
    pit.access = access; pit.hiNext = false;
  });
  machine.onPortWrite(0x40, (_p, _s, v) => {
    v &= 0xff;
    let reload;
    if (pit.access === 1) reload = v;
    else if (pit.access === 2) reload = v << 8;
    else {
      if (!pit.hiNext) { pit.lo = v; pit.hiNext = true; return; }
      reload = (v << 8) | pit.lo; pit.hiNext = false;
    }
    sync();
    pit.reload = reload === 0 ? 0x10000 : reload;
    due = clock.us + periodUs();               // a new count starts now
    schedule();
  });
  machine.onPortRead(0x40, () => {
    const c = pit.latched >= 0 ? pit.latched : count();
    if (pit.access === 1) { pit.latched = -1; return c & 0xff; }
    if (pit.access === 2) { pit.latched = -1; return (c >> 8) & 0xff; }
    const b = pit.readHi ? (c >> 8) & 0xff : c & 0xff;
    pit.readHi = !pit.readHi;
    if (!pit.readHi) pit.latched = -1;
    return b;
  });

  // --- the 8042: data on 60h (reading takes the byte), 61h's acknowledge bit is kept and ignored
  machine.onPortRead(0x60, () => { kbd.full = false; return kbd.data; });
  machine.onPortRead(0x64, () => (kbd.full ? 1 : 0));
  machine.onPortRead(0x61, () => kbd.port61);
  machine.onPortWrite(0x61, (_p, _s, v) => { kbd.port61 = v & 0xff; });

  /*
   * --- the display's timing, as a VGA's input status register 1 (3DAh) reports it: 70 Hz frames of
   * 449 lines at 31.47 kHz, the last 2 lines of each frame in vertical retrace (bit 3), and bits 0
   * set while the beam is blanked -- the last fifth of every line, and all of vertical retrace.
   * VW_WaitVBL and VW_SetScreen poll exactly these two bits. Time is the virtual clock above, so a
   * polling loop sees the beam move as its own iterations spend time.
   */
  const LINE_US = 1e6 / 31469, LINES = 449, FRAME_US = LINE_US * LINES, VRETRACE_LINES = 2;
  machine.onPortRead(0x3da, () => {
    sync();
    const inFrame = clock.us % FRAME_US;
    const line = Math.floor(inFrame / LINE_US);
    const vr = line >= LINES - VRETRACE_LINES;
    const hblank = (inFrame % LINE_US) > LINE_US * 0.8;
    return (vr ? 0x08 : 0) | (vr || hblank ? 0x01 : 0);
  });

  // --- the 8259: EOI on 20h clears the highest-priority request in service; the mask on 21h
  machine.onPortWrite(0x20, (_p, _s, v) => { if ((v & 0xff) === 0x20) pic.isr &= pic.isr - 1; });
  machine.onPortWrite(0x21, (_p, _s, v) => { pic.imr = v & 0xff; });
  machine.onPortRead(0x21, () => pic.imr);
  machine.onPortRead(0x20, () => pic.irr);

  // --- the BIOS's own int 8, in the vector table until the program replaces it: the tick count at
  // 0040:006C, then the EOI.
  const biosInt8 = () => {
    dv().setUint32(BDA_TICKS, (dv().getUint32(BDA_TICKS, true) + 1) >>> 0, true);
    pic.isr &= ~1;
  };
  const biosInt9 = () => {
    const scan = machine.read(0x60, 1);
    if (!(scan & 0x80) && M.keyQueue) M.keyQueue.push((scan << 8) | (SCAN_ASCII[scan] ?? 0));
    pic.isr &= ~2;
  };
  for (const [n, name, fn] of [[8, '__bios_int8', biosInt8], [9, '__bios_int9', biosInt9]]) {
    const f = M.mod.defineFunc(name, null);
    M.mod.bindFunc(name, fn);
    dv().setUint32(n * 4, f.addr >>> 0, true);
  }

  const deliver = (n, regs) => {
    const v = dv().getUint32(n * 4, true);
    if (!v) throw new Error(`IRQ for int ${n.toString(16)}h: the vector table holds nothing there`);
    const saved = M.cpu.if;
    M.cpu.if = 0;                               // the interrupt gate
    const outer = M.isrRegs;
    M.isrRegs = typeof regs === 'function' ? regs() : regs;
    try { M.icall(v, []); } finally { M.cpu.if = saved; M.isrRegs = outer; }   // IRET
  };

  // Edges until the next event -- the PIT's expiry or a scancode's arrival.
  function schedule() {
    const next = Math.min(due, kbd.script.length && !kbd.full ? kbd.script[0].us : Infinity);
    const edges = Math.max(1, Math.ceil((next - clock.us) / clock.usPerEdge));
    const cap = M.leashDeadline ? (1 << 20) : (1 << 30);
    M.spSet = M.spBudget = Math.min(edges, cap);
  }

  /*
   * STI (enable(), `sti`, a POPF or _FLAGS that sets IF, a TASM routine returning with IF set): a
   * request held while IF was clear is delivered right away, as the 8086 delivers it after the
   * instruction that follows STI -- not at the next timer expiry.
   */
  M.irqPoll = (regs = null) => { sync(); dispatch(regs, M.cpu.if); schedule(); };

  M.sp_ = (_id, regs = null, ifNow = null) => {
    sync();
    checkLeash(M);
    dispatch(regs, ifNow ?? M.cpu.if);
    schedule();
  };
  // The highest-priority request not masked, and not below one already in service -- and again after
  // each IRET, as the PIC raises INTR at once for the next request still pending.
  function dispatch(regs, enabled) {
    if (!enabled) return;
    for (let guard = 0; guard < 16; guard++) {
      let served = false;
      for (const irq of [0, 1]) {
        const bit = 1 << irq;
        if (!(pic.irr & bit) || (pic.imr & bit)) continue;
        if (pic.isr & ((bit << 1) - 1)) break;
        pic.irr &= ~bit;
        pic.isr |= bit;
        deliver(8 + irq, regs);
        served = true;
        break;
      }
      if (!served || !M.cpu.if) return;
    }
  }
  schedule();
  return { clock, pic, pit };
}
