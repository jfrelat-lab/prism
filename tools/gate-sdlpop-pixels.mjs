// gate-sdlpop-pixels.mjs — SDLPoP on PRISM shows what SDLPoP on the real SDL 2 shows.
//
// THE REFERENCE is the same source built by gcc against the real SDL 2 and SDL_image in the oracle
// container, run with SDL's dummy video and audio drivers, and watched from outside: a preloaded
// library (tools/oracle/sdl2-capture.c) stands in front of SDL_UpdateTexture, the call by which the
// game hands SDL its finished 320x200 picture, and writes two hashes per DISTINCT picture. Nothing
// of the picture is kept, here or in the golden.
//
// THE CLAIM: every picture PRISM presents, from the first black frame through the notice screen,
// the title's fade, the start of level 1 and the prince running off his ledge, is a picture the
// real build presented. Three things make that possible. The game's one source of variety is its
// random seed, which both runs are given (`seed=1234`, the game's own argument). The keys are tied
// to a COUNT OF DISTINCT PICTURES rather than to a time: the game advances by its own ticks, the
// pictures follow, and a wall clock is the one thing the two runs do not share. And the one place
// where the game waits on real time inside the script, the tune that opens level 1, is switched
// off on both sides by the game's own setting (see INI below).
//
// Controls: another seed, and sprite palettes with red and blue exchanged.
//
// Replaying needs the game's data (PRISM_SDLPOP_DATA, a directory holding data/ and SDLPoP.ini;
// default ~/games/sdlpop) and SKIPS without it. Capturing also needs the container, with
// libsdl2-dev and libsdl2-image-dev, and takes several minutes: the game runs in real time.
//
//   node tools/gate-sdlpop-pixels.mjs --capture     # the real build, into goldens/sdlpop-pixels.json
//   node tools/gate-sdlpop-pixels.mjs               # PRISM against it
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, cpSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { PIXELFORMAT } from '../src/env/sdl2-surface.js';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'sdlpop-pixels.json');
const DATA = process.env.PRISM_SDLPOP_DATA ?? join(process.env.HOME ?? '', 'games', 'sdlpop');
const SEED = 'seed=1234';
const ARGS = [SEED];
/*
 * The one setting changed, on both sides, in the game's own SDLPoP.ini: level 1 opens with a tune
 * during which the prince stays crouched, and he stands when it has finished PLAYING. That is real
 * time, and longer in the container -- where the game's OPL emulation cannot keep up -- than
 * anywhere else: with the tune, the two runs agree for 70 pictures and part exactly where it ends
 * on PRISM. (The game's `mute` does not help: it plays the tune in silence and waits all the same.)
 */
const INI = ['intro_music_level = 1', 'intro_music_level = 0'];
const iniFor = (text) => {
  if (!text.includes(INI[0])) throw new Error(`SDLPoP.ini has no "${INI[0]}" line to change`);
  return text.replace(INI[0], () => INI[1]);
};
/*
 * [distinct picture, SDL scancode, down]. Space (44) leaves the notice screen; Enter (40) starts
 * the game from the title; Right (79) is held while the prince runs to the edge and falls.
 */
const KEYS = [[2, 44, 1], [3, 44, 0], [30, 40, 1], [31, 40, 0], [70, 79, 1], [100, 79, 0]];
const STOP = 130, MIN_DISTINCT = 100;
const SOURCES = ['main.c', 'data.c', 'seg000.c', 'seg001.c', 'seg002.c', 'seg003.c', 'seg004.c', 'seg005.c', 'seg006.c', 'seg007.c', 'seg008.c', 'seg009.c',
  'seqtbl.c', 'replay.c', 'options.c', 'lighting.c', 'screenshot.c', 'menu.c', 'midi.c', 'opl3.c', 'stb_vorbis.c'];

