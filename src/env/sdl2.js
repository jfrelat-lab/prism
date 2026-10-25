// sdl2.js — SDL2, for the Open* family.
//
// The 70 entry points OpenTyrian actually CALLS, counted by PRISM's own undefined-symbol report
// rather than by grep, and implemented in the proportions that report gave: half of them are
// bookkeeping (12 joystick queries that answer "no joystick", 8 logging calls, 15 window and
// renderer state setters), and the work is in 13 pixel calls and 7 audio ones.
//
// The pixel path lands on a seam PRISM already has. `SDL_LockTexture` hands the program a buffer,
// `SDL_RenderCopy` names which buffer is the frame and `SDL_RenderPresent` publishes it — the same
// shape as `XPutImage` in x11.js and as writing to 0xA0000 under DOS. Nothing is scaled or blended
// here: the program has already drawn every pixel by the time it presents.
//
// The one real design question is the AUDIO CALLBACK. SDL calls the program's function from another
// thread to fill a buffer, and there are no threads here. So the callback is RECORDED and pulled --
// `pumpAudio()` — which is the same answer safepoints give for the timer: an asynchronous event
// reaches a C program only where the host chooses to reach into it.

const NULLPTR = 0;

/** SDL_Surface, in the layout src/env/headers-sdl2.js declares. The two are one thing, twice. */
const S_FLAGS = 0, S_FORMAT = 4, S_W = 8, S_H = 12, S_PITCH = 16, S_PIXELS = 20,
      S_USERDATA = 24, S_LOCKED = 28, S_LOCKDATA = 32, S_CLIP = 36, S_MAP = 52, S_REFCOUNT = 56,
      S_SIZE = 60;

/** SDL_PixelFormat: format, palette, BitsPerPixel, BytesPerPixel, padding[2], masks… */
const F_FORMAT = 0, F_PALETTE = 4, F_BITS = 8, F_BYTES = 9, F_RMASK = 12, F_GMASK = 16,
      F_BMASK = 20, F_AMASK = 24, F_SIZE = 56;

/** SDL_AudioSpec: freq, format(u16), channels(u8), silence(u8), samples(u16), padding(u16), size… */
const A_FREQ = 0, A_FORMAT = 4, A_CHANNELS = 6, A_SILENCE = 7, A_SAMPLES = 8, A_PADDING = 10,
      A_SIZE_ = 12, A_CALLBACK = 16, A_USERDATA = 20, A_SIZE = 24;

import { format } from '../runtime/runtime.js';
import { freeRunningClock } from './clock.js';
import { surfaceApi, surfaceBuiltins } from './sdl2-surface.js';
import { imageApi, imageBuiltins } from './sdl2-image.js';

