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
size_t SDL_strlcpy(char *dst, const char *src, size_t maxlen);
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
#define SDL_SwapLE16(x) (x)
#define SDL_SwapLE32(x) (x)
#define SDL_SwapBE16(x) ((Uint16)((((Uint16)(x)) << 8) | (((Uint16)(x)) >> 8)))
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
    SDL_SCANCODE_LCTRL = 224, SDL_SCANCODE_LSHIFT, SDL_SCANCODE_LALT, SDL_SCANCODE_LGUI,
    SDL_SCANCODE_RCTRL, SDL_SCANCODE_RSHIFT, SDL_SCANCODE_RALT, SDL_SCANCODE_RGUI,
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
#define SDL_PIXELFORMAT_RGB565 0x15151002
#define SDL_PIXELFORMAT_RGB888 0x16161804
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
#define SDL_JOYAXISMOTION     0x600
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
typedef union SDL_Event {
    Uint32 type;
    SDL_KeyboardEvent key;
    SDL_WindowEvent window;
    SDL_MouseMotionEvent motion;
    SDL_MouseButtonEvent button;
    SDL_TextInputEvent text;
    Uint8 padding[56];
} SDL_Event;
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
int SDL_BuildAudioCVT(SDL_AudioCVT *cvt, SDL_AudioFormat src_format, Uint8 src_channels, int src_rate,
                      SDL_AudioFormat dst_format, Uint8 dst_channels, int dst_rate);
int SDL_ConvertAudio(SDL_AudioCVT *cvt);
#endif
`;

const SDL_JOYSTICK = `
#ifndef _PRISM_SDL_JOYSTICK_H
#define _PRISM_SDL_JOYSTICK_H
#include <SDL_stdinc.h>
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
#define SDL_MESSAGEBOX_ERROR 0x00000010
#define SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE "SDL_MOUSE_RELATIVE_SYSTEM_SCALE"
/* The compiled-against version. OpenTyrian tests it with SDL_VERSION_ATLEAST. */
#define SDL_MAJOR_VERSION 2
#define SDL_MINOR_VERSION 0
#define SDL_PATCHLEVEL    22
#define SDL_VERSIONNUM(X, Y, Z) ((X) * 1000 + (Y) * 100 + (Z))
#define SDL_COMPILEDVERSION SDL_VERSIONNUM(SDL_MAJOR_VERSION, SDL_MINOR_VERSION, SDL_PATCHLEVEL)
#define SDL_VERSION_ATLEAST(X, Y, Z) (SDL_COMPILEDVERSION >= SDL_VERSIONNUM(X, Y, Z))
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

export const SDL2_HEADERS = {
  'SDL.h': SDL_MAIN,
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
