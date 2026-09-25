// gate-borlandasm.mjs — Borland inline assembly (src/asm/borland.js), in two halves.
//
// A. THE INSTRUCTIONS, against Unicorn. Random real-mode snippets -- the ALU with CF/ZF/SF, 8- and
//    16-bit registers, every addressing form the 8086 has except bp, segment overrides, shifts by a
//    constant and by cl, push/pop, pushf/popf, the string instructions with and without rep, forward
//    conditional jumps and `loop` -- are rendered twice from one description: as Borland `asm`
//    statements inside a C function for PRISM, and as NASM for Unicorn. Both start from the same
//    memory (filled from the case's seed by the same generator on both sides) and the same
//    registers, and must end with the same registers, the same CF/ZF/SF and the same memory.
//
//    CAPTURE ONCE, REPLAY FOREVER, as gate-asm does: `--capture` needs nasm and a Python with
//    unicorn, and writes goldens/borland-asm.json, which is committed; a replay needs neither.
//
//      node tools/gate-borlandasm.mjs --capture [--python=/path/to/python3]
//      node tools/gate-borlandasm.mjs
//
// B. THE C-FACING HALF, which no emulator can speak to because it is about C: names resolved to a
//    static (DS-relative), a local and a parameter (SS-relative); jumps to C labels, one of them
//    named like an enum constant; the far-pointer views; a flag computed on a view refusing to be
//    read; the return in AX and DX:AX; OFFSET; ports through the machine seam; a pushf word popped
//    as data; and every refusal by name -- int, call, bp, std, jl, an unknown label, a model whose
//    DGROUP is not at 0. Executed, each probe a function called directly (run() refuses 16-bit).
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'borland-asm.json');
const CAPTURE = process.argv.includes('--capture');
const PY = process.argv.find((a) => a.startsWith('--python='))?.slice(9) ?? process.env.PRISM_PYTHON ?? 'python3';
const CASES = 400;

