// build.mjs — build any target in targets/, from its JSON alone.
//
//   node tools/build.mjs targets/quake.json                       # compile only, report
//   node tools/build.mjs targets/quake.json:null                  # a named variant
//   node tools/build.mjs targets/heretic.json --run --data=<dir>
//   node tools/build.mjs targets/quake.json:x11 --run --data=<dir> --frames=200 --png=/tmp/q.png
//   node tools/build.mjs --list
//
// This replaces the BUILD half of quake.mjs, raven.mjs, mame.mjs and doomsnd.mjs: four hand-written
// copies of the same six decisions. What it does not replace is the other half of those tools --
// each program's own instrumentation. Quake's frame cap and key script, Doom's fire trigger, the
// audio drain: those wrap the program's functions to watch it run, and a JSON file describing them
// would be game logic in a config file.
//
// So the honest split is: every target COMPILES here, and a target with nothing program-specific to
// do also RUNS here. The rest keep their tool, which now calls buildTarget() instead of restating
// the build.

import { writeIndexedPng } from './png.mjs';
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGETS = join(ROOT, 'targets');
const argv = process.argv.slice(2);
const opt = (n, d = null) => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const flag = (n) => argv.includes(`--${n}`);

if (flag('list') || argv.length === 0) {
  console.log('targets:');
  for (const f of readdirSync(TARGETS).filter(f => f.endsWith('.json')).sort()) {
    const t = JSON.parse(readFileSync(join(TARGETS, f), 'utf8'));
    const vs = Object.keys(t.variants ?? {}).filter(k => !k.startsWith('_'));
    const have = existsSync(join(ROOT, t.dir)) ? '' : '  (source tree absent)';
    console.log(`  targets/${f.padEnd(16)} ${t.title ?? t.name}${vs.length ? `  [${vs.join(' ')}]` : ''}${have}`);
  }
  process.exit(0);
}

// `path.json:variant` -- one argument, because the variant is part of naming the target.
const [file, variant] = argv[0].split(':');
let target;
try {
  target = loadTarget(file.includes('/') ? join(ROOT, file) : join(TARGETS, file), variant ?? null);
  if (!variant && target.default) target = loadTarget(join(ROOT, file), target.default);
} catch (e) {
  console.error(String(e.message));
  process.exit(2);
}

if (!existsSync(join(ROOT, target.dir))) {
  console.error(`source tree absent: ${target.dir}`);
  if (target.fetch) console.error(`fetch it with:\n  ${target.fetch}`);
  process.exit(2);
}

/*
 * The data directory, read from a directory the USER names and nowhere else. No tool here fetches
 * game data, and none of it enters the repository.
 */
const files = {};
/*
 * --seconds=N: a wall-clock ceiling on the RUN, enforced from the clock hook below. Zero, the
 * default, means no ceiling. `runStarted` is set when the program is actually launched, so the
 * build itself is never on the clock.
 */
