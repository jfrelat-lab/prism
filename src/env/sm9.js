// sm9.js — Direct3D 9 shader bytecode (vs_1_1 to vs_3_0, ps_2_0 to ps_3_0) to GLSL ES 3.00, for
// src/env/d3d9.js: the tokens fxc or D3DXAssembleShader produced, as a program hands them to
// CreateVertexShader / CreatePixelShader. The result has hlsl.js's shape and conventions, so either
// stage can meet the other's: { glsl, samplers, inputs, outputs }, the float register file
// `uniform vec4 prism_c[N]`, the integer and boolean ones prism_i and prism_b, sampler n prism_s<n>,
// a vertex shader's inputs prism_a_<usage><index> and its outputs prism_t<n> / prism_col<n> (and
// prism_pos, mapped to GL's clip space through prism_posFix), a pixel shader's colours prism_o<n>.
//
// Every register is a vec4 and every instruction computes a vec4 that is written through its mask,
// so swizzles, masks and source modifiers are GLSL's own. Subroutines become functions over the
// global registers; a loop's aL is declared in the loop's body, so the innermost one is what reads see.
// The token layout and each instruction's semantics are the D3D9 shader model's (d3d9types.h, the
// "Asm Shader Reference"); where an instruction's result is hardware-dependent (rcp(0), log(0)), GLSL's
// IEEE answer is taken.

const fail = (msg) => { throw new Error(`sm9: ${msg}`); };

const USAGE = ['position', 'blendweight', 'blendindices', 'normal', 'psize', 'texcoord', 'tangent', 'binormal', 'tessfactor',
  'positiont', 'color', 'fog', 'depth', 'sample'];
const OP = {
  0: 'nop', 1: 'mov', 2: 'add', 3: 'sub', 4: 'mad', 5: 'mul', 6: 'rcp', 7: 'rsq', 8: 'dp3', 9: 'dp4', 10: 'min', 11: 'max', 12: 'slt',
  13: 'sge', 14: 'exp', 15: 'log', 16: 'lit', 17: 'dst', 18: 'lrp', 19: 'frc', 20: 'm4x4', 21: 'm4x3', 22: 'm3x4', 23: 'm3x3', 24: 'm3x2',
  25: 'call', 26: 'callnz', 27: 'loop', 28: 'ret', 29: 'endloop', 30: 'label', 31: 'dcl', 32: 'pow', 33: 'crs', 34: 'sgn', 35: 'abs',
  36: 'nrm', 37: 'sincos', 38: 'rep', 39: 'endrep', 40: 'if', 41: 'ifc', 42: 'else', 43: 'endif', 44: 'break', 45: 'breakc', 46: 'mova',
  47: 'defb', 48: 'defi', 65: 'texkill', 66: 'texld', 78: 'expp', 79: 'logp', 80: 'cnd', 81: 'def', 88: 'cmp', 90: 'dp2add', 91: 'dsx',
  92: 'dsy', 93: 'texldd', 94: 'setp', 95: 'texldl', 96: 'breakp',
};
// instructions without a destination parameter
const NO_DST = new Set(['nop', 'call', 'callnz', 'loop', 'ret', 'endloop', 'label', 'rep', 'endrep', 'if', 'ifc', 'else', 'endif', 'break', 'breakc', 'breakp']);
// register types (D3DSHADER_PARAM_REGISTER_TYPE)
const R = { TEMP: 0, INPUT: 1, CONST: 2, ADDR: 3, TEXTURE: 3, RASTOUT: 4, ATTROUT: 5, OUTPUT: 6, CONSTINT: 7, COLOROUT: 8, DEPTHOUT: 9,
  SAMPLER: 10, CONSTBOOL: 14, LOOP: 15, MISCTYPE: 17, LABEL: 18, PREDICATE: 19 };
