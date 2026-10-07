/*
 * osdnull34.c — a headless platform backend for MAME 0.34, in C.
 *
 * The same purpose as osdnull.c, for the osd interface 0.34 has: the SAME MAME is built twice, once
 * by a real i386 gcc and once by PRISM, and every emulated frame prints a hash of the screen bitmap
 * and of the palette, so the first differing line names the frame at which the two builds part.
 *
 * What it replaces is src/msdos, less one file: src/msdos/fileio.c is compiled as it is, on both
 * sides, because finding a ROM in a zip by its CRC is the release's own code and worth holding.
 * The bitmap layout and the pen allocation below follow src/msdos/video.c, 8 bits deep always --
 * the three games that can use 16 run as `-depth 8` would run them.
 *
 * Deterministic by construction: no clock, no sound device (the sound CPUs still run), and input
 * only from a schedule both runs are given. The run ends by reporting Esc after MAX_FRAMES
 * emulated frames, which is how MAME's own loop ends.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "driver.h"
#include "osinline.h"

/*
 * The run's parameters come from the COMMAND LINE, not from the build: one native binary of 695
 * units serves every game.   <game> [frames [coin start fireFrom fireTo [dumpFrame]]]
 * The schedule is in emulated frames: a coin, then start, then fire held over a span. 0 = never.
 */
static int MAX_FRAMES = 300, PLAY_COIN, PLAY_START, PLAY_FIRE_FROM, PLAY_FIRE_TO, DUMP_FRAME = -1;

/* ---- what src/msdos/config.c and msdos.c define and the core or fileio.c read */
FILE *errorlog;
int ignorecfg;
int use_profiler;
int video_sync;
int frameskip;
char *rompath = ".;ROMS", *samplepath = ".;SAMPLES";
extern char *cfgdir, *hidir, *inpdir, *stadir, *artworkdir, *alternate_name;
void decompose_rom_sample_path(char *rompath, char *samplepath);

/*
 * ...and two the core reaches into the DOS layer for: sndhrdw/psgintf.c asks whether an OPL card
 * plays the YM2203 (never here: the chip is computed), and vidhrdw/vector.c marks 16x16 blocks
 * dirty through osinline.h's macro, straight into the layer's grid.
 */
unsigned char No_FM = 1;
static char dirty_grid[DIRTY_H * DIRTY_V];
char *dirty_new = dirty_grid;

static struct osd_bitmap *scrbitmap;
static unsigned char current_palette[256][3];
static int running;              /* the emulation loop has started (see osd_poll_joystick) */
static int frame;                /* emulated frames presented since then */

int osd_init(void) { return 0; }
void osd_exit(void) {}

/* ---- video: src/msdos/video.c's bitmap, with its 8-pixel safety area */
struct osd_bitmap *osd_new_bitmap(int width, int height, int depth)
{
	struct osd_bitmap *bitmap;
	(void)depth;
	if (Machine->orientation & ORIENTATION_SWAP_XY) { int t = width; width = height; height = t; }
	if ((bitmap = malloc(sizeof(struct osd_bitmap))) != 0)
	{
		int i, rowlen, rdwidth, safety = width > 32 ? 8 : 0;
		unsigned char *bm;
		bitmap->depth = 8;
		bitmap->width = width;
		bitmap->height = height;
		rdwidth = (width + 7) & ~7;
		rowlen = rdwidth + 2 * safety;
		if ((bm = malloc((height + 2 * safety) * rowlen)) == 0) { free(bitmap); return 0; }
		/* The safety area is written by routines that do not clip; start it defined. */
		memset(bm, 0, (height + 2 * safety) * rowlen);
		if ((bitmap->line = malloc(height * sizeof(unsigned char *))) == 0) { free(bm); free(bitmap); return 0; }
		for (i = 0; i < height; i++) bitmap->line[i] = &bm[(i + safety) * rowlen + safety];
		bitmap->_private = bm;
		osd_clearbitmap(bitmap);
	}
	return bitmap;
}

void osd_clearbitmap(struct osd_bitmap *bitmap)
{
	int i;
	for (i = 0; i < bitmap->height; i++) memset(bitmap->line[i], 0, bitmap->width);
	if (bitmap == scrbitmap) { extern int bitmap_dirty; bitmap_dirty = 1; }
}

void osd_free_bitmap(struct osd_bitmap *bitmap)
{
	if (bitmap) { free(bitmap->line); free(bitmap->_private); free(bitmap); }
}

