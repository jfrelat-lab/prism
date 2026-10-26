// gate-gl-scenes.mjs — the parts of the fixed-function pipeline GLQuake uses, one scene each, held to Mesa.
//
// tests/gl/scenes.c draws one scene per argument (textures and the mipmap filters, a Quake-style
// lightmap blend, the alpha test, blending, fog, near-plane clipping, depth range). Mesa 22
// (llvmpipe) draws it in the oracle container on tools/oracle/glut-egl.c; PRISM draws it through
// src/env/gl.js's software rasteriser. Two conforming implementations differ in the last bit of a
// filtered texel and in which triangle owns a shared edge, so the claim is per scene: at most
// MAX_OFF of the pixels differ by more than TOL in any channel.
//
//   node tools/gate-gl-scenes.mjs [scene ...] [--png=<dir>]   # dir: <scene>.png, PRISM | Mesa | diff
import { readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';
import { up, sh, SCRATCH } from './oracle.mjs';
import { writeRgbPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ALL = ['tex-nearest', 'tex-linear', 'mip-nn', 'mip-ln', 'mip-ll', 'lightmap', 'alpha', 'blend', 'fog', 'clip', 'depth',
  'texgen-object', 'texgen-sphere', 'arrays-normal', 'colour-material', 'matrix-rect',
  'vbo', 'points', 'point-sprite', 'array-types', 'copytex', 'far'];
const args = process.argv.slice(2);
const pngDir = args.find((a) => a.startsWith('--png='))?.slice(6);
const SCENES = args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : ALL;
const TOL = 8, MAX_OFF = 0.005;

up();
const work = join(SCRATCH, 'gl-scenes');
mkdirSync(join(work, 'GL'), { recursive: true });
copyFileSync(join(ROOT, 'tests', 'gl', 'scenes.c'), join(work, 'scenes.c'));
copyFileSync(join(ROOT, 'tools', 'oracle', 'glut-egl.c'), join(work, 'glut-egl.c'));
copyFileSync(join(ROOT, 'tools', 'oracle', 'GL', 'glut.h'), join(work, 'GL', 'glut.h'));
const build = sh('cd /work/gl-scenes && gcc -O0 -I. -o scenes scenes.c glut-egl.c -lEGL -lOpenGL -lm');
if (build.code !== 0) throw new Error(`reference build: ${build.stderr || build.stdout}`);
const readPpm = (p) => {
  const b = readFileSync(p), m = b.toString('latin1', 0, 32).match(/^P6\n(\d+) (\d+)\n255\n/);
  return { w: +m[1], h: +m[2], rgb: b.subarray(m[0].length) };
};
const target = { name: 'gl-scenes', dir: 'tests/gl', units: { list: ['scenes.c'] }, compile: { memory: 16, collect: true }, env: ['stdio', 'gl', 'glut'] };

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(34)} ${detail}`); };
if (pngDir) mkdirSync(pngDir, { recursive: true });
for (const scene of SCENES) {
  const r = sh(`cd /work/gl-scenes && rm -f frame-0.ppm && PRISM_GLUT_FRAMES=0 ./scenes ${scene} && mv frame-0.ppm ${scene}.ppm`);
  if (r.code !== 0) throw new Error(`reference ${scene}: ${r.stderr || r.stdout}`);
  const mesa = readPpm(join(work, `${scene}.ppm`));
  let mine = null;
  const { program } = buildTarget(target, { root: ROOT, envExtra: { glut: { frames: [0], onFrame: (_n, rgba, w, h) => { mine = { rgba, w, h }; } } } });
  program.run(['scenes', scene]);
  let off = 0, max = 0;
  const N = mesa.w * mesa.h, diff = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(mine.rgba[4 * i + k] - mesa.rgb[3 * i + k]));
    if (d > TOL) { off++; diff[i] = 1; }
    if (d > max) max = d;
  }
  report(off / N <= MAX_OFF, scene, `${off} of ${N} pixels off by more than ${TOL} (max ${max})`);
  if (pngDir) {
    const W = mesa.w, H = mesa.h, out = new Uint8Array(W * 3 * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, a = [mine.rgba[4 * i], mine.rgba[4 * i + 1], mine.rgba[4 * i + 2]], b = [mesa.rgb[3 * i], mesa.rgb[3 * i + 1], mesa.rgb[3 * i + 2]];
      const d = diff[i] ? [255, 0, 255] : a.map((v) => v >> 2);
      [a, b, d].forEach((c, col) => { const o = (y * W * 3 + col * W + x) * 4; out[o] = c[2]; out[o + 1] = c[1]; out[o + 2] = c[0]; out[o + 3] = 255; });
    }
    writeRgbPng(join(pngDir, `${scene}.png`), { bytes: out, width: W * 3, height: H });
  }
}
console.log(bad ? `\n${bad} WRONG` : "\nevery scene draws on PRISM what it draws on Mesa.");
process.exit(bad ? 1 : 0);
