// svgalib.js — the Linux console's graphics library, for Quake's second display path.
//
// `vid_svgalib.c` is the other video driver id shipped for Linux: no X server, no window, just the
// framebuffer of the virtual console and the raw keyboard. It is a whole platform layer in one file
// -- VID_*, Sys_SendKeyEvents and every IN_* -- exactly as vid_x.c and vid_sunx.c are, so the choice
// between them is a display path within one machine rather than a different machine.
//
// WHY IT IS CHEAP HERE, when a planar VGA is not. The driver has both paths:
//
//     VGA_planar = modes[current_mode].bytesperpixel == 0;
//     ...
//     if (VGA_planar) VGA_UpdatePlanarScreen (vid.buffer);   /* d_copy.s, no C equivalent */
//
// and with no arguments it takes `current_mode = G320x200x256`, which on a real svgalib is a LINEAR
// eight-bit mode -- `bytesperpixel == 1`. So the planar branch is not avoided by a trick; it is not
// the mode the program asks for. A planar svgalib mode would need the same two things mode-X needs
// (P3.5): the assembly routine and a host with plane registers.
//
// The surface is nineteen functions, and the two input ones are a better fit than anything else in
// this corpus: svgalib's keyboard delivers a RAW PC SCAN CODE to a handler the client installs, and
// its mouse delivers RELATIVE deltas to another. Those are precisely the two channels PRISM already
// carries, so this layer forwards rather than translates.

import { SLOT } from './webhost.js';
import { funcIndex } from '../link/module.js';

/*
 * svgalib's mode numbers. Only the two that matter are named: TEXT to leave graphics on shutdown,
 * and G320x200x256, which is the one the driver defaults to.
 */
const TEXT = 0;
const G320x200x256 = 5;
const LAST_MODE = G320x200x256;

/* vga_modeinfo, in svgalib 1.4's layout. Quake memcpy's the whole struct, so the SIZE matters as
 * much as the five fields it reads -- see VGA_MODEINFO in headers-svgalib.js for the declaration. */
const MI_WIDTH = 0, MI_HEIGHT = 4, MI_BYTESPERPIXEL = 8, MI_COLORS = 12, MI_LINEWIDTH = 16;
const MI_SIZE = 68;                       // through `extensions`, i386: 17 words

