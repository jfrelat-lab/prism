/*
 * wrap.c -- the native side of tools/cubediff.mjs: Cube built by g++ against the REAL SDL 1.2,
 * SDL_mixer and SDL_image (the last two linked statically, so their calls into SDL are wrapped too),
 * drawn by Mesa (llvmpipe) on a surfaceless EGL context and a framebuffer object -- with exactly the
 * parts of SDL that depend on time replaced, by `ld --wrap`, with what src/env/sdl12.js does under
 * PRISM's virtual clock (src/env/clock.js). tools/scummvmdiff/wrap.c's clock, pump, audio device,
 * timers, input script and date, transcribed again from the shim, and:
 *
 *   SDL_SetVideoMode   with SDL_OPENGL: the dummy driver's surface for SDL, and an EGL context with a
 *                      w x h framebuffer object (colour and depth) for GL, as tools/oracle/glx-egl.c
 *   SDL_GL_SetAttribute   accepted: the framebuffer is RGBA8 with a 24-bit depth whatever is asked
 *   SDL_GL_SwapBuffers    pump, as sdl12.js does; then the frame: its FNV-1a hash printed as
 *                         `frame N <hash>`, and with PPM=n1,n2,... the picture of those frames written
 *                         as cube-frame-N.ppm (top row first); FRAMES=n stops after the n-th
 *
 * Each buffer the audio callback fills prints `audio N <hash>` as in scummvmdiff.
 */
#include <SDL.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#define GL_GLEXT_PROTOTYPES 1
#include <GL/gl.h>
#include <GL/glext.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

SDL_Surface *__real_SDL_SetVideoMode(int, int, int, Uint32);

/* ---- the virtual clock: src/env/clock.js virtualClock(), in doubles as JavaScript has it. */
static double t_ms = 0;
static int clock_now(void) { t_ms += 1.0 / 1024; return (int)t_ms; }
static void clock_delay(int ms) { if (ms > 0) t_ms += ms; }

/* ---- the audio device: src/env/sdl12.js / sdlmixer.js, pumped by the clock. */
static int audio_open, audio_freq, audio_frames, audio_bytes, audio_format, mix_t0, mixed, audio_count;
static Uint8 *audio_buf;
static void (*audio_cb)(void *, Uint8 *, int);
static void *audio_user;

static SDL_TimerCallback timer_cb;
static Uint32 timer_interval;
static double timer_next;

static int pumping;
static void pump(void) {
  if (pumping) return;
  pumping = 1;
  if (audio_open && audio_buf) {
    int now = clock_now();
    int due = (int)floor(((double)(now - mix_t0) * audio_freq) / (1000.0 * audio_frames)) + 1;
    while (mixed < due) {
      Uint32 h = 0x811c9dc5u;
      int i;
      memset(audio_buf, (audio_format & 0xff) == 8 ? 0x80 : 0, audio_bytes);
      audio_cb(audio_user, audio_buf, audio_bytes);
      mixed++;
      for (i = 0; i < audio_bytes; i++) h = (h ^ audio_buf[i]) * 16777619u;
      printf("audio %d %08x\n", ++audio_count, h);
    }
  }
  if (timer_cb) {
    SDL_TimerCallback t = timer_cb;
    int now = clock_now(), n;
    for (n = 0; timer_cb == t && now >= timer_next && n < 64; n++) {
      Uint32 again = t(timer_interval);
      if (!again) { if (timer_cb == t) timer_cb = 0; break; }
      timer_interval = again; timer_next += again;
    }
    if (timer_cb == t && now >= timer_next) timer_next = now + timer_interval;
  }
  pumping = 0;
}

Uint32 __wrap_SDL_GetTicks(void) { pump(); return (Uint32)clock_now(); }
void __wrap_SDL_Delay(Uint32 ms) { clock_delay((int)ms); pump(); }

