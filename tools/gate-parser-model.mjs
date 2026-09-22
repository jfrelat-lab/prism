// gate-parser-model.mjs — the front end compiles for the model the target names, and stops there.
//
// types.js can build either model (gate-typemodel); this asks whether the PARSER uses the one it is
// given. The sizes are read straight out of the parsed scope rather than asserted in the C: the
// obvious trick, `char probe[cond ? 1 : -1]`, does not work here because PRISM does not diagnose a
// negative array size at all -- `char x[-1];` compiles today, which is a separate gap and is noted
// rather than relied upon.
//
// The other half matters more: parsing under dos16 must NOT lead to emitting under it. A front end
// that says int is 2 bytes, handing work to a back end that assumes 4, is how a compiler produces
// confident wrong answers -- so everything past the parse is refused BY NAME until the backend
// exists (ROADMAP P11.1), and the door is checked in its message, not merely in its failure.
import { Preprocessor } from '../src/cpp/cpp.js';
import { parse } from '../src/parse/parser.js';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const SRC = 'int i; void *p; long l; short s; enum e { A } en;';

/** What the parser made of each declaration, under one model. */
const sizes = (model) => {
  const tokens = new Preprocessor().run(SRC, 'pm.c');
  const { scope } = parse(tokens, { file: 'pm.c', model });
  const of = (n) => scope.ordinary.get(n)?.type?.size;
  return { i: of('i'), p: of('p'), l: of('l'), s: of('s'), en: of('en') };
};

const i386 = sizes('i386');
const dos16 = sizes('dos16');

const cases = [
  ['i386 int', i386.i, 4], ['i386 pointer', i386.p, 4], ['i386 long', i386.l, 4],
  ['i386 short', i386.s, 2], ['i386 enum', i386.en, 4],
  ['dos16 int', dos16.i, 2], ['dos16 pointer', dos16.p, 2], ['dos16 long', dos16.l, 4],
  ['dos16 short', dos16.s, 2], ['dos16 enum', dos16.en, 1],
];

let bad = 0;
for (const [what, got, want] of cases) {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(16)} ${got}${ok ? '' : `  (want ${want})`}`);
}

/** A type the model has no entry for is refused, not quietly aliased to something else. */
{
  let msg = '(parsed)';
  try { parse(new Preprocessor().run('long long x;', 'pm.c'), { file: 'pm.c', model: 'dos16' }); }
  catch (e) { msg = e.message; }
  const ok = msg.includes("no scalar 'long long'");
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${'dos16 long long'.padEnd(16)} ${msg.slice(0, 58)}`);
}

/** And the door. */
const build = (model) => {
  try {
    compileProgram([{ file: 'pm.c', source: 'int f(void) { return 0; }' }],
      { resolve: builtinHeaderResolver({}), memory: 8 * 1024 * 1024, collect: true, model });
    return 'compiles';
  } catch (e) { return e.message.split('\n')[0]; }
};
for (const [model, want] of [['i386', 'compiles'], ['dos16', 'emits for i386 only']]) {
  const got = build(model);
  const ok = want === 'compiles' ? got === 'compiles' : got.includes(want);
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${`emitting ${model}`.padEnd(16)} ${got.slice(0, 58)}`);
}

const total = cases.length + 3;
console.log(bad ? `\n${bad} of ${total} WRONG`
  : `\nthe front end compiles for the model it is given, and stops at the backend: ${total}/${total}`);
process.exit(bad ? 1 : 0);
