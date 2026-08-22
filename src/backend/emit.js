// emit.js — the tier-0 JavaScript emitter.
//
// Tier-0 is the COLD path: compact, generic, no optimisation. Memory goes through a DataView so
// unaligned access is correct without proof, and every integer op is written in its canonical
// 32-bit form. Tier-1 (roadmap P2.3) re-emits hot functions with typed-array views, unboxed locals
// and inline caches; the two must produce identical state, which is why tier-0 stays this literal.
//
// Value representation, chosen once and relied on everywhere:
//   * every integer type ≤ 32 bits is a JS int32 holding the two's-complement BIT PATTERN.
//     Signedness is applied at the operations where it is observable — /, %, >>, and comparisons —
//     not carried around as a tag. `unsigned` is therefore free on +, -, *, &, |, ^ and <<.
//   * a pointer is that same int32: an offset into the module's one ArrayBuffer.
//   * `float` is a JS number kept exact with Math.fround at every store and every operation;
//     `double` is a JS number unchanged.
//
// The one local-variable decision that matters for speed is made even in tier-0: a scalar whose
// address is never taken lives in a JS `var` and never touches memory. Everything else — arrays,
// structs, unions, anything with `&` applied to it — gets a shadow-stack slot.

import * as T from '../sema/types.js';
import { findField, constEval } from '../parse/parser.js';
import { FUNC_TAG } from '../link/module.js';
import { isWideLiteral, literalBytes, literalUnits } from '../util/charset.js';

export class EmitError extends Error {}


const unsup = (what) => { throw new EmitError(`tier-0 does not support ${what} yet`); };

// ---------------------------------------------------------------- load / store

/** The DataView accessor for a scalar type, and whether the loaded value needs no fixup. */
function accessor(t) {
  if (t.k === 'ptr' || t.k === 'func') return { get: 'getInt32', set: 'setInt32', endian: true };
  if (t.k === 'enum') return { get: 'getInt32', set: 'setInt32', endian: true };
  if (t.k !== 'scalar') return null;
  switch (t.name) {
    case '_Bool': case 'unsigned char': return { get: 'getUint8', set: 'setUint8', endian: false };
    case 'char': return { get: T.CHAR.signed ? 'getInt8' : 'getUint8', set: 'setInt8', endian: false };
    case 'signed char': return { get: 'getInt8', set: 'setInt8', endian: false };
    case 'short': return { get: 'getInt16', set: 'setInt16', endian: true };
    case 'unsigned short': return { get: 'getUint16', set: 'setUint16', endian: true };
    case 'int': case 'long': return { get: 'getInt32', set: 'setInt32', endian: true };
    case 'unsigned int': case 'unsigned long': return { get: 'getInt32', set: 'setInt32', endian: true };
    case 'float': return { get: 'getFloat32', set: 'setFloat32', endian: true };
    case 'double': return { get: 'getFloat64', set: 'setFloat64', endian: true };
    case 'long long': return { get: 'getBigInt64', set: 'setBigInt64', endian: true };
    case 'unsigned long long': return { get: 'getBigUint64', set: 'setBigUint64', endian: true };
    case 'long double': return unsup('long double');
  }
  return null;
}

const loadExpr = (addr, t) => {
  const a = accessor(t);
  if (!a) unsup(`loading a ${T.typeName(t)}`);
  return `D.${a.get}(${addr}${a.endian ? ',1' : ''})`;
};
const storeExpr = (addr, t, val) => {
  const a = accessor(t);
  if (!a) unsup(`storing a ${T.typeName(t)}`);
  return `D.${a.set}(${addr},${val}${a.endian ? ',1' : ''})`;
};

/** Types tier-0 cannot represent at all. Checked on every conversion, which is the one place every
 *  value must pass through — a check only on load/store misses a local kept in a JS var. */
const WIDE = new Set(['long double']);

/**
 * A 64-bit integer is a BigInt in tier-0. The plan calls for i32 pairs, and tier-1 will lower them,
 * but tier-0 is the compact/generic path: BigInt is correct by construction (arbitrary precision plus
 * an explicit 64-bit mask) where pairs need a twenty-function helper library and a return-value
 * convention. The cost is speed, which is exactly what tier-1 exists to fix.
 *
 * The hazard is that JS throws on mixing BigInt with Number, so EVERY conversion in or out has to be
 * explicit — which is why `coerce` handles i64 before anything else.
 */
export const is64 = (t) => t && t.k === 'scalar' && (t.name === 'long long' || t.name === 'unsigned long long');
const mask64 = (js, t) => `BigInt.as${t.signed ? 'Int' : 'Uint'}N(64,${js})`;
const checkWide = (t) => { if (t && t.k === 'scalar' && WIDE.has(t.name)) unsup(t.name); };

/** Truncate/extend a 32-bit value to a narrower type, as an assignment or cast must. */
function coerce(js, from, to) {
  checkWide(from); checkWide(to);

  // 64-bit conversions come first: nothing below may see a BigInt on one side and a Number on the
  // other, because JS throws rather than converting.
  if (is64(to)) {
    if (is64(from)) return mask64(js, to);
    if (T.isFloat(from)) return mask64(`BigInt(Math.trunc(${js}))`, to);
    return mask64(`BigInt(${T.isUnsigned(from) ? `(${js})>>>0` : `(${js})|0`})`, to);
  }
  if (is64(from)) {
    if (T.isFloat(to)) return to.name === 'float' ? `Math.fround(Number(${js}))` : `Number(${js})`;
    // Narrowing to 32 bits or less: truncate in BigInt, then leave the BigInt world exactly once.
    return coerce(`Number(BigInt.asIntN(32,${js}))`, T.INT, to);
  }
  if (T.isFloat(to)) {
    const v = T.isFloat(from) ? js : (T.isUnsigned(from) ? `(${js}>>>0)` : `(${js}|0)`);
    return to.name === 'float' ? `Math.fround(${v})` : `+(${v})`;
  }
  if (T.isFloat(from)) {
    // C truncates toward zero. `|0` does exactly that for the in-range case, which is all C defines.
    return T.isUnsigned(to) ? `((${js})>>>0)` : `((${js})|0)`;
  }
  if (to.k === 'ptr' || to.k === 'func') return `(${js}|0)`;
  if (to.k === 'enum') return `(${js}|0)`;
  if (to.k === 'void') return `(${js})`;
  switch (to.name) {
    case '_Bool': return `((${js})!==0?1:0)`;
    case 'char': return T.CHAR.signed ? `((${js})<<24>>24)` : `((${js})&255)`;
    case 'signed char': return `((${js})<<24>>24)`;
    case 'unsigned char': return `((${js})&255)`;
    case 'short': return `((${js})<<16>>16)`;
    case 'unsigned short': return `((${js})&65535)`;
    default: return `((${js})|0)`;
  }
}

// ---------------------------------------------------------------- the function emitter

export class FunctionEmitter {
  /** @param mod the Module @param decl the `func` AST node @param globals name -> {addr,type} */
  constructor(mod, decl, ctx) {
    this.mod = mod;
    this.decl = decl;
    this.ctx = ctx;                 // {globals: Map, funcs: Map, builtins: Set}
    this.locals = new Map();        // name -> {kind:'var'|'slot', js?, off?, type}
    this.frameSize = 0;
    this.tmp = 0;
    this.out = [];
    this.loopDepth = 0;
  }

  newTmp() { return `_t${this.tmp++}`; }

  /**
   * A local that must live in memory gets a frame slot, and the returned offset is its START.
   * Returning the post-bump frame size instead placed every aggregate one object too high — which
   * showed up as `*p` reading a[2] and as a DataView range error once the frame reached the top of
   * the buffer. Two symptoms, one off-by-its-own-size.
   */
  slot(size, align) {
    const off = Math.ceil(this.frameSize / align) * align;
    this.frameSize = off + size;
    return off;
  }

