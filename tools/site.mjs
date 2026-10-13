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

const shipped = [];
const targets = new Map();
const dataRoots = new Map();      // root -> Set of files under it
let total = 0;
for (const e of entries) {
  const desc = JSON.parse(readFileSync(join(ROOT, 'web/programs', `${e.program}.json`), 'utf8'));
  const tname = e.variant ? `${desc.target.split(':')[0]}:${e.variant}` : desc.target;
  console.log(`${e.id}: ${tname}`);

  // The build, as a bundle. Once per target: two shelf entries of one program share it.
  if (!targets.has(tname)) {
    const [file, variant] = tname.split(':');
    const target = loadTarget(join(ROOT, 'targets', `${file}.json`), variant || null);
    const name = variant ? `${target.name}-${variant}` : target.name;
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
    targets.set(tname, { title: answer.title, units: answer.units.length, functions: b.functions });
  }

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
    licences.push({ name: l.name, href: rel });
  }
  shipped.push({ ...e, target: tname, licences, machine: e.machine });
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

// The picker's answers: only what is shipped, all present.
write('__static/targets.json', JSON.stringify({ targets: [...new Set([...targets.keys()].map((t) => t.split(':')[0]))].map((name) => {
  const variants = [...targets.keys()].filter((t) => t.startsWith(`${name}:`)).map((t) => ({ name: t.split(':')[1], host: null, web: true, args: null }));
  return { name, title: targets.get(name)?.title ?? name, variants, present: true };
}) }));

// The shelf: each machine keeps only the shipped entries, in the manifest's order; an empty machine goes.
const machines = JSON.parse(readFileSync(join(ROOT, 'web/machines.json'), 'utf8'));
const want = new Set(shipped.map((s) => `${s.machine}\0${s.program}\0${s.variant ?? ''}`));
machines.machines = machines.machines.map((m) => ({ ...m, programs: m.programs.filter((p) => want.has(`${m.id}\0${p.program}\0${p.variant ?? ''}`)) }))
  .filter((m) => m.programs.length);
write('web/machines.json', JSON.stringify(machines, null, 1));

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
  programs: shipped.map(({ licenseFiles, ...s }) => ({ ...s, units: targets.get(s.target)?.units ?? null,
    run: `web/?machine=${encodeURIComponent(s.machine)}&program=${encodeURIComponent(s.variant ? s.file ?? s.program : s.program)}${s.args !== undefined ? `&args=${encodeURIComponent(s.args)}` : ''}&run=1` })),
}, null, 1));
console.log(`\n${shipped.length} programs, ${targets.size} builds, ${mb(total)} of bundles, assembly and data in ${OUT}`);
