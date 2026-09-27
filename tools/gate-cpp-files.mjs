// gate-cpp-files.mjs — the cpp gate on WHOLE FILES from the corpus. Bar: identical token stream.
//
// `tools/gate-cpp.mjs` compares self-contained snippets, deliberately: it tests the preprocessor and
// nothing else. This tests the preprocessor on what it is actually asked to do — a real translation
// unit of a real program, with a real include path, thousands of macros deep.
//
// The whole difficulty is making the comparison MEAN something, and it is one thing:
//
//   **gcc must be given PRISM's headers, not its own.**
//
// Otherwise the diff is glibc's `stdio.h` against PRISM's `stdio.h`, which says nothing about
// preprocessing. So the headers are written to disk, gcc runs with `-nostdinc` so it cannot reach
// its own, and `-undef` so it predefines nothing — then PRISM's TARGET_DEFINES are handed to it as a
// prelude header, which is exactly the set PRISM starts from. Both sides then see the same text and
// the same initial macro table, and every difference is a preprocessing difference.
//
//   node tools/gate-cpp-files.mjs [--verbose] [--limit=N] [filter]

import { sh, SCRATCH, version } from './oracle.mjs';
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { Preprocessor } from '../src/cpp/cpp.js';
import { tokenize } from '../src/cpp/lexer.js';
import { EOF } from '../src/cpp/token.js';
import { HEADERS } from '../src/env/headers.js';
import { TARGET_DEFINES, mergeDefines } from '../src/compile.js';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const VERBOSE = process.argv.includes('--verbose');
const LIMIT = +(process.argv.find(a => a.startsWith('--limit='))?.slice(8) ?? 8);
const FILTER = process.argv.slice(2).find(a => !a.startsWith('--')) ?? null;

/*
 * The targets, and the defines each build passes. These are the same values the corresponding tool
 * in tools/ passes -- a gate that preprocessed a program differently from the way it is built would
 * be testing a configuration nobody compiles.
 */
const TARGETS = [
  { name: 'doom', dir: join(ROOT, 'corpus/DOOM/linuxdoom-1.10'), defines: {} },
  { name: 'heretic', dir: join(ROOT, 'corpus/Heretic'), defines: { __WATCOMC__: '1100', __386__: '1' } },
  { name: 'hexen', dir: join(ROOT, 'corpus/Hexen'), defines: { __WATCOMC__: '1100', __386__: '1' } },
  // The same -I list tools/mame.mjs passes; a gate that used a different one would be testing
  // a build nobody performs.
  { name: 'mame', dir: join(ROOT, 'corpus/mame05/src'), defines: { LSB_FIRST: '1' }, incs: ['Z80', 'msdos'] },
  { name: 'quake', dir: join(ROOT, 'corpus/Quake/WinQuake'), defines: {} },
].filter(t => existsSync(t.dir));

if (!TARGETS.length) {
  skip('no corpus present; nothing to compare', 'fetch any target with the `fetch` line of its targets/*.json');
}

