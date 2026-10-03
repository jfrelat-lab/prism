// gate-cxx-camera.mjs — Enemy Territory's camera splines run on PRISM as they run under g++.
//
// splines.cpp is the part of ET's C++ that the game's own data never reaches: pak0 ships no camera
// file, so loadCamera always answers "no such file" and idCameraDef, its three position classes and
// their virtual functions never execute in the game. tools/cxx/camera-driver.cpp reaches them through
// the functions the engine calls -- loadCamera, startCamera, getCameraInfo -- on three camera files
// served from memory (a spline, an interpolated move, a fixed shot), then saves one back. All seven
// of the library's unmodified .cpp files are built with it twice: by g++ in the oracle, and by
// src/cxx. Every printed line must be the same: the camera's origin, angles and field of view at
// each sampled time, what a missing file and an out-of-range index answer, and the re-written file.
//
// The reference uses SSE arithmetic (-msse2 -mfpmath=sse): PRISM computes float and double as IEEE
// says, and the x87's extended intermediates are not what is under test.
//
//   node tools/gate-cxx-camera.mjs
import { readFileSync, mkdirSync, cpSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';
import { up, sh, SCRATCH } from './oracle.mjs';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus', 'Enemy-Territory-master', 'src');
const LIB = ['splines.cpp', 'q_parse.cpp', 'util_str.cpp', 'math_vector.cpp', 'math_matrix.cpp', 'math_quaternion.cpp', 'math_angles.cpp'];
if (!existsSync(join(SRC, 'splines', 'splines.cpp'))) skip('corpus/Enemy-Territory-master', "run targets/et.json's fetch");
const driver = readFileSync(join(ROOT, 'tools', 'cxx', 'camera-driver.cpp'), 'latin1');

// --- g++ (splines.h includes ../renderer/qgl.h, which includes ../game and ../qcommon headers)
up();
const work = join(SCRATCH, 'cxx-camera');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
for (const d of ['splines', 'renderer', 'game', 'qcommon', 'cgame']) cpSync(join(SRC, d), join(work, d), { recursive: true });
copyFileSync(join(ROOT, 'tools', 'cxx', 'camera-driver.cpp'), join(work, 'splines', 'prism-camera.cpp'));
const g = sh(`cd /work/cxx-camera/splines && g++ -std=gnu++98 -msse2 -mfpmath=sse -w -o /tmp/camera-driver prism-camera.cpp ${LIB.join(' ')} -lm && /tmp/camera-driver`);
if (g.code !== 0) { console.log(` BAD  the reference did not build or run:\n${g.stdout}${g.stderr}`); process.exit(1); }
const want = g.stdout;

// --- PRISM
function prism(mutate = null) {
  const target = { name: 'camera-driver', dir: 'corpus/Enemy-Territory-master/src/splines', units: { list: LIB },
    inline: { 'prism-camera.cpp': driver }, env: ['stdio', 'x11', 'gl', 'glx'], defines: { __linux__: '1' },
    compile: { memory: 32, collect: false } };
  const { program } = buildTarget(target, { root: ROOT });
  if (mutate) mutate(program);
  return program.run(['camera-driver']).stdout;
}

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${detail}`); };
let got;
try { got = prism(); } catch (e) { got = `PRISM: ${e.message.split('\n')[0]}`; }
const lines = want.split('\n'), mine = got.split('\n');
const same = lines.filter((l, i) => l === mine[i]).length;
report(got === want, 'three cameras sampled, and one saved, as under g++', `${same} of ${lines.length} lines`);
if (got !== want) {
  let shown = 0;
  for (let i = 0; i < Math.max(lines.length, mine.length) && shown < 3; i++) {
    if (lines[i] !== mine[i]) { console.log(`       line ${i + 1}\n         prism: ${JSON.stringify(mine[i])}\n         g++  : ${JSON.stringify(lines[i])}`); shown++; }
  }
}

// Controls: one lowered C++ function replaced by a plausible mistake; the output must change.
const rebind = (program, match, wrap) => {
  let n = 0;
  for (const [name, f] of program.mod.funcs) if (match.test(name) && f.fn) { program.mod.bindFunc(name, wrap(f.fn)); n++; }
  if (!n) throw new Error(`control: nothing matches ${match}`);
};
const controls = [
  // The camera's position is an idCameraPosition *: getPosition must reach the spline's override.
  ['a virtual call that reaches the base class', (p) => {
    const base = [...p.mod.funcs].find(([n]) => /(^|\$)_ZN16idCameraPosition11getPositionEl$/.test(n));
    if (!base) throw new Error('control: no idCameraPosition::getPosition');
    rebind(p, /(^|\$)_ZN16idSplinePosition11getPositionEl$/, () => base[1].fn);
  }],
  // The global camera[64] is constructed before main; without it every camera starts as garbage zeroes.
  // (The runner calls these through program.F, so that is where the mutation goes.)
  ['splines.cpp\'s file-scope objects never constructed', (p) => {
    const names = Object.keys(p.F).filter((n) => /__prism_cxx_init_.*splines_cpp$/.test(n));
    if (!names.length) throw new Error('control: no static initialiser for splines.cpp');
    for (const n of names) p.F[n] = () => 0;
  }],
  // idList<idVec3 *>::Append grows its array with new[]; dropping the element loses a control point.
  ['idList::Append that forgets every other element', (p) => rebind(p, /(^|\$)_ZN\d+idListIP6idVec3E6AppendERKP6idVec3$/, (f) => { let k = 0; return (...a) => (k++ % 2 ? 0 : f(...a)); })],
];
for (const [name, mutate] of controls) {
  let out, setup = null;
  try { out = prism(mutate); } catch (e) { if (/^control:/.test(e.message)) setup = e.message; out = `threw: ${e.message.split('\n')[0]}`; }
  if (setup) { report(false, `control: ${name}`, setup); continue; }
  const differ = out.split('\n').filter((l, i) => l !== lines[i]).length;
  report(out !== want, `control: ${name} is told apart`, out.startsWith('threw') ? out.slice(0, 70) : `${differ} line(s) differ`);
}

if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nthe camera splines run on PRISM as they run under g++.');
