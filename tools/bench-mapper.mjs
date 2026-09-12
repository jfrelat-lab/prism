// bench-mapper.mjs — what does a paged memory map COST per access?
//
// The question before the feature: the whole argument for a page table is that it is nearly free,
// and "nearly free" is a claim, so it is measured before anything is built on it.
//
// What is measured is the two EMISSION FORMS, in the shape src/backend/emit.js actually emits:
//
//   direct     D.setUint8(a, v)                                     -- what every target emits today
//   guarded    if (PAGE[a >>> 12]) mmio(a, v); else D.setUint8(a, v) -- what a DOS target would emit
//
// ONE CASE PER PROCESS, and that is not fussiness. The first version of this file ran every case in
// one process and produced a contradiction: the case that does MORE work -- 1.6 million handler
// calls on top of the same stores -- came out 2.5x FASTER than the same guard with no traffic. A
// guard cannot be cheaper for doing more, so the numbers were describing V8's optimisation state
// rather than the code: the early cases teach it that PAGE[...] is always zero, it speculates on
// that, and a later case that falsifies it forces a deoptimisation and a recompile. Whatever those
// figures were, they were not the cost of a guard. A fresh process per case is the only way to ask
// each one the same question.
//
// The other three things this has to get right, all of them mistakes already made here:
//
//  * WARM-UP. A first timing on a cold JIT is worthless -- an earlier measurement in this project
//    reported 257 where the true figure was four times that. Each case discards a warm-up round.
//  * A DEAD BRANCH IS NOT A MEASUREMENT. With no access ever reaching a device page the engine may
//    prove the call unreachable and delete it, and the result would be a guard that costs nothing
//    because it is not there. The trapping case asserts the handler was CALLED.
//  * ADDRESSES MUST NOT BE A RAMP. A sequential sweep is the friendliest case for both the cache and
//    the branch predictor. These walk an odd stride larger than a page.
//
// It measures JavaScript in the emitted shape, not a compiled guest: it answers what a guard costs
// per access, NOT what it costs Jump 'n Bump. That second question needs the feature and a real
// target, and this one decides whether it is worth building at all.
//
//   node tools/bench-mapper.mjs              run every case, each in its own process
//   node tools/bench-mapper.mjs --case=NAME  run one case (used by the driver above)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HEAP = 1 << 24;                       // 16 MB, the order every target here uses
const PAGE_SHIFT = 12;                      // 4 kB, so the 0xA0000-0xBFFFF window is 32 pages
const ITERS = 40_000_000;
const ROUNDS = 5;
const STRIDE = 4099;                        // odd and larger than a page: every access a new page

const CASES = {
  'store-direct': { what: 'store  direct  D.setUint8', device: false, kind: 'store', guard: false },
  'store-guarded': { what: 'store  guarded, all RAM', device: false, kind: 'store', guard: true },
  'store-trapping': { what: 'store  guarded, 0xA0000 is a device', device: true, kind: 'store', guard: true },
  'load-direct': { what: 'load   direct  D.getUint8', device: false, kind: 'load', guard: false },
  'load-guarded': { what: 'load   guarded, all RAM', device: false, kind: 'load', guard: true },
};

function runCase(name) {
  const c = CASES[name];
  const D = new DataView(new ArrayBuffer(HEAP));
  const PAGE = new Uint8Array(HEAP >>> PAGE_SHIFT);
  let calls = 0;
  const mmio = (a, v) => { calls++; D.setUint8(a, v); };
  const mmioRead = (a) => { calls++; return D.getUint8(a); };
  if (c.device) {
    for (let p = 0xa0000 >>> PAGE_SHIFT; p < (0xc0000 >>> PAGE_SHIFT); p++) PAGE[p] = 1;
  }

  // Four separate function objects, so no case can inherit another's feedback even in one process.
  const fns = {
    'store-direct': (n) => { let a = 0; for (let i = 0; i < n; i++) { a = (a + STRIDE) & (HEAP - 1); D.setUint8(a, i & 0xff); } return a; },
    'store-guarded': (n) => { let a = 0; for (let i = 0; i < n; i++) { a = (a + STRIDE) & (HEAP - 1); if (PAGE[a >>> PAGE_SHIFT]) mmio(a, i & 0xff); else D.setUint8(a, i & 0xff); } return a; },
    'load-direct': (n) => { let s = 0, a = 0; for (let i = 0; i < n; i++) { a = (a + STRIDE) & (HEAP - 1); s += D.getUint8(a); } return s; },
    'load-guarded': (n) => { let s = 0, a = 0; for (let i = 0; i < n; i++) { a = (a + STRIDE) & (HEAP - 1); s += PAGE[a >>> PAGE_SHIFT] ? mmioRead(a) : D.getUint8(a); } return s; },
  };
  const fn = fns[name === 'store-trapping' ? 'store-guarded' : name];

  fn(ITERS / 10);                                          // warm-up, thrown away
  const warm = calls;
  let best = Infinity;
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    fn(ITERS);
    const ms = performance.now() - t0;
    if (ms < best) best = ms;
  }
  // Machine-readable, because a parent process is reading it.
  console.log(JSON.stringify({ name, ms: best, nsPer: (best * 1e6) / ITERS, calls: calls - warm }));
}

const only = process.argv.find(a => a.startsWith('--case='))?.slice(7);
if (only) { runCase(only); process.exit(0); }

const self = fileURLToPath(import.meta.url);
console.log(`${(ITERS / 1e6).toFixed(0)}M accesses per case, best of ${ROUNDS} after a warm-up round,\n` +
  `EACH CASE IN ITS OWN PROCESS so no case inherits another's optimisation state.\n`);

const got = {};
for (const name of Object.keys(CASES)) {
  const r = spawnSync(process.execPath, [self, `--case=${name}`], { encoding: 'utf8' });
  const line = (r.stdout ?? '').trim().split('\n').pop();
  const v = JSON.parse(line);
  got[name] = v;
  console.log(`  ${CASES[name].what.padEnd(38)} ${v.ms.toFixed(0).padStart(6)} ms   ` +
    `${v.nsPer.toFixed(2)} ns/access` + (CASES[name].device ? `   ${v.calls.toLocaleString()} handler calls` : ''));
}

const pct = (a, b) => `${(((a / b) - 1) * 100).toFixed(1)}%`;
console.log(`\nguard cost on plain RAM:   stores ${pct(got['store-guarded'].ms, got['store-direct'].ms)}` +
  `   loads ${pct(got['load-guarded'].ms, got['load-direct'].ms)}`);
console.log(`with the video window live: stores ${pct(got['store-trapping'].ms, got['store-direct'].ms)}` +
  `  (${(got['store-trapping'].calls / ITERS * 100).toFixed(2)}% of accesses trapped)`);

const live = got['store-trapping'].calls > 0;
console.log(live
  ? '\nThe trapping case really trapped, so these describe a guard that exists.'
  : '\nZERO handler calls: the guard was never taken and these numbers prove nothing.');
console.log('Measures the emitted SHAPE, not a guest. What it costs a GAME needs the feature and a real target.');
process.exit(live ? 0 : 1);
