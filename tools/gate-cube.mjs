// gate-cube.mjs — Cube (2005_08_29) builds whole from its C++ (P15.12).
//
//   targets/cube.json lists exactly src/Makefile's CLIENT_OBJS and ENet's libenet sources (less
//   win32.c, all #ifdef WIN32), and every unit lowers and compiles with zlib 1.1.3 beside it: every
//   function emitted, no name unresolved -- functions AND variables -- and a main. "Nothing
//   unresolved" says nothing of a program that never calls anything, hence the main.
//
//   libjpeg (which SDL_image links, for its 568 JPEG textures) is the IJG 6b library compiled from
//   its source, its jconfig.h and objects what its own configure and Makefile write
//   (tools/jpeg6b-configure.mjs --check).
//
//   With the data (~/games/cube/files/cube, or PRISM_CUBE_DATA), it RUNS: 30 frames presented with
//   the default map loaded. CONTROL, red: without its textures (packages/ withheld) it stops before the map.
//
//   THE REFERENCE (tools/cubediff.mjs): Cube built natively by g++ over the real SDL 1.2, SDL_mixer and
//   SDL_image, drawn by Mesa, the same scripted player on both sides (walk, turn, fire, strafe):
//   frames 100, 200 and 300 within the tolerance -- at most 0.5% of the pixels off by more than 8
//   (measured: 0.24%, at the HUD icons' edges and mipmaps; both sides at 320x240, Cube's -w and -h)
//   -- and EVERY audio buffer the native
//   build's, sample for sample, SDL_mixer's panning included. CONTROLS, red, on the native side: the
//   run without the player is outside the tolerance at frame 300 (it sees another viewpoint), and a
//   run at another sound volume (soundvol 128) differs in its sound.
//
//   node tools/gate-cube.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const SRC = join(ROOT, 'corpus/cube_2005_08_29');

// ---- a child that runs Cube for some frames: { frames, output }.
if (process.argv[2] === '--run') {
  const { readdirSync, statSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const { virtualClock } = await import('../src/env/clock.js');
  const data = process.env.PRISM_CUBE_DATA ?? join(homedir(), 'games/cube/files/cube');
  const files = {};
  const walk = (d, pre) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`); else files[pre + f] = new Uint8Array(readFileSync(p)); } };
  walk(join(data, 'data'), 'data/');
  if (process.argv[4] !== 'no-packages') walk(join(data, 'packages'), 'packages/');
  files['autoexec.cfg'] = new Uint8Array(readFileSync(join(data, 'autoexec.cfg')));
  const b = buildTarget(loadTarget(join(ROOT, 'targets/cube.json')), { root: ROOT, compile: { safepoints: true },
    envExtra: { stdio: { files }, sdl12: { clock: virtualClock() } } });
  const M = b.program.M;
  let n = 0;
  M.sdl.state.onSwap = () => { if (++n >= +process.argv[3]) throw new Error('__done'); };
  M.spBudget = 200000;
  M.sp_ = () => { M.spBudget = 200000; };
  let error = null;
  try { b.program.run(['cube_client', '-w320', '-h240']); } catch (e) { if (!/__done/.test(e.message)) error = e.message.split('\n')[0]; }
  process.stdout.write(JSON.stringify({ frames: n, output: String(M.output?.() ?? ''), error }) + '\n', () => process.exit(0));
  await new Promise(() => {});
}
if (process.argv[2] === '--child') {
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const b = buildTarget(loadTarget(join(ROOT, 'targets/cube.json')), { root: ROOT });
  process.stdout.write(JSON.stringify({
    functions: Object.keys(b.program.F).length,
    hasMain: 'main' in b.program.F,
    failures: (b.program.failures ?? []).map((x) => `${x.fn}: ${x.message}`),
    unresolved: [...(b.program.undefined ?? []), ...(b.program.undefinedVars ?? [])].map((u) => u.name),
    missingHeaders: b.missingHeaders ?? [],
  }));
  process.exit(0);
}

if (!existsSync(SRC)) skip('no corpus/cube_2005_08_29', 'unpack cube_2005_08_29_src.zip there (the `fetch` line of targets/cube.json)');

let failed = 0;
const check = (ok, what, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail && !ok ? `\n       ${detail}` : ''}`); };

// The unit list is the Makefile's.
const mk = readFileSync(join(SRC, 'src/Makefile'), 'utf8');
const objs = mk.slice(mk.indexOf('CLIENT_OBJS='), mk.indexOf('SERVER_LIBS')).match(/\b\w+\.o\b/g).map((o) => `src/${o.replace(/\.o$/, '.cpp')}`);
const am = readFileSync(join(SRC, 'enet/Makefile.am'), 'utf8').match(/libenet_a_SOURCES\s*=\s*(.*)/)[1].split(/\s+/).filter((f) => f && f !== 'win32.c').map((f) => `enet/${f}`);
const target = JSON.parse(readFileSync(join(ROOT, 'targets/cube.json'), 'utf8'));
check(JSON.stringify([...target.units.list].sort()) === JSON.stringify([...objs, ...am].sort()),
  `targets/cube.json lists the Makefile's ${objs.length} CLIENT_OBJS and ENet's ${am.length} sources`);

