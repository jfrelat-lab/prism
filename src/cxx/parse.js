// parse.js — C++ (the C++03 subset real game code of the late 1990s uses) into an unresolved tree.
//
// The tree is resolved and lowered to C by sema.js. This file decides only SHAPE, and the one thing
// shape cannot be decided without is whether a name is a TYPE: `T(x)` is a construction or a call,
// `A<B>` a template-id or two comparisons, `T * x;` a declaration or a product. So the parser keeps a
// small scope chain of what names a type -- classes, typedefs, enums, template parameters -- and
// nothing else; every other question is sema's.
//
// What is parsed (and what is refused, loudly, rather than half-read):
//   classes and structs with access specifiers, bases (single or multiple, `virtual` refused),
//   member functions inline or out of line, constructors with initialiser lists, destructors,
//   virtual functions, static members, friends, nested typedefs and enums, operator overloading
//   including conversion functions, references, default arguments, class templates with their
//   out-of-line members, new/delete (and their [] forms), `this`, C-style and functional casts,
//   `extern "C"` blocks, bool/true/false.
//   Not parsed: namespaces, exceptions, RTTI, member templates, function templates, the cast
//   keywords, pointers to members.

import { ID, NUM, STR, CHR, PUNCT, EOF } from '../cpp/token.js';

export class CxxError extends Error {
  constructor(msg, tok) {
    super(tok?.loc ? `${tok.loc.file}:${tok.loc.line}: ${msg}` : msg);
    this.tok = tok;
  }
}

const BUILTIN = new Set(['void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double', 'signed',
  'unsigned', '__signed', '__signed__', '_Bool', 'wchar_t']);
const CV = new Set(['const', 'volatile', '__const', '__const__', '__volatile', '__volatile__', 'restrict',
  '__restrict', '__restrict__']);
const STORAGE = new Set(['static', 'extern', 'typedef', 'register', 'auto', 'mutable']);
const FUNCSPEC = new Set(['inline', '__inline', '__inline__', 'virtual', 'explicit', 'friend']);
const KEYWORDS = new Set([...BUILTIN, ...CV, ...STORAGE, ...FUNCSPEC, 'class', 'struct', 'union', 'enum',
  'public', 'private', 'protected', 'operator', 'template', 'typename', 'this', 'new', 'delete',
  'true', 'false', 'sizeof', 'return', 'if', 'else', 'while', 'do', 'for', 'switch', 'case', 'default',
  'break', 'continue', 'goto', 'namespace', 'using', 'try', 'catch', 'throw', 'static_cast',
  'dynamic_cast', 'const_cast', 'reinterpret_cast', 'typeid', '__attribute__', '__extension__',
  '__asm__', 'asm', '__typeof__', 'typeof']);
const REFUSED = new Set(['namespace', 'using', 'try', 'catch', 'throw', 'dynamic_cast', 'typeid']);
const NAMED_CASTS = new Set(['static_cast', 'const_cast', 'reinterpret_cast']);

// Binary operators by precedence, loosest first (assignment, ?: and comma are handled apart).
const BINARY = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'],
  ['+', '-'], ['*', '/', '%']];
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
// What may follow `operator` as an overloadable operator, longest first.
const OPERATORS = ['new[]', 'delete[]', '->*', '<<=', '>>=', '()', '[]', '->', '++', '--', '<<', '>>', '<=',
  '>=', '==', '!=', '&&', '||', '*=', '/=', '%=', '+=', '-=', '&=', '^=', '|=', '+', '-', '*', '/', '%',
  '^', '&', '|', '~', '!', '=', '<', '>', ',', 'new', 'delete'];

/** A scope of what names are types to the PARSER. */
class PScope {
  constructor(parent = null, cls = null) { this.parent = parent; this.names = new Map(); this.cls = cls; }
  set(name, kind) { this.names.set(name, kind); }
  find(name) { for (let s = this; s; s = s.parent) { const k = s.names.get(name); if (k) return k; } return null; }
}

/**
 * Parse a preprocessed token stream. `cLinkage(tok)` says whether a token comes from a header PRISM
 * supplies -- C headers, whose declarations have C linkage as if wrapped in extern "C".
 */
export function parseCxx(tokens, { cLinkage = () => false } = {}) {
  return new CxxParser(tokens, cLinkage).unit();
}

class CxxParser {
  constructor(tokens, cLinkage) {
    // `::` is not a C punctuator; two adjacent colons with nothing between are one here.
    const ts = [];
    for (const t of tokens) {
      if (t.k === 'pm') continue;
      const last = ts[ts.length - 1];
      if (t.k === PUNCT && t.v === ':' && last && last.k === PUNCT && last.v === ':' && !last.merged && !t.ws) {
        ts[ts.length - 1] = { ...last, v: '::', merged: true };
        continue;
      }
      ts.push(t);
    }
    this.ts = ts;
    this.i = 0;
    this.cLinkage = cLinkage;
    this.scope = new PScope();
    this.classScopes = new Map();          // class (or template) name -> its PScope, for A::member
    this.linkage = null;                   // 'C' inside extern "C" { }
  }

