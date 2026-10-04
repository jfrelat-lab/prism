/*
 * mixer.c -- what SDL_mixer does with sound effects, for tools/gate-sdl-mixer.mjs.
 *
 *   mixer [rate bits channels]      the device, 22050 16 2 when not given
 *
 * Built twice: against the real SDL 1.2 and SDL_mixer 1.2 in the oracle (SDL_AUDIODRIVER=dummy, so
 * no sound card is needed), and by PRISM against src/env/sdl12.js and sdlmixer.js. It writes three
 * WAV files itself, in three formats, so that each conversion SDL makes when loading is exercised:
 *
 *   a.wav   44100 Hz, stereo, 16-bit   -> halved to the device's 22050 Hz
 *   b.wav   22050 Hz, mono,   8-bit    -> widened to 16 bits and to stereo
 *   c.wav   11025 Hz, mono,   16-bit   -> doubled in rate, and to stereo
 *
 * plays them together on three channels -- one at a chunk volume of 64, one on a channel at 96, one
 * looped once -- and CAPTURES the mixed stream with Mix_SetPostMix, the hook SDL_mixer gives a
 * program to see exactly what goes to the device. The three start under SDL_LockAudio, so they
 * start in the same buffer; the capture is trimmed of the silence before and after, and what is
 * printed is its length, a checksum of every byte, and samples from along it.
 *
 * The waveforms are integer ramps, not sines: nothing here depends on libm. Their peaks are odd and
 * add up past 32767, so the stream has samples that only clipping explains and halvings that only
 * one rounding explains.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "SDL.h"
#include "SDL_mixer.h"

#define CAPACITY (1 << 21)
static unsigned char captured[CAPACITY];
static int capturedLen;

static void post(void *udata, Uint8 *stream, int len) {
  (void)udata;
  if (capturedLen + len <= CAPACITY) { memcpy(captured + capturedLen, stream, len); capturedLen += len; }
}

static void le32(FILE *f, unsigned v) { fputc(v & 255, f); fputc((v >> 8) & 255, f); fputc((v >> 16) & 255, f); fputc((v >> 24) & 255, f); }
static void le16(FILE *f, unsigned v) { fputc(v & 255, f); fputc((v >> 8) & 255, f); }

/* A ramp of `period` frames, peak `amp`, the right channel a quarter period behind the left. */
static void writeWav(const char *name, int rate, int channels, int bits, int frames, int period, int amp) {
  FILE *f = fopen(name, "wb");
  int bytes = frames * channels * (bits / 8), i, c;
  fwrite("RIFF", 1, 4, f); le32(f, 36 + bytes); fwrite("WAVEfmt ", 1, 8, f);
  le32(f, 16); le16(f, 1); le16(f, channels); le32(f, rate); le32(f, rate * channels * (bits / 8));
  le16(f, channels * (bits / 8)); le16(f, bits);
  fwrite("data", 1, 4, f); le32(f, bytes);
  for (i = 0; i < frames; i++) {
    for (c = 0; c < channels; c++) {
      int phase = (i + c * period / 4) % period;
      int v = (phase * 2 * amp) / period - amp;               /* -amp .. amp */
      if (v == 0) v = 1;                                      /* never silent: the trim relies on it */
      if (bits == 16) le16(f, (unsigned)v & 0xffff); else fputc((v >> 8) + 128, f);
    }
  }
  fclose(f);
}

int main(int argc, char **argv) {
  int rate = argc > 3 ? atoi(argv[1]) : 22050, bits = argc > 3 ? atoi(argv[2]) : 16, out = argc > 3 ? atoi(argv[3]) : 2;
  int frame = (bits / 8) * out, silence = bits == 8 ? 0x80 : 0;
  int freq = 0, channels = 0, i, first, last, v[4];
  Uint16 format = 0;
  Mix_Chunk *a, *b, *c;
  unsigned sum = 2166136261u;

  if (SDL_Init(SDL_INIT_AUDIO) < 0) { printf("SDL_Init failed\n"); return 1; }
  if (Mix_OpenAudio(rate, bits == 8 ? AUDIO_U8 : AUDIO_S16LSB, out, 1024) < 0) { printf("Mix_OpenAudio failed\n"); return 1; }
  Mix_QuerySpec(&freq, &format, &channels);
  printf("device %d Hz, format %x, %d channels\n", freq, format, channels);

  writeWav("a.wav", 44100, 2, 16, 9000, 100, 21001);
  writeWav("b.wav", 22050, 1, 8, 3000, 37, 9000);
  writeWav("c.wav", 11025, 1, 16, 2500, 23, 23003);
  a = Mix_LoadWAV("a.wav"); b = Mix_LoadWAV("b.wav"); c = Mix_LoadWAV("c.wav");
  if (!a || !b || !c) { printf("Mix_LoadWAV failed\n"); return 1; }
  printf("loaded %u %u %u bytes; missing: %s\n", (unsigned)a->alen, (unsigned)b->alen, (unsigned)c->alen,
         Mix_LoadWAV("none.wav") ? "loaded?" : "null");

  /* One call per statement: the order of evaluation of arguments is not the compiler's to promise. */
  v[0] = Mix_VolumeChunk(b, 64); v[1] = Mix_Volume(2, 96); v[2] = Mix_VolumeChunk(b, -1); v[3] = Mix_Volume(2, -1);
  printf("volumes %d %d %d %d\n", v[0], v[1], v[2], v[3]);
  Mix_SetPostMix(post, NULL);
  SDL_LockAudio();
  v[0] = Mix_PlayChannel(0, a, 0); v[1] = Mix_PlayChannel(1, b, 1); v[2] = Mix_PlayChannel(-1, c, 0);
  SDL_UnlockAudio();
  printf("channels %d %d %d, playing %d\n", v[0], v[1], v[2], Mix_Playing(-1));
  for (i = 0; i < 400 && Mix_Playing(-1); i++) SDL_Delay(10);
  SDL_Delay(120);
  SDL_LockAudio();
  Mix_SetPostMix(NULL, NULL);
  SDL_UnlockAudio();
  printf("still playing %d\n", Mix_Playing(-1));

  for (first = 0; first < capturedLen && captured[first] == silence; first++) {}
  first -= first % frame;                                     /* whole frames */
  for (last = capturedLen; last > first && captured[last - 1] == silence; last--) {}
  last += (frame - last % frame) % frame;
  for (i = first; i < last; i++) sum = (sum ^ captured[i]) * 16777619u;
  printf("mixed %d frames, checksum %08x\n", (last - first) / frame, sum);
  for (i = 0; i < 12; i++) {
    int at = first + ((last - first) / frame) * i / 12 * frame, c;
    printf("  frame %6d:", (at - first) / frame);
    for (c = 0; c < out; c++) {
      if (bits == 16) printf(" %6d", (short)(captured[at + 2 * c] | (captured[at + 2 * c + 1] << 8)));
      else printf(" %6d", captured[at + c]);
    }
    printf("\n");
  }

  Mix_HaltChannel(-1);
  Mix_FreeChunk(a); Mix_FreeChunk(b); Mix_FreeChunk(c);
  Mix_CloseAudio();
  SDL_Quit();
  return 0;
}
