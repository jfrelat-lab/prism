// gate-wolf3d-pixels.mjs — Wolfenstein 3-D's pictures, held to the binary its own source built, under DOSBox-X.
//
// THE REFERENCE is WOLFSRC/WOLF3D.EXE: the executable id shipped beside the released source, built
// from it (its WOLF3D.MAP names every symbol), run on the id/Activision 1.4 six-episode data -- the
// set GFXV_WL6.H numbers. A key at its signon is typed by AUTOTYPE and the run is recorded by DOSBox-X's
// `DX-CAPTURE /V`. machine=vgaonly records mode 13h as 640x400 32-bit frames (B,G,R,x, every pixel
// doubled both ways), which tools/zmbv.mjs reads; the gate takes every other pixel of every other line.
// Not the id/Activision binary: the released source is the GoodTimes build (VERSION.H), whose signon
// picture and high-score table (no CODE column) differ from it -- differences of source, not of PRISM.
//
// THE CLAIM: every screen PRISM's build shows for at least STABLE consecutive 70 Hz frames is a screen
// the reference showed -- pixel for pixel, each colour the DAC's six bits a channel. The runs are not
// synchronised, so it is a set inclusion, as in gate-keen-pixels. It is strict for the 3-D view
// because demo playback is: PollControls gives every frame exactly DEMOTICS tics (WL_PLAY.C), so a demo
// draws the same frames however fast the machine -- and the same game, so ONE wrong decision (a guard
// that fires where the reference's walks on) changes every frame after it. It requires MIN_SCREENS
// matches and screens after DEMO_AFTER s, past the first demo into the second, so a run that shows
// nothing, or stops early, cannot pass.
//
// THE ONE EXCLUSION: the signon, PRISM's screens before its key. It draws the machine, not the
// program -- bars of free conventional, EMS and XMS memory and the devices found (mouse, AdLib,
// Sound Blaster), which DOSBox-X has and PRISM's env has not.
//
// What it found on its first run, each invisible to every other gate: ScaleLine's RETF patched into a
// compiled scaler that MIRAGE kept running unpatched (sprites drawn too long; compile.codeWriters),
// and abs(unsigned) handed to the runtime unconverted (a guard 13 tiles away read as 3, fired, and
// the demo went its own way; src/backend/emit.js).
//
// The compiled scalers run on the vendored MIRAGE core (src/asm/x86-mirage.js). The gate SKIPS without
// the data set (PRISM_WOLF3D_DATA, default ~/Projects/wolf3d-data/wl6). No game data
// enters the repository: the golden holds hashes of screens.
//
//   node tools/gate-wolf3d-pixels.mjs --capture    # the reference, into goldens/wolf3d-pixels.json
//   node tools/gate-wolf3d-pixels.mjs              # PRISM against it [--times] [--dump=dir]
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdtempSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zmbvFrames } from './zmbv.mjs';
import { skip } from './gate-skip.mjs';
import { installTargetX86Node } from './mirage-x86.mjs';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = process.argv.find((a) => a.startsWith('--golden='))?.slice(9) ?? join(ROOT, 'goldens', 'wolf3d-pixels.json');
const EXE = process.argv.find((a) => a.startsWith('--exe='))?.slice(6) ?? join(ROOT, 'corpus', 'Wolf3D', 'WOLFSRC', 'WOLF3D.EXE');
const DATA = process.env.PRISM_WOLF3D_DATA ?? join(process.env.HOME ?? '', 'Projects', 'wolf3d-data', 'wl6');
const STABLE = 3;
const MIN_SCREENS = 600, DEMO_AFTER = 125;
const VIRTUAL_SECONDS = Number(process.env.WOLF_SECONDS ?? 140), REF_SECONDS = 150;
const KEY_MS = 2000, PRISM_KEYS = [[KEY_MS, 57], [KEY_MS + 100, 185]];   // space at the signon

