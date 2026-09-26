// gate-borland-offset.mjs — `OFFSET local` in Borland inline assembly, as Borland C++ 2.0 runs it.
//
// Keen Dreams' MML_CheckForEMS writes `mov dx,OFFSET emmname` for a local array and passes DS:DX to
// DOS as a device name. Borland emits `mov dx,OFFSET [bp-10]`, and TASM makes that the DISPLACEMENT:
// DX = 65526, not the array's address. PRISM answers the same number where Borland's frame layout is
// known from measurement -- a function's only automatic, array/struct/long at -(size rounded to a
// word), char at -1 -- and refuses the rest by name (a second local; an int Borland may put in SI).
//
//   node tools/gate-borland-offset.mjs --capture [--bc=~/Projects/borland/BC20]
//   node tools/gate-borland-offset.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'borland-offset.json');
const SHAPES = [
  ['c1', 'char v[1];'], ['c2', 'char v[2];'], ['c3', 'char v[3];'], ['c9', 'char v[9] = "EMMXXXX0";'],
  ['c10', 'char v[10];'], ['i3', 'int v[3];'], ['s3', 'struct { char a; int b; char c; } v;'],
  ['l', 'long v;'], ['c9p', 'char v[9];', 'int a, int b'], ['ch', 'char v;'],
];
// Refused: Borland's frame is not known for these, so no number is invented.
const REFUSED = [['two', 'char v[4]; char w[6];'], ['scalar', 'int v;']];
const fn = ([n, decl, params]) => `unsigned ${n}(${params ?? 'void'})\n{\n  ${decl}\nasm mov dx,OFFSET v\n  return _DX;\n}\n`;
const call = ([n, , p]) => `${n}(${p ? '1, 2' : ''})`;

if (process.argv.includes('--capture')) {
  const { bccRun, bccVersion } = await import('./oracle-borland.mjs');
  const bc = process.argv.find((a) => a.startsWith('--bc='))?.slice(5) ?? join(process.env.HOME ?? '', 'Projects', 'borland', 'BC20');
  const source = `#include <stdio.h>\n${SHAPES.map(fn).join('\n')}\nint main(void)\n{\n${SHAPES.map((s) => `  printf("${s[0]} %d\\n", (int)${call(s)});`).join('\n')}\n  return 0;\n}\n`;
  const [r] = bccRun([{ name: 'OFFSET', source }], { bc, options: ['-mm', '-a', '-K'] });
  if (!r.compiled) throw new Error(r.compileLog);
  const want = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split(' ')).map(([k, v]) => [k, +v]));
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify({ _doc: `${bccVersion({ bc })}, -mm -a -K: DX after \`mov dx,OFFSET v\`, v the function's only local, run in DOSBox-X`, want }, null, 1)}\n`);
}
if (!existsSync(GOLDEN)) { console.log('no goldens/borland-offset.json: run with --capture'); process.exit(1); }
const { want } = JSON.parse(readFileSync(GOLDEN, 'utf8'));

const p = compileProgram([{ file: 'off.c', source: [...SHAPES, ...REFUSED].map(fn).join('\n') }],
  { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model: 'dos16m', signedChar: false, enums: 'int' });
const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
let bad = 0;
for (const s of SHAPES) {
  const got = failed.has(s[0]) ? `refused: ${failed.get(s[0])}` : ((p.F[s[0]](1, 2) << 16) >> 16);
  const ok = got === want[s[0]];
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${s[1].padEnd(40)} ${String(got).slice(0, 60)}${ok ? '' : ` (Borland ${want[s[0]]})`}`);
}
for (const [n, decl] of REFUSED) {
  const ok = /OFFSET of the local 'v'/.test(failed.get(n) ?? '');
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${decl.padEnd(40)} ${ok ? 'refused by name' : `not refused: ${failed.get(n) ?? 'compiled'}`}`);
}
console.log(bad ? `\n${bad} WRONG` : '\nOFFSET of a local is Borland\'s displacement where its frame is known, and refused elsewhere.');
process.exit(bad ? 1 : 0);
