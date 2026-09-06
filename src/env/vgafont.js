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

/*
 * The filesystem is asked for ONLY under Node, and asked for at all only because the default path
 * reads the font off disk. A static `node:fs` import here is fatal in a browser WORKER -- the
 * specifier is fetched as a URL and the request hangs rather than failing, so the module never
 * finishes evaluating and the worker never reaches its message handler. Nothing reports an error;
 * the page simply stops at "starting". Callers in the page pass `bytes` and never touch this.
 */
let readFileSync = null, FONT_PATH = null;
if (typeof process !== 'undefined' && process.versions?.node) {
  ({ readFileSync } = await import('node:fs'));
  FONT_PATH = new URL('../../assets/vga-rom-8x16.bin', import.meta.url);
}

/**
 * `bytes` lets a host that has no filesystem -- the browser worker -- pass the font in instead.
 * The symbol is only written if the program actually defines it, so installing this for a target
 * that has no use for it costs a lookup and nothing else.
 */
export function installVgaFont(M, { bytes = null, symbol = 'prism_vga_font' } = {}) {
  if (!bytes && !readFileSync) throw new Error('vga font: no bytes given and no filesystem to read from');
  const font = bytes ?? new Uint8Array(readFileSync(FONT_PATH));
  if (font.length < 4096) throw new Error(`vga font: ${font.length} bytes, expected at least 4096`);

  const at = M.mod.intern([...font.subarray(0, 4096)]);
  const sym = M.mod.symbols.get(symbol);
  if (sym) M.mod.dv.setInt32(sym.addr, at, true);
  return { at, size: 4096, bound: !!sym };
}
