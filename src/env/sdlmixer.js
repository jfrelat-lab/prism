// sdlmixer.js — SDL_mixer, shared by the SDL 1.2 and SDL 2 environments.
//
// SDL_mixer is its OWN library, not part of SDL, and across the two SDL majors it did not change
// where these entry points are concerned. That is measured rather than assumed: the same
// prototypes were compiled beside the genuine headers of BOTH libsdl-mixer1.2-dev and
// libsdl2-mixer-dev, and a conflicting declaration is a compile error, so the file building twice
// IS the agreement. MIX_DEFAULT_FORMAT is 0x8010 and MIX_MAX_VOLUME is 128 in both.
//
// So it lives in one place and both environments name it. envHeaders() allows that on purpose: it
// refuses two environments that supply one header with DIFFERENT text, and identical text is not a
// conflict -- which is exactly the case a shared satellite library makes.
//
// SOUND EFFECTS ARE REAL: a WAV is loaded and converted to the device's format the way SDL 1.2
// converts it, channels are mixed the way SDL_mixer 1.2 mixes them, and tools/gate-sdl-mixer.mjs
// holds the mixed stream, byte for byte, to the real libraries in the oracle. MUSIC IS NOT:
// Mix_LoadMUS returns NULL and the program copes -- Jump 'n Bump prints "Couldn't load music" and
// plays on -- which is the library's own failure path rather than an invented switch.
//
// What is here is what corpus/jumpnbump-sdl12, corpus/jumpnbump-sdl2 and corpus/tuxracer-0.61 call.

export const MIXER_HEADERS = {
  'SDL_mixer.h': `
#ifndef _SDL_mixer_h
#define _SDL_mixer_h
#define MIX_CHANNELS 8
#define MIX_DEFAULT_FREQUENCY 22050
#define MIX_DEFAULT_FORMAT 0x8010
#define MIX_DEFAULT_CHANNELS 2
#define MIX_MAX_VOLUME 128
typedef struct Mix_Chunk {
    int allocated;
    Uint8 *abuf;
    Uint32 alen;
    Uint8 volume;
} Mix_Chunk;
typedef struct _Mix_Music Mix_Music;
struct SDL_RWops;
int Mix_OpenAudio(int frequency, Uint16 format, int channels, int chunksize);
void Mix_CloseAudio(void);
int Mix_QuerySpec(int *frequency, Uint16 *format, int *channels);
char *Mix_GetError(void);
void Mix_SetPostMix(void (*mix_func)(void *udata, Uint8 *stream, int len), void *arg);
Mix_Chunk *Mix_LoadWAV_RW(struct SDL_RWops *src, int freesrc);
#define Mix_LoadWAV(file) Mix_LoadWAV_RW(SDL_RWFromFile(file, "rb"), 1)
void Mix_FreeChunk(Mix_Chunk *chunk);
int Mix_VolumeChunk(Mix_Chunk *chunk, int volume);
int Mix_Volume(int channel, int volume);
int Mix_PlayChannelTimed(int channel, Mix_Chunk *chunk, int loops, int ticks);
#define Mix_PlayChannel(channel, chunk, loops) Mix_PlayChannelTimed(channel, chunk, loops, -1)
int Mix_HaltChannel(int channel);
int Mix_AllocateChannels(int numchans);
int Mix_SetPanning(int channel, Uint8 left, Uint8 right);
int Mix_Playing(int channel);
Mix_Music *Mix_LoadMUS(const char *file);
void Mix_FreeMusic(Mix_Music *music);
int Mix_PlayMusic(Mix_Music *music, int loops);
int Mix_VolumeMusic(int volume);
int Mix_HaltMusic(void);
int Mix_FadeOutMusic(int ms);
int Mix_PlayingMusic(void);
int Mix_SetMusicCMD(const char *command);
#endif
`,
  'SDL2/SDL_mixer.h': null,   // filled in below; the two names serve one text
};
MIXER_HEADERS['SDL2/SDL_mixer.h'] = MIXER_HEADERS['SDL_mixer.h'];

