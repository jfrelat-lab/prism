// gate-memmap.mjs — the per-platform page map: does an address land where the map says?
//
// No external oracle, and the reason is the same as gate-ports': there is no PC memory map on the
// container's host to diff against. What can be checked is the contract the emitted code will
// depend on, and the checks below are the ones a device actually needs.
//
// THE ASYMMETRIC CASES ARE THE POINT. A single table would pass every symmetric check here and be
// quietly wrong on the first planar VGA: a read comes from the plane in Read Map Select while a
// write goes to the planes in Map Mask, so the same address has two answers. The 'r'-only and
// 'w'-only redirects are what separate a map that can serve mode X from one that cannot.
import { installMemMap } from '../src/env/memmap.js';

const MB = 1 << 20;
const VGA = 0xa0000, VGA_LEN = 0x20000;      // the window, 32 pages of 4 kB
const PLANES = 0x800000;                     // where a device would keep its bytes

const checks = [];
const check = (what, got, want) => checks.push([what, got === want ? null
  : `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`]);
/*
 * A refusal has to be refused FOR THE RIGHT REASON. An earlier version of this helper accepted any
 * throw at all, which would have passed on a typo, on a missing function, on a TypeError from
 * reading a property of undefined -- a check that cannot fail. The expected wording is required.
 */
const refuses = (what, saying, fn) => {
  try { fn(); checks.push([what, 'it was ACCEPTED, so nothing is being refused']); }
  catch (e) {
    checks.push([what, String(e.message).includes(saying) ? null
      : `it threw, but for another reason: ${e.message}`]);
  }
};

const fresh = () => installMemMap({ u8: new Uint8Array(16 * MB) }, {});

// --- identity. Also the control for everything below: if this did not hold, a later "it moved"
// check could pass against a map that was broken from the start rather than redirected.
{
  const m = fresh();
  check('a fresh map is the identity, for reads', m.translateRead(VGA + 123), VGA + 123);
  check('a fresh map is the identity, for writes', m.translateWrite(VGA + 123), VGA + 123);
  check('and away from any window too', m.translateRead(0x123456), 0x123456);
}

// --- a plain redirect moves both.
{
  const m = fresh();
  m.redirect(VGA, VGA_LEN, PLANES, { who: 'vga' });
  check('rw redirect moves reads', m.translateRead(VGA + 123), PLANES + 123);
  check('rw redirect moves writes', m.translateWrite(VGA + 123), PLANES + 123);
  check('a page further along keeps its offset', m.translateRead(VGA + 0x1000 + 7), PLANES + 0x1000 + 7);
  check('memory outside the range is untouched', m.translateRead(0x123456), 0x123456);
}

// --- THE ASYMMETRY: reads from one plane, writes to another, at the SAME address.
{
  const m = fresh();
  m.redirect(VGA, VGA_LEN, PLANES + 0x10000, { how: 'r', who: 'vga' });   // Read Map Select = plane 1
  m.redirect(VGA, VGA_LEN, PLANES + 0x20000, { how: 'w', who: 'vga' });   // Map Mask = plane 2
  check('a read comes from the read plane', m.translateRead(VGA + 5), PLANES + 0x10005);
  check('a write goes to the write plane', m.translateWrite(VGA + 5), PLANES + 0x20005);
  check('and they really differ', m.translateRead(VGA + 5) !== m.translateWrite(VGA + 5), true);
}

// --- moving the read plane, which is what the guest's assembly does four times per blit.
{
  const m = fresh();
  for (const plane of [0, 1, 2, 3]) {
    m.redirect(VGA, VGA_LEN, PLANES + plane * 0x10000, { how: 'r', who: 'vga' });
    check(`read plane ${plane} lands in its own bank`, m.translateRead(VGA), PLANES + plane * 0x10000);
  }
}

// --- and giving the window back.
{
  const m = fresh();
  m.redirect(VGA, VGA_LEN, PLANES, { who: 'vga' });
  check('claimed', m.claims().length, VGA_LEN >> 12);
  m.identity(VGA, VGA_LEN);
  check('identity() restores reads', m.translateRead(VGA + 123), VGA + 123);
  check('identity() restores writes', m.translateWrite(VGA + 123), VGA + 123);
  check('and releases the claim', m.claims().length, 0);
}

/*
 * --- BLOCK WRITES, which is the question a translation cannot answer on its own.
 *
 * `from` is the part of the source block a destination takes, and it carries the distinction that
 * makes this mechanism correct: a page split gives each destination a SUCCESSIVE slice, while a
 * device's fan-out gives every destination the SAME bytes. A version without it wrote slice 0
 * everywhere -- right for planes, silently wrong for pages.
 */
{
  const m = fresh();
  const plain = m.writeSpans(0x123000, 100);
  check('an unclaimed range is one span, itself', JSON.stringify(plain),
    JSON.stringify([{ to: 0x123000, from: 0, len: 100 }]));

  m.redirect(VGA, VGA_LEN, PLANES, { who: 'vga' });
  const one = m.writeSpans(VGA + 16, 64);
  check('a claimed range inside one page is one translated span', JSON.stringify(one),
    JSON.stringify([{ to: PLANES + 16, from: 0, len: 64 }]));

  // A write that straddles a page boundary: two spans, and the second takes the LATER bytes.
  const two = m.writeSpans(VGA + 0x1000 - 8, 16);
  check('a straddling write splits at the page', two.length, 2);
  check('  the first span takes the first bytes', JSON.stringify(two[0]),
    JSON.stringify({ to: PLANES + 0x1000 - 8, from: 0, len: 8 }));
  check('  the second span takes the rest', JSON.stringify(two[1]),
    JSON.stringify({ to: PLANES + 0x1000, from: 8, len: 8 }));
}

// --- what it REFUSES, which is as much of the contract as what it does.
{
  const m = fresh();
  refuses('a misaligned start is refused', 'page-aligned', () => m.redirect(VGA + 1, VGA_LEN, PLANES));
  refuses('a misaligned length is refused', 'page-aligned', () => m.redirect(VGA, 100, PLANES));
  refuses('a range outside the image is refused', 'outside the guest image', () => m.redirect(0xff000000, 0x1000, PLANES));
  m.redirect(VGA, VGA_LEN, PLANES, { who: 'vga' });
  refuses('a second device claiming the same page is refused', 'already held by',
    () => m.redirect(VGA, 0x1000, PLANES, { who: 'vesa' }));
  check('the same device may re-point its own pages', (() => {
    m.redirect(VGA, 0x1000, PLANES + 0x30000, { who: 'vga' });
    return m.translateRead(VGA);
  })(), PLANES + 0x30000);
  refuses('a multi-plane byte write is refused, not approximated', 'cannot be expressed',
    () => m.multiWrite(0x0f, VGA));
}

let bad = 0;
for (const [what, err] of checks) {
  if (err) { console.log(`  ✗ ${what}: ${err}`); bad++; }
  else console.log(`  ✓ ${what}`);
}
console.log(bad
  ? `\ngate-memmap: ${bad} of ${checks.length} checks failed`
  : `\nthe page map translates, refuses and releases as a device needs: ${checks.length}/${checks.length}`);
process.exit(bad ? 1 : 0);
