// gate-long-double64.mjs — compile.longDouble 64 behaves as gcc's -mlong-double-64.
//
// i386's long double is the 12-byte x87 extended type, which PRISM does not represent. gcc can be
// told otherwise: -mlong-double-64 makes long double an IEEE double, 8 bytes, aligned as double.
// That is a build option of the program's compiler, and Quake III's botlib keeps every number its
// script parser reads in a long double -- so a target may ask for it, and the reference build asks
// gcc for the same thing.
//
// THE CLAIM: one program, compiled by gcc -m32 -mlong-double-64 in the oracle container and by
// PRISM with compile.longDouble 64, prints the same lines: sizes and offsets in a struct, arithmetic,
// conversions both ways, L-suffixed constants, a long double through varargs.
//
// Two things the reference is told, both outside this option. -msse2 -mfpmath=sse: PRISM rounds every
// operation to its type, as SSE does, where the x87 keeps 80 bits in registers (0.1L+0.2L+0.3L is
// 0.59999999999999998 there and 0.60000000000000009 here) -- excess precision is a question of its own,
// and not this gate's. And no %Lf: glibc was not built with the flag and still reads 12 bytes for it,
// so gcc prints -nan; the option changes the program's long double, not its libc's.
// Controls, which must be red: PRISM without the option (it refuses the type), and gcc without the
// flag (its sizes are the 12-byte ones).
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';
import { up, put, sh } from './oracle.mjs';

const SOURCE = `#include <stdio.h>
#include <stdarg.h>
#include <stddef.h>
struct s { char c; long double v; int i; };
static long double sum(int n, ...) { va_list ap; long double t = 0; va_start(ap, n); while (n--) t += va_arg(ap, long double); va_end(ap); return t; }
static long double half(long double x) { return x / 2; }
int main(void) {
  long double a = 1.5L, b = 3, c;
  long double arr[3] = { 0.1L, 0.2L, 0.3L };
  printf("sizeof %u, struct %u, offset v %u, offset i %u\\n", (unsigned)sizeof(long double), (unsigned)sizeof(struct s),
         (unsigned)offsetof(struct s, v), (unsigned)offsetof(struct s, i));
  c = a * b + 0.25L;
  printf("arith %.17g %.17g\\n", (double)c, (double)(c - a / 3));
  printf("to int %d, to float %.9g, from int %.17g\\n", (int)(c * 10), (double)(float)c, (double)(long double)7);
  printf("array %.17g, compare %d %d\\n", (double)(arr[0] + arr[1] + arr[2]), a < b, arr[2] == 0.3L);
  printf("varargs %.17g, call %.17g\\n", (double)sum(3, a, b, c), (double)half(c));
  return 0;
}
`;

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(56)} ${detail}`); };

up();
put('ld64.c', SOURCE);
const gcc = (flags) => {
  const r = sh(`cd /work && rm -f ld64 && gcc -w ${flags} -o ld64 ld64.c && ./ld64`);
  if (r.code !== 0) throw new Error(`gcc ${flags}: ${r.stderr || r.stdout}`);
  return r.stdout.trim().split('\n');
};
const ref = gcc('-mlong-double-64 -msse2 -mfpmath=sse'), ref80 = gcc('-msse2 -mfpmath=sse');

const prism = (longDouble) => {
  const p = compileProgram([{ file: 'ld64.c', source: SOURCE }], { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, longDouble });
  if (p.failures.length) return { failed: p.failures.map((f) => `${f.fn}: ${f.message}`) };
  let out = '';
  const w = p.M.write.bind(p.M);
  p.M.write = (s) => { out += s; return w(s); };
  p.run(['ld64']);
  p.M.flushAll?.();
  return { lines: out.trim().split('\n') };
};

const got = prism(64);
if (got.failed) report(false, 'PRISM compiles it with longDouble 64', got.failed.join('; '));
else ref.forEach((line, i) => report(got.lines[i] === line, `line ${i + 1}`, got.lines[i] === line ? line : `prism ${got.lines[i]}  gcc ${line}`));

const off = prism(undefined);
report(!!off.failed, 'control: without the option PRISM refuses long double', off.failed ? off.failed[0].slice(0, 60) : 'it compiled');
const sizesDiffer = !got.failed && got.lines[0] !== ref80[0];
report(sizesDiffer, 'control: gcc without the flag is told apart', `${ref80[0]}`);
console.log(bad ? `\n${bad} WRONG` : '\nlongDouble 64 is what gcc -mlong-double-64 makes of long double.');
process.exit(bad ? 1 : 0);
