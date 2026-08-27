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
import { installPorts } from '../src/env/ports.js';
import { installCrtStatus } from '../src/env/crtstatus.js';
import { installVgaDac } from '../src/env/vgadac.js';
import { installKbd8042 } from '../src/env/kbd8042.js';
import { installGo32 } from '../src/env/go32.js';
import { writeIndexedPng } from './png.mjs';

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
/*
 * Two platform configurations, both id's own.
 *
 * `*_null.c` is the porting stub set Quake ships for exactly this situation: no real input, sound or
 * timing. `--dos` selects the units the game actually shipped with. It is not a one-for-one swap:
 * `snd_null.c` also DEFINES the sound cvars and `shm`, which the engine and the menu reference, so
 * dropping it means picking up Quake's real sound core as well as its DOS driver. The null build was
 * missing a third of the program, not just its output stage.
 */
const PLATFORM_NULL = ['sys_null.c', 'vid_null.c', 'snd_null.c', 'cd_null.c', 'net_none.c', 'in_null.c'];
const PLATFORM_DOS = ['sys_dos.c', 'vid_dos.c', 'vid_vga.c', 'vid_ext.c', 'vregset.c',
  'snd_dos.c', 'snd_dma.c', 'snd_mem.c', 'snd_mix.c',
  'cd_audio.c', 'net_none.c', 'in_dos.c', 'dos_v2.c'];
const DOS = process.argv.includes('--dos');
const PLATFORM = DOS ? PLATFORM_DOS : PLATFORM_NULL;

const UNITS = [...ENGINE, ...PLATFORM];

