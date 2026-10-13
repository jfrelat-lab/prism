// parse.js — C++ (the C++03 subset real game code of the late 1990s uses) into an unresolved tree.
//
// The tree is resolved and lowered to C by sema.js. This file decides only SHAPE, and the one thing
// shape cannot be decided without is whether a name is a TYPE: `T(x)` is a construction or a call,
// `A<B>` a template-id or two comparisons, `T * x;` a declaration or a product. So the parser keeps a
// small scope chain of what names a type -- classes, typedefs, enums, template parameters -- and
// nothing else; every other question is sema's.
//
// What is parsed (and what is refused, loudly, rather than half-read):
//   classes and structs with access specifiers, bases (single, multiple or virtual),
//   member functions inline or out of line, constructors with initialiser lists, destructors,
//   virtual functions, static members, friends, nested typedefs and enums, operator overloading
//   including conversion functions, references, default arguments, class templates with their
//   out-of-line members, new/delete (and their [] forms), `this`, C-style and functional casts,
//   `extern "C"` blocks, bool/true/false.
//   namespaces (nested, reopened, anonymous) with using-directives and using-declarations; function
//   templates; template parameters that are values, with defaults; explicit specialisations of class
//   templates; pointers to member functions and .* / ->*; dynamic_cast; declarations as conditions.
//   Not parsed: exceptions, typeid.

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
const REFUSED = new Set(['typeid']);
const NAMED_CASTS = new Set(['static_cast', 'const_cast', 'reinterpret_cast', 'dynamic_cast']);

// Binary operators by precedence, loosest first (assignment, ?: and comma are handled apart).
const BINARY = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'],
  ['+', '-'], ['*', '/', '%']];
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
// What may follow `operator` as an overloadable operator, longest first.
const OPERATORS = ['new[]', 'delete[]', '->*', '<<=', '>>=', '()', '[]', '->', '++', '--', '<<', '>>', '<=',
  '>=', '==', '!=', '&&', '||', '*=', '/=', '%=', '+=', '-=', '&=', '^=', '|=', '+', '-', '*', '/', '%',
  '^', '&', '|', '~', '!', '=', '<', '>', ',', 'new', 'delete'];

/**
 * A scope of what names are types to the PARSER. `inner` holds the scopes a class or a namespace
 * declared here opens, so that `A::B::c` can be followed; `usings` are the scopes a
 * using-directive (or a namespace's anonymous member) makes visible from here.
 */
