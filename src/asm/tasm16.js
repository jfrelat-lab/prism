// tasm16.js — lay out and translate a module from src/asm/tasm.js as 8086 code.
//
// LAYOUT FIRST, because the program can see code addresses. Keen's assembly keeps jump tables of
// code labels (`jmp [ss:memtoscreentable+di]`), stores a routine's address in a variable
// (`mov [routinetouse],OFFSET generalmask`), keeps data in its code segment and pushes return
// addresses on a real stack. If a code label's value were anything but TASM's offset, each of those
// would hold a number the real program never held. So every instruction gets the length TASM gives
// it -- the same choices, not merely a valid encoding: a forward `jmp` is three bytes because TASM
// sizes it in one pass, `mov ax,[x]` uses the accumulator's short form, a code-segment variable
// read under ASSUME DS:DGROUP costs a CS: prefix TASM adds on its own. tools/gate-tasm-front.mjs
// holds every offset to the listing.

import { parseOperand, splitOperands } from './borland.js';

export class Tasm16Error extends Error {}

const REG16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const REG8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const SREGS = ['es', 'cs', 'ss', 'ds'];
const SIZE_OF_TYPE = { byte: 1, word: 2, dword: 4 };
const ALU = new Set(['add', 'adc', 'sub', 'sbb', 'and', 'or', 'xor', 'cmp']);
const SHIFTS = new Set(['rol', 'ror', 'rcl', 'rcr', 'shl', 'sal', 'shr', 'sar']);
const GROUP3 = new Set(['not', 'neg', 'mul', 'imul', 'div', 'idiv']);
const STRING = new Set(['movsb', 'movsw', 'stosb', 'stosw', 'lodsb', 'lodsw', 'scasb', 'scasw', 'cmpsb', 'cmpsw']);
const ONE_BYTE = new Set(['cli', 'sti', 'cld', 'std', 'clc', 'stc', 'cmc', 'nop', 'pushf', 'popf', 'xlat',
  'cbw', 'cwd', 'lahf', 'sahf', 'hlt', 'iret']);
const JCC = new Set(['jo', 'jno', 'jb', 'jc', 'jnae', 'jnb', 'jnc', 'jae', 'je', 'jz', 'jne', 'jnz', 'jbe', 'jna',
  'jnbe', 'ja', 'js', 'jns', 'jp', 'jpe', 'jnp', 'jpo', 'jl', 'jnge', 'jnl', 'jge', 'jle', 'jng', 'jnle', 'jg',
  'loop', 'loope', 'loopz', 'loopne', 'loopnz', 'jcxz']);
const REPS = new Set(['rep', 'repe', 'repz', 'repne', 'repnz']);

const s16 = (v) => ((v & 0xffff) << 16) >> 16;

/**
 * Resolve every instruction of `mod` and give it TASM's offset and length.
 *
 * Returns { ins: [...], labels: Map(name -> { addr, space, type }), size, image, imageFixups }:
 * `image` is the code segment with its data at their real offsets (instruction bytes are left 0 --
 * nothing reads them), and `imageFixups` the words in it that hold an address.
 */
