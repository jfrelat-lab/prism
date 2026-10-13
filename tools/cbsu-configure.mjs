// cbsu-configure.mjs — Chromium B.S.U.'s build, as its own configure and Makefiles write it, and those of
// the two libraries it is built with here: FreeType 2.3.11 and FTGL 2.1.3~rc5.
//
//   node tools/cbsu-configure.mjs           write corpus/chromium-bsu-generated/
//   node tools/cbsu-configure.mjs --check   exit 1 if the files on disk differ from what they write
//
// The three configure scripts run in the i386 oracle container, FreeType's and FTGL's for a static
// library, the game's with the layers PRISM has: SDL 1.2 for the window, SDL_mixer, SDL_image, FTGL
// for text (GLC, OpenAL, glpng and SDL 2 disabled by its own --disable flags), the DejaVu bold face
// as its font. What comes back, for targets/chromium-bsu.json:
//   ftconfig.h, ftmodule.h        FreeType's builds/unix/ftconfig.h and objs/ftmodule.h
//   ftgl/config.h                 FTGL's config.h (its sources include "config.h")
//   chromium-bsu-config.h         the game's
//   build.json                    what each Makefile compiles, and the definitions on its command lines
// It is kept in the reference cache (tools/ref-cache.mjs) under the three source trees: three
// configures under emulation are minutes, and their answer only changes with what goes in.
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './oracle.mjs';
import { refCached, treeHash } from './ref-cache.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = { freetype: 'corpus/freetype-2.3.11', ftgl: 'corpus/ftgl-2.1.3~rc5', game: 'corpus/chromium-bsu-0.9.16.1' };
const OUT = join(ROOT, 'corpus/chromium-bsu-generated');
const WORK = join(ROOT, '.oracle/cbsu-configure');
export const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
export const GAME_OPTIONS = ['--disable-sdl2', '--disable-openal', '--disable-sdl2mixer', '--disable-glpng', '--disable-sdl2image', '--disable-glc',
  '--disable-nls', `--with-font-path=${FONT}`];

for (const [k, d] of Object.entries(SRC)) {
  if (!existsSync(join(ROOT, d))) { console.error(`no ${d} (${k}): see the "fetch" line of targets/chromium-bsu.json`); process.exit(1); }
}

/** `make VAR`'s value in a configured tree: a Makefile that includes the real one and prints it. */
const printVars = (dir, makefile, vars) => {
  writeFileSync(join(WORK, dir, 'print.mk'), `include ${makefile}\nprint-vars:\n${vars.map((v) => `\t@echo '${v}=$(${v})'`).join('\n')}\n`);
  const r = sh(`cd cbsu-configure/${dir} && make -s -f print.mk print-vars`);
  if (r.code !== 0) throw new Error(`${dir}: ${r.stdout}${r.stderr}`);
  return Object.fromEntries(vars.map((v) => [v, (r.stdout.match(new RegExp(`^${v}=(.*)$`, 'm'))?.[1] ?? '').trim()]));
};
/**
 * A make variable's value as the compiler receives it: expanded by make, then split and unquoted by
 * the shell (`"-DFONT_PATH=\"/usr/...\""` becomes -DFONT_PATH="/usr/..."), one word a line.
 */
