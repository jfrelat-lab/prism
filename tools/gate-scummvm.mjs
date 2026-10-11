// gate-scummvm.mjs — ScummVM 0.6.1 builds whole from its C++, and runs Beneath a Steel Sky and two SCUMM demos.
//
// What is held, without the game:
//
//   1. config.h is what the release's own configure writes (tools/scummvm-configure.mjs, in the
//      oracle container), and targets/scummvm.json lists what the release's module lists name;
//   2. all 170 units (the Sky, SCUMM and Queen engines) lower from C++ and compile, every function is emitted and no name is unresolved.
//
// For each game of tools/scummvmdiff.mjs's GAMES whose files are present -- Beneath a Steel Sky
// (PRISM_SCUMMVM_DATA, sky.dsk and sky.dnr), the EGA demo of Monkey Island and the demo of Day of the
// Tentacle (PRISM_SCUMMVM_MONKEY / _DOTT, else ~/games/scumm/...) -- the game run
// on the virtual clock (src/env/clock.js), where a delay advances time instead of waiting:
//
//   3. THE REFERENCE, replayed: each of the first 3,000 presented frames is the picture a native g++ build of the same sources over the real SDL 1.2
//      presented (goldens/scummvm.json, written by tools/scummvmdiff.mjs only when the two agreed on
//      every frame; time, timer and audio wrapped onto the same clock, everything that draws real) --
//      WITH A PLAYER: tools/scummvmdiff.mjs's input script skips the introduction (Esc), opens the
//      control panel (F5) and moves the pointer in it, closes it, walks, clicks the door with each
//      button (Sky does different things), dies, and clicks "play again". Swapping the two buttons in
//      the shim differs from frame 378, losing F5 from frame 187 (measured by hand);
//   4. THE SOUND, the same way: each buffer the audio callback filled before the last frame is the
//      native build's (FNV-1a of its bytes, wrap.c), and they are not all one buffer (silence
//      hashes alike); for Sky also music the page hears, buffers that are not silence;
//   5. controls, red: with the game's files withheld no frame is presented, and a run with another
//      scaler (-gnormal, 320x200) disagrees with the reference at its first frame -- the comparison
//      sees a difference when there is one.
//
//   node tools/gate-scummvm.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const SRC = join(ROOT, 'corpus/scummvm-0.6.1');
const FRAMES = 3000;

// ---- the child: one build and, given data, one run. A JSON report on stdout.
if (process.argv[2] === '--child') {
  const [, , , data, mode, ...args] = process.argv;
  const report = {};
  if (mode === 'build') {
    const { loadTarget, buildTarget } = await import('../src/target.js');
    const b = buildTarget(loadTarget(join(ROOT, 'targets/scummvm.json')), { root: ROOT });
    Object.assign(report, {
      functions: Object.keys(b.program.F).length,
      failures: (b.program.failures ?? []).map((x) => `${x.fn}: ${x.message}`),
      // Functions AND variables: a variable declared and never defined is otherwise given storage
      // silently, and read 0 (String::_builtinCapacity was, and String copied nothing).
      unresolved: [...(b.program.undefined ?? []), ...(b.program.undefinedVars ?? [])].map((u) => u.name),
      missingHeaders: b.missingHeaders,
    });
  } else {
    // data is a game's key in scummvmdiff.mjs's GAMES, or 'none': the Sky build with no files.
    const { prismFrames, GAMES, gameData, gameArgs } = await import('./scummvmdiff.mjs');
    const g = GAMES[data] ?? GAMES.sky;
    const audio = {};
    try {
      report.frames = await prismFrames(data === 'none' ? '' : gameData(g), +mode, args.length ? args : gameArgs(g), audio,
        { input: g.input, folder: g.folder, exclude: g.exclude ?? [] });
      report.audio = report.frames.audio;
    } catch (e) { report.error = e.message.split('\n')[0]; report.frames = []; }
    Object.assign(report, audio);
  }
  process.stdout.write(JSON.stringify(report) + '\n', () => process.exit(0));
  await new Promise(() => {});
}

