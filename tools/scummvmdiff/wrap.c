/*
 * wrap.c -- the native side of tools/scummvmdiff.mjs: ScummVM (0.6.1, 0.10.0) built by g++ against the REAL
 * SDL 1.2, with exactly the parts of SDL that depend on time replaced, by `ld --wrap`, with what
 * src/env/sdl12.js does under PRISM's virtual clock (src/env/clock.js).
 *
 * Everything that DRAWS is real SDL: the display (the dummy video driver), the surfaces, the blits
 * that turn the game's 8-bit screen into the 16-bit display through its palette, the fills. What is
 * wrapped is what would otherwise make two runs differ -- and each wrapper is the shim's code
 * transcribed, with its order of clock readings, because the virtual clock advances 1/1024 ms at
 * every reading and a reading more or less on one side shifts every frame after it:
 *
 *   SDL_GetTicks    pump, then read the clock
 *   SDL_Delay       advance the clock, then pump
 *   SDL_PollEvent   pump; then the INPUT SCRIPT's events, made as sdl12.js makes them: the
 *                   mouse first (a motion when the host pointer moved, then a press or release per
 *                   changed button), then one key -- its symbol resolved by sdl12.js itself and
 *                   written into the script, its modifiers tracked here by symbol as there
 *   SDL_WarpMouse / SDL_GetMouseState   the host pointer, and SDL's own idea of it, as there
 *   SDL_UpdateRects / SDL_UpdateRect / SDL_Flip   pump, present -- and here, print the frame's hash
 *   SDL_OpenAudio / SDL_PauseAudio / SDL_CloseAudio   the device is a callback pumped by the clock
 *   SDL_SetTimer    the periodic timer, fired by the pump
 *   SDL_AddTimer / SDL_RemoveTimer   the newer timers (0.10.0's backend), fired by the pump before it
 *   time            the date PRISM's libc answers
 *
 * The pump is not re-entered (a callback that asks for the time is inside it), as in sdl12.js.
 * The script (EVENTS=<file>, written by tools/scummvmdiff.mjs) says what the host does and when, in
 * the virtual clock's ms, taken at each SDL_PollEvent after its pump without reading the clock
 * (a reading would advance it): `T k <scan> <down> <sym>` a key, `T m <x> <y> <buttons>` the pointer.
 *
 * Each presented frame prints `frame N <hash>`: FNV-1a over the display's rows, w*bytes each, so a
 * difference of pitch between the two sides does not count. Each buffer the audio callback fills
 * prints `audio N <hash>`, FNV-1a over its bytes: the sound, compared as the pictures are.
 */
#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

void __real_SDL_UpdateRects(SDL_Surface *, int, SDL_Rect *);
void __real_SDL_UpdateRect(SDL_Surface *, Sint32, Sint32, Uint32, Uint32);
int __real_SDL_Flip(SDL_Surface *);

/* ---- the virtual clock: src/env/clock.js virtualClock(), in doubles as JavaScript has it. */
static double t_ms = 0;
static int clock_now(void) { t_ms += 1.0 / 1024; return (int)t_ms; }
static void clock_delay(int ms) { if (ms > 0) t_ms += ms; }

/* ---- the audio device: src/env/sdl12.js SDL_OpenAudio over src/env/sdlmixer.js's pump. */
static int audio_open, audio_freq, audio_frames, audio_bytes, audio_format, mix_t0, mixed, audio_count;
static Uint8 *audio_buf;
static void (*audio_cb)(void *, Uint8 *, int);
static void *audio_user;

/* ---- the timer: sdl12.js SDL_SetTimer and its pump. */
static SDL_TimerCallback timer_cb;
static Uint32 timer_interval;
static double timer_next;

/* ---- the newer timers: sdl12.js SDL_AddTimer, fired after the audio and before SDL_SetTimer's, one
   clock reading each, in the order they were added. */
