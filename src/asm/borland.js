// borland.js — Borland C++'s inline assembly, real mode, translated to JavaScript.
//
//     asm mov es,[WORD PTR mapsegs+4]           // Keen Dreams, kd_play.c
//     asm mov ax,[es:si]
//     asm or ax,ax
//     asm jz nothing                            // `nothing:` is a C label
//
// Borland's asm is not a separate routine the way a .ASM file or a Watcom `#pragma aux` is: it is
// statements interleaved with C, naming C variables, jumping to C labels, and sharing the machine
// with code only Borland's generator produced. What makes it translatable is that the SHARING is
// narrow and documented:
//
//   * DS and SS both hold DGROUP at every function entry. PRISM's 16-bit layouts (dos16, dos16m) put
//     DGROUP at linear 0, so a near address IS its linear address and DS = SS = 0. That is why this
//     runs for those two models only; dos16l keeps the refusal.
//   * A C variable named in an operand is found by NAME: a static in DGROUP (DS-relative), a local
//     or a parameter on the stack (SS-relative). The emitter pins every local the asm names to a
//     stack slot, so each one is plain memory with an address -- as it was under Borland.
//   * Registers belong to the function: `mov es,...` in one asm statement is still there in the
//     next. The C code in between does not touch them -- Borland's own generator would clobber AX,
//     BX, CX, DX and ES there, so a program cannot rely on them surviving, and keeping them is the
//     one behaviour every correct program agrees with.
//   * Jumps go to C labels, so they are lowered to `if (flag) goto label` BEFORE the function is
//     emitted, and the C machinery for goto -- the state machine, flatten.js -- does the rest.
//   * A function that falls off its end right after an asm statement returns what is in AX (DX:AX
//     for a long), which is how Borland returns a value computed in assembly.
//
// FAR POINTERS ARE LINEAR IN PRISM, and asm sees their halves. `mov es,[WORD PTR dest+2]` reads the
// segment of `byte far *dest`. Wherever an operand's C type says it covers a far pointer, the two
// words are VIEWS of the linear address, decomposed normalised exactly as FP_OFF/FP_SEG are
// (headers-watcom.js): offset = L & 15, segment = L >> 4, and a write recombines seg*16 + off. A
// far pointer reached through a REGISTER rather than a name cannot be recognised, and reads its
// linear representation -- the same limit as C code that type-puns one.
//
// FLAGS: CF, ZF and SF, computed at the operation's width, which is every condition this
// translator accepts. A jump that needs OF or PF (jl, jg, jo, jp...) is refused by name rather than
// answered from a flag nobody computed. DF must stay clear (cld is honoured, std refused).
//
// Everything outside this subset is REFUSED BY NAME at compile time -- call, sp, cs/ss writes, and
// any read of a register the function never wrote, which is how Borland's own frame pointer is
// kept out: `[bp+4]` in a function that has not loaded bp reads what Borland's prologue put there.
// Memory through a bp the function DID load is ordinary, and SS-relative as the 8086 makes it
// (CAL_ShiftSprite points bp at a shift table). The two things only knowable at run time throw by
// name: a pushf word popped into a register, and a pop with nothing pushed.
//
// There is no Borland compiler to diff against. The instruction semantics are checked against
// Unicorn running the same instructions in real mode (tools/gate-borlandasm.mjs); the C-facing
// half -- names, labels, views, the return in AX -- is checked by executing it.
import { ID, NUM, PUNCT } from '../cpp/token.js';

export class BorlandAsmError extends Error {}
const fail = (m) => { throw new BorlandAsmError(m); };

const REG16 = new Set(['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp']);
const REG8 = { al: ['ax', 0], ah: ['ax', 8], bl: ['bx', 0], bh: ['bx', 8],
               cl: ['cx', 0], ch: ['cx', 8], dl: ['dx', 0], dh: ['dx', 8] };
const SREG = new Set(['es', 'ds', 'ss', 'cs']);
const PTR_SIZE = { byte: 1, word: 2, dword: 4 };
const MASK = { 1: 0xff, 2: 0xffff };
const SIGN = { 1: 0x80, 2: 0x8000 };

/** The registers a translated function declares. */
/**
 * The register file: ONE object per function invocation, shared by the asm and by Borland's
 * pseudo-registers. The asm reads and writes the plain fields (ax, bx, ...), which it keeps
 * masked itself; C reaches the same machine through accessors named as Borland spells them --
 * `_AX` is `$r.AX`, `_AL` is `$r.AL` -- which mask on the way in, and which make `_AL = 3` and
 * `_AH = 0` two halves of the ax that `mov dx,ax` or a BIOS service then reads.
 */
const W16 = ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'ds', 'es'];
const H8 = [['al', 'ax', 0], ['ah', 'ax', 8], ['bl', 'bx', 0], ['bh', 'bx', 8],
  ['cl', 'cx', 0], ['ch', 'cx', 8], ['dl', 'dx', 0], ['dh', 'dx', 8]];