const AUDIO_U8 = 0x0008, AUDIO_S16LSB = 0x8010;
const MIX_CHANNELS = 8, MIX_MAX_VOLUME = 128;
/* Mix_Chunk { int allocated; Uint8 *abuf; Uint32 alen; Uint8 volume; }, the same in both majors. */
const C_ALLOCATED = 0, C_ABUF = 4, C_ALEN = 8, C_VOLUME = 12, C_SIZE = 16;

/*
 * SDL_LoadWAV_RW, for what it accepts of PCM: a RIFF/WAVE file, its `fmt ` chunk, then the first
 * `data` chunk, with any other chunk stepped over. 8-bit samples are unsigned and 16-bit ones
 * signed little-endian, which is the file format's rule and not a choice here.
 */
export function parseWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { error: 'Unrecognized file type (not WAVE)' };
  let fmt = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tag(at), len = dv.getUint32(at + 4, true), body = at + 8;
    if (id === 'fmt ') {
      if (len < 16) return { error: 'Wave format chunk too small' };
      fmt = { encoding: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true),
              rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
      // SDL decodes the two ADPCM encodings as well; this does not, and says which it met.
      if (fmt.encoding !== 1) return { error: `Unknown WAVE data format: 0x${fmt.encoding.toString(16).padStart(4, '0')}` };
      if (fmt.bits !== 8 && fmt.bits !== 16) return { error: `Unknown ${fmt.bits}-bit PCM data format` };
    } else if (id === 'data') {
      if (!fmt) return { error: 'Complex WAVE files not supported' };
      const frame = (fmt.bits >> 3) * fmt.channels;
      const n = Math.min(len, bytes.length - body);
      return { format: fmt.bits === 8 ? AUDIO_U8 : AUDIO_S16LSB, channels: fmt.channels, rate: fmt.rate,
               data: bytes.subarray(body, body + (n - n % frame)) };
    }
    at = body + len;
  }
  return { error: 'Complex WAVE files not supported' };
}

/*
 * SDL 1.2's audio conversion, TRANSCRIBED from SDL_audiocvt.c rather than reasoned out, because
 * what a sound becomes when it is loaded is exactly what these filters do and nothing more
 * principled: a rate is only ever halved or doubled -- 44100 to 22050 keeps every other frame, and
 * 32000 to 22050 is left at 32000 and plays slow, as it does under the real library -- and each
 * filter works in place on one buffer, front to back when it shrinks and back to front when it
 * grows. The order is SDL_BuildAudioCVT's: sign, width, channels, rate.
 */
