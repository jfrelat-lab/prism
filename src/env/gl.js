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
// NOT implemented, and refused rather than approximated: colour-index textures.

import { GL_H } from './headers-gl.js';
import { makeGLSL, makeGLSLWebGL } from './glsl.js';

const MODELVIEW = 0x1700, PROJECTION = 0x1701, TEXTURE_MATRIX = 0x1702;
const CAP = {
  CULL_FACE: 0x0b44, LIGHTING: 0x0b50, DEPTH_TEST: 0x0b71, NORMALIZE: 0x0ba1, LIGHT0: 0x4000,
  TEXTURE_2D: 0x0de1, BLEND: 0x0be2, ALPHA_TEST: 0x0bc0, FOG: 0x0b60, SCISSOR_TEST: 0x0c11,
  POLYGON_OFFSET_FILL: 0x8037, CLIP_PLANE0: 0x3000, STENCIL_TEST: 0x0b90,
};
// What glEnable acts on (the rest are named in CAP): texture generation, colour material.
const KNOWN_CAPS = new Set([0x0b90, 0x0b44, 0x0b50, 0x0b71, 0x0ba1, 0x0de1, 0x0be2, 0x0bc0, 0x0b60, 0x0c11, 0x8037, 0x0c60, 0x0c61, 0x0b57, 0x8861]);
/*
 * glPushAttrib's groups: the fields of the state each saves, and its enables. Texture units 1 and 2,
 * and the ENABLE group's every capability, are glPushAttrib's own (they are not plain fields).
 */
const TEXTURE_CAPS = [0x0de1, 0x806f, 0x0c60, 0x0c61, 0x0c62, 0x0c63];
const ATTRIB_GROUPS = [
  [0x1, { fields: ['colour', 'normal', 'tex'], caps: [] }],                                       // CURRENT
  [0x2, { fields: ['pointSize', 'pointMin', 'pointMax', 'pointAtten', 'coordReplace'], caps: [0x0b10, 0x8861] }],   // POINT
  [0x4, { fields: ['lineWidth'], caps: [0x0b20, 0x0b24] }],                                       // LINE
  [0x8, { fields: ['cullFace', 'frontFace', 'polyMode', 'polygonOffset'], caps: [0x0b44, 0x0b41, 0x0b42, 0x8037, 0x2a01, 0x2a02] }],  // POLYGON
  [0x40, { fields: ['shade', 'material', 'backMaterial', 'sceneAmbient', 'twoSide', 'lights', 'colourMaterial', 'colourControl'],
    caps: [0x0b50, 0x0b57, 0x4000, 0x4001, 0x4002, 0x4003, 0x4004, 0x4005, 0x4006, 0x4007] }],      // LIGHTING
  [0x80, { fields: ['fog'], caps: [0x0b60] }],                                                    // FOG
  [0x100, { fields: ['depthFunc', 'depthMask', 'clearDepth'], caps: [0x0b71] }],                  // DEPTH_BUFFER
  [0x400, { fields: ['stencilFunc', 'stencilOp', 'stencilWriteMask', 'clearStencil'], caps: [0x0b90] }],   // STENCIL_BUFFER
  [0x800, { fields: ['viewport', 'depthRange'], caps: [] }],                                      // VIEWPORT
  [0x1000, { fields: ['mode', 'clipPlanes'], caps: [0x0ba1, 0x803a, 0x3000, 0x3001, 0x3002, 0x3003, 0x3004, 0x3005] }],   // TRANSFORM
  [0x4000, { fields: ['alphaFunc', 'alphaRef', 'blend', 'colorMask', 'clear'], caps: [0x0bc0, 0x0be2, 0x0bd0, 0x0bf2] }],   // COLOR_BUFFER
  [0x40000, { fields: ['bound', 'bound3D', 'envMode', 'combine', 'texGen', 'activeUnit'], caps: TEXTURE_CAPS }],   // TEXTURE (units 1, 2: glPushAttrib)
  [0x80000, { fields: ['scissor'], caps: [0x0c11] }],                                             // SCISSOR
];
/*
 * The immediate-mode spellings (GL 1.1 2.7, GL 1.3 2.7's glMultiTexCoord): each family's component
 * counts and types, with and without v. A type: its C scalar (T's name), its size, the DataView getter
 * a v form reads it with, and how a COLOUR or a NORMAL of it becomes a float (GL 1.1 Table 2.6, as
 * Mesa's BYTE_TO_FLOAT and the rest have it: a signed c maps to (2c + 1) / (2^n - 1)). The integer is narrowed to its type first: an unsigned int arrives as a
 * negative JS number. A position or a
 * texture coordinate is the number itself, made a float as Mesa's entry points make it.
 */
const IMM_TYPES = {
  b: ['SCHAR', 1, 'getInt8', (c) => (2 * (c << 24 >> 24) + 1) / 255], s: ['SHORT', 2, 'getInt16', (c) => (2 * (c << 16 >> 16) + 1) / 65535],
  i: ['INT', 4, 'getInt32', (c) => (2 * (c | 0) + 1) / 4294967295], f: ['FLOAT', 4, 'getFloat32', (c) => c],
  d: ['DOUBLE', 8, 'getFloat64', Math.fround], ub: ['UCHAR', 1, 'getUint8', (c) => (c & 0xff) / 255],
  us: ['USHORT', 2, 'getUint16', (c) => (c & 0xffff) / 65535], ui: ['UINT', 4, 'getUint32', (c) => (c >>> 0) / 4294967295],
};
const IMM_FAMILIES = [
  ['glVertex', [2, 3, 4], 'sifd'], ['glColor', [3, 4], ['b', 's', 'i', 'f', 'd', 'ub', 'us', 'ui']], ['glTexCoord', [1, 2, 3, 4], 'sifd'],
  ['glNormal', [3], 'bsifd'], ['glMultiTexCoord', [1, 2, 3, 4], 'sifd'], ['glMultiTexCoordARB', [1, 2, 3, 4], 'sifd'],
];
/** Every spelling: { name, family, n, t, v }. glMultiTexCoordARB's names end in ARB (glMultiTexCoord2fARB). */
const immediateForms = () => IMM_FAMILIES.flatMap(([family, counts, types]) => counts.flatMap((n) => [...types].flatMap((t) => [false, true].map((v) => {
  const base = family.replace(/ARB$/, '');
  return { name: `${base}${n}${t}${v ? 'v' : ''}${family.endsWith('ARB') ? 'ARB' : ''}`, family: base, n, t, v };
}))));
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
const POINT = 0x1b00, LINE = 0x1b01, FILL = 0x1b02;
const PNAME = { AMBIENT: 0x1200, DIFFUSE: 0x1201, SPECULAR: 0x1202, POSITION: 0x1203, EMISSION: 0x1600, SHININESS: 0x1601, AMBIENT_AND_DIFFUSE: 0x1602 };
const LIGHT_MODEL = { LOCAL_VIEWER: 0x0b51, TWO_SIDE: 0x0b52, AMBIENT: 0x0b53 };
const COMPILE_AND_EXECUTE = 0x1301;
const TEX = {
  MAG: 0x2800, MIN: 0x2801, WRAP_S: 0x2802, WRAP_T: 0x2803,
  NEAREST: 0x2600, LINEAR: 0x2601, NN: 0x2700, LN: 0x2701, NL: 0x2702, LL: 0x2703,
  REPEAT: 0x2901, CLAMP: 0x2900, CLAMP_TO_EDGE: 0x812f,
  ENV_MODE: 0x2200, MODULATE: 0x2100, REPLACE: 0x1e01, DECAL: 0x2101, COMBINE: 0x8570,
};
/*
 * ARB_multitexture: THREE UNITS. Unit 0's state is where it always was (s.bound, s.envMode, s.texGen,
 * s.tex, s.arrays.tex, s.stacks[GL_TEXTURE], its enables in s.caps), so a program that uses one unit
 * runs the code it ran before; units 1 and 2 keep theirs in s.units[k], and every command that acts
 * on "the active unit" goes there when that is not 0. A fragment then goes through each enabled unit
 * in turn, the colour one gives being the PREVIOUS the next one takes (GL 1.3, 3.8.13).
 */
const UNITS = 3;
/*
 * GL_COMBINE (GL 1.3, ARB_texture_env_combine): each unit's function of up to three arguments, each a
 * source (its texture, the constant colour, the primary colour, the previous unit's) through an operand
 * (the colour, its alpha, or one minus either), separately for RGB and alpha, scaled and clamped.
 * Neverball's ball shadow is two of them. The defaults are the specification's.
 */
