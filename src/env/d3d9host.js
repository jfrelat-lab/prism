// d3d9host.js — the host side of src/env/d3d9.c: its one entry, prism_d3d9_call(op, a..h), onto src/env/d3d9.js's
// device. d3d9.c is d3d9.dll in C (the COM objects, their memory, what a program reads back); what it cannot do in C
// is draw, so every call that draws, or holds what is drawn, comes here by operation number -- the enum H_ in
// d3d9.c, in the same order as OPS below. Pointers are addresses in the program's memory (M.u8), read here.
//
// With no WebGL 2 context (Node, the texture gate) the device is refused (0) and d3d9.c stays headless.
//
//   installD3D9(M, { gl, canvas, onPresent })   gl: a WebGL2RenderingContext, or a canvas to take one from
import { createD3D9 } from './d3d9.js';

const OPS = ['DEVICE', 'BACKBUFFER', 'AUTODEPTH', 'TEXTURE', 'TEXWRITE', 'SURFACE', 'RENDERTARGET', 'DEPTHSURF', 'BUFFER', 'BUFWRITE',
  'SHADER', 'DECL', 'RS', 'SS', 'TSS', 'SETTEX', 'SETVS', 'SETPS', 'SETDECL', 'SETFVF', 'STREAM', 'INDICES', 'SETRT', 'SETDS',
  'CONSTS', 'VIEWPORT', 'SCISSOR', 'CLEAR', 'DRAW', 'DRAWI', 'DRAWUP', 'DRAWIUP', 'PRESENT', 'STRETCH', 'READBACK', 'COLORFILL',
  'RELEASE', 'TRANSFORM', 'MATERIAL', 'LIGHT', 'LIGHTENABLE'];
// vertices a primitive count needs, by D3DPRIMITIVETYPE
const VERTS = { 1: (n) => n, 2: (n) => 2 * n, 3: (n) => n + 1, 4: (n) => 3 * n, 5: (n) => n + 2, 6: (n) => n + 2 };

