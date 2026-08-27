// opendune.mjs — OpenDUNE, run and looked at.
//
//   node tools/opendune.mjs [--data=<dir>] [--frames=200] [--png=/tmp/od.png]
//
// The build is targets/opendune.json; this is the half a JSON file has no business describing.
// Video_Tick is the frame -- src/opendune.c's GameLoop_Main calls it in an unbounded loop -- so it
// is both where to count and the only place to stop.
//
// The picture comes straight out of 0xA0000. video_dos.c sets mode 13h and writes there, and PRISM
// reserves the low megabyte, so the framebuffer is simply memory. Nothing is emulated for it: the
// palette goes through the VGA DAC at 0x3C8/0x3C9, which is the same three-device story as Quake DOS.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { writeIndexedPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = (n, d = null) => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const flag = (n) => argv.includes(`--${n}`);
const FRAMES = +(opt('frames') ?? 200);

/* Data from a directory the user names. Dune II's own files; never fetched here. */
const files = {};
const DATA = opt('data');
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
  console.log(`data: ${Object.keys(files).length} files from ${DATA}`);
}

const target = loadTarget(join(ROOT, 'targets/opendune.json'));
const { program, env, units } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files } } });
const loc = units.reduce((n, u) => n + u.source.split('\n').length, 0);
console.log(`OpenDUNE — ${units.length} units, ${loc.toLocaleString('en')} lines, ` +
  `${Object.keys(program.F).length} functions`);
if (program.failures?.length) console.log(`  ${program.failures.length} functions unemitted`);

/*
 * Everything it says. src/os/error.c's Error/Warning/Debug go to stderr through vfprintf, not
 * through vsprintf -- so hooking the formatter alone showed nothing at all and made a program that
 * had exited with a message look like one that had exited in silence.
 */
if (!flag('quiet')) {
  const write = program.M.write.bind(program.M);
  program.M.write = (str) => { process.stdout.write(str); write(str); };
}

let frames = 0;
const tick = program.F.Video_Tick;
if (typeof tick === 'function') {
  program.F.Video_Tick = function (...a) {
    const r = tick.apply(this, a);
    if (++frames >= FRAMES) throw new Error('__frames_done');
    return r;
  };
} else console.log('(no Video_Tick — the loop will have to stop on its own)');

const t0 = performance.now();
try {
  program.run(['opendune', ...(opt('args') ?? '').split(/\s+/).filter(Boolean)]);
} catch (e) {
  if (e.message !== '__frames_done') {
    console.log(`\nexited: ${e.message}`);
    if (flag('trace')) console.log(String(e.stack).split('\n').slice(1, 12).join('\n'));
  }
}
const secs = (performance.now() - t0) / 1000;
console.log(`\n${frames} Video_Tick in ${secs.toFixed(1)} s`);

/* Mode 13h: 320x200 bytes at 0xA0000, and the DAC holds the palette. */
const px = program.M.u8.slice(0xa0000, 0xa0000 + 64000);
const seen = new Set(px);
console.log(`framebuffer at 0xa0000: ${px.reduce((n, v) => n + (v ? 1 : 0), 0)} non-zero of 64000, ` +
  `${seen.size} distinct colours`);
const png = opt('png');
if (png && env.vgadac) {
  writeIndexedPng(png, { pixels: px, width: 320, height: 200, palette: env.vgadac.palette });
  console.log(`wrote ${png}`);
}
