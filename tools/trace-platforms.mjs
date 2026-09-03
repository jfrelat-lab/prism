// trace-platforms.mjs — run one program on several platform layers and find where they first differ.
//
//   node tools/trace-platforms.mjs --data=<dir with id1/> [--frames=60]
//        [--platforms=x11,dos,win] [--trace=R_DrawSurface,D_CacheSurface] [--args="..."]
//
// gate-pixels.mjs says WHETHER the pictures agree. This says WHERE they stop agreeing, which is the
// question you have once they do not: at which frame, and -- if you name functions to watch -- which
// of them was called a different number of times on the way there.
//
// The signature per frame is a checksum of the framebuffer plus the call counts of whatever was
// named. Comparing checksums finds the first divergent frame in one run instead of a bisection by
// hand, and comparing counts at that frame says which part of the engine took a different path.
//
// ONE TRAP, and it is this project's own: PRISM emits DIRECT calls, so wrapping `program.F[name]`
// does not intercept a call made from another compiled function unless the rebinder reaches it. A
// count of zero here means "not intercepted", NOT "not called" -- an early hunt of mine read
// D_DrawParticle as 0 while R_DrawParticles was 60 and drew a conclusion from it. Anything reported
// as 0 is therefore marked, and a count that stays 0 on every platform proves nothing at all.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const opt = (n, d = null) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;

