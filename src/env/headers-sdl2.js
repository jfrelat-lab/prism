// headers-sdl2.js — the SDL2 a program of the OpenDUNE/OpenTyrian family includes.
//
// Written for OpenTyrian, and every declaration here is named by its source: 79 distinct SDL
// functions across 52 units, gathered before a line of this file existed. Nothing is anticipated.
//
// The struct layouts are SDL's REAL ones rather than something convenient, and that is not
// politeness. A program reads `surface->pixels`, `surface->pitch` and `format->BytesPerPixel`
// itself, so those offsets are a contract between this header and whatever fills the struct -- the
// same contract `union REGS` is between headers-watcom.js and env/watcom.js.
//
// This file exists to be compiled against, not to work: with it, PRISM's undefined-symbol report
// says exactly which of the 79 the program actually CALLS, which is a smaller number than grep
// finds and the right size for an implementation to aim at.

const SDL_STDINC = `
#ifndef _PRISM_SDL_STDINC_H
#define _PRISM_SDL_STDINC_H
#include <stddef.h>
#include <stdarg.h>
/*
 * The real SDL_stdinc.h pulls in <stdint.h>, and programs rely on it: OpenTyrian's file.h uses
 * uint8_t while including only SDL_endian.h. Faithful rather than accommodating.
 */
#include <stdint.h>
typedef unsigned char  Uint8;
typedef signed char    Sint8;
typedef unsigned short Uint16;
typedef signed short   Sint16;
typedef unsigned int   Uint32;
typedef signed int     Sint32;
typedef unsigned long long Uint64;
typedef signed long long   Sint64;
typedef enum { SDL_FALSE = 0, SDL_TRUE = 1 } SDL_bool;
#define SDL_COMPILE_TIME_ASSERT(name, x) typedef int SDL_compile_time_assert_ ## name[(x) * 2 - 1]
void SDL_free(void *mem);
void *SDL_memset(void *dst, int c, size_t len);
size_t SDL_strlen(const char *str);
size_t SDL_strlcpy(char *dst, const char *src, size_t maxlen);
/* SDL's own allocator and string functions are the C library's here, as on Linux. */
#include <stdlib.h>
#include <string.h>
#define SDL_malloc malloc
#define SDL_calloc calloc
#define SDL_realloc realloc
#define SDL_strchr strchr
#define SDL_strcmp strcmp
#define SDL_memcpy memcpy
#define SDL_stack_alloc(type, count) (type *)SDL_malloc(sizeof(type) * (count))
#define SDL_stack_free(data) SDL_free(data)
/* A release build: SDL_ASSERT_LEVEL 1, at which SDL_assert evaluates nothing. */
#define SDL_assert(condition) ((void)sizeof(condition))
#define SDL_assert_release(condition) ((void)sizeof(condition))
int SDL_vsnprintf(char *text, size_t maxlen, const char *fmt, va_list ap);
#endif
`;

/* Byte order. The target is i386, so this is settled, and the swaps are the ones OpenTyrian calls. */
const SDL_ENDIAN = `
#ifndef _PRISM_SDL_ENDIAN_H
#define _PRISM_SDL_ENDIAN_H
#include <SDL_stdinc.h>
#define SDL_LIL_ENDIAN 1234
#define SDL_BIG_ENDIAN 4321
#define SDL_BYTEORDER  SDL_LIL_ENDIAN
#define SDL_Swap16(x) ((Uint16)((((Uint16)(x)) << 8) | (((Uint16)(x)) >> 8)))
#define SDL_SwapLE16(x) (x)
#define SDL_SwapLE32(x) (x)
#define SDL_SwapBE16(x) ((Uint16)((((Uint16)(x)) << 8) | (((Uint16)(x)) >> 8)))
#define SDL_SwapBE32(x) ((Uint32)((((Uint32)(x)) << 24) | ((((Uint32)(x)) << 8) & 0x00FF0000) | \\
                                  ((((Uint32)(x)) >> 8) & 0x0000FF00) | (((Uint32)(x)) >> 24)))
#endif
`;

/*
 * Scancodes, in SDL's own order -- which is the USB HID usage table, not an invention. The values
 * matter because OpenTyrian writes key bindings to its config file BY NAME and reads them back
 * through SDL_GetScancodeFromName, so a name and a number have to agree with each other.
 */
