// d3d9.js — Direct3D 9's device model on WebGL 2: what a program's calls through IDirect3D9 and
// IDirect3DDevice9 do, for a COM layer that owns the objects and the guest memory (an
// emulator's Win32 layer calls this). Nothing here reads or writes guest memory: the layer hands bytes in
// (Uint8Array, Uint32Array, Float32Array views it made) and copies the ones it gets back. Enum values
// are d3d9types.h's; returns are HRESULTs; what is not implemented throws, naming the method and value.
//
// ORIENTATION. A render target keeps D3D's rows: row 0, the top of the picture, is the GL texture's
// first row -- so a texture the program uploads and one it draws into are read with the same
// coordinates, (0,0) the first row of each. Present blits the back buffer to the canvas flipped. The
// clip space is D3D's too: a shader's position goes through prism_posFix (y flipped, the half-pixel
// offset of D3D9's pixel centres at integer coordinates), and a pretransformed vertex (XYZRHW) is a
// render-target pixel position, its centre at x + 0.5 in GL's terms.
//
// SHADERS. A shader is HLSL carried in the blob D3DXCompileShader returns (hlsl.js: makeBlob,
// translateHLSL) or real SM2/SM3 bytecode (not yet: refused by name). With no vertex shader the
// vertices must be pretransformed (XYZRHW); the fixed function's transform and lighting is not yet here.
import { translateHLSL, blobHLSL, hlslConstants } from './hlsl.js';
import { translateBytecode, bytecodeVersion } from './sm9.js';

const OK = 0, D3DERR_NOTAVAILABLE = 0x8876086a | 0, D3DERR_INVALIDCALL = 0x8876086c | 0;
const fail = (msg) => { throw new Error(`d3d9: ${msg}`); };

// Formats: [GL internal format, format, type, bytes a texel, how the D3D bytes become GL's]
const FMT = {
  21: ['RGBA8', 'RGBA', 'UNSIGNED_BYTE', 4, 'bgra'],      // A8R8G8B8: memory B,G,R,A
  22: ['RGBA8', 'RGBA', 'UNSIGNED_BYTE', 4, 'bgrx'],      // X8R8G8B8
  32: ['RGBA8', 'RGBA', 'UNSIGNED_BYTE', 4, 'rgba'],      // A8B8G8R8
  28: ['R8', 'RED', 'UNSIGNED_BYTE', 1, 'a8'],            // A8: alpha only
  50: ['R8', 'RED', 'UNSIGNED_BYTE', 1, 'l8'],            // L8
  111: ['R16F', 'RED', 'HALF_FLOAT', 2, 'copy'],          // R16F
  112: ['RG16F', 'RG', 'HALF_FLOAT', 4, 'copy'],          // G16R16F
  113: ['RGBA16F', 'RGBA', 'HALF_FLOAT', 8, 'copy'],      // A16B16G16R16F
  114: ['R32F', 'RED', 'FLOAT', 4, 'copy'],               // R32F
  115: ['RG32F', 'RG', 'FLOAT', 8, 'copy'],               // G32R32F
  116: ['RGBA32F', 'RGBA', 'FLOAT', 16, 'copy'],          // A32B32G32R32F
};
// a float as IEEE half bits (round to nearest even), for reading an F16 target back
const f32h = new Float32Array(1), u32h = new Uint32Array(f32h.buffer);
function half(v) {
  f32h[0] = v; const x = u32h[0], sign = (x >>> 16) & 0x8000, e = (x >>> 23) & 255, m = x & 0x7fffff;
  if (e === 255) return sign | 0x7c00 | (m ? 0x200 : 0);
  const he = e - 112;
  if (he >= 31) return sign | 0x7c00;
  if (he <= 0) { if (he < -10) return sign; const mm = (m | 0x800000) >>> (1 - he); return sign | ((mm >>> 13) + ((mm >>> 12) & 1 && ((mm & 0x1fff) !== 0x1000 || (mm >>> 13) & 1) ? 1 : 0)); }
  const r = (he << 10) | (m >>> 13), rest = m & 0x1fff;
  return sign | (r + (rest > 0x1000 || (rest === 0x1000 && (r & 1)) ? 1 : 0));
}
const DEPTH_FMT = new Set([70, 71, 75, 77, 79, 80, 82, 83]);   // D15S1 D32 D24S8 D24X8 D24X4S4 D16 D32F_LOCKABLE D24FS8
const USAGE_RENDERTARGET = 1, USAGE_DEPTHSTENCIL = 2, USAGE_AUTOGENMIPMAP = 0x400;

// Render states (D3DRENDERSTATETYPE) and their defaults; the device's auto depth buffer sets ZENABLE.
const RS = { ZENABLE: 7, FILLMODE: 8, SHADEMODE: 9, ZWRITEENABLE: 14, ALPHATESTENABLE: 15, SRCBLEND: 19, DESTBLEND: 20, CULLMODE: 22, ZFUNC: 23,
  ALPHAREF: 24, ALPHAFUNC: 25, DITHERENABLE: 26, ALPHABLENDENABLE: 27, FOGENABLE: 28, SPECULARENABLE: 29, STENCILENABLE: 52, STENCILFAIL: 53, STENCILZFAIL: 54,
  STENCILPASS: 55, STENCILFUNC: 56, STENCILREF: 57, STENCILMASK: 58, STENCILWRITEMASK: 59, TEXTUREFACTOR: 60, LIGHTING: 137, COLORWRITEENABLE: 168,
  BLENDOP: 171, SCISSORTESTENABLE: 174, SLOPESCALEDEPTHBIAS: 175, SRGBWRITEENABLE: 194, DEPTHBIAS: 195, SEPARATEALPHABLENDENABLE: 206,
  SRCBLENDALPHA: 207, DESTBLENDALPHA: 208, BLENDOPALPHA: 209, BLENDFACTOR: 193, POINTSIZE: 154, AMBIENT: 139, COLORVERTEX: 141, LOCALVIEWER: 142,
  NORMALIZENORMALS: 143, DIFFUSEMATERIALSOURCE: 145, SPECULARMATERIALSOURCE: 146, AMBIENTMATERIALSOURCE: 147, EMISSIVEMATERIALSOURCE: 148 };
const RS_DEFAULT = { [RS.FILLMODE]: 3, [RS.SHADEMODE]: 2, [RS.ZWRITEENABLE]: 1, [RS.SRCBLEND]: 2, [RS.DESTBLEND]: 1, [RS.CULLMODE]: 3, [RS.ZFUNC]: 4,
  [RS.ALPHAFUNC]: 8, [RS.DITHERENABLE]: 0, [RS.STENCILFAIL]: 1, [RS.STENCILZFAIL]: 1, [RS.STENCILPASS]: 1, [RS.STENCILFUNC]: 8, [RS.STENCILMASK]: 0xffffffff,
  [RS.STENCILWRITEMASK]: 0xffffffff, [RS.TEXTUREFACTOR]: 0xffffffff, [RS.LIGHTING]: 1, [RS.COLORWRITEENABLE]: 0xf, [RS.BLENDOP]: 1, [RS.SRCBLENDALPHA]: 2,
  [RS.DESTBLENDALPHA]: 1, [RS.BLENDOPALPHA]: 1, [RS.BLENDFACTOR]: 0xffffffff, [RS.COLORVERTEX]: 1, [RS.LOCALVIEWER]: 1, [RS.DIFFUSEMATERIALSOURCE]: 1,
  [RS.SPECULARMATERIALSOURCE]: 2 };
// Texture stage states (D3DTEXTURESTAGESTATETYPE) the fixed function's pixel stage reads, and their defaults: stage 0
// modulates its texture by the diffuse colour and takes the texture's alpha, the others are disabled.
const TSS = { COLOROP: 1, COLORARG1: 2, COLORARG2: 3, ALPHAOP: 4, ALPHAARG1: 5, ALPHAARG2: 6, TEXCOORDINDEX: 11, TEXTURETRANSFORMFLAGS: 24 };
const tssDefault = (k) => ({ [TSS.COLOROP]: k ? 1 : 4, [TSS.COLORARG1]: 2, [TSS.COLORARG2]: 1, [TSS.ALPHAOP]: k ? 1 : 2, [TSS.ALPHAARG1]: 2, [TSS.ALPHAARG2]: 1,
  [TSS.TEXCOORDINDEX]: k, [TSS.TEXTURETRANSFORMFLAGS]: 0 });
// Sampler states (D3DSAMPLERSTATETYPE): ADDRESSU/V/W, BORDERCOLOR, MAG/MIN/MIPFILTER, MIPMAPLODBIAS, MAXMIPLEVEL, MAXANISOTROPY, SRGBTEXTURE
const SAMP_DEFAULT = [0, 1, 1, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0];

