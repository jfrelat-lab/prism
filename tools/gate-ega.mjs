// gate-ega.mjs — the EGA device (src/env/ega.js) against DOSBox's, through a program that drives it.
//
// tests/ega/ega.c sets mode 0Dh and exercises the graphics controller's paths -- Map Mask, Set/Reset,
// Bit Mask with the latches, data rotate with AND/OR/XOR, write modes 1 and 2, read mode 1 -- reading
// every plane back through Read Map Select. Borland C++ 2.0 builds it and DOSBox-X runs it (its VGA
// does exactly this in mode 0Dh); PRISM builds it with the ega environment and must print the same.
//
//   node tools/gate-ega.mjs --capture [--bc=~/Projects/borland/BC20]
//   node tools/gate-ega.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST = join(ROOT, 'tests', 'ega', 'ega.c');
const GOLDEN = join(ROOT, 'goldens', 'ega.json');
const keen = JSON.parse(readFileSync(join(ROOT, 'targets', 'keendreams.json'), 'utf8'));

if (process.argv.includes('--capture')) {
  const { bccRun, bccVersion } = await import('./oracle-borland.mjs');
  const bc = process.argv.find((a) => a.startsWith('--bc='))?.slice(5) ?? join(process.env.HOME ?? '', 'Projects', 'borland', 'BC20');
  const [r] = bccRun([{ name: 'EGA', source: readFileSync(TEST, 'latin1') }], { bc, options: ['-mm', '-a', '-K'] });
  if (!r.compiled) throw new Error(r.compileLog);
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify({ _doc: `${bccVersion({ bc })}: tests/ega/ega.c run in DOSBox-X, whose VGA in mode 0Dh is the reference`, stdout: r.stdout }, null, 1)}\n`);
  console.log('captured');
}
if (!existsSync(GOLDEN)) { console.log('no goldens/ega.json: run with --capture'); process.exit(1); }
const want = JSON.parse(readFileSync(GOLDEN, 'utf8')).stdout.split('\n');

let got;
try {
  const { program } = buildTarget({ name: 'ega', dir: dirname(TEST), units: { list: ['ega.c'] },
    env: ['stdio', 'borland', 'dos', 'pcirq', 'ega'], compile: { ...keen.compile, ppSizeof: null } }, { root: ROOT });
  if (program.failures.length) throw new Error(program.failures.map((f) => `${f.fn}: ${f.message}`).join('; '));
  got = program.run(['EGA.EXE']).stdout.split('\n');
} catch (e) { got = [`threw: ${e.message}`]; }

let bad = 0;
want.forEach((w, k) => {
  if (!w && !got[k]) return;
  const ok = got[k] === w;
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${w.padEnd(26)}${ok ? '' : ` got [${got[k]}]`}`);
});
console.log(bad ? `\n${bad} WRONG` : '\nthe EGA behaves as DOSBox\'s does.');
process.exit(bad ? 1 : 0);
