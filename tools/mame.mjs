// mame.mjs — build and run MAME 0.1 (Nicola Salmoria, 1997) from its unmodified source.
//
// MAME 0.1 has a clean platform boundary: osdepend.h declares eighteen functions and the whole
// Allegro dependency lives in src/msdos/msdos.c, which the makefile already selects per platform
// (`obj/osdepend.o: src/msdos/msdos.c`). PRISM therefore supplies its own backend for those
// functions and compiles every other file untouched — that is what the abstraction is for, and it is
// the same boundary the project draws everywhere else: the shim sits outside the game's own code.
//
// Built WITHOUT -DX86_ASM, which is a build option, not a source change: Z80.c guards its x86
// assembly behind it and has the C path underneath.
//
//   node tools/mame.mjs            # report what the build is missing, ranked
//   node tools/mame.mjs --run      # run it
//   node tools/mame.mjs --src      # dump the emitted JavaScript

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram } from '../src/compile.js';
import { installAllegro, ALLEGRO_VARS } from '../src/env/allegro.js';
import { installStdio } from '../src/env/stdio.js';
import { installPorts } from '../src/env/ports.js';
import { installSpinDamping } from '../src/runtime/runtime.js';
import { HEADERS } from '../src/env/headers.js';
import { writeIndexedPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/*
 * WHICH RELEASE. Three of them are in the corpus and they are the same program five months apart --
 * running one and calling it "MAME" hid the other two, and 0.3 is the one that adds a driver with
 * video hardware of its own (Donkey Kong) rather than another Pac-Man derivative.
 *
 * The unit list comes from each makefile's own OBJS, so it is transcribed once per release rather
 * than guessed: 0.1 and 0.2 have a `machine.c` per driver that 0.3 mostly dropped.
 */
const RELEASE = process.argv.find(a => a.startsWith('--release='))?.slice(10) ?? '01';
const SRC = join(ROOT, 'corpus', `mame${RELEASE}`);

if (!existsSync(join(SRC, 'src'))) {
  console.error(`corpus missing: ${SRC}\nFetch it with:\n` +
    `  curl -sL https://downloads.sourceforge.net/mame/mame${RELEASE}.zip -o /tmp/mame${RELEASE}.zip\n` +
    `  mkdir -p corpus/mame${RELEASE} && (cd corpus/mame${RELEASE} && unzip -qo /tmp/mame${RELEASE}.zip)`);
  process.exit(2);
}

// The makefile's own object list, minus the platform backend PRISM replaces.
const UNITS_BY_RELEASE = {
  '02': [
    'src/mame.c', 'src/common.c', 'src/machine.c', 'src/driver.c',
    'src/pacman/machine.c', 'src/pacman/vidhrdw.c', 'src/pacman/driver.c',
    'src/crush/machine.c', 'src/crush/driver.c',
    'src/pengo/machine.c', 'src/pengo/vidhrdw.c', 'src/pengo/sndhrdw.c', 'src/pengo/driver.c',
    'src/ladybug/machine.c', 'src/ladybug/vidhrdw.c', 'src/ladybug/sndhrdw.c', 'src/ladybug/driver.c',
    'src/mrdo/machine.c', 'src/mrdo/vidhrdw.c', 'src/mrdo/driver.c',
    'src/cclimber/vidhrdw.c', 'src/cclimber/sndhrdw.c', 'src/cclimber/driver.c',
    'src/z80/z80.c', 'src/msdos/msdos.c',
  ],
  '04': [
    'src/mame.c', 'src/common.c', 'src/machine.c', 'src/driver.c',
    'src/pacman/machine.c', 'src/pacman/vidhrdw.c', 'src/pacman/driver.c',
    'src/crush/driver.c',
    'src/pengo/vidhrdw.c', 'src/pengo/sndhrdw.c', 'src/pengo/driver.c',
    'src/ladybug/machine.c', 'src/ladybug/vidhrdw.c', 'src/ladybug/sndhrdw.c', 'src/ladybug/driver.c',
    'src/mrdo/machine.c', 'src/mrdo/vidhrdw.c', 'src/mrdo/driver.c',
    'src/cclimber/vidhrdw.c', 'src/cclimber/sndhrdw.c', 'src/cclimber/driver.c',
    'src/ckong/vidhrdw.c', 'src/ckong/driver.c',
    'src/dkong/vidhrdw.c', 'src/dkong/driver.c',
    'src/bagman/machine.c', 'src/bagman/vidhrdw.c', 'src/bagman/driver.c',
    'src/wow/vidhrdw.c', 'src/wow/driver.c',
    'src/z80/z80.c', 'src/msdos/msdos.c',
  ],
  '03': [
    'src/mame.c', 'src/common.c', 'src/machine.c', 'src/driver.c',
    'src/pacman/machine.c', 'src/pacman/vidhrdw.c', 'src/pacman/driver.c',
    'src/crush/driver.c',
    'src/pengo/vidhrdw.c', 'src/pengo/sndhrdw.c', 'src/pengo/driver.c',
    'src/ladybug/machine.c', 'src/ladybug/vidhrdw.c', 'src/ladybug/sndhrdw.c', 'src/ladybug/driver.c',
    'src/mrdo/machine.c', 'src/mrdo/vidhrdw.c', 'src/mrdo/driver.c',
    'src/cclimber/vidhrdw.c', 'src/cclimber/sndhrdw.c', 'src/cclimber/driver.c',
    'src/ckong/vidhrdw.c', 'src/ckong/driver.c',
    'src/dkong/vidhrdw.c', 'src/dkong/driver.c',
    'src/z80/z80.c', 'src/msdos/msdos.c',
  ],
};

const UNITS = UNITS_BY_RELEASE[RELEASE] ?? [
  'src/mame.c', 'src/common.c', 'src/machine.c', 'src/driver.c',
  'src/Z80/Z80.c',
  'src/pacman/machine.c', 'src/pacman/driver.c',
  'src/crush/machine.c', 'src/crush/driver.c',
  'src/pengo/machine.c', 'src/pengo/vidhrdw.c', 'src/pengo/sndhrdw.c', 'src/pengo/driver.c',
  'src/ladybug/machine.c', 'src/ladybug/vidhrdw.c', 'src/ladybug/sndhrdw.c', 'src/ladybug/driver.c',
  // MAME's OWN platform backend, the file its makefile selects for DOS. It used to be replaced by a
  // JavaScript one; what is shimmed now is the two libraries it links (src/env/allegro.js).
  'src/msdos/msdos.c',
];

const INCLUDE_DIRS = ['src', 'src/Z80', 'src/msdos'];

/** Serve the game's own headers from the corpus, and the hosted-C ones from PRISM. */
function resolver(name, angled, fromFile) {
  if (!angled && fromFile) {
    const local = join(dirname(fromFile), name);
    if (existsSync(local) && statSync(local).isFile()) {
      return { path: local, text: readFileSync(local, 'latin1') };
    }
  }
  for (const d of INCLUDE_DIRS) {
    const full = join(SRC, d, name);
    if (existsSync(full) && statSync(full).isFile()) {
      return { path: full, text: readFileSync(full, 'latin1') };
    }
    // The tree mixes cases (src/Z80 vs -Isrc/z80 in the makefile).
    const dir = join(SRC, d);
    if (existsSync(dir)) {
      const hit = readdirSync(dir).find(f => f.toLowerCase() === name.toLowerCase());
      if (hit) {
        const p = join(dir, hit);
        if (statSync(p).isFile()) return { path: p, text: readFileSync(p, 'latin1') };
      }
    }
  }
  const std = HEADERS[name] ?? HEADERS[name.replace(/^.*\//, '')];
  if (std !== undefined) return { path: `<${name}>`, text: std };
  // Diagnostic mode: stub what is missing and record it, so ONE run reports every absent header
  // instead of dying on the first. Never silent — the names are printed.
  missingHeaders.add(name);
  return { path: `<missing:${name}>`, text: '' };
}

const missingHeaders = new Set();

/*
 * A hand-assembled Z80 program, standing in for the (copyrighted) pacman.6e.
 *
 * This proves MORE than a game ROM would, because the opcodes are known and so is the expected
 * effect. It fills Pac-Man's video RAM at 0x4000 and its colour RAM at 0x4400, so a run that draws
 * non-zero pixels has exercised the Z80 core, the memory-map dispatch and the video path — with data
 * authored here rather than obtained.
 *
 *   0000  21 00 40   LD HL,4000h      ; video RAM
 *   0003  11 00 44   LD DE,4400h      ; colour RAM
 *   0006  06 40      LD B,40h         ; 64 cells
 *   0008  3E 10      LD A,10h         ; a character code
 *   000A  77         LD (HL),A
 *   000B  3E 01      LD A,01h         ; colour 1
 *   000D  12         LD (DE),A
 *   000E  23         INC HL
 *   000F  13         INC DE
 *   0010  10 F6      DJNZ 0008h       ; -10 relative to 0x0012
 *   0012  18 FE      JR 0012h         ; spin
 */
const Z80_TEST = [
  0x21, 0x00, 0x40, 0x11, 0x00, 0x44, 0x06, 0x40,
  0x3E, 0x10, 0x77, 0x3E, 0x01, 0x12, 0x23, 0x13,
  0x10, 0xF6, 0x18, 0xFE,
];

function testRoms() {
  const code = new Uint8Array(0x1000);
  code.set(Z80_TEST, 0);
  const zeros = () => new Uint8Array(0x1000);
  const solid = () => new Uint8Array(0x1000).fill(0xff);   // solid glyphs, so writes are visible
  return {
    'pacman.6e': code, 'pacman.6f': zeros(), 'pacman.6h': zeros(), 'pacman.6j': zeros(),
    'pacman.5e': solid(), 'pacman.5f': solid(),
  };
}

const units = UNITS.map(f => {
  const full = join(SRC, f);
  if (!existsSync(full)) throw new Error(`missing unit ${f}`);
  return { file: full, source: readFileSync(full, 'latin1') };
});

// Allegro's DATA. The behaviour is in src/env/allegro.js; `screen` and `key[]` have to be real
// objects with external linkage because msdos.c takes their address and indexes them.
units.push({ file: 'prism-allegro-vars.c', source: ALLEGRO_VARS });

console.log(`MAME 0.${RELEASE.replace(/^0/, '')} — ${units.length} translation units, ` +
  `${units.reduce((n, u) => n + u.source.split('\n').length, 0)} lines`);

let program;
try {
  program = compileProgram(units, {
    defines: { LSB_FIRST: '1' },       // NOT X86_ASM: that selects the x86 assembly path
    resolve: resolver,
    memory: 256 * 1024 * 1024,
  });
} catch (e) {
  if (missingHeaders.size) console.log(`\nheaders stubbed: ${[...missingHeaders].join(' ')}`);
  console.log(`\n✗ build failed:\n  ${String(e.message).split('\n').slice(0, 6).join('\n  ')}`);
  process.exit(1);
}

if (missingHeaders.size) console.log(`headers stubbed (empty): ${[...missingHeaders].join(' ')}`);
// Wire the platform backend. ROMs come from the corpus directories if they are present; without
// them MAME reports the missing files, which is itself a real signal.
const roms = {};
for (const dir of ['pacman', 'mspacman', 'pengo', 'crush', 'ladybug']) {
  const d = join(SRC, dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    const full = join(d, f);
    if (statSync(full).isFile()) roms[f] = new Uint8Array(readFileSync(full));
  }
}
// --roms=<dir>: a directory the user supplies. Game ROMs are copyrighted data and are never
// fetched by this tool; they are read from wherever the user points it.
const romArg = process.argv.find(a => a.startsWith('--roms='))?.slice(7);
if (romArg) {
  const walk = (d, prefix = '') => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${e}/`);
      else roms[`${prefix}${e}`] = new Uint8Array(readFileSync(full));
    }
  };
  walk(romArg);
  console.log(`ROMs from ${romArg}: ${Object.keys(roms).length} files`);
}
if (process.argv.includes('--test-rom')) Object.assign(roms, testRoms());
const frames = +(process.argv.find(a => a.startsWith('--frames='))?.slice(9) ?? 60);
// The driver to run, as MAME's own argv[1]. It was hardcoded to 'pacman', which meant a loop over
// five game names ran Pac-Man five times and printed five identical framebuffers — identical output
// across supposedly different games is the tell.
const game = process.argv.find(a => a.startsWith('--game='))?.slice(7) ?? 'pacman';
/*
 * msdos.c parses its own command line now, and two of its switches matter here: without -nosound it
 * prints a list of audio devices and blocks on `scanf("%d",&i)`, and without -nojoy it reads the
 * game port every frame. Both are the program's own options, passed as argv -- not a modification.
 */
const wantSound = process.argv.includes('--sound') || process.argv.some(a => a.startsWith('--wav='));
const extraArgs = (process.argv.find(a => a.startsWith('--args='))?.slice(7) ??
  (wantSound ? '-nojoy' : '-nosound -nojoy')).split(/\s+/).filter(Boolean);
/*
 * The platform layer, one level below where it used to be. MAME's own msdos.c is compiled now, so
 * what gets installed is the libraries it links: Allegro and SEAL, the DJGPP memory helpers, the I/O
 * port seam TwkUser.c writes CRTC registers through, and stdio for the ROM files.
 */
/*
 * With sound on, osd_init prints the SEAL device list and calls `scanf("%d",&i)`. That is the
 * program asking a question, so it gets an answer rather than a stub: a canned "0\n" on stdin, which
 * is what a person at a terminal would type. --stdin= overrides it.
 */
const cannedStdin = (process.argv.find(a => a.startsWith('--stdin='))?.slice(8) ?? '0\n');
let stdinAt = 0;
installStdio(program.M, {
  files: roms,
  readChar: () => (stdinAt < cannedStdin.length ? cannedStdin.charCodeAt(stdinAt++) : -1),
});
/*
 * --save=<name>:<path>: write a file the PROGRAM wrote back out to the host.
 *
 * MAME's own `-log` option opens error.log and its drivers write to it -- the Bally blitter in
 * src/wow/vidhrdw.c logs every blit with its mode -- so the emulator can be asked what it is doing
 * in its own words, with no instrumentation on our side at all. Without this the file existed only
 * in the guest's filesystem and could not be read.
 */
const saves = process.argv.filter(a => a.startsWith('--save='))
  .map(a => a.slice(7).split(':'));
installPorts(program.M);
/*
 * --keys=<script>: hold keys at chosen frames, so a game can be PLAYED headlessly.
 *
 * Every other harness here has one -- Quake's, Doom's -- and MAME's did not, which meant every
 * headless capture of every driver was its attract mode. An attract mode exercises the tilemap and
 * nothing else: a report that "shooting looks wrong" cannot be reproduced, let alone compared
 * against a native build, without a way to press the fire button.
 *
 * The script is frames and OSD key names: `--keys=240:3,300:1,400-460:ctrl,400-460:right`.
 * A single frame number means "hold for 8 frames from there", which is long enough for MAME's own
 * edge detection to see it and short enough not to jam the input.
 */
const KEY_SCAN = {                       // OSD_KEY_* values, from mame's src/msdos/osdepend.h order
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, esc: 1, tab: 15, enter: 28, space: 57,
  ctrl: 29, alt: 56, up: 72, down: 80, left: 75, right: 77, p: 25, f3: 61,
};
const keyScript = [];
for (const part of (process.argv.find(a => a.startsWith('--keys='))?.slice(7) ?? '')
    .split(',').filter(Boolean)) {
  const [when, name] = part.split(':');
  const [a, b] = when.split('-').map(Number);
  const scan = KEY_SCAN[String(name).toLowerCase()];
  if (scan === undefined) { console.error(`unknown key '${name}'`); process.exit(2); }
  keyScript.push({ from: a, to: Number.isFinite(b) ? b : a + 8, scan });
}
const allegro = installAllegro(program.M, {
  stopAfterFrames: frames,
  keys: (k) => (keyScript.some(s => s.scan === k && osdFrames() >= s.from && osdFrames() <= s.to) ? 1 : 0),
});
/* The frame counter lives in the state the call above returns, so it is read through a function. */
function osdFrames() { return allegro?.state?.frames ?? 0; }
const osd = allegro.state;
// The library's data lives in the linked image; its addresses are only known now.
allegro.bindGlobals(program);
// --wav=<path>: collect every mixed sample so the mixer can be LOOKED AT. Sound is the one output
// this harness cannot check by reading a pixel count, and "it did not throw" is not evidence.
const wavPath = process.argv.find(a => a.startsWith('--wav='))?.slice(6);
if (wavPath) program.M.audio.wav = [];

/*
 * --probe-polls: measure how many times in a row the program asks one service INSIDE ONE FRAME.
 * That is what calibrates the browser host's spin damping: the threshold has to sit above the longest
 * legitimate run, or a program that is working gets mistaken for a program that is waiting.
 */
if (process.argv.includes('--probe-polls')) {
  installSpinDamping(program.M, {
    frame: () => osd.frames,
    threshold: Infinity,                 // measure only; never park
    services: ['uclock', 'clock', 'osd_key_pressed', 'osd_read_key'],
  });
}
console.log(`platform backend installed; ${Object.keys(roms).length} data files visible; game '${game}'`);

console.log(`✓ compiled: ${Object.keys(program.F).length} functions, ` +
  `${(program.src.length / 1024 / 1024).toFixed(2)} MB of emitted JavaScript`);

if (process.argv.includes('--src')) {
  console.log(program.src.slice(0, 4000));
}

/** A 16-bit mono WAV, header written by hand: it is 44 bytes and it needs no dependency. */
function writeWav(path, samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  writeFileSync(path, buf);
}

function report() {
    for (const [name, path] of saves) {
      const bytes = program.M.files?.find?.(name)?.bytes ?? program.M.files?.store?.get?.(name.toLowerCase());
      if (!bytes) { console.log(`--save: the program never wrote ${name}`); continue; }
      writeFileSync(path, Buffer.from(bytes));
      console.log(`wrote ${path} (${bytes.length.toLocaleString('en')} bytes from the guest's ${name})`);
    }
    console.log(`display ${osd.width}x${osd.height} · pens ${osd.pens} · ` +
      `frames ${osd.frames} · samples ${osd.samples.length}`);
    const au = program.M.audio;
    if (au && au.wav) {
      let peak = 0, energy = 0, nz = 0;
      for (const v of au.wav) { const a = Math.abs(v); if (a > peak) peak = a; energy += v * v; if (v) nz++; }
      const rms = au.wav.length ? Math.sqrt(energy / au.wav.length) : 0;
      console.log(`audio: ${au.wav.length} samples at ${au.rate} Hz ` +
        `(${(au.wav.length / au.rate).toFixed(2)} s) · peak ${peak} · rms ${rms.toFixed(0)} · ` +
        `${nz} non-silent`);
      writeWav(wavPath, au.wav, au.rate);
      console.log(`wrote ${wavPath}`);
    }
    const pngPath = process.argv.find(a => a.startsWith('--png='))?.slice(6);
    if (pngPath && osd.width && osd.pixels) {
      writeIndexedPng(pngPath, {
        pixels: program.M.u8.subarray(osd.pixels, osd.pixels + osd.width * osd.height),
        width: osd.width, height: osd.height, palette: osd.palette,
      });
      console.log(`wrote ${pngPath} (${osd.width}x${osd.height})`);
    }
    if (osd.width && osd.pixels) {
      const px = program.M.u8.subarray(osd.pixels, osd.pixels + osd.width * osd.height);
      let nz = 0;
      for (const b of px) if (b) nz++;
      console.log(`framebuffer: ${nz} non-zero pixels of ${px.length}`);
    }
}

if (process.argv.includes('--run')) {
  try {
    const r = program.run(['mame', game, ...extraArgs]);
    console.log(`\nexit ${r.code}`);
    if (r.stdout) console.log(r.stdout.trimEnd());
    if (program.M.spinDamping) {
      const m = program.M.spinDamping.maxRun;
      console.log(`longest run of consecutive calls within one frame: ` +
        Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · '));
    }
    report();
  } catch (e) {
    // The frame cap is how this harness stops a main loop that never returns, not a failure.
    if (e.message === '__frames_done') report();
    else console.log(`\n✗ ran and threw: ${e.message}`);
  }
}