// One machine for both sides. DS and ES windows are filled from the seed; the stack sits apart.
const LAYOUT = { code: 0x10000, fill: [[0x20000, 0x14000]], ss: 0x5000, sp: 0xfffe };
const DS = 0x2000, ES = 0x2400;

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(52)} ${detail}`);
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
  // Values at the edges -- where a carry, a borrow or a sign flips -- are where flag bugs live, and a
  // uniform draw almost never lands on them: a mutated `>` for `>=` in add's carry survived 400 cases.
  const EDGE = [0, 1, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xfffe, 0xffff];
  const val = (n) => (int(5) < 2 ? EDGE[int(EDGE.length)] % n : int(n));
  return { int, val, pick: (a) => a[next() % a.length] };
}

// ------------------------------------------------------------------------------------------ part A
const R16 = ['ax', 'bx', 'cx', 'dx', 'si', 'di'];
const R8 = ['al', 'ah', 'bl', 'bh', 'cl', 'ch', 'dl', 'dh'];
const hex = (n) => `0x${n.toString(16)}`;

/** A random operand description; `size` 1 or 2. */
function memOp(r, size) {
  const base = r.pick([null, 'bx']), idx = r.pick([null, 'si', 'di']);
  const disp = (!base && !idx) || r.int(2) ? r.int(0x10000) : 0;
  return { k: 'mem', size, seg: r.int(3) === 0 ? 'es' : null, base, idx, disp };
}
const regOp = (r, size, avoid = []) => ({ k: 'reg', size, name: r.pick((size === 1 ? R8 : R16).filter((x) => !avoid.includes(x))) });

function renderOp(o, dialect, withSize) {
  if (o.k === 'reg') return o.name;
  if (o.k === 'imm') return hex(o.value);
  const terms = [o.base, o.idx, o.disp ? hex(o.disp) : null].filter(Boolean).join('+') || '0';
  const seg = o.seg ? `${o.seg}:` : '';
  const sz = o.size === 1 ? 'BYTE' : 'WORD';
  if (dialect === 'nasm') return `${withSize ? `${sz.toLowerCase()} ` : ''}[${seg}${terms}]`;
  return `[${withSize ? `${sz} PTR ` : ''}${seg}${terms}]`;
}

/** One instruction line in both dialects. */
function line(op, ops = [], { needSize = false } = {}) {
  const sized = needSize || (ops.every((o) => o.k !== 'reg'));
  const b = `${op}${ops.length ? ' ' : ''}${ops.map((o) => renderOp(o, 'borland', sized && o.k === 'mem')).join(',')}`;
  const n = `${op}${ops.length ? ' ' : ''}${ops.map((o) => renderOp(o, 'nasm', sized && o.k === 'mem')).join(',')}`;
  return { b, n };
}

/** A random snippet: a list of { b, n } lines, labels as { label }. */
function snippet(seed) {
  const r = rng(seed);
  const out = [];
  const L = (op, ops, o) => out.push(line(op, ops, o));
  // registers
  for (const reg of R16) L('mov', [{ k: 'reg', size: 2, name: reg }, { k: 'imm', value: r.val(0x10000) }]);
  let lab = 0;
  const count = 6 + r.int(10);
  const one = (avoidCx = false) => {
    const size = r.pick([1, 2]);
    const avoid = avoidCx ? ['cx', 'cl', 'ch'] : [];
    const kind = r.int(100);
    if (kind < 30) {
      const op = r.pick(['add', 'sub', 'cmp', 'and', 'or', 'xor', 'test']);
      const shape = r.int(4);
      const d = shape === 3 ? memOp(r, size) : regOp(r, size, avoid);
      const s = shape === 0 ? { k: 'imm', value: r.val(size === 1 ? 256 : 0x10000) }
        : shape === 1 ? (r.int(3) ? regOp(r, size) : d) : shape === 2 ? memOp(r, size) : regOp(r, size);
      L(op, [d, s]);
    } else if (kind < 42) {
      L(r.pick(['inc', 'dec', 'not', 'neg']), [r.int(3) ? regOp(r, size, avoid) : memOp(r, size)]);
    } else if (kind < 55) {
      const d = r.int(3) ? regOp(r, size, [...avoid, 'cl', 'cx']) : memOp(r, size);
      const bits = size * 8;
      const c = r.int(3) ? { k: 'imm', value: 1 + r.int(bits - 1) } : { k: 'reg', size: 1, name: 'cl' };
      if (c.k === 'reg') {
        if (avoidCx) return;
        L('mov', [{ k: 'reg', size: 1, name: 'cl' }, { k: 'imm', value: 1 + r.int(bits - 1) }]);
      }
      L(r.pick(['shl', 'shr', 'sar']), [d, c], { needSize: d.k === 'mem' });
    } else if (kind < 66) {
      const shape = r.int(3);
      if (shape === 0) L('mov', [regOp(r, size, avoid), memOp(r, size)]);
      else if (shape === 1) L('mov', [memOp(r, size), regOp(r, size)]);
      else L('xchg', [regOp(r, size, avoid), r.int(2) ? memOp(r, size) : regOp(r, size, avoid)]);
    } else if (kind < 72) {
      L(r.pick(['clc', 'stc', 'cmc']));
    } else if (kind < 80) {
      const s = r.pick(['stosb', 'stosw', 'lodsb', 'lodsw', 'movsb', 'movsw']);
      if (!avoidCx && r.int(2)) {
        L('mov', [{ k: 'reg', size: 2, name: 'cx' }, { k: 'imm', value: r.int(24) }]);
        out.push({ b: `rep ${s}`, n: `rep ${s}` });
      } else out.push({ b: s, n: s });
    } else if (kind < 86) {
      const a = regOp(r, 2, avoid);
      L('push', [regOp(r, 2)]);
      L('pop', [a]);
    } else if (kind < 92) {
      L('pushf');
      L(r.pick(['add', 'xor', 'sub']), [regOp(r, 2, avoid), { k: 'imm', value: r.val(0x10000) }]);
      L('popf');
    } else if (kind < 97) {
      const k = lab++;
      out.push(line(r.pick(['jz', 'jnz', 'jc', 'jnc', 'js', 'jns', 'jbe', 'ja', 'jcxz']), []));
      out.at(-1).b += ` L${k}`; out.at(-1).n += ` L${k}`;
      L('inc', [regOp(r, 2, avoid)]);
      out.push({ label: `L${k}` });
    } else if (!avoidCx) {
      const k = lab++;
      L('mov', [{ k: 'reg', size: 2, name: 'cx' }, { k: 'imm', value: 1 + r.int(5) }]);
      out.push({ label: `L${k}` });
      one(true); one(true);
      out.push({ b: `loop L${k}`, n: `loop L${k}` });
    }
  };
  for (let i = 0; i < count; i++) one();
  return out;
}

const SEGSET = [
  { b: `mov ax,${hex(DS)}`, n: `mov ax,${hex(DS)}` }, { b: 'mov ds,ax', n: 'mov ds,ax' },
  { b: `mov ax,${hex(ES)}`, n: `mov ax,${hex(ES)}` }, { b: 'mov es,ax', n: 'mov es,ax' },
];

function nasmSource(lines) {
  return ['bits 16', ...[...SEGSET, ...lines].map((l) => (l.label ? `${l.label}:` : l.n))].join('\n') + '\n';
}

/** The C function PRISM runs for a case: the snippet, then the machine state written to globals. */
function cFunction(k, lines) {
  // Unicorn starts every register at 0; PRISM refuses to read a register the function never wrote
  // (firstUndefinedRead), so the same zeros are written explicitly, with mov, which sets no flag.
  const zero = ['ax', 'bx', 'cx', 'dx', 'si', 'di'].map((r) => ({ b: `mov ${r},0` }));
  const body = [...zero, ...SEGSET, ...lines].map((l) => (l.label ? `${l.label}_${k}:` : `asm ${l.b.replace(/\b(L\d+)\b/, `$1_${k}`)}`));
  const save = ['ax', 'bx', 'cx', 'dx', 'si', 'di'].map((r) => `asm mov [WORD PTR ss:g_${r}],${r}`);
  const segs = ['asm mov [WORD PTR ss:g_ax2],ax', 'asm mov ax,ds', 'asm mov [WORD PTR ss:g_ds],ax',
    'asm mov ax,es', 'asm mov [WORD PTR ss:g_es],ax'];
  const flags = [['jnc', 'cf'], ['jnz', 'zf'], ['jns', 'sf']].map(([j, f]) =>
    `asm ${j} no_${f}_${k}\ng_${f} = 1;\nno_${f}_${k}:`);
  return `void c${k}(void) {\n${[...body, ...flags, ...save, ...segs].join('\n')}\n;}\n`;
}

/**
 * The edge grid: every ALU operation, at both widths, on every pair of edge values, as the LAST
 * instruction so its flags are the ones read back. Random snippets reach a carry out of exactly
 * 0xFFFF too rarely to tell `>` from `>=`; this reaches it by construction. No memory is involved,
 * so these cases skip the fill.
 */
function edgeGrid() {
  const EDGE = [0, 1, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0xfffe, 0xffff];
  const out = [];
  for (const [w, d, s] of [[2, 'ax', 'bx'], [1, 'al', 'bl']]) {
    const vals = [...new Set(EDGE.map((v) => v & (w === 1 ? 0xff : 0xffff)))];
    for (const op of ['add', 'sub', 'cmp', 'and', 'or', 'xor', 'test']) {
      for (const a of vals) for (const b of vals) {
        out.push([`mov ax,${hex(a)}`, `mov bx,${hex(b)}`, `${op} ${d},${s}`].map((x) => ({ b: x, n: x })));
      }
    }
    for (const op of ['inc', 'dec', 'neg', 'not']) {
      for (const a of vals) for (const cf of ['clc', 'stc']) {
        out.push([`mov ax,${hex(a)}`, cf, `${op} ${d}`].map((x) => ({ b: x, n: x })));
      }
    }
  }
  return out;
}

function capture() {
  const dir = mkdtempSync(join(tmpdir(), 'borlandasm-'));
  const cases = [];
  const grid = edgeGrid();
  for (let k = 0; k < CASES + grid.length; k++) {
    const seed = k < CASES ? 0x5eed0000 + k * 7919 : 0;
    const lines = k < CASES ? snippet(seed) : grid[k - CASES];
    const src = join(dir, `c${k}.asm`), bin = join(dir, `c${k}.bin`);
    writeFileSync(src, nasmSource(lines));
    const a = spawnSync('nasm', ['-f', 'bin', src, '-o', bin], { encoding: 'utf8' });
    if (a.status !== 0) throw new Error(`nasm on case ${k}: ${a.stderr}\n${nasmSource(lines)}`);
    cases.push({ seed, lines, code: readFileSync(bin).toString('hex'), fill: k < CASES });
  }
  const r = spawnSync(PY, [join(ROOT, 'tools/oracle/unicorn-rm16.py')], {
    input: JSON.stringify({ layout: LAYOUT, cases: cases.map((c) => ({ code: c.code, seed: c.seed, fill: c.fill })) }),
    encoding: 'utf8', maxBuffer: 64 << 20,
  });
  if (r.status !== 0) throw new Error(`unicorn-rm16.py: ${r.stderr}`);
  const { results } = JSON.parse(r.stdout);
  const golden = {
    _doc: 'Unicorn 16-bit real mode, running nasm -f bin of the SAME snippets PRISM translates from Borland '
      + 'asm syntax. Captured by tools/gate-borlandasm.mjs --capture; replayed without Python or nasm.',
    layout: LAYOUT,
    cases: cases.map((c, i) => ({ seed: c.seed, fill: c.fill, lines: c.lines.map((l) => (l.label ? { label: l.label } : { b: l.b })), want: results[i] })),
  };
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  const errs = results.filter((x) => x.error).length;
  console.log(`captured ${cases.length} cases (${errs} that Unicorn could not finish) -> goldens/borland-asm.json`);
}

function replay() {
  if (!existsSync(GOLDEN)) { console.log('no goldens/borland-asm.json: run with --capture first'); process.exit(1); }
  const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const globals = ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'ax2', 'ds', 'es', 'cf', 'zf', 'sf'].map((r) => `unsigned g_${r};`).join('\n');
  // In batches: one C file of 1,300 functions is a single directive-free run of 250,000 tokens, which
  // PRISM's preprocessor takes for a runaway expansion (its bound is on the run, not on growth).
  const BATCH = 250;
  const builds = [];
  for (let from = 0; from < g.cases.length; from += BATCH) {
    const part = g.cases.slice(from, from + BATCH);
    const src = `${globals}\n${part.map((c, j) => cFunction(from + j, c.lines)).join('\n')}`;
    builds.push(compileProgram([{ file: 'cases.c', source: src }],
      { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model: 'dos16m' }));
  }
  let pass = 0, skipped = 0, firstBad = null;
  for (let k = 0; k < g.cases.length; k++) {
    const c = g.cases[k];
    const p = builds[Math.floor(k / BATCH)];
    const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
    const dv = p.mod.dv, u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const at = (n) => p.mod.symbols.get(n).addr;
    if (c.want.error) { skipped++; continue; }
    const why = [];
    if (failed.has(`c${k}`)) why.push(`refused: ${failed.get(`c${k}`)}`);
    else {
      for (const [a, n] of g.layout.fill) {
        if (c.fill) u8.set(fillBytes(c.seed, n), a); else u8.fill(0, a, a + n);
      }
      for (const r of ['cf', 'zf', 'sf']) dv.setUint16(at(`g_${r}`), 0, true);
      try { p.F[`c${k}`](); } catch (e) { why.push(`threw ${e.message}`); }
      if (!why.length) {
        const got = (r) => dv.getUint16(at(`g_${r}`), true);
        for (const r of ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'ds', 'es']) {
          if (got(r) !== c.want.regs[r]) why.push(`${r} ${hex(got(r))} want ${hex(c.want.regs[r])}`);
        }
        for (const f of ['cf', 'zf', 'sf']) if (got(f) !== c.want[f]) why.push(`${f} ${got(f)} want ${c.want[f]}`);
        const h = createHash('sha256');
        for (const [a, n] of g.layout.fill) h.update(u8.subarray(a, a + n));
        if (h.digest('hex') !== c.want.mem) why.push('memory differs');
      }
    }
    if (why.length) { if (!firstBad) firstBad = { k, why, lines: c.lines }; (globalThis.badList ??= []).push(`${k}:${why[0]}`); } else pass++;
  }
  const n = g.cases.length - skipped;
  report(pass === n, `A. Unicorn real mode: ${pass}/${n} cases agree`, skipped ? `(${skipped} Unicorn could not finish)` : '');
  if (process.env.ALLBAD && globalThis.badList) console.log(globalThis.badList.join('\n'));
  if (firstBad) {
    console.log(`       first disagreement, case ${firstBad.k}: ${firstBad.why.slice(0, 4).join('; ')}`);
    for (const l of firstBad.lines) console.log(`         ${l.label ? `${l.label}:` : l.b}`);
  }
}

// ------------------------------------------------------------------------------------------ part B
const PROBES = `#include <dos.h>
typedef enum { nothing, something } thing;
unsigned counter;
unsigned long big = 0x11223344UL;
unsigned table[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
char far farbuf[16];
unsigned char seen[4];

void SwapLong(long far *Var) {
  asm les bx,Var
  asm mov ax,[es:bx]
  asm xchg ah,al
  asm xchg ax,[es:bx+2]
  asm xchg ah,al
  asm mov [es:bx],ax
}
int b_swap(void) { SwapLong((long far *)&big); return big == 0x44332211UL; }

int b_names(void) {
  unsigned n = 8;
  asm xor si,si
  asm mov [counter],0
more:
  asm mov ax,[WORD PTR table+si]
  asm add [counter],ax
  asm add si,2
  asm dec [n]
  asm jnz more
  return counter == 36 && n == 0;
}

int b_param(unsigned a, unsigned char b) {
  asm mov ax,[a]
  asm add al,[b]
  asm mov [a],ax
  return a;
}

int b_enum_label(void) {
  asm xor ax,ax
  asm jz nothing
  return 1;
nothing:
  return something == 1 ? 0 : 2;
}

int b_view(void) {
  char far *p = (char far *)MK_FP(0x2345, 0x0007);
  unsigned s, o;
  asm mov ax,[WORD PTR p+2]
  asm mov [s],ax
  asm mov ax,[WORD PTR p]
  asm mov [o],ax
  asm add [WORD PTR p],3
  return s == FP_SEG(p) - 0 && o == 7 && p == (char far *)MK_FP(0x2345, 10);
}

int b_view_write(void) {
  char far *p = 0;
  asm mov [WORD PTR p+2],0x1000
  asm mov [WORD PTR p],0x25
  return p == (char far *)MK_FP(0x1000, 0x25) && FP_SEG(p) == 0x1002 && FP_OFF(p) == 5;
}

int b_les(void) {
  char far *p = (char far *)MK_FP(0x2000, 0x1234);
  unsigned s, o;
  asm les bx,p
  asm mov [o],bx
  asm mov [s],es
  return (unsigned long)s * 16 + o == 0x21234UL && o < 16;
}

int b_poison(void) {
  char far *p = (char far *)MK_FP(0x2000, 0x10);
  asm add [WORD PTR p],1
  asm jz out
  return 1;
out:
  return 2;
}

unsigned b_ret16(void) { asm mov ax,0xfffe }
int b_ret16s(void) { asm mov ax,0xfffe }
long b_ret32(void) { asm mov dx,0x1234 ; asm mov ax,0x5678 }
unsigned char b_ret8(void) { asm mov ax,0x1ff }

unsigned b_offset(void) { asm mov ax,OFFSET table }

int b_ports(void) {
  asm mov dx,0x3c4
  asm mov ax,0x0f02
  asm out dx,ax
  asm in al,0x61
  asm mov [BYTE PTR seen],al
  asm mov al,0x55
  asm out 0x61,al
  return seen[0];
}

int b_ds_local(void) {
  unsigned n = 0x4321, got;
  asm mov ax,0x3000
  asm mov ds,ax
  asm mov bx,[n]
  asm mov ax,ss
  asm mov ds,ax
  asm mov [got],bx
  return got;
}

int b_shift_wide(void) {
  asm mov cl,16
  asm mov ax,1
  asm shl ax,cl
  asm jc wide
  return 1;
wide:
  return 2;
}

unsigned char shiftt[8] = { 10, 11, 12, 13, 14, 15, 16, 17 };
unsigned tbl[4];
int b_bp(void) {
  tbl[2] = (unsigned)shiftt;
  asm push bp
  asm mov bp,2
  asm shl bp,1
  asm mov bp,[WORD PTR tbl+bp]
  asm mov si,3
  asm mov ax,0x2000
  asm mov ds,ax
  asm mov al,[BYTE PTR bp+si]
  asm mov bx,ss
  asm mov ds,bx
  asm pop bp
  asm xor ah,ah
}

int b_pushf_data(void) {
  asm pushf
  asm pop ax
  return 0;
}

int b_far_object(void) { asm mov al,[BYTE PTR farbuf] ; return 0; }
int b_int(void) {
  asm mov ax,0x4400
  asm mov bx,5
  asm int 21h
  asm jc failed
  asm mov [counter],dx
  return counter;
failed:
  return -1;
}
int b_genint(void) {
  _AH = 0x0f;
  geninterrupt(0x10);
  return _BH * 256 + _AL;
}
int b_bytes(void) {
  _AX = 0x1234;
  _AL = 0x99;
  _AH += 1;
  return _AX;
}
unsigned b_mask16(void) { _AX = 0x12345L; return _AX; }
int b_mask8(void) { _AX = 0x1234; _AL = 0x1ff; return _AX; }
int r_undef(void) { return _DI; }
int r_clobber(void) { _AX = 5; b_ret16(); return _AX; }
int r_call(void)  { asm call b_ret16 ; return 0; }
int r_bp(void)    { asm mov ax,[bp+4] ; return 0; }
int r_std(void)   { asm std ; return 0; }
int r_jl(void)    { asm jl here ; here: return 0; }
int r_label(void) { asm jz nowhere ; return 0; }
int r_nosize(void){ asm xor bx,bx ; asm mov [bx],0 ; return 0; }
`;

function partB() {
  let p;
  try {
    p = compileProgram([{ file: 'probes.c', source: PROBES }],
      { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model: 'dos16m' });
  } catch (e) { report(false, 'B. the probes compile', e.message.split('\n')[0]); return; }
  const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
  const call = (fn, ...a) => {
    if (failed.has(fn)) return `refused: ${failed.get(fn).slice(0, 70)}`;
    try { return p.F[fn](...a); } catch (e) { return `threw: ${e.message.slice(0, 80)}`; }
  };
  const eq = (fn, want, args = [], what = fn) => {
    const got = call(fn, ...args);
    report(got === want, `B. ${what}`, `${got}${got === want ? '' : ` (want ${want})`}`);
  };
  eq('b_swap', 1, [], 'les + xchg through a far pointer parameter');
  eq('b_names', 1, [], 'a static, a local, a loop to a C label');
  eq('b_param', 0x1234 + 0x10, [0x1234, 0x10], 'parameters, SS-relative');
  eq('b_enum_label', 0, [], 'jz to a label named like an enum constant');
  eq('b_view', 1, [], 'far pointer halves read, offset written');
  eq('b_view_write', 1, [], 'far pointer halves written');
  eq('b_les', 1, [], 'les of a far pointer, normalised');
  const pz = call('b_poison');
  report(typeof pz === 'string' && pz.includes('value is undefined'), 'B. a flag from far-pointer arithmetic is not read', String(pz).slice(0, 60));
  eq('b_ds_local', 0x4321, [], 'a local is SS-relative while DS is elsewhere');
  eq('b_bp', 13, [], 'memory through a loaded bp is SS-relative, even with DS moved');
  const sw = call('b_shift_wide');
  report(typeof sw === 'string' && sw.includes('value is undefined'), 'B. CF after a shift by the full width is not read', String(sw).slice(0, 60));
  eq('b_ret16', 0xfffe, [], 'unsigned returned in AX');
  eq('b_ret16s', -2, [], 'int returned in AX, sign-extended');
  eq('b_ret32', 0x12345678, [], 'long returned in DX:AX');
  eq('b_ret8', 0xff, [], 'unsigned char returned in AL');
  eq('b_offset', p.mod.symbols.get('table').addr, [], 'OFFSET is the DGROUP address');
  {
    const log = [];
    p.M.machine = {
      read: (port, size) => { log.push(`r${port.toString(16)}/${size}`); return 0xa5; },
      write: (port, size, v) => { log.push(`w${port.toString(16)}/${size}=${v.toString(16)}`); },
    };
    const got = call('b_ports');
    const want = 'w3c4/2=f02 r61/1 w61/1=55';
    report(got === 0xa5 && log.join(' ') === want, 'B. in/out through the machine seam', `${got} ${log.join(' ')}`);
    delete p.M.machine;
  }
  {
    const seen = [];
    p.M.interrupt = (n, r) => {
      seen.push(`${n.toString(16)}:${r.ax.toString(16)}/${r.bx}`);
      if (n === 0x21) { r.dx = 0x80; r.cf = 0; }
      if (n === 0x10) { r.ax = 0x0f03; r.bx = 0x0100; }
    };
    eq('b_int', 0x80, [], 'asm int 21h through the dispatcher, CF read back');
    eq('b_genint', 0x0103, [], 'geninterrupt with _AH, answer in _AL and _BH');
    report(seen.join(' ') === '21:4400/5 10:f00/0', 'B. the service saw the registers the program loaded', seen.join(' '));
    delete p.M.interrupt;
    const none = call('b_genint');
    report(typeof none === 'string' && none.includes('no interrupt dispatcher'), 'B. no dispatcher: throws by name', String(none).slice(0, 60));
  }
  eq('b_bytes', 0x1399, [], '_AL and _AH are the halves of _AX');
  eq('b_mask16', 0x2345, [], '_AX keeps 16 bits of what is stored in it');
  eq('b_mask8', 0x12ff, [], '_AL keeps 8 bits and leaves _AH alone');
  const pf = call('b_pushf_data');
  report(typeof pf === 'string' && pf.includes('pushf word'), 'B. a pushf word popped as data throws by name', String(pf).slice(0, 60));
  const named = {
    b_far_object: 'outside DGROUP', r_call: 'call', r_bp: 'reads bp before this function wrote it', r_std: 'std',
    r_jl: 'OF or PF', r_label: 'not a label', r_nosize: 'size nothing states',
    r_undef: 'reads di before this function wrote it', r_clobber: 'after the call to b_ret16()',
  };
  for (const [fn, want] of Object.entries(named)) {
    const m = failed.get(fn) ?? '';
    report((m.includes('Borland inline assembly') || m.includes('only Borland')) && m.includes(want), `B. ${fn} refused by name`, m ? m.replace('tier-0 does not support ', '').slice(0, 60) : 'emitted');
  }
  // Only where DGROUP is at linear 0.
  for (const model of ['i386', 'dos16l']) {
    const q = compileProgram([{ file: 'm.c', source: 'int f(void) { asm mov ax,1 ; return 0; }' }],
      { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model });
    const m = (q.failures ?? []).find((f) => f.fn === 'f')?.message ?? '';
    report(m.includes('outside a model with DGROUP at linear 0'), `B. ${model}: refused by name`, m.slice(0, 60) || 'emitted');
  }
}

if (CAPTURE) capture();
replay();
partB();
console.log(bad ? `\n${bad} WRONG` : '\nBorland inline assembly: the instructions agree with Unicorn, and the C around them holds.');
process.exit(bad ? 1 : 0);