export function layoutTasm(mod) {
  const fail = (where, what) => { throw new Tasm16Error(`${where}: ${what}`); };

  // Symbols: code labels get their address during the pass; data labels and externs are DGROUP's.
  const codeLabel = (name) => mod.code.labels.get(name) ?? [...mod.code.labels.values()].find((l) => l.name.toLowerCase() === name.toLowerCase());
  const dataLabel = (name) => mod.data.labels.get(name) ?? [...mod.data.labels.values()].find((l) => l.name.toLowerCase() === name.toLowerCase());
  const extern = (name) => {
    for (const [k, v] of mod.externs) if (k === name || k.toLowerCase() === name.toLowerCase()) return { name: k, type: String(v).toLowerCase() };
    return null;
  };
  const symbol = (name, where) => {
    const c = codeLabel(name);
    if (c) return { name: c.name, space: 'code', type: c.type };
    const d = dataLabel(name);
    if (d) return { name: d.name, space: 'data', type: d.type };
    const e = extern(name);
    if (e) return { name: e.name, space: 'extern', type: e.type };
    return fail(where, `the symbol '${name}', which is defined nowhere`);
  };

  /** One operand, resolved. */
  const resolve = (toks, where) => {
    // A segment's name is its paragraph: an immediate the loader fills.
    if (toks.length === 1 && toks[0].k === 'id' && /^@(code|data)$/i.test(toks[0].v)) {
      return { k: 'segaddr', group: toks[0].v.toLowerCase() === '@code' ? 'code' : 'data' };
    }
    let x;
    try { x = parseOperand(toks); } catch (e) { fail(where, e.message); }
    if (x.kind === 'reg') return { k: 'reg', r: x.reg, w: 2 };
    if (x.kind === 'reg8') return { k: 'reg', r: x.reg, w: 1 };
    if (x.kind === 'sreg') return { k: 'sreg', r: x.reg, w: 2 };
    if (x.kind === 'imm') return { k: 'imm', v: x.value, w: x.size };
    if (x.kind === 'offset') return { k: 'addr', sym: symbol(x.sym, where), add: x.c };
    const sym = x.sym ? symbol(x.sym, where) : null;
    const bracket = toks.some((t) => t.k === 'punct' && t.v === '[');
    // A bare code label with no register is a jump target, not a memory operand.
    if (sym && sym.space === 'code' && !bracket && !x.regs.length && !x.size && !x.seg && (sym.type === 'near' || sym.type === 'far')) {
      return { k: 'label', sym, add: x.c };
    }
    // A structure field gives the operand its type, as a variable's declaration does.
    const field = toks.find((t) => t.fieldSize)?.fieldSize;
    return { k: 'mem', w: x.size ?? SIZE_OF_TYPE[sym?.type] ?? field ?? null, seg: x.seg, regs: [...x.regs].sort(), disp: x.c, sym };
  };

  /** The segment register a memory operand goes through, and whether TASM writes a prefix for it. */
  const segment = (m, assume, where) => {
    const dflt = m.regs.includes('bp') ? 'ss' : 'ds';
    if (m.seg) return { seg: m.seg, prefix: m.seg !== dflt };
    if (!m.sym) return { seg: dflt, prefix: false };
    const group = m.sym.space === 'code' ? 'code' : 'data';
    if (assume[dflt] === group) return { seg: dflt, prefix: false };
    for (const r of ['cs', 'ss', 'ds', 'es']) if (assume[r] === group) return { seg: r, prefix: true };
    return fail(where, `'${m.sym.name}', which no segment register is assumed to reach`);
  };
  /** ModR/M displacement bytes. */
  const dispBytes = (m) => {
    if (!m.regs.length) return 2;
    if (m.sym) return 2;
    const d = s16(m.disp);
    if (d === 0 && !(m.regs.length === 1 && m.regs[0] === 'bp')) return 0;
    return d >= -128 && d <= 127 ? 1 : 2;
  };

  const ins = [];
  const labels = new Map();
  const image = [];
  const imageFixups = [];
  const pads = new Set();             // EVEN's NOPs between instructions: executed, not jumped to
  let pc = 0;
  const dataAt = new Map();           // code.bytes offset -> real offset, for the fixups in the code segment
  for (const it of mod.code.items) {
    if (it.kind === 'label') {
      const l = mod.code.labels.get(it.name);
      labels.set(it.name, { addr: pc, space: 'code', type: l?.type ?? 'near' });
      continue;
    }
    if (it.kind === 'even') {
      if (pc & 1) { image[pc] = 0x90; pads.add(pc); pc++; }
      continue;
    }
    if (it.kind === 'data') {
      for (let b = it.from; b < it.to; b++) { dataAt.set(b, pc); image[pc++] = mod.code.bytes[b]; }
      continue;
    }
    if (it.kind !== 'ins') continue;
    const where = it.where;
    const words = it.toks;
    let k = 0;
    let rep = null;
    let op = words[k++].v.toLowerCase();
    if (REPS.has(op)) { rep = op; op = words[k++]?.v.toLowerCase(); }
    const rest = words.slice(k);
    // `short` and `near` qualify a jump target; they are not part of the operand.
    const short = rest[0]?.k === 'id' && rest[0].v.toLowerCase() === 'short';
    const opToks = rest.filter((t, n) => !(n === 0 && t.k === 'id' && /^(short|near)$/i.test(t.v)));
    const ops = splitOperands(opToks).map((o) => resolve(o, where));
    const mems = ops.filter((o) => o.k === 'mem');
    if (mems.length > 1) fail(where, 'two memory operands');
    const m = mems[0];
    const seg = m ? segment(m, it.assume, where) : null;
    const mb = m ? dispBytes(m) : 0;
    const prefix = (seg?.prefix ? 1 : 0) + (rep ? 1 : 0);
    const [a, b] = ops;
    const width = () => {
      const w = ops.find((o) => o.k === 'reg' || o.k === 'sreg')?.w ?? m?.w;
      if (!w) fail(where, `${op} whose operand size is not stated`);
      return w;
    };
    const immLen = (o, w) => (o.k === 'addr' || o.k === 'segaddr' ? 2 : w === 1 ? 1 : 2);
    const isAcc = (o) => o?.k === 'reg' && (o.r === 'ax' || o.r === 'al');
    let len;
    if (op === 'mov') {
      if (a.k === 'sreg' || b.k === 'sreg') len = 2 + mb;
      else if (a.k === 'reg' && (b.k === 'imm' || b.k === 'addr' || b.k === 'segaddr')) len = 1 + immLen(b, a.w);
      else if (a.k === 'reg' && b.k === 'reg') len = 2;
      else if (m && !m.regs.length && (isAcc(a) || isAcc(b))) len = 3;            // A0-A3
      else if (a.k === 'mem' && (b.k === 'imm' || b.k === 'addr' || b.k === 'segaddr')) len = 2 + mb + immLen(b, width());
      else len = 2 + mb;
    } else if (ALU.has(op) || op === 'test') {
      if (b.k === 'imm' || b.k === 'addr' || b.k === 'segaddr') {
        const w = width();
        if (isAcc(a)) len = 1 + immLen(b, w);
        else if (op !== 'test' && w === 2 && b.k === 'imm' && s16(b.v) >= -128 && s16(b.v) <= 127) len = 2 + mb + 1;
        else len = 2 + mb + immLen(b, w);
      } else len = 2 + mb;
    } else if (op === 'inc' || op === 'dec') len = a.k === 'reg' && a.w === 2 ? 1 : 2 + mb;
    else if (op === 'push' || op === 'pop') {
      if (a.k === 'imm' || a.k === 'addr') fail(where, `${op} of an immediate, which the 8086 has not`);
      len = a.k === 'mem' ? 2 + mb : 1;
    } else if (SHIFTS.has(op)) {
      if (!(b.k === 'imm' && b.v === 1) && !(b.k === 'reg' && b.r === 'cl')) fail(where, `${op} by something other than 1 or CL`);
      len = 2 + mb;
    } else if (GROUP3.has(op)) len = 2 + mb;
    else if (op === 'xchg') len = (a.k === 'reg' && b.k === 'reg' && a.w === 2 && (a.r === 'ax' || b.r === 'ax')) ? 1 : 2 + mb;
    else if (op === 'lea') len = m.regs.length ? 2 + mb : 3;                         // TASM: MOV r,OFFSET
    else if (op === 'les' || op === 'lds') len = 2 + mb;
    else if (STRING.has(op)) { if (ops.length) fail(where, `${op} with operands`); len = 1; }
    else if (op === 'in' || op === 'out') len = ops.some((o) => o.k === 'imm') ? 2 : 1;
    else if (op === 'int') len = a.v === 3 ? 1 : 2;
    else if (ONE_BYTE.has(op)) len = 1;
    else if (op === 'ret' || op === 'retn' || op === 'retf') len = ops.length ? 3 : 1;
    else if (op === 'jmp' || op === 'call') {
      if (a.k === 'label') {
        const far = a.sym.type === 'far';
        if (op === 'call') len = far ? 5 : 3;
        else if (far) len = 5;
        else if (short || a.sym.name.startsWith('$next#')) len = 2;         // `jmp $+2` states its distance
        else {
          const t = labels.get(a.sym.name);
          // Backward: TASM knows the distance. Forward: one pass, so it reserves a near jump.
          len = t && s16(t.addr - (pc + prefix + 2)) >= -128 && s16(t.addr - (pc + prefix + 2)) <= 127 ? 2 : 3;
        }
      } else if (a.k === 'reg') len = 2;
      else if (a.k === 'mem') len = 2 + mb;
      else fail(where, `${op} to ${a.k}`);
    } else if (JCC.has(op)) {
      if (a.k !== 'label') fail(where, `${op} to something other than a label`);
      len = 2;
    } else fail(where, `the instruction '${op}'`);
    len += prefix;
    ins.push({ item: it, where, op, rep, ops, seg: seg?.seg ?? null, off: pc, len });
    pc += len;
  }
  for (const f of mod.code.fixups) {
    const at = dataAt.get(f.at);
    if (at === undefined) throw new Tasm16Error(`a fixup at ${f.at} outside the code segment's data`);
    imageFixups.push({ ...f, at });
  }
  for (let k = 0; k < pc; k++) image[k] ??= 0;
  return { ins, labels, size: pc, image, imageFixups, pads };
}

