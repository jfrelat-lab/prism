// neverball-sols.mjs — Neverball's levels, compiled by its own map compiler compiled by PRISM.
//
//   node tools/neverball-sols.mjs [--out=<dir>] [--only=<substring>]
//
// The release ships its 407 levels as Radiant .map sources and its Makefile turns each into a .sol
// with mapc (`%.sol : %.map $(MAPC_TARG)`: `$(MAPC) $< data`, from the tree's top). This is that rule:
// targets/neverball-mapc.json built once (the build cache keeps it), then one fresh run per map, with
// the tree's data/ readable where mapc looks for it and the .sol it writes copied out to
// <out>/<map's path>.sol (default dist/neverball-sols/).
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const OUT = arg('out') ?? join(ROOT, 'dist/neverball-sols');
const ONLY = arg('only');
const TREE = join(ROOT, 'corpus/neverball-1.6.0');

// data/, as the tree holds it: each file read when the program first opens it.
const files = {};
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(TREE, p)] = () => new Uint8Array(readFileSync(p));
  }
})(join(TREE, 'data'));
const maps = Object.keys(files).filter((k) => k.endsWith('.map') && (!ONLY || k.includes(ONLY))).sort();

const target = loadTarget(join(ROOT, 'targets/neverball-mapc.json'));
let ok = 0, failed = 0;
const t0 = performance.now();
for (const map of maps) {
  const b = buildTarget(target, { root: ROOT, envExtra: { stdio: { files: { ...files }, exactPaths: true } } });
  let out = '';
  b.program.M.stdoutHook = (s) => { out += s; };
  let r;
  try { r = b.program.run(['./mapc', map, 'data']); } catch (err) { r = { code: -1, stderr: err.message }; }
  const sol = map.replace(/\.map$/, '.sol');
  const bytes = b.program.M.files.store.get(b.program.M.files.norm(sol));
  if (r.code === 0 && bytes?.length) {
    mkdirSync(dirname(join(OUT, sol)), { recursive: true });
    writeFileSync(join(OUT, sol), bytes);
    ok++;
  } else {
    failed++;
    console.log(`FAIL ${map}: exit ${r.code} ${String(r.stderr ?? '').trim().split('\n').slice(-2).join(' | ')}`);
  }
}
console.log(`${ok} of ${maps.length} levels compiled to ${OUT} in ${((performance.now() - t0) / 1000).toFixed(1)} s${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
