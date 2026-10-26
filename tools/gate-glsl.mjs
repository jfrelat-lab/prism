// gate-glsl.mjs — GLSL through gl.js: desktop shaders as the OpenGL 2.0 programs of 2007-2010 wrote
// them, drawn by the WebGL rasteriser, read back, and held to what the GLSL specification makes of them.
//
// src/env/glsl.js rewrites a desktop fragment shader (GLSL 1.10/1.20, the compatibility built-ins, and
// the desktop drivers' leniency: an integer where a float is wanted, a global initialised from
// gl_FragCoord) as GLSL ES 3.00 for WebGL2. Two parts:
//   - THE TRANSLATION, in Node: each idiom comes out in the form GLSL ES takes.
//   - THE PICTURE, in a headless Chrome (WebGL2 on SwiftShader, so the same everywhere): every case is
//     drawn through gl.js's own entry points -- glCreateShader ... glUseProgram, glUniform, glRecti --
//     on installGL's WebGL rasteriser, as a program built by PRISM calls them, and the pixels read back
//     must be the values the shader computes, worked out here exactly (within one step of 255 for the
//     rounding to 8 bits). WebGL's compiler is the reference for what GLSL ES accepts: ANGLE's.
// The CONTROL: each case's desktop source, given to WebGL as it is, must be refused -- the translation
// is what makes it drawable, and a translation that changed nothing would not pass.
// The shaders are this gate's own, written for it in the style of the 1K intros of 2009.
//
//   node tools/gate-glsl.mjs          SKIP when no Chrome is found (PRISM_CHROME=<path> names one)
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { translateFragment, translateVertex } from '../src/env/glsl.js';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let bad = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${ok ? '' : `\n        ${detail}`}`); if (!ok) bad++; };

// ---- the translation ----------------------------------------------------------------------------
const T = (src) => translateFragment(src).source.replace(/^[\s\S]*?out vec4 prism_FragColor;\n/, '');
const idioms = [
  ['gl_FragColor and gl_Color become the stage\'s own names', 'void main(){gl_FragColor=gl_Color;}', 'void main(){prism_FragColor=prism_Color;}'],
  ['an integer where a float is wanted becomes a float', 'void main(){gl_FragColor=vec4(cos(gl_FragCoord.x*3)/2);}', 'void main(){prism_FragColor=vec4(cos(gl_FragCoord.x*3.0)/2.0);}'],
  ['a loop counter keeps its integers', 'void main(){float t=0.;for(int i=0;i<75;i++)t+=1.;gl_FragColor=vec4(t);}', 'void main(){float t=0.;for(int i=0;i<75;i++)t+=1.;prism_FragColor=vec4(t);}'],
  ['an index keeps its integer', 'uniform float k[4];void main(){gl_FragColor=vec4(k[2]);}', 'uniform float k[4];void main(){prism_FragColor=vec4(k[2]);}'],
  ['an int variable in a float expression is converted', 'void main(){int c=0;while(c<3)c++;gl_FragColor=vec4(1)*c/3.0;}', 'void main(){int c=0;while(c<3)c++;prism_FragColor=vec4(1.0)*float(c)/3.0;}'],
  ['a global initialised from gl_FragCoord is initialised in main', 'vec2 v=gl_FragCoord.xy/vec2(64,48);void main(){gl_FragColor=vec4(v,0,1);}',
    'vec2 v;void main(){v=gl_FragCoord.xy/vec2(64.0,48.0);prism_FragColor=vec4(v,0.0,1.0);}'],
  ['a constant global stays where it is', 'const float s=0.4;void main(){gl_FragColor=vec4(s);}', 'const float s=0.4;void main(){prism_FragColor=vec4(s);}'],
  ['texture2D and gl_TexCoord[0], varying', 'uniform sampler2D t;varying vec2 q;void main(){gl_FragData[0]=texture2D(t,gl_TexCoord[0].xy);}',
    'uniform sampler2D t;in vec2 q;void main(){prism_FragColor=texture(t,prism_TexCoord0.xy);}'],
];
for (const [what, src, want] of idioms) { const got = T(src); check(got === want, `translate: ${what}`, `got  ${got}\n        want ${want}`); }
// A vertex shader: its body as main became prism_main, between the declarations and the wrapper.
const TV = (src) => translateVertex(src).source.replace(/^[\s\S]*?vec4 prism_discard;\n(?:uniform [^\n]*\n)*/, '').replace(/\nvoid main\(\) \{[^\n]*\n$/, '');
const vidioms = [
  ['the vertex as given, a varying out', 'varying vec4 v;void main(){gl_Position=v=gl_Vertex;}', 'out vec4 v;void prism_main(){gl_Position=v=prism_Vertex;}'],
  ['ftransform, gl_Normal, gl_FrontColor and gl_TexCoord[0], with an integer where a float is wanted',
    'void main(){gl_Position=ftransform();gl_FrontColor=vec4(gl_Normal*.5+.5,1);gl_TexCoord[0]=gl_MultiTexCoord0*2;}',
    'void prism_main(){gl_Position=(prism_ModelViewProjectionMatrix * prism_Vertex);prism_Color=vec4(prism_Normal*.5+.5,1.0);prism_TexCoord0=prism_MultiTexCoord0*2.0;}'],
  ['attribute, a built-in matrix, an output no stage reads', 'attribute float a;void main(){gl_Position=gl_ProjectionMatrix*gl_Vertex;gl_BackColor=vec4(a);}',
    'in float a;void prism_main(){gl_Position=prism_ProjectionMatrix*prism_Vertex;prism_discard=vec4(a);}'],
];
for (const [what, src, want] of vidioms) { const got = TV(src); check(got === want, `translate (vertex): ${what}`, `got  ${got}\n        want ${want}`); }
check(translateFragment('void main(){gl_FragColor=gl_ModelViewMatrixInverse[3];}').source.includes('uniform mat4 prism_ModelViewMatrixInverse;'),
  'translate: a built-in matrix read by a fragment shader is a uniform it declares');

// ---- the picture ------------------------------------------------------------------------------
const CHROME = process.env.PRISM_CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!CHROME) { if (bad) process.exit(1); skip('no Chrome for the WebGL2 part', 'install Google Chrome, or PRISM_CHROME=<path to a Chrome or Chromium>'); }

const W = 64, H = 48;
// Each case: a desktop fragment shader, what the program does around it (in gl.js's entry points), and
// the colour the specification gives at window pixel (x, y) -- its centre is (x + .5, y + .5).
const cases = [
  { name: 'gl_FragCoord with integer literals', src: 'void main(){gl_FragColor=vec4(gl_FragCoord.x/64,gl_FragCoord.y/48,0.5,1);}',
    want: (x, y) => [(x + 0.5) / W, (y + 0.5) / H, 0.5, 1] },
  { name: 'the time through gl_Color, as the 1K intros pass it', src: 'float w=dot(gl_Color.xyz,vec3(1,256,65536))*.25;void main(){gl_FragColor=vec4(fract(w),w/4.,0,1);}',
    colour: [3, 0, 0, 255], want: () => { const w = (3 / 255) * 0.25; return [w - Math.floor(w), w / 4, 0, 1]; } },
  { name: 'a global from gl_FragCoord, an int loop, an int counter in a float', src:
    'vec2 v=gl_FragCoord.xy/vec2(64,48);void main(){int n=0;for(int i=0;i<10;i++)n+=i;float s=0.;int c=0;while(c<4){s+=.25;c++;}gl_FragColor=vec4(v.x,n/90.0,s*c/8,1);}',
    want: (x) => [(x + 0.5) / W, 0.5, 0.5, 1] },
  { name: 'a uniform set with glUniform1f, a constant global', src: 'uniform float k;const float h=0.25;void main(){gl_FragColor=vec4(k,h,k*2,1);}',
    uniforms: [['k', 0.375]], want: () => [0.375, 0.25, 0.75, 1] },
  // A vertex shader. The matrices are a window-sized glOrtho and a modelview that puts glRecti(-1, -1, 1, 1)
  // behind the near plane, so the fixed function would draw nothing of it (Retrospection's gluLookAt does
  // the same to its glRects): a shader that places the vertex as given covers the window.
  { name: 'a vertex shader placing the vertex as given, its varying read by the fragment shader (Retrospection 2009)',
    vs: 'varying vec4 v;void main(){gl_Position=v=gl_Vertex;}', src: 'varying vec4 v;void main(){gl_FragColor=vec4(v.xy*.5+.5,0,1);}',
    rect: [-1, -1, 1, 1], translate: [0, 0, 5], want: (x, y) => [(x + 0.5) / W, (y + 0.5) / H, 0, 1] },
  { name: 'ftransform, gl_Normal and gl_Color in a vertex shader, gl_FrontColor out',
    vs: 'void main(){gl_Position=ftransform();gl_FrontColor=vec4(gl_Normal.xy,gl_Color.b,1);}', src: 'void main(){gl_FragColor=gl_Color;}',
    normal: [0.25, 0.5, 0], colour: [0, 0, 191, 255], want: () => [0.25, 0.5, 191 / 255, 1] },
  { name: 'a built-in matrix in a fragment shader: gl_ModelViewMatrixInverse',
    src: 'void main(){gl_FragColor=vec4(gl_ModelViewMatrixInverse[3].xyz,1);}', translate: [-0.25, -0.5, -0.125], want: () => [0.25, 0.5, 0.125, 1] },
  { name: 'a back face culled under a vertex shader',
    vs: 'void main(){gl_Position=gl_Vertex;}', src: 'void main(){gl_FragColor=vec4(1);}', cull: true, raw: false, rect: [1, -1, -1, 1], want: () => [0, 0, 0, 0] },
];

// The page: gl.js on a flat memory, as PRISM's runtime gives it, each case drawn and read back.
const page = `<!doctype html><pre id=o>running</pre><script type=module>
import { installGL } from '/src/env/gl.js';
const CASES = ${JSON.stringify(cases.map(({ name, src, vs, colour, uniforms, rect, normal, translate, cull }) => ({ name, src, vs, colour, uniforms, rect, normal, translate, cull })))};
const out = {};
const raw = (src) => { const c = new OffscreenCanvas(4, 4).getContext('webgl2'), s = c.createShader(c.FRAGMENT_SHADER); c.shaderSource(s, src); c.compileShader(s); return !!c.getShaderParameter(s, c.COMPILE_STATUS); };
for (const k of CASES) {
  try {
    const u8 = new Uint8Array(1 << 20), dv = new DataView(u8.buffer);
    let heap = 4096;
    const put = (s) => { const p = heap; u8.set(new TextEncoder().encode(s), p); u8[p + s.length] = 0; heap += s.length + 1; return p; };
    const cstr = (p) => { let s = ''; while (u8[p]) s += String.fromCharCode(u8[p++]); return s; };
    const M = { u8, rt: {}, cstr, mod: { dv, cstr, intern: (b) => { const p = heap; u8.set(b, p); heap += b.length; return p; } } };
    const gl = installGL(M, { backend: 'webgl' }), G = M.rt;
    gl.resize(${W}, ${H});
    G.glViewport(0, 0, ${W}, ${H}); G.glMatrixMode(0x1701); G.glLoadIdentity(); G.glOrtho(0, ${W}, 0, ${H}, -1, 1); G.glMatrixMode(0x1700); G.glLoadIdentity();
    if (k.translate) G.glTranslatef(...k.translate);
    const compile = (type, src) => { const sh = G.glCreateShader(type), strs = heap; heap += 4; dv.setUint32(strs, put(src), true); G.glShaderSource(sh, 1, strs, 0); G.glCompileShader(sh); return sh; };
    const pr = G.glCreateProgram(); G.glAttachShader(pr, compile(0x8b30, k.src));
    if (k.vs) G.glAttachShader(pr, compile(0x8b31, k.vs));
    G.glLinkProgram(pr); G.glUseProgram(pr);
    if (k.normal) G.glNormal3f(...k.normal);
    if (k.cull) G.glEnable(0x0b44);
    for (const [n, v] of k.uniforms || []) G.glUniform1f(G.glGetUniformLocation(pr, put(n)), v);
    const c = k.colour || [255, 255, 255, 255], cp = heap; heap += 4; u8.set(c, cp); G.glColor4ubv(cp);
    G.glRecti(...(k.rect || [0, 0, ${W}, ${H}]));
    out[k.name] = { pixels: Array.from(gl.readPixels()), raw: raw(k.src) };
  } catch (e) { out[k.name] = { error: String(e.message || e) }; }
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
  if (!r || r.error) { check(false, `draw: ${k.name}`, r ? r.error : 'not run'); continue; }
  // readPixels is top row first: window row y is picture row H - 1 - y
  let worst = 0, at = '';
  for (let y = 0; y < H; y += 7) for (let x = 0; x < W; x += 5) {
    const want = k.want(x, y).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)), o = ((H - 1 - y) * W + x) * 4;
    for (let c = 0; c < 4; c++) { const d = Math.abs(r.pixels[o + c] - want[c]); if (d > worst) { worst = d; at = `(${x},${y}) got ${r.pixels.slice(o, o + 4)} want ${want}`; } }
  }
  check(worst <= 1, `draw: ${k.name}`, `off by ${worst} at ${at}`);
  if (k.raw !== false) check(!r.raw, `control: ${k.name} -- the desktop source as it is is refused by WebGL`, 'WebGL compiled the untranslated desktop shader');
}
process.exit(bad ? 1 : 0);
