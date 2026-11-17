// threads.js — POSIX threads: each one a Web Worker over the program's own SharedArrayBuffer.
//
// THE SHAPE. A thread is the same compiled program instantiated a second time, in its own worker, over
// the same memory image: its own JavaScript stack and its own shadow stack (a block of the heap), the
// same functions at the same table indices, the same globals at the same addresses. What it does NOT
// share is the JavaScript state of the machine that started the program -- the heap's free lists, the
// open files, the GL context, the clock, the keyboard. Those live in the HOME thread (the program's
// main thread, tid 1), and every library call another thread makes is FORWARDED there and run against
// them, the arguments travelling as numbers (pointers mean the same thing on both sides).
//
// ONE THREAD RUNS AT A TIME, and the home thread decides which. A thread gives control back when it
// blocks -- a contended mutex, a condition wait, a sleep, a join, its end -- and the home thread hands
// it out at its own blocking points and whenever the program asks the time (M.pollThreads, which is
// how a sleeping thread is woken at its deadline while the main loop runs). That is what makes the
// forwarding safe: while a thread runs, the home thread is waiting in this file, free to serve its
// calls, and no library state is ever touched by two threads at once. It is also what makes a run
// reproducible under the deterministic clock: the interleaving is a function of the program's own
// calls, not of the host's scheduler. Two threads never run truly in parallel; what this gives a
// program is threads of control, which is what a 2004 engine's design needs (Doom 3's async thread,
// sys/linux/main.cpp: a loop that sleeps to the next 16 ms tick and runs common->Async()).
//
// THE CLOCK THREADS SLEEP ON is the home thread's guest clock: the real one under installRealClock,
// else the deterministic one gettimeofday advances. When every thread is blocked and the earliest
// wake-up is a deadline, the deterministic clock jumps to it -- time passes while everyone sleeps --
// and the real one is waited for.

import { Trap, ExitCalled, vaReader, guestMicros, setGuestMicros } from './runtime.js';
import { funcIndex, isFuncPtr } from '../link/module.js';

const HOME = 1, MAX_THREADS = 64;
// The control block's words (Int32Array S).
const RUN = 0,      // the tid allowed to run guest code; -1 once the program has ended
      EVENT = 1,    // bumped by a thread for every request and every hand-back; the home thread waits on it
      REQ = 2,      // 1 while a forwarded call waits to be served
      RESP = 3,     // 1 once it has been
      EXIT = 4, EXIT_CODE = 5, EXIT_QUICK = 6,
      NEXT_KEY = 7,
      KEY_DTORS = 1200, MAX_KEYS = 800;   // a key's destructor, by key, for every thread
// A thread's slot: SLOT + tid * SLOT_WORDS.
const SLOT = 64, SLOT_WORDS = 16;
const ST = 0, KIND = 1, A = 2, B = 3, C = 4, LOADED = 5, CANCEL = 6, RESULT = 7, DETACHED = 8, SIGNALED = 9,
      COUNT = 10, NOCANCEL = 11, STACK = 12;
// States
const FREE = 0, STARTING = 1, READY = 2, BLOCKED = 3, RUNNING = 4, DONE = 5, FAILED = 6;
// What a blocked thread waits for
const K_SLEEP_REL = 1, K_SLEEP = 2, K_MUTEX = 3, K_COND = 4, K_JOIN = 5, K_YIELD = 6;
// Byte offsets: deadlines (f64 per tid), the mailbox.
const DEADLINES = 8192, MAILBOX = 16384, MB_NAME = MAILBOX + 16, MB_TAGS = MAILBOX + 512, MB_VALS = MAILBOX + 8192,
      MB_TEXT = MAILBOX + 40960, MB_END = MAILBOX + 65536, MAX_TOKENS = 2048;
export const SCHED_BYTES = MB_END;

const EPERM = 1, ESRCH = 3, EAGAIN = 11, EINVAL = 22, EBUSY = 16, EDEADLK = 35, ETIMEDOUT = 110;
const PTHREAD_CANCELED = -1;
const NORMAL = 0, RECURSIVE = 1, ERRORCHECK = 2;
const DEFAULT_STACK = 1 << 20;

class ThreadExit { constructor(value) { this.value = value; } }
class ThreadKilled { }

/*
 * Values through the mailbox. A forwarded call's arguments are what emitted code passes a builtin:
 * numbers, BigInts (64-bit integers), arrays of them (a variadic tail some builtins take flat), and a
 * va_list reader (M.va), which travels as the address it reads from.
 */
