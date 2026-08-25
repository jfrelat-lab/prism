// audio-worklet.js — the page's end of the guest's audio ring.
//
// Sound arrives the same way pixels do, and for the same reason: the guest's audio library is called
// from inside a main loop that never yields, so there is no moment at which it could hand a buffer
// to anybody. It writes into shared memory; this reads.
//
// An AudioWorklet rather than a ScriptProcessorNode because it runs on the audio thread, where a
// blocked main thread — a compile, a long paint, a debugger — cannot make it stutter. It shares the
// SAME SharedArrayBuffer as the worker and the page, so nothing is copied or posted.
//
// The read cursor is published back so the guest can tell how much sound is buffered. That is the
// one number the producer needs, and it is what stops the guest overrunning a ring the page has not
// drained yet.

// Kept in step with src/env/webhost.js by hand: an AudioWorklet module cannot import.
const SLOT_AUDIO_RATE = 12, SLOT_AUDIO_WRITE = 13, SLOT_AUDIO_CHANNELS = 14, SLOT_AUDIO_READ = 24;
const AUDIO_AT = 2048;

class GuestAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sab = options.processorOptions.control;
    this.ctrl = new Int32Array(sab, 0, 128);
    this.ring = new Int16Array(sab, AUDIO_AT, options.processorOptions.ringSamples);
    this.read = 0;             // fractional: the guest's rate and the device's rate rarely match
    this.last = [0, 0];        // the last frame emitted, held through an underrun
    this.started = false;
    this.underruns = 0;
  }

  process(_inputs, outputs) {
    const left = outputs[0][0], right = outputs[0][1] ?? outputs[0][0];
    if (!left) return true;

    const rate = Atomics.load(this.ctrl, SLOT_AUDIO_RATE);
    if (!rate) { left.fill(0); if (right !== left) right.fill(0); return true; }
    const ch = Atomics.load(this.ctrl, SLOT_AUDIO_CHANNELS) || 1;

    const written = Atomics.load(this.ctrl, SLOT_AUDIO_WRITE);
    const frames = this.ring.length / ch;
    const mask = this.ring.length - 1;

    /*
     * Start behind, not level.
     *
     * The guest tops the ring up once per emulated frame, in bursts; the audio thread drains it in
     * even 128-sample blocks. Beginning to play the instant the first sample appears means every
     * block races the next burst. A quarter of the ring in hand is below what anyone hears as
     * latency and above any single frame's jitter.
     */
    const lead = frames >> 2;
    if (!this.started) {
      if (written - this.read < lead) { left.fill(0); if (right !== left) right.fill(0); return true; }
      this.started = true;
      this.read = Math.max(0, written - lead);
    }

    /*
     * Resample, because the two rates are not the same number and cannot be made to be.
     *
     * A guest picks its rate from its own source -- msdos.c's `#define SAMPLE_RATE 44100`, Doom's
     * `#define SAMPLERATE 11025` -- and the device picks its own, usually 48000. Playing 44100
     * samples at 48000 without a step is not a subtle artefact: it is everything 9% sharp, which is
     * very easy to mistake for the emulation running fast. Linear interpolation is enough here; the
     * sources are 8- and 16-bit waveforms from 1990s hardware, well below the device's resolution.
     */
    const step = rate / sampleRate;

    for (let i = 0; i < left.length; i++) {
      if (this.read + 1 < written) {
        const j = Math.floor(this.read), f = this.read - j;
        for (let c = 0; c < 2; c++) {
          const o = ch === 2 ? c : 0;
          const a = this.ring[(j * ch + o) & mask], b = this.ring[((j + 1) * ch + o) & mask];
          this.last[c] = (a + (b - a) * f) / 32768;
        }
        this.read += step;
      } else {
        /*
         * An underrun. Decay the last frame rather than dropping to zero: a jump to silence and back
         * is a click, which is audible, whereas a few milliseconds of decay is not. The guest is
         * never slowed down for it -- a program that cannot keep up should sound rough, not run
         * rough.
         */
        this.underruns++;
        this.last[0] *= 0.995; this.last[1] *= 0.995;
      }
      left[i] = this.last[0];
      if (right !== left) right[i] = this.last[1];
    }
    Atomics.store(this.ctrl, SLOT_AUDIO_READ, Math.floor(this.read));
    return true;
  }
}

registerProcessor('guest-audio', GuestAudio);
