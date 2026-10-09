// scummvmdiff.mjs — ScummVM 0.6.1 under PRISM against a native g++ build of the same sources, frame
// for frame, on Beneath a Steel Sky.
//
//   node tools/scummvmdiff.mjs [--frames=3000]            compare, print the first frame that differs
//   node tools/scummvmdiff.mjs --write                    ...and, if every frame agrees, write goldens/scummvm.json
//   node tools/scummvmdiff.mjs --check                    PRISM against goldens/scummvm.json (no container)
//
// The data: PRISM_SCUMMVM_DATA=<dir holding sky.dsk and sky.dnr> (bass-cd-1.0.zip's sky-cd/).
//
// THE NATIVE SIDE is the release built by g++ 12 in the i386 oracle container, against the real
// SDL 1.2 with its dummy video and audio drivers: real surfaces, real blits (the 8-bit game screen
// into the 16-bit display, through its palette), real fills. Only what depends on time is replaced,
// by `ld --wrap`, with src/env/sdl12.js's own behaviour over the virtual clock -- see
// tools/scummvmdiff/wrap.c, which says why the ORDER of clock readings matters. Built once, kept in
// .oracle/scummvm-native/.
//
// Each side prints, at every presented frame, FNV-1a over the display's rows. Agreement means the
// pictures are the same bytes; it says nothing about sound, which is not compared.
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const FRAMES = +arg('frames', 3000);
const ARGS = ['-psky', 'sky'];

/*
 * THE INPUT SCRIPT: what a player does, and WHEN, in the virtual clock's milliseconds. Both sides
 * take it at each SDL_PollEvent, once that call has pumped: what is due by then is delivered --
 * PRISM through the host hooks the page uses (scan codes, a pointer), the native side through
 * wrap.c, which makes the same SDL events from it. Time and not presented frames, because a program
 * waiting for a key need not present anything (Sky's control panel does not), and an input that
 * waits for a frame would never come. Coordinates are the 640x400 display's.
 */
const key = (ms, scan) => [[ms, 'key', scan, 1], [ms + 100, 'key', scan, 0]];
const move = (ms, x, y) => [[ms, 'mouse', x, y, 0]];
const click = (ms, x, y, button = 1) => [[ms, 'mouse', x, y, 0], [ms + 100, 'mouse', x, y, button], [ms + 200, 'mouse', x, y, 0]];
export const INPUT = [
  ...key(3000, 1),                      // Esc: skip the introduction
  ...key(14000, 63),                    // F5: the control panel
  ...move(17000, 320, 300),             // the pointer, in the panel
  ...key(20000, 1),                     // Esc: back to the game
  ...click(23000, 430, 185),            // walk: right along the walkway
  ...click(30000, 560, 120, 4),         // the door, right button: Sky's two buttons do different things here
  ...click(36000, 250, 185),            // walk back
  ...click(60000, 100, 357),            // on the screen that follows: its first button (play again)
  ...click(70000, 560, 120),            // the door again, left button
]
  .sort((a, b) => a[0] - b[0]);

/* Monkey Island's EGA demo: the verbs at the bottom of the 640x400 display, then what they act on. */
const MONKEY_INPUT = [
  ...key(5000, 1),                      // Esc: SCUMM's key for skipping a cutscene
  ...click(100000, 120, 245),           // walk to the left of the dock
  ...click(110000, 240, 330),           // "Look at"
  ...click(112000, 205, 125),           // ...the crane's hook
  ...click(125000, 25, 312),            // "Open"
  ...click(127000, 165, 200),           // ...the door on the left
  ...click(145000, 560, 250),           // walk to the right
].sort((a, b) => a[0] - b[0]);

/*
 * THE GAMES: where each one's files are (an environment variable, else under ~/games), the folder
 * they are given in on both sides, the name ScummVM knows the game by, its player and its reference.
 * The two SCUMM demos are the ones the ScummVM project distributes.
 */
