// keen-static.mjs — the static resources a Keen Dreams data set was built with, taken from its own
// KDREAMS.EXE, for the ones that differ from the source tree's static/.
//
// The source release is 1.93 and its static/ holds 1.93's linked resources. The freely distributed
// shareware is 1.13, whose KDREAMS.MAP was saved differently: its map headers sit a few bytes away
// from where 1.93's MAPHEAD says, and are Huffman-coded with a different MAPDICT, so the 1.93 build
// reads garbage as a map header (Keen then filled mapbwidthtable 5,000 entries long, over
// SoundUserHook). README.md says it: "ensure that the proper static data files are being linked".
//
// This unpacks the executable (tools/lzexe.mjs), reports which of static/'s files it contains byte
// for byte, finds its own MAPHEAD (the RLEW tag, then 100 offsets inside KDREAMS.MAP) and MAPDICT
// (the dictionary that decodes those headers into printable map names), and writes the two into
// --out. Nothing it writes belongs in this repository: it is the user's data.
//
//   node tools/keen-static.mjs --data=~/Projects/keendreams-data [--out=<data dir>/static]
//   node tools/keen.mjs --data=... --static=<that dir>
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlzexe } from './lzexe.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATIC = join(ROOT, 'corpus', 'KeenDreams', 'static');
const arg = (k, d = null) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const home = (p) => p.replace(/^~/, process.env.HOME ?? '');
const data = home(arg('data') ?? '');
if (!data) { console.error('--data=<directory with KDREAMS.EXE and KDREAMS.MAP> is required'); process.exit(2); }
const out = home(arg('out', join(data, 'static')));
const find = (name) => readdirSync(data).find((f) => f.toUpperCase() === name);
const img = unlzexe(readFileSync(join(data, find('KDREAMS.EXE'))));
const map = readFileSync(join(data, find('KDREAMS.MAP')));
console.log(`KDREAMS.EXE unpacked: ${img.length} bytes`);

for (const f of readdirSync(STATIC).filter((x) => x.endsWith('.KDR')).sort()) {
  const at = img.indexOf(readFileSync(join(STATIC, f)));
  console.log(`  ${f.padEnd(14)} ${at >= 0 ? `the same as static/ (at ${at})` : 'differs, or is not linked in this build'}`);
}

const mapHeadSize = readFileSync(join(STATIC, 'MAPHEAD.KDR')).length;
const heads = [];
for (let i = 0; i + 402 < img.length; i++) {
  if (img.readUInt16LE(i) !== 0xabcd) continue;
  let ok = true, used = 0;
  for (let k = 0; k < 100 && ok; k++) {
    const v = img.readInt32LE(i + 2 + 4 * k);
    if (v === 0 || v === -1) continue;
    if (v < 0 || v >= map.length) ok = false; else used++;
  }
  if (ok && used) heads.push(i);
}
const decode = (dict, pos) => {
  const out = [];
  let n = 254, i = pos, bit = 0;
  while (out.length < 38 && i < map.length) {
    const b = (map[i] >> bit) & 1;
    if (++bit === 8) { bit = 0; i++; }
    const v = img.readUInt16LE(dict + n * 4 + b * 2);
    if (v < 256) { out.push(v); n = 254; } else if (v < 510) n = v - 256; else return null;
  }
  return out.length === 38 ? Buffer.from(out) : null;
};
for (const h of heads) {
  const first = img.readInt32LE(h + 2);
  for (let d = 0; d + 1020 <= img.length; d++) {
    const hd = decode(d, first);
    if (!hd) continue;
    // A real header: every map decodes to a size a map can have and a name with letters in it.
    const sane = (x) => {
      if (!x) return null;
      const w = x.readUInt16LE(18), ht = x.readUInt16LE(20);
      const name = x.subarray(22, 38).toString('latin1').replace(/\0.*$/s, '');
      return w >= 1 && w <= 256 && ht >= 1 && ht <= 256 && /^[ -~]+$/.test(name) && /[A-Za-z]{3}/.test(name) ? name : null;
    };
    if (!sane(hd)) continue;
    const names = [];
    for (let m = 0; m < 100; m++) {
      const off = img.readInt32LE(h + 2 + 4 * m);
      if (off <= 0) continue;
      names.push(sane(decode(d, off)));
    }
    if (names.some((n) => n === null)) continue;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'MAPHEAD.KDR'), img.subarray(h, h + mapHeadSize));
    writeFileSync(join(out, 'MAPDICT.KDR'), img.subarray(d, d + 1020));
    console.log(`MAPHEAD at ${h}, MAPDICT at ${d}: ${names.length} maps -- ${names.join(', ')}`);
    console.log(`written to ${out}`);
    process.exit(0);
  }
}
console.log('no MAPHEAD/MAPDICT pair decodes this KDREAMS.MAP');
process.exit(1);
