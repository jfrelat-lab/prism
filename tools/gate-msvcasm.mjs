// gate-msvcasm.mjs — Visual C++ inline assembly (src/asm/msvc.js), in two halves.
//
// A. THE INSTRUCTIONS, against Unicorn. Random 32-bit snippets -- the integer ALU with CF/ZF/SF/OF at
//    the three widths, shifts by a constant and by cl, imul in its three forms, lea and scaled
//    addresses, movzx/movsx, push/pop, forward conditional jumps, and every MMX instruction the
//    translator knows, with register and memory sources, shifts past the lane width, and the integer
//    MMX instructions SSE added -- are rendered twice from one description: as an __asm block inside
//    a C function for PRISM, and as NASM for Unicorn (a Pentium III). Both start from the same buffer
//    (filled from the case's seed by the same generator on both sides), point EBX at it, and store
//    their general and MMX registers into it at the end; the buffers and the four flags must agree.
//    A flag the SDM leaves undefined (OF after a multi-bit shift, SF and ZF after imul) is not
//    compared, and no jump reads one.
//
//    CAPTURE ONCE, REPLAY FOREVER, as gate-borlandasm does: `--capture` needs nasm and a Python with
//    unicorn, and writes goldens/msvc-asm.json, which is committed; a replay needs neither.
//
//      node tools/gate-msvcasm.mjs --capture [--python=/path/to/python3]
//      node tools/gate-msvcasm.mjs
//
//    The replay then MUTATES the MMX runtime -- pmulhw shifting by 15, paddsw wrapping, psrlw keeping
//    a count past the lane width -- and requires each mutation to turn part A red.
//
// B. THE C-FACING HALF, which no emulator can speak to: names resolved to a parameter, a local, a
//    static and a global; `[esi]Type.field`; an enum constant; labels on their own line and before an
//    instruction; the computed jump .kkrieger's Bitmap_Inner makes; `;` as a comment; the one-line
//    form; the return in EAX and EDX:EAX; MMX registers surviving from one function to the next; and
//    every refusal by name -- esp, ebp, call, int, the x87, an unknown label, an unsized operand.
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { compileProgram, builtinHeaderResolver, snapshotProgram, loadSnapshot } from '../src/compile.js';
import { makeX86 } from '../src/asm/msvc-rt.js';
import { compileRun } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'msvc-asm.json');
const CAPTURE = process.argv.includes('--capture');
const PY = process.argv.find((a) => a.startsWith('--python='))?.slice(9) ?? process.env.PRISM_PYTHON ?? 'python3';
const CASES = 600, FPU_CASES = 600;

