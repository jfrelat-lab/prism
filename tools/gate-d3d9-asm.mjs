// gate-d3d9-asm.mjs — Direct3D 9 shader BYTECODE through src/env/sm9.js and src/env/d3d9.js, held
// pixel for pixel to Wine's d3d9 running the same bytecode.
//
// Each case is a shader in D3D9 assembly. `--capture-wine` has tools/oracle/d3d9ref.c assemble it with
// Wine's D3DXAssembleShader in the oracle container, draw it (a full-screen quad on an 8x8 X8R8G8B8
// back buffer, as gate-hlsl), and keep both the bytecode and the pixels in goldens/d3d9-asm.json. A
// normal run hands PRISM that same bytecode, as a program would hand it to CreatePixelShader, draws,
// and compares (within one step of 255). Wine is the semantics here: the cases need no expected values
// of their own, only inputs that vary across the 64 pixels (from vPos) so that signs, zeros and ranges
// are all met, and results mapped into [0, 1] so the back buffer keeps them. Alpha is not stored, so
// each case shows three results. Where Wine 8.0 is itself wrong, a case says why (`notWine`) and is held
// to values worked out here (`want`) instead, Wine serving only as the assembler.
// In a headless Chrome (WebGL2 on SwiftShader), as gate-hlsl.
//
//   node tools/gate-d3d9-asm.mjs                 SKIP when no Chrome is found (PRISM_CHROME=<path> names one)
//   node tools/gate-d3d9-asm.mjs --capture-wine  assembles and draws the reference again in the oracle container first
//   node tools/gate-d3d9-asm.mjs --verbose       prints both images of a case that fails
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'd3d9-asm.json');
let bad = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${ok ? '' : `\n        ${detail}`}`); if (!ok) bad++; };
const N = 8;
const ps3 = (...l) => ['ps_3_0', ...l, ''].join('\n');

const cases = [
  { name: 'ps_3_0 arithmetic and source modifiers: mad, max with a negated source, min with _abs, frc of negatives',
    ps: ps3('def c0, 0.125, -0.5, 0.5, 0.25', 'mul r0.xy, vPos.xy, c0.x', 'add r1, r0.xyxy, c0.y', 'mad r2.x, r1.x, r1.y, c0.z',
      'max r2.y, r1.x, -r1.y', 'min r2.z, r1_abs.x, r1.y', 'mad r3, r2, c0.z, c0.z', 'mov oC0, r3') },
  { name: 'saturate, frc, sub, a write mask with a swizzled source',
    ps: ps3('def c0, 0.25, -0.9, 0.5, 4', 'mad r0.xy, vPos.xy, c0.x, c0.y', 'mul_sat r1.xyz, r0.yxyx, c0.w', 'frc r2.x, r0.x',
      'sub r2.yz, r1.yyzz, r1.xxxx', 'mad r2.yz, r2, c0.z, c0.z', 'mov r2.w, c0.z', 'mov oC0, r2') },
  { name: 'scalar ops: rcp, rsq, exp of a negative, log (results scaled into range)',
    ps: ps3('def c0, 0.125, 0.1, 1, 0', 'def c1, 0.1, 0.3, 1, -0.3', 'mad r0.xy, vPos.xy, c0.x, c0.y', 'rcp r1.x, r0.x', 'rsq r1.y, r0.y',
      'exp r1.z, -r0.x', 'mul r2.xyz, r1, c1', 'mov oC0, r2') },
  { name: 'log of a value below one, pow with a fractional exponent, dp2add',
    ps: ps3('def c0, 0.125, 0.1, 0.7, -0.3', 'def c1, 0.2, 0.7, -0.3, 0.5', 'mad r0, vPos.xyxy, c0.x, c0.y', 'log r1.x, r0.x', 'mul r1.x, r1.x, c0.w',
      'pow r1.y, r0.y, c0.z', 'dp2add r1.z, r0, c1, c1.w', 'mov oC0, r1') },
  { name: 'dp3, dp4, lrp on signed inputs',
    ps: ps3('def c0, 0.125, -0.4375, 0.5, 0.3', 'def c1, 0.2, 0.7, -0.3, 0.6', 'mad r0, vPos.xyxy, c0.x, c0.y', 'dp3 r1.x, r0, c1', 'dp4 r1.y, r0, c1',
      'lrp r1.z, c0.w, r0.x, r0.y', 'mad oC0, r1, c0.z, c0.z') },
  { name: 'cmp on signs (zero included), sincos, nrm',
    ps: ps3('def c0, 0.125, -0.5, 0.5, 2', 'mad r0, vPos.xyxy, c0.x, c0.y', 'cmp r1.x, r0.x, c0.z, -c0.z', 'sincos r3.xy, r0.y',
      'mov r1.y, r3.y', 'nrm r4.xyz, r0', 'mov r1.z, r4.x', 'mad oC0, r1, c0.z, c0.z') },
  { name: 'texld, texldp, texldb and texldl on a 2x2 texture (point filtering), texkill on a sign',
    texture: true,
    ps: ps3('def c0, 0.5, 0.125, 2, 0', 'def c1, 0.5, 0.5, 0, 1', 'dcl_2d s0', 'add r0.xy, vPos, c0.x', 'mul r0.xy, r0, c0.y', 'mov r0.zw, c0.zw',
      'texld r1, r0, s0', 'mul r2.xy, r0, c0.z', 'mov r2.w, c0.z', 'texldp r3, r2, s0', 'texldb r4, r0, s0', 'texldl r5, r0, s0',
      'add r6, r0.x, -c1.x', 'texkill r6', 'add r1.x, r1.x, r3.y', 'add r1.y, r4.z, r5.x', 'mul r1, r1, c1.x', 'mov oC0, r1') },
  { name: 'flow: loop aL over defi with a break_gt, rep, if_lt / else',
    ps: ps3('def c0, 0.125, 0.1, 0, 1', 'defi i0, 5, 2, 3, 0', 'mul r0.xy, vPos, c0.x', 'mov r1, c0.z',
      'loop aL, i0', 'add r1.x, r1.x, c0.y', 'break_gt r1.x, r0.x', 'endloop',
      'rep i0', 'add r1.y, r1.y, c0.y', 'endrep',
      'if_lt r0.x, r0.y', 'mov r1.z, c0.w', 'else', 'mov r1.z, c0.y', 'endif', 'mov oC0, r1') },
  { name: 'subroutines: call, callnz on a defb, ret, labels after the main body',
    // Wine 8.0 writes the pixel shader's colour at the end of the LAST subroutine instead of main, and reads defb from an unset uniform
    notWine: 'its GLSL writes the colour out at the end of the last subroutine', want: (x, y) => [x / 8 + 0.25, y / 8, 0.25],
    ps: ps3('def c0, 0.125, 0.25, 0.5, 0', 'defb b0, true', 'defb b1, false', 'mul r0.xy, vPos, c0.x', 'mov r1, c0.w',
      'call l1', 'callnz l2, b0', 'callnz l2, b1', 'mov oC0, r1', 'ret',
      'label l1', 'add r1.x, r0.x, c0.y', 'ret', 'label l2', 'add r1.y, r1.y, r0.y', 'add r1.z, r1.z, c0.y', 'ret') },
  { name: 'predication: setp, a predicated mov, a negated predicate, if on a predicate, breakp',
    // the loop stops at the first multiple of 0.11 at or above x / 8 (none falls within 0.005 of one)
    notWine: 'its GLSL backend has no setp ("Backend can\'t handle opcode setp")',
    want: (x, y) => [x > 4 ? 1 : 0, y > 4 ? 0 : 0.25, (y > 4 ? 0.75 : 0) + 0.11 * (x + 1)],
    ps: ps3('def c0, 0.125, 0.5, 1, 0', 'def c1, 0.25, 0.75, 0.11, 0', 'defi i0, 8, 0, 0, 0', 'mul r0.xy, vPos, c0.x', 'mov r1, c0.w', 'setp_gt p0.xy, r0, c0.y',
      '(p0.x) mov r1.x, c0.z', '(!p0.y) mov r1.y, c1.x', 'if p0.y', 'mov r1.z, c1.y', 'endif',
      'mov r2.x, c0.w', 'rep i0', 'add r2.x, r2.x, c1.z', 'setp_ge p0.z, r2.x, r0.x', 'breakp p0.z', 'endrep', 'add r1.z, r1.z, r2.x', 'mov oC0, r1') },
  { name: 'ps_2_0: texture coordinates in t registers, the diffuse colour in v0 from a vs_2_0, dcl_2d, texld',
    texture: true,
    vs: ['vs_2_0', 'dcl_position v0', 'def c0, 0.5, 0.53, 0.25, 1', 'mov oPos, v0', 'mad oT0, v0, c0.x, c0.y', 'mad oD0, v0.yxzw, c0.z, c0.x', ''].join('\n'),
    ps: ['ps_2_0', 'dcl t0.xy', 'dcl v0', 'dcl_2d s0', 'texld r0, t0, s0', 'add r0, r0, v0', 'mul r0, r0, c0', 'mov oC0, r0', ''].join('\n'),
    consts: [0.5, 0.5, 0.5, 1] },
  { name: 'vs_3_0: m4x4, m3x3, lit, dst, sgn, mova rounding a fraction and a constant read through a0',
    vs: ['vs_3_0', 'dcl_position v0', 'dcl_position o0', 'dcl_texcoord o1', 'dcl_texcoord1 o2',
      'def c0, 0.5, 0.25, 1, 0', 'def c1, 0.1, 0.2, 0.3, 0.4', 'def c2, 0.5, 0.6, -0.7, 0.8', 'def c3, -0.2, 0.3, 0.9, 0.1', 'def c4, 0.3, 0.1, -0.5, 0.2',
      'def c10, 0.9, 0.1, 0.1, 0', 'def c11, 0.1, 0.9, 0.1, 0', 'def c12, 0.1, 0.1, 0.9, 0',
      'mov o0, v0', 'm4x4 r0, v0, c1', 'm3x3 r1.xyz, v0, c2', 'add r0.w, r1.x, r1.y',
      'lit r2, r0.yxzw', 'dst r3, r0, r1', 'sgn r4, v0, r5, r6',
      'def c5, 0.3, 1.6, 0, 0', 'mad r5.x, v0.x, c5.x, c5.y', 'mova a0.x, r5.x', 'mov r6, c10[a0.x]',
      'mad o1, r0, c0.y, c0.x', 'mad o2.xy, r2.yz, c0.y, c0.y', 'mad o2.z, r4.x, c0.y, c0.x', 'mad o2.w, r6.y, c0.x, r3.y', ''].join('\n'),
    ps: ps3('dcl_texcoord v0', 'dcl_texcoord1 v1', 'def c0, 0.5, 0, 0, 0', 'add r0.xy, v0.xy, v1.zw', 'mul r0.xy, r0, c0.x', 'mov r0.z, v1.x', 'mov oC0, r0') },
  { name: 'vs_3_0: a loop of step 2 reading constants through aL, if on a defb, expp, logp',
    vs: ['vs_3_0', 'dcl_position v0', 'dcl_position o0', 'dcl_texcoord o1',
      'def c0, 0.5, 0.25, 0.75, 0', 'def c4, 0.1, 0.0, 0.0, 0', 'def c5, 0.0, 0.2, 0.0, 0', 'def c6, 0.0, 0.0, 0.3, 0', 'def c8, 0.0, 0.15, 0.0, 0',
      'defi i0, 3, 4, 2, 0', 'defb b0, true', 'mov o0, v0', 'mov r0, c0.w',
      'loop aL, i0', 'add r0, r0, c0[aL]', 'endloop', 'if b0', 'add r0.xyz, r0, v0.x', 'endif',
      'expp r1.x, c0.y', 'logp r1.y, c0.z', 'mad o1.xyz, r0, c0.x, c0.y', 'mov o1.w, r1.x', ''].join('\n'),
    ps: ps3('dcl_texcoord v0', 'def c0, 0.5, 0, 0, 0', 'mov oC0, v0') },
  { name: 'vs_1_1: oPos, oT0, oT1 and a diffuse colour above one (clamped before the pixel shader), m4x3, expp and logp as vectors, an unswizzled rcp',
    vs: ['vs_1_1', 'dcl_position v0', 'def c0, 0.5, 0.25, 2, 1', 'def c1, 0.3, 0.1, 0.2, 0.1', 'def c2, 0.1, 0.4, 0.1, 0.2', 'def c3, 0.2, 0.1, 0.3, 0.3',
      'mov oPos, v0', 'mul oD0, v0.xxyy, c0.z', 'm4x3 r0.xyz, v0, c1', 'expp r1, c0.y', 'logp r2, c0.z', 'rcp r3, c3',
      'mad oT0.xyz, r0, c0.x, c0.x', 'mul oT0.w, r1.y, r2.y', 'mul oT1, r3, c1.y', ''].join('\n'),
    ps: ['ps_2_0', 'dcl t0', 'dcl t1', 'dcl v0', 'def c0, 0.5, 0, 0, 0', 'mad r0.xy, v0, c0.x, t0', 'mul r0.xy, r0, c0.x', 'add r0.z, t0.w, t1.x', 'mov r0.w, c0.x', 'mov oC0, r0', ''].join('\n') },
];

// ---- the reference: Wine assembles and draws ----
const rgbOff = (got, want) => { let worst = 0, at = 0; for (let i = 0; i < want.length; i++) { const d = Math.abs(got[i] - want[i]); if (d > worst) { worst = d; at = i; } } return { worst, at }; };
if (process.argv.includes('--capture-wine')) {
  const { sh, SCRATCH } = await import('./oracle.mjs');
  const dir = join(SCRATCH, 'wine');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, 'tools', 'oracle', 'd3d9ref.c'), join(dir, 'd3d9ref.c'));
  const b = sh('cd /work/wine && /usr/lib/wine/winegcc -m32 -O1 -o d3d9ref.exe d3d9ref.c -ld3d9 -ld3dx9 2>&1 | grep -v warning', { timeout: 600000 });
  if (!existsSync(join(dir, 'd3d9ref.exe.so'))) { console.log(`d3d9ref did not build:\n${b.stdout}${b.stderr}`); process.exit(1); }
  sh('[ -e /tmp/.X7-lock ] || { Xvfb :7 -screen 0 640x480x24 >/dev/null 2>&1 & sleep 2; }');
  const golden = { _doc: ['Wine 8.0 d3d9 (wined3d on Mesa llvmpipe) assembling and drawing the gate-d3d9-asm cases through',
    'tools/oracle/d3d9ref.c. Each case: the bytecode D3DXAssembleShader produced (DWORDs) and the 8x8 back buffer,',
    'row 0 (the top) first, R, G, B bytes. Written by node tools/gate-d3d9-asm.mjs --capture-wine.'], cases: {} };
  const words = (f) => { const b = readFileSync(f); return Array.from(new Uint32Array(b.buffer, b.byteOffset, b.length >> 2)); };
  for (const [i, k] of cases.entries()) {
    const ps = `a${i}.asm`, vs = `a${i}-vs.asm`;
    writeFileSync(join(dir, ps), k.ps);
    if (k.vs) writeFileSync(join(dir, vs), k.vs);
    const flags = `-dump ${k.texture ? '-tex ' : ''}${k.vs ? `-vs ${vs} ` : ''}`;
    // through `| cat`: with its output straight on docker exec's pipe, wine returns 0 and the program writes nothing (measured)
    const r = sh(`cd /work/wine && rm -f a${i}.rgb && DISPLAY=:7 WINEDEBUG=-all WINEDLLOVERRIDES=mscoree,mshtml= wine ./d3d9ref.exe ${flags}${ps} a${i}.rgb ${N} ${N} ${(k.consts ?? []).join(' ')} 2>&1 | cat`, { timeout: 600000 });
    if (!existsSync(join(dir, `a${i}.rgb`))) { check(false, `Wine drew: ${k.name}`, r.stdout.slice(-600)); continue; }
    golden.cases[k.name] = { ps: words(join(dir, `${ps}.bin`)), ...(k.vs ? { vs: words(join(dir, `${vs}.bin`)) } : {}), ...(k.notWine ? {} : { pixels: Array.from(readFileSync(join(dir, `a${i}.rgb`))) }) };
    console.log(`  captured  ${k.name}`);
  }
  writeFileSync(GOLDEN, JSON.stringify(golden) + '\n');
  console.log(`wrote ${GOLDEN}\n`);
}

const CHROME = process.env.PRISM_CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!CHROME) skip('no Chrome for the WebGL2 part', 'install Google Chrome, or PRISM_CHROME=<path to a Chrome or Chromium>');
if (!existsSync(GOLDEN)) { console.log('no capture: node tools/gate-d3d9-asm.mjs --capture-wine'); process.exit(1); }
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).cases;

const page = `<!doctype html><canvas id="c" width="${N}" height="${N}"></canvas><pre id="o"></pre>
<script type="module">
import { createD3D9 } from '/src/env/d3d9.js';
const cases = ${JSON.stringify(cases.map((k) => ({ name: k.name, texture: !!k.texture, consts: k.consts, ps: golden[k.name]?.ps, vs: golden[k.name]?.vs })))};
const out = {};
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
const d3d = createD3D9({ gl });
const dev = d3d.createDevice({ width: ${N}, height: ${N}, backBufferFormat: 22, backBufferCount: 1, autoDepthStencilFormat: 0, windowed: 1, presentInterval: 0 });
// a full-screen quad: pretransformed, pixel centres at integer coordinates; or in clip space for a vertex shader, clockwise
const quad = new Uint8Array(new Float32Array([-.5, -.5, 0, 1, 0, 0, ${N - 0.5}, -.5, 0, 1, 1, 0, -.5, ${N - 0.5}, 0, 1, 0, 1, ${N - 0.5}, ${N - 0.5}, 0, 1, 1, 1]).buffer);
const clip = new Uint8Array(new Float32Array([-1, 1, .5, 1, 1, .5, -1, -1, .5, 1, -1, .5]).buffer);
const tex = [0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255];
for (const k of cases) {
  try {
    if (!k.ps) throw new Error('not captured');
    dev.beginScene();
    dev.clear(null, 1, 0xffff00ff, 1, 0);
    if (k.consts) dev.setPixelShaderConstantF(0, new Float32Array(k.consts));
    if (k.texture) { const t = dev.createTexture(2, 2, 1, 0, 21); dev.textureWrite(t, 0, null, new Uint8Array(tex), 8); dev.setTexture(0, t); }
    dev.setPixelShader(dev.createPixelShader(new Uint32Array(k.ps)));
    if (k.vs) { dev.setVertexShader(dev.createVertexShader(new Uint32Array(k.vs))); dev.setFVF(2); dev.drawPrimitiveUP(5, 2, clip, 12); dev.setVertexShader(0); }
    else { dev.setFVF(0x104); dev.drawPrimitiveUP(5, 2, quad, 24); }
    dev.endScene();
    dev.present();
    const px = new Uint8Array(${N * N * 4});
    gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out[k.name] = { pixels: Array.from(px) };
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
for (const k of cases) {
  const r = res[k.name];
  const wine = k.notWine ? (golden[k.name] && Array.from({ length: N * N }, (_, i) => k.want(i % N, (i / N) | 0)).flat().map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255))) : golden[k.name]?.pixels;
  if (!wine) { check(false, k.name, 'no capture: node tools/gate-d3d9-asm.mjs --capture-wine'); continue; }
  if (!r || r.error) { check(false, k.name, r ? r.error : 'not run'); continue; }
  const got = [];   // the canvas read back bottom row first; the capture is top row first
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const o = ((N - 1 - y) * N + x) * 4; got.push(r.pixels[o], r.pixels[o + 1], r.pixels[o + 2]); }
  const { worst, at } = rgbOff(got, wine), p0 = at - (at % 3);
  if (worst > 1 && process.argv.includes('--verbose')) for (const [what, img] of [['PRISM', got], [k.notWine ? 'want ' : 'Wine ', wine]]) for (let y = 0; y < N; y++) console.log(`        ${y ? '     ' : what} ${Array.from({ length: N }, (_, x) => img.slice((y * N + x) * 3, (y * N + x) * 3 + 3).map((v) => v.toString(16).padStart(2, '0')).join('')).join(' ')}`);
  check(worst <= 1, `${k.name}${k.notWine ? ` (held to worked-out values: Wine 8.0 ${k.notWine})` : ''}`, `off by ${worst} at (${(at / 3 | 0) % N},${(at / 3 / N) | 0}) got ${got.slice(p0, p0 + 3)} ${k.notWine ? 'want' : 'Wine'} ${wine.slice(p0, p0 + 3)}`);
}
console.log(bad ? `\n${bad} check(s) failed.` : '\nShader bytecode draws on the Direct3D 9 device what Wine draws with it.');
process.exit(bad ? 1 : 0);
