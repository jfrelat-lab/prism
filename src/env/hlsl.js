// hlsl.js — HLSL (Direct3D 9's shader model 2 and 3, as D3DXCompileShader takes it) to GLSL ES 3.00.
//
// A typed translator, not a rewrite of tokens: HLSL converts where GLSL refuses -- a float4 assigned to a
// float3 is truncated, a scalar beside a vector is broadcast (dot(v,.5), 1+v), a bool multiplies
// ((a<.001)*x), an int is a float wherever one is wanted, an initialiser list builds a vector
// ({4e-3,0,0}) -- so each expression's type is worked out and every operand converted to what GLSL
// wants. Then the D3D9 machinery: the constants are the register file (c#, i#, b#), the samplers s#,
// bound by `: register()` or allocated in declaration order as fxc allocates the ones used; a matrix
// is kept transposed (GLSL's columns are HLSL's rows), so mul(v,M) is M*v here and a float4x4 read from
// registers packed column-major (fxc's default) is transpose(mat4(c[n..n+3])). The entry point's
// parameters and result are its semantics: VPOS, TEXCOORDn, COLORn, VFACE in; COLORn, DEPTH out.
//
// The pixel orientation is D3D's: the device draws row 0 at the top of its render targets (d3d9.js
// flips at Present), so VPOS is gl_FragCoord.xy - 0.5 and a texture's (0,0) is its first row.
//
// What is not here is refused by name (`hlsl: ...`), never approximated.

const SCALARS = { float: 'float', half: 'float', double: 'float', min16float: 'float', int: 'int', dword: 'uint', uint: 'uint', bool: 'bool' };
const SAMPLER_TYPES = { sampler: null, sampler1D: '2D', sampler2D: '2D', sampler3D: '3D', samplerCUBE: 'Cube', sampler_state: null };
const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'discard', 'struct', 'static', 'const', 'uniform', 'extern', 'in', 'out', 'inout', 'inline', 'shared', 'volatile', 'row_major', 'column_major', 'true', 'false', 'register', 'typedef', 'switch', 'case', 'default']);
const PUNCT = ['<<=', '>>=', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '::'];
const fail = (msg) => { throw new Error(`hlsl: ${msg}`); };

// ---- types ----------------------------------------------------------------------------------------
// { k: 'num', b: 'float'|'int'|'uint'|'bool', n } (n = 1 a scalar), { k: 'mat', b, r, c }, { k: 'struct', name },
// { k: 'sampler', dim }, { k: 'void' }, { k: 'array', of, len }.
const num = (b, n = 1) => ({ k: 'num', b, n });
const FLOAT = num('float'), INT = num('int'), BOOL = num('bool'), VOID = { k: 'void' };
const same = (a, b) => a.k === b.k && (a.k === 'num' ? a.b === b.b && a.n === b.n : a.k === 'mat' ? a.b === b.b && a.r === b.r && a.c === b.c
  : a.k === 'struct' ? a.name === b.name : a.k === 'array' ? a.len === b.len && same(a.of, b.of) : a.k === 'sampler' ? a.dim === b.dim : true);
const VEC = { float: 'vec', int: 'ivec', uint: 'uvec', bool: 'bvec' };
function glslType(t) {
  if (t.k === 'num') return t.n === 1 ? t.b : `${VEC[t.b]}${t.n}`;
  if (t.k === 'mat') return t.r === t.c ? `mat${t.r}` : `mat${t.r}x${t.c}`;     // HLSL rows are GLSL columns
  if (t.k === 'struct') return `hl_${t.name}`;
  if (t.k === 'void') return 'void';
  if (t.k === 'sampler') return `sampler${t.dim ?? '2D'}`;
  if (t.k === 'array') return glslType(t.of);
  return fail(`type ${JSON.stringify(t)}`);
}
/** A type name at tokens[i]: [type, tokens used] or null. */
function typeName(tk, i, structs) {
  const v = tk[i]?.v;
  if (v == null || tk[i].t !== 'id') return null;
  if (SCALARS[v]) return [num(SCALARS[v]), 1];
  let m = /^(float|half|double|int|uint|bool|dword|min16float)([1-4])$/.exec(v);
  if (m) return [num(SCALARS[m[1]], +m[2]), 1];
  m = /^(float|half|double|int|uint|bool|dword|min16float)([1-4])x([1-4])$/.exec(v);
  if (m) return [{ k: 'mat', b: SCALARS[m[1]], r: +m[2], c: +m[3] }, 1];
  if (v === 'vector' && tk[i + 1]?.v === '<') return [num(SCALARS[tk[i + 2].v], +tk[i + 4].v), 6];
  if (v === 'matrix' && tk[i + 1]?.v === '<') return [{ k: 'mat', b: SCALARS[tk[i + 2].v], r: +tk[i + 4].v, c: +tk[i + 6].v }, 8];
  if (v in SAMPLER_TYPES) return [{ k: 'sampler', dim: SAMPLER_TYPES[v] }, 1];
  if (v === 'texture' || v === 'Texture' || v === 'texture2D') return [{ k: 'texture' }, 1];
  if (v === 'void') return [VOID, 1];
  if (structs.has(v)) return [{ k: 'struct', name: v }, 1];
  return null;
}