  // ---------------------------------------------------------------- tokens
  peek(k = 0) { return this.ts[this.i + k] ?? this.ts[this.ts.length - 1]; }
  next() { return this.ts[this.i++]; }
  get done() { return this.peek().k === EOF; }
  isP(v, k = 0) { const t = this.peek(k); return t.k === PUNCT && t.v === v; }
  isKw(v, k = 0) { const t = this.peek(k); return t.k === ID && t.v === v; }
  eatP(v) { if (this.isP(v)) { this.i++; return true; } return false; }
  eatKw(v) { if (this.isKw(v)) { this.i++; return true; } return false; }
  expectP(v) { if (!this.eatP(v)) this.fail(`expected '${v}' but found '${this.peek().v || 'end of file'}'`); }
  fail(msg, t = this.peek()) { throw new CxxError(msg, t); }
  isIdent(k = 0) { const t = this.peek(k); return t.k === ID && !KEYWORDS.has(t.v); }
  ident() { if (!this.isIdent()) this.fail(`expected an identifier, found '${this.peek().v}'`); return this.next().v; }
  loc() { return this.peek().loc; }

  /** Is the name at position k a type (class, typedef, enum, template parameter)? */
  typeKind(name) { return this.scope.find(name); }
  isTypeName(k = 0) {
    const t = this.peek(k);
    if (t.k !== ID || KEYWORDS.has(t.v)) return false;
    const kind = this.typeKind(t.v);
    return kind === 'type' || kind === 'template';
  }
  /** Does a type specifier start here? (a declaration, a cast, a sizeof(type)) */
  startsType(k = 0) {
    const t = this.peek(k);
    if (t.k !== ID) return false;
    if (BUILTIN.has(t.v) || CV.has(t.v) || ['class', 'struct', 'union', 'enum', 'typename'].includes(t.v)) return true;
    if (t.v === '::') return false;
    // A qualified type: A::B where A is a class and B a type inside it.
    if (this.isTypeName(k)) {
      let j = k + 1;
      if (this.typeKind(t.v) === 'template' && this.isP('<', j)) j = this.skipAngles(j);
      if (this.isP('::', j)) {
        const inner = this.peek(j + 1);
        const cs = this.classScopes.get(t.v);
        return !!(cs && inner.k === ID && cs.names.get(inner.v));
      }
      return true;
    }
    return false;
  }
  /** Index just past a balanced <...> starting at k (which is '<'). */
  skipAngles(k) {
    let depth = 0, j = k;
    for (;;) {
      const t = this.peek(j);
      if (t.k === EOF) return j;
      if (t.k === PUNCT && t.v === '<') depth++;
      else if (t.k === PUNCT && t.v === '>') { depth--; if (depth === 0) return j + 1; }
      else if (t.k === PUNCT && t.v === '>>') { depth -= 2; if (depth <= 0) return j + 1; }
      else if (t.k === PUNCT && (t.v === ';' || t.v === '{')) return j;
      j++;
    }
  }

  // ---------------------------------------------------------------- translation unit
  unit() {
    const items = [];
    while (!this.done) {
      const it = this.topItem();
      if (it) items.push(...[].concat(it));
    }
    return { k: 'unit', items };
  }

  topItem() {
    if (this.eatP(';')) return null;
    if (this.eatKw('__extension__')) return null;
    const t = this.peek();
    if (t.k === PUNCT && t.v === '#') { this.skipPragma(); return null; }
    if (this.isKw('extern') && this.peek(1).k === STR) {
      this.next();
      const lang = this.next().v.replace(/^"|"$/g, '');
      const saved = this.linkage;
      this.linkage = lang === 'C' ? 'C' : null;
      try {
        if (this.eatP('{')) {
          const items = [];
          while (!this.isP('}') && !this.done) { const it = this.topItem(); if (it) items.push(...[].concat(it)); }
          this.expectP('}');
          return items;
        }
        return this.topItem();
      } finally { this.linkage = saved; }
    }
    if (this.isKw('template')) return this.templateDecl();
    if (t.k === ID && REFUSED.has(t.v)) this.fail(`C++ '${t.v}' is not supported`);
    return this.declaration({ top: true });
  }

  skipPragma() {
    const line = this.peek().loc?.line;
    this.next();
    while (!this.done && this.peek().loc?.line === line && !this.peek().bol) this.next();
  }

