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
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { targetAnswer } from './target-answer.mjs';
import { writeBundle } from './bundle.mjs';
import { loadTarget } from '../src/target.js';
import { targetFile } from '../web/endpoints.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const OUT = resolve(arg('out') ?? join(ROOT, 'site'));
const GAMES = resolve((arg('games') ?? join(homedir(), 'games')).replace(/^~/, homedir()));
const ONLY = arg('only')?.split(',');
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
for (const f of ['index.html', 'LICENSE', 'THIRD-PARTY.md']) copyFileSync(join(ROOT, f), join(OUT, f));
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

/** The build of `tname` as a bundle, its static answers and its assembly; once per target. */
async function bundle(tname, desc) {
  if (targets.has(tname)) return targets.get(tname);
  const [file, variant] = tname.split(':');
  const target = loadTarget(join(ROOT, 'targets', `${file}.json`), variant || null);
  // A file name, not a path: a variant's own name can be "quake/x11".
  const name = tname.replace(/[:/]/g, "-");
  // A descriptor that runs with safepoints needs a bundle built with them, or the page compiles instead.
  const b = writeBundle(target, join(OUT, 'dist'), name, { compile: desc.safepoints ? { safepoints: true } : {} });
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
  const info = { title: answer.title, units: answer.units.length, functions: b.functions, tags: techTags(target, answer, desc) };
  targets.set(tname, info);
  return info;
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
for (const g of manifest.gallery ?? []) {
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
  }
  if (built) gallery.push({ ...rest, target: tname, thumb: `thumbs/${g.id}.png`, tags: [...new Set([...built.tags, ...(g.tags ?? [])])],
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
write('__static/targets.json', JSON.stringify({ targets: [...new Set([...targets.keys()].map((t) => t.split(':')[0]))].map((name) => {
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

write('web/site.json', JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  gallery,
  programs: shipped.map(({ licenseFiles, ...s }) => ({ ...s, units: targets.get(s.target)?.units ?? null,
    run: `web/?machine=${encodeURIComponent(s.machine)}&program=${encodeURIComponent(s.variant ? s.file ?? s.program : s.program)}${s.args !== undefined ? `&args=${encodeURIComponent(s.args)}` : ''}&run=1` })),
}, null, 1));
console.log(`\n${shipped.length} programs, ${targets.size} builds, ${mb(total)} of bundles, assembly and data in ${OUT}`);