/** D3DCAPS9 (304 bytes), as this device answers it. */
function caps() {
  const f = [
    ['DeviceType', 1], ['AdapterOrdinal', 0], ['Caps', 0x20000], ['Caps2', 0x60020000], ['Caps3', 0x3a0], ['PresentationIntervals', 0x80000001], ['CursorCaps', 1],
    ['DevCaps', 0x1bbef0], ['PrimitiveMiscCaps', 0x2fcef2], ['RasterCaps', 0x7732191], ['ZCmpCaps', 0xff], ['SrcBlendCaps', 0x3fff], ['DestBlendCaps', 0x3fff],
    ['AlphaCmpCaps', 0xff], ['ShadeCaps', 0x84208], ['TextureCaps', 0x1ec05], ['TextureFilterCaps', 0x3030700], ['CubeTextureFilterCaps', 0x3030300],
    ['VolumeTextureFilterCaps', 0x3030300], ['TextureAddressCaps', 0x3f], ['VolumeTextureAddressCaps', 0x3f], ['LineCaps', 0x1f], ['MaxTextureWidth', 8192],
    ['MaxTextureHeight', 8192], ['MaxVolumeExtent', 2048], ['MaxTextureRepeat', 8192], ['MaxTextureAspectRatio', 8192], ['MaxAnisotropy', 16],
    ['MaxVertexW', 1e10, 'f'], ['GuardBandLeft', -8192, 'f'], ['GuardBandTop', -8192, 'f'], ['GuardBandRight', 8192, 'f'], ['GuardBandBottom', 8192, 'f'],
    ['ExtentsAdjust', 0, 'f'], ['StencilCaps', 0x1ff], ['FVFCaps', 0x180008], ['TextureOpCaps', 0x3ffffff], ['MaxTextureBlendStages', 8], ['MaxSimultaneousTextures', 8],
    ['VertexProcessingCaps', 0x17b], ['MaxActiveLights', 8], ['MaxUserClipPlanes', 6], ['MaxVertexBlendMatrices', 4], ['MaxVertexBlendMatrixIndex', 0],
    ['MaxPointSize', 64, 'f'], ['MaxPrimitiveCount', 0xffffff], ['MaxVertexIndex', 0xffffff], ['MaxStreams', 16], ['MaxStreamStride', 508],
    ['VertexShaderVersion', 0xfffe0300], ['MaxVertexShaderConst', 256], ['PixelShaderVersion', 0xffff0300], ['PixelShader1xMaxValue', 65504, 'f'],
    ['DevCaps2', 0x51], ['MaxNpatchTessellationLevel', 0, 'f'], ['Reserved5', 0], ['MasterAdapterOrdinal', 0], ['AdapterOrdinalInGroup', 0],
    ['NumberOfAdaptersInGroup', 1], ['DeclTypes', 0x30f], ['NumSimultaneousRTs', 4], ['StretchRectFilterCaps', 0x3000300],
    ['VS20Caps.Caps', 1], ['VS20Caps.DynamicFlowControlDepth', 24], ['VS20Caps.NumTemps', 32], ['VS20Caps.StaticFlowControlDepth', 4],
    ['PS20Caps.Caps', 0x1f], ['PS20Caps.DynamicFlowControlDepth', 24], ['PS20Caps.NumTemps', 32], ['PS20Caps.StaticFlowControlDepth', 4],
    ['PS20Caps.NumInstructionSlots', 512], ['VertexTextureFilterCaps', 0x3000300], ['MaxVShaderInstructionsExecuted', 65535],
    ['MaxPShaderInstructionsExecuted', 65535], ['MaxVertexShader30InstructionSlots', 32768], ['MaxPixelShader30InstructionSlots', 32768],
  ];
  if (f.length * 4 !== 304) fail(`D3DCAPS9 is ${f.length * 4} bytes`);
  const b = new Uint8Array(304), v = new DataView(b.buffer);
  f.forEach(([, x, t], k) => (t === 'f' ? v.setFloat32(4 * k, x, true) : v.setUint32(4 * k, x >>> 0, true)));
  return b;
}

/** IDirect3D9, on a WebGL2 context; `onPresent()` after each Present. */
export function createD3D9({ gl: g, onPresent = () => {} }) {
  const floatRT = !!g.getExtension('EXT_color_buffer_float');
  g.getExtension('OES_texture_float_linear');
  const d3d = {
    hlslConstants,
    getAdapterDisplayMode: () => ({ width: g.drawingBufferWidth, height: g.drawingBufferHeight, refresh: 60, format: 22 }),
    getDeviceCaps: caps,
    checkDeviceType: () => OK,
    checkDeviceFormat: (adapterFmt, usage, rtype, fmt) => {
      if (usage & USAGE_DEPTHSTENCIL) return DEPTH_FMT.has(fmt) ? OK : D3DERR_NOTAVAILABLE;
      const f = FMT[fmt];
      if (!f) return D3DERR_NOTAVAILABLE;
      if ((usage & USAGE_RENDERTARGET) && /F$/.test(f[0]) && !floatRT) return D3DERR_NOTAVAILABLE;
      return OK;
    },
    checkDepthStencilMatch: () => OK,
    checkDeviceMultiSampleType: (a, b, c, d, type) => (type === 0 ? OK : D3DERR_NOTAVAILABLE),
    createDevice: (p) => createDevice(g, p, { floatRT, onPresent }),
  };
  return d3d;
}

