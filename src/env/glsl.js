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
  const re = /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|(^[ \t]*#[^\n]*)|(\s+)|([A-Za-z_][A-Za-z0-9_]*)|(0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fFuU]?)|(<<=|>>=|\+\+|--|<=|>=|==|!=|&&|\|\||\^\^|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<|>>|[^\s])/gm;
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

/** Translate a desktop GLSL fragment shader into GLSL ES 3.00. Returns { source, uniforms, matrices }
 *  — the uniforms as name -> type, as the shader declares them; the built-in matrices it reads. */
export const translateFragment = (src) => translate(src, 'fragment');
/** The same for a vertex shader: its attributes are gl.js's vertex as given (object space, the current
 *  colour, texture coordinate and normal), its outputs the fragment stage's inputs. */
export const translateVertex = (src) => translate(src, 'vertex');

/*
 * THE BUILT-IN MATRICES (GLSL 1.10, 7.4), uniforms in both stages: the modelview, projection, their
 * product and the texture matrix, each also inverted, transposed or both, and the normal matrix. ES has
 * none of them; each one a shader reads becomes a uniform gl.js sets from its matrix stacks
 * (matrixValue). gl_TextureMatrix[0] only: gl.js has one texture unit.
 */
const MATRIX = /^gl_(ModelView|Projection|ModelViewProjection|Texture)Matrix(Inverse)?(Transpose)?$/;
const VERTEX_IN = { gl_Vertex: 'prism_Vertex', gl_Color: 'prism_ColorIn', gl_Normal: 'prism_Normal', gl_MultiTexCoord0: 'prism_MultiTexCoord0' };
/** The attribute names of a translated vertex shader, by gl.js's vertex layout (pos, col, tc, ez, normal). */
export const VERTEX_ATTRIBUTES = ['prism_Vertex', 'prism_ColorIn', 'prism_MultiTexCoord0', 'prism_unused', 'prism_Normal'];

/** Object-like macros (`#define ve return`, `#define ec float`, as the 4K intros shorten their
 *  shaders) replaced by what they stand for and their lines dropped, so that the rewrite sees the
 *  types and keywords; function-like macros are left to the compiler. */
function expandDefines(src) {
  const defs = new Map();
  const kept = src.split('\n').map((line) => {
    const m = /^\s*#\s*define\s+([A-Za-z_]\w*)(?!\()(?:\s+(.*))?$/.exec(line);
    if (!m) return line;
    defs.set(m[1], (m[2] || '').trim());
    return '';
  }).join('\n');
  if (!defs.size) return src;
  let out = kept;
  for (let pass = 0; pass < 4; pass++) out = out.replace(/[A-Za-z_]\w*/g, (w) => (defs.has(w) ? defs.get(w) : w));
  return out;
}

const DECL_TYPES = new Set([...INT_TYPES, 'float', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'void', 'sampler1D', 'sampler2D', 'sampler3D', 'samplerCube']);

function translate(src, stage) {
  const vertex = stage === 'vertex', matrices = new Set();
  const tk = tokens(hoistGlobals(expandDefines(src)));
  const sig = [];                                   // indices of the significant tokens (not whitespace)
  tk.forEach((x, i) => { if (x.t !== 'ws') sig.push(i); });
  const at = (k) => (k >= 0 && k < sig.length ? tk[sig[k]] : null);
  // WHICH NAMES ARE INTEGERS, scope by scope: each use of a name is the declaration it sees -- a
  // global, a function's parameter in its body, a local -- so `int k` in one function and `float k` in
  // another are two (Valleyball 2009: R(vec3 n, vec3 m, int k) and F's float k).
  const intAt = new Array(sig.length).fill(false), uniforms = {};
  {
    const scopes = [new Map()];
    let pending = null;                                     // a function's parameters, for its body
    const bind = (name, isInt) => scopes[scopes.length - 1].set(name, isInt);
    const look = (name) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); return false; };
    for (let k = 0; k < sig.length; k++) {
      const x = at(k);
      if (x.v === '{') { scopes.push(new Map(pending || [])); pending = null; continue; }
      if (x.v === '}') { if (scopes.length > 1) scopes.pop(); continue; }
      if (x.v === ';' && scopes.length === 1) { pending = null; continue; }
      if (x.t !== 'id') continue;
      const next = at(k + 1), prev = at(k - 1);
      if (DECL_TYPES.has(x.v) && next && next.t === 'id' && !(prev && prev.v === '.')) {
        if (at(k + 2) && at(k + 2).v === '(' && scopes.length === 1) {
          // a function: its parameters bound in its body (a prototype's are forgotten at its `;`)
          const ps = [];
          for (let j = k + 3, depth = 0, type = null; at(j); j++) {
            const y = at(j);
            if (y.v === '(' || y.v === '[') depth++;
            else if (y.v === ')' || y.v === ']') { if (depth === 0) break; depth--; }
            else if (y.v === ',' && depth === 0) type = null;
            else if (y.t === 'id' && depth === 0) { if (DECL_TYPES.has(y.v)) type = y.v; else if (type) ps.push([y.v, INT_TYPES.has(type)]); }
          }
          pending = ps;
        } else {
          // `int a = 1, b;` -- every name of the declarator list, until `;` or `)` at the same depth
          for (let j = k + 1, depth = 0; j < sig.length; j++) {
            const y = at(j);
            if (y.v === '(' || y.v === '[') depth++;
            else if (y.v === ')' || y.v === ']') { if (depth === 0) break; depth--; }
            else if ((y.v === ';' || y.v === '{') && depth === 0) break;
            if (y.t === 'id' && depth === 0 && (at(j - 1).v === ',' || j === k + 1)) bind(y.v, INT_TYPES.has(x.v));
          }
        }
      }
      if (!(prev && prev.v === '.')) intAt[k] = look(x.v);
    }
  }
  const isInt = (k) => !!intAt[k];
  for (let k = 0; k < sig.length; k++) {
    const x = at(k);
    if (x.t === 'id' && x.v === 'uniform') {
      let j = k + 1; while (at(j) && ['lowp', 'mediump', 'highp'].includes(at(j).v)) j++;
      const type = at(j) && at(j).v;
      for (j++; at(j) && at(j).v !== ';'; j++) if (at(j).t === 'id' && (at(j - 1).v === type || at(j - 1).v === ',')) uniforms[at(j).v] = type;
    }
  }
  // A name after a dot is a field or a swizzle (`texture(...).r`), never the variable of that name: a
  // global `int r` beside it is another thing.
  const isField = (k) => !!(at(k - 1) && at(k - 1).v === '.');
  // The shader's own functions and the types of their parameters: `float mn(float p,float pp,int ppp)`
  // is called `mn(a, b, 2)`, and that 2 is an int (Retrospection 2009). Every overload is kept; a call
  // takes the one with as many parameters as it has arguments.
  const params = new Map();                 // name -> [types of each declaration's parameters]
  for (let k = 1, depth = 0; k < sig.length; k++) {
    const x = at(k);
    if (x.v === '{') depth++; else if (x.v === '}') depth--;
    if (depth || x.t !== 'id' || !at(k + 1) || at(k + 1).v !== '(' || at(k - 1).t !== 'id' || QUALIFIERS.has(at(k - 1).v)) continue;
    const types = [];
    for (let j = k + 2, want = true; at(j) && at(j).v !== ')'; j++) {
      const y = at(j);
      if (y.v === ',') { want = true; continue; }
      if (want && y.t === 'id' && !['in', 'out', 'inout', 'const', 'highp', 'mediump', 'lowp'].includes(y.v)) { types.push(y.v); want = false; }
    }
    if (!params.has(x.v)) params.set(x.v, []);
    params.get(x.v).push(types);
  }
  // Whether the parenthesised group whose parenthesis is at k (its `)` when dir is -1, its `(` when 1)
  // holds integers only: int literals, int variables, operators, int constructors -- Valleyball's hash
  // (i*(i*i*15731+789221)+1376312589)&0x7fffffff, all ints, its last literal beside a `)`.
  const intGroup = (k, dir) => {
    let j = k + dir, depth = 0, intVar = false;
    for (; at(j); j += dir) {
      const y = at(j);
      if (y.v === (dir < 0 ? ')' : '(')) { depth++; continue; }
      if (y.v === (dir < 0 ? '(' : ')')) { if (!depth) break; depth--; continue; }
      if (y.t === 'num') { if (!isIntLiteral(y.v)) return false; continue; }
      if (y.t === 'id') {
        if (isField(j)) return false;
        if (INT_TYPES.has(y.v) && at(j + 1) && at(j + 1).v === '(') { intVar = true; continue; }
        if (!isInt(j) || (at(j + 1) && at(j + 1).v === '(')) return false;   // a float, or a call of unknown type
        intVar = true; continue;
      }
      if (y.v === '.' || y.v === '[' || y.v === ']') return false;
    }
    if (!at(j) || !intVar) return false;                        // literals alone say nothing: x*(1+2) is a float's
    // a call's parentheses: an int constructor's are an int, any other function's are not known
    if (dir < 0) { const f = at(j - 1); if (f && f.t === 'id' && !INT_TYPES.has(f.v)) return false; }
    return true;
  };
  // Whether the literal at k is an operand of + - * / whose other operand is a float: a float literal,
  // a name that is not an int variable (or is a swizzle), a parenthesis or bracket closing.
  const besideFloat = (k) => {
    for (const d of [-1, 1]) {
      const op = at(k + d), side = at(k + 2 * d);
      if (!op || !['*', '/', '+', '-'].includes(op.v) || !side) continue;
      if (side.t === 'num') { if (!isIntLiteral(side.v)) return true; continue; }
      if (side.t === 'id') { if (!isInt(k + 2 * d) || isField(k + 2 * d) || (at(k + 3 * d) && at(k + 3 * d).v === '.')) return true; continue; }
      if (side.v === ')' || side.v === ']') return true;
    }
    return false;
  };
  // Integer context of the significant token k: inside [...], inside an int constructor's parentheses or
  // an int parameter's place in a call of the shader's own function, or beside an integer variable
  // through an operator (a < 75, i += 1, n * 2).
  const intCtx = (k) => {
    for (let j = k - 1, depth = 0, arg = 0; j >= 0; j--) {   // the innermost open bracket or parenthesis
      const y = at(j).v;
      if (y === ')' || y === ']') depth++;
      else if (y === '(' || y === '[') {
        if (depth) { depth--; continue; }
        if (y === '[') return true;
        const f = at(j - 1);
        // an int constructor's argument is integer unless the literal sits in float arithmetic there:
        // Valleyball (2009) hashes with int(j.x*40+j.y*6400), where 40 and 6400 multiply floats
        if (f && f.t === 'id' && INT_TYPES.has(f.v)) return !besideFloat(k);
        if (f && f.t === 'id' && params.has(f.v)) {
          let n = 1;                                         // the call's arguments, from its '(' at j
          for (let e = j + 1, d = 0; at(e) && !(d === 0 && at(e).v === ')'); e++) {
            const z = at(e).v;
            if (z === '(' || z === '[') d++; else if (z === ')' || z === ']') d--; else if (z === ',' && d === 0) n++;
          }
          const decl = params.get(f.v).find((t) => t.length === n);
          if (decl && INT_TYPES.has(decl[arg])) return true;
        }
        // plain parentheses (not a call's) around integers only: (i*i*15731+789221)
        if (y === '(' && !(f && f.t === 'id' && !['return', 'if', 'while', 'for'].includes(f.v)) && intGroup(j, 1)) return true;
        break;
      } else if (y === ',' && depth === 0) arg++;
      else if ((y === ';' || y === '{' || y === '}') && depth === 0) break;
    }
    const OPS = new Set(['<', '>', '<=', '>=', '==', '!=', '=', '+', '-', '*', '/', '%', '+=', '-=', '*=', '/=', '%=', '<<', '>>', '&', '|', '^']);
    for (const d of [-1, 1]) {
      const op = at(k + d), side = at(k + 2 * d);
      if (op && OPS.has(op.v) && side) {
        if (side.t === 'id' && isInt(k + 2 * d) && !isField(k + 2 * d) && !converted.has(k + 2 * d) && !(at(k + 3 * d) && at(k + 3 * d).v === '.')) return true;
        if (side.t === 'num' && isIntLiteral(side.v) && d === -1 && at(k - 3) && isInt(k - 3)) return true;
        if ((side.v === ')' && d === -1) || (side.v === '(' && d === 1)) { if (intGroup(k + 2 * d, d)) return true; }
      }
    }
    // the initialiser of an int declaration: `int i = 0`, `int n = 3`
    if (at(k - 1) && at(k - 1).v === '=' && at(k - 2) && isInt(k - 2)) return true;
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
    for (const [op, side, sk] of [[at(k - 1), at(k - 2), k - 2], [at(k + 1), at(k + 2), k + 2]]) {
      if (!op || !ARITH.has(op.v) || !side) continue;
      if (side.t === 'num') { if (!isIntLiteral(side.v)) return true; continue; }
      if (side.t === 'id' && isInt(sk) && !isField(sk)) continue;
      if (side.v === ')' || side.v === ']' || side.t === 'id') return true;
    }
    return false;
  };
  // Which integer variables become float(...), decided before the literals beside them are: in `s*c/8`
  // c is converted, so 8 is beside a float and becomes 8.0.
  const converted = new Set();
  for (let k = 0; k < sig.length; k++) { const x = at(k); if (x.t === 'id' && isInt(k) && !isField(k) && floatNeighbour(k) && !intCtx(k)) converted.add(k); }
  const out = [];
  for (let i = 0, k = 0; i < tk.length; i++) {
    const x = tk[i];
    if (x.t === 'ws') { out.push(x.v); continue; }
    k = sig.indexOf(i, k);
    if (x.t === 'pp') { if (!/^\s*#\s*version\b/.test(x.v)) out.push(x.v + '\n'); continue; }
    if (x.t === 'num' && isIntLiteral(x.v) && !/^0[xX]/.test(x.v) && !/[uU]$/.test(x.v) && !intCtx(k)) { out.push(x.v + '.0'); continue; }
    if (converted.has(k)) { out.push(`float(${x.v})`); continue; }
    if (x.t === 'id') {
      if (MATRIX.test(x.v)) {
        matrices.add(x.v);
        if (x.v === 'gl_TextureMatrix' || /^gl_TextureMatrix/.test(x.v)) {   // gl_TextureMatrix[n]: unit 0, else identity
          const a = at(k + 1), b = at(k + 2), c = at(k + 3);
          if (a && a.v === '[' && b && c && c.v === ']') { out.push(b.v === '0' ? x.v.replace('gl_', 'prism_') : 'mat4(1.0)'); i = sig[k + 3]; continue; }
        }
        out.push(x.v.replace('gl_', 'prism_')); continue;
      }
      if (x.v === 'gl_NormalMatrix') { matrices.add(x.v); out.push('prism_NormalMatrix'); continue; }
      if (vertex) {
        if (VERTEX_IN[x.v]) { out.push(VERTEX_IN[x.v]); continue; }
        if (/^gl_MultiTexCoord[1-7]$/.test(x.v)) { out.push('vec4(0.0, 0.0, 0.0, 1.0)'); continue; }
        if (x.v === 'gl_SecondaryColor') { out.push('vec4(0.0)'); continue; }
        if (x.v === 'gl_FogCoord') { out.push('0.0'); continue; }
        if (x.v === 'ftransform') {                          // ftransform(): the fixed function's own position
          const a = at(k + 1), b = at(k + 2);
          if (a && a.v === '(' && b && b.v === ')') { matrices.add('gl_ModelViewProjectionMatrix'); out.push('(prism_ModelViewProjectionMatrix * prism_Vertex)'); i = sig[k + 2]; continue; }
        }
        if (x.v === 'gl_FrontColor') { out.push('prism_Color'); continue; }
        if (/^gl_(BackColor|FrontSecondaryColor|BackSecondaryColor|ClipVertex)$/.test(x.v)) { out.push('prism_discard'); continue; }
        if (x.v === 'gl_TexCoord') {                         // an output: unit 0 is passed on, the others written nowhere
          const a = at(k + 1), b = at(k + 2), c = at(k + 3);
          if (a && a.v === '[' && b && c && c.v === ']') { out.push(b.v === '0' ? 'prism_TexCoord0' : 'prism_discard'); i = sig[k + 3]; continue; }
        }
        if (x.v === 'gl_FogFragCoord') { out.push('prism_FogFragCoord'); continue; }
        if (x.v === 'attribute') { out.push('in'); continue; }
        if (x.v === 'varying') { out.push('out'); continue; }
        if (x.v === 'main') { out.push('prism_main'); continue; }
        if (TEXTURE[x.v]) { out.push(TEXTURE[x.v]); continue; }
        out.push(x.v); continue;
      }
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
  const decl = [...matrices].map((m) => `uniform ${m === 'gl_NormalMatrix' ? 'mat3' : 'mat4'} ${m.replace('gl_', 'prism_')};\n`).join('');
  if (vertex) {
    // The outputs start as the fixed function leaves them (the colour as given), then the shader's main.
    const head = '#version 300 es\nprecision highp float;\nprecision highp int;\n' +
      'in vec4 prism_Vertex;\nin vec4 prism_ColorIn;\nin vec4 prism_MultiTexCoord0;\nin vec3 prism_Normal;\nuniform int zFlip;\n' +
      'out vec4 prism_Color;\nout vec4 prism_TexCoord0;\nout float prism_FogFragCoord;\nvec4 prism_discard;\n' + decl;
    const tail = '\nvoid main() { prism_Color = prism_ColorIn; prism_TexCoord0 = vec4(0.0, 0.0, 0.0, 1.0); prism_FogFragCoord = 0.0;' +
      ' prism_main(); if (zFlip == 1) gl_Position.z = -gl_Position.z; }\n';
    return { source: head + out.join('') + tail, uniforms, matrices: [...matrices] };
  }
  const head = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler3D;\n' +
    'in vec4 prism_Color;\nin vec4 prism_TexCoord0;\nin float prism_FogFragCoord;\nout vec4 prism_FragColor;\n' + decl;
  return { source: head + out.join(''), uniforms, matrices: [...matrices] };
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
 * in place of the fixed one. A program with a VERTEX shader is handed the vertices as given (object
 * space) and positions them itself; gl.js then leaves clipping and culling to the GPU, since only the
 * shader knows where a vertex lands. The software rasteriser refuses GLSL altogether: it would need a
 * GLSL interpreter.
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
    glCompileShader: (sh) => { const o = shaderOf(sh); o.es = o.type === FRAGMENT_SHADER ? translateFragment(o.source) : o.type === VERTEX_SHADER ? translateVertex(o.source) : null; },
    glCreateProgram: () => create({ kind: 'program', shaders: [], fragment: null, vertex: null, locations: [], values: new Map(), gpu: null }),
    glAttachShader: (p, sh) => { programOf(p).shaders.push(shaderOf(sh)); },
    glDetachShader: (p, sh) => { const o = programOf(p); o.shaders = o.shaders.filter((x) => x !== shaderOf(sh)); },
    glLinkProgram: (p) => {
      const o = programOf(p);
      o.fragment = o.shaders.find((x) => x.type === FRAGMENT_SHADER) || null;
      o.vertex = o.shaders.find((x) => x.type === VERTEX_SHADER) || null;
      o.gpu = null; o.values = new Map(); version++;
      // The built-in matrices either stage reads: gl.js sends them with every draw that uses the program.
      o.matrices = [...new Set([o.fragment, o.vertex].flatMap((x) => (x && x.es ? x.es.matrices : [])))];
    },
    glUseProgram: (p) => {
      current = p ? programOf(p) : null;
      if (current && !current.fragment) throw new Error('gl: GLSL: a program with a vertex shader and no fragment shader is not implemented');
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
    /** Make `program` current with its uniforms and `matrices` (name -> values); false for the fixed function. */
    use(program, zFlip, matrices) {
      if (!program) return false;
      if (!program.gpu) {
        if (!program.fragment || !program.fragment.es) throw new Error('gl: GLSL: a program without a compiled fragment shader');
        const p = g.createProgram();
        g.attachShader(p, shader(g.VERTEX_SHADER, program.vertex ? program.vertex.es.source : FIXED_VERTEX));
        g.attachShader(p, shader(g.FRAGMENT_SHADER, program.fragment.es.source));
        (program.vertex ? VERTEX_ATTRIBUTES : layout).forEach((n, i) => g.bindAttribLocation(p, i, n));
        g.linkProgram(p);
        if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(`gl: GLSL: link: ${g.getProgramInfoLog(p)}`);
        program.gpu = { p, zFlip: g.getUniformLocation(p, 'zFlip'), loc: new Map() };
      }
      const gp = program.gpu;
      g.useProgram(gp.p);
      g.uniform1i(gp.zFlip, zFlip);
      for (const m of program.matrices || []) {
        const name = m.replace('gl_', 'prism_');
        if (!gp.loc.has(name)) gp.loc.set(name, g.getUniformLocation(gp.p, name));
        const l = gp.loc.get(name);
        if (l) (m === 'gl_NormalMatrix' ? g.uniformMatrix3fv : g.uniformMatrix4fv).call(g, l, false, matrices[m]);
      }
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
