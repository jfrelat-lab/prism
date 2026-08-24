// osd.js — PRISM's platform backend for MAME 0.1's `osdepend.h`.
//
// MAME 0.1 declares exactly eighteen platform functions and confines its whole Allegro dependency to
// src/msdos/msdos.c, which its own makefile selects per platform. Supplying a different backend is
// therefore the intended use of the abstraction, not a modification of the game — the same boundary
// PRISM draws everywhere: the shim lives outside the game's own code.
//
// Everything here is DETERMINISTIC. No real clock, no host randomness: the same input must produce
// byte-identical state, which is what makes a golden fingerprint of a frame possible at all.

import { SLOT } from './webhost.js';

/** `struct osd_bitmap { int width, height; void *private; unsigned char *line[0]; }` */
const B_WIDTH = 0, B_HEIGHT = 4, B_PRIVATE = 8, B_LINE = 12;

export function installOSD(M, {
  files = {}, keys = () => 0, stopAfterFrames = 0, publish = null, onPresent = null,
} = {}) {
  const mod = M.mod;
  const dv = () => mod.dv;

  /*
   * `publish` is the browser path: a control block (src/env/webhost.js) the page reads while this
   * code runs. Publishing is three integer stores and a palette copy, so the headless path pays
   * nothing for it — and the page learns the display's geometry from the GAME, never from a config.
   */
  const pub = publish;

  const state = {
    screen: 0,            // the osd_bitmap the game draws into
    width: 0, height: 0,
    pixels: 0,            // byte address of the display's pixel data
    palette: [],          // pen index -> [r,g,b]
    frames: 0,
    samples: [],          // what the game asked to play, so a test can assert on it
  };
  M.osd = state;

  /**
   * Allocate a bitmap plus its pixel data, and fill in the row pointers.
   *
   * Through the guest's own malloc, NOT mod.alloc: the latter grows the STATIC area by advancing
   * `brk`, and the heap start was already fixed when the program began. Allocating there at run time
   * handed out addresses that malloc later handed out again, so the framebuffer was quietly
   * overwritten — the display read as all-zero while a C backend compiled from the same source saw
   * 26340 lit pixels.
   */
  function createBitmap(width, height) {
    const rows = Math.max(height, 0);
    const hdr = M.rt.malloc(B_LINE + 4 * rows);
    const pix = M.rt.malloc(Math.max(width * rows, 1));
    dv().setInt32(hdr + B_WIDTH, width, true);
    dv().setInt32(hdr + B_HEIGHT, height, true);
    dv().setInt32(hdr + B_PRIVATE, 0, true);
    for (let y = 0; y < rows; y++) dv().setInt32(hdr + B_LINE + 4 * y, pix + y * width, true);
    M.u8.fill(0, pix, pix + width * rows);
    return { hdr, pix };
  }

  const osd = {
    osd_init: () => 0,
    osd_exit: () => {},

    osd_create_bitmap: (w, h) => createBitmap(w | 0, h | 0).hdr,
    osd_free_bitmap: () => {},          // the image is never reclaimed; a frame's worth is cheap

    osd_create_display: (w, h) => {
      const b = createBitmap(w | 0, h | 0);
      state.screen = b.hdr; state.pixels = b.pix;
      state.width = w | 0; state.height = h | 0;
      if (pub) {
        // PIXELS last: the page treats a non-zero PIXELS as "geometry is valid", so width and
        // height must already be there when it becomes visible.
        Atomics.store(pub.ctrl, SLOT.WIDTH, w | 0);
        Atomics.store(pub.ctrl, SLOT.HEIGHT, h | 0);
        Atomics.store(pub.ctrl, SLOT.PIXELS, b.pix);
        Atomics.store(pub.ctrl, SLOT.TEXTMODE, 0);
      }
      return b.hdr;
    },
    osd_close_display: () => {
      state.screen = 0;
      // Back to the text surface, the way a DOS program that leaves mode 13h lands back on the
      // console it printed to before.
      if (pub) { Atomics.store(pub.ctrl, SLOT.PIXELS, 0); Atomics.store(pub.ctrl, SLOT.TEXTMODE, 1); }
    },

    // Pens are handed out in order, so a palette entry's index is reproducible.
    osd_obtain_pen: (r, g, b) => {
      state.palette.push([r & 0xff, g & 0xff, b & 0xff]);
      const pen = state.palette.length - 1;
      if (pub && pen < 256) {
        pub.pal[pen * 3] = r & 0xff;
        pub.pal[pen * 3 + 1] = g & 0xff;
        pub.pal[pen * 3 + 2] = b & 0xff;
        Atomics.store(pub.ctrl, SLOT.PENS, pen + 1);
        Atomics.add(pub.ctrl, SLOT.PALGEN, 1);
      }
      return pen;
    },

    /*
     * A program calls this exactly when it has a frame to show, which makes it the one honest place
     * to hold the guest back. What holding it back MEANS is not decided here — the caller supplies
     * `onPresent`, so this module knows nothing about clocks, browsers or pacing policy.
     */
    osd_update_display: () => {
      state.frames++;
      if (pub) Atomics.store(pub.ctrl, SLOT.FRAME, state.frames);
      if (onPresent) onPresent();
    },
    osd_update_audio: () => {},

    osd_play_sample: (ch, data, len, freq, vol, loop) =>
      { state.samples.push({ ch, data, len, freq, vol, loop }); },
    osd_play_streamed_sample: (ch, data, len, freq, vol) =>
      { state.samples.push({ ch, data, len, freq, vol, streamed: true }); },
    osd_adjust_sample: () => {},
    osd_stop_sample: () => {},

    // MAME's main loop only ends on a keypress, so a bounded run reports ESC once it has drawn
    // enough frames. That is a harness decision, stated rather than hidden.
    osd_key_pressed: (k) => ((stopAfterFrames && state.frames >= stopAfterFrames && (k | 0) === 1)
      ? 1 : (keys(k | 0) | 0)),
    osd_read_key: () => 0,
    osd_poll_joystick: () => {},
  };

  // --- the DOS/DJGPP libc extras MAME 0.1 calls, measured from its sources
  const handles = new Map();            // FILE* -> {bytes, pos}
  let nextHandle = 0x40000000;

  const lib = {
    // Case-insensitive compare, a DOS-ism with no ISO equivalent.
    stricmp: (a, b) => {
      const x = mod.cstr(a).toLowerCase(), y = mod.cstr(b).toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    },

    /**
     * File I/O over an injected map of name -> Uint8Array. MAME uses it only to load ROMs, so read
     * support is what matters; a write returns the count without storing, which keeps a high-score
     * save from failing the run.
     */
    fopen: (namePtr, modePtr) => {
      const name = mod.cstr(namePtr);
      const mode = mod.cstr(modePtr);
      // MAME asks for `pacman/pacman.6e`; a caller may key the map either way.
      const want = name.toLowerCase();
      const base = want.replace(/^.*\//, '');
      const key = Object.keys(files).find(k => {
        const kk = k.toLowerCase();
        return kk === want || kk === base || kk.replace(/^.*\//, '') === base;
      });
      if (key === undefined) return 0;                  // NULL: not found, which MAME reports
      if (/w|a/.test(mode)) return 0;
      handles.set(nextHandle, { bytes: files[key], pos: 0 });
      return nextHandle++;
    },
    fclose: (fp) => { handles.delete(fp); return 0; },
    fread: (dst, size, count, fp) => {
      const h = handles.get(fp);
      if (!h) return 0;
      const want = (size | 0) * (count | 0);
      const got = Math.max(0, Math.min(want, h.bytes.length - h.pos));
      M.u8.set(h.bytes.subarray(h.pos, h.pos + got), dst);
      h.pos += got;
      return size ? Math.floor(got / size) : 0;
    },
    fwrite: (_src, size, count) => count | 0,
    getchar: () => -1,

    /**
     * A deterministic PRNG. `rand()` must not read host entropy: the same run has to produce the
     * same frame. This is the ANSI C sample generator, which is also what DJGPP shipped.
     */
    rand: () => { M.randState = (Math.imul(M.randState, 1103515245) + 12345) | 0; return (M.randState >>> 16) & 0x7fff; },
    srand: (seed) => { M.randState = seed | 0; },
  };

  M.randState = 1;
  Object.assign(M.rt, osd, lib);
  return state;
}

/** The declarations for the extras above, in the shape src/compile.js's BUILTINS table wants. */
export function osdBuiltins(T) {
  const P = T.ptr(T.CHAR), I = T.INT, U = T.UINT, V = T.VOID;
  const ptr = P;
  return {
    osd_init: { ret: I, params: [I, P] },
    osd_exit: { ret: V, params: [] },
    osd_create_bitmap: { ret: ptr, params: [I, I] },
    osd_free_bitmap: { ret: V, params: [ptr] },
    osd_create_display: { ret: ptr, params: [I, I] },
    osd_close_display: { ret: V, params: [] },
    osd_obtain_pen: { ret: I, params: [I, I, I] },
    osd_update_display: { ret: V, params: [] },
    osd_update_audio: { ret: V, params: [] },
    osd_play_sample: { ret: V, params: [I, P, I, I, I, I] },
    osd_play_streamed_sample: { ret: V, params: [I, P, I, I, I] },
    osd_adjust_sample: { ret: V, params: [I, I, I] },
    osd_stop_sample: { ret: V, params: [I] },
    osd_key_pressed: { ret: I, params: [I] },
    osd_read_key: { ret: I, params: [] },
    osd_poll_joystick: { ret: V, params: [] },

    stricmp: { ret: I, params: [P, P] },
    strcmpi: { ret: I, params: [P, P], impl: 'stricmp' },
    fopen: { ret: ptr, params: [P, P] },
    fclose: { ret: I, params: [ptr] },
    fread: { ret: U, params: [P, U, U, ptr] },
    fwrite: { ret: U, params: [P, U, U, ptr] },
    getchar: { ret: I, params: [] },
    rand: { ret: I, params: [] },
    srand: { ret: V, params: [U] },
  };
}
