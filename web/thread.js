// thread.js — one POSIX thread of the program running in worker.js (src/runtime/threads.js).
//
// The page starts it when the program's worker asks (a 'thread' message), and hands it what that
// worker sent: the shared memory, the scheduler's control block, and the program's code -- its emitted
// source, or the URL of the static bundle it was loaded from.
import { runThread } from '../src/runtime/threads.js';
import { attachThread } from '../src/compile.js';

self.onmessage = async (e) => {
  const init = e.data;
  if (init.module) init.factory = (await import(init.module)).factory;
  runThread(init, attachThread);
  self.close();
};
