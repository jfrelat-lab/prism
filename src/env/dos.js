// dos.js — the DOS and BIOS services a real-mode program asks for with `int n`, for the machine PRISM
// actually is: a VGA, no EMS, no mouse driver, a keyboard fed by the harness, and files from stdio's
// store.
//
// src/env/borland.js dispatches `int n` (inline assembly, geninterrupt, the TASM modules through
// src/asm/tasm-link.js) to the handler the program installed, else to M.pcServices[n], which this
// file fills. A register file is { ax, bx, cx, dx, si, di, bp, ds, es, cf, zf, ... }; a service reads
// and writes it as the real one does. EVERY function not written here is refused by name -- vector,
// AH and AL -- because an invented answer is a wrong answer nobody sees.
//
// FILES ARE STDIO'S. `int 21h` open/read/close work on the same handles as the C library's open()
// and fopen(): Keen Dreams opens KDREAMS.EGA with open() and reads it with `int 21h` AH=3Fh from
// assembly (CA_FarRead), so the two must be one table. Under a 16-bit model stdio numbers those
// handles as DOS does (env/stdio.js), which is what lets BX carry one.
//
// THE ANSWERS ARE THE MACHINE'S, chosen once: DOS 5.0; a VGA with a colour display (what DOSBox, the
// oracle this project runs Borland programs on, reports); no EMS, so opening the EMMXXXX0 device
// fails like any missing file; no mouse driver (int 33h AX=0 returns AX=0).

const hex = (n, w = 2) => (n >>> 0).toString(16).toUpperCase().padStart(w, '0');

