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

import { keyNames } from './scancodes.js';
import { SLOT } from './webhost.js';
import { installX11Draw } from './x11-draw.js';

const DISPLAY = 0x7200_0001;      // the token XOpenDisplay hands back
const WINDOW = 0x7200_0002;
const COLORMAP = 0x7200_0003;

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
// XAnyEvent.window, and XExposeEvent's width and height (x and y at 20 and 24 stay 0).
const XANY_WINDOW = 16, XEXPOSE_WIDTH = 28, XEXPOSE_HEIGHT = 32;
/*
 * The pointer fields, from the same struct: `int x, y` at 32 and 36, `unsigned int state` at 48, and
 * at 52 either `keycode` (a key event) or `button` (a button event). XMotionEvent has a `char is_hint`
 * there instead, which nothing in this corpus reads.
 */
const XEV_X = 32, XEV_Y = 36, XEV_X_ROOT = 40, XEV_Y_ROOT = 44, XEV_STATE = 48, XEV_BUTTON = 52;
/* X numbers its buttons 1 left, 2 MIDDLE, 3 right, and its state mask starts at bit 8. */
const X_BUTTON_MASK = [0, 1 << 8, 1 << 9, 1 << 10];

/*
 * `font` is the VGA ROM's 8x16 glyphs, for the core drawing requests (src/env/x11-draw.js); without it
 * the server has no core font, as before. `windowed` makes the page the window manager: the window
 * gets a frame, a title and a place, and can be dragged and closed (the SLOT.WIN_* channel the Win32
 * host uses). A game on the shelf leaves it off and fills the screen.
 */
