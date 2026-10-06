// mame034diff.mjs — MAME 0.34 built twice, by an i386 gcc and by PRISM, and compared frame by frame.
//
// tools/mamediff.mjs does this for releases 0.1 to 0.7. 0.34 needs its own tool because nothing
// about the build is the same size: 695 units whose basenames collide across drivers/, machine/,
// vidhrdw/ and sndhrdw/ (so no flat directory), an osd interface of some ninety functions (so its
// own backend, tools/mamediff/osdnull34.c), and a native build that takes minutes -- made ONCE,
// with make, and kept: the backend takes the game and the schedule on its command line, so one
// binary answers for every game.
//
// Both sides compile the same sources: everything in targets/mame034.json but src/msdos, plus
// src/msdos/fileio.c as it is (the zip and CRC lookup is the release's own) and the backend. Every
// emulated frame prints a hash of the screen bitmap and of the palette; the first differing line
// is where the two builds part.
//
//   node tools/mame034diff.mjs --roms=<dir of zips> --games=a,b,c [--frames=300]
//                              [--play=coin,start,fireFrom,fireTo] [--dump=N]
//
// No ROM enters the repository: the zips a game needs are copied into the gitignored .oracle/ for
// the container to read, and removed when the game has run.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sh, SCRATCH } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const arg = (k, d = null) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CORPUS = join(ROOT, 'corpus', 'mame034');
const BACKEND = join(ROOT, 'tools', 'mamediff', 'osdnull34.c');
const target = JSON.parse(readFileSync(join(ROOT, 'targets', 'mame034.json'), 'utf8'));
/** The units of both builds: the target's, less the DOS layer, plus the DOS layer's file I/O. */
const UNITS = [...target.units.list.filter((u) => !/^src\/msdos\//i.test(u)), 'src/msdos/fileio.c'];

/*
 * WHAT FRESH MEMORY HOLDS, said out loud on both sides.
 *
 * MAME 0.34 reads memory it never wrote: Smash TV's palette RAM is a bare malloc that its word
 * write combines new data INTO, so the colour of pen 0 is whatever the allocator left there. The
 * native build shows it by itself -- MALLOC_PERTURB_ set to five values gave five pictures for
 * frame 0 -- so without this the two sides compare their allocators, not their compilers.
 *
 * glibc's MALLOC_PERTURB_=n fills every block malloc returns with ~n (calloc stays zero). The same
 * byte is written into every block PRISM's malloc returns. 0x55 gives 0xAA: not zero, so a read of
 * unwritten memory is not quietly the same as a read of cleared memory.
 */
const PERTURB = 0x55, FILL = PERTURB ^ 0xff;

/*
 * One unit pastes a name and `++` with ## (machine/smashtv.c), which DJGPP's gcc 2.8 let through as
 * two tokens and gcc 12 refuses outright. Neither side may be patched, so for that unit the
 * PREPROCESSOR is tcc's, which bends as gcc 2.8 did, posing as gcc so that glibc's headers come out
 * the way gcc will read them; gcc still compiles the result. PRISM's side is `lenientPaste`.
 */
const LENIENT_PASTE = ['src/machine/smashtv.c'];

/** The driver a clone borrows ROMs from, read from the driver sources: `&parent_driver` in its struct. */
export function parentOf(game) {
  const dir = join(CORPUS, 'src', 'drivers');
  const r = spawnSync('grep', ['-rlE', `"${game}",`, dir], { encoding: 'utf8' });
  for (const f of r.stdout.trim().split('\n').filter(Boolean)) {
    const text = readFileSync(f, 'latin1');
    const m = new RegExp(`struct\\s+GameDriver\\s+\\w+\\s*=\\s*\\{\\s*__FILE__\\s*,\\s*(&\\s*(\\w+)|0)\\s*,\\s*"${game}"`).exec(text);
    if (!m || !m[2]) continue;
    const p = new RegExp(`struct\\s+GameDriver\\s+${m[2]}\\s*=\\s*\\{\\s*__FILE__\\s*,[^,]*,\\s*"([^"]+)"`).exec(text);
    if (p) return p[1];
  }
  return null;
}

// ---------------------------------------------------------------- the PRISM side, one process a game
if (process.argv[2] === '--prism') {
  const { buildTarget } = await import('../src/target.js');
  const [, , , romDir, ...argv] = process.argv;
  const files = {};
  for (const g of [argv[0], parentOf(argv[0])].filter(Boolean)) {
    const z = join(romDir, `${g}.zip`);
    if (existsSync(z)) files[`ROMS/${g}.zip`] = new Uint8Array(readFileSync(z));
  }
  const t = { ...target, units: { list: UNITS }, env: ['stdio'],
    inline: { ...(target.inline ?? {}), 'osdnull34.c': readFileSync(BACKEND, 'latin1') } };
  const { program } = buildTarget(t, { root: ROOT, envExtra: { stdio: { files } } });
  {
    const M = program.M, malloc = M.rt.malloc;
    const filled = (n) => { const p = malloc(n); if (p) M.u8.fill(FILL, p, p + (n >>> 0)); return p; };
    M.rt.malloc = filled;
    program.mod.bindFunc('malloc', filled);
  }
  let out = '', error = '';
  try { out = program.run(['mameref34', ...argv])?.stdout ?? ''; }
  catch (e) { error = `PRISM threw: ${e.message.split('\n')[0]}\n${(e.stack ?? '').split('\n').slice(1, 6).join('\n')}`; out = program.M.stdoutText?.() ?? ''; }
  process.stdout.write(out + (error ? `\n${error}\n` : ''), () => process.exit(0));
  await new Promise(() => {});
}

// ---------------------------------------------------------------- the native side, built once
const WORK = join(SCRATCH, 'mame034');
/** Stage the sources and (re)build the reference with make; returns null, or what went wrong. */
export function buildReference(say = console.log) {
  mkdirSync(join(WORK, 'stub'), { recursive: true });
  if (!existsSync(join(WORK, 'src', 'mame.c'))) cpSync(join(CORPUS, 'src'), join(WORK, 'src'), { recursive: true });
  // The one header of the DOS layer's libraries fileio.c names. It uses nothing from it.
  writeFileSync(join(WORK, 'stub', 'allegro.h'), '/* fileio.c includes it and uses nothing of it */\n');
  const staged = join(WORK, 'osdnull34.c');
  if (!existsSync(staged) || readFileSync(staged, 'latin1') !== readFileSync(BACKEND, 'latin1')) copyFileSync(BACKEND, staged);
  const defs = Object.entries(target.defines).map(([k, v]) => `-D'${k}=${v}'`).join(' ');
  const incs = ['stub', ...target.include].map((d) => `-I${d}`).join(' ');
  const objs = [...UNITS, 'osdnull34.c'].map((u) => ({ src: u, obj: `obj/${u.replace(/[\/.]/g, '_')}.o` }));
  /*
   * -O0 and SSE arithmetic. No optimiser, so the reference is what the source says; and doubles
   * computed as doubles (the x87's 80-bit intermediates are an artefact of one FPU, and PRISM's
   * arithmetic is IEEE double, which is also what any later compiler gives this code).
   */
  const mk = [
    `CFLAGS = -m32 -O0 -w -std=gnu89 -fcommon -fno-strict-aliasing -fwrapv -msse2 -mfpmath=sse ${defs} ${incs}`,
    `OBJS = ${objs.map((o) => o.obj).join(' ')}`,
    'mameref34: $(OBJS)', '\tgcc -m32 -o $@ $(OBJS) -lm',
    ...objs.flatMap((o) => (LENIENT_PASTE.includes(o.src)
      ? [`${o.obj}: ${o.src}`, `\t@tcc -E -w -U__TINYC__ -D__GNUC__=12 -D__GNUC_MINOR__=2 -D__i386__=1 ${defs} ${incs} -o ${o.obj}.pp.c $<`,
        `\t@gcc $(CFLAGS) -c -o $@ ${o.obj}.pp.c`]
      : [`${o.obj}: ${o.src}`, '\t@gcc $(CFLAGS) -c -o $@ $<'])),
    '',
  ].join('\n');
  writeFileSync(join(WORK, 'Makefile'), mk);
  mkdirSync(join(WORK, 'obj'), { recursive: true });
  const fresh = !existsSync(join(WORK, 'mameref34'));
  if (fresh) say(`building the native reference (${objs.length} units, once; a few minutes)...`);
  const r = sh('cd mame034 && make -j8 mameref34 > build.log 2>&1; echo "RC $?"; tail -15 build.log', { timeout: 3600000 });
  return /RC 0/.test(r.stdout) ? null : r.stdout;
}

/** PRISM's side of one game: the lines it printed. */
export function runPrism(romDir, game, argv) {
  const p = spawnSync('node', ['--max-old-space-size=8192', SELF, '--prism', romDir, game, ...argv.map(String)],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 1000000 });
  return `${p.stdout ?? ''}${p.stderr ?? ''}`.split('\n');
}

/** Run one game on both sides. Returns { ref: [...lines], prism: [...lines] }. */
export function runBoth(romDir, game, argv) {
  const run = join(WORK, 'ROMS');
  rmSync(run, { recursive: true, force: true });
  mkdirSync(run, { recursive: true });
  try {
    for (const g of [game, parentOf(game)].filter(Boolean)) {
      if (existsSync(join(romDir, `${g}.zip`))) copyFileSync(join(romDir, `${g}.zip`), join(run, `${g}.zip`));
    }
    const r = sh(`cd mame034 && MALLOC_PERTURB_=${PERTURB} timeout 900 ./mameref34 ${[game, ...argv].join(' ')} < /dev/null 2>&1`, { timeout: 1000000 });
    return { ref: r.stdout.split('\n'), prism: runPrism(romDir, game, argv) };
  } finally {
    rmSync(run, { recursive: true, force: true });           // the ROMs do not stay
  }
}

const frameLines = (lines) => lines.filter((l) => /^frame \d+ [0-9a-f]{8} [0-9a-f]{8}$/.test(l));
/** What a run is remembered by: its frame lines, hashed. Null when it printed none. */
export function fingerprint(lines) {
  const f = frameLines(lines);
  return f.length ? { fingerprint: createHash('sha256').update(f.join('\n')).digest('hex').slice(0, 16), frames: f.length } : null;
}
/** { agreed, frames, first: index of the first differing frame line or -1, why } */
export function compare({ ref, prism }, wanted) {
  const a = frameLines(ref), b = frameLines(prism);
  let first = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { first = i; break; }
  const agreed = first < 0 && a.length >= wanted;
  const tail = (lines) => lines.filter((l) => l && !/^frame /.test(l)).slice(-3).join(' | ');
  const why = agreed ? '' : first >= 0
    ? `frame line ${first}: gcc "${a[first] ?? '(none)'}"  prism "${b[first] ?? '(none)'}"`
    : `only ${a.length} frames from gcc (${tail(ref)}) and ${b.length} from PRISM (${tail(prism)})`;
  return { agreed, frames: a.length, first, why, lines: a };
}

/*
 * THE GOLDEN, goldens/mame034.json: one fingerprint per game, written ONLY for a game whose
 * differential was green at that moment (the rule tools/mame-golden.mjs states for 0.1 to 0.7 --
 * a fingerprint taken from PRISM alone would freeze whatever PRISM did, right or wrong). `--check`
 * then replays PRISM's side alone, which needs neither the container nor the native build.
 */
export const GOLDEN = join(ROOT, 'goldens', 'mame034.json');
export const readGolden = () => (existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : null);

if (process.argv[1] === SELF && process.argv[2] !== '--prism') {
  const romDir = arg('roms'), dump = arg('dump');
  const WRITE = process.argv.includes('--write'), CHECK = process.argv.includes('--check');
  const golden = readGolden();
  const frames = +arg('frames', CHECK && golden ? golden.frames : 300);
  const play = (arg('play') ?? (CHECK && golden ? golden.play.join(',') : '0,0,0,0')).split(',').map(Number);
  const games = (arg('games') ?? (CHECK && golden ? Object.keys(golden.games).join(',') : '')).split(',').filter(Boolean);
  if (!romDir || !existsSync(romDir) || !games.length || (CHECK && !golden)) {
    console.error('usage: node tools/mame034diff.mjs --roms=<dir of zips> --games=a,b [--frames=300] [--play=coin,start,fireFrom,fireTo] [--dump=N] [--write]\n' +
      '       node tools/mame034diff.mjs --roms=<dir of zips> --check [--games=a,b]      PRISM alone, against goldens/mame034.json');
    process.exit(2);
  }
  const argv = [frames, ...play, ...(dump ? [dump] : [])];
  let bad = 0;

  if (CHECK) {
    for (const game of games) {
      const want = golden.games[game];
      if (!want) { console.log(`absent  ${game.padEnd(9)} is not in the golden`); bad++; continue; }
      if (!existsSync(join(romDir, `${game}.zip`))) { console.log(`no ROMs ${game.padEnd(9)} ${game}.zip is not in ${romDir}`); continue; }
      const got = fingerprint(runPrism(romDir, game, argv));
      const ok = got && got.fingerprint === want.fingerprint && got.frames === want.frames;
      console.log(`${ok ? 'match  ' : 'CHANGED'} ${game.padEnd(9)} ${got ? `${got.frames} frames ${got.fingerprint}` : 'printed no frame'}${ok ? '' : `  (golden: ${want.frames} frames ${want.fingerprint})`}`);
      if (!ok) bad++;
    }
    console.log(`\n${games.length - bad} of ${games.length} games still print what agreed with the native build`);
    process.exit(bad ? 1 : 0);
  }

  const err = buildReference();
  if (err) { console.error(`the native build failed:\n${err}`); process.exit(1); }
  // A partial write merges: regenerating two games must not delete the others.
  const out = { _doc: [
    'MAME 0.34, per game: the fingerprint of the frame lines PRISM and a native i386 gcc build BOTH printed',
    '(tools/mame034diff.mjs --write). Recorded only for a game whose differential was green when written.',
    'A frame line is a hash of the screen bitmap and one of the palette, per emulated frame; `play` is the',
    'schedule both sides were given (coin, start, fire from, fire to, in frames). No ROM data is in here.',
  ], release: '034', frames, play, games: { ...(golden && golden.frames === frames && String(golden.play) === String(play) ? golden.games : {}) } };
  for (const game of games) {
    const t0 = Date.now();
    const both = runBoth(romDir, game, argv);
    const c = compare(both, frames);
    console.log(`${c.agreed ? 'AGREE  ' : 'DIFFER '} ${game.padEnd(9)} ${String(c.frames).padStart(5)} frames  ${((Date.now() - t0) / 1000).toFixed(0)} s${c.why ? `\n         ${c.why}` : ''}`);
    if (!c.agreed) bad++;
    if (WRITE) { if (c.agreed) out.games[game] = fingerprint(both.prism); else delete out.games[game]; }
    if (dump) { writeFileSync(join(SCRATCH, `mame034-${game}-ref.txt`), both.ref.join('\n')); writeFileSync(join(SCRATCH, `mame034-${game}-prism.txt`), both.prism.join('\n')); }
  }
  console.log(`\n${games.length - bad} of ${games.length} games agree with the native build over ${frames} frames`);
  if (WRITE) { writeFileSync(GOLDEN, `${JSON.stringify(out, null, 2)}\n`); console.log(`${Object.keys(out.games).length} games in ${GOLDEN}`); }
  process.exit(bad ? 1 : 0);
}
