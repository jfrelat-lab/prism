// cubediff.mjs — Cube on PRISM against Cube built natively, picture by picture.
//
// The native side: Cube by g++ 12 in the oracle container (-std=gnu++98 -fpermissive, which g++ 3 was;
// -msse2 -mfpmath=sse, as PRISM rounds float and double), ENet by gcc with the definitions its own
// configure finds, over the real SDL 1.2, SDL_mixer and SDL_image (the last two statically, so their
// calls into SDL are wrapped), drawn by Mesa (llvmpipe) on a surfaceless EGL context
// (tools/cubediff/wrap.c: sdl12.js's virtual clock, pump, audio device and input, transcribed). Mesa
// is told MESA_EXTENSION_OVERRIDE=-GL_EXT_texture_env_combine: PRISM's GL does not offer it, and
// Cube takes another lighting path without it.
//
// Both sides are given autoexec.cfg with `musicvol 0` appended: Cube then never asks for music, which
// is Ogg Vorbis and which PRISM's SDL_mixer does not decode.
//
// The pictures are compared with a tolerance -- GL is not bit-exact here: Mesa and gl.js differ at
// polygon edges and in the mipmaps gluBuild2DMipmaps makes (P15.2).
//
//   node tools/cubediff.mjs [--frames=N] [--at=n1,n2,...] [--tol=8]
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, cpSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sh } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus/cube_2005_08_29');
export const cubeData = () => process.env.PRISM_CUBE_DATA ?? join(homedir(), 'games/cube/files/cube');
const ENET_DEFS = '-DHAS_GETHOSTBYADDR_R=1 -DHAS_GETHOSTBYNAME_R=1 -DHAS_POLL=1 -DHAS_FCNTL=1 -DHAS_MSGHDR_FLAGS=1 -DHAS_SOCKLEN_T=1';
const WRAPS = ['SDL_GetTicks', 'SDL_Delay', 'SDL_PollEvent', 'SDL_WarpMouse', 'SDL_GetMouseState', 'time', 'SDL_SetTimer',
  'SDL_OpenAudio', 'SDL_PauseAudio', 'SDL_CloseAudio', 'SDL_LockAudio', 'SDL_UnlockAudio', 'SDL_SetVideoMode',
  'SDL_GL_SetAttribute', 'SDL_GL_SwapBuffers', 'glDrawBuffer', 'glReadBuffer'].map((n) => `--wrap=${n}`).join(',');
const LIBS = '-Wl,-Bstatic -lSDL_mixer -lSDL_image -Wl,-Bdynamic $(sdl-config --libs) -lFLAC -lmikmod -lvorbisfile -lvorbis -logg '
  + '-lfluidsynth -lmad -lmodplug -lpng -ljpeg -ltiff -lwebp -lGLU -lOpenGL -lEGL -lX11 -lz -lm -ldl -lpthread';
const MUSIC_OFF = '\nmusicvol 0\n';
// 320x240 on both sides (Cube's own -w and -h): the same game a quarter of the pixels, and the
// software rasteriser that draws PRISM's side is most of a run's time.
export const ARGS = ['-w320', '-h240'];

/*
 * THE PLAYER: keys and the pointer at fixed virtual times, as tools/scummvmdiff.mjs scripts them --
 * [ms, 'key', scan, down] and [ms, 'mouse', x, y, buttons]. 300 frames are about 750 ms here: Cube
 * draws as fast as it can, and the virtual clock moves only as it reads it. Walk forward (W), turn
 * (Cube ignores its first pointer motions, then turns by their xrel), fire (the left button: a sound
 * on both sides), strafe right (D).
 */
