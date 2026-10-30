// gate-webgl-stream.mjs — the WebGL2 path of src/env/gl.js issues the same commands it was blessed with.
//
// The page draws OpenGL through WebGL2 (makeWebGL), which no other gate runs: Node has no WebGL, so the
// pixel gates all use the soft rasteriser. This one gives gl.js a recording WebGL2 context and hashes
// everything it is told -- every call with its arguments, every buffer and texture upload byte for
// byte -- over whole programs, against goldens/webgl-stream.json. Its job is to hold the page's
// renderer to a known stream while the front end around it is made faster: batching, state caching
// and vertex fetch may change how the commands are COMPUTED, never which commands come out.
//
// A changed stream is not necessarily a wrong picture -- a deliberate change to the WebGL path is
// re-captured (--capture), after looking at it in the page. Each case carries a control: a GL call
// the program makes, dropped, which must change the stream (state-only calls, the kind a stale state
// cache would lose).
//
// Beside the stream, the EFFECTIVE STATE at every draw: the calls are replayed through a model of the
// WebGL state that matters to a draw or a clear -- capabilities, test, blend and mask functions,
// viewport and scissor, framebuffer, program and its uniforms, the bound textures with their
// parameters and contents, the vertex data -- and each draw and clear hashes it. Sending less (a
// state the batch already has) changes the stream and must not change this; the controls change both.
//
//   node tools/gate-webgl-stream.mjs [--capture]
//   PRISM_QUAKE3_DATA=<dir with baseq3/> ...   also Quake III in q3dm1 (the reason this gate exists)
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadTarget, buildTarget } from '../src/target.js';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'webgl-stream.json');
const CAPTURE = process.argv.includes('--capture');
const Q3 = process.env.PRISM_QUAKE3_DATA;

/** The WebGL state a draw or a clear depends on, as the recorded calls leave it. */
const model = () => ({ caps: new Set(), set: {}, program: '', fb: '', vao: '', unit: 0, units: {}, params: {}, contents: {}, uniforms: {}, buffer: '', store: {},
  bound: {}, buffers: {}, attribs: {} });
const STATE_SETTERS = new Set(['blendFunc', 'depthFunc', 'depthMask', 'depthRange', 'scissor', 'colorMask', 'polygonOffset', 'stencilFunc',
  'stencilOp', 'stencilMask', 'viewport', 'clearColor', 'clearDepth', 'clearStencil', 'frontFace', 'cullFace']);
function track(m, p, a, id, bytes) {
  if (p === 'enable') m.caps.add(a[0]);
  else if (p === 'disable') m.caps.delete(a[0]);
  else if (STATE_SETTERS.has(p)) m.set[p] = a.map(String).join(',');
  else if (p === 'useProgram') m.program = id(a[0]);
  else if (p === 'bindFramebuffer') m.fb = id(a[1]);
  else if (p === 'bindVertexArray') m.vao = id(a[0]);
  else if (p === 'activeTexture') m.unit = a[0];
  else if (p === 'bindTexture') m.units[m.unit] = id(a[1]);
  else if (p === 'texParameteri') { const t = m.units[m.unit]; (m.params[t] ??= {})[a[1]] = a[2]; }
  else if (p === 'pixelStorei') m.store[a[0]] = a[1];
  else if (p === 'texImage2D' || p === 'texSubImage2D') {
    const t = m.units[m.unit];
    m.contents[t] = createHash('sha256').update(`${m.contents[t] ?? ''}${p}(${a.filter((v) => !ArrayBuffer.isView(v)).map(String)})${JSON.stringify(m.store)}`).update(bytes).digest('hex');
  } else if (/^uniform/.test(p)) m.uniforms[id(a[0])] = a.slice(1).map(String).join(',');
  else if (p === 'bufferData') {
    // A draw's vertices and, for an indexed one, its indices: each buffer's contents by the buffer.
    m.buffer = createHash('sha256').update(bytes).digest('hex');
    m.buffers[m.bound[a[0]] ?? a[0]] = m.buffer;
  } else if (p === 'bindBuffer') m.bound[a[0]] = id(a[1]);
  // The vertex attributes, per vertex array object: where each reads (the array buffer bound when its
  // pointer was set), whether it is on, and the constant an attribute that is off reads.
  else if (p === 'vertexAttribPointer') m.attribs[`${m.vao}:${a[0]}:ptr`] = `${a.map(String)}@${m.bound[fnvArray] ?? ''}`;
  else if (p === 'enableVertexAttribArray' || p === 'disableVertexAttribArray') m.attribs[`${m.vao}:${a[0]}:on`] = p[0] === 'e';
  else if (p === 'vertexAttrib4f') m.attribs[`const:${a[0]}`] = a.slice(1).map(String).join(',');
  else return false;
  return true;
}
const fnvArray = String((() => { let x = 0x811c9dc5; for (const ch of 'ARRAY_BUFFER') x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0; return x; })());
const snapshot = (m, p, a) => JSON.stringify({
  call: `${p}(${a.map(String)})`, caps: [...m.caps].sort(), set: m.set, program: m.program, fb: m.fb, vao: m.vao, buffer: m.buffer,
  textures: Object.entries(m.units).sort().map(([u, t]) => [u, t, m.params[t] ?? {}, m.contents[t] ?? '']),
  uniforms: Object.entries(m.uniforms).sort(),
  buffers: Object.entries(m.buffers).sort(), attribs: Object.entries(m.attribs).sort(),
});