  emit() {
    const d = this.decl;
    // A struct RETURN uses the sret convention: the caller supplies the buffer, because the callee's
    // own frame is released before the value could be read out of it.
    this.sret = T.isRecord(d.type.ret);
    const params = d.type.params.map((p, i) => p.name ?? `_unused${i}`);
    if (this.sret) params.unshift('_sret');
    // A variadic function takes the caller-packed argument buffer as a hidden last parameter, which
    // is what `va_start` resolves to.
    this.variadic = !!d.type.variadic;
    if (this.variadic) params.push('_va');

    // Which locals escape? A scalar that is never `&`-taken can live in a JS var. Everything with
    // an address, and every aggregate, needs a slot. This single decision is the difference between
    // "a few times slower than native" and "tens of times".
    const escaped = new Set();
    collectAddressTaken(d.body, escaped);

    const pre = [];
    for (const p of d.type.params) {
      if (!p.name) continue;
      if (T.isRecord(p.type)) {
        // The caller already made a fresh copy, so the callee may modify it in place — no second
        // copy is needed, and `&param` is simply that address.
        this.locals.set(p.name, { kind: 'aggparam', js: p.name, type: p.type });
        continue;
      }
      if (p.type.k === 'array') unsup('an array parameter by value');
      if (escaped.has(p.name)) {
        const off = this.slot(p.type.size, p.type.align);
        this.locals.set(p.name, { kind: 'slot', off, type: p.type });
        pre.push({ off, type: p.type, from: p.name });
      } else {
        this.locals.set(p.name, { kind: 'var', js: p.name, type: p.type });
      }
    }

    // `goto` is emitted as a state machine over the function's TOP-LEVEL statements: a labelled
    // `for(;;) switch(_pc)`, where a jump sets _pc and `continue`s. JS switch fallthrough reproduces
    // C label fallthrough exactly, and `continue _top` from inside a nested loop unwinds it — which
    // is what a goto out of a loop must do. A label nested inside a block or loop would need real
    // control-flow flattening and is still refused.
    this.labels = this.#planLabels(d.body);
    if (this.labels) {
      this.out.push('var _pc=0;');
      this.out.push('_top: for(;;){ switch(_pc){');
      for (const [k, seg] of this.labels.segments.entries()) {
        this.out.push(`case ${k}:`);
        for (const item of seg) this.#item(item, escaped);
      }
      this.out.push('} break _top; }');
    } else {
      this.#block(d.body, escaped);
    }

    const body = [];
    body.push(`var _fp=M.sp-${this.frameSize}|0;`);
    if (this.frameSize) body.push(`M.sp=_fp;`);
    for (const p of pre) body.push('  ' + storeExpr(`(_fp+${p.off}|0)`, p.type, coerce(p.from, p.type, p.type)) + ';');
    body.push(...this.out.map(l => '  ' + l));
    if (this.frameSize) body.push(`  M.sp=_fp+${this.frameSize}|0;`);
    body.push(`  return ${d.type.ret.k === 'void' ? '' : (is64(d.type.ret) ? '0n' : '0')};`);

    return `function ${d.name}(${params.join(',')}){\n${body.join('\n')}\n}`;
  }

  /**
   * Split a function body at its top-level labels. Returns null when the function has no labels, and
   * throws when a label sits inside a nested block — that case needs control-flow flattening.
   */
  #planLabels(body) {
    // A `label` node wraps the statement that follows it, so flatten it back into a marker plus
    // that statement before splitting.
    const flat = [];
    const walk = (items) => {
      for (const it of items) {
        if (it.n === 'label') { flat.push({ mark: it.name }); walk([it.body]); continue; }
        flat.push(it);
      }
    };
    walk(body.items);
    const names = flat.filter(x => x.mark).map(x => x.mark);
    if (!names.length) {
      // A goto with no TOP-LEVEL label means the label is nested inside a block or loop, which needs
      // real control-flow flattening. Say that, rather than the misleading "no label in this
      // function" this used to report.
      if (findGoto(body)) unsup('a label nested inside a block');
      return null;
    }

    // Every goto in the function must target one of these top-level labels.
    for (const target of collectGotoTargets(body)) {
      if (!names.includes(target)) unsup(`goto into a nested block ('${target}')`);
    }

