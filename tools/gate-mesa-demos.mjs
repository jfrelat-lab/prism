// gate-mesa-demos.mjs — more whole GLUT programs on PRISM's OpenGL, each held to MESA drawing the same frames.
//
// The method is gate-gears.mjs's: the same source built by gcc against Mesa 22 (llvmpipe) in the
// oracle container, its GLUT answered by tools/oracle/glut-egl.c on the same 40 ms-per-swap clock, and
// per frame at most MAX_OFF of the pixels off by more than TOL, with the drawn set the same within
// MAX_EDGE. The programs are mesa-demos 8.0.1's (2010), the last release before its loaders:
//
//   morph3d   five morphing polyhedra: TWO-SIDED lighting with one material on both faces, two
//             directional lights, a scene ambient set by glLightModel, GL_NORMALIZE, GL_TRIANGLES.
//   texobj    two textured quads, each with its own 8x8 NEAREST texture in DECAL mode. It picks its
//             path by glGetString(GL_VERSION): "1.1" or "1.2" means texture OBJECTS, anything else
//             means each texture compiled into a DISPLAY LIST around glTexImage2D. Both paths are
//             run, the version set on each side (MESA_GL_VERSION_OVERRIDE, and gl.js's `version`).
//
// Each carries controls -- a defect of a GL implementation this program shows -- that must be red.
//
//   node tools/gate-mesa-demos.mjs [--png=<dir>]   # per case: PRISM | Mesa | differences
import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { up, sh, SCRATCH } from './oracle.mjs';
import { writeRgbPng } from './png.mjs';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOL = 8, MAX_OFF = 0.001, MAX_EDGE = 0.001;
const pngDir = process.argv.find((a) => a.startsWith('--png='))?.slice(6);

const recordingOff = (M, name) => {   // the call runs at once even while a list is being compiled
  const orig = M.rt[name];
  M.rt[name] = (...a) => { const st = M.gl.state, r = st.recording; st.recording = null; try { orig(...a); } finally { st.recording = r; } };
};
const CASES = [
  {
    // swap 0 is the clear main() shows before init; the polyhedron is small (Scale 0.3) and roams the window
    name: 'morph3d', target: 'morph3d', frames: [5, 60, 195], minDrawn: 0.002,
    controls: [
      ['two-sided lighting ignored', (M) => { const lm = M.rt.glLightModelfv; M.rt.glLightModelfv = (p, v) => (p === 0x0b52 ? undefined : lm(p, v)); }],
      ['the scene ambient ignored', (M) => { const lm = M.rt.glLightModelfv; M.rt.glLightModelfv = (p, v) => (p === 0x0b53 ? undefined : lm(p, v)); }],
      ['the second light ignored', (M) => { const en = M.rt.glEnable; M.rt.glEnable = (c) => (c === 0x4001 ? undefined : en(c)); }],
    ],
  },
  {
    name: 'texobj (texture objects)', target: 'texobj', frames: [0, 25, 50], version: '1.1',
    controls: [
      // init() binds each name once and asserts glIsTexture on it; the draw binds them in turn
      ['glBindTexture ignored once init() is done', (M) => { const b = M.rt.glBindTexture; let n = 0; M.rt.glBindTexture = (t, id) => (++n <= 2 ? b(t, id) : undefined); }],
      // (DECAL read as MODULATE is NOT one: the fragment colour is white and the textures RGB, so both give the texel.)
      ['NEAREST magnification read as LINEAR', (M) => { const p = M.rt.glTexParameteri; M.rt.glTexParameteri = (t, n, v) => p(t, n, n === 0x2800 && v === 0x2600 ? 0x2601 : v); }],
    ],
  },
  {
    name: 'texobj (display lists)', target: 'texobj', frames: [0, 25, 50], version: '2.1',
    controls: [
      ['glTexImage2D executed instead of compiled', (M) => recordingOff(M, 'glTexImage2D')],
    ],
  },
];

