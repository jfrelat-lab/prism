// headers-sdl12.js — SDL 1.2's declarations, for a program compiled against SDL 1.2.
//
// NOT a variant of headers-sdl2.js and not derived from it. The two APIs share a prefix and little
// else, and the places they overlap are the dangerous ones: SDL_Surface and SDL_PixelFormat have
// different fields, SDL_PollEvent hands back a different union, and SDL_KEYDOWN differs in both
// value and layout. That is why these travel on the `sdl12` environment rather than in the global
// header table, and why naming both environments is refused rather than resolved — see
// src/env/registry.js.
//
// WHAT IS DECLARED IS WHAT corpus/jumpnbump-sdl12 ASKS FOR, and the list came from its own source
// rather than from a memory of SDL: 34 functions, 11 types, 17 constants, 19 key symbols. Adding
// the rest of SDL 1.2 before a program needs it is how a shim grows a surface nobody checks.
// corpus/tuxracer-0.61 then asked for more -- SDL_OPENGL and the SDL_GL calls, the rest of the
// keyboard, mouse motion, the resize event, the audio formats, SDL_RWFromFile -- and each of those
// is in the gate's probe too. corpus/scummvm-0.6.1's SDL backend then asked for the audio callback
// (SDL_OpenAudio), the timer, the software blits and fills, CREATED-FROM surfaces, the CD-ROM, the
// joystick and expose events and input grabbing -- read from the real headers in the oracle
// container (/usr/include/SDL) and measured by the same gate.
//
// EVERY LAYOUT AND EVERY VALUE HERE WAS MEASURED against the real headers, with gcc -m32 in the
// oracle container (libsdl1.2-dev), because the program reads surface->pixels and surface->pitch
// directly: an offset that is off by one field is corrupted graphics, not an error. Two of the
// numbers would not have survived being written from memory --
//
//   pitch is Uint16 in SDL 1.2 and int in SDL2. A 32-bit read picks up the padding behind it.
//   SDL_Event's type is Uint8 in SDL 1.2 and Uint32 in SDL2.
//
// The measured reference, which tools/gate-sdl12abi.mjs re-checks:
//
//   SDL_Surface 60   flags 0  format 4  w 8  h 12  pitch 16  pixels 20  clip_rect 32  refcount 56
//   SDL_PixelFormat 40   palette 0  BitsPerPixel 4  BytesPerPixel 5  Rmask 16  colorkey 32  alpha 36
//   SDL_Event 20   type 0  key.state 2  key.keysym 4  key.keysym.sym 8  key.keysym.unicode 16
//                  button.button 2  button.state 3
//   SDL_keysym 16   SDL_Color 4   SDL_Rect 8
//
// The padding members below carry SDL's own field names where the name is public and a neutral one
// where it is an internal detail; either way they exist to place the fields after them, and the
// gate is what says they do.

const SDL_STDINC_12 = `
#ifndef _SDL_stdinc_h
#define _SDL_stdinc_h
typedef unsigned char Uint8;
typedef signed char Sint8;
typedef unsigned short Uint16;
typedef signed short Sint16;
typedef unsigned int Uint32;
typedef enum { SDL_FALSE = 0, SDL_TRUE = 1 } SDL_bool;
typedef signed int Sint32;
#endif
`;

const SDL_ENDIAN_12 = `
#ifndef _SDL_endian_h
#define _SDL_endian_h
#define SDL_LIL_ENDIAN 1234
#define SDL_BIG_ENDIAN 4321
/* PRISM's target is i386, and its guests are little-endian by construction. */
#define SDL_BYTEORDER SDL_LIL_ENDIAN
#define SDL_Swap16(x) ((Uint16)(((Uint16)(x) << 8) | ((Uint16)(x) >> 8)))
#define SDL_SwapLE16(x) (x)
#define SDL_SwapLE32(x) (x)
#endif
`;

