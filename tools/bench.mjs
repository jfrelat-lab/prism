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
import { spawnSync } from 'node:child_process';
import { sh, SCRATCH, version } from './oracle.mjs';
import { compileProgram } from '../src/compile.js';
import { installStdio } from '../src/env/stdio.js';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAME = join(ROOT, 'corpus', 'mame01');
const Z80DIR = join(MAME, 'src', 'Z80');
const STEPS = +(process.argv.find(a => a.startsWith('--steps='))?.slice(8) ?? 2_000_000);
const romDir = process.argv.find(a => a.startsWith('--roms='))?.slice(7);

if (!romDir && !process.argv.includes('--synthetic')) {
  console.error('usage: node tools/bench.mjs --roms=<dir with pacman.6e .6f .6h .6j> [--steps=N]\n' +
    '   or: node tools/bench.mjs --synthetic [--steps=N]');
  process.exit(2);
}

/*
 * --synthetic: a Z80 program written HERE instead of a game ROM.
 *
 * The headline performance number used to need copyrighted data, which meant it could not be
 * reproduced on a fresh clone -- a gate nobody else can run is a claim, not a measurement. This is
 * a mix chosen to exercise the paths a real ROM exercises rather than to look fast: memory read and
 * write, 8- and 16-bit ALU with flags, a taken branch, a call and a return.
 *
 *   0000  31 00 20   LD SP,2000h
 *   0003  21 00 30   LD HL,3000h     ; a RAM pointer
 *   0006  01 34 12   LD BC,1234h
 *   0009  11 78 56   LD DE,5678h
 *   000C  7E         LD A,(HL)
 *   000D  3C         INC A
 *   000E  77         LD (HL),A
 *   000F  09         ADD HL,BC
 *   0010  EB         EX DE,HL
 *   0011  CD 20 00   CALL 0020h
 *   0014  A9         XOR C
 *   0015  FE 40      CP 40h
 *   0017  20 F3      JR NZ,000Ch     ; the hot loop
 *   0019  C3 03 00   JP 0003h
 *   0020  0C         INC C
 *   0021  C9         RET
 *
 * NOT comparable to the ROM-driven number: it is a different workload, and both are published
 * separately rather than blended.
 */
const SYNTHETIC = [
  0x31, 0x00, 0x20, 0x21, 0x00, 0x30, 0x01, 0x34, 0x12, 0x11, 0x78, 0x56,
  0x7E, 0x3C, 0x77, 0x09, 0xEB, 0xCD, 0x20, 0x00, 0xA9, 0xFE, 0x40, 0x20, 0xF3,
  0xC3, 0x03, 0x00,
];

