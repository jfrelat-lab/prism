// serve.mjs — the dev server for web/.
//
// It exists for three reasons, none cosmetic:
//
//   1. SharedArrayBuffer is gated behind cross-origin isolation. Without COOP/COEP the shell cannot
//      share the guest's memory with the page, and the whole display strategy collapses.
//   2. The compiler is loaded as unbundled ES modules straight out of src/, so the browser runs the
//      SAME files the Node gates run. There is no build step to drift.
//   3. The corpus is gitignored and lives outside web/; the worker needs a directory listing to know
//      what to fetch, which no static server offers.
//
// Data files (ROM images) are NOT served: the page reads those from a file picker, so copyrighted
// data never travels through this server or into the repository. --data=<dir> exists only because
// re-picking six files by hand on every reload is not a workflow; it exposes a directory the user
// names explicitly, and nothing else.
//
//   node tools/serve.mjs [--port=8080] [--data=<dir>]

import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join, dirname, extname, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, targetUnits } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const port = +(process.argv.find(a => a.startsWith('--port='))?.slice(7) ?? 8080);
// --data may be given more than once, or comma-separated: a program's data and another's do not
// collide, because each file keeps its path relative to the directory it came from (pacman/... and
// id1/...), and one server can then feed every program in the picker.
const dataDirs = process.argv.filter(a => a.startsWith('--data='))
  .flatMap(a => a.slice(7).split(',')).map(s => s.trim()).filter(Boolean);
const dataDir = dataDirs[0];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
};