// ---------------------------------------------------------------- translation
//
// THE MACHINE IS THE PROGRAM'S, NOT C'S. The registers, the flags and SS:SP are real: a routine
// pushes its registers, reads its arguments at [bp+6] and returns with RETF to whatever address is on
// the stack. That is what lets the same routine be run from compiled C and, in the differential, from
// the real object file's entry state, with nothing adapted in between.
//
// THE FLAGS ARE LAZY. An arithmetic instruction records its kind, operands and result; a flag is
// computed when something reads it -- a conditional jump, ADC/SBB/RCL, PUSHF. All six arithmetic
// flags are produced because PUSHF can expose any of them.
//
// ONE FUNCTION PER PROCEDURE, dispatched by real address. A single switch over a whole module is one
// function too large for V8 to optimise. Within a procedure a jump is `continue` to a case; leaving
// it (a jump to another procedure's label, an indirect jump, a return) hands the address back to the
// dispatcher. Every case is a real code offset, so a return address or a jump table's entry is found
// exactly where TASM put it.
//
// DF is taken to be 0: the C convention guarantees it on entry and no Keen module executes STD.

const MASK = { 1: 0xff, 2: 0xffff };
const SIGN = { 1: 0x80, 2: 0x8000 };
const R8 = { al: ['ax', 0], cl: ['cx', 0], dl: ['dx', 0], bl: ['bx', 0], ah: ['ax', 8], ch: ['cx', 8], dh: ['dx', 8], bh: ['bx', 8] };
// Lazy flag kinds.
const K = { CONST: 0, ADD: 1, SUB: 2, LOGIC: 3, INC: 4, DEC: 5, NEG: 6, SHL: 7, SHR: 8, SAR: 9 };
const COND = {
  jo: 'of()', jno: '!of()', jb: 'cf()', jc: 'cf()', jnae: 'cf()', jnb: '!cf()', jnc: '!cf()', jae: '!cf()',
  je: 'zf()', jz: 'zf()', jne: '!zf()', jnz: '!zf()', jbe: '(cf()||zf())', jna: '(cf()||zf())',
  jnbe: '!(cf()||zf())', ja: '!(cf()||zf())', js: 'sf()', jns: '!sf()', jp: 'pf()', jpe: 'pf()',
  jnp: '!pf()', jpo: '!pf()', jl: '(sf()!==of())', jnge: '(sf()!==of())', jnl: '(sf()===of())',
  jge: '(sf()===of())', jle: '(zf()||sf()!==of())', jng: '(zf()||sf()!==of())',
  jnle: '(!zf()&&sf()===of())', jg: '(!zf()&&sf()===of())',
};

