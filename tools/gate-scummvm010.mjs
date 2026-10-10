// gate-scummvm010.mjs — ScummVM 0.10.0 builds whole from its C++ (P14.7).
//
//   1. config.h, config.mk and the object list are what the release's own configure and Makefile
//      write (tools/scummvm010-configure.mjs, in the oracle container), and targets/scummvm010.json
//      lists exactly those objects;
//   2. all 535 units -- thirteen engines and the SDL backend -- lower from C++ and compile, every
//      function is emitted, no name is unresolved, no header is missing, and there is a main: "nothing
//      unresolved" said nothing while the list missed the backend, whose sdl.cpp has main, since
//      nothing then called anything at all.
//
//   node tools/gate-scummvm010.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const SRC = join(ROOT, 'corpus/scummvm-0.10.0');

// ---- the child: the build, in its own process (it wants more heap than a gate runner starts with).
if (process.argv[2] === '--child') {
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const b = buildTarget(loadTarget(join(ROOT, 'targets/scummvm010.json')), { root: ROOT });
  process.stdout.write(JSON.stringify({
    functions: Object.keys(b.program.F).length,
    hasMain: 'main' in b.program.F,
    failures: (b.program.failures ?? []).map((x) => `${x.fn}: ${x.message}`),
    unresolved: (b.program.undefined ?? []).map((u) => u.name),
    missingHeaders: b.missingHeaders ?? [],
  }));
  process.exit(0);
}

if (!existsSync(SRC)) skip('no corpus/scummvm-0.10.0', 'fetch it with the `fetch` line of targets/scummvm010.json');

let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (detail) console.log(`       ${detail}`);
};

const conf = spawnSync('node', [join(ROOT, 'tools/scummvm010-configure.mjs'), '--check'], { encoding: 'utf8' });
check(conf.status === 0, "config.h, config.mk and the object list are what the release's configure and Makefile write", (conf.stdout + conf.stderr).trim());

const target = JSON.parse(readFileSync(join(ROOT, 'targets/scummvm010.json'), 'utf8'));
const { objs } = JSON.parse(readFileSync(join(ROOT, 'corpus/scummvm-0.10.0-generated/objs.json'), 'utf8'));
const listed = objs.map((o) => o.replace(/\.o$/, '.cpp'));
check(JSON.stringify(target.units.list) === JSON.stringify(listed), `targets/scummvm010.json lists the ${listed.length} units the Makefile names`);

const r = spawnSync('node', ['--max-old-space-size=8192', SELF, '--child'], { encoding: 'utf8', maxBuffer: 1 << 26 });
let b = {};
try { b = JSON.parse(r.stdout); } catch { b = { failures: [`the build did not report: ${(r.stderr || '').split('\n').slice(0, 3).join(' | ')}`] }; }
check(b.functions > 0 && b.hasMain && b.failures?.length === 0 && b.unresolved?.length === 0 && b.missingHeaders?.length === 0,
  `all ${listed.length} units lowered and compiled: ${b.functions ?? 0} functions, every one emitted, no name unresolved, no header missing, a main`,
  [...(b.failures ?? []), ...(b.unresolved ?? []), ...(b.missingHeaders ?? [])].slice(0, 6).join(' | '));

console.log(failed ? `gate-scummvm010: ${failed} FAILED` : `gate-scummvm010: ScummVM 0.10.0 builds whole, ${listed.length} units, ${b.functions} functions`);
process.exit(failed ? 1 : 0);
