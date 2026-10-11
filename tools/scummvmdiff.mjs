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

/* Flight of the Amazon Queen: Esc skips the introduction's scenes one by one, then the hotel room. */
const QUEEN_INPUT = [
  ...key(15000, 1), ...key(30000, 1), ...key(45000, 1), ...key(75000, 1), ...key(90000, 1),
  ...click(110000, 340, 200),           // walk to the chest
  ...click(125000, 380, 190, 4),        // the chest, right button: Queen's default verb for it
  ...click(140000, 80, 180),            // walk to the door
  ...click(160000, 22, 345),            // the panel's first verb, "Open"
  ...click(162000, 80, 180),            // ...the door
  ...click(185000, 400, 345, 4),        // the baseball bat in the inventory, right button
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
  sky: { env: 'PRISM_SCUMMVM_DATA', home: 'bass/sky-cd', folder: 'sky', name: 'sky', id010: 'sky', input: INPUT,
    // 0.10.0's Sky engine reads its compact data from sky.cpt, an engine data file of the ScummVM project:
    // the one 0.10.0's release shipped (~/games/scummvm-engine-data-0.10.0, PROVENANCE.txt there; 2 bytes
    // from the one in git today), given beside the game's files.
    extra010: ['scummvm-engine-data-0.10.0/sky.cpt'], golden: 'goldens/scummvm.json',
    title: 'Beneath a Steel Sky (bass-cd-1.0)' },
  monkey: { env: 'PRISM_SCUMMVM_MONKEY', home: 'scumm/monkey1-ega-demo', folder: 'monkey', name: 'monkeyEGA', id010: 'monkey', input: MONKEY_INPUT, golden: 'goldens/scummvm-monkey.json',
    title: 'The Secret of Monkey Island, EGA demo (monkey1-dos-ega-demo-en)' },
  dott: { env: 'PRISM_SCUMMVM_DOTT', home: 'scumm/dott-demo', folder: 'dott', name: 'dottdemo', id010: 'tentacle', input: [...move(30000, 320, 200), ...key(60000, 1)].sort((a, b) => a[0] - b[0]), golden: 'goldens/scummvm-dott.json',
    // Its speech: ScummVM 0.6.1 asserts on this demo's MONSTER.SOU (sound/voc.cpp:125, "Creative Voice
    // File" expected), native and PRISM alike. Without the file the demo runs, silent.
    exclude: ['MONSTER.SOU'],
    title: 'Day of the Tentacle, non-interactive demo (dott-dos-ni-demo-en)' },
  atlantis: { env: 'PRISM_SCUMMVM_ATLANTIS', home: 'scumm/atlantis-demo', folder: 'atlantis', name: 'playfate', id010: 'atlantis', input: [...click(70000, 150, 312), ...click(100000, 450, 250), ...click(115000, 160, 330)].sort((a, b) => a[0] - b[0]), golden: 'goldens/scummvm-atlantis.json',
    title: 'Indiana Jones and the Fate of Atlantis, demo (atlantis-dos-demo1-en)' },
  monkey2: { env: 'PRISM_SCUMMVM_MONKEY2', home: 'scumm/monkey2-demo', folder: 'monkey2', name: 'mi2demo', id010: 'monkey2', input: [],
    // ScummVM 0.6.1 and 0.10.0 stop this demo in their debugger ("room 5 not in room 5 at 0+0 in file
    // mi2demo.001"), natively as here: the reference holds that too, and its silence.
    quiet: 'the demo stops in the ScummVM debugger ("room 5 not in room 5") before its music starts, natively too',
    golden: 'goldens/scummvm-monkey2.json',
    title: 'Monkey Island 2, non-interactive demo (monkey2-dos-ni-demo-en)' },
  samnmax: { env: 'PRISM_SCUMMVM_SAMNMAX', home: 'scumm/samnmax-demo', folder: 'samnmax', name: 'snmdemo', id010: 'samnmax', input: [...move(20000, 320, 200), ...key(50000, 1)].sort((a, b) => a[0] - b[0]), golden: 'goldens/scummvm-samnmax.json',
    title: 'Sam & Max Hit the Road, demo (samnmax-dos-demo-en)' },
  queen: { env: 'PRISM_SCUMMVM_QUEEN', home: 'queen/FOTAQ_Floppy', folder: 'queen', name: 'queen', id010: 'queen', input: QUEEN_INPUT, golden: 'goldens/scummvm-queen.json',
    title: 'Flight of the Amazon Queen, floppy version (FOTAQ_Floppy, freeware)' },
  // Engines 0.6.1 does not have: demos the ScummVM project distributes (~/games/scummvm-demos, a
  // PROVENANCE.txt beside each), run by 0.10.0 only.
  gob1: { env: 'PRISM_SCUMMVM_GOB1', home: 'scummvm-demos/gob1-dos-demo1-en/files', folder: 'gob1', id010: 'gob1', only010: true, input: [],
    golden: 'goldens/scummvm-gob1.json', title: 'Gobliiins, demo (gob1-dos-demo1-en)' },
  agidemo: { env: 'PRISM_SCUMMVM_AGIDEMO', home: 'scummvm-demos/agi-dos-pack1-demo-en/files', folder: 'agidemo', id010: 'agidemo', only010: true, input: [...key(2000, 28), ...key(6000, 3), ...key(7000, 28)].sort((a, b) => a[0] - b[0]),   // Return at the title, then 2 and Return in the menu: Police Quest's demo
    // The AGI engine sets its render mode only from render_mode or platform, neither of which a game
    // named on the command line has: left unset, the native build drew CGA (whatever its heap held)
    // and PRISM EGA from frame 7. The option is the release's own.
    args010: ['--render-mode=ega'],
    golden: 'goldens/scummvm-agidemo.json', title: 'Sierra AGI demo pack 1 (agi-dos-pack1-demo-en)' },
  sword2: { env: 'PRISM_SCUMMVM_SWORD2', home: 'scummvm-demos/sword2-win-demo-en/files', folder: 'sword2', id010: 'sword2demo', only010: true, input: [],
    golden: 'goldens/scummvm-sword2.json', title: 'Broken Sword 2, demo (sword2-win-demo-en)' },
  kyra1: { env: 'PRISM_SCUMMVM_KYRA1', home: 'scummvm-demos/kyra1-dos-ni-demo-en/files', folder: 'kyra1', id010: 'kyra1', only010: true, input: [],
    // The Kyra engine reads KYRA.DAT, the data file 0.10.0's release shipped (~/games/scummvm-engine-data-0.10.0).
    extra010: ['scummvm-engine-data-0.10.0/KYRA.DAT'],
    // The demo quits after its 872nd frame, natively as here.
    ends: 872,
    golden: 'goldens/scummvm-kyra1.json', title: 'The Legend of Kyrandia, non-interactive demo (kyra1-dos-ni-demo-en)' },
  // Not here: the Simon the Sorcerer 1 floppy demo and the Nippon Safes Amiga demo the project
  // distributes today are other builds than 0.10.0's tables name (GDEMO and ICON.DAT; disk0 and fr
  // differ by MD5); 0.10.0 takes them on a partial match and waits on a black screen, natively too.
};
export const gameData = (g) => process.env[g.env] ?? join(homedir(), 'games', g.home);
/*
 * The two releases: the build PRISM makes (target), the native one beside it (its configure, run in
 * the oracle container with a g++ that answers the version configure wants), the goldens, the game
 * ids. 0.10.0's native build undefines __i386__ as targets/scummvm010.json does, so both sides take
 * the same C paths where the release offers x86 assembly.
 */