const COMBINE_FN = { 0x1e01: 0, 0x2100: 1, 0x0104: 2, 0x8574: 3, 0x8575: 4, 0x84e7: 5 };   // REPLACE MODULATE ADD ADD_SIGNED INTERPOLATE SUBTRACT
const COMBINE_SRC = { 0x1702: 0, 0x8576: 1, 0x8577: 2, 0x8578: 3 };                          // TEXTURE CONSTANT PRIMARY_COLOR PREVIOUS
const COMBINE_OP = { 0x300: 0, 0x301: 1, 0x302: 2, 0x303: 3 };                               // SRC_COLOR, 1 - it, SRC_ALPHA, 1 - it
const newCombine = () => ({
  rgb: 0x2100, alpha: 0x2100, srcRGB: [0x1702, 0x8578, 0x8576], srcA: [0x1702, 0x8578, 0x8576],
  opRGB: [0x300, 0x300, 0x302], opA: [0x302, 0x302, 0x302], scaleRGB: 1, scaleA: 1, colour: [0, 0, 0, 0],
});
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
export function installGL(M, { onFrame = null, backend = 'soft', version = '1.1 PRISM', onLost = null, extensions = [], tnl = true } = {}) {
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
  // A texture unit other than 0: its binding, environment, coordinate generation, matrix stack, enables,
  // current coordinate (s, t, r, q) and coordinate array.
  const newUnit = () => ({
    bound: 0, envMode: TEX.MODULATE, combine: newCombine(),
    texGen: [{ mode: 0x2400, object: [1, 0, 0, 0] }, { mode: 0x2400, object: [0, 1, 0, 0] }],
    matrix: [ident()], caps: new Set(), coord: [0, 0, 0, 1], array: { on: false },
  });
  const newTexture = () => ({ levels: [], base: 'RGBA', min: TEX.NL, mag: TEX.LINEAR, wrapS: TEX.REPEAT, wrapT: TEX.REPEAT, wrapR: TEX.REPEAT, gpu: null, dirty: true });
  /*
   * GL_TEXTURE_3D (GL 1.2) is a second binding beside GL_TEXTURE_2D, with its own default object. Only
   * a GLSL program samples it (a sampler3D, on the WebGL path): the fixed function's 3D texturing is
   * not implemented, and enabling it says so (glEnable).
   */
  const TEX3D = 0x806f, WRAP_R = 0x8072;
  /*
   * GL_GENERATE_MIPMAP (GL 1.4, SGIS_generate_mipmap): a texture object's flag that makes every write
   * to its level 0 make the levels below again. Each level is the one above halved in every dimension
   * greater than 1, each texel the rounded mean of the 2, 4 or 8 above it -- the box filter Mesa uses.
   */
  const GENERATE_MIPMAP = 0x8191;
  function generateMipmaps(t) {
    let A = t.levels[0];
    t.levels.length = 1;
    for (let lv = 1; A.w > 1 || A.h > 1 || (A.d ?? 1) > 1; lv++) {
      const w = Math.max(1, A.w >> 1), h = Math.max(1, A.h >> 1), d = Math.max(1, (A.d ?? 1) >> 1);
      const sx = A.w > 1 ? 2 : 1, sy = A.h > 1 ? 2 : 1, sz = (A.d ?? 1) > 1 ? 2 : 1, n = sx * sy * sz;
      const data = new Uint8Array(w * h * d * 4), S = A.data;
      for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        for (let k = 0; k < 4; k++) {
          let sum = 0;
          for (let c = 0; c < sz; c++) for (let b = 0; b < sy; b++) for (let a = 0; a < sx; a++) {
            sum += S[(((z * sz + c) * A.h + y * sy + b) * A.w + x * sx + a) * 4 + k];
          }
          data[((z * h + y) * w + x) * 4 + k] = Math.floor((sum + (n >> 1)) / n);
        }
      }
      A = t.levels[lv] = A.d ? { w, h, d, data } : { w, h, data };
    }
    t.dirty = true;
  }
  // After a write to a level: the chain made again when it was level 0 of a texture that asks for it.
  const written = (t, level) => { if (level === 0 && t.generate) generateMipmaps(t); };
  const s = {
    width: 0, height: 0, color: null, depth: null,
    viewport: [0, 0, 0, 0], clear: [0, 0, 0, 0], clearDepth: 1,
    mode: MODELVIEW, stacks: { [MODELVIEW]: [ident()], [PROJECTION]: [ident()], [TEXTURE_MATRIX]: [ident()] },
    caps: new Set(), shade: 0x1d01, frontFace: CCW, cullFace: BACK, polyMode: [FILL, FILL],
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
    envMode: TEX.MODULATE, combine: newCombine(),
    fog: { mode: FOG.EXP, density: 1, start: 0, end: 1, colour: [0, 0, 0, 0] },
    textures: new Map([[0, newTexture()]]), bound: 0, nextTexture: 1, genTextures: new Set(),
    bound3D: 0, default3D: newTexture(),
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
    // ARB_multitexture: the selected server and client units; units 1 and 2 (see UNITS).
    activeUnit: 0, clientUnit: 0, units: [null, newUnit(), newUnit()],
    // ARB_vertex_buffer_object: a buffer is a block of the program's own memory, so an array pointer
    // into a bound buffer is an ordinary pointer once its base is added -- the arrays, glDrawArrays
    // and glDrawElements read it unchanged. id -> { ptr, size }; the two bindings by target.
    buffers: new Map(), nextBuffer: 1, arrayBuffer: 0, elementBuffer: 0,
    // Framebuffer objects: id -> its attachments; renderbuffers: id -> their storage. The draw and the
    // read framebuffer, 0 the window's (whose buffers `win` keeps while another is bound).
    fbos: new Map(), nextFbo: 1, rbs: new Map(), nextRb: 1, boundRb: 0, drawFbo: 0, readFbo: 0, win: null,
    colorMask: [true, true, true, true], polygonOffset: [0, 0], clipPlanes: [null, null, null, null, null, null],
    prim: null, verts: [],
    lists: new Map(), nextList: 1, recording: null, recordMode: 0,
    stats: { triangles: 0, culled: 0, clipped: 0, fragments: 0, gpuDraws: 0 },
    strings: new Map(),
  };
  const glsl = makeGLSL(M);                 // shaders and programs (src/env/glsl.js)
  // The stack a matrix command acts on: GL_TEXTURE's is the active unit's.
  const stackOf = (mode) => (mode === TEXTURE_MATRIX && s.activeUnit ? s.units[s.activeUnit].matrix : s.stacks[mode]);
  const top = () => { const st = stackOf(s.mode); return st[st.length - 1]; };
  const setTop = (m) => { const st = stackOf(s.mode); st[st.length - 1] = m; };
  // The 2D texture bound to the ACTIVE unit, which glTexImage2D and glTexParameter act on.
  const texture = () => s.textures.get(s.activeUnit ? s.units[s.activeUnit].bound : s.bound);
  const xunit = () => (s.activeUnit ? s.units[s.activeUnit] : null);
  const clientTex = () => (s.clientUnit ? s.units[s.clientUnit].array : s.arrays.tex);
  const texture3D = () => (s.bound3D ? s.textures.get(s.bound3D) : s.default3D);
  const targetTexture = (target) => (target === TEX3D ? texture3D() : texture());
  /*
   * Component k of element i of array a, as glArrayElement reads it -- defined once, not per element.
   * Every type GL 1.1 allows an array (2.8): bytes, shorts and ints, signed or not, floats and
   * doubles. A colour or a normal of an integer type is NORMALIZED (2.13, Table 2.6: the largest
   * value is 1.0, a signed one maps -max-1..max onto -1..1); a position or a texture coordinate
   * is the number itself. Neverball's interface sends GL_SHORT positions, read as floats before.
   */
  function arrayAt(a, i, k, norm) {
    // The component size and the element step are the array's own (layout(), when it was given).
    const p = a.ptr + i * a.step + a.n * k, d = dv();
    if (a.type === 0x1406) return d.getFloat32(p, true);
    switch (a.type) {
      case 0x1401: return norm ? M.u8[p] / 255 : M.u8[p];
      case 0x1400: { const v = d.getInt8(p); return norm ? (2 * v + 1) / 255 : v; }
      case 0x1402: { const v = d.getInt16(p, true); return norm ? (2 * v + 1) / 65535 : v; }
      case 0x1403: { const v = d.getUint16(p, true); return norm ? v / 65535 : v; }
      case 0x1404: { const v = d.getInt32(p, true); return norm ? (2 * v + 1) / 4294967295 : v; }
      case 0x1405: { const v = d.getUint32(p, true); return norm ? v / 4294967295 : v; }
      case 0x140a: return d.getFloat64(p, true);
      default: throw new Error(`gl: array type 0x${a.type.toString(16)}`);
    }
  }
  // An array pointer: into the bound array buffer, or the program's memory as it stands.
  // What an array's elements take: its component size and its step, worked out once per gl*Pointer.
  const layout = (type, size, stride) => ({ n: TYPE_BYTES[type], step: stride || size * TYPE_BYTES[type] });
  const inBuffer = (ptr) => (s.arrayBuffer
    ? { ptr: s.buffers.get(s.arrayBuffer).ptr + ptr, buffer: s.arrayBuffer, offset: ptr }
    : { ptr, buffer: 0, offset: 0 });

  /*
   * FRAMEBUFFER OBJECTS (GL 3.0, ARB_framebuffer_object; the EXT names too). A framebuffer is a set of
   * attachments -- a texture's level or a renderbuffer as its colour, a renderbuffer as its depth and
   * stencil -- and drawing goes to the one bound: the software rasteriser draws into the arrays the
   * attachments hold (s.color/s.depth/s.stencil and their size are the bound one's, `win` keeps the
   * window's), the WebGL path into a WebGL framebuffer over the same texture. A texture drawn into on
   * the GPU is the GPU's from then on (gpuOwned): its pixels here are not uploaded over it until the
   * program writes it again itself. Without a depth attachment the depth test is off, as GL has it.
   */
  const FB = { FRAMEBUFFER: 0x8d40, READ: 0x8ca8, DRAW: 0x8ca9, RENDERBUFFER: 0x8d41, COLOR0: 0x8ce0, DEPTH: 0x8d00, STENCIL: 0x8d20, DEPTH_STENCIL: 0x821a, COMPLETE: 0x8cd5, INCOMPLETE: 0x8cd6 };
  const DEPTH_FORMATS = new Set([0x1902, 0x81a5, 0x81a6, 0x81a7, 0x88f0, 0x8cac]), STENCIL_FORMATS = new Set([0x88f0, 0x8d48, 0x1901]);
  const newFbo = () => ({ color: null, depth: null, stencil: null });
  /** A framebuffer's buffers, as the rasteriser draws into them; null while it is incomplete. */
  function fboBuffers(id) {
    const fb = s.fbos.get(id);
    if (!fb?.color) return null;
    let color, width, height;
    if (fb.color.tex) {
      const L = s.textures.get(fb.color.tex)?.levels[fb.color.level];
      if (!L) return null;
      ({ data: color, w: width, h: height } = L);
    } else {
      const rb = s.rbs.get(fb.color.rb);
      if (!rb?.color) return null;
      ({ color, w: width, h: height } = rb);
    }
    const d = fb.depth && s.rbs.get(fb.depth.rb), st = fb.stencil && s.rbs.get(fb.stencil.rb);
    return { color, depth: d?.depth ?? null, stencil: st?.stencil ?? null, width, height };
  }
  // What the WebGL backend needs to build the same framebuffer.
  function fboSpec(id) {
    const fb = s.fbos.get(id), rb = (a) => a && { ...s.rbs.get(a.rb), id: a.rb };
    if (fb.color?.tex) {
      const t = s.textures.get(fb.color.tex);
      if (t.dirty && !t.gpuOwned) webgl.upload(fb.color.tex, t);
      t.dirty = false; t.gpuOwned = true;
    }
    return { id, color: fb.color?.tex ? { tex: fb.color.tex, level: fb.color.level } : fb.color && { rb: rb(fb.color) }, depth: rb(fb.depth), stencil: rb(fb.stencil) };
  }
  /** Point drawing at the bound draw framebuffer. */
  function drawTarget() {
    const b = s.drawFbo ? fboBuffers(s.drawFbo) : s.win;
    if (b) { s.color = b.color; s.depth = b.depth; s.stencil = b.stencil; s.width = b.width; s.height = b.height; }
    if (webgl) webgl.framebuffer(s.drawFbo && b ? fboSpec(s.drawFbo) : null);
    gpuCache = null;
  }
  /** The read framebuffer's colour, bottom row first, with its width and height. */
  function readBuffer() {
    const b = s.readFbo ? fboBuffers(s.readFbo) : s.win;
    if (!b) throw new Error('gl: reading from an incomplete framebuffer');
    return { data: webgl ? webgl.read(s.readFbo, b.width, b.height) : b.color, width: b.width, height: b.height };
  }
  const fboFor = (target) => { const id = target === FB.READ ? s.readFbo : s.drawFbo; const fb = s.fbos.get(id); if (!fb) throw new Error('gl: no framebuffer object is bound'); return fb; };
  const attach = (target, attachment, value) => {
    const fb = fboFor(target);
    if (attachment === FB.COLOR0) fb.color = value;
    else if (attachment === FB.DEPTH) fb.depth = value;
    else if (attachment === FB.STENCIL) fb.stencil = value;
    else if (attachment === FB.DEPTH_STENCIL) { fb.depth = value; fb.stencil = value; }
    else throw new Error(`gl: framebuffer attachment 0x${attachment.toString(16)}`);
    if (target !== FB.READ) drawTarget();
  };
  const genIds = (n, ids, make) => { for (let k = 0; k < n; k++) dv().setUint32(ids + 4 * k, make(), true); };
  const eachId = (n, ids, fn) => { for (let k = 0; k < n; k++) { const id = dv().getUint32(ids + 4 * k, true); if (id) fn(id); } };
  const fboApi = {
    glGenFramebuffers: (n, ids) => genIds(n, ids, () => { const id = s.nextFbo++; s.fbos.set(id, newFbo()); return id; }),
    glDeleteFramebuffers: (n, ids) => eachId(n, ids, (id) => {
      s.fbos.delete(id);
      if (s.readFbo === id) s.readFbo = 0;
      if (s.drawFbo === id) { s.drawFbo = 0; drawTarget(); }
    }),
    glIsFramebuffer: (id) => (s.fbos.has(id) ? 1 : 0),
    glBindFramebuffer: (target, id) => {
      if (id && !s.fbos.has(id)) s.fbos.set(id, newFbo());
      if (target !== FB.DRAW) s.readFbo = id;
      if (target !== FB.READ) { s.drawFbo = id; drawTarget(); }
    },
    glFramebufferTexture2D: (target, attachment, textarget, tex, level) => {
      if (tex && textarget !== CAP.TEXTURE_2D) throw new Error(`gl: a framebuffer attachment of texture target 0x${textarget.toString(16)}`);
      attach(target, attachment, tex ? { tex, level } : null);
    },
    glFramebufferRenderbuffer: (target, attachment, _rbTarget, rb) => attach(target, attachment, rb ? { rb } : null),
    glCheckFramebufferStatus: (target) => { const id = target === FB.READ ? s.readFbo : s.drawFbo; return !id || fboBuffers(id) ? FB.COMPLETE : FB.INCOMPLETE; },
    glGenRenderbuffers: (n, ids) => genIds(n, ids, () => { const id = s.nextRb++; s.rbs.set(id, { w: 0, h: 0 }); return id; }),
    glDeleteRenderbuffers: (n, ids) => eachId(n, ids, (id) => { s.rbs.delete(id); if (s.boundRb === id) s.boundRb = 0; }),
    glIsRenderbuffer: (id) => (s.rbs.has(id) ? 1 : 0),
    glBindRenderbuffer: (_target, id) => { if (id && !s.rbs.has(id)) s.rbs.set(id, { w: 0, h: 0 }); s.boundRb = id; },
    glRenderbufferStorage: (_target, format, w, h) => {
      const rb = s.rbs.get(s.boundRb);
      if (!rb) throw new Error('gl: glRenderbufferStorage with no renderbuffer bound');
      const depth = DEPTH_FORMATS.has(format), stencil = STENCIL_FORMATS.has(format);
      Object.assign(rb, { format, w, h, color: depth || stencil ? null : new Uint8Array(w * h * 4),
        depth: depth ? new Float32Array(w * h).fill(1) : null, stencil: stencil ? new Uint8Array(w * h) : null });
      if (s.drawFbo) drawTarget();
    },
    // Level 0 made into the levels below: on the GPU when the GPU has the texture's pixels.
    glGenerateMipmap: () => {
      const id = s.activeUnit ? s.units[s.activeUnit].bound : s.bound, t = s.textures.get(id);
      if (!t?.levels[0]) return;
      generateMipmaps(t);
      if (webgl && t.gpuOwned) { t.dirty = false; webgl.generateMipmap(id); }
      gpuCache = null;
    },
    glBlitFramebuffer: (sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) => {
      if (webgl) { webgl.blit(s.readFbo, s.drawFbo, [sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1], mask, filter); return; }
      const src = s.readFbo ? fboBuffers(s.readFbo) : s.win;
      const sc = s.caps.has(CAP.SCISSOR_TEST) ? s.scissor : null;
      const xa = Math.min(dx0, dx1), xb = Math.max(dx0, dx1), ya = Math.min(dy0, dy1), yb = Math.max(dy0, dy1);
      for (let y = Math.max(0, ya); y < Math.min(yb, s.height); y++) for (let x = Math.max(0, xa); x < Math.min(xb, s.width); x++) {
        if (sc && (x < sc[0] || y < sc[1] || x >= sc[0] + sc[2] || y >= sc[1] + sc[3])) continue;
        // Nearest: the source pixel whose centre the destination pixel's centre maps into.
        const u = sx0 + (x + 0.5 - dx0) * (sx1 - sx0) / (dx1 - dx0), v = sy0 + (y + 0.5 - dy0) * (sy1 - sy0) / (dy1 - dy0);
        const px = Math.floor(u), py = Math.floor(v);
        if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
        const i = y * s.width + x, j = py * src.width + px;
        if (mask & 0x4000) s.color.set(src.color.subarray(4 * j, 4 * j + 4), 4 * i);
        if ((mask & 0x100) && s.depth && src.depth) s.depth[i] = src.depth[j];
        if ((mask & 0x400) && s.stencil && src.stencil) s.stencil[i] = src.stencil[j];
      }
    },
  };
  // The EXT_framebuffer_object names of the same calls, which the programs of 2005-2010 ask for.
  for (const name of Object.keys(fboApi)) if (name !== 'glBlitFramebuffer') fboApi[`${name}EXT`] = fboApi[name];
  fboApi.glBlitFramebufferEXT = fboApi.glBlitFramebuffer;

  /** Size the framebuffer; the window system (glut.js, glx.js) calls this. */
  function resize(w, h) {
    s.win = { color: new Uint8Array(w * h * 4), depth: new Float32Array(w * h).fill(1), stencil: s.stencilBits ? new Uint8Array(w * h) : null, width: w, height: h };
    s.viewport = [0, 0, w, h];
    gpuCache = null;
    if (backend === 'webgl') { webgl = makeWebGL(w, h, s.stencilBits > 0); webgl.viewport(0, 0, w, h); for (const t of s.textures.values()) { t.dirty = true; t.gpuOwned = false; } }
    drawTarget();
  }
  /*
   * A LOST CONTEXT, rebuilt the way a resize builds one: everything the GPU held is a copy of state
   * kept here (the textures are re-sent from their pixels, marked dirty), so a new context draws the
   * next frame as the old one would have. Without this, the GPU dropping the context left the window
   * black for good while the program -- its sound, its clock -- went on (Tux Racer, mid-race).
   */
  function recoverIfLost() {
    if (!webgl?.lost) return;
    webgl = makeWebGL(s.win.width, s.win.height, s.stencilBits > 0);
    webgl.viewport(...s.viewport);
    for (const t of s.textures.values()) { t.dirty = true; t.gpuOwned = false; }
    gpuCache = null;
    drawTarget();
    onLost?.();
  }

  // --- per-vertex work
  /*
   * WORK THAT DEPENDS ON STATE, NOT ON THE VERTEX, done once per state: the normal matrix of the
   * current modelview, a directional light's normalized direction and half vector. The matrices and
   * a light's position are always REPLACED, never written in place (setTop, glLightfv), so the object
   * itself says whether the cached value is still the one. Same arithmetic, so the same bits.
   */
  let nmOf = null, nmVal = null;
  const normalMatrixOf = (mv) => (mv === nmOf ? nmVal : (nmOf = mv, nmVal = normalMatrix(mv)));
  const lightDir = new WeakMap();      // light position array -> { dir, hv }
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
      let hvFixed = null;
      if (L.position[3] === 0) {
        let c = lightDir.get(L.position);
        if (!c) { const d0 = norm3(L.position); c = { dir: d0, hv: norm3([d0[0], d0[1], d0[2] + 1]) }; lightDir.set(L.position, c); }
        dir = c.dir; hvFixed = c.hv;
      }
      else {
        const v = [L.position[0] - eye[0] / eye[3], L.position[1] - eye[1] / eye[3], L.position[2] - eye[2] / eye[3]];
        const d = Math.hypot(v[0], v[1], v[2]), [kc, kl, kq] = L.attenuation ?? [1, 0, 0];
        dir = d ? [v[0] / d, v[1] / d, v[2] / d] : [0, 0, 0];
        att = 1 / (kc + kl * d + kq * d * d);
      }
      const ndl = Math.max(0, eyeNormal[0] * dir[0] + eyeNormal[1] * dir[1] + eyeNormal[2] * dir[2]);
      let spec = 0;
      if (ndl > 0 && (m.specular[0] || m.specular[1] || m.specular[2])) {
        const hv = hvFixed ?? norm3([dir[0], dir[1], dir[2] + 1]);
        const ndh = Math.max(0, eyeNormal[0] * hv[0] + eyeNormal[1] * hv[1] + eyeNormal[2] * hv[2]);
        spec = m.shininess ? ndh ** m.shininess : (ndh > 0 ? 1 : 0);
      }
      for (let k = 0; k < 3; k++) out[k] += att * (L.ambient[k] * m.ambient[k] + ndl * L.diffuse[k] * m.diffuse[k] + spec * L.specular[k] * m.specular[k]);
    }
    out[0] = clamp01(out[0]); out[1] = clamp01(out[1]); out[2] = clamp01(out[2]); out[3] = clamp01(out[3]);
    return out;
  }
  function vertex(x, y, z, w = 1) {
    if (s.gpuPrim) { recordVertex(x, y, z, w); return; }
    const mv = s.stacks[MODELVIEW].at(-1), pr = s.stacks[PROJECTION].at(-1);
    const eye = xform(mv, x, y, z, w);
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
      const nm = normalMatrixOf(mv), n = s.normal;
      let en = [nm[0] * n[0] + nm[1] * n[1] + nm[2] * n[2], nm[3] * n[0] + nm[4] * n[1] + nm[5] * n[2], nm[6] * n[0] + nm[7] * n[1] + nm[8] * n[2]];
      if (s.caps.has(CAP.NORMALIZE)) en = norm3(en);
      colour = litColour(s.material, en, eye);
      // Two-sided: the colour a back face shows, lit with the back material and the normal reversed.
      // Which of the two a triangle gets is known only once its window-space winding is (triangle()).
      if (s.twoSide) back = litColour(s.backMaterial, [-en[0], -en[1], -en[2]], eye);
    } else colour = s.colour.map(clamp01);
    // A generated coordinate replaces the current one: the object plane dotted with the vertex as given.
    let tu = s.tex[0], tv = s.tex[1];
    const tr = s.tex.length > 2 ? s.tex[2] : 0;      // not s.tex[2] ?? 0: a read past the end is V8's slow path, once a vertex
    const genS = s.caps.has(0x0c60), genT = s.caps.has(0x0c61);
    if ((genS && s.texGen[0].mode === 0x2402) || (genT && s.texGen[1].mode === 0x2402)) {
      const sm = sphereMap(mv, eye);
      if (genS && s.texGen[0].mode === 0x2402) tu = sm[0];
      if (genT && s.texGen[1].mode === 0x2402) tv = sm[1];
    }
    if (genS && s.texGen[0].mode === 0x2401) { const p = s.texGen[0].object; tu = p[0] * x + p[1] * y + p[2] * z + p[3] * w; }
    if (genT && s.texGen[1].mode === 0x2401) { const p = s.texGen[1].object; tv = p[0] * x + p[1] * y + p[2] * z + p[3] * w; }
    // The texture matrix (2.10.2), on (s, t, r, 1) after any generation; q divided out, as a fragment
    // would. Chromium B.S.U.'s title scrolls and turns its background through it. r is 0 unless the
    // coordinate had three components, and then only is its column read.
    const tm = s.stacks[TEXTURE_MATRIX].at(-1);
    if (tm[0] !== 1 || tm[1] || tm[4] || tm[5] !== 1 || tm[12] || tm[13] || tm[3] || tm[7] || tm[15] !== 1 || (tr && (tm[8] || tm[9] || tm[11]))) {
      let q = tm[3] * tu + tm[7] * tv + tm[15];
      let su = tm[0] * tu + tm[4] * tv + tm[12], sv = tm[1] * tu + tm[5] * tv + tm[13];
      if (tr) { su += tm[8] * tr; sv += tm[9] * tr; q += tm[11] * tr; }
      tu = q === 1 ? su : su / q; tv = q === 1 ? sv : sv / q;
    }
    // The other units, each its own coordinate through its own generation and matrix -- only those
    // enabled: a disabled unit's coordinate reaches no fragment.
    let tex1 = null, tex2 = null;
    if (s.units[1].caps.has(CAP.TEXTURE_2D)) tex1 = unitCoord(s.units[1], x, y, z, w, mv, eye);
    if (s.units[2].caps.has(CAP.TEXTURE_2D)) tex2 = unitCoord(s.units[2], x, y, z, w, mv, eye);
    // Under a program with a vertex shader, the vertex as given is what the GPU gets (its attributes).
    const vs = glsl.current()?.vertex ? { o: [x, y, z, w], c: s.colour.slice(), t: [s.tex[0], s.tex[1]], n: s.normal.slice() } : null;
    s.verts.push({ clip, colour, back, tex: [tu, tv], tex1, tex2, eyeZ: Math.abs(eye[2] / (eye[3] || 1)), eye, vs });
  }
  // GL_SPHERE_MAP (GL 1.1, 2.10.4): the eye-space reflection of the view direction about the normal.
  function sphereMap(mv, eye) {
    const nm = normalMatrixOf(mv), n = s.normal;
    const en = norm3([nm[0] * n[0] + nm[1] * n[1] + nm[2] * n[2], nm[3] * n[0] + nm[4] * n[1] + nm[5] * n[2], nm[6] * n[0] + nm[7] * n[1] + nm[8] * n[2]]);
    const w = eye[3] || 1, u = norm3([eye[0] / w, eye[1] / w, eye[2] / w]);
    const d = 2 * (en[0] * u[0] + en[1] * u[1] + en[2] * u[2]);
    const r = [u[0] - d * en[0], u[1] - d * en[1], u[2] - d * en[2]];
    const m = 2 * Math.sqrt(r[0] * r[0] + r[1] * r[1] + (r[2] + 1) * (r[2] + 1)) || 1;
    return [r[0] / m + 0.5, r[1] / m + 0.5];
  }
  // A unit's (s, t) for this vertex: its current (s, t, r, q), generation, then its matrix, q divided out.
  // Whether a matrix is the identity, once per matrix: they are replaced, never written in place (setTop).
  const identity = new WeakMap();
  const isIdentity = (m) => {
    let v = identity.get(m);
    if (v === undefined) { v = true; for (let k = 0; k < 16; k++) if (m[k] !== (k % 5 === 0 ? 1 : 0)) { v = false; break; } identity.set(m, v); }
    return v;
  };
  function unitCoord(u, x, y, z, w, mv, eye) {
    const c = u.coord, genS = u.caps.has(0x0c60), genT = u.caps.has(0x0c61), g = u.texGen, tm = u.matrix.at(-1);
    // A surface's own coordinate, as given (Neverball's unit 2 for every textured face): q is 1.
    if (!genS && !genT && c[3] === 1 && isIdentity(tm)) return [c[0], c[1]];
    let cs = c[0], ct = c[1];
    const cr = c[2], cq = c[3];
    if ((genS && g[0].mode === 0x2402) || (genT && g[1].mode === 0x2402)) {
      const sm = sphereMap(mv, eye);
      if (genS && g[0].mode === 0x2402) cs = sm[0];
      if (genT && g[1].mode === 0x2402) ct = sm[1];
    }
    if (genS && g[0].mode === 0x2401) { const p = g[0].object; cs = p[0] * x + p[1] * y + p[2] * z + p[3] * w; }
    if (genT && g[1].mode === 0x2401) { const p = g[1].object; ct = p[0] * x + p[1] * y + p[2] * z + p[3] * w; }
    const q = tm[3] * cs + tm[7] * ct + tm[11] * cr + tm[15] * cq;
    const su = tm[0] * cs + tm[4] * ct + tm[8] * cr + tm[12] * cq, sv = tm[1] * cs + tm[5] * ct + tm[9] * cr + tm[13] * cq;
    return q === 1 ? [su, sv] : [su / q, sv / q];
  }

  /*
   * TRANSFORMATION AND LIGHTING ON THE GPU, for vertex arrays (P15.15). On the WebGL path a
   * glDrawArrays or glDrawElements whose state the fixed-function vertex shader covers is not taken
   * apart vertex by vertex: the program's arrays go to WebGL as they are (their bytes, types and
   * strides), the primitive becomes an index list, and the shader does what vertex() does -- the two
   * matrices, lighting with colour material and two sides, texture generation and each unit's
   * matrix, fog distance, user clip planes. The GPU clips and culls. What it does not cover falls back
   * to the vertex-by-vertex path, which stays the reference: points and lines, a GLSL program, flat
   * shading of GL_QUADS (no single provoking vertex per triangle), an array of doubles, an array not
   * aligned to its component. The arrays leave the program's current colour, normal and coordinates
   * as they were, as Mesa does; the vertex-by-vertex path sets them to the last element's.
   */
  const ARRAY_TYPES = new Set([0x1400, 0x1401, 0x1402, 0x1403, 0x1404, 0x1405, 0x1406]);
  const CM_MODE = { [PNAME.AMBIENT_AND_DIFFUSE]: 1, [PNAME.AMBIENT]: 2, [PNAME.DIFFUSE]: 3, [PNAME.SPECULAR]: 4, [PNAME.EMISSION]: 5 };
  const genMode = (caps, g, k) => (caps.has(0x0c60 + k) ? (g[k].mode === 0x2401 ? 1 : g[k].mode === 0x2402 ? 2 : 0) : 0);
  // Each primitive's triangles as index triples, the provoking vertex last (WebGL's flat varyings take it).
  // A quad is cut as assemble() cuts it: along 0-2 from arrays, along 1-3 in immediate mode.
  function triangleIndices(mode, el, flat, fromArrays = true) {
    const n = el.length, out = [];
    const t = (a, b, c) => { out.push(el[a], el[b], el[c]); };
    switch (mode) {
      case 4: for (let i = 0; i + 2 < n; i += 3) t(i, i + 1, i + 2); break;
      case 5: for (let i = 0; i + 2 < n; i++) (i & 1) ? t(i + 1, i, i + 2) : t(i, i + 1, i + 2); break;
      case 6: for (let i = 1; i + 1 < n; i++) t(0, i, i + 1); break;
      case 7:
        if (fromArrays) for (let i = 0; i + 3 < n; i += 4) { t(i, i + 1, i + 2); t(i, i + 2, i + 3); }
        else for (let i = 0; i + 3 < n; i += 4) { t(i, i + 1, i + 3); t(i + 1, i + 2, i + 3); }
        break;
      case 8: for (let i = 0; i + 3 < n; i += 2) { t(i, i + 1, i + 3); flat ? t(i + 2, i, i + 3) : t(i, i + 3, i + 2); } break;
      case 9: for (let i = 1; i + 1 < n; i++) flat ? t(i, i + 1, 0) : t(0, i, i + 1); break;
      default: return null;
    }
    return out;
  }
  // What the fixed-function vertex shader needs of the state, as typed arrays (makeWebGL's drawArrays).
  function tnlUniforms() {
    const mv = s.stacks[MODELVIEW].at(-1), lit = s.caps.has(CAP.LIGHTING), fl = new Int32Array(13);
    fl[0] = lit ? 1 : 0; fl[1] = s.caps.has(CAP.NORMALIZE) ? 1 : 0; fl[2] = lit && s.twoSide ? 1 : 0;
    if (lit && s.caps.has(0x0b57)) {
      const { face, mode } = s.colourMaterial;
      fl[3] = CM_MODE[mode] ?? 0; fl[4] = face === FRONT ? 1 : face === BACK ? 2 : 3;
    }
    const lPos = new Float32Array(32), lAmb = new Float32Array(32), lDif = new Float32Array(32), lSpe = new Float32Array(32), lAtt = new Float32Array(32);
    for (let i = 0; i < 8; i++) {
      if (!s.caps.has(CAP.LIGHT0 + i)) continue;
      const L = s.lights[i];
      fl[5] |= 1 << i;
      lPos.set(L.position, 4 * i); lAmb.set(L.ambient, 4 * i); lDif.set(L.diffuse, 4 * i); lSpe.set(L.specular, 4 * i); lAtt.set(L.attenuation ?? [1, 0, 0], 4 * i);
    }
    const clipP = new Float32Array(24);
    for (let i = 0; i < 6; i++) if (s.clipPlanes[i] && s.caps.has(CAP.CLIP_PLANE0 + i)) { fl[6] |= 1 << i; clipP.set(s.clipPlanes[i], 4 * i); }
    const tm = new Float32Array(48), genS = new Float32Array(12), genT = new Float32Array(12);
    for (let k = 0; k < UNITS; k++) {
      const caps = k ? s.units[k].caps : s.caps, g = k ? s.units[k].texGen : s.texGen;
      fl[7 + 2 * k] = genMode(caps, g, 0); fl[8 + 2 * k] = genMode(caps, g, 1);
      genS.set(g[0].object, 4 * k); genT.set(g[1].object, 4 * k);
      tm.set(k ? s.units[k].matrix.at(-1) : s.stacks[TEXTURE_MATRIX].at(-1), 16 * k);
    }
    const mat = (m) => [...m.ambient, ...m.diffuse, ...m.specular, ...m.emission];
    return {
      mv: Float32Array.from(mv), proj: Float32Array.from(s.stacks[PROJECTION].at(-1)), nmat: Float32Array.from(normalMatrixOf(mv)), fl,
      sceneAmb: Float32Array.from(s.sceneAmbient), mF: Float32Array.from(mat(s.material)), mB: Float32Array.from(mat(s.backMaterial)),
      sh: Float32Array.of(s.material.shininess, s.backMaterial.shininess), lPos, lAmb, lDif, lSpe, lAtt, tm, genS, genT, clipP,
    };
  }
  /*
   * The vertex shader's uniforms, once per state: the same cache as gpuState's, which every command
   * that is not a vertex's clears. Immediate mode asks for them at every glEnd.
   */
  let tnlFor = null, tnlVal = null;
  const tnlCached = () => { const st = gpuState(); if (tnlFor !== st) { tnlFor = st; tnlVal = tnlUniforms(); } return tnlVal; };
  /*
   * IMMEDIATE MODE on the GPU: between glBegin and glEnd each vertex's attributes are recorded as
   * given -- its position, the current colour, normal and each unit's coordinate (s, t, r, q), REC
   * floats -- and glEnd hands the primitive to makeWebGL, which batches consecutive primitives drawn
   * with the same state into one draw (Quake begins and ends a polygon per surface). A glMaterial
   * inside the primitive sends what was recorded through vertex() first, under the material it had,
   * and the rest of the primitive goes that way too.
   */
  const REC = 23;
  let rec = new Float32Array(REC * 1024), recN = 0, recFar = false;
  /*
   * A primitive whose coordinates reach past FAR goes through vertex() after all: the GPU clips it
   * itself, and a GPU's clipper has a range (SwiftShader draws nothing of a rectangle 10^6 times the
   * clip volume), where vertex()'s path has the guard band (clipGuard). Coordinates of objects drawn
   * the usual way are far inside it -- Quake's maps are within +-4096.
   */
  const FAR = 1e5;
  /*
   * ONLY WHERE THERE IS VERTEX WORK TO HAND OVER: lighting, texture generation, a user clip plane.
   * Unlit, a vertex is two matrix products in JavaScript, and that path batches across matrix changes
   * -- its triangles are in clip space -- where the shader's batch ends at each one: Tux Racer's
   * menus move the matrix for every widget, and taking them to the GPU made 526 draws a frame and
   * the frame three times slower (gl-bench).
   */
  const vertexWork = () => s.caps.has(CAP.LIGHTING) || s.caps.has(0x0c60) || s.caps.has(0x0c61) || anyUserPlane()
    || s.units[1].caps.has(0x0c60) || s.units[1].caps.has(0x0c61) || s.units[2].caps.has(0x0c60) || s.units[2].caps.has(0x0c61);
  const SMALL_DRAW = 128;
  const gpuPrimitive = (mode) => !!webgl && tnl && !glsl.current() && mode >= 4 && mode <= 9 && vertexWork() && s.polyMode[0] === FILL && s.polyMode[1] === FILL;
  function recordVertex(x, y, z, w) {
    if ((recN + 1) * REC > rec.length) { const r = new Float32Array(rec.length * 2); r.set(rec); rec = r; }
    if (x > FAR || x < -FAR || y > FAR || y < -FAR || z > FAR || z < -FAR) recFar = true;
    const o = recN++ * REC, c = s.colour, n = s.normal, t = s.tex, u1 = s.units[1].coord, u2 = s.units[2].coord;
    rec[o] = x; rec[o + 1] = y; rec[o + 2] = z; rec[o + 3] = w;
    rec[o + 4] = c[0]; rec[o + 5] = c[1]; rec[o + 6] = c[2]; rec[o + 7] = c[3];
    rec[o + 8] = t[0]; rec[o + 9] = t[1]; rec[o + 10] = t.length > 2 ? t[2] : 0; rec[o + 11] = 1;
    rec[o + 12] = n[0]; rec[o + 13] = n[1]; rec[o + 14] = n[2];
    rec[o + 15] = u1[0]; rec[o + 16] = u1[1]; rec[o + 17] = u1[2]; rec[o + 18] = u1[3];
    rec[o + 19] = u2[0]; rec[o + 20] = u2[1]; rec[o + 21] = u2[2]; rec[o + 22] = u2[3];
  }
  // The recorded vertices through vertex(), each with the current values it was given, which are put back.
  function replayRecorded() {
    const keep = [s.colour, s.normal, s.tex, s.units[1].coord, s.units[2].coord];
    s.gpuPrim = false;
    for (let i = 0; i < recN; i++) {
      const o = i * REC, r = (k, m) => Array.from(rec.subarray(o + k, o + k + m));
      s.colour = r(4, 4); s.tex = r(8, 3); s.normal = r(12, 3); s.units[1].coord = r(15, 4); s.units[2].coord = r(19, 4);
      vertex(rec[o], rec[o + 1], rec[o + 2], rec[o + 3]);
    }
    recN = 0;
    [s.colour, s.normal, s.tex, s.units[1].coord, s.units[2].coord] = keep;
  }
  function endGpuPrimitive(mode) {
    const flat = s.shade === FLAT, n = recN;
    recN = 0;
    if ((flat && mode === 7 && s.fromArrays) || recFar) { recN = n; recFar = false; replayRecorded(); assemble(mode, s.verts); s.verts = []; return; }
    const tri = triangleIndices(mode, Array.from({ length: n }, (_, i) => i), flat, !!s.fromArrays);
    if (!tri || !tri.length) return;
    const st = gpuState();
    webgl.primitive(st, `tnl${st.multi ? '-multi' : ''}${flat ? '-flat' : ''}`, tnlCached(), s.caps.has(CAP.CULL_FACE) ? [s.cullFace, s.frontFace] : null,
      rec.subarray(0, n * REC), n, tri);
    s.stats.triangles += tri.length / 3; s.stats.gpuDraws++;
    // GL_COLOR_MATERIAL: the material follows the current colour, as vertex() leaves it.
    if (s.caps.has(CAP.LIGHTING) && s.caps.has(0x0b57)) {
      const { face, mode: cm } = s.colourMaterial;
      for (const m of face === FRONT ? [s.material] : face === BACK ? [s.backMaterial] : [s.material, s.backMaterial]) {
        if (cm === PNAME.AMBIENT_AND_DIFFUSE) { m.ambient = s.colour; m.diffuse = s.colour; }
        else if (cm === PNAME.AMBIENT) m.ambient = s.colour;
        else if (cm === PNAME.DIFFUSE) m.diffuse = s.colour;
        else if (cm === PNAME.SPECULAR) m.specular = s.colour;
        else if (cm === PNAME.EMISSION) m.emission = s.colour;
      }
    }
  }
  /** Draw `count` elements of the enabled arrays on the GPU; false when the state is not one it covers. */
  function gpuArrays(mode, count, indexAt) {
    if (!webgl || !tnl || glsl.current() || s.polyMode[0] !== FILL || s.polyMode[1] !== FILL) return false;
    // A small unlit draw is cheaper batched in clip space with its neighbours (see vertexWork): Cube
    // draws its world as some 1,700 strips a frame, and one GPU draw each halved its frame rate.
    if (count < SMALL_DRAW && !vertexWork()) return false;
    const flat = s.shade === FLAT;
    if (mode < 4 || mode > 9 || (flat && mode === 7)) return false;
    const va = s.arrays.vertex;
    if (!va.on || va.size < 2) return false;
    const list = [[0, va, false]];
    if (s.arrays.color.on) list.push([1, s.arrays.color, true]);
    if (s.arrays.tex.on) list.push([2, s.arrays.tex, false]);
    if (s.arrays.normal.on) list.push([4, s.arrays.normal, true]);
    for (let k = 1; k < UNITS; k++) if (s.units[k].array.on) list.push([4 + k, s.units[k].array, false]);
    for (const [, a] of list) if (!ARRAY_TYPES.has(a.type) || a.ptr % a.n || a.step % a.n) return false;
    const el = new Uint32Array(count);
    for (let i = 0; i < count; i++) el[i] = indexAt(i);
    const tri = triangleIndices(mode, el, flat);
    if (!tri) return false;
    if (!tri.length) return true;
    let lo = Infinity, hi = -1;
    for (const i of tri) { if (i < lo) lo = i; if (i > hi) hi = i; }
    // The bytes each array spans for those elements, neighbouring spans (interleaved arrays) uploaded once.
    const spans = list.map(([loc, a, norm]) => ({ loc, a, norm, start: a.ptr + lo * a.step, end: a.ptr + hi * a.step + a.size * a.n }))
      .sort((x, y) => x.start - y.start);
    const ranges = [];
    for (const sp of spans) {
      const r = ranges.at(-1);
      if (r && sp.start <= r.end + 256) { r.end = Math.max(r.end, sp.end); r.spans.push(sp); }
      else ranges.push({ start: sp.start, end: sp.end, spans: [sp] });
    }
    const attribs = [], uploads = [];
    ranges.forEach((r, i) => {
      const base = r.start & ~3;
      uploads.push(M.u8.slice(base, r.end));
      for (const sp of r.spans) attribs.push({ loc: sp.loc, size: sp.a.size, type: sp.a.type, norm: sp.norm, stride: sp.a.step, range: i, offset: sp.start - base });
    });
    const indices = hi - lo < 65536 ? new Uint16Array(tri.length) : new Uint32Array(tri.length);
    for (let i = 0; i < tri.length; i++) indices[i] = tri[i] - lo;
    const t0 = s.tex, u = s.units;
    const consts = { 1: s.colour, 2: [t0[0], t0[1], t0.length > 2 ? t0[2] : 0, 1], 4: [...s.normal, 0], 5: u[1].coord, 6: u[2].coord };
    const st = gpuState();
    const key = `tnl${st.multi ? '-multi' : ''}${flat ? '-flat' : ''}`;
    webgl.drawArrays(st, key, tnlCached(), uploads, attribs, consts, indices, s.caps.has(CAP.CULL_FACE) ? [s.cullFace, s.frontFace] : null);
    s.stats.triangles += tri.length / 3; s.stats.gpuDraws++;
    return true;
  }

  // --- clipping against the near plane (z + w >= 0), every attribute linear in clip space
  const lerpV = (a, b, t) => ({
    clip: a.clip.map((v, k) => v + (b.clip[k] - v) * t),
    colour: a.colour.map((v, k) => v + (b.colour[k] - v) * t),
    back: a.back && a.back.map((v, k) => v + (b.back[k] - v) * t),
    tex: [a.tex[0] + (b.tex[0] - a.tex[0]) * t, a.tex[1] + (b.tex[1] - a.tex[1]) * t],
    tex1: a.tex1 && [a.tex1[0] + (b.tex1[0] - a.tex1[0]) * t, a.tex1[1] + (b.tex1[1] - a.tex1[1]) * t],
    tex2: a.tex2 && [a.tex2[0] + (b.tex2[0] - a.tex2[0]) * t, a.tex2[1] + (b.tex2[1] - a.tex2[1]) * t],
    eyeZ: a.eyeZ + (b.eyeZ - a.eyeZ) * t,
    eye: a.eye && a.eye.map((v, k) => v + (b.eye[k] - v) * t),
  });
  function clipNear(poly) {
    let inside = true;
    for (let i = 0; i < poly.length; i++) if (poly[i].clip[2] + poly[i].clip[3] < 0) { inside = false; break; }
    if (inside) return poly;
    const d = (v) => v.clip[2] + v.clip[3];
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

  /*
   * THE GUARD BAND. GL clips a primitive to the clip volume whatever its size (2.12); a GPU does not
   * always: SwiftShader draws nothing of a rectangle whose corners are 10^6 times the volume (10^5 it
   * draws), Mesa's llvmpipe loses a corner of one at 10^8, and where a GPU gives up is its own. So a
   * polygon reaching beyond GUARD times the volume in x or y is clipped HERE to those planes,
   * attributes linear in clip space as GL's clipping takes them, and each rasteriser clips what is left
   * to the window. Both rasterisers, so that both are given the same polygons. Anything within the
   * band -- every primitive of an ordinary frame -- is drawn as it is.
   */
  const GUARD = 1e4;
  const guardPlanes = [(v) => GUARD * v.clip[3] - v.clip[0], (v) => GUARD * v.clip[3] + v.clip[0],
    (v) => GUARD * v.clip[3] - v.clip[1], (v) => GUARD * v.clip[3] + v.clip[1]];
  const outsideGuard = (v) => { const g = GUARD * v.clip[3]; return v.clip[0] > g || v.clip[0] < -g || v.clip[1] > g || v.clip[1] < -g; };
  function clipGuard(poly) {
    let out = true;
    for (let i = 0; i < poly.length; i++) if (outsideGuard(poly[i])) { out = false; break; }
    if (out) return poly;
    for (const d of guardPlanes) {
      if (poly.length < 2) break;
      const next = [];
      for (let i = 0; i < poly.length; i++) {
        if (poly.length === 2 && i === 1) break;               // a segment: one edge, not a closed loop
        const a = poly[i], b = poly[(i + 1) % poly.length], da = d(a), db = d(b);
        if (da >= 0) next.push(a);
        if ((da >= 0) !== (db >= 0)) next.push(lerpV(a, b, da / (da - db)));
        if (poly.length === 2 && db >= 0) next.push(b);
      }
      poly = next;
    }
    return poly;
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
    let w = t.levels[0].w, h = t.levels[0].h, d = t.levels[0].d ?? 1, lv = 0;
    for (;;) {
      const L = t.levels[lv];
      if (!L || L.w !== w || L.h !== h || (L.d ?? 1) !== d) return false;
      if (w === 1 && h === 1 && d === 1) return true;
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); d = Math.max(1, d >> 1); lv++;
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
  /*
   * The units a fragment goes through, in order: those enabled whose texture is complete (an incomplete
   * one is as if disabled, 3.8.10). Unit 0 by itself in a classic environment is the one-unit path.
   */
  function textureStages() {
    const out = [];
    if (s.caps.has(CAP.TEXTURE_2D)) { const t = s.textures.get(s.bound); if (t && complete(t)) out.push({ k: 0, key: 'tex', t, env: s.envMode, combine: s.combine }); }
    for (let k = 1; k < UNITS; k++) {
      const u = s.units[k];
      if (!u.caps.has(CAP.TEXTURE_2D)) continue;
      const t = s.textures.get(u.bound);
      if (t && complete(t)) out.push({ k, key: k === 1 ? 'tex1' : 'tex2', t, env: u.envMode, combine: u.combine });
    }
    return out;
  }
  const oneUnit = (st) => st.length === 1 && st[0].k === 0 && st[0].env !== TEX.COMBINE;
  // A texel as GL_COMBINE's TEXTURE source has it (table 3.15): what the base format lacks, 0 or 1.
  function texSource(base, ct) {
    if (base === 'RGB') return [ct[0], ct[1], ct[2], 1];
    if (base === 'L') return [ct[0], ct[0], ct[0], 1];
    if (base === 'LA') return [ct[0], ct[0], ct[0], ct[3]];
    if (base === 'I') return [ct[0], ct[0], ct[0], ct[0]];
    if (base === 'A') return [0, 0, 0, ct[3]];
    return [ct[0], ct[1], ct[2], ct[3]];
  }
  function combineApply(c, base, ct, prev, prim) {
    const T = texSource(base, ct);
    const src = (x) => (x === 0x1702 ? T : x === 0x8576 ? c.colour : x === 0x8577 ? prim : prev);
    const fn = (f, a0, a1, a2) => (f === 0x1e01 ? a0 : f === 0x2100 ? a0 * a1 : f === 0x0104 ? a0 + a1 : f === 0x8574 ? a0 + a1 - 0.5
      : f === 0x8575 ? a0 * a2 + a1 * (1 - a2) : a0 - a1);
    const out = [0, 0, 0, 0];
    const argRGB = (i, k) => { const v = src(c.srcRGB[i]), o = c.opRGB[i]; return o === 0x300 ? v[k] : o === 0x301 ? 1 - v[k] : o === 0x302 ? v[3] : 1 - v[3]; };
    for (let k = 0; k < 3; k++) out[k] = clamp01(fn(c.rgb, argRGB(0, k), argRGB(1, k), argRGB(2, k)) * c.scaleRGB);
    const argA = (i) => { const a = src(c.srcA[i])[3]; return c.opA[i] === 0x302 ? a : 1 - a; };
    out[3] = clamp01(fn(c.alpha, argA(0), argA(1), argA(2)) * c.scaleA);
    return out;
  }
  function envApply(cf, ct, base, m = s.envMode) {
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
    if (s.depth && s.caps.has(CAP.DEPTH_TEST)) {
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
    // differences taken once. An edge two triangles share is walked u->v by one and v->u by the other;
    // evaluated each its own way, the two roundings need not be opposite, and a pixel centre on the edge
    // went to neither (a row of holes along a quad's diagonal). So an edge is always evaluated from its
    // lower endpoint (by y, then x) and negated for the other direction: exactly opposite values, and
    // the top-left rule gives the pixel to one triangle.
    const edgeFn = (u, v) => {
      if (u.y < v.y || (u.y === v.y && u.x < v.x)) { const dx = v.x - u.x, dy = v.y - u.y; return (cx, cy) => dx * (cy - u.y) - dy * (cx - u.x); }
      const dx = u.x - v.x, dy = u.y - v.y;
      return (cx, cy) => -(dx * (cy - v.y) - dy * (cx - v.x));
    };
    const eQ = edgeFn(Q, R), eR = edgeFn(R, P), eP = edgeFn(P, Q);
    const stages = textureStages();
    const t = oneUnit(stages) ? stages[0].t : null;
    const textured = !!t;
    // More than unit 0, or a combiner: each unit in turn, its own coordinate and level of detail.
    const multi = !textured && stages.length ? stages : null;
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
    if (multi) for (const S of multi) { S.L0 = S.t.levels[0]; S.rhoOf = new Float64Array(quads); S.rhoRow = new Int32Array(quads).fill(-1); }
    const texAtK = (cx, cy, key, k) => {
      const l0 = eQ(cx, cy) / ar, l1 = eR(cx, cy) / ar, l2 = eP(cx, cy) / ar;
      const iw = l0 * P.iw + l1 * Q.iw + l2 * R.iw;
      return persp(l0, l1, l2, iw, P, Q, R, Pv[key][k], Qv[key][k], Rv[key][k]);
    };
    const quadRhoK = (px, py, key, L) => {
      const qx = (px & ~1) + 0.5, qy = (py & ~1) + 0.5;
      const u0 = texAtK(qx, qy, key, 0), v0 = texAtK(qx, qy, key, 1);
      const dudx = (texAtK(qx + 1, qy, key, 0) - u0) * L.w, dvdx = (texAtK(qx + 1, qy, key, 1) - v0) * L.h;
      const dudy = (texAtK(qx, qy + 1, key, 0) - u0) * L.w, dvdy = (texAtK(qx, qy + 1, key, 1) - v0) * L.h;
      return Math.max(Math.hypot(dudx, dvdx), Math.hypot(dudy, dvdy));
    };
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
        } else if (multi) {
          const prim = col, qc = (px >> 1) - qc0;
          for (const S of multi) {
            const key = S.key;
            const u = persp(l0, l1, l2, iw, P, Q, R, Pv[key][0], Qv[key][0], Rv[key][0]);
            const v = persp(l0, l1, l2, iw, P, Q, R, Pv[key][1], Qv[key][1], Rv[key][1]);
            if (S.rhoRow[qc] !== row) { S.rhoRow[qc] = row; S.rhoOf[qc] = quadRhoK(px, py, key, S.L0); }
            const ct = sample(S.t, u, v, S.rhoOf[qc]);
            col = S.env === TEX.COMBINE ? combineApply(S.combine, S.t.base, ct, col, prim) : envApply(col, ct, S.t.base, S.env);
          }
        }
        fragment(py * W + px, z, col, fog ? persp(l0, l1, l2, iw, P, Q, R, Pv.eyeZ, Qv.eyeZ, Rv.eyeZ) : 0);
      }
    }
  }
  function triangle(a, b, c, provoking) {
    s.stats.triangles++;
    // A vertex shader positions the vertices: clipping and culling are the GPU's (the cull state goes
    // with the program, apply()).
    if (webgl && a.vs) { webgl.tri(a, b, c, null, gpuState()); return; }
    let poly = clipUser(clipNear([a, b, c]));
    poly = clipGuard(poly);
    if (poly.length < 3) return;
    const asBack = (v) => ({ ...v, colour: v.back });
    for (let k = 1; k + 1 < poly.length; k++) {
      let p0 = poly[0], p1 = poly[k], p2 = poly[k + 1];
      // The GPU path needs only the winding: toWindow's own arithmetic, without its three objects.
      let A = null, B = null, C = null, area;
      if (webgl) {
        const [vx, vy, vw, vh] = s.viewport;
        const ax = (p0.clip[0] / p0.clip[3] + 1) * vw / 2 + vx, ay = (p0.clip[1] / p0.clip[3] + 1) * vh / 2 + vy;
        const bx = (p1.clip[0] / p1.clip[3] + 1) * vw / 2 + vx, by = (p1.clip[1] / p1.clip[3] + 1) * vh / 2 + vy;
        const cx = (p2.clip[0] / p2.clip[3] + 1) * vw / 2 + vx, cy = (p2.clip[1] / p2.clip[3] + 1) * vh / 2 + vy;
        area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
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
      else if (glsl.current()) throw new Error('gl: GLSL programs are drawn by the WebGL rasteriser only');
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
    if (v.vs) throw new Error('gl: GLSL: points drawn under a vertex shader are not implemented');
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
    if (webgl && a.vs) { webgl.line(a, b, gpuState()); return; }
    let seg = clipUserSegment(clipNear([a, b]));
    if (seg.length === 2) seg = clipGuard(seg);
    if (seg.length < 2) return;
    if (webgl) { webgl.line(seg[0], seg[1], gpuState()); return; }
    const A = toWindow(seg[0]), B = toWindow(seg[1]), ca = seg[0].colour, cb = seg[1].colour;
    /*
     * GL 1.1 3.4.1's DIAMOND-EXIT rule, as Mesa (llvmpipe) draws it: a pixel is drawn when the segment
     * leaves the diamond |x - xc| + |y - yc| < 1/2 about its centre. Along the major axis that is each
     * column (row) whose centre the segment crosses, in the row (column) it crosses it at -- unless the
     * segment ENDS inside that diamond; and the pixel the segment STARTS inside, whose centre it may
     * not cross. A connected strip so draws each shared vertex's pixel once.
     */
    const xMajor = Math.abs(B.x - A.x) >= Math.abs(B.y - A.y);
    const [a0, a1, b0, b1] = xMajor ? [A.x, B.x, A.y, B.y] : [A.y, B.y, A.x, B.x];
    if (a0 === a1) return;
    const inDiamond = (P, i, j) => Math.abs(P.x - (i + 0.5)) + Math.abs(P.y - (j + 0.5)) < 0.5;
    const [bx0, by0, bx1, by1] = drawBox();
    const lo = Math.floor(Math.min(a0, a1)), hi = Math.floor(Math.max(a0, a1));
    for (let m = lo; m <= hi; m++) {
      const t = (m + 0.5 - a0) / (a1 - a0), n = Math.floor(b0 + (b1 - b0) * t);
      const [x, y] = xMajor ? [m, n] : [n, m];
      if (inDiamond(B, x, y)) continue;                      // it ends inside: never left
      if (!(t >= 0 && t < 1) && !inDiamond(A, x, y)) continue;
      if (x < bx0 || y < by0 || x > bx1 || y > by1) continue;
      const u = Math.min(Math.max(t, 0), 1);
      fragment(y * s.width + x, A.z + (B.z - A.z) * u, ca.map((v, i) => v + (cb[i] - v) * u), 0);
    }
  }
  /*
   * A triangle under glPolygonMode other than GL_FILL: its facing decided first, from the sign of the
   * homogeneous determinant of its clip coordinates -- the winding of whatever part of it lies in front
   * of the eye, so no clipping is needed to know it -- then culled, then drawn as its boundary EDGES
   * (`edges`: bit 0 a-b, bit 1 b-c, bit 2 c-a; the diagonals that cut a quad or a polygon into triangles
   * are not edges) or as the vertices that start them. Each edge is clipped as a line is, so the edges
   * that clipping would add to the polygon are never drawn, as Mesa's draw module leaves them unflagged.
   */
  function unfilled(a, b, c, provoking, edges) {
    if (a.vs) throw new Error('gl: GLSL: glPolygonMode other than GL_FILL under a vertex shader is not implemented');
    const [ax, ay, , aw] = a.clip, [bx, by, , bw] = b.clip, [cx, cy, , cw] = c.clip;
    const det = ax * (by * cw - bw * cy) - ay * (bx * cw - bw * cx) + aw * (bx * cy - by * cx);
    if (det === 0) return;
    const front = (det > 0) === (s.frontFace === CCW);
    if (s.caps.has(CAP.CULL_FACE) && (s.cullFace === FRONT_AND_BACK || (s.cullFace === BACK) === !front)) { s.stats.culled++; return; }
    const mode = s.polyMode[front ? 0 : 1];
    if (mode === FILL) { triangle(a, b, c, provoking); return; }
    const back = !front && a.back;
    const colour = provoking ? (back ? provoking.back : provoking.colour) : null;
    const as = (p) => (back || colour ? { ...p, colour: colour ?? p.back } : p);
    const q = [as(a), as(b), as(c)];
    for (let k = 0; k < 3; k++) if (edges & (1 << k)) { if (mode === LINE) line(q[k], q[(k + 1) % 3]); else point(q[k]); }
  }
  function assemble(mode, v) {
    const flat = s.shade === FLAT;
    const fill = s.polyMode[0] === FILL && s.polyMode[1] === FILL;
    const tri = (a, b, c, provoking, edges = 7) => (fill ? triangle(v[a], v[b], v[c], flat ? v[provoking] : null)
      : unfilled(v[a], v[b], v[c], flat ? v[provoking] : null, edges));
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
        if (s.fromArrays) for (let i = 0; i + 3 < v.length; i += 4) { tri(i, i + 1, i + 2, i + 3, 3); tri(i, i + 2, i + 3, i + 3, 6); }
        else for (let i = 0; i + 3 < v.length; i += 4) { tri(i, i + 1, i + 3, i + 3, 5); tri(i + 1, i + 2, i + 3, i + 3, 3); }
        break;
      case 0x0008: for (let i = 0; i + 3 < v.length; i += 2) { tri(i, i + 1, i + 3, i + 3, 3); tri(i, i + 3, i + 2, i + 3, 6); } break;
      case 0x0009: for (let i = 1; i + 1 < v.length; i++) tri(0, i, i + 1, 0, 2 | (i === 1 ? 1 : 0) | (i + 2 === v.length ? 4 : 0)); break;
      case 0x0000: for (const p of v) point(p); break;
      default: throw new Error(`gl: primitive 0x${mode.toString(16)} is not implemented`);
    }
  }
  /** What the GPU path needs of the fragment state, as one comparable value. */
  function gpuState() {
    if (gpuCache) return gpuCache;
    // A GLSL program samples the bound texture whether or not GL_TEXTURE_2D is enabled.
    const t = s.caps.has(CAP.TEXTURE_2D) || glsl.current() ? s.textures.get(s.bound) : null, textured = !!(t && complete(t));
    const stages = glsl.current() ? [] : textureStages(), multi = stages.length && !oneUnit(stages) ? multiKey(stages) : '';
    if (textured && t.dirty && !t.gpuOwned) { webgl.upload(s.bound, t); t.dirty = false; }
    const t3 = glsl.current() ? texture3D() : null, textured3 = !!(t3 && complete(t3));
    if (textured3 && t3.dirty) { webgl.upload3D(s.bound3D, t3); t3.dirty = false; }
    return gpuCache = {
      tex: textured ? s.bound : -1, base: textured ? t.base : '', env: s.envMode,
      min: textured ? t.min : 0, mag: textured ? t.mag : 0, wrapS: textured ? t.wrapS : 0, wrapT: textured ? t.wrapT : 0,
      multi,
      tex3: textured3 ? s.bound3D : -1, params3: textured3 ? `${t3.min},${t3.mag},${t3.wrapS},${t3.wrapT},${t3.wrapR}` : '',
      blend: s.caps.has(CAP.BLEND) ? `${s.blend[0]},${s.blend[1]}` : '',
      alpha: s.caps.has(CAP.ALPHA_TEST) ? `${s.alphaFunc},${s.alphaRef}` : '',
      depth: s.caps.has(CAP.DEPTH_TEST) ? `${s.depthFunc},${s.depthMask}` : '',
      range: `${s.depthRange[0]},${s.depthRange[1]}`,
      scissor: s.caps.has(CAP.SCISSOR_TEST) ? s.scissor.join(',') : '',
      mask: s.colorMask.join(','),
      stencil: s.stencil && s.caps.has(CAP.STENCIL_TEST) ? `${s.stencilFunc.join(',')},${s.stencilOp.join(',')},${s.stencilWriteMask}` : '',
      offset: s.caps.has(CAP.POLYGON_OFFSET_FILL) ? s.polygonOffset.join(',') : '',
      fog: s.caps.has(CAP.FOG) ? `${s.fog.mode},${s.fog.density},${s.fog.start},${s.fog.end},${s.fog.colour.join(',')}` : '',
      program: glsl.key(), glsl: glsl.current(),
      cull: glsl.current()?.vertex && s.caps.has(CAP.CULL_FACE) ? `${s.cullFace},${s.frontFace}` : '',
      xf: glsl.current()?.matrices?.length ? builtinMatrices() : null,
    };
  }
  /*
   * The units for the WebGL path's multitexture program, as one string: per unit its number, texture,
   * base format, environment and combiner, and the texture's filters -- what apply() sends. The
   * textures of units 1 and 2 are uploaded here as unit 0's is above.
   */
  const BASE_N = { RGB: 0, RGBA: 1, L: 2, LA: 3, A: 4, I: 5 }, ENV_N = { [TEX.MODULATE]: 0, [TEX.REPLACE]: 1, [TEX.DECAL]: 2, [TEX.COMBINE]: 3 };
  function multiKey(stages) {
    return stages.map(({ k, t, env, combine: c }) => {
      const id = k ? s.units[k].bound : s.bound;
      if (k && t.dirty && !t.gpuOwned) { webgl.upload(id, t); t.dirty = false; }
      return [k, id, BASE_N[t.base] ?? 1, ENV_N[env], COMBINE_FN[c.rgb], COMBINE_FN[c.alpha], ...c.srcRGB.map((x) => COMBINE_SRC[x]), ...c.srcA.map((x) => COMBINE_SRC[x]),
        ...c.opRGB.map((x) => COMBINE_OP[x]), ...c.opA.map((x) => COMBINE_OP[x]), c.scaleRGB, c.scaleA, ...c.colour, t.min, t.mag, t.wrapS, t.wrapT].join(',');
    }).join('|');
  }
  /*
   * GLSL's built-in matrices (glsl.js), from the stacks' tops. Those are replaced, never written in
   * place, so the same three tops are the same values: one object for them, which gpuState compares.
   */
  let xfOf = [], xfVal = null, xfId = 0;
  function builtinMatrices() {
    const mv = s.stacks[MODELVIEW].at(-1), pr = s.stacks[PROJECTION].at(-1), tm = s.stacks[TEXTURE_MATRIX].at(-1);
    if (xfOf[0] === mv && xfOf[1] === pr && xfOf[2] === tm) return xfVal;
    xfOf = [mv, pr, tm];
    const t4 = (m) => Float32Array.from({ length: 16 }, (_, k) => m[(k % 4) * 4 + (k >> 2)]);
    const base = { ModelView: mv, Projection: pr, ModelViewProjection: mul(pr, mv), Texture: tm }, v = { id: ++xfId };
    for (const [name, m] of Object.entries(base)) {
      const inv = invert4(m);
      v[`gl_${name}Matrix`] = Float32Array.from(m); v[`gl_${name}MatrixInverse`] = Float32Array.from(inv);
      v[`gl_${name}MatrixTranspose`] = t4(m); v[`gl_${name}MatrixInverseTranspose`] = t4(inv);
    }
    const nm = normalMatrix(mv);                               // row-major; a uniform is column-major
    v.gl_NormalMatrix = Float32Array.of(nm[0], nm[3], nm[6], nm[1], nm[4], nm[7], nm[2], nm[5], nm[8]);
    return xfVal = v;
  }

  // --- textures
  /*
   * Client texels as RGBA bytes. GL_FLOAT ones are stored as every internal format here is, 8 bits a
   * component: clamped to [0, 1] and rounded to the nearest of 255 steps, as Mesa stores floats given
   * to an 8-bit format -- converted first into tightly packed bytes, then read as those.
   */
  function toRGBA(format, w, h, ptr, type = 0x1401) {
    let u8 = M.u8, out = new Uint8Array(w * h * 4);
    const n = { [FMT.RGBA]: 4, [FMT.RGB]: 3, [FMT.LUMINANCE]: 1, [FMT.ALPHA]: 1, [FMT.LUMINANCE_ALPHA]: 2, [FMT.INTENSITY]: 1 }[format];
    if (!n) throw new Error(`gl: pixel format 0x${format.toString(16)} (colour index needs an extension PRISM does not advertise)`);
    if (type !== 0x1401 && type !== 0x1406) throw new Error(`gl: texel type 0x${type.toString(16)} (GL_UNSIGNED_BYTE or GL_FLOAT)`);
    let row = Math.ceil(w * n / s.unpackAlign) * s.unpackAlign;
    if (type === 0x1406) {
      const frow = Math.ceil(w * n * 4 / s.unpackAlign) * s.unpackAlign, packed = new Uint8Array(w * h * n), d = dv();
      for (let j = 0; j < h; j++) for (let i = 0; i < w * n; i++) {
        const f = d.getFloat32(ptr + j * frow + 4 * i, true);
        packed[j * w * n + i] = Math.round((f > 1 ? 1 : f > 0 ? f : 0) * 255);
      }
      u8 = packed; ptr = 0; row = w * n;
    }
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
        if ((mask & 0x100) && s.depthMask && s.depth) s.depth[i] = s.clearDepth;
        if ((mask & 0x400) && s.stencil) { const wm = s.stencilWriteMask & 0xff; s.stencil[i] = (s.stencil[i] & ~wm) | (s.clearStencil & wm); }
      }
    },
    glClearColor: (r, g, b, a) => { s.clear = [r, g, b, a].map(clamp01); },
    glEnable: (cap) => {
      if (s.activeUnit && UNIT_CAPS.has(cap)) { s.units[s.activeUnit].caps.add(cap); return; }
      // A capability this GL does not implement is said once, by number: enabling it changes nothing
      // here, and a picture that is wrong for that reason should be traceable to it.
      if (!KNOWN_CAPS.has(cap) && !(cap >= 0x4000 && cap < 0x4008) && !(cap >= 0x3000 && cap < 0x3006) && !s.unknownCaps.has(cap)) {
        s.unknownCaps.add(cap);
        console.warn(`gl: glEnable(0x${cap.toString(16)}) has no effect in this implementation`);
      }
      s.caps.add(cap);
    },
    glColorMaterial: (face, mode) => { s.colourMaterial = { face, mode }; },
    glDisable: (cap) => { if (s.activeUnit && UNIT_CAPS.has(cap)) { s.units[s.activeUnit].caps.delete(cap); return; } s.caps.delete(cap); },
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
    glPushMatrix: () => { stackOf(s.mode).push(Float64Array.from(top())); },
    /*
     * The attribute stacks (GL 1.1 6.1.14, Table 6.x's "attribute" column): each group the state it
     * names, of what is kept here, with the enables that belong to it. The state of a texture OBJECT
     * is not saved with GL_TEXTURE_BIT (only the bindings), as Mesa does not either since GL 1.1's
     * objects. A group with no state kept here (pixel mode, hints, multisample) saves nothing,
     * which is exact while nothing can change it.
     */
    glPushAttrib: (mask) => {
      const saved = { mask, fields: {}, caps: [], unitCaps: null, units: null };
      for (const [bit, g] of ATTRIB_GROUPS) {
        if (!(mask & bit)) continue;
        for (const k of g.fields) saved.fields[k] = structuredClone(s[k]);
        for (const cap of g.caps) saved.caps.push([cap, s.caps.has(cap)]);
      }
      if (mask & 0x2000) {                                  // GL_ENABLE_BIT: every capability, every unit
        saved.allCaps = new Set(s.caps); saved.unknownCaps = new Set(s.unknownCaps);
        saved.unitCaps = s.units.map((u) => u && new Set(u.caps));
      }
      if (mask & 0x40000) saved.units = s.units.map((u) => u && structuredClone({ bound: u.bound, envMode: u.envMode, combine: u.combine, texGen: u.texGen,
        caps: [...u.caps].filter((c) => TEXTURE_CAPS.includes(c)) }));
      if (mask & 0x1) saved.coords = s.units.map((u) => u && [...u.coord]);
      (s.attribStack ??= []).push(saved);
    },
    glPopAttrib: () => {
      const a = s.attribStack?.pop();
      if (!a) return;                                      // GL_STACK_UNDERFLOW: nothing changes
      if (a.allCaps) {
        s.caps = a.allCaps; s.unknownCaps = a.unknownCaps;
        a.unitCaps.forEach((c, k) => { if (c) s.units[k].caps = c; });
      }
      Object.assign(s, a.fields);
      for (const [cap, on] of a.caps) { if (on) s.caps.add(cap); else s.caps.delete(cap); }
      if (a.units) a.units.forEach((u, k) => {
        if (!u) return;
        const unit = s.units[k];
        unit.bound = u.bound; unit.envMode = u.envMode; unit.combine = u.combine; unit.texGen = u.texGen;
        for (const c of TEXTURE_CAPS) { if (u.caps.includes(c)) unit.caps.add(c); else unit.caps.delete(c); }
      });
      if (a.coords) a.coords.forEach((c, k) => { if (c) s.units[k].coord = c; });
      if (a.mask & 0x800 && webgl) webgl.viewport(...s.viewport);      // the one piece of state the backend holds itself
    },
    // ...and the client's: the pixel store (both alignments) and the vertex arrays.
    glPushClientAttrib: (mask) => {
      const other = mask & ~(0x1 | 0x2);
      if (other) throw new Error(`gl: glPushClientAttrib of the groups 0x${other.toString(16)} is not implemented`);
      (s.clientAttribStack ??= []).push({ mask, unpackAlign: s.unpackAlign, packAlign: s.packAlign, arrays: mask & 0x2 ? JSON.parse(JSON.stringify(s.arrays)) : null,
        unitArrays: mask & 0x2 ? s.units.map((u) => u && JSON.parse(JSON.stringify(u.array))) : null });
    },
    glPopClientAttrib: () => {
      const a = s.clientAttribStack?.pop();
      if (!a) return;
      if (a.mask & 0x1) { s.unpackAlign = a.unpackAlign; s.packAlign = a.packAlign; }
      if (a.arrays) { s.arrays = a.arrays; a.unitArrays.forEach((x, k) => { if (x) s.units[k].array = x; }); }
    },
    glPopMatrix: () => { const st = stackOf(s.mode); if (st.length > 1) st.pop(); },
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
    glBegin: (mode) => { s.prim = mode; s.verts = []; recN = 0; recFar = false; s.gpuPrim = gpuPrimitive(mode); },
    glEnd: () => {
      const m = s.prim; s.prim = null;
      if (s.gpuPrim) { s.gpuPrim = false; endGpuPrimitive(m); return; }
      const v = s.verts; s.verts = []; assemble(m, v);
    },
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
    glRects: (x1, y1, x2, y2) => exec.glRectf(x1, y1, x2, y2),
    glRectd: (x1, y1, x2, y2) => exec.glRectf(Math.fround(x1), Math.fround(y1), Math.fround(x2), Math.fround(y2)),
    // The vector forms: two corners, read at call time (ARRAYS) and converted as their scalar forms are.
    glRectfv: (a, b) => exec.glRectf(a[0], a[1], b[0], b[1]),
    glRectiv: (a, b) => exec.glRectf(a[0], a[1], b[0], b[1]),
    glRectsv: (a, b) => exec.glRectf(a[0], a[1], b[0], b[1]),
    glRectdv: (a, b) => exec.glRectd(a[0], a[1], b[0], b[1]),
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
      const g = (xunit()?.texGen ?? s.texGen)[coord - 0x2000];
      if (!g || pname !== 0x2500) throw new Error(`gl: glTexGeni 0x${coord.toString(16)} 0x${pname.toString(16)}`);
      if (v !== 0x2401 && v !== 0x2402) throw new Error(`gl: texture generation mode 0x${v.toString(16)} (GL_EYE_LINEAR is not implemented)`);
      g.mode = v;
    },
    glTexGenfv: (coord, pname, v) => {
      const g = (xunit()?.texGen ?? s.texGen)[coord - 0x2000];
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
      if (s.gpuPrim) replayRecorded();          // between glBegin and glEnd: what came before keeps its material
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
      if (target !== CAP.TEXTURE_2D && target !== TEX3D) throw new Error(`gl: texture target 0x${target.toString(16)}`);
      if (id && !s.textures.has(id)) s.textures.set(id, newTexture());
      if (s.activeUnit) {
        if (target === TEX3D) throw new Error('gl: GL_TEXTURE_3D on a texture unit other than 0 is not implemented');
        s.units[s.activeUnit].bound = id; return;
      }
      if (target === TEX3D) s.bound3D = id; else s.bound = id;
    },
    glTexParameterf: (target, p, v) => {
      const t = targetTexture(target);
      if (p === TEX.MIN) t.min = v; else if (p === TEX.MAG) t.mag = v;
      else if (p === TEX.WRAP_S) t.wrapS = v; else if (p === TEX.WRAP_T) t.wrapT = v;
      else if (p === WRAP_R) t.wrapR = v;
      else if (p === GENERATE_MIPMAP) { t.generate = !!v; if (t.generate && t.levels[0]) generateMipmaps(t); }
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
    glActiveTextureARB: (unit) => { const k = unit - 0x84c0; if (k < 0 || k >= UNITS) throw new Error(`gl: texture unit 0x${unit.toString(16)}`); s.activeUnit = k; },
    glClientActiveTextureARB: (unit) => { const k = unit - 0x84c0; if (k < 0 || k >= UNITS) throw new Error(`gl: texture unit 0x${unit.toString(16)}`); s.clientUnit = k; },
    glColor3fv: (v) => { s.colour = [v[0], v[1], v[2], 1]; },
    glColor4ubv: (v) => { s.colour = [v[0] / 255, v[1] / 255, v[2] / 255, v[3] / 255]; },
    glColor4ub: (r, g, b, a) => { s.colour = [(r & 255) / 255, (g & 255) / 255, (b & 255) / 255, (a & 255) / 255]; },
    glEnableClientState: (cap) => { (ARRAY[cap] === 'tex' ? clientTex() : s.arrays[ARRAY[cap]]).on = true; },
    glDisableClientState: (cap) => { (ARRAY[cap] === 'tex' ? clientTex() : s.arrays[ARRAY[cap]]).on = false; },
    glVertexPointer: (size, type, stride, ptr) => { Object.assign(s.arrays.vertex, { size, type, stride, ...layout(type, size, stride), ...inBuffer(ptr) }); },
    glColorPointer: (size, type, stride, ptr) => { Object.assign(s.arrays.color, { size, type, stride, ...layout(type, size, stride), ...inBuffer(ptr) }); },
    glTexCoordPointer: (size, type, stride, ptr) => { Object.assign(clientTex(), { size, type, stride, ...layout(type, size, stride), ...inBuffer(ptr) }); },
    glNormalPointer: (type, stride, ptr) => { Object.assign(s.arrays.normal, { size: 3, type, stride, ...layout(type, 3, stride), ...inBuffer(ptr) }); },
    // One element of the enabled arrays, as if its colour, texture coordinate and vertex were given.
    // One element of the enabled arrays, as if its colour, texture coordinate and vertex were given.
    glArrayElement: (i) => {
      const { vertex: va, color: ca, tex: ta, normal: na } = s.arrays;
      if (na.on) s.normal = [arrayAt(na, i, 0, true), arrayAt(na, i, 1, true), arrayAt(na, i, 2, true)];
      if (ca.on) s.colour = [arrayAt(ca, i, 0, true), arrayAt(ca, i, 1, true), arrayAt(ca, i, 2, true), ca.size > 3 ? arrayAt(ca, i, 3, true) : 1];
      // r too when the array has it: Neverball's shadow takes positions as coordinates, through a matrix.
      if (ta.on) s.tex = ta.size > 2 ? [arrayAt(ta, i, 0, false), arrayAt(ta, i, 1, false), arrayAt(ta, i, 2, false)] : [arrayAt(ta, i, 0, false), ta.size > 1 ? arrayAt(ta, i, 1, false) : 0];
      for (let k = 1; k < UNITS; k++) {
        const a = s.units[k].array;
        // Written in place: vertex() reads it at once (unitCoord) and keeps only what it computes from it.
        if (a.on) { const c = s.units[k].coord; c[0] = arrayAt(a, i, 0, false); c[1] = a.size > 1 ? arrayAt(a, i, 1, false) : 0; c[2] = a.size > 2 ? arrayAt(a, i, 2, false) : 0; c[3] = a.size > 3 ? arrayAt(a, i, 3, false) : 1; }
      }
      if (va.on) vertex(arrayAt(va, i, 0, false), arrayAt(va, i, 1, false), va.size > 2 ? arrayAt(va, i, 2, false) : 0);
    },
    // GL_EXT_compiled_vertex_array: a lock is a promise the program makes, which nothing here relies on.
    glLockArraysEXT: () => {},
    glUnlockArraysEXT: () => {},
    glTexEnvf: (target, p, v) => {
      if (target === 0x8861 && p === 0x8862) { s.coordReplace = !!v; return; }   // GL_POINT_SPRITE, GL_COORD_REPLACE
      const u = xunit();
      if (p === TEX.ENV_MODE) {
        if (v !== TEX.MODULATE && v !== TEX.REPLACE && v !== TEX.DECAL && v !== TEX.COMBINE) throw new Error(`gl: texture environment 0x${v.toString(16)}`);
        if (u) u.envMode = v; else s.envMode = v;
        return;
      }
      const c = u ? u.combine : s.combine;
      const check = (table, x) => { if (table[x] === undefined) throw new Error(`gl: glTexEnv 0x${p.toString(16)} = 0x${x.toString(16)}`); return x; };
      if (p === 0x8571) c.rgb = check(COMBINE_FN, v);
      else if (p === 0x8572) c.alpha = check(COMBINE_FN, v);
      else if (p >= 0x8580 && p <= 0x8582) c.srcRGB[p - 0x8580] = check(COMBINE_SRC, v);
      else if (p >= 0x8588 && p <= 0x858a) c.srcA[p - 0x8588] = check(COMBINE_SRC, v);
      else if (p >= 0x8590 && p <= 0x8592) c.opRGB[p - 0x8590] = check(COMBINE_OP, v);
      else if (p >= 0x8598 && p <= 0x859a) c.opA[p - 0x8598] = check({ 0x302: 2, 0x303: 3 }, v);
      else if (p === 0x8573) c.scaleRGB = v;
      else if (p === 0x0d1c) c.scaleA = v;
      else throw new Error(`gl: glTexEnv 0x${p.toString(16)}`);
    },
    glTexEnvi: (target, p, v) => exec.glTexEnvf(target, p, v),
    // GL_TEXTURE_ENV_COLOR: the active unit's constant colour, GL_COMBINE's CONSTANT source.
    glTexEnvfv: (target, p, v) => {
      if (p !== 0x2201) { exec.glTexEnvf(target, p, v[0]); return; }
      (xunit()?.combine ?? s.combine).colour = v.map(clamp01);
    },
    glTexParameteri: (target, p, v) => exec.glTexParameterf(target, p, v),
    glTexImage2D: (target, level, internal, w, h, border, format, type, texels) => {
      const t = texture();
      t.base = baseFormat(internal);
      t.levels[level] = { w, h, data: texels ?? new Uint8Array(w * h * 4) };
      t.dirty = true; t.gpuOwned = false;
      written(t, level);
      if (s.drawFbo) drawTarget();               // an attached level redefined: the target follows it
    },
    // Its texels as RGBA bytes, one w x h layer after another (read at call time, see ARRAYS).
    glTexImage3D: (target, level, internal, w, h, d, border, format, type, texels) => {
      if (target !== TEX3D) throw new Error(`gl: glTexImage3D target 0x${target.toString(16)}`);
      const t = texture3D();
      t.base = baseFormat(internal);
      t.levels[level] = { w, h, d, data: texels ?? new Uint8Array(w * h * d * 4) };
      t.dirty = true;
      written(t, level);
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
      if (p === 0x1004) { targetTexture(target).border = v; return; }   // GL_TEXTURE_BORDER_COLOR, kept with the texture
      exec.glTexParameterf(target, p, v[0]);
    },
    glCallList: (n) => { for (const [name, args] of s.lists.get(n) ?? []) exec[name](...args); },
  };
  /*
   * The immediate-mode spellings not written above, from IMM_FAMILIES: each converts its components
   * (IMM_TYPES) and sets what its family sets. glTexCoord4 with q other than 1 divides it out at the
   * vertex, as the texture matrix's q is (vertex()). Unit 0's glMultiTexCoord is glTexCoord.
   */
  const IMM_SET = {
    glVertex: (c) => vertex(c[0], c[1], c.length > 2 ? c[2] : 0, c.length > 3 ? c[3] : 1),
    glColor: (c) => { s.colour = [c[0], c[1], c[2], c.length > 3 ? c[3] : 1]; },
    glNormal: (c) => { s.normal = [c[0], c[1], c[2]]; },
    glTexCoord: (c) => {
      const q = c.length > 3 ? c[3] : 1;
      s.tex = c.length > 2 ? [c[0] / q, c[1] / q, c[2] / q] : [c[0], c.length > 1 ? c[1] : 0];
    },
    glMultiTexCoord: (c, unit) => {
      const k = unit - 0x84c0;
      if (k < 0 || k >= UNITS) throw new Error(`gl: texture unit 0x${unit.toString(16)}`);
      if (k === 0) IMM_SET.glTexCoord(c);
      else s.units[k].coord = [c[0], c.length > 1 ? c[1] : 0, c.length > 2 ? c[2] : 0, c.length > 3 ? c[3] : 1];
    },
  };
  const immediate = immediateForms().filter((m) => !exec[m.name]);
  for (const { name, family, n, t, v } of immediate) {
    const conv = family === 'glColor' || family === 'glNormal' ? IMM_TYPES[t][3] : t === 'f' ? (c) => c : Math.fround;
    const set = IMM_SET[family], multi = family === 'glMultiTexCoord';
    exec[name] = v ? (multi ? (unit, a) => set(a.map(conv), unit) : (a) => set(a.map(conv)))
      : multi ? (unit, ...c) => set(c.map(conv), unit) : (...c) => set(c.map(conv));
  }
  exec.glActiveTexture = exec.glActiveTextureARB;
  exec.glClientActiveTexture = exec.glClientActiveTextureARB;
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
    glRectfv: (a) => [f32(a[0], 2), f32(a[1], 2)],
    glRectiv: (a) => [0, 1].map((k) => [dv().getInt32(a[k], true), dv().getInt32(a[k] + 4, true)]),
    glRectsv: (a) => [0, 1].map((k) => [dv().getInt16(a[k], true), dv().getInt16(a[k] + 2, true)]),
    glRectdv: (a) => [0, 1].map((k) => [dv().getFloat64(a[k], true), dv().getFloat64(a[k] + 8, true)]),
    glMultMatrixd: (a) => [Array.from({ length: 16 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))],
    glLoadMatrixd: (a) => [Array.from({ length: 16 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))],
    glTexCoord2dv: (a) => [Array.from({ length: 2 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))], glColor3dv: (a) => [Array.from({ length: 3 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))], glColor4dv: (a) => [Array.from({ length: 4 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))],
    glVertex2dv: (a) => [Array.from({ length: 2 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))], glVertex3dv: (a) => [Array.from({ length: 3 }, (_, k) => dv().getFloat64(a[0] + 8 * k, true))], glNormal3fv: (a) => [f32(a[0], 3)],
    glTexGenfv: (a) => [a[0], a[1], f32(a[2], a[1] === 0x2500 ? 1 : 4)],
    glClipPlane: (a) => [a[0], Array.from({ length: 4 }, (_, k) => dv().getFloat64(a[1] + 8 * k, true))],
    glTexParameterfv: (a) => [a[0], a[1], f32(a[2], a[1] === 0x1004 ? 4 : 1)],
    glTexEnvfv: (a) => [a[0], a[1], f32(a[2], a[1] === 0x2201 ? 4 : 1)],
    glPointParameterfvARB: (a) => [a[0], f32(a[1], a[0] === 0x8129 ? 3 : 1)],
    glTexImage2D: (a) => {
      return [...a.slice(0, 8), a[8] ? toRGBA(a[6], a[3], a[4], a[8], a[7]) : null];
    },
    glTexImage3D: (a) => {
      return [...a.slice(0, 9), a[9] ? toRGBA(a[7], a[3], a[4] * a[5], a[9], a[8]) : null];
    },
  };
  for (const { name, family, n, t, v } of immediate) {
    if (!v) continue;
    const [, size, get] = IMM_TYPES[t], at = family === 'glMultiTexCoord' ? 1 : 0;
    ARRAYS[name] = (a) => { const r = Array.from({ length: n }, (_, k) => dv()[get](a[at] + size * k, true)); return at ? [a[0], r] : [r]; };
  }
  // Only these leave the fragment state alone; every other command may change it, display lists included.
  const VERTEX_ONLY = new Set(['glBegin', 'glEnd', 'glVertex2f', 'glVertex3f', 'glVertex3fv', 'glNormal3f',
    'glColor3f', 'glColor4f', 'glColor3fv', 'glColor4fv', 'glColor3ubv', 'glColor4ubv', 'glTexCoord2f', 'glTexCoord2fv',
    'glArrayElement', 'glLockArraysEXT', 'glUnlockArraysEXT', 'glTexCoord2d', 'glTexCoord2dv', 'glColor3dv', 'glColor4dv',
    'glVertex2dv', 'glVertex3dv', 'glNormal3fv', ...immediate.map((m) => m.name)]);
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
  // GLSL's entry points: what they change is part of the state a draw is made with.
  for (const [name, fn] of Object.entries(glsl.api)) api[name] = (...a) => { gpuCache = null; return fn(...a); };
  function copyFramebuffer(L, xo, yo, x, y, w, h) {
    const { data: fb, width: W, height: H } = readBuffer();
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const sx = x + i, sy = y + j, tx = xo + i, ty = yo + j;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H || tx >= L.w || ty >= L.h) continue;
      L.data.set(fb.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (ty * L.w + tx) * 4);
    }
  }
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
      const t = texture(), L = t.levels[level], src = toRGBA(format, w, h, ptr, type);
      for (let j = 0; j < h; j++) L.data.set(src.subarray(j * w * 4, (j + 1) * w * 4), ((y + j) * L.w + x) * 4);
      if (webgl && t.gpuOwned) { webgl.texSubImage(s.activeUnit ? s.units[s.activeUnit].bound : s.bound, level, x, y, w, h, src); gpuCache = null; return; }
      // A dirty texture is uploaded where the draw state is worked out: so that state is worked out again.
      written(t, level);
      t.dirty = true; gpuCache = null;
    },
    glTexSubImage3D: (target, level, x, y, z, w, h, d, format, type, ptr) => {
      const t = texture3D(), L = t.levels[level], src = toRGBA(format, w, h * d, ptr, type);
      if (!L) throw new Error(`gl: glTexSubImage3D into level ${level}, which has no image`);
      for (let k = 0; k < d; k++) for (let j = 0; j < h; j++) {
        L.data.set(src.subarray(((k * h + j) * w) * 4, ((k * h + j) * w + w) * 4), (((z + k) * L.h + y + j) * L.w + x) * 4);
      }
      written(t, level);
      t.dirty = true; gpuCache = null;
    },
    // The framebuffer copied into a texture, through the texture's own copy of its texels (what both
    // rasterisers upload from): read back after whatever is pending is drawn. A source pixel outside the
    // framebuffer is undefined (GL 1.1, 3.8.2); it is left as it was.
    glCopyTexSubImage2D: (target, level, xo, yo, x, y, w, h) => {
      const t = texture(), L = t.levels[level];
      if (!L) throw new Error(`gl: glCopyTexSubImage2D into level ${level}, which has no image`);
      if (webgl && t.gpuOwned) { webgl.copyTexSubImage(s.activeUnit ? s.units[s.activeUnit].bound : s.bound, level, xo, yo, x, y, w, h, s.readFbo); gpuCache = null; return; }
      copyFramebuffer(L, xo, yo, x, y, w, h);
      written(t, level);
      t.dirty = true; gpuCache = null;
    },
    glCopyTexImage2D: (target, level, internal, x, y, w, h, border) => {
      const t = texture(), L = { w, h, data: new Uint8Array(w * h * 4) };
      t.base = baseFormat(internal);
      t.levels[level] = L;
      t.gpuOwned = false;
      copyFramebuffer(L, 0, 0, x, y, w, h);
      written(t, level);
      t.dirty = true; gpuCache = null;
    },
    glReadPixels: (x, y, w, h, format, type, out) => {
      // The depth buffer, as floats in [0, 1]: Cube reads the one under its crosshair every frame.
      if (format === 0x1902 && type === 0x1406) {
        readBuffer();                                        // whatever is pending is drawn first
        const d = webgl ? webgl.readDepth(x, y, w, h) : null;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) dv().setFloat32(out + 4 * (j * w + i), d ? d[j * w + i] : s.depth[(y + j) * s.width + x + i], true);
        return;
      }
      const { data: fb, width: W } = readBuffer(), n = format === FMT.RGBA ? 4 : format === FMT.RGB ? 3 : 0;
      if (!n || type !== 0x1401) throw new Error('gl: glReadPixels wants GL_RGB or GL_RGBA, GL_UNSIGNED_BYTE');
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const o = ((y + j) * W + x + i) * 4, d = out + (j * w + i) * n;
        for (let k = 0; k < n; k++) M.u8[d + k] = fb[o + k];
      }
    },
    glDeleteTextures: (n, ids) => { for (let k = 0; k < n; k++) { const id = dv().getUint32(ids + 4 * k, true); if (id) { s.textures.delete(id); s.genTextures.delete(id); if (s.bound === id) s.bound = 0; if (s.bound3D === id) s.bound3D = 0; for (const u of s.units) if (u?.bound === id) u.bound = 0; } } },
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
      const vals = store ? store : p === 0x0d57 ? [s.stencilBits] : p === 0x0d33 ? [16384] : p === 0x0ba2 ? s.viewport : p === 0x0d32 ? [6] : p === 0x84e2 ? [UNITS]
        : p === 0x84e0 ? [0x84c0 + s.activeUnit] : p === 0x84e1 ? [0x84c0 + s.clientUnit] : null;
      if (!vals) throw new Error(`gl: glGetIntegerv 0x${p.toString(16)}`);
      vals.forEach((v, k) => dv().setInt32(out + 4 * k, v, true));
    },
    // glDrawElements: the enabled arrays, element by element, as if each index were glArrayElement.
    // The arrays' elements first..first+count-1, between a Begin and an End of the mode.
    glDrawArrays: (mode, first, count) => {
      if (s.recording) throw new Error('gl: glDrawArrays inside a display list is not implemented');
      if (gpuArrays(mode, count, (i) => first + i)) return;
      exec.glBegin(mode);
      for (let i = 0; i < count; i++) exec.glArrayElement(first + i);
      s.fromArrays = true; exec.glEnd(); s.fromArrays = false;
    },
    glDrawElements: (mode, count, type, ptr) => {
      if (s.elementBuffer) ptr += s.buffers.get(s.elementBuffer).ptr;
      if (s.recording) throw new Error('gl: glDrawElements inside a display list is not implemented');
      const size = type === 0x1405 ? 4 : type === 0x1403 ? 2 : type === 0x1401 ? 1 : 0;
      if (!size) throw new Error(`gl: glDrawElements index type 0x${type.toString(16)}`);
      if (gpuArrays(mode, count, size === 4 ? (i) => dv().getUint32(ptr + 4 * i, true) : size === 2 ? (i) => dv().getUint16(ptr + 2 * i, true) : (i) => M.u8[ptr + i])) return;
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
    glIsEnabled: (cap) => ((s.activeUnit && UNIT_CAPS.has(cap) ? s.units[s.activeUnit].caps : s.caps).has(cap) ? 1 : 0),
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
    glPolygonMode: (face, mode) => {
      if (face !== BACK) s.polyMode[0] = mode;
      if (face !== FRONT) s.polyMode[1] = mode;
    },
    glHint: () => {}, glDrawBuffer: () => {}, glReadBuffer: () => {},
    ...fboApi,
    glFinish: () => {}, glFlush: () => {},
  });
  Object.assign(M.rt, api);

  const gl = {
    state: s, resize,
    /** The picture, top row first, RGBA -- GL's framebuffer is bottom row first. */
    readPixels() {
      const { width: W, height: H } = s.win, src = webgl ? webgl.read(0, W, H) : s.win.color, out = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) out.set(src.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
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
  let FS_FIXED = '', FS_MULTI = '';
  const prog = g.createProgram();
  g.attachShader(prog, shader(g.VERTEX_SHADER, `#version 300 es
in vec4 pos; in vec4 col; in vec2 tc; in float ez;
out vec4 v; out vec2 uv; out float eyeZ;
uniform int zFlip;     // 1 while glDepthRange is reversed (near > far); see apply()
void main() { gl_Position = vec4(pos.xy, zFlip == 1 ? -pos.z : pos.z, pos.w); v = col; uv = tc; eyeZ = ez; }`));
  g.attachShader(prog, shader(g.FRAGMENT_SHADER, FS_FIXED = `#version 300 es
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
  const programs = makeGLSLWebGL(g, ['pos', 'col', 'tc', 'ez'], shader);   // GLSL programs (src/env/glsl.js)
  const U0 = Object.fromEntries(['tex', 'textured', 'base', 'env', 'alphaFn', 'fogMode', 'alphaRef', 'fogDensity', 'fogStart', 'fogEnd', 'fogColour', 'zFlip']
    .map((n) => [n, g.getUniformLocation(prog, n)]));
  let U = U0;                                 // the current fixed program's uniforms: prog's, or multi's
  /*
   * THE MULTITEXTURE PROGRAM, for a batch that uses a unit other than 0 or a combiner: the same
   * pipeline with three samplers (WebGL units 0, 2 and 3 -- 1 is readDepth's) applied in turn, each
   * unit in its classic environment or GL_COMBINE, and two more coordinates a vertex. Made the first
   * time it is wanted and used only then, so a one-unit program sends WebGL what it always did.
   */
  let multi = null;
  const multiProgram = () => {
    if (multi) return multi;
    const p = g.createProgram();
    g.attachShader(p, shader(g.VERTEX_SHADER, `#version 300 es
in vec4 pos; in vec4 col; in vec2 tc; in float ez; in vec2 tc1; in vec2 tc2;
out vec4 v; out vec2 uv; out float eyeZ; out vec2 uv1; out vec2 uv2;
uniform int zFlip;
void main() { gl_Position = vec4(pos.xy, zFlip == 1 ? -pos.z : pos.z, pos.w); v = col; uv = tc; eyeZ = ez; uv1 = tc1; uv2 = tc2; }`));
    g.attachShader(p, shader(g.FRAGMENT_SHADER, FS_MULTI = `#version 300 es
precision highp float;
in vec4 v; in vec2 uv; in float eyeZ; in vec2 uv1; in vec2 uv2; out vec4 o;
uniform sampler2D tex0, tex1, tex2;
// Per unit: on, base (0 RGB 1 RGBA 2 L 3 LA 4 A 5 I), environment (0 MODULATE 1 REPLACE 2 DECAL 3 COMBINE);
// the combiner as cA (functions RGB, alpha; RGB sources 0, 1), cB (RGB source 2; alpha sources 0-2),
// cC (RGB operands 0-2; alpha operands packed 2 bits each), its constant colour and its two scales.
uniform int on[3], base[3], env[3];
uniform ivec4 cA[3], cB[3], cC[3];
uniform vec4 kc[3]; uniform vec2 sc[3];
uniform int alphaFn, fogMode;
uniform float alphaRef, fogDensity, fogStart, fogEnd;
uniform vec4 fogColour;
bool cmp(int f, float a, float b) {
  if (f == 0) return false; if (f == 1) return a < b; if (f == 2) return a == b; if (f == 3) return a <= b;
  if (f == 4) return a > b; if (f == 5) return a != b; if (f == 6) return a >= b; return true;
}
vec4 source(int b, vec4 t) {
  if (b == 0) return vec4(t.rgb, 1.0); if (b == 2) return vec4(t.rrr, 1.0); if (b == 3) return vec4(t.rrr, t.a);
  if (b == 4) return vec4(0.0, 0.0, 0.0, t.a); if (b == 5) return vec4(t.r); return t;
}
vec4 pick(int s, vec4 T, vec4 k, vec4 prim, vec4 prev) { return s == 0 ? T : s == 1 ? k : s == 2 ? prim : prev; }
vec3 opc(int o, vec4 c) { return o == 0 ? c.rgb : o == 1 ? 1.0 - c.rgb : o == 2 ? vec3(c.a) : vec3(1.0 - c.a); }
float opa(int o, vec4 c) { return o == 2 ? c.a : 1.0 - c.a; }
vec3 fnc(int f, vec3 a0, vec3 a1, vec3 a2) {
  if (f == 0) return a0; if (f == 1) return a0 * a1; if (f == 2) return a0 + a1; if (f == 3) return a0 + a1 - 0.5;
  if (f == 4) return a0 * a2 + a1 * (1.0 - a2); return a0 - a1;
}
float fna(int f, float a0, float a1, float a2) {
  if (f == 0) return a0; if (f == 1) return a0 * a1; if (f == 2) return a0 + a1; if (f == 3) return a0 + a1 - 0.5;
  if (f == 4) return a0 * a2 + a1 * (1.0 - a2); return a0 - a1;
}
vec4 unit(int i, vec4 t, vec4 c, vec4 prim) {
  int b = base[i];
  if (env[i] == 3) {
    vec4 T = source(b, t), k = kc[i];
    ivec4 A = cA[i], B = cB[i], C = cC[i];
    vec3 rgb = fnc(A.x, opc(C.x, pick(A.z, T, k, prim, c)), opc(C.y, pick(A.w, T, k, prim, c)), opc(C.z, pick(B.x, T, k, prim, c)));
    float a = fna(A.y, opa(C.w & 3, pick(B.y, T, k, prim, c)), opa((C.w >> 2) & 3, pick(B.z, T, k, prim, c)), opa((C.w >> 4) & 3, pick(B.w, T, k, prim, c)));
    return clamp(vec4(rgb * sc[i].x, a * sc[i].y), 0.0, 1.0);
  }
  if (b == 5) t = vec4(t.r); else if (b == 2) t = vec4(t.rrr, 1.0); else if (b == 3) t = vec4(t.rrr, t.a);
  bool hasA = b == 1 || b == 3 || b == 4 || b == 5;
  if (env[i] == 1) return b == 4 ? vec4(c.rgb, t.a) : vec4(t.rgb, hasA ? t.a : c.a);
  if (env[i] == 2) return b == 0 ? vec4(t.rgb, c.a) : vec4(mix(c.rgb, t.rgb, t.a), c.a);
  return b == 4 ? vec4(c.rgb, c.a * t.a) : vec4(c.rgb * t.rgb, hasA ? c.a * t.a : c.a);
}
void main() {
  vec4 c = v;
  if (on[0] == 1) c = unit(0, texture(tex0, uv), c, v);
  if (on[1] == 1) c = unit(1, texture(tex1, uv1), c, v);
  if (on[2] == 1) c = unit(2, texture(tex2, uv2), c, v);
  if (fogMode != 0) {
    float f = fogMode == 1 ? (fogEnd - eyeZ) / (fogEnd - fogStart) : fogMode == 2 ? exp(-fogDensity * eyeZ) : exp(-pow(fogDensity * eyeZ, 2.0));
    f = clamp(f, 0.0, 1.0);
    c = vec4(mix(fogColour.rgb, c.rgb, f), c.a);
  }
  if (alphaFn >= 0 && !cmp(alphaFn, c.a, alphaRef)) discard;
  o = c;
}`));
    ['pos', 'col', 'tc', 'ez'].forEach((n, i) => g.bindAttribLocation(p, i, n));
    g.bindAttribLocation(p, 5, 'tc1'); g.bindAttribLocation(p, 6, 'tc2');
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(`gl: link: ${g.getProgramInfoLog(p)}`);
    const loc = (n) => g.getUniformLocation(p, n);
    multi = { p, U: Object.fromEntries(['alphaFn', 'fogMode', 'alphaRef', 'fogDensity', 'fogStart', 'fogEnd', 'fogColour', 'zFlip'].map((n) => [n, loc(n)]).concat([['textured', null], ['base', null], ['env', null]])),
      on: loc('on'), base: loc('base'), env: loc('env'), cA: loc('cA'), cB: loc('cB'), cC: loc('cC'), kc: loc('kc'), sc: loc('sc') };
    g.useProgram(p);
    g.uniform1i(loc('tex0'), 0); g.uniform1i(loc('tex1'), 2); g.uniform1i(loc('tex2'), 3);
    return multi;
  };
  /*
   * THE FIXED-FUNCTION VERTEX SHADER (P15.15): what the front end's vertex() computes, from the
   * program's own arrays -- see gpuArrays. Its lighting is litColour's: emission and scene ambient,
   * then each enabled light, directional or positional with 1 / (kc + kl d + kq d^2), the half vector
   * towards +z (no local viewer), specular only where the diffuse term lights. Paired with either
   * fragment shader, which takes the face's colour (two-sided lighting) and discards what a user clip
   * plane removes; with `flat` varyings for flat shading, the provoking vertex last.
   */
  const tnlVS = (q) => `#version 300 es
in vec4 pos; in vec4 col; in vec4 tc0; in vec3 nrm; in vec4 tc1; in vec4 tc2;
uniform mat4 mv, proj; uniform mat3 nmat;
// fl: lighting, normalize, two sides, colour material (1 ambient and diffuse, 2 ambient, 3 diffuse, 4 specular,
// 5 emission), its faces (1 front, 2 back, 3 both), the lights on (bits), the clip planes on (bits), then
// each unit's generation of s and t (1 object linear, 2 sphere map).
uniform int fl[13];
uniform vec4 sceneAmb, mF[4], mB[4]; uniform vec2 sh;
uniform vec4 lPos[8], lAmb[8], lDif[8], lSpe[8], lAtt[8];
uniform mat4 tm[3]; uniform vec4 genS[3], genT[3], clipP[6];
uniform int zFlip;
${q}out vec4 vF; ${q}out vec4 vB; out vec2 uv; out float eyeZ; out vec2 uv1; out vec2 uv2; out float clipD[6];
vec4 lit(vec4 a, vec4 d, vec4 sp, vec4 e, float shin, vec3 n, vec3 p) {
  vec3 c = e.rgb + sceneAmb.rgb * a.rgb;
  for (int i = 0; i < 8; i++) {
    if ((fl[5] & (1 << i)) == 0) continue;
    vec3 dir; float att = 1.0;
    if (lPos[i].w == 0.0) dir = normalize(lPos[i].xyz);
    else { vec3 v = lPos[i].xyz - p; float dd = length(v); dir = dd > 0.0 ? v / dd : vec3(0.0); att = 1.0 / (lAtt[i].x + lAtt[i].y * dd + lAtt[i].z * dd * dd); }
    float ndl = max(0.0, dot(n, dir)), spec = 0.0;
    if (ndl > 0.0 && (sp.r != 0.0 || sp.g != 0.0 || sp.b != 0.0)) {
      float ndh = max(0.0, dot(n, normalize(dir + vec3(0.0, 0.0, 1.0))));
      spec = shin > 0.0 ? pow(ndh, shin) : (ndh > 0.0 ? 1.0 : 0.0);
    }
    c += att * (lAmb[i].rgb * a.rgb + ndl * lDif[i].rgb * d.rgb + spec * lSpe[i].rgb * sp.rgb);
  }
  return clamp(vec4(c, d.a), 0.0, 1.0);
}
vec2 coord(int k, vec4 c, vec2 sm) {
  int gs = fl[7 + 2 * k], gt = fl[8 + 2 * k];
  if (gs == 1) c.x = dot(genS[k], vec4(pos.xyz, 1.0)); else if (gs == 2) c.x = sm.x;
  if (gt == 1) c.y = dot(genT[k], vec4(pos.xyz, 1.0)); else if (gt == 2) c.y = sm.y;
  vec4 t = tm[k] * c;
  return t.xy / t.w;
}
void main() {
  vec4 eye = mv * pos, cp = proj * eye;
  gl_Position = vec4(cp.xy, zFlip == 1 ? -cp.z : cp.z, cp.w);
  eyeZ = abs(eye.z / eye.w);
  vec3 p = eye.xyz / eye.w, en = nrm * nmat, n = fl[1] == 1 ? normalize(en) : en;
  vec2 sm = vec2(0.5);
  if (fl[7] == 2 || fl[8] == 2 || fl[9] == 2 || fl[10] == 2 || fl[11] == 2 || fl[12] == 2) {
    vec3 un = normalize(en), u = normalize(p), r = u - 2.0 * dot(un, u) * un;
    float m = 2.0 * sqrt(r.x * r.x + r.y * r.y + (r.z + 1.0) * (r.z + 1.0));
    if (m == 0.0) m = 1.0;
    sm = vec2(r.x / m + 0.5, r.y / m + 0.5);
  }
  if (fl[0] == 1) {
    vec4 aF = mF[0], dF = mF[1], sF = mF[2], eF = mF[3], aB = mB[0], dB = mB[1], sB = mB[2], eB = mB[3];
    int cm = fl[3];
    if (cm != 0 && (fl[4] & 1) != 0) { if (cm == 1 || cm == 2) aF = col; if (cm == 1 || cm == 3) dF = col; if (cm == 4) sF = col; if (cm == 5) eF = col; }
    if (cm != 0 && (fl[4] & 2) != 0) { if (cm == 1 || cm == 2) aB = col; if (cm == 1 || cm == 3) dB = col; if (cm == 4) sB = col; if (cm == 5) eB = col; }
    vF = lit(aF, dF, sF, eF, sh.x, n, p);
    vB = fl[2] == 1 ? lit(aB, dB, sB, eB, sh.y, -n, p) : vF;
  } else { vF = clamp(col, 0.0, 1.0); vB = vF; }
  uv = coord(0, tc0, sm); uv1 = coord(1, tc1, sm); uv2 = coord(2, tc2, sm);
  for (int i = 0; i < 6; i++) clipD[i] = dot(clipP[i], eye);
}`;
  const tnlFS = (src, q) => src.replace('in vec4 v; ', `${q}in vec4 vF; ${q}in vec4 vB; in float clipD[6]; `)
    .replace('void main() {\n', 'uniform int twoSided, clipMask;\nvoid main() {\n  for (int i = 0; i < 6; i++) if ((clipMask & (1 << i)) != 0 && clipD[i] < 0.0) discard;\n  vec4 v = twoSided == 1 && !gl_FrontFacing ? vB : vF;\n');
  const TNL_UNIFORMS = ['mv', 'proj', 'nmat', 'fl', 'sceneAmb', 'mF', 'mB', 'sh', 'lPos', 'lAmb', 'lDif', 'lSpe', 'lAtt', 'tm', 'genS', 'genT', 'clipP'];
  const tnlPrograms = new Map();
  const tnlProgram = (key) => {
    let rec = tnlPrograms.get(key);
    if (rec) return rec;
    const isMulti = key.includes('multi'), q = key.includes('flat') ? 'flat ' : '';
    if (isMulti) multiProgram();                       // FS_MULTI is written when that program is made
    const p = g.createProgram();
    g.attachShader(p, shader(g.VERTEX_SHADER, tnlVS(q)));
    g.attachShader(p, shader(g.FRAGMENT_SHADER, tnlFS(isMulti ? FS_MULTI : FS_FIXED, q)));
    [['pos', 0], ['col', 1], ['tc0', 2], ['nrm', 4], ['tc1', 5], ['tc2', 6]].forEach(([nm, i]) => g.bindAttribLocation(p, i, nm));
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(`gl: link: ${g.getProgramInfoLog(p)}`);
    const loc = (nm) => g.getUniformLocation(p, nm);
    const common = ['alphaFn', 'fogMode', 'alphaRef', 'fogDensity', 'fogStart', 'fogEnd', 'fogColour', 'zFlip', 'twoSided', 'clipMask'];
    rec = isMulti
      ? { p, U: Object.fromEntries(common.map((nm) => [nm, loc(nm)]).concat([['textured', null], ['base', null], ['env', null]])),
        on: loc('on'), base: loc('base'), env: loc('env'), cA: loc('cA'), cB: loc('cB'), cC: loc('cC'), kc: loc('kc'), sc: loc('sc') }
      : { p, U: Object.fromEntries(['tex', 'textured', 'base', 'env', ...common].map((nm) => [nm, loc(nm)])) };
    rec.vs = Object.fromEntries(TNL_UNIFORMS.map((nm) => [nm, loc(nm)]));
    rec.last = {};
    g.useProgram(p);
    if (isMulti) { g.uniform1i(loc('tex0'), 0); g.uniform1i(loc('tex1'), 2); g.uniform1i(loc('tex2'), 3); } else g.uniform1i(loc('tex'), 0);
    tnlPrograms.set(key, rec);
    return rec;
  };
  const fixedRec = { p: prog, U: U0 };
  let curRec = fixedRec;
  const recFor = (key) => (key === 'fixed' ? fixedRec : key === 'fixed-multi' ? multiProgram() : tnlProgram(key));
  // The uniforms the two fixed programs share by name: switching between them, each is sent again.
  const FIXED_UNIFORMS = ['textured', 'base', 'env', 'alpha', 'fog', 'multi'];
  g.uniform1i(U.tex, 0);
  const vertexBuffer = g.createBuffer();
  g.bindBuffer(g.ARRAY_BUFFER, vertexBuffer);
  const STRIDE = 11 * 4;
  g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 4, g.FLOAT, false, STRIDE, 0);
  g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 4, g.FLOAT, false, STRIDE, 16);
  g.enableVertexAttribArray(2); g.vertexAttribPointer(2, 2, g.FLOAT, false, STRIDE, 32);
  g.enableVertexAttribArray(3); g.vertexAttribPointer(3, 1, g.FLOAT, false, STRIDE, 40);
  g.disable(g.CULL_FACE);
  const gpuTex = new Map();
  const MAXV = 3 * 65536, data = new Float32Array(MAXV * 11);
  let dataM_ = null;
  const dataMOf = () => (dataM_ ??= new Float32Array(MAXV * 15));   // a multitexture batch's vertices, made when first wanted
  // The normals, for a vertex shader's gl_Normal: their own buffer and attribute 4, bound only for a
  // batch drawn with one, so a program without one sends WebGL what it always did.
  let normalBuffer = null, normals = null;
  let n = 0, mode = g.TRIANGLES, key = null, pending = null;
  let tnlVao = null, tnlIndexBuffer = null;
  // The framebuffer drawn into: the window's (target) or a framebuffer object's (framebuffer()).
  let cur = target;
  const fbos = new Map(), renderbuffers = new Map();
  const renderbuffer = (rb, format) => {
    const k = `${rb.id}`, want = `${rb.w}x${rb.h}:${format}`;
    let r = renderbuffers.get(k);
    if (!r) { r = { rb: g.createRenderbuffer(), as: '' }; renderbuffers.set(k, r); }
    if (r.as !== want) { r.as = want; g.bindRenderbuffer(g.RENDERBUFFER, r.rb); g.renderbufferStorage(g.RENDERBUFFER, format, rb.w, rb.h); }
    return r.rb;
  };
  const tnlBuffers = [];
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
  let applied = { program: 'fixed' }, culling = false;
  const texParams = new Map();                // texture id -> its min, mag and wraps as last set
  const gpuTex3 = new Map(), texParams3 = new Map();   // the same for GL_TEXTURE_3D (its default object is id 0)
  const put = (k, v, send) => { if (applied[k] !== v) { applied[k] = v; send(); } };
  function apply(st, tnlKey = null) {
    // The program first: a GLSL program's (its uniforms, and the depth range's flip, which its vertex
    // stage applies too) or the fixed function's, which keeps its own uniforms from before.
    // The fixed path's key never changes ('fixed', as `applied` starts and as readDepth leaves it), so a
    // program that uses no GLSL sends WebGL exactly what it sent before GLSL existed (gate-webgl-stream).
    const key = st.glsl ? `${st.program},${st.range},${st.cull},${st.xf ? st.xf.id : ''}` : tnlKey ?? (st.multi ? 'fixed-multi' : 'fixed');
    put('program', key, () => {
      const flip = st.range.split(',').map(Number).reduce((dn, df) => (dn > df ? 1 : 0));
      if (!programs.use(st.glsl, flip, st.xf)) {
        const rec = recFor(key);
        if (rec.U !== U) { U = rec.U; for (const k of FIXED_UNIFORMS) delete applied[k]; }
        curRec = rec;
        g.useProgram(rec.p); g.uniform1i(U.zFlip, zFlip);
      }
      // Culling is WebGL's only under a vertex shader (gl.js culls the rest itself), so only then is it on.
      if (st.cull) { const [cf, ff] = st.cull.split(',').map(Number); g.enable(g.CULL_FACE); g.cullFace(cf); g.frontFace(ff); culling = true; }
      else if (culling) { g.disable(g.CULL_FACE); culling = false; }
    });
    if (st.tex >= 0) {
      put('tex', st.tex, () => g.bindTexture(g.TEXTURE_2D, gpuTex.get(st.tex)));
      const p = `${st.min},${st.mag},${st.wrapS},${st.wrapT}`;
      if (texParams.get(st.tex) !== p) {
        texParams.set(st.tex, p);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, FILT[st.min]); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, FILT[st.mag]);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, WRAP[st.wrapS]); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, WRAP[st.wrapT]);
      }
    }
    if (st.tex3 >= 0) {
      put('tex3', st.tex3, () => g.bindTexture(g.TEXTURE_3D, gpuTex3.get(st.tex3)));
      if (texParams3.get(st.tex3) !== st.params3) {
        texParams3.set(st.tex3, st.params3);
        const [mn, mg, ws, wt, wr] = st.params3.split(',').map(Number);
        g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MIN_FILTER, FILT[mn]); g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MAG_FILTER, FILT[mg]);
        g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_S, WRAP[ws]); g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_T, WRAP[wt]);
        g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_R, WRAP[wr]);
      }
    }
    if (st.multi) applyUnits(st.multi);
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
      if (flip !== zFlip) { zFlip = flip; if (!st.glsl) g.uniform1i(U.zFlip, flip); }
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
  /*
   * The units of a multitexture batch (gpuState's multiKey): units 1 and 2 bound on WebGL units 2 and 3
   * with their filters, then every unit's uniforms. Unit 0's texture is bound above, as always.
   */
  const texParamsOn = (target, id, min, mag, ws, wt) => {
    const p = `${min},${mag},${ws},${wt}`;
    if (texParams.get(id) === p) return;
    texParams.set(id, p);
    g.texParameteri(target, g.TEXTURE_MIN_FILTER, FILT[min]); g.texParameteri(target, g.TEXTURE_MAG_FILTER, FILT[mag]);
    g.texParameteri(target, g.TEXTURE_WRAP_S, WRAP[ws]); g.texParameteri(target, g.TEXTURE_WRAP_T, WRAP[wt]);
  };
  function applyUnits(key) {
    const units = key.split('|').map((x) => x.split(',').map(Number));
    for (const u of units) {
      const [k, id] = u, [min, mag, ws, wt] = u.slice(-4);
      if (!k) continue;
      put(`tex${k}`, id, () => { g.activeTexture(g.TEXTURE0 + k + 1); g.bindTexture(g.TEXTURE_2D, gpuTex.get(id)); g.activeTexture(g.TEXTURE0); });
      if (texParams.get(id) !== `${min},${mag},${ws},${wt}`) { g.activeTexture(g.TEXTURE0 + k + 1); texParamsOn(g.TEXTURE_2D, id, min, mag, ws, wt); g.activeTexture(g.TEXTURE0); }
    }
    put('multi', key, () => {
      const on = [0, 0, 0], base = [0, 0, 0], env = [0, 0, 0], cA = new Int32Array(12), cB = new Int32Array(12), cC = new Int32Array(12);
      const kc = new Float32Array(12), sc = new Float32Array(6);
      for (const u of units) {
        const [k, , b, e, fr, fa, s0, s1, s2, a0, a1, a2, o0, o1, o2, p0, p1, p2, scR, scA, r, gg, bb, aa] = u;
        on[k] = 1; base[k] = b; env[k] = e;
        cA.set([fr, fa, s0, s1], 4 * k); cB.set([s2, a0, a1, a2], 4 * k); cC.set([o0, o1, o2, p0 + 4 * p1 + 16 * p2], 4 * k);
        kc.set([r, gg, bb, aa], 4 * k); sc.set([scR, scA], 2 * k);
      }
      const r = curRec;
      g.uniform1iv(r.on, on); g.uniform1iv(r.base, base); g.uniform1iv(r.env, env);
      g.uniform4iv(r.cA, cA); g.uniform4iv(r.cB, cB); g.uniform4iv(r.cC, cC);
      g.uniform4fv(r.kc, kc); g.uniform2fv(r.sc, sc);
    });
  }
  /*
   * The program, its vertex-shader uniforms and the culling, for a draw with the fixed-function
   * vertex shader. The uniforms are sent when the state object is not the one last sent (the front end
   * keeps one per state), and then only those that differ.
   */
  function tnlBind(st, progKey, vu, cull) {
    apply(st, progKey);
    const rec = curRec, last = rec.last;
    if (rec.lastVu !== vu) {
      rec.lastVu = vu;
      for (const nm of TNL_UNIFORMS) {
        const v = vu[nm], was = last[nm];
        if (was && was.length === v.length && was.every((x, i) => x === v[i])) continue;
        last[nm] = v;
        const l = rec.vs[nm];
        if (nm === 'mv' || nm === 'proj' || nm === 'tm') g.uniformMatrix4fv(l, false, v);
        else if (nm === 'nmat') g.uniformMatrix3fv(l, false, v);
        else if (nm === 'fl') { g.uniform1iv(l, v); g.uniform1i(rec.U.twoSided, v[2]); g.uniform1i(rec.U.clipMask, v[6]); }
        else if (nm === 'sh') g.uniform2fv(l, v);
        else g.uniform4fv(l, v);
      }
    }
    if (cull) { g.enable(g.CULL_FACE); g.cullFace(cull[0]); g.frontFace(cull[1]); culling = true; }
    else if (culling) { g.disable(g.CULL_FACE); culling = false; }
  }
  // The batch of immediate-mode primitives (primitive()), drawn from its own buffers and vertex array object.
  const IMM = 23, IMMV = 65536, IMMI = 3 * 65536;
  let imm = null, immVao = null, immBuffer = null, immIndexBuffer = null, immData_ = null, immIdx_ = null;
  const immArrays = () => { immData_ ??= new Float32Array(IMMV * IMM); immIdx_ ??= new Uint32Array(IMMI); };
  function drawImmediate(p) {
    tnlBind(p.st, p.progKey, p.vu, p.cull);
    if (!immVao) {
      immVao = g.createVertexArray(); immBuffer = g.createBuffer(); immIndexBuffer = g.createBuffer();
      g.bindVertexArray(immVao);
      g.bindBuffer(g.ARRAY_BUFFER, immBuffer);
      const S = IMM * 4;
      for (const [loc, size, off] of [[0, 4, 0], [1, 4, 16], [2, 4, 32], [4, 3, 48], [5, 4, 60], [6, 4, 76]]) {
        g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, size, g.FLOAT, false, S, off);
      }
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, immIndexBuffer);
    } else g.bindVertexArray(immVao);
    g.bindBuffer(g.ARRAY_BUFFER, immBuffer);
    g.bufferData(g.ARRAY_BUFFER, immData_.subarray(0, p.n * IMM), g.STREAM_DRAW);
    g.bufferData(g.ELEMENT_ARRAY_BUFFER, immIdx_.subarray(0, p.ni), g.STREAM_DRAW);
    g.drawElements(g.TRIANGLES, p.ni, g.UNSIGNED_INT, 0);
    g.bindVertexArray(null);
    g.bindBuffer(g.ARRAY_BUFFER, vertexBuffer);
  }
  const flush = () => {
    if (imm) { const p = imm; imm = null; if (p.ni) drawImmediate(p); }
    if (!n) return;
    apply(pending);
    if (pending.multi) {
      g.bufferData(g.ARRAY_BUFFER, dataMOf().subarray(0, n * 15), g.STREAM_DRAW);
      g.vertexAttribPointer(0, 4, g.FLOAT, false, 60, 0); g.vertexAttribPointer(1, 4, g.FLOAT, false, 60, 16);
      g.vertexAttribPointer(2, 2, g.FLOAT, false, 60, 32); g.vertexAttribPointer(3, 1, g.FLOAT, false, 60, 40);
      g.enableVertexAttribArray(5); g.vertexAttribPointer(5, 2, g.FLOAT, false, 60, 44);
      g.enableVertexAttribArray(6); g.vertexAttribPointer(6, 2, g.FLOAT, false, 60, 52);
      g.drawArrays(mode, 0, n);
      g.disableVertexAttribArray(5); g.disableVertexAttribArray(6);
      g.vertexAttribPointer(0, 4, g.FLOAT, false, STRIDE, 0); g.vertexAttribPointer(1, 4, g.FLOAT, false, STRIDE, 16);
      g.vertexAttribPointer(2, 2, g.FLOAT, false, STRIDE, 32); g.vertexAttribPointer(3, 1, g.FLOAT, false, STRIDE, 40);
      n = 0;
      return;
    }
    g.bufferData(g.ARRAY_BUFFER, data.subarray(0, n * 11), g.STREAM_DRAW);
    const vs = pending.glsl?.vertex;
    if (vs) {
      g.bindBuffer(g.ARRAY_BUFFER, normalBuffer ??= g.createBuffer());
      g.bufferData(g.ARRAY_BUFFER, normals.subarray(0, n * 3), g.STREAM_DRAW);
      g.enableVertexAttribArray(4); g.vertexAttribPointer(4, 3, g.FLOAT, false, 0, 0);
      g.bindBuffer(g.ARRAY_BUFFER, vertexBuffer);
    }
    g.drawArrays(mode, 0, n);
    if (vs) g.disableVertexAttribArray(4);
    n = 0;
  };
  const push = (v, colour) => {
    if (v.vs) {                                // under a vertex shader: the attributes as given
      const o = n * 11; data.set(v.vs.o, o); data.set(v.vs.c, o + 4); data[o + 8] = v.vs.t[0]; data[o + 9] = v.vs.t[1]; data[o + 10] = 0;
      (normals ??= new Float32Array(MAXV * 3)).set(v.vs.n, n * 3); n++; return;
    }
    if (pending.multi) {
      const dataM = dataMOf(), o = n * 15, t1 = v.tex1, t2 = v.tex2;
      dataM.set(v.clip, o); dataM.set(colour ?? v.colour, o + 4); dataM[o + 8] = v.tex[0]; dataM[o + 9] = v.tex[1]; dataM[o + 10] = v.eyeZ;
      dataM[o + 11] = t1 ? t1[0] : 0; dataM[o + 12] = t1 ? t1[1] : 0; dataM[o + 13] = t2 ? t2[0] : 0; dataM[o + 14] = t2 ? t2[1] : 0;
      n++; return;
    }
    const o = n * 11; data.set(v.clip, o); data.set(colour ?? v.colour, o + 4); data[o + 8] = v.tex[0]; data[o + 9] = v.tex[1]; data[o + 10] = v.eyeZ; n++; };
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
    upload3D(id, t) {
      flush();
      let tx = gpuTex3.get(id);
      if (!tx) { tx = g.createTexture(); gpuTex3.set(id, tx); }
      g.bindTexture(g.TEXTURE_3D, tx);
      delete applied.tex3;
      g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
      t.levels.forEach((L, lv) => { if (L) g.texImage3D(g.TEXTURE_3D, lv, g.RGBA, L.w, L.h, L.d, 0, g.RGBA, g.UNSIGNED_BYTE, L.data); });
      g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MAX_LEVEL, t.levels.length - 1);
      key = null;
    },
    tri(a, b, c, flat, st) { begin(st, g.TRIANGLES, 3); push(a, flat); push(b, flat); push(c, flat); },
    /*
     * A primitive of the program's own arrays, transformed and lit by the fixed-function vertex shader
     * (installGL's gpuArrays): `uploads` the bytes the arrays span, `attribs` where each array is in
     * them, `consts` the current values of the arrays that are off, `indices` the triangles. Its own
     * vertex array object, so the batches' attribute setup is untouched.
     */
    drawArrays(st, progKey, vu, uploads, attribs, consts, indices, cull) {
      flush();
      tnlBind(st, progKey, vu, cull);
      tnlVao ??= g.createVertexArray();
      g.bindVertexArray(tnlVao);
      uploads.forEach((bytes, i) => { g.bindBuffer(g.ARRAY_BUFFER, tnlBuffers[i] ??= g.createBuffer()); g.bufferData(g.ARRAY_BUFFER, bytes, g.STREAM_DRAW); });
      const on = new Set();
      for (const a of attribs) {
        g.bindBuffer(g.ARRAY_BUFFER, tnlBuffers[a.range]);
        g.enableVertexAttribArray(a.loc); g.vertexAttribPointer(a.loc, a.size, a.type, a.norm, a.stride, a.offset);
        on.add(a.loc);
      }
      for (const l of [1, 2, 4, 5, 6]) if (!on.has(l)) { const c = consts[l]; g.disableVertexAttribArray(l); g.vertexAttrib4f(l, c[0], c[1], c[2] ?? 0, c[3] ?? 1); }
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, tnlIndexBuffer ??= g.createBuffer());
      g.bufferData(g.ELEMENT_ARRAY_BUFFER, indices, g.STREAM_DRAW);
      g.drawElements(g.TRIANGLES, indices.length, indices instanceof Uint16Array ? g.UNSIGNED_SHORT : g.UNSIGNED_INT, 0);
      g.bindVertexArray(null);
      g.bindBuffer(g.ARRAY_BUFFER, vertexBuffer);
      key = null;
    },
    /*
     * One immediate-mode primitive, its vertices as recorded (installGL's recordVertex, IMM floats
     * each) and its triangles: appended to the batch while the state is the same object, drawn by
     * flush() like the batches of transformed triangles.
     */
    primitive(st, progKey, vu, cull, verts, nv, tri) {
      immArrays();
      const p = imm;
      const sameCull = (a, b) => (a === null ? b === null : b !== null && a[0] === b[0] && a[1] === b[1]);
      if (!p || p.st !== st || p.progKey !== progKey || p.vu !== vu || !sameCull(p.cull, cull) || p.n + nv > IMMV || p.ni + tri.length > IMMI) {
        flush();
        imm = { st, progKey, vu, cull, n: 0, ni: 0 };
        key = null;                                   // the next batch of transformed triangles flushes this one
      }
      const q = imm;
      immData_.set(verts, q.n * IMM);
      for (let i = 0; i < tri.length; i++) immIdx_[q.ni + i] = q.n + tri[i];
      q.n += nv; q.ni += tri.length;
    },
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
      if (culling) { g.disable(g.CULL_FACE); culling = false; }   // a vertex shader's; the next batch sets it again
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
      g.bindFramebuffer(g.FRAMEBUFFER, cur);
      g.viewport(...view);
      key = null; applied = { program: 'fixed' }; U = U0; curRec = fixedRec; U = U0;
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
      g.bindFramebuffer(g.READ_FRAMEBUFFER, target);
      g.bindFramebuffer(g.DRAW_FRAMEBUFFER, null);
      g.blitFramebuffer(0, 0, w, h, 0, 0, w, h, g.COLOR_BUFFER_BIT, g.NEAREST);
      g.bindFramebuffer(g.FRAMEBUFFER, cur);
      key = null;
      return canvas.transferToImageBitmap();
    },
    /** A framebuffer's colour (0 the window's), bottom row first, as GL's own is. */
    read(id = 0, rw = w, rh = h) {
      flush();
      const px = new Uint8Array(rw * rh * 4);
      g.bindFramebuffer(g.READ_FRAMEBUFFER, id ? fbos.get(id).fb : target);
      g.readPixels(0, 0, rw, rh, g.RGBA, g.UNSIGNED_BYTE, px);
      g.bindFramebuffer(g.READ_FRAMEBUFFER, cur);
      return px;
    },
    /*
     * Draw into a framebuffer object (installGL's fboSpec) or, with null, into the window's: its
     * colour a texture's level (the WebGL texture of the same id) or a renderbuffer, its depth and
     * stencil renderbuffers, each made here at the size and format the program gave.
     */
    framebuffer(spec) {
      flush();
      if (!spec) cur = target;
      else {
        let fo = fbos.get(spec.id);
        if (!fo) { fo = { fb: g.createFramebuffer() }; fbos.set(spec.id, fo); }
        g.bindFramebuffer(g.FRAMEBUFFER, fo.fb);
        if (spec.color?.tex) g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, gpuTex.get(spec.color.tex), spec.color.level);
        else g.framebufferRenderbuffer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.RENDERBUFFER, spec.color ? renderbuffer(spec.color.rb, g.RGBA8) : null);
        const ds = spec.depth && spec.stencil && spec.depth.id === spec.stencil.id;
        if (ds) g.framebufferRenderbuffer(g.FRAMEBUFFER, g.DEPTH_STENCIL_ATTACHMENT, g.RENDERBUFFER, renderbuffer(spec.depth, g.DEPTH24_STENCIL8));
        else {
          g.framebufferRenderbuffer(g.FRAMEBUFFER, g.DEPTH_STENCIL_ATTACHMENT, g.RENDERBUFFER, null);
          g.framebufferRenderbuffer(g.FRAMEBUFFER, g.DEPTH_ATTACHMENT, g.RENDERBUFFER, spec.depth ? renderbuffer(spec.depth, g.DEPTH_COMPONENT24) : null);
          g.framebufferRenderbuffer(g.FRAMEBUFFER, g.STENCIL_ATTACHMENT, g.RENDERBUFFER, spec.stencil ? renderbuffer(spec.stencil, g.STENCIL_INDEX8) : null);
        }
        cur = fo.fb;
        // A texture left bound to a unit the program samples is a FEEDBACK LOOP to WebGL when it is also
        // the attachment, and every draw fails -- even one that does not texture (the sampler is there).
        // So the units are emptied; the next textured batch binds what it samples.
        for (const u of [0, 2, 3]) { g.activeTexture(g.TEXTURE0 + u); g.bindTexture(g.TEXTURE_2D, null); }
        g.activeTexture(g.TEXTURE0);
        delete applied.tex; delete applied.tex1; delete applied.tex2;
      }
      g.bindFramebuffer(g.FRAMEBUFFER, cur);
      key = null;
    },
    blit(readId, drawId, c, mask, filter) {
      flush();
      g.bindFramebuffer(g.READ_FRAMEBUFFER, readId ? fbos.get(readId).fb : target);
      g.bindFramebuffer(g.DRAW_FRAMEBUFFER, drawId ? fbos.get(drawId).fb : target);
      g.blitFramebuffer(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], mask, filter);
      g.bindFramebuffer(g.FRAMEBUFFER, cur);
      key = null;
    },
    generateMipmap(id) {
      flush();
      g.bindTexture(g.TEXTURE_2D, gpuTex.get(id));
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAX_LEVEL, 1000);
      g.generateMipmap(g.TEXTURE_2D);
      delete applied.tex;
      key = null;
    },
    texSubImage(id, level, x, y, sw, sh, rgba) {
      flush();
      g.bindTexture(g.TEXTURE_2D, gpuTex.get(id));
      g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
      g.texSubImage2D(g.TEXTURE_2D, level, x, y, sw, sh, g.RGBA, g.UNSIGNED_BYTE, rgba);
      delete applied.tex;
      key = null;
    },
    copyTexSubImage(id, level, xo, yo, x, y, cw, ch, readId) {
      flush();
      g.bindFramebuffer(g.READ_FRAMEBUFFER, readId ? fbos.get(readId).fb : target);
      g.bindTexture(g.TEXTURE_2D, gpuTex.get(id));
      g.copyTexSubImage2D(g.TEXTURE_2D, level, xo, yo, x, y, cw, ch);
      g.bindFramebuffer(g.READ_FRAMEBUFFER, cur);
      delete applied.tex;
      key = null;
    },
    get lost() { return lost || !!g.isContextLost?.(); },
    /** For a test: take the context away, as the GPU would (WEBGL_lose_context). */
    lose() { g.getExtension('WEBGL_lose_context')?.loseContext(); lost = true; },
  };
}

/** The builtin signatures, from headers-gl.js. */
export function glBuiltins(T) {
  const I = T.INT, U = T.UINT, V = T.VOID, F = T.FLOAT, D = T.DOUBLE, P = T.ptr(T.CHAR);
  const f = (ret, ...params) => ({ ret, params });
  const immediate = {};
  for (const { name, family, n, t, v } of immediateForms()) {
    const multi = family === 'glMultiTexCoord' ? [U] : [];
    immediate[name] = f(V, ...multi, ...(v ? [P] : Array(n).fill(T[IMM_TYPES[t][0]])));
  }
  return {
    ...immediate,
    glActiveTexture: f(V, U), glClientActiveTexture: f(V, U),
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
    glRectf: f(V, F, F, F, F), glRecti: f(V, I, I, I, I), glRects: f(V, T.SHORT, T.SHORT, T.SHORT, T.SHORT), glRectd: f(V, D, D, D, D),
    glRectfv: f(V, P, P), glRectiv: f(V, P, P), glRectsv: f(V, P, P), glRectdv: f(V, P, P), glLightf: f(V, U, U, F), glMaterialf: f(V, U, U, F),
    glColorMaterial: f(V, U, U), glPixelStorei: f(V, U, I), glTexGeni: f(V, U, U, I), glTexGenfv: f(V, U, U, P), glNormalPointer: f(V, U, I, P),
    glGetBooleanv: f(V, U, P), glGetTexLevelParameteriv: f(V, U, I, U, P),
    glLightfv: f(V, U, U, P), glMaterialfv: f(V, U, U, P),
    glLightModelfv: f(V, U, P), glLightModelf: f(V, U, F), glLightModeli: f(V, U, I), glIsTexture: f(U, U),
    glFogf: f(V, U, F), glFogi: f(V, U, I), glFogfv: f(V, U, P),
    glBindTexture: f(V, U, U), glTexParameterf: f(V, U, U, F), glTexEnvf: f(V, U, U, F), glTexEnvfv: f(V, U, U, P), glTexParameteri: f(V, U, U, I), glTexEnvi: f(V, U, U, I),
    glTexImage2D: f(V, U, I, I, I, I, I, U, U, P), glTexSubImage2D: f(V, U, I, I, I, I, I, U, U, P),
    glTexImage3D: f(V, U, I, I, I, I, I, I, U, U, P), glTexSubImage3D: f(V, U, I, I, I, I, I, I, I, U, U, P),
    glCopyTexSubImage2D: f(V, U, I, I, I, I, I, I, I), glCopyTexImage2D: f(V, U, I, U, I, I, I, I, I),
    glReadPixels: f(V, I, I, I, I, U, U, P), glPolygonMode: f(V, U, U), glHint: f(V, U, U),
    glDrawBuffer: f(V, U), glReadBuffer: f(V, U),
    ...Object.fromEntries(['', 'EXT'].flatMap((x) => [
      [`glGenFramebuffers${x}`, f(V, I, P)], [`glDeleteFramebuffers${x}`, f(V, I, P)], [`glIsFramebuffer${x}`, f(U, U)], [`glBindFramebuffer${x}`, f(V, U, U)],
      [`glFramebufferTexture2D${x}`, f(V, U, U, U, U, I)], [`glFramebufferRenderbuffer${x}`, f(V, U, U, U, U)], [`glCheckFramebufferStatus${x}`, f(U, U)],
      [`glGenRenderbuffers${x}`, f(V, I, P)], [`glDeleteRenderbuffers${x}`, f(V, I, P)], [`glIsRenderbuffer${x}`, f(U, U)], [`glBindRenderbuffer${x}`, f(V, U, U)],
      [`glRenderbufferStorage${x}`, f(V, U, U, I, I)], [`glGenerateMipmap${x}`, f(V, U)], [`glBlitFramebuffer${x}`, f(V, I, I, I, I, I, I, I, I, U, U)],
    ])),
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
