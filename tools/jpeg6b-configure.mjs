// jpeg6b-configure.mjs — the IJG JPEG library 6b's jconfig.h and decompression object list, as its
// own configure and Makefile write them.
//
//   node tools/jpeg6b-configure.mjs           write corpus/jpeg-6b-generated/{jconfig.h,objs.json}
//   node tools/jpeg6b-configure.mjs --check   exit 1 if the files on disk differ from what they write
//
// configure runs in the i386 oracle container with gcc. The objects are the generated Makefile's
// COMOBJECTS and DLIBOBJECTS -- the common part, the memory manager configure picked (SYSDEPMEM), and
// the decompressor: what a program that only reads JPEG files links of libjpeg.
import { writeFileSync, readFileSync, cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus/jpeg-6b');
const OUT = join(ROOT, 'corpus/jpeg-6b-generated');
const WORK = join(ROOT, '.oracle/jpeg6b-configure');

if (!existsSync(SRC)) { console.error(`no ${SRC}: jpegsrc.v6b.tar.gz from www.ijg.org/files, unpacked as corpus/jpeg-6b`); process.exit(1); }
rmSync(WORK, { recursive: true, force: true });
cpSync(SRC, WORK, { recursive: true });
writeFileSync(join(WORK, 'print.mk'), 'include Makefile\nprint-vars:\n\t@echo "OBJS=$(COMOBJECTS) $(DLIBOBJECTS)"\n');
const r = sh('cd jpeg6b-configure && CC=gcc ./configure >/dev/null && make -f print.mk print-vars O=o');
if (r.code !== 0) { console.error(r.stdout + r.stderr); process.exit(1); }
const objs = (r.stdout.match(/^OBJS=(.*)$/m)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
const files = {
  'jconfig.h': readFileSync(join(WORK, 'jconfig.h'), 'utf8'),
  'objs.json': JSON.stringify({ objs }, null, 1) + '\n',
};
if (process.argv.includes('--check')) {
  const bad = Object.entries(files).filter(([f, text]) => !existsSync(join(OUT, f)) || readFileSync(join(OUT, f), 'utf8') !== text).map(([f]) => f);
  if (bad.length) { console.log(`differ from what configure writes: ${bad.join(', ')}`); process.exit(1); }
  console.log(`jconfig.h and the ${objs.length} objects are configure's`);
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });
for (const [f, text] of Object.entries(files)) writeFileSync(join(OUT, f), text);
console.log(`wrote ${OUT}: jconfig.h, ${objs.length} objects (${objs.join(' ')})`);
