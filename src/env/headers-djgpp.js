// headers-djgpp.js — the headers a DOS/DJGPP program includes, plus the two libraries MAME 0.1 links.
//
// These exist so that `src/msdos/msdos.c` — MAME's OWN platform backend, the file its makefile picks
// for DOS — compiles unmodified. Until now PRISM hand-wrote a replacement for that file in
// JavaScript; supplying the headers and the libraries instead is what moves the compatibility
// boundary off the program and onto the library, which is the whole premise of the project.
//
// Every declaration below was put here because msdos.c or TwkUser.c names it. Nothing is anticipated.

/*
 * DJGPP's memory-move helpers. On real hardware these copy across a selector into the low megabyte;
 * here the low megabyte is part of the same image, so `_dosmemputl(src, n, 0xa0000)` writes exactly
 * where a real one would and the page reads the result from there.
 */
const GO32 = `
#ifndef _PRISM_GO32_H
#define _PRISM_GO32_H
extern unsigned short _go32_my_ds(void);
extern unsigned long _go32_info_block;
extern int _dos_ds;
void dosmemget(unsigned long offset, int length, void *buffer);
void dosmemput(const void *buffer, int length, unsigned long offset);
void _dosmemgetb(unsigned long offset, int length, void *buffer);
void _dosmemgetw(unsigned long offset, int length, void *buffer);
void _dosmemgetl(unsigned long offset, int length, void *buffer);
void _dosmemputb(const void *buffer, int length, unsigned long offset);
void _dosmemputw(const void *buffer, int length, unsigned long offset);
void _dosmemputl(const void *buffer, int length, unsigned long offset);
void movedata(unsigned srcsel, unsigned srcoff, unsigned dstsel, unsigned dstoff, unsigned n);
#endif
`;

const FARPTR = `
#ifndef _PRISM_FARPTR_H
#define _PRISM_FARPTR_H
#include <go32.h>
void _farpokeb(unsigned short sel, unsigned long off, unsigned char v);
void _farpokew(unsigned short sel, unsigned long off, unsigned short v);
void _farpokel(unsigned short sel, unsigned long off, unsigned long v);
unsigned char _farpeekb(unsigned short sel, unsigned long off);
unsigned short _farpeekw(unsigned short sel, unsigned long off);
unsigned long _farpeekl(unsigned short sel, unsigned long off);
void _farsetsel(unsigned short sel);
unsigned short _fargetsel(void);
void _farnspokeb(unsigned long off, unsigned char v);
void _farnspokew(unsigned long off, unsigned short v);
void _farnspokel(unsigned long off, unsigned long v);
unsigned char _farnspeekb(unsigned long off);
unsigned short _farnspeekw(unsigned long off);
unsigned long _farnspeekl(unsigned long off);
#endif
`;

/* TwkUser.c includes <dos.h> and <io.h> and uses the port intrinsics from them. */
const DOSH = `
#ifndef _PRISM_DOS_H
#define _PRISM_DOS_H
#include <pc.h>
void delay(unsigned msec);
#endif
`;

const IOH = `
#ifndef _PRISM_IO_H
#define _PRISM_IO_H
#include <unistd.h>
#define O_BINARY 0
long filelength(int handle);
#endif
`;

/*
 * Allegro, as much of it as MAME 0.1 uses: thirteen functions, four types and one array, measured by
 * grepping msdos.c rather than by reading Allegro's own header.
 *
 * BITMAP is deliberately NOT Allegro's full struct. msdos.c touches exactly two things through a
 * BITMAP — `bmp->line[y]` when it saves an F12 snapshot, and the opaque `screen` it hands to
 * bmp_write_line and save_pcx — so the layout carries those and says so, rather than reproducing a
 * vtable and bank-switch pointers that would never be read. `create_bitmap` in src/env/allegro.js
 * builds the object, so the two definitions are one thing in two places, exactly as with XImage.
 */
const ALLEGRO = `
#ifndef _PRISM_ALLEGRO_H
#define _PRISM_ALLEGRO_H

#define GFX_TEXT      -1
#define GFX_AUTODETECT 0
#define GFX_VGA        1
#define GFX_MODEX      2
#define GFX_VESA1      3
#define GFX_VESA2B     5

typedef struct BITMAP {
   int w, h;
   int clip;
   int cl, cr, ct, cb;
   void *vtable;
   void *write_bank;
   void *read_bank;
   void *dat;
   int   id;
   void *extra;
   int   x_ofs, y_ofs, seg;
   unsigned char *line[1];
} BITMAP;

typedef struct RGB { unsigned char r, g, b, filler; } RGB;
typedef RGB PALETTE[256];

extern BITMAP *screen;
extern char key[128];
extern int joy_x, joy_y;
extern int joy_left, joy_right, joy_up, joy_down;
extern int joy_b1, joy_b2, joy_b3, joy_b4;

int  allegro_init(void);
void allegro_exit(void);
int  install_keyboard(void);
void remove_keyboard(void);
int  set_gfx_mode(int card, int w, int h, int v_w, int v_h);
void set_color(int index, const RGB *p);
void set_palette(const RGB *p);
void get_palette(RGB *p);
BITMAP *create_bitmap(int width, int height);
void destroy_bitmap(BITMAP *bitmap);
int  save_pcx(const char *filename, BITMAP *bmp, const RGB *pal);
int  readkey(void);
int  keypressed(void);
void clear_keybuf(void);
int  initialise_joystick(void);
int  poll_joystick(void);
unsigned long bmp_write_line(BITMAP *bmp, int line);
void vsync(void);
#endif
`;

