// gas.js — GNU as (AT&T syntax) assembly, preprocessed and rewritten as the NASM subset nasm.js reads.
//
// Enemy Territory's Linux build assembles unix/snd_mixa.spp with gcc -x assembler-with-cpp, and that
// file is the ONLY definition of S_WriteLinearBlastStereo16 a Linux build can link: snd_mix.c declares
// it under __linux__ and its C twin sits in an #else no Linux configuration reaches. So the file is
// translated, not side-stepped -- through the C preprocessor first, with the defines its own build
// gives it (SConscript.core's gas_env: ELF, and -m32's __i386__), then line by line into NASM.
//
// The rewrite is syntax only, and REFUSES what it does not understand, as nasm.js does: a line it
// cannot read is an error naming the line, never a skipped instruction.
//
//   AT&T                                 NASM
//   movl  -8(%ebx,%ecx,4),%eax           mov  eax, dword [ebx+ecx*4-8]
//   cmpl  $0x7FFF,%eax                   cmp  eax, 0x7FFF
//   movl  snd_linear_count,%ecx          mov  ecx, dword [snd_linear_count]
//   .globl S_WriteLinearBlastStereo16    global S_WriteLinearBlastStereo16
//   LClampHigh:                          .LClampHigh:   (a local: nasm.js ends a routine at a global)
import { Preprocessor } from '../cpp/cpp.js';
import { AsmError } from './nasm.js';

const SIZE_WORD = { l: 'dword', w: 'word', b: 'byte' };
// Mnemonics whose last letter is gas's operand-size suffix, not part of the name.
const SUFFIXED = /^(mov|add|sub|and|or|xor|cmp|test|shl|shr|sar|push|pop|inc|dec|neg|imul|mul|lea)([lwb])$/;
// gas spellings nasm.js knows under another name.
const ALIAS = { jnl: 'jge', jnge: 'jl', jng: 'jle', jnle: 'jg' };

/** The preprocessed text of a gas source: its #include and #define resolved as gcc -E would. */
export function preprocessGas(text, file, { resolve, defines = {} }) {
  const pp = new Preprocessor({ defines, resolve });
  const out = [];
  let line = '';
  for (const t of pp.run(text, file)) {
    if (t.bol && line.trim()) { out.push(line); line = ''; }
    if (t.v === undefined || t.k === 'eof') continue;
    line += (t.ws && line ? ' ' : '') + t.v;
  }
  if (line.trim()) out.push(line);
  for (const d of pp.diagnostics) throw new AsmError(`${file}: ${d.message ?? d}`);
  return out.join('\n');
}

/** Split operands at top-level commas: `-8(%ebx,%ecx,4),%eax` is two operands, not four. */
function operands(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of text) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A number gas would accept here, or null. */
function number(t) {
  const s = t.replace(/\s+/g, '');
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?0x[0-9a-f]+$/i.test(s)) return Number(s.replace(/^-/, '')) * (s.startsWith('-') ? -1 : 1);
  return null;
}