export function installSvgalib(M, { publish = null, keyboard = null, mouse = null,
                                    onFrame = null } = {}) {
  const dv = () => M.mod.dv;
  const state = {
    mode: TEXT, width: 0, height: 0, mem: 0,
    palette: new Uint8Array(768),
    keyHandler: 0, mouseHandler: 0,
    modeinfo: 0,
  };
  M.svgalib = state;

  /*
   * Calling BACK into the guest, through the function-pointer table. A function's "address" here is
   * its table index tagged into the high region (src/link/module.js), so a handler the client
   * installed is called by unmasking that index -- the same path an indirect call inside the program
   * takes, which is why a handler that was inlined or rebound still works.
   */
  const call = (ptr, ...args) => {
    const fn = M.mod.funcTable[funcIndex(ptr | 0)];
    if (fn) fn(...args);
  };

  /** One vga_modeinfo in guest memory, refilled per query: the client keeps its own copy anyway. */
  function modeinfoFor(mode) {
    if (!state.modeinfo) state.modeinfo = M.rt.malloc(MI_SIZE);
    M.u8.fill(0, state.modeinfo, state.modeinfo + MI_SIZE);
    if (mode === G320x200x256) {
      dv().setInt32(state.modeinfo + MI_WIDTH, 320, true);
      dv().setInt32(state.modeinfo + MI_HEIGHT, 200, true);
      dv().setInt32(state.modeinfo + MI_BYTESPERPIXEL, 1, true);   // 1 = LINEAR, and 0 would be planar
      dv().setInt32(state.modeinfo + MI_COLORS, 256, true);
      dv().setInt32(state.modeinfo + MI_LINEWIDTH, 320, true);
    }
    return state.modeinfo;
  }

  function publishGeometry() {
    if (!publish || !state.mem) return;
    Atomics.store(publish.ctrl, SLOT.WIDTH, state.width);
    Atomics.store(publish.ctrl, SLOT.HEIGHT, state.height);
    Atomics.store(publish.ctrl, SLOT.PIXELS, state.mem);
    Atomics.store(publish.ctrl, SLOT.TEXTMODE, 0);
  }

  const api = {
    /* ---------------------------------------------------------------- the library */
    vga_init: () => 0,
    vga_lastmodenumber: () => LAST_MODE,
    vga_hasmode: (mode) => ((mode | 0) === G320x200x256 ? 1 : 0),
    vga_getmodeinfo: (mode) => modeinfoFor(mode | 0),
    vga_getmodenumber: (namePtr) => {
      /* By name, for `-mode G320x200x256`. Only one exists, so only one can be found. */
      const name = namePtr ? M.mod.cstr(namePtr) : '';
      return /320x200x256/.test(name) ? G320x200x256 : -1;
    },
    vga_getcolors: () => (state.mode === G320x200x256 ? 256 : 16),

    vga_setmode: (mode) => {
      state.mode = mode | 0;
      if (state.mode === TEXT) {
        /* Back to text on the way out, which is what the console looked like before. */
        if (publish) Atomics.store(publish.ctrl, SLOT.TEXTMODE, 1);
        return 0;
      }
      state.width = 320; state.height = 200;
      if (!state.mem) state.mem = M.rt.malloc(state.width * state.height);
      M.u8.fill(0, state.mem, state.mem + state.width * state.height);
      publishGeometry();
      return 0;
    },

    /*
     * The framebuffer. On a real svgalib this is the mmapped console memory; here it is ordinary
     * guest memory whose address the page reads, which is the same "publish what the program was
     * going to write anyway" move the X11 and Quake layers make.
     */
    vga_getgraphmem: () => state.mem,
    /* A linear mode has one page, so there is nothing to switch and nothing to wait for. */
    vga_setpage: () => 0,
    vga_oktowrite: () => 1,
    vga_waitretrace: () => 0,
    vga_runinbackground: () => 0,
    vga_setlinearaddressing: () => 0,        // the driver's call site is commented out; kept for the link

    /*
     * The palette, in svgalib's currency: `vga_setpalvec(start, num, int *)` where each component is
     * SIX bits, because that is what the VGA DAC took. VID_SetPalette shifts Quake's bytes down by
     * two on the way in (vid_svgalib.c:VID_SetPalette), so they shift back up here.
     */
    vga_setpalvec: (start, num, vec) => {
      for (let i = 0; i < (num | 0) * 3; i++) {
        const six = dv().getInt32(vec + i * 4, true) & 0x3f;
        state.palette[((start | 0) * 3 + i) % 768] = (six << 2) | (six >> 4);
      }
      if (publish) {
        publish.pal.set(state.palette);
        Atomics.store(publish.ctrl, SLOT.PENS, 256);
        Atomics.add(publish.ctrl, SLOT.PALGEN, 1);
      }
      return 0;
    },

    /*
     * <asm/io.h>, because the GAME does port I/O: D_BeginDirectRect programs the VGA sequencer and
     * graphics controller by hand to pick a plane. Linux's argument order is VALUE FIRST, which is
     * the opposite of the DOS convention PRISM's port machine uses, so they are swapped here -- and
     * they go to the real machine rather than nowhere, because a program writing 0x3C4 means it.
     */
    outb: (value, port) => { M.machine?.outb?.(port & 0xffff, value & 0xff); },
    outw: (value, port) => { M.machine?.outw?.(port & 0xffff, value & 0xffff); },
    inb: (port) => (M.machine?.inb?.(port & 0xffff) ?? 0xff) & 0xff,
    inw: (port) => (M.machine?.inw?.(port & 0xffff) ?? 0xffff) & 0xffff,

    /* ---------------------------------------------------------------- vgakeyboard */
    /*
     * A RAW SCAN CODE to a handler the client installs, which is what PRISM's keyboard channel
     * already carries -- so nothing is translated here, only forwarded. `keyhandler(scancode, state)`
     * with state == KEY_EVENTPRESS, and `vid_svgalib.c` masks the code with 0x7f itself.
     */
    keyboard_init: () => 0,
    keyboard_close: () => 0,
    keyboard_seteventhandler: (fn) => { state.keyHandler = fn | 0; return 0; },
    // The raw scan codes PRISM delivers are already untranslated; a flag other than
    // DONT_CATCH_CTRLC (which only stops svgalib trapping Ctrl-C) would change them, so it is refused.
    keyboard_translatekeys: (mask) => { if ((mask | 0) & ~8) throw new Error(`svgalib: keyboard_translatekeys(${mask}) translation is not implemented`); return 0; },
    /*
     * ONE event per call, and non-zero while there might be more: the client's loop is
     * `while (keyboard_update());`, so a function that drained everything and returned 1 would spin
     * for ever and one that returned 0 after draining would deliver only the first.
     */
    keyboard_update: () => {
      if (!keyboard || !state.keyHandler) return 0;
      const e = keyboard.next ? keyboard.next() : null;
      if (!e) return 0;
      call(state.keyHandler, e.scan & 0x7f, e.down ? 1 : 0);
      return 1;
    },

    /* ---------------------------------------------------------------- vgamouse */
    vga_getmousetype: () => 0,
    mouse_init: () => (mouse && mouse.has() ? 0 : 1),   // 0 is success, as the driver reads it
    mouse_close: () => 0,
    mouse_seteventhandler: (fn) => { state.mouseHandler = fn | 0; return 0; },
    /*
     * `mousehandler(buttonstate, dx, dy)` -- relative, like INT 33h's motion counters and unlike
     * X11's absolute positions. This is the one host binding in the corpus that wants exactly what
     * the channel holds.
     */
    mouse_update: () => {
      if (!mouse || !state.mouseHandler) return 0;
      const { dx, dy } = mouse.take();
      const b = mouse.state();
      if (dx || dy || b !== state.lastButtons) {
        state.lastButtons = b;
        /*
         * svgalib's OWN button bits, which are not the channel's: MOUSE_LEFTBUTTON is 4 and
         * MOUSE_RIGHTBUTTON is 1. Quake then indexes them as `1 << i` for K_MOUSE1..3, so on real
         * svgalib its "button 1" is the RIGHT one -- id's mapping, and reproducing it is the point.
         */
        const sv = ((b & 1) ? 4 : 0) | ((b & 4) ? 2 : 0) | ((b & 2) ? 1 : 0);
        call(state.mouseHandler, sv, dx, dy);
      }
      return 0;
    },
  };

  /*
   * The frame boundary. VID_Update is where the driver has finished a picture, and it is where a
   * host gets its one chance to pace the guest and retire a frame's input -- the same place vid_x.c
   * gives through XPutImage.
   */
  if (onFrame) state.onFrame = onFrame;

  Object.assign(M.rt, api);
  return state;
}

