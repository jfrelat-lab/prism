// gate-cube.mjs — Cube (2005_08_29) builds whole from its C++ (P15.12).
//
//   targets/cube.json lists exactly src/Makefile's CLIENT_OBJS and ENet's libenet sources (less
//   win32.c, all #ifdef WIN32), and every unit lowers and compiles with zlib 1.1.3 beside it: every
//   function emitted, no name unresolved -- functions AND variables -- and a main. "Nothing
//   unresolved" says nothing of a program that never calls anything, hence the main.
//
// Running it waits on a JPEG decoder: 568 of its textures are JPEG, and IMG_Load decodes PNG only.
//
//   node tools/gate-cube.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const SRC = join(ROOT, 'corpus/cube_2005_08_29');

if (process.argv[2] === '--child') {
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const b = buildTarget(loadTarget(join(ROOT, 'targets/cube.json')), { root: ROOT });
  process.stdout.write(JSON.stringify({
    functions: Object.keys(b.program.F).length,
    hasMain: 'main' in b.program.F,
    failures: (b.program.failures ?? []).map((x) => `${x.fn}: ${x.message}`),
    unresolved: [...(b.program.undefined ?? []), ...(b.program.undefinedVars ?? [])].map((u) => u.name),
    missingHeaders: b.missingHeaders ?? [],
  }));
  process.exit(0);
}

if (!existsSync(SRC)) skip('no corpus/cube_2005_08_29', 'unpack cube_2005_08_29_src.zip there (the `fetch` line of targets/cube.json)');

let failed = 0;
const check = (ok, what, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail && !ok ? `\n       ${detail}` : ''}`); };

// The unit list is the Makefile's.
const mk = readFileSync(join(SRC, 'src/Makefile'), 'utf8');
const objs = mk.slice(mk.indexOf('CLIENT_OBJS='), mk.indexOf('SERVER_LIBS')).match(/\b\w+\.o\b/g).map((o) => `src/${o.replace(/\.o$/, '.cpp')}`);
const am = readFileSync(join(SRC, 'enet/Makefile.am'), 'utf8').match(/libenet_a_SOURCES\s*=\s*(.*)/)[1].split(/\s+/).filter((f) => f && f !== 'win32.c').map((f) => `enet/${f}`);
const target = JSON.parse(readFileSync(join(ROOT, 'targets/cube.json'), 'utf8'));
check(JSON.stringify([...target.units.list].sort()) === JSON.stringify([...objs, ...am].sort()),
  `targets/cube.json lists the Makefile's ${objs.length} CLIENT_OBJS and ENet's ${am.length} sources`);

const r = spawnSync('node', ['--max-old-space-size=8192', SELF, '--child'], { encoding: 'utf8', maxBuffer: 1 << 26 });
let b = {};
try { b = JSON.parse(r.stdout); } catch { b = { failures: [`the build did not report: ${(r.stderr || '').split('\n').slice(0, 3).join(' | ')}`] }; }
check(b.functions > 0 && b.hasMain && b.failures?.length === 0 && b.unresolved?.length === 0 && b.missingHeaders?.length === 0,
  `all ${target.units.list.length} units and zlib lowered and compiled: ${b.functions ?? 0} functions, every one emitted, no name unresolved, no header missing, a main`,
  [...(b.failures ?? []), ...(b.unresolved ?? []), ...(b.missingHeaders ?? [])].slice(0, 6).join(' | '));

console.log(failed ? `gate-cube: ${failed} FAILED` : `gate-cube: Cube builds whole, ${b.functions} functions`);
process.exit(failed ? 1 : 0);