const r = spawnSync('node', ['--max-old-space-size=8192', SELF, '--child'], { encoding: 'utf8', maxBuffer: 1 << 26 });
let b = {};
try { b = JSON.parse(r.stdout); } catch { b = { failures: [`the build did not report: ${(r.stderr || '').split('\n').slice(0, 3).join(' | ')}`] }; }
check(b.functions > 0 && b.hasMain && b.failures?.length === 0 && b.unresolved?.length === 0 && b.missingHeaders?.length === 0,
  `all ${target.units.list.length} units and zlib lowered and compiled: ${b.functions ?? 0} functions, every one emitted, no name unresolved, no header missing, a main`,
  [...(b.failures ?? []), ...(b.unresolved ?? []), ...(b.missingHeaders ?? [])].slice(0, 6).join(' | '));

const conf = spawnSync('node', [join(ROOT, 'tools/jpeg6b-configure.mjs'), '--check'], { encoding: 'utf8' });
check(conf.status === 0, "libjpeg's jconfig.h and decompression objects are what its configure and Makefile write", (conf.stdout + conf.stderr).trim());

const { homedir } = await import('node:os');
const data = process.env.PRISM_CUBE_DATA ?? join(homedir(), 'games/cube/files/cube');
let ran = false;
if (!existsSync(join(data, 'packages'))) console.log(`     (no ${data}: set PRISM_CUBE_DATA to cube_2005_08_29_unix.tar.gz's cube/; not run)`);
else {
  const run = (...a) => {
    const c = spawnSync('node', ['--max-old-space-size=8192', SELF, '--run', ...a], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900000 });
    try { return JSON.parse(c.stdout.trim().split('\n').at(-1)); } catch { return { frames: 0, output: '', error: (c.stderr || '').slice(-300) }; }
  };
  const r = run('30');
  check(r.frames === 30 && /read map packages\/base\/metl3\.cgz/.test(r.output), `it runs: ${r.frames} frames presented, the default map (metl3) loaded`, r.error ?? r.output.slice(-300));
  const w = run('30', 'no-packages');
  check(w.frames < 30 && !/read map/.test(w.output), `control: with its textures withheld it stops, after ${w.frames} of 30 frames and no map`, w.output.slice(-300));
  ran = true;

  const { nativeFrames, prismFrames: cubePrism, comparePictures } = await import('./cubediff.mjs');
  const AT = [100, 200, 300], LIMIT = 0.005, TOL = 8;
  const nat = await nativeFrames(300, AT);
  const mine = await cubePrism(300, AT);
  for (const n of AT) {
    const c = nat.pictures[n] && mine.pictures[n] ? comparePictures(mine.pictures[n], nat.pictures[n], TOL) : null;
    check(c && c.off / c.total <= LIMIT, `frame ${n}: within the tolerance of Mesa's, ${c ? `${c.off} of ${c.total} pixels off by more than ${TOL} (max ${c.max})` : 'missing'}`,
      c ? '' : `PRISM ${mine.frames} frames${mine.error ? ` (${mine.error})` : ''}, native ${nat.hashes.length}`);
  }
  const firstA = mine.audio.findIndex((h, i) => h !== nat.audio[i]), kinds = new Set(nat.audio).size;
  check(mine.audio.length === nat.audio.length && firstA < 0 && kinds > 1, `audio: all ${mine.audio.length} buffers are the native build's, sample for sample (${kinds} of them different)`,
    `PRISM ${mine.audio.length} buffers, native ${nat.audio.length}, first difference at ${firstA + 1}`);
  const still = await nativeFrames(300, [300], []);
  const cs = still.pictures[300] && nat.pictures[300] ? comparePictures(still.pictures[300], nat.pictures[300], TOL) : null;
  check(cs && cs.off / cs.total > LIMIT, `control: the native run without the player is outside the tolerance at frame 300 (${cs ? (100 * cs.off / cs.total).toFixed(2) : '?'}% off)`);
  const quiet = await nativeFrames(300, [], undefined, 'soundvol 128\n');
  check(quiet.audio.some((h, i) => h !== nat.audio[i]), 'control: the native run at another sound volume (soundvol 128) differs in its sound');
}
console.log(failed ? `gate-cube: ${failed} FAILED` : `gate-cube: Cube builds whole, ${b.functions} functions${ran ? ', and runs its default map as g++, SDL and Mesa do' : ''}`);
process.exit(failed ? 1 : 0);
