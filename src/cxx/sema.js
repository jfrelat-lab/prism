// sema.js — C++ resolved and lowered to C text (the cfront way).
//
// parse.js gives a tree of unresolved names. This file gives every name a meaning and every
// expression a type, picks the function each call means, and writes C that the existing compiler
// takes as it takes any other unit:
//
//   a class            a struct: its bases first (each a member), a vptr if it has virtual functions
//                      and no base brought one, then its fields
//   a member function  a function taking `this` first
//   a reference        a pointer, dereferenced where it is used
//   a virtual call     a call through the object's table of function pointers
//   a constructor      a function run where the object is defined; its destructor where it dies --
//                      at the end of the block, before every return/break/continue out of it, and for
//                      a temporary at the end of the full expression
//   a class template   one struct and one set of functions per set of arguments, made when used
//   a function template one static function per set of arguments, deduced at the call
//   a namespace        a prefix of the C names declared in it (N_x for a class, _ZN1N1fE... for a
//                      function or a variable); an anonymous one's names are its unit's alone
//   a second polymorphic base  its own table, whose overridden slots are thunks that move `this`
//                      from that base back to the class; every table also carries its offset to the
//                      whole object and a type descriptor, which is what dynamic_cast reads
//   a pointer to member function  a C function pointer taking the object first; for a virtual
//                      function, a thunk that calls through the object's table
//
// Layout is the C compiler's (types.js); names are mangled in the Itanium manner so that a C++
// function never collides with a C one (ET has a Q_fabs on each side).
//
// The file is one class in three parts: declarations here, expressions in sema-expr.js, statements
// and function bodies in sema-stmt.js.

import * as T from './types.js';
import { CxxError } from './parse.js';
import { exprMethods } from './sema-expr.js';
import { stmtMethods } from './sema-stmt.js';

/**
 * A scope. `ns` marks a namespace's (its name as a C prefix, and whether it is anonymous);
 * `usings` are the namespaces a using-directive here makes visible.
 */
export class Scope {
  constructor(parent = null, { cls = null, ns = null } = {}) { this.parent = parent; this.map = new Map(); this.cls = cls; this.ns = ns; this.usings = []; }
  get(name) { return this.map.get(name); }
  set(name, ent) { this.map.set(name, ent); return ent; }
  /** This scope's own entity for name, or one a using-directive here brings in. */
  find(name, seen = new Set()) {
    const e = this.map.get(name);
    if (e) return e;
    seen.add(this);
    for (const u of this.usings) { if (seen.has(u)) continue; const r = u.find(name, seen); if (r) return r; }
    return undefined;
  }
}
/** The namespace a scope is in (null at file scope): the C prefix of the names declared there. */
export function nsOf(scope) {
  for (let s = scope; s; s = s.parent) if (s.ns) return s.ns;
  return null;
}

const OP_CODE = { '+': 'pl', '-': 'mi', '*': 'ml', '/': 'dv', '%': 'rm', '^': 'eo', '&': 'an', '|': 'or', '~': 'co',
  '!': 'nt', '=': 'aS', '<': 'lt', '>': 'gt', '+=': 'pL', '-=': 'mI', '*=': 'mL', '/=': 'dV', '%=': 'rM', '^=': 'eO',
  '&=': 'aN', '|=': 'oR', '<<': 'ls', '>>': 'rs', '<<=': 'lS', '>>=': 'rS', '==': 'eq', '!=': 'ne', '<=': 'le',
  '>=': 'ge', '&&': 'aa', '||': 'oo', '++': 'pp', '--': 'mm', ',': 'cm', '->': 'pt', '()': 'cl', '[]': 'ix',
  new: 'nw', delete: 'dl', 'new[]': 'na', 'delete[]': 'da' };

/** Lower a parsed C++ unit to C text. `tag` names the unit, for its static-initialiser function. */
export function lowerCxx(unit, { tag = 'unit', builtins = null } = {}) {
  const sema = new Sema(tag);
  sema.builtins = builtins;
  return sema.run(unit);
}

export class Sema {
  constructor(tag) {
    this.tag = tag.replace(/[^A-Za-z0-9_]/g, '_');
    this.global = new Scope();
    this.out = { fwd: [], types: [], protos: [], vars: [], vtables: [], bodies: [] };
    this.structsDone = new Set();
    this.fwdDone = new Set();
    this.queue = [];                      // functions whose bodies are still to be written
    this.templates = new Map();           // name -> { ast, params, env, outOfLine: [] }
    this.instances = new Map();
    this.inits = [];                      // dynamic initialisation of this unit's globals, in order
    this.finis = [];                      // their destruction, to run in reverse at exit
    this.anon = 0;
    this.classes = [];
  }

  fail(msg, node) {
    const loc = node?.loc;
    throw new CxxError(loc ? `${loc.file}:${loc.line}: ${msg}` : msg);
  }

  run(unit) {
    const env = { scope: this.global, cls: null, bind: null };
    for (const it of unit.items) this.item(it, env);
    // Every function with external linkage that this unit defines is written, used here or not.
    for (const f of this.defined ?? []) this.use(f);
    while (this.queue.length) this.writeFunction(this.queue.shift());
    return this.assemble();
  }

  assemble() {
    const o = this.out;
    const init = [];
    if (this.inits.length || this.finis.length) {
      const fini = `__prism_cxx_fini_${this.tag}`;
      if (this.finis.length) {
        init.push(`static void ${fini}(void) {\n${[...this.finis].reverse().join('\n')}\n}`);
        this.needAtexit = true;
      }
      init.push(`void __prism_cxx_init_${this.tag}(void) {\n${(this.initFn?.temps ?? []).map((t) => `  ${t}`).join('\n')}\n${this.inits.join('\n')}\n${this.finis.length ? `  atexit(${fini});\n` : ''}}`);
    }
    return [
      '/* generated by PRISM from C++ */',
      this.needAtexit && !this.global.get('atexit') ? 'int atexit(void (*)(void));' : '',
      ...o.fwd, ...o.types, ...o.protos, ...o.vars, ...o.vtables, ...o.bodies, ...init, '',
    ].filter((s) => s !== '').join('\n');
  }

