// png-encode.mjs — a PNG ENCODER for gates: the forward row filters and zlib's deflate.
//
// It exists so that a gate can hand src/env/png.js a file whose pixels it already knows, of any
// colour type and depth, with any filter on any row. It is deliberately not the decoder run
// backwards: the filters are written out here on their own, and the compression is zlib's.
import zlib from 'node:zlib';

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (id, body) => {
  const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  out.set(new TextEncoder().encode(id), 4); out.set(body, 8);
  dv.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
  return out;
};
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
export const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
export function encode({ width, height, depth, colorType, rows, palette = null, trns = null, filterOf = (y) => y % 5 }) {
  const channels = CHANNELS[colorType], rowBytes = (width * channels * depth + 7) >> 3, bpp = Math.max(1, (channels * depth) >> 3);
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = filterOf(y);
    raw[y * (rowBytes + 1)] = f;
    for (let x = 0; x < rowBytes; x++) {
      const v = rows[y * rowBytes + x], a = x >= bpp ? rows[y * rowBytes + x - bpp] : 0, b = y ? rows[(y - 1) * rowBytes + x] : 0, c = x >= bpp && y ? rows[(y - 1) * rowBytes + x - bpp] : 0;
      raw[y * (rowBytes + 1) + 1 + x] = (v - (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 255;
    }
  }
  const z = new Uint8Array(zlib.deflateSync(raw)), cut = z.length >> 1;
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height); ihdr[8] = depth; ihdr[9] = colorType;
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', palette));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('tEXt', new TextEncoder().encode('Comment\0made by gate-png')), chunk('IDAT', z.subarray(0, cut)), chunk('IDAT', z.subarray(cut)), chunk('IEND', new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