export function installSDL2(M, { width = 0, height = 0, onPresent = null, keyboard = null,
                                clock = freeRunningClock() } = {}) {
  const dv = () => M.mod.dv;
  const enc = new TextEncoder();

  const state = {
    surfaces: new Map(),     // guest pointer -> { w, h, pitch, pixels, bpp }
    textures: new Map(),     // handle -> { w, h, format, bpp, pixels, pitch }
    formats: new Map(),
    window: 0, renderer: 0,
    frame: null,             // the last presented texture, as a JS view
    frames: 0,
    clock,                   // SDL_GetTicks and SDL_Delay are two views of THIS, see env/clock.js
    audio: null,             // { callback, userdata, spec, silence }
    events: [],
    error: 0,
    initFlags: 0, ignored: new Set(), keyNames: {}, displayName: null,
    // The pointer as the program sees it: position, SDL button mask (1 left, 2 middle, 4 right), motion not yet read.
    mouse: { x: 0, y: 0, buttons: 0, relX: 0, relY: 0 }, relative: false, onRelative: null,
    textInput: true,
    quit: false,
  };
  M.sdl = state;

  let nextHandle = 0x51000000;
  const handle = () => (nextHandle += 16);

  const cstr = (p) => (p ? M.mod.cstr(p) : '');
  const intern = (s) => M.mod.intern([...enc.encode(s), 0]);
  const setErr = (s) => { state.error = intern(s); return -1; };

  /* Surfaces, formats, palettes and blits: src/env/sdl2-surface.js. */
  const surfaces = surfaceApi(M, state, { setErr, intern, cstr });
  const bytesPerPixel = (format) => surfaces.LAYOUT[format >>> 0]?.[1] ?? 0;

  /*
   * SDL_RWops: a stream over a block of the program's own memory, or over a file. A handle here is
   * a number the program only hands back; what it names is kept on this side.
   */
  const streams = new Map();
  /*
   * A stream the PROGRAM made (SDL_AllocRW, then its own size, seek, read, write and close): every
   * pointer that is not one of these handles. Its functions are at the head of SDL_RWops.
   */
  const own = (rw) => rw !== 0 && !streams.has(rw);
  const RW_SIZE = 0, RW_SEEK = 4, RW_READ = 8, RW_WRITE = 12, RW_CLOSE = 16;
  const fn = (rw, at) => dv().getUint32(rw + at, true);
  const streamBytes = (st) => (st.data ? st.data : M.u8.subarray(st.mem, st.mem + st.size));
  const closeStream = (rw) => {
    const st = streams.get(rw);
    if (!st) return -1;
    if (st.write && st.name && M.files) M.files.store.set(M.files.norm(st.name), st.data.slice(0, st.size));
    streams.delete(rw);
    return 0;
  };

  /* The keyboard as SDL_GetKeyboardState shows it, and the modifiers a key event reports. */
  const KEYS = 512;
  let keyState = 0, modState = 0;
  const keyArray = () => { if (!keyState) { keyState = M.rt.malloc(KEYS); M.u8.fill(0, keyState, keyState + KEYS); } return keyState; };

  /* Timers. SDL runs them on a thread; here the due ones run where the program yields to SDL. */
  const timers = new Map();
  let nextTimer = 1;
  const pumpTimers = () => {
    if (!timers.size) return;
    const now = state.clock.now();
    for (const [id, t] of timers) {
      if (now < t.due) continue;
      const next = M.icall(t.callback, [t.interval, t.param]) >>> 0;
      if (!next) timers.delete(id); else { t.interval = next; t.due = now + next; }
    }
  };

  /*
   * THE AUDIO THREAD, WITHOUT A THREAD: the buffers due by the clock are asked of the program's
   * callback where it yields to SDL. A program may WAIT on what its callback does -- SDLPoP holds a
   * scene until the callback reports its sound finished -- so this runs whether or not anybody
   * listens; a listener (state.onAudio) is handed the newest buffers only.
   */
  const pumpAudioDue = () => {
    const a = state.audio;
    if (!a || a.paused || !a.callback || !a.spec.freq || !a.spec.samples) return;
    const due = Math.floor(((state.clock.now() - a.t0) * a.spec.freq) / (1000 * a.spec.samples)) + 1;
    while (a.done < due) {
      if (!a.buffer) a.buffer = M.rt.malloc(a.size);
      M.u8.fill(a.silence, a.buffer, a.buffer + a.size);
      a.done++;
      M.icall(a.callback, [a.userdata, a.buffer, a.size]);
      if (state.onAudio && due - a.done < 2) state.onAudio(a.buffer, a.spec.samples, a.spec);
      if (!state.audio || state.audio.paused) break;       // the callback may stop the device itself
    }
  };
  const pump = () => { pumpTimers(); pumpAudioDue(); };
  state.pump = pump;

  const api = {
    // ---------------------------------------------------------------- core
    SDL_Init: (flags) => { state.initFlags |= flags >>> 0; return 0; },
    SDL_InitSubSystem: () => 0,
    SDL_QuitSubSystem: () => 0,
    SDL_Quit: () => 0,
    SDL_GetError: () => state.error,
    SDL_SetHint: () => 1,
    /*
     * A clock that actually moves, because OpenTyrian paces itself with it: 29 calls, more than any
     * other SDL function in the program.
     */
    SDL_GetTicks: () => { pump(); return state.clock.now(); },
    // A millisecond counter is the resolution this clock has; the frequency says so.
    SDL_GetPerformanceCounter: () => { pump(); return BigInt(state.clock.now()); },
    SDL_GetPerformanceFrequency: () => 1000n,
    // What was initialised: every subsystem is always there, so it is whatever was asked for.
    SDL_WasInit: (flags) => (flags ? flags & state.initFlags : state.initFlags) >>> 0,
    prism_SDL_SetErrorText: (text) => { state.error = intern(cstr(text)); },
    // One display, the page: a 1024x768 desktop at 60 Hz, 32-bit.
    SDL_GetDesktopDisplayMode: (_i, mode) => {
      const d = dv();
      d.setUint32(mode, 0x16161804, true); d.setInt32(mode + 4, 1024, true); d.setInt32(mode + 8, 768, true);
      d.setInt32(mode + 12, 60, true); d.setUint32(mode + 16, 0, true);
      return 0;
    },
    SDL_GetDisplayName: () => (state.displayName ??= intern('PRISM')),
    SDL_GetWindowID: (w) => (w ? 1 : 0),
    // The pointer belongs to the page, which captures it on a click; nothing to grab or move here.
    SDL_SetWindowGrab: () => {},
    SDL_WarpMouseInWindow: () => {},
    // Which kinds of event are delivered: all, and a query answers so; an IGNORE is kept and honoured.
    SDL_EventState: (type, st) => {
      const was = state.ignored.has(type >>> 0) ? 0 : 1;
      if (st === 0) state.ignored.add(type >>> 0); else if (st === 1) state.ignored.delete(type >>> 0);
      return was;
    },
    SDL_GetKeyName: (key) => {
      const name = keyName(key >>> 0);
      return (state.keyNames[name] ??= intern(name));
    },
    SDL_GetKeyFromName: (p) => keyFromName(cstr(p)),
    SDL_GetVersion: (ver) => { M.u8[ver] = 2; M.u8[ver + 1] = 0; M.u8[ver + 2] = 22; },   // headers-sdl2.js's own
    SDL_free: (p) => M.rt.free(p),
    SDL_memset: (p, c, n) => M.rt.memset(p, c, n),
    SDL_strlen: (p) => M.rt.strlen(p),
    SDL_AddTimer: (interval, callback, param) => {
      const id = nextTimer++;
      timers.set(id, { interval: interval >>> 0, callback, param, due: state.clock.now() + (interval >>> 0) });
      return id;
    },
    SDL_RemoveTimer: (id) => (timers.delete(id | 0) ? 1 : 0),
    /*
     * Delay writes to the SAME clock GetTicks reads, and the host decides what waiting costs.
     *
     * This used to return 0 and do nothing, on the argument that the guest's clock keeps running so
     * its pacing logic still sees time pass. Time did pass; the deadline never arrived any sooner
     * for it. A limiter written as "sleep a little, ask again" is then a spin, and OpenTyrian's ran
     * 487 million times over 200 frames -- 96% of the wall clock, against 1.1 s of actual game work.
     */
    SDL_Delay: (ms) => { state.clock.delay(ms | 0); pump(); return 0; },
    SDL_ShowSimpleMessageBox: (_flags, title, msg) => {
      M.write(`[SDL messagebox] ${cstr(title)}: ${cstr(msg)}\n`);
      return 0;
    },
    SDL_strlcpy: (dst, src, maxlen) => {
      const s = cstr(src), n = Math.min(s.length, Math.max(0, (maxlen | 0) - 1));
      for (let i = 0; i < n; i++) M.u8[dst + i] = s.charCodeAt(i) & 0xff;
      if (maxlen > 0) M.u8[dst + n] = 0;
      return s.length;
    },
    SDL_vsnprintf: (dst, n, fmt, ap) => M.rt.vsnprintf(dst, n, fmt, ap),

    // ---------------------------------------------------------------- logging
    SDL_Log: (fmt, va) => { M.write('[SDL] ' + format(M, fmt, va ?? []) + '\n'); },
    SDL_LogDebug: (_c, fmt, va) => { M.write('[SDL debug] ' + format(M, fmt, va ?? []) + '\n'); },
    SDL_LogWarn: (_c, fmt, va) => { M.write('[SDL warn] ' + format(M, fmt, va ?? []) + '\n'); },
    SDL_LogError: (_c, fmt, va) => { M.write('[SDL error] ' + format(M, fmt, va ?? []) + '\n'); },
    SDL_LogMessageV: (_c, _p, fmt, ap) => { M.rt.vprintf(fmt, ap); },
    SDL_LogSetPriority: () => 0,

    // ---------------------------------------------------------------- window and renderer
    SDL_CreateWindow: (_t, _x, _y, w, h) => {
      state.window = handle();
      state.winW = w | 0; state.winH = h | 0;
      return state.window;
    },
    SDL_DestroyWindow: () => { state.window = 0; },
    SDL_ShowWindow: () => 0,
    SDL_SetWindowSize: (_w, w, h) => { state.winW = w | 0; state.winH = h | 0; },
    SDL_SetWindowPosition: () => 0,
    SDL_SetWindowFullscreen: () => 0,
    SDL_GetWindowSize: (_w, wp, hp) => {
      if (wp) dv().setInt32(wp, state.winW | 0, true);
      if (hp) dv().setInt32(hp, state.winH | 0, true);
    },
    SDL_GetWindowDisplayIndex: () => 0,
    SDL_GetNumVideoDisplays: () => 1,
    /** One display, the size of the window the program asked for. */
    SDL_GetDisplayBounds: (_i, rect) => {
      if (!rect) return -1;
      dv().setInt32(rect, 0, true); dv().setInt32(rect + 4, 0, true);
      dv().setInt32(rect + 8, state.winW || 640, true);
      dv().setInt32(rect + 12, state.winH || 400, true);
      return 0;
    },
    SDL_CreateRenderer: () => (state.renderer = handle()),
    /* One software renderer, which can draw into a texture. */
    SDL_GetRendererInfo: (_r, info) => {
      if (!info) return -1;
      M.u8.fill(0, info, info + 84);
      dv().setUint32(info, intern('software'), true);
      dv().setUint32(info + 4, 0x1 | 0x8, true);            // SDL_RENDERER_SOFTWARE | TARGETTEXTURE
      dv().setUint32(info + 8, 1, true);
      dv().setUint32(info + 12, 0x16161804, true);          // SDL_PIXELFORMAT_RGB888
      return 0;
    },
    SDL_GetRendererOutputSize: (_r, wp, hp) => {
      if (wp) dv().setInt32(wp, state.winW | 0, true);
      if (hp) dv().setInt32(hp, state.winH | 0, true);
      return 0;
    },
    SDL_GL_GetDrawableSize: (_w, wp, hp) => {
      if (wp) dv().setInt32(wp, state.winW | 0, true);
      if (hp) dv().setInt32(hp, state.winH | 0, true);
    },
    SDL_GetWindowFlags: () => 0,
    SDL_RenderGetLogicalSize: (_r, wp, hp) => {
      if (wp) dv().setInt32(wp, state.logicalW | 0, true);
      if (hp) dv().setInt32(hp, state.logicalH | 0, true);
    },
    SDL_RenderGetScale: (_r, xp, yp) => {
      if (xp) dv().setFloat32(xp, 1, true);
      if (yp) dv().setFloat32(yp, 1, true);
    },
    SDL_RenderGetViewport: (_r, rect) => {
      if (!rect) return;
      dv().setInt32(rect, 0, true); dv().setInt32(rect + 4, 0, true);
      dv().setInt32(rect + 8, state.logicalW || state.winW | 0, true);
      dv().setInt32(rect + 12, state.logicalH || state.winH | 0, true);
    },
    SDL_RenderSetIntegerScale: () => 0,
    /*
     * A texture as the render target: what SDL_RenderCopy then draws lands in that texture instead
     * of on the display. SDLPoP uses it to double its picture before the final stretch.
     */
    SDL_SetRenderTarget: (_r, t) => {
      if (t && !state.textures.has(t)) return setErr('Invalid texture');
      state.target = t ? state.textures.get(t) : null;
      return 0;
    },
    SDL_DestroyRenderer: () => { state.renderer = 0; },
    SDL_SetRenderDrawColor: () => 0,
    SDL_RenderClear: () => {
      const t = state.target;
      if (t) M.u8.fill(0, t.pixels, t.pixels + t.pitch * t.h);
      return 0;
    },
    SDL_ShowCursor: () => 0,
    // Relative mode: the host captures the pointer and reports motion only (state.onRelative).
    SDL_SetRelativeMouseMode: (on) => { state.relative = !!on; state.onRelative?.(state.relative); return 0; },
    SDL_GetRelativeMouseMode: () => (state.relative ? 1 : 0),

    // ---------------------------------------------------------------- textures: the frame
    SDL_CreateTexture: (_r, format, _access, w, h) => {
      const bpp = bytesPerPixel(format >>> 0);
      const pitch = (w | 0) * bpp;
      const pixels = M.rt.malloc(pitch * (h | 0));
      M.u8.fill(0, pixels, pixels + pitch * (h | 0));
      const t = handle();
      state.textures.set(t, { w: w | 0, h: h | 0, format: format >>> 0, bpp, pixels, pitch });
      return t;
    },
    SDL_DestroyTexture: (t) => {
      const tx = state.textures.get(t);
      if (tx) { M.rt.free(tx.pixels); state.textures.delete(t); }
    },
    SDL_QueryTexture: (t, fp, ap, wp, hp) => {
      const tx = state.textures.get(t);
      if (!tx) return setErr('invalid texture');
      if (fp) dv().setUint32(fp, tx.format, true);
      if (ap) dv().setInt32(ap, 1, true);
      if (wp) dv().setInt32(wp, tx.w, true);
      if (hp) dv().setInt32(hp, tx.h, true);
      return 0;
    },
    /*
     * The program writes its frame here itself. A streaming texture IS a buffer plus a pitch, so
     * handing over the real ones is not a shortcut -- it is what SDL does.
     */
    SDL_LockTexture: (t, _rect, pixelsOut, pitchOut) => {
      const tx = state.textures.get(t);
      if (!tx) return setErr('invalid texture');
      if (pixelsOut) dv().setUint32(pixelsOut, tx.pixels >>> 0, true);
      if (pitchOut) dv().setInt32(pitchOut, tx.pitch, true);
      return 0;
    },
    SDL_UnlockTexture: () => 0,
    SDL_RenderCopy: (_r, t) => {
      const tx = state.textures.get(t) ?? null, to = state.target;
      if (!to) { state.current = tx; return 0; }
      if (!tx) return setErr('Invalid texture');
      if (tx.bpp !== to.bpp) return setErr('SDL_RenderCopy between textures of different formats is not supported');
      // The whole texture onto the whole target, nearest pixel.
      for (let y = 0; y < to.h; y++) {
        const from = tx.pixels + Math.floor((y * tx.h) / to.h) * tx.pitch, row = to.pixels + y * to.pitch;
        for (let x = 0; x < to.w; x++) {
          const a = from + Math.floor((x * tx.w) / to.w) * tx.bpp;
          for (let k = 0; k < tx.bpp; k++) M.u8[row + x * tx.bpp + k] = M.u8[a + k];
        }
      }
      return 0;
    },
    /** Publish. Everything above this line only prepared bytes; this is where a frame exists. */
    SDL_RenderPresent: () => {
      pump();
      const tx = state.current;
      if (!tx) return;
      state.frame = {
        w: tx.w, h: tx.h, bpp: tx.bpp, format: tx.format,
        bytes: M.u8.slice(tx.pixels, tx.pixels + tx.pitch * tx.h), pitch: tx.pitch,
      };
      state.frames++;
      if (onPresent) onPresent(state.frame, state.frames);
    },

    /*
     * ------------------------------------------- what Jump 'n Bump's SDL 2 port adds
     *
     * Two groups, and the split is the interesting part. SDL_CreateWindowAndRenderer,
     * SDL_UpdateTexture, SDL_ConvertSurfaceFormat and SDL_SetPaletteColors are SDL2's own; the rest
     * are names SDL2 KEPT from 1.2, with the same meaning -- which is exactly why the two versions
     * cannot share one table. Same name, same intent, different structs behind them.
     */
    SDL_CreateWindowAndRenderer: (w, h, _flags, winOut, rendOut) => {
      state.window = handle();
      state.winW = w | 0; state.winH = h | 0;
      state.renderer = handle();
      const d = M.mod.dv;
      if (winOut) d.setUint32(winOut, state.window, true);
      if (rendOut) d.setUint32(rendOut, state.renderer, true);
      return 0;
    },
    SDL_RenderSetLogicalSize: (_r, w, h) => { state.logicalW = w | 0; state.logicalH = h | 0; return 0; },
    SDL_SetWindowTitle: () => 0,
    SDL_SetWindowIcon: () => 0,

    /*
     * The upload path this port uses instead of locking a texture: it hands over a whole buffer and
     * a pitch, so the bytes are copied into the texture's own store and RenderCopy/RenderPresent
     * publish it exactly as they do for the locked path.
     */
    SDL_UpdateTexture: (tex, _rect, pixels, pitch) => {
      const t = state.textures.get(tex);
      if (!t || !pixels) return -1;
      const src = pitch | 0, dst = t.pitch, n = Math.min(src, dst);
      for (let y = 0; y < t.h; y++) {
        M.u8.copyWithin(t.pixels + y * dst, pixels + y * src, pixels + y * src + n);
      }
      return 0;
    },

    SDL_GetMouseState: (xp, yp) => {
      const d = M.mod.dv, m = state.mouse;
      if (xp) d.setInt32(xp, m.x, true);
      if (yp) d.setInt32(yp, m.y, true);
      return m.buttons >>> 0;
    },
    SDL_GetRelativeMouseState: (xp, yp) => {
      const d = M.mod.dv, m = state.mouse;
      if (xp) d.setInt32(xp, m.relX, true);
      if (yp) d.setInt32(yp, m.relY, true);
      m.relX = 0; m.relY = 0;
      return m.buttons >>> 0;
    },
    /* No audio thread here, so there is nothing to lock against -- see src/env/sdl12.js. */
    SDL_LockAudio: () => 0,
    SDL_UnlockAudio: () => 0,

    // ---------------------------------------------------------------- events
    SDL_PollEvent: (evt) => {
      pump();
      const e = state.events.shift();
      if (!e) return 0;
      if (evt) { M.u8.fill(0, evt, evt + 56); M.u8.set(e, evt); }
      return 1;
    },
    SDL_PushEvent: (evt) => {
      if (evt) state.events.push(M.u8.slice(evt, evt + 56));
      return 1;
    },
    SDL_GetKeyboardState: (numkeys) => {
      if (numkeys) dv().setInt32(numkeys, KEYS, true);
      return keyArray();
    },
    SDL_SetTextInputRect: () => 0,
    // Text input is ON from the start, as SDL 2 starts it with its video (SDL_VideoInit).
    SDL_StartTextInput: () => { state.textInput = true; },
    SDL_StopTextInput: () => { state.textInput = false; },
    SDL_IsTextInputActive: () => (state.textInput ? 1 : 0),
    SDL_GetScancodeName: (sc) => intern(scancodeName(sc | 0)),
    SDL_GetScancodeFromName: (name) => scancodeFromName(cstr(name)),

    // ---------------------------------------------------------------- joystick: there is none
    SDL_NumJoysticks: () => 0,
    SDL_JoystickOpen: () => NULLPTR,
    SDL_JoystickClose: () => 0,
    SDL_JoystickName: () => intern('none'),
    SDL_JoystickNumAxes: () => 0,
    SDL_JoystickNumButtons: () => 0,
    SDL_JoystickNumHats: () => 0,
    SDL_JoystickGetAxis: () => 0,
    SDL_JoystickGetButton: () => 0,
    SDL_JoystickGetHat: () => 0,
    SDL_JoystickUpdate: () => 0,
    SDL_JoystickEventState: () => 0,
    SDL_JoystickRumble: () => -1,
    // Game controllers and force feedback: none, said the way SDL says it.
    SDL_IsGameController: () => 0,
    SDL_GameControllerOpen: () => NULLPTR,
    SDL_GameControllerClose: () => 0,
    SDL_GameControllerFromInstanceID: () => NULLPTR,
    SDL_GameControllerRumble: () => -1,
    SDL_GameControllerAddMapping: () => 0,
    SDL_GameControllerAddMappingsFromRW: (rw, freerw) => { if (rw && freerw) closeStream(rw); return rw ? 0 : -1; },
    SDL_HapticOpen: () => NULLPTR,
    SDL_HapticRumbleInit: () => -1,
    SDL_HapticRumblePlay: () => -1,

    // ---------------------------------------------------------------- streams
    SDL_RWFromConstMem: (mem, size) => { const rw = handle(); streams.set(rw, { mem, size: size | 0, pos: 0 }); return rw; },
    SDL_RWFromMem: (mem, size) => { const rw = handle(); streams.set(rw, { mem, size: size | 0, pos: 0, writable: true }); return rw; },
    SDL_RWFromFile: (file, mode) => {
      const name = cstr(file), m = cstr(mode);
      if (/[wa+]/.test(m)) {
        const rw = handle();
        streams.set(rw, { data: new Uint8Array(256), size: 0, pos: 0, write: true, writable: true, name });
        return rw;
      }
      const key = M.files ? M.files.find(name, { guess: false }) : null;
      if (key === null) { setErr(`Couldn't open ${name}`); return NULLPTR; }
      const data = M.files.store.get(key), rw = handle();
      streams.set(rw, { data, size: data.length, pos: 0 });
      return rw;
    },
    SDL_RWread: (rw, ptr, size, maxnum) => {
      if (own(rw)) return M.icall(fn(rw, RW_READ), [rw, ptr, size, maxnum]) >>> 0;
      const st = streams.get(rw);
      if (!st || !(size >>> 0)) return 0;
      const n = Math.min(maxnum >>> 0, Math.floor((st.size - st.pos) / (size >>> 0)));
      if (n <= 0) return 0;
      M.u8.set(streamBytes(st).subarray(st.pos, st.pos + n * size), ptr);
      st.pos += n * size;
      return n;
    },
    SDL_RWwrite: (rw, ptr, size, num) => {
      if (own(rw)) return M.icall(fn(rw, RW_WRITE), [rw, ptr, size, num]) >>> 0;
      const st = streams.get(rw), bytes = (size >>> 0) * (num >>> 0);
      if (!st || !st.writable || !bytes) return 0;
      if (st.data) {
        if (st.pos + bytes > st.data.length) { const bigger = new Uint8Array(Math.max(st.data.length * 2, st.pos + bytes)); bigger.set(st.data); st.data = bigger; }
        st.data.set(M.u8.subarray(ptr, ptr + bytes), st.pos);
        st.size = Math.max(st.size, st.pos + bytes);
      } else {
        if (st.pos + bytes > st.size) return 0;
        M.u8.copyWithin(st.mem + st.pos, ptr, ptr + bytes);
      }
      st.pos += bytes;
      return num >>> 0;
    },
    SDL_RWtell: (rw) => (own(rw) ? BigInt(M.icall(fn(rw, RW_SEEK), [rw, 0n, 1])) : BigInt(streams.get(rw)?.pos ?? -1)),
    SDL_RWclose: (rw) => (own(rw) ? M.icall(fn(rw, RW_CLOSE), [rw]) | 0 : closeStream(rw)),
    // An offset from the start, the position or the end (RW_SEEK_SET, CUR, END); -1 outside the stream.
    SDL_RWseek: (rw, offset, whence) => {
      if (own(rw)) return BigInt(M.icall(fn(rw, RW_SEEK), [rw, BigInt(offset), whence]));
      const st = streams.get(rw);
      if (!st) return -1n;
      const to = Number(offset) + (whence === 1 ? st.pos : whence === 2 ? st.size : 0);
      if (to < 0) return -1n;
      st.pos = to;
      return BigInt(to);
    },
    SDL_RWsize: (rw) => (own(rw) ? BigInt(M.icall(fn(rw, RW_SIZE), [rw])) : BigInt(streams.get(rw)?.size ?? -1)),

    // ---------------------------------------------------------------- audio
    /*
     * The device is opened and the program's callback recorded. Nothing is played from here: the
     * callback is PULLED by pumpAudio(), because SDL would call it on a thread this host does not
     * have. `obtained` echoes `desired`, which is what a device that can do exactly what was asked
     * reports -- and saying so is why the program's own resampling never runs.
     */
    SDL_OpenAudio: (desired, obtained) => {
      if (!api.SDL_OpenAudioDevice(0, 0, desired, obtained)) return -1;
      // With no `obtained`, SDL writes what it computed back into `desired`: the program reads
      // the silence value and the buffer size from there.
      if (!obtained) {
        dv().setUint32(desired + A_SIZE_, state.audio.size, true);
        M.u8[desired + A_SILENCE] = state.audio.silence;
      }
      return 0;
    },
    SDL_CloseAudio: () => { state.audio = null; if (state.onAudioOpen) state.onAudioOpen(null); },
    SDL_PauseAudio: (pause) => api.SDL_PauseAudioDevice(0, pause),
    SDL_GetAudioStatus: () => (!state.audio ? 0 : state.audio.paused ? 2 : 1),
    SDL_OpenAudioDevice: (_dev, _capture, desired, obtained) => {
      if (!desired) return 0;
      const spec = {
        freq: dv().getInt32(desired + A_FREQ, true),
        format: dv().getUint16(desired + A_FORMAT, true),
        channels: M.u8[desired + A_CHANNELS],
        samples: dv().getUint16(desired + A_SAMPLES, true),
      };
      const callback = dv().getUint32(desired + A_CALLBACK, true);
      const userdata = dv().getUint32(desired + A_USERDATA, true);
      const size = spec.samples * spec.channels * (spec.format & 0xff) / 8;
      const silence = (spec.format & 0xff) === 8 && !(spec.format & 0x8000) ? 0x80 : 0;
      if (obtained) {
        M.u8.copyWithin(obtained, desired, desired + A_SIZE);
        dv().setUint32(obtained + A_SIZE_, size, true);
        M.u8[obtained + A_SILENCE] = silence;
      }
      state.audio = { callback, userdata, spec, size, silence, paused: true, buffer: 0, t0: 0, done: 0 };
      if (state.onAudioOpen) state.onAudioOpen(spec);
      return handle();
    },
    SDL_CloseAudioDevice: () => { state.audio = null; if (state.onAudioOpen) state.onAudioOpen(null); },
    SDL_PauseAudioDevice: (_d, pause) => {
      const a = state.audio;
      if (!a) return;
      // Leaving a pause starts the count of buffers again from now: none is owed for the silence.
      if (a.paused && !(pause | 0)) { a.t0 = state.clock.now(); a.done = 0; }
      a.paused = !!(pause | 0);
    },
    SDL_LockAudioDevice: () => 0,
    SDL_UnlockAudioDevice: () => 0,
    /*
     * No conversion is needed, because `obtained` matched `desired`. Returning 0 is SDL's own way of
     * saying that, and it is TRUE here rather than convenient -- a caller that got 1 would then run
     * its own resampler over data that is already in the right shape.
     */
    SDL_BuildAudioCVT: (cvt, srcFormat, _sc, srcRate, dstFormat, _dc, dstRate) => {
      if (!cvt) return -1;
      /*
       * Returning 0 -- "no conversion needed" -- is not the whole contract. Real SDL ALWAYS fills
       * the struct: len_mult 1, len_ratio 1.0, rate_incr 1.0, and the two formats. A caller then
       * sizes its buffer with `len * cvt.len_mult`.
       *
       * Leaving those fields alone meant the caller multiplied by whatever was on its stack, and
       * OpenTyrian asked malloc for 4,294,550,356 bytes -- which is -416,940 read as unsigned. The
       * struct is packed, so these offsets are SDL's exactly; see headers-sdl2.js.
       */
      const d = dv();
      d.setInt32(cvt + 0, 0, true);                       // needed
      d.setUint16(cvt + 4, srcFormat & 0xffff, true);     // src_format
      d.setUint16(cvt + 6, dstFormat & 0xffff, true);     // dst_format
      d.setFloat64(cvt + 8, (dstRate | 0) && (srcRate | 0) ? dstRate / srcRate : 1, true);
      d.setUint32(cvt + 16, 0, true);                     // buf
      d.setInt32(cvt + 20, 0, true);                      // len
      d.setInt32(cvt + 24, 0, true);                      // len_cvt
      d.setInt32(cvt + 28, 1, true);                      // len_mult
      d.setFloat64(cvt + 32, 1, true);                    // len_ratio
      d.setInt32(cvt + 80, 0, true);                      // filter_index
      return 0;
    },
    /** needed was 0, so the data is already in shape: len_cvt is len, unchanged. */
    SDL_ConvertAudio: (cvt) => {
      if (!cvt) return -1;
      dv().setInt32(cvt + 24, dv().getInt32(cvt + 20, true), true);
      return 0;
    },
  };

  Object.assign(api, surfaces.api, imageApi(M, state, {
    surfaces, setErr, cstr, closeStream,
    readStream: (rw) => { const st = streams.get(rw); return st ? streamBytes(st).subarray(st.pos, st.size) : null; },
    readFile: (name) => { const key = M.files ? M.files.find(name, { guess: false }) : null; return key === null ? null : M.files.store.get(key); },
  }));

  /** Ask the program to fill one audio buffer, the way a device thread would. */
  function pumpAudio() {
    const a = state.audio;
    if (!a || a.paused || !a.callback) return null;
    if (!a.buffer) a.buffer = M.rt.malloc(a.size);
    M.u8.fill(0, a.buffer, a.buffer + a.size);
    M.icall(a.callback, [a.userdata, a.buffer, a.size]);
    return M.u8.slice(a.buffer, a.buffer + a.size);
  }

  /** Queue a key event the way a window system would deliver one. `scancode` is SDL's own. */
  function pushKey(scancode, down) {
    scancode >>>= 0;
    const bit = MOD_BIT[scancode] ?? 0;
    modState = down ? modState | bit : modState & ~bit;
    if (scancode < KEYS) M.u8[keyArray() + scancode] = down ? 1 : 0;
    const e = new Uint8Array(56);
    const d = new DataView(e.buffer);
    d.setUint32(0, down ? 0x300 : 0x301, true);      // SDL_KEYDOWN / SDL_KEYUP
    d.setUint32(4, state.clock.now() >>> 0, true);   // timestamp
    d.setUint8(12, down ? 1 : 0);                    // state
    d.setUint32(16, scancode, true);                 // keysym.scancode
    d.setInt32(20, keycodeOf(scancode), true);       // keysym.sym
    d.setUint16(24, modState, true);                 // keysym.mod
    state.events.push(e);
  }
  /*
   * The pointer, as a window system delivers it: moved to (x, y) by (xrel, yrel), with these buttons
   * down (SDL's mask). A motion event when it moved and SDL_MOUSEMOTION is not ignored, then one
   * button event per button that changed -- SDL_mouse.c's order. Layouts are SDL_events.h's.
   */
  function pushMouse(x, y, xrel, yrel, buttons) {
    const m = state.mouse, now = state.clock.now() >>> 0;
    m.relX += xrel; m.relY += yrel;
    if ((xrel || yrel || x !== m.x || y !== m.y) && !state.ignored.has(0x400)) {
      const e = new Uint8Array(56), d = new DataView(e.buffer);
      d.setUint32(0, 0x400, true); d.setUint32(4, now, true); d.setUint32(8, 1, true);
      d.setUint32(16, buttons >>> 0, true);
      d.setInt32(20, x, true); d.setInt32(24, y, true); d.setInt32(28, xrel, true); d.setInt32(32, yrel, true);
      state.events.push(e);
    }
    m.x = x; m.y = y;
    for (let b = 1; b <= 3; b++) {
      const bit = 1 << (b - 1), down = (buttons & bit) !== 0;
      if (down === ((m.buttons & bit) !== 0)) continue;
      m.buttons = down ? m.buttons | bit : m.buttons & ~bit;
      if (state.ignored.has(down ? 0x401 : 0x402)) continue;
      const e = new Uint8Array(56), d = new DataView(e.buffer);
      d.setUint32(0, down ? 0x401 : 0x402, true); d.setUint32(4, now, true); d.setUint32(8, 1, true);
      d.setUint8(16, b); d.setUint8(17, down ? 1 : 0); d.setUint8(18, 1);
      d.setInt32(20, x, true); d.setInt32(24, y, true);
      state.events.push(e);
    }
  }
  /*
   * The text a key typed, as SDL_TEXTINPUT after its SDL_KEYDOWN: UTF-8 in a 32-byte field, while
   * text input is on. What the page's keyboard typed, layout and shift included.
   */
  function pushText(text) {
    if (!state.textInput || state.ignored.has(0x303)) return;
    const e = new Uint8Array(56), d = new DataView(e.buffer);
    d.setUint32(0, 0x303, true); d.setUint32(4, state.clock.now() >>> 0, true); d.setUint32(8, 1, true);
    e.set(enc.encode(text).subarray(0, 31), 12);
    state.events.push(e);
  }
  /** The same, from a PC set-1 scan code and its 0xE0 prefix, which is what a host's keyboard has. */
  function pushScan(scan, extended, down) {
    const code = (extended ? SET1_EXTENDED : SET1)[scan];
    if (code) pushKey(code, down);
  }

  Object.assign(M.rt, api);
  return { state, pumpAudio, pushKey, pushScan, pushMouse, pushText };
}

