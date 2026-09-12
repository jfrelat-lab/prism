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
  /*
   * The alternative: TRANSLATE the address instead of branching on it.
   *
   *     D.setUint8(XLAT[a >>> 12] + (a & 4095), v)
   *
   * For plain RAM the entry is the identity (p << 12), so the byte written is the same byte as
   * today; for the video window it points at the plane the current Map Mask or Read Map Select
   * selects, and the mapper rewrites 32 entries when a register changes. No branch and no call, so
   * the fast path keeps a shape V8 can inline -- which is what the guarded form loses.
   *
   * It cannot express every case: a write with Map Mask 0x0f touches four planes at once and one
   * address cannot mean four. That needs a fallback. Whether the fallback is worth its complexity
   * is exactly what these two cases decide.
   */
  'store-xlat': { what: 'store  translated, all RAM', device: false, kind: 'store', xlat: true },
  'load-xlat': { what: 'load   translated, all RAM', device: false, kind: 'load', xlat: true },
  'store-xlat-device': { what: 'store  translated, 0xA0000 redirected', device: true, kind: 'store', xlat: true },
};

function runCase(name) {
  const c = CASES[name];
  const D = new DataView(new ArrayBuffer(HEAP));
  const PAGE = new Uint8Array(HEAP >>> PAGE_SHIFT);
  let calls = 0;
  const mmio = (a, v) => { calls++; D.setUint8(a, v); };
  const mmioRead = (a) => { calls++; return D.getUint8(a); };
  /*
   * The translation table starts as the identity, which is what makes the RAM case a fair
   * comparison: the translated store writes the SAME byte the direct one does, so any difference is
   * the table lookup and nothing else.
   */
  const XLAT = new Int32Array(HEAP >>> PAGE_SHIFT);
  for (let p = 0; p < XLAT.length; p++) XLAT[p] = p << PAGE_SHIFT;
  const PLANES = 0x800000;                   // where the redirected window lands, 8 MB in

  if (c.device) {
    for (let p = 0xa0000 >>> PAGE_SHIFT; p < (0xc0000 >>> PAGE_SHIFT); p++) {
      PAGE[p] = 1;
      XLAT[p] = PLANES + ((p - (0xa0000 >>> PAGE_SHIFT)) << PAGE_SHIFT);
    }
  }

  // Four separate function objects, so no case can inherit another's feedback even in one process.
  const fns = {
    'store-direct': (n) => { let a = 0; for (let i = 0; i < n; i++) { a = (a + STRIDE) & (HEAP - 1); D.setUint8(a, i & 0xff); } return a; },
    'store-guarded': (n) => { let a = 0; for (let i = 0; i < n; i++) { a = (a + STRIDE) & (HEAP - 1); if (PAGE[a >>> PAGE_SHIFT]) mmio(a, i & 0xff); else D.setUint8(a, i & 0xff); } return a; },
    'load-direct': (n) => { let s = 0, a = 0; for (let i = 0; i < n; i++) { a = (a + STRIDE) & (HEAP - 1); s += D.getUint8(a); } return s; },
    'load-guarded': (n) => { let s = 0, a = 0; for (let i = 0; i < n; i++) { a = (a + STRIDE) & (HEAP - 1); s += PAGE[a >>> PAGE_SHIFT] ? mmioRead(a) : D.getUint8(a); } return s; },
    'store-xlat': (n) => { let a = 0; for (let i = 0; i < n; i++) { a = (a + STRIDE) & (HEAP - 1); D.setUint8(XLAT[a >>> PAGE_SHIFT] + (a & 4095), i & 0xff); } return a; },
    'load-xlat': (n) => { let s = 0, a = 0; for (let i = 0; i < n; i++) { a = (a + STRIDE) & (HEAP - 1); s += D.getUint8(XLAT[a >>> PAGE_SHIFT] + (a & 4095)); } return s; },
  };
  const fn = fns[name === 'store-trapping' ? 'store-guarded'
    : name === 'store-xlat-device' ? 'store-xlat' : name];

  fn(ITERS / 10);                                          // warm-up, thrown away
  const warm = calls;
  let best = Infinity;
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    fn(ITERS);
    const ms = performance.now() - t0;
    if (ms < best) best = ms;
  }
  /*
   * THE CONTROL FOR A TRANSLATED RUN. There is no handler to count here, so "did the mechanism do
   * anything" has to be asked differently: write a marker through the translated form at an address
   * inside the video window, and check the byte landed at the TRANSLATED place and not at the raw
   * one. Without this, a table left as the identity would time beautifully and redirect nothing.
   */
  let redirected = null;
  if (c.xlat && c.device) {
    const a = 0xa0000 + 123;
    const to = XLAT[a >>> PAGE_SHIFT] + (a & 4095);
    D.setUint8(a, 0);
    D.setUint8(to, 0xa5);
    redirected = D.getUint8(to) === 0xa5 && D.getUint8(a) !== 0xa5 && to !== a;
  }

  // Machine-readable, because a parent process is reading it.
  console.log(JSON.stringify({ name, ms: best, nsPer: (best * 1e6) / ITERS, calls: calls - warm, redirected }));
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
  const note = CASES[name].xlat
    ? (v.redirected === null ? '' : v.redirected ? '   redirect verified' : '   REDIRECTED NOTHING')
    : (CASES[name].device ? `   ${v.calls.toLocaleString()} handler calls` : '');
  console.log(`  ${CASES[name].what.padEnd(38)} ${v.ms.toFixed(0).padStart(6)} ms   ` +
    `${v.nsPer.toFixed(2)} ns/access${note}`);
}

const pct = (a, b) => `${(((a / b) - 1) * 100).toFixed(1)}%`;
console.log(`\nguard cost on plain RAM:   stores ${pct(got['store-guarded'].ms, got['store-direct'].ms)}` +
  `   loads ${pct(got['load-guarded'].ms, got['load-direct'].ms)}`);
console.log(`with the video window live: stores ${pct(got['store-trapping'].ms, got['store-direct'].ms)}` +
  `  (${(got['store-trapping'].calls / ITERS * 100).toFixed(2)}% of accesses trapped)`);
console.log(`translated instead:        stores ${pct(got['store-xlat'].ms, got['store-direct'].ms)}` +
  `   loads ${pct(got['load-xlat'].ms, got['load-direct'].ms)}` +
  `   redirecting ${pct(got['store-xlat-device'].ms, got['store-direct'].ms)}`);

const live = got['store-trapping'].calls > 0;
console.log(live
  ? '\nThe trapping case really trapped, so these describe a guard that exists.'
  : '\nZERO handler calls: the guard was never taken and these numbers prove nothing.');
console.log('Measures the emitted SHAPE, not a guest. What it costs a GAME needs the feature and a real target.');
process.exit(live ? 0 : 1);
