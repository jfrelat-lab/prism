# PRISM

[![gates](https://github.com/jfrelat-lab/prism/actions/workflows/gates.yml/badge.svg)](https://github.com/jfrelat-lab/prism/actions/workflows/gates.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Play in your browser](https://img.shields.io/badge/%E2%96%B6%20play-in%20your%20browser-6cb6ff)](https://prism-compiler.pages.dev)

### Quake, Doom, MAME and ScummVM, compiled from their original C and C++ source and playing in your browser tab.

**A C and C++ compiler that targets JavaScript and is itself written in plain JavaScript. It compiles
the unmodified source of games and emulators from the DOS, Windows 95 and early Linux era — MAME,
Quake, Doom, ScummVM, Keen Dreams — and runs them in a browser tab or in Node.**

No WebAssembly, no build step, no dependencies. The compiler runs in the page.

**Try it: [prism-compiler.pages.dev](https://prism-compiler.pages.dev)** — the games, compiled and
playing in the tab, and [Live C](https://prism-compiler.pages.dev/web/live/): type C or C++ (console,
GLUT, SDL, X11 or Win32) and run it, or load one of Rosetta Code's solutions.

<table>
<tr>
<td align="center" width="50%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/media/quake3.gif" alt="Quake III Arena compiled by PRISM, bots on The Longest Yard, in a browser tab"></a><br><sub><b>Quake III Arena</b>, its 1.32 source compiled in the page, drawn through WebGL</sub></td>
<td align="center" width="50%"><a href="https://prism-compiler.pages.dev/web/live/"><img src="https://prism-compiler.pages.dev/media/livec.gif" alt="Live C: an Xlib clock compiled and run in the page, its emitted JavaScript, a Rosetta Code solution loading"></a><br><sub><b>Live C</b>: an Xlib program compiled and run in the page, the JavaScript it became, Rosetta Code's solutions</sub></td>
</tr>
</table>

<table>
<tr>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/web/?machine=linux&amp;program=doom-shareware&amp;run=1&amp;player=1"><img src="https://prism-compiler.pages.dev/thumbs/doom.png" width="200" alt="DOOM (shareware), compiled by PRISM"></a><br><sub><b>DOOM (shareware)</b><br>Linux · ▶ plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/web/?machine=linux&amp;program=scummvm-monkey-demo&amp;run=1&amp;player=1"><img src="https://prism-compiler.pages.dev/thumbs/monkey.png" width="200" alt="The Secret of Monkey Island (demo), compiled by PRISM"></a><br><sub><b>The Secret of Monkey Island (demo)</b><br>Linux · ▶ plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/quake3.png" width="200" alt="Quake III Arena, compiled by PRISM"></a><br><sub><b>Quake III Arena</b><br>Linux · your copy</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/web/?machine=linux&amp;program=tuxracer&amp;run=1&amp;player=1"><img src="https://prism-compiler.pages.dev/thumbs/tuxracer.png" width="200" alt="Tux Racer, compiled by PRISM"></a><br><sub><b>Tux Racer</b><br>Linux · ▶ plays now</sub></td>
</tr>
<tr>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/web/?machine=linux&amp;program=scummvm&amp;run=1&amp;player=1"><img src="https://prism-compiler.pages.dev/thumbs/bass.png" width="200" alt="Beneath a Steel Sky, compiled by PRISM"></a><br><sub><b>Beneath a Steel Sky</b><br>Linux · ▶ plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/mame-dkong.png" width="200" alt="Donkey Kong, compiled by PRISM"></a><br><sub><b>Donkey Kong</b><br>DOS · your copy</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/web/?machine=linux&amp;program=cube&amp;run=1&amp;player=1"><img src="https://prism-compiler.pages.dev/thumbs/cube.png" width="200" alt="Cube, compiled by PRISM"></a><br><sub><b>Cube</b><br>Linux · ▶ plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/web/?machine=linux&amp;program=scummvm-dott-demo&amp;run=1&amp;player=1"><img src="https://prism-compiler.pages.dev/thumbs/dott.png" width="200" alt="Day of the Tentacle (demo), compiled by PRISM"></a><br><sub><b>Day of the Tentacle (demo)</b><br>Linux · ▶ plays now</sub></td>
</tr>
<tr>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/sdlpop.png" width="200" alt="Prince of Persia (SDLPoP), compiled by PRISM"></a><br><sub><b>Prince of Persia (SDLPoP)</b><br>Linux · your copy</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/web/?machine=dos&amp;program=heretic-shareware&amp;run=1&amp;player=1"><img src="https://prism-compiler.pages.dev/thumbs/heretic.png" width="200" alt="Heretic (shareware), compiled by PRISM"></a><br><sub><b>Heretic (shareware)</b><br>DOS · ▶ plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/web/?machine=linux&amp;program=chromium-bsu&amp;run=1&amp;player=1"><img src="https://prism-compiler.pages.dev/thumbs/chromium-bsu.png" width="200" alt="Chromium B.S.U., compiled by PRISM"></a><br><sub><b>Chromium B.S.U.</b><br>Linux · ▶ plays now</sub></td>
<td align="center" width="25%"><a href="https://prism-compiler.pages.dev/"><img src="https://prism-compiler.pages.dev/thumbs/hexen2.png" width="200" alt="Hexen II, compiled by PRISM"></a><br><sub><b>Hexen II</b><br>Windows · your copy</sub></td>
</tr>
</table>

<sub>Every picture is a frame PRISM drew from the game's unmodified source. ▶ starts the game; the others open the showcase, which asks for your copy.</sub>

- **MAME**: 15 of 15 games bit-identical to a native gcc build over 1,500 frames.
- **ScummVM**: 3,000 of 3,000 frames and every audio buffer equal to native, for each of 20 game demos.
- **Quake**: the same pixels on four platform layers (DOS, X11, svgalib, Win32); GLQuake within 1 pixel of 307,200 of Mesa.
- **Live C**: type C or C++ and run it, or load one of 787 Rosetta Code solutions; the 775 console ones print what a native build prints.

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
server: the programs whose code and data may be passed on, each precompiled with its licences and
the source it was built from, and a gallery that plays the visitor's own copy of the rest. That is
what [prism-compiler.pages.dev](https://prism-compiler.pages.dev) serves. How it is built, checked and
hosted, and how the page adapts to the visitor's language and keyboard: [docs/SITE.md](docs/SITE.md).

**No game data is fetched or stored by this repository.** The page reads only the files you
give it, or a directory you name with `--data`.

## Deterministic by construction

A comparison proves something only if it gives the same answer every time it is made. PRISM is
built so that it does:

- **The same source compiles to the same JavaScript, byte for byte.** `__DATE__` and `__TIME__`
  are fixed (`Jan  1 1996`, `00:00:00`) rather than the wall clock, as `SOURCE_DATE_EPOCH` fixes
  them for gcc. A precompiled bundle is keyed by a hash of the compiler and the program, so it is
  rebuilt exactly when one of them changes.
- **The same run produces the same frames.** Headless, time is a virtual clock: it advances by what
  the program asks for (a delay, a frame), never by how fast the host happens to be. A gate can ask
  for frame 1,500 of a demo, or of MAME's attract mode, and get the same pixels every time. That is
  what makes "bit-identical to a native build" a claim anyone can re-check, not a screenshot.
- **So a difference is a defect, never noise.** Gates compare exactly (to the bit, or within a
  tolerance that is stated and justified, such as the x87's extra precision in Debian's libGLU), and
  the goldens they commit replay without the reference toolchain.

Only the page relaxes this, where a person is watching: Live C stamps `__DATE__` with the present,
and a game in the browser runs on the real clock. The gates keep a fixed date, UTC and US key
positions.

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

## FAQ

**Is it an emulator?** No. Nothing x86 is executed: the game's C source is compiled to JavaScript,
and the machine it was written for (DOS, Win32, X11, SDL, OpenGL...) is supplied as libraries
underneath it. Its sibling project MIRAGE is the other approach: it recompiles a program's x86
binary.

**Why JavaScript and not WebAssembly?** Readable output, run by the browser's own JIT: one
JavaScript function per C function, which is what makes a defect findable by reading. The choice is
measured, not assumed: [the comparison page](https://prism-compiler.pages.dev/compare) sets PRISM
against Emscripten, Cheerp and an emulated x86 build, on compile time, run time and size.

**Is it fast enough?** For these games, yes: about 9.5× slower than `clang -O2` with no optimiser
yet, and Quake's own timedemo reports several hundred frames a second. See [How fast](#how-fast).

**What can I play without any files?** Everything with a **Play** button on
[the showcase](https://prism-compiler.pages.dev) (its *Play now* filter): programs whose code and data may be passed on --
the DOOM and Heretic shareware, the Monkey Island, Day of the Tentacle and Sam & Max demos, Beneath
a Steel Sky, Tux Racer, Cube and more. The others ask for *your files*: give the page your game's folder
or `.zip` and it plays from there. Your files are read in your browser and sent nowhere.

**What about licences?** PRISM is MIT. This repository holds no game, no game data and no ROM. The
showcase ships only builds whose code and data may be passed on, each with its licences and the
exact source it was built from ([prism-sources](https://github.com/jfrelat-lab/prism-sources)
releases), and says so where a caution applies.

**What does it need from the browser?** `SharedArrayBuffer`, so cross-origin isolation (the site
sends the headers; any static host can, through `_headers` or `web/coi-sw.js`), and WebGL 2 for the
3D games. It is developed and checked mostly in Chromium-based browsers.

**Can I compile my own code?** In the page, with [Live C](https://prism-compiler.pages.dev/web/live/):
console programs and GLUT, SDL, X11 or Win32 windows, several files, C or C++. Locally, a
`targets/*.json` describes a whole program and `tools/build.mjs` compiles and runs it in Node (see
[Quick start](#quick-start)).

**What does "written with Claude Code" mean?** The code in this repository was written by Claude
Code, Anthropic's coding agent; the commit messages carry its name. None of it is taken on trust:
every claim about C, a library or a picture is held to an independent implementation by a gate (see
[How it is tested](#how-it-is-tested)), and the runs are [deterministic](#deterministic-by-construction)
so anyone can check them again.

## Documentation

Reference documents describe the present state:

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): the design, the file map, the hard parts. Start here.
- [COMPAT.md](docs/COMPAT.md): what runs, how far, and what holds it there.
- [TESTING.md](docs/TESTING.md): the gates, the oracles, and the measured facts behind the ABIs.
- [ROADMAP.md](docs/ROADMAP.md): what is open, one line per task.
- [SITE.md](docs/SITE.md): the static showcase, and hosting PRISM's programs yourself.

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

PRISM was written with [Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE), except where [THIRD-PARTY.md](THIRD-PARTY.md) says otherwise. The licence covers PRISM
itself, not the programs you compile with it.
