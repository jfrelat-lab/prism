/*
 * sdl2-capture.c -- record what an SDL 2 program shows, from outside it. For tools/gate-sdlpop-pixels.mjs.
 *
 * Preloaded (LD_PRELOAD) into a program built from unmodified source against the real SDL 2, it
 * stands in front of SDL_UpdateTexture -- the call by which a software-rendering program hands its
 * finished picture to SDL -- and writes one line per DISTINCT picture: two FNV-1a hashes over the
 * pixel bytes, row padding left out. Nothing of the picture itself is kept.
 *
 * It also plays a key script, because a reference that never leaves the title screen says little.
 * A key is tied to a count of distinct pictures, not to a time: the program's logic advances by its
 * own ticks, the pictures follow from the logic, and a wall clock is the one thing two runs on two
 * machines do not share.
 *
 *   SDL2_CAPTURE_OUT=<file>        where the hashes go
 *   SDL2_CAPTURE_KEYS=n:code:d,... at distinct picture n, SDL scancode `code` goes down (d=1) or up (d=0)
 *   SDL2_CAPTURE_STOP=n            leave after n distinct pictures
 *   SDL2_CAPTURE_DUMP=a-b          for debugging: write distinct pictures a..b as dump-<n>.ppm (24-bit only)
 *
 *   gcc -shared -fPIC -o sdl2-capture.so sdl2-capture.c -I/usr/include/SDL2 -ldl
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "SDL.h"

static FILE *out;
static int distinct, stop_at, started;
static unsigned last_a, last_b;
static struct { int at, code, down; } keys[256];
static int nkeys, next_key;

static void start(void) {
  const char *k = getenv("SDL2_CAPTURE_KEYS"), *s = getenv("SDL2_CAPTURE_STOP"), *o = getenv("SDL2_CAPTURE_OUT");
  started = 1;
  out = o ? fopen(o, "w") : stdout;
  stop_at = s ? atoi(s) : 0;
  while (k && *k && nkeys < 256) {
    if (sscanf(k, "%d:%d:%d", &keys[nkeys].at, &keys[nkeys].code, &keys[nkeys].down) == 3) nkeys++;
    k = strchr(k, ',');
    if (k) k++;
  }
}

int SDL_UpdateTexture(SDL_Texture *texture, const SDL_Rect *rect, const void *pixels, int pitch) {
  static int (*real)(SDL_Texture *, const SDL_Rect *, const void *, int);
  Uint32 format = 0;
  int w = 0, h = 0, y, x, n;
  unsigned a = 2166136261u, b = 0x9747b28cu;
  if (!real) real = (int (*)(SDL_Texture *, const SDL_Rect *, const void *, int))dlsym(RTLD_NEXT, "SDL_UpdateTexture");
  if (!started) start();
  SDL_QueryTexture(texture, &format, NULL, &w, &h);
  n = w * SDL_BYTESPERPIXEL(format);
  for (y = 0; y < h; y++) {
    const Uint8 *p = (const Uint8 *)pixels + y * pitch;
    for (x = 0; x < n; x++) { a = (a ^ p[x]) * 16777619u; b = (b ^ p[x]) * 16777619u; }
  }
  if (!distinct || a != last_a || b != last_b) {
    distinct++; last_a = a; last_b = b;
    fprintf(out, "%08x%08x\n", a, b);
    fflush(out);
    if (getenv("SDL2_CAPTURE_DUMP") && SDL_BYTESPERPIXEL(format) == 3) {
      int from = 0, to = 0;
      sscanf(getenv("SDL2_CAPTURE_DUMP"), "%d-%d", &from, &to);
      if (distinct >= from && distinct <= to) {
        char name[64];
        FILE *f;
        sprintf(name, "dump-%d.ppm", distinct);
        f = fopen(name, "wb");
        fprintf(f, "P6 %d %d 255\n", w, h);
        for (y = 0; y < h; y++) fwrite((const Uint8 *)pixels + y * pitch, 1, n, f);
        fclose(f);
      }
    }
    while (next_key < nkeys && keys[next_key].at <= distinct) {
      SDL_Event e;
      memset(&e, 0, sizeof e);
      e.type = keys[next_key].down ? SDL_KEYDOWN : SDL_KEYUP;
      e.key.state = keys[next_key].down ? SDL_PRESSED : SDL_RELEASED;
      e.key.keysym.scancode = (SDL_Scancode)keys[next_key].code;
      SDL_PushEvent(&e);
      next_key++;
    }
    if (stop_at && distinct >= stop_at) { fclose(out); _exit(0); }
  }
  return real(texture, rect, pixels, pitch);
}
