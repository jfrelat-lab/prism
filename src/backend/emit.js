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
import { needsFlattening, flattenGotos } from './flatten.js';

/*
 * The frame epilogue, emitted as a MARKER and resolved once the function's final frame size is known.
 *
 * It used to be written inline with `this.frameSize` as it stood at that moment — but slots are
 * allocated as emission proceeds, so an early `return` followed by any later allocation restored the
 * stack pointer to the wrong place. W_GetLumpinfo returned inside its loop with the frame at 16
 * bytes and then grew to 20 for a varargs buffer, leaking 4 bytes per call.
 *
 * Silent, cumulative, and fatal at a distance: Quake's own R_RenderView checks that the stack has not
 * drifted more than 10000 bytes, and died after 1238 frames of leaking 8 bytes each. A program
 * without that check would simply have run out of stack.
 */
const FRAME_RESTORE = '\u0000FRAME_RESTORE\u0000';

/*
 * C identifiers that JavaScript reserves. A C program is entitled to a variable called `in`, `new` or
 * `class`, and Quake has one: the emitted module died with "Unexpected token 'in'".
 *
 * Locals are already safe because they go out as `_v_name`, but PARAMETERS and function names keep
 * their own names, which is worth preserving — readable emitted code is this project's primary
 * debugging lever. So only the collisions are renamed, with a `$`: legal in a JS identifier, and not
 * something a C identifier produces.
 *
 * C's own keywords are absent from the list: a C program cannot use `if`, `for`, `void`, `const`,
 * `switch`, `enum` or `static` as a name in the first place. What is left is the JavaScript-only half.
 */
const JS_RESERVED = new Set([
  'in', 'new', 'class', 'delete', 'this', 'null', 'true', 'false', 'typeof', 'instanceof',
  'var', 'let', 'with', 'throw', 'try', 'catch', 'finally', 'super', 'import', 'export',
  'function', 'yield', 'await', 'async', 'debugger', 'arguments', 'eval',
  'package', 'private', 'protected', 'public', 'interface', 'implements',
  'undefined', 'NaN', 'Infinity',
]);

export const jsIdent = (n) => (JS_RESERVED.has(n) ? n + '$' : n);

/*
 * A PARAMETER's JavaScript name, prefixed.
 *
 * Locals already are (`_v_status`); parameters were not, and a parameter named M, F or D shadowed
 * the three the emitted module runs on -- the memory, the function table and the DataView. Lua's
 * ldump.c writes `static void dumpBlock (DumpState *D, ...)`, so every memory access inside it
 * became a method call on a guest pointer: "D.getInt32 is not a function", from a function whose C
 * mentions nothing of the sort.
 *
 * Prefixing is the whole fix, and it is the same one locals already had. Renaming the module's own
 * three to something C cannot spell would work too, but it would touch every emitted access instead
 * of one declaration.
 */
export const paramIdent = (n) => `_p_${jsIdent(n)}`;

/*
 * An index into a pointer, narrowed to the pointer's width.
 *
 * `p + n` is legal C when n is a `long long`, and the index has to come down to 32 bits before it can
 * be scaled. Tier-0 keeps a 64-bit integer as a BigInt, so the usual `x|0` threw "Cannot mix BigInt
 * and other types" — loudly, which is the point of the BigInt choice, and it surfaced only when
 * SQLite indexed a buffer with an i64 length.
 */
function indexJs(v) {
  return is64(T.decay(v.type ?? T.INT)) ? `Number(BigInt.asIntN(32,${v.js}))` : `${v.js}|0`;
}


