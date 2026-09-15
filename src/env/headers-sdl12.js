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

/*
 * SDL_mixer is a SEPARATE LIBRARY, not part of SDL, and it is declared here only because this
 * environment is what a program linking `-lSDL -lSDL_mixer` expects to find. Thirteen functions,
 * which is what corpus/jumpnbump-sdl12 calls and nothing more.
 */
const SDL_MIXER_12 = `
#ifndef _SDL_mixer_h
#define _SDL_mixer_h
#define MIX_DEFAULT_FORMAT 0x8010
#define MIX_MAX_VOLUME 128
typedef struct _Mix_Music Mix_Music;
int Mix_OpenAudio(int frequency, Uint16 format, int channels, int chunksize);
void Mix_CloseAudio(void);
int Mix_QuerySpec(int *frequency, Uint16 *format, int *channels);
void Mix_SetPostMix(void (*mix_func)(void *udata, Uint8 *stream, int len), void *arg);
Mix_Music *Mix_LoadMUS(const char *file);
void Mix_FreeMusic(Mix_Music *music);
int Mix_PlayMusic(Mix_Music *music, int loops);
int Mix_VolumeMusic(int volume);
int Mix_HaltMusic(void);
int Mix_FadeOutMusic(int ms);
int Mix_PlayingMusic(void);
int Mix_SetMusicCMD(const char *command);
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
#define SDL_INIT_JOYSTICK 0x00000200
#define SDL_INIT_EVERYTHING 0x0000FFFF

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
#define SDL_DOUBLEBUF   0x40000000
#define SDL_FULLSCREEN  0x80000000
#define SDL_SRCCOLORKEY 0x00001000

SDL_Surface *SDL_SetVideoMode(int width, int height, int bpp, Uint32 flags);
SDL_Surface *SDL_GetVideoSurface(void);
SDL_Surface *SDL_CreateRGBSurface(Uint32 flags, int width, int height, int depth,
                                  Uint32 Rmask, Uint32 Gmask, Uint32 Bmask, Uint32 Amask);
void SDL_FreeSurface(SDL_Surface *surface);
int SDL_LockSurface(SDL_Surface *surface);
void SDL_UnlockSurface(SDL_Surface *surface);
int SDL_Flip(SDL_Surface *screen);
void SDL_UpdateRect(SDL_Surface *screen, Sint32 x, Sint32 y, Uint32 w, Uint32 h);
int SDL_SetColors(SDL_Surface *surface, SDL_Color *colors, int firstcolor, int ncolors);
int SDL_SetColorKey(SDL_Surface *surface, Uint32 flag, Uint32 key);
Uint32 SDL_MapRGB(const SDL_PixelFormat *format, Uint8 r, Uint8 g, Uint8 b);
Uint32 SDL_MapRGBA(const SDL_PixelFormat *format, Uint8 r, Uint8 g, Uint8 b, Uint8 a);
int SDL_ShowCursor(int toggle);
void SDL_WM_SetCaption(const char *title, const char *icon);
void SDL_WM_SetIcon(SDL_Surface *icon, Uint8 *mask);
int SDL_WM_ToggleFullScreen(SDL_Surface *surface);

/*
 * SDLKey is an ENUM, four bytes wide, and SDL2 renamed it SDL_Keycode -- which is what made a
 * program compiled against 1.2 fail to parse when it was handed SDL2's header. The values below are
 * the ones this corpus names, read from the real headers: the printable keys are their ASCII codes
 * and the rest are not, which is exactly the part that cannot be guessed.
 */
typedef enum {
    SDLK_ESCAPE = 27,
    SDLK_1 = 49, SDLK_2 = 50, SDLK_3 = 51, SDLK_4 = 52,
    SDLK_a = 97, SDLK_d = 100, SDLK_i = 105, SDLK_j = 106, SDLK_l = 108, SDLK_w = 119,
    SDLK_KP4 = 260, SDLK_KP6 = 262, SDLK_KP8 = 264,
    SDLK_UP = 273, SDLK_RIGHT = 275, SDLK_LEFT = 276,
    SDLK_F10 = 291, SDLK_F12 = 293,
    SDLK_LAST = 323
} SDLKey;

/* The program never reads a modifier; this is here to be four bytes wide in the right place. */
typedef int SDLMod;

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
#define SDL_QUIT            12

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

typedef struct SDL_QuitEvent {
    Uint8 type;
} SDL_QuitEvent;

/* 20 bytes, which the keyboard member is what decides. */
typedef union SDL_Event {
    Uint8 type;
    SDL_KeyboardEvent key;
    SDL_MouseMotionEvent motion;
    SDL_MouseButtonEvent button;
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

Uint8 SDL_GetMouseState(int *x, int *y);

struct _SDL_Joystick;
typedef struct _SDL_Joystick SDL_Joystick;
int SDL_NumJoysticks(void);
SDL_Joystick *SDL_JoystickOpen(int device_index);
void SDL_JoystickClose(SDL_Joystick *joystick);
Sint16 SDL_JoystickGetAxis(SDL_Joystick *joystick, int axis);
Uint8 SDL_JoystickGetButton(SDL_Joystick *joystick, int button);

void SDL_LockAudio(void);
void SDL_UnlockAudio(void);
void SDL_PauseAudio(int pause_on);
void SDL_CloseAudio(void);

#endif
`;

export const SDL12_HEADERS = {
  'SDL.h': SDL_MAIN_12,
  'SDL/SDL.h': SDL_MAIN_12,
  'SDL_stdinc.h': SDL_STDINC_12,
  'SDL_endian.h': SDL_ENDIAN_12,
  'SDL_mutex.h': SDL_MUTEX_12,
  'SDL_thread.h': SDL_THREAD_12,
  'SDL_mixer.h': SDL_MIXER_12,
};