function mailbox(sab) {
  const i32 = new Int32Array(sab), f64 = new Float64Array(sab), b64 = new BigInt64Array(sab), u8 = new Uint8Array(sab);
  let n = 0;
  const put = (tag, v) => {
    if (n >= MAX_TOKENS) throw new Trap('threads: a forwarded call has too many arguments');
    i32[MB_TAGS / 4 + n] = tag;
    if (tag === 1) b64[MB_VALS / 8 + n] = v; else f64[MB_VALS / 8 + n] = v;
    n++;
  };
  const enc = (v) => {
    if (typeof v === 'number') put(0, v);
    else if (typeof v === 'bigint') put(1, BigInt.asIntN(64, v));
    else if (v === undefined || v === null) put(2, 0);
    else if (typeof v === 'boolean') put(0, v ? 1 : 0);
    else if (Array.isArray(v)) { put(3, v.length); v.forEach(enc); }
    else if (typeof v === 'object' && typeof v.__va === 'number') put(4, v.__va);
    else throw new Trap(`threads: cannot forward a ${typeof v} argument`);
  };
  let at = 0;
  const dec = (M) => {
    const tag = i32[MB_TAGS / 4 + at];
    const v = tag === 1 ? b64[MB_VALS / 8 + at] : f64[MB_VALS / 8 + at];
    at++;
    if (tag === 0 || tag === 1) return v;
    if (tag === 2) return undefined;
    if (tag === 3) { const out = []; for (let k = 0; k < v; k++) out.push(dec(M)); return out; }
    if (tag === 4) return vaM(M, v);
    throw new Trap(`threads: a mailbox token of kind ${tag}`);
  };
  const text = (s) => {
    const bytes = new TextEncoder().encode(String(s)).subarray(0, MB_END - MB_TEXT - 8);
    i32[MB_TEXT / 4] = bytes.length; u8.set(bytes, MB_TEXT + 4);
  };
  const readText = () => new TextDecoder().decode(u8.slice(MB_TEXT + 4, MB_TEXT + 4 + i32[MB_TEXT / 4]));
  return {
    writeCall(name, args) {
      const bytes = new TextEncoder().encode(name);
      i32[MAILBOX / 4] = bytes.length; u8.set(bytes, MB_NAME);
      n = 0; enc(args);
    },
    readCall(M) {
      const name = new TextDecoder().decode(u8.slice(MB_NAME, MB_NAME + i32[MAILBOX / 4]));
      at = 0;
      return { name, args: dec(M) };
    },
    // kind: 0 a value, 1 exit (code, quick), 2 an error (text)
    writeResult(kind, v, extra = 0) { i32[MAILBOX / 4 + 1] = kind; n = 0; if (kind === 2) text(v); else { enc(v); i32[MAILBOX / 4 + 2] = extra; } },
    readResult(M) {
      const kind = i32[MAILBOX / 4 + 1];
      if (kind === 2) return { kind, text: readText() };
      at = 0;
      return { kind, value: dec(M), extra: i32[MAILBOX / 4 + 2] };
    },
    text, readText,
  };
}

/** A va_list reader that remembers its address, so it can be forwarded (see `enc`). */
function vaM(M, p) { return vaReader(M, p); }

/*
 * The pthread calls, over the shared control block and the program's memory, for whichever thread
 * calls them. `self` is that thread: its tid and how it blocks.
 *
 * A mutex is glibc's pthread_mutex_t as i386 lays it out: the owner's tid at 0 (0 when free), the
 * recursion count at 4 and the kind at 12 -- so PTHREAD_MUTEX_INITIALIZER, all zeros, is a free
 * normal mutex. A condition variable keeps a ticket counter at 0, which orders its waiters.
 */