/** Enough of an expression to find it in the source. A node kind alone is not a search term. */
function describeExpr(e) {
  if (!e || typeof e !== 'object') return String(e);
  switch (e.n) {
    case 'ident': return `identifier '${e.name}'`;
    case 'call': return `a call to '${e.fn?.name ?? '?'}'`;
    case 'bin': return `${describeExpr(e.a)} ${e.op} ${describeExpr(e.b)}`;
    case 'unary': return `${e.op}${describeExpr(e.expr)}`;
    case 'cast': return `a cast of ${describeExpr(e.expr)}`;
    case 'member': return `${describeExpr(e.obj ?? e.base)}.${e.name ?? e.field}`;
    case 'index': return `${describeExpr(e.base)}[${describeExpr(e.index)}]`;
    case 'num': return String(e.value);
    case 'cond': return 'a ?: expression';
    default: return `'${e.n}'`;
  }
}

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
    this.nameSeq = new Map();       // how many times a name has been declared in this function
    this.frameSize = 0;
    this.frameAlign = 4;        // the strictest alignment any slot in this frame asked for
    this.tmp = 0;
    this.out = [];
    this.loopDepth = 0;
    /*
     * A NESTED function is emitted as a top-level one taking the enclosing frame as a hidden first
     * parameter -- the "static link" a C compiler would put in a register. `parent` is the emitter
     * that owns that frame, and is consulted for any name this function does not declare itself.
     */
    this.parent = ctx.parentEmitter ?? null;
    this.nested = new Map();        // name -> { jsName, decl }
    this.extra = [];                // the nested functions' own emitted text
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
    /*
     * A slot's alignment is only as good as the FRAME's. Offsets inside the frame are aligned here,
     * but `_fp` is wherever the stack pointer happened to be -- so `__attribute__((aligned))`, which
     * means the target's maximum and is 16 on i386, was landing on a 4-byte boundary. gcc's
     * nest-align-1.c checks the address itself, and it was a wrong answer rather than a refusal.
     */
    if (align > this.frameAlign) this.frameAlign = align;
    return off;
  }

  emit() {
    let d = this.decl;

    /*
     * A label below the top level means the state machine cannot see it, so lower the whole body to
     * labels and gotos first — see flatten.js. Only functions that need it pay: everything else keeps
     * its structured emission, which is both faster and readable.
     *
     * Quake needs this for nine functions, six of them in the span renderer, where a label sits
     * inside a `do` loop the gotos jump around.
     */
    if (needsFlattening(d.body)) {
      let sw = 0;
      const newTemp = (disc) => {
        // The discriminant is evaluated ONCE, into a real local, because the dispatch chain that
        // replaces the switch would otherwise re-evaluate it per comparison.
        const name = `_sw${sw++}$${d.name}`;
        return {
          decl: { n: 'decls', decls: [{ n: 'vardecl', name, type: T.INT, storage: null, init: { expr: disc } }] },
          ref: { n: 'ident', name, type: T.INT },
        };
      };
      d = { ...d, body: flattenGotos(d.body, { unsup, newTemp }) };
      this.decl = d;
    }
    // A struct RETURN uses the sret convention: the caller supplies the buffer, because the callee's
    // own frame is released before the value could be read out of it.
    this.sret = T.isRecord(d.type.ret);
    const params = d.type.params.map((p, i) => (p.name ? paramIdent(p.name) : `_unused${i}`));
    if (this.sret) params.unshift('_sret');
    /* The static link comes FIRST, before even the sret buffer: it is the frame, not an argument. */
    if (this.parent) params.unshift('_up');
    // A variadic function takes the caller-packed argument buffer as a hidden last parameter, which
    // is what `va_start` resolves to.
    this.variadic = !!d.type.variadic;
    if (this.variadic) params.push('_va');

    // Which locals escape? A scalar that is never `&`-taken can live in a JS var. Everything with
    // an address, and every aggregate, needs a slot. This single decision is the difference between
    // "a few times slower than native" and "tens of times".
    const escaped = new Set();
    collectAddressTaken(d.body, escaped);
    this.escaped = escaped;
    /*
     * A nested function reaches the enclosing frame through MEMORY and nothing else, so every name
     * it mentions has to be in a slot rather than a JS variable. Collected before the body is
     * walked, because the decision is made when each declaration is emitted.
     */
    for (const it of nestedDefs(d.body)) collectNestedRefs(it.body, escaped);

    const pre = [];
    for (const p of d.type.params) {
      if (!p.name) continue;
      if (T.isRecord(p.type)) {
        // The caller already made a fresh copy, so the callee may modify it in place — no second
        // copy is needed, and `&param` is simply that address.
        this.locals.set(p.name, { kind: 'aggparam', js: paramIdent(p.name), type: p.type });
        continue;
      }
      if (p.type.k === 'array') unsup('an array parameter by value');
      if (escaped.has(p.name)) {
        const off = this.slot(p.type.size, p.type.align);
        this.locals.set(p.name, { kind: 'slot', off, type: p.type });
        pre.push({ off, type: p.type, from: paramIdent(p.name) });
      } else {
        this.locals.set(p.name, { kind: 'var', js: paramIdent(p.name), type: p.type });
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
      if (this.hasSetjmp) this.out.push('var _sjv=0;');
      this.out.push(this.hasSetjmp ? '_top: for(;;){ try{ switch(_pc){' : '_top: for(;;){ switch(_pc){');
      for (const [k, seg] of this.labels.segments.entries()) {
        // The registration runs at the END of the previous segment, which is where a fall-through
        // arrives from — so a setjmp is recorded before its own case is ever entered.
        if (seg.pre) {
          const env = this.#rvalForCall(seg.pre.args[0], T.ptr(T.INT));
          this.out.push(`_sjv=0; M.rt.__prism_setjmp(${env},_fp,${k});`);
        }
        this.out.push(`case ${k}:`);
        for (const item of seg.items) this.#item(item, escaped);
      }
      if (this.hasSetjmp) {
        // A longjmp aimed at THIS frame resumes; anything else keeps unwinding. The stack pointer is
        // put back to this frame's base, because everything the abandoned path pushed is gone.
        this.out.push('} }catch(_e){ if(_e&&_e.__prismJmp===_fp){ _sjv=_e.val; _pc=_e.pc; M.sp=_fp; continue _top; } throw _e; } break _top; }');
      } else {
        this.out.push('} break _top; }');
      }
    } else {
      this.#block(d.body, escaped);
    }

    const body = [];
    // Aligning DOWN is always safe: it only moves the frame further from the stack pointer.
    body.push(this.frameAlign > 4
      ? `var _fp=(M.sp-${this.frameSize})&${~(this.frameAlign - 1)}|0;`
      : `var _fp=M.sp-${this.frameSize}|0;`);
    if (this.frameSize) body.push(`M.sp=_fp;`);
    for (const p of pre) body.push('  ' + storeExpr(`(_fp+${p.off}|0)`, p.type, coerce(p.from, p.type, p.type)) + ';');
    body.push(...this.out.map(l => '  ' + l));
    body.push('  ' + FRAME_RESTORE);
    body.push(`  return ${d.type.ret.k === 'void' ? '' : (is64(d.type.ret) ? '0n' : '0')};`);

    // Now the frame's final size is known, so every epilogue marker becomes the one right value.
    // With no frame at all the restore is a no-op assignment and is dropped rather than emitted.
    const restore = this.frameSize ? `M.sp=_fp+${this.frameSize}|0;` : '';
    const text = body.join('\n').split(FRAME_RESTORE).join(restore);
    const self = `function ${jsIdent(d.name)}(${params.join(',')}){\n${text}\n}`;

    /*
     * The nested functions, now that every slot offset this frame will ever hand out is settled.
     * They are siblings in the emitted JavaScript, not closures: a closure would capture the JS
     * variables, and what a nested C function needs is the FRAME.
     */
    for (const { jsName, decl, scope } of this.nested.values()) {
      if (this.parent) unsup('a nested function inside a nested function');
      const child = new FunctionEmitter(this.mod, { ...decl, name: jsName },
        { ...this.ctx, parentEmitter: this, parentScope: scope });
      this.extra.push(child.emit());
      for (const x of child.extra) this.extra.push(x);
    }
    return this.extra.length ? [self, ...this.extra].join('\n') : self;
  }

  /**
   * Split a function body at its top-level labels. Returns null when the function has no labels, and
   * throws when a label sits inside a nested block — that case needs control-flow flattening.
   */
  #planLabels(body) {
    // A `label` node wraps the statement that follows it, so flatten it back into a marker plus
    // that statement before splitting.
    //
    // A statement containing a `setjmp` call also becomes a boundary: longjmp must resume just after
    // the call, and a numbered dispatch point is exactly what the goto machinery already provides.
    // The call itself is lifted out and replaced by `_sjv`, so `if (setjmp(e)) return;` becomes
    // "register, then fall into a case whose first act is to test _sjv".
    const flat = [];
    const walk = (items) => {
      for (const it of items) {
        if (it.n === 'label') { flat.push({ mark: it.name }); walk([it.body]); continue; }
        const sj = findSetjmpCall(it, this.ctx.builtins);
        if (sj) flat.push({ sj });
        flat.push(it);
      }
    };
    walk(body.items);
    const names = flat.filter(x => x.mark).map(x => x.mark);
    this.hasSetjmp = flat.some(x => x.sj);
    if (!names.length && !this.hasSetjmp) {
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

    const segments = [{ pre: null, items: [] }];
    const index = new Map();
    for (const x of flat) {
      if (x.mark) { index.set(x.mark, segments.length); segments.push({ pre: null, items: [] }); continue; }
      if (x.sj) { segments.push({ pre: x.sj, items: [] }); continue; }
      segments[segments.length - 1].items.push(x);
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
      case 'func': {
        /*
         * A GNU nested function. It becomes a top-level JS function whose first parameter is this
         * frame, and every reference it makes to an enclosing local goes through that -- which is
         * why those locals were forced into slots before the body was walked.
         *
         * Emitted AFTER this function's body, because the slot offsets it will refer to are only
         * final once every declaration has been seen.
         */
        if (!item.body) return;
        const jsName = `${this.decl.name}$${item.name}`;
        /*
         * The visible locals are captured HERE, at the point of declaration, because that is C's
         * scope and not the one that will exist later: a nested function declared inside a block is
         * emitted after the whole body, by which time #scoped has unwound that block and the names
         * it could see are gone from the map.
         */
        this.nested.set(item.name, { jsName, decl: item, scope: new Map(this.locals) });
        return;
      }
      default: return this.#stmt(item, escaped);
    }
  }

  #localDecl(d, escaped) {
    /*
     * A FUNCTION declared at block scope declares the external function — it never creates an object,
     * and it needs no `extern` keyword to do so, because a function declaration is extern by default.
     * Requiring the keyword turned Doom's
     *
     *     void V_MarkRect(int, int, int, int);      // inside wipe_ScreenWipe's body
     *
     * into a local variable holding zero, and the next line called through it. The symptom was
     * "call through a non-function pointer 0x0" inside the melt effect, which pointed at the dispatch
     * table three lines below — the table was perfectly correct.
     *
     * Declaring nothing here is the fix: the name then resolves through the ordinary function lookup.
     */
    if (d.type.k === 'func') return;

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
      // A static local is a global with a private name; its address must survive the call. The name
      // has to be unique within the FUNCTION, not just the block: two `static int i;` in sibling
      // blocks are two objects, and one symbol for both would silently share their storage.
      const sym = this.mod.defineGlobal(`${this.decl.name}.${this.#uniq(d.name)}`, d.type);
      this.locals.set(d.name, { kind: 'global', addr: sym.addr, type: d.type });
      if (d.init) this.initStatic(sym.addr, d.type, d.init);
      return;
    }
    checkWide(d.type);
    /*
     * A VARIABLE-LENGTH ARRAY: the extent is not known until the declaration runs, so the storage
     * cannot be a frame slot. It is alloca'd, which puts it on the same shadow stack the frame is on
     * and therefore releases it when the function returns -- which is exactly a VLA's lifetime.
     *
     * The local is then recorded as an ADDRESS IN A VARIABLE, which is the shape a by-value struct
     * parameter already uses, so indexing, decay and `&x` all work without another case.
     *
     * ONLY THE OUTERMOST extent may vary. `int a[n][m]` needs a row stride that is itself a runtime
     * value, and every index expression would have to carry it; that is a different feature and it
     * is refused rather than half-built.
     */
    if (d.type.k === 'array' && d.type.vla) {
      if (d.type.of.size == null || (d.type.of.k === 'array' && d.type.of.vla)) {
        unsup('a variable-length array of variable-length arrays');
      }
      if (d.init) unsup('an initialiser on a variable-length array');
      const count = this.#rval(d.type.vla);
      const js = `_vla${this.tmp++}`;
      /*
       * Re-executing the declaration ends the PREVIOUS object's lifetime -- that is what a loop or
       * a backward `goto` does -- so the previous instance is popped, but only when it is still the
       * topmost thing on the shadow stack. Then nothing else can be living below it, and the pop
       * cannot free storage some other declaration is still using.
       *
       * Without it a VLA in a `goto` loop allocates a million times and overflows the shadow stack
       * (gcc's 20040811-1.c). The two variables are function-scoped, so a recursive call gets its
       * own pair and sees no previous instance of its own.
       */
      this.out.unshift(`var ${js}_a=0,${js}_e=0;`);
      this.out.push(`if(${js}_a===M.sp)M.sp=${js}_e;`);
      this.out.push(`${js}_e=M.sp;`);
      this.out.push(`var ${js}=${js}_a=M.rt.alloca(Math.imul((${count.js})|0,${d.type.of.size})|0);`);
      this.locals.set(d.name, { kind: 'aggparam', js, type: d.type });
      return;
    }
    const isAggregate = d.type.k === 'array' || T.isRecord(d.type);
    if (isAggregate || escaped.has(d.name)) {
      if (d.type.size == null) unsup('a local of incomplete type');
      const off = this.slot(d.type.size, d.type.align);
      this.locals.set(d.name, { kind: 'slot', off, type: d.type });
      if (d.init) this.#initDynamic(`(_fp+${off}|0)`, d.type, d.init);
      return;
    }
    /*
     * A JS `var` is FUNCTION-scoped, so two C locals of the same name in different blocks cannot
     * share one. `$` is the separator because no C identifier can contain it.
     */
    const js = `_v_${this.#uniq(d.name)}`;
    this.locals.set(d.name, { kind: 'var', js, type: d.type });
    const init = d.init ? this.#rvalCoerced(d.init.expr, d.type) : (is64(d.type) ? '0n' : '0');
    this.out.push(`var ${js}=${init};`);
  }

  /**
   * A name unique within this function: `w`, then `w$1`, `w$2`.
   *
   * C lets a block redeclare a name it shadows, and the emitter's `locals` map and JS variable names
   * are both flat over the function. PuTTY's terminal.c has a `char buf[2]` inside a block of a
   * function whose outer `buf` is a struct, and every use of the outer one after that point resolved
   * to the inner type.
   */
  #uniq(name) {
    const n = this.nameSeq.get(name) ?? 0;
    this.nameSeq.set(name, n + 1);
    return n ? `${name}$${n}` : name;
  }

  /**
   * Run `fn` with a nested declaration scope: whatever it declares is forgotten on the way out, and
   * whatever it shadowed comes back. Costs one Map copy per block, which is compile time and small
   * beside the source this emitter writes.
   */
  #scoped(fn) {
    const outer = this.locals;
    this.locals = new Map(outer);
    try { fn(); } finally { this.locals = outer; }
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
        // An AGGREGATE element is a copy, not a store: `char name[23][8] = {"e2m1", ...}` gives each
        // row a string literal, and storeExpr has no accessor for a char[8]. Doom's D_DoomMain has
        // exactly that table, and it is the function that starts the game.
        else if (type.of.k === 'array' || T.isRecord(type.of)) this.#initDynamic(off, type.of, it.value);
        else this.out.push(storeExpr(off, type.of, this.#rvalCoerced(it.value.expr, type.of)) + ';');
        idx++;
      }
      return;
    }
    if (T.isRecord(type)) {
      // Bitfields ARE initialisable members and must not be filtered out: skipping them left
      // `struct { signed s:3; unsigned u:3; } x = {-1,-1}` completely unwritten.
      /*
       * The members an initialiser list walks, one per OFFSET.
       *
       * An anonymous union is flattened into its parent's field list by the parser, which is what
       * makes `v.c` resolve without a path -- but it also loses the grouping, and positional
       * initialisation needs it:
       *
       *     struct { int a, b; union { int c, d; }; struct S1 s; } v = {1, 2, 3, {4, 5}};
       *
       * Here `c` and `d` share an offset and between them take ONE item; the braced pair belongs to
       * `s`. Without the grouping the pair went to `d`, which overwrote `c` -- a silently wrong
       * object where the previous code had at least refused. Two members at one offset inside a
       * struct can only have come from a union.
       */
      /*
       * Two fields of a STRUCT at one offset can only have come from an anonymous union, which the
       * parser folds into the parent's field list -- so the second is dropped rather than given the
       * next item.
       *
       * BITFIELDS ARE THE EXCEPTION AND THEY ARE NOT RARE. `struct { unsigned a:1, b:2, c:3; }`
       * packs all three into one storage unit, so all three report offset 0, and deduplicating by
       * offset alone silently dropped every bitfield after the first: `{1, 2, 3}` initialised to
       * 1, 0, 0. Two of gcc's torture programs are exactly that (bf-sign-1.c, 20000113-1.c) and it
       * is a WRONG ANSWER rather than a refusal, which is the worst kind.
       */
      const seen = new Set();
      const named = type.fields.filter((f) => {
        if (!f.name || f.width === 0) return false;
        if (type.k === 'struct' && f.bits === undefined) {
          if (seen.has(f.offset)) return false;
          seen.add(f.offset);
        }
        return true;
      });
      let k = 0;
      for (const it of init.items) {
        let f = named[k];
        if (it.designators?.[0]?.field) f = findField(type, it.designators[0].field);
        if (!f) break;
        const t = it.designators && it.designators.length > 1
          ? descendDesignators(f, it.designators.slice(1))
          : { off: f.offset, type: f.type, field: f };
        // An object with automatic storage has no room past its own size, so a flexible array
        // member cannot be filled in one -- gcc rejects it too.
        if (t.field.flexible) unsup('initialising a flexible array member in a local');
        if (t.field.bits !== undefined) {
          this.#initBitfield(addr, { ...t.field, offset: t.off }, this.#rvalCoerced(it.value.expr, t.type));
        } else {
          const off = `(${addr}+${t.off}|0)`;
          if (it.value.n === 'initlist') this.#initList(off, t.type, it.value);
          else this.out.push(storeExpr(off, t.type, this.#rvalCoerced(it.value.expr, t.type)) + ';');
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

  /**
   * Run the ordinary initialiser walk, but collect its statements instead of emitting them.
   *
   * This reuses every case #initDynamic already handles -- designators, brace elision, bitfields,
   * nested aggregates -- rather than growing a second, thinner implementation that would drift from
   * it. What it cannot reuse is a statement that is not a single expression: a loop or a block does
   * not fit inside a comma. That is refused BY NAME rather than hoisted, because hoisting would
   * silently move when the initialisers run.
   */
  #captureInit(at, type, init) {
    const saved = this.out;
    this.out = [];
    let captured;
    try {
      this.#initDynamic(at, type, init);
      captured = this.out;
    } finally { this.out = saved; }
    const steps = [];
    for (const line of captured) {
      const t = String(line).trim();
      if (!t) continue;
      /*
       * A temporary DECLARES itself at the top of whatever buffer was current when it was asked
       * for, and here that buffer is this capture -- so `var _t0=0;` would land inside the comma
       * expression, where JavaScript does not allow a declaration. It belongs to the function, so
       * it is put back at the top of the function, which is where #declareTmp meant to put it.
       */
      if (/^var \w+=0;$/.test(t)) { this.out.unshift(t); continue; }
      if (t.includes('\n') || /^(if|for|while|do|switch|\{)/.test(t) || t.endsWith('{')) {
        throw new EmitError('a compound literal whose initialiser needs a statement, not an expression');
      }
      steps.push(...topLevelStatements(t));
    }
    return steps;
  }

  /** Public: the driver uses this for file-scope initialisers too. */
  initStatic(addr, type, init) {
    // Static initialisers are written into the image at link time where they are constant, and
    // otherwise deferred to a start-up thunk. Tier-0 only handles the constant case.
    if (init.n === 'init') {
      if (this.#staticScalar(addr, type, init.expr)) return;
    }
    if (init.n === 'initlist') { this.#staticList(addr, type, init); return; }
    unsup(`a non-constant static initialiser (${describeExpr(init.expr ?? init)}) [type ${T.typeName(type)}]`);
  }

  /** One constant scalar, pointer or string into the image. Returns false if not constant. */
  #staticScalar(addr, type, expr) {
    // `(unsigned char *)"..."` is still a string literal. Peeling casts first costs nothing and is
    // what a program writes when it stores a literal into a typed pointer.
    while (expr.n === 'cast' && expr.expr?.n === 'str') expr = expr.expr;
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
        /*
         * The address of a LIBRARY function. PRISM's builtins are JavaScript in M.rt and have no
         * address of their own, but a program is entitled to take one: SQLite's unix layer builds a
         * table of syscall pointers — `{ "access", (sqlite3_syscall_ptr)access, 0 }` — so it can
         * swap them out under test.
         *
         * Giving the builtin a function-table slot is all it takes; an indirect call then finds the
         * runtime implementation the same way it finds a compiled one. Recorded here and bound after
         * emission, when M.rt exists.
         */
        const b = this.ctx.builtins?.get(e.name);
        if (b) {
          const fn = this.mod.defineFunc(e.name, null);
          (this.ctx.builtinRefs ??= new Set()).add(e.name);
          return fn.addr;
        }
        return null;
      }
      /*
       * An indexed or selected ARRAY decays to its own address, and that is a constant when the
       * index is. Doom writes `cheat_powerup_seq[0]` — a row of a 2-D array — in a static
       * initialiser, which is ordinary C and was refused only because this case was missing.
       */
      case 'index': case 'member': {
        const t = e.type;
        if (t && (t.k === 'array' || t.k === 'func')) return this.#lvalAddrConst(e);
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
        /*
         * Through a POINTER, which is constant whenever the pointer is -- and that is the offsetof
         * idiom, written by hand because C89 had no offsetof worth using:
         *
         *     #define offset(c, m) (((size_t)&((c *)8)->m) - 8)      // OpenDUNE, saveload.h:29
         *
         * The base is 8 rather than 0 to keep a null-dereference warning quiet; the subtraction
         * takes it back out. Refusing this refused every save/load table in the program.
         */
        if (e.arrow) {
          let base = this.#addrConst(e.base);
          if (base === null) { try { base = evalConstNumber(e.base); } catch { return null; } }
          const pt = T.decay(e.base.type ?? T.INT);
          const rec = pt.k === 'ptr' ? pt.to : null;
          if (!rec || !T.isRecord(rec)) return null;
          const f = findField(rec, e.field);
          return f && f.bits === undefined ? base + f.offset : null;
        }
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
        /*
         * The element size, and it cannot always come from the expression's own type: nothing
         * annotates an `ident` node inside a file-scope initialiser, so `&S_sfx[69]` -- Heretic's
         * sound table pointing at its own entries -- arrived here with no type and was refused.
         * The declaration knows, so ask it.
         */
        let bt = T.decay(e.base.type ?? T.INT);
        if (bt.k !== 'ptr' && e.base.n === 'ident') {
          const g = this.ctx.globals?.get(e.base.name) ?? this.locals?.get(e.base.name);
          if (g?.type) bt = T.decay(g.type);
        }
        if (bt.k !== 'ptr') return null;
        let n;
        try { n = evalConstNumber(e.index); } catch { return null; }
        return base + n * (bt.to.size ?? 1);
      }
      case 'str': return this.#stringAddr(e);
    }
    return null;
  }

  /**
   * A file-scope brace initialiser, written straight into the image.
   *
   * Members are matched one-to-one against items, EXCEPT that an aggregate member handed a
   * non-braced item consumes as many following items as it needs. That is brace elision (C89
   * 6.7.8p17), and it is how most tables of structs are actually written:
   *
   *     struct { mobjtype_t type; int speed[2]; } MonsterMissileInfo[] = {
   *         { MT_IMPBALL, 10, 20 },        // speed[] takes the 10 and the 20, with no braces
   *
   * It is grafted onto the one-to-one walk rather than replacing it. Rewriting this as a pure stream
   * looked cleaner and broke three things the one-to-one version had right -- designators that go
   * backwards, flattened anonymous unions, and array designators with holes -- so the elision is
   * confined to the one branch that needs it.
   */
  #staticList(addr, type, init) {
    /*
     * `{ "ARTIBOX" }` -- a string literal in braces, initialising a whole character array.
     *
     * The braces belong to the ARRAY, not to its first element, so the string fills the object the
     * way it would without them. Heretic's status bar is a table of these:
     *
     *     char patcharti[][10] = { {"ARTIBOX"}, {"ARTIINVU"}, ... };
     *
     * Read element by element instead, the string decayed to its ADDRESS and the low byte of that
     * address landed in patcharti[i][0] -- so the game asked its WAD for a lump called "K" and died.
     * The unbraced form was already handled in #elidable; this is the same rule one level in.
     */
    if (type.k === 'array' && type.of.k === 'scalar' && (type.of.size === 1 || type.of.size === 4)
        && init.items.length === 1 && !init.items[0].designators) {
      let e = init.items[0].value?.expr;
      while (e && e.n === 'cast') e = e.expr;
      if (e && e.n === 'str') { this.#staticScalar(addr, type, e); return; }
    }
    if (type.k === 'array') {
      let idx = 0;
      for (let i = 0; i < init.items.length; i++) {
        const it = init.items[i];
        if (it.designators) idx = it.designators[0].index ?? idx;
        if (it.value.n === 'initlist') {
          this.#staticList(addr + idx * type.of.size, type.of, it.value);
        } else if (this.#elidable(type.of, it)) {
          i = this.#staticElided(addr + idx * type.of.size, type.of, init.items, i) - 1;
        } else if (!this.#staticScalar(addr + idx * type.of.size, type.of, it.value.expr)) {
          unsup(`a non-constant static initialiser (${describeExpr(it.value.expr)}) ` +
            `into element ${idx} of type ${T.typeName(type.of)}`);
        }
        idx++;
      }
      return;
    }
    if (T.isRecord(type)) {
      // Bitfields are initialisable here too. The dynamic path was fixed first and this one was
      // not, so `struct s x = { -123, -456 };` at file scope still wrote nothing (gcc's bitfld-4.c).
      const named = type.fields.filter(f => f.width !== 0
        // An ANONYMOUS struct or union member is initialised positionally like any other; it just
        // has no name to be designated by. Dropping it gave its item to the NEXT member and left the
        // union unwritten (c-testsuite 00050).
        && (f.name || (f.bits === undefined && T.isRecord(f.type))));
      let k = 0;
      for (let i = 0; i < init.items.length; i++) {
        const it = init.items[i];
        let f = named[k];
        if (it.designators?.[0]?.field) f = findField(type, it.designators[0].field);
        if (!f) break;
        const t = it.designators && it.designators.length > 1
          ? descendDesignators(f, it.designators.slice(1))
          : { off: f.offset, type: f.type, field: f };
        /*
         * A FLEXIBLE array member writes past the struct's nominal size, which is exactly what the
         * extension is for. It has no length of its own, so it is given the one its initialiser
         * implies -- and the object was allocated that much larger, by flexibleExtra(), before any
         * of this ran.
         */
        const ft = t.field.flexible ? flexibleArrayType(t.type, it.value) : t.type;
        if (t.field.bits !== undefined) {
          let v;
          try { v = evalConstNumber(it.value.expr); } catch { unsup('a non-constant bitfield initialiser'); }
          writeStaticBitfield(this.mod, addr, { ...t.field, offset: t.off }, v);
        } else if (it.value.n === 'initlist') {
          this.#staticList(addr + t.off, ft, it.value);
        } else if (this.#elidable(ft, it)) {
          i = this.#staticElided(addr + t.off, ft, init.items, i) - 1;
        } else if (!this.#staticScalar(addr + t.off, ft, it.value.expr)) {
          unsup(`a non-constant static initialiser (${describeExpr(it.value.expr)}) ` +
            `into field '${t.field.name}' of type ${T.typeName(t.type)}`);
        }
        k = named.indexOf(f) + 1;
      }
      return;
    }
    if (init.items.length) this.#staticScalar(addr, type, init.items[0].value.expr);
  }

  /**
   * Would this member take its initialiser from the enclosing list, with no braces of its own?
   *
   * Only for an aggregate given a bare expression — and NOT for a character array given a string
   * literal, which is a complete initialiser for the whole array rather than one element of it:
   * `{ "-phopow", &S_sfx[9], 32 }` fills `char name[8]` from the string and moves on.
   */
  #elidable(type, it) {
    if (type.k !== 'array' && !T.isRecord(type)) return false;
    if (it.designators) return false;
    /*
     * REFUSE a struct that contains a flattened anonymous union.
     *
     * The parser folds an anonymous union's members into the parent's field list, which is what
     * makes `v.c` resolve without a path -- and it destroys the grouping that positional
     * initialisation needs: `{1, 2, 3, {4, 5}}` must give the 3 to the union and the pair to the
     * next member, but a flat list of a, b, c, d, s gives the pair to `d` and overwrites `c`.
     *
     * Two named fields at one offset inside a struct can only have come from a union. Refusing keeps
     * the failure LOUD, which is the whole point: before elision existed this shape was refused, and
     * making it compile-but-wrong would have been a strictly worse outcome.
     */
    if (type.k === 'struct') {
      const at = new Set();
      for (const f of type.fields) {
        if (!f.name || f.width === 0) continue;
        if (at.has(f.offset)) return false;
        at.add(f.offset);
      }
    }
    let e = it.value.expr;
    while (e && e.n === 'cast') e = e.expr;
    if (!e) return false;
    if (e.n === 'str' && type.k === 'array' && type.of.k === 'scalar'
        && (type.of.size === 1 || type.of.size === 4)) return false;
    return true;
  }

  /**
   * Fill one elided aggregate from `items` starting at `i`, and return the index of the first item
   * it did not take. Recurses, because elision nests: a struct of arrays takes scalars all the way
   * down.
   */
  #staticElided(addr, type, items, i) {
    if (type.k === 'array') {
      const n = type.n ?? 0;
      for (let idx = 0; idx < n && i < items.length; idx++) {
        const it = items[i];
        if (it.designators) return i;                 // a designator belongs to the outer object
        if (it.value.n === 'initlist') { this.#staticList(addr + idx * type.of.size, type.of, it.value); i++; }
        else if (this.#elidable(type.of, it)) i = this.#staticElided(addr + idx * type.of.size, type.of, items, i);
        else if (this.#staticScalar(addr + idx * type.of.size, type.of, it.value.expr)) i++;
        else unsup(`a non-constant static initialiser (${describeExpr(it.value.expr)}) ` +
          `into element ${idx} of type ${T.typeName(type.of)}`);
      }
      return i;
    }
    // A union takes exactly one item, into its first member.
    const named = type.fields.filter(f => f.width !== 0
        // An ANONYMOUS struct or union member is initialised positionally like any other; it just
        // has no name to be designated by. Dropping it gave its item to the NEXT member and left the
        // union unwritten (c-testsuite 00050).
        && (f.name || (f.bits === undefined && T.isRecord(f.type))));
    const upto = type.k === 'union' ? Math.min(1, named.length) : named.length;
    for (let k = 0; k < upto && i < items.length; k++) {
      const it = items[i];
      if (it.designators) return i;
      const f = named[k];
      const ft = f.flexible ? flexibleArrayType(f.type, it.value) : f.type;
      if (f.bits !== undefined) {
        let v;
        try { v = evalConstNumber(it.value.expr); } catch { unsup('a non-constant bitfield initialiser'); }
        writeStaticBitfield(this.mod, addr, f, v);
        i++;
      } else if (it.value.n === 'initlist') { this.#staticList(addr + f.offset, ft, it.value); i++; }
      else if (this.#elidable(ft, it)) i = this.#staticElided(addr + f.offset, ft, items, i);
      else if (this.#staticScalar(addr + f.offset, ft, it.value.expr)) i++;
      else unsup(`a non-constant static initialiser (${describeExpr(it.value.expr)}) ` +
        `into field '${f.name}' of type ${T.typeName(f.type)}`);
    }
    return i;
  }

  #stmt(s, escaped) {
    switch (s.n) {
      case 'empty': return;
      case 'block': {
        /*
         * A block that declares a VLA gives its storage back when it ENDS -- C's rule, and the one
         * that keeps two sibling VLA blocks inside a `goto` loop from allocating for ever (gcc's
         * pr43220.c). Only the fall-through exit restores; a `break` or `goto` out of the block
         * leaves the storage until the function returns, which leaks but never frees too early.
         */
        const vla = s.items.some(it => it.n === 'vardecl' && it.type?.vla)
          || s.items.some(it => it.n === 'decls' && it.decls?.some(d => d.type?.vla));
        const mark = vla ? `_bsp${this.tmp++}` : null;
        this.out.push(mark ? `{var ${mark}=M.sp;` : '{');
        this.#scoped(() => this.#block(s, escaped));
        this.out.push(mark ? `M.sp=${mark};}` : '}');
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
        if (this.ctx.safepoints) this.out.push(this.#safepoint());
        this.out.push('}');
        return;
      }
      case 'do': {
        this.out.push('do{');
        this.loopDepth++; this.#stmt(s.body, escaped); this.loopDepth--;
        if (this.ctx.safepoints) this.out.push(this.#safepoint());
        this.out.push(`}while(${this.#truth(s.cond)});`);
        return;
      }
      case 'for': {
        // The init clause may declare, so it is emitted BEFORE the loop and the JS `for` gets an
        // empty init. `for (int i = ...)` opens a scope of its own, which is why the whole statement
        // is wrapped: the `i` it declares must not outlive the loop.
        this.#scoped(() => {
          if (s.init) this.#item(s.init.n === 'decls' ? s.init : s.init, escaped);
          const cond = s.cond ? this.#truth(s.cond) : 'true';
          const step = s.step ? this.#rval(s.step).js : '';
          this.out.push(`for(;${cond};${step}){`);
          this.loopDepth++; this.#stmt(s.body, escaped); this.loopDepth--;
          if (this.ctx.safepoints) this.out.push(this.#safepoint());
          this.out.push('}');
        });
        return;
      }
      case 'switch': {
        const d = this.#rval(s.disc);
        this.out.push(`switch(${d.js}|0){`);
        // The braces of the body are dropped on purpose: `switch(x){{case 0:...}}` is a syntax
        // error in JavaScript, where a switch's cases must be direct children.
        if (s.body.n === 'block') this.#scoped(() => this.#block(s.body, escaped));
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
          this.out.push(FRAME_RESTORE);
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
          this.out.push(FRAME_RESTORE);
          this.out.push('return _sret;');
          return;
        }
        const v = this.#rvalCoerced(s.expr, ret);
        const t = this.newTmp(); this.#declareTmp(t);
        this.out.push(`${t}=${v};`);
        this.out.push(FRAME_RESTORE);
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
        const outputs = (s.outputs ?? []).filter(o => o.expr);
        const inputs = (s.inputs ?? []).filter(o => o.expr);
        if (text === '') {
          /*
           * An empty template emits no instructions, so what it does is entirely in its CONSTRAINTS.
           *
           * A digit constraint on an input names the output it shares a register with, and with no
           * instructions in between the output simply ends up holding the input: `asm ("" : "=r"(i)
           * : "0"(x))` copies x into i. gcc's own 20030222-1.c and 990130-1.c are that and nothing
           * else -- they exist to stop the optimiser, and the value carried through the tie is the
           * whole observable effect.
           *
           * An output with no tie is left ALONE. gcc leaves whatever the register held, which is
           * undefined; keeping the variable's own value is the deterministic reading of that, and
           * inventing a number would be worse than either.
           *
           * Inputs are evaluated in order whether or not they are tied, being ordinary C expressions
           * that may have side effects -- 990130-1.c calls a function inside one.
           */
          /*
           * The OUTPUT lvalues are evaluated first, and exactly once. That is not tidiness: gcc's
           * 990130-1.c writes `asm("" : "+r"(*bar()))` and counts the calls to bar(), so an
           * implementation that only looks at inputs never calls it at all.
           */
          /* A constraint arrives as a STRING TOKEN, quotes and all -- `"0"`, not `0`. */
          const bare = (c) => String(c ?? '').replace(/^L?"|"$/g, '');
          const dests = outputs.map(op => ({
            place: this.#lvalPlace(op.expr),
            constraint: bare(op.constraint),
          }));
          const values = inputs.map(op => {
            const v = this.#rval(op.expr);
            const t = this.newTmp();
            this.#declareTmp(t);
            this.out.push(`${t}=${v.js};`);
            return { tmp: t, type: v.type, constraint: bare(op.constraint) };
          });
          for (let i = 0; i < values.length; i++) {
            const m = /^[%&]*(\d+)$/.exec(values[i].constraint);
            if (!m) continue;
            const d = dests[+m[1]];
            if (d) this.#storeAt(d.place, values[i].tmp, values[i].type);
          }
          return;
        }
        return unsup('inline assembly');
      }
    }
    unsup(`statement '${s.n}'`);
  }

  /**
   * Evaluate an lvalue ONCE and keep where it lands, so a later store does not re-run the address.
   * `*bar()` must call bar exactly once however many times the place is written.
   */
  #lvalPlace(e) {
    const l = this.#lval(e);
    if (l.varJs) return { varJs: l.varJs, type: l.type };
    const t = this.newTmp();
    this.#declareTmp(t);
    this.out.push(`${t}=${l.addr};`);
    return { addr: t, type: l.type, bitfield: l.bitfield };
  }

  /** Store an already-computed JS value into a place from #lvalPlace. */
  #storeAt(place, js, fromType) {
    if (!place) return;
    if (place.bitfield) { this.#initBitfield(place.addr, place.bitfield, js); return; }
    const v = coerce(js, fromType ?? place.type, place.type);
    if (place.varJs) { this.out.push(`${place.varJs}=${v};`); return; }
    this.out.push(storeExpr(place.addr, place.type, v) + ';');
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
        /*
         * Not ours: it may be the ENCLOSING function's, reached through the static link. A slot
         * there is at the same offset in the frame `_up` points at; a JS variable there is
         * unreachable, which is why every name a nested function mentions was pinned to a slot.
         */
        if (this.parent) {
          const up = (this.ctx.parentScope ?? this.parent.locals).get(e.name);
          if (up) {
            if (up.kind === 'slot') return { addr: `(_up+${up.off}|0)`, type: up.type };
            if (up.kind === 'global') return { addr: String(up.addr), type: up.type };
            if (up.kind === 'aggparam') unsup(`the enclosing function's '${e.name}'`);
          }
        }
        const g = this.ctx.globals.get(e.name);
        if (g) return { addr: String(g.addr), type: g.type };
        const f = this.ctx.funcs.get(e.name);
        if (f) return { addr: String(f.addr), type: f.type, isFunc: true };
        /*
         * `__func__` is not a variable a program declares -- C99 6.4.2.2 says the compiler provides
         * it, as a static array holding the function's name. gcc's `__FUNCTION__` is the same thing
         * spelled older, and `__PRETTY_FUNCTION__` is too in C.
         */
        if (/^(__func__|__FUNCTION__|__PRETTY_FUNCTION__)$/.test(e.name)) {
          const bytes = [...this.decl.name].map(c => c.charCodeAt(0) & 0xff);
          return { addr: String(this.mod.intern(bytes)), type: T.array(T.CHAR, bytes.length + 1) };
        }
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
        return { addr: `((${b.js})+Math.imul(${indexJs(i)},${es})|0)`, type: bt.to };
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
        if (!f) {
          /*
           * What it DOES have, because the interesting case is never a typo -- it is a tag that
           * resolved to a different or an unfinished type, and the member list says which at a
           * glance instead of after an hour of reading headers.
           */
          const have = rec.complete === false ? '(incomplete)'
            : (rec.fields ?? []).map(x => x.name ?? '<anon>').join(' ') || '(no members)';
          throw new EmitError(`'${T.typeName(rec)}' has no member '${e.field}' -- it has: ${have}`);
        }
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
      /*
       * A struct-valued `?:` is not an lvalue in C, but tier-0 still needs an ADDRESS for it: struct
       * assignment copies from one. So materialise it — a slot in this frame, filled by whichever
       * branch runs, and the slot's address is the result.
       *
       * SQLite's generated parser writes exactly this shape, and refusing it left the entire SQL
       * parser unimplemented.
       */
      /*
       * A record-valued comma or assignment: `(a, s).f` and `(s = t).f` are both ordinary C, and
       * neither result is an lvalue -- but tier-0 needs an ADDRESS for a record all the same, for
       * exactly the reason the `cond` case below explains.
       *
       * Deliberately NOT the GNU lvalue extensions. `(a, b) = x` and `(a = b) = c` on scalars were
       * removed from gcc years ago and gcc 12 rejects them, so accepting them here would make PRISM
       * compile programs the reference will not -- a divergence in the direction no gate looks.
       * Restricting to records keeps this a tier-0 implementation detail rather than a dialect.
       */
      case 'comma': {
        // The parser leaves a comma's own type null, so the type is the RIGHT operand's.
        if (!T.isRecord(e.type ?? e.b?.type ?? T.INT)) break;
        const left = this.#rval(e.a);
        const l = this.#lval(e.b);
        return { ...l, addr: `(${left.js},${l.addr})` };
      }
      case 'assign': {
        if (!T.isRecord(e.type ?? T.INT)) break;
        const done = this.#rval(e);          // performs the assignment
        const l = this.#lval(e.lhs);         // then the object it wrote to
        return { ...l, addr: `(${done.js},${l.addr})` };
      }
      /*
       * A COMPOUND LITERAL, `(T){ ... }`. C99 6.5.2.5 makes it an lvalue with automatic storage and
       * the lifetime of the enclosing block, so a frame slot is not an implementation convenience --
       * it is the storage the standard describes.
       *
       * The initialisation is emitted IN PLACE, as a comma expression, rather than hoisted ahead of
       * the statement. That matters when the literal sits inside a branch or a `?:`: hoisting would
       * run its initialisers whether or not the branch is taken, and initialisers can have side
       * effects. OpenTyrian's file.c returns `(File){ f, errno, f == NULL }`, which reads errno.
       */
      case 'compound': {
        const t = e.type;
        if (!t || t.size == null) throw new EmitError('a compound literal of incomplete type');
        const off = this.slot(t.size, t.align);
        const at = `(_fp+${off}|0)`;
        const steps = this.#captureInit(at, t, e.init);
        return { addr: steps.length ? `(${steps.join(',')},${at})` : at, type: t };
      }
      /*
       * A record-valued statement expression. Same rule as the comma and the conditional above: the
       * result is not an lvalue, but a record travels as its address in tier-0, and `({...}).x` is
       * ordinary GNU C.
       */
      case 'stmtexpr': {
        if (!T.isRecord(e.type ?? T.INT)) break;
        const v = this.#stmtExpr(e);
        return { addr: v.js, type: v.type };
      }
      case 'cond': {
        if (!T.isRecord(e.type ?? T.INT)) break;
        const off = this.slot(e.type.size, e.type.align);
        const at = `(_fp+${off}|0)`;
        const a2 = this.#lval(e.then ?? e.cond);
        const b2 = this.#lval(e.els);
        return {
          addr: `(${this.#truth(e.cond)}?M.copy(${at},${a2.addr},${e.type.size}):` +
            `M.copy(${at},${b2.addr},${e.type.size}),${at})`,
          type: e.type,
        };
      }
    }
    /*
     * An AST node name and nothing else is not a diagnostic. `'bin' is not an lvalue` sent me
     * reading a whole file for a variable called bin; the loc every node already carries says which
     * line, and the operator says which expression.
     */
    const where = e.loc ? ` at ${e.loc.file}:${e.loc.line}` : '';
    throw new EmitError(`'${e.n}'${e.op ? ` (${e.op})` : ''} is not an lvalue${where}`);
  }

  /*
   * A safepoint on a loop's back edge.
   *
   * This is the one thing that makes a loop in pure guest C observable. Neither profiler can see one:
   * a program spinning in its own code calls no runtime service and crosses no unit boundary, so
   * there is nothing to count. A check here is the only place the host can regain control.
   *
   * It is off by default and it is not free — a decrement and a compare on every iteration of every
   * loop, which is exactly the cost MIRAGE measured when it studied this. Emitting it as a budget
   * rather than a call keeps the common case to two operations and never leaves the loop.
   *
   * The general form of this is what would let Stop interrupt a `while (1);` — the same mechanism,
   * a different handler.
   */
  #safepoint() {
    if (!this.ctx.safepoints) return '';
    const id = this.mod.safepoints.length;
    this.mod.safepoints.push(`${this.decl.name}#${this.mod.safepoints.length}`);
    return `if(--M.spBudget<0)M.sp_(${id});`;
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
      /*
       * offsetof is a constant, and constEval already knows how to walk the member path — including
       * through arrays and nested structs. It reached the emitter unhandled only because nothing had
       * used it in an ordinary expression before; SQLite uses it in 38 functions.
       */
      case 'offsetof': return { js: String(constEval(e)), type: T.UINT };
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
        // A struct's "value" in tier-0 IS its address, exactly as an array's is: every legal
        // consumer of a struct rvalue -- assignment, an argument, a return, a member access,
        // sizeof -- wants the address and copies from it. Refusing here made `(void)tok;` fail,
        // which SQLite's generated parser writes to silence an unused-parameter warning.
        if (T.isRecord(l.type)) return { js: l.addr, type: l.type };
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
        if (T.isRecord(l.type)) return { js: l.addr, type: l.type };
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
      // `__alignof__ x` -- the alignment of the EXPRESSION's type, and like sizeof it does not
      // evaluate x.
      case 'alignofexpr': {
        const t = e.expr?.type;
        // A FUNCTION has no alignment here: its address is a table index, so `__alignof__(func)`
        // could only ever be a plausible-looking wrong number (gcc's align-3.c asks for 256).
        if (t?.k === 'func') unsup('__alignof__ of a function');
        if (!t || t.align == null) throw new EmitError('__alignof__ of an expression of unknown type');
        return { js: String(t.align), type: T.UINT };
      }
      /*
       * As an rvalue. A record IS its address here -- that is how every record-valued expression
       * travels in tier-0, and it is what lets `return (File){...}` reach the sret buffer. A scalar
       * compound literal, `(int){3}`, is read back out of its slot.
       */
      case 'compound': {
        const l = this.#lval(e);
        if (T.isRecord(l.type) || l.type.k === 'array') return { js: l.addr, type: l.type };
        return { js: loadExpr(l.addr, l.type), type: l.type };
      }
      case 'stmtexpr': return this.#stmtExpr(e);
      case 'offsetof':
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
      // A record rvalue IS its address in tier-0, the same rule as an array's -- and `*p` on a
      // struct or union pointer is a place that rule was missing. csmith reaches it constantly
      // because it passes unions by value through pointers; the two sibling sites above already
      // had the guard.
      if (T.isRecord(l.type)) return { js: l.addr, type: l.type };
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
      return { js: `((${a.js})${op}Math.imul(${indexJs(b)},${s})|0)`, type: at };
    }
    if (bt.k === 'ptr' && T.isInteger(at) && op === '+') {
      const s = bt.to.size ?? 1;
      return { js: `((${b.js})+Math.imul(${indexJs(a)},${s})|0)`, type: bt };
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
      // The COUNT is converted on its own -- a shift has no common type, C99 6.5.7p3 -- so a 64-bit
      // count on a 32-bit value becomes an ordinary number. Left as a BigInt, `&31` threw
      // "Cannot mix BigInt and other types" out of `(unsigned)a >> 3ULL` (gcc's pr82192.c).
      const sh = `((${coerce(b.js, bt, T.INT)})&31)`;
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

    /*
     * Compound assignment. The right-hand side is evaluated BEFORE the lvalue is read, which is what
     * gcc does and what real code depends on: MAME's Z80 core writes
     *
     *     R.PC.W.l += (offset)M_RDMEM_OPCODE();
     *
     * where the callee increments PC. Reading the lvalue first makes every relative jump one byte
     * short — DJNZ landed at 0x2310 instead of 0x2311, which is how Pac-Man never got past its
     * init. C leaves the order unspecified, so both are conforming; only one of them runs the code
     * this project exists to run.
     */
    const op = e.op.slice(0, -1);
    const rv = this.#rval(e.rhs);
    const rt = this.newTmp(); this.#declareTmp(rt);
    const rhsVal = { js: rt, type: rv.type };

    if (l.varJs) {
      const combined = this.#binaryWithValue({ js: l.varJs, type: l.type }, rhsVal, op);
      return {
        js: `(${rt}=${rv.js},${l.varJs}=${coerce(combined.js, combined.type, rhsType)})`,
        type: rhsType,
      };
    }
    const at = this.newTmp(); this.#declareTmp(at);
    const t = this.newTmp(); this.#declareTmp(t);
    const combined = this.#binaryWithValue({ js: loadExpr(at, l.type), type: l.type }, rhsVal, op);
    // The address is computed once, before the right-hand side, so the lvalue is designated once.
    return {
      js: `(${at}=${l.addr},${rt}=${rv.js},${t}=${coerce(combined.js, combined.type, rhsType)},` +
        `${storeExpr(at, rhsType, t)},${t})`,
      type: rhsType,
    };
  }

  /** Like #binary but with the left side already evaluated. */
  #binaryWith(a, rhsNode, op) {
    return this.#binaryWithValue(a, this.#rval(rhsNode), op);
  }

  /** Like #binaryWith but with BOTH sides already evaluated, so the caller controls the order. */
  #binaryWithValue(a, b, op) {
    const at = T.decay(a.type), bt = T.decay(b.type);
    if (at.k === 'ptr' && T.isInteger(bt) && (op === '+' || op === '-')) {
      const s = at.to.size ?? 1;
      return { js: `((${a.js})${op}Math.imul(${indexJs(b)},${s})|0)`, type: at };
    }
    if (op === '<<' || op === '>>') {
      const t = T.promote(at);
      const A = coerce(a.js, at, t);
      if (is64(t)) {
        const shb = `BigInt(${coerce(b.js, bt, T.INT)}&63)`;
        return { js: mask64(`((${A})${op}${shb})`, t), type: t };
      }
      const sh = `((${coerce(b.js, bt, T.INT)})&31)`;
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

  /*
   * A GNU statement expression, `({ ... })`. Its value is the last statement, and the last statement
   * is a STATEMENT -- so the thing JavaScript has no syntax for is exactly the thing this needs.
   *
   * It becomes an arrow function called on the spot. The obvious alternative, hoisting the body
   * ahead of the enclosing statement and leaving a temporary behind, is wrong wherever the
   * expression is not evaluated unconditionally: gcc's 950906-1.c puts one in a `while` condition,
   * where hoisting would run the body once instead of once per iteration, and `a ? ({...}) : b`
   * would run it even when the branch is not taken. An arrow evaluates where it is written.
   *
   * The body's locals are ordinary emitted `var`s, scoped to the arrow, and its frame slots are
   * this function's -- which is what 20020320-1.c checks by returning a struct from one statement
   * expression and reading it after a second one has run: slot offsets only grow, so the storage a
   * statement expression used is still there afterwards.
   *
   * A jump that LEAVES the body cannot be an arrow's: `return` would return from the arrow, and
   * `break`/`continue`/`goto` have no target across a function boundary. Each is refused by name.
   */
  #stmtExpr(e) {
    escapingJump(e.body);
    const outer = this.out;
    this.out = [];
    let value = null;
    try {
      this.#scoped(() => {
        const items = e.body.items;
        for (let i = 0; i < items.length; i++) {
          const tail = i === items.length - 1;
          if (tail && items[i].n === 'exprstmt') {
            value = this.#rval(items[i].expr);
            this.out.push(`return ${value.js};`);
          } else this.#item(items[i], this.escaped);
        }
      });
    } finally {
      var lines = this.out;
      this.out = outer;
    }
    // Joined onto ONE line, not for compactness: an emitted line that contains a newline is how
    // #captureInit tells a statement from an expression, and this is an expression whichever way it
    // is spelled. Every line the emitter produces already ends in `;` or a brace, and none of them
    // carry a `//` comment, so a space is a safe join.
    return { js: `(()=>{${lines.join(' ')}})()`, type: value ? value.type : T.VOID };
  }

  #declareTmp(name) {
    if (!this._tmps) this._tmps = new Set();
    // Initialised to 0, and reassigned before any use; a BigInt temp is written before it is read.
    if (!this._tmps.has(name)) { this._tmps.add(name); this.out.unshift(`var ${name}=0;`); }
  }

  #call(e) {
    // A direct call by name; anything else goes through the function table.
    //
    // A global VARIABLE of function-pointer type is not a direct call: Quake's byte-order helpers are
    // `int (*LittleLong)(int)` assigned at start-up, and treating the name as a function made it an
    // undeclared-function error. In C a name is either a function or an object, so a hit in `globals`
    // settles it in favour of the indirect path.
    const calleeIsObject = !this.locals.has(e.fn.name) && this.ctx.globals.has(e.fn.name);
    if (e.fn.n === 'ident' && !this.locals.has(e.fn.name) && !calleeIsObject) {
      const name = e.fn.name;
      /*
       * A NESTED function of this one, or -- when this IS a nested function -- one of its siblings,
       * itself included. The frame it needs is `_fp` when the caller owns it and `_up` when the
       * caller is another nested function of the same parent.
       */
      const nest = this.nested.get(name) ?? this.parent?.nested.get(name);
      if (nest) {
        const frame = this.nested.has(name) ? '_fp' : '_up';
        const args = this.#callArgs(e, nest.decl.type);
        return { js: `${jsIdent(nest.jsName)}(${[frame, ...args].join(',')})`, type: nest.decl.type.ret };
      }
      const f = this.ctx.funcs.get(name);
      /*
       * A function the PROGRAM DEFINES wins over a runtime builtin of the same name. Checking the
       * builtin table first meant a program's own `osd_key_pressed` — or its own memcpy, or printf —
       * was silently replaced by PRISM's: that is how MAME's headless backend lost its "stop after N
       * frames" and ran for twelve hours. A mere PROTOTYPE does not win, so `int printf();` still
       * reaches the runtime.
       */
      const rt = (f && f.defined) ? null : this.ctx.builtins.get(name);
      if (rt?.setjmp) {
        // The registration was emitted by the planner; here the call is just its return value.
        if (!this.hasSetjmp) unsup('setjmp outside a statement the planner could lift');
        return { js: '_sjv', type: T.INT };
      }
      if (rt?.vaStart) {
        if (!this.variadic) throw new EmitError('va_start outside a variadic function');
        return { js: '_va', type: T.ptr(T.CHAR) };
      }
      /*
       * `__builtin_classify_type(x)` is a constant naming the CLASS of x's type, and gcc does not
       * evaluate x -- so neither does this. The codes are gcc's own, confirmed against the reference
       * build rather than read off its header: every integer type is 1 (char, _Bool and an enum
       * included, where the header still lists separate classes), every floating type is 8, and an
       * array or a function is 5 because it has already decayed to a pointer.
       */
      if (rt?.classify) {
        if (e.args.length !== 1) throw new EmitError(`${name} takes one argument`);
        const t = T.decay(e.args[0].type ?? T.INT);
        const code = t.k === 'ptr' ? 5
          : t.k === 'struct' ? 12
          : t.k === 'union' ? 13
          : t.k === 'void' ? 0
          : (t.k === 'scalar' && /float|double/.test(t.name ?? '')) ? 8
          : 1;
        return { js: String(code), type: T.INT };
      }
      /*
       * The overflow builtins are TYPE-GENERIC, which is why they cannot be an ordinary table entry:
       * `__builtin_add_overflow(a, b, &r)` computes in infinite precision and reports whether the
       * result fits in whatever `r` is. So the width and signedness come from the third argument's
       * POINTEE, which only the emitter knows, and the arithmetic happens in BigInt because that is
       * the only thing here with the range to notice an overflow of a 64-bit type.
       */
      if (rt?.overflow) {
        if (e.args.length !== 3) throw new EmitError(`${name} takes three arguments`);
        const a = this.#rval(e.args[0]), b = this.#rval(e.args[1]), dst = this.#rval(e.args[2]);
        const to = dst.type?.k === 'ptr' ? dst.type.to : null;   /* a pointer's target is `to`; `of` is an array's */
        if (!to || to.k !== 'scalar') unsup(`${name} into a ${T.typeName(dst.type ?? T.INT)}`);
        const isUnsigned = (t) => !!t && /^unsigned|^_Bool/.test(t.name ?? '');
        /*
         * Each operand carries ITS OWN type into the infinite-precision arithmetic -- there is no
         * common type here, which is the whole point of these builtins. A 32-bit value comes out of
         * the emitter as a signed i32, so an unsigned one has to be put back: 0xffffffffu read as -1
         * turns `0xffffffffu + 1u` into 0 and reports NO overflow, which is how gcc's pr85095.c
         * caught this.
         */
        const operand = (v) => (v.type?.k === 'scalar' && v.type.size <= 4 && isUnsigned(v.type)
          ? `((${v.js})>>>0)` : v.js);
        return {
          js: `M.rt.__prism_overflow(${JSON.stringify(rt.overflow)},${operand(a)},${operand(b)},` +
              `${dst.js},${to.size},${isUnsigned(to) ? 0 : 1})`,
          type: T.INT,
        };
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
        /*
         * The PROGRAM's prototype governs the result type when both say pointer.
         *
         * A builtin table cannot name `struct tm *` -- the struct belongs to whichever program
         * declared it -- so localtime is listed as returning a generic pointer, and that was
         * overruling `struct tm *localtime(const time_t *)` from PRISM's own time.h. The member
         * access then failed with "'char' has no member 'tm_mon'".
         *
         * Restricted to pointer-for-pointer on purpose. The float family declares sqrtf as taking
         * and returning FLOAT precisely so a store rounds, and that must keep winning over a
         * program that prototypes it in double.
         */
        const declared = f?.type?.ret;
        const ret = (declared && declared.k === 'ptr' && rt.ret?.k === 'ptr') ? declared : rt.ret;
        return { js: `M.rt.${impl}(${args.join(',')})`, type: ret };
      }
      if (f) {
        const ft = f.type;
        const args = this.#callArgs(e, ft);
        /*
         * A call to a name that is DECLARED and never DEFINED, and is not a runtime builtin either.
         * It compiles -- the call goes through F, which is exactly what a real linker's undefined
         * symbol would not do -- and then fails at run time as `F.name is not a function`.
         *
         * OpenDUNE is why this is recorded. `get_bios_keyboard_status` has its body in a Watcom
         * `#pragma aux`, which PRISM ignores, so the build reported "nothing unemitted" and the gap
         * appeared only when Video_Tick called it. A linker names its undefined symbols; so should
         * this. It is also the on-ramp to compiling the assembly: cross this list with the .asm
         * objects a makefile lists and you have exactly what the assembler was providing.
         */
        if (!f.defined) {
          const where = this.ctx.undefinedCalls;
          if (where) (where.get(f.name) ?? where.set(f.name, new Set()).get(f.name)).add(this.ctx.unit ?? '?');
        }
        /*
         * directCalls: an experiment, off by default, measuring one thing only.
         *
         * Every cross-function call normally goes through `F["name"]` on an object with as many
         * properties as the program has functions, which V8 keeps in dictionary mode -- and
         * `Builtin: LoadIC` is the largest accounted entry in the profile of the Z80 core. This
         * emits a direct call to the emitted function's own identifier instead, which is only
         * possible when the callee is DEFINED here: a declaration with no body resolves through F to
         * a runtime binding or a throwing stub.
         *
         * The cost of turning it on is not speed, it is observability: every harness in tools/
         * instruments a program by rebinding prog.F, and a direct call cannot see that.
         */
        if (this.ctx.directCalls && f.defined) {
          return { js: `${jsIdent(f.name)}(${args.join(',')})`, type: ft?.ret ?? T.INT };
        }
        // The LINKAGE name, not the source name: a file-scope `static` is mangled per translation
        // unit, and using the source name here called a function that was never bound.
        return { js: `F[${JSON.stringify(f.name)}](${args.join(',')})`, type: ft?.ret ?? T.INT };
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

  /*
   * A bitfield read.
   *
   * The fast path is a single 32-bit unit, which is what the layout produces for every ordinary
   * struct. It is NOT what `#pragma pack(1)` produces: packing removes the alignment that kept a
   * field inside one unit, so `int f:26` can start at bit 23 and run past the word boundary. That
   * used to be refused outright, which csmith hit in one program in six.
   *
   * The general path works in BYTES, because bytes are the only unit that always contains the field
   * -- at most five of them for a 32-bit-wide field -- and assembles them with multiplication rather
   * than shifts: JS shifts are 32-bit, and five bytes is 40.
   */
  #loadBitfield(l) {
    const f = l.bitfield;
    /*
     * A bitfield whose DECLARED TYPE is 64-bit goes through the runtime, whatever its width.
     *
     * Two reasons, and the first is not about width at all: `unsigned long long a:8` is eight bits
     * wide but its type is 64-bit, so the value has to arrive as a BigInt or the first arithmetic on
     * it throws "Cannot mix BigInt and other types" -- which is what six of gcc's torture programs
     * did. The second is that a field wider than 32 bits cannot be assembled in a Number at all
     * beyond 53 bits, and the byte path below multiplies rather than shifts precisely because JS
     * shifts are 32-bit.
     *
     * A bitfield is not a hot path, so a call is cheaper than emitting the BigInt arithmetic inline
     * and getting the sign extension wrong in two places instead of one.
     */
    if (is64(f.type)) {
      /*
       * WIDER THAN 32 BITS IS STILL REFUSED, and the reason is not the storage -- it is the
       * ARITHMETIC. C 6.7.2.1p9 makes a bitfield "an integer type consisting of the specified number
       * of bits", and gcc takes that literally: `unsigned long long b:40` shifted left by 32 is
       * computed in FORTY-bit precision, so 0x100 << 32 is 0, not 0x10000000000. Doing that needs a
       * width-parameterised integer type, which this type system does not have -- and pretending the
       * type is 64-bit produces a plausible wrong answer instead of a refusal (bitfld-5.c,
       * pr32244-1.c, pr34971.c). See docs/ROADMAP.md.
       */
      if (f.width > 32) unsup('a bitfield wider than 32 bits');
      const get = `M.rt.__prism_bf_get64((${l.addr}|0),${f.bitOffset},${f.width},${f.type.signed ? 1 : 0})`;
      // Narrow fields promote to int or unsigned int, so their value must arrive as a Number.
      return is64(bitfieldPromoted(f)) ? get : `Number(${get})`;
    }
    const shift = f.bitOffset & 31;
    if (shift + f.width <= 32) {
      const unitOff = (f.bitOffset >> 5) * 4;
      const raw = `D.getUint32((${l.addr}+${unitOff}|0),1)`;
      if (f.type.signed) return `((${raw})<<${32 - shift - f.width}>>${32 - f.width})`;
      return `(((${raw})>>>${shift})&${(2 ** f.width - 1) >>> 0})`;
    }
    if (f.width > 32) unsup('a bitfield wider than 32 bits');
    const byteOff = f.bitOffset >> 3;
    const bit = f.bitOffset & 7;
    const nbytes = Math.ceil((bit + f.width) / 8);
    const at = this.newTmp(); this.#declareTmp(at);
    const parts = [];
    for (let i = 0; i < nbytes; i++) parts.push(`M.u8[${at}+${i}]*${2 ** (8 * i)}`);
    const raw = `(${parts.join('+')})`;
    // Math.floor, not >>>: the assembled value can exceed 32 bits.
    const field = `(Math.floor(${raw}/${2 ** bit})%${2 ** f.width})`;
    const body = f.type.signed
      // Sign-extend by hand; the value is a plain Number, so the <<>> trick is unavailable.
      ? `(${field}>=${2 ** (f.width - 1)}?${field}-${2 ** f.width}:${field})`
      : field;
    return `(${at}=(${l.addr}+${byteOff}|0),${body})`;
  }

  #assignBitfield(l, e) {
    const f = l.bitfield;
    const v = this.newTmp(); this.#declareTmp(v);
    const at = this.newTmp(); this.#declareTmp(at);
    /*
     * `b.f += x` is a read, an operation in the PROMOTED type, and a store back -- and the promotion
     * is where a bitfield differs from anything else: `unsigned f:3` promotes to `int`, so
     * `f -= 1` on a zero field is -1 in int and then truncates to 7, not to some 3-bit borrow.
     * bitfieldPromoted already knows that rule, so the arithmetic simply happens there.
     */
    const rhs = e.op === '='
      ? this.#rvalCoerced(e.rhs, f.type)
      : coerce(
          this.#binaryWithValue(
            { js: this.#loadBitfield(l), type: bitfieldPromoted(f) },
            this.#rval(e.rhs), e.op.slice(0, -1),
          ).js,
          bitfieldPromoted(f), f.type);
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
  const shift = f.bitOffset & 31;
  if (shift + f.width <= 32) {
    const mask = (((2 ** f.width - 1) >>> 0) << shift) >>> 0;
    const at = base + (f.bitOffset >> 5) * 4;
    const cur = mod.dv.getUint32(at, true);
    mod.dv.setUint32(at, (((cur & ~mask) | ((value << shift) & mask)) >>> 0), true);
    return;
  }
  if (f.width > 32) unsup('a static bitfield wider than 32 bits');
  // Byte-wise, the same arithmetic as bitfieldPoke but executed here instead of emitted.
  const bit = f.bitOffset & 7;
  const nbytes = Math.ceil((bit + f.width) / 8);
  const at = base + (f.bitOffset >> 3);
  const v = Number(value) >>> 0;
  for (let i = 0; i < nbytes; i++) {
    const lo = Math.max(0, bit - 8 * i);
    const hi = Math.min(8, bit + f.width - 8 * i);
    const keep = (~(((1 << hi) - (1 << lo)) & 0xff)) & 0xff;
    const from = 8 * i - bit + lo;
    mod.u8[at + i] = (mod.u8[at + i] & keep) | (((Math.floor(v / 2 ** from) << lo) & (~keep & 0xff)));
  }
}

