// site.mjs — a static export of the shelf: the programs whose code AND data may be shared, playable
// from any static host, with no tools/serve.mjs behind them.
//
//   node tools/site.mjs [--out=site] [--games=~/games] [--only=id,id]
//   python3 -m http.server 8800 --directory site        then http://localhost:8800/
//
// What is shipped is tools/site-programs.json: one entry per program, with its licences. For each,
// this writes what the server would have answered (tools/target-answer.mjs) into __static/, a static
// BUNDLE of its build (tools/bundle.mjs: emitted JavaScript + memory image, so the visitor compiles
// nothing and no C source is shipped), the assembly the page translates at load, its data from
// --games into data/<root>/, its licence files, and a shelf (web/machines.json) holding only it.
// web/site.json tells the page it is an export (web/endpoints.js); the project page index.html reads
// it to show the programs. COOP/COEP come from `_headers` where the host reads one (Cloudflare Pages,
// Netlify) and from web/coi-sw.js where it does not.
//
// The output holds game data and is never committed (.gitignore). No file it writes is over 25 MiB, the
// largest a common static host accepts: a bundle over it is refused, a data file over it goes in parts.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { targetAnswer } from './target-answer.mjs';
import { writeBundle } from './bundle.mjs';
import { prismHash } from '../src/build-cache.js';
import { createHash } from 'node:crypto';
import { loadTarget } from '../src/target.js';
import { targetFile } from '../web/endpoints.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const GAMES = resolve((arg('games') ?? join(homedir(), 'games')).replace(/^~/, homedir()));
/*
 * --standalone=<id>: ONE program, as a folder anyone can put on their own site (tools/standalone.mjs):
 * the export of that program alone, its index.html a page of its own with a Play button rather than
 * the catalogue, and HOSTING.txt (with .htaccess and _headers) saying how to serve it.
 */
const STANDALONE = arg('standalone') ?? null;
const ONLY = STANDALONE ? [STANDALONE] : arg('only')?.split(',');
const OUT = resolve(arg('out') ?? join(ROOT, STANDALONE ? `dist/standalone/${STANDALONE}` : 'site'));
const MAX_FILE = 25 * 1024 * 1024;

