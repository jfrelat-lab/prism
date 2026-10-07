// zlib.js — zlib's interface, as far as MAME 0.37b5 uses it, in JavaScript.
//
// An IMITATION, and it has an oracle: zlib 1.1.3 itself, compiled by PRISM from its own sources
// (targets/zlib.json). tools/gate-zlib.mjs runs one C probe against both and requires the same
// answers; this file is the shortcut a program links when it names the `zlib` environment, the
// compiled library is what says the shortcut is right.
//
// What is here: crc32, adler32, inflateInit_/inflateInit2_/inflate/inflateEnd, uncompress,
// compress, zlibVersion -- the six functions unzip.c, png.c and fileio.c call, and the two beside
// them. What is not, and is refused by absence rather than faked: deflate as a stream, gz* files,
// dictionaries, inflateSync.
//
// TWO PLACES WHERE THE IMITATION IS KNOWINGLY NOT zlib, both invisible to a program that reads the
// return code and the output, which is all MAME does:
//
//  * `compress` writes STORED blocks. The stream is valid -- the real uncompress expands it to the
//    same bytes, and the gate checks exactly that -- but it is not smaller, and it is not the
//    bytes zlib's deflate would have written. PRISM has no compressor.
//  * `inflate` asks for input a bit at a time. zlib 1.1.3 looks a whole table index ahead (up to
//    nine bits for a literal), which is why it needs "an extra dummy byte after the compressed
//    stream" -- unzip.c says so and supplies one. So at the same moment this may have consumed a
//    byte less than zlib has: `avail_in` and `total_in` are kept, but are not held to zlib's.

const Z_OK = 0, Z_STREAM_END = 1, Z_STREAM_ERROR = -2, Z_DATA_ERROR = -3, Z_BUF_ERROR = -5, Z_VERSION_ERROR = -6;

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * The rules a near miss would break, named so the gate can swap each for its neighbour and see the
 * imitation stop agreeing with zlib: the checksum's polynomial and its modulus, and the two tables
 * of deflate a decoder is most easily one off in.
 */
export const ZLIB_RULES = { crcPoly: 0xedb88320, adlerBase: 65521, lenBase: LEN_BASE, distBase: DIST_BASE };

let crcTable = null, crcPolyOf = 0;
function crcTab() {
  if (crcTable && crcPolyOf === ZLIB_RULES.crcPoly) return crcTable;
  crcPolyOf = ZLIB_RULES.crcPoly;
  crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? crcPolyOf ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return crcTable;
}
export function crc32(crc, bytes) {
  const t = crcTab();
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function adler32(adler, bytes) {
  const B = ZLIB_RULES.adlerBase;
  let a = adler & 0xffff, b = (adler >>> 16) & 0xffff;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % B; b = (b + a) % B; }
  return ((b << 16) | a) >>> 0;
}

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

/** Thrown inside a step that ran out of input; the step is undone and tried again with more. */
const MORE = Symbol('more input');

/**
 * A deflate stream expanded AS IT ARRIVES (RFC 1951; with `wrapped`, behind RFC 1950's header and
 * before its Adler-32).
 *
 * Input comes in pieces of any size -- unzip.c reads a zip member 16 KB at a time -- and a piece may
 * end anywhere, in the middle of a code. So the work is cut into STEPS that each either complete
 * or leave no trace: a block header, a stored run, the code tables, one symbol with its extra
 * bits. A step that runs dry restores the bit position it started from and waits; the bytes it had
 * not finished with are kept and the next piece is appended to them.
 *
 * `run(limit)` stops once `limit` bytes of output are waiting, so the caller's buffer is what sets
 * the pace, as with zlib.
 */
export class Inflate {
  constructor({ wrapped = false } = {}) {
    this.wrapped = wrapped;
    this.data = new Uint8Array(0); this.pos = 0; this.bitBuf = 0; this.bitCnt = 0;
    this.out = new Uint8Array(65536); this.n = 0; this.given = 0;   // out[given..n) is waiting
    this.mode = wrapped ? 'head' : 'block';
    this.last = false; this.stored = 0; this.lit = null; this.dist = null;
    this.adler = 1; this.totalIn = 0; this.totalOut = 0;
    this.error = null;
  }