/** Cross-origin isolation, plus no-store: a cached module during development is a debugging trap. */
function headers(res, type) {
  res.setHeader('Content-Type', type || 'application/octet-stream');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

/** Every path is confined to the repository; a `..` that escapes it is a 403, not a read. */
function safeJoin(base, rel) {
  const p = resolvePath(base, '.' + normalize('/' + rel));
  return p.startsWith(resolvePath(base)) ? p : null;
}

async function listTree(dir, prefix = '', out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) await listTree(join(dir, e.name), `${prefix}${e.name}/`, out);
    else out.push(prefix + e.name);
  }
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);

  try {
    /*
     * A TARGET, resolved.
     *
     * The browser used to carry its own description of every program in web/programs/*.json -- a
     * third schema beside targets/*.json and the harnesses in tools/, and therefore a third thing to
     * keep in step. This server runs in Node, so it can use src/target.js itself: it applies the
     * unit rules (a list, a glob, or the program's own MAKEFILE), the per-unit defines and the
     * generated units, and hands the browser the ANSWER rather than the rules.
     *
     * Sources are not inlined here. The worker already fetches the corpus, and doing it twice would
     * mean the page waiting on one large response instead of many cached small ones.
     */
    if (path === '/__target') {
      const name = (url.searchParams.get('name') || '').replace(/[^A-Za-z0-9_.:-]/g, '');
      const [file, variant] = name.split(':');
      headers(res, TYPES['.json']);
      try {
        const target = loadTarget(join(ROOT, 'targets', `${file}.json`), variant || null);
        const resolved = variant || !target.default
          ? target : loadTarget(join(ROOT, 'targets', `${file}.json`), target.default);
        const { units, dir, asm } = targetUnits(resolved, ROOT);
        const rel = (f) => f.startsWith(ROOT) ? f.slice(ROOT.length + 1) : f;
        res.end(JSON.stringify({
          name: resolved.name,
          title: resolved.title ?? resolved.name,
          dir: rel(dir),
          // A unit is a path to fetch, or -- for the generated and inline ones -- its own source.
          units: units.map(u => (u.source !== undefined && !u.file.startsWith(ROOT)
            ? { file: u.file, source: u.source, defines: u.defines, module: u.module }
            : { file: rel(u.file), defines: u.defines, module: u.module })),
          defines: resolved.defines ?? {},
          include: (resolved.include ?? []).map(d => `${rel(dir)}/${d}`),
          caseInsensitive: !!resolved.caseInsensitive,
          compile: resolved.compile ?? {},
          env: resolved.env ?? ['stdio'],
          // Which shell branch presents it; a variant may set its own.
          host: resolved.host ?? null,
          args: resolved.args ?? null,
          modules: Object.fromEntries(Object.entries(resolved.modules ?? {})
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, m]) => [k, { soname: m.soname ?? null }])),
          asm,
        }));
      } catch (e) {
        res.writeHead(404).end(JSON.stringify({ error: String(e.message) }));
      }
      return;
    }

    /** Which targets exist, for the picker. */
    if (path === '/__targets') {
      const files = (await readdir(join(ROOT, 'targets')).catch(() => []))
        .filter(f => f.endsWith('.json'));
      const out = [];
      for (const f of files) {
        const t = JSON.parse(await readFile(join(ROOT, 'targets', f), 'utf8'));
        /* Each variant as an object: the page needs its host and whether it is meant for a page. */
        const variants = Object.entries(t.variants ?? {})
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => ({ name: k, host: v.host ?? null, web: v.web !== false,
                              args: v.args ?? null }));
        const present = await stat(join(ROOT, t.dir)).then(() => true, () => false);
        out.push({ name: f.replace(/\.json$/, ''), title: t.title ?? t.name, variants, present });
      }
      headers(res, TYPES['.json']);
      res.end(JSON.stringify({ targets: out }));
      return;
    }

    // The listing the worker needs to know what a corpus contains.
    if (path === '/__ls') {
      const dir = safeJoin(ROOT, url.searchParams.get('dir') || '');
      if (!dir) { res.writeHead(403).end('outside the repository'); return; }
      const files = await listTree(dir).catch(() => null);
      if (!files) {
        headers(res, TYPES['.json']);
        res.writeHead(404).end(JSON.stringify({ error: `no such directory`, files: [] }));
        return;
      }
      headers(res, TYPES['.json']);
      res.end(JSON.stringify({ files }));
      return;
    }

    // The opt-in data directory, if the user named one.
    if (path.startsWith('/__data/')) {
      if (!dataDirs.length) { res.writeHead(404).end('no --data directory'); return; }
      if (path === '/__data/') {
        const files = [];
        for (const d of dataDirs) files.push(...await listTree(d).catch(() => []));
        headers(res, TYPES['.json']);
        res.end(JSON.stringify({ files }));
        return;
      }
      // Whichever data directory actually holds it. First match wins, which is why they must not
      // overlap — and they do not, since each program's files live under its own name.
      let body = null;
      for (const d of dataDirs) {
        const f = safeJoin(d, path.slice('/__data'.length));
        if (!f) continue;
        body = await readFile(f).catch(() => null);
        if (body) break;
      }
      if (!body) { res.writeHead(404).end('no such data file'); return; }
      headers(res, 'application/octet-stream');
      res.end(body);
      return;
    }

    // A REDIRECT rather than a rewrite: serving web/index.html at `/` would make its own
    // `./app.js` resolve to `/app.js`, which does not exist. The page's relative imports have to be
    // relative to the directory it really lives in.
    if (path === '/') { res.writeHead(302, { Location: '/web/' }).end(); return; }

    const file = safeJoin(ROOT, path);
    if (!file) { res.writeHead(403).end('outside the repository'); return; }
    let st = await stat(file).catch(() => null);
    if (st && st.isDirectory()) {
      if (!path.endsWith('/')) { res.writeHead(302, { Location: path + '/' }).end(); return; }
      const index = join(file, 'index.html');
      st = await stat(index).catch(() => null);
      if (!st) { res.writeHead(404).end(`no index.html in ${path}`); return; }
      headers(res, TYPES['.html']);
      res.end(await readFile(index));
      return;
    }
    if (!st) { res.writeHead(404).end(`not found: ${path}`); return; }
    headers(res, TYPES[extname(file).toLowerCase()]);
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(500).end(String(e.message));
  }
});

server.listen(port, () => {
  console.log(`PRISM shell:  http://localhost:${port}/`);
  console.log(`serving       ${ROOT}`);
  console.log(dataDirs.length ? `data dirs     ${dataDirs.join('  ')}  (exposed at /__data/)`
    : `data dir      none — pick data files in the page (--data=<dir> to serve one)`);
});
