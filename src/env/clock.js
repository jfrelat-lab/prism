// clock.js — the one clock an SDL guest reads and writes.
//
// `SDL_GetTicks` and `SDL_Delay` are two views of a single clock, and treating them as unrelated is
// what made OpenTyrian look eight times slower than it is. Its frame limiter is built on sleeping:
//
//     while (true) { handleSdlEvents(); delay = getFrameCountTicks();
//                    if (delay == 0) return; SDL_Delay(MIN(delay, SDL_POLL_INTERVAL)); }
//
// With `SDL_Delay` stubbed to nothing -- deliberately, under the rule that a headless guest must not
// sleep because the host paces it -- that loop does not wait, it SPINS. Measured over 200 frames it
// ran 487 million times and took 96% of the wall clock, while the game's own work came to 1.1 s.
// The stub was not wrong about pacing; it was wrong that a limiter can be left without an answer.
//
// So the host supplies the clock, and there are two honest answers:
//
//   virtualClock  — headless. Time is what the guest asked for: a delay advances it and returns at
//                   once. A run takes the guest's real work and is reproducible, which is what the
//                   harness has been claiming in its "deterministic clock" note all along.
//   sleepingClock — interactive. Time is real and a delay really waits, on whatever `sleep` the host
//                   gives it. In the browser worker that is `Atomics.wait`, the same channel
//                   makePacer naps on, so one notify from the page releases every kind of wait.

/**
 * Time the guest asked for, and nothing else.
 *
 * `now()` also advances, by a fraction of a millisecond per call. That is not cosmetic: a guest whose
 * limiter polls `SDL_GetTicks` WITHOUT ever calling `SDL_Delay` would otherwise wait on a deadline
 * that can never arrive, turning a slow run into a hung one. The step depends only on how many times
 * the guest has asked, so the run stays reproducible; at a handful of calls per frame it is worth
 * microseconds, and it is a spinning guest -- the one that needs rescuing -- that moves time at all.
 */
export function virtualClock() {
  let t = 0;
  return {
    virtual: true,
    now: () => (t += 1 / 1024) | 0,
    delay: (ms) => { if (ms > 0) t += ms; },
  };
}

/** Real time, and a delay that really waits. `sleep(ms)` blocks the caller. */
export function sleepingClock(sleep) {
  const t0 = performance.now();
  return {
    virtual: false,
    now: () => (performance.now() - t0) | 0,
    delay: (ms) => { if (ms > 0) sleep(ms); },
  };
}

/** Real time and no waiting: the previous behaviour, for a host that paces the guest itself. */
export function freeRunningClock() {
  return sleepingClock(() => {});
}
