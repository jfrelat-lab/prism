/*
 * wrap.c -- the native side of tools/scummvmdiff.mjs: ScummVM 0.6.1 built by g++ against the REAL
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
 *   SDL_PollEvent   pump; there are no events
 *   SDL_UpdateRects / SDL_UpdateRect / SDL_Flip   pump, present -- and here, print the frame's hash
 *   SDL_OpenAudio / SDL_PauseAudio / SDL_CloseAudio   the device is a callback pumped by the clock
 *   SDL_SetTimer    the periodic timer, fired by the pump
 *   time            the date PRISM's libc answers
 *
 * The pump is not re-entered (a callback that asks for the time is inside it), as in sdl12.js.
 * Each presented frame prints `frame N <hash>`: FNV-1a over the display's rows, w*bytes each, so a
 * difference of pitch between the two sides does not count.
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
static int audio_open, audio_freq, audio_frames, audio_bytes, audio_format, mix_t0, mixed;
static Uint8 *audio_buf;
static void (*audio_cb)(void *, Uint8 *, int);
static void *audio_user;

/* ---- the timer: sdl12.js SDL_SetTimer and its pump. */
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
      memset(audio_buf, (audio_format & 0xff) == 8 ? 0x80 : 0, audio_bytes);
      audio_cb(audio_user, audio_buf, audio_bytes);
      mixed++;
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
int __wrap_SDL_PollEvent(SDL_Event *e) { (void)e; pump(); return 0; }
time_t __wrap_time(time_t *p) { if (p) *p = 852076800; return 852076800; }

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
  if (frames == 1) printf("display %dx%dx%d masks %x %x %x\n", d->w, d->h, d->format->BitsPerPixel, d->format->Rmask, d->format->Gmask, d->format->Bmask);
  if (frames >= stop) { fflush(stdout); exit(0); }
}
void __wrap_SDL_UpdateRects(SDL_Surface *s, int n, SDL_Rect *r) { pump(); __real_SDL_UpdateRects(s, n, r); present(s); }
void __wrap_SDL_UpdateRect(SDL_Surface *s, Sint32 x, Sint32 y, Uint32 w, Uint32 h) { pump(); __real_SDL_UpdateRect(s, x, y, w, h); present(s); }
int __wrap_SDL_Flip(SDL_Surface *s) { pump(); __real_SDL_Flip(s); present(s); return 0; }