/** The type a bitfield read has after the integer promotions. */
/*
 * C99 6.3.1.1: a bitfield promotes to int if int can hold every value it has, otherwise to unsigned
 * int -- and otherwise to its own type, which is the case a 64-bit bitfield reaches. `long long
 * a:40` cannot fit in an int, so it stays 64-bit and its arithmetic stays BigInt; saying INT here
 * made every read mix a BigInt with a Number on the next operation.
 */
function bitfieldPromoted(f) {
  if (f.type.k !== 'scalar') return T.INT;
  /*
   * The rule is about VALUES, not about the declared type: int if int can represent every value the
   * field can hold, otherwise unsigned int, otherwise the field's own type. So a `long long a:8`
   * promotes to int like any other narrow field, and only a field wider than 32 bits stays 64-bit.
   *
   * Claiming the 64-bit type for narrow fields instead was tempting -- the read returns a BigInt
   * whatever the width -- and gcc has four programs that fail on it (bf-sign-2.c, bitfld-5.c,
   * pr32244-1.c, pr34971.c). #loadBitfield converts the BigInt down when the promotion says 32-bit;
   * the representation follows the type rather than deciding it.
   */
  if (is64(f.type)) {
    if (f.width < 32) return T.INT;
    if (f.width === 32) return f.type.signed ? T.INT : T.UINT;
    return f.type;
  }
  if (f.type.signed) return T.INT;
  return f.width < 32 ? T.INT : T.UINT;
}