function pthreadCalls(M, S, self) {
  const dv = () => M.mod.dv;
  const slot = (t) => SLOT + t * SLOT_WORDS;
  const owner = (m) => dv().getInt32(m, true);
  const kindOf = (m) => dv().getInt32(m + 12, true);
  const cancelPoint = () => {
    const s = slot(self.tid);
    if (self.tid !== HOME && Atomics.load(S, s + CANCEL) && !Atomics.load(S, s + NOCANCEL)) throw new ThreadExit(PTHREAD_CANCELED);
  };
  const block = (kind, a = 0, b = 0, c = 0) => {
    const s = slot(self.tid);
    S[s + KIND] = kind; S[s + A] = a; S[s + B] = b; S[s + C] = c; S[s + SIGNALED] = 0; S[s + RESULT] = 0;
    S[s + ST] = BLOCKED;
    self.block();
    return S[s + RESULT];
  };
  const lock = (m) => {
    const o = owner(m);
    if (o === 0) { dv().setInt32(m, self.tid, true); dv().setInt32(m + 4, 1, true); return 0; }
    if (o === self.tid) {
      const k = kindOf(m);
      if (k === RECURSIVE) { dv().setInt32(m + 4, dv().getInt32(m + 4, true) + 1, true); return 0; }
      if (k === ERRORCHECK) return EDEADLK;
      throw new Trap(`pthread_mutex_lock: thread ${self.tid} locks a normal mutex it already holds -- it would wait forever`);
    }
    block(K_MUTEX, m, 1);
    return 0;
  };
  const condWait = (c, m, deadline) => {
    if (owner(m) !== self.tid) return EPERM;
    const count = dv().getInt32(m + 4, true);
    dv().setInt32(m, 0, true); dv().setInt32(m + 4, 0, true);
    const ticket = (dv().getInt32(c, true) + 1) | 0;
    dv().setInt32(c, ticket, true);
    if (deadline !== null) new Float64Array(S.buffer)[DEADLINES / 8 + self.tid] = deadline;
    const r = block(K_COND, c, m, deadline !== null ? -ticket : ticket);
    // reacquired by the scheduler, at the depth it was held
    dv().setInt32(m + 4, count, true);
    cancelPoint();
    return r;
  };
  const wake = (c, all) => {
    let best = 0, bestTicket = Infinity;
    for (let t = 1; t < MAX_THREADS; t++) {
      const s = slot(t);
      if (S[s + ST] !== BLOCKED || S[s + KIND] !== K_COND || S[s + A] !== c || S[s + SIGNALED]) continue;
      if (all) { S[s + SIGNALED] = 1; continue; }
      const ticket = Math.abs(S[s + C]);
      if (ticket < bestTicket) { bestTicket = ticket; best = t; }
    }
    if (best) S[slot(best) + SIGNALED] = 1;
    return 0;
  };
  const keys = new Map();
  return {
    pthread_self: () => self.tid,
    pthread_equal: (a, b) => ((a >>> 0) === (b >>> 0) ? 1 : 0),
    pthread_attr_init: (attr) => { if (attr) M.u8.fill(0, attr, attr + 36); return 0; },
    pthread_attr_destroy: () => 0,
    pthread_attr_setdetachstate: (attr, st) => { dv().setInt32(attr, st, true); return 0; },
    pthread_attr_getdetachstate: (attr, out) => { dv().setInt32(out, dv().getInt32(attr, true), true); return 0; },
    pthread_attr_setstacksize: (attr, size) => { dv().setInt32(attr + 4, size, true); return 0; },
    pthread_mutexattr_init: (attr) => { dv().setInt32(attr, NORMAL, true); return 0; },
    pthread_mutexattr_destroy: () => 0,
    pthread_mutexattr_settype: (attr, type) => { if (type < 0 || type > 3) return EINVAL; dv().setInt32(attr, type, true); return 0; },
    pthread_mutex_init: (m, attr) => {
      M.u8.fill(0, m, m + 24);
      dv().setInt32(m + 12, attr ? dv().getInt32(attr, true) : NORMAL, true);
      return 0;
    },
    pthread_mutex_destroy: (m) => (owner(m) ? EBUSY : 0),
    pthread_mutex_lock: lock,
    pthread_mutex_trylock: (m) => {
      const o = owner(m);
      if (o === 0) { dv().setInt32(m, self.tid, true); dv().setInt32(m + 4, 1, true); return 0; }
      if (o === self.tid && kindOf(m) === RECURSIVE) { dv().setInt32(m + 4, dv().getInt32(m + 4, true) + 1, true); return 0; }
      return EBUSY;
    },
    pthread_mutex_unlock: (m) => {
      const o = owner(m), k = kindOf(m);
      if (o !== self.tid && k !== NORMAL) return EPERM;
      const n = dv().getInt32(m + 4, true);
      if (k === RECURSIVE && n > 1) { dv().setInt32(m + 4, n - 1, true); return 0; }
      dv().setInt32(m, 0, true); dv().setInt32(m + 4, 0, true);
      return 0;
    },
    pthread_cond_init: (c) => { M.u8.fill(0, c, c + 48); return 0; },
    pthread_cond_destroy: () => 0,
    pthread_cond_wait: (c, m) => condWait(c, m, null),
    pthread_cond_timedwait: (c, m, ts) => condWait(c, m, (dv().getInt32(ts, true) * 1e6 + dv().getInt32(ts + 4, true) / 1000)),
    pthread_cond_signal: (c) => wake(c, false),
    pthread_cond_broadcast: (c) => wake(c, true),
    pthread_join: (t, ret) => {
      t >>>= 0;
      if (t === self.tid) return EDEADLK;
      if (t < 1 || t >= MAX_THREADS || S[slot(t) + ST] === FREE) return ESRCH;
      if (S[slot(t) + ST] !== DONE) block(K_JOIN, t);
      if (ret) dv().setInt32(ret, S[slot(t) + RESULT], true);
      self.reap(t);
      return 0;
    },
    pthread_detach: (t) => {
      t >>>= 0;
      if (t < 1 || t >= MAX_THREADS || S[slot(t) + ST] === FREE) return ESRCH;
      S[slot(t) + DETACHED] = 1;
      if (S[slot(t) + ST] === DONE) self.reap(t);
      return 0;
    },
    pthread_cancel: (t) => {
      t >>>= 0;
      if (t < 1 || t >= MAX_THREADS || S[slot(t) + ST] === FREE) return ESRCH;
      S[slot(t) + CANCEL] = 1;
      return 0;
    },
    pthread_testcancel: () => { cancelPoint(); },
    pthread_setcancelstate: (st, old) => {
      const s = slot(self.tid);
      if (old) dv().setInt32(old, S[s + NOCANCEL], true);
      S[s + NOCANCEL] = st ? 1 : 0;
      return 0;
    },
    pthread_setcanceltype: (_type, old) => { if (old) dv().setInt32(old, 0, true); return 0; },
    pthread_exit: (v) => { throw new ThreadExit(v | 0); },
    pthread_key_create: (key, dtor) => {
      const k = Atomics.add(S, NEXT_KEY, 1) + 1;
      if (k >= MAX_KEYS) return EAGAIN;
      dv().setUint32(key, k, true);
      S[KEY_DTORS + k] = dtor | 0;
      return 0;
    },
    pthread_key_delete: (k) => { keys.delete(k >>> 0); return 0; },
    pthread_getspecific: (k) => keys.get(k >>> 0) ?? 0,
    pthread_setspecific: (k, v) => { keys.set(k >>> 0, v | 0); return 0; },
    pthread_once: (once, init) => {
      if (dv().getInt32(once, true) !== 0) return 0;
      dv().setInt32(once, 1, true);
      M.icall(init, []);
      return 0;
    },
    sched_yield: () => { self.yield(); return 0; },
    // the calls that SLEEP, for a thread other than the home one (installThreads gives the home thread its own)
    usleep: (us) => { cancelPoint(); new Float64Array(S.buffer)[DEADLINES / 8 + self.tid] = us >>> 0; block(K_SLEEP_REL); cancelPoint(); return 0; },
    sleep: (s) => { cancelPoint(); new Float64Array(S.buffer)[DEADLINES / 8 + self.tid] = (s >>> 0) * 1e6; block(K_SLEEP_REL); cancelPoint(); return 0; },
    nanosleep: (req, _rem) => {
      cancelPoint();
      new Float64Array(S.buffer)[DEADLINES / 8 + self.tid] = dv().getInt32(req, true) * 1e6 + dv().getInt32(req + 4, true) / 1000;
      block(K_SLEEP_REL); cancelPoint(); return 0;
    },
    __keys: keys,
  };
}

