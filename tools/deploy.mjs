// deploy.mjs — build the static export, check it, and put it on Cloudflare Pages.
//
//   node tools/deploy.mjs                      a preview: https://preview.prism-compiler.pages.dev
//   node tools/deploy.mjs --branch=<name>      a preview under another name: https://<name>.prism-compiler.pages.dev
//   node tools/deploy.mjs --production         https://prism-compiler.pages.dev (a clean tree only)
//   ... --skip-build                           send site/ as it is
//   ... --sources=release[:tag]                passed to site.mjs (the release-day export)
//
// Direct upload, never Cloudflare's Git build: site/ is made of files the repository does not hold
// (the bundle cache, game data, source archives). wrangler must be logged in (npx wrangler login).
//
// A PREVIEW IS LOCKED by the project itself, not by this script: the Pages project's preview
// deployments are behind Cloudflare Access (dashboard: the project's Settings, "Restricted access"),
// so every deployment is plain static files and nothing secret is held here. What this checks after a
// preview deploy is that the lock is really there: an anonymous request must be sent to Access's
// sign-in, not served.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECT = 'prism-compiler';
const WRANGLER = 'wrangler@4.151.1';
const SITE = join(ROOT, 'site');
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n) => process.argv.includes(`--${n}`);
const production = flag('production');
const branch = production ? 'main' : (arg('branch') ?? 'preview');
const die = (msg) => { console.error(`deploy: ${msg}`); process.exit(1); };
const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) die(`${cmd} ${args[0] ?? ''} failed`);
};
const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).stdout.trim();

const dirty = git('status', '--porcelain') !== '';
if (production && dirty) die('production is deployed from a clean tree: commit first (git status shows changes)');

if (!flag('skip-build')) {
  const sources = arg('sources');
  run('node', ['tools/site.mjs', ...(sources ? [`--sources=${sources}`] : [])]);
}
run('node', ['tools/site-check.mjs', SITE]);

const sha = git('rev-parse', 'HEAD'), subject = git('log', '-1', '--format=%s');
run('npx', ['--yes', WRANGLER, 'pages', 'deploy', SITE, `--project-name=${PROJECT}`, `--branch=${branch}`,
  `--commit-hash=${sha}`, `--commit-message=${subject}`, `--commit-dirty=${dirty}`]);

// What a visitor gets: production open and isolated; a preview sent to Cloudflare Access's sign-in.
const url = production ? `https://${PROJECT}.pages.dev/` : `https://${branch}.${PROJECT}.pages.dev/`;
let res = null;
for (let i = 0; i < 10; i++) {
  res = await fetch(url, { redirect: 'manual' }).catch(() => null);
  if (res && (production ? res.status === 200 : res.status !== 200)) break;
  await new Promise((r) => setTimeout(r, 3000));
}
const coep = res?.headers.get('cross-origin-embedder-policy');
if (production) {
  if (res?.status !== 200 || coep !== 'require-corp') die(`${url} answers ${res?.status}, COEP ${coep}: check it before announcing anything`);
  console.log(`\n${url} is live, cross-origin isolated.`);
} else {
  const to = res?.headers.get('location') ?? '';
  if (!(res?.status >= 300 && res?.status < 400 && /cloudflareaccess\.com/.test(to))) {
    die(`${url} answers ${res?.status}${to ? ` -> ${to}` : ''} to an anonymous request: is the project's restricted access still on?`);
  }
  console.log(`\n${url} is up, behind Cloudflare Access.`);
}
