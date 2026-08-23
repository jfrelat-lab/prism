// mamediff.mjs — diff a whole MAME build, frame by frame, against a gcc build of the same source.
//
// tools/z80diff.mjs proved the CPU core. This covers everything above it: the memory-map dispatch,
// the drivers, the tilemap renderer. Both sides compile the SAME MAME sources with the SAME headless
// backend (tools/mamediff/osdnull.c) and print a hash of the display bitmap every frame, so the
// first differing line names the frame where the two builds part company.
//
//   node tools/mamediff.mjs --roms=<dir> [--frames=400] [--game=pacman]
//
// No ROM data enters the repository: the harness copies whatever directory it is pointed at into the
// gitignored .oracle/ so the container can read the same bytes.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, SCRATCH, version } from './oracle.mjs';
import { compileProgram, installOSD } from '../src/compile.js';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAME = join(ROOT, 'corpus', 'mame01');

const romDir = process.argv.find(a => a.startsWith('--roms='))?.slice(7);
const FRAMES = +(process.argv.find(a => a.startsWith('--frames='))?.slice(9) ?? 400);
const GAME = process.argv.find(a => a.startsWith('--game='))?.slice(7) ?? 'pacman';
if (!romDir || !existsSync(romDir)) {
  console.error('usage: node tools/mamediff.mjs --roms=<dir> [--frames=N] [--game=name]');
  process.exit(2);
}

const UNITS = [
  'src/mame.c', 'src/common.c', 'src/machine.c', 'src/driver.c',
  'src/Z80/Z80.c',
  'src/pacman/machine.c', 'src/pacman/driver.c',
  'src/crush/machine.c', 'src/crush/driver.c',
  'src/pengo/machine.c', 'src/pengo/vidhrdw.c', 'src/pengo/sndhrdw.c', 'src/pengo/driver.c',
  'src/ladybug/machine.c', 'src/ladybug/vidhrdw.c', 'src/ladybug/sndhrdw.c', 'src/ladybug/driver.c',
];
const INCLUDE_DIRS = ['src', 'src/Z80', 'src/msdos'];

// --- lay the whole build out in one flat directory the container can compile in
const work = join(SCRATCH, 'mamediff');
mkdirSync(work, { recursive: true });
const flat = new Map();                       // basename -> contents, for the flat build
for (const d of ['src', 'src/Z80', 'src/pacman', 'src/crush', 'src/pengo', 'src/ladybug', 'src/msdos']) {
  const dir = join(MAME, d);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (/\.h$/i.test(f)) flat.set(f, readFileSync(join(dir, f)));
  }
}
for (const [name, data] of flat) writeFileSync(join(work, name), data);

// The .c files keep distinct names, because src/pacman/driver.c and src/pengo/driver.c collide.
const cfiles = [];
for (const u of UNITS) {
  const flatName = u.replace(/^src\//, '').replace(/\//g, '_');
  writeFileSync(join(work, flatName), readFileSync(join(MAME, u)));
  cfiles.push(flatName);
}
writeFileSync(join(work, 'osdnull.c'), readFileSync(join(ROOT, 'tools', 'mamediff', 'osdnull.c')));
cfiles.push('osdnull.c');

// The ROMs, under the subdirectory name MAME asks for.
mkdirSync(join(work, GAME), { recursive: true });
const roms = {};
for (const f of readdirSync(romDir)) {
  const full = join(romDir, f);
  if (!statSync(full).isFile()) continue;
  const bytes = new Uint8Array(readFileSync(full));
  writeFileSync(join(work, GAME, f), bytes);
  roms[`${GAME}/${f}`] = bytes;
}
console.log(`${version().split('\n')[0]}`);
console.log(`${cfiles.length} units, ${Object.keys(roms).length} data files, ${FRAMES} frames, game "${GAME}"`);

// --- the gcc side
console.log('building all of MAME with gcc…');
// -DUNIX is MAME's own switch for a non-DJGPP host: it maps uclock onto clock, which glibc has and
// DJGPP's uclock it does not. Defined on BOTH sides so the two builds see identical source. It only
// reaches the FPS counter, which needs an F11 keypress this backend never reports.
const cmd = `cd mamediff && gcc -std=gnu89 -w -DLSB_FIRST -DUNIX -DMAX_FRAMES=${FRAMES} -I. -o mameref ` +
  // stdin from /dev/null: mame.c's banner calls getchar(), which blocks for ever on a terminal.
  // PRISM's getchar already returns EOF, so this makes the two sides behave the same way.
  `${cfiles.join(' ')} 2>&1 && ./mameref ${GAME} < /dev/null > ref.txt 2>&1; echo "RC $?"`;
const r = sh(cmd, { timeout: 1800000 });
if (!/RC 0/.test(r.stdout)) {
  console.error(`gcc side failed:\n${r.stdout.split('\n').slice(0, 25).join('\n')}`);
  process.exit(1);
}
const ref = readFileSync(join(work, 'ref.txt'), 'utf8').trim().split('\n');
console.log(`reference: ${ref.length} lines`);

// --- the PRISM side, from the same flat directory so both see identical text
function resolver(name) {
  const full = join(work, basename(name));
  if (existsSync(full)) return { path: full, text: readFileSync(full, 'latin1') };
  const std = HEADERS[basename(name)];
  return std === undefined ? null : { path: `<${name}>`, text: std };
}

console.log('building the same sources with PRISM…');
const units = cfiles.map(f => ({ file: join(work, f), source: readFileSync(join(work, f), 'latin1') }));
let prog;
try {
  prog = compileProgram(units, {
    defines: { LSB_FIRST: '1', UNIX: '1', MAX_FRAMES: String(FRAMES) },
    resolve: resolver,
    memory: 256 * 1024 * 1024,
  });
} catch (e) {
  console.error(`PRISM side failed to build: ${e.message.split('\n')[0]}`);
  process.exit(1);
}
// osdnull.c IS the backend here, so only the libc extras are installed.
installOSD(prog.M, { files: roms });

let out;
try {
  out = prog.run(['mame', GAME]);
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
  console.log(`\n✓ identical over ${ref.length} lines — the whole build agrees with gcc.`);
  process.exit(0);
}
console.log(`\n✗ first divergence at line ${bad}:`);
for (let i = Math.max(0, bad - 3); i <= Math.min(bad + 2, Math.max(ref.length, ours.length) - 1); i++) {
  const mark = i === bad ? '>>' : '  ';
  console.log(`${mark} gcc   ${ref[i] ?? '(end)'}`);
  console.log(`${mark} prism ${ours[i] ?? '(end)'}`);
}
process.exit(1);
