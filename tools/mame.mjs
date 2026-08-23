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
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, installOSD } from '../src/compile.js';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus', 'mame01');

if (!existsSync(join(SRC, 'src'))) {
  console.error(`corpus missing: ${SRC}\nFetch it with:\n` +
    `  curl -sL https://downloads.sourceforge.net/project/mame/mame/0.1/mame01.zip -o /tmp/mame01.zip\n` +
    `  mkdir -p corpus/mame01 && (cd corpus/mame01 && unzip -qo /tmp/mame01.zip)`);
  process.exit(2);
}

// The makefile's own object list, minus the platform backend PRISM replaces.
const UNITS = [
  'src/mame.c', 'src/common.c', 'src/machine.c', 'src/driver.c',
  'src/Z80/Z80.c',
  'src/pacman/machine.c', 'src/pacman/driver.c',
  'src/crush/machine.c', 'src/crush/driver.c',
  'src/pengo/machine.c', 'src/pengo/vidhrdw.c', 'src/pengo/sndhrdw.c', 'src/pengo/driver.c',
  'src/ladybug/machine.c', 'src/ladybug/vidhrdw.c', 'src/ladybug/sndhrdw.c', 'src/ladybug/driver.c',
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
 * The DATA half of the platform backend. src/msdos/msdos.c defines these; a different backend must
 * too, and writing them in C is the most honest form — they are ordinary objects with external
 * linkage that the game reads.
 */
const OSD_VARS = `
int play_sound = 1;
int osd_joy_up = 0, osd_joy_down = 0, osd_joy_left = 0, osd_joy_right = 0;
int osd_joy_b1 = 0, osd_joy_b2 = 0, osd_joy_b3 = 0, osd_joy_b4 = 0;
`;

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

units.push({ file: 'prism-osd-vars.c', source: OSD_VARS });

console.log(`MAME 0.1 — ${units.length} translation units, ` +
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
const osd = installOSD(program.M, { files: roms, stopAfterFrames: frames });
console.log(`platform backend installed; ${Object.keys(roms).length} data files visible`);

console.log(`✓ compiled: ${Object.keys(program.F).length} functions, ` +
  `${(program.src.length / 1024 / 1024).toFixed(2)} MB of emitted JavaScript`);

/**
 * Write the display as a PNG, through the palette the game itself asked for. No dependencies: a PNG
 * is a CRC-checked container around a deflate stream, and Node has deflate built in.
 */
function writePng(path, M, osd) {
  const { width: w, height: h, pixels, palette } = osd;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;                                  // filter: none
    for (let x = 0; x < w; x++) {
      const pen = M.u8[pixels + y * w + x];
      const rgb = palette[pen] ?? [0, 0, 0];
      raw[o++] = rgb[0]; raw[o++] = rgb[1]; raw[o++] = rgb[2];
    }
  }
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit truecolour
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  console.log(`wrote ${path} (${w}x${h})`);
}

if (process.argv.includes('--src')) {
  console.log(program.src.slice(0, 4000));
}

if (process.argv.includes('--run')) {
  try {
    const r = program.run(['mame', 'pacman']);
    console.log(`\nexit ${r.code}`);
    if (r.stdout) console.log(r.stdout.trimEnd());
    console.log(`display ${osd.width}x${osd.height} · pens ${osd.palette.length} · ` +
      `frames ${osd.frames} · samples ${osd.samples.length}`);
    const pngPath = process.argv.find(a => a.startsWith('--png='))?.slice(6);
    if (pngPath && osd.width && osd.pixels) writePng(pngPath, program.M, osd);
    if (osd.width && osd.pixels) {
      const px = program.M.u8.subarray(osd.pixels, osd.pixels + osd.width * osd.height);
      let nz = 0;
      for (const b of px) if (b) nz++;
      console.log(`framebuffer: ${nz} non-zero pixels of ${px.length}`);
    }
  } catch (e) {
    console.log(`\n✗ ran and threw: ${e.message}`);
  }
}
