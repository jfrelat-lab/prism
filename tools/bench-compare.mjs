// bench-compare.mjs — where PRISM stands: the same C and C++ programs, built and run several ways.
//
//   node tools/bench-compare.mjs [--only=nbody,fasta] [--runs=3] [--docker-runs=1] [--skip=docker-i386]
//
// The programs are The Computer Language Benchmarks Game's (benchmarksgame-team.pages.debian.net,
// revised BSD), in corpus/bench/benchmarksgame/src -- one C and one C++ variant of each, the plainest
// that is single-threaded and uses no SIMD intrinsics, so every solution compiles the same source.
// The arguments are smaller than the Game's own, so the slow solutions finish: what is compared is
// each solution against the others on the same work, not against the Game's published figures.
//
// The solutions, each measured on what it is for:
//   native      clang / clang++ -O2 on this host (arm64): the reference.
//   docker-i386 gcc / g++ -O2 in the oracle container, a linux/386 image -- EMULATED on an arm64 host,
//               so it is what running an old x86 binary costs here, not native x86 speed.
//   prism       PRISM in Node: the compile is PRISM's own front end to JavaScript; the run is the
//               emitted JavaScript under V8. Its size is what a static bundle ships (JS + memory image).
//   emscripten  emcc / em++ -O2, run in Node, when emsdk is installed (~/Projects/emsdk).
//
// Every run's stdout is hashed: a solution whose output differs from the native one is reported, and
// its time is not a comparison. Times are wall-clock, best of --runs. Results go to
// dist/bench-compare/results.json, with the machine and every toolchain's version.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { cpus, totalmem } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const SRC = join(ROOT, 'corpus/bench/benchmarksgame/src');
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** The programs: the Game's name, the argument used here, and the C and C++ variant files. */
export const PROGRAMS = [
  { id: 'nbody', what: 'double-precision N-body simulation', arg: '5000000', c: 'nbody/nbody.gcc', cpp: 'nbody/nbody.gpp' },
  { id: 'spectralnorm', what: 'eigenvalue by the power method', arg: '2000', c: 'spectralnorm/spectralnorm.gcc-8.gcc', cpp: 'spectralnorm/spectralnorm.gpp' },
  { id: 'fannkuchredux', what: 'indexed access to a tiny integer sequence', arg: '10', c: 'fannkuchredux/fannkuchredux.gcc', cpp: 'fannkuchredux/fannkuchredux.gpp-3.gpp' },
  { id: 'mandelbrot', what: 'Mandelbrot set, a 1-bit bitmap', arg: '2000', c: 'mandelbrot/mandelbrot.gcc-8.gcc', cpp: 'mandelbrot/mandelbrot.gpp-3.gpp' },
  { id: 'binarytrees', what: 'allocate and free many binary trees', arg: '16', c: 'binarytrees/binarytrees.gcc', cpp: 'binarytrees/binarytrees.gpp-2.gpp' },
  { id: 'fasta', what: 'generate and write random DNA sequences', arg: '2500000', c: 'fasta/fasta.gcc', cpp: 'fasta/fasta.gpp' },
];