export const GAMES = {
  sky: { env: 'PRISM_SCUMMVM_DATA', home: 'bass/sky-cd', folder: 'sky', name: 'sky', input: INPUT, golden: 'goldens/scummvm.json',
    title: 'Beneath a Steel Sky (bass-cd-1.0)' },
  monkey: { env: 'PRISM_SCUMMVM_MONKEY', home: 'scumm/monkey1-ega-demo', folder: 'monkey', name: 'monkeyEGA', input: MONKEY_INPUT, golden: 'goldens/scummvm-monkey.json',
    title: 'The Secret of Monkey Island, EGA demo (monkey1-dos-ega-demo-en)' },
  dott: { env: 'PRISM_SCUMMVM_DOTT', home: 'scumm/dott-demo', folder: 'dott', name: 'dottdemo', input: [...move(30000, 320, 200), ...key(60000, 1)].sort((a, b) => a[0] - b[0]), golden: 'goldens/scummvm-dott.json',
    // Its speech: ScummVM 0.6.1 asserts on this demo's MONSTER.SOU (sound/voc.cpp:125, "Creative Voice
    // File" expected), native and PRISM alike. Without the file the demo runs, silent.
    exclude: ['MONSTER.SOU'],
    title: 'Day of the Tentacle, non-interactive demo (dott-dos-ni-demo-en)' },
  atlantis: { env: 'PRISM_SCUMMVM_ATLANTIS', home: 'scumm/atlantis-demo', folder: 'atlantis', name: 'playfate', input: [...click(70000, 150, 312), ...click(100000, 450, 250), ...click(115000, 160, 330)].sort((a, b) => a[0] - b[0]), golden: 'goldens/scummvm-atlantis.json',
    title: 'Indiana Jones and the Fate of Atlantis, demo (atlantis-dos-demo1-en)' },
  monkey2: { env: 'PRISM_SCUMMVM_MONKEY2', home: 'scumm/monkey2-demo', folder: 'monkey2', name: 'mi2demo', input: [],
    // ScummVM 0.6.1 stops this demo in its debugger ("room 5 not in room 5 at 0+0 in file mi2demo.001"),
    // natively as here: the reference holds that too.
    golden: 'goldens/scummvm-monkey2.json',
    title: 'Monkey Island 2, non-interactive demo (monkey2-dos-ni-demo-en)' },
  samnmax: { env: 'PRISM_SCUMMVM_SAMNMAX', home: 'scumm/samnmax-demo', folder: 'samnmax', name: 'snmdemo', input: [...move(20000, 320, 200), ...key(50000, 1)].sort((a, b) => a[0] - b[0]), golden: 'goldens/scummvm-samnmax.json',
    title: 'Sam & Max Hit the Road, demo (samnmax-dos-demo-en)' },
};
export const gameData = (g) => process.env[g.env] ?? join(homedir(), 'games', g.home);
export const gameArgs = (g) => [`-p${g.folder}`, g.name];
/** Every file of a game's directory, by name. */
const gameFiles = (dir, exclude = []) => readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile() && !exclude.includes(f));

/** The script as wrap.c reads it, each key's symbol resolved by the shim itself. */
async function scriptFile(input) {
  const { sdl12KeySym } = await import('../src/env/sdl12.js');
  return input.map((e) => (e[1] === 'key' ? `${e[0]} k ${e[2] & 0x7f} ${e[3]} ${sdl12KeySym(e[2] & 0x7f, e[2] >= 128)}` : `${e[0]} m ${e[2]} ${e[3]} ${e[4]}`)).join('\n') + '\n';
}

/**
 * PRISM's side: the hash of the display at each presented frame -- and, given `audio`, how many of
 * the audio buffers were not silence (audio.buffers, audio.loud).
 */