// A WebGL2 context that does nothing but remember. Constants are numbers derived from their names,
// so the stream does not depend on the order gl.js first reads them.
let rec = null;
const fnv = (s) => { let x = 0x811c9dc5; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193) >>> 0; return x; };
const context = new Proxy({}, {
  get(_t, p) {
    if (typeof p !== 'string') return undefined;
    if (/^[A-Z0-9_]+$/.test(p)) return fnv(p);
    return (...a) => {
      rec.calls++;
      if (p === 'drawArrays' || p === 'drawElements') rec.draws++;
      const args = a.map((v) => {
        if (v && typeof v === 'object' && ArrayBuffer.isView(v)) {
          if (p !== 'readPixels') rec.h.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
          return `[${v.byteLength}]`;
        }
        if (v && typeof v === 'object') return `#${rec.ids.get(v)}`;
        return String(v);
      });
      rec.h.update(`${p}(${args.join(',')})\n`);
      const view = a.find((v) => v && typeof v === 'object' && ArrayBuffer.isView(v));
      const bytes = view ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : new Uint8Array(0);
      const id = (o) => (o ? `#${rec.ids.get(o)}` : 'null');
      if (p === 'drawArrays' || p === 'drawElements' || p === 'clear') rec.d.update(snapshot(rec.m, p, a));
      else track(rec.m, p, a, id, bytes);
      // What the reversed-depth-range check below reads: the ranges asked of WebGL, and the shader's
      // z-flip switch.
      if (p === 'depthRange') rec.ranges.push([a[0], a[1]]);
      if (p === 'uniform1i' && a[0] === rec.zFlip) rec.flips.push(a[1]);
      if (p === 'getShaderParameter' || p === 'getProgramParameter') return true;
      if (/^(create|getUniformLocation)/.test(p)) {
        const o = {};
        rec.ids.set(o, ++rec.objects);   // (a WeakMap has no size: every object was #NaN, one texture as good as another)
        if (p === 'getUniformLocation' && a[1] === 'zFlip') rec.zFlip = o;
        return o;
      }
      return undefined;
    };
  },
});
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context; } };

// Point the link-time bindings of what a control replaced at the replacement (as gate-mesa-demos does).
function mutate(program, control) {
  if (!control) return;
  const before = { ...program.M.rt };
  control(program.M);
  for (const [name] of program.mod.funcs) {
    const base = name.slice(name.lastIndexOf('$') + 1);
    if (program.M.rt[base] !== before[base]) program.mod.bindFunc(name, program.M.rt[base]);
  }
}
const drop = (name, when = () => true) => (M) => { const f = M.rt[name]; M.rt[name] = (...a) => (when(...a) ? undefined : f(...a)); };

