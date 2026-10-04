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

/*
 * The go32 half: real-mode interrupt simulation and protected-mode vectors. A _go32_dpmi_seginfo
 * carries a handler both ways -- a selector/offset pair going out, a wrapper coming back -- which is
 * why registering an interrupt takes a struct rather than a function pointer.
 *
 * (No backticks in this comment: these header strings are JS template literals, and the trap this
 * file already warns about has now been sprung three times.)
 */
/*
 * DJGPP spells the first field size for a memory request and size_or_mask for an interrupt
 * wrapper -- one word with two jobs, which its own header expresses as a union. dos_v2.c writes
 * info.size, so that is the name; the alias is here so either spelling compiles.
 */
typedef struct { union { unsigned long size; unsigned long size_or_mask; }; unsigned long pm_offset;
                 unsigned short pm_selector, rm_offset, rm_segment; } _go32_dpmi_seginfo;
typedef struct { unsigned long edi, esi, ebp, res, ebx, edx, ecx, eax;
                 unsigned short flags, es, ds, fs, gs, ip, cs, sp, ss; } __go32_dword_regs;
typedef union { __go32_dword_regs d; } _go32_dpmi_registers;

unsigned long _go32_rmcb_stack_size;
unsigned long _go32_interrupt_stack_size;

int _go32_dpmi_simulate_int(int vector, _go32_dpmi_registers *regs);
int _go32_dpmi_set_protected_mode_interrupt_vector(int vector, _go32_dpmi_seginfo *info);
int _go32_dpmi_get_protected_mode_interrupt_vector(int vector, _go32_dpmi_seginfo *info);
int _go32_dpmi_allocate_iret_wrapper(_go32_dpmi_seginfo *info);
int _go32_dpmi_free_iret_wrapper(_go32_dpmi_seginfo *info);
int _go32_dpmi_allocate_dos_memory(_go32_dpmi_seginfo *info);
int _go32_dpmi_free_dos_memory(_go32_dpmi_seginfo *info);
unsigned long _go32_dpmi_remaining_physical_memory(void);
unsigned long _go32_dpmi_remaining_virtual_memory(void);
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
#define GFX_VESA2B     4
#define GFX_VESA2L     5

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
extern char allegro_error[80];
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

/*
 * ---- What MAME 0.34's src/msdos asks of Allegro 3.0 beyond the above: colour depths, the linear
 * VESA driver, configuration files, the new joystick tables, the mouse, the keyboard LEDs.
 *
 * The driver lists are link-time tables in the real library (which drivers get linked in); here
 * every driver is one shim, so a list declares nothing.
 */
#define DECLARE_GFX_DRIVER_LIST(list)   extern int _prism_allegro_gfx_driver_list;
#define DECLARE_COLOR_DEPTH_LIST(list)  extern int _prism_allegro_color_depth_list;
#define DECLARE_DIGI_DRIVER_LIST(list)  extern int _prism_allegro_digi_driver_list;
#define DECLARE_MIDI_DRIVER_LIST(list)  extern int _prism_allegro_midi_driver_list;

void set_color_depth(int depth);
int  makecol(int r, int g, int b);
int  getr(int c);
int  getg(int c);
int  getb(int c);
BITMAP *create_sub_bitmap(BITMAP *parent, int x, int y, int width, int height);

#define KEY_LCONTROL 29
#define KEY_PRTSCR   84
#define KEY_F12      88
#define KEY_RCONTROL 120
#define KEY_ALTGR    121
#define KB_SCROLOCK_FLAG 0x0100
#define KB_NUMLOCK_FLAG  0x0200
#define KB_CAPSLOCK_FLAG 0x0400
void set_leds(int leds);

void set_config_file(const char *filename);
const char *get_config_string(const char *section, const char *name, const char *def);
int   get_config_int(const char *section, const char *name, int def);
float get_config_float(const char *section, const char *name, float def);
void  set_config_string(const char *section, const char *name, const char *val);
void  set_config_int(const char *section, const char *name, int val);
void  set_config_float(const char *section, const char *name, float val);

#define JOY_TYPE_NONE      0
#define JOYFLAG_CALIBRATE  8
typedef struct JOYSTICK_AXIS_INFO { int pos; int d1, d2; char *name; } JOYSTICK_AXIS_INFO;
typedef struct JOYSTICK_STICK_INFO { int flags; int num_axis; JOYSTICK_AXIS_INFO axis[3]; char *name; } JOYSTICK_STICK_INFO;
typedef struct JOYSTICK_BUTTON_INFO { int b; char *name; } JOYSTICK_BUTTON_INFO;
typedef struct JOYSTICK_INFO {
   int flags;
   int num_sticks;
   int num_buttons;
   JOYSTICK_STICK_INFO stick[4];
   JOYSTICK_BUTTON_INFO button[16];
} JOYSTICK_INFO;
extern JOYSTICK_INFO joy[4];
extern int num_joysticks;
extern int joy_type;
int  install_joystick(int type);
void remove_joystick(void);
int  load_joystick_data(const char *filename);
int  save_joystick_data(const char *filename);
int  calibrate_joystick(int n);
char *calibrate_joystick_name(int n);

extern volatile int mouse_x, mouse_y, mouse_b;
int  install_mouse(void);
void remove_mouse(void);
void get_mouse_mickeys(int *mickeyx, int *mickeyy);
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

/* SEAL 1.0x's later calls, which MAME 0.34's sound.c uses: a voice primed with a wave and started
   separately, a status query, an update that says how many frames are due, the mixer's volume. */
