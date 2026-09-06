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

/** Start the oracle container if it is not already running. Idempotent and cheap to re-call. */
export function up() {
  if (ready) return;
  mkdirSync(SCRATCH, { recursive: true });
  const running = docker(['ps', '-q', '-f', `name=^${NAME}$`]).stdout.trim();
  if (!running) {
    // A stopped container of the same name would make `run` fail with a name clash.
    docker(['rm', '-f', NAME], { stdio: 'ignore' });
    const r = docker(['run', '-d', '--name', NAME, '--platform', 'linux/386',
      '-v', `${SCRATCH}:/work`, IMAGE, 'sleep', 'infinity']);
    if (r.status !== 0) {
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
