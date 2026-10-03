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
  ct(t, name = '') { this.needType(t, true); return T.cDecl(t, name); },
  needType(t, byValue) {
    switch (t.k) {
      case 'class': if (byValue) this.needStruct(t.cls); else this.forward(t.cls); break;
      case 'ptr': case 'ref': this.needType(t.to, false); break;
      case 'array': this.needType(t.of, byValue); break;
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
    cls.bases.forEach((b, i) => { this.needStruct(b); lines.push(`  struct ${b.cname} __b${i};`); });
    if (cls.ownVptr) lines.push('  void **__vptr;');
    for (const f of cls.fields) lines.push(`  ${this.ct(f.type.k === 'ref' ? T.ptr(f.type.to) : f.type, f.cname)}${f.bits != null ? ` : ${f.bits}` : ''};`);
    // An empty class has size 1 in C++ and no spelling in C.
    if (!lines.length) lines.push('  char __empty;');
    this.out.types.push(`${cls.key === 'union' ? 'union' : 'struct'} ${cls.cname} {\n${lines.join('\n')}\n};`);
  },

  // ---------------------------------------------------------------- special members
  isClassy(t) { while (t.k === 'array') t = t.of; return t.k === 'class' ? t.cls : null; },
  needsCtor(cls) {
    this.complete(cls, cls.node);
    return cls.ctors.length > 0 || cls.hasVptr || cls.bases.some((b) => this.needsCtor(b))
      || cls.fields.some((f) => { const c = this.isClassy(f.type); return c && this.needsCtor(c); });
  },
  needsDtor(cls) {
    this.complete(cls, cls.node);
    return !!cls.dtor || cls.bases.some((b) => this.needsDtor(b))
      || cls.fields.some((f) => { const c = this.isClassy(f.type); return c && this.needsDtor(c); });
  },
  userCopyCtor(cls) {
    return cls.ctors.find((f) => f.type.params.length >= 1 && f.type.params[0].k === 'ref' && f.type.params[0].to.k === 'class'
      && f.type.params[0].to.cls === cls && f.params.slice(1).every((p) => p.def));
  },
  needsCopy(cls) {
    this.complete(cls, cls.node);
    return !!this.userCopyCtor(cls) || cls.hasVptr || cls.bases.some((b) => this.needsCopy(b))
      || cls.fields.some((f) => { const c = this.isClassy(f.type); return c && this.needsCopy(c); });
  },
  userAssign(cls) {
    const set = cls.scope.get('operator=');
    return set?.list.find((f) => f.type.params.length === 1 && ((f.type.params[0].k === 'ref' && f.type.params[0].to.k === 'class' && f.type.params[0].to.cls === cls)
      || (f.type.params[0].k === 'class' && f.type.params[0].cls === cls)));
  },
  needsAssign(cls) {
    this.complete(cls, cls.node);
    return !!this.userAssign(cls) || cls.hasVptr || cls.bases.some((b) => this.needsAssign(b))
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
    if (f.used) return f;
    f.used = true;
    const hasBody = !!f.body || !!f.implicit || (f.cls && this.findTemplateBody(f));
    const stat = hasBody ? (f.inline || f.fileStatic) : false;
    f.cStatic = stat;
    this.out.protos.push(`${stat ? 'static ' : ''}${this.signature(f)};`);
    if (hasBody) this.queue.push(f);
    return f;
  },
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
  signature(f) {
    const ps = [];
    if (f.cls && !f.isStatic) ps.push(this.ct(T.ptr(f.type.thisConst ? T.cst({ k: 'class', cls: f.cls }) : { k: 'class', cls: f.cls }), 'this'));
    f.type.params.forEach((p, i) => ps.push(this.ct(p.k === 'ref' ? T.ptr(p.to) : p, this.paramName(f, i))));
    if (f.type.variadic) ps.push('...');
    const ret = f.type.ret.k === 'ref' ? T.ptr(f.type.ret.to) : f.type.ret;
    return this.ct(ret, `${f.cname}(${ps.length ? ps.join(', ') : 'void'})`);
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
      const ot = this.namedType({ parts: q.parts.slice(0, -1), global: q.global }, env);
      if (ot.k !== 'class') return null;
      this.complete(ot.cls);
      const m = this.memberEntity(ot.cls, last);
      return m ? { ent: m.ent, path: m.path, owner: ot.cls, qualified: true, found: m.cls } : null;
    }
    if (q.global) { const ent = this.global.get(last); return ent ? { ent, path: [], owner: null } : null; }
    for (let s = env.scope; s; s = s.parent) {
      if (s.cls) {
        const m = this.memberEntity(s.cls, last);
        if (m) return { ent: m.ent, path: m.path, owner: s.cls, found: m.cls };
      } else {
        const ent = s.get(last);
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
    if (obj.t.c && t.k !== 'array') t = T.cst(t);
    return { c, t, lv: true, bits: ent.bits != null };
  },
  varExpr(ent, cx) {
    if (ent.global) this.useGlobal(ent);
    if (ent.constValue !== undefined && !ent.global) return { c: String(ent.constValue), t: T.uncst(ent.type), lv: false };
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
      if (V.to.k === 'void' && F.to.k !== 'func') return { rank: CONV, gen: () => `((${this.ct(T.uncst(V))})${from.c})` };
      if (V.to.k === 'class' && F.to.k === 'class') {
        const path = this.derivedPath(F.to.cls, V.to.cls);
        if (path) return { rank: CONV, gen: () => this.upcastPtr(from.c, path, V.to.cls) };
      }
      return null;
    }
    if (V.k === 'prim' && V.name === 'bool' && F.k === 'ptr') return { rank: CONV, gen: () => `(${from.c} != 0)` };
    return null;
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
    // A base that is not first sits at an offset; a null pointer stays null.
    return `(${c} ? &(${c})->${path.join('.')} : (struct ${base.cname} *)0)`;
  },
  /** A copy of the class value e (of class cls or derived from it), as a C rvalue of struct cls. */
  copyOf(e, cls, cx) {
    const self = { k: 'class', cls };
    const path = this.basePath(e.t.cls, cls);
    const cc = this.copyCtorOf(cls);
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
      this.fail(`ambiguous conversion from ${T.show(e.t)} to ${T.show(V)}: ${found[0].f.display} or ${found[1].f.display}`, cx.node);
    }
    return found[0];
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
    const winners = viable.filter((a) => !viable.some((b) => b !== a && better(b, a)));
    if (winners.length !== 1) {
      // Two declarations of one function (a member seen through two paths) are not an ambiguity.
      const distinct = [...new Set(winners.map((w) => w.f))];
      if (distinct.length !== 1) this.fail(`ambiguous ${what}: ${distinct.map((f) => `${f.display}(${f.type.params.map(T.show).join(', ')})`).join(' or ')}`, node);
    }
    void best;
    return winners[0];
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
    const all = thisC ? [thisC, ...cArgs] : cArgs;
    let call;
    if (!direct && f.isVirtual) {
      // Through the object's table. The object pointer is used twice, so it is held in a temporary
      // unless it is a plain name.
      let p = thisC;
      let pre = '';
      if (!/^[A-Za-z_]\w*$/.test(p)) { const name = this.temp(cx, T.ptr({ k: 'class', cls: f.cls })); pre = `${name} = ${p}, `; p = name; }
      const root = this.vtableOwnerPath(f.cls);
      const fnType = this.fnPtrType(f);
      call = `(${pre}((${fnType})(${p})->${[...root, '__vptr'].join('.')}[${f.vindex}])(${[p, ...cArgs].join(', ')}))`;
    } else call = `${f.cname}(${all.join(', ')})`;
    const r = f.type.ret;
    if (r.k === 'ref') return { c: `(*${call})`, t: r.to, lv: true, addr: call };
    return { c: call, t: r, lv: false };
  },
  vtableOwnerPath(cls) { return this.vptrPath(cls); },
  fnPtrType(f) {
    const ps = [this.ct(T.ptr({ k: 'class', cls: f.cls }))];
    for (const p of f.type.params) ps.push(this.ct(p.k === 'ref' ? T.ptr(p.to) : p));
    if (f.type.variadic) ps.push('...');
    const ret = f.type.ret.k === 'ref' ? T.ptr(f.type.ret.to) : f.type.ret;
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
    return `(${f.cname}(${[`&${name}`, ...cArgs].join(', ')}), ${name})`;
  },
  /** The constructor of cls for these arguments and its converted arguments. */
  pickCtor(cls, args, cx, node) {
    this.complete(cls, node);
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
    const g = this.global.get(name);
    if (g?.k === 'funcs') for (const f of g.list) cands.push({ f, member: false });
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
      case 'bool': return { c: n.v ? '1' : '0', t: T.BOOL, lv: false };
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
        return n.k === 'pre' ? { c: `(${n.op}${e.c})`, t: e.t, lv: true } : { c: `(${e.c}${n.op})`, t: T.uncst(e.t), lv: false };
      }
      case 'sizeof': {
        if (n.type) return { c: `sizeof(${this.ct(this.stripRef(this.declType(n.type.specs, n.type.derivs, cx.env, n)))})`, t: T.UINT, lv: false };
        const sub = { ...cx, fn: cx.fn ? { ...cx.fn, temps: [], ntemp: cx.fn.ntemp } : null, pending: [], sizeofOnly: true };
        const e = this.expr(n.e, sub);
        return { c: `sizeof(${this.ct(e.t)})`, t: T.UINT, lv: false };
      }
      case 'cast': return this.castExpr(this.declType(n.type.specs, n.type.derivs, cx.env, n), this.expr(n.e, cx), cx, n);
      case 'fcast': return this.functionalCast(n, cx);
      case 'new': return this.newExpr(n, cx);
      case 'delete': return this.deleteExpr(n, cx);
      case 'bin': return this.binaryExpr(n, cx);
      case 'assign': return this.assignExpr(n, cx);
      case 'cond': {
        const c = this.condition(this.expr(n.c, cx), cx, n);
        let a = this.expr(n.a, cx), b = this.expr(n.b, cx);
        if (a.t.k === 'class' || b.t.k === 'class') {
          if (a.t.k === 'class' && b.t.k === 'class' && a.t.cls === b.t.cls) {
            if (a.lv && b.lv) { const ac = this.addrOf(a, cx), bc = this.addrOf(b, cx); const p = `(${c} ? ${ac} : ${bc})`; return { c: `(*${p})`, t: a.t, lv: true, addr: p }; }
            return { c: `(${c} ? ${this.copyOf(a, a.t.cls, cx)} : ${this.copyOf(b, b.t.cls, cx)})`, t: T.uncst(a.t), lv: false };
          }
          // One side converts to the other's type.
          const toA = this.convert(b, T.uncst(a.t), cx), toB = this.convert(a, T.uncst(b.t), cx);
          if (toA && !toB) return { c: `(${c} ? ${this.coerce(a, T.uncst(a.t), cx, n)} : ${toA.gen()})`, t: T.uncst(a.t), lv: false };
          if (toB && !toA) return { c: `(${c} ? ${toB.gen()} : ${this.coerce(b, T.uncst(b.t), cx, n)})`, t: T.uncst(b.t), lv: false };
          this.fail(`?: between ${T.show(a.t)} and ${T.show(b.t)}`, n);
        }
        // Two lvalues of one type give an lvalue: `return i ? y : x;` from a function returning float &.
        if ((a.lv || a.addr) && (b.lv || b.addr) && a.t.k !== 'array' && a.t.k !== 'func' && !a.bits && !b.bits && T.same(a.t, b.t)) {
          const p = `(${c} ? ${this.addrOf(a, cx)} : ${this.addrOf(b, cx)})`;
          return { c: `(*${p})`, t: a.t, lv: true, addr: p };
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
        return { c: `(${c} ? ${a.c} : ${b.c})`, t, lv: false };
      }
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
      case 'enumerator': return { c: String(ent.value), t: ent.type, lv: false, enumerator: true };
      case 'var':
        if (ent.field) return this.fieldOf(this.thisObject(cx, n), ent, r.path, cx);
        return this.varExpr(ent, cx);
      case 'funcs': {
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
    if (m.ent.k === 'funcs') return { funcs: m.ent.list, obj, qualified, t: T.VOID, c: '', lv: false };
    if (m.ent.k === 'enumerator') return { c: String(m.ent.value), t: m.ent.type, lv: false };
    this.fail(`member '${name}' of ${obj.t.cls.name} is not a value`, n);
  },

  callExpr(n, cx) {
    const args = n.args.map((a) => this.expr(a, cx));
    // A member's conversion-function call spelt out: obj.operator T()
    if (n.fn.k === 'member' && n.fn.name.parts[n.fn.name.parts.length - 1].conv) {
      const obj = this.objectOf(n.fn, cx);
      const want = this.declType(n.fn.name.parts[n.fn.name.parts.length - 1].conv.specs, n.fn.name.parts[n.fn.name.parts.length - 1].conv.derivs, cx.env, n);
      const f = this.allConversions(obj.t.cls).find((x) => T.same(x.conv, want) && !(obj.t.c && !x.type.thisConst));
      if (!f) this.fail(`no conversion of ${obj.t.cls.name} to ${T.show(want)}`, n);
      return this.callMember(f, obj, [], cx, { node: n });
    }
    const fn = n.fn.k === 'id' && !this.lookupName(n.fn.name, cx.env) ? this.fail(`'${this.qualText(n.fn.name)}' is not declared`, n.fn) : this.expr(n.fn, cx);
    if (fn.dtorCall) {
      const d = this.dtorOf(fn.obj.t.cls);
      if (!d) return { c: '((void)0)', t: T.VOID, lv: false };
      return this.callResult(d, this.addrOf(fn.obj, cx), [], cx, { direct: false });
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
    const call = `${p.c}(${cArgs.join(', ')})`;
    if (ft.ret.k === 'ref') return { c: `(*${call})`, t: ft.ret.to, lv: true, addr: call };
    return { c: call, t: ft.ret, lv: false };
  },

  unaryExpr(n, cx) {
    const e = this.expr(n.e, cx);
    if (n.op === '&') {
      if (e.funcs && e.t.k === 'func') return { c: e.c, t: T.ptr(e.t), lv: false };
      const o = this.overloaded('&', [e], cx, n);
      if (o) return o;
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
        return { c: `(${n.op}${v.c})`, t: T.promote(v.t), lv: false };
      default: this.fail(`unary ${n.op}`, n);
    }
  },

  binaryExpr(n, cx) {
    const a0 = this.expr(n.a, cx), b0 = this.expr(n.b, cx);
    const o = this.overloaded(n.op, [a0, b0], cx, n);
    if (o) return o;
    if (n.op === '&&' || n.op === '||') return { c: `(${this.condition(a0, cx, n)} ${n.op} ${this.condition(b0, cx, n)})`, t: T.BOOL, lv: false };
    const a = this.builtinOperand(a0, cx, n), b = this.builtinOperand(b0, cx, n);
    const c = `(${a.c} ${n.op} ${b.c})`;
    if (CMP.has(n.op)) {
      const ok = (T.isArith(a.t) && T.isArith(b.t)) || (a.t.k === 'ptr' && (b.t.k === 'ptr' || b.zero)) || (b.t.k === 'ptr' && a.zero);
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
    if (n.op === '=') return { c: `(${a.c} = ${this.coerce(b, T.uncst(a.t), cx, n, 'assignment')})`, t: a.t, lv: true };
    const r = this.builtinOperand(b, cx, n);
    if (a.t.k === 'ptr' ? !(T.isInteger(r.t) && (n.op === '+=' || n.op === '-=')) : !(T.isArith(a.t) && T.isArith(r.t))) {
      this.fail(`${n.op} between ${T.show(a.t)} and ${T.show(b.t)}`, n);
    }
    return { c: `(${a.c} ${n.op} ${r.c})`, t: a.t, lv: true };
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
      if (path && path.length && !path.every((p) => p === '__b0')) {
        this.needStruct(V.to.cls);
        return { c: `((${this.ct(V)})((char *)${s.c} - (unsigned int)&((${this.ct(V)})0)->${path.join('.')}))`, t: V, lv: false };
      }
    }
    if (!T.isScalar(V) || !T.isScalar(s.t)) this.fail(`cast from ${T.show(e.t)} to ${T.show(V)}`, node);
    return { c: `((${this.ct(V)})${s.c})`, t: V, lv: false, zero: e.zero && V.k === 'ptr' && V.to.k === 'void' };
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
    if (n.count) {
      const count = this.coerce(this.expr(n.count, cx), T.UINT, cx, n);
      const ctor = cls ? this.defaultCtor(cls, n) : null, dtor = cls ? this.dtorOf(cls) : null;
      if (!ctor && !dtor) return { c: `((${this.ct(pt)})malloc(${count} * sizeof(${this.ct(t)})))`, t: pt, lv: false };
      return { c: `${this.arrayHelper(cls, 'new')}(${count})`, t: pt, lv: false };
    }
    const p = this.temp(cx, pt);
    const alloc = `${p} = (${this.ct(pt)})malloc(sizeof(${this.ct(t)}))`;
    if (!cls) {
      if (n.args && n.args.length === 1) return { c: `(${alloc}, *${p} = ${this.coerce(this.expr(n.args[0], cx), t, cx, n)}, ${p})`, t: pt, lv: false };
      if (n.args) return { c: `(${alloc}, *${p} = 0, ${p})`, t: pt, lv: false };
      return { c: `(${alloc}, ${p})`, t: pt, lv: false };
    }
    const args = (n.args ?? []).map((a) => this.expr(a, cx));
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