typedef int BOOL;
typedef BOOL *LPBOOL;
typedef long LONG;
typedef LONG *LPLONG;
#define AUDIO_MIXER_MASTER_VOLUME 0x0001
unsigned int APrimeVoice(HAC hVoice, LPAUDIOWAVE lpWave);
unsigned int AStartVoice(HAC hVoice);
unsigned int AGetVoiceStatus(HAC hVoice, LPBOOL lpnStatus);
unsigned int AUpdateAudioEx(unsigned int nFrames);
unsigned int ASetAudioMixerValue(unsigned int nChannel, unsigned int nValue);
#endif
`;


/*
 * DJGPP's DPMI and go32 interfaces, as Quake's DOS platform uses them.
 *
 * The list is measured, not imagined: twenty-four symbols across `sys_dos.c vid_dos.c vid_vga.c
 * vid_ext.c in_dos.c snd_dos.c dos_v2.c`, and nothing else. `dos_v2.c` is the important one -- it
 * implements ALL of dosisms.h (dos_int86, dos_registerintr, dos_getmemory, real2ptr...) on top of
 * these, so PRISM supplies the floor and Quake's own code supplies the rest.
 *
 * `__dpmi_regs` is a union of three views of one 50-byte block, the same shape as Watcom's
 * `union REGS` and for the same reason: a program sets `x.ax` and reads `h.bh` on the same variable.
 * The layout here is DJGPP's, which orders the 32-bit view edi..eax and appends the segment and
 * flag registers -- a real-mode call frame, not a register file.
 */
const DPMI_H = `
#ifndef _PRISM_DPMI_H
#define _PRISM_DPMI_H

/* Locking memory so a hardware interrupt can touch it without faulting on a page that is out.
   Nothing here pages, so the answer is always success -- but the call has to EXIST, because
   interrpt.c locks its keyboard state before it hooks IRQ 1, and a program whose lock call is
   missing is unemittable at the CALLER rather than at the name. */
int _go32_dpmi_lock_data(void *addr, unsigned long size);
int _go32_dpmi_lock_code(void *addr, unsigned long size);

typedef struct { unsigned long edi, esi, ebp, res, ebx, edx, ecx, eax;
                 unsigned short flags, es, ds, fs, gs, ip, cs, sp, ss; } __dpmi_dword_regs;
typedef struct { unsigned short di, di_hi, si, si_hi, bp, bp_hi, res, res_hi,
                                bx, bx_hi, dx, dx_hi, cx, cx_hi, ax, ax_hi,
                                flags, es, ds, fs, gs, ip, cs, sp, ss; } __dpmi_word_regs;
typedef struct { unsigned char bl, bh, blh1, blh2, dl, dh, dlh1, dlh2,
                               cl, ch, clh1, clh2, al, ah, alh1, alh2; } __dpmi_byte_regs;
typedef union { __dpmi_dword_regs d; __dpmi_word_regs x; __dpmi_byte_regs h; } __dpmi_regs;

typedef struct { unsigned long handle, size, address; } __dpmi_meminfo;
typedef struct { unsigned long largest_available_free_block_in_bytes;
                 unsigned long maximum_unlocked_page_allocation_in_pages;
                 unsigned long maximum_locked_page_allocation_in_pages;
                 unsigned long linear_address_space_size_in_pages;
                 unsigned long total_number_of_unlocked_pages;
                 unsigned long total_number_of_free_pages;
                 unsigned long total_number_of_physical_pages;
                 unsigned long free_linear_address_space_in_pages;
                 unsigned long size_of_paging_file_partition_in_pages;
                 unsigned long reserved[3]; } __dpmi_free_mem_info;

/*
 * TENTATIVE definitions, not externs, for the same reason errno.h gives: these are objects the DJGPP
 * runtime provides, no PRISM translation unit defines them, and C89's common-symbol rule merges
 * tentative definitions across units by name. An extern with no definition anywhere reaches the
 * emitter as an undeclared identifier instead.
 *
 * __djgpp_conventional_base is 0 and __djgpp_selector_limit is the whole image, which is the truth
 * in a flat model with the low megabyte inside it -- not a convenient answer.
 */
int __dpmi_error;
unsigned long __djgpp_base_address;
unsigned long __djgpp_selector_limit;
unsigned long __djgpp_conventional_base;

int __dpmi_int(int vector, __dpmi_regs *regs);
int __dpmi_lock_linear_region(__dpmi_meminfo *info);
int __dpmi_unlock_linear_region(__dpmi_meminfo *info);
int __dpmi_physical_address_mapping(__dpmi_meminfo *info);
int __dpmi_get_free_memory_information(__dpmi_free_mem_info *info);
#include <go32.h>
#endif
`;

const NEARPTR_H = `
#ifndef _PRISM_NEARPTR_H
#define _PRISM_NEARPTR_H
#include <dpmi.h>
/*
 * Near pointers. On real DJGPP this asks the extender to drop segment limits so a flat pointer can
 * reach conventional memory; PRISM's whole image already IS flat, with the low megabyte in it, so
 * the answer is yes and the base is zero -- which is the truth here rather than a convenience.
 */
int __djgpp_nearptr_enable(void);
void __djgpp_nearptr_disable(void);
#endif
`;

const DIR_H = `
#ifndef _PRISM_DIR_H
#define _PRISM_DIR_H
#include <unistd.h>
#define MAXPATH 260
int findfirst(const char *path, void *ff, int attrib);
int findnext(void *ff);
#endif
`;

export const DJGPP_HEADERS = {
  'go32.h': GO32,
  'sys/farptr.h': FARPTR,
  'sys/movedata.h': GO32,
  'dpmi.h': DPMI_H,
  'sys/nearptr.h': NEARPTR_H,
  'dir.h': DIR_H,
  'dos.h': DOSH,
  'io.h': IOH,
  'allegro.h': ALLEGRO,
  'audio.h': AUDIO,
};
