// dosbox-configure.mjs — DOSBox 0.74-3's config.h, as its own configure writes it.
//
//   node tools/dosbox-configure.mjs           write corpus/dosbox-generated/config.h
//   node tools/dosbox-configure.mjs --check   exit 1 if the file on disk differs from what configure writes
//
// configure runs in the i386 oracle container (gcc, SDL 1.2.15, libpng, X11), with the options that
// remove what cannot mean anything here, each one of configure's own switches:
//   --disable-dynamic-core   both recompilers emit x86 or ARM machine code at run time
//   --disable-fpu-x86        the FPU core written in x86 inline assembly (the C one stays)
//   --disable-alsa-midi      no MIDI device
// Everything else is what configure found: OpenGL (output=opengl, through src/env/gl.js: a texture and
// a quad, OpenGL 1.x), libpng (screenshots, compiled from corpus/libpng-1.6.16), the serial passthrough
// Linux gets, XKB.
import { writeFileSync, readFileSync, cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus/dosbox/dosbox-0.74-3');
const OUT = join(ROOT, 'corpus/dosbox-generated');
const WORK = join(ROOT, '.oracle/dosbox-configure');
export const OPTIONS = '--disable-dynamic-core --disable-fpu-x86 --disable-alsa-midi';

if (!existsSync(SRC)) {
  console.error(`no ${SRC}: dosbox-0.74-3.tar.gz from sourceforge.net/projects/dosbox, unpacked in corpus/dosbox`);
  process.exit(1);
}
rmSync(WORK, { recursive: true, force: true });
cpSync(SRC, WORK, { recursive: true });
const r = sh(`cd dosbox-configure && ./configure ${OPTIONS} >cfg.log 2>&1 || { tail -20 cfg.log; exit 1; }`);
if (r.code !== 0) { console.error(r.stdout + r.stderr); process.exit(1); }
const text = readFileSync(join(WORK, 'config.h'), 'utf8');
if (process.argv.includes('--check')) {
  const ok = existsSync(join(OUT, 'config.h')) && readFileSync(join(OUT, 'config.h'), 'utf8') === text;
  console.log(ok ? `config.h is configure's (${OPTIONS})` : 'config.h differs from what configure writes');
  process.exit(ok ? 0 : 1);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'config.h'), text);
console.log(`wrote ${OUT}/config.h (${OPTIONS})`);
