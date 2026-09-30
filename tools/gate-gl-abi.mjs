// gate-gl-abi.mjs — every constant PRISM's <GL/gl.h> defines, held to Mesa's <GL/gl.h>.
//
// src/env/headers-gl.js transcribes OpenGL 1.1's values. A slip there (GL_QUAD_STRIP 7 for 8) would
// not fail to compile; it would draw the wrong primitive. So each #define PRISM declares is printed
// by a program compiled against Mesa's own header in the oracle container, and must be equal; and
// the types PRISM declares must have the sizes Mesa's do on i386.
import { GL_H } from '../src/env/headers-gl.js';
import { up, put, sh } from './oracle.mjs';

const names = [...GL_H.matchAll(/^#define\s+(GL_[A-Z0-9_]+)\s+(\S+)/gm)].map((m) => [m[1], Number(m[2])]);
const types = ['GLenum', 'GLboolean', 'GLbitfield', 'GLbyte', 'GLshort', 'GLint', 'GLsizei', 'GLubyte', 'GLushort', 'GLuint', 'GLfloat', 'GLclampf', 'GLdouble', 'GLclampd'];
const sizeOf = { GLenum: 4, GLboolean: 1, GLbitfield: 4, GLbyte: 1, GLshort: 2, GLint: 4, GLsizei: 4, GLubyte: 1, GLushort: 2, GLuint: 4, GLfloat: 4, GLclampf: 4, GLdouble: 8, GLclampd: 8 };
const mine = new Map(GL_H.matchAll(/^typedef\s+(.+?)\s+(GL\w+);/gm).map((m) => [m[2], m[1]]));

up();
put('glabi.c', `#include <GL/gl.h>\n#include <stdio.h>\nint main(void) {\n${names.map(([n]) => `  printf("%s %ld\\n", "${n}", (long)(${n}));`).join('\n')}\n${types.map((t) => `  printf("%s %d\\n", "${t}", (int)sizeof(${t}));`).join('\n')}\n  return 0;\n}\n`);
const r = sh('cd /work && gcc -o glabi glabi.c && ./glabi');
if (r.code !== 0) throw new Error(r.stderr || r.stdout);
const mesa = new Map(r.stdout.trim().split('\n').map((l) => { const [k, v] = l.split(' '); return [k, Number(v)]; }));

let bad = 0;
const wrong = names.filter(([n, v]) => mesa.get(n) !== v);
if (wrong.length) { bad++; for (const [n, v] of wrong) console.log(` BAD  ${n}: prism ${v}  mesa ${mesa.get(n)}`); }
else console.log(`  ok   ${names.length} of ${names.length} constants equal Mesa's`);
// The C types PRISM gives, sized by PRISM's own i386 model (sizeOf above is that model's table).
const i386 = { 'unsigned int': 4, 'unsigned char': 1, 'signed char': 1, short: 2, int: 4, 'unsigned short': 2, float: 4, double: 8, void: 0 };
const typeBad = types.filter((t) => i386[mine.get(t)] !== mesa.get(t) || sizeOf[t] !== mesa.get(t));
if (typeBad.length) { bad++; for (const t of typeBad) console.log(` BAD  ${t}: prism ${mine.get(t)}  mesa sizeof ${mesa.get(t)}`); }
else console.log(`  ok   ${types.length} of ${types.length} types have Mesa's sizes`);
// The control: the check must be able to fail -- one constant off by one is caught.
const mutated = names.map(([n, v], i) => [n, i === 0 ? v + 1 : v]);
const caught = mutated.filter(([n, v]) => mesa.get(n) !== v).length === 1;
if (!caught) bad++;
console.log(`${caught ? '  ok ' : ' BAD '}  control: the same comparison finds one constant off by one`);
console.log(bad ? `\n${bad} WRONG` : "\nPRISM's <GL/gl.h> says what Mesa's says.");
process.exit(bad ? 1 : 0);
