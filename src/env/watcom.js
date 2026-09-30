// watcom.js — the DOS platform a Watcom/DOS4GW program expects, shimmed at the library boundary.
//
// Heretic and Hexen keep their whole machine dependence in `I_IBM.C`, the way MAME keeps its in
// `msdos.c` — and that file is compiled unmodified. What is shimmed is one level down: the Watcom
// runtime calls it makes, and the two hardware registers it reads directly.
//
// The surface is measured, not anticipated. `I_IBM.C` is 2,204 lines and this is everything in it
// that leaves the program:
//
//   int386 / int386x / segread   BIOS and DPMI, through a `union REGS`
//   _dos_setvect / _dos_getvect  the keyboard and timer interrupt vectors
//   _dpmi_lockregion / unlock    page locking, meaningless without paging
//   _settextposition, _outtext   the text-mode banner (graph.h)
//   inp / outp                   0x3DA, 0x201, and the VGA sequencer/graphics indices
//
// Two things this does NOT need, both checked before writing a line:
//
//  * **No VGA mode emulation.** `int386(0x10, ax=0x13)` is answered by recording the mode, and the
//    very next line of the game is `pcscreen = destscreen = (byte *)0xa0000` — a FLAT pointer into
//    memory PRISM already has, because the low megabyte is part of the image. Everything the game
//    draws is an ordinary store. The sequencer and graphics-controller writes are page-flip
//    plumbing for a mode this host does not emulate, and swallowing them changes nothing the host
//    reads: the geometry comes from the game's own `screenwidth`/`SCREENHEIGHT`.
//  * **No interrupt delivery, yet.** `_dos_setvect(KEYBOARDINT, isr)` hands over a function pointer,
//    and PRISM can call it — that is what makes an interrupt deliverable here at all. See
//    `deliverKeyboard` below.

import { SLOT } from './webhost.js';

/*
 * Watcom's `union REGS`, in the layout src/env/headers-watcom.js declares. A 32-bit REGS is three
 * views of the same sixteen bytes -- `x.eax`, `w.ax`, `h.al`/`h.ah` -- and the program uses all
 * three, so they are offsets into one buffer rather than three structs.
 *
 *   x:  eax ebx ecx edx esi edi cflag       (7 x 4 bytes)
 *   w:  ax  bx  cx  dx  si  di  cflag       (the low half of each)
 *   h:  al ah bl bh cl ch dl dh             (the two low bytes of each of the first four)
 */
const R_EAX = 0, R_EBX = 4, R_ECX = 8, R_EDX = 12, R_ESI = 16, R_EDI = 20, R_CFLAG = 24;

/*
 * Watcom's DOS clock(), measured with Open Watcom's own libc under DOSBox-X: CLOCKS_PER_SEC is 1000,
 * it starts at 0, and it steps by the BIOS tick -- 55, 110, 165, ... 439 (54 ms there), 494 --
 * i.e. round(ticks * 54.9254), a tick being 65536 PIT periods. A program that times itself with it
 * sees time move in lumps of ~55 ms; OpenDUNE's Timer_InterruptRun runs its "callonce" timers at
 * most once per lump, so a finer clock ran its intro's animations fast and cut them short.
 */
const BIOS_TICK_US = 65536 / 1193182 * 1e6;
export const watcomClock = (us) => Math.round(Math.floor(us / BIOS_TICK_US) * (BIOS_TICK_US / 1000));