export const FILTER = {
  sign(c) {
    if ((c.format & 0xff) === 16) for (let i = 1; i < c.len; i += 2) c.buf[i] ^= 0x80;
    else for (let i = 0; i < c.len; i++) c.buf[i] ^= 0x80;
    c.format ^= 0x8000;
  },
  to16(c) {
    for (let s = c.len - 1, d = c.len * 2 - 2; s >= 0; s--, d -= 2) { c.buf[d + 1] = c.buf[s]; c.buf[d] = 0; }
    c.format = (c.format & ~0x0008) | 0x0010;
    c.len *= 2;
  },
  to8(c) {
    const n = c.len >> 1;
    for (let i = 0; i < n; i++) c.buf[i] = c.buf[2 * i + 1];
    c.format = (c.format & ~0x9010) | AUDIO_U8;
    c.len = n;
  },
  stereo(c) {
    const b = c.buf;
    if ((c.format & 0xff) === 16) {
      for (let s = (c.len & ~1) - 2, d = (c.len & ~1) * 2 - 4; s >= 0; s -= 2, d -= 4) {
        const lo = b[s], hi = b[s + 1];
        b[d] = lo; b[d + 1] = hi; b[d + 2] = lo; b[d + 3] = hi;
      }
    } else {
      for (let s = c.len - 1, d = c.len * 2 - 2; s >= 0; s--, d -= 2) { b[d] = b[s]; b[d + 1] = b[s]; }
    }
    c.len *= 2;
  },
  mono(c) {
    const b = c.buf;
    if ((c.format & 0xff) === 16) {
      const signed = (c.format & 0x8000) !== 0, n = c.len >> 2;
      const at = (i) => { const v = b[i] | (b[i + 1] << 8); return signed ? (v << 16) >> 16 : v; };
      for (let i = 0; i < n; i++) {
        const v = MIX_RULES.monoHalf(at(4 * i) + at(4 * i + 2));
        b[2 * i] = v & 0xff; b[2 * i + 1] = (v >> 8) & 0xff;
      }
    } else {
      const signed = (c.format & 0x8000) !== 0, n = c.len >> 1;
      const at = (i) => (signed ? (b[i] << 24) >> 24 : b[i]);
      for (let i = 0; i < n; i++) b[i] = MIX_RULES.monoHalf(at(2 * i) + at(2 * i + 1)) & 0xff;
    }
    c.len >>= 1;
  },
  mul2(c) {
    const b = c.buf, unit = c.unit, n = Math.floor(c.len / unit);
    for (let i = n - 1; i >= 0; i--) {
      const s = c.len - (n - i) * unit, d = c.len * 2 - (n - i) * 2 * unit;
      for (let k = unit - 1; k >= 0; k--) { const v = b[s + k]; b[d + k] = v; b[d + unit + k] = v; }
    }
    c.len *= 2;
  },
  div2(c) {
    const b = c.buf, unit = c.unit, n = Math.floor(c.len / (2 * unit));
    for (let i = 0; i < n; i++) for (let k = 0; k < unit; k++) b[i * unit + k] = b[2 * i * unit + k];
    c.len = Math.floor(c.len / 2);
  },
};
/*
 * The pieces of arithmetic where a plausible reading and the library differ by one unit, each
 * MEASURED on SDL 1.2.15 rather than recalled: two channels are averaged by a division that rounds
 * toward zero (a shift is one off on odd negative sums), a sample is scaled by a volume of 0..128
 * the same way, and an unsigned 8-bit sum saturates at 254, not 255 -- SDL's lookup table ends one
 * short. Named, and in one place, because tools/gate-sdl-mixer.mjs holds each to the real library
 * and swaps it for its near miss to show that it would notice.
 */
export const MIX_RULES = {
  monoHalf: (sum) => Math.trunc(sum / 2),
  scale16: (s, volume) => Math.trunc((s * volume) / MIX_MAX_VOLUME),
  top8: 254,
};

/** The filter list SDL_BuildAudioCVT would make, and how far the buffer can grow under it. */
export function buildConversion(src, dst) {
  const steps = [];
  let mult = 1, { format, channels, rate } = src;
  if ((format & 0x8000) !== (dst.format & 0x8000)) steps.push('sign');
  if ((format & 0xff) !== (dst.format & 0xff)) {
    if ((dst.format & 0xff) === 8) steps.push('to8'); else { steps.push('to16'); mult *= 2; }
  }
  while (channels * 2 <= dst.channels) { steps.push('stereo'); channels *= 2; mult *= 2; }
  while (channels % 2 === 0 && channels / 2 >= dst.channels) { steps.push('mono'); channels /= 2; }
  if (Math.floor(rate / 100) !== Math.floor(dst.rate / 100)) {
    const down = rate > dst.rate, hi = down ? rate : dst.rate;
    for (let lo = down ? dst.rate : rate; Math.floor(lo * 2 / 100) <= Math.floor(hi / 100); lo *= 2) {
      steps.push(down ? 'div2' : 'mul2');
      if (!down) mult *= 2;
    }
  }
  return { steps, mult, unit: ((dst.format & 0xff) >> 3) * channels };
}

export function convertAudio(data, src, dst) {
  const { steps, mult, unit } = buildConversion(src, dst);
  const c = { buf: new Uint8Array(data.length * mult), len: data.length, format: src.format, unit };
  c.buf.set(data);
  for (const s of steps) FILTER[s](c);
  return c.buf.subarray(0, c.len);
}

