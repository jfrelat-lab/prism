// sdl2gl.js — OpenGL for an SDL 2 program: a window made with SDL_WINDOW_OPENGL draws through
// src/env/gl.js, and SDL_GL_SwapWindow publishes the frame, as SDL 1.2's SDL_OPENGL video mode does
// in src/env/sdl12.js.
//
// An environment of its own rather than part of sdl2.js, because of SDL_GL_GetProcAddress: a pointer
// to a GL entry point exists only where C takes its address, so the lookup is C (SDL2GL_VARS, like
// src/env/opengl32.c's wglGetProcAddress), and C that names GL functions links only in a program that
// has the gl environment. OpenTyrian and SDLPoP name sdl2 without gl, and keep doing so.
//
// The values of the GL attributes and flags are SDL 2's own (SDL_video.h, read in the oracle).

const SDL_WINDOW_OPENGL = 0x2;
const ATTR = { RED: 0, GREEN: 1, BLUE: 2, ALPHA: 3, BUFFER: 4, DOUBLEBUFFER: 5, DEPTH: 6, STENCIL: 7,
  STEREO: 12, MULTISAMPLEBUFFERS: 13, MULTISAMPLESAMPLES: 14, ACCELERATED: 15, MAJOR: 17, MINOR: 18 };

export function installSDL2GL(M) {
  const sdl = M.sdl, dv = () => M.mod.dv;
  if (!sdl) throw new Error('sdl2gl: the sdl2 environment must be installed first');
  if (!M.gl) throw new Error('sdl2gl: the gl environment must be installed first');
  const asked = new Map();
  let context = 0, interval = 0;
  const out = { onSwap: null, get context() { return context; } };

  /*
   * What a context has, whatever was asked: 8 bits of red, green and blue on an opaque canvas, a
   * 24-bit depth buffer, the stencil bits asked for (gl.js makes them on request), no multisampling,
   * double-buffered. GL 1.1 is what gl.js says it is.
   */
  const actual = (a) => {
    switch (a) {
      case ATTR.RED: case ATTR.GREEN: case ATTR.BLUE: return 8;
      case ATTR.ALPHA: case ATTR.STEREO: case ATTR.MULTISAMPLEBUFFERS: case ATTR.MULTISAMPLESAMPLES: return 0;
      case ATTR.BUFFER: return 24;
      case ATTR.DOUBLEBUFFER: case ATTR.ACCELERATED: return 1;
      case ATTR.DEPTH: return 24;
      case ATTR.STENCIL: return asked.get(ATTR.STENCIL) ? 8 : 0;
      case ATTR.MAJOR: case ATTR.MINOR: return 1;
      default: return asked.get(a) ?? 0;
    }
  };

  // The window: an OpenGL one sizes gl.js's framebuffer; any other is sdl2.js's as before.
  const createWindow = M.rt.SDL_CreateWindow;
  M.rt.SDL_CreateWindow = (t, x, y, w, h, flags) => {
    const win = createWindow(t, x, y, w, h, flags);
    if ((flags >>> 0) & SDL_WINDOW_OPENGL) sdl.opengl = true;
    return win;
  };
  const setSize = M.rt.SDL_SetWindowSize;
  M.rt.SDL_SetWindowSize = (win, w, h) => { setSize(win, w, h); if (context) M.gl.resize(sdl.winW, sdl.winH); };

  Object.assign(M.rt, {
    SDL_GL_LoadLibrary: () => 0,
    SDL_GL_UnloadLibrary: () => {},
    SDL_GL_ResetAttributes: () => { asked.clear(); },
    SDL_GL_SetAttribute: (a, v) => { asked.set(a, v); return 0; },
    SDL_GL_GetAttribute: (a, p) => { if (p) dv().setInt32(p, actual(a), true); return 0; },
    SDL_GL_CreateContext: () => {
      if (!sdl.opengl) { sdl.error = M.mod.intern([...new TextEncoder().encode('The specified window isn\'t an OpenGL window'), 0]); return 0; }
      M.gl.stencilBits = actual(ATTR.STENCIL);
      M.gl.resize(sdl.winW, sdl.winH);
      return (context = 0x51700000);
    },
    SDL_GL_MakeCurrent: () => 0,
    SDL_GL_GetCurrentContext: () => context,
    SDL_GL_GetCurrentWindow: () => (context ? sdl.window : 0),
    SDL_GL_DeleteContext: () => { context = 0; },
    SDL_GL_SetSwapInterval: (n) => { interval = n | 0; return 0; },
    SDL_GL_GetSwapInterval: () => interval,
    SDL_GL_ExtensionSupported: (namePtr) => {
      const list = M.mod.cstr(M.rt.glGetString(0x1f03)).split(' ');
      return list.includes(M.mod.cstr(namePtr)) ? 1 : 0;
    },
    // A frame: what was drawn is published, and the window system's events are read.
    SDL_GL_SwapWindow: () => { sdl.pump?.(); if (out.onSwap) out.onSwap(M.gl); },
  });
  return out;
}