export const REGISTER_FILE = '{' + [
  ...W16.map((r) => `${r}:0`), 'cf:0', 'zf:0', 'sf:0', 'df:0',
  // IF is the machine's (M.cpu), not the invocation's: CLI here masks the timer everywhere.
  'get if(){return M.cpu.if},set if(v){const was=M.cpu.if;M.cpu.if=v&1;if(!was&&(v&1))M.irqPoll?.(this)}',
  ...W16.map((r) => `get ${r.toUpperCase()}(){return this.${r}},set ${r.toUpperCase()}(v){this.${r}=v&65535}`),
  // The flags word Borland's _FLAGS reads (PUSHF): CF, ZF, SF, IF and DF, with bit 1 set. A flag
  // this machine could not know holds 2, and reading it through the word is refused like any other.
  'get FLAGS(){if(this.cf>1||this.zf>1||this.sf>1)throw new Error("Borland _FLAGS: a flag whose value is undefined here");'
    + 'return 2|this.cf|(this.zf<<6)|(this.sf<<7)|(this.if<<9)|(this.df<<10)}',
  'set FLAGS(v){this.cf=v&1;this.zf=(v>>6)&1;this.sf=(v>>7)&1;this.if=(v>>9)&1;this.df=(v>>10)&1}',
  ...H8.map(([h, r, sh]) => (sh
    ? `get ${h.toUpperCase()}(){return this.${r}>>>8},set ${h.toUpperCase()}(v){this.${r}=(this.${r}&255)|((v&255)<<8)}`
    : `get ${h.toUpperCase()}(){return this.${r}&255},set ${h.toUpperCase()}(v){this.${r}=(this.${r}&65280)|(v&255)}`)),
].join(',') + '}';

/** The locals a function using the register file declares. */
export const REGISTER_DECLS = `var $r=${REGISTER_FILE},$t=0,$u=0,$v=0,$stk=[];`;

/**
 * Conditions, as JavaScript over the flags this file computes. A flag holding 2 is UNKNOWN: set by
 * arithmetic on half of a far pointer, whose normalised offset is not the one Borland's pointer held,
 * or CF after a shift by the operand's full width. Reading one throws by name instead of branching
 * on a guess.
 */
const CC = {
  jz: '$r.zf', je: '$r.zf', jnz: '!$r.zf', jne: '!$r.zf',
  jc: '$r.cf', jb: '$r.cf', jnae: '$r.cf', jnc: '!$r.cf', jnb: '!$r.cf', jae: '!$r.cf',
  js: '$r.sf', jns: '!$r.sf',
  jbe: '($r.cf||$r.zf)', jna: '($r.cf||$r.zf)', ja: '(!$r.cf&&!$r.zf)', jnbe: '(!$r.cf&&!$r.zf)',
  jcxz: '($r.cx===0)',
};
const FLAGS_OF = (js) => ['$r.cf', '$r.zf', '$r.sf'].filter((f) => js.includes(f));
export function conditionJs(op) {
  const js = op === 'loop' ? '($r.cx!==0)' : CC[op];
  const fl = FLAGS_OF(js);
  if (!fl.length) return js;
  return `(${fl.map((f) => `${f}>1`).join('||')}?${THROW('a flag whose value is undefined here (arithmetic on half of a far pointer, or a shift by the full width)')}:${js})`;
}
const NEEDS_OF_PF = new Set(['jl', 'jnge', 'jge', 'jnl', 'jle', 'jng', 'jg', 'jnle', 'jo', 'jno',
  'jp', 'jpe', 'jnp', 'jpo']);

const ALU = new Set(['add', 'sub', 'and', 'or', 'xor', 'cmp', 'test']);
const STRING = { stosb: 1, stosw: 2, lodsb: 1, lodsw: 2, movsb: 1, movsw: 2 };
const NOARG = new Set(['cli', 'sti', 'cld', 'clc', 'stc', 'cmc', 'nop', 'pushf', 'popf', 'std']);
const KNOWN = new Set([...ALU, ...Object.keys(STRING), ...NOARG, 'mov', 'xchg', 'inc', 'dec', 'not',
  'neg', 'shl', 'sal', 'shr', 'sar', 'push', 'pop', 'in', 'out', 'les', 'lds', 'jmp', 'loop', 'int',
  ...Object.keys(CC)]);

/** MASM numbers: 0x3CE, 0ch, 43h, 255. */
function number(v) {
  const t = String(v).toLowerCase();
  let m = /^0x([0-9a-f]+)$/.exec(t) ?? /^([0-9][0-9a-f]*)h$/.exec(t);
  if (m) return parseInt(m[1], 16);
  if ((m = /^([01]+)b$/.exec(t))) return parseInt(m[1], 2);    // TASM's binary, as in its equates
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  return fail(`the number '${v}'`);
}

const isP = (t, v) => t && t.k === PUNCT && t.v === v;
const lc = (t) => (t && t.k === ID ? t.v.toLowerCase() : null);

