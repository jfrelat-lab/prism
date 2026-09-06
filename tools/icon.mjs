// icon.mjs — the icon a program ships with its own source, as a PNG.
//
// Half the corpus has one and half never did, and the split is not arbitrary: an icon is a WINDOWS
// idea. Quake, Quake II, PuTTY, OpenTyrian and OpenDUNE each keep a .ico in their tree; Doom
// (linuxdoom is an X client), Heretic, Hexen and MAME are DOS programs, where the concept does not
// exist. Nothing is invented for those -- see --frame in the harnesses, which captures what the
// program itself draws.
//
// Reading a .ico needs no resource compiler, which matters because PRISM has none and is not going
// to get one (roadmap N4). The file is a directory of images, each a BITMAPINFOHEADER with its rows
// bottom-up and a 1-bit AND mask underneath: the same DIB the rest of Windows uses.
//
//   node tools/icon.mjs <file.ico> [--out=/tmp/x.png] [--size=32]
//   node tools/icon.mjs --corpus                 # every icon the corpus ships, listed
import { readFileSync, existsSync } from 'node:fs';
import { writeIndexedPng } from './png.mjs';

const ROOT = '/Users/julienfrelat/Projects/prism';

/** Every icon the corpus ships, and which program owns it. */
const CORPUS = [
  ['quake', 'corpus/Quake/WinQuake/quake.ico'],
  ['quake2', 'corpus/Quake2/win32/q2.ico'],
  ['putty', 'corpus/putty/windows/putty.ico'],
  ['opentyrian', 'corpus/OpenTyrian/visualc/tyrian.ico'],
  ['opendune', 'corpus/OpenDUNE/os/win32/opendune.ico'],
];

/**
 * The images inside a .ico: {w, h, bpp, offset, length}.
 *
 * A zero in the width or height byte means 256 -- the format is one byte per dimension, and 256 did
 * not fit. The bpp in the directory entry is often 0 (Quake's is, in all five of its images); the
 * real depth is in the image's own header, which is why the decoder below reads it there.
 */
export function iconDirectory(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an .ico');
  const n = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    out.push({
      w: buf[e] || 256, h: buf[e + 1] || 256,
      colours: buf[e + 2], bpp: buf.readUInt16LE(e + 6),
      length: buf.readUInt32LE(e + 8), offset: buf.readUInt32LE(e + 12),
    });
  }
  return out;
}

/**
 * One image, decoded to RGBA. Handles the DIB forms this corpus actually contains: 1, 4, 8, 24 and
 * 32 bits per pixel. A PNG-in-ICO (Vista and later) is passed through untouched.
 *
 * The AND mask is what makes an icon an icon -- the transparent corners of a round logo are in it,
 * not in the colour data -- so a decoder that ignores it produces a black square with the right
 * picture inside, which looks like a rendering bug.
 */
