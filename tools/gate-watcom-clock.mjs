// gate-watcom-clock.mjs — clock() as Watcom's DOS libc gives it, held to Open Watcom running under DOSBox-X.
//
// A program built with Watcom for DOS reads clock() in milliseconds (CLOCKS_PER_SEC 1000) that move
// in BIOS-tick lumps of ~55 ms. OpenDUNE's timers are built on it, and a finer clock ran its intro
// at 0.59x the real binary's time (gate-dune-pixels). So PRISM's Watcom toolchain must say the same
// two things: the constant, through its own <time.h> under __WATCOMC__, and the sequence of values,
// through src/env/watcom.js's watcomClock. The oracle is Open Watcom's libc itself: a program that
// prints CLOCKS_PER_SEC and the first twelve distinct values clock() returns, built in the oracle
// container and run under DOSBox-X (tools/oracle.mjs watcomRun16).
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';
import { watcomClock } from '../src/env/watcom.js';
import { watcomRun16 } from './oracle.mjs';

const SOURCE = `#include <stdio.h>
#include <time.h>
int main(void) {
  clock_t last = clock(), c; int n = 0;
  printf("%ld %ld\\n", (long)CLOCKS_PER_SEC, (long)last);
  while (n < 12) { c = clock(); if (c != last) { printf("%ld ", (long)c); last = c; n++; } }
  printf("\\n");
  return 0;
}
`;
let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${detail}`); };

const out = watcomRun16(SOURCE, { timeout: 30 }).stdout.trim().split('\n');
const [perSec, start] = out[0].split(' ').map(Number);
const values = (out[1] ?? '').trim().split(/\s+/).map(Number);
report(values.length === 12, 'Watcom printed twelve clock() values', `${values.length}`);

// PRISM's constant, through its own headers, as a program sees it.
const constant = (defines) => {
  const p = compileProgram([{ file: "c.c", source: "#include <stdio.h>\n#include <time.h>\nint main(void) { printf(\"%ld\", (long)CLOCKS_PER_SEC); return 0; }\n" }],
    { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, defines });
  let out = "";
  const w = p.M.write.bind(p.M);
  p.M.write = (t) => { out += t; return w(t); };
  p.run(["c"]);
  p.M.flushAll?.();
  return Number(out);
};
const mine = constant({ __WATCOMC__: '1100' });
report(mine === perSec, 'CLOCKS_PER_SEC under __WATCOMC__', `prism ${mine}  watcom ${perSec}`);
report(constant({}) === 1000000, "and still glibc's without it", `${constant({})}`);

// The values. Watcom's clock() is the time of day in ms, taken from the BIOS tick, minus the same at
// start-up, so its first step depends on where in a tick the program started (54 on one run, 55 on
// another). PRISM's clock starts at a tick boundary. The claim: with PRISM's own tick-to-ms map g,
// there is a start tick s for which Watcom printed g(s+n) - g(s) -- the same clock, another phase.
report(start === 0 && watcomClock(0) === 0, 'it starts at 0', `watcom ${start}`);
const TICK_US = 65536 / 1193182 * 1e6;
const g = (ticks) => watcomClock(ticks * TICK_US + 1);
let phase = -1;
for (let s = 0; s < 1573040 && phase < 0; s++) if (values.every((v, i) => g(s + i + 1) - g(s) === v)) phase = s;
report(phase >= 0, "the twelve values are PRISM's tick-to-ms map at some start tick",
  phase >= 0 ? `start tick ${phase}: ${values.join(' ')}` : `watcom ${values.join(' ')}`);
// And the control that the search can fail: a clock that stepped every 50 ms is no such sequence.
const fifty = values.map((_, i) => 50 * (i + 1));
let fake = -1;
for (let s = 0; s < 1573040 && fake < 0; s++) if (fifty.every((v, i) => g(s + i + 1) - g(s) === v)) fake = s;
report(fake < 0, 'control: a 50 ms clock is not one of them', fake < 0 ? 'no start tick fits' : `start tick ${fake} fits`);
report(watcomClock(1.5 * TICK_US) === watcomClock(TICK_US + 1), 'and it does not move between ticks', `${watcomClock(1.5 * TICK_US)}`);
console.log(bad ? `\n${bad} WRONG` : "\nclock() under the Watcom toolchain is Watcom's.");
process.exit(bad ? 1 : 0);
