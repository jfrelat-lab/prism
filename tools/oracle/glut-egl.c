/*
 * glut-egl.c -- the smallest GLUT a GLUT program needs, on EGL with no display, for the oracle.
 *
 * The REFERENCE side of the OpenGL gates: a program's own GLUT calls, answered here, with Mesa
 * (llvmpipe, in the oracle container) doing every GL call the program makes. The window is a
 * framebuffer object on a surfaceless EGL context, so nothing needs an X server.
 *
 * The schedule is the harness's, and PRISM's GLUT (src/env/glut.js) follows the same one, which is
 * what makes the frames comparable:
 *   glutMainLoop: reshape(w, h); visibility(GLUT_VISIBLE); display; then for ever
 *                 { idle; if a redisplay was posted: display }.
 *   GLUT_ELAPSED_TIME is PRISM_GLUT_STEP_MS (default 40) times the number of glutSwapBuffers so far.
 * Environment: PRISM_GLUT_FRAMES="0,10,50" writes those frames (0-based, counted at swap) as
 * frame-N.ppm, bottom row last; the program exits after the highest one.
 */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#define GL_GLEXT_PROTOTYPES 1
#include <GL/gl.h>
#include <GL/glext.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "GL/glut.h"

static int winW = 300, winH = 300, swaps = 0, redisplay = 0, stepMs = 40, lastFrame = 0;
static unsigned int displayMode = 0;
static int want[64], nwant = 0;
static void (*displayCb)(void), (*reshapeCb)(int, int), (*idleCb)(void), (*visibilityCb)(int);

void glutInit(int *argc, char **argv) {
  (void)argc; (void)argv;
  const char *s = getenv("PRISM_GLUT_STEP_MS"), *f = getenv("PRISM_GLUT_FRAMES");
  if (s) stepMs = atoi(s);
  for (const char *p = f ? f : "0"; *p && nwant < 64;) {
    want[nwant++] = atoi(p);
    if (want[nwant - 1] > lastFrame) lastFrame = want[nwant - 1];
    while (*p && *p != ',') p++;
    if (*p == ',') p++;
  }
}
void glutInitDisplayMode(unsigned int mode) { displayMode = mode; }
void glutInitWindowSize(int w, int h) { winW = w; winH = h; }
void glutInitWindowPosition(int x, int y) { (void)x; (void)y; }

int glutCreateWindow(const char *title) {
  (void)title;
  PFNEGLGETPLATFORMDISPLAYEXTPROC getDisplay = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
  EGLDisplay d = getDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
  if (!eglInitialize(d, NULL, NULL)) { fprintf(stderr, "glut-egl: eglInitialize failed\n"); exit(2); }
  eglBindAPI(EGL_OPENGL_API);
  static const EGLint cfg[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_NONE };
  EGLConfig c; EGLint n;
  if (!eglChooseConfig(d, cfg, &c, 1, &n) || n < 1) { fprintf(stderr, "glut-egl: no config\n"); exit(2); }
  EGLContext ctx = eglCreateContext(d, c, EGL_NO_CONTEXT, NULL);   /* compatibility profile */
  if (!eglMakeCurrent(d, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)) { fprintf(stderr, "glut-egl: makeCurrent failed\n"); exit(2); }
  GLuint fb, rb[2];
  glGenFramebuffers(1, &fb); glBindFramebuffer(GL_FRAMEBUFFER, fb);
  glGenRenderbuffers(2, rb);
  glBindRenderbuffer(GL_RENDERBUFFER, rb[0]); glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, winW, winH);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, rb[0]);
  /* GLUT_STENCIL asks for a stencil buffer too: 8 bits, packed with the depth as Mesa's visuals are. */
  int stencil = (displayMode & GLUT_STENCIL) != 0;
  glBindRenderbuffer(GL_RENDERBUFFER, rb[1]); glRenderbufferStorage(GL_RENDERBUFFER, stencil ? GL_DEPTH24_STENCIL8 : GL_DEPTH_COMPONENT24, winW, winH);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, stencil ? GL_DEPTH_STENCIL_ATTACHMENT : GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, rb[1]);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) { fprintf(stderr, "glut-egl: incomplete framebuffer\n"); exit(2); }
  return 1;
}
void glutDestroyWindow(int win) { (void)win; }
int glutGetWindow(void) { return 1; }
void glutSetWindow(int win) { (void)win; }
void glutSetWindowTitle(const char *title) { (void)title; }
void glutDisplayFunc(void (*f)(void)) { displayCb = f; }
void glutReshapeFunc(void (*f)(int, int)) { reshapeCb = f; }
void glutIdleFunc(void (*f)(void)) { idleCb = f; }
void glutVisibilityFunc(void (*f)(int)) { visibilityCb = f; }
void glutKeyboardFunc(void (*f)(unsigned char, int, int)) { (void)f; }
void glutSpecialFunc(void (*f)(int, int, int)) { (void)f; }
void glutPostRedisplay(void) { redisplay = 1; }

int glutGet(int what) {
  if (what == GLUT_ELAPSED_TIME) return swaps * stepMs;
  if (what == GLUT_WINDOW_WIDTH) return winW;
  if (what == GLUT_WINDOW_HEIGHT) return winH;
  return 0;
}

void glutSwapBuffers(void) {
  glFinish();
  for (int i = 0; i < nwant; i++) {
    if (want[i] != swaps) continue;
    unsigned char *px = malloc((size_t)winW * winH * 4);
    glReadPixels(0, 0, winW, winH, GL_RGBA, GL_UNSIGNED_BYTE, px);
    char name[64];
    snprintf(name, sizeof name, "frame-%d.ppm", swaps);
    FILE *o = fopen(name, "wb");
    fprintf(o, "P6\n%d %d\n255\n", winW, winH);
    for (int y = winH - 1; y >= 0; y--) for (int x = 0; x < winW; x++) fwrite(px + ((size_t)y * winW + x) * 4, 1, 3, o);
    fclose(o);
    free(px);
  }
  if (swaps++ >= lastFrame) exit(0);
}

void glutMainLoop(void) {
  if (reshapeCb) reshapeCb(winW, winH);
  if (visibilityCb) visibilityCb(GLUT_VISIBLE);
  if (displayCb) displayCb();
  for (;;) {
    if (idleCb) idleCb();
    if (redisplay) { redisplay = 0; if (displayCb) displayCb(); }
  }
}