const SDL_SCANCODE = `
#ifndef _PRISM_SDL_SCANCODE_H
#define _PRISM_SDL_SCANCODE_H
typedef enum {
    SDL_SCANCODE_UNKNOWN = 0,
    SDL_SCANCODE_A = 4, SDL_SCANCODE_B, SDL_SCANCODE_C, SDL_SCANCODE_D, SDL_SCANCODE_E,
    SDL_SCANCODE_F, SDL_SCANCODE_G, SDL_SCANCODE_H, SDL_SCANCODE_I, SDL_SCANCODE_J,
    SDL_SCANCODE_K, SDL_SCANCODE_L, SDL_SCANCODE_M, SDL_SCANCODE_N, SDL_SCANCODE_O,
    SDL_SCANCODE_P, SDL_SCANCODE_Q, SDL_SCANCODE_R, SDL_SCANCODE_S, SDL_SCANCODE_T,
    SDL_SCANCODE_U, SDL_SCANCODE_V, SDL_SCANCODE_W, SDL_SCANCODE_X, SDL_SCANCODE_Y,
    SDL_SCANCODE_Z,
    SDL_SCANCODE_1 = 30, SDL_SCANCODE_2, SDL_SCANCODE_3, SDL_SCANCODE_4, SDL_SCANCODE_5,
    SDL_SCANCODE_6, SDL_SCANCODE_7, SDL_SCANCODE_8, SDL_SCANCODE_9, SDL_SCANCODE_0,
    SDL_SCANCODE_RETURN = 40, SDL_SCANCODE_ESCAPE, SDL_SCANCODE_BACKSPACE, SDL_SCANCODE_TAB,
    SDL_SCANCODE_SPACE, SDL_SCANCODE_MINUS, SDL_SCANCODE_EQUALS, SDL_SCANCODE_LEFTBRACKET,
    SDL_SCANCODE_RIGHTBRACKET, SDL_SCANCODE_BACKSLASH, SDL_SCANCODE_NONUSHASH,
    SDL_SCANCODE_SEMICOLON, SDL_SCANCODE_APOSTROPHE, SDL_SCANCODE_GRAVE, SDL_SCANCODE_COMMA,
    SDL_SCANCODE_PERIOD, SDL_SCANCODE_SLASH, SDL_SCANCODE_CAPSLOCK,
    SDL_SCANCODE_F1 = 58, SDL_SCANCODE_F2, SDL_SCANCODE_F3, SDL_SCANCODE_F4, SDL_SCANCODE_F5,
    SDL_SCANCODE_F6, SDL_SCANCODE_F7, SDL_SCANCODE_F8, SDL_SCANCODE_F9, SDL_SCANCODE_F10,
    SDL_SCANCODE_F11, SDL_SCANCODE_F12,
    SDL_SCANCODE_PRINTSCREEN = 70, SDL_SCANCODE_SCROLLLOCK, SDL_SCANCODE_PAUSE,
    SDL_SCANCODE_INSERT, SDL_SCANCODE_HOME, SDL_SCANCODE_PAGEUP, SDL_SCANCODE_DELETE,
    SDL_SCANCODE_END, SDL_SCANCODE_PAGEDOWN, SDL_SCANCODE_RIGHT, SDL_SCANCODE_LEFT,
    SDL_SCANCODE_DOWN, SDL_SCANCODE_UP,
    SDL_SCANCODE_NUMLOCKCLEAR = 83, SDL_SCANCODE_KP_DIVIDE, SDL_SCANCODE_KP_MULTIPLY,
    SDL_SCANCODE_KP_MINUS, SDL_SCANCODE_KP_PLUS, SDL_SCANCODE_KP_ENTER,
    SDL_SCANCODE_KP_1 = 89, SDL_SCANCODE_KP_2, SDL_SCANCODE_KP_3, SDL_SCANCODE_KP_4,
    SDL_SCANCODE_KP_5, SDL_SCANCODE_KP_6, SDL_SCANCODE_KP_7, SDL_SCANCODE_KP_8,
    SDL_SCANCODE_KP_9, SDL_SCANCODE_KP_0, SDL_SCANCODE_KP_PERIOD,
    SDL_SCANCODE_APPLICATION = 101,
    SDL_SCANCODE_MUTE = 127, SDL_SCANCODE_VOLUMEUP, SDL_SCANCODE_VOLUMEDOWN,
    SDL_SCANCODE_CLEAR = 156,
    SDL_SCANCODE_LCTRL = 224, SDL_SCANCODE_LSHIFT, SDL_SCANCODE_LALT, SDL_SCANCODE_LGUI,
    SDL_SCANCODE_RCTRL, SDL_SCANCODE_RSHIFT, SDL_SCANCODE_RALT, SDL_SCANCODE_RGUI,
    SDL_SCANCODE_AUDIOMUTE = 262,
    SDL_NUM_SCANCODES = 512
} SDL_Scancode;
#endif
`;

/*
 * Keycodes. In SDL2 a printable keycode IS its ASCII value -- `SDLK_s` is 's' -- and the rest are a
 * scancode with bit 30 set, which is what SDL_SCANCODE_TO_KEYCODE does. Both spellings are here
 * because both are the real definition, not an approximation of it.
 */
const SDL_KEYCODE = `
#ifndef _PRISM_SDL_KEYCODE_H
#define _PRISM_SDL_KEYCODE_H
#include <SDL_stdinc.h>
#include <SDL_scancode.h>
#define SDLK_SCANCODE_MASK (1 << 30)
#define SDL_SCANCODE_TO_KEYCODE(X) ((X) | SDLK_SCANCODE_MASK)
#define SDLK_UNKNOWN 0
#define SDLK_RETURN '\\r'
#define SDLK_ESCAPE '\\033'
#define SDLK_BACKSPACE '\\b'
#define SDLK_TAB '\\t'
#define SDLK_SPACE ' '
#define SDLK_LEFTBRACKET '['
#define SDLK_DELETE 127
#define SDLK_0 '0'
#define SDLK_1 '1'
#define SDLK_2 '2'
#define SDLK_3 '3'
#define SDLK_4 '4'
#define SDLK_5 '5'
#define SDLK_6 '6'
#define SDLK_7 '7'
#define SDLK_8 '8'
#define SDLK_9 '9'
#define SDLK_MINUS '-'
#define SDLK_EQUALS '='
#define SDLK_PLUS '+'
#define SDLK_F1 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F1)
#define SDLK_F2 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F2)
#define SDLK_F3 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F3)
#define SDLK_F4 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F4)
#define SDLK_F5 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F5)
#define SDLK_F6 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F6)
#define SDLK_F7 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F7)
#define SDLK_F8 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F8)
#define SDLK_F9 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F9)
#define SDLK_F10 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F10)
#define SDLK_F11 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F11)
#define SDLK_F12 SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_F12)
#define SDLK_RIGHT SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_RIGHT)
#define SDLK_LEFT SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_LEFT)
#define SDLK_DOWN SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_DOWN)
#define SDLK_UP SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_UP)
#define SDLK_LCTRL SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_LCTRL)
#define SDLK_LSHIFT SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_LSHIFT)
#define SDLK_LALT SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_LALT)
#define SDLK_RCTRL SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_RCTRL)
#define SDLK_RSHIFT SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_RSHIFT)
#define SDLK_RALT SDL_SCANCODE_TO_KEYCODE(SDL_SCANCODE_RALT)
#define SDLK_RIGHTBRACKET ']'
#define SDLK_a 'a'
#define SDLK_b 'b'
#define SDLK_c 'c'
#define SDLK_d 'd'
#define SDLK_e 'e'
#define SDLK_f 'f'
#define SDLK_g 'g'
#define SDLK_h 'h'
#define SDLK_i 'i'
#define SDLK_j 'j'
#define SDLK_k 'k'
#define SDLK_l 'l'
#define SDLK_m 'm'
#define SDLK_n 'n'
#define SDLK_o 'o'
#define SDLK_p 'p'
#define SDLK_q 'q'
#define SDLK_r 'r'
#define SDLK_s 's'
#define SDLK_t 't'
#define SDLK_u 'u'
#define SDLK_v 'v'
#define SDLK_w 'w'
#define SDLK_x 'x'
#define SDLK_y 'y'
#define SDLK_z 'z'
#define KMOD_NONE   0x0000
#define KMOD_LSHIFT 0x0001
#define KMOD_RSHIFT 0x0002
#define KMOD_LCTRL  0x0040
#define KMOD_RCTRL  0x0080
#define KMOD_LALT   0x0100
#define KMOD_RALT   0x0200
#define KMOD_LGUI   0x0400
#define KMOD_RGUI   0x0800
#define KMOD_CTRL  (KMOD_LCTRL | KMOD_RCTRL)
#define KMOD_SHIFT (KMOD_LSHIFT | KMOD_RSHIFT)
#define KMOD_ALT   (KMOD_LALT | KMOD_RALT)
#define KMOD_GUI   (KMOD_LGUI | KMOD_RGUI)
#endif
`;

