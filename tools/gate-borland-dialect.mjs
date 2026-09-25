// gate-borland-dialect.mjs — where Keen Dreams' own compiler departs from C, and where Keen goes there.
//
// PRISM compiles C. Borland C++ 2.0, the compiler Keen Dreams was built with, departs from C in two
// ways found by executing it (tools/oracle-borland.mjs, gate-borland-int16) and confirmed in its
// generated code:
//
//   * two chars of DIFFERENT signedness are compared and combined in 8 bits, unsigned, instead of
//     being promoted to int first: `cmp al,[b]` + `jbe` for a comparison, `or al,[b]` + `mov ah,0`
//     for & | ^ (3.1 does the same)
//   * an unsigned short promotes to a SIGNED int: `us <= i` is cmp + jg (3.1 gives ja, as C does)
//
// So wherever Keen does one of those things, PRISM and KDREAMS.EXE could disagree. This gate scans
// every unit under Keen's options and pins the answer: exactly two occurrences, both `<` between a
// signed char loop counter and `SHP->bmHdr.d` (unsigned char) in gelib.c's UnpackEGAShapeToScreen.
// There the values are plane counts -- the loops index `Dst[8]` -- so both stay below 128, where an
// 8-bit unsigned comparison and C's agree. A new occurrence, or one gone, turns this red.
//
// A positive control runs the same scan over a unit holding every pattern, because a scan reporting
// nothing proves nothing until it has been seen to report something.
import { loadTarget, targetUnits, makeResolver } from '../src/target.js';
import { envHeaders } from '../src/env/registry.js';
import { Preprocessor } from '../src/cpp/cpp.js';
import { parse } from '../src/parse/parser.js';
import { modelDefines } from '../src/compile.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const t = loadTarget(join(ROOT, 'targets', 'keendreams.json'));
const c = t.compile;
const { units, dir } = targetUnits(t, ROOT);

const CHAR_OPS = ['&', '|', '^', '<', '>', '<=', '>=', '==', '!='];
const isChar = (ty) => ty && ty.size === 1 && (ty.k === 'scalar' || ty.k === 'enum') && ty.name !== '_Bool';
const isUShort = (ty) => ty && ty.k === 'scalar' && ty.name === 'unsigned short';

function scan(unitList) {
  const hits = [];
  let ops = 0;
  const unparsed = [];
  for (const u of unitList) {
    let unit;
    try {
      const pp = new Preprocessor({ defines: { ...(t.defines ?? {}), ...modelDefines(c.model, c.signedChar) },
        resolve: makeResolver(dir, t, new Set(), new Set(), envHeaders(t.env), new Set()) });
      ({ unit } = parse(pp.run(u.source, u.file), { model: c.model, c89: true, file: u.file, signedChar: c.signedChar, enums: c.enums }));
    } catch { unparsed.push(u.file.split(/[\\/]/).pop()); continue; }
    const file = u.file.split(/[\\/]/).pop();
    const walk = (n, fn) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach((x) => walk(x, fn)); return; }
      const here = n.n === 'func' || n.n === 'fundef' ? (n.name ?? fn) : fn;
      if (n.n === 'bin' || (n.n === 'assign' && n.op !== '=')) {
        ops++;
        const op = n.n === 'bin' ? n.op : n.op.slice(0, -1);
        const a = n.n === 'bin' ? n.a : n.lhs, b = n.n === 'bin' ? n.b : n.rhs;
        if (CHAR_OPS.includes(op) && isChar(a?.type) && isChar(b?.type) && !!a.type.signed !== !!b.type.signed) {
          hits.push(`${file}:${here}: mixed-sign char ${op}`);
        }
        if (isUShort(a?.type) || isUShort(b?.type)) hits.push(`${file}:${here}: unsigned short operand of ${op}`);
      }
      for (const k of Object.keys(n)) if (k !== 'type' && k !== 'sym' && k !== 'loc') walk(n[k], here);
    };
    walk(unit, '(file scope)');
  }
  return { hits, ops, unparsed };
}

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${detail}`);
};

{
  const control = scan([{ file: join(dir, 'control.c'), source:
    'signed char a; unsigned char b; unsigned short us; int i;\n'
    + 'int f(void) { return (a | b) + (us <= i) + (a ^ b) + (a > b) + (a & i); }\n' }]);
  const want = ['control.c:f: mixed-sign char |', 'control.c:f: unsigned short operand of <=',
    'control.c:f: mixed-sign char ^', 'control.c:f: mixed-sign char >'];
  report(JSON.stringify(control.hits) === JSON.stringify(want), 'positive control: each pattern found, a & i (char & int) not',
    control.hits.length ? `${control.hits.length} hit(s)` : 'nothing found');
}
{
  const { hits, ops, unparsed } = scan(units);
  const want = ['gelib.c:UnpackEGAShapeToScreen: mixed-sign char <', 'gelib.c:UnpackEGAShapeToScreen: mixed-sign char <'];
  report(JSON.stringify(hits) === JSON.stringify(want),
    `Keen Dreams: only the two plane loops of UnpackEGAShapeToScreen`, `${hits.length} hit(s) in ${ops} operations`);
  for (const h of hits) console.log(`       ${h}`);
  report(unparsed.join() === 'id_ca.c', 'every unit scanned but id_ca.c (sizeof in #if, refused by name)', unparsed.join(', '));
}

console.log(bad ? `\n${bad} WRONG` : '\nwhere Borland C++ 2.0 departs from C, Keen Dreams goes only where the two agree.');
process.exit(bad ? 1 : 0);
