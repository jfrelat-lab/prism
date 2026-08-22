// probe-abi.mjs — exploratory: ask the oracle what the i386 SysV layout rules ACTUALLY are.
// Not a gate. Run it when you need to learn a rule rather than assert one.
import { layout, version } from './oracle.mjs';

console.log(version());

const BASICS = ['char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int',
  'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long', 'float',
  'double', 'long double', 'void *', 'char *', 'enum E'];

const prelude = `
enum E { E0, E1 };
struct CI    { char a; int b; };
struct CS    { char a; short b; };
struct CLL   { char a; long long b; };
struct CD    { char a; double b; };
struct DC    { double a; char b; };
struct CLD   { char a; long double b; };
struct ARR   { char a; int b[3]; char c; };
struct NEST  { char a; struct CI b; char c; };
union  U     { char a; double b; short c; };
struct BF1   { int a:1; int b:1; };
struct BF2   { char a:3; char b:6; };
struct BF3   { int a:31; int b:2; };
struct BF4   { unsigned a:3; unsigned char b:5; };
struct BF5   { int a:5; int :0; int b:5; };
struct BF6   { char a; int b:20; char c; };
struct PK    { char a; int b; } __attribute__((packed));
struct EMPTY { int a[0]; };
`;

const q = [
  ...BASICS.map(t => ({ name: t, type: t })),
  { name: 'CI', type: 'struct CI', fields: ['a', 'b'] },
  { name: 'CS', type: 'struct CS', fields: ['a', 'b'] },
  { name: 'CLL', type: 'struct CLL', fields: ['a', 'b'] },
  { name: 'CD', type: 'struct CD', fields: ['a', 'b'] },
  { name: 'DC', type: 'struct DC', fields: ['a', 'b'] },
  { name: 'CLD', type: 'struct CLD', fields: ['a', 'b'] },
  { name: 'ARR', type: 'struct ARR', fields: ['a', 'b', 'c'] },
  { name: 'NEST', type: 'struct NEST', fields: ['a', 'b', 'c'] },
  { name: 'U', type: 'union U', fields: ['a', 'b', 'c'] },
  { name: 'BF1', type: 'struct BF1' },
  { name: 'BF2', type: 'struct BF2' },
  { name: 'BF3', type: 'struct BF3' },
  { name: 'BF4', type: 'struct BF4' },
  { name: 'BF5', type: 'struct BF5' },
  { name: 'BF6', type: 'struct BF6', fields: ['a', 'c'] },
  { name: 'PK', type: 'struct PK', fields: ['a', 'b'] },
  { name: 'EMPTY', type: 'struct EMPTY' },
];

const res = layout(prelude, q);
for (const [name, r] of Object.entries(res)) {
  const offs = Object.entries(r.offsets).map(([k, v]) => `${k}@${v}`).join(' ');
  console.log(`${name.padEnd(20)} size=${String(r.size).padStart(3)} align=${r.align}${offs ? '  ' + offs : ''}`);
}
