/*
 * glx-egl.c -- GLX, and the few X11 calls around it, for a GL program built for the oracle: Mesa
 * (llvmpipe) draws, on a surfaceless EGL context and a framebuffer object, and no X server exists.
 *
 * The REFERENCE side of tools/gate-glquake.mjs. GLQuake's own gl_vidlinuxglx.c is compiled
 * unmodified against the real Xlib and GL headers; this file answers its X and GLX calls the way
 * PRISM's X11 shim and src/env/glx.js do -- one display, one screen, no events, the extensions
 * absent -- so both builds take the same path through the platform layer.
 *
 * Frames are taken at glXSwapBuffers. The harness counts the program's WORLD frames through
 * __wrap_R_RenderView (link with -Wl,--wrap=R_RenderView) and gives it a fixed clock through
 * __wrap_Sys_FloatTime (-Wl,--wrap=Sys_FloatTime): 1/72 s per call, the step gate-pixels gives
 * PRISM, so both runs draw the same demo frame by frame. PRISM_GLX_WORLD=N writes the picture of the
 * swap that follows the N-th world frame as frame.ppm (top row first) and exits.
 */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#define GL_GLEXT_PROTOTYPES 1
#include <GL/gl.h>
#include <GL/glext.h>
#include <GL/glx.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int winW = 640, winH = 480, world = 0, wantWorld = 60;
static double ticks = 0;

/* --- the program's clock and its world frames */
extern void __real_R_RenderView(void);
void __wrap_R_RenderView(void) { __real_R_RenderView(); world++; }
double __wrap_Sys_FloatTime(void) { return ++ticks / 72.0; }

/* --- X11: one display, one screen, no events */
static Screen theScreen;
static struct { char pad[4096]; } displayStore;
Display *XOpenDisplay(const char *name) {
  (void)name;
  _XPrivDisplay d = (_XPrivDisplay)&displayStore;
  memset(&displayStore, 0, sizeof displayStore);
  d->screens = &theScreen; d->nscreens = 1; d->default_screen = 0;
  theScreen.root = 1; theScreen.width = 1024; theScreen.height = 768; theScreen.root_depth = 24;
  const char *w = getenv("PRISM_GLX_WORLD");
  if (w) wantWorld = atoi(w);
  return (Display *)d;
}
int XCloseDisplay(Display *d) { (void)d; return 0; }
Colormap XCreateColormap(Display *d, Window w, Visual *v, int alloc) { (void)d; (void)w; (void)v; (void)alloc; return 1; }
GC XCreateGC(Display *d, Drawable dr, unsigned long m, XGCValues *v) { (void)d; (void)dr; (void)m; (void)v; return (GC)1; }
Pixmap XCreatePixmap(Display *d, Drawable dr, unsigned int w, unsigned int h, unsigned int depth) { (void)d; (void)dr; (void)w; (void)h; (void)depth; return 2; }
Cursor XCreatePixmapCursor(Display *d, Pixmap s, Pixmap m, XColor *f, XColor *b, unsigned int x, unsigned int y) { (void)d; (void)s; (void)m; (void)f; (void)b; (void)x; (void)y; return 3; }
Window XCreateWindow(Display *d, Window p, int x, int y, unsigned int w, unsigned int h, unsigned int bw, int depth, unsigned int cls, Visual *v, unsigned long mask, XSetWindowAttributes *a) {
  (void)d; (void)p; (void)x; (void)y; (void)bw; (void)depth; (void)cls; (void)v; (void)mask; (void)a;
  winW = (int)w; winH = (int)h; return 4;
}
int XDefineCursor(Display *d, Window w, Cursor c) { (void)d; (void)w; (void)c; return 0; }
int XUndefineCursor(Display *d, Window w) { (void)d; (void)w; return 0; }
int XDestroyWindow(Display *d, Window w) { (void)d; (void)w; return 0; }
int XFillRectangle(Display *d, Drawable dr, GC gc, int x, int y, unsigned int w, unsigned int h) { (void)d; (void)dr; (void)gc; (void)x; (void)y; (void)w; (void)h; return 0; }
int XFlush(Display *d) { (void)d; return 0; }
int XSync(Display *d, Bool b) { (void)d; (void)b; return 0; }
int XFreeGC(Display *d, GC gc) { (void)d; (void)gc; return 0; }
int XFreePixmap(Display *d, Pixmap p) { (void)d; (void)p; return 0; }
int XGrabKeyboard(Display *d, Window w, Bool o, int pm, int km, Time t) { (void)d; (void)w; (void)o; (void)pm; (void)km; (void)t; return 0; }
int XUngrabKeyboard(Display *d, Time t) { (void)d; (void)t; return 0; }
int XGrabPointer(Display *d, Window w, Bool o, unsigned int m, int pm, int km, Window c, Cursor cu, Time t) { (void)d; (void)w; (void)o; (void)m; (void)pm; (void)km; (void)c; (void)cu; (void)t; return 0; }
int XUngrabPointer(Display *d, Time t) { (void)d; (void)t; return 0; }
int XWarpPointer(Display *d, Window s, Window w, int sx, int sy, unsigned int sw, unsigned int sh, int x, int y) { (void)d; (void)s; (void)w; (void)sx; (void)sy; (void)sw; (void)sh; (void)x; (void)y; return 0; }
int XMapWindow(Display *d, Window w) { (void)d; (void)w; return 0; }
int XMoveWindow(Display *d, Window w, int x, int y) { (void)d; (void)w; (void)x; (void)y; return 0; }
int XRaiseWindow(Display *d, Window w) { (void)d; (void)w; return 0; }
int XPending(Display *d) { (void)d; return 0; }
int XNextEvent(Display *d, XEvent *e) { (void)d; memset(e, 0, sizeof *e); return 0; }
int XLookupString(XKeyEvent *e, char *b, int n, KeySym *k, XComposeStatus *s) { (void)e; (void)b; (void)n; (void)s; if (k) *k = 0; return 0; }
KeySym XLookupKeysym(XKeyEvent *e, int i) { (void)e; (void)i; return 0; }

