// sdl12.js — SDL 1.2, for the ports written against it.
//
// NOT a variant of sdl2.js. The two APIs overlap on names and disagree behind them, which is why
// this and its headers travel together on one environment and why naming both is refused
// (src/env/registry.js). Every struct offset below is the one src/env/headers-sdl12.js declares,
// and tools/gate-sdl12abi.mjs checks both against the real headers -- so the layout the guest reads
// and the layout this file writes cannot drift apart without a gate going red.
//
// THE 40 ENTRY POINTS corpus/jumpnbump-sdl12 CALLS, counted by PRISM's own undefined-symbol report
// rather than by grep. Most are bookkeeping; the work is in three places.
//
// THE PIXEL PATH is the conventional 8-bit one and lands on the seam PRISM already has:
// SDL_SetVideoMode hands back a paletted surface, the program writes into surface->pixels at
// surface->pitch, and SDL_Flip publishes. Nothing is scaled or converted here -- by the time it
// flips, the program has drawn every pixel. Same shape as XPutImage in x11.js and as writing to
// 0xA0000 under DOS.
//
// THE KEYBOARD is where SDL 1.2 asks for something PRISM only recently had. The game reads the
// arrows (SDLK_UP is 273) and the numeric keypad (SDLK_KP8 is 264) as different keys, and in scan
// code set 1 they ARE the same code -- 72 for both. What separates them is the 0xE0 prefix a real
// controller sends, which this host now carries beside the code. Without it the keypad and the
// arrows would be one key here, silently.
//
// THE AUDIO CALLBACK is the one real design question, and this build answers it more simply than
// SDL2's does. Real SDL runs the mixing callback on its own thread and the program guards against
// it with SDL_LockAudio; there are no threads here, so the lock pair is honestly a no-op -- there
// is nothing to race with -- and the callback registered through Mix_SetPostMix is RECORDED and
// pulled by pumpAudio(), the same answer safepoints give for the timer. What this build does NOT
// need is thread emulation: SDL_CreateThread and the semaphores live inside #ifdef USE_KAILLERA in
// sdl/interrpt.c, the netplay lobby, which this target does not select.
//
// SINCE THEN, FOR corpus/tuxracer-0.61: an OPENGL display -- SDL_SetVideoMode with SDL_OPENGL makes
// gl.js's framebuffer the display and SDL_GL_SwapBuffers publishes it -- the whole keyboard rather
// than one game's keys, the mouse as events, and SDL_RWFromFile for Mix_LoadWAV. And SDL_mixer now
// mixes for itself (src/env/sdlmixer.js), so the calls where a program yields to SDL -- a delay, a
// tick query, an event poll, a flip or a swap -- are also where the buffers due by the clock get
// mixed: state.pump(), the audio thread's work done at the safepoints.
//
// AND FOR corpus/scummvm-0.6.1, whose SDL backend draws the game in 8 bits, converts it to a 16-bit
// display with SDL_BlitSurface, runs its scalers over that and presents with SDL_UpdateRects: surfaces
// of any depth SDL 1.2 lays out (8, 15, 16, 32 bits, described by their masks), blits that convert
// between them, fills, surfaces made around the program's own pixels; the audio callback of
// SDL_OpenAudio -- which is the mixer's post-mix hook by another name, so it is pumped by the same
// clock; the periodic timer, fired at the same points; and honest answers for the CD-ROM and the
// joystick, which are not here.

/* SDL_Surface, SDL 1.2's. pitch is 16-BIT here -- SDL2 widened it, and the padding hides the
   difference from offsetof, which is why the gate measures member widths too. */
const S_FLAGS = 0, S_FORMAT = 4, S_W = 8, S_H = 12, S_PITCH = 16, S_PIXELS = 20,
      S_CLIP = 32, S_LOCKED = 44, S_REFCOUNT = 56, S_SIZE = 60;

/* SDL_PixelFormat, SDL 1.2's: palette first, then the two depth bytes, then the masks. */
const F_PALETTE = 0, F_BITS = 4, F_BYTES = 5, F_RMASK = 16, F_GMASK = 20, F_BMASK = 24,
      F_AMASK = 28, F_COLORKEY = 32, F_ALPHA = 36, F_SIZE = 40;

/* SDL_Palette { int ncolors; SDL_Color *colors; } and SDL_Color { r, g, b, unused }. */
const P_NCOLORS = 0, P_COLORS = 4, P_SIZE = 8, COLOR_SIZE = 4;

/* SDL_Event, SDL 1.2's. `type` is a Uint8 here and a Uint32 in SDL2 -- the difference that makes
   one version's PollEvent unusable by the other's program. */
const E_TYPE = 0, E_KEY_STATE = 2, E_KEY_SCAN = 4, E_KEY_SYM = 8, E_KEY_MOD = 12, E_KEY_UNICODE = 16,
      E_BTN_BUTTON = 2, E_BTN_STATE = 3, E_BTN_X = 4, E_BTN_Y = 6,
      E_MOTION_STATE = 2, E_MOTION_X = 4, E_MOTION_Y = 6, E_MOTION_XREL = 8, E_MOTION_YREL = 10, E_SIZE = 20;

const SDL_KEYDOWN = 2, SDL_KEYUP = 3, SDL_MOUSEMOTION = 4, SDL_MOUSEBUTTONDOWN = 5, SDL_MOUSEBUTTONUP = 6;
const SDL_PRESSED = 1, SDL_RELEASED = 0;
/* The modifier each modifier key holds, by its symbol (SDL_keysym.h). */
const KMOD_OF = { 304: 0x0001, 303: 0x0002, 306: 0x0040, 305: 0x0080, 308: 0x0100, 307: 0x0200, 310: 0x0400, 309: 0x0800 };
const SDL_OPENGL = 0x00000002;

