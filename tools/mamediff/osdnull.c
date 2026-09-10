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

#ifdef HASH_RAM
/*
 * THE WHOLE MACHINE STATE, hashed per frame — `unsigned char RAM[0x20000]` in machine.c, which is
 * MAME's entire CPU-visible address space plus its graphics area.
 *
 * Why this and not the picture: a display hash only diverges once the difference has been DRAWN, so
 * the frame it names is the frame the symptom became visible, not the frame the machine went wrong.
 * Hashing memory says when the two builds' state actually parted, which may be much earlier and
 * invisible. Generic across every driver and release — nothing here knows which game is running.
 *
 * The two halves are hashed apart because they answer different questions: 0x00000-0x0ffff is the
 * Z80's address space (the game's own state), and everything above it is decoded graphics and
 * samples, which are built once at load time and should never change at all.
 */
extern unsigned char RAM[];
#endif

#ifdef DUMP_VRAM
/*
 * The GAME's video RAM, read through the pointer MAME's own memory map filled in
 * (`{ 0x4000, 0x7fff, wow_videoram_w, &wow_videoram }` in wow/driver.c).
 *
 * WHY THIS IS THE QUESTION. `wow_videoram_w` early-outs on an unchanged byte and then writes all
 * four of that byte's pixels from scratch, so a pixel's value depends only on the LAST accepted
 * write to its byte -- which makes the picture a pure function of the video RAM's CONTENT. Dumping
 * the content therefore splits the diagnosis in two and cannot be argued with: same bytes and a
 * different picture means the write handler was invoked differently; different bytes means the
 * divergence is upstream of the video hardware entirely.
 *
 * Declared here rather than added to the game: osdnull.c is the harness's own file, and referencing
 * a global the driver already exports is not a modification of it. It is wow-specific, which is why
 * it is behind a define and not compiled for any other driver.
 */
extern unsigned char *wow_videoram;
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
#ifdef HASH_RAM
  {
    unsigned long r1 = 5381, r2 = 5381;
    int i;
    for (i = 0; i < 0x10000; i++) r1 = r1 * 33 + RAM[i];
    for (i = 0x10000; i < 0x20000; i++) r2 = r2 * 33 + RAM[i];
    printf("frame %d hash %08lx nz %d cpu %08lx gfx %08lx\n", frames, h & 0xffffffffUL, nz,
           r1 & 0xffffffffUL, r2 & 0xffffffffUL);
  }
#else
  printf("frame %d hash %08lx nz %d\n", frames, h & 0xffffffffUL, nz);
#endif

  /*
   * ONE FRAME, PIXEL BY PIXEL, when asked. A hash says two frames differ and nothing else; the next
   * question is always which pixels and which pens, and that cannot be answered from a hash by
   * anyone. -DDUMP_FRAME=N is compiled into BOTH sides, so the dump is produced by the same code on
   * the same frame and the comparison stays a comparison.
   *
   * It goes to stdout rather than to a file because PRISM's guest has no host filesystem to write
   * to, and stdout is the one channel both builds already share. `pix` prefixes the rows so the
   * frame-hash diff can ignore them and read them separately.
   */
#ifdef DUMP_FRAME
  if (frames == DUMP_FRAME && display)
  {
    printf("dump %d %d\n", display->width, display->height);
    for (y = 0; y < display->height; y++)
    {
      printf("pix");
      for (x = 0; x < display->width; x++) printf("%02x", display->line[y][x]);
      printf("\n");
    }
#ifdef HASH_RAM
    /*
     * The Z80's whole address space, 256 bytes a row, so a diff names an ADDRESS. Emitted with the
     * frame dump because "which bytes" is the question a hash mismatch always raises next.
     */
    for (y = 0; y < 256; y++)
    {
      printf("mem");
      for (x = 0; x < 256; x++) printf("%02x", RAM[y * 256 + x]);
      printf("\n");
    }
#endif
#ifdef DUMP_VRAM
    /* 80 bytes per screen row: two per 8-pixel group, 40 groups. See the note above. */
    if (wow_videoram)
      for (y = 0; y < 204; y++)
      {
        printf("vrm");
        for (x = 0; x < 80; x++) printf("%02x", wow_videoram[y * 80 + x]);
        printf("\n");
      }
#endif
  }
#endif
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