// --- the ROM image
const rom = new Uint8Array(0x4000);
if (romDir) {
  let off = 0;
  for (const p of ['pacman.6e', 'pacman.6f', 'pacman.6h', 'pacman.6j']) {
    const hit = readdirSync(romDir).find(f => f.toLowerCase() === p);
    if (!hit) { console.error(`missing ${p}`); process.exit(2); }
    rom.set(new Uint8Array(readFileSync(join(romDir, hit))).subarray(0, 0x1000), off);
    off += 0x1000;
  }
} else {
  rom.set(SYNTHETIC, 0);
  rom[0x20] = 0x0C; rom[0x21] = 0xC9;      // INC C / RET, at the CALL target
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

/*
 * The native builds time THEMSELVES. Timing them from outside with spawnSync measured process
 * creation and OS scheduling as well as the work, and it showed the same binary running at 36, 79
 * and 115 M instr/s on three consecutive workloads — a 3x spread that was the harness, not the
 * machine. PRISM is already measured in-process, so this makes the two sides comparable.
 *
 * PRISM does not define BENCH_REALTIME: its clock() is a deterministic counter on purpose.
 */
#ifdef BENCH_REALTIME
#include <sys/time.h>
static double now_ms(void)
{
  struct timeval tv;
  gettimeofday(&tv, 0);
  return tv.tv_sec * 1000.0 + tv.tv_usec / 1000.0;
}
#endif

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

#ifdef BENCH_REALTIME
  { double t0 = now_ms();
#endif
  for (i = 0; i < ${STEPS}L; i++)
  {
    Z80_ICount = 1;
    Z80_Execute();
  }
#ifdef BENCH_REALTIME
  printf("elapsed %.1f\\n", now_ms() - t0); }
#endif
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
const g = sh('cd bench && gcc -std=gnu89 -w -O2 -DLSB_FIRST -DBENCH_REALTIME -I. ' +
  '-o benchref bench.c Z80.c 2>&1 && ./benchref', { timeout: 1800000 });
const gccMs = Math.round(+(g.stdout.match(/elapsed ([\d.]+)/)?.[1] ?? 0));
const gccOut = g.stdout.match(/steps .*/)?.[0] ?? '(no output)';
if (!gccMs) { console.error(`gcc side failed:\n${g.stdout}`); process.exit(1); }
console.log(`  ${gccOut}\n  ${gccMs} ms → ${(STEPS / gccMs / 1000).toFixed(2)} M instr/s`);

// --- a NATIVE reference on this host's own CPU.
//
// The containerised gcc above is i386 under emulation, which makes it a floor rather than a
// reference: comparing JavaScript running natively against emulated machine code flatters the
// JavaScript. clang builds the same C for arm64 and runs it on the same core PRISM's JIT runs on, so
// this is the ratio that actually answers "how much does compiling to JavaScript cost".
//
// The caveat that remains, stated rather than buried: this build is LP64, so `int` is still 32 bits
// but pointers are 64. It is the same algorithm on the same silicon, not the same ABI.
console.log('\nclang -O2, native on this host …');
let nativeMs = 0, nativeOut = '(not run)';
{
  const nat = join(work, 'native');
  mkdirSync(nat, { recursive: true });
  for (const f of readdirSync(work)) {
    if (/\.(c|h)$/i.test(f)) writeFileSync(join(nat, f), readFileSync(join(work, f)));
  }
  writeFileSync(join(nat, 'z80rom.bin'), rom);
  const r2 = spawnSync('sh', ['-c',
    `cd ${nat} && clang -std=gnu89 -w -O2 -DLSB_FIRST -DBENCH_REALTIME -I. -o benchnat bench.c Z80.c 2>&1`],
    { encoding: 'utf8' });
  if (r2.status !== 0) {
    console.log(`  clang side unavailable: ${(r2.stdout || r2.stderr || '').split('\n')[0]}`);
  } else {
    // Best of three: the point is the machine's capability, not a sample of its scheduler.
    let best = Infinity, last = '';
    for (let k = 0; k < 3; k++) {
      const run = spawnSync('sh', ['-c', `cd ${nat} && ./benchnat`], { encoding: 'utf8' });
      const ms = +((run.stdout || '').match(/elapsed ([\d.]+)/)?.[1] ?? Infinity);
      if (ms < best) best = ms;
      last = (run.stdout || '').split('\n').find(l => l.startsWith('steps')) ?? last;
    }
    nativeMs = best;
    nativeOut = last;
    console.log(`  ${nativeOut}\n  ${nativeMs.toFixed(0)} ms (best of 3, self-timed) → ` +
      `${(STEPS / nativeMs / 1000).toFixed(2)} M instr/s`);
  }
}

// --- PRISM tier-0
function resolver(name) {
  const full = join(work, name.replace(/^.*\//, ''));
  if (existsSync(full)) return { path: full, text: readFileSync(full, 'latin1') };
  const std = HEADERS[name] ?? HEADERS[name.replace(/^.*\//, '')];
  return std === undefined ? null : { path: `<${name}>`, text: std };
}

console.log(`\nPRISM tier-0${process.argv.includes('--direct-calls') ? ' (direct calls)' : ''} …`);
const t0 = performance.now();
const prog = compileProgram([
  { file: join(work, 'bench.c'), source: BENCH_C },
  { file: join(Z80DIR, 'Z80.c'), source: readFileSync(join(Z80DIR, 'Z80.c'), 'latin1') },
], {
  defines: { LSB_FIRST: '1' }, resolve: resolver, memory: 64 * 1024 * 1024,
  // --direct-calls: the dispatch experiment. See docs/TESTING.md; off by default.
  directCalls: process.argv.includes('--direct-calls'),
});
const compileMs = performance.now() - t0;
installStdio(prog.M, { files: { 'z80rom.bin': rom } });

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
console.log(`vs the containerised gcc -O2 (i386 EMULATED — a floor, not a reference): ` +
  `${(runMs / gccMs).toFixed(2)}×`);
if (nativeMs) {
  const ratio = runMs / nativeMs;
  console.log(`vs clang -O2 NATIVE on this host: PRISM tier-0 is ${ratio.toFixed(1)}× slower.`);
  console.log(`  ^ this is the number that means something. Same algorithm, same silicon.`);
  if (nativeOut !== ourOut) {
    console.log(`  ⚠ the native build's checksum differs (${nativeOut}) — it is LP64, so a program`);
    console.log(`    that depends on pointer width legitimately diverges; the TIMING is still valid.`);
  }
}
console.log(`emitted JavaScript: ${(prog.src.length / 1024).toFixed(0)} KB`);
