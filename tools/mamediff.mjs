// mamediff.mjs — diff a whole MAME build, frame by frame, against a gcc build of the same source.
//
// tools/z80diff.mjs proved the CPU core. This covers everything above it: the memory-map dispatch,
// the drivers, the tilemap renderer. Both sides compile the SAME MAME sources with the SAME headless
// backend (tools/mamediff/osdnull.c) and print a hash of the display bitmap every frame, so the
// first differing line names the frame where the two builds part company.
//
//   node tools/mamediff.mjs --roms=<dir> [--frames=400] [--game=pacman] [--release=01|04]
//                            [--play=coin,start,fireFrom,fireTo]
//
// --play makes both sides PLAY: the same coin, start and fire schedule is compiled into the backend,
// so the comparison covers the parts of a driver an attract mode never reaches. Without it the two
// builds only ever agree about a demo loop.
//
// No ROM data enters the repository: the harness copies whatever directory it is pointed at into the
// gitignored .oracle/ so the container can read the same bytes.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, SCRATCH, version } from './oracle.mjs';
import { compileProgram } from '../src/compile.js';
import { installStdio } from '../src/env/stdio.js';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RELEASE = process.argv.find(a => a.startsWith('--release='))?.slice(10) ?? '01';
const MAME = join(ROOT, 'corpus', `mame${RELEASE}`);

const romDir = process.argv.find(a => a.startsWith('--roms='))?.slice(7);
const FRAMES = +(process.argv.find(a => a.startsWith('--frames='))?.slice(9) ?? 400);
const GAME = process.argv.find(a => a.startsWith('--game='))?.slice(7) ?? 'pacman';
if (!romDir || !existsSync(romDir)) {
  console.error('usage: node tools/mamediff.mjs --roms=<dir> [--frames=N] [--game=name]');
  process.exit(2);
}

/*
 * The unit list, per release, read from the TARGET rather than repeated here.
 *
 * targets/mame0N.json already carries the makefile's object list, minus the platform backend PRISM
 * replaces -- and it is the list `node tools/build.mjs` compiles, so the differential and the build
 * cannot drift apart. Only src/msdos/msdos.c is dropped: osdnull.c is the backend here.
 */
const target = JSON.parse(readFileSync(join(ROOT, 'targets', `mame${RELEASE}.json`), 'utf8'));
const UNITS = target.units.list.filter(u => !/msdos/.test(u));

const INCLUDE_DIRS = ['src', 'src/Z80', 'src/msdos'];

