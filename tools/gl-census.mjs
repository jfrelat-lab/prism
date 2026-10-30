// gl-census.mjs — every small OpenGL program of a collection, on PRISM and on Mesa, frame for frame.
//
// A coverage instrument, not a gate: where gate-mesa-demos holds three chosen programs with controls,
// this takes a whole collection -- the Red Book's examples, mesa-demos, Mark Kilgard's GLUT demos --
// builds each program with PRISM (gl, glu, glut on the software rasteriser) and with gcc against Mesa
// in the oracle container (its GLUT answered by tools/oracle/glut-egl.c on the same 40 ms a swap),
// compares the frames, and sorts what it finds:
//
//   equal       every frame within MAX_OFF of Mesa's pixels (a channel off by more than TOL)
//   differs     a frame further off than that -- the worst fraction is printed
//   prism: ...  PRISM refused it: a compile error, a function not emitted, a GL call gl.js lacks
//   mesa: ...   the reference did not build or run (glut-egl.c lacks what it asked of GLUT)
//
// and counts the messages, so that what gl.js lacks most comes first.
//
//   node tools/gl-census.mjs <set> [name ...] [--frames=2,20] [--png=<dir>]
//   sets: redbook, demos, samples, trivial (mesa-demos 8.0.1), glut-demos, glut-examples (GLUT 3.7)
import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, cpSync, statSync, rmSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget } from '../src/target.js';
import { up, sh, SCRATCH, oracleGlut } from './oracle.mjs';
import { writeRgbPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MD = 'corpus/mesa-demos-8.0.1-dist/mesa-demos-8.0.1/src', GL37 = 'corpus/glut-3.7-dist/glut-3.7/progs';
const TOL = 8, MAX_OFF = 0.005;
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const FRAMES = (arg('frames') ?? '2,20').split(',').map(Number);
const pngDir = arg('png');
const [SET, ...NAMES] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

/*
 * A program: the directory it runs in (`dir`, relative to the set's `root`), its units there, and the
 * data files beside it. mesa-demos' programs share src/util (readtex.c, trackball.c, showbuffer.c),
 * taken in when a program includes its header, and open their images as ../images/<name>.
 */
const UTIL = { 'readtex.h': 'readtex.c', 'trackball.h': 'trackball.c', 'showbuffer.h': 'showbuffer.c', 'shaderutil.h': 'shaderutil.c' };
const DATA = /\.(rgb|rgba|bw|dat|ppm|bin|txt)$/i;
function mesaDemos(sub) {
  const d = join(ROOT, MD, sub);
  return readdirSync(d).filter((f) => f.endsWith('.c')).sort().map((f) => {
    const src = readFileSync(join(d, f), 'latin1');
    const util = Object.entries(UTIL).filter(([h]) => src.includes(`"${h}"`)).map(([, c]) => `../util/${c}`);
    return { name: f.replace(/\.c$/, ''), root: MD, dir: sub, units: [f, ...util], include: ['util'], images: true };
  });
}
function glutDemos() {
  const d = join(ROOT, GL37, 'demos');
  return readdirSync(d).filter((s) => statSync(join(d, s)).isDirectory()).sort().map((s) => {
    const files = readdirSync(join(d, s));
    return { name: s, root: GL37, dir: `demos/${s}`, units: files.filter((f) => f.endsWith('.c')).sort(), data: files.filter((f) => DATA.test(f)) };
  });
}
function glutExamples() {
  const d = join(ROOT, GL37, 'examples');
  const all = readdirSync(d);
  return all.filter((f) => f.endsWith('.c')).sort().map((f) => ({ name: f.replace(/\.c$/, ''), root: GL37, dir: 'examples', units: [f], data: all.filter((x) => DATA.test(x)) }));
}
const SETS = {
  redbook: () => mesaDemos('redbook'), demos: () => mesaDemos('demos'), samples: () => mesaDemos('samples'), trivial: () => mesaDemos('trivial'),
  'glut-demos': glutDemos, 'glut-examples': glutExamples,
};
if (!SETS[SET]) { console.log(`a set: ${Object.keys(SETS).join(', ')}`); process.exit(2); }
const programs = SETS[SET]().filter((p) => !NAMES.length || NAMES.includes(p.name));

// ---- the reference --------------------------------------------------------------------------------
up();
const work = join(SCRATCH, 'gl-census');
mkdirSync(join(work, '_glut', 'GL'), { recursive: true });
oracleGlut(join(work, '_glut'));
// Each program's directory and the ones it includes from, fresh (the archives' files are read-only).
const copied = new Set();
for (const p of programs) for (const d of [p.dir, ...(p.include ?? []), ...(p.images ? ['images'] : [])]) {
  const key = join(p.root, d);
  if (copied.has(key)) continue;
  copied.add(key);
  const dest = join(work, p.root.replace(/\//g, '_'), d);
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(ROOT, key), dest, { recursive: true });
  sh(`chmod -R u+w /work/gl-census/${p.root.replace(/\//g, '_')}/${d} 2>/dev/null; true`);
}
const readPpm = (p) => {
  const b = readFileSync(p), m = b.toString('latin1', 0, 32).match(/^P6\n(\d+) (\d+)\n255\n/);
  return { w: +m[1], h: +m[2], rgb: b.subarray(m[0].length) };
};
// A program that asks for an accumulation buffer is built on OSMesa (see glut-egl.c): an EGL framebuffer object has none.
const osmesa = (p) => p.units.some((u) => /GLUT_ACCUM/.test(readFileSync(join(ROOT, p.root, p.dir, u), 'latin1')));
function mesa(p) {
  const at = `/work/gl-census/${p.root.replace(/\//g, '_')}/${p.dir}`;
  const inc = (p.include ?? []).map((i) => `-I../${i}`).join(' ');
  const r = sh(`cd ${at} && rm -f frame-*.ppm census-prog && gcc -O0 -w -I/work/gl-census/_glut -I. ${inc} -o census-prog ${p.units.join(' ')} /work/gl-census/_glut/glut-egl.c /work/gl-census/_glut/glut-c-*.c -lGLU ${osmesa(p) ? "-DPRISM_OSMESA -lOSMesa" : "-lEGL -lOpenGL"} -lm 2> census-cc.txt; grep -m1 -E 'error|undefined reference' census-cc.txt; test -x census-prog && PRISM_GLUT_FRAMES=${FRAMES.join(',')} timeout 30 ./census-prog > /dev/null 2>&1; ls frame-*.ppm 2>/dev/null`);
  r.err = (r.stdout + r.stderr).split('\n').find((l) => /error|undefined reference/.test(l))?.replace(/^.*?: /, '');
  const local = join(work, p.root.replace(/\//g, '_'), p.dir);
  const got = Object.fromEntries(FRAMES.filter((n) => existsSync(join(local, `frame-${n}.ppm`))).map((n) => [n, readPpm(join(local, `frame-${n}.ppm`))]));
  if (!Object.keys(got).length) return { error: r.err || 'no frame' };
  return { frames: got };
}

// ---- PRISM ----------------------------------------------------------------------------------------
function prism(p) {
  const files = {};
  const dataDir = join(ROOT, p.root, p.dir);
  for (const f of p.data ?? []) files[f] = () => new Uint8Array(readFileSync(join(dataDir, f)));
  if (p.images) { const im = join(ROOT, MD, 'images'); for (const f of readdirSync(im)) files[f] = () => new Uint8Array(readFileSync(join(im, f))); }
  const out = {};
  const deadline = performance.now() + 30000;
  let program;
  try {
    ({ program } = buildTarget({ name: p.name, dir: join(p.root, p.dir), units: { list: p.units }, include: (p.include ?? []).map((i) => `../${i}`),
      compile: { memory: 16, collect: true }, env: ['stdio', 'gl', 'glu', 'glut'] }, { root: ROOT,
      envExtra: { stdio: { files }, glut: { frames: FRAMES, onFrame: (n, rgba, w, h) => { out[n] = { w, h, rgba: rgba.slice() }; }, stop: () => performance.now() > deadline } } }));
  } catch (e) { return { error: `compile: ${e.message.split('\n')[0].slice(0, 120)}` }; }
  const failed = program.failures ?? [];
  if (failed.length) return { error: `not emitted (${failed.length}): ${failed[0].message ?? failed[0].fn}` };
  program.M.write = () => {};
  try { program.run([p.name]); } catch (e) { if (!Object.keys(out).length) return { error: e.message.split('\n')[0].slice(0, 140) }; }
  if (!Object.keys(out).length) return { error: 'no frame' };
  return { frames: out };
}

function compare(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { off: 1, size: `${a.w}x${a.h} vs ${b.w}x${b.h}` };
  let off = 0;
  const n = b.w * b.h, diff = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.rgba[4 * i + k] - b.rgb[3 * i + k]));
    if (d > TOL) { off++; diff[i] = 1; }
  }
  return { off: off / n, diff };
}

const tally = { equal: 0, differs: 0, prism: 0, mesa: 0 }, messages = new Map();
const note = (m) => messages.set(m, (messages.get(m) ?? 0) + 1);
if (pngDir) mkdirSync(pngDir, { recursive: true });
for (const p of programs) {
  const ref = mesa(p);
  const mine = prism(p);
  let line;
  if (mine.error) { tally.prism++; line = `prism: ${mine.error}`; note(mine.error.replace(/0x[0-9a-f]+/g, (h) => h).slice(0, 90)); }
  else if (ref.error) { tally.mesa++; line = `mesa: ${ref.error.slice(0, 100)}`; }
  else {
    let worst = 0, size = null;
    for (const n of FRAMES) {
      const a = mine.frames[n], b = ref.frames[n];
      if (!a || !b) { worst = Math.max(worst, a || b ? 1 : 0); continue; }
      const c = compare(a, b);
      if (c.size) size = c.size;
      worst = Math.max(worst, c.off);
      if (pngDir && c.diff && n === FRAMES.at(-1)) {
        const W = b.w, H = b.h, img = new Uint8Array(W * 3 * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x, pa = [a.rgba[4 * i], a.rgba[4 * i + 1], a.rgba[4 * i + 2]], pb = [b.rgb[3 * i], b.rgb[3 * i + 1], b.rgb[3 * i + 2]];
          const d = c.diff[i] ? [255, 0, 255] : pa.map((v) => v >> 2);
          [pa, pb, d].forEach((col, k) => { const o = (y * W * 3 + k * W + x) * 4; img[o] = col[2]; img[o + 1] = col[1]; img[o + 2] = col[0]; img[o + 3] = 255; });
        }
        writeRgbPng(join(pngDir, `${SET}-${p.name}.png`), { bytes: img, width: W * 3, height: H });
      }
    }
    if (worst <= MAX_OFF) { tally.equal++; line = `equal (worst ${(100 * worst).toFixed(2)}%)`; }
    else { tally.differs++; line = `differs: ${(100 * worst).toFixed(1)}% of the pixels${size ? `, window ${size}` : ''}`; }
  }
  console.log(`${p.name.padEnd(18)} ${line}`);
}
console.log(`\n${SET}: ${programs.length} programs -- ${tally.equal} equal to Mesa, ${tally.differs} differ, ${tally.prism} refused by PRISM, ${tally.mesa} without a reference`);
if (messages.size) {
  console.log('\nwhat PRISM refused, most frequent first:');
  for (const [m, k] of [...messages].sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padStart(3)}  ${m}`);
}