struct osd_bitmap *osd_create_display(int width, int height, int attributes)
{
	(void)attributes;
	scrbitmap = osd_new_bitmap(width, height, 8);
	return scrbitmap;
}
int osd_set_display(int width, int height, int attributes) { (void)width; (void)height; (void)attributes; return 1; }
void osd_close_display(void) { osd_free_bitmap(scrbitmap); scrbitmap = 0; }

void osd_allocate_colors(unsigned int totalcolors, const unsigned char *palette, unsigned short *pens)
{
	unsigned int i;
	memset(current_palette, 0, sizeof current_palette);
	if (totalcolors >= 255)
	{
		int bestblack = 0, bestwhite = 0, bestblackscore = 3 * 255 * 255, bestwhitescore = 0;
		for (i = 0; i < totalcolors; i++) pens[i] = i;
		for (i = 0; i < totalcolors; i++)
		{
			int r = palette[3 * i], g = palette[3 * i + 1], b = palette[3 * i + 2], score = r * r + g * g + b * b;
			if (score < bestblackscore) { bestblack = i; bestblackscore = score; }
			if (score > bestwhitescore) { bestwhite = i; bestwhitescore = score; }
		}
		Machine->uifont->colortable[0] = pens[bestblack];
		Machine->uifont->colortable[1] = pens[bestwhite];
		Machine->uifont->colortable[2] = pens[bestwhite];
		Machine->uifont->colortable[3] = pens[bestblack];
	}
	else
	{
		current_palette[1][0] = current_palette[1][1] = current_palette[1][2] = 0xff;
		Machine->uifont->colortable[0] = 0;
		Machine->uifont->colortable[1] = 1;
		Machine->uifont->colortable[2] = 1;
		Machine->uifont->colortable[3] = 0;
		for (i = 0; i < totalcolors; i++) pens[i] = 255 - i;
	}
	for (i = 0; i < totalcolors && i < 256; i++)
	{
		current_palette[pens[i] & 255][0] = palette[3 * i];
		current_palette[pens[i] & 255][1] = palette[3 * i + 1];
		current_palette[pens[i] & 255][2] = palette[3 * i + 2];
	}
}

void osd_modify_pen(int pen, unsigned char red, unsigned char green, unsigned char blue)
{
	current_palette[pen & 255][0] = red;
	current_palette[pen & 255][1] = green;
	current_palette[pen & 255][2] = blue;
}
void osd_get_pen(int pen, unsigned char *red, unsigned char *green, unsigned char *blue)
{
	*red = current_palette[pen & 255][0];
	*green = current_palette[pen & 255][1];
	*blue = current_palette[pen & 255][2];
}
void osd_mark_dirty(int xmin, int ymin, int xmax, int ymax, int ui) { (void)xmin; (void)ymin; (void)xmax; (void)ymax; (void)ui; }
/* Never skip: a skipped frame is a frame not drawn, and the picture is what is compared. */
int osd_skip_this_frame(int recommend) { (void)recommend; return 0; }

static unsigned fnv(unsigned h, const unsigned char *p, int n)
{
	while (n-- > 0) { h ^= *p++; h *= 16777619u; }
	return h;
}

