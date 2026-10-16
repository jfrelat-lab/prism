// gate-unpack.mjs — the page's archive reader against the files the archives were made from.
//
// web/unpack.js opens, in the page, the archives a static export ships whole: ZIP entries stored,
// deflated or IMPLODED (method 6, PKZIP 1.x: Day of the Tentacle's 1993 demo), with no library behind
// it. The reference is not a second unzip but the files themselves: the ScummVM project's three
// LucasArts demo archives (in <games>/scumm-demos/) were checked to hold exactly the loose copies in
// <games>/scumm/<demo>/, so every entry unpacked here must equal its loose file, byte for byte.
//
// And it has to be able to fail: an imploded entry read with the other window size (flag bit 1
// flipped) must not come out as the file.
//
//   node tools/gate-unpack.mjs [--games=~/games]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { unzip, explode } from '../web/unpack.js';
import { skip } from './gate-skip.mjs';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const GAMES = (arg('games') ?? join(homedir(), 'games')).replace(/^~/, homedir());
const SETS = [
  ['dott-dos-ni-demo-en.zip', 'dott-demo'],          // imploded, both window sizes
  ['monkey1-dos-ega-demo-en.zip', 'monkey1-ega-demo'],
  ['samnmax-dos-demo-en.zip', 'samnmax-demo'],
];
if (!SETS.every(([z, d]) => existsSync(join(GAMES, 'scumm-demos', z)) && existsSync(join(GAMES, 'scumm', d)))) {
  skip('the ScummVM demo archives and their loose copies are not in the games directory',
    'downloads.scummvm.org/frs/demos/scumm/ into <games>/scumm-demos/, unpacked into <games>/scumm/<demo>/');
}

let bad = 0;
const check = (ok, text, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}${!ok && detail ? `\n     ${detail}` : ''}`); if (!ok) bad++; };

for (const [zip, dir] of SETS) {
  const files = await unzip(new Uint8Array(readFileSync(join(GAMES, 'scumm-demos', zip))));
  const differ = files.filter((f) => Buffer.compare(Buffer.from(f.bytes), readFileSync(join(GAMES, 'scumm', dir, f.path))) !== 0);
  check(files.length > 0 && differ.length === 0, `${zip}: ${files.length - differ.length} of ${files.length} entries equal to the loose files`, differ.map((f) => f.path).join(', '));
}

// The control: DOTTDEMO.001, imploded, read with the other window size.
const raw = new Uint8Array(readFileSync(join(GAMES, 'scumm-demos', SETS[0][0])));
const dv = new DataView(raw.buffer);
let p = 0, hit = null;
while (dv.getUint32(p, true) === 0x04034b50) {
  const flags = dv.getUint16(p + 6, true), method = dv.getUint16(p + 8, true), csize = dv.getUint32(p + 18, true), size = dv.getUint32(p + 22, true);
  const nlen = dv.getUint16(p + 26, true), xlen = dv.getUint16(p + 28, true);
  const name = String.fromCharCode(...raw.subarray(p + 30, p + 30 + nlen));
  const data = raw.subarray(p + 30 + nlen + xlen, p + 30 + nlen + xlen + csize);
  if (method === 6 && name === 'DOTTDEMO.001') hit = { flags, data, size, name };
  p += 30 + nlen + xlen + csize;
}
let wrong;
try { wrong = explode(hit.data, hit.size, hit.flags ^ 2); } catch { wrong = null; }
const loose = readFileSync(join(GAMES, 'scumm', SETS[0][1], hit.name));
check(!wrong || Buffer.compare(Buffer.from(wrong), loose) !== 0, `control: ${hit.name} exploded with the other window size is not the file`);

console.log(bad ? `\n${bad} check(s) failed` : '\nthe page unpacks stored, deflated and imploded ZIP entries as the files they were made from');
process.exit(bad ? 1 : 0);
