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
//   node tools/gate-hlsl.mjs                 SKIP when no Chrome is found (PRISM_CHROME=<path> names one)
//   node tools/gate-hlsl.mjs --capture-wine  draws the reference again in the oracle container first
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
if (!CHROME) skip('no Chrome for the WebGL2 part', 'install Google Chrome, or PRISM_CHROME=<path to a Chrome or Chromium>');

const N = 8;
const halfBits = (v) => { const f = new Float32Array([v]), x = new Uint32Array(f.buffer)[0], sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 255) - 112, m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7c00; if (e <= 0) return sign; const r = (e << 10) | (m >>> 13), rest = m & 0x1fff; return sign | (r + (rest > 0x1000 || (rest === 0x1000 && (r & 1)) ? 1 : 0)); };
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
    src: 'float4x4 M:register(c0);float4 m():color{float3x3 R=float3x3(.1,.2,.3,.4,.5,.6,.7,.8,.9);return float4(mul(float4(1,0,0,0),M).x,mul(M,float4(0,1,0,0)).x,mul(float3(0,1,0),R).z,1);}',
    consts: cols, want: () => [M[0][0], M[0][1], 0.6, 1] },
  { name: 'mul: a float3x3 built row by row times a column (the back buffer keeps no alpha, so a case of its own)',
    src: 'float4 m():color{float3x3 R=float3x3(.1,.2,.3,.4,.5,.6,.7,.8,.9);return float4(mul(R,float3(0,0,1)),1);}', want: () => [0.3, 0.6, 0.9, 1] },
  { name: 'mul: a float3 by a float4x4 meets the matrix\'s first three rows, as fxc truncates (Photon Race 2); the vertex shader\'s POSITION passed to the pixel shader unread',
    src: 'struct I{float4 p:POSITION;float2 v:VPOS;};float4x4 M:register(c0);float4 m(I i):color{return float4(mul(float3(0,1,0),M).xyz,1);}',
    consts: cols, want: () => [M[1][0], M[1][1], M[1][2], 1] },
  { name: 'VPOS is the pixel\'s integer position, row 0 at the top',
    src: 'float4 m(float2 v:vpos):color{return float4(v/8,0,1);}', want: (x, y) => [x / N, y / N, 0, 1],
    asm: 'ps_3_0\ndef c0, 0.125, 0, 1, 0\nmul r0.xy, vPos, c0.x\nmov r0.z, c0.y\nmov r0.w, c0.z\nmov oC0, r0\n' },
  { name: 'a texture\'s first row is its top (A8R8G8B8 as D3D\'s bytes), sampled with D3D9\'s default point filter',
    src: 'sampler s;float4 m(float2 v:vpos):color{return tex2D(s,(v+.5)/8);}', texture: tex,
    asm: 'ps_3_0\ndef c0, 0.5, 0.125, 0, 0\ndcl_2d s0\nadd r0.xy, vPos, c0.x\nmul r0.xy, r0, c0.y\ntexld r0, r0, s0\nmov oC0, r0\n',
    want: (x, y) => (y < 4 ? (x < 4 ? [1, 0, 0, 1] : [0, 1, 0, 1]) : (x < 4 ? [0, 0, 1, 1] : [1, 1, 1, 1])) },
  { name: 'two passes: a float render target (A32B32G32R32F) keeps values outside [0, 1], then is read with its first row at the top; the X8R8G8B8 back buffer shows no alpha',
    first: 'float4 m(float2 v:vpos):color{return float4(v.x*.1,v.y*.05,-1,2);}',
    firstAsm: 'ps_3_0\ndef c0, 0.1, 0.05, -1, 2\nmul r0.xy, vPos, c0\nmov r0.zw, c0\nmov oC0, r0\n',
    asm: 'ps_3_0\ndef c0, 0.5, 0.125, 1.25, -1.5\ndcl_2d s0\nadd r0.xy, vPos, c0.x\nmul r0.xy, r0, c0.y\ntexld r0, r0, s0\nadd r0.zw, r0, c0\nmov oC0, r0\n',
    src: 'sampler s;float4 m(float2 v:vpos):color{float4 t=tex2D(s,(v+.5)/8);return float4(t.x,t.y,t.z+1.25,t.w-1.5);}',
    want: (x, y) => [x * 0.1, y * 0.05, 0.25, 1] },
  { name: 'two render targets at once (A16B16G16R16F, COLOR0 and COLOR1), drawn twice with ONE/ONE blending beside a third the shader does not write (WebGL refuses that draw unless it is left out), the second then read',
    mrt: 'struct O{float4 a:COLOR0;float4 b:COLOR1;};O m(float2 v:vpos){O o;o.a=1;o.b=float4(v*.05,.375,-.5);return o;}',
    mrtAsm: 'ps_3_0\ndef c0, 1, 0.05, 0.375, -0.5\nmul r0.xy, vPos, c0.y\nmov r0.z, c0.z\nmov r0.w, c0.w\nmov oC0, c0.x\nmov oC1, r0\n',
    src: 'sampler s;float4 m(float2 v:vpos):color{return tex2D(s,(v+.5)/8);}',
    asm: 'ps_3_0\ndef c0, 0.5, 0.125, 0, 0\ndcl_2d s0\nadd r0.xy, vPos, c0.x\nmul r0.xy, r0, c0.y\ntexld r0, r0, s0\nmov oC0, r0\n',
    want: (x, y) => [x * 0.1, y * 0.1, 0.75, 1] },
  { name: 'a vertex shader on XYZ vertices in clip space: pixel centres half a pixel off GL\'s, row 0 at the top, the default cull keeping a clockwise quad',
    vs: 'struct V{float4 p:POSITION;float4 t:TEXCOORD0;};V v(float4 p:POSITION){V o;o.p=p;o.t=p*.5+.5;return o;}',
    src: 'float4 m(float4 t:TEXCOORD0):color{return float4(t.xy,0,1);}', want: (x, y) => [x / N, 1 - y / N, 0, 1],
    vsAsm: 'vs_3_0\ndcl_position v0\ndcl_position o0\ndcl_texcoord o1\ndef c0, 0.5, 0.5, 0.5, 0.5\nmov o0, v0\nmad o1, v0, c0, c0\n',
    asm: 'ps_3_0\ndef c0, 0, 1, 0, 0\ndcl_texcoord v0\nmov r0.xy, v0\nmov r0.z, c0.x\nmov r0.w, c0.y\nmov oC0, r0\n' },
  { name: 'border addressing (D3DTADDRESS_BORDER, which WebGL lacks): the border colour outside [0, 1], the texture inside',
    src: 'sampler s;float4 m(float2 v:vpos):color{return tex2D(s,(v+.5)/4-.5);}', texture: tex, border: 0x80402010,
    asm: 'ps_3_0\ndef c0, 0.5, 0.25, -0.5, 0\ndcl_2d s0\nadd r0.xy, vPos, c0.x\nmad r0.xy, r0, c0.y, c0.z\ntexld r0, r0, s0\nmov oC0, r0\n',
    want: (x, y) => (x < 2 || x > 5 || y < 2 || y > 5 ? [0x40 / 255, 0x20 / 255, 0x10 / 255, 1] : y < 4 ? (x < 4 ? [1, 0, 0, 1] : [0, 1, 0, 1]) : (x < 4 ? [0, 0, 1, 1] : [1, 1, 1, 1])) },
  // Cases with a `script`: its body runs in the page with (dev, back, quad, clip, makeBlob, N, half) inside a
  // scene on the back buffer; `want` then holds the pixels, or `expect` the value the script returns.
  { name: 'a vertex shader reading a texture (D3DVERTEXTEXTURESAMPLER0, R16F, which D3D9 reads as (r, 1, 1, 1)), interpolated',
    script: `
      const t = dev.createTexture(2, 2, 1, 0, 111);                   // R16F: 0.25, 0.5 / 0.75, 1.0, first row first
      dev.textureWrite(t, 0, null, new Uint8Array(new Uint16Array([0.25, 0.5, 0.75, 1].map(half)).buffer), 4);
      dev.setTexture(257, t); dev.setSamplerState(257, 1, 3); dev.setSamplerState(257, 2, 3);   // CLAMP
      dev.setVertexShader(dev.createVertexShader(makeBlob('vs_3_0', 'v', 'sampler2D h:register(s0);struct V{float4 p:POSITION;float4 c:TEXCOORD0;};V v(float4 p:POSITION){V o;o.p=p;o.c=tex2Dlod(h,float4(p.x*.5+.5,.5-p.y*.5,0,0));return o;}')));
      dev.setPixelShader(dev.createPixelShader(makeBlob('ps_3_0', 'm', 'float4 m(float4 c:TEXCOORD0):color{return c;}')));
      dev.setFVF(2); dev.drawPrimitiveUP(5, 2, clip, 12);
      dev.setTexture(257, 0);`,
    // the corners read the texels (top-left 0.25, top-right 0.5, bottom-left 0.75, bottom-right 1), a plane in between
    want: (x, y) => [0.25 + 0.25 * x / N + 0.5 * y / N, 1, 1, 1] },
  { name: 'surfaceRead (LockRect of a render target): A32B32G32R32F as floats, A16B16G16R16F as halves, A8R8G8B8 as B, G, R, A',
    script: `
      const out = {};
      dev.setPixelShader(dev.createPixelShader(makeBlob('ps_3_0', 'm', 'float4 m(float2 v:vpos):color{return v.x<.5?float4(-3,1024,-2.5,.125):float4(997,-.0625,6e4,1.125);}')));
      for (const fmt of [116, 113]) {
        const rt = dev.createRenderTarget(2, 1, fmt, 0, 0, 1);
        dev.setRenderTarget(0, rt);
        dev.drawPrimitiveUP(5, 2, new Uint8Array(new Float32Array([-.5, -.5, 0, 1, 0, 0, 1.5, -.5, 0, 1, 1, 0, -.5, .5, 0, 1, 0, 1, 1.5, .5, 0, 1, 1, 1]).buffer), 24);
        const r = dev.surfaceRead(rt);
        out[fmt] = { pitch: r.pitch, v: Array.from(fmt === 116 ? new Float32Array(r.bytes.buffer) : new Uint16Array(r.bytes.buffer)) };
      }
      const rt = dev.createRenderTarget(1, 1, 21, 0, 0, 1);
      dev.setRenderTarget(0, rt);
      dev.setPixelShader(dev.createPixelShader(makeBlob('ps_3_0', 'm', 'float4 m():color{return float4(1,.5,0,.25);}')));
      dev.drawPrimitiveUP(5, 2, new Uint8Array(new Float32Array([-.5, -.5, 0, 1, 0, 0, .5, -.5, 0, 1, 1, 0, -.5, .5, 0, 1, 0, 1, .5, .5, 0, 1, 1, 1]).buffer), 24);
      const r = dev.surfaceRead(rt);
      out[21] = { pitch: r.pitch, v: Array.from(r.bytes) };
      dev.setRenderTarget(0, back);
      return out;`,
    expect: (o) => {
      const h = (v) => halfBits(v);
      const want = { 116: { pitch: 32, v: [-3, 1024, -2.5, 0.125, 997, -0.0625, 60000, 1.125] }, 113: { pitch: 16, v: [-3, 1024, -2.5, 0.125, 997, -0.0625, 60000, 1.125].map(h) } };
      for (const f of [116, 113]) if (JSON.stringify(o[f]) !== JSON.stringify(want[f])) return `format ${f}: got ${JSON.stringify(o[f])} want ${JSON.stringify(want[f])}`;
      const b = o[21].v;
      if (o[21].pitch !== 4 || b[0] !== 0 || Math.abs(b[1] - 128) > 1 || b[2] !== 255 || Math.abs(b[3] - 64) > 1) return `A8R8G8B8: got ${JSON.stringify(o[21])}, want pitch 4 and bytes 0, 128, 255, 64 (B, G, R, A)`;
      return '';
    } },
  { name: 'drawIndexedPrimitive from buffers kept in GL: 32-bit indices, baseVertex and startIndex, a partial bufferWrite after the first',
    script: `
      const vb = dev.createVertexBuffer(5 * 24, 0, 0x104, 0), ib = dev.createIndexBuffer(9 * 4, 0, 102, 0);
      // a vertex before the quad (baseVertex 1), three indices before its six (startIndex 3)
      dev.bufferWrite(vb, 0, new Uint8Array(new Float32Array([9, 9, 0, 1, 0, 0,  0, 0, 0, 1, 0, 0,  1, 0, 0, 1, 1, 0,  0, 1, 0, 1, 0, 1,  1, 1, 0, 1, 1, 1]).buffer));
      dev.bufferWrite(vb, 24, new Uint8Array(new Float32Array([-.5, -.5, 0, 1, 0, 0, N - .5, -.5, 0, 1, 1, 0, -.5, N - .5, 0, 1, 0, 1, N - .5, N - .5, 0, 1, 1, 1]).buffer));
      dev.bufferWrite(ib, 0, new Uint8Array(new Uint32Array([7, 7, 7, 0, 1, 2, 2, 1, 3]).buffer));
      dev.setPixelShader(dev.createPixelShader(makeBlob('ps_3_0', 'm', 'float4 m(float2 t:TEXCOORD0):color{return float4(t,0,1);}')));
      dev.setFVF(0x104); dev.setStreamSource(0, vb, 0, 24); dev.setIndices(ib);
      dev.drawIndexedPrimitive(4, 1, 0, 4, 3, 2);`,
    want: (x, y) => [(x + 0.5) / N, (y + 0.5) / N, 0, 1] },
  { name: 'a loop with a float counter, a comma step, an assignment in its condition (cdak\'s style), a function returning float',
    src: 'float f(float x){return x-.25;}float4 m():color{float i,a,z=0;for(i=0;i<8&&abs(a=f(i*.1))>.01;i++,z+=.125);return float4(z,a+.5,i/8,1);}',
    want: () => [1, 0.95, 1, 1] },
];

