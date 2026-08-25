// doom.mjs — build DOOM (id Software, 1993) from `linuxdoom-1.10`, unmodified.
//
// The one thing to know before reading further: **the DOS Doom source was never released.** The only
// original source id published is this Linux/X11 tree, so compiling Doom unmodified means being a
// UNIX host, not a DOS one. That was established when the corpus was first surveyed and it decides
// everything here — including that this is the target which justifies the POSIX host at all.
//
// Doom also ships no null drivers, unlike Quake. Its i_video.c talks to X11, its i_sound.c to
// /dev/dsp through a separate server process, and its i_net.c to UDP sockets. So the honest approach
// is the same as everywhere else: compile all of it, and let the linker rank what is missing.
//
//   node tools/doom.mjs                     # report what the build is missing, ranked
//   node tools/doom.mjs --run --data=<dir>  # run it against a WAD you supply

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, installStdio } from '../src/compile.js';
import { installX11 } from '../src/env/x11.js';
import { writeIndexedPng } from './png.mjs';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus', 'DOOM', 'linuxdoom-1.10');

if (!existsSync(SRC)) {
  console.error(`corpus missing: ${SRC}\nFetch it with:\n` +
    `  git clone --depth 1 https://github.com/id-Software/DOOM.git corpus/DOOM`);
  process.exit(2);
}

// Everything in the tree. Doom's makefile lists these explicitly; taking the directory is the same
// set and cannot drift out of date.
const UNITS = readdirSync(SRC).filter(f => f.endsWith('.c')).sort();

const missing = new Set();
function resolve(name, angled, fromFile) {
  const local = join(SRC, basename(name));
  if (existsSync(local) && statSync(local).isFile()) {
    return { path: local, text: readFileSync(local, 'latin1') };
  }
  const std = HEADERS[name] ?? HEADERS[basename(name)];
  if (std !== undefined) return { path: `<${name}>`, text: std };
  missing.add(name);
  return { path: `<missing:${name}>`, text: '' };
}

const units = UNITS.map(f => ({ file: join(SRC, f), source: readFileSync(join(SRC, f), 'latin1') }));
const loc = units.reduce((n, u) => n + u.source.split('\n').length, 0);
console.log(`DOOM (linuxdoom-1.10) — ${units.length} translation units, ${loc.toLocaleString('en')} lines`);

const t0 = performance.now();
let program;
try {
  program = compileProgram(units, {
    defines: { __PRISM__: '1', NORMALUNIX: '1', LINUX: '1' },
    resolve,
    memory: 128 * 1024 * 1024,
    collect: true,
  });
} catch (e) {
  if (missing.size) console.log(`headers stubbed (empty): ${[...missing].join(' ')}`);
  console.log(`\n✗ build failed after ${(performance.now() - t0).toFixed(0)} ms:`);
  console.log(`  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`);
  process.exit(1);
}
const compileMs = performance.now() - t0;

if (missing.size) console.log(`headers stubbed (empty): ${[...missing].join(' ')}`);

if (program.failures.length) {
  const buckets = new Map();
  for (const f of program.failures) {
    const key = f.message.replace(/^.*?:\d+: /, '').slice(0, 76);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(`${f.unit}:${f.fn}`);
  }
  const ranked = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`\n${program.failures.length} of ${Object.keys(program.F).length} functions could not ` +
    `be emitted, ${ranked.length} distinct causes:\n`);
  for (const [msg, where] of ranked.slice(0, 20)) {
    console.log(`  ${String(where.length).padStart(4)}  ${msg}`);
    console.log(`        ${where.slice(0, 4).join(' ')}`);
  }
}

console.log(`\n✓ compiled in ${(compileMs / 1000).toFixed(1)} s: ${Object.keys(program.F).length} ` +
  `functions, ${(program.src.length / 1048576).toFixed(2)} MB of emitted JavaScript`);

// Shared with reportFrame below, which runs after the guest has stopped one way or another.
let x11 = null;
let frames = 0;

// --sym=<substring>: print matching symbols and their first words. Reading the linked image is how a
// "null function pointer" question gets settled — an empty table and a bad index look identical from
// the stack trace.
const fnArg = process.argv.find(a => a.startsWith('--fn='))?.slice(5);
if (fnArg) {
  const i = program.src.indexOf(`function ${fnArg}(`);
  console.log(i < 0 ? `${fnArg}: not found` : program.src.slice(i, program.src.indexOf('\nfunction ', i + 10)));
}

const symArg = process.argv.find(a => a.startsWith('--sym='))?.slice(6);
if (symArg) {
  for (const [name, sym] of program.mod.symbols) {
    if (!name.includes(symArg)) continue;
    const words = [];
    for (let i = 0; i < Math.min(8, Math.ceil((sym.size ?? 4) / 4)); i++) {
      words.push('0x' + (program.mod.dv.getInt32(sym.addr + i * 4, true) >>> 0).toString(16));
    }
    console.log(`  ${name}  @0x${sym.addr.toString(16)} size ${sym.size}: ${words.join(' ')}`);
  }
}

