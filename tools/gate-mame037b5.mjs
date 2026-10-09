// gate-mame037b5.mjs — MAME 0.37b5 builds whole, its own DOS layer and zlib included.
//
// What is held, without a ROM:
//
//   1. targets/mame037b5.json is what the release's makefiles say (tools/mame037-target.mjs);
//   2. every one of its 23,000-odd functions is emitted but nine, each named below -- all GCC inline
//      assembly the program runs only on a processor that says it has CPUID (src/msdos/ticker.c) or
//      in the unchained VGA and pixel-doubling paths -- and the only unresolved names are the 39
//      routines of src/msdos/asmblit.asm, a NASM file this build does not assemble.
//
// With PRISM_MAME_ROMS=<dir of zips>, a SMOKE run through the release's own DOS layer: Space
// Invaders (8080) and Rastan (68000, the generated core) get past the warning screen, take a coin,
// start, and present a picture that is not blank, with sound that is not silence; with the ROM set
// withheld, no frame. It tells "does not start" from "starts"; it cannot tell right from wrong:
// there is no reference for 0.37b5 yet (see docs/ROADMAP.md, P8.5e).
//
//   node tools/gate-mame037b5.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);

// ---- the child: one build, one run, a JSON report on stdout.
if (process.argv[2] === '--child') {
  const { loadTarget, buildTarget } = await import('../src/target.js');
  const [, , , game, frames] = process.argv;
  const files = {};
  const roms = process.env.PRISM_MAME_ROMS;
  if (game && roms && existsSync(join(roms, `${game}.zip`))) files[`ROMS/${game}.zip`] = new Uint8Array(readFileSync(join(roms, `${game}.zip`)));
  /*
   * The keyboard, as host scan codes. The warning screen wants O then K typed, and it REDRAWS while
   * it waits, so they are tapped in turn on alternate groups of 8 frames until frame TAP -- and
   * also while no frame arrives, for a screen that does not. Then by frame number: coin (the 5 key) at COIN, start (1) a second
   * later, and the first fire button (Ctrl) held on alternate groups of 8 frames.
   */
  const COIN = 900, TAP = 300, SEQ = [24, 37];
  let held = false, sp = 0, last = -1, idle = 0, presses = 0, was = false, b = null;
  const keys = (k) => {
    const f = b?.program.M.allegro.state.frames ?? 0;
    const down = (held && f === last) || (f < TAP && ((f >> 3) & 1) === 1);
    if (down && !was) presses++;
    was = down;
    if ((k === 6 && f >= COIN && f < COIN + 8) || (k === 2 && f >= COIN + 60 && f < COIN + 68) || (k === 29 && f >= COIN + 120 && (f & 8))) return 1;
    return down && k === SEQ[presses % 2] ? 1 : 0;
  };
  const t0 = Date.now();
  b = buildTarget(loadTarget(join(ROOT, 'targets', 'mame037b5.json')), {
    root: ROOT, compile: { safepoints: true },
    envExtra: { stdio: { files }, allegro39: { stopAfterFrames: +(frames ?? 1), keys } },
  });
  const buildSecs = (Date.now() - t0) / 1000;
  const { program } = b;
  const M = program.M;
  M.spBudget = 200000;
  M.sp_ = () => {
    M.spBudget = 200000;
    const f = M.allegro.state.frames;
    if (f === last) idle++; else { idle = 0; last = f; }
    held = idle > 2 && (++sp & 4) !== 0;
    M.allegro.refreshKeys();
  };
  M.allegro.bindGlobals(program);
  const snd = { writes: 0, nonSilent: 0 };
  const o = M.rt.AWriteAudioData;
  const w = (wave, off, n) => {
    snd.writes++;
    const d = program.mod.dv, data = d.getInt32(wave + 24, true) + (off >>> 0);
    const first = d.getInt16(data, true);
    for (let i = 0; i < (n >>> 0); i += 2) if (d.getInt16(data + i, true) !== first) { snd.nonSilent++; break; }
    return o(wave, off, n);
  };
  M.rt.AWriteAudioData = w; program.mod.bindFunc('AWriteAudioData', w);
  const report = {
    buildSecs, functions: Object.keys(program.F).length,
    failures: (program.failures ?? []).map((f) => `${f.fn}: ${f.message}`),
    unresolved: (program.undefined ?? []).map((u) => u.name),
  };
  if (game) {
    try { program.run(['mame', game, '-nodouble', '-soundcard', '1']); } catch (e) {
      if (!/__frames_done/.test(e.message)) report.error = e.message.split('\n')[0];
    }
    const s = M.allegro.state;
    const px = s.pixels && s.width ? M.u8.slice(s.pixels, s.pixels + s.width * s.height * (s.format === 32 ? 4 : 1)) : [];
    const colours = new Set();
    if (s.format === 32) for (let i = 0; i < px.length; i += 4) colours.add(px[i] | (px[i + 1] << 8) | (px[i + 2] << 16));
    else for (const p of px) colours.add(p);
    Object.assign(report, { frames: s.frames, width: s.width, height: s.height, colours: colours.size, sound: snd });
  }
  process.stdout.write(JSON.stringify(report) + '\n', () => process.exit(0));
  await new Promise(() => {});
}