/* The pthread builtins' signatures, for an environment's `builtins`. */
export function pthreadBuiltins(T) {
  const I = T.INT, V = T.VOID, P = T.ptr(T.CHAR), U = T.UINT;
  const f = (ret, ...params) => ({ ret, params });
  return {
    pthread_create: f(I, P, P, P, P), pthread_join: f(I, U, P), pthread_detach: f(I, U), pthread_self: f(U),
    pthread_equal: f(I, U, U), pthread_exit: f(V, P), pthread_cancel: f(I, U), pthread_testcancel: f(V),
    pthread_setcancelstate: f(I, I, P), pthread_setcanceltype: f(I, I, P),
    pthread_attr_init: f(I, P), pthread_attr_destroy: f(I, P), pthread_attr_setdetachstate: f(I, P, I),
    pthread_attr_getdetachstate: f(I, P, P), pthread_attr_setstacksize: f(I, P, U),
    pthread_mutex_init: f(I, P, P), pthread_mutex_destroy: f(I, P), pthread_mutex_lock: f(I, P),
    pthread_mutex_trylock: f(I, P), pthread_mutex_unlock: f(I, P),
    pthread_mutexattr_init: f(I, P), pthread_mutexattr_destroy: f(I, P), pthread_mutexattr_settype: f(I, P, I),
    pthread_cond_init: f(I, P, P), pthread_cond_destroy: f(I, P), pthread_cond_wait: f(I, P, P),
    pthread_cond_timedwait: f(I, P, P, P), pthread_cond_signal: f(I, P), pthread_cond_broadcast: f(I, P),
    pthread_key_create: f(I, P, P), pthread_key_delete: f(I, U), pthread_getspecific: f(P, U),
    pthread_setspecific: f(I, U, P), pthread_once: f(I, P, P), sched_yield: f(I),
  };
}

