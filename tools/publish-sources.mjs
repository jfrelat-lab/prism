// publish-sources.mjs — the source archives of a static export, as the assets of a GitHub release.
//
//   node tools/site.mjs --sources=release[:<tag>]     the export links to the release; this lists it
//   node tools/publish-sources.mjs [--dry-run]         then this creates it, with gh
//
// tools/site.mjs writes dist/site-sources/release.json: the repository, the tag, and the files -- each
// source tree's archive as it was fetched, build-scripts.tar.gz, the README and SHA256SUMS. This uploads them
// as they are. A tag that already exists is refused rather than overwritten: an export's pages link to
// its release, and changing the files under a published link would change the source a build claims.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const at = join(ROOT, 'dist', 'site-sources', 'release.json');
if (!existsSync(at)) { console.error('no dist/site-sources/release.json: run node tools/site.mjs --sources=release first'); process.exit(1); }
const rel = JSON.parse(readFileSync(at, 'utf8'));
const dry = process.argv.includes('--dry-run');

const missing = rel.files.filter((f) => !existsSync(f));
if (missing.length) { console.error(`missing: ${missing.join(', ')}`); process.exit(1); }
const mb = rel.files.reduce((t, f) => t + statSync(f).size, 0) / 1048576;
console.log(`${rel.repo} release ${rel.tag}: ${rel.files.length} files, ${mb.toFixed(1)} MB, PRISM ${rel.commit.slice(0, 12)}${rel.dirty ? ' (built from a working tree with uncommitted changes)' : ''}`);
for (const f of rel.files) console.log(`  ${basename(f)}`);
if (rel.dirty) console.log('warning: the export was built from uncommitted changes, so the commit its README links is not exactly what built it');
if (dry) process.exit(0);

const gh = (...args) => spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (gh('release', 'view', rel.tag, '--repo', rel.repo).status === 0) {
  console.error(`${rel.repo} already has a release ${rel.tag}; export again with --sources=release:<another tag>`);
  process.exit(1);
}
const r = gh('release', 'create', rel.tag, ...rel.files, '--repo', rel.repo, '--title', `Sources of the PRISM site, ${rel.tag}`,
  '--notes-file', rel.files.find((f) => basename(f) === 'README.txt'));
process.stdout.write(r.stdout); process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
