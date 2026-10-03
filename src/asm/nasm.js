// nasm.js — the NASM subset PRISM needs, parsed into a form an emitter can use.
//
// P5 starts here rather than with Quake's renderer loops, and on purpose: Jump 'n Bump's dos/gfx.S
// is TWO routines and 215 useful lines, and it is the first file in the corpus where the assembly
// cannot be side-stepped. Every other game ships a C twin its own build can select (P5.2 measured
// that an assembler buys one symbol corpus-wide); this one ships none at all.
//
// THE PARSER REFUSES WHAT IT DOES NOT UNDERSTAND. A translator that quietly skips a line it cannot
// read produces a routine that is almost right, which is the worst outcome available: the picture
// comes out nearly correct and the defect is hunted somewhere else for days. Every line is either
// recognised or reported.
//
// WHAT THE FILE ACTUALLY CONTAINS, counted rather than assumed: 24 distinct mnemonics, no string
// operations, no floating point, no segmentation. What it does contain, and what the emitter must
// not smooth over:
//
//   * SUB-REGISTER WIDTHS. get_block ends its inner loop with `dec cx` -- SIXTEEN bits -- while
//     put_block, the same loop, uses `dec ecx`. Twin routines, different widths. Translating both
//     as a 32-bit decrement is right almost everywhere and wrong exactly where it matters.
//   * `imul dword [mem]`, one operand, which writes EDX:EAX and not just EAX.
//   * `or eax,eax` is not an or. It is a sign test, and the `jns` after it is the point.
//   * `shl eax,cl`, a shift whose count is a register.
//
// Syntax notes, because this is 1998 NASM: labels sit alone on a line WITHOUT a colon, local labels
// begin with a dot and belong to the preceding global one, directives are bracketed ([GLOBAL x],
// [SECTION .text]), and `dd` reserves data INSIDE the text section -- the routines keep their
// variables among their own code.

/** Registers this subset knows, and the width each name implies. */
const REGS32 = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'];
const REGS16 = ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp'];
const REGS8 = ['al', 'bl', 'cl', 'dl', 'ah', 'bh', 'ch', 'dh'];

/** The 32-bit register a narrow name lives in, and where in it. */
export function regInfo(name) {
  const i32 = REGS32.indexOf(name);
  if (i32 >= 0) return { base: name, size: 4, shift: 0 };
  const i16 = REGS16.indexOf(name);
  if (i16 >= 0) return { base: REGS32[i16], size: 2, shift: 0 };
  const i8 = REGS8.indexOf(name);
  if (i8 >= 0) return { base: `e${'abcd'[i8 % 4]}x`, size: 1, shift: i8 < 4 ? 0 : 8 };
  return null;
}

export class AsmError extends Error {}

const SIZES = { byte: 1, word: 2, dword: 4, qword: 8 };

/**
 * One operand.
 *
 * `{k:'reg', name}` | `{k:'imm', value}` | `{k:'mem', base, disp, sym, size}`
 *
 * A memory operand is `[reg+disp]`, `[reg]` or `[symbol]`; this file has no scaled index and no
 * segment override, and an operand that has one is refused rather than approximated.
 */
function parseOperand(text, sizeHint) {
  const t = text.trim();

  const m = /^(byte|word|dword|qword)\s+(.*)$/i.exec(t);
  if (m) return parseOperand(m[2], SIZES[m[1].toLowerCase()]);

  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new AsmError(`unbalanced memory operand: ${t}`);
    const inner = t.slice(1, -1).trim();
    // [reg+disp] / [reg-disp] / [reg]
    const r = /^(e[a-z]{2})\s*([+-])\s*(\d+|0x[0-9a-f]+)$/i.exec(inner);
    if (r) {
      return { k: 'mem', base: r[1].toLowerCase(), disp: (r[2] === '-' ? -1 : 1) * Number(r[3]),
               size: sizeHint ?? null };
    }
    // [base+index*scale], [base+index*scale+disp], [index*scale+disp], with an optional symbol: what
    // gas's disp(%base,%index,scale) becomes (src/asm/gas.js).
    const sib = /^(?:([.\w$]+)\s*\+\s*)?(?:(e[a-z]{2})\s*\+\s*)?(e[a-z]{2})\s*\*\s*([1248])(?:\s*([+-])\s*(\d+|0x[0-9a-f]+))?$/i.exec(inner);
    if (sib) {
      // The leading name is the base register when it is one and no other base follows.
      const regFirst = sib[1] && REGS32.includes(sib[1].toLowerCase()) && !sib[2];
      const symBase = sib[1] && !regFirst ? sib[1] : undefined;
      if (sib[1] && !regFirst && REGS32.includes(sib[1].toLowerCase())) throw new AsmError(`memory operand not in the subset: [${inner}]`);
      return { k: 'mem', ...(symBase ? { symBase } : {}), base: (regFirst ? sib[1] : sib[2])?.toLowerCase() ?? null, index: sib[3].toLowerCase(),
               scale: Number(sib[4]), disp: sib[5] ? (sib[5] === '-' ? -1 : 1) * Number(sib[6]) : 0, size: sizeHint ?? null };
    }
    if (REGS32.includes(inner.toLowerCase())) {
      return { k: 'mem', base: inner.toLowerCase(), disp: 0, size: sizeHint ?? null };
    }
    if (/^[.\w$]+$/.test(inner)) return { k: 'mem', sym: inner, disp: 0, size: sizeHint ?? null };
    throw new AsmError(`memory operand not in the subset: [${inner}]`);
  }

  const reg = regInfo(t.toLowerCase());
  if (reg) return { k: 'reg', name: t.toLowerCase() };

  if (/^-?\d+$/.test(t)) return { k: 'imm', value: Number(t) };
  if (/^0x[0-9a-f]+$/i.test(t)) return { k: 'imm', value: Number(t) };

  throw new AsmError(`operand not in the subset: ${t}`);
}