    const segments = [[]];
    const index = new Map();
    for (const x of flat) {
      if (x.mark) { index.set(x.mark, segments.length); segments.push([]); continue; }
      segments[segments.length - 1].push(x);
    }
    return { segments, index };
  }

  // ------------------------------------------------------------- statements

  #block(node, escaped) {
    for (const item of node.items) this.#item(item, escaped);
  }

  #item(item, escaped) {
    switch (item.n) {
      case 'vardecl': return this.#localDecl(item, escaped);
      case 'typedef': case 'tagdecl': return;
      case 'func': return unsup('a nested function definition');
      default: return this.#stmt(item, escaped);
    }
  }

  #localDecl(d, escaped) {
    if (d.storage === 'extern') {
      // `extern` inside a block REFERS to the file-scope object; it does not create one. Giving it
      // a private global shadowed the real `v` and gcc's scope-1.c exists to catch exactly that.
      const g = this.ctx.globals.get(d.name);
      if (g) { this.locals.set(d.name, { kind: 'global', addr: g.addr, type: g.type }); return; }
      const f = this.ctx.funcs.get(d.name);
      if (f) { this.locals.set(d.name, { kind: 'global', addr: f.addr, type: f.type }); return; }
      // Nothing to bind to: leave the name unresolved so a use reports it rather than reading a
      // silently invented object.
      return;
    }
    if (d.storage === 'static') {
      // A static local is a global with a private name; its address must survive the call.
      const sym = this.mod.defineGlobal(`${this.decl.name}.${d.name}`, d.type);
      this.locals.set(d.name, { kind: 'global', addr: sym.addr, type: d.type });
      if (d.init) this.initStatic(sym.addr, d.type, d.init);
      return;
    }
    checkWide(d.type);
    const isAggregate = d.type.k === 'array' || T.isRecord(d.type);
    if (isAggregate || escaped.has(d.name)) {
      if (d.type.size == null) unsup('a local of incomplete type');
      const off = this.slot(d.type.size, d.type.align);
      this.locals.set(d.name, { kind: 'slot', off, type: d.type });
      if (d.init) this.#initDynamic(`(_fp+${off}|0)`, d.type, d.init);
      return;
    }
    const js = `_v_${d.name}`;
    this.locals.set(d.name, { kind: 'var', js, type: d.type });
    const init = d.init ? this.#rvalCoerced(d.init.expr, d.type) : (is64(d.type) ? '0n' : '0');
    this.out.push(`var ${js}=${init};`);
  }

  #initDynamic(addr, type, init) {
    if (init.n === 'init') {
      const isAggregate = type.k === 'array' || T.isRecord(type);
      if (isAggregate) {
        // `struct box c = b;` and `char s[8] = "abc";` are copies, not stores.
        if (init.expr.n === 'str') {
          const src = this.#stringAddr(init.expr);
          const wideAll = init.expr.parts.some(pp => isWideLiteral(pp.v));
          const elem = wideAll ? 4 : 1;
          let n = 0;
          for (const part of init.expr.parts) n += literalBytes(part.v, wideAll).bytes.length;
          this.out.push(`M.copy(${addr},${src},${Math.min(n + elem, type.size)});`);
          return;
        }
        const r = this.#lval(init.expr);
        this.out.push(`M.copy(${addr},${r.addr},${type.size});`);
        return;
      }
      this.out.push(storeExpr(addr, type, this.#rvalCoerced(init.expr, type)) + ';');
      return;
    }
    // A brace initializer: zero the object, then write the listed members.
    this.out.push(`M.zero(${addr},${type.size});`);
    this.#initList(addr, type, init);
  }

  #initList(addr, type, init) {
    if (type.k === 'array') {
      let idx = 0;
      for (const it of init.items) {
        if (it.designators) idx = it.designators[0].index ?? idx;
        const off = `(${addr}+${idx * type.of.size}|0)`;
        if (it.value.n === 'initlist') this.#initList(off, type.of, it.value);
        else this.out.push(storeExpr(off, type.of, this.#rvalCoerced(it.value.expr, type.of)) + ';');
        idx++;
      }
      return;
    }
    if (T.isRecord(type)) {
      // Bitfields ARE initialisable members and must not be filtered out: skipping them left
      // `struct { signed s:3; unsigned u:3; } x = {-1,-1}` completely unwritten.
      const named = type.fields.filter(f => f.name && f.width !== 0);
      let k = 0;
      for (const it of init.items) {
        let f = named[k];
        if (it.designators?.[0]?.field) f = findField(type, it.designators[0].field);
        if (!f) break;
        // Initialising a FLEXIBLE array member writes past the struct's nominal size; it is a GNU
        // extension and tier-0 refuses it rather than producing a plausible wrong object.
        if (f.flexible) unsup('initialising a flexible array member');
        if (f.bits !== undefined) {
          this.#initBitfield(addr, f, this.#rvalCoerced(it.value.expr, f.type));
        } else {
          const off = `(${addr}+${f.offset}|0)`;
          if (it.value.n === 'initlist') this.#initList(off, f.type, it.value);
          else this.out.push(storeExpr(off, f.type, this.#rvalCoerced(it.value.expr, f.type)) + ';');
        }
        k = named.indexOf(f) + 1;
      }
      return;
    }
    // A scalar in braces: `int x = { 1 };`
    if (init.items.length) {
      this.out.push(storeExpr(addr, type, this.#rvalCoerced(init.items[0].value.expr, type)) + ';');
    }
  }

  /** Public: the driver uses this for file-scope initialisers too. */
  initStatic(addr, type, init) {
    // Static initialisers are written into the image at link time where they are constant, and
    // otherwise deferred to a start-up thunk. Tier-0 only handles the constant case.
    if (init.n === 'init') {
      if (this.#staticScalar(addr, type, init.expr)) return;
    }
    if (init.n === 'initlist') { this.#staticList(addr, type, init); return; }
    unsup('a non-constant static initialiser');
  }

  /** One constant scalar, pointer or string into the image. Returns false if not constant. */
  #staticScalar(addr, type, expr) {
    if (expr.n === 'str') {
      const wideAll = expr.parts.some(pp => isWideLiteral(pp.v));
      const elem = wideAll ? 4 : 1;
      const bytes = [];
      for (const part of expr.parts) bytes.push(...literalBytes(part.v, wideAll).bytes);
      if (type.k === 'array') {
        // The array holds the literal's bytes, plus a full-width terminator only if it fits.
        const n = Math.min(bytes.length, type.size);
        this.mod.u8.set(bytes.slice(0, n), addr);
        for (let k = 0; k < elem && bytes.length + k < type.size; k++) this.mod.u8[addr + bytes.length + k] = 0;
        return true;
      }
      writeConst(this.mod, addr, type, this.#stringAddr(expr));
      return true;
    }
    if (expr.n === 'labeladdr') {
      const k = this.labels?.index.get(expr.name);
      if (k === undefined) unsup(`the address of label '${expr.name}' in a static initialiser`);
      writeConst(this.mod, addr, type, k);
      return true;
    }

    // A 64-bit initialiser must be folded in BigInt: going through Number would silently lose the
    // low bits of anything past 2^53.
    if (is64(type)) {
      try { writeConst(this.mod, addr, type, constEval(expr)); return true; } catch { /* fall through */ }
    }

    // An ADDRESS CONSTANT is a legal static initialiser and c-testsuite leans on it heavily:
    // `int *p = &x;`, `.p = &x`, `&arr[2]`, `&s.field`, `name + 1`. It is constant because every
    // global already has its address by the time any initialiser is written.
    const a = this.#addrConst(expr);
    if (a !== null) { writeConst(this.mod, addr, type, a); return true; }

    try {
      writeConst(this.mod, addr, type, evalConstNumber(expr));
      return true;
    } catch { return false; }
  }

  /** Fold a constant address expression, or return null if it is not one. */
  #addrConst(e) {
    switch (e.n) {
      case 'cast': return this.#addrConst(e.expr);
      case 'unary':
        if (e.op === '&') return this.#lvalAddrConst(e.expr);
        return null;
      case 'ident': {
        // An array or function name decays to its own address without needing `&`.
        const g = this.ctx.globals?.get(e.name);
        if (g && g.type.k === 'array') return g.addr;
        const f = this.ctx.funcs?.get(e.name);
        if (f) return f.addr;
        return null;
      }
      case 'bin': {
        if (e.op !== '+' && e.op !== '-') return null;
        const base = this.#addrConst(e.a);
        if (base === null) return null;
        // The offset scales by the pointee, exactly as at run time.
        const elem = T.decay(e.a.type ?? T.INT);
        const step = elem.k === 'ptr' ? (elem.to.size ?? 1) : 1;
        let n;
        try { n = evalConstNumber(e.b); } catch { return null; }
        return e.op === '+' ? base + n * step : base - n * step;
      }
    }
    return null;
  }

  /** The constant address of a static lvalue: a global, a member of one, an element of one. */
  #lvalAddrConst(e) {
    switch (e.n) {
      case 'ident': {
        const g = this.ctx.globals?.get(e.name);
        if (g) return g.addr;
        const f = this.ctx.funcs?.get(e.name);
        if (f) return f.addr;
        return null;
      }
      case 'member': {
        if (e.arrow) return null;
        const base = this.#lvalAddrConst(e.base);
        if (base === null) return null;
        const rec = e.base.type;
        if (!rec || !T.isRecord(rec)) return null;
        const f = findField(rec, e.field);
        return f && f.bits === undefined ? base + f.offset : null;
      }
      case 'index': {
        const base = this.#lvalAddrConst(e.base) ?? this.#addrConst(e.base);
        if (base === null) return null;
        const bt = T.decay(e.base.type ?? T.INT);
        if (bt.k !== 'ptr') return null;
        let n;
        try { n = evalConstNumber(e.index); } catch { return null; }
        return base + n * (bt.to.size ?? 1);
      }
      case 'str': return this.#stringAddr(e);
    }
    return null;
  }

  #staticList(addr, type, init) {
    if (type.k === 'array') {
      let idx = 0;
      for (const it of init.items) {
        if (it.designators) idx = it.designators[0].index ?? idx;
        if (it.value.n === 'initlist') this.#staticList(addr + idx * type.of.size, type.of, it.value);
        else if (!this.#staticScalar(addr + idx * type.of.size, type.of, it.value.expr)) {
          unsup('a non-constant static initialiser');
        }
        idx++;
      }
      return;
    }
    if (T.isRecord(type)) {
      // Bitfields are initialisable here too. The dynamic path was fixed first and this one was
      // not, so `struct s x = { -123, -456 };` at file scope still wrote nothing (gcc's bitfld-4.c).
      const named = type.fields.filter(f => f.name && f.width !== 0);
      let k = 0;
      for (const it of init.items) {
        let f = named[k];
        if (it.designators?.[0]?.field) f = findField(type, it.designators[0].field);
        if (!f) break;
        // Initialising a FLEXIBLE array member writes past the struct's nominal size; it is a GNU
        // extension and tier-0 refuses it rather than producing a plausible wrong object.
        if (f.flexible) unsup('initialising a flexible array member');
        if (f.bits !== undefined) {
          let v;
          try { v = evalConstNumber(it.value.expr); } catch { unsup('a non-constant bitfield initialiser'); }
          writeStaticBitfield(this.mod, addr, f, v);
        } else if (it.value.n === 'initlist') {
          this.#staticList(addr + f.offset, f.type, it.value);
        } else if (!this.#staticScalar(addr + f.offset, f.type, it.value.expr)) {
          unsup('a non-constant static initialiser');
        }
        k = named.indexOf(f) + 1;
      }
      return;
    }
    if (init.items.length) this.#staticScalar(addr, type, init.items[0].value.expr);
  }

  #stmt(s, escaped) {
    switch (s.n) {
      case 'empty': return;
      case 'block': {
        this.out.push('{');
        this.#block(s, escaped);
        this.out.push('}');
        return;
      }
      case 'exprstmt': this.out.push(this.#rval(s.expr).js + ';'); return;
      case 'decls': for (const d of s.decls) this.#item(d, escaped); return;
      case 'if': {
        this.out.push(`if(${this.#truth(s.cond)}){`);
        this.#stmt(s.then, escaped);
        if (s.els) { this.out.push('}else{'); this.#stmt(s.els, escaped); }
        this.out.push('}');
        return;
      }
      case 'while': {
        this.out.push(`while(${this.#truth(s.cond)}){`);
        this.loopDepth++; this.#stmt(s.body, escaped); this.loopDepth--;
        this.out.push('}');
        return;
      }
      case 'do': {
        this.out.push('do{');
        this.loopDepth++; this.#stmt(s.body, escaped); this.loopDepth--;
        this.out.push(`}while(${this.#truth(s.cond)});`);
        return;
      }
      case 'for': {
        // The init clause may declare, so it is emitted BEFORE the loop and the JS `for` gets an
        // empty init — block scoping is already handled by the parser's scopes.
        if (s.init) this.#item(s.init.n === 'decls' ? s.init : s.init, escaped);
        const cond = s.cond ? this.#truth(s.cond) : 'true';
        const step = s.step ? this.#rval(s.step).js : '';
        this.out.push(`for(;${cond};${step}){`);
        this.loopDepth++; this.#stmt(s.body, escaped); this.loopDepth--;
        this.out.push('}');
        return;
      }
      case 'switch': {
        const d = this.#rval(s.disc);
        this.out.push(`switch(${d.js}|0){`);
        // The braces of the body are dropped on purpose: `switch(x){{case 0:...}}` is a syntax
        // error in JavaScript, where a switch's cases must be direct children.
        if (s.body.n === 'block') this.#block(s.body, escaped);
        else this.#stmt(s.body, escaped);
        this.out.push('}');
        return;
      }
      case 'case': {
        if (s.hi !== null && s.hi !== undefined) {
          // GNU case ranges: expand, which is what gcc does too.
          for (let v = s.lo; v <= s.hi; v++) this.out.push(`case ${Number(v)}:`);
        } else this.out.push(`case ${Number(s.lo)}:`);
        this.#stmt(s.body, escaped);
        return;
      }
      case 'default': this.out.push('default:'); this.#stmt(s.body, escaped); return;
      case 'break': this.out.push('break;'); return;
      case 'continue': this.out.push('continue;'); return;
      case 'return': {
        const ret = this.decl.type.ret;
        if (!s.expr || ret.k === 'void') {
          if (this.frameSize) this.out.push(`M.sp=_fp+${this.frameSize}|0;`);
          this.out.push('return;');
          return;
        }
        // The value is computed FIRST, into a temp, and only then is the frame released. Releasing
        // it first lets `return foo(x)` run foo on a frame that overlaps this one — foo's own locals
        // then overwrite the array whose address was just passed to it. Found by c-testsuite 00077,
        // never by a hand-written case, because it needs an aggregate local AND a call in a return.
        if (T.isRecord(ret)) {
          const src = this.#lval(s.expr);
          this.out.push(`M.copy(_sret,${src.addr},${ret.size});`);
          if (this.frameSize) this.out.push(`M.sp=_fp+${this.frameSize}|0;`);
          this.out.push('return _sret;');
          return;
        }
        const v = this.#rvalCoerced(s.expr, ret);
        if (!this.frameSize) { this.out.push(`return ${v};`); return; }
        const t = this.newTmp(); this.#declareTmp(t);
        this.out.push(`${t}=${v};`);
        this.out.push(`M.sp=_fp+${this.frameSize}|0;`);
        this.out.push(`return ${t};`);
        return;
      }
      case 'label': {
        // Reached only when a label is nested; the planner rejects that, so this is the top-level
        // case where the marker has already opened a new switch arm.
        this.#stmt(s.body, escaped);
        return;
      }
      case 'goto': {
        const k = this.labels?.index.get(s.label);
        if (k === undefined) unsup(`goto '${s.label}'`);
        this.out.push(`{_pc=${k}; continue _top;}`);
        return;
      }
      case 'gotoexpr': {
        // A computed goto is the state machine's natural form: the "address" of a label IS its _pc
        // value, so `goto *p` is simply a dispatch on p.
        if (!this.labels) unsup('a computed goto with no labels in this function');
        const v = this.#rval(s.expr);
        this.out.push(`{_pc=(${v.js})|0; continue _top;}`);
        return;
      }
      case 'asm': {
        // An asm whose template is empty emits no instructions — it exists only as a barrier — so
        // with no output operands the faithful translation is nothing at all. Its INPUTS are still
        // evaluated, because they are ordinary C expressions and may have side effects.
        const text = (s.template ?? []).map(t => t.replace(/^L?"|"$/g, '')).join('').trim();
        // An empty template emits no instructions, so with NO OUTPUT OPERANDS it is faithfully a
        // no-op — its inputs are still evaluated, being ordinary C expressions with possible side
        // effects.
        //
        // With an output operand it is NOT a no-op, and generalising to "empty template = nothing"
        // was wrong: a tied constraint carries a value through the shared register even with an
        // empty template, so `asm ("" : "=r" (i) : "0" (x))` copies x into i (gcc's 20030222-1.c).
        // Refusing is the honest answer until constraints are modelled.
        if (text === '' && (s.outputs ?? []).length === 0) {
          for (const op of s.inputs ?? []) {
            if (op.expr) this.out.push(this.#rval(op.expr).js + ';');
          }
          return;
        }
        return unsup('inline assembly');
      }
    }
    unsup(`statement '${s.n}'`);
  }

  #truth(e) {
    const v = this.#rval(e);
    // A BigInt is never `!== 0` in the Number sense — the comparison has to use 0n.
    return is64(T.decay(v.type ?? T.INT)) ? `(${v.js})!==0n` : `(${v.js})!==0`;
  }

  // ------------------------------------------------------------- expressions

  /** An lvalue: an address expression plus its type. */
  #lval(e) {
    switch (e.n) {
      case 'ident': {
        const l = this.locals.get(e.name);
        if (l) {
          if (l.kind === 'slot') return { addr: `(_fp+${l.off}|0)`, type: l.type };
          if (l.kind === 'global') return { addr: String(l.addr), type: l.type };
          if (l.kind === 'aggparam') return { addr: `(${l.js}|0)`, type: l.type };
          return { varJs: l.js, type: l.type };
        }
        const g = this.ctx.globals.get(e.name);
        if (g) return { addr: String(g.addr), type: g.type };
        const f = this.ctx.funcs.get(e.name);
        if (f) return { addr: String(f.addr), type: f.type, isFunc: true };
        throw new EmitError(`undeclared identifier '${e.name}'`);
      }
      case 'unary':
        if (e.op === '*') {
          const p = this.#rval(e.expr);
          const to = p.type.k === 'ptr' ? p.type.to : (p.type.k === 'array' ? p.type.of : null);
          if (!to) throw new EmitError('dereferencing a non-pointer');
          return { addr: `((${p.js})|0)`, type: to };
        }
        break;
      case 'index': {
        const b = this.#rval(e.base);
        const i = this.#rval(e.index);
        const bt = T.decay(b.type);
        if (bt.k !== 'ptr') throw new EmitError('subscripting a non-pointer');
        const es = bt.to.size ?? 1;
        return { addr: `((${b.js})+Math.imul(${i.js}|0,${es})|0)`, type: bt.to };
      }
      case 'member': {
        let recAddr, rec;
        if (e.arrow) {
          const p = this.#rval(e.base);
          rec = p.type.k === 'ptr' ? p.type.to : p.type;
          recAddr = `((${p.js})|0)`;
        } else {
          const l = this.#lval(e.base);
          if (l.varJs) throw new EmitError('member access on a value with no address');
          rec = l.type;
          recAddr = l.addr;
        }
        const f = findField(rec, e.field);
        if (!f) throw new EmitError(`'${T.typeName(rec)}' has no member '${e.field}'`);
        if (f.bits !== undefined) return { addr: recAddr, type: f.type, bitfield: f };
        return { addr: `(${recAddr}+${f.offset}|0)`, type: f.type };
      }
      case 'str': {
        const addr = this.#stringAddr(e);
        return { addr: String(addr), type: e.type ?? T.array(T.CHAR, null), isString: true };
      }
      case 'call': {
        // The call evaluates to the address of the sret buffer, so `f().field` and `x = f()` both
        // work — and it is evaluated exactly once, which is why the caller must not use this twice.
        const c = this.#rval(e);
        if (!T.isRecord(c.type)) throw new EmitError('a call returning a scalar is not an lvalue');
        return { addr: `(${c.js}|0)`, type: c.type };
      }
    }
    throw new EmitError(`'${e.n}' is not an lvalue`);
  }

  #stringAddr(e) {
    // `L"a" "b"` is ONE wide string: the wideness of the concatenation is decided first, and every
    // part is then encoded at that width. Encoding each part at its own width put a 1-byte 'b' after
    // a 4-byte 'a' (20010325-1.c).
    const wide = e.parts.some(p => isWideLiteral(p.v));
    const bytes = [];
    for (const part of e.parts) bytes.push(...literalBytes(part.v, wide).bytes);
    // Module.intern appends ONE NUL byte; a wide string needs a full 4-byte terminator.
    for (let k = 1; k < (wide ? 4 : 1); k++) bytes.push(0);
    return this.mod.intern(bytes);
  }

  /** An rvalue: a JS expression plus its C type. */
  #rval(e) {
    switch (e.n) {
      // The mask must follow the literal's SIGNEDNESS: asIntN on `18446744073709551615ULL` gives
      // -1n, and `(double)` of that is -1 (gcc's 920710-1.c).
      case 'num': return is64(e.type)
        ? { js: `${e.type.signed ? BigInt.asIntN(64, e.value) : BigInt.asUintN(64, e.value)}n`, type: e.type }
        : { js: String(BigInt.asIntN(32, e.value)), type: e.type };
      case 'char': return { js: String(Number(e.value)), type: T.INT };
      case 'float': return { js: e.type.name === 'float' ? `Math.fround(${e.value})` : String(e.value), type: e.type };
      // The element type comes from the literal, not from `char`: indexing `L"ab"` must read a
      // wchar_t. Hardcoding char here made `L"a" "b"[1]` read one byte (20010325-1.c).
      case 'str': return { js: String(this.#stringAddr(e)), type: T.ptr(e.type?.of ?? T.CHAR) };

      case 'ident': {
        const l = this.#lval(e);
        if (l.isFunc) return { js: l.addr, type: T.ptr(l.type) };
        if (l.varJs) return { js: l.varJs, type: l.type };
        if (l.type.k === 'array') return { js: l.addr, type: T.ptr(l.type.of) };
        if (l.type.k === 'func') return { js: l.addr, type: T.ptr(l.type) };
        return { js: loadExpr(l.addr, l.type), type: l.type };
      }

      case 'index': case 'member': {
        const l = this.#lval(e);
        // A bitfield read undergoes the INTEGER PROMOTIONS, and the promoted type is not the
        // declared one: `unsigned int u:7` becomes `int`, because an int represents every value a
        // 7-bit unsigned field can hold. Returning the declared type made `bit.u % 61` unsigned and
        // gcc's bitfld-1.c exists precisely to catch that.
        if (l.bitfield) return { js: this.#loadBitfield(l), type: bitfieldPromoted(l.bitfield) };
        if (l.type.k === 'array') return { js: l.addr, type: T.ptr(l.type.of) };
        return { js: loadExpr(l.addr, l.type), type: l.type };
      }

      case 'unary': return this.#unary(e);
      case 'bin': return this.#binary(e);
      case 'assign': return this.#assign(e);
      case 'cast': {
        const v = this.#rval(e.expr);
        if (e.type.k === 'void') return { js: `(${v.js},0)`, type: T.VOID };
        return { js: coerce(v.js, T.decay(v.type), e.type), type: e.type };
      }
      case 'cond': {
        const c = this.#truth(e.cond);
        const a = e.then ? this.#rval(e.then) : null;
        const b = this.#rval(e.els);
        const type = a ? unifyCond(a.type, b.type) : b.type;
        if (!a) { const t = this.newTmp(); return { js: `((${t}=${this.#rval(e.cond).js}),${t}!==0?${t}:${b.js})`, type, needsTmp: t }; }
        return { js: `(${c}?${coerceTo(a, type)}:${coerceTo(b, type)})`, type };
      }
      case 'comma': {
        const a = this.#rval(e.a), b = this.#rval(e.b);
        return { js: `(${a.js},${b.js})`, type: b.type };
      }
      case 'call': return this.#call(e);
      case 'preinc': case 'postinc': return this.#incdec(e);
      case 'labeladdr': {
        const k = this.labels?.index.get(e.name);
        if (k === undefined) unsup(`the address of label '${e.name}'`);
        return { js: String(k), type: T.ptr(T.VOID) };
      }
      case 'sizeoftype': return { js: String(e.target.size), type: T.UINT };
      case 'sizeofexpr': {
        const t = e.expr.type;
        if (!t || t.size == null) throw new EmitError('sizeof an expression of unknown type');
        return { js: String(t.size), type: T.UINT };
      }
      case 'alignoftype': return { js: String(e.target.align), type: T.UINT };
      case 'offsetof': case 'compound': case 'stmtexpr':
        return unsup(`'${e.n}'`);
    }
    throw new EmitError(`cannot emit expression '${e.n}'`);
  }

  #unary(e) {
    if (e.op === '&') {
      const l = this.#lval(e.expr);
      if (l.varJs) throw new EmitError(`internal: '&' on a variable that was not given a slot`);
      return { js: l.addr, type: T.ptr(l.type) };
    }
    if (e.op === '*') {
      const l = this.#lval(e);
      if (l.type.k === 'array') return { js: l.addr, type: T.ptr(l.type.of) };
      if (l.type.k === 'func') return { js: l.addr, type: T.ptr(l.type) };
      return { js: loadExpr(l.addr, l.type), type: l.type };
    }
    const v = this.#rval(e.expr);
    const t = T.promote(T.decay(v.type));
    const V = coerce(v.js, T.decay(v.type), t);
    if (is64(t)) {
      switch (e.op) {
        case '+': return { js: V, type: t };
        case '-': return { js: mask64(`-(${V})`, t), type: t };
        case '~': return { js: mask64(`~(${V})`, t), type: t };
        case '!': return { js: `((${V})===0n?1:0)`, type: T.INT };
      }
    }
    switch (e.op) {
      case '+': return { js: V, type: t };
      case '-': return T.isFloat(t) ? { js: `(-(${v.js}))`, type: t } : { js: `((0-(${v.js}))|0)`, type: t };
      case '~': return { js: `(~(${v.js}))`, type: t };
      case '!': return { js: `((${v.js})===0?1:0)`, type: T.INT };
    }
    throw new EmitError(`unary '${e.op}'`);
  }

  #binary(e) {
    const a = this.#rval(e.a), b = this.#rval(e.b);
    const at = T.decay(a.type), bt = T.decay(b.type);
    const op = e.op;

    if (op === '&&') return { js: `((${this.#truth(e.a)}&&${this.#truth(e.b)})?1:0)`, type: T.INT };
    if (op === '||') return { js: `((${this.#truth(e.a)}||${this.#truth(e.b)})?1:0)`, type: T.INT };

    // Pointer arithmetic scales by the pointee, and p - q divides by it.
    if (at.k === 'ptr' && T.isInteger(bt) && (op === '+' || op === '-')) {
      const s = at.to.size ?? 1;
      return { js: `((${a.js})${op}Math.imul(${b.js}|0,${s})|0)`, type: at };
    }
    if (bt.k === 'ptr' && T.isInteger(at) && op === '+') {
      const s = bt.to.size ?? 1;
      return { js: `((${b.js})+Math.imul(${a.js}|0,${s})|0)`, type: bt };
    }
    if (at.k === 'ptr' && bt.k === 'ptr' && op === '-') {
      const s = at.to.size ?? 1;
      return { js: `((((${a.js})-(${b.js}))|0)/${s}|0)`, type: T.INT };
    }

    const CMP = { '==': '===', '!=': '!==', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
    if (op in CMP) {
      if (at.k === 'ptr' || bt.k === 'ptr') {
        return { js: `(((${a.js})>>>0)${CMP[op]}((${b.js})>>>0)?1:0)`, type: T.INT };
      }
      const c = T.usualArith(at, bt);
      const A = coerce(a.js, at, c), B = coerce(b.js, bt, c);
      if (T.isFloat(c)) return { js: `((${A})${CMP[op]}(${B})?1:0)`, type: T.INT };
      // Both sides are already masked to the same 64-bit signedness, so a plain BigInt comparison
      // is correct — `>>>0` would throw on a BigInt.
      if (is64(c)) return { js: `((${A})${CMP[op]}(${B})?1:0)`, type: T.INT };
      if (T.isUnsigned(c)) return { js: `(((${A})>>>0)${CMP[op]}((${B})>>>0)?1:0)`, type: T.INT };
      return { js: `((${A})${CMP[op]}(${B})?1:0)`, type: T.INT };
    }

    if (op === '<<' || op === '>>') {
      const t = T.promote(at);
      const A = coerce(a.js, at, t);
      if (is64(t)) {
        // The count is an ordinary integer and must be converted; the result is masked back to 64.
        const shb = `BigInt(${coerce(b.js, bt, T.INT)}&63)`;
        return { js: mask64(`((${A})${op === '<<' ? '<<' : '>>'}${shb})`, t), type: t };
      }
      const sh = `((${b.js})&31)`;
      if (op === '<<') return { js: `((${A})<<${sh})`, type: t };
      return { js: T.isUnsigned(t) ? `((${A})>>>${sh})` : `((${A})>>${sh})`, type: t };
    }

    const c = T.usualArith(at, bt);
    const A = coerce(a.js, at, c), B = coerce(b.js, bt, c);
    if (T.isFloat(c)) {
      const raw = `((${A})${op}(${B}))`;
      return { js: c.name === 'float' ? `Math.fround(${raw})` : raw, type: c };
    }
    if (is64(c)) return { js: bin64(op, A, B, c), type: c };
    const u = T.isUnsigned(c);
    switch (op) {
      case '+': return { js: `((${A})+(${B})|0)`, type: c };
      case '-': return { js: `((${A})-(${B})|0)`, type: c };
      case '*': return { js: `Math.imul(${A},${B})`, type: c };
      case '/': return { js: u ? `((((${A})>>>0)/((${B})>>>0))|0)` : `(((${A})/(${B}))|0)`, type: c };
      case '%': return { js: u ? `((((${A})>>>0)%((${B})>>>0))|0)` : `(((${A})%(${B}))|0)`, type: c };
      case '&': return { js: `((${A})&(${B}))`, type: c };
      case '|': return { js: `((${A})|(${B}))`, type: c };
      case '^': return { js: `((${A})^(${B}))`, type: c };
    }
    throw new EmitError(`binary '${op}'`);
  }

  #assign(e) {
    const l = this.#lval(e.lhs);
    if (l.bitfield) return this.#assignBitfield(l, e);
    const rhsType = l.type;

    if (e.op === '=') {
      if (T.isRecord(rhsType) || rhsType.k === 'array') {
        // Struct assignment is a byte copy; C allows it and game code uses it constantly.
        const r = this.#lval(e.rhs);
        return { js: `M.copy(${l.addr},${r.addr},${rhsType.size})`, type: rhsType };
      }
      const v = this.#rvalCoerced(e.rhs, rhsType);
      if (l.varJs) return { js: `(${l.varJs}=${v})`, type: rhsType };
      const t = this.newTmp();
      this.#declareTmp(t);
      return { js: `(${t}=${v},${storeExpr(l.addr, rhsType, t)},${t})`, type: rhsType };
    }

    // Compound assignment: read, operate in the promoted type, coerce back.
    const op = e.op.slice(0, -1);
    const cur = l.varJs ? { js: l.varJs, type: l.type } : { js: loadExpr(l.addr, l.type), type: l.type };
    const fake = { n: 'bin', op, a: { ...e.lhs, __pre: cur }, b: e.rhs, type: null };
    const combined = this.#binaryWith(cur, e.rhs, op);
    const v = coerce(combined.js, combined.type, rhsType);
    if (l.varJs) return { js: `(${l.varJs}=${v})`, type: rhsType };
    const t = this.newTmp();
    this.#declareTmp(t);
    // The address is evaluated once by hoisting it into a temp, which C requires.
    const at = this.newTmp();
    this.#declareTmp(at);
    const curAt = l.varJs ? cur.js : loadExpr(at, l.type);
    const combined2 = this.#binaryWith({ js: curAt, type: l.type }, e.rhs, op);
    return {
      js: `(${at}=${l.addr},${t}=${coerce(combined2.js, combined2.type, rhsType)},` +
        `${storeExpr(at, rhsType, t)},${t})`,
      type: rhsType,
    };
  }

  /** Like #binary but with the left side already evaluated. */
  #binaryWith(a, rhsNode, op) {
    const b = this.#rval(rhsNode);
    const at = T.decay(a.type), bt = T.decay(b.type);
    if (at.k === 'ptr' && T.isInteger(bt) && (op === '+' || op === '-')) {
      const s = at.to.size ?? 1;
      return { js: `((${a.js})${op}Math.imul(${b.js}|0,${s})|0)`, type: at };
    }
    if (op === '<<' || op === '>>') {
      const t = T.promote(at);
      const A = coerce(a.js, at, t);
      if (is64(t)) {
        const shb = `BigInt(${coerce(b.js, bt, T.INT)}&63)`;
        return { js: mask64(`((${A})${op}${shb})`, t), type: t };
      }
      const sh = `((${b.js})&31)`;
      return { js: op === '<<' ? `((${A})<<${sh})` : (T.isUnsigned(t) ? `((${A})>>>${sh})` : `((${A})>>${sh})`), type: t };
    }
    const c = T.usualArith(at, bt);
    const A = coerce(a.js, at, c), B = coerce(b.js, bt, c);
    if (T.isFloat(c)) {
      const raw = `((${A})${op}(${B}))`;
      return { js: c.name === 'float' ? `Math.fround(${raw})` : raw, type: c };
    }
    if (is64(c)) return { js: bin64(op, A, B, c), type: c };
    const u = T.isUnsigned(c);
    const table = {
      '+': `((${A})+(${B})|0)`, '-': `((${A})-(${B})|0)`, '*': `Math.imul(${A},${B})`,
      '/': u ? `((((${A})>>>0)/((${B})>>>0))|0)` : `(((${A})/(${B}))|0)`,
      '%': u ? `((((${A})>>>0)%((${B})>>>0))|0)` : `(((${A})%(${B}))|0)`,
      '&': `((${A})&(${B}))`, '|': `((${A})|(${B}))`, '^': `((${A})^(${B}))`,
    };
    if (!(op in table)) throw new EmitError(`compound operator '${op}='`);
    return { js: table[op], type: c };
  }

  #incdec(e) {
    const l = this.#lval(e.expr);
    if (l.bitfield) {
      // Read, adjust in the promoted type, store truncated, and yield the value that was STORED —
      // the same rule as a bitfield assignment, so `++m` on a `signed int m:11` wraps.
      const f = l.bitfield;
      const at = this.newTmp(); this.#declareTmp(at);
      const v = this.newTmp(); this.#declareTmp(v);
      const { unitOff, poke } = bitfieldPoke(f, at, v);
      const cur = this.#loadBitfield({ addr: l.addr, bitfield: f });
      const old = this.newTmp(); this.#declareTmp(old);
      const one = { n: 'num', value: 1n, type: T.INT };
      const nv = coerce(this.#binaryWith({ js: old, type: bitfieldPromoted(f) }, one,
        e.op === '++' ? '+' : '-').js, bitfieldPromoted(f), f.type);
      const readBack = this.#loadBitfield({ addr: l.addr, bitfield: f });
      return {
        js: `(${at}=(${l.addr}+${unitOff}|0),${old}=${cur},${v}=${nv},${poke},` +
          `${e.n === 'preinc' ? readBack : old})`,
        type: bitfieldPromoted(f),
      };
    }
    const one = { n: 'num', value: 1n, type: T.INT };
    const op = e.op === '++' ? '+' : '-';
    const cur = l.varJs ? { js: l.varJs, type: l.type } : null;

    if (l.varJs) {
      const nv = coerce(this.#binaryWith(cur, one, op).js, l.type, l.type);
      if (e.n === 'preinc') return { js: `(${l.varJs}=${nv})`, type: l.type };
      const t = this.newTmp(); this.#declareTmp(t);
      return { js: `(${t}=${l.varJs},${l.varJs}=${nv},${t})`, type: l.type };
    }
    const at = this.newTmp(); this.#declareTmp(at);
    const old = this.newTmp(); this.#declareTmp(old);
    const loaded = loadExpr(at, l.type);
    const nv = coerce(this.#binaryWith({ js: old, type: l.type }, one, op).js, l.type, l.type);
    if (e.n === 'preinc') {
      const nt = this.newTmp(); this.#declareTmp(nt);
      return { js: `(${at}=${l.addr},${old}=${loaded},${nt}=${nv},${storeExpr(at, l.type, nt)},${nt})`, type: l.type };
    }
    return { js: `(${at}=${l.addr},${old}=${loaded},${storeExpr(at, l.type, nv)},${old})`, type: l.type };
  }

  #declareTmp(name) {
    if (!this._tmps) this._tmps = new Set();
    // Initialised to 0, and reassigned before any use; a BigInt temp is written before it is read.
    if (!this._tmps.has(name)) { this._tmps.add(name); this.out.unshift(`var ${name}=0;`); }
  }

  #call(e) {
    // A direct call by name; anything else goes through the function table.
    if (e.fn.n === 'ident' && !this.locals.has(e.fn.name)) {
      const name = e.fn.name;
      const f = this.ctx.funcs.get(name);
      const rt = this.ctx.builtins.get(name);
      if (rt?.vaStart) {
        if (!this.variadic) throw new EmitError('va_start outside a variadic function');
        return { js: '_va', type: T.ptr(T.CHAR) };
      }
      if (rt) {
        const args = e.args.map((a, i) => this.#rvalForCall(a, rt.params?.[i]));
        // A variadic runtime function takes its extras as one JS array, which is enough for
        // printf-family calls and is all tier-0 promises.
        const impl = rt.impl ?? name;
        if (rt.variadic) {
          const fixed = args.slice(0, rt.params.length);
          const rest = args.slice(rt.params.length);
          return { js: `M.rt.${impl}(${[...fixed, `[${rest.join(',')}]`].join(',')})`, type: rt.ret };
        }
        return { js: `M.rt.${impl}(${args.join(',')})`, type: rt.ret };
      }
      if (f) {
        const ft = f.type;
        const args = this.#callArgs(e, ft);
        return { js: `F.${name}(${args.join(',')})`, type: ft?.ret ?? T.INT };
      }
      throw new EmitError(`call to undeclared function '${name}'`);
    }
    const p = this.#rval(e.fn);
    let ft = T.decay(p.type);
    if (ft.k === 'ptr' && ft.to.k === 'func') ft = ft.to;
    const args = this.#callArgs(e, ft);
    return { js: `M.icall(${p.js},[${args.join(',')}])`, type: ft?.ret ?? T.INT };
  }

  /**
   * The argument list for one call, including the hidden sret buffer when the callee returns a
   * struct. Both the buffer and every by-value struct argument are allocated in the CALLER's frame:
   * the callee's frame is gone by the time the result is read, and C promises the callee its own
   * copy of each argument.
   */
  #callArgs(e, ft) {
    const args = [];
    // A variadic callee receives ONLY its fixed parameters positionally; the tail travels in the
    // packed buffer. Passing both made the buffer land in the wrong JS parameter.
    const positional = ft?.variadic ? Math.min(ft.params.length, e.args.length) : e.args.length;
    for (let i = 0; i < positional; i++) {
      const want = ft?.params?.[i]?.type;
      const node = e.args[i];
      const asRecord = want && T.isRecord(want) ? want
        : (!want && node.type && T.isRecord(node.type) ? node.type : null);
      args.push(asRecord ? this.#structArg(node, asRecord) : this.#rvalForCall(node, want));
    }
    if (ft && T.isRecord(ft.ret)) {
      const off = this.slot(ft.ret.size, ft.ret.align);
      args.unshift(`(_fp+${off}|0)`);
    }
    if (ft?.variadic) args.push(this.#packVarargs(e, ft));
    return args;
  }

  /**
   * Pack the variadic tail of a call into a caller-owned buffer and return its address. Each value
   * takes a whole number of 4-byte slots after the DEFAULT ARGUMENT PROMOTIONS — a float is passed
   * as a double, anything narrower than int as an int — because that is what the callee's `va_arg`
   * will assume when it is handed a type to read.
   */
  #packVarargs(e, ft) {
    const fixed = ft.params.length;
    const tail = e.args.slice(fixed);
    const items = [];
    let total = 0;
    for (const node of tail) {
      // The TYPE comes from the parser's annotation, not from emitting the expression: calling
      // #rval here and again below would evaluate each argument twice, so `f(2, i++, i++)` would
      // increment four times.
      let t = T.decay(node.type ?? T.INT);
      if (T.isFloat(t) && t.name === 'float') t = T.DOUBLE;          // default promotion
      else if (T.isInteger(t) && T.rank(t) < 3) t = T.promote(t);
      const size = T.isRecord(t) ? t.size : (t.size ?? 4);
      items.push({ node, type: t, off: total });
      total += Math.ceil(size / 4) * 4;
    }
    if (!total) return '0';
    const base = this.slot(total, 8);
    const parts = [];
    for (const it of items) {
      const addr = `(_fp+${base + it.off}|0)`;
      if (T.isRecord(it.type)) {
        const src = this.#lval(it.node);
        parts.push(`M.copy(${addr},${src.addr},${it.type.size})`);
      } else {
        parts.push(storeExpr(addr, it.type, this.#rvalCoerced(it.node, it.type)));
      }
    }
    const t = this.newTmp(); this.#declareTmp(t);
    return `(${parts.join(',')},${t}=(_fp+${base}|0),${t})`;
  }

  /** Copy a struct argument into a caller-owned temporary and pass its address. */
  #structArg(node, type) {
    if (type.size == null) unsup('passing an incomplete struct by value');
    const off = this.slot(type.size, type.align);
    const src = this.#lval(node);
    const t = this.newTmp(); this.#declareTmp(t);
    return `(${t}=(_fp+${off}|0),M.copy(${t},${src.addr},${type.size}),${t})`;
  }

  #rvalForCall(node, want) {
    const v = this.#rval(node);
    const from = T.decay(v.type);
    if (!want) {
      // No prototype for this parameter: the default argument promotions apply.
      if (T.isFloat(from) && from.name === 'float') return `+(${v.js})`;
      if (T.isInteger(from) && T.rank(from) < 3) return coerce(v.js, from, T.INT);
      return v.js;
    }
    return coerce(v.js, from, T.decay(want));
  }

  #rvalCoerced(node, want) {
    const v = this.#rval(node);
    return coerce(v.js, T.decay(v.type), want);
  }

  // ------------------------------------------------------------- bitfields

  #loadBitfield(l) {
    const f = l.bitfield;
    const unitOff = (f.bitOffset >> 5) * 4;
    const shift = f.bitOffset & 31;
    if (shift + f.width > 32) unsup('a bitfield straddling a 32-bit unit');
    const raw = `D.getUint32((${l.addr}+${unitOff}|0),1)`;
    if (f.type.signed) return `((${raw})<<${32 - shift - f.width}>>${32 - f.width})`;
    return `(((${raw})>>>${shift})&${(2 ** f.width - 1) >>> 0})`;
  }

  #assignBitfield(l, e) {
    if (e.op !== '=') unsup('compound assignment to a bitfield');
    const f = l.bitfield;
    const v = this.newTmp(); this.#declareTmp(v);
    const at = this.newTmp(); this.#declareTmp(at);
    const rhs = this.#rvalCoerced(e.rhs, f.type);
    const { unitOff, poke } = bitfieldPoke(f, at, v);
    // The result is the field READ BACK, not `v`: assigning 1081 to a `signed int m:11` yields -967,
    // and `(l.m = j) == j` must therefore be false (gcc's 921016-1.c).
    const readBack = this.#loadBitfield({ addr: l.addr, bitfield: f });
    return {
      js: `(${at}=(${l.addr}+${unitOff}|0),${v}=${rhs},${poke},${readBack})`,
      type: bitfieldPromoted(f),
    };
  }

  /** Write a constant-position bitfield at a known address; used by brace initialisers. */
  #initBitfield(addrJs, f, valueJs) {
    const at = this.newTmp(); this.#declareTmp(at);
    const v = this.newTmp(); this.#declareTmp(v);
    const { unitOff, poke } = bitfieldPoke(f, at, v);
    this.out.push(`${at}=(${addrJs}+${unitOff}|0);${v}=${valueJs};${poke};`);
  }
}

