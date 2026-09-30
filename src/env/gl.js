// gl.js — OpenGL 1.1's fixed-function pipeline, answered in JavaScript: state, and a rasteriser.
//
// A library boundary, like SDL or Allegro here: the program's GL calls arrive at this file, and the
// PICTURE they describe comes out of it. Two outputs share one state machine. Headless, this file
// rasterises the triangles itself into an RGBA framebuffer, so a gate can hold the result to Mesa
// (tools/gate-gears.mjs); in the page a WebGL backend can draw the same assembled triangles.
//
// What is implemented is what the specification says for the parts a program has called, and no
// more (headers-gl.js declares exactly this set):
//   - matrices: MODELVIEW and PROJECTION stacks; Translate, Rotate, Scale, Frustum, Ortho.
//   - immediate mode: Begin/End with Vertex, Normal, Color; every GL 1.1 polygon primitive,
//     assembled into triangles (quads and polygons as fans from their first vertex).
//   - display lists: GL_COMPILE records the commands (with their array arguments COPIED, as the
//     spec requires); CallList replays them. GenLists/NewList/EndList/DeleteLists run at once.
//   - lighting: per vertex, in eye space -- emission + scene ambient * ambient + for each enabled
//     light (ambient + max(N.L,0) diffuse + specular) -- with a light's position taken through the
//     modelview matrix current when it is set, normals through its inverse transpose, NORMALIZE.
//     Directional lights only (w = 0) and an infinite viewer, which is GL's default.
//   - shading: SMOOTH interpolates colour perspective-correctly; FLAT takes the provoking vertex's
//     (the last of a triangle or quad, the first of a polygon).
//   - rasterisation: pixel centres, the top-left fill rule, CULL_FACE by window-space winding
//     (FrontFace CCW, CullFace BACK by default), DEPTH_TEST LESS with window z linear in screen space.
// NOT implemented, and refused rather than approximated: clipping against the view volume (a
// triangle with a vertex at or behind the eye is dropped and counted), textures, blending, lines and
// points.

const MODELVIEW = 0x1700, PROJECTION = 0x1701;
const CAP = { CULL_FACE: 0x0b44, LIGHTING: 0x0b50, DEPTH_TEST: 0x0b71, NORMALIZE: 0x0ba1, LIGHT0: 0x4000 };
const FLAT = 0x1d00, CCW = 0x0901, BACK = 0x0405, FRONT = 0x0404, FRONT_AND_BACK = 0x0408;
const PNAME = { AMBIENT: 0x1200, DIFFUSE: 0x1201, SPECULAR: 0x1202, POSITION: 0x1203, EMISSION: 0x1600, SHININESS: 0x1601, AMBIENT_AND_DIFFUSE: 0x1602 };
const COMPILE_AND_EXECUTE = 0x1301;

const ident = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function mul(a, b) {                        // column-major a * b
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
    r[c * 4 + row] = s;
  }
  return r;
}
const xform = (m, x, y, z, w) => [
  m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w,
  m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w];
