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
const DEPTH_FMT = new Set([70, 71, 75, 77, 79, 80, 82, 83]);   // D15S1 D32 D24S8 D24X8 D24X4S4 D16 D32F_LOCKABLE D24FS8
const USAGE_RENDERTARGET = 1, USAGE_DEPTHSTENCIL = 2, USAGE_AUTOGENMIPMAP = 0x400;

// Render states (D3DRENDERSTATETYPE) and their defaults; the device's auto depth buffer sets ZENABLE.
const RS = { ZENABLE: 7, FILLMODE: 8, SHADEMODE: 9, ZWRITEENABLE: 14, ALPHATESTENABLE: 15, SRCBLEND: 19, DESTBLEND: 20, CULLMODE: 22, ZFUNC: 23,
  ALPHAREF: 24, ALPHAFUNC: 25, DITHERENABLE: 26, ALPHABLENDENABLE: 27, FOGENABLE: 28, SPECULARENABLE: 29, STENCILENABLE: 52, STENCILFAIL: 53, STENCILZFAIL: 54,
  STENCILPASS: 55, STENCILFUNC: 56, STENCILREF: 57, STENCILMASK: 58, STENCILWRITEMASK: 59, TEXTUREFACTOR: 60, LIGHTING: 137, COLORWRITEENABLE: 168,
  BLENDOP: 171, SCISSORTESTENABLE: 174, SLOPESCALEDEPTHBIAS: 175, SRGBWRITEENABLE: 194, DEPTHBIAS: 195, SEPARATEALPHABLENDENABLE: 206,
  SRCBLENDALPHA: 207, DESTBLENDALPHA: 208, BLENDOPALPHA: 209, BLENDFACTOR: 193, POINTSIZE: 154 };