// ---------------------------------------------------------------- helpers

const coerceTo = (v, t) => coerce(v.js, T.decay(v.type), t);

/** Write one bitfield straight into the image, for a file-scope initialiser. */
function writeStaticBitfield(mod, base, f, value) {
  const unitOff = (f.bitOffset >> 5) * 4;
  const shift = f.bitOffset & 31;
  if (shift + f.width > 32) unsup('a static bitfield straddling a 32-bit unit');
  const mask = (((2 ** f.width - 1) >>> 0) << shift) >>> 0;
  const at = base + unitOff;
  const cur = mod.dv.getUint32(at, true);
  mod.dv.setUint32(at, (((cur & ~mask) | ((value << shift) & mask)) >>> 0), true);
}

/** The type a bitfield read has after the integer promotions. */
function bitfieldPromoted(f) {
  if (f.type.k !== 'scalar') return T.INT;
  if (f.type.signed) return T.INT;
  return f.width < 32 ? T.INT : T.UINT;
}

/** The read-modify-write for one bitfield, shared by assignment and initialisation. */
function bitfieldPoke(f, atVar, valVar) {
  const unitOff = (f.bitOffset >> 5) * 4;
  const shift = f.bitOffset & 31;
  if (shift + f.width > 32) unsup('a bitfield straddling a 32-bit unit');
  const mask = (((2 ** f.width - 1) >>> 0) << shift) >>> 0;
  return {
    unitOff,
    poke: `D.setUint32(${atVar},((D.getUint32(${atVar},1)&${(~mask) >>> 0})|((${valVar}<<${shift})&${mask}))>>>0,1)`,
  };
}

