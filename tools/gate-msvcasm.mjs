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
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';
import { makeX86 } from '../src/asm/msvc-rt.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'msvc-asm.json');
const CAPTURE = process.argv.includes('--capture');
const PY = process.argv.find((a) => a.startsWith('--python='))?.slice(9) ?? process.env.PRISM_PYTHON ?? 'python3';
const CASES = 600;

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
  jl: 'so', jge: 'so', jle: 'zso', jg: 'zso' };

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
    const kind = r.int(100);
    const size = r.pick([4, 4, 2, 1]);
    const mm = () => reg(`mm${r.int(8)}`);
    if (kind < 16) {
      const op = r.pick(['add', 'sub', 'cmp', 'and', 'or', 'xor', 'test', 'adc']);
      const shape = r.int(5);
      const d = shape === 3 || shape === 4 ? mem(dataDisp(size), size) : reg(pickReg(size));
      const s = shape === 0 || shape === 4 ? imm(r.val(MASKW[size])) : shape === 2 ? mem(dataDisp(size), size) : reg(pickReg(size));
      if (op === 'adc' && undef.has('c')) continue;
      set(L(op, d, s), 'czso');
    } else if (kind < 22) {
      const op = r.pick(['inc', 'dec', 'neg', 'not']);
      const d = r.int(3) ? reg(pickReg(size)) : mem(dataDisp(size), size);
      set(L(op, d), op === 'not' ? '' : op === 'neg' ? 'czso' : 'zso');
    } else if (kind < 30) {
      const op = r.pick(['shl', 'shr', 'sar']);
      const bits = size * 8;
      const n = 1 + r.int(bits - 1);
      const d = r.int(3) ? reg(pickReg(size, ['cl', 'cx', 'ecx'])) : mem(dataDisp(size), size);
      if (r.int(3)) set(L(op, d, imm(n)), 'czs', n === 1 ? '' : 'o');
      else { out.push(L('mov', reg('cl'), imm(n))); set(L(op, d, reg('cl')), 'czs', n === 1 ? '' : 'o'); }
      if (n === 1) define('o');
    } else if (kind < 36) {
      const shape = r.int(3);
      const d = reg(pickReg(4));
      if (shape === 0) set(L('imul', d, r.int(2) ? reg(pickReg(4)) : mem(dataDisp(4), 4)), 'co', 'zs');
      else if (shape === 1) set(L('imul', d, reg(pickReg(4)), imm(r.val(0xffff) << 16 >> 16)), 'co', 'zs');
      else set(L('imul', r.int(2) ? reg(pickReg(4, ['eax', 'edx'])) : mem(dataDisp(4), 4)), 'co', 'zs');
    } else if (kind < 46) {
      const shape = r.int(6);
      if (shape === 0) out.push(L('mov', reg(pickReg(size)), mem(dataDisp(size), size, false)));
      else if (shape === 1) out.push(L('mov', mem(dataDisp(size), size, false), reg(pickReg(size))));
      else if (shape === 2) out.push(L(r.pick(['movzx', 'movsx']), reg(pickReg(4)), r.int(2) ? reg(pickReg(r.pick([1, 2]))) : mem(dataDisp(2), r.pick([1, 2]))));
      else if (shape === 3) { const sc = r.pick([1, 2, 4, 8]), disp = hex(r.u32()); out.push(L('lea', reg(pickReg(4)), { m: `[edi+esi*${sc}+${disp}]`, n: `[edi+esi*${sc}+${disp}]` })); }
      else if (shape === 4) { out.push(L('xchg', reg(pickReg(size)), r.int(2) ? reg(pickReg(size)) : mem(dataDisp(size), size, false))); }
      else {
        // A scaled index the snippet bounds first.
        set(L('and', reg('ecx'), imm(0x3f)), 'czso');
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

/** Stores the results, on both sides: the five general registers, then the eight MMX ones. */
const SAVE = [...R[4].map((name, k) => L('mov', mem(OUT + 4 * k, 4, false), reg(name))),
  ...Array.from({ length: 8 }, (_, k) => L('movq', mem(OUT + 0x20 + 8 * k, 8, false), reg(`mm${k}`)))];

function nasmSource(lines) {
  return ['bits 32', `mov ebx,${hex(LAYOUT.buf)}`, ...[...lines, ...SAVE].map((l) => (l.label ? `${l.label}:` : l.n))].join('\n') + '\n';
}

/** The C function PRISM runs for a case: the snippet, the stores, then the flags into globals. */
function cFunction(k, lines) {
  const body = ['lea ebx,g_mem', ...[...lines, ...SAVE].map((l) => (l.label ? `${l.label}_${k}:` : l.m.replace(/\b(L\d+)\b/, `$1_${k}`)))];
  const flags = [['jnc', 'cf'], ['jnz', 'zf'], ['jns', 'sf'], ['jno', 'of']]
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

function capture() {
  const dir = mkdtempSync(join(tmpdir(), 'msvcasm-'));
  const cases = [];
  const grid = edgeGrid();
  for (let k = 0; k < CASES + grid.length; k++) {
    const seed = k < CASES ? 0x3a5e0000 + k * 7919 : 0;
    const { lines, skip } = k < CASES ? snippet(seed) : grid[k - CASES];
    const src = join(dir, `c${k}.asm`), bin = join(dir, `c${k}.bin`);
    writeFileSync(src, nasmSource(lines));
    const a = spawnSync('nasm', ['-f', 'bin', src, '-o', bin], { encoding: 'utf8' });
    if (a.status !== 0) throw new Error(`nasm on case ${k}: ${a.stderr}\n${nasmSource(lines)}`);
    cases.push({ seed, lines, skip, code: readFileSync(bin).toString('hex'), fill: k < CASES });
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
    cases: cases.map((c, i) => ({ seed: c.seed, fill: c.fill, skip: c.skip, lines: c.lines.map((l) => (l.label ? { label: l.label } : { m: l.m })),
      // Only the stored registers are kept for diagnosis: five general ones and eight MMX ones.
      want: results[i].error ? results[i] : { ...results[i], out: results[i].out.slice(0, 0x60 * 2) } })),
  };
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  const errs = results.filter((x) => x.error).length;
  console.log(`captured ${cases.length} cases (${errs} that Unicorn could not finish) -> goldens/msvc-asm.json`);
}

/** Build every case once; `check(builds, x86)` then runs them all against one MMX runtime. */
function buildAll(g) {
  const globals = ['unsigned char g_mem[4096];', ...['cf', 'zf', 'sf', 'of'].map((f) => `unsigned g_${f};`)].join('\n');
  const BATCH = 250, builds = [];
  for (let from = 0; from < g.cases.length; from += BATCH) {
    const part = g.cases.slice(from, from + BATCH);
    const src = `${globals}\n${part.map((c, j) => cFunction(from + j, c.lines)).join('\n')}`;
    builds.push(compileProgram([{ file: 'cases.c', source: src }], { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true }));
  }
  return builds;
}

function check(g, builds, x86 = null) {
  let pass = 0, skipped = 0, firstBad = null;
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
      for (const f of ['cf', 'zf', 'sf', 'of']) dv.setUint32(at(`g_${f}`), 0, true);
      try { p.F[`c${k}`](); } catch (e) { why.push(`threw ${e.message}`); }
      if (!why.length) {
        for (const f of ['cf', 'zf', 'sf', 'of']) {
          if (c.skip.includes(f[0])) continue;
          const got = dv.getUint32(at(`g_${f}`), true);
          if (got !== c.want[f]) why.push(`${f} ${got} want ${c.want[f]}`);
        }
        const mine = u8.subarray(buf, buf + g.layout.size);
        if (createHash('sha256').update(mine).digest('hex') !== c.want.mem) {
          const got = Buffer.from(mine.subarray(g.layout.out)).toString('hex');
          const names = [...R[4], ...Array.from({ length: 8 }, (_, i) => `mm${i}`)];
          const diffs = names.map((n, i) => {
            const [o, len] = i < 5 ? [4 * i, 4] : [0x20 + 8 * (i - 5), 8];
            const a = got.slice(o * 2, (o + len) * 2), b = c.want.out.slice(o * 2, (o + len) * 2);
            return a === b ? null : `${n} ${a} want ${b}`;
          }).filter(Boolean);
          why.push(diffs.length ? diffs.join('; ') : 'data memory differs');
        }
      }
    }
    if (why.length) { if (!firstBad) firstBad = { k, why, lines: c.lines }; if (process.env.ALLBAD && !x86) console.log(`  case ${k}: ${why.join('; ')}`); } else pass++;
  }
  return { pass, n: g.cases.length - skipped, skipped, firstBad };
}

function replay() {
  if (!existsSync(GOLDEN)) { console.log('no goldens/msvc-asm.json: run with --capture first'); process.exit(1); }
  const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const builds = buildAll(g);
  const { pass, n, skipped, firstBad } = check(g, builds);
  report(pass === n, `A. Unicorn 32-bit: ${pass}/${n} cases agree`, skipped ? `(${skipped} Unicorn could not finish)` : '');
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
  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    const X = makeX86(); mutate(X);
    const m = check(g, builds, X);
    report(m.pass < m.n, `   mutation '${name}' is caught`, `${m.n - m.pass} cases red`);
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
int x_method(void) { K k; k.v = 21; return k.get(); }
`;

const REFUSE = [
  ['esp', 'int f(void) { __asm { mov eax, esp } }', /esp/],
  ['ebp', 'int f(void) { __asm { mov eax, [ebp+8] } }', /ebp/],
  ['call', 'void g(void); void f(void) { __asm { call g } }', /call/],
  ['int', 'void f(void) { __asm { int 3 } }', /int/],
  ['the x87', 'float x; void f(void) { __asm { fld x } }', /x87/],
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