/** The inverse transpose of m's upper 3x3, as a 9-array (row-major), for normals. */
function normalMatrix(m) {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C || 1;
  // inverse = adj^T / det; its transpose = cofactor matrix / det
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export function installGL(M, { onFrame = null, backend = 'soft' } = {}) {
  let webgl = null;                         // the WebGL2 rasteriser when backend is 'webgl' (makeWebGL)
  const dv = () => M.mod.dv;
  const f32 = (p, n) => Array.from({ length: n }, (_, k) => dv().getFloat32(p + 4 * k, true));
  const light = () => ({ enabled: false, ambient: [0, 0, 0, 1], diffuse: [0, 0, 0, 1], specular: [0, 0, 0, 1], position: [0, 0, 1, 0] });
  const s = {
    width: 0, height: 0, color: null, depth: null,
    viewport: [0, 0, 0, 0], clear: [0, 0, 0, 0],
    mode: MODELVIEW, stacks: { [MODELVIEW]: [ident()], [PROJECTION]: [ident()] },
    caps: new Set(), shade: 0x1d01, frontFace: CCW, cullFace: BACK,
    normal: [0, 0, 1], colour: [1, 1, 1, 1],
    material: { ambient: [0.2, 0.2, 0.2, 1], diffuse: [0.8, 0.8, 0.8, 1], specular: [0, 0, 0, 1], emission: [0, 0, 0, 1], shininess: 0 },
    sceneAmbient: [0.2, 0.2, 0.2, 1],
    lights: Array.from({ length: 8 }, (_, k) => {
      const l = light();
      if (k === 0) { l.diffuse = [1, 1, 1, 1]; l.specular = [1, 1, 1, 1]; }
      return l;
    }),
    prim: null, verts: [],
    lists: new Map(), nextList: 1, recording: null, recordMode: 0,
    stats: { triangles: 0, culled: 0, behindEye: 0, fragments: 0 },
    strings: new Map(),
  };
  const top = () => { const st = s.stacks[s.mode]; return st[st.length - 1]; };
  const setTop = (m) => { const st = s.stacks[s.mode]; st[st.length - 1] = m; };

  /** Size the framebuffer; the window system (glut.js) calls this. */
  function resize(w, h) {
    s.width = w; s.height = h;
    s.color = new Uint8Array(w * h * 4); s.depth = new Float32Array(w * h).fill(1);
    s.viewport = [0, 0, w, h];
    if (backend === 'webgl') { webgl = makeWebGL(w, h); webgl.viewport(0, 0, w, h); }
  }

  // --- per-vertex work: position to window space, colour through lighting
  function litColour(eyeNormal) {
    if (!s.caps.has(CAP.LIGHTING)) return s.colour.slice();
    const m = s.material, out = [0, 0, 0, m.diffuse[3]];
    for (let k = 0; k < 3; k++) out[k] = m.emission[k] + s.sceneAmbient[k] * m.ambient[k];
    for (let li = 0; li < 8; li++) {
      const L = s.lights[li];
      if (!s.caps.has(CAP.LIGHT0 + li)) continue;
      const dir = norm3(L.position);                       // directional: position is a direction
      const ndl = Math.max(0, eyeNormal[0] * dir[0] + eyeNormal[1] * dir[1] + eyeNormal[2] * dir[2]);
      let spec = 0;
      if (ndl > 0 && (m.specular[0] || m.specular[1] || m.specular[2])) {
        const hv = norm3([dir[0], dir[1], dir[2] + 1]);   // infinite viewer: eye direction (0,0,1)
        const ndh = Math.max(0, eyeNormal[0] * hv[0] + eyeNormal[1] * hv[1] + eyeNormal[2] * hv[2]);
        spec = m.shininess ? ndh ** m.shininess : (ndh > 0 ? 1 : 0);
      }
      for (let k = 0; k < 3; k++) out[k] += L.ambient[k] * m.ambient[k] + ndl * L.diffuse[k] * m.diffuse[k] + spec * L.specular[k] * m.specular[k];
    }
    for (let k = 0; k < 4; k++) out[k] = Math.min(1, Math.max(0, out[k]));
    return out;
  }
  function vertex(x, y, z) {
    const mv = s.stacks[MODELVIEW].at(-1), pr = s.stacks[PROJECTION].at(-1);
    const eye = xform(mv, x, y, z, 1);
    const clip = xform(pr, eye[0], eye[1], eye[2], eye[3]);
    let colour;
    if (s.caps.has(CAP.LIGHTING)) {
      const nm = normalMatrix(mv), n = s.normal;
      let en = [nm[0] * n[0] + nm[1] * n[1] + nm[2] * n[2], nm[3] * n[0] + nm[4] * n[1] + nm[5] * n[2], nm[6] * n[0] + nm[7] * n[1] + nm[8] * n[2]];
      if (s.caps.has(CAP.NORMALIZE)) en = norm3(en);
      colour = litColour(en);
    } else colour = s.colour.slice();
    s.verts.push({ clip, colour });
  }

  // --- primitive assembly and rasterisation
  function toWindow(v) {
    const [x, y, z, w] = v.clip, [vx, vy, vw, vh] = s.viewport;
    return { x: (x / w + 1) * vw / 2 + vx, y: (y / w + 1) * vh / 2 + vy, z: (z / w + 1) / 2, iw: 1 / w, c: v.colour };
  }
  function triangle(a, b, c, flatColour) {
    s.stats.triangles++;
    if (a.clip[3] <= 1e-9 || b.clip[3] <= 1e-9 || c.clip[3] <= 1e-9) { s.stats.behindEye++; return; }
    const A = toWindow(a), B = toWindow(b), C = toWindow(c);
    const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    if (area === 0) return;
    const front = (area > 0) === (s.frontFace === CCW);
    if (s.caps.has(CAP.CULL_FACE) && (s.cullFace === FRONT_AND_BACK || (s.cullFace === BACK) === !front)) { s.stats.culled++; return; }
    // On the GPU path the triangle leaves here, already lit, culled and in clip space.
    if (webgl) { webgl.tri(a, b, c, flatColour, s.caps.has(CAP.DEPTH_TEST)); return; }
    // Orient counter-clockwise so every edge function is positive inside.
    const [P, Q, R] = area > 0 ? [A, B, C] : [A, C, B];
    const ar = Math.abs(area);
    const W = s.width, H = s.height;
    const x0 = Math.max(0, Math.floor(Math.min(P.x, Q.x, R.x))), x1 = Math.min(W - 1, Math.ceil(Math.max(P.x, Q.x, R.x)));
    const y0 = Math.max(0, Math.floor(Math.min(P.y, Q.y, R.y))), y1 = Math.min(H - 1, Math.ceil(Math.max(P.y, Q.y, R.y)));
    // Top-left rule, in GL's bottom-up window space: an edge owns its pixels if it is a left edge
    // (going down, dy < 0 for a CCW triangle) or a top edge (horizontal, going left).
    const owns = (u, v) => { const dy = v.y - u.y, dx = v.x - u.x; return dy < 0 || (dy === 0 && dx < 0); };
    const eQR = owns(Q, R), eRP = owns(R, P), ePQ = owns(P, Q);
    const edge = (u, v, px, py) => (v.x - u.x) * (py - u.y) - (v.y - u.y) * (px - u.x);
    const depthTest = s.caps.has(CAP.DEPTH_TEST);
    for (let py = y0; py <= y1; py++) {
      const cy = py + 0.5;
      for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5;
        const w0 = edge(Q, R, cx, cy), w1 = edge(R, P, cx, cy), w2 = edge(P, Q, cx, cy);
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        if ((w0 === 0 && !eQR) || (w1 === 0 && !eRP) || (w2 === 0 && !ePQ)) continue;
        const l0 = w0 / ar, l1 = w1 / ar, l2 = w2 / ar;
        const z = l0 * P.z + l1 * Q.z + l2 * R.z;
        const i = py * W + px;
        if (depthTest) { if (!(z < s.depth[i])) continue; s.depth[i] = z; }
        let col = flatColour;
        if (!col) {
          const iw = l0 * P.iw + l1 * Q.iw + l2 * R.iw;
          col = [0, 1, 2, 3].map((k) => (l0 * P.c[k] * P.iw + l1 * Q.c[k] * Q.iw + l2 * R.c[k] * R.iw) / iw);
        }
        const o = i * 4;
        for (let k = 0; k < 4; k++) s.color[o + k] = Math.round(Math.min(1, Math.max(0, col[k])) * 255);
        s.stats.fragments++;
      }
    }
  }
  function assemble(mode, v) {
    const flat = s.shade === FLAT;
    const tri = (a, b, c, provoking) => triangle(v[a], v[b], v[c], flat ? v[provoking].colour : null);
    switch (mode) {
      case 0x0004: for (let i = 0; i + 2 < v.length; i += 3) tri(i, i + 1, i + 2, i + 2); break;
      case 0x0005: for (let i = 0; i + 2 < v.length; i++) (i & 1) ? tri(i + 1, i, i + 2, i + 2) : tri(i, i + 1, i + 2, i + 2); break;
      case 0x0006: for (let i = 1; i + 1 < v.length; i++) tri(0, i, i + 1, i + 1); break;
      case 0x0007: for (let i = 0; i + 3 < v.length; i += 4) { tri(i, i + 1, i + 2, i + 3); tri(i, i + 2, i + 3, i + 3); } break;
      case 0x0008: for (let i = 0; i + 3 < v.length; i += 2) { tri(i, i + 1, i + 3, i + 3); tri(i, i + 3, i + 2, i + 3); } break;
      case 0x0009: for (let i = 1; i + 1 < v.length; i++) tri(0, i, i + 1, 0); break;
      default: throw new Error(`gl: primitive 0x${mode.toString(16)} (lines and points) is not implemented`);
    }
  }

  // --- the commands. Each runs, or is recorded into the display list being compiled.
  const exec = {
    glClear: (mask) => {
      if (webgl) { webgl.clear(mask, s.clear); return; }
      if (mask & 0x4000) for (let i = 0; i < s.color.length; i += 4) for (let k = 0; k < 4; k++) s.color[i + k] = Math.round(s.clear[k] * 255);
      if (mask & 0x100) s.depth.fill(1);
    },
    glClearColor: (r, g, b, a) => { s.clear = [r, g, b, a].map((x) => Math.min(1, Math.max(0, x))); },
    glEnable: (cap) => { s.caps.add(cap); },
    glDisable: (cap) => { s.caps.delete(cap); },
    glShadeModel: (m) => { s.shade = m; },
    glCullFace: (m) => { s.cullFace = m; },
    glFrontFace: (m) => { s.frontFace = m; },
    glViewport: (x, y, w, h) => { s.viewport = [x, y, w, h]; if (webgl) webgl.viewport(x, y, w, h); },
    glMatrixMode: (m) => { s.mode = m; },
    glLoadIdentity: () => setTop(ident()),
    glPushMatrix: () => { s.stacks[s.mode].push(Float64Array.from(top())); },
    glPopMatrix: () => { if (s.stacks[s.mode].length > 1) s.stacks[s.mode].pop(); },
    glTranslatef: (x, y, z) => { const t = ident(); t[12] = x; t[13] = y; t[14] = z; setTop(mul(top(), t)); },
    glScalef: (x, y, z) => { const t = ident(); t[0] = x; t[5] = y; t[10] = z; setTop(mul(top(), t)); },
    glRotatef: (angle, x, y, z) => {
      const [ux, uy, uz] = norm3([x, y, z]), r = angle * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r), k = 1 - c;
      const t = ident();
      t[0] = ux * ux * k + c; t[4] = ux * uy * k - uz * sn; t[8] = ux * uz * k + uy * sn;
      t[1] = uy * ux * k + uz * sn; t[5] = uy * uy * k + c; t[9] = uy * uz * k - ux * sn;
      t[2] = ux * uz * k - uy * sn; t[6] = uy * uz * k + ux * sn; t[10] = uz * uz * k + c;
      setTop(mul(top(), t));
    },
    glFrustum: (l, r, b, t, n, f) => {
      const m = new Float64Array(16);
      m[0] = 2 * n / (r - l); m[5] = 2 * n / (t - b); m[8] = (r + l) / (r - l); m[9] = (t + b) / (t - b);
      m[10] = -(f + n) / (f - n); m[11] = -1; m[14] = -2 * f * n / (f - n);
      setTop(mul(top(), m));
    },
    glOrtho: (l, r, b, t, n, f) => {
      const m = ident();
      m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
      m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n);
      setTop(mul(top(), m));
    },
    glBegin: (mode) => { s.prim = mode; s.verts = []; },
    glEnd: () => { const v = s.verts; s.verts = []; const m = s.prim; s.prim = null; assemble(m, v); },
    glVertex3f: (x, y, z) => vertex(x, y, z),
    glVertex2f: (x, y) => vertex(x, y, 0),
    glNormal3f: (x, y, z) => { s.normal = [x, y, z]; },
    glColor3f: (r, g, b) => { s.colour = [r, g, b, 1]; },
    glColor4f: (r, g, b, a) => { s.colour = [r, g, b, a]; },
    // Array arguments arrive already read (see `recordable` below), as the spec's copy semantics need.
    glLightfv: (li, pname, v) => {
      const L = s.lights[li - CAP.LIGHT0];
      if (!L) throw new Error(`gl: light 0x${li.toString(16)}`);
      if (pname === PNAME.POSITION) {
        const e = xform(s.stacks[MODELVIEW].at(-1), v[0], v[1], v[2], v[3]);
        if (v[3] !== 0) throw new Error('gl: positional lights (w != 0) are not implemented');
        L.position = [e[0], e[1], e[2], 0];
      } else if (pname === PNAME.AMBIENT) L.ambient = v;
      else if (pname === PNAME.DIFFUSE) L.diffuse = v;
      else if (pname === PNAME.SPECULAR) L.specular = v;
      else throw new Error(`gl: glLightfv pname 0x${pname.toString(16)}`);
    },
    glMaterialfv: (face, pname, v) => {
      if (face === BACK) return;                           // one-sided lighting: back is never shown lit
      const m = s.material;
      if (pname === PNAME.AMBIENT_AND_DIFFUSE) { m.ambient = v; m.diffuse = v; }
      else if (pname === PNAME.AMBIENT) m.ambient = v;
      else if (pname === PNAME.DIFFUSE) m.diffuse = v;
      else if (pname === PNAME.SPECULAR) m.specular = v;
      else if (pname === PNAME.EMISSION) m.emission = v;
      else if (pname === PNAME.SHININESS) m.shininess = v[0];
      else throw new Error(`gl: glMaterialfv pname 0x${pname.toString(16)}`);
    },
    glCallList: (n) => { for (const [name, args] of s.lists.get(n) ?? []) exec[name](...args); },
  };
  // How many floats an array argument holds, read at CALL time so a list keeps the values.
  const vecLen = (pname) => (pname === PNAME.SHININESS ? 1 : 4);
  const api = {};
  for (const name of Object.keys(exec)) {
    api[name] = (...a) => {
      if (name === 'glLightfv' || name === 'glMaterialfv') a = [a[0], a[1], f32(a[2], vecLen(a[1]))];
      if (s.recording) { s.recording.push([name, a]); if (s.recordMode !== COMPILE_AND_EXECUTE) return; }
      exec[name](...a);
    };
  }
  Object.assign(api, {
    glGenLists: (range) => { const first = s.nextList; s.nextList += range; return first; },
    glNewList: (n, mode) => { s.recording = []; s.recordMode = mode; s.recordingId = n; },
    glEndList: () => { s.lists.set(s.recordingId, s.recording); s.recording = null; },
    glDeleteLists: (n, range) => { for (let k = 0; k < range; k++) s.lists.delete(n + k); },
    glGetString: (name) => {
      const text = { 0x1f00: 'PRISM', 0x1f01: 'PRISM software rasteriser', 0x1f02: '1.1 PRISM', 0x1f03: '' }[name];
      if (text === undefined) return 0;
      if (!s.strings.has(name)) s.strings.set(name, M.mod.intern([...new TextEncoder().encode(text), 0]));
      return s.strings.get(name);
    },
    glFinish: () => {}, glFlush: () => {},
  });
  Object.assign(M.rt, api);

  const gl = {
    state: s, resize,
    /** The picture, top row first, RGBA -- GL's framebuffer is bottom row first. */
    readPixels() {
      const out = new Uint8Array(s.width * s.height * 4), src = webgl ? webgl.read() : s.color;
      for (let y = 0; y < s.height; y++) out.set(src.subarray((s.height - 1 - y) * s.width * 4, (s.height - y) * s.width * 4), y * s.width * 4);
      return out;
    },
    onFrame,
    get backend() { return webgl ? 'webgl' : 'soft'; },
  };
  M.gl = gl;
  return gl;
}

