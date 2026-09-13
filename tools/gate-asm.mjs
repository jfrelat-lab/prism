// gate-asm.mjs — PRISM's translation of the game's own assembly against Unicorn, instruction for
// instruction, over random inputs.
//
// P5 had no oracle until now. MIRAGE cannot be one here (it is real-mode; this is 32-bit flat) and
// a native i386 harness faults on the routine's privileged `out`. Unicorn runs the real bytes that
// nasm produces from the UNMODIFIED dos/gfx.S, and this compares PRISM's JavaScript against it.
//
// CAPTURE ONCE, REPLAY FOREVER -- the idea is MIRAGE's tools/uc-capture.py, and it is the reason
// this gate is worth having rather than merely possible: `--capture` runs Unicorn and writes the
// expected end states into goldens/, which is COMMITTED, so every later run needs neither Python
// nor Unicorn nor nasm. The same shape as goldens/mame05.json: born against a real reference, then
// cheap to replay on any machine.
//
//   node tools/gate-asm.mjs --capture     assemble, run Unicorn, record the expectations
//   node tools/gate-asm.mjs               replay them against the translation
//
// Cases are random register and memory states rather than hand-picked ones, for the reason csmith
// exists: the interesting failures are the ones nobody thought to write down.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from '../src/asm/nasm.js';
import { translate } from '../src/asm/x86.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus/jumpnbump-dos/dos/gfx.S');
const GOLDEN = join(ROOT, 'goldens', 'asm-x86.json');
const CAPTURE = process.argv.includes('--capture');
const PY = process.argv.find(a => a.startsWith('--python='))?.slice(9);

// The same layout on both sides. Only the OBSERVABLE parts are compared -- the window, the buffer
// and the registers -- because the routine's private data slots live at different addresses in a
// linked object than in a translation that simply asks for some memory.
const VGA = 0xa0000, VGA_LEN = 0x20000;
const BUF = 0x100000, BUF_LEN = 0x1000;
const BASEVAR = 0x500000;
const DATA = 0x600000;                      // where the translation keeps the routine's `dd` slots
const STACK_TOP = 0x00300000, DONE = 0x00200000;

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A small deterministic generator, so a failing case can be reproduced from its seed alone. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s; };
}

/** One case: a page, a rectangle, and a window filled with a pattern the routine must carry over. */
function makeCase(i) {
  const r = rng(0x9e3779b9 ^ i);
  const page = r() % 4;
  const x = (r() % 420) - 10;               // deliberately out of range sometimes: the clipping
  const y = (r() % 270) - 10;               // paths at the top of both routines are the subtle half
  const width = 1 + (r() % 24);
  const height = 1 + (r() % 12);
  const fill = [];
  for (let k = 0; k < 64; k++) fill.push(r() & 0xff);
  return { i, page, x, y, width, height, fill };
}

const CASES = Array.from({ length: 200 }, (_, i) => makeCase(i));

function windowBytes(c) {
  // A repeating pattern, so a byte's value tells you where it came from.
  const b = new Uint8Array(VGA_LEN);
  for (let k = 0; k < b.length; k++) b[k] = c.fill[k % c.fill.length] ^ (k & 0xff);
  return b;
}

/* ---------------------------------------------------------------- the reference, once */

