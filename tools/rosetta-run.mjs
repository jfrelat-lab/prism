// rosetta-run.mjs — run the graphical Rosetta Code solutions PRISM builds, headless, and keep a picture.
//
//   node tools/rosetta-run.mjs [--frame=60]      the blocks tools/rosetta.mjs reported as env-builds
//
// Step 2 after the build: each block runs in its own process with a wall-clock limit, on the
// environment it was built against, and what it did is reported in the terms that environment has:
//
//   glut    the GL framebuffer at frame N (installGlut's own frame schedule, gate-gears' path)
//   sdl     SDL 1.2's surface at its Nth SDL_Flip/SDL_UpdateRect
//   sdl2    SDL 2's last presented texture at its Nth SDL_RenderPresent
//   x11     the window's pixels once the client has drawn into it and come back for events (the
//           core drawing requests, src/env/x11-draw.js), 50 event calls in
//   win32   a DIB section's picture when the program draws into one; otherwise whether it reached
//           its message loop -- GDI's text and shapes are accepted without a raster behind them
//           (src/env/win32.c), so a window that only draws with GDI has nothing to show here
//
// Pictures go to dist/rosetta/shots/ (gitignored, like the survey: a picture of Rosetta's program
// is the program's output), the report to dist/rosetta/runs.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const FRAME = +(arg('frame') ?? 60);
const SHOTS = join(ROOT, 'dist', 'rosetta', 'shots');

// ---------------------------------------------------------------- one block, in a child process
if (process.argv[2] === '--one') {
  const [, , , env, file, png] = process.argv;
  const { buildTarget } = await import('../src/target.js');
  const { writeRgbPng, writeIndexedPng } = await import('./png.mjs');
  const { virtualClock } = await import('../src/env/clock.js');
  // tools/rosetta.mjs's table, so a build here is the build the survey made.
  const { ENV_TARGET } = await import('./rosetta-envs.mjs');
  const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
  const stats = (bgra, n) => { let nz = 0; const cols = new Set(); for (let i = 0; i < n; i++) { const v = bgra[4 * i] | (bgra[4 * i + 1] << 8) | (bgra[4 * i + 2] << 16); if (v) nz++; if (cols.size < 4096) cols.add(v); } return { nonzero: nz, colours: cols.size }; };
  let frames = 0;
  const target = { name: 'rosetta', dir: dirname(file).slice(ROOT.length + 1), units: { list: [basename(file)] },
    compile: { memory: 64, collect: true }, ...ENV_TARGET[env] };
  const envExtra = { sdl12: { clock: virtualClock() }, sdl2: { clock: virtualClock() } };
  if (env === 'glut' || env === 'gl') {
    envExtra.glut = { frames: [FRAME - 1], onFrame: (_n, rgba, w, h) => {
      const bgra = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) { bgra[4 * i] = rgba[4 * i + 2]; bgra[4 * i + 1] = rgba[4 * i + 1]; bgra[4 * i + 2] = rgba[4 * i]; bgra[4 * i + 3] = 255; }
      writeRgbPng(png, { bytes: bgra, width: w, height: h });
      out({ phase: 'frame', frame: FRAME, width: w, height: h, ...stats(bgra, w * h) });
    } };
  }
  let built;
  try { built = buildTarget(target, { root: ROOT, envExtra }); } catch (e) { out({ phase: 'build-failed', err: String(e.message).split('\n')[0] }); }
  const { program } = built;
  const M = program.M;
  const done = new Error('__frame');
  if (env === 'sdl') {
    M.sdl.state.onPresent = () => {
      if (++frames < FRAME) return;
      const { width: w, height: h, pixels, palette, depth = 8 } = M.sdl.state;
      if (depth === 8) writeIndexedPng(png, { pixels: new Uint8Array(M.u8.subarray(pixels, pixels + w * h)), width: w, height: h, palette });
      else writeRgbPng(png, { bytes: M.u8.subarray(pixels, pixels + w * h * (depth === 32 ? 4 : 2)), width: w, height: h, bpp: depth === 32 ? 4 : 2 });
      out({ phase: 'frame', frame: frames, width: w, height: h, depth });
    };
  } else if (env === 'sdl2') {
    const inner = M.rt.SDL_RenderPresent;
    M.rt.SDL_RenderPresent = function (...a) {
      const r = inner.apply(this, a);
      if (++frames < FRAME) return r;
      const tex = [...(M.sdl?.textures?.values() ?? [])].pop();
      if (tex) writeRgbPng(png, { bytes: M.u8.subarray(tex.pixels, tex.pixels + tex.pitch * tex.h), width: tex.w, height: tex.h, bpp: tex.bpp, pitch: tex.pitch });
      out({ phase: 'frame', frame: frames, width: tex?.w ?? 0, height: tex?.h ?? 0 });
    };
  } else if (env === 'x11') {
    // A client that has drawn and come back for events many times over is showing its picture.
    for (const name of ['XNextEvent', 'XPending']) {
      const inner = M.rt[name];
      M.rt[name] = function (...a) {
        if (++frames === 50) {
          const d = M.x11.window();
          if (d?.addr) {
            const bgra = M.u8.slice(d.addr, d.addr + d.w * d.h * 4);
            writeRgbPng(png, { bytes: bgra, width: d.w, height: d.h });
            out({ phase: 'frame', frame: frames, width: d.w, height: d.h, ...stats(bgra, d.w * d.h) });
          }
        }
        return inner.apply(this, a);
      };
    }
  } else if (env.startsWith('win32')) {
    // A program that reaches its message loop has a window; after a hundred calls it is idling there.
    let polls = 0;
    for (const name of ['GetMessageA', 'GetMessage', 'GetMessageW', 'PeekMessageA', 'PeekMessage', 'PeekMessageW']) {
      const fn = program.F[name];
      if (!fn) continue;
      const wrapped = function (...a) { if (++polls === 100) throw done; return fn.apply(this, a); };
      program.F[name] = wrapped;
      program.mod.bindFunc(name, wrapped);
    }
  }
  let r = null, err = null;
  try { r = program.run(['prog']); } catch (e) { if (e !== done) err = String(e.message ?? e).split('\n')[0]; }
  const stdout = (M.output ? M.output() : r?.stdout ?? '').slice(0, 2000);
  if (env.startsWith('win32')) {
    const sym = program.mod.syms?.get?.('prism_dib_surface') ?? null;
    out({ phase: err ? 'run-error' : r ? 'exited' : 'message-loop', code: r?.code ?? null, err, stdout, dib: !!sym });
  }
  out({ phase: err ? 'run-error' : 'exited-before-frame', frames, code: r?.code ?? null, err, stdout });
}

