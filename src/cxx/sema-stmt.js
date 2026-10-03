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
      scope.set(name, { k: 'var', name, type: p, cname: name });
    });
    const lines = [];
    // A parameter passed by value is the callee's object: destroyed when the function returns.
    const top = { vars: [], kind: 'fn' };
    fn.cleanups.push(top);
    f.type.params.forEach((p, i) => { const c = this.isClassy(p); if (c && p.k === 'class' && this.dtorOf(c)) top.vars.push({ c: this.paramName(f, i), cls: c }); });

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
    this.out.bodies.push(`${f.cStatic ? 'static ' : ''}${this.signature(f)} {\n${indent([...decls, ...lines].join('\n'))}\n}`);
  },

  /** The destructor calls for these objects, last first. */
  destroy(vars, cx) {
    const out = [];
    for (const v of [...vars].reverse()) {
      if (v.skip) continue;
      const d = this.dtorOf(v.cls);
      if (!d) continue;
      this.use(d);
      const p = this.upcastPtr(`&${v.c}`, this.basePath(v.cls, d.cls), d.cls);
      if (v.count != null) out.push(`{ int __i; for (__i = ${v.count}; __i > 0; __i--) ${d.cname}(${this.upcastPtr(`&${v.c}[__i - 1]`, this.basePath(v.cls, d.cls), d.cls)}); }`);
      else if (v.guard) out.push(`if (${v.guard}) ${d.cname}(${p});`);
      else out.push(`${d.cname}(${p});`);
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
      const after = this.destroy(cx.pending.map((p) => ({ c: p.name, cls: p.cls })), cx);
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
      case 'label': return `${n.name}: ${this.stmt(n.s, cx)}`;
      case 'return': return this.returnStmt(n, cx);
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
      try { c = this.coerce(this.expr(it.init ?? it.ctorArgs[0], cx), type, cx, it, 'reference binding'); for (const p of cx.pending) cl.vars.push({ c: p.name, cls: p.cls }); } finally { cx.pending = saved; }
      return done(`${this.ct(T.ptr(type.to), name)} = ${c};`);
    }
    const cls = type.k === 'class' ? this.complete(type.cls, it) : null;
    if (cls) {
      const decl = `${st}${this.ct(T.uncst(type), name)}`;
      const d = this.dtorOf(cls);
      if (isStatic) return done(this.staticLocal(ent, it, cx, decl, cls));
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
    if (type.k === 'array' && elem) {
      if (type.of.k !== 'class') this.fail('an array of arrays of objects', it);
      const ctor = this.defaultCtor(elem, it), d = this.dtorOf(elem);
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
    const init = pick.copy ? `${ent.cname} = ${this.copyOf(pick.copy, cls, cx)};` : pick.f ? (this.use(pick.f), `${pick.f.cname}(${[`&${ent.cname}`, ...pick.cArgs].join(', ')});`) : '';
    return `if (!${g}) { ${g} = 1; ${init}${reg} }`;
  },
  /** `{ ... }` for an aggregate: each element converted to its member's or element's type. */
  bracesInit(b, type, cx) {
    if (type.k === 'array') {
      return `{ ${b.items.map((x) => this.initElem(x, type.of, cx)).join(', ')} }`;
    }
    if (type.k === 'class') {
      const cls = this.complete(type.cls, b);
      if (cls.ctors.length || cls.bases.length || cls.hasVptr) this.fail(`${cls.name} is not an aggregate`, cx.node);
      return `{ ${b.items.map((x, i) => this.initElem(x, cls.fields[i]?.type ?? this.fail('too many initialisers', cx.node), cx)).join(', ')} }`;
    }
    if (b.items.length === 1) return this.initElem(b.items[0], type, cx);
    this.fail('braces initialising a scalar', cx.node);
  },
  initElem(x, type, cx) {
    if (x.k === 'braces') return this.bracesInit(x, type, cx);
    if (type.k === 'array' && x.k === 'str') return x.parts.join(' ');
    if (type.k === 'array' || (type.k === 'class' && !this.convert(this.expr(x, { ...cx, pending: [] }), T.uncst(type), cx))) this.fail('an initialiser without its braces', cx.node);
    return this.coerce(this.expr(x, cx), T.uncst(type), cx, cx.node, 'initialisation');
  },

  // ---------------------------------------------------------------- constructors and destructors
  vtableName(cls) {
    const name = `__vtbl_${cls.cname}`;
    if (!cls.vtableDone) {
      cls.vtableDone = true;
      const slots = cls.vtable.map((f) => {
        if (f.pure && !f.body) return '0';
        // A class that declares no destructor under a virtual one still has its own to run.
        if (f.isDtor && f.cls !== cls) { const d = this.dtorOf(cls); if (d && d !== f) { d.isVirtual = true; d.vindex = f.vindex; f = d; } }
        // A destructor never declared is still a destructor to call: the implicit one.
        this.use(f);
        return `(void *)${f.cname}`;
      });
      this.out.vtables.push(`static void *${name}[${slots.length}] = { ${slots.join(', ')} };`);
    }
    return name;
  },
  setVptr(cls) {
    if (!cls.hasVptr) return [];
    // An implicit destructor that must be virtual takes the slot its base's had.
    return [`this->${[...this.vptrPath(cls), '__vptr'].join('.')} = __vtbl_${cls.cname};`].map((s) => (this.vtableName(cls), s));
  },
  /** Bases, then the vptr, then members in the order they are declared -- whatever order the list is in. */
  ctorPrologue(f, cx) {
    const cls = f.cls;
    const lines = [];
    const inits = new Map();
    for (const i of f.inits ?? []) inits.set(this.lastName(i.name), i);
    cls.bases.forEach((b, bi) => {
      const init = inits.get(b.node?.name) ?? inits.get(b.template?.name) ?? inits.get(b.name);
      const { e, after } = this.full({ k: 'ctor' }, cx, (_m, c) => {
        const args = (init?.args ?? []).map((a) => this.expr(a, c));
        const pick = this.pickCtor(b, args, c, f.defNode);
        if (pick.copy) return { c: `this->__b${bi} = ${this.copyOf(pick.copy, b, c)};` };
        if (!pick.f) return { c: '' };
        this.use(pick.f);
        return { c: `${pick.f.cname}(${[`&this->__b${bi}`, ...pick.cArgs].join(', ')});` };
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
          if (pick.copy) return { c: `${target} = ${this.copyOf(pick.copy, c, cc)};` };
          if (!pick.f) return { c: '' };
          this.use(pick.f);
          return { c: `${pick.f.cname}(${[`&${target}`, ...pick.cArgs].join(', ')});` };
        });
        if (e.c) lines.push(e.c, ...after);
      } else if (fld.type.k === 'array' && c) {
        const ctor = this.defaultCtor(c, f.defNode);
        if (ctor) { this.use(ctor); lines.push(`{ int __i; for (__i = 0; __i < ${fld.type.n}; __i++) ${ctor.cname}(${[`&${target}[__i]`, ...this.defaultArgs(ctor, 0, cx)].join(', ')}); }`); }
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
    [...cls.bases].map((b, i) => [b, i]).reverse().forEach(([b, i]) => lines.push(...this.destroy([{ c: `this->__b${i}`, cls: b }], cx)));
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
      const src = `&${o}->__b${i}`, dst = `&this->__b${i}`;
      if (f.implicit === 'copy') {
        const cc = this.copyCtorOf(b);
        if (cc) { this.use(cc); lines.push(`${cc.cname}(${[dst, src, ...this.defaultArgs(cc, 1, cx)].join(', ')});`); } else lines.push(`this->__b${i} = ${o}->__b${i};`);
      } else lines.push(this.assignStmt(b, `this->__b${i}`, `${o}->__b${i}`, cx));
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
    ent.declared = true;
    this.out.protos.push(`extern ${this.ct(ent.type.k === 'ref' ? T.ptr(ent.type.to) : ent.type, ent.cname)};`);
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
    if (cls) {
      if (it.init?.k === 'braces') { this.out.vars.push(`${decl} = ${this.bracesInit(it.init, type, { env, fn: null, pending: [], constOnly: true, node: it })};`); return; }
      this.out.vars.push(`${decl};`);
      const cx = this.initContext(env);
      const { e, after } = this.full({ k: 'ctor' }, cx, (_m, c) => {
        const args = (it.ctorArgs ?? (it.init ? [it.init] : [])).map((a) => this.expr(a, c));
        const pick = this.pickCtor(cls, args, c, it);
        if (pick.copy) return { c: `${ent.cname} = ${this.copyOf(pick.copy, cls, c)};` };
        if (!pick.f) return { c: '' };
        this.use(pick.f);
        return { c: `${pick.f.cname}(${[`&${ent.cname}`, ...pick.cArgs].join(', ')});` };
      });
      dynamic([e.c, ...after], this.dtorOf(cls) ? { c: ent.cname, cls } : null);
      return;
    }
    if (type.k === 'array' && elem) {
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
    if (init.k === 'braces') { this.out.vars.push(`${decl} = ${this.bracesInit(init, type, { env, fn: null, pending: [], constOnly: true, node: it })};`); return; }
    if (type.k === 'array') {
      if (init.k !== 'str') this.fail('an array initialised by an expression', it);
      this.out.vars.push(`${decl} = ${init.parts.join(' ')};`);
      return;
    }
    // A constant initialiser stays one; anything that calls or builds a temporary runs before main.
    const probe = { env, fn: null, pending: [], constOnly: true, node: it };
    let c = null;
    try { c = this.coerce(this.expr(init, probe), type.k === 'ref' ? type : T.uncst(type), probe, it, 'initialisation'); } catch (err) { if (!probe.dynamic) throw err; }
    if (!probe.dynamic && c !== null) { this.out.vars.push(`${decl} = ${c};`); return; }
    this.out.vars.push(`${decl.replace(/^(static )?const /, '$1')};`);
    const cx = this.initContext(env);
    const { e, after } = this.full(init, cx, (m, cc) => ({ c: this.coerce(this.expr(m, cc), type.k === 'ref' ? type : T.uncst(type), cc, m, 'initialisation') }));
    dynamic([`${ent.cname} = ${e.c};`, ...after], null);
  },
};
