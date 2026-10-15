// build-cache.js — a target compiled once, loaded again when nothing it was made of has changed.
//
// A gate or a tool that runs a program several times used to compile it every time: ScummVM 0.10.0's
// 536 units take some twenty seconds, and gate-scummvm010 built them once per game. buildTarget now
// keeps what compileProgram made -- the snapshot a static bundle is (P13.1: the emitted JavaScript,
// the linked memory image, the link tables) and the compiler's reports (what was not emitted, what
// is unresolved, which headers were missing) -- in <root>/.oracle/build-cache/, and loads it instead
// of compiling when the KEY matches and every header the compile read still reads the same.
//
// The key is the hash of everything that decides the output:
//   - PRISM's own source, every file under src/ -- the compiler, the runtime, the environments and
//     the headers they supply. Any change to PRISM makes every entry stale; that is the point.
//   - the target's description, whole (units, defines, include paths, compile options, envs);
//   - each unit's name, text, per-unit defines and module;
//   - the options buildTarget hands compileProgram.
// The headers a compile read are recorded as the resolver answered them (name, angled, from, hash)
// and REPLAYED through a fresh resolver before an entry is used: a header edited, or a new file
// that now shadows one, is a miss.
//
// Not cached, compiled as before: a build that links assembly, TASM modules, shared modules or data
// objects, a paged build (its snapshot is refused), and a caller that wants the freshly compiled
// program itself (onProgram, as tools/bundle.mjs). PRISM_BUILD_CACHE=0 turns it off.
//
// Every change to src/ makes every key new, so stale entries pile up: past CAP bytes the least
// recently used go (a hit touches its entry). ScummVM 0.10.0's entry is some 55 MB.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
let srcHash = null;
/** The hash of every file under src/, once a process. */
export function prismHash() {
  if (srcHash) return srcHash;
  const h = createHash('sha256');
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else { h.update(p.slice(SRC.length)); h.update('\0'); h.update(readFileSync(p)); h.update('\0'); }
    }
  };
  walk(SRC);
  srcHash = h.digest('hex');
  return srcHash;
}

const sha = (text) => createHash('sha256').update(text).digest('hex');
/** JSON with sorted keys, functions and typed arrays left out: the same object, the same string. */
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) && !ArrayBuffer.isView(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : typeof x === 'function' ? undefined : x));

export const cacheEnabled = () => process.env.PRISM_BUILD_CACHE !== '0';

/** The key of a build: PRISM, the target, its units, the compile options. */
export function buildKey(target, units, options) {
  const h = createHash('sha256');
  h.update(prismHash());
  h.update(stable(target));
  for (const u of units) { h.update(u.file); h.update('\0'); h.update(u.source); h.update('\0'); h.update(stable({ defines: u.defines ?? null, module: u.module ?? null })); }
  h.update(stable(options));
  return h.digest('hex');
}

/** A resolver that records what it answered: [name, angled, from, hash of the text]. */
export function recordingResolver(resolve) {
  const seen = [];
  const r = (name, angled, from) => {
    const hit = resolve(name, angled, from);
    seen.push([name, !!angled, from ?? null, hit ? sha(hit.text) : null]);
    return hit;
  };
  r.seen = seen;
  return r;
}

const dirOf = (root) => join(root, '.oracle', 'build-cache');
const CAP = 2 * 1024 ** 3;

/** The least recently used entries removed until the directory is under CAP. */
function prune(dir) {
  const entries = new Map();
  for (const f of readdirSync(dir)) {
    const m = /^([0-9a-f]{64})\.(json|bin|js)$/.exec(f);
    if (!m) continue;
    const st = statSync(join(dir, f)), e = entries.get(m[1]) ?? { size: 0, used: 0 };
    e.size += st.size;
    if (m[2] === 'json') e.used = st.mtimeMs;
    entries.set(m[1], e);
  }
  let total = [...entries.values()].reduce((a, e) => a + e.size, 0);
  for (const [key, e] of [...entries].sort((a, b) => a[1].used - b[1].used)) {
    if (total <= CAP) break;
    for (const ext of ['json', 'bin', 'js']) rmSync(join(dir, `${key}.${ext}`), { force: true });
    total -= e.size;
  }
}

/** The cached build for `key`, if every header it read still reads the same through `resolve`. */
export function loadCached(root, key, resolve) {
  const base = join(dirOf(root), key);
  if (!existsSync(`${base}.json`)) return null;
  let entry;
  try { entry = JSON.parse(readFileSync(`${base}.json`, 'utf8')); } catch { return null; }
  for (const [name, angled, from, hash] of entry.headers) {
    const hit = resolve(name, angled, from);
    if ((hit ? sha(hit.text) : null) !== hash) return null;
  }
  const now = new Date();
  try { utimesSync(`${base}.json`, now, now); } catch { /* used, even if the touch fails */ }
  return { ...entry, image: new Uint8Array(readFileSync(`${base}.bin`)), src: readFileSync(`${base}.js`, 'utf8') };
}

/** Keep a build: its snapshot, its reports and the headers it read. Written whole or not at all. */
export function storeCached(root, key, { meta, image, src }, reports, headers) {
  const dir = dirOf(root);
  mkdirSync(dir, { recursive: true });
  const base = join(dir, key), tmp = `${base}.${process.pid}`;
  writeFileSync(`${tmp}.bin`, image);
  writeFileSync(`${tmp}.js`, src);
  writeFileSync(`${tmp}.json`, JSON.stringify({ meta, reports, headers }));
  // The .json last: an entry is only read through it, so a half-written one is never found.
  renameSync(`${tmp}.bin`, `${base}.bin`);
  renameSync(`${tmp}.js`, `${base}.js`);
  renameSync(`${tmp}.json`, `${base}.json`);
  prune(dir);
}
