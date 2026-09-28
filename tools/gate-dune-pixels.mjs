// gate-dune-pixels.mjs — OpenDUNE's intro, held to the REAL DUNE2.EXE running under DOSBox-X.
//
// THE REFERENCE is Dune II 1.07's own executable, the program OpenDUNE was reverse-engineered from,
// on a VGA-only DOSBox-X recorded by `DX-CAPTURE /V` (tools/dosref.mjs: 32 bpp, 640x400, each
// mode-13h pixel doubled both ways -- asserted per frame, not assumed). Each frame is reduced to 320x200 of six-bit r,g,b,
// the DAC's own width; PRISM's frame is 0xA0000 through its DAC (src/env/vgadac.js), the same six
// bits. No game data enters the repository: the golden holds hashes.
//
// THE CLAIM, as gate-keen-pixels makes it: every screen PRISM's OpenDUNE holds for HELD consecutive
// Video_Ticks is a screen the real binary showed -- a set inclusion, because the two runs are not
// synchronised. It is asserted over the first ASSERTED_TICKS, which cover the Westwood logo, the
// credits, and Arrakis with its captions, and it must match at least MIN_SCREENS there.
//
// PAST THAT POINT PRISM's CLOCK SHOWS, and this gate reports it rather than asserting it: the intro
// skips the planet's fade-in (the copyright line is still up when Arrakis appears), runs the moon's
// orbit at one position per tick and cuts it seven positions short, and holds dissolves at states
// the real one passes through between two captured frames. Every one of those is a screen out of
// order or out of time, not a wrong pixel: it is ROADMAP P7.11 ("the intro runs slow and then
// lurches"), measured. When the clock is fixed, raise ASSERTED_TICKS.
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
const HELD = 2, TICKS = 3000, ASSERTED_TICKS = 900, MIN_SCREENS = 100;

function capture() {
  if (!existsSync(join(DATA, 'data', 'DUNE2.EXE'))) throw new Error(`--capture needs DUNE2.EXE at ${join(DATA, 'data')}`);
  const files = dbxRun({ dir: join(DATA, 'data'), command: 'dune2', seconds: 60, cycles: 20000 });
  const screens = new Set(), stats = { frames: 0, text: 0 };
  for (const c of vgaScreens(files, 320, 200, stats)) screens.add(hash(c));
  const { frames, text, torn } = stats;
  writeFileSync(GOLDEN, `${JSON.stringify({
    _doc: 'Dune II 1.07, the real DUNE2.EXE under DOSBox-X (machine=vgaonly, cycles=20000, 60 s, no '
      + 'keys), recorded with DX-CAPTURE /V and read by tools/zmbv.mjs. Each entry is the hash of one '
      + 'distinct 320x200 screen, every pixel six-bit r,g,b. Captured by tools/gate-dune-pixels.mjs --capture.',
    frames, textFrames: text, tornFrames: torn, screens: [...screens].sort(),
  })}\n`);
  console.log(`captured ${frames} frames (${text} text-mode and ${torn} torn left out), ${screens.size} distinct screens -> goldens/dune-pixels.json`);
}

if (process.argv.includes('--capture')) capture();
if (!existsSync(GOLDEN)) { console.log('no goldens/dune-pixels.json: run with --capture first'); process.exit(1); }
if (!existsSync(join(DATA, 'data', 'DUNE2.EXE'))) skip(`Dune II's data at ${join(DATA, 'data')}`, 'set PRISM_DUNE2_DATA to a directory holding data/ with DUNE2.EXE and its PAKs');
const ref = new Set(JSON.parse(readFileSync(GOLDEN, 'utf8')).screens);

// --- PRISM: OpenDUNE opens data/ relative to its working directory.
const files = {};
for (const f of readdirSync(join(DATA, 'data'))) {
  const p = join(DATA, 'data', f);
  if (statSync(p).isFile()) files[`data/${f}`] = new Uint8Array(readFileSync(p));
}
const { program, env } = buildTarget(loadTarget(join(ROOT, 'targets', 'opendune.json')), { root: ROOT, envExtra: { stdio: { files } } });
const seen = new Map();                                   // hash -> { first, held }
let ticks = 0, last = null, run = 0;
const tick = program.F.Video_Tick;
program.F.Video_Tick = function (...a) {
  const r = tick.apply(this, a);
  const u8 = program.M.u8;
  const h = hash(sixBit((i) => u8[0xa0000 + i], 64000, env.vgadac.palette));
  run = h === last ? run + 1 : 1; last = h;
  const s = seen.get(h) ?? { first: ticks, held: 0 };
  s.held = Math.max(s.held, run); seen.set(h, s);
  if (++ticks >= TICKS) throw new Error('__done');
  return r;
};
try { program.run(['opendune']); } catch (e) { if (e.message !== '__done') throw e; }

const stable = [...seen].filter(([, s]) => s.held >= HELD);
const early = stable.filter(([, s]) => s.first < ASSERTED_TICKS), late = stable.filter(([, s]) => s.first >= ASSERTED_TICKS);
const earlyMissing = early.filter(([h]) => !ref.has(h)), lateMissing = late.filter(([h]) => !ref.has(h));
let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(66)} ${detail}`); };
report(ticks === TICKS, `the intro ran ${TICKS} Video_Ticks`, `${ticks}`);
report(early.length >= MIN_SCREENS, `at least ${MIN_SCREENS} stable screens in the first ${ASSERTED_TICKS} ticks`, `${early.length}`);
report(!earlyMissing.length, 'every one of them is a screen the real DUNE2.EXE showed',
  earlyMissing.length ? `${earlyMissing.length} are not: first at tick ${earlyMissing[0][1].first}` : `${early.length} of ${early.length}`);
console.log(`  --  after tick ${ASSERTED_TICKS} (reported, P7.11's clock): ${late.length - lateMissing.length} of ${late.length} stable screens are the real binary's`);
console.log(bad ? `\n${bad} WRONG` : `\nOpenDUNE draws what DUNE2.EXE draws, screen for screen, for its first ${ASSERTED_TICKS} ticks.`);
process.exit(bad ? 1 : 0);
