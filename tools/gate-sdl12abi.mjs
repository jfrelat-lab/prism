// gate-sdl12abi.mjs — PRISM's SDL 1.2 declarations against the real ones. Bar: exact, every line.
//
//   node tools/gate-sdl12abi.mjs
//
// src/env/headers-sdl12.js declares SDL 1.2 itself, because the guest is compiled against PRISM's
// headers rather than against a copy of SDL's. That makes the layout PRISM's responsibility, and it
// is the kind of responsibility that fails silently: corpus/jumpnbump-sdl12 reads surface->pixels
// and surface->pitch directly, so a field at the wrong offset is corrupted graphics, never an error
// message. Two of the numbers are exactly the sort that do not survive being written from memory --
// pitch is Uint16 in 1.2 and int in SDL2, and SDL_Event's type is Uint8 in 1.2 and Uint32 in SDL2.
//
// ONE PROBE, TWO COMPILERS. The same C source is built by a real i386 gcc against the genuine
// headers (libsdl1.2-dev, in the oracle container) and by PRISM against ours, and the two outputs
// are diffed line by line. Neither side is asked to agree with a number written down here: they are
// asked to agree with each other, which is what makes a wrong declaration fail this gate.
//
// The probe only touches what BOTH header sets have. Ours declares the subset the corpus asks for,
// which is the rule everywhere in src/env -- a shim grows when a program needs it, not before.

import { compileRun, version } from './oracle.mjs';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';
import { envHeaders } from '../src/env/registry.js';
import { installStdio } from '../src/env/stdio.js';
import { skip } from './gate-skip.mjs';