// The buffer: data the snippet reads and writes below DATA_END, edge constants for the MMX
// registers at MMINIT, and the results at OUT (eax ecx edx esi edi, then mm0..mm7).
const LAYOUT = { code: 0x10000, buf: 0x100000, size: 0x1000, out: 0xf00 };
const DATA_END = 0xe00, MMINIT = 0xe80, OUT = LAYOUT.out;

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(58)} ${detail}`);
};

/** The generator both sides share: a 32-bit LCG, one byte from the top of each step. */
function fillBytes(seed, n) {
  let s = seed >>> 0;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = s >>> 24; }
  return out;
}
function rng(seed) {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  const next = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s >>> 8; };
  const int = (n) => next() % n;
  const EDGE = [0, 1, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffffe];
  const u32 = () => ((next() << 8) ^ next()) >>> 0;
  const val = (mask) => ((int(5) < 2 ? EDGE[int(EDGE.length)] : u32()) & mask) >>> 0;
  return { int, val, u32, pick: (a) => a[next() % a.length] };
}

// ------------------------------------------------------------------------------------------ part A
const hex = (n) => `0x${(n >>> 0).toString(16)}`;
const R = { 4: ['eax', 'ecx', 'edx', 'esi', 'edi'], 2: ['ax', 'cx', 'dx', 'si', 'di'], 1: ['al', 'cl', 'dl', 'ah', 'dh'] };
const MASKW = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
const SZ = { 1: 'byte', 2: 'word', 4: 'dword', 8: 'qword' };
const MMX_BIN = ['paddb', 'paddw', 'paddd', 'paddsb', 'paddsw', 'paddusb', 'paddusw', 'psubb', 'psubw', 'psubd', 'psubsb',
  'psubsw', 'psubusb', 'psubusw', 'pmullw', 'pmulhw', 'pmulhuw', 'pmaddwd', 'pand', 'por', 'pxor', 'pandn', 'pcmpeqb',
  'pcmpeqw', 'pcmpeqd', 'pcmpgtb', 'pcmpgtw', 'pcmpgtd', 'punpcklbw', 'punpcklwd', 'punpckldq', 'punpckhbw', 'punpckhwd',
  'punpckhdq', 'packsswb', 'packuswb', 'packssdw', 'pminsw', 'pmaxsw', 'pminub', 'pmaxub', 'pavgb', 'pavgw', 'psadbw'];
const MMX_SH = ['psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad'];
// Which flags each condition reads.
const JCC = { jz: 'z', jnz: 'z', jc: 'c', jnc: 'c', js: 's', jns: 's', jo: 'o', jno: 'o', jbe: 'cz', ja: 'cz',
  jl: 'so', jge: 'so', jle: 'zso', jg: 'zso', jp: 'p', jnp: 'p' };

/** A memory operand at [ebx+disp], sized when `size` is given (and the instruction needs it). */
const mem = (disp, size, sized = true) => ({
  m: `${sized && size ? `${SZ[size]} ptr ` : ''}[ebx+${hex(disp)}]`,
  n: `${sized && size ? `${SZ[size]} ` : ''}[ebx+${hex(disp)}]`,
});
const reg = (name) => ({ m: name, n: name });
const imm = (v) => ({ m: hex(v), n: hex(v) });
const L = (op, ...ops) => ({ m: `${op}${ops.length ? ' ' : ''}${ops.map((o) => o.m).join(',')}`, n: `${op}${ops.length ? ' ' : ''}${ops.map((o) => o.n).join(',')}` });

/** A random snippet: { lines: [{m, n} | {label}], skip: flags not to compare }. */
function snippet(seed) {
  const r = rng(seed);
  const out = [];
  // Undefined flags, as the last instruction to touch each left it.
  const undef = new Set();
  const define = (flags) => { for (const f of flags) undef.delete(f); };
  const set = (l, defined, undefined_ = '') => { out.push(l); define(defined); for (const f of undefined_) undef.add(f); };
  for (const name of R[4]) out.push(L('mov', reg(name), imm(r.val(0xffffffff))));
  // The MMX registers: from the random fill, or from edge constants written first.
  for (let k = 0; k < 8; k++) {
    let at = r.int(DATA_END / 8) * 8;
    if (r.int(2)) {
      const EW = [0, 1, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0x8001, 0xffff, 0x7ffe, 0x00ff, 0xff00];
      at = MMINIT + 8 * k;
      for (const half of [0, 4]) {
        const v = (r.pick(EW) | (r.pick(EW) << 16)) >>> 0;
        out.push(L('mov', mem(at + half, 4), imm(v)));
      }
    }
    out.push(L('movq', reg(`mm${k}`), mem(at, 8, false)));
  }
  let lab = 0;
  const dataDisp = (size) => r.int((DATA_END - 8) / size) * size + (r.int(4) === 0 ? r.int(size) : 0);
  const pickReg = (size, avoid = []) => r.pick(R[size].filter((x) => !avoid.includes(x)));
  const count = 8 + r.int(14);
  for (let i = 0; i < count; i++) {
    const kind = r.int(112);
    const size = r.pick([4, 4, 2, 1]);
    const mm = () => reg(`mm${r.int(8)}`);
    if (kind >= 100) {
      const shape = r.int(7);
      if (shape === 0) set(L('mul', r.int(2) ? reg(pickReg(4)) : mem(dataDisp(4), 4)), 'co', 'zsp');
      else if (shape === 1) {
        // Division with a divisor that cannot be zero and a quotient that must fit.
        out.push(L('or', reg('ecx'), imm(1)), L('xor', reg('edx'), reg('edx')));
        set(L('div', reg('ecx')), '', 'czsop');
      } else if (shape === 2) {
        out.push(L('and', reg('ecx'), imm(0x7fff)), L('or', reg('ecx'), imm(1)), L('cdq'));
        set(L('idiv', reg('ecx')), '', 'czsop');
      } else if (shape === 3) {
        const op = r.pick(['shld', 'shrd']), n = 1 + r.int(31);
        const d = r.int(3) ? reg(pickReg(4, ['ecx'])) : mem(dataDisp(4), 4);
        const c = r.int(2) ? imm(n) : (out.push(L('mov', reg('cl'), imm(n))), reg('cl'));
        set(L(op, d, reg(pickReg(4)), c), 'czsp', n === 1 ? '' : 'o');
        if (n === 1) define('o');
      } else if (shape === 4) { out.push(L('push', imm(r.val(0xffffffff))), L('pop', reg(pickReg(4)))); }
      else if (shape === 5) { set(L('sahf'), 'czsp'); }
      else {
        const op = r.pick(['movsb', 'movsd', 'stosb', 'stosd']), n = r.int(17);
        const si = hex(r.int(DATA_END - 80));
        out.push({ m: `lea esi,[ebx+${si}]`, n: `lea esi,[ebx+${si}]` });
        const di = hex(r.int(DATA_END - 80));
        out.push({ m: `lea edi,[ebx+${di}]`, n: `lea edi,[ebx+${di}]` }, L('mov', reg('ecx'), imm(n)));
        out.push(r.int(4) ? { m: `rep ${op}`, n: `rep ${op}` } : { m: op, n: op });
        // The addresses are the buffer's, which differ between the two machines: scrubbed.
        out.push(L('mov', reg('esi'), imm(r.u32())), L('mov', reg('edi'), imm(r.u32())));
      }
      continue;
    }
    if (kind < 16) {
      const op = r.pick(['add', 'sub', 'cmp', 'and', 'or', 'xor', 'test', 'adc']);
      const shape = r.int(5);
      const d = shape === 3 || shape === 4 ? mem(dataDisp(size), size) : reg(pickReg(size));
      const s = shape === 0 || shape === 4 ? imm(r.val(MASKW[size])) : shape === 2 ? mem(dataDisp(size), size) : reg(pickReg(size));
      if (op === 'adc' && undef.has('c')) continue;
      set(L(op, d, s), 'czsop');
    } else if (kind < 22) {
      const op = r.pick(['inc', 'dec', 'neg', 'not']);
      const d = r.int(3) ? reg(pickReg(size)) : mem(dataDisp(size), size);
      set(L(op, d), op === 'not' ? '' : op === 'neg' ? 'czsop' : 'zsop');
    } else if (kind < 30) {
      const op = r.pick(['shl', 'shr', 'sar']);
      const bits = size * 8;
      const n = 1 + r.int(bits - 1);
      const d = r.int(3) ? reg(pickReg(size, ['cl', 'cx', 'ecx'])) : mem(dataDisp(size), size);
      if (r.int(3)) set(L(op, d, imm(n)), 'czsp', n === 1 ? '' : 'o');
      else { out.push(L('mov', reg('cl'), imm(n))); set(L(op, d, reg('cl')), 'czsp', n === 1 ? '' : 'o'); }
      if (n === 1) define('o');
    } else if (kind < 36) {
      const shape = r.int(3);
      const d = reg(pickReg(4));
      if (shape === 0) set(L('imul', d, r.int(2) ? reg(pickReg(4)) : mem(dataDisp(4), 4)), 'co', 'zsp');
      else if (shape === 1) set(L('imul', d, reg(pickReg(4)), imm(r.val(0xffff) << 16 >> 16)), 'co', 'zsp');
      else set(L('imul', r.int(2) ? reg(pickReg(4, ['eax', 'edx'])) : mem(dataDisp(4), 4)), 'co', 'zsp');
    } else if (kind < 46) {
      const shape = r.int(6);
      if (shape === 0) out.push(L('mov', reg(pickReg(size)), mem(dataDisp(size), size, false)));
      else if (shape === 1) out.push(L('mov', mem(dataDisp(size), size, false), reg(pickReg(size))));
      else if (shape === 2) out.push(L(r.pick(['movzx', 'movsx']), reg(pickReg(4)), r.int(2) ? reg(pickReg(r.pick([1, 2]))) : mem(dataDisp(2), r.pick([1, 2]))));
      else if (shape === 3) { const sc = r.pick([1, 2, 4, 8]), disp = hex(r.u32()); out.push(L('lea', reg(pickReg(4)), { m: `[edi+esi*${sc}+${disp}]`, n: `[edi+esi*${sc}+${disp}]` })); }
      else if (shape === 4) { out.push(L('xchg', reg(pickReg(size)), r.int(2) ? reg(pickReg(size)) : mem(dataDisp(size), size, false))); }
      else {
        // A scaled index the snippet bounds first.
        set(L('and', reg('ecx'), imm(0x3f)), 'czsop');
        const sc = r.pick([1, 2, 4, 8]);
        out.push({ m: `mov eax,dword ptr [ebx+ecx*${sc}+0x40]`, n: `mov eax,dword [ebx+ecx*${sc}+0x40]` });
      }
    } else if (kind < 49) {
      out.push(L('push', reg(pickReg(4))));
      out.push(L('pop', reg(pickReg(4))));
    } else if (kind < 51) {
      out.push(L(r.pick(['cdq', 'clc', 'stc', 'cmc'])));
      define(out.at(-1).m === 'cdq' ? '' : 'c');
    } else if (kind < 56) {
      const usable = Object.keys(JCC).filter((j) => ![...JCC[j]].some((f) => undef.has(f)));
      if (!usable.length) continue;
      const k = lab++;
      const j = r.pick(usable);
      out.push({ m: `${j} L${k}`, n: `${j} L${k}` });
      // The jump may skip the inc, so the flags it would define stay as undefined as they were.
      out.push(L('inc', reg(pickReg(4))));
      out.push({ label: `L${k}` });
    } else if (kind < 80) {
      const op = r.pick(MMX_BIN);
      out.push(L(op, mm(), r.int(3) ? mm() : mem(dataDisp(8), 8, false)));
    } else if (kind < 88) {
      const op = r.pick(MMX_SH);
      const shape = r.int(3);
      if (shape === 0) out.push(L(op, mm(), imm(r.int(4) ? r.int(op.endsWith('q') ? 64 : op.endsWith('d') ? 32 : 16) : r.int(80))));
      else if (shape === 1) out.push(L(op, mm(), mm()));
      else { const c = `mm${r.int(8)}`; out.push(L('movd', reg(c), reg(pickReg(4)))); out.push(L('pand', reg(c), mem(MMINIT + 0x40, 8, false))); out.push(L(op, mm(), reg(c))); }
    } else {
      const shape = r.int(9);
      if (shape === 0) out.push(L('movq', mm(), mm()));
      else if (shape === 1) out.push(L('movq', mem(dataDisp(8), 8, false), mm()));
      else if (shape === 2) out.push(L(r.pick(['movq', 'movntq']), mem(dataDisp(8), 8, false), mm()));
      else if (shape === 3) out.push(L('movd', mm(), r.int(2) ? reg(pickReg(4)) : mem(dataDisp(4), 4, false)));
      else if (shape === 4) out.push(L('movd', r.int(2) ? reg(pickReg(4)) : mem(dataDisp(4), 4, false), mm()));
      else if (shape === 5) out.push(L('pshufw', mm(), r.int(2) ? mm() : mem(dataDisp(8), 8, false), imm(r.int(256))));
      else if (shape === 6) out.push(L('pinsrw', mm(), reg(pickReg(4)), imm(r.int(4))));
      else if (shape === 7) out.push(L('pextrw', reg(pickReg(4)), mm(), imm(r.int(4))));
      else out.push(L('pmovmskb', reg(pickReg(4)), mm()));
    }
  }
  return { lines: out, skip: [...undef] };
}

// ---- the x87 ---------------------------------------------------------------------------------
// Values live in a table in the buffer; the stack's depth is tracked so no snippet overflows or
// underflows it; what is left on the stack is stored at the end, and the condition codes are
// stored only when a compare (or fprem) is the last x87 instruction to define them -- after
// anything else the SDM leaves C0, C2 and C3 undefined.
const FT = { dbl: 0xd00, flt: 0xd60, i32: 0xd80, i16: 0xd90, i64: 0xda0, small: 0xdb0, cw: 0xe70 };
const STATUS = OUT + 0x18, STACK = OUT + 0x60;
const sti = (i) => ({ m: `st(${i})`, n: `st${i}` });
const ST0 = { m: 'st', n: 'st0' };
const wordAt = (disp, v) => L('mov', mem(disp, 2), imm(v & 0xffff));
const dwordAt = (disp, v) => L('mov', mem(disp, 4), imm(v >>> 0));
/** Two dword moves that put the double v at disp. */
function doubleAt(disp, v) {
  const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true);
  return [dwordAt(disp, b.getUint32(0, true)), dwordAt(disp + 4, b.getUint32(4, true))];
}
function floatBits(v) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return b.getUint32(0, true); }
const fmem = (disp, size) => ({ m: `${{ 2: 'word', 4: 'dword', 8: 'qword', 10: 'tbyte' }[size]} ptr [ebx+${hex(disp)}]`,
  n: `${{ 2: 'word', 4: 'dword', 8: 'qword', 10: 'tword' }[size]} [ebx+${hex(disp)}]` });

function fpuSnippet(seed) {
  const r = rng(seed);
  const out = [];
  for (const name of R[4]) out.push(L('mov', reg(name), imm(r.val(0xffffffff))));
  // The control word: precision 53 or 24 bits with round-to-nearest, where arithmetic is compared;
  // or a directed rounding, where only loads, integer stores, frndint and float stores are.
  const cw = r.pick([0x27f, 0x27f, 0x27f, 0x07f, 0x07f, 0x67f, 0xa7f, 0xe7f, 0x47f]);
  const nearest = ((cw >> 10) & 3) === 0, single = ((cw >> 8) & 3) === 0;
  out.push(L('fninit'), wordAt(FT.cw, cw), L('fldcw', fmem(FT.cw, 2)));
  // The table. Exponents stay small enough that no chain of these operations leaves a double's
  // range -- or, at 24 bits, a float's, which the x87's wider exponent would not leave either.
  // At 24 bits every value is a float, so that a load is exact under either reading of the precision
  // control: QEMU rounds a load of a double to it, which the SDM does not list (and MIRAGE does not do).
  const E = single ? 6 : 20;
  const nice = () => {
    const SPECIAL = [0, -0, 1, -1, 0.5, 2.5, -2.5, 1.5, 3, 7, 0.1, -1e-3];
    const v = r.int(3) === 0 ? r.pick(SPECIAL) : (r.int(2) ? -1 : 1) * (1 + r.u32() / 2 ** 32) * 2 ** (r.int(2 * E + 1) - E);
    return single ? Math.fround(v) : v;
  };
  const dbl = Array.from({ length: 12 }, nice);
  dbl.forEach((v, k) => out.push(...doubleAt(FT.dbl + 8 * k, v)));
  for (let k = 0; k < 6; k++) out.push(dwordAt(FT.flt + 4 * k, floatBits(Math.fround(nice()))));
  const I32 = [0, 1, -1, 7, 100000, -32768, 0x7fffffff, -0x80000000];
  for (let k = 0; k < 4; k++) out.push(dwordAt(FT.i32 + 4 * k, r.int(2) ? r.pick(I32) : (r.u32() % 2001) - 1000));
  for (let k = 0; k < 4; k++) out.push(wordAt(FT.i16 + 2 * k, r.int(2) ? r.pick([0, 1, -1, 32767, -32768, 12]) : (r.u32() % 201) - 100));
  for (let k = 0; k < 2; k++) { out.push(dwordAt(FT.i64 + 8 * k, r.u32())); out.push(dwordAt(FT.i64 + 8 * k + 4, r.int(2) ? 0 : 0xffffffff)); }
  for (let k = 0; k < 4; k++) out.push(wordAt(FT.small + 2 * k, r.int(21) - 10));

  let d = 0, cc = null, lab = 0;
  const D = () => fmem(FT.dbl + 8 * r.int(12), 8), F = () => fmem(FT.flt + 4 * r.int(6), 4);
  const slot = (size) => fmem(r.int((DATA_END - 16) / 8) * 8, size);
  const count = 6 + r.int(14);
  for (let i = 0; i < count; i++) {
    const kind = r.int(100);
    if (kind < 22 && d < 8) {
      const shape = r.int(7);
      if (shape === 0) out.push(L('fld', D()));
      else if (shape === 1) out.push(L('fld', F()));
      else if (shape === 2 && d > 0) out.push(L('fld', sti(r.int(d))));
      else if (shape === 3) out.push(L('fild', fmem(FT.i32 + 4 * r.int(4), 4)));
      else if (shape === 4) out.push(L('fild', fmem(FT.i16 + 2 * r.int(4), 2)));
      else if (shape === 5) out.push(L('fild', fmem(FT.i64 + 8 * r.int(2), 8)));
      // Not the irrational constants: the x87 holds them to 64 bits, a double to 53, so arithmetic on
      // one can differ in its last bit (part D checks each constant itself, exactly).
      else out.push(L(r.pick(['fld1', 'fldz'])));
      d++; cc = null;
    } else if (kind < 34 && d > 0) {
      const shape = r.int(6);
      if (shape === 0) out.push(L(r.pick(['fst', 'fstp']), slot(8)));
      else if (shape === 1) out.push(L(r.pick(['fst', 'fstp']), slot(4)));
      else if (shape === 2) out.push(L(r.pick(['fist', 'fistp']), slot(4)));
      else if (shape === 3) out.push(L(r.pick(['fist', 'fistp']), slot(2)));
      else if (shape === 4) out.push(L('fistp', slot(8)));
      else { out.push(L(r.pick(['fst', 'fstp']), sti(r.int(d)))); }
      if (out.at(-1).m.startsWith('fstp') || out.at(-1).m.startsWith('fistp')) d--;
      cc = null;
    } else if (kind < 60 && d > 0 && nearest) {
      const op = r.pick(['fadd', 'fsub', 'fsubr', 'fmul', 'fdiv', 'fdivr']);
      const shape = r.int(7);
      if (shape === 0) out.push(L(op, D()));
      else if (shape === 1) out.push(L(op, F()));
      else if (shape === 2) out.push(L(op, ST0, sti(r.int(d))));
      else if (shape === 3 && d > 1) out.push(L(op, sti(r.int(d)), ST0));
      else if (shape === 4 && d > 1) { out.push(L(`${op}p`, sti(1 + r.int(d - 1)), ST0)); d--; }
      else if (shape === 5 && d > 1) { out.push({ m: op, n: `${op}p st1,st0` }); d--; }
      else out.push(L(`fi${op.slice(1)}`, r.int(2) ? fmem(FT.i32 + 4 * r.int(4), 4) : fmem(FT.i16 + 2 * r.int(4), 2)));
      cc = null;
    } else if (kind < 68 && d > 0) {
      const op = nearest ? r.pick(['fchs', 'fabs', 'fsqrt', 'frndint']) : r.pick(['fchs', 'fabs', 'frndint']);
      out.push(L(op)); cc = null;
    } else if (kind < 72 && d > 1) {
      out.push(L('fxch', sti(1 + r.int(d - 1)))); cc = null;
    } else if (kind < 86 && d > 0) {
      const shape = r.int(8);
      if (shape === 0 && d > 1) out.push(L(r.pick(['fcom', 'fucom']), sti(1 + r.int(d - 1))));
      else if (shape === 1 && d > 1) { out.push(L(r.pick(['fcomp', 'fucomp']), sti(1 + r.int(d - 1)))); d--; }
      else if (shape === 2 && d > 1) { out.push(L(r.pick(['fcompp', 'fucompp']))); d -= 2; }
      else if (shape === 3) out.push(L('fcom', D()));
      else if (shape === 4) { out.push(L('fcomp', F())); d--; }
      else if (shape === 5 && d > 1) {
        // fcomi writes EFLAGS directly; a jump reads them.
        const op = r.pick(['fcomi', 'fcomip', 'fucomi', 'fucomip']);
        out.push(L(op, ST0, sti(1 + r.int(d - 1))));
        if (op.endsWith('p')) d--;
        const k = lab++;
        out.push({ m: `${r.pick(['jz', 'jc', 'jbe', 'ja', 'jp', 'jnp'])} F${k}`, n: '' });
        out.at(-1).n = out.at(-1).m;
        out.push(L('inc', reg('edx')), { label: `F${k}` });
        cc = null;
        continue;
      } else out.push(L('ftst'));
      cc = 'cmp';
      // The status word reaches a jump through AX and SAHF, as Visual C++ code does it.
      if (cc && r.int(2)) {
        const k = lab++;
        out.push(L('fnstsw', reg('ax')), L('sahf'), { m: `${r.pick(['jz', 'jc', 'jbe', 'ja', 'jp', 'jnp'])} F${k}`, n: '' });
        out.at(-1).n = out.at(-1).m;
        // AX keeps the whole status word: its exception flags and C1 are not modelled, so mask them.
        out.push(L('inc', reg('edx')), { label: `F${k}` }, L('and', reg('eax'), imm(0x4500)));
      }
    } else if (kind < 96 && d < 7) {
      // fprem is not here: Unicorn's QEMU 5 computes it in double (part D asks a newer QEMU).
      out.push(L('fild', fmem(FT.small + 2 * r.int(4), 2)), L('fld', D()), L('fscale'), L('fstp', sti(1)));
      d++; cc = null;
    } else if (d < 8) {
      // An 80-bit store and load back.
      out.push(L('fld', D()), L('fstp', fmem(0xc00, 10)), L('fld', fmem(0xc00, 10)));
      d++; cc = null;
    }
  }
  // The condition codes, when defined; then the stack, top first.
  // C1 after a compare is 0 by the SDM and not by QEMU: compared only as fprem's quotient bit.
  if (cc) out.push(L('fnstsw', reg('ax')), L('and', reg('eax'), imm(cc === 'prem' ? 0x4700 : 0x4500)), L('mov', mem(STATUS, 4, false), reg('eax')));
  for (let k = 0; k < d; k++) out.push(L('fstp', fmem(STACK + 8 * k, 8)));
  return { lines: out, skip: [] };
}

/*
 * PART D: the x87 operations Unicorn's QEMU 5 computes in host double -- fprem, the transcendentals
 * -- asked instead of the oracle container's x87 (a newer QEMU, whose x87 is 80-bit floatx80, run by
 * Docker under linux/386). Each entry sets a control word, pushes its inputs (the last on top), runs
 * one operation and stores what it leaves. gcc's GNU asm and PRISM's __asm run the same entries.
 * Exact where the result is exact; in ULPs (2) for a transcendental, which neither side rounds
 * correctly. Entries marked `open` are printed, not judged: they are where the oracle and the SDM
 * part ways, and no silicon is at hand to say which one a Pentium follows.
 */
function x87Table() {
  const out = [];
  const add = (cw, inputs, ops, pushes, judge) => out.push({ cw, inputs, ops, pushes, ...judge });
  const xs = [0, -0, 1e-9, 0.5, -0.75, 1, 1.5707963267948966, 2, 3.141592653589793, -3, 6, 10, -10, 100.25, 1e5];
  for (const x of xs) {
    add(0x27f, [x], ['fsin'], 1, { tol: 2 }); add(0x27f, [x], ['fcos'], 1, { tol: 2 });
    add(0x27f, [x], ['fsincos'], 2, { tol: 2 }); add(0x27f, [x], ['fptan'], 2, { tol: 2 });
  }
  for (const x of [-1, -0.5, -1e-6, 0, 1e-6, 0.25, 0.5, 0.999, 1]) add(0x27f, [x], ['f2xm1'], 1, { tol: 2 });
  for (const [y, x] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0], [3, 4], [1e-3, 10], [10, 1e-3]]) add(0x27f, [y, x], ['fpatan'], 1, { tol: 2 });
  for (const [y, x] of [[1, 2], [1, 8], [2.5, 10], [1, 0.5], [-3, 7], [1, 1e-5], [0.5, 1e10], [1, 1]]) add(0x27f, [y, x], ['fyl2x'], 1, { tol: 2 });
  for (const [y, x] of [[1, 0], [1, 1e-9], [1, 0.25], [2, -0.25], [1, 0.1]]) add(0x27f, [y, x], ['fyl2xp1'], 1, { tol: 2 });
  // fprem: the sign of a zero remainder, quotients past 2^53, and a partial reduction (C2).
  for (const [b, a] of [[3, 7], [3, -7], [-3, 7], [-5, -5], [5, 5], [1.25, 5.5], [3, 1e10], [0.1, 1e15], [7.5, 1e18], [3, 1e30], [7.5, 1e300], [1e-300, 1e-200]]) {
    add(0x27f, [b, a], ['fprem', 'fstp st(1)'], 1, { exact: true });
    add(0x27f, [b, a], ['fprem', 'fstsw ax'], 0, { exact: true, status: true });
  }
  for (const op of ['fldpi', 'fldl2e', 'fldl2t', 'fldlg2', 'fldln2', 'fld1', 'fldz']) add(0x27f, [], [op], 1, { exact: true });
  // Precision control on the square root, which the SDM lists (and MIRAGE does not apply).
  for (const x of [2, 3, 0.5, 10, 1e-5, 12345.678, 7.000001, 1e30]) { add(0x27f, [x], ['fsqrt'], 1, { exact: true }); add(0x07f, [x], ['fsqrt'], 1, { exact: true }); }
  // Floats in, so that the load is exact under either reading (QEMU rounds a double loaded at 24 bits).
  for (const [a, b] of [[1.1, 2.2], [1 / 3, 1], [1e10, 3.3]].map((p) => p.map(Math.fround))) for (const op of ['faddp st(1),st', 'fmulp st(1),st', 'fdivp st(1),st', 'fsubp st(1),st']) add(0x07f, [a, b], [op], 1, { exact: true });
  // Where the oracle rounds and the SDM says the precision control does not.
  for (const [n, x] of [[3, 1.1], [-2, 1 / 3]]) add(0x07f, [n, x], ['fscale', 'fstp st(1)'], 1, { open: 'fscale at 24 bits' });
  for (const x of [1.2345678901234567, 0.1]) add(0x07f, [x], [], 1, { open: 'a double loaded at 24 bits' });
  for (const x of [0.4567890123456789]) add(0x07f, [x], ['fsin'], 1, { open: 'fsin at 24 bits' });
  return out;
}

/** One entry as GNU asm (AT&T) and as MSVC asm. */
function x87Gnu(e, k) {
  const st = (t) => t.replace(/st\((\d)\)/g, '%%st($1)').replace(/\bst\b(?!\()/g, '%%st');
  const lines = ['fninit', `fldcw CW${k}`, ...e.inputs.map((_, i) => `fldl IN${k}+${8 * i}`),
    ...e.ops.map((o) => {
      const m = /^(f\w+) (.*)$/.exec(o);
      if (o === 'fstsw ax') return 'fnstsw %%ax\\n\\tmovw %%ax, SW';
      if (!m) return o;
      // AT&T reverses the operands of the two-register forms -- and gas, keeping the Unixware
      // assembler's mistake, encodes fsubp/fdivp to st(i) as fsubrp/fdivrp and back.
      const ops = m[2].split(',').map((x) => st(x.trim())).reverse();
      const swap = ops.length === 2 ? { fsubp: 'fsubrp', fsubrp: 'fsubp', fdivp: 'fdivrp', fdivrp: 'fdivp' }[m[1]] : null;
      return `${swap ?? m[1]} ${ops.join(', ')}`;
    }),
    ...Array.from({ length: e.pushes }, (_, i) => `fstpl OUT+${8 * i}`)];
  return lines.join('\\n\\t');
}
function x87Masm(e, k) {
  return ['fninit', `fldcw word ptr [CW${k}]`, ...e.inputs.map((_, i) => `fld qword ptr [IN${k}+${8 * i}]`),
    ...e.ops.map((o) => (o === 'fstsw ax' ? 'fnstsw ax\n  mov word ptr [SW],ax' : o)),
    ...Array.from({ length: e.pushes }, (_, i) => `fstp qword ptr [OUT+${8 * i}]`)].join('\n  ');
}
function x87Program(table, dialect) {
  const data = table.map((e, k) => `static unsigned short CW${k} = ${e.cw}; static double IN${k}[4] = { ${[...e.inputs, 0].map((v) => (Object.is(v, -0) ? '-0.0' : v.toPrecision(17))).join(', ')} };`).join('\n');
  const fns = table.map((e, k) => (dialect === 'gnu'
    ? `void t${k}(void) { __asm__ volatile("${x87Gnu(e, k)}" ::: "memory", "ax"); }`
    : `void t${k}(void) {\n  __asm {\n  ${x87Masm(e, k)}\n  }\n}`)).join('\n');
  return `#include <stdio.h>
