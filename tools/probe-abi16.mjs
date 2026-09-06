// probe-abi16.mjs — exploratory: ask Open Watcom what the 16-BIT DOS layout rules actually are.
//
// The 32-bit sibling (probe-abi.mjs) can run the program it compiles; this one cannot, because
// nothing here executes a DOS binary. So every answer comes out of the OBJECT FILE, through
// oracle.watcom16: each query is a char array initialised with the digits of its value, which makes
// the compiler write the number into the data segment where a byte scan finds it.
//
// Not a gate. Run it when you need to learn a rule rather than assert one:
//
//   node tools/probe-abi16.mjs [ms|mm|mc|ml|mh]        # memory model, default small
import { watcom16, version } from './oracle.mjs';

const model = process.argv[2] ?? 'ms';
console.log(version());
console.log(`Open Watcom, 8086 (-0), memory model -${model}\n`);

const BASICS = ['char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int',
  'unsigned int', 'long', 'unsigned long', 'float', 'double', 'void *', 'char *', 'enum E'];

const prelude = `
enum E { E0, E1 };
struct CI    { char a; int b; };
struct CL    { char a; long b; };
struct CF    { char a; float b; };
struct CD    { char a; double b; };
struct DC    { double a; char b; };
struct ARR   { char a; int b[3]; char c; };
struct NEST  { char a; struct CI b; char c; };
union  U     { char a; double b; short c; };
struct BF1   { int a:1; int b:1; };
struct BF2   { char a:3; char b:6; };
struct BF3   { int a:15; int b:2; };
struct BF4   { unsigned a:3; unsigned char b:5; };
struct BF5   { int a:5; int :0; int b:5; };
struct BF6   { char a; int b:12; char c; };
struct EMPTY { int a[1]; };
`;

/*
 * offsetof by pointer arithmetic on a null pointer: <stddef.h> would do, but this keeps the probe
 * to one header-free file and the expression is the one every 1990s codebase wrote by hand.
 */
const off = (s, m) => `(char *)&((struct ${s} *)0)->${m} - (char *)0`;

const queries = [];
const labels = [];
const ask = (label, expr) => { labels.push(label); queries.push(expr); };

for (const t of BASICS) ask(`sizeof(${t})`, `sizeof(${t})`);

// Alignment, asked the way a struct asks it: where does the member land after a char?
for (const [s, m, t] of [['CI', 'b', 'int'], ['CL', 'b', 'long'], ['CF', 'b', 'float'],
  ['CD', 'b', 'double']]) {
  ask(`char + ${t}: offset`, off(s, m));
  ask(`char + ${t}: sizeof`, `sizeof(struct ${s})`);
}
ask('double then char: sizeof', 'sizeof(struct DC)');
ask('ARR sizeof', 'sizeof(struct ARR)');
ask('ARR .c offset', off('ARR', 'c'));
ask('NEST sizeof', 'sizeof(struct NEST)');
ask('NEST .c offset', off('NEST', 'c'));
ask('union sizeof', 'sizeof(union U)');
for (const b of ['BF1', 'BF2', 'BF3', 'BF4', 'BF5', 'BF6']) ask(`${b} sizeof`, `sizeof(struct ${b})`);
ask('BF6 .c offset', off('BF6', 'c'));
ask('EMPTY sizeof', 'sizeof(struct EMPTY)');

const answers = watcom16(prelude, queries, { model });
const width = Math.max(...labels.map((l) => l.length));
for (let i = 0; i < labels.length; i++) {
  console.log(`  ${labels[i].padEnd(width)}  ${String(answers[i]).padStart(3)}`);
}
