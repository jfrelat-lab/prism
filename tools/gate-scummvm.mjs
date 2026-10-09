// gate-scummvm.mjs — ScummVM 0.6.1 builds whole from its C++, and runs Beneath a Steel Sky.
//
// What is held, without the game:
//
//   1. config.h is what the release's own configure writes (tools/scummvm-configure.mjs, in the
//      oracle container), and targets/scummvm.json lists what the release's module lists name;
//   2. all 85 units lower from C++ and compile, every function is emitted and no name is unresolved.
//
// With PRISM_SCUMMVM_DATA=<dir holding sky.dsk and sky.dnr> (bass-cd-1.0.zip's sky-cd/), a run of
// the game on the virtual clock (src/env/clock.js), where a delay advances time instead of waiting:
//
//   3. 3,000 frames are presented on a 640x400 16-bit display, through the introduction and into the
//      first room, with music: audio buffers that are not silence;
//   4. the run is REPRODUCIBLE -- a second run presents the same last picture -- and that picture is
//      the one recorded below. That pins PRISM to ITSELF: it catches a change in what the compiled
//      program does, and says nothing about whether the picture is the one a native ScummVM shows.
//      There is no native reference for ScummVM yet (docs/ROADMAP.md, P14.6);
//   5. control: with the game's files withheld, no frame is presented.
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
// The last picture of the run above, as FNV-1a over the display's bytes. Written from a run that was
// looked at (the first room, Foster on the walkway) -- see the header for what it does and does not say.
const PICTURE = 'fbf839fd';

// ---- the child: one build and, given data, one run. A JSON report on stdout.
if (process.argv[2] === '--child') {
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const { virtualClock } = await import('../src/env/clock.js');
  const data = process.argv[3] ?? '';
  const files = {};
  if (data) for (const f of ['sky.dsk', 'sky.dnr']) files[`sky/${f}`] = new Uint8Array(readFileSync(join(data, f)));
  const b = buildTarget(loadTarget(join(ROOT, 'targets/scummvm.json')), {
    root: ROOT, compile: { safepoints: true }, envExtra: { stdio: { files }, sdl12: { clock: virtualClock() } },
  });
  const { program } = b, M = program.M, sdl = M.sdl.state;
  const report = {
    functions: Object.keys(program.F).length,
    failures: (program.failures ?? []).map((f) => `${f.fn}: ${f.message}`),
    unresolved: (program.undefined ?? []).map((u) => u.name),
    missingHeaders: b.missingHeaders,
  };
  if (process.argv[4] === 'run') {
    let shown = 0, buffers = 0, loud = 0;
    sdl.onPresent = () => { if (++shown >= FRAMES) throw new Error('__frames_done'); };
    sdl.onAudio = (buf, frames, s) => {
      buffers++;
      for (let i = 0; i < frames * s.outChannels; i++) if (M.mod.dv.getInt16(buf + 2 * i, true) !== 0) { loud++; break; }
    };
    M.spBudget = 200000;
    M.sp_ = () => { M.spBudget = 200000; };
    try { program.run(['scummvm', '-psky', 'sky']); } catch (e) { if (!/__frames_done/.test(e.message)) report.error = e.message.split('\n')[0]; }
    let h = 0x811c9dc5;
    const n = sdl.width * sdl.height * 2;
    for (let i = 0; i < n; i++) h = Math.imul(h ^ M.u8[sdl.pixels + i], 16777619) >>> 0;
    const colours = new Set();
    for (let i = 0; i < n; i += 2) colours.add(M.u8[sdl.pixels + i] | (M.u8[sdl.pixels + i + 1] << 8));
    Object.assign(report, { shown, width: sdl.width, height: sdl.height, depth: sdl.depth, buffers, loud, hash: h.toString(16), colours: colours.size });
  }
  process.stdout.write(JSON.stringify(report) + '\n', () => process.exit(0));
  await new Promise(() => {});
}

// ---- the gate.
let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `\n       ${detail}` : ''}`);
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
const listed = [...['base', 'common', 'gui', 'sound', 'backends', 'sky'].flatMap((m) => objsOf(`${m}/module.mk`)), 'backends/sdl/sdl-common', 'backends/sdl/sdl'].map((o) => `${o}.cpp`);
const target = JSON.parse(readFileSync(join(ROOT, 'targets/scummvm.json'), 'utf8'));
check(JSON.stringify(target.units.list) === JSON.stringify(listed), `targets/scummvm.json lists the ${listed.length} units the module lists name`);

const data = process.env.PRISM_SCUMMVM_DATA;
const runs = data && existsSync(join(data, 'sky.dsk')) ? [child(data, 'run'), child(data, 'run')] : [child()];
const b = runs[0];
check(!b.error || b.shown, `the whole program builds: ${b.functions} functions`, b.error ?? '');
check(b.failures?.length === 0 && b.unresolved?.length === 0 && b.missingHeaders?.length === 0,
  'every function emitted, no name unresolved, no header missing', [...(b.failures ?? []), ...(b.unresolved ?? []), ...(b.missingHeaders ?? [])].slice(0, 6).join(' | '));
if (runs.length === 2) {
  check(b.shown === FRAMES && b.width === 640 && b.height === 400 && b.depth === 16 && b.colours > 100,
    `${b.shown} frames on a ${b.width}x${b.height} ${b.depth}-bit display, ${b.colours} colours in the last`, b.error ?? '');
  check(b.loud > 100, `music: ${b.loud} of ${b.buffers} audio buffers are not silence`);
  check(runs[1].hash === b.hash, `reproducible: a second run ends on the same picture (${b.hash})`, `second run: ${runs[1].hash}`);
  check(b.hash === PICTURE, `the picture recorded for this run (PRISM against itself, not a reference): ${PICTURE}`, `got ${b.hash}`);
  const withheld = child('', 'run');
  check((withheld.shown ?? 0) === 0, 'control: with the game\'s files withheld, no frame is presented', withheld.error ?? '');
} else {
  console.log('     (no PRISM_SCUMMVM_DATA: the game is not run)');
}
console.log(failed ? `gate-scummvm: ${failed} FAILED` : `gate-scummvm: ScummVM 0.6.1 builds whole${runs.length === 2 ? ' and runs Beneath a Steel Sky' : ''}`);
process.exit(failed ? 1 : 0);
