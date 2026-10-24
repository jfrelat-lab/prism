// gl.js — OpenGL 1.1's fixed-function pipeline, answered in JavaScript: state, and a rasteriser.
//
// A library boundary, like SDL or Allegro here: the program's GL calls arrive at this file, and the
// PICTURE they describe comes out of it. Two rasterisers share one state machine. Headless, this
// file rasterises the triangles itself into an RGBA framebuffer, so a gate can hold the result to
// Mesa (tools/gate-gears.mjs, gate-glquake.mjs); in the page, WebGL2 rasterises the same triangles
// (makeWebGL below). Everything before rasterisation -- transformation, lighting, clipping, culling,
// the provoking vertex -- is this file's in both cases, so the part the gates hold is the part both
// paths share.
//
// What is implemented is what the specification says for the parts a program has called, and no
// more (headers-gl.js declares exactly this set):
//   - matrices: MODELVIEW and PROJECTION stacks; Translate, Rotate, Scale, Frustum, Ortho,
//     LoadMatrixf, GetFloatv of either matrix.
//   - immediate mode: Begin/End with Vertex, Normal, Color, TexCoord; every GL 1.1 polygon
//     primitive assembled into triangles (quads and polygons as fans from their first vertex), and
//     the three line primitives.
//   - display lists: GL_COMPILE records the commands (array arguments COPIED, as the spec requires).
//   - lighting: per vertex, in eye space; directional lights and an infinite viewer.
//   - clipping: against the NEAR plane of the view volume, in clip space (Sutherland-Hodgman), with
//     every attribute interpolated linearly there; x, y and far are left to the viewport and depth.
//   - textures: objects, levels, RGB/RGBA/LUMINANCE/ALPHA/INTENSITY, NEAREST/LINEAR and the four
//     mipmap filters with the specification's level selection, REPEAT/CLAMP, MODULATE/REPLACE/DECAL.
//   - per fragment, in the specification's order: texturing, fog (LINEAR/EXP/EXP2 on eye distance),
//     alpha test, depth test (every function, DepthMask, DepthRange), blending (every factor).
//   - rasterisation: pixel centres and the top-left fill rule, CULL_FACE by window-space winding,
//     perspective-correct colour, texture coordinates and fog distance.
// NOT implemented, and refused rather than approximated: points, polygon modes other than FILL,
// positional lights, colour-index textures.

import { GL_H } from './headers-gl.js';

const MODELVIEW = 0x1700, PROJECTION = 0x1701, TEXTURE_MATRIX = 0x1702;
const CAP = {
  CULL_FACE: 0x0b44, LIGHTING: 0x0b50, DEPTH_TEST: 0x0b71, NORMALIZE: 0x0ba1, LIGHT0: 0x4000,
  TEXTURE_2D: 0x0de1, BLEND: 0x0be2, ALPHA_TEST: 0x0bc0, FOG: 0x0b60, SCISSOR_TEST: 0x0c11,
  POLYGON_OFFSET_FILL: 0x8037, CLIP_PLANE0: 0x3000, STENCIL_TEST: 0x0b90,
};
// What glEnable acts on (the rest are named in CAP): texture generation, colour material.
const KNOWN_CAPS = new Set([0x0b90, 0x0b44, 0x0b50, 0x0b71, 0x0ba1, 0x0de1, 0x0be2, 0x0bc0, 0x0b60, 0x0c11, 0x8037, 0x0c60, 0x0c61, 0x0b57, 0x8861]);
const ARRAY = { 0x8074: 'vertex', 0x8075: 'normal', 0x8076: 'color', 0x8078: 'tex' };
// The size of one component of an array, by its type (GL_BYTE .. GL_FLOAT, GL_DOUBLE).
const TYPE_BYTES = { 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4, 0x140a: 8 };
/*
 * What glGetString(GL_EXTENSIONS) names: GL_EXT_compiled_vertex_array always, and those a TARGET asks
 * for (its env's gl.extensions) from the ones implemented here, entry points under their ARB names.
 * Not advertised by default: a program that sees GL_ARB_multitexture may want what is not here --
 * Quake II and III take glMultiTexCoord2fARB and two units from it -- and would change its path.
 */
const EXTENSIONS = 'GL_EXT_compiled_vertex_array';
const OPTIONAL_EXTENSIONS = new Set(['GL_ARB_multitexture', 'GL_ARB_vertex_buffer_object', 'GL_ARB_point_parameters', 'GL_ARB_point_sprite']);
// Capabilities that belong to a texture unit (2D texturing, coordinate generation).
const UNIT_CAPS = new Set([0x0de1, 0x0c60, 0x0c61, 0x0c62, 0x0c63]);
const FLAT = 0x1d00, CCW = 0x0901, BACK = 0x0405, FRONT = 0x0404, FRONT_AND_BACK = 0x0408;
const PNAME = { AMBIENT: 0x1200, DIFFUSE: 0x1201, SPECULAR: 0x1202, POSITION: 0x1203, EMISSION: 0x1600, SHININESS: 0x1601, AMBIENT_AND_DIFFUSE: 0x1602 };
const LIGHT_MODEL = { LOCAL_VIEWER: 0x0b51, TWO_SIDE: 0x0b52, AMBIENT: 0x0b53 };
const COMPILE_AND_EXECUTE = 0x1301;
const TEX = {
  MAG: 0x2800, MIN: 0x2801, WRAP_S: 0x2802, WRAP_T: 0x2803,
  NEAREST: 0x2600, LINEAR: 0x2601, NN: 0x2700, LN: 0x2701, NL: 0x2702, LL: 0x2703,
  REPEAT: 0x2901, CLAMP: 0x2900, CLAMP_TO_EDGE: 0x812f,
  ENV_MODE: 0x2200, MODULATE: 0x2100, REPLACE: 0x1e01, DECAL: 0x2101,
};
const FMT = { ALPHA: 0x1906, RGB: 0x1907, RGBA: 0x1908, LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190a, INTENSITY: 0x8049, COLOR_INDEX: 0x1900 };
const FOG = { MODE: 0x0b65, DENSITY: 0x0b62, START: 0x0b63, END: 0x0b64, COLOR: 0x0b66, LINEAR: 0x2601, EXP: 0x0800, EXP2: 0x0801 };

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
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}
function invert4(m) {
  const a = Array.from(m), r = Array.from(ident());
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let k = c + 1; k < 4; k++) if (Math.abs(a[c * 4 + k]) > Math.abs(a[c * 4 + p])) p = k;
    if (a[c * 4 + p] === 0) return r;               // singular: GL leaves the result undefined
    for (let j = 0; j < 4; j++) { [a[j * 4 + c], a[j * 4 + p]] = [a[j * 4 + p], a[j * 4 + c]]; [r[j * 4 + c], r[j * 4 + p]] = [r[j * 4 + p], r[j * 4 + c]]; }
    const d = a[c * 4 + c];
    for (let j = 0; j < 4; j++) { a[j * 4 + c] /= d; r[j * 4 + c] /= d; }
    for (let k = 0; k < 4; k++) {
      if (k === c) continue;
      const f = a[c * 4 + k];
      for (let j = 0; j < 4; j++) { a[j * 4 + k] -= f * a[j * 4 + c]; r[j * 4 + k] -= f * r[j * 4 + c]; }
    }
  }
  return r;
}
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** The eight comparison functions, shared by the alpha and depth tests (their enums coincide). */
const compare = (fn, a, b) => {
  switch (fn) {
    case 0x200: return false; case 0x201: return a < b; case 0x202: return a === b; case 0x203: return a <= b;
    case 0x204: return a > b; case 0x205: return a !== b; case 0x206: return a >= b; default: return true;
  }
};
/** The base internal format a texture's internalformat names, and so which components the environment uses. */
function baseFormat(internal) {
  switch (internal) {
    case 1: case FMT.LUMINANCE: case 0x803f: case 0x8040: return 'L';
    case 2: case FMT.LUMINANCE_ALPHA: return 'LA';
    case 3: case FMT.RGB: case 0x8051: case 0x8050: case 0x8052: return 'RGB';
    case 4: case FMT.RGBA: case 0x8056: case 0x8057: case 0x8058: return 'RGBA';
    case FMT.ALPHA: case 0x803c: return 'A';
    case FMT.INTENSITY: case 0x804b: return 'I';
    default: throw new Error(`gl: texture internal format 0x${internal.toString(16)}`);
  }
}

/*
 * `version` is what glGetString(GL_VERSION) says. A program may pick its path by it -- Mesa's texobj
 * uses texture objects on "1.1" and display lists otherwise -- so a gate can ask for either, as
 * MESA_GL_VERSION_OVERRIDE does on the reference side.
 */
