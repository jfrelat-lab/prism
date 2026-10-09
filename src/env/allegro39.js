// allegro39.js — what Allegro 3.9 changed for a program, next to the Allegro 3.0 of src/env/allegro.js.
//
// MAME 0.34 links Allegro 3.0; MAME 0.37b5 links a 3.9 work-in-progress, and between the two the
// library RENUMBERED ITS KEYS. In 3.0 a KEY_* constant is the PC's scan code (KEY_ESC is 1, KEY_A is
// 30), so `key[]` is indexed the way the keyboard controller counts. In 3.9 the constants are an
// enumeration of the library's own -- letters first, then digits, the keypad, the function keys --
// and the keypad and the arrows, which share scan codes, became different keys.
//
// They are two versions of one library, so they are two environments (`allegro` and `allegro39`)
// with two allegro.h, and a build names the one its program was written for.
//
// WHERE THE NUMBERS COME FROM. No Allegro 3.9 header is on this machine; the nearest published one
// is Allegro 4.4's include/allegro/keyboard.h (github.com/liballeg/allegro5, branch 4.4), and the
// table below was compared with it name by name: the first 102 keys, KEY_A = 1 to KEY_KANJI = 102,
// are equal. After them 4.4 has twelve keys this table does not (EQUALS_PAD, BACKQUOTE, SEMICOLON,
// COMMAND, UNKNOWN1-8), so its modifiers start at 115 where these start at 103. That those twelve
// came after 3.9 is INFERRED -- MAME 0.37b5 names none of them -- not read. Nothing a program can
// observe depends on it: it names keys, never numbers, and the only array it indexes is the one this
// file fills by the same names. src/msdos/input.c lists its keys in this very order.

/*
 * [name, code]: the key's name, in Allegro 3.9's order (its number is its position, from 1), and
 * the SOFTWARE scan code the host reports for it (src/env/scancodes.js), or 0 for a key the host
 * cannot tell apart. That last case is the keypad: scan-code set 1 gives Numpad 4 and Left the same
 * number, the page keeps that convention, and so the arrows answer and the keypad never does.
 */
export const KEYS39 = [
  ['A', 30], ['B', 48], ['C', 46], ['D', 32], ['E', 18], ['F', 33], ['G', 34], ['H', 35], ['I', 23], ['J', 36],
  ['K', 37], ['L', 38], ['M', 50], ['N', 49], ['O', 24], ['P', 25], ['Q', 16], ['R', 19], ['S', 31], ['T', 20],
  ['U', 22], ['V', 47], ['W', 17], ['X', 45], ['Y', 21], ['Z', 44],
  ['0', 11], ['1', 2], ['2', 3], ['3', 4], ['4', 5], ['5', 6], ['6', 7], ['7', 8], ['8', 9], ['9', 10],
  ['0_PAD', 0], ['1_PAD', 0], ['2_PAD', 0], ['3_PAD', 0], ['4_PAD', 0], ['5_PAD', 0], ['6_PAD', 0], ['7_PAD', 0], ['8_PAD', 0], ['9_PAD', 0],
  ['F1', 59], ['F2', 60], ['F3', 61], ['F4', 62], ['F5', 63], ['F6', 64], ['F7', 65], ['F8', 66], ['F9', 67], ['F10', 68], ['F11', 87], ['F12', 88],
  ['ESC', 1], ['TILDE', 41], ['MINUS', 12], ['EQUALS', 13], ['BACKSPACE', 14], ['TAB', 15], ['OPENBRACE', 26], ['CLOSEBRACE', 27],
  ['ENTER', 28], ['COLON', 39], ['QUOTE', 40], ['BACKSLASH', 43], ['BACKSLASH2', 86], ['COMMA', 51], ['STOP', 52], ['SLASH', 53], ['SPACE', 57],
  ['INSERT', 82], ['DEL', 83], ['HOME', 71], ['END', 79], ['PGUP', 73], ['PGDN', 81], ['LEFT', 75], ['RIGHT', 77], ['UP', 72], ['DOWN', 80],
  ['SLASH_PAD', 0], ['ASTERISK', 55], ['MINUS_PAD', 74], ['PLUS_PAD', 78], ['DEL_PAD', 0], ['ENTER_PAD', 0],
  ['PRTSCR', 0], ['PAUSE', 0],
  // Keys of other keyboards (Brazilian, Japanese) that 4.0's table holds here; unnamed by MAME.
  ['ABNT_C1', 0], ['YEN', 0], ['KANA', 0], ['CONVERT', 0], ['NOCONVERT', 0], ['AT', 0], ['CIRCUMFLEX', 0], ['COLON2', 0], ['KANJI', 0],
  ['LSHIFT', 42], ['RSHIFT', 54], ['LCONTROL', 29], ['RCONTROL', 0], ['ALT', 56], ['ALTGR', 0], ['LWIN', 0], ['RWIN', 0], ['MENU', 0],
  ['SCRLOCK', 70], ['NUMLOCK', 69], ['CAPSLOCK', 58],
];
export const KEY_MAX39 = KEYS39.length + 1;

/** key number (Allegro 3.9) -> the host's scan code, or 0. Index 0 is no key. */
export const KEYMAP39 = [0, ...KEYS39.map(([, code]) => code)];
/** ...and back, for readkey: the host's scan code -> the key number (the first that claims it). */
export const KEY39_OF_SCAN = (() => {
  const m = new Array(128).fill(0);
  KEYS39.forEach(([, code], i) => { if (code && !m[code]) m[code] = i + 1; });
  return m;
})();

