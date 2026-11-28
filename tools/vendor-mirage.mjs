// vendor-mirage.mjs — copy MIRAGE's CPU core into src/vendor/mirage/, at a recorded commit.
//
// PRISM translates source; the bytes a program writes at run time (Wolf3D's compiled scalers) need
// an x86 CPU, and MIRAGE has one held to its own oracles (https://github.com/jfrelat-lab/mirage).
// The page cannot import a sibling checkout, so the core ships here: machine.js and exactly what it
// imports -- the CPU, its recompiler, memory, the FPU, SSE and MMX -- and no device, BIOS or DOS.
// Nothing in src/ loads it unless a target names `x86: { executor: "mirage" }` (src/asm/x86-mirage.js).
//
// The copy is verbatim, so a refresh is this script again, and VENDOR.json says which commit the
// files are and lists them with their hashes; `--check` fails when the copy no longer matches.
//
//   node tools/vendor-mirage.mjs [--from=~/Projects/mirage]     # refresh
//   node tools/vendor-mirage.mjs --check                         # the copy is what VENDOR.json says
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'src', 'vendor', 'mirage');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

if (process.argv.includes('--check')) {
  const v = JSON.parse(readFileSync(join(OUT, 'VENDOR.json'), 'utf8'));
  let bad = 0;
  for (const [f, h] of Object.entries(v.files)) {
    const p = join(OUT, f);
    const ok = existsSync(p) && sha256(readFileSync(p)) === h;
    if (!ok) { bad++; console.log(` BAD  ${f}`); }
  }
  console.log(bad ? `${bad} vendored file(s) differ from VENDOR.json` : `src/vendor/mirage is MIRAGE ${v.commit.slice(0, 7)}, ${Object.keys(v.files).length} files`);
  process.exit(bad ? 1 : 0);
}

const from = (process.argv.find((a) => a.startsWith('--from='))?.slice(7) ?? join(process.env.HOME ?? '', 'Projects', 'mirage')).replace(/^~/, process.env.HOME ?? '');
const src = join(from, 'src');
if (!existsSync(join(src, 'machine.js'))) throw new Error(`no MIRAGE checkout at ${from}`);
const dirty = execFileSync('git', ['-C', from, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim();
if (dirty) throw new Error(`MIRAGE's src/ has uncommitted changes; vendor a commit:\n${dirty}`);
const commit = execFileSync('git', ['-C', from, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const subject = execFileSync('git', ['-C', from, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();

// machine.js and its static and dynamic relative imports, transitively
const seen = new Set();
const walk = (f) => {
  if (seen.has(f)) return;
  seen.add(f);
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/gm)) walk(resolve(dirname(f), m[1]));
  for (const m of s.matchAll(/^\s*import\s*['"](\.[^'"]+)['"]/gm)) walk(resolve(dirname(f), m[1]));
  for (const m of s.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) walk(resolve(dirname(f), m[1]));
};
walk(join(src, 'machine.js'));

if (existsSync(OUT)) for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { recursive: true });
mkdirSync(OUT, { recursive: true });
const files = {};
for (const f of [...seen].sort()) {
  const rel = relative(src, f);
  if (rel.startsWith('..')) throw new Error(`${rel} is outside MIRAGE's src/`);
  const bytes = readFileSync(f);
  mkdirSync(dirname(join(OUT, rel)), { recursive: true });
  writeFileSync(join(OUT, rel), bytes);
  files[rel] = sha256(bytes);
}
writeFileSync(join(OUT, 'LICENSE'), readFileSync(join(from, 'LICENSE')));
writeFileSync(join(OUT, 'VENDOR.json'), `${JSON.stringify({
  _doc: 'MIRAGE\'s CPU core, copied verbatim by tools/vendor-mirage.mjs: machine.js and what it imports. Do not edit here; change MIRAGE and vendor again.',
  repo: 'https://github.com/jfrelat-lab/mirage', commit, subject, files,
}, null, 2)}\n`);
console.log(`vendored MIRAGE ${commit.slice(0, 7)} "${subject}": ${Object.keys(files).length} files -> src/vendor/mirage`);