/**
 * An address or immediate expression, as a linear combination: a constant, base/index registers
 * and at most one C symbol, each added. `grsegs+368*2`, `tilecache+bx`, `5+256*0`.
 */
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
      if (REG16.has(r)) return { c: 0, regs: [r], sym: null };
      if (REG8[r] || SREG.has(r)) fail(`'${t.v}' inside an address`);
      return { c: 0, regs: [], sym: t.v };
    }
    return fail(`'${t.v}' in an operand`);
  };
  const term = () => {
    let v = factor();
    while (isP(toks[i], '*') || isP(toks[i], '/')) {
      const op = toks[i++].v;
      const w = factor();
      if (!pure(v) || !pure(w)) fail('scaling a register or a symbol');
      v = { c: op === '*' ? v.c * w.c : Math.trunc(v.c / w.c), regs: [], sym: null };
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

/** One operand: a register, a segment register, an immediate, OFFSET sym, or memory. */
function operand(toks) {
  let size = null, seg = null, bracket = false, offset = false;
  const rest = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], w = lc(t);
    if (w && PTR_SIZE[w] && lc(toks[i + 1]) === 'ptr') { size = PTR_SIZE[w]; i++; continue; }
    // TASM's IDEAL mode writes the size without PTR: `[BYTE bx+di]`, `[WORD es:di]`.
    if (w && PTR_SIZE[w] && toks[i + 1] && !isP(toks[i + 1], ',') && !isP(toks[i + 1], ']')) { size = PTR_SIZE[w]; continue; }
    if (w === 'offset') { offset = true; continue; }
    if (w && SREG.has(w) && isP(toks[i + 1], ':')) { seg = w; i++; continue; }
    // Brackets are addition: `x[bx]` and `[bx][si]` are x+bx and bx+si.
    const opPunct = (u) => u && u.k === PUNCT && '+-*/('.includes(u.v);
    if (isP(t, '[')) { bracket = true; if (rest.length && !opPunct(rest.at(-1))) rest.push({ k: PUNCT, v: '+' }); continue; }
    if (isP(t, ']')) { bracket = true; const n = toks[i + 1]; if (n && !isP(n, '[') && !opPunct(n) && !isP(n, ')')) rest.push({ k: PUNCT, v: '+' }); continue; }
    rest.push(t);
  }
  if (!rest.length) fail('an empty operand');
  if (rest.length === 1 && !bracket && !seg && !size && !offset && rest[0].k === ID) {
    const r = rest[0].v.toLowerCase();
    if (REG16.has(r)) return { kind: 'reg', reg: r, size: 2 };
    if (REG8[r]) return { kind: 'reg8', reg: r, size: 1 };
    if (SREG.has(r)) return { kind: 'sreg', reg: r, size: 2 };
  }
  const e = expression(rest);
  if (offset) {
    if (!e.sym || e.regs.length) fail('OFFSET of something other than a symbol');
    return { kind: 'offset', sym: e.sym, c: e.c };
  }
  if (!bracket && !seg && !e.sym && !e.regs.length) return { kind: 'imm', value: e.c, size };
  const regs = e.regs;
  const bases = regs.filter((r) => r === 'bx' || r === 'bp'), idx = regs.filter((r) => r === 'si' || r === 'di');
  if (bases.length + idx.length !== regs.length || bases.length > 1 || idx.length > 1) {
    fail(`the address [${regs.join('+')}], which the 8086 cannot form`);
  }
  return { kind: 'mem', size, seg, regs, sym: e.sym, c: e.c };
}

export { operand as parseOperand };

/** Split an instruction's tokens into operands on top-level commas. */
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

export { splitOperands };

/** Parse one instruction line (a token list) into { op, rep, ops, label }. */
export function parseInstruction(toks) {
  const text = toks.map((t) => t.v).join(' ');
  try {
    let i = 0;
    let op = lc(toks[i++]);
    if (!op) fail(`'${toks[0]?.v}' where an instruction was expected`);
    let rep = null;
    if (['rep', 'repe', 'repz', 'repne', 'repnz'].includes(op)) { rep = op; op = lc(toks[i++]); }
    if (!op) fail('rep with no instruction');
    if (isP(toks[i], ':')) fail('a label inside asm (Borland labels are C labels)');
    if (op === 'call') fail('call');
    if (NEEDS_OF_PF.has(op)) fail(`${op}, which reads OF or PF`);
    if (!KNOWN.has(op)) fail(`the instruction '${op}'`);
    if (rep && !(op in STRING)) fail(`${rep} ${op}`);
    if (rep && rep !== 'rep') fail(`${rep}, which compares`);
    if (op === 'std') fail('std (string operations run upward only)');
    if (op in CC || op === 'jmp' || op === 'loop') {
      // A jump's operand is a LABEL, which C keeps in a namespace of its own: Keen Dreams jumps to
      // `nothing:` in a file where `nothing` is also an enum constant the parser has already folded.
      const rest = toks.slice(i);
      const name = rest.length === 1 ? (rest[0].k === ID ? rest[0].v : rest[0].enumOf) : undefined;
      if (name === undefined) fail(`${op} to something other than a label`);
      return { op, rep, ops: [], label: name, text };
    }
    const ops = splitOperands(toks.slice(i)).map(operand);
    return { op, rep, ops, text };
  } catch (e) {
    if (e instanceof BorlandAsmError) e.message = `${e.message} -- in \`${text}\``;
    throw e;
  }
}

/**
 * Replace every Borland asm statement in a function body with ordinary statements: `asmins` for
 * an instruction, and `if (asmcc) goto label;` for a jump. Returns the new body and the names the
 * asm mentions, which the emitter must keep in memory.
 */
