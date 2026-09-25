// gate-borland-layout.mjs — Keen Dreams' own structures, laid out by Borland C++ and by PRISM.
//
// The layout rules PRISM uses for this target (dos16m, word alignment, int-sized enums, unsigned
// char -- the options kdreams.prj records, gate-borland-options) were measured against Watcom and
// argued for Borland. This asks Borland itself, about the program's OWN types: a probe that
// includes Keen's headers is compiled by BCC with Keen's options and RUN in DOSBox-X
// (tools/oracle-borland.mjs), printing the size of every named struct and union and the offset of
// every named member; PRISM parses the same probe with the target's options and computes the same
// numbers. Bar: exact, on every type.
//
// CAPTURE ONCE, REPLAY FOREVER: `--capture` needs Borland C++ 3.1 and dosbox-x (see
// oracle-borland.mjs) and writes goldens/borland-layout.json; a replay needs neither.
//
//   node tools/gate-borland-layout.mjs --capture [--bc=/path/to/BC31]
//   node tools/gate-borland-layout.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, makeResolver } from '../src/target.js';
import { envHeaders } from '../src/env/registry.js';
import { Preprocessor } from '../src/cpp/cpp.js';
import { parse } from '../src/parse/parser.js';
import { modelDefines } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'borland-layout.json');
const CORPUS = join(ROOT, 'corpus', 'KeenDreams');
// KD_DEF.H pulls in every ID_*.H, SOFT.H and SL_FILE.H. GELIB.H is left out: it defines Shape as
// SOFT.H does, and Keen's units include one or the other, never both.
const PROBE = '#include "KD_DEF.H"\n#include <dir.h>\n';
const PROBE_BCC = PROBE;
// Library types worth asking Borland about, beside the program's own: PRISM supplies these.
const LIBRARY_TYPES = ['struct ffblk', 'struct date', 'struct time'];

/** Is this type DEFINED in one of Keen's own headers (not PRISM's, not Borland's)? */
function keenOwns() {
  const text = readdirSync(CORPUS).filter((f) => /\.h$/i.test(f))
    .map((f) => readFileSync(join(CORPUS, f), 'latin1')).join('\n');
  return (key) => {
    if (LIBRARY_TYPES.includes(key)) return true;
    const m = /^(struct|union) (\w+)$/.exec(key);
    if (m) return new RegExp(`${m[1]}\\s+${m[2]}\\s*\\{`).test(text);
    return new RegExp(`\\}\\s*${key}\\s*[;,]`).test(text);
  };
}

/** Every named struct/union PRISM sees in the probe: name -> { size, members: [[name, offset]] }. */
function prismLayouts() {
  const t = loadTarget(join(ROOT, 'targets', 'keendreams.json'));
  const c = t.compile;
  const pp = new Preprocessor({ defines: { ...(t.defines ?? {}), ...modelDefines(c.model, c.signedChar) },
    resolve: makeResolver(CORPUS, t, new Set(), new Set(), envHeaders(t.env), new Set()) });
  const { unit, scope } = parse(pp.run(PROBE, join(CORPUS, 'probe.c')),
    { model: c.model, c89: !!c.c89, file: 'probe.c', signedChar: c.signedChar, enums: c.enums, pack: c.pack ?? null });
  const out = new Map();
  const seen = new Set();
  const visit = (ty, name) => {
    if (!ty || typeof ty !== 'object') return;
    if ((ty.k === 'struct' || ty.k === 'union') && ty.fields) {
      const key = name ?? (ty.tag ? `${ty.k} ${ty.tag}` : null);
      if (key && !out.has(key)) {
        out.set(key, {
          size: ty.size,
          members: ty.fields.filter((f) => f.name && !f.bitfield && f.bits === undefined).map((f) => [f.name, f.offset]),
        });
      }
      if (seen.has(ty)) return;
      seen.add(ty);
      for (const f of ty.fields) visit(f.type, null);
    }
    for (const k of ['to', 'of', 'ret']) visit(ty[k], null);
  };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type) visit(n.type, n.storage === 'typedef' ? n.name : null);
    for (const k of Object.keys(n)) if (k !== 'type' && k !== 'sym' && k !== 'loc') walk(n[k]);
  };
  // The file scope is the complete list: every typedef and every tag, whether anything uses it or not.
  for (const [name, e] of scope.ordinary) if (e.kind === 'typedef') visit(e.type, name);
  for (const [tag, ty] of scope.tags) visit(ty, ty.k === 'struct' || ty.k === 'union' ? `${ty.k} ${tag}` : null);
  walk(unit);
  const owns = keenOwns();
  return new Map([...out].filter(([k]) => owns(k)));
}

