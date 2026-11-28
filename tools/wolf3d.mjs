// wolf3d.mjs — run Wolfenstein 3D (targets/wolf3d.json) headless and look at it.
//
// The game's data is NOT in this repository: pass the directory holding the id/Activision 1.4
// six-episode *.WL6 files (the one data set WOLFSRC's GFXV_WL6.H numbers, P11.7). Nothing is fetched.
//
//   node tools/wolf3d.mjs --data=~/Projects/wolf3d-data/wl6 [--keys=2000:57,2100:185]
//        [--seconds=20] [--frame=wolf.png] [--every=1 --dir=frames/] [--args="..."] [--stack]
//
//   --keys     scancodes at virtual milliseconds (57 = space down, 185 = space up)
//   --seconds  real-time leash: the run is stopped there, wherever the game is
//   --frame    the VGA picture at the end; --every/--dir one picture every so many virtual seconds
//   --stack    print where a run that threw was
//   --mirage   a MIRAGE checkout to run the scalers on instead of the vendored core (or $PRISM_MIRAGE)
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { writeIndexedPng } from './png.mjs';
import { installTargetX86Node } from './mirage-x86.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (k, d = null) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const home = (p) => p.replace(/^~/, process.env.HOME ?? '');
const dataDir = arg('data') && home(arg('data'));
if (!dataDir) { console.error('--data=<directory with the *.WL6 files> is required'); process.exit(2); }

const files = Object.fromEntries(readdirSync(dataDir).filter((f) => /\.WL6$/i.test(f))
  .map((f) => [f.toUpperCase(), new Uint8Array(readFileSync(join(dataDir, f)))]));
const keys = (arg('keys', '') ?? '').split(',').filter(Boolean).map((k) => { const [ms, scan] = k.split(':').map(Number); return { ms, scan }; });
const t0 = performance.now();
const target = loadTarget(join(ROOT, 'targets', 'wolf3d.json'));
const { program: p, tasmBound } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files }, pcirq: { keys } } });
// The scalers WL_SCALE.C compiles at run time run on MIRAGE's CPU (tools/mirage-x86.mjs, P11.4).
const x86 = await installTargetX86Node(p, target.x86, arg('mirage') ? { mirage: home(arg('mirage')) } : {});
console.log(`built in ${(performance.now() - t0).toFixed(0)} ms; ${p.failures.length} refused; ${tasmBound.length} TASM routines bound`);

const every = Number(arg('every', 0)) * 1e6, shotDir = arg('dir') && home(arg('dir'));
if (every && shotDir) {
  mkdirSync(shotDir, { recursive: true });
  let next = every, n = 0;
  const sp = p.M.sp_;
  p.M.sp_ = (...a) => {
    if (p.M.vclock.us >= next) {
      const f = p.M.ega.indexed();
      if (f) writeIndexedPng(join(shotDir, `frame${String(n++).padStart(3, '0')}.png`), { pixels: f.pix, width: f.width, height: f.height, palette: f.palette.flat() });
      next += every;
    }
    return sp(...a);
  };
}

p.M.leashDeadline = performance.now() + Number(arg('seconds', 20)) * 1000;
let ended;
const argv = ['C:\\WOLF3D.EXE', ...(arg('args', '') ?? '').split(/\s+/).filter(Boolean)];
try { ended = `exited ${p.run(argv).code}`; } catch (e) {
  ended = e.message === '__leash' ? 'stopped by the leash' : `threw: ${e.message}`;
  if (process.argv.includes('--stack') && e.message !== '__leash') console.log(e.stack.split('\n').slice(1, 16).join('\n'));
}
console.log(`x86 run on MIRAGE: ${x86.calls} far calls, ${x86.blocks} blocks, ${x86.flushes} flushes`);
console.log(`${ended} at ${(p.M.vclock.us / 1e6).toFixed(2)} s virtual, video mode ${p.M.ega.mode.toString(16)}h`);
const out = arg('frame');
if (out) {
  const f = p.M.ega.indexed();
  if (f) { writeIndexedPng(home(out), { pixels: f.pix, width: f.width, height: f.height, palette: f.palette.flat() }); console.log(`frame -> ${out}`); }
}
