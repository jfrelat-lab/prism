// run-one.mjs — compile and run ONE C file, print the result as JSON.
//
// Exists so a gate can impose a wall-clock limit. A gate that runs programs in its own process has
// no way to stop a program that loops forever — and a corpus of somebody else's tests contains both
// deliberately long tests and, when the compiler is wrong, accidental infinite loops. Both must be
// reported as a timeout rather than hanging the gate.
//
//   node tools/run-one.mjs <file.c>   ->  {"ok":true,"code":0,"stdout":"…"} | {"ok":false,"err":"…"}

import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compile, builtinHeaderResolver } from '../src/compile.js';

const file = process.argv[2];
const HERE = dirname(file);

/*
 * A QUOTED include is relative to the including file first -- the standard's rule, and not a
 * courtesy: twelve of gcc's torture programs are a second file that does `#include "20040629-1.c"`
 * to compile the first one twice under different options. Without this they were all reported as
 * "missing header", which named the harness's gap as if it were the compiler's.
 *
 * Angled includes still go to PRISM's own table, so a program cannot reach the host's headers by
 * accident.
 */
const std = builtinHeaderResolver();
const resolve = (name, angled, from) => {
  if (!angled) {
    for (const dir of [from ? dirname(from) : HERE, HERE]) {
      const p = join(dir, name);
      if (existsSync(p) && statSync(p).isFile()) return { path: p, text: readFileSync(p, 'latin1') };
    }
  }
  return std(name);
};

try {
  // 'latin1' is byte-transparent: a C source is a byte stream and need not be valid UTF-8.
  const src = readFileSync(file, 'latin1');
  const m = compile(src, { file: basename(file), resolve });
  const r = m.run();
  process.stdout.write(JSON.stringify({ ok: true, code: r.code, stdout: r.stdout }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, err: String(e.message ?? e) }));
}