// --- Mesa
up();
const readPpm = (p) => {
  const b = readFileSync(p), m = b.toString('latin1', 0, 32).match(/^P6\n(\d+) (\d+)\n255\n/);
  return { w: +m[1], h: +m[2], rgb: b.subarray(m[0].length) };
};
function mesa(c) {
  const dir = c.target, work = join(SCRATCH, 'mesademos', dir);
  mkdirSync(join(work, 'GL'), { recursive: true });
  const src = join(ROOT, 'corpus', 'mesademos', `${c.target}.c`);
  if (!existsSync(src)) skip(`corpus/mesademos/${c.target}.c`, `run targets/${c.target}.json's fetch`);
  copyFileSync(src, join(work, `${c.target}.c`));
  copyFileSync(join(ROOT, 'tools', 'oracle', 'glut-egl.c'), join(work, 'glut-egl.c'));
  copyFileSync(join(ROOT, 'tools', 'oracle', 'GL', 'glut.h'), join(work, 'GL', 'glut.h'));
  const env = c.version ? `MESA_GL_VERSION_OVERRIDE=${c.version} ` : '';
  const r = sh(`cd /work/mesademos/${dir} && rm -f frame-*.ppm prog && gcc -O0 -I. -o prog ${c.target}.c glut-egl.c -lEGL -lOpenGL -lm && ${env}PRISM_GLUT_FRAMES=${c.frames.join(',')} ./prog`);
  if (r.code !== 0) throw new Error(`${c.name}: reference: ${r.stderr || r.stdout}`);
  return Object.fromEntries(c.frames.map((n) => [n, readPpm(join(work, `frame-${n}.ppm`))]));
}

// --- PRISM
function prism(c, mutate = null) {
  const out = {};
  const gl = c.version ? { version: `${c.version} PRISM` } : {};
  const { program } = buildTarget(loadTarget(join(ROOT, 'targets', `${c.target}.json`)), { root: ROOT,
    envExtra: { gl, glut: { frames: c.frames, onFrame: (n, rgba, w, h) => { out[n] = { w, h, rgba }; } } } });
  program.M.write = () => {};
  if (mutate) {
    const before = { ...program.M.rt };
    mutate(program.M);
    // A direct call was bound to its builtin at link time: point the slots of what changed at the mutation.
    for (const [name] of program.mod.funcs) {
      const base = name.slice(name.lastIndexOf('$') + 1);
      if (program.M.rt[base] !== before[base]) program.mod.bindFunc(name, program.M.rt[base]);
    }
  }
  program.run([c.target]);
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
  return { off: off / n, edge: edge / n, drawn: drawn / n, any: any / n, max, n };
}

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(64)} ${detail}`); };
const pct = (x) => `${(100 * x).toFixed(2)}%`;
for (const c of CASES) {
  console.log(`${c.name}:`);
  const ref = mesa(c), mine = prism(c);
  for (const n of c.frames) {
    const k = compare(mine[n], ref[n]);
    report(k.drawn > (c.minDrawn ?? 0.02), `frame ${n}: something is drawn`, pct(k.drawn));
    report(k.off <= MAX_OFF && k.edge <= MAX_EDGE, `frame ${n}: PRISM's picture is Mesa's`,
      `${Math.round(k.off * k.n)} of ${k.n} pixels off by more than ${TOL} (${Math.round(k.any * k.n)} differ at all, by at most ${k.max}); coverage differs on ${Math.round(k.edge * k.n)}`);
  }
  // A control is judged on every frame: the defect must show on at least one of them.
  for (const [name, mutate] of c.controls) {
    const got = prism(c, mutate);
    const worst = Math.max(...c.frames.map((n) => { const k = compare(got[n], ref[n]); return Math.max(k.off, k.edge); }));
    report(worst > MAX_OFF, `control: ${name} is told apart`, `${pct(worst)} off`);
  }
  if (pngDir) {
    mkdirSync(pngDir, { recursive: true });
    const W = ref[c.frames[0]].w, H = ref[c.frames[0]].h, out = new Uint8Array(W * 3 * H * c.frames.length * 4);
    c.frames.forEach((n, row) => {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, p = mine[n].rgba, m = ref[n].rgb;
        const a = [p[4 * i], p[4 * i + 1], p[4 * i + 2]], b = [m[3 * i], m[3 * i + 1], m[3 * i + 2]];
        const d = a.some((v, k) => Math.abs(v - b[k]) > TOL) ? [255, 0, 255] : a.map((v) => v >> 2);
        [a, b, d].forEach((col, j) => { const o = (((row * H + y) * W * 3) + j * W + x) * 4; out[o] = col[2]; out[o + 1] = col[1]; out[o + 2] = col[0]; out[o + 3] = 255; });
      }
    });
    const file = join(pngDir, `${c.name.replace(/\W+/g, '-')}.png`);
    writeRgbPng(file, { bytes: out, width: W * 3, height: H * c.frames.length });
    console.log(`  wrote ${file}`);
  }
}
console.log(bad ? `\n${bad} WRONG` : '\nmorph3d and texobj (both paths) draw on PRISM what they draw on Mesa.');
process.exit(bad ? 1 : 0);