#include <string.h>
double OUT[8]; unsigned short SW;
${data}
${fns}
${dialect === 'gnu' ? `int main(void) {
  unsigned long long u; int j;
${table.map((e, k) => `  memset(OUT, 0, sizeof OUT); SW = 0; t${k}(); for (j = 0; j < ${Math.max(e.pushes, 1)}; j++) { memcpy(&u, &OUT[j], 8); printf("%016llx ", u); } printf("%04x\\n", SW & 0x4700);`).join('\n')}
  return 0;
}` : ''}
`;
}

function captureX87() {
  const table = x87Table();
  const r = compileRun(x87Program(table, 'gnu'), { std: 'gnu99' });
  if (r.code !== 0) throw new Error(`the oracle's x87 program: ${r.stderr}`);
  const rows = r.stdout.trim().split('\n');
  return table.map((e, k) => ({ ...e, want: rows[k] }));
}

function replayX87(g, mutate = null) {
  const table = g.x87;
  if (!table) { report(false, 'D. x87 against the oracle container', 'no x87 table in the golden: --capture'); return; }
  const p = compileProgram([{ file: 'x87.c', source: x87Program(table, 'masm') }], { resolve: builtinHeaderResolver({}), collect: true });
  for (const f of p.failures ?? []) report(false, `D. ${f.fn} compiles`, f.message);
  const dv = p.mod.dv, OUTA = p.mod.symbols.get('OUT').addr, SWA = p.mod.symbols.get('SW').addr;
  let pass = 0, n = 0;
  const opens = [];
  for (let k = 0; k < table.length; k++) {
    const e = table[k];
    for (let j = 0; j < 8; j++) dv.setFloat64(OUTA + 8 * j, 0, true);
    dv.setUint16(SWA, 0, true);
    p.M._x86 = makeX86(); mutate?.(p.M._x86);
    try { p.F[`t${k}`](); } catch (err) { report(false, `D. entry ${k} runs`, err.message); continue; }
    const want = e.want.split(' ');
    const got = [];
    for (let j = 0; j < Math.max(e.pushes, 1); j++) got.push(dv.getBigUint64(OUTA + 8 * j, true).toString(16).padStart(16, '0'));
    got.push((dv.getUint16(SWA, true) & 0x4700).toString(16).padStart(4, '0'));
    const what = `${e.ops.join('; ') || 'load'} on [${e.inputs.join(', ')}] at cw ${e.cw.toString(16)}`;
    if (e.open) { opens.push(`${e.open}: ${got.slice(0, e.pushes).join(' ') === want.slice(0, e.pushes).join(' ') ? 'agree' : `PRISM ${got[0]}, oracle ${want[0]}`}`); continue; }
    n++;
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (j === want.length - 1) { if (e.status && got[j] !== want[j]) ok = false; continue; }
      if (e.exact) { if (got[j] !== want[j]) ok = false; continue; }
      const a = Buffer.from(got[j], 'hex').readDoubleBE(0), b = Buffer.from(want[j], 'hex').readDoubleBE(0);
      if (!(Number.isNaN(a) && Number.isNaN(b)) && ulpDistance(a, b) > e.tol) ok = false;
    }
    if (ok) pass++;
    else if (!mutate) console.log(`       ${what}: PRISM ${got.join(' ')} | oracle ${e.want}`);
  }
  if (mutate) return { pass, n };
  report(pass === n, `D. x87 against the oracle container's: ${pass}/${n} entries`, 'fprem, constants, the precision control, transcendentals in 2 ULPs');
  for (const o of opens) console.log(`       open -- ${o}`);
  return { pass, n };
}