export function installWatcom(M, {
  publish = null,
  keys = () => 0,            // scan code -> held?
  onPresent = null,
  stopAfterFrames = 0,
} = {}) {
  M.clockOf = watcomClock;
  const mod = M.mod;
  const dv = () => mod.dv;

  const state = {
    mode: null,              // the last BIOS video mode set
    width: 320, height: 200,
    pixels: 0xa0000,
    palette: new Uint8Array(768),
    pens: 0,
    frames: 0,
    vectors: new Map(),      // interrupt number -> the guest function pointer installed for it
    text: [],                // what the program wrote through graph.h, for a harness to read
    retrace: 0,
    services: [],            // TSM timer services registered but not yet driven
    ticks: 0,                // timer interrupts delivered
    keys: 0,                 // keyboard interrupts delivered
    // The mouse driver's state, as INT 33h sets it. `handler` is recorded rather than installed --
    // a recorded handler is one this host can CALL. See deliverMouse.
    mouse: { handler: 0, mask: 0, x: 0, y: 0, minX: 0, maxX: 319, minY: 0, maxY: 199, buttons: 0 },
  };
  M.watcom = state;

  /** Read the six general registers out of a `union REGS`. */
  const getRegs = (p) => ({
    eax: dv().getUint32(p + R_EAX, true) >>> 0,
    ebx: dv().getUint32(p + R_EBX, true) >>> 0,
    ecx: dv().getUint32(p + R_ECX, true) >>> 0,
    edx: dv().getUint32(p + R_EDX, true) >>> 0,
    esi: dv().getUint32(p + R_ESI, true) >>> 0,
    edi: dv().getUint32(p + R_EDI, true) >>> 0,
  });
  const setReg = (p, off, v) => { if (p) dv().setUint32(p + off, v >>> 0, true); };
  const setCarry = (p, on) => { if (p) dv().setUint32(p + R_CFLAG, on ? 1 : 0, true); };

  /*
   * The BIOS keyboard, INT 16h, with ONE implementation behind two doors.
   *
   * AH=11h/01h PEEK: they report whether a key is waiting in ZF and leave it waiting.
   * AH=10h/00h READ: they take it.
   *
   * That split matters because OpenDUNE's get_bios_keyboard_status does both -- it is a #pragma aux
   * whose body peeks, branches on ZF, and reads. Folding the two into one answer worked while that
   * routine was transcribed by hand; once it is COMPILED from its own assembly, the halves have to
   * be real. AH is the scan code and AL the ASCII, and nothing here maps a layout, so AL stays 0 --
   * which a program reading the scan code, as this one does, never notices.
   */
  function biosKeyboard(ah) {
    const peekOnly = (ah === 0x11 || ah === 0x01);
    if (peekOnly) {
      const code = M.kbd?.peek ? M.kbd.peek() : 0;
      return { eax: code ? ((code & 0xff) << 8) : 0, zf: !code };
    }
    const code = M.kbd?.take ? M.kbd.take() : 0;
    return { eax: code ? ((code & 0xff) << 8) : 0, zf: !code };
  }

  const api = {
    /**
     * A software interrupt. Only the services these games actually ask for, answered honestly;
     * anything else clears carry and returns, which is what a BIOS does for a function it does not
     * implement and is far better than pretending to fail.
     */
    int386: (num, inR, outR) => {
      const r = getRegs(inR);
      const out = outR || inR;
      if (inR !== out) M.u8.copyWithin(out, inR, inR + 32);
      switch (num | 0) {
        case 0x10: {                                   // BIOS video
          const ah = (r.eax >> 8) & 0xff, al = r.eax & 0xff;
          if (ah === 0) {                              // set mode
            state.mode = al;
            // 13h is 320x200 linear at 0xa0000, which is where the game will write. Nothing to
            // program: the memory is already there.
            if (al === 0x13) { state.width = 320; state.height = 200; state.pixels = 0xa0000; }
            publishGeometry();
          }
          setCarry(out, false);
          return 0;
        }
        /*
         * INT 16h, the BIOS keyboard, as OpenDUNE's Video_Tick polls it.
         *
         * AH=11h asks "is an enhanced keystroke waiting" and answers in ZF, which a Watcom program
         * cannot see: `union REGS` carries cflag and no other flag. The routine that asks -- a
         * #pragma aux with an assembly body, video_dos.c:142 -- immediately does the AH=10h read
         * itself when the answer is yes, and returns the key or zero. So the split between peek and
         * read is not observable to any caller, and this answers the whole question in EAX: zero
         * when nothing is waiting, the scan code and ASCII otherwise. Stated rather than implied,
         * because it IS a deviation from the BIOS interface, just not from the program's.
         */
        case 0x16: {
          /*
           * A C caller cannot see ZF: Watcom's union REGS carries cflag and no other flag. So this
           * door answers in EAX alone, and the ZF half of the service is reachable only through
           * __asmInt, where a compiled `jz` needs it.
           */
          setReg(out, R_EAX, biosKeyboard((r.eax >> 8) & 0xff).eax);
          setCarry(out, false);
          return 0;
        }

        /*
         * INT 33h, the mouse. Dune II is mouse-driven -- Video_Init refuses to start without one --
         * so supplying a mouse is supplying a device, the same as the DAC and the 8042.
         */
        case 0x33: {
          const ax = r.eax & 0xffff;
          if (ax === 0x0000) {                         // reset and detect
            setReg(out, R_EAX, 0xffff);                // installed
            setReg(out, R_EBX, 2);                     // two buttons
          } else if (ax === 0x000c) {
            /*
             * Install an event handler: CX is the event mask, ES:EDX the routine. Recorded, not
             * installed -- the same as every interrupt vector here, and for the same reason: a
             * recorded handler is one this host can CALL when it has an event. See deliverMouse.
             */
            state.mouse.mask = r.ecx & 0xffff;
            state.mouse.handler = r.edx >>> 0;
          } else if (ax === 0x0004) {                  // set position
            state.mouse.x = r.ecx & 0xffff;
            state.mouse.y = r.edx & 0xffff;
          } else if (ax === 0x0007) {                  // horizontal range
            state.mouse.minX = r.ecx & 0xffff; state.mouse.maxX = r.edx & 0xffff;
          } else if (ax === 0x0008) {                  // vertical range
            state.mouse.minY = r.ecx & 0xffff; state.mouse.maxY = r.edx & 0xffff;
          }
          setCarry(out, false);
          return 0;
        }
        case 0x31:                                     // DPMI
          return dpmi(r, out);
        default:
          setCarry(out, false);
          return 0;
      }
    },

    int386x: (num, inR, outR, _sregs) => api.int386(num, inR, outR),

    /*
     * A software interrupt from a COMPILED #pragma aux (src/asm/pragma-aux.js). Registers arrive and
     * leave as a plain object rather than through a union REGS in memory, and the flags come with
     * them -- which is the whole difference, and the reason this door exists at all.
     */
    __asmInt: (num, r) => {
      if ((num | 0) === 0x16) {
        const k = biosKeyboard((r.eax >> 8) & 0xff);
        return { ...r, eax: k.eax, zf: k.zf };
      }
      // Anything else: unchanged, and no flag set. A BIOS that does not know a service leaves the
      // registers alone, which is what a caller checking them will see.
      return { ...r, zf: false };
    },

    /** Segment registers. One flat selector, so every answer is the same one. */
    segread: (sregs) => {
      if (!sregs) return 0;
      for (let i = 0; i < 4; i++) dv().setUint16(sregs + i * 2, 0x1f, true);
      return 0;
    },

    /*
     * The interrupt vector table. The handler is RECORDED rather than installed, because there is
     * nothing to install it into -- and recorded rather than discarded, because a recorded handler
     * can be CALLED. That is the whole mechanism by which this host delivers an interrupt.
     */
    /*
     * The vector table. Bit 15 is DOS4GW's "this is an IRQ, not a software interrupt" flag --
     * Heretic installs its keyboard handler as `_dos_setvect(0x8000 | KEYBOARDINT, ...)` -- so it is
     * masked off before storing. Keeping it would file the handler under 0x8009 and leave
     * deliverKeyboard looking for a vector 9 that was never there.
     */
    _dos_setvect: (num, fn) => { state.vectors.set((num | 0) & 0xff, fn >>> 0); return 0; },
    _dos_getvect: (num) => state.vectors.get((num | 0) & 0xff) ?? 0,
    _dos_irqenable: () => 0,
    _dos_irqdisable: () => 0,
    _enable: () => 0,
    _disable: () => 0,

    // Page locking, for a host with no paging to defeat.
    _dpmi_lockregion: () => 0,
    _dpmi_unlockregion: () => 0,

    /*
     * graph.h, the text-mode banner. Collected rather than dropped: it is the program telling you
     * what it is doing during start-up, and on a screen that does not exist yet it is the only
     * progress report there is.
     */
    _settextposition: (row, col) => { state.textPos = { row: row | 0, col: col | 0 }; return 0; },
    _settextwindow: () => 0,
    _setvideomode: () => 0,
    _settextcolor: () => 0,
    _setbkcolor: () => 0,
    _clearscreen: () => { state.text.length = 0; return 0; },
    _outtext: (p) => { const s = mod.cstr(p); state.text.push(s); M.write(s + '\n'); return 0; },
    _settextcursor: () => 0,
    _setcursortype: () => 0,

    /*
     * DMX, the sound library these games link -- the same boundary as SEAL for MAME. Silence, but
     * reported as success: a library that fails sends I_InitSound down a path the game has no other
     * answer for. Detection reports NO hardware, which is the truthful answer and the one that keeps
     * the game out of every device-specific path.
     */
    DMX_Init: () => 0, DMX_DeInit: () => 0, DMX_Get: () => 0,
    GF1_Detect: () => -1, GF1_SetMap: () => 0,
    AL_Detect: (wait, type) => { if (wait) dv().setInt32(wait, 0, true); if (type) dv().setInt32(type, 0, true); return -1; },
    AL_SetCard: () => 0,
    SB_Detect: (base, irq, dma, midi) => {
      for (const p of [base, irq, dma, midi]) if (p) dv().setInt32(p, 0, true);
      return -1;                                        // no Sound Blaster
    },
    SB_SetCard: () => 0,
    MPU_Detect: (base, type) => { if (base) dv().setInt32(base, 0, true); if (type) dv().setInt32(type, 0, true); return -1; },
    MPU_SetCard: () => 0,
    CODEC_DetectDMA: () => 0,
    WAV_PlayMode: () => 0,
    SFX_PlayPatch: () => { state.sfx = (state.sfx ?? 0) + 1; return 1; },
    SFX_StopPatch: () => 0, SFX_Playing: () => 0, SFX_SetOrigin: () => 0,
    MUS_RegisterSong: () => 1, MUS_UnregisterSong: () => 0,
    MUS_PlaySong: () => 0, MUS_StopSong: () => 0,
    MUS_Pause: () => 0, MUS_Resume: () => 0,
    MUS_PauseSong: () => 0, MUS_ResumeSong: () => 0,
    MUS_SetMasterVolume: () => 0, MUS_QrySongPlaying: () => 0, MUS_ChainSong: () => 0,

    /*
     * TSM is DMX's timer-service manager, and a registered service is the same problem as an
     * interrupt handler: recorded, callable, not yet called. The handle is an index into the list so
     * TSM_DelService can find it again.
     */
    TSM_Install: () => 0,
    TSM_NewService: (fn) => { state.services.push(fn >>> 0); return state.services.length; },
    TSM_DelService: (h) => { if (h > 0) state.services[h - 1] = 0; return 0; },
    TSM_Remove: () => { state.services.length = 0; return 0; },
  };

  /**
   * DPMI (INT 31h), the two services these games use.
   *
   * 0x0500 asks for a memory-info block; the numbers only have to be plausible and large, because
   * the game divides by them to decide how big a zone to allocate. 0x0501 allocates, and here that
   * is the guest's own malloc — which is the truthful answer, since DPMI memory and heap memory are
   * the same memory in one flat image.
   */
  function dpmi(r, out) {
    const fn = r.eax & 0xffff;
    if (fn === 0x0500) {
      const info = r.edi;
      if (info) {
        dv().setUint32(info, 32 * 1024 * 1024, true);        // largest free block
        for (let i = 1; i < 12; i++) dv().setUint32(info + i * 4, 0xffffffff, true);
      }
      setCarry(out, false);
      return 0;
    }
    if (fn === 0x0501) {
      const size = ((r.ebx & 0xffff) << 16) | (r.ecx & 0xffff);
      const p = M.rt.malloc(size);
      if (!p) { setCarry(out, true); return 0; }
      setReg(out, R_EBX, (p >>> 16) & 0xffff);
      setReg(out, R_ECX, p & 0xffff);
      setReg(out, R_ESI, (p >>> 16) & 0xffff);              // the handle is the address
      setReg(out, R_EDI, p & 0xffff);
      setCarry(out, false);
      return 0;
    }
    setCarry(out, false);
    return 0;
  }

  /**
   * Deliver a keyboard interrupt: call the handler the program installed, exactly as the hardware
   * would.
   *
   * This is the piece that makes a DOS game playable without emulating a CPU. `I_KeyboardISR` reads
   * port 0x60 for the scan code and pushes it into the game's own ring buffer, so all the host has
   * to do is queue the code and call the function. Nothing about the game is special-cased: it is
   * its own ISR, running its own code.
   */
  /**
   * Deliver a timer interrupt: call the handler the program installed on vector 8.
   *
   * `IO_TimerISR` is four lines -- `ticcount++` and an EOI to the PIC -- and `ticcount` is the
   * game's ENTIRE notion of time. Nothing else advances it, so without this `TryRunTics` waits for a
   * tic that never comes; the safepoint profiler found it there after 280 million iterations.
   *
   * Rate is the caller's business, because it is the caller that knows what clock exists. Heretic
   * reprograms PIT channel 0 for 35 Hz and counts on that; a host with a real clock should call this
   * at 35 Hz, and a deterministic harness at whatever rate makes its frame budget.
   */
  function deliverTimer() {
    let fired = false;
    // Vector 8, the PC timer interrupt...
    const isr = state.vectors.get(0x08);
    if (isr) { M.icall(isr, []); fired = true; }
    /*
     * ...and DMX's timer services, which is where the tic ACTUALLY comes from in these games.
     * Heretic's own `IO_StartupTimer()` call is commented out in its source; time arrives instead
     * through `TSM_NewService(I_TimerISR, 35, 255, 0)` in I_SOUND.C, registered with the sound
     * library. Driving only vector 8 delivered zero interrupts and the game waited for ever --
     * which is the kind of thing you find by reading the game's source, not by assuming a PC.
     */
    for (const fn of state.services) {
      if (!fn) continue;
      M.icall(fn, []);
      fired = true;
    }
    if (fired) state.ticks++;
    return fired;
  }

  /**
   * Deliver a keyboard interrupt: queue the scan code where port 0x60 will read it, then call the
   * handler the program installed.
   *
   * `kbd` is the controller from src/env/kbd8042.js. The two halves have to meet -- a code with no
   * interrupt is never read, and an interrupt with no code makes the game read the previous one
   * again -- which is why they are one function rather than two.
   */
  function deliverKeyboard(scan, kbd = M.kbd) {
    const isr = state.vectors.get(0x09);
    if (!isr || !kbd) return false;
    kbd.push(scan);
    M.icall(isr, []);
    state.keys++;
    return true;
  }

  /** A key down and then up, one interrupt each, which is what a keypress actually is. */
  function tapKey(code, kbd = M.kbd) {
    const c = code & 0x7f;
    return deliverKeyboard(c, kbd) && deliverKeyboard(c | 0x80, kbd);
  }

  function publishGeometry() {
    if (!publish) return;
    Atomics.store(publish.ctrl, SLOT.WIDTH, state.width);
    Atomics.store(publish.ctrl, SLOT.HEIGHT, state.height);
    Atomics.store(publish.ctrl, SLOT.PIXELS, state.pixels);
    Atomics.store(publish.ctrl, SLOT.TEXTMODE, 0);
  }

  Object.assign(M.rt, api);
  M.watcomHost = { state, deliverKeyboard, tapKey, deliverTimer, publishGeometry, keys, onPresent, stopAfterFrames };
  return M.watcomHost;
}