// ---------------------------------------------------------------- all of them
function child(args, ms) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SELF, ...args], { cwd: join(ROOT, '.oracle', 'rosetta', 'run'), stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let timedOut = false;
    c.stdout.on('data', (d) => out.push(d));
    c.stderr.on('data', (d) => err.push(d));
    const t = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, ms);
    c.on('close', () => { clearTimeout(t); resolve({ timedOut, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
  });
}

mkdirSync(SHOTS, { recursive: true });
mkdirSync(join(ROOT, '.oracle', 'rosetta', 'run'), { recursive: true });
const sources = ['index-partial.json', 'index.json'].map((f) => join(ROOT, 'dist', 'rosetta', f)).filter(existsSync);
const rows = [];
for (const f of sources) for (const r of JSON.parse(readFileSync(f, 'utf8')).results) {
  if (r.status === 'env-builds' && !rows.some((x) => x.task === r.task && x.block === r.block)) rows.push(r);
}
const { createHash } = await import('node:crypto');
const slug = (t) => t.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) + '-' + createHash('sha1').update(t).digest('hex').slice(0, 8);
console.log(`${rows.length} graphical blocks that build; frame ${FRAME}, 60 s each at most`);
const runs = [];
for (const r of rows) {
  const tag = `${slug(r.task)}-${r.block}`;
  const file = join(ROOT, '.oracle', 'rosetta', 'blocks', `${tag}.c`);
  const png = join(SHOTS, `${tag}.png`);
  const c = await child(['--one', r.env, file, png], 60000);
  let res;
  try { res = JSON.parse(c.stdout); } catch { res = { phase: c.timedOut ? 'timeout' : 'crash', err: c.stderr.split('\n').find((l) => l.trim()) ?? null }; }
  runs.push({ task: r.task, block: r.block, env: r.env, ...res, shot: res.phase === 'frame' ? `shots/${tag}.png` : null });
  console.log(`  ${r.env.padEnd(6)} ${r.task.slice(0, 40).padEnd(40)} ${res.phase}${res.width ? ` ${res.width}x${res.height}` : ''}` +
    `${res.nonzero !== undefined ? `, ${res.nonzero} lit pixels, ${res.colours} colours` : ''}${res.err ? ` -- ${res.err.slice(0, 90)}` : ''}`);
}
writeFileSync(join(ROOT, 'dist', 'rosetta', 'runs.json'), JSON.stringify({ frame: FRAME, runs }, null, 1));
