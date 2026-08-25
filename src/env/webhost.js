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

  /*
   * Where a program keeps its OWN palette and frame counter, when it has them. A platform layer that
   * merely publishes addresses is the lightest one there is: Quake already draws into a 320x200 array
   * of its own and already counts its frames, so nothing needs copying, hooking or re-implementing —
   * the page reads what the program was going to write anyway.
   */
  PAL_ADDR: 9,     // guest address of 768 palette bytes, or 0 to use the control block's copy
  PAL_INDIRECT: 10, // 1 when PAL_ADDR holds a POINTER to those bytes rather than the bytes
  FRAME_ADDR: 11,  // guest address of an int the program increments per frame, or 0 for SLOT.FRAME

  FPS: 8,          // guest → host: the frame rate the program declares, x1000

  STOP: 17,        // host → guest: 1 asks the program to quit through its own quit path
  PAUSE: 18,
  SPEED: 19,       // host → guest: percent of normal speed; 0 means unthrottled
  TEXTMODE: 20,    // guest → host: 1 while no graphics display exists
  KBD_HEAD: 21,    // host → guest: write cursor into the keystroke queue
  KBD_TAIL: 22,    // guest → host: read cursor
  WAKE: 23,        // a pure wake channel, always 0: the host notifies it, a parked guest waits on it
};

export const STATE = { BOOT: 0, FETCHING: 1, COMPILING: 2, RUNNING: 3, EXITED: 4, ERROR: 5 };

// Byte offsets inside the control block.
const CTRL_INTS = 512;              // 128 int32 slots, more than the contract needs
const KEYS_AT = 512;                // 256 bytes: one per PC set-1 scancode, 1 = down
const LATCH_AT = 768;               // 256 bytes: a key that went down since the guest last looked
const PAL_AT = 1024;                // 256 * 3 bytes, r,g,b
const KBD_AT = 1792;                // 64 keystrokes, two bytes each: scan code then ASCII
export const KBD_SIZE = 64;
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
    kbd: new Uint8Array(sab, KBD_AT, KBD_SIZE * 2),
  };
}

/**
 * Pace the guest against its OWN clock, from inside its own present call.
 *
 * The first design paced the guest against the page: it was allowed to run N frames ahead of an
 * acknowledgement the page published once per paint. That was wrong in principle, and the symptom was
 * that the game was unplayable — its speed was whatever rate the browser felt like waking a timer at,
 * which is 125 fps in a foreground tab and 8 fps in a background one. **A display's refresh rate is
 * not a clock.**
 *
 * A program declares its frame rate (MAME's drivers carry `frames_per_second`; Pac-Man is 60). So the
 * guest sleeps until its next frame is due and the page is not involved at all — which also removes
 * the deadlock that froze the guest whenever the tab lost focus.
 *
 * Determinism is untouched: this changes WHEN frames happen, never what they contain. The guest's own
 * `clock()`/`uclock()` remain deterministic counters, so a run is still reproducible frame for frame.
 */