// Wine's d3d9 as the device's reference: the cases that carry `asm` (the same shader in ps_3_0
// assembly; Wine 8.0's HLSL compiler rejects VPOS) are drawn once by tools/oracle/d3d9ref.c in the
// oracle container (--capture-wine), checked there against `want`, and every run then holds PRISM's
// pixels to Wine's. Only device behaviour is asked of Wine -- VPOS, a texture's rows, the default
// filter, a float render target, two at once with blending, the back buffer's X channel, a vertex shader's clip space, border addressing: an assembly twin of an HLSL rule (mul,
// a conversion) would only restate this file's own reading of it.
const GOLDEN = join(ROOT, 'goldens', 'd3d9-wine.json');
const rgbOff = (got, want) => { let worst = 0, at = 0; for (let i = 0; i < want.length; i++) { const d = Math.abs(got[i] - want[i]); if (d > worst) { worst = d; at = i; } } return { worst, at }; };
const wantRGB = (k) => { const o = []; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o.push(...k.want(x, y).slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255))); return o; };
if (process.argv.includes('--capture-wine')) {
  const { sh, SCRATCH } = await import('./oracle.mjs');
  const dir = join(SCRATCH, 'wine');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, 'tools', 'oracle', 'd3d9ref.c'), join(dir, 'd3d9ref.c'));
  const b = sh('cd /work/wine && /usr/lib/wine/winegcc -m32 -O1 -o d3d9ref.exe d3d9ref.c -ld3d9 -ld3dx9 2>&1 | grep -v warning', { timeout: 600000 });
  if (!existsSync(join(dir, 'd3d9ref.exe.so'))) { console.log(`d3d9ref did not build:\n${b.stdout}${b.stderr}`); process.exit(1); }
  sh('[ -e /tmp/.X7-lock ] || { Xvfb :7 -screen 0 640x480x24 >/dev/null 2>&1 & sleep 2; }');
  const golden = { _doc: ['Wine 8.0 d3d9 (wined3d on Mesa llvmpipe) drawing the gate-hlsl cases that carry ps_3_0 assembly,',
    'through tools/oracle/d3d9ref.c. Each case: the 8x8 back buffer, row 0 (the top) first, R, G, B bytes.',
    'Written by node tools/gate-hlsl.mjs --capture-wine.'], cases: {} };
  for (const [i, k] of cases.entries()) {
    if (!k.asm) continue;
    writeFileSync(join(dir, `c${i}.asm`), k.asm);
    if (k.firstAsm || k.mrtAsm) writeFileSync(join(dir, `c${i}-first.asm`), k.firstAsm ?? k.mrtAsm);
    if (k.vsAsm) writeFileSync(join(dir, `c${i}-vs.asm`), k.vsAsm);
    const flags = `${k.texture ? '-tex ' : ''}${k.border !== undefined ? `-border ${k.border.toString(16)} ` : ''}${k.firstAsm ? `-first c${i}-first.asm ` : ''}${k.mrtAsm ? `-mrt c${i}-first.asm ` : ''}${k.vsAsm ? `-vs c${i}-vs.asm ` : ''}`;
    // through `| cat`: with its output straight on docker exec's pipe, wine returns 0 and the program writes nothing (measured)
    const r = sh(`cd /work/wine && rm -f c${i}.rgb && DISPLAY=:7 WINEDEBUG=-all WINEDLLOVERRIDES=mscoree,mshtml= wine ./d3d9ref.exe ${flags}c${i}.asm c${i}.rgb ${N} ${N} ${(k.consts ?? []).join(' ')} 2>&1 | cat`, { timeout: 600000 });
    if (!existsSync(join(dir, `c${i}.rgb`))) { check(false, `Wine drew: ${k.name}`, r.stdout.slice(-400)); continue; }
    const px = Array.from(readFileSync(join(dir, `c${i}.rgb`)));
    golden.cases[k.name] = px;
    const { worst, at } = rgbOff(px, wantRGB(k));
    check(worst <= 1, `Wine draws what this gate expects: ${k.name}`, `off by ${worst} at (${(at / 3 | 0) % N},${(at / 3 / N) | 0})`);
  }
  writeFileSync(GOLDEN, JSON.stringify(golden) + '\n');
  console.log(`wrote ${GOLDEN}\n`);
}

