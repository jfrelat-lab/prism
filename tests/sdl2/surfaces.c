/*
 * surfaces.c -- what SDL 2 does with software surfaces, for tools/gate-sdl2-surface.mjs.
 *
 * Built twice: against the real SDL 2 in the oracle (SDL_VIDEODRIVER=dummy; nothing here needs a
 * window), and by PRISM against src/env/sdl2-surface.js. Every scene is an operation a program in
 * the corpus performs -- SDLPoP's, mostly: a paletted sprite keyed onto a 24-bit screen, the same
 * sprite converted to 32 bits and blended, a translucent overlay merged over the picture, a blit
 * that hangs off the edge of a clip rectangle. Each prints what the program could observe: the
 * rectangle SDL wrote back, a checksum over every pixel byte of the result, and a few pixels.
 *
 * Patterns come from a small generator, so nothing depends on a data file.
 */
#include <stdio.h>
#include <string.h>
#include "SDL.h"

static unsigned seed;
static unsigned next(void) { seed = seed * 1664525u + 1013904223u; return seed >> 8; }

/* Every pixel byte of a surface, row padding left out. */
static unsigned sum(SDL_Surface *s) {
  unsigned h = 2166136261u;
  int x, y, n = s->w * s->format->BytesPerPixel;
  for (y = 0; y < s->h; y++) for (x = 0; x < n; x++) h = (h ^ ((Uint8 *)s->pixels)[y * s->pitch + x]) * 16777619u;
  return h;
}
static void show(const char *what, SDL_Surface *s) {
  int i, n = s->format->BytesPerPixel;
  printf("%-34s %08x ", what, sum(s));
  for (i = 0; i < 4; i++) {
    const Uint8 *p = (Uint8 *)s->pixels + (s->h * i / 4) * s->pitch + (s->w * (i + 1) / 5) * n;
    int k;
    printf(" ");
    for (k = 0; k < n; k++) printf("%02x", p[k]);
  }
  printf("\n");
}
static void noise(SDL_Surface *s) {
  int x, y, n = s->w * s->format->BytesPerPixel;
  for (y = 0; y < s->h; y++) for (x = 0; x < n; x++) ((Uint8 *)s->pixels)[y * s->pitch + x] = (Uint8)next();
}
static SDL_Surface *screen24(int w, int h) {
  SDL_Surface *s = SDL_CreateRGBSurface(0, w, h, 24, 0xFF, 0xFF << 8, 0xFF << 16, 0);
  noise(s);
  return s;
}
/* A 16-colour sprite, index 0 scattered through it as the transparent colour. */
static SDL_Surface *sprite8(int w, int h) {
  SDL_Surface *s = SDL_CreateRGBSurface(0, w, h, 8, 0, 0, 0, 0);
  SDL_Color colors[16];
  int i, x, y;
  for (i = 0; i < 16; i++) { colors[i].r = (Uint8)next(); colors[i].g = (Uint8)next(); colors[i].b = (Uint8)next(); colors[i].a = 255; }
  SDL_SetPaletteColors(s->format->palette, colors, 0, 16);
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) ((Uint8 *)s->pixels)[y * s->pitch + x] = (next() & 3) ? (Uint8)(next() & 15) : 0;
  return s;
}
static void describe(const char *what, SDL_Surface *s) {
  const SDL_PixelFormat *f = s->format;
  printf("%-22s format %08x bits %d bytes %d masks %08x %08x %08x %08x pitch %d palette %d  map %08x %08x\n", what,
         (unsigned)f->format, f->BitsPerPixel, f->BytesPerPixel, (unsigned)f->Rmask, (unsigned)f->Gmask, (unsigned)f->Bmask, (unsigned)f->Amask,
         s->pitch, f->palette ? f->palette->ncolors : 0,
         (unsigned)SDL_MapRGB(f, 0x12, 0x34, 0x56), (unsigned)SDL_MapRGBA(f, 0x12, 0x34, 0x56, 0x78));
}