if (process.argv.includes('--capture')) {
  const { up, sh, SCRATCH } = await import('./oracle.mjs');
  if (!existsSync(join(DATA, 'data'))) throw new Error(`--capture needs the game's data at ${DATA}`);
  up();
  const work = join(SCRATCH, 'sdlpop-ref');
  // The built game is kept between captures (it takes minutes to compile under emulation); the
  // data it runs on is copied in for the run and taken out again.
  const dropData = () => { for (const n of ['data', 'SDLPoP.ini', 'SDLPoP.cfg', 'ref.txt']) rmSync(join(work, n), { recursive: true, force: true }); };
  dropData();
  mkdirSync(work, { recursive: true });
  const fresh = !existsSync(join(work, 'prince'));
  if (fresh) cpSync(join(ROOT, 'corpus', 'SDLPoP-1.23', 'src'), join(work, 'src'), { recursive: true });
  cpSync(join(DATA, 'data'), join(work, 'data'), { recursive: true });
  writeFileSync(join(work, 'SDLPoP.ini'), iniFor(readFileSync(join(DATA, 'SDLPoP.ini'), 'utf8')));
  copyFileSync(join(ROOT, 'tools', 'oracle', 'sdl2-capture.c'), join(work, 'sdl2-capture.c'));
  const b = sh(`cd /work/sdlpop-ref && gcc -shared -fPIC -O1 -o sdl2-capture.so sdl2-capture.c -I/usr/include/SDL2 -ldl 2>&1 && ${fresh ? '' : 'exit 0; '}cd src && gcc -std=c99 -O1 -o ../prince ${SOURCES.join(' ')} -I/usr/include/SDL2 -D_REENTRANT -D_GNU_SOURCE=1 -lSDL2 -lSDL2_image -lm 2>&1`, { timeout: 1500000 });
  if (b.code !== 0) throw new Error(`the reference did not build:\n${b.stdout}${b.stderr}`);
  const keys = KEYS.map((k) => k.join(':')).join(',');
  const dump = process.env.SDL2_CAPTURE_DUMP ? `SDL2_CAPTURE_DUMP=${process.env.SDL2_CAPTURE_DUMP} ` : '';
  sh(`cd /work/sdlpop-ref && ${dump}SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy SDL2_CAPTURE_OUT=/work/sdlpop-ref/ref.txt SDL2_CAPTURE_KEYS=${keys} SDL2_CAPTURE_STOP=${STOP} LD_PRELOAD=./sdl2-capture.so timeout 900 ./prince ${ARGS.join(' ')} > run.log 2>&1`, { timeout: 1000000 });
  const screens = readFileSync(join(work, 'ref.txt'), 'utf8').trim().split('\n').filter(Boolean);
  dropData();                                                // the game's data does not stay in the scratch tree
  if (screens.length < STOP) throw new Error(`the reference showed ${screens.length} distinct pictures, not ${STOP}: it did not get through the script`);
  writeFileSync(GOLDEN, `${JSON.stringify({
    _doc: 'SDLPoP 1.23 built by gcc against the real SDL 2 and SDL_image in the oracle container (dummy video and audio '
      + `drivers, arguments ${ARGS.join(' ')}, SDLPoP.ini with ${INI[1]}), watched by tools/oracle/sdl2-capture.c: one entry per distinct 320x200 RGB24 picture handed to `
      + 'SDL_UpdateTexture, in order, as two FNV-1a hashes over its pixel bytes. Keys are given at counts of distinct '
      + 'pictures (the script is in tools/gate-sdlpop-pixels.mjs). Captured by that gate with --capture.',
    keys: KEYS, screens,
  })}\n`);
  console.log(`captured ${screens.length} distinct pictures -> goldens/sdlpop-pixels.json`);
}
if (!existsSync(GOLDEN)) { console.log('no goldens/sdlpop-pixels.json: run with --capture first'); process.exit(1); }
if (!existsSync(join(DATA, 'data'))) skip(`SDLPoP's data at ${DATA}`, 'set PRISM_SDLPOP_DATA to a directory holding data/ and SDLPoP.ini');
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
if (JSON.stringify(golden.keys) !== JSON.stringify(KEYS)) { console.log(' BAD  the golden was captured with another key script: capture again'); process.exit(1); }
const ref = new Set(golden.screens);

