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
      SNDCTL_DSP_GETOSPACE = 0x500c, SNDCTL_DSP_SYNC = 0x5001,
      SNDCTL_DSP_GETCAPS = 0x500f, SNDCTL_DSP_SETTRIGGER = 0x5010, SNDCTL_DSP_GETOPTR = 0x5012;
const DSP_CAP_TRIGGER = 0x1000, DSP_CAP_MMAP = 0x2000, PCM_ENABLE_OUTPUT = 0x0002;

/*
 * The DMA buffer, for the OTHER way a program uses this device.
 *
 * Doom WRITES its mixed samples here; Quake MMAPS the card's buffer and mixes straight into it,
 * asking SNDCTL_DSP_GETOPTR where the card has got to and filling in ahead of that. Both are OSS,
 * both are ordinary, and the difference is not a detail: without mmap, snd_linux.c refuses at
 * SNDDMA_Init with "sound driver too old".
 *
 * Eight fragments of 4 KB. The size is not arbitrary -- Quake computes `shm->samples` from it and
 * masks ring positions with `samples - 1`, so a total that is not a power of two silently corrupts
 * every wrap.
 */
const DMA_FRAGS = 8, DMA_FRAGSIZE = 4096, DMA_BYTES = DMA_FRAGS * DMA_FRAGSIZE;
const AFMT_S16_LE = 0x10, AFMT_U8 = 0x08;

const DSP_FD = 0x7300_0001;      // a descriptor no file store will ever hand out

/**
 * Install the device. Wraps whatever `open`/`ioctl`/`write`/`close` are already in place, so a
 * program that writes files AND plays sound keeps both — install this after src/env/stdio.js.
 */
export function installDsp(M, { publish = null, blockWhenFull = false, micros = null } = {}) {
  const prev = {
    open: M.rt.open, close: M.rt.close, write: M.rt.write, ioctl: M.rt.ioctl, mmap: M.rt.mmap,
  };
  /*
   * What paces the DMA pointer. A real card advances it at the sample rate whatever the program is
   * doing, so the wall clock is the truthful default and the only right answer in a browser.
   *
   * A headless capture wants the other thing -- a counter -- for the same reason the timer does:
   * a run that goes faster than real time would sample almost nothing, and one that goes slower
   * would race ahead of what the game had mixed. Pass `micros` to supply that.
   */
  const clock = micros ?? (() => Math.round(performance.now() * 1000));

  const audio = {
    open: false,
    rate: 11025,
    channels: 2,
    format: AFMT_S16_LE,
    written: 0,              // total frames ever accepted, monotonic
    ring: publish ? publish.audio : new Int16Array(4096),
    wav: null,               // a harness may collect here; nothing else uses it
    dropped: 0,              // frames refused because the page had not drained the ring
    dma: null,               // { addr, playing, playedBytes, at } once the program mmaps it
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

  /*
   * mmap on this descriptor hands back the DMA buffer. It is ordinary guest memory -- the program
   * writes samples into it and this device reads them out -- which is exactly the relationship a
   * real card has with its buffer, minus the bus.
   */
  M.rt.mmap = (addr, len, prot, flags, fd, off) => {
    if ((fd | 0) !== (DSP_FD | 0)) {
      return prev.mmap ? prev.mmap(addr, len, prot, flags, fd, off) : -1;
    }
    if (!audio.dma) {
      const p = M.rt.malloc(DMA_BYTES) | 0;
      if (!p) return -1;
      M.mod.u8.fill(0, p, p + DMA_BYTES);
      audio.dma = { addr: p, playing: false, playedBytes: 0, at: clock() };
    }
    return audio.dma.addr;
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
       * What this device can do. Saying TRIGGER|MMAP is a promise the two cases below keep; a
       * device that claimed it and then failed the mmap would be worse than one that claimed
       * nothing, because snd_linux.c checks the capability and not the result.
       */
      case SNDCTL_DSP_GETCAPS: return grant(DSP_CAP_TRIGGER | DSP_CAP_MMAP);
      /*
       * The trigger is the card's start button. Quake clears it, mmaps, then sets PCM_ENABLE_OUTPUT,
       * and only from that moment does the pointer move -- so the buffer it filled beforehand is not
       * half-played by the time it starts.
       */
      case SNDCTL_DSP_SETTRIGGER: {
        const want = (get() & PCM_ENABLE_OUTPUT) !== 0;
        if (audio.dma && want !== audio.dma.playing) {
          audio.dma.playing = want;
          audio.dma.at = clock();
        }
        return 0;
      }
      /*
       * Where the card has got to. This is also where the samples actually leave, because a program
       * using the mmap path never calls write() -- and it asks every frame, which is precisely when
       * new samples are guaranteed to be in the buffer. A real card would be moving them by DMA in
       * between; the program cannot tell the difference, since all it can observe is this answer.
       */
      case SNDCTL_DSP_GETOPTR: {
        if (!arg || !audio.dma) return -1;
        pumpDma();
        dv.setInt32(arg, audio.dma.playedBytes | 0, true);                   // bytes, total
        dv.setInt32(arg + 4, (audio.dma.playedBytes / DMA_FRAGSIZE) | 0, true);  // blocks
        dv.setInt32(arg + 8, audio.dma.playedBytes % DMA_BYTES, true);       // ptr, within the buffer
        return 0;
      }
      /*
       * How much room is left. Doom 1.10 does not ask, but a program that does is asking the one
       * question the ring can answer exactly, so answer it rather than failing.
       */
      /*
       * The output buffer: its GEOMETRY, and how much of it is free.
       *
       * `fragstotal` and `fragsize` describe the DEVICE, not the moment -- Quake multiplies them to
       * size its own mixing ring before it has written a byte. Reporting free space in those two
       * fields, as this did, gave a program asking about the card an answer about the queue.
       */
      case SNDCTL_DSP_GETOSPACE: {
        if (!arg) return -1;
        const freeBytes = Math.max(room(), 0) * 2 * audio.channels;
        dv.setInt32(arg, Math.min(DMA_FRAGS, (freeBytes / DMA_FRAGSIZE) | 0), true);  // fragments free
        dv.setInt32(arg + 4, DMA_FRAGS, true);                                        // fragstotal
        dv.setInt32(arg + 8, DMA_FRAGSIZE, true);                                     // fragsize
        dv.setInt32(arg + 12, freeBytes, true);                                       // bytes free
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

    submit(src, frames);
    return bytes;
  };

  /** Move `frames` frames of 16-bit samples from guest memory at `src` into the ring. */
  function submit(src, frames) {
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
  }

  /**
   * Play whatever the clock says has been played since last time, out of the mmapped buffer.
   *
   * Capped at one buffer's worth per call. A program that stops asking for a while has not caused
   * the card to queue up minutes of audio -- the card overwrote it -- and pretending otherwise would
   * emit a long stretch of stale samples the moment it came back.
   */
  function pumpDma() {
    const d = audio.dma;
    if (!d || !d.playing) return;
    const now = clock();
    const bytesPerFrame = 2 * audio.channels;
    const due = Math.floor(((now - d.at) / 1e6) * audio.rate) * bytesPerFrame;
    if (due <= 0) return;
    d.at = now;
    const take = Math.min(due, DMA_BYTES);
    let at = d.playedBytes % DMA_BYTES;
    let left = take;
    while (left > 0) {
      const run = Math.min(left, DMA_BYTES - at);
      submit(d.addr + at, run / bytesPerFrame);
      at = (at + run) % DMA_BYTES;
      left -= run;
    }
    d.playedBytes += due;
  }

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
