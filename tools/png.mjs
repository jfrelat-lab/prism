// png.mjs — write an 8-bit indexed framebuffer as a PNG, with no dependencies.
//
// A PNG is a CRC-checked container around a deflate stream, and Node has deflate built in. Extracted
// from tools/mame.mjs the third time a tool needed it: looking at the actual pixels is how several
// "it renders nothing" and "it renders the wrong thing" questions got answered, so it belongs
// somewhere shared rather than copied again.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};

/**
 * `pixels` is one byte per pixel, `palette` is 768 bytes of r,g,b. Written as 8-bit truecolour rather
 * than as a PNG palette, because the point is to LOOK at it and an indexed PNG hides a wrong palette.
 */
export function writeIndexedPng(path, { pixels, width, height, palette }) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;                                    // filter: none
    for (let x = 0; x < width; x++) {
      const pen = pixels[y * width + x];
      raw[o++] = palette[pen * 3] ?? 0;
      raw[o++] = palette[pen * 3 + 1] ?? 0;
      raw[o++] = palette[pen * 3 + 2] ?? 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;                          // 8-bit truecolour
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  return path;
}

/**
 * A TRUECOLOUR framebuffer, as SDL hands one over: 4 bytes per pixel, and on a little-endian host
 * SDL_PIXELFORMAT_RGB888 puts them in memory as B, G, R, X. Two bytes per pixel is RGB565.
 */
export function writeRgbPng(path, { bytes, width, height, bpp = 4, pitch = null }) {
  const stride = pitch ?? width * bpp;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * bpp;
      if (bpp === 4) { raw[o++] = bytes[i + 2]; raw[o++] = bytes[i + 1]; raw[o++] = bytes[i]; }
      else {
        const v = bytes[i] | (bytes[i + 1] << 8);
        raw[o++] = ((v >> 11) & 0x1f) << 3;
        raw[o++] = ((v >> 5) & 0x3f) << 2;
        raw[o++] = (v & 0x1f) << 3;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}
