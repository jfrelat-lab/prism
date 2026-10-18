# PRISM

[![gates](https://github.com/jfrelat-lab/prism/actions/workflows/gates.yml/badge.svg)](https://github.com/jfrelat-lab/prism/actions/workflows/gates.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A C and C++ compiler that targets JavaScript and is itself written in plain JavaScript. It compiles
the unmodified source of games and emulators from the DOS, Windows 95 and early Linux era — MAME,
Quake, Doom, ScummVM, Keen Dreams — and runs them in a browser tab or in Node.**

No WebAssembly, no build step, no dependencies. The compiler runs in the page.

**Try it: [prism-compiler.pages.dev](https://prism-compiler.pages.dev)** — the games, compiled and
playing in the tab, and [Live C](https://prism-compiler.pages.dev/web/live/): type C or C++ (console,
GLUT, SDL, X11 or Win32) and run it, or load one of Rosetta Code's solutions.

<table>
<tr>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/doom.png" width="200" alt="DOOM (shareware), compiled by PRISM"></a><br><sub><b>DOOM (shareware)</b><br>Linux · plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/monkey.png" width="200" alt="The Secret of Monkey Island (demo), compiled by PRISM"></a><br><sub><b>The Secret of Monkey Island (demo)</b><br>Linux · plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/quake3.png" width="200" alt="Quake III Arena, compiled by PRISM"></a><br><sub><b>Quake III Arena</b><br>Linux · your copy</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/tuxracer.png" width="200" alt="Tux Racer, compiled by PRISM"></a><br><sub><b>Tux Racer</b><br>Linux · plays now</sub></td>
</tr>
<tr>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/bass.png" width="200" alt="Beneath a Steel Sky, compiled by PRISM"></a><br><sub><b>Beneath a Steel Sky</b><br>Linux · plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/mame-dkong.png" width="200" alt="Donkey Kong, compiled by PRISM"></a><br><sub><b>Donkey Kong</b><br>DOS · your copy</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/cube.png" width="200" alt="Cube, compiled by PRISM"></a><br><sub><b>Cube</b><br>Linux · plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/dott.png" width="200" alt="Day of the Tentacle (demo), compiled by PRISM"></a><br><sub><b>Day of the Tentacle (demo)</b><br>Linux · plays now</sub></td>
</tr>
<tr>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/sdlpop.png" width="200" alt="Prince of Persia (SDLPoP), compiled by PRISM"></a><br><sub><b>Prince of Persia (SDLPoP)</b><br>Linux · your copy</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/heretic.png" width="200" alt="Heretic (shareware), compiled by PRISM"></a><br><sub><b>Heretic (shareware)</b><br>DOS · plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/chromium-bsu.png" width="200" alt="Chromium B.S.U., compiled by PRISM"></a><br><sub><b>Chromium B.S.U.</b><br>Linux · plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/hexen2.png" width="200" alt="Hexen II, compiled by PRISM"></a><br><sub><b>Hexen II</b><br>Windows · your copy</sub></td>
</tr>
</table>

<sub>Every picture is a frame PRISM drew from the game's unmodified source; click to open the showcase.</sub>

```
 C / C++ / asm source ─▶ preprocessor ─▶ parser + sema ─▶ JavaScript source ─▶ the engine's own JIT ─▶ run
                         (gcc -E exact)   (i386 or 16-bit       (readable, one function
                                           DOS ABI, exact)        per C function)
```

The game is not ported. Its source compiles as it shipped, and the platform it was written for
is supplied in JavaScript underneath it. That platform covers:
- libc and POSIX;
- DOS (DJGPP, Watcom, Borland C++ 2.0 with real 16-bit segmentation);
- Allegro, X11, svgalib, SunOS, Win32 with Winsock;
- SDL 1.2 and SDL 2, SDL_mixer, SDL_image;
- OpenGL 1.x with GLU, GLUT, GLX and WGL, drawn through WebGL.

Nothing in a game's tree is edited. Build switches the tree already has are configuration, not
modification.

PRISM has a sibling, MIRAGE, which recompiles a
program's x86 **binary**. MIRAGE needs a binary and no source; PRISM needs published source and no
binary.

## What it compiles

- **C89/C99 with the GNU extensions** that real code uses, for two ABIs:
  - i386 System V, flat 32-bit;
  - 16-bit real-mode DOS (small, medium and large models), with `far`, `_seg` and `huge` pointers.
- **A C++98 subset**, enough for ScummVM, Enemy Territory, Chromium B.S.U. and Tux Racer. It is lowered to C. It covers:
  - classes, virtual and multiple inheritance, templates;
  - exceptions on setjmp/longjmp;
  - the parts of the standard library those programs use.
- **A program's own assembly is translated from its source, not emulated.** PRISM has no CPU. It
  handles Borland inline `asm`, whole TASM modules, Watcom `#pragma aux` and NASM.

## What runs today

Per-program status, and what each one is checked against, is in
[docs/COMPAT.md](docs/COMPAT.md). None of that software is in this repository; see
[Third-party software](#third-party-software).

| | Reaches |
|---|---|
| **MAME** 0.34 (DJGPP, Allegro, SEAL); 0.1 to 0.7 before it | 15 of 15 games bit-identical to a native gcc build over 1,500 frames |
| **Quake**: DOS, X11, svgalib, SunOS, Win32; **GLQuake** | the same pixels on four platform layers; GLQuake within 1 pixel of 307,200 of Mesa |
| **Quake II** (software and GL), **Quake III Arena**, **Enemy Territory** | play; Quake II GL within 3 pixels of Mesa |
| **Doom**, **Heretic**, **Hexen**, **Hexen II** | play; Doom with its sound server as a second process |
| **ScummVM** 0.6.1 and 0.10.0, thirteen engines | 3,000 of 3,000 frames and every audio buffer equal to a native g++ build, for each of 20 game demos |
| **Keen Dreams** (16-bit Borland C++ and TASM) | plays; its screens are the shipped KDREAMS.EXE's under DOSBox-X |
| **OpenDUNE**, **Jump 'n Bump**, **SDLPoP**, **OpenTyrian**, **Tux Racer**, **Cube**, **Chromium B.S.U.** | play; most are pinned to a reference build |
| **Lua 5.4**, **PuTTY**, **SQLite**, Tcl 8.4 | their own test suites, or gcc's output |

**What does not work yet:**
- Catacomb 3-D builds but does not run, because it generates code at run time.
- Several programs have no picture reference yet (Quake III, Enemy Territory, Tux Racer, Hexen II).
- Some sound paths are unmeasured.
- There is no optimiser: the compiler emits one literal JavaScript translation of each function.
  [docs/ROADMAP.md](docs/ROADMAP.md) lists what is open.

## How fast

Tier-0 output is about **9.5× slower than `clang -O2` native** on the same benchmark. That is enough
for the games above: Quake's own timedemo reports several hundred frames a second. In the browser,
with the WebGL backend, Cube runs at about 145 fps and Enemy Territory at about 30 fps in a map.

## Quick start

Node 22. The upstream sources are not in the repository. Each `targets/*.json` has a `fetch` line
saying where its source comes from and where to unpack it under `corpus/`, which git ignores.

```bash
git clone --depth 1 -b v5.4.7 https://github.com/lua/lua.git corpus/lua   # targets/lua.json's fetch line
node tools/build.mjs targets/lua.json --run "--args=-e print(6*7)"         # compiles Lua, prints 42
node tools/build.mjs --list                                                 # every target and variant
node tools/serve.mjs --data=/path/to/your/game/files                        # the browser shell
```

Open the printed URL, pick a program, give it its data files and press **Run**. The shell compiles
the program in a worker. It shows a text screen until the program opens a display, then the
display. Each program is a descriptor in `web/programs/*.json`. The dev server exists because
`SharedArrayBuffer` needs the COOP/COEP headers. The page loads `src/` as plain ES modules, so the
browser runs the same files the Node gates run.

**Live C** (`web/live/`) is the part that needs nothing else: type C or C++ and run it in the page,
with the emitted JavaScript beside it. It works from any static host; on one that does not send the
COOP/COEP headers (GitHub Pages), `web/coi-sw.js` adds them. The repository's `index.html` is
the project page for GitHub Pages and links to it.

**A static showcase.** `node tools/site.mjs` writes `site/`, a copy of the shelf that needs no
server, and `index.html` turns into its catalogue. The programs are listed in
`tools/site-programs.json`:

- the ones it **ships** have code and data that may be passed on (or, for a few, a stated caution);
- its **gallery** holds the ones whose data is not ours to pass on. The page asks the visitor for
  their copy, a folder or a `.zip`, and reads it where it is.

Each program ships as a precompiled bundle (`tools/bundle.mjs`, kept between runs in
`dist/site-bundles/`), with its licences and the **source it was built from**. Every source tree it
reads is archived as published, beside the build scripts (`sources/`, or a release of
`jfrelat-lab/prism-sources` with `--sources=release` and `tools/publish-sources.mjs`).

Before putting an export on a host, check it with `tools/site-check.mjs` (file sizes, data that must
not be there, sources and licences present). Any static host serves it, under any path; the
COOP/COEP headers come from `_headers`, or from `web/coi-sw.js` where the host sends none.
`site/` holds game data and is never committed.

- `node tools/serve.mjs --site --games=<dir>` serves the export as a **local library**: the gallery
  games found in `<dir>` say *your copy* and play from it.
- `node tools/standalone.mjs <id>` writes **one** program as a folder for anyone's own site, with a
  page of its own and `HOSTING.txt`.
- `tools/site-thumbs.mjs` draws the thumbnails.

**The visitor's language, calendar and keyboard.** In the page, a program that can be told a
language gets the browser's (Beneath a Steel Sky's text in French on a French browser), sees the
real date and the browser's time zone, and reads typed text in the visitor's keyboard layout. Keys
stay positions by default, as game controls expect; *keys: your layout* names them by what the
layout types. The gates keep a fixed date, UTC and US positions. See
[ARCHITECTURE.md](docs/ARCHITECTURE.md#the-visitors-language-calendar-and-keyboard).

**No game data is fetched or stored by this repository.** The page reads only the files you
give it, or a directory you name with `--data`.

## How it is tested

PRISM is checked against other compilers and other machines, never against its own expectations.
`node tools/gates.mjs` runs every gate and reports each as PASS, SKIP or FAIL. A gate that needs
something the repository does not ship (a corpus, game data, the gcc container) reports SKIP, not
FAIL.

| Gate | Reference |
|---|---|
| Preprocessor | `gcc -E`, token for token, including 289 whole translation units |
| i386 layout (`sizeof`, `offsetof`, bitfields) | gcc 12 i386, about 105,000 checks |
| 16-bit layouts and execution | Open Watcom and Borland C++ 2.0, run under DOSBox-X |
| c-testsuite, gcc.c-torture/execute | 0 wrong answers |
| Random programs (csmith) | gcc `-O0` and `-O2` |
| TASM front end; translated TASM routines | Turbo Assembler 2.5's object code; that object code run under Unicorn |
| C++ features | g++, case by case |
| Games | native builds of the same sources (MAME, ScummVM, Quake), Mesa (the GL programs), the shipped DOS binaries under DOSBox-X (Keen Dreams, Dune II, Jump 'n Bump) |
| GLU, SDL_mixer, zlib | libGLU, SDL_mixer 1.2 and gcc-built zlib, to the bit |

Every gate carries a control: a deliberate mutation that it must catch. A gate that cannot fail
proves nothing. The references that need a C compiler run in a `linux/386` gcc container
(`npm run oracle:build`). Gates that compare against one replay committed goldens, so most can run
without it. [docs/TESTING.md](docs/TESTING.md) has the details.

## Documentation

Reference documents describe the present state:

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): the design, the file map, the hard parts. Start here.
- [COMPAT.md](docs/COMPAT.md): what runs, how far, and what holds it there.
- [TESTING.md](docs/TESTING.md): the gates, the oracles, and the measured facts behind the ABIs.
- [ROADMAP.md](docs/ROADMAP.md): what is open, one line per task.

The record is [LOG.md](docs/LOG.md): the long form of every roadmap row up to 2026-09-27, with
the measurements, dead ends and defects found. Later work is recorded in commit messages.

## Third-party software

This repository contains PRISM and the small test programs written for it (`tests/`). It contains no
game, game data, emulator source or ROM. The tools that need them look in `corpus/` (sources) or in a
directory you name (data). Both are ignored by git. Bring your own, and check that you are allowed
to use what you bring.

Some parts of PRISM's runtime reproduce a library's behaviour from that library's source. Those
parts, and their licences, are listed in [THIRD-PARTY.md](THIRD-PARTY.md).

## How it was built

PRISM was written with [Claude Code](https://claude.com/claude-code), Anthropic's coding agent,
directed by Julien Frelat; the commit messages say so. The method is the one above: every claim
about C, about a library or about a picture is checked against an independent implementation.

## License

[MIT](LICENSE), except where [THIRD-PARTY.md](THIRD-PARTY.md) says otherwise. The licence covers PRISM
itself, not the programs you compile with it.
