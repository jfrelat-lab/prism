// structure.js — gotos as JavaScript's own labelled statements, where their shape allows it.
//
// flatten.js makes any label reachable by turning the whole function into one `for(;;) switch(_pc)`
// state machine. That is exact, and for a big function it is ruinous: DOSBox's CPU core, a loop
// around a 256-way switch with `goto restart_opcode`, `goto illegal_opcode` and `goto decode_end`
// in it, came out as a 1.1 MB function V8 never optimises -- the emulator's interpreter ran inside
// V8's interpreter. Most gotos are not that general. This pass rewrites the three shapes structured
// code is made of, and gives up (the caller then flattens) on anything else:
//
//   forward, to a label later in the same statement list: the statements from the first goto's
//   up to the label are wrapped in a labelled block, and the goto is `break L` --
//       L: { ... goto ... }  label-statement
//   backward, to a label earlier in the same list (or the label's own statement): the statements
//   from the label to the last goto's are wrapped in a loop that runs once, and the goto is
//   `continue L` --
//       L: for (;;) { label-statement ... goto ... ; break; }
//   into a switch, to a label among the switch body's statements (`default: illegal_opcode:`): a
//   case only the jump can select is put there, and the goto re-enters the switch with it --
//       L: for (;;) { switch (_rd !== null ? _rd : disc) { ... case "L": ... } break; }
//
// Every goto must lie inside the list that holds its label: a jump INTO a block is not structured.
// The wrapped ranges of one list must nest. The loops this adds would catch a C `break` or
// `continue` meant for an enclosing loop or switch, so those are labelled with their real target.
//
// The result uses three node kinds the emitter knows: `lwrap` (a labelled block or once-loop),
// `jump` (break/continue to a JS label, `redispatch` to re-enter a switch), and `case` with a
// `sentinel` instead of a value; and `jsLabel` on loops and switches a break/continue names.

let seq = 0;
const fresh = (hint) => `_s${seq++}_${hint.replace(/\W/g, '_')}`;

const STOP = Symbol('not structured');
const giveUp = () => { throw STOP; };

/** The rewritten body, or null when its gotos are not of the shapes above. */
export function structureGotos(body) {
  try { return structure(body); } catch (e) { if (e === STOP) return null; throw e; }
}

// Statement fields that hold statements: everything else (conditions, initialisers) is expression.
const isList = (s) => s && (s.n === 'block');
const subStatements = (s) => {
  switch (s.n) {
    case 'block': return s.items;
    case 'if': return [s.then, s.els].filter(Boolean);
    case 'while': case 'do': case 'for': case 'switch': return [s.body];
    case 'label': case 'case': case 'default': return [s.body];
    default: return [];
  }
};

