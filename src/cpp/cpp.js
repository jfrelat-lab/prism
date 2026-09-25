// cpp.js — translation phase 4: directives and macro expansion.
//
// Expansion follows Prosser's algorithm (the one the standard's "blue paint" rule describes
// operationally): every token carries a HIDE SET of the macros it must not be re-expanded by, and a
// function-like invocation's hide set is the INTERSECTION of the name's and the closing paren's,
// plus the macro itself. Nothing else terminates recursion correctly — a depth counter accepts
// programs it should reject and rejects programs it should accept.
//
// Implementation shape: expansion rewrites the work list in place and rescans from the same index,
// which is what makes nested and repeated expansion fall out for free.

import { ID, NUM, STR, CHR, PUNCT, OTHER, EOF, tok, clone, hsHas, hsAdd, hsUnion, hsIntersect, render }
  from './token.js';
import { tokenize, lex } from './lexer.js';
import { evalCondition, ExprError } from './expr.js';

export class CppError extends Error {
  constructor(msg, loc) { super(loc ? `${loc.file}:${loc.line}: ${msg}` : msg); this.loc = loc; }
}

// A PLACEMARKER stands for an empty macro argument next to a `##`. It must exist as a token:
// deleting it lets the paste reach past it into the replacement list. Dropped at the end of subst.
const PMK = 'pm';
const PM = tok(PMK, '');

const DIRECTIVES = new Set(['define', 'undef', 'include', 'include_next', 'if', 'ifdef', 'ifndef',
  'elif', 'else', 'endif', 'line', 'error', 'warning', 'pragma', 'ident', 'sccs', 'assert',
  'unassert']);

export class Preprocessor {
  /**
   * @param opts.defines   {NAME: 'value'} predefined object-like macros
   * @param opts.resolve   (name, angled, fromFile, skipUntilAfter) => {path, text} | null
   * @param opts.trigraphs enable phase-1 trigraph replacement (OFF in -std=gnu*, as in gcc)
   * @param opts.onError   (msg) => void  — #error/#warning and recoverable problems
   */
  constructor(opts = {}) {
    this.macros = new Map();
    this.resolve = opts.resolve ?? (() => null);
    this.trigraphs = opts.trigraphs ?? false;
    // sizeof(T) in #if, answered from the build's own statement of the size (see expr.js).
    this.ppSizeof = opts.ppSizeof ?? null;
    this.diagnostics = [];
    this.counter = 0;
    this.includeDepth = 0;
    this.maxIncludeDepth = opts.maxIncludeDepth ?? 200;
    this.pragmaOnce = new Set();
    // #pragma push_macro/pop_macro: one saved-definition stack per macro name.
    this.macroStacks = new Map();
    this.dynamic = new Set(['__FILE__', '__LINE__', '__COUNTER__']);
    for (const [k, v] of Object.entries(opts.defines ?? {})) this.defineText(k, v);
  }

  /** Define from text, the equivalent of a `-D` on the command line. */
  defineText(spec, value = '1') {
    const eq = spec.indexOf('=');
    const text = eq < 0 ? `#define ${spec} ${value}\n` : `#define ${spec.slice(0, eq)} ${spec.slice(eq + 1)}\n`;
    const { tokens } = tokenize(text, { file: '<command-line>' });
    this.#directive(tokens.slice(1, -1), { emit: [] });
  }

  /** Preprocess one source string. Returns the fully expanded pp-token stream. */
  run(source, file = '<input>') {
    const out = [];
    this.#runInto(source, file, out);
    out.push(tok(EOF, '', { bol: true }));
    return out;
  }