export function decodeIcon(buf, entry) {
  const at = entry.offset;
  if (buf.readUInt32BE(at) === 0x89504e47) return { png: buf.subarray(at, at + entry.length) };

  const headerSize = buf.readUInt32LE(at);
  const w = buf.readInt32LE(at + 4);
  const h = buf.readInt32LE(at + 8) / 2;          // the height counts colour AND mask
  const bpp = buf.readUInt16LE(at + 14);
  const palCount = buf.readUInt32LE(at + 32) || (bpp <= 8 ? 1 << bpp : 0);
  const palAt = at + headerSize;
  const pal = [];
  for (let i = 0; i < palCount; i++) {
    const p = palAt + i * 4;
    pal.push([buf[p + 2], buf[p + 1], buf[p]]);   // BGRA on disk
  }
  const dataAt = palAt + palCount * 4;
  const rowBytes = Math.ceil((w * bpp) / 32) * 4;
  const maskRow = Math.ceil(w / 32) * 4;
  const maskAt = dataAt + rowBytes * h;

  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = dataAt + (h - 1 - y) * rowBytes;      // DIB rows are bottom-up
    const mskRow = maskAt + (h - 1 - y) * maskRow;
    for (let x = 0; x < w; x++) {
      let r, g, b, a = 255;
      if (bpp === 32) {
        const p = srcRow + x * 4;
        [b, g, r, a] = [buf[p], buf[p + 1], buf[p + 2], buf[p + 3]];
      } else if (bpp === 24) {
        const p = srcRow + x * 3;
        [b, g, r] = [buf[p], buf[p + 1], buf[p + 2]];
      } else {
        const bit = x * bpp;
        const byte = buf[srcRow + (bit >> 3)];
        const idx = bpp === 8 ? byte
          : bpp === 4 ? (bit % 8 === 0 ? byte >> 4 : byte & 15)
            : (byte >> (7 - (bit % 8))) & 1;
        [r, g, b] = pal[idx] ?? [0, 0, 0];
      }
      // The mask: 1 means TRANSPARENT. A 32-bit icon carries its own alpha and usually a mask of
      // zeroes, so the two are combined rather than one replacing the other.
      const m = (buf[mskRow + (x >> 3)] >> (7 - (x % 8))) & 1;
      if (m) a = 0;
      const o = (y * w + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  }
  return { w, h, bpp, rgba };
}

/** The image closest to `want` pixels, preferring the deepest colour at that size. */
export function pickIcon(dir, want = 32) {
  return [...dir].sort((a, b) =>
    (Math.abs(a.w - want) - Math.abs(b.w - want)) || (b.bpp - a.bpp) || (b.length - a.length))[0];
}

// ------------------------------------------------------------------ command line
const args = process.argv.slice(2);
const opt = (n, d = null) => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;

if (args.includes('--corpus')) {
  console.log('the icons the corpus ships, in the programs\' own trees:\n');
  for (const [name, rel] of CORPUS) {
    const path = `${ROOT}/${rel}`;
    if (!existsSync(path)) { console.log(`  ${name.padEnd(12)} (missing: ${rel})`); continue; }
    const buf = readFileSync(path);
    const dir = iconDirectory(buf);
    console.log(`  ${name.padEnd(12)} ${rel}`);
    console.log(`  ${''.padEnd(12)} ${dir.map(d => `${d.w}x${d.h}`).join(' ')}` +
      `  (${buf.length.toLocaleString('en')} bytes)`);
  }
  console.log('\n  and the ones that ship none, because DOS had no such thing:');
  console.log('    doom (X11)  heretic  hexen  mame 0.1-0.4  lua  clangsay');
  process.exit(0);
}

if (!args[0]) {
  console.error('usage: node tools/icon.mjs <file.ico> [--out=/tmp/x.png] [--size=32]');
  process.exit(2);
}

const buf = readFileSync(args[0]);
const dir = iconDirectory(buf);
const entry = pickIcon(dir, +(opt('size') ?? 32));
console.log(`${args[0]}: ${dir.length} image(s), taking ${entry.w}x${entry.h}`);
const img = decodeIcon(buf, entry);
const out = opt('out') ?? '/tmp/icon.png';
if (img.png) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, img.png);
} else {
  /*
   * Indexed, because that is what the corpus's own PNG writer produces and what the page already
   * draws. A colour that is transparent in the mask becomes palette entry 0, which the writer
   * leaves at black -- good enough for an icon on a dark shelf, and honest about what was dropped.
   */
  const palette = new Uint8Array(768);
  const pixels = new Uint8Array(img.w * img.h);
  const seen = new Map();
  let next = 1;
  for (let i = 0; i < pixels.length; i++) {
    const [r, g, b, a] = img.rgba.subarray(i * 4, i * 4 + 4);
    if (a < 128) { pixels[i] = 0; continue; }
    const k = (r << 16) | (g << 8) | b;
    let idx = seen.get(k);
    if (idx === undefined) {
      if (next > 255) { idx = 1; } else {
        idx = next++;
        palette[idx * 3] = r; palette[idx * 3 + 1] = g; palette[idx * 3 + 2] = b;
        seen.set(k, idx);
      }
    }
    pixels[i] = idx;
  }
  writeIndexedPng(out, { pixels, width: img.w, height: img.h, palette });
}
console.log(`wrote ${out}`);