/**
 * Translate a laid-out module to JavaScript source: `(function(D, io){ ... return { run }; })`.
 *
 * `cs` and `dgroup` are the paragraphs the code segment and DGROUP are loaded at; `dataBase` is where
 * this module's _DATA starts inside DGROUP; `symbol(name)` gives an external's offset in DGROUP.
 * run(R) takes { ax..di, bp, sp, ds, es, ss, ip, flags } and runs from CS:ip until a far return
 * leaves the code segment, then writes the registers back into R (with R.cs and R.ip the address it
 * returned to). io = { in(port, width), out(port, width, value), interrupt(n, R) }.
 */
export function translateTasm(mod, lay, { cs, dgroup, dataBase, symbol }) {
  const fail = (x, what) => { throw new Tasm16Error(`${x.where}: ${what}`); };
  const CS = cs & 0xffff;

  const symOff = (sym) => {
    if (sym.space === 'code') {
      const l = lay.labels.get(sym.name);
      if (!l) throw new Tasm16Error(`the code label '${sym.name}' has no address`);
      return l.addr;
    }
    if (sym.space === 'data') return (dataBase + mod.data.labels.get(sym.name).offset) & 0xffff;
    const v = symbol(sym.name);
    if (v === undefined) throw new Tasm16Error(`the external '${sym.name}' has no address`);
    return v & 0xffff;
  };
  const segJs = (s) => (s === 'cs' ? String(CS) : s);
  const eaJs = (m) => {
    const c = ((m.sym ? symOff(m.sym) : 0) + m.disp) & 0xffff;
    return m.regs.length ? `((${m.regs.join('+')}+${c})&65535)` : String(c);
  };

  // Where each instruction is, and which procedure owns it.
  const groupOf = (x) => x.item.proc ?? '';
  const byAddr = new Map(lay.ins.map((x, k) => [x.off, k]));
  const targets = new Set();
  for (const l of lay.labels.values()) if (byAddr.has(l.addr)) targets.add(l.addr);
  // Where control falls from x: the next instruction, past an EVEN pad if there is one.
  const after = (x) => x.off + x.len + (lay.pads.has(x.off + x.len) ? 1 : 0);
  lay.ins.forEach((x, k) => {
    if (x.op === 'call') { targets.add(x.off + x.len); targets.add(after(x)); }
    const next = lay.ins[k + 1];
    if (next && (next.off !== after(x) || groupOf(next) !== groupOf(x))) targets.add(after(x));
  });

  const groups = new Map();
  for (const x of lay.ins) {
    const g = groupOf(x);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(x);
  }
  const groupIndex = new Map([...groups.keys()].map((g, k) => [g, k]));
  const entry = new Map();              // address -> group index
  for (const [g, list] of groups) {
    for (const x of list) {
      if (targets.has(x.off)) entry.set(x.off, groupIndex.get(g));
      // A return address that is an EVEN pad: the NOP runs, then the instruction after it.
      if (lay.pads.has(x.off - 1) && targets.has(x.off - 1)) entry.set(x.off - 1, groupIndex.get(g));
    }
  }

  const fns = [];
  for (const [g, list] of groups) {
    const gi = groupIndex.get(g);
    const own = new Set(list.map((x) => x.off));
    const out = [];
    const go = (addr) => (own.has(addr) && entry.get(addr) === gi ? `{_pc=${addr};continue;}` : `return ${addr};`);
    list.forEach((x, k) => {
      if (lay.pads.has(x.off - 1) && targets.has(x.off - 1)) out.push(`case ${x.off - 1}:`);
      if (targets.has(x.off)) out.push(`case ${x.off}:`);
      out.push(`/* @${x.off} ${x.where}: ${x.item.toks.map((t) => t.v).join(' ')} */ ${statement(x, go)}`);
      const next = list[k + 1];
      if (!next || next.off !== after(x)) {
        if (!isTerminal(x)) out.push(`return ${after(x)};`);
      }
    });
    // Every jump taken and every entry spends the clock's budget -- the machine's own when the host
    // gives one (io.clock, src/env/pcirq.js: an interrupt may be delivered there, with this code's
    // registers and IF), else a step budget of its own.
    const tick = 'if(--CLK.spBudget<0)CLK.sp_(-1,regsNow,(_fl>>>9)&1);';
    fns.push(`function g${gi}(_pc){${tick}for(;;){${tick}switch(_pc){\n${out.join('\n')}\ndefault: return nowhere(_pc);}}}`);
  }

  function isTerminal(x) {
    return x.op === 'jmp' || x.op === 'ret' || x.op === 'retn' || x.op === 'retf' || x.op === 'iret';
  }

  /** The value of an operand, unsigned, at width w. */
  function rd(o, w, x, ea) {
    if (o.k === 'reg') return o.w === 2 ? o.r : R8[o.r][1] ? `(${R8[o.r][0]}>>>8)` : `(${R8[o.r][0]}&255)`;
    if (o.k === 'sreg') return segJs(o.r);
    if (o.k === 'imm') return String(o.v & MASK[w]);
    if (o.k === 'addr') return String((symOff(o.sym) + o.add) & 0xffff);
    if (o.k === 'segaddr') return String(o.group === 'code' ? CS : dgroup & 0xffff);
    if (o.k === 'mem') return w === 1 ? `rb(${segJs(x.seg)},${ea})` : `rw(${segJs(x.seg)},${ea})`;
    return fail(x, `reading a ${o.k}`);
  }
  /** A statement writing v (already masked to w) into an operand. */
  function wr(o, v, w, x, ea) {
    if (o.k === 'reg') {
      if (o.w === 2) return `${o.r}=${v};`;
      const [r, sh] = R8[o.r];
      return sh ? `${r}=(${r}&255)|((${v})<<8);` : `${r}=(${r}&65280)|(${v});`;
    }
    if (o.k === 'sreg') {
      if (o.r === 'cs') fail(x, 'a write to CS');
      return `${o.r}=${v};`;
    }
    if (o.k === 'mem') return w === 1 ? `wb(${segJs(x.seg)},${ea},${v});` : `ww(${segJs(x.seg)},${ea},${v});`;
    return fail(x, `writing a ${o.k}`);
  }
  function widthOf(x) {
    const r = x.ops.find((o) => o.k === 'reg' || o.k === 'sreg');
    if (r) return r.w;
    const m = x.ops.find((o) => o.k === 'mem');
    if (m?.w === 1 || m?.w === 2) return m.w;
    return fail(x, `${x.op} whose operand size is not stated`);
  }

  function statement(x, go) {
    const { op, ops } = x;
    const [a, b] = ops;
    const m = ops.find((o) => o.k === 'mem');
    // The effective address is computed once, before any register the instruction writes changes.
    const pre = m ? `const _e=${eaJs(m)};` : '';
    const ea = '_e';
    const block = (s) => `{${pre}${s}}`;
    const push = (v) => `sp=(sp-2)&65535;ww(ss,sp,${v});`;
    const pop = (dst) => `${dst}rw(ss,sp);sp=(sp+2)&65535;`;
    switch (op) {
      case 'mov': { const w = widthOf(x); return block(wr(a, rd(b, w, x, ea), w, x, ea)); }
      case 'add': case 'adc': case 'sub': case 'sbb': case 'cmp': case 'and': case 'or': case 'xor': case 'test': {
        const w = widthOf(x);
        const M = MASK[w];
        let s = `_a=${rd(a, w, x, ea)};_b=${rd(b, w, x, ea)};_w=${w};`;
        if (op === 'add') s += `_u=_a+_b;_c=0;_k=${K.ADD};`;
        else if (op === 'adc') s += `_c=cf();_u=_a+_b+_c;_k=${K.ADD};`;
        else if (op === 'sub' || op === 'cmp') s += `_u=_a-_b;_c=0;_k=${K.SUB};`;
        else if (op === 'sbb') s += `_c=cf();_u=_a-_b-_c;_k=${K.SUB};`;
        else s += `_u=_a${{ and: '&', test: '&', or: '|', xor: '^' }[op]}_b;_k=${K.LOGIC};`;
        s += `_r=_u&${M};`;
        if (op !== 'cmp' && op !== 'test') s += wr(a, '_r', w, x, ea);
        return block(s);
      }
      case 'inc': case 'dec': {
        const w = widthOf(x);
        return block(`_c=cf();_a=${rd(a, w, x, ea)};_b=1;_w=${w};_r=(_a${op === 'inc' ? '+' : '-'}1)&${MASK[w]};_k=${op === 'inc' ? K.INC : K.DEC};${wr(a, '_r', w, x, ea)}`);
      }
      case 'neg': { const w = widthOf(x); return block(`_a=${rd(a, w, x, ea)};_b=_a;_w=${w};_u=-_a;_r=_u&${MASK[w]};_k=${K.NEG};${wr(a, '_r', w, x, ea)}`); }
      case 'not': { const w = widthOf(x); return block(wr(a, `(~${rd(a, w, x, ea)})&${MASK[w]}`, w, x, ea)); }
      case 'shl': case 'sal': case 'shr': case 'sar': {
        const w = widthOf(x);
        const c = b.k === 'imm' ? String(b.v & 31) : '(cx&31)';
        const v = rd(a, w, x, ea);
        const res = op === 'shr' ? '(_a>>>_b)' : op === 'sar' ? `(((_a<<${32 - 8 * w})>>${32 - 8 * w})>>_b)&${MASK[w]}` : `(_a<<_b)&${MASK[w]}`;
        const kind = op === 'shr' ? K.SHR : op === 'sar' ? K.SAR : K.SHL;
        return block(`_t=${c};if(_t){_a=${v};_b=_t;_w=${w};_r=${res};_k=${kind};${wr(a, '_r', w, x, ea)}}`);
      }
      case 'rol': case 'ror': case 'rcl': case 'rcr': {
        const w = widthOf(x);
        const bits = 8 * w, M = MASK[w];
        const c = b.k === 'imm' ? String(b.v & 31) : '(cx&31)';
        const through = op === 'rcl' || op === 'rcr';
        // RCL/RCR rotate through CF: a (bits+1)-bit rotation. Only CF and OF change.
        const loop = op === 'rcl' ? `_n=((_v>>>${bits - 1})&1);_v=((_v<<1)|_f)&${M};_f=_n;`
          : op === 'rcr' ? `_n=_v&1;_v=(_v>>>1)|(_f<<${bits - 1});_f=_n;`
            : op === 'rol' ? `_f=(_v>>>${bits - 1})&1;_v=((_v<<1)|_f)&${M};`
              : `_f=_v&1;_v=(_v>>>1)|(_f<<${bits - 1});`;
        // OF is defined by the 8086 for a count of 1 only; for more, this is what the reference machine
        // computes (msb of old^new through the carry, as for a single step).
        const of = through ? `(((_o^_v)>>>${bits - 1})&1)` : op === 'rol' ? `(((_v>>>${bits - 1})&1)^_f)` : `(((_v>>>${bits - 1})^(_v>>>${bits - 2}))&1)`;
        return block(`_t=${c}${through ? `%${bits + 1}` : ''};if(_t){mat();_v=${rd(a, w, x, ea)};_o=_v;_f=_fl&1;for(let _i=0;_i<_t;_i++){${loop}}`
          + `_fl=(_fl&~0x801)|_f|(${of}<<11);${wr(a, '_v', w, x, ea)}}`);
      }
      case 'xchg': {
        const w = widthOf(x);
        return block(`_t=${rd(a, w, x, ea)};${wr(a, rd(b, w, x, ea), w, x, ea)}${wr(b, '_t', w, x, ea)}`);
      }
      case 'lea': return wr(a, b.k === 'mem' ? eaJs(b) : fail(x, 'LEA of something other than memory'), 2, x, ea);
      case 'les': case 'lds':
        return block(`_t=rw(${segJs(x.seg)},${ea});_s=rw(${segJs(x.seg)},(${ea}+2)&65535);${a.r}=_t;${op === 'les' ? 'es' : 'ds'}=_s;`);
      case 'push': return block(push(rd(a, 2, x, ea)));
      case 'pop':
        if (a.k === 'mem') return block(`_t=rw(ss,sp);sp=(sp+2)&65535;${wr(a, '_t', 2, x, ea)}`);
        return pop(a.k === 'sreg' ? `${a.r}=` : `${a.r}=`);
      case 'pushf': return `mat();${push('(_fl&0x0fd5)|2')}`;
      case 'popf': return `_fl=rw(ss,sp);sp=(sp+2)&65535;_k=${K.CONST};`;
      case 'cli': return '_fl&=~0x200;';
      case 'sti': return '_fl|=0x200;';
      case 'clc': return 'mat();_fl&=~1;';
      case 'stc': return 'mat();_fl|=1;';
      case 'cmc': return 'mat();_fl^=1;';
      case 'cld': return '';
      case 'nop': return '';
      case 'std': return fail(x, 'STD: DF is taken to be 0');
      case 'cbw': return 'ax=(ax&128)?(ax|65280):(ax&255);';
      case 'cwd': return 'dx=(ax&32768)?65535:0;';
      case 'xlat': return `ax=(ax&65280)|rb(${segJs(x.seg ?? 'ds')},(bx+(ax&255))&65535);`;
      case 'in': {
        const port = b.k === 'imm' ? String(b.v) : 'dx';
        return a.w === 1 ? `ax=(ax&65280)|(io.in(${port},1)&255);` : `ax=io.in(${port},2)&65535;`;
      }
      case 'out': {
        const port = a.k === 'imm' ? String(a.v) : 'dx';
        return b.w === 1 ? `io.out(${port},1,ax&255);` : `io.out(${port},2,ax);`;
      }
      case 'int': return `interrupt(${a.v & 255});`;
      case 'movsb': case 'movsw': case 'stosb': case 'stosw': case 'lodsb': case 'lodsw': case 'scasb': case 'scasw':
        return string(x);
      case 'jmp': {
        if (a.k === 'label') return go(lay.labels.get(a.sym.name).addr);
        return block(`return ${rd(a, 2, x, ea)};`);
      }
      case 'call': {
        const ret = x.off + x.len;
        if (a.k === 'label') {
          const t = lay.labels.get(a.sym.name);
          if (t.type === 'far') return `${push(CS)}${push(ret)}return ${t.addr};`;
          return `${push(ret)}return ${t.addr};`;
        }
        return block(`_t=${rd(a, 2, x, ea)};${push(ret)}return _t;`);
      }
      case 'ret': case 'retn': {
        const n = a ? a.v & 0xffff : 0;
        return `_t=rw(ss,sp);sp=(sp+${2 + n})&65535;return _t;`;
      }
      case 'retf': {
        const n = a ? a.v & 0xffff : 0;
        return `_t=rw(ss,sp);_s=rw(ss,(sp+2)&65535);sp=(sp+${4 + n})&65535;if(_s!==${CS}){_xcs=_s;_xip=_t;return -1;}return _t;`;
      }
      default:
        if (x.op in COND) return `if(${COND[x.op]})${go(lay.labels.get(a.sym.name).addr)}`;
        if (x.op === 'loop') return `cx=(cx-1)&65535;if(cx)${go(lay.labels.get(a.sym.name).addr)}`;
        if (x.op === 'loope' || x.op === 'loopz') return `cx=(cx-1)&65535;if(cx&&zf())${go(lay.labels.get(a.sym.name).addr)}`;
        if (x.op === 'loopne' || x.op === 'loopnz') return `cx=(cx-1)&65535;if(cx&&!zf())${go(lay.labels.get(a.sym.name).addr)}`;
        if (x.op === 'jcxz') return `if(!cx)${go(lay.labels.get(a.sym.name).addr)}`;
        return fail(x, `no translation for ${x.op}`);
    }
  }

  /** A string instruction, with its REP prefix. The source is DS:SI (or an override), the destination ES:DI. */
  function string(x) {
    const w = x.op.endsWith('w') ? 2 : 1;
    const src = segJs(x.seg ?? 'ds');
    const R = w === 1 ? 'rb' : 'rw', W = w === 1 ? 'wb' : 'ww';
    let one;
    if (x.op.startsWith('movs')) one = `${W}(es,di,${R}(${src},si));si=(si+${w})&65535;di=(di+${w})&65535;`;
    else if (x.op.startsWith('stos')) one = `${W}(es,di,${w === 1 ? 'ax&255' : 'ax'});di=(di+${w})&65535;`;
    else if (x.op.startsWith('lods')) one = `${w === 1 ? `ax=(ax&65280)|rb(${src},si);` : `ax=rw(${src},si);`}si=(si+${w})&65535;`;
    else one = `_a=${w === 1 ? 'ax&255' : 'ax'};_b=${R}(es,di);_w=${w};_u=_a-_b;_c=0;_r=_u&${MASK[w]};_k=${K.SUB};di=(di+${w})&65535;`;
    if (!x.rep) return one;
    const scan = x.op.startsWith('scas');
    if (!scan) return `while(cx){${one}cx=(cx-1)&65535;}`;
    const again = x.rep === 'repne' || x.rep === 'repnz' ? '!zf()' : 'zf()';
    return `while(cx){${one}cx=(cx-1)&65535;if(!${again})break;}`;
  }

  const entries = [...entry].map(([addr, gi]) => `[${addr},g${gi}]`).join(',');
  return `(function(D, io){
"use strict";
let ax=0,bx=0,cx=0,dx=0,si=0,di=0,bp=0,sp=0,ds=0,es=0,ss=0;
let _k=0,_a=0,_b=0,_c=0,_u=0,_r=0,_w=2,_fl=0x202,_t=0,_s=0,_v=0,_o=0,_f=0,_n=0,_xcs=0,_xip=0;
const CLK=io.clock??{spBudget:0,sp_(){budget();}};
const regsNow=()=>({ax,bx,cx,dx,si,di,bp,sp,ds,es,ss});
const rb=(s,o)=>D.getUint8((s<<4)+o);
const rw=(s,o)=>o===65535?(D.getUint8((s<<4)+o)|(D.getUint8(s<<4)<<8)):D.getUint16((s<<4)+o,true);
const wb=(s,o,v)=>D.setUint8((s<<4)+o,v);
const ww=(s,o,v)=>{if(o===65535){D.setUint8((s<<4)+o,v&255);D.setUint8(s<<4,v>>>8);}else D.setUint16((s<<4)+o,v,true);};
const SIGN=[0,128,32768];
function cf(){switch(_k){case ${K.CONST}:return _fl&1;case ${K.ADD}:return (_u>>>(8*_w))&1;case ${K.SUB}:return _u<0?1:0;`
    + `case ${K.INC}:case ${K.DEC}:return _c;case ${K.NEG}:return _a!==0?1:0;case ${K.SHL}:return _b<=8*_w?(_a>>>(8*_w-_b))&1:0;`
    + `case ${K.SHR}:return (_a>>>(_b-1))&1;case ${K.SAR}:return ((((_a<<(32-8*_w))>>(32-8*_w))>>(_b>31?31:_b-1))&1);default:return 0;}}
function zf(){return _k===${K.CONST}?(_fl>>>6)&1:(_r===0?1:0);}
function sf(){return _k===${K.CONST}?(_fl>>>7)&1:(_r&SIGN[_w])?1:0;}
function pf(){if(_k===${K.CONST})return (_fl>>>2)&1;let p=_r&255;p^=p>>4;p^=p>>2;p^=p>>1;return (p&1)^1;}
function af(){switch(_k){case ${K.CONST}:return (_fl>>>4)&1;case ${K.ADD}:case ${K.SUB}:return ((_a^_b^_r)>>>4)&1;case ${K.NEG}:return ((_a^_r)>>>4)&1;`
    + `case ${K.INC}:return (_r&15)===0?1:0;case ${K.DEC}:return (_r&15)===15?1:0;default:return 0;}}
function of(){const s=SIGN[_w];switch(_k){case ${K.CONST}:return (_fl>>>11)&1;case ${K.ADD}:return ((_a^_r)&(_b^_r)&s)?1:0;`
    + `case ${K.SUB}:return ((_a^_b)&(_a^_r)&s)?1:0;case ${K.INC}:return _r===s?1:0;case ${K.DEC}:return _r===s-1?1:0;`
    + `case ${K.NEG}:return _r===s?1:0;case ${K.SHL}:return (((_r&s)?1:0)^cf());case ${K.SHR}:return ((_a>>>(_b-1))^_r)&s?1:0;default:return 0;}}
function mat(){if(_k!==${K.CONST}){_fl=(_fl&~0x8d5)|cf()|(pf()<<2)|(af()<<4)|(zf()<<6)|(sf()<<7)|(of()<<11);_k=${K.CONST};}}
function budget(){throw new Error('tasm16: the step budget ran out');}
function nowhere(pc){throw new Error('tasm16: '+${JSON.stringify(mod.file)}+' reached '+pc.toString(16)+'h, which no jump or call in the source names');}
function interrupt(n){mat();const R={ax,bx,cx,dx,si,di,bp,sp,ds,es,ss,cs:${CS},flags:_fl};io.interrupt(n,R);`
    + `ax=R.ax&65535;bx=R.bx&65535;cx=R.cx&65535;dx=R.dx&65535;si=R.si&65535;di=R.di&65535;bp=R.bp&65535;ds=R.ds&65535;es=R.es&65535;_fl=R.flags&65535;_k=${K.CONST};}
${fns.join('\n')}
const ENTRY=new Map([${entries}]);
function run(R,steps){
  ax=R.ax&65535;bx=R.bx&65535;cx=R.cx&65535;dx=R.dx&65535;si=R.si&65535;di=R.di&65535;bp=R.bp&65535;sp=R.sp&65535;
  ds=R.ds&65535;es=R.es&65535;ss=R.ss&65535;_fl=(R.flags??0x202)&65535;_k=${K.CONST};if(!io.clock)CLK.spBudget=steps??1e9;
  let pc=R.ip&65535;
  while(pc>=0){const g=ENTRY.get(pc);if(!g)nowhere(pc);pc=g(pc);}
  mat();
  Object.assign(R,{ax,bx,cx,dx,si,di,bp,sp,ds,es,ss,cs:_xcs,ip:_xip,flags:_fl});
  return R;
}
return { run, entries: ENTRY };
})`;
}