/** The declarations, in the shape src/compile.js's BUILTINS table wants. */
export function watcomBuiltins(T) {
  const P = T.ptr(T.CHAR), I = T.INT, U = T.UINT, V = T.VOID;
  const f = (ret, ...params) => ({ ret, params });
  return {
    int386: f(I, I, P, P),
    int386x: f(I, I, P, P, P),
    segread: f(V, P),
    _dos_setvect: f(V, U, P),
    _dos_getvect: f(P, U),
    _dos_irqenable: f(V, U), _dos_irqdisable: f(V, U),
    _enable: f(V), _disable: f(V),
    _dpmi_lockregion: f(I, P, U), _dpmi_unlockregion: f(I, P, U),
    _settextposition: f(V, I, I), _settextwindow: f(V, I, I, I, I),
    _settextcursor: f(V, I), _setcursortype: f(V, I),
    DMX_Init: f(I, I, I, I, I), DMX_DeInit: f(V), DMX_Get: f(T.LONG),
    GF1_Detect: f(I), GF1_SetMap: f(V, P, I),
    AL_Detect: f(I, P, P), AL_SetCard: f(V, I, P),
    SB_Detect: f(I, P, P, P, P), SB_SetCard: f(V, I, I, I, I),
    MPU_Detect: f(I, P, P), MPU_SetCard: f(V, I),
    CODEC_DetectDMA: f(V), WAV_PlayMode: f(V, I, I),
    SFX_PlayPatch: f(I, P, I, I, I, I, I), SFX_StopPatch: f(V, I),
    SFX_Playing: f(I, I), SFX_SetOrigin: f(V, I, I, I, I),
    MUS_RegisterSong: f(I, P), MUS_UnregisterSong: f(V, I),
    MUS_PlaySong: f(I, I, I), MUS_StopSong: f(V, I),
    MUS_Pause: f(V), MUS_Resume: f(V), MUS_PauseSong: f(V, I), MUS_ResumeSong: f(V, I),
    MUS_SetMasterVolume: f(V, I), MUS_QrySongPlaying: f(I, I), MUS_ChainSong: f(V, I, I),
    TSM_Install: f(I, I), TSM_NewService: f(I, P, I, I, I),
    TSM_DelService: f(V, I), TSM_Remove: f(V),
    _setvideomode: f(I, I), _settextcolor: f(I, I), _setbkcolor: f(I, T.LONG),
    _clearscreen: f(V, I), _outtext: f(V, P),
  };
}
