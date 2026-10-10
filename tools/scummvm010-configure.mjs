// scummvm010-configure.mjs — ScummVM 0.10.0's config.h, config.mk and object list, written by the
// release's own configure and Makefile.
//
//   node tools/scummvm010-configure.mjs           write corpus/scummvm-0.10.0-generated/{config.h,config.mk,objs.json}
//   node tools/scummvm010-configure.mjs --check   exit 1 if the files on disk differ from what they write
//
// configure runs in the i386 oracle container with its default engines and none of the optional
// libraries (Ogg Vorbis, Tremor, FLAC, MAD, ALSA, zlib, libmpeg2, FluidSynth, NASM). It accepts gcc
// 2.95 to 4.x by the version -dumpversion prints, and the container's is 12: it is shown a g++ that
// answers 4.1.2 and is otherwise gcc 12, as tools/scummvm-configure.mjs does for 0.6.1.
//
// The object list is the Makefile's: the objects in OBJS and every module's MODULE_OBJS-<module>, for the MODULES config.mk
// and engines/engines.mk select, printed by make itself rather than re-derived from the module.mk
// files' ifdefs.
import { writeFileSync, readFileSync, cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus/scummvm-0.10.0');
const OUT = join(ROOT, 'corpus/scummvm-0.10.0-generated');
const WORK = join(ROOT, '.oracle/scummvm010-configure');

if (!existsSync(SRC)) { console.error(`no ${SRC}: see the fetch line of targets/scummvm010.json`); process.exit(1); }
rmSync(WORK, { recursive: true, force: true });
cpSync(SRC, WORK, { recursive: true });
writeFileSync(join(WORK, 'gxx4'), '#!/bin/sh\ncase "$1" in -dumpversion) echo 4.1.2; exit 0;; esac\nexec g++ "$@"\n', { mode: 0o755 });
writeFileSync(join(WORK, 'print.mk'), 'include Makefile\nprint-vars:\n\t@echo "OBJS=$(OBJS)"\n\t@echo "ALL=$(foreach m,$(MODULES),$(MODULE_OBJS-$(m)))"\n');
const r = sh('cd scummvm010-configure && CXX=/work/scummvm010-configure/gxx4 ./configure --disable-alsa --disable-vorbis --disable-tremor --disable-mad --disable-flac --disable-zlib --disable-mpeg2 --disable-fluidsynth --disable-nasm >/dev/null && make -f print.mk print-vars');
if (r.code !== 0) { console.error(r.stdout + r.stderr); process.exit(1); }
const words = (k) => (r.stdout.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
// The modules' objects, and the ones a module adds to OBJS itself: backends/platform/sdl does not use
// rules.mk, so its three objects (main is in sdl.o) are in OBJS and in no MODULE_OBJS-<module>.
const objs = [...words('OBJS').filter((o) => o.endsWith('.o')), ...words('ALL')];
const files = {
  'config.h': readFileSync(join(WORK, 'config.h'), 'utf8'),
  // The compiler configure was shown is a path inside this scratch copy; it is not part of the configuration.
  'config.mk': readFileSync(join(WORK, 'config.mk'), 'utf8').replace(/^CXX := .*$/m, 'CXX := g++'),
  'objs.json': JSON.stringify({ objs }, null, 1) + '\n',
};
rmSync(WORK, { recursive: true, force: true });
if (process.argv.includes('--check')) {
  const bad = Object.entries(files).filter(([f, text]) => !existsSync(join(OUT, f)) || readFileSync(join(OUT, f), 'utf8') !== text).map(([f]) => f);
  if (bad.length) { console.error(`${bad.join(', ')} not what configure and make write: run node tools/scummvm010-configure.mjs`); process.exit(1); }
  console.log(`config.h, config.mk and the ${objs.length} objects are what the release's configure and Makefile write`);
} else {
  mkdirSync(OUT, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(OUT, f), text);
  console.log(`wrote ${OUT}: config.h, config.mk, ${objs.length} objects`);
}