struct addtimer { int id; SDL_NewTimerCallback cb; void *param; Uint32 interval; double next; int live; };
static struct addtimer timers[16];
static int ntimers, next_timer_id;
static int timer_live(int id) { int i; for (i = 0; i < ntimers; i++) if (timers[i].id == id && timers[i].live) return 1; return 0; }
static void timer_drop(int id) {
  int i, j;
  for (i = 0; i < ntimers; i++) if (timers[i].id == id) { for (j = i; j < ntimers - 1; j++) timers[j] = timers[j + 1]; ntimers--; return; }
}

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
  if (ntimers) {
    int ids[16], k, count = ntimers;
    for (k = 0; k < count; k++) ids[k] = timers[k].id;
    for (k = 0; k < count; k++) {
      int i, n, now;
      if (!timer_live(ids[k])) continue;
      now = clock_now();
      for (n = 0; timer_live(ids[k]) && n < 64; n++) {
        Uint32 again;
        for (i = 0; i < ntimers && timers[i].id != ids[k]; i++) {}
        if (now < timers[i].next) break;
        again = timers[i].cb(timers[i].interval, timers[i].param);
        for (i = 0; i < ntimers && timers[i].id != ids[k]; i++) {}
        if (i == ntimers) break;
        if (!again) { timer_drop(ids[k]); break; }
        timers[i].interval = again; timers[i].next += again;
      }
      for (i = 0; i < ntimers && timers[i].id != ids[k]; i++) {}
      if (i < ntimers && now >= timers[i].next) timers[i].next = now + timers[i].interval;
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

/* ---- input: src/env/sdl12.js SDL_PollEvent and gatherMouse, transcribed. */
struct ev { int frame, kind, a, b, c; };
static struct ev script[8192];
static int nscript, scriptAt, loaded;
static int host_x, host_y, host_b;             /* the host's pointer (state.mouse.poll) */
static int ptr_x, ptr_y, ptr_b;                /* SDL's idea of it (sdl12.js `pointer`) */
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
time_t __wrap_time(time_t *p) { if (p) *p = 852076800; return 852076800; }

int __wrap_SDL_SetTimer(Uint32 interval, SDL_TimerCallback cb) {
  if (cb && interval) { timer_cb = cb; timer_interval = interval; timer_next = clock_now() + interval; }
  else timer_cb = 0;
  return 0;
}

SDL_TimerID __wrap_SDL_AddTimer(Uint32 interval, SDL_NewTimerCallback cb, void *param) {
  struct addtimer *t;
  if (!cb || ntimers == 16) return 0;
  t = &timers[ntimers++];
  t->id = ++next_timer_id; t->cb = cb; t->param = param; t->interval = interval; t->live = 1;
  t->next = clock_now() + interval;
  return (SDL_TimerID)(long)t->id;
}
SDL_bool __wrap_SDL_RemoveTimer(SDL_TimerID id) {
  if (!timer_live((int)(long)id)) return SDL_FALSE;
  timer_drop((int)(long)id);
  return SDL_TRUE;
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

/* ---- presenting: the hash of the display, and a stop after FRAMES of them. */
static int frames;
static void present(SDL_Surface *s) {
  SDL_Surface *d = s ? s : SDL_GetVideoSurface();
  Uint32 h = 0x811c9dc5u;
  int y, x, row = d->w * d->format->BytesPerPixel, stop = getenv("FRAMES") ? atoi(getenv("FRAMES")) : 1000;
  for (y = 0; y < d->h; y++) {
    const Uint8 *p = (const Uint8 *)d->pixels + y * d->pitch;
    for (x = 0; x < row; x++) h = (h ^ p[x]) * 16777619u;
  }
  printf("frame %d %08x\n", ++frames, h);
  /* DUMPAT=n: the display's rows at frame n, raw, into /work/scummvm-frame.raw -- to look at a difference. */
  if (getenv("DUMPAT") && atoi(getenv("DUMPAT")) == frames) {
    FILE *o = fopen("/work/scummvm-frame.raw", "wb");
    for (y = 0; o && y < d->h; y++) fwrite((const Uint8 *)d->pixels + y * d->pitch, 1, row, o);
    if (o) fclose(o);
  }
  if (frames == 1) printf("display %dx%dx%d masks %x %x %x\n", d->w, d->h, d->format->BitsPerPixel, d->format->Rmask, d->format->Gmask, d->format->Bmask);
  if (frames >= stop) { fflush(stdout); exit(0); }
}
void __wrap_SDL_UpdateRects(SDL_Surface *s, int n, SDL_Rect *r) { pump(); __real_SDL_UpdateRects(s, n, r); present(s); }
void __wrap_SDL_UpdateRect(SDL_Surface *s, Sint32 x, Sint32 y, Uint32 w, Uint32 h) { pump(); __real_SDL_UpdateRect(s, x, y, w, h); present(s); }
int __wrap_SDL_Flip(SDL_Surface *s) { pump(); __real_SDL_Flip(s); present(s); return 0; }