/** The part of allegro.h that 3.9 has and 3.0 does not, as C. Included by the header under _PRISM_ALLEGRO39. */
export const ALLEGRO39_H = `
/* ---- Allegro 3.9: see src/env/allegro39.js for where these numbers come from and what is not known. */
/* What Allegro's own DJGPP header includes (allegro/platform/aldjgpp.h, read in the 4.4 tree): a
   program gets these through <allegro.h> and src/msdos/blit.c uses __dpmi_regs on that strength. */
#include <pc.h>
#include <dir.h>
#include <dpmi.h>
#include <go32.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/farptr.h>
${KEYS39.map(([name], i) => `#define KEY_${name} ${i + 1}`).join('\n')}
#define KEY_MODIFIERS KEY_LSHIFT
#define KEY_MAX ${KEY_MAX39}
#define GFX_VESA3 6

/*
 * The driver lists. In the library these are tables the LINKER uses to leave out the drivers a
 * program does not name: BEGIN_GFX_DRIVER_LIST opens an array, each GFX_DRIVER_* is a row, END
 * closes it. Here one shim is every driver, so the rows are just the numbers -- but the arrays are
 * real, so the program's own text compiles as it stands.
 */
#define BEGIN_GFX_DRIVER_LIST    const int _prism_gfx_driver_list[] = {
#define END_GFX_DRIVER_LIST      0 };
#define GFX_DRIVER_VGA           GFX_VGA,
#define GFX_DRIVER_MODEX         GFX_MODEX,
#define GFX_DRIVER_VESA1         GFX_VESA1,
#define GFX_DRIVER_VESA2B        GFX_VESA2B,
#define GFX_DRIVER_VESA2L        GFX_VESA2L,
#define GFX_DRIVER_VESA3         GFX_VESA3,
#define BEGIN_COLOR_DEPTH_LIST   const int _prism_color_depth_list[] = {
#define END_COLOR_DEPTH_LIST     0 };
#define COLOR_DEPTH_8            8,
#define COLOR_DEPTH_15           15,
#define COLOR_DEPTH_16           16,
#define COLOR_DEPTH_24           24,
#define COLOR_DEPTH_32           32,

/* The joysticks 3.9 knows by type. None is attached here: install_joystick fails for each. */
#define JOY_TYPE_AUTODETECT -1
#define JOY_TYPE_STANDARD 1
#define JOY_TYPE_2PADS 2
#define JOY_TYPE_4BUTTON 3
#define JOY_TYPE_6BUTTON 4
#define JOY_TYPE_8BUTTON 5
#define JOY_TYPE_FSPRO 6
#define JOY_TYPE_WINGEX 7
#define JOY_TYPE_SIDEWINDER 8
#define JOY_TYPE_GAMEPAD_PRO 9
#define JOY_TYPE_GRIP 10
#define JOY_TYPE_GRIP4 11
#define JOY_TYPE_SNESPAD_LPT1 12
#define JOY_TYPE_SNESPAD_LPT2 13
#define JOY_TYPE_SNESPAD_LPT3 14
#define JOY_TYPE_PSXPAD_LPT1 15
#define JOY_TYPE_PSXPAD_LPT2 16
#define JOY_TYPE_PSXPAD_LPT3 17
#define JOY_TYPE_N64PAD_LPT1 18
#define JOY_TYPE_N64PAD_LPT2 19
#define JOY_TYPE_N64PAD_LPT3 20
#define JOY_TYPE_WINGWARRIOR 21
#define JOY_TYPE_IFSEGA_ISA 22
#define JOY_TYPE_IFSEGA_PCI 23

/* A key as Unicode: the character, and through the pointer the key's number. */
int ureadkey(int *scancode);

/*
 * The driver in use, which a program reads to NAME it in a log. Only the fields MAME prints are
 * here; the library's structs go on into tables of functions a program has no business calling.
 */
typedef struct GFX_DRIVER { int id; char *name; char *desc; char *ascii_name; } GFX_DRIVER;
typedef struct JOYSTICK_DRIVER { int id; char *name; char *desc; char *ascii_name; } JOYSTICK_DRIVER;
extern GFX_DRIVER *gfx_driver;
extern JOYSTICK_DRIVER *joystick_driver;
/* What the library found out about the processor. Neither is claimed: see ALLEGRO39_VARS. */
extern int cpu_cpuid, cpu_mmx;
/* The whole surface the card scrolls over; here the screen is all of it. */
#define VIRTUAL_W (screen ? screen->w : 0)
#define VIRTUAL_H (screen ? screen->h : 0)
`;

/**
 * The data Allegro 3.9 adds to the 3.0 unit (ALLEGRO_VARS in src/env/allegro.js).
 *
 * cpu_cpuid and cpu_mmx are ZERO, and that is a statement about this machine, not a shortcut: a
 * program asks them before it runs CPUID, RDTSC or MMX instructions of its own, written in assembly.
 * There is no such processor underneath, so the honest answer sends it down its portable path --
 * MAME then times itself with uclock() and blits in C.
 *
 * _dpmi_reg is the library's scratch register block. It is not in allegro.h; src/msdos/blit.c
 * declares it itself and borrows it, so it has to exist with external linkage.
 */
export const ALLEGRO39_VARS = `
static GFX_DRIVER _prism_gfx_driver = { 0, "PRISM", "PRISM shared framebuffer", "PRISM" };
static JOYSTICK_DRIVER _prism_joystick_driver = { 0, "None", "No joystick", "None" };
GFX_DRIVER *gfx_driver = &_prism_gfx_driver;
JOYSTICK_DRIVER *joystick_driver = &_prism_joystick_driver;
int cpu_cpuid = 0, cpu_mmx = 0;
__dpmi_regs _dpmi_reg;
`;