function unifyCond(a, b) {
  const at = T.decay(a), bt = T.decay(b);
  if (at.k === 'ptr') return at;
  if (bt.k === 'ptr') return bt;
  if (T.isArith(at) && T.isArith(bt)) return T.usualArith(at, bt);
  return at;
}

/** Does this subtree contain a goto? */
function findGoto(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(findGoto);
  if (node.n === 'goto' || node.n === 'gotoexpr') return true;
  return Object.keys(node).some(k => k !== 'type' && k !== 'sym' && k !== 'loc' && findGoto(node[k]));
}

/** Every label a goto in this subtree targets. */
function collectGotoTargets(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) collectGotoTargets(x, out); return out; }
  if (node.n === 'goto') out.add(node.label);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'sym' || k === 'loc') continue;
    collectGotoTargets(node[k], out);
  }
  return out;
}

/** Walk a function body and collect every name that has `&` applied to it. */
export function collectAddressTaken(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectAddressTaken(x, out); return; }
  if (node.n === 'unary' && node.op === '&') {
    let e = node.expr;
    // `&a`, `&a.b`, `&a[i]` all pin `a` in memory.
    while (e && (e.n === 'member' || e.n === 'index')) e = e.base;
    if (e?.n === 'ident') out.add(e.name);
  }
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'sym' || k === 'loc') continue;
    collectAddressTaken(node[k], out);
  }
}

