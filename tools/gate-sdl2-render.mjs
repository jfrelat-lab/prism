// gate-sdl2-render.mjs — what PRISM's SDL 2 answers about a renderer's logical size, and its
// SDL_PollEvent(NULL), are what the real SDL 2's are.
//
// tests/sdl2/render.c sets logical sizes on windows of every shape -- the same aspect at a whole and a
// fractional scale, wider, taller, neither dividing -- and prints SDL_RenderGetScale (the float's bits)
// and SDL_RenderGetViewport; then it pushes an event and polls with NULL twice before a real poll.
// It runs against the real SDL 2 in the oracle container (SDL_VIDEODRIVER=dummy) and through PRISM,
// and every line must be the same. Found by MIRAGE running Abuse on PRISM's SDL 2: Abuse scales its
// mouse by the scale and the viewport (PRISM answered 1 and the logical size), and its IsPending
// polls with NULL before each event it reads (PRISM's NULL poll took the event, so every click was lost).
//
// Controls: each answer swapped for the one PRISM gave before, the viewport rounded instead of
// truncated, and a display mode found for a window larger than the desktop.
//
//   node tools/gate-sdl2-render.mjs
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildTarget } from '../src/target.js';
import { up, sh, SCRATCH } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV = join(ROOT, 'src', 'env', 'sdl2.js');

up();
mkdirSync(join(SCRATCH, 'sdl2render'), { recursive: true });
copyFileSync(join(ROOT, 'tests', 'sdl2', 'render.c'), join(SCRATCH, 'sdl2render', 'render.c'));
const built = sh('cd /work/sdl2render && gcc -O1 -o render render.c -I/usr/include/SDL2 -lSDL2 2>&1');
if (built.code !== 0) { console.log(` BAD  the reference did not build:\n${built.stdout}${built.stderr}`); process.exit(1); }
const want = sh('cd /work/sdl2render && SDL_VIDEODRIVER=dummy ./render; echo "(exit $?)"').stdout;

function prism() {
  const target = { name: 'sdl2-render', dir: 'tests/sdl2', units: { list: ['render.c'] }, env: ['stdio', 'sdl2'], compile: { memory: 16 } };
  const { program } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files: {} } } });
  const r = program.run(['render']);
  return `${r.stdout}(exit ${r.code})\n`;
}

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${detail}`); };
const lines = want.split('\n');
report(lines.length >= 8 && want.includes('(exit 0)') && want.includes('poll NULL 1, NULL again 1, real 1'), 'the reference ran every scene', `${lines.length} lines`);
let got;
try { got = prism(); } catch (e) { got = `PRISM: ${e.message.split('\n')[0]}`; }
const mine = got.split('\n');
report(got === want, 'every answer is the real SDL 2\'s', `${lines.filter((l, i) => l === mine[i]).length} of ${lines.length} lines`);
if (got !== want) {
  for (let i = 0, shown = 0; i < Math.max(lines.length, mine.length) && shown < 6; i++) {
    if (lines[i] !== mine[i]) { console.log(`       line ${i + 1}\n         prism: ${JSON.stringify(mine[i])}\n         real : ${JSON.stringify(lines[i])}`); shown++; }
  }
}

// The controls edit the module's source, run it in a child process, and restore it.
const controls = [
  ['SDL_PollEvent(NULL) taking the event', '      if (!evt) return state.events.length ? 1 : 0;\n', ''],
  ['a scale of 1 whatever the logical size', '    if (!lw || !lh) return { scale: 1, x: 0, y: 0, w, h };', '    return { scale: 1, x: 0, y: 0, w: lw || w, h: lh || h };'],
  ['the viewport rounded, not truncated', 'Math.floor(v / g.scale)', 'Math.round(v / g.scale)'],
  ['a window larger than the desktop given its mode', '(state.winW | 0) > 1024 || (state.winH | 0) > 768', 'false'],
];
const original = readFileSync(ENV, 'utf8');
for (const [name, from, to] of controls) {
  if (!original.includes(from)) { report(false, `control: ${name}`, 'pattern not found'); continue; }
  writeFileSync(ENV, original.replace(from, to));
  let out;
  try {
    const r = spawnSync(process.execPath,
      ['--input-type=module', '-e', `import { buildTarget } from ${JSON.stringify(join(ROOT, 'src', 'target.js'))};
const { program } = buildTarget({ name: 'sdl2-render', dir: 'tests/sdl2', units: { list: ['render.c'] }, env: ['stdio', 'sdl2'], compile: { memory: 16 } }, { root: ${JSON.stringify(ROOT)}, envExtra: { stdio: { files: {} } } });
const r = program.run(['render']); process.stdout.write(r.stdout + '(exit ' + r.code + ')\\n');`], { encoding: 'utf8' });
    out = r.stdout || `threw: ${r.stderr.split('\n').find((l) => l.trim()) ?? ''}`;
  } finally { writeFileSync(ENV, original); }
  const differ = out.split('\n').filter((l, i) => l !== lines[i]).length;
  report(out !== want && !out.startsWith('threw'), `control: ${name}`, out.startsWith('threw') ? out.slice(0, 70) : `${differ} line(s) differ`);
}

if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nA logical size is scaled and viewported, and a NULL poll only looks, as SDL 2 does it.');
