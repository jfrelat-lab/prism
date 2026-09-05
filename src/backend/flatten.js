// flatten.js — lower structured control flow to labels and gotos, so a label may live anywhere.
//
// tier-0 emits `goto` as a state machine over the function's TOP-LEVEL statements: a labelled
// `for(;;) switch(_pc)` where a jump sets _pc and continues. That is exact and it is fast, but it can
// only see labels at the top level — and 1990s C puts them inside loops. Quake's edge sorter is the
// canonical case:
//
//     do {
//         next_edge = edgestoadd->next;
//     edgesearch:
//         if (edgelist->u >= edgestoadd->u) goto addedge;
//         edgelist = edgelist->next;
//         ...
//         goto edgesearch;
//     addedge:
//         ...
//     } while ((edgestoadd = next_edge) != NULL);
//
// Rather than teach the state machine about nesting, this pass makes the nesting go away: every
// construct that could contain a label is rewritten into the `if`/`goto` form it is defined as, until
// the whole body is one flat list. The existing machinery then handles it unchanged.
//
// It runs ONLY on functions that need it. A function whose labels are already at the top level — or
// which has none — keeps its structured emission, which matters for both readability and speed: a
// `while` loop is a `while` loop in the output, not a dispatch table.
//
// The lowerings are the textbook ones, and they are exact:
//
//     if (c) A else B     ->  if (!c) goto Lelse; A; goto Lend; Lelse: B; Lend:
//     while (c) B         ->  Ltop: if (!c) goto Lbrk; B; goto Ltop; Lbrk:
//     do B while (c)      ->  Ltop: B; Lcont: if (c) goto Ltop; Lbrk:
//     for (i;c;s) B       ->  i; Ltop: if (!c) goto Lbrk; B; Lcont: s; goto Ltop; Lbrk:
//     switch (e) {...}    ->  t = e; if (t==k1) goto L1; ... goto Ldef|Lbrk; L1: ... Lbrk:
//
// with `break` and `continue` becoming gotos to the enclosing Lbrk / Lcont.

import * as T from '../sema/types.js';

let seq = 0;
const fresh = (hint) => `_L${seq++}_${hint}`;

/**
 * Does a label appear anywhere below the top level -- or a `case` somewhere a JavaScript switch
 * cannot put one?
 *
 * C lets a `case` label ANY statement inside the switch body, including one nested in an `if`, which
 * is what makes Duff's device legal. libbenly's file.c:120 writes exactly that:
 *
 *     case -3:  if (buf != NULL)
 *     case -2:  if (tmp != NULL) free(tmp);
 *
 * JavaScript requires case clauses to be direct children of the switch block, so emitting that
 * literally produces source the engine will not parse. This pass already lowers a switch to a
 * dispatch over labels and gotos, where the nesting stops mattering -- so a nested case is simply
 * another reason to run it.
 */
/** A `case`/`default` that is not a direct child of a switch body. A nested switch owns its own. */
function nestedCase(body) {
  const direct = body?.n === 'block' ? (body.items ?? []) : [body];
  const find = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (node.n === 'case' || node.n === 'default') return true;
    if (node.n === 'switch') return false;
    for (const k of ['body', 'then', 'els', 'items']) {
      const v = node[k];
      if (Array.isArray(v)) { if (v.some(find)) return true; }
      else if (v && typeof v === 'object' && find(v)) return true;
    }
    return false;
  };
  return direct.some(st => ((st?.n === 'case' || st?.n === 'default') ? find(st.body) : find(st)));
}

export function needsFlattening(body) {
  let nested = false;
  const scan = (s, top) => {
    if (!s || typeof s !== 'object') return;
    switch (s.n) {
      case 'label':
        if (!top) { nested = true; return; }
        scan(s.body, top);
        return;
      case 'block':
        for (const it of s.items) scan(it, false);
        return;
      case 'if': scan(s.then, false); scan(s.els, false); return;
      case 'while': case 'do': scan(s.body, false); return;
      case 'for': scan(s.body, false); return;
      case 'switch':
        // Inside a switch, a case that is not a DIRECT child of the body is one JavaScript cannot
        // express. The body's own statement list is direct; anything below it is not.
        if (nestedCase(s.body)) { nested = true; return; }
        scan(s.body, false);
        return;
      case 'case': case 'default': scan(s.body, false); return;
      default: return;
    }
  };
  for (const it of body.items) scan(it, true);
  return nested;
}

