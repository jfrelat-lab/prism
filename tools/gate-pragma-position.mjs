// gate-pragma-position.mjs — a directive may sit between any two tokens, and the parser sees it.
//
// The preprocessor passes pragmas through rather than eating them, as gcc -E does and for the same
// reason: a pragma is a message to the COMPILER. So the parser meets `#pragma ...` as tokens, and
// has to step over the ones it does not recognise wherever a directive is allowed to be -- which is
// anywhere, a directive needing only a line of its own.
//
// There are three such places and all three are here, because two of them had nothing holding them
// and the third was missing outright until Keen Dreams' kd_play.c put a pragma between an `else`
// and the statement it governs. A pragma the parser DOES recognise must still work, which is the
// last case: #pragma pack(1) changes the layout of what follows, and a gate that only proved
// pragmas are skipped would be satisfied by a parser that skipped that one too.
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const run = (source) => {
  try {
    const p = compileProgram([{ file: 'pp.c', source }], {
      resolve: builtinHeaderResolver({}), memory: 8 * 1024 * 1024, collect: true,
    });
    const f = (p.failures ?? [])[0];
    return f ? `refused: ${f.message}` : 'compiles';
  } catch (e) { return `stopped: ${e.message.replace(/^pp\.c:\d+: /, '')}`; }
};

const cases = [
  ['at file scope', run('#pragma warn -pro\nint f(void) { return 1; }')],
  ['between a block\'s items', run('int f(void) { int a = 1;\n#pragma warn -pro\n return a; }')],
  ['between `else` and its statement',
    run('int f(int x) { int a = 0;\n if (x) a = 1;\n else\n#pragma warn -pro\n  a = 2;\n return a; }')],
  ['between `if (...)` and its statement',
    run('int f(int x) { int a = 0;\n if (x)\n#pragma warn -pro\n  a = 1;\n return a; }')],
  ['after a label', run('int f(void) { int a = 0;\n again:\n#pragma warn -pro\n a++;\n return a; }')],
  ['between `while (...)` and its body',
    run('int f(int n) { int a = 0;\n while (n--)\n#pragma warn -pro\n  a++;\n return a; }')],
];

let bad = 0;
for (const [what, got] of cases) {
  const ok = got === 'compiles';
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} a pragma ${what.padEnd(36)} ${got}`);
}

// ...and one the parser must NOT merely skip.
const packed = run('#pragma pack(1)\nstruct s { char c; int i; };\n'
  + 'int f(void) { return sizeof(struct s) == 5; }\n'
  + 'int g(void) { char probe[sizeof(struct s) == 5 ? 1 : -1]; return (int)sizeof probe; }');
{
  const ok = packed === 'compiles';
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} #pragma pack(1) still packs${' '.repeat(18)}${ok ? 'sizeof is 5' : packed}`);
}

const total = cases.length + 1;
console.log(bad ? `\n${bad} of ${total} WRONG`
  : `\na directive may sit between any two tokens: ${total}/${total}`);
process.exit(bad ? 1 : 0);