/**
 * The read-modify-write for one bitfield, shared by assignment and initialisation.
 *
 * `unitOff` is what the caller adds to the object's address before poking, so the two paths below
 * differ in their unit as well as in their arithmetic: a 32-bit word for the aligned case, the
 * containing byte for the packed one.
 */
function bitfieldPoke(f, atVar, valVar) {
  /* The 64-bit twin of the read above: the value is a BigInt, so the store has to be too. */
  if (is64(f.type)) {
    if (f.width > 32) unsup('a bitfield wider than 32 bits');
    return { unitOff: 0, poke: `M.rt.__prism_bf_set64(${atVar},${f.bitOffset},${f.width},${valVar})` };
  }
  const shift = f.bitOffset & 31;
  if (shift + f.width <= 32) {
    const mask = (((2 ** f.width - 1) >>> 0) << shift) >>> 0;
    return {
      unitOff: (f.bitOffset >> 5) * 4,
      poke: `D.setUint32(${atVar},((D.getUint32(${atVar},1)&${(~mask) >>> 0})|((${valVar}<<${shift})&${mask}))>>>0,1)`,
    };
  }
  if (f.width > 32) unsup('a bitfield wider than 32 bits');
  // Byte-wise, for a field `#pragma pack` left straddling a word: only the bytes the field actually
  // covers are touched, and only the bits inside them.
  const bit = f.bitOffset & 7;
  const nbytes = Math.ceil((bit + f.width) / 8);
  const steps = [];
  for (let i = 0; i < nbytes; i++) {
    const lo = Math.max(0, bit - 8 * i);                       // first bit of this byte in the field
    const hi = Math.min(8, bit + f.width - 8 * i);             // one past the last
    const keep = (~(((1 << hi) - (1 << lo)) & 0xff)) & 0xff;   // bits of this byte NOT in the field
    const from = 8 * i - bit + lo;                             // bit of the value that lands at `lo`
    steps.push(`M.u8[${atVar}+${i}]=(M.u8[${atVar}+${i}]&${keep})|` +
      `((Math.floor(${valVar}/${2 ** from})<<${lo})&${(~keep) & 0xff})`);
  }
  return { unitOff: f.bitOffset >> 3, poke: `(${steps.join(',')})` };
}

