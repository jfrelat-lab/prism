// unpack.js — a shareware archive, opened in the page as it was published.
//
// A shareware licence of the period lets the archive be passed on COMPLETE AND UNMODIFIED, not the
// files inside it. So a program whose data is such an archive (a descriptor's needsData.archive)
// receives the archive as published, and the page unpacks it here, as its installer would have.
//
// Ported from MIRAGE's src/zip.js (same author, MIT), the parts PRISM needs: a ZIP reader (stored and
// deflate, through the platform's DecompressionStream) and `deice`, for id Software's archives (DOOM
// 1.9, Heretic 1.2), which hold DEICE.EXE and a self-extracting PKZIP cut into floppy-sized pieces,
// NAME.1, NAME.2... joined back here as DEICE would, and read as the ZIP they are.

const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

async function inflateRaw(bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
  return new Uint8Array(await out.arrayBuffer());
}

/*
 * IMPLODED entries (method 6), PKZIP 1.x's: Day of the Tentacle's 1993 demo archive holds nothing
 * else. As PKWARE's APPNOTE and Info-ZIP's explode.c describe it: a sliding window of 4 or 8 KiB
 * (flag bit 1), two or three Shannon-Fano trees (bit 2: a tree for literals too), each sent as runs of
 * bit lengths. The trees are canonical codes over those lengths, read with every bit INVERTED (the
 * format's codes count down from all ones; explode.c reads ~b); a literal without a tree, the
 * literal/match flag and a distance's low bits are read as they are, least significant bit first.
 */
export function explode(src, size, flags) {
  let pos = 0, bit = 0;
  const one = () => {
    if (pos >= src.length) throw new Error('imploded data ends early');
    const b = (src[pos] >> bit) & 1;
    if (++bit === 8) { bit = 0; pos++; }
    return b;
  };
  const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v |= one() << i; return v; };
  // A tree: its byte count, then bytes of (count - 1) << 4 | (length - 1) at the byte boundary.
  const tree = (n) => {
    const lens = [];
    for (let k = src[pos++] + 1; k > 0; k--) {
      const b = src[pos++];
      for (let c = (b >> 4) + 1; c > 0; c--) lens.push((b & 15) + 1);
    }
    if (lens.length !== n) throw new Error(`imploded tree: ${lens.length} lengths, ${n} expected`);
    const count = new Array(17).fill(0);
    for (const l of lens) count[l]++;
    const offs = [0];
    for (let l = 1; l <= 16; l++) offs[l] = offs[l - 1] + count[l - 1];
    const sym = new Array(n);
    lens.forEach((l, s) => { sym[offs[l]++] = s; });
    return { count, sym };
  };
  const decode = (t) => {
    let code = 0, first = 0, index = 0;
    for (let l = 1; l <= 16; l++) {
      code |= one() ^ 1;
      const c = t.count[l];
      if (code - first < c) return t.sym[index + code - first];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('imploded data: no code matches');
  };
  const big = (flags & 2) !== 0, lit = (flags & 4) !== 0;
  const lt = lit ? tree(256) : null, len = tree(64), dist = tree(64);
  const dbits = big ? 7 : 6, minMatch = lit ? 3 : 2;
  const out = new Uint8Array(size);
  let o = 0;
  while (o < size) {
    if (one()) { out[o++] = lt ? decode(lt) : bits(8); continue; }
    const low = bits(dbits);
    const d = ((decode(dist) << dbits) | low) + 1;
    let n = decode(len);
    if (n === 63) n += bits(8);
    n += minMatch;
    // Bytes before the start of the output read as zero, as the window starts zeroed.
    for (; n > 0 && o < size; n--, o++) out[o] = o - d >= 0 ? out[o - d] : 0;
  }
  return out;
}

/** A ZIP's files, as { path, bytes }; directories are implied by the paths. */
export async function unzip(zip) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes (a comment may follow it).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported');
  const files = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== SIG_CEN) throw new Error('ZIP central directory is damaged');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    // Names of the period are CP437/ASCII; Latin-1 keeps every byte as one character.
    const name = Array.from(zip.subarray(p + 46, p + 46 + nameLen), (b) => String.fromCharCode(b)).join('');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.endsWith('\\')) continue;
    if (flags & 1) throw new Error(`${name}: encrypted ZIP entries are not supported`);
    if (dv.getUint32(local, true) !== SIG_LOC) throw new Error(`${name}: local header not found`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = zip.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data.slice();
    else if (method === 8) bytes = await inflateRaw(data);
    else if (method === 6) bytes = explode(data, size, flags);
    else throw new Error(`${name}: compression method ${method} is not supported (only stored, imploded and deflate)`);
    if (bytes.length !== size) throw new Error(`${name}: ${bytes.length} bytes unpacked, the directory says ${size}`);
    files.push({ path: name.replace(/\\/g, '/'), bytes });
  }
  return files;
}

