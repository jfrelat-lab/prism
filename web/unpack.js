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
    else throw new Error(`${name}: compression method ${method} is not supported (only stored and deflate)`);
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

/**
 * The files a program reads, from its archive: unpacked (and de-iced), then the ones named in
 * `pick` (by name, any directory, any case), each under the name it is listed with. With no `pick`,
 * every file, at its path in the archive.
 */
export async function unpackArchive(bytes, pick = null) {
  const files = await deice(await unzip(bytes));
  if (!pick) return Object.fromEntries(files.map((f) => [f.path, f.bytes]));
  const out = {};
  for (const want of pick) {
    const f = files.find((x) => x.path.split('/').pop().toUpperCase() === want.toUpperCase());
    if (!f) throw new Error(`${want} is not in the archive`);
    out[want] = f.bytes;
  }
  return out;
}
