// gate-tasm-front.mjs — PRISM's Turbo Assembler front end (src/asm/tasm.js) against Turbo Assembler.
//
// Keen Dreams builds four .ASM files with TASM (three top-level; id_vw_ae.asm is INCLUDEd by
// id_vw_a.asm for GRMODE = EGAGR). The front end reads the same source and must see the same module
// the real assembler saw. The oracle is TASM 2.5 itself, from the Borland C++ 2.0 floppies, run in
// DOSBox-X by `--capture`: its OBJECT files give the data segment's exact bytes, the positions that
// hold addresses, and the public symbols; its LISTINGS (`/la`, every macro and REPT line expanded)
// give the instruction stream as TASM assembled it, prologue and epilogue lines included.
//
// What is compared, per file:
//   * the public names
//   * the data segment, byte for byte, except where TASM recorded a fixup (an address)
//   * the offset of every public in the data segment
//   * the instruction stream: one mnemonic per instruction TASM emitted, in order -- the proof that
//     INCLUDE, EQU, IF, MACRO and REPT expanded to exactly what TASM expanded, and that PROC's
//     generated PUSH BP / MOV BP,SP / uses / POP ... / RET are where TASM put them
//
//   node tools/gate-tasm-front.mjs --capture [--bc=/path/to/BC20]
//   node tools/gate-tasm-front.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assembleTasm } from '../src/asm/tasm.js';
import { parseOperand, splitOperands } from '../src/asm/borland.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'tasm-keen.json');
const CORPUS = join(ROOT, 'corpus', 'KeenDreams');
const FILES = ['id_us_a.asm', 'id_rf_a.asm', 'id_vw_a.asm'];

const norm = (m) => (['ret', 'retf', 'retn'].includes(m) ? 'ret' : m);

/**
 * The instruction mnemonics of a TASM /la listing, in order. With tabs expanded to 8 columns the
 * layout is fixed: the offset in columns 8-11, the object bytes in 14-36, the source from 37 on.
 * A line is an instruction when it has bytes and its source is not a data directive.
 */
function listingInstructions(text) {
  const out = [];
  const expand = (l) => { let o = ''; for (const ch of l) { if (ch === '\t') o += ' '.repeat(8 - (o.length % 8)); else o += ch; } return o; };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const l = expand(raw);
    if (!/^[ 0-9]{7} [0-9A-F]{4}/.test(l)) continue;
    if (!l.slice(14, 37).trim()) continue;                  // a label or a directive: no bytes
    let src = l.slice(37).replace(/;.*/, '').trim();
    src = src.replace(/^[A-Za-z_@?$][\w@?$]*:\s*/, '');
    const words = src.split(/\s+/);
    const first = (words[0] ?? '').toLowerCase();
    if (!first || ['db', 'dw', 'dd', 'even', 'label'].includes(first)) continue;
    if (['db', 'dw', 'dd', 'label'].includes((words[1] ?? '').toLowerCase())) continue;
    if ((words[2] ?? '').startsWith('<')) continue;          // a structure instance: `name TYPE <>`
    // The object bytes: `26:` and `F3>` are prefixes, a 4-digit group is a little-endian word, and a
    // trailing r/e/s marks a fixup (an address the linker fills).
    const bytes = [];
    let fix = false;
    for (const w of l.slice(14, 37).trim().split(/\s+/)) {
      const m2 = /^([0-9A-F]{2})[:>]?$/.exec(w), m4 = /^([0-9A-F]{4})([res]?)$/.exec(w), m8 = /^([0-9A-F]{8})([res]?)$/.exec(w);
      if (m2) bytes.push(parseInt(m2[1], 16));
      else if (m4) { const v = parseInt(m4[1], 16); bytes.push(v & 255, v >> 8); if (m4[2]) fix = true; }
      else if (m8) { const v = parseInt(m8[1], 16); bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24); if (m8[2]) fix = true; }
      else throw new Error(`listing: the object bytes '${w}' in: ${l}`);
    }
    out.push({ m: norm(first), bytes, fix, off: parseInt(l.slice(8, 12), 16), src: l.trim() });
  }
  return out;
}

/*
 * NDISASM 3.01 has two faults in 16-bit code, both found here and stepped round: it cannot decode the
 * register forms of opcode FF -- `call ax` (FF D0) comes out as `db 0xff` and the next byte starts a
 * bogus instruction -- so those two-byte forms are decoded by their ModR/M reg field and handed to
 * ndisasm as NOPs; and it prints a shift or rotate by one (D0/D1) as `,0x0` (see disassemble).
 */
