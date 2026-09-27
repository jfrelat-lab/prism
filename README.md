# PRISM

A **dynamic C→JavaScript compiler, written in pure JavaScript**, for running the unmodified source
of DOS-era games and emulators — MAME, Quake, Doom, Keen Dreams — in the browser.

Sibling of [MIRAGE](../mirage), which recompiles a DOS program's **x86 binary**. The difference is
what each one needs: MIRAGE needs a binary and no source, PRISM needs published source and no
binary. A program whose source was never published is MIRAGE's alone; one that ships only source is
PRISM's.

The difference from Emscripten is the compatibility boundary. Emscripten requires **porting** the
game — replacing its main loop, its video access, its DOS calls. PRISM moves that boundary from the
game to the library: it supplies libc, the DJGPP layer, Allegro, Xlib, the Win32 SDK and the DOS
interrupt surface in JavaScript, and the game compiles as it shipped.

- Target ABI: **i386 System V, flat 32-bit (DJGPP)**, and **16-bit real-mode DOS** (`dos16`,
  `dos16m`, `dos16l`) with real segmentation, `far`/`_seg`/`huge` pointers and DGROUP.
- Language: **C89/C99 + the GNU extensions real code uses**. No C++.
- Assembly: a program's own is **translated, not emulated** — Borland inline `asm` and whole TASM
  modules, from their source. PRISM has no CPU and wants none.
- Backend: **JavaScript, no WASM** — readable emitted code is the primary debugging lever.

## Status

Seventeen targets build from unmodified sources, on six platform layers, and all but one run.
Among them: **MAME 0.1–0.5** (Pac-Man playable in a browser at 60 fps, bit-identical to a native
build), **Quake** on four platforms (DOS, X11, Win32, SunOS; its own timedemo reports 694 fps),
**Doom** with sound, **Quake II** rendering its demo, **Lua 5.4** running its own test suite, **PuTTY**
connecting over real sockets — and **Keen Dreams**, the first 16-bit target, which plays.

Measured against external oracles, never against itself — **52 gates, 50 green**:

| Gate | Result |
|---|---|
| i386 ABI layout (`sizeof`/`offsetof`/bitfields) vs gcc | exact, 105k checks |
| 16-bit DOS layout (small/medium/large) vs Open Watcom | exact |
| Preprocessor vs `gcc -E` | token-identical, including 289 whole translation units |
| Declarations + sema vs gcc | 8400+ checks |
| c-testsuite | 213/219, **0 wrong answers** |
| gcc.c-torture/execute | 1438/1556, **0 wrong answers** |
| Random programs vs `gcc -O0`/`-O2` (csmith) | divergence-free |
| MAME 0.1 vs a native gcc build | **bit-identical framebuffer over 200 frames** |
| Quake at 320x200 on DOS, X11 and Win32 | **identical pixels** |
| TASM front end vs **Turbo Assembler 2.5** | every byte, offset and instruction |
| Translated TASM routines vs **TASM's own object code** under Unicorn | registers, flags, 1 MB of memory |
| 16-bit programs vs **Borland C++ 2.0** running the same source | identical output |
| Speed, tier-0 vs `clang -O2` native | 9.5× slower |

See [docs/COMPAT.md](docs/COMPAT.md) for what runs and [docs/ROADMAP.md](docs/ROADMAP.md) for what
is next.

## Running a program in the browser

```bash
node tools/serve.mjs --data=/path/to/your/roms
```

Then open the printed URL, pick a program, type its arguments, load its data files and press **Run**.
The shell compiles the C in a worker and shows the program on one surface — a text screen until it
creates a display, its framebuffer afterwards. `--data` is optional (the page has a file picker), and
**no game data is ever fetched or stored by this repository** — it reads only a directory you name.

Seventeen programs ship as `web/programs/*.json` descriptors; each needs the data files you supply.
The Mandelbrot is plain C89 with no platform layer and no data files, and exists so that "the shell
is generic" is a claim something can falsify. Adding a program means adding a descriptor, not
touching the page.

The dev server exists because `SharedArrayBuffer` requires the COOP/COEP headers, and the shell loads
`src/` as unbundled ES modules — the browser runs the same files the Node gates run, so there is no
build step to drift.

## Getting started

Everything that makes a claim about C is checked against a **real compiler**, which on an arm64 Mac
means a container for gcc and DOSBox-X for the period ones:

```bash
npm run oracle:build     # one-off: linux/386 gcc 12.2 + csmith 2.3
npm run gate:abi         # struct layout vs gcc, exact
node tools/build.mjs <target>          # build any targets/*.json
```

Three oracles need software this repository does not ship: the gcc container (built above), Open
Watcom for the 16-bit layouts, and **Borland C++ 2.0 + Turbo Assembler 2.5** under DOSBox-X for the
16-bit targets. Every gate that needs one replays from a committed golden, so a plain `node
tools/gate-*.mjs` run needs none of them.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the design and the six hard parts
- [docs/TESTING.md](docs/TESTING.md) — the oracles, and every measured fact behind the ABI
- [docs/ROADMAP.md](docs/ROADMAP.md) — the task menu
- [docs/COMPAT.md](docs/COMPAT.md) — what runs, and the verified state of the upstream sources
