// pipe.js — a pipe between two PRISM programs, in shared memory.
//
// This exists because of a fact about Doom, not a wish for concurrency. `linuxdoom-1.10/doomdef.h`
// line 84 says
//
//     #define SNDSERV  1
//
// so the Doom id published does not play sound itself: it starts a SEPARATE PROGRAM with
// `popen("./sndserver ", "w")` and writes it one ASCII line per effect. That program is
// `corpus/DOOM/sndserv/`, it compiles, and it mixes correctly — what was missing was two address
// spaces and something to carry bytes between them.
//
// Two things make this a pipe rather than a queue:
//
//  * **It is bytes, not messages.** The writer is `fprintf(sndserver, "p%2.2x%2.2x%2.2x%2.2x\n", …)`
//    and the reader is `read(0, commandbuf, 1)` followed by `read(0, commandbuf, 9)`. Neither side
//    knows or cares where the other's writes ended.
//  * **The reader POLLS.** The server's loop is a zero-timeout `select` on fd 0, so it must be able
//    to ask "is anything there" without consuming or blocking — which is why `pending` exists
//    separately from `read`.
//
// The ring is a SharedArrayBuffer so the two programs can be genuinely concurrent — a worker thread
// in Node, a second Worker in a browser — rather than interleaved by a scheduler this project would
// then have to write. Neither program's main loop ever returns, so interleaving them cooperatively
// would mean calling their internals instead of running them, which is the thing PRISM does not do.

const HEAD = 0;            // int32 slot 0: total bytes ever written, monotonic
const TAIL = 1;            // int32 slot 1: total bytes ever read, monotonic
const HEADER_BYTES = 8;

/** Allocate a pipe. `capacity` must be a power of two, so the wrapped index is a mask. */
export function makePipe(capacity = 1 << 16) {
  if (capacity & (capacity - 1)) throw new Error('pipe capacity must be a power of two');
  return new SharedArrayBuffer(HEADER_BYTES + capacity);
}

/** The two views both ends use. Identical code on both sides, so they cannot disagree. */
export function pipeViews(sab) {
  const ctrl = new Int32Array(sab, 0, 2);
  const data = new Uint8Array(sab, HEADER_BYTES);
  return { ctrl, data, mask: data.length - 1 };
}

/**
 * The writing end.
 *
 * A full pipe DROPS rather than blocks, and says how much. Blocking would be more faithful to a real
 * pipe, and it is exactly wrong here: the writer is a game's audio thread and the reader is a mixer.
 * A game that stalls because its sound server is behind is a worse failure than a sound effect that
 * goes missing, and Doom ignores the return value of its own fprintf.
 */
export function pipeWriter(sab) {
  const { ctrl, data, mask } = pipeViews(sab);
  let dropped = 0;
  return {
    write(bytes) {
      const head = Atomics.load(ctrl, HEAD);
      const tail = Atomics.load(ctrl, TAIL);
      const room = data.length - (head - tail);
      const n = Math.min(bytes.length, room);
      if (n < bytes.length) dropped += bytes.length - n;
      for (let i = 0; i < n; i++) data[(head + i) & mask] = bytes[i];
      Atomics.store(ctrl, HEAD, head + n);
      Atomics.notify(ctrl, HEAD);
      return n;
    },
    get dropped() { return dropped; },
  };
}

/** The reading end. `pending` answers select without consuming, which is what a poll needs. */
export function pipeReader(sab) {
  const { ctrl, data, mask } = pipeViews(sab);
  return {
    get pending() { return Atomics.load(ctrl, HEAD) - Atomics.load(ctrl, TAIL); },
    /** Up to `max` bytes, however many are there. A short read is what a pipe does. */
    read(max) {
      const head = Atomics.load(ctrl, HEAD);
      const tail = Atomics.load(ctrl, TAIL);
      const n = Math.min(max, head - tail);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = data[(tail + i) & mask];
      Atomics.store(ctrl, TAIL, tail + n);
      return out;
    },
  };
}
