// gate-hlsl.mjs — Direct3D 9 through src/env/d3d9.js and src/env/hlsl.js: HLSL pixel shaders as
// D3DXCompileShader's callers write them, drawn on the device and held to what HLSL and D3D9 define.
//
// Each case is a ps_3_0 shader written for this gate, in the 4K intros' style, carried in the blob
// a host's d3dx9 hands over (hlsl.js makeBlob), with what the program does around it: constants in the
// register file, a texture uploaded as D3D's bytes, a render target drawn and then read. A full-screen
// quad of pretransformed vertices (XYZRHW, D3D9's pixel centres at integer coordinates) covers an 8x8
// back buffer, Present shows it, and the canvas is read back: every pixel must be the value worked out
// here from the HLSL and D3D9 rules (within one step of 255). They fix what a translation could get
// wrong without failing to compile: a float4 truncated to a float3, a scalar broadcast, a bool times a
// float; mul's row vectors and a matrix read from registers packed column-major, or built row by row;
// VPOS as the pixel's integer position with row 0 at the top; a texture's first row as its top; a
// float render target keeping values outside [0, 1].
// In a headless Chrome (WebGL2 on SwiftShader, the same everywhere), as gate-glsl.
//
//   node tools/gate-hlsl.mjs          SKIP when no Chrome is found (PRISM_CHROME=<path> names one)
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let bad = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${ok ? '' : `\n        ${detail}`}`); if (!ok) bad++; };
const CHROME = process.env.PRISM_CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!CHROME) skip('no Chrome for the WebGL2 part', 'install Google Chrome, or PRISM_CHROME=<path to a Chrome or Chromium>');

const N = 8;
// M's rows, and its registers packed column-major as fxc packs a float4x4: register k is column k.
const M = [[0.2, 0.3, 0.4, 0.5], [0.6, 0.7, 0.8, 0.9], [0.1, 0.15, 0.25, 0.35], [0.45, 0.55, 0.65, 0.75]];
const cols = [0, 1, 2, 3].flatMap((k) => M.map((row) => row[k]));
// A 2x2 A8R8G8B8 texture as D3D's bytes (B, G, R, A), first row first: red, green / blue, white.
const tex = [0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255];
const cases = [
  { name: 'a float4 truncated to a float3, a brace initialiser, a scalar broadcast in dot, a bool times a float',
    src: 'float4 c:register(c0);float4 m(float2 v:vpos):color{float3 p=c;float3 e={.25,0,0};return float4(dot(abs(p-e),.5),(p.x<.5)*.75+(p.y<=.5)*.25,frac(1.25),1);}',
    consts: [0.75, 0.5, 0.25, 9], want: () => [0.625, 0.25, 0.25, 1] },
  { name: 'mul: a row vector by a matrix read from registers (column-major), the matrix by a column; a float3x3 built row by row',
    src: 'float4x4 M:register(c0);float4 m():color{float3x3 R=float3x3(.1,.2,.3,.4,.5,.6,.7,.8,.9);return float4(mul(float4(1,0,0,0),M).x,mul(M,float4(0,1,0,0)).x,mul(float3(0,1,0),R).z,mul(R,float3(0,0,1)).x);}',
    consts: cols, want: () => [M[0][0], M[0][1], 0.6, 0.3] },
  { name: 'VPOS is the pixel\'s integer position, row 0 at the top',
    src: 'float4 m(float2 v:vpos):color{return float4(v/8,0,1);}', want: (x, y) => [x / N, y / N, 0, 1] },
  { name: 'a texture\'s first row is its top (A8R8G8B8 as D3D\'s bytes), sampled with D3D9\'s default point filter',
    src: 'sampler s;float4 m(float2 v:vpos):color{return tex2D(s,(v+.5)/8);}', texture: tex,
    want: (x, y) => (y < 4 ? (x < 4 ? [1, 0, 0, 1] : [0, 1, 0, 1]) : (x < 4 ? [0, 0, 1, 1] : [1, 1, 1, 1])) },
  { name: 'two passes: a float render target (A32B32G32R32F) keeps values outside [0, 1], then is read with its first row at the top',
    first: 'float4 m(float2 v:vpos):color{return float4(v.x*.1,v.y*.05,-1,2);}',
    src: 'sampler s;float4 m(float2 v:vpos):color{float4 t=tex2D(s,(v+.5)/8);return float4(t.x,t.y,t.z+1.25,t.w-1.5);}',
    want: (x, y) => [x * 0.1, y * 0.05, 0.25, 0.5] },
  { name: 'a loop with a float counter, a comma step, an assignment in its condition (cdak\'s style), a function returning float',
    src: 'float f(float x){return x-.25;}float4 m():color{float i,a,z=0;for(i=0;i<8&&abs(a=f(i*.1))>.01;i++,z+=.125);return float4(z,a+.5,i/8,1);}',
    want: () => [1, 0.95, 1, 1] },
];

const page = `<!doctype html><canvas id="c" width="${N}" height="${N}"></canvas><pre id="o"></pre>
<script type="module">
import { createD3D9 } from '/src/env/d3d9.js';
import { makeBlob } from '/src/env/hlsl.js';
const cases = ${JSON.stringify(cases.map(({ want, ...k }) => k))};
const out = {};
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
const d3d = createD3D9({ gl });
const dev = d3d.createDevice({ width: ${N}, height: ${N}, backBufferFormat: 22, backBufferCount: 1, autoDepthStencilFormat: 0, windowed: 1, presentInterval: 0 });
const back = dev.getBackBuffer(0, 0);
// a full-screen quad: pixel centres at integer coordinates, so its corners at -0.5 and N - 0.5
const quad = new Uint8Array(new Float32Array([-.5, -.5, 0, 1, 0, 0, ${N - 0.5}, -.5, 0, 1, 1, 0, -.5, ${N - 0.5}, 0, 1, 0, 1, ${N - 0.5}, ${N - 0.5}, 0, 1, 1, 1]).buffer);
for (const k of cases) {
  try {
    dev.setFVF(0x104);                                       // XYZRHW | TEX1
    dev.beginScene();
    dev.setRenderTarget(0, back);
    dev.clear(null, 1, 0, 1, 0);
    if (k.consts) dev.setPixelShaderConstantF(0, new Float32Array(k.consts));
    if (k.texture) {
      const t = dev.createTexture(2, 2, 1, 0, 21);
      dev.textureWrite(t, 0, null, new Uint8Array(k.texture), 8);
      dev.setTexture(0, t);
    }
    if (k.first) {
      const t = dev.createTexture(${N}, ${N}, 1, 1, 116), s = dev.getSurfaceLevel(t, 0);
      dev.setRenderTarget(0, s);
      dev.setPixelShader(dev.createPixelShader(makeBlob('ps_3_0', 'm', k.first)));
      dev.drawPrimitiveUP(5, 2, quad, 24);
      dev.setRenderTarget(0, back);
      dev.setTexture(0, t);
    }
    dev.setPixelShader(dev.createPixelShader(makeBlob('ps_3_0', 'm', k.src)));
    dev.drawPrimitiveUP(5, 2, quad, 24);
    dev.endScene();
    dev.present();
    const px = new Uint8Array(${N * N * 4});
    gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out[k.name] = { pixels: Array.from(px) };
  } catch (e) { out[k.name] = { error: String(e.message || e).slice(0, 2000) }; }
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
const url = `http://127.0.0.1:${server.address().port}/`;
const dom = await new Promise((resolve, reject) => {
  const p = spawn(CHROME, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--virtual-time-budget=20000', '--dump-dom', url], { stdio: ['ignore', 'pipe', 'ignore'] });
  let s = ''; p.stdout.on('data', (d) => { s += d; }); p.on('close', () => resolve(s)); p.on('error', reject);
});
server.close();
const m = dom.match(/<pre id="o">([\s\S]*?)<\/pre>/);
let res = null;
try { res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); } catch { /* reported below */ }
if (!res) { check(false, 'the WebGL2 page ran', m ? m[1].slice(0, 200) : 'no output from Chrome'); process.exit(1); }
for (const k of cases) {
  const r = res[k.name];
  if (!r || r.error) { check(false, k.name, r ? r.error : 'not run'); continue; }
  // the canvas read back bottom row first: D3D's row y is the canvas's row N - 1 - y
  let worst = 0, at = '';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const want = k.want(x, y).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)), o = ((N - 1 - y) * N + x) * 4;
    for (let c = 0; c < 4; c++) { const d = Math.abs(r.pixels[o + c] - want[c]); if (d > worst) { worst = d; at = `(${x},${y}) got ${r.pixels.slice(o, o + 4)} want ${want}`; } }
  }
  check(worst <= 1, k.name, `off by ${worst} at ${at}`);
}
console.log(bad ? `\n${bad} check(s) failed.` : '\nHLSL draws on the Direct3D 9 device what HLSL and D3D9 define.');
process.exit(bad ? 1 : 0);
