// gate-link-scope.mjs — which object a name means, across units and object files.
//
// Two defects Keen Dreams' link found, each a wrong answer before it was a refusal:
//
//   * A unit's OWN declaration wins over another kind of thing by that name elsewhere. lzhuf.c has
//     `static void update(int c)`; id_rf.c defines `byte update[2][UPDATESIZE]`, which lzhuf.c never
//     declares. The program-wide globals map made `update(c)` a call through the array.
//   * A block-scope `extern` refers to the object wherever it is defined -- including an object no C
//     unit defines, which another object file supplies. USL_CtlHButtonCustom declares
//     `extern char far gametext` inside the block that uses it; gametext is a MakeOBJ resource.
//
// The answers are C's own (6.2.2 linkage, 6.7 scope); both models are run.
//
//   node tools/gate-link-scope.mjs
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const UNIT_A = `int update[4] = { 7, 7, 7, 7 };\nint shared = 5;\n`;
const UNIT_B = `#include <stdio.h>
static int update(int c) { return c + 1; }
int viaBlock(void) { extern int shared; return shared; }
int viaObject(void) { extern char text; return text * 100 + (&text)[1]; }
int main(void)
{
    printf("%d %d %d\\n", update(41), viaBlock(), viaObject());
    return 0;
}
`;
// No file-scope declaration of `text` anywhere: only the block's `extern` can find it.

let bad = 0;
for (const model of ['i386', 'dos16m']) {
  let got;
  try {
    const p = compileProgram([{ file: 'a.c', source: UNIT_A }, { file: 'b.c', source: UNIT_B }], {
      resolve: builtinHeaderResolver({}), memory: 8 << 20, model,
      externData: [{ name: 'res', bytes: Uint8Array.from([65, 66, 0]), size: 3, far: false, publics: [{ name: 'text', offset: 0 }] }],
    });
    got = p.run(['x']).stdout.trim();
  } catch (e) { got = `threw: ${e.message.split('\n')[0]}`; }
  const want = '42 5 6566';
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${model.padEnd(7)} own static function over a foreign array; block extern to C and to an object file: ${got}`);
}
console.log(bad ? `\n${bad} WRONG` : '\neach name means the object C says it means.');
process.exit(bad ? 1 : 0);
