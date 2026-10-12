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
//   gluBuild2DMipmaps and gluScaleImage: tests/glu/mipmap.c, nine GL_UNSIGNED_BYTE images (powers of
//   two and not, 1x1, 1, 3 and 4 components) built into mipmaps and scaled to four sizes each. Every
//   level GLU hands glTexImage2D is hashed where it lands (tests/glu/native-gl.c natively, a hook on
//   M.rt here), as GL_UNPACK_ALIGNMENT lays its rows out; every scaled image is hashed by the program.
//   Held to the bit: these are integer results, and glu.js reproduces where libGLU's x87 code keeps
//   its `float`s unrounded. CONTROL, red: the same run with the first byte of each source image flipped
//   by 128 -- the hashes must see it, levels and scaled images alike.
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

// gluBuild2DMipmaps and gluScaleImage.
for (const f of ['mipmap.c', 'native-gl.c']) copyFileSync(join(ROOT, 'tests/glu', f), join(work, f));
const mipRef = sh('cd /work/glu && gcc -O0 -rdynamic -o mipmap mipmap.c native-gl.c -lGLU -lOpenGL -lEGL -ldl -lm && ./mipmap');
if (mipRef.code !== 0) throw new Error(`reference build: ${mipRef.stderr || mipRef.stdout}`);
const mipTarget = { name: 'glu-mipmap', dir: 'tests/glu', units: { list: ['mipmap.c'] }, inline: { 'context.c': 'void make_context(void) {}\n' },
  compile: { memory: 32, collect: true }, env: ['stdio', 'gl', 'glu'] };
/** mipmap.c's output on PRISM, every level hashed as native-gl.c hashes it; `nudge` flips the first byte of each source image by 128. */
const mipRun = (nudge) => {
  const { program: p } = buildTarget(mipTarget, { root: ROOT });
  const M = p.M, rt = M.rt, tex = rt.glTexImage2D;
  const comps = (f) => (f === 0x1908 ? 4 : f === 0x1907 ? 3 : f === 0x190a ? 2 : 1);
  rt.glTexImage2D = (tg, level, internal, w, h, border, format, type, px) => {
    if (tg === 0x0de1) {
      const align = M.gl.state.unpackAlign, rb = Math.ceil(w * comps(format) / align) * align;
      let hh = 0x811c9dc5;
      for (let y = 0; px && y < h; y++) {
        let r = 0x811c9dc5;
        for (let x = 0; x < w * comps(format); x++) r = Math.imul(r ^ M.u8[px + y * rb + x], 16777619) >>> 0;
        hh = Math.imul(hh ^ r, 16777619) >>> 0;
      }
      M.write(`level ${level} ${w}x${h} int ${internal} fmt ${format.toString(16)} type ${type.toString(16)} ${hh.toString(16).padStart(8, '0')}\n`);
    }
    return tex(tg, level, internal, w, h, border, format, type, px);
  };
  if (nudge) {
    const nudged = new Set();
    const once = (ptr) => { if (!nudged.has(ptr)) { nudged.add(ptr); M.u8[ptr] ^= 0x80; } };
    for (const name of ['gluBuild2DMipmaps', 'gluScaleImage']) {
      const real = rt[name], at = name === 'gluBuild2DMipmaps' ? 6 : 4;
      rt[name] = (...a) => { once(a[at]); return real(...a); };
    }
  }
  return p.run(['mipmap']).stdout.trim().split('\n');
};
const mipTheirs = mipRef.stdout.trim().split('\n'), mipOurs = mipRun(false);
const firstDiff = mipTheirs.findIndex((l, i) => l !== mipOurs[i]);
const levels = mipTheirs.filter((l) => l.startsWith('level ')).length, scales = mipTheirs.filter((l) => l.startsWith('scale ')).length;
check(firstDiff < 0 && mipOurs.length === mipTheirs.length && levels > 50 && scales === 36,
  `gluBuild2DMipmaps/gluScaleImage: all ${levels} levels and ${scales} scaled images are libGLU's, to the bit`,
  firstDiff >= 0 ? `line ${firstDiff + 1}: PRISM "${mipOurs[firstDiff]}", libGLU "${mipTheirs[firstDiff]}"` : `${mipOurs.length} lines, libGLU ${mipTheirs.length}`);
const nudged = mipRun(true);
const seenL = mipTheirs.filter((l, i) => l.startsWith('level ') && nudged[i] !== l).length;
const seenS = mipTheirs.filter((l, i) => l.startsWith('scale ') && nudged[i] !== l).length;
check(seenL > levels / 2 && seenS > scales / 2, `control: one source byte flipped by 128 moves ${seenL} of ${levels} levels and ${seenS} of ${scales} scaled images`);

console.log(failed ? `gate-glu: ${failed} FAILED` : `gate-glu: gluUnProject answers what libGLU answers, to ${TOL}; mipmaps and scaling to the bit`);
process.exit(failed ? 1 : 0);