/*
 * SEAL (`audio.h`), the sound library MAME 0.1 links on DOS. Seventeen functions, all of which this
 * host answers with success and silence — there is no audio path in PRISM yet, and a library that
 * reports failure would send msdos.c down its `return 1` and abort osd_init. The structs are real
 * because the program reads fields back out of them: caps.szProductName is printed, and every
 * lpWave field is written before AWriteAudioData is called.
 */
const AUDIO = `
#ifndef _PRISM_AUDIO_H
#define _PRISM_AUDIO_H

#define AUDIO_ERROR_NONE       0
#define AUDIO_ERROR_INVALHANDLE 1
#define AUDIO_ERROR_NOMEMORY    2
#define AUDIO_ERROR_NODEVICE    3

#define AUDIO_FORMAT_8BITS  0x0001
#define AUDIO_FORMAT_16BITS 0x0002
#define AUDIO_FORMAT_MONO   0x0010
#define AUDIO_FORMAT_STEREO 0x0020
#define AUDIO_FORMAT_LOOP   0x0100

#define AUDIO_DEVICE_NONE   0x0000
#define AUDIO_DEVICE_MAPPER 0xFFFF

typedef unsigned int HAC;
typedef unsigned int UINT;
typedef unsigned long DWORD;
typedef unsigned short WORD;
typedef char *LPSTR;

typedef struct AUDIOCAPS {
   unsigned short wProductId;
   char  szProductName[80];
   unsigned long dwFormats;
   unsigned long dwMinRate;
   unsigned long dwMaxRate;
   unsigned long dwFlags;
} AUDIOCAPS, *LPAUDIOCAPS;

typedef struct AUDIOINFO {
   unsigned short nDeviceId;
   unsigned short wFormat;
   unsigned int   nSampleRate;
} AUDIOINFO, *LPAUDIOINFO;

typedef struct AUDIOWAVE {
   unsigned short wFormat;
   unsigned int   nSampleRate;
   unsigned long  dwLength;
   unsigned long  dwLoopStart;
   unsigned long  dwLoopEnd;
   unsigned long  dwHandle;
   char          *lpData;
} AUDIOWAVE, *LPAUDIOWAVE;

unsigned int AInitialize(void);
unsigned int AGetAudioNumDevs(void);
unsigned int AGetAudioDevCaps(unsigned int nDeviceId, LPAUDIOCAPS lpCaps);
unsigned int AOpenAudio(LPAUDIOINFO lpInfo);
unsigned int ACloseAudio(void);
unsigned int AUpdateAudio(void);
unsigned int AOpenVoices(unsigned int nVoices);
unsigned int ACloseVoices(void);
unsigned int ACreateAudioVoice(HAC *lphVoice);
unsigned int ADestroyAudioVoice(HAC hVoice);
unsigned int APlayVoice(HAC hVoice, LPAUDIOWAVE lpWave);
unsigned int AStopVoice(HAC hVoice);
unsigned int ASetVoiceFrequency(HAC hVoice, unsigned int nFrequency);
unsigned int ASetVoiceVolume(HAC hVoice, unsigned int nVolume);
unsigned int ASetVoicePanning(HAC hVoice, unsigned int nPanning);
unsigned int AGetVoicePosition(HAC hVoice, unsigned long *lpdwPosition);
unsigned int ACreateAudioData(LPAUDIOWAVE lpWave);
unsigned int ADestroyAudioData(LPAUDIOWAVE lpWave);
unsigned int AWriteAudioData(LPAUDIOWAVE lpWave, unsigned long dwOffset, unsigned int nCount);
#endif
`;

export const DJGPP_HEADERS = {
  'go32.h': GO32,
  'sys/farptr.h': FARPTR,
  'sys/movedata.h': GO32,
  'dpmi.h': '#ifndef _PRISM_DPMI_H\n#define _PRISM_DPMI_H\n#include <go32.h>\n#endif\n',
  'dos.h': DOSH,
  'io.h': IOH,
  'allegro.h': ALLEGRO,
  'audio.h': AUDIO,
};
