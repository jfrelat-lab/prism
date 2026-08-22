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

Foundation only. The oracle infrastructure and the i386 ABI layout are done and gated; the
compiler itself is not written yet. See [docs/COMPAT.md](docs/COMPAT.md) for what runs (nothing) and
[docs/ROADMAP.md](docs/ROADMAP.md) for what is next.

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
