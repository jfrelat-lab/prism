// gate-dune-pixels.mjs — OpenDUNE's intro, held to the REAL DUNE2.EXE running under DOSBox-X:
// what it draws, and WHEN.
//
// THE REFERENCE is Dune II 1.07's own executable, the program OpenDUNE was reverse-engineered from,
// on a VGA-only DOSBox-X recorded by `DX-CAPTURE /V` (tools/dosref.mjs: 32 bpp, 640x400, each
// mode-13h pixel doubled both ways -- checked per frame, not assumed). Each frame is reduced to
// 320x200 of six-bit r,g,b, the DAC's own width; PRISM's frame is 0xA0000 through its DAC
// (src/env/vgadac.js), the same six bits. The golden holds, per distinct screen, its hash and the
// time the real binary first showed it (capture frame / 70.086 Hz). No game data enters the repository.
//
// TWO CLAIMS.
//
//   PICTURES: every screen PRISM holds for HELD consecutive Video_Ticks before ASSERTED_S of virtual
//   time -- the Westwood logo, the credits, Arrakis and its captions -- is a screen the real binary
//   showed, at least MIN_SCREENS of them. A set inclusion, because the runs are not synchronised.
//   Past that point the intro's animations (the moon's orbit, the dissolves) pick their frame from
//   the elapsed time, so which of their frames appear depends on the exact PHASE of the clock, not
//   on its correctness; that part is reported, not asserted.
//
//   TIME: for every screen both sides showed, PRISM's virtual time against the real one's, fitted
//   by a line whose slope must be within SLOPE of 1. This is P7.11 ("the intro runs slow and then
//   lurches"), measured: with a clock() that stepped every call, PRISM ran the intro at 0.59x the
//   real one's time, because Watcom's DOS clock() -- measured with Open Watcom's own libc under
//   DOSBox-X -- counts milliseconds (CLOCKS_PER_SEC 1000) in BIOS-tick lumps of ~55 ms, and
//   OpenDUNE's "callonce" timers fire at most once per lump (src/env/watcom.js watcomClock).
//
// Replaying needs the data (PRISM_DUNE2_DATA, a directory holding data/DUNE2.EXE and its PAKs;
// default ~/games/dune2) and SKIPS without it; capturing needs DOSBox-X.
//
//   node tools/gate-dune-pixels.mjs --capture     # the real binary, into goldens/dune-pixels.json
//   node tools/gate-dune-pixels.mjs               # PRISM against it
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbxRun, vgaScreens, vgaHash as hash, sixBit } from './dosref.mjs';
import { skip } from './gate-skip.mjs';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'dune-pixels.json');
const DATA = process.env.PRISM_DUNE2_DATA ?? join(process.env.HOME ?? '', 'games', 'dune2');
const CAPTURE_HZ = 70.086;                 // DOSBox-X's mode-13h frame rate on a vgaonly machine
const HELD = 2, RUN_S = 60, ASSERTED_S = 28, MIN_SCREENS = 50, SLOPE = 0.08;

function capture() {
  if (!existsSync(join(DATA, 'data', 'DUNE2.EXE'))) throw new Error(`--capture needs DUNE2.EXE at ${join(DATA, 'data')}`);
  const files = dbxRun({ dir: join(DATA, 'data'), command: 'dune2', seconds: 60, cycles: 20000 });
  const first = new Map(), stats = { frames: 0, text: 0 };
  for (const c of vgaScreens(files, 320, 200, stats)) {
    const h = hash(c);
    if (!first.has(h)) first.set(h, +(stats.at / CAPTURE_HZ).toFixed(3));
  }
  const { frames, text, torn } = stats;
  writeFileSync(GOLDEN, `${JSON.stringify({
    _doc: 'Dune II 1.07, the real DUNE2.EXE under DOSBox-X (machine=vgaonly, cycles=20000, 60 s, no '
      + 'keys), recorded with DX-CAPTURE /V and read by tools/dosref.mjs. Each entry maps the hash of '
      + 'one distinct 320x200 screen (every pixel six-bit r,g,b) to the time in seconds it was first '
      + `shown (capture frame / ${CAPTURE_HZ}). Captured by tools/gate-dune-pixels.mjs --capture.`,
    frames, textFrames: text, tornFrames: torn,
    screens: Object.fromEntries([...first].sort((a, b) => a[1] - b[1])),
  })}\n`);
  console.log(`captured ${frames} frames (${text} text-mode and ${torn} torn left out), ${first.size} distinct screens -> goldens/dune-pixels.json`);
}