export function installD3D9(M, { gl = null, canvas = null, onPresent = () => {} } = {}) {
  const g = gl ?? canvas?.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true }) ?? null;
  const state = { dev: null, d3d: g ? createD3D9({ gl: g, onPresent: () => onPresent(state) }) : null, textures: new Map(), presents: 0, calls: new Map() };
  const u8 = () => M.u8;
  const bytes = (p, n) => u8().slice(p, p + n);
  const view = (p, n) => new DataView(u8().buffer, u8().byteOffset + p, n);
  const f32 = (p, n) => { const d = view(p, 4 * n); return Float32Array.from({ length: n }, (_, k) => d.getFloat32(4 * k, true)); };
  const i32 = (p, n) => { const d = view(p, 4 * n); return Int32Array.from({ length: n }, (_, k) => d.getInt32(4 * k, true)); };
  const rect = (p) => (p ? Array.from(i32(p, 4)) : null);
  const fromBits = (b) => new Float32Array(new Int32Array([b]).buffer)[0];
  const dim = (n, l) => Math.max(1, n >> l);

  const op = {
    DEVICE: (w, h, fmt, depth) => {
      if (!state.d3d) return 0;
      state.dev = state.d3d.createDevice({ width: w, height: h, backBufferFormat: fmt, backBufferCount: 1, autoDepthStencilFormat: depth, windowed: 1, presentInterval: 0 });
      return 1;
    },
    BACKBUFFER: () => state.dev.getBackBuffer(0, 0),
    AUTODEPTH: () => state.dev.getDepthStencilSurface(),
    TEXTURE: (kind, w, h, d, levels, usage, fmt) => {
      const D = state.dev;
      const t = kind === 0 ? D.createTexture(w, h, levels, usage, fmt) : kind === 1 ? D.createCubeTexture(w, levels, usage, fmt) : D.createVolumeTexture(w, h, d, levels, usage, fmt);
      state.textures.set(t, { kind, w, h, d });
      return t;
    },
    TEXWRITE: (t, face, level, bits, pitch, slice) => {
      const x = state.textures.get(t);
      if (x.kind === 2) state.dev.volumeWrite(t, level, bytes(bits, slice * dim(x.d, level)), pitch, slice);
      else state.dev.textureWrite(t, level, null, bytes(bits, pitch * dim(x.h, level)), pitch, face);
      return 0;
    },
    SURFACE: (t, face, level) => (state.textures.get(t).kind === 1 ? state.dev.getCubeMapSurface(t, face, level) : state.dev.getSurfaceLevel(t, level)),
    RENDERTARGET: (w, h, fmt) => state.dev.createRenderTarget(w, h, fmt),
    DEPTHSURF: (w, h) => state.dev.createDepthStencilSurface(w, h),
    BUFFER: (index, size, fmt) => (index ? state.dev.createIndexBuffer(size, 0, fmt) : state.dev.createVertexBuffer(size, 0, 0)),
    BUFWRITE: (b, off, p, n) => state.dev.bufferWrite(b, off, bytes(p, n)),
    SHADER: (pixel, p, n) => { const t = new Uint32Array(bytes(p, n).buffer); return pixel ? state.dev.createPixelShader(t) : state.dev.createVertexShader(t); },
    DECL: (p, n) => {
      const d = view(p, 8 * n);
      return state.dev.createVertexDeclaration(Array.from({ length: n }, (_, k) => ({ stream: d.getUint16(8 * k, true), offset: d.getUint16(8 * k + 2, true),
        type: d.getUint8(8 * k + 4), method: d.getUint8(8 * k + 5), usage: d.getUint8(8 * k + 6), usageIndex: d.getUint8(8 * k + 7) })));
    },
    RS: (s, v) => state.dev.setRenderState(s, v >>> 0),
    SS: (s, t, v) => state.dev.setSamplerState(s, t, v >>> 0),
    TSS: (s, t, v) => state.dev.setTextureStageState(s, t, v >>> 0),
    SETTEX: (s, t) => state.dev.setTexture(s, t),
    SETVS: (h) => state.dev.setVertexShader(h),
    SETPS: (h) => state.dev.setPixelShader(h),
    SETDECL: (h) => state.dev.setVertexDeclaration(h),
    SETFVF: (f) => state.dev.setFVF(f >>> 0),
    STREAM: (s, b, off, stride) => state.dev.setStreamSource(s, b, off, stride),
    INDICES: (b) => state.dev.setIndices(b),
    SETRT: (i, s) => state.dev.setRenderTarget(i, s),
    SETDS: (s) => state.dev.setDepthStencilSurface(s),
    CONSTS: (kind, start, p, n) => {
      const D = state.dev;
      return [() => D.setVertexShaderConstantF(start, f32(p, 4 * n)), () => D.setPixelShaderConstantF(start, f32(p, 4 * n)),
        () => D.setVertexShaderConstantI(start, i32(p, 4 * n)), () => D.setPixelShaderConstantI(start, i32(p, 4 * n)),
        () => D.setVertexShaderConstantB(start, i32(p, n)), () => D.setPixelShaderConstantB(start, i32(p, n))][kind]();
    },
    VIEWPORT: (p) => { const d = view(p, 24); return state.dev.setViewport({ x: d.getUint32(0, true), y: d.getUint32(4, true), width: d.getUint32(8, true), height: d.getUint32(12, true), minZ: d.getFloat32(16, true), maxZ: d.getFloat32(20, true) }); },
    SCISSOR: (p) => state.dev.setScissorRect(...rect(p)),
    CLEAR: (n, p, flags, color, z, stencil) => state.dev.clear(p && n ? Array.from({ length: n }, (_, k) => rect(p + 16 * k)) : null, flags, color >>> 0, fromBits(z), stencil),
    DRAW: (t, start, n) => state.dev.drawPrimitive(t, start, n),
    DRAWI: (t, base, min, nv, start, n) => state.dev.drawIndexedPrimitive(t, base, min, nv, start, n),
    DRAWUP: (t, n, v, stride) => state.dev.drawPrimitiveUP(t, n, bytes(v, VERTS[t](n) * stride), stride),
    DRAWIUP: (t, min, nv, n, ix, fmt, v, stride) =>
      state.dev.drawIndexedPrimitiveUP(t, min, nv, n, bytes(ix, VERTS[t](n) * (fmt === 102 ? 4 : 2)), fmt, bytes(v, (min + nv) * stride), stride),
    PRESENT: () => { state.presents++; return state.dev.present(); },
    STRETCH: (a, ar, b, br, filter) => state.dev.stretchRect(a, rect(ar), b, rect(br), filter),
    READBACK: (s, bits, pitch) => {
      const { bytes: px, pitch: sp } = state.dev.surfaceRead(s), mem = u8(), row = Math.min(pitch, sp);
      for (let y = 0; y < px.length / sp; y++) mem.set(px.subarray(y * sp, y * sp + row), bits + y * pitch);
      return 0;
    },
    // ColorFill: a clear of that surface alone, the device's targets, viewport and scissor as they were
    COLORFILL: (s, r, color) => {
      const D = state.dev, rts = [0, 1, 2, 3].map((i) => D.getRenderTarget(i)), vp = D.getViewport(), sc = D.getScissorRect();
      D.setRenderTarget(0, s); for (let i = 1; i < 4; i++) D.setRenderTarget(i, 0);
      D.clear(r ? [rect(r)] : null, 1, color >>> 0, 1, 0);
      rts.forEach((h, i) => D.setRenderTarget(i, h));
      D.setViewport(vp); D.setScissorRect(...sc);
      return 0;
    },
    RELEASE: (h) => (h ? state.dev.release(h) : 0),
    TRANSFORM: (t, p) => state.dev.setTransform(t, f32(p, 16)),
    MATERIAL: (p) => { const v = f32(p, 17); return state.dev.setMaterial({ diffuse: [...v.slice(0, 4)], ambient: [...v.slice(4, 8)], specular: [...v.slice(8, 12)], emissive: [...v.slice(12, 16)], power: v[16] }); },
    LIGHT: (i, p) => {
      const v = f32(p + 4, 24);
      return state.dev.setLight(i, { type: view(p, 4).getUint32(0, true), diffuse: [...v.slice(0, 4)], specular: [...v.slice(4, 8)], ambient: [...v.slice(8, 12)],
        position: [...v.slice(12, 15)], direction: [...v.slice(15, 18)], range: v[18], falloff: v[19], attenuation: [v[20], v[21], v[22]], theta: v[23], phi: f32(p + 100, 1)[0] });
    },
    LIGHTENABLE: (i, on) => state.dev.lightEnable(i, !!on),
  };
  const table = OPS.map((name) => op[name]);
  Object.assign(M.rt, {
    prism_d3d9_call: (n, a, b, c, d, e, f, g2, h) => {
      const fn = table[n - 1];
      if (!fn) throw new Error(`d3d9host: operation ${n}`);
      if (!state.dev && n !== 1) return 0;
      state.calls.set(OPS[n - 1], (state.calls.get(OPS[n - 1]) ?? 0) + 1);
      const r = fn(a, b, c, d, e, f, g2, h);
      return typeof r === 'number' ? r | 0 : 0;
    },
    prism_d3d9_unlocked: () => {},
  });
  M.d3d9 = state;
  return state;
}

export function d3d9Builtins(T) {
  const I = T.INT, V = T.VOID, P = T.ptr(T.CHAR);
  return {
    prism_d3d9_call: { ret: I, params: [I, I, I, I, I, I, I, I, I] },
    prism_d3d9_unlocked: { ret: V, params: [I, I, I, I, I, I, P, I] },
  };
}
