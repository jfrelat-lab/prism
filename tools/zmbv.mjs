// zmbv.mjs — read the frames of a DOSBox(-X) ZMBV capture (`DX-CAPTURE /V`): palette indices, or 32-bit pixels.
//
// DOSBox records the EMULATED framebuffer, before any scaling, so an 8-bit capture is exactly the
// guest's pixels and palette: for an EGA or VGA game that is a pixel reference PRISM can be held to.
// Some machine types (DOSBox-X's vgaonly and svga_*) record 32 bpp instead, format 8: four bytes a
// pixel, B G R and one unused (a little-endian 0x00RRGGBB), no palette;
// the frame then says `bpp: 32` and `palette` is null.
//
// The format, as DOSBox's own encoder writes it (src/libs/zmbv): each video chunk starts with a
// flags byte -- bit 0 a keyframe, bit 1 a palette change. A keyframe carries a 6-byte header
// (version 0.1, compression 1 = zlib, format 4 = 8 bpp, block width, block height) and RESETS the
// deflate stream; every frame's payload is the next piece of ONE continuous stream until the next
// keyframe. Inside it, a keyframe is the 768-byte palette (8 bpp) and then the pixels; a delta frame
// is, optionally, the palette XOR the previous one, then two bytes per block -- dx and dy, each
// shifted left by one, the low bit of dx set when XOR data follows -- padded to four, then for each
// such block its pixels XOR the previous frame's pixels displaced by (dx, dy). An EMPTY chunk is a
// frame the encoder dropped: the picture did not change.
//
// Linear in the capture: each keyframe's segment of the stream is inflated ONCE and then read in
// order, since a frame's length follows from its own vectors. Frames are yielded, not collected --
// a minute of 640x350 is a third of a gigabyte of pixels.
//
//   import { zmbvFrames } from './zmbv.mjs';
//   for (const f of zmbvFrames(bytes)) f.index, f.width, f.height, f.bpp, f.pix, f.palette
import zlib from 'node:zlib';

function chunks(buf) {
  // A RIFF tree, flattened: every leaf chunk in file order, lists descended into.
  const out = [];
  const walk = (from, to) => {
    let p = from;
    while (p + 8 <= to) {
      const id = buf.toString('latin1', p, p + 4), size = buf.readUInt32LE(p + 4);
      if (id === 'RIFF' || id === 'LIST') walk(p + 12, Math.min(to, p + 8 + size));
      else out.push({ id, data: buf.subarray(p + 8, p + 8 + size) });
      p += 8 + size + (size & 1);
    }
  };
  walk(0, buf.length);
  return out;
}

export function* zmbvFrames(bytes) {
  const buf = Buffer.from(bytes);
  const all = chunks(buf);
  const strf = all.find((c) => c.id === 'strf');
  if (!strf) throw new Error('zmbv: no stream format');
  const width = strf.data.readInt32LE(4), height = Math.abs(strf.data.readInt32LE(8));
  const video = all.filter((c) => /^\d\ddc$/.test(c.id));

  // Segments: a keyframe and the delta frames after it, their payloads one deflate stream.
  const segments = [];
  for (const c of video) {
    if (c.data.length && (c.data[0] & 1)) segments.push({ start: c, frames: [] });
    if (!segments.length) { if (c.data.length) throw new Error('zmbv: a delta frame before any keyframe'); continue; }
    segments.at(-1).frames.push(c);
  }

  let index = 0, pix = null, palette = null, bpp = 8;
  for (const seg of segments) {
    const [, , comp, fmt, bw, bh] = seg.start.data.subarray(1, 7);
    if (comp !== 1) throw new Error(`zmbv: compression ${comp}`);
    if (fmt !== 4 && fmt !== 8) throw new Error(`zmbv: pixel format ${fmt}, only 8 and 32 bpp are read`);
    bpp = fmt === 4 ? 8 : 32;
    const B = bpp / 8;
    const payloads = seg.frames.filter((c) => c.data.length)
      .map((c, k) => (k === 0 ? c.data.subarray(7) : c.data.subarray(1)));
    const body = zlib.inflateSync(Buffer.concat(payloads), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const bx = Math.ceil(width / bw), by = Math.ceil(height / bh);
    let p = 0;
    for (const c of seg.frames) {
      if (!c.data.length) { yield { index: index++, width, height, bpp, pix, palette }; continue; }
      const flags = c.data[0];
      if (flags & 1) {
        if (bpp === 8) { palette = Uint8Array.from(body.subarray(p, p + 768)); p += 768; } else palette = null;
        pix = Uint8Array.from(body.subarray(p, p + width * height * B)); p += width * height * B;
      } else {
        if (flags & 2) { palette = Uint8Array.from(palette); for (let i = 0; i < 768; i++) palette[i] ^= body[p++]; }
        const vecAt = p;
        p += (bx * by * 2 + 3) & ~3;
        const old = pix, next = new Uint8Array(width * height * B);
        for (let j = 0; j < by; j++) {
          for (let i = 0; i < bx; i++) {
            const k = j * bx + i;
            const vx = (body[vecAt + 2 * k] << 24) >> 24, vy = (body[vecAt + 2 * k + 1] << 24) >> 24;
            const dx = vx >> 1, dy = vy >> 1;
            const x0 = i * bw, y0 = j * bh, x1 = Math.min(x0 + bw, width), y1 = Math.min(y0 + bh, height);
            for (let y = y0; y < y1; y++) {
              for (let x = x0; x < x1; x++) {
                const sx = x + dx, sy = y + dy;
                const inside = sx >= 0 && sx < width && sy >= 0 && sy < height;
                for (let b = 0; b < B; b++) next[(y * width + x) * B + b] = inside ? old[(sy * width + sx) * B + b] : 0;
              }
            }
            if (vx & 1) {
              for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let b = 0; b < B; b++) next[(y * width + x) * B + b] ^= body[p++];
            }
          }
        }
        pix = next;
      }
      yield { index: index++, width, height, bpp, pix, palette };
    }
    if (p !== body.length) throw new Error(`zmbv: segment at frame ${index} read ${p} of ${body.length} bytes -- the frame layout is misread`);
  }
}