const missingHeaders = new Set();
function resolver(name, angled, fromFile) {
  const local = join(SRC, basename(name));
  if (existsSync(local) && statSync(local).isFile()) {
    return { path: local, text: readFileSync(local, 'latin1') };
  }
  // The FULL name first: `sys/types.h` is its own key, and reducing to a basename looks up
  // `types.h`, misses, and stubs a header that is right there.
  const std = HEADERS[name] ?? HEADERS[basename(name)];
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
/*
 * What the linker and the assembler provide in a real DJGPP build. A real .c file rather than a
 * string in this tool -- it is C, so it belongs in a C file, and tools/quake-dos-vars.c says why
 * each routine can be what it is.
 */
if (DOS) {
  const p = join(ROOT, 'tools/quake-dos-vars.c');
  units.push({ file: p, source: readFileSync(p, 'latin1') });
}

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
    console.log(`        ${where.join(' ')}`);
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

if (process.argv.includes('--symbols')) {
  for (const n of ['vid_buffer', 'host_basepal', 'host_framecount', 'realtime', 'cls', 'key_dest']) {
    const sym = program.mod.symbols.get(n);
    console.log(`  ${n.padEnd(16)} ${sym ? '0x' + sym.addr.toString(16) + '  ' + sym.size + ' bytes' : '(absent)'}`);
  }
}

/*
 * --bench: wall-clock seconds to play demo1, bounded by the markers Quake prints ITSELF
 * ("Playing demo from demoN.dem"). The same two markers bound the native build, so both sides are
 * timed on identical work with no frame hook and no source change.
 *
 * A frame counter cannot be used for this: sys_null.c's Sys_FloatTime returns t += 0.1 rather than
 * reading a clock, so Quake's own timing — and anything derived from it, timedemo included — is
 * fiction in this configuration. Only wall clock outside the program means anything.
 */
if (process.argv.includes('--bench')) {
  installStdio(program.M, { files });
  const M = program.M;
  let t0 = 0, seen = 0;
  const write = M.write;
  M.write = (str) => {
    write(str);
    if (/Playing demo from demo1\.dem/.test(str)) t0 = performance.now();
    else if (t0 && /Playing demo from demo2\.dem/.test(str)) {
      const secs = (performance.now() - t0) / 1000;
      const frames = new DataView(program.mod.buffer).getInt32(program.mod.symbols.get('host_framecount').addr, true);
      console.log(`\ndemo1: ${secs.toFixed(2)} s wall clock, ${frames} frames total, ` +
        `${(frames / secs).toFixed(1)} fps while it played`);
      seen = 1;
      throw new Error('__bench_done');
    }
  };
  try { program.run(['quake']); } catch (e) { if (!seen) console.log(`bench stopped: ${e.message}`); }
  process.exit(0);
}

// --trace-exit: name the emitted function that called exit(). A program that stops without printing
// why leaves nothing else to go on, and the JS stack still carries the C function names.
if (process.argv.includes('--trace-exit')) {
  const real = program.M.rt.exit;
  program.M.rt.exit = (c) => {
    console.log(`\n>>> exit(${c}) called from:`);
    console.log(new Error().stack.split('\n').slice(2, 10).join('\n'));
    return real(c);
  };
}

if (process.argv.includes('--dump-main')) {
  const want = process.argv.find(a => a.startsWith('--fn='))?.slice(5) ?? 'main';
  const i = program.src.indexOf(`function ${want}(`);
  console.log(i < 0 ? `${want}: not found` : program.src.slice(i, program.src.indexOf('\nfunction ', i + 10)));
}

// --trace-sp: is the shadow stack drifting? main calls Host_Frame through the function table, so it
// can be wrapped, and M.sp at the top of each frame should be identical every time.
if (process.argv.includes('--trace-sp')) {
  const inner = program.F['Host_Frame'];
  let n = 0, first = null;
  program.F['Host_Frame'] = function (t) {
    const sp = program.M.sp;
    if (first === null) first = sp;
    if (n % 200 === 0 || sp !== first) {
      console.log(`[sp] frame ${n} sp=${sp} drift=${sp - first}`);
      if (sp !== first) { console.log('[sp] DRIFTED — stopping'); throw new Error('sp drift'); }
    }
    n++;
    return inner(t);
  };
  program.mod.bindFunc('Host_Frame', program.F['Host_Frame']);
}

/*
 * --audit-sp: which function fails to give the shadow stack back?
 *
 * The invariant is absolute — M.sp on return equals M.sp on entry, for every function, including one
 * that used alloca, because a frame's space dies with the frame. A violation is a leak, and 8 bytes
 * per Host_Frame is exactly what killed Quake at frame 1238: its own R_RenderView checks that the
 * stack has not drifted more than 10000 bytes.
 *
 * Only cross-unit calls go through the function table, so this sees most of Quake but not calls
 * within one file. It narrows the search to a unit, which is enough.
 */
if (process.argv.includes('--audit-sp')) {
  let reported = 0;
  for (const name of Object.keys(program.F)) {
    const inner = program.F[name];
    if (typeof inner !== 'function') continue;
    const wrapped = function (...args) {
      const before = program.M.sp;
      const r = inner.apply(this, args);
      const after = program.M.sp;
      if (after !== before && reported < 8) {
        reported++;
        console.log(`[sp] ${name} leaked ${before - after} bytes (in ${before}, out ${after})`);
      }
      return r;
    };
    program.F[name] = wrapped;
    program.mod.bindFunc(name, wrapped);
  }
}

const opt2 = (n) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;

if (process.argv.includes('--run')) {
  installStdio(program.M, { files });
  /*
   * The DOS host: the same three devices Heretic needed, plus DJGPP's DPMI floor. Quake's default
   * video mode programs NO VGA registers -- vgavidmodes[0] carries an empty register set -- so the
   * framebuffer is ordinary memory at 0xa0000 and nothing here emulates a CRTC.
   */
  let dosHost = null, dac = null;
  if (DOS) {
    const machine = installPorts(program.M);
    installCrtStatus(machine);                 // VGA_WaitVsync spins on bit 3 of 0x3DA
    dac = installVgaDac(machine);              // VGA_SetPalette writes 0x3C8/0x3C9
    program.M.kbd = installKbd8042(machine);   // in_dos.c's handler reads 0x60
    dosHost = installGo32(program.M);
    const write = program.M.write.bind(program.M);
    program.M.write = (str) => { process.stdout.write(str); write(str); };
  }
  /*
   * A frame cap, because Quake's main loop never returns. VID_Update is where a frame is presented,
   * which is also where the timer and keyboard interrupts are delivered -- a DOS program's
   * asynchronous events arrive while it is inside a loop of its own C, and this is the only moment
   * the host has.
   */
  let frames = 0;
  const FRAMES = +(opt2('frames') ?? 0);
  if (DOS && FRAMES) {
    const inner = program.F.VID_Update;
    const w = function (...a) {
      const r = inner.apply(this, a);
      dosHost.deliver(0x08);                        // the timer, if in_dos.c installed one
      if (++frames >= FRAMES) throw new Error('__frames_done');
      return r;
    };
    program.F.VID_Update = w; program.mod.bindFunc('VID_Update', w);
  }
  try {
    const extra = (opt2('args') ?? '').split(/\s+/).filter(Boolean);
    const r = program.run(['quake', '-nosound', ...extra]);
    console.log(`\nexit ${r.code}`);
    // The whole of it. Truncating at 4000 characters cut the line that said WHY the program stopped,
    // and made a self-inflicted mystery out of a printed error message.
    console.log(r.stdout);
  } catch (e) {
    if (e.message === '__frames_done') console.log(`\nstopped after ${frames} frames`);
    else {
      console.log(`\n✗ ran and threw: ${e.message}`);
      console.log((e.stack || '').split('\n').slice(1, 10).join('\n'));
    }
  }
  if (dosHost) {
    const st = dosHost.state;
    console.log(`video mode ${st.mode === null ? '(none set)' : '0x' + st.mode.toString(16)} · ` +
      `vectors ${[...st.vectors.keys()].map(v => '0x' + v.toString(16)).join(' ') || 'none'} · ` +
      `${st.locked} locked regions`);
    const px = program.M.u8.subarray(0xa0000, 0xa0000 + 320 * 200);
    let nz = 0;
    for (const b of px) if (b) nz++;
    console.log(`framebuffer at 0xa0000: ${nz} non-zero pixels of ${px.length}, ` +
      `${new Set(px).size} distinct colours`);
    const png = opt2('png');
    if (png) {
      writeIndexedPng(png, { pixels: px, width: 320, height: 200, palette: dac.palette });
      console.log(`wrote ${png}`);
    }
  }
}
