// gate-sdl2-surface.mjs — PRISM's SDL 2 surfaces do what the real SDL 2's do.
//
// src/env/sdl2-surface.js is the half of SDL a program draws THROUGH: formats, palettes, colour
// keys, blended and converted blits, clipping. SDLPoP's whole picture is made of those calls, so a
// rule that is one unit off here is a wrong pixel there. tests/sdl2/surfaces.c runs the operations
// that game performs on generated patterns and prints, for each, the rectangle SDL wrote back, a
// checksum over every pixel byte and four pixels; it runs against the real SDL 2 in the oracle
// container (SDL_VIDEODRIVER=dummy) and through PRISM, and every line must be the same.
//
// Controls: each rule the reference decided, swapped for its near miss.
//
//   node tools/gate-sdl2-surface.mjs
import { mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';
import { SURFACE_RULES, PIXELFORMAT } from '../src/env/sdl2-surface.js';
import { up, sh, SCRATCH } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

up();
mkdirSync(join(SCRATCH, 'sdl2surf'), { recursive: true });
copyFileSync(join(ROOT, 'tests', 'sdl2', 'surfaces.c'), join(SCRATCH, 'sdl2surf', 'surfaces.c'));
const built = sh('cd /work/sdl2surf && gcc -O1 -o surfaces surfaces.c -I/usr/include/SDL2 -lSDL2 2>&1');
if (built.code !== 0) { console.log(` BAD  the reference did not build:\n${built.stdout}${built.stderr}`); process.exit(1); }
const want = sh('cd /work/sdl2surf && SDL_VIDEODRIVER=dummy ./surfaces; echo "(exit $?)"').stdout;

function prism() {
  const target = { name: 'sdl2-surfaces', dir: 'tests/sdl2', units: { list: ['surfaces.c'] }, env: ['stdio', 'sdl2'], compile: { memory: 16 } };
  const { program } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files: {} } } });
  const r = program.run(['surfaces']);
  return `${r.stdout}(exit ${r.code})\n`;
}

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${detail}`); };
const lines = want.split('\n');
// A reference that drew nothing would agree with a library that draws nothing.
report(lines.length > 25 && want.includes('(exit 0)'), 'the reference ran every scene', `${lines.length} lines`);
let got;
try { got = prism(); } catch (e) { got = `PRISM: ${e.message.split('\n')[0]}`; }
const mine = got.split('\n');
report(got === want, 'every scene is what the real SDL 2 makes of it', `${lines.filter((l, i) => l === mine[i]).length} of ${lines.length} lines`);
if (got !== want) {
  let shown = 0;
  for (let i = 0; i < Math.max(lines.length, mine.length) && shown < 6; i++) {
    if (lines[i] !== mine[i]) { console.log(`       line ${i + 1}\n         prism: ${JSON.stringify(mine[i])}\n         real : ${JSON.stringify(lines[i])}`); shown++; }
  }
}

const swap = (object, key, value) => { const was = object[key]; object[key] = value; return () => { object[key] = was; }; };
const controls = [
  ['a blend that rounds down instead of toward zero', () => swap(SURFACE_RULES, 'blend', (s, d, a) => (d + Math.floor(((s - d) * a) / 255)) & 0xff)],
  ['a blend by shift (a/256) instead of a/255', () => swap(SURFACE_RULES, 'blend', (s, d, a) => (d + (((s - d) * a) >> 8)) & 0xff)],
  ['24 bits with no masks taken as R-first', () => swap(PIXELFORMAT, 'BGR24', PIXELFORMAT.RGB24)],
];
for (const [name, apply] of controls) {
  const undo = apply();
  let out;
  try { out = prism(); } catch (e) { out = `threw: ${e.message.split('\n')[0]}`; } finally { undo(); }
  const differ = out.split('\n').filter((l, i) => l !== lines[i]).length;
  report(out !== want && !out.startsWith('threw'), `control: ${name}`, out.startsWith('threw') ? out.slice(0, 70) : `${differ} line(s) differ`);
}

if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nSurfaces are blitted, keyed, blended and converted as SDL 2 does it.');
