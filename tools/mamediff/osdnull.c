/*
 * osdnull.c — a headless platform backend for MAME 0.1, in C.
 *
 * It exists so the SAME MAME can be built twice, once by a real i386 gcc and once by PRISM, and
 * compared frame by frame. `osd_update_display` prints a hash of the display bitmap, so the first
 * differing line says exactly which frame the two builds stop agreeing on — the register-level
 * differential (tools/z80diff.mjs) proved the CPU, and this one covers everything above it.
 *
 * Deterministic by construction: no clock, no sound, and input only from a SCHEDULE compiled into
 * both builds -- see PLAY_COIN below. The run is bounded by reporting ESC after a fixed number of
 * frames, because MAME's main loop only ends on a keypress.
 *
 * It serves every release in the corpus. 0.4 moved the joystick across the boundary -- the four
 * `osd_joy_*` globals a driver used to read became `osd_joy_pressed(joycode)` -- so which side of
 * that line this file is on comes from the release, not from a guess.
 */

#include <stdio.h>
#include <stdlib.h>
#include "osdepend.h"

#ifndef MAX_FRAMES
#define MAX_FRAMES 400
#endif

/*
 * stricmp is a DOS-ism with no ISO equivalent, so glibc does not have it and the platform layer must
 * supply it — the same role src/msdos/msdos.c plays on DJGPP. PRISM provides it as a builtin; here it
 * is written out so the gcc side links.
 */
int stricmp(const char *a, const char *b)
{
  while (*a && *b)
  {
    int x = *a, y = *b;
    if (x >= 'A' && x <= 'Z') x += 32;
    if (y >= 'A' && y <= 'Z') y += 32;
    if (x != y) return x < y ? -1 : 1;
    a++; b++;
  }
  if (*a == *b) return 0;
  return *a ? 1 : -1;
}

int play_sound = 0;
#ifdef OSD_JOY_FIRE          /* 0.4 and later: a function, and the globals are gone */
int osd_joy_pressed(int joycode) { return 0; }
#else
int osd_joy_up = 0, osd_joy_down = 0, osd_joy_left = 0, osd_joy_right = 0;
int osd_joy_b1 = 0, osd_joy_b2 = 0, osd_joy_b3 = 0, osd_joy_b4 = 0;
#endif

static struct osd_bitmap *display = 0;
static int frames = 0;
static int pens = 0;

int osd_init(int argc, char **argv) { return 0; }
void osd_exit(void) { printf("done: %d frames, %d pens\n", frames, pens); }

struct osd_bitmap *osd_create_bitmap(int width, int height)
{
  struct osd_bitmap *b;
  unsigned char *pix;
  int y;

  b = (struct osd_bitmap *)malloc(sizeof(struct osd_bitmap) + height * sizeof(unsigned char *));
  pix = (unsigned char *)malloc(width * height);
  for (y = 0; y < width * height; y++) pix[y] = 0;
  b->width = width;
  b->height = height;
  b->private = pix;
  for (y = 0; y < height; y++) b->line[y] = pix + y * width;
  return b;
}

void osd_free_bitmap(struct osd_bitmap *bitmap) { }

struct osd_bitmap *osd_create_display(int width, int height)
{
  display = osd_create_bitmap(width, height);
  printf("display %dx%d\n", width, height);
  return display;
}

void osd_close_display(void) { }

int osd_obtain_pen(unsigned char red, unsigned char green, unsigned char blue)
{
  printf("pen %d = %02x%02x%02x\n", pens, red, green, blue);
  return pens++;
}

void osd_update_display(void)
{
  unsigned long h = 5381;
  int y, x, nz = 0;

  frames++;
  if (display)
  {
    for (y = 0; y < display->height; y++)
      for (x = 0; x < display->width; x++)
      {
        unsigned char v = display->line[y][x];
        h = h * 33 + v;
        if (v) nz++;
      }
  }
  /* Every frame, so the first divergence is pinned to the frame it happens on. */
  printf("frame %d hash %08lx nz %d\n", frames, h & 0xffffffffUL, nz);
}

void osd_update_audio(void) { }
void osd_play_sample(int channel, unsigned char *data, int len, int freq, int volume, int loop) { }
void osd_play_streamed_sample(int channel, unsigned char *data, int len, int freq, int volume) { }
void osd_adjust_sample(int channel, int freq, int volume) { }
void osd_stop_sample(int channel) { }

/*
 * Bounded run, and -- with --play -- a PLAYED one.
 *
 * An attract mode exercises a driver's tilemap and nothing else: the sprites, the collision code and
 * the blitter modes a game uses while somebody is holding the fire button are never reached, so a
 * report of "shooting looks wrong" cannot be compared against a native build at all. The schedule is
 * three numbers and it is compiled into BOTH sides, so the two runs are still identical by
 * construction: this adds input, not nondeterminism.
 *
 * A key is held for eight frames from its moment, which is long enough for MAME's own edge detection
 * to see it and short enough not to jam the input.
 */
int osd_key_pressed(int keycode)
{
  if (keycode == OSD_KEY_ESC && frames >= MAX_FRAMES) return 1;
#ifdef PLAY_COIN
  if (keycode == OSD_KEY_3 && frames >= PLAY_COIN && frames < PLAY_COIN + 8) return 1;
  if (keycode == OSD_KEY_1 && frames >= PLAY_START && frames < PLAY_START + 8) return 1;
  if (keycode == OSD_KEY_CONTROL && frames >= PLAY_FIRE_FROM && frames < PLAY_FIRE_TO) return 1;
#endif
  return 0;
}

int osd_read_key(void) { return OSD_KEY_ESC; }
void osd_poll_joystick(void) { }
