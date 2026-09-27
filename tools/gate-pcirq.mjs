// gate-pcirq.mjs — hardware interrupts under a 16-bit model (src/env/pcirq.js), held to the rules of
// the hardware rather than to an emulator: PRISM's time is its own model (back edges), so no DOSBox
// run can be compared cycle for cycle, but what an 8086, an 8259, an 8253 and a VGA guarantee can be.
//
// tests/pcirq/irq.c prints one number per property; each has a value the hardware fixes:
//   the BIOS's int 8 advances 0040:006C; a handler runs while IF is set and not while it is clear,
//   and a request held under CLI is delivered on STI; without an EOI the PIC delivers once; an
//   `interrupt` function starts with the interrupted code's CX; scancodes reach int 9 in order;
//   vertical retrace comes 70 times a second; with IRQ0 and IRQ1 both pending, IRQ0 goes first.
//
//   node tools/gate-pcirq.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const keen = JSON.parse(readFileSync(join(ROOT, 'targets', 'keendreams.json'), 'utf8'));
const WANT = [
  ['bios tick advanced 1', 'the BIOS int 8 advances 0040:006C'],
  ['counting 1', 'IRQ0 reaches the program\'s handler at the rate it programmed'],
  ['held while disabled 1', 'nothing is delivered while IF is clear'],
  ['pending one delivered on enable 1', 'the request held under CLI is delivered on STI'],
  ['without EOI 1', 'a handler that never acknowledges is entered once'],
  ['interrupted cx matches 1', 'an interrupt function starts with the interrupted CX'],
  ['keys 3 1e 9e 30', 'scancodes reach int 9 in order through port 60h'],
  [/^retraces in a second 7[01]$/, 'vertical retrace at 70 Hz: 70 in a second (71 by phase)'],
  ['priority 0 1', 'with IRQ0 and IRQ1 both pending, IRQ0 is served first'],
];

let out;
try {
  const { program } = buildTarget({ name: 'pcirq', dir: join(ROOT, 'tests', 'pcirq'), units: { list: ['irq.c'] },
    env: ['stdio', 'borland', 'dos', 'pcirq'], compile: { ...keen.compile, ppSizeof: null, safepoints: true } },
  { root: ROOT, envExtra: { pcirq: { keys: [{ ms: 2000, scan: 0x1e }, { ms: 2010, scan: 0x9e }, { ms: 2020, scan: 0x30 }, { ms: 5000, scan: 0x10 }] } } });
  if (program.failures.length) throw new Error(program.failures.map((f) => `${f.fn}: ${f.message}`).join('; '));
  program.M.leashDeadline = performance.now() + 60000;
  out = program.run(['IRQ.EXE']).stdout.trim().split('\n');
} catch (e) { out = [`threw: ${e.message}`]; }

let bad = 0;
WANT.forEach(([want, what], k) => {
  const got = out[k] ?? '(nothing)';
  const ok = typeof want === 'string' ? got === want : want.test(got);
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${ok ? '' : `got [${got}]`}`);
});
console.log(bad ? `\n${bad} WRONG` : '\ninterrupts arrive as the PC delivers them.');
process.exit(bad ? 1 : 0);
