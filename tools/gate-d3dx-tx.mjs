// gate-d3dx-tx.mjs — D3DX's texture shaders through src/env/d3d9.js fillTextureTX and src/env/hlsl.js
// (tx_1_0), held to Microsoft's own d3dx9_33.dll: what D3DXFillTextureTX writes, texel by texel, as
// tools/oracle/txref.c reads it back under Wine (goldens/d3dx-tx.json).
//
// The cases fix what a texture shader is: POSITION the texel's centre in [0, 1] and PSIZE one texel's size,
// level by level down the chain, row 0 first; HLSL's noise() as D3DX computes it -- Perlin's noise3 with its
// own offset, scale and tables (tools/gen-d3dx-noise.mjs) -- at lattice points, between them, below zero,
// past the 256-cell period; and a shader in the 4K intros' style (Ergon's), octaves of noise through nested
// macros, written into an R32F and an R16F chain. In a headless Chrome (WebGL2 on SwiftShader), as gate-hlsl.
//
//   node tools/gate-d3dx-tx.mjs              SKIP when no Chrome is found (PRISM_CHROME=<path> names one)
//   node tools/gate-d3dx-tx.mjs --capture    runs the DLL in the oracle container first (corpus/d3dx9_33)
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

// texel (x, y) holds noise(o + x*dx + y*dy) in each channel
const grid = (chans) => `float4 t(float2 p:POSITION,float2 s:PSIZE):COLOR{float2 i=floor(p/s);return float4(${chans.map(([o, dx, dy]) =>
  `noise(float3(${o})+float3(${dx})*i.x+float3(${dy})*i.y)`).join(',')});}`;
const OCTAVES = `#define ty(x,y)(pow(.5+sin((x)*y*6.2831)/2,2)-.5)
#define t2(x,y)ty(y+2*ty(x+2*noise(float3(cos((x)/3)+x,y,(x)*.1)),.3),.7)
float4 t(float2 x:position,float2 y:psize):color{float a=0,d=16;for(;d>=1;d/=2)a+=abs(t2(x.x*2*d,x.y*2*d))/d;return a;}`;
const cases = [
  { name: 'POSITION is the texel centre and PSIZE one texel, on every level of the chain, row 0 first', src: 'float4 t(float2 p:POSITION,float2 s:PSIZE):COLOR{return float4(p,s);}',
    w: 8, h: 4, levels: 0, fmt: 116, tol: { worst: 0 } },
  { name: 'noise() at lattice points (0), half-way between them, and along an edge (the s-curve)',
    src: grid([['0,0,0', '1,0,0', '0,1,0'], ['.5,.5,.5', '1,0,0', '0,1,0'], ['0,0,0', '.03125,0,0', '0,0,1'], ['0,.5,0', '.0625,0,0', '0,0,.0625']]), w: 32, h: 32, levels: 1, fmt: 116, tol: { worst: 1e-6 } },
  { name: 'noise() below zero, past the 256-cell period, and at a large offset where x + 10000 loses bits',
    src: grid([['-3.7,-1.2,.3', '.37,0,0', '0,.29,0'], ['250.3,251.7,3.1', '.53,0,0', '0,0,.41'], ['1000.13,-77.7,5000.6', '.11,.07,0', '0,.13,.05'], ['-9000.4,.2,.9', '.017,0,0', '0,.023,0']]),
    w: 32, h: 32, levels: 1, fmt: 116, tol: { worst: 2.6e-3 } },
  { name: 'octaves of noise through nested macros (Ergon\'s style) into an R32F chain', src: OCTAVES, w: 32, h: 32, levels: 0, fmt: 114, tol: { worst: 0.03, p90: 2e-3 } },
  { name: 'the same into an R16F chain, the format Ergon fills', src: OCTAVES, w: 32, h: 32, levels: 0, fmt: 111, tol: { worst: 0.03, p90: 2e-3 } },
];
const BYTES = { 116: 16, 114: 4, 111: 2 };
const half = (b) => { const s = b & 0x8000 ? -1 : 1, e = (b >> 10) & 31, m = b & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? s * Infinity : s * (1 + m / 1024) * 2 ** (e - 15); };
const values = (buf, fmt) => { const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); const out = [];
  for (let o = 0; o < buf.byteLength; o += fmt === 111 ? 2 : 4) out.push(fmt === 111 ? half(dv.getUint16(o, true)) : dv.getFloat32(o, true)); return out; };

