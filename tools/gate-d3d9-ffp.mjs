// gate-d3d9-ffp.mjs — Direct3D 9's fixed function through src/env/d3d9.js: no shader set, the vertices
// transformed and lit by D3D9's own rules ("Mathematics of Lighting") and coloured by the default texture
// stage, held to two implementations of it, Wine's d3d9 (wined3d) and DXVK's, as tools/oracle/ffpref.c draws
// each scene in the oracle container (goldens/d3d9-ffp.json, --capture).
//
// Every scene is one grid of 8 x 8 quads, its normals bulging towards the viewer, under a world rotation and
// translation and a perspective projection: directional, point and spot lights, ambient, emissive and specular
// (the local viewer and not), attenuation and range, renormalised normals under a scaled world, the vertex's
// colour unlit or as the diffuse material, a texture modulated by the lit colour, a view matrix. Gouraud
// shading interpolates per-vertex colours, so the images agree to the rounding of colour, within 3 of 255.
// In a headless Chrome (WebGL2 on SwiftShader), as gate-hlsl.
//
//   node tools/gate-d3d9-ffp.mjs              SKIP when no Chrome is found (PRISM_CHROME=<path> names one)
//   node tools/gate-d3d9-ffp.mjs --capture    draws the references again in the oracle container first
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let bad = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${ok ? '' : `\n        ${detail}`}`); if (!ok) bad++; };
const CHROME = process.env.PRISM_CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const N = 32;

// D3D's row-major matrices, for row vectors
const mul = (a, b) => Array.from({ length: 16 }, (_, k) => [0, 1, 2, 3].reduce((s, i) => s + a[(k & ~3) + i] * b[i * 4 + (k & 3)], 0));
const rotY = (t) => [Math.cos(t), 0, -Math.sin(t), 0, 0, 1, 0, 0, Math.sin(t), 0, Math.cos(t), 0, 0, 0, 0, 1];
const move = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scale = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
const persp = (fov, zn, zf) => { const ys = 1 / Math.tan(fov / 2); return [ys, 0, 0, 0, 0, ys, 0, 0, 0, 0, zf / (zf - zn), 1, 0, 0, -zn * zf / (zf - zn), 0]; };
const WORLD = mul(rotY(0.3), move(0, 0, 3)), PROJ = persp(Math.PI / 3, 0.5, 10);
const light = (i, o) => ({ i, type: 3, diffuse: [0, 0, 0, 0], specular: [0, 0, 0, 0], ambient: [0, 0, 0, 0], position: [0, 0, 0], direction: [0, 0, 1], range: 0, falloff: 0, attenuation: [0, 0, 0], theta: 0, phi: 0, ...o });
const MATERIAL = { diffuse: [0.8, 0.6, 0.4, 1], ambient: [0.5, 0.5, 0.5, 1], specular: [0.7, 0.7, 0.7, 1], emissive: [0.05, 0, 0.05, 0], power: 12 };
const SUN = light(0, { diffuse: [0.9, 0.8, 0.7, 1], ambient: [0.1, 0.1, 0.1, 0], specular: [1, 1, 1, 1], direction: [0.3, -0.4, 1] });
const base = { fvf: 0x12, world: WORLD, proj: PROJ, lights: [SUN], material: MATERIAL, rs: [[139, 0x00202020]] };
const cases = [
  { name: 'a directional light: diffuse, the lights\' and the render state\'s ambient, emissive', ...base },
  { name: 'specular with the local viewer (the default)', ...base, rs: [...base.rs, [29, 1]] },
  { name: 'specular with a viewer at infinity (D3DRS_LOCALVIEWER off)', ...base, rs: [...base.rs, [29, 1], [142, 0]] },
  { name: 'a point light: attenuation and range', ...base, lights: [light(1, { type: 1, diffuse: [1, 0.9, 0.6, 1], specular: [1, 1, 1, 1], position: [0.5, 0.5, 2], range: 4, attenuation: [0.2, 0.3, 0.1] })], rs: [...base.rs, [29, 1]] },
  { name: 'a spot light: the cone between theta and phi, its falloff', ...base, lights: [light(2, { type: 2, diffuse: [1, 1, 1, 1], position: [0, 0, 1], direction: [0, 0, 1], range: 10, attenuation: [1, 0, 0], theta: 0.4, phi: 0.9, falloff: 1.5 })] },
  { name: 'two lights, renormalised normals under a scaled world (D3DRS_NORMALIZENORMALS)', ...base, world: mul(scale(1.5), WORLD),
    lights: [SUN, light(3, { type: 1, diffuse: [0.2, 0.4, 1, 1], position: [-1, 1, 2], range: 8, attenuation: [1, 0, 0] })], rs: [...base.rs, [143, 1]] },
  { name: 'lighting off: the vertex\'s own colour', ...base, fvf: 0x42, rs: [[137, 0]] },
  { name: 'the diffuse material from the vertex\'s colour (D3DMCS_COLOR1, the default)', ...base, fvf: 0x52 },
  { name: 'a texture modulated by the lit colour (texture stage 0 as D3D9 sets it)', ...base, fvf: 0x112, tex: true },
  { name: 'a view matrix: the camera moved and turned, the lights in world space', ...base, view: mul(move(0.4, -0.2, 0.5), rotY(-0.2)), rs: [...base.rs, [29, 1]] },
];
const scene = (k) => [`fvf ${k.fvf.toString(16)}`, ...(k.tex ? ['tex'] : []), ...(k.rs ?? []).map(([s, v]) => `rs ${s} ${v}`),
  `world ${k.world.join(' ')}`, ...(k.view ? [`view ${k.view.join(' ')}`] : []), `proj ${k.proj.join(' ')}`,
  ...k.lights.flatMap((l) => [`light ${l.i} ${l.type} ${[...l.diffuse, ...l.specular, ...l.ambient, ...l.position, ...l.direction, l.range, l.falloff, ...l.attenuation, l.theta, l.phi].join(' ')}`, `enable ${l.i}`]),
  `material ${[...k.material.diffuse, ...k.material.ambient, ...k.material.specular, ...k.material.emissive, k.material.power].join(' ')}`].join('\n') + '\n';

const GOLDEN = join(ROOT, 'goldens', 'd3d9-ffp.json');
if (process.argv.includes('--capture')) {
  const { sh, SCRATCH } = await import('./oracle.mjs');
  const dir = join(SCRATCH, 'wine');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, 'tools/oracle/ffpref.c'), join(dir, 'ffpref.c'));
  const b = sh('cd /work/wine && /usr/lib/wine/winegcc -m32 -O1 -o ffpref.exe ffpref.c -ld3d9 -lm 2>&1 | grep -v warning', { timeout: 600000 });
  if (!existsSync(join(dir, 'ffpref.exe.so'))) { console.log(`ffpref did not build:\n${b.stdout}${b.stderr}`); process.exit(1); }
  sh('[ -e /tmp/.X7-lock ] || { Xvfb :7 -screen 0 640x480x24 >/dev/null 2>&1 & sleep 2; }');
  const dxvk = sh('[ -f /opt/dxvk/x32/d3d9.dll ] && cp /opt/dxvk/x32/d3d9.dll /work/wine/dxvk_d3d9.dll && echo yes').stdout.includes('yes');
  const golden = { _note: `Each scene of tools/gate-d3d9-ffp.mjs drawn by tools/oracle/ffpref.c: the ${N}x${N} back buffer, row 0 (the top) first, R, G, B bytes; wine: Wine 8.0's d3d9, dxvk: DXVK 1.10.3's.`, cases: {} };
  for (const [i, k] of cases.entries()) {
    writeFileSync(join(dir, `f${i}.txt`), scene(k));
    const run = (prefix, dll, out) => sh(`cd /work/wine && rm -f ${out} && WINEPREFIX=${prefix} DISPLAY=:7 WINEDEBUG=-all WINEDLLOVERRIDES=mscoree,mshtml= wine ./ffpref.exe ${dll}f${i}.txt ${out} ${N} ${N} 2>&1 | cat`, { timeout: 600000 });
    const rw = run('/root/.wine', '', `f${i}.rgb`);
    if (!existsSync(join(dir, `f${i}.rgb`))) { console.log(`${k.name}: Wine did not draw\n${rw.stdout}`); process.exit(1); }
    if (dxvk) run('/root/.wine-dxvk', '-dll dxvk_d3d9.dll ', `f${i}-dxvk.rgb`);
    golden.cases[k.name] = { wine: Array.from(readFileSync(join(dir, `f${i}.rgb`))),
      ...(dxvk && existsSync(join(dir, `f${i}-dxvk.rgb`)) ? { dxvk: Array.from(readFileSync(join(dir, `f${i}-dxvk.rgb`))) } : {}) };
  }
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  console.log(`wrote ${GOLDEN}\n`);
}
if (!CHROME) skip('no Chrome for the WebGL2 part', 'install Google Chrome, or PRISM_CHROME=<path to a Chrome or Chromium>');
if (!existsSync(GOLDEN)) { console.log(`no ${GOLDEN}: node tools/gate-d3d9-ffp.mjs --capture`); process.exit(1); }
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).cases;

const page = `<!doctype html><canvas id="c" width="${N}" height="${N}"></canvas><pre id="o"></pre>
<script type="module">
import { createD3D9 } from '/src/env/d3d9.js';
const cases = ${JSON.stringify(cases)};
const out = {};
const gl = document.getElementById('c').getContext('webgl2', { antialias: false });
const d3d = createD3D9({ gl });
// the grid ffpref.c builds
function grid(fvf, n = 8) {
  const stride = 3 + (fvf & 0x10 ? 3 : 0) + (fvf & 0x40 ? 1 : 0) + (fvf & 0x100 ? 2 : 0);
  const vb = new DataView(new ArrayBuffer((n + 1) * (n + 1) * stride * 4)), ib = new Uint16Array(n * n * 6);
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    const px = Math.fround(-1 + 2 * x / n), py = Math.fround(-1 + 2 * y / n);
    let o = (y * (n + 1) + x) * stride * 4;
    const put = (v) => { vb.setFloat32(o, v, true); o += 4; };
    put(px); put(py); put(0);
    if (fvf & 0x10) { const nx = Math.fround(0.6 * px), ny = Math.fround(0.6 * py), l = Math.fround(Math.sqrt(nx * nx + ny * ny + 1)); put(nx / l); put(ny / l); put(-1 / l); }
    if (fvf & 0x40) { vb.setUint32(o, (0xff000000 | (Math.floor((px + 1) / 2 * 255 + 0.5) << 16) | (Math.floor((py + 1) / 2 * 255 + 0.5) << 8) | 128) >>> 0, true); o += 4; }
    if (fvf & 0x100) { put(x / n); put(y / n); }
  }
  let k = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const i0 = y * (n + 1) + x; ib.set([i0, i0 + 1, i0 + n + 1, i0 + 1, i0 + n + 2, i0 + n + 1], k); k += 6; }
  return { vb: new Uint8Array(vb.buffer), ib: new Uint8Array(ib.buffer), nv: (n + 1) * (n + 1), tris: n * n * 2, stride: stride * 4 };
}
for (const k of cases) {
  try {
    const dev = d3d.createDevice({ width: ${N}, height: ${N}, backBufferFormat: 22, backBufferCount: 1, autoDepthStencilFormat: 75, windowed: 1, presentInterval: 0 });
    dev.setRenderState(22, 1);
    for (const [s, v] of k.rs ?? []) dev.setRenderState(s, v);
    dev.setTransform(256, new Float32Array(k.world)); if (k.view) dev.setTransform(2, new Float32Array(k.view)); dev.setTransform(3, new Float32Array(k.proj));
    for (const l of k.lights) { dev.setLight(l.i, l); dev.lightEnable(l.i, true); }
    dev.setMaterial(k.material);
    if (k.tex) {
      const t = dev.createTexture(2, 2, 1, 0, 21);
      dev.textureWrite(t, 0, null, new Uint8Array([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255]), 8);
      dev.setTexture(0, t); dev.setSamplerState(0, 5, 2); dev.setSamplerState(0, 6, 2);
    }
    const m = grid(k.fvf);
    dev.setFVF(k.fvf);
    dev.beginScene();
    dev.clear(null, 3, 0x204060, 1, 0);
    dev.drawIndexedPrimitiveUP(4, 0, m.nv, m.tris, m.ib, 101, m.vb, m.stride);
    dev.endScene();
    const { bytes, pitch } = dev.surfaceRead(dev.getBackBuffer(0, 0));
    const rgb = [];
    for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) { const o = y * pitch + x * 4; rgb.push(bytes[o + 2], bytes[o + 1], bytes[o]); }
    out[k.name] = rgb;
  } catch (e) { out[k.name] = { error: String(e.message || e).slice(0, 3000) }; }
}
document.getElementById('o').textContent = JSON.stringify(out);
</script>`;
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
  const file = join(ROOT, path);
  if (!file.startsWith(join(ROOT, 'src')) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript' : 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const dom = await new Promise((resolve, reject) => {
  const p = spawn(CHROME, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--virtual-time-budget=20000', '--dump-dom', `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let s = ''; p.stdout.on('data', (d) => { s += d; }); p.on('close', () => resolve(s)); p.on('error', reject);
});
server.close();
const m = dom.match(/<pre id="o">([\s\S]*?)<\/pre>/);
let res = null;
try { res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); } catch { /* reported below */ }
if (!res) { check(false, 'the WebGL2 page ran', m ? m[1].slice(0, 200) : 'no output from Chrome'); process.exit(1); }
const off = (a, b) => { let worst = 0, at = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > worst) { worst = d; at = i; } } return { worst, at }; };
for (const k of cases) {
  const r = res[k.name], gd = golden[k.name];
  if (!r || r.error) { check(false, k.name, r ? r.error : 'not run'); continue; }
  for (const [who, ref] of [['Wine', gd.wine], ['DXVK', gd.dxvk]]) {
    if (!ref) continue;
    const { worst, at } = off(r, ref), px = (at / 3) | 0;
    check(worst <= 3, `${k.name}, against ${who} (worst ${worst})`, `at (${px % N},${(px / N) | 0}): PRISM ${r.slice(px * 3, px * 3 + 3)}, ${who} ${ref.slice(px * 3, px * 3 + 3)}`);
  }
}
if (bad) { console.log(`\n${bad} failed`); process.exit(1); }
console.log('\nevery scene agrees with Wine and DXVK');
