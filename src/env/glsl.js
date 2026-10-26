// glsl.js — a desktop GLSL fragment shader (OpenGL 2.0/2.1: GLSL 1.10 and 1.20, the compatibility
// built-ins) rewritten as a GLSL ES 3.00 one, which is what WebGL2 compiles. gl.js's WebGL rasteriser
// runs it in place of its own fixed-function fragment shader, fed the same interpolated values.
//
// The rewrite works on tokens, not on a syntax tree: the languages are the same but for
//   - the built-ins of the compatibility profile, which ES does not have: gl_FragColor and gl_FragData[0]
//     become an `out vec4`, gl_Color, gl_TexCoord[0] and gl_FogFragCoord inputs from the fixed vertex
//     stage, under names a program cannot have (prism_*) — a shader may well call its own variable `v`;
//   - the texture functions (texture2D, textureCube, shadow2D... become texture, texture2DProj
//     textureProj), `varying` (in), and the #version line;
//   - the leniency of the desktop drivers the intros of 2007-2010 were written on: an integer literal
//     where a float is wanted (`cos(pos.x*3)`, `vec2(320,240)/2`). GLSL 1.10 never allowed it; NVIDIA's
//     compiler accepted it, so shaders shipped with it, and GLSL ES refuses it. A literal becomes a
//     float unless its context is integer: an index between brackets, an int/ivec constructor, the
//     initialiser or an operand beside a variable declared int (a loop counter: `i<75`, `i+=1`).
// What it cannot rewrite it leaves, and WebGL's compiler then says so.

const INT_TYPES = new Set(['int', 'ivec2', 'ivec3', 'ivec4', 'uint', 'uvec2', 'uvec3', 'uvec4', 'bool']);
const TEXTURE = { texture1D: 'texture', texture2D: 'texture', texture3D: 'texture', textureCube: 'texture', shadow2D: 'texture',
  texture2DProj: 'textureProj', texture3DProj: 'textureProj', texture2DLod: 'textureLod', textureCubeLod: 'textureLod', shadow2DProj: 'textureProj' };

