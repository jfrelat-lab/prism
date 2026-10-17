// rosetta.mjs — what PRISM does with Rosetta Code's C solutions, measured.
//
//   node tools/rosetta.mjs                 fetch what is not cached yet, then compile and run every block
//   node tools/rosetta.mjs --fetch-only    only the download
//   node tools/rosetta.mjs --tasks=100     the first N tasks (alphabetical), for a quick look
//   node tools/rosetta.mjs --task="Hello world/Text"
//   node tools/rosetta.mjs --no-native     skip the comparison with the host's cc
//
// THE LICENCE DECIDES THE SHAPE. Rosetta Code's content, code included, is under the GNU FDL
// (rosettacode.org/wiki/Rosetta_Code:Copyrights), which does not mix with PRISM's MIT tree. So the
// sources are fetched into .oracle/rosetta/ (gitignored, never published) and what this writes to
// dist/rosetta/index.json is PRISM's own measurements: a task's title, the block's place in its C
// section, the environment its includes ask for, and what happened. A page that shows a solution
// fetches it from Rosetta Code itself, with its licence and its authors.
//
// THE DOWNLOAD is polite and resumable: one request at a time, a pause between them, a User-Agent
// that says who asks, and every answer cached, so a second run asks for nothing it already has.
// Per task, two small requests: the section list, then the C section alone (a whole task page is
// every language, 157 KB for Hello world/Text).
//
// THE RUN: each block in its own process (tools/rosetta.mjs --one), so a loop that never ends is a
// timeout and not a hung tool. No arguments, empty standard input. With the host's cc available,
// the same block is built natively and the two outputs are compared: "same output" is the only
// verdict that says right rather than ran (a program printing the time or a random number differs
// by nature, and is counted apart only by what it printed).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n) => process.argv.includes(`--${n}`);

// ---------------------------------------------------------------- one block, in a child process
if (process.argv[2] === '--one') {
  const { compile, builtinHeaderResolver } = await import('../src/compile.js');
  const file = process.argv[3];
  let m;
  try {
    m = compile(readFileSync(file, 'latin1'), { file: basename(file), resolve: builtinHeaderResolver() });
  } catch (e) {
    process.stdout.write(JSON.stringify({ phase: 'compile', err: String(e.message ?? e).split('\n')[0].slice(0, 300) }));
    process.exit(0);
  }
  try {
    const r = m.run();
    process.stdout.write(JSON.stringify({ phase: 'ran', code: r.code, stdout: r.stdout }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ phase: 'run', err: String(e.message ?? e).split('\n')[0].slice(0, 300) }));
  }
  process.exit(0);
}

/*
 * --build <env> <file>: a block that asks for a graphical environment, built the way a target is
 * (src/target.js), with the environment PRISM has for it. Step 1 is the BUILD only: compiled and
 * linked, or which units failed and which functions nothing defines. Running it needs a screen.
 */
