// oracle.mjs — the single door to the external truth.
//
// Every PRISM gate asks a REAL 32-bit gcc, never PRISM itself. This host is arm64 macOS with no
// gcc and no -m32, so the toolchain lives in a linux/386 container (tools/oracle/Dockerfile) that
// both compiles AND runs programs — a differential gate needs output, not object files.
//
// The container is long-lived and reused: `docker run` costs ~3.8 s, `docker exec` ~46 ms, and a
// gate makes thousands of calls. Files are exchanged through a bind-mounted scratch dir instead of
// `docker cp`, so Node writes them directly.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SCRATCH = join(ROOT, '.oracle');
const IMAGE = 'prism-oracle';
const NAME = 'prism-oracle';
const CSMITH_INC = '/usr/include/csmith';

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

let ready = false;

/** Something this repository does not ship; tools/gate-preload.mjs turns it into a SKIP. */
function missing(what) {
  return Object.assign(new Error(`${what} -- build it with: npm run oracle:build`), { code: 'PRISM_MISSING' });
}

/** Start the oracle container if it is not already running. Idempotent and cheap to re-call. */
export function up() {
  if (ready) return;
  mkdirSync(SCRATCH, { recursive: true });
  const ps = docker(['ps', '-q', '-f', `name=^${NAME}$`]);
  if (ps.error || ps.status !== 0) throw missing(`no Docker here to run the oracle container (${ps.error?.code ?? ps.stderr.trim()})`);
  const running = ps.stdout.trim();
  if (!running) {
    // A stopped container of the same name would make `run` fail with a name clash.
    docker(['rm', '-f', NAME], { stdio: 'ignore' });
    const r = docker(['run', '-d', '--name', NAME, '--platform', 'linux/386',
      '-v', `${SCRATCH}:/work`, IMAGE, 'sleep', 'infinity']);
    if (r.status !== 0) {
      if (docker(['image', 'inspect', IMAGE], { stdio: 'ignore' }).status !== 0) throw missing(`the oracle image ${IMAGE} is not built`);
      throw new Error(`oracle container failed to start — build it first:\n` +
        `  docker build --platform linux/386 -t ${IMAGE} tools/oracle\n${r.stderr}`);
    }
  }
  ready = true;
}

/**
 * Compile and run something with OPEN WATCOM inside the oracle.
 *
 * A second compiler, and the only one that answers for the toolchain three of the corpus programs
 * were actually built with -- Heretic, Hexen and OpenDUNE are Watcom/DOS4GW programs. `target` is
 * 'linux' (32-bit, hosted, so the result RUNS here) or 'dos16' / 'dos32' (cross-compiled; the
 * result needs an emulator to run, but its LAYOUT can be read without one).
 *
 * Watcom's headers live in two trees and picking the wrong one is a confusing failure: `lh` is the
 * Linux set, `h` is everything else. E1091 "unknown platform" is what a 16-bit compile does when it
 * finds `lh`.
 */
export function watcom(cmd, { target = 'linux' } = {}) {
  const inc = target === 'linux' ? '/opt/watcom/lh' : '/opt/watcom/h';
  return sh(`export INCLUDE=${inc}; ${cmd}`);
}

/**
 * Compile a 16-bit DOS program and RUN it, returning what it printed.
 *
 * The layout oracle above never runs anything, which is enough for sizeof and offsetof and nothing
 * else. This is the other half: Open Watcom builds a real DOS executable in the container, and
 * DOSBox-X -- on the host, because that is where it is installed -- executes it and leaves stdout in
 * a file on the mounted drive.
 *
 * `-silent -fastlaunch -nogui -nomenu` is what makes it headless and `-time-limit` is not optional:
 * a DOS program that waits for a key would otherwise hold the session open for ever, and the first
 * attempt at this hung exactly that way.
 *
 * Returns { code, stdout } where code is DOSBox-X's, not the program's -- DOS's errorlevel does not
 * survive the trip, so a program that must report failure should print it.
 */
