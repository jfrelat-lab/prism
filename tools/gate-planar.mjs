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

// --- four planes of 64 kB, which is the adapter this decoder is describing.
{
  const { vga } = machine();
  check('four planes', vga.planes.length, 4);
  check('64 kB each', vga.planes[0].length, 0x10000);
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
