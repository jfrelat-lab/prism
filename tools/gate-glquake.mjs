// gate-glquake.mjs — GLQuake (quake:glx) on PRISM's OpenGL, held to the SAME source built against Mesa.
//
// THE REFERENCE is GLQuake compiled by gcc in the oracle container from the same units
// (targets/quake.json:glx, -DGLQUAKE, id386=0 by leaving __i386__ undefined as PRISM does), linked to
// Mesa 22 (llvmpipe) through tools/oracle/glx-egl.c: GLX on a surfaceless EGL context, X answered as
// PRISM's X11 shim answers it. Both builds run the demo with Quake's own arguments for a fixed frame
// time and Sys_FloatTime stepped 1/72 s per call (gate-pixels' recipe; --wrap on the Mesa side), and
// both take the picture at the glXSwapBuffers after world frame WORLD. Mesa is told to advertise no
// extensions (MESA_EXTENSION_MAX_YEAR=1990), as PRISM advertises none -- which also keeps GLQuake's
// Con_Printf of the extension string inside its 4096-byte buffer, where Mesa's full list overflows it.
//
// THE CLAIM: at most MAX_OFF of the pixels differ by more than TOL in any channel. On the first run:
// 1 of 307,200. Two real defects are red controls: lightmaps not applied (their blend ignored), and
// texture filtering forced to NEAREST.
//
// Needs the data (PRISM_QUAKE_DATA, a directory with id1/ or ID1/) and SKIPS without it.
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { GLX_HEADERS } from '../src/env/headers-gl.js';
import { up, sh, SCRATCH } from './oracle.mjs';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.PRISM_QUAKE_DATA;
const id1 = DATA && ['id1', 'ID1'].map((d) => join(DATA, d)).find(existsSync);
if (!id1) skip("Quake's data: a directory containing id1/", 'set PRISM_QUAKE_DATA');
const WORLD = 40, TOL = 8, MAX_OFF = 0.002;
const ARGS = ['-nosound', '-nocdaudio', '+host_framerate', '0.05', '+con_notifytime', '0'];

// --- Mesa
up();
const work = join(SCRATCH, 'glquake');
mkdirSync(join(work, 'inc', 'X11', 'extensions'), { recursive: true });
cpSync(join(ROOT, 'corpus', 'Quake', 'WinQuake'), join(work, 'src'), { recursive: true });
copyFileSync(join(ROOT, 'tools', 'oracle', 'glx-egl.c'), join(work, 'glx-egl.c'));
for (const h of ['xf86dga.h', 'xf86vmode.h']) writeFileSync(join(work, 'inc', 'X11', 'extensions', h), GLX_HEADERS[`X11/extensions/${h}`]);
if (!existsSync(join(work, 'id1'))) cpSync(id1, join(work, 'id1'), { recursive: true });
const target = loadTarget(join(ROOT, 'targets', 'quake.json'), 'glx');
const units = target.units.list.map((u) => `src/${u}`).join(' ');
const build = sh(`cd /work/glquake && gcc -w -O0 -fcommon -DGLQUAKE -U__i386__ -Ui386 -Iinc -Isrc -o glquake ${units} glx-egl.c `
  + '-Wl,--wrap=R_RenderView -Wl,--wrap=Sys_FloatTime -Wl,--wrap=glDrawBuffer -Wl,--wrap=glReadBuffer -lEGL -lOpenGL -lm', { timeout: 600000 });
if (build.code !== 0) throw new Error(`reference build: ${build.stderr || build.stdout}`);
const run = sh(`cd /work/glquake && rm -f frame.ppm && MESA_EXTENSION_MAX_YEAR=1990 PRISM_GLX_WORLD=${WORLD} ./glquake -basedir . ${ARGS.join(' ')} > run.log 2>&1`, { timeout: 600000 });
if (run.code !== 0 || !existsSync(join(work, 'frame.ppm'))) throw new Error(`reference run: exit ${run.code}, see .oracle/glquake/run.log`);
const ppm = readFileSync(join(work, 'frame.ppm')), m = ppm.toString('latin1', 0, 32).match(/^P6\n(\d+) (\d+)\n255\n/);
const mesa = { w: +m[1], h: +m[2], rgb: ppm.subarray(m[0].length) };

// --- PRISM
const files = {};
(function walk(d, pre = '') {
  for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`); else files[pre + f] = new Uint8Array(readFileSync(p)); }
})(DATA);
function prism(mutate = null) {
  let world = 0, pic = null;
  const { program } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files }, glx: {
    onSwap: (_n, gl) => { if (world >= WORLD) { pic = gl.readPixels(); throw new Error('__done'); } } } } });
  program.M.write = () => {};
  let ticks = 0;
  const fake = () => ++ticks / 72;
  program.F.Sys_FloatTime = fake; program.mod.bindFunc('Sys_FloatTime', fake);
  const rv = program.F.R_RenderView;
  const rvw = function (...a) { const r = rv.apply(this, a); world++; return r; };
  program.F.R_RenderView = rvw; program.mod.bindFunc('R_RenderView', rvw);
  if (mutate) mutate(program.M);
  try { program.run(['quake', ...ARGS]); } catch (e) { if (e.message !== '__done') throw e; }
  return pic;
}
const compare = (p) => {
  let off = 0, any = 0;
  for (let i = 0; i < mesa.w * mesa.h; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(p[4 * i + k] - mesa.rgb[3 * i + k]));
    if (d > TOL) off++;
    if (d) any++;
  }
  return { off, any };
};
let bad = 0;
const N = mesa.w * mesa.h;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(60)} ${detail}`); };
const c = compare(prism());
report(c.off / N <= MAX_OFF, `world frame ${WORLD}: PRISM's picture is Mesa's`, `${c.off} of ${N} pixels off by more than ${TOL} (${c.any} differ at all)`);
const CONTROLS = [
  ['lightmaps not applied (their blend ignored)', (M) => { const b = M.rt.glBlendFunc; M.rt.glBlendFunc = (s, d) => b(s === 0 && d === 0x301 ? 0 : s, s === 0 && d === 0x301 ? 1 : d); }],
  ['texture filtering forced to NEAREST', (M) => { const t = M.rt.glTexParameterf; M.rt.glTexParameterf = (tg, p, v) => t(tg, p, p === 0x2800 || p === 0x2801 ? 0x2600 : v); }],
];
for (const [name, mutate] of CONTROLS) {
  const k = compare(prism(mutate));
  report(k.off / N > MAX_OFF, `control: ${name} is told apart`, `${k.off} off`);
}
console.log(bad ? `\n${bad} WRONG` : '\nGLQuake draws on PRISM what it draws on Mesa.');
process.exit(bad ? 1 : 0);
