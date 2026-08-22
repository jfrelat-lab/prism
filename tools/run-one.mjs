// run-one.mjs — compile and run ONE C file, print the result as JSON.
//
// Exists so a gate can impose a wall-clock limit. A gate that runs programs in its own process has
// no way to stop a program that loops forever — and a corpus of somebody else's tests contains both
// deliberately long tests and, when the compiler is wrong, accidental infinite loops. Both must be
// reported as a timeout rather than hanging the gate.
//
//   node tools/run-one.mjs <file.c>   ->  {"ok":true,"code":0,"stdout":"…"} | {"ok":false,"err":"…"}

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { compile } from '../src/compile.js';

const file = process.argv[2];
try {
  // 'latin1' is byte-transparent: a C source is a byte stream and need not be valid UTF-8.
  const src = readFileSync(file, 'latin1');
  const m = compile(src, { file: basename(file) });
  const r = m.run();
  process.stdout.write(JSON.stringify({ ok: true, code: r.code, stdout: r.stdout }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, err: String(e.message ?? e) }));
}