/* SDL_PixelFormat's loss and shift bytes, between the depth bytes and the masks. */
const F_RLOSS = 6, F_RSHIFT = 10;
/* SDL_AudioSpec: measured by tools/gate-sdl12abi.mjs like everything above. */
const A_FREQ = 0, A_FORMAT = 4, A_CHANNELS = 6, A_SILENCE = 7, A_SAMPLES = 8, A_SIZE = 12, A_CALLBACK = 16, A_USERDATA = 20, A_BYTES = 24;
const AUDIO_U8 = 0x0008, AUDIO_S16LSB = 0x8010;
/* The masks SDL gives a display of each depth when the program names none: 16 bits is 5-6-5, the
   format of every X server and frame buffer of the period; 15 is 5-5-5. 32 keeps this file's RGBA. */
const DEFAULT_MASKS = {
  15: [0x7c00, 0x03e0, 0x001f, 0],
  16: [0xf800, 0x07e0, 0x001f, 0],
  32: [0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000],
};
const CD_ERROR = -1;
const SDL_SRCALPHA = 0x00010000, SDL_SRCCOLORKEY = 0x00001000;

/*
 * Scan code set 1 -> SDLKey, for a US keyboard. `extended` is the 0xE0 prefix: the arrows and the
 * keypad share a code and SDL 1.2 gives them different symbols, so the prefix is the whole
 * difference between SDLK_UP and SDLK_KP8. A printable key's symbol is its unshifted character.
 */
const SCAN_CHARS = `\0\x1b1234567890-=\b\tqwertyuiop[]\r\0asdfghjkl;'\`\0\\zxcvbnm,./\0\0\0 `;
const SDLK = {
  plain: {
    29: 306, 42: 304, 54: 303, 56: 308,               // left Ctrl, left Shift, right Shift, left Alt
    55: 268, 58: 301, 69: 300, 70: 302,               // keypad *, Caps Lock, Num Lock, Scroll Lock
    59: 282, 60: 283, 61: 284, 62: 285, 63: 286, 64: 287, 65: 288, 66: 289, 67: 290, 68: 291,   // F1..F10
    87: 292, 88: 293,                                 // F11 F12
    71: 263, 72: 264, 73: 265, 74: 269,               // keypad 7 8 9 -
    75: 260, 76: 261, 77: 262, 78: 270,               // keypad 4 5 6 +
    79: 257, 80: 258, 81: 259, 82: 256, 83: 266,      // keypad 1 2 3 0 .
  },
  extended: {
    28: 271, 29: 305, 53: 267, 56: 307,               // keypad Enter, right Ctrl, keypad /, right Alt
    71: 278, 72: 273, 73: 280, 75: 276, 77: 275,      // Home, up, Page Up, left, right
    79: 279, 80: 274, 81: 281, 82: 277, 83: 127,      // End, down, Page Down, Insert, Delete
    91: 310, 92: 309,                                 // left and right Meta
  },
};
for (let scan = 1; scan < SCAN_CHARS.length; scan++) {
  const ch = SCAN_CHARS.charCodeAt(scan);
  if (ch) SDLK.plain[scan] = ch;
}

/** The SDLKey this shim reports for a scan code (set 1, `extended` the 0xE0 prefix): the table above, as SDL_PollEvent reads it. */
export const sdl12KeySym = (scan, extended) => (extended ? SDLK.extended : SDLK.plain)[scan] ?? SDLK.plain[scan] ?? 0;

import { mixerApi, mixerBuiltins, MIXER_STATE, pumpMixer } from './sdlmixer.js';
import { freeRunningClock } from './clock.js';