  // ---------------------------------------------------------------- templates
  templateDecl() {
    this.next();
    this.expectP('<');
    const params = [];
    while (!this.isP('>')) {
      if (!this.eatKw('class') && !this.eatKw('typename')) this.fail('only type template parameters are supported');
      params.push(this.ident());
      if (!this.eatP(',')) break;
    }
    this.expectP('>');
    // A class template is a template inside its own body too: `~idList<type>()`.
    if ((this.isKw('class') || this.isKw('struct')) && this.isIdent(1) && (this.isP('{', 2) || this.isP(':', 2))) this.scope.set(this.peek(1).v, 'template');
    const scope = new PScope(this.scope);
    for (const p of params) scope.set(p, 'type');
    const saved = this.scope;
    this.scope = scope;
    let decl;
    try { decl = this.declaration({ top: true, template: params }); } finally { this.scope = saved; }
    // The class template's name is a template to everyone after it.
    for (const d of [].concat(decl)) if (d.k === 'class' && d.name) this.scope.set(d.name, 'template');
    return [].concat(decl).map((d) => ({ ...d, template: params }));
  }

  /** `<args>` after a template name: each a type-id (only type arguments are supported). */
  templateArgs() {
    this.expectP('<');
    const args = [];
    while (!this.isP('>')) {
      args.push(this.typeId());
      if (!this.eatP(',')) break;
    }
    this.expectP('>');
    return args;
  }

  // ---------------------------------------------------------------- names
  /**
   * A possibly qualified name: `x`, `A::x`, `A<T>::x`, `::x`, `~A`, `A::~A`, `operator+`,
   * `A::operator float *`. Each part is { name, targs }; a conversion function's part has `conv`.
   */
  qualName({ allowOperator = true } = {}) {
    const parts = [];
    const global = this.eatP('::');
    for (;;) {
      const part = {};
      if (this.eatP('~')) { part.name = `~${this.ident()}`; if (this.isP('<') && this.isTemplate(part.name.slice(1))) this.templateArgs(); }
      else if (allowOperator && this.isKw('operator')) {
        this.next();
        const op = this.operatorName();
        if (typeof op === 'string') part.name = `operator${op}`;
        else { part.name = 'operator conv'; part.conv = op; }
      } else {
        part.name = this.ident();
        if (this.isP('<') && this.isTemplate(part.name)) part.targs = this.templateArgs();
      }
      parts.push(part);
      if (this.isP('::') && (this.peek(1).k === ID || this.isP('~', 1))) { this.next(); continue; }
      break;
    }
    return { parts, global };
  }
  isTemplate(name) { return this.typeKind(name) === 'template'; }

  operatorName() {
    for (const op of OPERATORS) {
      if (op === 'new[]' || op === 'delete[]') {
        if (this.isKw(op.slice(0, -2)) && this.isP('[', 1) && this.isP(']', 2)) { this.i += 3; return op; }
        continue;
      }
      if (op === 'new' || op === 'delete') { if (this.eatKw(op)) return op; continue; }
      if (op === '()') { if (this.isP('(') && this.isP(')', 1)) { this.i += 2; return op; } continue; }
      if (op === '[]') { if (this.isP('[') && this.isP(']', 1)) { this.i += 2; return op; } continue; }
      if (this.isP(op)) { this.next(); return op; }
    }
    // A conversion function: operator <type-specifiers> <ptr-operators>
    const specs = this.declSpecifiers({ allowNone: false });
    const derivs = [];
    for (;;) {
      if (this.eatP('*')) { derivs.push({ k: 'ptr', cv: this.cvList() }); continue; }
      if (this.eatP('&')) { derivs.push({ k: 'ref' }); continue; }
      break;
    }
    return { specs, derivs };
  }

  cvList() {
    const cv = {};
    while (this.peek().k === ID && CV.has(this.peek().v)) {
      const v = this.next().v.replace(/^__|__$/g, '');
      if (v === 'const' || v === 'volatile') cv[v] = true;
    }
    return cv;
  }

  // ---------------------------------------------------------------- declaration specifiers
  /**
   * { storage, inline, virtual, friend, explicit, cv, type } where type is one of
   *   { k:'builtin', words:[...] }  { k:'named', qname }  { k:'class', ... }  { k:'enum', ... }
   */
  declSpecifiers({ allowNone = true, inExpr = false } = {}) {
    const s = { storage: null, inline: false, virtual: false, friend: false, explicit: false, cv: {}, type: null };
    const words = [];
    for (;;) {
      const t = this.peek();
      if (t.k !== ID) break;
      const v = t.v;
      if (STORAGE.has(v)) { this.next(); if (v !== 'register' && v !== 'auto' && v !== 'mutable') s.storage = v; continue; }
      if (CV.has(v)) { this.next(); const c = v.replace(/^__|__$/g, ''); if (c === 'const' || c === 'volatile') s.cv[c] = true; continue; }
      if (v === 'inline' || v === '__inline' || v === '__inline__') { this.next(); s.inline = true; continue; }
      if (v === 'virtual') { this.next(); s.virtual = true; continue; }
      if (v === 'friend') { this.next(); s.friend = true; continue; }
      if (v === 'explicit') { this.next(); s.explicit = true; continue; }
      if (v === '__extension__') { this.next(); continue; }
      if (v === '__attribute__') { this.skipAttribute(); continue; }
      if (BUILTIN.has(v) && !s.type) { this.next(); words.push(v); continue; }
      if (words.length) break;
      if (s.type) break;
      if (v === 'class' || v === 'struct' || v === 'union') { s.type = this.classSpecifier(); continue; }
      if (v === 'enum') { s.type = this.enumSpecifier(); continue; }
      if (v === 'typename') { this.next(); s.type = { k: 'named', qname: this.qualName({ allowOperator: false }) }; continue; }
      if (this.startsType()) {
        // A constructor declaration `A(` / `A::A(` inside its own class is not a type specifier.
        if (!inExpr && this.isConstructorAhead()) break;
        s.type = { k: 'named', qname: this.qualName({ allowOperator: false }) };
        continue;
      }
      break;
    }
    if (words.length) s.type = { k: 'builtin', words };
    if (!s.type && !allowNone) this.fail(`expected a type, found '${this.peek().v}'`);
    return s;
  }

