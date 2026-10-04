// gate-sdl2-image.mjs — IMG_Load gives the surface the real SDL_image gives.
//
// A program treats the surface it gets from SDL_image by its KIND: SDLPoP keys a paletted image and
// blends an RGBA one, so whether a PNG with a tRNS chunk comes back indexed with a colour key or
// expanded to 32 bits decides what is drawn. src/env/sdl2-image.js makes that choice by rules; this
// gate holds them to the library. It encodes one PNG of each kind (tools/png-encode.mjs) -- every
// colour type at every depth, palettes with no transparency, one transparent entry, several, a
// translucent one -- and tests/sdl2/images.c loads them all on both sides, against the real SDL 2
// and SDL_image in the oracle container and through PRISM. Each line is a surface: format, palette
// size, colour key, blend mode, a checksum of the pixels and one of the palette.
//
// With PRISM_SDLPOP_DATA=<dir>, a sample of the game's own files goes through the same comparison.
//
//   node tools/gate-sdl2-image.mjs
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';
import { PNG_RULES } from '../src/env/png.js';
import { encode, CHANNELS } from './png-encode.mjs';
import { up, sh, SCRATCH } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let seed = 31;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8; };

function image(colorType, depth, extra = {}) {
  const width = 19, height = 11, rowBytes = (width * CHANNELS[colorType] * depth + 7) >> 3, rows = new Uint8Array(rowBytes * height);
  for (let i = 0; i < rows.length; i++) rows[i] = rnd() & 255;
  const used = (width * CHANNELS[colorType] * depth) & 7;
  if (used) for (let y = 0; y < height; y++) rows[y * rowBytes + rowBytes - 1] &= 0xff << (8 - used);
  const palette = colorType === 3 ? Uint8Array.from({ length: 3 << depth }, () => rnd() & 255) : null;
  return encode({ width, height, depth, colorType, rows, palette, ...extra });
}
const files = {};
for (const d of [1, 2, 4, 8]) {
  files[`pal${d}.png`] = image(3, d);
  files[`pal${d}-one.png`] = image(3, d, { trns: Uint8Array.from([255, 0]) });
}
files['pal4-first.png'] = image(3, 4, { trns: Uint8Array.from([0]) });
files['pal4-opaque.png'] = image(3, 4, { trns: Uint8Array.from([255, 255, 255]) });
files['pal4-two.png'] = image(3, 4, { trns: Uint8Array.from([0, 255, 0]) });
files['pal4-half.png'] = image(3, 4, { trns: Uint8Array.from([255, 128]) });
files['pal8-many.png'] = image(3, 8, { trns: Uint8Array.from({ length: 200 }, (_, i) => (i * 7) & 255) });
for (const d of [1, 2, 4, 8, 16]) files[`grey${d}.png`] = image(0, d);
files['grey8-key.png'] = image(0, 8, { trns: Uint8Array.from([0, 77]) });
files['grey4-key.png'] = image(0, 4, { trns: Uint8Array.from([0, 9]) });
for (const d of [8, 16]) { files[`greya${d}.png`] = image(4, d); files[`rgb${d}.png`] = image(2, d); files[`rgba${d}.png`] = image(6, d); }
files['rgb8-key.png'] = image(2, 8, { trns: Uint8Array.from([0, 10, 0, 20, 0, 30]) });

const data = process.env.PRISM_SDLPOP_DATA;
if (data && existsSync(join(data, 'data'))) {
  // One file in twenty of the game's, under flat names: every folder is sampled.
  let n = 0;
  (function walk(d) {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.png') && n++ % 20 === 0) files[`game${String(n).padStart(4, '0')}.png`] = new Uint8Array(readFileSync(p));
    }
  })(join(data, 'data'));
}
const names = Object.keys(files).sort();

// --- the reference
up();
const work = join(SCRATCH, 'sdl2image');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
copyFileSync(join(ROOT, 'tests', 'sdl2', 'images.c'), join(work, 'images.c'));
for (const n of names) writeFileSync(join(work, n), files[n]);
const built = sh('cd /work/sdl2image && gcc -O1 -o images images.c -I/usr/include/SDL2 -lSDL2_image -lSDL2 2>&1');
if (built.code !== 0) {
  console.log(` BAD  the reference did not build (the container needs libsdl2-image-dev):\n${built.stdout}${built.stderr}`);
  process.exit(1);
}
const want = sh(`cd /work/sdl2image && SDL_VIDEODRIVER=dummy ./images ${names.join(' ')}; echo "(exit $?)"`).stdout;
rmSync(work, { recursive: true, force: true });           // the game's files do not stay in the scratch tree

function prism() {
  const target = { name: 'sdl2-images', dir: 'tests/sdl2', units: { list: ['images.c'] }, env: ['stdio', 'sdl2'], compile: { memory: 16 } };
  const { program } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files } } });
  const r = program.run(['images', ...names]);
  return `${r.stdout}(exit ${r.code})\n`;
}

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(60)} ${detail}`); };
const lines = want.split('\n');
const loaded = lines.filter((l) => / format /.test(l)).length;
// A reference that loaded nothing would agree with a loader that loads nothing.
report(loaded === names.length && want.includes('(exit 0)'), 'the real SDL_image loaded every file', `${loaded} of ${names.length}`);
let got;
try { got = prism(); } catch (e) { got = `PRISM: ${e.message.split('\n')[0]}`; }
const mine = got.split('\n');
report(got === want, 'every surface is the one SDL_image makes', `${lines.filter((l, i) => l === mine[i]).length} of ${lines.length} lines`);
if (got !== want) {
  let shown = 0;
  for (let i = 0; i < Math.max(lines.length, mine.length) && shown < 12; i++) {
    if (lines[i] !== mine[i]) { console.log(`       prism: ${mine[i]}\n       real : ${lines[i]}`); shown++; }
  }
}
// One control: a decoder rule made wrong must show in the pixel checksums.
{
  const was = PNG_RULES.paeth;
  PNG_RULES.paeth = (a) => a;
  let out;
  try { out = prism(); } catch (e) { out = `threw: ${e.message}`; } finally { PNG_RULES.paeth = was; }
  const differ = out.split('\n').filter((l, i) => l !== lines[i]).length;
  report(out !== want && !out.startsWith('threw'), 'control: a Paeth filter that predicts from the left only', `${differ} line(s) differ`);
}

if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nIMG_Load gives the surfaces SDL_image gives.');