export function installSDL12(M, { onPresent = null, onPalette = null, keyboard = null,
                                 clock = freeRunningClock() } = {}) {
  const dv = () => M.mod.dv;
  const enc = new TextEncoder();

  /*
   * The three host hooks live in `state` and are READ AT CALL TIME, not captured here, so a harness
   * can attach them after the build the way it already assigns M.vga.onFrame. tools/build.mjs has to:
   * what it wants to do on a flip -- count the frame, tap a key, stop the run -- is not knowable
   * until the program has been compiled.
   */
  const state = {
    onPresent,
    onPalette,
    keyboard,
    surface: 0,             // the display surface's guest address
    width: 0,
    height: 0,
    pixels: 0,              // its pixel buffer
    palette: new Uint8Array(768),   // 0..255 per channel, as a host would want it
    error: 0,
    opengl: false,          // the display is an OpenGL context: gl.js draws, SDL only swaps
    onSwap: null,           // host hook: called at SDL_GL_SwapBuffers with the GL layer
    mouse: null,            // host hook: { poll() -> { x, y, buttons } }, buttons as SDL's mask
    mods: 0,                // the modifier keys held, as SDLMod bits
    clock,                   // one clock for GetTicks and Delay both, see env/clock.js
    ...MIXER_STATE,          // the mixer's bookkeeping, shared with the SDL 2 environment
  };

  // time() moves on with this clock, by whole seconds (src/runtime/runtime.js), read without the
  // step a guest's own reading takes; the clock is read at call time, as a host may replace it.
  M.timeSeconds = () => Math.floor(state.clock.peek() / 1000);

  const intern = (s) => M.mod.intern([...enc.encode(s), 0]);
  const noError = intern('');
  state.error = noError;
  /* SDL_GetError's text, which SDL_mixer sets too: Mix_GetError is the same string there. */
  state.setError = (text) => {
    if (state.error !== noError) M.rt.free(state.error);
    const bytes = enc.encode(text);
    state.error = M.rt.malloc(bytes.length + 1);
    M.u8.set(bytes, state.error); M.u8[state.error + bytes.length] = 0;
  };

  /* Files opened by SDL_RWFromFile: the handle is a guest block, so it is non-NULL and its own. */
  const rwFiles = new Map();
  const readRW = (rw) => {
    const bytes = rwFiles.get(rw) ?? null;
    if (rwFiles.delete(rw)) M.rt.free(rw);
    return bytes;
  };

  /* Mouse events are made here, from the difference between two polls of the host's pointer. */
  const pointer = { x: 0, y: 0, buttons: 0 };
  const queue = [];
  const gatherMouse = () => {
    if (!state.mouse) return;
    const p = state.mouse.poll();
    if (p.x !== pointer.x || p.y !== pointer.y) {
      queue.push({ type: SDL_MOUSEMOTION, x: p.x, y: p.y, xrel: p.x - pointer.x, yrel: p.y - pointer.y, held: p.buttons });
      pointer.x = p.x; pointer.y = p.y;
    }
    for (let button = 1; button <= 3; button++) {
      const bit = 1 << (button - 1);
      if ((p.buttons & bit) !== (pointer.buttons & bit)) {
        queue.push({ type: p.buttons & bit ? SDL_MOUSEBUTTONDOWN : SDL_MOUSEBUTTONUP, button, x: p.x, y: p.y });
      }
    }
    pointer.buttons = p.buttons;
  };

  /** A surface plus its format, laid out where the header says. Returns the surface's address. */
  const makeSurface = (w, h, depth, { masks = null, pixels = 0, pitch: givenPitch = 0 } = {}) => {
    const bytes = depth === 8 ? 1 : depth <= 16 ? 2 : depth === 24 ? 3 : 4;
    const pitch = givenPitch || w * bytes;
    // A surface made FROM the program's pixels uses them where they are; SDL does not copy them.
    const pix = pixels || M.rt.malloc(pitch * h);
    if (!pixels) M.u8.fill(0, pix, pix + pitch * h);

    const fmt = M.rt.malloc(F_SIZE);
    M.u8.fill(0, fmt, fmt + F_SIZE);
    const d = dv();
    d.setUint8(fmt + F_BITS, depth);
    d.setUint8(fmt + F_BYTES, bytes);
    if (depth === 8) {
      // An 8-bit surface owns a palette; the program reaches its colours through format->palette.
      const colors = M.rt.malloc(256 * COLOR_SIZE);
      M.u8.fill(0, colors, colors + 256 * COLOR_SIZE);
      const pal = M.rt.malloc(P_SIZE);
      d.setInt32(pal + P_NCOLORS, 256, true);
      d.setUint32(pal + P_COLORS, colors, true);
      d.setUint32(fmt + F_PALETTE, pal, true);
    } else {
      const m = masks && (masks[0] || masks[1] || masks[2]) ? masks : (DEFAULT_MASKS[depth] ?? DEFAULT_MASKS[32]);
      // Each mask, and the shift and loss SDL derives from it: where the component sits, and how
      // many of its 8 bits the format drops.
      m.forEach((mask, i) => {
        d.setUint32(fmt + F_RMASK + 4 * i, mask >>> 0, true);
        let shift = 0, bits = 0;
        if (mask) { while (!((mask >>> shift) & 1)) shift++; while ((mask >>> (shift + bits)) & 1) bits++; }
        d.setUint8(fmt + F_RLOSS + i, 8 - Math.min(bits, 8));
        d.setUint8(fmt + F_RSHIFT + i, shift);
      });
    }

    const s = M.rt.malloc(S_SIZE);
    M.u8.fill(0, s, s + S_SIZE);
    d.setUint32(s + S_FORMAT, fmt, true);
    d.setInt32(s + S_W, w, true);
    d.setInt32(s + S_H, h, true);
    d.setUint16(s + S_PITCH, pitch, true);   // 16-bit: see the header
    d.setUint32(s + S_PIXELS, pix, true);
    d.setInt32(s + S_REFCOUNT, 1, true);
    // clip_rect covers the whole surface, which is what SDL sets on creation.
    d.setInt16(s + S_CLIP + 0, 0, true); d.setInt16(s + S_CLIP + 2, 0, true);
    d.setUint16(s + S_CLIP + 4, w, true); d.setUint16(s + S_CLIP + 6, h, true);
    return s;
  };

  const surfacePixels = (s) => (s ? dv().getUint32(s + S_PIXELS, true) : 0);
  const surfaceFormat = (s) => (s ? dv().getUint32(s + S_FORMAT, true) : 0);

  /** What a blit or a fill needs to know about a surface, read from guest memory each time. */
  const info = (s) => {
    const d = dv(), fmt = surfaceFormat(s);
    const bits = M.u8[fmt + F_BITS], bytes = M.u8[fmt + F_BYTES];
    const pal = bits === 8 ? d.getUint32(fmt + F_PALETTE, true) : 0;
    return {
      w: d.getInt32(s + S_W, true), h: d.getInt32(s + S_H, true), pitch: d.getUint16(s + S_PITCH, true),
      pixels: d.getUint32(s + S_PIXELS, true), fmt, bits, bytes,
      colors: pal ? d.getUint32(pal + P_COLORS, true) : 0,
      masks: [0, 1, 2, 3].map((i) => d.getUint32(fmt + F_RMASK + 4 * i, true)),
      shifts: [0, 1, 2, 3].map((i) => M.u8[fmt + F_RSHIFT + i]),
      losses: [0, 1, 2, 3].map((i) => M.u8[fmt + F_RLOSS + i]),
      clip: [0, 2, 4, 6].map((o, i) => (i < 2 ? d.getInt16(s + S_CLIP + o, true) : d.getUint16(s + S_CLIP + o, true))),
    };
  };
  const getPixel = (a, bytes) => (bytes === 1 ? M.u8[a] : bytes === 2 ? M.u8[a] | (M.u8[a + 1] << 8)
    : bytes === 3 ? M.u8[a] | (M.u8[a + 1] << 8) | (M.u8[a + 2] << 16) : dv().getUint32(a, true));
  const putPixel = (a, bytes, v) => {
    M.u8[a] = v; if (bytes > 1) M.u8[a + 1] = v >>> 8; if (bytes > 2) M.u8[a + 2] = v >>> 16; if (bytes > 3) M.u8[a + 3] = v >>> 24;
  };
  /* A component widened back to 8 bits the way SDL does it: shifted up, the low bits left zero. */
  const toRGB = (fi, p) => (fi.bits === 8
    ? [M.u8[fi.colors + 4 * p], M.u8[fi.colors + 4 * p + 1], M.u8[fi.colors + 4 * p + 2]]
    : [0, 1, 2].map((i) => (((p & fi.masks[i]) >>> fi.shifts[i]) << fi.losses[i]) & 0xff));
  const fromRGB = (fi, r, g, b) => {
    if (fi.bits === 8) return mapToPalette(r, g, b);
    return ((((r >> fi.losses[0]) << fi.shifts[0]) | ((g >> fi.losses[1]) << fi.shifts[1]) | ((b >> fi.losses[2]) << fi.shifts[2]) | fi.masks[3]) >>> 0);
  };
  /** A rectangle argument, or the whole surface when it is NULL. */
  const rectOf = (r, w, h) => (r ? [dv().getInt16(r, true), dv().getInt16(r + 2, true), dv().getUint16(r + 4, true), dv().getUint16(r + 6, true)] : [0, 0, w, h]);

  /*
   * Nearest colour in the palette, which is what SDL_MapRGB means on an 8-bit surface. The game
   * calls it once per palette entry to find its own index back, so an exact hit is the common case
   * and the search only matters when it is not.
   */
  const mapToPalette = (r, g, b) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = state.palette[i * 3] - r, dg = state.palette[i * 3 + 1] - g,
            db = state.palette[i * 3 + 2] - b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestD) { bestD = dist; best = i; if (dist === 0) break; }
    }
    return best;
  };

  const pumpAudio = (buffer, bytes) => pumpMixer(M, state, buffer, bytes);

  const api = {
    // ---- lifecycle -------------------------------------------------------------------------
    SDL_Init: () => 0,
    SDL_InitSubSystem: () => 0,
    SDL_Quit: () => 0,
    SDL_GetError: () => state.error,
    // A limiter built on sleeping SPINS when the sleep does nothing, so the host answers instead.
    SDL_Delay: (ms) => { state.clock.delay(ms | 0); state.pump(); return 0; },
    SDL_GetTicks: () => { state.pump(); return state.clock.now(); },
    SDL_RWFromFile: (name, _mode) => {
      const path = M.mod.cstr(name);
      const key = M.files ? M.files.find(path, { guess: false }) : null;
      if (key === null) { state.setError(`Couldn't open ${path}`); return 0; }
      const rw = M.rt.malloc(4);
      rwFiles.set(rw, M.files.store.get(key));
      return rw;
    },

    // ---- video -----------------------------------------------------------------------------
    SDL_SetVideoMode: (w, h, depth, flags) => {
      state.width = w | 0;
      state.height = h | 0;
      state.depth = depth | 0 || 8;
      if (flags & SDL_OPENGL) {
        /*
         * An OpenGL display. The surface SDL hands back is one the program never draws into -- it
         * keeps the pointer and tests it against NULL -- so it has the geometry and no pixels.
         */
        if (!M.gl) { state.setError('No OpenGL here: the gl environment is not in the target\'s env list'); return 0; }
        M.gl.resize(state.width, state.height);
        state.opengl = true;
        state.surface = makeSurface(1, 1, 32);
        dv().setUint32(state.surface + S_FLAGS, flags >>> 0, true);
        dv().setInt32(state.surface + S_W, state.width, true);
        dv().setInt32(state.surface + S_H, state.height, true);
        state.pixels = 0;
        return state.surface;
      }
      state.opengl = false;
      state.surface = makeSurface(w | 0, h | 0, depth | 0 || 8);
      state.pixels = surfacePixels(state.surface);
      return state.surface;
    },
    SDL_GL_SetAttribute: () => 0,
    // No extension entry points: NULL is what SDL answers for a name the driver does not export.
    SDL_GL_GetProcAddress: () => 0,
    SDL_GL_SwapBuffers: () => { state.pump(); if (state.onSwap) state.onSwap(M.gl); },
    SDL_GetVideoSurface: () => state.surface,
    SDL_CreateRGBSurface: (_flags, w, h, depth, r, g, b, a) => makeSurface(w | 0, h | 0, depth | 0 || 32, { masks: [r >>> 0, g >>> 0, b >>> 0, a >>> 0] }),
    SDL_FreeSurface: () => 0,    // the guest heap is not reclaimed here; nothing leaks per frame
    SDL_LockSurface: () => 0,    // software surfaces are always addressable
    SDL_UnlockSurface: () => 0,
    SDL_Flip: (s) => { state.pump(); if (state.onPresent) state.onPresent(s || state.surface); return 0; },
    SDL_UpdateRect: (s) => { state.pump(); if (state.onPresent) state.onPresent(s || state.surface); },
    // The colour key, kept where SDL keeps it (flags, format->colorkey); SDL_UpperBlit leaves the
    // pixels that match it alone. ScummVM 0.10.0 draws its mouse cursor through one.
    SDL_SetColorKey: (surf, flag, key) => {
      if (!surf) return -1;
      const d = dv(), fmt = d.getUint32(surf + 4, true), flags = d.getUint32(surf, true);
      if (flag & SDL_SRCCOLORKEY) { d.setUint32(surf, (flags | SDL_SRCCOLORKEY) >>> 0, true); d.setUint32(fmt + 32, key >>> 0, true); }
      else { d.setUint32(surf, (flags & ~SDL_SRCCOLORKEY) >>> 0, true); d.setUint32(fmt + 32, 0, true); }
      return 0;
    },
    // Per-surface alpha, recorded where SDL keeps it (flags, format->alpha); SDL_UpperBlit refuses to
    // blend with it rather than guess SDL's arithmetic.
    SDL_SetAlpha: (surf, flag, alpha) => {
      if (!surf) return -1;
      const d = dv(), fmt = d.getUint32(surf + 4, true);
      const flags = d.getUint32(surf, true);
      if (flag & SDL_SRCALPHA) { d.setUint32(surf, (flags | SDL_SRCALPHA) >>> 0, true); M.u8[fmt + 36] = alpha & 0xff; }
      else { d.setUint32(surf, (flags & ~SDL_SRCALPHA) >>> 0, true); M.u8[fmt + 36] = 255; }
      return 0;
    },
    SDL_WM_IconifyWindow: () => 0,
    SDL_WM_SetCaption: () => 0,
    SDL_WM_SetIcon: () => 0,
    SDL_WM_ToggleFullScreen: () => 0,   // 0 = refused, which the program treats as "stay windowed"
    SDL_ShowCursor: () => 0,

    /*
     * The palette, in BOTH places it has to be: the surface's own SDL_Color array, because the
     * program may read it back through format->palette, and this host's 768-byte copy, which is
     * what a display actually needs. Writing only one of them is the kind of half-update that
     * shows as colours that are right until something re-reads them.
     */
    SDL_SetColors: (s, colors, first, n) => {
      const d = dv();
      const fmt = surfaceFormat(s || state.surface);
      const pal = fmt ? d.getUint32(fmt + F_PALETTE, true) : 0;
      const dst = pal ? d.getUint32(pal + P_COLORS, true) : 0;
      for (let i = 0; i < (n | 0); i++) {
        const idx = (first | 0) + i;
        if (idx < 0 || idx > 255) continue;
        const src = colors + i * COLOR_SIZE;
        const r = M.u8[src], g = M.u8[src + 1], b = M.u8[src + 2];
        state.palette[idx * 3] = r;
        state.palette[idx * 3 + 1] = g;
        state.palette[idx * 3 + 2] = b;
        if (dst) {
          M.u8[dst + idx * COLOR_SIZE] = r;
          M.u8[dst + idx * COLOR_SIZE + 1] = g;
          M.u8[dst + idx * COLOR_SIZE + 2] = b;
        }
      }
      if (state.onPalette) state.onPalette(state.palette);
      return 1;
    },

    SDL_MapRGB: (fmt, r, g, b) => {
      const bits = fmt ? M.u8[fmt + F_BITS] : 8;
      if (bits === 8) return mapToPalette(r & 0xff, g & 0xff, b & 0xff);
      // By the format's own masks: a 16-bit display is 5-6-5, not RGBA.
      const fi = { bits, masks: [0, 1, 2, 3].map((i) => dv().getUint32(fmt + F_RMASK + 4 * i, true)), shifts: [0, 1, 2].map((i) => M.u8[fmt + F_RSHIFT + i]), losses: [0, 1, 2].map((i) => M.u8[fmt + F_RLOSS + i]) };
      return fromRGB(fi, r & 0xff, g & 0xff, b & 0xff);
    },
    SDL_MapRGBA: (fmt, r, g, b, a) => {
      const bits = fmt ? M.u8[fmt + F_BITS] : 8;
      if (bits === 8) return mapToPalette(r & 0xff, g & 0xff, b & 0xff);
      return ((r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | ((a & 0xff) << 24)) >>> 0;
    },

    SDL_UpdateRects: (s) => { state.pump(); if (state.onPresent) state.onPresent(s || state.surface); },
    SDL_VideoModeOK: (_w, _h, bpp) => (bpp | 0) || 16,
    SDL_CreateRGBSurfaceFrom: (pixels, w, h, depth, pitch, r, g, b, a) =>
      makeSurface(w | 0, h | 0, depth | 0, { masks: [r >>> 0, g >>> 0, b >>> 0, a >>> 0], pixels, pitch: pitch | 0 }),
    SDL_GetRGB: (pixel, fmt, rp, gp, bp) => {
      const bits = M.u8[fmt + F_BITS];
      const fi = bits === 8
        ? { bits, colors: dv().getUint32(dv().getUint32(fmt + F_PALETTE, true) + P_COLORS, true) }
        : { bits, masks: [0, 1, 2].map((i) => dv().getUint32(fmt + F_RMASK + 4 * i, true)), shifts: [0, 1, 2].map((i) => M.u8[fmt + F_RSHIFT + i]), losses: [0, 1, 2].map((i) => M.u8[fmt + F_RLOSS + i]) };
      const [r, g, b] = toRGB(fi, pixel >>> 0);
      if (rp) M.u8[rp] = r; if (gp) M.u8[gp] = g; if (bp) M.u8[bp] = b;
    },

    /*
     * SDL_BlitSurface. The source rectangle is clipped to the source, the destination to its clip
     * rectangle, and `dstrect` is given back the rectangle actually drawn, as SDL does. Between two
     * surfaces of one format a row is a copy; otherwise each pixel goes through RGB -- an 8-bit
     * source through ITS palette, which is how a game's 8-bit screen becomes a 16-bit display.
     * A colour key (SDL_SetColorKey) is applied: its pixels are left alone.
     */
    SDL_UpperBlit: (src, srcrect, dst, dstrect) => {
      if ((dv().getUint32(src, true) & SDL_SRCALPHA) && M.u8[dv().getUint32(src + 4, true) + 36] !== 255) {
        throw new Error('SDL_BlitSurface: a source with per-surface alpha is not blended here yet (SDL_SetAlpha)');
      }
      const S = info(src), D = info(dst);
      let [sx, sy, w, h] = rectOf(srcrect, S.w, S.h);
      let [dx, dy] = dstrect ? rectOf(dstrect, 0, 0) : [0, 0];
      if (sx < 0) { w += sx; dx -= sx; sx = 0; }
      if (sy < 0) { h += sy; dy -= sy; sy = 0; }
      w = Math.min(w, S.w - sx); h = Math.min(h, S.h - sy);
      const [cx, cy, cw, ch] = D.clip;
      if (dx < cx) { w -= cx - dx; sx += cx - dx; dx = cx; }
      if (dy < cy) { h -= cy - dy; sy += cy - dy; dy = cy; }
      w = Math.min(w, cx + cw - dx); h = Math.min(h, cy + ch - dy);
      if (w < 0) w = 0; if (h < 0) h = 0;
      if (dstrect) { const d = dv(); d.setInt16(dstrect, dx, true); d.setInt16(dstrect + 2, dy, true); d.setUint16(dstrect + 4, w, true); d.setUint16(dstrect + 6, h, true); }
      if (!w || !h) return 0;
      const same = S.bytes === D.bytes && (S.bits === 8 ? D.bits === 8 : S.masks.every((m, i) => m === D.masks[i]));
      // A colour-keyed source: a pixel equal to the key, its alpha bits aside, is not copied (SDL 1.2's
      // BlitNtoNKey, Blit1toNKey).
      const keyed = (dv().getUint32(src, true) & SDL_SRCCOLORKEY) !== 0;
      const rgbMask = S.bits === 8 ? 0xff : ~(S.masks[3] ?? 0) >>> 0;
      const key = (dv().getUint32(dv().getUint32(src + 4, true) + 32, true) & rgbMask) >>> 0;
      for (let y = 0; y < h; y++) {
        const sRow = S.pixels + (sy + y) * S.pitch + sx * S.bytes, dRow = D.pixels + (dy + y) * D.pitch + dx * D.bytes;
        if (same && !keyed) { M.u8.copyWithin(dRow, sRow, sRow + w * S.bytes); continue; }
        for (let x = 0; x < w; x++) {
          const p = getPixel(sRow + x * S.bytes, S.bytes);
          if (keyed && ((p & rgbMask) >>> 0) === key) continue;
          if (same) { putPixel(dRow + x * D.bytes, D.bytes, p); continue; }
          const [r, g, b] = toRGB(S, p);
          putPixel(dRow + x * D.bytes, D.bytes, fromRGB(D, r, g, b));
        }
      }
      return 0;
    },
    SDL_FillRect: (dst, rect, color) => {
      const D = info(dst);
      let [x, y, w, h] = rectOf(rect, D.w, D.h);
      const [cx, cy, cw, ch] = D.clip;
      const x0 = Math.max(x, cx), y0 = Math.max(y, cy);
      const x1 = Math.min(x + w, cx + cw), y1 = Math.min(y + h, cy + ch);
      for (let yy = y0; yy < y1; yy++) {
        const row = D.pixels + yy * D.pitch;
        if (D.bytes === 1) M.u8.fill(color & 0xff, row + x0, row + x1);
        else for (let xx = x0; xx < x1; xx++) putPixel(row + xx * D.bytes, D.bytes, color >>> 0);
      }
      return 0;
    },
    SDL_SaveBMP_RW: (_s, rw, freedst) => { if (freedst && rw) readRW(rw); state.setError('SDL_SaveBMP: no files are written here'); return -1; },
    SDL_RWclose: (rw) => { readRW(rw); return 0; },
    SDL_WM_GrabInput: (mode) => { if ((mode | 0) >= 0) state.grab = mode | 0; return state.grab ?? 0; },

    // ---- the periodic timer: fired by pump(), at the points where the program yields to SDL ----
    SDL_SetTimer: (interval, cb) => {
      state.timer = cb && interval ? { cb, interval: interval >>> 0, next: state.clock.now() + (interval >>> 0) } : null;
      return 0;
    },
    // The newer interface: any number, each with its parameter, fired at the same points. An ID is
    // a small number the guest only hands back.
    SDL_AddTimer: (interval, cb, param) => {
      if (!cb) return 0;
      const id = (state.nextTimerId = (state.nextTimerId ?? 0) + 1);
      (state.timers ??= []).push({ id, cb, param, interval: interval >>> 0, next: state.clock.now() + (interval >>> 0) });
      return id;
    },
    SDL_RemoveTimer: (id) => {
      const i = (state.timers ?? []).findIndex((t) => t.id === id);
      if (i < 0) return 0;
      state.timers.splice(i, 1);
      return 1;
    },

    // ---- the CD-ROM: no drive -------------------------------------------------------------
    SDL_CDNumDrives: () => 0,
    SDL_CDName: () => 0,
    SDL_CDOpen: () => { state.setError('No CD-ROM drive here'); return 0; },
    SDL_CDStatus: () => CD_ERROR,
    SDL_CDPlayTracks: () => -1, SDL_CDPlay: () => -1, SDL_CDPause: () => -1, SDL_CDResume: () => -1,
    SDL_CDStop: () => -1, SDL_CDEject: () => -1,
    SDL_CDClose: () => 0,

    // ---- input -----------------------------------------------------------------------------
    SDL_EnableUNICODE: () => 0,
    SDL_EnableKeyRepeat: () => 0,
    SDL_GetModState: () => state.mods,
    SDL_GetMouseState: (xp, yp) => {
      if (xp) dv().setInt32(xp, pointer.x, true);
      if (yp) dv().setInt32(yp, pointer.y, true);
      return pointer.buttons;
    },
    SDL_WarpMouse: (x, y) => { if (state.mouse?.warp) state.mouse.warp(x & 0xffff, y & 0xffff); },

    /*
     * One host key event becomes one SDL 1.2 event. `extended` is what tells SDLK_UP from SDLK_KP8,
     * which share scan code 72 -- the game binds the arrows and the keypad to different players, so
     * losing that flag would silently merge two players' controls.
     */
    SDL_PollEvent: (ev) => {
      state.pump();
      gatherMouse();
      const d = dv();
      if (queue.length) {
        if (!ev) return 1;
        const m = queue.shift();
        M.u8.fill(0, ev, ev + E_SIZE);
        d.setUint8(ev + E_TYPE, m.type);
        if (m.type === SDL_MOUSEMOTION) {
          d.setUint8(ev + E_MOTION_STATE, m.held);
          d.setUint16(ev + E_MOTION_X, m.x, true); d.setUint16(ev + E_MOTION_Y, m.y, true);
          d.setInt16(ev + E_MOTION_XREL, m.xrel, true); d.setInt16(ev + E_MOTION_YREL, m.yrel, true);
        } else {
          d.setUint8(ev + E_BTN_BUTTON, m.button);
          d.setUint8(ev + E_BTN_STATE, m.type === SDL_MOUSEBUTTONDOWN ? SDL_PRESSED : SDL_RELEASED);
          d.setUint16(ev + E_BTN_X, m.x, true); d.setUint16(ev + E_BTN_Y, m.y, true);
        }
        return 1;
      }
      if (!state.keyboard) return 0;
      // SDL_PollEvent(NULL) asks whether there is an event and leaves it there: a key read to answer
      // is kept for the next call rather than dropped.
      const e = state.heldKey ?? (state.keyboard.next ? state.keyboard.next() : null);
      state.heldKey = null;
      if (!e) return 0;
      if (!ev) { state.heldKey = e; return 1; }
      const sym = sdl12KeySym(e.scan, e.extended);
      // The modifiers as they stand AFTER this event, which is what SDL reports with it.
      const bit = KMOD_OF[sym] ?? 0;
      state.mods = e.down ? (state.mods | bit) : (state.mods & ~bit);
      M.u8.fill(0, ev, ev + E_SIZE);
      d.setUint8(ev + E_TYPE, e.down ? SDL_KEYDOWN : SDL_KEYUP);
      d.setUint8(ev + E_KEY_STATE, e.down ? SDL_PRESSED : SDL_RELEASED);
      d.setUint8(ev + E_KEY_SCAN, e.scan & 0xff);
      d.setInt32(ev + E_KEY_SYM, sym, true);
      d.setInt32(ev + E_KEY_MOD, state.mods, true);
      d.setUint16(ev + E_KEY_UNICODE, e.ascii ?? 0, true);
      return 1;
    },

    // ---- joysticks: none, answered honestly rather than left undefined ----------------------
    SDL_NumJoysticks: () => 0,
    SDL_JoystickOpen: () => 0,
    SDL_JoystickClose: () => 0,
    SDL_JoystickGetAxis: () => 0,
    SDL_JoystickGetButton: () => 0,
    SDL_JoystickName: () => noError,

    /*
     * ---- audio ----------------------------------------------------------------------------
     * The lock pair is a NO-OP and that is the honest answer, not a shortcut: it exists to keep the
     * program's data away from SDL's audio thread, and there is no audio thread here. Making it a
     * real lock would be inventing a hazard in order to guard against it.
     */
    SDL_LockAudio: () => 0,
    SDL_UnlockAudio: () => 0,
    /*
     * Mutexes, for the same reason and with the same answer as the audio lock: the threads they
     * keep apart are not here. A mutex is a guest block, so it is non-NULL and its own; taking one
     * always succeeds.
     */
    SDL_CreateMutex: () => M.rt.malloc(4),
    SDL_DestroyMutex: (m) => { if (m) M.rt.free(m); },
    SDL_mutexP: () => 0,
    SDL_mutexV: () => 0,
    /*
     * SDL_OpenAudio's callback is called with (userdata, stream, len) for every buffer -- the very
     * shape of SDL_mixer's post-mix hook, so the device is the mixer's with no channels playing and
     * the callback as its hook: one pump, one clock, one path to the page's audio. The device opens
     * PAUSED, as SDL's does, until SDL_PauseAudio(0).
     */
    SDL_OpenAudio: (desired, obtained) => {
      const d = dv();
      const format = d.getUint16(desired + A_FORMAT, true), nch = M.u8[desired + A_CHANNELS];
      if (format !== AUDIO_U8 && format !== AUDIO_S16LSB) { state.setError(`Unsupported audio format 0x${format.toString(16)}`); return -1; }
      if (nch !== 1 && nch !== 2) { state.setError(`Unsupported number of audio channels: ${nch}`); return -1; }
      const frames = Math.max(d.getUint16(desired + A_SAMPLES, true), 1);
      state.freq = d.getInt32(desired + A_FREQ, true) || 22050; state.format = format; state.outChannels = nch; state.chunkFrames = frames;
      state.mixBytes = frames * nch * (format === AUDIO_U8 ? 1 : 2);
      state.mixBuf = M.rt.malloc(state.mixBytes);
      state.postMix = d.getUint32(desired + A_CALLBACK, true);
      state.postMixArg = d.getUint32(desired + A_USERDATA, true);
      state.channels = null;
      state.audioOpen = false;
      M.u8[desired + A_SILENCE] = format === AUDIO_U8 ? 0x80 : 0;
      d.setUint32(desired + A_SIZE, state.mixBytes, true);
      if (obtained) M.u8.copyWithin(obtained, desired, desired + A_BYTES);
      return 0;
    },
    SDL_PauseAudio: (on) => {
      const run = !(on | 0) && !!state.mixBuf && !!state.postMix;
      if (run && !state.audioOpen) { state.audioOpen = true; state.mixT0 = state.clock.now(); state.buffersMixed = 0; }
      else if (!run && state.audioOpen) state.audioOpen = false;
      else return 0;
      if (state.onAudioOpen) state.onAudioOpen(state);
      return 0;
    },
    SDL_CloseAudio: () => {
      if (state.audioOpen && state.onAudioOpen) { state.audioOpen = false; state.onAudioOpen(state); }
      state.audioOpen = false; state.postMix = 0;
      return 0;
    },

    ...mixerApi(M, state, { readRW }),
  };

  // The mixer's pump (installed by mixerApi above), then the timer: both are what SDL's threads
  // would have done by now, done where the program next yields.
  // NOT RE-ENTERED: SDL runs these on threads of its own, so a callback that asks for the time (and
  // ScummVM's timer handler does) never finds itself called again from inside. Here that question
  // is a pump point, and without this guard it recursed until the stack ran out.
  const mixerPump = state.pump;
  let pumping = false;
  state.pump = () => {
    if (pumping) return;
    pumping = true;
    try { pumpAll(); } finally { pumping = false; }
  };
  const pumpAll = () => {
    mixerPump();
    // SDL_AddTimer's timers, each as SDL_SetTimer's below, its parameter passed; removed by
    // SDL_RemoveTimer or by returning 0.
    for (const t of [...(state.timers ?? [])]) {
      const now = state.clock.now();
      for (let n = 0; state.timers.includes(t) && now >= t.next && n < 64; n++) {
        const again = M.icall(t.cb, [t.interval, t.param]) >>> 0;
        if (!again) { const i = state.timers.indexOf(t); if (i >= 0) state.timers.splice(i, 1); break; }
        t.interval = again; t.next += again;
      }
      if (state.timers.includes(t) && now >= t.next) t.next = now + t.interval;
    }
    const t = state.timer;
    if (!t) return;
    const now = state.clock.now();
    for (let n = 0; state.timer === t && now >= t.next && n < 64; n++) {
      const again = M.icall(t.cb, [t.interval]) >>> 0;
      if (!again) { if (state.timer === t) state.timer = null; break; }
      t.interval = again; t.next += again;
    }
    // A program that stalled longer than 64 periods catches up from now, not from the past.
    if (state.timer === t && now >= t.next) t.next = now + t.interval;
  };

  Object.assign(M.rt, api);
  // Reachable as M.sdl, the way the DAC is M.dac: a harness that wants the display or the palette
  // has nowhere else to ask.
  M.sdl = { state, pumpAudio, surfacePixels };
  return M.sdl;
}

