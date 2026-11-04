// msvc.js — Visual C++'s inline assembly, 32-bit flat, translated to JavaScript.
//
//     void Fade64(sU64 &r, sU64 &c0, sU64 &c1, sInt fade) {      // .kkrieger, genbitmap.cpp
//       __asm {
//         mov       eax, [c0]
//         movq      mm2, [eax]
//         movd      mm0, [fade]
//         ...
//         emms
//       }
//     }
//
// Like Borland's (src/asm/borland.js), MSVC's asm is statements inside a C function, naming its
// variables and its labels, and it is lowered the same way, before the function is emitted:
// instructions become `asmins` statements, a label inside the block a C label, a conditional jump
// `if (cc) goto label`, so the escape analysis, flatten.js and the goto state machine see ordinary
// statements. What differs is the machine:
//
//   * FLAT 32-BIT. A pointer is its linear address, a C variable named in an operand is MEMORY at its
//     address (`[c0]` and `c0` alike, as MASM reads them), and the emitter pins every local the asm
//     names to a stack slot. `[esi]BilinearContext.Src` adds the field's offset: the parser folds a
//     `Type.field` to a number (src/parse/parser.js), so this file sees `[esi] 0`.
//   * THE MMX REGISTERS BELONG TO THE MACHINE (M.x86, src/asm/msvc-rt.js), the general registers to
//     the invocation: Visual C++ makes no promise about EAX..EDI between two __asm blocks, so no
//     correct program reads one it did not write -- and every register starts at zero, which is the
//     one value a reading it on purpose could not be relying on anyway.
//   * A COMPUTED JUMP. Bitmap_Inner picks one of twenty loops with `lea eax,loop0 ... jmp eax`. A
//     label's "address" is its state number in the goto state machine, so `lea reg,label` loads that
//     number and `jmp reg` is a computed goto -- the device GNU C's `goto *p` already uses.
//   * A function that falls off its end right after an __asm block returns what EAX holds (EDX:EAX
//     for eight bytes), which Visual C++ documents (warning C4035) and programs rely on.
//
// FLAGS: CF, ZF, SF and OF, computed eagerly at the operation's width, which every condition this
// file accepts reads. PF and AF are not computed, and jp/jnp are refused by name.
//
// Everything outside the subset is REFUSED BY NAME at compile time: ESP and EBP as operands (the
// frame is PRISM's, not Visual C++'s), call, int, the x87, SSE registers, string instructions.
// The instruction semantics are checked against Unicorn in 32-bit protected mode
// (tools/gate-msvcasm.mjs); the C-facing half -- names, fields, labels, the return in EAX -- by
// executing it.
import { ID, NUM, PUNCT } from '../cpp/token.js';
import { MMX_BINARY, MMX_SHIFT, MM_SCRATCH } from './msvc-rt.js';

export class MsvcAsmError extends Error {}
const fail = (m) => { throw new MsvcAsmError(m); };

const R32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const SUB = {
  ax: ['eax', 2, 0], cx: ['ecx', 2, 0], dx: ['edx', 2, 0], bx: ['ebx', 2, 0], si: ['esi', 2, 0], di: ['edi', 2, 0],
  al: ['eax', 1, 0], cl: ['ecx', 1, 0], dl: ['edx', 1, 0], bl: ['ebx', 1, 0],
  ah: ['eax', 1, 8], ch: ['ecx', 1, 8], dh: ['edx', 1, 8], bh: ['ebx', 1, 8],
};
const PTR_SIZE = { byte: 1, word: 2, dword: 4, qword: 8, mmword: 8 };
const MASK = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };

/** The register file one invocation declares. */
export const MSVC_REGISTER_DECLS = 'var $e={eax:0,ecx:0,edx:0,ebx:0,esi:0,edi:0,cf:0,zf:0,sf:0,of:0},$x=M.x86,$a=0,$t=0,$u=0,$v=0,$stk=[];';

