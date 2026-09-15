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
    WID(SDL_PixelFormat, BitsPerPixel); WID(SDL_PixelFormat, colorkey); WID(SDL_PixelFormat, alpha);
    WID(SDL_Color, r); WID(SDL_Rect, x); WID(SDL_Rect, w);

    VAL(SDL_INIT_TIMER); VAL(SDL_INIT_AUDIO); VAL(SDL_INIT_VIDEO); VAL(SDL_INIT_JOYSTICK);
    VAL(SDL_SWSURFACE); VAL(SDL_HWSURFACE); VAL(SDL_DOUBLEBUF);
    VAL(SDL_SRCCOLORKEY);
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
    VAL(SDLK_LAST);

    VAL(MIX_DEFAULT_FORMAT);
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
  console.error('the oracle could not build the probe against the real SDL 1.2 headers:\n' +
    `${real.stderr || real.stdout}\n` +
    'The container needs libsdl1.2-dev:  docker exec prism-oracle apt-get -y install libsdl1.2-dev');
  process.exit(2);
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
