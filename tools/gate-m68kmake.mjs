// gate-m68kmake.mjs — a build step that is a program: MAME's 68000 generator, run by PRISM.
//
// From 0.37 four units of MAME's C 68000 core are not in the release: its makefile compiles
// src/cpu/m68000/m68kmake.c and RUNS it, and the program writes them from m68k_in.c. So PRISM has
// to run a C program at build time before it can compile the rest (tools/mame-m68k.mjs). This
// holds that step:
//
//   1. the five files PRISM's run of the generator writes are, byte for byte, the files the same
//      generator writes when gcc compiles it -- 765 KB of C source, 1,962 opcode handlers;
//   2. and what the generator found on the way stays found: a name declared nowhere, used as the
//      size of an array, is REFUSED. PRISM took `char output_path[MAXDIR] = ""` (its <dir.h> had
//      no MAXDIR) for a one-byte array and let the program overrun it into the next buffer.
//
// The comparison in 1 is with a gcc build linked with a forward, byte-by-byte memcpy, and the
// tool says why: m68kmake copies overlapping memory with memcpy, and glibc's own leaves garbage
// lines in the generated source. That is a defect of the program, found here, not of either
// compiler -- and the reason the reference is not simply "whatever gcc on Linux prints".
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compile } from '../src/compile.js';
import { sh, put, del } from './oracle.mjs';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let bad = 0;
const check = (ok, text, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}${!ok && detail ? `\n     ${detail}` : ''}`); if (!ok) bad++; };

// ---- 2 first: it needs no corpus
const refuses = (src) => { try { compile(src, { file: 'size.c' }); return null; } catch (e) { return String(e.message); } };
const UNDECLARED = '#include <stdio.h>\nint main(void) { char path[NOWHERE_DEFINED] = ""; char file[16]; printf("%d\\n", (int)sizeof path + (int)sizeof file); return 0; }\n';
const said = refuses(UNDECLARED);
check(said !== null && /NOWHERE_DEFINED/.test(said) && /undeclared/.test(said),
  'a name declared nowhere, as the size of an array, is refused and named', said ?? 'it compiled');
put('size.c', UNDECLARED);
const gcc = sh('gcc -m32 -w -c -o /dev/null size.c 2>&1; echo "RC $?"').stdout;
del('size.c');
check(/RC 1/.test(gcc) && /undeclared/.test(gcc), 'gcc refuses the same source, for the same reason', gcc.trim().split('\n').slice(-2).join(' | '));
// The refusal must not catch what is legal: a variable extent, and one that calls a function.
// (Read through their last elements, not through sizeof: `sizeof` of a variable-length array is a
// separate gap -- PRISM refuses it, "sizeof an expression of unknown type" -- and not this gate's.)
const legal = '#include <stdio.h>\nstatic int two(void) { return 2; }\nint main(void) { int n = 5, i; char a[n]; char b[n * two() + 1];\n' +
  'for (i = 0; i < n; i++) a[i] = 10 + i; for (i = 0; i < n * two() + 1; i++) b[i] = 20 + i; printf("%d %d\\n", a[n - 1], b[n * two()]); return 0; }\n';
let out = null;
try { out = compile(legal, { file: 'vla.c' }).run().stdout; } catch (e) { out = `THREW ${e.message}`; }
check(out === '14 30\n', 'control: a variable-length array, and one sized by a call, still compile and hold their elements', out);

// ---- 1: the generator
if (!existsSync(join(ROOT, 'corpus', 'mame037b5', 'src', 'cpu', 'm68000', 'm68kmake.c'))) {
  console.log('     (MAME 0.37b5 is not in corpus/: the generator itself is not run)');
} else {
  const r = spawnSync('node', [join(ROOT, 'tools', 'mame-m68k.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n');
  const made = text.find((l) => /^Generated \d+ opcode handlers/.test(l)) ?? '';
  check(r.status === 0 && /identical to what the generator writes when gcc compiles it \(5 of 5\)/.test(text.at(-1) ?? ''),
    `m68kmake under PRISM writes gcc's five files, byte for byte (${made.replace(/^Generated /, '') || 'no count printed'})`, text.slice(-2).join(' | '));
}

if (bad) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
if (!existsSync(join(ROOT, 'corpus', 'mame037b5'))) skip('MAME 0.37b5 is not in corpus/ (the refusal was checked; the generator was not)', 'unpack m37b5s.zip from the MAME project into corpus/mame037b5');
console.log('\nMAME\'s 68000 generator runs under PRISM and writes what it writes under gcc');