  /** At a type name, is this a constructor's declarator rather than a type? (`A(`, `A::A(`) */
  isConstructorAhead() {
    const t = this.peek();
    const cls = this.scope.cls;
    if (cls && t.v === cls && this.isP('(', 1)) return true;
    // Out of line: A::A( or A<T>::A(
    let j = 1;
    if (this.isP('<', j) && this.isTemplate(t.v)) j = this.skipAngles(j);
    if (this.isP('::', j) && this.peek(j + 1).v === t.v && this.isP('(', j + 2)) return true;
    return false;
  }

  skipAttribute() {
    this.next();
    this.expectP('(');
    let depth = 1;
    while (depth && !this.done) { const t = this.next(); if (t.k === PUNCT && t.v === '(') depth++; if (t.k === PUNCT && t.v === ')') depth--; }
  }

  enumSpecifier() {
    this.next();
    const loc = this.loc();
    let name = null;
    if (this.isIdent()) name = this.ident();
    if (name) this.scope.set(name, 'type');
    if (!this.eatP('{')) return { k: 'named', qname: { parts: [{ name }], global: false }, enumRef: true };
    const values = [];
    while (!this.isP('}')) {
      const n = this.ident();
      let e = null;
      if (this.eatP('=')) e = this.assignment();
      values.push({ name: n, e });
      if (!this.eatP(',')) break;
    }
    this.expectP('}');
    return { k: 'enum', name, values, loc };
  }

  classSpecifier() {
    const key = this.next().v;
    const loc = this.loc();
    if (this.isKw('__attribute__')) this.skipAttribute();
    let name = null;
    if (this.isIdent()) name = this.ident();
    if (name && !this.isTemplate(name)) this.scope.set(name, 'type');
    if (!this.isP('{') && !this.isP(':')) {
      return { k: 'named', qname: { parts: [{ name }], global: false }, elaborated: key };
    }
    const bases = [];
    if (this.eatP(':')) {
      for (;;) {
        let access = key === 'class' ? 'private' : 'public', virt = false;
        for (;;) {
          if (this.eatKw('public')) { access = 'public'; continue; }
          if (this.eatKw('protected')) { access = 'protected'; continue; }
          if (this.eatKw('private')) { access = 'private'; continue; }
          if (this.eatKw('virtual')) { virt = true; continue; }
          break;
        }
        if (virt) this.fail('virtual base classes are not supported');
        bases.push({ qname: this.qualName({ allowOperator: false }), access });
        if (!this.eatP(',')) break;
      }
    }
    this.expectP('{');
    const scope = new PScope(this.scope, name);
    if (name) { scope.set(name, this.typeKind(name) === 'template' ? 'template' : 'type'); this.classScopes.set(name, scope); }
    const saved = this.scope;
    this.scope = scope;
    const members = [];
    let access = key === 'class' ? 'private' : 'public';
    try {
      while (!this.isP('}') && !this.done) {
        if (this.eatP(';')) continue;
        if ((this.isKw('public') || this.isKw('private') || this.isKw('protected')) && this.isP(':', 1)) {
          access = this.next().v; this.next(); continue;
        }
        if (this.isKw('template')) this.fail('member templates are not supported');
        // The same object, not a copy: a member declared with a class defined in place points at that definition.
        for (const m of [].concat(this.declaration({ member: true, cls: name }))) { m.access = access; members.push(m); }
      }
    } finally { this.scope = saved; }
    this.expectP('}');
    return { k: 'class', key, name, bases, members, loc, cLinkage: this.cLinkage(this.ts[this.i - 1]) };
  }

