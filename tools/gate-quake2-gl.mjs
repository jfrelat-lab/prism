// gate-quake2-gl.mjs — Quake II's ref_gl (quake2:gl) on PRISM's OpenGL, held to the same build on Mesa.
//
// THE REFERENCE is Quake II 3.19 built in the oracle container the way linux/Makefile.i386 builds its
// GL client: the quake2 executable (-rdynamic, -ldl), and ref_gl.so and gamei386.so as shared
// objects dlopened by vid_so.c -- from the units targets/quake2.json:gl lists, against Mesa 22
// (llvmpipe). tools/oracle/q2-fxmesa-egl.c answers what that build links besides GL: fxMesa's
// full-screen context (a surfaceless EGL context and a framebuffer object), svgalib's keyboard and
// mouse as PRISM's shim answers them with nobody present, and a clock. Two build options keep the
// reference on the paths PRISM takes: __linux__ undefined (snd_mix.c picks its assembly by it, not by
// C_ONLY, and PRISM does not define it), and g_items.c compiled by tcc, because it declares three
// statics after non-static declarations, which gcc 12 refuses and the compilers of 1997 accepted.
// The installation is as a package left it: /etc/quake2.conf naming a root-owned ref_gl.so.
//
// Both builds run `+set vid_ref gl +map demo1` with Sys_Milliseconds stepped STEP ms per call
// (curtime kept, as q_shlinux.c keeps it) -- only the client and server call it -- and take the
// picture of fxMesaSwapBuffers number SWAP. Mesa advertises no extensions, as PRISM does.
//
// THE CLAIM: at most MAX_OFF of the pixels differ by more than TOL. On the first run: 3 of 307,200.
// Controls, which must be red: lightmaps not applied, and texture filtering forced to NEAREST.
//
// Needs Quake II's data (PRISM_QUAKE2_DATA, a directory with baseq2/pak0.pak) and SKIPS without it.
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { SVGALIB_HEADERS } from '../src/env/headers-svgalib.js';
import { FXMESA_H } from '../src/env/fxmesa.js';
import { up, sh, SCRATCH } from './oracle.mjs';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.PRISM_QUAKE2_DATA ?? join(process.env.HOME ?? '', 'games', 'quake2');
if (!existsSync(join(DATA, 'baseq2', 'pak0.pak'))) skip("Quake II's data: baseq2/pak0.pak", 'set PRISM_QUAKE2_DATA');
const SWAP = 120, STEP = 25, TOL = 8, MAX_OFF = 0.002;
const ARGS = ['+set', 'vid_ref', 'gl', '+map', 'demo1'];
const target = loadTarget(join(ROOT, 'targets', 'quake2.json'), 'gl');

// --- Mesa
up();
const work = join(SCRATCH, 'q2gl');
mkdirSync(work, { recursive: true });
cpSync(join(ROOT, 'corpus', 'Quake2'), join(work, 'src'), { recursive: true, filter: (p) => !p.includes('/.git') });
copyFileSync(join(ROOT, 'tools', 'oracle', 'q2-fxmesa-egl.c'), join(work, 'q2-fxmesa-egl.c'));
for (const [k, v] of Object.entries({ ...Object.fromEntries(['vga.h', 'vgakeyboard.h', 'vgamouse.h', 'asm/io.h'].map((h) => [h, SVGALIB_HEADERS[h]])), 'GL/fxmesa.h': FXMESA_H })) {
  mkdirSync(dirname(join(work, 'inc', k)), { recursive: true });
  writeFileSync(join(work, 'inc', k), v);
}
if (!existsSync(join(work, 'baseq2', 'pak0.pak'))) { mkdirSync(join(work, 'baseq2'), { recursive: true }); copyFileSync(join(DATA, 'baseq2', 'pak0.pak'), join(work, 'baseq2', 'pak0.pak')); }
const S = (l) => l.map((u) => `src/${u}`).join(' ');
const CF = '-w -O0 -fcommon -DC_ONLY -U__linux__ -Iinc -Isrc';
const steps = [
  'tcc -w -c -fPIC -DC_ONLY -Isrc -o g_items.o src/game/g_items.c',
  `gcc ${CF} -fPIC -shared -o gamei386.so ${S([...target.modules.game.units.filter((u) => u !== 'game/g_items.c'), 'game/q_shared.c', 'game/m_flash.c'])} g_items.o -lm`,
  `gcc ${CF} -fPIC -shared -o ref_gl.so ${S([...target.modules.ref_gl.units, 'game/q_shared.c', 'linux/q_shlinux.c', 'linux/glob.c'])} -lOpenGL -lm`,
  `gcc ${CF} -rdynamic -o quake2 ${S(target.units.list)} q2-fxmesa-egl.c -Wl,--wrap=Sys_Milliseconds -ldl -lEGL -lOpenGL -lm`,
];
for (const c of steps) {
  const r = sh(`cd /work/q2gl && ${c}`, { timeout: 600000 });
  if (r.code !== 0) throw new Error(`reference build: ${c.slice(0, 50)}: ${(r.stderr || r.stdout).slice(-1500)}`);
}
const run = sh('cd /work/q2gl && mkdir -p /tmp/q2lib && cp ref_gl.so /tmp/q2lib/ && echo /tmp/q2lib > /etc/quake2.conf && cp gamei386.so baseq2/ && rm -f frame.ppm && '
  + `MESA_EXTENSION_MAX_YEAR=1990 PRISM_Q2_SWAP=${SWAP} PRISM_Q2_STEP=${STEP} ./quake2 ${ARGS.join(' ')} > run.log 2>&1`, { timeout: 600000 });