const PROBE = `
#include <stdio.h>
#include "SDL.h"
#include "SDL_mixer.h"

#define SZ(t)      printf("sizeof %s = %u\\n", #t, (unsigned)sizeof(t))
#define OFF(t, f)  printf("offsetof %s.%s = %u\\n", #t, #f, (unsigned)__builtin_offsetof(t, f))
#define VAL(k)     printf("value %s = %d\\n", #k, (int)(k))
/*
 * The WIDTH of a member, which offsetof cannot see and which matters as much as its place: pitch is
 * Uint16 in SDL 1.2 and int in SDL2, and because two bytes of padding follow it either way, both
 * spellings put pixels at 20. Checking offsets alone let a deliberately widened pitch pass -- the
 * positive control for this gate found that, which is what a positive control is for.
 */
#define WID(t, f)  printf("width %s.%s = %u\\n", #t, #f, (unsigned)sizeof(((t *)0)->f))

int main(void)
{
    SZ(SDL_Surface); SZ(SDL_PixelFormat); SZ(SDL_Color); SZ(SDL_Rect);
    SZ(SDL_Event); SZ(SDL_keysym); SZ(SDLKey);

    OFF(SDL_Surface, flags);  OFF(SDL_Surface, format); OFF(SDL_Surface, w);
    OFF(SDL_Surface, h);      OFF(SDL_Surface, pitch);  OFF(SDL_Surface, pixels);
    OFF(SDL_Surface, clip_rect); OFF(SDL_Surface, refcount);
    WID(SDL_Surface, flags); WID(SDL_Surface, format); WID(SDL_Surface, w); WID(SDL_Surface, h);
    WID(SDL_Surface, pitch); WID(SDL_Surface, pixels); WID(SDL_Surface, refcount);

    OFF(SDL_PixelFormat, palette); OFF(SDL_PixelFormat, BitsPerPixel);
    OFF(SDL_PixelFormat, BytesPerPixel); OFF(SDL_PixelFormat, Rmask);
    OFF(SDL_PixelFormat, Gmask); OFF(SDL_PixelFormat, Bmask); OFF(SDL_PixelFormat, Amask);
    OFF(SDL_PixelFormat, colorkey); OFF(SDL_PixelFormat, alpha);

    OFF(SDL_Palette, ncolors); OFF(SDL_Palette, colors);

    OFF(SDL_Event, type);
    OFF(SDL_Event, key.state); OFF(SDL_Event, key.keysym);
    OFF(SDL_Event, key.keysym.sym); OFF(SDL_Event, key.keysym.unicode);
    OFF(SDL_Event, button.button); OFF(SDL_Event, button.state);
    OFF(SDL_Event, button.x); OFF(SDL_Event, button.y);
    WID(SDL_Event, type); WID(SDL_Event, key.keysym.sym); WID(SDL_Event, key.keysym.unicode);
    WID(SDL_Event, button.button);
    OFF(SDL_Event, motion.state); OFF(SDL_Event, motion.x); OFF(SDL_Event, motion.y);
    OFF(SDL_Event, motion.xrel); OFF(SDL_Event, motion.yrel);
    OFF(SDL_Event, resize.w); OFF(SDL_Event, resize.h);
    WID(SDL_Event, motion.x); WID(SDL_Event, motion.xrel); WID(SDL_Event, resize.w);
    WID(SDL_PixelFormat, BitsPerPixel); WID(SDL_PixelFormat, colorkey); WID(SDL_PixelFormat, alpha);
    WID(SDL_Color, r); WID(SDL_Rect, x); WID(SDL_Rect, w);

    VAL(SDL_INIT_TIMER); VAL(SDL_INIT_AUDIO); VAL(SDL_INIT_VIDEO); VAL(SDL_INIT_JOYSTICK);
    VAL(SDL_SWSURFACE); VAL(SDL_HWSURFACE); VAL(SDL_DOUBLEBUF);
    VAL(SDL_SRCCOLORKEY); VAL(SDL_SRCALPHA); VAL(SDL_RLEACCEL); VAL(SDL_ALPHA_OPAQUE); VAL(SDL_ALPHA_TRANSPARENT);
    VAL(SDL_COMPILEDVERSION); VAL(SDL_VERSION_ATLEAST(1, 2, 6)); VAL(SDL_VERSION_ATLEAST(1, 3, 0)); VAL(sizeof(SDL_TimerID)); VAL(sizeof(SDL_bool)); VAL(SDL_TRUE);
    VAL(SDL_INIT_NOPARACHUTE); VAL(SDL_OPENGL); VAL(SDL_RESIZABLE);
    VAL(SDL_GL_DOUBLEBUFFER); VAL(SDL_GL_DEPTH_SIZE); VAL(SDL_GL_STENCIL_SIZE); SZ(SDL_GLattr);
    VAL(SDL_MOUSEMOTION); VAL(SDL_VIDEORESIZE); VAL(SDL_QUIT);
    VAL(SDL_DEFAULT_REPEAT_DELAY); VAL(SDL_DEFAULT_REPEAT_INTERVAL);
    VAL(AUDIO_U8); VAL(AUDIO_S16LSB); VAL(AUDIO_S16); VAL(AUDIO_S16SYS);
    VAL(SDL_KEYDOWN); VAL(SDL_KEYUP); VAL(SDL_MOUSEBUTTONDOWN); VAL(SDL_MOUSEBUTTONUP);
    VAL(SDL_PRESSED); VAL(SDL_RELEASED);
    VAL(SDL_BUTTON_LEFT); VAL(SDL_BUTTON_MIDDLE); VAL(SDL_BUTTON_RIGHT);
    VAL(SDL_BUTTON(1)); VAL(SDL_BUTTON(2)); VAL(SDL_BUTTON(3));

    VAL(SDLK_ESCAPE);
    VAL(SDLK_1); VAL(SDLK_2); VAL(SDLK_3); VAL(SDLK_4);
    VAL(SDLK_a); VAL(SDLK_d); VAL(SDLK_i); VAL(SDLK_j); VAL(SDLK_l); VAL(SDLK_w);
    VAL(SDLK_KP4); VAL(SDLK_KP6); VAL(SDLK_KP8);
    VAL(SDLK_UP); VAL(SDLK_RIGHT); VAL(SDLK_LEFT);
    VAL(SDLK_F10); VAL(SDLK_F12);
    VAL(SDLK_UNKNOWN);
    VAL(SDLK_KP0); VAL(SDLK_KP1); VAL(SDLK_KP2); VAL(SDLK_KP3); VAL(SDLK_KP5); VAL(SDLK_KP7); VAL(SDLK_KP9);
    VAL(SDLK_KP_PERIOD); VAL(SDLK_KP_DIVIDE); VAL(SDLK_KP_MULTIPLY); VAL(SDLK_KP_MINUS);
    VAL(SDLK_KP_PLUS); VAL(SDLK_KP_ENTER); VAL(SDLK_KP_EQUALS);
    VAL(SDLK_DOWN); VAL(SDLK_INSERT); VAL(SDLK_HOME); VAL(SDLK_END); VAL(SDLK_PAGEUP); VAL(SDLK_PAGEDOWN);
    VAL(SDLK_F1); VAL(SDLK_F2); VAL(SDLK_F3); VAL(SDLK_F4); VAL(SDLK_F5); VAL(SDLK_F6); VAL(SDLK_F7);
    VAL(SDLK_F8); VAL(SDLK_F9); VAL(SDLK_F11); VAL(SDLK_F13); VAL(SDLK_F14); VAL(SDLK_F15);
    VAL(SDLK_NUMLOCK); VAL(SDLK_CAPSLOCK); VAL(SDLK_SCROLLOCK);
    VAL(SDLK_RSHIFT); VAL(SDLK_LSHIFT); VAL(SDLK_RCTRL); VAL(SDLK_LCTRL);
    VAL(SDLK_RALT); VAL(SDLK_LALT); VAL(SDLK_RMETA); VAL(SDLK_LMETA);
    VAL(SDLK_LAST);

    /* What ScummVM 0.6.1's SDL backend asked for. */
    SZ(SDL_AudioSpec); OFF(SDL_AudioSpec, freq); OFF(SDL_AudioSpec, format); OFF(SDL_AudioSpec, channels);
    OFF(SDL_AudioSpec, silence); OFF(SDL_AudioSpec, samples); OFF(SDL_AudioSpec, size);
    OFF(SDL_AudioSpec, callback); OFF(SDL_AudioSpec, userdata);
    WID(SDL_AudioSpec, format); WID(SDL_AudioSpec, channels); WID(SDL_AudioSpec, samples); WID(SDL_AudioSpec, size);
    SZ(SDL_CD); SZ(SDL_CDtrack); OFF(SDL_CD, status); OFF(SDL_CD, numtracks); OFF(SDL_CD, cur_frame); OFF(SDL_CD, track);
    OFF(SDL_CDtrack, length); OFF(SDL_CDtrack, offset); SZ(CDstatus);
    VAL(CD_TRAYEMPTY); VAL(CD_STOPPED); VAL(CD_PLAYING); VAL(CD_PAUSED); VAL(CD_ERROR); VAL(CD_FPS); VAL(SDL_INIT_CDROM);
    OFF(SDL_Event, jaxis.axis); OFF(SDL_Event, jaxis.value); OFF(SDL_Event, jbutton.button); OFF(SDL_Event, jbutton.state);
    WID(SDL_Event, jaxis.value);
    VAL(SDL_JOYAXISMOTION); VAL(SDL_JOYBUTTONDOWN); VAL(SDL_JOYBUTTONUP); VAL(SDL_VIDEOEXPOSE);
    VAL(SDL_BUTTON_WHEELUP); VAL(SDL_BUTTON_WHEELDOWN);
    VAL(SDL_GRAB_QUERY); VAL(SDL_GRAB_OFF); VAL(SDL_GRAB_ON); SZ(SDL_GrabMode);
    VAL(SDL_QUERY); VAL(SDL_IGNORE); VAL(SDL_DISABLE); VAL(SDL_ENABLE);
    SZ(SDLMod); OFF(SDL_Event, key.keysym.mod); WID(SDL_Event, key.keysym.mod);
    VAL(KMOD_LSHIFT); VAL(KMOD_RSHIFT); VAL(KMOD_LCTRL); VAL(KMOD_RCTRL); VAL(KMOD_LALT); VAL(KMOD_RALT);
    VAL(KMOD_LMETA); VAL(KMOD_RMETA); VAL(KMOD_NUM); VAL(KMOD_CAPS);
    VAL(KMOD_CTRL); VAL(KMOD_SHIFT); VAL(KMOD_ALT); VAL(KMOD_META);
    VAL(SDLK_BACKSPACE); VAL(SDLK_TAB); VAL(SDLK_RETURN); VAL(SDLK_SPACE); VAL(SDLK_COMMA); VAL(SDLK_MINUS); VAL(SDLK_PLUS); VAL(SDLK_EQUALS);
    VAL(SDLK_PERIOD); VAL(SDLK_SLASH); VAL(SDLK_0); VAL(SDLK_9); VAL(SDLK_z); VAL(SDLK_DELETE); VAL(SDLK_EURO);

    VAL(MIX_DEFAULT_FORMAT); VAL(MIX_CHANNELS); VAL(MIX_DEFAULT_FREQUENCY); VAL(MIX_DEFAULT_CHANNELS); VAL(MIX_MAX_VOLUME);
    SZ(Mix_Chunk); OFF(Mix_Chunk, allocated); OFF(Mix_Chunk, abuf); OFF(Mix_Chunk, alen); OFF(Mix_Chunk, volume);
    WID(Mix_Chunk, alen); WID(Mix_Chunk, volume);
    return 0;
}
`;