function operand(t, size, at, symbols) {
  const s = t.replace(/\s+/g, '');
  if (s.startsWith('%')) return s.slice(1);
  if (s.startsWith('$')) {
    const n = number(s.slice(1));
    if (n === null) throw new AsmError(`${at}: immediate not a number: ${t}`);
    return String(n);
  }
  // disp(%base,%index,scale), (%base), disp(,%index,scale)
  const m = /^([^(]*)\((%\w+)?(?:,(%\w+)(?:,([1248]))?)?\)$/.exec(s);
  let sym = null, disp = 0, base = null, index = null, scale = 1;
  if (m) {
    base = m[2] ? m[2].slice(1) : null;
    index = m[3] ? m[3].slice(1) : null;
    scale = m[4] ? Number(m[4]) : 1;
    if (m[1]) {
      const n = number(m[1]);
      if (n !== null) disp = n;
      else if (/^[A-Za-z_.$][\w.$]*$/.test(m[1])) sym = m[1];
      else throw new AsmError(`${at}: displacement not in the subset: ${t}`);
    }
  } else if (/^[A-Za-z_.$][\w.$]*$/.test(s)) {
    sym = s;                                     // a bare symbol is a memory operand in AT&T
  } else {
    throw new AsmError(`${at}: operand not in the subset: ${t}`);
  }
  if (sym) symbols.add(sym);
  const parts = [];
  if (sym) parts.push(sym);
  if (base) parts.push(base);
  if (index) parts.push(`${index}*${scale}`);
  let inner = parts.join('+');
  if (disp) inner += disp < 0 ? `-${-disp}` : `+${disp}`;
  if (!index && sym && (base || disp)) throw new AsmError(`${at}: symbol plus register or offset without an index is not in the subset: ${t}`);
  return `${size ? `${size} ` : ''}[${inner}]`;
}

/** NASM text for preprocessed gas text. */
export function gasToNasm(text, file = '<gas>') {
  const lines = text.split('\n');
  const globals = new Set(), labels = new Set();
  for (const l of lines) {
    const g = /^\s*\.globl\s+([\w.$]+)\s*$/.exec(l);
    if (g) globals.add(g[1]);
    const lab = /^\s*([\w.$]+)\s*:\s*$/.exec(l);
    if (lab) labels.add(lab[1]);
  }
  const local = (n) => (labels.has(n) && !globals.has(n) ? `.${n}` : n);
  const out = [], symbols = new Set();
  lines.forEach((raw, i) => {
    const at = `${file}: line ${i + 1} after preprocessing`;
    const l = raw.trim();
    if (!l) return;
    if (/^\.(text|align\s+\d+|p2align\s+\d+)$/.test(l)) return;
    // qasm.h declares every C global any of id's .s files might touch; the ones THIS file uses are
    // found from its operands, so a declaration alone adds nothing.
    if (/^\.extern\s+[\w.$]+$/.test(l)) return;
    const g = /^\.globl\s+([\w.$]+)$/.exec(l);
    if (g) { out.push(`global ${g[1]}`); return; }
    if (l.startsWith('.')) throw new AsmError(`${at}: directive not in the subset: ${l}`);
    const lab = /^([\w.$]+)\s*:$/.exec(l);
    if (lab) { out.push(`${local(lab[1])}:`); return; }
    const ins = /^(\w+)\s*(.*)$/.exec(l);
    if (!ins) throw new AsmError(`${at}: not understood: ${l}`);
    let op = ins[1].toLowerCase(), size = null;
    const sfx = SUFFIXED.exec(op);
    if (sfx) { op = sfx[1]; size = SIZE_WORD[sfx[2]]; }
    op = ALIAS[op] ?? op;
    if (op[0] === 'j' || op === 'call') { out.push(`${op} ${local(ins[2].trim())}`); return; }
    const ops = operands(ins[2]).map((o) => operand(o, size, at, symbols)).reverse();
    // A register operand states the width itself; NASM wants the keyword only where nothing else does.
    const plain = ops.map((o) => (ops.some((x) => !x.includes('[') && !/^-?\d/.test(x)) ? o.replace(/^(dword|word|byte) /, '') : o));
    out.push(`${op} ${plain.join(', ')}`.trim());
  });
  const externs = [...symbols].filter((s) => !labels.has(s));
  return [...externs.map((s) => `extern ${s}`), ...out].join('\n') + '\n';
}

/**
 * The NASM text for one `asmTranslate` entry. A string names a NASM file, used as it is. An object
 * `{ file, syntax: 'gas', defines }` is a gas source: preprocessed with ITS build's defines only (gcc
 * -x assembler-with-cpp does not see the C units' flags), then rewritten.
 */
export function asmText(entry, text, resolve) {
  if (typeof entry === 'string') return text;
  if (entry.syntax !== 'gas') throw new AsmError(`${entry.file}: unknown assembly syntax ${entry.syntax}`);
  return gasToNasm(preprocessGas(text, entry.file, { resolve, defines: entry.defines ?? {} }), entry.file);
}
