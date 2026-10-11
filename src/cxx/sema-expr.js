// sema-expr.js — expressions: names, conversions, overload resolution, calls, operators, temporaries.
//
// An expression lowers to E = { c, t, lv }: its C text, its type (never a reference: an expression of
// reference type is an lvalue of what it refers to), and whether it is an lvalue. Extra marks:
//   addr   the C text of a pointer to it, when it was made by dereferencing one (so &*p is p)
//   zero   it is a literal 0, a null pointer constant
//   str    it is a string literal (which converts to char * as well as const char *)
//   known  its dynamic type is its static type (a named object, not something reached by pointer)
//
// A conversion is found before it is written: { rank, gen }. Overload resolution compares ranks and
// only the winner's gen() runs, so losing candidates leave no temporaries behind.
//
// Ranks follow the standard's order: 0 exact (a little more for adding const), 1 promotion,
// 2 conversion, 3 user-defined (plus a tenth of its second standard conversion), 4 ellipsis.

import * as T from './types.js';

const EXACT = 0, QUAL = 0.01, PROMO = 1, CONV = 2, USER = 3, ELLIPSIS = 4;
const CMP = new Set(['==', '!=', '<', '>', '<=', '>=']);

export const exprMethods = {
  // ---------------------------------------------------------------- C spelling of types
  /** The C declaration of `name` with type t, having made sure the structs it needs are declared. */
  ct(t, name = '') { this.needType(t, true); return T.cDecl(this.abiType(t), name); },
  /**
   * The type as C has to spell it: a function that returns a pinned class takes the hidden result
   * pointer first (after the object, for a member) and returns nothing; one it takes by value comes
   * by address. A function's own signature is written this way (signature), and so must every
   * pointer to one -- 0.6.1's plugins keep a `List<DetectedGame> (*)(const FSList &)`.
   */
  abiType(t) {
    switch (t.k) {
      case 'ptr': { const to = this.abiType(t.to); return to === t.to ? t : { ...t, to }; }
      case 'ref': { const to = this.abiType(t.to); return to === t.to ? t : { ...t, to }; }
      case 'array': { const of = this.abiType(t.of); return of === t.of ? t : { ...t, of }; }
      case 'memptr': { const to = this.abiType(t.to); return to === t.to ? t : { ...t, to }; }
      case 'func': {
        const sret = this.pinnedType(t.ret);
        if (!sret && !t.params.some((p) => this.pinnedType(p))) return t;
        return { ...t, ret: sret ? T.VOID : t.ret, params: [...(sret ? [T.ptr(T.uncst(t.ret))] : []), ...t.params.map((p) => this.cParamType(p))] };
      }
      default: return t;
    }
  },
  needType(t, byValue) {
    switch (t.k) {
      case 'class': if (byValue) this.needStruct(t.cls); else this.forward(t.cls); break;
      case 'ptr': case 'ref': this.needType(t.to, false); break;
      case 'memptr': this.forward(t.cls); this.needType(t.to, false); break;
      // C has no array of an incomplete type, not even behind a pointer: Area (*)[N] needs Area's
      // definition, or its rows are 0 bytes apart (Queen's Grid::_area).
      case 'array': this.needType(t.of, true); break;
      case 'func': this.needType(t.ret, t.ret.k === 'class'); for (const p of t.params) this.needType(p, p.k === 'class'); break;
      default:
    }
  },
  forward(cls) {
    if (this.fwdDone.has(cls)) return;
    this.fwdDone.add(cls);
    this.out.fwd.push(`${cls.key === 'union' ? 'union' : 'struct'} ${cls.cname};`);
  },
  needStruct(cls) {
    if (this.structsDone.has(cls)) return;
    this.complete(cls, cls.node);
    this.structsDone.add(cls);
    this.forward(cls);
    const lines = [];
    // The table pointer first, then the primary base, then the other bases in order: the class and
    // its primary chain share one address, which is what a table's offset to the top relies on.
    if (cls.ownVptr) lines.push('  void **__vptr;');
    const order = cls.bases.map((_, i) => i);
    if (cls.primaryBase > 0) order.splice(order.indexOf(cls.primaryBase), 1), order.unshift(cls.primaryBase);
    for (const i of order) {
      const b = cls.bases[i];
      if (cls.virt[i]) { this.forward(b); lines.push(`  struct ${b.cname} *__vp${i};`); continue; }
      this.needStruct(b);
      lines.push(`  struct ${this.partName(b)} __b${i};`);
    }
    for (const f of cls.fields) lines.push(`  ${this.ct(f.type.k === 'ref' ? T.ptr(f.type.to) : f.type, f.cname)}${f.bits != null ? ` : ${f.bits}` : ''};`);
    // An empty class has size 1 in C++ and no spelling in C.
    if (!lines.length) lines.push('  char __empty;');
    const key = cls.key === 'union' ? 'union' : 'struct';
    // With virtual bases, two structs: the part a derived class embeds, and the complete object --
    // the same members first, so a pointer to either reads them at the same offsets, then each
    // virtual base once.
    // A class defined under `#pragma pack(n)` is laid out under it here too, wherever its struct lands.
    const pk = cls.node?.pack;
    const packed = (text) => (pk ? `#pragma pack(push, ${pk})\n${text}\n#pragma pack(pop)` : text);
    if (cls.vbases.length) {
      this.out.types.push(packed(`${key} ${cls.cname}__p {\n${lines.join('\n')}\n};`));
      cls.vbases.forEach((v, k) => { this.needStruct(v); lines.push(`  struct ${this.partName(v)} __vb${k};`); });
    }
    this.out.types.push(packed(`${key} ${cls.cname} {\n${lines.join('\n')}\n};`));
  },

  // ---------------------------------------------------------------- special members
  isClassy(t) { while (t.k === 'array') t = t.of; return t.k === 'class' ? t.cls : null; },
  needsCtor(cls) {
    this.complete(cls, cls.node);
    return cls.ctors.length > 0 || cls.ctorTemplates?.length > 0 || cls.hasVptr || cls.vbases.length > 0 || cls.bases.some((b) => this.needsCtor(b))
      || cls.fields.some((f) => { const c = this.isClassy(f.type); return c && this.needsCtor(c); });
  },
  needsDtor(cls) {
    this.complete(cls, cls.node);
    return !!cls.dtor || cls.bases.some((b) => this.needsDtor(b))
      || cls.fields.some((f) => { const c = this.isClassy(f.type); return c && this.needsDtor(c); });
  },
  /**
   * A PINNED class may not be moved by copying its bytes: one with a copy constructor of its own,
   * or with a base or member that has one. ScummVM 0.10.0's Common::String points into itself
   * (`_str == _storage`, its small-string storage), and a String moved like a C struct reads
   * garbage. Such a class is treated as the Itanium ABI treats one with a non-trivial copy
   * constructor: constructed where it will live, returned through a hidden pointer (`__sret`),
   * passed by value through an invisible reference that the caller owns and destroys.
   */
  pinned(cls) {
    if (cls.pinnedMemo !== undefined) return cls.pinnedMemo;
    // Not known yet of a class only declared (a function type may name one by value before its definition).
    if (!cls.complete && !cls.pending) return false;
    this.complete(cls, cls.node);
    cls.pinnedMemo = false;               // a class may hold a pointer to itself; never itself
    return (cls.pinnedMemo = !!this.userCopyCtor(cls) || cls.bases.some((b) => this.pinned(b))
      || cls.fields.some((f) => { const c = this.isClassy(f.type); return !!c && this.pinned(c); }));
  },
  pinnedType(t) { return t?.k === 'class' && this.pinned(t.cls); },
  /** Does f return through a hidden pointer? */
  sret(f) { return !f.isCtor && !f.isDtor && this.pinnedType(f.type.ret); },
  /** A parameter's C type: a pinned class by value is passed by its address. */
  cParamType(p) { return p.k === 'ref' ? T.ptr(p.to) : this.pinnedType(p) ? T.ptr(T.uncst(p)) : p; },
  userCopyCtor(cls) {
    return cls.ctors.find((f) => f.type.params.length >= 1 && f.type.params[0].k === 'ref' && f.type.params[0].to.k === 'class'
      && f.type.params[0].to.cls === cls && f.params.slice(1).every((p) => p.def));
  },
  needsCopy(cls) {
    this.complete(cls, cls.node);
    return !!this.userCopyCtor(cls) || cls.hasVptr || cls.vbases.length > 0 || cls.bases.some((b) => this.needsCopy(b))
      || cls.fields.some((f) => { const c = this.isClassy(f.type); return c && this.needsCopy(c); });
  },
  userAssign(cls) {
    const set = cls.scope.get('operator=');
    return set?.list.find((f) => f.type.params.length === 1 && ((f.type.params[0].k === 'ref' && f.type.params[0].to.k === 'class' && f.type.params[0].to.cls === cls)
      || (f.type.params[0].k === 'class' && f.type.params[0].cls === cls)));
  },
  needsAssign(cls) {
    this.complete(cls, cls.node);
    return !!this.userAssign(cls) || cls.hasVptr || cls.vbases.length > 0 || cls.bases.some((b) => this.needsAssign(b))
      || cls.fields.some((f) => { const c = this.isClassy(f.type); return c && this.needsAssign(c); });
  },
  /** The implicitly declared member of this kind, made once. */
  implicit(cls, kind) {
    const key = `__implicit_${kind}`;
    if (cls[key]) return cls[key];
    const self = { k: 'class', cls };
    const type = kind === 'copy' ? T.func(T.VOID, [T.ref(T.cst(self))]) : kind === 'assign' ? T.func(T.ref(self), [T.ref(T.cst(self))]) : T.func(T.VOID, []);
    const name = kind === 'dtor' ? '<dtor>' : kind === 'assign' ? 'operator=' : '<ctor>';
    const f = {
      k: 'func', name, display: `${cls.name}::<implicit ${kind}>`, cls, type, isStatic: false, isCtor: kind === 'ctor' || kind === 'copy',
      isDtor: kind === 'dtor', inline: true, implicit: kind, params: type.params.map(() => ({ name: '__o', def: null })),
    };
    f.cname = this.mangleName(name, cls, type, null);
    return (cls[key] = f);
  },
  /** The constructor that makes a cls from no arguments; null if that needs no code at all. */
  defaultCtor(cls, node) {
    if (!this.needsCtor(cls)) return null;
    if (!cls.ctors.length) return this.implicit(cls, 'ctor');
    const f = cls.ctors.find((c) => c.params.every((p) => p.def));
    if (!f) this.fail(`${cls.name} has no default constructor`, node);
    return f;
  },
  dtorOf(cls) { return this.needsDtor(cls) ? (cls.dtor ?? this.implicit(cls, 'dtor')) : null; },
  copyCtorOf(cls) { return this.needsCopy(cls) ? (this.userCopyCtor(cls) ?? this.implicit(cls, 'copy')) : null; },

  // ---------------------------------------------------------------- functions in use
  /** Mark a function used: its prototype is written, and its body queued if this unit has it. */
  use(f) {
    if (f.used) {
      /*
       * Used before its body was seen -- `&Logic::fnKillId` in a table above the definition, a
       * destructor in a vtable above `String::~String() {...}` -- and defined since: the body is
       * written now -- and a static or inline one gets its prototype made static to match.
       */
      if (!f.queued && f.body) {
        f.queued = true;
        if ((f.inline || f.fileStatic) && !f.cStatic && f.protoAt !== undefined && !this.isWeak(f)) {
          f.cStatic = true;
          for (let k = 0; k < (this.splits(f) ? 2 : 1); k++) this.out.protos[f.protoAt + k] = `static ${this.out.protos[f.protoAt + k]}`;
        }
        this.queue.push(f);
      }
      return f;
    }
    f.used = true;
    const hasBody = !!f.body || !!f.implicit || (f.cls && this.findTemplateBody(f));
    const weak = this.isWeak(f);
    const stat = hasBody ? (f.inline || f.fileStatic) && !weak : false;
    f.cStatic = stat;
    f.protoAt = this.out.protos.length;
    this.out.protos.push(`${stat ? 'static ' : ''}${this.signature(f)}${weak ? ' __attribute__((weak))' : ''};`);
    // The base-subobject constructor or destructor beside the complete object's (see writeFunction).
    if (this.splits(f)) this.out.protos.push(`${stat ? 'static ' : ''}${this.signature(f, '__base')}${weak ? ' __attribute__((weak))' : ''};`);
    if (hasBody) { f.queued = true; this.queue.push(f); }
    return f;
  },
  /**
   * A class template's member is defined by every unit that sees its body and needed by units that
   * may not: ScummVM's scummvm.cpp destroys a Common::Debugger<ScummDebugger> whose destructor only
   * scumm/debugger.cpp can see. g++ emits each such copy as a weak (COMDAT) symbol and keeps one;
   * so does this -- external, __attribute__((weak)), and the C linker keeps the first.
   */
  isWeak(f) { return (!!f.cls?.template && !f.implicit) || (!!f.fromTemplate && !f.fileStatic); },
  /** A class template's member defined outside the class: found by name and signature for this instance. */
  findTemplateBody(f) {
    if (f.body) return true;
    const cls = f.cls;
    if (!cls?.template) return false;
    for (const it of cls.template.outOfLine) {
      const before = f.body;
      const g = this.outOfLine(it, cls);
      if (g !== f && !before) continue;
      if (f.body) return true;
    }
    return !!f.body;
  },
  signature(f, suffix = '') {
    const ps = [];
    if (f.cls && !f.isStatic) ps.push(this.ct(T.ptr(f.type.thisConst ? T.cst({ k: 'class', cls: f.cls }) : { k: 'class', cls: f.cls }), 'this'));
    // A pinned class comes back through a hidden pointer, after `this`; one passed by value comes by its address.
    if (this.sret(f)) ps.push(this.ct(T.ptr(T.uncst(f.type.ret)), '__sret'));
    f.type.params.forEach((p, i) => ps.push(this.ct(this.cParamType(p), this.paramName(f, i))));
    if (f.type.variadic) ps.push('...');
    const ret = this.sret(f) ? T.VOID : f.type.ret.k === 'ref' ? T.ptr(f.type.ret.to) : f.type.ret;
    return this.ct(ret, `${f.cname}${suffix}(${ps.length ? ps.join(', ') : 'void'})`);
  },
  paramName(f, i) { return f.params[i]?.name ?? `__p${i}`; },

  // ---------------------------------------------------------------- temporaries
  /** A new function-level temporary of type t; its C name. */
  temp(cx, t) {
    // In a constant initialiser there is nowhere to put one: the initialiser is dynamic.
    if (!cx.fn) { cx.dynamic = true; return '__dyn'; }
    const name = `__t${++cx.fn.ntemp}`;
    cx.fn.temps.push(`${this.ct(t, name)};`);
    return name;
  },
  /** A class rvalue, held in a temporary so that it has an address; destroyed at the end of the full expression. */
  materialize(e, cx) {
    if (e.lv || e.addr) return e;
    const name = this.temp(cx, T.uncst(e.t));
    const cls = this.isClassy(e.t);
    if (cls && this.dtorOf(cls)) cx.pending.push({ name, cls });
    return { c: `(*(${name} = ${e.c}, &${name}))`, t: e.t, lv: true, addr: `(${name} = ${e.c}, &${name})`, known: true, temporary: true };
  },
  addrOf(e, cx) {
    if (e.addr) return e.addr;
    if (!e.lv) e = this.materialize(e, cx);
    return e.addr ?? `(&${e.c})`;
  },

  // ---------------------------------------------------------------- names
  /** { ent, path, owner } for a (possibly qualified) name: owner is the class it was found in, if any. */
  lookupName(q, env) {
    const last = q.parts[q.parts.length - 1].name;
    if (q.parts.length > 1) {
      const pre = this.qualified({ parts: q.parts.slice(0, -1), global: q.global }, env);
      if (pre?.k === 'namespace') {
        const ent = pre.ns.scope.find(last);
        return ent ? { ent, path: [], owner: null, qualified: true } : null;
      }
      const ot = this.namedType({ parts: q.parts.slice(0, -1), global: q.global }, env);
      if (ot.k !== 'class') return null;
      this.complete(ot.cls);
      const m = this.memberEntity(ot.cls, last);
      return m ? { ent: m.ent, path: m.path, owner: ot.cls, qualified: true, found: m.cls } : null;
    }
    if (q.global) { const ent = this.global.find(last); return ent ? { ent, path: [], owner: null } : null; }
    // A template's value parameter, bound in an instance: a constant, as an enumerator is.
    const bound = env.bind?.get(last);
    if (bound?.k === 'tvalue') return { ent: { k: 'enumerator', value: bound.value, type: T.INT }, path: [], owner: null };
    for (let s = env.scope; s; s = s.parent) {
      if (s.cls) {
        const m = this.memberEntity(s.cls, last);
        if (m) return { ent: m.ent, path: m.path, owner: s.cls, found: m.cls };
      } else {
        const ent = s.find(last);
        if (ent) return { ent, path: [], owner: null };
      }
    }
    return null;
  },
  thisObject(cx, node) {
    if (!cx.fn?.f.cls || cx.fn.f.isStatic) this.fail('a non-static member used without an object', node);
    const t = { k: 'class', cls: cx.fn.f.cls };
    return { c: '(*this)', t: cx.fn.f.type.thisConst ? T.cst(t) : t, lv: true, addr: 'this' };
  },
  /** A data member of obj (found at `path` of base members, then through anonymous members). */
  fieldOf(obj, ent, path, cx) {
    // Reaching into an object needs its struct defined, even when only a pointer to it was ever declared.
    this.needStruct(obj.t.cls);
    const steps = [...path, ...(ent.via ?? []), ent.cname].join('.');
    const c = obj.addr ? `(${obj.addr})->${steps}` : `(${this.materialize(obj, cx).c}).${steps}`;
    let t = ent.type;
    if (t.k === 'ref') return { c: `(*${c})`, t: t.to, lv: true, addr: c };
    // A mutable member is not const through a const object (String's _refCount, in incRefCount() const).
    if (obj.t.c && t.k !== 'array' && !ent.mutable) t = T.cst(t);
    return { c, t, lv: true, bits: ent.bits != null };
  },
  varExpr(ent, cx) {
    // A const integer with a known value is that value, as g++ folds it -- everywhere: C needs a
    // constant in a static initialiser (`1116 + stereospread`, mt32's freeverb.h), and a class's
    // `static const uint32 _builtinCapacity = 32;` is defined by no unit at all (common/str.h; read as
    // a variable, memcpy copied whatever nothing held). Its address is still the variable's:
    // `doOutput(&newline_character, 1)` (agos's charset.cpp).
    if (ent.constValue !== undefined) return { c: String(ent.constValue), t: T.uncst(ent.type), lv: false, constAddr: { c: `(&${ent.cname})`, t: T.ptr(ent.type), ent } };
    if (ent.global) this.useGlobal(ent);
    if (ent.type.k === 'ref') return { c: `(*${ent.cname})`, t: ent.type.to, lv: true, addr: ent.cname };
    return { c: ent.cname, t: ent.type, lv: true, known: true, constValue: ent.constValue };
  },

  // ---------------------------------------------------------------- conversions
  decay(e) {
    if (e.t.k === 'array') return { ...e, c: e.c, t: T.ptr(e.t.of), lv: false, addr: undefined };
    if (e.t.k === 'func') return { ...e, t: T.ptr(e.t), lv: false, addr: undefined };
    return e;
  },
  /** A standard conversion of e to the non-class, non-reference type V. */
  scalarConv(e, V) {
    // `&C::f` of an overloaded member: the target type picks one (kyra's FileType table of LoadFunc).
    if (e.memberOverload) {
      const f = V.k === 'memptr' ? e.memberOverload.find((g) => T.same(this.memberPointerType(g).to, V.to)) : null;
      return f ? { rank: EXACT, gen: () => this.memberPointer({ funcs: [f] }, e.node).c } : null;
    }
    const from = this.decay(e), F = from.t;
    if (T.same(F, V, { top: false })) return { rank: EXACT, gen: () => from.c };
    if (T.isArith(V) && T.isArith(F)) {
      if (V.k === 'enum') return null;                       // nothing converts implicitly TO an enum
      const promo = T.same(T.promote(F), V, { top: false }) || (F.k === 'prim' && F.name === 'float' && V.name === 'double');
      return { rank: promo ? PROMO : CONV, gen: () => `((${T.cDecl(T.uncst(V))})${from.c})` };
    }
    if (V.k === 'ptr') {
      if (e.zero) return { rank: CONV, gen: () => `((${this.ct(T.uncst(V))})0)` };
      if (F.k !== 'ptr') return null;
      const dropsConst = F.to.c && !V.to.c;
      if (T.same(F.to, V.to, { top: false })) {
        if (dropsConst && !e.str) return null;
        return { rank: dropsConst ? CONV : F.to.c === V.to.c ? EXACT : QUAL, gen: () => (dropsConst ? `((${this.ct(T.uncst(V))})${from.c})` : from.c) };
      }
      if (dropsConst) return null;
      // Several levels: `byte **` to `const byte *const *`, C++'s qualification conversion.
      if (this.qualifiesTo(F.to, V.to)) return { rank: QUAL, gen: () => `((${this.ct(T.uncst(V))})${from.c})` };
      if (V.to.k === 'void' && F.to.k !== 'func') return { rank: CONV, gen: () => `((${this.ct(T.uncst(V))})${from.c})` };
      if (V.to.k === 'class' && F.to.k === 'class') {
        const path = this.derivedPath(F.to.cls, V.to.cls);
        if (path) return { rank: CONV, gen: () => this.upcastPtr(from.c, path, V.to.cls) };
      }
      return null;
    }
    if (V.k === 'prim' && V.name === 'bool' && (F.k === 'ptr' || F.k === 'memptr')) return { rank: CONV, gen: () => `(${from.c} != 0)` };
    if (V.k === 'memptr') {
      if (e.zero) return { rank: CONV, gen: () => `((${this.ct(T.uncst(V))})0)` };
      if (F.k !== 'memptr' || !T.same(F.to, V.to)) return null;
      if (F.cls === V.cls) return { rank: EXACT, gen: () => from.c };
      // A base's member as the derived class's, where the base sits at the derived class's address.
      const path = this.derivedPath(V.cls, F.cls);
      if (path && path.every((p) => p === '__b0')) return { rank: CONV, gen: () => `((${this.ct(T.uncst(V))})${from.c})` };
      return null;
    }
    return null;
  },
  /**
   * C++'s rule for pointees through several levels of pointer (4.4): the same types, const never
   * removed, and wherever it is added every level between there and the top const too -- so that
   * `char **` cannot become `const char **`, through which a const char could be stored in a char *.
   */
  qualifiesTo(f, v) {
    let allConst = true;
    for (;;) {
      if (f.c && !v.c) return false;
      if (v.c && !f.c && !allConst) return false;
      allConst = allConst && !!v.c;
      if (f.k !== v.k) return false;
      if (f.k !== 'ptr') return T.same(T.uncst(f), T.uncst(v));
      f = f.to; v = v.to;
    }
  },
  /** The path from class d to its base b ([] when they are one class); an incomplete class has no bases. */
  derivedPath(d, b) {
    if (d === b) return [];
    if (!d.complete && !d.pending) return null;
    return this.basePath(this.complete(d), b);
  },
  /** A pointer to a class, as a pointer to the base reached by `path`. */
  upcastPtr(c, path, base) {
    if (!path.length) return c;
    if (path.every((p) => p === '__b0')) return `((struct ${base.cname} *)${c})`;
    // A base that is not first sits at an offset; a null pointer stays null. The pointer is read
    // twice, so anything but a plain name is read once into a local first: `new File` converted to
    // a second or virtual base made two objects when the expression was written out twice.
    if (/^\(*&?\(*[A-Za-z_]\w*\)*((->|\.)[A-Za-z_]\w*(\[0\])?\)*)*$/.test(c)) return `(${c} ? &(${c})->${path.join('.')} : (struct ${base.cname} *)0)`;
    const u = `__up${++this.anon}`;
    return `({ __typeof__(${c}) ${u} = (${c}); ${u} ? &${u}->${path.join('.')} : (struct ${base.cname} *)0; })`;
  },
  /** A copy of the class value e (of class cls or derived from it), as a C rvalue of struct cls. */
  copyOf(e, cls, cx) {
    const self = { k: 'class', cls };
    const path = this.basePath(e.t.cls, cls);
    const cc = this.copyCtorOf(cls);
    if (this.pinned(cls)) {
      // Never moved by its bytes: a temporary of the class is the object itself, left to die at the
      // end of the full expression; anything else is copied into a temporary of the caller's.
      if (e.temporary && e.tempName && !path.length) return e.c;
      this.use(cc);
      const name = this.temp(cx, self);
      if (this.dtorOf(cls)) cx.pending.push({ name, cls });
      return `(*(${cc.cname}(&${name}, ${[this.upcastPtr(this.addrOf(e, cx), path, cls), ...this.defaultArgs(cc, 1, cx)].join(', ')}), &${name}))`;
    }
    if (!e.lv && !e.addr && !path.length) return e.c;                // a temporary is moved, not copied
    if (e.temporary && e.tempName && !path.length) {
      // The temporary a constructor just made IS the object it initialises: handed over, so not
      // destroyed as a temporary.
      const i = cx.pending.findIndex((p) => p.name === e.tempName);
      if (i >= 0) cx.pending.splice(i, 1);
      return e.c;
    }
    if (!cc) return path.length ? `(${this.fieldPath(e, path, cx)})` : e.c;
    this.use(cc);
    const name = this.temp(cx, self);
    const src = this.upcastPtr(this.addrOf(e, cx), path, cls);
    const extra = this.defaultArgs(cc, 1, cx);
    return `(${cc.cname}(&${name}, ${[src, ...extra].join(', ')}), ${name})`;
  },
  fieldPath(e, path, cx) { return e.addr ? `(${e.addr})->${path.join('.')}` : `(${this.materialize(e, cx).c}).${path.join('.')}`; },

  /**
   * The implicit conversion of e to `to`, or null. `user` allows one user-defined conversion (a
   * converting constructor or a conversion function); `explicit` allows explicit constructors too.
   */
  convert(e, to, cx, { user = true, explicit = false } = {}) {
    if (to.k === 'ref') {
      const U = to.to;
      const direct = e.lv || e.addr || (e.t.k === 'class' && U.c);
      if (direct && (e.t.k === 'class') === (U.k === 'class')) {
        if (U.k === 'class' && e.t.k === 'class') {
          const path = this.derivedPath(e.t.cls, U.cls);
          if (path && !(e.t.c && !U.c)) {
            // A temporary binds to a reference to const only.
            if ((e.lv || e.addr) || U.c) {
              return { rank: (path.length ? CONV : EXACT) + (U.c && !e.t.c ? QUAL : 0), gen: () => this.upcastPtr(this.addrOf(e, cx), path, U.cls) };
            }
          }
        } else if ((e.lv || e.addr) && T.same(e.t, U, { top: false }) && !(e.t.c && !U.c) && e.t.k !== 'array') {
          return { rank: EXACT + (U.c && !e.t.c ? QUAL : 0), gen: () => this.addrOf(e, cx) };
        } else if ((e.lv || e.addr) && e.t.k === 'array' && U.k === 'array' && T.same(e.t.of, U.of, { top: false })) {
          return { rank: EXACT, gen: () => `(&${e.c})` };
        }
      }
      if (!U.c) return null;
      // A reference to const binds to a temporary made from the converted value.
      const v = this.convert(e, T.uncst(U), cx, { user, explicit });
      if (!v) return null;
      // A pinned class's conversion already leaves an object in a temporary of its own (construct,
      // copyOf): the reference is to that object, not to a byte copy of it.
      if (this.pinnedType(T.uncst(U))) return { rank: v.rank, gen: () => `(&${v.gen()})` };
      return { rank: v.rank, gen: () => { const name = this.temp(cx, T.uncst(U)); const cls = this.isClassy(U); if (cls && this.dtorOf(cls)) cx.pending.push({ name, cls }); return `(${name} = ${v.gen()}, &${name})`; } };
    }
    const V = T.uncst(to);
    if (V.k === 'class') {
      if (!V.cls.complete && !V.cls.pending) return null;
      this.complete(V.cls);
      if (e.t.k === 'class') {
        const path = this.derivedPath(e.t.cls, V.cls);
        if (path) return { rank: path.length ? CONV : EXACT, gen: () => this.copyOf(e, V.cls, cx) };
      }
      if (!user) return null;
      return this.userConv(e, V, cx, explicit);
    }
    if (e.t.k === 'class') return user ? this.userConv(e, V, cx, explicit) : null;
    if (V.k === 'array' || V.k === 'func' || V.k === 'void') return null;
    return this.scalarConv(e, V);
  },
  /** One user-defined conversion from e to V: a constructor of V, or a conversion function of e's class. */
  userConv(e, V, cx, explicit) {
    const found = [];
    if (V.k === 'class') {
      for (const f of V.cls.ctors) {
        if (f.explicit && !explicit) continue;
        if (f.type.params.length < 1 || !f.params.slice(1).every((p) => p.def)) continue;
        // Not the copy constructor: that is not a conversion.
        const p0 = f.type.params[0];
        if ((p0.k === 'ref' ? p0.to : p0).k === 'class' && (p0.k === 'ref' ? p0.to : p0).cls === V.cls) continue;
        const a = this.convert(e, p0, cx, { user: false });
        if (a) found.push({ rank: USER + a.rank / 10, f, gen: () => this.construct(V.cls, f, [a.gen(), ...this.defaultArgs(f, 1, cx)], cx) });
      }
    }
    if (e.t.k === 'class' && (e.t.cls.complete || e.t.cls.pending)) {
      this.complete(e.t.cls);
      for (const f of this.allConversions(e.t.cls)) {
        if (e.t.c && !f.type.thisConst) continue;
        const res = f.conv.k === 'ref' ? { t: f.conv.to, lv: true } : { t: f.conv, lv: false };
        const call = () => this.callMember(f, e, [], cx);
        // The second standard conversion is ranked on the function's result type.
        const b = V.k === 'class'
          ? (res.t.k === 'class' && this.basePath(res.t.cls, V.cls) ? { rank: EXACT } : null)
          : this.scalarConv({ c: '', t: res.t, lv: res.lv }, V);
        if (!b) continue;
        found.push({
          rank: USER + b.rank / 10 + (f.type.thisConst && !e.t.c ? QUAL : 0), f,
          gen: () => { const r = call(); return V.k === 'class' ? this.copyOf(r, V.cls, cx) : this.scalarConv(r, V).gen(); },
        });
      }
    }
    if (!found.length) return null;
    found.sort((a, b) => a.rank - b.rank);
    if (found.length > 1 && found[0].rank === found[1].rank && found[0].f !== found[1].f) {
      // An AMBIGUOUS conversion still ranks as a user-defined one (13.3.3.1/10): it is an error only
      // if the candidate needing it wins. `registerDefault("cdrom", 0)` takes the int overload,
      // whatever 0 might become as a String.
      const [a, b] = found;
      return { rank: a.rank, f: a.f, gen: () => this.fail(`ambiguous conversion from ${T.show(e.t)} to ${T.show(V)}: ${a.f.display} or ${b.f.display}`, cx.node) };
    }
    return found[0];
  },
  /** The namespace (or file) scope a class was declared in. */
  homeScope(cls) {
    let s = cls.scope.parent;
    while (s.cls && s.parent) s = s.parent;
    return s;
  },
  allConversions(cls) { return [...cls.convs, ...cls.bases.flatMap((b) => this.allConversions(b))]; },
  /** e converted to `to`, or an error naming both types. */
  coerce(e, to, cx, node, what = 'conversion') {
    const v = this.convert(e, to, cx);
    if (!v) this.fail(`no ${what} from ${T.show(e.t)} to ${T.show(to)}`, node ?? cx.node);
    return v.gen();
  },
  /** e as a condition: a scalar, a class having been converted by its conversion function. */
  condition(e, cx, node) {
    if (e.t.k === 'class') {
      const v = this.userConv(e, T.BOOL, cx, false);
      if (!v) this.fail(`${T.show(e.t)} is not a condition`, node);
      return v.gen();
    }
    return this.decay(e).c;
  },

  // ---------------------------------------------------------------- overload resolution
  /**
   * The best of `cands` for these arguments. obj is the object of a member call (null for a free
   * function); a candidate that is a static member ignores it. Returns { f, convs } or null when
   * none is viable; an ambiguity is an error.
   */
  resolve(cands, args, obj, cx, node, what) {
    const viable = [];
    for (const f of cands) {
      const P = f.type.params;
      if (args.length > P.length && !f.type.variadic) continue;
      if (args.length < P.length && !f.params.slice(args.length).every((p) => p.def)) continue;
      const ranks = [], convs = [];
      let ok = true;
      if (obj && f.cls && !f.isStatic && !f.isCtor) {
        if (obj.t.c && !f.type.thisConst) continue;
        ranks.push(f.type.thisConst && !obj.t.c ? QUAL : EXACT);
      } else ranks.push(EXACT);
      for (let i = 0; i < args.length; i++) {
        if (i >= P.length) { ranks.push(ELLIPSIS); convs.push({ gen: () => this.variadicArg(args[i], cx) }); continue; }
        const v = this.convert(args[i], P[i], cx);
        if (!v) { ok = false; break; }
        ranks.push(v.rank); convs.push(v);
      }
      if (ok) viable.push({ f, ranks, convs });
    }
    if (!viable.length) return null;
    const better = (a, b) => a.ranks.every((r, i) => r <= b.ranks[i]) && a.ranks.some((r, i) => r < b.ranks[i]);
    const best = viable.filter((a) => viable.every((b) => b === a || better(a, b) || (!better(b, a) && a === viable.find((x) => !viable.some((y) => better(y, x))))));
    let winners = viable.filter((a) => !viable.some((b) => b !== a && better(b, a)));
    // Between a plain function and a template's instance that convert as well, the plain one.
    if (winners.length > 1 && winners.some((w) => !w.f.fromTemplate)) winners = winners.filter((w) => !w.f.fromTemplate);
    // Between instances of two templates, the more specialised template's (partial ordering):
    // touche's saveOrLoadCommonArray(Common::WriteStream &, A &) over its (S &, A &).
    if (winners.length > 1 && winners.every((w) => w.f.ft)) {
      const less = (w) => winners.some((o) => o !== w && this.atLeastAsSpecialised(o.f.ft, w.f.ft) && !this.atLeastAsSpecialised(w.f.ft, o.f.ft));
      const kept = winners.filter((w) => !less(w));
      if (kept.length) winners = kept;
    }
    if (winners.length !== 1) {
      // Two declarations of one function (a member seen through two paths) are not an ambiguity.
      const distinct = [...new Set(winners.map((w) => w.f))];
      if (distinct.length !== 1) this.fail(`ambiguous ${what}: ${distinct.map((f) => `${f.display}(${f.type.params.map(T.show).join(', ')})`).join(' or ')}`, node);
    }
    void best;
    return winners[0];
  },
  /**
   * Is function template a at least as specialised as b (14.5.5.2)? a's parameter types, its own
   * template parameters replaced by types made up for the purpose, are taken as arguments: b's
   * parameters must deduce from them and then be exactly those types.
   */
  atLeastAsSpecialised(a, b) {
    const fdOf = (ft) => ft.ast.decl.derivs[ft.ast.decl.derivs.length - 1];
    const fa = fdOf(a), fb = fdOf(b);
    if (fa.params.length !== fb.params.length) return false;
    const envOf = (ft, bind) => ({ scope: ft.member ? ft.member.cls.scope : ft.env.scope, cls: ft.member?.cls ?? ft.env.cls ?? null, bind: new Map([...(ft.env.bind ?? []), ...bind]) });
    const synth = a.params.map((p, i) => [p.name, p.value ? { k: 'tvalue', value: `__synth${i}` } : { k: 'prim', name: `__synth${i}` }]);
    const strip = (t) => (t.k === 'ref' ? t.to : t);
    try {
      const argTs = fa.params.map((p) => strip(this.declType(p.specs, p.decl.derivs, envOf(a, synth), a.ast)));
      const bind = new Map();
      const names = b.params.map((p) => p.name);
      if (!fb.params.every((p, i) => this.deduceOne(p.specs, p.decl.derivs, argTs[i], bind, names))) return false;
      if (!b.params.every((p) => bind.has(p.name))) return false;
      return fb.params.every((p, i) => T.same(T.uncst(strip(this.declType(p.specs, p.decl.derivs, envOf(b, bind), b.ast))), T.uncst(argTs[i])));
    } catch { return false; }
  },
  variadicArg(e, cx) {
    if (e.t.k === 'class') return this.materialize(e, cx).c;
    return this.decay(e).c;
  },
  /** The default arguments of f from parameter `from` on, lowered in the scope they were written in. */
  defaultArgs(f, from, cx) {
    const out = [];
    for (let i = from; i < f.type.params.length; i++) {
      const p = f.params[i];
      if (!p?.def) this.fail(`${f.display}: no default for argument ${i + 1}`, cx.node);
      const dcx = { ...cx, env: p.env ?? f.bodyEnv ?? { scope: this.global, cls: f.cls, bind: f.cls?.bind ?? null } };
      out.push(this.coerce(this.expr(p.def, dcx), f.type.params[i], cx, cx.node, 'default argument'));
    }
    return out;
  },
  /** The result of calling f with these C arguments (and this C `this`), as an expression. */
  callResult(f, thisC, cArgs, cx, { direct = true, objC = null } = {}) {
    this.use(f);
    if (cx.constOnly) cx.dynamic = true;
    // A pinned class by value goes by its address: the argument is the caller's own object (a
    // temporary it made, or the one copied for the call), destroyed by the caller at the end of
    // the full expression.
    cArgs = cArgs.map((a, i) => (i < f.type.params.length && this.pinnedType(f.type.params[i]) ? `(&${a})` : a));
    // A pinned result is built in a temporary of the caller's, whose address the callee is given.
    let sretTemp = null;
    if (this.sret(f)) {
      const R = T.uncst(f.type.ret);
      sretTemp = this.temp(cx, R);
      if (this.dtorOf(R.cls)) cx.pending.push({ name: sretTemp, cls: R.cls });
      cArgs = [`&${sretTemp}`, ...cArgs];
    }
    const all = thisC ? [thisC, ...cArgs] : cArgs;
    let call;
    if (!direct && f.isVirtual) {
      // Through the object's table. The object pointer is used twice, so it is held in a temporary
      // unless it is a plain name.
      let p = thisC;
      let pre = '';
      if (!/^[A-Za-z_]\w*$/.test(p)) { const name = this.temp(cx, T.ptr({ k: 'class', cls: f.cls })); pre = `${name} = ${p}, `; p = name; }
      const root = this.vtableOwnerPath(f.cls);
      // Reaching the table needs the struct, even where only a pointer to the class was declared.
      this.needStruct(f.cls);
      const fnType = this.fnPtrType(f);
      call = `(${pre}((${fnType})(${p})->${[...root, '__vptr'].join('.')}[${f.vindex}])(${[p, ...cArgs].join(', ')}))`;
    } else call = `${f.cname}(${all.join(', ')})`;
    const r = f.type.ret;
    if (r.k === 'ref') return { c: `(*${call})`, t: r.to, lv: true, addr: call };
    if (sretTemp) { const addr = `(${call}, &${sretTemp})`; return { c: `(*${addr})`, t: r, lv: false, addr, known: true, temporary: true, tempName: sretTemp }; }
    return { c: call, t: r, lv: false };
  },
  vtableOwnerPath(cls) { return this.vptrPath(cls); },
  fnPtrType(f) {
    const ps = [this.ct(T.ptr({ k: 'class', cls: f.cls }))];
    if (this.sret(f)) ps.push(this.ct(T.ptr(T.uncst(f.type.ret))));
    for (const p of f.type.params) ps.push(this.ct(this.cParamType(p)));
    if (f.type.variadic) ps.push('...');
    const ret = this.sret(f) ? T.VOID : f.type.ret.k === 'ref' ? T.ptr(f.type.ret.to) : f.type.ret;
    return this.ct(ret, `(*)(${ps.join(', ')})`);
  },
  /** Call the member f on obj with already-lowered arguments. */
  callMember(f, obj, args, cx, { qualified = false, node = null } = {}) {
    const r = this.resolve([f], args, obj, cx, node, f.display);
    if (!r) this.fail(`${f.display} cannot be called with (${args.map((a) => T.show(a.t)).join(', ')})`, node ?? cx.node);
    return this.finishMemberCall(r, obj, args, cx, qualified);
  },
  finishMemberCall(r, obj, args, cx, qualified) {
    const f = r.f;
    const cArgs = [...r.convs.map((v) => v.gen()), ...this.defaultArgs(f, args.length, cx).slice(0, Math.max(0, f.type.params.length - args.length))];
    if (f.isStatic) return this.callResult(f, null, cArgs, cx);
    const ocls = obj.t.cls;
    const path = this.basePath(ocls, f.cls);
    const thisC = this.upcastPtr(this.addrOf(obj, cx), path, f.cls);
    return this.callResult(f, thisC, cArgs, cx, { direct: !!(qualified || obj.known) });
  },
  /** A cls made by constructor f from C arguments: an rvalue. */
  construct(cls, f, cArgs, cx) {
    const self = { k: 'class', cls };
    const name = this.temp(cx, self);
    if (!f) return `(${name})`;
    this.use(f);
    if (cx.constOnly) cx.dynamic = true;
    // A pinned one stays in its temporary, as an lvalue the caller may take the address of, and dies
    // with the full expression.
    if (this.pinned(cls)) {
      if (this.dtorOf(cls)) cx.pending.push({ name, cls });
      return `(*(${f.cname}(${[`&${name}`, ...cArgs].join(', ')}), &${name}))`;
    }
    return `(${f.cname}(${[`&${name}`, ...cArgs].join(', ')}), ${name})`;
  },
  /**
   * The statement that makes an object of cls at the lvalue `dest` from constructor arguments --
   * the one place a pinned object is built where it will live. An argument that is itself a
   * temporary of cls was built in a temporary of this function: that temporary's name is rewritten
   * to dest, so it is built there instead (the elision C++ does), and it no longer dies with the
   * full expression.
   */
  constructAt(dest, cls, args, cx, node) {
    const a = args.length === 1 ? args[0] : null;
    if (a && this.pinned(cls) && a.temporary && a.tempName && a.t.k === 'class' && a.t.cls === cls) {
      const i = cx.pending.findIndex((p) => p.name === a.tempName);
      if (i >= 0) cx.pending.splice(i, 1);
      return `(void)${a.c.replace(new RegExp(`\\b${a.tempName}\\b`, 'g'), dest)};`;
    }
    const pick = this.pickCtor(cls, args, cx, node);
    if (pick.copy) {
      const cc = this.copyCtorOf(cls);
      if (!cc) return `${dest} = ${this.copyOf(pick.copy, cls, cx)};`;
      this.use(cc);
      const path = this.basePath(pick.copy.t.cls, cls);
      return `${cc.cname}(${[`&${dest}`, this.upcastPtr(this.addrOf(pick.copy, cx), path, cls), ...this.defaultArgs(cc, 1, cx)].join(', ')});`;
    }
    if (!pick.f) return '';
    this.use(pick.f);
    if (cx.constOnly) cx.dynamic = true;
    return `${pick.f.cname}(${[`&${dest}`, ...pick.cArgs].join(', ')});`;
  },
  /** The constructor of cls for these arguments and its converted arguments. */
  pickCtor(cls, args, cx, node) {
    this.complete(cls, node);
    // A constructor template competes through the instance its arguments deduce (infogrames' Instruments(T)).
    if (cls.ctorTemplates?.length) {
      const insts = cls.ctorTemplates.map((ft) => this.deduce(ft, [], args, cx.env, node)).filter(Boolean);
      const r = this.resolve([...cls.ctors, ...insts], args, null, cx, node, `constructor of ${cls.name}`);
      if (!r) this.fail(`${cls.name} has no constructor taking (${args.map((a) => T.show(a.t)).join(', ')})`, node);
      return { f: r.f, cArgs: [...r.convs.map((v) => v.gen()), ...this.defaultArgs(r.f, args.length, cx)] };
    }
    if (!cls.ctors.length) {
      if (!args.length) return { f: this.defaultCtor(cls, node), cArgs: [] };
      if (args.length === 1 && args[0].t.k === 'class' && this.basePath(args[0].t.cls, cls)) return { copy: args[0] };
      this.fail(`${cls.name} has no constructor taking (${args.map((a) => T.show(a.t)).join(', ')})`, node);
    }
    // The implicit copy constructor is a candidate when no user one is declared.
    if (args.length === 1 && args[0].t.k === 'class' && this.basePath(args[0].t.cls, cls) && !this.userCopyCtor(cls)) {
      const viaUser = this.resolve(cls.ctors, args, null, cx, node, `constructor of ${cls.name}`);
      if (!viaUser || viaUser.ranks.some((r) => r >= USER)) return { copy: args[0] };
    }
    const r = this.resolve(cls.ctors, args, null, cx, node, `constructor of ${cls.name}`);
    if (!r) this.fail(`${cls.name} has no constructor taking (${args.map((a) => T.show(a.t)).join(', ')})`, node);
    return { f: r.f, cArgs: [...r.convs.map((v) => v.gen()), ...this.defaultArgs(r.f, args.length, cx)] };
  },

  // ---------------------------------------------------------------- operators
  /** The functions `name` names in the namespaces of the arguments' classes (pointed or referred to too), as a callee; or null. */
  adlLookup(name, args) {
    const list = [];
    const templates = [];
    for (const a of args) {
      let t = a.t;
      while (t.k === 'ptr' || t.k === 'ref') t = t.to;
      if (t.k !== 'class') continue;
      const e = this.homeScope(t.cls).find(name);
      if (e?.k !== 'funcs') continue;
      for (const f of e.list) if (!list.includes(f)) list.push(f);
      for (const ft of e.templates ?? []) if (!templates.includes(ft)) templates.push(ft);
    }
    if (!list.length && !templates.length) return null;
    return { funcs: list, ...(templates.length ? { templates, targs: null } : {}), t: T.VOID, c: '', lv: false };
  },
  /** A user-defined operator for these operands, called; null when there is none. */
  overloaded(op, operands, cx, node, extra = []) {
    if (!operands.some((o) => o.t.k === 'class' || o.t.k === 'enum')) return null;
    const name = `operator${op}`;
    const cands = [];
    const first = operands[0];
    if (first.t.k === 'class') {
      this.complete(first.t.cls);
      const m = this.memberEntity(first.t.cls, name);
      if (m?.ent.k === 'funcs') for (const f of m.ent.list) cands.push({ f, member: true });
    }
    // Non-members: by ordinary lookup from here, and in the namespace of each class operand (the
    // argument-dependent lookup that finds Common::operator+ from inside Sky).
    const seen = new Set(cands.map((c) => c.f));
    const add = (e) => { if (e?.k === 'funcs') for (const f of e.list) if (!seen.has(f)) { seen.add(f); cands.push({ f, member: false }); } };
    for (let s = cx.env.scope; s; s = s.parent) if (!s.cls) { const e = s.find(name); if (e) { add(e); break; } }
    for (const o of operands) if (o.t.k === 'class') add(this.homeScope(o.t.cls).find(name));
    add(this.global.find(name));
    if (!cands.length) return null;
    // Members take the first operand as their object; the others take every operand as an argument.
    const viable = [];
    for (const c of cands) {
      const args = c.member ? [...operands.slice(1), ...extra] : [...operands, ...extra];
      const r = this.resolve([c.f], args, c.member ? first : null, cx, node, name);
      if (r) viable.push({ ...r, member: c.member, args, ranks: c.member ? r.ranks : [r.ranks[1] ?? EXACT, ...r.ranks.slice(2)].concat([]) , full: r.ranks });
    }
    if (!viable.length) return null;
    // Compare on the operands in order: a member's object rank stands for its first operand.
    const key = (v) => (v.member ? v.full : v.full.slice(1));
    const better = (a, b) => key(a).every((r, i) => r <= (key(b)[i] ?? 0)) && key(a).some((r, i) => r < (key(b)[i] ?? 0));
    const winners = viable.filter((a) => !viable.some((b) => b !== a && better(b, a)));
    if (winners.length !== 1 && new Set(winners.map((w) => w.f)).size !== 1) {
      this.fail(`ambiguous ${name}: ${winners.map((w) => `${w.f.display}(${w.f.type.params.map(T.show).join(', ')})`).join(' or ')}`, node);
    }
    const w = winners[0];
    if (w.member) return this.finishMemberCall(w, first, w.args, cx, false);
    return this.callResult(w.f, null, [...w.convs.map((v) => v.gen()), ...this.defaultArgs(w.f, w.args.length, cx)], cx);
  },
  /** A class operand of a built-in operator, converted by its one conversion function to a scalar. */
  builtinOperand(e, cx, node) {
    if (e.t.k !== 'class') return this.decay(e);
    const fs = this.allConversions(this.complete(e.t.cls)).filter((f) => !(e.t.c && !f.type.thisConst));
    const pick = fs.filter((f) => !!f.type.thisConst === !!e.t.c);
    const use = pick.length ? pick : fs;
    const targets = new Set(use.map((f) => T.mangle(T.uncst(f.conv.k === 'ref' ? f.conv.to : f.conv))));
    if (!use.length) this.fail(`no operator for ${T.show(e.t)} here`, node);
    if (targets.size > 1) this.fail(`ambiguous conversion of ${T.show(e.t)} for a built-in operator`, node);
    return this.decay(this.callMember(use[0], e, [], cx));
  },

  // ---------------------------------------------------------------- expressions
  expr(n, cx) {
    const saved = cx.node;
    cx.node = n;
    try { return this.expr1(n, cx); } finally { cx.node = saved; }
  },
  expr1(n, cx) {
    switch (n.k) {
      case 'num': {
        const v = this.parseNumber(n.v);
        return { c: n.v, t: v.type, lv: false, zero: !T.isFloat(v.type) && v.value === 0 };
      }
      case 'chr': return { c: n.v, t: /^L/.test(n.v) ? T.INT : T.CHAR, lv: false };
      // `false` is an integral constant 0, so a null pointer constant in C++98: `if (_fd == false)` (animation_he.cpp).
      case 'bool': return { c: n.v ? '1' : '0', t: T.BOOL, lv: false, zero: !n.v };
      case 'str': return { c: n.parts.join(' '), t: T.array(T.cst(T.CHAR), this.stringLength(n) + 1), lv: true, str: true };
      case 'paren': { const e = this.expr(n.e, cx); return { ...e, c: `(${e.c})` }; }
      case 'this': { const o = this.thisObject(cx, n); return { c: 'this', t: T.ptr(o.t), lv: false }; }
      case 'id': return this.idExpr(n, cx);
      case 'member': return this.memberExpr(n, cx);
      case 'call': return this.callExpr(n, cx);
      case 'index': {
        const a = this.expr(n.obj, cx), i = this.expr(n.idx, cx);
        const o = this.overloaded('[]', [a, i], cx, n);
        if (o) return o;
        const p = this.builtinOperand(a, cx, n), ix = this.builtinOperand(i, cx, n);
        if (p.t.k !== 'ptr') this.fail(`subscript of ${T.show(a.t)}`, n);
        return { c: `${p.c}[${ix.c}]`, t: p.t.to, lv: true };
      }
      case 'unary': return this.unaryExpr(n, cx);
      case 'pre': case 'post': {
        const e = this.expr(n.e, cx);
        const o = this.overloaded(n.op, [e], cx, n, n.k === 'post' ? [{ c: '0', t: T.INT, lv: false, zero: true }] : []);
        if (o) return o;
        if (!e.lv) this.fail(`${n.op} needs an lvalue`, n);
        if (n.k === 'post') return { c: `(${e.c}${n.op})`, t: T.uncst(e.t), lv: false };
        // In C++ `++x` is x itself, an lvalue; in C it is a value. Where its address is wanted
        // (resource_he.cpp: `cond ? ++str : str` passed on as an lvalue) it is written as x's,
        // after the increment -- x read once, through a pointer, when it is more than a name.
        let addr;
        if (/^\(*[A-Za-z_]\w*\)*((->|\.)[A-Za-z_]\w*\)*)*$/.test(e.c)) addr = `(${n.op}${e.c}, &${e.c})`;
        else if (cx.fn) { const p = this.temp(cx, T.ptr(e.t)); addr = `(${p} = &${e.c}, ${n.op}*${p}, ${p})`; }
        return { c: `(${n.op}${e.c})`, t: e.t, lv: true, ...(addr ? { addr } : {}) };
      }
      case 'sizeof': {
        if (n.type) return { c: `sizeof(${this.ct(this.stripRef(this.declType(n.type.specs, n.type.derivs, cx.env, n)))})`, t: T.UINT, lv: false };
        const sub = { ...cx, fn: cx.fn ? { ...cx.fn, temps: [], ntemp: cx.fn.ntemp } : null, pending: [], sizeofOnly: true };
        const e = this.expr(n.e, sub);
        return { c: `sizeof(${this.ct(e.t)})`, t: T.UINT, lv: false };
      }
      case 'cast':
        if (n.named === 'dynamic_cast') return this.dynamicCast(this.declType(n.type.specs, n.type.derivs, cx.env, n), this.expr(n.e, cx), cx, n);
        return this.castExpr(this.declType(n.type.specs, n.type.derivs, cx.env, n), this.expr(n.e, cx), cx, n);
      case 'fcast': return this.functionalCast(n, cx);
      case 'new': return this.newExpr(n, cx);
      case 'delete': return this.deleteExpr(n, cx);
      case 'bin': return this.binaryExpr(n, cx);
      case 'assign': return this.assignExpr(n, cx);
      case 'cond': return this.condExpr(n, cx);
      case 'comma': {
        const a = this.expr(n.a, cx), b = this.expr(n.b, cx);
        const o = this.overloaded(',', [a, b], cx, n);
        if (o) return o;
        return { ...b, c: `(${a.c}, ${b.c})`, addr: b.addr ? `(${a.c}, ${b.addr})` : undefined, zero: false };
      }
      default: this.fail(`expression ${n.k}`, n);
    }
  },
  stripRef(t) { return t.k === 'ref' ? t.to : t; },
  /*
   * `c ? a : b`. A TEMPORARY MADE IN ONE BRANCH EXISTS ONLY IF THAT BRANCH RAN, and is destroyed only
   * then: the condition is kept in a variable and each branch's temporaries are destroyed under it.
   * Destroying them all, as this did, ran a String destructor on garbage whenever ScummEngine's
   * `ConfMan.hasKey("basename") ? ConfMan.get("basename") : ...` took its second branch -- the first
   * branch's String("basename") had never been built.
   */
  condExpr(n, cx) {
    let c = this.condition(this.expr(n.c, cx), cx, n);
    const cv = cx.fn && !cx.sizeofOnly ? this.temp(cx, T.INT) : null;
    if (cv) c = `(${cv} = (${c}) != 0)`;
    const pa = [], pb = [];
    // A branch's temporaries are back in view while that branch is converted: copyOf hands a
    // temporary over to the object it initialises by finding it there.
    const side = (arr, make) => { const k = cx.pending.length; cx.pending.push(...arr.splice(0)); const r = make(); arr.push(...cx.pending.splice(k)); return r; };
    const done = (r) => {
      const keep = (arr, guard) => { for (const p of arr) cx.pending.push(guard ? { ...p, guard: p.guard ? `(${guard} && ${p.guard})` : guard } : p); };
      keep(pa, cv); keep(pb, cv && `!${cv}`);
      return r;
    };
    let a = side(pa, () => this.expr(n.a, cx)), b = side(pb, () => this.expr(n.b, cx));
    if (a.t.k === 'class' || b.t.k === 'class') {
      if (a.t.k === 'class' && b.t.k === 'class' && a.t.cls === b.t.cls) {
        if (a.lv && b.lv) {
          const ac = side(pa, () => this.addrOf(a, cx)), bc = side(pb, () => this.addrOf(b, cx));
          const p = `(${c} ? ${ac} : ${bc})`;
          return done({ c: `(*${p})`, t: a.t, lv: true, addr: p });
        }
        if (this.pinned(a.t.cls)) {
          // Each branch builds the one object in place, so it may be built in turn where it is going.
          const cls = a.t.cls, name = this.temp(cx, T.uncst(a.t));
          const sa = side(pa, () => this.constructAt(name, cls, [a], cx, n).replace(/;$/, '')), sb = side(pb, () => this.constructAt(name, cls, [b], cx, n).replace(/;$/, ''));
          if (this.dtorOf(cls)) cx.pending.push({ name, cls });
          const p = `(${c} ? (${sa || '0'}, &${name}) : (${sb || '0'}, &${name}))`;
          return done({ c: `(*${p})`, t: T.uncst(a.t), lv: false, addr: p, known: true, temporary: true, tempName: name });
        }
        const va = side(pa, () => this.copyOf(a, a.t.cls, cx)), vb = side(pb, () => this.copyOf(b, b.t.cls, cx));
        return done(this.classChoice(c, va, vb, a.t, cx));
      }
      // One side converts to the other's type.
      const toA = this.convert(b, T.uncst(a.t), cx), toB = this.convert(a, T.uncst(b.t), cx);
      const pinnedTo = toA && !toB && a.t.k === 'class' && this.pinned(a.t.cls) ? a.t : toB && !toA && b.t.k === 'class' && this.pinned(b.t.cls) ? b.t : null;
      if (pinnedTo) {
        // Each branch builds the one object in place, the converted one through its constructor.
        const cls = pinnedTo.cls, name = this.temp(cx, T.uncst(pinnedTo));
        const sa = side(pa, () => this.constructAt(name, cls, [a], cx, n).replace(/;$/, '')), sb = side(pb, () => this.constructAt(name, cls, [b], cx, n).replace(/;$/, ''));
        if (this.dtorOf(cls)) cx.pending.push({ name, cls });
        const p = `(${c} ? (${sa || '0'}, &${name}) : (${sb || '0'}, &${name}))`;
        return done({ c: `(*${p})`, t: T.uncst(pinnedTo), lv: false, addr: p, known: true, temporary: true, tempName: name });
      }
      if (toA && !toB) { const va = side(pa, () => this.coerce(a, T.uncst(a.t), cx, n)), vb = side(pb, () => toA.gen()); return done(this.choice(c, va, vb, T.uncst(a.t), cx)); }
      if (toB && !toA) { const va = side(pa, () => toB.gen()), vb = side(pb, () => this.coerce(b, T.uncst(b.t), cx, n)); return done(this.choice(c, va, vb, T.uncst(b.t), cx)); }
      this.fail(`?: between ${T.show(a.t)} and ${T.show(b.t)}`, n);
    }
    // Two lvalues of one type give an lvalue: `return i ? y : x;` from a function returning float &.
    if ((a.lv || a.addr) && (b.lv || b.addr) && a.t.k !== 'array' && a.t.k !== 'func' && !a.bits && !b.bits && T.same(a.t, b.t)) {
      const ac = side(pa, () => this.addrOf(a, cx)), bc = side(pb, () => this.addrOf(b, cx));
      const p = `(${c} ? ${ac} : ${bc})`;
      return done({ c: `(*${p})`, t: a.t, lv: true, addr: p });
    }
    a = this.decay(a); b = this.decay(b);
    let t;
    if (a.t.k === 'void' || b.t.k === 'void') t = T.VOID;
    else if (T.isArith(a.t) && T.isArith(b.t)) t = T.same(a.t, b.t, { top: false }) ? T.uncst(a.t) : T.usual(a.t, b.t);
    else if (a.t.k === 'ptr' && b.zero) t = a.t;
    else if (b.t.k === 'ptr' && a.zero) t = b.t;
    else if (a.t.k === 'ptr' && b.t.k === 'ptr') {
      const ab = this.scalarConv(b, a.t), ba = this.scalarConv(a, b.t);
      if (ab) { b = { ...b, c: ab.gen() }; t = a.t; } else if (ba) { a = { ...a, c: ba.gen() }; t = b.t; } else this.fail(`?: between ${T.show(a.t)} and ${T.show(b.t)}`, n);
    } else this.fail(`?: between ${T.show(a.t)} and ${T.show(b.t)}`, n);
    if (a.t.k === 'ptr' && b.zero) b = { ...b, c: `((${this.ct(a.t)})0)` };
    if (b.t.k === 'ptr' && a.zero) a = { ...a, c: `((${this.ct(b.t)})0)` };
    return done({ c: `(${c} ? ${a.c} : ${b.c})`, t, lv: false });
  },
  /** `c ? a : b` of two C values of type t: through a temporary when t is a class (see classChoice). */
  choice(c, a, b, t, cx) {
    return t.k === 'class' ? this.classChoice(c, a, b, t, cx) : { c: `(${c} ? ${a} : ${b})`, t, lv: false };
  },
  /*
   * A ?: whose value is an OBJECT is, in C, a struct-valued conditional -- and C will not take its
   * address or copy it into a temporary through one, which is everything the lowering does with a
   * class rvalue next (ScummEngine's `_gameName = ConfMan.hasKey(...) ? ConfMan.get(...) : name`).
   * So each branch fills one temporary and the conditional chooses its address: the same object
   * whichever side ran, destroyed with the full expression unless something takes it over.
   */
  classChoice(c, a, b, t, cx) {
    const name = this.temp(cx, T.uncst(t));
    const cls = this.isClassy(t);
    if (cls && this.dtorOf(cls)) cx.pending.push({ name, cls });
    const p = `(${c} ? (${name} = ${a}, &${name}) : (${name} = ${b}, &${name}))`;
    return { c: `(*${p})`, t: T.uncst(t), lv: false, addr: p, temporary: true, tempName: name };
  },
  stringLength(n) {
    let len = 0;
    for (const p of n.parts) {
      const body = p.replace(/^L?"|"$/g, '');
      for (let i = 0; i < body.length; i++) {
        if (body[i] !== '\\') { len++; continue; }
        const m = /^\\(x[0-9a-fA-F]+|[0-7]{1,3}|.)/.exec(body.slice(i));
        i += m[0].length - 1; len++;
      }
    }
    return len;
  },

  idExpr(n, cx) {
    const r = this.lookupName(n.name, cx.env);
    if (!r) this.fail(`'${this.qualText(n.name)}' is not declared`, n);
    const { ent } = r;
    switch (ent.k) {
      case 'enumerator': return { c: ent.ctext ?? String(ent.value), t: ent.type, lv: false, enumerator: ent.ctext === undefined };
      case 'var':
        if (ent.field) return this.fieldOf(this.thisObject(cx, n), ent, r.path, cx);
        return this.varExpr(ent, cx);
      case 'funcs': {
        const targs = n.name.parts[n.name.parts.length - 1].targs ?? null;
        if (ent.templates?.length) return { funcs: ent.list, templates: ent.templates, targs, owner: r.owner, qualified: r.qualified, t: T.VOID, c: '', lv: false };
        // A function named without being called: its address, when it is not overloaded.
        if (ent.list.length !== 1) return { funcs: ent.list, owner: r.owner, qualified: r.qualified, t: T.VOID, c: '', lv: false };
        const f = ent.list[0];
        if (f.cls && !f.isStatic) return { funcs: ent.list, owner: r.owner, qualified: r.qualified, t: T.VOID, c: '', lv: false };
        this.use(f);
        return { c: f.cname, t: f.type, lv: true, funcs: ent.list, owner: r.owner, qualified: r.qualified };
      }
      case 'type': this.fail(`type '${this.qualText(n.name)}' used as a value`, n); break;
      default: this.fail(`'${this.qualText(n.name)}' is not a value`, n);
    }
  },
  qualText(q) { return q.parts.map((p) => p.name).join('::'); },

  /** The object of `obj.name` / `obj->name` as an lvalue of class type. */
  objectOf(n, cx) {
    let o = this.expr(n.obj, cx);
    if (n.arrow) {
      if (o.t.k === 'class') { const ov = this.overloaded('->', [o], cx, n); if (ov) o = ov; }
      o = this.decay(o);
      if (o.t.k !== 'ptr' || o.t.to.k !== 'class') this.fail(`-> on ${T.show(o.t)}`, n);
      return { c: `(*${o.c})`, t: o.t.to, lv: true, addr: o.c };
    }
    if (o.t.k !== 'class') this.fail(`. on ${T.show(o.t)}`, n);
    return o;
  },
  memberExpr(n, cx) {
    // `x.~T()` / `p->~T()` with T a scalar: a pseudo-destructor call, see callExpr.
    if (this.lastName(n.name).startsWith('~')) {
      let o = this.expr(n.obj, cx);
      if (n.arrow) o = this.decay(o);
      const t = n.arrow ? (o.t.k === 'ptr' ? o.t.to : null) : o.t;
      if (t && t.k !== 'class') return { dtorCall: true, obj: { c: n.arrow ? `(*${o.c})` : o.c, t, lv: true }, t: T.VOID, c: '', lv: false };
    }
    const obj = this.objectOf(n, cx);
    this.complete(obj.t.cls, n);
    const name = this.lastName(n.name);
    // `p->A::f` names A's member; the qualifier chooses the class the lookup starts in.
    let start = obj.t.cls, qualified = false;
    if (n.name.parts.length > 1) {
      const qt = this.namedType({ parts: n.name.parts.slice(0, -1), global: n.name.global }, cx.env, n);
      start = qt.cls; qualified = true;
      if (!this.basePath(obj.t.cls, start)) this.fail(`${start.name} is not a base of ${obj.t.cls.name}`, n);
    }
    if (name.startsWith('~')) return { dtorCall: true, obj, t: T.VOID, c: '', lv: false };
    const m = this.memberEntity(start, name);
    if (!m) this.fail(`${obj.t.cls.name} has no member '${name}'`, n);
    const lead = this.basePath(obj.t.cls, start) ?? [];
    if (m.ent.k === 'var') {
      if (m.ent.staticMember) return this.varExpr(m.ent, cx);
      return this.fieldOf(obj, m.ent, [...lead, ...m.path], cx);
    }
    if (m.ent.k === 'funcs') return { funcs: m.ent.list, ...(m.ent.templates?.length ? { templates: m.ent.templates, targs: n.name.parts[n.name.parts.length - 1].targs ?? null } : {}), obj, qualified, t: T.VOID, c: '', lv: false };
    if (m.ent.k === 'enumerator') return { c: m.ent.ctext ?? String(m.ent.value), t: m.ent.type, lv: false };
    this.fail(`member '${name}' of ${obj.t.cls.name} is not a value`, n);
  },

  callExpr(n, cx) {
    const args = n.args.map((a) => this.expr(a, cx));
    let callee = n.fn;
    while (callee.k === 'paren') callee = callee.e;
    if (callee.k === 'pm') return this.memberPointerCall(callee, args, cx, n);
    // A member's conversion-function call spelt out: obj.operator T()
    if (n.fn.k === 'member' && n.fn.name.parts[n.fn.name.parts.length - 1].conv) {
      const obj = this.objectOf(n.fn, cx);
      const want = this.declType(n.fn.name.parts[n.fn.name.parts.length - 1].conv.specs, n.fn.name.parts[n.fn.name.parts.length - 1].conv.derivs, cx.env, n);
      const f = this.allConversions(obj.t.cls).find((x) => T.same(x.conv, want) && !(obj.t.c && !x.type.thisConst));
      if (!f) this.fail(`no conversion of ${obj.t.cls.name} to ${T.show(want)}`, n);
      return this.callMember(f, obj, [], cx, { node: n });
    }
    // A function of the C library no header declared (rand, strstr): called as C calls it.
    if (n.fn.k === 'id' && n.fn.name.parts.length === 1 && !n.fn.name.global && this.builtins?.has(this.lastName(n.fn.name)) && !this.lookupName(n.fn.name, cx.env)) {
      const name = this.lastName(n.fn.name);
      if (cx.constOnly) cx.dynamic = true;
      return { c: `${name}(${args.map((a) => this.variadicArg(a, cx)).join(', ')})`, t: this.cxxTypeOfC(this.builtins.get(name).ret), lv: false };
    }
    // Not found by ordinary lookup, an unqualified name is looked for in the namespaces of its
    // arguments' classes (argument-dependent lookup): Scumm's debugger calls
    // `enableSpecialDebugLevel(option)` with a Common::String, and the function is Common's.
    const adl = n.fn.k === 'id' && n.fn.name.parts.length === 1 && !n.fn.name.global && !this.lookupName(n.fn.name, cx.env) ? this.adlLookup(this.lastName(n.fn.name), args) : null;
    let fn = adl ?? (n.fn.k === 'id' && !this.lookupName(n.fn.name, cx.env) ? this.fail(`'${this.qualText(n.fn.name)}' is not declared`, n.fn) : this.expr(n.fn, cx));
    if (fn.dtorCall) {
      // A pseudo-destructor, `x.~T()` with T a scalar (Cube's vector<int>::setsize): the object is
      // evaluated and nothing is destroyed.
      if (fn.obj.t.k !== 'class') return { c: `((void)(${fn.obj.c}))`, t: T.VOID, lv: false };
      const d = this.dtorOf(fn.obj.t.cls);
      if (!d) return { c: '((void)0)', t: T.VOID, lv: false };
      return this.callResult(d, this.addrOf(fn.obj, cx), [], cx, { direct: false });
    }
    if (fn.templates) {
      // The plain functions of the name, and an instance of each template whose arguments deduce.
      const insts = fn.templates.map((ft) => this.deduce(ft, fn.targs ?? [], args, cx.env, n)).filter(Boolean);
      const cands = [...(fn.targs ? [] : fn.funcs), ...insts];
      if (!cands.length) this.fail(`no ${fn.templates[0].name} takes (${args.map((a) => T.show(a.t)).join(', ')})`, n);
      fn = { ...fn, funcs: cands };
    }
    if (fn.funcs) {
      const first = fn.funcs[0];
      const isMember = !!first.cls;
      let obj = fn.obj ?? null;
      if (isMember && !obj && fn.funcs.some((f) => !f.isStatic)) {
        // An unqualified (or A::) call of a member from inside a member: on *this.
        if (cx.fn?.f.cls && !cx.fn.f.isStatic) obj = this.thisObject(cx, n);
      }
      const r = this.resolve(fn.funcs, args, obj, cx, n, `call of ${first.display}`);
      if (!r) this.fail(`no ${first.display} takes (${args.map((a) => T.show(a.t)).join(', ')})`, n);
      if (isMember) {
        if (!r.f.isStatic && !obj) this.fail(`${r.f.display} needs an object`, n);
        return this.finishMemberCall(r, obj, args, cx, !!fn.qualified);
      }
      return this.callResult(r.f, null, [...r.convs.map((v) => v.gen()), ...this.defaultArgs(r.f, args.length, cx)], cx);
    }
    // An object with operator(), or a pointer to function.
    if (fn.t.k === 'class') {
      const o = this.overloaded('()', [fn], cx, n, args);
      if (o) return o;
    }
    const p = this.decay(fn);
    const ft = p.t.k === 'ptr' && p.t.to.k === 'func' ? p.t.to : null;
    if (!ft) this.fail(`call of ${T.show(fn.t)}`, n);
    if (args.length < ft.params.length || (args.length > ft.params.length && !ft.variadic)) this.fail('wrong number of arguments', n);
    const cArgs = args.map((a, i) => (i < ft.params.length ? this.coerce(a, ft.params[i], cx, n, 'argument conversion') : this.variadicArg(a, cx)));
    if (cx.constOnly) cx.dynamic = true;
    return this.pointerCall(p.c, null, ft, cArgs, cx);
  },
  /**
   * A call through a pointer -- to a function, or to a member function with the object first: the
   * same convention as a direct call (callResult), a pinned result in a temporary of the caller's
   * whose address goes first, pinned arguments by address.
   */
  pointerCall(callee, objC, ft, cArgs, cx) {
    cArgs = cArgs.map((a, i) => (i < ft.params.length && this.pinnedType(ft.params[i]) ? `(&${a})` : a));
    let sretTemp = null;
    if (this.pinnedType(ft.ret)) {
      const R = T.uncst(ft.ret);
      sretTemp = this.temp(cx, R);
      if (this.dtorOf(R.cls)) cx.pending.push({ name: sretTemp, cls: R.cls });
      cArgs = [`&${sretTemp}`, ...cArgs];
    }
    const call = `${callee}(${[...(objC ? [objC] : []), ...cArgs].join(', ')})`;
    if (ft.ret.k === 'ref') return { c: `(*${call})`, t: ft.ret.to, lv: true, addr: call };
    if (sretTemp) { const addr = `(${call}, &${sretTemp})`; return { c: `(*${addr})`, t: ft.ret, lv: false, addr, known: true, temporary: true, tempName: sretTemp }; }
    return { c: call, t: ft.ret, lv: false };
  },

  /**
   * `&C::f` as a value: the C function itself, or for a virtual one a thunk that calls through the
   * object's table -- so that the pointer reaches the overrider of whatever object it is used on.
   */
  memberPointerType(f) { return { k: 'memptr', cls: f.cls, to: T.func(f.type.ret, f.type.params, f.type.variadic, !!f.type.thisConst) }; },
  memberPointer(e, node) {
    const fs = e.funcs.filter((f) => !f.isStatic);
    // Overloaded: which one is meant is the target's to say (scalarConv); until then, no value.
    if (fs.length !== 1) return { memberOverload: fs, node, t: { k: 'overload', display: fs[0].display }, c: '', lv: false };
    const f = fs[0];
    const t = this.memberPointerType(f);
    this.use(f);
    if (!f.isVirtual) return { c: `((${this.ct(t)})${f.cname})`, t, lv: false };
    const name = `__vcall_${f.cname}`;
    if (!f.vcallDone) {
      f.vcallDone = true;
      // The function's own C signature, a pinned result's pointer and pinned arguments' addresses
      // passed on as they came, through the object's table.
      const sret = this.sret(f);
      const ps = [...(sret ? [this.ct(T.ptr(T.uncst(f.type.ret)), '__sret')] : []), ...f.type.params.map((p, i) => this.ct(this.cParamType(p), `__a${i}`))];
      const ret = sret ? T.VOID : f.type.ret.k === 'ref' ? T.ptr(f.type.ret.to) : f.type.ret;
      const sig = this.ct(ret, `${name}(${[this.ct(T.ptr({ k: 'class', cls: f.cls }), '__self'), ...ps].join(', ')})`);
      this.needStruct(f.cls);
      const slot = `((${this.fnPtrType(f)})__self->${[...this.vtableOwnerPath(f.cls), '__vptr'].join('.')}[${f.vindex}])`;
      const call = `${slot}(${['__self', ...(sret ? ['__sret'] : []), ...f.type.params.map((_, i) => `__a${i}`)].join(', ')})`;
      this.out.protos.push(`static ${sig};`);
      this.out.bodies.push(`static ${sig} {\n  ${ret.k === 'void' ? '' : 'return '}${call};\n}`);
    }
    return { c: `((${this.ct(t)})${name})`, t, lv: false };
  },
  /** `(obj.*pm)(args)` and `(p->*pm)(args)`: the function, called with the object first. */
  memberPointerCall(pm, args, cx, node) {
    let o = this.expr(pm.obj, cx);
    if (pm.arrow) {
      o = this.decay(o);
      if (o.t.k !== 'ptr' || o.t.to.k !== 'class') this.fail(`->* on ${T.show(o.t)}`, node);
      o = { c: `(*${o.c})`, t: o.t.to, lv: true, addr: o.c };
    }
    const m = this.expr(pm.mp, cx);
    if (m.t.k !== 'memptr') this.fail(`.* with ${T.show(m.t)}`, node);
    if (o.t.k !== 'class') this.fail(`.* on ${T.show(o.t)}`, node);
    const path = this.basePath(this.complete(o.t.cls, node), m.t.cls);
    if (!path) this.fail(`${m.t.cls.name} is not a base of ${o.t.cls.name}`, node);
    const ft = m.t.to;
    if (args.length < ft.params.length || (args.length > ft.params.length && !ft.variadic)) this.fail('wrong number of arguments', node);
    const cArgs = args.map((a, i) => (i < ft.params.length ? this.coerce(a, ft.params[i], cx, node, 'argument conversion') : this.variadicArg(a, cx)));
    if (cx.constOnly) cx.dynamic = true;
    return this.pointerCall(`(${m.c})`, this.upcastPtr(this.addrOf(o, cx), path, m.t.cls), ft, cArgs, cx);
  },
  /** The C compiler's type (src/sema/types.js) as this front end's. */
  cxxTypeOfC(t) {
    if (t.k === 'void') return T.VOID;
    if (t.k === 'ptr') return T.ptr(this.cxxTypeOfC(t.to));
    return T.prim(t.name ?? 'int');
  },
  unaryExpr(n, cx) {
    const e = this.expr(n.e, cx);
    if (n.op === '&') {
      if (e.funcs && e.t.k === 'func') return { c: e.c, t: T.ptr(e.t), lv: false };
      // `&C::f`: a pointer to member function.
      if (e.funcs && e.funcs[0]?.cls && !e.funcs[0].isStatic && !e.obj) return this.memberPointer(e, n);
      const o = this.overloaded('&', [e], cx, n);
      if (o) return o;
      if (e.constAddr) { if (e.constAddr.ent.global) this.useGlobal(e.constAddr.ent); return { c: e.constAddr.c, t: e.constAddr.t, lv: false }; }
      if (!e.lv && !e.addr) this.fail('& of something that is not an lvalue', n);
      return { c: e.addr ?? `(&${e.c})`, t: T.ptr(e.t), lv: false };
    }
    const o = this.overloaded(n.op, [e], cx, n);
    if (o) return o;
    const v = this.builtinOperand(e, cx, n);
    switch (n.op) {
      case '*':
        if (v.t.k !== 'ptr') this.fail(`* of ${T.show(e.t)}`, n);
        if (v.t.to.k === 'func') return { c: v.c, t: v.t.to, lv: true };
        return { c: `(*${v.c})`, t: v.t.to, lv: true, addr: v.c };
      case '!': return { c: `(!${v.c})`, t: T.BOOL, lv: false };
      case '-': case '+': case '~':
        if (!T.isArith(v.t)) this.fail(`${n.op} of ${T.show(e.t)}`, n);
        // `-0` is still an integral constant zero, so a null pointer constant (kyra's menu tables).
        return { c: `(${n.op}${v.c})`, t: T.promote(v.t), lv: false, zero: n.op !== '~' && !!v.zero };
      default: this.fail(`unary ${n.op}`, n);
    }
  },

  binaryExpr(n, cx) {
    /*
     * && and ||: the right operand's temporaries exist only if it was evaluated, so they are destroyed
     * under the left operand's value, kept in a variable -- the same rule as condExpr's.
     */
    if ((n.op === '&&' || n.op === '||') && cx.fn && !cx.sizeofOnly) {
      const l = this.expr(n.a, cx);
      if (l.t.k !== 'class') {
        const cv = this.temp(cx, T.INT);
        const ca = `(${cv} = (${this.condition(l, cx, n)}) != 0)`;
        const k = cx.pending.length;
        const cb = this.condition(this.expr(n.b, cx), cx, n);
        const guard = n.op === '&&' ? cv : `!${cv}`;
        for (const p of cx.pending.splice(k)) cx.pending.push({ ...p, guard: p.guard ? `(${guard} && ${p.guard})` : guard });
        return { c: `(${ca} ${n.op} ${cb})`, t: T.BOOL, lv: false };
      }
    }
    const a0 = this.expr(n.a, cx), b0 = this.expr(n.b, cx);
    const o = this.overloaded(n.op, [a0, b0], cx, n);
    if (o) return o;
    if (n.op === '&&' || n.op === '||') return { c: `(${this.condition(a0, cx, n)} ${n.op} ${this.condition(b0, cx, n)})`, t: T.BOOL, lv: false };
    const a = this.builtinOperand(a0, cx, n), b = this.builtinOperand(b0, cx, n);
    const c = `(${a.c} ${n.op} ${b.c})`;
    if (CMP.has(n.op)) {
      const ok = (T.isArith(a.t) && T.isArith(b.t)) || (a.t.k === 'ptr' && (b.t.k === 'ptr' || b.zero)) || (b.t.k === 'ptr' && a.zero)
        || (a.t.k === 'memptr' && (b.t.k === 'memptr' || b.zero)) || (b.t.k === 'memptr' && a.zero);
      if (!ok) this.fail(`${n.op} between ${T.show(a0.t)} and ${T.show(b0.t)}`, n);
      return { c, t: T.BOOL, lv: false };
    }
    if (a.t.k === 'ptr' || b.t.k === 'ptr') {
      if (n.op === '+' && a.t.k === 'ptr' && T.isInteger(b.t)) return { c, t: a.t, lv: false };
      if (n.op === '+' && b.t.k === 'ptr' && T.isInteger(a.t)) return { c, t: b.t, lv: false };
      if (n.op === '-' && a.t.k === 'ptr' && T.isInteger(b.t)) return { c, t: a.t, lv: false };
      if (n.op === '-' && a.t.k === 'ptr' && b.t.k === 'ptr') return { c, t: T.INT, lv: false };
      this.fail(`${n.op} between ${T.show(a0.t)} and ${T.show(b0.t)}`, n);
    }
    if (!T.isArith(a.t) || !T.isArith(b.t)) this.fail(`${n.op} between ${T.show(a0.t)} and ${T.show(b0.t)}`, n);
    if (n.op === '<<' || n.op === '>>') return { c, t: T.promote(a.t), lv: false };
    return { c, t: T.usual(a.t, b.t), lv: false };
  },

  assignExpr(n, cx) {
    const a = this.expr(n.a, cx), b = this.expr(n.b, cx);
    if (a.t.k === 'class') {
      const o = this.overloaded(n.op, [a, b], cx, n);
      if (o) return o;
      if (n.op !== '=') this.fail(`no operator${n.op} for ${T.show(a.t)}`, n);
      // No user operator=: memberwise, which is a plain struct assignment unless a member has its own.
      const v = this.convert(b, T.uncst(a.t), cx);
      if (!v) this.fail(`cannot assign ${T.show(b.t)} to ${T.show(a.t)}`, n);
      if (this.needsAssign(a.t.cls)) {
        const f = this.implicit(a.t.cls, 'assign');
        const src = this.convert(b, T.ref(T.cst(T.uncst(a.t))), cx);
        return this.callResult(f, this.addrOf(a, cx), [src.gen()], cx);
      }
      return { c: `(${a.c} = ${v.gen()})`, t: a.t, lv: true };
    }
    const o = b.t.k === 'class' || a.t.k === 'enum' ? this.overloaded(n.op, [a, b], cx, n) : null;
    if (o) return o;
    if (!a.lv) this.fail('assignment to something that is not an lvalue', n);
    if (a.t.c) this.fail('assignment to a const object', n);
    if (cx.constOnly) cx.dynamic = true;
    if (n.op === '=') return this.assigned(a, '=', this.coerce(b, T.uncst(a.t), cx, n, 'assignment'), cx);
    const r = this.builtinOperand(b, cx, n);
    if (a.t.k === 'ptr' ? !(T.isInteger(r.t) && (n.op === '+=' || n.op === '-=')) : !(T.isArith(a.t) && T.isArith(r.t))) {
      this.fail(`${n.op} between ${T.show(a.t)} and ${T.show(b.t)}`, n);
    }
    return this.assigned(a, n.op, r.c, cx);
  },
  /*
   * An assignment is an lvalue in C++ and not in C, so its address cannot be `&(a = b)`. Where the
   * left side has no side effects -- a name, a member reached from one, a pointer read through one --
   * the address is the assignment's, then &a: Cube's `return p ? p : (p = new pool());`. Where it has
   * an address of its own (a reference a call returned: `players[cn] = newdynent()`), that address
   * is taken once into a temporary and the assignment goes through it.
   */
  assigned(a, op, v, cx) {
    const simple = /^\(*\*?\(*[A-Za-z_$][\w$]*\)*((\.|->)[A-Za-z_$][\w$]*\)*)*$/.test(a.c);
    if (simple || !a.addr || !cx.fn) {
      const c = `(${a.c} ${op} ${v})`;
      return simple ? { c, t: a.t, lv: true, addr: `(${c}, &${a.c})` } : { c, t: a.t, lv: true };
    }
    const p = this.temp(cx, T.ptr(a.t));
    const c = `(*(${p} = ${a.addr}) ${op} ${v})`;
    return { c, t: a.t, lv: true, addr: `(${c}, ${p})` };
  },

  /** An explicit conversion of e to `to` (a cast in any spelling). */
  castExpr(to, e, cx, node) {
    if (to.k === 'ref') {
      const v = this.convert(e, to, cx);
      if (v) { const p = v.gen(); return { c: `(*${p})`, t: to.to, lv: true, addr: p }; }
      if (!e.lv && !e.addr) this.fail('a cast to a reference of something that is not an lvalue', node);
      const p = `((${this.ct(T.ptr(to.to))})${this.addrOf(e, cx)})`;
      return { c: `(*${p})`, t: to.to, lv: true, addr: p };
    }
    const V = T.uncst(to);
    if (V.k === 'void') return { c: `((void)${e.funcs && !e.c ? '0' : e.c})`, t: T.VOID, lv: false };
    const v = this.convert(e, V, cx, { explicit: true });
    // C's NULL is ((void *)0): still a null pointer constant here, though void * converts to nothing in C++.
    if (v) return { c: v.gen(), t: V, lv: false, zero: !!e.zero && V.k === 'ptr' && V.to.k === 'void' };
    if (V.k === 'class') this.fail(`no conversion from ${T.show(e.t)} to ${T.show(V)}`, node);
    const s = this.builtinOperand(e, cx, node);
    // Down a class hierarchy: back from a base to the class that contains it.
    if (V.k === 'ptr' && s.t.k === 'ptr' && V.to.k === 'class' && s.t.to.k === 'class' && V.to.cls.complete) {
      const path = this.basePath(V.to.cls, s.t.to.cls);
      // C++ forbids it (a virtual base is at no fixed place in what derives from it): dynamic_cast is the way.
      if (path && this.isVirtualPath(path)) this.fail(`a cast from ${T.show(s.t)} down through a virtual base to ${T.show(V)}`, node);
      if (path && path.length && !path.every((p) => p === '__b0')) {
        this.needStruct(V.to.cls);
        return { c: `((${this.ct(V)})((char *)${s.c} - (unsigned int)&((${this.ct(V)})0)->${path.join('.')}))`, t: V, lv: false };
      }
    }
    if (!T.isScalar(V) || !T.isScalar(s.t)) this.fail(`cast from ${T.show(e.t)} to ${T.show(V)}`, node);
    return { c: `((${this.ct(V)})${s.c})`, t: V, lv: false, zero: e.zero && V.k === 'ptr' && V.to.k === 'void' };
  },

  /**
   * `dynamic_cast<D *>(p)`: up a hierarchy it is an ordinary conversion; down or across one, the
   * object's table says what it is -- its offset to the whole object and the whole object's type
   * descriptor, searched for D by name (src/cxx/sema-stmt.js, vtableName and typeinfo).
   */
  dynamicCast(to, e, cx, node) {
    const V = T.uncst(to);
    if (V.k !== 'ptr' || V.to.k !== 'class') this.fail(`dynamic_cast to ${T.show(to)}: only to a pointer to a class`, node);
    const p = this.builtinOperand(e, cx, node);
    if (p.t.k !== 'ptr' || p.t.to.k !== 'class') this.fail(`dynamic_cast of ${T.show(e.t)}`, node);
    const from = this.complete(p.t.to.cls, node), want = this.complete(V.to.cls, node);
    const up = this.derivedPath(from, want);
    if (up) return { c: this.upcastPtr(p.c, up, want), t: V, lv: false };
    if (!from.hasVptr) this.fail(`dynamic_cast from ${from.name}, which has no virtual function`, node);
    this.needStruct(from);
    this.typeinfo(want);
    this.needDyncast();
    const tmp = this.temp(cx, T.ptr({ k: 'class', cls: from }));
    const vptr = `${tmp}->${[...this.vptrPath(from), '__vptr'].join('.')}`;
    return { c: `((${this.ct(V)})__prism_dyncast((void *)(${tmp} = ${p.c}), ${tmp} ? ${vptr} : (void **)0, "${want.cname}"))`, t: V, lv: false };
  },
  needDyncast() {
    if (this.dyncastDone) return;
    this.dyncastDone = true;
    this.out.protos.push('static void *__prism_dyncast(void *p, void **vptr, const char *name);');
    this.out.bodies.push(
      'static int __prism_ti_find(const struct __prism_ti *ti, const char *name, int off) {\n'
      + '  int i, r; const char *a = ti->name, *b = name;\n'
      + '  while (*a && *a == *b) a++, b++;\n'
      + '  if (*a == *b) return off;\n'
      + '  for (i = 0; i < ti->n; i++) { r = __prism_ti_find(ti->b[i].ti, name, off + ti->b[i].off); if (r >= 0) return r; }\n'
      + '  return -1;\n}',
      'static void *__prism_dyncast(void *p, void **vptr, const char *name) {\n'
      + '  char *top; int r;\n'
      + '  if (!p) return (void *)0;\n'
      + '  top = (char *)p + (int)vptr[-2];\n'
      + '  r = __prism_ti_find((const struct __prism_ti *)vptr[-1], name, 0);\n'
      + '  return r < 0 ? (void *)0 : (void *)(top + r);\n}');
  },
  /** `T(args)`: a conversion for a non-class T, a temporary built by a constructor for a class. */
  functionalCast(n, cx) {
    const t = T.uncst(this.declType(n.type.specs, n.type.derivs, cx.env, n));
    const args = n.args.map((a) => this.expr(a, cx));
    if (t.k !== 'class') {
      if (args.length === 0) return { c: `((${this.ct(t)})0)`, t, lv: false, zero: T.isInteger(t) };
      if (args.length !== 1) this.fail(`${T.show(t)}(...) takes one value`, n);
      return this.castExpr(t, args[0], cx, n);
    }
    const pick = this.pickCtor(t.cls, args, cx, n);
    if (pick.copy) return { c: this.copyOf(pick.copy, t.cls, cx), t, lv: false };
    const name = this.temp(cx, t);
    const d = this.dtorOf(t.cls);
    if (d) cx.pending.push({ name, cls: t.cls });
    if (!pick.f) return { c: name, t, lv: true, known: true, temporary: true, moved: name };
    this.use(pick.f);
    if (cx.constOnly) cx.dynamic = true;
    // Held in its temporary: usable as an object (`T(x).m()`) and as a value.
    const p = `(${pick.f.cname}(${[`&${name}`, ...pick.cArgs].join(', ')}), &${name})`;
    return { c: `(*${p})`, t, lv: false, addr: p, known: true, temporary: true, tempName: name };
  },

  newExpr(n, cx) {
    const t = T.uncst(this.declType(n.type.specs, n.type.derivs, cx.env, n));
    const pt = T.ptr(t);
    this.needMalloc();
    if (cx.constOnly) cx.dynamic = true;
    const cls = t.k === 'class' ? this.complete(t.cls, n) : null;
    /*
     * `new Area[n][MAX_AREAS_NUMBER]` of a class with a constructor: the n arrays are n * MAX objects in
     * a row, made by the same helper as `new Area[n * MAX]` -- the count kept in front -- and handed
     * back as a pointer to the arrays. delete[] goes back through the helper (deleteExpr).
     */
    if (n.place && n.count) this.fail('placement new of an array', n);
    const inner = t.k === 'array' ? this.isClassy(t) : null;
    if (inner && n.count && (this.defaultCtor(inner, n) || this.dtorOf(inner))) {
      const count = this.coerce(this.expr(n.count, cx), T.UINT, cx, n);
      const per = `(sizeof(${this.ct(t)}) / sizeof(${this.ct({ k: 'class', cls: inner })}))`;
      return { c: `((${this.ct(pt)})${this.arrayHelper(inner, 'new')}((${count}) * ${per}))`, t: pt, lv: false };
    }
    if (n.count) {
      const count = this.coerce(this.expr(n.count, cx), T.UINT, cx, n);
      const ctor = cls ? this.defaultCtor(cls, n) : null, dtor = cls ? this.dtorOf(cls) : null;
      if (!ctor && !dtor) return { c: `((${this.ct(pt)})malloc(${count} * sizeof(${this.ct(t)})))`, t: pt, lv: false };
      return { c: `${this.arrayHelper(cls, 'new')}(${count})`, t: pt, lv: false };
    }
    const p = this.temp(cx, pt);
    // Placement new, `new (where) T(...)`: the object is built at that address, nothing allocated
    // (the <new> operator new(size_t, void *) returns its argument).
    if (n.place && n.place.length !== 1) this.fail('placement new with more than one argument', n);
    const alloc = n.place
      ? `${p} = (${this.ct(pt)})(${this.coerce(this.expr(n.place[0], cx), T.ptr(T.VOID), cx, n)})`
      : `${p} = (${this.ct(pt)})malloc(sizeof(${this.ct(t)}))`;
    if (!cls) {
      if (n.args && n.args.length === 1) return { c: `(${alloc}, *${p} = ${this.coerce(this.expr(n.args[0], cx), t, cx, n)}, ${p})`, t: pt, lv: false };
      if (n.args) return { c: `(${alloc}, *${p} = 0, ${p})`, t: pt, lv: false };
      return { c: `(${alloc}, ${p})`, t: pt, lv: false };
    }
    const args = (n.args ?? []).map((a) => this.expr(a, cx));
    // A pinned object is built in the memory new got for it: `new S(make())` copies nothing.
    if (this.pinned(cls)) return { c: `(${alloc}, ${this.constructAt(`(*${p})`, cls, args, cx, n).replace(/;$/, '') || '0'}, ${p})`, t: pt, lv: false };
    const pick = this.pickCtor(cls, args, cx, n);
    if (pick.copy) return { c: `(${alloc}, *${p} = ${this.copyOf(pick.copy, cls, cx)}, ${p})`, t: pt, lv: false };
    if (!pick.f) return { c: `(${alloc}, ${p})`, t: pt, lv: false };
    this.use(pick.f);
    return { c: `(${alloc}, ${pick.f.cname}(${[p, ...pick.cArgs].join(', ')}), ${p})`, t: pt, lv: false };
  },
  deleteExpr(n, cx) {
    const e = this.builtinOperand(this.expr(n.e, cx), cx, n);
    if (e.t.k !== 'ptr') this.fail(`delete of ${T.show(e.t)}`, n);
    this.needMalloc();
    const cls = e.t.to.k === 'class' ? this.complete(e.t.to.cls, n) : null;
    const dtor = cls ? this.dtorOf(cls) : null;
    const inner = e.t.to.k === 'array' ? this.isClassy(e.t.to) : null;
    if (n.array && inner && (this.defaultCtor(inner, n) || this.dtorOf(inner))) {
      return { c: `${this.arrayHelper(inner, 'delete')}((${this.ct(T.ptr({ k: 'class', cls: inner }))})${e.c})`, t: T.VOID, lv: false };
    }
    if (n.array) {
      const ctor = cls ? this.defaultCtor(cls, n) : null;
      if (!ctor && !dtor) return { c: `free((void *)${e.c})`, t: T.VOID, lv: false };
      return { c: `${this.arrayHelper(cls, 'delete')}(${e.c})`, t: T.VOID, lv: false };
    }
    if (!dtor) return { c: `free((void *)${e.c})`, t: T.VOID, lv: false };
    return { c: `${this.deleteHelper(cls)}(${e.c})`, t: T.VOID, lv: false };
  },
  needMalloc() {
    if (this.mallocDone) return;
    this.mallocDone = true;
    // <stdlib.h>'s own declarations when the unit included it; the same ones otherwise.
    for (const name of ['malloc', 'free']) {
      const ent = this.global.get(name);
      if (ent?.k === 'funcs') this.use(ent.list[0]);
      else this.out.protos.push(name === 'malloc' ? 'void *malloc(unsigned int);' : 'void free(void *);');
    }
  },
  /** `delete p` for a class with a destructor: null is left alone, the destructor may be virtual. */
  deleteHelper(cls) {
    const name = `__delete_${cls.cname}`;
    if (cls.deleteHelper) return name;
    cls.deleteHelper = true;
    this.needStruct(cls);
    const d = this.dtorOf(cls);
    this.use(d);
    const self = this.ct(T.ptr({ k: 'class', cls }), 'p');
    const call = d.isVirtual ? `((${this.fnPtrType(d)})p->${[...this.vptrPath(d.cls === cls ? cls : cls), '__vptr'].join('.')}[${d.vindex}])(${this.upcastPtr('p', this.basePath(cls, d.cls), d.cls)})` : `${d.cname}(${this.upcastPtr('p', this.basePath(cls, d.cls), d.cls)})`;
    this.out.protos.push(`static void ${name}(${self});`);
    this.out.bodies.push(`static void ${name}(${self}) {\n  if (p) { ${call}; free((void *)p); }\n}`);
    return name;
  },
  /** new T[n] and delete[] for a class that is constructed or destroyed: the count is kept in front. */
  arrayHelper(cls, which) {
    const nw = `__newarr_${cls.cname}`, dl = `__delarr_${cls.cname}`;
    if (!cls.arrayHelpers) {
      cls.arrayHelpers = true;
      const ctor = this.defaultCtor(cls), dtor = this.dtorOf(cls);
      if (ctor) this.use(ctor);
      if (dtor) this.use(dtor);
      const st = this.ct({ k: 'class', cls });
      const cx = { env: cls.env, fn: null, pending: [] };
      const extra = ctor ? this.defaultArgsStatic(ctor) : [];
      void cx;
      this.out.protos.push(`static ${st} *${nw}(unsigned int n);`, `static void ${dl}(${st} *p);`);
      this.out.bodies.push(
        `static ${st} *${nw}(unsigned int n) {\n  unsigned int *h = (unsigned int *)malloc(8 + n * sizeof(${st}));\n  ${st} *p = (${st} *)(h + 2);\n  unsigned int i;\n  h[0] = n;\n`
        + `${ctor ? `  for (i = 0; i < n; i++) ${ctor.cname}(${['&p[i]', ...extra].join(', ')});\n` : ''}  return p;\n}`,
        `static void ${dl}(${st} *p) {\n  unsigned int *h, i;\n  if (!p) return;\n  h = (unsigned int *)p - 2;\n`
        + `${dtor ? `  for (i = h[0]; i > 0; i--) ${dtor.cname}(&p[i - 1]);\n` : ''}  free((void *)h);\n}`,
      );
    }
    return which === 'new' ? nw : dl;
  },
  /** A default constructor's own default arguments, where they are constants (no function context). */
  defaultArgsStatic(f) {
    return f.params.map((p, i) => {
      const cx = { env: p.env ?? { scope: this.global, cls: f.cls, bind: f.cls?.bind ?? null }, fn: null, pending: [], constOnly: true };
      return this.coerce(this.expr(p.def, cx), f.type.params[i], cx, f.node, 'default argument');
    });
  },
};
