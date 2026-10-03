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
      if (p === 'drawArrays') rec.draws++;
      const args = a.map((v) => {
        if (v && typeof v === 'object' && ArrayBuffer.isView(v)) {
          if (p !== 'readPixels') rec.h.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
          return `[${v.byteLength}]`;
        }
        if (v && typeof v === 'object') return `#${rec.ids.get(v)}`;
        return String(v);
      });
      rec.h.update(`${p}(${args.join(',')})\n`);
      if (p === 'getShaderParameter' || p === 'getProgramParameter') return true;
      if (/^(create|getUniformLocation)/.test(p)) { const o = {}; rec.ids.set(o, rec.ids.size + 1); return o; }
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
  rec = { h: createHash('sha256'), calls: 0, draws: 0, ids: new WeakMap() };
  c.run(control);
  return { calls: rec.calls, draws: rec.draws, sha: rec.h.digest('hex') };
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
  report(got.sha === g.sha, `${c.name}: the blessed stream`, `${got.calls} calls, ${got.draws} draws (blessed: ${g.calls}, ${g.draws})`);
  const [what, control] = c.control, m = stream(c, control);
  report(m.sha !== g.sha, `${c.name}: control: ${what} changes it`, `${m.calls} calls, ${m.draws} draws`);
}
if (!Q3) console.log('  (quake3 not run: set PRISM_QUAKE3_DATA to a directory with baseq3/)');
if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log(`\nthe WebGL path issues the blessed stream for ${CASES.length} programs.`);
