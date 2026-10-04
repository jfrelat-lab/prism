/*
 * images.c -- what SDL_image makes of a PNG file, for tools/gate-sdl2-image.mjs.
 *
 * Built twice: against the real SDL 2 and SDL_image in the oracle, and by PRISM against
 * src/env/sdl2-image.js. For every file named on the command line it loads the image and prints
 * what a program can observe of the surface it gets back -- the format, the palette's size, whether
 * there is a colour key and which, the blend mode -- with a checksum over every pixel byte and one
 * over the palette. The files are the gate's: one of each kind of PNG there is.
 */
#include <stdio.h>
#include "SDL.h"
#include "SDL_image.h"

static unsigned fnv(unsigned h, const Uint8 *p, int n) { while (n-- > 0) h = (h ^ *p++) * 16777619u; return h; }

int main(int argc, char **argv) {
  int i, y;
  if (SDL_Init(SDL_INIT_VIDEO) < 0) { printf("SDL_Init failed\n"); return 1; }
  for (i = 1; i < argc; i++) {
    SDL_Surface *s = IMG_Load(argv[i]);
    SDL_BlendMode mode = SDL_BLENDMODE_NONE;
    Uint32 key = 0;
    unsigned px = 2166136261u, pal = 2166136261u;
    int keyed;
    if (!s) { printf("%-16s not loaded\n", argv[i]); continue; }
    keyed = SDL_GetColorKey(s, &key) == 0;
    SDL_GetSurfaceBlendMode(s, &mode);
    for (y = 0; y < s->h; y++) px = fnv(px, (Uint8 *)s->pixels + y * s->pitch, s->w * s->format->BytesPerPixel);
    if (s->format->palette) pal = fnv(pal, (Uint8 *)s->format->palette->colors, 4 * s->format->palette->ncolors);
    printf("%-16s %dx%d format %08x bits %d colours %d key %s%08x blend %d pixels %08x palette %08x\n", argv[i], s->w, s->h,
           (unsigned)s->format->format, s->format->BitsPerPixel, s->format->palette ? s->format->palette->ncolors : 0,
           keyed ? "" : "none ", keyed ? (unsigned)key : 0u, (int)mode, px, pal);
    SDL_FreeSurface(s);
  }
  printf("missing: %s\n", IMG_Load("no-such-file.png") ? "loaded?" : "null");
  SDL_Quit();
  return 0;
}