export const VERSIONS = {
  '0.6.1': {
    target: 'targets/scummvm.json', corpus: 'corpus/scummvm-0.6.1', native: 'scummvm-native', gxx: '3.3',
    configure: '--disable-simon --disable-sword1 --disable-sword2 --disable-alsa --disable-vorbis --disable-mad --disable-zlib --disable-mpeg2',
    cflags: '', golden: (g) => g.golden, id: (g) => g.name,
  },
  '0.10.0': {
    target: 'targets/scummvm010.json', corpus: 'corpus/scummvm-0.10.0', native: 'scummvm010-native', gxx: '4.1.2',
    // --disable-touche here only: g++ 12 refuses its `template<> static void saveOrLoad(...)`, which the
    // gccs of 2007 took; no game compared here is Touche's.
    configure: '--disable-alsa --disable-vorbis --disable-tremor --disable-mad --disable-flac --disable-zlib --disable-mpeg2 --disable-fluidsynth --disable-nasm --disable-touche',
    cflags: '-U__i386__ -Ui386', golden: (g) => g.golden.replace('goldens/scummvm', 'goldens/scummvm010'), id: (g) => g.id010 ?? g.name,
  },
};
const VERSION = VERSIONS[arg('version', '0.6.1')] ?? (console.error(`no version ${arg('version')}: ${Object.keys(VERSIONS).join(', ')}`), process.exit(2));
export const gameArgs = (g, v = VERSION) => [...(v === VERSIONS['0.10.0'] ? g.args010 ?? [] : []), `-p${g.folder}`, v.id(g)];
/** Files a release needs beside the game's own: absolute paths. */
export const gameExtras = (g, v = VERSION) => (v === VERSIONS['0.10.0'] ? (g.extra010 ?? []) : []).map((f) => join(homedir(), 'games', f));
/** Every file of a game's directory, by name. */
const gameFiles = (dir, exclude = []) => readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile() && !exclude.includes(f));