// ---- the preprocessor and the tokens --------------------------------------------------------------
/** Comments out, #define (object-like and function-like) expanded; other directives refused by name. */
function preprocess(src, defines = []) {
  const macros = new Map(defines.map(([n, v]) => [n, { params: null, body: String(v ?? '') }]));
  // NULs: a source buffer whose length counts its terminator (and padding) hands them over.
  src = src.replace(/\0/g, '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '').replace(/\\\r?\n/g, ' ');
  const out = [];
  const stack = [];                                          // #if nesting: whether each level is live
  const live = () => stack.every(Boolean);
  for (const line of src.split('\n')) {
    const d = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
    if (!d) { out.push(live() ? expand(line, macros) : ''); continue; }
    const [, dir, rest] = d;
    if (dir === 'ifdef') stack.push(macros.has(rest.trim()));
    else if (dir === 'ifndef') stack.push(!macros.has(rest.trim()));
    else if (dir === 'else') stack.push(!stack.pop());
    else if (dir === 'endif') stack.pop();
    else if (!live()) { /* skipped */ } else if (dir === 'define') {
      const m = /^(\w+)(\(([^)]*)\))?\s*(.*)$/.exec(rest);
      macros.set(m[1], { params: m[2] ? m[3].split(',').map((p) => p.trim()).filter(Boolean) : null, body: m[4] });
    } else if (dir === 'undef') macros.delete(rest.trim());
    else if (dir === 'pragma' || dir === 'line') { /* nothing */ } else fail(`#${dir} is not supported`);
    out.push('');
  }
  return out.join('\n');
}
function expand(text, macros, depth = 0) {
  if (!macros.size || depth > 32) return text;
  let changed = false;
  const res = text.replace(/[A-Za-z_]\w*/g, (name, at, whole) => name);   // placeholder for structure
  let out = '', i = 0;
  while (i < text.length) {
    const m = /[A-Za-z_]\w*/y; m.lastIndex = i;
    const id = m.exec(text);
    if (!id || !/[A-Za-z_]/.test(text[i]) || (i > 0 && /[\w.]/.test(text[i - 1]) && /\d/.test(text[i - 1]) === false && /\w/.test(text[i - 1]))) { out += text[i++]; continue; }
    const name = id[0], mac = macros.get(name);
    if (!mac) { out += name; i += name.length; continue; }
    i += name.length;
    if (!mac.params) { out += mac.body; changed = true; continue; }
    let j = i; while (/\s/.test(text[j] ?? '')) j++;
    if (text[j] !== '(') { out += name; continue; }
    const args = []; let depthP = 0, cur = '';
    for (j++; j < text.length; j++) {
      const c = text[j];
      if (c === '(') depthP++;
      if (c === ')') { if (!depthP) break; depthP--; }
      if (c === ',' && !depthP) { args.push(cur); cur = ''; continue; }
      cur += c;
    }
    args.push(cur);
    let body = mac.body;
    mac.params.forEach((p, k) => { body = body.replace(new RegExp(`\\b${p}\\b`, 'g'), (args[k] ?? '').trim()); });
    out += body; i = j + 1; changed = true;
  }
  void res;
  return changed ? expand(out, macros, depth + 1) : out;
}
function lex(src) {
  const tk = [];
  const re = /\s+|([A-Za-z_]\w*)|((?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?[fFhHlLuU]?|0[xX][0-9a-fA-F]+[uUlL]?)|(<<=|>>=|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|==|!=|<=|>=|&&|\|\||<<|>>|::|[{}()[\];,.:?~!%^&*\-+=|<>/])|(.)/gy;
  for (let m; (m = re.exec(src));) {
    if (m[4] !== undefined) fail(`unexpected character '${m[4]}'`);
    if (m[1]) tk.push({ t: 'id', v: m[1] });
    else if (m[2]) tk.push({ t: 'num', v: m[2] });
    else if (m[3]) tk.push({ t: 'p', v: m[3] });
  }
  void PUNCT;
  tk.push({ t: 'eof', v: '' });
  return tk;
}

// ---- the parser -------------------------------------------------------------------------------------
function parse(tk) {
  let i = 0;
  const structs = new Map();
  const peek = (o = 0) => tk[i + o], is = (v, o = 0) => tk[i + o].v === v && tk[i + o].t !== 'num';
  const next = () => tk[i++];
  const expect = (v) => { if (!is(v)) fail(`expected '${v}' but found '${peek().v}' (token ${i})`); return next(); };
  const accept = (v) => (is(v) ? (next(), true) : false);
  const ident = () => { const x = next(); if (x.t !== 'id') fail(`expected a name but found '${x.v}'`); return x.v; };
  const type = () => { const r = typeName(tk, i, structs); if (!r) fail(`expected a type but found '${peek().v}'`); i += r[1]; return r[0]; };
  const isType = (o = 0) => !!typeName(tk, i + o, structs);
  const skipAttributes = () => { while (is('[') && peek(1).t === 'id' && /^(unroll|loop|fastopt|branch|flatten|allow_uav_condition|call|forcecase)$/.test(peek(1).v)) { while (!is(']')) next(); next(); } };
  const MODIFIERS = new Set(['static', 'const', 'uniform', 'extern', 'shared', 'volatile', 'row_major', 'column_major', 'inline', 'precise', 'nointerpolation', 'linear', 'centroid', 'noperspective', 'sample']);
  const modifiers = () => { const m = new Set(); while (peek().t === 'id' && MODIFIERS.has(peek().v)) m.add(next().v); return m; };
  // `: SEMANTIC`, `: register(c3)`, `: packoffset(...)` (repeatable)
  const annotations = () => {
    let semantic = null, register = null;
    while (is(':')) {
      next();
      const w = ident();
      if (w === 'register') { expect('('); const r = ident(); expect(')'); register = r; } else if (w === 'packoffset') { while (!is(')')) next(); next(); } else semantic = w.toUpperCase();
    }
    return { semantic, register };
  };
  const arraySuffix = (t) => { while (accept('[')) { const n = is(']') ? 0 : +next().v; expect(']'); t = { k: 'array', of: t, len: n }; } return t; };

  // Expressions, by precedence.
  const BIN = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
  const expr = () => { let e = assign(); while (is(',')) { next(); e = { e: 'seq', a: e, b: assign() }; } return e; };
  const assign = () => {
    const l = ternary();
    if (peek().t === 'p' && ASSIGN.has(peek().v)) { const op = next().v; return { e: 'assign', op, l, r: assign() }; }
    return l;
  };
  const ternary = () => {
    const c = binary(0);
    if (!accept('?')) return c;
    const a = assign(); expect(':');
    return { e: 'cond', c, a, b: assign() };
  };
  const binary = (lvl) => {
    if (lvl === BIN.length) return unary();
    let l = binary(lvl + 1);
    while (peek().t === 'p' && BIN[lvl].includes(peek().v)) { const op = next().v; l = { e: 'bin', op, l, r: binary(lvl + 1) }; }
    return l;
  };
  const unary = () => {
    if (peek().t === 'p' && ['-', '+', '!', '~', '++', '--'].includes(peek().v)) { const op = next().v; return { e: 'unary', op, x: unary() }; }
    // a cast: (type) x, (type[n]) not supported
    if (is('(') && isType(1)) {
      const save = i; next(); const t = type();
      if (accept(')')) return { e: 'cast', t, x: unary() };
      i = save;
    }
    return postfix(primary());
  };
  const postfix = (x) => {
    for (;;) {
      if (accept('.')) { x = { e: 'field', x, name: ident() }; continue; }
      if (accept('[')) { const idx = expr(); expect(']'); x = { e: 'index', x, idx }; continue; }
      if (is('++') || is('--')) { x = { e: 'post', op: next().v, x }; continue; }
      return x;
    }
  };
  const args = () => { const a = []; expect('('); if (!is(')')) { do a.push(assign()); while (accept(',')); } expect(')'); return a; };
  const primary = () => {
    const x = peek();
    if (x.t === 'num') { next(); return { e: 'num', v: x.v }; }
    if (is('true') || is('false')) { next(); return { e: 'bool', v: x.v === 'true' }; }
    if (accept('(')) { const e = expr(); expect(')'); return e; }
    if (is('{')) return initList();
    if (isType()) { const t = type(); return { e: 'ctor', t, args: args() }; }
    if (x.t === 'id') { next(); if (is('(')) return { e: 'call', name: x.v, args: args() }; return { e: 'id', name: x.v }; }
    return fail(`unexpected '${x.v}' (token ${i})`);
  };
  const initList = () => { expect('{'); const items = []; while (!is('}')) { items.push(is('{') ? initList() : assign()); if (!accept(',')) break; } expect('}'); return { e: 'list', items }; };

  // Statements.
  const declarators = (t, mods) => {
    const vars = [];
    do {
      const name = ident(); const vt = arraySuffix(t); const ann = annotations();
      let init = null;
      if (accept('=')) {
        if (is('sampler_state')) { next(); expect('{'); let d = 1; while (d) { const v = next().v; if (v === '{') d++; else if (v === '}') d--; } } else init = assign();
      }
      vars.push({ name, type: vt, init, ...ann, mods });
    } while (accept(','));
    return vars;
  };
  const block = () => { expect('{'); const body = []; while (!is('}')) body.push(statement()); expect('}'); return { s: 'block', body }; };
  const statement = () => {
    skipAttributes();
    if (is('{')) return block();
    if (accept(';')) return { s: 'empty' };
    if (accept('if')) { expect('('); const c = expr(); expect(')'); const a = statement(); const b = accept('else') ? statement() : null; return { s: 'if', c, a, b }; }
    if (accept('for')) {
      expect('(');
      let init = null;
      if (!is(';')) { const m = modifiers(); init = isType() ? { s: 'decl', vars: declarators(type(), m) } : { s: 'expr', x: expr() }; }
      expect(';');
      const c = is(';') ? null : expr(); expect(';');
      const step = is(')') ? null : expr(); expect(')');
      return { s: 'for', init, c, step, body: statement() };
    }
    if (accept('while')) { expect('('); const c = expr(); expect(')'); return { s: 'while', c, body: statement() }; }
    if (accept('do')) { const body = statement(); expect('while'); expect('('); const c = expr(); expect(')'); expect(';'); return { s: 'do', body, c }; }
    if (accept('return')) { const x = is(';') ? null : expr(); expect(';'); return { s: 'return', x }; }
    if (accept('break')) { expect(';'); return { s: 'break' }; }
    if (accept('continue')) { expect(';'); return { s: 'continue' }; }
    if (accept('discard')) { expect(';'); return { s: 'discard' }; }
    const m = modifiers();
    if (isType() && (peek(1).t === 'id' || peek(1).v === '<') && !(peek(1).t === 'id' && is('(', 2) && false)) {
      // a declaration: `type name ...` (a constructor call `float3(...)` has '(' after the type)
      if (!is('(', typeName(tk, i, structs)[1])) { const t = type(); const vars = declarators(t, m); expect(';'); return { s: 'decl', vars }; }
    }
    const x = expr(); expect(';');
    return { s: 'expr', x };
  };

  // The top level.
  const globals = [], functions = [], structList = [];
  while (peek().t !== 'eof') {
    if (accept(';')) continue;
    if (is('struct')) {
      next(); const name = ident(); structs.set(name, null); expect('{');
      const fields = [];
      while (!is('}')) { modifiers(); const t = type(); do { const n = ident(); const ft = arraySuffix(t); const ann = annotations(); fields.push({ name: n, type: ft, semantic: ann.semantic }); } while (accept(',')); expect(';'); }
      expect('}'); structs.set(name, fields); structList.push({ name, fields });
      if (!is(';')) fail('a struct declaration with variables is not supported');
      next(); continue;
    }
    if (is('typedef')) fail('typedef is not supported');
    const mods = modifiers();
    const t = type();
    if (peek().t === 'id' && is('(', 1)) {
      const name = ident(); expect('(');
      const params = [];
      while (!is(')')) {
        let dir = 'in';
        for (;;) { if (is('in') || is('out') || is('inout')) dir = next().v; else if (is('uniform') || is('const')) next(); else break; }
        const pt = type(); const pn = ident(); const ptype = arraySuffix(pt); const ann = annotations();
        if (accept('=')) assign();
        params.push({ name: pn, type: ptype, dir, semantic: ann.semantic });
        if (!accept(',')) break;
      }
      expect(')');
      const ann = annotations();
      if (accept(';')) { continue; }                          // a prototype
      functions.push({ name, ret: t, params, semantic: ann.semantic, body: block() });
      continue;
    }
    const vars = declarators(t, mods); expect(';');
    globals.push(...vars);
  }
  return { globals, functions, structs, structList };
}

// ---- the intrinsics -----------------------------------------------------------------------------------
// Elementwise over floats: every argument made a float vector of the widest argument's size.
const ELEMENTWISE = { abs: 'abs', acos: 'acos', asin: 'asin', atan: 'atan', ceil: 'ceil', cos: 'cos', cosh: 'cosh', degrees: 'degrees', exp: 'exp', exp2: 'exp2',
  floor: 'floor', frac: 'fract', log: 'log', log2: 'log2', radians: 'radians', round: 'round', rsqrt: 'inversesqrt', sign: 'sign', sin: 'sin', sinh: 'sinh',
  sqrt: 'sqrt', tan: 'tan', tanh: 'tanh', trunc: 'trunc', ddx: 'dFdx', ddy: 'dFdy', fwidth: 'fwidth',
  atan2: 'atan', max: 'max', min: 'min', pow: 'pow', step: 'step', lerp: 'mix', smoothstep: 'smoothstep', clamp: 'clamp', fmod: 'prism_fmod',
  saturate: 'prism_saturate', log10: 'prism_log10', ldexp: 'prism_ldexp' };
const HELPERS = {
  prism_fmod: 'float prism_fmod(float a, float b) { return a - b * trunc(a / b); }\nvec2 prism_fmod(vec2 a, vec2 b) { return a - b * trunc(a / b); }\nvec3 prism_fmod(vec3 a, vec3 b) { return a - b * trunc(a / b); }\nvec4 prism_fmod(vec4 a, vec4 b) { return a - b * trunc(a / b); }',
  prism_saturate: 'float prism_saturate(float a) { return clamp(a, 0.0, 1.0); }\nvec2 prism_saturate(vec2 a) { return clamp(a, 0.0, 1.0); }\nvec3 prism_saturate(vec3 a) { return clamp(a, 0.0, 1.0); }\nvec4 prism_saturate(vec4 a) { return clamp(a, 0.0, 1.0); }',
  prism_log10: 'float prism_log10(float a) { return log2(a) * 0.30102999566; }\nvec2 prism_log10(vec2 a) { return log2(a) * 0.30102999566; }\nvec3 prism_log10(vec3 a) { return log2(a) * 0.30102999566; }\nvec4 prism_log10(vec4 a) { return log2(a) * 0.30102999566; }',
  prism_ldexp: 'float prism_ldexp(float a, float e) { return a * exp2(e); }\nvec2 prism_ldexp(vec2 a, vec2 e) { return a * exp2(e); }\nvec3 prism_ldexp(vec3 a, vec3 e) { return a * exp2(e); }\nvec4 prism_ldexp(vec4 a, vec4 e) { return a * exp2(e); }',
};
const TEXTURE = { tex1D: ['2D', 'plain'], tex2D: ['2D', 'plain'], tex3D: ['3D', 'plain'], texCUBE: ['Cube', 'plain'],
  tex2Dlod: ['2D', 'lod'], tex3Dlod: ['3D', 'lod'], texCUBElod: ['Cube', 'lod'], tex2Dbias: ['2D', 'bias'], tex3Dbias: ['3D', 'bias'], texCUBEbias: ['Cube', 'bias'],
  tex2Dproj: ['2D', 'proj'], tex3Dproj: ['3D', 'proj'], tex2Dgrad: ['2D', 'grad'], tex3Dgrad: ['3D', 'grad'], texCUBEgrad: ['Cube', 'grad'] };
const COORDS = { '2D': 2, '3D': 3, Cube: 3 };

// ---- the translation ----------------------------------------------------------------------------------
/** The profile's register files: [float constants, shader type]. */
const PROFILES = { ps_2_0: [32, 'ps'], ps_2_a: [32, 'ps'], ps_2_b: [32, 'ps'], ps_3_0: [224, 'ps'], vs_2_0: [256, 'vs'], vs_2_a: [256, 'vs'], vs_3_0: [256, 'vs'] };

/**
 * Translate HLSL `source` with entry point `entry` for `profile` (ps_2_0 .. vs_3_0). Returns
 * { glsl, constants, samplers, inputs, outputs }: the GLSL ES 3.00 source, the constant table
 * ([{ name, regSet, regIndex, regCount, rows, columns, type }], D3DXREGISTER_SET numbering), the
 * samplers ([{ name, index, dim }]), and the stage's inputs and outputs by semantic.
 */
export function translateHLSL(source, entry, profile, defines = []) {
  const prof = PROFILES[profile] ?? fail(`profile ${profile} is not supported`);
  const stage = prof[1];
  const ast = parse(lex(preprocess(source, defines)));
  const fn = ast.functions.filter((f) => f.name === entry);
  if (!fn.length) fail(`entry point ${entry} not found`);
  const main = fn[fn.length - 1];
  const helpers = new Set();

  // Which functions the entry point reaches, and which globals they use: only those are emitted and allocated.
  const byName = new Map();
  for (const f of ast.functions) (byName.get(f.name) ?? byName.set(f.name, []).get(f.name)).push(f);
  const reached = new Set(), usedIds = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.e === 'id') usedIds.add(node.name);
    if (node.e === 'call' && byName.has(node.name)) for (const f of byName.get(node.name)) if (!reached.has(f)) { reached.add(f); walk(f.body); }
    for (const k in node) if (k !== 'type' && typeof node[k] === 'object') walk(node[k]);
  };
  reached.add(main); walk(main.body);
  for (const g of ast.globals) if (g.init && usedIds.has(g.name)) walk(g.init);

  // Generic `sampler`s take their dimension from the texture functions that read them.
  const samplerDim = new Map();
  const dims = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(dims); return; }
    if (node.e === 'call' && TEXTURE[node.name] && node.args[0]?.e === 'id') samplerDim.set(node.args[0].name, TEXTURE[node.name][0]);
    for (const k in node) if (typeof node[k] === 'object') dims(node[k]);
  };
  dims(ast.functions);

  // The registers: explicit ones first, then the used rest in declaration order (fxc's allocation).
  const constants = [], samplers = [];
  const regCount = (t) => (t.k === 'mat' ? t.c : t.k === 'array' ? t.len * regCount(t.of) : 1);   // column-major: a register a column
  const taken = { c: new Set(), i: new Set(), b: new Set(), s: new Set() };
  const uniforms = ast.globals.filter((g) => !g.mods.has('static') && !(g.init && !g.register) && g.type.k !== 'texture');
  const setOf = (g) => (g.type.k === 'sampler' ? 's' : (g.type.k === 'array' ? g.type.of : g.type).b === 'bool' ? 'b' : (g.type.k === 'array' ? g.type.of : g.type).b === 'int' ? 'i' : 'c');
  for (const g of uniforms) if (g.register) {
    const set = g.register[0].toLowerCase(), at = +g.register.slice(1);
    g.reg = { set, at };
    for (let k = 0; k < (set === 's' ? 1 : regCount(g.type)); k++) taken[set].add(at + k);
  }
  for (const g of uniforms) if (!g.reg && usedIds.has(g.name)) {
    const set = setOf(g), n = set === 's' ? 1 : regCount(g.type);
    let at = 0;
    while ([...Array(n).keys()].some((k) => taken[set].has(at + k))) at++;
    for (let k = 0; k < n; k++) taken[set].add(at + k);
    g.reg = { set, at };
  }
  const REGSET = { b: 0, i: 1, c: 2, s: 3 };
  for (const g of uniforms) if (g.reg && usedIds.has(g.name)) {
    const t = g.type.k === 'array' ? g.type.of : g.type;
    if (g.reg.set === 's') samplers.push({ name: g.name, index: g.reg.at, dim: g.type.dim ?? samplerDim.get(g.name) ?? '2D' });
    constants.push({ name: g.name, regSet: REGSET[g.reg.set], regIndex: g.reg.at, regCount: g.reg.set === 's' ? 1 : regCount(g.type),
      rows: t.k === 'mat' ? t.r : 1, columns: t.k === 'mat' ? t.c : t.n ?? 1, type: t.k === 'sampler' ? 'sampler' : t.b ?? 'float', elements: g.type.k === 'array' ? g.type.len : 1 });
  }

  // ---- expressions: { code, type } ----
  const scopes = [new Map()];
  const lookup = (name) => { for (let s = scopes.length - 1; s >= 0; s--) if (scopes[s].has(name)) return scopes[s].get(name); return null; };
  const declare = (name, type) => { scopes[scopes.length - 1].set(name, { type, glsl: `hl_${name}` }); return `hl_${name}`; };
  const fmtFloat = (v) => { v = v.replace(/[fFhHlL]$/, ''); return /[.eE]/.test(v) ? (v.startsWith('.') ? `0${v}` : v.endsWith('.') ? `${v}0` : v) : `${v}.0`; };

  /** `e` (an emitted { code, type }) as type `t`. */
  function conv(e, t) {
    const f = e.type;
    if (same(f, t)) return e.code;
    if (f.k === 'num' && t.k === 'num') {
      if (f.n === 1 && t.n === 1) {
        if (e.lit !== undefined && t.b === 'float') return fmtFloat(e.lit);
        if (e.lit !== undefined && (t.b === 'int' || t.b === 'uint') && /^\d+$/.test(e.lit)) return t.b === 'uint' ? `${e.lit}u` : e.lit;
        return `${t.b}(${e.code})`;
      }
      if (f.n === 1) return `${glslType(t)}(${conv(e, num(t.b))})`;               // broadcast
      const sw = 'xyzw'.slice(0, t.n);
      const part = t.n < f.n ? `(${e.code}).${sw}` : t.n === f.n ? e.code : fail(`cannot widen ${glslType(f)} to ${glslType(t)}`);
      if (t.n === 1) return f.b === t.b ? part : `${t.b}(${part})`;
      return f.b === t.b ? part : `${glslType(t)}(${part})`;
    }
    if (f.k === 'mat' && t.k === 'mat' && f.r >= t.r && f.c >= t.c) return `${glslType(t)}(${e.code})`;
    if (f.k === 'num' && f.n === 1 && t.k === 'mat') return `${glslType(t)}(${conv(e, FLOAT)})`;
    return fail(`cannot convert ${glslType(f)} to ${glslType(t)}`);
  }
  const widest = (types) => {
    let n = 1, b = 'bool';
    for (const t of types) {
      if (t.k !== 'num') return null;
      if (t.n > 1) n = n === 1 ? t.n : Math.min(n, t.n);
      b = t.b === 'float' || b === 'float' ? 'float' : t.b === 'uint' || b === 'uint' ? 'uint' : t.b === 'int' || b === 'int' ? 'int' : 'bool';
    }
    return num(b, n);
  };
  const isLvalue = (x) => x.e === 'id' || x.e === 'field' || x.e === 'index';

  function emit(x) {
    switch (x.e) {
      case 'num': {
        const isF = /[.eEfFhH]/.test(x.v) && !/^0[xX]/.test(x.v);
        if (isF) return { code: fmtFloat(x.v), type: FLOAT, lit: x.v };
        const v = x.v.replace(/[lL]$/, '');
        if (/[uU]$/.test(v)) return { code: v, type: num('uint') };
        return { code: v, type: INT, lit: v };
      }
      case 'bool': return { code: String(x.v), type: BOOL };
      case 'id': {
        const s = lookup(x.name);
        if (!s) return fail(`undeclared identifier ${x.name}`);
        return { code: s.glsl, type: s.type, lvalue: true };
      }
      case 'seq': { const a = emit(x.a), b = emit(x.b); return { code: `(${a.code}, ${b.code})`, type: b.type }; }
      case 'assign': {
        const l = emit(x.l);
        if (x.op === '=') {
          if (x.r.e === 'list') return { code: `(${l.code} = ${listFor(x.r, l.type)})`, type: l.type };
          return { code: `(${l.code} = ${conv(emit(x.r), l.type)})`, type: l.type };
        }
        const r = emit(x.r), op = x.op.slice(0, -1);
        if (op === '%' && l.type.b === 'float') return { code: `(${l.code} = prism_fmod(${l.code}, ${conv(r, l.type)}))`, type: l.type, helper: helpers.add('prism_fmod') };
        // `v op= s`: a scalar stays one (GLSL takes vec op float), anything else is the left side's type
        const rt = r.type.k === 'num' && r.type.n === 1 && l.type.k === 'num' ? num(l.type.b) : l.type;
        return { code: `(${l.code} ${x.op} ${conv(r, rt)})`, type: l.type };
      }
      case 'cond': {
        const c = emit(x.c), a = emit(x.a), b = emit(x.b);
        const t = widest([a.type, b.type]) ?? (same(a.type, b.type) ? a.type : fail('a conditional of mismatched types'));
        if (c.type.k === 'num' && c.type.n > 1) return { code: `mix(${conv(b, num(t.b, c.type.n))}, ${conv(a, num(t.b, c.type.n))}, ${conv(c, num('bool', c.type.n))})`, type: num(t.b, c.type.n) };
        return { code: `(${conv(c, BOOL)} ? ${conv(a, t)} : ${conv(b, t)})`, type: t };
      }
      case 'unary': {
        const v = emit(x.x);
        if (x.op === '!') { const t = num('bool', v.type.n); return { code: t.n === 1 ? `(!${conv(v, t)})` : `not(${conv(v, t)})`, type: t }; }
        if (x.op === '-' || x.op === '+') {
          const t = v.type.k === 'num' && v.type.b === 'bool' ? num('int', v.type.n) : v.type;
          if (v.lit !== undefined && x.op === '-') return { code: `(-${v.code})`, type: t, lit: `-${v.lit}` };
          return { code: `(${x.op}${conv(v, t)})`, type: t };
        }
        return { code: `(${x.op}${v.code})`, type: v.type };
      }
      case 'post': { const v = emit(x.x); return { code: `(${v.code}${x.op})`, type: v.type }; }
      case 'cast': {
        const v = emit(x.x);
        if (v.type.k === 'num' && x.t.k === 'num' && v.type.n > 1 && x.t.n === 1) return { code: conv({ ...v, type: num(v.type.b, v.type.n) }, x.t), type: x.t };
        return { code: conv(v, x.t), type: x.t };
      }
      case 'bin': return binary(x);
      case 'field': return field(x);
      case 'index': {
        const v = emit(x.x), i = emit(x.idx);
        const idx = conv(i, INT);
        if (v.type.k === 'array') return { code: `${v.code}[${idx}]`, type: v.type.of, lvalue: true };
        if (v.type.k === 'mat') return { code: `${v.code}[${idx}]`, type: num(v.type.b, v.type.c), lvalue: true };   // HLSL's row i is GLSL's column i
        if (v.type.k === 'num' && v.type.n > 1) return { code: `${v.code}[${idx}]`, type: num(v.type.b), lvalue: true };
        return fail('indexing a scalar');
      }
      case 'list': return fail('an initialiser list outside a declaration');
      case 'ctor': return ctor(x.t, x.args.map(emit));
      case 'call': return call(x);
      default: return fail(`expression ${x.e}`);
    }
  }
  function field(x) {
    const v = emit(x.x);
    if (v.type.k === 'struct') {
      const f = ast.structs.get(v.type.name).find((m) => m.name === x.name) ?? fail(`${v.type.name} has no member ${x.name}`);
      return { code: `${v.code}.hl_${x.name}`, type: f.type, lvalue: true };
    }
    if (v.type.k === 'num') {
      const sw = x.name;
      if (!/^([xyzw]{1,4}|[rgba]{1,4})$/.test(sw)) fail(`swizzle .${sw}`);
      const idx = [...sw].map((c) => 'xyzwrgba'.indexOf(c) % 4);
      if (idx.some((k) => k >= v.type.n)) fail(`swizzle .${sw} of a ${glslType(v.type)}`);
      if (v.type.n === 1) return { code: sw.length === 1 ? v.code : `${VEC[v.type.b]}${sw.length}(${v.code})`, type: num(v.type.b, sw.length) };
      return { code: `${v.code}.${idx.map((k) => 'xyzw'[k]).join('')}`, type: num(v.type.b, sw.length), lvalue: v.lvalue };
    }
    if (v.type.k === 'mat') {
      // ._11 .. ._44 (1-based) and ._m00 .. ._m33: HLSL element [row][col], GLSL's [col][row] transposed back: G[row][col]
      const parts = x.name.match(/_m?\d\d/g);
      if (!parts || parts.join('') !== x.name) fail(`matrix member .${x.name}`);
      const els = parts.map((p) => { const zero = p.startsWith('_m'); const d = p.slice(zero ? 2 : 1); return [+d[0] - (zero ? 0 : 1), +d[1] - (zero ? 0 : 1)]; });
      const code = els.map(([r, c]) => `${v.code}[${r}][${c}]`);
      return els.length === 1 ? { code: code[0], type: num(v.type.b), lvalue: true } : { code: `${VEC[v.type.b]}${els.length}(${code.join(', ')})`, type: num(v.type.b, els.length) };
    }
    return fail(`a member of ${glslType(v.type)}`);
  }
  function binary(x) {
    const a = emit(x.l), b = emit(x.r), op = x.op;
    if (op === '&&' || op === '||') {
      const t = widest([a.type, b.type]); const bt = num('bool', t.n);
      if (t.n === 1) return { code: `(${conv(a, BOOL)} ${op} ${conv(b, BOOL)})`, type: BOOL };
      return fail('&& and || of vectors');
    }
    if (a.type.k === 'mat' || b.type.k === 'mat') {
      if (!['+', '-', '*', '/'].includes(op)) fail(`${op} on a matrix`);
      const t = a.type.k === 'mat' ? a.type : b.type;
      const ca = a.type.k === 'mat' ? a.code : conv(a, num('float')), cb = b.type.k === 'mat' ? b.code : conv(b, num('float'));
      return { code: op === '*' && a.type.k === 'mat' && b.type.k === 'mat' ? `matrixCompMult(${ca}, ${cb})` : `(${ca} ${op} ${cb})`, type: t };
    }
    const t = widest([a.type, b.type]) ?? fail(`${op} on ${glslType(a.type)} and ${glslType(b.type)}`);
    const arith = t.b === 'bool' && ['+', '-', '*', '/', '%'].includes(op) ? num('int', t.n) : t;
    const side = (e) => conv(e, e.type.n === 1 && !['<', '>', '<=', '>=', '==', '!='].includes(op) ? num(arith.b) : arith);
    if (['<', '>', '<=', '>=', '==', '!='].includes(op)) {
      const ct = t.b === 'bool' && !['==', '!='].includes(op) ? num('int', t.n) : t;
      if (ct.n === 1) return { code: `(${conv(a, ct)} ${op} ${conv(b, ct)})`, type: BOOL };
      const fnName = { '<': 'lessThan', '>': 'greaterThan', '<=': 'lessThanEqual', '>=': 'greaterThanEqual', '==': 'equal', '!=': 'notEqual' }[op];
      return { code: `${fnName}(${conv(a, ct)}, ${conv(b, ct)})`, type: num('bool', ct.n) };
    }
    if (op === '%' && arith.b === 'float') { helpers.add('prism_fmod'); return { code: `prism_fmod(${conv(a, arith)}, ${conv(b, arith)})`, type: arith }; }
    if (['&', '|', '^', '<<', '>>'].includes(op)) { const it = num(arith.b === 'float' ? 'int' : arith.b, arith.n); return { code: `(${conv(a, it)} ${op} ${conv(b, it)})`, type: it }; }
    // vec op scalar is GLSL; a scalar of the other's component type stays a scalar
    const ea = a.type.n === 1 && arith.n > 1 ? conv(a, num(arith.b)) : side(a), eb = b.type.n === 1 && arith.n > 1 ? conv(b, num(arith.b)) : side(b);
    return { code: `(${ea} ${op} ${eb})`, type: arith };
  }
  /** An HLSL constructor: GLSL's takes mixed component types; a matrix's arguments in HLSL's row order, which is GLSL's column order for the transposed matrix. */
  function ctor(t, args) {
    if (t.k === 'num') {
      if (args.length === 1 && args[0].type.k === 'num' && args[0].type.n === 1) return { code: `${glslType(t)}(${conv(args[0], num(t.b))})`, type: t };
      if (args.length === 1 && args[0].type.k === 'num') return { code: conv(args[0], t), type: t };
      return { code: `${glslType(t)}(${args.map((a) => (a.lit !== undefined ? conv(a, num(t.b)) : a.code)).join(', ')})`, type: t };
    }
    if (t.k === 'mat') return { code: `${glslType(t)}(${args.map((a) => (a.type.k === 'num' && a.type.n === 1 ? conv(a, FLOAT) : a.code)).join(', ')})`, type: t };
    if (t.k === 'struct') {
      const fields = ast.structs.get(t.name);
      return { code: `hl_${t.name}(${fields.map((f, k) => conv(args[k], f.type)).join(', ')})`, type: t };
    }
    return fail(`a constructor of ${glslType(t)}`);
  }
  /** An initialiser list as a value of type `t`: its leaves flattened, as HLSL fills a vector or matrix component by component. */
  function listFor(list, t) {
    const leaves = [];
    const flat = (e) => { if (e.e === 'list') e.items.forEach(flat); else leaves.push(emit(e)); };
    if (t.k === 'array') return `${glslType(t.of)}[${t.len || list.items.length}](${list.items.map((it) => (it.e === 'list' ? listFor(it, t.of) : conv(emit(it), t.of))).join(', ')})`;
    if (t.k === 'struct') { const fields = ast.structs.get(t.name); return `hl_${t.name}(${list.items.map((it, k) => (it.e === 'list' ? listFor(it, fields[k].type) : conv(emit(it), fields[k].type))).join(', ')})`; }
    list.items.forEach(flat);
    if (t.k === 'num' && t.n === 1) return conv(leaves[0], t);
    return ctor(t, leaves).code;
  }
  function call(x) {
    const name = x.name;
    // the shader's own functions
    if (byName.has(name)) {
      const args = x.args.map(emit);
      const cands = byName.get(name).filter((f) => f.params.length === args.length);
      if (!cands.length) fail(`no ${name} takes ${args.length} arguments`);
      const score = (f) => f.params.reduce((s, p, k) => s + (same(p.type, args[k].type) ? 0 : p.type.k === 'num' && args[k].type.k === 'num' ? (p.type.n === args[k].type.n ? 1 : 2) : 9), 0);
      const f = cands.sort((p, q) => score(p) - score(q))[0];
      return { code: `${fnName(f)}(${f.params.map((p, k) => (p.dir === 'in' ? conv(args[k], p.type) : args[k].code)).join(', ')})`, type: f.ret };
    }
    const args = x.args.map(emit);
    if (ELEMENTWISE[name]) {
      const t = widest(args.map((a) => a.type)) ?? fail(`${name} of a non-numeric argument`);
      const ft = num('float', t.n);
      const g = ELEMENTWISE[name];
      if (g.startsWith('prism_')) helpers.add(g);
      if (name === 'abs' && t.b === 'int') return { code: `abs(${conv(args[0], num('int', t.n))})`, type: num('int', t.n) };
      if ((name === 'max' || name === 'min' || name === 'clamp') && t.b === 'int') return { code: `${g}(${args.map((a) => conv(a, num('int', t.n))).join(', ')})`, type: num('int', t.n) };
      return { code: `${g}(${args.map((a) => conv(a, ft)).join(', ')})`, type: ft };
    }
    if (TEXTURE[name]) {
      const [dim, kind] = TEXTURE[name];
      const s = args[0], n = COORDS[dim];
      const coord = (e, k) => conv(e, num('float', k));
      const c = name === 'tex1D' ? `vec2(${coord(args[1], 1)}, 0.5)` : null;
      if (kind === 'plain') return { code: args.length === 4 ? `textureGrad(${s.code}, ${c ?? coord(args[1], n)}, ${coord(args[2], n === 3 ? 3 : 2)}, ${coord(args[3], n === 3 ? 3 : 2)})` : `texture(${s.code}, ${c ?? coord(args[1], n)})`, type: num('float', 4) };
      const t4 = conv(args[1], num('float', 4));
      if (kind === 'lod') return { code: `textureLod(${s.code}, (${t4}).${'xyz'.slice(0, n)}, (${t4}).w)`, type: num('float', 4) };
      if (kind === 'bias') return { code: `texture(${s.code}, (${t4}).${'xyz'.slice(0, n)}, (${t4}).w)`, type: num('float', 4) };
      if (kind === 'proj') return { code: n === 2 ? `textureProj(${s.code}, ${t4})` : `texture(${s.code}, (${t4}).xyz / (${t4}).w)`, type: num('float', 4) };
      return { code: `textureGrad(${s.code}, ${coord(args[1], n)}, ${coord(args[2], n)}, ${coord(args[3], n)})`, type: num('float', 4) };
    }
    const pair = () => { const [a, b] = args; const t = widest([a.type, b.type]); return [conv(a, num('float', t.n)), conv(b, num('float', t.n)), t.n]; };
    switch (name) {
      case 'dot': { const [a, b, n] = pair(); return { code: n === 1 ? `(${a} * ${b})` : `dot(${a}, ${b})`, type: FLOAT }; }
      case 'distance': { const [a, b, n] = pair(); return { code: n === 1 ? `abs(${a} - ${b})` : `distance(${a}, ${b})`, type: FLOAT }; }
      case 'length': return { code: args[0].type.n === 1 ? `abs(${conv(args[0], FLOAT)})` : `length(${conv(args[0], num('float', args[0].type.n))})`, type: FLOAT };
      case 'normalize': return { code: `normalize(${conv(args[0], num('float', args[0].type.n))})`, type: num('float', args[0].type.n) };
      case 'cross': return { code: `cross(${conv(args[0], num('float', 3))}, ${conv(args[1], num('float', 3))})`, type: num('float', 3) };
      case 'reflect': { const [a, b, n] = pair(); return { code: `reflect(${a}, ${b})`, type: num('float', n) }; }
      case 'refract': { const [a, b, n] = pair(); return { code: `refract(${a}, ${b}, ${conv(args[2], FLOAT)})`, type: num('float', n) }; }
      case 'faceforward': { const t = widest(args.map((a) => a.type)); const ft = num('float', t.n); return { code: `faceforward(${args.map((a) => conv(a, ft)).join(', ')})`, type: ft }; }
      case 'all': case 'any': { const t = args[0].type; return { code: t.n === 1 ? conv(args[0], BOOL) : `${name}(${conv(args[0], num('bool', t.n))})`, type: BOOL }; }
      case 'transpose': return { code: `transpose(${args[0].code})`, type: { ...args[0].type, r: args[0].type.c, c: args[0].type.r } };
      case 'determinant': return { code: `determinant(${args[0].code})`, type: FLOAT };
      case 'isnan': case 'isinf': { const n = args[0].type.n; return { code: `${name}(${conv(args[0], num('float', n))})`, type: num('bool', n) }; }
      case 'mul': return mul(args[0], args[1]);
      case 'asfloat': return { code: `intBitsToFloat(${conv(args[0], num('int', args[0].type.n))})`, type: num('float', args[0].type.n) };
      case 'asint': return { code: `floatBitsToInt(${conv(args[0], num('float', args[0].type.n))})`, type: num('int', args[0].type.n) };
      case 'asuint': return { code: `floatBitsToUint(${conv(args[0], num('float', args[0].type.n))})`, type: num('uint', args[0].type.n) };
      default: return fail(`intrinsic ${name} is not supported`);
    }
  }
  /** mul: HLSL's row vectors and matrices, GLSL's transposed ones (see the header). */
  function mul(a, b) {
    const A = a.type, B = b.type;
    if (A.k === 'num' && B.k === 'num') {
      if (A.n === 1 || B.n === 1) { const t = widest([A, B]); return { code: `(${conv(a, num('float', A.n === 1 ? 1 : t.n))} * ${conv(b, num('float', B.n === 1 ? 1 : t.n))})`, type: num('float', t.n) }; }
      const n = Math.min(A.n, B.n); return { code: `dot(${conv(a, num('float', n))}, ${conv(b, num('float', n))})`, type: FLOAT };
    }
    if (A.k === 'num' && B.k === 'mat') {
      if (A.n === 1) return { code: `(${conv(a, FLOAT)} * ${b.code})`, type: B };
      return { code: `(${b.code} * ${conv(a, num('float', B.r))})`, type: num('float', B.c) };          // v·M = G*v
    }
    if (A.k === 'mat' && B.k === 'num') {
      if (B.n === 1) return { code: `(${a.code} * ${conv(b, FLOAT)})`, type: A };
      return { code: `(${conv(b, num('float', A.c))} * ${a.code})`, type: num('float', A.r) };          // M·v = v*G
    }
    if (A.k === 'mat' && B.k === 'mat') return { code: `(${b.code} * ${a.code})`, type: { k: 'mat', b: 'float', r: A.r, c: B.c } };  // (AB)^T = B^T A^T
    return fail('mul of these types');
  }
  const fnName = (f) => (f === main ? 'prism_entry' : `hl_${f.name}`);

  // ---- statements ----
  const out = [];
  let indent = '  ', retType = VOID;
  const line = (s) => out.push(indent + s);
  function decl(v) {
    const g = declare(v.name, v.type);
    const t = glslType(v.type), arr = v.type.k === 'array' ? `[${v.type.len}]` : '';
    if (!v.init) return `${t} ${g}${arr}`;
    return `${t} ${g}${arr} = ${v.init.e === 'list' ? listFor(v.init, v.type) : conv(emit(v.init), v.type)}`;
  }
  function stmt(s) {
    switch (s.s) {
      case 'block': line('{'); scopes.push(new Map()); indent += '  '; s.body.forEach(stmt); indent = indent.slice(2); scopes.pop(); line('}'); break;
      case 'empty': break;
      case 'decl': for (const v of s.vars) line(`${decl(v)};`); break;
      case 'expr': {
        // clip(x) and sincos(x, s, c) are statements here
        if (s.x.e === 'call' && s.x.name === 'clip') { const a = emit(s.x.args[0]); line(a.type.n === 1 ? `if (${conv(a, FLOAT)} < 0.0) discard;` : `if (any(lessThan(${conv(a, num('float', a.type.n))}, vec${a.type.n}(0.0)))) discard;`); break; }
        if (s.x.e === 'call' && s.x.name === 'sincos') {
          const [v, sn, cs] = s.x.args.map(emit);
          line(`${sn.code} = sin(${conv(v, sn.type)}); ${cs.code} = cos(${conv(v, cs.type)});`); break;
        }
        line(`${emit(s.x).code};`); break;
      }
      case 'if': {
        line(`if (${conv(emit(s.c), BOOL)})`); sub(s.a);
        if (s.b) { line('else'); sub(s.b); }
        break;
      }
      case 'for': {
        scopes.push(new Map());
        const init = !s.init ? '' : s.init.s === 'decl' ? s.init.vars.map((v, k) => (k ? decl(v).replace(/^\S+ /, '') : decl(v))).join(', ') : emit(s.init.x).code;
        line(`for (${init}; ${s.c ? conv(emit(s.c), BOOL) : ''}; ${s.step ? emit(s.step).code : ''})`); sub(s.body);
        scopes.pop(); break;
      }
      case 'while': line(`while (${conv(emit(s.c), BOOL)})`); sub(s.body); break;
      case 'do': line('do'); sub(s.body); line(`while (${conv(emit(s.c), BOOL)});`); break;
      case 'return': line(s.x ? `return ${s.x.e === 'list' ? listFor(s.x, retType) : conv(emit(s.x), retType)};` : 'return;'); break;
      case 'break': case 'continue': line(`${s.s};`); break;
      case 'discard': line(stage === 'ps' ? 'discard;' : fail('discard in a vertex shader')); break;
      default: fail(`statement ${s.s}`);
    }
  }
  const sub = (s) => { if (s.s === 'block') stmt(s); else { line('{'); scopes.push(new Map()); indent += '  '; stmt(s); indent = indent.slice(2); scopes.pop(); line('}'); } };

  // ---- the program ----
  // Globals: each a GLSL global, uniform ones filled from the registers and static ones initialised, at
  // the top of main (GLSL ES wants constant global initialisers).
  const head = [], init = [];
  for (const g of ast.globals) {
    if (g.type.k === 'texture') continue;
    if (g.type.k === 'sampler') {
      const sm = samplers.find((s) => s.name === g.name);
      if (sm) scopes[0].set(g.name, { type: { k: 'sampler', dim: sm.dim }, glsl: `prism_s${sm.index}` });
      continue;
    }
    if (!usedIds.has(g.name)) { scopes[0].set(g.name, { type: g.type, glsl: `hl_${g.name}` }); continue; }
    const t = g.type;
    head.push(`${glslType(t)} hl_${g.name}${t.k === 'array' ? `[${t.len}]` : ''};`);
    scopes[0].set(g.name, { type: t, glsl: `hl_${g.name}` });
    if (g.reg) {
      const file = g.reg.set === 'c' ? 'prism_c' : g.reg.set === 'i' ? 'prism_i' : 'prism_b';
      const one = (et, at) => {
        const r = `${file}[${at}]`;
        if (et.k === 'mat') {
          // column-major (fxc's default): register k is column k of the HLSL matrix, i.e. row k of the GLSL one
          const cols = [...Array(et.c).keys()].map((k) => `${file}[${at + k}].${'xyzw'.slice(0, et.r)}`);
          return g.mods.has('row_major') ? fail('row_major matrices are not supported yet') : `transpose(mat${et.c === et.r ? et.r : `${et.c}x${et.r}`}(${cols.join(', ')}))`;
        }
        if (g.reg.set === 'b') return `${r} != 0`;
        return et.n === 4 ? r : `${r}.${'xyzw'.slice(0, et.n)}`;
      };
      if (t.k === 'array') for (let k = 0; k < t.len; k++) init.push(`hl_${g.name}[${k}] = ${one(t.of, g.reg.at + k * regCount(t.of))};`);
      else init.push(`hl_${g.name} = ${one(t, g.reg.at)};`);
    } else if (g.init) init.push({ g });
  }
  // Static initialisers, emitted with their globals in scope.
  const initLines = init.map((it) => (typeof it === 'string' ? it : `hl_${it.g.name} = ${it.g.init.e === 'list' ? listFor(it.g.init, it.g.type) : conv(emit(it.g.init), it.g.type)};`));

  // Structs.
  const structCode = ast.structList.map((st) => `struct hl_${st.name} { ${st.fields.map((f) => `${glslType(f.type)} hl_${f.name}${f.type.k === 'array' ? `[${f.type.len}]` : ''};`).join(' ')} };`);

  // Functions, in source order, those the entry point reaches.
  const fnCode = [];
  for (const f of ast.functions) {
    if (!reached.has(f)) continue;
    scopes.push(new Map());
    const params = f.params.map((p) => `${p.dir === 'in' ? '' : `${p.dir} `}${glslType(p.type)} ${declare(p.name, p.type)}${p.type.k === 'array' ? `[${p.type.len}]` : ''}`);
    retType = f.ret;
    out.length = 0; indent = '  ';
    f.body.body.forEach(stmt);
    fnCode.push(`${glslType(f.ret)} ${fnName(f)}(${params.join(', ')}) {\n${out.join('\n')}\n}`);
    scopes.pop();
  }

  // The stage's interface: the entry point's parameters and result by semantic.
  const inputs = [], outputs = [], ins = [], mainArgs = [], outDecl = [], after = [];
  const inputFor = (sem, t) => {
    const m = /^([A-Z_]+?)(\d*)$/.exec(sem); const base = m[1], idx = +(m[2] || 0);
    if (stage === 'ps') {
      if (base === 'VPOS' || base === 'SV_POSITION') return conv({ code: 'vec4(gl_FragCoord.xy - 0.5, gl_FragCoord.z, 1.0 / gl_FragCoord.w)', type: num('float', 4) }, t);
      if (base === 'VFACE') return conv({ code: '(gl_FrontFacing ? 1.0 : -1.0)', type: FLOAT }, t);
      if (base === 'TEXCOORD' || base === 'COLOR') {
        const name = `prism_${base === 'COLOR' ? 'col' : 't'}${idx}`;
        if (!inputs.some((x) => x.name === name)) { inputs.push({ semantic: base, index: idx, name }); ins.push(`in vec4 ${name};`); }
        return conv({ code: name, type: num('float', 4) }, t);
      }
    } else {
      const name = `prism_a_${base.toLowerCase()}${idx}`;
      if (!inputs.some((x) => x.name === name)) { inputs.push({ semantic: base, index: idx, name }); ins.push(`in vec4 ${name};`); }
      return conv({ code: name, type: num('float', 4) }, t);
    }
    return fail(`input semantic ${sem}`);
  };
  const outputFor = (sem, t, code) => {
    const m = /^([A-Z_]+?)(\d*)$/.exec(sem); const base = m[1], idx = +(m[2] || 0);
    if (stage === 'ps') {
      if (base === 'COLOR' || base === 'SV_TARGET') { outputs.push({ semantic: 'COLOR', index: idx }); outDecl.push(`layout(location = ${idx}) out vec4 prism_o${idx};`); after.push(`prism_o${idx} = ${conv({ code, type: t }, num('float', 4))};`); return; }
      if (base === 'DEPTH') { after.push(`gl_FragDepth = ${conv({ code, type: t }, FLOAT)};`); return; }
    } else {
      if (base === 'POSITION' || base === 'SV_POSITION') { outputs.push({ semantic: 'POSITION', index: 0 }); after.push(`prism_pos = ${conv({ code, type: t }, num('float', 4))};`); return; }
      if (base === 'TEXCOORD' || base === 'COLOR') { const name = `prism_${base === 'COLOR' ? 'col' : 't'}${idx}`; outputs.push({ semantic: base, index: idx, name }); outDecl.push(`out vec4 ${name};`); after.push(`${name} = ${widen(code, t)};`); return; }
      if (base === 'PSIZE') { after.push(`gl_PointSize = ${conv({ code, type: t }, FLOAT)};`); return; }
      if (base === 'FOG') return;
    }
    fail(`output semantic ${sem}`);
  };
  // A vertex output of fewer than four components, padded as D3D pads an unwritten one (0, 0, 0, 1).
  const widen = (code, t) => (t.k === 'num' && t.n < 4 ? `vec4(${t.n === 1 ? conv({ code, type: t }, FLOAT) : conv({ code, type: t }, num('float', t.n))}, ${['0.0, 0.0, 1.0', '0.0, 1.0', '1.0'][t.n - 1]})` : conv({ code, type: t }, num('float', 4)));
  const locals = [];
  main.params.forEach((p, k) => {
    const local = `prism_arg${k}`;
    if (p.type.k === 'struct') {
      const fields = ast.structs.get(p.type.name);
      locals.push(`${glslType(p.type)} ${local};`);
      if (p.dir !== 'out') for (const f of fields) locals.push(`${local}.hl_${f.name} = ${inputFor(f.semantic ?? fail(`${p.type.name}.${f.name} has no semantic`), f.type)};`);
      if (p.dir !== 'in') for (const f of fields) outputFor(f.semantic, f.type, `${local}.hl_${f.name}`);
    } else {
      locals.push(`${glslType(p.type)} ${local}${p.dir === 'out' ? '' : ` = ${inputFor(p.semantic ?? fail(`parameter ${p.name} has no semantic`), p.type)}`};`);
      if (p.dir !== 'in') outputFor(p.semantic, p.type, local);
    }
    mainArgs.push(local);
  });
  let callLine = `prism_entry(${mainArgs.join(', ')});`;
  if (main.ret.k === 'struct') {
    callLine = `${glslType(main.ret)} prism_r = ${callLine}`;
    for (const f of ast.structs.get(main.ret.name)) outputFor(f.semantic ?? fail(`${main.ret.name}.${f.name} has no semantic`), f.type, `prism_r.hl_${f.name}`);
  } else if (main.ret.k !== 'void') {
    callLine = `${glslType(main.ret)} prism_r = ${callLine}`;
    outputFor(main.semantic ?? fail(`${entry} returns a value with no semantic`), main.ret, 'prism_r');
  }

  const files = [];
  if (taken.c.size || constants.some((c) => c.regSet === 2)) files.push(`uniform vec4 prism_c[${prof[0]}];`);
  if (constants.some((c) => c.regSet === 1)) files.push('uniform ivec4 prism_i[16];');
  if (constants.some((c) => c.regSet === 0)) files.push('uniform int prism_b[16];');
  for (const s of samplers) files.push(`uniform highp sampler${s.dim} prism_s${s.index};`);
  if (stage === 'vs') files.push('uniform vec4 prism_posFix;');
  const glsl = [
    '#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler3D;', 'precision highp samplerCube;',
    ...files, ...ins, ...outDecl, ...structCode, ...head, ...[...helpers].map((h) => HELPERS[h]), ...fnCode,
    'void main() {', ...initLines.map((l) => `  ${l}`), ...locals.map((l) => `  ${l}`), `  ${callLine}`,
    ...(stage === 'vs' ? ['  vec4 prism_pos = vec4(0.0);'] : []), ...after.map((l) => `  ${l}`),
    // D3D's clip space to GL's: z from [0, w] to [-w, w], and the half-pixel offset and row order (prism_posFix)
    ...(stage === 'vs' ? ['  gl_Position = vec4(prism_pos.xy * prism_posFix.xy + prism_posFix.zw * prism_pos.w, prism_pos.z * 2.0 - prism_pos.w, prism_pos.w);'] : []),
    '}', ''].join('\n');
  // A vertex shader declares prism_pos before what assigns it.
  const fixed = stage === 'vs' ? glsl.replace(/(  [^\n]*prism_entry\([^\n]*\n)(  vec4 prism_pos = vec4\(0\.0\);\n)/, '$2$1') : glsl;
  return { glsl: fixed, constants, samplers, inputs, outputs };
}