export function lowerBorlandAsm(body, { INT }) {
  const names = new Set();
  const labels = new Set();
  const collect = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (n.n === 'label') labels.add(n.name);
    for (const k of Object.keys(n)) if (k !== 'type' && k !== 'loc' && k !== 'sym') collect(n[k]);
  };
  collect(body);
  let last = false;
  const lower = (node) => {
    const items = [];
    for (const line of node.lines ?? []) {
      const ins = parseInstruction(line);
      for (const o of ins.ops) if (o.sym) names.add(o.sym);
      if (ins.label !== undefined) {
        if (!labels.has(ins.label)) fail(`${ins.op} to '${ins.label}', which is not a label of this function`);
        const go = { n: 'goto', label: ins.label };
        if (ins.op === 'jmp') { items.push(go); continue; }
        if (ins.op === 'loop') {
          items.push({ n: 'asmins', ins: { op: 'loopdec', ops: [], text: ins.text } });
          items.push({ n: 'if', cond: { n: 'asmcc', js: conditionJs('loop'), type: INT }, then: go, els: null });
          continue;
        }
        items.push({ n: 'if', cond: { n: 'asmcc', js: conditionJs(ins.op), type: INT }, then: go, els: null });
        continue;
      }
      items.push({ n: 'asmins', ins });
    }
    return { n: 'block', items, asm: true };
  };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(walk);
    if (n.n === 'asmborland') return lower(n);
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
  const items = body?.items ?? [];
  last = items.length > 0 && endsInAsm(items.at(-1));
  return { body: walk(body), names, endsInAsm: last };
}

/** Does control fall off the end of this statement straight out of an asm statement? */
function endsInAsm(s) {
  if (!s) return false;
  if (s.n === 'asmborland') return true;
  if (s.n === 'label') return endsInAsm(s.body);
  if (s.n === 'block') return endsInAsm(s.items?.at(-1));
  return false;
}

// --------------------------------------------------------------------------------------------------
// Emission. `env` is the emitter's side of the contract:
//   env.symbol(name)       -> { addr: js, type, local: bool, near: number|null }   (memory, always)
//   env.load(addr, size)   -> js  (unsigned)
//   env.store(addr, size, v) -> js statement
// --------------------------------------------------------------------------------------------------

const POISON = '$r.cf=2;$r.zf=2;$r.sf=2;';

/**
 * `int n` -- from asm or from geninterrupt -- as one call into the environment: M.interrupt(n, $r)
 * reads the registers the program loaded and writes back what the service returns, flags included.
 * With no environment to answer, it throws by name rather than returning the registers unchanged.
 */
export const interruptJs = (n) => `(M.interrupt??${THROW('int with no interrupt dispatcher installed (the borland environment)')})(${n},$r)`;
const THROW = (msg) => `(()=>{throw new Error(${JSON.stringify(`Borland inline assembly: ${msg}`)})})()`;

/** The C scalars an access [off, off+size) of `type` covers, with their offsets. */
function scalarsAt(type, off, size, base = 0, out = []) {
  if (!type) return out;
  const end = base + (type.size ?? 0);
  if (off + size <= base || off >= end) return out;
  if (type.k === 'array') {
    const es = type.of.size;
    if (!es) return out;
    const first = Math.max(0, Math.floor((off - base) / es));
    const lastI = Math.min(type.len ?? Infinity, Math.ceil((off + size - base) / es));
    for (let k = first; k < lastI; k++) scalarsAt(type.of, off, size, base + k * es, out);
    return out;
  }
  if (type.k === 'struct' || type.k === 'union') {
    for (const f of type.fields ?? []) scalarsAt(f.type, off, size, base + (f.offset ?? 0), out);
    return out;
  }
  out.push({ type, start: base });
  return out;
}

/** Does this type hold a four-byte pointer anywhere? */
function holdsFarPointer(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (type.k === 'ptr') return type.size === 4;
  if (type.k === 'array') return holdsFarPointer(type.of, seen);
  if (type.k === 'struct' || type.k === 'union') return (type.fields ?? []).some((f) => holdsFarPointer(f.type, seen));
  return false;
}

/** The size MASM gives a named operand: its C type's, or an array's element's. */
function symbolSize(type) {
  let t = type;
  while (t && t.k === 'array') t = t.of;
  if (!t) return null;
  if (t.k === 'struct' || t.k === 'union') return null;
  return t.size ?? null;
}

export function emitInstruction(ins, env) {
  try {
    return new Translator(env).ins(ins);
  } catch (e) {
    if (e instanceof BorlandAsmError && !e.message.includes(' -- in `')) e.message = `${e.message} -- in \`${ins.text}\``;
    throw e;
  }
}

class Translator {
  constructor(env) { this.env = env; }

  /** Resolve a memory operand to an accessor for `size` bytes: { get, set(v) }. */
  mem(o, size) {
    const env = this.env;
    const regsum = o.regs.map((r) => `$r.${r}`).join('+');
    let segJs, near;
    if (o.sym) {
      const s = env.symbol(o.sym);
      if (s.isFunc) fail(`'${o.sym}', a function`);
      if (s.near === null) fail(`'${o.sym}', which lives outside DGROUP`);
      // SS for a local, and for any address based on bp -- the 8086's rule; DS otherwise.
      segJs = o.seg ? this.segRead(o.seg) : (s.local || o.regs.includes('bp') ? '0' : '$r.ds');
      near = s.addr;
      if (o.regs.length) {
        if (holdsFarPointer(s.type)) fail(`'${o.sym}' indexed by a register while it holds far pointers`);
      } else if (size <= 4) {
        const cover = scalarsAt(s.type, o.c, size);
        const far = cover.filter((x) => x.type.k === 'ptr' && x.type.size === 4);
        if (far.length) {
          if (cover.length !== 1) fail(`an access that straddles the far pointer '${o.sym}'`);
          if (far[0].type.to?.k === 'func') fail(`the halves of the function pointer '${o.sym}'`);
          return this.farView(`((${near})+${far[0].start}|0)`, o.c - far[0].start, size, o.sym);
        }
      }
    } else {
      segJs = o.seg ? this.segRead(o.seg) : (o.regs.includes('bp') ? '0' : '$r.ds');
      near = '0';
    }
    const off = `(((${near})+${regsum ? `${regsum}+` : ''}${o.c})&65535)`;
    const addr = `((${segJs}<<4)+${off})`;
    return { get: env.load(addr, size), set: (v) => `${env.store(addr, size, v)};`, addr, segJs, off };
  }