  // ---------------------------------------------------------------- declarations
  /**
   * One declaration: a function definition, or specifiers and a comma list of declarators. Returns
   * an array of items; a class or enum defined in the specifiers comes first, as its own item.
   */
  declaration({ top = false, member = false, cls = null, template = null } = {}) {
    const loc = this.loc();
    const cLink = this.linkage === 'C' || this.cLinkage(this.peek());
    const specs = this.declSpecifiers();
    const out = [];
    if (specs.type && (specs.type.k === 'class' || specs.type.k === 'enum')) {
      out.push(specs.type);
      specs.type = { k: 'named', qname: { parts: [{ name: specs.type.name }], global: false }, defined: specs.type };
    }
    if (this.eatP(';')) {
      // A bare `class X;` declares the class, to be completed later; `friend class X;` nothing here.
      if (specs.type?.elaborated && !specs.friend) out.push({ k: 'fwdclass', name: specs.type.qname.parts[0].name, key: specs.type.elaborated, loc });
      return out;
    }
    for (;;) {
      const d = this.declarator();
      if (this.isKw('__attribute__')) this.skipAttribute();
      if (this.isKw('__asm__') || this.isKw('asm')) { this.next(); this.expectP('('); while (!this.eatP(')')) this.next(); }
      const isFunc = d.derivs.length && d.derivs[d.derivs.length - 1].k === 'func';
      // A constructor's member initialisers, then a body.
      if (isFunc && (this.isP('{') || this.isP(':'))) {
        out.push(this.functionDefinition(specs, d, { loc, cLink, cls, member }));
        return out;
      }
      const item = { k: specs.storage === 'typedef' ? 'typedef' : 'decl', specs, decl: d, loc, cLink };
      if (specs.storage === 'typedef' && d.name) this.scope.set(d.name.parts[d.name.parts.length - 1].name, 'type');
      if (isFunc && this.eatP('=')) {
        // `= 0`: a pure virtual function.
        const z = this.next();
        if (z.v !== '0') this.fail('expected 0 after = in a function declaration');
        item.pure = true;
      } else if (this.eatP('=')) {
        item.init = this.isP('{') ? this.braceInit() : this.assignment();
      } else if (this.isP('(') && !isFunc) {
        // Direct initialisation: `T x(a, b);`
        this.next();
        item.ctorArgs = this.isP(')') ? [] : this.exprList();
        this.expectP(')');
      }
      if (member && this.eatP(':')) item.bits = this.conditional();
      out.push(item);
      if (this.eatP(',')) continue;
      this.expectP(';');
      return out;
    }
  }

  braceInit() {
    this.expectP('{');
    const items = [];
    while (!this.isP('}')) {
      items.push(this.isP('{') ? this.braceInit() : this.assignment());
      if (!this.eatP(',')) break;
    }
    this.expectP('}');
    return { k: 'braces', items };
  }

  functionDefinition(specs, d, { loc, cLink, cls, member }) {
    // Members of the class named by the qualifier are in scope in the body (A::f's body sees A's
    // nested types); a member defined inside its class already has that scope.
    const q = d.name.parts;
    const owner = q.length > 1 ? q[q.length - 2].name : null;
    const ownerScope = owner ? this.classScopes.get(owner) : null;
    const saved = this.scope;
    if (ownerScope) {
      const s = new PScope(this.scope, owner);
      for (const [k, v] of ownerScope.names) s.set(k, v);
      this.scope = s;
    }
    try {
      const inits = [];
      if (this.eatP(':')) {
        for (;;) {
          const name = this.qualName({ allowOperator: false });
          this.expectP('(');
          const args = this.isP(')') ? [] : this.exprList();
          this.expectP(')');
          inits.push({ name, args });
          if (!this.eatP(',')) break;
        }
      }
      const body = this.compound();
      return { k: 'func', specs, decl: d, inits, body, loc, cLink, inClass: member ? cls : null };
    } finally { this.scope = saved; }
  }

  /**
   * A declarator: { name (qualName or null), derivs } where derivs apply to the specifiers' type in
   * order -- `int *a[3]` is [ptr, array 3]: the pointer first, then the array of them.
   */
  declarator({ abstract = false } = {}) {
    const ptrs = [];
    for (;;) {
      if (this.eatP('*')) { ptrs.push({ k: 'ptr', cv: this.cvList() }); continue; }
      if (this.eatP('&')) { ptrs.push({ k: 'ref' }); continue; }
      if (this.isKw('__attribute__')) { this.skipAttribute(); continue; }
      break;
    }
    let name = null, inner = null;
    if (this.isP('(') && this.parenIsDeclarator()) {
      this.next();
      inner = this.declarator({ abstract });
      this.expectP(')');
    } else if (this.isIdent() || this.isP('::') || this.isP('~') || this.isKw('operator')) {
      if (!abstract || this.isIdent() || this.isKw('operator')) name = this.qualName();
    }
    // After `A::f` the rest of the declarator is read in A's scope: `idList<type>::Sort( cmp_t * )`.
    const q = name?.parts;
    const ownerScope = q && q.length > 1 ? this.classScopes.get(q[q.length - 2].name) : null;
    const savedScope = this.scope;
    if (ownerScope) { const sc = new PScope(this.scope, q[q.length - 2].name); for (const [k, v] of ownerScope.names) sc.set(k, v); this.scope = sc; }
    const suffixes = [];
    try {
    for (;;) {
      if (this.isP('[')) {
        this.next();
        const size = this.isP(']') ? null : this.assignment();
        this.expectP(']');
        suffixes.push({ k: 'array', size });
        continue;
      }
      if (this.isP('(') && (name || inner || abstract) && this.parenIsParams()) {
        const f = this.paramList();
        f.cv = this.cvList();
        if (this.isKw('throw')) { this.next(); this.expectP('('); while (!this.eatP(')')) this.next(); }
        suffixes.push(f);
        continue;
      }
      break;
    }
    } finally { this.scope = savedScope; }
    const derivs = [...ptrs, ...suffixes.reverse(), ...(inner ? inner.derivs : [])];
    return { name: inner ? inner.name : name, derivs };
  }

