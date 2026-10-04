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
const E_TYPE = 0, E_KEY_STATE = 2, E_KEY_SYM = 8, E_KEY_UNICODE = 16,
      E_BTN_BUTTON = 2, E_BTN_STATE = 3, E_BTN_X = 4, E_BTN_Y = 6,
      E_MOTION_STATE = 2, E_MOTION_X = 4, E_MOTION_Y = 6, E_MOTION_XREL = 8, E_MOTION_YREL = 10, E_SIZE = 20;

const SDL_KEYDOWN = 2, SDL_KEYUP = 3, SDL_MOUSEMOTION = 4, SDL_MOUSEBUTTONDOWN = 5, SDL_MOUSEBUTTONUP = 6;
const SDL_PRESSED = 1, SDL_RELEASED = 0;
const SDL_OPENGL = 0x00000002;

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

import { mixerApi, mixerBuiltins, MIXER_STATE, pumpMixer } from './sdlmixer.js';

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
    clock,                   // one clock for GetTicks and Delay both, see env/clock.js
    ...MIXER_STATE,          // the mixer's bookkeeping, shared with the SDL 2 environment
  };

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
  const makeSurface = (w, h, depth) => {
    const bytes = depth === 8 ? 1 : 4;
    const pitch = w * bytes;
    const pix = M.rt.malloc(pitch * h);
    M.u8.fill(0, pix, pix + pitch * h);

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
      d.setUint32(fmt + F_RMASK, 0x000000ff, true);
      d.setUint32(fmt + F_GMASK, 0x0000ff00, true);
      d.setUint32(fmt + F_BMASK, 0x00ff0000, true);
      d.setUint32(fmt + F_AMASK, 0xff000000, true);
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
    SDL_CreateRGBSurface: (_flags, w, h, depth) => makeSurface(w | 0, h | 0, depth | 0 || 32),
    SDL_FreeSurface: () => 0,    // the guest heap is not reclaimed here; nothing leaks per frame
    SDL_LockSurface: () => 0,    // software surfaces are always addressable
    SDL_UnlockSurface: () => 0,
    SDL_Flip: (s) => { state.pump(); if (state.onPresent) state.onPresent(s || state.surface); return 0; },
    SDL_UpdateRect: (s) => { state.pump(); if (state.onPresent) state.onPresent(s || state.surface); },
    SDL_SetColorKey: () => 0,
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
      return ((r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | 0xff000000) >>> 0;
    },
    SDL_MapRGBA: (fmt, r, g, b, a) => {
      const bits = fmt ? M.u8[fmt + F_BITS] : 8;
      if (bits === 8) return mapToPalette(r & 0xff, g & 0xff, b & 0xff);
      return ((r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | ((a & 0xff) << 24)) >>> 0;
    },

    // ---- input -----------------------------------------------------------------------------
    SDL_EnableUNICODE: () => 0,
    SDL_EnableKeyRepeat: () => 0,
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
      const e = state.keyboard.next ? state.keyboard.next() : null;
      if (!e) return 0;
      if (!ev) return 1;
      const table = e.extended ? SDLK.extended : SDLK.plain;
      const sym = table[e.scan] ?? SDLK.plain[e.scan] ?? 0;
      M.u8.fill(0, ev, ev + E_SIZE);
      d.setUint8(ev + E_TYPE, e.down ? SDL_KEYDOWN : SDL_KEYUP);
      d.setUint8(ev + E_KEY_STATE, e.down ? SDL_PRESSED : SDL_RELEASED);
      d.setInt32(ev + E_KEY_SYM, sym, true);
      d.setUint16(ev + E_KEY_UNICODE, e.ascii ?? 0, true);
      return 1;
    },

    // ---- joysticks: none, answered honestly rather than left undefined ----------------------
    SDL_NumJoysticks: () => 0,
    SDL_JoystickOpen: () => 0,
    SDL_JoystickClose: () => 0,
    SDL_JoystickGetAxis: () => 0,
    SDL_JoystickGetButton: () => 0,

    /*
     * ---- audio ----------------------------------------------------------------------------
     * The lock pair is a NO-OP and that is the honest answer, not a shortcut: it exists to keep the
     * program's data away from SDL's audio thread, and there is no audio thread here. Making it a
     * real lock would be inventing a hazard in order to guard against it.
     */
    SDL_LockAudio: () => 0,
    SDL_UnlockAudio: () => 0,
    SDL_PauseAudio: () => 0,
    SDL_CloseAudio: () => 0,

    ...mixerApi(M, state, { readRW }),
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
