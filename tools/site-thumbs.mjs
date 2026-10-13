// site-thumbs.mjs — the showcase's thumbnails, drawn by PRISM itself: frame N of each program in
// tools/site-programs.json that names `thumb: { frames }`, headless, into dist/site-thumbs/<id>.png,
// where tools/site.mjs picks them up.
//
//   node tools/site-thumbs.mjs [--games=~/games] [--only=id,id]
//
// A GLUT program is run here with glut.js's own frame hook (the schedule gate-gears uses). Anything
// else goes through tools/build.mjs --run --frames --png, which knows each host's present call, on a
// virtual clock, with a time limit: a program that never presents is a missing thumbnail, not a hang.
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { writeRgbPng } from './png.mjs';
import { virtualClock } from '../src/env/clock.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const GAMES = resolve((arg('games') ?? join(homedir(), 'games')).replace(/^~/, homedir()));
const ONLY = arg('only')?.split(',');
const OUT = join(ROOT, 'dist/site-thumbs');
mkdirSync(OUT, { recursive: true });

const { programs } = JSON.parse(readFileSync(join(ROOT, 'tools/site-programs.json'), 'utf8'));
// `thumb.page`: a thumbnail taken in the page by hand, where no headless run reaches the picture.
for (const e of programs.filter((p) => !p._skip && p.thumb?.frames && (!ONLY || ONLY.includes(p.id)))) {
  const desc = JSON.parse(readFileSync(join(ROOT, 'web/programs', `${e.program}.json`), 'utf8'));
  const file = join(OUT, `${e.id}.png`);
  const frame = e.thumb.frames;
  if (desc.host === 'glut') {
    let shot = null;
    buildTarget(loadTarget(join(ROOT, 'targets', `${desc.target}.json`)), { root: ROOT,
      envExtra: { glut: { frames: [frame], onFrame: (n, rgba, w, h) => { shot = { rgba, w, h }; } } } }).program.run([desc.target]);
    if (!shot) { console.log(`${e.id}: no frame ${frame}`); continue; }
    // png.mjs takes B,G,R,X, the page's own colour order (see its header).
    const bgrx = new Uint8Array(shot.w * shot.h * 4);
    for (let i = 0; i < shot.w * shot.h; i++) { bgrx[4 * i] = shot.rgba[4 * i + 2]; bgrx[4 * i + 1] = shot.rgba[4 * i + 1]; bgrx[4 * i + 2] = shot.rgba[4 * i]; }
    writeRgbPng(file, { bytes: bgrx, width: shot.w, height: shot.h });
  } else if (desc.host === 'sdl' && JSON.parse(readFileSync(join(ROOT, 'targets', `${desc.target}.json`), 'utf8')).env?.includes('gl')) {
    /*
     * An SDL 1.2 OPENGL program (Chromium B.S.U.): frame N at its SDL_GL_SwapBuffers, on a virtual
     * clock, with its data laid out as the page lays it (needsData.mount, exactPaths).
     */
    const nd = desc.needsData ?? {};
    const files = {};
    const walk = (d, pre) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`); else if (f !== 'PROVENANCE.txt') files[pre + f] = new Uint8Array(readFileSync(p)); } };
    if (nd.dir) walk(join(GAMES, nd.dir), nd.mount ?? '');
    const b = buildTarget(loadTarget(join(ROOT, 'targets', `${desc.target}.json`)), { root: ROOT,
      envExtra: { stdio: { files, exactPaths: !!nd.exactPaths }, sdl12: { clock: virtualClock() } } });
    let n = 0;
    b.program.M.sdl.state.onSwap = (gl) => {
      if (++n < frame) return;
      const W = gl.state.width, H = gl.state.height, px = gl.readPixels(), bgrx = new Uint8Array(W * H * 4);
      for (let i = 0; i < W * H; i++) { bgrx[4 * i] = px[4 * i + 2]; bgrx[4 * i + 1] = px[4 * i + 1]; bgrx[4 * i + 2] = px[4 * i]; }
      writeRgbPng(file, { bytes: bgrx, width: W, height: H });
      throw new Error('__thumb_done');
    };
    try { b.program.run([desc.target]); } catch (err) { if (!/__thumb_done/.test(err.message)) { console.log(`${e.id}: ${err.message}`); continue; } }
  } else {
    // `thumb.data`: another root to draw from, when the program's own holds an archive the page unpacks.
    const dataDir = e.thumb.data ?? desc.needsData?.dir;
    const data = dataDir ? [`--data=${join(GAMES, dataDir)}`] : [];
    const args = e.thumb.args ?? e.args ?? desc.args;
    const r = spawnSync('node', [join(ROOT, 'tools/build.mjs'), `targets/${desc.target}.json`, '--run', ...data,
      ...(args ? [`--args=${args}`] : []), `--frames=${frame}`, `--png=${file}`,
      // A program that waits on its own timer interrupt (Heretic's ticcount) moves only at safepoints.
      ...(desc.safepoints ? ['--safepoints'] : [])],
    { cwd: ROOT, encoding: 'utf8', timeout: (e.thumb.seconds ?? 120) * 1000, killSignal: 'SIGKILL' });
    if (!existsSync(file)) { console.log(`${e.id}: no thumbnail (${r.error?.code ?? `exit ${r.status}`}) ${(r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | ')}`); continue; }
  }
  console.log(`${e.id}: frame ${frame} -> ${file}`);
}