  /** `(` opening a nested declarator (`(*fp)(int)`), not a parameter list. */
  parenIsDeclarator() {
    return this.isP('*', 1) || this.isP('&', 1) || (this.isP('(', 1)) || (this.isIdent(1) && !this.isTypeName(1) && this.isP(')', 2) && this.isP('(', 3));
  }
  /** At `(` after a declarator name: a parameter list rather than a direct initialiser `T x(a)`. */
  parenIsParams() {
    if (this.isP(')', 1)) return true;
    if (this.isKw('void', 1) && this.isP(')', 2)) return true;
    if (this.isP('...', 1)) return true;
    if (!this.startsType(1)) return false;
    // A type, then what can open a parameter's declarator. `idVec3( 1, 0, 0 )` as an argument is a
    // temporary, so `mat3_t m( idVec3( 1, 0, 0 ) )` is an object, not a function declaration.
    const j = this.skipTypeSpec(1);
    const t = this.peek(j);
    if (t.k === PUNCT) {
      if ([',', ')', '*', '&', '[', '='].includes(t.v)) return true;
      if (t.v === '(') return this.isP('*', j + 1) || this.isP('&', j + 1);
      return false;
    }
    return t.k === ID;
  }
  /** Index past the type specifier starting at k: cv words, builtin words or one qualified name. */
  skipTypeSpec(k) {
    let j = k, sawType = false;
    for (;;) {
      const t = this.peek(j);
      if (t.k !== ID) return j;
      if (CV.has(t.v) || t.v === 'typename') { j++; continue; }
      if (BUILTIN.has(t.v)) { j++; sawType = true; continue; }
      if (['class', 'struct', 'union', 'enum'].includes(t.v)) { j += 2; sawType = true; continue; }
      if (sawType) return j;
      if (this.isTypeName(j)) {
        j++;
        if (this.isTemplate(t.v) && this.isP('<', j)) j = this.skipAngles(j);
        while (this.isP('::', j)) { j += 2; if (this.isP('<', j)) j = this.skipAngles(j); }
        sawType = true;
        continue;
      }
      return j;
    }
  }

  paramList() {
    this.expectP('(');
    const params = [];
    let variadic = false;
    if (this.isKw('void') && this.isP(')', 1)) { this.next(); }
    while (!this.isP(')')) {
      if (this.eatP('...')) { variadic = true; break; }
      const specs = this.declSpecifiers({ allowNone: false });
      const d = this.declarator({ abstract: true });
      let def = null;
      if (this.eatP('=')) def = this.assignment();
      params.push({ specs, decl: d, def });
      if (!this.eatP(',')) break;
    }
    this.expectP(')');
    return { k: 'func', params, variadic };
  }

  typeId() {
    const specs = this.declSpecifiers({ allowNone: false });
    const d = this.declarator({ abstract: true });
    return { specs, derivs: d.derivs };
  }

  // ---------------------------------------------------------------- statements
  compound() {
    const loc = this.loc();
    this.expectP('{');
    const saved = this.scope;
    this.scope = new PScope(this.scope, saved.cls);
    const stmts = [];
    try {
      while (!this.isP('}') && !this.done) stmts.push(this.statement());
    } finally { this.scope = saved; }
    this.expectP('}');
    return { k: 'block', stmts, loc };
  }