// --- PRISM's headers, on disk, where gcc can read them.
const work = join(SCRATCH, 'cppfiles');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const inc = join(work, 'inc');
for (const [name, text] of Object.entries(HEADERS)) {
  const full = join(inc, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

/**
 * PRISM's own predefined macros, as a header gcc can `-include`.
 *
 * A prelude rather than a hundred `-D` flags, because several values contain spaces
 * (`__SIZE_TYPE__` is `unsigned int`) and quoting them through a shell inside a container is a
 * source of silent difference. A `#define` emits nothing under `-P`, so the prelude is invisible in
 * the output.
 */
function preludeFor(defines) {
  const all = mergeDefines(TARGET_DEFINES, defines);
  const lines = [];
  for (const [k, v] of Object.entries(all)) {
    if (v === null) continue;                                  // null means UNDEFINE
    lines.push(v === '' ? `#define ${k}` : `#define ${k} ${v}`);
  }
  return lines.join('\n') + '\n';
}

/*
 * Copy each source tree into the oracle's bind mount.
 *
 * The container sees only `.oracle`, so gcc cannot read the corpus where it lives -- and copying has
 * a second benefit worth more than the convenience: both sides then read the SAME bytes off the same
 * files, so an encoding or line-ending difference cannot masquerade as a preprocessing one.
 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from)) {
    const src = join(from, e);
    const st = statSync(src);
    if (st.isDirectory()) copyTree(src, join(to, e));
    else if (/\.(c|h|equ|inc|def|q1|q2)$/i.test(e)) writeFileSync(join(to, e), readFileSync(src));
  }
}
for (const t of TARGETS) {
  t.copy = join(work, `src-${t.name}`);
  copyTree(t.dir, t.copy);
}

// --- collect the cases
const cases = [];
for (const t of TARGETS) {
  const files = readdirSync(t.copy).filter(f => /\.c$/i.test(f)).sort().slice(0, LIMIT);
  for (const f of files) {
    const name = `${t.name}/${f}`;
    if (FILTER && !name.includes(FILTER)) continue;
    cases.push({ name, target: t, file: join(t.copy, f) });
  }
}

// Lay the sources out and write each target's prelude once.
for (const t of TARGETS) writeFileSync(join(work, `prelude-${t.name}.h`), preludeFor(t.defines));
cases.forEach((c, n) => { c.id = n; });

console.log(version().split('\n')[0]);
console.log(`${cases.length} translation units from ${TARGETS.length} programs\n`);

/** gcc's search: for a quoted include the including file's directory first, then the -I list. */
const stubbed = new Set();
function makeResolve(t) {
  const dirs = [t.copy, ...(t.incs ?? []).map(d => join(t.copy, d)), inc];
  return (name, angled, fromFile) => {
    const search = (!angled && fromFile) ? [dirname(fromFile), ...dirs] : dirs;
    for (const d of search) {
      const full = join(d, name);
      if (existsSync(full) && statSync(full).isFile()) {
        return { path: full, text: readFileSync(full, 'latin1') };
      }
      // The corpus mixes cases in its #includes (`DoomDef.h` for `DOOMDEF.H`), which DOS never had
      // to forgive. gcc is given the same directories and the same problem.
      if (!existsSync(d)) continue;
      const hit = readdirSync(d).find(f => f.toLowerCase() === basename(name).toLowerCase());
      if (hit && statSync(join(d, hit)).isFile()) {
        return { path: join(d, hit), text: readFileSync(join(d, hit), 'latin1') };
      }
    }
    /*
     * A header neither side has becomes an EMPTY one, and the same empty file is then written where
     * gcc will find it. Without this gcc refuses the unit outright and half the corpus is unusable
     * as a comparison; with it both sides read the same nothing, and what is compared is still
     * purely preprocessing.
     */
    stubbed.add(name);
    return { path: `<stub:${name}>`, text: '' };
  };
}

/*
 * PRISM first, so the headers it had to stub are known before gcc runs.
 */
for (const c of cases) {
  try {
    const pp = new Preprocessor({
      defines: mergeDefines(TARGET_DEFINES, c.target.defines),
      resolve: makeResolve(c.target),
    });
    c.mine = pp.run(readFileSync(c.file, 'latin1'), c.file);
  } catch (e) {
    c.threw = e.message;
  }
}
for (const name of stubbed) {
  const full = join(inc, name);
  mkdirSync(dirname(full), { recursive: true });
  if (!existsSync(full)) writeFileSync(full, '');
}
if (stubbed.size) console.log(`${stubbed.size} headers neither side has, stubbed empty for both: ` +
  `${[...stubbed].sort().join(' ')}\n`);

/*
 * -nostdinc so gcc cannot reach its own headers, -undef so it predefines nothing, and the prelude
 * for what PRISM predefines. The include path is the source's own directory then PRISM's headers,
 * which is the order every tool in tools/ resolves in.
 */
// Paths as the container sees them: the bind mount is `.oracle` -> /work.
const rel = (p) => '/work/' + p.replace(SCRATCH + '/', '');
const script = cases.map((c) =>
  // `-x c` because Heretic and Hexen name their sources `.C` in upper case, and gcc dispatches on
  // the extension: an uppercase .C is C++, and every one of them was skipped with a puzzling
  // "cannot execute cc1plus" until the flag was added.
  `echo "===CASE ${c.id}"; gcc -E -P -std=gnu89 -w -x c -nostdinc -undef ` +
  `-include ${rel(join(work, `prelude-${c.target.name}.h`))} ` +
  `-I${rel(c.target.copy)} ` +
  `${(c.target.incs ?? []).map(d => `-I${rel(join(c.target.copy, d))} `).join('')}` +
  // The blank echo matters: gcc's output does not always end in a newline, and without one the
  // ===RC marker glues itself to the last line, the regex misses it, and the whole case vanishes as
  // "no oracle output" -- which reads like a missing result rather than a harness bug.
  `-I${rel(inc)} ${rel(c.file)} 2>&1; rc=$?; echo; echo "===RC $rc"`).join('; ');
const r = sh(script, { timeout: 1800000 });

const chunks = new Map();
{
  let cur = null, buf = [];
  for (const line of r.stdout.split('\n')) {
    let m = line.match(/^===CASE (\d+)$/);
    if (m) { cur = +m[1]; buf = []; continue; }
    m = line.match(/^===RC (\d+)$/);
    if (m) { chunks.set(cur, { rc: +m[1], text: buf.join('\n') }); cur = null; continue; }
    if (cur !== null) buf.push(line);
  }
}

/*
 * Token text, with the two sides' paths made comparable.
 *
 * `__FILE__` expands to a path, and the two sides read the same files through different roots -- the
 * host sees `.oracle/cppfiles/...`, the container sees `/work/cppfiles/...`. Normalising is not
 * papering over a difference: the path a compiler reports is the path it was given, and both were
 * given the same file. What must match is which FILE it names, and that survives.
 */
const normalisePaths = (v) => String(v)
  .replace(/\/work\/cppfiles\//g, '@/')
  .split(SCRATCH + '/cppfiles/').join('@/');
const strip = (toks) => toks.filter(t => t.k !== EOF).map(t => `${t.k}:${normalisePaths(t.v)}`);
const lex = (text) => strip(tokenize(text, { file: '<gcc>' }).tokens);

let pass = 0, skipped = 0;
const fails = [];
for (const c of cases) {
  const ref = chunks.get(c.id);
  if (!ref) { fails.push({ c, why: 'no oracle output' }); continue; }
  if (ref.rc !== 0) {
    // gcc refusing a unit is a fact about the unit, not about PRISM -- the corpus contains files no
    // build compiles. Skipped and counted, never silently dropped.
    skipped++;
    if (VERBOSE) console.log(`- ${c.name}: gcc refused it (${ref.text.split('\n')[0].slice(0, 80)})`);
    continue;
  }
  if (c.threw) { fails.push({ c, why: `PRISM threw: ${c.threw}` }); continue; }
  const mine = strip(c.mine);
  const theirs = lex(ref.text);
  if (mine.length === theirs.length && mine.every((t, i) => t === theirs[i])) {
    pass++;
    if (VERBOSE) console.log(`✓ ${c.name} (${mine.length} tokens)`);
    continue;
  }
  let at = 0;
  while (at < mine.length && at < theirs.length && mine[at] === theirs[at]) at++;
  fails.push({
    c,
    why: `token ${at} of ${theirs.length}: gcc ${theirs.slice(at, at + 6).join(' ')}\n` +
      `${' '.repeat(24)}PRISM ${mine.slice(at, at + 6).join(' ')}`,
  });
}

for (const f of fails) console.log(`✗ ${f.c.name}\n    ${f.why}`);
console.log(`\n${pass}/${cases.length - skipped} whole translation units match gcc -E exactly` +
  (skipped ? ` (${skipped} skipped: gcc refused them)` : ''));
process.exit(fails.length ? 1 : 0);