  /** The two words of a linear far pointer, as the segment:offset asm expects to see. */
  farView(addr, at, size, name) {
    const env = this.env;
    const L = env.load(addr, 4);
    if (size === 2 && at === 0) {
      return { view: true, get: `(${L}&15)`, set: (v) => `${env.store(addr, 4, `((${L}&-16)+((${v})&65535))`)};` };
    }
    if (size === 2 && at === 2) {
      return { view: true, get: `((${L}>>>4)&65535)`, set: (v) => `${env.store(addr, 4, `((((${v})&65535)<<4)+(${L}&15))`)};` };
    }
    if (size === 4 && at === 0) return { far: true, L, set: null };
    return fail(`${size === 1 ? 'a byte' : 'a word'} at +${at} of the far pointer '${name}'`);
  }

  segRead(s) {
    if (s === 'ss') return '0';
    if (s === 'cs') fail('cs, which PRISM has no value for');
    return `$r.${s}`;
  }

  /** An accessor for any operand at a known size. */
  acc(o, size) {
    switch (o.kind) {
      case 'reg':
        if (o.reg === 'sp') fail('sp');
        return { get: `$r.${o.reg}`, set: (v) => `$r.${o.reg}=(${v})&65535;` };
      case 'reg8': {
        const [r, sh] = REG8[o.reg];
        return sh
          ? { get: `($r.${r}>>>8)`, set: (v) => `$r.${r}=($r.${r}&255)|(((${v})&255)<<8);` }
          : { get: `($r.${r}&255)`, set: (v) => `$r.${r}=($r.${r}&65280)|((${v})&255);` };
      }
      case 'sreg':
        if (o.reg === 'cs') fail('cs, which PRISM has no value for');
        return { get: this.segRead(o.reg), set: (v) => (o.reg === 'ss' ? fail('writing ss') : `$r.${o.reg}=(${v})&65535;`) };
      case 'imm': return { get: String(o.value & (size === 1 ? 0xff : 0xffff)), set: () => fail('writing to an immediate') };
      case 'offset': {
        const s = this.env.symbol(o.sym);
        if (s.local) {
          // Borland's answer is the BP displacement in ITS frame, not an address (see emit.js).
          const disp = this.env.borlandFrameOffset?.(o.sym) ?? null;
          if (disp === null) fail(`OFFSET of the local '${o.sym}', whose place in Borland's frame is not known here (only a function's sole array, struct, long or char is)`);
          return { get: String((disp + o.c) & 0xffff), set: () => fail('writing to OFFSET') };
        }
        if (s.near === null) fail(`OFFSET of '${o.sym}', which lives outside DGROUP`);
        return { get: `(((${s.addr})+${o.c})&65535)`, set: () => fail('writing to OFFSET') };
      }
      case 'mem': return this.mem(o, size);
      default: return fail(`operand ${o.kind}`);
    }
  }

  /** The operation's width: a register's, or a PTR's, or the named C object's. */
  width(ops) {
    let size = null;
    const put = (s, why) => {
      if (s === null || s === undefined) return;
      if (size !== null && size !== s) fail(`operands of ${size} and ${s} bytes (${why})`);
      size = s;
    };
    for (const o of ops) {
      if (o.kind === 'reg' || o.kind === 'sreg' || o.kind === 'reg8') put(o.size, 'register');
    }
    for (const o of ops) if (o.kind === 'mem' && o.size) put(o.size, 'PTR');
    if (size === null) {
      for (const o of ops) {
        if (o.kind === 'mem' && o.sym) {
          const s = this.env.symbol(o.sym);
          put(symbolSize(s.type), `'${o.sym}'`);
        }
      }
    }
    if (size === null) fail('an operation whose size nothing states (write BYTE PTR or WORD PTR)');
    if (size !== 1 && size !== 2) fail(`a ${size}-byte operation`);
    return size;
  }

  flagsZS(r, w) { return `$r.zf=(${r})===0?1:0;$r.sf=(${r})&${SIGN[w]}?1:0;`; }