function unifyCond(a, b) {
  const at = T.decay(a), bt = T.decay(b);
  if (at.k === 'ptr') return at;
  if (bt.k === 'ptr') return bt;
  if (T.isArith(at) && T.isArith(bt)) return T.usualArith(at, bt);
  return at;
}

/** The first `setjmp` call in this statement, if any. */
function findSetjmpCall(node, builtins) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) { const r = findSetjmpCall(x, builtins); if (r) return r; }
    return null;
  }
  if (node.n === 'call' && node.fn?.n === 'ident' && builtins?.get(node.fn.name)?.setjmp) return node;
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'sym' || k === 'loc') continue;
    const r = findSetjmpCall(node[k], builtins);
    if (r) return r;
  }
  return null;
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
/**
 * Every identifier a NESTED FUNCTION mentions, because it can only reach the enclosing frame through
 * memory. A JS `var` in one function is invisible to another; a frame slot is not, since the nested
 * function is handed the frame pointer.
 *
 * Deliberately blunt: it marks names the nested function declares for itself too. Those are its own
 * locals and pinning the outer one of the same name costs a slot and nothing else, where being wrong
 * the other way costs a wrong answer.
 */
/** Every nested function definition in a body, at whatever block depth it sits. */
function nestedDefs(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) nestedDefs(x, out); return out; }
  if (node.n === 'func' && node.body) out.push(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'sym' || k === 'loc') continue;
    nestedDefs(node[k], out);
  }
  return out;
}

