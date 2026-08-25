// allegro.js — Allegro, SEAL and DJGPP's memory helpers, shimmed at the library boundary.
//
// This replaces src/env/osd.js, and the difference is the point of the project rather than a
// refactor. osd.js implemented MAME's eighteen `osdepend.h` functions in JavaScript: a hand-written
// backend, which is exactly what Emscripten makes you do and exactly what PRISM claims not to need.
// What MAME actually ships is `src/msdos/msdos.c`, the file its own makefile selects for DOS
// (`obj/osdepend.o: src/msdos/msdos.c`), and that file is now compiled unmodified. The eighteen
// functions are the GAME's again. What is shimmed is one level down, where it belongs: the two
// libraries msdos.c links against, and the DJGPP helpers it uses to reach video memory.
//
// The measured surface, from grepping msdos.c and TwkUser.c rather than from reading Allegro:
//   Allegro   13 functions, `screen`, `key[]`, the joystick globals, BITMAP / RGB / PALETTE, GFX_*
//   SEAL      17 A* functions, all answered with success and silence
//   DJGPP     _dosmemputl and the far-pointer pokes, plus inportb/outportb from src/env/ports.js
//
// Two things that did NOT need shimming, and both were checked before writing a line:
//
//  * **No VGA register emulation.** Both of msdos.c's display paths end in `_dosmemputl`, one to
//    0xa0000 and one to an address `bmp_write_line` returned. The CRTC tweaking in TwkUser.c goes to
//    the I/O port seam and changes nothing the host reads, because the host learns the display's
//    geometry from the game's own `bitmap` global — the same "publish what the program already
//    writes" move as Quake's vid_buffer and Doom's XImage.
//  * **The keyboard is not a function any more.** `osd_key_pressed` is now guest C reading `key[]`
//    out of memory, so nothing here is called when MAME polls. See `refreshKeys` below: that turned
//    out to need the safepoint, and it is the honest analogue of what Allegro really does — an
//    interrupt handler writing key[] asynchronously.

import { SLOT } from './webhost.js';

/** `struct osd_bitmap { int width, height; void *private; unsigned char *line[0]; }` — MAME's. */
const OSD_B_WIDTH = 0, OSD_B_HEIGHT = 4;

/** Allegro's BITMAP, in the layout src/env/headers-djgpp.js declares. */
const BMP_W = 0, BMP_H = 4, BMP_LINE = 56, BMP_SIZE = 56;