/** The probe program Borland runs: one line per type, `name|size|member=offset,...`. */
function probeProgram(layouts) {
  const lines = [];
  for (const [name, l] of layouts) {
    const T = name;
    const mem = l.members.map(([m]) => `printf(",${m}=%u", (unsigned)(char *)&((${T} *)0)->${m});`).join(' ');
    lines.push(`  printf("${name}|%u|", (unsigned)sizeof(${T})); ${mem} printf("\\n");`);
  }
  // KD_DEF.H declares `void main (void);`, so the probe's main is that.
  return `${PROBE_BCC}#include <stdio.h>\nvoid main(void)\n{\n${lines.join('\n')}\n}\n`;
}

async function capture() {
  const { bccRun, bccVersion, BC_DEFAULT } = await import('./oracle-borland.mjs');
  const bc = process.argv.find((a) => a.startsWith('--bc='))?.slice(5) ?? BC_DEFAULT;
  const layouts = prismLayouts();
  const prj = JSON.parse(readFileSync(join(ROOT, 'goldens', 'borland-prj.json'), 'utf8'));
  // Keen's own options, as its project records them -- minus the ones about debugging, output files
  // and precompiled headers, which change no layout.
  const options = prj.keendreams.filter((o) => /^-(m.|a|a-|K|b-?)$/.test(o));
  const [r] = bccRun([{ name: 'LAYOUT', source: probeProgram(layouts) }], { bc, options, includes: [CORPUS] });
  if (!r.compiled) { console.log(r.compileLog); process.exit(1); }
  const got = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^(.+?)\|(\d+)\|(.*)$/.exec(line.trim());
    if (!m) continue;
    got[m[1]] = { size: +m[2], members: m[3].split(',').filter(Boolean).map((x) => { const [n, o] = x.split('='); return [n, +o]; }) };
  }
  const golden = {
    _doc: `${bccVersion({ bc })}, options ${options.join(' ')} (from goldens/borland-prj.json), compiling a probe that `
      + 'includes Keen Dreams\' headers and RUNNING it in DOSBox-X (tools/gate-borland-layout.mjs --capture).',
    options,
    types: got,
  };
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 1)}\n`);
  console.log(`captured ${Object.keys(got).length} types -> goldens/borland-layout.json`);
}

if (process.argv.includes('--capture')) await capture();
if (!existsSync(GOLDEN)) { console.log('no goldens/borland-layout.json: run with --capture first'); process.exit(1); }
const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
const mine = prismLayouts();
let bad = 0, same = 0;
for (const [name, want] of Object.entries(g.types)) {
  const got = mine.get(name);
  const why = [];
  if (!got) why.push('PRISM does not see this type');
  else {
    if (got.size !== want.size) why.push(`size ${got.size} want ${want.size}`);
    for (const [m, off] of want.members) {
      const o = got.members.find(([n]) => n === m)?.[1];
      if (o !== off) why.push(`${m} at ${o} want ${off}`);
    }
  }
  if (why.length) { bad++; console.log(` BAD  ${name}: ${why.slice(0, 4).join('; ')}`); } else same++;
}
const extra = [...mine.keys()].filter((k) => !(k in g.types));
console.log(`${bad ? ' BAD ' : '  ok '} ${same}/${Object.keys(g.types).length} of Keen Dreams' types laid out exactly as Borland ${g.options.join(' ')} lays them out`);
if (extra.length) console.log(`       (${extra.length} type(s) PRISM sees that the golden lacks -- recapture: ${extra.slice(0, 5).join(', ')})`);
console.log(bad ? `\n${bad} WRONG` : '\nKeen Dreams\' structures are Borland\'s, member for member.');
process.exit(bad || extra.length ? 1 : 0);