const page = `<!doctype html><canvas id="c" width="${N}" height="${N}"></canvas><pre id="o"></pre>
<script type="module">
import { createD3D9 } from '/src/env/d3d9.js';
import { makeBlob } from '/src/env/hlsl.js';
const cases = ${JSON.stringify(cases.map(({ want, expect, ...k }) => k))};
const half = (v) => { const f = new Float32Array([v]), x = new Uint32Array(f.buffer)[0], sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 255) - 112, m = x & 0x7fffff; if (e >= 31) return sign | 0x7c00; if (e <= 0) return sign; const r = (e << 10) | (m >>> 13), rest = m & 0x1fff; return sign | (r + (rest > 0x1000 || (rest === 0x1000 && (r & 1)) ? 1 : 0)); };
const out = {};
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
const d3d = createD3D9({ gl });
const dev = d3d.createDevice({ width: ${N}, height: ${N}, backBufferFormat: 22, backBufferCount: 1, autoDepthStencilFormat: 0, windowed: 1, presentInterval: 0 });
const back = dev.getBackBuffer(0, 0);
// a full-screen quad: pixel centres at integer coordinates, so its corners at -0.5 and N - 0.5
const quad = new Uint8Array(new Float32Array([-.5, -.5, 0, 1, 0, 0, ${N - 0.5}, -.5, 0, 1, 1, 0, -.5, ${N - 0.5}, 0, 1, 0, 1, ${N - 0.5}, ${N - 0.5}, 0, 1, 1, 1]).buffer);
// clip space, clockwise on screen (D3D's default culls counter-clockwise)
const clip = new Uint8Array(new Float32Array([-1, 1, .5, 1, 1, .5, -1, -1, .5, 1, -1, .5]).buffer);
for (const k of cases) {
  try {
    if (k.script) {
      dev.beginScene(); dev.setRenderTarget(0, back); dev.clear(null, 1, 0, 1, 0);
      const value = new Function('dev', 'back', 'quad', 'clip', 'makeBlob', 'N', 'half', k.script)(dev, back, quad, clip, makeBlob, ${N}, half);
      dev.endScene(); dev.present();
      dev.setVertexShader(0); dev.setFVF(0x104);
      const px = new Uint8Array(${N * N * 4});
      gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out[k.name] = { pixels: Array.from(px), value };
      continue;
    }
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
    if (k.mrt) {
      const t0 = dev.createTexture(${N}, ${N}, 1, 1, 113), t1 = dev.createTexture(${N}, ${N}, 1, 1, 113), t2 = dev.createTexture(${N}, ${N}, 1, 1, 113);
      dev.setRenderTarget(0, dev.getSurfaceLevel(t0, 0)); dev.setRenderTarget(1, dev.getSurfaceLevel(t1, 0)); dev.setRenderTarget(2, dev.getSurfaceLevel(t2, 0));
      dev.clear(null, 1, 0, 1, 0);
      dev.setRenderState(27, 1); dev.setRenderState(19, 2); dev.setRenderState(20, 2);   // ALPHABLENDENABLE, ONE, ONE
      dev.setPixelShader(dev.createPixelShader(makeBlob('ps_3_0', 'm', k.mrt)));
      dev.drawPrimitiveUP(5, 2, quad, 24); dev.drawPrimitiveUP(5, 2, quad, 24);
      dev.setRenderState(27, 0); dev.setRenderTarget(2, 0); dev.setRenderTarget(1, 0); dev.setRenderTarget(0, back);
      dev.setTexture(0, t1);
    }
    if (k.first) {
      const t = dev.createTexture(${N}, ${N}, 1, 1, 116), s = dev.getSurfaceLevel(t, 0);
      dev.setRenderTarget(0, s);
      dev.setPixelShader(dev.createPixelShader(makeBlob('ps_3_0', 'm', k.first)));
      dev.drawPrimitiveUP(5, 2, quad, 24);
      dev.setRenderTarget(0, back);
      dev.setTexture(0, t);
    }
    if (k.border !== undefined) { dev.setSamplerState(0, 1, 4); dev.setSamplerState(0, 2, 4); dev.setSamplerState(0, 4, k.border); }
    dev.setPixelShader(dev.createPixelShader(makeBlob('ps_3_0', 'm', k.src)));
    if (k.vs) {
      dev.setVertexShader(dev.createVertexShader(makeBlob('vs_3_0', 'v', k.vs)));
      dev.setFVF(2);                                         // XYZ
      dev.drawPrimitiveUP(5, 2, clip, 12);
      dev.setVertexShader(0);
    } else dev.drawPrimitiveUP(5, 2, quad, 24);
    dev.setSamplerState(0, 1, 1); dev.setSamplerState(0, 2, 1); dev.setSamplerState(0, 4, 0);
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
  if (k.expect) { const why = k.expect(r.value); check(!why, k.name, why); continue; }
  // the canvas read back bottom row first: D3D's row y is the canvas's row N - 1 - y
  let worst = 0, at = '';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const want = k.want(x, y).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)), o = ((N - 1 - y) * N + x) * 4;
    for (let c = 0; c < 4; c++) { const d = Math.abs(r.pixels[o + c] - want[c]); if (d > worst) { worst = d; at = `(${x},${y}) got ${r.pixels.slice(o, o + 4)} want ${want}`; } }
  }
  check(worst <= 1, k.name, `off by ${worst} at ${at}`);
  if (k.asm) {
    const wine = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')).cases[k.name] : null;
    if (!wine) { check(false, `against Wine's d3d9: ${k.name}`, 'no capture: node tools/gate-hlsl.mjs --capture-wine'); continue; }
    const got = [];   // top row first, as the capture
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const o = ((N - 1 - y) * N + x) * 4; got.push(r.pixels[o], r.pixels[o + 1], r.pixels[o + 2]); }
    const { worst: w, at: a } = rgbOff(got, wine);
    check(w <= 1, `against Wine's d3d9: ${k.name}`, `off by ${w} at (${(a / 3 | 0) % N},${(a / 3 / N) | 0}) got ${got.slice(a - a % 3, a - a % 3 + 3)} Wine ${wine.slice(a - a % 3, a - a % 3 + 3)}`);
  }
}
console.log(bad ? `\n${bad} check(s) failed.` : '\nHLSL draws on the Direct3D 9 device what HLSL and D3D9 define.');
process.exit(bad ? 1 : 0);