function createDevice(g, params, { floatRT, onPresent }) {
  const objects = new Map();
  let nextHandle = 1;
  const add = (o) => { const h = nextHandle++; objects.set(h, o); return h; };
  const get = (h, kind) => { const o = objects.get(h); if (!o || (kind && o.kind !== kind)) fail(`handle ${h} is not a ${kind}`); return o; };

  // ---- surfaces and textures ----
  function makeTexture(w, h, levels, usage, format) {
    const f = FMT[format] ?? fail(`texture format ${format}`);
    if ((usage & USAGE_RENDERTARGET) && /F$/.test(f[0]) && !floatRT) fail('a float render target without EXT_color_buffer_float');
    const n = levels || 1 + Math.floor(Math.log2(Math.max(w, h)));
    const tex = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, tex);
    g.texStorage2D(g.TEXTURE_2D, (usage & USAGE_AUTOGENMIPMAP) ? 1 + Math.floor(Math.log2(Math.max(w, h))) : n, g[f[0]], w, h);
    const t = { kind: 'texture', tex, w, h, levels: n, usage, format, f, surfaces: [] };
    for (let l = 0; l < n; l++) t.surfaces.push(add({ kind: 'surface', tex: t, level: l, w: Math.max(1, w >> l), h: Math.max(1, h >> l), format }));
    return t;
  }
  function makeDepth(w, h) {
    const rb = g.createRenderbuffer();
    g.bindRenderbuffer(g.RENDERBUFFER, rb);
    g.renderbufferStorage(g.RENDERBUFFER, g.DEPTH24_STENCIL8, w, h);
    return { kind: 'surface', depth: rb, w, h, sized: new Map() };
  }
  // D3D9 draws into a render target smaller than the depth buffer through the depth buffer's top-left
  // corner; WebGL wants attachments of one size. A depth surface met with a smaller target answers with
  // a renderbuffer of that size, its own: what is drawn through one size is not seen through another.
  function depthFor(d, w, h) {
    if (d.w === w && d.h === h) return d.depth;
    if (w > d.w || h > d.h) fail(`a ${w}x${h} render target with a ${d.w}x${d.h} depth buffer (D3D9 wants the depth buffer at least as large)`);
    let rb = d.sized.get(`${w}x${h}`);
    if (!rb) { rb = g.createRenderbuffer(); g.bindRenderbuffer(g.RENDERBUFFER, rb); g.renderbufferStorage(g.RENDERBUFFER, g.DEPTH24_STENCIL8, w, h); d.sized.set(`${w}x${h}`, rb); }
    return rb;
  }
  const W = params.width || g.drawingBufferWidth, H = params.height || g.drawingBufferHeight;
  const backTex = makeTexture(W, H, 1, USAGE_RENDERTARGET, params.backBufferFormat === 22 ? 22 : 21);
  const backBuffer = backTex.surfaces[0];
  const autoDepth = params.autoDepthStencilFormat ? add(makeDepth(W, H)) : 0;

  // Framebuffers, one per (colour surfaces, depth surface).
  const fbos = new Map(), fbBufs = new Map();
  function framebuffer() {
    const key = `${rt.join(',')}/${depthSurface}`;
    let fb = fbos.get(key);
    if (!fb) {
      fb = g.createFramebuffer();
      g.bindFramebuffer(g.FRAMEBUFFER, fb);
      const bufs = [];
      rt.forEach((h, k) => {
        if (!h) { bufs.push(g.NONE); return; }
        const s = get(h, 'surface');
        g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0 + k, g.TEXTURE_2D, s.tex.tex, s.level);
        bufs.push(g.COLOR_ATTACHMENT0 + k);
      });
      g.drawBuffers(bufs);
      fbBufs.set(fb, bufs);
      const first = rt.find(Boolean);
      if (depthSurface && first) { const c = get(first, 'surface'); g.framebufferRenderbuffer(g.FRAMEBUFFER, g.DEPTH_STENCIL_ATTACHMENT, g.RENDERBUFFER, depthFor(get(depthSurface, 'surface'), c.w, c.h)); }
      const st = g.checkFramebufferStatus(g.FRAMEBUFFER);
      if (st !== g.FRAMEBUFFER_COMPLETE) fail(`render target incomplete (0x${st.toString(16)})`);
      fbos.set(key, fb);
    }
    return fb;
  }

  // ---- state ----
  const rs = new Map(Object.entries(RS_DEFAULT).map(([k, v]) => [+k, v]));
  rs.set(RS.ZENABLE, autoDepth ? 1 : 0);
  // sampler slots: 0-15 the pixel shader's, 16-19 the vertex shader's (D3DVERTEXTEXTURESAMPLER0-3, 257-260); a slot is also its texture unit
  const slot = (s) => (s >= 0 && s < 16 ? s : s >= 257 && s <= 260 ? s - 241 : fail(`sampler ${s}`));
  const samp = Array.from({ length: 20 }, () => SAMP_DEFAULT.slice());
  const textures = new Array(20).fill(0);
  const vsF = new Float32Array(256 * 4), psF = new Float32Array(224 * 4);
  const vsI = new Int32Array(16 * 4), psI = new Int32Array(16 * 4), vsB = new Int32Array(16), psB = new Int32Array(16);
  let rt = [backBuffer, 0, 0, 0], depthSurface = autoDepth;
  let viewport = { x: 0, y: 0, width: W, height: H, minZ: 0, maxZ: 1 }, scissor = [0, 0, W, H];
  let fvf = 0, decl = 0, vs = 0, ps = 0, inScene = false;
  const streams = Array.from({ length: 16 }, () => ({ vb: 0, offset: 0, stride: 0 }));
  let indices = 0;
  // the fixed function's state: transforms (D3DTRANSFORMSTATETYPE, D3D's row-major matrices), lights, the material, the stages
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const transforms = new Map();
  const transform = (t) => transforms.get(t) ?? IDENTITY;
  const lights = new Map(), lightOn = new Set();
  let material = { diffuse: [0, 0, 0, 0], ambient: [0, 0, 0, 0], specular: [0, 0, 0, 0], emissive: [0, 0, 0, 0], power: 0 };
  const tss = Array.from({ length: 8 }, (_, k) => new Map(Object.entries(tssDefault(k)).map(([t, v]) => [+t, v])));

  // ---- shaders ----
  function makeShader(tokens, type) {
    // the HLSL source D3DXCompileShader's caller was handed (hlsl.js), or real shader bytecode (sm9.js)
    const h = blobHLSL(tokens), v = h ? null : bytecodeVersion(tokens);
    const profile = h ? h.profile : v ? `${v.stage}_${v.major}_${v.minor}` : fail(`${type} shader: version token 0x${(tokens[0] >>> 0).toString(16)}`);
    if ((profile[0] === 'p') !== (type === 'pixel')) fail(`a ${profile} shader given as a ${type} shader`);
    const t = h ? translateHLSL(h.source, h.entry, h.profile) : translateBytecode(tokens);
    const sh = g.createShader(type === 'pixel' ? g.FRAGMENT_SHADER : g.VERTEX_SHADER);
    g.shaderSource(sh, t.glsl); g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) fail(`${profile}${h ? ` ${h.entry}` : ''}: ${g.getShaderInfoLog(sh)}\n${t.glsl}`);
    return { kind: type, sh, ...t };
  }
  // An FVF as vertex elements { off, size, color, usage, index } (usage as the HLSL semantic's name,
  // lower case) and its stride. D3DCOLOR elements are B,G,R,A bytes.
  const fvfLayouts = new Map();
  function fvfLayout(f) {
    let L = fvfLayouts.get(f);
    if (L) return L;
    const E = [];
    let off = 0;
    const el = (size, usage, index = 0, color = false) => { E.push({ off, size, color, usage, index }); off += color ? 4 : 4 * size; };
    const pos = f & 0x400e;
    if (pos === 0x4) el(4, 'positiont');                     // XYZRHW
    else if (pos === 0x2) el(3, 'position');                 // XYZ
    else if (pos === 0x4002) el(4, 'position');              // XYZW
    else fail(`FVF 0x${f.toString(16)}: position type 0x${pos.toString(16)} (blend weights) is not supported yet`);
    if (f & 0x10) el(3, 'normal');
    if (f & 0x20) el(1, 'psize');
    if (f & 0x40) el(4, 'color', 0, true);
    if (f & 0x80) el(4, 'color', 1, true);
    for (let k = 0, n = (f >> 8) & 15; k < n; k++) el([2, 3, 4, 1][(f >> (16 + 2 * k)) & 3], 'texcoord', k);
    L = { E, stride: off, colors: E.filter((e) => e.color).map((e) => e.off) };
    fvfLayouts.set(f, L);
    return L;
  }
  // What a sampler read must be made into, beyond GL's own read, per draw:
  // - D3DTADDRESS_BORDER, which WebGL lacks: the border colour outside [0, 1] on that axis (the GL sampler
  //   clamps). Exact with point filtering; with linear, D3D also blends the border into the outermost half texel.
  // - the channels a format does not store, which D3D9 fills where GL gives 0: R16F/R32F read (r, 1, 1, 1),
  //   G16R16F/G32R32F (r, g, 1, 1), L8 (l, l, l, 1), A8 (0, 0, 0, a), X8R8G8B8 (r, g, b, 1). WebGL has no
  //   texture swizzle, so the shader does it.
  // The reads of such a sampler go through a function; the program is built per combination.
  const BORDER = 4;
  const FILL = { 111: 'vec4(c.r, 1.0, 1.0, 1.0)', 114: 'vec4(c.r, 1.0, 1.0, 1.0)', 112: 'vec4(c.rg, 1.0, 1.0)', 115: 'vec4(c.rg, 1.0, 1.0)',
    50: 'vec4(c.rrr, 1.0)', 28: 'vec4(0.0, 0.0, 0.0, c.r)', 22: 'vec4(c.rgb, 1.0)' };
  function adaptations(samplers, base) {
    const out = [];
    for (const sm of samplers) {
      const sl = base + sm.index, st = samp[sl], t = textures[sl] ? objects.get(textures[sl]) : null;
      const u = sm.dim === '2D' && st[1] === BORDER, v = sm.dim === '2D' && st[2] === BORDER, fill = sm.dim === '2D' && t ? FILL[t.format] : undefined;
      if (u || v || fill) out.push({ index: sm.index, slot: sl, u, v, fill });
    }
    return out;
  }
  function adapt(glsl, prefix, list) {
    for (const { index, u, v, fill } of list) {
      const out = [u && 'uv.x < 0.0 || uv.x > 1.0', v && 'uv.y < 0.0 || uv.y > 1.0'].filter(Boolean).join(' || ');
      const id = `${prefix}${index}`, s = `prism_${id}`;
      const fn = (name, args, call) => `vec4 ${name}${id}(${args}) { vec4 c = ${call};${fill ? ` c = ${fill};` : ''} return ${out ? `(${out}) ? prism_bc${id} : c` : 'c'}; }`;
      // the reads first, then the functions (whose own reads must stay plain) after the sampler's declaration
      for (const [call, name] of [['texture', 'bt'], ['textureLod', 'btl'], ['textureGrad', 'btg'], ['textureProj', 'btp']]) glsl = glsl.replace(new RegExp(`\\b${call}\\(${s}, `, 'g'), `prism_${name}${id}(`);
      glsl = glsl.replace(`uniform highp sampler2D ${s};`, (d) => [d, ...(out ? [`uniform vec4 prism_bc${id};`] : []),
        fn('prism_bt', 'vec2 uv', `texture(${s}, uv)`), ...(prefix === 's' ? [fn('prism_bt', 'vec2 uv, float bias', `texture(${s}, uv, bias)`)] : []),
        fn('prism_btl', 'vec2 uv, float lod', `textureLod(${s}, uv, lod)`), fn('prism_btg', 'vec2 uv, vec2 dx, vec2 dy', `textureGrad(${s}, uv, dx, dy)`),
        `vec4 prism_btp${id}(vec3 q) { return prism_bt${id}(q.xy / q.z); }`, `vec4 prism_btp${id}(vec4 q) { return prism_bt${id}(q.xy / q.w); }`].join('\n'));
    }
    return glsl;
  }
  const compile = (type, src, what) => {
    const sh = g.createShader(type); g.shaderSource(sh, src); g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) fail(`${what}: ${g.getShaderInfoLog(sh)}\n${src}`);
    return sh;
  };
  const programs = new Map();
  function program(vsObj, psObj, L) {
    const psA = adaptations(psObj.samplers, 0), vsA = vsObj ? adaptations(vsObj.samplers, 16) : [];
    const sig = (l) => l.map((x) => `${x.index}${x.u ? 'u' : ''}${x.v ? 'v' : ''}${x.fill ? textures[x.slot] && objects.get(textures[x.slot]).format : ''}`).join(',');
    const key = `${vsObj ? objectsKey(vsObj) : `t${fvf}`}|${objectsKey(psObj)}|${sig(psA)}|${sig(vsA)}`;
    let p = programs.get(key);
    if (p) return p;
    let vsrc;
    if (vsObj) {
      // the vertex shader's register file apart from the pixel shader's; what the pixel shader reads and it does not write, zero
      const missing = psObj.inputs.filter((i) => !vsObj.outputs.some((o) => o.name === i.name));
      vsrc = vsObj.glsl.replace(/\bprism_([cib])\b/g, 'prism_v$1').replace(/\bprism_s(\d+)\b/g, 'prism_vs$1')
        .replace('void main() {', [...missing.map((i) => `out vec4 ${i.name};`), 'void main() {', ...missing.map((i) => `  ${i.name} = vec4(0.0);`)].join('\n'));
    } else {
      if (!L.E.some((e) => e.usage === 'positiont')) fail(`FVF 0x${fvf.toString(16)} without a vertex shader: the fixed function's transform is not supported yet`);
      const reads = psObj.inputs;
      const attr = (r) => `prism_a_${r.semantic === 'COLOR' ? 'color' : 'texcoord'}${r.index}`;
      vsrc = ['#version 300 es', 'precision highp float;', 'in vec4 prism_a_positiont0;', ...reads.map((r) => `in vec4 ${attr(r)};`),
        'uniform vec4 u_vp;', 'uniform vec2 u_zr;', ...reads.map((r) => `out vec4 ${r.name};`),
        'void main() {',
        // a render-target pixel position (centre at +0.5), into the viewport's normalised coordinates; w = 1/RHW for perspective
        '  vec4 p = prism_a_positiont0;',
        '  float w = p.w == 0.0 ? 1.0 : 1.0 / p.w;',
        '  vec2 ndc = (p.xy + 0.5 - u_vp.xy) / u_vp.zw * 2.0 - 1.0;',
        '  float z = (p.z - u_zr.x) / max(u_zr.y - u_zr.x, 1e-9) * 2.0 - 1.0;',
        '  gl_Position = vec4(ndc * w, z * w, w);',
        ...reads.map((r) => `  ${r.name} = ${attr(r)};`),
        '}', ''].join('\n');
    }
    const prog = g.createProgram();
    if (vsA.length) vsrc = adapt(vsrc, 'vs', vsA);
    g.attachShader(prog, compile(g.VERTEX_SHADER, vsrc, vsObj ? 'vertex shader' : 'pretransformed vertex stage'));
    g.attachShader(prog, psA.length ? compile(g.FRAGMENT_SHADER, adapt(psObj.glsl, 's', psA), 'pixel shader with its sampler reads adapted') : psObj.sh);
    // attributes by semantic: prism_a_<usage><index>, matched to the vertex elements at each draw
    const attrs = [...vsrc.matchAll(/^in vec4 prism_a_([a-z]+?)(\d+);$/gm)].map((m, loc) => ({ loc, usage: m[1], index: +m[2] }));
    for (const a of attrs) g.bindAttribLocation(prog, a.loc, `prism_a_${a.usage}${a.index}`);
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) fail(`link: ${g.getProgramInfoLog(prog)}`);
    const u = (n) => g.getUniformLocation(prog, n);
    p = { prog, attrs, c: u('prism_c'), vc: u('prism_vc'), i: u('prism_i'), vi: u('prism_vi'), b: u('prism_b'), vb: u('prism_vb'), posFix: u('prism_posFix'), vp: u('u_vp'), zr: u('u_zr'),
      ff: vsObj?.ffp ? { world: u('prism_ff_world'), view: u('prism_ff_view'), proj: u('prism_ff_proj'), mat: u('prism_ff_mat'), ambient: u('prism_ff_ambient'), light: u('prism_ff_light') } : null,
      s: [...psObj.samplers.map((sm) => [sm.index, u(`prism_s${sm.index}`)]), ...(vsObj ? vsObj.samplers.map((sm) => [16 + sm.index, u(`prism_vs${sm.index}`)]) : [])], bc: [...psA.map((x) => [x.slot, u(`prism_bcs${x.index}`)]), ...vsA.map((x) => [x.slot, u(`prism_bcvs${x.index}`)])].filter(([, l]) => l) };
    programs.set(key, p);
    return p;
  }
  // ---- the fixed function ----
  // Its vertex stage (D3D9's "Mathematics of Lighting"), generated per combination of what changes the code:
  // the vertex's elements, lighting on or off, which lights of which types, the material's sources. Lighting is
  // done in camera space, as D3D9 does it: D3D's row vectors, so v * World * View * Projection.
  const ffCache = new Map();
  function ffVertex(L) {
    const has = (u, i = 0) => L.E.some((e) => e.usage === u && e.index === i);
    if (has('psize')) fail('the fixed function with a point size in the vertex is not supported yet');
    if (rs.get(RS.FOGENABLE)) fail('fog in the fixed function (D3DRS_FOGENABLE) is not supported yet');
    const lit = !!rs.get(RS.LIGHTING);
    const on = lit ? [...lightOn].sort((a, b) => a - b).slice(0, 8).map((i) => lights.get(i)) : [];
    const cv = rs.get(RS.COLORVERTEX);
    // a material colour taken from the vertex: D3DMCS_COLOR1 or COLOR2, when the vertex has that colour
    const src = (r, fallback) => { const m = rs.get(r); return cv && m === 1 && has('color', 0) ? 'prism_a_color0' : cv && m === 2 && has('color', 1) ? 'prism_a_color1' : fallback; };
    const tcs = [...Array(8).keys()].filter((k) => has('texcoord', k));
    for (let k = 0; k < 8; k++) if (tss[k].get(TSS.TEXCOORDINDEX) !== k || tss[k].get(TSS.TEXTURETRANSFORMFLAGS)) fail(`texture stage ${k}: generated or transformed texture coordinates (D3DTSS_TEXCOORDINDEX, TEXTURETRANSFORMFLAGS) are not supported yet`);
    const sig = `${L.E.map((e) => e.usage + e.index).join(',')}|${lit ? on.map((l) => l.type).join('') : 'unlit'}|${[RS.SPECULARENABLE, RS.LOCALVIEWER, RS.NORMALIZENORMALS].map((r) => rs.get(r) ? 1 : 0).join('')}|${lit ? [RS.DIFFUSEMATERIALSOURCE, RS.SPECULARMATERIALSOURCE, RS.AMBIENTMATERIALSOURCE, RS.EMISSIVEMATERIALSOURCE].map((r) => src(r, '-')).join(',') : ''}`;
    let o = ffCache.get(`v${sig}`);
    if (o) return o;
    const ins = ['position0', ...(has('normal') ? ['normal0'] : []), 'color0', 'color1', ...tcs.map((k) => `texcoord${k}`)];
    const outs = [{ semantic: 'COLOR', index: 0, name: 'prism_col0' }, { semantic: 'COLOR', index: 1, name: 'prism_col1' }, ...tcs.map((k) => ({ semantic: 'TEXCOORD', index: k, name: `prism_t${k}` }))];
    const body = [];
    if (lit) {
      const Md = src(RS.DIFFUSEMATERIALSOURCE, 'prism_ff_mat[0]'), Ma = src(RS.AMBIENTMATERIALSOURCE, 'prism_ff_mat[1]'),
        Ms = src(RS.SPECULARMATERIALSOURCE, 'prism_ff_mat[2]'), Me = src(RS.EMISSIVEMATERIALSOURCE, 'prism_ff_mat[3]');
      body.push('  mat4 wv = prism_ff_view * prism_ff_world;', '  vec3 P = (wv * vec4(prism_a_position0.xyz, 1.0)).xyz;',
        `  vec3 N = ${has('normal') ? 'transpose(inverse(mat3(wv))) * prism_a_normal0.xyz' : 'vec3(0.0)'};${rs.get(RS.NORMALIZENORMALS) && has('normal') ? ' N = normalize(N);' : ''}`,
        '  vec3 dif = vec3(0.0), spe = vec3(0.0), amb = prism_ff_ambient.rgb;', '  vec3 L; float att, spot;');
      on.forEach((l, i) => {
        const b = i * 8, at = (k) => `prism_ff_light[${b + k}]`;
        body.push('  {');
        if (l.type === 3) body.push(`    L = normalize(-(mat3(prism_ff_view) * ${at(5)}.xyz)); att = 1.0; spot = 1.0;`);
        else {
          body.push(`    vec3 lv = (prism_ff_view * vec4(${at(4)}.xyz, 1.0)).xyz - P; float d = length(lv); L = lv / d;`,
            `    att = d > ${at(0)}.y ? 0.0 : 1.0 / (${at(6)}.x + ${at(6)}.y * d + ${at(6)}.z * d * d);`);
          // a spot: full inside theta/2, none outside phi/2, and between them ((rho - cos phi/2) / (cos theta/2 - cos phi/2))^falloff
          if (l.type === 2) body.push(`    float rho = dot(normalize(mat3(prism_ff_view) * ${at(5)}.xyz), -L);`,
            `    spot = rho > ${at(7)}.x ? 1.0 : rho <= ${at(7)}.y ? 0.0 : pow((rho - ${at(7)}.y) / (${at(7)}.x - ${at(7)}.y), ${at(0)}.z);`);
          else body.push('    spot = 1.0;');
        }
        body.push(`    float nl = dot(N, L);`, `    amb += ${at(3)}.rgb * att * spot;`, `    dif += ${at(1)}.rgb * max(nl, 0.0) * att * spot;`);
        if (rs.get(RS.SPECULARENABLE)) {
          // the viewer: towards the camera, at the origin, or at infinity behind it (-z: the camera looks down +z), as Wine and DXVK both have it
          body.push(`    vec3 H = normalize(L + ${rs.get(RS.LOCALVIEWER) ? 'normalize(-P)' : 'vec3(0.0, 0.0, -1.0)'});`,
            `    if (nl > 0.0) spe += ${at(2)}.rgb * pow(max(dot(N, H), 0.0), prism_ff_mat[4].x) * att * spot;`);
        }
        body.push('  }');
      });
      body.push(`  prism_col0 = vec4(clamp(${Me}.rgb + ${Ma}.rgb * amb + ${Md}.rgb * dif, 0.0, 1.0), ${Md}.a);`,
        `  prism_col1 = vec4(clamp(${Ms}.rgb * spe, 0.0, 1.0), 0.0);`);
    } else body.push('  prism_col0 = prism_a_color0;', '  prism_col1 = prism_a_color1;');
    const glsl = ['#version 300 es', 'precision highp float;', ...ins.map((n) => `in vec4 prism_a_${n};`),
      'uniform mat4 prism_ff_world, prism_ff_view, prism_ff_proj;', 'uniform vec4 prism_posFix;', 'uniform vec4 prism_ff_mat[5];', 'uniform vec4 prism_ff_ambient;',
      ...(on.length ? [`uniform vec4 prism_ff_light[${on.length * 8}];`] : []), ...outs.map((x) => `out vec4 ${x.name};`),
      'void main() {', '  vec4 p = prism_ff_proj * (prism_ff_view * (prism_ff_world * vec4(prism_a_position0.xyz, 1.0)));',
      '  gl_Position = vec4(p.xy * prism_posFix.xy + prism_posFix.zw * p.w, p.z * 2.0 - p.w, p.w);',
      ...body, ...tcs.map((k) => `  prism_t${k} = prism_a_texcoord${k};`), '}', ''].join('\n');
    o = { kind: 'vertex', ffp: true, lights: on, glsl, samplers: [], outputs: outs, inputs: [] };
    ffCache.set(`v${sig}`, o);
    return o;
  }
  // Its pixel stage: stage 0 as D3D9 sets it by default (its texture times the diffuse colour, the texture's
  // alpha), or the diffuse colour where no texture is bound; the specular colour added after, when enabled.
  // Any other stage setting is refused by name.
  function ffPixel() {
    const t0 = tss[0], tex = !!textures[0];
    const def = [TSS.COLOROP, TSS.COLORARG1, TSS.COLORARG2, TSS.ALPHAOP, TSS.ALPHAARG1, TSS.ALPHAARG2].every((t) => t0.get(t) === tssDefault(0)[t]);
    if (!def && !(t0.get(TSS.COLOROP) === 1)) fail(`texture stage 0 without a pixel shader: COLOROP ${t0.get(TSS.COLOROP)} ALPHAOP ${t0.get(TSS.ALPHAOP)} (args ${t0.get(TSS.COLORARG1)}, ${t0.get(TSS.COLORARG2)}): only the default stage is supported yet`);
    if (tss[1].get(TSS.COLOROP) !== 1) fail('texture stage 1 without a pixel shader is not supported yet');
    const textured = tex && t0.get(TSS.COLOROP) !== 1, spec = !!rs.get(RS.SPECULARENABLE);
    const sig = `p${textured ? 't' : ''}${spec ? 's' : ''}`;
    let o = ffCache.get(sig);
    if (o) return o;
    const inputs = [{ semantic: 'COLOR', index: 0, name: 'prism_col0' }, ...(spec ? [{ semantic: 'COLOR', index: 1, name: 'prism_col1' }] : []),
      ...(textured ? [{ semantic: 'TEXCOORD', index: 0, name: 'prism_t0' }] : [])];
    const glsl = ['#version 300 es', 'precision highp float;', ...inputs.map((i) => `in vec4 ${i.name};`), ...(textured ? ['uniform highp sampler2D prism_s0;'] : []),
      'layout(location = 0) out vec4 prism_o0;', 'void main() {',
      textured ? '  vec4 t = texture(prism_s0, prism_t0.xy);\n  vec4 c = vec4(t.rgb * prism_col0.rgb, t.a);' : '  vec4 c = prism_col0;',
      ...(spec ? ['  c.rgb = min(c.rgb + prism_col1.rgb, 1.0);'] : []), '  prism_o0 = c;', '}', ''].join('\n');
    o = { kind: 'pixel', ffp: true, sh: compile(g.FRAGMENT_SHADER, glsl, 'the fixed function\'s pixel stage'), glsl, inputs,
      samplers: textured ? [{ name: 'texture0', index: 0, dim: '2D' }] : [], outputs: [{ semantic: 'COLOR', index: 0 }] };
    ffCache.set(sig, o);
    return o;
  }
  function ffUniforms(p, vsObj) {
    g.uniformMatrix4fv(p.ff.world, false, transform(256)); g.uniformMatrix4fv(p.ff.view, false, transform(2)); g.uniformMatrix4fv(p.ff.proj, false, transform(3));
    if (p.ff.mat) g.uniform4fv(p.ff.mat, [...material.diffuse, ...material.ambient, ...material.specular, ...material.emissive, material.power, 0, 0, 0]);
    if (p.ff.ambient) { const a = rs.get(RS.AMBIENT) >>> 0; g.uniform4f(p.ff.ambient, ((a >> 16) & 255) / 255, ((a >> 8) & 255) / 255, (a & 255) / 255, (a >>> 24) / 255); }
    if (p.ff.light && vsObj.lights.length) {
      const v = new Float32Array(vsObj.lights.length * 32);
      vsObj.lights.forEach((l, i) => v.set([l.type, l.range ?? 0, l.falloff ?? 0, 0, ...l.diffuse, ...l.specular, ...l.ambient, ...l.position, 1, ...l.direction, 0,
        ...l.attenuation, 0, Math.cos((l.theta ?? 0) / 2), Math.cos((l.phi ?? 0) / 2), 0, 0], i * 32));
      g.uniform4fv(p.ff.light, v);
    }
  }
  const shaderIds = new WeakMap(); let shaderSeq = 0;
  const objectsKey = (o) => { if (!shaderIds.has(o)) shaderIds.set(o, ++shaderSeq); return shaderIds.get(o); };

  // ---- draw state onto GL ----
  const CMP = (v) => 0x200 + (v - 1);
  const BLEND = { 1: 'ZERO', 2: 'ONE', 3: 'SRC_COLOR', 4: 'ONE_MINUS_SRC_COLOR', 5: 'SRC_ALPHA', 6: 'ONE_MINUS_SRC_ALPHA', 7: 'DST_ALPHA', 8: 'ONE_MINUS_DST_ALPHA',
    9: 'DST_COLOR', 10: 'ONE_MINUS_DST_COLOR', 11: 'SRC_ALPHA_SATURATE', 14: 'CONSTANT_COLOR', 15: 'ONE_MINUS_CONSTANT_COLOR' };
  const BLENDOP = { 1: 'FUNC_ADD', 2: 'FUNC_SUBTRACT', 3: 'FUNC_REVERSE_SUBTRACT', 4: 'MIN', 5: 'MAX' };
  const blend = (v) => g[BLEND[v] ?? fail(`blend factor ${v}`)];
  const ADDRESS = { 1: 'REPEAT', 2: 'MIRRORED_REPEAT', 3: 'CLAMP_TO_EDGE', 4: 'CLAMP_TO_EDGE' };   // BORDER: see adapt
  const samplerObjs = [];
  function applyState() {
    g.bindFramebuffer(g.FRAMEBUFFER, framebuffer());
    g.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    g.depthRange(viewport.minZ, viewport.maxZ);
    if (rs.get(RS.SCISSORTESTENABLE)) { g.enable(g.SCISSOR_TEST); g.scissor(scissor[0], scissor[1], scissor[2] - scissor[0], scissor[3] - scissor[1]); } else g.disable(g.SCISSOR_TEST);
    const z = rs.get(RS.ZENABLE) && depthSurface;
    if (z) { g.enable(g.DEPTH_TEST); g.depthFunc(CMP(rs.get(RS.ZFUNC))); } else g.disable(g.DEPTH_TEST);
    g.depthMask(!!(z && rs.get(RS.ZWRITEENABLE)));
    // D3D's front faces are clockwise on screen; with D3D's rows kept, GL sees them counter-clockwise
    const cull = rs.get(RS.CULLMODE);
    if (cull === 1) g.disable(g.CULL_FACE); else { g.enable(g.CULL_FACE); g.frontFace(g.CCW); g.cullFace(cull === 3 ? g.BACK : g.FRONT); }
    if (rs.get(RS.ALPHABLENDENABLE)) {
      g.enable(g.BLEND);
      const sep = rs.get(RS.SEPARATEALPHABLENDENABLE);
      g.blendFuncSeparate(blend(rs.get(RS.SRCBLEND)), blend(rs.get(RS.DESTBLEND)), blend(sep ? rs.get(RS.SRCBLENDALPHA) : rs.get(RS.SRCBLEND)), blend(sep ? rs.get(RS.DESTBLENDALPHA) : rs.get(RS.DESTBLEND)));
      g.blendEquationSeparate(g[BLENDOP[rs.get(RS.BLENDOP)]], g[BLENDOP[sep ? rs.get(RS.BLENDOPALPHA) : rs.get(RS.BLENDOP)]]);
      const bf = rs.get(RS.BLENDFACTOR) >>> 0;
      g.blendColor(((bf >> 16) & 255) / 255, ((bf >> 8) & 255) / 255, (bf & 255) / 255, (bf >>> 24) / 255);
    } else g.disable(g.BLEND);
    const cw = rs.get(RS.COLORWRITEENABLE);
    g.colorMask(!!(cw & 1), !!(cw & 2), !!(cw & 4), !!(cw & 8));
    if (rs.get(RS.ALPHATESTENABLE)) fail('D3DRS_ALPHATESTENABLE is not supported yet');
    if (rs.get(RS.STENCILENABLE)) fail('D3DRS_STENCILENABLE is not supported yet');
    if (rs.get(RS.FILLMODE) !== 3) fail(`D3DRS_FILLMODE ${rs.get(RS.FILLMODE)}`);
  }
  function bindSamplers(p) {
    for (const [unit, loc] of p.s) {
      g.activeTexture(g.TEXTURE0 + unit);
      const t = textures[unit] ? get(textures[unit], 'texture') : null;
      g.bindTexture(g.TEXTURE_2D, t ? t.tex : null);
      g.uniform1i(loc, unit);
      const st = samp[unit];
      let so = samplerObjs[unit];
      if (!so) so = samplerObjs[unit] = g.createSampler();
      const addr = (v) => g[ADDRESS[v] ?? fail(`sampler ${unit}: texture address ${v}`)];
      g.samplerParameteri(so, g.TEXTURE_WRAP_S, addr(st[1])); g.samplerParameteri(so, g.TEXTURE_WRAP_T, addr(st[2]));
      const mag = st[5] >= 2 ? g.LINEAR : g.NEAREST, min = st[6] >= 2, mip = st[7];
      const levels = t ? t.levels : 1;
      g.samplerParameteri(so, g.TEXTURE_MAG_FILTER, mag);
      g.samplerParameteri(so, g.TEXTURE_MIN_FILTER, mip === 0 || levels === 1 ? (min ? g.LINEAR : g.NEAREST)
        : min ? (mip >= 2 ? g.LINEAR_MIPMAP_LINEAR : g.LINEAR_MIPMAP_NEAREST) : (mip >= 2 ? g.NEAREST_MIPMAP_LINEAR : g.NEAREST_MIPMAP_NEAREST));
      g.bindSampler(unit, so);
    }
  }

  // ---- D3DXFillTextureTX ----
  // A texture shader (tx_1_0, hlsl.js) run for every texel of every level, its result written in the
  // texture's format. D3DX runs it on the CPU, texel by texel; here each level is one full-screen draw.
  const txVao = g.createVertexArray();
  function fillTextureTX(h, tokens) {
    const t = get(h, 'texture'), b = blobHLSL(tokens);
    if (!b || b.profile !== 'tx_1_0') fail('fillTextureTX takes the blob of a tx_1_0 shader');
    if (/F$/.test(t.f[0]) && !floatRT) fail('filling a float texture without EXT_color_buffer_float');
    const tr = translateHLSL(b.source, b.entry, 'tx_1_0');
    if (tr.samplers.length) fail(`tx_1_0 ${b.entry}: a texture shader that samples a texture is not supported yet`);
    const prog = g.createProgram();
    g.attachShader(prog, compile(g.VERTEX_SHADER, '#version 300 es\nvoid main() { gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0); }\n', 'texture shader stage'));
    g.attachShader(prog, compile(g.FRAGMENT_SHADER, tr.glsl, `tx_1_0 ${b.entry}`));
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) fail(`link: ${g.getProgramInfoLog(prog)}`);
    g.useProgram(prog);
    const size = g.getUniformLocation(prog, 'prism_txSize');
    const fb = g.createFramebuffer();
    g.bindFramebuffer(g.FRAMEBUFFER, fb);
    g.disable(g.SCISSOR_TEST); g.disable(g.DEPTH_TEST); g.disable(g.BLEND); g.disable(g.CULL_FACE); g.colorMask(true, true, true, true);
    g.bindVertexArray(txVao);
    for (const sh of t.surfaces) {
      const sf = get(sh, 'surface');
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, t.tex, sf.level);
      g.drawBuffers([g.COLOR_ATTACHMENT0]);
      const st = g.checkFramebufferStatus(g.FRAMEBUFFER);
      if (st !== g.FRAMEBUFFER_COMPLETE) fail(`fillTextureTX: level ${sf.level} cannot be drawn into (0x${st.toString(16)})`);
      g.viewport(0, 0, sf.w, sf.h);
      g.uniform2f(size, 1 / sf.w, 1 / sf.h);
      g.drawArrays(g.TRIANGLES, 0, 3);
    }
    g.bindVertexArray(null);
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.deleteFramebuffer(fb); g.deleteProgram(prog);
    return OK;
  }

  // ---- drawing ----
  const vbo = g.createBuffer(), ibo = g.createBuffer(), vao = g.createVertexArray();
  const COUNT = { 1: (n) => n, 2: (n) => 2 * n, 3: (n) => n + 1, 4: (n) => 3 * n, 5: (n) => n + 2, 6: (n) => n + 2 };
  const MODE = { 1: 'POINTS', 2: 'LINES', 3: 'LINE_STRIP', 4: 'TRIANGLES', 5: 'TRIANGLE_STRIP', 6: 'TRIANGLE_FAN' };
  // Vertices that are all zero bytes make triangles of no area: D3D draws nothing, so nothing is uploaded.
  // (Photon Race 2 ends each frame with 8192 such draws.)
  const allZero = (b) => { for (let i = 0; i < b.length; i++) if (b[i]) return false; return true; };
  let maxAttrib = 0;
  // A buffer the program fills once and draws often stays in GL; the CPU copy serves LockRect-style reads and
  // the D3DCOLOR swap, which a buffer holding colours still needs per draw.
  function makeBuffer(kind, length) {
    const buf = g.createBuffer(), target = kind === 'ib' ? g.ELEMENT_ARRAY_BUFFER : g.ARRAY_BUFFER;
    g.bindVertexArray(null);
    g.bindBuffer(target, buf); g.bufferData(target, length, g.DYNAMIC_DRAW);
    return { kind, bytes: new Uint8Array(length), buf };
  }
  // v: { bytes } or { buf, base, first }; idx: null, { bytes, fmt } or { buf, offset, fmt }
  function draw(type, primCount, stride, v, idx = null) {
    const L = fvfLayout(fvf);
    if (L.stride !== stride) fail(`stride ${stride} for FVF 0x${fvf.toString(16)} of ${L.stride} bytes`);
    const n = COUNT[type]?.(primCount) ?? fail(`primitive type ${type}`);
    if (v.bytes && type >= 4 && !idx && allZero(v.bytes.subarray(0, n * stride))) return;
    // pretransformed vertices (XYZRHW) skip vertex processing, a vertex shader that is set included (elevated draws
    // its full-screen passes with its terrain's vertex shader still set)
    const pre = L.E.some((e) => e.usage === 'positiont');
    const psObj = ps ? get(ps, 'pixel') : ffPixel(), vsObj = pre ? null : vs ? get(vs, 'vertex') : ffVertex(L);
    applyState();
    // WebGL refuses a draw with a bound target the pixel shader writes nothing to; D3D leaves that target as it was
    g.drawBuffers(fbBufs.get(framebuffer()).map((b, k) => (b !== g.NONE && psObj?.outputs.some((o) => o.semantic === 'COLOR' && o.index === k) ? b : g.NONE)));
    const p = program(vsObj, psObj, L);
    g.useProgram(p.prog);
    if (p.c) g.uniform4fv(p.c, psF);
    if (p.vc) g.uniform4fv(p.vc, vsF);
    if (p.i) g.uniform4iv(p.i, psI);
    if (p.vi) g.uniform4iv(p.vi, vsI);
    if (p.b) g.uniform1iv(p.b, psB);
    if (p.vb) g.uniform1iv(p.vb, vsB);
    // D3D9's clip space to GL's (hlsl.js): the rows kept, so y negated, and pixel centres half a pixel off GL's
    if (p.posFix) g.uniform4f(p.posFix, 1, -1, 1 / viewport.width, 1 / viewport.height);
    if (p.vp) g.uniform4f(p.vp, viewport.x, viewport.y, viewport.width, viewport.height);
    if (p.zr) g.uniform2f(p.zr, viewport.minZ, viewport.maxZ);
    if (p.ff) ffUniforms(p, vsObj);
    bindSamplers(p);
    for (const [unit, loc] of p.bc) { const c = samp[unit][4]; g.uniform4f(loc, ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, (c >>> 24) / 255); }
    g.bindVertexArray(vao);
    let base = 0;
    if (v.bytes) { g.bindBuffer(g.ARRAY_BUFFER, vbo); g.bufferData(g.ARRAY_BUFFER, swizzleColours(v.bytes, stride, L), g.STREAM_DRAW); }
    else { g.bindBuffer(g.ARRAY_BUFFER, v.buf); base = v.base; }
    for (let k = 0; k < maxAttrib; k++) g.disableVertexAttribArray(k);
    maxAttrib = p.attrs.length;
    for (const a of p.attrs) {
      const e = L.E.find((x) => x.usage === a.usage && x.index === a.index);
      // an input no element feeds: D3DCOLOR's defaults for the colours, (0, 0, 0, 1) otherwise
      if (!e) { g.vertexAttrib4f(a.loc, ...(a.usage === 'color' ? (a.index ? [0, 0, 0, 0] : [1, 1, 1, 1]) : [0, 0, 0, 1])); continue; }
      g.enableVertexAttribArray(a.loc);
      g.vertexAttribPointer(a.loc, e.size, e.color ? g.UNSIGNED_BYTE : g.FLOAT, e.color, stride, base + e.off);
    }
    if (idx) {
      if (idx.bytes) { g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ibo); g.bufferData(g.ELEMENT_ARRAY_BUFFER, idx.bytes, g.STREAM_DRAW); } else g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, idx.buf);
      g.drawElements(g[MODE[type]], n, idx.fmt === 102 ? g.UNSIGNED_INT : g.UNSIGNED_SHORT, idx.offset ?? 0);
    } else g.drawArrays(g[MODE[type]], v.first ?? 0, n);
    g.bindVertexArray(null);
  }
  // D3DCOLOR's B,G,R,A bytes as GL's R,G,B,A: swapped in a copy of the vertices.
  function swizzleColours(bytes, stride, L) {
    if (!L.colors.length) return bytes;
    const b = new Uint8Array(bytes);
    for (let o = 0; o + stride <= b.length; o += stride) for (const off of L.colors) { const t = b[o + off]; b[o + off] = b[o + off + 2]; b[o + off + 2] = t; }
    return b;
  }

  // ---- texel uploads: D3D's bytes as GL's ----
  function texels(f, bytes, w, h, pitch) {
    const bpp = f[3], row = w * bpp;
    const out = f[4] === 'copy' ? (f[2] === 'FLOAT' ? new Float32Array(w * h * bpp / 4) : new Uint16Array(w * h * bpp / 2)) : new Uint8Array(w * h * bpp);
    const dst = new Uint8Array(out.buffer);
    for (let y = 0; y < h; y++) {
      const src = bytes.subarray(y * pitch, y * pitch + row);
      if (f[4] === 'copy' || f[4] === 'rgba' || f[4] === 'l8' || f[4] === 'a8') { dst.set(src, y * row); continue; }
      for (let x = 0; x < w; x++) {
        const i = x * 4, o = y * row + i;
        dst[o] = src[i + 2]; dst[o + 1] = src[i + 1]; dst[o + 2] = src[i]; dst[o + 3] = f[4] === 'bgrx' ? 255 : src[i + 3];
      }
    }
    return out;
  }

  const dev = {
    // frame
    beginScene: () => { if (inScene) return D3DERR_INVALIDCALL; inScene = true; return OK; },
    endScene: () => { if (!inScene) return D3DERR_INVALIDCALL; inScene = false; return OK; },
    present: () => {
      const s = get(backBuffer, 'surface');
      const fb = fbos.get(`${backBuffer},0,0,0/0`) ?? (() => { const save = [rt, depthSurface]; rt = [backBuffer, 0, 0, 0]; depthSurface = 0; const f = framebuffer(); [rt, depthSurface] = save; return f; })();
      g.bindFramebuffer(g.READ_FRAMEBUFFER, fb);
      g.bindFramebuffer(g.DRAW_FRAMEBUFFER, null);
      g.disable(g.SCISSOR_TEST);
      g.blitFramebuffer(0, 0, s.w, s.h, 0, g.drawingBufferHeight, g.drawingBufferWidth, 0, g.COLOR_BUFFER_BIT, g.LINEAR);   // D3D's rows to the canvas's
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      if (FMT[s.format]?.[4] === 'bgrx') {
        // X8R8G8B8's X is not alpha: what the shaders left there must not make the canvas translucent
        g.colorMask(false, false, false, true); g.clearColor(0, 0, 0, 1); g.clear(g.COLOR_BUFFER_BIT);
        g.colorMask(true, true, true, true);
      }
      onPresent();
      return OK;
    },
    clear: (rects, flags, argb, z, stencil) => {
      const fb = framebuffer();
      g.bindFramebuffer(g.FRAMEBUFFER, fb);
      g.drawBuffers(fbBufs.get(fb));                         // a draw may have narrowed them
      g.enable(g.SCISSOR_TEST);
      g.colorMask(true, true, true, true); g.depthMask(true); g.stencilMask(0xff);
      g.clearColor(((argb >> 16) & 255) / 255, ((argb >> 8) & 255) / 255, (argb & 255) / 255, (argb >>> 24) / 255);
      g.clearDepth(z); g.clearStencil(stencil);
      const mask = (flags & 1 ? g.COLOR_BUFFER_BIT : 0) | (flags & 2 && depthSurface ? g.DEPTH_BUFFER_BIT : 0) | (flags & 4 && depthSurface ? g.STENCIL_BUFFER_BIT : 0);
      const v = viewport;
      for (const r of rects?.length ? rects : [[v.x, v.y, v.x + v.width, v.y + v.height]]) {
        const x0 = Math.max(r[0], v.x), y0 = Math.max(r[1], v.y), x1 = Math.min(r[2], v.x + v.width), y1 = Math.min(r[3], v.y + v.height);
        if (x1 <= x0 || y1 <= y0) continue;
        g.scissor(x0, y0, x1 - x0, y1 - y0);
        g.clear(mask);
      }
      return OK;
    },
    reset: () => fail('Reset is not supported yet'),

    // state
    setRenderState: (state, value) => { rs.set(state, value >>> 0); return OK; },
    getRenderState: (state) => rs.get(state) ?? 0,
    setSamplerState: (s, type, value) => { samp[slot(s)][type] = value >>> 0; return OK; },
    getSamplerState: (s, type) => samp[slot(s)][type],
    setTextureStageState: (stage, type, value) => { if (stage < 8) tss[stage].set(type, value >>> 0); return OK; },
    getTextureStageState: (stage, type) => tss[stage]?.get(type) ?? 0,
    // a D3D matrix, row-major as D3DMATRIX lays it out; D3DTS_WORLD is 256
    setTransform: (state, m) => { transforms.set(state, Float32Array.from(m)); return OK; },
    getTransform: (state) => Float32Array.from(transform(state)),
    // D3DLIGHT9 as { type (1 point, 2 spot, 3 directional), diffuse, specular, ambient: [r,g,b,a], position, direction: [x,y,z], range, falloff, attenuation: [3], theta, phi }
    setLight: (i, l) => { lights.set(i, { ...l }); return OK; },
    getLight: (i) => lights.get(i) ?? fail(`light ${i} was never set`),
    lightEnable: (i, on) => {
      if (on && !lights.has(i)) lights.set(i, { type: 3, diffuse: [1, 1, 1, 0], specular: [0, 0, 0, 0], ambient: [0, 0, 0, 0], position: [0, 0, 0], direction: [0, 0, 1], range: 0, falloff: 0, attenuation: [0, 0, 0], theta: 0, phi: 0 });
      if (on) lightOn.add(i); else lightOn.delete(i);
      return OK;
    },
    getLightEnable: (i) => lightOn.has(i),
    // D3DMATERIAL9 as { diffuse, ambient, specular, emissive: [r,g,b,a], power }
    setMaterial: (m) => { material = { ...m }; return OK; },
    getMaterial: () => ({ ...material }),
    setViewport: (v) => { viewport = { ...v }; return OK; },
    getViewport: () => ({ ...viewport }),
    setScissorRect: (x1, y1, x2, y2) => { scissor = [x1, y1, x2, y2]; return OK; },

    // shaders
    createVertexShader: (tokens) => add(makeShader(tokens, 'vertex')),
    createPixelShader: (tokens) => add(makeShader(tokens, 'pixel')),
    setVertexShader: (h) => { vs = h; return OK; },
    setPixelShader: (h) => { if (h) get(h, 'pixel'); ps = h; return OK; },
    getVertexShader: () => vs,
    getPixelShader: () => ps,
    setVertexShaderConstantF: (start, v) => { vsF.set(v.subarray(0, Math.min(v.length, vsF.length - 4 * start)), 4 * start); return OK; },
    setPixelShaderConstantF: (start, v) => { psF.set(v.subarray(0, Math.min(v.length, psF.length - 4 * start)), 4 * start); return OK; },
    setVertexShaderConstantI: (start, v) => { vsI.set(v.subarray(0, Math.min(v.length, vsI.length - 4 * start)), 4 * start); return OK; },
    setPixelShaderConstantI: (start, v) => { psI.set(v.subarray(0, Math.min(v.length, psI.length - 4 * start)), 4 * start); return OK; },
    setVertexShaderConstantB: (start, v) => { vsB.set(v.subarray(0, Math.min(v.length, vsB.length - start)), start); return OK; },
    setPixelShaderConstantB: (start, v) => { psB.set(v.subarray(0, Math.min(v.length, psB.length - start)), start); return OK; },

    // vertex input
    setFVF: (f) => { fvf = f >>> 0; decl = 0; return OK; },
    getFVF: () => fvf,
    createVertexDeclaration: () => fail('vertex declarations are not supported yet'),
    setVertexDeclaration: (h) => { if (h) fail('vertex declarations are not supported yet'); decl = 0; return OK; },

    // buffers
    createVertexBuffer: (length) => add(makeBuffer('vb', length)),
    createIndexBuffer: (length, usage, format) => add({ ...makeBuffer('ib', length), format }),
    bufferWrite: (h, offset, bytes) => {
      const b = objects.get(h);
      b.bytes.set(bytes, offset);
      g.bindVertexArray(null);
      const target = b.kind === 'ib' ? g.ELEMENT_ARRAY_BUFFER : g.ARRAY_BUFFER;
      g.bindBuffer(target, b.buf); g.bufferSubData(target, offset, bytes);
      return OK;
    },
    setStreamSource: (stream, h, offset, stride) => { streams[stream] = { vb: h, offset, stride }; return OK; },
    setIndices: (h) => { indices = h; return OK; },

    // draws
    drawPrimitiveUP: (type, primCount, bytes, stride) => { draw(type, primCount, stride, { bytes }); return OK; },
    drawIndexedPrimitiveUP: (type, minIndex, numVertices, primCount, indexBytes, indexFmt, bytes, stride) => {
      draw(type, primCount, stride, { bytes }, { bytes: indexBytes, fmt: indexFmt }); return OK;
    },
    // from the buffers in GL; a vertex buffer holding D3DCOLORs goes up from its CPU copy, swapped
    drawPrimitive: (type, start, primCount) => {
      const s = streams[0], b = get(s.vb, 'vb');
      if (fvfLayout(fvf).colors.length) draw(type, primCount, s.stride, { bytes: b.bytes.subarray(s.offset + start * s.stride, s.offset + (start + COUNT[type](primCount)) * s.stride) });
      else draw(type, primCount, s.stride, { buf: b.buf, base: s.offset, first: start });
      return OK;
    },
    drawIndexedPrimitive: (type, baseVertex, minIndex, numVertices, startIndex, primCount) => {
      const s = streams[0], b = get(s.vb, 'vb'), ib = get(indices, 'ib');
      const size = ib.format === 102 ? 4 : 2;
      if (fvfLayout(fvf).colors.length) draw(type, primCount, s.stride, { bytes: b.bytes.subarray(s.offset + baseVertex * s.stride) }, { bytes: ib.bytes.slice(startIndex * size, (startIndex + COUNT[type](primCount)) * size), fmt: ib.format });
      else draw(type, primCount, s.stride, { buf: b.buf, base: s.offset + baseVertex * s.stride }, { buf: ib.buf, offset: startIndex * size, fmt: ib.format });
      return OK;
    },

    // textures and surfaces
    createTexture: (w, h, levels, usage, format) => add(makeTexture(w, h, levels, usage, format)),
    // D3DXFillTextureTX(texture, a tx_1_0 shader): the host's d3dx9 hands over the blob D3DXCompileShader made
    fillTextureTX,
    textureWrite: (h, level, rect, bytes, pitch) => {
      const t = get(h, 'texture'), s = get(t.surfaces[level], 'surface');
      if (rect) fail('a partial texture write is not supported yet');
      g.bindTexture(g.TEXTURE_2D, t.tex);
      g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
      g.texSubImage2D(g.TEXTURE_2D, level, 0, 0, s.w, s.h, g[t.f[1]], g[t.f[2]], texels(t.f, bytes, s.w, s.h, pitch));
      if (level === 0 && (t.usage & USAGE_AUTOGENMIPMAP)) g.generateMipmap(g.TEXTURE_2D);
      return OK;
    },
    setTexture: (s, h) => { textures[slot(s)] = h; return OK; },
    getTexture: (s) => textures[slot(s)],
    getSurfaceLevel: (h, level) => get(h, 'texture').surfaces[level] ?? fail(`level ${level}`),
    getLevelCount: (h) => get(h, 'texture').levels,
    getLevelDesc: (h, level) => { const s = get(get(h, 'texture').surfaces[level], 'surface'); return { width: s.w, height: s.h, format: s.format }; },
    getBackBuffer: () => backBuffer,
    getRenderTarget: (i) => rt[i],
    setRenderTarget: (i, h) => {
      if (h) get(h, 'surface');
      rt[i] = h;
      if (i === 0) { const s = get(h, 'surface'); viewport = { x: 0, y: 0, width: s.w, height: s.h, minZ: 0, maxZ: 1 }; scissor = [0, 0, s.w, s.h]; }   // as D3D9 resets them
      return OK;
    },
    getDepthStencilSurface: () => depthSurface,
    setDepthStencilSurface: (h) => { depthSurface = h; return OK; },
    createDepthStencilSurface: (w, h) => add(makeDepth(w, h)),
    createRenderTarget: (w, h, format) => makeTexture(w, h, 1, USAGE_RENDERTARGET, format).surfaces[0],
    getSurfaceDesc: (h) => { const s = get(h, 'surface'); return { width: s.w, height: s.h, format: s.format ?? 75 }; },
    stretchRect: (src, srcRect, dst, dstRect, filter) => {
      const a = get(src, 'surface'), b = get(dst, 'surface');
      const save = [rt, depthSurface];
      rt = [src, 0, 0, 0]; depthSurface = 0; const fa = framebuffer();
      rt = [dst, 0, 0, 0]; const fb = framebuffer();
      [rt, depthSurface] = save;
      const r = srcRect ?? [0, 0, a.w, a.h], d = dstRect ?? [0, 0, b.w, b.h];
      g.bindFramebuffer(g.READ_FRAMEBUFFER, fa); g.bindFramebuffer(g.DRAW_FRAMEBUFFER, fb);
      g.disable(g.SCISSOR_TEST);
      g.blitFramebuffer(r[0], r[1], r[2], r[3], d[0], d[1], d[2], d[3], g.COLOR_BUFFER_BIT, filter === 2 ? g.LINEAR : g.NEAREST);
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      return OK;
    },
    // LockRect of a render target: its texels in D3D's layout for its format, row 0 (the top) first
    surfaceRead: (h) => {
      const sf = get(h, 'surface');
      if (!sf.tex) fail('reading a depth surface back is not supported');
      const f = sf.tex.f, w = sf.w, ht = sf.h;
      const save = [rt, depthSurface]; rt = [h, 0, 0, 0]; depthSurface = 0; const fb = framebuffer(); [rt, depthSurface] = save;
      g.bindFramebuffer(g.READ_FRAMEBUFFER, fb); g.readBuffer(g.COLOR_ATTACHMENT0);
      const isFloat = f[2] !== 'UNSIGNED_BYTE';
      const px = isFloat ? new Float32Array(w * ht * 4) : new Uint8Array(w * ht * 4);
      g.readPixels(0, 0, w, ht, g.RGBA, isFloat ? g.FLOAT : g.UNSIGNED_BYTE, px);
      g.bindFramebuffer(g.READ_FRAMEBUFFER, null);
      const comps = { RGBA: 4, RG: 2, RED: 1 }[f[1]], pitch = w * f[3], out = new Uint8Array(pitch * ht), dv = new DataView(out.buffer);
      for (let i = 0; i < w * ht; i++) {
        if (!isFloat) {
          if (f[4] === 'bgra' || f[4] === 'bgrx') { out[4 * i] = px[4 * i + 2]; out[4 * i + 1] = px[4 * i + 1]; out[4 * i + 2] = px[4 * i]; out[4 * i + 3] = f[4] === 'bgrx' ? 255 : px[4 * i + 3]; }
          else for (let c = 0; c < comps; c++) out[comps * i + c] = px[4 * i + c];
        } else if (f[2] === 'FLOAT') for (let c = 0; c < comps; c++) dv.setFloat32((comps * i + c) * 4, px[4 * i + c], true);
        else for (let c = 0; c < comps; c++) dv.setUint16((comps * i + c) * 2, half(px[4 * i + c]), true);
      }
      return { bytes: out, pitch };
    },
    release: (h) => {
      const o = objects.get(h);
      if (!o) return OK;
      if (o.kind === 'texture') { g.deleteTexture(o.tex); for (const s of o.surfaces) objects.delete(s); }
      else if ((o.kind === 'vertex' || o.kind === 'pixel') && o.sh) g.deleteShader(o.sh);
      else if (o.kind === 'surface' && o.depth) { g.deleteRenderbuffer(o.depth); for (const rb of o.sized.values()) g.deleteRenderbuffer(rb); }
      objects.delete(h);
      for (const [k, fb] of fbos) if (k.split(/[,/]/).includes(String(h))) { g.deleteFramebuffer(fb); fbos.delete(k); }
      return OK;
    },
  };
  void decl;
  return dev;
}
