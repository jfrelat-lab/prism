// parser.js — C89 + the useful parts of C99 + the GNU extensions real code uses.
//
// Consumes the pp-token stream from src/cpp. Two things make a C parser awkward and both are handled
// with a scope-aware lookahead rather than a hack:
//
//   * `typedef-name` vs `identifier` is not decidable lexically. `(T)(x)` is a cast if T is a
//     typedef and a call if it is a variable. The scope chain is therefore consulted DURING parsing.
//   * a declarator reads inside-out (`int *a[3]` is an array of pointers, `int (*a)[3]` a pointer to
//     array), so declarators are parsed by wrapping the base type as the suffixes unwind.

import { ID, NUM, STR, CHR, PUNCT, EOF, tok } from '../cpp/token.js';
import * as T from '../sema/types.js';
import { charValue } from '../cpp/expr.js';
import { literalUnits } from '../util/charset.js';

export class ParseError extends Error {
  constructor(msg, tok) {
    super(tok?.loc ? `${tok.loc.file}:${tok.loc.line}: ${msg}` : msg);
    this.tok = tok;
  }
}

const KEYWORDS = new Set(['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'int', 'long', 'register',
  'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
  'unsigned', 'void', 'volatile', 'while',
  // C99 + GNU
  'inline', 'restrict', '_Bool', '__inline', '__inline__', '__const', '__const__', '__volatile',
  '__volatile__', '__restrict', '__restrict__', '__signed', '__signed__', '__attribute__',
  // gcc accepts the un-suffixed spelling too, and torture programs use it.
  '__attribute',
  '__extension__', '__typeof__', 'typeof', '__asm__', '__asm', 'asm', '__alignof__', '__alignof',
  '__builtin_offsetof', '__label__', '__complex__',
  '__real__', '__real', '__imag__', '__imag',
  /*
   * Watcom's memory-model and calling-convention keywords, which Raven's Heretic and Hexen use.
   *
   * Accepted and IGNORED, and that is correct here specifically because the target is the 32-bit
   * flat model those games were built for (DOS/4GW): with one segment, `__far` and `__near` describe
   * nothing. They are emphatically NOT no-ops in a 16-bit segmented program -- Wolfenstein 3D uses
   * `far` 451 times and means it -- which is why this is a parser allowance and not an ABI claim.
   *
   * `__interrupt` DOES change a calling convention: the compiler saves every register and returns
   * with IRET. Ignoring it is safe only while nothing installs such a function as a real handler,
   * which nothing here can: PRISM has no interrupt to deliver. If that ever changes, this line is
   * where the assumption was made.
   */
  '__far', '_far', '__near', '_near', '__interrupt', '_interrupt',
  '__cdecl', '_cdecl', '__pascal', '_pascal', '__loadds', '_loadds', '__saveregs', '_saveregs',
  '__export', '_export']);

const STORAGE = new Set(['typedef', 'extern', 'static', 'auto', 'register']);
const QUALS = new Set(['const', 'volatile', 'restrict', '__const', '__const__', '__volatile',
  '__volatile__', '__restrict', '__restrict__',
  // See the keyword list above: meaningless in a flat model, and only accepted for one.
  '__far', '_far', '__near', '_near', '__interrupt', '_interrupt',
  '__cdecl', '_cdecl', '__pascal', '_pascal', '__loadds', '_loadds', '__saveregs', '_saveregs',
  '__export', '_export']);
const FUNCSPEC = new Set(['inline', '__inline', '__inline__']);
const BARE_MODEL = new Set(['far', 'near']);
/** The subset of QUALS that Watcom also allows INSIDE a declarator; see #declarator. */
const WATCOM_QUALS = new Set(['__far', '_far', '__near', '_near', '__interrupt', '_interrupt',
  '__cdecl', '_cdecl', '__pascal', '_pascal', '__loadds', '_loadds', '__saveregs', '_saveregs',
  '__export', '_export']);

export class Parser {
  /** @param tokens pp-token stream (EOF-terminated) @param scope a T.Scope for the file scope */
  constructor(tokens, { scope = new T.Scope(), file = '<input>', pack = null } = {}) {
    this.ts = tokens.filter(t => t.k !== 'pm');
    this.i = 0;
    this.scope = scope;
    this.file = file;
    /*
     * #pragma pack state: the current maximum member alignment, and the stack push/pop use.
     *
     * `pack` seeds it for a whole build, which is a compiler OPTION and not a source change --
     * Watcom's /zp1, and Raven's makefiles pass it for Heretic and Hexen. Getting it wrong is not
     * subtle: every struct in the program changes size, so nothing read out of a WAD lands in the
     * right field.
     */
    this.pack = pack;
    this.aux = new Map();
    this.packStack = [];
  }

  // ---------------------------------------------------------------- token helpers

  peek(k = 0) { return this.ts[this.i + k] ?? this.ts[this.ts.length - 1]; }
  get done() { return this.peek().k === EOF; }
  next() { return this.ts[this.i++]; }
  isP(v, k = 0) { const t = this.peek(k); return t.k === PUNCT && t.v === v; }
  isKw(v, k = 0) { const t = this.peek(k); return t.k === ID && t.v === v; }
  eatP(v) { if (this.isP(v)) { this.i++; return true; } return false; }
  eatKw(v) { if (this.isKw(v)) { this.i++; return true; } return false; }
  expectP(v) {
    if (!this.eatP(v)) throw new ParseError(`expected '${v}' but found '${this.peek().v || 'end of file'}'`, this.peek());
  }
  expectId() {
    const t = this.peek();
    if (t.k !== ID || KEYWORDS.has(t.v)) throw new ParseError(`expected an identifier, found '${t.v}'`, t);
    this.i++;
    return t.v;
  }

  // ---------------------------------------------------------------- translation unit

