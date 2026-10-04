// png.js — a PNG decoder, for the image-loading libraries on PRISM's side of the boundary.
//
// SDL_image is a library a program links, like SDL itself, so what it does is supplied here rather
// than compiled: IMG_Load hands the program a surface, and behind it libpng and zlib turn a file
// into rows of pixels. This is that part, in JavaScript, and synchronous -- the page's own
// DecompressionStream is asynchronous, and a C program calling IMG_Load expects its surface back.
//
// What it decodes: every colour type at 1, 2, 4, 8 and 16 bits, PLTE and tRNS, the five row
// filters. What it REFUSES, by name: interlaced files (Adam7). tools/gate-png.mjs holds inflate()
// to zlib, and the unfiltered rows to files the gate encodes itself.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/* A canonical Huffman code as two tables: how many codes of each length, and the symbols in order. */
function huffman(lengths) {
  const count = new Uint16Array(16), symbol = new Uint16Array(lengths.length);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  return (FIXED = { lit: huffman(l), dist: huffman(new Uint8Array(30).fill(5)) });
}

/** RFC 1951. `data` is a raw deflate stream; the result is the whole of what it expands to. */
export function inflateRaw(data) {
  let pos = 0, bitBuf = 0, bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, data.length * 4)), n = 0;
  const need = (extra) => {
    if (n + extra <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, n + extra));
    bigger.set(out.subarray(0, n));
    out = bigger;
  };
  const bits = (count) => {
    while (bitCnt < count) {
      if (pos >= data.length) throw new Error('inflate: the stream ends inside a block');
      bitBuf |= data[pos++] << bitCnt; bitCnt += 8;
    }
    const v = bitBuf & ((1 << count) - 1);
    bitBuf >>>= count; bitCnt -= count;
    return v;
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('inflate: a code that is in no table');
  };
  for (let last = 0; !last;) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      const len = data[pos] | (data[pos + 1] << 8), nlen = data[pos + 2] | (data[pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: a stored block whose length does not check');
      pos += 4;
      need(len);
      out.set(data.subarray(pos, pos + len), n);
      n += len; pos += len;
      continue;
    }
    if (type === 3) throw new Error('inflate: block type 3 does not exist');
    let lit, dist;
    if (type === 1) ({ lit, dist } = fixedTables());
    else {
      const nlit = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[CODE_ORDER[i]] = bits(3);
      const ch = huffman(cl), lengths = new Uint8Array(nlit + ndist);
      for (let i = 0; i < nlit + ndist;) {
        const sym = decode(ch);
        if (sym < 16) { lengths[i++] = sym; continue; }
        let prev = 0, rep;
        if (sym === 16) { if (!i) throw new Error('inflate: a repeat with nothing before it'); prev = lengths[i - 1]; rep = 3 + bits(2); }
        else if (sym === 17) rep = 3 + bits(3);
        else rep = 11 + bits(7);
        if (i + rep > nlit + ndist) throw new Error('inflate: code lengths run past their table');
        while (rep--) lengths[i++] = prev;
      }
      lit = huffman(lengths.subarray(0, nlit)); dist = huffman(lengths.subarray(nlit));
    }
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) { need(1); out[n++] = sym; continue; }
      if (sym === 256) break;
      if (sym > 285) throw new Error('inflate: a length symbol that does not exist');
      const len = LEN_BASE[sym - 257] + bits(LEN_EXTRA[sym - 257]);
      const ds = decode(dist);
      if (ds > 29) throw new Error('inflate: a distance symbol that does not exist');
      const d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
      if (d > n) throw new Error('inflate: a distance that reaches before the output');
      need(len);
      for (let i = 0; i < len; i++, n++) out[n] = out[n - d];   // byte by byte: the ranges may overlap
    }
  }
  return out.subarray(0, n);
}

/** RFC 1950: a deflate stream behind a two-byte header and before an Adler-32, which is checked. */
export function inflateZlib(data) {
  if (data.length < 6 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31) throw new Error('zlib: not a zlib stream');
  if (data[1] & 0x20) throw new Error('zlib: a preset dictionary is not supported');
  const out = inflateRaw(data.subarray(2));
  let a = 1, b = 0;
  for (let i = 0; i < out.length; i++) { a = (a + out[i]) % 65521; b = (b + a) % 65521; }
  const t = data.length - 4;
  const want = ((data[t] << 24) | (data[t + 1] << 16) | (data[t + 2] << 8) | data[t + 3]) >>> 0;
  if ((((b << 16) | a) >>> 0) !== want) throw new Error('zlib: the checksum does not match');
  return out;
}

/*
 * The two row filters with a rule in them: the average rounds down, and Paeth's predictor breaks a
 * tie in the order left, above, upper-left. Named so tools/gate-png.mjs can swap each for its near
 * miss.
 */
export const PNG_RULES = {
  average: (a, b) => (a + b) >> 1,
  paeth: (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  },
};

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export const isPng = (bytes) => bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);

/**
 * The file as it is: its header, palette and transparency chunks, and its rows UNFILTERED but not
 * otherwise changed -- `rows` holds height * rowBytes bytes at the file's own bit depth, samples
 * packed as the format packs them. What a surface is made of is the caller's business.
 */
export function decodePng(bytes) {
  if (!isPng(bytes)) throw new Error('png: not a PNG file');
  const u32 = (at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  let header = null, palette = null, trns = null;
  const idat = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const len = u32(at), id = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (id === 'IHDR') header = { width: u32(at + 8), height: u32(at + 12), depth: body[8], colorType: body[9], interlace: body[12] };
    else if (id === 'PLTE') palette = body.slice();
    else if (id === 'tRNS') trns = body.slice();
    else if (id === 'IDAT') idat.push(body);
    else if (id === 'IEND') break;
    at += 12 + len;
  }
  if (!header) throw new Error('png: no IHDR chunk');
  if (!(header.colorType in CHANNELS)) throw new Error(`png: colour type ${header.colorType} does not exist`);
  if (header.interlace) throw new Error('png: interlaced files are not supported');
  const channels = CHANNELS[header.colorType];
  const bpp = Math.max(1, (channels * header.depth) >> 3);              // bytes a filter looks back by
  const rowBytes = (header.width * channels * header.depth + 7) >> 3;
  let size = 0;
  for (const c of idat) size += c.length;
  const packed = new Uint8Array(size);
  size = 0;
  for (const c of idat) { packed.set(c, size); size += c.length; }
  const raw = inflateZlib(packed);
  if (raw.length < (rowBytes + 1) * header.height) throw new Error('png: fewer rows than the header says');
  const rows = new Uint8Array(rowBytes * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (rowBytes + 1)], src = y * (rowBytes + 1) + 1, dst = y * rowBytes, up = dst - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? rows[dst + x - bpp] : 0, b = y ? rows[up + x] : 0, c = x >= bpp && y ? rows[up + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += PNG_RULES.average(a, b);
      else if (filter === 4) v += PNG_RULES.paeth(a, b, c);
      else if (filter !== 0) throw new Error(`png: row filter ${filter} does not exist`);
      rows[dst + x] = v;
    }
  }
  return { ...header, channels, rowBytes, rows, palette, trns };
}