/**
 * id's installer pieces, joined and read: DEICE.EXE beside NAME.1, NAME.2... is a self-extracting
 * PKZIP whose central directory keeps its offsets from the start of the whole .EXE, so `unzip` reads
 * the joined bytes as they stand. Anything else is returned unchanged.
 */
export async function deice(files) {
  const byName = new Map(files.map((f) => [f.path.toUpperCase(), f]));
  const deiceAt = [...byName.keys()].find((p) => p === 'DEICE.EXE' || p.endsWith('/DEICE.EXE'));
  if (deiceAt === undefined) return files;
  const dir = deiceAt.slice(0, -'DEICE.EXE'.length);
  const first = [...byName.keys()].find((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/') && p.endsWith('.1'));
  if (first === undefined) return files;
  const stem = first.slice(0, -2), pieces = [];
  for (let n = 1; byName.has(`${stem}.${n}`); n++) pieces.push(byName.get(`${stem}.${n}`).bytes);
  const whole = new Uint8Array(pieces.reduce((a, x) => a + x.length, 0));
  let at = 0; for (const x of pieces) { whole.set(x, at); at += x.length; }
  return unzip(whole);
}

// ---- .tar.gz: Unix releases of the period (Cube's cube_2005_08_29_unix.tar.gz) ----

const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

async function gunzip(bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * A tar archive's regular files, as { path, bytes }. 512-byte headers: the name at 0 (100 bytes) with
 * the ustar prefix at 345 (155), the size in octal at 124, the type at 156 ('0' or NUL a file, '5' a
 * directory); GNU's 'L' entry carries the next entry's long name. Links and devices are refused by
 * name rather than skipped, so an archive that needs them is not unpacked half.
 */
export function untar(tar) {
  const str = (at, n) => { let s = ''; for (let i = at; i < at + n && tar[i]; i++) s += String.fromCharCode(tar[i]); return s; };
  const files = [];
  let at = 0, longName = null;
  while (at + 512 <= tar.length) {
    if (tar.subarray(at, at + 512).every((b) => b === 0)) break;            // the end: two empty blocks
    const type = String.fromCharCode(tar[at + 156] || 0x30);
    const size = parseInt(str(at + 124, 12).trim() || '0', 8);
    const prefix = str(at + 257, 6).startsWith('ustar') ? str(at + 345, 155) : '';
    const name = longName ?? (prefix ? `${prefix}/${str(at, 100)}` : str(at, 100));
    const data = tar.subarray(at + 512, at + 512 + size);
    longName = null;
    if (type === 'L') longName = str(at + 512, size);
    else if (type === '0' || type === '7') files.push({ path: name.replace(/^\.\//, ''), bytes: data.slice() });
    else if (type !== '5' && type !== 'g' && type !== 'x') throw new Error(`${name}: tar entry type '${type}' is not supported (files and directories only)`);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * The files a program reads, from its archive: unpacked (and de-iced), then the ones named in
 * `pick` (by name, any directory, any case), each under the name it is listed with. With no `pick`,
 * every file, at its path in the archive.
 */
export async function unpackArchive(bytes, pick = null, root = null) {
  const files = isGzip(bytes) ? untar(await gunzip(bytes)) : await deice(await unzip(bytes));
  // `root`: only what the archive holds under this directory, named from there (Cube's cube/).
  if (root) {
    const pre = root.endsWith('/') ? root : `${root}/`;
    return Object.fromEntries(files.filter((f) => f.path.startsWith(pre)).map((f) => [f.path.slice(pre.length), f.bytes]));
  }
  if (!pick) return Object.fromEntries(files.map((f) => [f.path, f.bytes]));
  const out = {};
  for (const want of pick) {
    const f = files.find((x) => x.path.split('/').pop().toUpperCase() === want.toUpperCase());
    if (!f) throw new Error(`${want} is not in the archive`);
    out[want] = f.bytes;
  }
  return out;
}