export function collectNestedRefs(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectNestedRefs(x, out); return; }
  if (node.n === 'ident' && node.name) out.add(node.name);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'sym' || k === 'loc') continue;
    collectNestedRefs(node[k], out);
  }
}

/**
 * The length a flexible array member takes from its own initialiser: the items it is given, or the
 * bytes of the string literal that fills it. `struct { int n; char s[]; } x = { 1, "abc" };` makes
 * `s` four bytes long, terminator included, exactly as if the `[]` had said 4.
 */
export function flexibleArrayType(at, value) {
  if (at?.k !== 'array') return at;
  const of = at.of;
  if (value?.n === 'initlist') return T.array(of, value.items.length);
  let e = value?.expr;
  while (e && e.n === 'cast') e = e.expr;
  if (e?.n === 'str' && e.type?.size) return T.array(of, Math.ceil(e.type.size / (of.size || 1)));
  return at;
}

/**
 * How many bytes BEYOND `sizeof(type)` an initialiser writes, because it fills a flexible array
 * member. The object needs that storage reserved before anything is written into it -- a linker
 * sizes such an object from its initialiser, and without this the next global sits on top of it.
 *
 * Zero for everything else, which is every object in every target: this is walked once per
 * file-scope definition and stops at the first member that cannot contain one.
 */
