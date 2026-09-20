// gate-c89-inline.mjs — `inline` is a keyword in C99 and a name in C89, and a target says which.
//
// Borland C++ 2.0 compiled Keen Dreams five years before C99, and kd_act2.c declares
// `boolean inline = false;`, assigns to it and tests it. Quake ships another, in the gas2masm tool
// beside the game: `int inline, outline;`. So the word has to be available to a program that
// predates the keyword -- and must stay a keyword everywhere else, because that is what every other
// target is written in.
//
// The flag gives back `inline` and nothing else. Nothing in the corpus uses `restrict` or `_Bool`
// as a name, and the GNU spellings __inline / __inline__ carry underscores precisely so they cannot
// collide with a program's own names: both stay keywords in either mode, which the last case pins.
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const run = (source, c89) => {
  try {
    const p = compileProgram([{ file: 'c89.c', source }], {
      resolve: builtinHeaderResolver({}), memory: 8 * 1024 * 1024, collect: true, c89,
    });
    const f = (p.failures ?? [])[0];
    return f ? `refused: ${f.message}` : 'compiles';
  } catch (e) { return `stopped: ${e.message.replace(/^c89\.c:\d+: /, '')}`; }
};

const AS_NAME = 'int inline;\nint f(void) { inline = 3; return inline; }';
const AS_SPEC = 'inline int g(void) { return 1; }\nint f(void) { return g(); }';
const GNU_SPEC = '__inline int g(void) { return 1; }\nint f(void) { return g(); }';

const cases = [
  ['a variable called inline, c89', run(AS_NAME, true), 'compiles'],
  ['a variable called inline, c99', run(AS_NAME, false), 'stopped'],
  ['inline as a specifier, c99', run(AS_SPEC, false), 'compiles'],
  ['inline as a specifier, c89', run(AS_SPEC, true), 'stopped'],
  ['__inline as a specifier, c89', run(GNU_SPEC, true), 'compiles'],
];

let bad = 0;
for (const [what, got, want] of cases) {
  const ok = want === 'compiles' ? got === 'compiles' : got.startsWith(want);
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(32)} ${got}`);
}
console.log(bad ? `\n${bad} of ${cases.length} WRONG`
  : `\n\`inline\` is a keyword or a name, as the target says: ${cases.length}/${cases.length}`);
process.exit(bad ? 1 : 0);