/** Stores the results, on both sides: the five general registers, then the eight MMX ones. */
const SAVE = [...R[4].map((name, k) => L('mov', mem(OUT + 4 * k, 4, false), reg(name))),
  ...Array.from({ length: 8 }, (_, k) => L('movq', mem(OUT + 0x20 + 8 * k, 8, false), reg(`mm${k}`)))];

// On the chip the MMX registers ARE the x87 registers' significands, which this model does not alias
// (src/asm/msvc-rt.js): an x87 case stores the general registers only.
const saveFor = (fpu) => (fpu ? SAVE.slice(0, 5) : SAVE);

function nasmSource(lines, fpu = false) {
  return ['bits 32', `mov ebx,${hex(LAYOUT.buf)}`, ...[...lines, ...saveFor(fpu)].map((l) => (l.label ? `${l.label}:` : l.n))].join('\n') + '\n';
}

/** The C function PRISM runs for a case: the snippet, the stores, then the flags into globals. */
function cFunction(k, lines, fpu = false) {
  const body = ['lea ebx,g_mem', ...[...lines, ...saveFor(fpu)].map((l) => (l.label ? `${l.label}_${k}:` : l.m.replace(/\b([LF]\d+)\b/g, `$1_${k}`)))];
  const flags = [['jnc', 'cf'], ['jnz', 'zf'], ['jns', 'sf'], ['jno', 'of'], ['jnp', 'pf']]
    .map(([j, f]) => `  ${j} no_${f}_${k}\n  mov g_${f},1\nno_${f}_${k}:`);
  return `void c${k}(void) {\n  __asm {\n${body.map((l) => `  ${l}`).join('\n')}\n${flags.join('\n')}\n  }\n}\n`;
}

