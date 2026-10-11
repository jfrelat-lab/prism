// gate-scummvm010.mjs — ScummVM 0.10.0 builds whole from its C++ (P14.7).
//
//   1. config.h, config.mk and the object list are what the release's own configure and Makefile
//      write (tools/scummvm010-configure.mjs, in the oracle container), and targets/scummvm010.json
//      lists exactly those objects;
//   2. all 535 units -- thirteen engines and the SDL backend -- lower from C++ and compile, every
//      function is emitted, no name is unresolved, no header is missing, and there is a main: "nothing
//      unresolved" said nothing while the list missed the backend, whose sdl.cpp has main, since
//      nothing then called anything at all.
//
// For each game of tools/scummvmdiff.mjs's GAMES whose files are present -- and the engine data files
// 0.10.0 reads beside some (sky.cpt for Beneath a Steel Sky, KYRA.DAT for Kyrandia):
//
//   3. THE REFERENCE, replayed: each of the first 3,000 presented frames is the picture a native g++
//      build of 0.10.0 over the real SDL 1.2 presented (goldens/scummvm010-*.json, written by
//      `tools/scummvmdiff.mjs --version=0.10.0 --write` only when the two agreed on every frame), with
//      the same scripted player as 0.6.1's gate. The mouse cursor is drawn through SDL_SetColorKey:
//      without the key, the Monkey Island demo differs from frame 74.
//
//   node tools/gate-scummvm010.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const SRC = join(ROOT, 'corpus/scummvm-0.10.0');

// ---- a child that runs one game and reports its frames.
if (process.argv[2] === '--run') {
  const { prismFrames, GAMES, VERSIONS, gameData, gameArgs, gameExtras } = await import('./scummvmdiff.mjs');
  const g = GAMES[process.argv[3]], v = VERSIONS['0.10.0'];
  let report;
  try {
    report = { frames: await prismFrames(gameData(g), +process.argv[4], gameArgs(g, v), null, { input: g.input, folder: g.folder, exclude: g.exclude ?? [], target: v.target, extra: gameExtras(g, v) }) };
  } catch (e) { report = { frames: [], error: e.message.split('\n')[0] }; }
  process.stdout.write(JSON.stringify(report) + '\n', () => process.exit(0));
  await new Promise(() => {});
}
// ---- the child: the build, in its own process (it wants more heap than a gate runner starts with).
if (process.argv[2] === '--child') {
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const b = buildTarget(loadTarget(join(ROOT, 'targets/scummvm010.json')), { root: ROOT });
  process.stdout.write(JSON.stringify({
    functions: Object.keys(b.program.F).length,
    hasMain: 'main' in b.program.F,
    failures: (b.program.failures ?? []).map((x) => `${x.fn}: ${x.message}`),
    // Functions AND variables: a variable declared and never defined is otherwise given storage
    // silently, and read 0 (String::_builtinCapacity was, and String copied nothing).
    unresolved: [...(b.program.undefined ?? []), ...(b.program.undefinedVars ?? [])].map((u) => u.name),
    missingHeaders: b.missingHeaders ?? [],
  }));
  process.exit(0);
}

if (!existsSync(SRC)) skip('no corpus/scummvm-0.10.0', 'fetch it with the `fetch` line of targets/scummvm010.json');

let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (detail) console.log(`       ${detail}`);
};

const conf = spawnSync('node', [join(ROOT, 'tools/scummvm010-configure.mjs'), '--check'], { encoding: 'utf8' });
check(conf.status === 0, "config.h, config.mk and the object list are what the release's configure and Makefile write", (conf.stdout + conf.stderr).trim());

const target = JSON.parse(readFileSync(join(ROOT, 'targets/scummvm010.json'), 'utf8'));
const { objs } = JSON.parse(readFileSync(join(ROOT, 'corpus/scummvm-0.10.0-generated/objs.json'), 'utf8'));
const listed = objs.map((o) => o.replace(/\.o$/, '.cpp'));
check(JSON.stringify(target.units.list) === JSON.stringify(listed), `targets/scummvm010.json lists the ${listed.length} units the Makefile names`);

const r = spawnSync('node', ['--max-old-space-size=8192', SELF, '--child'], { encoding: 'utf8', maxBuffer: 1 << 26 });
let b = {};
try { b = JSON.parse(r.stdout); } catch { b = { failures: [`the build did not report: ${(r.stderr || '').split('\n').slice(0, 3).join(' | ')}`] }; }
check(b.functions > 0 && b.hasMain && b.failures?.length === 0 && b.unresolved?.length === 0 && b.missingHeaders?.length === 0,
  `all ${listed.length} units lowered and compiled: ${b.functions ?? 0} functions, every one emitted, no name unresolved, no header missing, a main`,
  [...(b.failures ?? []), ...(b.unresolved ?? []), ...(b.missingHeaders ?? [])].slice(0, 6).join(' | '));

const FRAMES = 3000;
const { GAMES, VERSIONS, gameData, gameExtras } = await import('./scummvmdiff.mjs');
const ran = [];
for (const [key, g] of Object.entries(GAMES)) {
  const golden = join(ROOT, VERSIONS['0.10.0'].golden(g));
  if (!existsSync(gameData(g))) { console.log(`     (${g.title}: no ${gameData(g)}, set ${g.env}; not run)`); continue; }
  const absent = gameExtras(g, VERSIONS['0.10.0']).filter((f) => !existsSync(f));
  if (absent.length) { console.log(`     (${g.title}: no ${absent.join(', ')}, an engine data file 0.10.0 needs; not run)`); continue; }
  if (!existsSync(golden)) { check(false, `${key}: a golden for 0.10.0`, `no ${golden}: tools/scummvmdiff.mjs --version=0.10.0 --game=${key} --write`); continue; }
  ran.push(key);
  const want = JSON.parse(readFileSync(golden, 'utf8')).frames.slice(0, FRAMES);
  const run = spawnSync('node', ['--max-old-space-size=8192', SELF, '--run', key, String(FRAMES)], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 1200000 });
  let got;
  try { got = JSON.parse(run.stdout.trim().split('\n').at(-1)); } catch { got = { frames: [], error: (run.stderr || '').slice(-300) }; }
  const first = got.frames.findIndex((h, i) => h !== want[i]);
  const count = Math.min(FRAMES, g.ends ?? FRAMES);   // a game that quits presents fewer
  check(got.frames.length === count && want.length === count && first < 0, `${key}: all ${got.frames.length} frames are the native 0.10.0 build's, picture for picture (the last: ${got.frames.at(-1)})`,
    got.error ?? (first >= 0 ? `first difference at frame ${first + 1}: PRISM ${got.frames[first]}, native ${want[first]}` : `${got.frames.length} frames`));
}
console.log(failed ? `gate-scummvm010: ${failed} FAILED` : `gate-scummvm010: ScummVM 0.10.0 builds whole, ${listed.length} units, ${b.functions} functions${ran.length ? `, and draws ${ran.join(', ')} as g++ and SDL do, 3,000 frames each` : ''}`);
process.exit(failed ? 1 : 0);