  #runInto(source, file, emit) {
    const { tokens, errors } = tokenize(source, { file, trigraphs: this.trigraphs });
    for (const e of errors) this.diagnostics.push(e);
    this.#process(tokens, { file, emit });
  }

  // ------------------------------------------------------------------ the line loop

  #process(tokens, ctx) {
    // A stack entry: {taken: has any branch been taken?, active: are we emitting?, seenElse}
    const conds = [];
    const active = () => conds.every(c => c.active);
    let i = 0;

    while (i < tokens.length && tokens[i].k !== EOF) {
      const t = tokens[i];

      // A directive is a `#` that is the first token on its line.
      if (t.bol && t.k === PUNCT && t.v === '#') {
        let j = i + 1;
        while (j < tokens.length && tokens[j].k !== EOF && !tokens[j].bol) j++;
        const line = tokens.slice(i + 1, j);
        i = j;
        const name = line.length && line[0].k === ID ? line[0].v : null;

        // Conditionals are processed even in a skipped region — that is how nesting works.
        if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
          if (!active()) { conds.push({ taken: true, active: false, seenElse: false }); continue; }
          const v = this.#evalIf(name, line.slice(1), t.loc);
          conds.push({ taken: v, active: v, seenElse: false });
          continue;
        }
        if (name === 'elif') {
          const c = conds[conds.length - 1];
          if (!c) throw new CppError('#elif without #if', t.loc);
          if (c.seenElse) throw new CppError('#elif after #else', t.loc);
          // Only evaluate if an enclosing level is active AND no branch has been taken here.
          const enclosing = conds.slice(0, -1).every(x => x.active);
          if (!enclosing || c.taken) { c.active = false; continue; }
          const v = this.#evalIf('if', line.slice(1), t.loc);
          c.active = v; c.taken = c.taken || v;
          continue;
        }
        if (name === 'else') {
          const c = conds[conds.length - 1];
          if (!c) throw new CppError('#else without #if', t.loc);
          if (c.seenElse) throw new CppError('#else after #else', t.loc);
          c.seenElse = true;
          const enclosing = conds.slice(0, -1).every(x => x.active);
          c.active = enclosing && !c.taken;
          c.taken = true;
          continue;
        }
        if (name === 'endif') {
          if (!conds.length) throw new CppError('#endif without #if', t.loc);
          conds.pop();
          continue;
        }

        if (!active()) continue;                       // every other directive is skipped

        // An unknown directive inside an inactive region is fine; here it is an error — except
        // that a `#` alone (the null directive) is always legal.
        if (name === null) {
          if (line.length === 0) continue;
          if (line[0].k === NUM) continue;             // `# 42 "file"` — a linemarker, ignore
          throw new CppError(`invalid preprocessing directive`, t.loc);
        }
        if (!DIRECTIVES.has(name)) throw new CppError(`invalid preprocessing directive #${name}`, t.loc);
        this.#directive(line, ctx);
        continue;
      }

      if (!active()) { i++; continue; }

      // Not a directive. Expansion is NOT line-oriented: a function-like macro name at the end of
      // one line takes its argument list from the next, which the standard's own 6.10.3.5 example
      // relies on (`& mm\n    (ff)`). The unit is therefore a run of tokens delimited by
      // DIRECTIVES, not by newlines. Activity cannot change inside a run, since only a directive
      // changes it.
      const start = i;
      let j = i;
      while (j < tokens.length && tokens[j].k !== EOF) {
        if (tokens[j].bol && tokens[j].k === PUNCT && tokens[j].v === '#') break;
        j++;
      }
      // #process must always advance. It cannot fail to here — a run never starts on a directive —
      // but a hang is the worst way to learn otherwise, as a mis-aimed perturbation of this very
      // line demonstrated by spinning silently instead of reporting anything.
      if (j === start) throw new CppError('internal: preprocessor made no progress', t.loc);
      for (const e of this.#expand(tokens.slice(start, j))) ctx.emit.push(e);
      i = j;
    }

    if (conds.length) throw new CppError('unterminated #if', tokens[tokens.length - 1]?.loc);
  }

  // ------------------------------------------------------------------ directives

  #directive(line, ctx) {
    const name = line[0].v;
    const rest = line.slice(1);
    const loc = line[0].loc;
    switch (name) {
      case 'define': return this.#define(rest, loc);
      case 'undef': {
        if (!rest.length || rest[0].k !== ID) throw new CppError('#undef needs an identifier', loc);
        this.macros.delete(rest[0].v);
        return;
      }
      case 'include': return this.#include(rest, loc, ctx, false);
      case 'include_next': return this.#include(rest, loc, ctx, true);
      case 'error':
        throw new CppError(`#error ${render(rest)}`, loc);
      case 'warning':
        this.diagnostics.push(`${loc?.file}:${loc?.line}: warning: ${render(rest)}`);
        return;
      case 'line': return;                             // line control does not affect tokens
      case 'pragma': return this.#pragma(rest, loc, ctx);
      case 'ident': case 'sccs': case 'assert': case 'unassert': return;
    }
  }

  #pragma(rest, loc, ctx) {
    if (rest.length && rest[0].k === ID && rest[0].v === 'once') {
      if (loc?.file) this.pragmaOnce.add(loc.file);
      return;
    }
    /*
     * push_macro / pop_macro, which are PREPROCESSOR pragmas and must never reach the parser.
     *
     * A stack per name: push saves the current definition, or the fact that there was none, and pop
     * puts it back. The operand is taken from the raw tokens rather than expanded, which c-testsuite
     * 00206 checks directly -- it defines macros CALLED pop_macro and push_macro first, and expects
     * that to change nothing.
     */
    if (rest.length && rest[0].k === ID && (rest[0].v === 'push_macro' || rest[0].v === 'pop_macro')) {
      const str = rest.find(t => t.k === STR);
      const name = str && String(str.v).replace(/^L?"|"$/g, '');
      if (name) {
        const stack = this.macroStacks.get(name) ?? [];
        if (rest[0].v === 'push_macro') {
          stack.push(this.macros.has(name) ? this.macros.get(name) : undefined);
          this.macroStacks.set(name, stack);
        } else if (stack.length) {
          const prev = stack.pop();
          if (prev === undefined) this.macros.delete(name); else this.macros.set(name, prev);
        }
      }
      return;
    }
    // Everything else survives into the output, the way gcc -E passes pragmas through.
    ctx.emit.push(clone(tok(PUNCT, '#', { bol: true }), {}));
    ctx.emit.push(tok(ID, 'pragma', { ws: false }));
    for (const t of rest) ctx.emit.push(clone(t, { bol: false, ws: true }));
  }

  #define(rest, loc) {
    if (!rest.length || rest[0].k !== ID) throw new CppError('#define needs an identifier', loc);
    const name = rest[0].v;
    if (name === 'defined') throw new CppError('cannot #define defined', loc);

    // Function-like ONLY if the '(' touches the name with no whitespace. `#define A (x)` is an
    // object-like macro whose body is `(x)`.
    const isFn = rest.length > 1 && rest[1].k === PUNCT && rest[1].v === '(' && !rest[1].ws;
    if (!isFn) {
      const body = rest.slice(1);
      this.macros.set(name, { name, fn: false, params: null, variadic: false, body: stripEdges(body) });
      return;
    }

    const params = [];
    let variadic = false, gnuNamedVariadic = null;
    let i = 2;
    if (!(rest[i] && rest[i].k === PUNCT && rest[i].v === ')')) {
      for (;;) {
        const t = rest[i];
        if (!t) throw new CppError('unterminated macro parameter list', loc);
        if (t.k === PUNCT && t.v === '...') { variadic = true; i++; break; }
        if (t.k !== ID) throw new CppError(`invalid macro parameter '${t.v}'`, loc);
        // GNU named variadic: `#define E(args...)`
        if (rest[i + 1] && rest[i + 1].k === PUNCT && rest[i + 1].v === '...') {
          gnuNamedVariadic = t.v; variadic = true; i += 2; break;
        }
        if (params.includes(t.v)) throw new CppError(`duplicate macro parameter '${t.v}'`, loc);
        params.push(t.v);
        i++;
        if (rest[i] && rest[i].k === PUNCT && rest[i].v === ',') { i++; continue; }
        break;
      }
    }
    if (!(rest[i] && rest[i].k === PUNCT && rest[i].v === ')')) {
      throw new CppError(`expected ')' in macro parameter list`, loc);
    }
    i++;
    const vaName = gnuNamedVariadic ?? '__VA_ARGS__';
    if (variadic) params.push(vaName);
    const body = stripEdges(rest.slice(i));
    checkBody(body, params, variadic, vaName, loc);
    this.macros.set(name, { name, fn: true, params, variadic, vaName, body });
  }

  #include(rest, loc, ctx, isNext) {
    // The header-name is lexed specially: `<stdio.h>` is ONE token, and `<` `stdio` `.` `h` `>`
    // would be wrong. Re-scan the raw spelling rather than trying to rejoin tokens... except that
    // a computed include (`#include MACRO`) must be expanded first. So: expand, then re-render.
    let ts = rest;
    if (!(ts.length && (ts[0].k === STR || (ts[0].k === PUNCT && ts[0].v === '<')))) {
      ts = this.#expand(rest);
    }
    let name = null, angled = false;
    if (ts.length && ts[0].k === STR) {
      name = ts[0].v.slice(1, -1);
    } else if (ts.length && ts[0].k === PUNCT && ts[0].v === '<') {
      const close = ts.findIndex((t, k) => k > 0 && t.k === PUNCT && t.v === '>');
      if (close < 0) throw new CppError('unterminated #include <...>', loc);
      name = ts.slice(1, close).map(t => (t.ws ? ' ' : '') + t.v).join('').trim();
      angled = true;
    } else {
      throw new CppError('#include expects "FILENAME" or <FILENAME>', loc);
    }

    if (this.includeDepth >= this.maxIncludeDepth) {
      throw new CppError(`#include nested too deeply (${name})`, loc);
    }
    const found = this.resolve(name, angled, loc?.file ?? null, isNext);
    if (!found) throw new CppError(`${name}: No such file or directory`, loc);
    if (this.pragmaOnce.has(found.path)) return;

    this.includeDepth++;
    try { this.#runInto(found.text, found.path, ctx.emit); }
    finally { this.includeDepth--; }
  }

  #evalIf(kind, rest, loc) {
    if (kind === 'ifdef' || kind === 'ifndef') {
      if (!rest.length || rest[0].k !== ID) throw new CppError(`#${kind} needs an identifier`, loc);
      const has = this.macros.has(rest[0].v) || this.dynamic.has(rest[0].v);
      return kind === 'ifdef' ? has : !has;
    }
    if (!rest.length) throw new CppError('#if with no expression', loc);
    // `defined X` must be resolved BEFORE expansion, or expanding would consume the operand.
    const resolved = this.#resolveDefined(rest);
    const expanded = this.#expand(resolved);
    try {
      return evalCondition(expanded, { sizeofs: this.ppSizeof });
    } catch (e) {
      if (e instanceof ExprError) throw new CppError(e.message, loc);
      throw e;
    }
  }

  #resolveDefined(ts) {
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!(t.k === ID && t.v === 'defined')) { out.push(t); continue; }
      let j = i + 1, paren = false;
      if (ts[j] && ts[j].k === PUNCT && ts[j].v === '(') { paren = true; j++; }
      const nameTok = ts[j];
      if (!nameTok || nameTok.k !== ID) throw new CppError('operator "defined" requires an identifier', t.loc);
      j++;
      if (paren) {
        if (!(ts[j] && ts[j].k === PUNCT && ts[j].v === ')')) {
          throw new CppError(`missing ')' after "defined"`, t.loc);
        }
        j++;
      }
      const has = this.macros.has(nameTok.v) || this.dynamic.has(nameTok.v);
      out.push(tok(NUM, has ? '1' : '0', { ws: t.ws, bol: t.bol, loc: t.loc }));
      i = j - 1;
    }
    return out;
  }

  // ------------------------------------------------------------------ expansion

  /** Fully expand a token slice. Rewrites a copy in place and rescans — see the header comment. */
  #expand(input, depth = 0) {
    // The budget is GLOBAL to one top-level expansion, not per call. Argument expansion recurses
    // into #expand, so a per-call guard bounds each level but leaves the total work exponential —
    // measured: with hide sets disabled, a per-call guard of 100k ran for over ten minutes instead
    // of reporting a runaway. Found by sensitivity-checking the gate, not by a failing case.
    if (depth === 0) this.work = 0;
    const ts = input.slice();
    const out = [];
    let i = 0;

    while (i < ts.length) {
      const t = ts[i];
      // Two bounds, because they catch different runaways: a macro that rewrites to itself at
      // constant length spins without growing (iteration bound), while `#define a a b` explodes the
      // work list — and since expansion rewrites in place through splice(), that is quadratic.
      if (++this.work > 400_000) throw new CppError('macro expansion did not terminate', t.loc);
      if (ts.length > 200_000) throw new CppError('macro expansion grew without bound', t.loc);

      if (t.k !== ID || t.noexpand || hsHas(t, t.v)) { out.push(t); i++; continue; }

      const dyn = this.#dynamicMacro(t);
      if (dyn) { ts.splice(i, 1, ...dyn); continue; }

      const m = this.macros.get(t.v);
      if (!m) { out.push(t); i++; continue; }

      if (!m.fn) {
        const hs = hsUnion(t.hs, new Set([m.name]));
        /*
         * The replacement tokens take the INVOCATION's location, not the definition's.
         *
         * `__FILE__` and `__LINE__` inside a macro body must report where the macro was USED --
         * which is the whole point of a `LOG(...)` or `assert(...)` macro living in a header. PRISM
         * reported the header and its line, so every such message named the wrong place; the
         * whole-file cpp gate found it on Doom's am_map.c against gcc.
         *
         * It also makes an error inside an expansion point at the line the user wrote.
         */
        const repl = this.#subst(m, [], hs, false, depth)
          .map(x => clone(x, { hs: hsUnion(x.hs, hs), loc: t.loc }));
        if (repl.length) repl[0] = clone(repl[0], { ws: t.ws, bol: t.bol });
        ts.splice(i, 1, ...repl);
        if (!repl.length && i < ts.length) ts[i] = clone(ts[i], { ws: ts[i].ws || t.ws, bol: ts[i].bol || t.bol });
        continue;
      }

      // Function-like: only an invocation if the very next token is '('.
      const open = i + 1;
      if (!(ts[open] && ts[open].k === PUNCT && ts[open].v === '(')) {
        // Not a call. Mark it so a later rescan does not reconsider it in a different context.
        out.push(t); i++; continue;
      }
      const parsed = parseArgs(ts, open, m, t.loc);
      const closeTok = ts[parsed.end - 1];
      // The hide set of the result: (name's ∩ close-paren's) ∪ {macro}
      const hs = hsUnion(hsIntersect(t.hs, closeTok.hs), new Set([m.name]));
      const repl = this.#subst(m, parsed.args, hs, parsed.varPresent, depth)
        .map(x => clone(x, { hs: hsUnion(x.hs, hs), loc: t.loc }));
      if (repl.length) repl[0] = clone(repl[0], { ws: t.ws, bol: t.bol });
      ts.splice(i, parsed.end - i, ...repl);
      if (!repl.length && i < ts.length) ts[i] = clone(ts[i], { ws: ts[i].ws || t.ws, bol: ts[i].bol || t.bol });
    }
    return out;
  }

  #dynamicMacro(t) {
    switch (t.v) {
      case '__FILE__': return [tok(STR, JSON.stringify(t.loc?.file ?? '<input>'), { ws: t.ws, bol: t.bol, hs: hsAdd(t, t.v).hs })];
      case '__LINE__': return [tok(NUM, String(t.loc?.line ?? 0), { ws: t.ws, bol: t.bol, hs: hsAdd(t, t.v).hs })];
      case '__COUNTER__': return [tok(NUM, String(this.counter++), { ws: t.ws, bol: t.bol, hs: hsAdd(t, t.v).hs })];
    }
    return null;
  }

  /**
   * Substitute arguments into a macro body: handles `#`, `##`, the GNU comma-paste, and expands
   * every other argument use. This is Prosser's `subst`, written as a loop.
   */
  #subst(m, args, hs, varPresent = false, depth = 0) {
    const body = m.body;
    const out = [];
    const paramIndex = (t) => (t.k === ID && m.params ? m.params.indexOf(t.v) : -1);
    const argOf = (idx) => args[idx] ?? [];

    for (let i = 0; i < body.length; i++) {
      const t = body[i];
      const nxt = body[i + 1];

      // `#param` — stringize, no expansion.
      if (t.k === PUNCT && t.v === '#' && nxt && paramIndex(nxt) >= 0) {
        out.push(tok(STR, stringize(argOf(paramIndex(nxt))), { ws: t.ws }));
        i++;
        continue;
      }

      // `x ## y`
      if (nxt && nxt.k === PUNCT && nxt.v === '##') {
        // GNU extension: `, ## __VA_ARGS__` deletes the comma when __VA_ARGS__ is empty.
        const after = body[i + 2];
        const isCommaPaste = t.k === PUNCT && t.v === ',' && after && paramIndex(after) >= 0
          && m.variadic && m.params[paramIndex(after)] === m.vaName;
        if (isCommaPaste) {
          const a = argOf(paramIndex(after));
          // Only an ABSENT variadic list deletes the comma. A present-but-empty one keeps it.
          if (a.length === 0 && !varPresent) { i += 2; continue; }
          if (a.length === 0) { out.push(t); i += 2; continue; }
          out.push(t);
          for (const x of a) out.push(clone(x, { ws: x === a[0] ? true : x.ws }));
          i += 2;
          continue;
        }
      }

      if (t.k === PUNCT && t.v === '##') {
        // A `##` with nothing to its left in the body is invalid and rejected at #define time.
        const rhs = body[i + 1];
        if (!rhs) break;
        const pi = paramIndex(rhs);
        // An empty argument becomes a PLACEMARKER, not nothing. Dropping it instead lets the `##`
        // reach the token before the parameter and paste THAT — which is how `zz p0 ## p1` with an
        // empty p0 produced `zzbb`. The hand-written `A3(,y,)` case missed this because `out` was
        // empty there, so the bug was invisible until the generator put a token in front.
        const rhsToks = pi >= 0 ? (argOf(pi).length ? argOf(pi) : [PM]) : [rhs];
        const last = out.length ? out.pop() : PM;
        if (last.k === PMK && rhsToks[0].k === PMK) out.push(PM);
        else if (last.k === PMK) for (const x of rhsToks) out.push(x);
        else if (rhsToks[0].k === PMK) { out.push(last); for (const x of rhsToks.slice(1)) out.push(x); }
        else {
          out.push(clone(paste(last, rhsToks[0], t.loc), { ws: last.ws }));
          for (const x of rhsToks.slice(1)) out.push(x);
        }
        i++;
        continue;
      }

      const pi = paramIndex(t);
      if (pi >= 0) {
        // A parameter adjacent to a `##` on the RIGHT is substituted UNEXPANDED — handled above
        // when we reach the `##`. Here we must not expand it either, so look ahead.
        if (nxt && nxt.k === PUNCT && nxt.v === '##') {
          const a = argOf(pi);
          if (a.length === 0) { out.push(PM); continue; }        // placemarker, see the `##` branch
          for (let k = 0; k < a.length; k++) {
            out.push(clone(a[k], k === 0 ? { ws: t.ws } : {}));
          }
          continue;
        }
        const a = this.#expand(argOf(pi).map(x => clone(x)), depth + 1);
        if (a.length === 0) continue;
        for (let k = 0; k < a.length; k++) out.push(clone(a[k], k === 0 ? { ws: t.ws, bol: false } : { bol: false }));
        continue;
      }

      out.push(t);
    }
    return out.filter(x => x.k !== PMK);
  }
}