const dataDir = opt('data');
if (!dataDir) { console.error('need --data=<dir>'); process.exit(2); }
const FRAMES = +(opt('frames') ?? 60);
const PLATFORMS = (opt('platforms') ?? 'x11,dos,win').split(',').map(s => s.trim()).filter(Boolean);
const WATCH = (opt('trace') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const EXTRA = (opt('args') ?? '').split(/\s+/).filter(Boolean);

const files = {};
(function walk(d, pre = '') {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`);
    else files[pre + f] = new Uint8Array(readFileSync(p));
  }
})(dataDir);

const COMMON = ['-nosound', '-nocdaudio', '+host_framerate', '0.05'];

/* The size every platform can render, and how each is asked for it -- see gate-pixels.mjs. */
const ARGS = {
  x11: ['-width', '320', '-height', '200'],
  dos: [],
  win: ['-window', '+vid_stretch_by_2', '0', '+vid_config_x', '320', '+vid_config_y', '200',
        '+vid_mode', '2'],
};

/** Where each platform keeps the picture it has just presented. */
const SURFACE = {
  x11: (p) => ({ at: p.M.x11.imageData, w: p.M.x11.width, h: p.M.x11.height, pitch: p.M.x11.width }),
  dos: () => ({ at: 0xa0000, w: 320, h: 200, pitch: 320 }),
  win: (p) => {
    const s = (n) => p.mod.symbols.get(n)?.addr ?? 0;
    const dv = p.mod.dv;
    return { at: dv.getInt32(s('prism_mgl_surface'), true), w: dv.getInt32(s('prism_mgl_width'), true),
             h: dv.getInt32(s('prism_mgl_height'), true), pitch: dv.getInt32(s('prism_mgl_pitch'), true) };
  },
};
const BOUNDARY = { x11: 'XPutImage', dos: 'VID_Update', win: 'MGL_bitBltCoord' };

function run(variant) {
  const { program } = buildTarget(loadTarget(join(ROOT, 'targets/quake.json'), variant),
    { root: ROOT, envExtra: { stdio: { files: { ...files } } } });
  program.M.write = () => {};

  const counts = Object.fromEntries(WATCH.map(n => [n, 0]));
  const missing = [];
  for (const n of WATCH) {
    const f = program.F[n];
    if (!f) { missing.push(n); continue; }
    const g = function (...a) { counts[n]++; return f.apply(this, a); };
    program.F[n] = g; program.mod.bindFunc(n, g);
  }

  /* Frames of the WORLD, so the platforms line up on the game rather than on its start-up chatter. */
  let world = 0, armed = false;
  const rv = program.F.R_RenderView;
  const rvw = function (...a) { const r = rv.apply(this, a); if (++world >= FRAMES) armed = true; return r; };
  program.F.R_RenderView = rvw; program.mod.bindFunc('R_RenderView', rvw);

  const frames = [];
  const snap = () => {
    const s = SURFACE[variant](program);
    if (!s.at || !s.w) return;
    let sum = 0;
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) sum = (Math.imul(sum, 31) + program.M.u8[s.at + y * s.pitch + x]) >>> 0;
    }
    frames.push({ world, sum, counts: { ...counts } });
  };

  const name = BOUNDARY[variant];
  if (program.F[name]) {
    const inner = program.F[name];
    const w = function (...a) { const r = inner.apply(this, a); snap(); if (armed) throw new Error('__done'); return r; };
    program.F[name] = w; program.mod.bindFunc(name, w);
  } else {
    const inner = program.M.rt[name];
    program.M.rt[name] = (...a) => { const r = inner(...a); snap(); if (armed) throw new Error('__done'); return r; };
  }

  try { program.run(['quake', ...COMMON, ...(ARGS[variant] ?? []), ...EXTRA]); }
  catch (e) { if (e.message !== '__done') return { error: e.message, frames, missing }; }
  return { frames, missing, counts };
}

const got = {};
for (const p of PLATFORMS) {
  const t0 = performance.now();
  got[p] = run(p);
  const g = got[p];
  console.log(`${p.padEnd(4)} ${g.error ? `FAILED: ${g.error}`
    : `${g.frames.length} presented frames captured (${((performance.now() - t0) / 1000).toFixed(1)} s)` +
      (g.missing.length ? `  [not present: ${g.missing.join(' ')}]` : '')}`);
}

/*
 * The first world frame at which two platforms disagree. Frames are matched by their WORLD count, not
 * by position, because the platforms present a different number of console frames before the demo.
 */
const byWorld = (g) => {
  const m = new Map();
  for (const f of g.frames) if (!m.has(f.world)) m.set(f.world, f);
  return m;
};
const maps = Object.fromEntries(Object.entries(got).filter(([, g]) => !g.error).map(([k, g]) => [k, byWorld(g)]));
const names = Object.keys(maps);
console.log('');
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const [a, b] = [names[i], names[j]];
    /*
     * WHICH frames differ, not just the first. Two platforms can differ early and converge -- the
     * console screens before the demo are drawn at different rates and legitimately disagree -- so
     * "first divergence" answered frame 0 for every pair, including one that is pixel-identical by
     * the end. The run of frames where they agree is what says something.
     */
    const rows = [];
    for (const [w, fa] of maps[a]) {
      const fb = maps[b].get(w);
      if (fb) rows.push({ w, same: fa.sum === fb.sum, fa, fb });
    }
    rows.sort((x, y) => x.w - y.w);
    const same = rows.filter(r => r.same).length;
    const ranges = [];
    for (const r of rows) {
      if (r.same) continue;
      const last = ranges[ranges.length - 1];
      if (last && last[1] === r.w - 1) last[1] = r.w; else ranges.push([r.w, r.w]);
    }
    console.log(`  ${a} vs ${b}: ${same}/${rows.length} world frames agree` +
      (ranges.length ? `, differing at ${ranges.map(([x, y]) => (x === y ? x : `${x}-${y}`)).join(' ')}` : ''));

    // The counts at the LAST differing frame, which is the one still wrong when the run ends.
    const worst = rows.filter(r => !r.same).pop();
    if (worst) {
      for (const n of WATCH) {
        const x = worst.fa.counts[n], y = worst.fb.counts[n];
        const zero = x === 0 && y === 0 ? '   (0 on both — probably NOT intercepted; see the note)' : '';
        if (x !== y || zero) console.log(`      at frame ${worst.w}: ${n.padEnd(22)} ${a}=${x}  ${b}=${y}${zero}`);
      }
    }
  }
}