const CC = {
  jz: '$e.zf', je: '$e.zf', jnz: '!$e.zf', jne: '!$e.zf',
  jc: '$e.cf', jb: '$e.cf', jnae: '$e.cf', jnc: '!$e.cf', jnb: '!$e.cf', jae: '!$e.cf',
  js: '$e.sf', jns: '!$e.sf', jo: '$e.of', jno: '!$e.of',
  jbe: '($e.cf||$e.zf)', jna: '($e.cf||$e.zf)', ja: '(!$e.cf&&!$e.zf)', jnbe: '(!$e.cf&&!$e.zf)',
  jl: '($e.sf!==$e.of)', jnge: '($e.sf!==$e.of)', jge: '($e.sf===$e.of)', jnl: '($e.sf===$e.of)',
  jle: '($e.zf||$e.sf!==$e.of)', jng: '($e.zf||$e.sf!==$e.of)', jg: '(!$e.zf&&$e.sf===$e.of)', jnle: '(!$e.zf&&$e.sf===$e.of)',
  jecxz: '($e.ecx===0)',
};
const ALU = new Set(['add', 'sub', 'and', 'or', 'xor', 'cmp', 'test', 'adc']);
const KNOWN = new Set([...ALU, ...MMX_BINARY, ...MMX_SHIFT, 'mov', 'movzx', 'movsx', 'lea', 'inc', 'dec', 'neg', 'not',
  'shl', 'sal', 'shr', 'sar', 'imul', 'push', 'pop', 'xchg', 'cdq', 'nop', 'jmp', 'clc', 'stc', 'cmc',
  'movq', 'movd', 'movntq', 'emms', 'pshufw', 'pinsrw', 'pextrw', 'pmovmskb', ...Object.keys(CC)]);

/** MASM numbers: 0x3CE, 0ch, 43h, 255. */
function number(v) {
  const t = String(v).toLowerCase();
  let m = /^0x([0-9a-f]+)$/.exec(t) ?? /^([0-9][0-9a-f]*)h$/.exec(t);
  if (m) return parseInt(m[1], 16);
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  return fail(`the number '${v}'`);
}

const isP = (t, v) => t && t.k === PUNCT && t.v === v;
const lc = (t) => (t && t.k === ID ? t.v.toLowerCase() : null);
const isMM = (r) => /^mm[0-7]$/.test(r);

/** An address or immediate: a constant, base/index registers (one of them scaled), one C symbol. */
function expression(toks) {
  let i = 0;
  const pure = (x) => !x.regs.length && !x.sym;
  const add = (a, b, sign) => {
    if (sign < 0 && !pure(b)) fail('subtracting a register or a symbol');
    if (a.sym && b.sym) fail('two symbols in one operand');
    return { c: a.c + sign * b.c, regs: [...a.regs, ...b.regs], sym: a.sym ?? b.sym };
  };
  const factor = () => {
    const t = toks[i++];
    if (!t) fail('an operand that ends too soon');
    if (isP(t, '(')) { const v = sum(); if (!isP(toks[i++], ')')) fail('an unclosed parenthesis'); return v; }
    if (isP(t, '-')) { const v = factor(); if (!pure(v)) fail('negating a register'); return { c: -v.c, regs: [], sym: null }; }
    if (isP(t, '+')) return factor();
    if (t.k === NUM) return { c: number(t.v), regs: [], sym: null };
    if (t.k === ID) {
      const r = t.v.toLowerCase();
      if (R32.includes(r)) return { c: 0, regs: [{ r, scale: 1 }], sym: null };
      if (SUB[r] || isMM(r)) fail(`'${t.v}' inside an address`);
      return { c: 0, regs: [], sym: t.v };
    }
    return fail(`'${t.v}' in an operand`);
  };
  const term = () => {
    let v = factor();
    while (isP(toks[i], '*')) {
      i++;
      const w = factor();
      if (v.regs.length === 1 && pure(w) && !v.c && !v.sym) v = { c: 0, regs: [{ r: v.regs[0].r, scale: v.regs[0].scale * w.c }], sym: null };
      else if (w.regs.length === 1 && pure(v) && !w.c && !w.sym) v = { c: 0, regs: [{ r: w.regs[0].r, scale: w.regs[0].scale * v.c }], sym: null };
      else if (pure(v) && pure(w)) v = { c: v.c * w.c, regs: [], sym: null };
      else fail('scaling a symbol');
    }
    return v;
  };
  const sum = () => {
    let v = term();
    while (isP(toks[i], '+') || isP(toks[i], '-')) {
      const sign = toks[i++].v === '+' ? 1 : -1;
      v = add(v, term(), sign);
    }
    return v;
  };
  const v = sum();
  if (i !== toks.length) fail(`'${toks[i].v}' in an operand`);
  return v;
}