/* SDL_FULLSCREEN is deliberately not in the probe: it is 0x80000000, which printf("%d") renders as
   a negative number on both sides and would compare equal for the wrong reason. It is checked here
   instead, as the unsigned value the header must define. */
const FULLSCREEN_EXPECTED = 0x80000000;

console.log(version().split('\n')[0]);

// --- the reference: a real i386 gcc against the genuine headers.
const real = compileRun(PROBE, { extra: '-I/usr/include/SDL' });
// `code`, not `status`: tools/oracle.mjs's sh() returns { code, stdout, stderr }. Reading the wrong
// name made this branch fire on every run -- and the mirror of that mistake, a check that can only
// pass, is the one that would have let a wrong header through without a word.
if (real.code !== 0) {
  skip(`the oracle could not build the probe against the real SDL 1.2 headers: ${(real.stderr || real.stdout).split('\n')[0]}`,
    'the container needs libsdl1.2-dev:  docker exec prism-oracle apt-get -y install libsdl1.2-dev');
}

// --- ours: the same source, through PRISM, with the sdl12 environment's headers.
const prog = compileProgram([{ file: 'probe.c', source: PROBE }], {
  resolve: builtinHeaderResolver(envHeaders(['sdl12'])),
  memory: 16 * 1024 * 1024,
  collect: true,
});
const out = [];
prog.M.write = (s) => out.push(s);
installStdio(prog.M, { files: {} });
try {
  prog.run(['probe']);
} catch (e) {
  console.error(`PRISM could not run the probe: ${e.message}`);
  process.exit(1);
}

