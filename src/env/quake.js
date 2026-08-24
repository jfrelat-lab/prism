// quake.js — the platform layer for Quake, which is almost nothing.
//
// Quake ships `vid_null.c` for exactly this situation, and it is more useful than its name suggests:
// it declares a real `byte vid_buffer[320*200]` and points `vid.buffer` at it, so the software
// renderer draws a complete frame into ordinary memory whether or not anything displays it. Quake
// also loads its own 768-byte palette and counts its own frames.
//
// So this layer implements no functions at all. It looks three symbols up in the linked image and
// publishes their addresses; the page then reads the pixels, the palette and the frame counter
// straight out of guest memory. Compare src/env/osd.js, which had to supply eighteen functions
// because MAME's platform boundary is a set of callbacks rather than a buffer.
//
// The addresses are stable for the life of the program: `vid_buffer` is a static array, and
// `host_basepal` is allocated once during Host_Init from a hunk that is never freed.

import { SLOT } from './webhost.js';

const WIDTH = 320, HEIGHT = 200;      // vid_null.c's BASEWIDTH x BASEHEIGHT

export function installQuake(M, { publish = null } = {}) {
  const sym = (name) => M.mod.symbols.get(name) ?? null;

  const buffer = sym('vid_buffer');
  const basepal = sym('host_basepal');
  const framecount = sym('host_framecount');

  const missing = [];
  if (!buffer) missing.push('vid_buffer');
  if (!basepal) missing.push('host_basepal');
  if (missing.length) {
    throw new Error(`Quake platform layer: ${missing.join(', ')} not in the linked image — ` +
      `is this build using vid_null.c?`);
  }

  if (publish) {
    const { ctrl } = publish;
    Atomics.store(ctrl, SLOT.WIDTH, WIDTH);
    Atomics.store(ctrl, SLOT.HEIGHT, HEIGHT);
    // host_basepal is a POINTER to the palette, not the palette, so the page dereferences it once.
    Atomics.store(ctrl, SLOT.PAL_ADDR, basepal.addr);
    Atomics.store(ctrl, SLOT.PAL_INDIRECT, 1);
    if (framecount) Atomics.store(ctrl, SLOT.FRAME_ADDR, framecount.addr);
    // PIXELS last: a non-zero PIXELS is what tells the page the geometry above is valid.
    Atomics.store(ctrl, SLOT.PIXELS, buffer.addr);
    Atomics.store(ctrl, SLOT.TEXTMODE, 0);
  }

  return { width: WIDTH, height: HEIGHT, pixels: buffer.addr, palette: basepal.addr };
}
