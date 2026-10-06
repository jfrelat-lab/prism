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
import { loadTarget, targetUnits, moduleExportsOf } from '../src/target.js';

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
      const [file, variant] = name.split(':');
      headers(res, TYPES['.json']);
      try {
        const target = loadTarget(join(ROOT, 'targets', `${file}.json`), variant || null);
        let resolved = variant || !target.default
          ? target : loadTarget(join(ROOT, 'targets', `${file}.json`), target.default);
        /*
         * A target whose build depends on WHAT IS ASKED OF IT. MAME links 959 games to play one;
         * its target names a module that knows which of the makefile's archives hold a given game
         * (`light`), and the page says which game its command line starts with (`subject`). The
         * module answers with a smaller target of the same shape, or null -- an unknown name, a
         * switch such as -listcrc -- and then the whole build is what is served.
         */
        const subject = (url.searchParams.get('subject') || '').replace(/[^A-Za-z0-9_]/g, '');
        if (resolved.light?.module && subject) {
          const light = (await import(join(ROOT, resolved.light.module)))[resolved.light.export ?? 'lightFor'](subject);
          if (light) resolved = { ...light, name: resolved.name };
        }
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
          /*
           * Files the INSTALLATION provides, as against the ones the player does. Quake II's
           * linux/vid_so.c reads /etc/quake2.conf to find its ref libraries; on a real box the
           * package put it there, and it is neither game data nor a source change.
           */
          files: resolved.files ?? {},
          tree: resolved.tree ?? null,
          // Which shell branch presents it; a variant may set its own.
          host: resolved.host ?? null,
          // What a light build is made of, for the page to say: archives, cores, units of how many.
          lightOf: resolved.lightOf ?? null,
          args: resolved.args ?? null,
          // A variant's frame-rate cap, when its renderer is not the one the descriptor was paced for.
          fps: resolved.fps ?? null,
          modules: Object.fromEntries(Object.entries(resolved.modules ?? {})
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, m]) => [k, { soname: m.soname ?? null }])),
          /*
           * What each module EXPORTS, resolved here. The list comes from the program's own .def
           * file -- Quake II ships ref_soft.def -- and a browser has no way to read one, so the
           * server answers with the same function Node's build uses rather than the page growing a
           * second reader of the format.
           */
          moduleExports: moduleExportsOf(resolved, dir),
          asm,
          /*
           * The assembly the target asks to be TRANSLATED, as repository paths the page can fetch.
           * `asm` above is a different list -- the assembly stems that had no C twin, which is a
           * report about the build. This one is an instruction, and Jump 'n Bump is why it exists:
           * its tree defines get_block and put_block nowhere but dos/gfx.S, so a browser that cannot
           * reach that file cannot draw anything at all.
           */
          // A gas entry is an object; its file is relative to the tree like a NASM name's.
          asmTranslate: (resolved.asmTranslate ?? []).map(f => (typeof f === 'string'
            ? `${rel(dir)}/${f}` : { ...f, file: `${rel(dir)}/${f.file}`, inTree: f.file })),
          /*
           * Whole Turbo Assembler modules and the object files the project links (Keen Dreams,
           * Catacomb 3-D): the module list as the target names it, every assembler source in the
           * tree -- a module INCLUDEs by name, case-insensitively as DOS did -- and each data
           * object with the repo path the page fetches. src/target.js builds the same blocks.
           */
          tasm: resolved.tasm ?? [],
          tasmFiles: (resolved.tasm?.length ? readdirSync(dir) : [])
            .filter(f => /\.(asm|equ|inc)$/i.test(f)).map(f => `${rel(dir)}/${f}`),
          dataObjects: (resolved.dataObjects ?? []).map((o) => {
            const name = o.object ?? o.file;
            const found = readdirSync(dirname(join(dir, name)))
              .find(f => f.toLowerCase() === name.replace(/^.*\//, '').toLowerCase());
            return { ...o, path: found ? `${rel(dirname(join(dir, name)))}/${found}` : null };
          }),
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
