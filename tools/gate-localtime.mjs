// gate-localtime.mjs — the C library's clock: a fixed date and UTC by default, the visitor's when asked.
//
// time() answers a fixed date (1997-01-01) plus the program's own seconds, and local time is UTC, so
// every run is reproducible; the page instead sets M.wallClock, M.utcOffset and M.isDst
// (web/worker.js) so that a game's clock, a file's date or OpenTyrian's Christmas read the visitor's
// calendar. This holds both: by default time() is the fixed date and localtime equals gmtime; with
// the page's three, in Paris's zone, localtime is gmtime plus two hours and summer time in October,
// plus one hour without it in January, and mktime takes localtime's answer back to the same second.
//
// And it has to be able to fail: the same October check, with the zone left at UTC, must not pass.
//
//   node tools/gate-localtime.mjs
process.env.TZ = 'Europe/Paris';             // the page's zone is the browser's; here, one with summer time
import { Module } from '../src/link/module.js';
import { makeMachine } from '../src/runtime/runtime.js';
import { installStdio } from '../src/env/stdio.js';

const machine = (page) => {
  const M = makeMachine(new Module({ memory: 8 * 1024 * 1024 }));
  installStdio(M, {});
  if (page) {
    // As web/worker.js sets them, the wall clock aside (each case gives its own second).
    M.utcOffset = (s) => -new Date(s * 1000).getTimezoneOffset() * 60;
    M.isDst = (s) => {
      const y = new Date(s * 1000).getFullYear();
      const std = Math.max(new Date(y, 0, 1).getTimezoneOffset(), new Date(y, 6, 1).getTimezoneOffset());
      return new Date(s * 1000).getTimezoneOffset() < std;
    };
  }
  return M;
};
const fields = (M, tm) => Array.from({ length: 9 }, (_, i) => M.mod.dv.getInt32(tm + i * 4, true));
const at = (M, secs) => { const p = M.rt.malloc(4); M.mod.dv.setInt32(p, secs, true); return p; };
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++; };

{
  const M = machine(false), t = M.rt.time(0), p = at(M, t);
  check(t === 852076800, 'by default time() is the fixed date, 1997-01-01 00:00 UTC');
  check(JSON.stringify(fields(M, M.rt.localtime(p))) === JSON.stringify(fields(M, M.rt.gmtime(p))), 'by default localtime is gmtime');
}

/** Whether local time is `hours` ahead of UTC at `secs`, with that summer-time flag, and mktime inverts it. */
const zoned = (M, secs, hours, dst) => {
  M.wallClock = () => secs;
  const t = M.rt.time(0), p = at(M, t);
  const gm = fields(M, M.rt.gmtime(p)), tm = M.rt.localtime(p), loc = fields(M, tm);
  const copy = M.rt.malloc(36); M.u8.copyWithin(copy, tm, tm + 36);
  return t === secs && (loc[2] - gm[2] + 24) % 24 === hours && loc[8] === dst && M.rt.mktime(copy) === secs;
};
check(zoned(machine(true), 1760600000, 2, 1), "the page's clock, 2025-10-16 07:33 UTC: Paris 09:33, summer time, and mktime gives the second back");
check(zoned(machine(true), 1767225600, 1, 0), "the page's clock, 2026-01-01 00:00 UTC: Paris 01:00, no summer time, and mktime gives the second back");
check(!zoned(machine(false), 1760600000, 2, 1), 'control: with the zone left at UTC, the October check does not pass');

console.log(bad ? `\n${bad} check(s) failed` : '\nthe clock is fixed and UTC by default, the visitor\'s when the page asks');
process.exit(bad ? 1 : 0);