  parseTranslationUnit() {
    const decls = [];
    while (!this.done) {
      if (this.eatP(';')) continue;                       // stray semicolon, GNU-tolerated
      if (this.eatKw('__extension__')) continue;
      if (this.isKw('asm') || this.isKw('__asm__') || this.isKw('__asm')) { decls.push(this.#topLevelAsm()); continue; }
      if (this.isP('#')) { this.#pragma(); continue; }
      decls.push(...this.#declarationOrFunction());
    }
    return { n: 'unit', decls, aux: [...this.aux.values()] };
  }

  /**
   * `#pragma ...`, which reaches the parser because the preprocessor passes pragmas through — as
   * gcc -E does, and for the same reason: a pragma is a message to the COMPILER, not to the
   * preprocessor.
   *
   * Only `pack` is acted on, and it has to be: it changes struct layout, which is the ABI, which is
   * the one thing that must match gcc exactly or a program reading its own data by offset gets
   * garbage. Everything else is skipped to the end of the line, which is what a compiler does with a
   * pragma it does not recognise.
   *
   *   #pragma pack(n)         members align to min(natural, n)
   *   #pragma pack()          back to the default
   *   #pragma pack(push)      save the current value
   *   #pragma pack(push, n)   save it and set n
   *   #pragma pack(pop)       restore
   */
  #pragma() {
    this.next();                                        // '#'
    /*
     * To the end of the LINE, and `bol` is the only reliable way to find it: the '#' the
     * preprocessor synthesises carries no source location at all, so comparing line numbers made
     * every token compare equal to `undefined` and the skip swallowed the next 64 tokens --
     * declarations included. The failure looked like a parse error three declarations later.
     */
    const words = [];
    while (!this.done && !this.peek().bol) words.push(this.next());
    /*
     * `#pragma aux NAME = "insn", "insn" ... parm [eax] [ebx] value [eax] modify exact [eax edx]`
     *
     * Two different things share this syntax. With an `=` and string literals it is the WHOLE
     * ROUTINE, written in assembly, and ignoring it leaves a declaration nothing defines. Without
     * one -- `#pragma aux mouse_handler parm [EAX] [EBX]` -- it only decorates a C function's
     * calling convention, and ignoring it is right.
     */
    if (words[0]?.v === 'pragma' && words[1]?.v === 'aux' && words[2]?.k === ID) {
      const aux = this.#auxPragma(words);
      if (aux) this.aux.set(aux.name, aux);
      return;
    }
    const text = words.map(t => t.v).join('');
    const m = /^pragma\s*pack\((.*)\)$/.exec(text.replace(/\s+/g, ''));
    if (!m) return;
    const arg = m[1];
    if (arg === '') { this.pack = null; return; }
    if (arg === 'pop') { this.pack = this.packStack.pop() ?? null; return; }
    if (arg === 'push') { this.packStack.push(this.pack); return; }
    const push = /^push,(.+)$/.exec(arg);
    if (push) { this.packStack.push(this.pack); this.pack = +push[1] || null; return; }
    if (/^\d+$/.test(arg)) this.pack = +arg || null;
  }

  /** Pull the routine out of an aux pragma's tokens, or null when it decorates rather than defines. */
  #auxPragma(words) {
    const name = words[2].v;
    let i = 3;
    if (words[i]?.v !== '=') return null;              // a convention, not a body
    i++;
    const insns = [];
    while (i < words.length && words[i].k === STR) {
      // A string token keeps its quotes; the instruction is what is between them.
      insns.push(String(words[i].v).replace(/^L?"|"$/g, ''));
      i++;
      if (words[i]?.v === ',') i++;
    }
    if (!insns.length) return null;
    const section = (kw) => {
      const at = words.findIndex((t, k) => k >= i && t.v === kw);
      if (at < 0) return null;
      const regs = [];
      for (let k = at + 1; k < words.length; k++) {
        const v = String(words[k].v).toLowerCase();
        if (v === 'exact' || v === '[' || v === ']') continue;
        if (/^e?(ax|bx|cx|dx|si|di|bp)$/.test(v)) { regs.push(v.length === 2 ? 'e' + v : v); continue; }
        if (['parm', 'value', 'modify', 'nomemory'].includes(v)) break;
      }
      return regs;
    };
    return { name, insns, parm: section('parm') ?? [], value: (section('value') ?? [])[0] ?? null };
  }

  /**
   * `asm [volatile|inline|goto] ( template [: outputs [: inputs [: clobbers]]] ) ;`
   *
   * The qualifiers are the reason 39 torture programs failed to PARSE: `asm volatile ("")` puts
   * `volatile` between the keyword and the paren. The operands are captured rather than skipped
   * because an asm with an EMPTY template does nothing at all — it is only a barrier — so one with
   * no outputs is faithfully a no-op that still evaluates its inputs.
   */
  #topLevelAsm() {
    this.next();
    while (this.peek().k === ID &&
           /^_*(volatile|inline|goto|const)_*$/.test(this.peek().v)) this.i++;
    this.#skipAttributeLike();
    this.expectP('(');

    const template = [];
    while (this.peek().k === STR) template.push(this.next().v);

    const outputs = [], inputs = [], clobbers = [];
    let section = 0;                                  // 0 outputs, 1 inputs, 2 clobbers
    while (this.eatP(':')) {
      const isClobber = section >= 2;
      const into = section === 0 ? outputs : section === 1 ? inputs : clobbers;
      section++;
      if (this.isP(':') || this.isP(')')) continue;
      for (;;) {
        // A clobber is a bare string with no `( expr )` after it. Testing the section counter AFTER
        // incrementing it made `asm ("" : : : "memory")` look for an operand and fail on the `)`.
        if (isClobber || (this.peek().k === STR && !this.isP('(', 1))) {
          // a clobber list entry: just a string
          into.push({ clobber: this.next().v });
        } else {
          if (this.eatP('[')) { this.expectId(); this.expectP(']'); }
          const constraint = this.peek().k === STR ? this.next().v : '';
          this.expectP('(');
          const expr = this.expression();
          this.expectP(')');
          into.push({ constraint, expr });
        }
        if (this.eatP(',')) continue;
        break;
      }
    }
    this.expectP(')');
    this.eatP(';');
    return { n: 'asm', template, outputs, inputs, clobbers };
  }

  /** A declaration, or a function definition if a `{` follows the first declarator. */
  #declarationOrFunction() {
    const specs = this.#declSpecifiers();
    const out = [];

    if (this.eatP(';')) {
      // A bare `struct S { ... };` or `enum E { ... };` declares only the tag.
      return [{ n: 'tagdecl', type: specs.type }];
    }

    for (;;) {
      this.lastAlias = null;
      const d = this.#declarator(specs.type);
      const datt = this.#skipAttributeLike();
      if (!datt.alias && this.lastAlias) datt.alias = this.lastAlias;
      if (datt.mode) d.type = applyMode(d.type, datt.mode, this.peek());
      if (datt.aligned) d.type = T.withAlign(d.type, datt.aligned);

      // K&R parameter declarations sit between the declarator and the body.
      const isKR = d.type.k === 'func' && d.type.oldStyle && !this.isP('{') && !this.isP(',')
        && !this.isP(';') && !this.isP('=');
      if (isKR || (d.type.k === 'func' && this.isP('{'))) {
        const fn = this.#functionBody(specs, d, isKR);
        out.push(fn);
        return out;
      }

      if (specs.storage === 'typedef' && hasVla(d.type)) {
        /*
         * `typedef int c[i+2];` -- a variably-modified typedef. Its sizeof is a RUN-TIME value, and
         * the constant folder answers with whatever the extent folded to, which is a wrong number
         * rather than a refusal (20040411-1.c, 20040423-1.c).
         */
        throw new ParseError('a variably-modified typedef', this.peek());
      }
      if (specs.storage === 'typedef') {
        this.scope.declare(d.name, { kind: 'typedef', type: d.type });
        out.push({ n: 'typedef', name: d.name, type: d.type });
      } else {
        let init = null;
        if (this.eatP('=')) init = this.#initializer(d.type);
        // `int a[] = {…};` completes the array from its initialiser. Two traps: a designated
        // initialiser can reach past the item count (`{5, [2]=2, 3}` has 3 items and 4 elements),
        // and a string literal sizes the array by its bytes plus the NUL.
        let type = d.type;
        if (type.k === 'array' && type.n === null && init) {
          if (init.n === 'initlist') type = T.array(type.of, initListExtent(init, type.of));
          else if (init.expr?.n === 'str') {
            // Sized in ELEMENTS, so a wide literal in a wchar_t[] gets the same count as its
            // characters rather than four times as many.
            let len = 0;
            for (const part of init.expr.parts) len += stringLiteralLength(part.v);
            type = T.array(type.of, len + 1);
          }
        }
        this.scope.declare(d.name, { kind: type.k === 'func' ? 'func' : 'var', type });
        out.push({ n: 'vardecl', name: d.name, type, storage: specs.storage, init, alias: datt.alias });
      }
      if (this.eatP(',')) continue;
      this.expectP(';');
      return out;
    }
  }

  #functionBody(specs, d, isKR) {
    // K&R: `int f(a, b) int a; char b; { ... }` — the parameter types follow the declarator.
    if (isKR) {
      const byName = new Map();
      while (!this.isP('{') && !this.done) {
        const s = this.#declSpecifiers();
        for (;;) {
          const p = this.#declarator(s.type);
          byName.set(p.name, p.type);
          if (this.eatP(',')) continue;
          this.expectP(';');
          break;
        }
      }
      d.type = T.func(d.type.ret,
        d.type.params.map(p => ({ name: p.name, type: byName.get(p.name) ?? T.INT })),
        { variadic: false, oldStyle: true });
    }

    this.scope.declare(d.name, { kind: 'func', type: d.type });
    const inner = new T.Scope(this.scope);
    for (const p of d.type.params) if (p.name) inner.declare(p.name, { kind: 'var', type: p.type });
    const saved = this.scope;
    this.scope = inner;
    let body;
    try { body = this.#compound(); } finally { this.scope = saved; }
    return { n: 'func', name: d.name, type: d.type, storage: specs.storage, body };
  }

  // ---------------------------------------------------------------- declaration specifiers

  /**
   * Collect specifiers in any order — `unsigned long int`, `long unsigned`, `static const int` are
   * all legal and mean the same thing. Counting rather than pattern-matching is what makes that work.
   */
  #declSpecifiers({ allowNone = false } = {}) {
    let storage = null, type = null, sawTypeSpec = false;
    let signed = 0, unsigned = 0, longs = 0, shorts = 0;
    let base = null;                                  // 'int' | 'char' | 'double' | 'float' | 'void' | '_Bool'
    const cv = {};
    let inlineFn = false;
    let alignAttr = 0;
    let isComplex = false;
    let modeAttr = null;

