// mame-audit.mjs — which ROM sets a directory holds, judged by the CRCs a MAME release expects.
//
// From 0.34 on, a MAME driver states the CRC-32 of every ROM it loads, and the program finds a ROM
// inside a zip by that CRC whatever the file is called. So whether a collection will run a game is
// a question about CONTENTS, answerable without running anything: this reads the release's own
// driver tables (ROM_START ... ROM_LOAD(name, offset, length, crc)) and the CRCs of what is on
// disk -- from each zip's directory, or computed for loose files -- and says, per game, what is
// there, what is missing, and what is present under another name.
//
// It reads ROMs and copies none: no ROM data is written anywhere, and nothing is fetched.
//
//   node tools/mame-audit.mjs --roms=<dir> [--release=034] [--game=name] [--all]
//
// <dir> holds one zip or one folder per game (pacman.zip, pacman/). Without --all only the games
// with at least one matching file are listed.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const RELEASE = arg('release') ?? '034';
const ROMS = arg('roms');
const ONLY = arg('game');
const ALL = process.argv.includes('--all');
const SRC = join(ROOT, 'corpus', `mame${RELEASE}`, 'src');
if (!ROMS || !existsSync(ROMS) || !existsSync(SRC)) {
  console.error('usage: node tools/mame-audit.mjs --roms=<dir> [--release=034] [--game=name] [--all]');
  process.exit(2);
}