const manifest = JSON.parse(readFileSync(join(ROOT, 'tools/site-programs.json'), 'utf8'));
const entries = manifest.programs.filter((e) => !e._skip && (!ONLY || ONLY.includes(e.id)));
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const write = (rel, text) => { const p = join(OUT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const copy = (from, rel) => {
  const size = statSync(from).size;
  if (size > MAX_FILE) throw new Error(`${rel} is ${mb(size)}, over the 25 MiB a static host takes`);
  const p = join(OUT, rel); mkdirSync(dirname(p), { recursive: true }); copyFileSync(from, p);
  return size;
};
const walk = (d, pre = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name.startsWith('.') ? []
  : e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// The page, its worker and everything they import: the shell runs the same files as under serve.mjs.
for (const d of ['web', 'src', 'assets']) cpSync(join(ROOT, d), join(OUT, d), { recursive: true });
for (const f of ['index.html', 'compare.html', 'LICENSE', 'THIRD-PARTY.md']) copyFileSync(join(ROOT, f), join(OUT, f));
// The comparison page's measurements (tools/bench-compare.mjs), when they have been taken here.
if (existsSync(join(ROOT, 'dist/bench-compare/results.json'))) copyFileSync(join(ROOT, 'dist/bench-compare/results.json'), join(OUT, 'web/bench.json'));
// The licence texts THIRD-PARTY.md points to: the LGPL routines ship in src/, so their licence does too.
cpSync(join(ROOT, 'LICENSES'), join(OUT, 'LICENSES'), { recursive: true });
write('_headers', '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n');

/*
 * TECHNOLOGY TAGS, read off the target rather than written by hand: its languages (the units' own
 * extensions), a 16-bit model, its compiler's runtime and every platform layer its env list names, the
 * assembly it translates; then what a target cannot say for itself (`tags` in the manifest: Tcl, FTGL).
 */
const ENV_TAGS = { borland: 'Borland C++', watcom: 'Watcom · DOS4GW', go32: 'DJGPP', dj: 'DJGPP', allegro: 'Allegro',
  allegro39: 'Allegro', x11: 'X11', svgalib: 'svgalib', sdl12: 'SDL 1.2', sdl2: 'SDL 2', sdlimage12: 'SDL_image',
  gl: 'OpenGL 1.x', glu: 'GLU', glut: 'GLUT', glx: 'GLX', wgl: 'WGL', fxmesa: '3Dfx (fxMesa)', wsock: 'Winsock',
  ega: 'EGA', vgaplanar: 'VGA planar' };
function techTags(target, answer, desc, extra = []) {
  const units = answer.units.map((u) => u.file);
  const tags = [];
  if (units.some((f) => /\.c$/i.test(f))) tags.push('C');
  if (units.some((f) => /\.(cpp|cc|cxx)$/i.test(f))) tags.push('C++');
  if (String(target.compile?.model ?? '').startsWith('dos16')) tags.push('16-bit');
  // The host a variant names wins over its descriptor's: quake.exe is the Win32 build of `quake`.
  // WinQuake's MGL window and a WGL context are Win32 hosts as much as `win32` is.
  if (['win32', 'mgl', 'wgl'].includes(answer.host ?? desc.host ?? desc.platform)) tags.push('Win32');
  for (const e of target.env ?? []) if (ENV_TAGS[e]) tags.push(ENV_TAGS[e]);
  for (const a of answer.asmTranslate) tags.push(typeof a !== 'string' || /\.s$/i.test(a) ? 'GNU as' : 'NASM');
  if (answer.tasm.length) tags.push('TASM');
  return [...new Set([...tags, ...extra])];
}

/*
 * BUNDLES ARE KEPT between runs, in dist/site-bundles/. Compiling them is nearly all of an export's
 * time -- the MAME builds alone are minutes -- and tools/bundle.mjs asks buildTarget for the program
 * it just compiled, which src/build-cache.js does not keep. A bundle is a function of PRISM's src/,
 * the target's description and its source tree; the key hashes the three, the tree by every file's
 * path, size and mtime, so a header or an assembly file touched is a miss as much as a unit.
 */
const CACHE = join(ROOT, 'dist', 'site-bundles');
function treeHash(dir) {
  const h = createHash('sha256');
  (function walk(d) {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f), s = statSync(p);
      if (s.isDirectory()) walk(p); else h.update(`${p.slice(dir.length)}\0${s.size}\0${s.mtimeMs}\n`);
    }
  })(dir);
  return h.digest('hex');
}
let hits = 0;
function cachedBundle(target, name, opts) {
  const key = createHash('sha256').update(JSON.stringify([prismHash(), target, opts]))
    .update(target.dir ? treeHash(join(ROOT, target.dir)) : '').digest('hex');
  const at = (ext) => join(CACHE, `${name}.${ext}`);
  let result = null;
  try { if (readFileSync(at('key'), 'utf8') === key) result = JSON.parse(readFileSync(at('json'), 'utf8')); } catch { /* a miss */ }
  if (result) hits++;
  else {
    mkdirSync(CACHE, { recursive: true });
    result = writeBundle(target, CACHE, name, opts);
    writeFileSync(at('json'), JSON.stringify(result));
    writeFileSync(at('key'), key);
  }
  mkdirSync(join(OUT, 'dist'), { recursive: true });
  for (const ext of ['js', 'bin']) copyFileSync(at(ext), join(OUT, 'dist', `${name}.${ext}`));
  return result;
}

/** The build of `tname` as a bundle, its static answers and its assembly; once per target. */
async function bundle(tname, desc) {
  if (targets.has(tname)) return targets.get(tname);
  const [file, variant] = tname.split(':');
  const target = loadTarget(join(ROOT, 'targets', `${file}.json`), variant || null);
  // A file name, not a path: a variant's own name can be "quake/x11".
  const name = tname.replace(/[:/]/g, "-");
  // A descriptor that runs with safepoints needs a bundle built with them, or the page compiles instead.
  const b = cachedBundle(target, name, { compile: desc.safepoints ? { safepoints: true } : {} });
  for (const ext of ['js', 'bin']) {
    const s = statSync(join(OUT, 'dist', `${name}.${ext}`)).size;
    if (s > MAX_FILE) throw new Error(`dist/${name}.${ext} is ${mb(s)}, over 25 MiB`);
    total += s;
  }
  const answer = await targetAnswer(ROOT, tname, { bundleFor: () => `dist/${name}` });
  // A bundle needs no C: the unit list stays (the page counts it) but nothing in it is fetched.
  write(`__static/target/${targetFile(tname)}.json`, JSON.stringify(answer));
  // The assembly the page still translates when the program loads, at its repository path.
  const asm = [...answer.asmTranslate.map((a) => (typeof a === 'string' ? a : a.file)), ...answer.tasmFiles,
    ...answer.dataObjects.map((o) => o.path).filter(Boolean)];
  for (const f of asm) total += copy(join(ROOT, f), f);
  // The source trees it was built from: each top directory of corpus/ the build reads anything in --
  // its units, include paths, assembly, generated files (Chromium B.S.U.'s FreeType is a tree of its own).
  const trees = [...new Set([answer.dir, ...answer.units.filter((u) => u.source === undefined).map((u) => u.file),
    ...answer.include, ...asm].map((p) => normalize(p).split('/')).filter((s) => s[0] === 'corpus' && s[1]).map((s) => s[1]))];
  const info = { title: answer.title, units: answer.units.length, functions: b.functions, tags: techTags(target, answer, desc), trees };
  targets.set(tname, info);
  return info;
}

/*
 * A LIGHT BUILD for one game of a target that has them (MAME: the makefile archive that holds the
 * game, tools/mame-light.mjs). Under serve.mjs the page names the game and the server answers; an
 * export has no server, so the answer for each game it shows is written beside the whole build's, as
 * __static/target/<target>@<game>.json, and site.json lists those games (web/endpoints.js).
 */
const light = {};                  // target -> [game]
async function lightBundle(tname, game, desc) {
  const answer = await targetAnswer(ROOT, tname, { subject: game, bundleFor: (n) => `dist/${n.replace(/[:/]/g, '-')}` });
  if (!answer.lightOf) return false;
  const name = answer.bundle.slice('dist/'.length);
  if (!targets.has(name)) {
    const resolved = (await import(join(ROOT, loadTarget(join(ROOT, 'targets', `${tname}.json`)).light.module))).lightFor(game);
    cachedBundle(resolved, name, { compile: desc.safepoints ? { safepoints: true } : {} });
    for (const ext of ['js', 'bin']) {
      const s = statSync(join(OUT, 'dist', `${name}.${ext}`)).size;
      if (s > MAX_FILE) throw new Error(`dist/${name}.${ext} is ${mb(s)}, over 25 MiB`);
      total += s;
    }
    targets.set(name, { title: answer.title, light: true });
  }
  write(`__static/target/${targetFile(tname)}@${game}.json`, JSON.stringify(answer));
  (light[tname] ??= []).push(game);
  return true;
}

const shipped = [];
const targets = new Map();
const dataRoots = new Map();      // root -> Set of files under it
let total = 0;
for (const e of entries) {
  const desc = JSON.parse(readFileSync(join(ROOT, 'web/programs', `${e.program}.json`), 'utf8'));
  const tname = e.variant ? `${desc.target.split(':')[0]}:${e.variant}` : desc.target;
  console.log(`${e.id}: ${tname}`);

  const built = await bundle(tname, desc);

  /*
   * A SOUND SERVER (Doom's sndserv): a second program the page compiles in a worker of its own
   * (web/sndworker.js), from its sources, which a static export ships at their paths.
   */
  if (desc.soundServer) for (const f of readdirSync(join(ROOT, desc.soundServer)).filter((x) => /\.(c|h)$/i.test(x))) total += copy(join(ROOT, desc.soundServer, f), `${desc.soundServer}/${f}`);

  // The data, as the page asks for it: the files of `dir` under `under`, minus `exclude`, plus `also`.
  const nd = desc.needsData;
  if (nd?.dir) {
    const from = join(GAMES, nd.dir);
    if (!existsSync(from)) throw new Error(`${e.id}: no ${from}`);
    const set = dataRoots.get(nd.dir) ?? new Set();
    for (const f of walk(from)) {
      if (!f.startsWith(nd.under ?? '') || (nd.exclude ?? []).includes(f.split('/').pop())) continue;
      if (f === 'PROVENANCE.txt') continue;             // our note on where it came from, not the game's
      // `dataFiles`: when the root holds more than the program reads, only these are shipped.
      if (e.dataFiles && !e.dataFiles.includes(f)) continue;
      set.add(f);
    }
    for (const { dir, file } of nd.also ?? []) {
      const s2 = dataRoots.get(dir) ?? new Set(); s2.add(file); dataRoots.set(dir, s2);
    }
    dataRoots.set(nd.dir, set);
  }

  // The licences, beside the program: the files the entry names, from the data root or the corpus.
  const licences = [];
  for (const l of e.licenseFiles ?? []) {
    const from = l.from === 'data' ? join(GAMES, l.path) : join(ROOT, l.path);
    const rel = `licenses/${e.id}/${l.path.split('/').pop()}`;
    copy(from, rel);
    licences.push({ name: l.name, href: rel, for: l.for ?? 'code' });
  }
  shipped.push({ ...e, target: tname, licences, machine: e.machine, tags: [...new Set([...built.tags, ...(e.tags ?? [])])] });
}

for (const [root, files] of dataRoots) {
  let n = 0;
  /*
   * A data file over the limit goes in PARTS (<file>.part0, .part1, ...) that the page joins back
   * (web/app.js loadData): Beneath a Steel Sky's sky.dsk is 69 MiB. The visitor's program reads the
   * file whole and unchanged; the parts are transport.
   */
  const chunks = {};
  for (const f of files) {
    const from = join(GAMES, root, f), size = statSync(from).size;
    if (size <= MAX_FILE) { n += copy(from, `data/${root}/${f}`); continue; }
    const bytes = readFileSync(from), PART = 24 * 1024 * 1024;
    chunks[f] = Math.ceil(size / PART);
    for (let i = 0; i < chunks[f]; i++) write(`data/${root}/${f}.part${i}`, bytes.subarray(i * PART, (i + 1) * PART));
    n += size;
  }
  total += n;
  write(`__static/data/${encodeURIComponent(root)}.json`, JSON.stringify({ files: [...files], entries: [...files].map((file) => ({ root, file })), roots: [root], chunks }));
  console.log(`  data ${root}: ${files.size} files, ${mb(n)}`);
}

/*
 * THE GALLERY: programs PRISM compiles whose data may not be passed on. Their data is never shipped;
 * a thumbnail PRISM drew from the owner's copy, what a visitor needs, the target the build comes from,
 * and the build itself when its code may be shipped. An entry without its thumbnail is left out.
 */
const gallery = [];
for (const g of (manifest.gallery ?? []).filter((x) => !ONLY || ONLY.includes(x.id))) {
  const t = join(ROOT, 'dist/site-thumbs', `${g.id}.png`);
  if (!existsSync(t)) { console.log(`  gallery ${g.id}: no thumbnail, left out`); continue; }
  copy(t, `thumbs/${g.id}.png`);
  const desc = JSON.parse(readFileSync(join(ROOT, 'web/programs', `${g.program}.json`), 'utf8'));
  const { thumb, ...rest } = g;
  const tname = (thumb?.target ?? '').replace('.json', '') || (g.variant ? `${desc.target.split(':')[0]}:${g.variant}` : desc.target);
  /*
   * ITS BUILD is shipped (its code's licence allows it; `noBuild` says when not, and why), so a visitor
   * who has the data can run it: the page asks for the folder (web/app.js), nothing of theirs leaves
   * the browser. A build that cannot be bundled leaves the entry a picture with no Run.
   */
  let built = null;
  if (!g.noBuild) {
    try { built = await bundle(tname, desc); } catch (err) { console.log(`  gallery ${g.id}: no build (${err.message.split('\n')[0]})`); }
    // `light`: the game its command line names gets its light build too, which loads in a fraction.
    const game = String(g.args ?? '').split(/\s+/).find((a) => a && !a.startsWith('-'));
    if (built && game && loadTarget(join(ROOT, 'targets', `${tname.split(':')[0]}.json`)).light) {
      try { await lightBundle(tname, game, desc); } catch (err) { console.log(`  gallery ${g.id}: no light build (${err.message.split('\n')[0]})`); }
    }
  }
  /*
   * `data`: the root the program reads and the one file that shows a copy is there (the descriptor's
   * marker, or for a ROM collection the game's own zip), for a local library (serve.mjs --site) to
   * tell the page which games it holds.
   */
  const nd = desc.needsData ?? {};
  const game = String(g.args ?? '').split(/\s+/).find((a) => a && !a.startsWith('-'));
  const data = nd.dir ? { root: nd.dir, under: nd.under ?? '', need: nd.marker ?? (nd.lazy && game ? `${game}.zip` : null) } : null;
  if (built) gallery.push({ ...rest, target: tname, thumb: `thumbs/${g.id}.png`, tags: [...new Set([...built.tags, ...(g.tags ?? [])])], data,
    run: `web/?machine=${encodeURIComponent(g.machine)}&program=${encodeURIComponent(g.variant ? g.file ?? g.program : g.program)}${g.args !== undefined ? `&args=${encodeURIComponent(g.args)}` : ''}&run=1` });
  else {
    // No build shipped, the tags all the same: they are read off the target, not off a bundle.
    const [file, variant] = tname.split(':');
    const answer = await targetAnswer(ROOT, tname);
    const tags = techTags(loadTarget(join(ROOT, 'targets', `${file}.json`), variant || null), answer, desc, g.tags ?? []);
    gallery.push({ ...rest, target: tname, thumb: `thumbs/${g.id}.png`, tags });
  }
}

// The picker's answers: only what is shipped, all present.
write('__static/targets.json', JSON.stringify({ targets: [...new Set([...targets.keys()].filter((t) => !targets.get(t).light).map((t) => t.split(':')[0]))].map((name) => {
  const variants = [...targets.keys()].filter((t) => t.startsWith(`${name}:`)).map((t) => ({ name: t.split(':')[1], host: null, web: true, args: null }));
  return { name, title: targets.get(name)?.title ?? name, variants, present: true };
}) }));

// The shelf: each machine keeps only the shipped entries, in the manifest's order; an empty machine goes.
const machines = JSON.parse(readFileSync(join(ROOT, 'web/machines.json'), 'utf8'));
const want = new Set([...shipped, ...gallery.filter((g) => g.run)].map((s) => `${s.machine}\0${s.program}\0${s.variant ?? ''}`));
machines.machines = machines.machines.map((m) => ({ ...m, programs: m.programs.filter((p) => want.has(`${m.id}\0${p.program}\0${p.variant ?? ''}`)) }))
  .filter((m) => m.programs.length);
write('web/machines.json', JSON.stringify(machines, null, 1));
// A Windows program's icon is its own .ico, in its source tree, which an export does not ship whole.
for (const p of machines.machines.flatMap((m) => m.programs)) if (p.icon) total += copy(join(ROOT, p.icon), p.icon);

// The thumbnails tools/site-thumbs.mjs took, when there are some.
for (const s of shipped) {
  const t = join(ROOT, 'dist/site-thumbs', `${s.id}.png`);
  // The manifest's `thumb` is how to TAKE one (site-thumbs.mjs); the page's is the image's path, or
  // nothing. Passed through as it stood, a missing thumbnail reached the page as an object and drew
  // <img src="[object Object]">.
  s.thumb = existsSync(t) ? (copy(t, `thumbs/${s.id}.png`), `thumbs/${s.id}.png`) : null;
}

/*
 * THE CORRESPONDING SOURCE, shipped beside the builds. A bundle is object code, and the GPL v2 asks
 * whoever passes it on to pass on its source too, not to point at someone else's copy (that is v3);
 * upstreams also go away (Raven's site has). So every source tree a shipped build was made from goes
 * into sources/<tree>.tar.gz exactly as it sits in corpus/ -- PRISM never edits a program's source --
 * with build-scripts.tar.gz (what the GPL calls the scripts that control the build: each shipped
 * program's targets/*.json, and the tools that write its generated files -- a configure run in the
 * oracle container, MAME's light driver tables), a checksum list and a README saying where each tree
 * came from and which commit of PRISM, the compiler, built them. The compiler itself is not a script
 * of the programs' builds and is not shipped here. Archives are kept in dist/site-sources/ under the
 * tree's hash, as bundles are.
 *
 * --sources=release[:<tag>]: the archives are not copied into the export but published as the assets
 * of a release of jfrelat-lab/prism-sources (tools/publish-sources.mjs, from dist/site-sources/
 * release.json), and the pages link there; the export keeps the README and the checksums. The tag
 * defaults to site-<date>. The archives themselves are the same files either way.
 */
const SRC_CACHE = join(ROOT, 'dist', 'site-sources');
const SOURCES_REPO = 'jfrelat-lab/prism-sources';
const RELEASE = arg('sources')?.startsWith('release')
  ? (arg('sources').split(':')[1] || `site-${new Date().toISOString().slice(0, 10)}`) : null;
const hrefOf = (name) => (RELEASE ? `https://github.com/${SOURCES_REPO}/releases/download/${RELEASE}/${encodeURIComponent(name)}` : `sources/${name}`);
const archives = new Map();               // tree -> { href, name, bytes, sha256, fetch }
function sourceArchive(tree, fetch) {
  if (archives.has(tree)) return archives.get(tree);
  const key = treeHash(join(ROOT, 'corpus', tree));
  const file = join(SRC_CACHE, `${tree}.tar.gz`);
  let fresh = false;
  try { fresh = readFileSync(join(SRC_CACHE, `${tree}.key`), 'utf8') === key; } catch { /* a miss */ }
  if (!fresh) {
    mkdirSync(SRC_CACHE, { recursive: true });
    const r = spawnSync('tar', ['-czf', file, '--exclude', '.git', '--exclude', '.DS_Store', '-C', join(ROOT, 'corpus'), tree]);
    if (r.status !== 0) throw new Error(`sources/${tree}.tar.gz: tar failed: ${r.stderr}`);
    writeFileSync(join(SRC_CACHE, `${tree}.key`), key);
  }
  const bytes = RELEASE ? statSync(file).size : copy(file, `sources/${tree}.tar.gz`);
  if (!RELEASE) total += bytes;
  const a = { href: hrefOf(`${tree}.tar.gz`), name: `${tree}.tar.gz`, file, bytes,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), fetch };
  archives.set(tree, a);
  return a;
}
// The commit of PRISM the export was built from; the README links it.
const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim() !== '';
mkdirSync(SRC_CACHE, { recursive: true });
/*
 * THE BUILD SCRIPTS: the shipped targets' files, and every tool that writes a generated tree one of
 * them reads (named in the tool's own text), with the local modules those tools import and the oracle
 * container they run in. Read from the working tree, so they are what built this export.
 */