const key = (ms, scan) => [[ms, 'key', scan, 1], [ms + 60, 'key', scan, 0]];
export const INPUT = [
  [40, 'key', 17, 1], [400, 'key', 17, 0],
  ...Array.from({ length: 12 }, (_, i) => [120 + 10 * i, 'mouse', 330 + 12 * i, 240, 0]),
  [300, 'mouse', 462, 240, 1], [330, 'mouse', 462, 240, 0],
  [480, 'key', 32, 1], [640, 'key', 32, 0],
  ...key(560, 57),
].sort((a, b) => a[0] - b[0]);

async function scriptFile(input) {
  const { sdl12KeySym } = await import('../src/env/sdl12.js');
  return input.map((e) => (e[1] === 'key' ? `${e[0]} k ${e[2] & 0x7f} ${e[3]} ${sdl12KeySym(e[2] & 0x7f, e[2] >= 128)}` : `${e[0]} m ${e[2]} ${e[3]} ${e[4]}`)).join('\n') + '\n';
}

/** The native build, made once into .oracle/cube-native (and again when wrap.c changes). */
export function nativeBuild() {
  const dir = join(ROOT, '.oracle/cube-native'), wrap = readFileSync(join(ROOT, 'tools/cubediff/wrap.c'), 'utf8');
  if (existsSync(join(dir, 'cube_native')) && readFileSync(join(dir, 'wrap.c'), 'utf8') === wrap) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(SRC, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(SRC, 'enet'), join(dir, 'enet'), { recursive: true });
  writeFileSync(join(dir, 'wrap.c'), wrap);
  const units = JSON.parse(readFileSync(join(ROOT, 'targets/cube.json'), 'utf8')).units.list;
  const cmds = [
    ...units.filter((u) => u.endsWith('.c')).map((u) => `gcc -O0 -msse2 -mfpmath=sse -w -Ienet/include ${ENET_DEFS} -c ${u} -o ${u.replace(/\.c$/, '.o')}`),
    ...units.filter((u) => u.endsWith('.cpp')).map((u) => `g++ -std=gnu++98 -fpermissive -O0 -msse2 -mfpmath=sse -fsigned-char -w -Ienet/include $(sdl-config --cflags) -c ${u} -o ${u.replace(/\.cpp$/, '.o')}`),
    'gcc -O0 $(sdl-config --cflags) -c wrap.c -o wrap.o',
    `g++ -o cube_native ${units.map((u) => u.replace(/\.(c|cpp)$/, '.o')).join(' ')} wrap.o ${LIBS} -Wl,${WRAPS}`,
  ];
  writeFileSync(join(dir, 'build.sh'), `set -e\n${cmds.join('\n')}\n`);
  const r = sh('cd /work/cube-native && sh build.sh', { timeout: 2400000 });
  if (r.code !== 0) throw new Error(`native build failed: ${(r.stdout + r.stderr).slice(-800)}`);
}

