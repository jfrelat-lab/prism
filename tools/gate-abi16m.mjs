// gate-abi16m.mjs — near, far and code pointers, through the real parser, against Open Watcom.
//
// A 16-bit memory model is two decisions: whether a pointer to data is near (2 bytes) or far (4) by
// default, and the same for a pointer to code. MEDIUM is near data and far code -- Keen Dreams' own
// assembly declares it -- and it is the model where those two differ in a way structs can see.
// Explicit `far` and `near` override the default in every model, and a program that writes `far` 214
// times depends on that being honoured rather than skipped.
//
// So this does not hand types to the layout algorithm; it hands C to the PARSER, under each model,
// and reads the structs back out of its scope -- which is the path a program takes, qualifiers,
// typedefs and function-pointer declarators included -- then asks Watcom the same questions.
import { Preprocessor } from '../src/cpp/cpp.js';
import { parse } from '../src/parse/parser.js';
import { watcom16, version } from './oracle.mjs';

const PRELUDE = `
typedef char far *fstr;
struct A  { char c; char *p; };
struct B  { char c; char far *p; };
struct N  { char c; char near *p; };
struct F  { char c; void (*f)(void); };
struct FF { char c; void (far *f)(void); };
struct FN { char c; void (near *f)(void); };
struct M  { char c; char *p; char far *q; void (*f)(void); int i; };
struct S  { char c; struct M *m; long l; };
struct Y  { char far *a[3]; int n; };
struct T  { char c; fstr s; int n; };
`;

const MODELS = [['dos16', 'ms'], ['dos16m', 'mm'], ['dos16l', 'ml']];

console.log(version());
let bad = 0, total = 0;
for (const [model, flag] of MODELS) {
  const tokens = new Preprocessor({ defines: {}, resolve: () => null }).run(PRELUDE, 'm.c');
  const { scope } = parse(tokens, { file: 'm.c', model });
  const queries = [], expect = [], labels = [];
  for (const [tag, t] of scope.tags) {
    if (t.k !== 'struct') continue;
    queries.push(`sizeof(struct ${tag})`); expect.push(t.size); labels.push(`${tag}: sizeof`);
    for (const f of t.fields) {
      queries.push(`(int)&((struct ${tag}*)0)->${f.name}`); expect.push(f.offset); labels.push(`${tag}.${f.name}`);
    }
  }
  const got = watcom16(PRELUDE, queries, { model: flag });
  let here = 0;
  for (let i = 0; i < queries.length; i++) {
    if (got[i] === expect[i]) continue;
    if (++here <= 6) console.log(`   ${model} ${labels[i].padEnd(12)} prism ${expect[i]}  watcom ${got[i]}`);
  }
  bad += here; total += queries.length;
  console.log(`${here ? ' BAD ' : '  ok '} ${model.padEnd(7)} vs wcc -${flag}: ${queries.length - here}/${queries.length}`);
}
console.log(bad ? `\n${bad} of ${total} checks differ`
  : `\n${total}/${total} checks pass\nnear, far and code pointers match Open Watcom in small, medium and large.`);
process.exit(bad ? 1 : 0);