// The machine PRISM's env is: no Sound Blaster, no AdLib (src/env has neither yet). Wolf3D's logic reads
// what it found -- SpawnTrans and the SS death time their animations by SoundBlasterPresent/DigiMode.
const SOUNDLESS = ['-set', 'sblaster sbtype=none', '-set', 'sblaster oplmode=none', '-set', 'gus gus=false'];
const W = 320, H = 200;
const hash = (a) => createHash('sha1').update(a).digest('hex').slice(0, 16);
// One screen as 6-bit R,G,B a pixel: the DAC's own precision, whichever way a side widened it.
function canon(at) {
  const out = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { const [r, g, b] = at(i); out[3 * i] = r >> 2; out[3 * i + 1] = g >> 2; out[3 * i + 2] = b >> 2; }
  return out;
}

function capture(reuse) {
  const work = reuse ?? mkdtempSync(join(tmpdir(), 'wolfref-'));
  if (!reuse) {
    if (!existsSync(EXE)) throw new Error(`--capture needs WOLFSRC's own executable at ${EXE}`);
    if (!existsSync(join(DATA, 'VSWAP.WL6'))) throw new Error(`--capture needs the data set at ${DATA} (PRISM_WOLF3D_DATA)`);
    mkdirSync(join(work, 'game')); mkdirSync(join(work, 'cap'));
    for (const f of readdirSync(DATA)) if (statSync(join(DATA, f)).isFile() && !/\.zip$/i.test(f)) copyFileSync(join(DATA, f), join(work, 'game', f));
    copyFileSync(EXE, join(work, 'game', 'WOLF3D.EXE'));
    const r = spawnSync('dosbox-x', ['-silent', '-nogui', '-nomenu', '-time-limit', String(REF_SECONDS),
      '-set', `dosbox captures=${join(work, 'cap')}`, '-set', 'dosbox machine=vgaonly', '-set', 'cpu cycles=20000', ...SOUNDLESS,
      '-c', `mount c "${join(work, 'game')}"`, '-c', 'c:', '-c', 'autotype -w 4 space', '-c', 'dx-capture /v wolf3d', '-c', 'exit'],
    { encoding: 'utf8', env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
    if (r.status !== 0) throw new Error(`dosbox-x: ${r.stderr}`);
  }
  const screens = new Set();
  let frames = 0;
  for (const f of readdirSync(join(work, 'cap')).filter((x) => x.endsWith('.avi')).sort()) {
    for (const fr of zmbvFrames(readFileSync(join(work, 'cap', f)))) {
      if (!fr.pix || fr.bpp !== 32 || fr.width !== 2 * W || fr.height !== 2 * H) continue;
      frames++;
      screens.add(hash(canon((i) => { const q = ((2 * Math.floor(i / W)) * 2 * W + 2 * (i % W)) * 4; return [fr.pix[q + 2], fr.pix[q + 1], fr.pix[q]]; })));
    }
  }
  writeFileSync(GOLDEN, `${JSON.stringify({
    _doc: 'Wolfenstein 3-D, WOLFSRC/WOLF3D.EXE (the build of the released source) on the id/Activision 1.4 WL6 data, under DOSBox-X (machine=vgaonly, no sound card, '
      + `cycles=20000, ${REF_SECONDS} s), a space at the signon by AUTOTYPE, recorded with DX-CAPTURE /V and read by `
      + 'tools/zmbv.mjs. Each entry is the hash of one distinct 320x200 screen, every pixel the DAC\'s '
      + '6-bit R,G,B. Captured by tools/gate-wolf3d-pixels.mjs --capture.',
    frames, screens: [...screens].sort(),
  })}\n`);
  console.log(`captured ${frames} frames, ${screens.size} distinct screens -> goldens/wolf3d-pixels.json`);
}

const reuseAt = process.argv.indexOf('--reuse');
if (process.argv.includes('--capture')) capture(reuseAt > 0 ? process.argv[reuseAt + 1] : null);
if (!existsSync(GOLDEN)) { console.log('no goldens/wolf3d-pixels.json: run with --capture first'); process.exit(1); }
if (!existsSync(join(DATA, 'VSWAP.WL6'))) skip(`Wolfenstein 3-D's id/Activision 1.4 WL6 data at ${DATA}`, 'set PRISM_WOLF3D_DATA to the directory holding the *.WL6 files');
const ref = new Set(JSON.parse(readFileSync(GOLDEN, 'utf8')).screens);

// --- PRISM, on the same key
const files = Object.fromEntries(readdirSync(DATA).filter((f) => /\.WL6$/i.test(f))
  .map((f) => [f.toUpperCase(), new Uint8Array(readFileSync(join(DATA, f)))]));
const target = loadTarget(join(ROOT, 'targets', 'wolf3d.json'));
const { program: p } = buildTarget(target, { root: ROOT,
  envExtra: { stdio: { files }, pcirq: { keys: PRISM_KEYS.map(([ms, scan]) => ({ ms, scan })) } } });
await installTargetX86Node(p, target.x86);
const seen = new Map();                                   // hash -> { first, held }
const dumpDir = process.argv.find((a) => a.startsWith('--dump='))?.slice(7), dumps = new Map();
let last = null, run = 0, next = 0;
const sp = p.M.sp_;
p.M.sp_ = (...a) => {
  if (p.M.vclock.us >= next) {
    next += 14286;                                        // one sample per 70 Hz frame of virtual time
    const f = p.M.ega.mode === 0x13 ? p.M.ega.indexed() : null;
    if (f) {
      const h = hash(canon((i) => f.palette[f.pix[i]]));
      run = h === last ? run + 1 : 1; last = h;
      if (dumpDir && !seen.has(h) && !ref.has(h)) dumps.set(h, canon((i) => f.palette[f.pix[i]]));
      const s = seen.get(h) ?? { first: p.M.vclock.us / 1e6, held: 0 };
      s.held = Math.max(s.held, run); seen.set(h, s);
    }
    if (p.M.vclock.us >= VIRTUAL_SECONDS * 1e6) throw new Error('__done');
  }
  return sp(...a);
};
const t0 = performance.now();
let ended = 'at the time bound';
try { ended = `exited ${p.run(['C:\\WOLF3D.EXE']).code}`; } catch (e) { if (e.message !== '__done') throw e; }

const stable = [...seen].filter(([, s]) => s.held >= STABLE && s.first * 1000 > KEY_MS);
const missing = stable.filter(([h]) => !ref.has(h));
let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(64)} ${detail}`); };
report(stable.length >= MIN_SCREENS, `at least ${MIN_SCREENS} stable screens in ${VIRTUAL_SECONDS} s of virtual time`, `${stable.length}`);
report(!missing.length, 'every one of them is a screen the reference showed',
  missing.length ? `${missing.length} are not: first at ${Math.min(...missing.map(([, s]) => s.first)).toFixed(2)} s` : `${stable.length} of ${stable.length}`);
const demo = stable.filter(([, s]) => s.first > DEMO_AFTER).length;
report(demo > 0, `and demo frames among them (stable screens after ${DEMO_AFTER} s)`, `${demo}`);
if (process.argv.includes('--times')) for (const [h, s] of [...stable].sort((a, b) => a[1].first - b[1].first)) console.log(`   ${s.first.toFixed(2).padStart(6)} s  held ${String(s.held).padStart(3)}  ${ref.has(h) ? 'ref' : 'NOT'}  ${h}`);
if (dumpDir) { mkdirSync(dumpDir, { recursive: true }); for (const [h] of missing) writeFileSync(join(dumpDir, `${h}.rgb6`), dumps.get(h)); }
console.log(`(${((performance.now() - t0) / 1000).toFixed(0)} s real; the run ended ${ended} at ${(p.M.vclock.us / 1e6).toFixed(2)} s virtual)`);
console.log(bad ? `\n${bad} WRONG` : '\nWolfenstein 3-D draws what the shipped binary draws, screen for screen.');
process.exit(bad ? 1 : 0);
