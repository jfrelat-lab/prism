// gate-typemodel.mjs — the ABI model is a value, and the module still hands out i386.
//
// abi.js has held both tables for a long time; types.js bound i386 at module scope and fixed a
// pointer at 4 bytes, so nothing could ask for the other one. makeTypes() is the seam, and this
// gate holds the two halves of what that must mean:
//
//   dos16 really is a second ABI, not a narrower one -- int and pointer are 2 bytes, and an enum is
//   ONE byte, which is the rule that cannot be guessed from the widths;
//   and asking the module for a type still gives i386, because 262 call sites across 15 files have
//   not been threaded yet and must not change under them.
//
// What this does NOT do is check layout: gate-abi16 already holds ~4,970 of those against Open
// Watcom, and duplicating them here would be a second opinion from the same source. This is the
// seam only.
import { makeTypes, INT, ptr, LONG, enumType } from '../src/sema/types.js';

const i386 = makeTypes('i386');
const dos16 = makeTypes('dos16');
const eq = (got, want) => got === want;

const cases = [
  ['dos16 int is 2 bytes', dos16.INT.size, 2],
  ['dos16 pointer is 2 bytes', dos16.ptr(dos16.INT).size, 2],
  ['dos16 enum is ONE byte', dos16.enumType('e', []).size, 1],
  ['dos16 long is still 4', dos16.LONG.size, 4],
  ['dos16 has no long long', dos16.LLONG, undefined],
  ['i386 int is 4 bytes', i386.INT.size, 4],
  ['i386 pointer is 4 bytes', i386.ptr(i386.INT).size, 4],
  ['i386 enum is 4 bytes', i386.enumType('e', []).size, 4],
  ['the module export is i386: int', INT.size, 4],
  ['the module export is i386: pointer', ptr(INT).size, 4],
  ['the module export is i386: long', LONG.size, 4],
  ['the module export is i386: enum', enumType('e', []).size, 4],
];

let bad = 0;
for (const [what, got, want] of cases) {
  const ok = eq(got, want);
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(36)} ${got}${ok ? '' : `  (want ${want})`}`);
}

// Two things that must RAISE rather than quietly answer.
for (const [what, fn] of [
  ['dos16 scalar("long long")', () => dos16.scalar('long long')],
  ['an unknown model', () => makeTypes('pdp11')],
]) {
  let raised = null;
  try { fn(); } catch (e) { raised = e.message; }
  const ok = raised !== null;
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(36)} ${raised ?? 'ANSWERED, and should not have'}`);
}

const total = cases.length + 2;
console.log(bad ? `\n${bad} of ${total} WRONG`
  : `\nthe ABI model is a value, and the module still hands out i386: ${total}/${total}`);
process.exit(bad ? 1 : 0);