export function installAllegro(M, {
  publish = null,          // the control block the page reads (src/env/webhost.js)
  keys = () => 0,          // scan code -> held?
  readKey = () => -1,      // blocking: the next typed key, as a PC scan code
  onPresent = null,        // called once per frame the game presents
  stopAfterFrames = 0,
} = {}) {
  const mod = M.mod;
  const dv = () => mod.dv;

  const state = {
    width: 0, height: 0,
    pixels: 0,               // where the game's frame lands, in guest memory
    palette: new Uint8Array(768),
    pens: 0,
    frames: 0,
    gfxMode: null,
    samples: [],             // what the game asked to play, so a test can assert on it
  };
  M.osd = state;

  /*
   * The VESA framebuffer. `bmp_write_line(screen, y)` hands the program a linear address to write a
   * scanline to, and on real hardware that is the card's aperture. Here it is an ordinary allocation:
   * the program's own `_dosmemputl` writes into it, and the page reads it from the same place.
   *
   * NOT at 0xa0000, even though a real VESA1 mode would be banked through there: 640x480 is 300 kB
   * and would run straight over the text video RAM at 0xb8000 that src/env/console.js uses.
   */
  const VESA_W = 640, VESA_H = 480;
  let vesaFb = 0;

  /** The addresses of the library's data, filled in by `bindGlobals` once the image is linked. */
  const g = { screen: 0, key: 0 };

  const api = {
    // ---- Allegro: initialisation
    allegro_init: () => 0,
    allegro_exit: () => 0,
    install_keyboard: () => 0,
    remove_keyboard: () => 0,
    vsync: () => 0,

    /*
     * No joystick. Nonzero means "not found", which is the answer that makes osd_init clear
     * use_joystick — and that in turn is what keeps msdos.c from reading port 0x201 every frame.
     */
    initialise_joystick: () => 1,
    poll_joystick: () => 0,

    /**
     * A graphics mode. The dimensions asked for are recorded but NOT published: msdos.c opens a
     * 320x200 mode and then reprograms the CRTC to 224x288 through TwkUser.c, so the mode is a poor
     * description of what will actually be drawn. The geometry the page uses comes from the game's
     * own bitmap at the first frame instead.
     */
    set_gfx_mode: (card, w, h) => {
      state.gfxMode = { card: card | 0, w: w | 0, h: h | 0 };
      if ((card | 0) === 3 /* GFX_VESA1 */ && !vesaFb) {
        vesaFb = M.rt.malloc(VESA_W * VESA_H);
        M.u8.fill(0, vesaFb, vesaFb + VESA_W * VESA_H);
      }
      return 0;
    },

    /**
     * A palette entry. Allegro's components are 6-bit, which is the VGA DAC's own range, so they are
     * scaled to 8 here — `<< 2` and not `* 255 / 63`, because that is what the hardware does with
     * the two low bits and the golden fingerprints were taken against it.
     */
    set_color: (index, p) => {
      const i = (index | 0) & 0xff;
      state.palette[i * 3] = M.u8[p] << 2;
      state.palette[i * 3 + 1] = M.u8[p + 1] << 2;
      state.palette[i * 3 + 2] = M.u8[p + 2] << 2;
      if (i + 1 > state.pens) state.pens = i + 1;
      publishPalette();
      return 0;
    },

    set_palette: (p) => {
      for (let i = 0; i < 256; i++) {
        state.palette[i * 3] = M.u8[p + i * 4] << 2;
        state.palette[i * 3 + 1] = M.u8[p + i * 4 + 1] << 2;
        state.palette[i * 3 + 2] = M.u8[p + i * 4 + 2] << 2;
      }
      state.pens = 256;
      publishPalette();
      return 0;
    },

    /** Reads back what set_color stored, into a PALETTE (256 x RGB, 6-bit again). */
    get_palette: (p) => {
      for (let i = 0; i < 256; i++) {
        M.u8[p + i * 4] = state.palette[i * 3] >> 2;
        M.u8[p + i * 4 + 1] = state.palette[i * 3 + 1] >> 2;
        M.u8[p + i * 4 + 2] = state.palette[i * 3 + 2] >> 2;
        M.u8[p + i * 4 + 3] = 0;
      }
      return 0;
    },

    // ---- Allegro: bitmaps
    create_bitmap: (w, h) => {
      const width = w | 0, height = Math.max(h | 0, 1);
      // Through the GUEST's malloc, never mod.alloc: mod.alloc advances brk, and brk was fixed when
      // the program started, so it hands out addresses malloc later hands out again.
      const hdr = M.rt.malloc(BMP_SIZE + 4 * height);
      const pix = M.rt.malloc(Math.max(width * height, 1));
      M.u8.fill(0, hdr, hdr + BMP_SIZE);
      M.u8.fill(0, pix, pix + width * height);
      dv().setInt32(hdr + BMP_W, width, true);
      dv().setInt32(hdr + BMP_H, height, true);
      for (let y = 0; y < height; y++) dv().setInt32(hdr + BMP_LINE + 4 * y, pix + y * width, true);
      return hdr;
    },

    destroy_bitmap: (b) => {
      if (!b) return 0;
      M.rt.free(dv().getInt32(b + BMP_LINE, true));
      M.rt.free(b);
      return 0;
    },

    /**
     * The address to write scanline `line` to. For the VESA display that is the linear framebuffer;
     * for any other bitmap it is that bitmap's own row, which is what Allegro means by it.
     */
    bmp_write_line: (bmp, line) => {
      if (bmp === g.screenValue) return (vesaFb + (line | 0) * VESA_W) >>> 0;
      return dv().getInt32(bmp + BMP_LINE + 4 * (line | 0), true) >>> 0;
    },

    /** F12 in MAME. A real 8-bit PCX, written into the file store, because that is what was asked. */
    save_pcx: (name, bmp, pal) => {
      const w = dv().getInt32(bmp + BMP_W, true), h = dv().getInt32(bmp + BMP_H, true);
      const hdr = new Uint8Array(128);
      hdr[0] = 10; hdr[1] = 5; hdr[2] = 1; hdr[3] = 8; hdr[65] = 1;      // 1 plane, 8 bpp, RLE
      const put16 = (o, v) => { hdr[o] = v & 0xff; hdr[o + 1] = v >> 8; };
      put16(4, 0); put16(6, 0); put16(8, w - 1); put16(10, h - 1);
      put16(12, 72); put16(14, 72); put16(66, w + (w & 1));
      const body = [];
      for (let y = 0; y < h; y++) {
        const row = dv().getInt32(bmp + BMP_LINE + 4 * y, true);
        for (let x = 0; x < w;) {
          const v = M.u8[row + x];
          let run = 1;
          while (run < 63 && x + run < w && M.u8[row + x + run] === v) run++;
          if (run > 1 || v >= 0xc0) body.push(0xc0 | run, v); else body.push(v);
          x += run;
        }
      }
      const tail = [0x0c];
      for (let i = 0; i < 256; i++) {
        tail.push(M.u8[pal + i * 4] << 2, M.u8[pal + i * 4 + 1] << 2, M.u8[pal + i * 4 + 2] << 2);
      }
      const out = new Uint8Array(128 + body.length + tail.length);
      out.set(hdr, 0); out.set(body, 128); out.set(tail, 128 + body.length);
      M.files[mod.cstr(name)] = out;
      return 0;
    },

    // ---- Allegro: keyboard.
    //
    // `key[]` itself is memory, refreshed by refreshKeys below; only the blocking reads are calls.
    readkey: () => {
      const scan = readKey();
      return scan < 0 ? 0 : (scan << 8);           // Allegro returns (scancode << 8) | ascii
    },
    keypressed: () => 0,
    clear_keybuf: () => 0,

    // ---- SEAL. Success and silence: a library that reported failure would send osd_init down its
    // `return 1` path and abort MAME's start-up before a frame was ever drawn.
    AInitialize: () => 0,
    AGetAudioNumDevs: () => 1,
    AGetAudioDevCaps: (_id, caps) => {
      const name = 'PRISM (silent)';
      for (let i = 0; i < name.length; i++) M.u8[caps + 2 + i] = name.charCodeAt(i);
      M.u8[caps + 2 + name.length] = 0;
      return 0;
    },
    AOpenAudio: () => 0,
    ACloseAudio: () => 0,
    AUpdateAudio: () => 0,
    AOpenVoices: () => 0,
    ACloseVoices: () => 0,
    ACreateAudioVoice: (lph) => { dv().setInt32(lph, ++voiceSeq, true); return 0; },
    ADestroyAudioVoice: () => 0,
    AStopVoice: () => 0,
    ASetVoiceFrequency: () => 0,
    ASetVoiceVolume: () => 0,
    ASetVoicePanning: () => 0,
    AGetVoicePosition: (_h, lp) => { if (lp) dv().setInt32(lp, 0, true); return 0; },
    ADestroyAudioData: () => 0,
    AWriteAudioData: () => 0,

    /*
     * The one SEAL call with an obligation: msdos.c writes `lpWave[i]->lpData` immediately after,
     * so the buffer has to exist. It reads `dwLength` to size it, exactly as the real library does.
     */
    ACreateAudioData: (lpWave) => {
      const len = dv().getInt32(lpWave + 8, true) >>> 0;
      const buf = M.rt.malloc(Math.max(len, 1));
      M.u8.fill(0, buf, buf + Math.max(len, 1));
      dv().setInt32(lpWave + 24, buf, true);        // AUDIOWAVE.lpData
      return 0;
    },

    APlayVoice: (h, lpWave) => {
      state.samples.push({ voice: h | 0, len: dv().getInt32(lpWave + 8, true) });
      return 0;
    },

    // ---- DJGPP. The low megabyte is part of the same image, so a "far" write is a near one.
    _dosmemputl: (src, len, off) => copyTo(src, (len | 0) * 4, off),
    _dosmemputw: (src, len, off) => copyTo(src, (len | 0) * 2, off),
    _dosmemputb: (src, len, off) => copyTo(src, len | 0, off),
    dosmemput: (src, len, off) => copyTo(src, len | 0, off),
    _dosmemgetb: (off, len, dst) => copyFrom(off, len | 0, dst),
    _dosmemgetw: (off, len, dst) => copyFrom(off, (len | 0) * 2, dst),
    _dosmemgetl: (off, len, dst) => copyFrom(off, (len | 0) * 4, dst),
    dosmemget: (off, len, dst) => copyFrom(off, len | 0, dst),
    movedata: (_ss, so, _ds, dof, n) => copyTo(so, n | 0, dof),
    _go32_my_ds: () => 0x1f,
    _farpokeb: (_s, off, v) => { M.u8[off >>> 0] = v & 0xff; },
    _farpokew: (_s, off, v) => dv().setUint16(off >>> 0, v & 0xffff, true),
    _farpokel: (_s, off, v) => dv().setUint32(off >>> 0, v >>> 0, true),
    _farpeekb: (_s, off) => M.u8[off >>> 0],
    _farpeekw: (_s, off) => dv().getUint16(off >>> 0, true),
    _farpeekl: (_s, off) => dv().getUint32(off >>> 0, true),
    _farsetsel: () => 0,
    _fargetsel: () => 0x1f,
    _farnspokeb: (off, v) => { M.u8[off >>> 0] = v & 0xff; },
    _farnspokew: (off, v) => dv().setUint16(off >>> 0, v & 0xffff, true),
    _farnspokel: (off, v) => dv().setUint32(off >>> 0, v >>> 0, true),
    _farnspeekb: (off) => M.u8[off >>> 0],
    _farnspeekw: (off) => dv().getUint16(off >>> 0, true),
    _farnspeekl: (off) => dv().getUint32(off >>> 0, true),
    delay: () => 0,
    filelength: () => -1,

    /** DOS's case-insensitive compare, which msdos.c parses its command line with. */
    stricmp: (a, b) => {
      const x = mod.cstr(a).toLowerCase(), y = mod.cstr(b).toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    },
  };
  api.strcmpi = api.stricmp;
  let voiceSeq = 0;

  /*
   * The frame.
   *
   * msdos.c ends BOTH display paths with a `_dosmemputl`, so this is where a frame is presented and
   * there is no separate hook to install. The one to 0xa0000 is the tweaked-VGA path and the one
   * into the VESA framebuffer is the other; the geometry comes from the game's own `bitmap` global
   * either way, because a mode number does not describe a CRTC that TwkUser.c has reprogrammed.
   */
  let vesaLines = 0;
  function copyTo(src, bytes, off) {
    const dst = off >>> 0;
    M.u8.copyWithin(dst, src, src + bytes);
    if (dst === 0xa0000) { present(true); return 0; }
    if (vesaFb && dst >= vesaFb && dst < vesaFb + VESA_W * VESA_H) {
      /*
       * A VESA frame arrives one scanline at a time, and counting them is the only way to know when
       * one ends: msdos.c centres the game's bitmap in the 640x480 mode, so the last line it writes
       * is line 383 of 480, not the last line of the framebuffer. Waiting for the bottom of the
       * screen meant no frame was ever presented and the harness's frame cap never fired.
       */
      if (++vesaLines >= (bitmapHeight() || VESA_H)) { vesaLines = 0; present(false); }
    }
    return 0;
  }

  const bitmapHeight = () => {
    const b = g.bitmap ? dv().getInt32(g.bitmap, true) : 0;
    return b ? dv().getInt32(b + OSD_B_HEIGHT, true) : 0;
  };
  function copyFrom(off, bytes, dst) {
    M.u8.copyWithin(dst, off >>> 0, (off >>> 0) + bytes);
    return 0;
  }

  function present(direct) {
    // The game's own bitmap: `struct osd_bitmap *bitmap;` in msdos.c, which is where the dimensions
    // actually live once the CRTC has been tweaked out from under the mode number.
    const b = g.bitmap ? dv().getInt32(g.bitmap, true) : 0;
    if (b) {
      state.width = dv().getInt32(b + OSD_B_WIDTH, true);
      state.height = dv().getInt32(b + OSD_B_HEIGHT, true);
    }
    state.pixels = direct ? 0xa0000 : vesaFb;
    if (!direct) { state.width = VESA_W; state.height = VESA_H; }
    state.frames++;
    if (publish) {
      Atomics.store(publish.ctrl, SLOT.WIDTH, state.width);
      Atomics.store(publish.ctrl, SLOT.HEIGHT, state.height);
      Atomics.store(publish.ctrl, SLOT.PIXELS, state.pixels);
      Atomics.store(publish.ctrl, SLOT.TEXTMODE, 0);
      Atomics.add(publish.ctrl, SLOT.FRAME, 1);
    }
    refreshKeys();
    if (onPresent) onPresent();
    if (stopAfterFrames && state.frames >= stopAfterFrames) throw new Error('__frames_done');
  }

  function publishPalette() {
    if (!publish) return;
    publish.pal.set(state.palette);
    Atomics.store(publish.ctrl, SLOT.PENS, state.pens);
    Atomics.add(publish.ctrl, SLOT.PALGEN, 1);
  }

  /*
   * `key[]` is an array in guest memory, not a function, which is the whole difference between this
   * file and the osd.js it replaces: `osd_key_pressed` is now MAME's own C reading that array. So the
   * host has to write into it, and the question is when.
   *
   * A frame boundary is not enough on its own. MAME waits for a key to be RELEASED with
   *
   *     while (osd_key_pressed(OSD_KEY_TAB));
   *
   * which presents no frame and calls nothing — it is a pure memory read, invisible to every
   * profiler and to spin damping alike. That loop is exactly what the safepoint exists for (see
   * docs/TESTING.md), and installing the refresh there is not a workaround: a real Allegro updates
   * key[] from a keyboard INTERRUPT, asynchronously, and the safepoint is where this runtime can be
   * interrupted at all.
   */
  function refreshKeys() {
    if (!g.key) return;
    for (let k = 0; k < 128; k++) M.u8[g.key + k] = keys(k) ? 1 : 0;
  }

  /**
   * Bind to the linked image: the library's own data lives in a generated translation unit (so the
   * C side has real definitions to link against), and the addresses are only known afterwards.
   */
  function bindGlobals(program) {
    const sym = (n) => program.mod.symbols.get(n)?.addr ?? 0;
    g.key = sym('key');
    g.screen = sym('screen');
    g.bitmap = sym('bitmap');
    // `screen` is a BITMAP* the program only ever passes back to us; give it a distinguishable value
    // so bmp_write_line can tell the display apart from an ordinary bitmap.
    if (g.screen) {
      g.screenValue = api.create_bitmap(VESA_W, 1);
      dv().setInt32(g.screen, g.screenValue, true);
    }
    refreshKeys();
  }

  Object.assign(M.rt, api);
  M.allegro = { state, bindGlobals, refreshKeys };
  return M.allegro;
}

