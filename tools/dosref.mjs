// dosref.mjs — a real DOS program's screens, recorded under headless DOSBox-X, for the pixel gates.
//
// `DX-CAPTURE /V` records the EMULATED framebuffer (tools/zmbv.mjs reads it), so nothing is asked of
// the guest. On a `vgaonly` machine DOSBox-X records 32 bpp with every VGA pixel doubled both ways
// (mode 13h is 640x400, Jump 'n Bump's 400x256 is 800x512); `vgaScreens` reduces each frame to the
// guest's own resolution in six-bit r,g,b -- the DAC's width -- and ASSERTS the doubling rather than
// assuming it. Text-mode frames (720x400) are counted and left out, and so are TORN frames: DOSBox
// renders line by line, so a frame caught while the palette or the page changes can differ between
// the two lines of a pair. Those are never a screen a game holds; they are counted, not compared.
//
//   import { dbxRun, vgaScreens, vgaHash } from './dosref.mjs';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zmbvFrames } from './zmbv.mjs';

export const vgaHash = (c) => createHash('sha1').update(c).digest('hex').slice(0, 16);

/**
 * Run `command` in a copy of `dir` (files only) under DOSBox-X for `seconds`, `before` DOS commands
 * first (a date and time, say, for a program that seeds from the clock). Returns the capture files.
 */
export function dbxRun({ dir, command, seconds, machine = 'vgaonly', cycles = 'max', before = [] }) {
  const work = mkdtempSync(join(tmpdir(), 'dosref-'));
  mkdirSync(join(work, 'game')); mkdirSync(join(work, 'cap'));
  for (const f of readdirSync(dir)) if (statSync(join(dir, f)).isFile()) copyFileSync(join(dir, f), join(work, 'game', f));
  const r = spawnSync('dosbox-x', ['-silent', '-nogui', '-nomenu', '-time-limit', String(seconds),
    '-set', `dosbox captures=${join(work, 'cap')}`, '-set', `dosbox machine=${machine}`, '-set', `cpu cycles=${cycles}`,
    '-set', 'sblaster sbtype=none', '-set', 'speaker pcspeaker=false',
    '-c', `mount c "${join(work, 'game')}"`, '-c', 'c:', ...before.flatMap((c) => ['-c', c]),
    '-c', `dx-capture /v ${command}`, '-c', 'exit'],
  { encoding: 'utf8', env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  if (r.status !== 0) throw new Error(`dosbox-x: ${r.stderr}`);
  return readdirSync(join(work, 'cap')).filter((x) => x.endsWith('.avi')).sort().map((f) => join(work, 'cap', f));
}

/** Every graphics frame of the captures as `width` x `height` six-bit r,g,b, plus the text-frame count. */
export function* vgaScreens(files, width, height, stats = { frames: 0, text: 0, torn: 0 }) {
  stats.torn ??= 0;
  for (const f of files) {
    for (const fr of zmbvFrames(readFileSync(f))) {
      if (!fr.pix) continue;
      if (fr.width === 720 && fr.height === 400) { stats.text++; continue; }   // 9-dot text mode
      if (fr.bpp !== 32 || fr.width !== 2 * width || fr.height !== 2 * height) {
        throw new Error(`capture frame ${fr.width}x${fr.height}x${fr.bpp}, expected ${2 * width}x${2 * height}x32`);
      }
      const c = new Uint8Array(width * height * 3), W = 2 * width;
      let torn = false;
      for (let y = 0; y < height && !torn; y++) {
        for (let x = 0; x < width; x++) {
          const o = (2 * y * W + 2 * x) * 4;
          for (const q of [o + 4, o + W * 4, o + W * 4 + 4]) {
            if (fr.pix[q] !== fr.pix[o] || fr.pix[q + 1] !== fr.pix[o + 1] || fr.pix[q + 2] !== fr.pix[o + 2]) {
              torn = true;
            }
          }
          const i = (y * width + x) * 3;               // B G R X -> six-bit r g b
          c[i] = fr.pix[o + 2] >> 2; c[i + 1] = fr.pix[o + 1] >> 2; c[i + 2] = fr.pix[o] >> 2;
        }
      }
      if (torn) { stats.torn++; continue; }
      stats.frames++;
      yield c;
    }
  }
}

/** PRISM's side: `n` palette indices through a DAC palette (8-bit, as src/env/vgadac.js keeps it). */
export function sixBit(indexAt, n, palette) {
  const c = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = indexAt(i) * 3;
    c[3 * i] = palette[k] >> 2; c[3 * i + 1] = palette[k + 1] >> 2; c[3 * i + 2] = palette[k + 2] >> 2;
  }
  return c;
}