const REG16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const FF_REG = { 0: 'inc', 1: 'dec', 2: 'call', 4: 'jmp', 6: 'push' };
function ffRegister(bytes) {
  if (bytes.length !== 2 || bytes[0] !== 0xff || (bytes[1] >> 6) !== 3) return null;
  const op = FF_REG[(bytes[1] >> 3) & 7];
  return op ? `${op} ${REG16[bytes[1] & 7]}` : null;
}

/** Disassemble the instructions' bytes with ndisasm, one decoded text per instruction. */
function disassemble(list) {
  const bin = join(mkdtempSync(join(tmpdir(), 'nd-')), 'code.bin');
  const all = [];
  const starts = new Map();                     // offset -> manual text or null
  for (const x of list) {
    const manual = ffRegister(x.bytes);
    starts.set(all.length, manual);
    all.push(...(manual ? [0x90, 0x90] : x.bytes));
  }
  writeFileSync(bin, Uint8Array.from(all));
  const r = spawnSync('ndisasm', ['-b', '16', bin], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ndisasm: ${r.stderr}`);
  const texts = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^([0-9A-F]{8})\s+[0-9A-F]+\s+(.*)$/.exec(line);
    if (!m) continue;
    // TASM pads a forward jump it sized in one pass: `jmp @@x` is EB 09 90, a short jump and a NOP.
    // The NOP is inside the listing's instruction; anything else there means the boundaries are lost.
    const off = parseInt(m[1], 16);
    if (starts.has(off) && starts.get(off)) { texts.push(starts.get(off)); continue; }
    // ...and it prints a shift or rotate by ONE (opcodes D0/D1) as `,0x0`.
    let k = off;
    while ([0x26, 0x2e, 0x36, 0x3e, 0xf2, 0xf3, 0xf0].includes(all[k])) k++;
    if ((all[k] === 0xd0 || all[k] === 0xd1) && / ,?0x0$|,0x0$/.test(m[2].trim())) m[2] = m[2].trim().replace(/,0x0$/, ',1');
    if (!starts.has(off)) {
      if (m[2].trim() === 'nop') continue;
      let acc = 0, near = '';
      const prev = [];
      for (const x of list) {
        if (off < acc + x.bytes.length) { near = `${x.src} [${x.bytes.map((v) => v.toString(16)).join(' ')}]`; break; }
        acc += x.bytes.length;
        prev.push(`${x.src.slice(0, 60)} [${x.bytes.map((v) => v.toString(16)).join(' ')}]`);
      }
      near += ` -- after: ${prev.slice(-3).join(' | ')}`;
      throw new Error(`ndisasm lost the instruction boundaries at ${m[1]}: ${m[2]} -- inside: ${near}`);
    }
    texts.push(m[2].trim());
  }
  if (texts.length !== list.length) throw new Error(`ndisasm decoded ${texts.length} instructions of ${list.length}`);
  return texts;
}

const JUMPS = /^(j[a-z]+|loop[a-z]*|call)$/;
const REGS = new Set(['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'al', 'ah', 'bl', 'bh', 'cl', 'ch', 'dl', 'dh', 'cs', 'ds', 'es', 'ss']);

/** ndisasm's operands, as comparable signatures. */
function sigFromDisasm(text, fix) {
  let t = text.replace(/^(rep[a-z]*|lock)\s+/, '');
  const sp = t.indexOf(' ');
  const mn = sp < 0 ? t : t.slice(0, sp);
  const ops = sp < 0 ? [] : t.slice(sp + 1).split(/,(?![^\[]*\])/);
  if (JUMPS.test(mn) && ops.length === 1 && !ops[0].includes('[') && !REGS.has(ops[0].replace(/^(word|near|short|far)\s+/, ''))) return ['target'];
  const sig = ops.map((o) => {
    o = o.trim().replace(/^((byte|word|dword|near|far|short)\s+)+/, '');
    if (REGS.has(o)) return `r:${o}`;
    const m = /^\[(.*)\]$/.exec(o);
    if (!m) return fix ? 'imm:fix' : `imm:${Number(o) & 0xffff}`;
    let body = m[1], seg = '';
    const sm = /^(cs|ds|es|ss):(.*)$/.exec(body);
    if (sm) { seg = sm[1]; body = sm[2]; }
    const regs = [], disp = [];
    for (const term of body.replace(/-/g, '+-').split('+').filter(Boolean)) {
      if (REGS.has(term)) regs.push(term); else disp.push(Number(term));
    }
    const d = disp.reduce((a, b) => a + b, 0) & 0xffff;
    return mem(seg, regs, fix ? 'fix' : d);
  });
  return mn === 'xchg' ? sig.sort() : sig;
}

/** A memory signature, with the default segment (SS through BP, else DS) dropped: TASM omits it. */
function mem(seg, regs, disp) {
  const r = [...regs].sort();
  const dflt = r.includes('bp') ? 'ss' : 'ds';
  return `m:${seg === dflt ? '' : seg}:${r.join('+')}:${disp}`;
}


/** PRISM's operands for one instruction, as the same signatures. */
function sigFromTokens(toks, fix) {
  let t = toks;
  const w = (k) => (t[k] && t[k].k === 'id' ? t[k].v.toLowerCase() : null);
  if (/^rep[a-z]*$/.test(w(0) ?? '')) t = t.slice(1);
  const mn = w(0);
  const rest = t.slice(1);
  if (!rest.length) return [];
  if (JUMPS.test(mn ?? '')) {
    const names = rest.filter((x) => x.k === 'id').map((x) => x.v.toLowerCase());
    const plain = rest.every((x) => x.k === 'id') && !names.some((n) => REGS.has(n)) && !rest.some((x) => x.k === 'punct');
    if (plain) return ['target'];
  }
  const sig = splitOperands(rest).map((o) => {
    // A segment's name is its paragraph, which only the linker knows.
    if (o.length === 1 && o[0].k === 'id' && /^@(data|code|fardata)$/i.test(o[0].v)) return 'imm:fix';
    let x;
    try { x = parseOperand(o); } catch (e) { throw new Error(`${toks.map((y) => y.v).join(' ')}: ${e.message}`); }
    if (x.kind === 'reg' || x.kind === 'reg8' || x.kind === 'sreg') return `r:${x.reg}`;
    if (x.kind === 'imm') return fix ? 'imm:fix' : `imm:${x.value & 0xffff}`;
    if (x.kind === 'offset') return 'imm:fix';
    // TASM assembles LEA of a plain address as MOV of its offset.
    if (mn === 'lea' && !x.regs.length) return 'imm:fix';
    return mem(x.seg ?? '', x.regs, x.sym || fix ? 'fix' : x.c & 0xffff);
  });
  return mn === 'xchg' ? sig.sort() : sig;
}

function frontEnd(file) {
  const names = readdirSync(CORPUS);
  const read = (name) => {
    const f = names.find((x) => x.toLowerCase() === String(name).toLowerCase());
    return f ? readFileSync(join(CORPUS, f), 'latin1') : null;
  };
  return assembleTasm(file, { read });
}

async function capture() {
  const { readOmf } = await import('./omf.mjs');
  const bc = process.argv.find((a) => a.startsWith('--bc='))?.slice(5) ?? join(process.env.HOME ?? '', 'Projects', 'borland', 'BC20');
  const work = mkdtempSync(join(tmpdir(), 'tasm-'));
  for (const f of readdirSync(CORPUS)) {
    if (/\.(asm|equ)$/i.test(f)) copyFileSync(join(CORPUS, f), join(work, f.toUpperCase()));
  }
  const cmds = FILES.flatMap((f, k) => ['-c', `tasm /mx /zi /la ${f.toUpperCase()},M${k}.OBJ,M${k}.LST > M${k}.LOG`]);
  const r = spawnSync('dosbox-x', ['-silent', '-nogui', '-nomenu', '-c', `mount c "${bc}"`, '-c', `mount d "${work}"`,
    '-c', 'd:', '-c', 'path c:\\bin', ...cmds, '-c', 'exit'],
  { encoding: 'utf8', env: { ...process.env, SDL_VIDEODRIVER: 'dummy' } });
  if (r.status !== 0) throw new Error(`dosbox-x: ${r.stderr}`);
  const golden = {
    _doc: 'Turbo Assembler 2.5 (Borland C++ 2.0 floppies), `tasm /mx /zi /la`, run in DOSBox-X by '
      + 'tools/gate-tasm-front.mjs --capture on the unmodified Keen Dreams sources. Per file: the object\'s '
      + 'publics, its _DATA bytes (hash) and fixup positions, and the listing\'s instruction mnemonics.',
    files: {},
  };
  FILES.forEach((f, k) => {
    const log = readFileSync(join(work, `M${k}.LOG`), 'latin1');
    if (!/Error messages:\s+None/.test(log)) throw new Error(`TASM reported errors on ${f}:\n${log}`);
    const o = readOmf(join(work, `M${k}.OBJ`));
    const data = o.segments.find((s) => s.name === '_DATA');
    const fixups = o.fixups.filter((x) => x.seg === '_DATA').map((x) => x.at).sort((a, b) => a - b);
    const masked = Uint8Array.from(data.bytes);
    for (const at of fixups) { masked[at] = 0; masked[at + 1] = 0; }
    golden.files[f] = {
      publics: o.publics.map((p) => ({ name: p.name, seg: p.seg, offset: p.offset })),
      dataSize: data.size,
      dataHash: createHash('sha256').update(masked).digest('hex'),
      dataFixups: fixups,
      ...(() => {
        const ins = listingInstructions(readFileSync(join(work, `M${k}.LST`), 'latin1'));
        const dis = disassemble(ins);
        // A near jump's destination, as the ordinal of the instruction it lands on. ndisasm read the
        // instructions alone, without the data between them, so its address is moved back to the
        // listing's offsets before it is looked up.
        const ordinal = new Map(), stream = [];
        let acc = 0;
        ins.forEach((x, j) => { ordinal.set(x.off, j); stream.push(acc); acc += x.bytes.length; });
        const last = ins.at(-1);
        ordinal.set(last.off + last.bytes.length, ins.length);
        const to = (text, fix, j0) => {
          const m = /^(\S+)\s+(?:(?:short|near)\s+)*(0x[0-9a-f]+)$/.exec(text);
          if (!m || fix || !JUMPS.test(m[1])) return undefined;
          const j = ordinal.get((Number(m[2]) - stream[j0] + ins[j0].off) & 0xffff);
          if (j === undefined) throw new Error(`${f}: '${text}' lands between instructions`);
          return j;
        };
        // What lies between the instructions in the code segment -- data and EVEN pads -- at its real
        // offset, with the linker's fields masked.
        const code = o.segments.find((x) => /_TEXT$/.test(x.name));
        const linked = new Set(o.fixups.filter((x) => x.seg === code.name).flatMap((x) => [x.at, x.at + 1]));
        const hex = (a, b) => {
          let h = '';
          for (let k = a; k < b; k++) h += linked.has(k) ? 'xx' : (code.bytes[k] ?? 0).toString(16).padStart(2, '0');
          return h;
        };
        const codeGaps = [];
        let end = 0;
        ins.forEach((x, j) => {
          if (x.off < end) throw new Error(`${f}: instruction ${j} overlaps the one before`);
          if (x.off > end) codeGaps.push({ before: j, off: end, hex: hex(end, x.off) });
          end = x.off + x.bytes.length;
        });
        if (code.size > end) codeGaps.push({ before: ins.length, off: end, hex: hex(end, code.size) });
        return { mnemonics: ins.map((x) => x.m), ins: ins.map((x, j) => ({ fix: x.fix, dis: dis[j], to: to(dis[j], x.fix, j) })), codeGaps };
      })(),
    };
  });
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden)}\n`);
  console.log(`captured ${FILES.length} files -> goldens/tasm-keen.json`);
}

