// bench.mjs — the perf ratio, in one comparable unit.
//
// The plan forbids writing the optimiser before there is a number, and MIRAGE's lesson is blunter:
// never explain away a slow run without a baseline. So this measures the same work three ways and
// prints the ratios, with nothing hidden in the framing:
//
//   * a native i386 gcc build, in the oracle container (emulated on this host — see the caveat)
//   * PRISM's tier-0 output
//
// The workload is MAME's Z80 core executing Pac-Man's ROM: real code, integer-heavy, pointer-heavy,
// and exactly the shape the games this project targets are made of.
//
// ⚠️ The gcc side runs under linux/386 emulation on an arm64 host, so it is NOT a native-speed
// reference — it is a floor, and the true native number is higher. The ratio printed here therefore
// FLATTERS PRISM, and is reported as such. A trustworthy absolute figure needs real i386 hardware or
// a same-arch build; what this measures honestly is the direction and the order of magnitude.
//
//   node tools/bench.mjs --roms=<dir> [--steps=2000000]

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, SCRATCH, version } from './oracle.mjs';
import { compileProgram, installOSD } from '../src/compile.js';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAME = join(ROOT, 'corpus', 'mame01');
const Z80DIR = join(MAME, 'src', 'Z80');
const STEPS = +(process.argv.find(a => a.startsWith('--steps='))?.slice(8) ?? 2_000_000);
const romDir = process.argv.find(a => a.startsWith('--roms='))?.slice(7);

if (!romDir || !existsSync(romDir)) {
  console.error('usage: node tools/bench.mjs --roms=<dir with pacman.6e .6f .6h .6j> [--steps=N]');
  process.exit(2);
}

// --- the ROM image
const rom = new Uint8Array(0x4000);
{
  let off = 0;
  for (const p of ['pacman.6e', 'pacman.6f', 'pacman.6h', 'pacman.6j']) {
    const hit = readdirSync(romDir).find(f => f.toLowerCase() === p);
    if (!hit) { console.error(`missing ${p}`); process.exit(2); }
    rom.set(new Uint8Array(readFileSync(join(romDir, hit))).subarray(0, 0x1000), off);
    off += 0x1000;
  }
}

/*
 * A timing harness, distinct from z80diff.c: no per-step printing, because writing 2 million lines
 * would measure stdio rather than the CPU emulation. It runs a fixed instruction budget and prints
 * one line at the end.
 */
const BENCH_C = `
#include <stdio.h>
#include <time.h>
#include "Z80.h"

unsigned char RAM[0x20000];
int Z80_IRQ = Z80_IGNORE_INT;
static int IntVector = 0xff;

unsigned Z80_RDMEM(dword A) { return RAM[A & 0xffff]; }
void Z80_WRMEM(dword A, byte V) { RAM[A & 0xffff] = V; }
byte Z80_In(byte Port) { return 0; }
void Z80_Out(byte Port, byte Value) { if (Port == 0) IntVector = Value; }
int Z80_Interrupt(void) { return Z80_IGNORE_INT; }
void Z80_Reti(void) { }
void Z80_Retn(void) { }
void Z80_Patch(Z80_Regs *Regs) { }

int main(void)
{
  Z80_Regs R;
  FILE *f;
  long i;
  unsigned long checksum = 0;

  f = fopen("z80rom.bin", "rb");
  if (!f) { printf("NOROM\\n"); return 1; }
  fread(RAM, 1, 0x4000, f);
  fclose(f);

  Z80_Reset();
  Z80_GetRegs(&R); R.R = 0; Z80_SetRegs(&R);
  Z80_IPeriod = 1;

  for (i = 0; i < ${STEPS}L; i++)
  {
    Z80_ICount = 1;
    Z80_Execute();
  }
  /* A checksum, so neither compiler can optimise the loop away and both did the same work. */
  Z80_GetRegs(&R);
  for (i = 0; i < 0x10000; i++) checksum = checksum * 31 + RAM[i];
  printf("steps ${STEPS} pc %04x checksum %08lx\\n",
         (unsigned)(R.PC.D & 0xffff), checksum & 0xffffffffUL);
  return 0;
}
`;

const work = join(SCRATCH, 'bench');
mkdirSync(work, { recursive: true });
writeFileSync(join(work, 'z80rom.bin'), rom);
writeFileSync(join(work, 'bench.c'), BENCH_C);
for (const f of readdirSync(Z80DIR)) {
  if (/\.(c|h)$/i.test(f)) writeFileSync(join(work, f), readFileSync(join(Z80DIR, f)));
}

console.log(version().split('\n')[0]);
console.log(`workload: MAME's Z80 core, Pac-Man ROM, ${STEPS.toLocaleString('en')} instructions\n`);

// --- gcc, at -O2 (what a real build uses)
console.log('gcc -O2 …');
const g = sh('cd bench && gcc -std=gnu89 -w -O2 -DLSB_FIRST -I. -o benchref bench.c Z80.c 2>&1 && ' +
  'S=$(date +%s%N); ./benchref; E=$(date +%s%N); echo "MS $(( (E-S)/1000000 ))"', { timeout: 1800000 });
const gccMs = +(g.stdout.match(/MS (\d+)/)?.[1] ?? 0);
const gccOut = g.stdout.match(/steps .*/)?.[0] ?? '(no output)';
if (!gccMs) { console.error(`gcc side failed:\n${g.stdout}`); process.exit(1); }
console.log(`  ${gccOut}\n  ${gccMs} ms → ${(STEPS / gccMs / 1000).toFixed(2)} M instr/s`);

// --- PRISM tier-0
function resolver(name) {
  const full = join(work, name.replace(/^.*\//, ''));
  if (existsSync(full)) return { path: full, text: readFileSync(full, 'latin1') };
  const std = HEADERS[name.replace(/^.*\//, '')];
  return std === undefined ? null : { path: `<${name}>`, text: std };
}

console.log('\nPRISM tier-0 …');
const t0 = performance.now();
const prog = compileProgram([
  { file: join(work, 'bench.c'), source: BENCH_C },
  { file: join(Z80DIR, 'Z80.c'), source: readFileSync(join(Z80DIR, 'Z80.c'), 'latin1') },
], { defines: { LSB_FIRST: '1' }, resolve: resolver, memory: 64 * 1024 * 1024 });
const compileMs = performance.now() - t0;
installOSD(prog.M, { files: { 'z80rom.bin': rom } });

const t1 = performance.now();
const out = prog.run(['bench']);
const runMs = performance.now() - t1;
const ourOut = out.stdout.trim().split('\n').pop() ?? '(no output)';
console.log(`  ${ourOut}`);
console.log(`  compile ${compileMs.toFixed(0)} ms · run ${runMs.toFixed(0)} ms → ` +
  `${(STEPS / runMs / 1000).toFixed(2)} M instr/s`);

// --- the verdict
console.log('');
if (ourOut !== gccOut) {
  console.log(`⚠ the two builds did NOT do the same work — the ratio below is meaningless:`);
  console.log(`   gcc:   ${gccOut}`);
  console.log(`   prism: ${ourOut}`);
} else {
  console.log(`same checksum, so both did identical work.`);
}
console.log(`ratio: PRISM tier-0 is ${(runMs / gccMs).toFixed(1)}× slower than gcc -O2 ` +
  `AS MEASURED HERE — and the gcc side is itself emulated on this arm64 host, so the true ` +
  `native gap is LARGER than this number, not smaller.`);
console.log(`emitted JavaScript: ${(prog.src.length / 1024).toFixed(0)} KB`);
