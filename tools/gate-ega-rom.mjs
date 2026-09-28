// gate-ega-rom.mjs — the colours of PRISM's EGA, held to a REAL VGA BIOS setting the modes up.
//
// gate-keen-pixels holds Keen's screens to the shipped binary under DOSBox-X, but DOSBox-X is one
// lineage: its video BIOS and its EGA model are the same code. This gate asks a second one.
// SeaVGABIOS (QEMU's pc-bios/vgabios-stdvga.bin) is loaded at C000:0 on MIRAGE's machine, POSTs, and
// its own INT 10h code sets each mode, writing the attribute palette and the DAC through MIRAGE's
// device model. A colour on that card is DAC[attribute value]. PRISM does not model a DAC: it keeps
// the attribute palette and reads the value as the EGA's monitor would (egaRgb for 350 lines,
// ega200Rgb -- IRGB, brown -- for 200). A VGA BIOS loads, for each mode, the DAC table that makes a
// VGA show what an EGA showed, so the two must agree:
//
//   1. after a mode set, PRISM's attribute palette is the ROM's, entry for entry;
//   2. every one of the 64 values a program may write into an attribute register shows, in PRISM,
//      the colour the ROM's DAC gives it (each channel in the EGA's four levels) -- Keen writes
//      18h-1Fh itself, so the 16 defaults alone would prove little.
//
// Two positive controls run with it and must DIFFER from the ROM, or the gate is red: the 64-colour
// reading applied to a 200-line mode, and the 350-line palette loaded for one. Those are the two
// defects gate-keen-pixels found on its first run.
//
// MIRAGE and the ROM are outside this repository; without them the gate SKIPS.
//   PRISM_MIRAGE   the MIRAGE checkout (default ~/Projects/mirage)
//   PRISM_VGA_ROM  the ROM (default $PRISM_MIRAGE/boot/vgabios-stdvga.bin)
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { skip } from './gate-skip.mjs';
import { installEga, egaRgb, ega200Rgb } from '../src/env/ega.js';

const MIRAGE = process.env.PRISM_MIRAGE ?? join(process.env.HOME ?? '', 'Projects', 'mirage');
const ROM = process.env.PRISM_VGA_ROM ?? join(MIRAGE, 'boot', 'vgabios-stdvga.bin');
const HARNESS = join(MIRAGE, 'tools', 'harness.mjs');
if (!existsSync(HARNESS)) skip(`MIRAGE's machine at ${MIRAGE}`, 'set PRISM_MIRAGE to a MIRAGE checkout');
if (!existsSync(ROM)) skip(`a VGA BIOS at ${ROM}`, 'QEMU ships it as pc-bios/vgabios-stdvga.bin; set PRISM_VGA_ROM');
const { makeMachine } = await import(pathToFileURL(HARNESS).href);
const rom = new Uint8Array(readFileSync(ROM));

const MODES = [0x0d, 0x0e, 0x10, 0x12];
const is200 = (m) => m === 0x0d || m === 0x0e;

function until(mc) {
  let n = 0;
  while (!mc.cpu.halted && n < 20_000_000) n += mc.runSlice(10000);
  if (!mc.cpu.halted) throw new Error('the ROM did not return');
}
// POST enters an option ROM by a far call to C000:0003; it returns to a HLT at 0:7C00.
function romModeSet(mode) {
  const { mc } = makeMachine({ dos: false });
  const cpu = mc.cpu;
  mc.mem.blit(0xc0000, rom);
  mc.mem.w8(0x7c00, 0xf4);
  cpu.reg.fill(0); cpu.setSeg(2, 0x9000); cpu.sp = 0xfff0; cpu.setSeg(3, 0); cpu.setSeg(0, 0);
  cpu.flags = 0x0202; cpu.push16(0); cpu.push16(0x7c00);
  cpu.setSeg(1, 0xc000); cpu.eip = 3; cpu.halted = false;
  until(mc);
  if (mc.getVector(0x10).seg !== 0xc000) throw new Error('the ROM did not take INT 10h');
  mc.mem.blit(0x50000, Uint8Array.from([0xb8, mode, 0x00, 0xcd, 0x10, 0xf4]));   // mov ax,mode; int 10h; hlt
  cpu.reg.fill(0); cpu.setSeg(2, 0x9000); cpu.sp = 0xfff0;
  cpu.setSeg(1, 0x5000); cpu.eip = 0; cpu.flags = 0x0202; cpu.halted = false;
  until(mc);
  return { attr: [...mc.vga.palette], dac: (v) => [0, 1, 2].map((k) => mc.bios.dac[(v & 0x3f) * 3 + k]) };
}
function prismAttr(mode) {
  const ega = installEga({ machine: { onPortWrite() {}, onPortRead() {} } });
  ega.setMode(mode);
  return [...ega.attr.slice(0, 16)];
}

const fromDac = (c) => c.map((v) => Math.round(v / 21)).join('');   // 6-bit DAC -> 0..3
const fromByte = (c) => c.map((v) => Math.round(v / 85)).join('');  // 00/55/AA/FF -> 0..3
const colourDiffs = (ref, rgb) => {
  const d = [];
  for (let v = 0; v < 64; v++) if (fromDac(ref.dac(v)) !== fromByte(rgb(v))) d.push(v);
  return d;
};
const hx = (v) => v.toString(16).padStart(2, '0');

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${detail}`); };
for (const mode of MODES) {
  const ref = romModeSet(mode);
  const attr = prismAttr(mode);
  const pd = attr.map((a, i) => (a === ref.attr[i] ? null : `[${i}] ${hx(a)} want ${hx(ref.attr[i])}`)).filter(Boolean);
  report(!pd.length, `mode ${hx(mode)}h: the attribute palette a mode set loads`, pd.length ? pd.slice(0, 4).join('  ') : '16 of 16');
  const rgb = is200(mode) ? ega200Rgb : egaRgb;
  const cd = colourDiffs(ref, rgb);
  report(!cd.length, `mode ${hx(mode)}h: all 64 attribute values show the ROM's colour`,
    cd.length ? `${cd.length} differ: ${cd.slice(0, 6).map((v) => `${hx(v)} ${fromByte(rgb(v))} want ${fromDac(ref.dac(v))}`).join('  ')}` : '64 of 64');
  if (is200(mode)) {
    const red1 = colourDiffs(ref, egaRgb).length;
    report(red1 > 0, `  control: the 64-colour reading here must differ`, `${red1} differ`);
    const other = prismAttr(0x10);
    const red2 = other.filter((a, i) => a !== ref.attr[i]).length;
    report(red2 > 0, `  control: the 350-line palette here must differ`, `${red2} differ`);
  }
}
console.log(bad ? `\n${bad} WRONG` : '\nevery EGA colour PRISM shows is the one a real VGA BIOS sets up.');
process.exit(bad ? 1 : 0);
