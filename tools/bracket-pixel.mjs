// bracket-pixel.mjs — inside ONE frame, after which function do two platforms stop agreeing?
//
//   node tools/bracket-pixel.mjs <world frame> <x> <y>
//
// gate-pixels says WHETHER; trace-platforms says WHICH FRAME; this says WHICH FUNCTION.
//
// Stage two of the hunt. The value is sampled after every intercepted call, in order, on both
// platforms; the first position where the two sequences part names the function that wrote
// differently -- or the one that failed to write at all.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadTarget, buildTarget } from '/Users/julienfrelat/Projects/prism/src/target.js';

const ROOT = '/Users/julienfrelat/Projects/prism';   // TODO: take --data like its siblings
const TARGET_FRAME = +(process.argv[2] ?? 3);
const files = {};
(function w(d, pre = '') {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) w(p, pre + f + '/'); else files[pre + f] = new Uint8Array(readFileSync(p));
  }
})('/Users/julienfrelat/quake');

const COMMON = ['-nosound', '-nocdaudio', '+host_framerate', '0.05'];
const ARGS = {
  win: ['-window', '+vid_stretch_by_2', '0', '+vid_config_x', '320', '+vid_config_y', '200', '+vid_mode', '2'],
  x11: ['-width', '320', '-height', '200'],
};
const WATCH = ['SCR_UpdateScreen', 'Draw_TileClear', 'V_RenderView', 'R_RenderView', 'R_EdgeDrawing',
  'R_RenderWorld', 'R_ScanEdges', 'D_DrawSurfaces', 'D_DrawSpans8', 'D_DrawZSpans',
  'R_AliasDrawModel', 'R_DrawViewModel', 'R_DrawParticles', 'Sbar_Draw', 'SCR_DrawConsole',
  'Draw_Character', 'Draw_Pic', 'SCR_DrawNet', 'SCR_CheckDrawCenterString'];

const PX = +(process.argv[3] ?? 160), PY = +(process.argv[4] ?? 22);

function trace(variant) {
  const { program } = buildTarget(loadTarget(join(ROOT, 'targets/quake.json'), variant),
    { root: ROOT, envExtra: { stdio: { files: { ...files } } } });
  program.M.write = () => {};
  const surface = () => {
    if (variant === 'x11') return { at: program.M.x11.imageData, pitch: program.M.x11.width };
    const s = (n) => program.mod.symbols.get(n)?.addr ?? 0;
    const dv = program.mod.dv;
    return { at: dv.getInt32(s('prism_mgl_surface'), true), pitch: dv.getInt32(s('prism_mgl_pitch'), true) };
  };
  const value = () => { const s = surface(); return s.at ? program.M.u8[s.at + PY * s.pitch + PX] : -1; };

  let world = 0, recording = false;
  const log = [];
  for (const n of WATCH) {
    const f = program.F[n];
    if (!f) continue;
    const g = function (...a) {
      const before = recording ? value() : -1;
      const r = f.apply(this, a);
      if (recording) { const after = value(); if (after !== before) log.push(`${n}: ${before}->${after}`); }
      return r;
    };
    program.F[n] = g; program.mod.bindFunc(n, g);
  }
  const rv = program.F.R_RenderView;
  const rw = function (...a) {
    // The frame we want is the one that ENDS at TARGET_FRAME, so recording starts just before it.
    recording = (world === TARGET_FRAME - 1);
    const r = rv.apply(this, a);
    if (++world > TARGET_FRAME) throw new Error('__done');
    return r;
  };
  program.F.R_RenderView = rw; program.mod.bindFunc('R_RenderView', rw);
  try { program.run(['quake', ...COMMON, ...ARGS[variant]]); } catch (e) { if (e.message !== '__done') throw e; }
  return log;
}

const w = trace('win'), x = trace('x11');
console.log(`pixel (${PX},${PY}) during world frame ${TARGET_FRAME}\n`);
const n = Math.max(w.length, x.length);
for (let i = 0; i < n; i++) {
  const mark = w[i] === x[i] ? '  ' : '->';
  console.log(`${mark} win: ${(w[i] ?? '(none)').padEnd(34)} x11: ${x[i] ?? '(none)'}`);
}
