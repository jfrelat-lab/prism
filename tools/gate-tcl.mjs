// gate-tcl.mjs — Tcl 8.4.20, built by PRISM, runs a script as the same Tcl built by gcc runs it.
//
// Tux Racer's courses are Tcl scripts, so the game links the real Tcl library: 75 C files, 137,000
// lines, K&R throughout, on a wide slice of POSIX. Building it found two defects in PRISM's C compiler
// that no game had -- a K&R parameter of array type was not decayed (150 functions), and a function
// declared in several units took the type of whichever declared it last, incomplete struct and all --
// and some thirty libc names. This gate holds the result: tclsh itself (unix/tclAppInit.c and
// Tcl_Main, as `make tclsh` builds it) runs tools/tcl/workout.tcl on both sides, with Tcl's own
// library/ scripts, and every line it prints must be the same.
//
// The reference is built once in the oracle container by Tcl's own configure and make (cached in the
// scratch directory). Controls: a libc function the script's output depends on, made wrong.
//
//   node tools/gate-tcl.mjs
import { readFileSync, readdirSync, statSync, mkdirSync, cpSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';
import { up, sh, SCRATCH } from './oracle.mjs';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TCL = join(ROOT, 'corpus', 'tcl8.4.20');
if (!existsSync(join(TCL, 'generic', 'tcl.h'))) skip('corpus/tcl8.4.20', "run targets/tuxracer.json's fetch");
const script = readFileSync(join(ROOT, 'tools', 'tcl', 'workout.tcl'), 'latin1');

// --- gcc: Tcl's own build, once
up();
const work = join(SCRATCH, 'tcl-ref');
if (!existsSync(join(work, 'tcl8.4.20', 'unix', 'tclsh'))) {
  mkdirSync(work, { recursive: true });
  cpSync(TCL, join(work, 'tcl8.4.20'), { recursive: true });
  const b = sh('cd /work/tcl-ref/tcl8.4.20/unix && ./configure --disable-shared --disable-threads --disable-load >/tmp/tcl-configure.log 2>&1 && make tclsh >/tmp/tcl-make.log 2>&1', { timeout: 1200000 });
  if (b.code !== 0) { console.log(` BAD  the reference Tcl did not build:\n${b.stdout}${b.stderr}`); process.exit(1); }
}
copyFileSync(join(ROOT, 'tools', 'tcl', 'workout.tcl'), join(work, 'workout.tcl'));
const g = sh('cd /work/tcl-ref && TCL_LIBRARY=/work/tcl-ref/tcl8.4.20/library ./tcl8.4.20/unix/tclsh workout.tcl; echo "(exit $?)"');
const want = g.stdout;

// --- PRISM: the same tclsh, from the same sources
const tux = JSON.parse(readFileSync(join(ROOT, 'targets', 'tuxracer.json'), 'utf8'));
const units = tux.units.list.filter((u) => u.startsWith('tcl8.4.20/')).map((u) => u.slice('tcl8.4.20/'.length));
const files = { 'workout.tcl': new TextEncoder().encode(script) };
(function walk(d, pre) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`); else files[pre + f] = new Uint8Array(readFileSync(p));
  }
})(join(TCL, 'library'), 'usr/lib/tcl8.4/');
function prism(mutate = null) {
  const target = { name: 'tclsh', dir: 'corpus/tcl8.4.20', units: { list: [...units, 'unix/tclAppInit.c'] }, include: ['generic', 'unix'],
    defines: tux.defines, env: ['stdio', 'tz', 'environ'], compile: { memory: 64, collect: false } };
  const { program } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files } } });
  if (mutate) {
    const before = { ...program.M.rt };
    mutate(program.M);
    for (const [name] of program.mod.funcs) {
      const base = name.slice(name.lastIndexOf('$') + 1);
      if (program.M.rt[base] !== before[base]) program.mod.bindFunc(name, program.M.rt[base]);
    }
  }
  const r = program.run(['tclsh', 'workout.tcl']);
  return `${r.stdout}(exit ${r.code})\n`;
}

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(58)} ${detail}`); };
let got;
try { got = prism(); } catch (e) { got = `PRISM: ${e.message.split('\n')[0]}`; }
const lines = want.split('\n'), mine = got.split('\n');
const same = lines.filter((l, i) => l === mine[i]).length;
report(got === want, 'tclsh runs the workout script as gcc\'s tclsh does', `${same} of ${lines.length} lines`);
if (got !== want) {
  let shown = 0;
  for (let i = 0; i < Math.max(lines.length, mine.length) && shown < 4; i++) {
    if (lines[i] !== mine[i]) { console.log(`       line ${i + 1}\n         prism: ${JSON.stringify(mine[i])}\n         gcc  : ${JSON.stringify(lines[i])}`); shown++; }
  }
}
const controls = [
  ['modf that keeps no fraction (expr round)', (M) => { const f = M.rt.modf; M.rt.modf = (x, ip) => { f(x, ip); return 0; }; }],
  ['strtod read as zero (every number in the script)', (M) => { M.rt.strtod = (p, end) => { if (end) M.mod.dv.setInt32(end, p + 1, true); return 0; }; }],
  ['hypot that adds', (M) => { M.rt.hypot = (x, y) => x + y; }],
];
for (const [name, mutate] of controls) {
  let out;
  try { out = prism(mutate); } catch (e) { out = `threw: ${e.message.split('\n')[0]}`; }
  const differ = out.split('\n').filter((l, i) => l !== lines[i]).length;
  report(out !== want, `control: ${name} is told apart`, out.startsWith('threw') ? out.slice(0, 60) : `${differ} line(s) differ`);
}
if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nTcl built by PRISM runs the script as Tcl built by gcc.');