  // ---------------------------------------------------------------- top-level items
  item(it, env) {
    switch (it.k) {
      case 'class':
        if (it.specArgs) return this.declareSpecialisation(it, env);
        return it.template ? this.declareTemplate(it, env) : this.declareClass(it, env);
      case 'enum': return this.declareEnum(it, env);
      case 'fwdclass': {
        if (!env.scope.get(it.name)) env.scope.set(it.name, { k: 'type', type: { k: 'class', cls: this.newClass(it.name, it.key, it, env) } });
        return null;
      }
      case 'typedef': {
        const type = this.declType(it.specs, it.decl.derivs, env, it);
        env.scope.set(this.lastName(it.decl.name), { k: 'type', type });
        return null;
      }
      case 'decl': case 'func':
        // A function template: `template<typename T> T MIN(T a, T b)`, not a member of a class template.
        if (it.template?.length && it.decl.name.parts.length === 1) return this.declareFunctionTemplate(it, env);
        return it.k === 'decl' ? this.declaration(it, env) : this.functionDefinition(it, env);
      case 'namespace': {
        const ns = this.namespace(it.name, env);
        const inner = { scope: ns.scope, cls: null, bind: env.bind };
        for (const x of it.items) this.item(x, inner);
        return null;
      }
      case 'nsalias': {
        const target = this.qualified(it.target, env, it);
        if (target?.k !== 'namespace') this.fail(`'${this.qualText(it.target)}' is not a namespace`, it);
        env.scope.set(it.name, target);
        return null;
      }
      case 'usingns': case 'usingdecl': return this.using(it, env.scope, env);
      default: this.fail(`unexpected ${it.k} at file scope`, it);
    }
  }
  lastName(q) { return q.parts[q.parts.length - 1].name; }

  // ---------------------------------------------------------------- namespaces
  /**
   * The namespace `name` declared in env's scope, made the first time it is opened. An anonymous
   * one is its unit's own -- named after the unit, its names internal -- and visible around it.
   */
  namespace(name, env) {
    const key = name ?? '<anonymous>';
    const prior = env.scope.get(key);
    if (prior?.k === 'namespace') return prior.ns;
    const outer = nsOf(env.scope);
    const own = name ?? `_GLOBAL__N_${this.tag}`;
    const ns = { name: key, cname: outer ? `${outer.cname}_${own}` : own, internal: !name || !!outer?.internal };
    ns.scope = new Scope(env.scope, { ns });
    env.scope.set(key, { k: 'namespace', ns });
    if (!name) env.scope.usings.push(ns.scope);
    return ns;
  }
  /** `using namespace N;` adds N to the scope's directives; `using N::x;` declares x here as N's x. */
  using(it, scope, env) {
    if (it.k === 'usingns') {
      const target = this.qualified(it.qname, env, it);
      if (target?.k !== 'namespace') this.fail(`'${this.qualText(it.qname)}' is not a namespace`, it);
      scope.usings.push(target.ns.scope);
      return null;
    }
    const r = this.lookupName(it.qname, env) ?? this.fail(`'${this.qualText(it.qname)}' is not declared`, it);
    scope.set(this.lastName(it.qname), r.ent);
    return null;
  }
  /**
   * What a qualified name's qualifier and name denote, without instantiating its last part: an
   * entity ({ k: 'namespace' | 'type' | 'template' | 'funcs' | 'var' ... }) or null. Used where the
   * name may be a namespace, which no type or value lookup returns.
   */
  qualified(q, env, node) {
    let ent = null;
    for (let i = 0; i < q.parts.length; i++) {
      const p = q.parts[i];
      if (i === 0) ent = q.global ? this.global.find(p.name) : this.lookupAny(p.name, env);
      else if (ent.k === 'namespace') ent = ent.ns.scope.find(p.name);
      else if (ent.k === 'type' && ent.type.k === 'class') { this.complete(ent.type.cls, node); ent = this.memberEntity(ent.type.cls, p.name)?.ent; }
      else return null;
      if (!ent) return null;
      if (i + 1 < q.parts.length && ent.k === 'template' && p.targs) {
        ent = { k: 'type', type: this.instantiate(ent.tmpl, p.targs.map((a) => this.templateArg(a, env, node)), node) };
      }
    }
    return ent;
  }
  /** An unqualified name's entity, whatever it is, through the scopes outward. */
  lookupAny(name, env) {
    for (let s = env.scope; s; s = s.parent) {
      const e = s.cls ? this.memberEntity(s.cls, name)?.ent : s.find(name);
      if (e) return e;
    }
    return null;
  }