// ---- the gate.
let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `\n       ${detail}` : ''}`);
  if (!ok) failed++;
};
if (!existsSync(join(ROOT, 'corpus/mame037b5/src')) || !existsSync(join(ROOT, 'corpus/mame037b5-generated')) || !existsSync(join(ROOT, 'corpus/zlib-1.1.3'))) {
  skip('MAME 0.37b5, its generated 68000 units or zlib 1.1.3 is not in corpus/ (see the fetch line of targets/mame037b5.json)');
}
const child = (...a) => {
  const r = spawnSync('node', ['--max-old-space-size=12000', SELF, '--child', ...a],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900000 });
  try { return JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { return { error: (r.stderr || r.stdout || '').slice(-400) }; }
};

const tgt = spawnSync('node', [join(ROOT, 'tools/mame037-target.mjs'), '--check'], { encoding: 'utf8' });
check(tgt.status === 0, 'targets/mame037b5.json is what the makefiles say', (tgt.stdout + tgt.stderr).trim());

// The nine functions that are not emitted, by name: a tenth, or a different one, is a regression.
const ASM_ONLY = ['unchained_flip', 'unchain_dword_blit', 'unchain_word_blit', 'unchain_byte_blit',
  'copyline_2x_8bpp', 'copyline_2x_16bpp', 'copyline_3x_16bpp', 'copyline_4x_16bpp', 'cpu_rdtsc'];
const roms = process.env.PRISM_MAME_ROMS;
const games = roms ? ['invaders', 'rastan'].filter((g) => existsSync(join(roms, `${g}.zip`))) : [];
const runs = games.length ? games.map((g) => [g, child(g, '2000')]) : [[null, child()]];
const built = runs[0][1];
check(!built.error && built.functions > 20000, `the whole program builds: ${built.functions} functions in ${built.buildSecs?.toFixed(0)} s`, built.error ?? '');
const notEmitted = (built.failures ?? []).map((f) => f.split(':')[0]).sort();
check(JSON.stringify(notEmitted) === JSON.stringify([...ASM_ONLY].sort()),
  `not emitted: exactly the ${ASM_ONLY.length} functions written in inline assembly`, `got: ${notEmitted.join(' ')}`);
const unresolved = built.unresolved ?? [];
check(unresolved.length === 39 && unresolved.every((n) => n.startsWith('asmblit_')),
  'unresolved: exactly the 39 routines of asmblit.asm', `got ${unresolved.length}: ${unresolved.filter((n) => !n.startsWith('asmblit_')).join(' ')}`);

if (games.length) {
  for (const [game, r] of runs) {
    check(!r.error && r.frames === 2000 && r.colours > 2 && r.sound?.nonSilent > 0,
      `SMOKE ${game}: ${r.frames} frames at ${r.width}x${r.height}, ${r.colours} colours on screen, ${r.sound?.nonSilent} of ${r.sound?.writes} audio writes not silent (starts; not a reference)`, r.error ?? '');
  }
  const none = child('nosuchgame', '10');
  check((none.frames ?? 0) === 0, 'SMOKE control: with the ROM set withheld no frame is presented', none.error ?? '');
} else {
  console.log('     (no PRISM_MAME_ROMS: the smoke runs are not made)');
}
console.log(failed ? `gate-mame037b5: ${failed} FAILED` : `gate-mame037b5: MAME 0.37b5 builds whole${games.length ? ` and ${games.length} games start` : ''}`);
process.exit(failed ? 1 : 0);