export function watcomRun16(source, { model = 'ms', timeout = 30 } = {}) {
  up();
  // A directory of this process's own: tools/gates.mjs runs gates in parallel, and two gates that
  // both build run16.c in one place read each other's programs (gate-abi16 and gate-abi16l did).
  const w = `w16_${process.pid}`;
  mkdirSync(join(SCRATCH, w), { recursive: true });
  put(`${w}/run16.c`, source);
  const build = watcom(`cd /work/${w} && rm -f run16.o RUN16.EXE && ` +
    `wcc -bt=dos -0 -${model} -q run16.c && wlink system dos file run16.o name RUN16.EXE`,
    { target: 'dos16' });
  if (build.code !== 0) throw new Error(`watcomRun16: ${build.stderr || build.stdout}`);

  const dir = join(SCRATCH, w, 'dosrun');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'RUN16.EXE'), readFileSync(join(SCRATCH, w, 'RUN16.EXE')));
  try { rmSync(join(dir, 'OUT.TXT')); } catch { /* first run */ }
  const r = spawnSync('dosbox-x', ['-silent', '-fastlaunch', '-nogui', '-nomenu',
    '-time-limit', String(timeout),
    '-c', `mount c ${dir}`, '-c', 'c:', '-c', 'RUN16.EXE > OUT.TXT', '-c', 'exit'], {
    encoding: 'utf8',
    // SDL still wants a video driver even with -nogui; the dummy one is what makes this runnable
    // from a script with no display.
    env: { ...process.env, SDL_VIDEODRIVER: 'dummy' },
    timeout: (timeout + 15) * 1000,
    /*
     * SIGKILL, because spawnSync's default SIGTERM DOES NOT KILL THIS PROGRAM. A DOSBox-X left over
     * from this work was found alive after six days: it ignored SIGTERM and died only on SIGKILL.
     * With the default, the timeout returns here while the child lives on, reparented to init --
     * a leash that reports the timeout without enforcing it.
     */
    killSignal: 'SIGKILL',
  });
  let stdout = '';
  try { stdout = readFileSync(join(dir, 'OUT.TXT'), 'latin1'); } catch { /* the program printed nothing */ }
  return { code: r.status, stdout };
}

/**
 * The DATA of an OMF object, with the record framing removed.
 *
 * Scanning the file as-is loses answers, and silently: OMF splits data into LEDATA records and puts
 * other records between them, so a probe string that straddles a boundary appears as `INFO:0` in one
 * place and `011=0002;` in another. Three of thirty-eight queries went missing that way, which is
 * exactly the kind of gap that reads as "the compiler did not answer" rather than "the reader is
 * wrong".
 *
 * Each record is [type:1][length:2 LE][payload: length-1][checksum:1]. LEDATA (0xA0, or 0xA1 for
 * 32-bit) begins with a segment index -- one byte, or two when the high bit is set -- and a data
 * offset, 2 bytes in 16-bit records and 4 in 32-bit ones.
 */
function omfData(buf) {
  const parts = [];
  let p = 0;
  while (p + 3 <= buf.length) {
    const type = buf[p];
    const len = buf[p + 1] | (buf[p + 2] << 8);
    const payload = buf.subarray(p + 3, p + 3 + len - 1);
    p += 3 + len;
    if (type !== 0xA0 && type !== 0xA1) continue;
    let q = 0;
    if (payload[q++] & 0x80) q++;
    q += type === 0xA1 ? 4 : 2;
    parts.push(payload.subarray(q));
  }
  return Buffer.concat(parts).toString('latin1');
}

/**
 * Ask the 16-BIT compiler for a list of integer constants, without running anything.
 *
 * There is no way to run a DOS executable here, so the answers have to come out of the OBJECT FILE.
 * Each query becomes a `char` array initialised with the DIGITS of its value -- the initialisers are
 * constant expressions, so the compiler itself computes the number and writes it into the data
 * segment, where a plain byte scan finds it. This is how CMake sizes types when it cross-compiles,
 * and it needs neither a linker, an emulator, nor a DOS.
 *
 * The index is written beside the value because the linker is not involved and nothing guarantees
 * the order records appear in; matching on the index makes the scan order-independent.
 *
 * `prelude` is C pasted above the probes -- the struct definitions the queries ask about.
 * `queries` are constant expressions. Returns an array of numbers, in the order given.
 */