const SDL_PIXELS = `
#ifndef _PRISM_SDL_PIXELS_H
#define _PRISM_SDL_PIXELS_H
#include <SDL_stdinc.h>
typedef struct SDL_Color { Uint8 r, g, b, a; } SDL_Color;
typedef struct SDL_Palette { int ncolors; SDL_Color *colors; Uint32 version, refcount; } SDL_Palette;
typedef struct SDL_PixelFormat {
    Uint32 format;
    SDL_Palette *palette;
    Uint8 BitsPerPixel, BytesPerPixel, padding[2];
    Uint32 Rmask, Gmask, Bmask, Amask;
    Uint8 Rloss, Gloss, Bloss, Aloss, Rshift, Gshift, Bshift, Ashift;
    int refcount;
    struct SDL_PixelFormat *next;
} SDL_PixelFormat;
#define SDL_PIXELFORMAT_INDEX8   0x13000801
#define SDL_PIXELFORMAT_RGB565   0x15151002
#define SDL_PIXELFORMAT_RGB888   0x16161804
#define SDL_PIXELFORMAT_ARGB8888 0x16362004
#define SDL_PIXELFORMAT_ABGR8888 0x16762004
#define SDL_PIXELFORMAT_RGB24    0x17101803
/* A format's type is the nibble at bit 24, and 1, 2 and 3 are the indexed ones; the nibble above
   it is 1 for every format that is not a FourCC. */
#define SDL_ISPIXELFORMAT_INDEXED(format) \\
    (((((format) >> 28) & 0x0F) == 1) && ((((format) >> 24) & 0x0F) >= 1) && ((((format) >> 24) & 0x0F) <= 3))
#define SDL_ALPHA_OPAQUE 255
#define SDL_ALPHA_TRANSPARENT 0
SDL_PixelFormat *SDL_AllocFormat(Uint32 pixel_format);
void SDL_FreeFormat(SDL_PixelFormat *format);
Uint32 SDL_MapRGB(const SDL_PixelFormat *format, Uint8 r, Uint8 g, Uint8 b);
const char *SDL_GetPixelFormatName(Uint32 format);
#endif
`;

const SDL_RECT = `
#ifndef _PRISM_SDL_RECT_H
#define _PRISM_SDL_RECT_H
typedef struct SDL_Rect { int x, y, w, h; } SDL_Rect;
#endif
`;

/*
 * SDL_Surface. `pixels`, `pitch`, `w` and `h` are read by the program itself -- OpenTyrian blits by
 * hand into them -- so the offsets here are load-bearing rather than decorative.
 */
const SDL_SURFACE = `
#ifndef _PRISM_SDL_SURFACE_H
#define _PRISM_SDL_SURFACE_H
#include <SDL_stdinc.h>
#include <SDL_pixels.h>
#include <SDL_rect.h>
typedef struct SDL_Surface {
    Uint32 flags;
    SDL_PixelFormat *format;
    int w, h, pitch;
    void *pixels;
    void *userdata;
    int locked;
    void *lock_data;
    SDL_Rect clip_rect;
    struct SDL_BlitMap *map;
    int refcount;
} SDL_Surface;
#define SDL_MUSTLOCK(S) (((S)->flags & 0x00000002) != 0)
typedef enum {
    SDL_BLENDMODE_NONE = 0x00000000, SDL_BLENDMODE_BLEND = 0x00000001,
    SDL_BLENDMODE_ADD = 0x00000002, SDL_BLENDMODE_MOD = 0x00000004
} SDL_BlendMode;
/*
 * A stream of bytes as SDL reads one: SDL_rwops.h's structure, Linux's union, so that a program can
 * make its own (SDL_AllocRW) as Neverball's fs_rwops.c does. The streams SDL itself makes are
 * src/env/sdl2.js's; the functions below call a program's own through its pointers.
 */
#define RW_SEEK_SET 0
#define RW_SEEK_CUR 1
#define RW_SEEK_END 2
#define SDL_RWOPS_UNKNOWN 0U
typedef struct SDL_RWops {
    Sint64 (*size)(struct SDL_RWops *context);
    Sint64 (*seek)(struct SDL_RWops *context, Sint64 offset, int whence);
    size_t (*read)(struct SDL_RWops *context, void *ptr, size_t size, size_t maxnum);
    size_t (*write)(struct SDL_RWops *context, const void *ptr, size_t size, size_t num);
    int (*close)(struct SDL_RWops *context);
    Uint32 type;
    union {
        struct { SDL_bool autoclose; void *fp; } stdio;
        struct { Uint8 *base; Uint8 *here; Uint8 *stop; } mem;
        struct { void *data1; void *data2; } unknown;
    } hidden;
} SDL_RWops;
SDL_RWops *SDL_AllocRW(void);
void SDL_FreeRW(SDL_RWops *area);
Sint64 SDL_RWsize(SDL_RWops *context);
Sint64 SDL_RWseek(SDL_RWops *context, Sint64 offset, int whence);
SDL_RWops *SDL_RWFromConstMem(const void *mem, int size);
SDL_RWops *SDL_RWFromMem(void *mem, int size);
int SDL_RWclose(SDL_RWops *context);
size_t SDL_RWread(SDL_RWops *context, void *ptr, size_t size, size_t maxnum);
size_t SDL_RWwrite(SDL_RWops *context, const void *ptr, size_t size, size_t num);
Sint64 SDL_RWtell(SDL_RWops *context);
SDL_Surface *SDL_ConvertSurface(SDL_Surface *src, const SDL_PixelFormat *fmt, Uint32 flags);
SDL_bool SDL_SetClipRect(SDL_Surface *surface, const SDL_Rect *rect);
int SDL_SetSurfaceAlphaMod(SDL_Surface *surface, Uint8 alpha);
int SDL_SetSurfaceBlendMode(SDL_Surface *surface, SDL_BlendMode blendMode);
int SDL_GetSurfaceBlendMode(SDL_Surface *surface, SDL_BlendMode *blendMode);
int SDL_GetColorKey(SDL_Surface *surface, Uint32 *key);
int SDL_SetSurfacePalette(SDL_Surface *surface, SDL_Palette *palette);
int SDL_UpperBlitScaled(SDL_Surface *src, const SDL_Rect *srcrect, SDL_Surface *dst, SDL_Rect *dstrect);
#define SDL_BlitScaled SDL_UpperBlitScaled
SDL_Surface *SDL_CreateRGBSurface(Uint32 flags, int width, int height, int depth,
                                  Uint32 Rmask, Uint32 Gmask, Uint32 Bmask, Uint32 Amask);
void SDL_FreeSurface(SDL_Surface *surface);
int SDL_FillRect(SDL_Surface *dst, const SDL_Rect *rect, Uint32 color);
int SDL_UpperBlit(SDL_Surface *src, const SDL_Rect *srcrect, SDL_Surface *dst, SDL_Rect *dstrect);
#define SDL_BlitSurface SDL_UpperBlit
#endif
`;

