// gate-dos16-run.mjs — whole 16-bit programs, RUN: PRISM's run() under dos16m against Borland C++
// 2.0 compiling and running the same source in DOSBox-X.
//
// run() refused every model but i386 until the pieces that execute a program -- argv, variadic
// arguments, the runtime's stores of pointers and ints -- were sized by the model. Each program in
// tests/dos16/ exercises what differs at 16 bits: printf at every width (a %d reads two bytes, a %ld
// four, a long given to %d is two words), a program's own va_arg, strtol's end pointer, setjmp,
// qsort's comparator, structs by value, long arithmetic, far data. Each is built as Keen Dreams is
// built (targets/keendreams.json: env stdio+borland, dos16m, unsigned char, int enums) and compared
// on everything it prints.
//
// CAPTURE ONCE, REPLAY FOREVER: `--capture` needs DOSBox-X and Borland C++ 2.0; it writes
// goldens/dos16-run.json with Keen's options from goldens/borland-prj.json.
//
//   node tools/gate-dos16-run.mjs --capture [--bc=~/Projects/borland/BC20]
//   node tools/gate-dos16-run.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, 'tests', 'dos16');
const GOLDEN = join(ROOT, 'goldens', 'dos16-run.json');
const PROGRAMS = readdirSync(DIR).filter((f) => f.endsWith('.c')).sort();
// A command line for the programs that read one: argv then has entries past argv[0] to be misplaced.
const ARGS = { 'lib.c': 'one TWO 3' };
// DOS hands a program its own full path as argv[0], upper case, on the drive it ran from.
const argv0 = (f) => `D:\\${f.replace('.c', '').toUpperCase()}.EXE`;
const keen = JSON.parse(readFileSync(join(ROOT, 'targets', 'keendreams.json'), 'utf8'));

async function capture() {
  const { bccRun, bccVersion } = await import('./oracle-borland.mjs');
  const bc = process.argv.find((a) => a.startsWith('--bc='))?.slice(5) ?? join(process.env.HOME ?? '', 'Projects', 'borland', 'BC20');
  const prj = JSON.parse(readFileSync(join(ROOT, 'goldens', 'borland-prj.json'), 'utf8'));
  const options = prj.keendreams.filter((o) => /^-(m.|a|a-|K|b-?)$/.test(o));
  const results = bccRun(PROGRAMS.map((f) => ({ name: f.replace('.c', '').toUpperCase(), source: readFileSync(join(DIR, f), 'latin1'), args: ARGS[f] })), { bc, options });
  const golden = {
    _doc: `${bccVersion({ bc })}, options ${options.join(' ')}: each tests/dos16 program compiled and RUN in DOSBox-X `
      + '(tools/gate-dos16-run.mjs --capture); `stdout` is what it printed.',
    options, programs: {},
  };
  for (const [k, r] of results.entries()) {
    if (!r.compiled) throw new Error(`Borland did not compile ${PROGRAMS[k]}:\n${r.compileLog}`);
    golden.programs[PROGRAMS[k]] = r.stdout;
  }
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`);
  console.log(`captured ${PROGRAMS.length} programs`);
}

if (process.argv.includes('--capture')) await capture();
if (!existsSync(GOLDEN)) { console.log('no goldens/dos16-run.json: run with --capture first'); process.exit(1); }
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));

let bad = 0;
for (const f of PROGRAMS) {
  const want = golden.programs[f];
  let got;
  try {
    const { program } = buildTarget({ name: `dos16/${f}`, dir: DIR, units: { list: [f] }, env: keen.env,
      compile: { ...keen.compile, ppSizeof: null } }, { root: ROOT });
    if (program.failures?.length) throw new Error(`refused: ${program.failures.map((x) => `${x.fn}: ${x.message}`).join('; ').slice(0, 300)}`);
    got = program.run([argv0(f), ...(ARGS[f] ?? '').split(' ').filter(Boolean)]).stdout;
  } catch (e) { got = `threw: ${e.message}`; }
  if (want === undefined) { bad++; console.log(` BAD  ${f}: not in the golden (recapture)`); continue; }
  const ok = got === want;
  if (!ok) bad++;
  let detail = '';
  if (!ok) {
    const a = got.split('\n'), b = want.split('\n');
    const k = a.findIndex((l, i) => l !== b[i]);
    detail = `line ${k + 1}: got [${a[k]}] want [${b[k]}]`;
  }
  console.log(`${ok ? '  ok ' : ' BAD '} ${f.padEnd(12)} ${want.split('\n').length - 1} lines ${detail}`);
}
console.log(bad ? `\n${bad} WRONG` : `\nevery program prints what Borland C++'s build of it prints.`);
process.exit(bad ? 1 : 0);