/* PC scan code set 1 -> SDL scancode (the USB usage), for a US keyboard. */
const SET1 = {
  1: 41, 2: 30, 3: 31, 4: 32, 5: 33, 6: 34, 7: 35, 8: 36, 9: 37, 10: 38, 11: 39, 12: 45, 13: 46, 14: 42, 15: 43,
  16: 20, 17: 26, 18: 8, 19: 21, 20: 23, 21: 28, 22: 24, 23: 12, 24: 18, 25: 19, 26: 47, 27: 48, 28: 40, 29: 224,
  30: 4, 31: 22, 32: 7, 33: 9, 34: 10, 35: 11, 36: 13, 37: 14, 38: 15, 39: 51, 40: 52, 41: 53, 42: 225, 43: 49,
  44: 29, 45: 27, 46: 6, 47: 25, 48: 5, 49: 17, 50: 16, 51: 54, 52: 55, 53: 56, 54: 229, 55: 85, 56: 226, 57: 44, 58: 57,
  59: 58, 60: 59, 61: 60, 62: 61, 63: 62, 64: 63, 65: 64, 66: 65, 67: 66, 68: 67, 69: 83, 70: 71,
  71: 95, 72: 96, 73: 97, 74: 86, 75: 92, 76: 93, 77: 94, 78: 87, 79: 89, 80: 90, 81: 91, 82: 98, 83: 99, 87: 68, 88: 69,
};
const SET1_EXTENDED = {
  28: 88, 29: 228, 53: 84, 56: 230, 71: 74, 72: 82, 73: 75, 75: 80, 77: 79, 79: 77, 80: 81, 81: 78, 82: 73, 83: 76,
};
/* KMOD_* by the scancode of the key that holds it down. */
const MOD_BIT = { 225: 0x0001, 229: 0x0002, 224: 0x0040, 228: 0x0080, 226: 0x0100, 230: 0x0200 };
/* SDL_Keycode: a printable key is its unshifted character, the rest the scancode with bit 30 set. */
const PRINTABLE = { 40: 13, 41: 27, 42: 8, 43: 9, 44: 32, 45: 45, 46: 61, 47: 91, 48: 93, 49: 92, 51: 59, 52: 39, 53: 96, 54: 44, 55: 46, 56: 47, 76: 127 };
function keycodeOf(sc) {
  if (sc >= 4 && sc <= 29) return 97 + sc - 4;
  if (sc >= 30 && sc <= 38) return 49 + sc - 30;
  if (sc === 39) return 48;
  return PRINTABLE[sc] ?? (sc | (1 << 30));
}