const ENV_TARGET = {
  glut: { env: ['stdio', 'tz', 'gl', 'glut', 'glu'] },
  gl: { env: ['stdio', 'tz', 'gl', 'glut', 'glu'] },
  sdl: { env: ['stdio', 'tz', 'sdl12'] },
  sdl2: { env: ['stdio', 'tz', 'sdl2'] },
  x11: { env: ['stdio', 'tz', 'x11'] },
  // The Win32 shim is C compiled with the program, as Hexen II and WinQuake have it: win32.c is the
  // window and expects win32-net.c's pump beside it (targets/hexen2.json).
  win32: { env: ['stdio', 'tz', 'wsock', 'vgafont'], generated: ['src/env/wide.c', 'src/env/inttypes.c', 'src/env/win32-app.c', 'src/env/win32-net.c', 'src/env/win32.c'] },
};
if (process.argv[2] === '--build') {
  const { buildTarget } = await import('../src/target.js');
  const [, , , env, file] = process.argv;
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const target = { name: 'rosetta', dir: dirname(file).slice(root.length + 1), units: { list: [basename(file)] },
    compile: { memory: 64, collect: true }, ...ENV_TARGET[env] };
  try {
    const t = buildTarget(target, { root });
    const p = t.program ?? t;
    const failures = (p.failures ?? []).map((f) => `${f.fn ? `${f.fn}: ` : ''}${String(f.message ?? f.error ?? JSON.stringify(f)).split('\n')[0]}`.slice(0, 200));
    // A header the build could not find is a failure too: it says which library is missing.
    if (t.missingHeaders?.length) failures.unshift(`missing header ${t.missingHeaders.join(', ')}`);
    // Only what the PROGRAM asks for: the shim's own units leave names for a real program to define
    // (PuTTY defines its COM GUIDs), and those say nothing about this one.
    // windows.h declares the COM GUIDs a real program's own sources define (PuTTY's do): any unit
    // that includes it lists them, used or not.
    const mine = (u) => (!u.units || u.units.some((x) => x === basename(file))) && !/^(CLSID|IID)_/.test(u.name ?? '');
    const undef = [...new Set([...(p.undefined ?? []), ...(p.undefinedVars ?? [])].filter(mine).map((u) => u.name ?? String(u)))];
    process.stdout.write(JSON.stringify({ phase: failures.length ? 'compile' : undef.length ? 'unresolved' : 'built', err: failures[0] ?? null, undefined: undef }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ phase: 'compile', err: String(e.message ?? e).split('\n')[0].slice(0, 300), undefined: [] }));
  }
  process.exit(0);
}

const API = 'https://rosettacode.org/w/api.php';
const UA = 'PRISM-rosetta-survey/1.0 (C compiler compatibility measurement; https://github.com/jfrelat-lab/prism)';
const CACHE = join(ROOT, '.oracle', 'rosetta');
const OUT = join(ROOT, 'dist', 'rosetta');
const PAUSE_MS = 400;
mkdirSync(join(CACHE, 'tasks'), { recursive: true });
mkdirSync(join(CACHE, 'blocks'), { recursive: true });
mkdirSync(OUT, { recursive: true });
const RUN = join(CACHE, 'run');
mkdirSync(RUN, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (t) => t.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) + '-' + createHash('sha1').update(t).digest('hex').slice(0, 8);
async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) { await sleep(PAUSE_MS); return r.json(); }
    if (attempt >= 3) throw new Error(`${r.status} for ${url}`);
    await sleep(5000 * (attempt + 1));   // a 429 or a 5xx: back off and ask again
  }
}

