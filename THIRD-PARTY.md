# Third-party code in PRISM

PRISM is under the [MIT licence](LICENSE). Most of its platform layer was written from scratch and
held to the real library by a gate. The places listed here are different: they reproduce part of
another project's **source**, routine by routine. Each one stays under its upstream licence, and
that licence is given here.

No game, game data, emulator source or ROM is in this repository. The programs PRISM compiles are
fetched into `corpus/`, which git ignores; see each `targets/*.json`.

## In the runtime (`src/`)

| File | What | From | Licence |
|---|---|---|---|
| `src/env/glu.js` | The mipmap and scaling routines (`halveImage_ubyte`, `scale_internal`…), the matrix functions (`gluPerspective`, `gluLookAt`, `gluProject`, `gluUnProject`…) and the quadrics (`gluSphere`, `gluCylinder`, `gluDisk`…) | libGLU 9.0 (Mesa), `src/libutil/mipmap.c`, `project.c`, `quad.c` | SGI Free Software License B 2.0, notice below |
| `src/env/sdlmixer.js` | The audio-format conversion filters and their order (`SDL_BuildAudioCVT`, `SDL_Convert*`, `SDL_Rate*2`), and the per-format loop of `SDL_MixAudio` | SDL 1.2.15, `src/audio/SDL_audiocvt.c`, `src/audio/SDL_mixer.c` | **LGPL-2.1**: those routines, in that file, are under the LGPL, not MIT |
| `src/env/sdlmixer.js` | Channel mixing and panning (`mix_channels`, `_Eff_position_s16lsb`) | SDL_mixer 1.2.12, `mixer.c`, `effect_position.c` | zlib licence |
| `src/env/sdl2-surface.js` | The clipping of `SDL_UpperBlit` | SDL 2, `src/video/SDL_surface.c` | zlib licence |
| `src/env/sdl12.js` | The key-name strings of `SDL_GetKeyName` | SDL 1.2, `src/events/SDL_keyboard.c` | LGPL-2.1 |
| `src/runtime/runtime.js` | `rand`/`random`: the additive-feedback generator and its seeding | 4.3BSD `random(3)`, as glibc and DJGPP's libc carry it | BSD (algorithm), glibc LGPL-2.1 |
| `src/runtime/runtime.js`, `src/asm/pragma-aux.js` | `FixedMul`, `FixedDiv2`: the instruction sequences of Heretic and Hexen's `#pragma aux` | Raven's `DOOMDEF.H` | GPL-2.0 (a few instructions) |

Interface facts (constant values, struct layouts, prototypes) of OpenGL, GLUT, SDL, Win32, DJGPP,
Watcom, svgalib and Allegro are written from the documentation. They are checked against the real
headers by gates and are not copies of those headers.

## In the tools and tests (`tools/`, `tests/`)

These files are built only with the program they serve, and never become part of PRISM's runtime.

| File | What | From | Licence |
|---|---|---|---|
| `tools/quake-dos-vars.c` | `VGA_UpdateLinearScreen` | Quake, `d_copy.s` | GPL-2.0 |
| `tools/mamediff/osdnull34.c` | `osd_new_bitmap`, `osd_allocate_colors`, `adjust_display` | MAME 0.34, `src/msdos/video.c` | MAME licence (non-commercial) |
| `tests/zlib/probe.c` | The inflate loop | MAME 0.37b5, `src/unzip.c` | MAME licence (non-commercial) |
| `tools/lzexe.mjs` | The LZ91 decompressor | UNLZEXE, `unlzexe.c` | freeware, no stated licence |

## Data

`assets/vga-rom-8x16.bin` is the IBM VGA 8x16 text font. It was rebuilt from glyphs rendered by
DOSBox, not copied from a ROM file (see `assets/README.md`).

## SGI Free Software License B 2.0

Applies to the parts of `src/env/glu.js` listed above.

```
SGI FREE SOFTWARE LICENSE B (Version 2.0, Sept. 18, 2008)
Copyright (C) 1991-2000 Silicon Graphics, Inc. All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice including the dates of first publication and
either this permission notice or a reference to
http://oss.sgi.com/projects/FreeB/
shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
SILICON GRAPHICS, INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF
OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Except as contained in this notice, the name of Silicon Graphics, Inc.
shall not be used in advertising or otherwise to promote the sale, use or
other dealings in this Software without prior written authorization from
Silicon Graphics, Inc.
```
