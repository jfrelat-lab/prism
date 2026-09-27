// tasm.js — a front end for Turbo Assembler source, as Keen Dreams' .ASM files are written.
//
// It reads the source the way TASM 2.x does and produces a MODULE: the data segment as bytes (with
// the positions that hold addresses), the code segment as an ordered stream of labels, instructions
// and data, the procedures with their arguments, and the public and external names. It does not
// encode instructions: the code segment is tokens, and src/asm/tasm16.js gives each one the offset
// and length TASM gives it, then translates it.
//
// COVERED, because Keen's four files use it, and nothing beyond it: IDEAL and MASM modes; INCLUDE;
// `=` and EQU, numeric and textual; IF/IFE/IFDEF/IFNDEF/ELSE/ENDIF; FARDATA and SEG; the .8086-.486 processor directives; MACRO/ENDM in both spellings, with
// parameters; REPT; @@ local labels; MODEL; DATASEG/CODESEG; ASSUME (stamped on each instruction: it decides TASM's override prefixes); PROC/ENDP
// with named arguments and USES, whose prologue and epilogue are generated as TASM generates them
// (PUSH BP / MOV BP,SP / PUSH uses ... POP uses / POP BP / RET); DB/DW/DD with DUP, `?`, strings and
// label references; STRUC/ENDS and instances; LABEL; EVEN; PUBLIC; EXTRN. Anything else is REFUSED
// BY NAME, with its file and line.
//
// The oracle is the real Turbo Assembler (the Borland C++ 2.0 floppies carry TASM 2.5): its object
// files and listings are what tools/gate-tasm-front.mjs compares this module against.

export class TasmError extends Error {}

const KEYWORD_REGS = new Set(['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'al', 'ah', 'bl', 'bh', 'cl', 'ch',
  'dl', 'dh', 'cs', 'ds', 'es', 'ss']);

/** Tokens of one line: { k: 'id'|'num'|'str'|'p', v, text }. A `;` ends the line. */
function tokenize(line, where) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ';') break;
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_@?$]/.test(c)) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_@?$]/.test(line[j])) j++;
      out.push({ k: 'id', v: line.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < line.length && /[0-9A-Za-z]/.test(line[j])) j++;
      out.push({ k: 'num', v: line.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= line.length) throw new TasmError(`${where}: unterminated string`);
        if (line[j] === c) { if (line[j + 1] === c) { s += c; j += 2; continue; } break; }
        s += line[j++];
      }
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (c === '<' && line[i + 1] === '>') { out.push({ k: 'punct', v: '<>' }); i += 2; continue; }
    out.push({ k: 'punct', v: c });
    i++;
  }
  return out;
}

/** A number as TASM writes it: 0ffh, 1010b, 17, 0x? no -- MASM has no 0x. */
export function tasmNumber(v, where = '') {
  const t = v.toLowerCase();
  let m;
  if ((m = /^([0-9][0-9a-f]*)h$/.exec(t))) return parseInt(m[1], 16);
  if ((m = /^([01]+)b$/.exec(t))) return parseInt(m[1], 2);
  if ((m = /^([0-7]+)[oq]$/.exec(t))) return parseInt(m[1], 8);
  if ((m = /^([0-9]+)d?$/.exec(t))) return parseInt(m[1], 10);
  throw new TasmError(`${where}: the number '${v}'`);
}

const lc = (t) => (t && t.k === 'id' ? t.v.toLowerCase() : null);
const isP = (t, v) => t && t.k === 'punct' && t.v === v;

/**
 * Assemble one file (and what it INCLUDEs). `read(name)` returns a file's text or null; names are
 * looked up case-insensitively by the caller.
 */
