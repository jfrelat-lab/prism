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
  /*
   * Allegro 3.9 numbers its keys itself (src/env/allegro39.js): `keymap[n]` is the scan code the
   * host reports for key n, and `scanOf[code]` the key a scan code is. Absent, a key IS its scan
   * code, which is Allegro 3.0.
   */
  keymap = null, scanOf = null,
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

    /*
     * ---- Allegro 3.0, as MAME 0.34's src/msdos uses it.
     *
     * No joystick and no mouse, each said the way the library says it: install_joystick fails,
     * install_mouse answers -1 ("no mouse driver"), and the tables stay empty. No configuration
     * file either: every get_config_* returns the default it was handed -- and the STRING one
     * returns that very pointer, which is what config.c tests for (`== "#"`) to learn that an
     * entry is absent.
     */
    install_joystick: () => -1,
    remove_joystick: () => 0,
    load_joystick_data: () => -1,
    save_joystick_data: () => -1,
    calibrate_joystick: () => -1,
    calibrate_joystick_name: () => 0,
    install_mouse: () => -1,
    remove_mouse: () => 0,
    get_mouse_mickeys: (xp, yp) => { if (xp) dv().setInt32(xp, 0, true); if (yp) dv().setInt32(yp, 0, true); },
    set_leds: () => 0,
    set_config_file: () => 0,
    get_config_string: (_s, _n, def) => def,
    get_config_int: (_s, _n, def) => def,
    get_config_float: (_s, _n, def) => def,
    set_config_string: () => 0,
    set_config_int: () => 0,
    set_config_float: () => 0,
    /* Colours of a 15- or 16-bit mode: 5-6-5, the layout a VESA 16-bit mode has. */
    set_color_depth: (depth) => { state.colorDepth = depth | 0; },
    makecol: (r, g, b) => {
      if (state.colorDepth === 15) return ((r & 0xf8) << 7) | ((g & 0xf8) << 2) | ((b & 0xff) >> 3);
      return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | ((b & 0xff) >> 3);
    },
    getr: (c) => (state.colorDepth === 15 ? ((c >> 10) & 31) << 3 : ((c >> 11) & 31) << 3),
    getg: (c) => (state.colorDepth === 15 ? ((c >> 5) & 31) << 3 : ((c >> 5) & 63) << 2),
    getb: (c) => (c & 31) << 3,
    create_sub_bitmap: (_parent, _x, _y, w, h) => api.create_bitmap(w, h),
    _my_ds: () => 0x1f,
    _movedatal: (_ss, so, _ds, dof, n) => copyTo(so, (n | 0) * 4, dof),
    // conio's getch: one character, unechoed. Read from the program's standard input.
    getch: () => (M.rt.getchar ? M.rt.getchar() : -1),

    /*
     * SEAL's later calls. A voice is PRIMED with a wave and STARTED separately -- APlayVoice is
     * the two together -- and AUpdateAudioEx says how many output frames are due, which headless
     * is taken at its word.
     */
    APrimeVoice: (h, lpWave) => { const v = voice(h); if (!v) return 1; setWave(v, lpWave); v.pos = 0; v.playing = false; return 0; },
    AStartVoice: (h) => { const v = voice(h); if (!v) return 1; v.playing = v.length > 0; return 0; },
    AGetVoiceStatus: (h, lp) => { const v = voice(h); if (lp) dv().setInt32(lp, v && v.playing ? 0 : 1, true); return 0; },
    AUpdateAudioEx: (n) => { mix(n >>> 0); return 0; },
    ASetAudioMixerValue: (_ch, value) => { audio.master = Math.min(value >>> 0, 256); return 0; },

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
      // Allegro returns (key << 8) | ascii; the key is the scan code in 3.0 and its own number in 3.9.
      return scan < 0 ? 0 : ((scanOf ? scanOf[scan & 127] : scan) << 8);
    },
    // 3.9's reading of a key as a character. No text input is offered: the key number, no character.
    ureadkey: (scancodeP) => {
      const scan = readKey();
      if (scancodeP) dv().setInt32(scancodeP, scan < 0 ? 0 : (scanOf ? scanOf[scan & 127] : scan), true);
      return 0;
    },
    keypressed: () => 0,
    clear_keybuf: () => 0,

    /*
     * ---- SEAL, the sound library MAME 0.1 links on DOS. A real four-voice mixer, not stubs.
     *
     * The contract is small but it has one hard obligation, and it is not the mixing:
     * `osd_play_streamed_sample` BLOCKS on the play position.
     *
     *     for(;;) { AGetVoicePosition(hVoice[channel],&pos);
     *               if (c == 1 && (pos < len || pos > 2*len)) break;
     *               osd_update_audio(); }
     *
     * That is a triple-buffered stream waiting for the DAC to leave the third it is about to
     * overwrite. On real hardware the position advances because DMA is running in real time and
     * AUpdateAudio only refills; if the position never moves, MAME hangs on its first streamed
     * sample. So this shim models the DAC the way the hardware works -- a play cursor that advances
     * with TIME -- and AUpdateAudio does what SEAL's really does: mix everything that has become due
     * since the last call, and no more.
     *
     * AUDIO_FORMAT_8BITS in SEAL is UNSIGNED 8-bit, centred on 128, and volume runs 0..64 (msdos.c
     * passes MAME's 0..255 as `volume/4`).
     */
    AInitialize: () => 0,
    /*
     * SEAL's device table starts with its "None" driver: device 0 (AUDIO_DEVICE_NONE) opens and
     * plays nothing, and the cards follow. MAME 0.34 relies on the numbering -- its sound.c reads
     * soundcard 0 as "silence" without asking SEAL -- so the one real output here is device 1.
     */
    AGetAudioNumDevs: () => 2,
    AGetAudioDevCaps: (id, caps) => {
      const name = (id | 0) === 0 ? 'None' : 'PRISM shared-memory ring';
      for (let i = 0; i < name.length; i++) M.u8[caps + 2 + i] = name.charCodeAt(i);
      M.u8[caps + 2 + name.length] = 0;
      return 0;
    },

    /** The program chooses the rate; the page is told what it chose, the same way as the geometry. */
    AOpenAudio: (info) => {
      audio.rate = dv().getInt32(info + 4, true) || 44100;   // AUDIOINFO.nSampleRate
      audio.open = dv().getUint16(info, true) !== 0;       // nDeviceId 0 is the silent driver
      if (!audio.open) return 0;
      audio.clockUs = null;
      if (publish) {
        Atomics.store(publish.ctrl, SLOT.AUDIO_CHANNELS, 1);   // SEAL voices mix to one channel
        Atomics.store(publish.ctrl, SLOT.AUDIO_RATE, audio.rate);
      }
      return 0;
    },
    ACloseAudio: () => {
      audio.open = false;
      if (publish) Atomics.store(publish.ctrl, SLOT.AUDIO_RATE, 0);
      return 0;
    },

    AOpenVoices: (n) => { audio.voices.length = 0; for (let i = 0; i < (n | 0); i++) newVoice(); return 0; },
    ACloseVoices: () => { for (const v of audio.voices) v.playing = false; return 0; },
    ACreateAudioVoice: (lph) => {
      const h = audio.voices.length ? audio.voices.length : newVoice();
      const id = audio.voices.findIndex(v => !v.claimed);
      const v = id >= 0 ? audio.voices[id] : audio.voices[newVoice() - 1];
      v.claimed = true;
      dv().setInt32(lph, v.handle, true);
      return 0;
    },
    ADestroyAudioVoice: (h) => { const v = voice(h); if (v) { v.playing = false; v.claimed = false; } return 0; },

    APlayVoice: (h, lpWave) => {
      const v = voice(h);
      if (!v) return 1;
      setWave(v, lpWave);
      v.pos = 0;
      v.playing = v.length > 0;
      state.samples.push({ voice: h | 0, len: v.length });
      return 0;
    },
    AStopVoice: (h) => { const v = voice(h); if (v) v.playing = false; return 0; },
    ASetVoiceFrequency: (h, f) => { const v = voice(h); if (v) v.freq = f >>> 0; return 0; },
    ASetVoiceVolume: (h, vol) => { const v = voice(h); if (v) v.vol = Math.min(vol >>> 0, 64); return 0; },
    ASetVoicePanning: (h, p) => { const v = voice(h); if (v) v.pan = p >>> 0; return 0; },

    /** In BYTES into the waveform, which is what msdos.c compares against its buffer thirds. */
    AGetVoicePosition: (h, lp) => {
      const v = voice(h);
      if (lp) dv().setInt32(lp, v ? Math.floor(v.pos) : 0, true);
      return 0;
    },

    /*
     * The mixer tick. MAME calls it once per frame through osd_update_audio, and also from inside the
     * streaming wait loop -- which is why it must always make progress when time has passed.
     */
    AUpdateAudio: () => { mix(); return 0; },

    /*
     * The two data calls. `lpData` has to exist because msdos.c writes through it immediately, and
     * it reads `dwLength` to size it, exactly as the real library does. AWriteAudioData is where a
     * real SEAL would upload to the card's own memory; here the data is already in the one address
     * space, so the upload is the identity -- but the LENGTH it reports matters, because a streamed
     * voice grows its buffer to 3x after the first write.
     */
    ACreateAudioData: (lpWave) => {
      const len = dv().getInt32(lpWave + 8, true) >>> 0;
      const buf = M.rt.malloc(Math.max(len, 1));
      M.u8.fill(128, buf, buf + Math.max(len, 1));        // 8-bit silence is 128, not 0
      dv().setInt32(lpWave + 24, buf, true);              // AUDIOWAVE.lpData
      return 0;
    },
    ADestroyAudioData: (lpWave) => {
      const p = dv().getInt32(lpWave + 24, true);
      if (p) M.rt.free(p);
      dv().setInt32(lpWave + 24, 0, true);
      return 0;
    },
    AWriteAudioData: (lpWave) => {
      for (const v of audio.voices) {
        if (!v.playing || v.data !== dv().getInt32(lpWave + 24, true)) continue;
        v.length = dv().getInt32(lpWave + 8, true) >>> 0;
        v.loopEnd = dv().getInt32(lpWave + 16, true) >>> 0 || v.length;
      }
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

  };

  /*
   * ---- the mixer.
   *
   * Sound leaves the guest exactly the way pixels do: written into shared memory for the page to
   * read, never handed over. The reason is the same one that shaped the whole host — the program's
   * audio library is called from inside a main loop that never yields, so there is no moment at
   * which the guest could pass a buffer to anybody. See src/env/webhost.js for the ring.
   */
  const audio = {
    open: false,
    rate: 44100,
    voices: [],
    written: 0,          // total output samples ever mixed, monotonic
    clockUs: null,       // guest microseconds at the last mix
    ring: publish ? publish.audio : new Int16Array(4096),
    wav: null,           // tools/mame.mjs --wav collects here; nothing else uses it
  };
  M.audio = audio;

  let voiceSeq = 0;
  const newVoice = () => {
    audio.voices.push({
      handle: ++voiceSeq, claimed: false, playing: false,
      data: 0, length: 0, pos: 0, freq: 8000, vol: 0, pan: 128,
      loop: false, loopStart: 0, loopEnd: 0,
    });
    return audio.voices.length;
  };
  const voice = (h) => audio.voices.find(v => v.handle === (h | 0)) ?? null;
  /* A voice's wave: where its data is, how long, whether it loops, and its sample width. Lengths
     and positions are in BYTES, as SEAL counts them, for 16-bit data too. */
  const setWave = (v, lpWave) => {
    const format = dv().getUint16(lpWave, true);
    v.data = dv().getInt32(lpWave + 24, true);           // AUDIOWAVE.lpData
    v.length = dv().getInt32(lpWave + 8, true) >>> 0;    // dwLength
    v.loop = (format & 0x0100) !== 0;
    v.wide = (format & 0x0002) !== 0;                    // AUDIO_FORMAT_16BITS
    v.loopStart = dv().getInt32(lpWave + 12, true) >>> 0;
    v.loopEnd = dv().getInt32(lpWave + 16, true) >>> 0 || v.length;
  };

  /*
   * How many output samples have become DUE since the last mix.
   *
   * In the browser, from the guest's own real clock: the DAC really does advance in real time there,
   * and the page is consuming the ring at exactly that rate.
   *
   * Headless there is no consumer and no real time, so a mix is worth one frame of sound. That is
   * both deterministic — a gate must get the same bytes every run — and the true call rate, because
   * MAME calls osd_update_audio once per frame. It is DELIBERATELY not read from `clock()`: MAME
   * throttles its frames on that counter, and advancing it from here would change the emulation
   * being measured. An audio clock must not be the game's clock.
   *
   * The one place this over-advances is msdos.c's streaming wait loop, which calls osd_update_audio
   * until the play cursor moves; headless it moves a whole frame at a time, so the loop exits after
   * one or two turns instead of many. It terminates, which is the property that matters.
   */
  function due() {
    if (M.realClock) {
      const nowUs = M.realClock.micros();
      if (audio.clockUs === null) { audio.clockUs = nowUs; return 0; }
      const dt = nowUs - audio.clockUs;
      if (dt <= 0) return 0;
      audio.clockUs = nowUs;
      // Bounded, so a long pause (a compile, a backgrounded tab) resumes rather than trying to
      // render the silence it missed.
      return Math.min(Math.floor(dt * audio.rate / 1e6), audio.rate >> 2);
    }
    return Math.floor(audio.rate / 60);
  }

  function mix(asked = 0) {
    if (!audio.open) return;
    // Headless, an update that names its frame count (AUpdateAudioEx) is taken at its word.
    let n = asked && !M.realClock ? asked : due();
    if (!n) return;
    // Never overrun the reader. The page publishes what it has consumed; without a page there is no
    // reader and the ring is a sliding window that nobody is behind.
    if (publish) {
      const read = Atomics.load(publish.ctrl, SLOT.AUDIO_READ);
      const room = audio.ring.length - (audio.written - read);
      if (room <= 0) return;
      if (n > room) n = room;
    }
    const mask = audio.ring.length - 1;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (const v of audio.voices) {
        if (!v.playing || !v.data || !v.length) continue;
        if (v.wide) {
          // 16-bit signed; the position is in bytes, so a sample is two of them.
          acc += (dv().getInt16(v.data + ((v.pos | 0) & ~1), true) >> 8) * v.vol;
          v.pos += (2 * v.freq) / audio.rate;
        } else {
          acc += (M.u8[v.data + (v.pos | 0)] - 128) * v.vol;   // 8-bit unsigned, centred on 128
          v.pos += v.freq / audio.rate;
        }
        if (v.pos >= (v.loop ? v.loopEnd : v.length)) {
          if (v.loop) v.pos = v.loopStart + (v.pos - v.loopEnd);
          else { v.pos = 0; v.playing = false; }
        }
      }
      // vol is 0..64 and a sample is -128..127, so the sum of four voices fits 16 bits with room.
      const out = Math.max(-32768, Math.min(32767, acc * 4));
      audio.ring[(audio.written + i) & mask] = out;
      if (audio.wav) audio.wav.push(out);
    }
    audio.written += n;
    if (publish) Atomics.store(publish.ctrl, SLOT.AUDIO_WRITE, audio.written);
  }

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
    // A program that keeps a screen bitmap of its own is presented from it (see presentBitmap):
    // what it writes to the card is then only the rectangles that changed.
    if (g.scrbitmap) return 0;
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
    frameDone();
  }

  /*
   * MAME 0.34's display, which is no longer "the whole bitmap, every frame, at 0xa0000".
   *
   * Its video.c keeps the game's picture in a bitmap of its own (`scrbitmap`) and copies to the card
   * only the 16x16 blocks that changed, through one of twenty `update_screen_*` routines chosen by
   * mode -- tweaked VGA, VESA 8- or 16-bit, doubled or not, with or without scanlines. So the card's
   * memory is never written as a whole, a frame in which nothing moved writes nothing at all, and
   * where the picture sits in it depends on CRTC registers this shim does not model.
   *
   * What does not depend on the mode is the bitmap and the rectangle of it the program decided to
   * show: `skiplines`, `skipcolumns`, `gfx_display_lines`, `gfx_display_columns`, its own variables,
   * which the PgUp/PgDn panning moves. So a frame is presented where the program copies it to the
   * screen -- every update_screen_* routine is followed by this -- and it is that rectangle of that
   * bitmap, undoubled: the picture the game drew rather than the scan-out of one card.
   *
   * MAME 0.37b5 keeps all of that and changes two things. Its blit routines are HANDED the bitmap
   * (`blitscreen_*(struct osd_bitmap *)`, in a unit of their own), and a 16-bit bitmap may hold pen
   * numbers rather than pixels: a game that rewrites more than 256 colours draws with indexes and
   * the routine turns each into a pixel through `palette_16bit_lookup` on the way to the card. So
   * the caller says which bitmap, and whether its words go through that table (`lookup`).
   */
  let shown = 0, shownSize = 0;
  function presentBitmap(b = dv().getInt32(g.scrbitmap, true), lookup = 0) {
    const d = dv();
    if (!b) return;
    const depth = d.getInt32(b + 8, true);
    const lines = d.getInt32(b + 16, true);
    const fullW = d.getInt32(b, true), fullH = d.getInt32(b + 4, true);
    const sy = Math.max(d.getInt32(g.skiplines, true), 0), sx = Math.max(d.getInt32(g.skipcolumns, true), 0);
    const w = Math.min(d.getInt32(g.displayColumns, true), fullW - sx);
    const h = Math.min(d.getInt32(g.displayLines, true), fullH - sy);
    if ((depth !== 8 && depth !== 16) || w <= 0 || h <= 0 || !lines) return;
    const bytes = depth === 16 ? 4 : 1;
    if (w * h * bytes > shownSize) { shownSize = w * h * bytes; shown = M.rt.malloc(shownSize); }
    if (depth === 8) {
      for (let y = 0; y < h; y++) {
        const row = d.getInt32(lines + 4 * (sy + y), true) + sx;
        M.u8.copyWithin(shown + y * w, row, row + w);
      }
    } else {
      /*
       * A 16-bit bitmap holds what makecol returned -- the mode's own pixel format, 5-6-5 or 5-5-5
       * by the depth the program set -- and no palette stands between it and the screen. It goes
       * out as B,G,R,A, a component's high bits repeated into its low ones as a DAC would not but a
       * full-range display must (31 is white, not 248).
       */
      const five = (v) => (v << 3) | (v >> 2), six = (v) => (v << 2) | (v >> 4);
      const is15 = state.colorDepth === 15;
      let o = shown;
      for (let y = 0; y < h; y++) {
        let p = d.getInt32(lines + 4 * (sy + y), true) + 2 * sx;
        for (let x = 0; x < w; x++, p += 2, o += 4) {
          let c = M.u8[p] | (M.u8[p + 1] << 8);
          if (lookup) c = M.u8[lookup + 4 * c] | (M.u8[lookup + 4 * c + 1] << 8);
          M.u8[o] = five(c & 31);
          M.u8[o + 1] = is15 ? five((c >> 5) & 31) : six((c >> 5) & 63);
          M.u8[o + 2] = five(is15 ? (c >> 10) & 31 : c >> 11);
          M.u8[o + 3] = 255;
        }
      }
    }
    state.width = w; state.height = h; state.pixels = shown; state.format = depth === 16 ? 32 : 0;
    frameDone();
  }

  function frameDone() {
    state.frames++;
    if (publish) {
      Atomics.store(publish.ctrl, SLOT.PIXFMT, state.format ?? 0);
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
    if (keymap) { for (let k = 1; k < keymap.length; k++) M.u8[g.key + k] = keymap[k] && keys(keymap[k]) ? 1 : 0; return; }
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
    /*
     * MAME 0.34's own display variables (see presentBitmap). Three of them are file statics of
     * src/msdos/video.c, which the linker names by their unit: "<unit>$<name>".
     */
    const inVideo = (n) => {
      for (const [k, v] of program.mod.symbols) if (k === n || /video\$/.test(k) && k.endsWith('$' + n)) return v.addr;
      return 0;
    };
    // ...and so are the blit routines, which video.c declares static before defining them.
    const blits = Object.keys(program.F).filter((n) => /(^|video\$)update_screen_(?!dummy$)/.test(n));
    const video = { scrbitmap: inVideo('scrbitmap'), skiplines: inVideo('skiplines'), skipcolumns: inVideo('skipcolumns'),
      displayLines: inVideo('gfx_display_lines'), displayColumns: inVideo('gfx_display_columns') };
    if (blits.length && Object.values(video).every(Boolean)) {
      Object.assign(g, video);
      for (const name of blits) {
        const blit = program.F[name];
        program.F[name] = function (...a) { const r = blit.apply(this, a); presentBitmap(); return r; };
      }
    }
    /*
     * MAME 0.37b5 (see presentBitmap). Its routines are REPLACED, not followed: all but the two for
     * the tweaked VGA modes end in assembly kept in a NASM file (asmblit.asm) that is not part of
     * this build, and what they would do -- stretch the picture into one card's memory -- is the
     * part of the display this shim never showed anyway.
     */
    const blits37 = Object.keys(program.F).filter((n) => /^blitscreen_/.test(n));
    const video37 = { skiplines: sym('skiplines'), skipcolumns: sym('skipcolumns'),
      displayLines: sym('gfx_display_lines'), displayColumns: sym('gfx_display_columns') };
    const lookup16 = sym('palette_16bit_lookup');
    if (blits37.length && lookup16 && Object.values(video37).every(Boolean)) {
      Object.assign(g, video37);
      g.scrbitmap = lookup16;    // any non-zero value: "this program is presented from its bitmap" (copyTo)
      for (const name of blits37) {
        const palettized = /_palettized$/.test(name);
        program.F[name] = (bitmap) => { presentBitmap(bitmap, palettized ? dv().getInt32(lookup16, true) : 0); };
      }
    }
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
char allegro_error[80];
int joy_x, joy_y;
int joy_left, joy_right, joy_up, joy_down;
int joy_b1, joy_b2, joy_b3, joy_b4;
JOYSTICK_INFO joy[4];
int num_joysticks;
int joy_type;
volatile int mouse_x, mouse_y, mouse_b;
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
    readkey: f(I), keypressed: f(I), clear_keybuf: f(V), ureadkey: f(I, P),
    install_joystick: f(I, I), remove_joystick: f(V), load_joystick_data: f(I, P), save_joystick_data: f(I, P),
    calibrate_joystick: f(I, I), calibrate_joystick_name: f(P, I),
    install_mouse: f(I), remove_mouse: f(V), get_mouse_mickeys: f(V, P, P), set_leds: f(V, I),
    set_config_file: f(V, P), get_config_string: f(P, P, P, P), get_config_int: f(I, P, P, I),
    get_config_float: f(T.FLOAT, P, P, T.FLOAT),
    set_config_string: f(V, P, P, P), set_config_int: f(V, P, P, I), set_config_float: f(V, P, P, T.FLOAT),
    set_color_depth: f(V, I), makecol: f(I, I, I, I), getr: f(I, I), getg: f(I, I), getb: f(I, I),
    create_sub_bitmap: f(P, P, I, I, I, I),
    _my_ds: f(T.USHORT), _movedatal: f(V, U, U, U, U, U), getch: f(I),
    APrimeVoice: f(U, U, P), AStartVoice: f(U, U), AGetVoiceStatus: f(U, U, P), AUpdateAudioEx: f(U, U),
    ASetAudioMixerValue: f(U, U, U),

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

  };
}
