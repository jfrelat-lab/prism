// gate-pixels.mjs — one renderer, three platform layers: the pictures must agree.
//
//   node tools/gate-pixels.mjs --data=<dir with id1/> [--frames=200] [--png=/tmp/diff]
//
// Quake's DOS, X11 and Win32 builds share every line of the renderer. What differs is the platform
// layer -- how a frame is presented, where the palette goes, which clock the game reads -- and all of
// that is PRISM's code, not id's. So the same demo at the same frame must produce the same pixels,
// and any difference is this project's, in a place a frame counter and an fps figure cannot see.
//
// It is the strongest oracle available here and it costs nothing to build, because the three targets
// already exist. It would have caught the WinQuake palette being four times too bright.
//
// Two things make the comparison mean something:
//
//   `+host_framerate` fixes the frame time. Sys_FloatTime reads the real clock on every platform, so
//   without it frame N lands wherever N rendered frames get to and depends on how fast the machine
//   is going -- which is how an earlier capture of mine disagreed with a later one for no reason at
//   all. With the frame time pinned, frame N is a property of the demo.
//
//   `-nocdaudio` skips the "Press a key" the DOS build shows when MSCDEX is absent. Waiting there is
//   correct behaviour and would simply never reach the demo.
//
// All three at 320x200, which took reading the game rather than writing a shim. WinQuake's windowed
// list looks fixed -- 320x240, 640x480, 800x600, written into vid_win.c:647 -- but modelist[2] is
// MODE_SETTABLE_WINDOW, and VID_CheckModedescFixup rebuilds it from the cvars `vid_config_x` and
// `vid_config_y` every time it is selected, with a floor of exactly 320x200 (vid_win.c:1031). So
//
//     +vid_stretch_by_2 0 +vid_config_x 320 +vid_config_y 200 +vid_mode 2
//
// is the game's own way of asking for that size, and no MGL fullscreen mode had to be invented for
// it. X11 gets there with -width/-height (vid_x.c:501); the DOS build is 320x200 already.
//
// Two things the first run of this gate taught, both of which would have made it lie:
//
//   COUNT FRAMES OF THE WORLD, not presented frames. At frame 120 the Win32 build was still showing
//   its console -- it prints more lines during start-up than the others and presents every one of
//   them -- so the three were being compared at different moments in the program. `R_RenderView` is
//   engine code, shared by all three, and runs only when the 3D view is drawn; counting IT aligns
//   them on the game rather than on the shell around it. It also needs no struct offsets, which is
//   the other reason to prefer it over reading `cls.demoplayback`.
//
//   COMPARE PALETTES AT SIX BITS. The DOS build writes its palette to the VGA DAC, which holds six
//   bits per component, so `VID_SetPalette` shifts Quake's 0..255 values down by two. X11 and Win32
//   keep all eight. Comparing the bytes raw made 691 of 768 differ and said nothing: they are not in
//   the same units. Six bits is what they share, and the two extra bits the DAC never had are not
//   evidence of anything.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { writeIndexedPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const opt = (n, d = null) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;

const dataDir = opt('data');
if (!dataDir) { console.error('need --data=<dir containing id1/>'); process.exit(2); }
const FRAMES = +(opt('frames') ?? 200);
const pngPrefix = opt('png');

