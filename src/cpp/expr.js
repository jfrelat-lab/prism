// expr.js — the `#if` expression evaluator.
//
// Two things make this its own file rather than a corner of cpp.js:
//
//   1. `#if` arithmetic is done in intmax_t/uintmax_t — 64-bit, whatever the target's `int` is. So
//      `#if 0x7fffffff + 1 > 0` is TRUE in a preprocessor and false in the compiled program. That
//      needs BigInt; it is compile-time and rare, so the cost is irrelevant.
//   2. Signedness is per-operand and propagates: if either side of a comparison is unsigned, the
//      comparison is unsigned. `#if -1 < 0u` is FALSE.
//
// Undefined identifiers become 0 (after macro expansion), and `defined X` / `defined(X)` is handled
// by the caller before expansion — it must be, because expanding first would consume the name.

import { charConstValue } from '../util/charset.js';

const MASK = (1n << 64n) - 1n;
const toU = (v) => ((v % (1n << 64n)) + (1n << 64n)) & MASK;
const toS = (v) => { const u = toU(v); return u >= (1n << 63n) ? u - (1n << 64n) : u; };

/** A value carries its signedness, because that changes the meaning of /, %, >> and comparisons. */
const val = (v, unsigned) => ({ v: unsigned ? toU(v) : toS(v), u: unsigned });

export class ExprError extends Error {}

/**
 * @param tokens pp-tokens of the controlling expression, already macro-expanded, `defined` resolved.
 * @returns boolean
 */
export function evalCondition(tokens, { sizeofs = null } = {}) {
  const p = new Parser(tokens.filter(t => t.k !== 'eof'), sizeofs);
  const r = p.conditional();
  p.expectEnd();
  return r.v !== 0n;
}

class Parser {
  // `live` is false inside a branch that cannot be reached. gcc evaluates the whole expression but
  // does NOT diagnose a dead `1/0`: `#if (0 ? 1/0 : 5) == 5` and `#if 1 || 1/0` both compile.
  // Observed, and the reason division-by-zero is suppressed rather than deferred.
  constructor(ts, sizeofs = null) { this.ts = ts; this.i = 0; this.live = true; this.sizeofs = sizeofs; }
  peek() { return this.ts[this.i]; }
  next() { return this.ts[this.i++]; }
  at(v) { const t = this.peek(); return t && t.k === 'punct' && t.v === v; }
  eat(v) { if (this.at(v)) { this.i++; return true; } return false; }
  expect(v) { if (!this.eat(v)) throw new ExprError(`expected '${v}' in #if expression`); }
  expectEnd() { if (this.i < this.ts.length) throw new ExprError(`unexpected '${this.peek().v}' in #if expression`); }

  primary() {
    const t = this.next();
    if (!t) throw new ExprError('#if with no expression');
    if (t.k === 'punct' && t.v === '(') { const r = this.conditional(); this.expect(')'); return r; }
    if (t.k === 'num') return number(t.v);
    if (t.k === 'chr') return val(charValue(t.v), false);
    if (t.k === 'id') {
      /*
       * `sizeof` is named before it dissolves. The rule below turns it into 0 like any other
       * leftover identifier, so `#if BUFFERSIZE < sizeof(maptype)` becomes `4096 < 0 (0)` and comes
       * out as "unexpected '('" -- a syntax error pointing at a parenthesis, for a construct that
       * was perfectly deliberate. Keen Dreams' id_ca.c has one, guarding a compile-time assertion.
       *
       * It is Borland's, not C's: that compiler preprocessed and parsed in one pass and could ask
       * its own type table. A standalone preprocessor has no types, and every conforming compiler
       * rejects this file too -- so the answer is a refusal, and what is worth getting right is
       * that the refusal says what it refused.
       */
      /*
       * ...unless the build STATES the answer. compile.ppSizeof maps a type's spelling to its size,
       * which is what Borland's one-pass compiler knew and a standalone preprocessor cannot: an
       * option, like -D, and not a change to the source. Each entry is checked against PRISM's own
       * layout of that type and Borland's (tools/gate-pp-sizeof.mjs), so a wrong number cannot stand.
       * `sizeof(T)` only, with T spelled as the table spells it; anything else keeps the refusal.
       */
      if (t.v === 'sizeof') {
        if (this.sizeofs && this.at('(')) {
          const save = this.i;
          this.i++;
          const words = [];
          while (this.peek() && !this.at(')') && this.peek().k === 'id') words.push(this.next().v);
          const spelled = words.join(' ');
          if (this.eat(')') && words.length && Object.hasOwn(this.sizeofs, spelled)) {
            return val(BigInt(this.sizeofs[spelled]), true);
          }
          this.i = save;
          throw new ExprError(`'sizeof' in a #if condition, for a type compile.ppSizeof does not state`
            + (words.length ? ` ('${spelled}')` : ''));
        }
        throw new ExprError("'sizeof' in a #if condition: a Borland extension, not standard C — "
          + 'the preprocessor has no types to measure');
      }
      // Any identifier still standing after expansion is 0 — including `true`/`false` in C89,
      // which is why <stdbool.h> defines them as macros.
      return val(0n, false);
    }
    if (t.k === 'str') throw new ExprError('string literal in #if expression');
    throw new ExprError(`invalid token '${t.v}' in #if expression`);
  }