void osd_update_display(void)
{
	unsigned h = 2166136261u;
	int y;
	if (!running || !scrbitmap) return;
	for (y = 0; y < scrbitmap->height; y++) h = fnv(h, scrbitmap->line[y], scrbitmap->width);
	printf("frame %d %08x %08x\n", frame, h, fnv(2166136261u, &current_palette[0][0], sizeof current_palette));
	if (frame == DUMP_FRAME)
	{
		int x;
		printf("dump %d %d\n", scrbitmap->width, scrbitmap->height);
		for (y = 0; y < scrbitmap->height; y++)
		{
			for (x = 0; x < scrbitmap->width; x++) printf("%02x", scrbitmap->line[y][x]);
			printf("\n");
		}
		for (y = 0; y < 256; y++) printf("%02x%02x%02x", current_palette[y][0], current_palette[y][1], current_palette[y][2]);
		printf("\n");
		/* ...and the game's pens, which sit between its colours and the bitmap: a wrong picture
		   under a right palette starts here or in the game's own video memory. */
		printf("pens %d\n", (int)Machine->drv->total_colors);
		for (y = 0; y < (int)Machine->drv->total_colors; y++) printf("%04x%s", Machine->pens[y], (y & 31) == 31 ? "\n" : "");
		printf("\n");
		/* ...and the rectangle of the bitmap a player is shown: the driver's visible area, turned
		   and flipped as the bitmap was. src/msdos/video.c's adjust_display, to the letter. */
		{
			int xmin = Machine->drv->visible_area.min_x, ymin = Machine->drv->visible_area.min_y;
			int xmax = Machine->drv->visible_area.max_x, ymax = Machine->drv->visible_area.max_y;
			int w = Machine->drv->screen_width, h = Machine->drv->screen_height, temp;
			if (Machine->orientation & ORIENTATION_SWAP_XY)
			{
				temp = xmin; xmin = ymin; ymin = temp;
				temp = xmax; xmax = ymax; ymax = temp;
				temp = w; w = h; h = temp;
			}
			if (!(Machine->drv->video_attributes & VIDEO_TYPE_VECTOR))
			{
				if (Machine->orientation & ORIENTATION_FLIP_X) { temp = w - xmin - 1; xmin = w - xmax - 1; xmax = temp; }
				if (Machine->orientation & ORIENTATION_FLIP_Y) { temp = h - ymin - 1; ymin = h - ymax - 1; ymax = temp; }
				printf("visible %d %d %d %d\n", xmin, ymin, xmax, ymax);
			}
		}
	}
	frame++;
}
void osd_set_gamma(float _gamma) { (void)_gamma; }
float osd_get_gamma(void) { return 1.0f; }
void osd_set_brightness(int brightness) { (void)brightness; }
int osd_get_brightness(void) { return 100; }
void osd_save_snapshot(void) {}

/* ---- sound: none. Machine->sample_rate is 0, so the core mixes nothing and calls these rarely. */
void osd_update_audio(void) {}
void osd_play_sample(int channel, signed char *data, int len, int freq, int volume, int loop) { (void)channel; (void)data; (void)len; (void)freq; (void)volume; (void)loop; }
void osd_play_sample_16(int channel, signed short *data, int len, int freq, int volume, int loop) { (void)channel; (void)data; (void)len; (void)freq; (void)volume; (void)loop; }
void osd_play_streamed_sample(int channel, signed char *data, int len, int freq, int volume, int pan) { (void)channel; (void)data; (void)len; (void)freq; (void)volume; (void)pan; }
void osd_play_streamed_sample_16(int channel, signed short *data, int len, int freq, int volume, int pan) { (void)channel; (void)data; (void)len; (void)freq; (void)volume; (void)pan; }
void osd_adjust_sample(int channel, int freq, int volume) { (void)channel; (void)freq; (void)volume; }
void osd_stop_sample(int channel) { (void)channel; }
void osd_restart_sample(int channel) { (void)channel; }
int osd_get_sample_status(int channel) { (void)channel; return 1; }
void osd_ym2203_write(int n, int r, int v) { (void)n; (void)r; (void)v; }
void osd_ym2203_update(void) {}
void osd_ym3812_control(int reg) { (void)reg; }
void osd_ym3812_write(int data) { (void)data; }
void osd_set_mastervolume(int attenuation) { (void)attenuation; }
int osd_get_mastervolume(void) { return 0; }
void osd_sound_enable(int enable) { (void)enable; }

/*
 * ---- input.
 *
 * Before the emulation starts MAME shows up to three screens and waits at each: the copyright
 * (osd_read_key, then the key's release), the driver credits and the game information (Enter, by
 * osd_key_pressed_memory), and for a driver with flags a warning that wants O then K. Each is
 * answered at once. `running` turns on at the first osd_poll_joystick, which only the emulation's
 * own input update calls; from then on the keys are the schedule, counted in emulated frames.
 */
static int ui_reads, k_asked;

static int scheduled(int keycode)
{
	if (frame >= MAX_FRAMES && keycode == OSD_KEY_ESC) return 1;
	if (PLAY_COIN && keycode == OSD_KEY_3) return frame >= PLAY_COIN && frame < PLAY_COIN + 6;
	if (PLAY_START && keycode == OSD_KEY_1) return frame >= PLAY_START && frame < PLAY_START + 6;
	if (PLAY_FIRE_TO && keycode == OSD_KEY_LCONTROL) return frame >= PLAY_FIRE_FROM && frame < PLAY_FIRE_TO;
	return 0;
}