const SDL_EVENTS = `
#ifndef _PRISM_SDL_EVENTS_H
#define _PRISM_SDL_EVENTS_H
#include <SDL_stdinc.h>
#include <SDL_scancode.h>
#include <SDL_keycode.h>
#include <SDL_rect.h>
typedef Sint32 SDL_Keycode;
typedef Uint16 SDL_Keymod;
typedef struct SDL_Keysym {
    SDL_Scancode scancode;
    SDL_Keycode sym;
    Uint16 mod;
    Uint32 unused;
} SDL_Keysym;
#define SDL_RELEASED 0
#define SDL_PRESSED  1
#define SDL_QUIT              0x100
#define SDL_WINDOWEVENT       0x200
#define SDL_KEYDOWN           0x300
#define SDL_KEYUP             0x301
#define SDL_TEXTEDITING       0x302
#define SDL_TEXTINPUT         0x303
#define SDL_MOUSEMOTION       0x400
#define SDL_MOUSEBUTTONDOWN   0x401
#define SDL_MOUSEBUTTONUP     0x402
#define SDL_MOUSEWHEEL        0x403
#define SDL_JOYAXISMOTION     0x600
#define SDL_JOYBUTTONDOWN     0x603
#define SDL_JOYBUTTONUP       0x604
#define SDL_CONTROLLERAXISMOTION    0x650
#define SDL_CONTROLLERBUTTONDOWN    0x651
#define SDL_CONTROLLERBUTTONUP      0x652
#define SDL_CONTROLLERDEVICEADDED   0x653
#define SDL_CONTROLLERDEVICEREMOVED 0x654
#define SDL_USEREVENT         0x8000
#define SDL_WINDOWEVENT_EXPOSED       3
#define SDL_WINDOWEVENT_MOVED         4
#define SDL_WINDOWEVENT_SIZE_CHANGED  6
#define SDL_WINDOWEVENT_RESTORED      9
#define SDL_WINDOWEVENT_RESIZED       5
#define SDL_WINDOWEVENT_FOCUS_GAINED 12
#define SDL_WINDOWEVENT_FOCUS_LOST   13
#define SDL_IGNORE 0
#define SDL_DISABLE 0
#define SDL_ENABLE 1
#define SDL_BUTTON(X)     (1 << ((X) - 1))
#define SDL_BUTTON_LEFT   1
#define SDL_BUTTON_MIDDLE 2
#define SDL_BUTTON_RIGHT  3
#define SDL_BUTTON_X1     4
#define SDL_BUTTON_LMASK  SDL_BUTTON(SDL_BUTTON_LEFT)
#define SDL_BUTTON_MMASK  SDL_BUTTON(SDL_BUTTON_MIDDLE)
#define SDL_BUTTON_RMASK  SDL_BUTTON(SDL_BUTTON_RIGHT)
typedef struct { Uint32 type, timestamp, windowID; Uint8 state, repeat, padding2, padding3;
                 SDL_Keysym keysym; } SDL_KeyboardEvent;
typedef struct { Uint32 type, timestamp, windowID; Uint8 event, padding1, padding2, padding3;
                 Sint32 data1, data2; } SDL_WindowEvent;
typedef struct { Uint32 type, timestamp, windowID, which; Uint32 state;
                 Sint32 x, y, xrel, yrel; } SDL_MouseMotionEvent;
typedef struct { Uint32 type, timestamp, windowID, which; Uint8 button, state, clicks, padding1;
                 Sint32 x, y; } SDL_MouseButtonEvent;
typedef struct { Uint32 type, timestamp, windowID; char text[32]; } SDL_TextInputEvent;
typedef Sint32 SDL_JoystickID;
typedef struct { Uint32 type, timestamp, windowID, which; Sint32 x, y; Uint32 direction;
                 float preciseX, preciseY; Sint32 mouseX, mouseY; } SDL_MouseWheelEvent;
typedef struct { Uint32 type, timestamp; SDL_JoystickID which; Uint8 axis, padding1, padding2, padding3;
                 Sint16 value; Uint16 padding4; } SDL_JoyAxisEvent;
typedef struct { Uint32 type, timestamp; SDL_JoystickID which;
                 Uint8 button, state, padding1, padding2; } SDL_JoyButtonEvent;
typedef struct { Uint32 type, timestamp; SDL_JoystickID which; Uint8 axis, padding1, padding2, padding3;
                 Sint16 value; Uint16 padding4; } SDL_ControllerAxisEvent;
typedef struct { Uint32 type, timestamp; SDL_JoystickID which;
                 Uint8 button, state, padding1, padding2; } SDL_ControllerButtonEvent;
typedef struct { Uint32 type, timestamp; Sint32 which; } SDL_ControllerDeviceEvent;
typedef struct { Uint32 type, timestamp, windowID; Sint32 code; void *data1, *data2; } SDL_UserEvent;
typedef union SDL_Event {
    Uint32 type;
    SDL_KeyboardEvent key;
    SDL_WindowEvent window;
    SDL_MouseMotionEvent motion;
    SDL_MouseButtonEvent button;
    SDL_MouseWheelEvent wheel;
    SDL_TextInputEvent text;
    SDL_JoyAxisEvent jaxis;
    SDL_JoyButtonEvent jbutton;
    SDL_ControllerAxisEvent caxis;
    SDL_ControllerButtonEvent cbutton;
    SDL_ControllerDeviceEvent cdevice;
    SDL_UserEvent user;
    Uint8 padding[56];
} SDL_Event;
const Uint8 *SDL_GetKeyboardState(int *numkeys);
void SDL_SetTextInputRect(const SDL_Rect *rect);
int SDL_PollEvent(SDL_Event *event);
int SDL_PushEvent(SDL_Event *event);
void SDL_StartTextInput(void);
void SDL_StopTextInput(void);
const char *SDL_GetScancodeName(SDL_Scancode scancode);
SDL_Scancode SDL_GetScancodeFromName(const char *name);
#endif
`;

