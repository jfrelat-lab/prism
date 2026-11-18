// arbprog.js — ARB_vertex_program and ARB_fragment_program (2002): the assembly language of a GL 1.4 card's
// programmable stages, translated to GLSL ES 3.00 for WebGL2. Doom 3's ARB2 path is written in it
// (glprogs/*.vfp): `!!ARBvp1.0` and `!!ARBfp1.0` texts of TEMP/PARAM/ATTRIB/OUTPUT declarations and
// instructions over four-component registers.
//
// parseProgram(text) reads one program into a list of instructions over named operands, or throws with the
// position of what it could not read (glProgramStringARB's GL_PROGRAM_ERROR_POSITION_ARB). linkPrograms(vp, fp)
// writes the two GLSL shaders of a pair -- either side may be null, for the fixed function's half -- with the
// interpolants the vertex side writes and the fragment side reads, and says which inputs, parameters,
// matrices and texture units the pair uses, which is what a draw binds.
//
// What the languages define and this does not: relative addressing (ARL and A0, the vertex program's
// address register), state.light/material/fog/texgen/clip bindings, and fragment.fogcoord; each is refused
// by name. The semantics follow the specifications: a scalar instruction reads one component and writes it
// to every component written; RSQ takes the absolute value; KIL discards when any component is negative;
// result colours are clamped to [0, 1] on the way to the fragment stage.

const SCALAR = new Set(['RCP', 'RSQ', 'EX2', 'LG2', 'EXP', 'LOG', 'COS', 'SIN', 'SCS', 'POW']);
const OPS = {
  // name: [sources, kind]
  ABS: 1, ADD: 2, ARL: 1, CMP: 3, COS: 1, DP3: 2, DP4: 2, DPH: 2, DST: 2, EX2: 1, EXP: 1, FLR: 1, FRC: 1, KIL: 1,
  LG2: 1, LIT: 1, LOG: 1, LRP: 3, MAD: 3, MAX: 2, MIN: 2, MOV: 1, MUL: 2, POW: 2, RCP: 1, RSQ: 1, SCS: 1, SGE: 2,
  SIN: 1, SLT: 2, SUB: 2, SWZ: 1, TEX: 1, TXB: 1, TXP: 1, XPD: 2,
};
const TEX_OPS = new Set(['TEX', 'TXB', 'TXP']);
const TARGETS = { '1D': 'sampler2D', '2D': 'sampler2D', '3D': 'sampler3D', CUBE: 'samplerCube', RECT: 'sampler2D' };

class ArbError extends Error {
  constructor(msg, pos) { super(`ARB program: ${msg}`); this.pos = pos; }
}

