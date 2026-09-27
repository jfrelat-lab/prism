// gate-keen-pixels.mjs — Keen Dreams' pictures, held to the REAL KDREAMS.EXE running under DOSBox-X.
//
// THE REFERENCE is the shipped shareware 1.13 binary, started the way its own shell starts it
// (START.EXE, option 5), driven by AUTOTYPE and recorded by DOSBox-X's `DX-CAPTURE /V`. That records
// the EMULATED framebuffer as ZMBV -- palette indices, before any scaling -- which tools/zmbv.mjs
// reads. Nothing is needed from the guest, so a game that takes INT 8 unchained, as Keen does, cannot
// stop the capture the way it stops a resident grabber.
//
// THE CLAIM: every screen PRISM's build of the same game shows for at least STABLE consecutive
// frames, on the same key path (a key at the text screen, Enter at the title, Enter for a new game),
// is a screen the real binary also showed -- pixel for pixel, each channel reduced to the EGA's four
// levels. The two runs are not synchronised (virtual microseconds against DOSBox cycles), so the gate
// asks for a set inclusion, not a frame-by-frame match; and it requires at least MIN_SCREENS matches
// and the world map among them, so a run that shows nothing cannot pass.
//
// What it found on its first run, each invisible to every other gate: the colours of a 200-line
// mode (IRGB, brown), the palette the BIOS loads with one, and a far pointer's asm views
// re-normalising their offset (src/env/ega.js, src/asm/borland.js).
//
// No game data enters the repository: the golden holds hashes of screens. Replaying needs the data
// set (PRISM_KEEN_DATA, default ~/games/keendreams) and SKIPS without it; capturing needs DOSBox-X.
//
//   node tools/gate-keen-pixels.mjs --capture      # the real binary, into goldens/keen-pixels.json
//   node tools/gate-keen-pixels.mjs                # PRISM against it
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdtempSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zmbvFrames } from './zmbv.mjs';
import { skip } from './gate-skip.mjs';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'keen-pixels.json');
const DATA = process.env.PRISM_KEEN_DATA ?? join(process.env.HOME ?? '', 'games', 'keendreams');
const STABLE = 3, MIN_SCREENS = 25, VIRTUAL_SECONDS = 30;
// The same path on both sides. DOSBox-X: START's menu wants 5, then the text screen a key, the
// title Enter, the control panel Enter. PRISM starts KDREAMS directly (its 1.93 source has no START
// check), so its script begins at the text screen.
const DBX_KEYS = '-w 3 -p 6 5 space enter enter';
const PRISM_KEYS = [[2000, 57], [2100, 185], [5000, 28], [5100, 156], [7000, 28], [7100, 156]];

const level = (v) => Math.round(v / 85);                  // 00/55/AA/FF (or A8, FC) -> 0..3
function canon(pix, rgb) {
  const lut = new Uint8Array(256);
  for (let c = 0; c < 256; c++) { const [r, g, b] = rgb(c); lut[c] = (level(r) << 4) | (level(g) << 2) | level(b); }
  const out = new Uint8Array(pix.length);
  for (let i = 0; i < pix.length; i++) out[i] = lut[pix[i]];
  return out;
}
const hash = (a) => createHash('sha1').update(a).digest('hex').slice(0, 16);