const SDL_VIDEO = `
#ifndef _PRISM_SDL_VIDEO_H
#define _PRISM_SDL_VIDEO_H
#include <SDL_stdinc.h>
#include <SDL_rect.h>
#include <SDL_surface.h>
typedef struct SDL_Window SDL_Window;
typedef struct SDL_Renderer SDL_Renderer;
typedef struct SDL_Texture SDL_Texture;
#define SDL_WINDOWPOS_CENTERED 0x2FFF0000
#define SDL_WINDOWPOS_UNDEFINED 0x1FFF0000
#define SDL_WINDOW_ALLOW_HIGHDPI 0x00002000
/* OpenGL (src/env/sdl2gl.js, which a target names beside gl): SDL_video.h's values. */
#define SDL_WINDOW_FULLSCREEN 0x00000001
#define SDL_WINDOW_OPENGL 0x00000002
#define SDL_WINDOW_SHOWN 0x00000004
#define SDL_WINDOW_BORDERLESS 0x00000010
#define SDL_WINDOWPOS_CENTERED_DISPLAY(X) (0x2FFF0000u | (X))
#define SDL_WINDOWPOS_UNDEFINED_DISPLAY(X) (0x1FFF0000u | (X))
typedef void *SDL_GLContext;
typedef enum {
    SDL_GL_RED_SIZE, SDL_GL_GREEN_SIZE, SDL_GL_BLUE_SIZE, SDL_GL_ALPHA_SIZE, SDL_GL_BUFFER_SIZE,
    SDL_GL_DOUBLEBUFFER, SDL_GL_DEPTH_SIZE, SDL_GL_STENCIL_SIZE, SDL_GL_ACCUM_RED_SIZE,
    SDL_GL_ACCUM_GREEN_SIZE, SDL_GL_ACCUM_BLUE_SIZE, SDL_GL_ACCUM_ALPHA_SIZE, SDL_GL_STEREO,
    SDL_GL_MULTISAMPLEBUFFERS, SDL_GL_MULTISAMPLESAMPLES, SDL_GL_ACCELERATED_VISUAL,
    SDL_GL_RETAINED_BACKING, SDL_GL_CONTEXT_MAJOR_VERSION, SDL_GL_CONTEXT_MINOR_VERSION,
    SDL_GL_CONTEXT_EGL, SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_PROFILE_MASK,
    SDL_GL_SHARE_WITH_CURRENT_CONTEXT, SDL_GL_FRAMEBUFFER_SRGB_CAPABLE,
    SDL_GL_CONTEXT_RELEASE_BEHAVIOR, SDL_GL_CONTEXT_RESET_NOTIFICATION, SDL_GL_CONTEXT_NO_ERROR,
    SDL_GL_FLOATBUFFERS
} SDL_GLattr;
int SDL_GL_LoadLibrary(const char *path);
void *SDL_GL_GetProcAddress(const char *proc);
void SDL_GL_UnloadLibrary(void);
SDL_bool SDL_GL_ExtensionSupported(const char *extension);
void SDL_GL_ResetAttributes(void);
int SDL_GL_SetAttribute(SDL_GLattr attr, int value);
int SDL_GL_GetAttribute(SDL_GLattr attr, int *value);
SDL_GLContext SDL_GL_CreateContext(SDL_Window *window);
int SDL_GL_MakeCurrent(SDL_Window *window, SDL_GLContext context);
SDL_Window *SDL_GL_GetCurrentWindow(void);
SDL_GLContext SDL_GL_GetCurrentContext(void);
int SDL_GL_SetSwapInterval(int interval);
int SDL_GL_GetSwapInterval(void);
void SDL_GL_SwapWindow(SDL_Window *window);
void SDL_GL_DeleteContext(SDL_GLContext context);
#define SDL_RENDERER_SOFTWARE 0x00000001
#define SDL_RENDERER_TARGETTEXTURE 0x00000008
#define SDL_TEXTUREACCESS_TARGET 2
typedef struct SDL_RendererInfo {
    const char *name;
    Uint32 flags;
    Uint32 num_texture_formats;
    Uint32 texture_formats[16];
    int max_texture_width;
    int max_texture_height;
} SDL_RendererInfo;
int SDL_GetRendererInfo(SDL_Renderer *renderer, SDL_RendererInfo *info);
int SDL_GetRendererOutputSize(SDL_Renderer *renderer, int *w, int *h);
void SDL_RenderGetLogicalSize(SDL_Renderer *renderer, int *w, int *h);
void SDL_RenderGetScale(SDL_Renderer *renderer, float *scaleX, float *scaleY);
void SDL_RenderGetViewport(SDL_Renderer *renderer, SDL_Rect *rect);
int SDL_RenderSetIntegerScale(SDL_Renderer *renderer, SDL_bool enable);
int SDL_SetRenderTarget(SDL_Renderer *renderer, SDL_Texture *texture);
Uint32 SDL_GetWindowFlags(SDL_Window *window);
void SDL_GL_GetDrawableSize(SDL_Window *window, int *w, int *h);
typedef struct {
    Uint32 format;
    int w;
    int h;
    int refresh_rate;
    void *driverdata;
} SDL_DisplayMode;
int SDL_GetDesktopDisplayMode(int displayIndex, SDL_DisplayMode *mode);
const char *SDL_GetDisplayName(int displayIndex);
Uint32 SDL_GetWindowID(SDL_Window *window);
void SDL_SetWindowGrab(SDL_Window *window, SDL_bool grabbed);
void SDL_WarpMouseInWindow(SDL_Window *window, int x, int y);
#define SDL_WINDOW_FULLSCREEN_DESKTOP 0x00001001
#define SDL_WINDOW_HIDDEN     0x00000008
#define SDL_WINDOW_RESIZABLE  0x00000020
#define SDL_TEXTUREACCESS_STREAMING 1
#define SDL_RENDERER_ACCELERATED 0x00000002
#define SDL_RENDERER_PRESENTVSYNC 0x00000004
SDL_Window *SDL_CreateWindow(const char *title, int x, int y, int w, int h, Uint32 flags);
void SDL_DestroyWindow(SDL_Window *window);
void SDL_ShowWindow(SDL_Window *window);
void SDL_SetWindowSize(SDL_Window *window, int w, int h);
void SDL_SetWindowPosition(SDL_Window *window, int x, int y);
int SDL_SetWindowFullscreen(SDL_Window *window, Uint32 flags);
void SDL_GetWindowSize(SDL_Window *window, int *w, int *h);
int SDL_GetWindowDisplayIndex(SDL_Window *window);
int SDL_GetNumVideoDisplays(void);
int SDL_GetDisplayBounds(int displayIndex, SDL_Rect *rect);
SDL_Renderer *SDL_CreateRenderer(SDL_Window *window, int index, Uint32 flags);
void SDL_DestroyRenderer(SDL_Renderer *renderer);
int SDL_RenderClear(SDL_Renderer *renderer);
int SDL_RenderCopy(SDL_Renderer *renderer, SDL_Texture *texture,
                   const SDL_Rect *srcrect, const SDL_Rect *dstrect);
void SDL_RenderPresent(SDL_Renderer *renderer);
int SDL_SetRenderDrawColor(SDL_Renderer *renderer, Uint8 r, Uint8 g, Uint8 b, Uint8 a);
SDL_Texture *SDL_CreateTexture(SDL_Renderer *renderer, Uint32 format, int access, int w, int h);
void SDL_DestroyTexture(SDL_Texture *texture);
int SDL_QueryTexture(SDL_Texture *texture, Uint32 *format, int *access, int *w, int *h);
int SDL_LockTexture(SDL_Texture *texture, const SDL_Rect *rect, void **pixels, int *pitch);
void SDL_UnlockTexture(SDL_Texture *texture);

/*
 * What Jump 'n Bump's SDL 2 port asks for beyond OpenTyrian's needs. Two groups, and the split is
 * worth seeing: SDL_CreateWindowAndRenderer, SDL_RenderSetLogicalSize, SDL_UpdateTexture,
 * SDL_ConvertSurfaceFormat, SDL_SetPaletteColors, SDL_SetWindowTitle and SDL_SetWindowIcon are
 * SDL2's own, while SDL_LockSurface, SDL_UnlockSurface, SDL_SetColorKey, SDL_MapRGBA,
 * SDL_GetMouseState, SDL_LockAudio and SDL_UnlockAudio are names SDL2 KEPT from 1.2 -- which is
 * exactly why the two versions cannot share one table: same name, and here the same meaning, but
 * the structs behind them differ.
 *
 * Signatures read from the real SDL2 headers in the oracle container, not recalled.
 */
int SDL_CreateWindowAndRenderer(int width, int height, Uint32 window_flags,
                                SDL_Window **window, SDL_Renderer **renderer);
int SDL_RenderSetLogicalSize(SDL_Renderer *renderer, int w, int h);
int SDL_UpdateTexture(SDL_Texture *texture, const SDL_Rect *rect, const void *pixels, int pitch);
void SDL_SetWindowTitle(SDL_Window *window, const char *title);
void SDL_SetWindowIcon(SDL_Window *window, SDL_Surface *icon);
SDL_Surface *SDL_ConvertSurfaceFormat(SDL_Surface *src, Uint32 pixel_format, Uint32 flags);
int SDL_SetPaletteColors(SDL_Palette *palette, const SDL_Color *colors,
                         int firstcolor, int ncolors);

/* SDL2 keeps SDL_SWSURFACE defined as 0 for source compatibility; this port still passes it. */
#define SDL_SWSURFACE 0

int SDL_LockSurface(SDL_Surface *surface);
void SDL_UnlockSurface(SDL_Surface *surface);
int SDL_SetColorKey(SDL_Surface *surface, int flag, Uint32 key);
Uint32 SDL_MapRGBA(const SDL_PixelFormat *format, Uint8 r, Uint8 g, Uint8 b, Uint8 a);
Uint32 SDL_GetMouseState(int *x, int *y);
void SDL_LockAudio(void);
void SDL_UnlockAudio(void);
int SDL_ShowCursor(int toggle);
int SDL_SetRelativeMouseMode(SDL_bool enabled);
#endif
`;

