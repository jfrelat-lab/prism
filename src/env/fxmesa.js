// fxmesa.js — Mesa's 3Dfx context API (fxMesa*), on src/env/gl.js: the window system of id's own
// Linux GL renderer.
//
// Quake II 3.19's linux/Makefile.i386 builds ref_gl.so from the GL renderer plus linux/gl_fxmesa.c,
// which opens a FULL-SCREEN context on a 3Dfx card through Mesa's fxMesa calls -- there is no GLX in
// that build at all -- and reads the keyboard and mouse through svgalib (linux/rw_in_svgalib.c, on
// src/env/svgalib.js). Four calls: CreateContext takes a Glide resolution and answers a context;
// MakeCurrent sizes gl.js's framebuffer to that resolution; SwapBuffers is the frame boundary (a
// host's `onSwap`, a gate's `frames`/`onFrame`), as glx.js's is; DestroyContext forgets it.
//
// The GR_ and FXMESA_ values are Glide 2's and Mesa 3's, from those headers' public text. Neither
// header exists in the oracle container, so no gate holds them to an original; what keeps them honest
// is that only this file reads them, through the same table the header defines.

export const GR_RESOLUTIONS = { 0: [320, 200], 1: [320, 240], 2: [400, 256], 3: [512, 384], 4: [640, 200], 5: [640, 350], 6: [640, 400], 7: [640, 480], 8: [800, 600] };

export const FXMESA_H = `#ifndef _PRISM_FXMESA_H
#define _PRISM_FXMESA_H
#include <GL/gl.h>
typedef int GrScreenResolution_t;
typedef int GrScreenRefresh_t;
#define GR_RESOLUTION_320x200 0x0
#define GR_RESOLUTION_320x240 0x1
#define GR_RESOLUTION_400x256 0x2
#define GR_RESOLUTION_512x384 0x3
#define GR_RESOLUTION_640x200 0x4
#define GR_RESOLUTION_640x350 0x5
#define GR_RESOLUTION_640x400 0x6
#define GR_RESOLUTION_640x480 0x7
#define GR_RESOLUTION_800x600 0x8
#define GR_REFRESH_60Hz 0x0
#define GR_REFRESH_70Hz 0x1
#define GR_REFRESH_72Hz 0x2
#define GR_REFRESH_75Hz 0x3
#define FXMESA_NONE 0
#define FXMESA_DOUBLEBUFFER 10
#define FXMESA_ALPHA_SIZE 11
#define FXMESA_DEPTH_SIZE 12
#define FXMESA_STENCIL_SIZE 13
#define FXMESA_ACCUM_SIZE 14
typedef struct tfxMesaContext *fxMesaContext;
fxMesaContext fxMesaCreateContext(GLuint win, GrScreenResolution_t res, GrScreenRefresh_t ref, const GLint attribList[]);
void fxMesaMakeCurrent(fxMesaContext ctx);
void fxMesaSwapBuffers(void);
void fxMesaDestroyContext(fxMesaContext ctx);
#endif
`;

export function installFxMesa(M, { frames = null, onFrame = null, onSwap = null } = {}) {
  const gl = M.gl;
  if (!gl) throw new Error('fxmesa: needs the gl environment');
  const want = frames ? new Set(frames) : null;
  const last = frames ? Math.max(...frames) : Infinity;
  const s = { swaps: 0, size: null, current: false };
  Object.assign(M.rt, {
    fxMesaCreateContext: (_win, res) => {
      const size = GR_RESOLUTIONS[res];
      if (!size) return 0;                          // an unknown resolution: no context, as fxMesa says
      s.size = size;
      return 1;
    },
    fxMesaMakeCurrent: (ctx) => {
      if (ctx && s.size && !s.current) { gl.resize(s.size[0], s.size[1]); s.current = true; }
    },
    fxMesaSwapBuffers: () => {
      if (want?.has(s.swaps) && onFrame) onFrame(s.swaps, gl.readPixels(), gl.state.width, gl.state.height);
      if (onSwap) onSwap(s.swaps, gl);
      if (s.swaps++ >= last) throw new Error('__fxmesa_done');
    },
    fxMesaDestroyContext: () => { s.current = false; },
  });
  M.fxmesa = s;
  return s;
}

export function fxmesaBuiltins(T) {
  const I = T.INT, U = T.UINT, V = T.VOID, P = T.ptr(T.CHAR);
  const f = (ret, ...params) => ({ ret, params });
  return {
    fxMesaCreateContext: f(P, U, I, I, P), fxMesaMakeCurrent: f(V, P), fxMesaSwapBuffers: f(V), fxMesaDestroyContext: f(V, P),
  };
}