function glut(target, frames, version) {
  return (control) => {
    const gl = { backend: 'webgl', ...(version ? { version: `${version} PRISM` } : {}) };
    const { program } = buildTarget(loadTarget(join(ROOT, 'targets', `${target}.json`)), { root: ROOT,
      envExtra: { gl, glut: { frames, onFrame: () => {} } } });
    program.M.write = () => {};
    mutate(program, control);
    program.run([target]);
  };
}
function quake3(swaps) {
  return (control) => {
    const files = {};
    (function walk(d, pre = '') {
      for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`); else files[pre + f] = new Uint8Array(readFileSync(p)); }
    })(Q3);
    const target = loadTarget(join(ROOT, 'targets', 'quake3.json'));
    const { program } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files }, gl: { backend: 'webgl' },
      glx: { onSwap: (n) => { if (n >= swaps) throw new Error('__done'); } } } });
    program.M.write = () => {};
    let now = 0;   // 16 ms a call, so the run is the same run every time
    const ms = () => (now += 16);
    program.F.Sys_Milliseconds = ms; program.mod.bindFunc('Sys_Milliseconds', ms);
    mutate(program, control);
    const args = (target.args ?? '').split(/\s+/).filter(Boolean);
    try { program.run(['quake3', ...args, '+set', 'com_introplayed', '1', '+map', 'q3dm1']); } catch (e) { if (e.message !== '__done') throw e; }
  };
}

const CASES = [
  { name: 'gears', run: glut('gears', [0, 25, 50]), control: ['glShadeModel dropped', drop('glShadeModel')] },
  { name: 'morph3d', run: glut('morph3d', [5, 60, 195]), control: ['glEnable(GL_DEPTH_TEST) dropped', drop('glEnable', (c) => c === 0x0b71)] },
  { name: 'texobj (texture objects)', run: glut('texobj', [0, 25, 50], '1.1'),
    control: ['glBindTexture dropped once init() is done', (M) => { const b = M.rt.glBindTexture; let n = 0; M.rt.glBindTexture = (t, id) => (++n <= 2 ? b(t, id) : undefined); }] },
  { name: 'texobj (display lists)', run: glut('texobj', [0, 25, 50], '2.1'), control: ['glCallList dropped', drop('glCallList')] },
];
// In play from swap 0 to 300: the map loads around swap 30. glDepthMask is the sky's and the
// transparent surfaces' -- state only, between two draws.
if (Q3) CASES.push({ name: 'quake3 q3dm1', run: quake3(300), control: ['glDepthMask dropped', drop('glDepthMask')] });

const stream = (c, control = null) => {
  rec = { h: createHash('sha256'), d: createHash('sha256'), m: model(), calls: 0, draws: 0, ids: new WeakMap(), objects: 0, ranges: [], flips: [], zFlip: null };
  c.run(control);
  return { calls: rec.calls, draws: rec.draws, sha: rec.h.digest('hex'), state: rec.d.digest('hex'), ranges: rec.ranges, flips: rec.flips };
};

if (CAPTURE) {
  const out = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {};
  for (const c of CASES) { out[c.name] = stream(c); console.log(`${c.name}: ${out[c.name].calls} calls, ${out[c.name].draws} draws`); }
  writeFileSync(GOLDEN, JSON.stringify(out, null, 2) + '\n');
  console.log(`captured ${CASES.length} cases -> goldens/webgl-stream.json`);
  process.exit(0);
}
if (!existsSync(GOLDEN)) { console.error('no goldens/webgl-stream.json: run with --capture first'); process.exit(2); }
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
for (const c of CASES) if (!golden[c.name]) skip(`no golden for ${c.name}`, 'run with --capture');

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(58)} ${detail}`); };
for (const c of CASES) {
  const g = golden[c.name], got = stream(c);
  report(got.state === g.state, `${c.name}: the blessed state at every draw and clear`, `${got.draws} draws`);
  report(got.sha === g.sha, `${c.name}: the blessed stream`, `${got.calls} calls, ${got.draws} draws (blessed: ${g.calls}, ${g.draws})`);
  const [what, control] = c.control, m = stream(c, control);
  report(m.sha !== g.sha && m.state !== g.state, `${c.name}: control: ${what} changes both`, `${m.calls} calls, ${m.draws} draws`);
}
/*
 * A REVERSED DEPTH RANGE never reaches WebGL reversed. GL 1.1 lets near exceed far, and GLQuake's
 * family draws every other frame that way (gl_ztrick); WebGL answers INVALID_OPERATION and keeps
 * the previous range, which made Hexen II flicker. gl.js hands WebGL the ordered range and negates
 * z in the vertex shader instead. tests/gl/ztrick.c draws four such frames: no range may arrive
 * with near above far, and the shader's switch must go on and off with the frames.
 */
{
  const ztrick = { name: 'ztrick', run: () => {
    const target = { name: 'ztrick', dir: 'tests/gl', units: { list: ['ztrick.c'] }, env: ['stdio', 'gl', 'glu', 'glut'], compile: { memory: 16 } };
    const { program } = buildTarget(target, { root: ROOT, envExtra: { gl: { backend: 'webgl' }, glut: { frames: [3], onFrame: () => {} } } });
    program.M.write = () => {};
    program.run(['ztrick']);
  } };
  const got = stream(ztrick);
  const reversed = got.ranges.filter(([n, f]) => n > f).length;
  report(got.ranges.length > 0 && reversed === 0, 'ztrick: no depth range reaches WebGL with near above far', `${got.ranges.length} ranges, ${reversed} reversed`);
  report(got.flips.includes(1) && got.flips.includes(0), 'ztrick: the shader negates z for the reversed frames only', `switch written ${JSON.stringify(got.flips)}`);
}
if (!Q3) console.log('  (quake3 not run: set PRISM_QUAKE3_DATA to a directory with baseq3/)');
if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log(`\nthe WebGL path issues the blessed stream for ${CASES.length} programs.`);
