// gate-jnb-pixels.mjs — Jump 'n Bump, held to its own jumpbump.exe running under DOSBox-X.
//
// THE REFERENCE is the DJGPP binary shipped with the game, on a VGA-only DOSBox-X recorded by
// `DX-CAPTURE /V` (tools/dosref.mjs): its unchained 400x256 mode arrives as 800x512, 32 bpp, each
// pixel doubled. PRISM's page is the one the CRTC start address shows (src/env/vgaplanar.js), through
// its DAC, both reduced to six-bit r,g,b.
//
// THE CLAIM IS STRONGER THAN THE OTHER PIXEL GATES': not "every screen held for a while", but
// EVERY PAGE PRISM FLIPS in its first FLIPS is a page the real binary showed -- the fade-in, the menu,
// the bunnies' idle animation, the flies. That is possible because the program's one source of
// variety is `srandom(time(0))` (main.c), and both clocks can be made to say the same thing:
// PRISM's time() is a fixed 1997-01-01 00:00:00, and the reference run sets the DOS date and time to
// exactly that before starting the game. Everything after is the program's own arithmetic.
//
// It is what found that PRISM seeded random() the glibc way for a DJGPP program. DJGPP's libc keeps
// the 4.3BSD seeding (r[i] = 1103515245 r[i-1] + 12345, read out of the libc inside jumpbump.exe once
// its DJP packing is undone): with glibc's, 1 page of 106 matched, the first menu placing the
// bunnies elsewhere. Both that and a DAC mutation turn this gate red.
//
// Replaying needs the game (PRISM_JNB_DATA, a directory with jumpbump.dat; default ~/games/jumpnbump)
// and SKIPS without it; capturing needs DOSBox-X and jumpbump.exe with cwsdpmi.exe beside it.
//
//   node tools/gate-jnb-pixels.mjs --capture     # the real binary, into goldens/jnb-pixels.json
//   node tools/gate-jnb-pixels.mjs               # PRISM against it
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbxRun, vgaScreens, vgaHash as hash, sixBit } from './dosref.mjs';
import { skip } from './gate-skip.mjs';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'jnb-pixels.json');
const DATA = process.env.PRISM_JNB_DATA ?? join(process.env.HOME ?? '', 'games', 'jumpnbump');
const W = 400, H = 256, FLIPS = 300, MIN_PAGES = 100;
// PRISM's time() (src/runtime/runtime.js), as the DOS commands that set the reference's clock to it.
const CLOCK = ['date 01/01/1997', 'time 00:00:00'];

if (process.argv.includes('--capture')) {
  if (!existsSync(join(DATA, 'jumpbump.exe'))) throw new Error(`--capture needs jumpbump.exe at ${DATA}`);
  const files = dbxRun({ dir: DATA, command: 'jumpbump', seconds: 25, before: CLOCK });
  const screens = new Set(), stats = { frames: 0, text: 0, torn: 0 };
  for (const c of vgaScreens(files, W, H, stats)) screens.add(hash(c));
  writeFileSync(GOLDEN, `${JSON.stringify({
    _doc: "Jump 'n Bump's own jumpbump.exe under DOSBox-X (machine=vgaonly, cycles=max, 25 s, DOS clock "
      + 'set to 1997-01-01 00:00:00, no keys), recorded with DX-CAPTURE /V and read by tools/dosref.mjs. '
      + 'Each entry is the hash of one distinct 400x256 page, every pixel six-bit r,g,b. Captured by '
      + 'tools/gate-jnb-pixels.mjs --capture.',
    frames: stats.frames, textFrames: stats.text, tornFrames: stats.torn, screens: [...screens].sort(),
  })}\n`);
  console.log(`captured ${stats.frames} frames (${stats.text} text-mode, ${stats.torn} torn left out), ${screens.size} distinct -> goldens/jnb-pixels.json`);
}
if (!existsSync(GOLDEN)) { console.log('no goldens/jnb-pixels.json: run with --capture first'); process.exit(1); }
if (!existsSync(join(DATA, 'jumpbump.dat'))) skip(`Jump 'n Bump's data at ${DATA}`, 'set PRISM_JNB_DATA to a directory holding jumpbump.dat');
const ref = new Set(JSON.parse(readFileSync(GOLDEN, 'utf8')).screens);

const target = loadTarget(join(ROOT, 'targets', 'jumpnbump.json'));
const files = {};
for (const f of readdirSync(DATA)) if (statSync(join(DATA, f)).isFile()) files[f] = new Uint8Array(readFileSync(join(DATA, f)));
for (const [name, text] of Object.entries(target.files ?? {})) if (!(name in files)) files[name] = new TextEncoder().encode(`${text}\n`);
const { program } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files } } });
const vga = program.M.vga, u8 = program.M.u8;
const pages = [];                                         // { flip, hash } of every page shown at 400x256
let flips = 0;
vga.onFrame = () => {
  const { width, height, rowBytes } = vga.geometry();
  if (width === W && height === H) {
    const at = (i) => { const x = i % W, y = (i - x) / W; return u8[vga.planes + (x & 3) * 0x10000 + vga.start + y * rowBytes + (x >> 2)]; };
    pages.push({ flip: flips, hash: hash(sixBit(at, W * H, program.M.dac.palette)) });
  }
  if (++flips >= FLIPS) throw new Error('__done');
};
try { program.run([target.name, ...(target.args ?? '').split(/\s+/).filter(Boolean)]); } catch (e) { if (e.message !== '__done') throw e; }

const distinct = new Set(pages.map((p) => p.hash));
const missing = pages.filter((p) => !ref.has(p.hash));
let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${detail}`); };
report(flips === FLIPS, `the game flipped ${FLIPS} pages`, `${flips}`);
report(distinct.size >= MIN_PAGES, `at least ${MIN_PAGES} distinct 400x256 pages among them`, `${distinct.size}`);
report(!missing.length, 'every page PRISM showed is one the real jumpbump.exe showed',
  missing.length ? `${pages.length - missing.length} of ${pages.length}; first miss at flip ${missing[0].flip}` : `${pages.length} of ${pages.length}`);
console.log(bad ? `\n${bad} WRONG` : "\nJump 'n Bump shows what jumpbump.exe shows, page for page.");
process.exit(bad ? 1 : 0);