if (process.argv.includes('--capture')) capture();
if (!existsSync(GOLDEN)) { console.log('no goldens/dune-pixels.json: run with --capture first'); process.exit(1); }
if (!existsSync(join(DATA, 'data', 'DUNE2.EXE'))) skip(`Dune II's data at ${join(DATA, 'data')}`, 'set PRISM_DUNE2_DATA to a directory holding data/ with DUNE2.EXE and its PAKs');
const ref = new Map(Object.entries(JSON.parse(readFileSync(GOLDEN, 'utf8')).screens));

// --- PRISM: OpenDUNE opens data/ relative to its working directory. Its time is the runtime's
// deterministic clock (M.clockTicks, microseconds), which clock() reports through Watcom's lumps.
const files = {};
for (const f of readdirSync(join(DATA, 'data'))) {
  const p = join(DATA, 'data', f);
  if (statSync(p).isFile()) files[`data/${f}`] = new Uint8Array(readFileSync(p));
}
const { program, env } = buildTarget(loadTarget(join(ROOT, 'targets', 'opendune.json')), { root: ROOT, envExtra: { stdio: { files } } });
const seen = new Map();                                   // hash -> { first (s), held }
let last = null, run = 0;
const tick = program.F.Video_Tick;
program.F.Video_Tick = function (...a) {
  const r = tick.apply(this, a);
  const t = program.M.clockTicks / 1e6, u8 = program.M.u8;
  const h = hash(sixBit((i) => u8[0xa0000 + i], 64000, env.vgadac.palette));
  run = h === last ? run + 1 : 1; last = h;
  const s = seen.get(h) ?? { first: t, held: 0 };
  s.held = Math.max(s.held, run); seen.set(h, s);
  if (t >= RUN_S) throw new Error('__done');
  return r;
};
try { program.run(['opendune']); } catch (e) { if (e.message !== '__done') throw e; }

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(66)} ${detail}`); };

// PICTURES
const stable = [...seen].filter(([, s]) => s.held >= HELD);
const early = stable.filter(([, s]) => s.first < ASSERTED_S), late = stable.filter(([, s]) => s.first >= ASSERTED_S);
const earlyMissing = early.filter(([h]) => !ref.has(h));
report(early.length >= MIN_SCREENS, `at least ${MIN_SCREENS} stable screens in the first ${ASSERTED_S} s`, `${early.length}`);
report(!earlyMissing.length, 'every one of them is a screen the real DUNE2.EXE showed',
  earlyMissing.length ? `${earlyMissing.length} are not: first at ${earlyMissing[0][1].first.toFixed(2)} s` : `${early.length} of ${early.length}`);
console.log(`  --  after ${ASSERTED_S} s (reported: animation frames follow the clock's phase): ${late.filter(([h]) => ref.has(h)).length} of ${late.length} stable screens are the real binary's`);

// TIME
const pairs = [...seen].filter(([h]) => ref.has(h)).map(([h, s]) => [ref.get(h), s.first]);
const n = pairs.length, mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n;
const slope = pairs.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pairs.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
const span = Math.max(...pairs.map((p) => p[0])) - Math.min(...pairs.map((p) => p[0]));
report(span > 40, 'the shared screens span the intro', `${n} screens over ${span.toFixed(1)} s of the real run`);
report(Math.abs(slope - 1) <= SLOPE, `PRISM's virtual time runs at the real binary's rate (within ${SLOPE})`, `slope ${slope.toFixed(3)}, offset ${(my - slope * mx).toFixed(2)} s`);
console.log(bad ? `\n${bad} WRONG` : '\nOpenDUNE draws what DUNE2.EXE draws, and on its clock.');
process.exit(bad ? 1 : 0);