const files = {};
(function walk(d, pre) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`);
    else if (pre.startsWith('data/') || f === 'SDLPoP.ini') files[pre + f] = new Uint8Array(readFileSync(p));
  }
})(DATA, '');
files['SDLPoP.ini'] = new TextEncoder().encode(iniFor(new TextDecoder().decode(files['SDLPoP.ini'])));

/** Run the game on PRISM by the same script; the distinct pictures it presents, in order. */
function prism({ args = ARGS, mutate = null } = {}) {
  let t = 0;
  const clock = { virtual: true, now: () => Math.floor(t += 0.01), delay: (ms) => { if (ms > 0) t += ms; } };
  const built = buildTarget(loadTarget(join(ROOT, 'targets', 'sdlpop.json')), { root: ROOT, envExtra: { stdio: { files: { ...files } }, sdl2: { clock } } });
  const { program } = built;
  program.M.write = () => {};
  if (mutate) mutate(program.M);
  const sdl = program.M.sdl, pushKey = built.env.sdl2.pushKey;
  const shown = [], keys = KEYS.slice();
  let last = '';
  const inner = program.M.rt.SDL_RenderPresent;
  program.M.rt.SDL_RenderPresent = function (...a) {
    const r = inner.apply(this, a);
    const f = sdl.frame;
    if (!f || f.format !== PIXELFORMAT.RGB24) return r;
    let h1 = 2166136261 >>> 0, h2 = 0x9747b28c;
    const n = f.w * f.bpp;
    for (let y = 0; y < f.h; y++) for (let x = 0, at = y * f.pitch; x < n; x++, at++) { h1 = Math.imul(h1 ^ f.bytes[at], 16777619); h2 = Math.imul(h2 ^ f.bytes[at], 16777619); }
    const hash = (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
    if (hash !== last) {
      last = hash; shown.push(hash);
      while (keys.length && keys[0][0] <= shown.length) { const [, code, down] = keys.shift(); pushKey(code, !!down); }
      if (shown.length >= STOP) throw new Error('__done');
    }
    return r;
  };
  let polls = 0;
  const innerPoll = program.M.rt.SDL_PollEvent;
  program.M.rt.SDL_PollEvent = function (...a) { if (++polls > 4000000) throw new Error('the game stopped presenting'); return innerPoll.apply(this, a); };
  try { program.run(['prince', ...args]); } catch (e) { if (e.message !== '__done') return { shown, error: e.message.split('\n')[0] }; }
  return { shown, error: null };
}

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${detail}`); };
const same = (shown) => shown.filter((h) => ref.has(h)).length;
const lead = (shown) => { let i = 0; while (i < shown.length && shown[i] === golden.screens[i]) i++; return i; };

report(ref.size >= MIN_DISTINCT, `the reference showed at least ${MIN_DISTINCT} distinct pictures`, `${ref.size}`);
const run = prism();
report(!run.error && run.shown.length >= STOP, `the game got through the script on PRISM`, run.error ?? `${run.shown.length} distinct pictures`);
report(same(run.shown) === run.shown.length, 'every picture PRISM showed is one the real build showed', `${same(run.shown)} of ${run.shown.length}`);
report(lead(run.shown) === run.shown.length, '...and in the same order', `the first ${lead(run.shown)} are the reference's first ${lead(run.shown)}`);

const other = prism({ args: ['seed=1235'] });
report(same(other.shown) < other.shown.length, 'control: another random seed is told apart', `${other.shown.length - same(other.shown)} of ${other.shown.length} pictures unknown`);
// The game's sprites are PNG files, so their palettes arrive through IMG_Load_RW.
const swapped = prism({
  mutate: (M) => {
    const inner = M.rt.IMG_Load_RW;
    M.rt.IMG_Load_RW = (rw, free) => {
      const surface = inner(rw, free), d = M.mod.dv;
      const palette = surface ? d.getUint32(d.getUint32(surface + 4, true) + 4, true) : 0;
      if (palette) {
        const n = d.getInt32(palette, true), colors = d.getUint32(palette + 4, true);
        for (let i = 0; i < n; i++) { const at = colors + 4 * i, r = M.u8[at]; M.u8[at] = M.u8[at + 2]; M.u8[at + 2] = r; }
      }
      return surface;
    };
  },
});
report(same(swapped.shown) < swapped.shown.length, 'control: palettes with red and blue exchanged are told apart', `${swapped.shown.length - same(swapped.shown)} of ${swapped.shown.length} pictures unknown`);

if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nSDLPoP shows on PRISM what it shows on the real SDL 2, picture for picture.');
