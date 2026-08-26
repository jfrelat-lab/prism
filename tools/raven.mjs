// raven.mjs — build Heretic or Hexen (Raven, 1994-95) from their unmodified DOS source.
//
// These are the opposite of Wolfenstein 3D, which is why they are here: Watcom 32-bit FLAT
// (DOS4GW), so `far` appears ten times in 47,000 lines and `_seg`, `MK_FP` and `huge` never. That
// is PRISM's own ABI, not a second one.
//
// The unit list comes from the game's OWN makefile rather than from a directory listing, and that is
// not tidiness: both trees carry dead files (`NETOLD.C`, `OLDD_NET.C`, `G_OLD.C`) that no build has
// compiled since 1995 and that do not compile at all. Reading the makefile is the difference between
// "the program does not build" and "a backup file does not build".
//
// Two build options in `CCOPTS` change the program and are honoured here:
//
//   /zp1   pack structures on byte boundaries -- EVERY struct in the program changes size, so
//          nothing read out of a WAD lands in the right field without it
//   /ei    enums are int
//
// Both are compiler options, not source edits -- the same standing as MAME's missing -DX86_ASM.
//
//   node tools/raven.mjs --game=heretic
//   node tools/raven.mjs --game=hexen --run --data=<dir with the WAD>

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram } from '../src/compile.js';
import { installStdio } from '../src/env/stdio.js';
import { installPorts } from '../src/env/ports.js';
import { installWatcom } from '../src/env/watcom.js';
import { HEADERS } from '../src/env/headers.js';
import { WATCOM_VARS } from '../src/env/headers-watcom.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const opt = (n, d = null) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;

const GAME = (opt('game') ?? 'heretic').toLowerCase();
const DIR = join(ROOT, 'corpus', GAME === 'hexen' ? 'Hexen' : 'Heretic');
if (!existsSync(join(DIR, 'MAKEFILE'))) {
  console.error(`corpus missing: ${DIR}\nFetch it with:\n` +
    `  git clone --depth 1 https://github.com/videogamepreservation/${GAME}.git corpus/${GAME === 'hexen' ? 'Hexen' : 'Heretic'}`);
  process.exit(2);
}

/**
 * The object list, straight out of the makefile. `.obj` entries with no `.C` are assembly.
 *
 * Read from the WHOLE file, not just the LOCOBJS/GLOBOBJS variables: Heretic's link rule is
 *
 *     tic.exe : $(LOCOBJS) $(GLOBOBJS) i_ibm.obj
 *
 * so the one file that holds every machine dependency -- and `main` -- is named nowhere else. The
 * `.c.obj :` and `.asm.obj :` suffix rules are skipped; they are patterns, not objects.
 */
function unitsFromMakefile() {
  const mk = readFileSync(join(DIR, 'MAKEFILE'), 'latin1');
  const lines = mk.split('\n').filter(l => !/^\.[A-Za-z]+\.[A-Za-z]+\s*:/.test(l));
  const objs = [...new Set(lines.join('\n').match(/[a-z0-9_]+\.obj/gi) ?? [])];
  const files = readdirSync(DIR);
  const out = [], asm = [];
  for (const o of objs) {
    const stem = o.replace(/\.obj$/i, '');
    const hit = files.find(f => f.toLowerCase() === `${stem}.c`);
    if (hit) out.push(hit);
    else asm.push(stem);
  }
  return { out, asm };
}

const { out: unitNames, asm } = unitsFromMakefile();
console.log(`${GAME} — ${unitNames.length} translation units from MAKEFILE` +
  (asm.length ? `, ${asm.length} assembly objects skipped: ${asm.join(' ')}` : ''));

const missing = new Set();
function resolver(name) {
  // The tree mixes cases in its #includes (`DoomDef.h` for `DOOMDEF.H`), which a case-sensitive
  // filesystem will not forgive and DOS never had to.
  const hit = readdirSync(DIR).find(f => f.toLowerCase() === basename(name).toLowerCase());
  if (hit && statSync(join(DIR, hit)).isFile()) {
    return { path: join(DIR, hit), text: readFileSync(join(DIR, hit), 'latin1') };
  }
  const std = HEADERS[name] ?? HEADERS[basename(name)];
  if (std !== undefined) return { path: `<${name}>`, text: std };
  missing.add(name);
  return { path: `<missing:${name}>`, text: '' };
}

const units = unitNames.map(f => ({ file: join(DIR, f), source: readFileSync(join(DIR, f), 'latin1') }));
units.push({ file: 'prism-watcom-vars.c', source: WATCOM_VARS });
console.log(`${units.reduce((n, u) => n + u.source.split('\n').length, 0).toLocaleString('en')} lines`);

let program;
const t0 = performance.now();
try {
  program = compileProgram(units, {
    // __WATCOMC__ selects the DOS paths; __386__ the flat model. /zp1 and /ei are the makefile's.
    defines: { __WATCOMC__: '1100', __386__: '1' },
    resolve: resolver,
    memory: 96 * 1024 * 1024,
    pack: 1,                       // CCOPTS /zp1
    collect: true,
  });
} catch (e) {
  if (missing.size) console.log(`headers stubbed: ${[...missing].join(' ')}`);
  console.log(`\n✗ build failed: ${String(e.message).split('\n').slice(0, 4).join('\n  ')}`);
  process.exit(1);
}
if (missing.size) console.log(`headers stubbed (empty): ${[...missing].join(' ')}`);
console.log(`✓ compiled in ${(performance.now() - t0).toFixed(0)} ms: ` +
  `${Object.keys(program.F).length} functions, ${(program.src.length / 1048576).toFixed(2)} MB`);

if (program.failures.length) {
  const causes = new Map();
  for (const f of program.failures) {
    const k = f.message.split('\n')[0].slice(0, 90);
    causes.set(k, (causes.get(k) ?? 0) + 1);
  }
  console.log(`${program.failures.length} functions could not be emitted:`);
  for (const [k, n] of [...causes].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${n}x ${k}`);
}

const fnArg = opt('fn');
if (fnArg) {
  const i = program.src.indexOf(`function ${fnArg}(`);
  console.log(i < 0 ? `${fnArg}: not emitted` : program.src.slice(i, program.src.indexOf('\nfunction ', i + 10)));
}

if (process.argv.includes('--run')) {
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
  installStdio(program.M, { files });
  installPorts(program.M);
  const host = installWatcom(program.M);

  // Live output: the start-up banner is the only progress report there is before a frame exists.
  const write = program.M.write.bind(program.M);
  program.M.write = (str) => { process.stdout.write(str); write(str); };

  const extra = (opt('args') ?? '').split(/\s+/).filter(Boolean);
  try {
    const r = program.run([GAME, ...extra]);
    console.log(`\nexit ${r.code}`);
  } catch (e) {
    console.log(`\n✗ ran and threw: ${e.message}`);
    console.log((e.stack || '').split('\n').slice(1, 14).join('\n'));
  }
  const s = host.state;
  console.log(`video mode ${s.mode === null ? '(none set)' : '0x' + s.mode.toString(16)} · ` +
    `${s.width}x${s.height} · vectors installed: ${[...s.vectors.keys()].map(k => '0x' + k.toString(16)).join(' ') || 'none'}`);
  const px = program.M.u8.subarray(s.pixels, s.pixels + s.width * s.height);
  let nz = 0;
  for (const b of px) if (b) nz++;
  console.log(`framebuffer at 0x${s.pixels.toString(16)}: ${nz} non-zero pixels of ${px.length}`);
}
