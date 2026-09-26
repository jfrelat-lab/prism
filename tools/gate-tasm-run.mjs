// gate-tasm-run.mjs — Keen Dreams' assembly routines, translated (src/asm/tasm16.js) and EXECUTED,
// against TASM's own object code executed by Unicorn.
//
// Each case is one call of one public routine from a stated machine: memory filled from a seed, the
// externals the routine reads set up as the game sets them (segments that point somewhere sensible,
// tables that end), the C arguments pushed with a far return address under them. Both sides start
// from byte-identical memory -- which is itself checked, because it is what says PRISM's loader
// places the module and resolves its addresses as TASM and a linker do -- and must end with the same
// registers, the same flags, the same memory (4 KB page by page, all 1,088 KB) and the same sequence
// of port writes. Ports and interrupts answer by one rule on both sides (unicorn-tasm.py).
//
// CAPTURE ONCE, REPLAY FOREVER: `--capture` needs DOSBox-X with Borland C++ 2.0 (TASM 2.5) and a
// Python with unicorn; it writes goldens/tasm-run.json, which carries the linked segments too, so a
// replay needs neither.
//
//   node tools/gate-tasm-run.mjs --capture [--bc=~/Projects/borland/BC20] [--python=python3]
//   node tools/gate-tasm-run.mjs [--only=VW_Plot]
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assembleTasm } from '../src/asm/tasm.js';
import { layoutTasm, translateTasm, loadTasm } from '../src/asm/tasm16.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPUS = join(ROOT, 'corpus', 'KeenDreams');
const GOLDEN = join(ROOT, 'goldens', 'tasm-run.json');
const CAPTURE = process.argv.includes('--capture');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const PY = process.argv.find((a) => a.startsWith('--python='))?.slice(9) ?? process.env.PRISM_PYTHON ?? 'python3';

// One placement for every case. DGROUP at 1000h with the module's _DATA at 100h in it and each
// external its room from 2000h (arrays by their real extent); the update matrices at E000h and E200h;
// the code segment at 3000h; the stack at the top of DGROUP; far data from 4000h; the return address
// F000:0000.
const G = 0x1000, CSP = 0x3000, DATA_BASE = 0x100, EXT_BASE = 0x2000;
const EXT_SPAN = { grsegs: 0x1800, tilecache: 0xc00, blockstarts: 0x400, updatemapofs: 0x400, ylookup: 0x400 };
const UPDATE = [0xe000, 0xe200], STRING = 0xe800;
const STOP_CS = 0xf000, STOP = STOP_CS << 4;
const MEM = 0x110000, PAGE = 4096;
const FILES = ['id_us_a.asm', 'id_rf_a.asm', 'id_vw_a.asm', 'flags.asm'];

/*
 * B. THE FLAGS, which Keen's routines mostly never read back: ADD's carry, INC keeping CF, RCL's
 * carry, SAR's sign all went unobserved by part A. flags.asm is generated here -- one procedure per
 * operation form, 8- and 16-bit, by 1 and by CL -- and ends each with PUSHF/POP DI, so the whole
 * flags word is a register. TASM assembles it like the others.
 */
