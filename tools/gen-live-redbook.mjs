// gen-live-redbook.mjs — the OpenGL Red Book's examples for Live C: web/live/redbook.json, the list Live
// C's picker shows under redbook/, each opened from its file in the corpus (mesa-demos 8.0.1, src/redbook)
// with the headers beside it that it includes (jitter.h). tools/site.mjs ships those files at the same
// path, since GitLab's raw files carry no CORS header and the page cannot fetch them from there.
//
//   node tools/gen-live-redbook.mjs
//
// The examples are the ones tools/gl-census.mjs found drawing what Mesa draws, frame for frame: Live C
// offers what was measured to run. Each one's blurb is its own header comment, the sentences its author
// wrote under the file name; its licence is SGI's notice in the file, checked for here, not assumed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = 'corpus/mesa-demos-8.0.1-dist/mesa-demos-8.0.1/src/redbook';
const FETCH = 'mkdir -p corpus/mesa-demos-8.0.1-dist && curl -sfL -o corpus/mesa-demos-8.0.1-dist/mesa-demos-8.0.1.tar.bz2 https://archive.mesa3d.org/demos/8.0.1/mesa-demos-8.0.1.tar.bz2 '
  + '&& echo "4bc7f2b20d17e3eebfec288f2367a435cd2db71fc5ac9ece2c14827e290d77d1  corpus/mesa-demos-8.0.1-dist/mesa-demos-8.0.1.tar.bz2" | shasum -a 256 -c - '
  + '&& tar -xjf corpus/mesa-demos-8.0.1-dist/mesa-demos-8.0.1.tar.bz2 -C corpus/mesa-demos-8.0.1-dist';
const NOTICE = /Permission to use, copy, modify, and distribute this software for\s+\*?\s*any purpose and without fee is hereby granted/;
// tools/gl-census.mjs redbook, 2026-10-31: the 52 of 63 equal to Mesa.
const EXAMPLES = ['accanti', 'accpersp', 'alpha', 'alpha3D', 'bezcurve', 'bezmesh', 'checker', 'clip', 'cube', 'dof', 'double', 'drawf', 'feedback',
  'fog', 'font', 'hello', 'image', 'light', 'lines', 'list', 'material', 'mipmap', 'model', 'movelight', 'pickdepth', 'picksquare', 'plane',
  'planet', 'polyoff', 'polys', 'quadric', 'robot', 'sccolorlight', 'scene', 'scenebamb', 'sceneflat', 'select', 'smooth', 'stencil', 'stroke',
  'teaambient', 'teapots', 'tess', 'tesswind', 'texbind', 'texgen', 'texsub', 'texturesurf', 'torus', 'unproject', 'varray', 'wrap'];

if (!existsSync(join(ROOT, DIR))) { console.log(`no ${DIR}: ${FETCH}`); process.exit(1); }

// The sentences under the file name: the comment that names a .c file (its own, or the one it was copied
// from: bezmesh.c says bezsurf.c), else the first that is not the licence; a function's comment is not it.
function blurbOf(src) {
  const blocks = [...src.matchAll(/\/\*([\s\S]*?)\*\//g)].map((m) => m[1]).filter((b) => !/Permission|Copyright|WARRANTY|Government|trademark/i.test(b));
  const named = blocks.find((b) => /^\s*\*?\s*\w+\.c\s*$/m.test(b));
  for (const b of named ? [named] : blocks.slice(0, 1)) {
    const text = b.split('\n').map((l) => l.replace(/^\s*\*+\s?/, '').trim()).filter((l) => l && !/^\w+\.c$/.test(l)).join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 12) return text.length > 220 ? `${text.slice(0, text.lastIndexOf(' ', 217))}…` : text;
  }
  return null;
}

const entries = EXAMPLES.map((name) => {
  const src = readFileSync(join(ROOT, DIR, `${name}.c`), 'latin1');
  if (!NOTICE.test(src)) throw new Error(`${name}.c: no SGI permission notice found in it -- read it before shipping it`);
  const headers = [...src.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)].map((m) => m[1]).filter((h) => existsSync(join(ROOT, DIR, h)));
  return { name, blurb: blurbOf(src), ...(headers.length ? { headers } : {}) };
});
writeFileSync(join(ROOT, 'web/live/redbook.json'), `${JSON.stringify({
  _note: 'The OpenGL Programming Guide\'s examples as mesa-demos 8.0.1 carries them (src/redbook), the ones tools/gl-census.mjs found drawing what Mesa draws; written by tools/gen-live-redbook.mjs. Live C opens each from `dir`, which tools/site.mjs ships; each file carries SGI\'s permission notice.',
  source: 'https://archive.mesa3d.org/demos/8.0.1/',
  dir: DIR,
  fetch: FETCH,
  entries,
}, null, 1)}\n`);
console.log(`web/live/redbook.json: ${entries.length} examples, ${entries.filter((e) => e.headers).length} with a header beside them`);