const scriptFiles = new Set(['LICENSE']);
const usedTargets = new Set([...shipped, ...gallery.filter((g) => g.run)].map((x) => String(x.target).split(':')[0]));
for (const t of usedTargets) scriptFiles.add(`targets/${t}.json`);
if (Object.keys(light).length) { scriptFiles.add('tools/mame-light.mjs'); scriptFiles.add('targets/light/mame034.json'); }
const generated = [...new Set([...targets.values()].flatMap((t) => t.trees ?? []))].filter((t) => t.endsWith('-generated'));
const toolNames = readdirSync(join(ROOT, 'tools')).filter((f) => f.endsWith('.mjs') && !f.startsWith('gate-'));
for (const tree of generated) for (const f of toolNames) if (readFileSync(join(ROOT, 'tools', f), 'utf8').includes(tree)) scriptFiles.add(`tools/${f}`);
for (const f of [...scriptFiles]) {
  // A tool's own imports from tools/, followed to the end.
  const walkImports = (rel) => {
    if (!rel.startsWith('tools/') || !rel.endsWith('.mjs')) return;
    for (const m of readFileSync(join(ROOT, rel), 'utf8').matchAll(/from '\.\/([\w.-]+\.mjs)'/g)) {
      const dep = `tools/${m[1]}`;
      if (!scriptFiles.has(dep)) { scriptFiles.add(dep); walkImports(dep); }
    }
  };
  walkImports(f);
}
if ([...scriptFiles].includes('tools/oracle.mjs')) scriptFiles.add('tools/oracle/Dockerfile');
const prismFile = join(SRC_CACHE, 'build-scripts.tar.gz');
const scriptsTar = spawnSync('tar', ['-czf', prismFile, '-C', ROOT, ...[...scriptFiles].sort()]);
if (scriptsTar.status !== 0) throw new Error(`sources/build-scripts.tar.gz: tar failed: ${scriptsTar.stderr}`);
const prismBytes = RELEASE ? statSync(prismFile).size : copy(prismFile, 'sources/build-scripts.tar.gz');
if (!RELEASE) total += prismBytes;
const prismArchive = { href: hrefOf('build-scripts.tar.gz'), name: 'build-scripts.tar.gz', file: prismFile, bytes: prismBytes,
  sha256: createHash('sha256').update(readFileSync(prismFile)).digest('hex') };