const SDL_AUDIO = `
#ifndef _PRISM_SDL_AUDIO_H
#define _PRISM_SDL_AUDIO_H
#include <SDL_stdinc.h>
typedef Uint16 SDL_AudioFormat;
typedef Uint32 SDL_AudioDeviceID;
#define AUDIO_U8     0x0008
#define AUDIO_S8     0x8008
#define AUDIO_S16LSB 0x8010
#define AUDIO_S16SYS AUDIO_S16LSB
typedef enum { SDL_AUDIO_STOPPED = 0, SDL_AUDIO_PLAYING, SDL_AUDIO_PAUSED } SDL_AudioStatus;
#define SDL_AUDIO_ALLOW_FREQUENCY_CHANGE 0x00000001
#define SDL_AUDIO_ALLOW_FORMAT_CHANGE    0x00000002
#define SDL_AUDIO_ALLOW_CHANNELS_CHANGE  0x00000004
#define SDL_AUDIO_ALLOW_SAMPLES_CHANGE   0x00000008
typedef void (*SDL_AudioCallback)(void *userdata, Uint8 *stream, int len);
typedef struct SDL_AudioSpec {
    int freq;
    SDL_AudioFormat format;
    Uint8 channels, silence;
    Uint16 samples, padding;
    Uint32 size;
    SDL_AudioCallback callback;
    void *userdata;
} SDL_AudioSpec;
struct SDL_AudioCVT;
typedef void (*SDL_AudioFilter)(struct SDL_AudioCVT *cvt, SDL_AudioFormat format);
/*
 * SDL declares this one PACKED, and says why in its own header: the struct is part of the ABI and
 * must not grow. Reproduced rather than tidied, because the program declares one on its stack.
 */
#pragma pack(push, 1)
typedef struct SDL_AudioCVT {
    int needed;
    SDL_AudioFormat src_format, dst_format;
    double rate_incr;
    Uint8 *buf;
    int len, len_cvt, len_mult;
    double len_ratio;
    SDL_AudioFilter filters[10];
    int filter_index;
} SDL_AudioCVT;
#pragma pack(pop)
SDL_AudioDeviceID SDL_OpenAudioDevice(const char *device, int iscapture,
                                      const SDL_AudioSpec *desired, SDL_AudioSpec *obtained,
                                      int allowed_changes);
void SDL_CloseAudioDevice(SDL_AudioDeviceID dev);
void SDL_PauseAudioDevice(SDL_AudioDeviceID dev, int pause_on);
void SDL_LockAudioDevice(SDL_AudioDeviceID dev);
void SDL_UnlockAudioDevice(SDL_AudioDeviceID dev);
int SDL_OpenAudio(SDL_AudioSpec *desired, SDL_AudioSpec *obtained);
void SDL_CloseAudio(void);
void SDL_PauseAudio(int pause_on);
SDL_AudioStatus SDL_GetAudioStatus(void);
int SDL_BuildAudioCVT(SDL_AudioCVT *cvt, SDL_AudioFormat src_format, Uint8 src_channels, int src_rate,
                      SDL_AudioFormat dst_format, Uint8 dst_channels, int dst_rate);
int SDL_ConvertAudio(SDL_AudioCVT *cvt);
#endif
`;

