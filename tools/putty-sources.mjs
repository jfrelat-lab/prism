// PuTTY's build is DATA, so read it rather than transcribe it.
//
//   node tools/putty-sources.mjs <executable>        e.g. test_terminal, puttytel, puttygen
//
// Every CMakeLists.txt in the tree declares its files with `add_sources_from_current_dir(<lib> ...)`
// and each executable names the libraries it links. Hand-copying that into a target file would go
// stale the first time upstream moves a function into its own unit -- which, in PuTTY's utils/, is
// most weeks. So the unit list is COMPUTED, and the target file records the query instead.
//
// The platform is chosen by which platform directory is read: windows/ or unix/, never both. What
// this does NOT do is evaluate CMake's conditionals; `if(HAVE_x)` blocks are taken when the guard is
// listed in ASSUMED below and skipped otherwise, because guessing them silently is how you end up
// linking two definitions of strtoumax and blaming the compiler.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus/putty');
const PLATFORM = process.argv.includes('--unix') ? 'unix' : 'windows';
const WANT = process.argv[2];

/* Guards we answer for. Anything else met inside an if() is reported, not guessed. */
const ASSUMED = new Map([
  ['HAVE_CONPTY', false],          // needs a real ConPTY; not what this target is about
  ['HAVE_STRTOUMAX', true],        // src/env/inttypes.c supplies it, so PuTTY's workarounds stay off
  ['HAVE_WMEMCHR', false],
  ['NOT_UTMP', false],
]);

const OTHER = PLATFORM === 'windows' ? 'unix' : 'windows';
const lists = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (f === '.git' || f === OTHER || f === 'doc' || f === 'icons') continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (f === 'CMakeLists.txt') lists.push(p);
  }
})(SRC);

const libs = new Map();          // library -> [repo-relative .c]
const execs = new Map();         // executable -> { files, libs }
const unknownGuards = new Set();

for (const path of lists) {
  const dir = dirname(path);
  const text = readFileSync(path, 'utf8');
  /* A crude but honest if()-tracker: a stack of "are we taking this branch". */
  let taking = [true];
  const live = () => taking.every(Boolean);
  const guard = (expr) => {
    const neg = /^\s*NOT\s+/i.test(expr);
    const name = expr.replace(/^\s*NOT\s+/i, '').trim();
    let v;
    if (ASSUMED.has(name)) v = ASSUMED.get(name);
    else if (/\bplatform\s+STREQUAL\s+unix\b/.test(name)) v = PLATFORM === 'unix';
    // A HAVE_ guard names a compiler or CPU feature PRISM does not have. Answering these "yes" is
    // how you pull in an AES-NI or NEON unit that cannot possibly compile here, so the default is no.
    else if (/^HAVE_/.test(name)) { v = false; unknownGuards.add(`${name}=no`); }
    else { unknownGuards.add(`${name}=yes`); v = true; }
    return neg ? !v : v;
  };
  /* Commands can span lines, so join first and then split on top-level parens. */
  const flat = text.replace(/#[^\n]*/g, '');
  const re = /(\w+)\s*\(([^()]*)\)/g;
  let m;
  while ((m = re.exec(flat))) {
    const cmd = m[1].toLowerCase(), body = m[2];
    if (cmd === 'if') { taking.push(guard(body)); continue; }
    if (cmd === 'elseif') { taking[taking.length - 1] = !taking[taking.length - 1] && guard(body); continue; }
    if (cmd === 'else') { taking[taking.length - 1] = !taking[taking.length - 1]; continue; }
    if (cmd === 'endif') { taking.pop(); continue; }
    if (!live()) continue;
    const words = body.split(/\s+/).filter(Boolean)
      .map(w => w.replace(/\$\{CMAKE_SOURCE_DIR\}/g, SRC));
    if (cmd === 'add_library') {
      /* The root file declares the libraries themselves; the subdirectories then add to them. */
      const lib = words.shift();
      if (['STATIC', 'OBJECT', 'SHARED', 'INTERFACE'].includes(words[0])) words.shift();
      const files = words.filter(w => w.endsWith('.c'))
        .map(w => relative(SRC, w.startsWith('/') ? w : join(dir, w)));
      libs.set(lib, (libs.get(lib) ?? []).concat(files));
    } else if (cmd === 'add_sources_from_current_dir') {
      const lib = words.shift();
      const files = words.filter(w => w.endsWith('.c'))
        .map(w => relative(SRC, w.startsWith('/') ? w : join(dir, w)));
      libs.set(lib, (libs.get(lib) ?? []).concat(files));
    } else if (cmd === 'add_executable') {
      const name = words.shift();
      execs.set(name, { dir, files: words.filter(w => w.endsWith('.c'))
        .map(w => relative(SRC, w.startsWith('/') ? w : join(dir, w))), libs: [] });
    } else if (cmd === 'target_link_libraries') {
      const name = words.shift();
      if (execs.has(name)) execs.get(name).libs.push(...words.filter(w => !w.startsWith('$')));
    }
  }
}

if (!WANT) {
  console.log(`executables (${PLATFORM}):\n  ${[...execs.keys()].join('\n  ')}`);
  console.log(`\nlibraries:\n  ${[...libs].map(([k, v]) => `${k} (${v.length})`).join('\n  ')}`);
  process.exit(0);
}
const e = execs.get(WANT);
if (!e) { console.error(`no executable "${WANT}" -- run with no argument to list them`); process.exit(2); }
const out = [...e.files];

/*
 * STATIC LIBRARY SEMANTICS, in the one shape PuTTY relies on everywhere.
 *
 * An executable that lists `no-jump-list.c` among its own sources also links the library holding
 * `jump-list.c`. A real link does not take both: the executable's own object already defines the
 * symbols, so the library member is never pulled. Treating the library as "every file in it" gave
 * two definitions of the whole jump-list, storage and timing APIs.
 *
 * Modelling that properly needs symbol tables. What is modelled instead is PuTTY's own naming
 * convention -- `no-X.c` and `noX.c` are the do-nothing versions of `X.c`, in stubs/ and in the
 * platform directories -- and every file it drops is REPORTED, because a heuristic that hides what
 * it did is worse than one that is occasionally wrong.
 */
const shadowed = new Map();
for (const f of e.files) {
  const m = /(^|\/)no-?(.+\.c)$/.exec(f);
  if (m) shadowed.set(m[2], f);
}
const dropped = [];
for (const l of e.libs) {
  if (!libs.has(l)) { console.error(`  ! library ${l} declares no sources`); continue; }
  for (const f of libs.get(l)) {
    if (out.includes(f)) continue;
    const base = f.replace(/^.*\//, '');
    if (shadowed.has(base)) { dropped.push(`${f} (shadowed by ${shadowed.get(base)})`); continue; }
    out.push(f);
  }
}
if (dropped.length) console.error(`not linked, the executable supplies its own:\n  ${dropped.join('\n  ')}`);
console.log(JSON.stringify(out, null, 2));
console.error(`\n${WANT} (${PLATFORM}): ${out.length} units from libraries ${e.libs.join(' ')}`);
if (unknownGuards.size) console.error(`guards taken unconditionally: ${[...unknownGuards].join(' ')}`);
