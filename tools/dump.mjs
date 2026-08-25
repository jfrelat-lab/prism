// dump.mjs — compile C and print the JavaScript that comes out.
//
// The whole premise of this backend is that the emitted code is readable: no bytecode, no WASM, no
// name mangling beyond what JS forces. That claim is only worth anything if it is easy to check, so
// this is the tool that checks it.
//
//   node tools/dump.mjs file.c                 the whole unit
//   node tools/dump.mjs file.c --fn=main       one function
//   node tools/dump.mjs file.c --safepoints    with the loop back-edge checks emitted
//   node tools/dump.mjs file.c --out=/tmp/a.js write it out instead of printing
//
// For a real program the per-function view is the usable one — `node tools/doom.mjs --fn=R_DrawColumn`
// already does that for Doom, and a 62-unit dump is 8 MB of JavaScript.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { compileProgram } from '../src/compile.js';

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
const opt = (n, d = null) => {
  const a = args.find(x => x === `--${n}` || x.startsWith(`--${n}=`));
  return a === undefined ? d : (a.includes('=') ? a.slice(a.indexOf('=') + 1) : true);
};

if (!files.length) {
  console.error('usage: node tools/dump.mjs <file.c...> [--fn=NAME] [--safepoints] [--out=PATH]');
  process.exit(2);
}

const units = files.map(f => ({ file: basename(f), source: readFileSync(f, 'latin1') }));
const prog = compileProgram(units, { collect: true, safepoints: !!opt('safepoints') });

let text = prog.src;
const fn = opt('fn');
if (fn) {
  // Functions are emitted one after another at the top level, so the next `\nfunction ` is the end.
  const i = text.indexOf(`function ${fn}(`);
  if (i < 0) {
    console.error(`${fn}: not emitted. ` +
      (prog.failures.some(f => f.name === fn) ? 'it failed to emit — see the failure list' : ''));
    process.exit(1);
  }
  const j = text.indexOf('\nfunction ', i + 10);
  text = j < 0 ? text.slice(i) : text.slice(i, j);
}

const out = opt('out');
if (out) {
  writeFileSync(out, text);
  console.error(`${(text.length / 1024).toFixed(1)} kB of JavaScript -> ${out}`);
} else {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

if (!fn && !out) {
  console.error(`\n// ${Object.keys(prog.F).length} functions, ` +
    `${(prog.src.length / 1024).toFixed(1)} kB of JavaScript` +
    (prog.mod.safepoints.length ? `, ${prog.mod.safepoints.length} safepoints` : ''));
}
