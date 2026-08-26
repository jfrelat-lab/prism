// vgadac.js — the VGA colour DAC, ports 0x3C6..0x3C9.
//
// The second device PRISM needs, and like the retrace register it is small because the hardware is
// small: a 256-entry palette written three bytes at a time through an auto-incrementing index.
//
//   0x3C8  write the index of the entry to be written next
//   0x3C9  write red, then green, then blue; after the third the index advances
//   0x3C7  write the index of the entry to be READ next
//   0x3C6  the pixel mask, 0xFF in every mode these games use
//
// The components are SIX bits, which is the DAC's real width -- Heretic writes 63 for full
// brightness, not 255. They are scaled to eight here by `<< 2` rather than by `* 255 / 63`, because
// that is what the hardware does with the two low bits.
//
// This is device emulation rather than shimming, and it is worth saying why it is acceptable: the
// program is not calling a library that could have been implemented differently, it is writing to
// a register in a documented order. There is nothing to interpret.

/**
 * Install the DAC.
 *
 * `onChange` fires when a write completes an entry, so a host can publish the palette without
 * polling for it. `palette` is 768 bytes of r,g,b at 8-bit width, the same layout every other
 * platform layer here publishes.
 */
export function installVgaDac(machine, { onChange = null } = {}) {
  const palette = new Uint8Array(768);
  let writeIndex = 0, readIndex = 0, phase = 0;
  let mask = 0xff;

  machine.onPortWrite(0x3c8, (p, size, v) => { writeIndex = v & 0xff; phase = 0; });
  machine.onPortWrite(0x3c7, (p, size, v) => { readIndex = v & 0xff; phase = 0; });
  machine.onPortWrite(0x3c6, (p, size, v) => { mask = v & 0xff; });

  machine.onPortWrite(0x3c9, (p, size, v) => {
    palette[writeIndex * 3 + phase] = (v & 0x3f) << 2;      // six bits, as the DAC really is
    if (++phase === 3) {
      phase = 0;
      writeIndex = (writeIndex + 1) & 0xff;                 // auto-increment, which is the whole API
      if (onChange) onChange(palette);
    }
  });

  machine.onPortRead(0x3c9, () => {
    const v = palette[readIndex * 3 + phase] >> 2;
    if (++phase === 3) { phase = 0; readIndex = (readIndex + 1) & 0xff; }
    return v;
  });
  machine.onPortRead(0x3c6, () => mask);

  return { palette };
}