const CMP = { 1: ['>', 'greaterThan'], 2: ['==', 'equal'], 3: ['>=', 'greaterThanEqual'], 4: ['<', 'lessThan'], 5: ['!=', 'notEqual'], 6: ['<=', 'lessThanEqual'] };
const HELPERS = {
  lit: 'vec4 prism_lit(vec4 s) { return vec4(1.0, max(s.x, 0.0), s.x > 0.0 && s.y > 0.0 ? pow(s.y, clamp(s.w, -128.0, 128.0)) : 0.0, 1.0); }',
  cmp: 'vec4 prism_cmp(vec4 a, vec4 b, vec4 c) { return vec4(a.x >= 0.0 ? b.x : c.x, a.y >= 0.0 ? b.y : c.y, a.z >= 0.0 ? b.z : c.z, a.w >= 0.0 ? b.w : c.w); }',
  nrm: 'vec4 prism_nrm(vec4 v) { float d = dot(v.xyz, v.xyz); return d == 0.0 ? v : v * inversesqrt(d); }',
  cnd: 'vec4 prism_cnd(vec4 a, vec4 b, vec4 c) { return vec4(a.x > 0.5 ? b.x : c.x, a.y > 0.5 ? b.y : c.y, a.z > 0.5 ? b.z : c.z, a.w > 0.5 ? b.w : c.w); }',
};
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const fnum = (bits) => { u32[0] = bits; const v = f32[0]; return Number.isFinite(v) ? (Number.isInteger(v) ? `${v}.0` : `${v}`) : v > 0 ? '1e38' : v < 0 ? '-1e38' : '0.0'; };

/** The version token's stage and model, or null when `tokens` is not D3D9 shader bytecode. */
export function bytecodeVersion(tokens) {
  const v = tokens[0] >>> 0, kind = v >>> 16;
  if (kind !== 0xfffe && kind !== 0xffff) return null;
  return { stage: kind === 0xfffe ? 'vs' : 'ps', major: (v >> 8) & 255, minor: v & 255 };
}

