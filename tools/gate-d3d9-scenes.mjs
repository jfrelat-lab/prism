// gate-d3d9-scenes.mjs — sequences of Direct3D 9 calls through src/env/d3d9.js, held pixel for pixel to Wine's d3d9
// (wined3d on Mesa's llvmpipe) and DXVK's (on lavapipe) making the same calls. Each scene is a script of calls
// (tools/oracle/d3d9scene.c documents the language): `--capture` plays it there, in the oracle container, and keeps
// each shader's bytecode (D3DXAssembleShader's) and the back buffer in goldens/d3d9-scenes.json; a normal run plays
// it on PRISM's device in a headless Chrome (tools/d3d9scene.js) and compares, within one step of 255.
//
// What the scenes hold: cube and volume textures (sampled by ps_2_0 with their dcl, and by ps_1_1's tex, which
// declares none), vertex declarations of the element types .kkrieger and others use, DrawIndexedPrimitive with a
// base vertex, the stencil one-sided and two-sided. Inputs are chosen off texel edges and face edges, where
// implementations may differ by a rounding.
//
// Each scene is played twice on PRISM: by tools/d3d9scene.js straight on d3d9.js, and by d3d9scene.c ITSELF compiled
// by PRISM, whose COM calls go through src/env/d3d9.c and its host (src/env/d3d9host.js) to the same device -- the
// path a Direct3D 9 program takes. There `code` lines carry the bytecode the reference assembled.
//
//   node tools/gate-d3d9-scenes.mjs              SKIP when no Chrome is found (PRISM_CHROME=<path> names one)
//   node tools/gate-d3d9-scenes.mjs --capture    plays the scenes in the oracle container first
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { skip } from './gate-skip.mjs';
import { buildTarget } from '../src/target.js';
import { snapshotProgram } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'd3d9-scenes.json');
const N = 16;
let bad = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${ok ? '' : `\n        ${detail}`}`); if (!ok) bad++; };
const CHROME = process.env.PRISM_CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);

// ---- building blocks ----
const f = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);          // a float token (d3d9scene reads a '.' as a float)
const asm = (id, ...lines) => `asm ${id} ${lines.join(';')}`;
// POSITION FLOAT3 + TEXCOORD0 FLOAT3
const DECL_PT = 'decl 1 2 0 0 2 0 0 0 0 12 2 0 5 0';
// a quad (triangle strip, clockwise on screen) over the clip rectangle [x0,x1] x [y0,y1], each vertex followed by uvw(x, y)
const quad = (id, x0, y0, x1, y1, uvw = () => []) =>
  `vb ${id} ${[[x0, y1], [x1, y1], [x0, y0], [x1, y0]].map(([x, y]) => [x, y, 0.5, ...uvw(x, y)].map(f).join(' ')).join(' ')}`;
const POINT = ['ss 0 5 1', 'ss 0 6 1', 'ss 0 7 0'];
const VS_PT = asm(1, 'vs_2_0', 'dcl_position v0', 'dcl_texcoord v1', 'mov oPos, v0', 'mov oT0, v1');
const START = ['rs 22 1', 'clear 7 0x204060 1.0 0'];
const cubeDir = (z) => (x, y) => [2.4 * x + 0.13, 2.4 * y + 0.07, z];

const cases = [
  { name: 'a cube map read by ps_2_0 (dcl_cube): +X, -X, +Y, -Y and +Z in one quad, point filtering',
    script: [...START, 'texcube 2 4 1 21', 'settex 0 2', ...POINT, DECL_PT, 'setdecl 1', VS_PT,
      asm(3, 'ps_2_0', 'dcl t0.xyz', 'dcl_cube s0', 'texld r0, t0, s0', 'mov oC0, r0'), 'setvs 1', 'setps 3',
      quad(4, -1, -1, 1, 1, cubeDir(1)), 'stream 0 4 0 24', 'draw 5 0 2'] },
  { name: 'a cube map read by ps_2_0: the -Z hemisphere, from a texture of two levels read at the first',
    script: [...START, 'texcube 2 4 2 21', 'settex 0 2', ...POINT, DECL_PT, 'setdecl 1', VS_PT,
      asm(3, 'ps_2_0', 'dcl t0.xyz', 'dcl_cube s0', 'texld r0, t0, s0', 'mov oC0, r0'), 'setvs 1', 'setps 3',
      quad(4, -1, -1, 1, 1, cubeDir(-1)), 'stream 0 4 0 24', 'draw 5 0 2'] },
  { name: 'a cube map read by ps_1_1\'s tex, which declares no kind (.kkrieger\'s normalisers)',
    script: [...START, 'texcube 2 4 1 21', 'settex 0 2', ...POINT, DECL_PT, 'setdecl 1',
      asm(1, 'vs_1_1', 'dcl_position v0', 'dcl_texcoord v1', 'mov oPos, v0', 'mov oT0, v1'),
      asm(3, 'ps_1_1', 'tex t0', 'mov r0, t0'), 'setvs 1', 'setps 3',
      quad(4, -1, -1, 1, 1, cubeDir(1)), 'stream 0 4 0 24', 'draw 5 0 2'] },
  { name: 'a volume texture read by ps_2_0 (dcl_volume), its slices across the quad',
    script: [...START, 'tex3d 2 4 4 4 1 21', 'settex 0 2', ...POINT, DECL_PT, 'setdecl 1', VS_PT,
      asm(3, 'ps_2_0', 'dcl t0.xyz', 'dcl_volume s0', 'texld r0, t0, s0', 'mov oC0, r0'), 'setvs 1', 'setps 3',
      quad(4, -1, -1, 1, 1, (x, y) => [0.45 * x + 0.52, 0.45 * y + 0.52, 0.2 * (x + y) + 0.53]), 'stream 0 4 0 24', 'draw 5 0 2'] },
  { name: 'a vertex declaration: D3DCOLOR, FLOAT2, UBYTE4N, SHORT2N and FLOAT16_2, drawn indexed from a base vertex',
    script: [...START,
      // POSITION FLOAT3 @0, COLOR D3DCOLOR @12, TEXCOORD0 FLOAT2 @16, TEXCOORD1 UBYTE4N @24, TEXCOORD2 SHORT2N @28, TEXCOORD3 FLOAT16_2 @32
      'decl 1 6 0 0 2 0 0 0 0 12 4 0 10 0 0 16 1 0 5 0 0 24 8 0 5 1 0 28 9 0 5 2 0 32 15 0 5 3', 'setdecl 1',
      asm(2, 'vs_2_0', 'dcl_position v0', 'dcl_color v1', 'dcl_texcoord v2', 'dcl_texcoord1 v3', 'dcl_texcoord2 v4', 'dcl_texcoord3 v5',
        'mov oPos, v0', 'mov oD0, v1', 'mov oT0, v2', 'mov oT1, v3', 'mov oT2, v4', 'mov oT3, v5'),
      asm(3, 'ps_2_0', 'def c0, 0.5, 0.25, 0, 0', 'dcl v0', 'dcl t0.xy', 'dcl t1', 'dcl t2.xy', 'dcl t3.xy',
        'mul r0.x, v0.x, c0.x', 'mad r0.x, t0.x, c0.x, r0.x', 'mul r0.y, t1.y, c0.x', 'mad r0.y, t2.x, c0.y, r0.y', 'add r0.y, r0.y, c0.y',
        'mul r0.z, t3.y, c0.x', 'mad r0.z, t1.z, c0.x, r0.z', 'mov r0.w, c0.x', 'mov oC0, r0'),
      'setvs 2', 'setps 3',
      // two vertices the draw skips, then the quad's four: position, colour, uv, ubyte4n, short2n, half2
      `vb 4 ${[
        [-1, -1, 0x00000000, 0, 0, 0, 0, 0], [-1, -1, 0x00000000, 0, 0, 0, 0, 0],
        [-1, 1, 0xff102030, 0.1, 0.2, 0x40c08000, 0x8001_7fff, 0x3c00_3400],
        [1, 1, 0xff806040, 0.9, 0.3, 0x10204080, 0x2000_c000, 0x3800_3a00],
        [-1, -1, 0xffe0c0a0, 0.3, 0.8, 0xf0e0d0c0, 0xe000_1000, 0x3400_3c00],
        [1, -1, 0xff40a0f0, 0.6, 0.7, 0x80808080, 0x0000_ffff, 0x3a00_3800],
      ].map(([x, y, c, u, v, b4, s2, h2]) => [f(x), f(y), f(0.5), `0x${(c >>> 0).toString(16)}`, f(u), f(v),
        `0x${(b4 >>> 0).toString(16)}`, `0x${(s2 >>> 0).toString(16)}`, `0x${(h2 >>> 0).toString(16)}`].join(' ')).join(' ')}`,
      'ib 5 0 1 2 2 1 3', 'stream 0 4 0 36', 'indices 5', 'drawi 4 2 0 4 0 2'] },
  { name: 'the stencil, one-sided: a quad writes its reference (REPLACE), a second draws only where EQUAL',
    script: [...START, 'decl 1 1 0 0 2 0 0 0', 'setdecl 1', asm(1, 'vs_2_0', 'dcl_position v0', 'mov oPos, v0'),
      asm(2, 'ps_2_0', 'mov oC0, c0'), 'setvs 1', 'setps 2',
      quad(3, -0.9, -0.3, 0.3, 0.9), quad(4, -0.3, -0.9, 0.9, 0.3),
      'rs 52 1', 'rs 56 8', 'rs 55 3', 'rs 57 1', 'psc 0 1.0 0.0 0.0 1.0', 'stream 0 3 0 12', 'draw 5 0 2',
      'rs 56 3', 'rs 55 1', 'psc 0 0.0 1.0 0.0 1.0', 'stream 0 4 0 12', 'draw 5 0 2'] },
  { name: 'the stencil, two-sided: INCR on clockwise triangles, DECR on counter-clockwise ones, then EQUAL 1 and EQUAL 255',
    script: [...START, 'decl 1 1 0 0 2 0 0 0', 'setdecl 1', asm(1, 'vs_2_0', 'dcl_position v0', 'mov oPos, v0'),
      asm(2, 'ps_2_0', 'mov oC0, c0'), 'setvs 1', 'setps 2',
      quad(3, -0.9, -0.9, 0.3, 0.9),
      // the same strip reversed in x: counter-clockwise on screen
      `vb 4 ${[[0.9, 0.9], [-0.3, 0.9], [0.9, -0.9], [-0.3, -0.9]].map(([x, y]) => [x, y, 0.5].map(f).join(' ')).join(' ')}`,
      quad(5, -1, -1, 1, 1),
      'rs 168 0', 'rs 52 1', 'rs 185 1', 'rs 56 8', 'rs 55 7', 'rs 189 8', 'rs 188 8',
      'stream 0 3 0 12', 'draw 5 0 2', 'stream 0 4 0 12', 'draw 5 0 2',
      'rs 168 15', 'rs 185 0', 'rs 55 1', 'rs 56 3', 'rs 57 1', 'psc 0 0.0 1.0 0.0 1.0', 'stream 0 5 0 12', 'draw 5 0 2',
      'rs 57 255', 'psc 0 0.0 0.0 1.0 1.0', 'draw 5 0 2'] },
];

// ---- the reference ----
if (process.argv.includes('--capture')) {
  const { sh, SCRATCH } = await import('./oracle.mjs');
  const dir = join(SCRATCH, 'wine');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, 'tools', 'oracle', 'd3d9scene.c'), join(dir, 'd3d9scene.c'));
  const b = sh('cd /work/wine && /usr/lib/wine/winegcc -m32 -O1 -o d3d9scene.exe d3d9scene.c -ld3d9 -ld3dx9 2>&1 | grep -v warning', { timeout: 600000 });
  if (!existsSync(join(dir, 'd3d9scene.exe.so'))) { console.log(`d3d9scene did not build:\n${b.stdout}${b.stderr}`); process.exit(1); }
  sh('[ -e /tmp/.X7-lock ] || { Xvfb :7 -screen 0 640x480x24 >/dev/null 2>&1 & sleep 2; }');
  const dxvk = sh('[ -f /opt/dxvk/x32/d3d9.dll ] && cp /opt/dxvk/x32/d3d9.dll /work/wine/dxvk_d3d9.dll && echo yes').stdout.includes('yes');
  const words = (file) => { const x = readFileSync(file); return Array.from(new Uint32Array(x.buffer, x.byteOffset, x.length >> 2)); };
  const golden = { _doc: ['Wine 8.0 d3d9 (wined3d on Mesa llvmpipe) and DXVK 1.10.3 (on lavapipe) playing the gate-d3d9-scenes scripts through',
    'tools/oracle/d3d9scene.c: each case\'s shaders as D3DXAssembleShader assembled them (id -> DWORDs) and its 16x16 back buffer',
    '(wine, dxvk), row 0 (the top) first, R, G, B bytes. Written by node tools/gate-d3d9-scenes.mjs --capture.'], cases: {} };
  for (const [i, k] of cases.entries()) {
    const txt = `s${i}.txt`;
    writeFileSync(join(dir, txt), `${k.script.join('\n')}\n`);
    // through `| cat`: with its output straight on docker exec's pipe, wine returns 0 and the program writes nothing (gate-d3d9-asm)
    const run = (prefix, dll, out) => sh(`cd /work/wine && rm -f ${out} && WINEPREFIX=${prefix} DISPLAY=:7 WINEDEBUG=-all WINEDLLOVERRIDES=mscoree,mshtml= wine ./d3d9scene.exe ${dll}${txt} ${out} ${N} ${N} 2>&1 | cat`, { timeout: 600000 });
    const rw = run('/root/.wine', '', `s${i}.rgb`);
    if (!existsSync(join(dir, `s${i}.rgb`))) { check(false, `Wine played: ${k.name}`, rw.stdout.slice(-800)); continue; }
    const rd = dxvk ? run('/root/.wine-dxvk', '-dll dxvk_d3d9.dll ', `s${i}-dxvk.rgb`) : null;
    if (dxvk && !existsSync(join(dir, `s${i}-dxvk.rgb`))) check(false, `DXVK played: ${k.name}`, rd.stdout.slice(-800));
    const shaders = {};
    for (const line of k.script) { const m = line.match(/^asm (\d+) /); if (m) shaders[m[1]] = words(join(dir, `${txt}.${m[1]}.bin`)); }
    golden.cases[k.name] = { shaders, wine: Array.from(readFileSync(join(dir, `s${i}.rgb`))),
      ...(dxvk && existsSync(join(dir, `s${i}-dxvk.rgb`)) ? { dxvk: Array.from(readFileSync(join(dir, `s${i}-dxvk.rgb`))) } : {}) };
    console.log(`  captured  ${k.name}`);
  }
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  console.log(`wrote ${GOLDEN}\n`);
}
if (!CHROME) skip('no Chrome for the WebGL2 part', 'install Google Chrome, or PRISM_CHROME=<path to a Chrome or Chromium>');
if (!existsSync(GOLDEN)) { console.log(`no ${GOLDEN}: node tools/gate-d3d9-scenes.mjs --capture`); process.exit(1); }
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).cases;

// ---- PRISM: the same scripts on d3d9.js ----
const runs = cases.filter((k) => golden[k.name]).map((k) => ({ name: k.name, script: k.script.join('\n'), shaders: golden[k.name].shaders,
  // for the compiled program: each asm line replaced by the bytecode it assembled to
  program: `${k.script.map((l) => { const a = l.match(/^asm (\d+) /); return a ? `code ${a[1]} ${golden[k.name].shaders[a[1]].map((w) => `0x${(w >>> 0).toString(16)}`).join(' ')}` : l; }).join('\n')}\n` }));
// d3d9scene.c through PRISM, once, as a snapshot the page loads (what the page's worker does with a bundle)
const target = { name: 'd3d9scene', dir: 'tools/oracle', units: { list: ['d3d9scene.c'] }, generated: ['src/env/win32-app.c', 'src/env/d3d9.c', 'src/env/dsound.c'],
  env: ['stdio', 'd3d9'], compile: { memory: 64, collect: true } };
let snap = null;
buildTarget(target, { root: ROOT, onProgram: (p) => { if (p.failures?.length) throw new Error(`d3d9scene.c: ${p.failures.map((f) => `${f.fn}: ${f.message}`).join('; ')}`); snap = snapshotProgram(p); } });
const bundleJs = `export const meta = ${JSON.stringify(snap.meta)};\nexport const factory = (function(){\n${snap.src}\n})();\n`;
const page = `<!doctype html><canvas id="c" width="${N}" height="${N}"></canvas><pre id="o"></pre>
<script type="module">
import { createD3D9 } from '/src/env/d3d9.js';
import { playScene } from '/tools/d3d9scene.js';
import { loadSnapshot, bindLateBuiltins } from '/src/compile.js';
import { buildEnv } from '/src/env/registry.js';
import * as B from '/bundle.js';
const image = new Uint8Array(await (await fetch('/bundle.bin')).arrayBuffer());
const runs = ${JSON.stringify(runs)};
const out = {};
const gl = document.getElementById('c').getContext('webgl2', { antialias: false });
const d3d = createD3D9({ gl });
for (const k of runs) {
  try {
    const dev = d3d.createDevice({ width: ${N}, height: ${N}, backBufferFormat: 22, backBufferCount: 1, autoDepthStencilFormat: 75, windowed: 1, presentInterval: 0 });
    dev.beginScene();
    out[k.name] = playScene(dev, k.script, k.shaders, ${N}, ${N});
  } catch (e) { out[k.name] = { error: String(e.message || e).slice(0, 3000) }; }
  try {
    const program = loadSnapshot({ meta: B.meta, factory: B.factory, image });
    const env = buildEnv(program.M, ['stdio', 'd3d9'], { stdio: { files: { 's.txt': new TextEncoder().encode(k.program) } }, d3d9: { gl } });
    bindLateBuiltins(program);
    program.run(['d3d9scene', 's.txt', 'out.rgb', '${N}', '${N}']);
    program.M.flushAll?.();
    const got = program.M.files.store.get('out.rgb');
    out['program: ' + k.name] = got ? Array.from(got) : { error: 'no out.rgb (calls: ' + JSON.stringify([...env.d3d9.calls]) + ')' };
  } catch (e) { out['program: ' + k.name] = { error: String(e.stack || e.message || e).slice(0, 3000) }; }
}
document.getElementById('o').textContent = JSON.stringify(out);
</script>`;
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
  if (path === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundleJs); return; }
  if (path === '/bundle.bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from(snap.image)); return; }
  const file = join(ROOT, path);
  if (!(file.startsWith(join(ROOT, 'src')) || file === join(ROOT, 'tools', 'd3d9scene.js')) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript' : 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const dom = await new Promise((resolve, reject) => {
  const p = spawn(CHROME, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--virtual-time-budget=60000', '--dump-dom', `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let s = ''; p.stdout.on('data', (d) => { s += d; }); p.on('close', () => resolve(s)); p.on('error', reject);
});
server.close();
const m = dom.match(/<pre id="o">([\s\S]*?)<\/pre>/);
let res = null;
try { res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); } catch { /* reported below */ }
if (!res) { check(false, 'the WebGL2 page ran', m ? m[1].slice(0, 200) : 'no output from Chrome'); process.exit(1); }
const verbose = process.argv.includes('--verbose');
const image = (px) => Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => px.slice((y * N + x) * 3, (y * N + x) * 3 + 3).map((v) => v.toString(16).padStart(2, '0')).join('')).join(' ')).join('\n        ');
for (const [via, k] of [...cases.map((k) => ['', k]), ...cases.map((k) => ['program: ', k])]) {
  const r = res[via + k.name], gd = golden[k.name], name = via ? `${k.name} -- through d3d9.c, compiled` : k.name;
  if (!gd) { check(false, name, 'no capture: node tools/gate-d3d9-scenes.mjs --capture'); continue; }
  if (!r || r.error) { check(false, name, r ? r.error : 'not run'); continue; }
  for (const [who, ref] of [['Wine', gd.wine], ['DXVK', gd.dxvk]]) {
    if (!ref) continue;
    let worst = 0, at = 0, n = 0;
    for (let i = 0; i < ref.length; i++) { const d = Math.abs(r[i] - ref[i]); if (d > 1) n++; if (d > worst) { worst = d; at = i; } }
    const px = (at / 3) | 0;
    check(worst <= 1, `${name} -- against ${who}`, `${n} bytes off, worst ${worst} at (${px % N},${(px / N) | 0}): PRISM ${r.slice(px * 3, px * 3 + 3)}, ${who} ${ref.slice(px * 3, px * 3 + 3)}` +
      (verbose ? `\n        PRISM:\n        ${image(r)}\n        ${who}:\n        ${image(ref)}` : ''));
  }
}
if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nevery scene draws on the Direct3D 9 device what Wine and DXVK draw.');