const FLAG_FORMS = [
  ...['add', 'adc', 'sub', 'sbb', 'cmp', 'and', 'or', 'xor', 'test'].flatMap((op) => [`${op} ax,bx`, `${op} al,bl`, `${op} ah,bh`]),
  ...['inc', 'dec', 'neg', 'not'].flatMap((op) => [`${op} ax`, `${op} al`]),
  ...['shl', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr'].flatMap((op) => [`${op} ax,1`, `${op} ax,cl`, `${op} al,1`, `${op} al,cl`]),
  'stc', 'clc', 'cmc', 'cli', 'sti',
  // A code-segment variable named without an override, under ASSUME DS:DGROUP: TASM reaches it
  // through the CS: prefix it adds itself. Keen's own modules never do this with DS not CS.
  'mov dx,[cvar]', 'add [cvar],bx',
];
const FLAGS_SOURCE = ['IDEAL', 'MODEL MEDIUM,C', 'DATASEG', 'CODESEG', 'cvar dw 1234h',
  ...FLAG_FORMS.flatMap((f, k) => [`PROC F${k}`, `PUBLIC F${k}`, `\t${f}`, '\tpushf', '\tpop di', '\tret', 'ENDP']), 'END', ''].join('\r\n');

// ---------------------------------------------------------------- the shared rules
function fillBytes(seed, n, mod, keep) {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  if (mod) {
    // Words below `keep`, from a draw modulo `mod`: tile numbers, zero where the draw is past keep.
    for (let i = 0; i + 1 < n; i += 2) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      let v = (s >>> 8) % mod;
      if (v >= keep) v = 0;
      out[i] = v & 255; out[i + 1] = v >>> 8;
    }
    return out;
  }
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = s >>> 24; }
  return out;
}
function portIn(seed, k, port) {
  const s = (seed + Math.imul(k, 0x9E3779B1) + Math.imul(port, 0x85EBCA77)) >>> 0;
  return (Math.imul(s, 1103515245) + 12345) >>> 16 & 0xffff;
}
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const pageHash = (mem, p) => createHash('sha1').update(mem.subarray(p * PAGE, (p + 1) * PAGE)).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- modules
const names = readdirSync(CORPUS);
const read = (name) => {
  if (String(name).toLowerCase() === 'flags.asm') return FLAGS_SOURCE;
  const f = names.find((x) => x.toLowerCase() === String(name).toLowerCase());
  return f ? readFileSync(join(CORPUS, f), 'latin1') : null;
};
const modules = new Map(FILES.map((f) => {
  const mod = assembleTasm(f, { read });
  const lay = layoutTasm(mod);
  const externs = [...mod.externs.keys()];
  let at = EXT_BASE;
  const extAddr = new Map(externs.map((e) => { const a = at; at += EXT_SPAN[e] ?? 0x100; return [e, a]; }));
  const symbol = (n) => extAddr.get(n);
  return [f, { file: f, mod, lay, externs, extAddr, symbol }];
}));

/** The linear address of an external, and of a module's own data label. */
const ext = (m, name) => (G << 4) + m.extAddr.get(name);
const dataAddr = (m, name) => (G << 4) + DATA_BASE + m.mod.data.labels.get(name).offset;

// ---------------------------------------------------------------- cases
//
// A case: { module, proc, name, args: [words], regs: {...}, fill: [[linear, size, seed]], image:
// [[linear, Uint8Array]], inSeed, intXor: [ax, bx] }. The routine is entered with SS:SP pointing at
// a far return address to F000:0000 with the C arguments above it, as Borland's caller leaves them.
const words = (...v) => Uint8Array.from(v.flatMap((x) => [x & 255, (x >>> 8) & 255]));
const rng = (seed) => { let s = seed >>> 0; return (n) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 8) % n; }; };

const eq = (m, name) => {
  const v = m.mod.equates.get(name.toLowerCase());
  if (v === undefined) throw new Error(`no equate ${name}`);
  return v;
};

/**
 * The game's world as the routines expect to find it: EGA memory at A000h, a screen 64 bytes wide,
 * ylookup and blockstarts computed as ID_VW.C and ID_RF.C compute them, map planes holding tile
 * numbers the graphics can index, update matrices ending in their terminators, a font whose
 * characters are 1 to 24 pixels wide (width 0 indexes shiftdrawtable's 0, a jump to offset 0).
 */
