// vgaplanar.js — the VGA's PLANE logic: what a byte written to 0xA0000 actually lands on.
//
// This is P3.5, and it is the first thing in the corpus that needs a video register to MEAN
// something. Every other DOS program here writes a linear surface and the host reads it back:
// src/env/allegro.js records that MAME needed no register emulation at all, because both its
// display paths end in _dosmemputl and the geometry comes from the game's own `bitmap` global.
//
// THE ONE BIT THAT SEPARATES THE TWO FAMILIES, measured on both programs rather than assumed:
//
//   MAME 0.5, msdos.c      { 0x3c4, 0x04, 0x0e }      Chain-4 SET   -> linear, like mode 13h
//   Jump 'n Bump, gfx.c    outportw(0x3c4, 0x0604)    Chain-4 CLEAR -> planar, four planes
//
// Both start from BIOS mode 13h, unlock CRTC index 0x11 and pour in a register table to reach a
// geometry the BIOS does not offer -- 256x256 for MAME, 400x256 here. Same technique, same register
// file, same era. But MAME's tweak changes the TIMING, so an address still means what it meant;
// Jump 'n Bump's changes what an ADDRESS MEANS, and that cannot be ignored.
//
// WHAT THIS FILE IS NOT. It is not a CRTC emulator. The 400x256 geometry is recoverable from what
// the program itself writes -- the same "publish what the program already writes" move the other
// hosts make -- so the CRTC table stays ignored exactly as it is for MAME today. Three registers
// decide everything that matters here:
//
//   0x3C4/0x3C5 index 2   Map Mask          which planes a WRITE touches
//   0x3C4/0x3C5 index 4   Memory Mode       bit 3 = Chain-4: linear when set, planar when clear
//   0x3CE/0x3CF index 4   Read Map Select   which plane a READ returns
//
// Read Map Select is the single `out` in the game's own assembly, which is a good sign that the
// list is complete rather than convenient.
//
// BOTH FORMS OF WRITE ARE HANDLED, because the program uses both. `outportw(0x3c4, 0x0604)` is one
// 16-bit write carrying index in the low byte and data in the high byte; `outportb(0x3d4, 0x11)`
// then `outportb(0x3d5, ...)` is the two-step form. A decoder that took only the pair would see
// none of Jump 'n Bump's mode setup, and one that took only the word would miss the CRTC unlock.

/** Sequencer index 4, bit 3. Set = chained (linear); clear = unchained (planar). */
const CHAIN4 = 0x08;

/**
 * Install the plane logic on the port seam.
 *
 * The planes themselves are 4 x 64 kB. Nothing writes them yet: a store to the 0xA0000 window is a
 * plain DataView call in the emitted JavaScript, so routing it here needs a write barrier the
 * compiler emits, and that is a compile option rather than something this file can reach. See
 * src/env/ports.js, which named the asymmetry before either half existed.
 */
export function installVgaPlanar(machine, { onChange = null } = {}) {
  const planes = [0, 1, 2, 3].map(() => new Uint8Array(0x10000));
  const state = {
    mapMask: 0x0f,        // all four planes, which is the reset value and what a clear uses
    readPlane: 0,
    chained: true,        // mode 13h until a program says otherwise
    planes,
  };

  // Sequencer and Graphics Controller both work as index-then-data, and both accept the word form.
  let seqIndex = 0, gcIndex = 0;

  const seqData = (v) => {
    if (seqIndex === 2) state.mapMask = v & 0x0f;
    else if (seqIndex === 4) {
      const chained = (v & CHAIN4) !== 0;
      if (chained !== state.chained) {
        state.chained = chained;
        if (onChange) onChange(state);
      }
    }
  };
  const gcData = (v) => { if (gcIndex === 4) state.readPlane = v & 3; };

  machine.onPortWrite(0x3c4, (p, size, v) => {
    seqIndex = v & 0xff;
    if (size === 2) seqData((v >> 8) & 0xff);          // index low, data high
  });
  machine.onPortWrite(0x3c5, (p, size, v) => seqData(v & 0xff));

  machine.onPortWrite(0x3ce, (p, size, v) => {
    gcIndex = v & 0xff;
    if (size === 2) gcData((v >> 8) & 0xff);
  });
  machine.onPortWrite(0x3cf, (p, size, v) => gcData(v & 0xff));

  machine.onPortRead(0x3c5, () => (seqIndex === 2 ? state.mapMask
    : seqIndex === 4 ? (state.chained ? CHAIN4 | 0x06 : 0x06) : 0));
  machine.onPortRead(0x3cf, () => (gcIndex === 4 ? state.readPlane : 0));

  machine.vga = state;
  return state;
}
