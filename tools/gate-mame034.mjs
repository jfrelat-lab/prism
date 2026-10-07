// gate-mame034.mjs — MAME 0.34 builds whole, its own DOS layer included, and its driver table
// survives the build.
//
// What is held, without a ROM:
//
//   1. every symbol the makefile's objects need is resolved, and the only functions that cannot be
//      emitted are the two the release wrote in x86 assembly for doubled VESA modes;
//   2. the program's own `-listcrc` -- 959 drivers' ROM tables walked by the compiled C, through
//      src/msdos/fronthlp.c -- names exactly the (CRC, file) pairs a plain-text reading of the same
//      ROM_LOAD lines finds in src/drivers. Two derivations of one table: the C compiled and run,
//      and a regular expression over the source.
//
// With PRISM_MAME_ROMS=<dir of zips>, two more things:
//
//   3. a SMOKE run through the release's own DOS layer: two games reach their emulation loop and
//      present a picture that is not blank. It can tell "does not start" from "starts"; it cannot
//      tell right from wrong, and says so;
//   4. THE REFERENCE, replayed: five games print, frame for frame, what a native i386 gcc build of
//      the same sources printed (goldens/mame034.json, written by tools/mame034diff.mjs only for
//      games on which the two builds agreed). That one does tell right from wrong -- for everything
//      above the platform layer, which there is a headless backend (tools/mamediff/osdnull34.c).
//   5. THE LIGHT BUILD the page is served -- one archive of the makefile, the CPU cores it uses --
//      prints those same frames for three games, and a cut that is too small does not.
//
// What is NOT held: the picture the DOS layer itself presents (src/msdos/video.c through the
// Allegro shim), and sound.
//
//   node tools/gate-mame034.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus', 'mame034', 'src');
const SELF = fileURLToPath(import.meta.url);

// ---- the child: one build, one run, a JSON report on stdout. A build of 695 units wants more
// heap than node's default, which is why it is a process of its own.
if (process.argv[2] === '--child') {
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const [, , , game, frames, ...extra] = process.argv;
  const files = {};
  const roms = process.env.PRISM_MAME_ROMS;
  if (roms && existsSync(join(roms, `${game}.zip`))) files[`ROMS/${game}.zip`] = new Uint8Array(readFileSync(join(roms, `${game}.zip`)));
  // Enter, tapped: MAME shows a copyright screen and a game information screen and waits at each
  // for a key to go down and come up again. Held on alternate groups of safepoints while no frame
  // arrives, and on alternate groups of 8 frames for the screen that redraws while it waits.
  let held = false, sp = 0, last = -1, idle = 0;
  const b = buildTarget(loadTarget(join(ROOT, 'targets', 'mame034.json')), {
    root: ROOT, compile: { safepoints: true },
    envExtra: { stdio: { files }, allegro: { stopAfterFrames: +frames, keys: (k) => (held && k === 28 ? 1 : 0) } },
  });
  const { program } = b;
  const M = program.M;
  M.spBudget = 200000;
  M.sp_ = () => {
    M.spBudget = 200000;
    const f = M.allegro.state.frames;
    if (f === last) idle++; else { idle = 0; last = f; }
    held = (idle > 2 && (++sp & 4) !== 0) || (f < 300 && ((f >> 3) & 1) === 1);
    M.allegro.refreshKeys();
  };
  M.allegro.bindGlobals(program);
  let stdout = '', error = null;
  try { stdout = program.run(['mame', game, ...extra])?.stdout ?? ''; }
  catch (e) { if (!/__frames_done/.test(e.message)) error = e.message.split('\n')[0]; }
  const s = M.allegro.state;
  const pens = s.pixels ? new Set(M.u8.subarray(s.pixels, s.pixels + s.width * s.height)).size : 0;
  // Exit only once the report is through the pipe: it is a megabyte, and exiting first cuts it.
  process.stdout.write(JSON.stringify({
    unresolved: (program.undefined ?? []).map((u) => u.name),
    failures: (program.failures ?? []).map((f) => f.name ?? f.fn ?? f.message),
    functions: Object.keys(program.F).length,
    stdout, error, frames: s.frames, width: s.width, height: s.height, pens,
  }), () => process.exit(0));
  await new Promise(() => {});
}

if (!existsSync(SRC)) {
  skip('MAME 0.34 is not in corpus/', JSON.parse(readFileSync(join(ROOT, 'targets', 'mame034.json'), 'utf8')).fetch);
}

const child = (game, frames, ...extra) => {
  const r = spawnSync('node', ['--max-old-space-size=8192', SELF, '--child', game, String(frames), ...extra],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 240000 });
  try { return JSON.parse(r.stdout); } catch { return { error: `no report: ${(r.stderr || r.stdout || '').trim().split('\n').at(-1)}` }; }
};