const shellWords = (dir, makefile, v) => {
  writeFileSync(join(WORK, dir, 'words.mk'), `include ${makefile}\nprint-words:\n\t@printf '%s\\n' $(${v})\n`);
  const r = sh(`cd cbsu-configure/${dir} && make -s -f words.mk print-words`);
  if (r.code !== 0) throw new Error(`${dir}: ${r.stdout}${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
};

const produce = () => {
  rmSync(WORK, { recursive: true, force: true });
  // Timestamps kept: a copy newer than its Makefile.am makes automake want to run again.
  for (const [k, d] of Object.entries(SRC)) cpSync(join(ROOT, d), join(WORK, k), { recursive: true, preserveTimestamps: true });
  const P = '/work/cbsu-configure/prefix';
  const run = (what, cmd) => {
    const r = sh(`cd cbsu-configure && ${cmd}`, { timeout: 1800000 });
    if (r.code !== 0) throw new Error(`${what}: ${r.stdout.slice(-3000)}${r.stderr.slice(-3000)}`);
  };
  run('freetype configure', `cd freetype && ./configure --prefix=${P} --disable-shared --enable-static > configure.log 2>&1`);
  // FreeType's objects: the compile lines its own make would run (make -n), each one's source file.
  const ft = sh('cd cbsu-configure/freetype && make -n 2>/dev/null', { timeout: 600000 });
  const ftUnits = [...new Set([...ft.stdout.matchAll(/--mode=compile .*? (\S+\.c)\s*$/gm)].map((m) => m[1].replace('/work/cbsu-configure/freetype/', '')))];
  const ftDefines = [...new Set([...ft.stdout.matchAll(/ -D(\S+)/g)].map((m) => m[1]))];
  run('freetype build', `cd freetype && make > make.log 2>&1 && make install > /dev/null 2>&1`);
  run('ftgl configure', `cd ftgl && PATH=${P}/bin:$PATH PKG_CONFIG_PATH=${P}/lib/pkgconfig ./configure --prefix=${P} --disable-shared --enable-static --without-x > configure.log 2>&1`);
  const fv = printVars('ftgl/src', 'Makefile', ['libftgl_la_SOURCES', 'libftgl_la_CPPFLAGS', 'DEFS']);
  // FTGL calls itself 2.1.3~rc5, which pkgconf orders BEFORE 2.1.3 (~ is a pre-release), so the game's
  // ">= 2.1.3" check is given FTGL's flags directly, as PKG_CHECK_MODULES allows.
  run('game configure', `cd game && FTGL_CFLAGS="-I${P}/include -I${P}/include/FTGL -I${P}/include/freetype2" FTGL_LIBS="-L${P}/lib -lftgl -lfreetype -lGLU -lGL -lm" ./configure ${GAME_OPTIONS.join(' ')} > configure.log 2>&1`);
  const gv = printVars('game/src', 'Makefile', ['chromium_bsu_SOURCES', 'DEFS']);
  const gameCpp = shellWords('game/src', 'Makefile', 'chromium_bsu_CPPFLAGS');
  const read = (f) => readFileSync(join(WORK, f), 'utf8');
  return {
    'ftconfig.h': read('freetype/builds/unix/ftconfig.h'),
    'ftmodule.h': read('freetype/objs/ftmodule.h'),
    'ftgl/config.h': read('ftgl/config.h'),
    'chromium-bsu-config.h': read('game/chromium-bsu-config.h'),
    'build.json': `${JSON.stringify({
      freetype: { units: ftUnits, defines: ftDefines },
      ftgl: { units: fv.libftgl_la_SOURCES.split(/\s+/).filter((f) => f.endsWith('.cpp')).map((f) => `src/${f}`), cppflags: fv.libftgl_la_CPPFLAGS, defs: fv.DEFS },
      game: {
        units: gv.chromium_bsu_SOURCES.split(/\s+/).filter((f) => f.endsWith('.cpp')).map((f) => `src/${f}`),
        // Every -D on its compile line: its own (PACKAGE, LOCALEDIR, PKGDATADIR) and its libraries'
        // (FONT_PATH from the text renderer's flags, SDL's _GNU_SOURCE and _REENTRANT).
        defines: Object.fromEntries(gameCpp.filter((w) => w.startsWith('-D')).map((w) => { const i = w.indexOf('='); return i < 0 ? [w.slice(2), '1'] : [w.slice(2, i), w.slice(i + 1)]; })),
        defs: gv.DEFS, options: GAME_OPTIONS,
      },
    }, null, 1)}\n`,
  };
};

const parts = [readFileSync(fileURLToPath(import.meta.url), 'utf8'), ...Object.values(SRC).map((d) => treeHash(join(ROOT, d)))];
const { cached, ...files } = await refCached(parts, produce);
if (process.argv.includes('--check')) {
  const bad = Object.entries(files).filter(([f, text]) => !existsSync(join(OUT, f)) || readFileSync(join(OUT, f), 'utf8') !== text).map(([f]) => f);
  if (bad.length) { console.log(`differ from what the configure scripts write: ${bad.join(', ')}`); process.exit(1); }
  console.log(`the generated headers and build.json are the configure scripts'${cached ? ' (cached)' : ''}`);
  process.exit(0);
}
for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(OUT, f)), { recursive: true }); writeFileSync(join(OUT, f), text); }
const b = JSON.parse(files['build.json']);
console.log(`wrote ${OUT}: FreeType ${b.freetype.units.length} units, FTGL ${b.ftgl.units.length}, the game ${b.game.units.length}${cached ? ' (cached)' : ''}`);