function world(m, seed) {
  const r = rng(seed);
  const image = [];
  const set = (name, ...vals) => { if (m.extAddr.has(name)) image.push([ext(m, name), words(...vals)]); };
  const W = 22, H = 14, SW = 64;
  set('screenseg', 0xa000);
  set('linewidth', SW);
  set('bufferofs', r(8) * 0x100);
  set('masterofs', 0x8000);
  set('displayofs', 0x4000 + r(8) * 0x100);
  set('panadjust', r(8));
  set('drawofs', 0);
  set('fontspace', 0);
  set('screenstart', 0, 0x4000, 0x8000);
  set('ylookup', ...Array.from({ length: 256 }, (_, y) => y * SW));
  set('blockstarts', ...Array.from({ length: W * H }, (_, i) => SW * 16 * Math.floor(i / W) + (i % W) * 2));
  set('updatemapofs', ...Array.from({ length: W * H }, (_, i) => (Math.floor(i / W) * 64 + (i % W)) * 2));
  set('originmap', r(0x3000) & ~1);
  set('mapsegs', 0x4000, 0x5000, 0x5800);
  set('tinf', 0x6000);
  set('tilecache', ...Array.from({ length: 1440 }, () => (r(2) ? r(0x10000) : 0)));
  set('grsegs', ...Array.from({ length: 3016 }, (_, k) => (k === eq(m, 'STARTFONT') ? 0x6800 : 0x7000 + ((k * 0x13) & 0x2ff) * 0x10)));
  const page = r(2);
  set('updatestart', 0xe000, 0xe200);
  set('updateptr', 0xe000 + page * 0x200);
  const matrix = Array.from({ length: W * H + 2 }, (_, i) => (i % W === W - 1 ? 0 : [0, 0, 1, 1, 3][r(5)]));
  matrix[W * H] = 1; matrix[W * H + 1] = 3;                   // UPDATETERMINATE
  image.push([(G << 4) + UPDATE[page], Uint8Array.from(matrix)]);
  // The font: height, 256 character offsets, 256 widths, and each character's rows.
  const h = 1 + r(16);
  const font = new Uint8Array(0x400);
  new DataView(font.buffer).setUint16(0, h, true);
  for (let c = 0; c < 256; c++) {
    new DataView(font.buffer).setUint16(2 + 2 * c, 0x400 + c * 64, true);
    font[514 + c] = 1 + r(24);
  }
  image.push([0x68000, font]);
  const fill = [
    [G << 4, 0x10000, seed],
    [0x40000, 0x70000, seed + 1],
    [0x40000, 0x8000, seed + 2, 1440, 1440],                  // background plane: tile numbers
    [0x50000, 0x8000, seed + 3, 2412, 1206],                  // foreground plane: half empty
  ];
  return { image, fill, r };
}

