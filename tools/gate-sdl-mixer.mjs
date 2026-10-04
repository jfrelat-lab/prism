// gate-sdl-mixer.mjs — PRISM's SDL_mixer mixes sound effects as the real SDL_mixer 1.2 does.
//
// src/env/sdlmixer.js loads a WAV, converts it to the device's format and mixes channels itself, and
// what comes out is what a player hears. tests/sdl/mixer.c writes three WAV files in three formats,
// plays them together -- a chunk volume, a channel volume, a loop -- and captures the mixed stream
// through Mix_SetPostMix, the library's own tap. It runs against the real SDL 1.2.15 and SDL_mixer
// 1.2.12 in the oracle container (SDL_AUDIODRIVER=dummy), and through PRISM, on three devices that
// between them make every conversion SDL knows for PCM: halving and doubling a rate once and twice,
// 8 bits to 16 and back, mono to stereo and back. Every line must be the same -- the length of the
// stream, a checksum over every byte, samples along it.
//
// Controls: each rule the reference decided, swapped for its near miss.
//
//   node tools/gate-sdl-mixer.mjs
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';
import { virtualClock } from '../src/env/clock.js';
import { FILTER, MIX_RULES } from '../src/env/sdlmixer.js';
import { up, sh, SCRATCH } from './oracle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEVICES = [['22050', '16', '2'], ['11025', '8', '1'], ['44100', '16', '1']];

// --- the reference: the real libraries
up();
mkdirSync(join(SCRATCH, 'sdlmix'), { recursive: true });
copyFileSync(join(ROOT, 'tests', 'sdl', 'mixer.c'), join(SCRATCH, 'sdlmix', 'mixer.c'));
const built = sh('cd /work/sdlmix && gcc -O1 -o mixer mixer.c -I/usr/include/SDL -lSDL_mixer -lSDL 2>&1');
if (built.code !== 0) { console.log(` BAD  the reference did not build:\n${built.stdout}${built.stderr}`); process.exit(1); }
const reference = (device) => sh(`cd /work/sdlmix && SDL_AUDIODRIVER=dummy ./mixer ${device.join(' ')}; echo "(exit $?)"`).stdout;

// --- PRISM: the same source on its own SDL 1.2 and SDL_mixer, with a clock that only moves when
//     the program waits, so the run is the same run every time
function prism(device) {
  const target = { name: 'sdl-mixer', dir: 'tests/sdl', units: { list: ['mixer.c'] }, env: ['stdio', 'sdl12'], compile: { memory: 16 } };
  const { program } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files: {} }, sdl12: { clock: virtualClock() } } });
  const r = program.run(['mixer', ...device]);
  return `${r.stdout}(exit ${r.code})\n`;
}

let bad = 0;
const report = (ok, what, detail = '') => { if (!ok) bad++; console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(62)} ${detail}`); };
const want = new Map();
for (const device of DEVICES) {
  const name = `${device[0]} Hz, ${device[1]}-bit, ${device[2] === '2' ? 'stereo' : 'mono'}`;
  const ref = reference(device);
  want.set(device, ref);
  // A reference that mixed nothing would agree with a mixer that mixes nothing.
  const frames = +(/mixed (\d+) frames/.exec(ref)?.[1] ?? 0);
  if (frames < 1000 || !ref.includes('(exit 0)')) { report(false, `${name}: the reference mixed a stream`, JSON.stringify(ref.slice(0, 120))); continue; }
  let got;
  try { got = prism(device); } catch (e) { got = `PRISM: ${e.message.split('\n')[0]}`; }
  const a = ref.split('\n'), b = got.split('\n');
  report(got === ref, `${name}: the mixed stream is the real mixer's`, `${a.filter((l, i) => l === b[i]).length} of ${a.length} lines, ${frames} frames`);
  if (got !== ref) {
    let shown = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 4; i++) {
      if (a[i] !== b[i]) { console.log(`       line ${i + 1}\n         prism: ${JSON.stringify(b[i])}\n         real : ${JSON.stringify(a[i])}`); shown++; }
    }
  }
}

/*
 * Each control changes one rule, runs every device, and must be told apart on at least one. The
 * rule is put back afterwards whatever happened.
 */
const swap = (object, key, value) => { const was = object[key]; object[key] = value; return () => { object[key] = was; }; };
const controls = [
  ['two channels averaged by shift, not by division', () => swap(MIX_RULES, 'monoHalf', (sum) => sum >> 1)],
  ['an 8-bit sum that saturates at 255, not 254', () => swap(MIX_RULES, 'top8', 255)],
  ['a volume applied by shift, not by division', () => swap(MIX_RULES, 'scale16', (s, v) => (s * v) >> 7)],
  ['a halved rate that keeps the second frame of each pair', () => swap(FILTER, 'div2', (c) => {
    const n = Math.floor(c.len / (2 * c.unit));
    for (let i = 0; i < n; i++) for (let k = 0; k < c.unit; k++) c.buf[i * c.unit + k] = c.buf[(2 * i + 1) * c.unit + k];
    c.len = Math.floor(c.len / 2);
  })],
  ['a doubled rate that interpolates instead of repeating', () => swap(FILTER, 'mul2', (c) => {
    const src = c.buf.slice(0, c.len), n = Math.floor(c.len / c.unit);
    for (let i = 0; i < n; i++) for (let k = 0; k < c.unit; k++) {
      const here = src[i * c.unit + k], next = src[Math.min(i + 1, n - 1) * c.unit + k];
      c.buf[2 * i * c.unit + k] = here; c.buf[(2 * i + 1) * c.unit + k] = (here + next) >> 1;
    }
    c.len *= 2;
  })],
  ['8 bits widened without the sign change', () => swap(FILTER, 'sign', () => {})],
];
for (const [name, apply] of controls) {
  const undo = apply();
  let told = 0, ran = 0;
  try {
    for (const device of DEVICES) {
      let out;
      try { out = prism(device); ran++; } catch (e) { out = `threw: ${e.message.split('\n')[0]}`; }
      if (out !== want.get(device)) told++;
    }
  } finally { undo(); }
  // A control that threw on every device was not run, and proves nothing about the comparison.
  report(told > 0 && ran > 0, `control: ${name}`, ran ? `told apart on ${told} of ${DEVICES.length} devices` : 'could not be run');
}

if (bad) { console.log(`\n${bad} check(s) failed.`); process.exit(1); }
console.log('\nSound effects are mixed as SDL_mixer 1.2 mixes them.');