const leashMs = +(opt('seconds') ?? 0) * 1000;
let leashed = false;
const dataArg = opt('data');
if (dataArg) {
  const walk = (d, prefix = '') => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${e}/`);
      else files[`${prefix}${e}`] = new Uint8Array(readFileSync(full));
    }
  };
  walk(dataArg);
}
/* Files the INSTALLATION provides -- see targets/*.json's `files`. The player's data wins on a clash. */
for (const [name, text] of Object.entries(target.files ?? {})) {
  if (!(name in files)) files[name] = new TextEncoder().encode(`${text}\n`);
}

/*
 * --date=now: stamp the REAL build time into __DATE__ and __TIME__.
 *
 * They are frozen at "Jan  1 1996 00:00:00" by default (src/compile.js), and that is deliberate: a
 * compiler that stamps the wall clock makes every build different, and this project's test strategy
 * rests on the same input producing the same output -- gcc has -Wdate-time and SOURCE_DATE_EPOCH for
 * the same reason. But Quake PRINTS them in its banner (`host.c:871`, "Exe: ..."), so the frozen
 * value is visible on screen and reads as a bug rather than as a policy. This is the opt-out: the
 * default stays reproducible, and a real date is one flag away.
 *
 * SOURCE_DATE_EPOCH is honoured too, with the same meaning it has everywhere else.
 */
const dateArg = opt('date') ?? (process.env.SOURCE_DATE_EPOCH ? 'epoch' : null);
const dateDefines = {};
if (dateArg) {
  const when = dateArg === 'now' ? new Date()
    : new Date(1000 * Number(dateArg === 'epoch' ? process.env.SOURCE_DATE_EPOCH : dateArg));
  if (Number.isNaN(when.getTime())) { console.error(`--date: not a time: ${dateArg}`); process.exit(2); }
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // C's format exactly: "Mmm dd yyyy" with the day SPACE-padded, and "hh:mm:ss".
  const d = String(when.getDate()).padStart(2, ' ');
  const p2 = (n) => String(n).padStart(2, '0');
  dateDefines.__DATE__ = `"${M[when.getMonth()]} ${d} ${when.getFullYear()}"`;
  dateDefines.__TIME__ = `"${p2(when.getHours())}:${p2(when.getMinutes())}:${p2(when.getSeconds())}"`;
}

/* Applied to the TARGET, because buildTarget reads its defines from there. */
if (Object.keys(dateDefines).length) target.defines = { ...(target.defines ?? {}), ...dateDefines };

const t0 = performance.now();
let built;
try {
  built = buildTarget(target, {
    root: ROOT,
    /*
     * --seconds IMPLIES --safepoints, because otherwise the leash has nothing to hang from. The
     * deadline is enforced from the clock, from the port seam and from a safepoint; a loop that
     * touches neither a port nor the clock is caught only by the safepoint, and a safepoint that was
     * never emitted catches nothing. Asking for a time limit and silently not getting one is worse
     * than not offering it.
     */
    compile: {
      safepoints: flag('safepoints') || leashMs > 0,
      ...(opt('memory') ? { memory: +opt('memory') } : {}),
    },
    envExtra: {
      stdio: { files },
      // A real clock, because a program that times itself with a fake one measures fiction.
      pit: { micros: () => performance.now() * 1000 },
    },
  });
} catch (e) {
  console.error(`${target.name}: ${e.message}`);
  process.exit(1);
}
const { program, env, units, asm, missingHeaders, dosPaths, asmExports, asmWanted } = built;
const secs = ((performance.now() - t0) / 1000).toFixed(1);

const loc = units.reduce((n, u) => n + u.source.split('\n').length, 0);
console.log(`${target.title ?? target.name} — ${units.length} translation units, ` +
  `${loc.toLocaleString('en')} lines, ${Object.keys(program.F).length} functions in ${secs} s`);
if (asm?.length) console.log(`  ${asm.length} assembly objects skipped: ${asm.join(' ')}`);
if (missingHeaders.length) console.log(`  headers stubbed: ${missingHeaders.join(' ')}`);
/* A resolution that needed an extra rule is reported, never silent: these includes were written
   the DOS way and only resolved once a backslash was read as a path separator. */
if (dosPaths?.length) {
  console.log(`  ${dosPaths.length} include${dosPaths.length === 1 ? '' : 's'} resolved by reading ` +
    `a backslash as a path separator: ${dosPaths.join(' ')}`);
}
/*
 * A duplicate external definition is not a warning to skim past: every emitted function shares one
 * JavaScript scope, so the last one wins and calls emitted BEFORE it also go to it.
 */
if (program.duplicates?.length) {
  console.log(`  ${program.duplicates.length} duplicate external definitions -- the LAST one wins ` +
    `for the whole program:`);
  for (const d of program.duplicates) console.log(`    ${d.name}  (redefined in ${d.unit})`);
}
/*
 * Undefined symbols, which a linker names and this used to swallow. They compile; they fail when
 * called. Nearly always they are what an ASSEMBLY file was providing, so the list beside the skipped
 * .asm objects above is the whole answer to "what does this build still need?".
 */
/*
 * MINUS WHAT WAS BOUND AFTER COMPILATION. program.undefined is computed while emitting, and a
 * routine translated from the program's own assembly is bound later -- so the raw list called
 * get_block "never defined" while it was sitting in F, callable, two lines further down. A report
 * that says a defined thing is undefined is worse than no report.
 */
const asmNames = new Set((built.asmBound ?? []).map(b => b.name));
if (asmNames.size) {
  program.undefined = (program.undefined ?? []).filter(u => !asmNames.has(u.name.split('$').pop()));
  console.log(`  assembly translated and bound: ${[...asmNames].join(' ')} ` +
    `(checked against Unicorn — tools/gate-asm.mjs)`);
}
if (program.undefined?.length) {
  console.log(`  ${program.undefined.length} symbols declared and called but NEVER DEFINED ` +
    `(they fail when called):`);
  for (const u of program.undefined.slice(0, 20)) {
    console.log(`    ${u.name.padEnd(32)} called from ${u.units.join(' ')}`);
  }
  if (program.undefined.length > 20) console.log(`    … and ${program.undefined.length - 20} more`);
}
/*
 * VARIABLES declared and never defined, which is a different thing from a missing function and is
 * reported on its own line for that reason: a missing function throws when called, a missing
 * variable reads as zero and a program that never touches it never notices.
 *
 * Most of these are honest. With `id386=0` Quake stops referencing the globals its assembly renderer
 * shares -- `bottomclip`, `r_lightptr` -- but the headers still declare them, so they are declared,
 * unused, and undefined all at once. WinQuake's DirectX GUIDs are the same shape for a different
 * reason: DEFINE_GUID declares them and dxguid.lib holds the definitions.
 */
if (program.undefinedVars?.length) {
  console.log(`  ${program.undefinedVars.length} variables declared and never defined ` +
    `(they read as zero):`);
  for (const u of program.undefinedVars.slice(0, 12)) console.log(`    ${u.name}`);
  if (program.undefinedVars.length > 12) {
    console.log(`    … and ${program.undefinedVars.length - 12} more`);
  }
}
if (program.failures?.length) {
  /*
   * Grouped by cause, with ONE example site each. The count says how much a gap is worth closing;
   * the site says where to look, and without it a message like "'char[2]' has no member 'textbuf'"
   * -- which is a compiler bug, not a missing declaration -- means grepping a 156-unit build by hand.
   */
  const by = new Map();
  for (const f of program.failures) {
    const e = by.get(f.message) ?? { n: 0, where: `${f.unit}:${f.fn}` };
    e.n++;
    by.set(f.message, e);
  }
  console.log(`  ${program.failures.length} functions could not be emitted (they throw IF CALLED):`);
  for (const [m, e] of [...by].sort((a, b) => b[1].n - a[1].n).slice(0, +(opt('failures') ?? 12))) {
    console.log(`    ${String(e.n).padStart(4)}  ${m}`);
    console.log(`          e.g. ${e.where}`);
  }
}
/*
 * What compiling the assembly would actually buy HERE. The interesting number is not how many
 * symbols the .s files export -- most are covered by a C fallback the source itself ships, which is
 * the whole point of id386=0 and `#ifndef __WATCOMC__` -- but how many are still missing.
 */
if (asmExports?.length) {
  const total = asmExports.reduce((n, f) => n + f.names.length, 0);
  console.log(`  assembly: ${asmExports.length} files export ${total} symbols; ` +
    `${asmWanted.length} of them are still undefined here` +
    (asmWanted.length ? ':' : ' — an assembler would buy nothing for this target.'));
  for (const w of asmWanted.slice(0, 12)) console.log(`    ${w.name.padEnd(28)} ${w.file}`);
}
console.log(`  environment: ${Object.keys(env).filter(k => k !== 'machine').join(' ')}`);
console.log(`  data: ${Object.keys(files).length} files from ${dataArg ?? '(none given)'}`);

const dumpTo = opt('dump');
if (dumpTo) { writeFileSync(dumpTo, program.src); console.log(`  wrote ${dumpTo} (${(program.src.length / 1e6).toFixed(1)} MB of JavaScript)`); }

if (!flag('run')) process.exit(0);

/*
 * Running with no instrumentation at all: the program gets its argv and goes. A program that never
 * returns needs a tool that knows where to interrupt it -- which is exactly the program-specific
 * half that stays in tools/.
 */
/*
 * A TARGET'S OWN ARGUMENTS ARE PART OF THE TARGET, and this dropped them.
 *
 * Several variants declare args because the build does not work without them -- quake:sun needs
 * `-zone 512` (vid_sunx.c takes its framebuffer from the zone, whose default cannot hold a frame),
 * quake2:solaris needs `+set dedicated 1`, and quake2:win32 needs `+set vid_fullscreen 0` because
 * rw_imp.c takes DIB_Init when windowed and DDRAW_Init when not, and DirectDraw is refused here.
 * Reading only --args meant every one of those ran in a configuration its own JSON said it could
 * not: quake2:win32 died in "catastrophic mode change failure" for exactly this reason.
 *
 * An explicit --args still wins, because a person naming arguments means them.
 */
const args = (opt('args') ?? target.args ?? '').split(/\s+/).filter(Boolean);
console.log(`\nrunning: ${target.name} ${args.join(' ')}` +
  (leashMs ? ` · leash ${leashMs / 1000}s` : ''));
/*
 * Enforced from the runtime's clock, the port seam and a safepoint back edge -- see checkLeash.
 *
 * The BUDGET is armed with the deadline, and it has to be: spBudget starts at 1<<30, so the first
 * safepoint call is about a billion back edges away. A leashed run whose hang touches no port would
 * wait that long for its first check, which is not a time limit. Measured that way on a hang here:
 * 40 s, 0 safepoint calls.
 */
if (leashMs) {
  program.M.leashDeadline = performance.now() + leashMs;
  program.M.spBudget = 1 << 20;
}
/*
 * What the program SAYS. Its stdout goes into an in-memory buffer -- the page reads it there -- so a
 * console run showed nothing at all, which for a program whose whole output is text reads as a
 * program that did nothing.
 */
const write = program.M.write.bind(program.M);
program.M.write = (str) => { process.stdout.write(str); write(str); };

/*
 * --frames=N --png=<path>: stop after N frames and write the last one.
 *
 * An X11 client presents by calling XPutImage, so that call IS the frame boundary and this needs to
 * know nothing else about the program -- it works for Doom, for Quake's X11 client and for Quake II
 * alike. It lives here rather than in each game's own tool because there is nothing game-specific
 * left in it once the boundary is named.
 *
 * It earns its place by answering a question a log cannot: these main loops never return, so a run
 * with no cap hangs, and a run that is interrupted proves only that it was still going.
 */
/*
 * --wav=<path>: collect what the program played. Generic for the same reason --png is: the dsp
 * device already keeps every sample it accepted, whether the program wrote them or mixed them into
 * an mmapped buffer, so this only has to ask for them.
 */
const wavPath = opt('wav');
if (wavPath && program.M.dsp) program.M.dsp.wav = [];

const frameCap = +(opt('frames') ?? 0);
const pngPath = opt('png');
let frames = 0;
if ((frameCap || pngPath) && program.M.rt.XPutImage) {
  const inner = program.M.rt.XPutImage;
  program.M.rt.XPutImage = (...a) => {
    const r = inner(...a);
    if (frameCap && ++frames >= frameCap) throw new Error('__frames_done');
    return r;
  };
}
/*
 * ...and for a program presenting through SVGALIB, whose boundary is its own VID_Update: the driver
 * writes straight into the framebuffer it was handed, so there is no library call to hook and the
 * game's own function is the only moment a frame exists.
 */
/*
 * GDI's frame boundary is BitBlt: rw_imp.c blits the DIB section to the window once a picture is
 * complete, which is the same moment MGL_bitBltCoord marks for WinQuake and XPutImage for X11.
 * src/env/win32.c publishes the surface beside it, in the prism_dib_* globals.
 */
const dibSym = (n) => program.mod.symbols.get(n)?.addr ?? 0;
const dibBase = dibSym('prism_dib_surface');
/*
 * THE PLANAR VGA'S FRAME BOUNDARY IS THE PAGE FLIP, and it comes from the program rather than from
 * this file: main.c makes a page visible by writing the CRTC start address, and src/env/vgaplanar.js
 * counts that. Without it a planar target crosses no boundary this tool knows, so --frames can
 * never be reached and the run never ends -- which is exactly what happened on the first attempt.
 */
if (program.M.vga) {
  program.M.vga.onFrame = () => {
    frames++;
    // The page flip is this platform's frame boundary, so it is also where a key is tapped: the
    // MGL branch below had the only tapKeys() call, which made --keys silently do nothing here --
    // the run came back byte-identical to a keyless one and printed no [key] line to say why.
    tapKeys();
    if (frameCap && frames >= frameCap) throw new Error('__frames_done');
  };
}
if ((frameCap || pngPath) && dibBase && program.F.BitBlt) {
  const inner = program.F.BitBlt;
  const wrapped = function (...a) {
    const r = inner.apply(this, a);
    if (frameCap && ++frames >= frameCap) throw new Error('__frames_done');
    return r;
  };
  program.F.BitBlt = wrapped;
  program.mod.bindFunc('BitBlt', wrapped);
}
if ((frameCap || pngPath) && program.M.svgalib && program.F.VID_Update) {
  const inner = program.F.VID_Update;
  const wrapped = function (...a) {
    const r = inner.apply(this, a);
    if (frameCap && ++frames >= frameCap) throw new Error('__frames_done');
    return r;
  };
  program.F.VID_Update = wrapped;
  program.mod.bindFunc('VID_Update', wrapped);
}
/*
 * The same thing for a program presenting through MGL, whose frame boundary is MGL_bitBltCoord.
 *
 * The four integers it reads are published by src/env/mgl.c, in C, on purpose: `surface` and
 * `mi.bytesPerLine` live inside a struct whose layout this file must not guess at -- that is the
 * whole reason that shim is not written in JavaScript. Plain integers cross the boundary safely.
 */
const mglAddr = (n) => program.mod.symbols.get(n)?.addr ?? 0;
const mgl = program.F.MGL_bitBltCoord && mglAddr('prism_mgl_surface')
  ? { surface: mglAddr('prism_mgl_surface'), width: mglAddr('prism_mgl_width'),
      height: mglAddr('prism_mgl_height'), pitch: mglAddr('prism_mgl_pitch'),
      palette: mglAddr('prism_mgl_palette') }
  : null;
/*
 * --keys=esc,down,enter taps keys at the frame boundary, through whichever door this platform has.
 *
 * For a Win32 program that is `prism_win32_key` in src/env/win32.c, which posts a real WM_KEYDOWN
 * into the message queue -- so the keystroke travels the route the program expects, out through
 * PeekMessage and back into its own window procedure, rather than being handed to its input code
 * behind its back.
 */
const KEYNAMES = {
  esc: 0x01, enter: 0x1c, space: 0x39, up: 0x48, down: 0x50, left: 0x4b, right: 0x4d,
  ctrl: 0x1d, y: 0x15, n: 0x31, tab: 0x0f, tilde: 0x29, f1: 0x3b,
};
const keyScript = (opt('keys') ?? '').split(',').map(k => k.trim()).filter(Boolean)
  .map(k => KEYNAMES[k.toLowerCase()] ?? parseInt(k, 16));
const keyEvery = +(opt('keyevery') ?? 20);
const keyFirst = +(opt('keyat') ?? 40);
/*
 * --keyhold=N IS NOT A REFINEMENT, IT IS WHAT MAKES A KEYSTROKE EXIST. Pressing and releasing
 * inside one frame callback runs no guest code between the two, so the program never looks while
 * the key is down. Measured on Jump 'n Bump over 900 frames: its own key_pressed() was called
 * 12,601 times and returned DOWN 0 times with no hold, and 104 times with a 6-frame hold.
 */
const keyHold = +(opt('keyhold') ?? 6);
let keyAt = 0, keyHeld = null, keyReleaseAt = 0;
/*
 * THE SECOND DOOR, for a DOS program that hooks the keyboard interrupt itself.
 *
 * Jump 'n Bump takes vector 9 through _go32_dpmi_set_protected_mode_interrupt_vector, and its
 * handler reads port 0x60 and fills its own `keyb[]` array. So there is nothing to call in the
 * game: the keystroke has to arrive the way the hardware sends it -- a scan code waiting at 0x60,
 * and then the guest's OWN handler invoked. Both halves already existed and nothing joined them:
 * src/env/kbd8042.js queues the code (its header says so in as many words) and src/env/go32.js
 * records the vector and can `deliver` it through M.icall.
 *
 * This is what P1.7 means by the keyboard having stopped being a function. There is no
 * osd_key_pressed to shim: `key_pressed()` reads memory an interrupt writes behind the program's
 * back, and the host's only way in is to BE that interrupt.
 */
/*
 * A CODE OF 0x80 OR MORE IS AN EXTENDED KEY, and it has to arrive as the two bytes the hardware
 * really sends -- 0xe0, then the base code -- because the handler reads ONE byte per interrupt and
 * keeps `extended` in a static across the two. Jump 'n Bump's own KEY_PL1_JUMP is 0xc8, and its
 * handler reaches that slot only as `(key & 0x7f) + 0x80` inside the extended branch: sending 0x48
 * alone fills keyb[0x48], a byte the game never reads. Masking the code to 0x7f here made the door
 * and the probe wrong in the same direction, so the check could not fail.
 */
const dosKey = (program.M.kbd && env.go32?.deliver)
  ? (code, down) => {
    const send = (b) => { program.M.kbd.push(b); env.go32.deliver(9); };
    if (code >= 0x80) send(0xe0);
    send(down ? (code & 0x7f) : ((code & 0x7f) | 0x80));
  }
  : null;
const pressKey = program.F.prism_win32_key ?? dosKey;
if (keyScript.length && !pressKey) {
  // A flag that quietly does nothing is worse than one that is missing: say so.
  console.log(`  --keys: this target has no key door here. A Win32 program needs prism_win32_key ` +
    `(src/env/win32.c); a DOS one that hooks vector 9 needs the kbd8042 and go32 environments, ` +
    `which is what joins a scan code at port 0x60 to the guest's own handler.`);
}
const tapKeys = () => {
  if (!pressKey) return;
  // The release comes from a LATER frame than the press, so guest code runs while the key is down.
  if (keyHeld !== null && frames >= keyReleaseAt) { pressKey(keyHeld, 0); keyHeld = null; }
  if (keyHeld !== null || keyAt >= keyScript.length) return;
  if (frames < keyFirst || (frames - keyFirst) % keyEvery !== 0) return;
  const code = keyScript[keyAt++] & 0xff;   // NOT 0x7f: that truncated every extended key to its base
  pressKey(code, 1);
  if (keyHold > 0) { keyHeld = code; keyReleaseAt = frames + keyHold; } else pressKey(code, 0);
  console.log(`[key] 0x${code.toString(16).padStart(2, '0')} at frame ${frames}` +
    (keyHold > 0 ? `, held ${keyHold} frames` : ''));
};

if ((frameCap || pngPath || keyScript.length) && mgl) {
  /*
   * BOTH blits, because FlipScreen (vid_win.c) presents through MGL_stretchBltCoord in Quake's 2x
   * windowed modes and through MGL_bitBltCoord in every other one. Counting only the first made a
   * stretched mode look like a hang: the frame counter stopped, --frames never arrived, and the
   * program was rendering the whole time.
   */
  for (const name of ['MGL_bitBltCoord', 'MGL_stretchBltCoord']) {
    const inner = program.F[name];
    if (!inner) continue;
    const wrapped = function (...a) {
      const r = inner.apply(this, a);
      frames++;
      tapKeys();
      if (frameCap && frames >= frameCap) throw new Error('__frames_done');
      return r;
    };
    program.F[name] = wrapped;
    program.mod.bindFunc(name, wrapped);
  }
}

/*
 * THE RUN IS TIMED SEPARATELY FROM THE COMPILE, because they are different claims and mixing them
 * makes both useless. The compile number says how fast PRISM turns C into JavaScript; this one says
 * how fast the resulting JavaScript runs the program, and only the second can be called fps.
 *
 * What it measures is the guest's own frame boundary -- VID_Update, XPutImage, the MGL blit -- so it
 * is the rate at which the PROGRAM finished pictures, not the rate at which a host presented them.
 *
 * ⚠️ IT IS THROUGHPUT, NOT A FRAME RATE, and the difference is not pedantry. This tool leaves the
 * runtime's DETERMINISTIC clock in place: `gettimeofday` advances a fixed 1/35 s per CALL, so the
 * guest's notion of time races ahead of the wall and `Host_FilterTime` never makes Quake wait. The
 * engine therefore renders on every iteration of its main loop, and what is printed is how much
 * engine work the emitted JavaScript gets through per second. The browser is the other case:
 * `web/worker.js` calls installRealClock, so there the program paces itself against real time and
 * the number you would read off the screen is a frame rate. Quoting this one as fps would compare
 * an unthrottled run against a throttled one.
 */
const runT0 = performance.now();
try {
  program.run([target.name, ...args]);
} catch (e) {
  /*
   * A leashed run is REPORTED, never silently treated as a completed one: it ended because time ran
   * out, and whatever it drew is a snapshot of an unfinished run, not the frame that was asked for.
   */
  if (e.message === '__leash') leashed = true;
  else if (e.message !== '__frames_done') console.log(`exited: ${e.message}`);
}
const runSecs = (performance.now() - runT0) / 1000;
/**
 * ` · 1.2 s, 257 rendered frames/s (deterministic clock, unthrottled)` — and it says which, because
 * a bare "fps" here would be read as the rate a player sees. Omitted when nothing counted frames:
 * zero is not a measurement.
 */
const fpsNote = () => (frames > 0
  ? ` · ${runSecs.toFixed(1)} s, ${(frames / runSecs).toFixed(0)} rendered frames/s ` +
    `(deterministic clock, unthrottled)`
  : ` · ${runSecs.toFixed(1)} s`) +
  (leashed ? ` · STOPPED BY --seconds: the run did not finish on its own` : '');

if (wavPath && program.M.dsp?.wav) {
  const w = program.M.dsp.wav, ch = program.M.dsp.channels || 2, rate = program.M.dsp.rate || 11025;
  let peak = 0, energy = 0;
  for (const v of w) { const a = Math.abs(v); if (a > peak) peak = a; energy += v * v; }
  console.log(`\naudio: ${(w.length / ch) | 0} frames at ${rate} Hz x${ch} · peak ${peak} · ` +
    `rms ${(w.length ? Math.sqrt(energy / w.length) : 0).toFixed(0)}`);
  if (w.length) {
    const n = w.length, buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2 * ch, 28); buf.writeUInt16LE(2 * ch, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(w[i], 44 + i * 2);
    writeFileSync(wavPath, buf);
    console.log(`  wrote ${wavPath}`);
  }
}

if (mgl) {
  const dv = program.mod.dv;
  const surface = dv.getInt32(mgl.surface, true);
  const width = dv.getInt32(mgl.width, true), height = dv.getInt32(mgl.height, true);
  const pitch = dv.getInt32(mgl.pitch, true);
  console.log(`\nframes ${frames} · display ${width}x${height}` + fpsNote());
  if (surface && width && pngPath) {
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) pixels[y * width + x] = program.M.u8[surface + y * pitch + x];
    }
    /*
     * MGL's palette_t is BGRA -- blue first, per its own header -- and the components are the FULL
     * 0..255, not the VGA DAC's six bits. That was worth reading rather than assuming: vid_win.c
     * writes `pal[i].red = palette[i*3]` with no shift at all, and scaling those up by four
     * saturated most of the picture and turned it yellow.
     */
    const palette = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      palette[i * 3 + 0] = program.M.u8[mgl.palette + i * 4 + 2];   // red
      palette[i * 3 + 1] = program.M.u8[mgl.palette + i * 4 + 1];   // green
      palette[i * 3 + 2] = program.M.u8[mgl.palette + i * 4 + 0];   // blue
    }
    let nz = 0;
    for (const b of pixels) if (b) nz++;
    writeIndexedPng(pngPath, { pixels, width, height, palette });
    console.log(`  ${nz} non-zero pixels of ${pixels.length}, ${new Set(pixels).size} colours -> ${pngPath}`);
  }
} else if (program.M.vga && !program.M.vga.chained) {
  /*
   * THE PLANAR PICTURE, de-interleaved. In unchained VGA four consecutive pixels live in four
   * different planes at the SAME offset, so pixel (x, y) is plane x&3 at start + y*rowBytes + x/4.
   *
   * Every number here is read from the adapter rather than assumed: the width and height come from
   * the Offset and Vertical Display End registers the program itself wrote, and `start` is the CRTC
   * start address -- which is how the page it just flipped to is the page that gets saved. For this
   * game start is 0x8000 on the second page, the same 32768 its assembly shifts a page number by.
   */
  const vga = program.M.vga;
  const { width: w, height: h, rowBytes } = vga.geometry();
  console.log(`\nframes ${frames} · display ${w}x${h} · planar, ${rowBytes} bytes a row per plane ` +
    `· page at 0x${vga.start.toString(16)}` + fpsNote());
  if (pngPath && w > 0 && h > 0) {
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const plane = vga.planes + (x & 3) * 0x10000;
        px[y * w + x] = program.M.u8[plane + vga.start + y * rowBytes + (x >> 2)];
      }
    }
    let nz = 0;
    for (const b of px) if (b) nz++;
    /*
     * The DAC's palette -- the ARRAY, not the device. installVgaDac returns { palette }, and
     * passing the object where 768 bytes were wanted produced a picture that was entirely black
     * while the run truthfully reported 27,694 non-zero pixels in 84 colours. Two numbers that
     * cannot both be right about the same image is what made it worth looking at rather than
     * explaining.
     */
    const palette = program.M.dac?.palette ?? null;
    writeIndexedPng(pngPath, { pixels: px, width: w, height: h, palette });
    console.log(`  ${nz} non-zero pixels of ${px.length}, ${new Set(px).size} colours -> ${pngPath}`);
  }
} else if (dibBase && program.mod.dv.getInt32(dibBase, true)) {
  /*
   * The DIB section, read back out of guest memory. Its rows are padded to a DWORD, so the picture
   * has to be de-strided before it is a bitmap -- pitch is what the renderer strides by, width is
   * what the image is.
   */
  const dv = program.mod.dv;
  const at = (n) => dv.getInt32(dibSym(n), true);
  const surface = dv.getInt32(dibBase, true);
  const w = at('prism_dib_width'), h = at('prism_dib_height'), pitch = at('prism_dib_pitch');
  const topdown = at('prism_dib_topdown');
  console.log(`\nframes ${frames} · display ${w}x${h} · pitch ${pitch} · ` +
    `${topdown ? 'top-down' : 'bottom-up'}` + fpsNote());
  if (pngPath && w > 0 && h > 0) {
    /*
     * BOTTOM-UP IS THE DEFAULT, and ignoring it turns the picture upside down.
     *
     * A DIB with a POSITIVE biHeight stores row 0 at the BOTTOM of the image -- the convention
     * bitmaps have had since OS/2 -- and Quake II asks for one: measured here as bottom-up, which is
     * why the first console this target drew came out inverted. A negative biHeight means top-down,
     * and src/env/win32.c records which was asked for rather than assuming either.
     */
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const src = surface + (topdown ? y : h - 1 - y) * pitch;
      px.set(program.M.u8.subarray(src, src + w), y * w);
    }
    const palAddr = dibSym('prism_dib_palette');
    const palette = Uint8Array.from(program.M.u8.subarray(palAddr, palAddr + 768));
    let nz = 0;
    for (const b of px) if (b) nz++;
    writeIndexedPng(pngPath, { pixels: px, width: w, height: h, palette });
    console.log(`  ${nz} non-zero pixels of ${px.length}, ${new Set(px).size} colours -> ${pngPath}`);
  }
} else if (program.M.svgalib?.mem) {
  /* svgalib: the framebuffer IS the console's memory, and the palette came through vga_setpalvec. */
  const g = program.M.svgalib;
  console.log(`\nframes ${frames} · display ${g.width}x${g.height}` + fpsNote());
  if (pngPath) {
    const px = program.M.u8.subarray(g.mem, g.mem + g.width * g.height);
    let nz = 0;
    for (const b of px) if (b) nz++;
    writeIndexedPng(pngPath, { pixels: px, width: g.width, height: g.height, palette: g.palette });
    console.log(`  ${nz} non-zero pixels of ${px.length}, ${new Set(px).size} colours -> ${pngPath}`);
  }
} else if (program.M.x11?.imageData) {
  const x = program.M.x11;
  console.log(`\nframes ${frames} · display ${x.width}x${x.height}` + fpsNote());
  if (pngPath) {
    const px = program.M.u8.subarray(x.imageData, x.imageData + x.width * x.height);
    let nz = 0;
    for (const b of px) if (b) nz++;
    writeIndexedPng(pngPath, { pixels: px, width: x.width, height: x.height, palette: x.palette });
    console.log(`  ${nz} non-zero pixels of ${px.length}, ${new Set(px).size} colours -> ${pngPath}`);
  }
}
