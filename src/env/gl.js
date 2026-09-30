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

const MODELVIEW = 0x1700, PROJECTION = 0x1701;
const CAP = {
  CULL_FACE: 0x0b44, LIGHTING: 0x0b50, DEPTH_TEST: 0x0b71, NORMALIZE: 0x0ba1, LIGHT0: 0x4000,
  TEXTURE_2D: 0x0de1, BLEND: 0x0be2, ALPHA_TEST: 0x0bc0, FOG: 0x0b60,
};
const FLAT = 0x1d00, CCW = 0x0901, BACK = 0x0405, FRONT = 0x0404, FRONT_AND_BACK = 0x0408;
const PNAME = { AMBIENT: 0x1200, DIFFUSE: 0x1201, SPECULAR: 0x1202, POSITION: 0x1203, EMISSION: 0x1600, SHININESS: 0x1601, AMBIENT_AND_DIFFUSE: 0x1602 };
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

export function installGL(M, { onFrame = null, backend = 'soft' } = {}) {
  let webgl = null;                         // the WebGL2 rasteriser when backend is 'webgl' (makeWebGL)
  const dv = () => M.mod.dv;
  const f32 = (p, n) => Array.from({ length: n }, (_, k) => dv().getFloat32(p + 4 * k, true));
  const light = () => ({ ambient: [0, 0, 0, 1], diffuse: [0, 0, 0, 1], specular: [0, 0, 0, 1], position: [0, 0, 1, 0] });
  const newTexture = () => ({ levels: [], base: 'RGBA', min: TEX.NL, mag: TEX.LINEAR, wrapS: TEX.REPEAT, wrapT: TEX.REPEAT, gpu: null, dirty: true });
  const s = {
    width: 0, height: 0, color: null, depth: null,
    viewport: [0, 0, 0, 0], clear: [0, 0, 0, 0], clearDepth: 1,
    mode: MODELVIEW, stacks: { [MODELVIEW]: [ident()], [PROJECTION]: [ident()] },
    caps: new Set(), shade: 0x1d01, frontFace: CCW, cullFace: BACK,
    normal: [0, 0, 1], colour: [1, 1, 1, 1], tex: [0, 0],
    material: { ambient: [0.2, 0.2, 0.2, 1], diffuse: [0.8, 0.8, 0.8, 1], specular: [0, 0, 0, 1], emission: [0, 0, 0, 1], shininess: 0 },
    sceneAmbient: [0.2, 0.2, 0.2, 1],
    lights: Array.from({ length: 8 }, (_, k) => {
      const l = light();
      if (k === 0) { l.diffuse = [1, 1, 1, 1]; l.specular = [1, 1, 1, 1]; }
      return l;
    }),
    depthFunc: 0x201, depthMask: true, depthRange: [0, 1],
    alphaFunc: 0x207, alphaRef: 0, blend: [1, 0],
    envMode: TEX.MODULATE,
    fog: { mode: FOG.EXP, density: 1, start: 0, end: 1, colour: [0, 0, 0, 0] },
    textures: new Map([[0, newTexture()]]), bound: 0,
    prim: null, verts: [],
    lists: new Map(), nextList: 1, recording: null, recordMode: 0,
    stats: { triangles: 0, culled: 0, clipped: 0, fragments: 0 },
    strings: new Map(),
  };
  const top = () => { const st = s.stacks[s.mode]; return st[st.length - 1]; };
  const setTop = (m) => { const st = s.stacks[s.mode]; st[st.length - 1] = m; };
  const texture = () => s.textures.get(s.bound);

  /** Size the framebuffer; the window system (glut.js, glx.js) calls this. */
  function resize(w, h) {
    s.width = w; s.height = h;
    s.color = new Uint8Array(w * h * 4); s.depth = new Float32Array(w * h).fill(1);
    s.viewport = [0, 0, w, h];
    if (backend === 'webgl') { webgl = makeWebGL(w, h); webgl.viewport(0, 0, w, h); for (const t of s.textures.values()) t.dirty = true; }
  }

  // --- per-vertex work
  function litColour(eyeNormal) {
    const m = s.material, out = [0, 0, 0, m.diffuse[3]];
    for (let k = 0; k < 3; k++) out[k] = m.emission[k] + s.sceneAmbient[k] * m.ambient[k];
    for (let li = 0; li < 8; li++) {
      const L = s.lights[li];
      if (!s.caps.has(CAP.LIGHT0 + li)) continue;
      const dir = norm3(L.position);
      const ndl = Math.max(0, eyeNormal[0] * dir[0] + eyeNormal[1] * dir[1] + eyeNormal[2] * dir[2]);
      let spec = 0;
      if (ndl > 0 && (m.specular[0] || m.specular[1] || m.specular[2])) {
        const hv = norm3([dir[0], dir[1], dir[2] + 1]);
        const ndh = Math.max(0, eyeNormal[0] * hv[0] + eyeNormal[1] * hv[1] + eyeNormal[2] * hv[2]);
        spec = m.shininess ? ndh ** m.shininess : (ndh > 0 ? 1 : 0);
      }
      for (let k = 0; k < 3; k++) out[k] += L.ambient[k] * m.ambient[k] + ndl * L.diffuse[k] * m.diffuse[k] + spec * L.specular[k] * m.specular[k];
    }
    return out.map(clamp01);
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
    } else colour = s.colour.map(clamp01);
    s.verts.push({ clip, colour, tex: [s.tex[0], s.tex[1]], eyeZ: Math.abs(eye[2] / (eye[3] || 1)) });
  }

  // --- clipping against the near plane (z + w >= 0), every attribute linear in clip space
  const lerpV = (a, b, t) => ({
    clip: a.clip.map((v, k) => v + (b.clip[k] - v) * t),
    colour: a.colour.map((v, k) => v + (b.colour[k] - v) * t),
    tex: [a.tex[0] + (b.tex[0] - a.tex[0]) * t, a.tex[1] + (b.tex[1] - a.tex[1]) * t],
    eyeZ: a.eyeZ + (b.eyeZ - a.eyeZ) * t,
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

  // --- rasterisation
  function toWindow(v) {
    const [x, y, z, w] = v.clip, [vx, vy, vw, vh] = s.viewport, [n, f] = s.depthRange;
    return { x: (x / w + 1) * vw / 2 + vx, y: (y / w + 1) * vh / 2 + vy, z: n + (f - n) * (z / w + 1) / 2, iw: 1 / w, v };
  }
  /** One texel of level `lv` at integer (i, j), after wrapping; RGBA 0..1. */
  function texel(t, lv, i, j) {
    const L = t.levels[lv];
    i = t.wrapS === TEX.REPEAT ? ((i % L.w) + L.w) % L.w : Math.min(L.w - 1, Math.max(0, i));
    j = t.wrapT === TEX.REPEAT ? ((j % L.h) + L.h) % L.h : Math.min(L.h - 1, Math.max(0, j));
    const o = (j * L.w + i) * 4;
    return [L.data[o] / 255, L.data[o + 1] / 255, L.data[o + 2] / 255, L.data[o + 3] / 255];
  }
  function filter(t, lv, u, v, linear) {
    const L = t.levels[lv], x = u * L.w, y = v * L.h;
    if (!linear) return texel(t, lv, Math.floor(x), Math.floor(y));
    const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5), a = x - 0.5 - x0, b = y - 0.5 - y0;
    const c00 = texel(t, lv, x0, y0), c10 = texel(t, lv, x0 + 1, y0), c01 = texel(t, lv, x0, y0 + 1), c11 = texel(t, lv, x0 + 1, y0 + 1);
    return [0, 1, 2, 3].map((k) => (1 - a) * (1 - b) * c00[k] + a * (1 - b) * c10[k] + (1 - a) * b * c01[k] + a * b * c11[k]);
  }
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
  /** The texture colour at (u, v) with scale factor rho (texels of level 0 per pixel), by the spec's rules. */
  function sample(t, u, v, rho) {
    const lambda = Math.log2(rho);
    const c = t.mag === TEX.LINEAR && (t.min === TEX.NN || t.min === TEX.NL) ? 0.5 : 0;
    if (lambda <= c) return filter(t, 0, u, v, t.mag === TEX.LINEAR);
    if (!mipmapped(t.min)) return filter(t, 0, u, v, t.min === TEX.LINEAR);
    const q = t.levels.length - 1, linear = t.min === TEX.LN || t.min === TEX.LL;
    if (t.min === TEX.NN || t.min === TEX.LN) {
      const d = lambda <= 0.5 ? 0 : Math.min(q, Math.ceil(lambda + 0.5) - 1);
      return filter(t, d, u, v, linear);
    }
    if (lambda >= q) return filter(t, q, u, v, linear);
    const d1 = Math.floor(lambda), fr = lambda - d1;
    const a = filter(t, d1, u, v, linear), b = filter(t, d1 + 1, u, v, linear);
    return [0, 1, 2, 3].map((k) => (1 - fr) * a[k] + fr * b[k]);
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
  function fragment(i, z, col, eyeZ) {
    if (s.caps.has(CAP.FOG)) {
      const F = s.fog;
      let f = F.mode === FOG.LINEAR ? (F.end - eyeZ) / (F.end - F.start)
        : F.mode === FOG.EXP ? Math.exp(-F.density * eyeZ) : Math.exp(-((F.density * eyeZ) ** 2));
      f = clamp01(f);
      col = [0, 1, 2].map((k) => f * col[k] + (1 - f) * F.colour[k]).concat(col[3]);
    }
    if (s.caps.has(CAP.ALPHA_TEST) && !compare(s.alphaFunc, col[3], s.alphaRef)) return;
    if (s.caps.has(CAP.DEPTH_TEST)) {
      if (!compare(s.depthFunc, z, s.depth[i])) return;
      if (s.depthMask) s.depth[i] = z;
    }
    const o = i * 4;
    let out = col.map(clamp01);
    if (s.caps.has(CAP.BLEND)) {
      const dst = [s.color[o] / 255, s.color[o + 1] / 255, s.color[o + 2] / 255, s.color[o + 3] / 255];
      const sf = BLEND(s.blend[0], out, dst, out[3], dst[3]), df = BLEND(s.blend[1], out, dst, out[3], dst[3]);
      out = [0, 1, 2, 3].map((k) => clamp01(out[k] * sf[k] + dst[k] * df[k]));
    }
    for (let k = 0; k < 4; k++) s.color[o + k] = Math.round(out[k] * 255);
    s.stats.fragments++;
  }
  function rasterTriangle(A, B, C, flatColour) {
    const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    if (area === 0) return;
    const [P, Q, R] = area > 0 ? [A, B, C] : [A, C, B];
    const ar = Math.abs(area);
    const W = s.width, H = s.height;
    const x0 = Math.max(0, Math.floor(Math.min(P.x, Q.x, R.x))), x1 = Math.min(W - 1, Math.ceil(Math.max(P.x, Q.x, R.x)));
    const y0 = Math.max(0, Math.floor(Math.min(P.y, Q.y, R.y))), y1 = Math.min(H - 1, Math.ceil(Math.max(P.y, Q.y, R.y)));
    // Top-left rule, in GL's bottom-up window space: an edge owns its pixels if it goes down
    // (a left edge of a CCW triangle) or is horizontal going left (a top edge).
    const owns = (u, v) => { const dy = v.y - u.y, dx = v.x - u.x; return dy < 0 || (dy === 0 && dx < 0); };
    const eQR = owns(Q, R), eRP = owns(R, P), ePQ = owns(P, Q);
    const edge = (u, v, px, py) => (v.x - u.x) * (py - u.y) - (v.y - u.y) * (px - u.x);
    const t = s.caps.has(CAP.TEXTURE_2D) ? texture() : null;
    const textured = t && complete(t);
    // Perspective-correct attributes at a window point: weights, then attribute/w over 1/w.
    const at = (cx, cy) => {
      const l0 = edge(Q, R, cx, cy) / ar, l1 = edge(R, P, cx, cy) / ar, l2 = edge(P, Q, cx, cy) / ar;
      const iw = l0 * P.iw + l1 * Q.iw + l2 * R.iw;
      const pc = (get) => (l0 * get(P.v) * P.iw + l1 * get(Q.v) * Q.iw + l2 * get(R.v) * R.iw) / iw;
      return { l0, l1, l2, pc };
    };
    for (let py = y0; py <= y1; py++) {
      const cy = py + 0.5;
      for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5;
        const w0 = edge(Q, R, cx, cy), w1 = edge(R, P, cx, cy), w2 = edge(P, Q, cx, cy);
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        if ((w0 === 0 && !eQR) || (w1 === 0 && !eRP) || (w2 === 0 && !ePQ)) continue;
        const { l0, l1, l2, pc } = at(cx, cy);
        // Rounded to the depth buffer's own precision BEFORE the test: comparing a double with the
        // float32 an earlier pass stored made LEQUAL fail wherever the rounding went down, and a second
        // pass over the same polygon (Quake's lightmaps) vanished on alternate rows.
        const z = Math.fround(l0 * P.z + l1 * Q.z + l2 * R.z);
        let col = flatColour ?? [0, 1, 2, 3].map((k) => pc((v) => v.colour[k]));
        if (textured) {
          const u = pc((v) => v.tex[0]), v = pc((v) => v.tex[1]);
          // Derivatives per 2x2 quad of pixels, from its top-left pixel, the way a GPU (and llvmpipe)
          // takes them: all four pixels of a quad share one level of detail.
          const qx = (px & ~1) + 0.5, qy = (py & ~1) + 0.5, r0 = at(qx, qy), r1 = at(qx + 1, qy), r2 = at(qx, qy + 1), L0 = t.levels[0];
          const u0 = r0.pc((q) => q.tex[0]), v0 = r0.pc((q) => q.tex[1]);
          const dudx = (r1.pc((q) => q.tex[0]) - u0) * L0.w, dvdx = (r1.pc((q) => q.tex[1]) - v0) * L0.h;
          const dudy = (r2.pc((q) => q.tex[0]) - u0) * L0.w, dvdy = (r2.pc((q) => q.tex[1]) - v0) * L0.h;
          const rho = Math.max(Math.hypot(dudx, dvdx), Math.hypot(dudy, dvdy));
          col = envApply(col, sample(t, u, v, rho), t.base);
        }
        fragment(py * W + px, z, col, s.caps.has(CAP.FOG) ? pc((v) => v.eyeZ) : 0);
      }
    }
  }
  function triangle(a, b, c, flatColour) {
    s.stats.triangles++;
    const poly = clipNear([a, b, c]);
    if (poly.length < 3) return;
    for (let k = 1; k + 1 < poly.length; k++) {
      const A = toWindow(poly[0]), B = toWindow(poly[k]), C = toWindow(poly[k + 1]);
      const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
      if (area === 0) continue;
      const front = (area > 0) === (s.frontFace === CCW);
      if (s.caps.has(CAP.CULL_FACE) && (s.cullFace === FRONT_AND_BACK || (s.cullFace === BACK) === !front)) { s.stats.culled++; continue; }
      if (webgl) webgl.tri(poly[0], poly[k], poly[k + 1], flatColour, gpuState());
      else rasterTriangle(A, B, C, flatColour);
    }
  }
  function line(a, b) {
    const seg = clipNear([a, b]);
    if (seg.length < 2) return;
    if (webgl) { webgl.line(seg[0], seg[1], gpuState()); return; }
    const A = toWindow(seg[0]), B = toWindow(seg[1]);
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(B.x - A.x), Math.abs(B.y - A.y))));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, x = Math.floor(A.x + (B.x - A.x) * t), y = Math.floor(A.y + (B.y - A.y) * t);
      if (x < 0 || y < 0 || x >= s.width || y >= s.height) continue;
      fragment(y * s.width + x, A.z + (B.z - A.z) * t, a.colour.map((v, i) => v + (b.colour[i] - v) * t), 0);
    }
  }
  function assemble(mode, v) {
    const flat = s.shade === FLAT;
    const tri = (a, b, c, provoking) => triangle(v[a], v[b], v[c], flat ? v[provoking].colour : null);
    switch (mode) {
      case 0x0001: for (let i = 0; i + 1 < v.length; i += 2) line(v[i], v[i + 1]); break;
      case 0x0003: for (let i = 0; i + 1 < v.length; i++) line(v[i], v[i + 1]); break;
      case 0x0002: for (let i = 0; i < v.length; i++) line(v[i], v[(i + 1) % v.length]); break;
      case 0x0004: for (let i = 0; i + 2 < v.length; i += 3) tri(i, i + 1, i + 2, i + 2); break;
      case 0x0005: for (let i = 0; i + 2 < v.length; i++) (i & 1) ? tri(i + 1, i, i + 2, i + 2) : tri(i, i + 1, i + 2, i + 2); break;
      case 0x0006: for (let i = 1; i + 1 < v.length; i++) tri(0, i, i + 1, i + 1); break;
      // A quad is cut along its 1-3 diagonal, as Mesa's index generation (gallium u_indices) cuts it:
      // the spec leaves the choice to the implementation, and it decides how four colours interpolate.
      case 0x0007: for (let i = 0; i + 3 < v.length; i += 4) { tri(i, i + 1, i + 3, i + 3); tri(i + 1, i + 2, i + 3, i + 3); } break;
      case 0x0008: for (let i = 0; i + 3 < v.length; i += 2) { tri(i, i + 1, i + 3, i + 3); tri(i, i + 3, i + 2, i + 3); } break;
      case 0x0009: for (let i = 1; i + 1 < v.length; i++) tri(0, i, i + 1, 0); break;
      default: throw new Error(`gl: primitive 0x${mode.toString(16)} (points) is not implemented`);
    }
  }
  /** What the GPU path needs of the fragment state, as one comparable value. */
  function gpuState() {
    const t = s.caps.has(CAP.TEXTURE_2D) ? texture() : null, textured = !!(t && complete(t));
    if (textured && t.dirty) { webgl.upload(s.bound, t); t.dirty = false; }
    return {
      tex: textured ? s.bound : -1, base: textured ? t.base : '', env: s.envMode,
      min: textured ? t.min : 0, mag: textured ? t.mag : 0, wrapS: textured ? t.wrapS : 0, wrapT: textured ? t.wrapT : 0,
      blend: s.caps.has(CAP.BLEND) ? `${s.blend[0]},${s.blend[1]}` : '',
      alpha: s.caps.has(CAP.ALPHA_TEST) ? `${s.alphaFunc},${s.alphaRef}` : '',
      depth: s.caps.has(CAP.DEPTH_TEST) ? `${s.depthFunc},${s.depthMask}` : '',
      range: `${s.depthRange[0]},${s.depthRange[1]}`,
      fog: s.caps.has(CAP.FOG) ? `${s.fog.mode},${s.fog.density},${s.fog.start},${s.fog.end},${s.fog.colour.join(',')}` : '',
    };
  }

  // --- textures
  function toRGBA(format, w, h, ptr) {
    const u8 = M.u8, out = new Uint8Array(w * h * 4);
    const n = { [FMT.RGBA]: 4, [FMT.RGB]: 3, [FMT.LUMINANCE]: 1, [FMT.ALPHA]: 1, [FMT.LUMINANCE_ALPHA]: 2, [FMT.INTENSITY]: 1 }[format];
    if (!n) throw new Error(`gl: pixel format 0x${format.toString(16)} (colour index needs an extension PRISM does not advertise)`);
    for (let i = 0; i < w * h; i++) {
      const p = ptr + i * n, o = i * 4;
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
      if (webgl) { webgl.clear(mask, s.clear, s.clearDepth); return; }
      if (mask & 0x4000) { const c = s.clear.map((x) => Math.round(clamp01(x) * 255)); for (let i = 0; i < s.color.length; i += 4) for (let k = 0; k < 4; k++) s.color[i + k] = c[k]; }
      if ((mask & 0x100) && s.depthMask) s.depth.fill(s.clearDepth);
    },
    glClearColor: (r, g, b, a) => { s.clear = [r, g, b, a].map(clamp01); },
    glEnable: (cap) => { s.caps.add(cap); },
    glDisable: (cap) => { s.caps.delete(cap); },
    glShadeModel: (m) => { s.shade = m; },
    glCullFace: (m) => { s.cullFace = m; },
    glFrontFace: (m) => { s.frontFace = m; },
    glViewport: (x, y, w, h) => { s.viewport = [x, y, w, h]; if (webgl) webgl.viewport(x, y, w, h); },
    glDepthFunc: (f) => { s.depthFunc = f; },
    glDepthMask: (m) => { s.depthMask = !!m; },
    glDepthRange: (n, f) => { s.depthRange = [clamp01(n), clamp01(f)]; },
    glAlphaFunc: (f, ref) => { s.alphaFunc = f; s.alphaRef = clamp01(ref); },
    glBlendFunc: (sf, df) => { s.blend = [sf, df]; },
    glMatrixMode: (m) => { s.mode = m; },
    glLoadIdentity: () => setTop(ident()),
    glLoadMatrixf: (m) => setTop(Float64Array.from(m)),
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
    glVertex3fv: (v) => vertex(v[0], v[1], v[2]),
    glVertex2f: (x, y) => vertex(x, y, 0),
    glNormal3f: (x, y, z) => { s.normal = [x, y, z]; },
    glColor3f: (r, g, b) => { s.colour = [r, g, b, 1]; },
    glColor4f: (r, g, b, a) => { s.colour = [r, g, b, a]; },
    glColor4fv: (v) => { s.colour = [v[0], v[1], v[2], v[3]]; },
    glColor3ubv: (v) => { s.colour = [v[0] / 255, v[1] / 255, v[2] / 255, 1]; },
    glTexCoord2f: (u, v) => { s.tex = [u, v]; },
    glTexCoord2fv: (v) => { s.tex = [v[0], v[1]]; },
    glLightfv: (li, pname, v) => {
      const L = s.lights[li - CAP.LIGHT0];
      if (!L) throw new Error(`gl: light 0x${li.toString(16)}`);
      if (pname === PNAME.POSITION) {
        if (v[3] !== 0) throw new Error('gl: positional lights (w != 0) are not implemented');
        const e = xform(s.stacks[MODELVIEW].at(-1), v[0], v[1], v[2], v[3]);
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
    glFogf: (p, v) => { if (p === FOG.MODE) s.fog.mode = v; else if (p === FOG.DENSITY) s.fog.density = v; else if (p === FOG.START) s.fog.start = v; else if (p === FOG.END) s.fog.end = v; },
    glFogi: (p, v) => exec.glFogf(p, v),
    glFogfv: (p, v) => { if (p === FOG.COLOR) s.fog.colour = v.map(clamp01); else exec.glFogf(p, v[0]); },
    glBindTexture: (target, id) => {
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
    glTexEnvf: (target, p, v) => { if (p === TEX.ENV_MODE) s.envMode = v; else throw new Error(`gl: glTexEnv 0x${p.toString(16)}`); },
    glCallList: (n) => { for (const [name, args] of s.lists.get(n) ?? []) exec[name](...args); },
  };
  // Array arguments are read at CALL time, so a display list keeps the values (the spec's copy rule).
  const ARRAYS = {
    glLightfv: (a) => [a[0], a[1], f32(a[2], a[1] === PNAME.SHININESS ? 1 : 4)],
    glMaterialfv: (a) => [a[0], a[1], f32(a[2], a[1] === PNAME.SHININESS ? 1 : 4)],
    glFogfv: (a) => [a[0], f32(a[1], a[0] === FOG.COLOR ? 4 : 1)],
    glVertex3fv: (a) => [f32(a[0], 3)], glTexCoord2fv: (a) => [f32(a[0], 2)], glColor4fv: (a) => [f32(a[0], 4)],
    glColor3ubv: (a) => [[M.u8[a[0]], M.u8[a[0] + 1], M.u8[a[0] + 2]]],
    glLoadMatrixf: (a) => [f32(a[0], 16)],
  };
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
      const text = { 0x1f00: 'PRISM', 0x1f01: 'PRISM software rasteriser', 0x1f02: '1.1 PRISM', 0x1f03: '' }[name];
      if (text === undefined) return 0;
      if (!s.strings.has(name)) s.strings.set(name, M.mod.intern([...new TextEncoder().encode(text), 0]));
      return s.strings.get(name);
    },
    glGetFloatv: (p, out) => {
      const m = p === 0x0ba6 ? s.stacks[MODELVIEW].at(-1) : p === 0x0ba7 ? s.stacks[PROJECTION].at(-1) : null;
      if (!m) throw new Error(`gl: glGetFloatv 0x${p.toString(16)}`);
      for (let k = 0; k < 16; k++) dv().setFloat32(out + 4 * k, m[k], true);
    },
    glTexImage2D: (target, level, internal, w, h, border, format, type, ptr) => {
      if (type !== 0x1401) throw new Error(`gl: texel type 0x${type.toString(16)} (only GL_UNSIGNED_BYTE)`);
      const t = texture();
      t.base = baseFormat(internal);
      t.levels[level] = { w, h, data: ptr ? toRGBA(format, w, h, ptr) : new Uint8Array(w * h * 4) };
      t.dirty = true;
    },
    glTexSubImage2D: (target, level, x, y, w, h, format, type, ptr) => {
      const t = texture(), L = t.levels[level], src = toRGBA(format, w, h, ptr);
      for (let j = 0; j < h; j++) L.data.set(src.subarray(j * w * 4, (j + 1) * w * 4), ((y + j) * L.w + x) * 4);
      t.dirty = true;
    },
    glReadPixels: (x, y, w, h, format, type, out) => {
      const fb = readFramebuffer(), n = format === FMT.RGBA ? 4 : format === FMT.RGB ? 3 : 0;
      if (!n || type !== 0x1401) throw new Error('gl: glReadPixels wants GL_RGB or GL_RGBA, GL_UNSIGNED_BYTE');
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const o = ((y + j) * s.width + x + i) * 4, d = out + (j * w + i) * n;
        for (let k = 0; k < n; k++) M.u8[d + k] = fb[o + k];
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
  g.attachShader(prog, shader(g.VERTEX_SHADER, `#version 300 es
in vec4 pos; in vec4 col; in vec2 tc; in float ez;
out vec4 v; out vec2 uv; out float eyeZ;
void main() { gl_Position = pos; v = col; uv = tc; eyeZ = ez; }`));
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
  g.useProgram(prog);
  const U = Object.fromEntries(['tex', 'textured', 'base', 'env', 'alphaFn', 'fogMode', 'alphaRef', 'fogDensity', 'fogStart', 'fogEnd', 'fogColour']
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
  function apply(st) {
    if (st.tex >= 0) {
      g.bindTexture(g.TEXTURE_2D, gpuTex.get(st.tex));
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, FILT[st.min]); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, FILT[st.mag]);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, WRAP[st.wrapS]); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, WRAP[st.wrapT]);
    }
    g.uniform1i(U.textured, st.tex >= 0 ? 1 : 0); g.uniform1i(U.base, BASES[st.base] ?? 0); g.uniform1i(U.env, ENVS[st.env] ?? 0);
    if (st.blend) { const [sf, df] = st.blend.split(',').map(Number); g.enable(g.BLEND); g.blendFunc(sf, df); } else g.disable(g.BLEND);
    if (st.alpha) { const [f, r] = st.alpha.split(','); g.uniform1i(U.alphaFn, f - 0x200); g.uniform1f(U.alphaRef, +r); } else g.uniform1i(U.alphaFn, -1);
    if (st.depth) { const [f, m] = st.depth.split(','); g.enable(g.DEPTH_TEST); g.depthFunc(+f); g.depthMask(m === 'true'); } else g.disable(g.DEPTH_TEST);
    const [dn, df] = st.range.split(',').map(Number); g.depthRange(dn, df);
    if (st.fog) {
      const [m, d, s0, e0, r, gg, b, a] = st.fog.split(',').map(Number);
      g.uniform1i(U.fogMode, m === 0x2601 ? 1 : m === 0x0800 ? 2 : 3); g.uniform1f(U.fogDensity, d); g.uniform1f(U.fogStart, s0); g.uniform1f(U.fogEnd, e0); g.uniform4f(U.fogColour, r, gg, b, a);
    } else g.uniform1i(U.fogMode, 0);
  }
  const flush = () => {
    if (!n) return;
    apply(pending);
    g.bufferData(g.ARRAY_BUFFER, data.subarray(0, n * 11), g.STREAM_DRAW);
    g.drawArrays(mode, 0, n);
    n = 0;
  };
  const push = (v, colour) => { const o = n * 11; data.set(v.clip, o); data.set(colour ?? v.colour, o + 4); data[o + 8] = v.tex[0]; data[o + 9] = v.tex[1]; data[o + 10] = v.eyeZ; n++; };
  const begin = (st, m, count) => {
    const k = JSON.stringify(st);
    if (k !== key || m !== mode || n + count > MAXV) { flush(); key = k; pending = st; mode = m; }
  };
  return {
    upload(id, t) {
      flush();
      let tx = gpuTex.get(id);
      if (!tx) { tx = g.createTexture(); gpuTex.set(id, tx); }
      g.bindTexture(g.TEXTURE_2D, tx);
      g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
      t.levels.forEach((L, lv) => { if (L) g.texImage2D(g.TEXTURE_2D, lv, g.RGBA, L.w, L.h, 0, g.RGBA, g.UNSIGNED_BYTE, L.data); });
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAX_LEVEL, t.levels.length - 1);
      key = null;
    },
    tri(a, b, c, flat, st) { begin(st, g.TRIANGLES, 3); push(a, flat); push(b, flat); push(c, flat); },
    line(a, b, st) { begin(st, g.LINES, 2); push(a); push(b); },
    viewport(x, y, vw, vh) { flush(); g.viewport(x, y, vw, vh); },
    clear(mask, colour, depth) {
      flush();
      g.clearColor(colour[0], colour[1], colour[2], colour[3]); g.clearDepth(depth); g.depthMask(true);
      g.clear(((mask & 0x4000) ? g.COLOR_BUFFER_BIT : 0) | ((mask & 0x100) ? g.DEPTH_BUFFER_BIT : 0));
      key = null;
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
    glDepthFunc: f(V, U), glDepthMask: f(V, U), glDepthRange: f(V, D, D), glAlphaFunc: f(V, U, F), glBlendFunc: f(V, U, U),
    glMatrixMode: f(V, U), glLoadIdentity: f(V), glLoadMatrixf: f(V, P), glPushMatrix: f(V), glPopMatrix: f(V),
    glTranslatef: f(V, F, F, F), glRotatef: f(V, F, F, F, F), glScalef: f(V, F, F, F),
    glFrustum: f(V, D, D, D, D, D, D), glOrtho: f(V, D, D, D, D, D, D), glGetFloatv: f(V, U, P),
    glBegin: f(V, U), glEnd: f(V), glVertex3f: f(V, F, F, F), glVertex3fv: f(V, P), glVertex2f: f(V, F, F),
    glNormal3f: f(V, F, F, F), glColor3f: f(V, F, F, F), glColor4f: f(V, F, F, F, F), glColor4fv: f(V, P), glColor3ubv: f(V, P),
    glTexCoord2f: f(V, F, F), glTexCoord2fv: f(V, P),
    glLightfv: f(V, U, U, P), glMaterialfv: f(V, U, U, P),
    glFogf: f(V, U, F), glFogi: f(V, U, I), glFogfv: f(V, U, P),
    glBindTexture: f(V, U, U), glTexParameterf: f(V, U, U, F), glTexEnvf: f(V, U, U, F),
    glTexImage2D: f(V, U, I, I, I, I, I, U, U, P), glTexSubImage2D: f(V, U, I, I, I, I, I, U, U, P),
    glReadPixels: f(V, I, I, I, I, U, U, P), glPolygonMode: f(V, U, U), glHint: f(V, U, U),
    glDrawBuffer: f(V, U), glReadBuffer: f(V, U),
    glGenLists: f(U, I), glNewList: f(V, U, U), glEndList: f(V), glCallList: f(V, U), glDeleteLists: f(V, U, I),
    glGetString: f(P, U), glFinish: f(V), glFlush: f(V),
  };
}
