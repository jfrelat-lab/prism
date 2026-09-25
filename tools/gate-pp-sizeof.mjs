// gate-pp-sizeof.mjs — `sizeof(T)` inside #if, answered from compile.ppSizeof, and the answer held true.
//
// Borland preprocessed and parsed in one pass, so `#if BUFFERSIZE < sizeof(maptype)` (Keen Dreams,
// id_ca.c:1471) meant something to it; a standalone preprocessor has no types. compile.ppSizeof
// lets a build STATE the sizes -- an option, like -D, and not a change to the source. A stated
// number is only worth having if it cannot be wrong, so this gate holds every entry of every target
// to two references:
//
//   * PRISM's own layout of that type, parsing the target's headers with the target's options
//   * Borland's, measured by running Borland C++ (goldens/borland-layout.json, gate-borland-layout)
//
// and checks the preprocessor side: a stated type is answered (unsigned, as a size_t is), a type not
// stated is refused by name, and with no table the old refusal stands.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Preprocessor } from '../src/cpp/cpp.js';
import { loadTarget, makeResolver } from '../src/target.js';
import { envHeaders } from '../src/env/registry.js';
import { parse } from '../src/parse/parser.js';
import { modelDefines } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(58)} ${detail}`);
};
const pp = (src, ppSizeof) => {
  try {
    return new Preprocessor({ ppSizeof }).run(src, 'p.c').map((t) => t.v).join(' ').trim();
  } catch (e) { return `refused: ${e.message}`; }
};

// 1. The preprocessor.
{
  const src = '#if 4096 < sizeof(maptype)\nyes\n#else\nno\n#endif\n';
  report(pp(src, { maptype: 38 }) === 'no', 'a stated size answers: 4096 < 38 is false', pp(src, { maptype: 38 }));
  report(pp(src, { maptype: 8192 }) === 'yes', '...and 4096 < 8192 is true', pp(src, { maptype: 8192 }));
  const neg = '#if sizeof(maptype) - 40 > 0\nwraps\n#else\nsigned\n#endif\n';
  report(pp(neg, { maptype: 38 }) === 'wraps', 'the size is unsigned, as a size_t: 38 - 40 > 0', pp(neg, { maptype: 38 }));
  const other = pp('#if sizeof(struct other) > 1\nx\n#endif\n', { maptype: 38 });
  report(other.includes('does not state') && other.includes("'struct other'"), 'a type not stated is refused by name', other.slice(0, 70));
  const none = pp(src, null);
  report(none.includes('Borland extension'), 'no table: the old refusal', none.slice(0, 70));
}

// 2. Every target's stated sizes, against PRISM and against Borland.
// Where each target's program sees its types: a unit including its headers.
const PROBES = { keendreams: '#include "KD_DEF.H"\n' };
const borland = JSON.parse(readFileSync(join(ROOT, 'goldens', 'borland-layout.json'), 'utf8')).types;
for (const f of readdirSync(join(ROOT, 'targets')).filter((x) => x.endsWith('.json'))) {
  const t = loadTarget(join(ROOT, 'targets', f));
  const c = t.compile ?? {};
  if (!c.ppSizeof) continue;
  const dir = join(ROOT, t.dir);
  const probe = PROBES[t.name];
  if (!probe) { report(false, `${t.name}: states ppSizeof but this gate has no probe for it`); continue; }
  const pre = new Preprocessor({ defines: { ...(t.defines ?? {}), ...modelDefines(c.model, c.signedChar) },
    resolve: makeResolver(dir, t, new Set(), new Set(), envHeaders(t.env), new Set()) });
  const { scope } = parse(pre.run(probe, join(dir, 'probe.c')),
    { model: c.model, c89: !!c.c89, file: 'probe.c', signedChar: c.signedChar, enums: c.enums, pack: c.pack ?? null });
  for (const [name, n] of Object.entries(c.ppSizeof)) {
    const m = /^(struct|union) (\w+)$/.exec(name);
    const ty = m ? scope.lookupTag(m[2]) : scope.lookup(name)?.type;
    report(ty?.size === n, `${t.name}: sizeof(${name}) stated ${n}, PRISM lays it out as`, `${ty?.size}`);
    report(borland[name]?.size === n, `${t.name}: sizeof(${name}) stated ${n}, Borland measured`, `${borland[name]?.size}`);
  }
}

console.log(bad ? `\n${bad} WRONG` : '\nsizeof in #if: answered where a build states it, and the statement is true.');
process.exit(bad ? 1 : 0);
