// gate-sound.mjs — does the SEAL shim actually make the sound the program asked for?
//
// Sound is the one output this project cannot check by counting pixels, and "it did not throw" is
// not evidence. Worse, MAME 0.1 makes it hard to check by playing a game: only two of its five
// drivers have sound at all (pengo and ladybug), and both need ROMs that cannot live in this repo.
//
// So this gate goes at the seam directly. It compiles MAME's OWN src/msdos/msdos.c — the same file
// the emulator uses, unmodified — against a probe that plays a waveform whose every sample is known,
// and then checks the mixed output against an expectation computed HERE, independently of the mixer.
// A one-sample-per-period square wave has an exactly predictable resampling: at frequency f into a
// rate r, output sample n reads source sample floor(n * f / r) modulo the wave length.
//
//   node tools/gate-sound.mjs            # check
//   node tools/gate-sound.mjs --wav=/tmp/probe.wav
//
// The probe is a C program, not a JavaScript call into the shim, because the thing under test is the
// whole path: MAME's osd_play_sample -> SEAL -> the mixer -> the ring.

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram } from '../src/compile.js';
import { installAllegro, ALLEGRO_VARS } from '../src/env/allegro.js';
import { installStdio } from '../src/env/stdio.js';
import { installPorts } from '../src/env/ports.js';
import { HEADERS } from '../src/env/headers.js';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus', 'mame05');
if (!existsSync(join(SRC, 'src', 'msdos', 'msdos.c'))) {
  skip(`corpus missing: ${SRC}`, 'fetch it with the `fetch` line of targets/mame05.json');
}

const RATE = 44100;
const WAVE_LEN = 32;
const FREQ = 4000;
const VOLUME = 200;            // MAME's 0..255; msdos.c passes volume/4 to SEAL
const FRAMES = 30;

/*
 * The waveform, and the ONE place it is defined. The probe reads it from here as C source, and the
 * expectation below reads it from here as JavaScript — so a disagreement is a real disagreement and
 * not two different test waves.
 */
const WAVE = Array.from({ length: WAVE_LEN }, (_, i) => (i < WAVE_LEN / 2 ? 200 : 56));

const PROBE = `
#include "osdepend.h"

unsigned char wave[${WAVE_LEN}] = { ${WAVE.join(',')} };

int main(int argc, char **argv)
{
	int i;

	if (osd_init(argc, argv) != 0) return 1;
	osd_play_sample(0, wave, ${WAVE_LEN}, ${FREQ}, ${VOLUME}, 1);
	for (i = 0; i < ${FRAMES}; i++) osd_update_audio();
	osd_exit();
	return 0;
}
`;

const INCLUDE_DIRS = ['src', 'src/Z80', 'src/msdos'];
function resolver(name, angled, fromFile) {
  if (!angled && fromFile) {
    const local = join(dirname(fromFile), name);
    if (existsSync(local) && statSync(local).isFile()) {
      return { path: local, text: readFileSync(local, 'latin1') };
    }
  }
  for (const d of INCLUDE_DIRS) {
    const dir = join(SRC, d);
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find(f => f.toLowerCase() === name.toLowerCase());
    if (hit && statSync(join(dir, hit)).isFile()) {
      return { path: join(dir, hit), text: readFileSync(join(dir, hit), 'latin1') };
    }
  }
  const std = HEADERS[name] ?? HEADERS[basename(name)];
  return std === undefined ? { path: `<missing:${name}>`, text: '' } : { path: `<${name}>`, text: std };
}

const program = compileProgram([
  { file: join(SRC, 'src/msdos/msdos.c'), source: readFileSync(join(SRC, 'src/msdos/msdos.c'), 'latin1') },
  { file: 'prism-allegro-vars.c', source: ALLEGRO_VARS },
  { file: 'sound-probe.c', source: PROBE },
], { defines: { LSB_FIRST: '1' }, resolve: resolver, memory: 64 * 1024 * 1024 });

// "0\n" answers the audio-device prompt msdos.c prints; that is the program asking a question.
let at = 0;
const stdin = '0\n';
installStdio(program.M, { files: {}, readChar: () => (at < stdin.length ? stdin.charCodeAt(at++) : -1) });
installPorts(program.M);
const allegro = installAllegro(program.M);
allegro.bindGlobals(program);
program.M.audio.wav = [];
program.M.write = () => {};                       // the device list is not what is being checked

program.run(['probe', '-nojoy']);
const got = program.M.audio.wav;

/*
 * The expectation, computed without the mixer.
 *
 * SEAL's 8-bit format is UNSIGNED, centred on 128, and its volume runs 0..64 — msdos.c passes
 * MAME's 0..255 as volume/4. The play cursor advances freq/rate source samples per output sample,
 * and the wave loops. Everything here comes from SEAL's documented contract, not from reading the
 * shim.
 */
const vol = Math.floor(VOLUME / 4);
const want = [];
let pos = 0;
for (let n = 0; n < got.length; n++) {
  want.push(Math.max(-32768, Math.min(32767, (WAVE[Math.floor(pos)] - 128) * vol * 4)));
  pos += FREQ / RATE;
  if (pos >= WAVE_LEN) pos -= WAVE_LEN;
}

let bad = 0, firstBad = -1;
for (let i = 0; i < got.length; i++) {
  if (got[i] !== want[i]) { bad++; if (firstBad < 0) firstBad = i; }
}

let peak = 0, energy = 0;
for (const v of got) { const a = Math.abs(v); if (a > peak) peak = a; energy += v * v; }
const rms = got.length ? Math.sqrt(energy / got.length) : 0;

const wavPath = process.argv.find(a => a.startsWith('--wav='))?.slice(6);
if (wavPath) {
  const buf = Buffer.alloc(44 + got.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + got.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(got.length * 2, 40);
  for (let i = 0; i < got.length; i++) buf.writeInt16LE(got[i], 44 + i * 2);
  writeFileSync(wavPath, buf);
  console.log(`wrote ${wavPath}`);
}

console.log(`${got.length} samples at ${RATE} Hz (${(got.length / RATE).toFixed(2)} s) · ` +
  `peak ${peak} · rms ${rms.toFixed(0)}`);

// Three separate things have to hold, because each fails differently and silently.
const expectedLen = Math.floor(RATE / 60) * FRAMES;
const problems = [];
if (got.length !== expectedLen) {
  problems.push(`${got.length} samples mixed, expected ${expectedLen} ` +
    `(${FRAMES} calls x one frame of sound)`);
}
if (!peak) problems.push('every sample is silence: the program asked for a note and got nothing');
if (bad) problems.push(`${bad} of ${got.length} samples differ from the expected resampling, ` +
  `first at ${firstBad}: got ${got[firstBad]}, want ${want[firstBad]}`);

if (problems.length) {
  console.log('\n✗ ' + problems.join('\n✗ '));
  process.exit(1);
}
console.log('\nthe waveform MAME asked SEAL to play is the waveform that comes out of the mixer.');