function structure(body) {
  /*
   * 1. Where each label is: the list (a block's items) that holds it and its index there, and
   *    whether that list is a switch's body. A label anywhere else -- `if (c) L: s;` -- gives up.
   */
  const labels = new Map();             // name -> { list, k, sw }
  const switchBodies = new WeakSet();
  const findLabels = (s, list, k, sw) => {
    if (!s || typeof s !== 'object') return;
    if (s.n === 'label') {
      if (!list) giveUp();
      if (labels.has(s.name)) giveUp();
      labels.set(s.name, { list, k, sw });
      findLabels(s.body, list, k, sw);  // `A: B: stmt` -- both at this place
      return;
    }
    if ((s.n === 'case' || s.n === 'default') && list && sw) { findLabels(s.body, list, k, sw); return; }
    if (isList(s)) {
      const inSwitch = switchBodies.has(s);
      s.items.forEach((it, i) => findLabels(it, s.items, i, inSwitch));
      return;
    }
    if (s.n === 'switch' && s.body?.n === 'block') {
      switchBodies.add(s.body);
      findLabels(s.body, null, 0, false);
      return;
    }
    for (const c of subStatements(s)) findLabels(c, null, 0, false);
  };
  findLabels(body, null, 0, false);
  if (!labels.size) return null;

  /*
   * 2. Each goto, with the chain of lists it sits in: the label's list must be one of them, and
   *    the goto's index there (the item that contains it) says forward or backward.
   */
  const plan = new Map();               // list -> [{ name, k, fwd: [j...], bwd: [j...], sw }]
  const entry = (name) => {
    const l = labels.get(name);
    let arr = plan.get(l.list);
    if (!arr) plan.set(l.list, arr = []);
    let e = arr.find((x) => x.name === name);
    if (!e) arr.push(e = { name, k: l.k, sw: l.sw, fwd: [], bwd: [] });
    return e;
  };
  const findGotos = (s, chain) => {
    if (!s || typeof s !== 'object') return;
    if (s.n === 'gotoexpr' || s.n === 'labeladdr') giveUp();
    if (s.n === 'goto') {
      const l = labels.get(s.label);
      if (!l) giveUp();
      const at = chain.find((c) => c.list === l.list);
      if (!at) giveUp();                 // a jump into a block
      const e = entry(s.label);
      if (!l.sw) (at.i < l.k ? e.fwd : e.bwd).push(at.i);
      return;
    }
    if (isList(s)) { s.items.forEach((it, i) => findGotos(it, [...chain, { list: s.items, i }])); return; }
    for (const c of subStatements(s)) findGotos(c, chain);
  };
  findGotos(body, []);

  /*
   * 3. The ranges each list wraps, which must nest. A label no goto reaches needs none.
   */
  const ranges = new Map();             // list -> [{ s, e, kind, label, name }]
  const jumps = new Map();              // label name -> { kind: 'break'|'continue'|'redispatch', js }
  for (const [list, arr] of plan) {
    const rs = [];
    for (const e of arr) {
      if (e.sw) { jumps.set(e.name, { kind: 'redispatch', js: fresh(e.name) }); continue; }
      if (e.fwd.length && e.bwd.length) {
        // Both: `L: for(;;) {...}` for the backward ones, and the forward ones break to just before it.
        const fl = fresh(`${e.name}_f`), bl = fresh(`${e.name}_b`);
        rs.push({ s: Math.min(...e.fwd), e: e.k, kind: 'block', label: fl });
        rs.push({ s: e.k, e: Math.max(...e.bwd) + 1, kind: 'loop', label: bl });
        jumps.set(e.name, { kind: 'both', fwdJs: fl, bwdJs: bl, k: e.k });
      } else if (e.fwd.length) {
        const fl = fresh(e.name);
        rs.push({ s: Math.min(...e.fwd), e: e.k, kind: 'block', label: fl });
        jumps.set(e.name, { kind: 'break', js: fl });
      } else if (e.bwd.length) {
        const bl = fresh(e.name);
        rs.push({ s: e.k, e: Math.max(...e.bwd) + 1, kind: 'loop', label: bl });
        jumps.set(e.name, { kind: 'continue', js: bl });
      }
    }
    for (const a of rs) for (const b of rs) {
      if (a === b) continue;
      const disjoint = a.e <= b.s || b.e <= a.s;
      const inside = (a.s >= b.s && a.e <= b.e) || (b.s >= a.s && b.e <= a.e);
      if (!disjoint && !inside) giveUp();
    }
    ranges.set(list, rs);
  }

  /*
   * 4. Rebuild. `targets` is the stack of what a C break/continue can mean (loops and switches)
   *    and of the loops this pass added; a break or continue with an added loop between it and its
   *    target names the target.
   */
  const targets = [];
  const labelFor = (t) => (t.node.jsLabel ??= fresh('loop'));
  const rebuildJumpOut = (s) => {
    const want = s.n === 'continue' ? (t) => t.loop : (t) => t.loop || t.sw;
    let crossed = false;
    for (let i = targets.length - 1; i >= 0; i--) {
      const t = targets[i];
      if (t.added) { crossed = true; continue; }
      if (!want(t)) continue;
      return crossed ? { ...s, label: labelFor(t) } : s;
    }
    return s;
  };
  const redispatchOf = new Map();       // switch node -> { loop, var }
  const switchOfLabel = new Map();      // label name -> its switch's redispatch record

  const rebuild = (s, curSwitch) => {
    if (!s || typeof s !== 'object') return s;
    switch (s.n) {
      case 'goto': {
        const j = jumps.get(s.label);
        if (j.kind === 'redispatch') {
          const r = switchOfLabel.get(s.label);
          if (!r) giveUp();              // not inside its switch
          return { n: 'jump', kind: 'redispatch', label: r.loop, rdVar: r.var, value: j.js, back: true };
        }
        if (j.kind === 'both') {
          // Which one this goto is was decided by its position; recomputing it needs the index, so
          // both kinds carry it: the emitter-facing node is chosen when the list is rebuilt.
          return { n: 'jump', kind: 'pending', name: s.label };
        }
        return { n: 'jump', kind: j.kind, label: j.js, back: j.kind === 'continue' };
      }
      case 'break': case 'continue': return rebuildJumpOut(s);
      case 'label': return rebuild(s.body, curSwitch);
      case 'block': return { ...s, items: rebuildList(s.items, curSwitch) };
      case 'if': return { ...s, then: rebuild(s.then, curSwitch), els: s.els ? rebuild(s.els, curSwitch) : s.els };
      case 'while': case 'do': case 'for': {
        const node = { ...s };
        targets.push({ node, loop: true });
        try { node.body = rebuild(s.body, null); } finally { targets.pop(); }
        return node;
      }
      case 'switch': {
        const node = { ...s };
        // Labels among this switch's statements make it re-enterable.
        const names = [...labels].filter(([, l]) => l.sw && s.body?.n === 'block' && l.list === s.body.items).map(([n]) => n);
        let r = null;
        if (names.some((n) => jumps.has(n))) {
          r = { loop: fresh('redispatch'), var: fresh('rd') };
          node.redispatch = r;
          for (const n of names) switchOfLabel.set(n, r);
          targets.push({ node: { jsLabel: r.loop }, added: true, loop: true });
        }
        targets.push({ node, sw: true });
        try { node.body = rebuild(s.body, node); } finally { targets.pop(); if (r) targets.pop(); }
        for (const n of names) switchOfLabel.delete(n);
        return node;
      }
      case 'case': case 'default': return { ...s, body: rebuild(s.body, curSwitch) };
      default: return s;
    }
  };

  // The goto nodes of a label reached both ways are resolved by their index in the label's list.
  // Statements only: expressions hold no goto (a statement expression with one is refused upstream).
  const anyBoth = [...jumps.values()].some((j) => j.kind === 'both');
  const resolvePending = (node, list, i) => {
    if (!anyBoth) return node;
    const fix = (s) => {
      if (!s || typeof s !== 'object') return s;
      switch (s.n) {
        case 'jump': {
          if (s.kind !== 'pending' || labels.get(s.name).list !== list) return s;
          const j = jumps.get(s.name);
          return i < j.k ? { n: 'jump', kind: 'break', label: j.fwdJs } : { n: 'jump', kind: 'continue', label: j.bwdJs, back: true };
        }
        case 'block': return { ...s, items: s.items.map(fix) };
        case 'lwrap': return { ...s, items: s.items.map(fix) };
        case 'if': return { ...s, then: fix(s.then), els: s.els ? fix(s.els) : s.els };
        case 'while': case 'do': case 'for': case 'switch': case 'case': case 'default': return { ...s, body: fix(s.body) };
        default: return s;
      }
    };
    return fix(node);
  };

  const rebuildList = (items, curSwitch) => {
    const rs = ranges.get(items) ?? [];
    const sentinels = [...labels].filter(([n, l]) => l.list === items && l.sw && jumps.get(n)?.kind === 'redispatch');
    // Each item rebuilt with the added loops that will enclose it on the target stack.
    const built = [];
    for (let i = 0; i < items.length; i++) {
      const around = rs.filter((r) => r.kind === 'loop' && r.s <= i && i < r.e);
      for (const r of around) targets.push({ node: { jsLabel: r.label }, added: true, loop: true });
      let it;
      try { it = rebuild(items[i], curSwitch); } finally { for (let q = 0; q < around.length; q++) targets.pop(); }
      it = resolvePending(it, items, i);
      // A switch label: a case only its gotos select, at the label's place.
      const here = sentinels.filter(([, l]) => l.k === i).map(([n]) => n);
      if (here.length) {
        // A case of its own just before the label's item, with nothing in it: the jump lands there and
        // falls into what follows -- `case "L": default: stmt` for `default: L: stmt`.
        for (const n of here) built.push({ n: 'case', sentinel: jumps.get(n).js, body: { n: 'empty' } });
        built.push(it);
      } else built.push(it);
    }
    if (!rs.length) return built;
    // Nest the ranges: outermost (longest) first among those starting at the same place.
    const wrap = (lo, hi, avail) => {
      const out = [];
      for (let i = lo; i < hi;) {
        const r = avail.filter((x) => x.s === i && x.e <= hi).sort((a, b) => b.e - a.e)[0];
        if (!r) { out.push(built[i]); i++; continue; }
        const rest = avail.filter((x) => x !== r);
        out.push({ n: 'lwrap', kind: r.kind, label: r.label, items: wrap(r.s, r.e, rest) });
        i = r.e;
      }
      return out;
    };
    return wrap(0, built.length, rs);
  };

  return rebuild(body, null);
}
