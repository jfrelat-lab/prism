// gate-structure.mjs — a goto of a structured shape is emitted as labelled JavaScript, not as the
// state machine.
//
// src/backend/structure.js turns a forward goto into `break L` out of a labelled block, a backward one
// into `continue L` of a loop that runs once, and a goto to a label among a switch's statements into a
// re-entry of the switch. The state machine (`for(;;) switch(_pc)`) stays for the rest. It is exact
// either way -- gate-run's gotos-structured case holds the answers to gcc's -- so what this gate holds
// is the SHAPE, which is what decides speed: DOSBox's CPU core as a state machine was a 1.1 MB function
// V8 never optimised, five times slower on MIRAGE's tube.com than the same core structured.
//
// THE CLAIM: each function below is emitted without `switch(_pc)`. THE CONTROL, which must be red: a
// goto INTO a block, which no labelled statement can express, still gets the state machine -- were it
// structured, this gate would be checking nothing the fallback could fail.
//
//   node tools/gate-structure.mjs
import { compile } from '../src/compile.js';

const SOURCE = `
int fwd(int n) { int i, j, s = 0;
  for (i = 0; i < n; i++) for (j = 0; j < n; j++) { s += i * j; if (s > 50) goto done; }
  s = -1;
done:
  return s; }
int back(int x) { int t = 0;
again:
  t++; x = x * 3 + 1; if (x % 7) goto again; return t; }
int both(int n) { int s = 0; if (n < 0) goto mid; s += 100;
mid:
  s += n; n--; if (n > 0) goto mid; return s; }
int core(const unsigned char *c, int len) { int pc = 0, acc = 0, p = 0;
  while (pc < len) { p = 0;
restart:
    switch (c[pc++]) {
    case 0x66: p++; goto restart;
    case 1: acc += 1 + p; break;
    case 2: if (p > 1) goto illegal; acc *= 2; break;
    case 3: continue;
    case 4: goto out;
    default:
    illegal:
      acc -= 100; break;
    }
    acc += 10;
  }
  return acc;
out:
  return -acc; }
int intoblock(int n) { if (n) goto in; { int k = 1;
in:
  n += k; } return n; }
int main(void) { return 0; }
`;

const src = compile(SOURCE, { file: 'structure.c' }).src;
const body = (fn) => {
  const i = src.search(new RegExp(`function [^(]*\\b${fn}\\(`));
  if (i < 0) return null;
  const j = src.indexOf('\nfunction ', i + 5);
  return src.slice(i, j < 0 ? undefined : j);
};
let bad = 0;
const check = (ok, what) => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what}`); };
for (const fn of ['fwd', 'back', 'both', 'core']) {
  const b = body(fn);
  check(b !== null && !b.includes('switch(_pc)'), `${fn}: labelled statements, no state machine`);
}
const ctl = body('intoblock');
check(ctl !== null && ctl.includes('switch(_pc)'), 'control: a goto into a block keeps the state machine');
console.log(bad ? `\n${bad} WRONG` : '\nevery structured goto shape is emitted as labelled JavaScript.');
process.exit(bad ? 1 : 0);