const SDL_JOYSTICK = `
#ifndef _PRISM_SDL_JOYSTICK_H
#define _PRISM_SDL_JOYSTICK_H
#include <SDL_stdinc.h>
#include <SDL_surface.h>
typedef struct _SDL_Joystick SDL_Joystick;
#define SDL_HAT_CENTERED 0x00
#define SDL_HAT_UP       0x01
#define SDL_HAT_RIGHT    0x02
#define SDL_HAT_DOWN     0x04
#define SDL_HAT_LEFT     0x08
int SDL_NumJoysticks(void);
SDL_Joystick *SDL_JoystickOpen(int device_index);
void SDL_JoystickClose(SDL_Joystick *joystick);
const char *SDL_JoystickName(SDL_Joystick *joystick);
int SDL_JoystickNumAxes(SDL_Joystick *joystick);
int SDL_JoystickNumButtons(SDL_Joystick *joystick);
int SDL_JoystickNumHats(SDL_Joystick *joystick);
Sint16 SDL_JoystickGetAxis(SDL_Joystick *joystick, int axis);
Uint8 SDL_JoystickGetButton(SDL_Joystick *joystick, int button);
Uint8 SDL_JoystickGetHat(SDL_Joystick *joystick, int hat);
void SDL_JoystickUpdate(void);
int SDL_JoystickEventState(int state);
int SDL_JoystickRumble(SDL_Joystick *joystick, Uint16 low_frequency_rumble, Uint16 high_frequency_rumble, Uint32 duration_ms);

/* Game controllers and force feedback: there are none, and each of these says so. */
typedef struct _SDL_GameController SDL_GameController;
typedef struct _SDL_Haptic SDL_Haptic;
typedef enum {
    SDL_CONTROLLER_AXIS_INVALID = -1, SDL_CONTROLLER_AXIS_LEFTX, SDL_CONTROLLER_AXIS_LEFTY,
    SDL_CONTROLLER_AXIS_RIGHTX, SDL_CONTROLLER_AXIS_RIGHTY, SDL_CONTROLLER_AXIS_TRIGGERLEFT,
    SDL_CONTROLLER_AXIS_TRIGGERRIGHT, SDL_CONTROLLER_AXIS_MAX
} SDL_GameControllerAxis;
typedef enum {
    SDL_CONTROLLER_BUTTON_INVALID = -1, SDL_CONTROLLER_BUTTON_A, SDL_CONTROLLER_BUTTON_B,
    SDL_CONTROLLER_BUTTON_X, SDL_CONTROLLER_BUTTON_Y, SDL_CONTROLLER_BUTTON_BACK,
    SDL_CONTROLLER_BUTTON_GUIDE, SDL_CONTROLLER_BUTTON_START, SDL_CONTROLLER_BUTTON_LEFTSTICK,
    SDL_CONTROLLER_BUTTON_RIGHTSTICK, SDL_CONTROLLER_BUTTON_LEFTSHOULDER,
    SDL_CONTROLLER_BUTTON_RIGHTSHOULDER, SDL_CONTROLLER_BUTTON_DPAD_UP,
    SDL_CONTROLLER_BUTTON_DPAD_DOWN, SDL_CONTROLLER_BUTTON_DPAD_LEFT, SDL_CONTROLLER_BUTTON_DPAD_RIGHT
} SDL_GameControllerButton;
SDL_bool SDL_IsGameController(int joystick_index);
SDL_GameController *SDL_GameControllerOpen(int joystick_index);
void SDL_GameControllerClose(SDL_GameController *gamecontroller);
SDL_GameController *SDL_GameControllerFromInstanceID(Sint32 joyid);
int SDL_GameControllerRumble(SDL_GameController *gamecontroller, Uint16 low_frequency_rumble, Uint16 high_frequency_rumble, Uint32 duration_ms);
int SDL_GameControllerAddMapping(const char *mappingString);
int SDL_GameControllerAddMappingsFromRW(SDL_RWops *rw, int freerw);
SDL_RWops *SDL_RWFromFile(const char *file, const char *mode);
#define SDL_GameControllerAddMappingsFromFile(file) SDL_GameControllerAddMappingsFromRW(SDL_RWFromFile(file, "rb"), 1)
SDL_Haptic *SDL_HapticOpen(int device_index);
int SDL_HapticRumbleInit(SDL_Haptic *haptic);
int SDL_HapticRumblePlay(SDL_Haptic *haptic, float strength, Uint32 length);
#endif
`;

const SDL_LOG = `
#ifndef _PRISM_SDL_LOG_H
#define _PRISM_SDL_LOG_H
#include <SDL_stdinc.h>
#define SDL_LOG_CATEGORY_APPLICATION 0
typedef enum {
    SDL_LOG_PRIORITY_VERBOSE = 1, SDL_LOG_PRIORITY_DEBUG, SDL_LOG_PRIORITY_INFO,
    SDL_LOG_PRIORITY_WARN, SDL_LOG_PRIORITY_ERROR, SDL_LOG_PRIORITY_CRITICAL
} SDL_LogPriority;
void SDL_Log(const char *fmt, ...);
void SDL_LogDebug(int category, const char *fmt, ...);
void SDL_LogWarn(int category, const char *fmt, ...);
void SDL_LogError(int category, const char *fmt, ...);
void SDL_LogMessageV(int category, SDL_LogPriority priority, const char *fmt, va_list ap);
void SDL_LogSetPriority(int category, SDL_LogPriority priority);
#define SDL_PRINTF_FORMAT_STRING
#define SDL_PRINTF_VARARG_FUNC(fmtargnumber)
#endif
`;