const GOLDEN = join(ROOT, 'goldens', 'd3dx-tx.json');
if (process.argv.includes('--capture')) {
  const { sh, SCRATCH } = await import('./oracle.mjs');
  const dll = join(ROOT, 'corpus/d3dx9_33/d3dx9_33.dll');
  if (!existsSync(dll)) { console.log(`no ${dll}: see tools/gen-d3dx-noise.mjs`); process.exit(1); }
  const dir = join(SCRATCH, 'tx');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, 'tools/oracle/txref.c'), join(dir, 'txref.c'));
  copyFileSync(dll, join(dir, 'd3dx9_33.dll'));
  const b = sh('cd /work/tx && /usr/lib/wine/winegcc -m32 -O1 -o txref.exe txref.c -ld3d9 2>&1 | grep -v warning', { timeout: 600000 });
  if (!existsSync(join(dir, 'txref.exe.so'))) { console.log(`txref did not build:\n${b.stdout}${b.stderr}`); process.exit(1); }
  sh('[ -e /tmp/.X7-lock ] || { Xvfb :7 -screen 0 640x480x24 >/dev/null 2>&1 & sleep 2; }');
  const golden = { _note: 'What Microsoft\'s d3dx9_33.dll (D3DX 9.18.904.15) writes with D3DXFillTextureTX for each case of tools/gate-d3dx-tx.mjs, '
    + 'run on Wine\'s d3d9 by tools/oracle/txref.c: every level, level 0 first, row 0 first, each texel\'s channels in the format\'s order.', cases: {} };
  for (const [i, k] of cases.entries()) {
    writeFileSync(join(dir, `g${i}.hlsl`), `${k.src}\n`);
    // through `| cat`, as gate-hlsl: with its output straight on docker exec's pipe, wine writes nothing
    const r = sh(`cd /work/tx && rm -f g${i}.bin && DISPLAY=:7 WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml=;d3dx9_33=n" wine ./txref.exe d3dx9_33.dll g${i}.hlsl t ${k.w} ${k.h} ${k.levels} ${k.fmt} g${i}.bin 2>&1 | cat`, { timeout: 600000 });
    if (!existsSync(join(dir, `g${i}.bin`))) { console.log(`${k.name}: txref failed\n${r.stdout}${r.stderr}`); process.exit(1); }
    golden.cases[k.name] = values(readFileSync(join(dir, `g${i}.bin`)), k.fmt).map((v) => +v.toPrecision(8));
  }
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  console.log(`wrote ${GOLDEN}\n`);
}
if (!CHROME) skip('no Chrome for the WebGL2 part', 'install Google Chrome, or PRISM_CHROME=<path to a Chrome or Chromium>');
if (!existsSync(GOLDEN)) { console.log(`no ${GOLDEN}: node tools/gate-d3dx-tx.mjs --capture`); process.exit(1); }
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).cases;

const page = `<!doctype html><canvas id="c" width="8" height="8"></canvas><pre id="o"></pre>
<script type="module">
import { createD3D9 } from '/src/env/d3d9.js';
import { makeBlob } from '/src/env/hlsl.js';
const cases = ${JSON.stringify(cases)};
const out = {};
const gl = document.getElementById('c').getContext('webgl2', { antialias: false });
const dev = createD3D9({ gl }).createDevice({ width: 8, height: 8, backBufferFormat: 22, backBufferCount: 1, autoDepthStencilFormat: 0, windowed: 1, presentInterval: 0 });
for (const k of cases) {
  try {
    const t = dev.createTexture(k.w, k.h, k.levels, 0, k.fmt);
    dev.fillTextureTX(t, makeBlob('tx_1_0', 't', k.src));
    const bytes = [];
    for (let l = 0; ; l++) {
      let s; try { s = dev.getSurfaceLevel(t, l); } catch { break; }
      bytes.push(...dev.surfaceRead(s).bytes);
    }
    out[k.name] = bytes;
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
// What each case is held to, from what was measured (2026-11-01). Where the shader's inputs are exact (a
// texel's position, a lattice of binary fractions), noise() is D3DX's to float32 rounding. Where they are
// computed, they are not: D3DX's texture-shader machine rounds its arithmetic otherwise than the GPU (given
// the inputs D3DX itself computed, this noise() matched it on all 1024 texels tried), and an input one ulp
// apart can fall on the other side of x + 10000's 1/1024 step: one step is 1.5/1024 x |gradient| x sqrt(3)
// at most, 2.6e-3. The octaves feed that, and the GPU's own sin and pow, through two sin()s of gain ~30:
// half the texels within 1e-4, nine in ten within 2e-3, none past 0.03 (measured worst 1.9e-2 of values to 1.5).
for (const k of cases) {
  const r = res[k.name], want = golden[k.name];
  if (!r || r.error) { check(false, k.name, r ? r.error : 'not run'); continue; }
  const got = values(Uint8Array.from(r), k.fmt);
  if (got.length !== want.length) { check(false, k.name, `${got.length} values, D3DX wrote ${want.length}`); continue; }
  let worst = 0, at = 0;
  const diffs = [];
  for (let i = 0; i < want.length; i++) { const d = Math.abs(got[i] - want[i]); diffs.push(d); if (d > worst) { worst = d; at = i; } }
  diffs.sort((a, b) => a - b);
  const pct = (q) => diffs[Math.min(diffs.length - 1, Math.floor(q * diffs.length))];
  const per = BYTES[k.fmt] / (k.fmt === 111 ? 2 : 4);
  const p90 = pct(0.9);
  check(worst <= k.tol.worst && (k.tol.p90 === undefined || p90 <= k.tol.p90), `${k.name} (worst ${worst.toExponential(1)}, p90 ${p90.toExponential(1)})`, `value ${at} (texel ${Math.floor(at / per)}, channel ${at % per}): ${got[at]}, D3DX ${want[at]}`);
}
if (bad) { console.log(`\n${bad} failed`); process.exit(1); }
console.log('\nall cases agree with D3DX');
