// crtstatus.js — the VGA input status register, 0x3DA. The smallest device that matters.
//
// Every DOS game of this era paces itself on the vertical retrace, and it does it by POLLING:
//
//     do { stat = inp(STATUS_REGISTER_1); if (stat & 8) break; } while (1);   // Heretic, I_WaitVBL
//     do { stat = inp(STATUS_REGISTER_1); if (!(stat & 8)) break; } while (1);
//
// A port that answers a constant makes that loop eternal — 970 million iterations before the
// safepoint profiler named it. The bit has to *change*, and there is no way around that: the
// program's entire notion of time passing is this one bit alternating.
//
// So this is a device, not a stub, and it is the first one where PRISM has to model something the
// hardware does rather than answer a question the program asked.
//
//   bit 3 (0x08)  vertical retrace in progress
//   bit 0 (0x01)  display disabled (horizontal or vertical blanking)
//
// The other thing 0x3DA does is reset the attribute controller's address/data flip-flop, which is
// why programs read it before writing 0x3C0. That happens for free: the read has no side effect
// here because the attribute controller is not modelled either.

/**
 * Install the status register.
 *
 * `now` returns guest microseconds. Given a real clock the retrace follows real time, which is what
 * makes the program's own pacing loop pace it correctly; without one it advances per READ, which is
 * deterministic and still terminates every wait — a gate needs the same bytes every run far more
 * than it needs a faithful frame rate.
 */
export function installCrtStatus(machine, { now = null, hz = 70, retraceFraction = 1 / 16 } = {}) {
  const periodUs = 1e6 / hz;
  const retraceUs = periodUs * retraceFraction;

  /*
   * The read-driven fallback. The cycle is deliberately SHORT: a wait loop costs one full cycle of
   * reads, so a 64-read cycle means I_WaitVBL(1) returns after about a hundred polls instead of
   * spinning. Long enough that a program measuring the retrace sees a plausible duty cycle, short
   * enough that nothing waits perceptibly.
   */
  const CYCLE = 64;
  const RETRACE_READS = 4;
  let reads = 0;

  machine.onPortRead(0x3da, () => {
    let inRetrace;
    if (now) {
      const t = now() % periodUs;
      inRetrace = t < retraceUs;
    } else {
      inRetrace = (reads++ % CYCLE) < RETRACE_READS;
    }
    // bit 0 tracks bit 3 here: display is disabled during vertical retrace, and nothing in these
    // games distinguishes horizontal blanking.
    return inRetrace ? 0x09 : 0x00;
  });

  // 0x3BA is the monochrome alias of the same register; a program that guessed the wrong adapter
  // still gets a coherent answer rather than a constant.
  machine.onPortRead(0x3ba, (p, size) => machine.read(0x3da, size));

  return { get reads() { return reads; } };
}
