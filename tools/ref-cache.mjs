// ref-cache.mjs — a native reference's output, kept while nothing it was made from has changed.
//
// The references the gates compare against -- Cube built natively and drawn by Mesa, the GL demos on
// Mesa -- run in the i386 oracle container, under emulation: Cube's 300 frames take some 35 s, and a
// gate may ask for several runs. Their output depends only on what goes in -- the native binary, the
// data, the configuration, the input script, the options -- so it is kept in .oracle/ref-cache/
// under the hash of all of that, and given back instead of running again. PRISM_REF_CACHE=0 runs
// every reference.
//
// A caller names its inputs as parts of the key: strings, and Buffers or Uint8Arrays (a binary, a
// file) -- hashed, never trusted by name or date. The container itself is part of every key, as the
// list of the packages installed in it: another Mesa or another gcc is another reference.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, '.oracle', 'ref-cache');
let container = null;
/** What is installed in the oracle container, hashed: once a process. */
async function containerId() {
  if (container) return container;
  const { sh } = await import('./oracle.mjs');
  const r = sh('md5sum /var/lib/dpkg/status');
  if (r.code !== 0) throw new Error(`ref-cache: cannot read the container's package list: ${r.stderr || r.stdout}`);
  container = r.stdout.trim().split(/\s+/)[0];
  return container;
}

/** The hash of every file under `dir`, names and contents, in name order -- version-control metadata left out. */
export function treeHash(dir) {
  const h = createHash('sha256');
  const walk = (d, pre) => {
    for (const f of readdirSync(d).sort()) {
      if (f === '.git' || f === '.svn') continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`);
      else { h.update(`${pre}${f}\0`); h.update(readFileSync(p)); }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

/**
 * `produce()`'s value for these key parts: from the cache when it holds them, else produced and kept.
 * The value must be JSON-able; Uint8Arrays inside it are kept as base64 and given back as Uint8Arrays.
 */
export async function refCached(parts, produce) {
  const h = createHash('sha256');
  h.update(await containerId());
  for (const p of parts) { h.update(typeof p === 'string' ? p : Buffer.from(p.buffer ?? p, p.byteOffset ?? 0, p.byteLength ?? p.length)); h.update('\0'); }
  const file = join(DIR, `${h.digest('hex')}.json`);
  const revive = (_k, v) => (v && v.__u8 ? new Uint8Array(Buffer.from(v.__u8, 'base64')) : v);
  if (process.env.PRISM_REF_CACHE !== '0' && existsSync(file)) {
    try { return { ...JSON.parse(readFileSync(file, 'utf8'), revive), cached: true }; } catch { /* unreadable: produce again */ }
  }
  const value = await produce();
  mkdirSync(DIR, { recursive: true });
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? { __u8: Buffer.from(v).toString('base64') } : v)));
  renameSync(tmp, file);
  return { ...value, cached: false };
}
