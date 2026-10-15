// site-check.mjs — what must hold of a static export before it goes on a host.
//
//   node tools/site-check.mjs [<export dir>]      default site/; a standalone folder works too
//   node tools/site-check.mjs --selftest          each check made to fail on a damaged copy
//
// 1. No file over 25 MiB, the most a common static host takes.
// 2. Data only for the programs the export SHIPS (tools/site-programs.json `programs`): a data root
//    of a gallery game -- Quake's, a ROM set -- in data/ would be passing on what is not ours to.
// 3. The source of every build it ships: each archive a program's card names is there and matches
//    sources/SHA256SUMS (or, for an export made with --sources=release, is named in it).
// 4. Each shipped program's licence files are there.
// 5. No path from the host's root in the page's code (web/*.js): an export must work under a path.
// It also lists, without failing, the links to PRISM's own repository, which work once it is public.
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, appendFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const MAX = 25 * 1024 * 1024;

function walk(dir, pre = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]));
}

/** The failures of an export, as strings; the notes are returned beside them. */
export function check(dir) {
  const fail = [], notes = [];
  const files = walk(dir);
  const site = JSON.parse(readFileSync(join(dir, 'web/site.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'tools/site-programs.json'), 'utf8'));

  for (const f of files) if (statSync(join(dir, f)).size > MAX) fail.push(`${f}: over 25 MiB`);

  const shippedRoots = new Set(site.programs.map((p) => {
    const d = JSON.parse(readFileSync(join(ROOT, 'web/programs', `${manifest.programs.find((m) => m.id === p.id)?.program ?? p.program}.json`), 'utf8'));
    return d.needsData?.dir;
  }).filter(Boolean));
  for (const f of files.filter((x) => x.startsWith('data/'))) {
    const root = f.split('/')[1];
    if (!shippedRoots.has(root)) fail.push(`${f}: data of a root no shipped program reads (${root})`);
  }
  for (const f of files.filter((x) => x.startsWith('__static/data/'))) {
    const root = decodeURIComponent(f.slice('__static/data/'.length).replace(/\.json$/, ''));
    if (!shippedRoots.has(root)) fail.push(`${f}: a listing for a root no shipped program reads`);
  }

  const sums = existsSync(join(dir, 'sources/SHA256SUMS'))
    ? new Map(readFileSync(join(dir, 'sources/SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/)).map(([h, n]) => [n, h])) : new Map();
  for (const p of [...site.programs, ...site.gallery.filter((g) => g.run)]) {
    if (!p.sources?.length) { fail.push(`${p.id}: ships a build with no source named`); continue; }
    for (const a of p.sources) {
      if (!sums.has(a.name)) { fail.push(`${p.id}: ${a.name} is not in sources/SHA256SUMS`); continue; }
      if (/^https?:/.test(a.href)) continue;                // a release: checked where it is published
      const at = join(dir, a.href);
      if (!existsSync(at)) { fail.push(`${p.id}: ${a.href} is missing`); continue; }
      const h = createHash('sha256').update(readFileSync(at)).digest('hex');
      if (h !== sums.get(a.name)) fail.push(`${p.id}: ${a.href} does not match its checksum`);
    }
  }

  for (const p of site.programs) {
    if (!p.licences?.length) fail.push(`${p.id}: shipped with no licence file`);
    for (const l of p.licences ?? []) if (!existsSync(join(dir, l.href))) fail.push(`${p.id}: licence ${l.href} is missing`);
  }

  for (const f of files.filter((x) => /^web\/[^/]+\.js$/.test(x))) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const m of text.matchAll(/(?:fetch|import)\(\s*[`'"]\/(?!\/)|src="\/(?!\/)/g)) {
      const line = text.slice(0, m.index).split('\n').length;
      fail.push(`${f}:${line}: a path from the host's root`);
    }
  }

  const repo = files.filter((x) => /\.(html|js|json|txt)$/.test(x) && !x.startsWith('src/') && !x.startsWith('corpus/'))
    .filter((x) => readFileSync(join(dir, x), 'utf8').includes('github.com/jfrelat-lab/prism'));
  if (repo.length) notes.push(`links to PRISM's repository (they work once it is public): ${repo.join(', ')}`);
  return { fail, notes, files: files.length };
}

if (process.argv.includes('--selftest')) {
  /*
   * Each check, made to fail: a copy of site/ (APFS clones it in no time) damaged one way at a time,
   * and the check that should catch it must name it. The undamaged copy must pass first.
   */
  const base = join(ROOT, 'site');
  const DAMAGE = [
    ['a 26 MiB file', (d) => writeFileSync(join(d, 'big.bin'), Buffer.alloc(26 * 1024 * 1024)), /over 25 MiB/],
    ['a gallery game\'s data', (d) => { spawnSync('mkdir', ['-p', join(d, 'data/quake/id1')]); writeFileSync(join(d, 'data/quake/id1/pak0.pak'), 'x'); }, /no shipped program reads \(quake\)/],
    ['a source archive changed', (d) => { const a = readdirSync(join(d, 'sources')).find((f) => f.endsWith('.tar.gz')); appendFileSync(join(d, 'sources', a), 'x'); }, /does not match its checksum/],
    ['a licence file gone', (d) => { const s = JSON.parse(readFileSync(join(d, 'web/site.json'), 'utf8')); rmSync(join(d, s.programs[0].licences[0].href)); }, /licence .* is missing/],
    ['a path from the root', (d) => appendFileSync(join(d, 'web/app.js'), "\nfetch('/data/x');\n"), /a path from the host's root/],
  ];
  let bad = 0;
  const clean = check(base);
  console.log(`${clean.fail.length ? 'FAIL' : 'ok  '} site/ as exported passes (${clean.files} files)${clean.fail.length ? `\n     ${clean.fail.slice(0, 5).join('\n     ')}` : ''}`);
  if (clean.fail.length) bad++;
  for (const [what, damage, expect] of DAMAGE) {
    const d = mkdtempSync(join(tmpdir(), 'prism-site-check-'));
    rmSync(d, { recursive: true });
    spawnSync('cp', ['-cR', base, d]);
    damage(d);
    const r = check(d);
    const caught = r.fail.some((f) => expect.test(f));
    console.log(`${caught ? 'ok  ' : 'FAIL'} control: ${what} is caught${caught ? '' : ` (failures: ${r.fail.slice(0, 3).join('; ') || 'none'})`}`);
    if (!caught) bad++;
    rmSync(d, { recursive: true, force: true });
  }
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] === SELF) {
  const dir = resolve(process.argv.slice(2).find((a) => !a.startsWith('-')) ?? join(ROOT, 'site'));
  const { fail, notes, files } = check(dir);
  for (const f of fail) console.log(`FAIL ${f}`);
  for (const n of notes) console.log(`note ${n}`);
  console.log(fail.length ? `\n${fail.length} problem(s) in ${dir}` : `\n${dir}: ${files} files, ready for a host`);
  process.exit(fail.length ? 1 : 0);
}