/** The script as wrap.c reads it, each key's symbol resolved by the shim itself. */
async function scriptFile(input) {
  const { sdl12KeySym } = await import('../src/env/sdl12.js');
  return input.map((e) => (e[1] === 'key' ? `${e[0]} k ${e[2] & 0x7f} ${e[3]} ${sdl12KeySym(e[2] & 0x7f, e[2] >= 128)}` : `${e[0]} m ${e[2]} ${e[3]} ${e[4]}`)).join('\n') + '\n';
}

/**
 * PRISM's side: the hash of the display at each presented frame, and in `.audio` the hash of each
 * buffer the audio callback filled until then -- and, given `audio`, how many of the buffers the
 * page would hear were not silence (audio.buffers, audio.loud).
 */
export async function prismFrames(data, frames = FRAMES, args = ARGS, audio = null, { input = INPUT, pngAt = [], folder = 'sky', png = 'scummvm', exclude = [], debugOut = null, target = 'targets/scummvm.json', extra = [] } = {}) {
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const { virtualClock } = await import('../src/env/clock.js');
  const files = {};
  if (data) for (const f of gameFiles(data, exclude)) files[`${folder}/${f}`] = new Uint8Array(readFileSync(join(data, f)));
  if (data) for (const f of extra) files[`${folder}/${f.replace(/^.*\//, '')}`] = new Uint8Array(readFileSync(f));
  const b = buildTarget(loadTarget(join(ROOT, target)), {
    root: ROOT, compile: { safepoints: true }, envExtra: { stdio: { files }, sdl12: { clock: virtualClock() } },
  });
  const M = b.program.M, sdl = M.sdl.state, out = [];
  out.audio = [];
  sdl.onMixed = (buf, len) => {
    let x = 0x811c9dc5;
    for (let i = buf; i < buf + len; i++) x = Math.imul(x ^ M.u8[i], 16777619) >>> 0;
    out.audio.push(x.toString(16).padStart(8, '0'));
  };
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
  if (debugOut) writeFileSync(debugOut, String(M.output?.() ?? ""));
  return out;
}

const WRAPS = ['SDL_GetTicks', 'SDL_Delay', 'SDL_PollEvent', 'SDL_WarpMouse', 'SDL_GetMouseState', 'time', 'SDL_SetTimer', 'SDL_AddTimer', 'SDL_RemoveTimer', 'SDL_OpenAudio', 'SDL_PauseAudio', 'SDL_CloseAudio', 'SDL_UpdateRects', 'SDL_UpdateRect', 'SDL_Flip'].map((n) => `--wrap=${n}`).join(',');