/** The data, given to the native run in .oracle/cube-data with autoexec.cfg's musicvol 0. */
function nativeData(extraCfg = '') {
  const dir = join(ROOT, '.oracle/cube-data');
  if (!existsSync(join(dir, 'packages'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const sub of ['data', 'packages']) cpSync(join(cubeData(), sub), join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, 'autoexec.cfg'), readFileSync(join(cubeData(), 'autoexec.cfg'), 'utf8') + MUSIC_OFF + extraCfg);
}

/** Native frames: { hashes, audio, pictures: { n: Uint8Array RGB } }. */
export async function nativeFrames(frames, at = [], input = INPUT, extraCfg = '') {
  nativeBuild();
  nativeData(extraCfg);
  const events = await scriptFile(input);
  writeFileSync(join(ROOT, '.oracle/cube-events.txt'), events);
  // Kept by everything it is made from (tools/ref-cache.mjs): a run is the same run while these are.
  const { refCached, treeHash } = await import('./ref-cache.mjs');
  dataHash ??= treeHash(join(ROOT, '.oracle/cube-data/packages')) + treeHash(join(ROOT, '.oracle/cube-data/data'));
  return refCached(['cube-native', readFileSync(join(ROOT, '.oracle/cube-native/cube_native')), dataHash,
    readFileSync(join(ROOT, '.oracle/cube-data/autoexec.cfg')), events, String(frames), at.join(','), ARGS.join(' '), 'MESA_EXTENSION_OVERRIDE=-GL_EXT_texture_env_combine'],
  () => nativeRun(frames, at));
}
let dataHash = null;
function nativeRun(frames, at) {
  const r = sh(`cd /work/cube-data && rm -f cube-frame-*.ppm && EVENTS=/work/cube-events.txt SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy `
    + `MESA_EXTENSION_OVERRIDE=-GL_EXT_texture_env_combine FRAMES=${frames} PPM=${at.join(',')} HOME=/tmp ../cube-native/cube_native ${ARGS.join(' ')} 2>/dev/null`, { timeout: 1800000 });
  const pictures = {};
  for (const n of at) {
    const p = join(ROOT, '.oracle/cube-data', `cube-frame-${n}.ppm`);
    if (!existsSync(p)) continue;
    const b = readFileSync(p), m = b.toString('latin1', 0, 32).match(/^P6\n(\d+) (\d+)\n255\n/);
    pictures[n] = { w: +m[1], h: +m[2], rgb: new Uint8Array(b.subarray(m[0].length)) };   // not a Buffer: its toJSON would win over ref-cache's
  }
  return { hashes: [...r.stdout.matchAll(/^frame \d+ ([0-9a-f]{8})$/gm)].map((x) => x[1]), audio: [...r.stdout.matchAll(/^audio \d+ ([0-9a-f]{8})$/gm)].map((x) => x[1]), pictures, output: r.stdout };
}

/** PRISM frames: { frames, pictures: { n: { w, h, rgb } }, output }. */
export async function prismFrames(frames, at = [], { withholdPackages = false, input = INPUT } = {}) {
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const { virtualClock } = await import('../src/env/clock.js');
  const files = {};
  const walk = (d, pre) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`); else files[pre + f] = new Uint8Array(readFileSync(p)); } };
  walk(join(cubeData(), 'data'), 'data/');
  if (!withholdPackages) walk(join(cubeData(), 'packages'), 'packages/');
  files['autoexec.cfg'] = new Uint8Array(Buffer.from(readFileSync(join(cubeData(), 'autoexec.cfg'), 'utf8') + MUSIC_OFF));
  const b = buildTarget(loadTarget(join(ROOT, 'targets/cube.json')), { root: ROOT, compile: { safepoints: true },
    envExtra: { stdio: { files }, sdl12: { clock: virtualClock() } } });
  const M = b.program.M, pictures = {}, sdl = M.sdl.state;
  // The host, as scummvmdiff's is: a queue of keys, and a pointer the shim polls -- the script's moment.
  const keys = [], host = { x: 0, y: 0, buttons: 0 };
  let next = 0;
  const inject = (ms) => {
    for (; next < input.length && input[next][0] <= ms; next++) {
      const e = input[next];
      if (e[1] === 'key') keys.push({ scan: e[2] & 0x7f, extended: e[2] >= 128, down: !!e[3], ascii: 0 });
      else Object.assign(host, { x: e[2], y: e[3], buttons: e[4] });
    }
  };
  sdl.keyboard = { next: () => keys.shift() ?? null };
  // Every buffer the mixer fills, hashed as wrap.c hashes them.
  const audio = [];
  sdl.onMixed = (buf, len) => {
    let x = 0x811c9dc5;
    for (let i = buf; i < buf + len; i++) x = Math.imul(x ^ M.u8[i], 16777619) >>> 0;
    audio.push(x.toString(16).padStart(8, '0'));
  };
  sdl.mouse = { poll: () => { inject(sdl.clock.peek()); return { ...host }; }, warp: (x, y) => { host.x = x; host.y = y; } };
  let n = 0;
  M.sdl.state.onSwap = (gl) => {
    n++;
    if (at.includes(n)) {
      const W = gl.state.width, H = gl.state.height, px = gl.readPixels(), rgb = new Uint8Array(W * H * 3);
      for (let i = 0; i < W * H; i++) { rgb[3 * i] = px[4 * i]; rgb[3 * i + 1] = px[4 * i + 1]; rgb[3 * i + 2] = px[4 * i + 2]; }
      pictures[n] = { w: W, h: H, rgb };
    }
    if (n >= frames) throw new Error('__frames_done');
  };
  M.spBudget = 200000;
  M.sp_ = () => { M.spBudget = 200000; };
  let error = null;
  try { b.program.run(['cube_client', ...ARGS]); } catch (e) { if (!/__frames_done/.test(e.message)) error = e.message.split('\n')[0]; }
  return { frames: n, pictures, audio, output: String(M.output?.() ?? ''), error };
}

/** Pixels off by more than tol on any channel, and the largest difference. */
export function comparePictures(a, b, tol) {
  let off = 0, max = 0;
  for (let i = 0; i < a.w * a.h; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.rgb[3 * i + k] - b.rgb[3 * i + k]));
    if (d > tol) off++;
    if (d > max) max = d;
  }
  return { off, total: a.w * a.h, max };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => process.argv.find((x) => x.startsWith(`--${k}=`))?.split('=')[1] ?? d;
  const frames = +arg('frames', 100), at = arg('at', '30,100').split(',').map(Number), tol = +arg('tol', 8);
  const t0 = Date.now();
  const nat = await nativeFrames(frames, at);
  console.log(`native: ${nat.hashes.length} frames, ${nat.audio.length} audio buffers (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const t1 = Date.now();
  const mine = await prismFrames(frames, at);
  console.log(`PRISM: ${mine.frames} frames (${((Date.now() - t1) / 1000).toFixed(0)} s)${mine.error ? `, ${mine.error}` : ''}`);
  {
    const a = mine.audio, t = nat.audio, first = a.findIndex((h, i) => h !== t[i]);
    console.log(a.length === t.length && first < 0 ? `audio: all ${a.length} buffers agree, ${new Set(a).size} of them different`
      : `audio: PRISM ${a.length} buffers, native ${t.length}; first difference at buffer ${first + 1}`);
  }
  for (const n of at) {
    if (!nat.pictures[n] || !mine.pictures[n]) { console.log(`frame ${n}: missing on ${nat.pictures[n] ? 'PRISM' : 'native'}'s side`); continue; }
    const c = comparePictures(mine.pictures[n], nat.pictures[n], tol);
    // PRISM | native | the difference (magenta past the tolerance), into dist/.
    const { writeRgbPng } = await import('./png.mjs');
    const a = mine.pictures[n], r = nat.pictures[n], W = a.w, H = a.h, out = new Uint8Array(W * 3 * H * 4);
    for (let i = 0; i < W * H; i++) {
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.rgb[3 * i + k] - r.rgb[3 * i + k]));
      const y = Math.floor(i / W), x = i % W;
      [[a.rgb[3 * i], a.rgb[3 * i + 1], a.rgb[3 * i + 2]], [r.rgb[3 * i], r.rgb[3 * i + 1], r.rgb[3 * i + 2]], d > tol ? [255, 0, 255] : [0, 0, 0].map(() => Math.min(255, d * 8))]
        .forEach((col, k) => { const o = (y * W * 3 + k * W + x) * 4; out[o] = col[2]; out[o + 1] = col[1]; out[o + 2] = col[0]; out[o + 3] = 255; });
    }
    writeRgbPng(join(ROOT, `dist/cubediff-${n}.png`), { bytes: out, width: W * 3, height: H });
    console.log(`frame ${n}: ${c.off} of ${c.total} pixels (${(100 * c.off / c.total).toFixed(2)}%) off by more than ${tol}, max ${c.max}`);
  }
}
