// gate-watcom-argorder.mjs — the order a call's arguments are evaluated in, held to Open Watcom.
//
// C leaves it unspecified (6.5.2.2p10), so it is the COMPILER's, and a program can depend on it
// without knowing: Heretic's `P_SpawnMobj(x + ((P_Random()-P_Random())<<11), y + (...), ...)` gives
// the first pair of random numbers to y in the shipped HERETIC.EXE, because Watcom evaluated y's
// argument first. A demo replays only if every P_Random lands where that build put it.
//
// THE ORACLE is wcc386 itself, in the oracle container, building for Linux so the program RUNS
// there: once with no options and once with Heretic's own CCOPTS (/omaxet /4r /zp1 /ei /j), in case
// the optimiser reorders. Each line of the program is one call shape, and prints the order in which
// its arguments' side effects happened. PRISM compiles the same program with compile.argOrder 'rtl'
// and must print the same; with the default (left to right) it must NOT -- the control that shows
// the program can tell the two apart. And every target on the Watcom environment must get 'rtl'
// from its toolchain (src/toolchain.js) without saying so itself.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';
import { loadTarget } from '../src/target.js';
import { toolchainCompile } from '../src/toolchain.js';
import { up, put, watcom, version } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = `#include <stdio.h>
#include <stdarg.h>
static int t(int v) { printf("%d", v); return v; }
static int f2(int a, int b) { return a + b; }
static int f3(int a, int b, int c) { return a + b + c; }
static int f5(int a, int b, int c, int d, int e) { return a + b + c + d + e; }
static int fv(int n, ...) { va_list ap; int s = 0; va_start(ap, n); while (n--) s += va_arg(ap, int); va_end(ap); return s; }
struct pt { int x, y; };
static int fs(struct pt p, int a, int b) { return p.x + a + b; }
static struct pt mk(int v) { struct pt p; p.x = t(v); p.y = 0; return p; }
int (*fp)(int, int) = f2;
int main(void) {
  f2(t(1), t(2));                    printf("\\n");   /* two register arguments */
  f3(t(1), t(2), t(3));              printf("\\n");   /* three */
  f5(t(1), t(2), t(3), t(4), t(5));  printf("\\n");   /* past the four registers: the stack */
  f2(t(1), f2(t(2), t(3)));          printf("\\n");   /* nested */
  f3(t(1), 7, t(3));                 printf("\\n");   /* a plain constant between */
  fv(3, t(1), t(2), t(3));           printf("\\n");   /* variadic */
  fp(t(1), t(2));                    printf("\\n");   /* through a pointer */
  fs(mk(1), t(2), t(3));             printf("\\n");   /* a struct by value */
  return 0;
}
`;
const SHAPES = ['two', 'three', 'five', 'nested', 'constant between', 'variadic', 'pointer', 'struct'];

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(58)} ${detail}`); };

// --- the oracle
up();
console.log(version());
put('argorder.c', SOURCE);
const oracle = {};
for (const [name, flags] of [['wcc386', ''], ['wcc386 with Heretic\'s CCOPTS', '-omaxet -4r -zp1 -ei -j']]) {
  const r = watcom(`cd /work && rm -f argorder argorder.o && wcl386 -q -bt=linux -l=linux ${flags} argorder.c -fe=argorder && ./argorder`);
  if (r.code !== 0) throw new Error(`${name}: ${r.stderr || r.stdout}`);
  oracle[name] = r.stdout.trim().split('\n');
}
const [plain, heretic] = Object.values(oracle);
report(plain.join() === heretic.join(), "the optimiser does not change the order", `${plain.join(' ')}  |  ${heretic.join(' ')}`);

// --- PRISM
const prism = (argOrder) => {
  const p = compileProgram([{ file: 'argorder.c', source: SOURCE }], { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, argOrder });
  let out = '';
  const w = p.M.write.bind(p.M);
  p.M.write = (s) => { out += s; return w(s); };
  p.run(['argorder']);
  p.M.flushAll?.();
  return out.trim().split('\n');
};
const rtl = prism('rtl'), ltr = prism(undefined);
SHAPES.forEach((shape, i) => report(rtl[i] === plain[i], `argOrder 'rtl', ${shape}`, `prism ${rtl[i]}  watcom ${plain[i]}`));
const differs = SHAPES.filter((_, i) => ltr[i] !== plain[i]).length;
report(differs > 0, 'control: left to right is told apart from Watcom', `${differs} of ${SHAPES.length} shapes differ`);

// --- the toolchain gives it to every Watcom target
for (const name of ['heretic', 'hexen', 'opendune']) {
  const t = loadTarget(join(ROOT, 'targets', `${name}.json`));
  const got = { ...toolchainCompile(t.env), ...(t.compile ?? {}) }.argOrder;
  report(got === 'rtl', `${name}: argOrder from its toolchain`, `${got}`);
}
console.log(bad ? `\n${bad} WRONG` : '\nPRISM evaluates a call\'s arguments in the order Watcom\'s code does.');
process.exit(bad ? 1 : 0);