/* ---- input: src/env/sdl12.js SDL_PollEvent and gatherMouse, transcribed (as in scummvmdiff). */
struct ev { int frame, kind, a, b, c; };
static struct ev script[8192];
static int nscript, scriptAt, loaded;
static int host_x, host_y, host_b;
static int ptr_x, ptr_y, ptr_b;
struct mev { int type, x, y, xrel, yrel, held, button; };
static struct mev mq[64];
static int mqn;
struct kev { int scan, down, sym; };
static struct kev kq[256];
static int kqh, kqt, held_valid;
static struct kev held;
static int mods;
static void load_script(void) {
  const char *f = getenv("EVENTS");
  FILE *fp;
  char kind;
  loaded = 1;
  if (!f || !(fp = fopen(f, "r"))) return;
  while (nscript < 8192) {
    struct ev *e = &script[nscript];
    if (fscanf(fp, "%d %c %d %d %d", &e->frame, &kind, &e->a, &e->b, &e->c) != 5) break;
    e->kind = kind;
    nscript++;
  }
  fclose(fp);
}
static void inject(int ms) {
  if (!loaded) load_script();
  while (scriptAt < nscript && script[scriptAt].frame <= ms) {
    struct ev *e = &script[scriptAt++];
    if (e->kind == 'k') { kq[kqt].scan = e->a; kq[kqt].down = e->b; kq[kqt].sym = e->c; kqt = (kqt + 1) & 255; }
    else { host_x = e->a; host_y = e->b; host_b = e->c; }
  }
}
static int kmod_of(int sym) {
  switch (sym) {
    case 304: return 0x0001; case 303: return 0x0002; case 306: return 0x0040; case 305: return 0x0080;
    case 308: return 0x0100; case 307: return 0x0200; case 310: return 0x0400; case 309: return 0x0800;
  }
  return 0;
}
static void gather_mouse(void) {
  int button;
  if (host_x != ptr_x || host_y != ptr_y) {
    struct mev m = { SDL_MOUSEMOTION, host_x, host_y, host_x - ptr_x, host_y - ptr_y, host_b, 0 };
    if (mqn < 64) mq[mqn++] = m;
    ptr_x = host_x; ptr_y = host_y;
  }
  for (button = 1; button <= 3; button++) {
    int bit = 1 << (button - 1);
    if ((host_b & bit) != (ptr_b & bit)) {
      struct mev m = { host_b & bit ? SDL_MOUSEBUTTONDOWN : SDL_MOUSEBUTTONUP, host_x, host_y, 0, 0, 0, button };
      if (mqn < 64) mq[mqn++] = m;
    }
  }
  ptr_b = host_b;
}
int __wrap_SDL_PollEvent(SDL_Event *e) {
  pump();
  inject((int)t_ms);
  gather_mouse();
  if (mqn) {
    struct mev m;
    if (!e) return 1;
    m = mq[0];
    memmove(mq, mq + 1, --mqn * sizeof mq[0]);
    memset(e, 0, sizeof *e);
    e->type = m.type;
    if (m.type == SDL_MOUSEMOTION) { e->motion.state = m.held; e->motion.x = m.x; e->motion.y = m.y; e->motion.xrel = m.xrel; e->motion.yrel = m.yrel; }
    else { e->button.button = m.button; e->button.state = m.type == SDL_MOUSEBUTTONDOWN ? SDL_PRESSED : SDL_RELEASED; e->button.x = m.x; e->button.y = m.y; }
    return 1;
  }
  {
    struct kev k;
    if (held_valid) { k = held; held_valid = 0; }
    else if (kqh != kqt) { k = kq[kqh]; kqh = (kqh + 1) & 255; }
    else return 0;
    if (!e) { held = k; held_valid = 1; return 1; }
    mods = k.down ? (mods | kmod_of(k.sym)) : (mods & ~kmod_of(k.sym));
    memset(e, 0, sizeof *e);
    e->type = k.down ? SDL_KEYDOWN : SDL_KEYUP;
    e->key.state = k.down ? SDL_PRESSED : SDL_RELEASED;
    e->key.keysym.scancode = k.scan & 0xff;
    e->key.keysym.sym = k.sym;
    e->key.keysym.mod = mods;
    e->key.keysym.unicode = 0;
    return 1;
  }
}
void __wrap_SDL_WarpMouse(Uint16 x, Uint16 y) { host_x = x; host_y = y; }
Uint8 __wrap_SDL_GetMouseState(int *x, int *y) { if (x) *x = ptr_x; if (y) *y = ptr_y; return ptr_b; }
time_t __wrap_time(time_t *p) { time_t t = 852076800 + (time_t)((int)t_ms / 1000); if (p) *p = t; return t; }

int __wrap_SDL_SetTimer(Uint32 interval, SDL_TimerCallback cb) {
  if (cb && interval) { timer_cb = cb; timer_interval = interval; timer_next = clock_now() + interval; }
  else timer_cb = 0;
  return 0;
}