/** The flag grid: every ALU operation at the three widths on pairs of edge values, as the LAST instruction. */
function edgeGrid() {
  const EDGE = [0, 1, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff];
  const out = [];
  for (const [w, d, s] of [[4, 'eax', 'ecx'], [2, 'ax', 'cx'], [1, 'al', 'cl']]) {
    const vals = [...new Set(EDGE.map((v) => (v & MASKW[w]) >>> 0))];
    for (const op of ['add', 'sub', 'cmp', 'and', 'or', 'xor', 'test', 'adc']) {
      for (const a of vals) for (const b of vals) {
        const pre = op === 'adc' ? [L(a & 1 ? 'stc' : 'clc')] : [];
        out.push([L('mov', reg('eax'), imm(a)), L('mov', reg('ecx'), imm(b)), ...pre, L(op, reg(d), reg(s))]);
      }
    }
    for (const op of ['inc', 'dec', 'neg']) {
      for (const a of vals) for (const cf of ['clc', 'stc']) out.push([L('mov', reg('eax'), imm(a)), L(cf), L(op, reg(d))]);
    }
    for (const op of ['shl', 'shr', 'sar']) {
      for (const a of vals) for (const n of [1, 2, w * 8 - 1]) {
        out.push([L('mov', reg('eax'), imm(a)), L('clc'), L('add', reg('edx'), reg('edx')), L(op, reg(d), imm(n))]);
      }
    }
  }
  return out.map((lines) => ({ lines, skip: lines.at(-1).m.match(/^s[ha][lr] .*,0x(?!1$)/) ? ['o'] : [] }));
}

/**
 * A case from its kind and seed: the generators are deterministic, so the golden keeps the seed and a
 * hash of the text, and the replay makes the text again -- a generator that drifted is caught by the
 * hash and asks for a recapture instead of comparing against answers to other questions.
 */
