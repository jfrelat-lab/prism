// gate-ports.mjs — the I/O port seam, and the first device on it.
//
// This one cannot be diffed against gcc, and the reason is worth stating rather than hiding: there is
// no oracle for it. `pc.h` and the PC's I/O space do not exist on the Linux host the container runs,
// so there is nothing to compare against. What CAN be checked is the device's own contract, and the
// checks below are the ones a DOS program actually depends on:
//
//   * a polled clock moves forward and never backwards — a program that spins on it must make progress
//   * counter 0 honours a reload, because games reprogram the timer for their own rate
//   * an unclaimed port floats high, because that is what a program probing for absent hardware sees
//   * the BIOS tick at 0x46C tracks the counter, because Quake reads BOTH and cross-checks them
//
// The program under test is DJGPP code. Nothing in it is PRISM-specific.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SRC = `
#include <stdio.h>
#include <pc.h>

#define BDA_TICKS (*(volatile unsigned short *)0x46c)

static double pit_time(void)
{
    unsigned t, tick;
    int r;
    t = BDA_TICKS * 65536;
    outportb(0x43, 0);
    r = inportb(0x40);
    r |= inportb(0x40) << 8;
    r = (r - 1) & 0xffff;
    tick = BDA_TICKS * 65536;
    if ((tick != t) && (r & 0x8000)) t = tick;
    return (double)(t + (65536 - r)) / 1193200.0;
}

int main(void)
{
    double last, now;
    int i, forward = 0, backward = 0, lo, hi, c;
    unsigned short tick_before, tick_after;

    last = pit_time();
    for (i = 0; i < 2000; i++) {
        now = pit_time();
        if (now > last) forward++;
        else if (now < last) backward++;
        last = now;
    }
    printf("forward %d backward %d\\n", forward, backward);

    outportb(0x43, 0x34);
    outportb(0x40, 0x00);
    outportb(0x40, 0x10);
    outportb(0x43, 0);
    lo = inportb(0x40);
    hi = inportb(0x40);
    c = lo | (hi << 8);
    printf("reload %d\\n", c <= 0x1000);

    printf("floating %d\\n", (inportb(0x1234) & 0xff) == 0xff);

    tick_before = BDA_TICKS;
    for (i = 0; i < 200000; i++) (void)pit_time();
    tick_after = BDA_TICKS;
    printf("tick %d\\n", tick_after != tick_before);
    return 0;
}
`;

const prog = compileProgram([{ file: 'ports.c', source: SRC }], { resolve: builtinHeaderResolver() });
const out = prog.run(['ports']).stdout;

const value = (key) => {
  const m = out.match(new RegExp(`^${key} (.*)$`, 'm'));
  return m ? m[1] : null;
};

const checks = [
  ['a polled clock always moves forward', value('forward') === '2000 backward 0'
    ? null : `got "${value('forward')}", wanted "2000 backward 0"`],
  ['counter 0 honours its reload', value('reload') === '1' ? null : 'the counter read outside the new range'],
  ['an unclaimed port floats high', value('floating') === '1' ? null : 'a port with no device did not read 0xff'],
  ['the BIOS tick at 0x46C advances', value('tick') === '1' ? null : 'the tick count never changed'],
];

let bad = 0;
for (const [what, err] of checks) {
  if (err) { console.log(`  ✗ ${what}: ${err}`); bad++; }
  else console.log(`  ✓ ${what}`);
}

console.log(bad
  ? `\ngate-ports: ${bad} of ${checks.length} checks failed`
  : `\nthe I/O port seam holds: ${checks.length}/${checks.length}, with the PIT as its first device`);
process.exit(bad ? 1 : 0);
