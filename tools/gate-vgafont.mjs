// gate-vgafont.mjs — the Win32 shim rasterises text, and these are the pixels.
//
//   node tools/gate-vgafont.mjs [--png=/tmp/font.png]
//
// PuTTY cannot demonstrate this yet: with no network it reports "Host does not exist" and exits
// before its message loop, so it never repaints. What CAN be checked is the whole path the font
// takes -- assets/vga-rom-8x16.bin, interned into guest memory by src/env/vgafont.js, read by
// src/env/win32-gui.c's glyph loop, written into the surface it allocates. Every step of that is the
// platform layer's, and calling ExtTextOutW is how a program reaches it.
//
// The check is not "some pixels changed". A glyph is compared AGAINST THE ROM BYTES it came from,
// bit for bit, so a font that loaded at the wrong offset or a rasteriser that mirrored a row fails
// here rather than looking plausible.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { writeIndexedPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pngPath = process.argv.find(a => a.startsWith('--png='))?.slice(6) ?? null;

const { program } = buildTarget(loadTarget(join(ROOT, 'targets/putty.json'), 'tel'), { root: ROOT });
const M = program.M, dv = program.mod.dv;
const sym = (n) => program.mod.symbols.get(n)?.addr ?? 0;
const i32 = (n) => (sym(n) ? dv.getInt32(sym(n), true) : 0);
const set32 = (n, v) => dv.setInt32(sym(n), v, true);

let bad = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) bad++; };

console.log('the font');
const fontAt = i32('prism_vga_font');
check(fontAt !== 0, `prism_vga_font is bound (${fontAt})`);
const rom = new Uint8Array(readFileSync(join(ROOT, 'assets/vga-rom-8x16.bin'))).subarray(0, 4096);
let same = true;
for (let i = 0; i < 4096; i++) if (M.u8[fontAt + i] !== rom[i]) { same = false; break; }
check(same, '4096 bytes in guest memory match the ROM file');

/* A window to draw in. win32.c keeps the rectangle; the shim sizes its surface from it. */
set32('prism_win32_w', 8 * 40);
set32('prism_win32_h', 16 * 3);

const TEXT = 'PRISM/PuTTY 0123 abc';
const buf = program.mod.alloc(2 * (TEXT.length + 1), 2);
for (let i = 0; i < TEXT.length; i++) dv.setUint16(buf + i * 2, TEXT.charCodeAt(i), true);
dv.setUint16(buf + TEXT.length * 2, 0, true);

program.F.SetTextColor(0, 0x00FFFFFF);      /* COLORREF is 0x00bbggrr, so this is white */
program.F.SetBkColor(0, 0x00000000);
program.F.ExtTextOutW(0, 0, 0, 0, 0, buf, TEXT.length, 0);

console.log('\nthe surface');
const at = i32('prism_gdi_surface'), w = i32('prism_gdi_w'), h = i32('prism_gdi_h');
const pitch = i32('prism_gdi_pitch');
check(at !== 0, `allocated (${w}x${h}, pitch ${pitch})`);
check(w === 320 && h === 48, 'sized from the window rectangle, not guessed');
check(i32('prism_gdi_draws') === TEXT.length, `${i32('prism_gdi_draws')} glyph cells drawn for ${TEXT.length} characters`);

/*
 * Every glyph, bit for bit against the ROM. This is the check that means something: it fails if the
 * font is offset by one character, if a row is upside down, or if the leftmost pixel is the low bit.
 */
console.log('\nthe glyphs, against the ROM bytes');
let wrong = null;
outer:
for (let i = 0; i < TEXT.length; i++) {
  const code = TEXT.charCodeAt(i);
  for (let row = 0; row < 16; row++) {
    const bits = rom[code * 16 + row];
    for (let col = 0; col < 8; col++) {
      const p = at + row * pitch + (i * 8 + col) * 4;
      const lit = M.u8[p] !== 0 || M.u8[p + 1] !== 0 || M.u8[p + 2] !== 0;
      if (lit !== !!(bits & (0x80 >> col))) { wrong = `'${TEXT[i]}' row ${row} col ${col}`; break outer; }
    }
  }
}
check(wrong === null, wrong ? `first mismatch at ${wrong}` : `all ${TEXT.length} glyphs match the ROM exactly`);

/* And the box-drawing map, which is the one part that is a decision rather than a copy. */
const BOX = '┌─┐│└┘';
const bbuf = program.mod.alloc(2 * BOX.length, 2);
for (let i = 0; i < BOX.length; i++) dv.setUint16(bbuf + i * 2, BOX.charCodeAt(i), true);
program.F.ExtTextOutW(0, 0, 16, 0, 0, bbuf, BOX.length, 0);
const cp437 = [0xDA, 0xC4, 0xBF, 0xB3, 0xC0, 0xD9];
let boxOk = true;
for (let i = 0; i < BOX.length && boxOk; i++) {
  for (let row = 0; row < 16 && boxOk; row++) {
    const bits = rom[cp437[i] * 16 + row];
    for (let col = 0; col < 8; col++) {
      const p = at + (16 + row) * pitch + (i * 8 + col) * 4;
      const lit = M.u8[p] !== 0 || M.u8[p + 1] !== 0 || M.u8[p + 2] !== 0;
      if (lit !== !!(bits & (0x80 >> col))) { boxOk = false; break; }
    }
  }
}
check(boxOk, 'the six box-drawing characters reach their code page 437 glyphs');

if (pngPath) {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = at + y * pitch + x * 4;
      px[y * w + x] = (M.u8[p] || M.u8[p + 1] || M.u8[p + 2]) ? 1 : 0;
    }
  writeIndexedPng(pngPath, { pixels: px, width: w, height: h,
    palette: Uint8Array.from([0, 0, 0, 255, 255, 255, ...new Array(762).fill(0)]) });
  console.log(`\nwrote ${pngPath}`);
}

console.log(bad ? `\n${bad} checks failed` : '\nthe Win32 shim rasterises text from the VGA ROM font');
process.exit(bad ? 1 : 0);