let GRID = null;
function generate(kind, seed, index) {
  if (kind === 'int') return snippet(seed);
  if (kind === 'grid') return (GRID ??= edgeGrid())[index];
  return fpuSnippet(seed);
}
const linesHash = (lines) => createHash('sha256').update(JSON.stringify(lines.map((l) => (l.label ? `${l.label}:` : l.m)))).digest('hex').slice(0, 16);

function capture() {
  const dir = mkdtempSync(join(tmpdir(), 'msvcasm-'));
  const cases = [];
  const grid = edgeGrid();
  const N = CASES + grid.length + FPU_CASES;
  for (let k = 0; k < N; k++) {
    const kind = k < CASES ? 'int' : k < CASES + grid.length ? 'grid' : 'fpu';
    const seed = kind === 'int' ? 0x3a5e0000 + k * 7919 : kind === 'fpu' ? 0x0f870000 + k * 104729 : 0;
    const { lines, skip } = kind === 'int' ? snippet(seed) : kind === 'grid' ? grid[k - CASES] : fpuSnippet(seed);
    const src = join(dir, `c${k}.asm`), bin = join(dir, `c${k}.bin`);
    const fpu = kind === 'fpu';
    writeFileSync(src, nasmSource(lines, fpu));
    const a = spawnSync('nasm', ['-f', 'bin', src, '-o', bin], { encoding: 'utf8' });
    if (a.status !== 0) throw new Error(`nasm on case ${k}: ${a.stderr}\n${nasmSource(lines, fpu)}`);
    cases.push({ seed, lines, skip, code: readFileSync(bin).toString('hex'), fill: kind === 'int' || kind === 'fpu', kind });
  }
  const r = spawnSync(PY, [join(ROOT, 'tools/oracle/unicorn-pm32.py')], {
    input: JSON.stringify({ layout: LAYOUT, cases: cases.map((c) => ({ code: c.code, seed: c.seed, fill: c.fill })) }),
    encoding: 'utf8', maxBuffer: 64 << 20,
  });
  if (r.status !== 0) throw new Error(`unicorn-pm32.py: ${r.stderr}`);
  const { results } = JSON.parse(r.stdout);
  const golden = {
    _doc: 'Unicorn 32-bit (a Pentium III), running nasm -f bin of the SAME snippets PRISM translates from Visual C++ '
      + '__asm syntax. Captured by tools/gate-msvcasm.mjs --capture; replayed without Python or nasm.',
    layout: LAYOUT,
    cases: cases.map((c, i) => ({ seed: c.seed, fill: c.fill, kind: c.kind, ...(c.kind === 'grid' ? { index: i - CASES } : {}), hash: linesHash(c.lines),
      // Only the stored registers are kept for diagnosis: five general ones and eight MMX ones.
      want: results[i].error ? results[i] : { ...results[i], out: results[i].out.slice(0, 0xa0 * 2) } })),
    // Part D: the oracle container's x87, through gcc's GNU asm.
    x87: captureX87(),
  };
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  const errs = results.filter((x) => x.error).length;
  console.log(`captured ${cases.length} cases (${errs} that Unicorn could not finish) -> goldens/msvc-asm.json`);
}

/** Build every case once; `check(builds, x86)` then runs them all against one MMX runtime. */
function buildAll(g) {
  const globals = ['unsigned char g_mem[4096];', ...['cf', 'zf', 'sf', 'of', 'pf'].map((f) => `unsigned g_${f};`)].join('\n');
  const BATCH = 250, builds = [];
  for (let from = 0; from < g.cases.length; from += BATCH) {
    const part = g.cases.slice(from, from + BATCH);
    const src = `${globals}\n${part.map((c, j) => cFunction(from + j, c.lines, c.kind === 'fpu')).join('\n')}`;
    builds.push(compileProgram([{ file: 'cases.c', source: src }], { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true }));
  }
  return builds;
}

/** How many doubles lie between a and b. */
function ulpDistance(a, b) {
  const v = new DataView(new ArrayBuffer(16));
  v.setFloat64(0, a); v.setFloat64(8, b);
  const ord = (o) => { const x = v.getBigInt64(o); return x < 0n ? -(x & 0x7fffffffffffffffn) : x; };
  const d = ord(0) - ord(8);
  return Number(d < 0n ? -d : d);
}

function check(g, builds, x86 = null) {
  let pass = 0, skipped = 0, firstBad = null;
  const byKind = {};
  const BATCH = 250;
  for (let k = 0; k < g.cases.length; k++) {
    const c = g.cases[k];
    const p = builds[Math.floor(k / BATCH)];
    if (x86) p.M._x86 = x86; else p.M._x86 = makeX86();
    const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
    const dv = p.mod.dv, u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const at = (n) => p.mod.symbols.get(n).addr;
    if (c.want.error) { skipped++; continue; }
    const why = [];
    if (failed.has(`c${k}`)) why.push(`refused: ${failed.get(`c${k}`)}`);
    else {
      const buf = at('g_mem');
      if (c.fill) u8.set(fillBytes(c.seed, g.layout.size), buf); else u8.fill(0, buf, buf + g.layout.size);
      for (const f of ['cf', 'zf', 'sf', 'of', 'pf']) dv.setUint32(at(`g_${f}`), 0, true);
      try { p.F[`c${k}`](); } catch (e) { why.push(`threw ${e.message}`); }
      if (!why.length) {
        for (const f of ['cf', 'zf', 'sf', 'of', 'pf']) {
          if (c.skip.includes(f[0])) continue;
          const got = dv.getUint32(at(`g_${f}`), true);
          if (got !== c.want[f]) why.push(`${f} ${got} want ${c.want[f]}`);
        }
        const mine = u8.subarray(buf, buf + g.layout.size);
        if (c.tol !== undefined) {
          // In ULPs: the transcendentals of a double are not the 80-bit unit's, and need not be.
          const dvm = new DataView(mine.buffer, mine.byteOffset, mine.byteLength);
          const wantv = Buffer.from(c.want.out, 'hex');
          for (let j = 0; j < c.pushes; j++) {
            const a = dvm.getFloat64(g.layout.out + 0x60 + 8 * j, true), b = wantv.readDoubleLE(0x60 + 8 * j);
            const ulps = Number.isNaN(a) && Number.isNaN(b) ? 0 : Object.is(a, b) ? 0 : ulpDistance(a, b);
            if (ulps > c.tol) why.push(`st(${j}) ${a} want ${b} (${ulps} ulp)`);
          }
        } else if (createHash('sha256').update(mine).digest('hex') !== c.want.mem) {
          const got = Buffer.from(mine.subarray(g.layout.out)).toString('hex');
          const names = [...R[4], 'sw', ...Array.from({ length: 8 }, (_, i) => `mm${i}`), ...Array.from({ length: 8 }, (_, i) => `st${i}`)];
          const diffs = names.map((n, i) => {
            const [o, len] = i < 5 ? [4 * i, 4] : i === 5 ? [0x18, 4] : i < 14 ? [0x20 + 8 * (i - 6), 8] : [0x60 + 8 * (i - 14), 8];
            const a = got.slice(o * 2, (o + len) * 2), b = c.want.out.slice(o * 2, (o + len) * 2);
            return a === b ? null : `${n} ${a} want ${b}`;
          }).filter(Boolean);
          why.push(diffs.length ? diffs.join('; ') : 'data memory differs');
        }
      }
    }
    const kind = c.kind ?? 'int';
    byKind[kind] ??= { pass: 0, n: 0 }; byKind[kind].n++;
    if (why.length) { if (!firstBad) firstBad = { k, why, lines: c.lines }; if (process.env.ALLBAD && !x86) console.log(`  case ${k} (${kind}): ${why.join('; ')}`); } else { pass++; byKind[kind].pass++; }
  }
  return { pass, n: g.cases.length - skipped, skipped, firstBad, byKind };
}

