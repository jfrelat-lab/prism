// gate-planar.mjs — the VGA plane registers, checked against what two real programs write.
//
// Like gate-ports, this has NO external oracle and says so: the PC's I/O space does not exist on the
// container's host, so there is nothing to diff against. What can be checked is that the decoder
// reads the exact bytes two period programs emit and reaches the state each of them intends -- and
// those bytes are transcribed from their sources, not invented for the test:
//
//   MAME 0.5 src/msdos/msdos.c   { 0x3c4, 0x04, 0x0e }     index-then-data, Chain-4 SET
//   Jump 'n Bump dos/gfx.c       outportw(0x3c4, 0x0604)   one word, index low, Chain-4 CLEAR
//
// That is the whole point of the file: the two differ in one bit, and everything about whether an
// address means a pixel or a quarter of four pixels hangs on it.
//
// THE CONTROLS MATTER MORE THAN THE CHECKS. A decoder that ignored the word form would leave the
// state at its reset value and every "is it linear" check would still pass, because linear IS the
// reset value. So the run also asserts the transitions in both directions, and a deliberately wrong
// decoder is exercised at the end to prove the checks can fail at all.
import { installPorts } from '../src/env/ports.js';
import { installVgaPlanar } from '../src/env/vgaplanar.js';
import { installMemMap } from '../src/env/memmap.js';

/** A bare machine: no guest, no memory to speak of, just the port seam these devices plug into. */
function machine() {
  const M = { u8: new Uint8Array(16), mod: { dv: new DataView(new ArrayBuffer(16)) }, rt: {} };
  const m = installPorts(M, {});
  return { m, vga: installVgaPlanar(m) };
}

const checks = [];
const check = (what, got, want) => checks.push([what, got === want ? null
  : `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`]);

// --- reset state. Linear, all planes writable: what a program inherits from BIOS mode 13h.
{
  const { vga } = machine();
  check('a fresh adapter is chained (linear, mode 13h)', vga.chained, true);
  check('a fresh adapter writes every plane', vga.mapMask, 0x0f);
}

// --- MAME's tweaked mode: index then data, Chain-4 left SET. Linear, so PRISM may keep ignoring it.
{
  const { m, vga } = machine();
  m.write(0x3c4, 1, 0x04);
  m.write(0x3c5, 1, 0x0e);
  check("MAME's 0x0e leaves the adapter chained", vga.chained, true);
}

// --- Jump 'n Bump: ONE word write, index in the low byte. Chain-4 clear, so planar.
{
  const { m, vga } = machine();
  m.write(0x3c4, 2, 0x0604);
  check("Jump 'n Bump's 0x0604 unchains the adapter", vga.chained, false);

  m.write(0x3c4, 2, 0x0f02);                 // Map Mask = all four planes, before clearing 64 kB
  check('Map Mask takes all four planes', vga.mapMask, 0x0f);

  // Read Map Select, the single `out` in the game's own assembly: dx=0x3ce, al=4, ah=plane.
  for (const plane of [0, 1, 2, 3]) {
    m.write(0x3ce, 2, (plane << 8) | 0x04);
    check(`Read Map Select answers plane ${plane}`, vga.readPlane, plane);
  }
}

// --- the transition BACK, so the check is not just reading a reset value that never moved.
{
  const { m, vga } = machine();
  m.write(0x3c4, 2, 0x0604);
  check('unchained after the word write', vga.chained, false);
  m.write(0x3c4, 1, 0x04);
  m.write(0x3c5, 1, 0x0e);
  check('chained again through the byte pair', vga.chained, true);
}