    for (;;) {
      const t = this.peek();
      if (t.k !== ID) break;
      const v = t.v;

      if (STORAGE.has(v)) { this.i++; storage = v === 'typedef' ? 'typedef' : v; continue; }
      if (QUALS.has(v)) { this.i++; cv[v.replace(/^__|__$/g, '')] = true; continue; }
      if (FUNCSPEC.has(v)) { this.i++; inlineFn = true; continue; }
      if (v === '__extension__') { this.i++; continue; }
      /*
       * GCC's thread-local storage class. PRISM's target has exactly one thread, and the meaning of
       * `__thread` on a single-threaded program is "an ordinary static object" -- so accepting and
       * ignoring it is the correct translation here, not a workaround. PuTTY's shinydialogbox.c
       * declares its one piece of dialogue state this way.
       */
      if (v === '__thread' || v === '_Thread_local') { this.i++; continue; }
      if (v === '__attribute__' || v === '__attribute') { const a = this.#skipAttributeLike(); if (a.aligned) alignAttr = Math.max(alignAttr, a.aligned); if (a.mode) modeAttr = a.mode; continue; }

      if (v === 'signed' || v === '__signed' || v === '__signed__') { this.i++; signed++; sawTypeSpec = true; continue; }
      if (v === 'unsigned') { this.i++; unsigned++; sawTypeSpec = true; continue; }
      if (v === 'long') { this.i++; longs++; sawTypeSpec = true; continue; }
      if (v === 'short') { this.i++; shorts++; sawTypeSpec = true; continue; }
      // `_Complex` is a specifier that MODIFIES the arithmetic type beside it, in any order:
      // `float _Complex`, `_Complex double`, and bare `_Complex` (which gcc reads as double).
      if (isComplexSpelling(v)) { this.i++; isComplex = true; sawTypeSpec = true; continue; }
      if (v === 'int' || v === 'char' || v === 'double' || v === 'float' || v === 'void' || v === '_Bool') {
        this.i++; base = v; sawTypeSpec = true; continue;
      }
      if (v === 'struct' || v === 'union') { type = this.#recordSpecifier(v); sawTypeSpec = true; continue; }
      if (v === 'enum') { type = this.#enumSpecifier(); sawTypeSpec = true; continue; }
      if (v === 'typeof' || v === '__typeof__') { type = this.#typeofSpecifier(); sawTypeSpec = true; continue; }

      // A typedef name is a type specifier only if no other type specifier has been seen —
      // otherwise `typedef int T; ... unsigned T;` would misparse, and more importantly
      // `T x;` vs `int T;` are told apart by exactly this test.
      if (!sawTypeSpec && this.scope.isTypedef(v)) {
        this.i++;
        type = this.scope.lookup(v).type;
        sawTypeSpec = true;
        continue;
      }
      break;
    }

    if (!type) {
      type = this.#buildArithmetic({ base: base ?? (isComplex ? 'double' : base), signed, unsigned, longs, shorts },
        sawTypeSpec, allowNone);
    }
    if (modeAttr) type = applyMode(type ?? T.INT, modeAttr, this.peek());
    if (isComplex) {
      if (!type || !T.isArith(type)) throw new ParseError('_Complex needs an arithmetic type', this.peek());
      type = T.complex(type);
    }
    if (alignAttr) type = T.withAlign(type, alignAttr);
    return { storage, type: T.qualify(type, Object.keys(cv).length ? cv : null), inline: inlineFn, sawTypeSpec };
  }

  #buildArithmetic({ base, signed, unsigned, longs, shorts }, sawTypeSpec, allowNone) {
    if (!sawTypeSpec) {
      // Implicit int — legal C89 (`static x;`, `f() { }`), and real DOS-era code uses it.
      if (allowNone) return null;
      return T.INT;
    }
    if (base === 'void') return T.VOID;
    if (base === '_Bool') return T.scalar('_Bool');
    if (base === 'float') return T.scalar('float');
    if (base === 'double') return T.scalar(longs ? 'long double' : 'double');
    if (base === 'char') return T.scalar(unsigned ? 'unsigned char' : signed ? 'signed char' : 'char');
    if (shorts) return T.scalar(unsigned ? 'unsigned short' : 'short');
    if (longs >= 2) return T.scalar(unsigned ? 'unsigned long long' : 'long long');
    if (longs === 1) return T.scalar(unsigned ? 'unsigned long' : 'long');
    return T.scalar(unsigned ? 'unsigned int' : 'int');
  }

  #typeofSpecifier() {
    this.next();
    this.expectP('(');
    if (this.#looksLikeTypeName()) {
      const t = this.#typeName();
      this.expectP(')');
      return t;
    }
    const e = this.expression();
    this.expectP(')');
    return e.type ?? T.INT;
  }

  #recordSpecifier(kind) {
    this.next();
    this.#skipAttributeLike();
    let tag = null;
    if (this.peek().k === ID && !KEYWORDS.has(this.peek().v)) tag = this.expectId();

    if (!this.isP('{')) {
      // A reference. An existing tag anywhere up the chain wins; otherwise it is incomplete.
      if (!tag) throw new ParseError(`${kind} with neither tag nor body`, this.peek());
      const found = this.scope.lookupTag(tag);
      if (found) return found;
      return this.scope.declareTag(tag, T.incompleteRecord(kind, tag));
    }

    // A definition. Declare the (incomplete) tag FIRST so a member can point at it:
    //   struct node { struct node *next; };
    //
    // And if the tag is ALREADY present in this scope as an incomplete record, complete THAT object
    // instead of making a new one. Making a new one is how `struct MachineDriver` stayed incomplete
    // in MAME: driver.h includes machine.h, machine.h declares `struct MachineDriver *drv` — taking
    // a reference to the placeholder — and driver.h then defines the body further down. Replacing
    // the tag left every earlier reference pointing at an object that was never filled in. Any pair
    // of mutually-referential headers hits this.
    const existing = tag ? this.scope.localTag(tag) : null;
    const placeholder = (existing && existing.k === kind && !existing.complete)
      ? existing
      : T.incompleteRecord(kind, tag);
    if (tag) this.scope.declareTag(tag, placeholder);

    this.expectP('{');
    const members = [];
    while (!this.isP('}') && !this.done) {
      if (this.eatP(';')) continue;
      const s = this.#declSpecifiers();
      // `struct { struct S; };` — an anonymous member (GNU) or just a tag declaration.
      if (this.eatP(';')) {
        if (T.isRecord(s.type) && !s.type.tag) members.push({ name: null, type: s.type, anon: true });
        continue;
      }
      for (;;) {
        let name = null, mtype = s.type, bits;
        if (this.isP(':')) {
          this.i++;
          bits = Number(this.#constExpr());
        } else {
          const d = this.#declarator(s.type);
          name = d.name; mtype = d.type;
          /*
           * A VARIABLY-MODIFIED member -- `struct { char x[size]; }` -- makes the whole struct's
           * size a run-time value, and every sizeof, every assignment and every va_arg of it with
           * it. Refused, loudly: accepting the declarator and laying the struct out with a null
           * extent produced five plausible WRONG ANSWERS in gcc's suite where there had been five
           * refusals, which is the wrong direction to move.
           */
          if (hasVla(mtype)) {
            throw new ParseError('a variably-modified type as a struct member', this.peek());
          }
          if (this.eatP(':')) bits = Number(this.#constExpr());
        }
        const matt = this.#skipAttributeLike();
        if (matt.mode) mtype = applyMode(mtype, matt.mode, this.peek());
        // Order matters and is observable: `packed` drops the member's alignment to 1, and a
        // following `aligned(N)` raises it to N. Applying only `aligned` put
        // `double d __attribute__((aligned(2),packed))` at offset 4 instead of 2.
        if (matt.packed) mtype = T.withExactAlign(mtype, 1);
        if (matt.aligned) mtype = T.withExactAlign(mtype, matt.aligned);
        members.push(bits === undefined ? { name, type: mtype } : { name, type: mtype, bits });
        if (this.eatP(',')) continue;
        this.expectP(';');
        break;
      }
    }
    this.expectP('}');
    const tail = this.#skipAttributeLike();

    // `#pragma pack(n)` in force clamps every member to n; pack(1) is then exactly __packed__.
    let built = T.record(kind, tag, members,
      { packed: tail.packed, maxAlign: this.pack ?? null });
    if (tail.aligned) built = T.withAlign(built, tail.aligned);
    if (tag) {
      // Mutate the placeholder in place: anything that already captured it (a self-referential
      // member) must see the completed type, and re-declaring the tag would not reach those.
      Object.assign(placeholder, built);
      return placeholder;
    }
    return built;
  }

  #enumSpecifier() {
    this.next();
    this.#skipAttributeLike();
    let tag = null;
    if (this.peek().k === ID && !KEYWORDS.has(this.peek().v)) tag = this.expectId();
    if (!this.isP('{')) {
      if (!tag) throw new ParseError('enum with neither tag nor body', this.peek());
      const found = this.scope.lookupTag(tag);
      if (found) return found;
      return this.scope.declareTag(tag, T.enumType(tag, []));
    }
    this.expectP('{');
    const consts = [];
    let nextVal = 0n;
    while (!this.isP('}') && !this.done) {
      const name = this.expectId();
      this.#skipAttributeLike();
      if (this.eatP('=')) nextVal = this.#constExpr();
      consts.push({ name, value: nextVal });
      // An enum constant is an ordinary identifier, visible immediately — the next initializer
      // may refer to it (`enum { A = 1, B = A + 1 }`).
      this.scope.declare(name, { kind: 'enumconst', type: T.INT, value: nextVal });
      nextVal = nextVal + 1n;
      if (!this.eatP(',')) break;
    }
    this.expectP('}');
    this.#skipAttributeLike();
    const t = T.enumType(tag, consts);
    if (tag) this.scope.declareTag(tag, t);
    return t;
  }

