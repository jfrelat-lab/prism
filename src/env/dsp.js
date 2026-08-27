// dsp.js — /dev/dsp, the OSS sound device a Linux program of 1997 writes to.
//
// This is the cheapest audio path in the project, and the reason is worth stating: Doom does its own
// mixing. `I_UpdateSound` fills `signed short mixbuffer[SAMPLECOUNT*BUFMUL]` from its own sound
// effects at its own volumes and stereo separation, and `I_SubmitSound` is one line:
//
//     write(audio_fd, mixbuffer, SAMPLECOUNT*BUFMUL);
//
// So there is no mixer to write and no voice model to reproduce. The host's whole job is to be a
// device that accepts those bytes — the same "publish what the program already writes" move as
// Quake's vid_buffer and Doom's own XImage, one dimension down.
//
// Compare src/env/allegro.js, where SEAL owns the mixing and PRISM had to implement it: the shape of
// a platform layer is decided by the program, not by the host.
//
// What the device must actually do, from i_sound.c's own ioctl sequence:
//   SNDCTL_DSP_SETFRAGMENT  fragment size — accepted and ignored, the ring is one buffer
//   SNDCTL_DSP_RESET        accepted
//   SNDCTL_DSP_SPEED        11025, and the program READS BACK what it got
//   SNDCTL_DSP_STEREO       1
//   SNDCTL_DSP_GETFMTS      which formats exist; AFMT_S16_LE is offered
//   SNDCTL_DSP_SETFMT       16-bit signed little-endian
//
// The read-back matters. An ioctl here takes a POINTER, and the driver writes the value it actually
// granted back through it; a program that asked for 44100 on a card that could only do 22050 is
// expected to notice. Answering with the value asked for is truthful here because the ring really
// does carry whatever rate it is told.

import { SLOT } from './webhost.js';

// <linux/soundcard.h>, the values PRISM's own header declares. The two are one thing in two places.
const SNDCTL_DSP_RESET = 0x5000, SNDCTL_DSP_SPEED = 0x5002, SNDCTL_DSP_STEREO = 0x5003,
      SNDCTL_DSP_GETFMTS = 0x500b, SNDCTL_DSP_SETFMT = 0x5005, SNDCTL_DSP_SETFRAGMENT = 0x500a,
      SNDCTL_DSP_GETOSPACE = 0x500c, SNDCTL_DSP_SYNC = 0x5001;
const AFMT_S16_LE = 0x10, AFMT_U8 = 0x08;

const DSP_FD = 0x7300_0001;      // a descriptor no file store will ever hand out

/**
 * Install the device. Wraps whatever `open`/`ioctl`/`write`/`close` are already in place, so a
 * program that writes files AND plays sound keeps both — install this after src/env/stdio.js.
 */