export async function prismFrames(data, frames = FRAMES, args = ARGS, audio = null, { input = INPUT, pngAt = [], folder = 'sky', png = 'scummvm', exclude = [] } = {}) {
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const { virtualClock } = await import('../src/env/clock.js');
  const files = {};
  if (data) for (const f of gameFiles(data, exclude)) files[`${folder}/${f}`] = new Uint8Array(readFileSync(join(data, f)));
  const b = buildTarget(loadTarget(join(ROOT, 'targets/scummvm.json')), {
    root: ROOT, compile: { safepoints: true }, envExtra: { stdio: { files }, sdl12: { clock: virtualClock() } },
  });
  const M = b.program.M, sdl = M.sdl.state, out = [];
  // The host, as the page is one: a queue of key events and a pointer the shim polls.
  const keys = [], host = { x: 0, y: 0, buttons: 0 };
  sdl.keyboard = { next: () => keys.shift() ?? null };
  // poll() is the first thing SDL_PollEvent asks of the host after pumping: the script's moment.
  sdl.mouse = { poll: () => { inject(sdl.clock.peek()); return { ...host }; }, warp: (x, y) => { host.x = x; host.y = y; } };
  let at = 0;
  const inject = (ms) => {
    for (; at < input.length && input[at][0] <= ms; at++) {
      const e = input[at];
      if (e[1] === 'key') keys.push({ scan: e[2] & 0x7f, extended: e[2] >= 128, down: !!e[3], ascii: 0 });
      else Object.assign(host, { x: e[2], y: e[3], buttons: e[4] });
    }
  };
  const { writeRgbPng } = await import('./png.mjs');
  if (audio) {
    Object.assign(audio, { buffers: 0, loud: 0 });
    sdl.onAudio = (buf, n, st) => {
      audio.buffers++;
      for (let i = 0; i < n * st.outChannels; i++) if (M.mod.dv.getInt16(buf + 2 * i, true) !== 0) { audio.loud++; break; }
    };
  }
  sdl.onPresent = (s) => {
    const d = M.mod.dv, surf = s || sdl.surface;
    const w = d.getInt32(surf + 8, true), h = d.getInt32(surf + 12, true), pitch = d.getUint16(surf + 16, true);
    const px = d.getUint32(surf + 20, true), bytes = M.u8[d.getUint32(surf + 4, true) + 5];
    let x = 0x811c9dc5;
    for (let y = 0; y < h; y++) for (let i = px + y * pitch, e = i + w * bytes; i < e; i++) x = Math.imul(x ^ M.u8[i], 16777619) >>> 0;
    out.push(x.toString(16).padStart(8, '0'));
    if (pngAt.includes(out.length)) writeRgbPng(join(ROOT, `dist/${png}-${out.length}.png`), { bytes: M.u8.subarray(px, px + h * pitch), width: w, height: h, bpp: bytes, pitch });
    if (process.env.TICKS && out.length % 100 === 0) console.log(`frame ${out.length} at ${sdl.clock.peek()} ms`);
    if (out.length >= frames) throw new Error('__frames_done');
  };
  M.spBudget = 200000;
  M.sp_ = () => { M.spBudget = 200000; };
  try { b.program.run(['scummvm', ...args]); } catch (e) { if (!/__frames_done/.test(e.message)) { if (process.env.SHOWOUT) console.log(String(M.output?.() ?? "").slice(-1500)); throw e; } }
  return out;
}