  ins(ins) {
    const { op, ops } = ins;
    const need = (n) => { if (ops.length !== n) fail(`${op} with ${ops.length} operand(s)`); };
    switch (op) {
      case 'nop': return '';
      case 'cli': return '$r.if=0;';
      case 'sti': return '$r.if=1;';
      case 'cld': return '$r.df=0;';
      case 'clc': return '$r.cf=0;';
      case 'stc': return '$r.cf=1;';
      case 'cmc': return '$r.cf^=1;';
      case 'loopdec': return '$r.cx=($r.cx-1)&65535;';
      case 'mov': {
        need(2);
        const w = this.width(ops);
        const d = this.acc(ops[0], w), s = this.acc(ops[1], w);
        if (d.far || s.far) fail('a whole far pointer moved in one instruction');
        return d.set(s.get);
      }
      case 'xchg': {
        need(2);
        const w = this.width(ops);
        const a = this.acc(ops[0], w), b = this.acc(ops[1], w);
        // Both read first, and the MEMORY operand written first: in `xchg bx,[es:bx]` the address
        // is computed from the bx the instruction started with.
        const [m, r] = ops[0].kind === 'mem' ? [a, b] : [b, a];
        return `$t=${m.get};$u=${r.get};${m.set('$u')}${r.set('$t')}`;
      }
      case 'add': case 'sub': case 'cmp': case 'and': case 'or': case 'xor': case 'test': {
        need(2);
        const w = this.width(ops);
        const d = this.acc(ops[0], w), s = this.acc(ops[1], w);
        const M = MASK[w];
        let code = `$t=${d.get};$u=${s.get};`;
        if (op === 'add') code += `$v=$t+$u;$r.cf=$v>${M}?1:0;$v&=${M};`;
        else if (op === 'sub' || op === 'cmp') code += `$r.cf=$t<$u?1:0;$v=($t-$u)&${M};`;
        else code += `$r.cf=0;$v=$t${op === 'or' ? '|' : op === 'xor' ? '^' : '&'}$u;`;
        code += this.flagsZS('$v', w);
        if (d.view || s.view) code += POISON;
        if (op !== 'cmp' && op !== 'test') code += d.set('$v');
        return code;
      }
      case 'inc': case 'dec': case 'not': case 'neg': {
        need(1);
        const w = this.width(ops);
        const d = this.acc(ops[0], w);
        const M = MASK[w];
        if (op === 'not') return d.set(`(~${d.get})&${M}`);
        const p = d.view ? POISON : '';
        if (op === 'neg') return `$t=${d.get};$r.cf=$t!==0?1:0;$v=(-$t)&${M};${this.flagsZS('$v', w)}${p}${d.set('$v')}`;
        return `$v=(${d.get}${op === 'inc' ? '+' : '-'}1)&${M};${this.flagsZS('$v', w)}${p}${d.set('$v')}`;
      }
      case 'shl': case 'sal': case 'shr': case 'sar': {
        need(2);
        const w = this.width([ops[0]]);
        const d = this.acc(ops[0], w);
        const c = ops[1];
        let n;
        if (c.kind === 'imm') n = String(c.value & 31);
        else if (c.kind === 'reg8' && c.reg === 'cl') n = '($r.cx&31)';
        else fail(`${op} by something other than a constant or cl`);
        const bits = w * 8, M = MASK[w];
        // A count of 0 changes nothing, flags included.
        let body;
        if (op === 'shl' || op === 'sal') {
          body = `$v=$u>${bits}?0:($t<<$u);$r.cf=$u>${bits}?0:($v>>>${bits})&1;$v&=${M};`;
        } else if (op === 'shr') {
          body = `$r.cf=$u>${bits}?0:($t>>>($u-1))&1;$v=$u>=${bits}?0:$t>>>$u;`;
        } else {
          body = `$t=($t<<${32 - bits})>>${32 - bits};$r.cf=($t>>(Math.min($u,${bits})-1))&1;$v=($t>>Math.min($u,${bits}-1))&${M};`;
        }
        // CF is undefined once the count reaches the operand's width (Intel SDM, SHL/SHR/SAR).
        return `$u=${n};if($u){$t=${d.get};${body}${this.flagsZS('$v', w)}if($u>=${bits})$r.cf=2;`
          + `${d.view ? POISON : ''}${d.set('$v')}}`;
      }
      case 'push': {
        need(1);
        const s = this.acc(ops[0], 2);
        return `$stk.push(${s.get});`;
      }
      case 'pop': {
        need(1);
        const d = this.acc(ops[0], 2);
        return `$t=$stk.pop();if(typeof $t!=="number")${THROW('pop of a pushf word, or of nothing pushed in this function')};${d.set('$t')}`;
      }
      case 'pushf': return '$stk.push({cf:$r.cf,zf:$r.zf,sf:$r.sf,if:$r.if,df:$r.df});';
      case 'popf':
        return `$t=$stk.pop();if($t===undefined)${THROW('popf with nothing pushed in this function')};`
          + 'if(typeof $t==="number"){$t={cf:$t&1,zf:($t>>6)&1,sf:($t>>7)&1,if:($t>>9)&1,df:($t>>10)&1};}'
          + `if($t.df)${THROW('popf setting DF')};$r.cf=$t.cf;$r.zf=$t.zf;$r.sf=$t.sf;$r.if=$t.if;$r.df=$t.df;`;
      case 'in': {
        need(2);
        const d = ops[0];
        if (!((d.kind === 'reg8' && d.reg === 'al') || (d.kind === 'reg' && d.reg === 'ax'))) fail('in to something other than al or ax');
        const w = d.size;
        const port = this.port(ops[1]);
        return this.acc(d, w).set(`${this.io()}.read(${port},${w})`);
      }
      case 'out': {
        need(2);
        const s = ops[1];
        if (!((s.kind === 'reg8' && s.reg === 'al') || (s.kind === 'reg' && s.reg === 'ax'))) fail('out from something other than al or ax');
        const w = s.size;
        const port = this.port(ops[0]);
        return `${this.io()}.write(${port},${w},${this.acc(s, w).get});`;
      }
      case 'int': {
        need(1);
        if (ops[0].kind !== 'imm' || ops[0].value < 0 || ops[0].value > 255) fail('int with a vector that is not a constant');
        return `${interruptJs(ops[0].value)};`;
      }
      case 'les': case 'lds': {
        need(2);
        const d = ops[0], m = ops[1];
        if (d.kind !== 'reg' || d.reg === 'sp' || d.reg === 'bp') fail(`${op} into ${d.reg ?? d.kind}`);
        if (m.kind !== 'mem') fail(`${op} from something other than memory`);
        const seg = op === 'les' ? '$r.es' : '$r.ds';
        const a = this.mem(m, 4);
        if (a.far) return `$t=${a.L};$r.${d.reg}=$t&15;${seg}=($t>>>4)&65535;`;
        const e = this.env;
        const hi = `((${a.segJs}<<4)+((${a.off}+2)&65535))`;
        // Both words read before either register is written: `les bx,[bx]` addresses with the old bx.
        return `$t=${e.load(a.addr, 2)};$u=${e.load(hi, 2)};$r.${d.reg}=$t;${seg}=$u;`;
      }
      default:
        if (op in STRING) return this.string(ins);
        return fail(`the instruction '${op}'`);
    }
  }

