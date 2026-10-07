// bundle.mjs — a compiled program as two files, loadable again without compiling it (P13.1).
//
//   dist/<name>.js    an ES module: the emitted JavaScript as a function the engine parses on
//                     import, the link tables (which name is where, which function is at which
//                     table index), and the target's environment list
//   dist/<name>.bin   the linked memory image: the 64 KB pages that hold anything
//
// Nothing of the compiler runs to load one, and no source is read: src/compile.js's loadSnapshot
// rebuilds the program and src/target.js's loadTargetBundle installs its environment around it.
// (loadSnapshot still LIVES in compile.js, so the compiler's code is imported even though none of
// it executes; moving the loader out is a separate cut.)
//
//   node tools/bundle.mjs targets/<name>.json [--out=dist]        bundle a whole target
//   node tools/bundle.mjs --mame=<game> [--out=dist]              bundle MAME 0.34's light build for a game
//
// The MAME bundles are the light builds of tools/mame-light.mjs: one archive of the makefile and
// the CPU cores it uses. dist/ is not committed -- a bundle is an artefact of sources that are not
// in this repository either.
import { writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadTarget, buildTarget, loadTargetBundle } from '../src/target.js';
import { snapshotProgram } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);

/** Build `target` and write its bundle as <dir>/<name>.js and .bin. Returns the sizes. */
export function writeBundle(target, dir, name = target.name, { compile = {} } = {}) {
  let snap = null;
  const t0 = Date.now();
  const built = buildTarget(target, { root: ROOT, compile, onProgram: (p) => { snap = snapshotProgram(p); } });
  const seconds = (Date.now() - t0) / 1000;
  mkdirSync(dir, { recursive: true });
  const about = { name, title: target.title ?? name, env: target.env ?? ['stdio'], lightOf: target.lightOf ?? null,
    notEmitted: (built.program.failures ?? []).map((f) => f.fn ?? f.name ?? f.message) };
  // `src` is `"use strict"; return function(M,F,D){...};` -- the body of a function that returns the
  // module's factory. Written as a called function expression it is ordinary JavaScript again.
  const js = [
    `// ${about.title} -- a static bundle written by PRISM's tools/bundle.mjs. Not a source file: the`,
    '// program below is JavaScript emitted from C, and it needs its memory image beside it.',
    `export const meta = ${JSON.stringify(snap.meta)};`,
    `export const about = ${JSON.stringify(about)};`,
    `export const factory = (function(){\n${snap.src}\n})();`,
    '',
  ].join('\n');
  writeFileSync(join(dir, `${name}.js`), js);
  writeFileSync(join(dir, `${name}.bin`), snap.image);
  return { name, seconds, js: js.length, image: snap.image.length,
    gzip: gzipSync(js).length + gzipSync(snap.image).length,
    functions: snap.meta.emitted.length, units: target.units?.list?.length ?? null };
}

/** A bundle read back from <dir>/<name>.{js,bin}: what loadTargetBundle takes, and its `about`. */
export async function readBundle(dir, name) {
  const m = await import(pathToFileURL(resolve(dir, `${name}.js`)).href);
  return { snapshot: { meta: m.meta, factory: m.factory, image: new Uint8Array(readFileSync(resolve(dir, `${name}.bin`))) }, about: m.about };
}

/** The program of a bundle with its environment installed. `target` only needs `name` and `env`. */
export async function loadBundle(dir, name, { envExtra = {} } = {}) {
  const { snapshot, about } = await readBundle(dir, name);
  return { ...loadTargetBundle({ name, env: about.env }, snapshot, { envExtra }), about };
}

if (process.argv[1] === SELF) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const out = resolve(arg('out') ?? join(ROOT, 'dist'));
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
  let target, name;
  /*
   * MAME's bundles are built WITH SAFEPOINTS, because that is how the page runs it (its
   * descriptor says why: `while (osd_key_pressed(k));` is a loop that calls nothing). A bundle is
   * emitted code, so the option is in it; the page refuses one that does not match.
   */
  const MAME = { safepoints: true };
  if (process.argv.includes('--mame-all')) {
    const { lightFor, CLOSURES, gamesOf } = await import('./mame-light.mjs');
    const closures = JSON.parse(readFileSync(CLOSURES, 'utf8')).archives;
    let js = 0, image = 0, gz = 0, n = 0;
    for (const a of Object.keys(closures)) {
      // Any game of the archive names its build; take one from its recorded closure.
      const game = gamesOf(a)[0];
      const t = lightFor(game);
      const r = writeBundle(t, out, `mame034-${a}`, { compile: MAME });
      js += r.js; image += r.image; gz += r.gzip; n++;
      console.log(`mame034-${a.padEnd(10)} ${mb(r.js + r.image).padStart(9)}  gzipped ${mb(r.gzip).padStart(8)}`);
    }
    console.log(`\n${n} bundles in ${out}: ${mb(js + image)}, gzipped ${mb(gz)}`);
    process.exit(0);
  }
  if (arg('mame')) {
    const { lightFor } = await import('./mame-light.mjs');
    target = lightFor(arg('mame'));
    if (!target) { console.error(`no recorded light build holds '${arg('mame')}' (tools/mame-light.mjs --write)`); process.exit(2); }
    name = `mame034-${target.lightOf.archives[0]}`;
  } else {
    const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
    if (!file) { console.error('usage: node tools/bundle.mjs targets/<name>.json | --mame=<game>  [--out=dist]'); process.exit(2); }
    target = loadTarget(resolve(file));
    name = target.name;
  }
  const r = writeBundle(target, out, name, { compile: arg('mame') ? MAME : {} });
  console.log(`${name}: ${r.units ?? '?'} units, ${r.functions} functions, compiled in ${r.seconds.toFixed(1)} s`);
  console.log(`  ${join(out, `${name}.js`)}   ${mb(r.js)}`);
  console.log(`  ${join(out, `${name}.bin`)}  ${mb(r.image)}`);
  console.log(`  together ${mb(r.js + r.image)}; gzipped ${mb(r.gzip)}`);
  // ...and read back, to say what loading costs against compiling.
  const t0 = Date.now();
  const b = await loadBundle(out, name);
  console.log(`  loads in ${((Date.now() - t0) / 1000).toFixed(2)} s (no compile, no source): ${Object.keys(b.program.F).length} functions bound`);
}
