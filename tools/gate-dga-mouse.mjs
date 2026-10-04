// gate-dga-mouse.mjs — the XFree86-DGA mouse reports motion as deltas, and only while it is on.
//
// GLQuake, Quake III and Enemy Territory read the mouse through XFree86-DGA by default. PRISM's
// Xlib used to answer "no such extension", which sent them to their fallback: warp the pointer to
// the centre and wait for the MotionNotify a real server sends for the warp. This Xlib sends none,
// so Enemy Territory queued no mouse movement at all -- its menu cursor never left the corner, and
// nothing in its first dialog could be clicked or typed into.
//
// There is NO external reference here: DGA 1 is gone from every X server one could run today. What
// this holds is the contract as XF86DGA(3) states it and as the three games read it -- a
// MotionNotify under XF86DGADirectMouse carries the motion in x/y and in x_root/y_root -- against a
// scripted host mouse, with the same script in position mode on either side of it.
//
//   node tools/gate-dga-mouse.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* The host's mouse: one delta each time the client drains its queue, then a click. */
function run({ dga = true } = {}) {
  const moves = [[5, -3], [0, 0], [2, 7], [-4, 1], [0, 0], [6, 6], [1, -2], [0, 0], [3, 3], [0, 0]];
  const levels = [0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
  let i = 0, pendingMove = null;
  const mouse = {
    take: () => { if (pendingMove === null) pendingMove = moves[Math.min(i, moves.length - 1)]; const [dx, dy] = pendingMove; pendingMove = [0, 0]; return { dx, dy }; },
    state: () => levels[Math.min(i, levels.length - 1)],
  };
  const target = { name: 'dgamouse', dir: 'tests/x11', units: { list: ['dgamouse.c'] }, env: ['stdio', 'x11', 'gl', 'glx'], compile: { memory: 16 } };
  const { program } = buildTarget(target, { root: ROOT, envExtra: { x11: { mouse }, gl: { backend: 'soft' } } });
  // One script step per drain: the client's XPending going false is the end of a step.
  const pending = program.M.rt.XPending;
  const step = (dpy) => { const n = pending(dpy); if (!n) { i++; pendingMove = null; } return n; };
  program.M.rt.XPending = step;
  for (const [name] of program.mod.funcs) if (name === 'XPending' || name.endsWith('$XPending')) program.mod.bindFunc(name, step);
  if (!dga) {
    program.M.rt.XF86DGADirectVideo = () => 1;             // accepted, and nothing switched
    for (const [name] of program.mod.funcs) if (name.endsWith('XF86DGADirectVideo')) program.mod.bindFunc(name, program.M.rt.XF86DGADirectVideo);
  }
  return program.run(['dgamouse']).stdout;
}

const WANT = `DGA 1.0
position motion x 105 y 77 root 0 0
position motion x 107 y 84 root 0 0
direct mouse: 1
dga motion x -4 y 1 root -4 1
dga press 1
dga motion x 6 y 6 root 6 6
dga release 1
dga motion x 1 y -2 root 1 -2
off: 1
position motion x 110 y 87 root 0 0
`;

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(60)} ${detail}`); };
let got;
try { got = run(); } catch (e) { got = `PRISM: ${e.message.split('\n')[0]}`; }
const a = WANT.split('\n'), b = got.split('\n');
report(got === WANT, 'deltas under the DGA mouse, positions on either side of it', `${a.filter((l, k) => l === b[k]).length} of ${a.length} lines`);
if (got !== WANT) for (let k = 0; k < Math.max(a.length, b.length); k++) if (a[k] !== b[k]) console.log(`       line ${k + 1}\n         got : ${JSON.stringify(b[k])}\n         want: ${JSON.stringify(a[k])}`);
let plain;
try { plain = run({ dga: false }); } catch (e) { plain = `threw: ${e.message.split('\n')[0]}`; }
report(plain !== WANT && !plain.startsWith('threw'), 'control: DirectMouse accepted but not switched on is told apart', `${plain.split('\n').filter((l, k) => l !== a[k]).length} line(s) differ`);

if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nThe DGA mouse reports motion the way its clients read it.');
