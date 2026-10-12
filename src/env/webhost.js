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

  /*
   * Sound, published exactly the way pixels are: the guest's audio library mixes into a ring in
   * shared memory and the page's AudioWorklet reads it. Same reason, too — a C program's sound
   * library is called from inside a main loop that never yields, so there is no moment at which the
   * guest could hand a buffer to the page. It writes, the page reads.
   *
   * WRITE and READ are MONOTONIC sample counts, never wrapped indices. Their difference is how much
   * sound is buffered, which is the one number both sides need: the guest tops the ring up when it
   * runs low (which is literally SEAL's AUpdateAudio contract) and the page can tell an underrun
   * from an empty ring.
   */
  AUDIO_RATE: 12,   // guest → host: output sample rate, 0 when the program produces no sound
  AUDIO_WRITE: 13,  // guest → host: total FRAMES ever written (a frame is one sample per channel)
  AUDIO_CHANNELS: 14, // guest → host: 1 or 2. Doom mixes in stereo, MAME's SEAL voices are mono.

  STOP: 17,        // host → guest: 1 asks the program to quit through its own quit path
  PAUSE: 18,
  SPEED: 19,       // host → guest: percent of normal speed; 0 means unthrottled
  TEXTMODE: 20,    // guest → host: 1 while no graphics display exists
  KBD_HEAD: 21,    // host → guest: write cursor into the keystroke queue
  KBD_TAIL: 22,    // guest → host: read cursor
  WAKE: 23,        // a pure wake channel, always 0: the host notifies it, a parked guest waits on it
  AUDIO_READ: 24,  // host → guest: total frames ever consumed by the page

  /*
   * The WINDOW, for a program that has one. Win32 Quake moves and resizes its own window and reads
   * back where it ended up -- VID_UpdateWindowStatus stores the position into the archived cvars
   * `vid_window_x` and `vid_window_y` -- so this is a two-way channel, not decoration.
   *
   * It goes through the control block rather than postMessage for the reason the keyboard does: once
   * the guest is inside `prog.run` its worker never returns to an event loop, so a message posted to
   * it is never delivered. Shared memory is the only thing that reaches a running program.
   */
  WIN_X: 25,       // guest → host: where the program has put its window
  WIN_Y: 26,
  WIN_W: 27,       // guest → host: and how big it made it -- a resolution change resizes it
  WIN_H: 28,
  WIN_HAS: 29,     // guest → host: 1 when this platform has a window at all
  DRAG_X: 30,      // host → guest: where the person dragged it to
  DRAG_Y: 31,
  DRAG_GEN: 32,    // host → guest: bumped per drag, so the guest applies each one once
  WIN_CLOSE: 33,   // host → guest: the close button was clicked; the guest posts itself WM_CLOSE

  /*
   * The PIXEL FORMAT of what PIXELS points at. Zero -- the default, and every DOS-era program here
   * -- is one byte per pixel through a palette. 32 is B,G,R,A in memory order, which is what a
   * program gets when it draws through a library that never had a palette: the Win32 GDI shim's
   * surface and an SDL2 texture are both this.
   *
   * It is a format, not a depth, because the page has to know the BYTE ORDER: GDI writes blue first
   * and a canvas wants red first, so the two cannot share a copy loop.
   *
   * 2 is NOT in guest memory at all: a WebGL frame, sent to the page as an ImageBitmap (the 'frame'
   * message) rather than read back from the GPU and copied twice -- see glPublisher in worker.js.
   */
  PIXFMT: 34,      // guest → host: 0 = 8-bit indexed (default), 32 = BGRA, 2 = an ImageBitmap message

  /*
   * THE MOUSE, and it is an ACCUMULATOR rather than a position.
   *
   * Every program here wants relative motion: Quake's DOS build reads INT 33h AX=000B, "read motion
   * counters", which returns how far the mouse has moved SINCE THE LAST CALL and resets the counters
   * -- and an X client asking for MotionNotify wants the same thing by a different name. A browser
   * gives absolute coordinates inside an element, so the page differences them (Pointer Lock hands
   * over `movementX` directly) and ADDS the result here; the guest EXCHANGES the slot for zero when
   * it reads. Two sides, one number each, and no shared cursor position to disagree about.
   *
   * That is also why this cannot be a poll of some page-side variable: `Atomics.add` on one side and
   * `Atomics.exchange` on the other is the whole protocol, and neither can lose a movement to the
   * other's timing.
   */
  MOUSE_DX: 35,    // host → guest: motion accumulated since the guest last read, in mickeys
  MOUSE_DY: 36,
  MOUSE_BUTTONS: 37, // host → guest: bit 0 left, bit 1 right, bit 2 middle -- the INT 33h order
  MOUSE_HAS: 38,   // host → guest: 1 once the page is capturing, so a probe can be answered honestly

  /*
   * WHETHER THE PAGE HAS THE FOCUS, which a Win32 program needs and cannot infer.
   *
   * WinQuake's IN_Move is `if (ActiveApp && !Minimized)` (in_win.c:741), and ActiveApp comes from
   * WM_ACTIVATE and nothing else. Alt-tab away from a real Quake and it lets go of the mouse; the
   * page is the desktop here, so it is the page's focus that says so.
   */
  FOCUS: 39,       // host → guest: 1 while the page has the focus
};