/** One operand: a general or MMX register, an immediate, or memory. */
function operand(toks) {
  let size = null, bracket = false, offset = false;
  const rest = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], w = lc(t);
    if (w && PTR_SIZE[w] && lc(toks[i + 1]) === 'ptr') { size = PTR_SIZE[w]; i++; continue; }
    if (w === 'offset') { offset = true; continue; }
    // Brackets are addition: `x[esi]`, `[esi]4` and `[esi][ecx]` are x+esi, esi+4 and esi+ecx.
    const opPunct = (u) => u && u.k === PUNCT && '+-*('.includes(u.v);
    if (isP(t, '[')) { bracket = true; if (rest.length && !opPunct(rest.at(-1))) rest.push({ k: PUNCT, v: '+' }); continue; }
    if (isP(t, ']')) { const n = toks[i + 1]; if (n && !isP(n, '[') && !opPunct(n) && !isP(n, ')')) rest.push({ k: PUNCT, v: '+' }); continue; }
    rest.push(t);
  }
  if (!rest.length) fail('an empty operand');
  if (rest.length === 1 && !bracket && !size && !offset && rest[0].k === ID) {
    const r = rest[0].v.toLowerCase();
    if (r === 'esp' || r === 'ebp') fail(`${r} (the frame is PRISM's, not Visual C++'s)`);
    if (R32.includes(r)) return { kind: 'reg', reg: r, size: 4 };
    if (SUB[r]) return { kind: 'reg', reg: r, size: SUB[r][1] };
    if (isMM(r)) return { kind: 'mm', n: Number(r[2]), size: 8 };
    if (/^xmm[0-7]$/.test(r)) fail(`the SSE register ${r}`);
    if (/^st$/.test(r)) fail('the x87 stack');
  }
  const e = expression(rest);
  if (offset) {
    if (!e.sym || e.regs.length) fail('OFFSET of something other than a symbol');
    return { kind: 'offset', sym: e.sym, c: e.c };
  }
  if (!bracket && !e.sym && !e.regs.length) return { kind: 'imm', value: e.c, size };
  if (e.regs.length > 2) fail('an address with more than two registers');
  if (e.regs.filter((x) => x.scale !== 1).length > 1) fail('an address with two scaled registers');
  for (const x of e.regs) {
    if (x.r === 'esp' || x.r === 'ebp') fail(`[${x.r}] (the frame is PRISM's, not Visual C++'s)`);
    if (![1, 2, 4, 8].includes(x.scale)) fail(`the scale ${x.scale}`);
  }
  // A bare name with no register is either memory or a label: lowering decides, knowing the labels.
  return { kind: 'mem', size, regs: e.regs, sym: e.sym, c: e.c, bare: !bracket };
}

function splitOperands(toks) {
  const ops = [[]];
  let depth = 0;
  for (const t of toks) {
    if (isP(t, '[') || isP(t, '(')) depth++;
    if (isP(t, ']') || isP(t, ')')) depth--;
    if (isP(t, ',') && depth === 0) { ops.push([]); continue; }
    ops.at(-1).push(t);
  }
  return ops.filter((o) => o.length);
}