export function installDos(M, { keys = [] } = {}) {
  const u8 = () => M.mod.u8;
  const lin = (seg, off) => ((seg & 0xffff) << 4) + (off & 0xffff);
  const refuse = (n, r) => {
    throw new Error(`int ${hex(n)}h AH=${hex(r.ax >>> 8)}h AL=${hex(r.ax & 255)}h: this DOS/BIOS service is not implemented`);
  };
  const ok = (r) => { r.cf = 0; };
  const err = (r, code) => { r.ax = code; r.cf = 1; };
  const cstr = (a) => { let s = ''; for (let k = 0; u8()[a + k]; k++) s += String.fromCharCode(u8()[a + k]); return s; };
  const video = M.video ??= { mode: 3, palette: new Array(17).fill(0), cursor: { page: 0, row: 0, col: 0 } };
  const keyQueue = M.keyQueue ??= [...keys];      // BIOS keys: (scancode << 8) | ascii

  // --- int 21h, over stdio's handles
  const std = { 0: 'stdin', 1: 'stdout', 2: 'stderr' };
  const handleOK = (h) => M.files?.isOpen?.(h) ?? true;
  const int21 = (r) => {
    const ah = r.ax >>> 8, al = r.ax & 255;
    switch (ah) {
      case 0x2c: {          // get time: CH hours, CL minutes, DH seconds, DL hundredths
        const now = M.rt.time(0), d = new Date((now + M.utcOffset(now)) * 1000);   // DOS keeps local time
        r.cx = (d.getUTCHours() << 8) | d.getUTCMinutes();
        r.dx = d.getUTCSeconds() << 8;
        return;
      }
      case 0x30: r.ax = 0x0005; r.bx = 0; r.cx = 0; return;     // DOS 5.0
      case 0x3d: {          // open: DS:DX name, AL access
        const name = cstr(lin(r.ds, r.dx));
        const mode = (al & 3) === 0 ? 'rb' : 'r+b';
        const h = M.rt.fopen(M.mod.intern([...name].map((c) => c.charCodeAt(0)).concat(0)), M.mod.intern([...mode].map((c) => c.charCodeAt(0)).concat(0)));
        if (!h) return err(r, 2);                              // file not found
        r.ax = h; return ok(r);
      }
      case 0x3e:            // close BX
        if (std[r.bx] !== undefined) return ok(r);
        M.rt.fclose(r.bx); return ok(r);
      case 0x3f: {          // read BX, CX bytes, to DS:DX
        const got = M.rt.read(r.bx, lin(r.ds, r.dx), r.cx);
        if (got < 0) return err(r, 6);
        r.ax = got; return ok(r);
      }
      case 0x40: {          // write BX, CX bytes, from DS:DX
        const n = M.rt.write(r.bx, lin(r.ds, r.dx), r.cx);
        if (n < 0) return err(r, 6);
        r.ax = n; return ok(r);
      }
      case 0x42: {          // lseek BX, AL whence, CX:DX offset -> DX:AX
        const p = M.rt.lseek(r.bx, ((r.cx << 16) | r.dx) | 0, al);
        if (p < 0) return err(r, 6);
        r.ax = p & 0xffff; r.dx = (p >>> 16) & 0xffff; return ok(r);
      }
      case 0x44:
        if (al === 0) {     // IOCTL: device information
          if (std[r.bx] !== undefined) { r.dx = 0x80d3; return ok(r); }   // CON: a character device
          if (!handleOK(r.bx)) return err(r, 6);
          r.dx = 0x0002; return ok(r);                         // a disk file on drive C
        }
        if (al === 7) { r.ax = (r.ax & 0xff00) | 0xff; return ok(r); }   // output status: ready
        return refuse(0x21, r);
      default: return refuse(0x21, r);
    }
  };

  // --- int 10h, the video BIOS of a VGA
  const int10 = (r) => {
    const ah = r.ax >>> 8, al = r.ax & 255;
    switch (ah) {
      case 0x00: video.mode = al & 0x7f; M.ega?.setMode(al & 0x7f, !(al & 0x80)); return;
      case 0x02: video.cursor = { page: r.bx >>> 8, row: r.dx >>> 8, col: r.dx & 255 }; return;
      case 0x03: { const c = video.cursor ?? { row: 0, col: 0 }; r.dx = (c.row << 8) | c.col; r.cx = 0x0607; return; }
      case 0x0f: r.ax = ((video.mode === 0x0d || video.mode === 0x04 || video.mode === 0x05 || video.mode === 0x01 || video.mode === 0x00 ? 40 : 80) << 8) | video.mode;
        r.bx = r.bx & 0x00ff; return;
      case 0x10:
        // The attribute controller's palette: sixteen registers and the overscan (the EGA's own, when
        // the ega environment is installed, which is what its frames are coloured by).
        if (al === 0x00) { video.palette[r.bx & 15] = (r.bx >>> 8) & 0x3f; if (M.ega) M.ega.attr[r.bx & 15] = (r.bx >>> 8) & 0x3f; return; }
        if (al === 0x01) { video.palette[16] = (r.bx >>> 8) & 0x3f; if (M.ega) M.ega.attr[0x11] = (r.bx >>> 8) & 0x3f; return; }
        if (al === 0x02) {
          for (let k = 0; k < 17; k++) video.palette[k] = u8()[lin(r.es, r.dx) + k] & 0x3f;
          if (M.ega) { for (let k = 0; k < 16; k++) M.ega.attr[k] = video.palette[k]; M.ega.attr[0x11] = video.palette[16]; }
          return;
        }
        if (al === 0x03) return;          // blink/intensity: nothing a graphics frame shows
        return refuse(0x10, r);
      case 0x12:
        if ((r.bx & 255) === 0x10) { r.bx = 0x0003; r.cx = 0x0009; return; }   // colour, 256K, switches 9
        return refuse(0x10, r);
      case 0x1a:
        if (al === 0) { r.ax = (r.ax & 0xff00) | 0x1a; r.bx = 0x0008; return; } // VGA, colour display
        return refuse(0x10, r);
      default: return refuse(0x10, r);
    }
  };

  // --- int 16h, the keyboard BIOS, fed from the harness's queue
  const int16 = (r) => {
    const ah = r.ax >>> 8;
    if (ah === 0x00 || ah === 0x10) {
      if (!keyQueue.length) throw new Error('int 16h: the program waits for a key and the harness queued none');
      r.ax = keyQueue.shift() & 0xffff; return;
    }
    if (ah === 0x01 || ah === 0x11) {
      if (keyQueue.length) { r.ax = keyQueue[0] & 0xffff; r.zf = 0; } else r.zf = 1;
      return;
    }
    if (ah === 0x02) { r.ax = (r.ax & 0xff00) | u8()[0x417]; return; }
    return refuse(0x16, r);
  };

  // --- int 33h, the mouse driver this machine does not have
  const int33 = (r) => { if (r.ax === 0) return; refuse(0x33, r); };

  M.pcServices = { 0x10: int10, 0x16: int16, 0x21: int21, 0x33: int33 };
  return { video, keyQueue };
}