/**
 * Parse a NASM source file.
 *
 * Returns { globals, externs, items }, where items are in source order:
 *   { kind:'label', name, global }      a place a jump can reach
 *   { kind:'insn', op, operands, near } one instruction
 *   { kind:'data', name, size, values } a `dd`/`dw`/`db` slot living inside .text
 */
export function parse(source) {
  const globals = [];
  const externs = [];
  const items = [];
  let current = null;                 // the global label local ones attach to
  const lines = source.split(/\r?\n/);

  lines.forEach((raw, n) => {
    const at = `line ${n + 1}`;
    // A comment runs to end of line. No string literals in this subset, so this is safe.
    const line = raw.replace(/;.*$/, '').trimEnd();
    if (!line.trim()) return;

    const d = /^\s*\[(\w+)\s*(.*?)\]\s*$/.exec(line);
    if (d) {
      const what = d[1].toUpperCase();
      if (what === 'GLOBAL') globals.push(d[2].trim());
      else if (what === 'EXTERN') externs.push(d[2].trim());
      else if (what === 'SECTION') { /* .text only here; data lives in it */ }
      else throw new AsmError(`${at}: directive not in the subset: [${what}]`);
      return;
    }

    // A data slot: `.name  dd  0`. Checked BEFORE the bare-label rule, which would otherwise
    // swallow the name and drop the storage -- silently reserving nothing.
    /*
     * The same directives without brackets, as NASM 0.98 onward also writes them: Quake III's
     * snapvector.nasm says `segment .data` and `global Sys_SnapVector`. Its data sits in a data
     * segment rather than among the code, which changes nothing here: a slot is a slot.
     */
    const bare = /^\s*(segment|section|global|extern)\s+(\S+)\s*$/i.exec(line);
    if (bare) {
      const what = bare[1].toLowerCase();
      if (what === 'global') globals.push(bare[2]);
      else if (what === 'extern') externs.push(bare[2]);
      return;
    }
    const dat = /^\s*([.\w$]+)\s+(dd|dw|db)\s+(.*)$/i.exec(line);
    if (dat) {
      const size = { dd: 4, dw: 2, db: 1 }[dat[2].toLowerCase()];
      const values = dat[3].split(',').map(v => Number(v.trim()));
      if (values.some(Number.isNaN)) throw new AsmError(`${at}: data value not a number: ${line}`);
      items.push({ kind: 'data', name: qualify(dat[1], current), size, values, at });
      return;
    }

    // A label, with or without the colon 1998 leaves off.
    const lab = /^\s*([.\w$]+):?\s*$/.exec(line);
    if (lab && !isMnemonic(lab[1])) {
      const name = lab[1];
      if (!name.startsWith('.')) current = name;
      items.push({ kind: 'label', name: qualify(name, current), global: !name.startsWith('.'), at });
      return;
    }

    const ins = /^\s*(\w+)\s*(.*)$/.exec(line);
    if (!ins) throw new AsmError(`${at}: not understood: ${line}`);
    const op = ins[1].toLowerCase();
    let rest = ins[2].trim();

    // `jge near .exit` -- `near` is a reach hint and carries no semantics for a translator.
    let near = false;
    rest = rest.replace(/^near\s+/i, () => { near = true; return ''; }).trim();

    const operands = [];
    if (rest) {
      for (const piece of splitOperands(rest)) {
        // A jump's operand is a label, which is not an operand form parseOperand knows.
        if (op[0] === 'j' || op === 'call') operands.push({ k: 'label', name: qualify(piece, current) });
        else {
          const o = parseOperand(piece);
          // A LOCAL data slot is qualified the same way a local label is, and for the same reason:
          // `.x` exists in both routines and they are two different variables. Missing this made
          // every memory operand look up a name nothing defined -- which the translator refused,
          // loudly, rather than inventing an address for.
          if (o.k === 'mem' && o.sym?.startsWith('.')) o.sym = qualify(o.sym, current);
          operands.push(o);
        }
      }
    }
    items.push({ kind: 'insn', op, operands, near, at, text: line.trim() });
  });

  return { globals, externs, items };
}

/** A local label belongs to the global one above it, so `.1` in two routines is two places. */
function qualify(name, current) {
  return name.startsWith('.') ? `${current ?? ''}${name}` : name;
}

/** Operands are comma-separated, and nothing in this subset nests commas. */
function splitOperands(rest) {
  return rest.split(',').map(s => s.trim()).filter(s => s.length);
}

const MNEMONICS = new Set([
  'mov', 'add', 'sub', 'cmp', 'and', 'or', 'xor', 'neg', 'inc', 'dec', 'imul', 'mul',
  'shl', 'shr', 'sar', 'push', 'pop', 'pusha', 'popa', 'ret', 'out', 'in', 'nop',
  'jmp', 'je', 'jz', 'jne', 'jnz', 'jl', 'jle', 'jg', 'jge', 'js', 'jns', 'jc', 'jnc',
  // x87, the part snapvector.nasm uses: control word, and loads and stores between memory and st(0)
  'fnstcw', 'fldcw', 'fld', 'fild', 'fstp', 'fistp',
]);
function isMnemonic(word) {
  return MNEMONICS.has(word.toLowerCase());
}

/**
 * Every mnemonic the parser saw, with a count. The point of having it: a translator is only honest
 * about a file it has fully read, and this is what a gate compares against the emitter's table.
 */
export function census(parsed) {
  const seen = new Map();
  for (const it of parsed.items) {
    if (it.kind !== 'insn') continue;
    seen.set(it.op, (seen.get(it.op) ?? 0) + 1);
  }
  return seen;
}