int main(void) {
  SDL_Surface *dst, *spr, *conv, *argb, *over, *big;
  SDL_Rect r, q;
  int x, y, rc;

  if (SDL_Init(SDL_INIT_VIDEO) < 0) { printf("SDL_Init failed: %s\n", SDL_GetError()); return 1; }
  seed = 12345;

  /* 1. what a surface of each kind is */
  describe("8, no masks", SDL_CreateRGBSurface(0, 5, 2, 8, 0, 0, 0, 0));
  describe("24, no masks", SDL_CreateRGBSurface(0, 5, 2, 24, 0, 0, 0, 0));
  describe("24, R low", SDL_CreateRGBSurface(0, 5, 2, 24, 0xFF, 0xFF << 8, 0xFF << 16, 0));
  describe("32, no masks", SDL_CreateRGBSurface(0, 5, 2, 32, 0, 0, 0, 0));
  describe("32, R low, alpha", SDL_CreateRGBSurface(0, 5, 2, 32, 0xFF, 0xFF << 8, 0xFF << 16, 0xFFu << 24));
  describe("32, R high, alpha", SDL_CreateRGBSurface(0, 5, 2, 32, 0xFF << 16, 0xFF << 8, 0xFF, 0xFFu << 24));

  /* 2. a paletted sprite onto a 24-bit screen, plain and keyed */
  dst = screen24(40, 30); spr = sprite8(17, 13);
  r.x = 5; r.y = 4; r.w = 0; r.h = 0;
  rc = SDL_BlitSurface(spr, NULL, dst, &r);
  printf("plain: %d, rect %d %d %d %d\n", rc, r.x, r.y, r.w, r.h);
  show("8 -> 24", dst);
  printf("key alpha before %d", spr->format->palette->colors[0].a);
  SDL_SetColorKey(spr, SDL_TRUE, 0);
  printf(", keyed %d", spr->format->palette->colors[0].a);
  r.x = 20; r.y = 10;
  SDL_BlitSurface(spr, NULL, dst, &r);
  show(", 8 keyed -> 24", dst);

  /* 3. the keyed sprite converted to 32 bits, as SDLPoP does to recolour it, then blended on */
  conv = SDL_ConvertSurfaceFormat(spr, SDL_PIXELFORMAT_ARGB8888, 0);
  describe("converted", conv);
  show("8 keyed -> ARGB8888", conv);
  r.x = 1; r.y = 15;
  SDL_BlitSurface(conv, NULL, dst, &r);
  show("converted, as made -> 24", dst);
  SDL_SetSurfaceBlendMode(conv, SDL_BLENDMODE_NONE);
  r.x = 22; r.y = 1;
  SDL_BlitSurface(conv, NULL, dst, &r);
  show("converted, blend none -> 24", dst);
  SDL_SetColorKey(spr, SDL_FALSE, 0);
  printf("key off: alpha %d\n", spr->format->palette->colors[0].a);
  conv = SDL_ConvertSurface(spr, dst->format, 0);
  describe("8 -> the screen's own", conv);
  show("8 -> 24 by conversion", conv);

  /* 4. every alpha there is, blended onto 24 bits */
  argb = SDL_CreateRGBSurface(0, 32, 16, 32, 0xFF << 16, 0xFF << 8, 0xFF, 0xFFu << 24);
  for (y = 0; y < 16; y++) for (x = 0; x < 32; x++)
    ((Uint32 *)argb->pixels)[y * argb->pitch / 4 + x] = ((Uint32)((y * 32 + x) / 2) << 24) | (next() & 0xFFFFFF);
  r.x = 4; r.y = 7;
  SDL_BlitSurface(argb, NULL, dst, &r);
  show("ARGB8888 blended -> 24", dst);

  /* 5. SDLPoP's overlay: R-low 32 bits with alpha, filled translucent, merged over the picture */
  over = SDL_CreateRGBSurface(0, 40, 30, 32, 0xFF, 0xFF << 8, 0xFF << 16, 0xFFu << 24);
  r.x = 3; r.y = 2; r.w = 30; r.h = 9;
  SDL_FillRect(over, &r, SDL_MapRGBA(over->format, 0, 0, 0, 128));
  r.x = 10; r.y = 6; r.w = 25; r.h = 20;
  SDL_FillRect(over, &r, SDL_MapRGBA(over->format, 200, 30, 90, 77));
  show("overlay", over);
  SDL_BlitSurface(over, NULL, dst, NULL);
  show("overlay merged -> 24", dst);

  /* 6. 24 onto 24: a copy, and the same with black keyed out */
  big = screen24(40, 30);
  for (y = 0; y < 30; y++) for (x = 0; x < 40; x++) if ((next() & 3) == 0) memset((Uint8 *)big->pixels + y * big->pitch + x * 3, 0, 3);
  r.x = 0; r.y = 0; r.w = 40; r.h = 12; q = r;
  SDL_BlitSurface(big, &r, dst, &q);
  show("24 -> 24", dst);
  SDL_SetColorKey(big, SDL_TRUE, 0);
  SDL_BlitSurface(big, NULL, dst, NULL);
  show("24 keyed -> 24", dst);

  /* 7. clipping: a clip rectangle, and blits and fills that hang off it */
  r.x = 6; r.y = 5; r.w = 20; r.h = 14;
  printf("clip set %d", SDL_SetClipRect(dst, &r));
  r.x = -3; r.y = -2; r.w = 12; r.h = 11;
  q.x = 2; q.y = 1; q.w = 99; q.h = 99;
  rc = SDL_BlitSurface(spr, &r, dst, &q);
  printf(", blit %d rect %d %d %d %d", rc, q.x, q.y, q.w, q.h);
  q.x = 20; q.y = 14; q.w = 0; q.h = 0;
  SDL_BlitSurface(argb, NULL, dst, &q);
  printf(", blit rect %d %d %d %d", q.x, q.y, q.w, q.h);
  q.x = 30; q.y = 25;
  SDL_BlitSurface(spr, NULL, dst, &q);
  printf(", outside rect %d %d %d %d\n", q.x, q.y, q.w, q.h);
  r.x = -5; r.y = 10; r.w = 100; r.h = 3;
  SDL_FillRect(dst, &r, SDL_MapRGB(dst->format, 250, 128, 5));
  show("clipped", dst);
  r.x = 50; r.y = 50; r.w = 4; r.h = 4;
  printf("empty clip %d, full clip %d\n", SDL_SetClipRect(dst, &r), SDL_SetClipRect(dst, NULL));

  /* 8. doubled, as SDLPoP's "fuzzy" scaling does first */
  big = SDL_CreateRGBSurface(0, 80, 60, 24, 0xFF, 0xFF << 8, 0xFF << 16, 0);
  rc = SDL_BlitScaled(dst, NULL, big, NULL);
  printf("scaled %d\n", rc);
  show("24 doubled", big);

  SDL_Quit();
  return 0;
}
