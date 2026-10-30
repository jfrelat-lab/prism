// gl-bench.mjs — how much JavaScript an OpenGL program costs a frame on the page's WebGL path, with
// the vertex work done in JavaScript and with it done by the fixed-function vertex shader (P15.15).
//
// Each program of web/programs/ is built from its target with its data from --games, on gl.js's WebGL
// backend over a WebGL2 that does nothing -- so what is timed is the program and gl.js, never a GPU --
// and run for --warm frames (loading, the first map) and then --frames more, timed. Its clock is
// virtual (SDL's), or advanced a fixed step a call (id Tech 3's Sys_Milliseconds), so both runs of a
// program do the same work and show the same pictures. Frames are counted at the host's swap.
//
//   node tools/gl-bench.mjs [id ...] [--games=~/games] [--frames=300] [--warm=60] [--only=cpu|gpu]
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { virtualClock } from '../src/env/clock.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const GAMES = (arg('games') ?? join(homedir(), 'games')).replace(/^~/, homedir());
const FRAMES = +(arg('frames') ?? 300), WARM = +(arg('warm') ?? 60), ONLY = arg('only');
const IDS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// `data`: where the program's files are, when the descriptor's root holds an archive the page unpacks.
// `modulesIn`: where the program looks for its shared objects before it dlopens them (ET's access() check):
// an empty file of each module's name there, the module itself being linked in.
const PROGRAMS = { neverball: {}, tuxracer: {}, 'chromium-bsu': {}, cube: { data: 'cube/files/cube' }, quake3: {}, et: { modulesIn: 'etmain' }, hexen2: {} };

const noop = new Proxy({}, {
  get(_t, p) {
    if (typeof p !== 'string') return undefined;
    if (/^[A-Z0-9_]+$/.test(p)) return 1;
    return () => undefined;
  },
});
const context = new Proxy(noop, {
  get(t, p) {
    if (typeof p !== 'string') return undefined;
    if (/^[A-Z0-9_]+$/.test(p)) return 1;
    return (...a) => (/^(create|getUniformLocation)/.test(p) ? {} : /Parameter$/.test(p) ? true : undefined);
  },
});
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context; } };

function files(dir, mount = '') {
  const out = {};
  (function walk(d, pre) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`);
      else if (f !== 'PROVENANCE.txt') out[pre + f] = () => new Uint8Array(readFileSync(p));
    }
  })(dir, mount.replace(/^\//, ''));
  return out;
}

const withModules = (fs, target, dir) => {
  if (dir) for (const m of Object.values(target.modules ?? {})) if (m.soname) fs[`${dir}/${m.soname}`] = () => new Uint8Array(0);
  return fs;
};

function run(id, tnl) {
  const desc = JSON.parse(readFileSync(join(ROOT, 'web/programs', `${id}.json`), 'utf8'));
  const nd = desc.needsData ?? {};
  const dataDir = join(GAMES, PROGRAMS[id].data ?? nd.dir);
  if (!existsSync(dataDir)) return { skipped: `no ${dataDir}` };
  let n = 0, t0 = 0, ms = 0;
  const swap = () => {
    if (++n === WARM) t0 = performance.now();
    if (n === WARM + FRAMES) { ms = performance.now() - t0; throw new Error('__bench_done'); }
  };
  const clock = virtualClock();
  const target = loadTarget(join(ROOT, 'targets', `${desc.target}.json`));
  const built = buildTarget(target, { root: ROOT, envExtra: {
    stdio: { files: withModules(files(dataDir, nd.mount ?? ''), target, PROGRAMS[id].modulesIn), exactPaths: !!nd.exactPaths },
    gl: { backend: 'webgl', tnl }, sdl2: { clock }, sdl12: { clock },
    glx: { onSwap: swap }, wgl: { onSwap: swap },
  } });
  const { program, env } = built;
  // What the program prints, kept for a run that ends without its frames.
  let said = '';
  program.M.write = (text) => { said = (said + text).slice(-600); };
  if (env.sdl2gl) env.sdl2gl.onSwap = swap;
  if (program.M.sdl?.state && 'onSwap' in program.M.sdl.state) program.M.sdl.state.onSwap = swap;
  // id Tech 3 asks the time of its own clock: a fixed step a call, so a run is the same run every time.
  if (program.F.Sys_Milliseconds) { let now = 0; const f = () => (now += 16); program.F.Sys_Milliseconds = f; program.mod.bindFunc('Sys_Milliseconds', f); }
  const stats = program.M.gl.state.stats, before = { tri: 0, gpu: 0 };
  // The target's own arguments (Quake III's interpreted VMs), then the program's, as the page joins them.
  const args = `${target.args ?? ''} ${desc.args ?? ''}`.split(/\s+/).filter(Boolean);
  try { program.run([desc.target, ...args]); } catch (e) { if (!/__bench_done/.test(e.message)) return { error: e.message.slice(0, 160), frames: n }; }
  if (!ms) return { error: `only ${n} frames; it said: ${said.trim().split('\n').slice(-3).join(' | ')}`, frames: n };
  return { fps: FRAMES * 1000 / ms, ms, tri: stats.triangles - before.tri, gpu: stats.gpuDraws };
}

for (const id of IDS.length ? IDS : Object.keys(PROGRAMS)) {
  const out = [];
  for (const tnl of [false, true]) {
    if (ONLY && ONLY !== (tnl ? 'gpu' : 'cpu')) continue;
    const r = run(id, tnl);
    out.push(r);
    const tag = tnl ? 'gpu' : 'cpu';
    if (r.skipped) { console.log(`${id.padEnd(13)} ${tag}: skipped (${r.skipped})`); break; }
    if (r.error) { console.log(`${id.padEnd(13)} ${tag}: ${r.error} after ${r.frames} frames`); continue; }
    console.log(`${id.padEnd(13)} ${tag}: ${r.fps.toFixed(1).padStart(6)} frames a second of JavaScript (${FRAMES} frames in ${r.ms.toFixed(0)} ms; ${r.tri} triangles, ${r.gpu} drawn by the vertex shader)`);
  }
  if (out.length === 2 && out[0].fps && out[1].fps) console.log(`${id.padEnd(13)} x${(out[1].fps / out[0].fps).toFixed(2)}`);
}
