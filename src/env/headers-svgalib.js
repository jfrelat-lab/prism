// headers-svgalib.js — svgalib's three headers, for Quake's Linux console driver.
//
// `vid_svgalib.c` includes <vga.h>, <vgakeyboard.h> and <vgamouse.h>, and it memcpy's a whole
// `vga_modeinfo` out of what vga_getmodeinfo returns -- so the STRUCT LAYOUT is part of the ABI here
// in exactly the way src/env/x11.js's event offsets are. It is svgalib 1.4's, written out in full
// even though the driver reads five of the seventeen fields, because the size decides how much is
// copied and a short struct would copy garbage over whatever followed it.
//
// It also includes <sys/vt.h> and <asm/io.h>. Both are Linux kernel headers and the driver uses
// neither for anything it reaches here -- the VT_ ioctls are for switching virtual consoles and
// asm/io.h is for the port I/O svgalib does on its own behalf -- so they are declared empty rather
// than stubbed silently, which is the difference between a decision and an accident.

const VGA_H = `
#ifndef _PRISM_VGA_H
#define _PRISM_VGA_H

/*
 * The mode numbers, as svgalib numbers them. Only G320x200x256 is offered by PRISM's shim (see
 * src/env/svgalib.js for why), but the names have to exist because the driver mentions several.
 */
#define TEXT             0
#define G320x200x16      1
#define G640x200x16      2
#define G640x350x16      3
#define G640x480x16      4
#define G320x200x256     5
#define G320x240x256     6
#define G320x400x256     7
#define G360x480x256     8
#define G640x480x2       9
#define G640x480x256     10
#define G800x600x256     11
#define G1024x768x256    12
#define GLASTMODE        12

/*
 * svgalib 1.4's vga_modeinfo. Seventeen words on i386, and the driver copies all of them:
 *     Q_memcpy(&modes[i], vga_getmodeinfo(i), sizeof (vga_modeinfo));
 */
typedef struct {
    int width;
    int height;
    int bytesperpixel;          /* 0 means PLANAR, which is what selects VGA_UpdatePlanarScreen */
    int colors;
    int linewidth;              /* scanline width in bytes */
    int maxlogicalwidth;
    int startaddressrange;
    int maxpixels;
    int haveblit;
    int flags;
    int chiptype;
    int memory;                 /* video memory in KB */
    int linewidth_unit;
    char *linear_aperture;
    int aperture_size;
    void (*set_aperture_page)(int page);
    void *extensions;
} vga_modeinfo;

int vga_init(void);
int vga_lastmodenumber(void);
int vga_hasmode(int mode);
vga_modeinfo *vga_getmodeinfo(int mode);
int vga_getmodenumber(char *name);
int vga_getcolors(void);
int vga_setmode(int mode);
unsigned char *vga_getgraphmem(void);
int vga_setpage(int page);
int vga_oktowrite(void);
void vga_waitretrace(void);
int vga_runinbackground(int flag);
int vga_setlinearaddressing(void);
int vga_setpalvec(int start, int num, int *pal);
int vga_getmousetype(void);
#endif
`;

const VGAKEYBOARD_H = `
#ifndef _PRISM_VGAKEYBOARD_H
#define _PRISM_VGAKEYBOARD_H
/*
 * The raw keyboard. svgalib puts the console in K_MEDIUMRAW and hands the client a SCAN CODE, which
 * is why this is the cheapest input surface in the corpus: it is the currency PRISM already carries.
 */
#define KEY_EVENTRELEASE 0
#define KEY_EVENTPRESS   1
typedef void (*__keyboard_handler)(int scancode, int state);
int keyboard_init(void);
void keyboard_close(void);
void keyboard_seteventhandler(__keyboard_handler handler);
int keyboard_update(void);
/* svgalib's translation flags; Quake II's rw_in_svgalib.c asks for DONT_CATCH_CTRLC alone. */
#define TRANSLATE_CURSORKEYS 1
#define TRANSLATE_DIAGONAL 2
#define TRANSLATE_KEYPADENTER 4
#define DONT_CATCH_CTRLC 8
int keyboard_translatekeys(int mask);
#endif
`;

const VGAMOUSE_H = `
#ifndef _PRISM_VGAMOUSE_H
#define _PRISM_VGAMOUSE_H
/* Relative motion to a handler -- the same shape as INT 33h's motion counters. */
#define MOUSE_LEFTBUTTON   4
#define MOUSE_MIDDLEBUTTON 2
#define MOUSE_RIGHTBUTTON  1

/*
 * The mouse TYPES, in svgalib's own order, because vid_svgalib.c builds a table out of them:
 *
 *     struct { char *name; int num; } mice[] = { stringify(MOUSE_MICROSOFT), ... };
 *
 * so each has to be an integer constant at file scope or the initialiser is not constant -- which is
 * exactly how their absence showed up.
 */
#define MOUSE_MICROSOFT     0
#define MOUSE_MOUSESYSTEMS  1
#define MOUSE_MMSERIES      2
#define MOUSE_LOGITECH      3
#define MOUSE_BUSMOUSE      4
#define MOUSE_PS2           5
#define MOUSE_MOUSEMAN      6
#define MOUSE_NONE          7
#define MOUSE_INTELLIMOUSE  8
#define MOUSE_IMPS2         9
/* The default sample rate vid_svgalib.c uses when neither MOUSERATE nor -mrate says otherwise. */
#define MOUSE_DEFAULTSAMPLERATE 100
typedef void (*__mouse_handler)(int button, int dx, int dy);
int mouse_init(char *dev, int type, int samplerate);
void mouse_close(void);
void mouse_seteventhandler(__mouse_handler handler);
int mouse_update(void);
#endif
`;

/*
 * Two Linux kernel headers the driver includes and does not need here. Declared empty ON PURPOSE:
 * sys/vt.h is the virtual-console ioctls (switching away from the game's console, which cannot
 * happen in a page) and asm/io.h is port I/O that svgalib itself would do, not the game.
 */
const EMPTY = (why) => `/* ${why} */\n`;

/*
 * <asm/io.h>, and it is NOT empty -- which was my first answer and it was wrong.
 *
 * I wrote that port I/O here was svgalib's own business. The GAME does it: D_BeginDirectRect and
 * D_EndDirectRect program the VGA sequencer and graphics controller by hand -- `outb(0x02, 0x3C4)`
 * and three more -- to select a plane before writing the little status-bar rectangles. Declaring the
 * header empty made both functions unemittable ("call to undeclared function 'outb'") and the game
 * threw the first time it drew one.
 *
 * Linux's argument order, value first, which is the opposite of the DOS convention PRISM's port
 * machine uses -- src/env/svgalib.js swaps them. The calls sit inside `if (VGA_planar)` and so are
 * never reached in the linear mode this shim offers, but a function has to compile before its dead
 * branches can go untaken.
 */
const ASM_IO_H = `
#ifndef _PRISM_ASM_IO_H
#define _PRISM_ASM_IO_H
void outb(unsigned char value, unsigned short port);
void outw(unsigned short value, unsigned short port);
unsigned char inb(unsigned short port);
unsigned short inw(unsigned short port);
#endif
`;

export const SVGALIB_HEADERS = {
  'vga.h': VGA_H,
  'vgakeyboard.h': VGAKEYBOARD_H,
  'vgamouse.h': VGAMOUSE_H,
  'asm/io.h': ASM_IO_H,
  'sys/vt.h': EMPTY('the virtual-console ioctls; there is no console to switch away from here'),
};