// ---- what the release expects: every driver's name, parent and ROM list, from its own source
const drivers = new Map();       // rom table name -> [{ name, length, crc }]
const games = [];                // { name, description, table, cloneOf }
const structs = new Map();       // driver struct name -> game name
const dir = readdirSync(SRC).find((d) => d.toLowerCase() === 'drivers');
for (const f of readdirSync(join(SRC, dir)).filter((f) => /\.c$/i.test(f))) {
  const text = readFileSync(join(SRC, dir, f), 'latin1').replace(/\/\*[\s\S]*?\*\//g, ' ');
  /*
   * ROMs a table gets through a MACRO OF THE FILE. neogeo.c's NEO_BIOS_SOUND_128K(name, sum) loads
   * the game's own sound ROM and, written out in the macro's body, the system's neo-geo.rom and
   * ng-sm1.rom; NEO_SFIX_128K adds ng-sfix.rom. Leaving those out called 68 sets complete that the
   * program then refused, each for a BIOS file. So: every #define whose body names ROMs outright,
   * and those ROMs added wherever a table uses it.
   */
  const inMacro = new Map();
  for (const d of text.replace(/\\\r?\n/g, " ").matchAll(/^[ \t]*#[ \t]*define[ \t]+(\w+)\([^)]*\)(.*)$/gm)) {
    const own = [...d[2].matchAll(/ROM_LOAD\w*\s*\(\s*"([^"]+)"\s*,[^,]+,\s*([^,]+),\s*(0x[0-9a-fA-F]+|\d+)\s*\)/g)]
      .map((r) => ({ name: r[1], length: Number(r[2].trim()) || 0, crc: Number(r[3]) >>> 0 }));
    if (own.length) inMacro.set(d[1], own);
  }
  for (const m of text.matchAll(/ROM_START\(\s*(\w+)\s*\)([\s\S]*?)ROM_END/g)) {
    const roms = [];
    for (const [macro, own] of inMacro) if (new RegExp(`\\b${macro}\\s*\\(`).test(m[2])) roms.push(...own);
    for (const r of m[2].matchAll(/ROM_LOAD\w*\s*\(\s*"([^"]+)"\s*,[^,]+,\s*([^,]+),\s*(0x[0-9a-fA-F]+|\d+)\s*\)/g)) {
      roms.push({ name: r[1], length: Number(r[2].trim()) || 0, crc: Number(r[3]) >>> 0 });
    }
    // neogeo.c's own macros take the name and the CRC and supply the rest: NEO_SFIX_128K(name, sum).
    for (const r of m[2].matchAll(/\bNEO_\w+\s*\(\s*"([^"]+)"\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*\)/g)) {
      roms.push({ name: r[1], length: 0, crc: Number(r[2]) >>> 0 });
    }
    drivers.set(m[1], roms);
  }
  for (const m of text.matchAll(/struct\s+GameDriver\s+(\w+)\s*=\s*\{\s*__FILE__\s*,\s*(&\s*\w+|0)\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"([\s\S]*?)\n\};/g)) {
    const table = [...m[5].matchAll(/\b(\w+_rom)\b/g)].map((x) => x[1]).find((t) => drivers.has(t)) ?? null;
    games.push({ name: m[3], description: m[4], table, parent: m[2] === '0' ? null : m[2].replace(/[&\s]/g, ''), struct: m[1] });
    structs.set(m[1], m[3]);
  }
  // ...and its drivers, a hundred of them, are declared through NEODRIVER / NEODRIVERX: `name_driver`
  // for the game `name` (or the name NEODRIVERX gives), its ROMs in `name_rom`, a clone of the BIOS set.
  for (const m of text.matchAll(/^NEODRIVER(X?)\(\s*(\w+)\s*,(.*)$/gm)) {
    const strings = [...m[3].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    const [name, description] = m[1] ? strings : [m[2], ...strings];
    games.push({ name, description, table: drivers.has(`${m[2]}_rom`) ? `${m[2]}_rom` : null, parent: "neogeo_bios", struct: `${m[2]}_driver` });
    structs.set(`${m[2]}_driver`, name);
  }
}
for (const g of games) g.cloneOf = g.parent ? structs.get(g.parent) ?? null : null;

// ---- what is on disk: CRC -> names, per game container
const TABLE = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** The files a zip's central directory lists, with the CRC it records for each. */
function zipEntries(path) {
  const b = readFileSync(path);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) return null;
  const count = b.readUInt16LE(end + 10);
  let at = b.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count && at + 46 <= b.length && b.readUInt32LE(at) === 0x02014b50; i++) {
    const n = b.readUInt16LE(at + 28), x = b.readUInt16LE(at + 30), c = b.readUInt16LE(at + 32);
    out.push({ name: b.toString('latin1', at + 46, at + 46 + n), crc: b.readUInt32LE(at + 16), size: b.readUInt32LE(at + 24) });
    at += 46 + n + x + c;
  }
  return out;
}
const have = new Map();          // game name -> [{ name, crc, size }]
for (const f of readdirSync(ROMS)) {
  const p = join(ROMS, f);
  if (statSync(p).isDirectory()) {
    have.set(f.toLowerCase(), readdirSync(p).filter((x) => statSync(join(p, x)).isFile() && !/^readme/i.test(x) && !x.startsWith('.'))
      .map((x) => { const b = readFileSync(join(p, x)); return { name: x, crc: crc32(b), size: b.length }; }));
  } else if (/\.zip$/i.test(f)) {
    const e = zipEntries(p);
    if (e) have.set(basename(f).replace(/\.zip$/i, '').toLowerCase(), e);
  }
}

// ---- the verdict, per game: its own container first, then its parent's (a clone shares ROMs)
const hex = (c) => c.toString(16).padStart(8, '0');
let complete = 0, partial = 0, listed = 0;
const rows = [];
for (const g of games) {
  if (ONLY && g.name !== ONLY) continue;
  const want = drivers.get(g.table) ?? [];
  const pool = [...(have.get(g.name) ?? []), ...(g.cloneOf ? have.get(g.cloneOf) ?? [] : [])];
  const byCrc = new Map(pool.map((e) => [e.crc, e]));
  const found = [], renamed = [], missing = [], undumped = [];
  for (const r of want) {
    if (r.crc === 0) { undumped.push(r); continue; }              // the release itself knows no good dump
    const e = byCrc.get(r.crc);
    if (!e) missing.push(r);
    else (e.name.toLowerCase() === r.name.toLowerCase() ? found : renamed).push({ r, e });
  }
  const got = found.length + renamed.length, need = want.length - undumped.length;
  if (!got && !ALL && !ONLY) continue;
  listed++;
  const state = need && got === need ? 'COMPLETE' : got ? 'partial ' : 'absent  ';
  if (state === 'COMPLETE') complete++; else if (got) partial++;
  rows.push(`${state} ${g.name.padEnd(9)} ${String(got).padStart(3)} of ${String(need).padEnd(3)} ${renamed.length ? `(${renamed.length} under another name) ` : ''}${g.description}`);
  if ((ONLY || state === 'partial ') && missing.length) {
    rows.push(`           missing: ${missing.slice(0, ONLY ? 99 : 6).map((r) => `${r.name} ${hex(r.crc)}`).join(', ')}${!ONLY && missing.length > 6 ? `, and ${missing.length - 6} more` : ''}`);
  }
  if (ONLY) for (const { r, e } of renamed) rows.push(`           ${r.name} is here as ${e.name}`);
}
console.log(`MAME 0.${RELEASE.replace(/^0/, '')}: ${games.length} games in its drivers; ${have.size} sets in ${ROMS}`);
console.log(rows.join('\n'));
console.log(`\n${complete} complete, ${partial} partial${ALL || ONLY ? '' : `, ${games.length - listed} with nothing here (use --all to list them)`}`);