int osd_key_pressed(int keycode)
{
	if (keycode == OSD_KEY_FAST_EXIT || keycode == OSD_KEY_CANCEL) keycode = OSD_KEY_ESC;
	if (keycode < 0 || keycode > OSD_MAX_KEY) return 0;
	if (running) return scheduled(keycode);
	/* The warning screen: `while (pressed(K) == 0);` then `while (pressed(K));` -- down, then up. */
	if (keycode == OSD_KEY_K) return (k_asked++ & 1) == 0;
	return 0;
}

int osd_key_pressed_memory(int keycode)
{
	static char memory[OSD_MAX_PSEUDO + 1];
	int now;
	if (keycode < 0 || keycode > OSD_MAX_PSEUDO) return 0;
	if (!running) return keycode == OSD_KEY_ENTER;
	now = osd_key_pressed(keycode);
	if (now && !memory[keycode]) { memory[keycode] = 1; return 1; }
	if (!now) memory[keycode] = 0;
	return 0;
}
int osd_key_pressed_memory_repeat(int keycode, int speed) { (void)speed; return osd_key_pressed_memory(keycode); }
int osd_read_key_immediate(void) { return OSD_KEY_NONE; }
/* The copyright screen takes any key; the warning screen is asked next and wants O. */
int osd_read_key(int translate) { (void)translate; return ui_reads++ == 0 ? OSD_KEY_ENTER : OSD_KEY_O; }
int osd_read_keyrepeat(int translate) { return osd_read_key(translate); }
int key_to_pseudo_code(int k) { return k; }
const char *osd_joy_name(int joycode) { (void)joycode; return "None"; }
const char *osd_key_name(int keycode) { (void)keycode; return "key"; }
void osd_poll_joystick(void) { running = 1; }
int osd_joy_pressed(int joycode) { (void)joycode; return 0; }
int osd_joystick_needs_calibration(void) { return 0; }
void osd_joystick_start_calibration(void) {}
char *osd_joystick_calibrate_next(void) { return 0; }
void osd_joystick_calibrate(void) {}
void osd_joystick_end_calibration(void) {}
void osd_trak_read(int *deltax, int *deltay) { *deltax = *deltay = 0; }
void osd_analogjoy_read(int *analog_x, int *analog_y) { *analog_x = *analog_y = 0; }

/* ---- the rest */
void osd_led_w(int led, int on) { (void)led; (void)on; }
void osd_set_config(int def_samplerate, int def_samplebits) { (void)def_samplerate; (void)def_samplebits; }
void osd_save_config(int fs, int samplerate, int samplebits) { (void)fs; (void)samplerate; (void)samplebits; }
int osd_get_config_samplerate(int def_samplerate) { return def_samplerate; }
int osd_get_config_samplebits(int def_samplebits) { return def_samplebits; }
int osd_get_config_frameskip(int def_frameskip) { return def_frameskip; }
void osd_profiler(int type) { (void)type; }
void osd_net_sync(void) {}

int main(int argc, char **argv)
{
	static struct GameOptions options;
	int i, game = -1, res;
	if (argc < 2) { printf("usage: %s <game> [frames [coin start fireFrom fireTo [dumpFrame]]]\n", argv[0]); return 2; }
	if (argc > 2) MAX_FRAMES = atoi(argv[2]);
	if (argc > 6) { PLAY_COIN = atoi(argv[3]); PLAY_START = atoi(argv[4]); PLAY_FIRE_FROM = atoi(argv[5]); PLAY_FIRE_TO = atoi(argv[6]); }
	if (argc > 7) DUMP_FRAME = atoi(argv[7]);
	for (i = 0; drivers[i]; i++) if (strcmp(argv[1], drivers[i]->name) == 0) { game = i; break; }
	if (game < 0) { printf("Game \"%s\" not supported\n", argv[1]); return 1; }
	cfgdir = "CFG"; hidir = "HI"; inpdir = "INP"; stadir = "STA"; artworkdir = "ARTWORK";
	decompose_rom_sample_path(rompath, samplepath);
	/* No sound device: sample rate 0, as `-nosound` leaves it. No frames skipped, no cheats. */
	options.samplerate = 0;
	options.samplebits = 8;
	options.frameskip = 0;
	res = run_game(game, &options);
	printf("exit %d after %d frames\n", res, frame);
	return res;
}