// ---- the gate.
let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail && !ok ? `\n       ${detail}` : ''}`);   // the detail: why it failed
  if (!ok) failed++;
};
if (!existsSync(SRC) || !existsSync(join(ROOT, 'corpus/scummvm-0.6.1-generated/config.h'))) {
  skip('ScummVM 0.6.1 is not in corpus/ (see the fetch line of targets/scummvm.json)');
}
const child = (...a) => {
  const r = spawnSync('node', ['--max-old-space-size=8000', SELF, '--child', ...a], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900000 });
  try { return JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { return { error: (r.stderr || r.stdout || '').slice(-400) }; }
};

const conf = spawnSync('node', [join(ROOT, 'tools/scummvm-configure.mjs'), '--check'], { encoding: 'utf8' });
check(conf.status === 0, 'config.h is what the release\'s configure writes', (conf.stdout + conf.stderr).trim());

const V = SRC;
const objsOf = (mk) => [...readFileSync(join(V, mk), 'latin1').replace(/\\\n/g, ' ').matchAll(/([\w/.-]+)\.o\b/g)].map((m) => m[1]);
const listed = [...['base', 'common', 'gui', 'sound', 'backends', 'sky', 'scumm', 'queen'].flatMap((m) => objsOf(`${m}/module.mk`)), 'backends/sdl/sdl-common', 'backends/sdl/sdl'].map((o) => `${o}.cpp`);
const target = JSON.parse(readFileSync(join(ROOT, 'targets/scummvm.json'), 'utf8'));
check(JSON.stringify(target.units.list) === JSON.stringify(listed), `targets/scummvm.json lists the ${listed.length} units the module lists name`);

const b = child('', 'build');
check(!b.error, `the whole program builds: ${b.functions} functions`, b.error ?? '');
check(b.failures?.length === 0 && b.unresolved?.length === 0 && b.missingHeaders?.length === 0,
  'every function emitted, no name unresolved, no header missing', [...(b.failures ?? []), ...(b.unresolved ?? []), ...(b.missingHeaders ?? [])].slice(0, 6).join(' | '));

/*
 * THE GAMES, each where scummvmdiff.mjs looks for it (its environment variable, else ~/games): each
 * one present is run with its player and held to its reference; one absent is said to be.
 */
const { GAMES, gameData } = await import('./scummvmdiff.mjs');
const ran = [];
for (const [key, g] of Object.entries(GAMES)) {
  if (g.only010) continue;
  if (!existsSync(gameData(g))) { console.log(`     (${g.title}: no ${gameData(g)}, set ${g.env}; not run)`); continue; }
  ran.push(key);
  const gold = JSON.parse(readFileSync(join(ROOT, g.golden), 'utf8')), golden = gold.frames.slice(0, FRAMES);
  const r = child(key, String(FRAMES));
  const first = r.frames.findIndex((h, i) => h !== golden[i]);
  check(r.frames.length === FRAMES && first < 0,
    `${key}: all ${r.frames.length} frames are the native build's, picture for picture (the last: ${r.frames.at(-1)})`,
    r.error ?? (first >= 0 ? `first difference at frame ${first + 1}: PRISM ${r.frames[first]}, native ${golden[first]}` : `${r.frames.length} frames`));
  // The sound the same way, and not all one buffer: silence hashes alike.
  const hear = gold.audio ?? [], heard = r.audio ?? [], firstA = heard.findIndex((h, i) => h !== hear[i]), kinds = new Set(hear).size;
  // A game silent on both sides says why (`quiet`); every other one has sound to compare.
  check(gold.audio && heard.length === hear.length && firstA < 0 && (g.quiet ? kinds === 1 : kinds > 1),
    g.quiet ? `${key}: silent on both sides, all ${heard.length} buffers -- ${g.quiet}`
      : `${key}: all ${heard.length} audio buffers are the native build's, sample for sample (${kinds} of them different)`,
    !gold.audio ? `the golden has no sound: tools/scummvmdiff.mjs --game=${key} --write`
      : firstA >= 0 ? `first difference at buffer ${firstA + 1}: PRISM ${heard[firstA]}, native ${hear[firstA]}`
      : heard.length !== hear.length ? `PRISM filled ${heard.length} buffers, native ${hear.length}`
      : g.quiet ? `${kinds} different buffers where silence was expected` : 'the buffers are all one: nothing to compare');
  if (key === 'sky') {
    check(r.loud > 100, `sky: music the page hears, ${r.loud} of ${r.buffers} buffers not silence`);
    const withheld = child('none', '10');
    check(withheld.frames.length === 0, 'control: with the game\'s files withheld, no frame is presented', withheld.error ?? '');
    const other = child('sky', '30', '-gnormal', '-psky', 'sky');
    check(other.frames.length > 0 && other.frames[0] !== golden[0], 'control: another scaler (-gnormal) disagrees with the reference at its first frame', other.error ?? '');
    // The sound's own control: the music at another volume (-m100) changes the buffers while the
    // pictures are still the reference's (Sky's introduction waits on its music, so later they part:
    // frame 189 on 0.6.1, 227 on 0.10.0) -- the comparison hears a difference when there is one.
    const quieter = child('sky', '150', '-m100', '-psky', 'sky');
    const sameFrames = (quieter.frames ?? []).length === 150 && quieter.frames.every((h, i) => h === golden[i]);
    const diffAt = (quieter.audio ?? []).findIndex((h, i) => h !== (gold.audio ?? [])[i]);
    check(sameFrames && diffAt >= 0, `control: the music at another volume (-m100) keeps the 150 first frames and differs from the reference's sound at buffer ${diffAt + 1}`, quieter.error ?? (sameFrames ? 'the sound did not change' : 'the frames changed'));
  }
}
console.log(failed ? `gate-scummvm: ${failed} FAILED` : `gate-scummvm: ScummVM 0.6.1 builds whole${ran.length ? ` and draws and sounds ${ran.join(', ')} as g++ and SDL do, 3,000 frames each` : ''}`);
process.exit(failed ? 1 : 0);