// --- lay the whole build out in one flat directory the container can compile in
const work = join(SCRATCH, 'mamediff');
mkdirSync(work, { recursive: true });
const flat = new Map();                       // basename -> contents, for the flat build
/* Every directory the units live in, plus the include dirs: the headers all go in one flat pile. */
const SRC_DIRS = [...new Set([...UNITS.map(u => u.replace(/\/[^/]+$/, '')), ...(target.include ?? [])])];
for (const d of [...SRC_DIRS, 'src/msdos']) {
  const dir = join(MAME, d);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    /*
     * .c FILES TOO, under their own basenames. MAME's sound code #includes source: cclimber's
     * sndhrdw.c opens with `#include "psg.c"`, which is a translation unit pulled into another one
     * and not a unit of its own. Copying only headers left the reference build looking for a file
     * that was right there in the corpus.
     */
    if (/\.(h|c)$/i.test(f)) flat.set(f, readFileSync(join(dir, f)));
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
//
// Accept either layout: a flat directory holding one game's files, or a tree with one directory per
// game — which is how a real MAME rom folder is arranged, and how MAME itself asks for them.
const gameDir = existsSync(join(romDir, GAME)) && statSync(join(romDir, GAME)).isDirectory()
  ? join(romDir, GAME) : romDir;

// Wipe first. The scratch directory persists between runs, and a stale ROM set left there let the
// gcc side load a game that PRISM could not see at all — 46 lines against 2, reported as a
// divergence in the compiler. A differential where the two sides are given different INPUTS is not
// measuring the thing it claims to measure.
rmSync(join(work, GAME), { recursive: true, force: true });
mkdirSync(join(work, GAME), { recursive: true });
const roms = {};
for (const f of readdirSync(gameDir)) {
  const full = join(gameDir, f);
  if (!statSync(full).isFile()) continue;
  const bytes = new Uint8Array(readFileSync(full));
  writeFileSync(join(work, GAME, f), bytes);
  roms[`${GAME}/${f}`] = bytes;
}
console.log(`${version().split('\n')[0]}`);
console.log(`${cfiles.length} units, ${Object.keys(roms).length} data files, ${FRAMES} frames, game "${GAME}"`);

// --- the gcc side
console.log('building all of MAME with the reference compiler…');
// -DUNIX is MAME's own switch for a non-DJGPP host: it maps uclock onto clock, which glibc has and
// DJGPP's uclock it does not. Defined on BOTH sides so the two builds see identical source. It only
// reaches the FPS counter, which needs an F11 keypress this backend never reports.
const play = (process.argv.find(a => a.startsWith('--play='))?.slice(7) ?? '').split(',').map(Number);
/*
 * --dump=N asks BOTH sides for frame N pixel by pixel. A hash tells you two frames differ; the next
 * question is always which pixels and which pens, and no hash can answer it. See osdnull.c.
 */
const DUMP = +(process.argv.find(a => a.startsWith('--dump='))?.slice(7) ?? 0) || 0;
/*
 * --vram goes one level below the picture: it also dumps the GAME's video RAM on that frame. It is
 * wow-only, because it reads a symbol only that driver exports. See osdnull.c for why the answer it
 * gives is not arguable -- the picture is a pure function of the video RAM's content.
 */
const VRAM = DUMP > 0 && process.argv.includes('--vram');
/*
 * --ram hashes the whole machine state every frame, beside the display hash. A display hash only
 * moves once a difference has been DRAWN, so it names the frame the symptom appeared; this names the
 * frame the two builds' state actually parted, which can be much earlier and invisible.
 */
const RAMHASH = process.argv.includes('--ram');
const PLAY_DEFS = play.length === 4 && play.every(Number.isFinite)
  ? { PLAY_COIN: play[0], PLAY_START: play[1], PLAY_FIRE_FROM: play[2], PLAY_FIRE_TO: play[3] } : {};
const playFlags = Object.entries(PLAY_DEFS).map(([k, v]) => `-D${k}=${v}`).join(' ');
if (playFlags) console.log(`playing: ${playFlags}`);
/*
 * THE REFERENCE COMPILER, and there are two of them because one release needs the other.
 *
 * gcc is the reference wherever it can be: it is the compiler every other gate in this project
 * asks, and the one whose answers the rest of the corpus is measured against. But gcc 12 refuses
 * four `case` labels in MAME 0.4's src/machine.c -- and a census of the whole release says those
 * four lines are the ONLY thing it refuses, in 31 units. So the fallback is not "a second opinion",
 * it is the difference between having an oracle for this release and having none.
 *
 * tcc accepts them. It also accepts the two other period constructs Open Watcom (which DOES take
 * the case labels) refuses in every mode: `unsigned char *line[0]` in osdepend.h, and `interrupt`
 * as an ordinary identifier. Neither side of the differential may be patched, so the compiler has
 * to bend, and tcc is the one that bends far enough. `-lm` is explicit because tcc, unlike gcc,
 * does not link libm on its own and cclimber's wave table calls cos().
 */
const dumpFlag = (DUMP ? ` -DDUMP_FRAME=${DUMP}` : '') + (VRAM ? ' -DDUMP_VRAM=1' : '') +
  (RAMHASH ? ' -DHASH_RAM=1' : '');
if (DUMP) console.log(`dumping frame ${DUMP} from both sides`);
const build = (cc) => (cc === 'tcc'
  ? `tcc -w -DLSB_FIRST -DUNIX -DMAX_FRAMES=${FRAMES} ${playFlags}${dumpFlag} -I. -lm -o mameref `
  : `gcc -std=gnu89 -w -DLSB_FIRST -DUNIX -DMAX_FRAMES=${FRAMES} ${playFlags}${dumpFlag} -I. -o mameref `);
// stdin from /dev/null: mame.c's banner calls getchar(), which blocks for ever on a terminal.
// PRISM's getchar already returns EOF, so this makes the two sides behave the same way.
const runIt = (cc) => sh(`cd mamediff && ${build(cc)}${cfiles.join(' ')} 2>&1 && ` +
  `./mameref ${GAME} < /dev/null > ref.txt 2>&1; echo "RC $?"`, { timeout: 1800000 });

let CC = 'gcc';
let r = runIt(CC);
if (!/RC 0/.test(r.stdout) && /pointers are not permitted as case values/.test(r.stdout)) {
  console.log(`gcc refuses 'case MRA_RAM:' (driver.h defines it as a cast POINTER constant, which ` +
    `gcc 2.7 on DJGPP took as a case label). Falling back to tcc, which accepts it.`);
  CC = 'tcc';
  r = runIt(CC);
}
if (!/RC 0/.test(r.stdout)) {
  /*
   * ONE FAILURE IS NOT A BUILD ERROR, it is a missing oracle, and it should be named as such.
   *
   * MAME 0.4's src/machine.c switches on `(int)mra->handler` with `case MRA_RAM:`, where driver.h
   * defines MRA_RAM as `((int(*)())-1)`. gcc 2.7 on DJGPP accepted a cast pointer constant as a case
   * label; gcc 12 refuses it, and a command-line -D cannot help because driver.h defines the macro
   * itself. Since PRISM must not modify the game's source, and neither may the reference build, this
   * release simply HAS NO native oracle on a modern compiler -- and the honest thing is to say which
   * construct, not to print a wall of compiler output as though the harness were broken.
   */
  if (/pointers are not permitted as case values/.test(r.stdout) || /tcc: not found/.test(r.stdout)) {
    console.error(`no oracle for MAME ${RELEASE}: the fallback compiler is missing. This release ` +
      `needs tcc -- gcc refuses 'case MRA_RAM:' and Open Watcom refuses osdepend.h's zero-length ` +
      `array -- and the oracle image has to carry it: rebuild with\n` +
      `  docker build --platform linux/386 -t prism-oracle tools/oracle`);
    process.exit(2);
  }
  console.error(`${CC} side failed:\n${r.stdout.split('\n').slice(0, 25).join('\n')}`);
  process.exit(1);
}
const ref = readFileSync(join(work, 'ref.txt'), 'utf8').trim().split('\n');
console.log(`reference: ${ref.length} lines, built with ${CC}`);

// --- the PRISM side, from the same flat directory so both see identical text
function resolver(name) {
  const full = join(work, basename(name));
  if (existsSync(full)) return { path: full, text: readFileSync(full, 'latin1') };
  // The FULL name first: `sys/types.h` is its own key, and reducing to a basename looks up
  // `types.h`, misses, and stubs a header that is right there.
  const std = HEADERS[name] ?? HEADERS[basename(name)];
  return std === undefined ? null : { path: `<${name}>`, text: std };
}

console.log('building the same sources with PRISM…');
const units = cfiles.map(f => ({ file: join(work, f), source: readFileSync(join(work, f), 'latin1') }));
let prog;
try {
  prog = compileProgram(units, {
    defines: { LSB_FIRST: '1', UNIX: '1', MAX_FRAMES: String(FRAMES),
               ...(DUMP ? { DUMP_FRAME: String(DUMP) } : {}),
               ...(VRAM ? { DUMP_VRAM: '1' } : {}),
               ...(RAMHASH ? { HASH_RAM: '1' } : {}),
               ...Object.fromEntries(Object.entries(PLAY_DEFS).map(([k, v]) => [k, String(v)])) },
    resolve: resolver,
    memory: 256 * 1024 * 1024,
  });
} catch (e) {
  console.error(`PRISM side failed to build: ${e.message.split('\n')[0]}`);
  process.exit(1);
}
// osdnull.c IS the backend here, so only the libc extras are installed.
installStdio(prog.M, { files: roms });

let out;
try {
  out = prog.run(['mame', GAME]);
} catch (e) {
  console.error(`PRISM side threw: ${e.message}`);
  process.exit(1);
}
const ours = out.stdout.trim().split('\n');
console.log(`PRISM:     ${ours.length} lines (exit ${out.code})`);

/*
 * THE PIXELS, when --dump asked for them. Split out before the line diff, because a 200-row picture
 * arriving in the middle of the frame log would be reported as "line 431 differs" and that is not
 * an answer to anything.
 */
function pixels(lines) {
  const head = lines.findIndex((l) => l.startsWith('dump '));
  if (head < 0) return null;
  const [, w, h] = lines[head].split(' ').map(Number);
  const rows = [];
  for (let i = head + 1; i < lines.length && lines[i].startsWith('pix'); i++) {
    const hex = lines[i].slice(3);
    const row = new Uint8Array(w);
    for (let x = 0; x < w; x++) row[x] = parseInt(hex.substr(x * 2, 2), 16);
    rows.push(row);
  }
  return { w, h, rows };
}
const strip = (lines) => lines.filter((l) =>
  !l.startsWith('pix') && !l.startsWith('vrm') && !l.startsWith('mem') && !l.startsWith('dump '));

/** The video-RAM rows, 80 bytes each, as they were dumped. */
function vram(lines) {
  const rows = lines.filter((l) => l.startsWith('vrm')).map((l) => {
    const hex = l.slice(3), row = new Uint8Array(hex.length / 2);
    for (let i = 0; i < row.length; i++) row[i] = parseInt(hex.substr(i * 2, 2), 16);
    return row;
  });
  return rows.length ? rows : null;
}

/*
 * THE ADDRESSES, when --ram and --dump are both given. A hash says the state differs; only this says
 * where, and where is what names the cause. Reported as RANGES rather than as bytes, because a
 * divergence is almost never one byte and a list of 800 of them is not a diagnosis.
 */
if (RAMHASH && DUMP) {
  const mem = (lines) => {
    const rows = lines.filter((l) => l.startsWith('mem'));
    if (!rows.length) return null;
    const out = new Uint8Array(rows.length * 256);
    rows.forEach((l, y) => {
      const hex = l.slice(3);
      for (let x = 0; x < 256; x++) out[y * 256 + x] = parseInt(hex.substr(x * 2, 2), 16);
    });
    return out;
  };
  const A = mem(ref), B = mem(ours);
  if (A && B && A.length === B.length) {
    const ranges = [];
    let n = 0;
    for (let a = 0; a < A.length; a++) {
      if (A[a] === B[a]) continue;
      n++;
      const last = ranges[ranges.length - 1];
      if (last && a - last.end <= 16) { last.end = a; last.n++; }
      else ranges.push({ start: a, end: a, n: 1, bytes: [] });
      // The VALUES of the first few, because "which byte" and "what in it" are different questions
      // and the second one is usually the one that names the cause.
      const r = ranges[ranges.length - 1];
      if (r.bytes.length < 6) r.bytes.push(`0x${a.toString(16)}: ${CC} ${A[a]} prism ${B[a]}`);
    }
    console.log(n
      ? `\n✗ Z80 address space on frame ${DUMP}: ${n} bytes differ, in ${ranges.length} ` +
        `region${ranges.length === 1 ? '' : 's'}\n` +
        ranges.slice(0, 12).map((r) => `   0x${r.start.toString(16).padStart(4, '0')}` +
          `-0x${r.end.toString(16).padStart(4, '0')}  ${r.n} bytes\n` +
          r.bytes.map((b) => `      ${b}`).join('\n')).join('\n') +
        (ranges.length > 12 ? `\n   … ${ranges.length - 12} more` : '')
      : `\n✓ Z80 address space on frame ${DUMP} is identical`);
  }
}

if (VRAM) {
  const A = vram(ref), B = vram(ours);
  if (!A || !B) {
    console.log(`\n⚠️  no video-RAM dump on the ${A ? 'PRISM' : CC} side`);
  } else {
    let d = 0;
    const hits = [];
    for (let y = 0; y < Math.min(A.length, B.length); y++) {
      for (let x = 0; x < A[y].length; x++) {
        if (A[y][x] === B[y][x]) continue;
        d++;
        if (hits.length < 12) hits.push(`row ${y} byte ${x}: ${CC} ${A[y][x].toString(16).padStart(2, '0')} ` +
          `prism ${B[y][x].toString(16).padStart(2, '0')}`);
      }
    }
    console.log(d
      ? `\n✗ video RAM on frame ${DUMP}: ${d} bytes differ — the divergence is UPSTREAM of the ` +
        `video hardware\n   ${hits.join('\n   ')}`
      : `\n✓ video RAM on frame ${DUMP} is IDENTICAL — so a differing picture means the write ` +
        `handler was invoked differently, not that the content is wrong`);
  }
}

if (DUMP) {
  const A = pixels(ref), B = pixels(ours);
  if (!A || !B) {
    console.log(`\n⚠️  no dump on the ${A ? 'PRISM' : CC} side — was frame ${DUMP} ever reached?`);
  } else if (A.w !== B.w || A.h !== B.h || A.rows.length !== B.rows.length) {
    console.log(`\n✗ frame ${DUMP}: different GEOMETRY — ${CC} ${A.w}x${A.rows.length}, ` +
      `prism ${B.w}x${B.rows.length}`);
  } else {
    /*
     * What a hash cannot say: how many, where, and which pens. The index-pair census is the part
     * that names the defect -- gate-pixels.mjs answers Quake's platform questions the same way, and
     * "16 became 112 everywhere" is a different bug from "one sprite is displaced".
     */
    let d = 0, x0 = A.w, x1 = -1, y0 = A.rows.length, y1 = -1;
    const pairs = new Map(), rowsHit = [];
    for (let y = 0; y < A.rows.length; y++) {
      let inRow = 0;
      for (let x = 0; x < A.w; x++) {
        const a = A.rows[y][x], b = B.rows[y][x];
        if (a === b) continue;
        d++; inRow++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        const k = `${a}->${b}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
      if (inRow) rowsHit.push(`${y}:${inRow}`);
    }
    if (!d) {
      console.log(`\n✓ frame ${DUMP}: identical, ${A.w * A.rows.length} pixels`);
    } else {
      const top = [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`\n✗ frame ${DUMP}: ${d} of ${A.w * A.rows.length} pixels differ`);
      console.log(`   bounding box x ${x0}..${x1}, y ${y0}..${y1} ` +
        `(${x1 - x0 + 1}x${y1 - y0 + 1}), ${rowsHit.length} rows touched`);
      console.log(`   rows: ${rowsHit.slice(0, 14).join(' ')}${rowsHit.length > 14 ? ' …' : ''}`);
      console.log(`   ${pairs.size} distinct pen pairs, commonest: ${top}`);
    }
  }
}

// --- the diff, over the frame log only: the pixel rows are compared above, on their own terms.
const refL = strip(ref), oursL = strip(ours);
let bad = -1;
for (let i = 0; i < Math.max(refL.length, oursL.length); i++) {
  if (refL[i] !== oursL[i]) { bad = i; break; }
}
if (bad < 0) {
  console.log(`\n✓ identical over ${refL.length} lines — the whole build agrees with the ${CC} build.`);
  process.exit(0);
}
/*
 * HOW MANY, not just WHERE. The first differing line is where to start reading; the count and the
 * span say what KIND of defect it is. A handful of frames that differ and then agree again is a
 * transient -- one object drawn wrongly for as long as it exists -- and every frame differing from
 * the first divergence onward is state that has gone permanently out of step. Reporting only the
 * first line cannot tell those apart, and they are not the same bug.
 */
const n = Math.max(refL.length, oursL.length);
let diff = 0, last = bad;
for (let i = 0; i < n; i++) if (refL[i] !== oursL[i]) { diff++; last = i; }
console.log(`\n✗ ${diff} of ${n} lines differ, first at ${bad}, last at ${last}` +
  (diff === last - bad + 1 ? ' — every line from the first onward' : ' — with agreement in between'));
for (let i = Math.max(0, bad - 3); i <= Math.min(bad + 2, n - 1); i++) {
  const mark = i === bad ? '>>' : '  ';
  console.log(`${mark} ${CC.padEnd(5)} ${refL[i] ?? '(end)'}`);
  console.log(`${mark} prism ${oursL[i] ?? '(end)'}`);
}
process.exit(1);
