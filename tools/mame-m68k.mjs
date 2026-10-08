// mame-m68k.mjs — the four generated units of MAME's 68000 core, made the way its makefile makes them.
//
// From 0.37 the C 68000 core (Karl Stenerud's) is not all source: the makefile first compiles
// src/cpu/m68000/m68kmake.c into a program and runs it,
//
//     $(OBJ)/cpu/m68000/m68kmake $(OBJ)/cpu/m68000 src/cpu/m68000/m68k_in.c
//
// which reads the opcode handlers of m68k_in.c and writes m68kops.h, m68kops.c, m68kopac.c,
// m68kopdm.c and m68kopnz.c -- which the core then includes and links. This does the same step
// with PRISM as the compiler of m68kmake: the generator runs as JavaScript, its input is the file
// of the release, and what it writes goes beside the corpus, not into the repository (it is as
// much the release's as its sources are).
//
//   node tools/mame-m68k.mjs [--release=037b5] [--check]
//
// --check also runs the generator built by gcc in the oracle container and wants the five files
// identical, which is what says PRISM ran the program right.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
export const M68K_FILES = ['m68kops.h', 'm68kops.c', 'm68kopac.c', 'm68kopdm.c', 'm68kopnz.c'];

/** Where a release's generated files live: corpus/mame<release>-generated/cpu/m68000. */
export const generatedDir = (release) => join(ROOT, 'corpus', `mame${release}-generated`, 'cpu', 'm68000');

/** Run m68kmake under PRISM. Returns { files: {name: Uint8Array}, stdout }. */
export function generate(release) {
  const dir = `corpus/mame${release}/src/cpu/m68000`;
  const input = readFileSync(join(ROOT, dir, 'm68k_in.c'));
  const t = { name: 'm68kmake', dir, units: { list: ['m68kmake.c'] }, defines: { DOS: '1' },
    compile: { memory: 64, collect: true }, env: ['stdio'] };
  // The output directory is named on the command line and the program opens "<dir>/<file>". It
  // has to exist -- fopen into a directory that is not there fails here as it does on a disk -- so
  // it is the current one.
  const { program } = buildTarget(t, { root: ROOT, envExtra: { stdio: { files: { 'm68k_in.c': new Uint8Array(input) } } } });
  const r = program.run(['m68kmake', '.', 'm68k_in.c']);
  const files = {};
  for (const [k, v] of program.M.files.store) {
    const name = k.replace(/^\.\//, '');
    if (M68K_FILES.includes(name)) files[name] = Uint8Array.from(v);
  }
  return { files, stdout: String(r?.stdout ?? ''), code: r?.code };
}

/** Write a release's generated files where its target expects them. */
export function writeGenerated(release) {
  const g = generate(release);
  const missing = M68K_FILES.filter((f) => !g.files[f]);
  if (missing.length) throw new Error(`m68kmake did not write ${missing.join(', ')} (it said: ${g.stdout.trim().split('\n').slice(-2).join(' | ')})`);
  const out = generatedDir(release);
  mkdirSync(out, { recursive: true });
  for (const f of M68K_FILES) writeFileSync(join(out, f), g.files[f]);
  return { ...g, out };
}

if (process.argv[1] === SELF) {
  const release = process.argv.find((a) => a.startsWith('--release='))?.slice(10) ?? '037b5';
  const g = writeGenerated(release);
  const total = M68K_FILES.reduce((n, f) => n + g.files[f].length, 0);
  console.log(`${g.stdout.trim().split('\n').slice(-3).join('\n')}`);
  console.log(`${M68K_FILES.length} files, ${total.toLocaleString('en')} bytes, in ${g.out}`);
  if (process.argv.includes('--check')) {
    const { sh, SCRATCH } = await import('./oracle.mjs');
    const work = join(SCRATCH, 'm68kmake');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, 'out'), { recursive: true });
    try {
      const src = join(ROOT, 'corpus', `mame${release}`, 'src', 'cpu', 'm68000');
      for (const f of ['m68kmake.c', 'm68k_in.c']) writeFileSync(join(work, f), readFileSync(join(src, f)));
      // m68kmake includes <dir.h>, which is DOS's: gcc on Linux is given the lengths PRISM's own has.
      writeFileSync(join(work, 'dir.h'), '#define MAXPATH 260\n#define MAXDRIVE 3\n#define MAXDIR 256\n#define MAXFILE 256\n#define MAXEXT 255\n');
      /*
       * m68kmake copies OVERLAPPING memory with memcpy -- `memcpy(buff, buff + 1, nchars - 1)`, to
       * drop a character -- which C leaves undefined. A libc that copies forward a byte at a time,
       * as DJGPP's did and PRISM's does, shifts the text left; glibc's copies in blocks from
       * wherever is fastest and leaves `AG_V = VFLAG_AADD_16(src, dst, res);` in the generated
       * source, which is not C. Measured, not supposed: with glibc's memcpy three of the five
       * files differ, by 36 such lines in the first. So gcc is linked with the copy the program
       * was written against, and -fno-builtin keeps it from inlining its own.
       */
      writeFileSync(join(work, 'forward.c'), 'void *memcpy(void *d, const void *s, unsigned n) { char *a = d; const char *b = s; while (n--) *a++ = *b++; return d; }\n');
      const r = sh('cd m68kmake && gcc -m32 -O0 -w -std=gnu89 -fno-builtin -DDOS -I. -o m68kmake m68kmake.c forward.c && ./m68kmake out m68k_in.c > said.txt 2>&1; echo "RC $?"', { timeout: 120000 });
      const differ = M68K_FILES.filter((f) => {
        const p = join(work, 'out', f);
        if (!existsSync(p)) return true;
        const b = readFileSync(p), a = g.files[f];
        return a.length !== b.length || !a.every((x, i) => x === b[i]);
      });
      console.log(differ.length ? `DIFFER from gcc's run: ${differ.join(' ')} (${r.stdout.trim()})` : `identical to what the generator writes when gcc compiles it (${M68K_FILES.length} of ${M68K_FILES.length})`);
      process.exitCode = differ.length ? 1 : 0;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
