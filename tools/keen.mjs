// keen.mjs — run Keen Dreams (targets/keendreams.json) headless and look at it.
//
// The game's data is NOT in this repository: pass the directory holding KDREAMS.EGA, .MAP, .AUD and
// .CMP (the shareware 1.13 files match the 1.93 source's static headers). Nothing is fetched here.
//
//   node tools/keen.mjs --data=~/Projects/keendreams-data [--keys=2000:57,2100:185]
//        [--seconds=10] [--frame=keen.png] [--every=3000 --dir=frames/]
//
//   --keys     scancodes at virtual milliseconds (57 = space down, 185 = space up); the startup
//              text screen waits for a key from about 0.6 s on
//   --seconds  real-time leash: the run is stopped there, wherever the game is
//   --frame    the EGA picture at the end; --every/--dir one picture every so many virtual ms
//   --stack    print where a run that threw was
//   --static   a directory of static resources matching the data (tools/keen-static.mjs)
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { writeRgbPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (k, d = null) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const home = (p) => p.replace(/^~/, process.env.HOME ?? '');
const dataDir = arg('data') && home(arg('data'));
if (!dataDir) { console.error('--data=<directory with KDREAMS.EGA, .MAP, .AUD, .CMP> is required'); process.exit(2); }

const files = Object.fromEntries(readdirSync(dataDir).filter((f) => /^KDREAMS\./i.test(f))
  .map((f) => [f.toUpperCase(), new Uint8Array(readFileSync(join(dataDir, f)))]));
const keys = (arg('keys', '') ?? '').split(',').filter(Boolean).map((k) => { const [ms, scan] = k.split(':').map(Number); return { ms, scan }; });
const t0 = performance.now();
const target = loadTarget(join(ROOT, 'targets', 'keendreams.json'));
// Resources linked from the data set's own build where it has them (tools/keen-static.mjs): the
// source's static/ is 1.93's, and the shareware 1.13 maps need 1.13's MAPHEAD and MAPDICT.
const staticDir = arg('static') && home(arg('static'));
if (staticDir) {
  const have = new Set(readdirSync(staticDir).map((f) => f.toUpperCase()));
  target.dataObjects = target.dataObjects.map((o) => {
    const base = o.file.split('/').pop().toUpperCase();
    return have.has(base) ? { ...o, file: join(staticDir, base) } : o;
  });
  console.log(`static from ${staticDir}: ${[...have].join(' ')}`);
}
const { program: p, tasmBound } = buildTarget(target,
  { root: ROOT, envExtra: { stdio: { files }, pcirq: { keys } } });
console.log(`built in ${(performance.now() - t0).toFixed(0)} ms; ${p.failures.length} refused; ${tasmBound.length} TASM routines bound`);

const every = Number(arg('every', 0)) * 1000, shotDir = arg('dir') && home(arg('dir'));
if (every && shotDir) {
  mkdirSync(shotDir, { recursive: true });
  let next = every, n = 0;
  const sp = p.M.sp_;
  p.M.sp_ = (...a) => {
    if (p.M.vclock.us >= next) {
      const f = p.M.ega.frame();
      if (f) writeRgbPng(join(shotDir, `frame${String(n++).padStart(3, '0')}.png`), { bytes: f.rgba, width: f.width, height: f.height });
      next += every;
    }
    return sp(...a);
  };
}
p.M.leashDeadline = performance.now() + Number(arg('seconds', 10)) * 1000;
let ended;
try { ended = `exited ${p.run(['C:\\KDREAMS.EXE']).code}`; } catch (e) {
  ended = e.message === '__leash' ? 'stopped by the leash' : `threw: ${e.message}`;
  if (process.argv.includes('--stack') && e.message !== '__leash') console.log(e.stack.split('\n').slice(1, 14).join('\n'));
}
console.log(`${ended} at ${(p.M.vclock.us / 1e6).toFixed(1)} s virtual, video mode ${p.M.ega.mode.toString(16)}h`);
const out = arg('frame');
if (out) {
  const f = p.M.ega.frame();
  if (f) { writeRgbPng(home(out), { bytes: f.rgba, width: f.width, height: f.height }); console.log(`frame -> ${out}`); }
  else console.log('no graphics frame (text mode)');
}
