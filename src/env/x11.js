// x11.js — Xlib, shimmed at the library boundary.
//
// Doom's only published source is the Linux/X11 tree, so compiling it unmodified means being a UNIX
// host with an X server. PRISM supplies the header and the library, and Doom's own `i_video.c` is
// compiled exactly as id wrote it — which is the whole claim of this project, and the reason this
// file exists rather than a hand-written replacement for i_video.c.
//
// Stated plainly, because it would be easy to overclaim: **this shims the LIBRARY, not the protocol.**
// `XOpenDisplay` returns a token rather than a connection, and nothing here speaks to an X server or
// ever could. What makes that honest is that the program cannot tell: it asks Xlib for an image
// buffer, draws into it, and hands it back with `XPutImage`. Where those bytes go afterwards is the
// host's business, and here they go straight to the page.
//
// The surface is measured, not invented — every symbol below appears in Doom's i_video.c. Quake's
// vid_x.c wants nearly the same set plus MIT-SHM, which is deliberately refused: `XShmQueryExtension`
// answering "no" is a supported answer that sends a program down its ordinary XImage path.

import { SLOT } from './webhost.js';

const DISPLAY = 0x7200_0001;      // the token XOpenDisplay hands back
const WINDOW = 0x7200_0002;
const COLORMAP = 0x7200_0003;
const GC_TOKEN = 0x7200_0004;

/**
 * `publish` is the same control block everything else uses. An XImage's pixel buffer lives in guest
 * memory, so the page reads it directly — no copy, and the same mechanism as Quake's vid_buffer.
 */
/*
 * Where a keycode goes inside an XEvent. These are not free choices: the guest reads the field with
 * its own `offsetof`, from the XKeyEvent this header declares, so a shim that writes anywhere else
 * hands it whatever happens to be there.
 *
 * They are MEASURED, by compiling `offsetof(XEvent, xkey.keycode)` with PRISM and reading the answer,
 * because counting the fields by hand is what produced 36 -- which is xexpose.count, one union arm
 * over. Every key reached Doom with keycode 0, `XKeycodeToKeysym(0)` returned 0, and the menu ignored
 * it. The one key that looked like it worked was Escape, and it did not: during demo playback
 * G_Responder opens the menu on ANY keydown, so an undecoded key and a decoded Escape are the same
 * picture. A shim's offsets are part of the ABI, and the ABI has a gate for a reason.
 */
const XKEY_KEYCODE = 52;
const XEXPOSE_COUNT = 36;

