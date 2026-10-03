// gate-asm-snapvector.mjs — Quake III's unix/snapvector.nasm, translated by PRISM, against Unicorn.
//
// Sys_SnapVector is assembly on Linux i386 (the C one in unix_shared.c is compiled only for
// __APPLE__), and the game VMs call it every frame through trap_SnapVector: it rounds a vector's
// three floats to integers with the x87, after setting the control word to round-to-nearest-even
// (0x037F) and restoring the caller's afterwards. So the translation is held to the real routine:
// Unicorn runs the bytes nasm makes of the UNMODIFIED file, on vectors chosen to catch a rounding
// rule -- halves of both signs, the edges of int32, values too large to convert, NaN, infinities,
// negative zero, denormals, and plain random floats.
//
// Captured once (--capture, which needs nasm and a Python with unicorn) into goldens/, then replayed.
// Controls, which must be red: the rounding forced to truncation, and the control word ignored
// (the caller's own RC kept, here round-down, set before the call).
//
//   node tools/gate-asm-snapvector.mjs --capture --python=/path/to/python3
//   node tools/gate-asm-snapvector.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/asm/nasm.js';
import { translate } from '../src/asm/x86.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus', 'Quake-III-Arena-master', 'code', 'unix', 'snapvector.nasm');
const GOLDEN = join(ROOT, 'goldens', 'asm-snapvector.json');
const CAPTURE = process.argv.includes('--capture');
const PY = process.argv.find((a) => a.startsWith('--python='))?.slice(9) ?? process.env.PRISM_PYTHON;
if (!existsSync(SRC)) { console.log('SKIP: no corpus/Quake-III-Arena-master'); process.exit(77); }

const VEC = 0x100000, DATA = 0x600000, STACK_TOP = 0x00300000, DONE = 0x00200000;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s; }; }
const f32bits = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return b.getUint32(0, true); };
const SPECIAL = [0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 3.5, -3.5, 1e10, -1e10, 2147483520, -2147483648, 2147483648, NaN,
  Infinity, -Infinity, -0, 1.4e-45, -1.4e-45, 0.49999997, 16777215.5, -16777215, 8388608.5, 0.999999940, -0.999999940];
/** Each case: three float32 bit patterns. The first cases walk the special values; the rest are random. */
function makeCase(i) {
  const r = rng(0x5eed ^ i);
  const pick = () => {
    const k = r() % 4;
    if (k === 0) return f32bits(SPECIAL[r() % SPECIAL.length]);
    if (k === 1) return f32bits(((r() % 2000) - 1000) / 2);          // a half, often
    if (k === 2) return f32bits((((r() | 0) / 65536)));                // a plain float
    return r();                                                        // any bit pattern
  };
  return { i, bits: [pick(), pick(), pick()] };
}
const CASES = Array.from({ length: 300 }, (_, i) => makeCase(i));
const hex = (bits) => bits.map((b) => { const x = new DataView(new ArrayBuffer(4)); x.setUint32(0, b, true); return Buffer.from(x.buffer).toString('hex'); }).join('');

const parsed = parse(readFileSync(SRC, 'latin1'));

if (CAPTURE) {
  if (!PY) { console.error('--capture needs --python=<python with unicorn>'); process.exit(2); }
  const obj = join(ROOT, '.oracle', 'snapvector.o');
  mkdirSync(dirname(obj), { recursive: true });
  const asm = spawnSync('nasm', ['-f', 'elf32', SRC, '-o', obj], { encoding: 'utf8' });
  if (asm.status !== 0) { console.error(`nasm: ${asm.stderr}`); process.exit(1); }
  const out = [];
  for (const c of CASES) {
    const spec = { object: obj, entry: 'Sys_SnapVector', args: [VEC],
      memory: [{ addr: VEC, size: 0x1000, fill: 0 }], write: [{ addr: VEC, hex: hex(c.bits) }],
      dump: [{ addr: VEC, size: 12 }] };
    const r = spawnSync(PY, [join(ROOT, 'tools/oracle/unicorn-x86.py')], { input: JSON.stringify(spec), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`unicorn, case ${c.i}: ${r.stderr.slice(-400)}`);
    const o = JSON.parse(r.stdout);
    if (!o.finished) throw new Error(`case ${c.i} did not return: ${o.error}`);
    out.push({ i: c.i, vec: o.dump[String(VEC)], eax: o.regs.eax, ebp: o.regs.ebp, esp: o.regs.esp });
  }
  writeFileSync(GOLDEN, `${JSON.stringify({ _doc: ['Quake III unix/snapvector.nasm (unmodified) assembled by nasm and run by Unicorn on',
    `${CASES.length} vectors of float32 bit patterns (tools/gate-asm-snapvector.mjs makeCase). Replayed against PRISM's translation.`], cases: out })}\n`);
  console.log(`captured ${out.length} cases -> goldens/asm-snapvector.json`);
  process.exit(0);
}
if (!existsSync(GOLDEN)) { console.error('no goldens/asm-snapvector.json: run with --capture first'); process.exit(2); }
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).cases;

function run(src, c, callerCW = null) {
  const D = new DataView(new ArrayBuffer(8 << 20));
  new Uint8Array(D.buffer).set(Buffer.from(hex(c.bits), 'hex'), VEC);
  let esp = STACK_TOP;
  esp -= 4; D.setUint32(esp, VEC, true);
  esp -= 4; D.setUint32(esp, DONE, true);
  let js = src;
  if (callerCW !== null) js = js.replace('let _cw=0x037f;', `let _cw=${callerCW};`);
  const end = (0, eval)(js)(D, { eax: 0, ebx: 0, ecx: 0, edx: 0, esi: 0, edi: 0, ebp: 0, esp }, { out() {} });
  return { vec: Buffer.from(D.buffer, VEC, 12).toString('hex'), eax: end.eax >>> 0, ebp: end.ebp >>> 0, esp: end.esp >>> 0 };
}

let bad = 0;
const src = translate(parsed, 'Sys_SnapVector', { dataBase: DATA });
const differ = (s, cw) => golden.filter((g) => { const r = run(s, CASES[g.i], cw); return r.vec !== g.vec || r.esp !== g.esp >>> 0 || r.ebp !== g.ebp >>> 0 || r.eax !== g.eax >>> 0; });
const wrong = differ(src, null);
for (const g of wrong.slice(0, 8)) { const r = run(src, CASES[g.i]); console.log(`  ✗ case ${g.i}: prism ${r.vec} unicorn ${g.vec}`); }
if (wrong.length) bad++;
console.log(`${wrong.length ? ' BAD ' : '  ok '} Sys_SnapVector agrees with Unicorn: ${golden.length - wrong.length} of ${golden.length} vectors`);
// Control 1: round toward zero instead of the control word's rounding.
const trunc = differ(src.replace('const _rc=()=>(_cw>>10)&3;', 'const _rc=()=>3;'), null).length;
console.log(`${trunc ? '  ok ' : ' BAD '} control: rounding forced to truncation is told apart: ${trunc} vectors differ`); if (!trunc) bad++;
// Control 2: the routine's fldcw ignored -- the caller's control word (round down, 0x077F) stays in force.
const ignored = differ(src.replace(/_cw=D\.getUint16\([^;]*;/, ';'), 0x077f).length;
console.log(`${ignored ? '  ok ' : ' BAD '} control: the routine's own control word ignored is told apart: ${ignored} vectors differ`); if (!ignored) bad++;
console.log(bad ? `\n${bad} WRONG` : "\nPRISM's translation of snapvector.nasm rounds as the x87 does.");
process.exit(bad ? 1 : 0);
