// threads-node.mjs — POSIX threads for a program run under Node (src/runtime/threads.js).
//
// As the main module's import: `nodeSpawn`, the spawn hook the `pthread` environment takes. As a
// worker's script (what nodeSpawn starts): one thread of the program, over its shared memory.
//
//   buildEnv(program.M, ['stdio', 'pthread'], { pthread: { spawn: nodeSpawn, image: threadImage(program) } })

import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { runThread } from '../src/runtime/threads.js';
import { attachThread } from '../src/compile.js';

/** Start one thread's worker. unref'd: a thread left parked must not keep the process alive. */
export function nodeSpawn(init) {
  const w = new Worker(new URL(import.meta.url), { workerData: init });
  w.unref();
  w.on('error', (e) => { process.stderr.write(`thread ${init.tid}: worker error: ${e?.stack ?? e}\n`); });
  return w;
}

// After the module has finished evaluating, not during it: the thread blocks for its whole life, and a
// worker terminated inside an unfinished (async) module evaluation aborts Node (a V8 check).
if (!isMainThread && workerData?.sched) setImmediate(() => runThread(workerData, attachThread));
