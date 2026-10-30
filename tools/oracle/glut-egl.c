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
 * GL/glut.h is not in this directory: tools/oracle.mjs (oracleGlut) writes PRISM's own beside this file.
 */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#define GL_GLEXT_PROTOTYPES 1
#include <GL/gl.h>
#include <GL/glext.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define PRISM_GLUT_EGL_IMPL 1
#include "GL/glut.h"

/*
 * Everything below mirrors src/env/glut.js, function for function: the same schedule, the same
 * answers to glutGet and its kind, the same timers. GL/glut.h is PRISM's own header (tools/oracle.mjs
 * writes it here), so the constants are the program's on both sides.
 */
static int winW = 300, winH = 300, swaps = 0, redisplay = 0, stepMs = 40, lastFrame = 0, dbl = 0, created = 0;
static int cursor = 1, gameMode = 0;
static GLuint windowFb = 0;   /* the window: what framebuffer 0 means to the program */
void prism_glutBindFramebuffer(unsigned int target, unsigned int framebuffer) { glBindFramebuffer(target, framebuffer ? framebuffer : windowFb); }
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
void glutInitDisplayMode(unsigned int mode) { displayMode = mode; dbl = (mode & GLUT_DOUBLE) != 0; }
/* The display string's words that change something: double and stencil, as glut.js reads them. */
void glutInitDisplayString(const char *string) {
  unsigned int mode = 0;
  char word[64];
  for (const char *p = string; *p;) {
    while (*p == ' ' || *p == '\t' || *p == '\n') p++;
    int n = 0;
    while (*p && *p != ' ' && *p != '\t' && *p != '\n') { if (n < 63) word[n++] = *p; p++; }
    word[n] = 0;
    word[strcspn(word, "=<>~!")] = 0;
    if (!strcmp(word, "double")) mode |= GLUT_DOUBLE;
    if (!strcmp(word, "stencil")) mode |= GLUT_STENCIL;
  }
  glutInitDisplayMode(mode);
}
void glutInitWindowSize(int w, int h) { winW = w; winH = h; }
void glutInitWindowPosition(int x, int y) { (void)x; (void)y; }

