// glx.js — GLX for an X client that draws with GL, on src/env/gl.js and the X11 shim.
//
// GLX is the seam between an X window and a GL context, and here both are PRISM's, so the seam is
// thin: glXChooseVisual answers one TrueColor visual, glXCreateContext a handle, glXMakeCurrent
// sizes gl.js's framebuffer to the window it is bound to (the size its XCreateWindow asked for), and
// glXSwapBuffers is the frame boundary -- where a host takes the picture (`onSwap`), and where a gate
// takes the frames it asked for (`frames`, `onFrame(index, rgba, w, h)`), as glut.js does.
//
// The XFree86 VidMode and DGA extensions GLQuake's platform layer names are answered "not present"
// by their QueryVersion, which is the case the program is written to handle; their other entry points
// refuse, because a program that called them after that answer would be relying on something no X
// server here offers.

export function installGlx(M, { frames = null, onFrame = null, onSwap = null } = {}) {
  const gl = M.gl;
  if (!gl) throw new Error('glx: needs the gl environment');
  const want = frames ? new Set(frames) : null;
  const last = frames ? Math.max(...frames) : Infinity;
  const s = { swaps: 0, window: { w: 640, h: 480 }, current: false };
  const dv = () => M.mod.dv;
  // The window size comes from the program's own XCreateWindow(dpy, parent, x, y, w, h, ...).
  const createWindow = M.rt.XCreateWindow;
  M.rt.XCreateWindow = (...a) => { s.window = { w: a[4] | 0, h: a[5] | 0 }; return createWindow(...a); };
  const refuse = (name) => () => { throw new Error(`glx: ${name} after its QueryVersion answered "not present"`); };
  /*
   * The gamma ramp, as a server with the VidMode extension keeps it: 256 entries a channel, identity until
   * a program sets one, which is kept (s.gammaRamp) for a host to apply. Doom 3's glimp.cpp calls these
   * without asking QueryVersion and reads the ramp size into an uninitialised local, so a display that
   * answered "missing" left it a garbage size, a NULL malloc and a resample written from address 0 over
   * the engine's statics. Every X server of its day had the extension; this answers as one did.
   */
  const RAMP = 256;
  const ramp = () => (s.gammaRamp ??= [0, 1, 2].map(() => Uint16Array.from({ length: RAMP }, (_, i) => i * 257)));
  const gammaRampSize = (_dpy, _screen, out) => { if (out) dv().setInt32(out, RAMP, true); return 1; };
  const getGammaRamp = (_dpy, _screen, size, r, g, b) => {
    if (size !== RAMP) return 0;
    [r, g, b].forEach((p, c) => { if (p) ramp()[c].forEach((v, i) => dv().setUint16(p + 2 * i, v, true)); });
    return 1;
  };
  const setGammaRamp = (_dpy, _screen, size, r, g, b) => {
    if (size !== RAMP) return 0;
    [r, g, b].forEach((p, c) => { if (p) for (let i = 0; i < RAMP; i++) ramp()[c][i] = dv().getUint16(p + 2 * i, true); });
    return 1;
  };
  Object.assign(M.rt, {
    /*
     * GLX 1.4's glXGetProcAddressARB: the address of a GL entry point this environment implements --
     * bound as dlsym binds libGL's (src/env/dl.js), under the library's own name -- and NULL for any
     * other, as for an extension the driver does not have. Doom 3's glimp_dlopen takes it from libGL
     * with dlsym and asks it for every extension function the GL_EXTENSIONS string advertised.
     */
    glXGetProcAddressARB: (namePtr) => {
      const name = namePtr ? M.mod.cstr(namePtr) : '';
      if (!/^gl/.test(name) || typeof M.rt[name] !== 'function') return 0;
      const link = `libGL.so$${name}`, known = M.mod.funcs.get(link);
      return (known?.fn ? known : M.mod.bindFunc(link, M.rt[name])).addr;
    },
    glXChooseVisual: () => {
      const vi = M.rt.malloc(40);                    // XVisualInfo, i386: 40 bytes, depth at 12
      for (let k = 0; k < 40; k += 4) dv().setInt32(vi + k, 0, true);
      dv().setInt32(vi + 12, 24, true);             // depth
      dv().setInt32(vi + 16, 4, true);              // class TrueColor
      dv().setUint32(vi + 20, 0xff0000, true); dv().setUint32(vi + 24, 0x00ff00, true); dv().setUint32(vi + 28, 0x0000ff, true);
      dv().setInt32(vi + 32, 256, true); dv().setInt32(vi + 36, 8, true);
      return vi;
    },
    glXCreateContext: () => 1,
    glXMakeCurrent: (_d, _w, ctx) => {
      // Again whenever the window bound now has another size: ET's vid_restart destroys its 800x600
      // window and context and makes a 1024x768 pair current, and a framebuffer sized only once
      // left the game drawing 1024x768 into 800x600 (the top of its menu cut off).
      if (ctx && (!s.current || gl.state.width !== s.window.w || gl.state.height !== s.window.h)) {
        gl.resize(s.window.w, s.window.h); s.current = true;
      }
      return 1;
    },
    glXSwapBuffers: () => {
      if (want?.has(s.swaps) && onFrame) onFrame(s.swaps, gl.readPixels(), gl.state.width, gl.state.height);
      if (onSwap) onSwap(s.swaps, gl);
      if (s.swaps++ >= last) throw new Error('__glx_done');
    },
    glXDestroyContext: () => {},
    XF86VidModeQueryVersion: () => 0,
    /*
     * THE DGA MOUSE. XFree86-DGA is how these games read a mouse by default (in_dgamouse 1 in
     * GLQuake, Quake III and Enemy Territory): the server reports relative motion and the pointer
     * stops being a position. Refusing it sent them to their fallback, which warps the pointer to
     * the centre and waits for the motion event a real server sends for the warp -- one this Xlib
     * does not send -- so Enemy Territory's menu cursor never left the corner. Only the mouse
     * part is here: DirectVideo with any other flag is refused.
     */
    XF86DGAQueryVersion: (_dpy, major, minor) => {
      if (major) dv().setInt32(major, 1, true);
      if (minor) dv().setInt32(minor, 0, true);
      return 1;
    },
    XF86VidModeGetAllModeLines: refuse('XF86VidModeGetAllModeLines'),
    XF86VidModeSwitchToMode: refuse('XF86VidModeSwitchToMode'),
    XF86VidModeSetViewPort: refuse('XF86VidModeSetViewPort'),
    // the ramp calls (see RAMP above); the 1.0 gamma triple is still refused
    XF86VidModeGetGamma: refuse('XF86VidModeGetGamma'), XF86VidModeSetGamma: refuse('XF86VidModeSetGamma'),
    XF86VidModeGetGammaRampSize: gammaRampSize, XF86VidModeGetGammaRamp: getGammaRamp, XF86VidModeSetGammaRamp: setGammaRamp,
    XF86DGADirectVideo: (_dpy, _screen, flags) => {
      if (flags & ~0x4) throw new Error(`glx: XF86DGADirectVideo with flags 0x${(flags >>> 0).toString(16)}: only the DGA mouse is implemented`);
      if (M.x11) M.x11.dgaMouse = (flags & 0x4) !== 0;         // XF86DGADirectMouse
      return 1;
    },
  });
  M.glx = s;
  return s;
}

export function glxBuiltins(T) {
  const I = T.INT, V = T.VOID, P = T.ptr(T.CHAR), U = T.UINT;
  const f = (ret, ...params) => ({ ret, params });
  return {
    glXGetProcAddressARB: f(P, P), glXChooseVisual: f(P, P, I, P), glXCreateContext: f(P, P, P, P, I), glXMakeCurrent: f(I, P, U, P),
    glXSwapBuffers: f(V, P, U), glXDestroyContext: f(V, P, P),
    XF86VidModeQueryVersion: f(I, P, P, P), XF86DGAQueryVersion: f(I, P, P, P),
    XF86VidModeGetAllModeLines: f(I, P, I, P, P), XF86VidModeSwitchToMode: f(I, P, I, P),
    XF86VidModeSetViewPort: f(I, P, I, I, I), XF86VidModeGetGamma: f(I, P, I, P), XF86VidModeSetGamma: f(I, P, I, P),
    XF86VidModeGetGammaRampSize: f(I, P, I, P), XF86VidModeGetGammaRamp: f(I, P, I, I, P, P, P), XF86VidModeSetGammaRamp: f(I, P, I, I, P, P, P), XF86DGADirectVideo: f(I, P, I, I),
  };
}