/** Translate shader bytecode (Uint32Array or array of DWORDs) to { glsl, samplers, inputs, outputs }. */
export function translateBytecode(tokens) {
  const ver = bytecodeVersion(tokens) ?? fail(`version token 0x${(tokens[0] >>> 0).toString(16)}`);
  const { stage, major, minor } = ver;
  const profile = `${stage}_${major}_${minor}`;
  if (stage === 'ps' && major < 2) fail(`${profile} is not supported yet (ps_2_0 and later)`);
  if (major > 3) fail(`${profile}`);

  // ---- decode: { op, ctl, pred, p: [param tokens] } ----
  const ins = [];
  for (let i = 1; i < tokens.length;) {
    const t = tokens[i] >>> 0, code = t & 0xffff;
    if (code === 0xffff) break;
    if (code === 0xfffe) { i += 1 + ((t >>> 16) & 0x7fff); continue; }
    const op = OP[code] ?? fail(`${profile}: opcode ${code} is not supported`);
    let len;
    if (major >= 2) len = (t >>> 24) & 15;
    else if (op === 'def') len = 5;
    else { len = 0; while (i + 1 + len < tokens.length && (tokens[i + 1 + len] >>> 31)) len++; }   // SM1: parameters have bit 31 set
    ins.push({ op, ctl: (t >>> 16) & 255, pred: !!(t & 0x10000000), p: Array.from(tokens.slice(i + 1, i + 1 + len), (x) => x >>> 0) });
    i += 1 + len;
  }
  const regType = (t) => ((t >>> 28) & 7) | ((t >>> 8) & 0x18);
  const regNum = (t) => t & 0x7ff;

  // ---- declarations and constants: a first pass, since a dcl or def may follow nothing it governs ----
  const defs = new Map(), defi = new Map(), defb = new Map();
  const inDecl = new Map(), outDecl = new Map(), samplerDim = new Map();
  let relConst = false;
  for (const x of ins) {
    if (x.op === 'def') defs.set(regNum(x.p[0]), x.p.slice(1, 5).map(fnum));
    else if (x.op === 'defi') defi.set(regNum(x.p[0]), x.p.slice(1, 5).map((v) => v | 0));
    else if (x.op === 'defb') defb.set(regNum(x.p[0]), x.p[1] ? 1 : 0);
    else if (x.op === 'dcl') {
      const [u, d] = x.p, type = regType(d), n = regNum(d);
      if (type === R.SAMPLER) samplerDim.set(n, { 2: '2D', 3: 'Cube', 4: '3D' }[(u >>> 27) & 15] ?? fail(`${profile}: sampler type ${(u >>> 27) & 15}`));
      else if (type === R.INPUT) inDecl.set(n, { usage: USAGE[u & 31] ?? fail(`usage ${u & 31}`), index: (u >>> 16) & 15 });
      else if (type === R.OUTPUT && stage === 'vs') outDecl.set(n, { usage: USAGE[u & 31] ?? fail(`usage ${u & 31}`), index: (u >>> 16) & 15 });
    }
    for (const t of x.p) if (t >>> 31 && regType(t) === R.CONST && t & 0x2000) relConst = true;
  }

  // ---- registers ----
  const temps = new Set(), inputs = [], outputs = [], ins_ = [], outs = [], locals = new Map(), helpers = new Set();
  const samplers = new Map();
  let usesC = false, usesI = false, usesB = false, usesP = false, usesA0 = false, usesAL = false, usesDepth = false;
  const input = (name, decl, entry) => { if (!inputs.some((x) => x.name === name)) { inputs.push(entry); ins_.push(decl); } return name; };
  const varyingIn = (usage, index) => {
    if (usage !== 'texcoord' && usage !== 'color') fail(`${profile}: a pixel shader input of usage ${usage}`);
    const name = `prism_${usage === 'color' ? 'col' : 't'}${index}`;
    return input(name, `in vec4 ${name};`, { semantic: usage === 'color' ? 'COLOR' : 'TEXCOORD', index, name });
  };
  // an output is a local vec4, copied to what GL reads at the end
  const output = (local, entry, epilogue, decl) => {
    if (!locals.has(local)) { locals.set(local, epilogue); if (entry) outputs.push(entry); if (decl) outs.push(decl); }
    return local;
  };
  const varyingOut = (usage, index) => {
    if (usage === 'position') return output('prism_pos', { semantic: 'POSITION', index: 0 }, null);
    if (usage === 'psize') return output('prism_psize', null, '  gl_PointSize = prism_psize.x;');
    if (usage === 'fog') return output('prism_fog', null, '');
    if (usage !== 'texcoord' && usage !== 'color') fail(`${profile}: a vertex shader output of usage ${usage}`);
    const name = `prism_${usage === 'color' ? 'col' : 't'}${index}`;
    // vs_1_x and vs_2_x colours reach the pixel shader clamped to [0, 1]
    return output(`${name}_r`, { semantic: usage === 'color' ? 'COLOR' : 'TEXCOORD', index, name },
      `  ${name} = ${usage === 'color' && major < 3 ? `clamp(${name}_r, 0.0, 1.0)` : `${name}_r`};`, `out vec4 ${name};`);
  };
  const constAt = (n) => (defs.has(n) && !relConst ? `vec4(${defs.get(n).join(', ')})` : (usesC = true, relConst ? `prism_cr[${n}]` : `prism_c[${n}]`));
  /** The register a parameter token names, as a vec4 (or the integer/bool forms where they are only used whole). */
  function reg(type, n, write) {
    switch (type) {
      case R.TEMP: temps.add(n); return `r${n}`;
      case R.INPUT:
        if (stage === 'vs') { const d = inDecl.get(n) ?? (major < 2 ? { usage: 'position', index: n } : fail(`v${n} without dcl`)); const name = `prism_a_${d.usage}${d.index}`; return input(name, `in vec4 ${name};`, { semantic: d.usage.toUpperCase(), index: d.index, name }); }
        if (major >= 3) { const d = inDecl.get(n) ?? fail(`v${n} without dcl`); return varyingIn(d.usage, d.index); }
        return varyingIn('color', n);                                              // ps_2_x: v0, v1 are the colours
      case R.CONST: return constAt(n);
      case 3:                                                                       // vs: a0; ps: t<n>, a texture coordinate
        if (stage === 'vs') { usesA0 = true; return write ? 'prism_a0' : 'vec4(prism_a0)'; }
        return varyingIn('texcoord', n);
      case R.RASTOUT: return varyingOut(['position', 'fog', 'psize'][n], 0);
      case R.ATTROUT: return varyingOut('color', n);
      case R.OUTPUT:
        if (stage === 'vs' && major >= 3) { const d = outDecl.get(n) ?? fail(`o${n} without dcl`); return varyingOut(d.usage, d.index); }
        return varyingOut('texcoord', n);                                          // oT<n>
      case R.CONSTINT: return defi.has(n) ? `vec4(${defi.get(n).join('.0, ')}.0)` : (usesI = true, `vec4(prism_i[${n}])`);
      case R.COLOROUT: return output(`prism_o${n}_r`, { semantic: 'COLOR', index: n }, `  prism_o${n} = prism_o${n}_r;`, `layout(location = ${n}) out vec4 prism_o${n};`);
      case R.DEPTHOUT: usesDepth = true; return output('prism_depth', null, '  gl_FragDepth = prism_depth.x;');
      case R.CONSTBOOL: return defb.has(n) ? `vec4(${defb.get(n)}.0)` : (usesB = true, `vec4(float(prism_b[${n}]))`);
      case R.LOOP: usesAL = true; return 'vec4(float(prism_aL))';
      case R.MISCTYPE: return n === 0 ? 'vec4(gl_FragCoord.xy - 0.5, 0.0, 0.0)' : 'vec4(gl_FrontFacing ? 1.0 : -1.0)';
      case R.PREDICATE: usesP = true; return 'prism_p';
      case R.SAMPLER: return `prism_s${n}`;
      case R.LABEL: return `prism_L${n}`;
      default: return fail(`${profile}: register type ${type}`);
    }
  }
  const SW = 'xyzw';
  const swizzle = (s) => [0, 2, 4, 6].map((k) => SW[(s >> k) & 3]).join('');
  /** A source parameter at p[k] (with its relative-address token, if any): { code, next, type, num, swz, mod }. */
  function src(p, k, offset = 0) {
    const t = p[k], type = regType(t), num = regNum(t) + offset, swz = (t >>> 16) & 255, mod = (t >>> 24) & 15;
    let next = k + 1, code;
    if (t & 0x2000) {
      let index;
      if (major >= 2) { const a = p[k + 1]; next++; const at = regType(a), comp = SW[(a >>> 16) & 3]; index = at === R.LOOP ? (usesAL = true, 'prism_aL') : (usesA0 = true, `prism_a0.${comp}`); }
      else { usesA0 = true; index = 'prism_a0.x'; }
      if (type === R.CONST) { usesC = true; code = `prism_cr[${index} + ${num}]`; }
      else if (type === R.INPUT && stage === 'ps') fail(`${profile}: relative addressing of the inputs is not supported yet`);
      else fail(`${profile}: relative addressing of register type ${type}`);
    } else code = reg(type, num, false);
    if (type === R.PREDICATE) { code = swz === 0xe4 ? code : `${code}.${swizzle(swz)}`; return { code: mod === 13 ? `not(${code})` : code, next, type, num, swz, mod, bool: true }; }
    const sw = swz === 0xe4 ? code : `${code}.${swizzle(swz)}`;
    const M = { 0: sw, 1: `(-${sw})`, 2: `(${sw} - 0.5)`, 3: `(-(${sw} - 0.5))`, 4: `(2.0 * ${sw} - 1.0)`, 5: `(-(2.0 * ${sw} - 1.0))`,
      6: `(1.0 - ${sw})`, 7: `(2.0 * ${sw})`, 8: `(-2.0 * ${sw})`, 9: `(${sw} / ${sw}.z)`, 10: `(${sw} / ${sw}.w)`, 11: `abs(${sw})`, 12: `(-abs(${sw}))` };
    return { code: M[mod] ?? fail(`${profile}: source modifier ${mod}`), next, at: k, type, num, swz, mod, rel: !!(t & 0x2000), t };
  }
  // A scalar operand: the replicated component, or w for an unswizzled one (the SM1 rule).
  const scalar = (s) => `(${s.code}).${s.swz === 0xe4 ? 'w' : SW[s.swz & 3]}`;

  // ---- statements ----
  const fns = [], protos = [];
  let body = [], depth = 1, loopN = 0;
  const line = (s) => body.push(`${'  '.repeat(depth)}${s}`);
  const mainBody = body;
  for (const x of ins) {
    const { op, p } = x;
    if (op === 'dcl' || op === 'def' || op === 'defi' || op === 'defb' || op === 'nop') continue;
    let k = 0, dst = null, pred = null;
    if (!NO_DST.has(op)) {
      const t = p[0];
      if (t & 0x2000) fail(`${profile}: relative addressing of a destination`);
      dst = { type: regType(t), num: regNum(t), mask: (t >>> 16) & 15, sat: !!(t & 0x100000), t };
      k = 1;
    }
    if (x.pred) { pred = src(p, k); k = pred.next; }
    const S = [];
    while (k < p.length) { const s = src(p, k); S.push(s); k = s.next; }
    const s = (j) => S[j].code;
    const write = (expr) => {
      if (dst.type === 3 && stage === 'vs') {                                     // a0: mova rounds, vs_1_x's mov truncates toward -infinity
        usesA0 = true;
        const m = [0, 1, 2, 3].filter((c) => dst.mask & (1 << c)).map((c) => SW[c]).join('');
        line(`prism_a0.${m} = ivec4(${op === 'mova' ? `floor(${expr} + 0.5)` : `floor(${expr})`}).${m};`);
        return;
      }
      const name = reg(dst.type, dst.num, true);
      const m = [0, 1, 2, 3].filter((c) => dst.mask & (1 << c)).map((c) => SW[c]).join('');
      let e = dst.sat ? `clamp(${expr}, 0.0, 1.0)` : `(${expr})`;
      if (pred) e = `mix(${name}, ${e}, ${pred.code})`;
      line(m === 'xyzw' ? `${name} = ${e};` : `${name}.${m} = ${e}.${m};`);
    };
    const mat = (rows, n3) => {
      const v = n3 ? `(${s(0)}).xyz` : s(0);
      // the matrix: consecutive registers from src1's
      const d = Array.from({ length: rows }, (_, r) => { const m = src(p, S[1].at, r); return `dot(${v}, ${n3 ? `(${m.code}).xyz` : m.code})`; });
      return `vec4(${[...d, ...Array(4 - rows).fill('0.0')].join(', ')})`;
    };
    switch (op) {
      case 'mov': case 'mova': write(s(0)); break;
      case 'add': write(`${s(0)} + ${s(1)}`); break;
      case 'sub': write(`${s(0)} - ${s(1)}`); break;
      case 'mad': write(`${s(0)} * ${s(1)} + ${s(2)}`); break;
      case 'mul': write(`${s(0)} * ${s(1)}`); break;
      case 'rcp': write(`vec4(1.0 / ${scalar(S[0])})`); break;
      case 'rsq': write(`vec4(inversesqrt(abs(${scalar(S[0])})))`); break;
      case 'dp3': write(`vec4(dot((${s(0)}).xyz, (${s(1)}).xyz))`); break;
      case 'dp4': write(`vec4(dot(${s(0)}, ${s(1)}))`); break;
      case 'min': write(`min(${s(0)}, ${s(1)})`); break;
      case 'max': write(`max(${s(0)}, ${s(1)})`); break;
      case 'slt': write(`vec4(lessThan(${s(0)}, ${s(1)}))`); break;
      case 'sge': write(`vec4(greaterThanEqual(${s(0)}, ${s(1)}))`); break;
      case 'exp': write(`vec4(exp2(${scalar(S[0])}))`); break;
      case 'log': write(`vec4(log2(abs(${scalar(S[0])})))`); break;
      // vs_1_x's expp and logp are their own vectors; later models make them partial-precision exp and log
      case 'expp': write(major < 2 ? `vec4(exp2(floor(${scalar(S[0])})), fract(${scalar(S[0])}), exp2(${scalar(S[0])}), 1.0)` : `vec4(exp2(${scalar(S[0])}))`); break;
      case 'logp': write(major < 2 ? `vec4(floor(log2(abs(${scalar(S[0])}))), abs(${scalar(S[0])}) / exp2(floor(log2(abs(${scalar(S[0])})))), log2(abs(${scalar(S[0])})), 1.0)` : `vec4(log2(abs(${scalar(S[0])})))`); break;
      case 'lit': helpers.add('lit'); write(`prism_lit(${s(0)})`); break;
      case 'dst': write(`vec4(1.0, (${s(0)}).y * (${s(1)}).y, (${s(0)}).z, (${s(1)}).w)`); break;
      case 'lrp': write(`mix(${s(2)}, ${s(1)}, ${s(0)})`); break;
      case 'frc': write(`fract(${s(0)})`); break;
      case 'm4x4': write(mat(4, false)); break;
      case 'm4x3': write(mat(3, false)); break;
      case 'm3x4': write(mat(4, true)); break;
      case 'm3x3': write(mat(3, true)); break;
      case 'm3x2': write(mat(2, true)); break;
      case 'pow': write(`vec4(pow(abs(${scalar(S[0])}), ${scalar(S[1])}))`); break;
      case 'crs': write(`vec4(cross((${s(0)}).xyz, (${s(1)}).xyz), 0.0)`); break;
      case 'sgn': write(`sign(${s(0)})`); break;
      case 'abs': write(`abs(${s(0)})`); break;
      case 'nrm': helpers.add('nrm'); write(`prism_nrm(${s(0)})`); break;
      case 'sincos': write(`vec4(cos(${scalar(S[0])}), sin(${scalar(S[0])}), 0.0, 0.0)`); break;
      case 'cmp': helpers.add('cmp'); write(`prism_cmp(${s(0)}, ${s(1)}, ${s(2)})`); break;
      case 'cnd': helpers.add('cnd'); write(`prism_cnd(${s(0)}, ${s(1)}, ${s(2)})`); break;
      case 'dp2add': write(`vec4(dot((${s(0)}).xy, (${s(1)}).xy) + ${scalar(S[2])})`); break;
      case 'dsx': write(`dFdx(${s(0)})`); break;
      case 'dsy': write(`dFdy(${s(0)})`); break;                                   // D3D's rows are kept, so +y is down in both
      case 'texld': case 'texldl': case 'texldd': {
        if (stage === 'vs' && op !== 'texldl') fail(`${profile}: ${op} in a vertex shader (only texldl reads a texture there)`);
        const n = S[1].num, dim = samplerDim.get(n) ?? (major < 3 ? '2D' : fail(`s${n} without dcl`));
        samplers.set(n, dim);
        const sm = `prism_s${n}`, c = s(0), xy = dim === '2D' ? 'xy' : 'xyz';
        if (op === 'texldl') write(`textureLod(${sm}, (${c}).${xy}, (${c}).w)`);
        else if (op === 'texldd') write(`textureGrad(${sm}, (${c}).${xy}, (${s(2)}).${xy}, (${s(3)}).${xy})`);
        else if (x.ctl === 1) write(`texture(${sm}, (${c}).${xy} / (${c}).w)`);
        else if (x.ctl === 2) write(`texture(${sm}, (${c}).${xy}, (${c}).w)`);
        else write(`texture(${sm}, (${c}).${xy})`);
        break;
      }
      case 'texkill': {
        const name = reg(dst.type, dst.num, false);
        const m = [0, 1, 2, 3].filter((c) => dst.mask & (1 << c)).map((c) => SW[c]).join('') || 'xyz';
        line(`if (any(lessThan(${name}.${m}, ${m.length === 1 ? '0.0' : `vec${m.length}(0.0)`}))) discard;`);
        break;
      }
      case 'setp': { usesP = true; const m = [0, 1, 2, 3].filter((c) => dst.mask & (1 << c)).map((c) => SW[c]).join(''); line(`prism_p.${m} = ${CMP[x.ctl][1]}(${s(0)}, ${s(1)}).${m};`); break; }
      case 'if': line(`if (${S[0].bool ? `(${S[0].code}).x` : `${s(0)}.x != 0.0`}) {`); depth++; break;
      case 'ifc': line(`if (${scalar(S[0])} ${CMP[x.ctl][0]} ${scalar(S[1])}) {`); depth++; break;
      case 'else': depth--; line('} else {'); depth++; break;
      case 'endif': case 'endrep': case 'endloop': depth--; line('}'); break;
      case 'rep': { const n = `prism_k${loopN++}`; line(`for (int ${n} = 0; ${n} < int(${s(0)}.x); ${n}++) {`); depth++; break; }
      case 'loop': {
        usesAL = true;
        const n = `prism_k${loopN++}`, i = `prism_i[${S[1].num}]`;
        if (S[1].type !== R.CONSTINT) fail(`${profile}: loop over a register of type ${S[1].type}`);
        const iv = defi.has(S[1].num) ? `ivec4(${defi.get(S[1].num).join(', ')})` : (usesI = true, i);
        line(`for (int ${n} = 0; ${n} < ${iv}.x; ${n}++) {`); depth++;
        line(`int prism_aL = ${iv}.y + ${n} * ${iv}.z;`);
        break;
      }
      case 'break': line('break;'); break;
      case 'breakc': line(`if (${scalar(S[0])} ${CMP[x.ctl][0]} ${scalar(S[1])}) break;`); break;
      case 'breakp': line(`if ((${S[0].code}).x) break;`); break;
      case 'call': line(`prism_L${S[0].num}();`); break;
      case 'callnz': line(`if (${S[1].bool ? `(${S[1].code}).x` : `${s(1)}.x != 0.0`}) prism_L${S[0].num}();`); break;
      case 'ret': line('return;'); break;
      case 'label': {
        if (depth !== 1) fail(`${profile}: a label inside a block`);
        const n = S[0].num;
        protos.push(`void prism_L${n}();`);
        body = [];
        fns.push({ name: `prism_L${n}`, body });
        break;
      }
      default: fail(`${profile}: ${op} is not supported yet`);
    }
  }

  // a defi/defb register reads its literal, as def's: the shader's own value over the register file's
  const intConsts = usesI ? 'uniform ivec4 prism_i[16];' : null;
  const boolConsts = usesB ? 'uniform int prism_b[16];' : null;
  const N = stage === 'vs' ? 256 : major >= 3 ? 224 : 32;
  const decls = [
    '#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler3D;', 'precision highp samplerCube;',
    ...(usesC ? [`uniform vec4 prism_c[${N}];`] : []), ...(intConsts ? [intConsts] : []), ...(boolConsts ? [boolConsts] : []),
    ...[...samplers].map(([n, dim]) => `uniform highp sampler${dim} prism_s${n};`),
    ...(stage === 'vs' ? ['uniform vec4 prism_posFix;'] : []),
    ...ins_, ...outs,
    ...[...temps].sort((a, b) => a - b).map((n) => `vec4 r${n} = vec4(0.0);`),
    ...[...locals.keys()].map((l) => `vec4 ${l} = vec4(0.0);`),
    ...(usesA0 ? ['ivec4 prism_a0 = ivec4(0);'] : []), ...(usesAL ? ['int prism_aL = 0;'] : []), ...(usesP ? ['bvec4 prism_p = bvec4(false);'] : []),
    ...(relConst ? [`vec4 prism_cr[${N}];`] : []),
    ...[...helpers].map((h) => HELPERS[h]),
    ...protos,
  ];
  const init = relConst ? [`  prism_cr = prism_c;`, ...[...defs].map(([n, v]) => `  prism_cr[${n}] = vec4(${v.join(', ')});`)] : [];
  const glsl = [
    ...decls,
    ...fns.map((f) => `void ${f.name}() {\n${f.body.join('\n')}\n}`),
    `void prism_main() {\n${mainBody.join('\n')}\n}`,
    'void main() {', ...init, '  prism_main();',
    ...[...locals.values()].filter(Boolean),
    // D3D's clip space to GL's: z from [0, w] to [-w, w], and the half-pixel offset and row order (prism_posFix)
    ...(stage === 'vs' ? ['  gl_Position = vec4(prism_pos.xy * prism_posFix.xy + prism_posFix.zw * prism_pos.w, prism_pos.z * 2.0 - prism_pos.w, prism_pos.w);'] : []),
    '}', ''].join('\n');
  if (stage === 'vs' && !locals.has('prism_pos')) fail(`${profile}: no position written`);
  void usesDepth;
  return { glsl, profile, samplers: [...samplers].map(([index, dim]) => ({ index, dim, name: `s${index}` })), inputs, outputs, defi, defb };
}
