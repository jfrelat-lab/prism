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
      E_BTN_BUTTON = 2, E_BTN_STATE = 3, E_BTN_X = 4, E_BTN_Y = 6, E_SIZE = 20;

const SDL_KEYDOWN = 2, SDL_KEYUP = 3;
const SDL_PRESSED = 1, SDL_RELEASED = 0;

/*
 * Scan code set 1 -> SDLKey, for the keys this corpus names, and only those. `ext` is the 0xE0
 * prefix: the arrows and the keypad share a code and SDL 1.2 gives them different symbols, so the
 * prefix is the whole difference between SDLK_UP and SDLK_KP8.
 */
const SDLK = {
  plain: {
    1: 27,                                            // Escape
    2: 49, 3: 50, 4: 51, 5: 52,                       // 1 2 3 4
    17: 119, 30: 97, 32: 100,                         // w a d
    23: 105, 36: 106, 38: 108,                        // i j l
    68: 291, 88: 293,                                 // F10 F12
    72: 264, 75: 260, 77: 262,                        // keypad 8 4 6
  },
  extended: {
    72: 273, 75: 276, 77: 275,                        // arrow up, left, right
  },
};

export function installSDL12(M, { onPresent = null, onPalette = null, keyboard = null } = {}) {
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
    ticks0: Date.now(),
    postMix: 0,             // the Mix_SetPostMix callback, or 0
    postMixArg: 0,
    audioOpen: false,
    musicPlaying: false,
    musicVolume: 128,
  };

  const intern = (s) => M.mod.intern([...enc.encode(s), 0]);
  state.error = intern('');

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

  /** Pull the recorded mixing callback, the way a host with no audio thread has to. */
  const pumpAudio = (buffer, bytes) => {
    if (!state.postMix) return 0;
    M.icall(state.postMix, [state.postMixArg, buffer, bytes]);
    return bytes;
  };

  const api = {
    // ---- lifecycle -------------------------------------------------------------------------
    SDL_Init: () => 0,
    SDL_InitSubSystem: () => 0,
    SDL_Quit: () => 0,
    SDL_GetError: () => state.error,
    SDL_Delay: () => 0,          // a headless guest must not sleep; the host paces it
    SDL_GetTicks: () => (Date.now() - state.ticks0) | 0,

    // ---- video -----------------------------------------------------------------------------
    SDL_SetVideoMode: (w, h, depth, _flags) => {
      state.width = w | 0;
      state.height = h | 0;
      state.surface = makeSurface(w | 0, h | 0, depth | 0 || 8);
      state.pixels = surfacePixels(state.surface);
      return state.surface;
    },
    SDL_GetVideoSurface: () => state.surface,
    SDL_CreateRGBSurface: (_flags, w, h, depth) => makeSurface(w | 0, h | 0, depth | 0 || 32),
    SDL_FreeSurface: () => 0,    // the guest heap is not reclaimed here; nothing leaks per frame
    SDL_LockSurface: () => 0,    // software surfaces are always addressable
    SDL_UnlockSurface: () => 0,
    SDL_Flip: (s) => { if (state.onPresent) state.onPresent(s || state.surface); return 0; },
    SDL_UpdateRect: (s) => { if (state.onPresent) state.onPresent(s || state.surface); },
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
      if (xp) dv().setInt32(xp, 0, true);
      if (yp) dv().setInt32(yp, 0, true);
      return 0;            // no buttons down
    },

    /*
     * One host key event becomes one SDL 1.2 event. `extended` is what tells SDLK_UP from SDLK_KP8,
     * which share scan code 72 -- the game binds the arrows and the keypad to different players, so
     * losing that flag would silently merge two players' controls.
     */
    SDL_PollEvent: (ev) => {
      if (!state.keyboard) return 0;
      const e = state.keyboard.next ? state.keyboard.next() : null;
      if (!e) return 0;
      if (!ev) return 1;
      const table = e.extended ? SDLK.extended : SDLK.plain;
      const sym = table[e.scan] ?? SDLK.plain[e.scan] ?? 0;
      const d = dv();
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

    Mix_OpenAudio: () => { state.audioOpen = true; return 0; },
    Mix_CloseAudio: () => { state.audioOpen = false; },
    Mix_QuerySpec: (freq, fmt, ch) => {
      const d = dv();
      if (freq) d.setInt32(freq, 44100, true);
      if (fmt) d.setUint16(fmt, 0x8010, true);   // MIX_DEFAULT_FORMAT, as the header defines it
      if (ch) d.setInt32(ch, 2, true);
      return state.audioOpen ? 1 : 0;
    },
    Mix_SetPostMix: (fn, arg) => { state.postMix = fn | 0; state.postMixArg = arg | 0; },
    Mix_LoadMUS: () => 0,            // no music file is decoded; the game checks for NULL and copes
    Mix_FreeMusic: () => 0,
    Mix_PlayMusic: () => { state.musicPlaying = true; return 0; },
    Mix_PlayingMusic: () => (state.musicPlaying ? 1 : 0),
    Mix_HaltMusic: () => { state.musicPlaying = false; return 0; },
    Mix_FadeOutMusic: () => { state.musicPlaying = false; return 1; },
    Mix_VolumeMusic: (v) => {
      const was = state.musicVolume;
      if ((v | 0) >= 0) state.musicVolume = v | 0;
      return was;
    },
    Mix_SetMusicCMD: () => 0,
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

    SDL_SetVideoMode: f(P, I, I, I, U),
    SDL_GetVideoSurface: f(P),
    SDL_CreateRGBSurface: f(P, U, I, I, I, U, U, U, U),
    SDL_FreeSurface: f(V, P),
    SDL_LockSurface: f(I, P),
    SDL_UnlockSurface: f(V, P),
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

    SDL_NumJoysticks: f(I),
    SDL_JoystickOpen: f(P, I),
    SDL_JoystickClose: f(V, P),
    SDL_JoystickGetAxis: f(S, P, I),
    SDL_JoystickGetButton: f(B, P, I),

    SDL_LockAudio: f(V),
    SDL_UnlockAudio: f(V),
    SDL_PauseAudio: f(V, I),
    SDL_CloseAudio: f(V),

    Mix_OpenAudio: f(I, I, T.USHORT, I, I),
    Mix_CloseAudio: f(V),
    Mix_QuerySpec: f(I, P, P, P),
    Mix_SetPostMix: f(V, P, P),
    Mix_LoadMUS: f(P, P),
    Mix_FreeMusic: f(V, P),
    Mix_PlayMusic: f(I, P, I),
    Mix_PlayingMusic: f(I),
    Mix_HaltMusic: f(I),
    Mix_FadeOutMusic: f(I, I),
    Mix_VolumeMusic: f(I, I),
    Mix_SetMusicCMD: f(I, P),
  };
}
