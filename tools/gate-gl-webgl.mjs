// gate-gl-webgl.mjs — gate-gl-scenes' scenes drawn by the page's renderer, WebGL2, and held to Mesa.
//
// gate-gl-scenes holds gl.js's SOFTWARE rasteriser to Mesa pixel for pixel; the page draws with WebGL,
// which no pixel gate saw (gate-webgl-stream hashes its calls, not its pictures). Here the same
// tests/gl/scenes.c, compiled once in Node and loaded as a snapshot (what the page's worker does with
// a bundle), runs in a headless Chrome on gl.js's WebGL backend -- SwiftShader, so the same everywhere
// -- and each frame is compared with Mesa's (llvmpipe, in the oracle container).
//
// A GPU computes in float and rasterises by its own rules where the software path is exact, so the
// comparison has a tolerance: a pixel is off when a channel differs by more than TOL, and a scene
// passes when at most its budget of pixels are (goldens/gl-webgl.json, written by --capture from a
// run that was looked at). The budget is what this backend did when captured: a change that makes it
// draw worse than that fails.
//
//   node tools/gate-gl-webgl.mjs [scene ...] [--capture] [--png=<dir>] [--cpu]
//   SKIP when no Chrome is found (PRISM_CHROME=<path> names one)
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildTarget } from '../src/target.js';
import { snapshotProgram } from '../src/compile.js';
import { up, sh, SCRATCH, oracleGlut } from './oracle.mjs';
import { writeRgbPng } from './png.mjs';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'gl-webgl.json');
const ALL = ['tex-nearest', 'tex-linear', 'mip-nn', 'mip-ln', 'mip-ll', 'lightmap', 'alpha', 'blend', 'fog', 'clip', 'depth',
  'texgen-object', 'texgen-sphere', 'arrays-normal', 'colour-material', 'matrix-rect',
  'vbo', 'points', 'point-sprite', 'array-types', 'copytex', 'far', 'generate-mipmap', 'rect-forms', 'multitex-shadow', 'combine', 'lights', 'fbo', 'polygon-mode', 'push-attrib'];
const args = process.argv.slice(2);
const CAPTURE = args.includes('--capture');
// --cpu: vertices transformed in JavaScript, as before P15.15's vertex shader -- to compare the two.
const CPU = args.includes('--cpu');
const pngDir = args.find((a) => a.startsWith('--png='))?.slice(6);
const SCENES = args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : ALL;
const TOL = 8;

const CHROME = process.env.PRISM_CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!CHROME) skip('no Chrome for the WebGL2 renderer', 'install Google Chrome, or PRISM_CHROME=<path to a Chrome or Chromium>');

// ---- Mesa's pictures, as gate-gl-scenes makes them ------------------------------------------------
up();
const work = join(SCRATCH, 'gl-scenes');
mkdirSync(join(work, 'GL'), { recursive: true });
copyFileSync(join(ROOT, 'tests', 'gl', 'scenes.c'), join(work, 'scenes.c'));
oracleGlut(work);
const build = sh('cd /work/gl-scenes && gcc -O0 -I. -o scenes scenes.c glut-egl.c -lEGL -lOpenGL -lm');
if (build.code !== 0) throw new Error(`reference build: ${build.stderr || build.stdout}`);
const mesa = {};
for (const scene of SCENES) {
  const r = sh(`cd /work/gl-scenes && rm -f frame-0.ppm && PRISM_GLUT_FRAMES=0 ./scenes ${scene} && mv frame-0.ppm ${scene}.ppm`);
  if (r.code !== 0) throw new Error(`reference ${scene}: ${r.stderr || r.stdout}`);
  const b = readFileSync(join(work, `${scene}.ppm`)), m = b.toString('latin1', 0, 32).match(/^P6\n(\d+) (\d+)\n255\n/);
  mesa[scene] = { w: +m[1], h: +m[2], rgb: b.subarray(m[0].length) };
}

// ---- PRISM's program, once, as a snapshot the page loads ------------------------------------------
const target = { name: 'gl-scenes', dir: 'tests/gl', units: { list: ['scenes.c'] }, compile: { memory: 16, collect: true }, env: ['stdio', 'gl', 'glut'] };
let snap = null;
buildTarget(target, { root: ROOT, onProgram: (p) => { snap = snapshotProgram(p); } });
const bundleJs = `export const meta = ${JSON.stringify(snap.meta)};\nexport const factory = (function(){\n${snap.src}\n})();\n`;