/* --- the X extensions, absent */
Bool XF86VidModeQueryVersion(Display *d, int *a, int *b) { (void)d; (void)a; (void)b; return False; }
Bool XF86VidModeGetAllModeLines(Display *d, int s, int *n, void ***m) { (void)d; (void)s; (void)n; (void)m; abort(); }
Bool XF86VidModeSwitchToMode(Display *d, int s, void *m) { (void)d; (void)s; (void)m; abort(); }
Bool XF86VidModeSetViewPort(Display *d, int s, int x, int y) { (void)d; (void)s; (void)x; (void)y; abort(); }
Bool XF86DGAQueryVersion(Display *d, int *a, int *b) { (void)d; (void)a; (void)b; return False; }
Status XF86DGADirectVideo(Display *d, int s, int e) { (void)d; (void)s; (void)e; abort(); }

/* --- GLX on EGL */
static XVisualInfo theVisual;
XVisualInfo *glXChooseVisual(Display *d, int s, int *attrib) {
  (void)d; (void)s; (void)attrib;
  theVisual.depth = 24; theVisual.class = TrueColor;
  theVisual.red_mask = 0xff0000; theVisual.green_mask = 0xff00; theVisual.blue_mask = 0xff;
  return &theVisual;
}
GLXContext glXCreateContext(Display *d, XVisualInfo *v, GLXContext share, Bool direct) { (void)d; (void)v; (void)share; (void)direct; return (GLXContext)1; }
Bool glXMakeCurrent(Display *dpy, GLXDrawable w, GLXContext c) {
  (void)dpy; (void)w;
  if (!c) return True;
  PFNEGLGETPLATFORMDISPLAYEXTPROC get = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
  EGLDisplay d = get(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
  if (!eglInitialize(d, NULL, NULL)) { fprintf(stderr, "glx-egl: eglInitialize failed\n"); exit(2); }
  eglBindAPI(EGL_OPENGL_API);
  static const EGLint cfg[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_NONE };
  EGLConfig conf; EGLint n;
  if (!eglChooseConfig(d, cfg, &conf, 1, &n) || n < 1) { fprintf(stderr, "glx-egl: no config\n"); exit(2); }
  EGLContext ctx = eglCreateContext(d, conf, EGL_NO_CONTEXT, NULL);
  if (!eglMakeCurrent(d, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)) { fprintf(stderr, "glx-egl: makeCurrent failed\n"); exit(2); }
  GLuint fb, rb[2];
  glGenFramebuffers(1, &fb); glBindFramebuffer(GL_FRAMEBUFFER, fb);
  glGenRenderbuffers(2, rb);
  glBindRenderbuffer(GL_RENDERBUFFER, rb[0]); glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, winW, winH);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, rb[0]);
  glBindRenderbuffer(GL_RENDERBUFFER, rb[1]); glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, winW, winH);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, rb[1]);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) { fprintf(stderr, "glx-egl: incomplete framebuffer\n"); exit(2); }
  /* A window's default draw buffer is BACK; an FBO's is COLOR_ATTACHMENT0, and glDrawBuffer(GL_BACK)
     from the program would be an error on it -- so the program's draw/read buffer calls are the
     window's and are answered here. */
  return True;
}
void glXDestroyContext(Display *d, GLXContext c) { (void)d; (void)c; }
void glXSwapBuffers(Display *d, GLXDrawable w) {
  (void)d; (void)w;
  if (world < wantWorld) return;
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
/* The program selects the window's buffers; on the FBO they are its one colour attachment. */
void __wrap_glDrawBuffer(GLenum b) { (void)b; }
void __wrap_glReadBuffer(GLenum b) { (void)b; }
