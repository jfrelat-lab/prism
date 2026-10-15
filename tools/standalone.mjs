// standalone.mjs — one program as a folder anyone can put on their own site.
//
//   node tools/standalone.mjs <id> [--out=<dir>] [--games=<dir>] [--sources=release[:<tag>]]
//
// <id> is an entry of tools/site-programs.json, shipped or in its gallery (doom, heretic, quake...).
// The folder is a static export of that program alone (tools/site.mjs --standalone): its build, its
// data when it may be passed on, its licences and the source of its build, the player, and an
// index.html of its own with a Play button. HOSTING.txt in it says how to serve it, and why an iframe
// needs the page around it to be cross-origin isolated too. Default output: dist/standalone/<id>/.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const id = process.argv[2];
if (!id || id.startsWith('-')) { console.error('usage: node tools/standalone.mjs <id> [--out=<dir>] [--games=<dir>] [--sources=release[:<tag>]]'); process.exit(2); }
const site = join(dirname(fileURLToPath(import.meta.url)), 'site.mjs');
const r = spawnSync('node', [site, `--standalone=${id}`, ...process.argv.slice(3)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