/** The native side, built on first use, and linked again when wrap.c has changed. */
async function nativeFrames(game, data, frames = FRAMES, { args = gameArgs(game), debugOut = null, v = VERSION } = {}) {
  const dir = join(ROOT, '.oracle', v.native), work = `/work/${v.native}`;
  const wrapSrc = readFileSync(join(ROOT, 'tools/scummvmdiff/wrap.c'), 'utf8');
  if (existsSync(join(dir, 'scummvm')) && readFileSync(join(dir, 'wrap.c'), 'utf8') !== wrapSrc) {
    console.log('wrap.c changed: linking the native build again...');
    writeFileSync(join(dir, 'wrap.c'), wrapSrc);
    rmSync(join(dir, 'scummvm'));
    const r = sh(`cd ${v.native} && gcc -O0 -c -I/usr/include/SDL wrap.c -o wrap.o && make CXX=g++ LIBS='wrap.o -lSDL -lm -Wl,${WRAPS}' >/dev/null 2>&1 && ls scummvm`, { timeout: 2400000 });
    if (r.code !== 0) throw new Error(`native link failed: ${r.stdout}${r.stderr}`.slice(-600));
  }
  if (!existsSync(join(dir, 'scummvm'))) {
    console.log(`building the native ScummVM ${v.corpus.replace(/^.*-/, '')} (once)...`);
    cpSync(join(ROOT, v.corpus), dir, { recursive: true });
    copyFileSync(join(ROOT, 'tools/scummvmdiff/wrap.c'), join(dir, 'wrap.c'));
    // The build date PRISM's preprocessor gives (src/compile.js TARGET_DEFINES): ScummVM prints
    // __DATE__ and __TIME__ in its debugger, and Monkey Island 2's demo stops there.
    writeFileSync(join(dir, 'prism-date.h'), '#undef __DATE__\n#define __DATE__ "Jan  1 1996"\n#undef __TIME__\n#define __TIME__ "00:00:00"\n');
    writeFileSync(join(dir, 'gxx'), `#!/bin/sh\ncase "$1" in -dumpversion) echo ${v.gxx}; exit 0;; esac\nexec g++ "$@"\n`, { mode: 0o755 });
    const r = sh(`cd ${v.native} && CXX=${work}/gxx ./configure ${v.configure} >/dev/null && gcc -O0 -c -I/usr/include/SDL wrap.c -o wrap.o && make -j8 CXX=g++ CXXFLAGS='-O0 -ansi -fpermissive -fno-strict-aliasing -fwrapv -w ${v.cflags} -include ${work}/prism-date.h' LIBS='wrap.o -lSDL -lm -Wl,${WRAPS}' >/dev/null 2>&1 && ls scummvm`, { timeout: 2400000 });
    if (r.code !== 0) throw new Error(`native build failed: ${r.stdout}${r.stderr}`.slice(-600));
  }
  mkdirSync(join(ROOT, '.oracle', game.folder), { recursive: true });
  rmSync(join(ROOT, '.oracle', game.folder), { recursive: true, force: true });
  mkdirSync(join(ROOT, '.oracle', game.folder), { recursive: true });
  for (const f of gameFiles(data, game.exclude)) if (!existsSync(join(ROOT, '.oracle', game.folder, f))) copyFileSync(join(data, f), join(ROOT, '.oracle', game.folder, f));
  for (const f of gameExtras(game, v)) copyFileSync(f, join(ROOT, '.oracle', game.folder, f.replace(/^.*\//, '')));
  writeFileSync(join(ROOT, '.oracle/scummvm-events.txt'), await scriptFile(game.input));
  const r = sh(`cd /work && EVENTS=/work/scummvm-events.txt SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy FRAMES=${frames} HOME=/tmp ./${v.native}/scummvm ${args.join(' ')} 2>/dev/null`, { timeout: 1200000 });
  if (debugOut) writeFileSync(debugOut, r.stdout);
  const out = [...r.stdout.matchAll(/^frame \d+ ([0-9a-f]{8})$/gm)].map((m) => m[1]);
  out.audio = [...r.stdout.matchAll(/^audio \d+ ([0-9a-f]{8})$/gm)].map((m) => m[1]);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // --game=sky|monkey|dott (sky by default).
  const game = GAMES[arg('game', 'sky')] ?? (console.error(`no game ${arg('game')}: ${Object.keys(GAMES).join(', ')}`), process.exit(2));
  const data = gameData(game);
  const GOLDEN = join(ROOT, VERSION.golden(game));
  if (!existsSync(data)) { console.error(`no ${data}: set ${game.env} to the directory holding ${game.title}`); process.exit(2); }
  const pngAt = (arg('png-at', '') || '').split(',').filter(Boolean).map(Number);
  // --input=<file.json>: another script, [ms, 'key', scan, down] and [ms, 'mouse', x, y, buttons] rows (PRISM only).
  const inputFile = arg('input', '');
  // --debug=N: ScummVM's own -dN on both sides, its traces written to .oracle/scummvm-{prism,native}-debug.txt
  // -- the diff of the two names the first decision that went differently, frames before a pixel does.
  const debug = arg('debug', ''), args = [...(debug ? [`-d${debug}`] : []), ...gameArgs(game)];
  const debugOut = (side) => (debug ? join(ROOT, `.oracle/scummvm-${side}-debug.txt`) : null);
  const ours = await prismFrames(data, FRAMES, args, null, { debugOut: debugOut('prism'), pngAt, folder: game.folder, png: `scummvm${VERSION === VERSIONS['0.6.1'] ? '' : '010'}-${arg('game', 'sky')}`, target: VERSION.target, extra: gameExtras(game), exclude: game.exclude ?? [], input: inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : game.input });
  // --prism-only: PRISM's run alone (with --png-at), to write or look at an input script.
  if (process.argv.includes('--prism-only')) { console.log(`PRISM ${ours.length} frames, the last ${ours.at(-1)}`); process.exit(0); }
  let theirs;
  if (process.argv.includes('--check')) {
    const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    theirs = g.frames.slice(0, FRAMES);
    theirs.audio = g.audio ?? null;
  } else theirs = await nativeFrames(game, data, FRAMES, { args, debugOut: debugOut('native') });
  const n = Math.min(ours.length, theirs.length);
  let first = -1;
  for (let i = 0; i < n; i++) if (ours[i] !== theirs[i]) { first = i; break; }
  console.log(`PRISM ${ours.length} frames, ${process.argv.includes('--check') ? 'goldens' : 'native'} ${theirs.length}`);
  if (first >= 0) { console.log(`first difference at frame ${first + 1}: PRISM ${ours[first]}, reference ${theirs[first]}`); process.exit(1); }
  // A game that quits (`ends`) presents that many frames on both sides.
  if (ours.length !== theirs.length || n < Math.min(FRAMES, game.ends ?? FRAMES)) { console.log('the runs presented different numbers of frames'); process.exit(1); }
  console.log(`all ${n} frames agree; the last is ${ours[n - 1]}`);
  // The sound, buffer by buffer: every one the callback filled before the last frame.
  if (theirs.audio) {
    const a = ours.audio, t = theirs.audio, na = Math.min(a.length, t.length);
    const firstA = a.findIndex((h, i) => i < na && h !== t[i]);
    if (firstA >= 0 && firstA < na) { console.log(`first audio difference at buffer ${firstA + 1} of ${t.length}: PRISM ${a[firstA]}, reference ${t[firstA]}`); process.exit(1); }
    if (a.length !== t.length) { console.log(`the runs filled different numbers of audio buffers: PRISM ${a.length}, reference ${t.length}`); process.exit(1); }
    // How many differ from one another: silence hashes alike, and a run of it would agree vacuously.
    console.log(`all ${a.length} audio buffers agree, ${new Set(a).size} of them different${a.length ? `; the last is ${a.at(-1)}` : ''}`);
  }
  if (process.argv.includes('--write')) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify({
      _doc: `ScummVM ${arg('version', '0.6.1')} on ${game.title}: FNV-1a of the display at each presented frame, and of each buffer the audio callback filled until the last, with the input script below, written by tools/scummvmdiff.mjs --write only when PRISM and a native g++ build over the real SDL 1.2 (time, timer, audio and input wrapped onto the same virtual clock) agreed on every frame and every buffer.`,
      args: gameArgs(game), input: game.input, frames: ours, audio: ours.audio,
    }) + '\n');
    console.log(`wrote ${GOLDEN}`);
  }
}
