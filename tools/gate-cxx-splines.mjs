// gate-cxx-splines.mjs — Enemy Territory's C++ splines library computes on PRISM what it computes under g++.
//
// The library (corpus/Enemy-Territory-master/src/splines, unmodified) is the first real C++ PRISM
// compiles: classes with every special member, operator overloading, conversion functions, virtual
// functions, a class template. Running the game proves it links and starts; it does not prove an
// operator picks the right overload or a temporary dies when it should, and ET's own data never
// reaches the camera code at all. So the library's string and maths files are built with one driver
// (tools/cxx/splines-driver.cpp) twice -- g++ -std=gnu++98 in the oracle, and src/cxx -- and their
// output compared byte for byte.
//
// Controls: a defect a C++ front end could have, put into the generated C's behaviour by replacing a
// function the driver's own output depends on, must change the output.
//
//   node tools/gate-cxx-splines.mjs
import { readFileSync, mkdirSync, cpSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';
import { up, sh, SCRATCH } from './oracle.mjs';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SPLINES = join(ROOT, 'corpus', 'Enemy-Territory-master', 'src', 'splines');
const LIB = ['util_str.cpp', 'math_vector.cpp', 'math_matrix.cpp', 'math_quaternion.cpp', 'math_angles.cpp'];
if (!existsSync(join(SPLINES, 'util_str.cpp'))) skip('corpus/Enemy-Territory-master', "run targets/et.json's fetch");
const driver = readFileSync(join(ROOT, 'tools', 'cxx', 'splines-driver.cpp'), 'latin1');

// --- g++
up();
const work = join(SCRATCH, 'cxx-splines');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
cpSync(SPLINES, join(work, 'splines'), { recursive: true });
copyFileSync(join(ROOT, 'tools', 'cxx', 'splines-driver.cpp'), join(work, 'splines', 'prism-driver.cpp'));
const g = sh(`cd /work/cxx-splines/splines && g++ -std=gnu++98 -w -o /tmp/splines-driver prism-driver.cpp ${LIB.join(' ')} -lm && /tmp/splines-driver`);
if (g.code !== 0) { console.log(` BAD  the reference did not build or run:\n${g.stdout}${g.stderr}`); process.exit(1); }
const want = g.stdout;

// --- PRISM
function prism(mutate = null) {
  const target = { name: 'splines-driver', dir: 'corpus/Enemy-Territory-master/src/splines', units: { list: LIB },
    inline: { 'prism-driver.cpp': driver }, env: ['stdio'], compile: { memory: 16, collect: false } };
  const { program } = buildTarget(target, { root: ROOT });
  if (mutate) mutate(program);
  const r = program.run(['splines-driver']);
  return r.stdout;
}

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${detail}`); };
let got;
try { got = prism(); } catch (e) { got = `PRISM: ${e.message.split('\n')[0]}`; }
const lines = want.split('\n').filter(Boolean), mine = got.split('\n').filter(Boolean);
const same = lines.filter((l, i) => l === mine[i]).length;
report(got === want, 'strings, vectors, matrices, quaternions and lists as under g++', `${same} of ${lines.length} lines`);
if (got !== want) {
  for (let i = 0; i < Math.max(lines.length, mine.length); i++) {
    if (lines[i] !== mine[i]) { console.log(`       line ${i + 1}\n         prism: ${JSON.stringify(mine[i])}\n         g++  : ${JSON.stringify(lines[i])}`); break; }
  }
}

// Controls: each replaces one lowered C++ function with a plausible mistake.
const rebind = (program, match, wrap) => {
  let n = 0;
  for (const [name, f] of program.mod.funcs) if (match.test(name) && f.fn) { program.mod.bindFunc(name, wrap(f.fn)); n++; }
  if (!n) throw new Error(`control: nothing matches ${match}`);
};
const controls = [
  // `c = a + ", " + b` reaches idStr::operator=(const idStr&); a plain struct copy there would not
  // be this function at all. (Not "a destructor run twice": idStr's nulls its pointer, so that is harmless.)
  ['operator=(const idStr&) that does nothing', (p) => rebind(p, /(^|\$)_ZN5idStraSERK5idStr$/, () => () => 0)],
  // The copy constructor shares the buffer and counts the reference; a bitwise copy does not count.
  ['a copy constructor that does nothing', (p) => rebind(p, /(^|\$)_ZN5idStrC1ERK5idStr$/, () => () => 0)],
  // operator+(const idStr&, const int) appends a number; picking the char overload appends a byte.
  ['operator+ (idStr, int) taken for (idStr, char)', (p) => { const c = [...p.mod.funcs].find(([n]) => /(^|\$)_ZplRK5idStrc$/.test(n)); if (!c) throw new Error('control: no operator+(idStr, char)'); rebind(p, /(^|\$)_ZplRK5idStri$/, () => c[1].fn); }],
  // a.Cross(b) is not b.Cross(a): the object and the argument swapped.
  ['idVec3::Cross with its object and argument swapped', (p) => rebind(p, /(^|\$)_ZNK6idVec35CrossERK6idVec3$/, (f) => (r, a, b) => f(r, b, a))],
];
for (const [name, mutate] of controls) {
  let out;
  // A control that could not be set up proves nothing: that is a failure, not a detection.
  let setup = null;
  try { out = prism(mutate); } catch (e) { if (/^control:/.test(e.message)) setup = e.message; out = `threw: ${e.message.split('\n')[0]}`; }
  if (setup) { report(false, `control: ${name}`, setup); continue; }
  const differ = out.split('\n').filter((l, i) => l !== want.split('\n')[i]).length;
  report(out !== want, `control: ${name} is told apart`, out.startsWith('threw') ? out.slice(0, 70) : `${differ} line(s) differ`);
}

if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nthe splines library computes on PRISM what it computes under g++.');