  port(o) {
    if (o.kind === 'reg' && o.reg === 'dx') return '$r.dx';
    if (o.kind === 'imm') {
      if (o.value < 0 || o.value > 255) fail(`the port ${o.value} as an immediate`);
      return String(o.value);
    }
    return fail('a port other than dx or a constant');
  }

  io() { return `(M.machine??${THROW('a port access with no I/O ports installed')})`; }

  string(ins) {
    const { op, rep } = ins;
    if (ins.ops.length) fail(`${op} with operands`);
    const w = STRING[op], e = this.env;
    const di = `(($r.es<<4)+$r.di)`, si = `(($r.ds<<4)+$r.si)`;
    const acc = w === 1 ? '($r.ax&255)' : '$r.ax';
    let one;
    if (op.startsWith('stos')) one = `${e.store(di, w, acc)};$r.di=($r.di+${w})&65535;`;
    else if (op.startsWith('lods')) {
      one = (w === 1 ? `$r.ax=($r.ax&65280)|${e.load(si, 1)};` : `$r.ax=${e.load(si, 2)};`) + `$r.si=($r.si+${w})&65535;`;
    } else one = `${e.store(di, w, e.load(si, w))};$r.di=($r.di+${w})&65535;$r.si=($r.si+${w})&65535;`;
    // DF is clear by construction: cld is the only direction write accepted.
    return rep ? `while($r.cx!==0){${one}$r.cx=($r.cx-1)&65535;}` : one;
  }
}

// --------------------------------------------------------------------------------------------------
// Borland's pseudo-registers, and the rule that keeps them and the asm honest.
// --------------------------------------------------------------------------------------------------

/** `_AX` and friends, as Borland spells them, with their register-file accessor and width. */
export const PSEUDO = new Map([
  ...['AX', 'BX', 'CX', 'DX', 'SI', 'DI', 'ES', 'DS'].map((r) => [`_${r}`, { acc: r, size: 2 }]),
  ...['AL', 'AH', 'BL', 'BH', 'CL', 'CH', 'DL', 'DH'].map((r) => [`_${r}`, { acc: r, size: 1 }]),
  ['_FLAGS', { acc: 'FLAGS', size: 2 }],
]);
/** The ones that name something PRISM has no value for. */
export const PSEUDO_REFUSED = new Map([
  ['_BP', 'Borland\'s frame pointer'], ['_SP', 'the stack pointer'], ['_SS', 'the stack segment'],
  ['_CS', 'the code segment'],
]);

const UNITS = { ax: ['al', 'ah'], bx: ['bl', 'bh'], cx: ['cl', 'ch'], dx: ['dl', 'dh'],
  si: ['si'], di: ['di'], bp: ['bp'], ds: ['ds'], es: ['es'],
  al: ['al'], ah: ['ah'], bl: ['bl'], bh: ['bh'], cl: ['cl'], ch: ['ch'], dl: ['dl'], dh: ['dh'],
  // The flags word, as one unit: defined by an interrupt (geninterrupt) or by the program's own
  // assembly, whose flags this file computes (a flag it cannot know reads as 2 and throws).
  flags: ['flags'] };
const GENERAL = ['al', 'ah', 'bl', 'bh', 'cl', 'ch', 'dl', 'dh', 'si', 'di', 'bp', 'es', 'flags'];
/** What a C call leaves undefined: the registers Borland's code does not preserve across one. */
const CLOBBERED = ['al', 'ah', 'bl', 'bh', 'cl', 'ch', 'dl', 'dh', 'es', 'flags'];