  // ---------------------------------------------------------------- types
  /** The type a declaration's specifiers and declarator derivations name. */
  declType(specs, derivs, env, node) {
    let t = this.specType(specs, env, node);
    for (const d of derivs) t = this.derive(t, d, env, node);
    return t;
  }
  specType(specs, env, node) {
    const s = specs.type;
    let t;
    if (!s) this.fail('a declaration with no type', node);
    if (s.k === 'builtin') t = this.builtin(s.words, node);
    else if (s.k === 'named') t = s.defined?.info ? this.typeOfInfo(s.defined.info) : this.namedType(s.qname, env, node, s.elaborated);
    else this.fail(`type specifier ${s.k}`, node);
    return specs.cv?.const ? T.cst(t) : t;
  }
  typeOfInfo(info) { return info.k === 'enuminfo' ? { k: 'enum', en: info } : { k: 'class', cls: info }; }
  builtin(words, node) {
    const n = (w) => words.filter((x) => x === w).length;
    const uns = n('unsigned') > 0, sig = n('signed') + n('__signed') + n('__signed__') > 0;
    if (n('void')) return T.VOID;
    if (n('bool') || n('_Bool')) return T.BOOL;
    if (n('float')) return T.FLOAT;
    if (n('double')) return n('long') ? T.prim('long double') : T.DOUBLE;
    if (n('char')) return T.prim(uns ? 'unsigned char' : sig ? 'signed char' : 'char');
    if (n('wchar_t')) return T.INT;
    if (n('short')) return T.prim(uns ? 'unsigned short' : 'short');
    if (n('long') >= 2) return T.prim(uns ? 'unsigned long long' : 'long long');
    if (n('long') === 1) return T.prim(uns ? 'unsigned long' : 'long');
    if (n('int') || uns || sig) return T.prim(uns ? 'unsigned int' : 'int');
    this.fail(`type '${words.join(' ')}'`, node);
  }
  namedType(qname, env, node, elaborated) {
    let scope = null, found = null, ns = null;
    for (let i = 0; i < qname.parts.length; i++) {
      const p = qname.parts[i];
      const more = i + 1 < qname.parts.length;
      let ent;
      if (i === 0) {
        const b = env.bind?.get(p.name);
        if (b && !p.targs) {
          if (b.k === 'tvalue') this.fail(`'${p.name}' is a value, not a type`, node);
          found = b;
        } else {
          ent = qname.global ? this.global.find(p.name) : this.lookupType(p.name, env, more);
          if (elaborated && !more) ent = this.lookupType(`struct ${p.name}`, env) ?? ent;
          if (!ent) {
            // `struct X *p` names a class not yet declared: an incomplete one, completed if defined.
            if (elaborated && qname.parts.length === 1) return this.forwardClass(p.name, elaborated, env, node);
            this.fail(`'${p.name}' does not name a type`, node);
          }
        }
      } else if (ns) {
        ent = ns.scope.find(p.name);
        if (!ent || (ent.k !== 'type' && ent.k !== 'template' && ent.k !== 'namespace')) this.fail(`'${p.name}' is not a type in ${ns.name}`, node);
      } else {
        ent = scope.get(p.name) ?? (scope.cls ? this.memberEntity(scope.cls, p.name)?.ent : null);
        if (!ent || (ent.k !== 'type' && ent.k !== 'template')) this.fail(`'${p.name}' is not a type in ${qname.parts[i - 1].name}`, node);
      }
      if (ent) {
        if (ent.k === 'namespace') {
          if (!more) this.fail(`namespace '${p.name}' used as a type`, node);
          ns = ent.ns; scope = null;
          continue;
        }
        found = ent.k === 'template' ? this.instantiate(ent.tmpl, (p.targs ?? this.fail(`template ${p.name} needs arguments`, node)).map((a) => this.templateArg(a, env, node)), node) : ent.type;
      }
      ns = null;
      if (more) {
        if (found.k !== 'class') this.fail(`'${p.name}' is not a class`, node);
        // A class may qualify a name with itself while it is still being defined.
        if (!found.cls.defining) this.complete(found.cls, node);
        scope = found.cls.scope;
      }
    }
    return found;
  }
  /** A template argument: a type, or (for a parameter that is a value) an integer constant. */
  templateArg(a, env, node) {
    if (a.expr) {
      const v = this.constInt(a.expr, env);
      if (v === null) this.fail('a template argument that is not a constant', node);
      return { k: 'tvalue', value: v };
    }
    return this.declType(a.specs, a.derivs, env, node);
  }
  /**
   * A type by unqualified name: the scopes outward, each class scope including its bases. With
   * `qualifier`, a namespace too -- the name is the first part of `N::T`.
   */
  lookupType(name, env, qualifier = false) {
    for (let s = env.scope; s; s = s.parent) {
      const e = s.cls ? this.memberEntity(s.cls, name)?.ent : s.find(name);
      if (e && (e.k === 'type' || e.k === 'template' || (qualifier && e.k === 'namespace'))) return e;
    }
    return null;
  }
  forwardClass(name, key, env, node) {
    const cls = this.newClass(name, key, node, env);
    // Declared in the nearest non-class scope, as C++ does for an elaborated name seen first here.
    let s = env.scope;
    while (s.cls && s.parent) s = s.parent;
    s.set(name, { k: 'type', type: { k: 'class', cls } });
    return { k: 'class', cls };
  }

  derive(t, d, env, node) {
    switch (d.k) {
      case 'ptr': { const p = T.ptr(t); return d.cv?.const ? T.cst(p) : p; }
      case 'ref': return t.k === 'ref' ? t : T.ref(t);
      case 'memptr': {
        const ct = this.namedType(d.qname, env, node);
        if (ct.k !== 'class') this.fail('a pointer to member of something that is not a class', node);
        if (t.k !== 'func') this.fail('a pointer to a data member is not supported', node);
        const p = { k: 'memptr', cls: ct.cls, to: t };
        return d.cv?.const ? T.cst(p) : p;
      }
      case 'array': {
        let n = null;
        if (d.size) {
          n = this.constInt(d.size, env);
          /*
           * A size this front end cannot fold -- `sizeof(channel_data)/2` in ScummVM's player_v2.h,
           * whose answer is the C compiler's layout, not this file's -- is written in C for the C
           * compiler to fold: the length becomes C text. Every use of it is C text too.
           */
          if (n === null) {
            const cx = { env, fn: null, pending: [], constOnly: true, node };
            const e = this.expr(d.size, cx);
            if (cx.dynamic || !T.isInteger(e.t)) this.fail('an array size that is not a constant', node);
            n = `(${e.c})`;
          }
        }
        return T.array(t, n);
      }
      case 'func': {
        const params = d.params.map((p) => T.paramType(this.declType(p.specs, p.decl.derivs, env, node)));
        return T.func(t, params, d.variadic, !!d.cv?.const);
      }
      default: this.fail(`declarator ${d.k}`, node);
    }
  }

