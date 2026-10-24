// title-card.mjs — a thumbnail that is NOT a picture of the program: its name, its maker and year,
// drawn in the VGA ROM font of assets/ at the size of the other thumbnails (320x200, shown pixelated).
// For a program whose licence forbids showing its screens (Quake's shareware licence, sections 3 and
// 4: "a screen display or a screenshot"), so the showcase still has a card and a link preview for it.
//
//   titleCard(path, { title, sub, note })
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRgbPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const W = 320, H = 200;
// The showcase's own colours: its ground, its head and dim text, and the spectrum under its header.
const BG = [0x0b, 0x0d, 0x11], HEAD = [0xed, 0xf1, 0xf6], DIM = [0x7a, 0x85, 0x94];
const SPECTRUM = [[0xff, 0x6b, 0x6b], [0xff, 0xb3, 0x5c], [0xff, 0xe0, 0x66], [0x7e, 0xe2, 0xa8], [0x6c, 0xb6, 0xff], [0x9b, 0x8c, 0xff], [0xd3, 0x8c, 0xff]];

/** Words into lines of at most `max` characters. */
function wrap(text, max) {
  const lines = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && line.length + 1 + w.length > max) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  return line ? [...lines, line] : lines;
}

export function titleCard(path, { title, sub = '', note = '' }) {
  const font = readFileSync(join(ROOT, 'assets/vga-rom-8x16.bin'));
  const px = new Uint8Array(W * H * 4);                      // B, G, R, X: png.mjs's order
  const put = (x, y, [r, g, b]) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; px[i] = b; px[i + 1] = g; px[i + 2] = r; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, BG);
  // The spectrum, as a 2-pixel band at the top and the bottom, its colours blended across the width.
  for (let x = 0; x < W; x++) {
    const t = (x / (W - 1)) * (SPECTRUM.length - 1), i = Math.min(Math.floor(t), SPECTRUM.length - 2), f = t - i;
    const c = SPECTRUM[i].map((v, k) => Math.round(v + (SPECTRUM[i + 1][k] - v) * f));
    for (const y of [0, 1, H - 2, H - 1]) put(x, y, c);
  }
  // A line of text, centred, each glyph cell `scale` pixels per font pixel.
  const text = (s, y, scale, colour) => {
    const x0 = Math.round((W - s.length * 8 * scale) / 2);
    for (let c = 0; c < s.length; c++) {
      const g = s.charCodeAt(c) & 0xff;
      for (let gy = 0; gy < 16; gy++) {
        const bits = font[g * 16 + gy];
        for (let gx = 0; gx < 8; gx++) if (bits & (0x80 >> gx))
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(x0 + (c * 8 + gx) * scale + sx, y + gy * scale + sy, colour);
      }
    }
  };
  const titleLines = wrap(title, 18);                        // 18 glyphs at scale 2 fill 288 of 320 pixels
  const subLines = sub ? wrap(sub, 38) : [], noteLines = note ? wrap(note, 38) : [];
  const height = titleLines.length * 32 + (subLines.length ? 10 + subLines.length * 16 : 0);
  let y = Math.round((H - 24 - height) / 2);
  for (const l of titleLines) { text(l, y, 2, HEAD); y += 32; }
  if (subLines.length) y += 10;
  for (const l of subLines) { text(l, y, 1, DIM); y += 16; }
  let ny = H - 10 - noteLines.length * 16;
  for (const l of noteLines) { text(l, ny, 1, DIM); ny += 16; }
  writeRgbPng(path, { bytes: px, width: W, height: H });
}