function evalConstNumber(e) {
  switch (e.n) {
    case 'num': return Number(BigInt.asIntN(64, e.value));
    case 'char': return Number(e.value);
    case 'float': return e.value;
    case 'unary':
      if (e.op === '-') return -evalConstNumber(e.expr);
      if (e.op === '+') return evalConstNumber(e.expr);
      if (e.op === '~') return ~evalConstNumber(e.expr);
      if (e.op === '!') return evalConstNumber(e.expr) === 0 ? 1 : 0;
      break;
    case 'cast': {
      // The cast's TYPE is the whole point: `(unsigned short) -4` is 65532, not -4. Dropping it made
      // `volatile unsigned long l2 = (unsigned short int) -4;` hold 0xFFFFFFFC (gcc's pr39240.c).
      const v = evalConstNumber(e.expr);
      return castConst(v, e.type);
    }
    case 'bin': {
      const a = evalConstNumber(e.a), b = evalConstNumber(e.b);
      // `1.0 / 32768.0` is NOT integer division. Folding it with `|0` made
      // `double d = 1024.0 - 1.0/32768.0;` equal 1024.0 exactly, which is what gcc's float-floor.c
      // catches. The node's own type decides, not the shape of the operands.
      const isFP = T.isFloat(e.type ?? T.INT) || T.isFloat(e.a.type ?? T.INT) || T.isFloat(e.b.type ?? T.INT);
      switch (e.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return isFP ? a / b : (a / b) | 0;
        case '%': return a % b;
        case '<<': return a << b; case '>>': return a >> b;
        case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
      }
      break;
    }
    case 'sizeoftype': return e.target.size;
    case 'sizeofexpr': return e.expr.type?.size ?? 0;
  }
  throw new EmitError('not a constant initialiser');
}

