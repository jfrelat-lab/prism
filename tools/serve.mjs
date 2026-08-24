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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const port = +(process.argv.find(a => a.startsWith('--port='))?.slice(7) ?? 8080);
const dataDir = process.argv.find(a => a.startsWith('--data='))?.slice(7);

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
      if (!dataDir) { res.writeHead(404).end('no --data directory'); return; }
      if (path === '/__data/') {
        const files = await listTree(dataDir).catch(() => []);
        headers(res, TYPES['.json']);
        res.end(JSON.stringify({ files }));
        return;
      }
      const f = safeJoin(dataDir, path.slice('/__data'.length));
      if (!f) { res.writeHead(403).end('outside the data directory'); return; }
      const body = await readFile(f);
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
  console.log(dataDir ? `data dir      ${dataDir}  (exposed at /__data/)`
    : `data dir      none — pick data files in the page (--data=<dir> to serve one)`);
});