if (process.argv.includes('--capture')) await capture();
if (!existsSync(GOLDEN)) { console.log('no goldens/tasm-keen.json: run with --capture first'); process.exit(1); }
const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(56)} ${detail}`);
};
for (const f of FILES) {
  const want = g.files[f];
  let m;
  try { m = frontEnd(f); } catch (e) { report(false, `${f}: assembles`, e.message); continue; }
  // Publics: TASM's C language convention prefixes an underscore.
  const mine = [...m.publics].map((p) => `_${p}`).sort();
  const theirs = want.publics.map((p) => p.name).sort();
  report(JSON.stringify(mine) === JSON.stringify(theirs), `${f}: the ${theirs.length} public names`, mine.length === theirs.length ? '' : `${mine.length} vs ${theirs.length}`);
  // Data segment, fixups masked.
  const bytes = Uint8Array.from(m.data.bytes);
  for (const at of want.dataFixups) { bytes[at] = 0; bytes[at + 1] = 0; }
  const hash = createHash('sha256').update(bytes).digest('hex');
  const myFix = m.data.fixups.map((x) => x.at).sort((a, b) => a - b);
  report(bytes.length === want.dataSize && hash === want.dataHash, `${f}: the data segment, ${want.dataSize} bytes`, hash === want.dataHash ? '' : `${bytes.length} bytes, hash differs`);
  report(JSON.stringify(myFix) === JSON.stringify(want.dataFixups), `${f}: the ${want.dataFixups.length} address positions in it`, `${myFix.length}`);
  const dataPubs = want.publics.filter((p) => p.seg === '_DATA');
  const wrongOff = dataPubs.filter((p) => m.data.labels.get(p.name.slice(1))?.offset !== p.offset);
  report(!wrongOff.length, `${f}: the offsets of its ${dataPubs.length} data publics`, wrongOff.map((p) => p.name).join(' '));
  // Instructions.
  const mn = m.code.items.filter((x) => x.kind === 'ins').map((x) => norm(x.toks[0].v.toLowerCase()));
  let at = 0;
  while (at < Math.min(mn.length, want.mnemonics.length) && mn[at] === want.mnemonics[at]) at++;
  const same = mn.length === want.mnemonics.length && at === mn.length;
  report(same, `${f}: ${want.mnemonics.length} instructions, in TASM's order`,
    same ? '' : `${mn.length} here; first difference at #${at}: ${mn[at]} vs ${want.mnemonics[at]} (${m.code.items.filter((x) => x.kind === 'ins')[at]?.where})`);
  // ...and their operands, against ndisasm's decoding of TASM's bytes.
  if (same) {
    const ins = m.code.items.filter((x) => x.kind === 'ins');
    // The ordinal of the instruction at or after each item: where a label lands.
    const landing = [];
    let n = ins.length;
    for (let k = m.code.items.length; k >= 0; k--) { landing[k] = n; if (m.code.items[k - 1]?.kind === 'ins') n--; }
    let wrong = 0, first = null;
    ins.forEach((x, j) => {
      let theirs = sigFromDisasm(want.ins[j].dis, want.ins[j].fix);
      let mine = sigFromTokens(x.toks, want.ins[j].fix);
      if (want.ins[j].to !== undefined && mine[0] === 'target') {
        const name = x.toks.slice(1).map((y) => y.v).find((v) => !/^(short|near)$/i.test(v));
        const label = m.code.labels.get(name);
        mine = [`to:${label ? landing[label.index] : name}`];
        theirs = [`to:${want.ins[j].to}`];
      }
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) { wrong++; if (process.env.ALL) console.log(`    ${x.where}: ${JSON.stringify(mine)} vs ${JSON.stringify(theirs)} ${want.ins[j].dis} fix=${want.ins[j].fix}`); first ??= `${x.where}: ${JSON.stringify(mine)} vs ${want.ins[j].dis}`; }
    });
    report(!wrong, `${f}: the operands of all ${ins.length}, against ndisasm`, wrong ? `${wrong} differ; first ${first}` : '');
    // The code segment between instructions, rebuilt from the data items and the EVEN pads, which
    // are placed by the real offsets TASM gave.
    const between = new Map();
    let j = 0;
    for (const it of m.code.items) {
      if (it.kind === 'ins') { j++; continue; }
      if (it.kind === 'data' || it.kind === 'even') { if (!between.has(j)) between.set(j, []); between.get(j).push(it); }
    }
    const linked = new Set(m.code.fixups.flatMap((x) => Array.from({ length: x.size }, (_, k) => x.at + k)));
    const gaps = new Map(want.codeGaps.map((g) => [g.before, g]));
    let gapWrong = 0, gapFirst = null;
    for (const k of new Set([...gaps.keys(), ...between.keys()])) {
      const g = gaps.get(k) ?? { off: null, hex: '' };
      let real = g.off ?? 0, hex = '';
      for (const it of between.get(k) ?? []) {
        if (it.kind === 'even') { if (real & 1) { hex += '90'; real++; } continue; }
        for (let b = it.from; b < it.to; b++) hex += linked.has(b) ? 'xx' : m.code.bytes[b].toString(16).padStart(2, '0');
        real += it.to - it.from;
      }
      if (hex !== g.hex) { gapWrong++; gapFirst ??= `before instruction #${k} (${ins[k]?.where ?? 'the end'}): ${hex.slice(0, 24)} vs ${g.hex.slice(0, 24)}`; }
    }
    report(!gapWrong, `${f}: the ${want.codeGaps.length} runs of data and padding among the instructions`, gapWrong ? `${gapWrong} differ; first ${gapFirst}` : '');
  }
}
console.log(bad ? `\n${bad} WRONG` : '\nthe front end sees each module exactly as Turbo Assembler assembled it.');
process.exit(bad ? 1 : 0);