  statement() {
    const loc = this.loc();
    const t = this.peek();
    if (t.k === PUNCT && t.v === '{') return this.compound();
    if (this.eatP(';')) return { k: 'null', loc };
    if (t.k === ID) {
      switch (t.v) {
        case 'if': {
          this.next(); this.expectP('('); const c = this.expression(); this.expectP(')');
          const a = this.statement(); const b = this.eatKw('else') ? this.statement() : null;
          return { k: 'if', c, a, b, loc };
        }
        case 'while': { this.next(); this.expectP('('); const c = this.expression(); this.expectP(')'); return { k: 'while', c, body: this.statement(), loc }; }
        case 'do': {
          this.next(); const body = this.statement();
          if (!this.eatKw('while')) this.fail('expected while');
          this.expectP('('); const c = this.expression(); this.expectP(')'); this.expectP(';');
          return { k: 'do', c, body, loc };
        }
        case 'for': {
          this.next(); this.expectP('(');
          const saved = this.scope;
          this.scope = new PScope(this.scope, saved.cls);
          try {
            let init = null;
            if (!this.isP(';')) {
              if (this.startsDeclaration()) init = { k: 'decl', items: this.declaration(), loc };
              else { init = { k: 'expr', e: this.expression(), loc }; this.expectP(';'); }
            } else this.next();
            const c = this.isP(';') ? null : this.expression(); this.expectP(';');
            const step = this.isP(')') ? null : this.expression(); this.expectP(')');
            return { k: 'for', init, c, step, body: this.statement(), loc };
          } finally { this.scope = saved; }
        }
        case 'switch': { this.next(); this.expectP('('); const c = this.expression(); this.expectP(')'); return { k: 'switch', c, body: this.statement(), loc }; }
        case 'case': { this.next(); const e = this.conditional(); this.expectP(':'); return { k: 'case', e, loc }; }
        case 'default': if (this.isP(':', 1)) { this.next(); this.next(); return { k: 'default', loc }; } break;
        case 'break': this.next(); this.expectP(';'); return { k: 'break', loc };
        case 'continue': this.next(); this.expectP(';'); return { k: 'continue', loc };
        case 'return': { this.next(); const e = this.isP(';') ? null : this.expression(); this.expectP(';'); return { k: 'return', e, loc }; }
        case 'goto': { this.next(); const name = this.ident(); this.expectP(';'); return { k: 'goto', name, loc }; }
        default:
          if (REFUSED.has(t.v)) this.fail(`C++ '${t.v}' is not supported`);
      }
      if (this.isIdent() && this.isP(':', 1) && !this.isTypeName()) {
        const name = this.next().v; this.next();
        return { k: 'label', name, s: this.statement(), loc };
      }
    }
    if (this.startsDeclaration()) return { k: 'decl', items: this.declaration(), loc };
    const e = this.expression();
    this.expectP(';');
    return { k: 'expr', e, loc };
  }

  /** A declaration statement, as opposed to an expression that starts with a type's name. */
  startsDeclaration() {
    const t = this.peek();
    if (t.k !== ID) return false;
    if (STORAGE.has(t.v) || (CV.has(t.v)) || t.v === 'class' || t.v === 'struct' || t.v === 'union' || t.v === 'enum') return true;
    if (BUILTIN.has(t.v)) return !this.isP('(', 1);      // `int(x)` is a cast
    if (!this.startsType()) return false;
    // `T(args).m()` and `T(args);` are expressions; `T x`, `T *x`, `T &x`, `T<U> x`, `A::B x` declare.
    let j = 1;
    if (this.isTemplate(t.v) && this.isP('<', j)) j = this.skipAngles(j);
    while (this.isP('::', j)) j += 2;
    return !this.isP('(', j) && !this.isP('.', j) && !this.isP('->', j);
  }

