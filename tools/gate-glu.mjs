// gate-glu.mjs — src/env/glu.js held to libGLU, function by function (P15.2).
//
//   gluUnProject: tests/glu/unproject.c, 40 pseudo-random model/projection pairs (an identity and a
//   singular one among them), each result printed with %a, built natively against the container's
//   libGLU (Mesa's GLU 9) and by PRISM: the same success flags, and the same values to 1e-12,
//   relative. Not to the bit: Debian i386's libGLU computes on the x87 (thousands of x87 instructions,
//   no SSE), whose 80-bit intermediates move the last bits -- glu.js's arithmetic, compiled for the
//   x87 from C, agrees with it to the bit on 2 cases of 40 and to ~1e-15 on the rest (measured).
//   CONTROL, red: the program also unprojects through the projection TRANSPOSED, and those results
//   lie outside the tolerance -- it sees a wrong matrix.
//
//   node tools/gate-glu.mjs
import { mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './oracle.mjs';
import { buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOL = 1e-12;
let failed = 0;
const check = (ok, what, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail && !ok ? `\n       ${detail}` : ''}`); };

/** A %a string's value: [-]0xH.HHHp[+-]D. */
const hexValue = (s) => {
  const m = /^(-?)0x([0-9a-f])(?:\.([0-9a-f]+))?p([-+]\d+)$/i.exec(s);
  if (!m) return NaN;
  const frac = m[3] ? parseInt(m[3], 16) / 16 ** m[3].length : 0;
  return (m[1] ? -1 : 1) * (parseInt(m[2], 16) + frac) * 2 ** +m[4];
};
const lines = (text, tag) => text.split('\n').filter((l) => l.startsWith(`${tag} `)).map((l) => {
  const [, n, ok, ...v] = l.split(' ');
  return { n: +n, ok: +ok, v: v.map(hexValue), text: l };
});
const close = (a, b) => a.every((x, k) => Math.abs(x - b[k]) <= TOL * Math.max(1, Math.abs(b[k])));

const work = join(ROOT, '.oracle', 'glu');
mkdirSync(work, { recursive: true });
copyFileSync(join(ROOT, 'tests/glu/unproject.c'), join(work, 'unproject.c'));
const ref = sh('cd /work/glu && gcc -O0 -o unproject unproject.c -lGLU -lm && ./unproject');
if (ref.code !== 0) throw new Error(`reference build: ${ref.stderr || ref.stdout}`);

const target = { name: 'glu-unproject', dir: 'tests/glu', units: { list: ['unproject.c'] }, compile: { memory: 16, collect: true }, env: ['stdio', 'gl', 'glu'] };
const { program } = buildTarget(target, { root: ROOT });
const mine = program.run(['unproject']).stdout;

const theirs = lines(ref.stdout, 'glu'), ours = lines(mine, 'glu');
const bad = theirs.find((t, i) => !ours[i] || ours[i].ok !== t.ok || (t.ok && !close(ours[i].v, t.v)));
check(theirs.length === 40 && ours.length === 40 && !bad, `gluUnProject: all ${ours.length} results are libGLU's, the same success and the same values to ${TOL} relative`,
  bad ? `case ${bad.n}: PRISM "${ours[theirs.indexOf(bad)]?.text}", libGLU "${bad.text}"` : `${ours.length} results, libGLU ${theirs.length}`);
const exact = theirs.filter((t, i) => ours[i] && ours[i].text === t.text).length;
console.log(`     (${exact} of ${theirs.length} to the bit)`);

const wrong = lines(ref.stdout, 'wrong');
// (Not the identity, case 0: it is its own transpose.)
const apart = theirs.filter((t, i) => t.n !== 0 && t.ok && wrong[i]?.ok && !close(wrong[i].v, t.v)).length;
const both = theirs.filter((t, i) => t.n !== 0 && t.ok && wrong[i]?.ok).length;
check(both > 20 && apart === both, `control: the projection transposed lies outside the tolerance on ${apart} of ${both} results`);

console.log(failed ? `gate-glu: ${failed} FAILED` : `gate-glu: gluUnProject answers what libGLU answers, to ${TOL}`);
process.exit(failed ? 1 : 0);