/**
 * The home thread's side: the pthread calls, and the scheduler. `spawn(init)` is the host's: it starts
 * a worker that calls runThread(init) -- a Node worker_threads Worker, or in the page a Worker the PAGE
 * creates (a worker blocked in guest code cannot start one of its own). Without it pthread_create
 * fails with EAGAIN, as on a system out of threads, and says why.
 *
 * `image` is what a thread instantiates: { meta, src } (threadImage in compile.js).
 */
export function installThreads(M, { spawn = M.threadHost?.spawn ?? null, image = M.threadHost?.image ?? null, stackSize = DEFAULT_STACK } = {}) {
  // (a host may set M.threadHost = { spawn, image } before the environments install, instead of passing them)
  if (!(M.mod.buffer instanceof SharedArrayBuffer) && spawn) throw new Error('threads: the program must be compiled with shared memory');
  const sched = new SharedArrayBuffer(SCHED_BYTES);
  const S = new Int32Array(sched), D = new Float64Array(sched), mb = mailbox(sched);
  S[RUN] = HOME;
  const slot = (t) => SLOT + t * SLOT_WORDS;
  S[slot(HOME) + ST] = RUNNING;
  let live = 0, servicing = false, scheduling = false, rr = HOME;
  const workers = new Map();
  const stdSleep = { usleep: M.rt.usleep, sleep: M.rt.sleep, nanosleep: M.rt.nanosleep };

  const now = () => guestMicros(M);

  /* Serve the forwarded call waiting in the mailbox, as the home thread's own call. */
  function serve() {
    const { name, args } = mb.readCall(M);
    servicing = true;
    try {
      const fn = name === '__prism_icall' ? (p, a, t) => M.icall(p, a, t) : M.rt[name];
      if (typeof fn !== 'function') throw new Trap(`${name}: not a function of this program's library`);
      const v = fn(...args);
      mb.writeResult(0, typeof v === 'object' && v !== null && !Array.isArray(v) ? undefined : v);
    } catch (e) {
      if (e instanceof ExitCalled) mb.writeResult(1, e.code, e.quick ? 1 : 0);
      else mb.writeResult(2, `${name}: ${e?.message ?? e}`);
    } finally { servicing = false; }
    Atomics.store(S, REQ, 0);
    Atomics.store(S, RESP, 1);
    Atomics.notify(S, RESP);
  }

  /* Let thread t run until it hands control back, serving its calls meanwhile. */
  function runThread(t) {
    const s = slot(t);
    S[s + ST] = RUNNING;
    Atomics.store(S, RUN, t);
    Atomics.notify(S, RUN);
    for (;;) {
      const ev = Atomics.load(S, EVENT);
      if (Atomics.load(S, REQ)) { serve(); continue; }
      if (Atomics.load(S, RUN) === HOME) break;
      Atomics.wait(S, EVENT, ev, 100);
    }
    const st = S[s + ST];
    if (st === BLOCKED && S[s + KIND] === K_SLEEP_REL) { S[s + KIND] = K_SLEEP; D[DEADLINES / 8 + t] = now() + D[DEADLINES / 8 + t]; }
    if (st === FAILED) throw new Trap(`thread ${t}: ${mb.readText()}`);
    if (S[EXIT]) { const quick = !!S[EXIT_QUICK]; S[EXIT] = 0; throw new ExitCalled(S[EXIT_CODE], quick); }
    if (st === DONE && S[s + DETACHED]) reap(t);
  }

  /* Whether thread t can run now; a mutex it waits for is granted to it here. */
  function ready(t) {
    const s = slot(t), st = S[s + ST];
    if (st === READY) return true;
    if (st !== BLOCKED) return false;
    const dv = M.mod.dv;
    switch (S[s + KIND]) {
      case K_YIELD: return true;
      case K_SLEEP: return S[s + CANCEL] && t !== HOME ? true : now() >= D[DEADLINES / 8 + t];
      case K_JOIN: return S[slot(S[s + A]) + ST] === DONE;
      case K_COND: {
        const timed = S[s + C] < 0;
        if (!S[s + SIGNALED] && !(S[s + CANCEL] && t !== HOME) && !(timed && now() >= D[DEADLINES / 8 + t])) return false;
        S[s + RESULT] = S[s + SIGNALED] ? 0 : (S[s + CANCEL] ? 0 : ETIMEDOUT);
        S[s + KIND] = K_MUTEX; S[s + A] = S[s + B];
      }
      // falls through: the mutex is taken back before the wait returns
      case K_MUTEX: {
        const m = S[s + A];
        if (dv.getInt32(m, true) !== 0) return false;
        dv.setInt32(m, t, true); dv.setInt32(m + 4, 1, true);
        return true;
      }
    }
    return false;
  }

  /* The next thread other than home that can run, round robin. */
  function pick() {
    for (let k = 1; k < MAX_THREADS; k++) {
      const t = ((rr - 1 + k) % (MAX_THREADS - 1)) + 1;
      if (t !== HOME && ready(t)) { rr = t; return t; }
    }
    return 0;
  }

  /* The home thread blocks (its slot already says on what): run the others until it can go on. */
  function homeBlock() {
    if (servicing) throw new Trap('threads: a forwarded call would block the home thread');
    scheduling = true;
    try {
      for (;;) {
        if (ready(HOME)) { S[slot(HOME) + ST] = RUNNING; return; }
        const t = pick();
        if (t) { runThread(t); continue; }
        // nobody can run: the earliest deadline, if any
        let d = Infinity, starting = false;
        for (let u = 1; u < MAX_THREADS; u++) {
          const s = slot(u);
          if (S[s + ST] === STARTING) starting = true;
          if (S[s + ST] !== BLOCKED) continue;
          if (S[s + KIND] === K_SLEEP || (S[s + KIND] === K_COND && S[s + C] < 0)) d = Math.min(d, D[DEADLINES / 8 + u]);
        }
        if (d === Infinity) {
          if (starting) { Atomics.wait(S, EVENT, Atomics.load(S, EVENT), 50); continue; }
          throw new Trap('threads: deadlock -- every thread is waiting and nothing will wake one');
        }
        if (M.realClock) {
          const ms = (d - now()) / 1000;
          if (ms > 0) Atomics.wait(S, EVENT, Atomics.load(S, EVENT), Math.min(ms, 50));
        } else setGuestMicros(M, Math.max(now(), d));
      }
    } finally { scheduling = false; }
  }

  /* Run every other thread that can run now, once each. Called whenever the home thread asks the time. */
  function poll() {
    if (!live || servicing || scheduling) return;
    scheduling = true;
    try {
      for (let n = 0; n < MAX_THREADS; n++) { const t = pick(); if (!t) break; runThread(t); }
    } finally { scheduling = false; }
  }

  function reap(t) {
    const s = slot(t);
    if (S[s + ST] === FREE) return;
    const stack = S[s + STACK];
    if (stack) M.rt.free(stack);
    S.fill(0, s, s + SLOT_WORDS);
    workers.delete(t);
    live--;
  }

  const self = {
    tid: HOME,
    block: homeBlock,
    yield: () => poll(),
    reap,
  };
  const calls = pthreadCalls(M, S, self);
  delete calls.__keys;
  // The home thread's sleeps: as before while it is alone; with other threads, a wait they can run in.
  const homeSleep = (us, std) => {
    if (!live) return std();
    D[DEADLINES / 8 + HOME] = now() + us;
    const s = slot(HOME);
    S[s + KIND] = K_SLEEP; S[s + ST] = BLOCKED;
    homeBlock();
    return 0;
  };
  calls.usleep = (us) => homeSleep(us >>> 0, () => stdSleep.usleep?.(us) ?? 0);
  calls.sleep = (sec) => homeSleep((sec >>> 0) * 1e6, () => stdSleep.sleep?.(sec) ?? 0);
  calls.nanosleep = (req, rem) => homeSleep(M.mod.dv.getInt32(req, true) * 1e6 + M.mod.dv.getInt32(req + 4, true) / 1000,
    () => stdSleep.nanosleep?.(req, rem) ?? 0);

  calls.pthread_create = (out, attr, fn, arg) => {
    if (!spawn || !image) {
      M.threadRefusal = 'pthread_create: this host runs one thread (no spawn hook was given)';
      return EAGAIN;
    }
    let t = 0;
    for (let u = 2; u < MAX_THREADS; u++) if (S[slot(u) + ST] === FREE) { t = u; break; }
    if (!t) return EAGAIN;
    const dv = M.mod.dv;
    const size = attr && dv.getInt32(attr + 4, true) > 0 ? Math.max(dv.getInt32(attr + 4, true), 65536) : stackSize;
    const stack = M.rt.malloc(size);
    if (!stack) return EAGAIN;
    const s = slot(t);
    S.fill(0, s, s + SLOT_WORDS);
    S[s + ST] = STARTING; S[s + STACK] = stack;
    S[s + DETACHED] = attr ? (dv.getInt32(attr, true) === 1 ? 1 : 0) : 0;
    live++;
    workers.set(t, spawn({ ...image, buffer: M.mod.buffer, sched, tid: t, entry: fn | 0, arg: arg | 0,
                           stackBase: stack, stackTop: (stack + size - 16) & ~15 }));
    // Wait for it to be loaded, so that when it first runs is the program's doing, not the host's.
    const deadline = performance.now() + 60000;
    while (!Atomics.load(S, s + LOADED)) {
      if (Atomics.load(S, s + ST) === FAILED) throw new Trap(`thread ${t} failed to start: ${mb.readText()}`);
      if (performance.now() > deadline) throw new Trap(`thread ${t}: its worker did not start`);
      Atomics.wait(S, s + LOADED, 0, 100);
    }
    S[s + ST] = READY;
    dv.setUint32(out, t, true);
    return 0;
  };

  calls.__prism_thread_reap = (t) => { reap(t >>> 0); };
  Object.assign(M.rt, calls);
  M.pollThreads = poll;
  const api = {
    sched, calls,
    get live() { return live; },
    /* The program has ended: every worker still parked wakes and finishes. */
    shutdown() {
      Atomics.store(S, RUN, -1);
      Atomics.notify(S, RUN);
      for (const w of workers.values()) w?.unref?.();
    },
    workers,
  };
  M.threads = api;
  return api;
}