export function sdl2glBuiltins(T) {
  const P = T.ptr(T.CHAR), I = T.INT, V = T.VOID;
  const f = (ret, ...params) => ({ ret, params });
  return {
    SDL_GL_LoadLibrary: f(I, P), SDL_GL_UnloadLibrary: f(V), SDL_GL_ResetAttributes: f(V),
    SDL_GL_SetAttribute: f(I, I, I), SDL_GL_GetAttribute: f(I, I, P),
    SDL_GL_CreateContext: f(P, P), SDL_GL_MakeCurrent: f(I, P, P), SDL_GL_GetCurrentContext: f(P),
    SDL_GL_GetCurrentWindow: f(P), SDL_GL_DeleteContext: f(V, P),
    SDL_GL_SetSwapInterval: f(I, I), SDL_GL_GetSwapInterval: f(I),
    SDL_GL_ExtensionSupported: f(I, P), SDL_GL_SwapWindow: f(V, P),
  };
}

/*
 * SDL_GL_GetProcAddress, in C: the entry points gl.js implements beyond GL 1.1, by their ARB names
 * and by the core names they became (the same functions). NULL for anything else, as SDL answers for
 * a name the driver does not export -- a program that checks the extension string first never asks.
 */
export const SDL2GL_VARS = `
#define GL_GLEXT_PROTOTYPES
#include <GL/gl.h>
#include <GL/glext.h>
#include <string.h>
static int prism_gl_named(const char *proc, const char *arb)
{
    size_t n = strlen(arb) - 3;                 /* the core name is the ARB one without its suffix */
    return !strcmp(proc, arb) || (strlen(proc) == n && !strncmp(proc, arb, n));
}
void *SDL_GL_GetProcAddress(const char *proc)
{
    if (!proc) return 0;
    if (prism_gl_named(proc, "glActiveTextureARB")) return (void *)glActiveTextureARB;
    if (prism_gl_named(proc, "glClientActiveTextureARB")) return (void *)glClientActiveTextureARB;
    if (prism_gl_named(proc, "glGenBuffersARB")) return (void *)glGenBuffersARB;
    if (prism_gl_named(proc, "glBindBufferARB")) return (void *)glBindBufferARB;
    if (prism_gl_named(proc, "glBufferDataARB")) return (void *)glBufferDataARB;
    if (prism_gl_named(proc, "glBufferSubDataARB")) return (void *)glBufferSubDataARB;
    if (prism_gl_named(proc, "glDeleteBuffersARB")) return (void *)glDeleteBuffersARB;
    if (prism_gl_named(proc, "glIsBufferARB")) return (void *)glIsBufferARB;
    if (prism_gl_named(proc, "glPointParameterfARB")) return (void *)glPointParameterfARB;
    if (prism_gl_named(proc, "glPointParameterfvARB")) return (void *)glPointParameterfvARB;
    if (!strcmp(proc, "glLockArraysEXT")) return (void *)glLockArraysEXT;
    if (!strcmp(proc, "glUnlockArraysEXT")) return (void *)glUnlockArraysEXT;
    return 0;
}
`;