function cases() {
  const out = [];
  const add = (m, proc, name, args, w, extra = {}) => out.push({ ...extra, m, proc, name, args, fill: w.fill, image: [...w.image, ...(extra.image ?? [])] });
  const rf = modules.get('id_rf_a.asm');
  for (let k = 0; k < 12; k++) {
    const w = world(rf, 1000 + k);
    add(rf, 'RFL_NewTile', `#${k}`, [w.r(22 * 14 - 1)], w);
  }
  for (let k = 0; k < 8; k++) add(rf, 'RFL_UpdateTiles', `#${k}`, [], world(rf, 1100 + k));
  for (let k = 0; k < 8; k++) add(rf, 'RFL_MaskForegroundTiles', `#${k}`, [], world(rf, 1200 + k));
  const vw = modules.get('id_vw_a.asm');
  for (let k = 0; k < 4; k++) add(vw, 'VW_WaitVBL', `#${k}`, [1 + k], world(vw, 2000 + k), { inSeed: 11 + k });
  for (let k = 0; k < 8; k++) { const w = world(vw, 2100 + k); add(vw, 'VW_Plot', `#${k}`, [w.r(512), w.r(200), w.r(16)], w); }
  for (let k = 0; k < 8; k++) {
    const w = world(vw, 2200 + k);
    const yl = w.r(200);
    add(vw, 'VW_Vlin', `#${k}`, [yl, yl + w.r(200 - yl), w.r(512), w.r(16)], w);
  }
  for (let k = 0; k < 8; k++) { const w = world(vw, 2300 + k); add(vw, 'VW_DrawTile8', `#${k}`, [w.r(63), w.r(192), w.r(72)], w); }
  // Every unwound width (0-10) at an even and an odd destination -- 22 routines -- then the general one.
  for (let k = 0; k < 26; k++) {
    const w = world(vw, 2400 + k);
    const wide = k < 22 ? k >> 1 : 11 + w.r(8), height = 1 + w.r(24);
    add(vw, 'VW_MaskBlock', `wide=${wide}#${k}`, [0x7000 + w.r(0x2000), w.r(0x800), (w.r(0x3000) & ~1) + (k & 1), wide, height, wide * height], w);
  }
  for (let k = 0; k < 6; k++) { const w = world(vw, 2500 + k); add(vw, 'VW_ScreenToScreen', `#${k}`, [w.r(0x8000), w.r(0x8000), 1 + w.r(20), 1 + w.r(30)], w); }
  for (let k = 0; k < 8; k++) {
    const w = world(vw, 2600 + k);
    add(vw, 'VW_MemToScreen', `parity=${k & 3}#${k}`, [0x7000 + w.r(0x2000), (w.r(0x3000) & ~1) + (k & 1), 2 + (w.r(10) * 2) + ((k >> 1) & 1), 1 + w.r(24)], w);
  }
  for (let k = 0; k < 4; k++) { const w = world(vw, 2700 + k); add(vw, 'VW_ScreenToMem', `#${k}`, [w.r(0x8000), 0x7000 + w.r(0x2000), 1 + w.r(20), 1 + w.r(24)], w); }
  for (let k = 0; k < 6; k++) add(vw, 'VWL_UpdateScreenBlocks', `#${k}`, [], world(vw, 2800 + k));
  for (let k = 0; k < 4; k++) { const w = world(vw, 2900 + k); add(vw, 'VW_SetScreen', `#${k}`, [w.r(0x10000), w.r(8)], w, { inSeed: 21 + k }); }
  for (let k = 0; k < 8; k++) {
    const w = world(vw, 3000 + k);
    const n = k < 2 ? 0 : 1 + w.r(10);          // an empty string at a byte boundary draws nothing
    const str = Uint8Array.from([...Array.from({ length: n }, () => 1 + w.r(255)), 0]);
    const extra = [[(G << 4) + STRING, str], [dataAddr(vw, 'px'), words(n ? w.r(300) : 8 * w.r(30))], [dataAddr(vw, 'py'), words(w.r(180))]];
    add(vw, 'VW_DrawPropString', `${n} chars#${k}`, [STRING, G], w, { image: extra });
  }
  // Adapter detection turns on what INT 10h and the ports answer: echo makes a port read back the
  // last value written to it, which is how a 6845 is recognised.
  for (let k = 0; k < 48; k++) {
    const w = world(vw, 3100 + k);
    const intXor = k < 20 ? [[0, 0x1a, 0x1a1a, 0x12, 0x0f07][k % 5], [0, 8, 0x0304, 0x10, 0x0b, 0x01][k % 6]]
      : [[0x1a, 0x1a1a, 0x001d, 0x1a07][w.r(4)], w.r(0x100) | (w.r(2) << 8)];
    add(vw, 'VW_VideoID', `#${k}`, [], w, { inSeed: 31 + k, echo: k >= 4 && (k & 1) === 0, intXor });
  }
  const us = modules.get('id_us_a.asm');
  // B: every flag form from edge values, with random incoming flags (CF matters to ADC, SBB, RCL, RCR, CMC).
  const fl = modules.get('flags.asm');
  const EDGE = [0, 1, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0x8001, 0xffff, 0x0f0f, 0xf00f];
  const COUNTS = [0, 1, 2, 7, 8, 9, 15, 16, 17, 31, 32, 255];
  FLAG_FORMS.forEach((form, k) => {
    const r = rng(5000 + k);
    for (let j = 0; j < 12; j++) {
      const pick = () => (r(3) ? EDGE[r(EDGE.length)] : r(0x10000));
      out.push({ m: fl, proc: `F${k}`, name: `${form} #${j}`, args: [], fill: [],
        regs: { ax: pick(), bx: pick(), cx: COUNTS[j], ds: 0x4000 + r(0x1000), flags: 0x202 | (r(0x10000) & 0x8d5) } });
    }
  });
  for (let k = 0; k < 8; k++) {
    out.push({ m: us, proc: 'US_InitRndT', name: `randomize=${k & 1}#${k}`, args: [k & 1 ? 1 + k : 0],
      fill: [[G << 4, 0x10000, 100 + k]], intXor: [k * 0x1111, 0x55] });
    out.push({ m: us, proc: 'US_RndT', name: `#${k}`, args: [], fill: [[G << 4, 0x10000, 200 + k]] });
  }
  return out;
}

