// vgafont.js — the IBM VGA 8x16 ROM font, put where compiled C can read it.
//
// The font is already in this repo: assets/vga-rom-8x16.bin, 256 glyphs of 16 rows, one byte per
// row with the most significant bit leftmost. web/app.js draws DOS text mode with it. This makes the
// same 4096 bytes reachable from a compiled program, by interning them in guest memory and pointing
// a global at them.
//
// Why not a C array in the shim: it would be a second copy of the same bytes, free to drift from the
// one the page uses, and 4,096 numbers of source for something that is data. Why not fetched at run
// time: the font is not the program's data, it is the PLATFORM's -- a Windows box has fonts before
// any program starts, and this is the cheapest honest stand-in for one.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * `bytes` lets a host that has no filesystem -- the browser worker -- pass the font in instead.
 * The symbol is only written if the program actually defines it, so installing this for a target
 * that has no use for it costs a lookup and nothing else.
 */
export function installVgaFont(M, { bytes = null, symbol = 'prism_vga_font' } = {}) {
  const font = bytes ?? new Uint8Array(readFileSync(join(ROOT, 'assets/vga-rom-8x16.bin')));
  if (font.length < 4096) throw new Error(`vga font: ${font.length} bytes, expected at least 4096`);

  const at = M.mod.intern([...font.subarray(0, 4096)]);
  const sym = M.mod.symbols.get(symbol);
  if (sym) M.mod.dv.setInt32(sym.addr, at, true);
  return { at, size: 4096, bound: !!sym };
}
