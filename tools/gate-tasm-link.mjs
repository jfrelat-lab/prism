// gate-tasm-link.mjs — C calling Keen Dreams' assembly through PRISM's link, against Borland's.
//
// gate-tasm-run holds each routine to TASM's object code from a machine state it sets up itself.
// This asks the other question: whether a C PROGRAM reaches those routines as Borland's linker lets it
// -- arguments laid down by the C calling convention (a far pointer as offset then segment, from a
// near string the compiler widened), the result taken from AX, and the modules' data publics (px,
// fontcolor, bufferwidth...) being the SAME objects the C reads and writes.
//
// The oracle: Borland C++ 2.0 compiles tests/tasm-link/link.c with Keen's options, assembles Keen's
// id_us_a.asm and id_vw_a.asm with its TASM (bcc hands them over), links and runs it in DOSBox-X.
// PRISM builds the same C with the same two modules (src/asm/tasm-link.js) and runs it.
//
//   node tools/gate-tasm-link.mjs --capture [--bc=~/Projects/borland/BC20]
//   node tools/gate-tasm-link.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPUS = join(ROOT, 'corpus', 'KeenDreams');
const TEST = join(ROOT, 'tests', 'tasm-link', 'link.c');
const GOLDEN = join(ROOT, 'goldens', 'tasm-link.json');
const MODULES = ['id_us_a.asm', 'id_vw_a.asm'];
const INCLUDED = ['id_vw_ae.asm', 'id_asm.equ', 'graphkdr.equ'];
const keen = JSON.parse(readFileSync(join(ROOT, 'targets', 'keendreams.json'), 'utf8'));

if (process.argv.includes('--capture')) {
  const { bccRun, bccVersion } = await import('./oracle-borland.mjs');
  const bc = process.argv.find((a) => a.startsWith('--bc='))?.slice(5) ?? join(process.env.HOME ?? '', 'Projects', 'borland', 'BC20');
  const prj = JSON.parse(readFileSync(join(ROOT, 'goldens', 'borland-prj.json'), 'utf8'));
  const options = prj.keendreams.filter((o) => /^-(m.|a|a-|K|b-?)$/.test(o));
  const [r] = bccRun([{ name: 'LINK', source: readFileSync(TEST, 'latin1'),
    files: [...MODULES, ...INCLUDED].map((f) => join(CORPUS, f)),
    // Assembled as the project assembles them (tasm /mx, as gate-tasm-front does); bcc's own call to
    // TASM passes /ml, under which id_vw_a.asm does not assemble.
    before: MODULES.map((f) => `tasm /mx ${f.toUpperCase()} > NUL`),
    link: MODULES.map((f) => f.replace(/\.asm$/i, '.obj')) }], { bc, options });
  if (!r.compiled) throw new Error(`Borland did not build it:\n${r.compileLog}`);
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify({
    _doc: `${bccVersion({ bc })}, ${options.join(' ')}: tests/tasm-link/link.c with Keen Dreams' ${MODULES.join(' and ')}, `
      + 'assembled by its TASM, linked and RUN in DOSBox-X (tools/gate-tasm-link.mjs --capture).',
    stdout: r.stdout,
  }, null, 1)}\n`);
  console.log('captured');
}
if (!existsSync(GOLDEN)) { console.log('no goldens/tasm-link.json: run with --capture'); process.exit(1); }
const want = JSON.parse(readFileSync(GOLDEN, 'utf8')).stdout;

let got;
try {
  const { program, tasmBound } = buildTarget({ name: 'tasm-link', dir: CORPUS, units: { list: ['../../tests/tasm-link/link.c'] },
    env: keen.env, compile: { ...keen.compile, ppSizeof: null }, tasm: MODULES }, { root: ROOT });
  if (program.failures.length) throw new Error(`refused: ${program.failures.map((f) => `${f.fn}: ${f.message}`).join('; ')}`);
  console.log(`  ..  bound ${tasmBound.map((b) => b.name).join(' ')}`);
  got = program.run(['D:\\LINK.EXE']).stdout;
} catch (e) { got = `threw: ${e.message}\n`; }
const ok = got === want;
const a = got.split('\n'), b = want.split('\n');
const k = a.findIndex((l, i) => l !== b[i]);
console.log(`${ok ? '  ok ' : ' BAD '} link.c: ${b.length - 1} lines${ok ? '' : `; line ${k + 1}: got [${a[k]}] want [${b[k]}]`}`);
console.log(ok ? '\nC reaches Keen\'s assembly as Borland\'s linker lets it.' : '\n1 WRONG');
process.exit(ok ? 0 : 1);