export function flexibleExtra(type, init) {
  let end = 0;
  const walk = (type, init, base) => {
    if (!init || init.n !== 'initlist' || !T.isRecord(type)) return;
    const named = type.fields.filter(f => f.width !== 0
      && (f.name || (f.bits === undefined && T.isRecord(f.type))));
    let k = 0;
    for (const it of init.items) {
      let f = named[k];
      if (it.designators?.[0]?.field) f = findField(type, it.designators[0].field);
      if (!f) break;
      k = named.indexOf(f) + 1;
      if (f.flexible) end = Math.max(end, base + f.offset + (flexibleArrayType(f.type, it.value).size ?? 0));
      else if (T.isRecord(f.type)) walk(f.type, it.value, base + f.offset);
      if (type.k === 'union') break;       // a union takes one item, into its first member
    }
  };
  walk(type, init, 0);
  return Math.max(0, end - (type.size ?? 0));
}

/**
 * Split one emitted line into the statements it holds, at its TOP-LEVEL semicolons.
 *
 * A single push is not always a single statement -- a bitfield store emits `_t0=addr; _t1=value;
 * D.setUint32(...)` as one line -- and a comma expression cannot hold a semicolon. Depth is tracked
 * because a semicolon inside an arrow function's body (a statement expression) belongs to that body,
 * not to this line.
 */