export function makePacer(ctrl, fps) {
  let due = 0;
  const stopped = () => Atomics.load(ctrl, SLOT.STOP) !== 0;

  /** Sleep without spinning. Waiting on STOP with an expected 0 returns at once if stop is set. */
  // The same WAKE channel `park` uses, so one notify from the page releases every kind of wait.
  const nap = (ms) => { Atomics.wait(ctrl, SLOT.WAKE, 0, Math.min(Math.max(ms, 1), 50)); };

  Atomics.store(ctrl, SLOT.FPS, Math.round(fps * 1000));

  return function pace() {
    while (Atomics.load(ctrl, SLOT.PAUSE) && !stopped()) { due = 0; nap(50); }

    const pct = Atomics.load(ctrl, SLOT.SPEED);
    if (!pct) { due = 0; return; }                 // unthrottled: run as fast as the host allows

    const step = 1000 / (fps * pct / 100);
    const now = performance.now();
    // Resync rather than try to catch up. A guest that fell behind — a slow host, a long GC pause, a
    // throttled tab — would otherwise run at full tilt to repay a debt it can never repay, which is
    // the fast-forward glitch every emulator with a naive frame timer has.
    if (!due || now > due + 250) due = now;
    due += step;

    for (let left = due - performance.now(); left > 0; left = due - performance.now()) {
      if (stopped()) return;
      nap(left);
    }
  };
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

/**
 * The one way anything in the guest waits.
 *
 * Blocking the worker is not the problem — the guest is synchronous C, so when it waits it has to be
 * stopped. The problems are spinning (a core at 100% to wait), being un-interruptible (Stop must
 * reach a guest that is waiting), and freezing the screen with no explanation. This answers all
 * three: the thread is parked at zero cost, STOP is checked before every wait, and the page keeps
 * painting because it reads guest memory rather than waiting for messages from it.
 *
 * The timeout is not a convenience. Without it a guest parked when the page has already gone would
 * wait for ever with nothing left to wake it.
 */
export function makeParker(ctrl) {
  return function park(ms = 1) {
    if (Atomics.load(ctrl, SLOT.STOP)) return false;
    // WAKE is held at 0 for ever and used only as a channel: waiting on it always parks for the
    // timeout, and any notify from the page cuts the wait short.
    Atomics.wait(ctrl, SLOT.WAKE, 0, Math.min(Math.max(ms, 1), 100));
    return !Atomics.load(ctrl, SLOT.STOP);
  };
}

/** Host side: something changed that a parked guest might be waiting for. */
export function wake(ctrl) {
  Atomics.notify(ctrl, SLOT.WAKE);
}

/**
 * The keystroke queue: what `getchar` reads, as distinct from which keys are held down.
 *
 * These are two different questions and a program asks both. MAME asks "is 3 held" every frame, which
 * the key bytes answer. MAME also prints "Press <ENTER> to continue." and calls `getchar()`, which
 * needs the CHARACTER a person typed, in order, once each. Answering the second question with the
 * first would report Enter as pressed for as long as the finger is down and read it dozens of times;
 * answering it with -1, as PRISM did until now, made the program ask and ignore the answer.
 *
 * MIRAGE draws the same distinction — a scancode path for INT 9h and a (scan, ascii) queue for INT
 * 16h — and for the same reason.
 */
export function makeKeyboard(views) {
  const { ctrl, kbd } = views;
  return {
    /**
     * Host side: a key was struck. Dropped rather than overwritten when the guest is not reading —
     * a real BIOS buffer overflows the same way, and beeps.
     */
    push(scan, ascii) {
      const head = Atomics.load(ctrl, SLOT.KBD_HEAD);
      const tail = Atomics.load(ctrl, SLOT.KBD_TAIL);
      if (head - tail >= KBD_SIZE) return false;
      const at = (head % KBD_SIZE) * 2;
      kbd[at] = scan & 0xff;
      kbd[at + 1] = ascii & 0xff;
      Atomics.store(ctrl, SLOT.KBD_HEAD, head + 1);
      Atomics.notify(ctrl, SLOT.KBD_HEAD);
      return true;
    },

    /**
     * Guest side: block until a character is typed. -1 means the host asked the program to stop,
     * which `getchar` reports as EOF — the one answer that cannot hang a program waiting for input.
     *
     * The timeout on the wait is what makes Stop work: a guest parked here with no timeout would never
     * see the flag.
     */
    read() { return take(1); },

    /** How many keystrokes are waiting — what XPending answers. */
    pending() {
      return Atomics.load(ctrl, SLOT.KBD_HEAD) - Atomics.load(ctrl, SLOT.KBD_TAIL);
    },

    /**
     * The next keystroke as an EVENT rather than a character, for a program that wants press and
     * release. The high bit of the scan code means release — the PC's own break-code convention, so
     * no extra storage is needed to carry it.
     */
    nextEvent() {
      if (this.pending() <= 0) return null;
      const tail = Atomics.load(ctrl, SLOT.KBD_TAIL);
      const raw = kbd[(tail % KBD_SIZE) * 2];
      Atomics.store(ctrl, SLOT.KBD_TAIL, tail + 1);
      return { scan: raw & 0x7f, down: (raw & 0x80) === 0 };
    },

    /**
     * The same queue, read as a scan code — what MAME's `osd_read_key` returns. One queue with two
     * readings, not two queues: a real PC has exactly one BIOS buffer, and DOS's `getchar` and a
     * direct INT 16h read drain it together. Faithful and simpler at once.
     */
    readKey() { return take(0); },
  };

  function take(which) {
    for (;;) {
      if (Atomics.load(ctrl, SLOT.STOP)) return -1;
      const tail = Atomics.load(ctrl, SLOT.KBD_TAIL);
      const head = Atomics.load(ctrl, SLOT.KBD_HEAD);
      if (head !== tail) {
        const v = kbd[(tail % KBD_SIZE) * 2 + which];
        Atomics.store(ctrl, SLOT.KBD_TAIL, tail + 1);
        return v;
      }
      Atomics.wait(ctrl, SLOT.KBD_HEAD, head, 100);
    }
  }
}
