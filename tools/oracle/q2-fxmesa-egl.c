/*
 * q2-fxmesa-egl.c -- what Quake II's Linux GL build links against besides GL, for the oracle: Mesa's
 * fxMesa context calls on a surfaceless EGL context and a framebuffer object, svgalib's keyboard and
 * mouse answering as PRISM's shim answers headless (no keys, no mouse), and a fixed clock.
 *
 * The REFERENCE side of tools/gate-quake2-gl.mjs. It is linked into the quake2 executable with
 * -rdynamic, so ref_gl.so -- built from REF_GL_OBJS as linux/Makefile.i386 builds it -- resolves its
 * fxMesa* and keyboard_ and mouse_ calls here, and its gl* calls in Mesa.
 *
 *   __wrap_Sys_Milliseconds (-Wl,--wrap=Sys_Milliseconds): PRISM_Q2_STEP ms per call (default 25),
 *     and curtime set as q_shlinux.c sets it, so the client's frame loop runs the same frames.
 *   PRISM_Q2_SWAP=N: the picture of the N-th fxMesaSwapBuffers (from 0) is written as frame.ppm,
 *     top row first, and the program exits.
 */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#define GL_GLEXT_PROTOTYPES 1
#include <GL/gl.h>
#include <GL/glext.h>
#include <stdio.h>
#include <stdlib.h>

static int winW = 640, winH = 480, swaps = 0, wantSwap = 120, step = 25, now = 0;
static const int RES[][2] = { {320,200}, {320,240}, {400,256}, {512,384}, {640,200}, {640,350}, {640,400}, {640,480}, {800,600} };

/* --- the clock */
extern int curtime;
int __wrap_Sys_Milliseconds(void) {
  static int init = 0;
  if (!init) { const char *s = getenv("PRISM_Q2_STEP"), *w = getenv("PRISM_Q2_SWAP"); if (s) step = atoi(s); if (w) wantSwap = atoi(w); init = 1; }
  now += step;
  curtime = now;
  return now;
}

/* --- fxMesa on EGL */
void *fxMesaCreateContext(GLuint win, int res, int refresh, const GLint *attribs) {
  (void)win; (void)refresh; (void)attribs;
  if (res < 0 || res > 8) return NULL;
  winW = RES[res][0]; winH = RES[res][1];
  return (void *)1;
}
void fxMesaMakeCurrent(void *ctx) {
  if (!ctx) return;
  PFNEGLGETPLATFORMDISPLAYEXTPROC get = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
  EGLDisplay d = get(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
  if (!eglInitialize(d, NULL, NULL)) { fprintf(stderr, "q2-egl: eglInitialize failed\n"); exit(2); }
  eglBindAPI(EGL_OPENGL_API);
  static const EGLint cfg[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_NONE };
  EGLConfig conf; EGLint n;
  if (!eglChooseConfig(d, cfg, &conf, 1, &n) || n < 1) { fprintf(stderr, "q2-egl: no config\n"); exit(2); }
  EGLContext c = eglCreateContext(d, conf, EGL_NO_CONTEXT, NULL);
  if (!eglMakeCurrent(d, EGL_NO_SURFACE, EGL_NO_SURFACE, c)) { fprintf(stderr, "q2-egl: makeCurrent failed\n"); exit(2); }
  GLuint fb, rb[2];
  glGenFramebuffers(1, &fb); glBindFramebuffer(GL_FRAMEBUFFER, fb);
  glGenRenderbuffers(2, rb);
  glBindRenderbuffer(GL_RENDERBUFFER, rb[0]); glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, winW, winH);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, rb[0]);
  glBindRenderbuffer(GL_RENDERBUFFER, rb[1]); glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, winW, winH);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, rb[1]);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) { fprintf(stderr, "q2-egl: incomplete framebuffer\n"); exit(2); }
}
void fxMesaSwapBuffers(void) {
  if (swaps++ != wantSwap) return;
  glFinish();
  unsigned char *px = malloc((size_t)winW * winH * 4);
  glReadPixels(0, 0, winW, winH, GL_RGBA, GL_UNSIGNED_BYTE, px);
  FILE *o = fopen("frame.ppm", "wb");
  fprintf(o, "P6\n%d %d\n255\n", winW, winH);
  for (int y = winH - 1; y >= 0; y--) for (int x = 0; x < winW; x++) fwrite(px + ((size_t)y * winW + x) * 4, 1, 3, o);
  fclose(o);
  free(px);
  exit(0);
}
void fxMesaDestroyContext(void *ctx) { (void)ctx; }
/* The program selects the window's buffers; on the FBO they are its one colour attachment. */
void glDrawBuffer(GLenum b) { (void)b; }
void glReadBuffer(GLenum b) { (void)b; }

/* --- svgalib's keyboard and mouse, as PRISM's shim answers with no person present */
typedef void (*keyhandler_t)(int, int);
typedef void (*mousehandler_t)(int, int, int, int, int, int, int);
int keyboard_init(void) { return 0; }
void keyboard_close(void) {}
void keyboard_seteventhandler(keyhandler_t h) { (void)h; }
int keyboard_translatekeys(int mask) { (void)mask; return 0; }
int keyboard_update(void) { return 0; }
int vga_getmousetype(void) { return 0; }
int mouse_init(char *dev, int type, int rate) { (void)dev; (void)type; (void)rate; return 1; }  /* no mouse */
void mouse_close(void) {}
void mouse_seteventhandler(mousehandler_t h) { (void)h; }
int mouse_update(void) { return 0; }

/* --- what PRISM's runtime also provides: stricmp, which Quake II's Linux files call by its DOS name */
#include <strings.h>
int stricmp(const char *a, const char *b) { return strcasecmp(a, b); }

/* The 3Dfx palette extension qgl_linux.c takes the address of; PRISM leaves it unresolved (it throws
   if called), and ref_gl calls it only when the extension string names it, which here it does not. */
void gl3DfxSetPaletteEXT(GLuint *pal) { (void)pal; fprintf(stderr, "q2-egl: gl3DfxSetPaletteEXT called\n"); abort(); }