/** The machine a case starts from: memory as both sides see it, and the registers. */
function setUp(c, { linked }) {
  const m = c.m;
  const sp = 0xfff0 - 2 * c.args.length - 4;
  const stack = words(0, STOP_CS, ...c.args);        // far return address, then the arguments
  const image = [...(c.image ?? []), [(G << 4) + sp, stack]];
  const entry = m.lay.labels.get(c.proc);
  if (!entry) throw new Error(`no routine ${c.proc} in ${m.file}`);
  const regs = { ax: 0x1111, bx: 0x2222, cx: 0x3333, dx: 0x4444, si: 0x5555, di: 0x6666, bp: 0x7777,
    sp, ds: G, es: 0x0bad, ss: G, cs: CSP, ip: entry.addr, flags: 0x202, ...(c.regs ?? {}) };
  const theirs = { image: [...image, ...linked], fill: c.fill };
  return { regs, image, theirs };
}

/** Memory as fill + images, as unicorn-tasm.py builds it. */
function memoryOf(fill, images) {
  const mem = new Uint8Array(MEM);
  for (const [a, n, seed, mod, keep] of fill) mem.set(fillBytes(seed, n, mod, keep), a);
  for (const [a, b] of images) mem.set(b, a);
  mem[STOP] = 0xf4;
  return mem;
}

// ---------------------------------------------------------------- capture
function assembleWithTasm() {
  const bc = process.argv.find((a) => a.startsWith('--bc='))?.slice(5) ?? join(process.env.HOME ?? '', 'Projects', 'borland', 'BC20');
  const work = mkdtempSync(join(tmpdir(), 'tasmrun-'));
  for (const f of names) if (/\.(asm|equ)$/i.test(f)) copyFileSync(join(CORPUS, f), join(work, f.toUpperCase()));
  writeFileSync(join(work, 'FLAGS.ASM'), FLAGS_SOURCE, 'latin1');
  const cmds = FILES.flatMap((f, k) => ['-c', `tasm /mx ${f.toUpperCase()},M${k}.OBJ > M${k}.LOG`]);
  const r = spawnSync('dosbox-x', ['-silent', '-nogui', '-nomenu', '-c', `mount c "${bc}"`, '-c', `mount d "${work}"`,
    '-c', 'd:', '-c', 'path c:\\bin', ...cmds, '-c', 'exit'], { encoding: 'utf8', env: { ...process.env, SDL_VIDEODRIVER: 'dummy' } });
  if (r.status !== 0) throw new Error(`dosbox-x: ${r.stderr}`);
  FILES.forEach((f, k) => {
    const log = readFileSync(join(work, `M${k}.LOG`), 'latin1');
    if (!/Error messages:\s+None/.test(log)) throw new Error(`TASM reported errors on ${f}:\n${log}`);
  });
  return FILES.map((f, k) => join(work, `M${k}.OBJ`));
}