/** One line (a token list) into { label } or { op, ops, text }; a line may be `label: instruction`. */
export function parseLine(toks) {
  const text = toks.map((t) => t.v).join(' ');
  try {
    if (toks[0]?.k === ID && isP(toks[1], ':')) {
      const rest = toks.slice(2);
      return [{ label: toks[0].v, text }, ...(rest.length ? parseLine(rest) : [])];
    }
    const op = lc(toks[0]);
    if (!op) fail(`'${toks[0]?.v}' where an instruction was expected`);
    if (op === 'call' || op === 'int') fail(op);
    if (op === 'rep' || /^(stos|lods|movs|scas|cmps)[bwd]$/.test(op)) fail(`the string instruction '${op}'`);
    if (/^f/.test(op)) fail(`the x87 instruction '${op}'`);
    if (!KNOWN.has(op)) fail(`the instruction '${op}'`);
    if (op in CC || op === 'jmp') {
      const rest = toks.slice(1);
      if (rest.length === 1 && rest[0].k === ID) {
        const r = rest[0].v.toLowerCase();
        if (R32.includes(r)) return [{ op: 'jmpreg', reg: r, text }];
        return [{ op, label: rest[0].v, text }];
      }
      fail(`${op} to something other than a label or a register`);
    }
    return [{ op, ops: splitOperands(toks.slice(1)).map(operand), text }];
  } catch (e) {
    if (e instanceof MsvcAsmError && !e.message.includes(' -- in `')) e.message = `${e.message} -- in \`${text}\``;
    throw e;
  }
}

/**
 * Replace every MSVC asm block in a function body with ordinary statements. Returns the new body,
 * the names the asm reads as memory (the emitter gives each a slot), and whether control falls off
 * the function's end straight out of an asm block.
 */
export function lowerMsvcAsm(body, { INT }) {
  const labels = new Set();
  const collect = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (n.n === 'label') labels.add(n.name);
    if (n.n === 'asmmsvc') for (const line of n.lines) if (line[0]?.k === ID && isP(line[1], ':')) labels.add(line[0].v);
    for (const k of Object.keys(n)) if (k !== 'type' && k !== 'loc' && k !== 'sym') collect(n[k]);
  };
  collect(body);
  const names = new Set();
  const labelTaken = new Set();
  const lower = (node) => {
    const items = [];
    for (const line of node.lines) {
      for (const ins of parseLine(line)) {
        if (ins.label !== undefined && ins.op === undefined) { items.push({ n: 'label', name: ins.label, body: { n: 'empty' } }); continue; }
        if (ins.op === 'jmpreg') { items.push({ n: 'gotoexpr', expr: { n: 'asmval', js: `$e.${ins.reg}`, type: INT } }); continue; }
        if (ins.label !== undefined) {
          if (!labels.has(ins.label)) fail(`${ins.op} to '${ins.label}', which is not a label of this function -- in \`${ins.text}\``);
          const go = { n: 'goto', label: ins.label };
          items.push(ins.op === 'jmp' ? go : { n: 'if', cond: { n: 'asmcc', js: CC[ins.op], type: INT }, then: go, els: null });
          continue;
        }
        // `lea reg,label` -- a label's address, which is its state number.
        if (ins.op === 'lea' && ins.ops[1]?.kind === 'mem' && ins.ops[1].bare && labels.has(ins.ops[1].sym) && !ins.ops[1].regs.length && !ins.ops[1].c) {
          labelTaken.add(ins.ops[1].sym);
          items.push({ n: 'asmins', ins: { isa: 'msvc', op: 'lealabel', ops: ins.ops, label: ins.ops[1].sym, text: ins.text } });
          continue;
        }
        for (const o of ins.ops) if (o.sym) names.add(o.sym);
        items.push({ n: 'asmins', ins: { isa: 'msvc', ...ins } });
      }
    }
    return { n: 'block', items, asm: true };
  };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(walk);
    if (n.n === 'asmmsvc') return lower(n);
    let out = n;
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'loc' || k === 'sym') continue;
      const v = n[k];
      if (v && typeof v === 'object') {
        const w = walk(v);
        if (w !== v) { if (out === n) out = { ...n }; out[k] = w; }
      }
    }
    return out;
  };
  // `__asm { emms };` ends in an empty statement, which control passes straight through.
  const last = (items) => { const real = (items ?? []).filter((x) => x.n !== 'empty'); return real.at(-1); };
  const endsInAsm = (s) => !!s && (s.n === 'asmmsvc' || (s.n === 'label' && endsInAsm(s.body)) || (s.n === 'block' && endsInAsm(last(s.items))));
  return { body: walk(body), names, labelTaken, endsInAsm: endsInAsm(last(body?.items)) };
}

