// d3d9scene.js — tools/oracle/d3d9scene.c's script played on src/env/d3d9.js's device: the same calls in the
// same order, the same texel pattern, and the shaders as the bytecode D3DXAssembleShader gave the reference
// (`shaders`: id -> DWORDs). Runs in the page tools/gate-d3d9-scenes.mjs serves. Returns the back buffer as
// R, G, B bytes, row 0 first.

/** A texel's B, G, R, A bytes -- the same function as d3d9scene.c's. */
export function pattern(x, y, z, face, level) {
  return [(x * 53 + 17) & 255, (y * 97 + 41) & 255, (z * 71 + face * 43 + level * 29 + 11) & 255, 255];
}
function filled(w, h, d, face, level) {
  const b = new Uint8Array(w * h * d * 4);
  for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(pattern(x, y, z, face, level), ((z * h + y) * w + x) * 4);
  return b;
}
const dim = (n, l) => Math.max(1, n >> l);
const levelsOf = (n, l) => l || 1 + Math.floor(Math.log2(n));

export function playScene(dev, script, shaders, w, h) {
  const ids = new Map();
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  let lineno = 0;
  for (const raw of script.split('\n')) {
    lineno++;
    const [word, ...rest] = raw.trim().split(/\s+/);
    if (!word) continue;
    const n = (k) => Number(rest[k]);
    const id = (k) => (n(k) ? ids.get(n(k)) ?? fail(`id ${n(k)}`) : 0);
    const fail = (m) => { throw new Error(`scene line ${lineno} (${word}): ${m}`); };
    switch (word) {
      case 'rs': dev.setRenderState(n(0), n(1) >>> 0); break;
      case 'ss': dev.setSamplerState(n(0), n(1), n(2) >>> 0); break;
      case 'tss': dev.setTextureStageState(n(0), n(1), n(2) >>> 0); break;
      case 'tex2d': {
        const t = dev.createTexture(n(1), n(2), n(3), 0, n(4));
        for (let l = 0; l < levelsOf(Math.max(n(1), n(2)), n(3)); l++) dev.textureWrite(t, l, null, filled(dim(n(1), l), dim(n(2), l), 1, 0, l), dim(n(1), l) * 4);
        ids.set(n(0), t); break;
      }
      case 'texcube': {
        const t = dev.createCubeTexture(n(1), n(2), 0, n(3));
        for (let f = 0; f < 6; f++) for (let l = 0; l < levelsOf(n(1), n(2)); l++) dev.textureWrite(t, l, null, filled(dim(n(1), l), dim(n(1), l), 1, f, l), dim(n(1), l) * 4, f);
        ids.set(n(0), t); break;
      }
      case 'tex3d': {
        const t = dev.createVolumeTexture(n(1), n(2), n(3), n(4), 0, n(5));
        for (let l = 0; l < levelsOf(Math.max(n(1), n(2), n(3)), n(4)); l++) {
          const tw = dim(n(1), l), th = dim(n(2), l), td = dim(n(3), l);
          dev.volumeWrite(t, l, filled(tw, th, td, 0, l), tw * 4, tw * th * 4);
        }
        ids.set(n(0), t); break;
      }
      case 'settex': dev.setTexture(n(0), id(1)); break;
      case 'asm': {
        const code = shaders[n(0)] ?? fail(`no bytecode for shader ${n(0)}`);
        ids.set(n(0), (code[0] >>> 16) === 0xfffe ? dev.createVertexShader(Uint32Array.from(code)) : dev.createPixelShader(Uint32Array.from(code)));
        break;
      }
      case 'setvs': dev.setVertexShader(id(0)); break;
      case 'setps': dev.setPixelShader(id(0)); break;
      case 'vsc': dev.setVertexShaderConstantF(n(0), new Float32Array(rest.slice(1, 5).map(Number))); break;
      case 'psc': dev.setPixelShaderConstantF(n(0), new Float32Array(rest.slice(1, 5).map(Number))); break;
      case 'decl': {
        const els = [];
        for (let k = 0; k < n(1); k++) {
          const b = 2 + k * 6;
          els.push({ stream: n(b), offset: n(b + 1), type: n(b + 2), method: n(b + 3), usage: n(b + 4), usageIndex: n(b + 5) });
        }
        ids.set(n(0), dev.createVertexDeclaration(els)); break;
      }
      case 'setdecl': dev.setVertexDeclaration(id(0)); break;
      case 'fvf': dev.setFVF(parseInt(rest[0], 16)); break;
      case 'vb': {
        const words = rest.slice(1).map((t) => (t.includes('.') ? (f32[0] = Number(t), u32[0]) : Number(t) >>> 0));
        const b = dev.createVertexBuffer(words.length * 4, 0, 0);
        dev.bufferWrite(b, 0, new Uint8Array(Uint32Array.from(words).buffer));
        ids.set(n(0), b); break;
      }
      case 'ib': {
        const idx = Uint16Array.from(rest.slice(1).map(Number));
        const b = dev.createIndexBuffer(idx.length * 2, 0, 101);
        dev.bufferWrite(b, 0, new Uint8Array(idx.buffer));
        ids.set(n(0), b); break;
      }
      case 'stream': dev.setStreamSource(n(0), id(1), n(2), n(3)); break;
      case 'indices': dev.setIndices(id(0)); break;
      case 'clear': dev.clear(null, n(0), n(1) >>> 0, n(2), n(3)); break;
      case 'draw': dev.drawPrimitive(n(0), n(1), n(2)); break;
      case 'drawi': dev.drawIndexedPrimitive(n(0), n(1), n(2), n(3), n(4), n(5)); break;
      default: fail('unknown call');
    }
  }
  const { bytes, pitch } = dev.surfaceRead(dev.getBackBuffer(0, 0));
  const rgb = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * pitch + x * 4; rgb.push(bytes[o + 2], bytes[o + 1], bytes[o]); }
  return rgb;
}
