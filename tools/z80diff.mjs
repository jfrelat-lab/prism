// z80diff.mjs — find the instruction PRISM gets wrong in MAME's Z80 core.
//
// Builds tools/z80diff/z80diff.c + MAME's Z80.c twice — once with a real i386 gcc in the oracle
// container, once with PRISM — drives both from the same ROM image, and reports the first step where
// the register files disagree. Same shape as MIRAGE's Unicorn co-simulator: with the same initial
// state, any divergence is a compiler bug and nothing else.
//
//   node tools/z80diff.mjs --roms=/path/to/pacman
//
// The ROM never leaves the machine it came from: it is copied into .oracle/ (gitignored) so the
// container can read the same bytes, and nothing about it is committed.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, SCRATCH, version } from './oracle.mjs';
import { compileProgram, installOSD } from '../src/compile.js';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAME = join(ROOT, 'corpus', 'mame01');
const Z80DIR = join(MAME, 'src', 'Z80');

const romDir = process.argv.find(a => a.startsWith('--roms='))?.slice(7);
if (!romDir || !existsSync(romDir)) {
  console.error('usage: node tools/z80diff.mjs --roms=<dir containing pacman.6e .6f .6h .6j>');
  process.exit(2);
}

// --- the ROM image: the four code ROMs concatenated, which is what the Z80 sees at 0x0000
const parts = ['pacman.6e', 'pacman.6f', 'pacman.6h', 'pacman.6j'];
const rom = new Uint8Array(0x4000);
{
  let off = 0;
  for (const p of parts) {
    const hit = readdirSync(romDir).find(f => f.toLowerCase() === p);
    if (!hit) { console.error(`missing ${p} in ${romDir}`); process.exit(2); }
    const bytes = new Uint8Array(readFileSync(join(romDir, hit)));
    rom.set(bytes.subarray(0, 0x1000), off);
    off += 0x1000;
  }
}
console.log(`${version().split('\n')[0]}\nROM image ${rom.length} bytes, entry ` +
  [...rom.subarray(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(' '));

// --- the gcc side, in the oracle container
const work = join(SCRATCH, 'z80diff');
mkdirSync(work, { recursive: true });
writeFileSync(join(work, 'z80rom.bin'), rom);
writeFileSync(join(work, 'z80diff.c'), readFileSync(join(ROOT, 'tools', 'z80diff', 'z80diff.c')));
for (const f of readdirSync(Z80DIR)) {
  if (/\.(c|h)$/i.test(f)) writeFileSync(join(work, f), readFileSync(join(Z80DIR, f)));
}

console.log('building the reference with gcc…');
const r = sh('cd z80diff && gcc -std=gnu89 -w -DLSB_FIRST -I. -o z80ref z80diff.c Z80.c 2>&1 && ' +
  './z80ref > ref.txt 2>&1; echo "RC $?"; wc -l < ref.txt', { timeout: 900000 });
if (!/RC 0/.test(r.stdout)) {
  console.error(`gcc side failed:\n${r.stdout}\n${r.stderr}`);
  process.exit(1);
}
const ref = readFileSync(join(work, 'ref.txt'), 'utf8').trim().split('\n');
console.log(`reference: ${ref.length} lines`);

// --- the PRISM side
function resolver(name, angled, fromFile) {
  for (const d of [work, Z80DIR, join(MAME, 'src')]) {
    const full = join(d, name);
    if (existsSync(full)) return { path: full, text: readFileSync(full, 'latin1') };
  }
  const std = HEADERS[name];
  return std === undefined ? null : { path: `<${name}>`, text: std };
}

console.log('building the same source with PRISM…');
const units = [
  { file: join(work, 'z80diff.c'), source: readFileSync(join(work, 'z80diff.c'), 'latin1') },
  { file: join(Z80DIR, 'Z80.c'), source: readFileSync(join(Z80DIR, 'Z80.c'), 'latin1') },
];
let prog;
try {
  prog = compileProgram(units, { defines: { LSB_FIRST: '1' }, resolve: resolver, memory: 64 * 1024 * 1024 });
} catch (e) {
  console.error(`PRISM side failed to build: ${e.message.split('\n')[0]}`);
  process.exit(1);
}
installOSD(prog.M, { files: { 'z80rom.bin': rom } });

let out;
try {
  out = prog.run(['z80diff']);
} catch (e) {
  console.error(`PRISM side threw: ${e.message}`);
  process.exit(1);
}
const ours = out.stdout.trim().split('\n');
console.log(`PRISM:     ${ours.length} lines (exit ${out.code})`);

// --- the diff
let bad = -1;
for (let i = 0; i < Math.max(ref.length, ours.length); i++) {
  if (ref[i] !== ours[i]) { bad = i; break; }
}
if (bad < 0) {
  console.log(`\n✓ identical over ${ref.length} steps — the Z80 core is compiled correctly.`);
  process.exit(0);
}

console.log(`\n✗ first divergence at output line ${bad}:`);
for (let i = Math.max(0, bad - 4); i <= Math.min(bad + 1, Math.max(ref.length, ours.length) - 1); i++) {
  const mark = i === bad ? '>>' : '  ';
  console.log(`${mark} gcc   ${ref[i] ?? '(end)'}`);
  console.log(`${mark} prism ${ours[i] ?? '(end)'}`);
}

// The offending instruction is the one executed to produce the diverging line: disassembling is out
// of scope here, but the PC on the PREVIOUS line is where it lives.
const prev = (ref[bad - 1] ?? '').match(/PC=([0-9a-f]{4})/);
if (prev) {
  const pc = parseInt(prev[1], 16);
  const bytes = [...rom.subarray(pc, pc + 6)].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`\nthe instruction at PC=${prev[1]} is the suspect; bytes there: ${bytes}`);
}
process.exit(1);