/**
 * The signatures, which decide what a call's result is worth to the emitter. Every entry carries a
 * `ret` -- src/compile.js refuses one that does not, because a call with no result type makes its
 * CALLER unemittable and points the blame at the wrong function.
 */
export function sdl12Builtins(T) {
  const V = T.VOID, I = T.INT, U = T.UINT, P = T.ptr(T.CHAR), S = T.SHORT, B = T.UCHAR;
  const f = (ret, ...params) => ({ ret, params });
  return {
    SDL_Init: f(I, U),
    SDL_InitSubSystem: f(I, U),
    SDL_Quit: f(V),
    SDL_GetError: f(P),
    SDL_Delay: f(V, U),
    SDL_GetTicks: f(U),
    SDL_RWFromFile: f(P, P, P),

    SDL_SetVideoMode: f(P, I, I, I, U),
    SDL_GetVideoSurface: f(P),
    SDL_CreateRGBSurface: f(P, U, I, I, I, U, U, U, U),
    SDL_FreeSurface: f(V, P),
    SDL_LockSurface: f(I, P),
    SDL_UnlockSurface: f(V, P),
    SDL_GL_SetAttribute: f(I, I, I),
    SDL_GL_GetProcAddress: f(P, P),
    SDL_GL_SwapBuffers: f(V),
    SDL_Flip: f(I, P),
    SDL_UpdateRect: f(V, P, I, I, U, U),
    SDL_UpdateRects: f(V, P, I, P),
    SDL_VideoModeOK: f(I, I, I, I, U),
    SDL_CreateRGBSurfaceFrom: f(P, P, I, I, I, I, U, U, U, U),
    SDL_GetRGB: f(V, U, P, P, P, P),
    SDL_UpperBlit: f(I, P, P, P, P),
    SDL_FillRect: f(I, P, P, U),
    SDL_SaveBMP_RW: f(I, P, P, I),
    SDL_RWclose: f(I, P),
    SDL_WM_GrabInput: f(I, I),
    SDL_SetTimer: f(I, U, P), SDL_AddTimer: f(P, U, P, P), SDL_RemoveTimer: f(I, P),
    SDL_SetAlpha: f(I, P, U, B), SDL_WM_IconifyWindow: f(I),
    SDL_CDNumDrives: f(I), SDL_CDName: f(P, I), SDL_CDOpen: f(P, I), SDL_CDStatus: f(I, P),
    SDL_CDPlayTracks: f(I, P, I, I, I, I), SDL_CDPlay: f(I, P, I, I), SDL_CDPause: f(I, P), SDL_CDResume: f(I, P),
    SDL_CDStop: f(I, P), SDL_CDEject: f(I, P), SDL_CDClose: f(V, P),
    SDL_OpenAudio: f(I, P, P),
    SDL_CreateMutex: f(P), SDL_DestroyMutex: f(V, P), SDL_mutexP: f(I, P), SDL_mutexV: f(I, P),
    SDL_JoystickName: f(P, I),
    SDL_SetColors: f(I, P, P, I, I),
    SDL_SetColorKey: f(I, P, U, U),
    SDL_MapRGB: f(U, P, B, B, B),
    SDL_MapRGBA: f(U, P, B, B, B, B),
    SDL_ShowCursor: f(I, I),
    SDL_WM_SetCaption: f(V, P, P),
    SDL_WM_SetIcon: f(V, P, P),
    SDL_WM_ToggleFullScreen: f(I, P),

    SDL_PollEvent: f(I, P),
    SDL_WaitEvent: f(I, P),
    SDL_EnableUNICODE: f(I, I),
    SDL_EnableKeyRepeat: f(I, I, I),
    SDL_GetModState: f(I),
    SDL_GetMouseState: f(B, P, P),
    SDL_WarpMouse: f(V, T.USHORT, T.USHORT),

    SDL_NumJoysticks: f(I),
    SDL_JoystickOpen: f(P, I),
    SDL_JoystickClose: f(V, P),
    SDL_JoystickGetAxis: f(S, P, I),
    SDL_JoystickGetButton: f(B, P, I),

    SDL_LockAudio: f(V),
    SDL_UnlockAudio: f(V),
    SDL_PauseAudio: f(V, I),
    SDL_CloseAudio: f(V),

    ...mixerBuiltins(T),
  };
}