/*
 * THE GPU PATH. Everything up to rasterisation stays in JavaScript -- transformation, lighting,
 * culling, the provoking vertex -- because that is the part gate-gears holds to Mesa; WebGL2 is
 * handed the result as triangles in CLIP space with their colours (a flat triangle carries its
 * provoking colour on all three vertices) and does only what a GPU is for: rasterise, interpolate
 * perspective-correctly, test depth. A pass-through shader pair, one vertex buffer, no culling or
 * blending of its own. Draws are batched and flushed on a clear, a viewport change, a change of the
 * depth test, and when the picture is read back.
 */
function makeWebGL(w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('webgl2', { antialias: false, depth: true, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!g) throw new Error('gl: this browser has no WebGL2 for an OffscreenCanvas');
  const shader = (type, src) => {
    const sh = g.createShader(type);
    g.shaderSource(sh, src); g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error(`gl: shader: ${g.getShaderInfoLog(sh)}`);
    return sh;
  };
  const prog = g.createProgram();
  g.attachShader(prog, shader(g.VERTEX_SHADER, '#version 300 es\nin vec4 pos; in vec4 col; out vec4 v;\nvoid main() { gl_Position = pos; v = col; }'));
  g.attachShader(prog, shader(g.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; in vec4 v; out vec4 o;\nvoid main() { o = v; }'));
  g.bindAttribLocation(prog, 0, 'pos'); g.bindAttribLocation(prog, 1, 'col');
  g.linkProgram(prog);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(`gl: link: ${g.getProgramInfoLog(prog)}`);
  g.useProgram(prog);
  g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
  g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 4, g.FLOAT, false, 32, 0);
  g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 4, g.FLOAT, false, 32, 16);
  g.disable(g.CULL_FACE); g.disable(g.BLEND); g.depthFunc(g.LESS); g.depthRange(0, 1);
  const MAXV = 3 * 65536, data = new Float32Array(MAXV * 8);
  let n = 0, depthOn = null;
  const flush = () => {
    if (!n) return;
    g.bufferData(g.ARRAY_BUFFER, data.subarray(0, n * 8), g.STREAM_DRAW);
    g.drawArrays(g.TRIANGLES, 0, n);
    n = 0;
  };
  return {
    tri(a, b, c, flat, depth) {
      if (depth !== depthOn) { flush(); depthOn = depth; if (depth) g.enable(g.DEPTH_TEST); else g.disable(g.DEPTH_TEST); }
      if (n + 3 > MAXV) flush();
      for (const v of [a, b, c]) { data.set(v.clip, n * 8); data.set(flat ?? v.colour, n * 8 + 4); n++; }
    },
    viewport(x, y, vw, vh) { flush(); g.viewport(x, y, vw, vh); },
    clear(mask, colour) {
      flush();
      g.clearColor(colour[0], colour[1], colour[2], colour[3]); g.clearDepth(1); g.depthMask(true);
      g.clear(((mask & 0x4000) ? g.COLOR_BUFFER_BIT : 0) | ((mask & 0x100) ? g.DEPTH_BUFFER_BIT : 0));
    },
    /** The framebuffer, bottom row first, as GL's own is. */
    read() { flush(); const px = new Uint8Array(w * h * 4); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px); return px; },
  };
}