/**
 * The implementations, over a `state` the caller owns — so an environment can keep the mixer's
 * bookkeeping beside its own rather than in a second place that has to be kept in step.
 *
 * `readRW` turns the handle SDL_RWFromFile returned into the file's bytes; the SDL environment
 * that owns the handles supplies it. Without one, Mix_LoadWAV_RW fails the way a missing file does.
 */
export function mixerApi(M, state, { readRW = null } = {}) {
  const dv = () => M.mod.dv;
  const enc = new TextEncoder();
  let errorAt = 0;
  const setError = (text) => {
    state.mixError = text;
    if (state.setError) state.setError(text);
  };
  const channels = () => (state.channels ??= Array.from({ length: MIX_CHANNELS }, () => (
    { chunk: 0, samples: 0, playing: 0, looping: 0, volume: MIX_MAX_VOLUME, paused: false, pan: null })));
  const frameBytes = () => ((state.format & 0xff) >> 3) * state.outChannels;
  const chunkVolume = (c) => M.u8[c + C_VOLUME];

  /* SDL_MixAudio for the two formats a device is opened in here. */
  const mixInto = (dst, src, len, volume) => {
    if (!volume) return;
    const d = dv(), u8 = M.u8;
    if ((state.format & 0xff) === 16) {
      for (let n = len >> 1; n > 0; n--, src += 2, dst += 2) {
        const v = d.getInt16(dst, true) + MIX_RULES.scale16(d.getInt16(src, true), volume);
        d.setInt16(dst, v > 32767 ? 32767 : v < -32768 ? -32768 : v, true);
      }
    } else {
      for (let n = len; n > 0; n--, src++, dst++) {
        const v = u8[dst] + Math.trunc(((u8[src] - 128) * volume) / MIX_MAX_VOLUME);
        u8[dst] = v > MIX_RULES.top8 ? MIX_RULES.top8 : v < 0 ? 0 : v;
      }
    }
  };

  /*
   * A channel's effects over the samples about to be mixed (Mix_DoEffects): the samples are copied
   * and the copy changed. The one effect here is Mix_SetPanning's, effect_position.c's
   * _Eff_position_s16lsb for a 16-bit stereo device: each sample times left_f (or right_f) times
   * distance_f, in float, then cast to Sint16.
   */
  let effectBuf = 0, effectLen = 0;
  const withEffects = (ch, src, len) => {
    if (!ch.pan || state.outChannels !== 2 || (state.format & 0xff) !== 16) return src;
    if (effectLen < len) { if (effectBuf) M.rt.free(effectBuf); effectBuf = M.rt.malloc(len); effectLen = len; }
    const d = dv(), { left, right, distance } = ch.pan;
    for (let i = 0; i + 4 <= len; i += 4) {
      const l = d.getInt16(src + i, true), r = d.getInt16(src + i + 2, true);
      d.setInt16(effectBuf + i, Math.trunc(Math.fround(Math.fround(l * left) * distance)), true);
      d.setInt16(effectBuf + i + 2, Math.trunc(Math.fround(Math.fround(r * right) * distance)), true);
    }
    return effectBuf;
  };

  /*
   * One device buffer, as SDL_mixer's mix_channels fills it: silence, then every playing channel
   * added at chunk volume times channel volume, a looping chunk starting again where it ended so a
   * loop has no gap, then the program's own post-mix hook over the result.
   */
  const mixBuffer = () => {
    const stream = state.mixBuf, len = state.mixBytes, u8 = M.u8;
    u8.fill((state.format & 0xff) === 8 ? 0x80 : 0, stream, stream + len);
    for (const ch of channels()) {
      if (ch.paused || !ch.chunk) continue;
      let index = 0, volume = 0;
      while (ch.playing > 0 && index < len) {
        volume = Math.trunc((ch.volume * chunkVolume(ch.chunk)) / MIX_MAX_VOLUME);
        const mixable = Math.min(ch.playing, len - index);
        mixInto(stream + index, withEffects(ch, ch.samples, mixable), mixable, volume);
        ch.samples += mixable; ch.playing -= mixable; index += mixable;
        // Done playing: SDL_mixer removes the channel's effects (_Mix_channel_done_playing).
        if (!ch.playing && !ch.looping) ch.pan = null;
      }
      const abuf = dv().getUint32(ch.chunk + C_ABUF, true), alen = dv().getUint32(ch.chunk + C_ALEN, true);
      while (ch.looping && index < len && alen > 0) {
        const remaining = Math.min(len - index, alen);
        mixInto(stream + index, withEffects(ch, abuf, remaining), remaining, volume);
        ch.looping--;
        ch.samples = abuf + remaining; ch.playing = alen - remaining; index += remaining;
      }
      if (!ch.playing && ch.looping) { ch.looping--; ch.samples = abuf; ch.playing = alen; }
    }
    if (state.postMix) M.icall(state.postMix, [state.postMixArg, stream, len]);
    state.buffersMixed++;
  };

  /*
   * THE AUDIO THREAD, WITHOUT A THREAD. Real SDL calls the mixer from its own thread each time the
   * device wants a buffer; here the buffers that are due by the clock are mixed at the points where
   * the program hands control to SDL -- a delay, a tick query, an event poll, a buffer swap. The
   * mixer's state therefore advances as time does, whether or not anybody listens. A listener
   * (state.onAudio, the page) is only handed the newest buffers: after a stall the old ones are
   * history, and playing them late would put everything after them late as well.
   */
  const pump = () => {
    if (!state.audioOpen || !state.clock || !state.mixBuf) return;
    const due = Math.floor(((state.clock.now() - state.mixT0) * state.freq) / (1000 * state.chunkFrames)) + 1;
    while (state.buffersMixed < due) {
      mixBuffer();
      if (state.onMixed) state.onMixed(state.mixBuf, state.mixBytes);   // every one: a comparison's
      if (state.onAudio && due - state.buffersMixed < 2) state.onAudio(state.mixBuf, state.chunkFrames, state);
    }
  };
  state.pump = pump;

  const halt = (ch) => { ch.playing = 0; ch.looping = 0; };
  // ...and halting one, or starting another chunk on it, is done playing too.
  const done = (ch) => { halt(ch); ch.pan = null; };
  const newChannel = () => ({ chunk: 0, samples: 0, playing: 0, looping: 0, volume: MIX_MAX_VOLUME, paused: false, pan: null });
  const active = (ch) => ch.playing > 0 || ch.looping > 0;

  return {
    /*
     * The device is opened as asked: SDL's own drivers take any of these rates and both of these
     * formats without correcting them.
     */
    Mix_OpenAudio: (freq, format, nch, chunk) => {
      format &= 0xffff;
      if (format !== AUDIO_U8 && format !== AUDIO_S16LSB) { setError(`Unsupported audio format 0x${format.toString(16)}`); return -1; }
      if ((nch | 0) !== 1 && (nch | 0) !== 2) { setError(`Unsupported number of audio channels: ${nch | 0}`); return -1; }
      const frames = Math.max(chunk | 0, 1);
      state.freq = freq | 0; state.format = format; state.outChannels = nch | 0; state.chunkFrames = frames;
      state.mixBytes = frames * frameBytes();
      state.mixBuf = M.rt.malloc(state.mixBytes);
      state.mixT0 = state.clock ? state.clock.now() : 0;
      state.buffersMixed = 0;
      state.channels = null;
      state.audioOpen = true;
      if (state.onAudioOpen) state.onAudioOpen(state);
      return 0;
    },
    Mix_CloseAudio: () => {
      state.audioOpen = false;
      if (state.onAudioOpen) state.onAudioOpen(state);
    },
    Mix_QuerySpec: (freq, fmt, ch) => {
      const d = dv();
      if (freq) d.setInt32(freq, state.freq, true);
      if (fmt) d.setUint16(fmt, state.format, true);
      if (ch) d.setInt32(ch, state.outChannels, true);
      return state.audioOpen ? 1 : 0;
    },
    Mix_GetError: () => {
      if (errorAt) M.rt.free(errorAt);
      const text = enc.encode(state.mixError ?? '');
      errorAt = M.rt.malloc(text.length + 1);
      M.u8.set(text, errorAt); M.u8[errorAt + text.length] = 0;
      return errorAt;
    },
    Mix_SetPostMix: (fn, arg) => { state.postMix = fn | 0; state.postMixArg = arg | 0; },

    // ---- sound effects ---------------------------------------------------------------------
    Mix_LoadWAV_RW: (rw, _freesrc) => {
      if (!rw) { setError('Mix_LoadWAV_RW with NULL src'); return 0; }
      if (!state.audioOpen) { setError('Audio device hasn\'t been opened'); return 0; }
      const bytes = readRW ? readRW(rw) : null;
      if (!bytes) { setError('Mix_LoadWAV_RW: nothing to read from'); return 0; }
      const wav = parseWav(bytes);
      if (wav.error) { setError(wav.error); return 0; }
      const out = convertAudio(wav.data, wav, { format: state.format, channels: state.outChannels, rate: state.freq });
      const abuf = M.rt.malloc(Math.max(out.length, 1));
      M.u8.set(out, abuf);
      const chunk = M.rt.malloc(C_SIZE), d = dv();
      d.setInt32(chunk + C_ALLOCATED, 1, true);
      d.setUint32(chunk + C_ABUF, abuf, true);
      d.setUint32(chunk + C_ALEN, out.length, true);
      d.setUint32(chunk + C_VOLUME, MIX_MAX_VOLUME, true);
      return chunk;
    },
    Mix_FreeChunk: (chunk) => {
      if (!chunk) return;
      for (const ch of channels()) if (ch.chunk === chunk) { halt(ch); ch.chunk = 0; }
      if (dv().getInt32(chunk + C_ALLOCATED, true)) M.rt.free(dv().getUint32(chunk + C_ABUF, true));
      M.rt.free(chunk);
    },
    Mix_VolumeChunk: (chunk, volume) => {
      if (!chunk) return -1;
      const was = chunkVolume(chunk);
      if ((volume | 0) >= 0) M.u8[chunk + C_VOLUME] = Math.min(volume | 0, MIX_MAX_VOLUME);
      return was;
    },
    Mix_Volume: (which, volume) => {
      const all = channels();
      const one = (ch) => { const was = ch.volume; if ((volume | 0) >= 0) ch.volume = Math.min(volume | 0, MIX_MAX_VOLUME); return was; };
      if ((which | 0) === -1) return Math.trunc(all.reduce((sum, ch) => sum + one(ch), 0) / all.length);
      return all[which | 0] ? one(all[which | 0]) : 0;
    },
    Mix_PlayChannelTimed: (which, chunk, loops, ticks) => {
      if (!chunk) return -1;
      const d = dv(), all = channels();
      // A chunk is played in whole frames: SDL_mixer trims the length itself, here, on every play.
      const alen = d.getUint32(chunk + C_ALEN, true), whole = alen - (alen % frameBytes());
      if (whole !== alen) d.setUint32(chunk + C_ALEN, whole, true);
      if (!whole) { setError('Tried to play a chunk with a bad frame'); return -1; }
      which |= 0;
      if (which === -1) {
        which = all.findIndex((ch) => ch.playing <= 0);
        if (which < 0) { setError('No free channels available'); return -1; }
      }
      if (which < 0 || which >= all.length) return -1;
      if ((ticks | 0) > 0 && !state.warnedTimed) {
        state.warnedTimed = true;
        console.warn('sdlmixer: Mix_PlayChannelTimed with a time limit plays the whole chunk in this implementation');
      }
      const ch = all[which];
      // A chunk started over a playing one ends that one first, effects and all.
      if (active(ch)) done(ch);
      ch.chunk = chunk; ch.samples = d.getUint32(chunk + C_ABUF, true); ch.playing = whole;
      ch.looping = loops | 0; ch.paused = false;
      return which;
    },
    Mix_HaltChannel: (which) => {
      const all = channels();
      if ((which | 0) === -1) all.forEach(done); else if (all[which | 0]) done(all[which | 0]);
      return 0;
    },
    /* As many channels as asked: the ones dropped are halted, the new ones as Mix_OpenAudio makes them. */
    Mix_AllocateChannels: (n) => {
      const all = channels();
      n |= 0;
      if (n < 0 || n === all.length) return all.length;
      for (let i = n; i < all.length; i++) done(all[i]);
      if (n < all.length) all.length = n;
      else while (all.length < n) all.push(newChannel());
      return n;
    },
    /*
     * Stereo panning, effect_position.c: left and right volumes 0..255 kept as floats (x / 255.0f);
     * 255 and 255 at full distance is no effect at all, and unregisters it. On a mono device it is
     * a no-op that succeeds.
     */
    Mix_SetPanning: (which, left, right) => {
      const all = channels();
      which |= 0; left &= 0xff; right &= 0xff;
      if (which < 0 || which >= all.length) { setError('Invalid channel number'); return 0; }
      if (state.outChannels === 1) return 1;
      const ch = all[which];
      if (left === 255 && right === 255 && (!ch.pan || ch.pan.distanceU8 === 255)) { ch.pan = null; return 1; }
      ch.pan = { left: Math.fround(left / 255), right: Math.fround(right / 255), distance: ch.pan?.distance ?? 1, distanceU8: ch.pan?.distanceU8 ?? 255 };
      return 1;
    },
    Mix_Playing: (which) => {
      const all = channels();
      if ((which | 0) === -1) return all.filter(active).length;
      return all[which | 0] && active(all[which | 0]) ? 1 : 0;
    },

    // ---- music: none. Mix_LoadMUS fails, which is the library's own answer to a format it was
    //      built without, and a program copes with it as it would there. ------------------------
    Mix_LoadMUS: () => { setError('Unrecognized music format'); return 0; },
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
}

/** Pull the recorded mixing callback, the way a host with no audio thread has to. */
export function pumpMixer(M, state, buffer, bytes) {
  if (!state.postMix) return 0;
  M.icall(state.postMix, [state.postMixArg, buffer, bytes]);
  return bytes;
}

/** The fields mixerApi reads and writes, for an environment building its own state object. */
export const MIXER_STATE = {
  postMix: 0, postMixArg: 0, audioOpen: false, musicPlaying: false, musicVolume: 128,
  freq: 44100, format: AUDIO_S16LSB, outChannels: 2, chunkFrames: 0, mixBuf: 0, mixBytes: 0,
  mixT0: 0, buffersMixed: 0, channels: null, mixError: '', onAudio: null, onAudioOpen: null,
};

export function mixerBuiltins(T) {
  const V = T.VOID, I = T.INT, P = T.ptr(T.CHAR), B = T.UCHAR;
  const f = (ret, ...params) => ({ ret, params });
  return {
    Mix_OpenAudio: f(I, I, T.USHORT, I, I),
    Mix_CloseAudio: f(V),
    Mix_QuerySpec: f(I, P, P, P),
    Mix_GetError: f(P),
    Mix_SetPostMix: f(V, P, P),
    Mix_LoadWAV_RW: f(P, P, I),
    Mix_FreeChunk: f(V, P),
    Mix_VolumeChunk: f(I, P, I),
    Mix_Volume: f(I, I, I),
    Mix_PlayChannelTimed: f(I, I, P, I, I),
    Mix_HaltChannel: f(I, I), Mix_AllocateChannels: f(I, I), Mix_SetPanning: f(I, I, B, B),
    Mix_Playing: f(I, I),
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