export function watcom16(prelude, queries, { model = 'ms', flags = '' } = {}) {
  const D = "#define D(v) ('0'+(((v)/1000)%10)), ('0'+(((v)/100)%10)), ('0'+(((v)/10)%10)), ('0'+((v)%10))\n" +
    "#define PROBE(i, v) char info_##i[] = { 'I','N','F','O',':', D(i), '=', D(v), ';', 0 };\n";
  const body = queries.map((q, i) => `PROBE(${i}, (int)(${q}))`).join('\n');
  // Per process, for the same reason as watcomRun16's.
  const w = `w16_${process.pid}`;
  mkdirSync(join(SCRATCH, w), { recursive: true });
  put(`${w}/probe16.c`, `${D}\n${prelude}\n${body}\n`);
  const r = watcom(`cd /work/${w} && rm -f probe16.o && wcc -bt=dos -0 -${model} ${flags} -q probe16.c`,
    { target: 'dos16' });
  if (r.code !== 0) throw new Error(`watcom16: ${r.stderr || r.stdout}`);
  const bytes = omfData(readFileSync(join(SCRATCH, w, 'probe16.o')));
  const out = new Array(queries.length).fill(null);
  for (const m of bytes.matchAll(/INFO:(\d{4})=(\d{4});/g)) out[+m[1]] = +m[2];
  const missing = out.findIndex((v) => v === null);
  if (missing >= 0) throw new Error(`watcom16: no answer for query ${missing}: ${queries[missing]}`);
  return out;
}

/** Run a shell command inside the oracle. Returns {code, stdout, stderr} — never throws on a
 *  non-zero exit, because a compile failure is data a gate wants to see, not an accident. */
export function sh(cmd, { timeout = 120000 } = {}) {
  up();
  const r = docker(['exec', NAME, 'sh', '-c', cmd], { timeout });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Put a file into the oracle's working directory (host-side write into the bind mount). */
export function put(name, content) {
  up();
  writeFileSync(join(SCRATCH, name), content);
  return name;
}

export function get(name) { return readFileSync(join(SCRATCH, name), 'utf8'); }
export function del(...names) { for (const n of names) { try { rmSync(join(SCRATCH, n)); } catch {} } }

const gccFlags = ({ std = 'gnu89', opt = '-O0', extra = '', includes = [] }) =>
  `-std=${std} ${opt} -w ${includes.map(i => `-I${i}`).join(' ')} ${extra}`;

/** `gcc -E` — the authority on preprocessor output. */
export function preprocess(source, opts = {}) {
  const src = `_pp_${process.pid}.c`;
  put(src, source);
  const r = sh(`gcc ${gccFlags(opts)} -E ${src}`);
  del(src);
  return r;
}

/** Compile and RUN a program; the oracle for observable C semantics. */
export function compileRun(source, opts = {}) {
  const tag = `_cr_${process.pid}`;
  put(`${tag}.c`, source);
  const r = sh(`gcc ${gccFlags(opts)} ${tag}.c -o ${tag} && ./${tag}`);
  del(`${tag}.c`, tag);
  return r;
}

/** Generate a random C program. Seeded, so a seed always yields the same program. */
export function csmith(seed, args = '') {
  const r = sh(`csmith --seed ${seed} ${args}`);
  if (r.code !== 0) throw new Error(`csmith failed: ${r.stderr}`);
  return r.stdout;
}

/** Compile+run a csmith program at one optimization level; returns its checksum line. */
export function csmithRun(source, opt = '-O0') {
  const r = compileRun(source, { std: 'gnu99', opt, includes: [CSMITH_INC] });
  return { ...r, checksum: (r.stdout.match(/checksum = ([0-9A-Fa-f]+)/) || [])[1] ?? null };
}

/** Ask the oracle for the real i386 layout of a set of types.
 *  `queries` is a list of {name, decl, fields?} — decl is any C type declaration text. */
export function layout(prelude, queries) {
  const lines = [];
  for (const q of queries) {
    lines.push(`  printf("%s|size=%u|align=%u", ${JSON.stringify(q.name)}, ` +
      `(unsigned)sizeof(${q.type}), (unsigned)__alignof__(${q.type}));`);
    for (const f of q.fields ?? []) {
      lines.push(`  printf("|%s=%u", ${JSON.stringify(f)}, ` +
        `(unsigned)__builtin_offsetof(${q.type}, ${f}));`);
    }
    lines.push(`  printf("\\n");`);
  }
  const src = `#include <stdio.h>\n${prelude}\nint main(void){\n${lines.join('\n')}\n  return 0;\n}\n`;
  const r = compileRun(src);
  if (r.code !== 0) throw new Error(`layout probe failed:\n${r.stderr}\n--- source:\n${src}`);
  const out = {};
  for (const line of r.stdout.trim().split('\n')) {
    const parts = line.split('|');
    const rec = { name: parts[0], offsets: {} };
    for (const p of parts.slice(1)) {
      const [k, v] = p.split('=');
      if (k === 'size') rec.size = +v; else if (k === 'align') rec.align = +v;
      else rec.offsets[k] = +v;
    }
    out[rec.name] = rec;
  }
  return out;
}

export function version() {
  return sh('gcc --version | head -1; csmith --version | head -1').stdout.trim();
}