// ---- one PRISM build and run, in a process of its own so each starts with a cold JIT
if (process.argv[2] === '--prism-one') {
  const [, , , file, lang, a] = process.argv;
  const { compileProgram, snapshotProgram } = await import('../src/compile.js');
  const { installStdio } = await import('../src/env/stdio.js');
  const { HEADERS } = await import('../src/env/headers.js');
  const resolve = (name) => { const std = HEADERS[name] ?? HEADERS[name.replace(/^.*\//, '')]; return std === undefined ? null : { path: `<${name}>`, text: std }; };
  const unit = `/bench/${basename(file).replace(/\.(gcc|gpp)$/, lang === 'cpp' ? '.cpp' : '.c')}`;
  let out;
  try {
    const t0 = performance.now();
    let snap = null;
    const prog = compileProgram([{ file: unit, source: readFileSync(file, 'latin1') }], { resolve, memory: 512 * 1024 * 1024 });
    const compileMs = performance.now() - t0;
    try { snap = snapshotProgram(prog); } catch { /* sizes unknown */ }
    installStdio(prog.M, {});
    const t1 = performance.now();
    const r = prog.run(['bench', a]);
    const runMs = performance.now() - t1;
    const js = snap ? Buffer.from(snap.src) : null, img = snap ? Buffer.from(snap.image) : null;
    out = { ok: true, compileMs, runMs, stdout: sha(Buffer.from(String(r.stdout), 'latin1')),
      bytes: js ? js.length + img.length : null, gz: js ? gzipSync(js).length + gzipSync(img).length : null };
  } catch (e) { out = { ok: false, error: String(e.message).split('\n')[0].slice(0, 200) }; }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const only = arg('only')?.split(',');
const skip = new Set(arg('skip')?.split(',') ?? []);
const RUNS = +(arg('runs') ?? 3);
// The emulated x86 column is ~100x native: one run decides it, and three cost the better part of an hour.
const DOCKER_RUNS = +(arg('docker-runs') ?? 1);
if (!existsSync(SRC)) { console.error(`no ${SRC}: the Benchmarks Game sources (benchmarksgame-sourcecode.zip) unpacked there`); process.exit(77); }
const WORK = join(ROOT, '.oracle', 'bench-compare');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
// The Game's C is written for Linux: <malloc.h> is glibc's, and macOS keeps it as <malloc/malloc.h>. A
// header of that name for the native build only -- a platform's missing header, not an edit to a program.
mkdirSync(join(WORK, 'compat'), { recursive: true });
writeFileSync(join(WORK, 'compat', 'malloc.h'), '#include <stdlib.h>\n#include <malloc/malloc.h>\n');
// Emscripten writes CommonJS, and the repository's package.json says ES modules: this directory says otherwise.
writeFileSync(join(WORK, 'package.json'), '{ "type": "commonjs" }\n');

const run = (cmd, opts = {}) => spawnSync('sh', ['-c', cmd], { encoding: 'buffer', maxBuffer: 1 << 28, ...opts });
const best = (fn, runs = RUNS) => { let b = null; for (let k = 0; k < runs; k++) { const r = fn(); if (!r.ok) return r; if (!b || r.runMs < b.runMs) b = r; } return b; };
const timed = (cmd) => { const t0 = performance.now(); const r = run(cmd); return { r, ms: performance.now() - t0 }; };

/** One native-style solution: a compile command and a run command, timed from here. */
function solutionNative(p, lang, file) {
  const exe = join(WORK, `${p.id}-${lang}-native`);
  const cc = lang === 'cpp' ? `clang++ -O2 -std=c++17 -w -x c++` : `clang -O2 -w -x c`;
  const c = timed(`${cc} -I${join(WORK, 'compat')} -o ${exe} ${file} -lm 2>&1`);
  if (c.r.status !== 0) return { ok: false, error: String(c.r.stdout).split('\n')[0] };
  const size = statSync(exe).size, gz = gzipSync(readFileSync(exe)).length;
  return best(() => {
    const t = timed(`${exe} ${p.arg}`);
    return t.r.status === 0 ? { ok: true, compileMs: c.ms, runMs: t.ms, bytes: size, gz, stdout: sha(t.r.stdout) } : { ok: false, error: `exit ${t.r.status}` };
  });
}

/** gcc in the linux/386 container: compile and run timed INSIDE it, so docker exec's own cost is left out. */
function solutionDocker(p, lang, file) {
  const { sh } = DOCKER;
  const name = `${p.id}-${lang}`;
  writeFileSync(join(WORK, `${name}.${lang === 'cpp' ? 'cpp' : 'c'}`), readFileSync(file));
  const cc = lang === 'cpp' ? 'g++ -O2 -std=gnu++17 -w' : 'gcc -O2 -w';
  const ms = (cmd) => `s=$(date +%s%N); ${cmd}; e=$?; t=$(date +%s%N); echo "@@ $e $(( (t - s) / 1000 ))" >&2`;
  const c = sh(`cd bench-compare && ${ms(`${cc} -o ${name}.i386 ${name}.${lang === 'cpp' ? 'cpp' : 'c'} -lm`)}`, { timeout: 600000 });
  const cm = c.stderr.match(/@@ (\d+) (\d+)/);
  if (!cm || cm[1] !== '0') return { ok: false, error: (c.stdout + c.stderr).split('\n')[0] };
  const exe = join(WORK, `${name}.i386`), size = statSync(exe).size, gz = gzipSync(readFileSync(exe)).length;
  return best(() => {
    const r = sh(`cd bench-compare && ${ms(`./${name}.i386 ${p.arg} > ${name}.out`)}`, { timeout: 1800000 });
    const m = r.stderr.match(/@@ (\d+) (\d+)/);
    if (!m || m[1] !== '0') return { ok: false, error: `exit ${m?.[1] ?? '?'}` };
    return { ok: true, compileMs: +cm[2] / 1000, runMs: +m[2] / 1000, bytes: size, gz, stdout: sha(readFileSync(join(WORK, `${name}.out`))) };
  }, DOCKER_RUNS);
}

function solutionPrism(p, lang, file) {
  return best(() => {
    const r = spawnSync('node', [SELF, '--prism-one', file, lang, p.arg], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 1800000 });
    try { return JSON.parse(r.stdout); } catch { return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).split('\n')[0] }; }
  });
}

const EMSDK = join(process.env.HOME, 'Projects/emsdk');
const EMCC = join(EMSDK, 'upstream/emscripten/emcc');
// emsdk wants Python 3.10 or later, which macOS does not ship: Homebrew's, when it is there.
if (!process.env.EMSDK_PYTHON && existsSync('/opt/homebrew/opt/python@3.12/bin/python3.12')) process.env.EMSDK_PYTHON = '/opt/homebrew/opt/python@3.12/bin/python3.12';
function solutionEmscripten(p, lang, file) {
  const js = join(WORK, `${p.id}-${lang}-em.js`), wasm = js.replace(/\.js$/, '.wasm');
  const cc = lang === 'cpp' ? `${EMCC.replace(/emcc$/, 'em++')} -std=c++17 -x c++` : `${EMCC} -x c`;
  const c = timed(`${cc} -O2 -w -sALLOW_MEMORY_GROWTH -sENVIRONMENT=node -sEXIT_RUNTIME=1 --pre-js ${join(ROOT, 'tools/bench/em-stdout.js')} -o ${js} ${file} 2>&1`);
  if (c.r.status !== 0) return { ok: false, error: String(c.r.stdout).split('\n').find((l) => /error/.test(l)) ?? 'compile failed' };
  const size = statSync(js).size + (existsSync(wasm) ? statSync(wasm).size : 0);
  const gz = gzipSync(readFileSync(js)).length + (existsSync(wasm) ? gzipSync(readFileSync(wasm)).length : 0);
  return best(() => {
    const t = timed(`node ${js} ${p.arg}`);
    return t.r.status === 0 ? { ok: true, compileMs: c.ms, runMs: t.ms, bytes: size, gz, stdout: sha(t.r.stdout) } : { ok: false, error: `exit ${t.r.status}` };
  });
}

let DOCKER = null;
const SOLUTIONS = [
  ['native', solutionNative],
  ['docker-i386', solutionDocker],
  ['prism', solutionPrism],
  ['emscripten', solutionEmscripten],
].filter(([n]) => !skip.has(n))
  .filter(([n]) => n !== 'emscripten' || existsSync(EMCC));
if (SOLUTIONS.some(([n]) => n === 'docker-i386')) DOCKER = await import('./oracle.mjs');

const version = (cmd) => String(run(cmd).stdout).split('\n')[0].trim();
const env = {
  date: new Date().toISOString(),
  host: `${String(run('sysctl -n machdep.cpu.brand_string').stdout).trim() || cpus()[0]?.model}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GiB`,
  node: process.version,
  native: version('clang --version'),
  'docker-i386': DOCKER ? DOCKER.sh('gcc --version | head -1').stdout.trim() + ' (linux/386, emulated)' : null,
  prism: version(`git -C ${ROOT} log -1 --format='%h %ad' --date=short`),
  emscripten: existsSync(EMCC) ? version(`${EMCC} --version`) : null,
};
/*
 * PRISM's RUNTIME, which its bundles do not include: the page loads it once for every program, where
 * an Emscripten .js carries its own. Measured as all of src/ and the worker, each file gzipped as a
 * server would send it -- an upper bound, since a page loads the environments its program names.
 */
{
  let bytes = 0, gz = 0, files = 0;
  const walkGz = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const q = join(d, f.name); if (f.isDirectory()) walkGz(q); else if (/\.(js|c|h)$/.test(f.name)) { const b = readFileSync(q); bytes += b.length; gz += gzipSync(b).length; files++; } } };
  walkGz(join(ROOT, 'src'));
  for (const f of ['web/worker.js', 'web/endpoints.js']) { const b = readFileSync(join(ROOT, f)); bytes += b.length; gz += gzipSync(b).length; files++; }
  env.prismRuntime = { files, bytes, gz };
}
console.log(Object.entries(env).filter(([, v]) => v && typeof v === 'string').map(([k, v]) => `${k}: ${v}`).join('\n'), '\n');