/** The builtin signatures, from headers-gl.js. */
export function glBuiltins(T) {
  const I = T.INT, U = T.UINT, V = T.VOID, F = T.FLOAT, D = T.DOUBLE, P = T.ptr(T.CHAR);
  const f = (ret, ...params) => ({ ret, params });
  return {
    glClear: f(V, U), glClearColor: f(V, F, F, F, F), glEnable: f(V, U), glDisable: f(V, U),
    glShadeModel: f(V, U), glCullFace: f(V, U), glFrontFace: f(V, U), glViewport: f(V, I, I, I, I),
    glMatrixMode: f(V, U), glLoadIdentity: f(V), glPushMatrix: f(V), glPopMatrix: f(V),
    glTranslatef: f(V, F, F, F), glRotatef: f(V, F, F, F, F), glScalef: f(V, F, F, F),
    glFrustum: f(V, D, D, D, D, D, D), glOrtho: f(V, D, D, D, D, D, D),
    glBegin: f(V, U), glEnd: f(V), glVertex3f: f(V, F, F, F), glVertex2f: f(V, F, F),
    glNormal3f: f(V, F, F, F), glColor3f: f(V, F, F, F), glColor4f: f(V, F, F, F, F),
    glLightfv: f(V, U, U, P), glMaterialfv: f(V, U, U, P),
    glGenLists: f(U, I), glNewList: f(V, U, U), glEndList: f(V), glCallList: f(V, U), glDeleteLists: f(V, U, I),
    glGetString: f(P, U), glFinish: f(V), glFlush: f(V),
  };
}