/** The tokens of a GLSL source: comments dropped, preprocessor lines kept whole, whitespace kept. */
function tokens(src) {
  const out = [];
  const re = /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|(^[ \t]*#[^\n]*)|(\s+)|([A-Za-z_][A-Za-z0-9_]*)|((?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fFuU]?|0[xX][0-9a-fA-F]+[uU]?)|(<<=|>>=|\+\+|--|<=|>=|==|!=|&&|\|\||\^\^|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|[^\s])/gm;
  for (let m; (m = re.exec(src));) {
    if (m[1] || m[2]) { out.push({ t: 'ws', v: ' ' }); continue; }
    if (m[3]) out.push({ t: 'pp', v: m[3] });
    else if (m[4]) out.push({ t: 'ws', v: m[4] });
    else if (m[5]) out.push({ t: 'id', v: m[5] });
    else if (m[6]) out.push({ t: 'num', v: m[6] });
    else out.push({ t: 'op', v: m[7] });
  }
  return out;
}

const isIntLiteral = (v) => /^(\d+|0[xX][0-9a-fA-F]+)[uU]?$/.test(v);

const QUALIFIERS = new Set(['const', 'uniform', 'in', 'out', 'varying', 'attribute', 'precision', 'struct']);

/** A global's initialiser that is not a constant expression — `vec2 v=(gl_FragCoord.xy-...)/...;`, which
 *  desktop drivers ran once per fragment before main and GLSL ES refuses — becomes an assignment at the
 *  start of main, in the order of the declarations; the functions above main run only after it. */
function hoistGlobals(src) {
  const tk = tokens(src), out = [], moved = [];
  let depth = 0, start = 0;
  const text = (a, b) => tk.slice(a, b).map((x) => x.v).join('');
  // Constant initialisers stay where they are (`float s = 0.4;` is legal in ES too); anything that reads
  // a variable or calls a function moves.
  const isConstInit = (toks) => toks.slice(toks.findIndex((x) => x.v === '=') + 1).every((x) => x.t === 'num' || /^[-+*\/().,]$/.test(x.v) || /^(vec[234]|mat[234]|float|int)$/.test(x.v));
  for (let i = 0; i < tk.length; i++) {
    const v = tk[i].v;
    if (v === '{') depth++;
    else if (v === '}') { depth--; if (depth === 0) { out.push(text(start, i + 1)); start = i + 1; } }
    else if (v === ';' && depth === 0) {
      const stmt = tk.slice(start, i), sig = stmt.filter((x) => x.t !== 'ws');
      const isDecl = sig.length > 2 && sig[0].t === 'id' && !QUALIFIERS.has(sig[0].v) && sig.some((x) => x.v === '=') && !(sig[2] && sig[2].v === '(');
      if (!isDecl || isConstInit(sig)) { out.push(text(start, i + 1)); start = i + 1; continue; }
      // `type a = E, b = F;` -> `type a, b;` and `a = E; b = F;` for main
      const names = [], inits = [];
      let cur = null, pdepth = 0;
      for (let k = 1; k < sig.length; k++) {
        const y = sig[k];
        if (y.v === '(' || y.v === '[') pdepth++;
        if (y.v === ')' || y.v === ']') pdepth--;
        if (pdepth === 0 && y.v === ',') { cur = null; continue; }
        if (!cur) { cur = { name: y.v, init: [] }; names.push(cur); continue; }
        if (pdepth === 0 && y.v === '=' && !cur.eq) { cur.eq = true; continue; }
        if (cur.eq) cur.init.push(y); else cur.name += y.v;   // an array size: name[3]
      }
      out.push(`${sig[0].v} ${names.map((d) => d.name).join(', ')};`);
      // the initialiser's tokens as they were, a space only between two words that would otherwise merge
      const join = (ts) => ts.map((t, j) => (j && /^[\w.]/.test(t.v) && /[\w.]$/.test(ts[j - 1].v) && (t.t !== 'op') && (ts[j - 1].t !== 'op') ? ' ' : '') + t.v).join('');
      for (const d of names) if (d.eq) inits.push(`${d.name.replace(/\[.*$/, '')}=${join(d.init)};`);
      moved.push(...inits);
      start = i + 1;
    }
  }
  out.push(text(start, tk.length));
  let res = out.join('');
  if (moved.length) res = res.replace(/(\bvoid\s+main\s*\(\s*(?:void)?\s*\)\s*\{)/, `$1${moved.join('')}`);
  return res;
}

/** Translate a desktop GLSL fragment shader into GLSL ES 3.00. Returns { source, uniforms } — the
 *  uniforms as name -> type, as the shader declares them. */
export function translateFragment(src) {
  const tk = tokens(hoistGlobals(src));
  const sig = [];                                   // indices of the significant tokens (not whitespace)
  tk.forEach((x, i) => { if (x.t !== 'ws') sig.push(i); });
  const at = (k) => (k >= 0 && k < sig.length ? tk[sig[k]] : null);
  // The identifiers declared with an integer type, anywhere (a loop counter, a parameter, a local).
  const ints = new Set(), uniforms = {};
  for (let k = 0; k < sig.length; k++) {
    const x = at(k);
    if (x.t === 'id' && INT_TYPES.has(x.v)) {
      // `int a = 1, b;` — every name in the declarator list, until `;` or `)` at the same depth
      for (let j = k + 1, depth = 0; j < sig.length; j++) {
        const y = at(j);
        if (y.v === '(' || y.v === '[') depth++;
        else if (y.v === ')' || y.v === ']') { if (depth === 0) break; depth--; }
        else if ((y.v === ';' || y.v === '{') && depth === 0) break;
        if (y.t === 'id' && depth === 0 && (at(j - 1).v === ',' || j === k + 1)) ints.add(y.v);
      }
    }
    if (x.t === 'id' && x.v === 'uniform') {
      let j = k + 1; while (at(j) && ['lowp', 'mediump', 'highp'].includes(at(j).v)) j++;
      const type = at(j) && at(j).v;
      for (j++; at(j) && at(j).v !== ';'; j++) if (at(j).t === 'id' && (at(j - 1).v === type || at(j - 1).v === ',')) uniforms[at(j).v] = type;
    }
  }
  // Integer context of the significant token k: inside [...], inside an int constructor's parentheses,
  // or beside an integer variable through an operator (a < 75, i += 1, n * 2).
  const intCtx = (k) => {
    for (let j = k - 1, depth = 0; j >= 0; j--) {          // the innermost open bracket or parenthesis
      const y = at(j).v;
      if (y === ')' || y === ']') depth++;
      else if (y === '(' || y === '[') {
        if (depth) { depth--; continue; }
        if (y === '[') return true;
        const f = at(j - 1);
        if (f && f.t === 'id' && INT_TYPES.has(f.v)) return true;
        break;
      } else if ((y === ';' || y === '{' || y === '}' || y === ',') && depth === 0) break;
    }
    const OPS = new Set(['<', '>', '<=', '>=', '==', '!=', '=', '+', '-', '*', '/', '%', '+=', '-=', '*=', '/=', '%=', '<<', '>>', '&', '|', '^']);
    for (const d of [-1, 1]) {
      const op = at(k + d), side = at(k + 2 * d);
      if (op && OPS.has(op.v) && side) {
        if (side.t === 'id' && ints.has(side.v) && !converted.has(k + 2 * d) && !(at(k + 3 * d) && at(k + 3 * d).v === '.')) return true;
        if (side.t === 'num' && isIntLiteral(side.v) && d === -1 && at(k - 3) && ints.has(at(k - 3).v)) return true;
      }
    }
    // the initialiser of an int declaration: `int i = 0`, `int n = 3`
    if (at(k - 1) && at(k - 1).v === '=' && at(k - 2) && ints.has(at(k - 2).v)) return true;
    // a `case` label, a `return` in a function declared int (rare in the intros) — left as integers
    if (at(k - 1) && at(k - 1).v === 'case') return true;
    return false;
  };
  // An integer variable beside a float through an arithmetic operator: `vec3(...)*c/75.0` (c an int
  // counter) — the desktop compilers converted it, GLSL ES wants float(c). Not its declaration, not a
  // comparison or an assignment of its own (`c<200`, `c++`), not beside another integer.
  const ARITH = new Set(['*', '/', '+', '-']);
  const floatNeighbour = (k) => {
    const prev = at(k - 1), next = at(k + 1);
    if (prev && prev.t === 'id' && INT_TYPES.has(prev.v)) return false;            // the declaration
    for (const [op, side] of [[at(k - 1), at(k - 2)], [at(k + 1), at(k + 2)]]) {
      if (!op || !ARITH.has(op.v) || !side) continue;
      if (side.t === 'num') { if (!isIntLiteral(side.v)) return true; continue; }
      if (side.t === 'id' && ints.has(side.v)) continue;
      if (side.v === ')' || side.v === ']' || side.t === 'id') return true;
    }
    return false;
  };
  // Which integer variables become float(...), decided before the literals beside them are: in `s*c/8`
  // c is converted, so 8 is beside a float and becomes 8.0.
  const converted = new Set();
  for (let k = 0; k < sig.length; k++) { const x = at(k); if (x.t === 'id' && ints.has(x.v) && floatNeighbour(k) && !intCtx(k)) converted.add(k); }
  const out = [];
  for (let i = 0, k = 0; i < tk.length; i++) {
    const x = tk[i];
    if (x.t === 'ws') { out.push(x.v); continue; }
    k = sig.indexOf(i, k);
    if (x.t === 'pp') { if (!/^\s*#\s*version\b/.test(x.v)) out.push(x.v + '\n'); continue; }
    if (x.t === 'num' && isIntLiteral(x.v) && !/^0[xX]/.test(x.v) && !/[uU]$/.test(x.v) && !intCtx(k)) { out.push(x.v + '.0'); continue; }
    if (converted.has(k)) { out.push(`float(${x.v})`); continue; }
    if (x.t === 'id') {
      if (x.v === 'gl_FragColor') { out.push('prism_FragColor'); continue; }
      if (x.v === 'gl_FragData') {                           // gl_FragData[0]: the one colour output
        const a = at(k + 1), b = at(k + 2), c = at(k + 3);
        if (a && a.v === '[' && b && b.v === '0' && c && c.v === ']') { out.push('prism_FragColor'); i = sig[k + 3]; continue; }
      }
      if (x.v === 'gl_Color') { out.push('prism_Color'); continue; }
      if (x.v === 'gl_SecondaryColor') { out.push('vec4(0.0)'); continue; }
      if (x.v === 'gl_FogFragCoord') { out.push('prism_FogFragCoord'); continue; }
      if (x.v === 'gl_TexCoord') {                           // gl_TexCoord[0], the one unit gl.js has
        const a = at(k + 1), b = at(k + 2), c = at(k + 3);
        if (a && a.v === '[' && b && c && c.v === ']') { out.push(b.v === '0' ? 'prism_TexCoord0' : 'vec4(0.0, 0.0, 0.0, 1.0)'); i = sig[k + 3]; continue; }
      }
      if (x.v === 'varying') { out.push('in'); continue; }
      if (TEXTURE[x.v]) { out.push(TEXTURE[x.v]); continue; }
    }
    out.push(x.v);
  }
  const head = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler3D;\n' +
    'in vec4 prism_Color;\nin vec4 prism_TexCoord0;\nin float prism_FogFragCoord;\nout vec4 prism_FragColor;\n';
  return { source: head + out.join(''), uniforms };
}

/** The vertex stage of a program whose only shader is a fragment one (OpenGL 2.0, 2.15: the fixed
 *  function does the vertex work): gl.js's own transformed vertices, and the values the fragment
 *  shader reads under the names translateFragment gives them. */
export const FIXED_VERTEX = `#version 300 es
in vec4 pos; in vec4 col; in vec2 tc; in float ez;
out vec4 prism_Color; out vec4 prism_TexCoord0; out float prism_FogFragCoord;
uniform int zFlip;
void main() { gl_Position = vec4(pos.xy, zFlip == 1 ? -pos.z : pos.z, pos.w); prism_Color = col; prism_TexCoord0 = vec4(tc, 0.0, 1.0); prism_FogFragCoord = ez; }`;

// ---- the objects and the entry points (OpenGL 2.0 chapter 2.15, and ARB_shader_objects' names) ----
const FRAGMENT_SHADER = 0x8b30, VERTEX_SHADER = 0x8b31;
const COMPILE_STATUS = 0x8b81, LINK_STATUS = 0x8b82, VALIDATE_STATUS = 0x8b83, INFO_LOG_LENGTH = 0x8b84, SHADER_TYPE = 0x8b4f,
  DELETE_STATUS = 0x8b80, ATTACHED_SHADERS = 0x8b85, OBJECT_TYPE_ARB = 0x8b4e, SHADER_OBJECT_ARB = 0x8b48, PROGRAM_OBJECT_ARB = 0x8b40;

/**
 * GLSL for gl.js: shader and program objects, their entry points (by their OpenGL 2.0 and ARB names,
 * as GetProcAddress hands both out), and what the WebGL rasteriser needs to draw with a program.
 * A program whose only shader is a fragment one is drawn: gl.js transforms the vertices as always
 * (2.15: the fixed function does what no vertex shader does) and the program's fragment shader runs
 * in place of the fixed one. A VERTEX shader is refused when the program is used, naming itself —
 * it reads object-space vertices and the matrices, which this rasteriser does not hand WebGL yet. The
 * software rasteriser refuses GLSL altogether: it would need a GLSL interpreter.
 */
export function makeGLSL(M) {
  const dv = () => M.mod.dv;
  const cstr = (p) => (M.cstr ? M.cstr(p) : M.mod.cstr(p));
  const objects = new Map();                      // id -> shader { kind: 'shader', type, source, es } | program
  let next = 1, current = null, version = 0;
  const get = (id) => objects.get(id >>> 0);
  const shaderOf = (id) => { const o = get(id); if (!o || o.kind !== 'shader') throw new Error(`gl: GLSL: ${id} is not a shader`); return o; };
  const programOf = (id) => { const o = get(id); if (!o || o.kind !== 'program') throw new Error(`gl: GLSL: ${id} is not a program`); return o; };
  const create = (o) => { const id = next++; objects.set(id, o); return id; };
  const setUniform = (loc, kind, values) => {
    if (!current || loc < 0) return;
    const name = current.locations[loc];
    if (name === undefined) return;
    current.values.set(name, { kind, values }); version++;
  };
  const vec = (p, n) => Array.from({ length: n }, (_, k) => dv().getFloat32(p + 4 * k, true));
  const ivec = (p, n) => Array.from({ length: n }, (_, k) => dv().getInt32(p + 4 * k, true));
  const writeLog = (max, lenPtr, logPtr) => { if (lenPtr) dv().setInt32(lenPtr, 0, true); if (logPtr && max > 0) M.u8[logPtr] = 0; };
  const api = {
    glCreateShader: (type) => create({ kind: 'shader', type, source: '', es: null }),
    glShaderSource: (sh, count, strings, lengths) => {
      let src = '';
      for (let i = 0; i < count; i++) {
        const p = dv().getUint32(strings + 4 * i, true), len = lengths ? dv().getInt32(lengths + 4 * i, true) : -1;
        src += len >= 0 ? new TextDecoder('latin1').decode(M.u8.slice(p, p + len)) : cstr(p);
      }
      shaderOf(sh).source = src;
    },
    glCompileShader: (sh) => { const o = shaderOf(sh); if (o.type === FRAGMENT_SHADER) o.es = translateFragment(o.source); },
    glCreateProgram: () => create({ kind: 'program', shaders: [], fragment: null, vertex: null, locations: [], values: new Map(), gpu: null }),
    glAttachShader: (p, sh) => { programOf(p).shaders.push(shaderOf(sh)); },
    glDetachShader: (p, sh) => { const o = programOf(p); o.shaders = o.shaders.filter((x) => x !== shaderOf(sh)); },
    glLinkProgram: (p) => {
      const o = programOf(p);
      o.fragment = o.shaders.find((x) => x.type === FRAGMENT_SHADER) || null;
      o.vertex = o.shaders.find((x) => x.type === VERTEX_SHADER) || null;
      o.gpu = null; o.values = new Map(); version++;
    },
    glUseProgram: (p) => {
      current = p ? programOf(p) : null;
      if (current && current.vertex) throw new Error('gl: GLSL: a program with a vertex shader is not implemented (its fragment shader alone is)');
      version++;
    },
    glValidateProgram: () => {},
    glDeleteShader: (id) => { objects.delete(id >>> 0); },
    glDeleteProgram: (id) => { if (current === get(id)) current = null; objects.delete(id >>> 0); },
    glIsShader: (id) => +(get(id)?.kind === 'shader'),
    glIsProgram: (id) => +(get(id)?.kind === 'program'),
    glGetUniformLocation: (p, name) => {
      const o = programOf(p), n = cstr(name);
      let k = o.locations.indexOf(n);
      if (k < 0) { k = o.locations.length; o.locations.push(n); }
      return k;
    },
    // Compiled, linked and valid, as far as this implementation can tell: WebGL's compiler judges the
    // translation when the program is first drawn with, and a refusal there names the line.
    glGetShaderiv: (sh, pname, out) => {
      const o = shaderOf(sh);
      const v = { [COMPILE_STATUS]: 1, [INFO_LOG_LENGTH]: 0, [SHADER_TYPE]: o.type, [DELETE_STATUS]: 0, 0x8b88: o.source.length + 1 }[pname];
      if (v === undefined) throw new Error(`gl: glGetShaderiv 0x${pname.toString(16)}`);
      dv().setInt32(out, v, true);
    },
    glGetProgramiv: (p, pname, out) => {
      const o = programOf(p);
      const v = { [LINK_STATUS]: 1, [VALIDATE_STATUS]: 1, [INFO_LOG_LENGTH]: 0, [DELETE_STATUS]: 0, [ATTACHED_SHADERS]: o.shaders.length }[pname];
      if (v === undefined) throw new Error(`gl: glGetProgramiv 0x${pname.toString(16)}`);
      dv().setInt32(out, v, true);
    },
    glGetShaderInfoLog: (sh, max, len, log) => writeLog(max, len, log),
    glGetProgramInfoLog: (p, max, len, log) => writeLog(max, len, log),
  };
  for (const n of [1, 2, 3, 4]) {
    api[`glUniform${n}f`] = (loc, ...v) => setUniform(loc, `f${n}`, v.slice(0, n));
    api[`glUniform${n}i`] = (loc, ...v) => setUniform(loc, `i${n}`, v.slice(0, n));
    api[`glUniform${n}fv`] = (loc, count, p) => setUniform(loc, `f${n}`, vec(p, n * count));
    api[`glUniform${n}iv`] = (loc, count, p) => setUniform(loc, `i${n}`, ivec(p, n * count));
  }
  api.glUniformMatrix4fv = (loc, count, transpose, p) => setUniform(loc, transpose ? 'm4t' : 'm4', vec(p, 16 * count));
  api.glUniformMatrix3fv = (loc, count, transpose, p) => setUniform(loc, transpose ? 'm3t' : 'm3', vec(p, 9 * count));
  // ARB_shader_objects: the same objects under their earlier names, one handle space for both kinds
  Object.assign(api, {
    glCreateShaderObjectARB: api.glCreateShader, glShaderSourceARB: api.glShaderSource, glCompileShaderARB: api.glCompileShader,
    glCreateProgramObjectARB: api.glCreateProgram, glAttachObjectARB: api.glAttachShader, glDetachObjectARB: api.glDetachShader,
    glLinkProgramARB: api.glLinkProgram, glUseProgramObjectARB: api.glUseProgram, glValidateProgramARB: api.glValidateProgram,
    glGetUniformLocationARB: api.glGetUniformLocation, glDeleteObjectARB: (id) => objects.delete(id >>> 0),
    glGetObjectParameterivARB: (id, pname, out) => {
      const o = get(id);
      if (pname === OBJECT_TYPE_ARB) { dv().setInt32(out, o?.kind === 'shader' ? SHADER_OBJECT_ARB : PROGRAM_OBJECT_ARB, true); return; }
      (o?.kind === 'shader' ? api.glGetShaderiv : api.glGetProgramiv)(id, pname, out);
    },
    glGetInfoLogARB: (id, max, len, log) => writeLog(max, len, log),
  });
  for (const n of [1, 2, 3, 4]) for (const t of ['f', 'i', 'fv', 'iv']) api[`glUniform${n}${t}ARB`] = api[`glUniform${n}${t}`];
  api.glUniformMatrix4fvARB = api.glUniformMatrix4fv;
  return {
    api,
    /** The program in use, or null: what a draw is made with. */
    current: () => current,
    /** A key that changes whenever what a draw needs from GLSL does (the program, its uniforms). */
    key: () => (current ? version : 0),
  };
}

/**
 * The WebGL side: a GLSL program compiled for WebGL2 the first time it is drawn with (the fixed vertex
 * stage and its translated fragment shader, with gl.js's vertex layout), then made current with its
 * uniforms. `use(program)` returns false for the fixed function, true once the program is current.
 */
export function makeGLSLWebGL(g, layout, shader) {
  const UNIFORM = {
    f1: (l, v) => g.uniform1fv(l, v), f2: (l, v) => g.uniform2fv(l, v), f3: (l, v) => g.uniform3fv(l, v), f4: (l, v) => g.uniform4fv(l, v),
    i1: (l, v) => g.uniform1iv(l, v), i2: (l, v) => g.uniform2iv(l, v), i3: (l, v) => g.uniform3iv(l, v), i4: (l, v) => g.uniform4iv(l, v),
    m4: (l, v) => g.uniformMatrix4fv(l, false, v), m3: (l, v) => g.uniformMatrix3fv(l, false, v),
    m4t: (l, v) => g.uniformMatrix4fv(l, false, transpose(v, 4)), m3t: (l, v) => g.uniformMatrix3fv(l, false, transpose(v, 3)),
  };
  return {
    use(program, zFlip) {
      if (!program) return false;
      if (!program.gpu) {
        if (!program.fragment || !program.fragment.es) throw new Error('gl: GLSL: a program without a compiled fragment shader');
        const p = g.createProgram();
        g.attachShader(p, shader(g.VERTEX_SHADER, FIXED_VERTEX));
        g.attachShader(p, shader(g.FRAGMENT_SHADER, program.fragment.es.source));
        layout.forEach((n, i) => g.bindAttribLocation(p, i, n));
        g.linkProgram(p);
        if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(`gl: GLSL: link: ${g.getProgramInfoLog(p)}`);
        program.gpu = { p, zFlip: g.getUniformLocation(p, 'zFlip'), loc: new Map() };
      }
      const gp = program.gpu;
      g.useProgram(gp.p);
      g.uniform1i(gp.zFlip, zFlip);
      for (const [name, { kind, values }] of program.values) {
        if (!gp.loc.has(name)) gp.loc.set(name, g.getUniformLocation(gp.p, name));
        const l = gp.loc.get(name);
        if (l) UNIFORM[kind](l, values);
      }
      return true;
    },
  };
}

const transpose = (v, n) => {
  const out = new Array(v.length);
  for (let m = 0; m < v.length; m += n * n) for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[m + c * n + r] = v[m + r * n + c];
  return out;
};