export function installX11(M, { publish = null, keyboard = null, mouse = null, onFrame = null, keys = keyNames(),
                                font = null, windowed = false, onTitle = null } = {}) {
  let peeked = null, errorHandler = 0;
  const pointerCtl = [2, 1, 4];
  const dv = () => M.mod.dv;

  // XImage, in the layout PRISM's own X11/Xlib.h declares. The two are one thing in two places.
  const IMG_WIDTH = 0, IMG_HEIGHT = 4, IMG_XOFF = 8, IMG_FORMAT = 12, IMG_DATA = 16,
        IMG_BYTE_ORDER = 20, IMG_BITMAP_UNIT = 24, IMG_BITMAP_BIT_ORDER = 28, IMG_BITMAP_PAD = 32,
        IMG_DEPTH = 36, IMG_BYTES_PER_LINE = 40, IMG_BITS_PER_PIXEL = 44, IMG_SIZE = 64;

  const state = { width: 0, height: 0, imageData: 0, palette: new Uint8Array(768),
                  // Interned atom names, and the window's own title when it sets one through ICCCM.
                  atoms: new Map(), windowName: '',
                  /*
                   * A VIRTUAL POINTER. X reports where the pointer IS; the host has only how far it
                   * moved. So the position is kept here, advanced by each delta and reset by
                   * XWarpPointer -- which is exactly the loop both games run, and it means their
                   * "subtract the centre" arithmetic works out to the delta they wanted.
                   */
                  pointer: { x: 0, y: 0 }, buttons: 0,
                  // The top-level window's geometry, and the WM protocols it asked for (WM_DELETE_WINDOW).
                  win: { x: 0, y: 0, w: 0, h: 0 }, protocols: [],
                  dgaMouse: false };         // XF86DGADirectMouse: motion is reported as deltas

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
    // The requests so far are on the screen: a frame, for a client that draws with requests.
    XSync: () => { if (present()) onFrame?.(); return 0; },
    XFlush: () => { if (present()) onFrame?.(); return 0; },
    XSynchronize: () => 0,
    XDefaultScreen: () => 0,
    XRootWindow: () => WINDOW,
    XCreateColormap: () => COLORMAP,
    XCreatePixmapCursor: () => 0,
    XDefineCursor: () => 0,
    XGrabPointer: () => 0,
    XUngrabPointer: () => 0,
    // GLQuake's GLX layer (gl_vidlinuxglx.c) grabs the keyboard and places its window; there is one
    // window and nothing else to take focus from, so each succeeds (GrabSuccess is 0).
    XGrabKeyboard: () => 0,
    XUngrabKeyboard: () => 0,
    XMoveWindow: () => 0,
    XRaiseWindow: () => 0,
    /*
     * XWarpPointer MOVES THE POINTER, and here that is the whole mechanism rather than a courtesy.
     *
     * Both games use the same idiom: read a MotionNotify's absolute x, subtract the window centre to
     * get a delta, then warp back to the centre so the next one is a delta too. If the warp did
     * nothing -- as this stub did -- the position would keep drifting and the "delta" would grow
     * without bound until the pointer pinned itself to an edge. Quake even turns PointerMotionMask
     * off around its warp (vid_x.c:889) precisely so the warp itself does not look like motion, so
     * this does not synthesise an event for it either.
     */
    XWarpPointer: (_dpy, _src, _dst, _sx, _sy, _sw, _sh, x, y) => {
      state.pointer.x = x | 0;
      state.pointer.y = y | 0;
      return 0;
    },
    XSelectInput: () => 0,
    XStoreName: (_d, _w, name) => { if (name) setTitle(M.mod.cstr(name)); return 0; },

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
    XSetWMProtocols: (_d, _w, atoms, n) => {
      state.protocols = Array.from({ length: n | 0 }, (_, i) => dv().getUint32(atoms + i * 4, true));
      return 1;
    },
    XConfigureWindow: () => 0,
    XUndefineCursor: () => 0,
    // Zeroed storage the caller owns, which is the whole contract. Quake writes flags into it and
    // frees it; handing back 0 would be a null dereference two lines later.
    XAllocWMHints: () => M.rt.calloc(1, 40),
    XAllocSizeHints: () => M.rt.calloc(1, 80),
    XAllocClassHint: () => M.rt.calloc(1, 8),
    XFree: (p) => { if (p) M.rt.free(p); return 1; },
    // The cut buffer: empty, as on a display nobody has copied anything to.
    XFetchBytes: (_d, n) => { if (n) dv().setInt32(n, 0, true); return 0; },
    XFreeFont: () => 1,
    /*
     * The window's NAME, which is the one part of this a page can act on: XTextProperty's first
     * field is the string. It goes where XStoreName's would, so a shell that shows a title shows
     * this one too.
     */
    XSetWMProperties: (_d, _w, namePtr) => {
      if (!namePtr) return 0;
      const str = M.mod.dv.getInt32(namePtr, true);
      if (str) setTitle(M.mod.cstr(str));
      return 0;
    },
    XSetWindowColormap: () => 0,
    XAutoRepeatOn: () => 0,
    XAutoRepeatOff: () => 0,
    XMapWindow: (_d, w) => { draw.map(w); events.push({ type: 12 /* Expose */, count: 0 }); return 0; },
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

    /*
     * ONE top-level window, whatever is asked: its size and background are kept (x11-draw.js gives it
     * pixels when something draws into it) and its place, for a page that frames it. XCreateWindow's
     * background is XSetWindowAttributes.background_pixel when CWBackPixel says it was set.
     */
    XCreateWindow: (_d, _parent, x, y, w, h, _border, _depth, _class, _visual, mask, attrs) =>
      makeWindow(x, y, w, h, attrs && (mask & (1 << 1)) ? dv().getUint32(attrs + 4, true) : 0),
    // The convenience form: a window with a border and a background, the same one window here.
    XCreateSimpleWindow: (_d, _parent, x, y, w, h, _bw, _border, background) => makeWindow(x, y, w, h, background),

    XCreateImage: (_dpy, _vis, depth, _fmt, _off, data, w, h, _pad, bpl) => {
      // Deeper than 8 bits is a TrueColor image, 32 bits a pixel; only such a client draws with one.
      if ((depth | 0) > 8) {
        const img = M.rt.calloc(1, IMG_SIZE);
        dv().setInt32(img + IMG_WIDTH, w | 0, true);
        dv().setInt32(img + IMG_HEIGHT, h | 0, true);
        dv().setInt32(img + IMG_DATA, data | 0, true);
        dv().setInt32(img + IMG_DEPTH, depth | 0, true);
        dv().setInt32(img + IMG_BYTES_PER_LINE, (bpl | 0) || (w | 0) * 4, true);
        dv().setInt32(img + IMG_BITS_PER_PIXEL, 32, true);
        dv().setInt32(img + IMG_FORMAT, 2, true);
        return img;
      }
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
    XPutImage: (_dpy, drawable, _gc, img, sx, sy, dx, dy, pw, ph) => {
      const data = dv().getInt32(img + IMG_DATA, true);
      const w = dv().getInt32(img + IMG_WIDTH, true);
      const h = dv().getInt32(img + IMG_HEIGHT, true);
      const bpp = dv().getInt32(img + IMG_BITS_PER_PIXEL, true);
      /*
       * Into the pixels of a drawable that has some -- a pixmap, or a window something has DRAWN into
       * -- the image is converted there. Only an 8-bit frame that is the whole window keeps the path
       * Doom has always taken: the page reads the image's own buffer, through the palette.
       */
      const target = draw.window(drawable);
      const whole = bpp === 8 && (!target?.window || (pw >>> 0) >= target.w && (ph >>> 0) >= target.h);
      if (target && (target.addr || !target.window || bpp !== 8) && !(whole && target.window)) {
        draw.putImage(drawable, data, w, h, dv().getInt32(img + IMG_BYTES_PER_LINE, true), bpp,
          sx | 0, sy | 0, dx | 0, dy | 0, pw >>> 0, ph >>> 0, state.palette);
        if (present()) onFrame?.();
        return 0;
      }
      surfaceMode = false;
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
    XPending: () => {
      pollManager();
      const n = (peeked ? 1 : 0) + events.length + (keyboard ? keyboard.pending() : 0) + (mousePending() ? 1 : 0);
      // A client that draws and polls has finished a frame when nothing is waiting for it.
      if (!n && present()) onFrame?.();
      return n;
    },
    // Every mode counts the same queue: there is no connection to flush or read from.
    XEventsQueued: (dpy) => M.rt.XPending(dpy),
    /*
     * XPeekEvent: the next event WITHOUT removing it. It is taken the way XNextEvent takes it, and the
     * 96 bytes kept, so the following XNextEvent hands back exactly what was peeked -- Quake III
     * peeks after a KeyRelease to see whether a KeyPress of the same key follows (auto-repeat).
     */
    XPeekEvent: (dpy, ev) => {
      // Kept only once taken: XNextEvent hands back a kept event first, so it must not see one yet.
      if (!peeked) { const tmp = M.rt.calloc(1, 96); M.rt.XNextEvent(dpy, tmp); peeked = M.u8.slice(tmp, tmp + 96); M.rt.free(tmp); }
      M.u8.set(peeked, ev);
      return 0;
    },
    /*
     * Errors: this server raises none, so a handler is recorded and never called; the text is what
     * Xlib prints for a code it has no name for.
     */
    XSetErrorHandler: (h) => { const old = errorHandler; errorHandler = h; return old; },
    XGetErrorText: (_dpy, code, buf, n) => {
      if (n > 0) { const b = new TextEncoder().encode(`X error ${code | 0}`.slice(0, n - 1)); M.u8.set(b, buf); M.u8[buf + b.length] = 0; }
      return 0;
    },
    // Pointer acceleration: the server's defaults (2/1 above 4 pixels), and a change is kept.
    XGetPointerControl: (_dpy, num, den, thr) => {
      if (num) dv().setInt32(num, pointerCtl[0], true); if (den) dv().setInt32(den, pointerCtl[1], true); if (thr) dv().setInt32(thr, pointerCtl[2], true);
      return 0;
    },
    XChangePointerControl: (_dpy, doAccel, doThr, num, den, thr) => { if (doAccel) { pointerCtl[0] = num; pointerCtl[1] = den; } if (doThr) pointerCtl[2] = thr; return 0; },
    // One thread here, so Xlib's thread support is trivially there.
    XInitThreads: () => 1,
    // The connection's descriptor: a number no file here uses. select() on it reports nothing ready,
    // which is true -- every event this server has is already in the queue XPending counts.
    XConnectionNumber: () => 1000,
    // TrueColor, so black is 0 and white every bit of the visual's 24.
    XBlackPixel: () => 0,
    XWhitePixel: () => 0xffffff,
    // A window manager would read these; there is none, and the window's size is set by XCreateWindow.
    XSetWMNormalHints: () => {},

    XNextEvent: (_dpy, ev) => {
      if (peeked) { M.u8.set(peeked, ev); peeked = null; return 0; }
      pollManager();
      if (present()) onFrame?.();
      M.u8.fill(0, ev, ev + 96);
      dv().setUint32(ev + XANY_WINDOW, WINDOW, true);
      /*
       * The POINTER first, and before the keyboard, because a game reads its mouse every frame and
       * its keys occasionally: leaving motion behind a queue of keystrokes would make aiming lag
       * behind typing. A synthesised event is built here rather than pushed into `events` so that no
       * motion is ever stale -- it carries the position as of the moment the client asked.
       */
      const m = takeMouseEvent();
      if (m) {
        dv().setInt32(ev, m.type, true);
        /*
         * Under the DGA mouse (XF86DGADirectMouse, src/env/glx.js) a MotionNotify carries how far
         * the pointer MOVED, in x and y and in x_root and y_root alike -- GLQuake reads the first
         * pair, Quake III and Enemy Territory the second -- and there is no position to keep.
         */
        if (m.relative) {
          dv().setInt32(ev + XEV_X, m.dx, true); dv().setInt32(ev + XEV_Y, m.dy, true);
          dv().setInt32(ev + XEV_X_ROOT, m.dx, true); dv().setInt32(ev + XEV_Y_ROOT, m.dy, true);
          dv().setInt32(ev + XEV_STATE, m.state, true);
          return 0;
        }
        dv().setInt32(ev + XEV_X, state.pointer.x, true);
        dv().setInt32(ev + XEV_Y, state.pointer.y, true);
        dv().setInt32(ev + XEV_STATE, m.state, true);
        if (m.button) dv().setInt32(ev + XEV_BUTTON, m.button, true);
        return 0;
      }
      const e = events.shift() ?? (keyboard ? keyboard.next() : null)
        // An Expose when there is nothing else: XNextEvent BLOCKS on a real system, and a client that
        // waits for one must eventually get it. Returning a harmless redraw request is the closest
        // truthful answer available without a server to wait for.
        ?? idleExpose();
      if (e.type === 12) {
        dv().setInt32(ev, 12, true);                    // Expose
        dv().setInt32(ev + XEXPOSE_COUNT, 0, true);
        dv().setInt32(ev + XEXPOSE_WIDTH, state.win.w, true);
        dv().setInt32(ev + XEXPOSE_HEIGHT, state.win.h, true);
        return 0;
      }
      if (e.type === 22) {                              // ConfigureNotify, after a drag
        dv().setInt32(ev, 22, true);
        dv().setUint32(ev + 20, WINDOW, true);          // xconfigure.window
        for (const [k, o] of [['x', 24], ['y', 28], ['w', 32], ['h', 36]]) dv().setInt32(ev + o, state.win[k], true);
        return 0;
      }
      if (e.type === 33) {                              // ClientMessage: WM_PROTOCOLS / WM_DELETE_WINDOW
        dv().setInt32(ev, 33, true);
        dv().setUint32(ev + 20, M.rt.XInternAtom(0, scratchString('WM_PROTOCOLS')), true);
        dv().setInt32(ev + 24, 32, true);
        dv().setUint32(ev + 28, e.atom, true);
        return 0;
      }
      dv().setInt32(ev, e.down ? 2 : 3, true);          // KeyPress / KeyRelease
      dv().setInt32(ev + XKEY_KEYCODE, e.scan, true);
      keys.note(e.scan, e.ascii ?? 0, e.down);
      return 0;
    },
    XKeycodeToKeysym: (_dpy, code) => keys.sym(code | 0) || keysymFor(code | 0),

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
    // The keysym of a key event's keycode, the same table XLookupString reads (index 0: unshifted).
    XLookupKeysym: (ev) => { const scan = ev ? dv().getInt32(ev + XKEY_KEYCODE, true) : 0; return keys.sym(scan) || keysymFor(scan); },
    XLookupString: (ev, buf, n, ksOut, _status) => {
      const scan = ev ? dv().getInt32(ev + XKEY_KEYCODE, true) : 0;
      // With the visitor's layout, what the key typed, shift included, as XLookupString composes it.
      const ks = keys.char(scan) || keysymFor(scan);
      if (ksOut) dv().setInt32(ksOut, ks, true);
      if (!buf || (n | 0) <= 0) return 0;
      const printable = ks >= 0x20 && ks <= 0x7e;
      if (!printable) { M.u8[buf] = 0; return 0; }
      M.u8[buf] = ks;
      if ((n | 0) > 1) M.u8[buf + 1] = 0;
      return 1;
    },
  };

  /*
   * WHAT THE POINTER HAS TO SAY, as one event at a time.
   *
   * Buttons are edges here even though the channel carries a level, because X sends ButtonPress and
   * ButtonRelease and a client counts them (Doom's `event.data1` is built from the STATE mask, but
   * Quake's `case ButtonPress` is an edge). Comparing against the last mask turns one into the other,
   * and one button changes per event because that is what a real server sends.
   */
  function pendingButtonChange() {
    if (!mouse) return 0;
    const now = mouse.state();
    return now ^ state.buttons;                 // bits that differ; 0 when nothing changed
  }
  const mousePending = () => !!mouse && (pendingButtonChange() !== 0 || pointerMoved() || mouseHasMotion());
  /* A page that reports WHERE the pointer is (Live C, no capture): the position is the event. */
  function pointerMoved() {
    const at = mouse.position?.();
    return !!at && (at.x !== state.pointer.x || at.y !== state.pointer.y);
  }

  let carriedDx = 0, carriedDy = 0;
  function mouseHasMotion() {
    if (carriedDx || carriedDy) return true;
    const { dx, dy } = mouse.take();
    carriedDx += dx; carriedDy += dy;
    return !!(carriedDx || carriedDy);
  }

  /** X's `state` mask for the buttons currently down, from the channel's INT 33h bit order. */
  function stateMask(mask) {
    return ((mask & 1) ? X_BUTTON_MASK[1] : 0)      // left  -> X button 1
         | ((mask & 4) ? X_BUTTON_MASK[2] : 0)      // middle-> X button 2
         | ((mask & 2) ? X_BUTTON_MASK[3] : 0);     // right -> X button 3
  }

  function takeMouseEvent() {
    if (!mouse) return null;
    // A button change first: a click that arrived with a movement must not be delayed behind it.
    const changed = pendingButtonChange();
    if (changed) {
      const bit = changed & -changed;             // lowest differing bit, one event at a time
      const at = mouse.position?.();               // a click lands where the visible pointer is
      if (at) { state.pointer.x = at.x; state.pointer.y = at.y; }
      const now = mouse.state();
      state.buttons ^= bit;
      const button = bit === 1 ? 1 : bit === 2 ? 3 : 2;   // left, right, middle -> X's 1, 3, 2
      return { type: (now & bit) ? 4 : 5, button, state: stateMask(state.buttons) };  // Press / Release
    }
    if (pointerMoved()) {
      const at = mouse.position();
      state.pointer.x = at.x; state.pointer.y = at.y;
      return { type: 6, button: 0, state: stateMask(state.buttons) };                 // MotionNotify
    }
    if (!mouseHasMotion()) return null;
    if (state.dgaMouse) {
      const m = { type: 6, button: 0, state: stateMask(state.buttons), relative: true, dx: carriedDx, dy: carriedDy };
      carriedDx = 0; carriedDy = 0;
      return m;
    }
    state.pointer.x += carriedDx;
    state.pointer.y += carriedDy;
    carriedDx = 0; carriedDy = 0;
    return { type: 6, button: 0, state: stateMask(state.buttons) };                   // MotionNotify
  }

  /*
   * THE DRAWING HALF and what ties it to the page. A client that draws with requests has its frame
   * in the window's surface; `present` publishes it when something was drawn since the last time,
   * and says so, so the caller can pace there -- that is the frame boundary for such a client.
   */
  const draw = installX11Draw(M, { font });
  let surfaceMode = false, title = '';
  Object.assign(api, draw.api);
  // The top-level window's pixels, for a tool that wants the picture without a page (rosetta-run).
  state.window = () => draw.window(WINDOW);
  function present() {
    if (!draw.takeDirty()) return false;
    const d = draw.window(WINDOW);
    if (!publish || !d?.addr) return false;
    surfaceMode = true;
    Atomics.store(publish.ctrl, SLOT.WIDTH, d.w);
    Atomics.store(publish.ctrl, SLOT.HEIGHT, d.h);
    Atomics.store(publish.ctrl, SLOT.PIXELS, d.addr);
    Atomics.store(publish.ctrl, SLOT.PIXFMT, 32);
    Atomics.store(publish.ctrl, SLOT.TEXTMODE, 0);
    Atomics.add(publish.ctrl, SLOT.FRAME, 1);
    return true;
  }
  function makeWindow(x, y, w, h, background) {
    Object.assign(state.win, { x: x | 0, y: y | 0, w: w >>> 0, h: h >>> 0 });
    draw.addWindow(WINDOW, w >>> 0, h >>> 0, background >>> 0);
    publishWindow();
    return WINDOW;
  }
  function setTitle(name) {
    state.windowName = name;
    if (name !== title) { title = name; onTitle?.(name); }
  }
  /* The page as window manager: the frame's place and size, then what the person did to it. */
  let lastDrag = 0;
  function publishWindow() {
    if (!publish || !windowed) return;
    Atomics.store(publish.ctrl, SLOT.WIN_X, state.win.x);
    Atomics.store(publish.ctrl, SLOT.WIN_Y, state.win.y);
    Atomics.store(publish.ctrl, SLOT.WIN_W, state.win.w);
    Atomics.store(publish.ctrl, SLOT.WIN_H, state.win.h);
    Atomics.store(publish.ctrl, SLOT.WIN_HAS, 1);
  }
  function pollManager() {
    if (!publish || !windowed) return;
    const gen = Atomics.load(publish.ctrl, SLOT.DRAG_GEN);
    if (gen !== lastDrag) {
      lastDrag = gen;
      state.win.x = Atomics.load(publish.ctrl, SLOT.DRAG_X);
      state.win.y = Atomics.load(publish.ctrl, SLOT.DRAG_Y);
      publishWindow();
      events.push({ type: 22 });
    }
    if (Atomics.load(publish.ctrl, SLOT.WIN_CLOSE)) {
      Atomics.store(publish.ctrl, SLOT.WIN_CLOSE, 0);
      /*
       * A window manager ASKS a client that took part in WM_DELETE_WINDOW, and otherwise ends its
       * connection -- after which Xlib's I/O error handler exits the program. Both, as here.
       */
      const del = state.atoms.get('WM_DELETE_WINDOW');
      if (del && state.protocols.includes(del)) events.push({ type: 33, atom: del });
      else M.rt.exit(1);
    }
  }
  /*
   * Nothing to deliver: a real XNextEvent blocks, so this one stands in an Expose -- and, for a client
   * that draws, waits a frame first, or its redraw-on-Expose loop would spin as fast as it could.
   */
  function idleExpose() {
    if (surfaceMode) onFrame?.();
    return { type: 12, count: 0 };
  }
  let scratch = 0;
  function scratchString(s) {
    if (!scratch) scratch = M.rt.malloc(64);
    for (let i = 0; i < s.length; i++) M.u8[scratch + i] = s.charCodeAt(i);
    M.u8[scratch + s.length] = 0;
    return scratch;
  }

  function publishGeometry() {
    if (!publish || !state.imageData) return;
    if (surfaceMode) return;
    Atomics.store(publish.ctrl, SLOT.PIXFMT, 0);
    /*
     * The pointer starts at the CENTRE, because that is where these games warp it to and what they
     * subtract from. Starting at 0,0 would make the first MotionNotify report a delta of half the
     * screen -- one enormous spin before anything settled.
     */
    if (!state.pointer.x && !state.pointer.y) {
      state.pointer.x = state.width >> 1;
      state.pointer.y = state.height >> 1;
    }
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