  /** More input. What an unfinished step still needs is kept in front of it. */
  push(chunk) {
    const rest = this.data.length - this.pos;
    const d = new Uint8Array(rest + chunk.length);
    d.set(this.data.subarray(this.pos)); d.set(chunk, rest);
    this.data = d; this.pos = 0;
    this.totalIn += chunk.length;
  }
  /** Input handed over and not yet read (whole bytes still in front of the bit buffer). */
  get unread() { return this.data.length - this.pos; }
  get waiting() { return this.n - this.given; }

  /** Up to `max` bytes of output, in order. */
  take(max) {
    const k = Math.min(max, this.waiting);
    const piece = this.out.subarray(this.given, this.given + k);
    if (this.wrapped) this.adler = adler32(this.adler, piece);
    this.given += k; this.totalOut += k;
    return piece;
  }

  #bits(count) {
    while (this.bitCnt < count) {
      if (this.pos >= this.data.length) throw MORE;
      this.bitBuf |= this.data[this.pos++] << this.bitCnt; this.bitCnt += 8;
    }
    const v = this.bitBuf & ((1 << count) - 1);
    this.bitBuf >>>= count; this.bitCnt -= count;
    return v;
  }
  #decode(h) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.#bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('a code that is in no table');
  }
  #room(extra) {
    if (this.n + extra <= this.out.length) return;
    // Everything handed over is dropped but the 32 KB a distance may reach back into.
    const keep = Math.min(this.given, 32768), from = this.given - keep;
    const size = Math.max(this.n - from + extra, 65536) * 2;
    const bigger = new Uint8Array(size);
    bigger.set(this.out.subarray(from, this.n));
    this.out = bigger; this.n -= from; this.given -= from;
  }

  /** Decode until the stream ends, input runs out, or `limit` bytes wait. 'end' | 'more' | 'full' | 'error'. */
  run(limit = Infinity) {
    if (this.error) return 'error';
    for (;;) {
      if (this.mode === 'done') return 'end';
      // The checksum covers every byte, and is summed as bytes are taken: all of them first.
      if (this.mode === 'check' && this.waiting) return 'full';
      /*
       * Stop for want of room only once MORE is waiting than there is room for. A buffer exactly
       * as large as the data is the ordinary call -- a zip member is expanded into its recorded
       * size -- and after its last byte the stream still has an end-of-block code to read, which
       * writes nothing: zlib reads it and says Z_STREAM_END, so stopping at "full" one code early
       * would leave the caller, who has no input left to offer, with a stream that never ends.
       * The symbol decoded past the room is kept and handed over at the next call.
       */
      if (this.mode !== 'check' && this.waiting > limit) return 'full';
      const save = [this.pos, this.bitBuf, this.bitCnt];
      try {
        this.#step(limit);
      } catch (e) {
        if (e !== MORE) { this.error = e.message; return 'error'; }
        [this.pos, this.bitBuf, this.bitCnt] = save;
        return 'more';
      }
    }
  }

  #step(limit) {
    switch (this.mode) {
      case 'head': {
        const cmf = this.#bits(8), flg = this.#bits(8);
        if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31) throw new Error('incorrect header check');
        if (flg & 0x20) throw new Error('a preset dictionary is not supported');
        this.mode = 'block';
        return;
      }
      case 'block': {
        if (this.last) { this.bitBuf = 0; this.bitCnt = 0; this.mode = this.wrapped ? 'check' : 'done'; return; }
        const last = this.#bits(1), type = this.#bits(2);
        if (type === 3) throw new Error('invalid block type');
        if (type === 0) {
          this.bitBuf = 0; this.bitCnt = 0;                      // to the byte boundary
          const len = this.#bits(16), nlen = this.#bits(16);
          if ((len ^ 0xffff) !== nlen) throw new Error('invalid stored block lengths');
          this.stored = len; this.mode = 'stored';
        } else if (type === 1) {
          ({ lit: this.lit, dist: this.dist } = fixedTables()); this.mode = 'codes';
        } else {
          const nlit = this.#bits(5) + 257, ndist = this.#bits(5) + 1, ncode = this.#bits(4) + 4;
          const cl = new Uint8Array(19);
          for (let i = 0; i < ncode; i++) cl[CODE_ORDER[i]] = this.#bits(3);
          const ch = huffman(cl), lengths = new Uint8Array(nlit + ndist);
          for (let i = 0; i < nlit + ndist;) {
            const sym = this.#decode(ch);
            if (sym < 16) { lengths[i++] = sym; continue; }
            let prev = 0, rep;
            if (sym === 16) { if (!i) throw new Error('invalid bit length repeat'); prev = lengths[i - 1]; rep = 3 + this.#bits(2); }
            else if (sym === 17) rep = 3 + this.#bits(3);
            else rep = 11 + this.#bits(7);
            if (i + rep > nlit + ndist) throw new Error('invalid bit length repeat');
            while (rep--) lengths[i++] = prev;
          }
          this.lit = huffman(lengths.subarray(0, nlit)); this.dist = huffman(lengths.subarray(nlit)); this.mode = 'codes';
        }
        this.last = !!last;
        return;
      }
      case 'stored': {
        // As much of the run as is here; the bit buffer is empty, so these are whole bytes.
        const k = Math.min(this.stored, this.data.length - this.pos, Math.max(limit - this.waiting, 1));
        if (this.stored && !k) throw MORE;
        this.#room(k);
        this.out.set(this.data.subarray(this.pos, this.pos + k), this.n);
        this.n += k; this.pos += k; this.stored -= k;
        if (!this.stored) this.mode = 'block';
        return;
      }
      case 'codes': {
        const sym = this.#decode(this.lit);
        if (sym < 256) { this.#room(1); this.out[this.n++] = sym; return; }
        if (sym === 256) { this.mode = 'block'; return; }
        if (sym > 285) throw new Error('invalid literal/length code');
        const len = LEN_BASE[sym - 257] + this.#bits(LEN_EXTRA[sym - 257]);
        const ds = this.#decode(this.dist);
        if (ds > 29) throw new Error('invalid distance code');
        const d = DIST_BASE[ds] + this.#bits(DIST_EXTRA[ds]);
        this.#room(len);
        // What can be reached back into is what this stream has written and still holds.
        if (d > this.n) throw new Error('invalid distance too far back');
        for (let i = 0; i < len; i++, this.n++) this.out[this.n] = this.out[this.n - d];   // may overlap
        return;
      }
      case 'check': {
        const want = ((this.#bits(8) << 24) | (this.#bits(8) << 16) | (this.#bits(8) << 8) | this.#bits(8)) >>> 0;
        if (want !== this.adler) throw new Error('incorrect data check');
        this.mode = 'done';
        return;
      }
      default: throw new Error(`inflate: no such mode ${this.mode}`);
    }
  }
}

/** A stored-block deflate stream holding `bytes`, behind zlib's header and before its Adler-32. */
export function storedZlib(bytes) {
  const blocks = Math.max(1, Math.ceil(bytes.length / 65535));
  const out = new Uint8Array(2 + bytes.length + 5 * blocks + 4);
  let o = 0;
  out[o++] = 0x78; out[o++] = 0x01;                              // deflate, 32 KB window; check bits make it a multiple of 31
  for (let b = 0, at = 0; b < blocks; b++) {
    const len = Math.min(65535, bytes.length - at);
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = len & 255; out[o++] = len >>> 8; out[o++] = ~len & 255; out[o++] = (~len >>> 8) & 255;
    out.set(bytes.subarray(at, at + len), o); o += len; at += len;
  }
  const a = adler32(1, bytes);
  out[o++] = a >>> 24; out[o++] = (a >>> 16) & 255; out[o++] = (a >>> 8) & 255; out[o++] = a & 255;
  return out;
}

/*
 * z_stream, as an i386 compiler lays it out (56 bytes): the offsets a program writes and reads.
 * `state` is zlib's own pointer; here it holds a handle, never dereferenced by the program.
 */
const NEXT_IN = 0, AVAIL_IN = 4, TOTAL_IN = 8, NEXT_OUT = 12, AVAIL_OUT = 16, TOTAL_OUT = 20, MSG = 24, STATE = 28, ADLER = 48;

export function installZlib(M) {
  const dv = () => M.mod.dv;
  const bytes = (p, n) => M.u8.subarray(p >>> 0, (p >>> 0) + (n >>> 0));
  const streams = new Map();
  let nextHandle = 1;
  const version = M.mod.intern([...new TextEncoder().encode('1.1.3')]);

  const init = (strm, windowBits) => {
    if (!strm) return Z_STREAM_ERROR;
    // A negative window is zlib's undocumented "no header, no checksum": the form inside a zip.
    const wrapped = windowBits >= 0;
    if (Math.abs(windowBits) < 8 || Math.abs(windowBits) > 15) return Z_STREAM_ERROR;
    const handle = nextHandle++;
    streams.set(handle, new Inflate({ wrapped }));
    dv().setInt32(strm + STATE, handle, true);
    dv().setInt32(strm + MSG, 0, true);
    dv().setUint32(strm + TOTAL_IN, 0, true);
    dv().setUint32(strm + TOTAL_OUT, 0, true);
    return Z_OK;
  };

  const api = {
    zlibVersion: () => version,
    crc32: (crc, buf, len) => (buf ? crc32(crc >>> 0, bytes(buf, len)) | 0 : 0),
    adler32: (adler, buf, len) => (buf ? adler32(adler >>> 0, bytes(buf, len)) | 0 : 1),

    // The macros inflateInit and inflateInit2 expand to these, passing the header's own version.
    inflateInit_: (strm, ver, size) => (!ver || M.u8[ver] !== 0x31 || size !== 56 ? Z_VERSION_ERROR : init(strm, 15)),
    inflateInit2_: (strm, windowBits, ver, size) => (!ver || M.u8[ver] !== 0x31 || size !== 56 ? Z_VERSION_ERROR : init(strm, windowBits | 0)),

    inflate: (strm) => {
      const z = strm ? streams.get(dv().getInt32(strm + STATE, true)) : null;
      if (!z) return Z_STREAM_ERROR;
      const d = dv();
      const availIn = d.getUint32(strm + AVAIL_IN, true), availOut = d.getUint32(strm + AVAIL_OUT, true);
      const nextIn = d.getUint32(strm + NEXT_IN, true), nextOut = d.getUint32(strm + NEXT_OUT, true);
      if (availIn) z.push(bytes(nextIn, availIn).slice());
      let r, written = 0;
      for (;;) {
        r = z.run(availOut - written);
        const piece = z.take(availOut - written);
        M.u8.set(piece, nextOut + written);
        written += piece.length;
        // 'full' with room left is the stream waiting for its last bytes to be taken before its
        // checksum: they have been, so go round again.
        if (r !== 'full' || !piece.length || written >= availOut) break;
      }
      /*
       * Input the stream has not started on goes back to the caller, whose buffer still holds it --
       * but only when the stream stopped for want of ROOM, or ended. When it stopped for want of
       * INPUT it keeps what it has, a code cut in two included: zlib does the same, and unzip.c
       * counts on it, refilling next_in from the file without looking at what avail_in was left.
       */
      const back = r === 'more' ? 0 : z.unread;
      if (back) { z.data = new Uint8Array(0); z.pos = 0; z.totalIn -= back; }
      d.setUint32(strm + NEXT_IN, nextIn + availIn - back, true);
      d.setUint32(strm + AVAIL_IN, back, true);
      d.setUint32(strm + TOTAL_IN, z.totalIn, true);
      d.setUint32(strm + NEXT_OUT, nextOut + written, true);
      d.setUint32(strm + AVAIL_OUT, availOut - written, true);
      d.setUint32(strm + TOTAL_OUT, z.totalOut, true);
      if (z.wrapped) d.setUint32(strm + ADLER, z.adler, true);
      if (r === 'error') return Z_DATA_ERROR;
      if (r === 'end' && !z.waiting) return Z_STREAM_END;
      // No input read and no output written is zlib's "cannot make progress".
      return availIn - back === 0 && written === 0 ? Z_BUF_ERROR : Z_OK;
    },
    inflateEnd: (strm) => {
      const h = strm ? dv().getInt32(strm + STATE, true) : 0;
      if (!streams.delete(h)) return Z_STREAM_ERROR;
      dv().setInt32(strm + STATE, 0, true);
      return Z_OK;
    },

    uncompress: (dest, destLenP, source, sourceLen) => {
      const z = new Inflate({ wrapped: true });
      z.push(bytes(source, sourceLen).slice());
      const room = dv().getUint32(destLenP, true);
      // All of it at once, as zlib's own uncompress does with Z_FINISH: decode, hand the bytes
      // over, and only then is the checksum looked at.
      let r = z.run(Infinity);
      if (r === 'full') {
        if (z.waiting > room) return Z_BUF_ERROR;
        M.u8.set(z.take(room), dest);
        r = z.run(Infinity);
      }
      if (r === 'error') return Z_DATA_ERROR;
      if (r !== 'end') return Z_BUF_ERROR;                       // the input stops before the stream does
      dv().setUint32(destLenP, z.totalOut, true);
      return Z_OK;
    },
    compress: (dest, destLenP, source, sourceLen) => {
      const s = storedZlib(bytes(source, sourceLen));
      if (s.length > dv().getUint32(destLenP, true)) return Z_BUF_ERROR;
      M.u8.set(s, dest);
      dv().setUint32(destLenP, s.length, true);
      return Z_OK;
    },
  };
  Object.assign(M.rt, api);
  M.zlib = { streams };
  return M.zlib;
}

/** zlib.h, as much of it as the functions above answer. */
export const ZLIB_H = `#ifndef _PRISM_ZLIB_H
#define _PRISM_ZLIB_H
/* zlib's interface as far as PRISM's own environment implements it (src/env/zlib.js): the
   checksums, inflate as a stream, compress and uncompress. No deflate stream, no gz files. */
#define ZLIB_VERSION "1.1.3"
#define MAX_WBITS 15
#define MAX_MEM_LEVEL 9
typedef unsigned char Byte;
typedef unsigned int uInt;
typedef unsigned long uLong;
typedef Byte Bytef;
typedef char charf;
typedef int intf;
typedef uInt uIntf;
typedef uLong uLongf;
typedef void *voidpf;
typedef void *voidp;
typedef voidpf (*alloc_func)(voidpf opaque, uInt items, uInt size);
typedef void (*free_func)(voidpf opaque, voidpf address);
struct internal_state;
typedef struct z_stream_s {
    Bytef *next_in; uInt avail_in; uLong total_in;
    Bytef *next_out; uInt avail_out; uLong total_out;
    char *msg; struct internal_state *state;
    alloc_func zalloc; free_func zfree; voidpf opaque;
    int data_type; uLong adler; uLong reserved;
} z_stream;
typedef z_stream *z_streamp;
#define Z_NO_FLUSH 0
#define Z_PARTIAL_FLUSH 1
#define Z_SYNC_FLUSH 2
#define Z_FULL_FLUSH 3
#define Z_FINISH 4
#define Z_OK 0
#define Z_STREAM_END 1
#define Z_NEED_DICT 2
#define Z_ERRNO (-1)
#define Z_STREAM_ERROR (-2)
#define Z_DATA_ERROR (-3)
#define Z_MEM_ERROR (-4)
#define Z_BUF_ERROR (-5)
#define Z_VERSION_ERROR (-6)
#define Z_NO_COMPRESSION 0
#define Z_BEST_SPEED 1
#define Z_BEST_COMPRESSION 9
#define Z_DEFAULT_COMPRESSION (-1)
#define Z_DEFLATED 8
#define Z_NULL 0
const char *zlibVersion(void);
int inflate(z_streamp strm, int flush);
int inflateEnd(z_streamp strm);
int inflateInit_(z_streamp strm, const char *version, int stream_size);
int inflateInit2_(z_streamp strm, int windowBits, const char *version, int stream_size);
#define inflateInit(strm) inflateInit_((strm), ZLIB_VERSION, sizeof(z_stream))
#define inflateInit2(strm, windowBits) inflateInit2_((strm), (windowBits), ZLIB_VERSION, sizeof(z_stream))
int compress(Bytef *dest, uLongf *destLen, const Bytef *source, uLong sourceLen);
int uncompress(Bytef *dest, uLongf *destLen, const Bytef *source, uLong sourceLen);
uLong adler32(uLong adler, const Bytef *buf, uInt len);
uLong crc32(uLong crc, const Bytef *buf, uInt len);
#endif
`;

export function zlibBuiltins(T) {
  const I = T.INT, U = T.UINT, UL = T.ULONG, P = T.ptr(T.CHAR);
  const f = (ret, ...params) => ({ ret, params });
  return {
    zlibVersion: f(P), crc32: f(UL, UL, P, U), adler32: f(UL, UL, P, U),
    inflateInit_: f(I, P, P, I), inflateInit2_: f(I, P, I, P, I), inflate: f(I, P, I), inflateEnd: f(I, P),
    compress: f(I, P, P, P, UL), uncompress: f(I, P, P, P, UL),
  };
}