/** Which register units one asm instruction reads and writes. */
function insEffect(ins) {
  const r = [], w = [];
  const regOf = (o) => (o.kind === 'reg' || o.kind === 'reg8' || o.kind === 'sreg' ? o.reg : null);
  const addr = (o) => {
    if (o.kind !== 'mem') return;
    r.push(...o.regs);
    if (o.seg && o.seg !== 'ss' && o.seg !== 'cs') r.push(o.seg);
  };
  const read = (o) => { addr(o); const g = regOf(o); if (g) r.push(g); };
  const write = (o) => { addr(o); const g = regOf(o); if (g) w.push(g); };
  const [a, b] = ins.ops ?? [];
  const same = a && b && regOf(a) && regOf(a) === regOf(b);
  switch (ins.op) {
    case 'mov': read(b); write(a); break;
    case 'xchg': read(a); read(b); write(a); write(b); break;
    case 'xor': case 'sub':
      if (same) { write(a); break; }            // the zeroing idiom reads nothing
      read(a); read(b); write(a); break;
    case 'add': case 'and': case 'or': read(a); read(b); write(a); break;
    case 'cmp': case 'test': read(a); read(b); break;
    case 'inc': case 'dec': case 'not': case 'neg': read(a); write(a); break;
    case 'shl': case 'sal': case 'shr': case 'sar': read(a); read(b); write(a); break;
    case 'push': addr(a); break;                // save/restore of a caller's value moves it, uses nothing
    case 'pop': write(a); break;
    case 'in': if (regOf(b)) r.push('dx'); write(a); break;
    case 'out': if (regOf(a)) r.push('dx'); read(b); break;
    case 'les': case 'lds': addr(b); w.push(regOf(a), ins.op === 'les' ? 'es' : 'ds'); break;
    case 'loopdec': r.push('cx'); w.push('cx'); break;
    case 'int': w.push(...GENERAL); break;
    default:
      if (ins.op in STRING) {
        const acc = STRING[ins.op] === 1 ? 'al' : 'ax';
        if (ins.op.startsWith('stos')) { r.push(acc, 'di', 'es'); w.push('di'); }
        else if (ins.op.startsWith('lods')) { r.push('si'); w.push(acc, 'si'); }
        else { r.push('si', 'di', 'es'); w.push('si', 'di'); }
        if (ins.rep) { r.push('cx'); w.push('cx'); }
      }
  }
  const u = (list) => list.filter(Boolean).flatMap((x) => UNITS[x] ?? []);
  return { reads: u(r), writes: u(w) };
}

/**
 * THE RULE: a register is read only after this function wrote it, and not across a C call.
 *
 * A register holds what the function's own code put there, or else whatever its caller, Borland's
 * code generator or an interrupt left -- and the second kind is the one value PRISM cannot know.
 * USL_HardError's `di = _DI` reads what DOS passed a critical-error handler; `errno = _AX` after a
 * library call reads the call's return value out of Borland's AX. Both are REFUSED BY NAME here
 * rather than answered with the 0 a fresh register file holds.
 *
 * Checked in source order, which is how such a read is written; a jump that skips a write is a
 * program reading junk in Borland too. Two exemptions, each an idiom that moves a value without
 * using it: `push` (save, later popped back), and `xor r,r` / `sub r,r` (zeroing). DS starts
 * written: it holds DGROUP at every entry. A C call -- any but geninterrupt, which is the service
 * the registers were loaded for -- undoes AX, BX, CX, DX and ES, the registers Borland's calling
 * convention does not preserve; `int` and geninterrupt leave every register defined.
 *
 * Returns null, or a sentence naming the first offending read.
 */
export function firstUndefinedRead(body, { isPseudo, entryDefined = false }) {
  // An interrupt function starts with every register holding the interrupted code's value.
  const written = new Set(entryDefined ? ['ds', ...GENERAL] : ['ds']);
  let clobberedBy = null;
  const check = (units, what) => {
    for (const u of units) {
      if (!written.has(u)) {
        return clobberedBy
          ? `${what} reads ${u} after the call to ${clobberedBy}, which leaves in it only what Borland's code put there`
          : `${what} reads ${u} before this function wrote it -- a value only its caller or an interrupt could have left`;
      }
    }
    return null;
  };
  const pseudoUnits = (n) => UNITS[PSEUDO.get(n).acc.toLowerCase()];
  let found = null;
  const expr = (e) => {
    if (found || !e || typeof e !== 'object') return;
    if (Array.isArray(e)) { e.forEach(expr); return; }
    switch (e.n) {
      case 'asmins': {
        const { reads, writes } = insEffect(e.ins);
        found = check(reads, `\`${e.ins.text}\``);
        for (const u of writes) written.add(u);
        written.add('flags');
        if (e.ins.op === 'int') clobberedBy = null;
        return;
      }
      case 'ident':
        if (isPseudo(e.name)) found = check(pseudoUnits(e.name), `\`${e.name}\``);
        return;
      case 'assign':
        expr(e.rhs);
        if (e.lhs?.n === 'ident' && isPseudo(e.lhs.name)) {
          if (e.op !== '=') expr(e.lhs);
          for (const u of pseudoUnits(e.lhs.name)) written.add(u);
          return;
        }
        expr(e.lhs);
        return;
      case 'preinc': case 'postinc':
        expr(e.expr);
        if (e.expr?.n === 'ident' && isPseudo(e.expr.name)) for (const u of pseudoUnits(e.expr.name)) written.add(u);
        return;
      case 'call': {
        for (const a of e.args ?? []) expr(a);
        if (found) return;
        const callee = e.fn?.n === 'ident' ? e.fn.name : 'a function pointer';
        if (callee === 'geninterrupt') { for (const u of GENERAL) written.add(u); return; }
        expr(e.fn);
        for (const u of CLOBBERED) written.delete(u);
        clobberedBy = `${callee}()`;
        return;
      }
      case 'asmcc':
        if (e.js.includes('$r.cx')) found = check(['cl', 'ch'], '`jcxz`');
        return;
      default:
        for (const k of Object.keys(e)) {
          if (k === 'type' || k === 'loc' || k === 'sym') continue;
          const v = e[k];
          if (Array.isArray(v)) v.forEach(expr); else if (v && typeof v === 'object') expr(v);
        }
    }
  };
  // Statements and expressions are walked alike, in source order.
  expr(body);
  return found;
}