export function installX11(M, { publish = null, keyboard = null, onFrame = null } = {}) {
  const dv = () => M.mod.dv;

  // XImage, in the layout PRISM's own X11/Xlib.h declares. The two are one thing in two places.
  const IMG_WIDTH = 0, IMG_HEIGHT = 4, IMG_XOFF = 8, IMG_FORMAT = 12, IMG_DATA = 16,
        IMG_BYTE_ORDER = 20, IMG_BITMAP_UNIT = 24, IMG_BITMAP_BIT_ORDER = 28, IMG_BITMAP_PAD = 32,
        IMG_DEPTH = 36, IMG_BYTES_PER_LINE = 40, IMG_BITS_PER_PIXEL = 44, IMG_SIZE = 64;

  const state = { width: 0, height: 0, imageData: 0, palette: new Uint8Array(768),
                  // Interned atom names, and the window's own title when it sets one through ICCCM.
                  atoms: new Map(), windowName: '' };

  /*
   * An event queue, because a real X server sends events a client waits for. Doom maps its window and
   * then blocks until an Expose arrives:
   *
   *     oktodraw = 0;
   *     while (!oktodraw) { XNextEvent(X_display, &X_event);
   *                         if (X_event.type == Expose && !X_event.xexpose.count) oktodraw = 1; }
   *
   * With nothing ever delivered that loop never ends — 1.98 million XNextEvent calls before the
   * profiler caught it. Mapping the window enqueues the Expose the server would have sent.
   */
  const events = [];
  M.x11 = state;

  const api = {
    XOpenDisplay: () => DISPLAY,
    XCloseDisplay: () => 0,
    XSync: () => 0,
    XFlush: () => 0,
    XSynchronize: () => 0,
    XDefaultScreen: () => 0,
    XRootWindow: () => WINDOW,
    XCreateColormap: () => COLORMAP,
    XCreateGC: () => GC_TOKEN,
    XFreeGC: () => 0,
    XCreatePixmap: () => WINDOW,
    XFreePixmap: () => 0,
    XCreatePixmapCursor: () => 0,
    XDefineCursor: () => 0,
    XFillRectangle: () => 0,
    XGrabPointer: () => 0,
    XUngrabPointer: () => 0,
    XWarpPointer: () => 0,
    XSelectInput: () => 0,
    XStoreName: () => 0,

    /*
     * ICCCM: what a client tells a WINDOW MANAGER about itself. Quake's SUN driver sets every one of
     * them where its Linux driver sets none -- a program written for a workstation desktop against
     * one written for a Linux box in 1996.
     *
     * There is no window manager here, so these record what a page could use and otherwise answer
     * the way a server with nothing to argue about would. They are not stubs in the bad sense: an
     * atom really is an interned string, XAllocWMHints really does return storage the caller frees,
     * and getting THAT wrong is what makes a program crash rather than merely look plain.
     */
    XInternAtom: (_d, namePtr) => {
      const name = M.mod.cstr(namePtr);
      if (!state.atoms.has(name)) state.atoms.set(name, state.atoms.size + 1);
      return state.atoms.get(name);
    },
    XChangeProperty: () => 0,
    /* One fixed display, and the same one the DisplayWidth macro reports: 640x480. */
    ScreenOfDisplay: () => 1,
    WidthOfScreen: () => 640,
    HeightOfScreen: () => 480,
    XSetWMProtocols: () => 1,
    XConfigureWindow: () => 0,
    XUndefineCursor: () => 0,
    // Zeroed storage the caller owns, which is the whole contract. Quake writes flags into it and
    // frees it; handing back 0 would be a null dereference two lines later.
    XAllocWMHints: () => M.rt.calloc(1, 40),
    XAllocSizeHints: () => M.rt.calloc(1, 80),
    XAllocClassHint: () => M.rt.calloc(1, 8),
    XFree: (p) => { if (p) M.rt.free(p); return 1; },
    /*
     * The window's NAME, which is the one part of this a page can act on: XTextProperty's first
     * field is the string. It goes where XStoreName's would, so a shell that shows a title shows
     * this one too.
     */
    XSetWMProperties: (_d, _w, namePtr) => {
      if (!namePtr) return 0;
      const str = M.mod.dv.getInt32(namePtr, true);
      if (str) state.windowName = M.mod.cstr(str);
      return 0;
    },
    XSetWindowColormap: () => 0,
    XAutoRepeatOn: () => 0,
    XAutoRepeatOff: () => 0,
    XMapWindow: () => { events.push({ type: 12 /* Expose */, count: 0 }); return 0; },
    XVisualIDFromVisual: () => 1,
    XDefaultVisual: () => 1,
    XDestroyWindow: () => 0,
    XFreeColormap: () => 0,

    /*
     * XGetVisualInfo returns an ARRAY, and its caller keeps the pointer: Quake II's rw_x11.c holds
     * `x_visinfo` for the life of the window and reads `->depth` on every mode change. So this
     * allocates rather than filling a caller's struct, which is the one real difference from
     * XMatchVisualInfo above.
     *
     * One visual, 8-bit PseudoColor, which is what ref_soft asks for -- it is a palettised renderer
     * and `pwidth = x_visinfo->depth / 8` has to come out 1.
     */
    XGetVisualInfo: (_dpy, _mask, _template, nitemsPtr) => {
      // struct XVisualInfo { Visual *visual; VisualID visualid; int screen, depth, class;
      //                      unsigned long red_mask, green_mask, blue_mask;
      //                      int colormap_size, bits_per_rgb; }
      const SIZE = 40;
      const p = M.rt.malloc(SIZE);
      if (!p) return 0;
      M.u8.fill(0, p, p + SIZE);
      dv().setInt32(p + 0, 1, true);        // a non-null Visual *
      dv().setInt32(p + 4, 1, true);        // visualid
      dv().setInt32(p + 8, 0, true);        // screen
      dv().setInt32(p + 12, 8, true);       // depth
      dv().setInt32(p + 16, 3, true);       // class = PseudoColor
      dv().setInt32(p + 32, 256, true);     // colormap_size
      dv().setInt32(p + 36, 8, true);       // bits_per_rgb
      if (nitemsPtr) dv().setInt32(nitemsPtr, 1, true);
      return p;
    },


    /** A visual is always available and always 8-bit PseudoColor, which is what Doom asks for. */
    XMatchVisualInfo: (_dpy, _screen, depth, _class, vinfo) => {
      if ((depth | 0) !== 8) return 0;
      // struct XVisualInfo { Visual *visual; VisualID visualid; int screen, depth; int class; ... }
      dv().setInt32(vinfo, 1, true);          // a non-null Visual *
      dv().setInt32(vinfo + 4, 1, true);      // visualid
      dv().setInt32(vinfo + 8, 0, true);      // screen
      dv().setInt32(vinfo + 12, 8, true);     // depth
      /*
       * `class` matters and was the thing left unset. Doom uploads its palette only under
       *   if (X_visualinfo.class == PseudoColor && X_visualinfo.depth == 8)
       * so a zero here meant XStoreColors was never called, PENS stayed 0, and the game rendered
       * into a canvas with no colours — 213 fps of black.
       */
      dv().setInt32(vinfo + 16, 3, true);      // class = PseudoColor
      dv().setInt32(vinfo + 32, 256, true);    // colormap_size
      dv().setInt32(vinfo + 36, 8, true);      // bits_per_rgb
      return 1;
    },

    XCreateWindow: () => WINDOW,

    XCreateImage: (_dpy, _vis, depth, _fmt, _off, data, w, h, _pad, bpl) => {
      const img = M.rt.malloc(IMG_SIZE);
      M.u8.fill(0, img, img + IMG_SIZE);
      dv().setInt32(img + IMG_WIDTH, w | 0, true);
      dv().setInt32(img + IMG_HEIGHT, h | 0, true);
      dv().setInt32(img + IMG_DATA, data | 0, true);
      dv().setInt32(img + IMG_DEPTH, depth | 0, true);
      dv().setInt32(img + IMG_BYTES_PER_LINE, (bpl | 0) || (w | 0), true);
      dv().setInt32(img + IMG_BITS_PER_PIXEL, 8, true);
      dv().setInt32(img + IMG_FORMAT, 2, true);      // ZPixmap
      state.width = w | 0; state.height = h | 0; state.imageData = data | 0;
      publishGeometry();
      return img;
    },

    /*
     * The frame. Doom has already drawn into the image's own buffer, so there is nothing to copy —
     * publishing the address is the whole operation, and the page reads guest memory from there.
     */
    XPutImage: (_dpy, _drawable, _gc, img) => {
      const data = dv().getInt32(img + IMG_DATA, true);
      const w = dv().getInt32(img + IMG_WIDTH, true);
      const h = dv().getInt32(img + IMG_HEIGHT, true);
      state.imageData = data; state.width = w; state.height = h;
      publishGeometry();
      if (publish) Atomics.add(publish.ctrl, SLOT.FRAME, 1);
      // The frame boundary, which is where a host paces: XPutImage is exactly when an X client
      // presents, so blocking here is indistinguishable from a slower machine.
      if (onFrame) onFrame();
      return 0;
    },

    /*
     * MIT-SHM is refused. "No" is a supported answer — every X program of this era carries the
     * ordinary XImage path as its fallback — and it is far better than pretending to share memory
     * with a server that does not exist.
     */
    XShmQueryExtension: () => 0,       // "no extension" — the answer that selects the XImage path
    XShmGetEventBase: () => 0,
    XShmCreateImage: () => 0,
    /*
     * Attach and detach report SUCCESS, which is the truthful answer rather than a convenient one:
     * there is nothing attached, so detaching it cannot fail. Returning False sent Doom into
     * I_Error -> I_ShutdownGraphics -> I_Error until the stack ran out.
     */
    XShmAttach: () => 1,
    XShmDetach: () => 1,
    XShmPutImage: () => 1,

    /** The palette. XColor is { pixel, red, green, blue, flags, pad } with 16-bit components. */
    XStoreColors: (_dpy, _cmap, colors, n) => {
      for (let i = 0; i < (n | 0); i++) {
        const c = colors + i * 12;
        const pixel = dv().getInt32(c, true) & 0xff;
        state.palette[pixel * 3] = dv().getUint16(c + 4, true) >> 8;
        state.palette[pixel * 3 + 1] = dv().getUint16(c + 6, true) >> 8;
        state.palette[pixel * 3 + 2] = dv().getUint16(c + 8, true) >> 8;
      }
      if (publish) {
        publish.pal.set(state.palette);
        Atomics.store(publish.ctrl, SLOT.PENS, 256);
        Atomics.add(publish.ctrl, SLOT.PALGEN, 1);
      }
      return 0;
    },

    /*
     * Input. A keycode here is a PC scan code, because that is what the host has and what
     * XKeycodeToKeysym is asked to translate; the mapping to X keysyms lives below.
     */
    XPending: () => events.length + (keyboard ? keyboard.pending() : 0),

    XNextEvent: (_dpy, ev) => {
      M.u8.fill(0, ev, ev + 96);
      const e = events.shift() ?? (keyboard ? keyboard.next() : null)
        // An Expose when there is nothing else: XNextEvent BLOCKS on a real system, and a client that
        // waits for one must eventually get it. Returning a harmless redraw request is the closest
        // truthful answer available without a server to wait for.
        ?? { type: 12, count: 0 };
      if (e.type === 12) {
        dv().setInt32(ev, 12, true);                    // Expose
        dv().setInt32(ev + XEXPOSE_COUNT, 0, true);
        return 0;
      }
      dv().setInt32(ev, e.down ? 2 : 3, true);          // KeyPress / KeyRelease
      dv().setInt32(ev + XKEY_KEYCODE, e.scan, true);
      return 0;
    },
    XKeycodeToKeysym: (_dpy, code) => keysymFor(code | 0),

    /*
     * XLookupString, which is the OTHER way an X client asks what a key was -- and it was a stub
     * returning 0, so every client that uses it saw every key as nothing.
     *
     * Doom asks with XKeycodeToKeysym and worked from the first day; Quake II's XLateKey
     * (linux/rw_x11.c:447) asks with this one, and `keysym` is an OUT parameter it never wrote. Every
     * key therefore translated to 0, Quake II ignored all of them, and the game looked perfectly
     * healthy while being completely deaf: it rendered, it ran its server, it stood still.
     *
     * The real function fills in the keysym AND writes the composed characters into the caller's
     * buffer, returning how many. The printable range is the keysym itself, which is how X defines
     * the Latin-1 keysyms; anything else composes to no characters, and saying 0 there is not a
     * shortcut -- it is what a real Xlib answers for a function key.
     */
    XLookupString: (ev, buf, n, ksOut, _status) => {
      const scan = ev ? dv().getInt32(ev + XKEY_KEYCODE, true) : 0;
      const ks = keysymFor(scan);
      if (ksOut) dv().setInt32(ksOut, ks, true);
      if (!buf || (n | 0) <= 0) return 0;
      const printable = ks >= 0x20 && ks <= 0x7e;
      if (!printable) { M.u8[buf] = 0; return 0; }
      M.u8[buf] = ks;
      if ((n | 0) > 1) M.u8[buf + 1] = 0;
      return 1;
    },
  };

  function publishGeometry() {
    if (!publish || !state.imageData) return;
    Atomics.store(publish.ctrl, SLOT.WIDTH, state.width);
    Atomics.store(publish.ctrl, SLOT.HEIGHT, state.height);
    Atomics.store(publish.ctrl, SLOT.PIXELS, state.imageData);
    Atomics.store(publish.ctrl, SLOT.TEXTMODE, 0);
  }

  Object.assign(M.rt, api);
  return state;
}