/**
 * Rewrite a function body so every label sits at the top level.
 *
 * `unsup` is the emitter's own refusal, used for the cases this pass will not guess at: a `switch`
 * whose discriminant needs a temporary the emitter would have to allocate, and a name declared twice
 * in sibling blocks that would collide once both are hoisted to function scope.
 */
export function flattenGotos(body, { unsup, newTemp }) {
  const out = [];
  const declared = new Map();          // name -> the declaration it came from, to catch collisions
  /*
   * Where each `case` label goes, and which ones have been placed.
   *
   * They are needed because a case label does not have to sit at the top of the switch body. In
   * Duff's device it sits INSIDE the loop the switch opens:
   *
   *     switch (count % 8) {
   *     case 0: do {    *dest-- = table[*src--];
   *     case 7:         *dest-- = table[*src--];
   *             } while (--n > 0);
   *     }
   *
   * `collectCases` already looked inside loops -- it had to, or the dispatch would have no arm for
   * `case 7` -- but `walkSwitchBody` only descended through blocks, so it handed the loop to the
   * ordinary walker, whose case/default branch assumed the label had been placed already. It had
   * not. The dispatch jumped to `_L625_case` and nothing ever defined it, which the emitter reported
   * as a goto into a nested block. Quake's vid_x.c is where it showed up.
   */
  const caseName = new Map();          // case/default node -> its dispatch label
  const placedCase = new Set();        // ...and the ones already emitted

  const emit = (s) => out.push(s);
  const label = (name) => emit({ n: 'label', name, body: { n: 'empty' } });
  const goto_ = (name) => emit({ n: 'goto', label: name });
  const jumpIfNot = (cond, name) => emit({
    n: 'if',
    cond: { n: 'unary', op: '!', expr: cond, type: T.INT },
    then: { n: 'goto', label: name },
    els: null,
  });
  const jumpIf = (cond, name) => emit({ n: 'if', cond, then: { n: 'goto', label: name }, els: null });

  /** `brk`/`cont` are the enclosing loop's or switch's targets, or null where the keyword is illegal. */
  function walk(s, brk, cont) {
    if (!s) return;
    switch (s.n) {
      case 'empty': return;

      case 'block':
        for (const it of s.items) walk(it, brk, cont);
        return;

      case 'decls':
        /*
         * Hoisting a nested declaration to function scope used to be refused when two of them shared
         * a name, because the emitter keyed its locals by name and named its JS variables after the
         * C ones -- so sibling `int i`s would have shared one variable, and sibling `static int i`s
         * one symbol. Both are now distinct per declaration (FunctionEmitter's `#uniq`), and the
         * flattened statement order is the program order, so a use between two declarations still
         * sees the one that precedes it. gate-run's `shadowed-locals` is the case that says so.
         */
        emit(s);
        return;

      case 'label':
        // The label itself becomes a top-level marker; whatever it labelled follows it.
        label(s.name);
        walk(s.body, brk, cont);
        return;

      case 'if': {
        if (!s.els) {
          const end = fresh('endif');
          jumpIfNot(s.cond, end);
          walk(s.then, brk, cont);
          label(end);
          return;
        }
        const els = fresh('else'), end = fresh('endif');
        jumpIfNot(s.cond, els);
        walk(s.then, brk, cont);
        goto_(end);
        label(els);
        walk(s.els, brk, cont);
        label(end);
        return;
      }

      case 'while': {
        const top = fresh('while'), out_ = fresh('endwhile');
        label(top);
        jumpIfNot(s.cond, out_);
        walk(s.body, out_, top);
        goto_(top);
        label(out_);
        return;
      }

      case 'do': {
        const top = fresh('do'), cnt = fresh('docont'), out_ = fresh('enddo');
        label(top);
        walk(s.body, out_, cnt);
        label(cnt);
        jumpIf(s.cond, top);
        label(out_);
        return;
      }

      case 'for': {
        const top = fresh('for'), cnt = fresh('forcont'), out_ = fresh('endfor');
        if (s.init) walk(s.init, brk, cont);
        label(top);
        // A `for` with no condition loops for ever; there is nothing to test.
        if (s.cond) jumpIfNot(s.cond, out_);
        walk(s.body, out_, cnt);
        label(cnt);
        if (s.step) emit({ n: 'exprstmt', expr: s.step });
        goto_(top);
        label(out_);
        return;
      }

      case 'switch': {
        /*
         * Lowered to a dispatch chain, because a JS `switch` cannot be entered by a goto and a label
         * inside one must be reachable both ways. The discriminant goes through a temporary: it is
         * evaluated exactly once, which is what C says, and the chain then compares against it.
         */
        const out_ = fresh('endswitch');
        const tmp = newTemp(s.disc);
        emit(tmp.decl);

        const arms = [];
        collectCases(s.body, arms);
        for (const a of arms) {
          if (a.kind === 'default') continue;
          for (let v = a.lo; v <= (a.hi ?? a.lo); v++) {
            // BigInt, because that is what the parser produces for a numeric literal and the
            // emitter masks it with BigInt.asIntN. A plain Number threw "Cannot convert 1 to a
            // BigInt" from inside the emitter, far from here.
            jumpIf({ n: 'bin', op: '==', a: tmp.ref, b: { n: 'num', value: BigInt(v), type: T.INT }, type: T.INT },
              a.name);
          }
        }
        const dflt = arms.find(a => a.kind === 'default');
        goto_(dflt ? dflt.name : out_);

        walkSwitchBody(s.body, arms, out_, cont);
        label(out_);
        return;
      }

      case 'case': case 'default': {
        /*
         * Usually walkSwitchBody has already placed this label. It has not when the case sits inside
         * a loop or an `if` within the switch body -- Duff's device -- because the loop is lowered by
         * this walker, not by that one. Place it here, at the point the statement actually occupies,
         * which is what makes a jump into the middle of the loop body land where C says it does.
         */
        const name = caseName.get(s);
        if (name && !placedCase.has(s)) { label(name); placedCase.add(s); }
        walk(s.body, brk, cont);
        return;
      }

      case 'break':
        if (!brk) unsup('a break outside any loop or switch, while flattening');
        goto_(brk);
        return;

      case 'continue':
        if (!cont) unsup('a continue outside any loop, while flattening');
        goto_(cont);
        return;

      default:
        emit(s);
        return;
    }
  }

  /** Give every case and default in a switch body a label name, in source order. */
  function collectCases(s, arms) {
    if (!s) return;
    if (s.n === 'block') { for (const it of s.items) collectCases(it, arms); return; }
    if (s.n === 'case') {
      const name = fresh('case');
      arms.push({ kind: 'case', lo: Number(s.lo), hi: s.hi === null || s.hi === undefined ? null : Number(s.hi), name, node: s });
      caseName.set(s, name);
      collectCases(s.body, arms);
      return;
    }
    if (s.n === 'default') {
      const name = fresh('default');
      arms.push({ kind: 'default', name, node: s });
      caseName.set(s, name);
      collectCases(s.body, arms);
      return;
    }
    // A nested switch has its own arms; do not steal them.
    if (s.n === 'switch') return;
    if (s.n === 'if') { collectCases(s.then, arms); collectCases(s.els, arms); return; }
    if (s.n === 'while' || s.n === 'do' || s.n === 'for') { collectCases(s.body, arms); return; }
    if (s.n === 'label') { collectCases(s.body, arms); return; }
  }

  function walkSwitchBody(s, arms, brk, cont) {
    if (!s) return;
    if (s.n === 'block') { for (const it of s.items) walkSwitchBody(it, arms, brk, cont); return; }
    if (s.n === 'case' || s.n === 'default') {
      const arm = arms.find(a => a.node === s);
      label(arm.name);
      placedCase.add(s);
      walkSwitchBody(s.body, arms, brk, cont);
      return;
    }
    walk(s, brk, cont);
  }

  for (const it of body.items) walk(it, null, null);
  return { n: 'block', items: out };
}
