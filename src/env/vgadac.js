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
 * The palette the VGA BIOS loads with mode 13h, as six-bit components: read back through 3C7h/3C9h
 * by a Borland C++ program that set the mode under DOSBox-X (the reference Wolf3D's pictures are held
 * to). The sixteen CGA colours, sixteen greys, then the hue table. A program that draws before it
 * loads a palette of its own -- Wolf3D's signon screen -- is coloured by these.
 */
export const BIOS_MODE13_DAC = Uint8Array.from(atob('AAAAAAAqACoAACoqKgAAKgAqKhUAKioqFRUVFRU/FT8VFT8/PxUVPxU/Pz8VPz8/AAAABQUFCAgICwsLDg4OERERFBQUGBgYHBwcICAgJCQkKCgoLS0tMjIyODg4Pz8/AAA/EAA/HwA/LwA/PwA/PwAvPwAfPwAQPwAAPxAAPx8APy8APz8ALz8AHz8AED8AAD8AAD8QAD8fAD8vAD8/AC8/AB8/ABA/Hx8/Jx8/Lx8/Nx8/Px8/Px83Px8vPx8nPx8fPycfPy8fPzcfPz8fNz8fLz8fJz8fHz8fHz8nHz8vHz83Hz8/Hzc/Hy8/Hyc/LS0/MS0/Ni0/Oi0/Py0/Py06Py02Py0xPy0tPzEtPzYtPzotPz8tOj8tNj8tMT8tLT8tLT8xLT82LT86LT8/LTo/LTY/LTE/AAAcBwAcDgAcFQAcHAAcHAAVHAAOHAAHHAAAHAcAHA4AHBUAHBwAFRwADhwABxwAABwAABwHABwOABwVABwcABUcAA4cAAccDg4cEQ4cFQ4cGA4cHA4cHA4YHA4VHA4RHA4OHBEOHBUOHBgOHBwOGBwOFRwOERwODhwODhwRDhwVDhwYDhwcDhgcDhUcDhEcFBQcFhQcGBQcGhQcHBQcHBQaHBQYHBQWHBQUHBYUHBgUHBoUHBwUGhwUGBwUFhwUFBwUFBwWFBwYFBwaFBwcFBocFBgcFBYcAAAQBAAQCAAQDAAQEAAQEAAMEAAIEAAEEAAAEAQAEAgAEAwAEBAADBAACBAABBAAABAAABAEABAIABAMABAQAAwQAAgQAAQQCAgQCggQDAgQDggQEAgQEAgOEAgMEAgKEAgIEAoIEAwIEA4IEBAIDhAIDBAIChAICBAICBAKCBAMCBAOCBAQCA4QCAwQCAoQCwsQDAsQDQsQDwsQEAsQEAsPEAsNEAsMEAsLEAwLEA0LEA8LEBALDxALDRALDBALCxALCxAMCxANCxAPCxAQCw8QCw0QCwwQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), (c) => c.charCodeAt(0));

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

  // What int 10h does to the DAC when it sets mode 13h (src/env/dos.js).
  const loadBios = () => { for (let i = 0; i < 768; i++) palette[i] = BIOS_MODE13_DAC[i] << 2; if (onChange) onChange(palette); };
  return { palette, loadBios };
}