export function installGL(M, { onFrame = null, backend = 'soft', version = '1.1 PRISM', onLost = null, extensions = [] } = {}) {
  for (const e of extensions) if (!OPTIONAL_EXTENSIONS.has(e)) throw new Error(`gl: extension ${e} is not implemented`);
  const extensionString = [EXTENSIONS, ...extensions].join(' ');
  // Every GL 1.1 entry point gl.h declares, implemented here or not: what a libGL opened with dlopen
  // exports (src/env/dl.js), as opengl32.dll does for GetProcAddress (src/env/opengl32.c).
  M.glNames = new Set([...GL_H.matchAll(/\b(gl[A-Z]\w*)\s*\(/g)].map((m) => m[1]));
  const drawSeen = [], drawStamp = [];      // glDrawElements' vertex per index (see there)
  let drawGen = 0;
  let gpuCache = null;                      // gpuState until a command that is not a vertex runs (see exec)
  let webgl = null;                         // the WebGL2 rasteriser when backend is 'webgl' (makeWebGL)
  const dv = () => M.mod.dv;
  const f32 = (p, n) => Array.from({ length: n }, (_, k) => dv().getFloat32(p + 4 * k, true));
  const material = () => ({ ambient: [0.2, 0.2, 0.2, 1], diffuse: [0.8, 0.8, 0.8, 1], specular: [0, 0, 0, 1], emission: [0, 0, 0, 1], shininess: 0 });
  const light = () => ({ ambient: [0, 0, 0, 1], diffuse: [0, 0, 0, 1], specular: [0, 0, 0, 1], position: [0, 0, 1, 0] });
  const newTexture = () => ({ levels: [], base: 'RGBA', min: TEX.NL, mag: TEX.LINEAR, wrapS: TEX.REPEAT, wrapT: TEX.REPEAT, gpu: null, dirty: true });
  const s = {
    width: 0, height: 0, color: null, depth: null,
    viewport: [0, 0, 0, 0], clear: [0, 0, 0, 0], clearDepth: 1,
    mode: MODELVIEW, stacks: { [MODELVIEW]: [ident()], [PROJECTION]: [ident()], [TEXTURE_MATRIX]: [ident()] },
    caps: new Set(), shade: 0x1d01, frontFace: CCW, cullFace: BACK,
    normal: [0, 0, 1], colour: [1, 1, 1, 1], tex: [0, 0],
    material: material(), backMaterial: material(),
    sceneAmbient: [0.2, 0.2, 0.2, 1], twoSide: false,
    lights: Array.from({ length: 8 }, (_, k) => {
      const l = light();
      if (k === 0) { l.diffuse = [1, 1, 1, 1]; l.specular = [1, 1, 1, 1]; }
      return l;
    }),
    depthFunc: 0x201, depthMask: true, depthRange: [0, 1],
    alphaFunc: 0x207, alphaRef: 0, blend: [1, 0],
    envMode: TEX.MODULATE,
    fog: { mode: FOG.EXP, density: 1, start: 0, end: 1, colour: [0, 0, 0, 0] },
    textures: new Map([[0, newTexture()]]), bound: 0, nextTexture: 1, genTextures: new Set(),
    arrays: { vertex: { on: false }, color: { on: false }, tex: { on: false }, normal: { on: false } },
    // glTexGen: per coordinate (s, t) its mode and object plane; the caps TEXTURE_GEN_S/T turn it on.
    texGen: [{ mode: 0x2400, object: [1, 0, 0, 0] }, { mode: 0x2400, object: [0, 1, 0, 0] }],
    unpackAlign: 4, packAlign: 4,
    // The stencil buffer exists only when the window asked for one (glut.js: GLUT_STENCIL); with no
    // stencil bits the test passes and nothing is written (GL 1.1 4.1.4).
    stencilBits: 0, stencil: null,
    stencilFunc: [0x207, 0, 0xffffffff], stencilOp: [0x1e00, 0x1e00, 0x1e00], stencilWriteMask: 0xffffffff, clearStencil: 0,
    colourMaterial: { face: 0x0408, mode: 0x1602 },    // GL_FRONT_AND_BACK, GL_AMBIENT_AND_DIFFUSE
    unknownCaps: new Set(),
    scissor: [0, 0, 0, 0], pointSize: 1, lineWidth: 1,
    // ARB_point_parameters: the size's clamp and its attenuation with eye distance (a + b d + c d^2);
    // ARB_point_sprite's COORD_REPLACE gives each point's fragments texture coordinates across it.
    pointMin: 0, pointMax: 64, pointAtten: [1, 0, 0], coordReplace: false,
    // ARB_multitexture: the selected server and client units. One unit is implemented, and
    // GL_MAX_TEXTURE_UNITS says so; a program that asks for more falls back on one (Neverball does).
    activeUnit: 0, clientUnit: 0,
    // ARB_vertex_buffer_object: a buffer is a block of the program's own memory, so an array pointer
    // into a bound buffer is an ordinary pointer once its base is added -- the arrays, glDrawArrays
    // and glDrawElements read it unchanged. id -> { ptr, size }; the two bindings by target.
    buffers: new Map(), nextBuffer: 1, arrayBuffer: 0, elementBuffer: 0,
    colorMask: [true, true, true, true], polygonOffset: [0, 0], clipPlanes: [null, null, null, null, null, null],
    prim: null, verts: [],
    lists: new Map(), nextList: 1, recording: null, recordMode: 0,
    stats: { triangles: 0, culled: 0, clipped: 0, fragments: 0 },
    strings: new Map(),
  };
  const top = () => { const st = s.stacks[s.mode]; return st[st.length - 1]; };
  const setTop = (m) => { const st = s.stacks[s.mode]; st[st.length - 1] = m; };
  const texture = () => s.textures.get(s.bound);
  // An array pointer: into the bound array buffer, or the program's memory as it stands.
  const inBuffer = (ptr) => (s.arrayBuffer
    ? { ptr: s.buffers.get(s.arrayBuffer).ptr + ptr, buffer: s.arrayBuffer, offset: ptr }
    : { ptr, buffer: 0, offset: 0 });

  /** Size the framebuffer; the window system (glut.js, glx.js) calls this. */
  function resize(w, h) {
    s.width = w; s.height = h;
    s.color = new Uint8Array(w * h * 4); s.depth = new Float32Array(w * h).fill(1);
    s.stencil = s.stencilBits ? new Uint8Array(w * h) : null;
    s.viewport = [0, 0, w, h];
    gpuCache = null;
    if (backend === 'webgl') { webgl = makeWebGL(w, h, s.stencilBits > 0); webgl.viewport(0, 0, w, h); for (const t of s.textures.values()) t.dirty = true; }
  }
  /*
   * A LOST CONTEXT, rebuilt the way a resize builds one: everything the GPU held is a copy of state
   * kept here (the textures are re-sent from their pixels, marked dirty), so a new context draws the
   * next frame as the old one would have. Without this, the GPU dropping the context left the window
   * black for good while the program -- its sound, its clock -- went on (Tux Racer, mid-race).
   */
  function recoverIfLost() {
    if (!webgl?.lost) return;
    webgl = makeWebGL(s.width, s.height, s.stencilBits > 0);
    webgl.viewport(...s.viewport);
    for (const t of s.textures.values()) t.dirty = true;
    gpuCache = null;
    onLost?.();
  }

  // --- per-vertex work
  function litColour(m, eyeNormal, eye) {
    const out = [0, 0, 0, m.diffuse[3]];
    for (let k = 0; k < 3; k++) out[k] = m.emission[k] + s.sceneAmbient[k] * m.ambient[k];
    for (let li = 0; li < 8; li++) {
      const L = s.lights[li];
      if (!s.caps.has(CAP.LIGHT0 + li)) continue;
      // GL 1.1 2.13.1: a directional light's direction is its position; a positional one's is the
      // vector from the vertex to it, and it falls off as 1 / (kc + kl d + kq d^2) -- all of the
      // light's contribution, ambient included.
      let dir, att = 1;
      if (L.position[3] === 0) dir = norm3(L.position);
      else {
        const v = [L.position[0] - eye[0] / eye[3], L.position[1] - eye[1] / eye[3], L.position[2] - eye[2] / eye[3]];
        const d = Math.hypot(v[0], v[1], v[2]), [kc, kl, kq] = L.attenuation ?? [1, 0, 0];
        dir = d ? [v[0] / d, v[1] / d, v[2] / d] : [0, 0, 0];
        att = 1 / (kc + kl * d + kq * d * d);
      }
      const ndl = Math.max(0, eyeNormal[0] * dir[0] + eyeNormal[1] * dir[1] + eyeNormal[2] * dir[2]);
      let spec = 0;
      if (ndl > 0 && (m.specular[0] || m.specular[1] || m.specular[2])) {
        const hv = norm3([dir[0], dir[1], dir[2] + 1]);
        const ndh = Math.max(0, eyeNormal[0] * hv[0] + eyeNormal[1] * hv[1] + eyeNormal[2] * hv[2]);
        spec = m.shininess ? ndh ** m.shininess : (ndh > 0 ? 1 : 0);
      }
      for (let k = 0; k < 3; k++) out[k] += att * (L.ambient[k] * m.ambient[k] + ndl * L.diffuse[k] * m.diffuse[k] + spec * L.specular[k] * m.specular[k]);
    }
    return out.map(clamp01);
  }
  function vertex(x, y, z) {
    const mv = s.stacks[MODELVIEW].at(-1), pr = s.stacks[PROJECTION].at(-1);
    const eye = xform(mv, x, y, z, 1);
    const clip = xform(pr, eye[0], eye[1], eye[2], eye[3]);
    let colour, back = null;
    if (s.caps.has(CAP.LIGHTING)) {
      /*
       * GL_COLOR_MATERIAL: the current colour IS the material property it tracks, alpha included (GL 1.1,
       * 2.13.3). Tux Racer blends its terrain layers -- snow, ice, rock -- by a per-vertex alpha that
       * reaches the lit colour only this way; ignored, every layer came out opaque.
       */
      if (s.caps.has(0x0b57)) {
        const { face, mode } = s.colourMaterial;
        for (const m of face === FRONT ? [s.material] : face === BACK ? [s.backMaterial] : [s.material, s.backMaterial]) {
          if (mode === PNAME.AMBIENT_AND_DIFFUSE) { m.ambient = s.colour; m.diffuse = s.colour; }
          else if (mode === PNAME.AMBIENT) m.ambient = s.colour;
          else if (mode === PNAME.DIFFUSE) m.diffuse = s.colour;
          else if (mode === PNAME.SPECULAR) m.specular = s.colour;
          else if (mode === PNAME.EMISSION) m.emission = s.colour;
        }
      }
      const nm = normalMatrix(mv), n = s.normal;
      let en = [nm[0] * n[0] + nm[1] * n[1] + nm[2] * n[2], nm[3] * n[0] + nm[4] * n[1] + nm[5] * n[2], nm[6] * n[0] + nm[7] * n[1] + nm[8] * n[2]];
      if (s.caps.has(CAP.NORMALIZE)) en = norm3(en);
      colour = litColour(s.material, en, eye);
      // Two-sided: the colour a back face shows, lit with the back material and the normal reversed.
      // Which of the two a triangle gets is known only once its window-space winding is (triangle()).
      if (s.twoSide) back = litColour(s.backMaterial, [-en[0], -en[1], -en[2]], eye);
    } else colour = s.colour.map(clamp01);
    // A generated coordinate replaces the current one: the object plane dotted with the vertex as given.
    let tu = s.tex[0], tv = s.tex[1];
    const genS = s.caps.has(0x0c60), genT = s.caps.has(0x0c61);
    if ((genS && s.texGen[0].mode === 0x2402) || (genT && s.texGen[1].mode === 0x2402)) {
      // GL_SPHERE_MAP (GL 1.1, 2.10.4): the eye-space reflection of the view direction about the normal.
      const nm = normalMatrix(mv), n = s.normal;
      const en = norm3([nm[0] * n[0] + nm[1] * n[1] + nm[2] * n[2], nm[3] * n[0] + nm[4] * n[1] + nm[5] * n[2], nm[6] * n[0] + nm[7] * n[1] + nm[8] * n[2]]);
      const w = eye[3] || 1, u = norm3([eye[0] / w, eye[1] / w, eye[2] / w]);
      const d = 2 * (en[0] * u[0] + en[1] * u[1] + en[2] * u[2]);
      const r = [u[0] - d * en[0], u[1] - d * en[1], u[2] - d * en[2]];
      const m = 2 * Math.sqrt(r[0] * r[0] + r[1] * r[1] + (r[2] + 1) * (r[2] + 1)) || 1;
      if (genS && s.texGen[0].mode === 0x2402) tu = r[0] / m + 0.5;
      if (genT && s.texGen[1].mode === 0x2402) tv = r[1] / m + 0.5;
    }
    if (genS && s.texGen[0].mode === 0x2401) { const p = s.texGen[0].object; tu = p[0] * x + p[1] * y + p[2] * z + p[3]; }
    if (genT && s.texGen[1].mode === 0x2401) { const p = s.texGen[1].object; tv = p[0] * x + p[1] * y + p[2] * z + p[3]; }
    // The texture matrix (2.10.2), on (s, t, 0, 1) after any generation; q divided out, as a fragment
    // would. Chromium B.S.U.'s title scrolls and turns its background through it.
    const tm = s.stacks[TEXTURE_MATRIX].at(-1);
    if (tm[0] !== 1 || tm[1] || tm[4] || tm[5] !== 1 || tm[12] || tm[13] || tm[3] || tm[7] || tm[15] !== 1) {
      const q = tm[3] * tu + tm[7] * tv + tm[15];
      const su = tm[0] * tu + tm[4] * tv + tm[12], sv = tm[1] * tu + tm[5] * tv + tm[13];
      tu = q === 1 ? su : su / q; tv = q === 1 ? sv : sv / q;
    }
    s.verts.push({ clip, colour, back, tex: [tu, tv], eyeZ: Math.abs(eye[2] / (eye[3] || 1)), eye });
  }

  // --- clipping against the near plane (z + w >= 0), every attribute linear in clip space
  const lerpV = (a, b, t) => ({
    clip: a.clip.map((v, k) => v + (b.clip[k] - v) * t),
    colour: a.colour.map((v, k) => v + (b.colour[k] - v) * t),
    back: a.back && a.back.map((v, k) => v + (b.back[k] - v) * t),
    tex: [a.tex[0] + (b.tex[0] - a.tex[0]) * t, a.tex[1] + (b.tex[1] - a.tex[1]) * t],
    eyeZ: a.eyeZ + (b.eyeZ - a.eyeZ) * t,
    eye: a.eye && a.eye.map((v, k) => v + (b.eye[k] - v) * t),
  });
  function clipNear(poly) {
    const d = (v) => v.clip[2] + v.clip[3];
    if (poly.every((v) => d(v) >= 0)) return poly;
    s.stats.clipped++;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], da = d(a), db = d(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) out.push(lerpV(a, b, da / (da - db)));
    }
    return out;
  }

  /*
   * The user clip planes (glClipPlane), in EYE space as GL 1.1 2.11 puts them: a point is kept where
   * plane . eye >= 0. After the near plane, so both rasterisers get the same clipped polygons.
   */
  const userPlanes = () => s.clipPlanes.map((p, i) => (p && s.caps.has(CAP.CLIP_PLANE0 + i) ? p : null)).filter(Boolean);
  const dotEye = (p, v) => p[0] * v.eye[0] + p[1] * v.eye[1] + p[2] * v.eye[2] + p[3] * v.eye[3];
  // Whether any user plane is on, without building the list: asked once per triangle.
  const anyUserPlane = () => { for (let i = 0; i < s.clipPlanes.length; i++) if (s.clipPlanes[i] && s.caps.has(CAP.CLIP_PLANE0 + i)) return true; return false; };
  function clipUser(poly) {
    if (!anyUserPlane()) return poly;
    for (const p of userPlanes()) {
      if (poly.length < 3) break;
      if (poly.every((v) => dotEye(p, v) >= 0)) continue;
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], da = dotEye(p, a), db = dotEye(p, b);
        if (da >= 0) out.push(a);
        if ((da >= 0) !== (db >= 0)) out.push(lerpV(a, b, da / (da - db)));
      }
      poly = out;
    }
    return poly;
  }
  function clipUserSegment(seg) {
    for (const p of userPlanes()) {
      if (seg.length < 2) break;
      const [a, b] = seg, da = dotEye(p, a), db = dotEye(p, b);
      if (da < 0 && db < 0) return [];
      if (da < 0) seg = [lerpV(a, b, da / (da - db)), b];
      else if (db < 0) seg = [a, lerpV(a, b, da / (da - db))];
    }
    return seg;
  }

  // --- rasterisation
  /** The pixels a fragment may land on: the viewport the view volume maps to, cut by the scissor box. */
  function drawBox() {
    const [vx, vy, vw, vh] = s.viewport;
    let x0 = Math.max(0, vx), y0 = Math.max(0, vy), x1 = Math.min(s.width, vx + vw) - 1, y1 = Math.min(s.height, vy + vh) - 1;
    if (s.caps.has(CAP.SCISSOR_TEST)) {
      const [sx, sy, sw, sh] = s.scissor;
      x0 = Math.max(x0, sx); y0 = Math.max(y0, sy); x1 = Math.min(x1, sx + sw - 1); y1 = Math.min(y1, sy + sh - 1);
    }
    return [x0, y0, x1, y1];
  }
  function toWindow(v) {
    const [x, y, z, w] = v.clip, [vx, vy, vw, vh] = s.viewport, [n, f] = s.depthRange;
    return { x: (x / w + 1) * vw / 2 + vx, y: (y / w + 1) * vh / 2 + vy, z: n + (f - n) * (z / w + 1) / 2, iw: 1 / w, v };
  }
  /*
   * GL_CLAMP is not CLAMP_TO_EDGE (GL 1.1, 3.8.1): the coordinate is clamped to [0, 1], and a linear
   * filter that reaches past the image there takes the BORDER colour (transparent black unless
   * GL_TEXTURE_BORDER_COLOR says otherwise) -- the darker rim Mesa draws round Cube's HUD icons.
   *
   * The sampling path allocates nothing: a texel is an offset into its level (-1 for the border),
   * and a filter writes its four components into the array it is handed. The arithmetic is the
   * expressions it always was, so a picture is the same to the bit.
   */
  const BORDER = [0, 0, 0, 0];
  /** Where texel (i, j) of level L is after wrapping, or -1 for the border (a linear filter past GL_CLAMP's edge). */
  function texelAt(t, L, i, j, border) {
    if (border && ((t.wrapS === TEX.CLAMP && (i < 0 || i >= L.w)) || (t.wrapT === TEX.CLAMP && (j < 0 || j >= L.h)))) return -1;
    // REPEAT on a power-of-two size is a mask: the same residue as ((i % w) + w) % w for any int i.
    if (t.wrapS === TEX.REPEAT) i = (L.w & (L.w - 1)) === 0 ? i & (L.w - 1) : ((i % L.w) + L.w) % L.w;
    else i = Math.min(L.w - 1, Math.max(0, i));
    if (t.wrapT === TEX.REPEAT) j = (L.h & (L.h - 1)) === 0 ? j & (L.h - 1) : ((j % L.h) + L.h) % L.h;
    else j = Math.min(L.h - 1, Math.max(0, j));
    return (j * L.w + i) * 4;
  }
  function filter(t, lv, u, v, linear, out) {
    if (t.wrapS === TEX.CLAMP) u = clamp01(u);
    if (t.wrapT === TEX.CLAMP) v = clamp01(v);
    const L = t.levels[lv], x = u * L.w, y = v * L.h, D = L.data;
    if (!linear) {
      const o = texelAt(t, L, Math.floor(x), Math.floor(y), false);
      out[0] = D[o] / 255; out[1] = D[o + 1] / 255; out[2] = D[o + 2] / 255; out[3] = D[o + 3] / 255;
      return out;
    }
    const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5), a = x - 0.5 - x0, b = y - 0.5 - y0;
    const o00 = texelAt(t, L, x0, y0, true), o10 = texelAt(t, L, x0 + 1, y0, true), o01 = texelAt(t, L, x0, y0 + 1, true), o11 = texelAt(t, L, x0 + 1, y0 + 1, true);
    const Bc = t.border ?? BORDER;
    for (let k = 0; k < 4; k++) {
      const c00 = o00 < 0 ? Bc[k] : D[o00 + k] / 255, c10 = o10 < 0 ? Bc[k] : D[o10 + k] / 255;
      const c01 = o01 < 0 ? Bc[k] : D[o01 + k] / 255, c11 = o11 < 0 ? Bc[k] : D[o11 + k] / 255;
      out[k] = (1 - a) * (1 - b) * c00 + a * (1 - b) * c10 + (1 - a) * b * c01 + a * b * c11;
    }
    return out;
  }
  const FILTER_A = [0, 0, 0, 0], FILTER_B = [0, 0, 0, 0];
  const mipmapped = (f) => f === TEX.NN || f === TEX.LN || f === TEX.NL || f === TEX.LL;
  function complete(t) {
    if (!t.levels[0]) return false;
    if (!mipmapped(t.min)) return true;
    let w = t.levels[0].w, h = t.levels[0].h, lv = 0;
    for (;;) {
      if (!t.levels[lv] || t.levels[lv].w !== w || t.levels[lv].h !== h) return false;
      if (w === 1 && h === 1) return true;
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); lv++;
    }
  }
  /** The texture colour at (u, v) with scale factor rho (texels of level 0 per pixel), by the spec's rules -- in an array
   *  that the next call reuses: envApply reads it at once. */
  function sample(t, u, v, rho) {
    const lambda = Math.log2(rho);
    const c = t.mag === TEX.LINEAR && (t.min === TEX.NN || t.min === TEX.NL) ? 0.5 : 0;
    if (lambda <= c) return filter(t, 0, u, v, t.mag === TEX.LINEAR, FILTER_A);
    if (!mipmapped(t.min)) return filter(t, 0, u, v, t.min === TEX.LINEAR, FILTER_A);
    const q = t.levels.length - 1, linear = t.min === TEX.LN || t.min === TEX.LL;
    if (t.min === TEX.NN || t.min === TEX.LN) {
      const d = lambda <= 0.5 ? 0 : Math.min(q, Math.ceil(lambda + 0.5) - 1);
      return filter(t, d, u, v, linear, FILTER_A);
    }
    if (lambda >= q) return filter(t, q, u, v, linear, FILTER_A);
    const d1 = Math.floor(lambda), fr = lambda - d1;
    const a = filter(t, d1, u, v, linear, FILTER_A), b = filter(t, d1 + 1, u, v, linear, FILTER_B);
    for (let k = 0; k < 4; k++) a[k] = (1 - fr) * a[k] + fr * b[k];
    return a;
  }
  function envApply(cf, ct, base) {
    const m = s.envMode;
    const rgb = base === 'RGB' || base === 'RGBA', lum = base === 'L' || base === 'LA';
    const hasA = base === 'RGBA' || base === 'A' || base === 'LA';
    const T = base === 'I' ? [ct[0], ct[0], ct[0], ct[0]] : lum ? [ct[0], ct[0], ct[0], ct[3]] : ct;
    if (m === TEX.REPLACE) {
      if (base === 'A') return [cf[0], cf[1], cf[2], T[3]];
      return [T[0], T[1], T[2], hasA || base === 'I' ? T[3] : cf[3]];
    }
    if (m === TEX.DECAL) {
      if (base === 'RGB') return [T[0], T[1], T[2], cf[3]];
      return [0, 1, 2].map((k) => cf[k] * (1 - T[3]) + T[k] * T[3]).concat(cf[3]);
    }
    // MODULATE
    if (base === 'A') return [cf[0], cf[1], cf[2], cf[3] * T[3]];
    return [cf[0] * T[0], cf[1] * T[1], cf[2] * T[2], hasA || base === 'I' ? cf[3] * T[3] : cf[3]];
  }
  const BLEND = (f, src, dst, sa, da) => {
    switch (f) {
      case 0: return [0, 0, 0, 0]; case 1: return [1, 1, 1, 1];
      case 0x300: return src; case 0x301: return src.map((x) => 1 - x);
      case 0x302: return [sa, sa, sa, sa]; case 0x303: return [1 - sa, 1 - sa, 1 - sa, 1 - sa];
      case 0x304: return [da, da, da, da]; case 0x305: return [1 - da, 1 - da, 1 - da, 1 - da];
      case 0x306: return dst; case 0x307: return dst.map((x) => 1 - x);
      case 0x308: { const k = Math.min(sa, 1 - da); return [k, k, k, 1]; }
      default: throw new Error(`gl: blend factor 0x${f.toString(16)}`);
    }
  };
  /*
   * One fragment: fog, the alpha and depth tests, blending, the write. Scalars where it was arrays,
   * and the same expressions: the per-pixel arrays were most of the garbage the rasteriser made.
   */
  function fragment(i, z, col, eyeZ) {
    let c0 = col[0], c1 = col[1], c2 = col[2];
    const c3 = col[3];
    if (s.caps.has(CAP.FOG)) {
      const F = s.fog;
      let f = F.mode === FOG.LINEAR ? (F.end - eyeZ) / (F.end - F.start)
        : F.mode === FOG.EXP ? Math.exp(-F.density * eyeZ) : Math.exp(-((F.density * eyeZ) ** 2));
      f = clamp01(f);
      c0 = f * c0 + (1 - f) * F.colour[0]; c1 = f * c1 + (1 - f) * F.colour[1]; c2 = f * c2 + (1 - f) * F.colour[2];
    }
    if (s.caps.has(CAP.ALPHA_TEST) && !compare(s.alphaFunc, c3, s.alphaRef)) return;
    const stencil = s.stencil && s.caps.has(CAP.STENCIL_TEST);
    if (stencil) {
      const [fn, ref, mask] = s.stencilFunc, m = mask & 0xff;
      if (!compare(fn, (ref < 0 ? 0 : ref > 255 ? 255 : ref) & m, s.stencil[i] & m)) { stencilUpdate(i, s.stencilOp[0]); return; }
    }
    if (s.caps.has(CAP.DEPTH_TEST)) {
      if (!compare(s.depthFunc, z, s.depth[i])) { if (stencil) stencilUpdate(i, s.stencilOp[1]); return; }
      if (s.depthMask) s.depth[i] = z;
    }
    if (stencil) stencilUpdate(i, s.stencilOp[2]);
    const o = i * 4;
    let o0 = clamp01(c0), o1 = clamp01(c1), o2 = clamp01(c2), o3 = clamp01(c3);
    if (s.caps.has(CAP.BLEND)) {
      const out = [o0, o1, o2, o3];
      const dst = [s.color[o] / 255, s.color[o + 1] / 255, s.color[o + 2] / 255, s.color[o + 3] / 255];
      const sf = BLEND(s.blend[0], out, dst, out[3], dst[3]), df = BLEND(s.blend[1], out, dst, out[3], dst[3]);
      o0 = clamp01(out[0] * sf[0] + dst[0] * df[0]); o1 = clamp01(out[1] * sf[1] + dst[1] * df[1]);
      o2 = clamp01(out[2] * sf[2] + dst[2] * df[2]); o3 = clamp01(out[3] * sf[3] + dst[3] * df[3]);
    }
    const m = s.colorMask;
    if (m[0]) s.color[o] = Math.round(o0 * 255);
    if (m[1]) s.color[o + 1] = Math.round(o1 * 255);
    if (m[2]) s.color[o + 2] = Math.round(o2 * 255);
    if (m[3]) s.color[o + 3] = Math.round(o3 * 255);
    s.stats.fragments++;
  }
  /** A stencil operation (GL 1.1 4.1.4) on one pixel, through the write mask. */
  function stencilUpdate(i, op) {
    const old = s.stencil[i];
    let v;
    switch (op) {
      case 0x1e00: return;                                                     // KEEP
      case 0: v = 0; break;                                                    // ZERO
      case 0x1e01: { const r = s.stencilFunc[1]; v = r < 0 ? 0 : r > 255 ? 255 : r; break; }   // REPLACE
      case 0x1e02: v = old === 255 ? 255 : old + 1; break;                     // INCR, saturating
      case 0x1e03: v = old === 0 ? 0 : old - 1; break;                         // DECR, saturating
      case 0x150a: v = ~old & 0xff; break;                                     // INVERT
      default: throw new Error(`gl: stencil operation 0x${op.toString(16)}`);
    }
    const wm = s.stencilWriteMask & 0xff;
    s.stencil[i] = (old & ~wm) | (v & wm);
  }
  /** A perspective-correct attribute from its value at the three vertices: attribute/w over 1/w. */
  const persp = (l0, l1, l2, iw, P, Q, R, aP, aQ, aR) => (l0 * aP * P.iw + l1 * aQ * Q.iw + l2 * aR * R.iw) / iw;
  function rasterTriangle(A, B, C, flatColour) {
    const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    if (area === 0) return;
    const [P, Q, R] = area > 0 ? [A, B, C] : [A, C, B];
    const ar = Math.abs(area);
    const W = s.width;
    // The view volume's x and y planes, clipped here as the viewport rectangle they map to: GLQuake's
    // 3-D view is 432 lines over a 480-line window, and a floor that ran past it painted over the
    // status bar below.
    const [bx0, by0, bx1, by1] = drawBox();
    const x0 = Math.max(bx0, Math.floor(Math.min(P.x, Q.x, R.x))), x1 = Math.min(bx1, Math.ceil(Math.max(P.x, Q.x, R.x)));
    const y0 = Math.max(by0, Math.floor(Math.min(P.y, Q.y, R.y))), y1 = Math.min(by1, Math.ceil(Math.max(P.y, Q.y, R.y)));
    if (x1 < x0 || y1 < y0) return;                     // wholly outside the viewport: no pixel
    // Top-left rule, in GL's bottom-up window space: an edge owns its pixels if it goes down
    // (a left edge of a CCW triangle) or is horizontal going left (a top edge).
    const owns = (u, v) => { const dy = v.y - u.y, dx = v.x - u.x; return dy < 0 || (dy === 0 && dx < 0); };
    const eQR = owns(Q, R), eRP = owns(R, P), ePQ = owns(P, Q);
    // The edge functions (v.x - u.x) * (py - u.y) - (v.y - u.y) * (px - u.x), their constant
    // differences taken once: the same subtractions, so the same doubles.
    const qrX = R.x - Q.x, qrY = R.y - Q.y, rpX = P.x - R.x, rpY = P.y - R.y, pqX = Q.x - P.x, pqY = Q.y - P.y;
    const eQ = (cx, cy) => qrX * (cy - Q.y) - qrY * (cx - Q.x);
    const eR = (cx, cy) => rpX * (cy - R.y) - rpY * (cx - R.x);
    const eP = (cx, cy) => pqX * (cy - P.y) - pqY * (cx - P.x);
    const t = s.caps.has(CAP.TEXTURE_2D) ? texture() : null;
    const textured = t && complete(t);
    const fog = s.caps.has(CAP.FOG);
    let zoff = 0;
    if (s.caps.has(CAP.POLYGON_OFFSET_FILL) && (s.polygonOffset[0] || s.polygonOffset[1])) {
      const dzdx = ((B.z - A.z) * (C.y - A.y) - (C.z - A.z) * (B.y - A.y)) / area;
      const dzdy = ((C.z - A.z) * (B.x - A.x) - (B.z - A.z) * (C.x - A.x)) / area;
      zoff = s.polygonOffset[0] * Math.max(Math.abs(dzdx), Math.abs(dzdy)) + s.polygonOffset[1] / 16777215;
    }
    const Pv = P.v, Qv = Q.v, Rv = R.v;
    /*
     * The level of detail, per 2x2 quad of pixels from its top-left pixel, the way a GPU (and llvmpipe)
     * takes it: all four pixels of a quad share it, so it is computed once a quad and kept by quad
     * column for the row pair.
     */
    const L0 = textured ? t.levels[0] : null, qc0 = x0 >> 1, quads = (x1 >> 1) - qc0 + 1;
    const rhoOf = textured ? new Float64Array(quads) : null, rhoRow = textured ? new Int32Array(quads).fill(-1) : null;
    const texAt = (cx, cy, k) => {
      const l0 = eQ(cx, cy) / ar, l1 = eR(cx, cy) / ar, l2 = eP(cx, cy) / ar;
      const iw = l0 * P.iw + l1 * Q.iw + l2 * R.iw;
      return persp(l0, l1, l2, iw, P, Q, R, Pv.tex[k], Qv.tex[k], Rv.tex[k]);
    };
    const quadRho = (px, py) => {
      const qx = (px & ~1) + 0.5, qy = (py & ~1) + 0.5;
      const u0 = texAt(qx, qy, 0), v0 = texAt(qx, qy, 1);
      const dudx = (texAt(qx + 1, qy, 0) - u0) * L0.w, dvdx = (texAt(qx + 1, qy, 1) - v0) * L0.h;
      const dudy = (texAt(qx, qy + 1, 0) - u0) * L0.w, dvdy = (texAt(qx, qy + 1, 1) - v0) * L0.h;
      return Math.max(Math.hypot(dudx, dvdx), Math.hypot(dudy, dvdy));
    };
    for (let py = y0; py <= y1; py++) {
      const cy = py + 0.5, row = py >> 1;
      for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5;
        const w0 = eQ(cx, cy), w1 = eR(cx, cy), w2 = eP(cx, cy);
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        if ((w0 === 0 && !eQR) || (w1 === 0 && !eRP) || (w2 === 0 && !ePQ)) continue;
        const l0 = w0 / ar, l1 = w1 / ar, l2 = w2 / ar;
        const iw = l0 * P.iw + l1 * Q.iw + l2 * R.iw;
        // Rounded to the depth buffer's own precision BEFORE the test: comparing a double with the
        // float32 an earlier pass stored made LEQUAL fail wherever the rounding went down, and a second
        // pass over the same polygon (Quake's lightmaps) vanished on alternate rows.
        const z = Math.fround(zoff ? clamp01(l0 * P.z + l1 * Q.z + l2 * R.z + zoff) : l0 * P.z + l1 * Q.z + l2 * R.z);
        let col = flatColour ?? [
          persp(l0, l1, l2, iw, P, Q, R, Pv.colour[0], Qv.colour[0], Rv.colour[0]),
          persp(l0, l1, l2, iw, P, Q, R, Pv.colour[1], Qv.colour[1], Rv.colour[1]),
          persp(l0, l1, l2, iw, P, Q, R, Pv.colour[2], Qv.colour[2], Rv.colour[2]),
          persp(l0, l1, l2, iw, P, Q, R, Pv.colour[3], Qv.colour[3], Rv.colour[3]),
        ];
        if (textured) {
          const u = persp(l0, l1, l2, iw, P, Q, R, Pv.tex[0], Qv.tex[0], Rv.tex[0]);
          const v = persp(l0, l1, l2, iw, P, Q, R, Pv.tex[1], Qv.tex[1], Rv.tex[1]);
          const qc = (px >> 1) - qc0;
          if (rhoRow[qc] !== row) { rhoRow[qc] = row; rhoOf[qc] = quadRho(px, py); }
          col = envApply(col, sample(t, u, v, rhoOf[qc]), t.base);
        }
        fragment(py * W + px, z, col, fog ? persp(l0, l1, l2, iw, P, Q, R, Pv.eyeZ, Qv.eyeZ, Rv.eyeZ) : 0);
      }
    }
  }
  function triangle(a, b, c, provoking) {
    s.stats.triangles++;
    const poly = clipUser(clipNear([a, b, c]));
    if (poly.length < 3) return;
    const asBack = (v) => ({ ...v, colour: v.back });
    for (let k = 1; k + 1 < poly.length; k++) {
      let p0 = poly[0], p1 = poly[k], p2 = poly[k + 1];
      // The GPU path needs only the winding: toWindow's own arithmetic, without its three objects.
      let A = null, B = null, C = null, area;
      if (webgl) {
        const [vx, vy, vw, vh] = s.viewport;
        const wx = (v) => (v.clip[0] / v.clip[3] + 1) * vw / 2 + vx, wy = (v) => (v.clip[1] / v.clip[3] + 1) * vh / 2 + vy;
        const ax = wx(p0), ay = wy(p0);
        area = (wx(p1) - ax) * (wy(p2) - ay) - (wx(p2) - ax) * (wy(p1) - ay);
      } else {
        A = toWindow(p0); B = toWindow(p1); C = toWindow(p2);
        area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
      }
      if (area === 0) continue;
      const front = (area > 0) === (s.frontFace === CCW);
      if (s.caps.has(CAP.CULL_FACE) && (s.cullFace === FRONT_AND_BACK || (s.cullFace === BACK) === !front)) { s.stats.culled++; continue; }
      const back = !front && p0.back;
      if (back) { p0 = asBack(p0); p1 = asBack(p1); p2 = asBack(p2); if (!webgl) { A = toWindow(p0); B = toWindow(p1); C = toWindow(p2); } }
      const flatColour = provoking ? (back ? provoking.back : provoking.colour) : null;
      if (webgl) webgl.tri(p0, p1, p2, flatColour, gpuState());
      else rasterTriangle(A, B, C, flatColour);
    }
  }
  /*
   * A POINT: a square of the point size, in window pixels, centred on the vertex -- as two triangles
   * that the rest of the pipeline treats like any other. ARB_point_parameters scales the size by
   * 1 / sqrt(a + b d + c d^2), then clamps it -- d the eye DEPTH |z|, as Mesa takes it (the extension
   * says the distance to the eye; Mesa's fixed function, the reference here, measures along z); with GL_POINT_SPRITE and
   * COORD_REPLACE its texture coordinates run 0..1 across it, t from the top (ARB_point_sprite).
   */
  function point(v) {
    if (v.clip[3] <= 0 || v.clip[2] < -v.clip[3]) return;      // behind the eye or the near plane
    const [a, b, c] = s.pointAtten;
    let size = s.pointSize;
    if (b || c || a !== 1) {
      const d = v.eyeZ;
      size *= Math.sqrt(1 / (a + b * d + c * d * d));
    }
    size = Math.min(Math.max(size, s.pointMin, 1), s.pointMax);
    const [, , vw, vh] = s.viewport, hx = size / vw * v.clip[3], hy = size / vh * v.clip[3];
    const sprite = s.coordReplace && s.caps.has(0x8861);
    const at = (dx, dy, u, t) => ({ ...v, clip: [v.clip[0] + dx * hx, v.clip[1] + dy * hy, v.clip[2], v.clip[3]], tex: sprite ? [u, t] : v.tex });
    const q = [at(-1, -1, 0, 1), at(1, -1, 1, 1), at(1, 1, 1, 0), at(-1, 1, 0, 0)];
    // Counter-clockwise in the window; reversed under glFrontFace(GL_CW), so culling never takes a point.
    if (s.frontFace !== CCW) q.reverse();
    triangle(q[0], q[1], q[2], null);
    triangle(q[0], q[2], q[3], null);
  }
  function line(a, b) {
    const seg = clipUserSegment(clipNear([a, b]));
    if (seg.length < 2) return;
    if (webgl) { webgl.line(seg[0], seg[1], gpuState()); return; }
    const A = toWindow(seg[0]), B = toWindow(seg[1]);
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(B.x - A.x), Math.abs(B.y - A.y))));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, x = Math.floor(A.x + (B.x - A.x) * t), y = Math.floor(A.y + (B.y - A.y) * t);
      const [bx0, by0, bx1, by1] = drawBox();
      if (x < bx0 || y < by0 || x > bx1 || y > by1) continue;
      fragment(y * s.width + x, A.z + (B.z - A.z) * t, a.colour.map((v, i) => v + (b.colour[i] - v) * t), 0);
    }
  }
  function assemble(mode, v) {
    const flat = s.shade === FLAT;
    const tri = (a, b, c, provoking) => triangle(v[a], v[b], v[c], flat ? v[provoking] : null);
    switch (mode) {
      case 0x0001: for (let i = 0; i + 1 < v.length; i += 2) line(v[i], v[i + 1]); break;
      case 0x0003: for (let i = 0; i + 1 < v.length; i++) line(v[i], v[i + 1]); break;
      case 0x0002: for (let i = 0; i < v.length; i++) line(v[i], v[(i + 1) % v.length]); break;
      case 0x0004: for (let i = 0; i + 2 < v.length; i += 3) tri(i, i + 1, i + 2, i + 2); break;
      case 0x0005: for (let i = 0; i + 2 < v.length; i++) (i & 1) ? tri(i + 1, i, i + 2, i + 2) : tri(i, i + 1, i + 2, i + 2); break;
      case 0x0006: for (let i = 1; i + 1 < v.length; i++) tri(0, i, i + 1, i + 1); break;
      // A quad is cut along its 1-3 diagonal, as Mesa's index generation (gallium u_indices) cuts it:
      // the spec leaves the choice to the implementation, and it decides how four colours interpolate.
      // From ARRAYS (glDrawArrays, glDrawElements) Mesa cuts along 0-2 instead: those go through
      // gallium's u_indices as (0,1,2),(0,2,3); immediate mode is converted by vbo_exec to (0,1,3),(1,2,3).
      case 0x0007:
        if (s.fromArrays) for (let i = 0; i + 3 < v.length; i += 4) { tri(i, i + 1, i + 2, i + 3); tri(i, i + 2, i + 3, i + 3); }
        else for (let i = 0; i + 3 < v.length; i += 4) { tri(i, i + 1, i + 3, i + 3); tri(i + 1, i + 2, i + 3, i + 3); }
        break;
      case 0x0008: for (let i = 0; i + 3 < v.length; i += 2) { tri(i, i + 1, i + 3, i + 3); tri(i, i + 3, i + 2, i + 3); } break;
      case 0x0009: for (let i = 1; i + 1 < v.length; i++) tri(0, i, i + 1, 0); break;
      case 0x0000: for (const p of v) point(p); break;
      default: throw new Error(`gl: primitive 0x${mode.toString(16)} is not implemented`);
    }
  }
  /** What the GPU path needs of the fragment state, as one comparable value. */
  function gpuState() {
    if (gpuCache) return gpuCache;
    const t = s.caps.has(CAP.TEXTURE_2D) ? texture() : null, textured = !!(t && complete(t));
    if (textured && t.dirty) { webgl.upload(s.bound, t); t.dirty = false; }
    return gpuCache = {
      tex: textured ? s.bound : -1, base: textured ? t.base : '', env: s.envMode,
      min: textured ? t.min : 0, mag: textured ? t.mag : 0, wrapS: textured ? t.wrapS : 0, wrapT: textured ? t.wrapT : 0,
      blend: s.caps.has(CAP.BLEND) ? `${s.blend[0]},${s.blend[1]}` : '',
      alpha: s.caps.has(CAP.ALPHA_TEST) ? `${s.alphaFunc},${s.alphaRef}` : '',
      depth: s.caps.has(CAP.DEPTH_TEST) ? `${s.depthFunc},${s.depthMask}` : '',
      range: `${s.depthRange[0]},${s.depthRange[1]}`,
      scissor: s.caps.has(CAP.SCISSOR_TEST) ? s.scissor.join(',') : '',
      mask: s.colorMask.join(','),
      stencil: s.stencil && s.caps.has(CAP.STENCIL_TEST) ? `${s.stencilFunc.join(',')},${s.stencilOp.join(',')},${s.stencilWriteMask}` : '',
      offset: s.caps.has(CAP.POLYGON_OFFSET_FILL) ? s.polygonOffset.join(',') : '',
      fog: s.caps.has(CAP.FOG) ? `${s.fog.mode},${s.fog.density},${s.fog.start},${s.fog.end},${s.fog.colour.join(',')}` : '',
    };
  }

  // --- textures
  function toRGBA(format, w, h, ptr) {
    const u8 = M.u8, out = new Uint8Array(w * h * 4);
    const n = { [FMT.RGBA]: 4, [FMT.RGB]: 3, [FMT.LUMINANCE]: 1, [FMT.ALPHA]: 1, [FMT.LUMINANCE_ALPHA]: 2, [FMT.INTENSITY]: 1 }[format];
    if (!n) throw new Error(`gl: pixel format 0x${format.toString(16)} (colour index needs an extension PRISM does not advertise)`);
    const row = Math.ceil(w * n / s.unpackAlign) * s.unpackAlign;
    for (let i = 0; i < w * h; i++) {
      const p = ptr + Math.floor(i / w) * row + (i % w) * n, o = i * 4;
      if (format === FMT.RGBA) { out[o] = u8[p]; out[o + 1] = u8[p + 1]; out[o + 2] = u8[p + 2]; out[o + 3] = u8[p + 3]; }
      else if (format === FMT.RGB) { out[o] = u8[p]; out[o + 1] = u8[p + 1]; out[o + 2] = u8[p + 2]; out[o + 3] = 255; }
      else if (format === FMT.LUMINANCE || format === FMT.INTENSITY) { out[o] = out[o + 1] = out[o + 2] = u8[p]; out[o + 3] = format === FMT.INTENSITY ? u8[p] : 255; }
      else if (format === FMT.ALPHA) { out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = u8[p]; }
      else { out[o] = out[o + 1] = out[o + 2] = u8[p]; out[o + 3] = u8[p + 1]; }
    }
    return out;
  }

  // --- the commands. Each runs, or is recorded into the display list being compiled.
  const exec = {
    glClear: (mask) => {
      const sc = s.caps.has(CAP.SCISSOR_TEST) ? s.scissor : null;
      if (webgl) { webgl.clear(mask, s.clear, s.clearDepth, sc, s.colorMask, s.depthMask, s.stencil ? [s.clearStencil, s.stencilWriteMask] : null); return; }
      const x0 = sc ? Math.max(0, sc[0]) : 0, y0 = sc ? Math.max(0, sc[1]) : 0;
      const x1 = sc ? Math.min(s.width, sc[0] + sc[2]) : s.width, y1 = sc ? Math.min(s.height, sc[1] + sc[3]) : s.height;
      const c = s.clear.map((x) => Math.round(clamp01(x) * 255));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = y * s.width + x;
        if (mask & 0x4000) for (let k = 0; k < 4; k++) if (s.colorMask[k]) s.color[i * 4 + k] = c[k];
        if ((mask & 0x100) && s.depthMask) s.depth[i] = s.clearDepth;
        if ((mask & 0x400) && s.stencil) { const wm = s.stencilWriteMask & 0xff; s.stencil[i] = (s.stencil[i] & ~wm) | (s.clearStencil & wm); }
      }
    },
    glClearColor: (r, g, b, a) => { s.clear = [r, g, b, a].map(clamp01); },
    glEnable: (cap) => {
      if (s.activeUnit && UNIT_CAPS.has(cap)) return;
      // A capability this GL does not implement is said once, by number: enabling it changes nothing
      // here, and a picture that is wrong for that reason should be traceable to it.
      if (!KNOWN_CAPS.has(cap) && !(cap >= 0x4000 && cap < 0x4008) && !(cap >= 0x3000 && cap < 0x3006) && !s.unknownCaps.has(cap)) {
        s.unknownCaps.add(cap);
        console.warn(`gl: glEnable(0x${cap.toString(16)}) has no effect in this implementation`);
      }
      s.caps.add(cap);
    },
    glColorMaterial: (face, mode) => { s.colourMaterial = { face, mode }; },
    glDisable: (cap) => { if (s.activeUnit && UNIT_CAPS.has(cap)) return; s.caps.delete(cap); },
    glShadeModel: (m) => { s.shade = m; },
    glCullFace: (m) => { s.cullFace = m; },
    glFrontFace: (m) => { s.frontFace = m; },
    glViewport: (x, y, w, h) => { s.viewport = [x, y, w, h]; if (webgl) webgl.viewport(x, y, w, h); },
    glDepthFunc: (f) => { s.depthFunc = f; },
    glDepthMask: (m) => { s.depthMask = !!m; },
    glDepthRange: (n, f) => { s.depthRange = [clamp01(n), clamp01(f)]; },
    glClearDepth: (d) => { s.clearDepth = clamp01(d); },
    glAlphaFunc: (f, ref) => { s.alphaFunc = f; s.alphaRef = clamp01(ref); },
    glBlendFunc: (sf, df) => { s.blend = [sf, df]; },
    glMatrixMode: (m) => { if (!s.stacks[m]) throw new Error(`gl: glMatrixMode 0x${m.toString(16)}`); s.mode = m; },
    glLoadIdentity: () => setTop(ident()),
    glLoadMatrixf: (m) => setTop(Float64Array.from(m)),
    glMultMatrixf: (m) => setTop(mul(top(), Float64Array.from(m))),
    glMultMatrixd: (m) => setTop(mul(top(), Float64Array.from(m))),
    glLoadMatrixd: (m) => setTop(Float64Array.from(m)),
    glPushMatrix: () => { s.stacks[s.mode].push(Float64Array.from(top())); },
    /*
     * The attribute stacks, for the groups whose whole state is kept here: GL_ENABLE_BIT (every
     * capability) and GL_COLOR_BUFFER_BIT (the alpha test, blending, the colour mask, the clear
     * colour, and the enables of alpha test and blending) -- FTGL's buffer font brackets its drawing
     * with those two. Any other group is refused by name, not saved in part.
     */
    glPushAttrib: (mask) => {
      const other = mask & ~(0x2000 | 0x4000);
      if (other) throw new Error(`gl: glPushAttrib of the groups 0x${other.toString(16)} is not implemented (GL_ENABLE_BIT and GL_COLOR_BUFFER_BIT are)`);
      (s.attribStack ??= []).push({
        mask, caps: mask & 0x2000 ? new Set(s.caps) : null,
        colour: mask & 0x4000 ? { alphaFunc: s.alphaFunc, alphaRef: s.alphaRef, blend: [...s.blend], colorMask: [...s.colorMask], clear: [...s.clear],
          alphaOn: s.caps.has(CAP.ALPHA_TEST), blendOn: s.caps.has(CAP.BLEND) } : null,
      });
    },
    glPopAttrib: () => {
      const a = s.attribStack?.pop();
      if (!a) return;                                      // GL_STACK_UNDERFLOW: nothing changes
      if (a.caps) s.caps = new Set(a.caps);
      if (a.colour) {
        const c = a.colour;
        s.alphaFunc = c.alphaFunc; s.alphaRef = c.alphaRef; s.blend = c.blend; s.colorMask = c.colorMask; s.clear = c.clear;
        for (const [cap, on] of [[CAP.ALPHA_TEST, c.alphaOn], [CAP.BLEND, c.blendOn]]) { if (on) s.caps.add(cap); else s.caps.delete(cap); }
      }
    },
    // ...and the client's: the pixel store (both alignments) and the vertex arrays.
    glPushClientAttrib: (mask) => {
      const other = mask & ~(0x1 | 0x2);
      if (other) throw new Error(`gl: glPushClientAttrib of the groups 0x${other.toString(16)} is not implemented`);
      (s.clientAttribStack ??= []).push({ mask, unpackAlign: s.unpackAlign, packAlign: s.packAlign, arrays: mask & 0x2 ? JSON.parse(JSON.stringify(s.arrays)) : null });
    },
    glPopClientAttrib: () => {
      const a = s.clientAttribStack?.pop();
      if (!a) return;
      if (a.mask & 0x1) { s.unpackAlign = a.unpackAlign; s.packAlign = a.packAlign; }
      if (a.arrays) s.arrays = a.arrays;
    },
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
    glVertex3fv: (v) => vertex(v[0], v[1], v[2]),
    glVertex2f: (x, y) => vertex(x, y, 0),
    glNormal3f: (x, y, z) => { s.normal = [x, y, z]; },
    glColor3f: (r, g, b) => { s.colour = [r, g, b, 1]; },
    glColor4f: (r, g, b, a) => { s.colour = [r, g, b, a]; },
    glColor4fv: (v) => { s.colour = [v[0], v[1], v[2], v[3]]; },
    glColor3ubv: (v) => { s.colour = [v[0] / 255, v[1] / 255, v[2] / 255, 1]; },
    glTexCoord2f: (u, v) => { s.tex = [u, v]; },
    glTexCoord2fv: (v) => { s.tex = [v[0], v[1]]; },
    glTexCoord2d: (u, v) => { s.tex = [u, v]; },
    glTexCoord2dv: (v) => { s.tex = [v[0], v[1]]; },
    glColor3dv: (v) => { s.colour = [v[0], v[1], v[2], 1]; },
    // The double and integer spellings, converted to float on the way in as Mesa's entry points do.
    glColor3d: (r, g, b) => { s.colour = [Math.fround(r), Math.fround(g), Math.fround(b), 1]; },
    glColor3ub: (r, g, b) => { s.colour = [(r & 0xff) / 255, (g & 0xff) / 255, (b & 0xff) / 255, 1]; },
    glVertex2i: (x, y) => vertex(x, y, 0),
    glVertex2d: (x, y) => vertex(Math.fround(x), Math.fround(y), 0),
    glVertex3d: (x, y, z) => vertex(Math.fround(x), Math.fround(y), Math.fround(z)),
    glTranslated: (x, y, z) => exec.glTranslatef(Math.fround(x), Math.fround(y), Math.fround(z)),
    glRotated: (a, x, y, z) => exec.glRotatef(Math.fround(a), Math.fround(x), Math.fround(y), Math.fround(z)),
    glColor4dv: (v) => { s.colour = [v[0], v[1], v[2], v[3]]; },
    glVertex2dv: (v) => vertex(v[0], v[1], 0),
    glVertex3dv: (v) => vertex(v[0], v[1], v[2]),
    glNormal3fv: (v) => { s.normal = [v[0], v[1], v[2]]; },
    // glRect: one polygon in the z = 0 plane, counter-clockwise from (x1, y1).
    glRectf: (x1, y1, x2, y2) => { exec.glBegin(0x0009); vertex(x1, y1, 0); vertex(x2, y1, 0); vertex(x2, y2, 0); vertex(x1, y2, 0); exec.glEnd(); },
    glRecti: (x1, y1, x2, y2) => exec.glRectf(x1, y1, x2, y2),
    glLightf: (li, pname, v) => exec.glLightfv(li, pname, [v]),
    glMaterialf: (face, pname, v) => exec.glMaterialfv(face, pname, [v]),
    // The alignments are kept; the other modes (swap, LSB first, row length, skips -- 0x0cf0-0x0cf4,
    // 0x0d00-0x0d04) are accepted at their defaults only, as GLU restores them, and refused otherwise.
    glPixelStorei: (p, v) => {
      if (p === 0x0cf5) s.unpackAlign = v;
      else if (p === 0x0d05) s.packAlign = v;
      else if (!(((p >= 0x0cf0 && p <= 0x0cf4) || (p >= 0x0d00 && p <= 0x0d04)) && v === 0)) throw new Error(`gl: glPixelStorei 0x${p.toString(16)} = ${v}`);
    },
    // Texture coordinate generation: GL_OBJECT_LINEAR, the mode a terrain textured by position uses.
    glTexGeni: (coord, pname, v) => {
      const g = s.texGen[coord - 0x2000];
      if (!g || pname !== 0x2500) throw new Error(`gl: glTexGeni 0x${coord.toString(16)} 0x${pname.toString(16)}`);
      if (v !== 0x2401 && v !== 0x2402) throw new Error(`gl: texture generation mode 0x${v.toString(16)} (GL_EYE_LINEAR is not implemented)`);
      g.mode = v;
    },
    glTexGenfv: (coord, pname, v) => {
      const g = s.texGen[coord - 0x2000];
      if (!g) throw new Error(`gl: glTexGenfv coordinate 0x${coord.toString(16)}`);
      if (pname === 0x2501) g.object = v; else if (pname === 0x2500) exec.glTexGeni(coord, pname, v[0]);
      else throw new Error(`gl: glTexGenfv 0x${pname.toString(16)} (eye planes are not implemented)`);
    },
    glLightfv: (li, pname, v) => {
      const L = s.lights[li - CAP.LIGHT0];
      if (!L) throw new Error(`gl: light 0x${li.toString(16)}`);
      if (pname === PNAME.POSITION) {
        const e = xform(s.stacks[MODELVIEW].at(-1), v[0], v[1], v[2], v[3]);
        L.position = e[3] === 0 ? [e[0], e[1], e[2], 0] : [e[0] / e[3], e[1] / e[3], e[2] / e[3], 1];
      } else if (pname === PNAME.AMBIENT) L.ambient = v;
      else if (pname === PNAME.DIFFUSE) L.diffuse = v;
      else if (pname === PNAME.SPECULAR) L.specular = v;
      // A spotlight's cone and a light's attenuation. A program may set them to their defaults -- Tux
      // Racer sets every parameter of every light -- and only a cone narrower than 180 degrees would
      // change the picture beyond what is implemented; that is refused, not approximated.
      else if (pname === 0x1204) L.spotDirection = v;
      else if (pname === 0x1205) L.spotExponent = v[0];
      else if (pname === 0x1206) { if (v[0] !== 180) throw new Error('gl: spotlights (GL_SPOT_CUTOFF other than 180) are not implemented'); }
      else if (pname === 0x1207 || pname === 0x1208 || pname === 0x1209) (L.attenuation ??= [1, 0, 0])[pname - 0x1207] = v[0];
      else throw new Error(`gl: glLightfv pname 0x${pname.toString(16)}`);
    },
    glMaterialfv: (face, pname, v) => {
      for (const m of face === FRONT ? [s.material] : face === BACK ? [s.backMaterial] : [s.material, s.backMaterial]) {
        if (pname === PNAME.AMBIENT_AND_DIFFUSE) { m.ambient = v; m.diffuse = v; }
        else if (pname === PNAME.AMBIENT) m.ambient = v;
        else if (pname === PNAME.DIFFUSE) m.diffuse = v;
        else if (pname === PNAME.SPECULAR) m.specular = v;
        else if (pname === PNAME.EMISSION) m.emission = v;
        else if (pname === PNAME.SHININESS) m.shininess = v[0];
        else throw new Error(`gl: glMaterialfv pname 0x${pname.toString(16)}`);
      }
    },
    glLightModelfv: (pname, v) => {
      if (pname === LIGHT_MODEL.AMBIENT) s.sceneAmbient = v;
      else if (pname === LIGHT_MODEL.TWO_SIDE) s.twoSide = v[0] !== 0;
      else if (pname === LIGHT_MODEL.LOCAL_VIEWER) { if (v[0] !== 0) throw new Error('gl: GL_LIGHT_MODEL_LOCAL_VIEWER is not implemented'); }
      /*
       * GL_SEPARATE_SPECULAR_COLOR (GL 1.2): the specular term added AFTER texturing instead of
       * before. Kept; not yet drawn so -- the specular is in the one colour as with GL_SINGLE_COLOR,
       * which a lit TEXTURED face shows as a highlight modulated by its texel.
       */
      else if (pname === 0x81f8) s.colourControl = v[0];
      else throw new Error(`gl: glLightModel pname 0x${pname.toString(16)}`);
    },
    glLightModelf: (pname, v) => exec.glLightModelfv(pname, [v]),
    glLightModeli: (pname, v) => exec.glLightModelfv(pname, [v]),
    glFogf: (p, v) => { if (p === FOG.MODE) s.fog.mode = v; else if (p === FOG.DENSITY) s.fog.density = v; else if (p === FOG.START) s.fog.start = v; else if (p === FOG.END) s.fog.end = v; },
    glFogi: (p, v) => exec.glFogf(p, v),
    glFogfv: (p, v) => { if (p === FOG.COLOR) s.fog.colour = v.map(clamp01); else exec.glFogf(p, v[0]); },
    glBindTexture: (target, id) => {
      if (s.activeUnit) return;
      if (target !== CAP.TEXTURE_2D) throw new Error(`gl: texture target 0x${target.toString(16)}`);
      if (!s.textures.has(id)) s.textures.set(id, newTexture());
      s.bound = id;
    },
    glTexParameterf: (target, p, v) => {
      const t = texture();
      if (p === TEX.MIN) t.min = v; else if (p === TEX.MAG) t.mag = v;
      else if (p === TEX.WRAP_S) t.wrapS = v; else if (p === TEX.WRAP_T) t.wrapT = v;
      else throw new Error(`gl: glTexParameter 0x${p.toString(16)}`);
      t.dirty = true;
    },
    glScissor: (x, y, w, h) => { s.scissor = [x, y, w, h]; },
    glPointSize: (v) => { s.pointSize = v; },
    glPointParameterfvARB: (p, v) => {
      if (p === 0x8126) s.pointMin = v[0];                    // GL_POINT_SIZE_MIN
      else if (p === 0x8127) s.pointMax = v[0];               // GL_POINT_SIZE_MAX
      else if (p === 0x8128) {}                               // GL_POINT_FADE_THRESHOLD_SIZE: no multisampling to fade into
      else if (p === 0x8129) s.pointAtten = [v[0], v[1], v[2]];   // GL_POINT_DISTANCE_ATTENUATION
      else throw new Error(`gl: glPointParameter 0x${p.toString(16)}`);
    },
    glPointParameterfARB: (p, v) => exec.glPointParameterfvARB(p, [v]),
    glActiveTextureARB: (unit) => { s.activeUnit = unit - 0x84c0; },
    glClientActiveTextureARB: (unit) => { s.clientUnit = unit - 0x84c0; },
    glColor3fv: (v) => { s.colour = [v[0], v[1], v[2], 1]; },
    glColor4ubv: (v) => { s.colour = [v[0] / 255, v[1] / 255, v[2] / 255, v[3] / 255]; },
    glColor4ub: (r, g, b, a) => { s.colour = [(r & 255) / 255, (g & 255) / 255, (b & 255) / 255, (a & 255) / 255]; },
    glEnableClientState: (cap) => { if (ARRAY[cap] !== 'tex' || !s.clientUnit) s.arrays[ARRAY[cap]].on = true; },
    glDisableClientState: (cap) => { if (ARRAY[cap] !== 'tex' || !s.clientUnit) s.arrays[ARRAY[cap]].on = false; },
    glVertexPointer: (size, type, stride, ptr) => { Object.assign(s.arrays.vertex, { size, type, stride, ...inBuffer(ptr) }); },
    glColorPointer: (size, type, stride, ptr) => { Object.assign(s.arrays.color, { size, type, stride, ...inBuffer(ptr) }); },
    glTexCoordPointer: (size, type, stride, ptr) => { if (!s.clientUnit) Object.assign(s.arrays.tex, { size, type, stride, ...inBuffer(ptr) }); },
    glNormalPointer: (type, stride, ptr) => { Object.assign(s.arrays.normal, { size: 3, type, stride, ...inBuffer(ptr) }); },
    // One element of the enabled arrays, as if its colour, texture coordinate and vertex were given.
    glArrayElement: (i) => {
      // Component k of element i of array a: called per vertex of every glDrawElements, so no allocation.
      /*
       * Every type GL 1.1 allows an array (2.8): bytes, shorts and ints, signed or not, floats and
       * doubles. A colour or a normal of an integer type is NORMALIZED (2.13, Table 2.6: the largest
       * value is 1.0, a signed one maps -max-1..max onto -1..1); a position or a texture coordinate
       * is the number itself. Neverball's interface sends GL_SHORT positions, read as floats before.
       */
      const d = dv(), u8 = M.u8;
      const at = (a, k, norm) => {
        const n = TYPE_BYTES[a.type], p = a.ptr + i * (a.stride || a.size * n) + n * k;
        switch (a.type) {
          case 0x1406: return d.getFloat32(p, true);
          case 0x1401: return norm ? u8[p] / 255 : u8[p];
          case 0x1400: { const v = d.getInt8(p); return norm ? (2 * v + 1) / 255 : v; }
          case 0x1402: { const v = d.getInt16(p, true); return norm ? (2 * v + 1) / 65535 : v; }
          case 0x1403: { const v = d.getUint16(p, true); return norm ? v / 65535 : v; }
          case 0x1404: { const v = d.getInt32(p, true); return norm ? (2 * v + 1) / 4294967295 : v; }
          case 0x1405: { const v = d.getUint32(p, true); return norm ? v / 4294967295 : v; }
          case 0x140a: return d.getFloat64(p, true);
          default: throw new Error(`gl: array type 0x${a.type.toString(16)}`);
        }
      };
      const { vertex: va, color: ca, tex: ta, normal: na } = s.arrays;
      if (na.on) s.normal = [at(na, 0, true), at(na, 1, true), at(na, 2, true)];
      if (ca.on) s.colour = [at(ca, 0, true), at(ca, 1, true), at(ca, 2, true), ca.size > 3 ? at(ca, 3, true) : 1];
      if (ta.on) s.tex = [at(ta, 0, false), ta.size > 1 ? at(ta, 1, false) : 0];
      if (va.on) vertex(at(va, 0, false), at(va, 1, false), va.size > 2 ? at(va, 2, false) : 0);
    },
    // GL_EXT_compiled_vertex_array: a lock is a promise the program makes, which nothing here relies on.
    glLockArraysEXT: () => {},
    glUnlockArraysEXT: () => {},
    glTexEnvf: (target, p, v) => {
      if (target === 0x8861 && p === 0x8862) { s.coordReplace = !!v; return; }   // GL_POINT_SPRITE, GL_COORD_REPLACE
      if (s.activeUnit) return;
      if (p === TEX.ENV_MODE) s.envMode = v; else throw new Error(`gl: glTexEnv 0x${p.toString(16)}`);
    },
    glTexEnvi: (target, p, v) => exec.glTexEnvf(target, p, v),
    glTexParameteri: (target, p, v) => exec.glTexParameterf(target, p, v),
    glTexImage2D: (target, level, internal, w, h, border, format, type, texels) => {
      const t = texture();
      t.base = baseFormat(internal);
      t.levels[level] = { w, h, data: texels ?? new Uint8Array(w * h * 4) };
      t.dirty = true;
    },
    glColorMask: (r, g, b, a) => { s.colorMask = [!!r, !!g, !!b, !!a]; },
    glPolygonOffset: (factor, units) => { s.polygonOffset = [factor, units]; },
    // The plane is given in object space and kept in eye space, by the modelview current NOW (2.11).
    glClipPlane: (plane, eq) => {
      const i = plane - CAP.CLIP_PLANE0;
      if (i < 0 || i > 5) throw new Error(`gl: clip plane 0x${plane.toString(16)}`);
      const inv = invert4(s.stacks[MODELVIEW].at(-1));
      s.clipPlanes[i] = [0, 1, 2, 3].map((c) => eq[0] * inv[c * 4] + eq[1] * inv[c * 4 + 1] + eq[2] * inv[c * 4 + 2] + eq[3] * inv[c * 4 + 3]);
    },
    glLineWidth: (w) => { s.lineWidth = w; },
    // The stencil state is kept whether or not there are stencil bits; without them it changes no pixel.
    glStencilFunc: (fn, ref, mask) => { s.stencilFunc = [fn, ref, mask >>> 0]; },
    glStencilOp: (fail, zfail, zpass) => { s.stencilOp = [fail, zfail, zpass]; },
    glStencilMask: (m) => { s.stencilWriteMask = m >>> 0; },
    glClearStencil: (v) => { s.clearStencil = v; },
    glTexParameterfv: (target, p, v) => {
      if (p === 0x1004) { texture().border = v; return; }   // GL_TEXTURE_BORDER_COLOR, kept with the texture
      exec.glTexParameterf(target, p, v[0]);
    },
    glCallList: (n) => { for (const [name, args] of s.lists.get(n) ?? []) exec[name](...args); },
  };
  // Array arguments are read at CALL time, so a display list keeps the values (the spec's copy rule).
  const ARRAYS = {
    glLightfv: (a) => [a[0], a[1], f32(a[2], a[1] === PNAME.SHININESS ? 1 : 4)],
    glMaterialfv: (a) => [a[0], a[1], f32(a[2], a[1] === PNAME.SHININESS ? 1 : 4)],
    glFogfv: (a) => [a[0], f32(a[1], a[0] === FOG.COLOR ? 4 : 1)],
    glLightModelfv: (a) => [a[0], f32(a[1], a[0] === LIGHT_MODEL.AMBIENT ? 4 : 1)],
    glVertex3fv: (a) => [f32(a[0], 3)], glTexCoord2fv: (a) => [f32(a[0], 2)], glColor4fv: (a) => [f32(a[0], 4)],
    glColor3ubv: (a) => [[M.u8[a[0]], M.u8[a[0] + 1], M.u8[a[0] + 2]]],
    glColor4ubv: (a) => [[M.u8[a[0]], M.u8[a[0] + 1], M.u8[a[0] + 2], M.u8[a[0] + 3]]],
    glColor3fv: (a) => [f32(a[0], 3)],
    glLoadMatrixf: (a) => [f32(a[0], 16)],
    glMultMatrixf: (a) => [f32(a[0], 16)],
    glMultMatrixd: (a) => [Array.from({ length: 16 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))],
    glLoadMatrixd: (a) => [Array.from({ length: 16 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))],
    glTexCoord2dv: (a) => [Array.from({ length: 2 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))], glColor3dv: (a) => [Array.from({ length: 3 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))], glColor4dv: (a) => [Array.from({ length: 4 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))],
    glVertex2dv: (a) => [Array.from({ length: 2 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))], glVertex3dv: (a) => [Array.from({ length: 3 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))], glNormal3fv: (a) => [f32(a[0], 3)],
    glTexGenfv: (a) => [a[0], a[1], f32(a[2], a[1] === 0x2500 ? 1 : 4)],
    glClipPlane: (a) => [a[0], Array.from({ length: 4 }, (_, k) => dv().getFloat64(a[1] + 8 * k, true))],
    glTexParameterfv: (a) => [a[0], a[1], f32(a[2], a[1] === 0x1004 ? 4 : 1)],
    glPointParameterfvARB: (a) => [a[0], f32(a[1], a[0] === 0x8129 ? 3 : 1)],
    glTexImage2D: (a) => {
      if (a[7] !== 0x1401) throw new Error(`gl: texel type 0x${a[7].toString(16)} (only GL_UNSIGNED_BYTE)`);
      return [...a.slice(0, 8), a[8] ? toRGBA(a[6], a[3], a[4], a[8]) : null];
    },
  };
  // Only these leave the fragment state alone; every other command may change it, display lists included.
  const VERTEX_ONLY = new Set(['glBegin', 'glEnd', 'glVertex2f', 'glVertex3f', 'glVertex3fv', 'glNormal3f',
    'glColor3f', 'glColor4f', 'glColor3fv', 'glColor4fv', 'glColor3ubv', 'glColor4ubv', 'glTexCoord2f', 'glTexCoord2fv',
    'glArrayElement', 'glLockArraysEXT', 'glUnlockArraysEXT', 'glTexCoord2d', 'glTexCoord2dv', 'glColor3dv', 'glColor4dv',
    'glVertex2dv', 'glVertex3dv', 'glNormal3fv']);
  for (const name of Object.keys(exec)) {
    if (VERTEX_ONLY.has(name)) continue;
    const run = exec[name];
    exec[name] = (...a) => { gpuCache = null; return run(...a); };
  }
  const api = {};
  for (const name of Object.keys(exec)) {
    api[name] = (...a) => {
      if (ARRAYS[name]) a = ARRAYS[name](a);
      if (s.recording) { s.recording.push([name, a]); if (s.recordMode !== COMPILE_AND_EXECUTE) return; }
      exec[name](...a);
    };
  }
  const readFramebuffer = () => (webgl ? webgl.read() : s.color);  // bottom row first
  Object.assign(api, {
    glGenLists: (range) => { const first = s.nextList; s.nextList += range; return first; },
    glNewList: (n, mode) => { s.recording = []; s.recordMode = mode; s.recordingId = n; },
    glEndList: () => { s.lists.set(s.recordingId, s.recording); s.recording = null; },
    glDeleteLists: (n, range) => { for (let k = 0; k < range; k++) s.lists.delete(n + k); },
    glGetString: (name) => {
      const text = { 0x1f00: 'PRISM', 0x1f01: 'PRISM software rasteriser', 0x1f02: version, 0x1f03: extensionString }[name];
      if (text === undefined) return 0;
      if (!s.strings.has(name)) s.strings.set(name, M.mod.intern([...new TextEncoder().encode(text), 0]));
      return s.strings.get(name);
    },
    glGetFloatv: (p, out) => {
      const m = p === 0x0ba6 ? s.stacks[MODELVIEW].at(-1) : p === 0x0ba7 ? s.stacks[PROJECTION].at(-1) : null;
      if (!m) throw new Error(`gl: glGetFloatv 0x${p.toString(16)}`);
      for (let k = 0; k < 16; k++) dv().setFloat32(out + 4 * k, m[k], true);
    },
    // The same matrices as doubles: Mesa keeps them as floats and widens them.
    glGetDoublev: (p, out) => {
      const m = p === 0x0ba6 ? s.stacks[MODELVIEW].at(-1) : p === 0x0ba7 ? s.stacks[PROJECTION].at(-1) : null;
      if (!m) throw new Error(`gl: glGetDoublev 0x${p.toString(16)}`);
      for (let k = 0; k < 16; k++) dv().setFloat64(out + 8 * k, Math.fround(m[k]), true);
    },
    glTexSubImage2D: (target, level, x, y, w, h, format, type, ptr) => {
      const t = texture(), L = t.levels[level], src = toRGBA(format, w, h, ptr);
      for (let j = 0; j < h; j++) L.data.set(src.subarray(j * w * 4, (j + 1) * w * 4), ((y + j) * L.w + x) * 4);
      t.dirty = true;
    },
    glReadPixels: (x, y, w, h, format, type, out) => {
      // The depth buffer, as floats in [0, 1]: Cube reads the one under its crosshair every frame.
      if (format === 0x1902 && type === 0x1406) {
        readFramebuffer();                                   // whatever is pending is drawn first
        const d = webgl ? webgl.readDepth(x, y, w, h) : null;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) dv().setFloat32(out + 4 * (j * w + i), d ? d[j * w + i] : s.depth[(y + j) * s.width + x + i], true);
        return;
      }
      const fb = readFramebuffer(), n = format === FMT.RGBA ? 4 : format === FMT.RGB ? 3 : 0;
      if (!n || type !== 0x1401) throw new Error('gl: glReadPixels wants GL_RGB or GL_RGBA, GL_UNSIGNED_BYTE');
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const o = ((y + j) * s.width + x + i) * 4, d = out + (j * w + i) * n;
        for (let k = 0; k < n; k++) M.u8[d + k] = fb[o + k];
      }
    },
    glDeleteTextures: (n, ids) => { for (let k = 0; k < n; k++) { const id = dv().getUint32(ids + 4 * k, true); if (id) { s.textures.delete(id); s.genTextures.delete(id); if (s.bound === id) s.bound = 0; } } },
    glGetError: () => 0,
    glGetBooleanv: (p, out) => {
      const v = p === 0x0c32 ? 1 : p === 0x0b72 ? +s.depthMask : s.caps.has(p) ? 1 : null;   // DOUBLEBUFFER, DEPTH_WRITEMASK, a capability
      if (v === null) throw new Error(`gl: glGetBooleanv 0x${p.toString(16)}`);
      M.u8[out] = v;
    },
    glGetTexLevelParameteriv: (target, level, p, out) => {
      const L = texture()?.levels[level];
      const v = p === 0x1000 ? (L?.w ?? 0) : p === 0x1001 ? (L?.h ?? 0) : null;
      if (v === null) throw new Error(`gl: glGetTexLevelParameteriv 0x${p.toString(16)}`);
      dv().setInt32(out, v, true);
    },
    /*
     * The integer state Quake III asks for. MAX_TEXTURE_SIZE: this layer has no limit of its own and
     * answers what Mesa 22's llvmpipe answers, 16384, so the program and its reference size images
     * alike. Any other name is refused, naming itself.
     */
    glGetIntegerv: (p, out) => {
      // The pixel store: the two alignments kept, the other modes 0 (glPixelStorei accepts only that).
      const store = p === 0x0cf5 ? [s.unpackAlign] : p === 0x0d05 ? [s.packAlign] : (p >= 0x0cf0 && p <= 0x0cf4) || (p >= 0x0d00 && p <= 0x0d04) ? [0] : null;
      const vals = store ? store : p === 0x0d57 ? [s.stencilBits] : p === 0x0d33 ? [16384] : p === 0x0ba2 ? s.viewport : p === 0x0d32 ? [6] : p === 0x84e2 ? [1] : null;
      if (!vals) throw new Error(`gl: glGetIntegerv 0x${p.toString(16)}`);
      vals.forEach((v, k) => dv().setInt32(out + 4 * k, v, true));
    },
    // glDrawElements: the enabled arrays, element by element, as if each index were glArrayElement.
    // The arrays' elements first..first+count-1, between a Begin and an End of the mode.
    glDrawArrays: (mode, first, count) => {
      if (s.recording) throw new Error('gl: glDrawArrays inside a display list is not implemented');
      exec.glBegin(mode);
      for (let i = 0; i < count; i++) exec.glArrayElement(first + i);
      s.fromArrays = true; exec.glEnd(); s.fromArrays = false;
    },
    glDrawElements: (mode, count, type, ptr) => {
      if (s.elementBuffer) ptr += s.buffers.get(s.elementBuffer).ptr;
      if (s.recording) throw new Error('gl: glDrawElements inside a display list is not implemented');
      const size = type === 0x1405 ? 4 : type === 0x1403 ? 2 : type === 0x1401 ? 1 : 0;
      if (!size) throw new Error(`gl: glDrawElements index type 0x${type.toString(16)}`);
      exec.glBegin(mode);
      /*
       * One index is one vertex: within a call the arrays cannot change, so an index met again reuses
       * the vertex already transformed and lit (the front end never alters a vertex once made). Quake
       * III's triangle lists name most vertices several times.
       */
      // Reused across calls and stamped with a generation, so a call allocates nothing.
      const gen = ++drawGen;
      for (let i = 0; i < count; i++) {
        const at = ptr + i * size;
        const ix = size === 4 ? dv().getUint32(at, true) : size === 2 ? dv().getUint16(at, true) : M.u8[at];
        if (drawStamp[ix] === gen) { s.verts.push(drawSeen[ix]); continue; }
        const before = s.verts.length;
        exec.glArrayElement(ix);
        if (s.verts.length > before) { drawStamp[ix] = gen; drawSeen[ix] = s.verts.at(-1); }   // no vertex array, no vertex
      }
      s.fromArrays = true; exec.glEnd(); s.fromArrays = false;
    },
    glIsTexture: (id) => (id && s.textures.has(id) ? 1 : 0),
    glIsEnabled: (cap) => (s.caps.has(cap) ? 1 : 0),
    // The front or back material's property, as glMaterialfv left it (GL_COLOR_MATERIAL included).
    glGetMaterialfv: (face, pname, out) => {
      const m = face === BACK ? s.backMaterial : s.material;
      const v = pname === PNAME.AMBIENT ? m.ambient : pname === PNAME.DIFFUSE ? m.diffuse : pname === PNAME.SPECULAR ? m.specular
        : pname === PNAME.EMISSION ? m.emission : pname === PNAME.SHININESS ? [m.shininess] : null;
      if (!v) throw new Error(`gl: glGetMaterialfv pname 0x${pname.toString(16)}`);
      v.forEach((x, k) => dv().setFloat32(out + 4 * k, x, true));
    },
    glGenBuffersARB: (n, out) => {
      for (let k = 0; k < n; k++) {
        while (s.buffers.has(s.nextBuffer)) s.nextBuffer++;
        s.buffers.set(s.nextBuffer, { ptr: 0, size: 0 });
        dv().setUint32(out + 4 * k, s.nextBuffer++, true);
      }
    },
    glBindBufferARB: (target, id) => {
      if (id && !s.buffers.has(id)) s.buffers.set(id, { ptr: 0, size: 0 });
      if (target === 0x8892) s.arrayBuffer = id; else if (target === 0x8893) s.elementBuffer = id;
      else throw new Error(`gl: buffer target 0x${target.toString(16)}`);
    },
    // New storage, filled from `data` or left zero; an array pointing into the old one follows it.
    glBufferDataARB: (target, size, data) => {
      const id = target === 0x8892 ? s.arrayBuffer : s.elementBuffer, b = s.buffers.get(id);
      if (!b) throw new Error('gl: glBufferData with no buffer bound');
      const old = b.ptr;
      if (old) M.rt.free(old);
      b.ptr = size ? M.rt.calloc(1, size) : 0; b.size = size;
      if (data && size) M.u8.copyWithin(b.ptr, data, data + size);
      for (const a of Object.values(s.arrays)) if (a.buffer === id) a.ptr = b.ptr + a.offset;
    },
    glBufferSubDataARB: (target, offset, size, data) => {
      const b = s.buffers.get(target === 0x8892 ? s.arrayBuffer : s.elementBuffer);
      if (!b || offset + size > b.size) throw new Error('gl: glBufferSubData outside the buffer');
      M.u8.copyWithin(b.ptr + offset, data, data + size);
    },
    glDeleteBuffersARB: (n, ids) => {
      for (let k = 0; k < n; k++) {
        const id = dv().getUint32(ids + 4 * k, true), b = s.buffers.get(id);
        if (!b) continue;
        if (b.ptr) M.rt.free(b.ptr);
        s.buffers.delete(id);
        if (s.arrayBuffer === id) s.arrayBuffer = 0;
        if (s.elementBuffer === id) s.elementBuffer = 0;
      }
    },
    glIsBufferARB: (id) => (id && s.buffers.has(id) ? 1 : 0),
    // Names no texture uses and none handed out before; they become textures when first bound (GL 1.1, 3.8.8).
    glGenTextures: (n, out) => {
      for (let k = 0; k < n; k++) {
        while (s.textures.has(s.nextTexture) || s.genTextures.has(s.nextTexture)) s.nextTexture++;
        s.genTextures.add(s.nextTexture);
        dv().setUint32(out + 4 * k, s.nextTexture, true);
      }
    },
    glPolygonMode: (face, mode) => { if (mode !== 0x1b02) throw new Error('gl: glPolygonMode other than GL_FILL is not implemented'); },
    glHint: () => {}, glDrawBuffer: () => {}, glReadBuffer: () => {},
    glFinish: () => {}, glFlush: () => {},
  });
  Object.assign(M.rt, api);

  const gl = {
    state: s, resize,
    /** The picture, top row first, RGBA -- GL's framebuffer is bottom row first. */
    readPixels() {
      const out = new Uint8Array(s.width * s.height * 4), src = readFramebuffer();
      for (let y = 0; y < s.height; y++) out.set(src.subarray((s.height - 1 - y) * s.width * 4, (s.height - y) * s.width * 4), y * s.width * 4);
      return out;
    },
    onFrame,
    get backend() { return webgl ? 'webgl' : 'soft'; },
    /** The WebGL frame as an ImageBitmap (makeWebGL's present); null on the software rasteriser. */
    present() { recoverIfLost(); return webgl ? webgl.present() : null; },
    /** For a test of the recovery: lose the context now (the next frame rebuilds it). */
    loseContext() { webgl?.lose(); },
    /** Stencil bits for the next resize: the window system's visual (glut.js on GLUT_STENCIL). */
    set stencilBits(n) { s.stencilBits = n; },
  };
  M.gl = gl;
  return gl;
}