/*
 * PC scan code -> X keysym, for the keys Doom names. Doom switches on keysyms (XK_Up, XK_Escape...),
 * and the host speaks scan codes, so the translation has to happen somewhere; Xlib is exactly where
 * it happens on a real system, so it happens here.
 */
const KEYSYM = {
  1: 0xff1b,   // Escape
  28: 0xff0d,  // Return
  15: 0xff09,  // Tab
  14: 0xff08,  // BackSpace
  57: 0x0020,  // space
  72: 0xff52, 80: 0xff54, 75: 0xff51, 77: 0xff53,   // Up Down Left Right
  29: 0xffe3,  // Control_L
  42: 0xffe1,  // Shift_L
  54: 0xffe2,  // Shift_R
  56: 0xffe9,  // Alt_L
  59: 0xffbe, 60: 0xffbf, 61: 0xffc0, 62: 0xffc1, 63: 0xffc2,   // F1..F5
  64: 0xffc3, 65: 0xffc4, 66: 0xffc5, 67: 0xffc6, 68: 0xffc7,   // F6..F10
  87: 0xffc8, 88: 0xffc9,                                        // F11 F12
  12: 0x002d,  // minus
  13: 0x003d,  // equal
  41: 0x007e,  // asciitilde
  83: 0xffff,  // Delete
};

function keysymFor(scan) {
  if (KEYSYM[scan] !== undefined) return KEYSYM[scan];
  // Letters and digits map to their ASCII keysym, which is what X does for the printable range.
  const ASCII = {
    2: 49, 3: 50, 4: 51, 5: 52, 6: 53, 7: 54, 8: 55, 9: 56, 10: 57, 11: 48,
    16: 113, 17: 119, 18: 101, 19: 114, 20: 116, 21: 121, 22: 117, 23: 105, 24: 111, 25: 112,
    30: 97, 31: 115, 32: 100, 33: 102, 34: 103, 35: 104, 36: 106, 37: 107, 38: 108,
    44: 122, 45: 120, 46: 99, 47: 118, 48: 98, 49: 110, 50: 109,
  };
  return ASCII[scan] ?? 0;
}