export function installDsp(M, { publish = null, blockWhenFull = false } = {}) {
  const prev = {
    open: M.rt.open, close: M.rt.close, write: M.rt.write, ioctl: M.rt.ioctl,
  };

  const audio = {
    open: false,
    rate: 11025,
    channels: 2,
    format: AFMT_S16_LE,
    written: 0,              // total frames ever accepted, monotonic
    ring: publish ? publish.audio : new Int16Array(4096),
    wav: null,               // a harness may collect here; nothing else uses it
    dropped: 0,              // frames refused because the page had not drained the ring
  };
  M.dsp = audio;

  M.rt.open = (namePtr, flags) => {
    if (M.mod.cstr(namePtr) === '/dev/dsp') {
      audio.open = true;
      publishFormat();
      return DSP_FD;
    }
    return prev.open ? prev.open(namePtr, flags) : -1;
  };

  M.rt.close = (fd) => {
    if ((fd | 0) === (DSP_FD | 0)) {
      audio.open = false;
      if (publish) Atomics.store(publish.ctrl, SLOT.AUDIO_RATE, 0);
      return 0;
    }
    return prev.close ? prev.close(fd) : -1;
  };

  /*
   * `ioctl` is declared variadic, so the emitter hands the trailing arguments over as an ARRAY --
   * see the `variadic` case in src/backend/emit.js. Unwrapping it here rather than special-casing
   * the declaration keeps ioctl's real signature, which genuinely is (fd, request, ...).
   */
  M.rt.ioctl = (fd, command, rest) => {
    if ((fd | 0) !== (DSP_FD | 0)) return prev.ioctl ? prev.ioctl(fd, command, rest) : -1;
    const arg = Array.isArray(rest) ? (rest[0] | 0) : (rest | 0);
    const dv = M.mod.dv;
    const get = () => (arg ? dv.getInt32(arg, true) : 0);
    const grant = (v) => { if (arg) dv.setInt32(arg, v, true); return 0; };
    switch (command | 0) {
      case SNDCTL_DSP_SPEED:   audio.rate = get() || 11025; publishFormat(); return grant(audio.rate);
      case SNDCTL_DSP_STEREO:  audio.channels = get() ? 2 : 1; publishFormat(); return grant(audio.channels - 1);
      case SNDCTL_DSP_SETFMT:  audio.format = get(); publishFormat(); return grant(audio.format);
      case SNDCTL_DSP_GETFMTS: return grant(AFMT_S16_LE | AFMT_U8);
      case SNDCTL_DSP_RESET:   audio.written = 0; return 0;
      case SNDCTL_DSP_SYNC:    return 0;
      case SNDCTL_DSP_SETFRAGMENT: return 0;
      /*
       * How much room is left. Doom 1.10 does not ask, but a program that does is asking the one
       * question the ring can answer exactly, so answer it rather than failing.
       */
      case SNDCTL_DSP_GETOSPACE: {
        if (!arg) return -1;
        const free = room();
        dv.setInt32(arg, free > 0 ? 1 : 0, true);              // fragments
        dv.setInt32(arg + 4, Math.max(free, 0), true);         // fragstotal
        dv.setInt32(arg + 8, Math.max(free, 0) * 2 * audio.channels, true);  // fragsize
        dv.setInt32(arg + 12, Math.max(free, 0) * 2 * audio.channels, true); // bytes
        return 0;
      }
      default: return 0;      // an unknown ioctl SUCCEEDS: i_sound.c's myioctl prints on failure
    }
  };

  /*
   * The frame. Doom hands over exactly SAMPLECOUNT*BUFMUL bytes of 16-bit stereo it has already
   * mixed, so this copies and publishes; there is nothing to compute.
   *
   * A short write is the honest answer when the ring is full, and it is also what a real blocking
   * device would avoid by blocking. Doom ignores the return value, so nothing here can stall it —
   * frames the page never drained are counted and reported rather than silently lost.
   */
  M.rt.write = (fd, src, n) => {
    if ((fd | 0) !== (DSP_FD | 0)) return prev.write ? prev.write(fd, src, n) : -1;
    const bytes = n | 0;
    const bytesPerFrame = 2 * audio.channels;
    let frames = Math.floor(bytes / bytesPerFrame);
    /*
     * blockWhenFull: WAIT for the consumer instead of dropping.
     *
     * Dropping is right for a game -- a program that cannot keep up should sound rough, not run
     * rough -- and wrong for a dedicated sound server, whose only job is to keep a buffer full and
     * which has no clock of its own. Doom's sndserver free-ran at whatever speed the host could
     * manage and lost 400,000 samples in four hundred submits, the sound effect among them.
     *
     * And it is what the call really does: `write(audio_fd, …)` to a real /dev/dsp blocks until the
     * card has room. The DAC is what paces a sound server, so waiting here is not a workaround, it
     * is the missing clock.
     */
    if (blockWhenFull && publish) {
      let spins = 0;
      while (room() < frames) {
        const read = Atomics.load(publish.ctrl, SLOT.AUDIO_READ);
        // A bounded wait, so a consumer that has gone away cannot wedge the program for ever.
        Atomics.wait(publish.ctrl, SLOT.AUDIO_READ, read, 50);
        if (++spins > 200) break;
      }
    }
    const free = room();
    if (frames > free) { audio.dropped += frames - free; frames = Math.max(free, 0); }
    if (frames <= 0) return bytes;

    const dv = M.mod.dv;
    const mask = audio.ring.length - 1;
    let o = (audio.written * audio.channels) & mask;
    for (let i = 0; i < frames * audio.channels; i++) {
      const s = dv.getInt16(src + i * 2, true);
      audio.ring[o] = s;
      if (audio.wav) audio.wav.push(s);
      o = (o + 1) & mask;
    }
    audio.written += frames;
    if (publish) Atomics.store(publish.ctrl, SLOT.AUDIO_WRITE, audio.written);
    return bytes;
  };

  function room() {
    if (!publish) return audio.ring.length;      // no reader: a sliding window nobody is behind
    const read = Atomics.load(publish.ctrl, SLOT.AUDIO_READ);
    return (audio.ring.length / audio.channels) - (audio.written - read);
  }

  function publishFormat() {
    if (!publish || !audio.open) return;
    Atomics.store(publish.ctrl, SLOT.AUDIO_CHANNELS, audio.channels);
    Atomics.store(publish.ctrl, SLOT.AUDIO_RATE, audio.rate);
  }

  return audio;
}