/** The native side, built on first use. */
async function nativeFrames(game, data, frames = FRAMES) {
  const dir = join(ROOT, '.oracle/scummvm-native');
  if (!existsSync(join(dir, 'scummvm'))) {
    console.log('building the native ScummVM (once)...');
    cpSync(join(ROOT, 'corpus/scummvm-0.6.1'), dir, { recursive: true });
    copyFileSync(join(ROOT, 'tools/scummvmdiff/wrap.c'), join(dir, 'wrap.c'));
    // The build date PRISM's preprocessor gives (src/compile.js TARGET_DEFINES): ScummVM prints
    // __DATE__ and __TIME__ in its debugger, and Monkey Island 2's demo stops there.
    writeFileSync(join(dir, 'prism-date.h'), '#undef __DATE__\n#define __DATE__ "Jan  1 1996"\n#undef __TIME__\n#define __TIME__ "00:00:00"\n');
    writeFileSync(join(dir, 'gxx33'), '#!/bin/sh\ncase "$1" in -dumpversion) echo 3.3; exit 0;; esac\nexec g++ "$@"\n', { mode: 0o755 });
    const wraps = ['SDL_GetTicks', 'SDL_Delay', 'SDL_PollEvent', 'SDL_WarpMouse', 'SDL_GetMouseState', 'time', 'SDL_SetTimer', 'SDL_OpenAudio', 'SDL_PauseAudio', 'SDL_CloseAudio', 'SDL_UpdateRects', 'SDL_UpdateRect', 'SDL_Flip'].map((n) => `--wrap=${n}`).join(',');
    const r = sh(`cd scummvm-native && CXX=/work/scummvm-native/gxx33 ./configure --disable-simon --disable-sword1 --disable-sword2 --disable-queen --disable-alsa --disable-vorbis --disable-mad --disable-zlib --disable-mpeg2 >/dev/null && gcc -O0 -c -I/usr/include/SDL wrap.c -o wrap.o && make -j8 CXX=g++ CXXFLAGS='-O0 -ansi -fpermissive -fno-strict-aliasing -fwrapv -w -include /work/scummvm-native/prism-date.h' LIBS='wrap.o -lSDL -lm -Wl,${wraps}' >/dev/null 2>&1 && ls scummvm`, { timeout: 1200000 });
    if (r.code !== 0) throw new Error(`native build failed: ${r.stdout}${r.stderr}`.slice(-600));
  }
  mkdirSync(join(ROOT, '.oracle', game.folder), { recursive: true });
  rmSync(join(ROOT, '.oracle', game.folder), { recursive: true, force: true });
  mkdirSync(join(ROOT, '.oracle', game.folder), { recursive: true });
  for (const f of gameFiles(data, game.exclude)) if (!existsSync(join(ROOT, '.oracle', game.folder, f))) copyFileSync(join(data, f), join(ROOT, '.oracle', game.folder, f));
  writeFileSync(join(ROOT, '.oracle/scummvm-events.txt'), await scriptFile(game.input));
  const r = sh(`cd /work && EVENTS=/work/scummvm-events.txt SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy FRAMES=${frames} HOME=/tmp ./scummvm-native/scummvm ${gameArgs(game).join(' ')} 2>/dev/null`, { timeout: 1200000 });
  return [...r.stdout.matchAll(/^frame \d+ ([0-9a-f]{8})$/gm)].map((m) => m[1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // --game=sky|monkey|dott (sky by default).
  const game = GAMES[arg('game', 'sky')] ?? (console.error(`no game ${arg('game')}: ${Object.keys(GAMES).join(', ')}`), process.exit(2));
  const data = gameData(game);
  const GOLDEN = join(ROOT, game.golden);
  if (!existsSync(data)) { console.error(`no ${data}: set ${game.env} to the directory holding ${game.title}`); process.exit(2); }
  const pngAt = (arg('png-at', '') || '').split(',').filter(Boolean).map(Number);
  // --input=<file.json>: another script, [ms, 'key', scan, down] and [ms, 'mouse', x, y, buttons] rows (PRISM only).
  const inputFile = arg('input', '');
  const ours = await prismFrames(data, FRAMES, gameArgs(game), null, { pngAt, folder: game.folder, png: `scummvm-${arg('game', 'sky')}`, exclude: game.exclude ?? [], input: inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : game.input });
  // --prism-only: PRISM's run alone (with --png-at), to write or look at an input script.
  if (process.argv.includes('--prism-only')) { console.log(`PRISM ${ours.length} frames, the last ${ours.at(-1)}`); process.exit(0); }
  const theirs = process.argv.includes('--check') ? JSON.parse(readFileSync(GOLDEN, 'utf8')).frames.slice(0, FRAMES) : await nativeFrames(game, data);
  const n = Math.min(ours.length, theirs.length);
  let first = -1;
  for (let i = 0; i < n; i++) if (ours[i] !== theirs[i]) { first = i; break; }
  console.log(`PRISM ${ours.length} frames, ${process.argv.includes('--check') ? 'goldens' : 'native'} ${theirs.length}`);
  if (first >= 0) { console.log(`first difference at frame ${first + 1}: PRISM ${ours[first]}, reference ${theirs[first]}`); process.exit(1); }
  if (ours.length !== theirs.length || n < FRAMES) { console.log('the runs presented different numbers of frames'); process.exit(1); }
  console.log(`all ${n} frames agree; the last is ${ours[n - 1]}`);
  if (process.argv.includes('--write')) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify({
      _doc: `ScummVM 0.6.1 on ${game.title}: FNV-1a of the display at each presented frame, with the input script below, written by tools/scummvmdiff.mjs --write only when PRISM and a native g++ build over the real SDL 1.2 (time, timer, audio and input wrapped onto the same virtual clock) agreed on every frame.`,
      args: gameArgs(game), input: game.input, frames: ours,
    }) + '\n');
    console.log(`wrote ${GOLDEN}`);
  }
}