/** The 64-bit operators, in BigInt, each masked back to the type's width. */
function bin64(op, A, B, t) {
  const m = (x) => mask64(x, t);
  switch (op) {
    case '+': return m(`(${A})+(${B})`);
    case '-': return m(`(${A})-(${B})`);
    case '*': return m(`(${A})*(${B})`);
    // BigInt `/` truncates toward zero and `%` takes the dividend's sign — the same as C99.
    case '/': return m(`(${A})/(${B})`);
    case '%': return m(`(${A})%(${B})`);
    case '&': return m(`(${A})&(${B})`);
    case '|': return m(`(${A})|(${B})`);
    case '^': return m(`(${A})^(${B})`);
  }
  throw new EmitError(`64-bit operator '${op}'`);
}

/** Apply a cast's truncation to a folded constant, matching `coerce`'s run-time behaviour. */
function castConst(v, t) {
  if (!t) return v;
  if (T.isFloat(t)) return t.name === 'float' ? Math.fround(v) : v;
  if (t.k === 'ptr' || t.k === 'func' || t.k === 'enum') return v | 0;
  if (t.k !== 'scalar') return v;
  switch (t.name) {
    case '_Bool': return v !== 0 ? 1 : 0;
    case 'char': return T.CHAR.signed ? (v << 24 >> 24) : (v & 255);
    case 'signed char': return v << 24 >> 24;
    case 'unsigned char': return v & 255;
    case 'short': return v << 16 >> 16;
    case 'unsigned short': return v & 65535;
    case 'unsigned int': case 'unsigned long': return v >>> 0;
    default: return v | 0;
  }
}

function writeConst(mod, addr, type, v) {
  const a = accessor(type);
  if (!a) unsup(`a static ${T.typeName(type)}`);
  // The Big* setters demand a BigInt and the others demand a Number; neither converts.
  const val = a.set.startsWith('setBig') ? BigInt(v) : (typeof v === 'bigint' ? Number(v) : v);
  if (a.endian) mod.dv[a.set](addr, val, true); else mod.dv[a.set](addr, val);
}

// Literal decoding lives in src/util/charset.js — one place, because the parser (to size an
// array), the #if evaluator (for a character constant) and this emitter all need it, and three
// copies disagreed about wide literals.
export { isWideLiteral, literalBytes, literalUnits } from '../util/charset.js';