  /** `__attribute__((...))` and `__asm__("...")` in a declaration; returns what we care about. */
  #skipAttributeLike() {
    const found = { packed: false, aligned: null, alias: null, mode: null };
    for (;;) {
      if (this.isKw('__attribute__') || this.isKw('__attribute')) {
        this.i++;
        this.expectP('('); this.expectP('(');
        let depth = 2;
        const inner = [];
        while (depth > 0 && !this.done) {
          if (this.isP('(')) depth++;
          else if (this.isP(')')) { depth--; if (!depth) { this.i++; break; } }
          inner.push(this.next());
        }
        for (let k = 0; k < inner.length; k++) {
          const t = inner[k];
          if (t.k === ID && /^_*packed_*$/.test(t.v)) { found.packed = true; continue; }
          // Most attributes are safe to ignore (noinline, unused, format…). These are NOT: they
          // change the TYPE, so ignoring them produces a wrong program instead of a refusal —
          // gcc's simd-*.c miscompiled silently until this list existed.
          /*
           * `__attribute__((mode(SI)))` names a machine MODE, which selects the width: the type it
           * is written on contributes only its signedness. `typedef unsigned int u8
           * __attribute__((mode(QI)))` is an unsigned 8-bit integer, not an int.
           */
          if (t.k === ID && /^_*mode_*$/.test(t.v) && inner[k + 1]?.v === '(' && inner[k + 2]?.k === ID) {
            found.mode = inner[k + 2].v.replace(/^__|__$/g, '');
            k += 3;
            continue;
          }
          if (t.k === ID && /^_*(vector_size|transparent_union|vector)_*$/.test(t.v)) {
            throw new ParseError(`__attribute__((${t.v})) changes the type and is not supported`, t);
          }
          /*
           * `__attribute__((alias("a")))` makes this name a SECOND name for an existing object --
           * one address, two spellings. It is a linker fact, so only the name is kept here.
           */
          if (t.k === ID && /^_*alias_*$/.test(t.v) && inner[k + 1]?.v === '(' && inner[k + 2]?.k === STR) {
            found.alias = String.fromCharCode(...literalUnits(inner[k + 2].v));
            k += 3;
            continue;
          }
          if (t.k === ID && /^_*aligned_*$/.test(t.v)) {
            // `aligned` with no argument means "the target's maximum"; with one it is a constant
            // EXPRESSION, and the torture suite writes `aligned(alignment)` behind a macro.
            if (inner[k + 1]?.k === PUNCT && inner[k + 1].v === '(') {
              let depth = 1, j = k + 2;
              const arg = [];
              while (j < inner.length && depth > 0) {
                if (inner[j].k === PUNCT && inner[j].v === '(') depth++;
                else if (inner[j].k === PUNCT && inner[j].v === ')') { depth--; if (!depth) break; }
                arg.push(inner[j]); j++;
              }
              try {
                const sub = new Parser([...arg, tok(EOF, '')], { scope: this.scope });
                found.aligned = Number(sub.constExpr());
              } catch { /* an alignment we cannot fold is better ignored than guessed */ }
              k = j;
            } else {
              found.aligned = 16;
            }
            continue;
          }
        }
        continue;
      }
      if ((this.isKw('__asm__') || this.isKw('__asm') || this.isKw('asm')) && this.isP('(', 1)) {
        this.i++;
        let depth = 0;
        do {
          if (this.isP('(')) depth++;
          else if (this.isP(')')) depth--;
          this.i++;
        } while (depth > 0 && !this.done);
        continue;
      }
      return found;
    }
  }

  // ---------------------------------------------------------------- declarators

  /** Parse a declarator, wrapping `base` as the suffixes unwind. Abstract declarators allowed. */
  #declarator(base, { abstract = false } = {}) {
    /*
     * Watcom puts its memory-model and convention keywords BEFORE the star, inside the declarator:
     *
     *     void (__interrupt __far *oldkeyboardisr)();      // Heretic, I_IBM.C:1282
     *
     * Standard C has no place for a qualifier there -- `const` after the star qualifies the pointer,
     * and nothing goes in front of it. Skipped rather than modelled, for the reason the keyword list
     * gives: in the flat model these games target, they describe nothing.
     */
    while (this.peek().k === ID
      && (WATCOM_QUALS.has(this.peek().v) || this.#bareModelKeyword())) this.i++;

    // Pointers bind tightest to the left, so they wrap the base first.
    while (this.isP('*')) {
      this.i++;
      const cv = {};
      while (this.peek().k === ID && QUALS.has(this.peek().v)) {
        cv[this.next().v.replace(/^__|__$/g, '')] = true;
      }
      this.#skipAttributeLike();
      base = T.qualify(T.ptr(base), Object.keys(cv).length ? cv : null);
    }

    // `int (*fp)(void)` — a parenthesized declarator is parsed against a placeholder and the real
    // base is threaded in afterwards, which is what makes inside-out reading work.
    if (this.isP('(') && !this.#parenIsParamList()) {
      this.i++;
      const hole = { k: 'hole' };
      const innerD = this.#declarator(hole, { abstract });
      this.expectP(')');
      const outer = this.#declaratorSuffix(base);
      substHole(innerD.type, hole, outer);
      return { name: innerD.name, type: innerD.type === hole ? outer : innerD.type };
    }

    let name = null;
    if (!abstract || (this.peek().k === ID && !KEYWORDS.has(this.peek().v))) {
      if (this.peek().k === ID && !KEYWORDS.has(this.peek().v)) name = this.expectId();
      else if (!abstract) throw new ParseError(`expected a declarator, found '${this.peek().v}'`, this.peek());
    }
    return { name, type: this.#declaratorSuffix(base) };
  }

  /** `[...]` and `(...)` suffixes. Applied left to right but wrap outside-in. */
  #declaratorSuffix(base) {
    const suffixes = [];
    for (;;) {
      if (this.isP('[')) {
        this.i++;
        // GNU/C99 allow qualifiers and `static` inside an array parameter's brackets.
        while (this.peek().k === ID && (QUALS.has(this.peek().v) || this.peek().v === 'static')) this.i++;
        /*
         * A VARIABLE-LENGTH ARRAY is an array whose extent is an expression: `double x[n]`. The
         * constant folder is asked first because almost every array is constant and the constant is
         * what the type system wants; only when it refuses is the same text re-read as an ordinary
         * expression, which is why the cursor is saved rather than the folder made lenient.
         */
        let n = null, vla = null;
        if (!this.isP(']')) {
          const save = this.i;
          try { n = Number(this.#constExpr()); }
          catch { this.i = save; vla = this.assignment(); }
        }
        this.expectP(']');
        suffixes.push({ kind: 'array', n, vla });
        continue;
      }
      if (this.isP('(')) {
        this.i++;
        suffixes.push(this.#paramList());
        this.expectP(')');
        // An attribute right after the parameter list belongs to the DECLARATION, and `alias` is
        // the one that must survive: `int f(int) __attribute__((alias("g")));` puts it here, where
        // it was being skipped along with the noinlines and the unuseds.
        const post = this.#skipAttributeLike();
        if (post.alias) this.lastAlias = post.alias;
        continue;
      }
      break;
    }
    // Wrap from the innermost suffix outward: `int a[2][3]` is array-2 of array-3 of int.
    let t = base;
    for (let k = suffixes.length - 1; k >= 0; k--) {
      const s = suffixes[k];
      if (s.kind === 'array') {
        t = T.array(t, s.n);
        if (s.vla) t = { ...t, vla: s.vla };
      } else {
        t = T.func(t, s.params, { variadic: s.variadic, oldStyle: s.oldStyle });
      }
    }
    return t;
  }

  #paramList() {
    if (this.isP(')')) return { kind: 'func', params: [], variadic: false, oldStyle: true };
    if (this.isKw('void') && this.isP(')', 1)) { this.i++; return { kind: 'func', params: [], variadic: false, oldStyle: false }; }

    // An identifier list with no types is a K&R declarator: `int f(a, b)`.
    if (this.peek().k === ID && !KEYWORDS.has(this.peek().v) && !this.scope.isTypedef(this.peek().v)
        && (this.isP(',', 1) || this.isP(')', 1))) {
      const params = [];
      for (;;) {
        params.push({ name: this.expectId(), type: T.INT });
        if (this.eatP(',')) continue;
        break;
      }
      return { kind: 'func', params, variadic: false, oldStyle: true };
    }

    const params = [];
    let variadic = false;
    for (;;) {
      if (this.isP('...')) { this.i++; variadic = true; break; }
      const s = this.#declSpecifiers();
      const d = this.#declarator(s.type, { abstract: true });
      /*
       * A VLA PARAMETER decays to a pointer, so its type carries nothing -- but its extent is still
       * an expression that gcc evaluates: `void foo(int a, int b[a++])` leaves a at 2. Dropping it
       * silently turned pr77767.c from a refusal into a wrong answer, so it is refused until the
       * evaluation is real.
       */
      if (hasVla(d.type)) {
        throw new ParseError('a variable-length array parameter', this.peek());
      }
      /*
       * `int main(int argc __attribute__((unused)), char **argv __attribute__((unused)))`. An
       * attribute may follow a PARAMETER's declarator as well as a declaration's, and nothing here
       * looked for one -- so a perfectly ordinary main() stopped the parse at the attribute.
       */
      while (this.isKw('__attribute__') || this.isKw('__attribute')) this.#skipAttributeLike();
      // A parameter of array or function type decays immediately, and that is observable through
      // sizeof inside the function body.
      params.push({ name: d.name, type: T.decay(d.type) });
      if (this.eatP(',')) continue;
      break;
    }
    return { kind: 'func', params, variadic, oldStyle: false };
  }

  /** Does the `(` at the cursor open a parameter list rather than a nested declarator? */
  /*
   * Bare `far` / `near`, which Watcom also accepts and Heretic writes once: `int (far *function)();`
   *
   * NOT added to the keyword list, and the restraint is the point: `far` and `near` are perfectly
   * ordinary identifiers, and making them keywords everywhere would break any program with a
   * variable of that name -- for a construct that appears once in 47,000 lines. Recognised only
   * where nothing else can be meant: inside a declarator, immediately before a star.
   */
  #bareModelKeyword() {
    if (!BARE_MODEL.has(this.peek().v)) return false;
    if (this.isP('*', 1)) return true;                       // `int (far *function)();`
    /*
     * `void _loadds far mouse_handler(...)` -- OpenDUNE's DOS mouse callback. Same restraint: a
     * declarator is being parsed, so a bare `far` followed by a plain identifier can only be the
     * memory model. An identifier that IS a typedef is left alone, because `far x;` would then be a
     * declaration of x with type far.
     */
    const next = this.peek(1);
    return next.k === ID && !KEYWORDS.has(next.v) && !this.scope.isTypedef(next.v);
  }

  #parenIsParamList() {
    if (this.isP(')', 1)) return true;                       // `f()`
    if (this.isP('...', 1)) return true;
    const t = this.peek(1);
    if (t.k !== ID) return false;
    /*
     * A Watcom convention keyword after '(' does NOT start a parameter list -- it decorates the
     * declarator inside it, as in `void (__interrupt __far *isr)()`. Without this the paren was read
     * as a parameter list because these are keywords now, and the declaration failed to parse at the
     * '(' rather than at anything meaningful.
     */
    if (WATCOM_QUALS.has(t.v)) return false;
    if (BARE_MODEL.has(t.v) && this.isP('*', 2)) return false;   // `(far *fp)()`
    if (KEYWORDS.has(t.v)) return true;                      // a type specifier starts a param list
    return this.scope.isTypedef(t.v);
  }

  /** A type-name: specifiers plus an abstract declarator. Used by casts, sizeof, offsetof. */
  #typeName() {
    const s = this.#declSpecifiers();
    const d = this.#declarator(s.type, { abstract: true });
    return d.type;
  }

  #looksLikeTypeName() {
    const t = this.peek();
    if (t.k !== ID) return false;
    if (STORAGE.has(t.v) || QUALS.has(t.v) || FUNCSPEC.has(t.v)) return true;
    if (TYPE_STARTERS.includes(t.v) || isComplexSpelling(t.v)) return true;
    return this.scope.isTypedef(t.v);
  }

  // ---------------------------------------------------------------- initializers

  #initializer(type) {
    if (!this.isP('{')) return { n: 'init', expr: this.assignment() };
    this.i++;
    const items = [];
    while (!this.isP('}') && !this.done) {
      /*
       * The pre-C99 GNU spelling: `{ b: 0, a: 0 }` instead of `{ .b = 0, .a = 0 }`. gcc still
       * accepts it and its own compndlit-1.c and struct-ini-4.c are written that way. Recognised by
       * lookahead so an ordinary identifier expression is untouched: only `name :` at the start of
       * an initialiser item can be one, and a `?:` cannot appear there without parentheses.
       */
      let designators = null;
      if (this.peek().k === ID && this.isP(':', 1) && !this.scope.isTypedef(this.peek().v)) {
        designators = [{ field: this.next().v }];
        this.expectP(':');
        items.push({ designators, value: this.#initializer(type) });
        if (this.eatP(',')) continue;
        break;
      }
      // C99 designated initializers, plus the obsolete GNU `field:` form.
      while (this.isP('.') || this.isP('[')) {
        designators ??= [];
        if (this.eatP('.')) designators.push({ field: this.expectId() });
        else { this.expectP('['); designators.push({ index: Number(this.#constExpr()) }); this.expectP(']'); }
      }
      if (designators) this.expectP('=');
      items.push({ designators, value: this.#initializer(type) });
      if (!this.eatP(',')) break;
    }
    this.expectP('}');
    return { n: 'initlist', items };
  }

  // ---------------------------------------------------------------- statements

  #compound() {
    this.expectP('{');
    const saved = this.scope;
    this.scope = new T.Scope(saved);
    const items = [];
    try {
      while (!this.isP('}') && !this.done) {
        if (this.eatKw('__label__')) { while (!this.eatP(';') && !this.done) this.i++; continue; }
        /*
         * A pragma inside a body. It reaches the parser because the preprocessor passes pragmas
         * through, and until now only file scope knew to skip one -- so OpenDUNE's DOS mouse
         * callback, which opens with `#pragma aux mouse_handler parm [EAX] [EBX] ...` as its FIRST
         * statement, stopped the parse on a '#' in an expression.
         *
         * Ignoring that particular pragma is honest rather than convenient: it names a register
         * calling convention for a routine only the real-mode mouse driver ever calls, through a
         * callback this host does not make.
         */
        if (this.isP('#')) { this.#pragma(); continue; }
        if (this.#startsDeclaration()) items.push(...this.#declarationOrFunction());
        else items.push(this.statement());
      }
    } finally { this.scope = saved; }
    this.expectP('}');
    return { n: 'block', items };
  }

  /** A statement starting with an identifier is a declaration only if that identifier is a type. */
  #startsDeclaration() {
    const t = this.peek();
    if (t.k !== ID) return false;
    if (t.v === '__extension__') return true;
    if (STORAGE.has(t.v) || QUALS.has(t.v) || FUNCSPEC.has(t.v)) return true;
    if (TYPE_STARTERS.includes(t.v) || isComplexSpelling(t.v)) return true;
    // `T x;` is a declaration; `T;` and `T:` are not, and neither is `T = 1` (T as a variable).
    return this.scope.isTypedef(t.v) && !this.isP(':', 1);
  }

  statement() {
    const t = this.peek();
    if (t.k === PUNCT && t.v === '{') return this.#compound();
    if (this.eatP(';')) return { n: 'empty' };

    if (t.k === ID) {
      switch (t.v) {
        case 'if': {
          this.i++; this.expectP('('); const cond = this.expression(); this.expectP(')');
          const then = this.statement();
          const els = this.eatKw('else') ? this.statement() : null;
          return { n: 'if', cond, then, els };
        }
        case 'while': {
          this.i++; this.expectP('('); const cond = this.expression(); this.expectP(')');
          return { n: 'while', cond, body: this.statement() };
        }
        case 'do': {
          this.i++; const body = this.statement();
          if (!this.eatKw('while')) throw new ParseError("expected 'while' after do-body", this.peek());
          this.expectP('('); const cond = this.expression(); this.expectP(')'); this.expectP(';');
          return { n: 'do', body, cond };
        }
        case 'for': {
          this.i++; this.expectP('(');
          const saved = this.scope;
          this.scope = new T.Scope(saved);
          try {
            let init = null;
            if (this.isP(';')) this.i++;
            else if (this.#startsDeclaration()) init = { n: 'decls', decls: this.#declarationOrFunction() };
            else { init = { n: 'exprstmt', expr: this.expression() }; this.expectP(';'); }
            const cond = this.isP(';') ? null : this.expression();
            this.expectP(';');
            const step = this.isP(')') ? null : this.expression();
            this.expectP(')');
            return { n: 'for', init, cond, step, body: this.statement() };
          } finally { this.scope = saved; }
        }
        case 'switch': {
          this.i++; this.expectP('('); const disc = this.expression(); this.expectP(')');
          return { n: 'switch', disc, body: this.statement() };
        }
        case 'case': {
          this.i++;
          const lo = this.#constExpr();
          // GNU case ranges: `case 1 ... 5:`
          const hi = this.eatP('...') ? this.#constExpr() : null;
          this.expectP(':');
          return { n: 'case', lo, hi, body: this.statement() };
        }
        case 'default': this.i++; this.expectP(':'); return { n: 'default', body: this.statement() };
        case 'break': this.i++; this.expectP(';'); return { n: 'break' };
        case 'continue': this.i++; this.expectP(';'); return { n: 'continue' };
        case 'return': {
          this.i++;
          const e = this.isP(';') ? null : this.expression();
          this.expectP(';');
          return { n: 'return', expr: e };
        }
        case 'goto': {
          this.i++;
          if (this.isP('*')) { this.i++; const e = this.expression(); this.expectP(';'); return { n: 'gotoexpr', expr: e }; }
          const label = this.expectId(); this.expectP(';');
          return { n: 'goto', label };
        }
        case 'asm': case '__asm__': case '__asm': return this.#topLevelAsm();
      }
      // A label: an identifier followed by ':'.
      if (!KEYWORDS.has(t.v) && this.isP(':', 1)) {
        this.i += 2;
        return { n: 'label', name: t.v, body: this.statement() };
      }
    }

    const expr = this.expression();
    this.expectP(';');
    return { n: 'exprstmt', expr };
  }

  // ---------------------------------------------------------------- expressions

  expression() {
    let e = this.assignment();
    while (this.isP(',')) { this.i++; e = { n: 'comma', a: e, b: this.assignment(), type: null }; }
    return e;
  }

  assignment() {
    const lhs = this.conditional();
    const t = this.peek();
    const OPS = ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|='];
    if (t.k === PUNCT && OPS.includes(t.v)) {
      this.i++;
      return { n: 'assign', op: t.v, lhs, rhs: this.assignment(), type: lhs.type };
    }
    return lhs;
  }

  conditional() {
    const c = this.#binary(0);
    if (!this.isP('?')) return c;
    this.i++;
    // GNU elvis: `a ?: b`
    const then = this.isP(':') ? null : this.expression();
    this.expectP(':');
    const els = this.conditional();
    return { n: 'cond', cond: c, then, els, type: (then ?? c).type ?? els.type };
  }

  #binary(minPrec) {
    let lhs = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.k !== PUNCT) break;
      const prec = BINPREC[t.v];
      if (prec === undefined || prec < minPrec) break;
      this.i++;
      const rhs = this.#binary(prec + 1);
      lhs = { n: 'bin', op: t.v, a: lhs, b: rhs, type: binType(t.v, lhs, rhs) };
    }
    return lhs;
  }

  unary() {
    const t = this.peek();
    if (t.k === PUNCT) {
      // GNU label address. The lexer produces `&&` as one punctuator, so this must be checked
      // before the unary operators.
      if (t.v === '&&' && this.peek(1).k === ID && !KEYWORDS.has(this.peek(1).v)) {
        this.i++;
        const name = this.expectId();
        return { n: 'labeladdr', name, type: T.ptr(T.VOID) };
      }
      const U = ['&', '*', '+', '-', '~', '!'];
      if (U.includes(t.v)) {
        this.i++;
        const e = this.unary();
        let type = e.type;
        if (t.v === '&') type = T.ptr(e.type ?? T.INT);
        else if (t.v === '*') type = e.type?.k === 'ptr' ? e.type.to : (e.type?.k === 'array' ? e.type.of : T.INT);
        else if (t.v === '!') type = T.INT;
        else if (e.type) type = T.promote(T.decay(e.type));
        return { n: 'unary', op: t.v, expr: e, type };
      }
      if (t.v === '++' || t.v === '--') {
        this.i++;
        const e = this.unary();
        return { n: 'preinc', op: t.v, expr: e, type: e.type };
      }
      if (t.v === '(' && this.#isCastAhead()) {
        this.i++;
        const type = this.#typeName();
        this.expectP(')');
        /*
         * A compound literal is `(T){...}`, not a cast -- and the grammar makes it a POSTFIX
         * expression, so `(int []){0,1,2}[i]` and `(struct s){...}.f` are ordinary C (gcc's
         * pr22098-1.c). Its own suffixes are parsed here rather than left to the caller, which
         * would have gone on to read the `[` as the start of a new statement.
         */
        if (this.isP('{')) {
          const init = this.#initializer(type);
          // `(int []){0,1,2}` states its extent by listing it, the same completion a declaration
          // gets from its initialiser.
          const complete = type.k === 'array' && type.n === null && init.n === 'initlist'
            ? T.array(type.of, initListExtent(init, type.of)) : type;
          return this.#postfix({ n: 'compound', type: complete, init });
        }
        return { n: 'cast', type, expr: this.unary() };
      }
    }
    if (t.k === ID) {
      if (t.v === 'sizeof') {
        this.i++;
        if (this.isP('(') && this.#isTypeNameAhead()) {
          this.i++;
          const type = this.#typeName();
          this.expectP(')');
          if (this.isP('{')) {
            const lit = { n: 'compound', type, init: this.#initializer(type) };
            return { n: 'sizeofexpr', expr: lit, type: T.UINT };
          }
          return { n: 'sizeoftype', target: type, type: T.UINT };
        }
        return { n: 'sizeofexpr', expr: this.unary(), type: T.UINT };
      }
      /*
       * `__real__ z` and `__imag__ z` are unary OPERATORS, and they are lvalues: `__real__ x = 5;`
       * is how a program writes one half. On a real operand gcc lets them through -- __real__ is the
       * value itself and __imag__ is a zero of the same type.
       */
      if (t.v === '__real__' || t.v === '__real' || t.v === '__imag__' || t.v === '__imag') {
        this.i++;
        const e = this.unary();
        const part = /imag/.test(t.v) ? 1 : 0;
        return { n: 'cxpart', part, expr: e, type: e.type?.complexOf ?? e.type ?? T.DOUBLE };
      }
      if (t.v === '__alignof__' || t.v === '__alignof') {
        this.i++;
        if (this.isP('(') && this.#isTypeNameAhead()) {
          this.i++; const type = this.#typeName(); this.expectP(')');
          return { n: 'alignoftype', target: type, type: T.UINT };
        }
        return { n: 'alignofexpr', expr: this.unary(), type: T.UINT };
      }
      if (t.v === '__builtin_offsetof') {
        this.i++;
        this.expectP('(');
        const type = this.#typeName();
        this.expectP(',');
        const path = this.#offsetofPath();
        this.expectP(')');
        return { n: 'offsetof', target: type, path, type: T.UINT };
      }
      if (t.v === '__extension__') { this.i++; return this.unary(); }
    }
    return this.#postfix();
  }

  #offsetofPath() {
    const path = [{ field: this.expectId() }];
    for (;;) {
      if (this.eatP('.')) { path.push({ field: this.expectId() }); continue; }
      if (this.eatP('[')) { path.push({ index: Number(this.#constExpr()) }); this.expectP(']'); continue; }
      return path;
    }
  }

  /** `(` at the cursor: a cast, or a parenthesized expression? Decided by the scope, not by luck. */
  #isCastAhead() {
    if (!this.isP('(')) return false;
    const t = this.peek(1);
    if (t.k !== ID) return false;
    if (QUALS.has(t.v)) return true;
    if (TYPE_STARTERS.includes(t.v) || isComplexSpelling(t.v)) return true;
    if (!this.scope.isTypedef(t.v)) return false;
    // `(T)` or `(T*)` or `(T[...])` is a cast; `(T + 1)` would be an expression using T as a value,
    // which cannot happen for a typedef name, so a typedef here is always a cast.
    return true;
  }

  #isTypeNameAhead() { return this.#isCastAhead(); }

  #postfix(start = null) {
    let e = start ?? this.#primary();
    for (;;) {
      if (this.isP('[')) {
        this.i++;
        const idx = this.expression();
        this.expectP(']');
        const base = e.type ? T.decay(e.type) : null;
        e = { n: 'index', base: e, index: idx, type: base?.k === 'ptr' ? base.to : T.INT };
        continue;
      }
      if (this.isP('(')) {
        this.i++;
        const args = [];
        if (!this.isP(')')) for (;;) { args.push(this.assignment()); if (!this.eatP(',')) break; }
        this.expectP(')');
        let ft = e.type ? T.decay(e.type) : null;
        if (ft?.k === 'ptr' && ft.to.k === 'func') ft = ft.to;
        e = { n: 'call', fn: e, args, type: ft?.k === 'func' ? ft.ret : T.INT };
        continue;
      }
      if (this.isP('.') || this.isP('->')) {
        const arrow = this.isP('->');
        this.i++;
        const field = this.expectId();
        let rec = e.type;
        /*
         * `->` decays its operand first: an ARRAY of structs is a valid left side, because it decays
         * to a pointer. Without the decay the field was never found and the member's type silently
         * became `int` -- so `sizeof(cases->c)` answered 4 instead of 32, and c-testsuite's 00205
         * (a snippet of the J interpreter) printed one array element instead of four.
         */
        if (arrow && rec) rec = T.decay(rec);
        if (arrow && rec?.k === 'ptr') rec = rec.to;
        const f = rec && T.isRecord(rec) ? findField(rec, field) : null;
        /*
         * A BITFIELD's expression type is its PROMOTED type, not its declared one (C 6.3.1.1): int
         * if int can hold every value the field can have, else unsigned int, else the field's own
         * type. The emitter has always known this -- it is why `unsigned f:3` minus 1 is -1 and not
         * a huge unsigned -- but the parser did not, and the parser is what answers `sizeof`. It
         * never showed for an ordinary bitfield, whose declared type is already 4 bytes; a
         * `long long a:8` made `sizeof(a + 0)` eight where gcc says four.
         */
        let mtype = f?.type ?? T.INT;
        if (f && f.bits !== undefined && mtype.k === 'scalar' && T.isInteger(mtype)) {
          if (f.width < 32) mtype = T.INT;
          else if (f.width === 32) mtype = mtype.signed ? T.INT : T.UINT;
        }
        e = { n: 'member', base: e, field, arrow, type: mtype, offset: f?.offset ?? null };
        continue;
      }
      if (this.isP('++') || this.isP('--')) {
        const op = this.next().v;
        e = { n: 'postinc', op, expr: e, type: e.type };
        continue;
      }
      return e;
    }
  }

  #primary() {
    const t = this.next();
    if (t.k === NUM) return numberLiteral(t);
    if (t.k === STR) {
      const parts = [t];
      while (this.peek().k === STR) parts.push(this.next());       // adjacent literals concatenate
      // `L"…"` is an array of wchar_t, which is `int` on i386 — the element type, not just the
      // bytes, has to be right or `sizeof(L"ab")` and pointer arithmetic on it are both wrong.
      const wide = parts.some(p => p.v[0] === 'L');
      // A string literal's type is a COMPLETE array — `sizeof("ab")` is 3 — so it must carry its
      // length here rather than being left incomplete.
      let n = 0;
      for (const p of parts) n += stringLiteralLength(p.v);
      return { n: 'str', parts, wide, type: T.array(wide ? T.INT : T.CHAR, n + 1) };
    }
    if (t.k === CHR) return { n: 'char', value: charValue(t.v), type: T.INT };
    if (t.k === PUNCT && t.v === '(') {
      // GNU statement expression: `({ ... })`
      if (this.isP('{')) {
        const body = this.#compound();
        this.expectP(')');
        // The value of a statement expression is its LAST statement, so that is where its type
        // comes from; anything else -- a declaration, a loop -- makes it void, as gcc does.
        const tail = body.items[body.items.length - 1];
        const type = tail?.n === 'exprstmt' ? (tail.expr.type ?? T.INT) : T.VOID;
        return { n: 'stmtexpr', body, type };
      }
      const e = this.expression();
      this.expectP(')');
      return e;
    }
    if (t.k === ID && !KEYWORDS.has(t.v)) {
      const sym = this.scope.lookup(t.v);
      if (sym?.kind === 'enumconst') return { n: 'num', value: sym.value, type: T.INT };
      return { n: 'ident', name: t.v, type: sym?.type ?? null, sym };
    }
    throw new ParseError(`unexpected '${t.v || 'end of file'}' in expression`, t);
  }

  /** An integer constant expression, evaluated now. Used by array sizes, bitfields, enums, cases. */
  #constExpr() {
    const e = this.conditional();
    return constEval(e);
  }
  constExpr() { return this.#constExpr(); }
}

// ---------------------------------------------------------------- helpers

const BINPREC = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

const CMP = new Set(['==', '!=', '<', '>', '<=', '>=', '&&', '||']);

function binType(op, a, b) {
  if (CMP.has(op)) return T.INT;
  const at = a.type ? T.decay(a.type) : null;
  const bt = b.type ? T.decay(b.type) : null;
  if (!at || !bt) return at ?? bt ?? T.INT;
  // Pointer arithmetic: p+n and p-n keep the pointer type; p-q is an integer.
  if (at.k === 'ptr' && T.isInteger(bt)) return at;
  if (bt.k === 'ptr' && T.isInteger(at)) return bt;
  if (at.k === 'ptr' && bt.k === 'ptr') return T.INT;
  if (op === '<<' || op === '>>') return T.promote(at);
  /*
   * COMPLEX wins: `z * 2.0` is complex, and its parts are computed in the common type of the two
   * bases. Without this the expression was typed `double`, and the emitter -- which decides by TYPE
   * -- refused it as "not an lvalue" the moment it was returned or passed.
   */
  if (T.isComplex(at) || T.isComplex(bt)) {
    return T.complex(T.usualArith(T.isComplex(at) ? at.complexOf : at, T.isComplex(bt) ? bt.complexOf : bt));
  }
  return T.usualArith(at, bt);
}

/** Replace the placeholder left by a parenthesized declarator with the real outer type. */
function substHole(type, hole, real) {
  if (!type || typeof type !== 'object') return;
  for (const key of ['to', 'of', 'ret']) {
    if (type[key] === hole) { type[key] = real; recomputeSize(type); return; }
    if (type[key]) { substHole(type[key], hole, real); recomputeSize(type); }
  }
}

function recomputeSize(t) {
  if (t.k === 'array' && t.of && t.n !== null && t.of.size != null) {
    t.size = t.of.size * t.n;
    t.align = t.of.align;
  }
}

/** Find a member, descending into anonymous struct/union members as C11/GNU require. */
export function findField(rec, name) {
  const direct = rec.byName?.[name];
  if (direct) return direct;
  for (const f of rec.fields ?? []) {
    if (f.name || !T.isRecord(f.type)) continue;
    const inner = findField(f.type, name);
    if (inner) return { ...inner, offset: f.offset + inner.offset };
  }
  return null;
}

/**
 * A C99 hexadecimal floating constant: 0x1.8p3 is 1.5 x 2^3.
 *
 * Worth its own function because JS has no syntax for one and `parseFloat` silently returns 0 for
 * the whole thing — so a missing case here does not fail, it produces a wrong number. csmith's
 * safe_math.h is full of them (`0x1.0p-100f`, `0x1.0p-924`) as exact powers of two chosen to test
 * float overflow without rounding, which is precisely what a decimal literal cannot express.
 *
 * The exponent is mandatory in C, which is what makes 0x1p3 unambiguous against a suffix.
 */
function hexFloat(text) {
  const m = text.match(/^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([-+]?[0-9]+)$/);
  if (!m) return null;
  const [, intPart = '', fracPart = '', expPart] = m;
  if (!intPart && !fracPart) return null;
  // Scale by whole powers of two, so a value that IS a power of two comes out exact.
  const mantissa = Number(BigInt('0x' + (intPart + fracPart || '0')));
  return mantissa * Math.pow(2, parseInt(expPart, 10) - 4 * fracPart.length);
}

function numberLiteral(t) {
  let text = t.v;
  /*
   * An IMAGINARY constant: `2.0i`, `1.0fi`, `3j`. gcc's own extension, and its complex tests are
   * written with it. The value is the imaginary PART, so the constant's type is complex and its
   * real part is zero.
   */
  const im = /^(.*?)([ij])([fFlL]?)$/.exec(text);
  if (im && /[0-9.]/.test(im[1])) {
    const inner = numberLiteral({ ...t, v: im[1] + im[3] });
    const of = T.isFloat(inner.type) ? inner.type : T.DOUBLE;
    return { n: 'imaginary', value: Number(inner.value), type: T.complex(of) };
  }
  const hf = hexFloat(text.replace(/[fFlL]+$/, ''));
  if (hf !== null) {
    return { n: 'float', value: hf, type: /[fF]$/.test(text) ? T.scalar('float') : T.DOUBLE };
  }
  if (/^[0-9]*\.|[0-9][0-9a-fA-F]*[pP][-+]|^\.[0-9]/.test(text) || /^[0-9.]+[eE][-+]?[0-9]/.test(text)
      || (/^[0-9]/.test(text) && /[fF]$/.test(text) && !/^0[xX]/.test(text))) {
    const v = parseFloat(text.replace(/[fFlL]+$/, ''));
    return { n: 'float', value: v, type: /[fF]$/.test(text) ? T.scalar('float') : T.DOUBLE };
  }
  const m = text.match(/^(.*?)([uUlL]*)$/);
  const body = m[1], suffix = m[2];
  let v;
  if (/^0[xX]/.test(body)) v = BigInt(body);
  else if (/^0[bB][01]+$/.test(body)) v = BigInt(body);
  else if (/^0[0-7]+$/.test(body)) { v = 0n; for (const c of body.slice(1)) v = v * 8n + BigInt(c); }
  else v = BigInt(body);
  const uns = /[uU]/.test(suffix);
  const longs = (suffix.match(/[lL]/g) ?? []).length;

  /*
   * C99 6.4.4.1: an integer constant takes the FIRST type in a list that can represent it, and the
   * list depends on the suffix AND on whether the constant was written in decimal.
   *
   * The base matters, and that is the part that was missing. A hexadecimal or octal constant may
   * become unsigned; a decimal one may not. So `0xAD2A1758533D8CC8LL` -- larger than LLONG_MAX --
   * is an UNSIGNED long long and therefore positive, where PRISM read it as a negative long long.
   * csmith found it in the third program it generated: the comparison `1UL < 0xAD2A1758533D8CC8LL`
   * went the other way, a branch was not taken, and one global ended the run holding 1 instead of 0.
   *
   * On i386 `long` and `int` are both 32 bits, so the long entries change the type's NAME without
   * changing its width -- but they still have to be in the list, because the next candidate after
   * `long` is `long long` and skipping it is how a 33-bit decimal constant wrongly became unsigned.
   */
  const decimal = !/^0[xXbB]/.test(body) && !/^0[0-7]/.test(body);
  const fits = (t) => (t.signed ? v <= (1n << BigInt(t.size * 8 - 1)) - 1n : v <= (1n << BigInt(t.size * 8)) - 1n);
  let candidates;
  if (uns && longs >= 2) candidates = [T.ULLONG];
  else if (uns && longs === 1) candidates = [T.ULONG, T.ULLONG];
  else if (uns) candidates = [T.UINT, T.ULONG, T.ULLONG];
  else if (longs >= 2) candidates = decimal ? [T.LLONG] : [T.LLONG, T.ULLONG];
  else if (longs === 1) candidates = decimal ? [T.LONG, T.LLONG] : [T.LONG, T.ULONG, T.LLONG, T.ULLONG];
  else if (decimal) candidates = [T.INT, T.LONG, T.LLONG];
  else candidates = [T.INT, T.UINT, T.LONG, T.ULONG, T.LLONG, T.ULLONG];
  // Nothing fits only for a decimal constant too large for long long; gcc takes unsigned long long
  // there too, with a warning nobody reads.
  const type = candidates.find(fits) ?? T.ULLONG;
  return { n: 'num', value: v, type };
}

/**
 * How many elements a brace initialiser actually reaches, designators and BRACE ELISION included.
 *
 * Counting top-level items is right only when each element takes one. With elision an aggregate
 * element swallows several, and getting this wrong is not a layout detail -- it is the array's
 * length, so `sizeof(a)/sizeof(a[0])` comes out wrong and every loop over the table runs too long.
 * c-testsuite's 00205 (a snippet of the J interpreter) writes ten seven-field structs as seventy
 * bare scalars; counted item by item it became a 63-element array and printed 505 lines to gcc's 72.
 *
 * The decisions here are syntactic only -- is the item a braced list, is it a string literal -- and
 * they MUST match `#elidable` in src/backend/emit.js, which makes the same calls when it writes the
 * bytes. Two walkers, one rule; if they disagree the length and the contents disagree.
 */
export function initListExtent(init, elemType = null) {
  let idx = 0, max = 0;
  for (let i = 0; i < init.items.length;) {
    const it = init.items[i];
    if (it.designators?.[0]?.index !== undefined) idx = it.designators[0].index;
    if (elemType && !it.designators && it.value.n !== 'initlist' && elidesInto(elemType, it)) {
      const next = consumeElided(elemType, init.items, i);
      i = next > i ? next : i + 1;
    } else {
      i++;
    }
    idx++;
    if (idx > max) max = idx;
  }
  return max;
}

/** Does this item begin an ELIDED initialiser for `type` — an aggregate given a bare expression? */
function elidesInto(type, it) {
  if (type.k !== 'array' && type.k !== 'struct' && type.k !== 'union') return false;
  let e = it.value.expr;
  while (e && e.n === 'cast') e = e.expr;
  if (!e) return false;
  // A string literal is a complete initialiser for a character array, not one of its elements.
  if (e.n === 'str' && type.k === 'array' && type.of.k === 'scalar'
      && (type.of.size === 1 || type.of.size === 4)) return false;
  return true;
}

/** The index of the first item an elided `type` does NOT take, starting at `i`. */
function consumeElided(type, items, i) {
  if (type.k === 'array') {
    const n = type.n ?? 0;
    for (let k = 0; k < n && i < items.length; k++) {
      if (items[i].designators) return i;
      if (items[i].value.n === 'initlist') i++;
      else if (elidesInto(type.of, items[i])) i = consumeElided(type.of, items, i);
      else i++;
    }
    return i;
  }
  const named = (type.fields ?? []).filter(f => f.name && f.width !== 0);
  const upto = type.k === 'union' ? Math.min(1, named.length) : named.length;
  for (let k = 0; k < upto && i < items.length; k++) {
    if (items[i].designators) return i;
    if (items[i].value.n === 'initlist') i++;
    else if (named[k].bits !== undefined) i++;
    else if (elidesInto(named[k].type, items[i])) i = consumeElided(named[k].type, items, i);
    else i++;
  }
  return i;
}

/** The length of a string literal in ELEMENTS — wide units for `L"…"`, bytes otherwise.
 *  Counting source BYTES here made `sizeof(L"Ä")` 12 instead of 8. */
/**
 * `__attribute__((mode(M)))`: the machine mode decides the WIDTH, the written type decides only the
 * signedness. The i386 modes a program can name, and what they are here.
 *
 * A mode this does not know is refused rather than guessed: getting a width wrong is a wrong
 * answer, and these types are used precisely where the width is the whole point.
 */
function applyMode(type, mode, at) {
  const uns = T.isInteger(type) && T.isUnsigned(type);
  const INT_MODES = {
    QI: ['signed char', 'unsigned char'],
    HI: ['short', 'unsigned short'],
    SI: ['int', 'unsigned int'],
    DI: ['long long', 'unsigned long long'],
    byte: ['signed char', 'unsigned char'],
    // On i386 a machine word and a pointer are both 32 bits.
    word: ['int', 'unsigned int'],
    pointer: ['int', 'unsigned int'],
  };
  if (INT_MODES[mode]) return T.scalar(INT_MODES[mode][uns ? 1 : 0]);
  if (mode === 'SF') return T.scalar('float');
  if (mode === 'DF') return T.scalar('double');
  throw new ParseError(`__attribute__((mode(${mode}))) is not a mode tier-0 knows`, at);
}

/** The keywords a type name may START with -- shared by the three lookaheads, which disagreed. */
const TYPE_STARTERS = ['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed',
  'unsigned', '_Bool', 'struct', 'union', 'enum', 'typeof', '__typeof__'];
/** `_Complex`, `__complex__`, `__complex`, `_Complex_` -- gcc accepts them all. */
const isComplexSpelling = (v) => /^_*(complex|Complex)_*$/.test(v);

export const stringLiteralLength = (text) => literalUnits(text).length;

export class ConstError extends Error {}

/**
 * Wrap a folded value to its expression's type. A constant expression is evaluated IN its type:
 * `(0x1234567876543210LL << 32) >> 32` must lose the shifted-out bits, and without this the static
 * initialiser kept them and disagreed with the same expression evaluated at run time
 * (gcc's 20060110-1.c).
 */
function narrow(v, t) {
  if (typeof v !== 'bigint' || !t || t.k !== 'scalar') return v;
  const bits = (t.size ?? 4) * 8;
  if (t.name === 'float' || t.name === 'double' || t.name === 'long double') return v;
  return t.signed ? BigInt.asIntN(bits, v) : BigInt.asUintN(bits, v);
}

function binConst(op, a, b) {
  switch (op) {
    case '+': return a + b; case '-': return a - b; case '*': return a * b;
    case '/': if (b === 0n) throw new ConstError('division by zero'); return a / b;
    case '%': if (b === 0n) throw new ConstError('division by zero'); return a % b;
    case '<<': return a << b; case '>>': return a >> b;
    case '&': return a & b; case '|': return a | b; case '^': return a ^ b;
    case '==': return a === b ? 1n : 0n; case '!=': return a !== b ? 1n : 0n;
    case '<': return a < b ? 1n : 0n; case '>': return a > b ? 1n : 0n;
    case '<=': return a <= b ? 1n : 0n; case '>=': return a >= b ? 1n : 0n;
    case '&&': return (a !== 0n && b !== 0n) ? 1n : 0n;
    case '||': return (a !== 0n || b !== 0n) ? 1n : 0n;
  }
  throw new ConstError(`operator '${op}' is not constant`);
}

/** Evaluate an integer constant expression. Throws if the expression is not constant. */
export function constEval(e) {
  const r = ce(e);
  if (typeof r !== 'bigint') throw new ConstError('not an integer constant expression');
  return r;
}

/**
 * The address of an lvalue, as an integer, when arithmetic on a constant pointer gets us there.
 *
 * `p->m` adds the member's offset to the POINTER's value; `b.m` adds it to the address of `b`, which
 * has to be constant in turn; `a[i]` adds `i` elements, taking its base the same way round. Anything
 * else falls through to `ce`, which either evaluates it -- a cast of 0 to a pointer is exactly that
 * -- or refuses it by name.
 */
function addrConst(e) {
  switch (e.n) {
    case 'member': {
      if (e.offset === null || e.offset === undefined) {
        throw new ConstError(`no constant offset for member '${e.field}'`);
      }
      const base = e.arrow ? ce(e.base) : addrConst(e.base);
      return base + BigInt(e.offset);
    }
    case 'index': {
      const elem = e.type;
      if (!elem || elem.size == null) throw new ConstError('subscript of an incomplete type');
      // An array decays to its own address; a pointer is already one.
      const bt = e.base.type;
      const base = bt && bt.k === 'array' ? addrConst(e.base) : ce(e.base);
      return base + ce(e.index) * BigInt(elem.size);
    }
    case 'unary':
      if (e.op === '*') return ce(e.expr);
      break;
    default: break;
  }
  return ce(e);
}

function ce(e) {
  switch (e.n) {
    case 'num': return e.value;
    case 'char': return e.value;
    case 'float': return e.value;                              // callers that need an integer cast
    case 'bin': {
      const a = ce(e.a), b = ce(e.b);
      return narrow(binConst(e.op, a, b), e.type);
    }
    case 'unary':
      switch (e.op) {
        case '-': return -ce(e.expr);
        case '+': return ce(e.expr);
        case '~': return ~ce(e.expr);
        case '!': return ce(e.expr) === 0n ? 1n : 0n;
        /*
         * `&lvalue`, when the lvalue's address is arithmetic on a constant pointer. That is how C
         * spelled offsetof before it had one, and a great deal of pre-standard code still does:
         *
         *     #define FIELD_OFFSET(t, f)  ((LONG)&(((t *)0)->f))        // the Windows SDK
         *     #define offset(c, m)        (((size_t)&((c *)8)->m) - 8)  // OpenDUNE, saveload.h:29
         *
         * The emitter has folded this shape for a while (`#lvalAddrConst`), but a STATIC INITIALISER
         * is evaluated here, before the emitter sees it -- so WinQuake's DirectInput data-format
         * table, thirteen rows of FIELD_OFFSET, was refused with "unary '&' is not constant" and the
         * emitter's version never got the chance.
         */
        case '&': return addrConst(e.expr);
      }
      throw new ConstError(`unary '${e.op}' is not constant`);
    case 'cond': {
      const c = ce(e.cond);
      return c !== 0n ? (e.then ? ce(e.then) : c) : ce(e.els);
    }
    case 'cast': {
      const v = ce(e.expr);
      const t = e.type ?? e.target;
      if (T.isInteger(t) && typeof v === 'bigint') {
        return t.signed ? BigInt.asIntN(t.size * 8, v) : BigInt.asUintN(t.size * 8, v);
      }
      return v;
    }
    case 'sizeoftype': {
      if (e.target.size == null) throw new ConstError('sizeof an incomplete type');
      return BigInt(e.target.size);
    }
    case 'sizeofexpr': {
      const t = e.expr.type;
      if (!t || t.size == null) throw new ConstError('sizeof an expression of unknown type');
      return BigInt(t.size);
    }
    case 'alignoftype': return BigInt(e.target.align ?? 1);
    case 'offsetof': {
      let t = e.target, off = 0;
      for (const step of e.path) {
        if (step.field !== undefined) {
          const f = findField(t, step.field);
          if (!f) throw new ConstError(`no member '${step.field}'`);
          off += f.offset; t = f.type;
        } else {
          if (t.k !== 'array') throw new ConstError('subscript of a non-array in offsetof');
          off += step.index * t.of.size; t = t.of;
        }
      }
      return BigInt(off);
    }
    case 'comma': throw new ConstError('comma is not allowed in a constant expression');
  }
  // Name the thing, not just its node kind. "'ident' is not a constant expression" gave nothing to
  // search for in a 270,000-line amalgamation; the identifier's own name points straight at it.
  const what = e.n === 'ident' ? `identifier '${e.name}'`
    : e.n === 'call' ? `a call to '${e.fn?.name ?? '?'}'`
    : e.n === 'bin' ? `the operator '${e.op}'`
    : e.n === 'unary' ? `the operator '${e.op}'`
    : `'${e.n}'`;
  throw new ConstError(`${what} is not a constant expression`);
}

/** Parse a whole translation unit from preprocessed tokens. */
/** Does this type contain a variable extent anywhere? A VLA of, or a pointer to, still counts. */
function hasVla(t) {
  for (let x = t; x; x = x.k === 'array' ? x.of : x.k === 'ptr' ? x.to : null) {
    if (x.k === 'array' && x.vla) return true;
  }
  return false;
}

export function parse(tokens, opts = {}) {
  const p = new Parser(tokens, opts);
  const unit = p.parseTranslationUnit();
  return { unit, scope: p.scope };
}
