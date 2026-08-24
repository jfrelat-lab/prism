// quake.mjs — build Quake (id Software, 1996) from its unmodified source.
//
// 15× the size of MAME 0.1 and a completely different shape: float-heavy maths, span rasterisation,
// setjmp/longjmp, a bytecode VM (QuakeC), and 70-odd translation units. MAME exercised none of that.
//
// Two build switches, both Quake's own, neither a source edit:
//
//   * `id386 = 0` — selected by NOT defining __i386__, exactly as Quake does on SPARC. It takes the
//     portable C paths instead of the 19 hand-written .s files the makefile lists. The plan chose
//     this configuration for the first pass.
//   * Quake's OWN null drivers (sys_null.c, vid_null.c, snd_null.c, cd_null.c, net_none.c,
//     in_null.c) in place of the platform ones — the same boundary MAME's osdepend.h gave us, and
//     shipped in the tree for precisely this purpose.
//
//   node tools/quake.mjs              # report what the build is missing
//   node tools/quake.mjs --run        # run it

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, installStdio } from '../src/compile.js';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus', 'Quake', 'WinQuake');

if (!existsSync(SRC)) {
  console.error(`corpus missing: ${SRC}\nFetch it with:\n` +
    `  git clone --depth 1 https://github.com/id-Software/Quake.git corpus/Quake`);
  process.exit(2);
}

// The engine, from the makefile's own object list minus the .s files (id386 = 0) …
const ENGINE = [
  'cl_demo.c', 'cl_input.c', 'cl_main.c', 'cl_parse.c', 'cl_tent.c', 'chase.c', 'cmd.c',
  'common.c', 'console.c', 'crc.c', 'cvar.c', 'draw.c',
  'd_edge.c', 'd_fill.c', 'd_init.c', 'd_modech.c', 'd_part.c', 'd_polyse.c', 'd_scan.c',
  'd_sky.c', 'd_sprite.c', 'd_surf.c', 'd_vars.c', 'd_zpoint.c',
  'host.c', 'host_cmd.c', 'keys.c', 'menu.c', 'mathlib.c', 'model.c',
  'net_dgrm.c', 'net_loop.c', 'net_main.c', 'net_vcr.c',
  'nonintel.c', 'pr_cmds.c', 'pr_edict.c', 'pr_exec.c',
  'r_aclip.c', 'r_alias.c', 'r_bsp.c', 'r_light.c', 'r_draw.c', 'r_efrag.c', 'r_edge.c',
  'r_misc.c', 'r_main.c', 'r_sky.c', 'r_sprite.c', 'r_surf.c', 'r_part.c', 'r_vars.c',
  'screen.c', 'sbar.c', 'sv_main.c', 'sv_phys.c', 'sv_move.c', 'sv_user.c',
  'view.c', 'wad.c', 'world.c', 'zone.c',
];

// … and Quake's own null platform drivers instead of the Linux/SVGAlib ones.
const PLATFORM = ['sys_null.c', 'vid_null.c', 'snd_null.c', 'cd_null.c', 'net_none.c', 'in_null.c'];

const UNITS = [...ENGINE, ...PLATFORM];

const missingHeaders = new Set();
function resolver(name, angled, fromFile) {
  const local = join(SRC, basename(name));
  if (existsSync(local) && statSync(local).isFile()) {
    return { path: local, text: readFileSync(local, 'latin1') };
  }
  const std = HEADERS[basename(name)];
  if (std !== undefined) return { path: `<${name}>`, text: std };
  // Diagnostic: stub and record, so one run reports every absent header instead of dying on the
  // first. Printed, never silent.
  missingHeaders.add(name);
  return { path: `<missing:${name}>`, text: '' };
}

/*
 * The DATA half of the platform layer, the same role MAME's OSD_VARS plays.
 *
 * `isDedicated` is declared in quakedef.h and defined by each platform's sys_*.c — sys_dos.c,
 * sys_win.c, sys_linux.c all define it. sys_null.c, the one Quake ships for exactly this purpose,
 * does not. So it falls to whoever supplies the platform, which here is us.
 */