/* The names SDL gives scancodes, for the few the program round-trips through its config file. */
const NAMES = {
  40: 'Return', 41: 'Escape', 42: 'Backspace', 43: 'Tab', 44: 'Space', 79: 'Right', 80: 'Left',
  81: 'Down', 82: 'Up', 58: 'F1', 59: 'F2', 60: 'F3', 61: 'F4', 62: 'F5', 63: 'F6',
  224: 'Left Ctrl', 225: 'Left Shift', 226: 'Left Alt',
};
function scancodeName(sc) {
  if (sc >= 4 && sc <= 29) return String.fromCharCode(65 + sc - 4);
  if (sc >= 30 && sc <= 38) return String.fromCharCode(49 + sc - 30);
  if (sc === 39) return '0';
  return NAMES[sc] ?? '';
}
function scancodeFromName(name) {
  if (!name) return 0;
  if (name.length === 1) {
    const c = name.toUpperCase().charCodeAt(0);
    if (c >= 65 && c <= 90) return 4 + (c - 65);
    if (c >= 49 && c <= 57) return 30 + (c - 49);
    if (c === 48) return 39;
  }
  for (const [k, v] of Object.entries(NAMES)) if (v === name) return +k;
  return 0;
}

/** The declarations, in the shape src/compile.js's BUILTINS table wants. */
export function sdl2Builtins(T) {
  const P = T.ptr(T.CHAR), I = T.INT, U = T.UINT, V = T.VOID;
  const f = (ret, ...params) => ({ ret, params });
  const varargs = (ret, ...params) => ({ ret, params, variadic: true });
  return {
    SDL_Init: f(I, U), SDL_InitSubSystem: f(I, U), SDL_QuitSubSystem: f(V, U), SDL_Quit: f(V),
    SDL_GetError: f(P), SDL_SetHint: f(I, P, P), SDL_GetTicks: f(U), SDL_Delay: f(V, U),
    SDL_ShowSimpleMessageBox: f(I, U, P, P, P),
    SDL_strlcpy: f(U, P, P, U), SDL_vsnprintf: f(I, P, U, P, P),
    SDL_Log: varargs(V, P), SDL_LogDebug: varargs(V, I, P), SDL_LogWarn: varargs(V, I, P),
    SDL_LogError: varargs(V, I, P), SDL_LogMessageV: f(V, I, I, P, P), SDL_LogSetPriority: f(V, I, I),
    SDL_CreateWindow: f(P, P, I, I, I, I, U), SDL_DestroyWindow: f(V, P), SDL_ShowWindow: f(V, P),
    SDL_SetWindowSize: f(V, P, I, I), SDL_SetWindowPosition: f(V, P, I, I),
    SDL_SetWindowFullscreen: f(I, P, U), SDL_GetWindowSize: f(V, P, P, P),
    SDL_GetWindowDisplayIndex: f(I, P), SDL_GetNumVideoDisplays: f(I),
    SDL_GetDisplayBounds: f(I, I, P),
    SDL_CreateRenderer: f(P, P, I, U), SDL_DestroyRenderer: f(V, P),
    SDL_SetRenderDrawColor: f(I, P, I, I, I, I), SDL_RenderClear: f(I, P),
    SDL_ShowCursor: f(I, I), SDL_SetRelativeMouseMode: f(I, I), SDL_GetRelativeMouseMode: f(I),
    SDL_CreateTexture: f(P, P, U, I, I, I), SDL_DestroyTexture: f(V, P),
    SDL_QueryTexture: f(I, P, P, P, P, P), SDL_LockTexture: f(I, P, P, P, P),
    SDL_UnlockTexture: f(V, P), SDL_RenderCopy: f(I, P, P, P, P), SDL_RenderPresent: f(V, P),
    /* What Jump 'n Bump's SDL 2 port adds; signatures read from the real headers, not recalled. */
    SDL_CreateWindowAndRenderer: f(I, I, I, U, P, P),
    SDL_RenderSetLogicalSize: f(I, P, I, I),
    SDL_UpdateTexture: f(I, P, P, P, I),
    SDL_SetWindowTitle: f(V, P, P), SDL_SetWindowIcon: f(V, P, P),
    SDL_GetMouseState: f(U, P, P), SDL_GetRelativeMouseState: f(U, P, P),
    SDL_LockAudio: f(V), SDL_UnlockAudio: f(V),
    SDL_PollEvent: f(I, P), SDL_PushEvent: f(I, P),
    SDL_StartTextInput: f(V), SDL_StopTextInput: f(V), SDL_IsTextInputActive: f(I),
    SDL_GetScancodeName: f(P, I), SDL_GetScancodeFromName: f(I, P),
    SDL_NumJoysticks: f(I), SDL_JoystickOpen: f(P, I), SDL_JoystickClose: f(V, P),
    SDL_JoystickName: f(P, P), SDL_JoystickNumAxes: f(I, P), SDL_JoystickNumButtons: f(I, P),
    SDL_JoystickNumHats: f(I, P), SDL_JoystickGetAxis: f(T.SHORT, P, I),
    SDL_JoystickGetButton: f(T.UCHAR, P, I), SDL_JoystickGetHat: f(T.UCHAR, P, I),
    SDL_JoystickUpdate: f(V), SDL_JoystickEventState: f(I, I),
    SDL_OpenAudioDevice: f(U, P, I, P, P, I), SDL_CloseAudioDevice: f(V, U),
    SDL_PauseAudioDevice: f(V, U, I), SDL_LockAudioDevice: f(V, U), SDL_UnlockAudioDevice: f(V, U),
    SDL_BuildAudioCVT: f(I, P, I, I, I, I, I, I), SDL_ConvertAudio: f(I, P),
    /* What SDLPoP adds; prototypes read from the real SDL 2 headers in the oracle container. */
    SDL_GetPerformanceCounter: f(T.ULLONG), SDL_GetPerformanceFrequency: f(T.ULLONG),
    SDL_WasInit: f(U, U), prism_SDL_SetErrorText: f(V, P), SDL_GetDesktopDisplayMode: f(I, I, P), SDL_GetDisplayName: f(P, I),
    SDL_GetWindowID: f(U, P), SDL_SetWindowGrab: f(V, P, I), SDL_WarpMouseInWindow: f(V, P, I, I), SDL_EventState: f(U, U, I),
    SDL_GetKeyName: f(P, I), SDL_GetKeyFromName: f(I, P),
    SDL_RWseek: f(T.LLONG, P, T.LLONG, I), SDL_RWsize: f(T.LLONG, P),
    SDL_GetVersion: f(V, P), SDL_free: f(V, P), SDL_memset: f(P, P, I, U), SDL_strlen: f(U, P),
    SDL_AddTimer: f(I, U, P, P), SDL_RemoveTimer: f(I, I),
    SDL_GetRendererInfo: f(I, P, P), SDL_GetRendererOutputSize: f(I, P, P, P),
    SDL_GL_GetDrawableSize: f(V, P, P, P), SDL_GetWindowFlags: f(U, P),
    SDL_RenderGetLogicalSize: f(V, P, P, P), SDL_RenderGetScale: f(V, P, P, P),
    SDL_RenderGetViewport: f(V, P, P), SDL_RenderSetIntegerScale: f(I, P, I),
    SDL_SetRenderTarget: f(I, P, P),
    SDL_GetKeyboardState: f(P, P), SDL_SetTextInputRect: f(V, P),
    SDL_JoystickRumble: f(I, P, T.USHORT, T.USHORT, U),
    SDL_IsGameController: f(I, I), SDL_GameControllerOpen: f(P, I), SDL_GameControllerClose: f(V, P),
    SDL_GameControllerFromInstanceID: f(P, I), SDL_GameControllerRumble: f(I, P, T.USHORT, T.USHORT, U),
    SDL_GameControllerAddMapping: f(I, P), SDL_GameControllerAddMappingsFromRW: f(I, P, I),
    SDL_HapticOpen: f(P, I), SDL_HapticRumbleInit: f(I, P), SDL_HapticRumblePlay: f(I, P, T.FLOAT, U),
    SDL_RWFromConstMem: f(P, P, I), SDL_RWFromMem: f(P, P, I), SDL_RWFromFile: f(P, P, P),
    SDL_RWread: f(U, P, P, U, U), SDL_RWwrite: f(U, P, P, U, U), SDL_RWtell: f(T.LLONG, P), SDL_RWclose: f(I, P),
    SDL_OpenAudio: f(I, P, P), SDL_CloseAudio: f(V), SDL_PauseAudio: f(V, I), SDL_GetAudioStatus: f(I),
    ...surfaceBuiltins(T), ...imageBuiltins(T),
  };
}

