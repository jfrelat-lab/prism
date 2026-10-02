// wgl.js — the host side of src/env/opengl32.c: size gl.js's framebuffer, and present each SwapBuffers.
//
// opengl32.c is the Win32 API in C (its contracts are structs); what it cannot do in C is reach the
// GL layer and the page, so it calls these two. The options are fxmesa.js's: a gate takes frames by
// number (frames + onFrame), the page reads every one (onSwap).
export function installWgl(M, { frames = null, onFrame = null, onSwap = null } = {}) {
  const gl = M.gl;
  if (!gl) throw new Error('wgl: needs the gl environment');
  const want = frames ? new Set(frames) : null;
  const last = frames ? Math.max(...frames) : Infinity;
  const s = { swaps: 0 };
  Object.assign(M.rt, {
    // Made current again after a mode change: resize only when the window's client area changed.
    prism_wgl_resize: (w, h) => { if (gl.state.width !== w || gl.state.height !== h) gl.resize(w, h); },
    prism_wgl_swap: () => {
      if (want?.has(s.swaps) && onFrame) onFrame(s.swaps, gl.readPixels(), gl.state.width, gl.state.height);
      if (onSwap) onSwap(s.swaps, gl);
      if (s.swaps++ >= last) throw new Error('__wgl_done');
    },
  });
  M.wgl = s;
  return s;
}

export function wglBuiltins(T) {
  const I = T.INT, V = T.VOID;
  return { prism_wgl_resize: { ret: V, params: [I, I] }, prism_wgl_swap: { ret: V, params: [] } };
}