const SDL_MUTEX_12 = `
#ifndef _SDL_mutex_h
#define _SDL_mutex_h
struct SDL_mutex;
typedef struct SDL_mutex SDL_mutex;
struct SDL_semaphore;
typedef struct SDL_semaphore SDL_sem;
SDL_mutex *SDL_CreateMutex(void);
int SDL_mutexP(SDL_mutex *mutex);
int SDL_mutexV(SDL_mutex *mutex);
void SDL_DestroyMutex(SDL_mutex *mutex);
#define SDL_LockMutex(m) SDL_mutexP(m)
#define SDL_UnlockMutex(m) SDL_mutexV(m)
SDL_sem *SDL_CreateSemaphore(Uint32 initial_value);
void SDL_DestroySemaphore(SDL_sem *sem);
int SDL_SemWait(SDL_sem *sem);
int SDL_SemPost(SDL_sem *sem);
Uint32 SDL_SemValue(SDL_sem *sem);
#endif
`;

const SDL_THREAD_12 = `
#ifndef _SDL_thread_h
#define _SDL_thread_h
struct SDL_Thread;
typedef struct SDL_Thread SDL_Thread;
SDL_Thread *SDL_CreateThread(int (*fn)(void *), void *data);
Uint32 SDL_ThreadID(void);
void SDL_WaitThread(SDL_Thread *thread, int *status);
void SDL_KillThread(SDL_Thread *thread);
#endif
`;