int __wrap_SDL_OpenAudio(SDL_AudioSpec *d, SDL_AudioSpec *o) {
  if (d->format != AUDIO_U8 && d->format != AUDIO_S16LSB) return -1;
  if (d->channels != 1 && d->channels != 2) return -1;
  audio_frames = d->samples ? d->samples : 1;
  audio_freq = d->freq ? d->freq : 22050;
  audio_format = d->format;
  audio_bytes = audio_frames * d->channels * (d->format == AUDIO_U8 ? 1 : 2);
  audio_buf = malloc(audio_bytes);
  audio_cb = d->callback; audio_user = d->userdata;
  audio_open = 0;
  d->silence = d->format == AUDIO_U8 ? 0x80 : 0;
  d->size = audio_bytes;
  if (o) *o = *d;
  return 0;
}
void __wrap_SDL_PauseAudio(int on) {
  int run = !on && audio_buf && audio_cb;
  if (run && !audio_open) { audio_open = 1; mix_t0 = clock_now(); mixed = 0; }
  else if (!run && audio_open) audio_open = 0;
}
void __wrap_SDL_CloseAudio(void) { audio_open = 0; audio_cb = 0; }
/* No thread runs the device: locking it has nothing to keep out. */
void __wrap_SDL_LockAudio(void) {}
void __wrap_SDL_UnlockAudio(void) {}

/* ---- video: the dummy driver's surface for SDL, Mesa on EGL for GL */
static int vw = 640, vh = 480, frames;
SDL_Surface *__wrap_SDL_SetVideoMode(int w, int h, int bpp, Uint32 flags) {
  SDL_Surface *s = __real_SDL_SetVideoMode(w, h, bpp, flags & ~SDL_OPENGL);
  static int made;
  if (!(flags & SDL_OPENGL) || made) return s;
  made = 1; vw = w; vh = h;
  {
    PFNEGLGETPLATFORMDISPLAYEXTPROC get = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    EGLDisplay d = get(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
    static const EGLint cfg[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_NONE };
    EGLConfig conf; EGLint n;
    EGLContext ctx;
    GLuint fb, rb[2];
    if (!eglInitialize(d, NULL, NULL)) { fprintf(stderr, "cube wrap: eglInitialize failed\n"); exit(2); }
    eglBindAPI(EGL_OPENGL_API);
    if (!eglChooseConfig(d, cfg, &conf, 1, &n) || n < 1) { fprintf(stderr, "cube wrap: no config\n"); exit(2); }
    ctx = eglCreateContext(d, conf, EGL_NO_CONTEXT, NULL);
    if (!eglMakeCurrent(d, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)) { fprintf(stderr, "cube wrap: makeCurrent failed\n"); exit(2); }
    glGenFramebuffers(1, &fb); glBindFramebuffer(GL_FRAMEBUFFER, fb);
    glGenRenderbuffers(2, rb);
    glBindRenderbuffer(GL_RENDERBUFFER, rb[0]); glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA8, vw, vh);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, rb[0]);
    glBindRenderbuffer(GL_RENDERBUFFER, rb[1]); glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, vw, vh);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, rb[1]);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) { fprintf(stderr, "cube wrap: incomplete framebuffer\n"); exit(2); }
    glViewport(0, 0, vw, vh);
  }
  if (s) s->flags |= SDL_OPENGL;
  return s;
}
int __wrap_SDL_GL_SetAttribute(SDL_GLattr a, int v) { (void)a; (void)v; return 0; }
static int wanted(int n) {
  const char *p = getenv("PPM");
  while (p && *p) { if (atoi(p) == n) return 1; p = strchr(p, ','); if (p) p++; }
  return 0;
}
void __wrap_SDL_GL_SwapBuffers(void) {
  int stop = getenv("FRAMES") ? atoi(getenv("FRAMES")) : 1000, x, y;
  unsigned char *px;
  Uint32 h = 0x811c9dc5u;
  pump();
  glFinish();
  px = malloc((size_t)vw * vh * 4);
  glReadPixels(0, 0, vw, vh, GL_RGBA, GL_UNSIGNED_BYTE, px);
  for (y = vh - 1; y >= 0; y--) for (x = 0; x < vw * 4; x++) h = (h ^ px[(size_t)y * vw * 4 + x]) * 16777619u;
  printf("frame %d %08x\n", ++frames, h);
  if (wanted(frames)) {
    char name[64];
    FILE *o;
    sprintf(name, "cube-frame-%d.ppm", frames);
    o = fopen(name, "wb");
    fprintf(o, "P6\n%d %d\n255\n", vw, vh);
    for (y = vh - 1; y >= 0; y--) for (x = 0; x < vw; x++) fwrite(px + ((size_t)y * vw + x) * 4, 1, 3, o);
    fclose(o);
  }
  free(px);
  if (frames >= stop) { fflush(stdout); exit(0); }
}
/* The program selects the window's buffers; on the FBO they are its one colour attachment. */
void __wrap_glDrawBuffer(GLenum b) { (void)b; }
void __wrap_glReadBuffer(GLenum b) { (void)b; }
