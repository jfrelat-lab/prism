// wsock.js — Winsock over the host's real sockets.
//
// This is the guest's half of tools/net-worker.mjs. It owns the shared memory, sends commands to the
// socket thread, and hands the compiled C six primitives -- open, connect, poll, recv, send, close.
// Everything Winsock-shaped stays in src/env/win32-net.c, because the shape is a CONTRACT (a SOCKET
// is a handle, WSAAsyncSelect posts a window message) and the compiler settles it better than a
// string of hand-written offsets would.
//
// WHY A THREAD AT ALL: `program.run` is one long JavaScript call, so node's event loop cannot run
// while the guest is executing and an asynchronous socket can never fire. The sockets therefore live
// on another thread and share memory, which is the same arrangement the browser build uses for sound
// and for stdin. Node allows Atomics.wait on the main thread, so the guest can wait properly rather
// than spinning.
//
// WHAT IT DOES NOT DO: listen, accept, or UDP. PuTTY's client opens outgoing TCP connections and
// nothing else, and a socket layer written past what a program asks for is a surface with no oracle.

import { Worker } from 'node:worker_threads';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const MAX = 8;                  // concurrent sockets; PuTTY's client uses one
const RING = 1 << 16;           // receive bytes per socket
const CTRL_SLOTS = 64 + MAX * 8;

const SEQ = 0;
const base = (i) => 64 + i * 8;
const STATE = (i) => base(i) + 0;
const ERRNO = (i) => base(i) + 1;
const RHEAD = (i) => base(i) + 2;
const RTAIL = (i) => base(i) + 3;
const EVENTS = (i) => base(i) + 4;

/*
 * The six primitives the compiled C calls, declared for the emitter.
 *
 * A C file cannot reach an implementation that lives only in M.rt: PRISM resolves a call by name
 * through the builtin table, exactly as it does for Allegro. Kept beside the implementation so the
 * two cannot drift.
 */
export function wsockBuiltins(T) {
  const P = T.ptr(T.CHAR), I = T.INT;
  const f = (ret, ...params) => ({ ret, params });
  return {
    prism_net_open: f(I),
    prism_net_connect: f(I, I, P, I),
    prism_net_events: f(I, I),
    prism_net_state: f(I, I),
    prism_net_error: f(I, I),
    prism_net_recv: f(I, I, P, I),
    prism_net_send: f(I, I, P, I),
    prism_net_close: f(I, I),
prism_net_wait: f(I, I),
    /* The host's millisecond clock, which every Win32 timer is scheduled off. */
    prism_now_ms: f(T.DOUBLE),
  };
}

export function installWsock(M, { onStop = null } = {}) {
  const sab = new SharedArrayBuffer(CTRL_SLOTS * 4 + MAX * RING);
  const ctrl = new Int32Array(sab, 0, CTRL_SLOTS);
  const rings = new Uint8Array(sab, CTRL_SLOTS * 4);
  const worker = new Worker(join(ROOT, 'tools/net-worker.mjs'), {
    workerData: { sab, MAX, RING },
  });
  worker.unref();                                  // the guest's exit must not wait on it

  const used = new Array(MAX).fill(false);
  const api = {
    /** A slot, or -1. The C side turns this into a SOCKET; -1 becomes INVALID_SOCKET. */
    prism_net_open: () => {
      for (let i = 0; i < MAX; i++) {
        if (used[i]) continue;
        used[i] = true;
        for (const s of [STATE, ERRNO, RHEAD, RTAIL, EVENTS]) Atomics.store(ctrl, s(i), 0);
        return i;
      }
      return -1;
    },

    prism_net_connect: (slot, hostPtr, port) => {
      if (slot < 0 || slot >= MAX || !used[slot]) return -1;
      Atomics.store(ctrl, STATE(slot), 1);
      worker.postMessage({ op: 'connect', slot, host: M.mod.cstr(hostPtr), port: port & 0xffff });
      return 0;
    },

    /**
     * What has happened since last asked, as FD_ bits, and the bits are CONSUMED.
     *
     * Winsock's WSAEnumNetworkEvents has exactly this contract -- it reports and clears -- which is
     * why the guest can be told once and act on it, rather than being woken repeatedly for the same
     * byte.
     */
    prism_net_events: (slot) => {
      if (slot < 0 || slot >= MAX) return 0;
      return Atomics.exchange(ctrl, EVENTS(slot), 0);
    },

    prism_net_state: (slot) => (slot < 0 || slot >= MAX ? 0 : Atomics.load(ctrl, STATE(slot))),
    prism_net_error: (slot) => (slot < 0 || slot >= MAX ? 0 : Atomics.load(ctrl, ERRNO(slot))),

    /** Up to `max` bytes into guest memory. Returns the count; 0 means nothing was waiting. */
    prism_net_recv: (slot, dst, max) => {
      if (slot < 0 || slot >= MAX) return 0;
      const head = Atomics.load(ctrl, RHEAD(slot));
      let tail = Atomics.load(ctrl, RTAIL(slot));
      const off = slot * RING;
      let n = 0;
      while (tail !== head && n < max) {
        M.u8[dst + n++] = rings[off + tail];
        tail = (tail + 1) % RING;
      }
      Atomics.store(ctrl, RTAIL(slot), tail);
      return n;
    },

    prism_net_send: (slot, src, len) => {
      if (slot < 0 || slot >= MAX || !used[slot]) return -1;
      worker.postMessage({ op: 'send', slot, bytes: M.u8.slice(src, src + len) });
      return len | 0;                              // buffered by the socket thread, never short
    },

    prism_net_close: (slot) => {
      if (slot < 0 || slot >= MAX) return -1;
      used[slot] = false;
      worker.postMessage({ op: 'close', slot });
      return 0;
    },

    /**
     * The one place the guest waits, in milliseconds.
     *
     * PuTTY's event loop calls MsgWaitForMultipleObjects with INFINITE when it has nothing to do,
     * and that is the only point in the program where waiting is correct. A bound is still imposed:
     * a guest that waits for ever on a connection nobody will make is a hang, and the timers it also
     * wants to service would never run.
     */
    prism_net_wait: (ms) => {
      const seen = Atomics.load(ctrl, SEQ);
      Atomics.wait(ctrl, SEQ, seen, Math.max(1, Math.min(ms | 0, 200)));
      return Atomics.load(ctrl, SEQ) !== seen ? 1 : 0;
    },
  };

  Object.assign(M.rt, api);
  M.wsock = { stop: () => { worker.postMessage({ op: 'stop' }); onStop?.(); } };
  return M.wsock;
}
