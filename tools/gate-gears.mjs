// gate-gears.mjs — gears on PRISM's OpenGL (src/env/gl.js, glut.js), held to MESA drawing the same frames.
//
// THE REFERENCE is the same gears.c compiled by gcc against Mesa 22 (llvmpipe) in the oracle
// container, its GLUT answered by tools/oracle/glut-egl.c: a surfaceless EGL context and a
// framebuffer object, so no display is needed, and the SAME schedule PRISM's glut.js keeps --
// GLUT_ELAPSED_TIME advances 40 ms per swap -- so frame N is the same scene on both sides.
//
// THE CLAIM is not pixel equality: two conforming GL implementations may differ in the last bit of
// an interpolated colour and in which of two triangles owns a pixel on the diagonal they share (GL
// 1.1 section 3.1 leaves exactly that invariance-free). It is that the PICTURES agree: per frame,
// at most MAX_OFF of the pixels differ by more than TOL in any channel, and the pixels that are
// drawn at all (not background) are the same set within MAX_EDGE. What a real defect does is far
// larger, and the gate carries four of them as controls that must be red: lighting ignored, the
// winding read backwards, flat shading ignored, and the depth test
// off. (Unnormalised normals is NOT one: gears' normals are unit length and its matrices rotate
// only, so GL_NORMALIZE changes 0.9% of its pixels -- a control has to be a defect this program shows.)
//
//   node tools/gate-gears.mjs [--png=<file>]      # frames 0, 25 and 50: PRISM | Mesa | differences
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { up, sh, SCRATCH, oracleGlut } from './oracle.mjs';
import { writeRgbPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FRAMES = [0, 25, 50];
const TOL = 8, MAX_OFF = 0.001, MAX_EDGE = 0.001;
const pngOut = process.argv.find((a) => a.startsWith('--png='))?.slice(6);

// --- Mesa
up();
const work = join(SCRATCH, 'gears');
mkdirSync(join(work, 'GL'), { recursive: true });
for (const f of ['gears.c', 'glut_wrap.h']) copyFileSync(join(ROOT, 'corpus', 'gears', f), join(work, f));
oracleGlut(work);
const r = sh(`cd /work/gears && rm -f frame-*.ppm gears && gcc -O0 -I. -o gears gears.c glut-egl.c glut-c.c -lGLU -lEGL -lOpenGL -lm && PRISM_GLUT_FRAMES=${FRAMES.join(',')} ./gears -info`);
if (r.code !== 0) throw new Error(`reference build: ${r.stderr || r.stdout}`);
console.log(`Mesa: ${(r.stdout.match(/GL_RENDERER\s*=\s*(.*)/) ?? [])[1] ?? '?'}`);
const readPpm = (p) => {
  const b = readFileSync(p), m = b.toString('latin1', 0, 32).match(/^P6\n(\d+) (\d+)\n255\n/);
  return { w: +m[1], h: +m[2], rgb: b.subarray(m[0].length) };
};
const mesa = Object.fromEntries(FRAMES.map((n) => [n, readPpm(join(work, `frame-${n}.ppm`))]));

// --- PRISM
function prism(mutate = null) {
  const out = {};
  const { program } = buildTarget(loadTarget(join(ROOT, 'targets', 'gears.json')), { root: ROOT,
    envExtra: { glut: { frames: FRAMES, onFrame: (n, rgba, w, h) => { out[n] = { w, h, rgba }; } } } });
  if (mutate) mutate(program.M);
  program.run(['gears']);
  return out;
}
function compare(p, m) {
  let off = 0, edge = 0, drawn = 0, any = 0, max = 0;
  const n = m.w * m.h;
  for (let i = 0; i < n; i++) {
    const a = [p.rgba[4 * i], p.rgba[4 * i + 1], p.rgba[4 * i + 2]], b = [m.rgb[3 * i], m.rgb[3 * i + 1], m.rgb[3 * i + 2]];
    const d = Math.max(...a.map((v, k) => Math.abs(v - b[k])));
    if (d > TOL) off++;
    if (d) any++;
    if (d > max) max = d;
    const da = a.some((v) => v), db = b.some((v) => v);
    if (da || db) drawn++;
    if (da !== db) edge++;
  }
  return { off: off / n, edge: edge / n, drawn: drawn / n, any: any / n, max };
}

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(58)} ${detail}`); };
const pct = (x) => `${(100 * x).toFixed(2)}%`;
const mine = prism();
const N = mesa[FRAMES[0]].w * mesa[FRAMES[0]].h;
for (const n of FRAMES) {
  const c = compare(mine[n], mesa[n]);
  report(c.drawn > 0.2, `frame ${n}: the gears cover the window`, pct(c.drawn));
  report(c.off <= MAX_OFF && c.edge <= MAX_EDGE, `frame ${n}: PRISM's picture is Mesa's`, `${Math.round(c.off * N)} of ${N} pixels off by more than ${TOL} (${Math.round(c.any * N)} differ at all, by at most ${c.max}); coverage differs on ${Math.round(c.edge * N)}`);
}
// The controls: each is a real defect of a GL implementation, and each must fail the claim.
const CONTROLS = [
  ['lighting ignored', (M) => { const en = M.rt.glEnable; M.rt.glEnable = (c) => (c === 0x0b50 ? undefined : en(c)); }],
  ['the winding read backwards (front faces culled)', (M) => { const en = M.rt.glEnable; M.rt.glEnable = (c) => { en(c); if (c === 0x0b44) M.rt.glCullFace(0x0404); }; }],
  ['flat shading ignored', (M) => { const sm = M.rt.glShadeModel; M.rt.glShadeModel = () => sm(0x1d01); }],
  ['depth test off', (M) => { const en = M.rt.glEnable; M.rt.glEnable = (c) => (c === 0x0b71 ? undefined : en(c)); }],
];
for (const [name, mutate] of CONTROLS) {
  const got = prism(mutate)[FRAMES[1]], c = compare(got, mesa[FRAMES[1]]);
  report(c.off > MAX_OFF || c.edge > MAX_EDGE, `control: ${name} is told apart`, `${pct(c.off)} off`);
}

if (pngOut) {
  const W = mesa[0].w, H = mesa[0].h, out = new Uint8Array(W * 3 * H * FRAMES.length * 4);
  FRAMES.forEach((n, row) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, p = mine[n].rgba, m = mesa[n].rgb;
      const a = [p[4 * i], p[4 * i + 1], p[4 * i + 2]], b = [m[3 * i], m[3 * i + 1], m[3 * i + 2]];
      const d = a.some((v, k) => Math.abs(v - b[k]) > TOL) ? [255, 0, 255] : a.map((v) => v >> 2);
      [a, b, d].forEach((c, col) => { const o = (((row * H + y) * W * 3) + col * W + x) * 4; out[o] = c[2]; out[o + 1] = c[1]; out[o + 2] = c[0]; out[o + 3] = 255; });
    }
  });
  writeRgbPng(pngOut, { bytes: out, width: W * 3, height: H * FRAMES.length });
  console.log(`wrote ${pngOut}`);
}
console.log(bad ? `\n${bad} WRONG` : '\ngears draws on PRISM what it draws on Mesa.');
process.exit(bad ? 1 : 0);