/*
 * THE GPU PATH. Everything up to rasterisation stays in JavaScript -- transformation, lighting,
 * clipping, culling, the provoking vertex -- because that is the part the gates hold to Mesa;
 * WebGL2 is handed the result as triangles and lines in CLIP space with their colours, texture
 * coordinates and eye distance (a flat triangle carries its provoking colour on all three vertices),
 * and does what a GPU is for: rasterise, sample, test, blend. One shader pair implements the fixed
 * fragment pipeline in the specification's order; the state it needs travels with each batch, and a
 * batch is flushed whenever that state changes, on a clear or viewport change, and on read-back.
 */
function makeWebGL(w, h, stencilBuffer = false) {
  const canvas = new OffscreenCanvas(w, h);
  // No alpha: the canvas is what present() hands the page, and a GL window is opaque -- with one, the
  // alpha the program's fragments left (gears' lit faces are below 1) showed the page through them.
  const g = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, preserveDrawingBuffer: true });
  if (!g) throw new Error('gl: this browser has no WebGL2 for an OffscreenCanvas');
  // The GPU can take the context away (a driver reset, memory pressure): noticed here, rebuilt by
  // installGL at the next frame. preventDefault is what lets a context be restored at all.
  let lost = false;
  canvas.addEventListener?.('webglcontextlost', (e) => { e.preventDefault(); lost = true; });   // ?. for gate-webgl-stream's stand-in
  /*
   * The program draws into a framebuffer of its own, not the canvas's: WebGL2 cannot read a depth
   * buffer back, and Cube reads the one under its crosshair every frame. So the depth (and stencil)
   * is a texture, which readDepth() samples. Nothing shows the canvas itself -- every host takes the
   * frame through read() -- so this costs the picture nothing.
   */
  const target = g.createFramebuffer();
  g.bindFramebuffer(g.FRAMEBUFFER, target);
  const colourBuffer = g.createRenderbuffer();
  g.bindRenderbuffer(g.RENDERBUFFER, colourBuffer);
  g.renderbufferStorage(g.RENDERBUFFER, g.RGBA8, w, h);
  g.framebufferRenderbuffer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.RENDERBUFFER, colourBuffer);
  const depthTex = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, depthTex);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
  if (stencilBuffer) {
    g.texImage2D(g.TEXTURE_2D, 0, g.DEPTH24_STENCIL8, w, h, 0, g.DEPTH_STENCIL, g.UNSIGNED_INT_24_8, null);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.DEPTH_STENCIL_ATTACHMENT, g.TEXTURE_2D, depthTex, 0);
  } else {
    g.texImage2D(g.TEXTURE_2D, 0, g.DEPTH_COMPONENT24, w, h, 0, g.DEPTH_COMPONENT, g.UNSIGNED_INT, null);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.DEPTH_ATTACHMENT, g.TEXTURE_2D, depthTex, 0);
  }
  g.bindTexture(g.TEXTURE_2D, null);
  const shader = (type, src) => {
    const sh = g.createShader(type);
    g.shaderSource(sh, src); g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error(`gl: shader: ${g.getShaderInfoLog(sh)}`);
    return sh;
  };
  const prog = g.createProgram();
  g.attachShader(prog, shader(g.VERTEX_SHADER, `#version 300 es
in vec4 pos; in vec4 col; in vec2 tc; in float ez;
out vec4 v; out vec2 uv; out float eyeZ;
uniform int zFlip;     // 1 while glDepthRange is reversed (near > far); see apply()
void main() { gl_Position = vec4(pos.xy, zFlip == 1 ? -pos.z : pos.z, pos.w); v = col; uv = tc; eyeZ = ez; }`));
  g.attachShader(prog, shader(g.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec4 v; in vec2 uv; in float eyeZ; out vec4 o;
uniform sampler2D tex;
uniform int textured, base, env, alphaFn, fogMode;   // base: 0 RGB 1 RGBA 2 L 3 LA 4 A 5 I; env: 0 MODULATE 1 REPLACE 2 DECAL
uniform float alphaRef, fogDensity, fogStart, fogEnd;
uniform vec4 fogColour;
bool cmp(int f, float a, float b) {
  if (f == 0) return false; if (f == 1) return a < b; if (f == 2) return a == b; if (f == 3) return a <= b;
  if (f == 4) return a > b; if (f == 5) return a != b; if (f == 6) return a >= b; return true;
}
void main() {
  vec4 c = v;
  if (textured == 1) {
    vec4 t = texture(tex, uv);
    if (base == 5) t = vec4(t.r); else if (base == 2) t = vec4(t.rrr, 1.0); else if (base == 3) t = vec4(t.rrr, t.a);
    bool hasA = base == 1 || base == 3 || base == 4 || base == 5;
    if (env == 1) { c = base == 4 ? vec4(c.rgb, t.a) : vec4(t.rgb, hasA ? t.a : c.a); }
    else if (env == 2) { c = base == 0 ? vec4(t.rgb, c.a) : vec4(mix(c.rgb, t.rgb, t.a), c.a); }
    else { c = base == 4 ? vec4(c.rgb, c.a * t.a) : vec4(c.rgb * t.rgb, hasA ? c.a * t.a : c.a); }
  }
  if (fogMode != 0) {
    float f = fogMode == 1 ? (fogEnd - eyeZ) / (fogEnd - fogStart) : fogMode == 2 ? exp(-fogDensity * eyeZ) : exp(-pow(fogDensity * eyeZ, 2.0));
    f = clamp(f, 0.0, 1.0);
    c = vec4(mix(fogColour.rgb, c.rgb, f), c.a);
  }
  if (alphaFn >= 0 && !cmp(alphaFn, c.a, alphaRef)) discard;
  o = c;
}`));
  ['pos', 'col', 'tc', 'ez'].forEach((n, i) => g.bindAttribLocation(prog, i, n));
  g.linkProgram(prog);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(`gl: link: ${g.getProgramInfoLog(prog)}`);
  /*
   * The depth probe: a triangle over the probed rectangle that fetches each texel of the depth
   * texture and writes its 24 bits as three bytes of an RGBA8 target -- the integer GL keeps, which
   * GL_FLOAT then reads as k / (2^24 - 1), as Mesa does.
   */
  const probe = g.createProgram();
  g.attachShader(probe, shader(g.VERTEX_SHADER, `#version 300 es
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`));
  g.attachShader(probe, shader(g.FRAGMENT_SHADER, `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D depth; uniform ivec2 origin; out vec4 o;
void main() {
  uint k = uint(round(texelFetch(depth, origin + ivec2(gl_FragCoord.xy), 0).r * 16777215.0));
  o = vec4(float(k & 255u), float((k >> 8) & 255u), float((k >> 16) & 255u), 0.0) / 255.0;
}`));
  g.linkProgram(probe);
  if (!g.getProgramParameter(probe, g.LINK_STATUS)) throw new Error(`gl: link: ${g.getProgramInfoLog(probe)}`);
  const probeDepth = g.getUniformLocation(probe, 'depth'), probeOrigin = g.getUniformLocation(probe, 'origin');
  let probeTarget = null, probeColour = null, probeVao = null, probeSize = '';
  g.useProgram(prog);
  const U = Object.fromEntries(['tex', 'textured', 'base', 'env', 'alphaFn', 'fogMode', 'alphaRef', 'fogDensity', 'fogStart', 'fogEnd', 'fogColour', 'zFlip']
    .map((n) => [n, g.getUniformLocation(prog, n)]));
  g.uniform1i(U.tex, 0);
  g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
  const STRIDE = 11 * 4;
  g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 4, g.FLOAT, false, STRIDE, 0);
  g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 4, g.FLOAT, false, STRIDE, 16);
  g.enableVertexAttribArray(2); g.vertexAttribPointer(2, 2, g.FLOAT, false, STRIDE, 32);
  g.enableVertexAttribArray(3); g.vertexAttribPointer(3, 1, g.FLOAT, false, STRIDE, 40);
  g.disable(g.CULL_FACE);
  const gpuTex = new Map();
  const MAXV = 3 * 65536, data = new Float32Array(MAXV * 11);
  let n = 0, mode = g.TRIANGLES, key = null, pending = null;
  const BASES = { RGB: 0, RGBA: 1, L: 2, LA: 3, A: 4, I: 5 };
  const ENVS = { 0x2100: 0, 0x1e01: 1, 0x2101: 2 };
  const FILT = { 0x2600: g.NEAREST, 0x2601: g.LINEAR, 0x2700: g.NEAREST_MIPMAP_NEAREST, 0x2701: g.LINEAR_MIPMAP_NEAREST, 0x2702: g.NEAREST_MIPMAP_LINEAR, 0x2703: g.LINEAR_MIPMAP_LINEAR };
  const WRAP = { 0x2901: g.REPEAT, 0x2900: g.CLAMP_TO_EDGE, 0x812f: g.CLAMP_TO_EDGE };
  let zFlip = 0, view = [0, 0, w, h];
  /*
   * What WebGL was last told, piece by piece, so that a batch sends only what differs from the one
   * before: Cube flushes some 900 batches a frame of 15 vertices each -- every change of texture
   * ends one -- and sending all of the state with each was a fifth of its frame. Whatever else
   * touches the same WebGL state (clear, upload, readDepth) forgets the pieces it changed.
   */
  let applied = {};
  const texParams = new Map();                // texture id -> its min, mag and wraps as last set
  const put = (k, v, send) => { if (applied[k] !== v) { applied[k] = v; send(); } };
  function apply(st) {
    if (st.tex >= 0) {
      put('tex', st.tex, () => g.bindTexture(g.TEXTURE_2D, gpuTex.get(st.tex)));
      const p = `${st.min},${st.mag},${st.wrapS},${st.wrapT}`;
      if (texParams.get(st.tex) !== p) {
        texParams.set(st.tex, p);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, FILT[st.min]); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, FILT[st.mag]);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, WRAP[st.wrapS]); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, WRAP[st.wrapT]);
      }
    }
    put('textured', st.tex >= 0, () => g.uniform1i(U.textured, st.tex >= 0 ? 1 : 0));
    put('base', st.base, () => g.uniform1i(U.base, BASES[st.base] ?? 0));
    put('env', st.env, () => g.uniform1i(U.env, ENVS[st.env] ?? 0));
    put('blend', st.blend, () => { if (st.blend) { const [sf, df] = st.blend.split(',').map(Number); g.enable(g.BLEND); g.blendFunc(sf, df); } else g.disable(g.BLEND); });
    put('alpha', st.alpha, () => { if (st.alpha) { const [f, r] = st.alpha.split(','); g.uniform1i(U.alphaFn, f - 0x200); g.uniform1f(U.alphaRef, +r); } else g.uniform1i(U.alphaFn, -1); });
    put('depth', st.depth, () => { if (st.depth) { const [f, m] = st.depth.split(','); g.enable(g.DEPTH_TEST); g.depthFunc(+f); g.depthMask(m === 'true'); } else g.disable(g.DEPTH_TEST); });
    /*
     * A REVERSED depth range. GL 1.1 lets near exceed far, and GLQuake's family lives on it: with
     * gl_ztrick (the default) it never clears the depth buffer, and instead draws even frames into
     * [0, 0.5] with GL_LEQUAL and odd ones into [1, 0.5] with GL_GEQUAL. WebGL refuses such a range
     * outright (INVALID_OPERATION), so every other frame kept the previous one's range and failed
     * its depth test: Hexen II flickered. Window z is linear in clip z, so the reversed range is the
     * ordinary one with z negated -- which the vertex shader does.
     */
    put('range', st.range, () => {
      const [dn, df] = st.range.split(',').map(Number), flip = dn > df ? 1 : 0;
      g.depthRange(flip ? df : dn, flip ? dn : df);
      if (flip !== zFlip) { zFlip = flip; g.uniform1i(U.zFlip, flip); }
    });
    put('scissor', st.scissor, () => { if (st.scissor) { const [x, y, sw, sh] = st.scissor.split(',').map(Number); g.enable(g.SCISSOR_TEST); g.scissor(x, y, sw, sh); } else g.disable(g.SCISSOR_TEST); });
    put('fog', st.fog, () => {
      if (st.fog) {
        const [m, d, s0, e0, r, gg, b, a] = st.fog.split(',').map(Number);
        g.uniform1i(U.fogMode, m === 0x2601 ? 1 : m === 0x0800 ? 2 : 3); g.uniform1f(U.fogDensity, d); g.uniform1f(U.fogStart, s0); g.uniform1f(U.fogEnd, e0); g.uniform4f(U.fogColour, r, gg, b, a);
      } else g.uniform1i(U.fogMode, 0);
    });
    put('mask', st.mask, () => { const cm = st.mask.split(',').map((v) => v === 'true'); g.colorMask(cm[0], cm[1], cm[2], cm[3]); });
    // Only a program that uses the stencil test sends WebGL stencil calls (WebGL's initial state is off).
    if (st.stencil !== (applied.stencil ?? '')) {
      applied.stencil = st.stencil;
      if (st.stencil) {
        const [fn, ref, mask, f0, f1, f2, wm] = st.stencil.split(',').map(Number);
        g.enable(g.STENCIL_TEST); g.stencilFunc(fn, ref, mask); g.stencilOp(f0, f1, f2); g.stencilMask(wm);
      } else g.disable(g.STENCIL_TEST);
    }
    put('offset', st.offset, () => { if (st.offset) { const [f, u] = st.offset.split(',').map(Number); g.enable(g.POLYGON_OFFSET_FILL); g.polygonOffset(f, u); } else g.disable(g.POLYGON_OFFSET_FILL); });
  }
  const flush = () => {
    if (!n) return;
    apply(pending);
    g.bufferData(g.ARRAY_BUFFER, data.subarray(0, n * 11), g.STREAM_DRAW);
    g.drawArrays(mode, 0, n);
    n = 0;
  };
  const push = (v, colour) => { const o = n * 11; data.set(v.clip, o); data.set(colour ?? v.colour, o + 4); data[o + 8] = v.tex[0]; data[o + 9] = v.tex[1]; data[o + 10] = v.eyeZ; n++; };
  // gpuState builds every field from primitives in a fixed order, so field-wise equality is identity.
  const same = (a, b) => { if (!a || !b) return false; for (const f in a) if (a[f] !== b[f]) return false; return true; };
  const begin = (st, m, count) => {
    if (!key || !same(st, pending) || m !== mode || n + count > MAXV) { flush(); key = true; pending = st; mode = m; }
  };
  return {
    upload(id, t) {
      flush();
      let tx = gpuTex.get(id);
      if (!tx) { tx = g.createTexture(); gpuTex.set(id, tx); }
      g.bindTexture(g.TEXTURE_2D, tx);
      delete applied.tex;
      g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
      t.levels.forEach((L, lv) => { if (L) g.texImage2D(g.TEXTURE_2D, lv, g.RGBA, L.w, L.h, 0, g.RGBA, g.UNSIGNED_BYTE, L.data); });
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAX_LEVEL, t.levels.length - 1);
      key = null;
    },
    tri(a, b, c, flat, st) { begin(st, g.TRIANGLES, 3); push(a, flat); push(b, flat); push(c, flat); },
    line(a, b, st) { begin(st, g.LINES, 2); push(a); push(b); },
    viewport(x, y, vw, vh) { flush(); g.viewport(x, y, vw, vh); view = [x, y, vw, vh]; },
    clear(mask, colour, depth, scissor, colorMask = [true, true, true, true], depthMask = true, stencil = null) {
      flush();
      if (scissor) { g.enable(g.SCISSOR_TEST); g.scissor(...scissor); } else g.disable(g.SCISSOR_TEST);
      g.clearColor(colour[0], colour[1], colour[2], colour[3]); g.clearDepth(depth);
      g.colorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]); g.depthMask(depthMask);
      delete applied.scissor; delete applied.mask; delete applied.depth;
      if (stencil && (mask & 0x400)) { g.clearStencil(stencil[0]); g.stencilMask(stencil[1]); applied.stencil = 'unknown'; }
      g.clear(((mask & 0x4000) ? g.COLOR_BUFFER_BIT : 0) | ((mask & 0x100) ? g.DEPTH_BUFFER_BIT : 0) | (stencil && (mask & 0x400) ? g.STENCIL_BUFFER_BIT : 0));
      key = null;
    },
    /** The depth of a rectangle, bottom row first, as GL_FLOAT values in [0, 1]. */
    readDepth(x, y, rw, rh) {
      flush();
      if (probeSize !== `${rw}x${rh}`) {
        probeSize = `${rw}x${rh}`;
        probeTarget ??= g.createFramebuffer(); probeColour ??= g.createRenderbuffer(); probeVao ??= g.createVertexArray();
        g.bindRenderbuffer(g.RENDERBUFFER, probeColour);
        g.renderbufferStorage(g.RENDERBUFFER, g.RGBA8, rw, rh);
        g.bindFramebuffer(g.FRAMEBUFFER, probeTarget);
        g.framebufferRenderbuffer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.RENDERBUFFER, probeColour);
      }
      g.bindFramebuffer(g.FRAMEBUFFER, probeTarget);
      g.disable(g.DEPTH_TEST); g.disable(g.BLEND); g.disable(g.SCISSOR_TEST); g.disable(g.STENCIL_TEST); g.disable(g.POLYGON_OFFSET_FILL);
      g.colorMask(true, true, true, true);
      g.viewport(0, 0, rw, rh);
      g.useProgram(probe);
      g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, depthTex);
      g.uniform1i(probeDepth, 1); g.uniform2i(probeOrigin, x, y);
      g.bindVertexArray(probeVao);
      g.drawArrays(g.TRIANGLES, 0, 3);
      const px = new Uint8Array(rw * rh * 4);
      g.readPixels(0, 0, rw, rh, g.RGBA, g.UNSIGNED_BYTE, px);
      // Back to the program's framebuffer and state: the next batch sets all of it again.
      g.bindVertexArray(null);
      g.bindTexture(g.TEXTURE_2D, null); g.activeTexture(g.TEXTURE0);
      g.useProgram(prog);
      g.bindFramebuffer(g.FRAMEBUFFER, target);
      g.viewport(...view);
      key = null; applied = {};
      const out = new Float32Array(rw * rh);
      for (let i = 0; i < rw * rh; i++) out[i] = (px[4 * i] | (px[4 * i + 1] << 8) | (px[4 * i + 2] << 16)) / 16777215;
      return out;
    },
    /**
     * The frame as an ImageBitmap, for a page to draw: the program's framebuffer blitted to the
     * canvas's own and taken from it, with nothing read back. The scissor would clip the blit, so it
     * is off for it and forgotten.
     */
    present() {
      flush();
      g.disable(g.SCISSOR_TEST); delete applied.scissor;
      g.bindFramebuffer(g.DRAW_FRAMEBUFFER, null);
      g.blitFramebuffer(0, 0, w, h, 0, 0, w, h, g.COLOR_BUFFER_BIT, g.NEAREST);
      g.bindFramebuffer(g.FRAMEBUFFER, target);
      key = null;
      return canvas.transferToImageBitmap();
    },
    /** The framebuffer, bottom row first, as GL's own is. */
    read() { flush(); const px = new Uint8Array(w * h * 4); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px); return px; },
    get lost() { return lost || !!g.isContextLost?.(); },
    /** For a test: take the context away, as the GPU would (WEBGL_lose_context). */
    lose() { g.getExtension('WEBGL_lose_context')?.loseContext(); lost = true; },
  };
}

/** The builtin signatures, from headers-gl.js. */
export function glBuiltins(T) {
  const I = T.INT, U = T.UINT, V = T.VOID, F = T.FLOAT, D = T.DOUBLE, P = T.ptr(T.CHAR);
  const f = (ret, ...params) => ({ ret, params });
  return {
    glClear: f(V, U), glClearColor: f(V, F, F, F, F), glEnable: f(V, U), glDisable: f(V, U),
    glShadeModel: f(V, U), glCullFace: f(V, U), glFrontFace: f(V, U), glViewport: f(V, I, I, I, I),
    glDepthFunc: f(V, U), glDepthMask: f(V, U), glDepthRange: f(V, D, D), glClearDepth: f(V, D), glAlphaFunc: f(V, U, F), glBlendFunc: f(V, U, U),
    glMatrixMode: f(V, U), glLoadIdentity: f(V), glLoadMatrixf: f(V, P), glPushMatrix: f(V), glPopMatrix: f(V), glPushAttrib: f(V, U), glPopAttrib: f(V), glPushClientAttrib: f(V, U), glPopClientAttrib: f(V),
    glTranslatef: f(V, F, F, F), glRotatef: f(V, F, F, F, F), glScalef: f(V, F, F, F),
    glFrustum: f(V, D, D, D, D, D, D), glOrtho: f(V, D, D, D, D, D, D), glGetFloatv: f(V, U, P),
    glColorMask: f(V, U, U, U, U), glPolygonOffset: f(V, F, F), glClipPlane: f(V, U, P), glLineWidth: f(V, F),
    glStencilFunc: f(V, U, I, U), glStencilOp: f(V, U, U, U), glStencilMask: f(V, U), glClearStencil: f(V, I),
    glTexParameterfv: f(V, U, U, P), glGetIntegerv: f(V, U, P), glDrawElements: f(V, U, I, U, P),
    glBegin: f(V, U), glEnd: f(V), glVertex3f: f(V, F, F, F), glVertex3fv: f(V, P), glVertex2f: f(V, F, F),
    glNormal3f: f(V, F, F, F), glColor3f: f(V, F, F, F), glColor4f: f(V, F, F, F, F), glColor4fv: f(V, P), glColor3ubv: f(V, P),
    glTexCoord2f: f(V, F, F), glTexCoord2fv: f(V, P),
    glMultMatrixf: f(V, P), glMultMatrixd: f(V, P), glLoadMatrixd: f(V, P), glTexCoord2d: f(V, D, D), glTexCoord2dv: f(V, P),
    glColor3dv: f(V, P), glColor4dv: f(V, P), glVertex2dv: f(V, P), glVertex3dv: f(V, P), glNormal3fv: f(V, P),
    glColor3d: f(V, D, D, D), glColor3ub: f(V, T.UCHAR, T.UCHAR, T.UCHAR), glVertex2i: f(V, I, I), glVertex2d: f(V, D, D), glVertex3d: f(V, D, D, D),
    glTranslated: f(V, D, D, D), glRotated: f(V, D, D, D, D), glGetDoublev: f(V, U, P), glDrawArrays: f(V, U, I, I),
    glRectf: f(V, F, F, F, F), glRecti: f(V, I, I, I, I), glLightf: f(V, U, U, F), glMaterialf: f(V, U, U, F),
    glColorMaterial: f(V, U, U), glPixelStorei: f(V, U, I), glTexGeni: f(V, U, U, I), glTexGenfv: f(V, U, U, P), glNormalPointer: f(V, U, I, P),
    glGetBooleanv: f(V, U, P), glGetTexLevelParameteriv: f(V, U, I, U, P),
    glLightfv: f(V, U, U, P), glMaterialfv: f(V, U, U, P),
    glLightModelfv: f(V, U, P), glLightModelf: f(V, U, F), glLightModeli: f(V, U, I), glIsTexture: f(U, U),
    glFogf: f(V, U, F), glFogi: f(V, U, I), glFogfv: f(V, U, P),
    glBindTexture: f(V, U, U), glTexParameterf: f(V, U, U, F), glTexEnvf: f(V, U, U, F), glTexParameteri: f(V, U, U, I), glTexEnvi: f(V, U, U, I),
    glTexImage2D: f(V, U, I, I, I, I, I, U, U, P), glTexSubImage2D: f(V, U, I, I, I, I, I, U, U, P),
    glReadPixels: f(V, I, I, I, I, U, U, P), glPolygonMode: f(V, U, U), glHint: f(V, U, U),
    glDrawBuffer: f(V, U), glReadBuffer: f(V, U),
    glScissor: f(V, I, I, I, I), glPointSize: f(V, F), glColor3fv: f(V, P), glColor4ubv: f(V, P),
    glEnableClientState: f(V, U), glDisableClientState: f(V, U), glVertexPointer: f(V, I, U, I, P),
    glColorPointer: f(V, I, U, I, P), glTexCoordPointer: f(V, I, U, I, P), glArrayElement: f(V, I), glLockArraysEXT: f(V, I, I), glUnlockArraysEXT: f(V),
    // ARB_vertex_buffer_object, ARB_multitexture, ARB_point_parameters: by their ARB names, as GetProcAddress hands them out.
    glColor4ub: f(V, U, U, U, U), glIsEnabled: f(U, U), glGetMaterialfv: f(V, U, U, P),
    glGenBuffersARB: f(V, I, P), glBindBufferARB: f(V, U, U), glBufferDataARB: f(V, U, I, P, U), glBufferSubDataARB: f(V, U, I, I, P),
    glDeleteBuffersARB: f(V, I, P), glIsBufferARB: f(U, U), glActiveTextureARB: f(V, U), glClientActiveTextureARB: f(V, U),
    glPointParameterfARB: f(V, U, F), glPointParameterfvARB: f(V, U, P),
    glDeleteTextures: f(V, I, P), glGenTextures: f(V, I, P), glGetError: f(U),
    glGenLists: f(U, I), glNewList: f(V, U, U), glEndList: f(V), glCallList: f(V, U), glDeleteLists: f(V, U, I),
    glGetString: f(P, U), glFinish: f(V), glFlush: f(V),
  };
}
