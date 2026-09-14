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
export function installVgaPlanar(machine, { onChange = null, onFrame = null, map = null, planes = 0 } = {}) {
  const state = {
    mapMask: 0x0f,        // all four planes, which is the reset value and what a clear uses
    readPlane: 0,
    chained: true,        // mode 13h until a program says otherwise
    planes,               // guest address of four 64 kB banks, then a fifth used as scratch
    scratchWrites: 0,
    frames: 0,            // how many times the program has presented a page
    start: 0,             // the CRTC start address, i.e. which page is visible
    /*
     * Read from `state` on every flip rather than closed over, so a harness that builds the target
     * first and decides what to do with frames second can still be told. build.mjs is exactly that.
     */
    onFrame: onFrame ?? null,
  };

  /*
   * SIXTY-FOUR KILOBYTES, not 128. The graphics window is A000:0000..A000:FFFF and a plane bank is
   * the same size; 0xB0000 upwards is the text window and has no business here. Redirecting 128 kB
   * into 64 kB banks meant an access past 0xB0000 landed in the NEXT PLANE's bank -- silently, and
   * only for a program that touched that range, which this one does not. Found by writing the
   * arithmetic down rather than by a failure.
   */
  const WINDOW = 0xa0000, WINDOW_LEN = 0x10000, BANK = 0x10000;
  const bank = (n) => planes + n * BANK;
  const SCRATCH = 4;

  /*
   * Push the current register state into the page map.
   *
   * CHAINED is the identity: with Chain-4 set the window is plain linear memory, which is mode 13h
   * and exactly what every other DOS target here already does. MAME's tweaked 256x256 lands in this
   * branch, so wiring this device changes nothing for it -- and the golden says so rather than this
   * comment.
   *
   * UNCHAINED splits: a read comes from the plane in Read Map Select, a write goes to the planes in
   * Map Mask. Those are two different answers for one address, which is why the map has two tables.
   *
   * THE CASE A TABLE CANNOT EXPRESS is a Map Mask with more than one bit. Refusing when the REGISTER
   * is set would be wrong -- the game writes 0x0f legitimately, before clearing 64 kB through
   * memset -- so the refusal has to attach to the byte write, which a silent translation cannot
   * intercept. What happens instead: writes go to a scratch bank nobody displays, and they are
   * COUNTED. A fill through the runtime's memset can fan out properly once that is wired; an
   * emitted byte write under such a mask is lost, and `scratchWrites` is how it stops being silent.
   */
  const apply = () => {
    if (!map || !planes) return;
    if (state.chained) { map.identity(WINDOW, WINDOW_LEN); return; }
    map.redirect(WINDOW, WINDOW_LEN, bank(state.readPlane), { how: 'r', who: 'vga' });
    const single = [1, 2, 4, 8].indexOf(state.mapMask & 0x0f);
    map.redirect(WINDOW, WINDOW_LEN, bank(single >= 0 ? single : SCRATCH), { how: 'w', who: 'vga' });
    state.unexpressible = single < 0 ? (state.mapMask & 0x0f) : 0;

    /*
     * AND THE ANSWER A TRANSLATION CANNOT GIVE. A block write under a multi-plane mask has to reach
     * every masked plane, which one translated address cannot say -- but memset and memcpy are
     * runtime functions and can simply write the bytes several times. This is where the game's own
     * `memset(ptr1, 0, 65535)` after Map Mask 0x0f goes: four spans, one per plane.
     *
     * Only for the window. Anything else falls through to the map's own answer.
     */
    map.setSpanner((addr, len) => {
      if (state.chained) return null;
      if (addr + len <= WINDOW || addr >= WINDOW + WINDOW_LEN) return null;
      // `from: 0` for every plane: a fan-out gives each destination the SAME bytes, where a page
      // split gives each a successive slice. That distinction is the map's `from` field.
      const spans = [];
      for (let p = 0; p < 4; p++) {
        if (!(state.mapMask & (1 << p))) continue;
        spans.push({ to: bank(p) + (addr - WINDOW), from: 0, len });
      }
      return spans.length ? spans : [{ to: bank(SCRATCH) + (addr - WINDOW), from: 0, len }];
    });
  };
  state.apply = apply;

  // Sequencer and Graphics Controller both work as index-then-data, and both accept the word form.
  let seqIndex = 0, gcIndex = 0;

  const seqData = (v) => {
    if (seqIndex === 2) { state.mapMask = v & 0x0f; apply(); }
    else if (seqIndex === 4) {
      const chained = (v & CHAIN4) !== 0;
      if (chained !== state.chained) {
        state.chained = chained;
        apply();
        if (onChange) onChange(state);
      }
    }
  };
  const gcData = (v) => { if (gcIndex === 4) { state.readPlane = v & 3; apply(); } };

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

  /*
   * THE CRTC, for two things only: where the visible page starts, and how big it is.
   *
   * THE FRAME BOUNDARY IS THE PROGRAM'S OWN ACT OF PRESENTING. main.c flips pages by writing the
   * start address -- index 0x0D then 0x0C, with the page number shifted in -- and that instant, when
   * a freshly drawn page becomes the visible one, is this host's BitBlt. It is read out of the
   * game's source rather than invented: there was no boundary for a planar target before, so a run
   * could never reach its frame count and never stopped.
   *
   * Firing on 0x0C because this program writes 0x0D first and 0x0C second, so 0x0C completes the
   * pair. A program writing them the other way round would need the rule stated differently, and
   * that is worth knowing rather than papering over.
   *
   * THE GEOMETRY IS READ, NOT ASSUMED. The Offset register (0x13) is bytes-per-row in units of two
   * per plane: the game writes 0x32, so 100 bytes a row and 400 pixels across -- the same 100 the
   * assembly adds. Height comes from Vertical Display End (0x12 plus two bits of the 0x07 overflow)
   * divided by the character height in 0x09: 512 scanlines over 2 gives 256 rows.
   */
  let crtIndex = 0;
  const crt = new Uint8Array(0x40);
  const crtData = (v) => {
    crt[crtIndex & 0x3f] = v & 0xff;
    if (crtIndex === 0x0c || crtIndex === 0x0d) {
      state.start = ((crt[0x0c] << 8) | crt[0x0d]) >>> 0;
      if (crtIndex === 0x0c) { state.frames++; if (state.onFrame) state.onFrame(state); }
    }
  };
  machine.onPortWrite(0x3d4, (p, size, v) => {
    crtIndex = v & 0xff;
    if (size === 2) crtData((v >> 8) & 0xff);
  });
  machine.onPortWrite(0x3d5, (p, size, v) => crtData(v & 0xff));
  machine.onPortRead(0x3d5, () => crt[crtIndex & 0x3f]);

  /** Width and height as the registers state them, for a host that has to show the picture. */
  state.geometry = () => {
    const rowBytes = (crt[0x13] || 50) * 2;                    // per plane
    const vde = crt[0x12] | ((crt[0x07] & 0x02) << 7) | ((crt[0x07] & 0x40) << 3);
    const charHeight = (crt[0x09] & 0x1f) + 1;
    return { width: rowBytes * 4, height: Math.max(1, Math.floor((vde + 1) / charHeight)), rowBytes };
  };

  machine.onPortRead(0x3c5, () => (seqIndex === 2 ? state.mapMask
    : seqIndex === 4 ? (state.chained ? CHAIN4 | 0x06 : 0x06) : 0));
  machine.onPortRead(0x3cf, () => (gcIndex === 4 ? state.readPlane : 0));

  machine.vga = state;
  return state;
}
