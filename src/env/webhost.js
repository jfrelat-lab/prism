// webhost.js — the contract between a PRISM guest and a browser that displays it.
//
// The problem this solves: a C program's main loop is synchronous and never yields. MAME 0.1 spins
// in `run_machine` until a key says stop; Quake spins in `Host_Frame`. There is no point at which a
// browser could paint. Emscripten's answer is to REWRITE the loop (emscripten_set_main_loop), which
// is exactly the source modification this project exists to avoid.
//
// PRISM's answer instead: the guest runs in a Web Worker over a SharedArrayBuffer, and the page
// OBSERVES the guest's memory while it runs. Nothing yields, nothing is rewritten, and the display
// is a read of guest memory at whatever moment the page happens to paint.
//
// That needs two shared regions:
//
//   * the guest image itself (Module.buffer, a SharedArrayBuffer) — read directly for pixels
//   * this small CONTROL block, the only thing the two sides agree on
//
// The control block is deliberately tiny and untyped-by-design: a platform layer publishes where the
// framebuffer is and what the palette holds, the page publishes which keys are down. Neither side
// knows what program is running. Adding a new program means writing its platform layer, not touching
// the page.
//
// Torn reads are accepted for pixels: the page may paint a framebuffer the guest is halfway through
// writing. That shows as a tear, never as corruption, and costs nothing — whereas double-buffering
// would need the guest to yield, which is the thing it cannot do.

/** Int32 slot indices in the control block. Slots 0-15 are guest→host, 16-23 host→guest. */
export const SLOT = {
  STATE: 0,        // see STATE below
  WIDTH: 1,
  HEIGHT: 2,
  PIXELS: 3,       // guest address of the display's pixel data (8-bit, one byte per pixel)
  FRAME: 4,        // incremented once per presented frame
  PALGEN: 5,       // incremented whenever the palette changes, so the page re-reads it lazily
  EXITCODE: 6,
  PENS: 7,         // how many palette entries are valid

  ACK: 16,         // host → guest: frames the page has painted. Pacing reads this.
  STOP: 17,        // host → guest: 1 asks the program to quit through its own quit path
  PAUSE: 18,
  SPEED: 19,       // host → guest: max frames the guest may run ahead of ACK (0 = unthrottled)
};

export const STATE = { BOOT: 0, FETCHING: 1, COMPILING: 2, RUNNING: 3, EXITED: 4, ERROR: 5 };

// Byte offsets inside the control block.
const CTRL_INTS = 512;              // 128 int32 slots, more than the contract needs
const KEYS_AT = 512;                // 256 bytes: one per PC set-1 scancode, 1 = down
const LATCH_AT = 768;               // 256 bytes: a key that went down since the guest last looked
const PAL_AT = 1024;                // 256 * 3 bytes, r,g,b
export const CONTROL_BYTES = 2048;

/** Allocate the control block. Called by the page; the worker receives the same buffer. */
export function makeControl() {
  return new SharedArrayBuffer(CONTROL_BYTES);
}

/** The three views both sides use. Identical code on page and worker, so they cannot disagree. */
export function controlViews(sab) {
  return {
    ctrl: new Int32Array(sab, 0, CTRL_INTS / 4),
    keys: new Uint8Array(sab, KEYS_AT, 256),
    latch: new Uint8Array(sab, LATCH_AT, 256),
    pal: new Uint8Array(sab, PAL_AT, 768),
  };
}

/**
 * Pace the guest to the page's paint rate, from inside the guest's own present call.
 *
 * Without this the guest runs flat out: MAME 0.1 reached 400 frames a second, which is not a game,
 * it is a blur, and a keypress lasting 16 ms was sampled dozens of times. `Atomics.wait` blocks the
 * WORKER only — the page keeps painting, which is what releases the wait.
 *
 * The timeout is not optional: if the page stops acknowledging (tab hidden, page closed), a wait
 * with no timeout would hang the worker forever with no way to stop it.
 */
export function paceFrame(ctrl) {
  const ahead = Atomics.load(ctrl, SLOT.SPEED);
  for (;;) {
    if (Atomics.load(ctrl, SLOT.STOP)) return;
    const paused = Atomics.load(ctrl, SLOT.PAUSE);
    if (!paused && !ahead) return;
    const behind = Atomics.load(ctrl, SLOT.FRAME) - Atomics.load(ctrl, SLOT.ACK);
    if (!paused && behind < ahead) return;
    // Wait on ACK, so the page's next paint wakes us rather than a poll interval.
    Atomics.wait(ctrl, SLOT.ACK, Atomics.load(ctrl, SLOT.ACK), 50);
  }
}

/**
 * Read keys the way a guest expects, including taps it would otherwise never see.
 *
 * The physical byte is not enough. The guest samples its keyboard once per frame at best, and a real
 * key tap lasts 30-80 ms; when the page is throttled — a background tab drops the acknowledgement
 * timer to about 2 Hz — a whole press and release fits between two samples and vanishes. Inserting a
 * coin in Pac-Man silently did nothing.
 *
 * So a keydown also sets a LATCH, which stays set until the guest has both seen it and reached the
 * end of a frame. A tap is then worth exactly one guest frame of "held", whatever the two sides'
 * relative speeds.
 *
 * The spin guard is not hypothetical: MAME 0.1 contains `while (osd_key_pressed(OSD_KEY_P));` to
 * wait for a release, and that loop never presents a frame. A latch cleared only at frame boundaries
 * would hang the guest there forever, so a latch also expires after enough reads with no frame.
 */
/*
 * How many guest frames a tapped key stays held. MEASURED, not chosen: against Pac-Man's coin input,
 * 1 frame and 4 frames both registered nothing, 8 frames registered exactly one coin, and a physical
 * hold spanning 6 frames registered two. The game's ROM debounces the input, so the shell has to
 * present a tap as a press of real duration rather than a pulse.
 */
export const KEY_HOLD_FRAMES = 8;

export function makeKeyReader({ keys, latch }) {
  const observed = new Set();
  let reads = 0;
  return {
    read(k) {
      k &= 0xff;
      if (keys[k]) return 1;                 // physically held: nothing to synthesise
      if (latch[k]) {
        observed.add(k);
        if (++reads > 4000) { latch[k] = 0; observed.delete(k); reads = 0; return 0; }
        return 1;
      }
      return 0;
    },
    endFrame() {
      reads = 0;
      // Counts DOWN over KEY_HOLD_FRAMES frames rather than clearing at the first boundary — see
      // the measurement above.
      for (const k of observed) if (!keys[k] && latch[k]) latch[k]--;
      observed.clear();
    },
  };
}
