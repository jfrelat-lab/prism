// bracket-pixel.mjs — inside ONE frame, after which function do two platforms stop agreeing?
//
//   node tools/bracket-pixel.mjs <world frame> <x> <y> --data=<dir with id1/> [--pair=x11,dos]
//
// gate-pixels says WHETHER; trace-platforms says WHICH FRAME; this says WHICH FUNCTION.
//
// Stage two of the hunt. The value is sampled after every intercepted call, in order, on both
// platforms; the first position where the two sequences part names the function that wrote
// differently -- or the one that failed to write at all.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadTarget, buildTarget } from '/Users/julienfrelat/Projects/prism/src/target.js';

const ROOT = '/Users/julienfrelat/Projects/prism';
const opt = (n, d = null) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const dataDir = opt('data');
if (!dataDir) { console.error('need --data=<dir containing id1/>'); process.exit(2); }
// WHICH TWO platforms. Was hard-wired to win/x11, the pair the Win32 hunt needed; the dos/x11
// divergence at frame 90 needs the other pair, and the tool is the same tool.
const [A, B] = (opt('pair') ?? 'win,x11').split(',');
const TARGET_FRAME = +(process.argv.find(a => /^\d+$/.test(a)) ?? 3);
const files = {};
(function w(d, pre = '') {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) w(p, pre + f + '/'); else files[pre + f] = new Uint8Array(readFileSync(p));
  }
})(dataDir);

const COMMON = ['-nosound', '-nocdaudio', '+host_framerate', '0.05'];
const ARGS = {
  win: ['-window', '+vid_stretch_by_2', '0', '+vid_config_x', '320', '+vid_config_y', '200', '+vid_mode', '2'],
  x11: ['-width', '320', '-height', '200'],
  dos: [],
};
const WATCH = ['SCR_UpdateScreen', 'Draw_TileClear', 'V_RenderView', 'R_RenderView', 'R_EdgeDrawing',
  'R_RenderWorld', 'R_ScanEdges', 'D_DrawSurfaces', 'D_DrawSpans8', 'D_DrawZSpans',
  'R_AliasDrawModel', 'R_DrawViewModel', 'R_DrawParticles', 'Sbar_Draw', 'SCR_DrawConsole',
  'Draw_Character', 'Draw_Pic', 'SCR_DrawNet', 'SCR_CheckDrawCenterString'];

const positional = process.argv.slice(2).filter(a => /^\d+$/.test(a));
const PX = +(positional[1] ?? 160), PY = +(positional[2] ?? 22);

function trace(variant) {
  const { program } = buildTarget(loadTarget(join(ROOT, 'targets/quake.json'), variant),
    { root: ROOT, envExtra: { stdio: { files: { ...files } } } });
  program.M.write = () => {};
  /*
   * QUAKE'S OWN surface, not the platform's. `vid.buffer` is where the renderer writes and
   * `vid.rowbytes` is its pitch -- vid.h puts them at offsets 0 and 16 of viddef_t -- so one
   * accessor serves every platform, and it observes the pixel at the moment a rasteriser writes it
   * rather than after the platform has presented it. Reaching for each platform's own surface
   * instead is what made the DOS column read -1: its framebuffer address is not the one Quake draws
   * into until the mode is set.
   */
  const surface = () => {
    const vid = program.mod.symbols.get('vid')?.addr ?? 0;
    if (!vid) return { at: 0, pitch: 0 };
    const dv = program.mod.dv;
    return { at: dv.getInt32(vid, true), pitch: dv.getUint32(vid + 16, true) };
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

const w = trace(A), x = trace(B);
console.log(`pixel (${PX},${PY}) during world frame ${TARGET_FRAME}\n`);
const n = Math.max(w.length, x.length);
for (let i = 0; i < n; i++) {
  const mark = w[i] === x[i] ? '  ' : '->';
  console.log(`${mark} ${A}: ${(w[i] ?? '(none)').padEnd(34)} ${B}: ${x[i] ?? '(none)'}`);
}