/** The tokens of a program: words (with dots, as `vertex.attrib`), numbers, punctuation; comments gone. */
function lex(text) {
  const out = [];
  // A texture target (`2D`) before a number, and a number's point never the first of a range's `..`.
  const re = /(#[^\n]*)|(\s+)|([123]D(?![A-Za-z0-9_]))|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)|((?:\d+\.(?!\.)\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)|(\.\.|[^\s])/g;
  for (let m; (m = re.exec(text));) {
    if (m[1] || m[2]) continue;
    out.push({ v: m[3] ?? m[4] ?? m[5] ?? m[6], pos: m.index, num: !!m[5] });
  }
  return out;
}

/**
 * One program, read. `kind` 'vertex' or 'fragment'; `insts` [{ op, sat, dst, srcs, target, unit }]; the
 * declarations in `temps`, `params` (name -> operand or array), `attribs`, `outputs`, `aliases`.
 */
export function parseProgram(text) {
  const head = /^\s*!!ARB(vp|fp)1\.0/.exec(text);
  if (!head) throw new ArbError('not an ARB program (no !!ARBvp1.0 or !!ARBfp1.0)', 0);
  const kind = head[1] === 'vp' ? 'vertex' : 'fragment';
  const tk = lex(text.slice(head[0].length)).map((t) => ({ ...t, pos: t.pos + head[0].length }));
  let i = 0;
  const peek = () => tk[i]?.v, next = () => tk[i++], at = () => tk[i]?.pos ?? text.length;
  const expect = (v) => { if (tk[i]?.v !== v) throw new ArbError(`expected '${v}', found '${tk[i]?.v ?? 'the end'}'`, at()); i++; };
  const prog = { kind, options: new Set(), temps: new Set(), params: new Map(), attribs: new Map(), outputs: new Map(), aliases: new Map(), insts: [] };

  // A number, signed.
  const number = () => {
    let sign = 1;
    if (peek() === '-') { sign = -1; i++; } else if (peek() === '+') i++;
    const t = next();
    if (!t?.num) throw new ArbError(`expected a number, found '${t?.v ?? 'the end'}'`, t?.pos ?? text.length);
    return sign * parseFloat(t.v);
  };
  // `{ a, b, c, d }`: missing y and z are 0, a missing w 1 (2.14.3.4).
  const constVector = () => {
    expect('{');
    const v = [number()];
    while (peek() === ',') { i++; v.push(number()); }
    expect('}');
    return { k: 'const', v: [v[0], v[1] ?? 0, v[2] ?? 0, v[3] ?? 1] };
  };
  const index = () => { expect('['); const n = number(); expect(']'); return n | 0; };
  // A binding: program.env[n], program.local[n], state.matrix..., a constant, a vertex/fragment input.
  const binding = (allowRange = false) => {
    if (peek() === '{') return constVector();
    if (tk[i]?.num || peek() === '-' || peek() === '+') { const x = number(); return { k: 'const', v: [x, x, x, x] }; }
    const t = next(), w = t?.v ?? '';
    if (w === 'program.env' || w === 'program.local') {
      expect('['); const a = number() | 0; let b = a;
      if (peek() === '..') { if (!allowRange) throw new ArbError('a parameter range outside an array', at()); i++; b = number() | 0; }
      expect(']');
      const space = w === 'program.env' ? 'env' : 'local';
      return a === b ? { k: 'param', space, n: a } : { k: 'range', space, from: a, to: b };
    }
    if (w.startsWith('state.matrix.')) {
      // `state.matrix.mvp.row[0]` lexes as one word and `[0]`; `state.matrix.texture[1].inverse.row[2]` as
      // `state.matrix.texture`, `[1]`, `.`, `inverse.row`, `[2]`.
      const parts = w.slice('state.matrix.'.length).split('.');
      const name = parts.shift();
      let unit = 0;
      if (name === 'texture' && !parts.length && peek() === '[') unit = index();
      while (peek() === '.') { i++; parts.push(...next().v.split('.')); }
      if (!['modelview', 'projection', 'mvp', 'texture', 'palette', 'program'].includes(name)) throw new ArbError(`state.matrix.${name} is not a matrix`, t.pos);
      if (name === 'palette' || name === 'program') throw new ArbError(`state.matrix.${name} is not implemented`, t.pos);
      let mod = '';
      while (parts[0] === 'inverse' || parts[0] === 'transpose' || parts[0] === 'invtrans') mod = parts.shift();
      const matrix = `${name}${name === 'texture' ? unit : ''}${mod ? `_${mod}` : ''}`;
      if (parts[0] === 'row') {
        parts.shift();
        expect('['); const a = number() | 0; let b = a;
        if (peek() === '..') { i++; b = number() | 0; }
        expect(']');
        return a === b ? { k: 'row', matrix, row: a } : { k: 'rows', matrix, from: a, to: b };
      }
      if (parts.length) throw new ArbError(`state.matrix: '${parts.join('.')}'`, t.pos);
      return { k: 'rows', matrix, from: 0, to: 3 };
    }
    if (w.startsWith('state.')) throw new ArbError(`${w} is not implemented`, t.pos);
    if (w.startsWith('vertex.') || w.startsWith('fragment.')) return inputOf(w, t.pos);
    if (prog.params.has(w)) {
      const p = prog.params.get(w);
      if (Array.isArray(p)) { const n = index(); if (!p[n]) throw new ArbError(`${w}[${n}] is outside the array`, t.pos); return p[n]; }
      return p;
    }
    throw new ArbError(`'${w}' is not a parameter`, t?.pos ?? text.length);
  };
  const inputOf = (w, pos) => {
    if (kind === 'vertex') {
      if (w === 'vertex.position') return { k: 'in', name: 'pos' };
      if (w === 'vertex.color' || w === 'vertex.color.primary') return { k: 'in', name: 'col' };
      if (w === 'vertex.color.secondary') return { k: 'in', name: 'col2' };
      if (w === 'vertex.normal') return { k: 'in', name: 'nrm' };
      if (w === 'vertex.fogcoord') return { k: 'in', name: 'fog' };
      if (w === 'vertex.texcoord') return { k: 'in', name: `tc${peek() === '[' ? index() : 0}` };
      if (w === 'vertex.attrib') { const n = index(); return { k: 'in', name: n === 0 ? 'pos' : `att${n}` }; }
    } else {
      if (w === 'fragment.color' || w === 'fragment.color.primary') return { k: 'in', name: 'col' };
      if (w === 'fragment.color.secondary') return { k: 'in', name: 'col2' };
      if (w === 'fragment.texcoord') return { k: 'in', name: `tc${peek() === '[' ? index() : 0}` };
      if (w === 'fragment.position') return { k: 'in', name: 'fragpos' };
    }
    throw new ArbError(`${w} is not implemented`, pos);
  };
  const outputOf = (w, pos) => {
    if (kind === 'vertex') {
      if (w === 'result.position') return { k: 'out', name: 'pos' };
      if (/^result\.color(\.front)?(\.primary)?$/.test(w)) return { k: 'out', name: 'col' };
      if (/^result\.color(\.front)?\.secondary$/.test(w)) return { k: 'out', name: 'col2' };
      if (w === 'result.texcoord') return { k: 'out', name: `tc${peek() === '[' ? index() : 0}` };
      if (w === 'result.fogcoord' || w === 'result.pointsize') return { k: 'out', name: 'ignored' };
    } else {
      if (w === 'result.color') return { k: 'out', name: 'col' };
      if (w === 'result.depth') return { k: 'out', name: 'depth' };
    }
    throw new ArbError(`${w} is not an output`, pos);
  };

  // A swizzle or a write mask, if one follows: `.xyz`, `.x` (replicated for a source), `.rgba` in a fragment program.
  const suffix = () => {
    if (peek() !== '.') {
      // a word with its suffix glued on (`R0.x` lexes as one word) is split in `operandName`
      return null;
    }
    i++; return next().v;
  };
  const operandName = (t) => {
    // `R0.xyz` and `program.env[4]` arrive as words: separate a trailing component suffix from a name.
    const m = /^(.*?)(?:\.([xyzwrgba]{1,4}))?$/.exec(t.v);
    const known = (n) => prog.temps.has(n) || prog.params.has(n) || prog.attribs.has(n) || prog.outputs.has(n) || prog.aliases.has(n);
    if (m[2] && known(m[1])) return { base: m[1], sw: m[2] };
    return { base: t.v, sw: null };
  };
  const resolveAlias = (n) => { let x = n; for (let k = 0; k < 8 && prog.aliases.has(x); k++) x = prog.aliases.get(x); return x; };
  const comps = (sw) => (sw ?? 'xyzw').replace(/r/g, 'x').replace(/g/g, 'y').replace(/b/g, 'z').replace(/a/g, 'w');

  const source = () => {
    let neg = false;
    if (peek() === '-') { neg = true; i++; } else if (peek() === '+') i++;
    let op;
    const t = tk[i];
    if (!t) throw new ArbError('expected a source', text.length);
    let sw = null;
    if (t.v === '{' || t.num) {
      op = binding();
      // a constant with a swizzle, as a scalar instruction needs it: POW r.y, r.y, {2.5}.x
      if (peek() === '.') { i++; sw = next().v; }
    } else {
      i++;
      const { base, sw: glued } = operandName(t);
      sw = glued;
      const name = resolveAlias(base);
      if (prog.temps.has(name)) op = { k: 'temp', name };
      else if (prog.attribs.has(name)) op = prog.attribs.get(name);
      else if (prog.params.has(name)) {
        const p = prog.params.get(name);
        if (Array.isArray(p)) {
          if (peek() !== '[') throw new ArbError(`${name} is an array`, at());
          i++;
          if (tk[i] && !tk[i].num) throw new ArbError('relative addressing is not implemented', at());
          const n = number() | 0; expect(']');
          if (!p[n]) throw new ArbError(`${name}[${n}] is outside the array`, at());
          op = p[n];
        } else op = p;
      } else if ((name.startsWith('vertex.') || name.startsWith('fragment.')) && /\.[xyzwrgba]{1,4}$/.test(name)) {
        // `fragment.color.xyz`, `vertex.position.w`: the swizzle glued to an input's name
        try { op = inputOf(name, t.pos); } catch (e) {
          const m = /^(.*)\.([xyzwrgba]{1,4})$/.exec(name);
          op = inputOf(m[1], t.pos); sw = m[2];
        }
      } else { i--; op = binding(); }
      // a swizzle after a bracketed index: program.env[4].xyz
      if (peek() === '.') { i++; sw = next().v; }
      else if (!sw && tk[i] && /^\.[xyzwrgba]{1,4}$/.test(tk[i].v)) sw = next().v.slice(1);
    }
    if (op.k === 'range' || op.k === 'rows') throw new ArbError('a parameter array where one vector is wanted', t.pos);
    const s = comps(sw);
    if (!/^[xyzw]{1,4}$/.test(s)) throw new ArbError(`swizzle '${sw}'`, t.pos);
    return { op, neg, sw: s.length === 1 ? s.repeat(4) : s.length === 4 ? s : null, pos: t.pos };
  };
  const destination = () => {
    const t = next();
    if (!t) throw new ArbError('expected a destination', text.length);
    let { base, sw } = operandName(t);
    let name = resolveAlias(base), op;
    if (prog.temps.has(name)) op = { k: 'temp', name };
    else if (prog.outputs.has(name)) op = prog.outputs.get(name);
    else if (name.startsWith('result.')) {
      // `result.color.xyz` lexes as one word: the mask is the last part when the whole is not an output
      try { op = outputOf(name, t.pos); } catch (e) {
        const m = /^(.*)\.([xyzwrgba]{1,4})$/.exec(name);
        if (!m) throw e;
        op = outputOf(m[1], t.pos); sw = m[2];
      }
    } else throw new ArbError(`'${name}' is not writable`, t.pos);
    let mask = sw;
    if (!mask && peek() === '.') { i++; mask = next().v; }
    else if (!mask && tk[i] && /^\.[xyzwrgba]{1,4}$/.test(tk[i].v)) mask = next().v.slice(1);
    return { op, mask: comps(mask) };
  };

  while (i < tk.length) {
    const t = next(), w = t.v;
    if (w === 'END') break;
    if (w === 'OPTION') { prog.options.add(next().v); expect(';'); continue; }
    if (w === 'TEMP' || w === 'ADDRESS') {
      do { const n = next().v; if (w === 'TEMP') prog.temps.add(n); } while (peek() === ',' && i++);
      expect(';'); continue;
    }
    if (w === 'ALIAS') { const n = next().v; expect('='); prog.aliases.set(n, next().v); expect(';'); continue; }
    if (w === 'ATTRIB') { const n = next().v; expect('='); const b = tk[i]; i++; prog.attribs.set(n, inputOf(b.v, b.pos)); expect(';'); continue; }
    if (w === 'OUTPUT') { const n = next().v; expect('='); const b = tk[i]; i++; prog.outputs.set(n, outputOf(b.v, b.pos)); expect(';'); continue; }
    if (w === 'PARAM') {
      const n = next().v;
      if (peek() === '[') {
        i++; if (peek() !== ']') number(); expect(']'); expect('=');
        expect('{');
        const list = [];
        do {
          const b = binding(true);
          if (b.k === 'range') for (let k = b.from; k <= b.to; k++) list.push({ k: 'param', space: b.space, n: k });
          else if (b.k === 'rows') for (let k = b.from; k <= b.to; k++) list.push({ k: 'row', matrix: b.matrix, row: k });
          else list.push(b);
        } while (peek() === ',' && i++);
        expect('}');
        prog.params.set(n, list);
      } else {
        expect('=');
        const b = binding(true);
        if (b.k === 'rows') prog.params.set(n, Array.from({ length: b.to - b.from + 1 }, (_, k) => ({ k: 'row', matrix: b.matrix, row: b.from + k })));
        else if (b.k === 'range') throw new ArbError('a parameter range bound to a single PARAM', t.pos);
        else prog.params.set(n, b);
      }
      expect(';'); continue;
    }
    // An instruction: OP[_SAT] dst, src[, src[, src]][, texture[n], TARGET];
    const m = /^([A-Z0-9]+?)(_SAT)?$/.exec(w);
    if (!m || !(m[1] in OPS)) throw new ArbError(`'${w}' is not an instruction`, t.pos);
    const op = m[1];
    if (op === 'ARL') throw new ArbError('ARL (relative addressing) is not implemented', t.pos);
    if (kind === 'vertex' && (TEX_OPS.has(op) || ['CMP', 'KIL', 'LRP', 'COS', 'SIN', 'SCS'].includes(op))) throw new ArbError(`${op} is a fragment program instruction`, t.pos);
    if (kind === 'fragment' && ['ARL', 'EXP', 'LOG'].includes(op)) throw new ArbError(`${op} is a vertex program instruction`, t.pos);
    const inst = { op, sat: !!m[2], dst: null, srcs: [], pos: t.pos };
    if (op !== 'KIL') { inst.dst = destination(); expect(','); }
    if (op === 'SWZ') {
      // SWZ dst, src, x, y, z, w with each one of 0, 1, x, y, z, w (or rgba), optionally negated
      const s0 = source(); inst.srcs.push(s0);
      inst.ext = [];
      for (let k = 0; k < 4; k++) {
        expect(',');
        let neg = false;
        if (peek() === '-') { neg = true; i++; } else if (peek() === '+') i++;
        const c = next().v;
        inst.ext.push({ neg, c: c === '0' || c === '1' ? c : comps(c) });
      }
    } else {
      for (let k = 0; k < OPS[op]; k++) { if (k) expect(','); inst.srcs.push(source()); }
    }
    if (TEX_OPS.has(op)) {
      expect(',');
      const tw = next().v;
      if (tw !== 'texture') throw new ArbError(`expected texture[n], found '${tw}'`, at());
      inst.unit = peek() === '[' ? index() : 0;
      expect(',');
      inst.target = next().v;
      if (!(inst.target in TARGETS)) throw new ArbError(`texture target '${inst.target}'`, at());
    }
    expect(';');
    prog.insts.push(inst);
  }
  return prog;
}

const fmt = (x) => { const s = String(Math.fround(x)); return /[.eE]/.test(s) || /inf|nan/i.test(s) ? s : `${s}.0`; };

/**
 * The GLSL ES 3.00 shaders of a vertex/fragment pair (either may be null: that stage is the fixed function's,
 * as far as these programs need it). Returns { vs, fs, inputs, matrices, env, local, samplers } where
 * `inputs` are the vertex inputs read (pos, col, col2, nrm, fog, tcN, attN) in their attribute order,
 * `matrices` the state matrices read by name, `env`/`local` { vertex, fragment } the highest index read + 1,
 * and `samplers` the fragment program's texture units with their targets.
 */
export function linkPrograms(vp, fp) {
  const env = { vertex: 0, fragment: 0 }, local = { vertex: 0, fragment: 0 };
  const matrices = new Set(), samplers = new Map();
  const vertexInputs = new Set(['pos']);
  const varyings = new Set();

  const operand = (o, stage) => {
    switch (o.k) {
      case 'const': return `vec4(${o.v.map(fmt).join(', ')})`;
      case 'param': {
        const box = o.space === 'env' ? env : local;
        box[stage] = Math.max(box[stage], o.n + 1);
        return `prism_${o.space}${stage === 'vertex' ? 'V' : 'F'}[${o.n}]`;
      }
      case 'row': matrices.add(o.matrix); return `prism_row(prism_m_${o.matrix}, ${o.row})`;
      case 'temp': return `t_${o.name}`;
      case 'in':
        if (stage === 'vertex') { vertexInputs.add(o.name); return `a_${o.name}`; }
        if (o.name === 'fragpos') return 'gl_FragCoord';
        varyings.add(o.name);
        return `v_${o.name}`;
      default: throw new ArbError(`operand ${o.k}`, 0);
    }
  };
  const src = (s, stage) => {
    let e = operand(s.op, stage);
    if (s.sw) e = `${e}.${s.sw}`;
    return s.neg ? `(-${e})` : e;
  };
  const body = (prog, stage) => {
    const lines = [];
    for (const t of prog.temps) lines.push(`  vec4 t_${t} = vec4(0.0);`);
    for (const inst of prog.insts) {
      const a = inst.srcs[0] && src(inst.srcs[0], stage), b = inst.srcs[1] && src(inst.srcs[1], stage), c = inst.srcs[2] && src(inst.srcs[2], stage);
      let e;
      switch (inst.op) {
        case 'ABS': e = `abs(${a})`; break;
        case 'ADD': e = `(${a} + ${b})`; break;
        case 'SUB': e = `(${a} - ${b})`; break;
        case 'MUL': e = `(${a} * ${b})`; break;
        case 'MAD': e = `(${a} * ${b} + ${c})`; break;
        case 'MOV': e = a; break;
        case 'MIN': e = `min(${a}, ${b})`; break;
        case 'MAX': e = `max(${a}, ${b})`; break;
        case 'DP3': e = `vec4(dot((${a}).xyz, (${b}).xyz))`; break;
        case 'DP4': e = `vec4(dot(${a}, ${b}))`; break;
        case 'DPH': e = `vec4(dot((${a}).xyz, (${b}).xyz) + (${b}).w)`; break;
        case 'DST': e = `vec4(1.0, (${a}).y * (${b}).y, (${a}).z, (${b}).w)`; break;
        case 'RCP': e = `vec4(1.0 / (${a}).x)`; break;
        case 'RSQ': e = `vec4(inversesqrt(abs((${a}).x)))`; break;
        case 'EX2': e = `vec4(exp2((${a}).x))`; break;
        case 'LG2': e = `vec4(log2((${a}).x))`; break;
        case 'POW': e = `vec4(pow((${a}).x, (${b}).x))`; break;
        case 'EXP': e = `prism_exp((${a}).x)`; break;
        case 'LOG': e = `prism_log((${a}).x)`; break;
        case 'COS': e = `vec4(cos((${a}).x))`; break;
        case 'SIN': e = `vec4(sin((${a}).x))`; break;
        case 'SCS': e = `vec4(cos((${a}).x), sin((${a}).x), 0.0, 0.0)`; break;
        case 'FLR': e = `floor(${a})`; break;
        case 'FRC': e = `fract(${a})`; break;
        case 'SGE': e = `vec4(greaterThanEqual(${a}, ${b}))`; break;
        case 'SLT': e = `vec4(lessThan(${a}, ${b}))`; break;
        case 'CMP': e = `mix(${c}, ${b}, lessThan(${a}, vec4(0.0)))`; break;
        case 'LRP': e = `mix(${c}, ${b}, ${a})`; break;
        case 'XPD': e = `vec4(cross((${a}).xyz, (${b}).xyz), 1.0)`; break;
        case 'LIT': e = `prism_lit(${a})`; break;
        case 'SWZ': {
          const base = operand(inst.srcs[0].op, stage), neg0 = inst.srcs[0].neg ? '-' : '';
          e = `vec4(${inst.ext.map(({ neg, c: x }) => `${neg ? '-' : ''}${x === '0' ? '0.0' : x === '1' ? '1.0' : `${neg0}${base}.${x}`}`).join(', ')})`;
          break;
        }
        case 'KIL': lines.push(`  if (any(lessThan(${a}, vec4(0.0)))) discard;`); continue;
        case 'TEX': case 'TXP': case 'TXB': {
          const type = TARGETS[inst.target];
          const had = samplers.get(inst.unit);
          if (had && had !== inst.target) throw new ArbError(`texture[${inst.unit}] used as both ${had} and ${inst.target}`, inst.pos);
          samplers.set(inst.unit, inst.target);
          const s = `prism_tex${inst.unit}`;
          const coord = type === 'samplerCube' || type === 'sampler3D' ? 'xyz' : 'xy';
          if (inst.op === 'TEX') e = `texture(${s}, (${a}).${coord})`;
          else if (inst.op === 'TXB') e = `texture(${s}, (${a}).${coord}, (${a}).w)`;
          else e = type === 'samplerCube' ? `texture(${s}, (${a}).xyz / (${a}).w)` : type === 'sampler3D' ? `textureProj(${s}, ${a})` : `textureProj(${s}, (${a}).xyw)`;
          break;
        }
        default: throw new ArbError(`${inst.op} is not implemented`, inst.pos);
      }
      if (inst.sat) e = `clamp(${e}, 0.0, 1.0)`;
      const d = inst.dst;
      let target;
      if (d.op.k === 'temp') target = `t_${d.op.name}`;
      else if (stage === 'vertex') {
        if (d.op.name === 'ignored') continue;
        target = d.op.name === 'pos' ? 'r_pos' : `r_${d.op.name}`;
        if (d.op.name !== 'pos') varyings.add(`w:${d.op.name}`);
      } else target = d.op.name === 'depth' ? 'r_depth' : 'r_col';
      // every expression is a vec4 (a scalar one replicated), so a write mask takes the same components of it
      const mask = d.mask;
      lines.push(mask === 'xyzw' ? `  ${target} = ${e};` : `  ${target}.${mask} = (${e}).${mask};`);
    }
    return lines;
  };

  const HELPERS = `vec4 prism_row(mat4 m, int r) { return vec4(m[0][r], m[1][r], m[2][r], m[3][r]); }
vec4 prism_lit(vec4 s) {
  float d = max(s.x, 0.0), sp = max(s.y, 0.0), e = clamp(s.w, -128.0, 128.0);
  return vec4(1.0, d, s.x > 0.0 ? pow(sp, e) : 0.0, 1.0);
}
vec4 prism_exp(float x) { float f = floor(x); return vec4(exp2(f), x - f, exp2(x), 1.0); }
vec4 prism_log(float x) { float a = abs(x), f = floor(log2(a)); return vec4(f, a / exp2(f), log2(a), 1.0); }
`;

  // The fragment side first: what it reads decides what the vertex side must write.
  const fsBody = fp ? body(fp, 'fragment') : null;
  const fpReads = new Set([...varyings].filter((v) => !v.startsWith('w:')));
  varyings.clear();
  const vsBody = vp ? body(vp, 'vertex') : null;
  const vpWrites = new Set([...varyings].filter((v) => v.startsWith('w:')).map((v) => v.slice(2)));
  // The fixed function's halves: a vertex stage that passes the colour and the coordinates the fragment
  // program reads; a fragment stage that outputs the interpolated colour (Doom 3's shadow volumes write no
  // colour at all), modulated by texture unit 0 when the program writes its coordinate.
  const vary = fp ? [...fpReads] : [...new Set(['col', ...vpWrites])].filter((v) => v === 'col' || v === 'col2' || /^tc\d+$/.test(v));
  const varyDecl = (dir) => vary.map((v) => `${dir} vec4 v_${v};`).join('\n');

  // Vertex shader
  const posInvariant = vp?.options.has('ARB_position_invariant') ?? true;
  // The fixed function's own expression (gl.js tnlVS): GLSL ES makes a position invariant across two
  // shaders only when both compute it alike, and Doom 3's GL_EQUAL light passes need it to the bit.
  if (posInvariant) { matrices.add('modelview'); matrices.add('projection'); }
  const vsLines = [];
  if (vp) vsLines.push(...vsBody);
  else for (const v of vary) vertexInputs.add(v);          // the fixed function passes its arrays through
  const vsHeadUniforms = () => [
    env.vertex ? `uniform vec4 prism_envV[${env.vertex}];` : '',
    local.vertex ? `uniform vec4 prism_localV[${local.vertex}];` : '',
  ];
  const fsHeadUniforms = () => [
    env.fragment ? `uniform vec4 prism_envF[${env.fragment}];` : '',
    local.fragment ? `uniform vec4 prism_localF[${local.fragment}];` : '',
  ];
  const inputs = [...vertexInputs].sort((x, y) => (x === 'pos' ? -1 : y === 'pos' ? 1 : x < y ? -1 : 1));
  const vs = [
    '#version 300 es',
    'precision highp float;',
    ...inputs.map((n) => `in vec4 a_${n};`),
    ...vsHeadUniforms(),
    ...[...matrices].map((m) => `uniform mat4 prism_m_${m};`),
    varyDecl('out'),
    HELPERS,
    'invariant gl_Position;',
    'void main() {',
    '  vec4 r_pos = vec4(0.0, 0.0, 0.0, 1.0);',
    // every result the program writes, read by the fragment stage or not, and every one it reads
    ...[...new Set([...vary, ...vpWrites])].map((v) => `  vec4 r_${v} = vec4(0.0, 0.0, 0.0, 1.0);`),
    ...(vp ? vsLines : vary.map((v) => `  r_${v} = a_${v};`)),
    posInvariant ? '  r_pos = prism_m_projection * (prism_m_modelview * a_pos);' : '',
    '  gl_Position = r_pos;',
    // the colour results are clamped on their way to the fragment stage (ARB_vertex_program 2.14.5)
    ...vary.map((v) => (v === 'col' || v === 'col2' ? `  v_${v} = clamp(r_${v}, 0.0, 1.0);` : `  v_${v} = r_${v};`)),
    '}',
  ].filter((l) => l !== '').join('\n');

  // Fragment shader
  const fs = [
    '#version 300 es',
    'precision highp float;',
    'precision highp sampler3D;',
    varyDecl('in'),
    ...fsHeadUniforms(),
    ...[...samplers].map(([u, tgt]) => `uniform ${TARGETS[tgt]} prism_tex${u};`),
    'out vec4 prism_out;',
    HELPERS,
    'void main() {',
    '  vec4 r_col = vec4(0.0, 0.0, 0.0, 1.0);',
    '  vec4 r_depth = vec4(gl_FragCoord.z);',
    ...(fp ? fsBody : [vary.includes('col') ? '  r_col = v_col;' : '  r_col = vec4(1.0);']),
    '  prism_out = r_col;',
    ...(fp && fp.insts.some((x) => x.dst?.op.name === 'depth') ? ['  gl_FragDepth = r_depth.z;'] : []),
    '}',
  ].join('\n');
  return { vs, fs, inputs, matrices: [...matrices], env, local, samplers };
}

export { ArbError };
