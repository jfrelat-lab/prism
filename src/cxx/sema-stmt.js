// sema-stmt.js — function bodies: statements, object lifetimes, constructors and destructors, vtables,
// and the unit's global objects.
//
// LIFETIME is what C has no word for, so every exit from a scope is written out: the destructors of
// the scope's objects run, last constructed first, at its closing brace and before each `return`,
// `break` and `continue` that leaves it. A temporary dies at the end of the full expression that made
// it. A `return` in a constructor or destructor jumps to the function's end instead, so that the
// members' destructors (or nothing) still follow.

import * as T from './types.js';
import { Scope } from './sema.js';

const indent = (s) => s.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');

export const stmtMethods = {
  // ---------------------------------------------------------------- one function
  writeFunction(f) {
    if (f.written) return;
    f.written = true;
    if (!f.body && !f.implicit) this.findTemplateBody(f);
    const fn = { f, temps: [], ntemp: 0, cleanups: [], usesEnd: false };
    const base = f.cls ? f.cls.scope : (f.bodyEnv?.scope ?? this.global);
    const scope = new Scope(base);
    const env = { scope, cls: f.cls ?? null, bind: f.bodyEnv?.bind ?? f.cls?.bind ?? null };
    const cx = { env, fn, pending: [], node: f.defNode ?? f.node };
    f.type.params.forEach((p, i) => {
      const name = this.paramName(f, i);
      // A pinned class by value arrives by its address: the object is the caller's.
      scope.set(name, { k: 'var', name, type: p, cname: this.pinnedType(p) ? `(*${name})` : name });
    });
    const lines = [];
    // A parameter passed by value is the callee's object: destroyed when the function returns --
    // unless it is pinned, and the caller's.
    const top = { vars: [], kind: 'fn' };
    fn.cleanups.push(top);
    f.type.params.forEach((p, i) => { const c = this.isClassy(p); if (c && p.k === 'class' && this.dtorOf(c) && !this.pinnedType(p)) top.vars.push({ c: this.paramName(f, i), cls: c }); });
    // The named return value: when every return of a function returning a pinned class names the
    // same local, that local is built in the caller's object (`*__sret`), as g++ builds it.
    if (this.sret(f) && f.body) fn.nrvo = this.nrvoName(f.body);

    if (f.implicit) lines.push(...this.implicitBody(f, cx));
    else {
      if (f.isCtor) lines.push(...this.ctorPrologue(f, cx));
      lines.push(this.block(f.body, cx, { own: false }));
      if (f.isDtor) { lines.push(...this.dtorEpilogue(f.cls, cx)); }
    }
    lines.push(...this.destroy(top.vars, cx));
    if (fn.usesEnd) lines.push('__end: ;');
    if (f.implicit === 'assign') lines.push('return this;');
    const ret = f.type.ret;
    const needRet = fn.retUsed;
    const decls = [...fn.temps];
    if (needRet) decls.unshift(`${this.ct(ret.k === 'ref' ? T.ptr(ret.to) : ret, '__ret')};`);
    if (fn.usesEnd && ret.k !== 'void') lines.push('return __ret;');
    const split = this.splits(f);
    this.out.bodies.push(`${f.cStatic ? 'static ' : ''}${this.signature(f, split ? '__base' : '')} {\n${indent([...decls, ...lines].join('\n'))}\n}`);
    if (split) this.writeComplete(f);
  },
  /**
   * A class with virtual bases has two of each constructor and of its destructor, as the Itanium
   * ABI has: the body above is the BASE-subobject one (`__base`), which leaves the virtual bases
   * alone, and this is the COMPLETE-object one, the only one that builds or destroys them. It points
   * every `__vp` of every subobject at the one copy of its virtual base, constructs the virtual bases
   * first (with the initialiser this constructor gives them, else their default constructor), gives
   * them this class's tables, then runs the base-subobject constructor. The destructor runs the
   * base-subobject one first, then destroys the virtual bases, last constructed first.
   */
  writeComplete(f) {
    const cls = f.cls;
    if (f.type.variadic) this.fail(`${f.display}: a variadic constructor of a class with virtual bases`, f.node);
    const fn = { f, temps: [], ntemp: 0, cleanups: [{ vars: [], kind: 'fn' }], usesEnd: false };
    const scope = new Scope(cls.scope);
    const cx = { env: { scope, cls, bind: cls.bind ?? null }, fn, pending: [], node: f.defNode ?? f.node };
    f.type.params.forEach((p, i) => { const name = this.paramName(f, i); scope.set(name, { k: 'var', name, type: p, cname: name }); });
    const lines = [];
    const call = `${f.cname}__base(${['this', ...f.type.params.map((_, i) => this.paramName(f, i))].join(', ')});`;
    const vb = (v) => `this->__vb${cls.vbases.indexOf(v)}`;
    if (f.isDtor) {
      lines.push(call);
      [...cls.vbases].reverse().forEach((v) => lines.push(...this.destroy([{ c: vb(v), cls: v, base: true }], cx)));
    } else {
      // Every pointer to a virtual base, in every subobject of the complete object.
      const point = (c, at) => c.bases.forEach((b, i) => {
        if (c.virt[i]) lines.push(`this->${at}__vp${i} = (struct ${b.cname} *)&${vb(b)};`);
        else point(b, `${at}__b${i}.`);
      });
      point(cls, '');
      cls.vbases.forEach((v, k) => point(v, `__vb${k}.`));
      const inits = new Map();
      for (const i of f.inits ?? []) inits.set(this.lastName(i.name), i);
      for (const v of cls.vbases) {
        const init = inits.get(v.node?.name) ?? inits.get(v.template?.name) ?? inits.get(v.name);
        const { e, after } = this.full({ k: 'ctor' }, cx, (_m, c) => {
          // The implicit copy constructor copies them too, from the other object's.
          const args = f.implicit === 'copy' ? [{ c: `(*${this.upcastPtr('__o', this.basePath(cls, v), v)})`, t: T.cst({ k: 'class', cls: v }), lv: true }]
            : (init?.args ?? []).map((a) => this.expr(a, c));
          const pick = this.pickCtor(v, args, c, f.defNode ?? f.node);
          if (pick.copy) return { c: this.pinned(v) ? this.constructAt(`(*(struct ${v.cname} *)&${vb(v)})`, v, args, c, f.defNode ?? f.node) : `${vb(v)} = ${this.copyOf(pick.copy, v, c)};` };
          if (!pick.f) return { c: '' };
          this.use(pick.f);
          return { c: `${this.baseName(pick.f)}(${[`(struct ${v.cname} *)&${vb(v)}`, ...pick.cArgs].join(', ')});` };
        });
        if (e.c) lines.push(e.c, ...after);
      }
      if (cls.hasVptr) { this.vtableName(cls); lines.push(...cls.vbaseTables.map((t) => `this->${t.path.join('.')} = ${t.name} + 2;`)); }
      lines.push(call);
    }
    this.out.bodies.push(`${f.cStatic ? 'static ' : ''}${this.signature(f)} {\n${indent([...fn.temps, ...lines].join('\n'))}\n}`);
  },
  /** The function a subobject is built or destroyed by: the base-subobject one where there are two. */
  baseName(f) { return this.splits(f) ? `${f.cname}__base` : f.cname; },

  /** The name every return of this body returns, if it is one local declared once in it; else null. */
  nrvoName(body) {
    const returns = [], decls = new Map();
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.k === 'class' || n.k === 'func') return;            // a local class's own functions
      if (n.k === 'return') returns.push(n.e);
      if (n.k === 'decl' && n.decl?.name && n.specs?.storage !== 'static' && n.specs?.storage !== 'extern') {
        const nm = this.lastName(n.decl.name);
        decls.set(nm, (decls.get(nm) ?? 0) + 1);
      }
      for (const [k, v] of Object.entries(n)) if (k !== 'loc' && v && typeof v === 'object') walk(v);
    };
    walk(body);
    const ids = returns.map((e) => { while (e?.k === 'paren') e = e.e; return e?.k === 'id' && e.name.parts.length === 1 ? e.name.parts[0].name : null; });
    if (!ids.length || ids.some((x) => x === null || x !== ids[0])) return null;
    return decls.get(ids[0]) === 1 ? ids[0] : null;
  },
  /** The destructor calls for these objects, last first. */
  destroy(vars, cx) {
    const out = [];
    for (const v of [...vars].reverse()) {
      if (v.skip) continue;
      const d = this.dtorOf(v.cls);
      if (!d) continue;
      this.use(d);
      // A base subobject (`base`) is destroyed by the base-subobject destructor, through its part's address.
      const p = v.base ? `(struct ${d.cls.cname} *)&${v.c}` : this.upcastPtr(`&${v.c}`, this.basePath(v.cls, d.cls), d.cls);
      const dn = v.base ? this.baseName(d) : d.cname;
      if (v.count != null) out.push(`{ int __i; for (__i = ${v.count}; __i > 0; __i--) ${dn}(${this.upcastPtr(`&${v.c}[__i - 1]`, this.basePath(v.cls, d.cls), d.cls)}); }`);
      // An expression, not an if: these lines are also joined into comma expressions (valueThen).
      else if (v.guard) out.push(`((${v.guard}) ? (${dn}(${p}), 0) : 0);`);
      else out.push(`${dn}(${p});`);
    }
    return out;
  },
  /** Everything to destroy when control leaves for `target` ('fn', 'loop' or 'switch'). */
  unwind(cx, target) {
    const out = [];
    const stack = cx.fn.cleanups;
    for (let i = stack.length - 1; i >= 0; i--) {
      out.push(...this.destroy(stack[i].vars, cx));
      if (target === 'loop' && stack[i].kind === 'loop') break;
      if (target === 'switch' && (stack[i].kind === 'loop' || stack[i].kind === 'switch')) break;
    }
    return out;
  },

  // ---------------------------------------------------------------- full expressions
  /**
   * A full expression lowered, with the destructors of its temporaries: { c, e, after } where
   * `after` are the statements to run once its value has been used.
   */
  full(n, cx, lower = (m, c) => this.expr(m, c)) {
    const saved = cx.pending;
    cx.pending = [];
    try {
      const e = lower(n, cx);
      const after = this.destroy(cx.pending.map((p) => ({ c: p.name, cls: p.cls, guard: p.guard })), cx);
      return { e, after };
    } finally { cx.pending = saved; }
  },
  /** A value needed after its temporaries are gone: held in a temporary of its own if there are any. */
  valueThen(c, t, after, cx) {
    if (!after.length) return c;
    const name = this.temp(cx, T.uncst(t));
    return `(${name} = ${c}, ${after.map((s) => s.replace(/;$/, '')).join(', ')}, ${name})`;
  },
  cond(n, cx) {
    const { e, after } = this.full(n, cx, (m, c) => { const x = this.expr(m, c); return { c: this.condition(x, c, m), t: T.BOOL }; });
    return this.valueThen(e.c, T.INT, after, cx);
  },

  // ---------------------------------------------------------------- statements
  block(n, cx, { own = true, kind = 'block' } = {}) {
    const scope = new Scope(cx.env.scope);
    const inner = { ...cx, env: { ...cx.env, scope } };
    const cl = { vars: [], kind };
    cx.fn.cleanups.push(cl);
    const lines = [];
    try {
      for (const s of n.stmts) lines.push(this.stmt(s, inner));
      const last = n.stmts[n.stmts.length - 1];
      if (!last || !['return', 'break', 'continue', 'goto'].includes(last.k)) lines.push(...this.destroy(cl.vars, cx));
    } finally { cx.fn.cleanups.pop(); }
    const body = lines.filter((l) => l !== '').join('\n');
    return own ? `{\n${indent(body)}\n}` : body;
  },
  /** A statement as a loop or branch body: always a block, so that its objects have a scope. */
  body(n, cx, kind) {
    if (n.k === 'block') return this.block(n, cx, { kind });
    return this.block({ k: 'block', stmts: [n], loc: n.loc }, cx, { kind });
  },

  stmt(n, cx) {
    cx.node = n;
    // A condition that declares: the object lives in a block around the statement, assigned where
    // the condition is evaluated -- before each test, for a loop.
    const cd = n.c?.k === 'condDecl' ? n.c : null;
    if (cd && ['if', 'while', 'switch', 'for'].includes(n.k)) {
      const scope = new Scope(cx.env.scope);
      const inner = { ...cx, env: { ...cx.env, scope } };
      const decl = this.localItem({ k: 'decl', specs: cd.specs, decl: cd.decl, loc: cd.loc }, inner);
      const ent = scope.get(this.lastName(cd.decl.name));
      if (ent.type.k === 'class') this.fail('a condition that declares an object of class type', n);
      const id = { k: 'id', name: cd.decl.name, loc: cd.loc };
      const c = n.k === 'if' || n.k === 'switch' ? null : { k: 'comma', a: { k: 'assign', op: '=', a: id, b: cd.init, loc: cd.loc }, b: id, loc: cd.loc };
      const pre = c ? '' : this.stmt({ k: 'expr', e: { k: 'assign', op: '=', a: id, b: cd.init, loc: cd.loc }, loc: cd.loc }, inner);
      return `{\n${indent([decl, pre, this.stmt({ ...n, c: c ?? id }, inner)].filter(Boolean).join('\n'))}\n}`;
    }
    switch (n.k) {
      case 'null': return ';';
      case 'block': return this.block(n, cx);
      case 'expr': {
        const { e, after } = this.full(n.e, cx, (m, c) => {
          const x = this.expr(m, c);
          // A class value nobody takes is still an object, to be destroyed.
          if (x.t.k === 'class' && !x.lv && !x.addr && this.dtorOf(x.t.cls)) return this.materialize(x, c);
          return x;
        });
        return [`${e.c || '0'};`, ...after].join('\n');
      }
      case 'decl': return n.items.map((it) => this.localItem(it, cx)).filter(Boolean).join('\n');
      case 'if': {
        const c = this.cond(n.c, cx);
        return `if (${c}) ${this.body(n.a, cx)}${n.b ? ` else ${this.body(n.b, cx)}` : ''}`;
      }
      case 'while': return `while (${this.cond(n.c, cx)}) ${this.body(n.body, cx, 'loop')}`;
      case 'do': { const b = this.body(n.body, cx, 'loop'); return `do ${b} while (${this.cond(n.c, cx)});`; }
      case 'for': {
        const scope = new Scope(cx.env.scope);
        const inner = { ...cx, env: { ...cx.env, scope } };
        const cl = { vars: [], kind: 'block' };
        cx.fn.cleanups.push(cl);
        try {
          const init = n.init ? this.stmt(n.init, inner) : '';
          const c = n.c ? this.cond(n.c, inner) : '';
          let step = '';
          if (n.step) { const { e, after } = this.full(n.step, inner); step = [e.c, ...after.map((s) => s.replace(/;$/, ''))].join(', '); }
          const b = this.body(n.body, inner, 'loop');
          return `{\n${indent([init, `for (; ${c}; ${step}) ${b}`, ...this.destroy(cl.vars, cx)].filter(Boolean).join('\n'))}\n}`;
        } finally { cx.fn.cleanups.pop(); }
      }
      case 'switch': {
        const { e, after } = this.full(n.c, cx, (m, c) => this.builtinOperand(this.expr(m, c), c, m));
        return `switch (${this.valueThen(e.c, e.t, after, cx)}) ${this.body(n.body, cx, 'switch')}`;
      }
      case 'case': { const v = this.constInt(n.e, cx.env); if (v === null) this.fail('a case label that is not a constant', n); return `case ${v}:;`; }
      case 'default': return 'default:;';
      case 'break': return [...this.unwind(cx, 'switch'), 'break;'].join('\n');
      case 'continue': return [...this.unwind(cx, 'loop'), 'continue;'].join('\n');
      case 'goto': return `goto ${n.name};`;
      // C wants a statement after a label where C++ allows a declaration: an empty one goes between.
      case 'label': return `${n.name}: ${n.s.k === 'decl' ? ';\n' : ''}${this.stmt(n.s, cx)}`;
      case 'return': return this.returnStmt(n, cx);
      case 'using': this.using(n.item, cx.env.scope, cx.env); return '';
      default: this.fail(`statement ${n.k}`, n);
    }
  },

  returnStmt(n, cx) {
    const f = cx.fn.f;
    const ret = f.type.ret;
    // A constructor or destructor returns through its end, where the members are still to be handled.
    if (f.isCtor || f.isDtor) { cx.fn.usesEnd = true; return [...this.unwindKeepingFn(cx), 'goto __end;'].join('\n'); }
    if (!n.e) return [...this.unwind(cx, 'fn'), 'return;'].join('\n');
    if (ret.k === 'void') {
      const { e, after } = this.full(n.e, cx);
      return [`${e.c};`, ...after, ...this.unwind(cx, 'fn'), 'return;'].join('\n');
    }
    if (this.sret(f)) {
      // Built in the caller's object: the named return value is already there; anything else is
      // made there (a temporary of the class renamed to it, or a copy).
      let x = n.e;
      while (x?.k === 'paren') x = x.e;
      // Only a local actually built there: the name alone is not enough -- detection.cpp's
      // `char buf[128]; ...; return buf;` returns a String made from it.
      if (cx.fn.nrvo && x?.k === 'id' && x.name.parts.length === 1 && x.name.parts[0].name === cx.fn.nrvo && this.lookupName(x.name, cx.env)?.ent?.cname === '(*__sret)') {
        return [...this.unwind(cx, 'fn'), 'return;'].join('\n');
      }
      const { e, after } = this.full(n.e, cx, (m, c) => ({ c: this.constructAt('(*__sret)', ret.cls, [this.expr(m, c)], c, m) }));
      return [e.c, ...after, ...this.unwind(cx, 'fn'), 'return;'].join('\n');
    }
    // Returning a local object by name hands it over: no copy, and it is not destroyed here.
    let moved = null;
    if (ret.k === 'class' && (n.e.k === 'id' || (n.e.k === 'paren' && n.e.e.k === 'id'))) {
      const id = n.e.k === 'id' ? n.e : n.e.e;
      const r = this.lookupName(id.name, cx.env);
      if (r?.ent.k === 'var' && r.ent.local && r.ent.type.k === 'class' && r.ent.type.cls === ret.cls && !r.ent.isStatic) moved = r.ent;
    }
    const { e, after } = this.full(n.e, cx, (m, c) => {
      if (moved) return { c: moved.cname, t: ret };
      const x = this.expr(m, c);
      return { c: this.coerce(x, ret, c, m, 'return conversion'), t: ret };
    });
    if (moved) {
      for (const cl of cx.fn.cleanups) for (const v of cl.vars) if (v.ent === moved) v.skip = true;
    }
    const un = this.unwind(cx, 'fn');
    if (moved) for (const cl of cx.fn.cleanups) for (const v of cl.vars) if (v.ent === moved) v.skip = false;
    if (!after.length && !un.length) return `return ${e.c};`;
    cx.fn.retUsed = true;
    return `{ __ret = ${e.c}; ${[...after, ...un].join(' ')} return __ret; }`;
  },
  unwindKeepingFn(cx) {
    // Everything but the function's own top scope, which the end of the function destroys.
    const out = [];
    const stack = cx.fn.cleanups;
    for (let i = stack.length - 1; i >= 1; i--) out.push(...this.destroy(stack[i].vars, cx));
    return out;
  },

  // ---------------------------------------------------------------- local declarations
  localItem(it, cx) {
    switch (it.k) {
      case 'class': this.declareClass(it, cx.env); return '';
      case 'enum': this.declareEnum(it, cx.env); return '';
      case 'typedef': cx.env.scope.set(this.lastName(it.decl.name), { k: 'type', type: this.declType(it.specs, it.decl.derivs, cx.env, it) }); return '';
      case 'decl': break;
      default: this.fail(`${it.k} inside a function`, it);
    }
    if (!it.decl.name) return '';
    if (it.decl.derivs.length && it.decl.derivs[it.decl.derivs.length - 1].k === 'func') { this.declareFunction(it, { ...cx.env, scope: cx.env.scope }); return ''; }
    const name = this.lastName(it.decl.name);
    let type = this.declType(it.specs, it.decl.derivs, cx.env, it);
    if (type.k === 'array' && type.n == null && it.init?.k === 'braces') type = T.array(type.of, it.init.items.length);
    if (type.k === 'array' && type.n == null && it.init?.k === 'str') type = T.array(type.of, this.stringLength(it.init) + 1);
    const isStatic = it.specs.storage === 'static';
    if (it.specs.storage === 'extern') {
      const g = this.global.get(name) ?? this.global.set(name, { k: 'var', name, type, cname: name, global: true, externOnly: true });
      cx.env.scope.set(name, g);
      return '';
    }
    const ent = { k: 'var', name, type, cname: name, local: true, isStatic };
    const cl = cx.fn.cleanups[cx.fn.cleanups.length - 1];
    const st = isStatic ? 'static ' : '';
    const done = (text) => { cx.env.scope.set(name, ent); return text; };
    if (type.c && T.isInteger(type) && it.init) { const v = this.constInt(it.init, cx.env); if (v !== null) ent.constValue = v; }

    if (type.k === 'ref') {
      if (!it.init && !it.ctorArgs) this.fail(`reference '${name}' is not initialised`, it);
      // A temporary bound to a reference lives as long as the reference: it joins this scope's objects.
      const saved = cx.pending;
      cx.pending = [];
      let c;
      try { c = this.coerce(this.expr(it.init ?? it.ctorArgs[0], cx), type, cx, it, 'reference binding'); for (const p of cx.pending) cl.vars.push({ c: p.name, cls: p.cls, guard: p.guard }); } finally { cx.pending = saved; }
      return done(`${this.ct(T.ptr(type.to), name)} = ${c};`);
    }
    const cls = type.k === 'class' ? this.complete(type.cls, it) : null;
    if (cls) {
      const decl = `${st}${this.ct(T.uncst(type), name)}`;
      const d = this.dtorOf(cls);
      // `static ActorFrameRange def = {0, 0};` (saga): an aggregate's braces are C's; what is not
      // constant among them is assigned the first time control passes.
      if (isStatic && it.init?.k === 'braces' && this.isCxxAggregate(cls)) {
        const dynFix = [];
        const text = this.bracesInit(it.init, type, { env: cx.env, fn: null, pending: [], constOnly: true, node: it, dynFix });
        if (!dynFix.length) return done(`${decl} = ${text};`);
        const g = `__guard_${name}_${++this.anon}`;
        cx.env.scope.set(name, ent);
        const sets = dynFix.map((dx) => { const { e, after } = this.full(dx.x, cx, (m, c) => ({ c: this.dynSet(`${name}${dx.path.join('')}`, dx.type, this.expr(m, c), c, m) })); return [e.c, ...after].join(' '); });
        return [`static ${this.ct(T.uncst(type), name)} = ${text};`, `static int ${g};`, `if (!${g}) { ${g} = 1; ${sets.join(' ')} }`].join('\n');
      }
      if (isStatic) return done(this.staticLocal(ent, it, cx, decl, cls));
      // A pinned object is built where it lives -- in the caller's object when it is the named
      // return value, which is then not destroyed here.
      if (this.pinned(cls) && it.init?.k !== 'braces') {
        const nrvo = cx.fn.nrvo === name && this.sret(cx.fn.f) && cx.fn.f.type.ret.cls === cls;
        const dest = nrvo ? '(*__sret)' : name;
        if (nrvo) ent.cname = dest;
        else if (d) cl.vars.push({ c: name, cls, ent });
        const { e, after } = this.full({ k: 'ctor' }, cx, (_m, c) => {
          const args = it.ctorArgs ? it.ctorArgs.map((a) => this.expr(a, c)) : it.init ? [this.expr(it.init, c)] : [];
          return { c: this.constructAt(dest, cls, args, c, it) };
        });
        cx.env.scope.set(name, ent);
        return [nrvo ? '' : `${decl};`, e.c, ...after].filter(Boolean).join('\n');
      }
      if (d) cl.vars.push({ c: name, cls, ent });
      if (it.init && !it.ctorArgs) {
        if (it.init.k === 'braces') return done(`${decl} = ${this.bracesInit(it.init, type, cx)};`);
        const { e, after } = this.full(it.init, cx, (m, c) => ({ c: this.coerce(this.expr(m, c), T.uncst(type), c, m, 'initialisation'), t: type }));
        return done([`${decl} = ${e.c};`, ...after].join('\n'));
      }
      const { e, after } = this.full({ k: 'ctor' }, cx, (_m, c) => {
        const args = (it.ctorArgs ?? []).map((a) => this.expr(a, c));
        const pick = this.pickCtor(cls, args, c, it);
        if (pick.copy) return { c: `${name} = ${this.copyOf(pick.copy, cls, c)};` };
        if (!pick.f) return { c: '' };
        this.use(pick.f);
        return { c: `${pick.f.cname}(${[`&${name}`, ...pick.cArgs].join(', ')});` };
      });
      cx.env.scope.set(name, ent);
      return [`${decl};`, e.c, ...after].filter(Boolean).join('\n');
    }
    const elem = this.isClassy(type);
    if (type.k === 'array' && elem && it.init?.k === 'braces' && this.isAggregate(elem)) return done(`${st}${this.ct(type, name)} = ${this.bracesInit(it.init, type, cx)};`);
    if (type.k === 'array' && elem) {
      if (type.of.k !== 'class') this.fail('an array of arrays of objects', it);
      const d = this.dtorOf(elem);
      if (it.init?.k === 'braces') {
        // Built element by element; a static one the first time control passes it, as C++ says.
        const decl = `${st}${this.ct(T.array(T.uncst(type.of), type.n), name)};`;
        if (isStatic) {
          const id = ++this.anon;
          const g = `__guard_${name}_${id}`;
          if (!d) return done(`${decl}\nstatic int ${g};\nif (!${g}) {\n  ${g} = 1;\n${this.arrayFromBraces(name, type, it.init.items, cx, it).map((l) => `  ${l}`).join('\n')}\n}`);
          // With a destructor, kept at file scope (as staticLocal keeps one object) so that the
          // function atexit runs can reach it: destroyed at exit if it was ever built.
          ent.cname = `__static_${name}_${id}`;
          this.out.vars.push(`static ${this.ct(T.array(T.uncst(type.of), type.n), ent.cname)};`, `static int ${g};`);
          const fini = `__fini_${ent.cname}`;
          this.out.protos.push(`static void ${fini}(void);`);
          this.out.bodies.push(`static void ${fini}(void) {\n${this.destroy([{ c: ent.cname, cls: elem, count: type.n }], this.initContext(cx.env)).map((l) => `  ${l}`).join('\n')}\n}`);
          this.needAtexit = true;
          return done(`if (!${g}) {\n  ${g} = 1;\n${this.arrayFromBraces(ent.cname, type, it.init.items, cx, it).map((l) => `  ${l}`).join('\n')}\n  atexit(${fini});\n}`);
        }
        if (d) cl.vars.push({ c: name, cls: elem, count: type.n });
        return done([decl, ...this.arrayFromBraces(name, type, it.init.items, cx, it)].join('\n'));
      }
      const ctor = this.defaultCtor(elem, it);
      if (d) cl.vars.push({ c: name, cls: elem, count: type.n });
      const decl = `${st}${this.ct(type, name)};`;
      if (it.init) this.fail('an initialised array of objects', it);
      if (!ctor) return done(decl);
      this.use(ctor);
      return done(`${decl}\n{ int __i; for (__i = 0; __i < ${type.n}; __i++) ${ctor.cname}(${[`&${name}[__i]`, ...this.defaultArgs(ctor, 0, cx)].join(', ')}); }`);
    }
    const decl = `${st}${this.ct(type, name)}`;
    if (it.ctorArgs) {
      if (it.ctorArgs.length !== 1) this.fail(`'${name}' initialised with ${it.ctorArgs.length} values`, it);
      it = { ...it, init: it.ctorArgs[0] };
    }
    if (!it.init) return done(`${decl};`);
    if (it.init.k === 'braces') return done(`${decl} = ${this.bracesInit(it.init, type, cx)};`);
    if (type.k === 'array') {
      if (it.init.k !== 'str') this.fail('an array initialised by an expression', it);
      return done(`${decl} = ${it.init.parts.join(' ')};`);
    }
    // The name is in scope in its own initialiser (`int x = x;` is legal, if useless).
    if (isStatic) {
      // A static whose initialiser is no constant is initialised the first time control passes it
      // (gob's `static char *slotBase = _saveFiles[0] + strlen(_saveFiles[0]) - 2;`).
      const probe = { env: cx.env, fn: null, pending: [], constOnly: true, node: it };
      let c = null;
      // No constant, whatever the reason: the guarded path says what is wrong, if anything is.
      try { c = this.coerce(this.expr(it.init, probe), T.uncst(type), probe, it, 'initialisation'); } catch { c = null; }
      if (probe.dynamic || c === null || this.readsVariable(it.init, cx.env)) {
        const g = `__guard_${name}_${++this.anon}`;
        cx.env.scope.set(name, ent);
        const { e, after } = this.full(it.init, cx, (m, cc) => ({ c: this.coerce(this.expr(m, cc), T.uncst(type), cc, m, 'initialisation'), t: type }));
        return [`static ${this.ct(T.uncst(type), name)};`, `static int ${g};`, `if (!${g}) { ${g} = 1; ${name} = ${e.c}; ${after.join(' ')} }`].join('\n');
      }
    }
    const { e, after } = this.full(it.init, cx, (m, c) => ({ c: this.coerce(this.expr(m, c), T.uncst(type), c, m, 'initialisation'), t: type }));
    return done([`${decl} = ${e.c};`, ...after].join('\n'));
  },
  /** A function's static object of class type: constructed the first time control passes it. */
  staticLocal(ent, it, cx, _decl, cls) {
    // Kept at file scope under a name of its own, so that the function registered with atexit can
    // reach it: it is destroyed at exit if control ever passed its definition, after main's globals
    // were registered and so before them.
    const id = ++this.anon;
    const g = `__guard_${ent.cname}_${id}`;
    ent.cname = `__static_${ent.cname}_${id}`;
    this.out.vars.push(`static ${this.ct({ k: 'class', cls }, ent.cname)};`, `static int ${g};`);
    const d = this.dtorOf(cls);
    let reg = '';
    if (d) {
      this.use(d); this.needAtexit = true;
      this.out.bodies.push(`static void __fini_${ent.cname}(void) { ${d.cname}(${this.upcastPtr(`&${ent.cname}`, this.basePath(cls, d.cls), d.cls)}); }`);
      this.out.protos.push(`static void __fini_${ent.cname}(void);`);
      reg = ` atexit(__fini_${ent.cname});`;
    }
    const args = (it.ctorArgs ?? (it.init ? [it.init] : [])).map((a) => this.expr(a, cx));
    const pick = this.pickCtor(cls, args, cx, it);
    const init = pick.copy ? (this.pinned(cls) ? this.constructAt(ent.cname, cls, args, cx, it) : `${ent.cname} = ${this.copyOf(pick.copy, cls, cx)};`) : pick.f ? (this.use(pick.f), `${pick.f.cname}(${[`&${ent.cname}`, ...pick.cArgs].join(', ')});`) : '';
    return `if (!${g}) { ${g} = 1; ${init}${reg} }`;
  },
  /** Does an initialiser read the value of a variable (as opposed to taking an address, or a constant)? */
  readsVariable(x, env) {
    switch (x.k) {
      case 'paren': case 'cast': return this.readsVariable(x.e, env);
      case 'id': {
        const r = this.lookupName(x.name, env);
        const e = r?.ent;
        return e?.k === 'var' && !e.field && e.constValue === undefined && e.type.k !== 'array' && e.type.k !== 'func';
      }
      case 'bin': return this.readsVariable(x.a, env) || this.readsVariable(x.b, env);
      case 'unary': return x.op !== '&' && this.readsVariable(x.e, env);
      default: return false;
    }
  },
  /** A class C initialises with braces: no constructor, base or virtual function, none in its members. */
  isAggregate(cls) {
    this.complete(cls, cls.node);
    return !cls.ctors.length && !cls.bases.length && !cls.hasVptr && !this.needsCtor(cls) && !this.needsDtor(cls);
  },
  /**
   * An aggregate as C++ means it -- no constructor, base or virtual function of its own -- whose
   * members may still be objects with constructors: saga's `{ 0, Point(0, -1) }`. With braces, those
   * members are assigned the values the braces give.
   */
  isCxxAggregate(cls) {
    this.complete(cls, cls.node);
    return !cls.ctors.length && !cls.ctorTemplates?.length && !cls.bases.length && !cls.hasVptr && !this.needsDtor(cls);
  },
  /**
   * The statements that build an array of objects from braces, element by element: each one
   * copy-initialised from its expression (kyra's `static const OpcodeV1 opcodeTable[] = {
   * OpcodeV1(this, &KyraEngine_v1::o1_magicInMouseItem), ... }`), the rest default-constructed.
   */
  arrayFromBraces(target, type, items, cx, node) {
    const elem = type.of.cls;
    const lines = [];
    items.forEach((x, i) => {
      if (x.k === 'braces') this.fail(`${elem.name} has constructors: braces cannot initialise it`, node);
      // Copy-initialised in place: a pinned element's temporary is built there.
      const { e, after } = this.full(x, cx, (m, c) => ({ c: this.constructAt(`${target}[${i}]`, elem, [this.expr(m, c)], c, m) }));
      lines.push(e.c, ...after);
    });
    const ctor = items.length < type.n ? this.defaultCtor(elem, node) : null;
    if (ctor) { this.use(ctor); lines.push(`{ int __i; for (__i = ${items.length}; __i < ${type.n}; __i++) ${ctor.cname}(${[`&${target}[__i]`, ...this.defaultArgs(ctor, 0, cx)].join(', ')}); }`); }
    return lines;
  },
  /** An element of braces assigned before main: a pinned object built in place, anything else assigned. */
  dynSet(dest, type, x, cx, node) {
    if (this.pinnedType(T.uncst(type))) return this.constructAt(dest, T.uncst(type).cls, [x], cx, node);
    return `${dest} = ${this.coerce(x, T.uncst(type), cx, node, 'initialisation')};`;
  },
  /** `{ ... }` for an aggregate: each element converted to its member's or element's type. */
  bracesInit(b, type, cx, path = []) {
    if (type.k === 'array') {
      return `{ ${b.items.map((x, i) => this.initElem(x, type.of, cx, [...path, `[${i}]`])).join(', ')} }`;
    }
    if (type.k === 'class') {
      const cls = this.complete(type.cls, b);
      if (cls.ctors.length || cls.bases.length || cls.hasVptr) this.fail(`${cls.name} is not an aggregate`, cx.node);
      return `{ ${b.items.map((x, i) => this.initElem(x, cls.fields[i]?.type ?? this.fail('too many initialisers', cx.node), cx, [...path, `.${cls.fields[i].cname}`])).join(', ')} }`;
    }
    if (b.items.length === 1) return this.initElem(b.items[0], type, cx, path);
    this.fail('braces initialising a scalar', cx.node);
  },
  initElem(x, type, cx, path = []) {
    if (x.k === 'braces') return this.bracesInit(x, type, cx, path);
    if (type.k === 'array' && x.k === 'str') return x.parts.join(' ');
    /*
     * At file scope, an element that reads a variable -- `Compact left_exit_rm2 = { ..., left_table2 }`,
     * left_table2 a pointer initialised elsewhere -- is not a constant in C. C++ initialises it before
     * main: the element is written as 0 here and assigned in the unit's initialisation function.
     */
    // ...and so is one that runs code: saga's `{ 0, Point(0, -1) }` constructs a Point.
    const runs = () => {
      const probe = { ...cx, pending: [], dynamic: false, dynFix: null };
      try { this.coerce(this.expr(x, probe), T.uncst(type), probe, cx.node, 'initialisation'); } catch { return true; }
      return probe.dynamic;
    };
    if (cx.dynFix && (this.readsVariable(x, cx.env) || (type.k !== 'array' && runs()))) {
      cx.dynFix.push({ path, x, type });
      return type.k === 'class' ? '{ 0 }' : '0';
    }
    if (type.k === 'array' && x.k === 'str') return x.parts.join(' ');
    if (type.k === 'array' || (type.k === 'class' && !this.convert(this.expr(x, { ...cx, pending: [] }), T.uncst(type), cx))) this.fail('an initialiser without its braces', cx.node);
    return this.coerce(this.expr(x, cx), T.uncst(type), cx, cx.node, 'initialisation');
  },

  // ---------------------------------------------------------------- constructors and destructors
  /**
   * The class's tables, written once per unit. Each is laid out as the Itanium ABI lays one: the
   * offset from the subobject it serves to the whole object, the class's type descriptor, then the
   * slots -- and the vptr points at the first slot, so a call indexes it as it always did.
   */
  vtableName(cls) {
    const name = `__vtbl_${cls.cname}`;
    if (!cls.vtableDone) {
      cls.vtableDone = true;
      this.needStruct(cls);
      const ti = this.typeinfo(cls);
      const slots = cls.vtable.map((f) => {
        if (f.pure && !f.body) return '0';
        // A class that declares no destructor under a virtual one still has its own to run.
        if (f.isDtor && f.cls !== cls) { const d = this.dtorOf(cls); if (d && d !== f) { d.isVirtual = true; d.vindex = f.vindex; f = d; } }
        // A destructor never declared is still a destructor to call: the implicit one.
        this.use(f);
        return `(void *)${f.cname}`;
      });
      this.out.vtables.push(`static void *${name}[${slots.length + 2}] = { ${['(void *)0', `(void *)&${ti}`, ...slots].join(', ')} };`);
      const groups = this.secondaryGroups(cls);
      cls.secondaryTables = groups.map((g, gi) => this.secondaryTable(cls, g, gi, ti));
      // The tables of the virtual bases' subobjects: set by the complete object's constructor only.
      cls.vbaseTables = this.vbaseGroups(cls).map((g, k) => this.secondaryTable(cls, g, groups.length + k, ti));
    }
    return name;
  },
  /**
   * The final overrider in class c of virtual function f, searched below f's class: c's own, else
   * one a base of c on the way to f's class has -- the dominance rule, which with a virtual base can
   * pick a function from a sibling path. Null when nothing below f's class overrides it.
   */
  finalOverrider(c, f) {
    const m = c.methods.find((x) => !x.isCtor && !x.isDtor && this.overrides(x, f));
    if (m) return m;
    for (const b of c.bases) {
      if (b === f.cls || !this.basePath(b, f.cls)) continue;
      const r = this.finalOverrider(b, f);
      if (r) return r;
    }
    return null;
  },
  /**
   * The table of one secondary subobject g of cls: g's own layout, each slot cls's final overrider.
   * An overrider declared below g (in cls, or between) expects `this` to point at ITS class, so the
   * slot holds a thunk that moves the pointer from g's subobject to there.
   */
  secondaryTable(cls, g, gi, ti) {
    const name = `__vtbl_${cls.cname}_${gi}`;
    const st = (c) => `struct ${c.cname}`;
    const off = (path) => (path.length ? `(int)(unsigned int)&((${st(cls)} *)0)->${path.join('.')}` : '0');
    // The classes from cls down to g, along g's path.
    const chain = [cls];
    if (!g.virtual) for (const seg of g.xpath) chain.push(chain[chain.length - 1].bases[+seg.slice(3)]);
    const slots = g.cls.vtable.map((f, j) => {
      let final = null, at = -1;
      if (f.isDtor) { final = this.dtorOf(cls); at = 0; }
      // In a virtual base, the overrider may be anywhere below it, reached through any path.
      else if (g.virtual) { final = this.finalOverrider(cls, f); at = final?.cls === cls ? 0 : 1; }
      else for (let c = 0; c < chain.length - 1 && !final; c++) { const m = chain[c].methods.find((x) => !x.isCtor && !x.isDtor && this.overrides(x, f)); if (m) { final = m; at = c; } }
      if (!final) {
        if (f.pure && !f.body) return '0';
        this.use(f);
        return `(void *)${f.cname}`;
      }
      // A pure virtual overrider with no body leaves the slot empty, as in the class's own table
      // (scumm's BaseScummFile::read, pure, overriding ReadStream's in a virtual base).
      if (final.pure && !final.body) return '0';
      this.use(final);
      const thunk = `__thunk_${cls.cname}_${gi}_${j}`;
      // The C signature is the function's: a pinned result through __sret, pinned arguments by address, all passed on.
      const sret = this.sret(f);
      const ps = [...(sret ? [this.ct(T.ptr(T.uncst(f.type.ret)), '__sret')] : []), ...f.type.params.map((p, i) => this.ct(this.cParamType(p), `__a${i}`))];
      const ret = sret ? T.VOID : f.type.ret.k === 'ref' ? T.ptr(f.type.ret.to) : f.type.ret;
      const sig = this.ct(ret, `${thunk}(${['void *__self', ...ps].join(', ')})`);
      const top = `((${st(cls)} *)((char *)__self - ${off(g.xpath)}))`;
      const target = at === 0 ? top : g.virtual ? this.upcastPtr(top, this.basePath(cls, final.cls), final.cls)
        : `(&${top}->${g.xpath.slice(0, at).join('.')})`;
      const call = `${final.cname}(${[`(${st(final.cls)} *)${target}`, ...(sret ? ['__sret'] : []), ...f.type.params.map((_, i) => `__a${i}`)].join(', ')})`;
      this.out.protos.push(`static ${sig};`);
      this.out.bodies.push(`static ${sig} {\n  ${ret.k === 'void' ? '' : 'return '}${call};\n}`);
      return `(void *)${thunk}`;
    });
    this.out.vtables.push(`static void *${name}[${slots.length + 2}] = { ${[`(void *)(-${off(g.xpath)})`, `(void *)&${ti}`, ...slots].join(', ')} };`);
    return { name, path: [...g.xpath, ...this.vptrPath(g.cls), '__vptr'] };
  },
  /**
   * A class's type descriptor, for dynamic_cast: its name and its bases at their offsets. Each unit
   * writes its own, so two are the same class when their NAMES are equal, not their addresses.
   */
  typeinfo(cls, part = false) {
    // With virtual bases, the descriptor of the class as a BASE lists its other bases only; the
    // complete object's adds each virtual base once, at its place in the complete object.
    part = part && cls.vbases.length > 0;
    const name = `__ti_${cls.cname}${part ? '__p' : ''}`;
    const done = part ? 'typeinfoPartDone' : 'typeinfoDone';
    if (cls[done]) return name;
    cls[done] = true;
    this.needStruct(cls);
    if (!this.tiDeclared) {
      this.tiDeclared = true;
      this.out.types.push('struct __prism_ti;\nstruct __prism_ti_base { const struct __prism_ti *ti; int off; };\nstruct __prism_ti { const char *name; int n; const struct __prism_ti_base *b; };');
    }
    const at = (m) => `(int)(unsigned int)&((struct ${part ? this.partName(cls) : cls.cname} *)0)->${m}`;
    const bases = cls.bases.flatMap((b, i) => (cls.virt[i] ? [] : [`{ &${this.typeinfo(b, true)}, ${at(`__b${i}`)} }`]));
    if (!part) cls.vbases.forEach((v, k) => bases.push(`{ &${this.typeinfo(v, true)}, ${at(`__vb${k}`)} }`));
    this.out.vars.push(`static const struct __prism_ti_base ${name}_b[${bases.length || 1}] = { ${bases.length ? bases.join(', ') : '{ 0, 0 }'} };`,
      `static const struct __prism_ti ${name} = { "${cls.cname}", ${bases.length}, ${name}_b };`);
    return name;
  },
  setVptr(cls) {
    if (!cls.hasVptr) return [];
    const name = this.vtableName(cls);
    return [
      `this->${[...this.vptrPath(cls), '__vptr'].join('.')} = ${name} + 2;`,
      ...cls.secondaryTables.map((t) => `this->${t.path.join('.')} = ${t.name} + 2;`),
    ];
  },
  /** Bases, then the vptr, then members in the order they are declared -- whatever order the list is in. */
  ctorPrologue(f, cx) {
    const cls = f.cls;
    const lines = [];
    const inits = new Map();
    for (const i of f.inits ?? []) inits.set(this.lastName(i.name), i);
    cls.bases.forEach((b, bi) => {
      if (cls.virt[bi]) return;              // built by the complete object's constructor (writeComplete)
      const init = inits.get(b.node?.name) ?? inits.get(b.template?.name) ?? inits.get(b.name);
      const { e, after } = this.full({ k: 'ctor' }, cx, (_m, c) => {
        const args = (init?.args ?? []).map((a) => this.expr(a, c));
        const pick = this.pickCtor(b, args, c, f.defNode);
        if (pick.copy && this.pinned(b)) {
          // Never moved by its bytes: copied by the base-subobject copy constructor, in place.
          const cc = this.copyCtorOf(b);
          this.use(cc);
          return { c: `${this.baseName(cc)}(${[`(struct ${b.cname} *)&this->__b${bi}`, this.upcastPtr(this.addrOf(pick.copy, c), this.basePath(pick.copy.t.cls, b), b), ...this.defaultArgs(cc, 1, c)].join(', ')});` };
        }
        if (pick.copy) return { c: `this->__b${bi} = ${this.copyOf(pick.copy, b, c)};` };
        if (!pick.f) return { c: '' };
        this.use(pick.f);
        return { c: `${this.baseName(pick.f)}(${[`(struct ${b.cname} *)&this->__b${bi}`, ...pick.cArgs].join(', ')});` };
      });
      if (e.c) lines.push(e.c, ...after);
    });
    lines.push(...this.setVptr(cls));
    for (const fld of cls.fields) {
      const init = fld.name ? inits.get(fld.name) : null;
      const target = `this->${fld.cname}`;
      const c = this.isClassy(fld.type);
      if (fld.type.k === 'class') {
        const { e, after } = this.full({ k: 'ctor' }, cx, (_m, cc) => {
          const args = (init?.args ?? []).map((a) => this.expr(a, cc));
          const pick = this.pickCtor(c, args, cc, f.defNode);
          if (pick.copy) return { c: this.pinned(c) ? this.constructAt(target, c, args, cc, f.defNode) : `${target} = ${this.copyOf(pick.copy, c, cc)};` };
          if (!pick.f) return { c: '' };
          this.use(pick.f);
          return { c: `${pick.f.cname}(${[`&${target}`, ...pick.cArgs].join(', ')});` };
        });
        if (e.c) lines.push(e.c, ...after);
      } else if (fld.type.k === 'array' && c) {
        const ctor = this.defaultCtor(c, f.defNode);
        if (ctor) { this.use(ctor); lines.push(`{ int __i; for (__i = 0; __i < ${fld.type.n}; __i++) ${ctor.cname}(${[`&${target}[__i]`, ...this.defaultArgs(ctor, 0, cx)].join(', ')}); }`); }
      } else if (init && !init.args.length) {
        // `_defaultVal()`, `_fonts()`: value-initialised, which for a scalar or an array of them is zero.
        lines.push(fld.type.k === 'array' ? `{ unsigned int __i; for (__i = 0; __i < sizeof(${target}); __i++) ((char *)${target})[__i] = 0; }` : `${target} = 0;`);
      } else if (init) {
        if (init.args.length !== 1) this.fail(`member ${fld.name} initialised with ${init.args.length} values`, f.defNode);
        const { e, after } = this.full(init.args[0], cx, (m, cc) => ({ c: this.coerce(this.expr(m, cc), fld.type.k === 'ref' ? fld.type : T.uncst(fld.type), cc, m, 'member initialisation'), t: fld.type }));
        lines.push(`${target} = ${e.c};`, ...after);
      }
    }
    return lines;
  },
  dtorEpilogue(cls, cx) {
    const lines = [];
    if (cx.fn.usesEnd) { lines.push('__end: ;'); cx.fn.usesEnd = false; }
    for (const fld of [...cls.fields].reverse()) {
      const c = this.isClassy(fld.type);
      if (!c) continue;
      lines.push(...this.destroy([{ c: `this->${fld.cname}`, cls: c, count: fld.type.k === 'array' ? fld.type.n : null }], cx));
    }
    [...cls.bases].map((b, i) => [b, i]).reverse().forEach(([b, i]) => { if (!cls.virt[i]) lines.push(...this.destroy([{ c: `this->__b${i}`, cls: b, base: true }], cx)); });
    return lines;
  },
  /** The body of a member the class never declared: what the language says it does. */
  implicitBody(f, cx) {
    const cls = f.cls;
    const lines = [];
    const o = f.implicit === 'copy' || f.implicit === 'assign' ? '__o' : null;
    if (f.implicit === 'ctor') return this.ctorPrologue({ ...f, inits: [] }, cx);
    if (f.implicit === 'dtor') return this.dtorEpilogue(cls, cx);
    cls.bases.forEach((b, i) => {
      // A virtual base is copied by the complete object's constructor (writeComplete), and assigned
      // here through its pointer -- once per path to it, as g++'s implicit operator= does too.
      if (cls.virt[i]) { if (f.implicit === 'assign') lines.push(this.assignStmt(b, `this->__vp${i}[0]`, `${o}->__vp${i}[0]`, cx)); return; }
      const st = `struct ${b.cname} *`;
      const src = `(${st})&${o}->__b${i}`, dst = `(${st})&this->__b${i}`;
      if (f.implicit === 'copy') {
        const cc = this.copyCtorOf(b);
        if (cc) { this.use(cc); lines.push(`${this.baseName(cc)}(${[dst, src, ...this.defaultArgs(cc, 1, cx)].join(', ')});`); } else lines.push(`this->__b${i} = ${o}->__b${i};`);
      } else lines.push(this.assignStmt(b, b.vbases.length ? `(*${dst})` : `this->__b${i}`, b.vbases.length ? `(*${src})` : `${o}->__b${i}`, cx));
    });
    if (f.implicit === 'copy') lines.push(...this.setVptr(cls));
    for (const fld of cls.fields) {
      const dst = `this->${fld.cname}`, src = `${o}->${fld.cname}`;
      const c = this.isClassy(fld.type);
      if (fld.type.k === 'array') {
        if (c && (f.implicit === 'copy' ? this.copyCtorOf(c) : this.needsAssign(c))) {
          if (fld.type.of.k !== 'class') this.fail('copying an array of arrays of objects', cls.node);
          const cc = this.copyCtorOf(c);
          const one = f.implicit === 'copy' ? (this.use(cc), `${cc.cname}(${[`&${dst}[__i]`, `&${src}[__i]`, ...this.defaultArgs(cc, 1, cx)].join(', ')});`) : this.assignStmt(c, `${dst}[__i]`, `${src}[__i]`, cx);
          lines.push(`{ int __i; for (__i = 0; __i < ${fld.type.n}; __i++) ${one} }`);
        } else lines.push(`{ unsigned int __i; for (__i = 0; __i < sizeof(${dst}); __i++) ((char *)${dst})[__i] = ((const char *)${src})[__i]; }`);
      } else if (c && f.implicit === 'copy') {
        const cc = this.copyCtorOf(c);
        if (cc) { this.use(cc); lines.push(`${cc.cname}(${[`&${dst}`, `&${src}`, ...this.defaultArgs(cc, 1, cx)].join(', ')});`); } else lines.push(`${dst} = ${src};`);
      } else if (c) lines.push(this.assignStmt(c, dst, src, cx));
      else lines.push(`${dst} = ${src};`);
    }
    return lines;
  },
  /** `dst = src` for two objects of class cls, by its operator= when it has one. */
  assignStmt(cls, dst, src, cx) {
    const self = { k: 'class', cls };
    const a = { c: dst, t: self, lv: true }, b = { c: src, t: T.cst(self), lv: true };
    const user = this.userAssign(cls);
    if (user) return `${this.callMember(user, a, [b], cx).c};`;
    if (this.needsAssign(cls)) { const f = this.implicit(cls, 'assign'); this.use(f); return `${f.cname}(&${dst}, &${src});`; }
    return `${dst} = ${src};`;
  },

  // ---------------------------------------------------------------- globals
  /** A global this unit only refers to: declared extern the first time it is used. */
  useGlobal(ent) {
    if (ent.declared || ent.definedHere) return;
    // A class template's static member: its definition, made for this instance.
    const tdef = ent.staticMember && ent.ownerCls?.template?.staticDefs?.find((d) => this.lastName(d.decl.name) === ent.name);
    if (tdef) { this.defineTemplateStatic(ent, tdef); return; }
    ent.declared = true;
    this.out.protos.push(`extern ${this.ct(ent.type.k === 'ref' ? T.ptr(ent.type.to) : ent.type, ent.cname)};`);
  },
  /**
   * The definition of a class template's static member for one instance. Every unit that uses the
   * instance makes it, as g++ makes a COMDAT one; a zero (or absent) initialiser leaves a tentative
   * definition, which the C linker merges into one object. Any other value would be defined twice.
   */
  defineTemplateStatic(ent, it) {
    ent.definedHere = true;
    const zero = !it.init || (it.init.k === 'num' && /^0+[uUlL]*$/.test(it.init.v));
    if (!zero) this.fail(`${ent.ownerCls.name}::${ent.name}: a class template's static member initialised to something other than 0`, it);
    this.out.vars.push(`${this.ct(ent.type.k === 'ref' ? T.ptr(ent.type.to) : ent.type, ent.cname)};`);
  },
  initContext(env) {
    this.initFn ??= { f: { name: '<static initialisation>', type: T.func(T.VOID, []), display: 'static initialisation' }, temps: [], ntemp: 0, cleanups: [{ vars: [], kind: 'fn' }] };
    return { env, fn: this.initFn, pending: [] };
  },
  /** The definition of a global: a C initialiser when it is a constant, code run before main when not. */
  defineGlobal(ent, it, env) {
    ent.definedHere = true;
    const type = ent.type;
    const st = ent.storage === 'static' && !ent.staticMember ? 'static ' : '';
    const decl = `${st}${this.ct(type.k === 'ref' ? T.ptr(type.to) : type, ent.cname)}`;
    const cls = type.k === 'class' ? this.complete(type.cls, it) : null;
    const elem = this.isClassy(type);
    const dynamic = (lines, dtorVar) => {
      this.inits.push(...lines.filter(Boolean).map((l) => `  ${l}`));
      if (dtorVar) this.finis.push(...this.destroy([dtorVar], this.initContext(env)).map((l) => `  ${l}`));
    };
    // Braces at file scope: constant elements in the C initialiser, the rest assigned before main.
    const braces = (target) => {
      const dynFix = [];
      const text = this.bracesInit(it.init, type, { env, fn: null, pending: [], constOnly: true, node: it, dynFix });
      // An object assigned before main cannot be const in C.
      this.out.vars.push(`${dynFix.length ? target.replace(/^(static )?const /, '$1') : target} = ${text};`);
      if (dynFix.length) {
        const cx = this.initContext(env);
        for (const d of dynFix) {
          const { e, after } = this.full(d.x, cx, (m, c) => ({ c: this.dynSet(`${ent.cname}${d.path.join('')}`, d.type, this.expr(m, c), c, m) }));
          dynamic([e.c, ...after], null);
        }
      }
    };
    if (cls) {
      if (it.init?.k === 'braces') { braces(decl); return; }
      this.out.vars.push(`${decl};`);
      const cx = this.initContext(env);
      const { e, after } = this.full({ k: 'ctor' }, cx, (_m, c) => {
        const args = (it.ctorArgs ?? (it.init ? [it.init] : [])).map((a) => this.expr(a, c));
        const pick = this.pickCtor(cls, args, c, it);
        if (pick.copy) return { c: this.pinned(cls) ? this.constructAt(ent.cname, cls, args, c, it) : `${ent.cname} = ${this.copyOf(pick.copy, cls, c)};` };
        if (!pick.f) return { c: '' };
        this.use(pick.f);
        return { c: `${pick.f.cname}(${[`&${ent.cname}`, ...pick.cArgs].join(', ')});` };
      });
      dynamic([e.c, ...after], this.dtorOf(cls) ? { c: ent.cname, cls } : null);
      return;
    }
    if (type.k === 'array' && elem) {
      // An array of aggregates with braces is C's, element by element.
      if (it.init?.k === 'braces' && (this.isAggregate(elem) || this.isCxxAggregate(elem))) { braces(decl); return; }
      if (type.of.k === 'class' && it.init?.k === 'braces') {
        this.out.vars.push(`${decl.replace(/^(static )?const /, '$1')};`);
        dynamic(this.arrayFromBraces(ent.cname, type, it.init.items, this.initContext(env), it), null);
        if (this.dtorOf(elem)) this.finis.push(...this.destroy([{ c: ent.cname, cls: elem, count: type.n }], this.initContext(env)).map((l) => `  ${l}`));
        return;
      }
      if (type.of.k !== 'class' || it.init) this.fail('an initialised array of objects at file scope', it);
      this.out.vars.push(`${decl};`);
      const ctor = this.defaultCtor(elem, it);
      const cx = this.initContext(env);
      if (ctor) { this.use(ctor); dynamic([`{ int __i; for (__i = 0; __i < ${type.n}; __i++) ${ctor.cname}(${[`&${ent.cname}[__i]`, ...this.defaultArgs(ctor, 0, cx)].join(', ')}); }`], null); }
      if (this.dtorOf(elem)) this.finis.push(...this.destroy([{ c: ent.cname, cls: elem, count: type.n }], cx).map((l) => `  ${l}`));
      return;
    }
    const init = it.init ?? (it.ctorArgs?.length === 1 ? it.ctorArgs[0] : null);
    if (!init) { this.out.vars.push(`${decl};`); return; }
    if (init.k === 'braces') { braces(decl); return; }
    if (type.k === 'array') {
      if (init.k !== 'str') this.fail('an array initialised by an expression', it);
      this.out.vars.push(`${decl} = ${init.parts.join(' ')};`);
      return;
    }
    // A constant initialiser stays one; anything that calls or builds a temporary runs before main.
    const probe = { env, fn: null, pending: [], constOnly: true, node: it };
    let c = null;
    try { c = this.coerce(this.expr(init, probe), type.k === 'ref' ? type : T.uncst(type), probe, it, 'initialisation'); } catch (err) { if (!probe.dynamic) throw err; }
    // Reading a variable C cannot fold is no constant in C either: `const float initialwet = 1 /
    // scalewet;` (mt32's freeverb.h) is folded by g++ and runs before main here.
    if (!probe.dynamic && c !== null && !this.readsVariable(init, env)) { this.out.vars.push(`${decl} = ${c};`); return; }
    this.out.vars.push(`${decl.replace(/^(static )?const /, '$1')};`);
    const cx = this.initContext(env);
    const { e, after } = this.full(init, cx, (m, cc) => ({ c: this.coerce(this.expr(m, cc), type.k === 'ref' ? type : T.uncst(type), cc, m, 'initialisation') }));
    dynamic([`${ent.cname} = ${e.c};`, ...after], null);
  },
};