/*
 * Library calls a thread makes on its own machine rather than forwarding: the ones that only read and
 * write the program's memory (their answers cannot depend on which thread asks), and the ones that ARE
 * the calling thread -- its shadow stack (alloca), its setjmp/longjmp and C++ exception state.
 */
const LOCAL = new Set([
  'memcpy', 'memmove', 'memset', 'memcmp', 'memchr', 'strlen', 'strcmp', 'strncmp', 'strcpy', 'strncpy', 'strcat',
  'strncat', 'strchr', 'strrchr', 'strstr', 'strcasecmp', 'strncasecmp', 'stricmp', 'strnicmp', 'strspn', 'strcspn',
  'strpbrk', 'abs', 'labs', 'toupper', 'tolower', 'isalpha', 'isdigit', 'isalnum', 'isspace', 'isupper', 'islower',
  'isprint', 'ispunct', 'isxdigit', 'iscntrl', 'isgraph',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'pow', 'exp', 'log', 'log10', 'floor', 'ceil', 'fabs',
  'fmod', 'ldexp', 'frexp', 'modf', 'hypot', 'sinf', 'cosf', 'tanf', 'asinf', 'acosf', 'atanf', 'atan2f', 'sqrtf',
  'powf', 'expf', 'logf', 'log10f', 'floorf', 'ceilf', 'fabsf', 'fmodf',
  'alloca', '__prism_setjmp', 'longjmp', '_longjmp', 'siglongjmp', '__prism_va_next', '__prism_bf_get64', '__prism_bf_set64',
  '__prism_overflow', '__prism_eh_push', '__prism_eh_pop', '__prism_eh_obj', '__prism_eh_is', '__prism_cxx_throw',
  '__prism_cxx_throw_obj', '__prism_cxx_rethrow', '__prism_cxx_rethrow_from', '__builtin_expect',
]);

