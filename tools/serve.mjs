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
//   node tools/serve.mjs [--port=8080] [--data=<dir>] [--games=<dir>]

import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetAnswer } from './target-answer.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const port = +(process.argv.find(a => a.startsWith('--port='))?.slice(7) ?? 8080);
// --data may be given more than once, or comma-separated: a program's data and another's do not
// collide, because each file keeps its path relative to the directory it came from (pacman/... and
// id1/...), and one server can then feed every program in the picker.
const dataDirs = process.argv.filter(a => a.startsWith('--data='))
  .flatMap(a => a.slice(7).split(',')).map(s => s.trim()).filter(Boolean);

/*
 * --games=<dir>: one directory holding one directory per game, each of which becomes a data root.
 *
 * The distinction matters and it is not cosmetic. A data root is the directory a program believes it
 * was STARTED IN: Quake opens `id1/pak0.pak`, Quake II opens `baseq2/pak0.pak`, MAME opens
 * `pacman/pacman.6e`. Handing the whole games directory over as ONE root would make those
 * `quake/id1/pak0.pak` and nothing would be found -- so each subdirectory is its own root, and the
 * flag is a shorthand for listing them, not a new kind of thing.
 *
 * A name beginning with `_` is skipped, which is how two copies of one file are kept without
 * serving both: `_spare/` holds the one that is not in use. Two roots offering the same relative
 * path collide -- the page keys data files by that path -- so this is a real rule, not tidiness.
 */
for (const a of process.argv.filter(x => x.startsWith('--games='))) {
  const root = a.slice(8).trim();
  if (!root) continue;
  try {
    for (const e of readdirSyncSafe(root)) {
      if (e.startsWith('_') || e.startsWith('.')) continue;
      dataDirs.push(join(root, e));
    }
  } catch { console.error(`--games: cannot read ${root}`); }
}
const dataDir = dataDirs[0];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  /* A program's own assembly, for a target that names it in asmTranslate. src/asm/ is pure JS, so
     the browser translates the same .S file Node does rather than fetching a pre-built artefact. */
  '.s': 'text/plain; charset=utf-8',
  /* An XPM is C, not an image format the browser should be asked to decode: it is a
     `char *name[] = { ... }` an X11 program #includes to embed its icon. */
  '.xpm': 'text/plain; charset=utf-8',
  /* A program's own icon, from its own source tree: the Windows shelf points an <img> straight at
     it, and a browser decodes ICO natively. Without the type it arrives as application/octet-stream
     and Chrome will not decode it -- the desktop then draws four empty labels and looks broken. */
  '.ico': 'image/x-icon',
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

/** Immediate subdirectories, or nothing if the path is not a directory. */
/*
 * A STATIC BUNDLE of a target (tools/bundle.mjs), offered to the page when one is in dist/ and is
 * not older than the compiler that wrote it: a bundle is emitted code, and code emitted by an older
 * src/ is a different program. Stale or absent, the page compiles from source as it always has.
 */
function freshBundle(name) {
  try {
    const at = statSync(join(ROOT, "dist", `${name}.js`)).mtimeMs;
    statSync(join(ROOT, "dist", `${name}.bin`));
    let newest = 0;
    (function walk(d) {
      for (const f of readdirSync(d)) {
        const p = join(d, f), s = statSync(p);
        if (s.isDirectory()) walk(p); else if (s.mtimeMs > newest) newest = s.mtimeMs;
      }
    })(join(ROOT, "src"));
    return at >= newest ? `dist/${name}` : null;
  } catch { return null; }
}

function readdirSyncSafe(dir) {
  return readdirSync(dir).filter(e => statSync(join(dir, e)).isDirectory());
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
      // `subject`: the first word of the page's command line, for a light build (tools/target-answer.mjs).
      const subject = (url.searchParams.get('subject') || '').replace(/[^A-Za-z0-9_]/g, '');
      headers(res, TYPES['.json']);
      try {
        res.end(JSON.stringify(await targetAnswer(ROOT, name, { subject, bundleFor: freshBundle })));
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
        /*
         * WHICH ROOT a file came from, and only the one asked for.
         *
         * The page used to load every data file the server could see before running anything --
         * ~150 MB for this corpus, most of it another game's. A program's data belongs to a root
         * (Quake's `id1/`, MAME's per-driver directories), the descriptor names that root, and the
         * shell fetches that one when it starts the program. `?root=` is what makes that possible;
         * without it the listing is flat and a file's origin is unrecoverable.
         */
        const want = url.searchParams.get('root');
        const out = [];
        for (const d of dataDirs) {
          const root = d.replace(/\/+$/, '').split('/').pop();
          if (want && root !== want) continue;
          for (const f of await listTree(d).catch(() => [])) out.push({ root, file: f });
        }
        headers(res, TYPES['.json']);
        // `files` stays a flat list of names, because that is what the older page reads.
        res.end(JSON.stringify({ files: out.map(x => x.file), entries: out,
                                 roots: [...new Set(dataDirs.map(d => d.replace(/\/+$/, '').split('/').pop()))] }));
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