  // ---------------------------------------------------------------- constants
  /** An integer constant expression's value, or null if it is not one this front end can fold. */
  constInt(e, env) {
    switch (e.k) {
      case 'num': { const v = this.parseNumber(e.v); return T.isFloat(v.type) ? null : v.value; }
      case 'chr': return this.charValue(e.v);
      case 'bool': return e.v ? 1 : 0;
      case 'paren': return this.constInt(e.e, env);
      case 'id': {
        const ent = this.lookupName(e.name, env);
        if (ent?.ent?.k === 'enumerator') return ent.ent.value;
        if (ent?.ent?.k === 'var' && ent.ent.constValue !== undefined) return ent.ent.constValue;
        return null;
      }
      case 'unary': {
        const v = this.constInt(e.e, env);
        if (v === null) return null;
        return e.op === '-' ? -v : e.op === '+' ? v : e.op === '~' ? ~v : e.op === '!' ? (v ? 0 : 1) : null;
      }
      case 'cast': return this.constInt(e.e, env);
      case 'bin': {
        const a = this.constInt(e.a, env), b = this.constInt(e.b, env);
        if (a === null || b === null) return null;
        switch (e.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': return b ? Math.trunc(a / b) : null; case '%': return b ? a % b : null;
          case '<<': return a << b; case '>>': return a >> b; case '&': return a & b; case '|': return a | b;
          case '^': return a ^ b; case '==': return +(a === b); case '!=': return +(a !== b);
          case '<': return +(a < b); case '>': return +(a > b); case '<=': return +(a <= b); case '>=': return +(a >= b);
          case '&&': return +(a && b); case '||': return +(a || b);
          default: return null;
        }
      }
      case 'cond': { const c = this.constInt(e.c, env); if (c === null) return null; return this.constInt(c ? e.a : e.b, env); }
      default: return null;
    }
  }
  parseNumber(text) {
    const s = text.toLowerCase();
    if (/^0x/.test(s) ? false : /[.e]/.test(s) || /^\d+f$/.test(s)) {
      const fl = s.endsWith('f'), ld = s.endsWith('l');
      return { type: fl ? T.FLOAT : ld ? T.prim('long double') : T.DOUBLE, value: parseFloat(s) };
    }
    const m = /^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)([ul]*)$/.exec(s);
    if (!m) return { type: T.INT, value: 0 };
    const value = Number(BigInt.asIntN(64, BigInt(m[1].startsWith('0x') ? m[1] : /^0[0-7]+$/.test(m[1]) ? `0o${m[1].slice(1)}` : m[1])));
    const u = m[2].includes('u'), l = (m[2].match(/l/g) ?? []).length;
    let type;
    if (l >= 2) type = T.prim(u ? 'unsigned long long' : 'long long');
    else if (l === 1) type = u ? T.ULONG : T.LONG;
    else if (u) type = T.UINT;
    else if (value > 0x7fffffff) type = /^0/.test(m[1]) && value <= 0xffffffff ? T.UINT : T.prim('long long');
    else type = T.INT;
    return { type, value };
  }
  /*
   * A character constant's value. With several characters -- SCUMM's MKID('SMAP'), a resource tag --
   * it is gcc's: each character shifts the value left by eight, in an int. Taking the first character
   * alone made `case MKID('SMAP')` never match, and Monkey Island's rooms had no z-buffers.
   */
  charValue(lit) {
    const body = lit.replace(/^L?'|'$/g, '');
    const esc = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, "'": 39, '"': 34, '?': 63 };
    const units = [];
    for (let i = 0; i < body.length;) {
      if (body[i] !== '\\') { units.push(body.charCodeAt(i++)); continue; }
      const m = /^\\(x[0-9a-fA-F]+|[0-7]{1,3}|.)/.exec(body.slice(i));
      const e = m[1];
      units.push(e[0] === 'x' ? parseInt(e.slice(1), 16) : /^[0-7]/.test(e) ? parseInt(e, 8) : (esc[e] ?? e.charCodeAt(0)));
      i += m[0].length;
    }
    if (units.length === 1) return units[0];
    return units.reduce((v, u) => ((v << 8) | (u & 0xff)) | 0, 0);
  }

  // ---------------------------------------------------------------- enums
  declareEnum(it, env) {
    const cname = this.scopedName(it.name ?? `__enum${++this.anon}`, env);
    const en = { k: 'enuminfo', name: it.name, cname, unsigned: true, values: new Map() };
    it.info = en;
    const type = { k: 'enum', en };
    if (it.name) env.scope.set(it.name, { k: 'type', type });
    let next = 0;
    for (const v of it.values) {
      if (v.e) { const x = this.constInt(v.e, env); if (x === null) this.fail(`enumerator ${v.name} is not a constant`, it); next = x; }
      if (next < 0) en.unsigned = false;
      env.scope.set(v.name, { k: 'enumerator', type, value: next });
      next++;
    }
    return en;
  }
  scopedName(name, env) {
    if (env.cls) return `${env.cls.cname}_${name}`;
    const ns = nsOf(env.scope);
    return ns ? `${ns.cname}_${name}` : name;
  }

  // ---------------------------------------------------------------- classes
  newClass(name, key, node, env) {
    const cls = {
      k: 'classinfo', name: name ?? `<anonymous>`, cname: name ? this.scopedName(name, env) : `__anon${++this.anon}`,
      key, complete: false, bases: [], fields: [], scope: null, ctors: [], dtor: null, convs: [], methods: [],
      hasVptr: false, ownVptr: false, vtable: [], cLink: false, node,
    };
    cls.scope = new Scope(env.scope, { cls });
    this.classes.push(cls);
    return cls;
  }

  declareClass(it, env, { cls = null, bind = env.bind } = {}) {
    if (!cls) {
      // A class whose name a function already has (`struct stat` and `stat()`) is named by its tag only.
      const hidden = it.name && env.scope.get(it.name)?.k === 'funcs';
      const key = hidden ? `struct ${it.name}` : it.name;
      const prior = key ? env.scope.get(key) : null;
      cls = prior?.k === 'type' && prior.type.k === 'class' && !prior.type.cls.complete ? prior.type.cls : this.newClass(it.name, it.key, it, env);
      if (key) env.scope.set(key, { k: 'type', type: { k: 'class', cls } });
    }
    it.info = cls;
    cls.defining = true;
    cls.key = it.key;
    cls.cLink = !!it.cLinkage;
    cls.node = it;
    const cenv = { scope: cls.scope, cls, bind };
    cls.env = cenv;
    for (const b of it.bases) {
      const bt = this.namedType(b.qname, env.bind === bind ? env : { ...env, bind }, it);
      if (bt.k !== 'class') this.fail('a base that is not a class', it);
      this.complete(bt.cls, it);
      cls.bases.push(bt.cls);
    }
    // The PRIMARY base is the first polymorphic one: it shares the class's address and its table
    // (it is laid out first, as the Itanium ABI lays it). Every other polymorphic base keeps a table
    // of its own -- see secondaryGroups.
    cls.primaryBase = cls.bases.findIndex((b) => b.hasVptr);
    cls.hasVptr = cls.primaryBase >= 0;
    cls.vtable = cls.hasVptr ? [...cls.bases[cls.primaryBase].vtable] : [];
    // The class's own name names it inside itself (the injected class name).
    if (it.name) cls.scope.set(it.name, { k: 'type', type: { k: 'class', cls } });

    for (const m of it.members) {
      if (m.k === 'class') { this.declareClass(m, cenv); continue; }
      if (m.k === 'enum') { this.declareEnum(m, cenv); continue; }
      if (m.k === 'typedef') { cls.scope.set(this.lastName(m.decl.name), { k: 'type', type: this.declType(m.specs, m.decl.derivs, cenv, m) }); continue; }
      if (m.k === 'func') { this.memberFunction(m, cls, cenv, m); continue; }
      if (m.k === 'decl') {
        const isFunc = m.decl.derivs.length && m.decl.derivs[m.decl.derivs.length - 1].k === 'func';
        if (isFunc) { this.memberFunction(m, cls, cenv, null); continue; }
        if (m.specs.friend) continue;
        if (!m.decl.name) { this.anonymousMember(m, cls, cenv); continue; }
        const type = this.declType(m.specs, m.decl.derivs, cenv, m);
        const name = this.lastName(m.decl.name);
        if (m.specs.storage === 'static') {
          const ent = { k: 'var', name, type, cname: `${cls.cname}_${name}`, global: true, storage: 'extern', staticMember: true, ownerCls: cls };
          if (type.c && T.isInteger(type) && m.init) { const v = this.constInt(m.init, cenv); if (v !== null) ent.constValue = v; }
          cls.scope.set(name, ent);
          continue;
        }
        const bits = m.bits ? this.constInt(m.bits, cenv) : null;
        const field = { k: 'var', name, type, cname: name, field: cls, bits };
        cls.fields.push(field);
        cls.scope.set(name, field);
      }
    }
    cls.complete = true;
    cls.defining = false;
    // The table: an overrider takes its base's slot; a new virtual function takes the next one.
    for (const f of cls.methods) {
      if (f.isCtor) continue;
      const slot = cls.vtable.findIndex((b) => this.overrides(f, b));
      if (slot >= 0) { f.isVirtual = true; f.vindex = slot; cls.vtable[slot] = f; }
      // An overrider of a secondary base's function is virtual too, with a slot of its own here.
      else if (f.isVirtual || cls.bases.some((b, i) => i !== cls.primaryBase && b.hasVptr && this.allVirtuals(b).some((v) => this.overrides(f, v)))) {
        f.isVirtual = true; f.vindex = cls.vtable.length; cls.vtable.push(f);
      }
    }
    if (cls.vtable.length && !cls.hasVptr) { cls.hasVptr = true; cls.ownVptr = true; }
    return cls;
  }
  overrides(f, b) {
    if (f.isDtor || b.isDtor) return f.isDtor && b.isDtor;
    return f.name === b.name && !f.isStatic && f.type.params.length === b.type.params.length
      && f.type.params.every((p, i) => T.same(p, b.type.params[i], { top: false })) && !!f.type.thisConst === !!b.type.thisConst;
  }
  anonymousMember(m, cls, cenv) {
    // `union { ... };` inside a struct: its members are the struct's own, reached through it.
    const type = this.specType(m.specs, cenv, m);
    if (type.k !== 'class') return;
    const field = { k: 'var', name: null, type, cname: `__anon_m${++this.anon}`, field: cls };
    cls.fields.push(field);
    for (const [name, ent] of type.cls.scope.map) {
      if (ent.k === 'var' && ent.field) cls.scope.set(name, { ...ent, via: [field.cname, ...(ent.via ?? [])], field: cls });
    }
  }

  /** A class used where it must be complete: an instance of a template is made now. */
  complete(cls, node) {
    if (cls.complete) return cls;
    if (cls.pending) { const p = cls.pending; cls.pending = null; p(); }
    if (!cls.complete) this.fail(`'${cls.name}' is incomplete here`, node);
    return cls;
  }

  /** The member `name` of cls or of a base: { ent, path } where path is the base members to go through. */
  memberEntity(cls, name, path = []) {
    const ent = cls.scope.get(name);
    if (ent && !(ent.k === 'type' && ent.type.k === 'class' && ent.type.cls === cls && false)) return { ent, path, cls };
    for (let i = 0; i < cls.bases.length; i++) {
      const r = this.memberEntity(cls.bases[i], name, [...path, `__b${i}`]);
      if (r) return r;
    }
    return null;
  }
  /** Is `d` the class `b` or derived from it? The path of base members from d to b, or null. */
  basePath(d, b, path = []) {
    if (d === b) return path;
    for (let i = 0; i < d.bases.length; i++) {
      const r = this.basePath(d.bases[i], b, [...path, `__b${i}`]);
      if (r) return r;
    }
    return null;
  }
  /** The base members from cls to the subobject holding the vptr. */
  vptrPath(cls) {
    if (cls.ownVptr || !(cls.primaryBase >= 0)) return [];
    return [`__b${cls.primaryBase}`, ...this.vptrPath(cls.bases[cls.primaryBase])];
  }
  /** Every virtual function of a class, its secondary bases' included. */
  allVirtuals(cls) {
    return [...cls.vtable, ...cls.bases.flatMap((b, i) => (i !== cls.primaryBase && b.hasVptr ? this.allVirtuals(b) : []))];
  }
  /**
   * The polymorphic subobjects of cls that do not share its table: { xpath, cls } for each, xpath
   * the base members from cls to it. A secondary base's own secondaries are listed too; the primary
   * base's are, under its path.
   */
  secondaryGroups(cls, path = [], out = []) {
    cls.bases.forEach((b, i) => {
      if (!b.hasVptr) return;
      const p = [...path, `__b${i}`];
      if (i !== cls.primaryBase) out.push({ xpath: p, cls: b });
      this.secondaryGroups(b, p, out);
    });
    return out;
  }

  // ---------------------------------------------------------------- templates
  declareTemplate(it, env) {
    const tmpl = { name: it.name, ast: it, params: it.template, env, outOfLine: [], specs: new Map() };
    this.templates.set(it.name, tmpl);
    env.scope.set(it.name, { k: 'template', tmpl });
    return tmpl;
  }
  /** `template<> struct ColorMasks<565> { ... }`: the class used for those arguments instead of the template's. */
  declareSpecialisation(it, env) {
    const ent = this.lookupType(it.name, env);
    if (ent?.k !== 'template') this.fail(`'${it.name}' is not a class template`, it);
    const args = this.withDefaults(ent.tmpl, it.specArgs.map((a) => this.templateArg(a, env, it)), it);
    ent.tmpl.specs.set(args.map(T.mangle).join(','), { ast: it, env });
    return null;
  }
  /** The arguments of a template, its parameters' defaults filling those not given. */
  withDefaults(tmpl, args, node) {
    if (args.length > tmpl.params.length) this.fail(`template ${tmpl.name} takes ${tmpl.params.length} argument(s)`, node);
    const out = [...args];
    for (let i = out.length; i < tmpl.params.length; i++) {
      const p = tmpl.params[i];
      if (!p.def) this.fail(`template ${tmpl.name} takes ${tmpl.params.length} argument(s)`, node);
      // A default is read where the template was declared, the parameters before it bound.
      const denv = { scope: tmpl.env.scope, cls: tmpl.env.cls ?? null, bind: new Map([...(tmpl.env.bind ?? []), ...tmpl.params.slice(0, i).map((q, j) => [q.name, out[j]])]) };
      out.push(p.value ? this.templateArg({ expr: p.def }, denv, node) : this.declType(p.def.specs, p.def.derivs, denv, node));
    }
    tmpl.params.forEach((p, i) => {
      if (p.value !== (out[i].k === 'tvalue')) this.fail(`template ${tmpl.name}: argument ${i + 1} must be a ${p.value ? 'value' : 'type'}`, node);
    });
    return out;
  }
  instantiate(tmpl, args, node) {
    args = this.withDefaults(tmpl, args, node);
    const key = `${tmpl.name}<${args.map(T.mangle).join(',')}>`;
    let cls = this.instances.get(key);
    if (cls) return { k: 'class', cls };
    const spec = tmpl.specs?.get(args.map(T.mangle).join(','));
    const bind = new Map([...(tmpl.env.bind ?? []), ...(spec ? [] : tmpl.params.map((p, i) => [p.name, args[i]]))]);
    cls = this.newClass(tmpl.name, tmpl.ast.key, tmpl.ast, tmpl.env);
    cls.name = `${tmpl.name}<${args.map(T.show).join(', ')}>`;
    cls.cname = `${this.scopedName(tmpl.name, tmpl.env)}I${args.map(T.mangle).join('')}E`;
    cls.template = tmpl;
    cls.bind = bind;
    this.instances.set(key, cls);
    // Made complete when first needed so: `idList<idCameraEvent*>` may be named before its argument is.
    cls.pending = () => {
      const ast = spec ? spec.ast : tmpl.ast;
      const info = ast.info;
      this.declareClass(ast, spec ? spec.env : tmpl.env, { cls, bind });
      ast.info = info;
      // The template's own name inside an instance is that instance.
      cls.scope.set(tmpl.name, { k: 'type', type: { k: 'class', cls } });
    };
    return { k: 'class', cls };
  }

  // ---------------------------------------------------------------- function templates
  /**
   * A function template joins its name's overload set as a template: a call deduces its arguments,
   * makes the instance and lets it compete with the plain functions of the same name.
   */
  declareFunctionTemplate(it, env) {
    const name = this.lastName(it.decl.name);
    let set = env.scope.get(name);
    if (!set || set.k !== 'funcs') set = env.scope.set(name, { k: 'funcs', name, list: [] });
    set.templates ??= [];
    const nparams = it.decl.derivs[it.decl.derivs.length - 1].params.length;
    // A definition after a declaration completes it; the instances are made from the definition.
    let ft = set.templates.find((t) => t.params.length === it.template.length && t.nparams === nparams);
    if (!ft) { ft = { name, params: it.template, nparams, ast: it, env, instances: new Map() }; set.templates.push(ft); }
    if (it.k === 'func') ft.ast = it;
    return ft;
  }
  /** The instance of ft a call with these explicit template arguments and argument expressions makes, or null. */
  deduce(ft, explicit, args, env, node) {
    const names = ft.params.map((p) => p.name);
    const bind = new Map();
    explicit.forEach((a, i) => { if (i < names.length) bind.set(names[i], this.templateArg(a, env, node)); });
    if (explicit.length > names.length) return null;
    const fd = ft.ast.decl.derivs[ft.ast.decl.derivs.length - 1];
    if (args.length > fd.params.length && !fd.variadic) return null;
    let ok = true;
    // A parameter given explicitly is not deduced: its arguments are converted to it.
    const open = names.slice(explicit.length);
    fd.params.forEach((p, i) => { if (i < args.length && !this.deduceOne(p.specs, p.decl.derivs, args[i].t, bind, open)) ok = false; });
    if (!ok) return null;
    const out = [];
    for (const p of ft.params) {
      if (bind.has(p.name)) { out.push(bind.get(p.name)); continue; }
      if (!p.def) return null;
      const denv = { scope: ft.env.scope, cls: null, bind: new Map(ft.params.slice(0, out.length).map((q, j) => [q.name, out[j]])) };
      out.push(p.value ? this.templateArg({ expr: p.def }, denv, node) : this.declType(p.def.specs, p.def.derivs, denv, node));
    }
    return this.instantiateFunction(ft, out, node);
  }
  /**
   * Deduce from one parameter written `specs derivs` and the type of its argument: T, T*, T&, const T&.
   * False when the argument cannot match or contradicts an earlier deduction.
   */
  deduceOne(specs, derivs, argT, bind, names) {
    const ds = [...derivs];
    let a = argT;
    if (ds.length && ds[ds.length - 1].k === 'ref') ds.pop();
    else { if (a.k === 'array') a = T.ptr(a.of); else if (a.k === 'func') a = T.ptr(a); a = T.uncst(a); }
    while (ds.length) {
      const d = ds.pop();
      if (d.k !== 'ptr') return true;          // not a form deduced from: left to the instance's conversions
      if (a.k !== 'ptr') return false;
      a = a.to;
    }
    const st = specs.type;
    if (st?.k !== 'named' || st.qname.parts.length !== 1 || st.qname.parts[0].targs) return true;
    const n = st.qname.parts[0].name;
    if (!names.includes(n)) return true;
    if (specs.cv?.const) a = T.uncst(a);
    const prior = bind.get(n);
    if (prior) return prior.k !== 'tvalue' && T.same(prior, a);
    bind.set(n, a);
    return true;
  }
  instantiateFunction(ft, args, node) {
    const key = args.map(T.mangle).join(',');
    let f = ft.instances.get(key);
    if (f) return f;
    const it = ft.ast;
    const env = { scope: ft.env.scope, cls: ft.env.cls ?? null, bind: new Map([...(ft.env.bind ?? []), ...ft.params.map((p, i) => [p.name, args[i]])]) };
    const type = this.declType(it.specs, it.decl.derivs, env, it);
    const fd = it.decl.derivs[it.decl.derivs.length - 1];
    const ns = nsOf(ft.env.scope);
    f = {
      k: 'func', name: ft.name, display: `${ft.name}<${args.map(T.show).join(', ')}>`, cls: null, type, isStatic: true, cLink: false,
      node: it, params: this.paramInfo(fd, env), inline: true, fileStatic: true, fromTemplate: true,
    };
    // Every unit that uses an instance makes its own, as g++ makes a weak one: static here.
    f.cname = `${this.mangleName(ft.name, null, type, null, ns)}_I${args.map(T.mangle).join('')}E`;
    ft.instances.set(key, f);
    if (it.k === 'func') this.attachBody(f, it, env);
    return f;
  }

  // ---------------------------------------------------------------- functions
  mangleName(name, cls, type, conv, ns = null) {
    let n;
    if (conv) n = `cv${T.mangle(conv)}`;
    else if (name.startsWith('operator')) n = OP_CODE[name.slice(8)] ?? this.fail(`operator ${name.slice(8)}`);
    else if (cls && name === '<ctor>') n = 'C1';
    else if (cls && name === '<dtor>') n = 'D1';
    else n = `${name.length}${name}`;
    // A parameter's own const is not part of the function's type: f(int) and f(const int) are one.
    const sig = type.params.length ? type.params.map((p) => T.mangle(T.uncst(p))).join('') : 'v';
    return cls ? `_ZN${type.thisConst ? 'K' : ''}${cls.cname.length}${cls.cname}${n}E${sig}${type.variadic ? 'z' : ''}`
      : ns ? `_ZN${ns.cname.length}${ns.cname}${n}E${sig}${type.variadic ? 'z' : ''}`
      : `_Z${n}${sig}${type.variadic ? 'z' : ''}`;
  }

  /** A function declared or defined inside its class. `def` is the definition node, if it has a body. */
  memberFunction(m, cls, cenv, def) {
    const raw = this.lastName(m.decl.name);
    const part = m.decl.name.parts[m.decl.name.parts.length - 1];
    if (m.specs.friend) {
      // A friend is a function of the enclosing namespace, declared (or defined) from in here.
      let home = cls.scope.parent;
      while (home.cls && home.parent) home = home.parent;
      const outer = { scope: home, cls: null, bind: cenv.bind };
      const f = this.declareFunction(m, outer, { name: raw });
      if (def) this.attachBody(f, def, { scope: home, cls: null, bind: cenv.bind });
      return f;
    }
    const isCtor = raw === cls.node.name || raw === cls.template?.name;
    const isDtor = raw.startsWith('~');
    const derivs = m.decl.derivs;
    let type, conv = null;
    if (isCtor || isDtor) type = this.derive(T.VOID, derivs[derivs.length - 1], cenv, m);
    else if (part.conv) {
      conv = this.declType(part.conv.specs, part.conv.derivs, cenv, m);
      type = T.func(conv, [], false, !!derivs[derivs.length - 1].cv?.const);
    } else type = this.declType(m.specs, derivs, cenv, m);
    const name = isCtor ? '<ctor>' : isDtor ? '<dtor>' : raw;
    const isStatic = m.specs.storage === 'static';
    // A redeclaration (a template's members are declared once per instance, never twice).
    let f = cls.methods.find((x) => x.name === name && !!x.conv === !!conv && this.sameSignature(x.type, type) && (!conv || T.same(x.conv, conv)));
    if (!f) {
      f = {
        k: 'func', name, display: `${cls.name}::${raw}`, cls, type, isStatic, isVirtual: !!m.specs.virtual, isCtor, isDtor, conv,
        explicit: !!m.specs.explicit, pure: !!m.pure, cLink: false, inline: true, node: m,
        params: this.paramInfo(derivs[derivs.length - 1], cenv),
      };
      f.cname = this.mangleName(name, cls, type, conv);
      cls.methods.push(f);
      if (isCtor) cls.ctors.push(f);
      else if (isDtor) cls.dtor = f;
      else if (conv) cls.convs.push(f);
      else {
        const set = cls.scope.get(name);
        if (set?.k === 'funcs') set.list.push(f); else cls.scope.set(name, { k: 'funcs', name, list: [f] });
      }
    }
    if (def) this.attachBody(f, def, cenv);
    return f;
  }
  sameSignature(a, b) {
    return a.params.length === b.params.length && a.variadic === b.variadic && !!a.thisConst === !!b.thisConst
      && a.params.every((p, i) => T.same(p, b.params[i], { top: false }));
  }
  paramInfo(fd, env) {
    return fd.params.map((p) => ({ name: p.decl.name ? this.lastName(p.decl.name) : null, def: p.def, env }));
  }
  attachBody(f, def, env) {
    f.body = def.body;
    f.inits = def.inits ?? [];
    f.bodyEnv = env;
    f.defNode = def;
    // The definition's parameter names are the ones its body uses.
    const fd = def.decl.derivs[def.decl.derivs.length - 1];
    fd.params.forEach((p, i) => { if (f.params[i]) { f.params[i].name = p.decl.name ? this.lastName(p.decl.name) : f.params[i].name; if (p.def && !f.params[i].def) { f.params[i].def = p.def; f.params[i].env = env; } } });
  }

  /** A function declared at namespace scope (or a friend): added to its overload set. */
  declareFunction(it, env, { name = null } = {}) {
    name = name ?? this.lastName(it.decl.name);
    const part = it.decl.name.parts[it.decl.name.parts.length - 1];
    if (part.conv) this.fail('a conversion function outside a class', it);
    const type = this.declType(it.specs, it.decl.derivs, env, it);
    const cLink = !!it.cLink || name === 'main';
    let set = env.scope.get(name);
    // A function named as a class is: the class stays reachable by its tag.
    if (set?.k === 'type' && set.type.k === 'class') env.scope.set(`struct ${name}`, set);
    if (set && set.k !== 'funcs') set = null;
    let f = set?.list.find((x) => this.sameSignature(x.type, type));
    if (!f) {
      const fd = it.decl.derivs[it.decl.derivs.length - 1];
      f = {
        k: 'func', name, display: name, cls: null, type, isStatic: true, cLink, node: it, params: this.paramInfo(fd, env),
        inline: !!it.specs.inline, fileStatic: it.specs.storage === 'static' || !!nsOf(env.scope)?.internal,
      };
      f.cname = cLink ? name : this.mangleName(name, null, type, null, nsOf(env.scope));
      if (set) set.list.push(f); else env.scope.set(name, { k: 'funcs', name, list: [f] });
    } else {
      const fd = it.decl.derivs[it.decl.derivs.length - 1];
      fd.params.forEach((p, i) => { if (p.def && !f.params[i].def) { f.params[i].def = p.def; f.params[i].env = env; } });
      if (it.specs.inline) f.inline = true;
    }
    return f;
  }

  functionDefinition(it, env) {
    const q = it.decl.name.parts;
    if (q.length > 1) {
      // A member defined outside its class: A::f, or a class template's A<T>::f -- or a function of
      // a namespace defined from outside it, N::f.
      const ownerName = q[q.length - 2].name;
      const owner = this.qualified({ parts: q.slice(0, -1).map((p) => ({ name: p.name })), global: it.decl.name.global }, env, it);
      if (owner?.k === 'namespace') {
        const nenv = { scope: owner.ns.scope, cls: null, bind: env.bind };
        return this.functionDefinition({ ...it, decl: { ...it.decl, name: { parts: [q[q.length - 1]], global: false } } }, nenv);
      }
      const tmpl = owner?.k === 'template' ? owner.tmpl : null;
      if (it.template && tmpl) { tmpl.outOfLine.push(it); for (const cls of this.instances.values()) if (cls.template === tmpl && cls.complete) this.outOfLine(it, cls); return null; }
      const ot = this.namedType({ parts: q.slice(0, -1), global: it.decl.name.global }, env, it);
      if (ot.k !== 'class') this.fail(`'${ownerName}' is not a class`, it);
      this.complete(ot.cls, it);
      const f = this.outOfLine(it, ot.cls);
      // Not inline: this unit defines it for the whole program.
      if (!it.specs.inline) { f.inline = false; (this.defined ??= []).push(f); }
      return f;
    }
    const f = this.declareFunction(it, env);
    this.attachBody(f, it, env);
    if (!f.inline && !f.fileStatic) (this.defined ??= []).push(f);
    else if (f.fileStatic && !f.inline) (this.defined ??= []).push(f);
    return f;
  }
  /** Give the member of `cls` that this out-of-line definition defines its body. */
  outOfLine(it, cls) {
    const cenv = cls.env;
    const f = this.memberFunction({ ...it, decl: { ...it.decl, name: { parts: [it.decl.name.parts[it.decl.name.parts.length - 1]], global: false } }, specs: { ...it.specs, storage: null } }, cls, cenv, null);
    // Declared static in the class, it stays static however it is defined.
    this.attachBody(f, it, cenv);
    return f;
  }

  // ---------------------------------------------------------------- variables at file scope
  declaration(it, env) {
    const d = it.decl;
    if (!d.name) return null;                             // `struct X;` and the like
    const isFunc = d.derivs.length && d.derivs[d.derivs.length - 1].k === 'func';
    if (isFunc) return this.declareFunction(it, env);
    const q = d.name.parts;
    const name = this.lastName(d.name);
    // `template <class T> T *Singleton<T>::_singleton = 0;`: defined for each instance that uses it --
    // and its type means something only in one.
    if (q.length > 1 && it.template) {
      const owner = this.qualified({ parts: q.slice(0, -1).map((p) => ({ name: p.name })), global: d.name.global }, env, it);
      if (owner?.k === 'template') { (owner.tmpl.staticDefs ??= []).push(it); return null; }
    }
    let type = this.declType(it.specs, d.derivs, env, it);
    if (q.length > 1) {
      const owner = this.qualified({ parts: q.slice(0, -1).map((p) => ({ name: p.name })), global: d.name.global }, env, it);
      if (owner?.k === 'namespace') return this.declaration({ ...it, decl: { ...d, name: { parts: [q[q.length - 1]], global: false } } }, { scope: owner.ns.scope, cls: null, bind: env.bind });
      // The definition of a static data member: `int A::count = 0;`
      const ot = this.namedType({ parts: q.slice(0, -1), global: d.name.global }, env, it);
      const ent = ot.cls.scope.get(name);
      if (!ent || !ent.staticMember) this.fail(`'${name}' is not a static member of ${ot.cls.name}`, it);
      this.defineGlobal(ent, it, ot.cls.env);
      return ent;
    }
    if (type.k === 'array' && type.n == null && it.init?.k === 'braces') type = T.array(type.of, it.init.items.length);
    if (type.k === 'array' && type.n == null && it.init?.k === 'str') type = T.array(type.of, this.stringLength(it.init) + 1);
    const cLink = !!it.cLink;
    const prior = env.scope.get(name);
    // A namespace's variable is named after it in C, as its functions are (Itanium's _ZN...E).
    const ns = nsOf(env.scope);
    const cname = ns && !cLink ? `_ZN${ns.cname.length}${ns.cname}${name.length}${name}E` : name;
    const ent = prior?.k === 'var' ? prior : env.scope.set(name, { k: 'var', name, type, cname, global: true, cLink });
    if (prior?.k === 'var' && prior.type.k === 'array' && prior.type.n == null) prior.type = type;
    ent.storage = ns?.internal && it.specs.storage !== 'extern' ? 'static' : it.specs.storage;
    if (type.c && T.isInteger(type) && it.init) { const v = this.constInt(it.init, env); if (v !== null) ent.constValue = v; }
    if (it.specs.storage === 'extern' && !it.init && !it.ctorArgs) { ent.externOnly = !ent.definedHere; return ent; }
    ent.definedHere = true; ent.externOnly = false;
    this.defineGlobal(ent, it, env);
    return ent;
  }
}

Object.assign(Sema.prototype, exprMethods, stmtMethods);
