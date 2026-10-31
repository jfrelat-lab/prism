// gate-gl-select.mjs -- selection and feedback (GL 1.1 5.2, 5.3) answer what Mesa answers.
//
// tests/gl/select.c prints its hit records and feedback buffers; this compiles it against Mesa 22's
// llvmpipe in the oracle container (tools/oracle/glut-egl.c) and on PRISM, and compares the two
// line by line. Counts, names, tokens and the order of everything must be equal. A hit's depths are
// window z times 2^32 -- Mesa computes window z in floats, PRISM in doubles, and the two differ by a
// float's last bit, 256 at these depths; and a vertex clipped to the near plane is a hair below 0 in
// Mesa, which its i386 conversion wraps to 0xFFFFFFC0. So depths are compared as 32-bit words,
// circularly, within Z_TOL. Feedback values are printed to 4 decimals and compared within 1e-3.
//
// The comparison checks itself first: Mesa's output against copies of it with one name changed, one
// depth moved by 2^16, one feedback value moved by 0.01 and one line dropped must all fail.
//
//   node tools/gate-gl-select.mjs
import { mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { up, sh, SCRATCH, oracleGlut } from './oracle.mjs';
import { buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const Z_TOL = 4096, F_TOL = 1e-3;
let failed = 0;
const check = (ok, what, detail = '') => { if (!ok) failed++; console.log(`${ok ? ' ok ' : ' BAD'}  ${what}${detail && !ok ? `\n       ${detail}` : ''}`); };

/** The first line where `ours` is not `theirs`, or null. */
function differ(ours, theirs) {
  const a = ours.trimEnd().split('\n'), b = theirs.trimEnd().split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? '', y = b[i] ?? '';
    if (x === y) continue;
    const hx = /^ {2}hit names (\d+) z (\d+) (\d+) :(.*)$/.exec(x), hy = /^ {2}hit names (\d+) z (\d+) (\d+) :(.*)$/.exec(y);
    if (hx && hy) {
      const near = (p, q) => { const d = Math.abs(+p - +q); return Math.min(d, 2 ** 32 - d) <= Z_TOL; };
      if (hx[1] === hy[1] && hx[4] === hy[4] && near(hx[2], hy[2]) && near(hx[3], hy[3])) continue;
    } else if (/^ {2}-?\d/.test(x) && /^ {2}-?\d/.test(y)) {
      const vx = x.trim().split(/\s+/).map(Number), vy = y.trim().split(/\s+/).map(Number);
      if (vx.length === vy.length && vx.every((v, k) => Math.abs(v - vy[k]) <= F_TOL)) continue;
    }
    return { line: i + 1, ours: x, theirs: y };
  }
  return null;
}

// ---- the reference ----------------------------------------------------------------------------------
up();
const work = join(SCRATCH, 'gl-select');
mkdirSync(join(work, 'GL'), { recursive: true });
copyFileSync(join(ROOT, 'tests', 'gl', 'select.c'), join(work, 'select.c'));
oracleGlut(work);
const ref = sh('cd /work/gl-select && gcc -O0 -I. -o select select.c glut-egl.c glut-c-*.c -lGLU -lEGL -lOpenGL -lm && PRISM_GLUT_FRAMES=0 ./select');
if (ref.code !== 0) throw new Error(`reference: ${ref.stderr || ref.stdout}`);
const theirs = ref.stdout;

// ---- the comparison's own controls --------------------------------------------------------------------
const mutate = (re, fn) => { const lines = theirs.split('\n'), i = lines.findIndex((l) => re.test(l)); lines[i] = fn(lines[i]); return lines.join('\n'); };
const controls = [
  ['a name changed', mutate(/^ {2}hit names 2 /, (l) => l.replace(/ 3$/, ' 4'))],
  ['a depth moved by 2^16', mutate(/^ {2}hit names 1 /, (l) => l.replace(/z (\d+)/, (_, z) => `z ${+z + 65536}`))],
  ['a feedback value moved by 0.01', mutate(/^ {2}1793\.0000 /, (l) => l.replace(/^ {2}1793\.0000 (\d+\.\d+)/, (_, v) => `  1793.0000 ${(+v + 0.01).toFixed(4)}`))],
  ['a line dropped', theirs.split('\n').filter((l, i) => i !== 3).join('\n')],
];
for (const [what, text] of controls) check(text !== theirs && differ(text, theirs) !== null, `control: ${what} is caught`);

// ---- PRISM --------------------------------------------------------------------------------------------
const { program } = buildTarget({ name: 'gl-select', dir: 'tests/gl', units: { list: ['select.c'] }, compile: { memory: 16, collect: true }, env: ['stdio', 'gl', 'glu', 'glut'] },
  { root: ROOT, envExtra: { glut: { frames: [0], onFrame: () => {} } } });
const ours = program.run(['select']).stdout;
const d = differ(ours, theirs);
const records = (theirs.match(/^ {2}hit /gm) ?? []).length, buffers = (theirs.match(/^feedback /gm) ?? []).length;
check(!d, `PRISM prints what Mesa prints: ${records} hit records, ${buffers} feedback buffers, two overflows`,
  d && `line ${d.line}: PRISM "${d.ours}", Mesa "${d.theirs}"`);
console.log(failed ? `\n${failed} check(s) failed.` : '\nselection and feedback answer on PRISM what they answer on Mesa.');
process.exit(failed ? 1 : 0);