if (process.argv.includes('--run')) {
  // The WAD comes from a directory the user names. DOOM1.WAD is the freely redistributable shareware
  // one; nothing is fetched here.
  const dataArg = process.argv.find(a => a.startsWith('--data='))?.slice(7);
  const files = {};
  if (dataArg) {
    for (const f of readdirSync(dataArg)) {
      const full = join(dataArg, f);
      if (statSync(full).isFile()) files[f] = new Uint8Array(readFileSync(full));
    }
    console.log(`data from ${dataArg}: ${Object.keys(files).length} files`);
  }
  installStdio(program.M, { files });
  // Live output. Doom prints each init step, and a buffered stdout that only appears at exit tells
  // you nothing about where a hang is.
  const write = program.M.write.bind(program.M);
  program.M.write = (str) => { process.stdout.write(str); write(str); };
  x11 = installX11(program.M);

  /*
   * --frames=N: Doom's main loop never returns, so the harness stops it. I_FinishUpdate calls
   * XPutImage once per frame, which makes it the honest frame boundary — the same place a real X
   * client presents.
   */
  /*
   * --profile: which runtime service is a hung program calling? A program stuck in its own pure C is
   * invisible, but one waiting on the host shows up here immediately.
   */
  if (process.argv.includes('--profile')) {
    const counts = new Map();
    for (const name of Object.keys(program.M.rt)) {
      const inner = program.M.rt[name];
      if (typeof inner !== 'function') continue;
      program.M.rt[name] = function (...args) {
        counts.set(name, (counts.get(name) || 0) + 1);
        return inner.apply(this, args);
      };
    }
    // Reported from INSIDE the wrapper, on a call count. A timer cannot fire while the guest's own
    // synchronous loop owns the thread, which is exactly the situation being diagnosed.
    let total = 0;
    const LIMIT = 2_000_000;
    for (const name of Object.keys(program.M.rt)) {
      const inner = program.M.rt[name];
      if (typeof inner !== 'function') continue;
      program.M.rt[name] = function (...args) {
        if (++total > LIMIT) {
          const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12);
          console.log(`\n[profile] after ${LIMIT.toLocaleString('en')} runtime calls:`);
          for (const [n, c] of top) console.log(`  ${String(c).padStart(10)}  ${n}`);
          process.exit(0);
        }
        return inner.apply(this, args);
      };
    }
  }

  const frameCap = +(process.argv.find(a => a.startsWith('--frames='))?.slice(9) ?? 60);
  frames = 0;
  // --png=<prefix> --at=1,50,200: dump specific frames. Looking at the pixels is the only way to tell
  // "renders nothing" from "renders the wrong thing", and the two look identical from a counter.
  const pngPrefix = process.argv.find(a => a.startsWith('--png='))?.slice(6);
  const at = new Set((process.argv.find(a => a.startsWith('--at='))?.slice(5) ?? '')
    .split(',').filter(Boolean).map(Number));

  const putImage = program.M.rt.XPutImage;
  program.M.rt.XPutImage = (...args) => {
    const r = putImage(...args);
    frames++;
    if (pngPrefix && at.has(frames)) {
      const x = program.M.x11;
      writeIndexedPng(`${pngPrefix}-${String(frames).padStart(4, '0')}.png`, {
        pixels: program.M.u8.subarray(x.imageData, x.imageData + x.width * x.height),
        width: x.width, height: x.height, palette: x.palette,
      });
    }
    if (frames >= frameCap) throw new Error('__frames_done');
    return r;
  };
  try {
    // --args="-warp 1 1 -skill 3" reaches Doom as argv, which is how a game is started without
    // waiting for an attract loop.
    const extra = (process.argv.find(a => a.startsWith('--args='))?.slice(7) ?? '')
      .split(/\s+/).filter(Boolean);
    const r = program.run(['doom', ...extra]);
    console.log(`\n${r.stdout}`);
    console.log(`exit ${r.code}`);
    reportFrame();
  } catch (e) {
    if (e.message === '__frames_done') {
      console.log(`\n${program.M.output()}`);
      reportFrame();
      process.exit(0);
    }
    // Whatever it printed BEFORE it threw is usually the real message.
    console.log(`\n${program.M.output()}`);
    console.log(`\n✗ ran and threw: ${e.message}`);
    console.log((e.stack || '').split('\n').slice(1, 16).join('\n'));
  }
}

function reportFrame() {
  const x = x11 ?? program.M.x11;
  if (!x || !x.imageData) { console.log('\nno frame was ever presented'); return; }
  const px = program.M.u8.subarray(x.imageData, x.imageData + x.width * x.height);
  let nz = 0;
  for (const b of px) if (b) nz++;
  const pens = new Set(px).size;
  console.log(`\nframes ${frames} · display ${x.width}x${x.height} · ` +
    `${nz} non-zero pixels of ${px.length} · ${pens} distinct colours`);
}