function capture() {
  if (!existsSync(DATA)) throw new Error(`--capture needs the data set at ${DATA} (PRISM_KEEN_DATA)`);
  const work = mkdtempSync(join(tmpdir(), 'keenref-'));
  mkdirSync(join(work, 'game')); mkdirSync(join(work, 'cap'));
  for (const f of readdirSync(DATA)) if (statSync(join(DATA, f)).isFile()) copyFileSync(join(DATA, f), join(work, 'game', f));
  const r = spawnSync('dosbox-x', ['-silent', '-nogui', '-nomenu', '-time-limit', '45',
    '-set', `dosbox captures=${join(work, 'cap')}`, '-set', 'dosbox machine=ega', '-set', 'cpu cycles=12000',
    '-c', `mount c "${join(work, 'game')}"`, '-c', 'c:', '-c', `autotype ${DBX_KEYS}`, '-c', 'dx-capture /v start', '-c', 'exit'],
  { encoding: 'utf8', env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  if (r.status !== 0) throw new Error(`dosbox-x: ${r.stderr}`);
  // DOSBox-X starts a new file when the video mode changes; the game's 320x200 is one of them.
  const screens = new Set();
  let frames = 0;
  for (const f of readdirSync(join(work, 'cap')).filter((x) => x.endsWith('.avi')).sort()) {
    for (const fr of zmbvFrames(readFileSync(join(work, 'cap', f)))) {
      if (!fr.pix || fr.width !== 320 || fr.height !== 200) continue;
      frames++;
      screens.add(hash(canon(fr.pix, (i) => [fr.palette[3 * i], fr.palette[3 * i + 1], fr.palette[3 * i + 2]])));
    }
  }
  writeFileSync(GOLDEN, `${JSON.stringify({
    _doc: 'Keen Dreams shareware 1.13, the real KDREAMS.EXE started through START.EXE under DOSBox-X '
      + '(machine=ega, cycles=12000), keys by AUTOTYPE, recorded with DX-CAPTURE /V and read by '
      + 'tools/zmbv.mjs. Each entry is the hash of one distinct 320x200 screen, every pixel an EGA '
      + 'colour reduced to 2 bits a channel. Captured by tools/gate-keen-pixels.mjs --capture.',
    keys: DBX_KEYS, frames, screens: [...screens].sort(),
  })}\n`);
  console.log(`captured ${frames} frames, ${screens.size} distinct screens -> goldens/keen-pixels.json`);
}

if (process.argv.includes('--capture')) capture();
if (!existsSync(GOLDEN)) { console.log('no goldens/keen-pixels.json: run with --capture first'); process.exit(1); }
if (!existsSync(join(DATA, 'KDREAMS.EGA'))) skip(`Keen Dreams' data set: KDREAMS.EGA and static/ at ${DATA}`, 'set PRISM_KEEN_DATA to the shareware 1.13 directory (tools/keen-static.mjs writes static/)');
const ref = new Set(JSON.parse(readFileSync(GOLDEN, 'utf8')).screens);

// --- PRISM, on the same key path
const files = Object.fromEntries(readdirSync(DATA).filter((f) => /^KDREAMS\./i.test(f))
  .map((f) => [f.toUpperCase(), new Uint8Array(readFileSync(join(DATA, f)))]));
const target = loadTarget(join(ROOT, 'targets', 'keendreams.json'));
target.dataObjects = target.dataObjects.map((o) => (/MAP(HEAD|DICT)/.test(o.file ?? '') ? { ...o, file: join(DATA, 'static', o.file.split('/').pop()) } : o));
const { program: p } = buildTarget(target, { root: ROOT,
  envExtra: { stdio: { files }, pcirq: { keys: PRISM_KEYS.map(([ms, scan]) => ({ ms, scan })) } } });
const seen = new Map();                                   // hash -> { first, held }
let last = null, run = 0, next = 0;
const sp = p.M.sp_;
p.M.sp_ = (...a) => {
  if (p.M.vclock.us >= next) {
    next += 14286;                                        // one sample per 70 Hz frame of virtual time
    const f = p.M.ega.indexed();
    if (f) {
      const h = hash(canon(f.pix, (i) => (i < 16 ? f.palette[i] : [0, 0, 0])));
      run = h === last ? run + 1 : 1; last = h;
      const s = seen.get(h) ?? { first: p.M.vclock.us / 1e6, held: 0 };
      s.held = Math.max(s.held, run); seen.set(h, s);
    }
    if (p.M.vclock.us >= VIRTUAL_SECONDS * 1e6) throw new Error('__done');
  }
  return sp(...a);
};
try { p.run(['C:\\KDREAMS.EXE']); } catch (e) { if (e.message !== '__done') throw e; }

const stable = [...seen].filter(([, s]) => s.held >= STABLE);
const missing = stable.filter(([h]) => !ref.has(h));
let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(64)} ${detail}`); };
report(stable.length >= MIN_SCREENS, `at least ${MIN_SCREENS} stable screens in ${VIRTUAL_SECONDS} s of virtual time`, `${stable.length}`);
report(!missing.length, `every one of them is a screen the real KDREAMS.EXE showed`,
  missing.length ? `${missing.length} are not: first at ${missing[0][1].first.toFixed(2)} s` : `${stable.length} of ${stable.length}`);
const lastSeen = Math.max(...stable.map(([, s]) => s.first));
report(lastSeen > 20, 'and the path reached the world map (a stable screen after 20 s)', `${lastSeen.toFixed(2)} s`);
console.log(bad ? `\n${bad} WRONG` : '\nKeen Dreams draws what the shipped binary draws, screen for screen.');
process.exit(bad ? 1 : 0);
