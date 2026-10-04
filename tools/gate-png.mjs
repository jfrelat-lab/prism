// gate-png.mjs — src/env/png.js inflates what zlib deflates, and decodes the PNG files it is given.
//
// The decoder behind IMG_Load is PRISM's own: a program calling it expects a surface back at once,
// and the page's DecompressionStream is asynchronous. Two references, neither of them this code:
//
//   INFLATE against zlib (node's): data of four kinds deflated at every level and with every
//   strategy -- stored blocks, fixed Huffman codes, dynamic ones, long matches -- must come back
//   byte for byte, and a damaged checksum must be refused.
//
//   PNG against files this gate ENCODES: every colour type at every legal bit depth, each row
//   through one of the five filters in turn, the image data split across IDAT chunks. The encoder
//   is the forward filter and zlib's deflate; the pixels it started from are the answer.
//
// Then what SDL_image makes of a decoded file (src/env/sdl2-image.js): which kind of surface, and
// when a tRNS chunk becomes a colour key. Here that is checked without a container; the rules
// themselves are held to the real SDL_image by tools/gate-sdl2-image.mjs.
//
// With PRISM_SDLPOP_DATA=<dir> the 929 PNG files of SDLPoP are inflated against zlib as well.
//
//   node tools/gate-png.mjs
import zlib from 'node:zlib';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateZlib, decodePng, PNG_RULES } from '../src/env/png.js';
import { pngToSurface } from '../src/env/sdl2-image.js';
import { PIXELFORMAT } from '../src/env/sdl2-surface.js';
import { encode, CHANNELS } from './png-encode.mjs';

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(64)} ${detail}`); };
let seed = 2024;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- inflate
const corpus = {
  noise: Uint8Array.from({ length: 70000 }, () => rnd() & 255),
  text: new TextEncoder().encode('the quick brown fox jumps over the lazy dog; '.repeat(900)),
  zeros: new Uint8Array(100000),
  ramps: Uint8Array.from({ length: 50000 }, (_, i) => (i >> (i % 7)) & 255),
  empty: new Uint8Array(0),
};
let streams = 0, wrong = 0;
for (const [name, data] of Object.entries(corpus)) {
  for (const level of [0, 1, 6, 9]) {
    for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE]) {
      streams++;
      let out;
      try { out = inflateZlib(new Uint8Array(zlib.deflateSync(data, { level, strategy }))); } catch (e) { out = null; }
      if (!out || !same(out, data)) { wrong++; if (wrong < 4) console.log(`       ${name}, level ${level}, strategy ${strategy}`); }
    }
  }
}
report(wrong === 0, 'inflate returns what zlib deflated', `${streams - wrong} of ${streams} streams`);
{
  const z = new Uint8Array(zlib.deflateSync(corpus.text));
  z[z.length - 1] ^= 1;
  let threw = false;
  try { inflateZlib(z); } catch { threw = true; }
  report(threw, 'a stream whose checksum is wrong is refused');
}

// ---- PNG, encoded here
const KINDS = [[0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [2, 8], [2, 16], [3, 1], [3, 2], [3, 4], [3, 8], [4, 8], [4, 16], [6, 8], [6, 16]];
function image(colorType, depth, width = 37, height = 23) {
  const rowBytes = (width * CHANNELS[colorType] * depth + 7) >> 3, rows = new Uint8Array(rowBytes * height);
  // Smooth in places and noisy in others, so that every filter has both ties and carries to get right.
  for (let i = 0; i < rows.length; i++) rows[i] = (i % 11 < 6 ? (i * 3) >> 2 : rnd()) & 255;
  // The unused low bits of a last partial byte are zero in a file a real encoder writes.
  const used = (width * CHANNELS[colorType] * depth) & 7;
  if (used) for (let y = 0; y < height; y++) rows[y * rowBytes + rowBytes - 1] &= 0xff << (8 - used);
  const palette = colorType === 3 ? Uint8Array.from({ length: 3 << depth }, () => rnd() & 255) : null;
  return { width, height, depth, colorType, rows, palette };
}
function decodeAll() {
  let ok = 0;
  const failed = [];
  for (const [colorType, depth] of KINDS) {
    const img = image(colorType, depth);
    let got;
    try { got = decodePng(encode(img)); } catch (e) { failed.push(`type ${colorType} depth ${depth}: ${e.message}`); continue; }
    if (got.width === img.width && got.height === img.height && same(got.rows, img.rows) && (!img.palette || same(got.palette, img.palette))) ok++;
    else failed.push(`type ${colorType} depth ${depth}`);
  }
  return { ok, failed };
}
{
  seed = 77;
  const { ok, failed } = decodeAll();
  report(ok === KINDS.length, 'every colour type and depth decodes to the rows that were encoded', `${ok} of ${KINDS.length}${failed.length ? `: ${failed.slice(0, 3).join('; ')}` : ''}`);
  for (const f of [0, 1, 2, 3, 4]) {
    const img = image(6, 8);
    const got = decodePng(encode({ ...img, filterOf: () => f }));
    report(same(got.rows, img.rows), `filter ${f} on every row`);
  }
  let refused = '';
  const bytes = encode(image(2, 8));
  bytes[8 + 8 + 12] = 1;                        // IHDR's interlace byte; the CRC is not checked on read
  try { decodePng(bytes); } catch (e) { refused = e.message; }
  report(/interlaced/.test(refused), 'an interlaced file is refused by name', refused);
}

// ---- controls: each filter rule, swapped for its near miss
const swap = (key, value) => { const was = PNG_RULES[key]; PNG_RULES[key] = value; return () => { PNG_RULES[key] = was; }; };
for (const [name, key, value] of [
  ['an average that rounds up', 'average', (a, b) => (a + b + 1) >> 1],
  ['a Paeth predictor that breaks ties toward the upper-left', 'paeth', (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pc <= pa && pc <= pb ? c : pb <= pa ? b : a; }],
]) {
  const undo = swap(key, value);
  seed = 77;
  let r;
  try { r = decodeAll(); } finally { undo(); }
  report(r.ok < KINDS.length, `control: ${name}`, `${KINDS.length - r.ok} of ${KINDS.length} kinds come out wrong`);
}

// ---- what SDL_image makes of a file
{
  seed = 5;
  const pal = image(3, 4, 9, 7);
  const one = pngToSurface(encode({ ...pal, trns: Uint8Array.from([255, 255, 0, 255]) }));
  report(one.format === PIXELFORMAT.INDEX8 && one.colorKey === 2 && one.pixels.length === 63 && one.palette.length === 48,
    'a palette with one transparent entry: 8-bit indexed, keyed on it', `key ${one.colorKey}`);
  const none = pngToSurface(encode(pal));
  report(none.format === PIXELFORMAT.INDEX8 && none.colorKey === null, 'a palette with no tRNS: 8-bit indexed, no key');
  const two = pngToSurface(encode({ ...pal, trns: Uint8Array.from([0, 255, 0]) }));
  report(two.format === PIXELFORMAT.ABGR8888 && two.colorKey === null && two.pixels.length === 63 * 4, 'a palette with two transparent entries: expanded to RGBA');
  const half = pngToSurface(encode({ ...pal, trns: Uint8Array.from([255, 128]) }));
  const firstIndex = pal.rows[0] >> 4;
  report(half.format === PIXELFORMAT.ABGR8888 && half.pixels[3] === (firstIndex === 1 ? 128 : 255) && half.pixels[0] === pal.palette[3 * firstIndex],
    'a palette with a translucent entry: expanded, alpha from tRNS');
  const rgb = image(2, 8, 9, 7), rgba = image(6, 8, 9, 7), deep = image(2, 16, 9, 7);
  const s24 = pngToSurface(encode(rgb)), s32 = pngToSurface(encode(rgba)), s16 = pngToSurface(encode(deep));
  report(s24.format === PIXELFORMAT.RGB24 && same(s24.pixels, rgb.rows), 'RGB: a 24-bit surface, bytes in the file\'s order');
  report(s32.format === PIXELFORMAT.ABGR8888 && same(s32.pixels, rgba.rows), 'RGBA: a 32-bit surface, bytes in the file\'s order');
  report(s16.format === PIXELFORMAT.RGB24 && s16.pixels.every((v, i) => v === deep.rows[2 * i]), '16-bit samples keep their high byte');
  const bits = pngToSurface(encode(image(3, 1, 9, 7)));
  report(bits.format === PIXELFORMAT.INDEX8 && bits.pixels.every((v) => v < 2), 'a 1-bit palette image: one byte a pixel');
}

// ---- the game's own files, when they are here
const data = process.env.PRISM_SDLPOP_DATA;
if (data && existsSync(join(data, 'data'))) {
  let n = 0, off = 0;
  (function walk(d) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.png')) continue;
      n++;
      const b = readFileSync(p), parts = [];
      for (let at = 8; at < b.length;) { const len = b.readUInt32BE(at); if (b.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(b.subarray(at + 8, at + 8 + len)); at += 12 + len; }
      const z = Buffer.concat(parts);
      try { if (Buffer.compare(Buffer.from(inflateZlib(new Uint8Array(z))), zlib.inflateSync(z))) off++; decodePng(new Uint8Array(b)); } catch { off++; }
    }
  })(join(data, 'data'));
  report(n > 0 && off === 0, 'SDLPoP\'s own PNG files inflate as zlib inflates them', `${n - off} of ${n}`);
} else console.log('  --  SDLPoP\'s PNG files: not checked (PRISM_SDLPOP_DATA is not set)');

if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nPNG files are inflated and decoded as they were encoded.');
