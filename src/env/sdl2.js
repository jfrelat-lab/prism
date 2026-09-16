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

const bytesPerPixel = (format) => (format === 0x16161804 ? 4 : format === 0x15151002 ? 2 : 1);

import { format } from '../runtime/runtime.js';

export function installSDL2(M, { width = 0, height = 0, onPresent = null, keyboard = null } = {}) {
  const dv = () => M.mod.dv;
  const enc = new TextEncoder();

  const state = {
    surfaces: new Map(),     // guest pointer -> { w, h, pitch, pixels, bpp }
    textures: new Map(),     // handle -> { w, h, format, bpp, pixels, pitch }
    formats: new Map(),
    window: 0, renderer: 0,
    frame: null,             // the last presented texture, as a JS view
    frames: 0,
    ticks0: performance.now(),
    audio: null,             // { callback, userdata, spec, silence }
    events: [],
    error: 0,
    quit: false,
  };
  M.sdl = state;

  let nextHandle = 0x51000000;
  const handle = () => (nextHandle += 16);

  const cstr = (p) => (p ? M.mod.cstr(p) : '');
  const intern = (s) => M.mod.intern([...enc.encode(s), 0]);
  const setErr = (s) => { state.error = intern(s); return -1; };

  /** A PixelFormat in guest memory, because the program reads BytesPerPixel out of it. */
  function makeFormat(format) {
    const p = M.rt.malloc(F_SIZE);
    M.u8.fill(0, p, p + F_SIZE);
    const bpp = bytesPerPixel(format);
    dv().setUint32(p + F_FORMAT, format >>> 0, true);
    M.u8[p + F_BITS] = bpp * 8;
    M.u8[p + F_BYTES] = bpp;
    if (bpp === 4) {
      dv().setUint32(p + F_RMASK, 0x00ff0000, true);
      dv().setUint32(p + F_GMASK, 0x0000ff00, true);
      dv().setUint32(p + F_BMASK, 0x000000ff, true);
    } else if (bpp === 2) {
      dv().setUint32(p + F_RMASK, 0xf800, true);
      dv().setUint32(p + F_GMASK, 0x07e0, true);
      dv().setUint32(p + F_BMASK, 0x001f, true);
    }
    state.formats.set(p, { format, bpp });
    return p;
  }

  const api = {
    // ---------------------------------------------------------------- core
    SDL_Init: () => 0,
    SDL_InitSubSystem: () => 0,
    SDL_QuitSubSystem: () => 0,
    SDL_Quit: () => 0,
    SDL_GetError: () => state.error,
    SDL_SetHint: () => 1,
    /*
     * A clock that actually moves, because OpenTyrian paces itself with it: 29 calls, more than any
     * other SDL function in the program.
     */
    SDL_GetTicks: () => (performance.now() - state.ticks0) | 0,
    /*
     * Delay does NOT sleep. A guest that asks to wait 16 ms is asking to be slower than the host,
     * and a harness counting frames wants the opposite; the guest's own clock keeps running, so its
     * pacing logic still sees time pass. Stated because it IS a deviation.
     */
    SDL_Delay: () => 0,
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
    SDL_GetPixelFormatName: (f) => intern(f === 0x16161804 ? 'SDL_PIXELFORMAT_RGB888'
      : f === 0x15151002 ? 'SDL_PIXELFORMAT_RGB565' : 'SDL_PIXELFORMAT_UNKNOWN'),

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
    SDL_DestroyRenderer: () => { state.renderer = 0; },
    SDL_SetRenderDrawColor: () => 0,
    SDL_RenderClear: () => 0,
    SDL_ShowCursor: () => 0,
    SDL_SetRelativeMouseMode: () => 0,

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
    SDL_RenderCopy: (_r, t) => { state.current = state.textures.get(t) ?? null; return 0; },
    /** Publish. Everything above this line only prepared bytes; this is where a frame exists. */
    SDL_RenderPresent: () => {
      const tx = state.current;
      if (!tx) return;
      state.frame = {
        w: tx.w, h: tx.h, bpp: tx.bpp, format: tx.format,
        bytes: M.u8.slice(tx.pixels, tx.pixels + tx.pitch * tx.h), pitch: tx.pitch,
      };
      state.frames++;
      if (onPresent) onPresent(state.frame, state.frames);
    },

    // ---------------------------------------------------------------- surfaces
    SDL_CreateRGBSurface: (_flags, w, h, depth) => {
      const bpp = Math.max(1, (depth | 0) >> 3);
      const pitch = ((w | 0) * bpp + 3) & ~3;      // SDL pads a surface row to four bytes
      const pixels = M.rt.malloc(pitch * (h | 0));
      M.u8.fill(0, pixels, pixels + pitch * (h | 0));
      const p = M.rt.malloc(S_SIZE);
      M.u8.fill(0, p, p + S_SIZE);
      const fmt = makeFormat(depth === 8 ? 0x11100100 : depth === 16 ? 0x15151002 : 0x16161804);
      M.u8[fmt + F_BYTES] = bpp;
      M.u8[fmt + F_BITS] = bpp * 8;
      dv().setUint32(p + S_FORMAT, fmt, true);
      dv().setInt32(p + S_W, w | 0, true);
      dv().setInt32(p + S_H, h | 0, true);
      dv().setInt32(p + S_PITCH, pitch, true);
      dv().setUint32(p + S_PIXELS, pixels, true);
      dv().setInt32(p + S_CLIP + 8, w | 0, true);
      dv().setInt32(p + S_CLIP + 12, h | 0, true);
      state.surfaces.set(p, { w: w | 0, h: h | 0, pitch, pixels, bpp });
      return p;
    },
    SDL_FreeSurface: (p) => {
      const s = state.surfaces.get(p);
      if (!s) return;
      M.rt.free(s.pixels);
      M.rt.free(dv().getUint32(p + S_FORMAT, true));
      M.rt.free(p);
      state.surfaces.delete(p);
    },
    SDL_FillRect: (dst, rect, color) => {
      const s = state.surfaces.get(dst);
      if (!s) return setErr('invalid surface');
      const x0 = rect ? dv().getInt32(rect, true) : 0;
      const y0 = rect ? dv().getInt32(rect + 4, true) : 0;
      const w = rect ? dv().getInt32(rect + 8, true) : s.w;
      const h = rect ? dv().getInt32(rect + 12, true) : s.h;
      for (let y = y0; y < Math.min(y0 + h, s.h); y++) {
        const row = s.pixels + y * s.pitch;
        for (let x = x0; x < Math.min(x0 + w, s.w); x++) {
          if (s.bpp === 1) M.u8[row + x] = color & 0xff;
          else if (s.bpp === 2) dv().setUint16(row + x * 2, color & 0xffff, true);
          else dv().setUint32(row + x * 4, color >>> 0, true);
        }
      }
      return 0;
    },
    /** A straight copy, clipped. Same depth on both sides is all the corpus asks for. */
    SDL_UpperBlit: (src, srcrect, dst, dstrect) => {
      const a = state.surfaces.get(src), b = state.surfaces.get(dst);
      if (!a || !b) return setErr('invalid surface');
      const sx = srcrect ? dv().getInt32(srcrect, true) : 0;
      const sy = srcrect ? dv().getInt32(srcrect + 4, true) : 0;
      let w = srcrect ? dv().getInt32(srcrect + 8, true) : a.w;
      let h = srcrect ? dv().getInt32(srcrect + 12, true) : a.h;
      const dx = dstrect ? dv().getInt32(dstrect, true) : 0;
      const dy = dstrect ? dv().getInt32(dstrect + 4, true) : 0;
      w = Math.min(w, a.w - sx, b.w - dx);
      h = Math.min(h, a.h - sy, b.h - dy);
      if (a.bpp !== b.bpp) return setErr('blit between different depths');
      for (let y = 0; y < h; y++) {
        const from = a.pixels + (sy + y) * a.pitch + sx * a.bpp;
        const to = b.pixels + (dy + y) * b.pitch + dx * b.bpp;
        M.u8.copyWithin(to, from, from + w * a.bpp);
      }
      return 0;
    },
    SDL_AllocFormat: (format) => makeFormat(format >>> 0),
    SDL_FreeFormat: (p) => { state.formats.delete(p); M.rt.free(p); },
    SDL_MapRGB: (fmtPtr, r, g, b) => {
      const f = state.formats.get(fmtPtr);
      const bpp = f ? f.bpp : (M.u8[fmtPtr + F_BYTES] || 4);
      if (bpp === 2) return (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)) >>> 0;
      return (((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;
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
    SDL_RenderSetLogicalSize: () => 0,
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

    /*
     * An 8-bit surface converted to a 32-bit one THROUGH ITS PALETTE, which is all this call means
     * here: the port draws in 8 bits and asks for RGB888 to hand to a texture. Any other conversion
     * returns NULL rather than being approximated -- a surface that comes back with plausible wrong
     * pixels is worse than one that comes back missing, because only the second is noticed.
     */
    SDL_ConvertSurfaceFormat: (src, _fmt, _flags) => {
      const s = state.surfaces.get(src);
      if (!s || s.bpp !== 1) return NULLPTR;
      const out = api.SDL_CreateRGBSurface(0, s.w, s.h, 32, 0, 0, 0, 0);
      const o = state.surfaces.get(out);
      const pal = state.palette ?? null;
      for (let y = 0; y < s.h; y++) {
        for (let x = 0; x < s.w; x++) {
          const i = M.u8[s.pixels + y * s.pitch + x];
          const r = pal ? pal[i * 3] : i, g = pal ? pal[i * 3 + 1] : i, b = pal ? pal[i * 3 + 2] : i;
          const at = o.pixels + y * o.pitch + x * 4;
          M.u8[at] = b; M.u8[at + 1] = g; M.u8[at + 2] = r; M.u8[at + 3] = 0xff;
        }
      }
      return out;
    },

    /* The palette, kept on the shim so a later conversion and the host both see the same colours. */
    SDL_SetPaletteColors: (_palPtr, colors, first, n) => {
      if (!state.palette) state.palette = new Uint8Array(768);
      for (let i = 0; i < (n | 0); i++) {
        const idx = (first | 0) + i;
        if (idx < 0 || idx > 255) continue;
        const at = colors + i * 4;
        state.palette[idx * 3] = M.u8[at];
        state.palette[idx * 3 + 1] = M.u8[at + 1];
        state.palette[idx * 3 + 2] = M.u8[at + 2];
      }
      if (state.onPalette) state.onPalette(state.palette);
      return 0;
    },

    SDL_LockSurface: () => 0,          // software surfaces are always addressable
    SDL_UnlockSurface: () => 0,
    SDL_SetColorKey: () => 0,
    SDL_MapRGBA: (fmtPtr, r, g, b, a) => {
      const f = state.formats.get(fmtPtr);
      const bpp = f ? f.bpp : (M.u8[fmtPtr + F_BYTES] || 4);
      if (bpp === 2) return (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)) >>> 0;
      return (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;
    },
    SDL_GetMouseState: (xp, yp) => {
      const d = M.mod.dv;
      if (xp) d.setInt32(xp, 0, true);
      if (yp) d.setInt32(yp, 0, true);
      return 0;
    },
    /* No audio thread here, so there is nothing to lock against -- see src/env/sdl12.js. */
    SDL_LockAudio: () => 0,
    SDL_UnlockAudio: () => 0,

    // ---------------------------------------------------------------- events
    SDL_PollEvent: (evt) => {
      const e = state.events.shift();
      if (!e) return 0;
      if (evt) { M.u8.fill(0, evt, evt + 56); M.u8.set(e, evt); }
      return 1;
    },
    SDL_PushEvent: (evt) => {
      if (evt) state.events.push(M.u8.slice(evt, evt + 56));
      return 1;
    },
    SDL_StartTextInput: () => 0,
    SDL_StopTextInput: () => 0,
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

    // ---------------------------------------------------------------- audio
    /*
     * The device is opened and the program's callback recorded. Nothing is played from here: the
     * callback is PULLED by pumpAudio(), because SDL would call it on a thread this host does not
     * have. `obtained` echoes `desired`, which is what a device that can do exactly what was asked
     * reports -- and saying so is why the program's own resampling never runs.
     */
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
      if (obtained) {
        M.u8.copyWithin(obtained, desired, desired + A_SIZE);
        dv().setUint32(obtained + A_SIZE_, size, true);
      }
      state.audio = { callback, userdata, spec, size, paused: true, buffer: 0 };
      return handle();
    },
    SDL_CloseAudioDevice: () => { state.audio = null; },
    SDL_PauseAudioDevice: (_d, pause) => { if (state.audio) state.audio.paused = !!(pause | 0); },
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

  /** Ask the program to fill one audio buffer, the way a device thread would. */
  function pumpAudio() {
    const a = state.audio;
    if (!a || a.paused || !a.callback) return null;
    if (!a.buffer) a.buffer = M.rt.malloc(a.size);
    M.u8.fill(0, a.buffer, a.buffer + a.size);
    M.icall(a.callback, [a.userdata, a.buffer, a.size]);
    return M.u8.slice(a.buffer, a.buffer + a.size);
  }

  /** Queue a key event the way a window system would deliver one. */
  function pushKey(scancode, down) {
    const e = new Uint8Array(56);
    const d = new DataView(e.buffer);
    d.setUint32(0, down ? 0x300 : 0x301, true);      // SDL_KEYDOWN / SDL_KEYUP
    d.setUint8(12, down ? 1 : 0);                    // state
    d.setUint32(16, scancode >>> 0, true);           // keysym.scancode
    state.events.push(e);
  }

  Object.assign(M.rt, api);
  return { state, pumpAudio, pushKey };
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
    SDL_GetPixelFormatName: f(P, U),
    SDL_CreateWindow: f(P, P, I, I, I, I, U), SDL_DestroyWindow: f(V, P), SDL_ShowWindow: f(V, P),
    SDL_SetWindowSize: f(V, P, I, I), SDL_SetWindowPosition: f(V, P, I, I),
    SDL_SetWindowFullscreen: f(I, P, U), SDL_GetWindowSize: f(V, P, P, P),
    SDL_GetWindowDisplayIndex: f(I, P), SDL_GetNumVideoDisplays: f(I),
    SDL_GetDisplayBounds: f(I, I, P),
    SDL_CreateRenderer: f(P, P, I, U), SDL_DestroyRenderer: f(V, P),
    SDL_SetRenderDrawColor: f(I, P, I, I, I, I), SDL_RenderClear: f(I, P),
    SDL_ShowCursor: f(I, I), SDL_SetRelativeMouseMode: f(I, I),
    SDL_CreateTexture: f(P, P, U, I, I, I), SDL_DestroyTexture: f(V, P),
    SDL_QueryTexture: f(I, P, P, P, P, P), SDL_LockTexture: f(I, P, P, P, P),
    SDL_UnlockTexture: f(V, P), SDL_RenderCopy: f(I, P, P, P, P), SDL_RenderPresent: f(V, P),
    /* What Jump 'n Bump's SDL 2 port adds; signatures read from the real headers, not recalled. */
    SDL_CreateWindowAndRenderer: f(I, I, I, U, P, P),
    SDL_RenderSetLogicalSize: f(I, P, I, I),
    SDL_UpdateTexture: f(I, P, P, P, I),
    SDL_ConvertSurfaceFormat: f(P, P, U, U),
    SDL_SetPaletteColors: f(I, P, P, I, I),
    SDL_SetWindowTitle: f(V, P, P), SDL_SetWindowIcon: f(V, P, P),
    SDL_LockSurface: f(I, P), SDL_UnlockSurface: f(V, P),
    SDL_SetColorKey: f(I, P, I, U),
    SDL_MapRGBA: f(U, P, T.UCHAR, T.UCHAR, T.UCHAR, T.UCHAR),
    SDL_GetMouseState: f(U, P, P),
    SDL_LockAudio: f(V), SDL_UnlockAudio: f(V),
    SDL_CreateRGBSurface: f(P, U, I, I, I, U, U, U, U), SDL_FreeSurface: f(V, P),
    SDL_FillRect: f(I, P, P, U), SDL_UpperBlit: f(I, P, P, P, P),
    SDL_AllocFormat: f(P, U), SDL_FreeFormat: f(V, P), SDL_MapRGB: f(U, P, I, I, I),
    SDL_PollEvent: f(I, P), SDL_PushEvent: f(I, P),
    SDL_StartTextInput: f(V), SDL_StopTextInput: f(V),
    SDL_GetScancodeName: f(P, I), SDL_GetScancodeFromName: f(I, P),
    SDL_NumJoysticks: f(I), SDL_JoystickOpen: f(P, I), SDL_JoystickClose: f(V, P),
    SDL_JoystickName: f(P, P), SDL_JoystickNumAxes: f(I, P), SDL_JoystickNumButtons: f(I, P),
    SDL_JoystickNumHats: f(I, P), SDL_JoystickGetAxis: f(T.SHORT, P, I),
    SDL_JoystickGetButton: f(T.UCHAR, P, I), SDL_JoystickGetHat: f(T.UCHAR, P, I),
    SDL_JoystickUpdate: f(V), SDL_JoystickEventState: f(I, I),
    SDL_OpenAudioDevice: f(U, P, I, P, P, I), SDL_CloseAudioDevice: f(V, U),
    SDL_PauseAudioDevice: f(V, U, I), SDL_LockAudioDevice: f(V, U), SDL_UnlockAudioDevice: f(V, U),
    SDL_BuildAudioCVT: f(I, P, I, I, I, I, I, I), SDL_ConvertAudio: f(I, P),
  };
}