/** The (crc, file) pairs the drivers state, read as text: every ROM_LOAD-family line of src/drivers. */
function pairsFromSource() {
  const out = new Set();
  const dir = readdirSync(SRC).find((d) => d.toLowerCase() === 'drivers');
  for (const f of readdirSync(join(SRC, dir)).filter((x) => /\.c$/i.test(x))) {
    // Less what the compiler never sees: comments, and the blocks the drivers park under `#if 0`.
    const text = readFileSync(join(SRC, dir, f), 'latin1')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')
      .replace(/^[ \t]*#[ \t]*if[ \t]+0\b[\s\S]*?^[ \t]*#[ \t]*endif/gm, ' ');
    for (const r of text.matchAll(/ROM_LOAD\w*\s*\(\s*"([^"]+)"\s*,[^,]+,[^,]+,\s*(0x[0-9a-fA-F]+|\d+)\s*\)/g)) {
      out.add(`${(Number(r[2]) >>> 0).toString(16).padStart(8, '0')} ${r[1]}`);
    }
    // neogeo.c's own macros, which take the name and the CRC and supply the rest: NEO_SFIX_128K(name,sum).
    for (const r of text.matchAll(/\bNEO_\w+\s*\(\s*"([^"]+)"\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*\)/g)) {
      out.add(`${(Number(r[2]) >>> 0).toString(16).padStart(8, '0')} ${r[1]}`);
    }
  }
  return out;
}
/** ...and the pairs the program prints: "%08x %-12s %s" per ROM. */
const pairsFromProgram = (stdout) => new Set(
  [...stdout.matchAll(/^([0-9a-f]{8}) (\S+)/gm)].map((m) => `${m[1]} ${m[2]}`));
const difference = (a, b) => [...a].filter((x) => !b.has(x));

let bad = 0;
const check = (ok, text, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}${!ok && detail ? `\n     ${detail}` : ''}`); if (!ok) bad++; };

const ASM_ONLY = ['double_pixels', 'double_pixels16'];
const list = child('-listcrc', 1);
if (list.error && !list.stdout) { console.log(`FAIL the build or the run: ${list.error}`); process.exit(1); }
check(list.unresolved.length === 0, `every symbol resolved (${list.functions} functions)`, list.unresolved.slice(0, 8).join(' '));
const failed = list.failures.map((n) => String(n).split('$').pop()).sort();
check(JSON.stringify(failed) === JSON.stringify(ASM_ONLY),
  `the only functions not emitted are the two x86-assembly pixel doublers`, failed.join(' '));

/*
 * The two readings are not the same set, and the gate says which way each bound holds. The text
 * also finds ROM tables no driver in src/driver.c's list uses (arkanunk's, for one), which the
 * program rightly never prints -- so "stated" is an upper bound. What must hold exactly is the
 * other direction: nothing is printed that the sources do not spell. And the listing must be
 * nearly all of what is stated, or a table walk that stopped early would pass.
 */
const want = pairsFromSource(), got = pairsFromProgram(list.stdout);
const surplus = (g) => difference(g, want);
const coverage = (g) => (want.size - difference(want, g).length) / want.size;
const s0 = surplus(got);
check(got.size > 5000 && s0.length === 0,
  `every one of the ${got.size} (CRC, file) pairs -listcrc prints is spelled in the driver sources`,
  `${s0.length} printed and not stated (${s0.slice(0, 4).join(', ')})`);
check(coverage(got) >= 0.95,
  `they are ${(100 * coverage(got)).toFixed(1)}% of the ${want.size} the sources state (the rest belong to tables no listed driver uses)`);

// Both have to be able to fail: one printed pair with one bit of its CRC flipped, and half a listing.
{
  const one = [...got][Math.floor(got.size / 2)];
  const flipped = `${(parseInt(one.slice(0, 8), 16) ^ 1).toString(16).padStart(8, '0')}${one.slice(8)}`;
  const mutated = new Set(got); mutated.delete(one); mutated.add(flipped);
  check(surplus(mutated).length === 1, 'control: a single flipped CRC bit in the listing is seen');
  const lines = list.stdout.split('\n');
  check(coverage(pairsFromProgram(lines.slice(0, lines.length >> 1).join('\n'))) < 0.95, 'control: half a listing is seen');
}

const roms = process.env.PRISM_MAME_ROMS;
if (roms) {
  for (const game of ['invaders', '1942']) {
    if (!existsSync(join(roms, `${game}.zip`))) { console.log(`     (${game}.zip is not in ${roms}: not run)`); continue; }
    const r = child(game, 900, '-nodouble');
    check(!r.error && r.frames >= 900 && r.pens > 2,
      `SMOKE ${game}: ${r.frames} frames presented at ${r.width}x${r.height}, ${r.pens} pens on screen (starts; not a reference)`, r.error ?? '');
  }
  const none = child('invaders', 50, '-nodouble', '-romdir', 'nosuchset');
  check((none.frames ?? 0) === 0, 'SMOKE control: with the ROM set withheld no frame is presented');

  /*
   * THE REFERENCE, replayed: goldens/mame034.json holds, per game, the fingerprint of the frames
   * PRISM and a native i386 gcc build both printed (tools/mame034diff.mjs --write records a game
   * only when the two agreed). Five of them here, one per CPU family -- 8080, Z80, 6502 vector,
   * 68000, TMS34010; the tool's own --check replays them all.
   */
  const { readGolden, runPrism, fingerprint } = await import('./mame034diff.mjs');
  const golden = readGolden();
  if (!golden) check(false, 'goldens/mame034.json is in the tree');
  else {
    const argv = [golden.frames, ...golden.play];
    let control = null;
    for (const game of ['invaders', '1942', 'asteroid', 'ffight', 'smashtv']) {
      const want = golden.games[game];
      if (!want || !existsSync(join(roms, `${game}.zip`))) { console.log(`     (${game}: not in the golden or no zip here, not replayed)`); continue; }
      const lines = runPrism(roms, game, argv);
      const got = fingerprint(lines);
      check(got && got.fingerprint === want.fingerprint && got.frames === want.frames,
        `${game}: ${want.frames} played frames, the pictures and palettes a native gcc build printed`,
        got ? `${got.frames} frames ${got.fingerprint}, golden ${want.fingerprint}` : `no frame: ${lines.filter(Boolean).slice(-2).join(' | ')}`);
      control ??= { lines, want };
    }
    // One frame line's hash altered by one digit, and the run cut short by a frame: both must show.
    if (control) {
      const i = control.lines.findIndex((l) => /^frame 700 /.test(l));
      const flipped = control.lines.map((l, k) => (k === i ? l.replace(/([0-9a-f])( [0-9a-f]{8})$/, (_m, d, rest) => `${d === '0' ? '1' : '0'}${rest}`) : l));
      check(i >= 0 && fingerprint(flipped).fingerprint !== control.want.fingerprint, 'control: one altered digit in one frame of 1500 changes the fingerprint');
      const short = fingerprint(control.lines.filter((l) => !/^frame 1499 /.test(l)));
      check(short.frames === control.want.frames - 1 && short.fingerprint !== control.want.fingerprint, 'control: a run one frame short is seen');
    }

    /*
     * THE LIGHT BUILD, which is what the page is served (tools/mame-light.mjs, P16.10): one archive
     * of the makefile and the CPU cores its drivers use, instead of 695 units. Held to the same
     * golden as the whole build -- the frames a native gcc build printed -- so what was left out
     * was not needed. Three games whose builds differ in kind: one archive and one core family;
     * the 68000; and Exterminator, whose archive only links with another one's routine.
     */
    for (const game of ['invaders', 'ffight', 'exterm']) {
      const want = golden.games[game];
      if (!want || !existsSync(join(roms, `${game}.zip`))) { console.log(`     (${game}: not in the golden or no zip here, light build not replayed)`); continue; }
      const got = fingerprint(runPrism(roms, game, argv, { light: true }));
      check(got && got.fingerprint === want.fingerprint && got.frames === want.frames,
        `LIGHT ${game}: the same ${want.frames} frames from the build of its archive alone`,
        got ? `${got.frames} frames ${got.fingerprint}, golden ${want.fingerprint}` : 'printed no frame');
    }
    if (golden.games.exterm && existsSync(join(roms, 'exterm.zip'))) {
      const alone = fingerprint(runPrism(roms, 'exterm', argv, { light: 'alone' }));
      check(!alone || alone.fingerprint !== golden.games.exterm.fingerprint,
        'LIGHT control: Exterminator\'s archive WITHOUT the one its links need does not pass');
    }

    /*
     * ...and that light build as a STATIC BUNDLE (tools/bundle.mjs, P13.1): written to disk and
     * read back, so what runs was not compiled in the process that runs it. Final Fight, for the
     * largest program of the three. The round trip itself, with its controls, is gate-bundle's.
     */
    if (golden.games.ffight && existsSync(join(roms, 'ffight.zip'))) {
      const got = fingerprint(runPrism(roms, 'ffight', argv, { light: 'bundle' }));
      check(got && got.fingerprint === golden.games.ffight.fingerprint && got.frames === golden.games.ffight.frames,
        `BUNDLE ffight: the same ${golden.games.ffight.frames} frames from the bundle read back from disk`,
        got ? `${got.frames} frames ${got.fingerprint}` : 'printed no frame');
    }
  }
} else {
  console.log('     (no PRISM_MAME_ROMS: the smoke runs are not made)');
}

console.log(bad ? `\n${bad} check(s) failed` : '\nMAME 0.34 builds whole with its DOS layer, its ROM tables read back as the sources state them' + (roms ? ', and five games print what a native gcc build printed' : ''));
process.exit(bad ? 1 : 0);
