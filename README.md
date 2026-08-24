# PRISM

A **dynamic C→JavaScript compiler, written in pure JavaScript**, for running the unmodified source
of DOS-era games and emulators — MAME 0.1, Quake, Doom — in the browser.

Sibling of [MIRAGE](../mirage), which recompiles a DOS program's **x86 binary**. MIRAGE is real-mode
only, so DOS/4GW and DPMI titles are out of scope there. PRISM reaches exactly that class by
compiling the **C source** instead, and never emulating a CPU.

The difference from Emscripten is the compatibility boundary. Emscripten requires **porting** the
game — replacing its main loop, its video access, its DOS calls. PRISM moves that boundary from the
game to the library: it supplies libc, the DJGPP layer, Allegro and Xlib in JavaScript, and the game
compiles as it shipped.

- Target ABI: **i386 System V, flat 32-bit (DJGPP)** — one address space, no segmentation.
- Language: **C89/C99 + the GNU extensions real code uses**. No C++.
- Backend: **JavaScript, no WASM** — readable emitted code is the primary debugging lever.

## Status

The compiler works and **MAME 0.1 runs Pac-Man in a browser**, compiled from its unmodified 1997 C
source: 18 translation units, 894 functions, 0.45 MB of emitted JavaScript, compiled in the browser
in about 700 ms. Playable — coin, start and the arrow keys all reach the game.

Measured against external oracles, never against itself:

| Gate | Result |
|---|---|
| i386 ABI layout (`sizeof`/`offsetof`/bitfields) vs gcc | exact, 1745/1745 |
| Preprocessor vs `gcc -E` | token-identical |
| Declarations + sema vs gcc | 1819/1819 |
| c-testsuite | 193/219, **0 wrong answers** |
| gcc.c-torture/execute | 1218/1556, **0 wrong answers** |
| MAME 0.1 vs a native gcc build | **bit-identical framebuffer over 200 frames** |
| Speed, tier-0 vs `clang -O2` native | 9.5× slower |

Quake compiles but does not yet run. See [docs/COMPAT.md](docs/COMPAT.md) and
[docs/ROADMAP.md](docs/ROADMAP.md).

## Running a program in the browser

```bash
node tools/serve.mjs --data=/path/to/your/roms
```

Then open the printed URL, pick a program, type its arguments, load its data files and press **Run**.
The shell compiles the C in a worker and shows the program on one surface — a text screen until it
creates a display, its framebuffer afterwards. `--data` is optional (the page has a file picker), and
**no game data is ever fetched or stored by this repository** — it reads only a directory you name.

Two programs ship. MAME 0.1 needs a ROM set you supply; the Mandelbrot is plain C89 with no platform
layer and no data files, and exists so that "the shell is generic" is a claim something can falsify.
Adding a program means adding a `web/programs/*.json` descriptor, not touching the page.

The dev server exists because `SharedArrayBuffer` requires the COOP/COEP headers, and the shell loads
`src/` as unbundled ES modules — the browser runs the same files the Node gates run, so there is no
build step to drift.

## Getting started

Everything that makes a claim about C is checked against a **real i386 gcc**, which on an arm64 Mac
means a container:

```bash
npm run oracle:build     # one-off: linux/386 gcc 12.2 + csmith 2.3
npm run gate:abi         # the one gate that exists: struct layout vs gcc, exact
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the design and the six hard parts
- [docs/TESTING.md](docs/TESTING.md) — the oracles, and every measured fact behind the ABI
- [docs/ROADMAP.md](docs/ROADMAP.md) — the task menu
- [docs/COMPAT.md](docs/COMPAT.md) — what runs, and the verified state of the upstream sources