const page = `<!doctype html><pre id=o>running</pre><script type=module>
import { loadSnapshot, bindLateBuiltins } from '/src/compile.js';
import { buildEnv } from '/src/env/registry.js';
import * as B from '/bundle.js';
const image = new Uint8Array(await (await fetch('/bundle.bin')).arrayBuffer());
for (const scene of ${JSON.stringify(SCENES)}) {
  let frame = null, error = null;
  try {
    const program = loadSnapshot({ meta: B.meta, factory: B.factory, image });
    buildEnv(program.M, ${JSON.stringify(target.env)}, { gl: { backend: 'webgl', tnl: ${!CPU} }, dl: { modules: {} },
      glut: { frames: [0], onFrame: (_n, rgba, w, h) => { frame = { rgba: rgba.slice(), w, h, backend: program.M.gl.backend, gpu: program.M.gl.state.stats.gpuDraws }; } } });
    bindLateBuiltins(program);
    program.run(['scenes', scene]);
  } catch (e) { error = String(e.stack || e.message || e); }
  await fetch('/frame?scene=' + scene + '&w=' + (frame?.w ?? 0) + '&h=' + (frame?.h ?? 0) + '&backend=' + (frame?.backend ?? '') + '&gpu=' + (frame?.gpu ?? 0) + (error ? '&error=' + encodeURIComponent(error.slice(0, 400)) : ''),
    { method: 'POST', body: frame ? frame.rgba : new Uint8Array(0) });
}
await fetch('/done', { method: 'POST' });
document.getElementById('o').textContent = 'done';
</script>`;

const frames = {};
let finish;
const done = new Promise((r) => { finish = r; });
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), path = decodeURIComponent(url.pathname);
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (path === '/frame') {
        const q = url.searchParams;
        frames[q.get('scene')] = { rgba: Buffer.concat(chunks), w: +q.get('w'), h: +q.get('h'), backend: q.get('backend'), gpu: +q.get('gpu'), error: q.get('error') };
      }
      res.end('ok');
      if (path === '/done') finish();
    });
    return;
  }
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
  if (path === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundleJs); return; }
  if (path === '/bundle.bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from(snap.image)); return; }
  const file = join(ROOT, path);
  if (!file.startsWith(join(ROOT, 'src')) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript' : 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const chrome = spawn(CHROME, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--user-data-dir=${join(SCRATCH, 'chrome-gl-webgl')}`,
  `http://127.0.0.1:${server.address().port}/`], { stdio: 'ignore' });
const timeout = setTimeout(() => finish('timeout'), 300000);
const why = await done;
clearTimeout(timeout);
chrome.kill();
server.close();
if (why === 'timeout') { console.log(' FAIL  the page did not finish in 5 minutes'); process.exit(1); }

// ---- the comparison ------------------------------------------------------------------------------
const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};
const captured = { ...golden };
let bad = 0;
if (pngDir) mkdirSync(pngDir, { recursive: true });
for (const scene of SCENES) {
  const f = frames[scene], m = mesa[scene];
  if (!f || f.error || !f.w) { bad++; console.log(` FAIL  ${scene.padEnd(18)} ${f?.error ?? 'no frame'}`); continue; }
  if (f.backend !== 'webgl') { bad++; console.log(` FAIL  ${scene.padEnd(18)} drawn by the ${f.backend} rasteriser, not WebGL`); continue; }
  const N = m.w * m.h;
  let off = 0, max = 0, sum = 0;
  const diff = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) { const e = Math.abs(f.rgba[4 * i + k] - m.rgb[3 * i + k]); sum += e; if (e > d) d = e; }
    if (d > TOL) { off++; diff[i] = 1; }
    if (d > max) max = d;
  }
  const budget = golden[scene];
  const ok = budget !== undefined && off <= budget;
  if (CAPTURE) captured[scene] = off;
  else if (!ok) bad++;
  console.log(`${CAPTURE || ok ? '  ok ' : ' BAD '} ${scene.padEnd(18)} ${String(off).padStart(6)} of ${N} pixels off by more than ${TOL} (max ${max}, mean ${(sum / N / 3).toFixed(2)}); budget ${budget ?? 'none'}${f.gpu ? `; ${f.gpu} draws transformed on the GPU` : ''}`);
  if (pngDir) {
    const W = m.w, H = m.h, out = new Uint8Array(W * 3 * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, a = [f.rgba[4 * i], f.rgba[4 * i + 1], f.rgba[4 * i + 2]], b = [m.rgb[3 * i], m.rgb[3 * i + 1], m.rgb[3 * i + 2]];
      const d = diff[i] ? [255, 0, 255] : a.map((v) => v >> 2);
      [a, b, d].forEach((c, col) => { const o = (y * W * 3 + col * W + x) * 4; out[o] = c[2]; out[o + 1] = c[1]; out[o + 2] = c[0]; out[o + 3] = 255; });
    }
    writeRgbPng(join(pngDir, `${scene}.png`), { bytes: out, width: W * 3, height: H });
  }
}
if (CAPTURE) { writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n'); console.log(`\ncaptured ${GOLDEN}`); process.exit(0); }
console.log(bad ? `\n${bad} WRONG` : '\nevery scene draws on WebGL within its budget of what it draws on Mesa.');
process.exit(bad ? 1 : 0);