const SDL_MAIN = `
#ifndef _PRISM_SDL_H
#define _PRISM_SDL_H
#include <SDL_stdinc.h>
#include <SDL_endian.h>
#include <SDL_scancode.h>
#include <SDL_keycode.h>
#include <SDL_pixels.h>
#include <SDL_rect.h>
#include <SDL_surface.h>
#include <SDL_events.h>
#include <SDL_video.h>
#include <SDL_audio.h>
#include <SDL_joystick.h>
#include <SDL_log.h>
#define SDL_INIT_TIMER    0x00000001u
#define SDL_INIT_AUDIO    0x00000010u
#define SDL_INIT_VIDEO    0x00000020u
#define SDL_INIT_JOYSTICK 0x00000200u
#define SDL_INIT_HAPTIC   0x00001000u
#define SDL_INIT_GAMECONTROLLER 0x00002000u
#define SDL_INIT_NOPARACHUTE 0x00100000u
#define SDL_MESSAGEBOX_ERROR 0x00000010
#define SDL_HINT_RENDER_SCALE_QUALITY "SDL_RENDER_SCALE_QUALITY"
#define SDL_HINT_RENDER_VSYNC "SDL_RENDER_VSYNC"
#define SDL_HINT_IME_SHOW_UI "SDL_IME_SHOW_UI"
#define SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE "SDL_MOUSE_RELATIVE_SYSTEM_SCALE"
/* The compiled-against version. OpenTyrian tests it with SDL_VERSION_ATLEAST. */
#define SDL_MAJOR_VERSION 2
#define SDL_MINOR_VERSION 0
#define SDL_PATCHLEVEL    22
#define SDL_VERSIONNUM(X, Y, Z) ((X) * 1000 + (Y) * 100 + (Z))
#define SDL_COMPILEDVERSION SDL_VERSIONNUM(SDL_MAJOR_VERSION, SDL_MINOR_VERSION, SDL_PATCHLEVEL)
#define SDL_VERSION_ATLEAST(X, Y, Z) (SDL_COMPILEDVERSION >= SDL_VERSIONNUM(X, Y, Z))
typedef struct SDL_version { Uint8 major, minor, patch; } SDL_version;
#define SDL_VERSION(x) { (x)->major = SDL_MAJOR_VERSION; (x)->minor = SDL_MINOR_VERSION; (x)->patch = SDL_PATCHLEVEL; }
void SDL_GetVersion(SDL_version *ver);
Uint32 SDL_WasInit(Uint32 flags);
int SDL_SetError(const char *fmt, ...);
#define SDL_OutOfMemory() SDL_SetError("Out of memory")
#define SDL_QUERY -1
#define SDL_IGNORE 0
#define SDL_DISABLE 0
#define SDL_ENABLE 1
Uint8 SDL_EventState(Uint32 type, int state);
const char *SDL_GetKeyName(SDL_Keycode key);
SDL_Keycode SDL_GetKeyFromName(const char *name);
typedef int SDL_TimerID;
typedef Uint32 (*SDL_TimerCallback)(Uint32 interval, void *param);
SDL_TimerID SDL_AddTimer(Uint32 interval, SDL_TimerCallback callback, void *param);
SDL_bool SDL_RemoveTimer(SDL_TimerID id);
Uint64 SDL_GetPerformanceCounter(void);
Uint64 SDL_GetPerformanceFrequency(void);
int SDL_Init(Uint32 flags);
int SDL_InitSubSystem(Uint32 flags);
void SDL_QuitSubSystem(Uint32 flags);
void SDL_Quit(void);
const char *SDL_GetError(void);
Uint32 SDL_GetTicks(void);
void SDL_Delay(Uint32 ms);
SDL_bool SDL_SetHint(const char *name, const char *value);
int SDL_ShowSimpleMessageBox(Uint32 flags, const char *title, const char *message,
                             SDL_Window *window);
#endif
`;

/*
 * SDL_image, which is its own library as SDL_mixer is. What it does with a file is in
 * src/env/sdl2-image.js; IMG_GetError is SDL's own error string, as in the real header.
 */
const SDL_IMAGE = `
#ifndef _PRISM_SDL_IMAGE_H
#define _PRISM_SDL_IMAGE_H
#include <SDL.h>
SDL_Surface *IMG_Load(const char *file);
SDL_Surface *IMG_Load_RW(SDL_RWops *src, int freesrc);
int IMG_SavePNG(SDL_Surface *surface, const char *file);
#define IMG_GetError SDL_GetError
#endif
`;

export const SDL2_HEADERS = {
  'SDL_image.h': SDL_IMAGE,
  'SDL2/SDL_image.h': SDL_IMAGE,
  'SDL.h': SDL_MAIN,
  // A library built against SDL 2 (SDL2_ttf) brackets its declarations with these; on Linux they are empty.
  'SDL_rwops.h': '#include <SDL.h>\n',
  'SDL_thread.h': '#include <SDL.h>\n',
  'begin_code.h': '#ifndef DECLSPEC\n#define DECLSPEC\n#endif\n#ifndef SDLCALL\n#define SDLCALL\n#endif\n',
  'close_code.h': '',
  'SDL2/SDL.h': SDL_MAIN,
  'SDL_stdinc.h': SDL_STDINC,
  // SDL 1.2's name for the same file, which SDL2 keeps as a compatibility alias and OpenTyrian
  // still writes.
  'SDL_types.h': SDL_STDINC,
  'SDL_endian.h': SDL_ENDIAN,
  'SDL_scancode.h': SDL_SCANCODE,
  'SDL_keycode.h': SDL_KEYCODE,
  'SDL_pixels.h': SDL_PIXELS,
  'SDL_rect.h': SDL_RECT,
  'SDL_surface.h': SDL_SURFACE,
  'SDL_events.h': SDL_EVENTS,
  'SDL_video.h': SDL_VIDEO,
  'SDL_audio.h': SDL_AUDIO,
  'SDL_joystick.h': SDL_JOYSTICK,
  'SDL_log.h': SDL_LOG,
};