  unary() {
    const t = this.peek();
    if (t && t.k === 'punct') {
      if (this.eat('-')) { const a = this.unary(); return val(-a.v, a.u); }
      if (this.eat('+')) return this.unary();
      if (this.eat('!')) { const a = this.unary(); return val(a.v === 0n ? 1n : 0n, false); }
      if (this.eat('~')) { const a = this.unary(); return val(~a.v, a.u); }
    }
    return this.primary();
  }

  /** Parse (and maybe evaluate) with `live` temporarily forced off. */
  #dead(fn) {
    const saved = this.live;
    this.live = false;
    try { return fn(); } finally { this.live = saved; }
  }

  // Precedence climbing over the C binary operators legal in #if.
  binary(minPrec = 0) {
    let lhs = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.k !== 'punct') break;
      const prec = PREC[t.v];
      if (prec === undefined || prec < minPrec) break;
      this.i++;
      // `||` and `&&` short-circuit: the right side is still parsed, but not diagnosed.
      const shortCircuits = (t.v === '||' && lhs.v !== 0n) || (t.v === '&&' && lhs.v === 0n);
      const rhs = shortCircuits ? this.#dead(() => this.binary(prec + 1)) : this.binary(prec + 1);
      lhs = apply(t.v, lhs, rhs, this.live);
    }
    return lhs;
  }

  conditional() {
    const c = this.binary();
    if (!this.eat('?')) return c;
    const taken = c.v !== 0n;
    const a = taken ? this.conditional() : this.#dead(() => this.conditional());
    this.expect(':');
    const b = taken ? this.#dead(() => this.conditional()) : this.conditional();
    return taken ? a : b;
  }
}

const PREC = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

function apply(op, a, b, live = true) {
  // The usual arithmetic conversions, in their 64-bit form: unsigned wins.
  const u = a.u || b.u;
  const A = u ? toU(a.v) : a.v, B = u ? toU(b.v) : b.v;
  const bool = (x) => val(x ? 1n : 0n, false);
  switch (op) {
    case '||': return bool(a.v !== 0n || b.v !== 0n);
    case '&&': return bool(a.v !== 0n && b.v !== 0n);
    case '|': return val(A | B, u);
    case '^': return val(A ^ B, u);
    case '&': return val(A & B, u);
    case '==': return bool(A === B);
    case '!=': return bool(A !== B);
    case '<': return bool(A < B);
    case '>': return bool(A > B);
    case '<=': return bool(A <= B);
    case '>=': return bool(A >= B);
    // A shift keeps the LEFT operand's signedness, not the converted one.
    case '<<': return val(a.u ? toU(a.v) << (B & 63n) : a.v << (B & 63n), a.u);
    case '>>': return val(a.u ? toU(a.v) >> (B & 63n) : a.v >> (B & 63n), a.u);
    case '+': return val(A + B, u);
    case '-': return val(A - B, u);
    case '*': return val(A * B, u);
    case '/':
      if (B === 0n) { if (!live) return val(0n, u); throw new ExprError('division by zero in #if expression'); }
      return val(u ? A / B : truncDiv(A, B), u);
    case '%':
      if (B === 0n) { if (!live) return val(0n, u); throw new ExprError('division by zero in #if expression'); }
      return val(u ? A % B : truncRem(A, B), u);
  }
  throw new ExprError(`operator '${op}' is not allowed in #if`);
}

// BigInt `/` already truncates toward zero, and `%` takes the sign of the dividend — same as C99.
const truncDiv = (a, b) => a / b;
const truncRem = (a, b) => a % b;

/** Parse a pp-number as an integer constant. Floats are not allowed in #if. */
export function number(text) {
  let s = text;
  let unsigned = false;
  // Strip the integer suffixes; anything left over means it was not an integer constant.
  const m = s.match(/^(.*?)([uUlL]*)$/);
  const suffix = m[2];
  s = m[1];
  if (/[uU]/.test(suffix)) unsigned = true;
  let v;
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) v = BigInt(s);
  else if (/^0[bB][01]+$/.test(s)) v = BigInt(s);                 // GNU binary literal
  else if (/^0[0-7]*$/.test(s)) v = BigInt(parseOctal(s));
  else if (/^[1-9][0-9]*$/.test(s)) v = BigInt(s);
  else if (/^0$/.test(s)) v = 0n;
  else throw new ExprError(`'${text}' is not an integer constant`);
  // A decimal constant too large for intmax_t becomes unsigned, as does any hex/octal one.
  if (!unsigned && v > (1n << 63n) - 1n) unsigned = true;
  return val(v, unsigned);
}

const parseOctal = (s) => {
  let v = 0n;
  for (const c of s) v = v * 8n + BigInt(c);
  return v;
};

/** The value of a character constant in #if. Delegates to the one charset module. */
export const charValue = (text) => charConstValue(text);