async function capture() {
  const { readOmf, linkOmf } = await import('./omf.mjs');
  const objs = assembleWithTasm();
  const golden = {
    _doc: 'TASM 2.5 object code for Keen Dreams\' three modules, linked by tools/omf.mjs at the placement '
      + 'in tools/gate-tasm-run.mjs and executed by Unicorn (tools/oracle/unicorn-tasm.py), one routine per case.',
    modules: {}, cases: {},
  };
  FILES.forEach((f, k) => {
    const m = modules.get(f);
    const o = readOmf(objs[k]);
    const text = o.segments.find((s) => /_TEXT$/.test(s.name));
    const data = o.segments.find((s) => s.name === '_DATA');
    const segs = { [text.name]: CSP << 4, _DATA: (G << 4) + DATA_BASE };
    for (const s of o.segments) if (segs[s.name] === undefined && s.size === 0) segs[s.name] = G << 4;
    const externs = {};
    for (const e of o.externs) externs[e] = (G << 4) + m.extAddr.get(e.replace(/^_/, ''));
    const linked = linkOmf(o, { segs, groups: { DGROUP: G << 4 }, externs });
    golden.modules[f] = {
      text: hex(linked.find((s) => s.name === text.name).bytes),
      data: hex(linked.find((s) => s.name === '_DATA').bytes.subarray(0, data.size)),
    };
  });
  const list = cases();
  const req = list.map((c) => {
    const lm = golden.modules[c.m.file];
    const linked = [[CSP << 4, Buffer.from(lm.text, 'hex')], [(G << 4) + DATA_BASE, Buffer.from(lm.data, 'hex')]];
    const { regs, theirs } = setUp(c, { linked });
    return { image: theirs.image.map(([a, b]) => [a, hex(b)]), fill: theirs.fill, regs, stop: STOP,
      in_seed: c.inSeed ?? 7, int_xor: c.intXor ?? [0, 0], echo: !!c.echo, steps: 50_000_000 };
  });
  const r = spawnSync(PY, [join(ROOT, 'tools/oracle/unicorn-tasm.py')], { input: JSON.stringify({ cases: req }), encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`unicorn-tasm.py: ${r.stderr}`);
  const results = JSON.parse(r.stdout).results;
  // Only the pages the routine changed are kept: every other page must end as it began, and the
  // replay rebuilds the beginning.
  list.forEach((c, k) => {
    const res = results[k];
    if (res.error) throw new Error(`${c.proc} ${c.name}: Unicorn: ${res.error}`);
    const start = memoryOf(req[k].fill, req[k].image.map(([a, h]) => [a, Buffer.from(h, 'hex')]));
    const changed = {};
    res.pages.forEach((h, p) => { if (pageHash(start, p) !== h) changed[p] = h; });
    delete res.pages;
    golden.cases[`${c.proc} ${c.name}`] = { ...res, changed };
  });
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  console.log(`captured ${list.length} cases`);
}

// ---------------------------------------------------------------- replay
let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(60)} ${ok ? '' : detail}`);
};

function replay() {
  if (!existsSync(GOLDEN)) throw new Error(`${GOLDEN} is missing: run with --capture`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  // Coverage: every translated instruction counts itself, so the report can say how much of each
  // module the cases executed -- an instruction no case reaches is checked by nothing.
  const machines = new Map(), executed = new Map();
  for (const [f, m] of modules) {
    let js = translateTasm(m.mod, m.lay, { cs: CSP, dgroup: G, dataBase: DATA_BASE, symbol: m.symbol });
    const seen = new Set();
    executed.set(f, seen);
    globalThis.__tasmSeen = globalThis.__tasmSeen ?? new Map();
    globalThis.__tasmSeen.set(f, seen);
    js = js.replace(/\/\* @(\d+) /g, (all, off) => `__tasmSeen.get(${JSON.stringify(f)}).add(${off});${all}`);
    machines.set(f, (0, eval)(js));
  }
  const byProc = new Map();
  for (const c of cases()) {
    if (ONLY && c.proc !== ONLY) continue;
    const want = golden.cases[`${c.proc} ${c.name}`];
    const key = c.m.file === 'flags.asm' ? `flags ${c.name.split(' ')[0]}` : `${c.m.file.replace('.asm', '')} ${c.proc}`;
    if (!byProc.has(key)) byProc.set(key, { n: 0, wrong: [], pages: 0, outs: 0 });
    const tally = byProc.get(key);
    tally.n++;
    if (!want) { tally.wrong.push(`${c.name}: not in the golden (recapture)`); continue; }
    const lm = golden.modules[c.m.file];
    const text = Buffer.from(lm.text, 'hex');
    const { regs, image, theirs } = setUp(c, { linked: [[CSP << 4, text], [(G << 4) + DATA_BASE, Buffer.from(lm.data, 'hex')]] });
    // Their memory, and ours: the same fill and images, then PRISM's loader instead of the linked
    // object -- with TASM's instruction bytes copied in, since PRISM never reads them.
    const mine = memoryOf(c.fill, image);
    const D = new DataView(mine.buffer);
    loadTasm(c.m.mod, c.m.lay, D, { cs: CSP, dgroup: G, dataBase: DATA_BASE, symbol: c.m.symbol });
    for (const x of c.m.lay.ins) mine.set(text.subarray(x.off, x.off + x.len), (CSP << 4) + x.off);
    const ref = memoryOf(theirs.fill, theirs.image);
    // What the routine changed, by Unicorn's account: pages whose final hash is not the start's.
    const expected = [];
    for (let p = 0; p < MEM / PAGE; p++) expected.push(want.changed[p] ?? pageHash(ref, p));
    tally.pages += Object.keys(want.changed).length;
    tally.outs += want.n_out;
    let firstDiff = -1;
    for (let a = 0; a < MEM; a++) if (mine[a] !== ref[a]) { firstDiff = a; break; }
    if (firstDiff >= 0) { tally.wrong.push(`${c.name}: the loaded memory differs at ${firstDiff.toString(16)}h`); continue; }
    // Run.
    let k = 0;
    const latch = new Map();
    const outs = createHash('sha1');
    let nOut = 0;
    const ints = [];
    const io = {
      in: (port, w) => { const v = portIn(c.inSeed ?? 7, k++, port); return (c.echo && latch.has(port) ? latch.get(port) : v) & (w === 1 ? 0xff : 0xffff); },
      out: (port, w, v) => { latch.set(port, v); outs.update(`${port}:${w}:${v & (w === 1 ? 0xff : 0xffff)};`); nOut++; },
      interrupt: (n, R) => { ints.push([n, R.ax]); R.ax ^= (c.intXor ?? [0, 0])[0]; R.bx ^= (c.intXor ?? [0, 0])[1]; },
    };
    const R = { ...regs };
    try {
      machines.get(c.m.file)(D, io).run(R, 50_000_000);
    } catch (e) { tally.wrong.push(`${c.name}: ${e.message}`); continue; }
    const diffs = [];
    if (R.cs !== STOP_CS || R.ip !== 0) diffs.push(`returned to ${R.cs?.toString(16)}:${R.ip?.toString(16)}`);
    for (const r of ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'ds', 'es', 'ss']) {
      if (R[r] !== want.regs[r]) diffs.push(`${r} ${R[r].toString(16)} vs ${want.regs[r].toString(16)}`);
    }
    const FL = 0xad5;
    if ((R.flags & FL) !== (want.flags & FL)) diffs.push(`flags ${(R.flags & FL).toString(16)} vs ${(want.flags & FL).toString(16)}`);
    for (let p = 0; p < MEM / PAGE; p++) if (pageHash(mine, p) !== expected[p]) diffs.push(`memory page ${(p * PAGE).toString(16)}h`);
    if (nOut !== want.n_out || outs.digest('hex') !== want.outs) diffs.push(`port writes (${nOut} vs ${want.n_out})`);
    if (k !== want.n_in) diffs.push(`port reads (${k} vs ${want.n_in})`);
    if (JSON.stringify(ints) !== JSON.stringify(want.ints)) diffs.push(`interrupts ${JSON.stringify(ints)} vs ${JSON.stringify(want.ints)}`);
    if (diffs.length) tally.wrong.push(`${c.name}: ${diffs.slice(0, 4).join('; ')}${diffs.length > 4 ? ` (+${diffs.length - 4})` : ''}`);
  }
  for (const [key, t] of byProc) report(!t.wrong.length, `${key}: ${t.n} calls, ${t.pages} pages written, ${t.outs} OUTs`, t.wrong.length ? `${t.wrong.length} wrong; first ${t.wrong[0]}` : '');
  for (const [f, m] of modules) {
    const missed = m.lay.ins.filter((x) => !executed.get(f).has(x.off));
    const where = [...new Set(missed.map((x) => x.where))];
    console.log(`       ${f}: ${m.lay.ins.length - missed.length} of ${m.lay.ins.length} instructions executed`
      + `${missed.length ? `; never: ${where.slice(0, process.env.ALL ? 999 : 6).join(', ')}${where.length > 6 && !process.env.ALL ? ` (+${where.length - 6} lines)` : ''}` : ''}`);
  }
  console.log(bad ? `\n${bad} WRONG` : '\nevery routine does what TASM\'s object code does.');
  process.exit(bad ? 1 : 0);
}

if (CAPTURE) await capture();
else replay();