  // ---------------------------------------------------------------- expressions
  expression() {
    let e = this.assignment();
    while (this.isP(',')) { this.next(); e = { k: 'comma', a: e, b: this.assignment(), loc: e.loc }; }
    return e;
  }
  exprList() {
    const out = [this.assignment()];
    while (this.eatP(',')) out.push(this.assignment());
    return out;
  }
  assignment() {
    const a = this.conditional();
    const t = this.peek();
    if (t.k === PUNCT && ASSIGN.has(t.v)) { this.next(); return { k: 'assign', op: t.v, a, b: this.assignment(), loc: t.loc }; }
    return a;
  }
  conditional() {
    const c = this.binary(0);
    if (this.isP('?')) {
      const loc = this.loc(); this.next();
      const a = this.expression(); this.expectP(':');
      return { k: 'cond', c, a, b: this.assignment(), loc };
    }
    return c;
  }
  binary(level) {
    if (level === BINARY.length) return this.unary();
    let a = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.k !== PUNCT || !BINARY[level].includes(t.v)) return a;
      this.next();
      a = { k: 'bin', op: t.v, a, b: this.binary(level + 1), loc: t.loc };
    }
  }
  unary() {
    const t = this.peek();
    const loc = t.loc;
    if (t.k === PUNCT) {
      if (t.v === '++' || t.v === '--') { this.next(); return { k: 'pre', op: t.v, e: this.unary(), loc }; }
      if (['-', '+', '!', '~', '*', '&'].includes(t.v)) { this.next(); return { k: 'unary', op: t.v, e: this.castExpr(), loc }; }
    }
    if (t.k === ID) {
      if (t.v === 'sizeof') {
        this.next();
        if (this.isP('(') && this.startsType(1)) { this.next(); const ty = this.typeId(); this.expectP(')'); return { k: 'sizeof', type: ty, loc }; }
        return { k: 'sizeof', e: this.unary(), loc };
      }
      if (t.v === 'new' || (t.v === '::' && this.isKw('new', 1))) return this.newExpr();
      if (t.v === 'delete') {
        this.next();
        let array = false;
        if (this.isP('[') && this.isP(']', 1)) { this.i += 2; array = true; }
        return { k: 'delete', array, e: this.castExpr(), loc };
      }
      if (t.v === '__extension__') { this.next(); return this.castExpr(); }
    }
    return this.castExpr();
  }
  castExpr() {
    if (this.isP('(') && this.startsType(1)) {
      // `(T)e`, unless it is `(T)` followed by nothing castable -- C++ has no compound literals here.
      const save = this.i;
      this.next();
      const ty = this.typeId();
      if (this.eatP(')')) {
        const loc = this.peek().loc;
        return { k: 'cast', type: ty, e: this.unary(), loc };
      }
      this.i = save;
    }
    return this.postfix(this.primary());
  }
  newExpr() {
    const loc = this.loc();
    this.eatP('::');
    this.next();
    let type;
    if (this.isP('(')) { this.next(); type = this.typeId(); this.expectP(')'); }
    else {
      const specs = this.declSpecifiers({ allowNone: false });
      const derivs = [];
      while (this.eatP('*')) derivs.push({ k: 'ptr', cv: this.cvList() });
      type = { specs, derivs };
    }
    let count = null, args = null;
    if (this.eatP('[')) { count = this.expression(); this.expectP(']'); }
    if (this.eatP('(')) { args = this.isP(')') ? [] : this.exprList(); this.expectP(')'); }
    return { k: 'new', type, count, args, loc };
  }
  postfix(e) {
    for (;;) {
      const t = this.peek();
      if (t.k !== PUNCT) return e;
      const loc = t.loc;
      if (t.v === '(') { this.next(); const args = this.isP(')') ? [] : this.exprList(); this.expectP(')'); e = { k: 'call', fn: e, args, loc }; continue; }
      if (t.v === '[') { this.next(); const idx = this.expression(); this.expectP(']'); e = { k: 'index', obj: e, idx, loc }; continue; }
      if (t.v === '.' || t.v === '->') {
        this.next();
        e = { k: 'member', obj: e, arrow: t.v === '->', name: this.qualName(), loc };
        continue;
      }
      if (t.v === '++' || t.v === '--') { this.next(); e = { k: 'post', op: t.v, e, loc }; continue; }
      return e;
    }
  }
  primary() {
    const t = this.peek();
    const loc = t.loc;
    if (t.k === NUM) { this.next(); return { k: 'num', v: t.v, loc }; }
    if (t.k === CHR) { this.next(); return { k: 'chr', v: t.v, loc }; }
    if (t.k === STR) {
      const parts = [];
      while (this.peek().k === STR) parts.push(this.next().v);
      return { k: 'str', parts, loc };
    }
    if (t.k === PUNCT && t.v === '(') { this.next(); const e = this.expression(); this.expectP(')'); return { k: 'paren', e, loc }; }
    if (t.k === ID) {
      if (t.v === 'this') { this.next(); return { k: 'this', loc }; }
      if (t.v === 'true' || t.v === 'false') { this.next(); return { k: 'bool', v: t.v === 'true', loc }; }
      if (NAMED_CASTS.has(t.v)) {
        this.next(); this.expectP('<'); const type = this.typeId(); this.expectP('>');
        this.expectP('('); const e = this.expression(); this.expectP(')');
        return { k: 'cast', type, e, named: t.v, loc };
      }
      if (REFUSED.has(t.v)) this.fail(`C++ '${t.v}' is not supported`);
      // A functional cast or a temporary: `int(x)`, `T(a, b)`, `T()`.
      // In an expression `A(...)` is a temporary even inside A, where a declaration would read a constructor.
      if (BUILTIN.has(t.v) || this.startsType()) {
        const specs = this.declSpecifiers({ allowNone: false, inExpr: true });
        if (!this.isP('(')) this.fail('expected ( after a type in an expression');
        this.next();
        const args = this.isP(')') ? [] : this.exprList();
        this.expectP(')');
        return { k: 'fcast', type: { specs, derivs: [] }, args, loc };
      }
      if (t.v === '__builtin_offsetof') this.fail('offsetof in C++ is not supported');
      if (this.isIdent() || this.isP('::') || this.isP('~') || this.isKw('operator')) return { k: 'id', name: this.qualName(), loc };
    }
    if (t.k === PUNCT && t.v === '::') return { k: 'id', name: this.qualName(), loc };
    this.fail(`unexpected '${t.v || 'end of file'}' in an expression`);
  }
}