// ---------------------------------------------------------------- the task list
async function taskList() {
  const file = join(CACHE, 'category-C.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const titles = [];
  let cont = {};
  do {
    const d = await api({ action: 'query', list: 'categorymembers', cmtitle: 'Category:C', cmlimit: '500', cmnamespace: '0', ...cont });
    titles.push(...d.query.categorymembers.map((m) => m.title));
    cont = d.continue ?? null;
    process.stdout.write(`\rtask list: ${titles.length}`);
  } while (cont);
  console.log();
  titles.sort();
  writeFileSync(file, JSON.stringify(titles));
  return titles;
}

/** The task's C section as wikitext, or null when it has none; cached. */
async function cSection(title) {
  const file = join(CACHE, 'tasks', `${slug(title)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const s = await api({ action: 'parse', page: title, prop: 'sections' });
  // The language header is level 2 and reads "C" -- not "C++", "C sharp", "Objective-C".
  const sec = s.parse?.sections?.find((x) => x.level === '2' && x.line.trim() === 'C');
  let entry = { title, revid: s.parse?.revid ?? null, wikitext: null };
  if (sec) {
    const w = await api({ action: 'parse', page: title, prop: 'wikitext|revid', section: sec.index });
    entry = { title, revid: w.parse?.revid ?? null, wikitext: w.parse?.wikitext ?? null };
  }
  writeFileSync(file, JSON.stringify(entry));
  return entry;
}

// ---------------------------------------------------------------- blocks and their environment
/** Each C code block of a section, with the subsection it sits under and the library notes before it. */
function blocks(wikitext) {
  const out = [];
  let sub = '', libs = [];
  const re = /^(={3,})\s*(.*?)\s*\1\s*$|\{\{\s*libheader\s*\|\s*([^}|]+)|<(syntaxhighlight|lang)\b([^>]*)>([\s\S]*?)<\/\4>/gm;
  for (const m of wikitext.matchAll(re)) {
    if (m[1]) { sub = m[2].replace(/\{\{[^}]*\}\}/g, '').trim(); libs = []; continue; }
    if (m[3]) { libs.push(m[3].trim()); continue; }
    const lang = (/lang\s*=\s*"?([\w+#-]+)/.exec(m[5])?.[1] ?? (m[4] === 'lang' ? m[5].trim().split(/\s/)[0] : '')).toLowerCase();
    if (lang !== 'c') continue;   // output listings and other languages' snippets are not programs
    out.push({ sub, libs: [...libs], code: m[6].replace(/^\n/, '') });
  }
  return out;
}

/*
 * The environment a block asks for, from its own includes first -- the code is the most reliable
 * witness -- and from Rosetta's {{libheader}} notes for what an include does not name.
 */
const ENVS = [
  ['win32', /^\s*#\s*include\s*[<"](windows|winuser|wingdi|commctrl)\.h[>"]/im],
  ['sdl2', /^\s*#\s*include\s*[<"]SDL2\/SDL\.h[>"]/im],
  ['sdl', /^\s*#\s*include\s*[<"](SDL\/)?SDL\.h[>"]/im],
  ['glut', /^\s*#\s*include\s*[<"]GL\/(glut|freeglut)\.h[>"]/im],
  ['gl', /^\s*#\s*include\s*[<"](GL|OpenGL)\/gl\.h[>"]/im],
  ['x11', /^\s*#\s*include\s*[<"]X11\/Xlib\.h[>"]/im],
  ['gtk', /^\s*#\s*include\s*[<"](gtk\/gtk|glib)\.h[>"]/im],
  ['pthreads', /^\s*#\s*include\s*[<"]pthread\.h[>"]/im],
  ['curses', /^\s*#\s*include\s*[<"]n?curses\.h[>"]/im],
  ['openmp', /^\s*#\s*(include\s*[<"]omp\.h[>"]|pragma\s+omp)/im],
  ['gmp', /^\s*#\s*include\s*[<"]gmp\.h[>"]/im],
  ['sockets', /^\s*#\s*include\s*[<"](sys\/socket|netdb|arpa\/inet|winsock2?)\.h[>"]/im],
  ['posix', /^\s*#\s*include\s*[<"](unistd|sys\/\w+|dirent|termios|fcntl|signal)\.h[>"]/im],
];
const envOf = (b) => ENVS.find(([, re]) => re.test(b.code))?.[0]
  ?? (b.libs.some((l) => /win(32|dows)/i.test(l)) ? 'win32' : b.libs.length ? `lib:${b.libs[0]}` : 'console');
/*
 * What a block reads besides its code. Both sides run with an empty standard input and no files, so a
 * program that waits for a key loops or times out on both, and one that reads unixdict.txt prints
 * whatever its failure path does: neither says anything about the compiler. They are counted apart.
 */
const inputOf = (code) => (/\b(scanf|getchar|getch|getline|gets)\s*\(|\bf(gets|scanf|getc|read)\s*\([^;]*\bstdin\b/.test(code) ? 'stdin'
  : /\bfopen\s*\(/.test(code) ? 'file' : null);
const hasMain = (code) => /\bmain\s*\(/.test(code) || /\bWinMain\s*\(/.test(code);

// ---------------------------------------------------------------- run
const NATIVE = !flag('no-native') && spawnSync('cc', ['--version']).status === 0;
/** A child process with a wall-clock limit: { code, stdout, stderr, timedOut }. Output kept as bytes read as latin1. */
/*
 * PRISM's side answers in JSON, which is UTF-8 on the wire: read as latin1 like a program's raw bytes,
 * every character above 0x7f came back encoded twice and a correct "°" was counted as a difference.
 * A native program runs as `prog`, the argv[0] PRISM gives: a usage line that prints its own name
 * differed by the build directory's path alone.
 */
function child(cmd, args, ms, { json = false } = {}) {
  return new Promise((resolve) => {
    // In a folder of their own: Rosetta's file tasks create, rename and delete files where they run.
    const c = spawn(cmd, args, { cwd: RUN, argv0: json ? undefined : 'prog', stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let size = 0, timedOut = false;
    c.stdout.on('data', (d) => { if ((size += d.length) < 64 << 20) out.push(d); });
    c.stderr.on('data', (d) => err.push(d));
    const t = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, ms);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, timedOut, stdout: Buffer.concat(out).toString(json ? 'utf8' : 'latin1'), stderr: Buffer.concat(err).toString('utf8') }); });
    c.on('error', () => { clearTimeout(t); resolve({ code: -1, timedOut, stdout: '', stderr: 'spawn failed' }); });
  });
}
async function native(file) {
  const exe = file.replace(/\.c$/, '.native');
  const c = await child('cc', ['-w', '-O0', '-o', exe, file, '-lm'], 60000);
  if (c.code !== 0) return { built: false };
  const r = await child(exe, [], 10000);
  return { built: true, timedOut: r.timedOut, code: r.code, stdout: r.stdout };
}
async function prism(file) {
  const r = await child(process.execPath, [SELF, '--one', file], 20000, { json: true });
  if (r.timedOut) return { phase: 'timeout' };
  try { return JSON.parse(r.stdout); } catch { return { phase: 'crash', err: r.stderr.split('\n').find((l) => l.trim()) ?? `exit ${r.code}` }; }
}
// The native side outputs latin1 bytes; PRISM's stdout is a JS string of the same bytes.
const JOBS = +(arg('jobs') ?? Math.max(1, availableParallelism() - 2));

const all = await taskList();
const only = arg('task');
const tasks = only ? [only] : all.slice(0, arg('tasks') ? +arg('tasks') : all.length);
console.log(`${all.length} tasks in Category:C; ${tasks.length} to look at`);

// The download first, one request at a time; then the runs, several at once.
const results = [], jobs = [];
let fetched = 0;
for (const [i, title] of tasks.entries()) {
  const cached = existsSync(join(CACHE, 'tasks', `${slug(title)}.json`));
  const entry = await cSection(title);
  if (!cached) fetched++;
  process.stdout.write(`\rtasks ${i + 1}/${tasks.length} (${fetched} fetched now, the rest cached)`);
  const bs = entry.wikitext ? blocks(entry.wikitext) : [];
  bs.forEach((b, n) => {
    const env = envOf(b);
    const row = { task: title, revid: entry.revid, block: n, sub: b.sub, env, input: inputOf(b.code), lines: b.code.split('\n').length };
    if (!hasMain(b.code)) { results.push({ ...row, status: 'fragment' }); return; }
    // PRISM runs console programs here; the others are counted by what they need, not attempted.
    if (ENV_TARGET[env] && !flag('no-envs')) { jobs.push({ row, code: b.code, env, file: join(CACHE, 'blocks', `${slug(title)}-${n}.c`) }); return; }
    if (env !== 'console' && env !== 'posix') { results.push({ ...row, status: 'needs-env' }); return; }
    if (flag('envs-only')) return;   // --envs-only: the graphical ones alone, into the partial index
    jobs.push({ row, code: b.code, file: join(CACHE, 'blocks', `${slug(title)}-${n}.c`) });
  });
}
console.log();
if (flag('fetch-only')) process.exit(0);

let done = 0;
async function work(j) {
  writeFileSync(j.file, j.code, 'latin1');
  if (j.env) {
    const r = await child(process.execPath, [SELF, '--build', j.env, j.file], 120000, { json: true });
    let b = null;
    try { b = JSON.parse(r.stdout); } catch { b = { phase: r.timedOut ? 'timeout' : 'crash', err: r.stderr.split('\n').find((l) => l.trim()) ?? null, undefined: [] }; }
    const status = { built: 'env-builds', unresolved: 'env-unresolved', compile: 'env-compile-error' }[b.phase] ?? `env-${b.phase}`;
    results.push({ ...j.row, status, err: b.err, undefined: b.undefined });
    process.stdout.write(`\rran ${++done}/${jobs.length} blocks, ${JOBS} at a time`);
    return;
  }
  const [p, nat] = await Promise.all([prism(j.file), NATIVE ? native(j.file) : null]);
  let status = p.phase === 'ran' ? 'runs' : p.phase === 'compile' ? 'compile-error' : p.phase === 'run' ? 'run-error' : p.phase;
  if (status === 'runs' && nat?.built && !nat.timedOut) status = nat.stdout === p.stdout ? 'same-output' : 'output-differs';
  if (nat && !nat.built && status === 'compile-error') status = 'native-fails-too';
  results.push({ ...j.row, status, err: p.err ?? null, nativeBuilt: nat?.built ?? null });
  process.stdout.write(`\rran ${++done}/${jobs.length} blocks, ${JOBS} at a time`);
}
const queue = [...jobs];
await Promise.all(Array.from({ length: JOBS }, async () => { while (queue.length) await work(queue.shift()); }));
console.log();
results.sort((a, b) => a.task.localeCompare(b.task) || a.block - b.block);

// ---------------------------------------------------------------- the report
const count = (k) => results.reduce((m, r) => (m[r[k]] = (m[r[k]] ?? 0) + 1, m), {});
const byStatus = count('status'), byEnv = count('env');
// The verdicts that speak about the compiler, on the programs that need neither input nor files.
const selfContained = results.filter((r) => !r.input && r.status !== 'fragment' && r.status !== 'needs-env');
const byStatusSelf = selfContained.reduce((m, r) => (m[r.status] = (m[r.status] ?? 0) + 1, m), {});
const errs = {};
for (const r of results.filter((x) => x.status === 'compile-error' || x.status === 'run-error')) {
  // Group messages by their shape: names and numbers out, so one missing function is one line.
  const k = `${r.status}: ${r.err.replace(/'[^']*'/g, "'…'").replace(/\b\d+\b/g, 'N').replace(/^[^:]*:\d+:(\d+:)?\s*/, '')}`;
  errs[k] = (errs[k] ?? 0) + 1;
}
// A partial run (--task, --tasks) must not replace the survey a page reads.
const INDEX = join(OUT, only || arg('tasks') || flag('envs-only') ? 'index-partial.json' : 'index.json');
writeFileSync(INDEX, JSON.stringify({
  note: 'PRISM\'s measurements on Rosetta Code\'s C solutions. No Rosetta Code content: a solution is under the GNU FDL and is read from rosettacode.org, with its authors.',
  date: new Date().toISOString(), native: NATIVE, tasks: tasks.length, blocks: results.length, byStatus, byStatusSelf, byEnv, results,
}, null, 1));
const show = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`).join('\n');
console.log(`\n${results.length} C blocks in ${tasks.length} tasks\n\nby status\n${show(byStatus)}\n\nby status, the ${selfContained.length} that read neither input nor files\n${show(byStatusSelf)}\n\nby environment\n${show(byEnv)}`);
const top = Object.entries(errs).sort((a, b) => b[1] - a[1]);
console.log(`\nthe ${Math.min(25, top.length)} most frequent failures, of ${top.length} kinds\n${top.slice(0, 25).map(([k, v]) => `  ${String(v).padStart(5)}  ${k.slice(0, 150)}`).join('\n')}`);
console.log(`\n${INDEX}`);