const sourcesOf = (tname) => {
  // `file` is where the archive sits on this machine: for publish-sources.mjs, not for the page.
  const t = targets.get(tname);
  if (!t) return null;
  const fetch = loadTarget(join(ROOT, 'targets', `${tname.split(':')[0]}.json`)).fetch ?? null;
  return [...t.trees.map((tree) => sourceArchive(tree, fetch)), prismArchive].map(({ file, ...a }) => a);
};
for (const s of shipped) s.sources = sourcesOf(s.target);
for (const g of gallery) if (g.run) g.sources = sourcesOf(g.target);
write('sources/SHA256SUMS', [...archives.values(), prismArchive].map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n');
write('sources/README.txt', [
  'The source of every program this site runs, as it was built.',
  '',
  'Each <tree>.tar.gz is a source tree exactly as it was fetched from its publisher -- PRISM compiles',
  "programs' sources unmodified. build-scripts.tar.gz holds the scripts that control their builds: one",
  'targets/<program>.json per program (its units, defines and options) and the tools that write the',
  'generated trees (the *-generated archives: what each program\'s own configure wrote, run in the',
  'container tools/oracle/Dockerfile describes). SHA256SUMS holds the archives\' checksums.',
  '',
  'The compiler that turned them into this site\'s builds is PRISM, at this commit:',
  `  https://github.com/jfrelat-lab/prism/tree/${head}${dirty ? '  (built from a working tree with uncommitted changes)' : ''}`,
  'and node tools/site.mjs there rebuilds every bundle of this site from the archives here.',
  ...(RELEASE ? ['', `The archives are the assets of the release ${RELEASE} of https://github.com/${SOURCES_REPO}:`,
    `  https://github.com/${SOURCES_REPO}/releases/tag/${RELEASE}`] : []),
  '',
  ...[...archives.entries()].flatMap(([tree, a]) => [`${a.name}: corpus/${tree}/`, `  fetched with: ${a.fetch ?? '(see the target file)'}`]),
  '',
].join('\n'));
if (RELEASE) {
  // What tools/publish-sources.mjs uploads: the archives as they are in the cache, the README, the sums.
  for (const f of ['README.txt', 'SHA256SUMS']) copyFileSync(join(OUT, 'sources', f), join(SRC_CACHE, f));
  writeFileSync(join(SRC_CACHE, 'release.json'), JSON.stringify({ repo: SOURCES_REPO, tag: RELEASE, commit: head, dirty,
    files: [...[...archives.values()].map((a) => a.file), prismFile, join(SRC_CACHE, 'README.txt'), join(SRC_CACHE, 'SHA256SUMS')] }, null, 1));
  console.log(`  sources: to publish as ${SOURCES_REPO} release ${RELEASE}: node tools/publish-sources.mjs`);
}
console.log(`  sources: ${archives.size} trees and the build scripts (${scriptFiles.size} files), ${mb([...archives.values()].reduce((t, a) => t + a.bytes, prismBytes))}${dirty ? ' (built from uncommitted changes: the README says so)' : ''}`);

write('web/site.json', JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  light,
  gallery,
  programs: shipped.map(({ licenseFiles, ...s }) => ({ ...s, units: targets.get(s.target)?.units ?? null,
    run: `web/?machine=${encodeURIComponent(s.machine)}&program=${encodeURIComponent(s.variant ? s.file ?? s.program : s.program)}${s.args !== undefined ? `&args=${encodeURIComponent(s.args)}` : ''}&run=1` })),
}, null, 1));
console.log(`\n${shipped.length} programs, ${targets.size} builds (${hits} from dist/site-bundles), ${mb(total)} of bundles, assembly and data in ${OUT}`);