// ---- the blob D3DXCompileShader returns (the host's d3dx9) --------------------------------------------
// [version token][comment 0x0000FFFE | n << 16]['PRSM'][entry NUL source NUL, zero-padded][0x0000FFFF]
export const PRSM = 0x4d535250;
const PROFILE_OF = { 0xffff0200: 'ps_2_0', 0xffff0300: 'ps_3_0', 0xfffe0200: 'vs_2_0', 0xfffe0300: 'vs_3_0', 0xffff0201: 'ps_2_a', 0xfffe0201: 'vs_2_a' };
/** The HLSL a blob carries, or null for real bytecode: { profile, entry, source }. */
export function blobHLSL(tokens) {
  if ((tokens[1] & 0xffff) !== 0xfffe || tokens[2] !== PRSM) return null;
  const n = tokens[1] >>> 16;
  const bytes = new Uint8Array(tokens.buffer, tokens.byteOffset + 12, (n - 1) * 4);
  const text = new TextDecoder('latin1').decode(bytes);
  const [entry, source] = text.split('\0');
  const profile = PROFILE_OF[tokens[0] >>> 0] ?? fail(`version token 0x${(tokens[0] >>> 0).toString(16)}`);
  return { profile, entry, source };
}
/** The blob for (profile, entry, source): what a test, or a d3dx9 written in JS, hands to createPixelShader. */
export function makeBlob(profile, entry, source) {
  const version = Object.entries(PROFILE_OF).find(([, p]) => p === profile)?.[0] ?? fail(`profile ${profile}`);
  const text = new TextEncoder().encode(`${entry}\0${source}\0`);
  const words = Math.ceil(text.length / 4);
  const out = new Uint32Array(4 + words);
  out[0] = +version; out[1] = 0xfffe | ((words + 1) << 16); out[2] = PRSM;
  new Uint8Array(out.buffer, 12, words * 4).set(text);
  out[3 + words] = 0xffff;
  return out;
}
/** ID3DXConstantTable's entries for a blob (see translateHLSL). */
export function hlslConstants(tokens) {
  const h = blobHLSL(tokens);
  if (!h) return fail('a constant table for real bytecode (its CTAB comment) is not supported yet');
  return translateHLSL(h.source, h.entry, h.profile).constants;
}
