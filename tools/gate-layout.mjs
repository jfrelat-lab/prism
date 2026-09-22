// gate-layout.mjs — where things sit in memory, per ABI model.
//
// The i386 numbers below are TRANSCRIBED FROM THE MAP THAT WAS THERE BEFORE the layouts were named,
// which is the only way this checks anything: read off the new table, it would agree with whatever
// the table said.
//
// dos16 is the small model, so the whole address space a program can name is 64K and every region
// has to fit inside it. The case that matters most is the last one: running out must be a REFUSAL
// THAT SAYS SO. A 2-byte pointer handed an address above 0xFFFF would wrap, and a wrapped pointer is
// a wrong answer that reads and writes real memory belonging to something else.
import { Module, LAYOUTS, LOW_MEMORY } from '../src/link/module.js';

const MB = 1024 * 1024;
let bad = 0;
const check = (what, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(40)} ${got}${ok ? '' : `  (want ${want})`}`);
};

// --- i386, as it was.
const i = new Module({ memory: 16 * MB });
check('i386 image is the memory asked for', i.size, 16 * MB);
check('i386 statics start above the low megabyte', i.brk, LOW_MEMORY);
check('i386 low megabyte is 0x100000', LOW_MEMORY, 0x100000);
check('i386 stack is 1 MB', i.stackTop - i.stackLimit, 16 * MB - 16 - (16 * MB - MB));
check('i386 stack top is memory - 16', i.stackTop, 16 * MB - 16);
check('i386 string gap is 64K', LAYOUTS.i386.stringGap, 64 * 1024);

// --- dos16, the small model.
const d = new Module({ memory: 16 * MB, model: 'dos16' });
check('dos16 ignores a larger request', d.size, 0x10000);
check('dos16 statics start low', d.brk, 0x100);
check('dos16 stack top fits in 16 bits', d.stackTop, 0x10000 - 16);
check('dos16 stack is 4K', d.stackTop - d.stackLimit, 0x10000 - 16 - (0x10000 - 4096));
check('dos16 string gap is 2K', LAYOUTS.dos16.stringGap, 2 * 1024);
check('every dos16 address fits in 16 bits', d.stackTop < 0x10000 && d.size <= 0x10000, true);

// --- running out says which space ran out, rather than wrapping.
{
  const m = new Module({ model: 'dos16' });
  let msg = '(allocated)';
  try { for (let n = 0; n < 200; n++) m.alloc(1024, 1); } catch (e) { msg = e.message; }
  const ok = msg.includes('static storage exhausted') && msg.includes('65536');
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${'dos16 overflow is named'.padEnd(40)} ${msg.slice(0, 62)}`);
}
{
  let msg = '(built)';
  try { new Module({ model: 'pdp11' }); } catch (e) { msg = e.message; }
  const ok = msg.includes("unknown ABI model");
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${'an unknown model raises'.padEnd(40)} ${msg.slice(0, 62)}`);
}

const total = 12 + 2;
console.log(bad ? `\n${bad} of ${total} WRONG`
  : `\nthe memory image is laid out per model, and running out is named: ${total}/${total}`);
process.exit(bad ? 1 : 0);
