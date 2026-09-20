// gate-dos-eof.mjs — 0x1A ends a source file, the way every DOS compiler read it.
//
// CP/M counted file length in 128-byte records and used 0x1A to say where the text stopped inside
// the last one; DOS kept it. 429 files in this corpus carry the marker. PRISM used to lex it into a
// token with an empty name, which came out of Keen Dreams as "unexpected '' in expression" at a line
// its own compiler never reached.
//
// The cases below are the whole rule, and the last two are why it is safe to apply it to every
// source rather than to DOS targets only: a file without a marker is untouched, and a marker at the
// very end -- which is where all 430 of them sit -- changes nothing but the noise it used to make.
import { tokenize } from '../src/cpp/lexer.js';

const kinds = (src) => tokenize(src, { file: 't.c' }).tokens.map(t => t.v).filter(v => v !== '\n' && v !== '');

const cases = [
  ['text after the marker is not read',
    () => { const got = kinds('int a;\n\x1a int b;\n'); return { got: got.join(' '), want: 'int a ;' }; }],
  ['a marker at the very end changes nothing',
    () => ({ got: kinds('int a;\n\x1a').join(' '), want: kinds('int a;\n').join(' ') })],
  ['a file with no marker is untouched',
    () => ({ got: kinds('int a; int b;').join(' '), want: 'int a ; int b ;' })],
  ['the marker leaves no token of its own',
    () => ({ got: String(tokenize('int a;\n\x1a\n', { file: 't.c' }).tokens.some(t => t.v === '\x1a')), want: 'false' })],
];

let bad = 0;
for (const [what, run] of cases) {
  const { got, want } = run();
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(40)} ${ok ? '' : `got [${got}] want [${want}]`}`);
}
console.log(bad ? `\n${bad} of ${cases.length} WRONG`
  : `\n0x1A ends a source file, as DOS did: ${cases.length}/${cases.length}`);
process.exit(bad ? 1 : 0);
