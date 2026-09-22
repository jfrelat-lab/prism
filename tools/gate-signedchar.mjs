// gate-signedchar.mjs — compile.signedChar, measured rather than asserted.
//
// Whether plain char is signed belongs to the COMPILER, not to the memory model: Watcom's 16-bit char
// is unsigned, Borland's is signed, and both lay memory out the same way. The tables carry what their
// oracle measured, and compile.signedChar overrides it the way gcc's -fsigned-char, Borland's -K and
// Watcom's -j do. Three things hold that up, and each part below goes red on its own:
//
//   A. Against the oracle. Watcom with and without -j, small and large, asked the three questions a
//      program can ask -- (char)-1 < 0, CHAR_MIN, CHAR_MAX -- and PRISM asked the same through its
//      real pipeline: the predefined macros, its own <limits.h>, and the parser's types. CHAR_MIN is
//      asked as CHAR_MIN + 128 because the oracle reads answers back as four decimal digits.
//
//   B. The emitter types for the model the program was compiled for. compileProgram's ctx once
//      carried no model, so every target's emitter typed for i386 while its parser typed for dos16l --
//      nothing ran, so nothing wrong escaped, but a build was reported under a model it was only half
//      compiled for. Every emitted function records the model it used; the set must be exactly one.
//
//   C. It runs. i386 is the one model that executes, so an unsigned char there is checked by running a
//      program whose answer C itself defines: (char)200 is positive exactly when char is unsigned.
import { Preprocessor } from '../src/cpp/cpp.js';
import { Parser } from '../src/parse/parser.js';
import { compileProgram, builtinHeaderResolver, charDefines } from '../src/compile.js';
import { makeTypes } from '../src/sema/types.js';
import { watcom16, version } from './oracle.mjs';

let bad = 0;
const report = (ok, what, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(46)} ${detail}`);
};

const QUESTIONS = ['(char)-1 < 0', 'CHAR_MIN + 128', 'CHAR_MAX'];

/** PRISM's answer to one constant expression, through the preprocessor, limits.h and the parser. */
const prism = (expr, model, signedChar) => {
  const pp = new Preprocessor({ defines: charDefines(model, signedChar), resolve: builtinHeaderResolver() });
  const tokens = pp.run(`#include <limits.h>\n${expr}\n`, 'q.c');
  return Number(new Parser(tokens, { file: 'q.c', model, signedChar }).constExpr());
};

// --- A. the oracle
console.log(version());
for (const [model, flag] of [['dos16', 'ms'], ['dos16l', 'ml']]) {
  for (const signedChar of [undefined, true]) {
    const got = watcom16('#include <limits.h>', QUESTIONS, { model: flag, flags: signedChar ? '-j' : '' });
    const mine = QUESTIONS.map((q) => prism(q, model, signedChar));
    const same = QUESTIONS.every((_, i) => got[i] === mine[i]);
    report(same, `${model} signedChar=${signedChar ?? '(model)'} vs wcc -${flag}${signedChar ? ' -j' : ''}`,
      `prism [${mine}]  watcom [${got}]`);
  }
}

// --- B. the emitter types for the program's model, and only that one
for (const model of ['i386', 'dos16', 'dos16l']) {
  for (const signedChar of [undefined, true, false]) {
    const p = compileProgram([{ file: 'e.c', source: 'char c; int f(void) { return c; }' }],
      { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, model, signedChar });
    const want = `${model}/${makeTypes(model, { signedChar }).CHAR.signed ? 'signed' : 'unsigned'}`;
    const seen = [...(p.M.mod.emitModels ?? [])];
    report(seen.length === 1 && seen[0] === want,
      `emitter under ${model} signedChar=${signedChar ?? '(model)'}`, `[${seen.join(', ')}]  want [${want}]`);
  }
}

// --- C. it runs
for (const [signedChar, want] of [[undefined, 0], [false, 1], [true, 0]]) {
  const p = compileProgram([{ file: 'r.c', source: 'int main(void) { char c = (char)200; return c > 0; }' }],
    { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true, signedChar });
  const code = p.run(['r']).code;
  report(code === want, `i386 signedChar=${signedChar ?? '(model)'}: (char)200 > 0`, `exit ${code}, want ${want}`);
}

console.log(bad ? `\n${bad} WRONG` : '\ncompile.signedChar is measured, reaches the emitter, and runs.');
process.exit(bad ? 1 : 0);