// ------------------------------------------------------------------ helpers

function stripEdges(ts) {
  const out = ts.slice();
  if (out.length) out[0] = clone(out[0], { ws: false, bol: false });
  return out;
}

/** `##` may not begin or end a replacement list; `#` must be followed by a parameter. */
function checkBody(body, params, variadic, vaName, loc) {
  if (body.length && body[0].k === PUNCT && body[0].v === '##') {
    throw new CppError("'##' cannot appear at the start of a macro expansion", loc);
  }
  if (body.length && body[body.length - 1].k === PUNCT && body[body.length - 1].v === '##') {
    throw new CppError("'##' cannot appear at the end of a macro expansion", loc);
  }
  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    if (t.k === PUNCT && t.v === '#' && params) {
      const n = body[i + 1];
      if (!n || n.k !== ID || !params.includes(n.v)) {
        throw new CppError("'#' is not followed by a macro parameter", loc);
      }
    }
    if (t.k === ID && t.v === '__VA_ARGS__' && !(variadic && vaName === '__VA_ARGS__')) {
      throw new CppError('__VA_ARGS__ can only appear in a variadic macro', loc);
    }
  }
}

/** Split a function-like macro's actual arguments. `open` indexes the '('. */
function parseArgs(ts, open, m, loc) {
  const args = [];
  let cur = [];
  let depth = 0, closed = false;
  let i = open;
  const nparams = m.params.length;
  const fixed = m.variadic ? nparams - 1 : nparams;

  for (; i < ts.length; i++) {
    const t = ts[i];
    if (t.k === EOF) throw new CppError(`unterminated argument list invoking macro '${m.name}'`, loc);
    if (t.k === PUNCT && t.v === '(') { depth++; if (depth === 1) continue; }
    else if (t.k === PUNCT && t.v === ')') {
      depth--;
      if (depth === 0) { args.push(cur); closed = true; i++; break; }
    } else if (t.k === PUNCT && t.v === ',' && depth === 1) {
      // Inside the variadic tail, commas are part of the argument.
      if (!(m.variadic && args.length >= fixed)) { args.push(cur); cur = []; continue; }
    }
    cur.push(t);
  }

  // The slice handed to #expand stops before the EOF token, so running off its end is how an
  // unclosed argument list at end of file presents itself — silently, until this check.
  if (!closed) throw new CppError(`unterminated argument list invoking macro '${m.name}'`, loc);

  // `F()` on a one-parameter macro passes one empty argument, not zero.
  if (args.length === 1 && args[0].length === 0 && nparams === 0) args.length = 0;

  // `F(a)` and `F(a, )` both leave __VA_ARGS__ empty, but they are NOT the same to the GNU
  // comma-paste: the first deletes the comma, the second keeps it. Record the difference before
  // padding below destroys it.
  const varPresent = m.variadic && args.length > fixed;

  if (m.variadic) {
    if (args.length < fixed) throw new CppError(`macro '${m.name}' requires at least ${fixed} arguments`, loc);
    while (args.length < nparams) args.push([]);
  } else if (args.length !== nparams) {
    throw new CppError(
      `macro '${m.name}' passed ${args.length} arguments, but takes ${nparams}`, loc);
  }
  return { args: args.map(a => trimWs(a)), end: i, varPresent };
}

const trimWs = (a) => (a.length ? [clone(a[0], { ws: false, bol: false }), ...a.slice(1).map(x => clone(x, { bol: false }))] : a);

/** `#x` — the spelling of the argument, with `\` and `"` escaped inside literals. */
function stringize(ts) {
  let s = '';
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (i > 0 && t.ws) s += ' ';
    const raw = t.raw ?? t.v;
    s += (t.k === STR || t.k === CHR) ? raw.replace(/([\\"])/g, '\\$1') : raw;
  }
  return `"${s}"`;
}

/** `a ## b` — concatenate the spellings and re-lex; the result must be exactly one pp-token. */
function paste(a, b, loc) {
  const text = (a.raw ?? a.v) + (b.raw ?? b.v);
  const { tokens } = lex(text, { file: a.loc?.file ?? '<paste>', keepNewlines: false });
  const real = tokens.filter(t => t.k !== EOF);
  if (real.length !== 1) {
    throw new CppError(`pasting "${a.v}" and "${b.v}" does not give a valid preprocessing token`, loc ?? a.loc);
  }
  return clone(real[0], { hs: hsIntersect(a.hs, b.hs), loc: a.loc });
}

export { render };