export function assembleTasm(file, { read }) {
  const mod = {
    file,
    model: null,
    mode: 'masm',
    publics: new Set(),
    externs: new Map(),               // name -> type (WORD, BYTE, DWORD, PROC, ...)
    equates: new Map(),               // lowercased name -> number
    textEquates: new Map(),           // lowercased name -> tokens (MASM text substitution)
    structs: new Map(),               // lowercased name -> { size, fields: Map(name -> {offset, size, bytes}) }
    data: { bytes: [], labels: new Map(), fixups: [] },     // DATASEG, in DGROUP
    fardata: { bytes: [], labels: new Map(), fixups: [] },  // FARDATA: a segment of its own, reached by SEG
    code: { items: [], labels: new Map(), bytes: [], fixups: [] }, // CODESEG: stream + its data area
    procs: [],
    cpu: 86,                          // the processor directive in force (.386C: 386); TASM sizes jumps by it
    // What each segment register is assumed to hold: 'code', 'data' (DGROUP) or null. An instruction
    // carries the assumptions in force where it stands, because they decide TASM's override prefixes.
    assume: {},
  };
  const macros = new Map();           // lowercased name -> { params: [], body: [lines] }
  let seg = null;                     // 'data' | 'code' | 'fardata'
  let proc = null;                    // the PROC being assembled
  let localScope = 0;
  let curStruct = null;

  const fail = (where, what) => { throw new TasmError(`${where}: ${what}`); };
  const segOf = (s) => (s === 'code' ? mod.code : s === 'fardata' ? mod.fardata : mod.data);

  // ---------------------------------------------------------------- expressions
  /** Evaluate tokens as a constant. Returns { value, sym } where sym is a relocated label (or null). */
  const evaluate = (toks, where) => {
    let i = 0;
    const peek = () => toks[i];
    const primary = () => {
      const t = toks[i++];
      if (!t) fail(where, 'an expression that ends too soon');
      if (isP(t, '(')) { const v = expr(); if (!isP(toks[i++], ')')) fail(where, 'an unclosed parenthesis'); return v; }
      if (isP(t, '-')) { const v = primary(); if (v.sym) fail(where, 'negating an address'); return { value: -v.value, sym: null }; }
      if (isP(t, '+')) return primary();
      if (t.k === 'num') return { value: tasmNumber(t.v, where), sym: null };
      if (t.k === 'str' && t.v.length <= 2) {
        return { value: [...t.v].reduce((a, ch) => (a << 8) | ch.charCodeAt(0), 0), sym: null };
      }
      if (t.k === 'id') {
        const n = t.v.toLowerCase();
        if (n === 'not') { const v = primary(); return { value: ~v.value, sym: null }; }
        if (n === 'offset') { const v = primary(); return v; }
        if (n === 'size' || n === 'type') {
          const s = mod.structs.get(lc(toks[i]));
          if (s) { i++; return { value: s.size, sym: null }; }
          fail(where, `${n} of something other than a structure`);
        }
        if (mod.equates.has(n)) return { value: mod.equates.get(n), sym: null };
        // `$` and labels carry their place, so that the distance between two of them is a constant
        // ($-Table sizes a table). In CODESEG that holds only while no instruction lies between
        // them: instructions are not encoded here, so their lengths are unknown.
        if (t.v === '$') {
          return seg === 'code' ? { value: 0, sym: '$', off: mod.code.bytes.length, seg, index: mod.code.items.length }
            : { value: 0, sym: '$', off: segOf(seg).bytes.length, seg };
        }
        const d = mod.data.labels.get(scoped(t.v)) ?? mod.code.labels.get(scoped(t.v)) ?? mod.fardata.labels.get(scoped(t.v));
        if (d) return { value: 0, sym: t.v, off: d.offset, seg: d.seg, index: d.index };
        for (const s of mod.structs.values()) if (s.fields.has(n)) return { value: s.fields.get(n).offset, sym: null };
        const s = mod.structs.get(n);
        if (s) return { value: s.size, sym: null };
        return { value: 0, sym: t.v };                // a label: relocated later
      }
      return fail(where, `'${t.v}' in an expression`);
    };
    const binop = (a, b, op) => {
      if (op === '-' && a.off !== undefined && b.off !== undefined && a.seg === b.seg) {
        if (a.seg === 'code') {
          const [lo, hi] = [Math.min(a.index, b.index), Math.max(a.index, b.index)];
          if (mod.code.items.slice(lo, hi).some((x) => x.kind === 'ins')) fail(where, 'the distance across instructions');
        }
        return { value: a.value - b.value + a.off - b.off, sym: null };
      }
      if ((a.sym || b.sym) && op !== '+' && op !== '-') fail(where, `'${op}' on an address`);
      if (a.sym && b.sym) fail(where, 'two addresses in one expression');
      if (b.sym && op === '-') fail(where, 'subtracting an address');
      const v = {
        '+': a.value + b.value, '-': a.value - b.value, '*': a.value * b.value,
        '/': Math.trunc(a.value / b.value), mod: a.value % b.value, shl: a.value << b.value,
        shr: a.value >>> b.value, and: a.value & b.value, or: a.value | b.value, xor: a.value ^ b.value,
      }[op];
      const s = a.sym ? a : b.sym ? b : null;
      return s ? { ...s, value: v } : { value: v, sym: null };
    };
    const term = () => {
      let v = primary();
      for (;;) {
        const t = peek();
        const op = isP(t, '*') ? '*' : isP(t, '/') ? '/' : ['mod', 'shl', 'shr'].includes(lc(t)) ? lc(t) : null;
        if (!op) return v;
        i++;
        v = binop(v, primary(), op);
      }
    };
    const sum = () => {
      let v = term();
      while (isP(peek(), '+') || isP(peek(), '-')) { const op = toks[i++].v; v = binop(v, term(), op); }
      return v;
    };
    const expr = () => {
      let v = sum();
      while (['and', 'or', 'xor'].includes(lc(peek()))) { const op = lc(toks[i++]); v = binop(v, sum(), op); }
      return v;
    };
    const v = expr();
    if (i !== toks.length) fail(where, `'${toks[i].v}' in an expression`);
    return v;
  };

  // ---------------------------------------------------------------- data
  const target = () => (curStruct ? curStruct : segOf(seg));
  const here = () => target().bytes.length;
  const emitBytes = (bytes) => { target().bytes.push(...bytes); };
  /** DB/DW/DD values, with DUP and '?'. Returns [{bytes}] and records fixups. */
  const dataValues = (toks, size, where) => {
    const items = [];
    let depth = 0, start = 0;
    const parts = [];
    for (let k = 0; k <= toks.length; k++) {
      const t = toks[k];
      if (t && isP(t, '(')) depth++;
      if (t && isP(t, ')')) depth--;
      if (k === toks.length || (isP(t, ',') && depth === 0)) { parts.push(toks.slice(start, k)); start = k + 1; }
    }
    const one = (p) => {
      const dupAt = p.findIndex((t) => lc(t) === 'dup');
      if (dupAt >= 0) {
        const n = evaluate(p.slice(0, dupAt), where).value;
        const inner = p.slice(dupAt + 1);
        if (!isP(inner[0], '(') || !isP(inner.at(-1), ')')) fail(where, 'DUP without parentheses');
        const body = [];
        for (const x of dataValues(inner.slice(1, -1), size, where)) body.push(x);
        for (let r = 0; r < n; r++) for (const x of body) items.push({ ...x });
        return;
      }
      // `?` is uninitialised. It tokenizes as an identifier -- `?` is a name character in TASM.
      if (p.length === 1 && (isP(p[0], '?') || (p[0].k === 'id' && p[0].v === '?'))) {
        items.push({ bytes: new Array(size).fill(0), undef: true });
        return;
      }
      if (p.length === 1 && p[0].k === 'str' && size === 1) {
        items.push({ bytes: [...p[0].v].map((ch) => ch.charCodeAt(0) & 255) });
        return;
      }
      const v = evaluate(p, where);
      const bytes = [];
      for (let b = 0; b < size; b++) bytes.push((v.value >>> (8 * b)) & 255);
      items.push({ bytes, sym: v.sym ?? null, addend: v.value });
    };
    for (const p of parts) if (p.length) one(p);
    return items;
  };
  const defineData = (name, size, toks, where) => {
    const tgt = target();
    if (curStruct) {
      const items = dataValues(toks, size, where);
      const bytes = items.flatMap((x) => x.bytes);
      if (name) curStruct.fields.set(name.toLowerCase(), { offset: curStruct.bytes.length, size, bytes });
      curStruct.bytes.push(...bytes);
      return;
    }
    if (name) defineLabel(name, where, { type: { 1: 'byte', 2: 'word', 4: 'dword' }[size] });
    const from = tgt.bytes.length;
    for (const x of dataValues(toks, size, where)) {
      if (x.sym) tgt.fixups.push({ at: tgt.bytes.length, size, sym: x.sym, addend: x.addend });
      tgt.bytes.push(...x.bytes);
    }
    if (seg === 'code') mod.code.items.push({ kind: 'data', from, to: tgt.bytes.length, where });
  };

  // ---------------------------------------------------------------- labels
  const scoped = (name) => (name.startsWith('@@') ? `${name}#${localScope}` : name);
  const defineLabel = (name, where, { type = 'near' } = {}) => {
    if (!name.startsWith('@@') && !proc) localScope++;
    const key = scoped(name);
    const tgt = segOf(seg);
    if (tgt.labels.has(key)) fail(where, `the label '${name}' defined twice`);
    const entry = { name: key, seg, type, offset: tgt.bytes.length, index: seg === 'code' ? mod.code.items.length : null };
    tgt.labels.set(key, entry);
    if (seg === 'code') mod.code.items.push({ kind: 'label', name: key, where, dataOffset: tgt.bytes.length });
  };

  // ---------------------------------------------------------------- instructions
  const emitIns = (toks, where, generated = false) => {
    if (seg !== 'code') fail(where, 'an instruction outside CODESEG');
    const t2 = [];
    let depth = 0;
    toks.forEach((t, k) => {
      if (isP(t, '[')) depth++;
      if (isP(t, ']')) depth--;
      // Inside brackets OFFSET adds nothing: [bx+OFFSET t] is [bx+t].
      if (depth > 0 && lc(t) === 'offset') return;
      // @@ labels in operands resolve in the current scope.
      if (t.k === 'id' && t.v.startsWith('@@')) { t2.push({ ...t, v: scoped(t.v) }); return; }
      // A named argument is [bp+offset], sized as declared -- how TASM resolves it inside a frame.
      if (t.k === 'argref') {
        const inner = [{ k: 'id', v: t.arg.type.toUpperCase() }, { k: 'id', v: 'PTR' }, { k: 'id', v: 'bp' }, { k: 'punct', v: '+' }, { k: 'num', v: String(t.arg.offset) }];
        t2.push(...(depth > 0 ? inner : [{ k: 'punct', v: '[' }, ...inner, { k: 'punct', v: ']' }]));
        return;
      }
      // A numeric equate or a structure field becomes its value (the mnemonic excepted).
      if (k > 0 && t.k === 'id') {
        const n = t.v.toLowerCase();
        if (mod.equates.has(n)) { t2.push({ k: 'num', v: String(mod.equates.get(n) & 0xffff), equate: t.v }); return; }
        for (const s of mod.structs.values()) {
          if (s.fields.has(n)) {
            // `x.field` is x plus the field's offset.
            if (isP(t2.at(-1), '.')) t2[t2.length - 1] = { k: 'punct', v: '+' };
            t2.push({ k: 'num', v: String(s.fields.get(n).offset), field: t.v, fieldSize: s.fields.get(n).size });
            return;
          }
        }
      }
      t2.push(t);
    });
    // A wholly constant operand -- MASM's AND/OR/SHL included, which the instruction parser does not
    // speak -- is folded to its value here, where the expression evaluator lives.
    const out = [];
    let cur = [], depth2 = 0;
    const flush = () => {
      const constant = cur.length > 1 && cur.every((x) => x.k === 'num' || x.k === 'punct'
        || ['and', 'or', 'xor', 'not', 'shl', 'shr', 'mod'].includes(lc(x)))
        && !cur.some((x) => isP(x, '[') || isP(x, ']') || isP(x, ':'));
      if (constant) {
        try { out.push({ k: 'num', v: String(evaluate(cur, where).value & 0xffff) }); cur = []; return; } catch { /* leave it */ }
      }
      out.push(...cur);
      cur = [];
    };
    t2.forEach((x, k) => {
      if (k === 0) { out.push(x); return; }
      if (isP(x, '[') || isP(x, '(')) depth2++;
      if (isP(x, ']') || isP(x, ')')) depth2--;
      if (isP(x, ',') && depth2 === 0) { flush(); out.push(x); return; }
      cur.push(x);
    });
    flush();
    t2.length = 0;
    t2.push(...out);
    // `jmp $+2` (the classic I/O delay) is a short jump over nothing: a jump to the next instruction.
    // Other distances from `$` would need the encoded lengths, which are not known here.
    const dollar = t2.findIndex((x, k) => k > 0 && x.k === 'id' && x.v === '$');
    let next = null;
    if (dollar > 0) {
      const jump = /^(jmp|j[a-z]{1,3}|loop[a-z]*)$/i.test(t2[0].v);
      if (!jump || dollar !== 1 || t2.length !== 4 || !isP(t2[2], '+') || t2[3].k !== 'num' || tasmNumber(t2[3].v, where) !== 2) {
        fail(where, "'$' in an instruction other than a jump to $+2");
      }
      next = `$next#${mod.code.items.length}`;
      t2.splice(1, 3, { k: 'id', v: next });
    }
    mod.code.items.push({ kind: 'ins', toks: t2, where, generated, proc: proc?.name ?? null, assume: mod.assume });
    if (next) {
      mod.code.labels.set(next, { name: next, seg, type: 'near', offset: mod.code.bytes.length, index: mod.code.items.length });
      mod.code.items.push({ kind: 'label', name: next, where, dataOffset: mod.code.bytes.length });
    }
  };
  const epilogue = (where) => {
    for (const r of [...(proc.uses ?? [])].reverse()) emitIns([{ k: 'id', v: 'POP' }, { k: 'id', v: r.toUpperCase() }], where, true);
    if (proc.frame) emitIns([{ k: 'id', v: 'POP' }, { k: 'id', v: 'BP' }], where, true);
  };

  // ---------------------------------------------------------------- text substitution
  const substitute = (toks) => {
    let out = toks;
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      const next = [];
      for (const t of out) {
        const n = t.k === 'id' ? t.v.toLowerCase() : null;
        if (n && mod.textEquates.has(n)) { next.push(...mod.textEquates.get(n)); changed = true; } else next.push(t);
      }
      out = next;
      if (!changed) break;
    }
    return out;
  };

  // ---------------------------------------------------------------- the line loop
  const condStack = [];                 // { active, taken, parentActive }
  const active = () => condStack.every((c) => c.active);

  const DIRECTIVE_OPS = new Set(['db', 'dw', 'dd', 'equ', '=', 'macro', 'proc', 'endp', 'label', 'struc', 'ends', 'segment']);

  function processLines(lines, file) {
    for (let li = 0; li < lines.length; li++) {
      const where = `${file}:${lines[li].line}`;
      let toks = tokenize(lines[li].text, where);
      if (!toks.length) continue;
      const first = lc(toks[0]);

      // Conditionals are processed even while skipping, to keep nesting straight.
      if (['if', 'ife', 'ifdef', 'ifndef'].includes(first)) {
        const parent = active();
        let cond = false;
        if (parent) {
          if (first === 'ifdef' || first === 'ifndef') {
            const n = lc(toks[1]);
            const def = mod.equates.has(n) || mod.textEquates.has(n) || mod.code.labels.has(n) || mod.data.labels.has(n) || mod.fardata.labels.has(n);
            cond = first === 'ifdef' ? def : !def;
          } else {
            const v = evaluate(substitute(toks.slice(1)), where).value;
            cond = first === 'if' ? v !== 0 : v === 0;
          }
        }
        condStack.push({ active: parent && cond, taken: parent && cond, parent });
        continue;
      }
      if (first === 'else') {
        const c = condStack.at(-1);
        if (!c) fail(where, 'ELSE without IF');
        c.active = c.parent && !c.taken;
        c.taken = true;
        continue;
      }
      if (first === 'endif') { if (!condStack.pop()) fail(where, 'ENDIF without IF'); continue; }
      if (!active()) {
        // A skipped MACRO or REPT body still has to be stepped over as a block.
        if (first === 'macro' || first === 'rept' || lc(toks[1]) === 'macro') li = skipBlock(lines, li, where);
        continue;
      }

      toks = substitute(toks);
      const f = lc(toks[0]), second = lc(toks[1]);

      // Macro definitions: IDEAL `MACRO name params`, MASM `name MACRO params`.
      if (f === 'macro' || second === 'macro') {
        const name = f === 'macro' ? toks[1].v : toks[0].v;
        const params = (f === 'macro' ? toks.slice(2) : toks.slice(2)).filter((t) => t.k === 'id').map((t) => t.v.toLowerCase());
        const end = skipBlock(lines, li, where);
        macros.set(name.toLowerCase(), { params, body: lines.slice(li + 1, end), file });
        li = end;
        continue;
      }
      if (f === 'rept') {
        const n = evaluate(toks.slice(1), where).value;
        const end = skipBlock(lines, li, where);
        const body = lines.slice(li + 1, end);
        for (let r = 0; r < n; r++) processLines(body, file);
        li = end;
        continue;
      }
      // Macro invocation (possibly after a label).
      let labelTok = null, rest = toks;
      if (toks[0].k === 'id' && isP(toks[1], ':')) { labelTok = toks[0]; rest = toks.slice(2); }
      if (rest.length && rest[0].k === 'id' && macros.has(rest[0].v.toLowerCase()) && !DIRECTIVE_OPS.has(lc(rest[1]))) {
        if (labelTok) defineLabel(labelTok.v, where);
        expandMacro(macros.get(rest[0].v.toLowerCase()), rest.slice(1), where);
        continue;
      }
      directive(toks, where, lines, li);
    }
  }

  function skipBlock(lines, li, where) {
    let depth = 1;
    for (let k = li + 1; k < lines.length; k++) {
      const t = tokenize(lines[k].text, where);
      const a = lc(t[0]), b = lc(t[1]);
      if (a === 'macro' || b === 'macro' || a === 'rept' || a === 'irp' || a === 'irpc') depth++;
      if (a === 'endm') { depth--; if (depth === 0) return k; }
    }
    return fail(where, 'a MACRO or REPT with no ENDM');
  }

  function expandMacro(m, argToks, where) {
    const args = [];
    let cur = [];
    for (const t of argToks) { if (isP(t, ',')) { args.push(cur); cur = []; } else cur.push(t); }
    if (cur.length || argToks.length) args.push(cur);
    const body = m.body.map((l) => {
      let text = l.text;
      m.params.forEach((p, k) => {
        const rep = (args[k] ?? []).map((t) => (t.k === 'str' ? `'${t.v}'` : t.v)).join(' ');
        text = text.replace(new RegExp(`\\b${p}\\b`, 'gi'), rep);
      });
      return { text, line: `${l.line}(macro)` };
    });
    processLines(body, `${m.file}`);
  }

  function directive(toks, where, lines, li) {
    const f = lc(toks[0]), second = lc(toks[1]);
    // Mode and model.
    // The processor: `.386C` lets 386 instructions through and changes how TASM sizes a forward
    // conditional jump (it reserves the 386's near form).
    if (isP(toks[0], '.') && toks.length === 2 && /^(8086|186|286|386|486)[cp]?$/i.test(toks[1].v)) {
      mod.cpu = parseInt(toks[1].v, 10) % 1000;
      return;
    }
    if (f === 'ideal') { mod.mode = 'ideal'; return; }
    if (f === 'masm') { mod.mode = 'masm'; return; }
    if (f === 'model') {
      mod.model = toks.slice(1).filter((t) => t.k === 'id').map((t) => t.v.toLowerCase());
      mod.assume = { cs: 'code', ds: 'data', ss: 'data', es: null };
      return;
    }
    if (f === 'include') {
      const name = toks[1]?.v;
      const text = read(name);
      if (text === null) fail(where, `INCLUDE of '${name}', which is not found`);
      processLines(text.replace(/\r/g, '').split('\n').map((t, k) => ({ text: t, line: k + 1 })), name);
      return;
    }
    if (f === 'dataseg') { seg = 'data'; return; }
    if (f === 'codeseg') { seg = 'code'; return; }
    if (f === 'fardata') { seg = 'fardata'; return; }
    if (f === 'assume') {
      const next = { ...mod.assume };
      for (let k = 1; k < toks.length; k++) {
        if (!isP(toks[k], ':')) continue;
        const v = lc(toks[k + 1]);
        next[lc(toks[k - 1])] = v === 'nothing' ? null : /^@code$|_text$/.test(v) ? 'code'
          : /^(@data|dgroup|_data)$/.test(v) ? 'data' : fail(where, `ASSUME of '${toks[k + 1]?.v}'`);
      }
      mod.assume = next;
      return;
    }
    if (f === 'end') return;
    if (f === 'even') {
      // In CODESEG the pad depends on the lengths of the encoded instructions before it, which are not
      // known here: the item marks the place, and code.bytes holds only the data between instructions.
      if (seg === 'code') { mod.code.items.push({ kind: 'even', where }); return; }
      // In data only the aligned case has been observed (Catacomb 3-D's C3_ASM opens DATASEG with
      // EVEN): what byte TASM pads data with is not known, so an odd offset is refused.
      if (segOf(seg).bytes.length & 1) fail(where, 'EVEN at an odd data offset, whose pad byte TASM has not shown');
      return;
    }
    if (f === 'public' || f === 'global') {
      for (const t of toks.slice(1)) if (t.k === 'id') mod.publics.add(t.v);
      return;
    }
    if (f === 'extrn') {
      for (let k = 1; k < toks.length; k++) {
        if (toks[k].k === 'id' && isP(toks[k + 1], ':')) mod.externs.set(toks[k].v, lc(toks[k + 2]));
      }
      return;
    }
    // Equates.
    if (second === '=' || isP(toks[1], '=')) {
      mod.equates.set(toks[0].v.toLowerCase(), evaluate(toks.slice(2), where).value);
      return;
    }
    if (second === 'equ') {
      const val = toks.slice(2);
      try {
        const v = evaluate(val, where);
        if (v.sym) throw new TasmError('text');
        mod.equates.set(toks[0].v.toLowerCase(), v.value);
      } catch { mod.textEquates.set(toks[0].v.toLowerCase(), val); }
      return;
    }
    // Structures: MASM `name STRUC` / `name ENDS`, IDEAL `STRUC name` / `ENDS`.
    if (second === 'struc' || f === 'struc') {
      curStruct = { name: (f === 'struc' ? toks[1] : toks[0]).v.toLowerCase(), bytes: [], fields: new Map() };
      return;
    }
    if (curStruct && (f === 'ends' || second === 'ends')) {
      mod.structs.set(curStruct.name, { size: curStruct.bytes.length, fields: curStruct.fields, bytes: curStruct.bytes });
      curStruct = null;
      return;
    }
    // Procedures.
    if (f === 'proc' || second === 'proc') {
      const name = (f === 'proc' ? toks[1] : toks[0]).v;
      const rest = toks.slice(2);
      let far = mod.model?.includes('medium') || mod.model?.includes('large') || mod.model?.includes('huge');
      const args = [];
      let k = 0;
      if (lc(rest[0]) === 'near') { far = false; k = 1; } else if (lc(rest[0]) === 'far') { far = true; k = 1; }
      let off = far ? 6 : 4;
      for (; k < rest.length; k++) {
        if (rest[k].k === 'id' && isP(rest[k + 1], ':')) {
          const ty = lc(rest[k + 2]);
          const size = { byte: 2, word: 2, dword: 4 }[ty];
          if (!size) fail(where, `an argument of type ${ty}`);
          args.push({ name: rest[k].v, offset: off, size, type: ty });
          off += size;
        }
      }
      proc = { name, far, args, uses: [], frame: args.length > 0, where };
      localScope++;
      defineLabel(name, where, { type: far ? 'far' : 'near' });
      mod.procs.push(proc);
      if (proc.frame) {
        emitIns([{ k: 'id', v: 'PUSH' }, { k: 'id', v: 'BP' }], where, true);
        emitIns([{ k: 'id', v: 'MOV' }, { k: 'id', v: 'BP' }, { k: 'punct', v: ',' }, { k: 'id', v: 'SP' }], where, true);
      }
      return;
    }
    if (f === 'uses') {
      if (!proc) fail(where, 'USES outside a PROC');
      proc.uses = toks.slice(1).filter((t) => t.k === 'id').map((t) => t.v.toLowerCase());
      for (const r of proc.uses) emitIns([{ k: 'id', v: 'PUSH' }, { k: 'id', v: r.toUpperCase() }], where, true);
      return;
    }
    if (f === 'endp' || second === 'endp') { proc = null; localScope++; return; }
    if (f === 'arg' || f === 'local') fail(where, `${f.toUpperCase()} directive`);
    // LABEL.
    if (second === 'label') { defineLabel(toks[0].v, where, { type: lc(toks[2]) }); return; }   // MASM
    if (f === 'label') { defineLabel(toks[1].v, where, { type: lc(toks[2]) }); return; }        // IDEAL
    // Data, with or without a name.
    const size = (w) => ({ db: 1, dw: 2, dd: 4 }[w]);
    if (size(f)) { defineData(null, size(f), toks.slice(1), where); return; }
    if (toks[0].k === 'id' && size(second)) { defineData(toks[0].v, size(second), toks.slice(2), where); return; }
    // A structure instance: `name STRUCNAME <...>`.
    if (toks[0].k === 'id' && mod.structs.has(second)) {
      const s = mod.structs.get(second);
      if (!isP(toks[2], '<>') && !(isP(toks[2], '<') && isP(toks[3], '>'))) fail(where, 'a structure instance with initial values');
      defineLabel(toks[0].v, where, { type: second });
      const from = here();
      emitBytes(s.bytes);
      if (seg === 'code') mod.code.items.push({ kind: 'data', from, to: here(), where });
      return;
    }
    // A label, possibly followed by an instruction.
    let t = toks;
    if (t[0].k === 'id' && isP(t[1], ':')) {
      defineLabel(t[0].v, where);
      t = t.slice(2);
      if (!t.length) return;
    }
    const op = lc(t[0]);
    if (!op) fail(where, `'${t[0].v}' where an instruction was expected`);
    if (op === 'ret' || op === 'retf' || op === 'retn') {
      if (proc && op === 'ret') {
        epilogue(where);
        emitIns([{ k: 'id', v: proc.far ? 'RETF' : 'RETN' }, ...t.slice(1)], where);
        return;
      }
      emitIns(t, where);
      return;
    }
    // Argument names become [bp+offset] -- how TASM resolves them inside a PROC with a frame.
    if (proc?.args.length) {
      const names = new Map(proc.args.map((a) => [a.name.toLowerCase(), a]));
      t = t.map((x) => (x.k === 'id' && names.has(x.v.toLowerCase())
        ? { k: 'argref', v: x.v, arg: names.get(x.v.toLowerCase()) } : x));
    }
    emitIns(t, where);
  }

  const text = read(file);
  if (text === null) throw new TasmError(`${file}: not found`);
  processLines(text.replace(/\r/g, '').split('\n').map((t, k) => ({ text: t, line: k + 1 })), file);
  if (condStack.length) throw new TasmError(`${file}: IF without ENDIF`);
  return mod;
}

export { tokenize as tasmTokenize, KEYWORD_REGS };