/*
 * KEY NAMES, as SDL_GetKeyName gives them (SDL_keyboard.c): a key with SDLK_SCANCODE_MASK by its
 * scancode's name, the few control characters by theirs, a letter in capitals, any other character
 * as itself. Neverball keeps its keys in its configuration by these names.
 */
const SCANCODE_NAMES = {
  58: 'F1', 59: 'F2', 60: 'F3', 61: 'F4', 62: 'F5', 63: 'F6', 64: 'F7', 65: 'F8', 66: 'F9', 67: 'F10', 68: 'F11', 69: 'F12',
  73: 'Insert', 74: 'Home', 75: 'PageUp', 76: 'Delete', 77: 'End', 78: 'PageDown', 79: 'Right', 80: 'Left', 81: 'Down', 82: 'Up',
  224: 'Left Ctrl', 225: 'Left Shift', 226: 'Left Alt', 227: 'Left GUI', 228: 'Right Ctrl', 229: 'Right Shift', 230: 'Right Alt', 231: 'Right GUI',
};
const CHAR_NAMES = { 13: 'Return', 27: 'Escape', 8: 'Backspace', 9: 'Tab', 32: 'Space', 127: 'Delete' };
function keyName(key) {
  if (key & 0x40000000) return SCANCODE_NAMES[key & ~0x40000000] ?? '';
  if (CHAR_NAMES[key]) return CHAR_NAMES[key];
  if (key >= 0x61 && key <= 0x7a) return String.fromCharCode(key - 32);
  return key ? String.fromCharCode(key) : '';
}
function keyFromName(name) {
  if (!name) return 0;
  const low = name.toLowerCase();
  for (const [code, n] of Object.entries(SCANCODE_NAMES)) if (n.toLowerCase() === low) return (0x40000000 | +code) >>> 0;
  for (const [code, n] of Object.entries(CHAR_NAMES)) if (n.toLowerCase() === low) return +code;
  if (name.length === 1) return name.toLowerCase().charCodeAt(0);
  return 0;
}

/*
 * The two that are C: SDL_SetError is variadic, so it formats through SDL_vsnprintf and hands the
 * text over; SDL_AllocRW's structure is the program's to fill, so it is the program's memory.
 */
export const SDL2_VARS = `
#include <stdarg.h>
#include <stdlib.h>
#include <SDL.h>
void prism_SDL_SetErrorText(const char *text);
int SDL_SetError(const char *fmt, ...)
{
    static char text[1024];
    va_list ap;
    va_start(ap, fmt);
    SDL_vsnprintf(text, sizeof text, fmt, ap);
    va_end(ap);
    prism_SDL_SetErrorText(text);
    return -1;
}
SDL_RWops *SDL_AllocRW(void) { return (SDL_RWops *)calloc(1, sizeof (SDL_RWops)); }
void SDL_FreeRW(SDL_RWops *area) { free(area); }
`;