/**
 * A thread's worker: instantiate the program over the shared image (attach, from compile.js), make
 * every library call but the LOCAL ones a forwarder, and run the thread's start routine when the home
 * thread first lets it.
 */
export function runThread(init, attach) {
  const { sched, tid, entry, arg, stackBase, stackTop } = init;
  const S = new Int32Array(sched), mb = mailbox(sched);
  const s = SLOT + tid * SLOT_WORDS;
  const giveBack = () => { Atomics.store(S, RUN, HOME); Atomics.add(S, EVENT, 1); Atomics.notify(S, EVENT); };
  const waitRun = () => {
    for (;;) {
      const r = Atomics.load(S, RUN);
      if (r === tid) return;
      if (r < 0) throw new ThreadKilled();
      Atomics.wait(S, RUN, r, 1000);
    }
  };
  let M;
  const rpc = (name, args) => {
    Atomics.store(S, RESP, 0);
    mb.writeCall(name, args);
    Atomics.store(S, REQ, 1);
    Atomics.add(S, EVENT, 1);
    Atomics.notify(S, EVENT);
    while (Atomics.load(S, RESP) === 0) {
      if (Atomics.load(S, RUN) < 0) throw new ThreadKilled();
      Atomics.wait(S, RESP, 0, 1000);
    }
    const r = mb.readResult(M);
    if (r.kind === 1) throw new ExitCalled(r.value | 0, !!r.extra);
    if (r.kind === 2) throw new Trap(r.text);
    return r.value;
  };
  try {
    const prepare = (machine) => {
      M = machine;
      const local = M.rt;
      const forward = new Proxy({}, {
        get: (_t, name) => {
          if (typeof name !== 'string' || name === 'then') return undefined;
          const fn = (...a) => rpc(name, a);
          rt[name] = fn;
          return fn;
        },
      });
      const rt = Object.create(forward);
      for (const name of LOCAL) if (typeof local[name] === 'function') rt[name] = local[name];
      const self = {
        tid,
        block: () => { giveBack(); waitRun(); },
        yield: () => { S[s + KIND] = K_YIELD; S[s + ST] = BLOCKED; giveBack(); waitRun(); },
        reap: (t) => rpc('__prism_thread_reap', [t]),
      };
      const calls = pthreadCalls(M, S, self);
      const keys = calls.__keys; delete calls.__keys;
      Object.assign(rt, calls);
      M.rt = rt;
      M.va = (p) => vaM(M, p);
      // A function pointer this thread's table has no body for -- a library function bound after the
      // program loaded (dlsym's GL entry points) -- is called where it is bound.
      M.icallMissing = (p, a, packed) => rpc('__prism_icall', [p, a, packed]);
      M.spBudget = 1e9;
      M.sp_ = () => { M.spBudget = 1e9; };
      M.sp = stackTop;
      M.mod.stackLimit = stackBase;
      M.thread = { tid, keys };
    };
    attach(init, prepare);
  } catch (e) {
    mb.text(`could not instantiate the program: ${e?.stack ?? e}`);
    Atomics.store(S, s + ST, FAILED);
    Atomics.store(S, s + LOADED, 1);
    Atomics.notify(S, s + LOADED);
    return;
  }
  Atomics.store(S, s + LOADED, 1);
  Atomics.notify(S, s + LOADED);
  let result = 0;
  try {
    waitRun();
    if (!isFuncPtr(entry)) throw new Trap(`pthread_create: the start routine 0x${(entry >>> 0).toString(16)} is not a function`);
    const f = M.funcs[funcIndex(entry)];
    if (!f) throw new Trap('pthread_create: the start routine has no body');
    try { result = f(arg) | 0; } catch (e) { if (e instanceof ThreadExit) result = e.value; else throw e; }
    // thread-specific values with a destructor, as a thread's exit runs them
    for (const [k, v] of M.thread.keys) {
      const d = S[KEY_DTORS + k];
      if (v && d) M.icall(d, [v]);
    }
    S[s + RESULT] = result;
    S[s + ST] = DONE;
    giveBack();
  } catch (e) {
    if (e instanceof ThreadKilled) return;
    if (e instanceof ExitCalled) {
      S[EXIT_CODE] = e.code; S[EXIT_QUICK] = e.quick ? 1 : 0; S[EXIT] = 1;
      S[s + ST] = DONE;
    } else {
      mb.text(e?.stack ?? String(e));
      S[s + ST] = FAILED;
    }
    giveBack();
  }
}
