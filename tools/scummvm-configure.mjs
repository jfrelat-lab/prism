// scummvm-configure.mjs — ScummVM 0.6.1's config.h, written by the release's own configure.
//
//   node tools/scummvm-configure.mjs           write corpus/scummvm-0.6.1-generated/config.h
//   node tools/scummvm-configure.mjs --check   exit 1 if the file on disk differs from what configure writes
//
// configure is a /bin/sh script that compiles and runs probes (endianness, alignment, the integer
// types, the optional libraries) and writes config.h from what they answer. It runs here in the i386
// oracle container, where the answers are those of the machine PRISM models, with the engines the
// target builds: Beneath a Steel Sky's alone, the SDL backend, none of the optional libraries.
//
// One thing is put between configure and the container: configure refuses any gcc but 2.95 and 3.x
// by the version -dumpversion prints, and the container's is 12. It is shown a g++ that answers 3.3
// and is otherwise gcc 12 -- the probes it compiles are a few lines of C++ each, which any gcc
// compiles alike. Running configure under PRISM itself is P17.14.
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus/scummvm-0.6.1');
const OUT = join(ROOT, 'corpus/scummvm-0.6.1-generated/config.h');
const WORK = join(ROOT, '.oracle/scummvm-configure');

if (!existsSync(SRC)) { console.error(`no ${SRC}: see the fetch line of targets/scummvm.json`); process.exit(1); }
rmSync(WORK, { recursive: true, force: true });
cpSync(SRC, WORK, { recursive: true });
writeFileSync(join(WORK, 'gxx33'), '#!/bin/sh\ncase "$1" in -dumpversion) echo 3.3; exit 0;; esac\nexec g++ "$@"\n', { mode: 0o755 });
const r = sh('cd scummvm-configure && CXX=/work/scummvm-configure/gxx33 ./configure --disable-scumm --disable-simon --disable-sword1 --disable-sword2 --disable-queen --disable-alsa --disable-vorbis --disable-mad --disable-zlib --disable-mpeg2 && cat config.h');
if (r.code !== 0) { console.error(r.stdout + r.stderr); process.exit(1); }
const text = readFileSync(join(WORK, 'config.h'), 'utf8');
rmSync(WORK, { recursive: true, force: true });
if (process.argv.includes('--check')) {
  const now = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (now !== text) { console.error(`${OUT} is not what configure writes: run node tools/scummvm-configure.mjs`); process.exit(1); }
  console.log('config.h is what the release\'s configure writes');
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
