// sndserv.mjs — run Doom's sound server, the program that actually makes Doom's noise.
//
// This exists because of a discovery, not a plan. `linuxdoom-1.10/doomdef.h` line 84 says
//
//     #define SNDSERV  1
//
// so the Doom that id published does NOT play sound itself. It starts a separate program with
// `popen("./sndserver ", "w")` and writes it one ASCII line per sound effect:
//
//     fprintf(sndserver, "p%2.2x%2.2x%2.2x%2.2x\n", id, pitch, vol, sep);
//
// That other program is `corpus/DOOM/sndserv/`, and IT is the thing that opens /dev/dsp, reads the
// WAD, mixes eight channels and writes 16-bit stereo. It is 2,026 lines of C that PRISM had never
// compiled, and it is the real consumer of src/env/dsp.js.
//
// Connecting the two for real needs a process model PRISM does not have -- two address spaces and a
// scheduler, see docs/ROADMAP.md. What this tool does instead is run the server ALONE, feeding it on
// stdin the exact bytes Doom would have sent, which is enough to answer the question that matters:
// does Doom's own mixer, compiled by PRISM, produce Doom's own sounds?
//
//   node tools/sndserv.mjs --data=<dir with DOOM1.WAD> --wav=/tmp/sfx.wav
//   node tools/sndserv.mjs --data=<dir> --play=1a,20,7f,80 --submits=40
//
// The default command plays sound 26 (the shotgun) at full volume, centred.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram } from '../src/compile.js';
import { installStdio } from '../src/env/stdio.js';
import { installDsp } from '../src/env/dsp.js';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus', 'DOOM', 'sndserv');
if (!existsSync(SRC)) {
  console.error(`corpus missing: ${SRC}`);
  process.exit(2);
}

const opt = (n, d = null) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;

const UNITS = ['soundsrv.c', 'linux.c', 'wadread.c', 'sounds.c'].filter(f => existsSync(join(SRC, f)));

function resolver(name, angled, fromFile) {
  if (!angled && fromFile) {
    const local = join(dirname(fromFile), basename(name));
    if (existsSync(local) && statSync(local).isFile()) {
      return { path: local, text: readFileSync(local, 'latin1') };
    }
  }
  const local = join(SRC, basename(name));
  if (existsSync(local) && statSync(local).isFile()) {
    return { path: local, text: readFileSync(local, 'latin1') };
  }
  const std = HEADERS[name] ?? HEADERS[basename(name)];
  return std === undefined ? { path: `<missing:${name}>`, text: '' } : { path: `<${name}>`, text: std };
}

const units = UNITS.map(f => ({ file: join(SRC, f), source: readFileSync(join(SRC, f), 'latin1') }));
console.log(`Doom sound server — ${units.length} translation units, ` +
  `${units.reduce((n, u) => n + u.source.split('\n').length, 0)} lines`);

const program = compileProgram(units, { resolve: resolver, memory: 64 * 1024 * 1024, collect: true });
if (program.failures.length) {
  const causes = new Map();
  for (const f of program.failures) causes.set(f.message.slice(0, 90), (causes.get(f.message.slice(0, 90)) ?? 0) + 1);
  console.log(`${program.failures.length} functions could not be emitted:`);
  for (const [k, n] of causes) console.log(`  ${n}x ${k}`);
}
console.log(`✓ compiled: ${Object.keys(program.F).length} functions, ` +
  `${(program.src.length / 1024 / 1024).toFixed(2)} MB of emitted JavaScript`);

// The WAD comes from a directory the user names. Nothing is fetched here.
const dataArg = opt('data');
const files = {};
if (dataArg) {
  for (const f of readdirSync(dataArg)) {
    const full = join(dataArg, f);
    if (statSync(full).isFile()) files[f] = new Uint8Array(readFileSync(full));
  }
  console.log(`data from ${dataArg}: ${Object.keys(files).length} files`);
}

/*
 * stdin IS the pipe Doom writes to. The bytes below are the exact format i_sound.c's I_StartSound
 * emits -- 'p' then four two-digit hex fields -- so what the server reads here is what it would read
 * from a running Doom, byte for byte.
 */
const play = (opt('play') ?? '1a,20,7f,80').split(',');
const commands = `p${play.map(x => x.padStart(2, '0')).join('')}\n`;
let at = 0;
installStdio(program.M, {
  files,
  readChar: () => (at < commands.length ? commands.charCodeAt(at++) : -1),
  stdinPending: () => at < commands.length,
});

const dsp = installDsp(program.M);
dsp.wav = [];

/*
 * The server's main loop never returns; it is a `while (!done)` around select and a mix. Stopping it
 * after a fixed number of buffers is the same frame cap every other harness here uses -- and here it
 * is counted in the thing the program actually produces, buffers handed to the sound device.
 */
const SUBMITS = +(opt('submits') ?? 60);
const innerWrite = program.M.rt.write;
let submits = 0;
program.M.rt.write = (fd, src, n) => {
  const r = innerWrite(fd, src, n);
  if (program.M.dsp.open && (fd | 0) === (program.M.rt.__dspFd ?? fd | 0)) { /* counted below */ }
  return r;
};
// Count on the ring instead of guessing at the descriptor: every accepted buffer advances it.
let lastWritten = 0;
const tick = () => {
  if (dsp.written !== lastWritten) { lastWritten = dsp.written; submits++; }
  if (submits >= SUBMITS) throw new Error('__submits_done');
};
const wrapped = program.M.rt.write;
program.M.rt.write = (fd, src, n) => { const r = wrapped(fd, src, n); tick(); return r; };

// stderr carries the server's progress; let it through so a failure to find the WAD is visible.
const write = program.M.write.bind(program.M);
program.M.write = (str) => { process.stdout.write(str); write(str); };

try {
  program.run(['sndserver', '-quiet']);
} catch (e) {
  if (e.message !== '__submits_done') {
    console.log(`\n✗ ran and threw: ${e.message}`);
    console.log((e.stack || '').split('\n').slice(1, 12).join('\n'));
  }
}

const n = dsp.wav.length;
let peak = 0, energy = 0;
for (const v of dsp.wav) { const a = Math.abs(v); if (a > peak) peak = a; energy += v * v; }
const frames = n / dsp.channels;
console.log(`\naudio: ${frames} frames at ${dsp.rate} Hz x${dsp.channels} ` +
  `(${(frames / dsp.rate).toFixed(2)} s) · peak ${peak} · ` +
  `rms ${(n ? Math.sqrt(energy / n) : 0).toFixed(0)}`);

const wavPath = opt('wav');
if (wavPath && n) {
  const ch = dsp.channels;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(dsp.rate, 24);
  buf.writeUInt32LE(dsp.rate * 2 * ch, 28); buf.writeUInt16LE(2 * ch, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(dsp.wav[i], 44 + i * 2);
  writeFileSync(wavPath, buf);
  console.log(`wrote ${wavPath}`);
}

if (!peak) {
  console.log('\n✗ every sample is silence: the server produced no sound');
  process.exit(1);
}
console.log("\nDoom's own sound server, compiled unmodified, mixed Doom's own sound effect.");
