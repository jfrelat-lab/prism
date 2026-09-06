// survey16.mjs — how much of a 16-bit DOS program is actually C?
//
// The question a 16-bit target has to answer before anything is built: is the assembly an OPTION or
// a load-bearing wall? Quake shipped a C equivalent of every .s and `id386=0` selects it; Wolf3D
// never had one, and 1,116 of its lines are inline asm inside the C. So the ratio that matters is
// not .C versus .ASM by file count -- it is how much assembly sits INSIDE the C, and how much of the
// C assumes segmentation.
//
//   node tools/survey16.mjs [dir ...]        # default: the 16-bit candidates in corpus/
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const ROOT = '/Users/julienfrelat/Projects/prism/corpus';
const DIRS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['Wolf3D', 'KeenDreams', 'Catacomb3D', 'Hovertank3D'].map((d) => join(ROOT, d));

/* An `asm` line, counted the way a porter counts it: one line of assembly is one line to translate.
   Both spellings, because Borland accepts `asm` and `_asm` and the sources use both. */
const ASM_LINE = /(^|[\s{;])(_?asm)[\s{]/;

/* Segmentation, which is the part a flat 32-bit model cannot approximate. `far` alone is often just
   a pointer that fits; `_seg` and `huge` are the ones that mean a real segment register. */
const SEG = /\b(_seg|huge)\b/g;
const FAR = /\bfar\b/g;

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    if (e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

const rows = [];
for (const dir of DIRS) {
  let files;
  try { files = walk(dir); } catch { console.log(`  (missing: ${dir})`); continue; }
  const row = { name: basename(dir), c: 0, cLines: 0, asmFiles: 0, asmLines: 0, inline: 0,
                engine: 0, game: 0, far: 0, seg: 0, worst: [] };
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    const text = ext === '.c' || ext === '.h' || ext === '.asm' || ext === '.inc'
      ? readFileSync(f, 'latin1') : null;
    if (text === null) continue;
    const lines = text.split('\n');
    if (ext === '.asm' || ext === '.inc') { row.asmFiles++; row.asmLines += lines.length; continue; }
    if (ext === '.c') { row.c++; row.cLines += lines.length; }
    const inl = lines.filter((l) => ASM_LINE.test(l)).length;
    row.inline += inl;
    /*
     * ENGINE or GAME. `id_*` is the ID Engine -- the same caching, video and sound libraries in
     * every one of these titles -- and it is a BOUNDARY, the way MAME's osdepend.h and Quake's
     * sys_*.c are. Assembly behind a boundary can be shimmed; assembly in the game's own renderer
     * has to be translated. Counting them together hides the only number that decides anything.
     */
    if (/^id_/i.test(basename(f))) row.engine += inl; else row.game += inl;
    if (inl) row.worst.push([basename(f), inl]);
    row.far += (text.match(FAR) ?? []).length;
    row.seg += (text.match(SEG) ?? []).length;
  }
  row.worst.sort((a, b) => b[1] - a[1]);
  rows.push(row);
}

const pad = (v, n) => String(v).padStart(n);
console.log('\n                 .C    C lines   .ASM  asm lines   inline: id_*  GAME    far   _seg/huge');
console.log('  ' + '-'.repeat(84));
for (const r of rows) {
  console.log(`  ${r.name.padEnd(13)}${pad(r.c, 3)} ${pad(r.cLines.toLocaleString('en'), 10)} ` +
    `${pad(r.asmFiles, 6)} ${pad(r.asmLines.toLocaleString('en'), 10)} ` +
    `${pad(r.engine, 13)} ${pad(r.game, 5)} ${pad(r.far, 6)} ${pad(r.seg, 11)}`);
}
console.log('\n  where the inline assembly is:');
for (const r of rows) {
  console.log(`    ${r.name.padEnd(13)} ${r.worst.slice(0, 6).map(([f, n]) => `${f}:${n}`).join('  ') || '(none)'}`);
}