const results = [];
for (const p of PROGRAMS.filter((x) => !only || only.includes(x.id))) {
  for (const lang of ['c', 'cpp']) {
    const file = join(SRC, p[lang]);
    const row = { program: p.id, what: p.what, lang, source: p[lang], arg: p.arg, solutions: {} };
    for (const [name, fn] of SOLUTIONS) {
      const r = fn(p, lang, file);
      row.solutions[name] = r;
      process.stdout.write(`${p.id.padEnd(14)} ${lang.padEnd(4)} ${name.padEnd(12)} ${r.ok ? `compile ${r.compileMs.toFixed(0).padStart(6)} ms  run ${r.runMs.toFixed(0).padStart(7)} ms  ${r.bytes ? `${(r.bytes / 1024).toFixed(0)} KiB` : ''}` : `-- ${r.error}`}\n`);
    }
    results.push(row);
  }
}
const OUT = join(ROOT, 'dist/bench-compare');
mkdirSync(OUT, { recursive: true });
// --only and --skip re-measure part of the table: what this run measured replaces the same program,
// language and solution in the results already there, and the rest is kept.
let all = results;
if ((only || arg('skip')) && existsSync(join(OUT, 'results.json'))) {
  const prev = JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8')), before = prev.results ?? [];
  // A skipped solution's version line stays the one it was measured with.
  for (const [k, v] of Object.entries(prev.env ?? {})) if (env[k] == null || skip.has(k)) env[k] = v;
  const key = (r) => `${r.program}/${r.lang}`, fresh = new Map(results.map((r) => [key(r), r]));
  all = [...before.filter((r) => !fresh.has(key(r))), ...before.filter((r) => fresh.has(key(r))).map((r) => {
    const n = fresh.get(key(r)); fresh.delete(key(r)); return { ...n, solutions: { ...r.solutions, ...n.solutions } };
  }), ...fresh.values()]
    .sort((a, b) => PROGRAMS.findIndex((p) => p.id === a.program) - PROGRAMS.findIndex((p) => p.id === b.program) || a.lang.localeCompare(b.lang));
}
// Compared with native's output once the table is whole: a solution kept from an earlier run is checked too.
for (const row of all) {
  const ref = row.solutions.native?.stdout;
  for (const [name, r] of Object.entries(row.solutions)) {
    delete r.sameOutput;
    if (r.ok && ref && r.stdout !== ref) { r.sameOutput = false; console.log(`   ⚠ ${row.program} ${row.lang} ${name}'s output differs from native: its time is not a comparison`); }
  }
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ env, runs: RUNS, dockerRuns: DOCKER_RUNS, results: all }, null, 1));
console.log(`\n${join(OUT, 'results.json')}`);
