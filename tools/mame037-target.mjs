// mame037-target.mjs — write targets/mame037b5.json from MAME 0.37b5's own makefiles.
//
//   node tools/mame037-target.mjs            write it
//   node tools/mame037-target.mjs --check    exit 1 if the file on disk is not what the makefiles say
//
// The unit list is not typed by hand: it is what makefile, src/core.mak, src/mame.mak,
// src/msdos/msdos.mak and src/rules.mak name, read the way make reads them --
//
//   - mame.mak selects CPU cores and sound chips with `CPUS+=Z80@`; each becomes -DHAS_Z80=1, and
//     rules.mak's block for a core (`CPU=$(strip $(findstring Z80@,$(CPUS)))` ... `endif`) counts
//     only if the core was selected. Taking every block compiled cores no driver can reach (TMS9995).
//   - `ifdef MESS` blocks build the other program this tree also is: left out.
//   - the disassemblers (`*dasm`) are linked only with -DMAME_DEBUG, and three objects of the 68000
//     directory are its assembly core and the generator, not the core.
//
// What the release does not contain is named as `generated`: the four units the 68000 generator
// writes (tools/mame-m68k.mjs) and zlib, which the makefile links as -lz from the DJGPP install.
// zlib comes from corpus/zlib-1.1.3, the target `zlib` (P17.1): the real library, compiled, not
// src/env/zlib.js's imitation.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = join(ROOT, 'corpus/mame037b5');
const OUT = join(ROOT, 'targets/mame037b5.json');
const read = (f) => readFileSync(join(C, f), 'latin1').replace(/\r/g, '').replace(/\\\n/g, ' ');

const picked = (v) => [...read('src/mame.mak').matchAll(new RegExp(`^${v}\\+=(\\w+)@`, 'gm'))].map((m) => m[1]);
const cpus = picked('CPUS'), sounds = picked('SOUNDS');

const disk = new Map();
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p); else disk.set(relative(C, p).toLowerCase(), relative(C, p));
  }
})(join(C, 'src'));

const kept = [];
let on = true;
for (const line of read('src/rules.mak').split('\n')) {
  const pick = /^(CPU|SOUND)=\$\(strip \$\(findstring (\w+)@,\$\((CPUS|SOUNDS)\)\)\)/.exec(line);
  if (pick) { on = (pick[3] === 'CPUS' ? cpus : sounds).includes(pick[2]); continue; }
  if (on) kept.push(line);
}
const selected = ['makefile', 'src/core.mak', 'src/mame.mak', 'src/msdos/msdos.mak'].map(read).join('\n')
  .replace(/^ifdef MESS\n[\s\S]*?^endif$/gm, '') + '\n' + kept.join('\n');
const objs = new Set([...selected.matchAll(/\$\(OBJ\)\/([\w/.-]+)\.o\b/g)].map((m) => m[1]));
const units = [], noSource = [];
for (const o of objs) {
  if (/dasm$|^cpu\/m68000\/(make68k|asmintf|68kem)$/.test(o)) continue;
  const u = disk.get(`src/${o}.c`.toLowerCase());
  if (u) units.push(u); else noSource.push(o);
}
// What has no C source must be accounted for, one by one: anything new here is a misreading.
const EXPECTED = ['msdos/asmblit', 'cpu/m68000/m68kops', 'cpu/m68000/m68kopac', 'cpu/m68000/m68kopdm', 'cpu/m68000/m68kopnz'];
const surprise = noSource.filter((o) => !EXPECTED.includes(o));
if (surprise.length) { console.error(`objects with no C source: ${surprise.join(' ')}`); process.exit(1); }

const defines = { LSB_FIRST: '1', INLINE: 'static __inline__', asm: '__asm__', DJGPP: '2', __DJGPP__: '2',
  MSDOS: '1', __MSDOS__: '1', PI: '3.14159265358979323846' };
for (const c of cpus) defines[`HAS_${c}`] = '1';
for (const s of sounds) defines[`HAS_${s}`] = '1';

const GEN = 'corpus/mame037b5-generated/cpu/m68000';
const ZLIB = 'adler32 compress crc32 gzio uncompr deflate trees zutil inflate infblock inftrees infcodes infutil inffast';
const target = {
  name: 'mame037b5',
  title: 'MAME 0.37b5 (DJGPP + Allegro 3.9 + SEAL + zlib, 2000)',
  dir: 'corpus/mame037b5',
  fetch: 'curl -Lo /tmp/m37b5s.zip https://downloads.sourceforge.net/project/mame/mame/0.37b5/m37b5s.zip && mkdir -p corpus/mame037b5 && (cd corpus/mame037b5 && unzip -qo /tmp/m37b5s.zip && unzip -qo M37B5.ZIP && rm M37B5.ZIP) && node tools/mame-m68k.mjs',
  _doc: 'MAME 0.37b5, the release of the owner\'s ROM collection: 2,309 games, the 2,309 zips. WRITTEN BY tools/mame037-target.mjs from the release\'s makefiles -- regenerate it, do not edit it.',
  units: { list: units },
  _units: `What makefile, core.mak, mame.mak, msdos.mak and the selected blocks of rules.mak name: ${cpus.length} CPU families and ${sounds.length} sound chips (mame.mak's CPUS+= / SOUNDS+=). Left out: ifdef MESS blocks, the disassemblers (MAME_DEBUG only), the 68000 assembly core, and src/msdos/asmblit.asm (NASM; its 39 routines are replaced by the presentation in src/env/allegro.js).`,
  generated: [...['m68kops.c', 'm68kopac.c', 'm68kopdm.c', 'm68kopnz.c'].map((x) => `${GEN}/${x}`),
    ...ZLIB.split(' ').map((x) => `corpus/zlib-1.1.3/${x}.c`)],
  _generated: 'The 68000 opcode handlers its generator writes (tools/mame-m68k.mjs), and zlib 1.1.3 -- what the makefile links as -lz -- compiled from its source (target zlib).',
  caseInsensitive: true,
  include: ['src', 'src/msdos', '../mame037b5-generated/cpu/m68000', '../zlib-1.1.3',
    ...new Set(units.map((u) => u.replace(/\/[^/]+$/, '')))],
  defines,
  _defines: 'The makefile\'s DEFS (LSB_FIRST, INLINE, asm, PI), less -DX86_ASM; what DJGPP\'s gcc predefines; HAS_<cpu> and HAS_<chip> for every CPUS+= and SOUNDS+= of mame.mak.',
  compile: { memory: 1024, collect: true, lenientPaste: true },
  env: ['stdio', 'ports', 'allegro39'],
  _env: 'allegro39: Allegro 3.9, whose keys are renumbered from 3.0\'s (src/env/allegro39.js).',
};
const text = JSON.stringify(target, null, 2) + '\n';
if (process.argv.includes('--check')) {
  let now = '';
  try { now = readFileSync(OUT, 'utf8'); } catch { /* absent */ }
  if (now !== text) { console.error('targets/mame037b5.json is not what the makefiles say: run node tools/mame037-target.mjs'); process.exit(1); }
  console.log(`targets/mame037b5.json: ${units.length} units, as the makefiles say`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote targets/mame037b5.json: ${units.length} units, ${cpus.length} CPU families, ${sounds.length} sound chips`);
}
