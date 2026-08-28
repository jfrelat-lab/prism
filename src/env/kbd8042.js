// kbd8042.js — the keyboard controller, ports 0x60 and 0x64. The third device, and the last one a
// DOS game of this era needs.
//
// It is small because the interesting part is not here. A DOS game does not poll the keyboard: it
// installs an interrupt handler, and the handler reads one byte:
//
//     void __interrupt I_KeyboardISR (void) {          // Heretic, I_IBM.C
//         keyboardque[kbdhead & (KBDQUESIZE-1)] = lastpress = _inbyte(0x60);
//         kbdhead++;
//         _outbyte(0x20, 0x20);                        // acknowledge the interrupt
//     }
//
// So the host's job is two halves that meet: put a scan code where port 0x60 will read it, and CALL
// the handler. The second half is `deliverKeyboard` in src/env/watcom.js and it works by the same
// mechanism as everything asynchronous here — a registered handler is a function pointer PRISM can
// call, and the safepoint is where it can be called from.
//
// The game's own ISR then runs, filling the game's own ring buffer, and nothing about the keyboard is
// special-cased anywhere: PRISM never touches `keyboardque`.
//
//   0x60  data: the next scan code, or the last one again if the queue is empty
//   0x64  status: bit 0 = output buffer full, bit 1 = input buffer full (never)
//
// Set 1, the codes the PC controller really produced: a press is the code, a release is the code
// with bit 7 set. src/env/scancodes.js maps a browser key to one.

const OBF = 0x01;          // status bit 0: a byte is waiting in the output buffer

export function installKbd8042(machine, { onAck = null } = {}) {
  const queue = [];
  let last = 0;

  machine.onPortRead(0x60, () => {
    /*
     * An empty queue returns the LAST code rather than zero. A real controller holds its output
     * buffer until it is overwritten, and 0 is a meaningful scan code on set 1 (an error/overrun
     * indication) that some handlers act on -- so inventing one is worse than repeating the truth.
     */
    if (queue.length) last = queue.shift();
    return last & 0xff;
  });

  machine.onPortRead(0x64, () => (queue.length ? OBF : 0));

  /*
   * The PIC's end-of-interrupt. Swallowed, because there is no PIC to unmask -- but noticed, because
   * a handler that writes it is a handler that ran, and that is worth being able to observe from a
   * harness.
   */
  machine.onPortWrite(0x20, () => { if (onAck) onAck(); });
  // 0x64 also takes commands (0xAE enable, 0xAD disable); accepting them is the whole response.
  machine.onPortWrite(0x64, () => {});
  machine.onPortWrite(0x60, () => {});

  return {
    /** Queue one raw set-1 code. Press and release are separate codes, as the hardware sends them. */
    push(code) { queue.push(code & 0xff); },
    /** A key going down then up, which is what a menu keypress is. */
    tap(code) { queue.push(code & 0x7f, (code & 0x7f) | 0x80); },
    /*
     * Take one code, or 0 when there is none. Port 0x60 deliberately repeats the LAST code on an
     * empty queue, because that is what the hardware latch does; a BIOS INT 16h caller needs the
     * other answer -- "nothing is waiting" -- so it gets its own door rather than a flag on that one.
     */
    take() { return queue.length ? queue.shift() : 0; },
    get pending() { return queue.length; },
  };
}