function topLevelStatements(line) {
  const out = [];
  let depth = 0, start = 0, quote = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = 0; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) { out.push(line.slice(start, i)); start = i + 1; }
  }
  const last = line.slice(start).trim();
  if (last) out.push(last);
  return out.map(x => x.trim()).filter(Boolean);
}

/**
 * Refuse a statement expression whose body jumps OUT of itself, naming the jump. Depth counts the
 * loops and switches the body opens for itself: a `break` inside one of those is the body's own.
 */
function escapingJump(body) {
  const walk = (node, depth, sw) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x, depth, sw); return; }
    switch (node.n) {
      case 'return': unsup('a `return` inside a statement expression');
      case 'goto': case 'gotoexpr': unsup('a `goto` out of a statement expression');
      case 'label': unsup('a label inside a statement expression');
      case 'case': case 'default':
        if (!sw) unsup('a case label inside a statement expression');
        walk(node.body, depth, sw);
        return;
      case 'break': if (!depth && !sw) unsup('a `break` out of a statement expression'); return;
      case 'continue': if (!depth) unsup('a `continue` out of a statement expression'); return;
      case 'while': case 'do': case 'for':
        walk(node.cond, depth, sw); walk(node.init, depth, sw); walk(node.step, depth, sw);
        walk(node.body, depth + 1, sw);
        return;
      case 'switch': walk(node.disc, depth, sw); walk(node.body, depth, true); return;
      // A nested statement expression checks itself when it is emitted.
      case 'stmtexpr': return;
      case 'func': return;
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'sym' || k === 'loc') continue;
      walk(node[k], depth, sw);
    }
  };
  walk(body, 0, false);
}

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
      const a = evalConstNumber(e.a);
      // `b` is deliberately not evaluated for && and || — see below.
      const b = (e.op === '&&' || e.op === '||') ? 0 : evalConstNumber(e.b);
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
        /*
         * Comparisons and the logical operators are constant expressions in C, and leaving them out
         * meant a static initialised with something as ordinary as `0 == 1` was refused. SQLite's
         * amalgamation has one; so, it turns out, do a number of the torture programs.
         */
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        // Short-circuit for real: the unevaluated side may not be constant at all, and C does not
        // require it to be.
        case '&&': return a !== 0 && evalConstNumber(e.b) !== 0 ? 1 : 0;
        case '||': return a !== 0 || evalConstNumber(e.b) !== 0 ? 1 : 0;
      }
      break;
    }
    // Also short-circuiting: only the taken branch has to be a constant.
    case 'cond':
      return evalConstNumber(e.cond) !== 0
        ? evalConstNumber(e.then ?? e.cond)
        : evalConstNumber(e.els);
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

/**
 * Walk a designator chain PAST its first element.
 *
 * `.default_value.ival = 1` names a field of a field, and only the first designator was ever read --
 * so the value was written at the right offset with the OUTER member's type, which for PuTTY's
 * `ConfKeyInfo` is a union and stopped the build. C99 6.7.8p6 makes the chain arbitrarily long and
 * lets it mix the two forms, `.a[2].b`, so this walks whatever is there and returns where it lands.
 *
 * The caller keeps the FIRST-level field for its own bookkeeping: an item after a designated one
 * continues from the member following that outermost one, not from wherever the chain ended.
 */
function descendDesignators(field, rest) {
  let off = field.offset, type = field.type, f = field;
  for (const d of rest) {
    if (d.field !== undefined && d.field !== null) {
      if (!T.isRecord(type)) unsup(`a field designator '.${d.field}' on ${T.typeName(type)}`);
      const g = findField(type, d.field);
      if (!g) unsup(`no field '${d.field}' in ${T.typeName(type)}`);
      off += g.offset; type = g.type; f = g;
    } else if (d.index !== undefined && d.index !== null) {
      if (type.k !== 'array') unsup(`an array designator on ${T.typeName(type)}`);
      off += d.index * type.of.size; type = type.of; f = { ...type, bits: undefined, name: f.name };
    }
  }
  /*
   * The FIELD comes back, not a summary of it. Returning {off, type, bits, name} instead dropped
   * bitOffset, width and signedness, so every designated bitfield initialiser wrote zero -- and the
   * c-testsuite does not cover that shape, so only PuTTY's conf table noticed.
   */
  return { off, type, field: f };
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
