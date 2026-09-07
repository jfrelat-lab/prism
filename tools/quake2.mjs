// quake2.mjs — Quake II, run and looked at.
//
//   node tools/quake2.mjs --data=<dir with baseq2/> [--frames=200] [--png=/tmp/q2.png] [--verbose]
//
// The BUILD is not here: targets/quake2.json states it, and src/target.js reads it. What is here is
// the half a JSON file has no business describing — where to interrupt a program whose main loop is
// `while (1) Qcommon_Frame (0.1);`, and how to get a look at what it drew.
//
// Three modules, bridged where the program bridges them: the refresh through GetRefAPI, which
// null/vid_null.c calls in process, and the game through dlopen/dlsym over PRISM's symbol table.
// linux/rw_x11.c is what gives ref_soft a surface at all — null/swimp_null.c's SWimp_SetMode returns
// nothing, so vid.buffer stayed 0 and the renderer had nowhere to draw.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { writeIndexedPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (n, d = null) => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const flag = (n) => argv.includes(`--${n}`);

const DATA = opt('data');
const FRAMES = +(opt('frames') ?? 200);
const probes = [];

/* Data from a directory the user names, never fetched here and never in the repository. */
const files = {};
if (DATA) {
  if (!existsSync(DATA)) { console.error(`no such directory: ${DATA}`); process.exit(2); }
  const walk = (d, prefix = '') => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${e}/`);
      else files[`${prefix}${e}`] = new Uint8Array(readFileSync(full));
    }
  };
  walk(DATA);
  console.log(`data: ${Object.keys(files).length} files, ` +
    `${(Object.values(files).reduce((n, b) => n + b.length, 0) / 1048576).toFixed(1)} MB`);
}

const target = loadTarget(join(ROOT, 'targets/quake2.json'));
/* Files the INSTALLATION provides -- targets/*.json's `files`; vid_so.c reads /etc/quake2.conf. */
for (const [name, text] of Object.entries(target.files ?? {})) {
  if (!(name in files)) files[name] = new TextEncoder().encode(`${text}\n`);
}
const t0 = performance.now();
const { program, env, units } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files } } });
const loc = units.reduce((n, u) => n + u.source.split('\n').length, 0);
console.log(`Quake II — ${units.length} units, ${loc.toLocaleString('en')} lines, ` +
  `${Object.keys(program.F).length} functions in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
if (program.failures?.length) console.log(`  ${program.failures.length} functions unemitted`);

/*
 * Everything the program says, which is otherwise invisible: null/sys_null.c's Sys_ConsoleOutput is
 * empty and sys_linux.c writes to a terminal this host does not have. vsprintf is where every
 * formatted message passes, so it is one hook rather than a dozen.
 */
if (!flag('quiet')) {
  const vsprintf = program.M.rt.vsprintf;
  program.M.rt.vsprintf = (dst, fmt, ap) => {
    const r = vsprintf(dst, fmt, ap);
    const s = program.M.mod.cstr(dst).trimEnd();
    if (s) console.log(`  > ${s}`);
    return r;
  };
}

/*
 * The frame cap. Qcommon_Frame is the frame -- sys_linux.c's main calls it in an unbounded loop --
 * so it is both the right place to count and the only place to stop.
 */
/*
 * --probe-input: how many times the input path is actually reached.
 *
 * "The game runs and ignores the keyboard" has two very different causes -- the events never arrive,
 * or the client never asks for them -- and they look identical from a screenshot. Counting the calls
 * separates them in one run.
 */
if (flag('probe-input')) {
  /*
   * BY LINKAGE NAME, not by the name in the source. A function that belongs to a module is placed as
   * `ref_soft$KBD_Update` -- that is the whole point of the per-module namespaces -- so looking it up
   * unqualified finds nothing and reports "not in this build" about a function that is right there.
   * And the Xlib entry points are not the program's at all: they are PRISM's shim, on M.rt.
   */
  for (const name of ['KBD_Update', 'Do_Key_Event', 'RW_IN_Frame', 'RW_IN_Commands', 'XLateKey']) {
    const key = program.F[name] ? name
      : program.F[`ref_soft$${name}`] ? `ref_soft$${name}` : null;
    if (!key) { console.log(`  [probe] ${name}: in neither namespace`); continue; }
    const f = program.F[key];
    let n = 0;
    const w = function (...a) { n++; return f.apply(this, a); };
    program.F[key] = w;
    program.mod.bindFunc(key, w);
    probes.push([key, () => n]);
  }
  for (const name of ['XPending', 'XNextEvent', 'XLookupString', 'XKeycodeToKeysym']) {
    const f = program.M.rt[name];
    if (!f) { console.log(`  [probe] ${name}: not in the shim`); continue; }
    let n = 0;
    program.M.rt[name] = function (...a) { n++; return f.apply(this, a); };
    probes.push([`rt.${name}`, () => n]);
  }
}

let frames = 0;
const inner = program.F.Qcommon_Frame;
program.F.Qcommon_Frame = function (...a) {
  const r = inner.apply(this, a);
  if (++frames >= FRAMES) throw new Error('__frames_done');
  return r;
};

const t1 = performance.now();
try {
  program.run(['quake2', ...(opt('args') ?? '').split(/\s+/).filter(Boolean)]);
} catch (e) {
  if (e.message !== '__frames_done') {
    console.log(`\nexited: ${e.message}`);
    if (flag('trace')) console.log(String(e.stack).split('\n').slice(1, 12).join('\n'));
  }
}
const secs = (performance.now() - t1) / 1000;
console.log(`\n${frames} frames in ${secs.toFixed(1)} s (${(frames / secs).toFixed(1)}/s)`);
for (const [name, count] of probes) console.log(`  [probe] ${name}: ${count().toLocaleString('en')} calls`);

/*
 * What ref_soft drew.
 *
 * `vid` is the renderer's own viddef_t -- buffer, colormap, alphamap, rowbytes, width, height -- and
 * it lives in the ref_soft module, so its linkage name carries the module. Reading it rather than
 * the X image is deliberate: it is the renderer's output, before anything the platform does with it.
 */
const vid = program.mod.symbols.get('ref_soft$vid');
if (!vid) { console.log('ref_soft$vid absent'); process.exit(0); }
const dv = program.mod.dv;
const buffer = dv.getUint32(vid.addr, true);
const rowbytes = dv.getInt32(vid.addr + 12, true);
const width = dv.getInt32(vid.addr + 16, true);
const height = dv.getInt32(vid.addr + 20, true);
console.log(`vid: ${width}x${height} rowbytes=${rowbytes} buffer=0x${buffer.toString(16)}`);
if (!buffer || !width || !height) { console.log('nothing drawn'); process.exit(0); }

const px = new Uint8Array(width * height);
for (let y = 0; y < height; y++) {
  px.set(program.M.u8.subarray(buffer + y * rowbytes, buffer + y * rowbytes + width), y * width);
}
const seen = new Set(px);
console.log(`  ${px.reduce((n, v) => n + (v ? 1 : 0), 0)} non-zero of ${px.length} pixels, ` +
  `${seen.size} distinct colours`);

/*
 * The palette: sw_state.currentpalette, which R_GammaCorrectAndSetPalette fills. It is 256 entries of
 * four bytes, and the fourth is padding rather than alpha.
 */
const sw = program.mod.symbols.get('ref_soft$sw_state');
const palette = new Uint8Array(768);
if (sw) {
  const CURRENTPALETTE = 4 + 4 + 256;      // fullscreen, prev_mode, gammatable[256]
  for (let i = 0; i < 256; i++) {
    for (let c = 0; c < 3; c++) palette[i * 3 + c] = program.M.u8[sw.addr + CURRENTPALETTE + i * 4 + c];
  }
}

const png = opt('png');
if (png) {
  writeIndexedPng(png, { pixels: px, width, height, palette });
  console.log(`wrote ${png}`);
}
console.log(`  environment: ${Object.keys(env).filter(k => k !== 'machine').join(' ')}`);