function replay() {
  if (!existsSync(GOLDEN)) { console.log('no goldens/msvc-asm.json: run with --capture first'); process.exit(1); }
  const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  let drifted = 0;
  for (const c of g.cases) {
    const { lines, skip } = generate(c.kind, c.seed, c.index);
    if (linesHash(lines) !== c.hash) drifted++;
    c.lines = lines; c.skip = skip;
  }
  if (drifted) { report(false, 'A. the snippets are the ones captured', `${drifted} differ: the generator changed, run --capture`); return; }
  const builds = buildAll(g);
  const { pass, n, skipped, firstBad, byKind } = check(g, builds);
  report(pass === n, `A. Unicorn 32-bit: ${pass}/${n} cases agree`, skipped ? `(${skipped} Unicorn could not finish)` : '');
  const KIND = { int: 'random integer and MMX snippets', grid: 'the flag grid', fpu: 'x87 snippets, exact' };
  for (const [k, v] of Object.entries(byKind)) console.log(`        ${KIND[k] ?? k}: ${v.pass}/${v.n}`);
  if (firstBad) {
    console.log(`       first disagreement, case ${firstBad.k}: ${firstBad.why.slice(0, 4).join('; ')}`);
    for (const l of firstBad.lines) console.log(`         ${l.label ? `${l.label}:` : l.m}`);
  }
  // Each mutation of the MMX runtime must be caught.
  const MUTATIONS = {
    'pmulhw >> 15': (X) => { X.pmulhw = (d, s) => { for (let k = 0; k < 4; k++) X.i16[d * 4 + k] = Math.imul(X.i16[d * 4 + k], X.i16[s * 4 + k]) >> 15; }; },
    'paddsw wraps': (X) => { const w = X.paddw; X.paddsw = w; },
    'psrlw keeps a count past 15': (X) => { X.psrlw = (d, s, imm) => { const c = (s < 0 ? imm : X.u32[s * 2]) & 15; for (let k = 0; k < 4; k++) X.u16[d * 4 + k] >>>= c; }; },
  };
  // ...and of the x87's: part C or part D must turn red.
  const X87_MUTATIONS = {
    'precision control ignored': (X) => { X.f.r = (v) => v; },
    'frndint truncates': (X) => { X.f.rint = Math.trunc; },
    'fprem leaves the quotient bits': (X) => { const p = X.f.prem; X.f.prem = () => { const sw = X.f.sw; p(); X.f.sw = (X.f.sw & ~0x4300) | (sw & 0x4300); }; },
    'fcom reverses below and above': (X) => { const c = X.f.com; X.f.com = (a, b) => c(b, a); },
  };
  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    const X = makeX86(); mutate(X);
    const m = check(g, builds, X);
    report(m.pass < m.n, `   mutation '${name}' is caught`, `${m.n - m.pass} cases red`);
  }
  replayX87(g);
  for (const [name, mutate] of Object.entries(X87_MUTATIONS)) {
    const X = makeX86(); mutate(X);
    const c = check(g, builds, X), d = replayX87(g, mutate);
    const red = (c.n - c.pass) + (d.n - d.pass);
    report(red > 0, `   mutation '${name}' is caught`, `${c.n - c.pass} cases and ${d.n - d.pass} entries red`);
  }
}

// ------------------------------------------------------------------------------------------ part B
const PROBES = `
typedef unsigned long long u64;
typedef struct { int pad; int Src; int Count; } Ctx;
enum { SEVEN = 7 };
int global = 5;
u64 mmsave;

int b_param(int a) { __asm { mov eax, [a] ; a comment that is not an instruction: mov eax, 0
    add eax, a } }
int b_local(void) { int x = 20; __asm { mov eax, x
  add x, eax }
  return x; }
int b_static(void) { static int s = 3; __asm { mov eax, s
  imul eax, eax, 11 } }
int b_global(void) { __asm add global, 10
  return global; }
int b_field(Ctx *c) { __asm { mov esi, [c]
  mov eax, [esi]Ctx.Count
  add eax, Ctx.Src } }
int b_enum(void) { __asm { mov eax, SEVEN } }
int b_labels(int n) { __asm {
    xor eax, eax
    mov ecx, n
  again: add eax, ecx
    dec ecx
    jnz again } }
int b_computed(int m) {
  int r = 0;
  __asm {
    lea eax, l0
    cmp m, 1
    jne go
    lea eax, l1
  go:
    jmp eax
  l0:
    mov r, 100
    jmp done
  l1:
    mov r, 200
  done:
  }
  return r;
}
int b_oneline(void) { __asm mov eax, 1 __asm add eax, 2
  __asm { emms }; }
u64 b_edxeax(void) { __asm { mov edx, 0x11223344
  mov eax, 0x55667788 } }
unsigned char b_al(void) { __asm { mov eax, 0x1ff } }
short b_ax(void) { __asm { mov eax, 0x18000 } }
void b_mmset(void) { __asm { pcmpeqb mm5, mm5
  psrlw mm5, 1 } }
/* .kkrieger's _types.hpp, as written (the calling conventions dropped). */
void sFloatFix(void) { __asm {
    fclex;
    push 0103fh; // round to nearest even + single precision
    fldcw [esp];
    pop eax; } }
unsigned short b_cw(void) { unsigned short cw; __asm { fnstcw cw } return cw; }
int sFtol(const float f) { __asm {
    fld f
    push eax
    fistp dword ptr [esp]
    pop eax } }
float sFRound(const float f) { __asm {
    fld f
    frndint } }
void sFSinCos(const float x, float *sine, float *cosine) { __asm {
    fld x;
    fsincos;
    mov eax,[cosine];
    fstp dword ptr [eax];
    mov eax,[sine];
    fstp dword ptr [eax]; } }
int sMulShift(int var_a, int var_b) { __asm {
    mov eax, var_a
    imul var_b
    shrd eax, edx, 16 } }
int sDivShift(int var_a, int var_b) { __asm {
    mov eax,var_a
    mov edx,eax
    shl eax,16
    sar edx,16
    idiv var_b } }
int sMulDiv(int var_a, int var_b, int var_c) { __asm {
    mov eax,var_a
    imul var_b
    idiv var_c } }
float b_sincos(void) { float s, c; sFSinCos(0.5f, &s, &c); return s * 1000 + c; }
/* kdoc.cpp's CallCode: the operator's arguments copied onto the stack, then a call through a pointer. */
static int CallCode(int code, int *para, int count) {
  int result;
  __asm {
    mov eax,code
    mov esi,para
    mov ecx,count
    push ebp
    mov ebp,esp
    sub esp,ecx
    sub esp,ecx
    sub esp,ecx
    sub esp,ecx
    mov edi,esp
    rep movsd

    call eax

    mov esp,ebp
    pop ebp
    mov result,eax
  }
  return result;
}
int op3(int a, float b, int c) { return a * 1000 + (int)(b * 10) + c; }
int b_callcode(void) {
  float f = 2.5f;
  int para[3];
  para[0] = 7; para[1] = *(int *)&f; para[2] = 9;
  return CallCode((int)op3, para, 3);
}
/* a call through a register to a function returning a float: the result is ST(0), stored by fstp */
float opf(int a, int b) { return a * 0.5f + b; }
int b_callfloat(void) {
  float r;
  void *fn = (void *)opf;
  __asm {
    push 6
    push 9
    mov eax,fn
    call eax
    add esp,8
    fstp r
  }
  return (int)(r * 100);
}
int b_mmget(void) { __asm { movq mmsave, mm5
  emms }
  return mmsave == 0x7fff7fff7fff7fffULL; }
`;
// The same through the C++ front end, which rewrites the names first (src/cxx/sema-stmt.js msvcAsm).
const CXX_PROBES = `
typedef unsigned __int64 sU64;
struct Base { int pad; };
struct Ctx : Base { sU64 *Src; int XShift; };
enum { SEVEN = 7 };
namespace N { int g = 4; }
void Fade64(sU64 &r, sU64 &c0, sU64 &c1, int fade) {
  static const sU64 xor0 = 0xffffffff00000000;
  static const sU64 add0 = 0x0000800100000000;
  __asm {
    mov eax, [c0];
    movq mm2, [eax];
    mov eax, [c1];
    movq mm3, [eax];
    movd mm0, [fade];
    punpckldq mm0, mm0;
    psrad mm0, 1;
    pxor mm0, [xor0];
    paddd mm0, [add0];
    packssdw mm0, mm0;
    punpcklwd mm0, mm0;
    movq mm1, mm0;
    punpcklwd mm0, mm0;
    punpckhwd mm1, mm1;
    mov eax, [r];
    pmulhw mm3, mm0;
    pmulhw mm2, mm1;
    paddw mm2, mm3;
    psllw mm2, 1;
    movq [eax], mm2;
    emms;
  }
}
int x_fade(void) {
  sU64 r, a = 0x4000300020001000ULL, b = 0x1000200030004000ULL;
  Fade64(r, a, b, 0x4000);
  return r == 0x34002c0024001c00ULL;
}
int x_names(Ctx *ctx) { __asm {
    mov esi, [ctx];
    mov eax, [esi]Ctx.XShift;
    add eax, SEVEN
    add eax, N::g } }
class K { public: int v; int get() { int t = v; __asm { mov eax, t
  shl eax, 1 } } };
/* _viruz2.cpp's CV2MPlayer::Play: this in a register, a member as its offset. */
class V { public: int pad; int m_samplerate; int m_tpc; int ratio(int a_time) { int d;
  __asm {
    mov  ecx, this
    mov  eax, [a_time]
    mov  ebx, [ecx + m_samplerate]
    imul ebx
    mov  ebx, [ecx + m_tpc]
    idiv ebx
    mov  [d], eax
  }
  return d; } };
int x_member(void) { V v; v.m_samplerate = 44100; v.m_tpc = 7; return v.ratio(1000); }
int x_method(void) { K k; k.v = 21; return k.get(); }
`;