const PLATFORM_VARS = 'int isDedicated;\n';

const units = [];
for (const f of UNITS) {
  const full = join(SRC, f);
  if (!existsSync(full)) { console.error(`missing unit ${f}`); process.exit(2); }
  units.push({ file: full, source: readFileSync(full, 'latin1') });
}

units.push({ file: 'prism-platform-vars.c', source: PLATFORM_VARS });

const loc = units.reduce((n, u) => n + u.source.split('\n').length, 0);
console.log(`Quake (WinQuake, id386=0) — ${units.length} translation units, ${loc.toLocaleString('en')} lines`);

let program;
const t0 = performance.now();
try {
  program = compileProgram(units, {
    /*
     * __i386__ is UNDEFINED for this build, which is what selects `id386 = 0` and the portable C
     * equivalent of all 21 hand-written .s files — exactly the configuration Quake compiles in on a
     * SPARC. It is a build switch, not a source edit.
     *
     * `null` means undefine, and it has to: PRISM's target defines set __i386__ because the target
     * really is i386, and Quake's test is `#if defined __i386__`, which no value can answer. Until
     * this existed the whole build was silently in the id386=1 configuration — compiling code that
     * expects assembly routines nothing was providing, and skipping the C globals in r_vars.c
     * because its entire body sits inside `#if !id386`.
     */
    defines: { __PRISM__: '1', __i386__: null, i386: null },
    resolve: resolver,
    memory: 512 * 1024 * 1024,
    collect: true,
  });
} catch (e) {
  if (missingHeaders.size) console.log(`\nheaders stubbed: ${[...missingHeaders].join(' ')}`);
  console.log(`\n✗ build failed after ${(performance.now() - t0).toFixed(0)} ms:`);
  console.log(`  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`);
  process.exit(1);
}
const compileMs = performance.now() - t0;

if (missingHeaders.size) console.log(`headers stubbed (empty): ${[...missingHeaders].join(' ')}`);
// Rank what could not be emitted, so the next move is chosen by frequency rather than by whichever
// error happened to come first.
if (program.failures.length) {
  const buckets = new Map();
  for (const f of program.failures) {
    const key = f.message
      .replace(/^.*?:\d+: /, '')
      .replace(/'[^']*'/g, (m) => m)
      .slice(0, 72);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(`${f.unit}:${f.fn}`);
  }
  const ranked = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`\n${program.failures.length} functions could not be emitted, ` +
    `${ranked.length} distinct causes:\n`);
  for (const [msg, where] of ranked.slice(0, 22)) {
    console.log(`  ${String(where.length).padStart(4)}  ${msg}`);
    console.log(`        e.g. ${where.slice(0, 3).join(' ')}`);
  }
}

console.log(`✓ compiled in ${compileMs.toFixed(0)} ms: ${Object.keys(program.F).length} functions, ` +
  `${(program.src.length / 1024 / 1024).toFixed(2)} MB of emitted JavaScript`);

/*
 * --data=<dir>: where Quake's own data lives, read from a directory the user names. Never fetched.
 * Quake looks for id1/pak0.pak relative to its base directory, so the tree is mirrored as-is.
 */
const dataArg = process.argv.find(a => a.startsWith('--data='))?.slice(7);
const files = {};
if (dataArg) {
  const walk = (d, prefix = '') => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${e}/`);
      else files[`${prefix}${e}`] = new Uint8Array(readFileSync(full));
    }
  };
  walk(dataArg);
  console.log(`data from ${dataArg}: ${Object.keys(files).length} files ` +
    `(${(Object.values(files).reduce((n, b) => n + b.length, 0) / 1048576).toFixed(1)} MB)`);
}

if (process.argv.includes('--run')) {
  installStdio(program.M, { files });
  try {
    const r = program.run(['quake', '-nosound']);
    console.log(`\nexit ${r.code}`);
    console.log(r.stdout.slice(0, 4000));
  } catch (e) {
    console.log(`\n✗ ran and threw: ${e.message}`);
  }
}
