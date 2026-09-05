// net-worker.mjs — the sockets, on a thread of their own.
//
// PRISM's guest runs on the main thread and does not return to node's event loop while it is
// running: `program.run` is one long JavaScript call. So node's own asynchronous sockets can never
// fire while the program is executing, and a blocking recv() is impossible in the same thread.
//
// The way out is the one the browser build already uses for sound and for stdin: put the work on
// another thread and share memory. Here the SOCKETS are on the other thread. Commands go out by
// postMessage -- the worker has an event loop, so it hears them -- and everything the guest reads
// comes back through a SharedArrayBuffer, so the guest can look without yielding.
//
// The guest never blocks on a socket. PuTTY's Windows client asks to be TOLD when a socket is ready
// (WSAAsyncSelect), so recv is only ever called when bytes are already there; the one place it waits
// is MsgWaitForMultipleObjects, and that waits on this ring.

import { parentPort, workerData } from 'node:worker_threads';
import net from 'node:net';

const { sab, MAX, RING } = workerData;
const ctrl = new Int32Array(sab, 0, 64 + MAX * 8);
const rings = new Uint8Array(sab, (64 + MAX * 8) * 4);

/* Control layout, in Int32 slots. Kept in one place because both sides index it. */
const SEQ = 0;                                   // bumped on every change, for Atomics.wait
const base = (i) => 64 + i * 8;
const STATE = (i) => base(i) + 0;                // 0 free 1 connecting 2 open 3 closed 4 error
const ERRNO = (i) => base(i) + 1;
const RHEAD = (i) => base(i) + 2;                // written by the worker
const RTAIL = (i) => base(i) + 3;                // written by the guest
const EVENTS = (i) => base(i) + 4;               // FD_ bits the guest has not been told about

const FD_READ = 1, FD_WRITE = 2, FD_CONNECT = 16, FD_CLOSE = 32;

const socks = new Array(MAX).fill(null);

const wake = () => { Atomics.add(ctrl, SEQ, 1); Atomics.notify(ctrl, SEQ); };
const raise = (i, bits) => { Atomics.or(ctrl, EVENTS(i), bits); wake(); };

/** Bytes into slot i's receive ring. Drops what will not fit rather than growing without bound. */
function deliver(i, buf) {
  const off = i * RING;
  let head = Atomics.load(ctrl, RHEAD(i));
  const tail = Atomics.load(ctrl, RTAIL(i));
  const free = RING - 1 - ((head - tail + RING) % RING);
  const n = Math.min(buf.length, free);
  for (let k = 0; k < n; k++) {
    rings[off + head] = buf[k];
    head = (head + 1) % RING;
  }
  Atomics.store(ctrl, RHEAD(i), head);
  if (n) raise(i, FD_READ);
}

parentPort.on('message', (m) => {
  const i = m.slot;
  if (m.op === 'connect') {
    const s = net.connect({ host: m.host, port: m.port });
    socks[i] = s;
    s.on('connect', () => {
      Atomics.store(ctrl, STATE(i), 2);
      raise(i, FD_CONNECT | FD_WRITE);
    });
    s.on('data', (b) => deliver(i, b));
    s.on('close', () => { Atomics.store(ctrl, STATE(i), 3); raise(i, FD_CLOSE); });
    s.on('error', (e) => {
      Atomics.store(ctrl, ERRNO(i), e.errno ? Math.abs(e.errno) : 1);
      Atomics.store(ctrl, STATE(i), 4);
      raise(i, FD_CLOSE);
    });
    return;
  }
  if (m.op === 'send') { socks[i]?.write(Buffer.from(m.bytes)); return; }
  if (m.op === 'close') { socks[i]?.destroy(); socks[i] = null; Atomics.store(ctrl, STATE(i), 0); return; }
  if (m.op === 'stop') { for (const s of socks) s?.destroy(); parentPort.close(); }
});