const REFUSE = [
  ['ebp', 'int f(void) { __asm { mov eax, [ebp+8] } }', /ebp/],
  ['call', 'void g(void); void f(void) { __asm { call g } }', /call/],
  ['int', 'void f(void) { __asm { int 3 } }', /int/],
  ['an x87 instruction outside the subset', 'float x; void f(void) { __asm { fld x \n fxtract } }', /fxtract/],
  ['a string instruction that compares', 'void f(void) { __asm { rep scasb } }', /scasb/],
  ['an unknown label', 'void f(void) { __asm { jmp nowhere } }', /nowhere/],
  ['an unsized operand', 'struct S { int a, b; } s; void f(void) { __asm { inc [s] } }', /size/],
  ['an unknown instruction', 'void f(void) { __asm { bswap eax } }', /bswap/],
  ['a model that is not flat', 'void f(void) { __asm { nop } }', /flat/, { model: 'dos16m' }],
];

function probes() {
  const p = compileProgram([{ file: 'probes.c', source: PROBES }], { resolve: builtinHeaderResolver({}), collect: true });
  for (const f of p.failures ?? []) report(false, `B. ${f.fn} compiles`, f.message);
  const call = (name, ...a) => { try { return p.F[name](...a); } catch (e) { return `threw ${e.message}`; } };
  const B = (what, got, want) => report(got === want, `B. ${what}`, got === want ? '' : `got ${got} want ${want}`);
  B('a parameter by name, bracketed and bare; `;` begins a comment', call('b_param', 4), 8);
  B('a local, read and written', call('b_local'), 40);
  B('a static local; three-operand imul', call('b_static'), 33);
  B('a global, the one-line form', call('b_global'), 15);
  const ctx = p.M.rt.malloc(12);
  p.mod.dv.setInt32(ctx + 4, 30, true); p.mod.dv.setInt32(ctx + 8, 12, true);
  B('[esi]Type.field and Type.field as offsets', call('b_field', ctx), 16);
  B('an enum constant', call('b_enum'), 7);
  B('a label before an instruction', call('b_labels', 10), 55);
  B('lea reg,label + jmp reg (Bitmap_Inner\'s dispatch), first way', call('b_computed', 0), 100);
  B('lea reg,label + jmp reg, the other way', call('b_computed', 1), 200);
  B('two __asm on one line, then `__asm { emms };`', call('b_oneline'), 3);
  B('a long long returned in EDX:EAX', String(call('b_edxeax')), String(0x1122334455667788n));
  B('an unsigned char returned in AL', call('b_al'), 0xff);
  B('a short returned in AX, sign-extended', call('b_ax'), -32768);
  call('b_mmset');
  const fl = (v) => Math.fround(v);
  call('sFloatFix');
  B('push 0103fh / fldcw [esp] / pop eax: sFloatFix sets the control word', call('b_cw'), 0x103f);
  B('fistp dword ptr [esp] then pop eax: sFtol rounds to nearest even', `${call('sFtol', 2.5)} ${call('sFtol', -3.5)} ${call('sFtol', 7.25)}`, '2 -4 7');
  B('a float returned in ST(0): sFRound', call('sFRound', 3.5), 4);
  B('fsincos through two pointers', call('b_sincos'), fl(fl(fl(Math.sin(0.5)) * 1000) + fl(Math.cos(0.5))));
  B('imul + shrd: sMulShift, 16.16 fixed point', call('sMulShift', 3 << 16, -(5 << 15)), -(15 << 15));
  B('shl/sar + idiv: sDivShift', call('sDivShift', 3 << 16, 2 << 16), 3 << 15);
  B('CallCode: push ebp/mov ebp,esp, rep movsd the arguments, call eax', call('b_callcode'), 7034);
  B('call eax to a function returning a float, its result in ST(0)', call('b_callfloat'), 1050);
  // The same calls from a SNAPSHOT (what a page loads): call reg reads the callee's declared return type, which
  // the snapshot must keep -- without it EAX was left as it was, and .kkrieger's CallCode returned garbage.
  {
    const s = snapshotProgram(p), q = loadSnapshot({ meta: s.meta, image: s.image, src: s.src });
    const qcall = (name) => { try { return q.F[name](); } catch (e) { return `threw ${e.message}`; } };
    B('CallCode from a snapshot', qcall('b_callcode'), 7034);
    B('call eax returning a float, from a snapshot', qcall('b_callfloat'), 1050);
  }
  B('imul + idiv through EDX:EAX: sMulDiv', call('sMulDiv', 1 << 20, 3000, 7), Math.trunc((2 ** 20 * 3000) / 7));
  B('MMX registers survive from one function to the next', call('b_mmget'), 1);

  const x = compileProgram([{ file: 'probes.cpp', source: CXX_PROBES }], { resolve: builtinHeaderResolver({}), collect: true, cxx: { compiler: 'msvc' } });
  for (const f of x.failures ?? []) report(false, `B. C++: ${f.fn} compiles`, f.message);
  const xcall = (name, ...a) => { try { return x.F[name](...a); } catch (e) { return `threw ${e.message}`; } };
  const xf = (name) => Object.keys(x.F).find((k) => k === name || k.startsWith(`_Z${name.length}${name}`));
  B('C++: Fade64 as genbitmap.cpp writes it, references and static locals', xcall(xf('x_fade')), 1);
  const ctx2 = x.M.rt.malloc(16);
  x.mod.dv.setInt32(ctx2 + 8, 30, true);
  B('C++: [esi]Class.field through a base, an enumerator, N::g', xcall(xf('x_names'), ctx2), 41);
  B('C++: a local in a member function', xcall(xf('x_method')), 42);
  B("C++: `this` and a member as its offset (_viruz2.cpp)", xcall(xf('x_member')), Math.trunc(44100 * 1000 / 7));

  for (const [what, src, re, opts = {}] of REFUSE) {
    const q = compileProgram([{ file: 'r.c', source: src }], { resolve: builtinHeaderResolver({}), collect: true, ...opts });
    const msg = (q.failures ?? []).map((f) => f.message).join(' | ');
    report(re.test(msg) && /inline assembly/.test(msg), `B. refused by name: ${what}`, msg ? msg.slice(0, 70) : 'NOT refused');
  }
}

if (CAPTURE) capture();
else {
  replay();
  probes();
  console.log(bad ? `\n${bad} check(s) failed` : '\nall checks pass');
  process.exit(bad ? 1 : 0);
}