// --------------------------------------------------------------------------------------------------
// Emission. `env` is the emitter's side of the contract:
//   env.symbol(name)         -> { addr: js, type }    (memory, always)
//   env.load(addr, size)     -> js  (unsigned)
//   env.store(addr, size, v) -> js statement
//   env.labelIndex(name)     -> the label's state number
// --------------------------------------------------------------------------------------------------

/** The width a C object's type gives an operand that names it. */
function symbolSize(type) {
  let t = type;
  while (t?.k === 'array') t = t.of;
  // A struct names no width: `inc [s]` has to say which of its bytes it means.
  return t && t.k !== 'struct' && t.k !== 'union' && [1, 2, 4, 8].includes(t.size) ? t.size : null;
}

/** Read a general register at its width, unsigned. */
function rdReg(r) {
  if (R32.includes(r)) return `($e.${r}>>>0)`;
  const [full, size, shift] = SUB[r];
  return `(($e.${full}>>>${shift})&${MASK[size]})`;
}
function wrReg(r, v) {
  if (R32.includes(r)) return `$e.${r}=(${v})|0;`;
  const [full, size, shift] = SUB[r];
  const keep = ~(MASK[size] << shift) >>> 0;
  return `$e.${full}=(($e.${full}&${keep | 0})|(((${v})&${MASK[size]})<<${shift}))|0;`;
}

/** Flags at width w from the inputs and the unmasked result; `k` names the operation family. */
function flagsJs(k, a, b, r, w) {
  const mask = MASK[w], sign = w === 4 ? 0x80000000 : w === 2 ? 0x8000 : 0x80;
  const zs = `$e.zf=((${r})&${mask})===0?1:0;$e.sf=((${r})&${sign})!==0?1:0;`;
  switch (k) {
    case 'add': return zs + `$e.cf=(${r})>${mask}?1:0;$e.of=((~((${a})^(${b}))&((${a})^(${r}))&${sign})!==0)?1:0;`;
    case 'sub': return zs + `$e.cf=(${a})<(${b})?1:0;$e.of=((((${a})^(${b}))&((${a})^(${r}))&${sign})!==0)?1:0;`;
    case 'logic': return zs + '$e.cf=0;$e.of=0;';
    default: throw new Error(k);
  }
}

export function emitInstruction(ins, env) {
  const { op, ops = [] } = ins;
  const line = `/* ${ins.text.replace(/\*\//g, '* /')} */`;
  try {
    return line + emit(ins, op, ops, env);
  } catch (e) {
    if (e instanceof MsvcAsmError && !e.message.includes(' -- in `')) e.message = `${e.message} -- in \`${ins.text}\``;
    throw e;
  }
}

