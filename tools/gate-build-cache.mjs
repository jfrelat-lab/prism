// gate-build-cache.mjs — the build cache (src/build-cache.js) gives back a build only while nothing
// it was made of has changed.
//
// A toy target in .oracle/build-cache-gate/ (two C units, a header found through an include path)
// built again and again, each check one way the cache could hand back a stale program:
//   1. a second build is a hit, and runs as the first did;
//   2. a header edited is a miss, and the program prints the new value;
//   3. a unit edited is a miss;
//   4. a new file that now SHADOWS the header (earlier on the include path) is a miss, and wins;
//   5. other compile options (safepoints) are another entry, not this one;
//   6. PRISM_BUILD_CACHE=0 compiles.
// Measured red: with the header replay in loadCached disabled, check 2 hands back the old program.
//
//   node tools/gate-build-cache.mjs
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, '.oracle/build-cache-gate');
let failed = 0;
const check = (ok, what, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail && !ok ? `\n       ${detail}` : ''}`); };

rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'inc'), { recursive: true });
mkdirSync(join(DIR, 'early'), { recursive: true });
// Every text carries this run's stamp: an entry an earlier run left must never be what a check finds.
const STAMP = `/* ${Date.now()} ${process.pid} */`;
const put = (f, text) => writeFileSync(join(DIR, f), `${text}${STAMP}\n`);
put('main.c', '#include <stdio.h>\n#include "value.h"\nint twice(int);\nint main(void) { printf("%d %d\\n", VALUE, twice(VALUE)); return 0; }\n');
put('twice.c', 'int twice(int x) { return 2 * x; }\n');
put('inc/value.h', '#define VALUE 21\n');
const target = { name: 'build-cache-gate', dir: '.oracle/build-cache-gate', units: { list: ['main.c', 'twice.c'] },
  include: ['early', 'inc'], env: ['stdio'], compile: { memory: 8 } };
const build = (extra = {}) => { const b = buildTarget(target, { root: ROOT, ...extra }); return { cached: !!b.program.cached, out: b.program.run(['t']).stdout.trim() }; };

const a = build(), b = build();
check(!a.cached && b.cached && a.out === '21 42' && b.out === a.out, 'a second build comes from the cache and runs as the first', JSON.stringify({ a, b }));
put('inc/value.h', '#define VALUE 5\n');
const c = build();
check(!c.cached && c.out === '5 10', 'a header edited is a miss, and the program sees it', JSON.stringify(c));
put('twice.c', 'int twice(int x) { return 3 * x; }\n');
const d = build();
check(!d.cached && d.out === '5 15', 'a unit edited is a miss', JSON.stringify(d));
build();
put('early/value.h', '#define VALUE 7\n');
const e = build();
check(!e.cached && e.out === '7 21', 'a new header that shadows the old one on the include path is a miss, and wins', JSON.stringify(e));
const f = build({ compile: { safepoints: true } });
check(!f.cached && f.out === '7 21', 'other compile options are another entry', JSON.stringify(f));
process.env.PRISM_BUILD_CACHE = '0';
const g = build();
delete process.env.PRISM_BUILD_CACHE;
check(!g.cached && g.out === '7 21', 'PRISM_BUILD_CACHE=0 compiles', JSON.stringify(g));

console.log(failed ? `gate-build-cache: ${failed} FAILED` : 'gate-build-cache: a build comes from the cache only while its sources, headers and options are the same');
process.exit(failed ? 1 : 0);