if (STANDALONE) standalonePage();

/*
 * THE STANDALONE PAGE: the one program's own index.html -- its picture, what it is, Play (the player,
 * web/?...&player=1), its licences and the source of its build -- in place of the catalogue, and how
 * to host the folder. Everything in it is relative, so the folder works under any path.
 */
function standalonePage() {
  const all = [...shipped.map((p) => ({ ...p, avail: 'play' })), ...gallery.filter((g) => g.run).map((g) => ({ ...g, avail: 'files' }))];
  const p = all[0];
  if (!p) throw new Error(`--standalone=${STANDALONE}: no such program, or it has no build to ship`);
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const run = `web/?machine=${encodeURIComponent(p.machine)}&program=${encodeURIComponent(p.variant ? p.file ?? p.program : p.program)}${p.args !== undefined ? `&args=${encodeURIComponent(p.args)}` : ''}&run=1&player=1`;
  const thumb = typeof p.thumb === 'string' ? p.thumb : null;
  const li = (items) => items.map((x) => `<li>${x}</li>`).join('');
  write('index.html', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.blurb)}">
<style>
  :root { --bg: #0b0d11; --panel: #12161c; --line: #1f2630; --ink: #c3cbd6; --dim: #7a8594; --head: #edf1f6; --accent: #6cb6ff; --accent-ink: #061524; --warn: #c9a227; }
  @media (prefers-color-scheme: light) { :root { --bg: #f4f6f9; --panel: #fff; --line: #d9dee6; --ink: #2b3440; --dim: #5f6b7a; --head: #0f1720; --accent: #1f6fd1; --accent-ink: #fff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; display: grid; gap: 18px; }
  .shot { display: block; aspect-ratio: 4 / 3; background: #000; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .shot img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; display: block; }
  h1 { margin: 0; font-size: 28px; color: var(--head); text-wrap: balance; }
  .meta { color: var(--dim); }
  .play { justify-self: start; padding: 10px 22px; border-radius: 6px; background: var(--accent); color: var(--accent-ink); font-weight: 600; text-decoration: none; font-size: 16px; }
  .play:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  a { color: var(--accent); }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  h2 { margin: 0 0 6px; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  ul { margin: 0; padding-left: 18px; } p { margin: 0 0 6px; }
  .caution { border-color: var(--warn); }
  footer { color: var(--dim); font-size: 13px; }
</style>
</head>
<body>
<main>
  ${thumb ? `<a class="shot" href="${esc(run)}" aria-label="Play ${esc(p.title)}"><img src="${esc(thumb)}" alt="${esc(p.title)}"></a>` : ''}
  <div>
    <h1>${esc(p.title)}</h1>
    <div class="meta">${esc(p.author)}${p.year ? `, ${esc(p.year)}` : ''} · ${esc(p.kind)}</div>
  </div>
  <p>${esc(p.blurb)}</p>
  <a class="play" href="${esc(run)}">${p.avail === 'play' ? 'Play' : 'Play with your files'}</a>
  ${p.avail === 'files' ? `<p class="meta">Needs ${esc(p.needs)}${p.get ? ` (from <a href="${esc(p.get.href)}">${esc(p.get.label)}</a>)` : ''}: the page asks for your copy, a folder or a .zip, and reads it where it is; nothing is uploaded.</p>` : ''}
  <p class="meta">It needs a keyboard, and most games take the mouse too.</p>
  ${p.caution ? `<section class="caution"><h2>⚠️ Licence</h2><p>${esc(p.caution)}</p></section>` : ''}
  <section>
    <h2>Licences</h2>
    ${p.code?.license ? `<p>Code: ${esc(p.code.license)}</p>` : ''}${p.data?.license ? `<p>Data: ${esc(p.data.license)}</p>` : ''}
    ${p.licences?.length ? `<ul>${li(p.licences.map((l) => `<a href="${esc(l.href)}">${esc(l.name)}</a>`))}</ul>` : ''}
    ${p.credits ? `<p class="meta">${esc(p.credits)}</p>` : ''}
  </section>
  <section>
    <h2>Source of this build</h2>
    <ul>${li((p.sources ?? []).map((a) => `<a href="${esc(a.href)}" download>${esc(a.name)}</a> <span class="meta">${(a.bytes / 1048576).toFixed(1)} MB</span>`))}</ul>
    <p class="meta"><a href="sources/README.txt">What these archives are</a> · <a href="sources/SHA256SUMS">checksums</a> · <a href="${esc(p.code?.source ?? p.source)}">the publisher's source</a></p>
  </section>
  <footer>Compiled from its unmodified source to JavaScript by <a href="https://github.com/jfrelat-lab/prism">PRISM</a>, and run in this page.</footer>
</main>
</body>
</html>
`);
  // Cross-origin isolation (SharedArrayBuffer) from the server where it can say so; web/coi-sw.js does it otherwise.
  const H = ['Cross-Origin-Opener-Policy: same-origin', 'Cross-Origin-Embedder-Policy: require-corp', 'Cross-Origin-Resource-Policy: same-origin'];
  write('.htaccess', ['# Apache (mod_headers): the headers PRISM needs for SharedArrayBuffer.', '<IfModule mod_headers.c>',
    ...H.map((h) => `  Header set ${h.replace(': ', ' "')}"`), '</IfModule>', ''].join('\n'));
  write('HOSTING.txt', [
    `${p.title}, as a folder for your own site`,
    '',
    'Copy this folder anywhere on a web server, under any path, and link to it (its index.html). It',
    'needs no server code: every file is static, and every path in it is relative to the folder.',
    '',
    'CROSS-ORIGIN ISOLATION. The program runs in a worker that shares its memory with the page',
    '(SharedArrayBuffer), which a browser allows only in a cross-origin isolated page. Either:',
    '  - your server sends these three headers for the folder:',
    ...H.map((h) => `      ${h}`),
    '    _headers does it on Cloudflare Pages and Netlify, .htaccess on Apache; for nginx:',
    ...H.map((h) => `      add_header ${h.split(': ')[0]} ${h.split(': ')[1]};`),
    '  - or it does not, and web/coi-sw.js, a service worker, adds them: the first visit reloads',
    '    once. That needs HTTPS (or localhost).',
    '',
    'IN AN IFRAME. A frame is isolated only if the page around it is too: the page holding the',
    'iframe must send the same COOP/COEP headers, and the frame must be allowed to be isolated:',
    `  <iframe src="<this folder>/${run}"`,
    '          allow="cross-origin-isolated; fullscreen; autoplay; gamepad" width="800" height="600"></iframe>',
    'On a page that cannot send those headers (most blogs), link to the folder instead.',
    '',
    'LICENCES. The folder holds the licences of the program and of its data (licenses/), and the',
    'source its build was made from (sources/, or the release its README names): keep them with it.',
    '',
  ].join('\n'));
  console.log(`  standalone: ${p.title} in ${OUT} (index.html, HOSTING.txt)`);
}