/** The declarations, in the shape src/compile.js's BUILTINS table wants. */
export function svgalibBuiltins(T) {
  const I = T.INT, P = T.ptr(T.CHAR), V = T.VOID;
  const f = (ret, ...params) => ({ ret, params });
  return {
    vga_init: f(I),
    vga_lastmodenumber: f(I),
    vga_hasmode: f(I, I),
    vga_getmodeinfo: f(P, I),
    vga_getmodenumber: f(I, P),
    vga_getcolors: f(I),
    vga_setmode: f(I, I),
    vga_getgraphmem: f(P),
    vga_setpage: f(I, I),
    vga_oktowrite: f(I),
    vga_waitretrace: f(V),
    vga_runinbackground: f(I, I),
    vga_setlinearaddressing: f(I),
    vga_setpalvec: f(I, I, I, P),
    keyboard_init: f(I),
    keyboard_close: f(V),
    keyboard_seteventhandler: f(V, P),
    keyboard_translatekeys: f(I, I),
    keyboard_update: f(I),
    outb: f(V, I, I),
    outw: f(V, I, I),
    inb: f(I, I),
    inw: f(I, I),
    vga_getmousetype: f(I),
    mouse_init: f(I, P, I, I),
    mouse_close: f(V),
    mouse_seteventhandler: f(V, P),
    mouse_update: f(I),
  };
}