const RS_DEFAULT = { [RS.FILLMODE]: 3, [RS.SHADEMODE]: 2, [RS.ZWRITEENABLE]: 1, [RS.SRCBLEND]: 2, [RS.DESTBLEND]: 1, [RS.CULLMODE]: 3, [RS.ZFUNC]: 4,
  [RS.ALPHAFUNC]: 8, [RS.DITHERENABLE]: 0, [RS.STENCILFAIL]: 1, [RS.STENCILZFAIL]: 1, [RS.STENCILPASS]: 1, [RS.STENCILFUNC]: 8, [RS.STENCILMASK]: 0xffffffff,
  [RS.STENCILWRITEMASK]: 0xffffffff, [RS.TEXTUREFACTOR]: 0xffffffff, [RS.LIGHTING]: 1, [RS.COLORWRITEENABLE]: 0xf, [RS.BLENDOP]: 1, [RS.SRCBLENDALPHA]: 2,
  [RS.DESTBLENDALPHA]: 1, [RS.BLENDOPALPHA]: 1, [RS.BLENDFACTOR]: 0xffffffff };
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
  const samp = Array.from({ length: 16 }, () => SAMP_DEFAULT.slice());
  const textures = new Array(16).fill(0);
  const vsF = new Float32Array(256 * 4), psF = new Float32Array(224 * 4);
  let rt = [backBuffer, 0, 0, 0], depthSurface = autoDepth;
  let viewport = { x: 0, y: 0, width: W, height: H, minZ: 0, maxZ: 1 }, scissor = [0, 0, W, H];
  let fvf = 0, decl = 0, vs = 0, ps = 0, inScene = false;
  const streams = Array.from({ length: 16 }, () => ({ vb: 0, offset: 0, stride: 0 }));
  let indices = 0;

  // ---- shaders ----
  function makeShader(tokens, type) {
    const h = blobHLSL(tokens);
    if (!h) fail(`${type} shader bytecode (version 0x${(tokens[0] >>> 0).toString(16)}) is not supported yet, only the HLSL blob`);
    if ((h.profile[0] === 'p') !== (type === 'pixel')) fail(`a ${h.profile} blob given as a ${type} shader`);
    const t = translateHLSL(h.source, h.entry, h.profile);
    const sh = g.createShader(type === 'pixel' ? g.FRAGMENT_SHADER : g.VERTEX_SHADER);
    g.shaderSource(sh, t.glsl); g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) fail(`${h.profile} ${h.entry}: ${g.getShaderInfoLog(sh)}\n${t.glsl}`);
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
  // A sampler at D3DTADDRESS_BORDER, which WebGL lacks: its reads in the pixel shader go through a
  // function that returns the border colour outside [0, 1] on that axis (the GL sampler clamps). Exact
  // with point filtering; with linear, D3D also blends the border into the outermost half texel.
  const BORDER = 4;
  function withBorders(glsl, mask) {
    for (const [unit, u, v] of mask) {
      const out = [u && 'uv.x < 0.0 || uv.x > 1.0', v && 'uv.y < 0.0 || uv.y > 1.0'].filter(Boolean).join(' || ');
      const fn = (name, args, call) => `vec4 ${name}${unit}(${args}) { vec4 c = ${call}; return (${out}) ? prism_bc${unit} : c; }`;
      const s = `prism_s${unit}`;
      // the reads first, then the functions (whose own reads must stay plain) after the sampler's declaration
      for (const [call, name] of [['texture', 'bt'], ['textureLod', 'btl'], ['textureGrad', 'btg'], ['textureProj', 'btp']]) glsl = glsl.replace(new RegExp(`\\b${call}\\(${s}, `, 'g'), `prism_${name}${unit}(`);
      glsl = glsl.replace(`uniform highp sampler2D ${s};`, (d) => [d, `uniform vec4 prism_bc${unit};`,
        fn('prism_bt', 'vec2 uv', `texture(${s}, uv)`), fn('prism_bt', 'vec2 uv, float bias', `texture(${s}, uv, bias)`),
        fn('prism_btl', 'vec2 uv, float lod', `textureLod(${s}, uv, lod)`), fn('prism_btg', 'vec2 uv, vec2 dx, vec2 dy', `textureGrad(${s}, uv, dx, dy)`),
        `vec4 prism_btp${unit}(vec3 q) { return prism_bt${unit}(q.xy / q.z); }`, `vec4 prism_btp${unit}(vec4 q) { return prism_bt${unit}(q.xy / q.w); }`].join('\n'));
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
    if (!psObj) fail('drawing without a pixel shader (the fixed function\'s texture stages) is not supported yet');
    const mask = psObj.samplers.filter((s) => s.dim === '2D' && (samp[s.index][1] === BORDER || samp[s.index][2] === BORDER))
      .map((s) => [s.index, samp[s.index][1] === BORDER, samp[s.index][2] === BORDER]);
    const key = `${vsObj ? objectsKey(vsObj) : `t${fvf}`}|${objectsKey(psObj)}|${mask.join(';')}`;
    let p = programs.get(key);
    if (p) return p;
    let vsrc;
    if (vsObj) {
      // the vertex shader's register file apart from the pixel shader's; what the pixel shader reads and it does not write, zero
      if (vsObj.samplers.length) fail('a vertex shader sampling a texture is not supported yet');
      const missing = psObj.inputs.filter((i) => !vsObj.outputs.some((o) => o.name === i.name));
      vsrc = vsObj.glsl.replace(/\bprism_c\b/g, 'prism_vc')
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
    g.attachShader(prog, compile(g.VERTEX_SHADER, vsrc, vsObj ? 'vertex shader' : 'pretransformed vertex stage'));
    g.attachShader(prog, mask.length ? compile(g.FRAGMENT_SHADER, withBorders(psObj.glsl, mask), 'pixel shader with border addressing') : psObj.sh);
    // attributes by semantic: prism_a_<usage><index>, matched to the vertex elements at each draw
    const attrs = [...vsrc.matchAll(/^in vec4 prism_a_([a-z]+?)(\d+);$/gm)].map((m, loc) => ({ loc, usage: m[1], index: +m[2] }));
    for (const a of attrs) g.bindAttribLocation(prog, a.loc, `prism_a_${a.usage}${a.index}`);
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) fail(`link: ${g.getProgramInfoLog(prog)}`);
    const u = (n) => g.getUniformLocation(prog, n);
    p = { prog, attrs, c: u('prism_c'), vc: u('prism_vc'), posFix: u('prism_posFix'), vp: u('u_vp'), zr: u('u_zr'),
      s: psObj.samplers.map((sm) => [sm.index, u(`prism_s${sm.index}`)]), bc: mask.map(([unit]) => [unit, u(`prism_bc${unit}`)]) };
    programs.set(key, p);
    return p;
  }
  const shaderIds = new WeakMap(); let shaderSeq = 0;
  const objectsKey = (o) => { if (!shaderIds.has(o)) shaderIds.set(o, ++shaderSeq); return shaderIds.get(o); };

  // ---- draw state onto GL ----
  const CMP = (v) => 0x200 + (v - 1);
  const BLEND = { 1: 'ZERO', 2: 'ONE', 3: 'SRC_COLOR', 4: 'ONE_MINUS_SRC_COLOR', 5: 'SRC_ALPHA', 6: 'ONE_MINUS_SRC_ALPHA', 7: 'DST_ALPHA', 8: 'ONE_MINUS_DST_ALPHA',
    9: 'DST_COLOR', 10: 'ONE_MINUS_DST_COLOR', 11: 'SRC_ALPHA_SATURATE', 14: 'CONSTANT_COLOR', 15: 'ONE_MINUS_CONSTANT_COLOR' };
  const BLENDOP = { 1: 'FUNC_ADD', 2: 'FUNC_SUBTRACT', 3: 'FUNC_REVERSE_SUBTRACT', 4: 'MIN', 5: 'MAX' };
  const blend = (v) => g[BLEND[v] ?? fail(`blend factor ${v}`)];
  const ADDRESS = { 1: 'REPEAT', 2: 'MIRRORED_REPEAT', 3: 'CLAMP_TO_EDGE', 4: 'CLAMP_TO_EDGE' };   // BORDER: see withBorders
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

  // ---- drawing ----
  const vbo = g.createBuffer(), ibo = g.createBuffer(), vao = g.createVertexArray();
  const COUNT = { 1: (n) => n, 2: (n) => 2 * n, 3: (n) => n + 1, 4: (n) => 3 * n, 5: (n) => n + 2, 6: (n) => n + 2 };
  const MODE = { 1: 'POINTS', 2: 'LINES', 3: 'LINE_STRIP', 4: 'TRIANGLES', 5: 'TRIANGLE_STRIP', 6: 'TRIANGLE_FAN' };
  // Vertices that are all zero bytes make triangles of no area: D3D draws nothing, so nothing is uploaded.
  // (Photon Race 2 ends each frame with 8192 such draws.)
  const allZero = (b) => { for (let i = 0; i < b.length; i++) if (b[i]) return false; return true; };
  let maxAttrib = 0;
  function drawUP(type, primCount, bytes, stride, indexBytes = null, indexFmt = 0) {
    const L = fvfLayout(fvf);
    if (L.stride !== stride) fail(`stride ${stride} for FVF 0x${fvf.toString(16)} of ${L.stride} bytes`);
    const n = COUNT[type]?.(primCount) ?? fail(`primitive type ${type}`);
    if (type >= 4 && !indexBytes && allZero(bytes.subarray(0, n * stride))) return;
    bytes = swizzleColours(bytes, stride, L);
    const vsObj = vs ? get(vs, 'vertex') : null, psObj = ps ? get(ps, 'pixel') : null;
    applyState();
    // WebGL refuses a draw with a bound target the pixel shader writes nothing to; D3D leaves that target as it was
    g.drawBuffers(fbBufs.get(framebuffer()).map((b, k) => (b !== g.NONE && psObj?.outputs.some((o) => o.semantic === 'COLOR' && o.index === k) ? b : g.NONE)));
    const p = program(vsObj, psObj, L);
    g.useProgram(p.prog);
    if (p.c) g.uniform4fv(p.c, psF);
    if (p.vc) g.uniform4fv(p.vc, vsF);
    // D3D9's clip space to GL's (hlsl.js): the rows kept, so y negated, and pixel centres half a pixel off GL's
    if (p.posFix) g.uniform4f(p.posFix, 1, -1, 1 / viewport.width, 1 / viewport.height);
    if (p.vp) g.uniform4f(p.vp, viewport.x, viewport.y, viewport.width, viewport.height);
    if (p.zr) g.uniform2f(p.zr, viewport.minZ, viewport.maxZ);
    bindSamplers(p);
    for (const [unit, loc] of p.bc) { const c = samp[unit][4]; g.uniform4f(loc, ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, (c >>> 24) / 255); }
    g.bindVertexArray(vao);
    g.bindBuffer(g.ARRAY_BUFFER, vbo);
    g.bufferData(g.ARRAY_BUFFER, bytes, g.STREAM_DRAW);
    for (let k = 0; k < maxAttrib; k++) g.disableVertexAttribArray(k);
    maxAttrib = p.attrs.length;
    for (const a of p.attrs) {
      const e = L.E.find((x) => x.usage === a.usage && x.index === a.index);
      // an input no element feeds: D3DCOLOR's defaults for the colours, (0, 0, 0, 1) otherwise
      if (!e) { g.vertexAttrib4f(a.loc, ...(a.usage === 'color' ? (a.index ? [0, 0, 0, 0] : [1, 1, 1, 1]) : [0, 0, 0, 1])); continue; }
      g.enableVertexAttribArray(a.loc);
      g.vertexAttribPointer(a.loc, e.size, e.color ? g.UNSIGNED_BYTE : g.FLOAT, e.color, stride, e.off);
    }
    if (indexBytes) {
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ibo);
      g.bufferData(g.ELEMENT_ARRAY_BUFFER, indexBytes, g.STREAM_DRAW);
      g.drawElements(g[MODE[type]], n, indexFmt === 102 ? g.UNSIGNED_INT : g.UNSIGNED_SHORT, 0);
    } else g.drawArrays(g[MODE[type]], 0, n);
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
    setSamplerState: (s, type, value) => { (samp[s] ?? fail(`sampler ${s}`))[type] = value >>> 0; return OK; },
    getSamplerState: (s, type) => samp[s][type],
    setTextureStageState: () => OK,                          // the fixed function's stages: not drawn yet
    setTransform: () => OK,
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
    setVertexShaderConstantI: () => fail('SetVertexShaderConstantI is not supported yet'),
    setPixelShaderConstantI: () => fail('SetPixelShaderConstantI is not supported yet'),
    setVertexShaderConstantB: () => fail('SetVertexShaderConstantB is not supported yet'),
    setPixelShaderConstantB: () => fail('SetPixelShaderConstantB is not supported yet'),

    // vertex input
    setFVF: (f) => { fvf = f >>> 0; decl = 0; return OK; },
    getFVF: () => fvf,
    createVertexDeclaration: () => fail('vertex declarations are not supported yet'),
    setVertexDeclaration: (h) => { if (h) fail('vertex declarations are not supported yet'); decl = 0; return OK; },

    // buffers
    createVertexBuffer: (length) => add({ kind: 'vb', bytes: new Uint8Array(length) }),
    createIndexBuffer: (length, usage, format) => add({ kind: 'ib', bytes: new Uint8Array(length), format }),
    bufferWrite: (h, offset, bytes) => { const b = objects.get(h); b.bytes.set(bytes, offset); return OK; },
    setStreamSource: (stream, h, offset, stride) => { streams[stream] = { vb: h, offset, stride }; return OK; },
    setIndices: (h) => { indices = h; return OK; },

    // draws
    drawPrimitiveUP: (type, primCount, bytes, stride) => { drawUP(type, primCount, bytes, stride); return OK; },
    drawIndexedPrimitiveUP: (type, minIndex, numVertices, primCount, indexBytes, indexFmt, bytes, stride) => {
      drawUP(type, primCount, bytes, stride, indexBytes, indexFmt); return OK;
    },
    drawPrimitive: (type, start, primCount) => {
      const s = streams[0], b = get(s.vb, 'vb');
      const n = COUNT[type](primCount);
      const bytes = b.bytes.subarray(s.offset + start * s.stride, s.offset + (start + n) * s.stride);
      drawUP(type, primCount, bytes, s.stride); return OK;
    },
    drawIndexedPrimitive: (type, baseVertex, minIndex, numVertices, startIndex, primCount) => {
      const s = streams[0], b = get(s.vb, 'vb'), ib = get(indices, 'ib');
      const size = ib.format === 102 ? 4 : 2, n = COUNT[type](primCount);
      const idx = ib.bytes.slice(startIndex * size, (startIndex + n) * size);
      const bytes = b.bytes.subarray(s.offset + baseVertex * s.stride);
      drawUP(type, primCount, bytes, s.stride, idx, ib.format); return OK;
    },

    // textures and surfaces
    createTexture: (w, h, levels, usage, format) => add(makeTexture(w, h, levels, usage, format)),
    textureWrite: (h, level, rect, bytes, pitch) => {
      const t = get(h, 'texture'), s = get(t.surfaces[level], 'surface');
      if (rect) fail('a partial texture write is not supported yet');
      g.bindTexture(g.TEXTURE_2D, t.tex);
      g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
      g.texSubImage2D(g.TEXTURE_2D, level, 0, 0, s.w, s.h, g[t.f[1]], g[t.f[2]], texels(t.f, bytes, s.w, s.h, pitch));
      if (level === 0 && (t.usage & USAGE_AUTOGENMIPMAP)) g.generateMipmap(g.TEXTURE_2D);
      return OK;
    },
    setTexture: (s, h) => { textures[s] = h; return OK; },
    getTexture: (s) => textures[s],
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
    surfaceRead: () => fail('reading a render target back (LockRect) is not supported yet'),
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