/**
 * The translation unit that DEFINES Allegro's data.
 *
 * Real definitions in C, not addresses conjured in JavaScript, because the program takes their
 * address and indexes them: `key[keycode]` compiles to a load from a static array, and there has to
 * be a static array. This is the same shape as the header — the library's two halves, its
 * declarations and its data, with its behaviour in JavaScript above.
 */
export const ALLEGRO_VARS = `
#include <allegro.h>
BITMAP *screen;
char key[128];
int joy_x, joy_y;
int joy_left, joy_right, joy_up, joy_down;
int joy_b1, joy_b2, joy_b3, joy_b4;
`;

/**
 * The declarations, in the shape src/compile.js's BUILTINS table wants.
 *
 * Kept here rather than in compile.js for the same reason as the header and the data unit: a shimmed
 * library is one thing described in three places, and they should be next to each other.
 */
export function allegroBuiltins(T) {
  const P = T.ptr(T.CHAR), I = T.INT, U = T.UINT, V = T.VOID;
  const f = (ret, ...params) => ({ ret, params });
  return {
    // Allegro
    allegro_init: f(I), allegro_exit: f(V),
    install_keyboard: f(I), remove_keyboard: f(V), vsync: f(V),
    initialise_joystick: f(I), poll_joystick: f(I),
    set_gfx_mode: f(I, I, I, I, I, I),
    set_color: f(V, I, P), set_palette: f(V, P), get_palette: f(V, P),
    create_bitmap: f(P, I, I), destroy_bitmap: f(V, P),
    bmp_write_line: f(T.ULONG, P, I),
    save_pcx: f(I, P, P, P),
    readkey: f(I), keypressed: f(I), clear_keybuf: f(V),

    // SEAL
    AInitialize: f(U), AGetAudioNumDevs: f(U), AGetAudioDevCaps: f(U, U, P),
    AOpenAudio: f(U, P), ACloseAudio: f(U), AUpdateAudio: f(U),
    AOpenVoices: f(U, U), ACloseVoices: f(U),
    ACreateAudioVoice: f(U, P), ADestroyAudioVoice: f(U, U),
    APlayVoice: f(U, U, P), AStopVoice: f(U, U),
    ASetVoiceFrequency: f(U, U, U), ASetVoiceVolume: f(U, U, U), ASetVoicePanning: f(U, U, U),
    AGetVoicePosition: f(U, U, P),
    ACreateAudioData: f(U, P), ADestroyAudioData: f(U, P), AWriteAudioData: f(U, P, T.ULONG, U),

    // DJGPP
    _dosmemputb: f(V, P, I, T.ULONG), _dosmemputw: f(V, P, I, T.ULONG),
    _dosmemputl: f(V, P, I, T.ULONG), dosmemput: f(V, P, I, T.ULONG),
    _dosmemgetb: f(V, T.ULONG, I, P), _dosmemgetw: f(V, T.ULONG, I, P),
    _dosmemgetl: f(V, T.ULONG, I, P), dosmemget: f(V, T.ULONG, I, P),
    movedata: f(V, U, U, U, U, U),
    _go32_my_ds: f(T.USHORT),
    _farpokeb: f(V, U, T.ULONG, T.UCHAR), _farpokew: f(V, U, T.ULONG, T.USHORT),
    _farpokel: f(V, U, T.ULONG, T.ULONG),
    _farpeekb: f(T.UCHAR, U, T.ULONG), _farpeekw: f(T.USHORT, U, T.ULONG),
    _farpeekl: f(T.ULONG, U, T.ULONG),
    _farsetsel: f(V, U), _fargetsel: f(T.USHORT),
    _farnspokeb: f(V, T.ULONG, T.UCHAR), _farnspokew: f(V, T.ULONG, T.USHORT),
    _farnspokel: f(V, T.ULONG, T.ULONG),
    _farnspeekb: f(T.UCHAR, T.ULONG), _farnspeekw: f(T.USHORT, T.ULONG),
    _farnspeekl: f(T.ULONG, T.ULONG),
    delay: f(V, U), filelength: f(T.LONG, I),

    stricmp: f(I, P, P),
    strcmpi: { ret: I, params: [P, P], impl: 'stricmp' },
  };
}
