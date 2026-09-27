// ega.js — the EGA's graphics, as a real-mode program drives it: four 64 KB planes behind the A000h
// window, the latches every read loads, and the graphics controller's write path.
//
// What an access to A000h means is not what memory means, and Keen Dreams uses nearly all of it:
//   read            loads all four latches; read mode 0 returns the Read Map Select plane, read
//                   mode 1 the colour-compare bits;
//   write mode 0    the CPU byte, rotated, or the Set/Reset colour where Enable Set/Reset says so,
//                   combined with the latch by the logical function (replace/AND/OR/XOR), then the
//                   Bit Mask keeps latch bits where it is clear;
//   write mode 1    the latches themselves -- the four-plane copy VW_ScreenToScreen and the tile
//                   cache rely on;
//   write mode 2    the CPU byte's low four bits as a colour, one bit per plane (VW_Plot);
//   Map Mask        which planes a write reaches (sequencer index 2).
// The CRTC's start address and offset say which part of the planes is on screen; the attribute
// controller's sixteen palette registers and pel panning say how it looks. That is also what
// frame() reads to make an image.
//
// PRISM routes every access to the window here (src/backend/emit.js setWindow, the TASM machine's
// rb/wb, the runtime's block copies), so a program's C, its inline assembly and its TASM modules
// all meet one device. src/env/dos.js's int 10h sets modes and palettes through it.
//
// The oracle is DOSBox's EGA (tools/gate-ega.mjs): a Borland program drives the registers, reads
// every plane back, and PRISM must print the same bytes.

const WINDOW = 0xa0000, PLANE = 0x10000;
// The EGA's power-on palette for 16-colour modes: 0-7, then 38h-3Fh.
const DEFAULT_PALETTE = [0, 1, 2, 3, 4, 5, 0x14, 7, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f];

/** An EGA 6-bit colour (rgbRGB) as RGB bytes. */
export function egaRgb(c) {
  const lvl = (hi, lo) => ((c >> hi) & 1) * 0xaa + ((c >> lo) & 1) * 0x55;
  return [lvl(2, 5), lvl(1, 4), lvl(0, 3)];
}