const SDL_MAIN_12 = `
#ifndef _SDL_H
#define _SDL_H
#include "SDL_stdinc.h"
#include "SDL_endian.h"
#include "SDL_mutex.h"
#include "SDL_thread.h"

#define SDL_INIT_TIMER    0x00000001
#define SDL_INIT_AUDIO    0x00000010
#define SDL_INIT_VIDEO    0x00000020
#define SDL_INIT_CDROM    0x00000100
#define SDL_INIT_JOYSTICK 0x00000200
#define SDL_INIT_NOPARACHUTE 0x00100000
#define SDL_INIT_EVERYTHING 0x0000FFFF

/* A file as SDL reads one. Opaque here: the only use is to hand one to a loader. */
typedef struct SDL_RWops SDL_RWops;
SDL_RWops *SDL_RWFromFile(const char *file, const char *mode);
/* A macro calling ctx->close in SDL; the struct is opaque here, so it is a function. */
int SDL_RWclose(SDL_RWops *ctx);

#define AUDIO_U8     0x0008
#define AUDIO_S16LSB 0x8010
#define AUDIO_S16    AUDIO_S16LSB
#define AUDIO_S16SYS AUDIO_S16LSB

/* The audio device: SDL calls the callback for each buffer it needs (see SDL_OpenAudio in sdl12.js). */
typedef struct SDL_AudioSpec {
    int freq;
    Uint16 format;
    Uint8 channels;
    Uint8 silence;
    Uint16 samples;
    Uint16 padding;
    Uint32 size;
    void (*callback)(void *userdata, Uint8 *stream, int len);
    void *userdata;
} SDL_AudioSpec;
int SDL_OpenAudio(SDL_AudioSpec *desired, SDL_AudioSpec *obtained);

/* One periodic timer, the old interface: the callback returns the next interval, or 0 to stop. */
typedef Uint32 (*SDL_TimerCallback)(Uint32 interval);
int SDL_SetTimer(Uint32 interval, SDL_TimerCallback callback);

/* Timers of the newer interface (ScummVM 0.10.0's backend): as many as are added, each with a
   parameter; the callback returns the next interval, or 0 to stop. Fired where SDL_SetTimer's is. */
typedef struct _SDL_TimerID *SDL_TimerID;
typedef Uint32 (*SDL_NewTimerCallback)(Uint32 interval, void *param);
SDL_TimerID SDL_AddTimer(Uint32 interval, SDL_NewTimerCallback callback, void *param);
SDL_bool SDL_RemoveTimer(SDL_TimerID t);

/* The version these declarations are, SDL 1.2.15's, and its macros (SDL_version.h). */
#define SDL_MAJOR_VERSION 1
#define SDL_MINOR_VERSION 2
#define SDL_PATCHLEVEL 15
#define SDL_VERSIONNUM(X, Y, Z) ((X)*1000 + (Y)*100 + (Z))
#define SDL_COMPILEDVERSION SDL_VERSIONNUM(SDL_MAJOR_VERSION, SDL_MINOR_VERSION, SDL_PATCHLEVEL)
#define SDL_VERSION_ATLEAST(X, Y, Z) (SDL_COMPILEDVERSION >= SDL_VERSIONNUM(X, Y, Z))

/* The CD-ROM: there is no drive here, so SDL_CDNumDrives is 0 and SDL_CDOpen fails. */
#define SDL_MAX_TRACKS 99
#define SDL_AUDIO_TRACK 0x00
#define SDL_DATA_TRACK  0x04
typedef enum { CD_TRAYEMPTY, CD_STOPPED, CD_PLAYING, CD_PAUSED, CD_ERROR = -1 } CDstatus;
#define CD_INDRIVE(status) ((int)(status) > 0)
typedef struct SDL_CDtrack {
    Uint8 id;
    Uint8 type;
    Uint16 unused;
    Uint32 length;
    Uint32 offset;
} SDL_CDtrack;
typedef struct SDL_CD {
    int id;
    CDstatus status;
    int numtracks;
    int cur_track;
    int cur_frame;
    SDL_CDtrack track[SDL_MAX_TRACKS + 1];
} SDL_CD;
#define CD_FPS 75
int SDL_CDNumDrives(void);
const char *SDL_CDName(int drive);
SDL_CD *SDL_CDOpen(int drive);
CDstatus SDL_CDStatus(SDL_CD *cdrom);
int SDL_CDPlayTracks(SDL_CD *cdrom, int start_track, int start_frame, int ntracks, int nframes);
int SDL_CDPlay(SDL_CD *cdrom, int start, int length);
int SDL_CDPause(SDL_CD *cdrom);
int SDL_CDResume(SDL_CD *cdrom);
int SDL_CDStop(SDL_CD *cdrom);
int SDL_CDEject(SDL_CD *cdrom);
void SDL_CDClose(SDL_CD *cdrom);

int SDL_Init(Uint32 flags);
int SDL_InitSubSystem(Uint32 flags);
void SDL_Quit(void);
char *SDL_GetError(void);
void SDL_Delay(Uint32 ms);
Uint32 SDL_GetTicks(void);

typedef struct SDL_Rect {
    Sint16 x, y;
    Uint16 w, h;
} SDL_Rect;

typedef struct SDL_Color {
    Uint8 r, g, b, unused;
} SDL_Color;

typedef struct SDL_Palette {
    int ncolors;
    SDL_Color *colors;
} SDL_Palette;

/* 40 bytes. Rmask lands at 16 because the eight loss/shift bytes are followed by two of padding. */
typedef struct SDL_PixelFormat {
    SDL_Palette *palette;
    Uint8 BitsPerPixel;
    Uint8 BytesPerPixel;
    Uint8 Rloss, Gloss, Bloss, Aloss;
    Uint8 Rshift, Gshift, Bshift, Ashift;
    Uint32 Rmask, Gmask, Bmask, Amask;
    Uint32 colorkey;
    Uint8 alpha;
} SDL_PixelFormat;

/*
 * 60 bytes. pitch IS 16-BIT HERE -- SDL2 widened it to int, and reading it as one would take two
 * bytes of padding with it. The members between pixels and clip_rect, and those after it, exist to
 * place what follows; SDL's own names are kept where they are public.
 */
typedef struct SDL_Surface {
    Uint32 flags;
    SDL_PixelFormat *format;
    int w, h;
    Uint16 pitch;
    void *pixels;
    int offset;
    void *hwdata;
    SDL_Rect clip_rect;
    Uint32 unused1;
    Uint32 locked;
    void *map;
    unsigned int format_version;
    int refcount;
} SDL_Surface;

#define SDL_SWSURFACE   0x00000000
#define SDL_HWSURFACE   0x00000001
#define SDL_OPENGL      0x00000002
#define SDL_RESIZABLE   0x00000010
#define SDL_DOUBLEBUF   0x40000000
#define SDL_FULLSCREEN  0x80000000
#define SDL_SRCCOLORKEY 0x00001000
#define SDL_RLEACCEL    0x00004000
#define SDL_SRCALPHA    0x00010000
#define SDL_ALPHA_OPAQUE 255
#define SDL_ALPHA_TRANSPARENT 0
/* Per-surface alpha. Recorded; a blit that would blend with it is refused until that blend is held
   to SDL's own (ScummVM's on-screen messages are the one user, and only when shown). */
int SDL_SetAlpha(SDL_Surface *surface, Uint32 flag, Uint8 alpha);

SDL_Surface *SDL_SetVideoMode(int width, int height, int bpp, Uint32 flags);
SDL_Surface *SDL_GetVideoSurface(void);
SDL_Surface *SDL_CreateRGBSurface(Uint32 flags, int width, int height, int depth,
                                  Uint32 Rmask, Uint32 Gmask, Uint32 Bmask, Uint32 Amask);
void SDL_FreeSurface(SDL_Surface *surface);
int SDL_LockSurface(SDL_Surface *surface);
void SDL_UnlockSurface(SDL_Surface *surface);
int SDL_Flip(SDL_Surface *screen);
void SDL_UpdateRect(SDL_Surface *screen, Sint32 x, Sint32 y, Uint32 w, Uint32 h);
void SDL_UpdateRects(SDL_Surface *screen, int numrects, SDL_Rect *rects);
int SDL_VideoModeOK(int width, int height, int bpp, Uint32 flags);
SDL_Surface *SDL_CreateRGBSurfaceFrom(void *pixels, int width, int height, int depth, int pitch,
                                      Uint32 Rmask, Uint32 Gmask, Uint32 Bmask, Uint32 Amask);
void SDL_GetRGB(Uint32 pixel, const SDL_PixelFormat * const fmt, Uint8 *r, Uint8 *g, Uint8 *b);
int SDL_UpperBlit(SDL_Surface *src, SDL_Rect *srcrect, SDL_Surface *dst, SDL_Rect *dstrect);
#define SDL_BlitSurface SDL_UpperBlit
int SDL_FillRect(SDL_Surface *dst, SDL_Rect *dstrect, Uint32 color);
int SDL_SaveBMP_RW(SDL_Surface *surface, SDL_RWops *dst, int freedst);
#define SDL_SaveBMP(surface, file) SDL_SaveBMP_RW(surface, SDL_RWFromFile(file, "wb"), 1)
typedef enum { SDL_GRAB_QUERY = -1, SDL_GRAB_OFF = 0, SDL_GRAB_ON = 1, SDL_GRAB_FULLSCREEN } SDL_GrabMode;
SDL_GrabMode SDL_WM_GrabInput(SDL_GrabMode mode);
int SDL_SetColors(SDL_Surface *surface, SDL_Color *colors, int firstcolor, int ncolors);
int SDL_SetColorKey(SDL_Surface *surface, Uint32 flag, Uint32 key);
Uint32 SDL_MapRGB(const SDL_PixelFormat *format, Uint8 r, Uint8 g, Uint8 b);
Uint32 SDL_MapRGBA(const SDL_PixelFormat *format, Uint8 r, Uint8 g, Uint8 b, Uint8 a);
int SDL_ShowCursor(int toggle);
void SDL_WM_SetCaption(const char *title, const char *icon);
void SDL_WM_SetIcon(SDL_Surface *icon, Uint8 *mask);
int SDL_WM_ToggleFullScreen(SDL_Surface *surface);
/* There is no window manager to iconify to: 0, as SDL answers where it cannot. */
int SDL_WM_IconifyWindow(void);

/* An OpenGL display: SDL_SetVideoMode with SDL_OPENGL makes the context, and this pair is all a
   program then asks of SDL about it. */
typedef enum {
    SDL_GL_RED_SIZE, SDL_GL_GREEN_SIZE, SDL_GL_BLUE_SIZE, SDL_GL_ALPHA_SIZE, SDL_GL_BUFFER_SIZE,
    SDL_GL_DOUBLEBUFFER, SDL_GL_DEPTH_SIZE, SDL_GL_STENCIL_SIZE
} SDL_GLattr;
int SDL_GL_SetAttribute(SDL_GLattr attr, int value);
void SDL_GL_SwapBuffers(void);
void *SDL_GL_GetProcAddress(const char *proc);

/*
 * SDLKey is an ENUM, four bytes wide, and SDL2 renamed it SDL_Keycode -- which is what made a
 * program compiled against 1.2 fail to parse when it was handed SDL2's header. The values below are
 * the ones this corpus names, read from the real headers: the printable keys are their ASCII codes
 * and the rest are not, which is exactly the part that cannot be guessed.
 */
typedef enum {
    SDLK_UNKNOWN = 0,
    SDLK_BACKSPACE = 8, SDLK_TAB = 9, SDLK_RETURN = 13,
    SDLK_ESCAPE = 27,
    SDLK_SPACE = 32, SDLK_PLUS = 43, SDLK_COMMA = 44, SDLK_EQUALS = 61, SDLK_MINUS = 45, SDLK_PERIOD = 46, SDLK_SLASH = 47,
    SDLK_0 = 48, SDLK_9 = 57, SDLK_z = 122, SDLK_DELETE = 127,
    SDLK_1 = 49, SDLK_2 = 50, SDLK_3 = 51, SDLK_4 = 52,
    SDLK_a = 97, SDLK_d = 100, SDLK_i = 105, SDLK_j = 106, SDLK_l = 108, SDLK_w = 119,
    SDLK_KP0 = 256, SDLK_KP1 = 257, SDLK_KP2 = 258, SDLK_KP3 = 259, SDLK_KP4 = 260,
    SDLK_KP5 = 261, SDLK_KP6 = 262, SDLK_KP7 = 263, SDLK_KP8 = 264, SDLK_KP9 = 265,
    SDLK_KP_PERIOD = 266, SDLK_KP_DIVIDE = 267, SDLK_KP_MULTIPLY = 268, SDLK_KP_MINUS = 269,
    SDLK_KP_PLUS = 270, SDLK_KP_ENTER = 271, SDLK_KP_EQUALS = 272,
    SDLK_UP = 273, SDLK_DOWN = 274, SDLK_RIGHT = 275, SDLK_LEFT = 276,
    SDLK_INSERT = 277, SDLK_HOME = 278, SDLK_END = 279, SDLK_PAGEUP = 280, SDLK_PAGEDOWN = 281,
    SDLK_F1 = 282, SDLK_F2 = 283, SDLK_F3 = 284, SDLK_F4 = 285, SDLK_F5 = 286, SDLK_F6 = 287,
    SDLK_F7 = 288, SDLK_F8 = 289, SDLK_F9 = 290, SDLK_F10 = 291, SDLK_F11 = 292, SDLK_F12 = 293,
    SDLK_F13 = 294, SDLK_F14 = 295, SDLK_F15 = 296,
    SDLK_NUMLOCK = 300, SDLK_CAPSLOCK = 301, SDLK_SCROLLOCK = 302,
    SDLK_RSHIFT = 303, SDLK_LSHIFT = 304, SDLK_RCTRL = 305, SDLK_LCTRL = 306,
    SDLK_RALT = 307, SDLK_LALT = 308, SDLK_RMETA = 309, SDLK_LMETA = 310,
    SDLK_EURO = 321,
    SDLK_LAST = 323
} SDLKey;

/* The modifiers held when a key event was made: ScummVM reads them (Alt+Enter, Ctrl+key). */
typedef enum {
    KMOD_NONE = 0x0000, KMOD_LSHIFT = 0x0001, KMOD_RSHIFT = 0x0002, KMOD_LCTRL = 0x0040, KMOD_RCTRL = 0x0080,
    KMOD_LALT = 0x0100, KMOD_RALT = 0x0200, KMOD_LMETA = 0x0400, KMOD_RMETA = 0x0800,
    KMOD_NUM = 0x1000, KMOD_CAPS = 0x2000, KMOD_MODE = 0x4000, KMOD_RESERVED = 0x8000
} SDLMod;
#define KMOD_CTRL  (KMOD_LCTRL|KMOD_RCTRL)
#define KMOD_SHIFT (KMOD_LSHIFT|KMOD_RSHIFT)
#define KMOD_ALT   (KMOD_LALT|KMOD_RALT)
#define KMOD_META  (KMOD_LMETA|KMOD_RMETA)
SDLMod SDL_GetModState(void);

typedef struct SDL_keysym {
    Uint8 scancode;
    SDLKey sym;
    SDLMod mod;
    Uint16 unicode;
} SDL_keysym;

#define SDL_RELEASED 0
#define SDL_PRESSED  1

#define SDL_KEYDOWN          2
#define SDL_KEYUP            3
#define SDL_MOUSEMOTION      4
#define SDL_MOUSEBUTTONDOWN  5
#define SDL_MOUSEBUTTONUP    6
#define SDL_JOYAXISMOTION    7
#define SDL_JOYBUTTONDOWN   10
#define SDL_JOYBUTTONUP     11
#define SDL_QUIT            12
#define SDL_VIDEORESIZE     16
#define SDL_VIDEOEXPOSE     17

#define SDL_QUERY   -1
#define SDL_IGNORE   0
#define SDL_DISABLE  0
#define SDL_ENABLE   1

#define SDL_DEFAULT_REPEAT_DELAY    500
#define SDL_DEFAULT_REPEAT_INTERVAL 30

/* Every event begins with a Uint8 type -- a Uint32 in SDL2, which is the other silent difference. */
typedef struct SDL_KeyboardEvent {
    Uint8 type;
    Uint8 which;
    Uint8 state;
    SDL_keysym keysym;
} SDL_KeyboardEvent;

typedef struct SDL_MouseMotionEvent {
    Uint8 type;
    Uint8 which;
    Uint8 state;
    Uint16 x, y;
    Sint16 xrel, yrel;
} SDL_MouseMotionEvent;

typedef struct SDL_MouseButtonEvent {
    Uint8 type;
    Uint8 which;
    Uint8 button;
    Uint8 state;
    Uint16 x, y;
} SDL_MouseButtonEvent;

typedef struct SDL_JoyAxisEvent {
    Uint8 type;
    Uint8 which;
    Uint8 axis;
    Sint16 value;
} SDL_JoyAxisEvent;

typedef struct SDL_JoyButtonEvent {
    Uint8 type;
    Uint8 which;
    Uint8 button;
    Uint8 state;
} SDL_JoyButtonEvent;

typedef struct SDL_ExposeEvent {
    Uint8 type;
} SDL_ExposeEvent;

typedef struct SDL_QuitEvent {
    Uint8 type;
} SDL_QuitEvent;

typedef struct SDL_ResizeEvent {
    Uint8 type;
    int w;
    int h;
} SDL_ResizeEvent;

/* 20 bytes, which the keyboard member is what decides. */
typedef union SDL_Event {
    Uint8 type;
    SDL_KeyboardEvent key;
    SDL_MouseMotionEvent motion;
    SDL_MouseButtonEvent button;
    SDL_JoyAxisEvent jaxis;
    SDL_JoyButtonEvent jbutton;
    SDL_ResizeEvent resize;
    SDL_ExposeEvent expose;
    SDL_QuitEvent quit;
} SDL_Event;

int SDL_PollEvent(SDL_Event *event);
int SDL_WaitEvent(SDL_Event *event);
int SDL_EnableUNICODE(int enable);
int SDL_EnableKeyRepeat(int delay, int interval);
Uint8 *SDL_GetKeyState(int *numkeys);

#define SDL_BUTTON(X)     (1 << ((X) - 1))
#define SDL_BUTTON_LEFT   1
#define SDL_BUTTON_MIDDLE 2
#define SDL_BUTTON_RIGHT  3
#define SDL_BUTTON_WHEELUP   4
#define SDL_BUTTON_WHEELDOWN 5

Uint8 SDL_GetMouseState(int *x, int *y);
void SDL_WarpMouse(Uint16 x, Uint16 y);

struct _SDL_Joystick;
typedef struct _SDL_Joystick SDL_Joystick;
int SDL_NumJoysticks(void);
SDL_Joystick *SDL_JoystickOpen(int device_index);
void SDL_JoystickClose(SDL_Joystick *joystick);
Sint16 SDL_JoystickGetAxis(SDL_Joystick *joystick, int axis);
Uint8 SDL_JoystickGetButton(SDL_Joystick *joystick, int button);
const char *SDL_JoystickName(int device_index);

void SDL_LockAudio(void);
void SDL_UnlockAudio(void);
void SDL_PauseAudio(int pause_on);
void SDL_CloseAudio(void);

#endif
`;

/* SDL_mixer is not here: it is its own library and did not change across the two SDL majors for
   the entry points these programs use, so src/env/sdlmixer.js supplies it to both environments. */
export const SDL12_HEADERS = {
  'SDL.h': SDL_MAIN_12,
  'SDL/SDL.h': SDL_MAIN_12,
  'SDL_stdinc.h': SDL_STDINC_12,
  'SDL_endian.h': SDL_ENDIAN_12,
  // Older programs include it by this name; in SDL 1.2 it only includes SDL_endian.h.
  'SDL_byteorder.h': '#include "SDL_endian.h"\n',
  'SDL_mutex.h': SDL_MUTEX_12,
  'SDL_thread.h': SDL_THREAD_12,
};