/*
 * --- THE WIRING, which is the half the decoder alone cannot demonstrate. A register write has to
 * reach the page map and move where an address lands, and these check the address rather than the
 * register: the register state was already proved above, and a state that nothing reads is not a
 * mechanism.
 */
{
  const PLANES = 0x800000, W = 0xa0000;
  const M = { u8: new Uint8Array(16 << 20), mod: { dv: new DataView(new ArrayBuffer(16)) }, rt: {} };
  const m = installPorts(M, {});
  const map = installMemMap(M, {});
  const vga = installVgaPlanar(m, { map, planes: PLANES });

  check('chained, the window is plain memory', map.translateRead(W + 5), W + 5);

  m.write(0x3c4, 2, 0x0604);                           // unchain, as the game does
  m.write(0x3ce, 2, (2 << 8) | 0x04);                  // Read Map Select = plane 2
  m.write(0x3c4, 2, (0x04 << 8) | 0x02);               // Map Mask = plane 2 only
  check('a read comes from the selected plane', map.translateRead(W + 5), PLANES + 2 * 0x10000 + 5);
  check('a write goes to the masked plane', map.translateWrite(W + 5), PLANES + 2 * 0x10000 + 5);

  m.write(0x3c4, 2, (0x08 << 8) | 0x02);               // Map Mask = plane 3, read plane unchanged
  check('the write plane moves alone', map.translateWrite(W + 5), PLANES + 3 * 0x10000 + 5);
  check('and the read plane stays put', map.translateRead(W + 5), PLANES + 2 * 0x10000 + 5);

  // The case a table cannot express: four planes at once. Contained and counted, not approximated.
  m.write(0x3c4, 2, (0x0f << 8) | 0x02);
  check('a multi-plane mask is recorded as unexpressible', vga.unexpressible, 0x0f);
  check('and its writes go to a scratch bank nobody displays',
    map.translateWrite(W + 5), PLANES + 4 * 0x10000 + 5);

  /*
   * AND THE BLOCK WRITE THE TABLE CANNOT EXPRESS. This is the game's own clear: Map Mask 0x0f,
   * then memset of 64 kB. A translation gives one destination; a fan-out gives four, each taking
   * the SAME bytes -- which is what `from: 0` on every span says.
   */
  const spans = map.writeSpans(W, 0x10000);
  check('a multi-plane clear fans out to four planes', spans.length, 4);
  check('  each plane takes the same bytes', spans.every(s => s.from === 0), true);
  check('  and they land in four different banks',
    new Set(spans.map(s => s.to)).size, 4);

  m.write(0x3c4, 2, (0x02 << 8) | 0x02);               // Map Mask = plane 1 alone
  const one = map.writeSpans(W, 0x1000);
  check('a single-plane mask is one span', one.length, 1);
  check('  in that plane', one[0].to, PLANES + 1 * 0x10000);

  m.write(0x3c4, 2, 0x0e04);                           // Chain-4 back on
  check('chained again gives the window back', map.translateWrite(W + 5), W + 5);
  check('and a block write is plain memory again', map.writeSpans(W, 64)[0].to, W);
}

/*
 * THE POSITIVE CONTROL. Every check above passes against a decoder that handles only the byte pair
 * and drops the word form -- because linear is also the reset state, so "MAME leaves it chained"
 * would be true by accident. This drives that broken decoder and requires it to FAIL.
 */
{
  const { m } = machine();
  const broken = { chained: true };
  let idx = 0;
  m.onPortWrite(0x3c4, (p, size, v) => { idx = v & 0xff; });          // word form ignored, deliberately
  m.onPortWrite(0x3c5, (p, size, v) => {
    if (idx === 4) broken.chained = (v & 0x08) !== 0;
  });
  m.write(0x3c4, 2, 0x0604);
  checks.push(['the control fires: a decoder blind to the word form is caught',
    broken.chained === true ? null : 'the broken decoder unchained anyway, so this proves nothing']);
}

let bad = 0;
for (const [what, err] of checks) {
  if (err) { console.log(`  ✗ ${what}: ${err}`); bad++; }
  else console.log(`  ✓ ${what}`);
}
console.log(bad
  ? `\ngate-planar: ${bad} of ${checks.length} checks failed`
  : `\nthe plane registers decode as both programs write them: ${checks.length}/${checks.length}`);
process.exit(bad ? 1 : 0);