export function installEga(M) {
  const machine = M.machine;
  if (!machine) throw new Error('ega: no port seam (installPorts) on this machine');
  const planes = [0, 1, 2, 3].map(() => new Uint8Array(PLANE));
  const latch = new Uint8Array(4);
  const seq = new Uint8Array(8), gc = new Uint8Array(9), crtc = new Uint8Array(32), attr = new Uint8Array(21);
  const ports = { seqIndex: 0, gcIndex: 0, crtcIndex: 0, attrIndex: 0, attrFlip: false };
  let mode = 3;

  const setMode = (m, clear = true) => {
    mode = m & 0x7f;
    seq.fill(0); gc.fill(0); crtc.fill(0); attr.fill(0);
    seq[2] = 0x0f;                     // all planes
    gc[8] = 0xff;                      // every bit
    DEFAULT_PALETTE.forEach((v, k) => { attr[k] = v; });
    attr[0x12] = 0x0f;
    crtc[0x13] = mode === 0x0d ? 20 : 40;   // words per line: 320 pixels, or 80 text columns
    if (clear) for (const p of planes) p.fill(0);
  };
  setMode(3, false);

  // --- the ports, byte-wide or word-wide (index in the low byte, data in the high)
  const indexed = (idxPort, dataPort, regs, key) => {
    machine.onPortWrite(idxPort, (_p, size, v) => {
      ports[key] = v & 0xff;
      if (size === 2) regs[ports[key] % regs.length] = (v >>> 8) & 0xff;
    });
    machine.onPortWrite(dataPort, (_p, _s, v) => { regs[ports[key] % regs.length] = v & 0xff; });
    machine.onPortRead(dataPort, () => regs[ports[key] % regs.length]);
    machine.onPortRead(idxPort, () => ports[key]);
  };
  indexed(0x3c4, 0x3c5, seq, 'seqIndex');
  indexed(0x3ce, 0x3cf, gc, 'gcIndex');
  indexed(0x3d4, 0x3d5, crtc, 'crtcIndex');
  // The attribute controller: one port, alternating index and data; reading 3DAh resets it to index.
  machine.onPortWrite(0x3c0, (_p, _s, v) => {
    v &= 0xff;
    if (!ports.attrFlip) ports.attrIndex = v & 0x1f;
    else if (ports.attrIndex < attr.length) attr[ports.attrIndex] = v;
    ports.attrFlip = !ports.attrFlip;
  });

  const alu = (d, l) => {
    switch ((gc[3] >> 3) & 3) {
      case 1: return d & l;
      case 2: return d | l;
      case 3: return d ^ l;
      default: return d;
    }
  };
  const rotate = (v) => { const r = gc[3] & 7; return ((v >>> r) | (v << (8 - r))) & 0xff; };

  const win = {
    r8(a) {
      const off = a - WINDOW;
      for (let p = 0; p < 4; p++) latch[p] = planes[p][off];
      if (gc[5] & 8) {                   // read mode 1: colour compare
        let diff = 0;
        for (let p = 0; p < 4; p++) {
          if (!((gc[7] >> p) & 1)) continue;
          diff |= latch[p] ^ (((gc[2] >> p) & 1) ? 0xff : 0);
        }
        return (~diff) & 0xff;
      }
      return latch[gc[4] & 3];
    },
    w8(a, v) {
      const off = a - WINDOW;
      const wm = gc[5] & 3, mask = gc[8], mapMask = seq[2];
      for (let p = 0; p < 4; p++) {
        if (!((mapMask >> p) & 1)) continue;
        const l = latch[p];
        let d;
        if (wm === 1) d = l;
        else if (wm === 2) d = (alu(((v >> p) & 1) ? 0xff : 0, l) & mask) | (l & ~mask);
        else if (wm === 3) {
          const m = rotate(v) & mask;
          d = ((((gc[0] >> p) & 1) ? 0xff : 0) & m) | (l & ~m);
        } else {
          const src = ((gc[1] >> p) & 1) ? (((gc[0] >> p) & 1) ? 0xff : 0) : rotate(v);
          d = (alu(src, l) & mask) | (l & ~mask);
        }
        planes[p][off] = d & 0xff;
      }
    },
  };

  const ega = {
    planes, latch, seq, gc, crtc, attr,
    get mode() { return mode; },
    setMode,
    resetFlipFlop() { ports.attrFlip = false; },
    /**
     * The visible picture of mode 0Dh as PALETTE INDICES, 0-15 after the colour-plane enable, with
     * the 16 attribute-palette entries as RGB bytes -- start address, line offset and pel panning
     * applied. `into` receives the pixels when given (a host's display buffer), so a frame costs no
     * allocation.
     */
    indexed(into = null) {
      if (mode !== 0x0d) return null;
      const width = 320, height = 200;
      const pix = into ?? new Uint8Array(width * height);
      const start = (crtc[0x0c] << 8) | crtc[0x0d];
      const pitch = crtc[0x13] * 2;
      const pel = attr[0x13] & 7, enable = attr[0x12];
      for (let y = 0; y < height; y++) {
        const line = start + y * pitch;
        for (let x = 0; x < width; x++) {
          const bitpos = x + pel;
          const off = (line + (bitpos >> 3)) & 0xffff, bit = 7 - (bitpos & 7);
          let c = 0;
          for (let p = 0; p < 4; p++) c |= ((planes[p][off] >> bit) & 1) << p;
          pix[y * width + x] = c & enable;
        }
      }
      const palette = [...attr.slice(0, 16)].map(egaRgb);
      return { width, height, pix, palette };
    },
    /** The same picture as RGBA. */
    frame() {
      const f = this.indexed();
      if (!f) return null;
      const rgba = new Uint8Array(f.width * f.height * 4);
      for (let i = 0; i < f.pix.length; i++) {
        const [r, g, b] = f.palette[f.pix[i]];
        rgba[4 * i] = r; rgba[4 * i + 1] = g; rgba[4 * i + 2] = b; rgba[4 * i + 3] = 255;
      }
      return { width: f.width, height: f.height, rgba };
    },
  };
  M.win = win;
  M.ega = ega;
  return ega;
}
