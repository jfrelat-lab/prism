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
    compile: { safepoints: flag('safepoints'), ...(opt('memory') ? { memory: +opt('memory') } : {}) },
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
const { program, env, units, asm, missingHeaders, asmExports, asmWanted } = built;
const secs = ((performance.now() - t0) / 1000).toFixed(1);

const loc = units.reduce((n, u) => n + u.source.split('\n').length, 0);
console.log(`${target.title ?? target.name} — ${units.length} translation units, ` +
  `${loc.toLocaleString('en')} lines, ${Object.keys(program.F).length} functions in ${secs} s`);
if (asm?.length) console.log(`  ${asm.length} assembly objects skipped: ${asm.join(' ')}`);
if (missingHeaders.length) console.log(`  headers stubbed: ${missingHeaders.join(' ')}`);
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
const args = (opt('args') ?? '').split(/\s+/).filter(Boolean);
console.log(`\nrunning: ${target.name} ${args.join(' ')}`);
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
let keyAt = 0;
const pressKey = program.F.prism_win32_key ?? null;
if (keyScript.length && !pressKey) {
  // A flag that quietly does nothing is worse than one that is missing: say so.
  console.log(`  --keys: this target has no key door here (it needs prism_win32_key, from ` +
    `src/env/win32.c). For an X11 program use tools/doom.mjs --keys, and for a DOS one ` +
    `tools/raven.mjs or tools/quake.mjs.`);
}
const tapKeys = () => {
  if (!pressKey || keyAt >= keyScript.length) return;
  if (frames < keyFirst || (frames - keyFirst) % keyEvery !== 0) return;
  const code = keyScript[keyAt++] & 0x7f;
  pressKey(code, 1);
  pressKey(code, 0);
  console.log(`[key] 0x${code.toString(16).padStart(2, '0')} at frame ${frames}`);
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
  if (e.message !== '__frames_done') console.log(`exited: ${e.message}`);
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
  : ` · ${runSecs.toFixed(1)} s`);

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