int glutCreateWindow(const char *title) {
  (void)title;
  if (created) return 1;
  created = 1;
  PFNEGLGETPLATFORMDISPLAYEXTPROC getDisplay = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
  EGLDisplay d = getDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
  if (!eglInitialize(d, NULL, NULL)) { fprintf(stderr, "glut-egl: eglInitialize failed\n"); exit(2); }
  eglBindAPI(EGL_OPENGL_API);
  static const EGLint cfg[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_NONE };
  EGLConfig c; EGLint n;
  if (!eglChooseConfig(d, cfg, &c, 1, &n) || n < 1) { fprintf(stderr, "glut-egl: no config\n"); exit(2); }
  EGLContext ctx = eglCreateContext(d, c, EGL_NO_CONTEXT, NULL);   /* compatibility profile */
  if (!eglMakeCurrent(d, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)) { fprintf(stderr, "glut-egl: makeCurrent failed\n"); exit(2); }
  GLuint rb[2];
  glGenFramebuffers(1, &windowFb); glBindFramebuffer(GL_FRAMEBUFFER, windowFb);
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
void glutPostRedisplay(void) { redisplay = 1; }
void glutPostWindowRedisplay(int win) { (void)win; redisplay = 1; }
int glutEnterGameMode(void) { winW = 640; winH = 480; gameMode = 1; glutCreateWindow("game mode"); return 1; }
void glutLeaveGameMode(void) { gameMode = 0; }
void glutSetCursor(int c) { cursor = c; }

/* Callbacks for input and devices: kept, never called (no events reach the reference). */
void glutKeyboardFunc(void (*f)(unsigned char, int, int)) { (void)f; }
void glutKeyboardUpFunc(void (*f)(unsigned char, int, int)) { (void)f; }
void glutSpecialFunc(void (*f)(int, int, int)) { (void)f; }
void glutSpecialUpFunc(void (*f)(int, int, int)) { (void)f; }
void glutMouseFunc(void (*f)(int, int, int, int)) { (void)f; }
void glutMotionFunc(void (*f)(int, int)) { (void)f; }
void glutPassiveMotionFunc(void (*f)(int, int)) { (void)f; }
void glutEntryFunc(void (*f)(int)) { (void)f; }
void glutMenuStatusFunc(void (*f)(int, int, int)) { (void)f; }
void glutMenuStateFunc(void (*f)(int)) { (void)f; }
void glutWindowStatusFunc(void (*f)(int)) { (void)f; }
void glutOverlayDisplayFunc(void (*f)(void)) { (void)f; }
void glutSpaceballMotionFunc(void (*f)(int, int, int)) { (void)f; }
void glutSpaceballRotateFunc(void (*f)(int, int, int)) { (void)f; }
void glutSpaceballButtonFunc(void (*f)(int, int)) { (void)f; }
void glutButtonBoxFunc(void (*f)(int, int)) { (void)f; }
void glutDialsFunc(void (*f)(int, int)) { (void)f; }
void glutTabletMotionFunc(void (*f)(int, int)) { (void)f; }
void glutTabletButtonFunc(void (*f)(int, int, int, int)) { (void)f; }
void glutJoystickFunc(void (*f)(unsigned int, int, int, int), int pollInterval) { (void)f; (void)pollInterval; }
void glutForceJoystickFunc(void) {}
void glutIgnoreKeyRepeat(int ignore) { (void)ignore; }
void glutSetKeyRepeat(int repeatMode) { (void)repeatMode; }
void glutWarpPointer(int x, int y) { (void)x; (void)y; }
void glutReportErrors(void) {}

/* What a window manager would do, done by nobody (glut.js says why). */
int glutCreateSubWindow(int win, int x, int y, int width, int height) { (void)win; (void)x; (void)y; (void)width; (void)height; return 2; }
void glutReshapeWindow(int width, int height) { (void)width; (void)height; }
void glutPositionWindow(int x, int y) { (void)x; (void)y; }
void glutPopWindow(void) {}
void glutPushWindow(void) {}
void glutIconifyWindow(void) {}
void glutShowWindow(void) {}
void glutHideWindow(void) {}
void glutFullScreen(void) {}
void glutSetIconTitle(const char *title) { (void)title; }
void glutEstablishOverlay(void) {}
void glutRemoveOverlay(void) {}
void glutUseLayer(GLenum layer) { (void)layer; }
void glutPostOverlayRedisplay(void) {}
void glutPostWindowOverlayRedisplay(int win) { (void)win; }
void glutShowOverlay(void) {}
void glutHideOverlay(void) {}
void glutSetColor(int ndx, GLfloat red, GLfloat green, GLfloat blue) { (void)ndx; (void)red; (void)green; (void)blue; }
GLfloat glutGetColor(int ndx, int component) { (void)ndx; (void)component; return 0; }
void glutCopyColormap(int win) { (void)win; }
int glutVideoResizeGet(GLenum param) { (void)param; return 0; }
void glutSetupVideoResizing(void) {}
void glutStopVideoResizing(void) {}
void glutVideoResize(int x, int y, int width, int height) { (void)x; (void)y; (void)width; (void)height; }
void glutVideoPan(int x, int y, int width, int height) { (void)x; (void)y; (void)width; (void)height; }
void glutGameModeString(const char *string) { (void)string; }

/* Menus: kept and counted, never shown. */
static int menuLen[256], menuVal[256][64], curMenu = 0, nextMenu = 1;
int glutCreateMenu(void (*f)(int)) { (void)f; int id = nextMenu < 256 ? nextMenu++ : 255; menuLen[id] = 0; curMenu = id; return id; }
void glutDestroyMenu(int menu) { if (menu > 0 && menu < 256) menuLen[menu] = 0; if (curMenu == menu) curMenu = 0; }
int glutGetMenu(void) { return curMenu; }
void glutSetMenu(int menu) { if (menu > 0 && menu < nextMenu) curMenu = menu; }
static void menuPush(int v) { if (curMenu && menuLen[curMenu] < 64) menuVal[curMenu][menuLen[curMenu]++] = v; }
void glutAddMenuEntry(const char *label, int value) { (void)label; menuPush(value); }
void glutAddSubMenu(const char *label, int submenu) { (void)label; menuPush(-submenu); }
void glutChangeToMenuEntry(int item, const char *label, int value) { (void)label; if (curMenu && item >= 1 && item <= menuLen[curMenu]) menuVal[curMenu][item - 1] = value; }
void glutChangeToSubMenu(int item, const char *label, int submenu) { (void)label; if (curMenu && item >= 1 && item <= menuLen[curMenu]) menuVal[curMenu][item - 1] = -submenu; }
void glutRemoveMenuItem(int item) {
  if (!curMenu || item < 1 || item > menuLen[curMenu]) return;
  for (int i = item - 1; i + 1 < menuLen[curMenu]; i++) menuVal[curMenu][i] = menuVal[curMenu][i + 1];
  menuLen[curMenu]--;
}
void glutAttachMenu(int button) { (void)button; }
void glutDetachMenu(int button) { (void)button; }

/* What GLUT answers about itself: glut.js's GET and DEVICE tables. */
int glutGet(GLenum what) {
  switch (what) {
    case GLUT_ELAPSED_TIME: return swaps * stepMs;
    case GLUT_WINDOW_WIDTH: case GLUT_INIT_WINDOW_WIDTH: return winW;
    case GLUT_WINDOW_HEIGHT: case GLUT_INIT_WINDOW_HEIGHT: return winH;
    case GLUT_WINDOW_STENCIL_SIZE: return displayMode & GLUT_STENCIL ? 8 : 0;
    case GLUT_WINDOW_DOUBLEBUFFER: return dbl;
    case GLUT_WINDOW_CURSOR: return cursor;
    case GLUT_MENU_NUM_ITEMS: return curMenu ? menuLen[curMenu] : 0;
    case GLUT_INIT_DISPLAY_MODE: return (int)displayMode;
    case GLUT_WINDOW_BUFFER_SIZE: return 32;
    case GLUT_WINDOW_DEPTH_SIZE: return 24;
    case GLUT_WINDOW_RED_SIZE: case GLUT_WINDOW_GREEN_SIZE: case GLUT_WINDOW_BLUE_SIZE: case GLUT_WINDOW_ALPHA_SIZE: return 8;
    case GLUT_WINDOW_RGBA: return 1;
    case GLUT_SCREEN_WIDTH: return 1024;
    case GLUT_SCREEN_HEIGHT: return 768;
    case GLUT_SCREEN_WIDTH_MM: return 361;
    case GLUT_SCREEN_HEIGHT_MM: return 271;
    case GLUT_DISPLAY_MODE_POSSIBLE: return 1;
    default: return 0;
  }
}
int glutDeviceGet(GLenum what) { return what == GLUT_HAS_KEYBOARD || what == GLUT_HAS_MOUSE ? 1 : what == GLUT_NUM_MOUSE_BUTTONS ? 3 : 0; }
int glutLayerGet(GLenum what) { (void)what; return 0; }
int glutGetModifiers(void) { return 0; }
int glutExtensionSupported(const char *name) { (void)name; return 0; }
int glutGameModeGet(GLenum what) { return what == 0 ? gameMode : what == 1 ? 1 : what == 2 ? 640 : what == 3 ? 480 : what == 4 ? 32 : what == 5 ? 60 : 0; }

/* Timers: fired at the first turn of the loop whose time has reached theirs, oldest due first. */
static struct { int due, n, value; void (*fn)(int); } timers[256];
static int ntimers = 0, timerN = 0;
void glutTimerFunc(unsigned int ms, void (*fn)(int), int value) {
  if (ntimers == 256) return;
  timers[ntimers].due = swaps * stepMs + (int)ms; timers[ntimers].n = timerN++; timers[ntimers].value = value; timers[ntimers].fn = fn;
  ntimers++;
}
static void fireTimers(void) {
  int t = swaps * stepMs, limit = timerN;
  for (;;) {
    int best = -1;
    for (int i = 0; i < ntimers; i++) if (timers[i].due <= t && timers[i].n < limit && (best < 0 || timers[i].due < timers[best].due || (timers[i].due == timers[best].due && timers[i].n < timers[best].n))) best = i;
    if (best < 0) return;
    void (*fn)(int) = timers[best].fn; int v = timers[best].value;
    timers[best] = timers[--ntimers];
    /* Fired only those due when this turn began: a timer registered by a callback here waits its turn. */
    fn(v);
  }
}

static void present(void) {
  glFinish();
  for (int i = 0; i < nwant; i++) {
    if (want[i] != swaps) continue;
    unsigned char *px = malloc((size_t)winW * winH * 4);
    GLint read = 0;
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, windowFb);
    glReadPixels(0, 0, winW, winH, GL_RGBA, GL_UNSIGNED_BYTE, px);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)read);
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
static void display(void) { if (displayCb) displayCb(); if (!dbl) present(); }
/* "If the layer in use is not double buffered, glutSwapBuffers has no effect" (GLUT 3 spec 4.6). */
void glutSwapBuffers(void) { if (dbl) present(); }

void glutMainLoop(void) {
  if (reshapeCb) reshapeCb(winW, winH);
  if (visibilityCb) visibilityCb(GLUT_VISIBLE);
  display();
  for (;;) {
    fireTimers();
    if (idleCb) idleCb();
    if (redisplay) { redisplay = 0; display(); }
    else if (!dbl && idleCb) present();
    else if (!idleCb) present();
  }
}