/**
 * Load a laid-out module into memory D: the code segment's image at paragraph `cs` and _DATA at
 * `dataBase` inside DGROUP (paragraph `dgroup`), every address in them resolved as the linker would.
 */
export function loadTasm(mod, lay, D, { cs, dgroup, dataBase, symbol }) {
  const resolve = (name) => {
    const c = lay.labels.get(name);
    if (c) return { off: c.addr, seg: cs };
    const d = mod.data.labels.get(name);
    if (d) return { off: dataBase + d.offset, seg: dgroup };
    const e = [...mod.externs.keys()].find((k) => k === name || k.toLowerCase() === name.toLowerCase());
    if (e !== undefined && symbol(e) !== undefined) return { off: symbol(e), seg: dgroup };
    throw new Tasm16Error(`${mod.file}: the address of '${name}', which is defined nowhere`);
  };
  const place = (base, bytes, fixups) => {
    bytes.forEach((v, k) => D.setUint8(base + k, v));
    for (const f of fixups) {
      const t = resolve(f.sym);
      D.setUint16(base + f.at, (t.off + f.addend) & 0xffff, true);
      if (f.size === 4) D.setUint16(base + f.at + 2, t.seg, true);
      else if (f.size !== 2) throw new Tasm16Error(`${mod.file}: a ${f.size}-byte address`);
    }
  };
  place(cs << 4, lay.image, lay.imageFixups);
  place((dgroup << 4) + dataBase, mod.data.bytes, mod.data.fixups);
}