const files = {};
(function walk(d, pre = '') {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`);
    else files[pre + f] = new Uint8Array(readFileSync(p));
  }
})(dataDir);

/* The same demo, pinned to the same frame time, on every platform. */
const COMMON = ['-nosound', '-nocdaudio', '+host_framerate', '0.05', '+con_notifytime', '0'];

/**
 * Run one platform to `FRAMES` presented frames and return what it was showing.
 *
 * Each platform presents through a different function, and that function IS the frame boundary --
 * XPutImage for an X client, VID_Update for the DOS build, MGL_bitBltCoord for the Win32 one. The
 * pixels and the palette then come from wherever that platform keeps them, which is the one part of
 * this file that has to know anything platform-specific.
 */
function capture(variant, extraArgs, envExtra = {}) {
  const target = loadTarget(join(ROOT, 'targets/quake.json'), variant);
  const { program } = buildTarget(target, {
    root: ROOT,
    envExtra: { stdio: { files: { ...files } }, ...envExtra },
  });
  program.M.write = () => {};

  /*
   * `frames` counts frames of the WORLD. The capture happens at the first present AFTER the Nth
   * R_RenderView, so every platform is stopped at the same point in the demo however many console
   * screens it drew on the way there.
   */
  let world = 0, armed = false, frames = 0;
  const rv = program.F.R_RenderView;
  if (!rv) throw new Error(`${variant}: no R_RenderView -- cannot align on the demo`);
  const rvw = function (...a) {
    const r = rv.apply(this, a);
    if (++world >= FRAMES) armed = true;
    return r;
  };
  program.F.R_RenderView = rvw;
  program.mod.bindFunc('R_RenderView', rvw);

  const done = () => { frames++; if (armed) throw new Error('__frames_done'); };
  /*
   * The boundary may be the PROGRAM's own function or one PRISM supplies -- VID_Update and
   * MGL_bitBltCoord are compiled from C, XPutImage comes from src/env/x11.js -- so both places are
   * looked in. Wrapping the wrong one is silent: the run simply never stops.
   */
  const wrap = (name, after) => {
    if (program.F[name]) {
      const inner = program.F[name];
      const w = function (...a) { const r = inner.apply(this, a); after(); done(); return r; };
      program.F[name] = w; program.mod.bindFunc(name, w);
      return;
    }
    const inner = program.M.rt[name];
    if (!inner) throw new Error(`${variant}: no ${name} to hook, in either the program or the runtime`);
    program.M.rt[name] = (...a) => { const r = inner(...a); after(); done(); return r; };
  };

  let read;
  if (variant === 'x11') {
    wrap('XPutImage', () => {});
    read = () => {
      const x = program.M.x11;
      return { w: x.width, h: x.height, at: x.imageData, palette: Uint8Array.from(x.palette) };
    };
  } else if (variant === 'win') {
    const sym = (n) => program.mod.symbols.get(n)?.addr ?? 0;
    const a = { s: sym('prism_mgl_surface'), w: sym('prism_mgl_width'),
                h: sym('prism_mgl_height'), p: sym('prism_mgl_pitch'), pal: sym('prism_mgl_palette') };
    wrap('MGL_bitBltCoord', () => {});
    read = () => {
      const dv = program.mod.dv;
      // MGL's palette_t is BGRA at the full 0..255 -- vid_win.c writes it with no shift.
      const palette = new Uint8Array(768);
      for (let i = 0; i < 256; i++) {
        palette[i * 3 + 0] = program.M.u8[a.pal + i * 4 + 2];
        palette[i * 3 + 1] = program.M.u8[a.pal + i * 4 + 1];
        palette[i * 3 + 2] = program.M.u8[a.pal + i * 4 + 0];
      }
      return { w: dv.getInt32(a.w, true), h: dv.getInt32(a.h, true),
               at: dv.getInt32(a.s, true), pitch: dv.getInt32(a.p, true), palette };
    };
  } else if (variant === 'dos') {
    wrap('VID_Update', () => {});
    read = () => {
      /*
       * Already in 0..255. The hardware's precision is six bits and vid_dos.c shifts Quake's values
       * down by two on the way in, but src/env/vgadac.js stores `(v & 0x3f) << 2` -- it puts them
       * back. Scaling again here was a second multiply nobody asked for, and it left 678 of 768
       * palette bytes "differing" between two builds that had set identical colours.
       */
      const palette = Uint8Array.from(program.M.dac?.palette ?? new Uint8Array(768));
      return { w: 320, h: 200, at: 0xa0000, palette };
    };
  } else {
    throw new Error(`no capture for variant '${variant}'`);
  }

  try { program.run(['quake', ...COMMON, ...extraArgs]); }
  catch (e) { if (e.message !== '__frames_done') return { error: e.message, frames }; }

  const s = read();
  const pitch = s.pitch ?? s.w;
  const pixels = new Uint8Array(s.w * s.h);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) pixels[y * s.w + x] = program.M.u8[s.at + y * pitch + x];
  }
  return { frames, world, width: s.w, height: s.h, pixels, palette: s.palette };
}

/**
 * WinQuake's own remap of palette index 0.
 *
 * vid_win.c:2117 says why: "GDI doesn't let us remap palette index 0, so we'll remap color mappings
 * from that black to another one". It then walks the WHOLE colormap and replaces every entry equal
 * to 0 with the index whose colour is closest to palette entry 0 -- 48 in ID1. So any pixel that
 * reached the screen THROUGH the colormap, which means the 3D view, is 48 on Windows where it is 0
 * on DOS and X11. This is id's code doing what id wrote, not a defect in the platform layer, and it
 * is why the Win32 comparison is asserted modulo exactly this substitution and nothing else.
 */
function winBlackRemap(palette) {
  let best = 0, metric = 256 * 256 * 3;
  for (let i = 1; i < 256; i++) {
    const dr = palette[0] - palette[i * 3], dg = palette[1] - palette[i * 3 + 1],
          db = palette[2] - palette[i * 3 + 2];
    const t = dr * dr + dg * dg + db * db;
    if (t < metric) { metric = t; best = i; if (t === 0) break; }
  }
  return best;
}

/**
 * Two captures, compared as pictures: the indices first, then the colours they name.
 *
 * `allow` names differences the platforms are ENTITLED to have. It is given the two indices and
 * says whether this one is expected; anything it does not claim counts against the gate.
 */
function compare(a, b, allow = null) {
  if (a.error || b.error) return { verdict: 'error', detail: a.error ?? b.error };
  if (a.width !== b.width || a.height !== b.height) {
    return { verdict: 'size', detail: `${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  let differing = 0, firstAt = -1, explained = 0;
  for (let i = 0; i < a.pixels.length; i++) {
    if (a.pixels[i] === b.pixels[i]) continue;
    if (allow && allow(a.pixels[i], b.pixels[i])) { explained++; continue; }
    if (firstAt < 0) firstAt = i;
    differing++;
  }
  // Six bits, which is what a VGA DAC holds and therefore all the three have in common.
  let palDiff = 0;
  for (let i = 0; i < 768; i++) if ((a.palette[i] >> 2) !== (b.palette[i] >> 2)) palDiff++;
  // Where they differ matters more than how many: a band of rows is a different thing from a
  // scatter, and the first tells you which part of the picture to look at.
  const rows = [];
  for (let y = 0; y < a.height; y++) {
    let n = 0;
    for (let x = 0; x < a.width; x++) {
      const i = y * a.width + x;
      if (a.pixels[i] !== b.pixels[i] && !(allow && allow(a.pixels[i], b.pixels[i]))) n++;
    }
    if (n) rows.push(`${y}:${n}`);
  }
  return { verdict: differing || palDiff ? 'differ' : 'identical', differing, explained, palDiff,
           firstAt, total: a.pixels.length, rows };
}

console.log(`Quake, one renderer over three platform layers — frame ${FRAMES}, ` +
  `args: ${COMMON.join(' ')}\n`);

const SETTABLE = ['+vid_stretch_by_2', '0', '+vid_config_x', '320', '+vid_config_y', '200',
                  '+vid_mode', '2'];
const runs = {
  x11: () => capture('x11', ['-width', '320', '-height', '200']),
  dos: () => capture('dos', []),
  win: () => capture('win', ['-window', ...SETTABLE]),
};
const got = {};
for (const [name, run] of Object.entries(runs)) {
  const t0 = performance.now();
  got[name] = run();
  const g = got[name];
  console.log(`  ${name.padEnd(12)} ${g.error ? `FAILED after ${g.frames} frames: ${g.error}`
    : `${g.width}x${g.height}, ${new Set(g.pixels).size} colours, ${g.world} world frames ` +
       `of ${g.frames} presented (${((performance.now() - t0) / 1000).toFixed(1)} s)`}`);
  if (pngPrefix && !g.error) {
    writeIndexedPng(`${pngPrefix}-${name.replace(/[@x]/g, '_')}.png`,
      { pixels: g.pixels, width: g.width, height: g.height, palette: g.palette });
  }
}

/*
 * X11 is the pivot: each other platform is compared against the run that matches its size.
 *
 * ALL THREE pairs are asserted. `x11 == dos` holds exactly -- 64,000 pixels and 768 palette bytes,
 * identical, on two platform layers that share nothing but the renderer. `x11 vs win` holds modulo
 * ONE named substitution, and the story of that number is the reason this gate was worth building.
 *
 * The Win32 picture differed from the other two in 1219 of 64,000 pixels. Six hypotheses were
 * measured and all six refuted:
 *
 *   - a phase offset (frame 60 is thirty times closer than 59 or 61);
 *   - a PRNG divergence (3 rand() calls before the first world frame, 66 by frame 60, on both);
 *   - the surface cache's SIZE (same D_SurfaceCacheForRes(320, 200) on both);
 *   - vid.numpages (vid_x.c:455 sets 2, vid_win.c:1353 sets 1 -- but vid_vga.c:365 sets 1 for DOS
 *     too, and DOS matches X11 exactly);
 *   - the Win32 build's three mode sets, all of which happen before world frame 0;
 *   - the surface cache's PLACEMENT and an uninitialised read. Both builds take it from the high
 *     hunk right after the z-buffer; tools/written.mjs showed 267 distinct blocks filled at the same
 *     offsets in the same order on both, and not one block was read without having been written.
 *
 * What the answer turned out to be, once every input to the rasteriser had been compared and found
 * equal -- span geometry, cachewidth, mip level, lightadj, d_lightstylevalue, dynamic lights, and
 * the texture bytes themselves -- was the ONE input that is not shared engine code: vid.colormap.
 * vid_win.c:2117 replaces every zero entry in it with the nearest colour to palette index 0, because
 * GDI will not let a program remap index 0. That is 48 in ID1, and every one of the 1219 pixels is
 * 0 on X11/DOS and 48 on Win32 -- not one is the other way round.
 *
 * So the difference is Quake's, not PRISM's, and the gate now asserts it in that exact shape: a
 * Win32 pixel may differ from an X11 one only by being the black-remap index where X11 has 0.
 * Anything else fails.
 */
const remap = got.x11.error ? 0 : winBlackRemap(got.x11.palette);
const pairs = [
  { a: 'x11', b: 'dos', assert: true },
  { a: 'x11', b: 'win', assert: true,
    allow: (l, r) => l === 0 && r === remap,
    note: `allowing X11's index 0 to be Win32's black remap, index ${remap}` },
];
let bad = 0;
console.log('');
for (const { a, b, assert: strict, allow, note } of pairs) {
  const r = compare(got[a], got[b], allow);
  if (note) console.log(`  (${note})`);
  if (r.verdict === 'identical') {
    console.log(`  ${a} == ${b}   identical, ${got[a].pixels.length} pixels and 768 palette bytes` +
      (r.explained ? `, plus ${r.explained} explained by the remap` : ''));
  } else {
    if (strict) bad++;
    console.log(`  ${a} != ${b}   ${r.verdict}` +
      (r.verdict === 'differ'
        ? `: ${r.differing} of ${r.total} pixels, ${r.palDiff}/768 palette bytes\n` +
          `                       rows: ${r.rows.slice(0, 14).join(' ')}${r.rows.length > 14 ? ` … (${r.rows.length} rows)` : ''}`
        : `: ${r.detail}`));
  }
}
const asserted = pairs.filter(p => p.assert).length;
console.log(bad ? `\n${bad} of ${asserted} asserted comparisons differ`
  : `\nall ${asserted} asserted comparisons agree`);
process.exit(bad ? 1 : 0);