class PScope {
  constructor(parent = null, cls = null) { this.parent = parent; this.names = new Map(); this.cls = cls; this.inner = new Map(); this.usings = []; }
  set(name, kind) { this.names.set(name, kind); }
  /** This scope's own entry for name (its using-directives included), or null. */
  own(name, field = 'names', seen = new Set()) {
    const k = this[field].get(name);
    if (k) return k;
    seen.add(this);
    for (const u of this.usings) {
      if (seen.has(u.scope)) continue;
      // A member function's body sees its class AND what encloses the class: a deep using.
      for (let s = u.scope; s; s = u.deep ? s.parent : null) { const r = s.own(name, field, seen); if (r) return r; }
    }
    return null;
  }
  find(name, field = 'names') { for (let s = this; s; s = s.parent) { const k = s.own(name, field); if (k) return k; } return null; }
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
    this.root = this.scope;
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
    const r = this.resolvePath(k);
    // `A::~A` and `A::operator=` go on past a type: they name a member of it, not it.
    return !!r && (r.kind === 'type' || r.kind === 'template') && !this.isP('::', r.end);
  }
  /**
   * The (possibly qualified) name starting at token k, followed through the scopes it names:
   * `Common::List<T>::iterator`. { kind, scope, end, names } -- kind of its last name ('type',
   * 'template', 'namespace' or null), the scope that name opens, the index past it, and the names --
   * or null when no name starts there. A name whose qualifier is not a class or namespace this
   * parser knows ends the path.
   */
  resolvePath(k = 0) {
    let j = k, sc = null;
    if (this.isP('::', j) && this.peek(j + 1).k === ID) { sc = this.root; j++; }
    const names = [];
    for (;;) {
      const t = this.peek(j);
      if (t.k !== ID || KEYWORDS.has(t.v)) return names.length ? null : null;
      names.push(t.v);
      const kind = sc ? sc.own(t.v) : this.scope.find(t.v);
      const inner = sc ? sc.own(t.v, 'inner') : this.scope.find(t.v, 'inner');
      j++;
      if ((kind === 'template' || kind === 'ftemplate') && this.isP('<', j)) j = this.skipAngles(j);
      if (inner && this.isP('::', j) && this.peek(j + 1).k === ID && !KEYWORDS.has(this.peek(j + 1).v)) { sc = inner; j++; continue; }
      return { kind, scope: inner, end: j, names };
    }
  }
  /** The scope a qualifier (all parts of a qualName but the last) names, or null. */
  scopeOfParts(parts, global = false) {
    let sc = global ? this.root : null;
    for (const p of parts) {
      const inner = sc ? sc.own(p.name, 'inner') : this.scope.find(p.name, 'inner');
      if (!inner) return null;
      sc = inner;
    }
    return sc;
  }
  /** Does a type specifier start here? (a declaration, a cast, a sizeof(type)) */
  startsType(k = 0) {
    const t = this.peek(k);
    if (t.k === PUNCT && t.v === '::') return this.isTypeName(k);
    if (t.k !== ID) return false;
    if (BUILTIN.has(t.v) || CV.has(t.v) || ['class', 'struct', 'union', 'enum', 'typename'].includes(t.v)) return true;
    // A qualified type: A::B where A is a class or a namespace and B a type inside it.
    return this.isTypeName(k);
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
    if (this.isKw('namespace')) return this.namespaceDecl();
    if (this.isKw('using')) return this.usingDecl();
    if (t.k === ID && REFUSED.has(t.v)) this.fail(`C++ '${t.v}' is not supported`);
    return this.declaration({ top: true });
  }

  /**
   * `namespace N { ... }`, reopened as often as a program likes (each opening adds to one scope);
   * `namespace { ... }`, whose names are its unit's alone and visible around it; `namespace A = B;`.
   */
  namespaceDecl() {
    const loc = this.loc();
    this.next();
    const name = this.isIdent() ? this.ident() : null;
    if (name && this.eatP('=')) {
      const target = this.qualName({ allowOperator: false });
      this.expectP(';');
      const sc = this.scopeOfParts(target.parts, target.global);
      if (sc) { this.scope.inner.set(name, sc); this.scope.set(name, 'namespace'); }
      return { k: 'nsalias', name, target, loc };
    }
    const key = name ?? '<anonymous>';
    let ns = this.scope.inner.get(key);
    if (!ns) {
      ns = new PScope(this.scope);
      this.scope.inner.set(key, ns);
      if (name) this.scope.set(name, 'namespace');
      else this.scope.usings.push({ scope: ns, deep: false });
    }
    this.expectP('{');
    const saved = this.scope;
    this.scope = ns;
    const items = [];
    try {
      while (!this.isP('}') && !this.done) { const it = this.topItem(); if (it) items.push(...[].concat(it)); }
    } finally { this.scope = saved; }
    this.expectP('}');
    return { k: 'namespace', name, items, loc };
  }
  /** `using namespace N;` or `using N::name;`, at file, namespace or block scope. */
  usingDecl() {
    const loc = this.loc();
    this.next();
    if (this.eatKw('namespace')) {
      const q = this.qualName({ allowOperator: false });
      this.expectP(';');
      const sc = this.scopeOfParts(q.parts, q.global);
      if (sc) this.scope.usings.push({ scope: sc, deep: false });
      return { k: 'usingns', qname: q, loc };
    }
    this.eatKw('typename');
    const q = this.qualName();
    this.expectP(';');
    // The name is declared here as what it is there: a type stays a type to the parser.
    const sc = this.scopeOfParts(q.parts.slice(0, -1), q.global);
    const last = q.parts[q.parts.length - 1].name;
    if (sc) {
      const kind = sc.own(last), inner = sc.own(last, 'inner');
      if (kind) this.scope.set(last, kind);
      if (inner) this.scope.inner.set(last, inner);
    }
    return { k: 'usingdecl', qname: q, loc };
  }

  // To the end of the line, found by `bol`: the '#' the preprocessor passes on has no location, so
  // comparing line numbers stopped at once and `#pragma mark -` left `mark -` to be parsed.
  skipPragma() {
    this.next();
    const words = [];
    while (!this.done && !this.peek().bol) words.push(this.next().v);
    /*
     * `#pragma pack` is acted on, as the C parser acts on it: it is struct layout. ScummVM 0.10.0
     * packs its file structures between common/pack-start.h and pack-end.h with `#pragma pack(1)`
     * and `#pragma pack()`. Each class records the value in force where it is defined, and the
     * lowering writes it around that class's struct -- the structs come out in another order.
     */
    const m = /^pragmapack\((.*)\)$/.exec(words.join(''));
    if (!m) return;
    const arg = m[1];
    this.packStack ??= [];
    const push = /^push(?:,(\d+))?$/.exec(arg);
    if (arg === '') this.pack = null;
    else if (arg === 'pop') this.pack = this.packStack.pop() ?? null;
    else if (push) { this.packStack.push(this.pack ?? null); if (push[1]) this.pack = +push[1] || null; }
    else if (/^\d+$/.test(arg)) this.pack = +arg || null;
    else this.fail(`#pragma pack(${arg}) is not understood`);
  }

  // ---------------------------------------------------------------- templates
  /**
   * `template<...>` and what it introduces. A parameter is { name, value, def }: a type (`class T`,
   * `typename T = X`) or a value of an integer type (`int bitFormat`); `template<>` (no parameters)
   * opens an explicit specialisation.
   */
  templateDecl(ctx = { top: true }) {
    this.next();
    this.expectP('<');
    const params = [];
    // The parameters' scope is open while they are read: a default may name the ones before it.
    const scope = new PScope(this.scope, this.scope.cls); // in a class, still that class: `template<class T> Instruments(T)` is its constructor
    scope.tparams = true;
    const outer = this.scope;
    this.scope = scope;
    try {
    while (!this.isP('>')) {
      if (this.eatKw('class') || this.eatKw('typename')) {
        const p = { name: this.ident(), value: false, def: null };
        scope.set(p.name, 'type');
        if (this.eatP('=')) p.def = this.typeId();
        params.push(p);
      } else {
        const specs = this.declSpecifiers({ allowNone: false, inExpr: true });
        if (specs.type?.k !== 'builtin') this.fail('a template parameter that is a value must be of an integer type');
        const p = { name: this.ident(), value: true, specs, def: null };
        if (this.eatP('=')) p.def = this.binary(7);
        params.push(p);
      }
      if (!this.eatP(',')) break;
    }
    } finally { this.scope = outer; }
    this.closeAngle();
    // A class template is a template inside its own body too: `~idList<type>()`.
    if ((this.isKw('class') || this.isKw('struct')) && this.isIdent(1) && (this.isP('{', 2) || this.isP(':', 2) || this.isP(';', 2))) this.scope.set(this.peek(1).v, 'template');
    const saved = this.scope;
    this.scope = scope;
    let decl;
    try { decl = this.declaration({ ...ctx, template: params }); } finally { this.scope = saved; }
    // The class template's name is a template to everyone after it; a function template's, a
    // function that may be called with arguments: `INTERPOLATE<bitFormat>(a, b)`.
    for (const d of [].concat(decl)) {
      if (d.k === 'class' && d.name && !d.specArgs) this.scope.set(d.name, 'template');
      const isFunc = d.decl && d.decl.derivs.length && d.decl.derivs[d.decl.derivs.length - 1].k === 'func';
      if (params.length && isFunc && d.decl.name?.parts.length === 1 && this.scope.names.get(d.decl.name.parts[0].name) !== 'template') this.scope.set(d.decl.name.parts[0].name, 'ftemplate');
      if (ctx.member && isFunc && d.decl.name?.parts.length === 1) (this.memberTemplates ??= new Set()).add(d.decl.name.parts[0].name);
    }
    return [].concat(decl).map((d) => ({ ...d, template: params }));
  }

  /**
   * `<args>` after a template name: each a type-id, or { expr } -- a value, read without the
   * relational operators, so that the '>' closing the list is not taken for one.
   */
  templateArgs() {
    this.expectP('<');
    const args = [];
    while (!this.isP('>') && !this.isP('>>')) {
      args.push(this.startsType() ? this.typeId() : { expr: this.binary(7) });
      if (!this.eatP(',')) break;
    }
    this.closeAngle();
    return args;
  }
  /** The '>' closing a template's list; `>>` closes two, so it leaves one behind. */
  closeAngle() {
    if (this.isP('>>')) { this.ts[this.i] = { ...this.ts[this.i], v: '>' }; return; }
    this.expectP('>');
  }

  // ---------------------------------------------------------------- names
  /**
   * A possibly qualified name: `x`, `A::x`, `A<T>::x`, `::x`, `~A`, `A::~A`, `operator+`,
   * `A::operator float *`. Each part is { name, targs }; a conversion function's part has `conv`.
   */
  qualName({ allowOperator = true, member = false } = {}) {
    const parts = [];
    const global = this.eatP('::');
    // The scope each part is looked up in: the one the part before it opened.
    let sc = global ? this.root : null;
    const kindOf = (n) => { const k = sc ? sc.own(n) : this.scope.find(n); return k === 'ftemplate' ? 'template' : k; };
    for (;;) {
      const part = {};
      if (this.eatP('~')) { part.name = `~${this.ident()}`; if (this.isP('<') && (kindOf(part.name.slice(1)) === 'template' || this.isTemplate(part.name.slice(1)))) this.templateArgs(); }
      else if (allowOperator && this.isKw('operator')) {
        this.next();
        const op = this.operatorName();
        if (typeof op === 'string') part.name = `operator${op}`;
        else { part.name = 'operator conv'; part.conv = op; }
      } else {
        part.name = this.ident();
        // After `.` or `->` the object's class is not known here: a member function template seen in
        // some class, then `<...>(`, is read as its arguments (`sc.pixel<2>(6)`).
        if (this.isP('<') && (kindOf(part.name) === 'template' || (member && this.memberTemplates?.has(part.name) && this.isP('(', this.skipAngles(0))))) part.targs = this.templateArgs();
      }
      parts.push(part);
      if (this.isP('::') && (this.peek(1).k === ID || this.isP('~', 1))) {
        this.next();
        sc = (sc ? sc.own(part.name, 'inner') : this.scope.find(part.name, 'inner')) ?? sc;
        continue;
      }
      break;
    }
    return { parts, global };
  }
  isTemplate(name) { const k = this.typeKind(name); return k === 'template' || k === 'ftemplate'; }

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
      if (STORAGE.has(v)) { this.next(); if (v === 'mutable') s.mutable = true; else if (v !== 'register' && v !== 'auto') s.storage = v; continue; }
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
    // A class template's constructor may be written with its arguments: `List<T>()`.
    if (cls && t.v === cls && this.isP('<', 1) && this.isTemplate(t.v) && this.isP('(', this.skipAngles(1))) return true;
    // Out of line: A::A( or A<T>::A( or N::A::A( -- the last two names equal, then a parameter list.
    const r = this.resolvePath(0);
    if (!r || r.names.length < 2 || !this.isP('(', r.end)) return false;
    return r.names[r.names.length - 1] === r.names[r.names.length - 2];
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
    while (this.isKw('__attribute__')) this.skipAttribute();
    let name = null, owner = null, ownerScope = null;
    // An elaborated name may be qualified: `friend class Common::Singleton<NewGui>;` -- and so may a
    // nested class defined outside its class: `struct ScummNESFile::Resource { ... };`.
    if ((this.isIdent() && this.isP('::', 1)) || this.isP('::')) {
      const q = this.qualName({ allowOperator: false });
      if (!this.isP('{') && !this.isP(':')) return { k: 'named', qname: q, elaborated: key };
      owner = { parts: q.parts.slice(0, -1), global: q.global };
      ownerScope = this.scopeOfParts(owner.parts, owner.global);
      if (!ownerScope) this.fail(`a class defined in ${owner.parts.map((p) => p.name).join('::')}, which is not a class`);
      name = q.parts[q.parts.length - 1].name;
    }
    if (!owner && this.isIdent()) name = this.ident();
    // A class named as a function already is (`struct stat` after `stat()`) is reached by its tag only.
    // `struct X x;` naming a class already known declares nothing: only a definition, a first mention, or
    // `class X;` alone, which declares X here even past an outer X (Queen's `class Graphics;`).
    const defines = this.isP('{') || this.isP(':') || (this.isP('<') && this.isTemplate(name));
    if (name && !owner && !this.isTemplate(name) && this.scope.names.get(name) !== 'func' && (defines || this.isP(';') || !this.scope.find(name))) this.scope.set(name, 'type');
    // An explicit specialisation names its arguments: `template<> struct ColorMasks<565> { ... }`.
    const specArgs = name && this.isP('<') && this.isTemplate(name) ? this.templateArgs() : null;
    if (!this.isP('{') && !this.isP(':')) {
      return { k: 'named', qname: { parts: [{ name }], global: false }, elaborated: key };
    }
    const bases = [];
    let baseScopes = null;
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
        const at = this.i;
        const r = this.resolvePath(0);
        bases.push({ qname: this.qualName({ allowOperator: false }), access, virt });
        // What the base declares is in scope in the derived class: its typedefs name types here too.
        if (r?.scope && this.i - at === r.end) (baseScopes ??= []).push(r.scope);
        if (!this.eatP(',')) break;
      }
    }
    this.expectP('{');
    const scope = new PScope(this.scope, name);
    for (const b of baseScopes ?? []) scope.usings.push({ scope: b, deep: false });
    // Defined outside its class, a nested class still sees that class's names.
    if (ownerScope) { scope.usings.push({ scope: ownerScope, deep: true }); ownerScope.inner.set(name, scope); }
    else if (name) {
      scope.set(name, this.typeKind(name) === 'template' ? 'template' : 'type');
      // Opened from the scope the class is declared in -- not from a template's parameter list.
      let home = this.scope;
      while (home.tparams && home.parent) home = home.parent;
      if (!specArgs || !home.inner.has(name)) home.inner.set(name, scope);
    }
    this.declareMemberTypesAhead(scope);
    const saved = this.scope;
    this.scope = scope;
    const members = [];
    let access = key === 'class' ? 'private' : 'public';
    try {
      while (!this.isP('}') && !this.done) {
        if (this.eatP(';')) continue;
        if (this.isP('#')) { this.skipPragma(); continue; }
        if ((this.isKw('public') || this.isKw('private') || this.isKw('protected')) && this.isP(':', 1)) {
          access = this.next().v; this.next(); continue;
        }
        // A member template: a class template inside the class, or a function template member.
        if (this.isKw('template')) { for (const m of this.templateDecl({ member: true, cls: name })) { m.access = access; members.push(m); } continue; }
        // The same object, not a copy: a member declared with a class defined in place points at that definition.
        for (const m of [].concat(this.declaration({ member: true, cls: name }))) { m.access = access; members.push(m); }
      }
    } finally { this.scope = saved; }
    this.expectP('}');
    return { k: 'class', key, name, bases, members, loc, cLinkage: this.cLinkage(this.ts[this.i - 1]), pack: this.pack ?? null, ...(owner ? { owner } : {}), ...(specArgs ? { specArgs } : {}) };
  }

  /**
   * A member function's body sees the whole class (9.2/2), the types declared below it too: FTGL's
   * FTList does `head = new Node;` in its constructor and declares `struct Node` at the end. The
   * parser has to know such a name is a type when it reaches it, so the class body is looked over
   * first, at its own level: the names of the classes, unions and enums it declares, and of its
   * typedefs, are entered as types before any member is parsed.
   */
  declareMemberTypesAhead(scope) {
    const ts = this.ts;
    let depth = 0, i = this.i, stmt = [];
    for (; i < ts.length; i++) {
      const t = ts[i];
      if (t.k === PUNCT && t.v === '{') { if (depth === 0 && stmt.length) this.typeNameIn(stmt, scope, true); depth++; continue; }
      if (t.k === PUNCT && t.v === '}') { if (depth === 0) break; depth--; if (depth === 0) stmt = []; continue; }
      if (depth > 0) continue;
      if (t.k === PUNCT && t.v === ';') { this.typeNameIn(stmt, scope, false); stmt = []; continue; }
      stmt.push(t);
    }
  }
  /** The type a member declaration's leading tokens name, if it names one: `struct Node`, `typedef ... X`. */
  typeNameIn(toks, scope, opening) {
    const first = toks.findIndex((t) => t.k === ID && !['public', 'private', 'protected', 'friend', 'static', 'mutable', 'virtual', 'inline'].includes(t.v));
    if (first < 0) return;
    const t0 = toks[first];
    if (['struct', 'class', 'union', 'enum'].includes(t0.v)) {
      const n = toks[first + 1];
      // A definition, a declaration on its own, or a base list: `struct Node {`, `class X;`, `struct Y : Z {`.
      if (n?.k === ID && (opening || toks.length === first + 2 || (toks[first + 2]?.k === PUNCT && toks[first + 2].v === ':'))) {
        if (!scope.names.has(n.v)) scope.set(n.v, 'type');
      }
      return;
    }
    if (t0.v === 'typedef' && !opening) {
      // The declarator's name. A pointer to function or member: the last identifier of the first
      // parenthesised group, `(*X)`, `(T::*X)`. A function type: the identifier before its '('.
      // Otherwise the last identifier before any '[' -- never a parameter's name.
      const open = toks.findIndex((t, k) => k > first && t.k === PUNCT && t.v === '(');
      let n = null;
      if (open >= 0) {
        let depth = 0, close = open;
        for (let k = open; k < toks.length; k++) {
          if (toks[k].k === PUNCT && toks[k].v === '(') depth++;
          else if (toks[k].k === PUNCT && toks[k].v === ')' && --depth === 0) { close = k; break; }
        }
        const group = toks.slice(open + 1, close);
        // A declarator group starts with * or &, or names a class first (`T::*`); a parameter list does not.
        const starts = group[0]?.k === PUNCT ? group[0].v === '*' || group[0].v === '&' : group[0]?.k === ID && group[1]?.v === '::';
        if (starts) n = [...group].reverse().find((t) => t.k === ID) ?? null;
        else if (toks[open - 1]?.k === ID) n = toks[open - 1];
      } else {
        const bracket = toks.findIndex((t, k) => k > first && t.k === PUNCT && t.v === '[');
        n = [...toks.slice(first + 1, bracket >= 0 ? bracket : toks.length)].reverse().find((t) => t.k === ID) ?? null;
      }
      if (n && !scope.names.has(n.v)) scope.set(n.v, 'type');
    }
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
      // `union { ... };` in a class: an anonymous member, whose members are the class's own.
      if (member && specs.type?.defined && !specs.type.defined.name) out.push({ k: 'decl', specs, decl: { name: null, derivs: [] }, loc, cLink });
      // A bare `class X;` declares the class, to be completed later; `friend class X;` nothing here.
      if (specs.type?.elaborated && !specs.friend) out.push({ k: 'fwdclass', name: specs.type.qname.parts[0].name, key: specs.type.elaborated, loc });
      return out;
    }
    for (;;) {
      const d = this.declarator();
      while (this.isKw('__attribute__')) this.skipAttribute();
      if (this.isKw('__asm__') || this.isKw('asm')) { this.next(); this.expectP('('); while (!this.eatP(')')) this.next(); }
      const isFunc = d.derivs.length && d.derivs[d.derivs.length - 1].k === 'func';
      // A constructor's member initialisers, then a body.
      if (isFunc && (this.isP('{') || this.isP(':'))) {
        // Hiding a type of its name, as a declaration does below -- before the body, which may call it.
        if (member && specs.storage !== 'typedef' && d.name?.parts.length === 1 && d.name.parts[0].name !== cls) this.scope.set(d.name.parts[0].name, 'func');
        out.push(this.functionDefinition(specs, d, { loc, cLink, cls, member }));
        return out;
      }
      const item = { k: specs.storage === 'typedef' ? 'typedef' : 'decl', specs, decl: d, loc, cLink };
      // A function hides a class of its name in its scope: `stat(path, &st)` is a call, not a cast. A
      // member function in its class too -- Cube's pool::string(s, l) beside `typedef char string[260]`
      // -- but not a constructor, whose name is the class's.
      if (isFunc && specs.storage !== 'typedef' && d.name?.parts.length === 1 && (!member || d.name.parts[0].name !== cls)) this.scope.set(d.name.parts[0].name, 'func');
      // So does a variable, in its scope: after Cube's `mitem &mitem = ...;`, `mitem.text` is the variable's.
      if (!isFunc && !member && specs.storage !== 'typedef' && d.name?.parts.length === 1) {
        const k = this.scope.find(d.name.parts[0].name);
        if (k === 'type' || k === 'template') this.scope.set(d.name.parts[0].name, 'var');
      }
      if (specs.storage === 'typedef' && d.name) {
        const tname = d.name.parts[d.name.parts.length - 1].name;
        this.scope.set(tname, 'type');
        // A typedef of a class opens its scope too: `typedef List<Plugin *> PluginList;` and then
        // `PluginList::iterator`.
        const named = specs.type?.k === 'named' && !d.derivs.length ? this.scopeOfParts(specs.type.qname.parts, specs.type.qname.global) : null;
        if (named) this.scope.inner.set(tname, named);
      }
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
    const ownerScope = owner ? this.scopeOfParts(q.slice(0, -1), d.name.global) : null;
    const saved = this.scope;
    if (ownerScope) {
      // The body sees the class (or namespace) the name is qualified by, and everything enclosing it.
      const sc = new PScope(this.scope, owner);
      sc.usings.push({ scope: ownerScope, deep: true });
      this.scope = sc;
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
      if (this.isMemberPointerAhead(0)) {
        // `Logic::*`: a pointer to a member of the class the qualified name names.
        const q = this.qualName({ allowOperator: false });
        this.expectP('::'); this.expectP('*');
        ptrs.push({ k: 'memptr', qname: q, cv: this.cvList() });
        continue;
      }
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
    const ownerScope = q && q.length > 1 ? this.scopeOfParts(q.slice(0, -1), name.global) : null;
    const savedScope = this.scope;
    if (ownerScope) { const sc = new PScope(this.scope, q[q.length - 2].name); sc.usings.push({ scope: ownerScope, deep: true }); this.scope = sc; }
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

  /** At k, `C::*` (or `N::C::*`): the start of a pointer to member. */
  isMemberPointerAhead(k) {
    if (!(this.isIdent(k) || this.isP('::', k))) return false;
    const r = this.resolvePath(k);
    return !!r && (r.kind === 'type' || r.kind === 'template') && this.isP('::', r.end) && this.isP('*', r.end + 1);
  }
  /** `(` opening a nested declarator (`(*fp)(int)`), not a parameter list. */
  parenIsDeclarator() {
    if (this.isMemberPointerAhead(1)) return true;
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
      if (t.v === '(') return this.isP('*', j + 1) || this.isP('&', j + 1) || this.isMemberPointerAhead(j + 1);
      return false;
    }
    return t.k === ID;
  }
  /** Index past the type specifier starting at k: cv words, builtin words or one qualified name. */
  skipTypeSpec(k) {
    let j = k, sawType = false;
    for (;;) {
      const t = this.peek(j);
      if (t.k === PUNCT && t.v === '::' && !sawType && this.isTypeName(j)) { j = this.resolvePath(j).end; sawType = true; continue; }
      if (t.k !== ID) return j;
      if (CV.has(t.v) || t.v === 'typename') { j++; continue; }
      if (BUILTIN.has(t.v)) { j++; sawType = true; continue; }
      if (['class', 'struct', 'union', 'enum'].includes(t.v)) { j += 2; sawType = true; continue; }
      if (sawType) return j;
      if (this.isTypeName(j)) { j = this.resolvePath(j).end; sawType = true; continue; }
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
    // A type named where no declaration can be: `A(` here is never A's constructor being declared.
    const specs = this.declSpecifiers({ allowNone: false, inExpr: true });
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
      while (!this.isP('}') && !this.done) { if (this.isP('#')) { this.skipPragma(); continue; } stmts.push(this.statement()); }
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
          this.next(); this.expectP('('); const c = this.condition(); this.expectP(')');
          const a = this.statement(); const b = this.eatKw('else') ? this.statement() : null;
          return { k: 'if', c, a, b, loc };
        }
        case 'while': { this.next(); this.expectP('('); const c = this.condition(); this.expectP(')'); return { k: 'while', c, body: this.statement(), loc }; }
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
            const c = this.isP(';') ? null : this.condition(); this.expectP(';');
            const step = this.isP(')') ? null : this.expression(); this.expectP(')');
            return { k: 'for', init, c, step, body: this.statement(), loc };
          } finally { this.scope = saved; }
        }
        case 'switch': { this.next(); this.expectP('('); const c = this.condition(); this.expectP(')'); return { k: 'switch', c, body: this.statement(), loc }; }
        case 'case': { this.next(); const e = this.conditional(); this.expectP(':'); return { k: 'case', e, loc }; }
        case 'default': if (this.isP(':', 1)) { this.next(); this.next(); return { k: 'default', loc }; } break;
        case 'break': this.next(); this.expectP(';'); return { k: 'break', loc };
        case 'continue': this.next(); this.expectP(';'); return { k: 'continue', loc };
        case 'return': { this.next(); const e = this.isP(';') ? null : this.expression(); this.expectP(';'); return { k: 'return', e, loc }; }
        case 'goto': { this.next(); const name = this.ident(); this.expectP(';'); return { k: 'goto', name, loc }; }
        case 'using': return { k: 'using', item: this.usingDecl(), loc };
        // try { ... } catch (T x) { ... } catch (...) { ... }  -- lowered in sema-stmt.js.
        case 'try': {
          this.next();
          const body = this.compound(), handlers = [];
          while (this.eatKw('catch')) {
            this.expectP('(');
            let param = null;
            if (!this.eatP('...')) { const specs = this.declSpecifiers({ allowNone: false }); param = { specs, decl: this.declarator({ abstract: true }) }; }
            this.expectP(')');
            handlers.push({ param, body: this.compound(), loc: this.loc() });
          }
          if (!handlers.length) this.fail('a try block with no handler');
          return { k: 'try', body, handlers, loc };
        }
        // GNU inline assembly, `__asm__ volatile ("tmpl" : "=r"(x) : "r"(y) : "cc");` -- kept for the C
        // front end, which reads it: the template and constraints as written, the operands as C++
        // expressions to lower. FreeType's ftconfig.h has one in a static inline function.
        case '__asm__': case '__asm': case 'asm': {
          this.next();
          const quals = [];
          while (this.peek().k === ID && /^_*(volatile|inline|goto)_*$/.test(this.peek().v)) quals.push(this.next().v);
          this.expectP('(');
          const template = [];
          while (this.peek().k === STR) template.push(this.next().v);
          const sections = [];
          while (this.eatP(':')) {
            const ops = [];
            sections.push(ops);
            if (this.isP(':') || this.isP(')')) continue;
            for (;;) {
              if (sections.length >= 3 || (this.peek().k === STR && !this.isP('(', 1))) ops.push({ clobber: this.next().v });
              else {
                const constraint = this.peek().k === STR ? this.next().v : '""';
                this.expectP('('); const e = this.expression(); this.expectP(')');
                ops.push({ constraint, e });
              }
              if (!this.eatP(',')) break;
            }
          }
          this.expectP(')'); this.expectP(';');
          return { k: 'asm', quals, template, sections, loc };
        }
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

  /** A condition: an expression, or a declaration with an initialiser -- `while (uint16 id = *list++)`. */
  condition() {
    if (!this.startsDeclaration()) return this.expression();
    const loc = this.loc();
    const specs = this.declSpecifiers();
    const decl = this.declarator();
    this.expectP('=');
    return { k: 'condDecl', specs, decl, init: this.assignment(), loc };
  }
  /** A declaration statement, as opposed to an expression that starts with a type's name. */
  startsDeclaration() {
    const t = this.peek();
    if (t.k === PUNCT && t.v === '::' && this.isTypeName()) { const j = this.resolvePath(0).end; return !this.isP('(', j) && !this.isP('.', j) && !this.isP('->', j); }
    if (t.k !== ID) return false;
    if (STORAGE.has(t.v) || (CV.has(t.v)) || t.v === 'class' || t.v === 'struct' || t.v === 'union' || t.v === 'enum') return true;
    if (BUILTIN.has(t.v)) return !this.isP('(', 1);      // `int(x)` is a cast
    if (!this.startsType()) return false;
    // `T(args).m()` and `T(args);` are expressions; `T x`, `T *x`, `T &x`, `T<U> x`, `A::B x` declare.
    const j = this.resolvePath(0).end;
    // `T (*p)[N]` and `T (&r)` declare: C++ settles that ambiguity for the declaration (6.8).
    if (this.isP('(', j) && (this.isP('*', j + 1) || this.isP('&', j + 1))) return true;
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
    // `throw e` and the bare `throw` that rethrows are assignment-expressions.
    if (this.isKw('throw')) {
      const loc = this.loc();
      this.next();
      const e = this.isP(';') || this.isP(')') || this.isP(',') || this.isP(':') || this.isP(']') ? null : this.assignment();
      return { k: 'throw', e, loc };
    }
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
    if (level === BINARY.length) return this.pmExpr();
    let a = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.k !== PUNCT || !BINARY[level].includes(t.v)) return a;
      this.next();
      a = { k: 'bin', op: t.v, a, b: this.binary(level + 1), loc: t.loc };
    }
  }
  /** `obj.*pm` and `ptr->*pm`, which bind tighter than * and looser than a cast. */
  pmExpr() {
    let a = this.unary();
    for (;;) {
      const loc = this.loc();
      if (this.isP('->*')) { this.next(); a = { k: 'pm', obj: a, arrow: true, mp: this.unary(), loc }; continue; }
      if ((this.isP('.') || this.isP('->')) && this.isP('*', 1)) {
        const arrow = this.next().v === '->';
        this.next();
        a = { k: 'pm', obj: a, arrow, mp: this.unary(), loc };
        continue;
      }
      return a;
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
    // An operand that is itself a unary expression: `**p`, `!*p`, `!--n`, `-sizeof x`.
    const t = this.peek();
    if ((t.k === PUNCT && ['++', '--', '-', '+', '!', '~', '*', '&'].includes(t.v)) || (t.k === ID && ['sizeof', 'new', 'delete'].includes(t.v))) return this.unary();
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
    let type, place = null;
    // `new (where) T(x)`, placement new: a parenthesised expression list followed by a type. Otherwise
    // the parentheses hold the type itself, `new (T)`.
    if (this.isP('(')) {
      const save = this.i;
      try {
        this.next();
        const where = this.exprList();
        this.expectP(')');
        const t = this.peek();
        if (t.k === ID && !this.isP('(')) place = where; else this.i = save;
      } catch { this.i = save; }
    }
    if (!place && this.isP('(')) { this.next(); type = this.typeId(); this.expectP(')'); }
    else {
      const specs = this.declSpecifiers({ allowNone: false, inExpr: true });
      const derivs = [];
      while (this.eatP('*')) derivs.push({ k: 'ptr', cv: this.cvList() });
      type = { specs, derivs };
    }
    let count = null, args = null;
    if (this.eatP('[')) {
      count = this.expression(); this.expectP(']');
      // `new Area[n][MAX_AREAS_NUMBER]`: the other dimensions are the element type's, constants.
      const dims = [];
      while (this.eatP('[')) { dims.push({ k: 'array', size: this.conditional() }); this.expectP(']'); }
      if (dims.length) type = { ...type, derivs: [...type.derivs, ...dims.reverse()] };
    }
    if (this.eatP('(')) { args = this.isP(')') ? [] : this.exprList(); this.expectP(')'); }
    return { k: 'new', type, count, args, place, loc };
  }
  postfix(e) {
    for (;;) {
      const t = this.peek();
      if (t.k !== PUNCT) return e;
      const loc = t.loc;
      if (t.v === '(') { this.next(); const args = this.isP(')') ? [] : this.exprList(); this.expectP(')'); e = { k: 'call', fn: e, args, loc }; continue; }
      if (t.v === '[') { this.next(); const idx = this.expression(); this.expectP(']'); e = { k: 'index', obj: e, idx, loc }; continue; }
      // `.*` and `->*` are not member accesses: binary() reads them, a level above.
      if ((t.v === '.' || t.v === '->') && this.isP('*', 1)) return e;
      if (t.v === '->*') return e;
      if (t.v === '.' || t.v === '->') {
        this.next();
        e = { k: 'member', obj: e, arrow: t.v === '->', name: this.qualName({ member: true }), loc };
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
