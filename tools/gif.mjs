// gif.mjs — PNG frames to an animated GIF, with no dependency (the README's moving pictures).
//
//   node tools/gif.mjs <out.gif> <frame.png>... [--fps=12] [--colors=255] [--dither=1] [--loop=0]
//
// The frames are what a page captured from its canvas (8-bit RGB or RGBA PNGs, one size). One palette
// serves the whole animation -- median cut over a sample of every frame -- so a colour does not shift
// from frame to frame. A 4x4 ordered dither (--dither, 0 for none) keeps gradients from banding into
// steps, and is ORDERED rather than error-diffused so that a still area dithers the same way in every
// frame: then a pixel that did not change is the same index, and is sent as transparent. That is
// where most of the size goes on a mostly still picture (Live C), and some of it on a moving one.
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG in
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let at = 8, w = 0, h = 0, depth = 0, type = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), kind = buf.toString('latin1', at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12]) throw new Error('interlaced PNG'); }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    at += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[type];
  if (depth !== 8 || !bpp) throw new Error(`PNG colour type ${type}, depth ${depth}: only 8-bit RGB and RGBA`);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      cur[i] = (line[i] + pred) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = cur[x * bpp + k];
    [prev, cur] = [cur, prev];
  }
  return { w, h, rgb: out };
}

// ---------------------------------------------------------------- one palette, by median cut
function medianCut(samples, n) {
  let boxes = [samples];
  const range = (box) => {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const c of box) for (let k = 0; k < 3; k++) { if (c[k] < lo[k]) lo[k] = c[k]; if (c[k] > hi[k]) hi[k] = c[k]; }
    return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  };
  while (boxes.length < n) {
    // Split the box whose widest channel, weighted by how many pixels it holds, is widest.
    let best = -1, bestScore = 0, axis = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      const r = range(b), k = r.indexOf(Math.max(...r)), score = r[k] * Math.sqrt(b.length);
      if (score > bestScore) { bestScore = score; best = i; axis = k; }
    });
    if (best < 0) break;
    const b = boxes[best].sort((p, q) => p[axis] - q[axis]), mid = b.length >> 1;
    boxes.splice(best, 1, b.slice(0, mid), b.slice(mid));
  }
  return boxes.map((b) => [0, 1, 2].map((k) => Math.round(b.reduce((s, c) => s + c[k], 0) / b.length)));
}

// ---------------------------------------------------------------- LZW, as GIF wants it
function lzw(indices, minCode) {
  const out = [];
  let bits = 0, acc = 0;
  const emit = (code, size) => { acc |= code << bits; bits += size; while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8; } };
  const clear = 1 << minCode, end = clear + 1;
  let dict = new Map(), next = end + 1, size = minCode + 1;
  emit(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix * 4096 + k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, size);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(clear, size); dict = new Map(); next = end + 1; size = minCode + 1; }
    prefix = k;
  }
  emit(prefix, size);
  emit(end, size);
  if (bits) out.push(acc & 255);
  return out;
}
const blocks = (bytes) => { const out = []; for (let i = 0; i < bytes.length; i += 255) { const s = bytes.slice(i, i + 255); out.push(s.length, ...s); } out.push(0); return out; };

// ---------------------------------------------------------------- the animation
export function encodeGif(frames, { fps = 12, colors = 255, dither = 1, loop = 0 } = {}) {
  const { w, h } = frames[0];
  if (frames.some((f) => f.w !== w || f.h !== h)) throw new Error('frames of different sizes');
  const samples = [];
  for (const f of frames) for (let i = 0; i < w * h; i += 37) samples.push([f.rgb[i * 3], f.rgb[i * 3 + 1], f.rgb[i * 3 + 2]]);
  const pal = medianCut(samples, Math.min(colors, 255));
  const T = pal.length;                       // the transparent index, one past the colours
  const near = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (near[key] >= 0) return near[key];
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) { const dr = pal[i][0] - r, dg = pal[i][1] - g, db = pal[i][2] - b, d = 2 * dr * dr + 4 * dg * dg + 3 * db * db; if (d < bd) { bd = d; best = i; } }
    return (near[key] = best);
  };
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const index = (f) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, d = dither ? (BAYER[(y & 3) * 4 + (x & 3)] - 7.5) * 2 * dither : 0;
      const c = (k) => Math.max(0, Math.min(255, f.rgb[i * 3 + k] + d));
      out[i] = nearest(c(0), c(1), c(2));
    }
    return out;
  };
  const size = Math.max(2, Math.ceil(Math.log2(T + 1)));
  const table = [];
  for (let i = 0; i < 1 << size; i++) table.push(...(pal[i] ?? [0, 0, 0]));
  const bytes = [...Buffer.from('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0xf0 | (size - 1), 0, 0, ...table,
    0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, loop & 255, loop >> 8, 0];
  const delay = Math.round(100 / fps);
  let last = null;
  for (const f of frames) {
    const idx = index(f);
    let px = idx;
    if (last) { px = new Uint8Array(idx); for (let i = 0; i < px.length; i++) if (idx[i] === last[i]) px[i] = T; }
    // Graphic control: keep the previous frame under this one (disposal 1), T transparent.
    bytes.push(0x21, 0xf9, 4, (1 << 2) | (last ? 1 : 0), delay & 255, delay >> 8, last ? T : 0, 0);
    bytes.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, size, ...blocks(lzw(px, size)));
    last = idx;
  }
  bytes.push(0x3b);
  return Buffer.from(bytes);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opt = (n, d) => Number(process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d);
  const [out, ...files] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!out || !files.length) { console.error('usage: node tools/gif.mjs <out.gif> <frame.png>... [--fps=12] [--colors=255] [--dither=1]'); process.exit(2); }
  const frames = files.map((f) => decodePng(readFileSync(f)));
  const gif = encodeGif(frames, { fps: opt('fps', 12), colors: opt('colors', 255), dither: opt('dither', 1), loop: opt('loop', 0) });
  writeFileSync(out, gif);
  console.log(`${out}: ${frames.length} frames, ${frames[0].w}x${frames[0].h}, ${(gif.length / 1024 / 1024).toFixed(2)} MB`);
}