function emit(ins, op, ops, env) {
  /** The linear address of a memory operand, as a JS expression. */
  const addr = (o) => {
    const parts = [];
    if (o.sym) {
      const s = env.symbol(o.sym);
      if (s.isFunc) fail(`the function '${o.sym}' as memory`);
      parts.push(s.addr);
    }
    for (const x of o.regs) parts.push(x.scale === 1 ? `$e.${x.r}` : `Math.imul($e.${x.r},${x.scale})`);
    if (o.c) parts.push(String(o.c | 0));
    return parts.length ? `((${parts.join('+')})|0)` : '0';
  };
  /** The width of a memory operand: as written, else the named object's, else the other operand's. */
  const memSize = (o, other) => {
    if (o.size) return o.size;
    if (other) return other;
    if (o.sym) { const z = symbolSize(env.symbol(o.sym).type); if (z) return z; }
    return fail('an operand whose size nothing states (write BYTE/WORD/DWORD PTR)');
  };
  const regSize = (o) => (o?.kind === 'reg' ? o.size : null);
  const width = (a, b) => {
    const w = regSize(a) ?? regSize(b) ?? (a?.kind === 'mem' ? memSize(a, null) : null) ?? (b?.kind === 'mem' ? memSize(b, null) : 4);
    return MASK[w] ? w : fail(`a ${w}-byte operand for ${op}`);
  };
  const rd = (o, w) => {
    if (o.kind === 'reg') return rdReg(o.reg);
    if (o.kind === 'imm') return String((o.value & MASK[w]) >>> 0);
    if (o.kind === 'offset') return `((${env.symbol(o.sym).addr}+${o.c | 0})>>>0)`;
    if (o.kind === 'mem') {
      const z = memSize(o, w);
      if (z !== w) fail(`a ${z}-byte memory operand where ${w} bytes are wanted`);
      // Unsigned at every width: the flags compare the operands as unsigned numbers.
      return `(${env.load(addr(o), w)}>>>0)`;
    }
    return fail(`a ${o.kind} operand here`);
  };
  const wr = (o, v, w) => {
    if (o.kind === 'reg') return wrReg(o.reg, v);
    if (o.kind === 'mem') {
      const z = memSize(o, w);
      if (z !== w) fail(`a ${z}-byte memory operand where ${w} bytes are wanted`);
      return `$a=${addr(o)};` + env.store('$a', w, v) + ';';
    }
    return fail(`writing a ${o.kind} operand`);
  };
  /** An MMX source: a register number, after loading memory into the scratch one. */
  const mmSrc = (o) => {
    if (o.kind === 'mm') return { pre: '', n: o.n };
    if (o.kind === 'mem') {
      const z = memSize(o, 8);
      if (z !== 8) fail(`a ${z}-byte memory operand for an MMX source`);
      return { pre: `$t=${addr(o)};$x.ld(${env.load('$t', 4)},${env.load('($t+4|0)', 4)});`, n: MM_SCRATCH };
    }
    return fail(`a ${o.kind} operand as an MMX source`);
  };
  const need = (n) => { if (ops.length !== n) fail(`${op} with ${ops.length} operands`); };
  const mm = (o) => { if (o.kind !== 'mm') fail(`${op} wants an MMX register, not a ${o.kind} operand`); return o.n; };

  if (op === 'lealabel') return `${wrReg(ops[0].reg, String(env.labelIndex(ins.label)))}`;

  if (MMX_BINARY.has(op)) {
    need(2);
    const s = mmSrc(ops[1]);
    return `${s.pre}$x.${op}(${mm(ops[0])},${s.n});`;
  }
  if (MMX_SHIFT.has(op)) {
    need(2);
    if (ops[1].kind === 'imm') return `$x.${op}(${mm(ops[0])},-1,${ops[1].value & 0xff});`;
    const s = mmSrc(ops[1]);
    return `${s.pre}$x.${op}(${mm(ops[0])},${s.n},0);`;
  }

  switch (op) {
    case 'nop': case 'emms': return '';
    case 'clc': return '$e.cf=0;';
    case 'stc': return '$e.cf=1;';
    case 'cmc': return '$e.cf^=1;';
    case 'cdq': return '$e.edx=$e.eax>>31;';

    case 'movq': case 'movntq': {
      need(2);
      const [d, s] = ops;
      if (d.kind === 'mm') { const src = mmSrc(s); return `${src.pre}$x.movq(${d.n},${src.n});`; }
      if (d.kind === 'mem') {
        if (memSize(d, 8) !== 8) fail('a movq store of other than eight bytes');
        const n = mm(s);
        return `$t=${addr(d)};${env.store('$t', 4, `$x.lo(${n})`)};${env.store('($t+4|0)', 4, `$x.hi(${n})`)};`;
      }
      return fail(`${op} to a ${d.kind} operand`);
    }
    case 'movd': {
      need(2);
      const [d, s] = ops;
      if (d.kind === 'mm') {
        if (s.kind === 'reg' && s.size !== 4) fail('movd from a narrow register');
        return `$x.movdIn(${d.n},${rd(s, 4)});`;
      }
      return wr(d, `$x.lo(${mm(s)})`, 4);
    }
    case 'pshufw': {
      need(3);
      if (ops[2].kind !== 'imm') fail('pshufw without an immediate order');
      const s = mmSrc(ops[1]);
      return `${s.pre}$x.pshufw(${mm(ops[0])},${s.n},${ops[2].value & 0xff});`;
    }
    case 'pinsrw': {
      need(3);
      if (ops[2].kind !== 'imm') fail('pinsrw without an immediate lane');
      const src = ops[1].kind === 'reg' ? rdReg(ops[1].reg) : rd(ops[1], 2);
      return `$x.pinsrw(${mm(ops[0])},${src},${ops[2].value & 3});`;
    }
    case 'pextrw': {
      need(3);
      if (ops[0].kind !== 'reg' || ops[0].size !== 4 || ops[2].kind !== 'imm') fail('pextrw other than into a 32-bit register');
      return wrReg(ops[0].reg, `$x.pextrw(${mm(ops[1])},${ops[2].value & 3})`);
    }
    case 'pmovmskb': {
      need(2);
      if (ops[0].kind !== 'reg' || ops[0].size !== 4) fail('pmovmskb other than into a 32-bit register');
      return wrReg(ops[0].reg, `$x.pmovmskb(${mm(ops[1])})`);
    }

    case 'mov': {
      need(2);
      const w = width(ops[0], ops[1]);
      return wr(ops[0], rd(ops[1], w), w);
    }
    case 'movzx': case 'movsx': {
      need(2);
      const dw = regSize(ops[0]) ?? fail(`${op} into memory`);
      const sw = ops[1].kind === 'reg' ? ops[1].size : memSize(ops[1], null);
      if (sw >= dw) fail(`${op} from ${sw} bytes into ${dw}`);
      const v = rd(ops[1], sw);
      const sh = 32 - sw * 8;
      return wrReg(ops[0].reg, op === 'movzx' ? v : `((${v})<<${sh}>>${sh})`);
    }
    case 'lea': {
      need(2);
      if (ops[0].kind !== 'reg' || ops[0].size !== 4 || ops[1].kind !== 'mem') fail('lea other than a 32-bit register from an address');
      return wrReg(ops[0].reg, addr(ops[1]));
    }
    case 'xchg': {
      need(2);
      const w = width(ops[0], ops[1]);
      return `$u=${rd(ops[0], w)};$v=${rd(ops[1], w)};${wr(ops[0], '$v', w)}${wr(ops[1], '$u', w)}`;
    }
    case 'push': {
      need(1);
      return `$stk.push(${rd(ops[0], 4)});`;
    }
    case 'pop': {
      need(1);
      return `if(!$stk.length)throw new Error("MSVC inline assembly: pop with nothing pushed");${wr(ops[0], '$stk.pop()', 4)}`;
    }

    case 'add': case 'sub': case 'cmp': case 'and': case 'or': case 'xor': case 'test': case 'adc': {
      need(2);
      const w = width(ops[0], ops[1]);
      const mask = MASK[w];
      const a = `$u=${rd(ops[0], w)};`, b = `$v=${rd(ops[1], w)};`;
      let r, fl;
      switch (op) {
        case 'add': r = '$u+$v'; fl = flagsJs('add', '$u', '$v', '$t', w); break;
        case 'adc': r = '$u+$v+$e.cf'; fl = flagsJs('add', '$u', '$v', '$t', w); break;
        case 'sub': case 'cmp': r = '$u-$v'; fl = flagsJs('sub', '$u', '$v', '$t', w); break;
        case 'and': case 'test': r = '($u&$v)>>>0'; fl = flagsJs('logic', '$u', '$v', '$t', w); break;
        case 'or': r = '($u|$v)>>>0'; fl = flagsJs('logic', '$u', '$v', '$t', w); break;
        case 'xor': r = '($u^$v)>>>0'; fl = flagsJs('logic', '$u', '$v', '$t', w); break;
      }
      const body = `${a}${b}$t=${r};${fl}`;
      return op === 'cmp' || op === 'test' ? body : body + wr(ops[0], `$t&${mask}`, w);
    }
    case 'inc': case 'dec': {
      need(1);
      const w = width(ops[0], null), mask = MASK[w], sign = w === 4 ? 0x80000000 : w === 2 ? 0x8000 : 0x80;
      // CF is not touched by inc and dec.
      const r = op === 'inc' ? '$u+1' : '$u-1';
      const of = op === 'inc' ? `(($t&${mask})>>>0)===${sign}` : `(($t&${mask})>>>0)===${sign - 1}`;
      return `$u=${rd(ops[0], w)};$t=(${r})>>>0;$e.zf=($t&${mask})===0?1:0;$e.sf=($t&${sign})!==0?1:0;$e.of=${of}?1:0;`
        + wr(ops[0], `$t&${mask}`, w);
    }
    case 'neg': {
      need(1);
      const w = width(ops[0], null), mask = MASK[w];
      return `$u=0;$v=${rd(ops[0], w)};$t=$u-$v;${flagsJs('sub', '$u', '$v', '$t', w)}$e.cf=$v!==0?1:0;` + wr(ops[0], `$t&${mask}`, w);
    }
    case 'not': {
      need(1);
      const w = width(ops[0], null);
      return wr(ops[0], `(~${rd(ops[0], w)})&${MASK[w]}`, w);
    }
    case 'shl': case 'sal': case 'shr': case 'sar': {
      need(2);
      const w = width(ops[0], null), bits = w * 8, mask = MASK[w], sign = w === 4 ? 0x80000000 : w === 2 ? 0x8000 : 0x80;
      const c = ops[1].kind === 'imm' ? String(ops[1].value & 31)
        : ops[1].kind === 'reg' && ops[1].reg === 'cl' ? '($e.ecx&31)' : fail(`${op} by something other than an immediate or cl`);
      const sx = 32 - bits;
      const r = op === 'shr' ? `($u>>>$v)` : op === 'sar' ? `(((($u<<${sx})>>${sx})>>$v)&${mask})>>>0`
        : `$v>=32?0:(($u<<$v)&${mask})>>>0`;
      // A count of zero changes nothing, flags included. CF is the last bit shifted out; OF is
      // defined for a count of one, and left as the SDM leaves it otherwise -- this file does not
      // invent a value for an undefined flag, it keeps the earlier one.
      const cf = op === 'shl' || op === 'sal' ? `$e.cf=$v<=${bits}?(($u>>>(${bits}-$v))&1):0;` : `$e.cf=(${op === 'sar' ? `(($u<<${sx})>>${sx})` : '$u'}>>>Math.min($v-1,31))&1;`;
      const of = op === 'shr' ? `if($v===1)$e.of=($u&${sign})!==0?1:0;` : op === 'sar' ? 'if($v===1)$e.of=0;'
        : `if($v===1)$e.of=((($t&${sign})!==0?1:0)^$e.cf);`;
      return `$u=${rd(ops[0], w)};$v=${c};if($v){$t=${r};${cf}$e.zf=($t&${mask})===0?1:0;$e.sf=($t&${sign})!==0?1:0;${of}${wr(ops[0], '$t', w)}}`;
    }
    case 'imul': {
      if (ops.length === 2 || ops.length === 3) {
        const d = ops[0];
        if (d.kind !== 'reg' || d.size !== 4) fail('imul into other than a 32-bit register');
        const a = ops.length === 3 ? rd(ops[1], 4) : rdReg(d.reg);
        const b = ops.length === 3 ? rd(ops[2], 4) : rd(ops[1], 4);
        // CF = OF = the product does not fit 32 bits signed. SF and ZF are undefined, and kept.
        return `$u=${a}|0;$v=${b}|0;$t=Math.imul($u,$v);$e.cf=$e.of=($u*$v!==$t)?1:0;${wrReg(d.reg, '$t')}`;
      }
      need(1);
      return `{const _p=BigInt(${rd(ops[0], 4)}|0)*BigInt($e.eax|0);$e.eax=Number(BigInt.asIntN(32,_p));`
        + `$e.edx=Number(BigInt.asIntN(32,_p>>32n));$e.cf=$e.of=(_p<-2147483648n||_p>2147483647n)?1:0;}`;
    }
  }
  return fail(`the instruction '${op}'`);
}