if (run.code !== 0 || !existsSync(join(work, 'frame.ppm'))) throw new Error(`reference run: exit ${run.code}, see .oracle/q2gl/run.log`);
const ppm = readFileSync(join(work, 'frame.ppm')), m = ppm.toString('latin1', 0, 32).match(/^P6\n(\d+) (\d+)\n255\n/);
const mesa = { w: +m[1], h: +m[2], rgb: ppm.subarray(m[0].length) };

// --- PRISM
const files = {};
(function walk(d, pre = '') {
  for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`); else if (!/\.exe$/i.test(f)) files[pre + f] = new Uint8Array(readFileSync(p)); }
})(DATA);
for (const [name, text] of Object.entries(target.files ?? {})) if (!(name in files)) files[name] = new TextEncoder().encode(`${text}\n`);
function prism(mutate = null) {
  let pic = null;
  const { program } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files }, fxmesa: {
    onSwap: (n, gl) => { if (n >= SWAP) { pic = gl.readPixels(); throw new Error('__done'); } } } } });
  program.M.write = () => {};
  let now = 0;
  const cur = program.mod.symbols.get('curtime')?.addr;
  const ms = () => { now += STEP; if (cur) program.mod.dv.setInt32(cur, now, true); return now; };
  program.F.Sys_Milliseconds = ms; program.mod.bindFunc('Sys_Milliseconds', ms);
  if (mutate) {
    mutate(program.M);
    // ref_gl calls GL through pointers whose slots were bound before the mutation: point them at it.
    for (const [name] of program.mod.funcs) {
      const base = name.slice(name.lastIndexOf('$') + 1);
      if (base === 'glBlendFunc' || base === 'glTexParameterf') program.mod.bindFunc(name, program.M.rt[base]);
    }
  }
  try { program.run(['quake2', ...ARGS]); } catch (e) { if (e.message !== '__done') throw e; }
  return pic;
}
const N = mesa.w * mesa.h;
const compare = (p) => {
  let off = 0, any = 0;
  for (let i = 0; i < N; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(p[4 * i + k] - mesa.rgb[3 * i + k]));
    if (d > TOL) off++;
    if (d) any++;
  }
  return { off, any };
};
let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(60)} ${detail}`); };
const c = compare(prism());
report(c.off / N <= MAX_OFF, `swap ${SWAP} of demo1: PRISM's picture is Mesa's`, `${c.off} of ${N} pixels off by more than ${TOL} (${c.any} differ at all)`);
const CONTROLS = [
  // ref_gl's lightmap pass: glBlendFunc(GL_ZERO, GL_SRC_COLOR); read as (ONE, ZERO) it paints over.
  ['lightmaps not applied (their blend ignored)', (M) => { const b = M.rt.glBlendFunc; M.rt.glBlendFunc = (s, d) => (s === 0 && d === 0x300 ? b(1, 0) : b(s, d)); }],
  ['texture filtering forced to NEAREST', (M) => { const t = M.rt.glTexParameterf; M.rt.glTexParameterf = (tg, p, v) => t(tg, p, p === 0x2800 || p === 0x2801 ? 0x2600 : v); }],
];
for (const [name, mutate] of CONTROLS) {
  const k = compare(prism(mutate));
  report(k.off / N > MAX_OFF, `control: ${name} is told apart`, `${k.off} off`);
}
console.log(bad ? `\n${bad} WRONG` : "\nQuake II's ref_gl draws on PRISM what it draws on Mesa.");
process.exit(bad ? 1 : 0);