function capture(routine, obj, python) {
  const out = [];
  for (const c of CASES) {
    const win = windowBytes(c);
    const spec = {
      object: obj, entry: routine, symbols: { ___djgpp_base_address: BASEVAR },
      args: [c.page, c.x, c.y, c.width, c.height, BUF],
      memory: [{ addr: VGA, size: VGA_LEN, fill: 0 }, { addr: BUF, size: BUF_LEN, fill: 0 },
               { addr: BASEVAR, size: 0x1000, fill: 0 }],
      write: [{ addr: VGA, hex: Buffer.from(win).toString('hex') }],
      /*
       * THE WHOLE REGION, hashed, not its first few hundred bytes. put_block writes at an offset
       * computed from `y`, so a 256-byte window at the start would usually see nothing on either
       * side and compare equal -- a green that means nothing. This was a real hole in the first
       * version of this gate, found by asking what it could not fail on rather than by a red run.
       */
      dump: [{ addr: BUF, size: BUF_LEN, hash: true }, { addr: VGA, size: VGA_LEN, hash: true }],
    };
    const r = spawnSync(python, [join(ROOT, 'tools/oracle/unicorn-x86.py')],
      { input: JSON.stringify(spec), encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`unicorn failed on case ${c.i}: ${r.stderr?.slice(-400)}`);
    const o = JSON.parse(r.stdout);
    if (!o.finished) throw new Error(`case ${c.i} did not return: ${o.error}`);
    out.push({ i: c.i, regs: o.regs, ports: o.ports, dump: o.dump });
  }
  return out;
}

/* ---------------------------------------------------------------- the translation, every time */

function runTranslation(routineSrc, c, routine) {
  const image = new ArrayBuffer(8 << 20);
  const D = new DataView(image);
  const u8 = new Uint8Array(image);
  u8.set(windowBytes(c), VGA);
  D.setUint32(BASEVAR, 0, true);

  // The same stack the reference is given: arguments right to left, then the return address.
  let esp = STACK_TOP;
  for (const a of [c.page, c.x, c.y, c.width, c.height, BUF].reverse()) {
    esp -= 4; D.setUint32(esp, a >>> 0, true);
  }
  esp -= 4; D.setUint32(esp, DONE, true);

  const ports = [];
  const fn = (0, eval)(routineSrc);
  const regs = { eax: 0, ebx: 0, ecx: 0, edx: 0, esi: 0, edi: 0, ebp: 0, esp };
  const end = fn(D, regs, { out: (port, size, value) => ports.push({ port, size, value }) });
  return {
    regs: end,
    ports,
    dump: { [BUF]: sha(u8.subarray(BUF, BUF + BUF_LEN)),
            [VGA]: sha(u8.subarray(VGA, VGA + VGA_LEN)) },
  };
}

/* ---------------------------------------------------------------- */

const parsed = parse(readFileSync(SRC, 'latin1'));
const ROUTINES = ['_get_block', '_put_block'];

if (CAPTURE) {
  const python = PY ?? process.env.PRISM_PYTHON;
  if (!python) {
    console.error('--capture needs a Python with unicorn installed: --python=/path/to/venv/bin/python');
    process.exit(2);
  }
  const obj = join(ROOT, '.oracle', 'gfx.o');
  mkdirSync(dirname(obj), { recursive: true });
  const asm = spawnSync('nasm', ['-f', 'elf32', '-w-label-orphan', SRC, '-o', obj], { encoding: 'utf8' });
  if (asm.status !== 0) { console.error(`nasm: ${asm.stderr}`); process.exit(1); }
  const golden = { _doc: [
    'PRISM translating Jump n Bump\'s own dos/gfx.S, checked against Unicorn running the bytes',
    'nasm produces from the SAME unmodified file. Captured once with --capture; committed so the',
    'gate replays with neither Python, Unicorn nor nasm installed -- the pattern MIRAGE uses for',
    'its own x86 differential, and the same bargain as goldens/mame05.json.',
  ], cases: CASES.length, routines: {} };
  for (const routine of ROUTINES) golden.routines[routine] = capture(routine, obj, python);
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  console.log(`captured ${CASES.length} cases for ${ROUTINES.join(' and ')} -> ${GOLDEN.replace(`${ROOT}/`, '')}`);
  process.exit(0);
}

if (!existsSync(GOLDEN)) {
  console.error(`no expectations at ${GOLDEN.replace(`${ROOT}/`, '')} — record them with --capture first`);
  process.exit(2);
}
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));

let bad = 0, ok = 0;
const problems = [];
for (const routine of ROUTINES) {
  let src;
  try {
    src = translate(parsed, routine, { symbols: { ___djgpp_base_address: BASEVAR }, dataBase: DATA });
  } catch (e) {
    problems.push(`${routine}: the translator refused it — ${e.message}`);
    bad += golden.routines[routine].length;
    continue;
  }
  for (const want of golden.routines[routine]) {
    const c = CASES[want.i];
    let got;
    try { got = runTranslation(src, c, routine); }
    catch (e) { problems.push(`${routine} case ${c.i}: threw — ${e.message}`); bad++; continue; }

    const why = [];
    for (const r of ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp']) {
      if ((got.regs[r] >>> 0) !== (want.regs[r] >>> 0)) {
        why.push(`${r} ${(got.regs[r] >>> 0).toString(16)} ≠ ${(want.regs[r] >>> 0).toString(16)}`);
      }
    }
    for (const addr of [BUF, VGA]) {
      if (got.dump[addr] !== want.dump[String(addr)]) why.push(`memory at 0x${addr.toString(16)}`);
    }
    const gp = got.ports.map(p => `${p.port}:${p.value}`).join(',');
    const wp = want.ports.map(p => `${p.port}:${p.value}`).join(',');
    if (gp !== wp) why.push(`ports [${gp}] ≠ [${wp}]`);

    if (why.length) { bad++; if (problems.length < 12) problems.push(`${routine} case ${c.i}: ${why.join('; ')}`); }
    else ok++;
  }
}

console.log(problems.length ? problems.map(p => `  ✗ ${p}`).join('\n') : '');
console.log(bad
  ? `\ngate-asm: ${ok} agree, ${bad} DIFFER from Unicorn`
  : `\nthe translation of the game's own assembly agrees with Unicorn: ${ok}/${ok}`);
process.exit(bad ? 1 : 0);