const split = (s) => s.trim().split('\n').map(l => l.trim()).filter(Boolean);
const a = split(real.stdout), b = split(out.join(''));

let bad = 0;
const width = Math.max(...a.map(l => l.split(' = ')[0].length), 20);
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  const [ka = '?', va = ''] = (a[i] ?? '').split(' = ');
  const [kb = '?', vb = ''] = (b[i] ?? '').split(' = ');
  if (ka !== kb) {
    console.log(`  MISMATCHED LINE ${i}: real "${a[i]}" vs PRISM "${b[i]}"`);
    bad++;
    continue;
  }
  if (va !== vb) {
    console.log(`  ${ka.padEnd(width)}  real ${va}   PRISM ${vb}   WRONG`);
    bad++;
  }
}

/* The one value the probe cannot carry, checked by reading the declaration PRISM hands a guest. */
const header = envHeaders(['sdl12'])['SDL.h'] ?? '';
const fs = header.match(/#define\s+SDL_FULLSCREEN\s+(\S+)/);
const fsVal = fs ? Number(fs[1]) : NaN;
if (fsVal !== FULLSCREEN_EXPECTED) {
  console.log(`  SDL_FULLSCREEN  expected 0x${FULLSCREEN_EXPECTED.toString(16)}, header says ${fs?.[1]}`);
  bad++;
}

console.log('');
if (bad) {
  console.log(`${bad} of ${a.length + 1} checks disagree with the real SDL 1.2 headers`);
  process.exit(1);
}
console.log(`PRISM's SDL 1.2 declarations match the real headers exactly: ${a.length + 1} checks`);