export const STATE = { BOOT: 0, FETCHING: 1, COMPILING: 2, RUNNING: 3, EXITED: 4, ERROR: 5 };

// Byte offsets inside the control block.
const CTRL_INTS = 512;              // 128 int32 slots, more than the contract needs
const KEYS_AT = 512;                // 256 bytes: one per PC set-1 scancode, 1 = down
const LATCH_AT = 768;               // 256 bytes: a key that went down since the guest last looked
const PAL_AT = 1024;                // 256 * 3 bytes, r,g,b
/*
 * 64 keystrokes, THREE bytes each: scan code, ASCII, flags.
 *
 * The third byte carries what a scan code cannot. Set 1's software convention gives ArrowUp and
 * Numpad8 the same 72, and a real controller separates them with an 0xE0 prefix byte -- so a host
 * that feeds port 0x60 directly has no way to reproduce the pair from the queue alone. Rather than
 * overload the ASCII byte (an accented character really can set its high bit), the flag gets its
 * own. 64 * 3 = 192 bytes ends at 1984, still clear of the audio ring at 2048.
 */
const KBD_AT = 1792;
export const KBD_SIZE = 64;
const KBD_STRIDE = 3;
export const KBD_EXTENDED = 1;      // flags bit 0: this key arrives 0xE0-prefixed on real hardware
/*
 * The audio ring: 16384 signed 16-bit samples, about 370 ms at 44100 Hz. A power of two so the
 * wrapped index is a mask, and generous because the guest tops it up once per frame — a browser that
 * skips a frame under load must not be heard doing so.
 */
const AUDIO_AT = 2048;
export const AUDIO_RING = 16384;
export const CONTROL_BYTES = AUDIO_AT + AUDIO_RING * 2;

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
    kbd: new Uint8Array(sab, KBD_AT, KBD_SIZE * KBD_STRIDE),
    audio: new Int16Array(sab, AUDIO_AT, AUDIO_RING),
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

/**
 * The mouse, from both sides.
 *
 * `push` is the page's: it ADDS motion, because two events between two guest reads are one movement.
 * `take` is the guest's: it EXCHANGES for zero, so a delta is delivered exactly once -- which is the
 * contract INT 33h's "read motion counters" already has, and what an X client expects of the events
 * it has consumed.
 */
export function makeMouse(views) {
  const { ctrl } = views;
  return {
    /** Host side: the pointer moved by (dx, dy), and these buttons are down. */
    move(dx, dy) {
      if (dx) Atomics.add(ctrl, SLOT.MOUSE_DX, dx | 0);
      if (dy) Atomics.add(ctrl, SLOT.MOUSE_DY, dy | 0);
    },
    buttons(mask) { Atomics.store(ctrl, SLOT.MOUSE_BUTTONS, mask & 7); },
    /** Host side: whether the page is capturing at all. A program may ask, and must not be lied to. */
    present(on) { Atomics.store(ctrl, SLOT.MOUSE_HAS, on ? 1 : 0); },

    /** Guest side: how far since the last call, and reset -- INT 33h AX=000B, exactly. */
    take() {
      return {
        dx: Atomics.exchange(ctrl, SLOT.MOUSE_DX, 0),
        dy: Atomics.exchange(ctrl, SLOT.MOUSE_DY, 0),
      };
    },
    /** Guest side: which buttons are down right now. Level, not edge -- INT 33h AX=0003. */
    state() { return Atomics.load(ctrl, SLOT.MOUSE_BUTTONS) & 7; },
    has() { return Atomics.load(ctrl, SLOT.MOUSE_HAS) === 1; },
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
    push(scan, ascii, flags = 0) {
      const head = Atomics.load(ctrl, SLOT.KBD_HEAD);
      const tail = Atomics.load(ctrl, SLOT.KBD_TAIL);
      if (head - tail >= KBD_SIZE) return false;
      const at = (head % KBD_SIZE) * KBD_STRIDE;
      kbd[at] = scan & 0xff;
      kbd[at + 1] = ascii & 0xff;
      kbd[at + 2] = flags & 0xff;
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
      const at = (tail % KBD_SIZE) * KBD_STRIDE;
      const raw = kbd[at], flags = kbd[at + 2];
      Atomics.store(ctrl, SLOT.KBD_TAIL, tail + 1);
      // `extended` is what a host feeding port 0x60 needs to send the 0xE0 byte first; a host that
      // wants set 1's software convention ignores it and reads the same number it always did.
      return { scan: raw & 0x7f, down: (raw & 0x80) === 0, extended: (flags & KBD_EXTENDED) !== 0 };
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
        const v = kbd[(tail % KBD_SIZE) * KBD_STRIDE + which];
        Atomics.store(ctrl, SLOT.KBD_TAIL, tail + 1);
        /*
         * A RELEASE produced no character. The queue carries both -- one BIOS buffer, read either as
         * a scan code or as a character -- and a break code's character byte is zero, so a program
         * reading text used to get a NUL between every two keystrokes. Lua's REPL saw `p\0r\0i...`
         * and answered with a syntax error for a line that had been typed correctly. The scan-code
         * reader still sees them: that is what the high bit is for.
         */
        if (which === 1 && v === 0) continue;
        return v;
      }
      Atomics.wait(ctrl, SLOT.KBD_HEAD, head, 100);
    }
  }
}
