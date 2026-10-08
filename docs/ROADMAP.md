# PRISM — Roadmap (a menu, not a schedule)

North star, as first written: **MAME 0.1, then Quake, then Doom**, compiled from unmodified source
and running in the browser — **all three reached**, plus Quake II, Hexen, Heretic, OpenDUNE, Lua,
PuTTY and a first 16-bit title. The axis now is the one those three never exercised: **16-bit DOS
programs whose own assembly sees its own addresses** (P11), and making what already runs playable
by a person rather than by a script. Effort: **S** ≤ half a session, **M** ≈ one focused session,
**L** = multi-session.
See [COMPAT.md](COMPAT.md) for what runs and [TESTING.md](TESTING.md) for the gates.

**Where the compiler actually is, in four lines, so nothing below is read as a description of
today.** PRISM has **one literal emitter and no optimiser**: `src/ir/` and `src/opt/` are empty
directories (P13.2), and it is not a JIT -- runtime re-emission was reconsidered and set aside
(P2.3). It emits for **i386 and for 16-bit real-mode DOS** (`dos16`/`dos16m`/`dos16l`, real
segmentation, `far`/`_seg`/`huge`): Keen Dreams plays, Catacomb 3-D builds (P11). It compiles
**C89/C99 + GNU, and a C++98 subset** through a front end that lowers to C (P14). It **translates a program's own assembly from its source** — Borland
inline `asm`, whole TASM modules, Watcom `#pragma aux` — and emulates no CPU. Perf, measured:
**~9.5x** off clang -O2, and Quake in the browser has **24x** the headroom it needs for its own
frame rate.

⚠️ **This file lags the code, repeatedly and by a lot** — a 🔴 or 🟡 row is not evidence that a
capability is absent. P11.1 sat at "first half done, XL, Wolf3D stays the wrong first target" for the
ten commits that made Keen Dreams play, and both this project and a peer session re-derived a wrong
estimate from it. **When a chantier closes, write its row before starting the next one.**

**How to read it.** ✅ done · 🟡 partly done or in progress · 🔴 blocked · ⚪ open, not started ·
❌ retracted. One line per task; the long form of every row written before 2026-09-27 — the
measurements, the dead ends, the defects found on the way — is in [LOG.md](LOG.md), linked from each
row. A row's story after that date is in its commit.

## Menu — what to pick next, in the owner's order (2026-09-27)

| # | What | Rows | Effort |
|---|---|---|---|
| 1 | **A pixel oracle for every DOS target: the real binary under DOSBox-X.** `DX-CAPTURE /V` records the emulated framebuffer as ZMBV -- palette indices, unscaled -- and `tools/zmbv.mjs` reads it; `AUTOTYPE` drives the keys. It needs nothing from the guest, so a game that takes INT 8 unchained (Keen) cannot stop it. **Keen Dreams: done** (`gate-keen-pixels`, 35 of 35 stable screens are the real binary's, and the first run found three defects no other gate saw). **OpenDUNE: done** against DUNE2.EXE 1.07 (`gate-dune-pixels`, 123 of 123 over the first 900 ticks; past them the oracle measures P7.11's clock). Heretic and Hexen need their DOS executables, which are not on disk. **Jump 'n Bump: done**, every one of 300 pages equal to jumpbump.exe's once both clocks say 1997-01-01 (`gate-jnb-pixels`; it found PRISM seeding `random()` the glibc way for a DJGPP program). Next Quake and MAME on DOS: "it looks right" becomes "it draws what the shipped binary draws". | P11.8, P3.6 | M |
| 2 | **Playable by a person, on one clock.** Keen Dreams plays in the browser (P11.5); next its sound (PC speaker, then an OPL2), then Hexen and Heretic at 35 Hz and OpenDUNE's intro that runs slow and then lurches. | P11.5, P6.4, P7.11 | M |
| 3 | **NetHack**, from its own tree and its own `sys/` ports: a large program with NO proprietary data, that stresses the libc, the file layer and the terminal where the games stress devices. | P7.12 | M |
| 4 | **OpenGL onto WebGL, from the small end** -- done as far as it was written (gears, GLQuake, Quake II, then Hexen II, Quake III, Enemy Territory, Tux Racer). What comes next is its own list now, from the least to the most ambitious: **P15**. | P12.5, P12.4, P15 | — |

**After those, in the order they were ranked:** the far-pointer offset wrap (P11.8, the one open
item that could be a wrong answer); a static bundle of a whole program (P13.1); Catacomb 3-D's
run-time code seam (P11.4); an IR designed around separate objects, then WASM (P13.2, P13.3); the
compiler's own gaps -- `long double`, wide bitfields, cheaper safepoints (N2, N1, P2b.1); and the
default-buffering decision (P8.11).

## P0 · Foundation and oracles (no game yet)

| # | | Task | Effort | |
|---|---|---|---|---|
| P0.1 | ✅ | The oracle: `linux/386` gcc 12.2 + csmith 2.3 container, long-lived, `tools/oracle.mjs`. Measured the host has no gcc, no `-m32`, no cross-compiler, no csmith; measured … | — | [log](LOG.md#p0-1) |
| P0.2 | ✅ | `src/sema/abi.js` + `tools/gate-abi.mjs`. Exact i386 layout, gated on 105k checks across 13 seeds, sensitivity-checked. Found three bitfield rules by generation that … | — | [log](LOG.md#p0-2) |
| P0.3 | ✅ | `src/cpp/` (lexer, `#if` evaluator, directives, Prosser expansion) + `tools/gate-cpp.mjs`. Token-identical to `gcc -E` on 42 hand cases (including the canonical C99 … | — | [log](LOG.md#p0-3) |
| P0.3b | ❌ | RETRACTED — measured, and not worth doing. | — | [log](LOG.md#p0-3b) |
| P0.3c | ✅ | `tools/gate-cpp-files.mjs`. 289 of 289 whole translation units from five programs match `gcc -E` token for token (⚠️ at `--limit=200`: the default is 8 files per … | M | [log](LOG.md#p0-3c) |
| P0.4 | ✅ | `src/parse/parser.js` + `src/sema/types.js` + `tools/gate-decl.mjs`. C89 complete (K&R definitions, implicit `int`, nested declarators), the useful C99, GNU … | — | [log](LOG.md#p0-4) |
| P0.5 | ✅ | `src/link/module.js`, `src/backend/emit.js`, `src/runtime/runtime.js`, `src/env/headers.js`, `src/compile.js` + `tools/gate-run.mjs`. 22/22 programs behave identically … | — | [log](LOG.md#p0-5) |
| P0.5b | 🟡 | Torture 1294 → 1438, c-testsuite 204 → 213, zero wrong answers throughout. | L | [log](LOG.md#p0-5b) |
| P0.5c | ⚪ | Lower i64 to i32 pairs in the optimised output (P13.2), or to native i64 in WASM (P13.3). | L | [log](LOG.md#p0-5c) |
| P0.6 | ✅ | c-testsuite as a gate, gcc captured once: 182/219 then, 0 wrong answers; four real defects found | — | [log](LOG.md#p0-6) |
| P0.6b | ✅ | `gcc.c-torture/execute`, 1592 programs, fetched from the gcc 12.2 tarball. 869/1558 pass, 0 unexplained wrong answers. Two tables (`__builtin_*` aliases and gcc's … | — | [log](LOG.md#p0-6b) |
| P0.6c | ✅ | 37 miscompiles down to 6, torture 869 → 892. Seven causes: `aligned`/member-`packed` attributes, a half-fixed address-precedence bug worth 15 programs on its own, … | — | [log](LOG.md#p0-6c) |
| P0.6d | ✅ | Wide literals as 4-byte elements, plus the endianness macros and bitfield placement in unions (a class the ABI generator had never produced). Torture 885 → 892, … | — | [log](LOG.md#p0-6d) |
| P0.6e | ✅ | Zero wrong answers across 1,556 torture and 219 c-testsuite programs | — | [log](LOG.md#p0-6e) |
| P0.7 | ✅ | `tools/csmith-diff.mjs`. Random programs against `gcc -O0`/`-O2`, with gcc-vs-itself as the UB filter so a divergence is evidence about PRISM and not about csmith. Found … | M | [log](LOG.md#p0-7) |
| P0.8 | ✅ | Gates say PASS, SKIP or FAIL: `tools/gates.mjs` runs them all, and a gate missing something the repository does not ship exits 77 through `tools/gate-skip.mjs` instead of red. The two gates that had been red for weeks: `gate-pixels` was green all along given `PRISM_QUAKE_DATA`; `gate-lua` had real defects under it (P8.10) and now pins its one known stop. | S | — |

## P1 · MAME

| # | | Task | Effort | |
|---|---|---|---|---|
| P1.1 | ✅ | Corpus fetched, `tools/mame.mjs` builds and runs it. | — | [log](LOG.md#p1-1) |
| P1.2 | ✅ | MAME's own osdepend.h boundary, eighteen functions, shimmed by src/env/osd.js -- later replaced by MAME's own msdos.c (P1.7) | — | [log](LOG.md#p1-2) |
| P1.3 | ✅ | Pac-Man runs and every frame is bit-identical to a native gcc build over 200 frames (`tools/mamediff.mjs`). Two defects found: a runtime builtin shadowed the program's … | — | [log](LOG.md#p1-3) |
| P1.4 | ✅ | `tools/z80diff.mjs`. Found the defect in seconds: compound assignment evaluated the lvalue before the right-hand side, so `R.PC.W.l += (offset)M_RDMEM_OPCODE()` made … | — | [log](LOG.md#p1-4) |
| P1.5 | ✅ | `web/` + `tools/serve.mjs`: a program-agnostic browser shell. Guest in a Web Worker over a SharedArrayBuffer; the page observes guest memory, because a C main loop never … | — | [log](LOG.md#p1-5) |
| P1.6 | ✅ | The shell is FOUR MACHINES, and Live C is a page of its own. | M | [log](LOG.md#p1-6) |
| P1.7 | ✅ | `src/env/osd.js` is deleted and MAME compiles its own `src/msdos/msdos.c`, the file its makefile selects for DOS. What is shimmed is one level down: `src/env/allegro.js` … | M | [log](LOG.md#p1-7) |
| P1.8 | ✅ | Two processes: Doom and its own sound server, in two threads, connected by a byte pipe | M | [log](LOG.md#p1-8) |
| P1.10 | ✅ | Wizard of Wor was `rand()`, and it was never a PRISM defect in the way the complaint implied. | M | [log](LOG.md#p1-10) |
| P1.11 | ✅ | MAME 0.4 HAS a native oracle, and the row that said it could not was too narrow. | S | [log](LOG.md#p1-11) |
| P1.12 | ✅ | The shell became a machine you use. | — | [log](LOG.md#p1-12) |

## P2 · Performance

| # | | Task | Effort | |
|---|---|---|---|---|
| P2.1 | 🟡 | Direct calls are on by default. | L | [log](LOG.md#p2-1) |
| P2.2 | ⚪ | Alignment inference, GVN, LICM, inlining -- blocked on an IR (src/ir/ and src/opt/ are empty) | L | [log](LOG.md#p2-2) |
| P2.3 | ⚪ | **Reframed 2026-09-27: a PRISM-level JIT mostly duplicates the JS engine's own.** V8 already compiles lazily, re-optimises hot code and specialises on what it observes. What it cannot see is C's memory semantics (aliasing, alignment, a local that never escapes) and that is STATIC knowledge, since PRISM always holds the whole program: it belongs to the IR's whole-program optimiser (P13.2), not to a tier. Profile-guided re-emission stays open, to be taken only when a measurement shows a gain the static pass cannot reach -- none does today (9.5x off clang -O2; Quake has 24x headroom). So "dynamic" should not be the word that defines the project. | L | [log](LOG.md#p2-3) |
| P2.4 | ✅ | `tools/bench.mjs`, and it no longer needs a ROM (`--synthetic`). Two workloads published separately: ~9.5× slower than clang -O2 on MAME's Z80 core with Pac-Man, ~10× on … | M | [log](LOG.md#p2-4) |
| P2.5 | ⚪ | Two load modes, over one serialised IR. | M | [log](LOG.md#p2-5) |

## P2b · Safepoints — the only way a loop that calls nothing is reachable

The mechanism exists, is opt-in, and four programs ask for it (MAME 0.5, Heretic, Hexen,
OpenDUNE): `if(--M.spBudget<0)M.sp_(id);` on every `while`/`do`/`for` back edge. See
[ARCHITECTURE.md](ARCHITECTURE.md#safepoints-making-a-loop-observable-when-it-calls-nothing).

**The constraint that bounds every row here: nothing in JavaScript can preempt.** No signals, no
guard page to unprotect (the JVM's trick), no way to interrupt a running function — a worker can be
killed, not interrupted. **Every solution is therefore cooperative**, and the only question is where
the cooperation is paid for. Rows are ordered by what I would take first.

| # | | Task | Effort | |
|---|---|---|---|---|
| P2b.1 | ⚪ | Instrument only the loops that call NOTHING. | S | [log](LOG.md#p2b-1) |
| P2b.2 | ⚪ | Write the guest's memory from the OTHER thread, and skip the safepoint entirely. | M | [log](LOG.md#p2b-2) |
| P2b.3 | ⚪ | A shared FLAG instead of a budget. | S | [log](LOG.md#p2b-3) |
| P2b.4 | ⚪ | A handler for the general case: Stop interrupting a `while (1);`. | S | [log](LOG.md#p2b-4) |
| P2b.5 | 🔴 | Not taken: lowering loops to state machines so the host can re-enter between turns. | L | [log](LOG.md#p2b-5) |

## P3 · Quake

| # | | Task | Effort | |
|---|---|---|---|---|
| P3.1 | ✅ | `src/env/headers-djgpp.js`: `go32.h sys/farptr.h sys/movedata.h dpmi.h dos.h io.h`, plus `pc.h` from P5.1. Written for MAME's `msdos.c` (P1.7) rather than for Quake, … | M | [log](LOG.md#p3-1) |
| P3.2 | ✅ | `WinQuake/` compiles and runs: 1030 functions, 1.73 MB of JavaScript in 0.9 s, demo1 at 525 fps. `id386=0` turned out NOT to be the switch: `TARGET_DEFINES` sets … | — | [log](LOG.md#p3-2) |
| P3.3 | ✅ | Quake runs on its OWN DOS platform units. | M | [log](LOG.md#p3-3) |
| P3.4 | 🟡 | The timedemo runs and the number is Quake's own: `969 FRAMES 1.4 SECONDS 694.2 FPS` on demo1. | M | [log](LOG.md#p3-4) |
| P3.5 | 🔴 | Quake's DOS mode-X resolutions cannot work yet, for TWO independent reasons. | L | [log](LOG.md#p3-5) |
| P3.5b | ✅ | ONE COLUMN IN FOUR: FIXED. The translated assembly was bypassing the page map. | M | [log](LOG.md#p3-5b) |
| P3.5c | ✅ | SOLVED, and the defect was nowhere the symptoms pointed. `finalizeHeap` is called TWICE and the second call handed the game memory the environment had already been given. | M | [log](LOG.md#p3-5c) |
| P3.5d | ⚪ | The picture is still wrong, in a DIFFERENT way: the title repeats FOUR TIMES across the width, with heavy horizontal banding. | M | [log](LOG.md#p3-5d) |
| P3.6 | 🟡 | The pixel diff against DOSBox-X needs a THIRD ingredient, and it is not obvious. | M | [log](LOG.md#p3-6) |
| P3.7 | ✅ | There is a mouse, on DOS and on X11. | — | [log](LOG.md#p3-7) |

## P4 · Doom

| # | | Task | Effort | |
|---|---|---|---|---|
| P4.1 | ✅ | `src/env/x11.js`, the Xlib boundary (not the protocol), plus the POSIX half in `src/env/stdio.js`. `linuxdoom-1.10` compiles entirely unmodified: 62 units, 45,152 lines, … | M | [log](LOG.md#p4-1) |
| P4.2 | ✅ | Doom plays E1M1, not just its title; its shareware demos do not, and Doom says why ('different game version') | M | [log](LOG.md#p4-2) |

## P5 · Native assembly

| # | | Task | Effort | |
|---|---|---|---|---|
| P5.1 | ✅ | The inportb/outportb intrinsics -- and no inline assembly was needed at all: every port access goes through pc.h | — | [log](LOG.md#p5-1) |
| P5.2 | 🟡 | MEASURED AT ONE SYMBOL — AND THE CENSUS HAD A HOLE, WHICH IS WHERE THE ASSEMBLER CAME FROM. | L | [log](LOG.md#p5-2) |
| P5.2a | ✅ | Inline asm with an EMPTY TEMPLATE — torture 1344 → 1363. | S | [log](LOG.md#p5-2a) |
| P5.3 | ✅ | A program's own assembly is TRANSLATED from its source, in three dialects — and the one that matters most was not in this section's plan. | — | [log](LOG.md#p5-3) |

## P6 · Raven (Heretic, Hexen)

Not in the original plan. They arrived because Wolfenstein 3D turned out to be 16-bit segmented — a
second ABI — and the question "what else is DOS but flat?" had an answer.

| # | | Task | Effort | |
|---|---|---|---|---|
| P6.1 | ✅ | Heretic plays its attract loop. | M | [log](LOG.md#p6-1) |
| P6.2 | ✅ | Hexen RUNS, on the retail v1.1 WAD. | S | [log](LOG.md#p6-2) |
| P6.3 | ✅ | Heretic is interactive. | S | [log](LOG.md#p6-3) |
| P6.4 | ⚪ | Pace it, and put it in the browser. | M | [log](LOG.md#p6-4) |
| P6.5 | 🟡 | Heretic 1.3 and Hexen 1.1 DEMOS DESYNC against the real EXEs under DOSBox-X: Heretic agrees tic for tic (38 status-bar states) until PRISM frame 632, where the player's MOVEMENT differs (wall sliding or a push). Ruled out: RNG, timing, operand and argument order (now Watcom's, `gate-watcom-argorder`), FixedMul/FixedDiv2. Next: a Watcom-built headless Heretic as a per-tic state oracle. | L | [log](LOG.md#p6-5) |

## P7 · Targets as data, and the programs they brought

| # | | Task | Effort | |
|---|---|---|---|---|
| P7.1 | 🟡 | Targets are DATA. | M | [log](LOG.md#p7-1) |
| P7.2 | ✅ | The 16-bit ABI is pinned by an external oracle — `gate-abi16.mjs`, ~4,970 checks over six seeds, exact. | M | [log](LOG.md#p7-2) |
| P7.3 | ✅ | Per-module symbol namespaces — Quake II runs. | L | [log](LOG.md#p7-3) |
| P7.4 | 🟡 | OpenDUNE compiles and runs to its data check | M | [log](LOG.md#p7-4) |
| P7.5 | ✅ | Quake II RENDERS. | L | [log](LOG.md#p7-5) |
| P7.6 | ✅ | OpenDUNE RUNS on Dune II's data | S | [log](LOG.md#p7-6) |
| P7.7 | ✅ | Undefined symbols are reported. | S | [log](LOG.md#p7-7) |
| P7.8 | ✅ | The assembly cross-reference: 298 exported symbols, 1 missing. | S | [log](LOG.md#p7-8) |
| P7.9 | ✅ | `#pragma aux` routine bodies compile. | M | [log](LOG.md#p7-9) |
| P7.10 | ✅ | Heretic was never broken — the harness needs `--safepoints`. | S | [log](LOG.md#p7-10) |
| P7.11 | ✅ | OpenDUNE's intro ran at 0.59x the real binary's time: Watcom's DOS clock() counts ms (CLOCKS_PER_SEC 1000) in ~55 ms BIOS-tick lumps, and OpenDUNE's callonce timers fire once per lump. Now PRISM's under the Watcom toolchain (`gate-watcom-clock`, against Open Watcom's libc); the intro runs at 1.01x (`gate-dune-pixels` asserts the slope). | M | [log](LOG.md#p7-11) |
| P7.13 | ✅ | **SDLPoP 1.23 (Prince of Persia) plays in the page**, with its music: the 1989 DOS game as David Nagy disassembled and rewrote it in C (21 files, 31,000 lines), on SDL 2 and SDL_image. It is the first program here that draws THROUGH SDL instead of beside it, so the SDL 2 shim, written for two programs that blit by hand, gained its other half: **software surfaces** (src/env/sdl2-surface.js: 8-bit indexed with palettes, 24- and 32-bit formats by their masks, colour keys, blend modes, alpha modulation, SDL_ConvertSurface, clip rectangles, SDL_BlitScaled), held to the real SDL 2 in the oracle by `gate-sdl2-surface` (28 of 28 lines of scenes; the reference corrected two things recalled wrong: SDL_SetColorKey leaves the palette alone, and RGB888 reports 32 bits); **SDL_image's PNG loading** (sdl2-image.js over png.js, a pure-JS inflate and PNG decoder, `gate-png`: inflate against zlib on 80 streams and the game's 929 files, the decoder against files the gate encodes); render targets, RWops over memory and files, timers, the performance counter, SDL_GetKeyboardState, and SDL 2's legacy audio device whose callback is pulled by the clock at the points where the program yields (the game WAITS on what its callback does). Its music is the original AdLib data played by an OPL3 emulator that is part of the program and compiled with it (0.12x real time in node). On the way, **two defects of PRISM itself**: a `setjmp` nested in a branch was lifted out in front of its statement, so the `longjmp` came back to the `if` and took the `longjmp` again for ever (start_game; functions with a nested setjmp are now flattened first -- `gate-run` setjmp-nested-in-a-branch); and scanf at the end of input returned EOF where glibc returns 0 (white space in a format is satisfied by none; the game took its ini file for truncated -- `gate-run` scanf-at-the-end-of-input). Also stat() and access() on a directory, strnlen, log2f, strtoimax. In the page the SDL 2 host widens a 24-bit texture, translates PC scan codes to SDL's, delivers keys where the program polls, and plays the callback's buffers. **Then held to the real thing** (libsdl2-image-dev added to the oracle): `gate-sdl2-image` loads one PNG of every kind, and a sample of the game's own, through the real SDL_image and through PRISM -- 77 of 77 surfaces the same; it found that a grey PNG with a transparent level comes back as a two-byte surface SDL calls RGB565. And `gate-sdlpop-pixels`: the game built by gcc against the real SDL 2 runs in the container under a preloaded library (tools/oracle/sdl2-capture.c) that hashes every distinct picture handed to SDL_UpdateTexture and plays a key script tied to counts of distinct pictures; PRISM replays it and all 130 pictures -- notice screen, title fade, level 1, the prince running off his ledge and landing -- are the reference's, in order. One setting is changed on both sides (`intro_music_level = 0`): the prince stays crouched while level 1's tune PLAYS, which is real time and slower in the container. Not yet: IMG_SavePNG (screenshots), game controllers, interlaced PNG; the pixel reference covers the first seconds of level 1, not a fight or a level change. | L | |
| P7.12 | ⚪ | **NetHack.** 133 units in `src/` and its own `sys/msdos` and `sys/unix` ports: pick the platform layer the way Quake's were picked, from the tree's own makefiles. No game data to fetch or license -- the dungeon is the program -- and no graphics: it stresses what the games do not, the libc, the file layer (save files, bones, the high-score file with its locking) and a terminal (tty, termcap/curses or the DOS console). A tty on the page is the text surface the shell already has. | M | — |

## P8 · Semantic oracles: Lua, the MAME releases, and what they found

| # | | Task | Effort | |
|---|---|---|---|---|
| P8.1 | ✅ | Lua 5.4 runs | M | [log](LOG.md#p8-1) |
| P8.2 | ✅ | A C string is BYTES. | S | [log](LOG.md#p8-2) |
| P8.3 | ✅ | `%f` expands in BigInt. | S | [log](LOG.md#p8-3) |
| P8.4 | ✅ | Lua's own test suite as a gate (tools/gate-lua.mjs): 14 passing files to 16, 5 failing to 1 | M | [log](LOG.md#p8-4) |
| P8.5 | ✅ | MAME 0.1 through 0.4, from one harness. | S | [log](LOG.md#p8-5) |
| P8.5b | ✅ | **MAME 0.6** (`mame06`): the release that reorganised its tree into drivers/ machine/ vidhrdw/ sndhrdw/ and added Scramble, Uniwars, Frogger, Amidar, Turtles and Rally X -- 46 units, 41 games in its table. Through the same harness (`tools/mame-golden.mjs --write --release=06`): **21 of the 21 games whose ROMs are here** print the frame hashes a native gcc build prints over 120 frames (goldens/mame06.json), Amidar and Turtles among them. The other 20 have no ROM set here (Scramble, Frogger, Rally X, Galaxian and its clones, Moon Cresta, Uniwars, Gorf, Robby Roto ...) and are untested, not failing. It is MAME.EXE on the DOS shelf, in place of 0.5: the shelf carries ONE MAME, the newest that is verified, and a release replaces the one before it (the older targets and their goldens stay in the repository, which is what several gates read). | S | |
| P8.5c | ✅ | **MAME 0.7** (`mame07`), which takes 0.6's place on the shelf: Super Cobra, Pooyan, Phoenix and Pleiades join, 52 units, 48 games. Its source archive stores every file in UPPER CASE while the makefile and the #includes spell them in lower case (`caseInsensitive`). **21 of the 21 games whose ROMs are here** agree with a native gcc build over 120 frames (goldens/mame07.json); none of the release's NEW games has a ROM set here, so they are untested. Next is not 0.8 but **0.34**, the release that identifies ROMs by CRC-32 (the notes of every release between were read: 0.15 only wishes for a CRC, 0.27 adds a home-made checksum, 0.34 switches to CRC-32 and finds a ROM in a zip whatever its name). Measured: 721 C files, about 450,000 lines; everything but its DOS layer compiles (686 units, 12,500 functions, 3 refusals) with the makefile's own C alternatives to its two x86 assembly cores; the DOS layer asks about 40 Allegro 3 and SEAL functions more than the shim has. `tools/mame-audit.mjs` says, from the release's own driver tables and the CRCs on disk, which games a ROM collection can run -- of the sets here, 5 are complete for 0.34, most of the rest lacking the colour PROMs later releases load. | S | |
| P8.5d | 🟡 | **MAME 0.34** (`mame034`) builds WHOLE, its own `src/msdos` included: 695 units from the makefile's OBJS and archives, 12,638 functions, every symbol resolved. What it took: Allegro 3's colour depths, configuration, joystick and mouse tables (absent: no joystick, no mouse, no mame.cfg -- every get_config_* answers its default); SEAL's primed voices, AUpdateAudioEx, 16-bit waves, and its real device numbering (device 0 is the silent "None", which 0.34's sound.c relies on); GCC inline assembly over EAX/EDX wide enough for the profiler's rdtsc and vec_mult's one-operand imull (gate-run, against a real x86); `strings.h`; four empty entry points for `ym2203.opm`, an object the release ships precompiled. **The picture** is no longer "the whole bitmap at 0xa0000": 0.34 copies only changed 16x16 blocks through one of twenty mode-specific routines, so a frame is presented where the program blits, from its own screen bitmap and the rectangle of it it shows. **In the page** a ROM collection is listed, not loaded (`needsData.lazy`): each zip is fetched when the program opens it. Runs, seen: Space Invaders, 1942, Commando, Asteroids (vector, VESA), Crystal Castles, Marble Madness, Final Fight. `tools/gate-mame034.mjs` holds the build and the driver table (the program's `-listcrc` against a text reading of the sources); its runs through the DOS layer are a SMOKE test. **The reference** (`tools/mame034diff.mjs`, `tools/mamediff/osdnull34.c`): the same sources built by an i386 gcc and by PRISM over one headless backend -- everything but src/msdos, plus the release's own fileio.c -- printing a hash of the bitmap and of the palette per emulated frame. One native binary (make, kept in .oracle/) serves every game. **15 of 15 games agree over 1500 played frames** (coin, start, fire): Space Invaders, 1942, Commando, Asteroids, Crystal Castles, Marble Madness, Final Fight, Bobble Bobble, Capcom Bowling, Exterminator, Smash TV, Donkey Kong, Berzerk, Battlezone, Black Tiger -- 8080, Z80, 6502, 68000/68010, TMS34010, raster and vector (goldens/mame034.json; the gate replays five). What it found: **a compiler defect** -- unsigned arithmetic folded as signed in a static initialiser (`(UINT32)x >> 3` in the TMS34010 memory maps; Smash TV read its reset vector outside its ROM, Exterminator ran out of memory; gate-run) -- and **a defect of MAME's**: Smash TV's palette RAM is a bare malloc its writes combine into, so the native build prints five pictures for five values of MALLOC_PERTURB_; both sides now fill fresh memory with one byte. gcc 12 refuses machine/smashtv.c's `name ## ++`, so that unit is preprocessed by tcc. **16-bit games** (Capcom Bowling, Smash TV, Exterminator) are presented, as B,G,R,A. `bublbobl` is GAME_NOT_WORKING in the release itself; its clone `boblbobl` runs. **Open:** the picture the DOS layer presents is not held to anything (the reference stops at the osd interface); sound reaches SEAL (1942's music, 16-bit, 22,050 Hz) but the 16-bit mix is unmeasured and unheard; the two pixel doublers are x86 assembly, hence `-nodouble`; the other 764 complete sets are unrun. | L | |
| P8.5e | 🟡 | **MAME 0.37b5, measured** -- the release the owner's ROM collection is: it declares **2,309 games, exactly the 2,309 zips**. `m37b5s.zip` from the MAME project (4.3 MB, a zip inside a zip), unpacked to corpus/mame037b5: 1,124 C files, about 784,000 lines, 44 CPU families and 39 sound chips selected by mame.mak, 55 driver archives. **Everything but src/msdos compiles**: the objects core.mak, mame.mak and the selected blocks of rules.mak name -- 1,028 units, plus the four generated ones -- give **22,797 functions and 34.8 MB of JavaScript in 55 s, every function emitted**, and 62 unresolved names, every one an `osd_*`. What that took: zlib (P17.1); `offsetof` in a static initialiser, which PRISM refused (the ADSP-2100 core's register table; gate-run); `mem.h`; and the generator below. Read in the sources and good news: `tiny.mak` and per-CPU / per-chip selection (`CPUS+=Z80@` becomes `-DHAS_Z80=1`) -- the light build is the release's own mechanism now, not lazy binding; the 68000 core is C by default. **The 68000 core's generator** (`tools/mame-m68k.mjs`, `gate-m68kmake`): four of its units are not in the release -- the makefile compiles `m68kmake.c` and RUNS it on `m68k_in.c`. PRISM runs it: 1,962 opcode handlers from 503 primitives, five files, 765 KB, written to corpus/mame037b5-generated/ and **byte for byte what the generator writes when gcc compiles it**. Running it found three things: (a) **a compiler defect** -- a name declared nowhere, as the size of an array with an initialiser, was accepted and the array took the initialiser's size (`char output_path[MAXDIR] = ""` was one byte; the program overran it); refused now, as gcc refuses it; (b) PRISM's DJGPP `<dir.h>` had no MAXDIR (added with MAXDRIVE, MAXFILE, MAXEXT -- DJGPP's values as remembered, said so in the header: none is on this machine to read); (c) **a defect of the generator's own**: it shifts text with an overlapping `memcpy`, and glibc's leaves 36 lines of garbage in the first generated file -- so the reference is gcc linked with a forward byte-by-byte memcpy, the libc the program was written against. Noted on the way and not taken: `sizeof` of a variable-length array is refused. **Not done, in order**: (1) the DOS layer, about 11,500 lines, with a 298-line NASM file for the blits (`asmblit.asm`) and whatever Allegro it asks beyond 0.34's; (2) a headless backend for its osd interface, to have a reference; (3) the 0.34 tools (audit, mame034diff, mame-light, bundle, mame-compat) carry `mame034` in their names and paths and are to be made to take a release, not copied. The measure was a scratch script: nothing of 0.37b5 is a target yet. | L | — |
| P8.6 | ✅ | clangsay, the smallest target, and the Duff's device it found on its first build | S | [log](LOG.md#p8-6) |
| P8.7 | ⚪ | Descent: not a candidate until P5.2. | — | [log](LOG.md#p8-7) |
| P8.8 | ✅ | The menus answer the keyboard. | S | [log](LOG.md#p8-8) |
| P8.9 | ✅ | Six printf defects, from Lua's own assertions. | M | [log](LOG.md#p8-9) |
| P8.10 | ✅ | files.lua's i/o tests had been SKIPPED since directories landed, and five stdio defects sat under them: `/tmp` seeded in the wrong namespace, so every temporary file was refused; a reader's bytes snapshotted at open, so it never saw another handle's writes; `mktime` not normalising its struct (a wrong-answer class, now a gate-run case); `tmpfile` answering NULL; `setvbuf` ignored. | S | — |
| P8.11 | ⚪ | Should files be fully buffered by default, as C99 7.19.3p7 says? Today a stream buffers only when `setvbuf` asks, so every target's writes are visible at once; changing the default changes that for all seventeen. A decision, not a fix. | S | — |
| P8.12 | ✅ | `atexit` handlers run: in reverse order of registration, on `exit()` and on a return from `main`, then every stream is flushed; `_exit` does neither (C99 7.20.4.3). They had been recorded and never run. gate-run: `atexit-reverse-order`, `atexit-from-exit`. | S | — |

## P16 · MAME 0.34, from the least to the most ambitious

Asked for by the owner on 2026-10-06, once the release ran and was held to a native build (P8.5d).
Two lists. The first is what the DOS layer or the shims under it do not do yet, ranked by how much
each asks for. The second is the build itself: today the page compiles all 695 units -- 959 games,
16.4 MB of emitted JavaScript, 7.7 s -- to play one.

**What is missing, by ambition.**

| # | | Task | Effort | |
|---|---|---|---|---|
| P16.1 | ⚪ | **Keyboard LEDs.** `set_leds` answers nothing; MAME drives them from `osd_led_w` (start lamps, coin counters). Carry the three bits to the page. | S | — |
| P16.2 | ⚪ | **High scores, per-game configuration, snapshots: test them, then keep them.** The writes already land in the in-memory file store (HI/, CFG/, PCX/) -- untested. Then make them outlive a reload (the page's storage), which is also what turns off the copyright and credits screens on a second run, as on a real disk. | S | — |
| P16.3 | ⚪ | **`mame.cfg`.** Allegro's `get_config_*`/`set_config_*` over a real file instead of "every option is its default and nothing is saved". Persists with P16.2. | S | — |
| P16.4 | ⚪ | **Sound, measured.** MAME's audio reaches SEAL (1942's music: 16-bit, 22,050 Hz) and nothing holds the 16-bit mix -- gate-sound covers the 8-bit voices of 0.5. A gate for it, and `samples/<game>.zip` fetched as the ROMs are (Space Invaders is silent without them). | S–M | — |
| P16.5 | ⚪ | **Mouse and trackball.** `install_mouse` says there is none. The page's pointer through `get_mouse_mickeys`, which is how MAME reads a trackball: Centipede, Missile Command, Marble Madness. | S–M | — |
| P16.6 | ⚪ | **Joystick and analogue controls.** The browser's Gamepad API into Allegro 3's `joy[]` table (sticks, axes with d1/d2, buttons), calibration answered as already done. | M | — |
| P16.7 | ⚪ | **The pixel doublers.** `double_pixels` and `double_pixels16` are GCC inline assembly in video.c (`lodsl`, `bswap`, `xchgw`, `roll`, `stosl`, `loop`, a segment override): widen the subset emit.js has for rdtsc and imull, held to a real x86 as those are. Fidelity more than need -- the page scales the picture already -- but it removes `-nodouble`. | M | — |
| P16.8 | ⚪ | **The card's scan-out.** No VGA or VESA register is modelled: the frame is the program's own bitmap, so tweaked modes, scanlines and centring do not exist here. Model the CRTC and the VESA window and present what the card would show. Its reference is the real MAME.EXE under DOSBox-X (`DX-CAPTURE`, as for Keen Dreams) -- which would also be the first thing to hold src/msdos/video.c itself. | L | — |
| P16.9 | ⚪ | **The YM2203 through an OPL card.** `ym2203.opm` is x86 object code with no source: it would have to be translated (MIRAGE's territory) and given an OPL to drive. Little to gain -- with No_FM the core computes the chip itself. | L–XL | — |

**The build, by ambition.** The static bundle is P13.1 and is not started; these are what it means
for MAME.

| # | | Task | Effort | |
|---|---|---|---|---|
| P16.10 | ✅ | **A light build, per ARCHIVE of the makefile** (`tools/mame-light.mjs`), which is the cut the release already made: obj/pacman.a, obj/midw8080.a, obj/capcom.a -- 62 of them, all linked only because src/driver.c names every game. A light build is the makefile's OBJS, the archive that holds the game, and a driver table listing that archive's games in driver.c's own order (a replaced unit, as the platform layer is; no source is edited). **Measured, and the first number was a surprise**: the archive cut alone left 12.4 MB of 19.2, because the thirteen CPU cores are 9.9 MB and cpuintrf.c names them all. So the cores no linked driver asks for (its MachineDriver's CPU_* constants) are left out too, their table rows bound lazily. Links are closed by building: a driver that uses another archive's routine (Exterminator's memory map takes a handler from Gottlieb's) pulls that archive in; what only the CORE reaches for (usrintrf.c's NeoMVSDrawGfx) does not, or every build would carry the Neo Geo and a 68000. **Result**, recorded per archive in targets/light/mame034.json: 2.6 to 8.75 MB, median 3.8 (the whole build: 19.2); Space Invaders 74 units and 3.9 MB, Final Fight 117 and 6.7. In the page 1942 compiles in 1.8 s instead of 7.9 (the server answers `/__target?subject=<game>` with the light target; `-listcrc` and unknown names get the whole build). **Held**: all 15 golden games print, from their light builds, the frames a native gcc build printed; the gate replays three and a cut that is too small fails. Open: four archives still drag `other` and `konami` in (8.7 MB) -- worth a look at which names do it. | M | — |
| P16.11 | ✅ | **A static bundle per archive** (P13.1 applied to P16.10; `node tools/bundle.mjs --mame-all`): 61 bundles in dist/, **0.37 to 0.88 MB each gzipped** (3.6 to 11.3 MB on disk), 29.6 MB gzipped for all of MAME 0.34 -- and a player downloads one. In the page 1942 starts from `dist/mame034-capcom` in 97 ms: no source fetched, nothing compiled (the server offers a bundle only when it is not older than src/; `?bundle=off` compiles). **Held**: all 15 golden games print, from bundles read back from disk, the frames a native gcc build printed (`mame034diff --check --bundle`; the gate replays Final Fight). The comparison the owner asked for, in PRISM's own numbers: about half a megabyte of gzipped JavaScript and image per family of games, against the runtime's ~1 MB of source shared by every program. An Emscripten MAME was not built here to set beside it, so "lighter" is a claim about this side only. Built with safepoints, as the page runs it. | M | — |
| P16.12 | ⚪ | **The whole collection through the reference.** 15 games are in the golden; every complete set has now RUN (P16.13) but a run is not a reference. `mame034diff --write` over the 770 is about 20 s a game (four hours). Every disagreement is either a compiler defect or one of MAME's, and both are worth knowing -- the four games P16.13's run could not explain were put through it by hand and one of them was PRISM's. Start with the 11 that do not draw, then the rest by archive. | M | — |
| P16.13 | ✅ | **A compatibility page** (`/web/mame/`, data from `node tools/mame-compat.mjs --roms=<dir>`). One card per game the release lists, from four sources kept apart: the driver sources (title, year, maker, archive, the release's own GAME_NOT_WORKING and colour flags), the ROM set by CRC, a RUN of the game's light build over the headless backend (900 frames, a screenshot cropped to the visible area as src/msdos/video.c crops it), and the reference (in goldens/mame034.json or not). The tally is the filter, and it partitions the list: held to gcc / start and draw / do not / ROM set incomplete. Data and screenshots go to dist/ and are not committed. **On the owner's collection** (0.37b5 sets): 1024 games listed, 779 complete sets, 770 run, **759 draw a picture**, 15 of them held to gcc; 8 stay black (6 flagged not working by MAME, and Gladiator and Ohgon no Siro black under gcc too), 1 throws (flagged not working), 2 never reach a frame (Gun Dealer: nor does the native build under this backend). **What it found**: (a) the release lists 1024 drivers, not 959 -- neogeo.c declares 101 through a macro, which the audit, the light build and the parent lookup all missed; and none of them runs here, their system ROMs (ng-sm1, ng-sfix) come from a macro's body the audit did not expand and differ in this collection; (b) **a runtime defect**: `malloc` of more than the whole image trapped where C says NULL -- MAME's readsamples asks for a negative size when a game has no samples and takes the NULL to mean so (Tomahawk 777; gate-run); (c) a defect of mine: targets/mame034-light.json broke `/__targets`, which takes every file there for a target (moved to targets/light/). gate-mame034 now holds the program's own `-list` against the names read from the sources. Open: a second screenshot in play (coin, start); Neo Geo sets of the right vintage; no gate covers the page itself or `/__targets`. | M–L | — |

## P17 · PRISM outside the page: a program as a function, from the least to the most ambitious

Kept by the owner on 2026-10-08, out of a longer discussion, in this order. The starting point is a
change of view: in the page a program is something to watch; headless, under Node, it is a
**function** -- state and input in, state out -- whose memory is an array that can be read by the
names its C gave things, copied, and run again. And one plain scenario the owner put: "I have C
written for Linux, it does not build on my Mac, through PRISM it runs, and I can plug it into
Node -- stdin, stdout and the rest."

**None of this is measured.** Every row inherits the same limits and should be read with them: a
32-bit i386 world (code that assumes 64-bit longs or pointers is not on the machine it expects), a
partial C library (no threads, no fork, few sockets, no mmap), and a speed below native that has
no number yet. And none of it closes the gap P16 names first: the picture MAME's own DOS layer
presents is held to nothing.

What was weighed and NOT kept, so it is not proposed again by drift: a catalogue of old C
libraries as npm packages (every useful one already has a WASM port); SQLite as an alternative to
a native or WASM build (it compiles and agrees with gcc; nothing says it competes); Android, with
or without MIRAGE (wrong languages above the kernel, and orders of magnitude from where MIRAGE is).

| # | | Task | Effort | |
|---|---|---|---|---|
| P17.1 | ✅ | **zlib, compiled, and then imitated.** MAME 0.37b5 links zlib and ships no source for it. **Compiled**: zlib 1.1.3 from Makefile.in's OBJS (`targets/zlib.json`: 15 units, 106 functions, 0.3 s); its own example program prints under PRISM what it prints under gcc, and its DEFLATE writes the same 27 files byte for byte (1.9 MB, levels 0/1/6/9, Huffman-only, stored, fixed and dynamic blocks). **Imitated**: the `zlib` environment (src/env/zlib.js) -- crc32, adler32, inflate as a stream, uncompress, compress, with its own zlib.h. The inflater is new and takes input IN PIECES: unzip.c reads a member 16 KB at a time and refills without looking at what was left, so a piece ends anywhere and each decoding step either completes or leaves no trace. **Held three ways** (`tools/gate-zlib.mjs`): tests/zlib/probe.c -- unzip.c's own loop with pieces of 16384, 1000, 257, 7 and 1 bytes, uncompress with room exact, short, input cut, checksum off, compress -- prints the same 118 lines linked with gcc's zlib, PRISM's compiled zlib and the imitation; each library expands what the other compressed; four rules moved by one each break it. Two things the build found in the imitation, both at the edge of a buffer exactly as large as the data (an empty member; the end-of-block code after the last byte) -- which is the ordinary call for a zip. Knowingly not zlib, and said in the file: `compress` STORES (valid, not smaller: PRISM has no compressor), and input is asked for a bit at a time where zlib looks a table index ahead, so `avail_in` is not held to zlib's. | S | — |
| P17.2 | ⚪ | **`prism run`.** One command that runs a C source or a target with its arguments, stdin, stdout, exit status and a directory of files: what tools/run-one.mjs, build.mjs --run and each gate's runner do one by one, as a thing a person types. The owner's scenario, made real. First honest test: a Linux program that is not a game (NetHack, P7.12). | S | — |
| P17.3 | ⚪ | **A C filter as a Node stream.** A program that reads stdin and writes stdout, used as one link of a pipeline: old Unix utilities as bricks again. Needs P17.2, and stdin that blocks without holding the event loop (P17.9 is the general form). | S–M | — |
| P17.4 | ⚪ | **Snapshot and fork.** Copy the memory image of a RUNNING program -- only the pages it changed -- to resume it or to make a second one. tools/bundle.mjs already takes the image of a program that has not started; this is the same for one that has, plus whatever state lives outside the image (the heap's bookkeeping, open files, the environments). The floor under P17.5, P17.6, P17.8 and P17.11. | M | — |
| P17.5 | ⚪ | **A game as `step`.** Advance one frame, hand back the picture and the state, read the score from the program's own variable by its name; a run recorded as its inputs and replayed to the frame. What reinforcement-learning benches do for Atari, from source, for anything compiled. MAME 0.34's headless backend is nearly this already (tools/mamediff/osdnull34.c takes a schedule); with P17.4, stepping back. Deterministic only without a real clock or sound. | M | — |
| P17.6 | ⚪ | **A program as its own converter.** Run the original loader to get out what only it reads: levels, sprite sheets, tables, forgotten formats. First: the graphics MAME decodes for a game, as sheets. | M | — |
| P17.7 | ⚪ | **JavaScript bindings, generated.** Call a compiled C library from ordinary JavaScript, the strings, buffers, structures and callbacks converted by code the COMPILER writes, TypeScript types included -- it knows every structure's layout and every function's signature, which is what a person writes by hand for Emscripten. The static bundle is half of it (code, image, symbols). Shown on zlib (P17.1). The row this discussion found most its own. | M–L | — |
| P17.8 | ⚪ | **Sanitizers for code no modern compiler builds.** Uninitialised reads, overruns, undefined behaviour, in Borland 16-bit or DJGPP C. Filling fresh memory with one byte on both sides is the handmade version, and it found a defect of MAME's own (Smash TV's palette RAM). First: a shadow of "written / never written" per byte, reported at the read. It finds only what PRISM executes. | M–L | — |
| P17.9 | ⚪ | **Blocking made asynchronous.** A C program that waits in a loop, presented as steps Node takes at its own pace -- the safepoints are already in the loops (P2b), for another purpose. A real piece of work to make it an interface; today the answer is a worker and a shared buffer. | L | — |
| P17.10 | ⚪ | **The system as a parameter.** Run one source as Linux, DOS, Win32, SunOS and see what it assumes without saying. The personalities exist (P9) but are welded code: this wants them interchangeable, which is the "platform as data" idea and is not true today. | L | — |
| P17.11 | ⚪ | **Rollback netplay.** Determinism and snapshots are what modern fighting games build their netcode on; here for games of 1990 that never had a network. Needs P17.4 and P17.5, and snapshots fast enough to take every frame. | L | — |
| P17.12 | ⚪ | **Firmware, simulated.** A microcontroller's hardware layer is a library like Allegro is: imitate it and a device's C firmware runs under Node with virtual pins, a serial port, sensors -- testable without the board, replayable. Faster and more readable than emulating the processor, and less faithful to the hardware. A whole new domain, one layer per family of boards; a bet. Several real-time kernels (FreeRTOS, Zephyr, NuttX) ship a simulator port that is an ordinary program, which is the cheap way in. | L–XL | — |
| P17.13 | ⚪ | **A kernel compiled by PRISM, its hardware by MIRAGE.** xv6 (x86): the kernel's C becomes JavaScript one can stop in by function name, MIRAGE's devices answer its ports, and MIRAGE's CPU runs the user programs, which stay x86 binaries; a system call is where one hands over to the other. Research, and it CONTRADICTS the rule below ("they meet at the device boundary, not at the CPU") -- so it is to be decided on purpose, and Catacomb 3-D's run-time code (P11.4) is the smaller, real case to decide it on. Known walls: the kernel's assembly (boot, trap entry, context switch) has to be supplied as a layer; a context switch suspends a function mid-way, which JavaScript's stack cannot do (one thread per process, one running at a time, is the lead); kernel addresses need translation; MIRAGE has to become callable. First step, cheap: fetch xv6 and measure how much of its C compiles. Its use is teaching, not a faster Linux -- MIRAGE alone booting a period Linux is the plainer milestone, and is MIRAGE's. | XL | — |

## P9 · One engine, more platforms: X11, Win32, SunOS, and sound

| # | | Task | Effort | |
|---|---|---|---|---|
| P9.1 | ✅ | Quake's Linux/X11 client runs, renders, and now compiles whole. | M | [log](LOG.md#p9-1) |
| P9.2 | ✅ | Duff's device. | S | [log](LOG.md#p9-2) |
| P9.3 | ✅ | Doom is audible in the browser. | M | [log](LOG.md#p9-3) |
| P9.4 | ✅ | Quake/X11 has sound | M | [log](LOG.md#p9-4) |
| P9.5 | ✅ | WinQuake runs, renders and takes the keyboard | L | [log](LOG.md#p9-5) |
| P9.6 | ✅ | The cross-platform pixel gate is green, and the 2% it found was Quake's. | M | [log](LOG.md#p9-6) |
| P9.7 | ✅ | The pixel gate is green at 200 and 400 frames, and the 289 pixels were Quake's own clock. | — | [log](LOG.md#p9-7) |
| P9.8 | ✅ | A FOURTH platform layer: Quake on SunOS. | M | [log](LOG.md#p9-8) |

## P10 · PuTTY — an application, not a game

The first target that is neither a game nor a 1990s DOS program: modern C99, a real Win32 GUI, and a
build system that is itself data. Different evidence from the rest — Quake shows PRISM runs a
renderer; this shows it runs an application. See [COMPAT.md](COMPAT.md).

| # | | Task | Effort | |
|---|---|---|---|---|
| P10.1 | ✅ | The build system is read, not transcribed. | M | [log](LOG.md#p10-1) |
| P10.2 | ✅ | `test_split_into_argv` passes 92/92 | S | [log](LOG.md#p10-2) |
| P10.3 | ✅ | `test_terminal` passes | M | [log](LOG.md#p10-3) |
| P10.4 | ✅ | PuTTYtel runs | M | [log](LOG.md#p10-4) |
| P10.5 | ✅ | The Win32 shim draws. | M | [log](LOG.md#p10-5) |
| P10.6 | ✅ | An update region. | S | [log](LOG.md#p10-6) |
| P10.7 | ✅ | PuTTY shows a terminal with text in it. | L | [log](LOG.md#p10-7) |
| P10.8 | ⚪ | PuTTY's configuration box needs `.rc` resources. | L | [log](LOG.md#p10-8) |
| P10.9 | 🟡 | The page has a Win32 host, and three browser-only bugs came out of it. | M | [log](LOG.md#p10-9) |
| P10.10 | ✅ | QUAKE II RENDERS IN THE PAGE | — | [log](LOG.md#p10-10) |
| P10.11 | 🟡 | PuTTY names the 18 functions it is missing, and they are the Win32 shim's real edges. | M | [log](LOG.md#p10-11) |
| P10.12 | ✅ | Quake II takes the keyboard, and the fix was a BUILD SELECTION. | — | [log](LOG.md#p10-12) |

## P11 · The 16-bit axis — Borland C++, TASM, and the bare machine

Ten commits, each held to an external reference. The chain, because the chain IS the claim:
**Turbo Assembler 2.5** (its object files and listings, byte for byte) → **Unicorn executing TASM's
own object code** (registers, flags, 1,088 KB, port writes) → **Borland C++ 2.0 running the same C**
(identical output) → **DOSBox's VGA** (the EGA's eleven paths). None of it is PRISM checked against
PRISM. See [ARCHITECTURE.md](ARCHITECTURE.md) for why offsets rather than values are the thing that
has to be faithful, and [TESTING.md](TESTING.md) for each gate and its mutations.

| # | | Task | Effort | |
|---|---|---|---|---|
| P11.1 | ✅ | The 16-bit id corpus, surveyed — and the number that decides is not the one I first counted. | XL | [log](LOG.md#p11-1) |
| P11.2 | ✅ | KEEN DREAMS PLAYS. | — | [log](LOG.md#p11-2) |
| P11.3 | ✅ | Catacomb 3-D BUILDS | — | [log](LOG.md#p11-3) |
| P11.4 | 🔴 | Catacomb 3-D's view needs code the program WRITES AT RUN TIME, and that is a boundary rather than a gap. | M | [log](LOG.md#p11-4) |
| P11.5 | 🟡 | Keen Dreams PLAYS IN THE BROWSER, by a person: `KDREAMS` on the DOS shelf, a `borland16` host that ties pcirq's virtual clock to the wall (interrupts stay where virtual time puts them), real keys through port 60h and IRQ1, the EGA composed as palette indices. Title, control panel, world map, Keen walking. Not yet: sound (PC speaker, then an OPL2 neither project has). | M | [log](LOG.md#p11-5) |
| P11.6 | ⚪ | Keen 4-6, for the oracle nothing else gives. | L | [log](LOG.md#p11-6) |
| P11.7 | 🟡 | The data of the other 16-bit id titles, verified against their sources by decoding (done); the targets themselves (not started) | S | [log](LOG.md#p11-7) |
| P11.8 | 🟡 | What is still open on the 16-bit runtime: the far-pointer 64K wrap and errno; the pixel reference is DONE (`gate-keen-pixels`) | M | [log](LOG.md#p11-8) |

## P12 · More machines, and a second renderer

The corpus was read for what else it ships, and it ships a lot: Quake II carries `irix/ linux/
solaris/ rhapsody/ win32/ unix/ null/` **and two renderers**, `ref_soft/` and `ref_gl/`; Quake
carries sixteen `gl_*.c` files and `vid_svgalib.c` beside the four platform layers already built.

Two different kinds of thing, and the distinction is the same one the shell now makes on screen:

* a **MACHINE** is a platform layer -- a new entry in the shelf, priced by what it reaches for below
  the library boundary, exactly as the Hosts section above prices them;
* a **RENDERER** is a graphics option *within* a machine -- the same program, drawing another way.

| # | | Task | Effort | |
|---|---|---|---|---|
| P12.1 | ✅ | Quake II on Solaris is a dedicated server (q2ded), not a client -- and it runs | — | [log](LOG.md#p12-1) |
| P12.2 | 🔴 | IRIX is BLOCKED, and on two things rather than the one I thought. | L | [log](LOG.md#p12-2) |
| P12.3 | ✅ | Quake on svgalib: the default mode is linear, not planar, so P3.5's blocker does not apply -- a fifth platform build | M | [log](LOG.md#p12-3) |
| P12.4 | 🟡 | **GLQUAKE RUNS on PRISM's GL and draws what Mesa draws**: `quake:glx` is the Makefile's glquake.glx (GLQUAKE_OBJS + gl_vidlinuxglx.c on src/env/glx.js). The same source built against Mesa in the oracle (tools/oracle/glx-egl.c) is the reference: at world frame 40 of the demo, 1 of 307,200 pixels differs by more than 8 levels (`gate-glquake`). Getting there took textures, mipmaps, blending, fog, near-plane clipping and four fixes eleven reference scenes found (`gate-gl-scenes`). In the page it is `glquake.glx` on the Linux shelf, on WebGL2, at the descriptor's 72 fps cap, with keys and the mouse as X events. **Quake II's `ref_gl` too** (`quake2:gl`): the renderer linux/Makefile.i386 builds as ref_gl.so -- qgl_linux.c taking the address of all 336 GL 1.1 entry points, gl_fxmesa.c's full-screen fxMesa context (src/env/fxmesa.js), svgalib for input -- held to the same build on Mesa (`gate-quake2-gl`: 3 of 307,200 pixels at swap 120 of demo1). In the page it is `quake2.gl` on the Linux shelf, on WebGL2 at 60 fps (the variant's own cap; ref_gl draws 115-120 unpaced). **Two more Mesa demos** (8.0.1, 2010): morph3d (two-sided lighting) and texobj on both its paths (texture objects, and textures compiled into display lists), held to Mesa by `gate-mesa-demos`; they found glTexImage2D executing instead of compiling inside a list, and gl.h lacking `GL_VERSION_1_1` and 407 of Mesa's GL 1.1 values. **And WGL**: src/env/opengl32.c is opengl32.dll (the wgl context calls, GDI pixel formats, and every gl and wgl export for GetProcAddress) over gl.js, with src/env/wgl.js as its host half. GLQuake's Win32 build (`quake:wgl`, gl_vidnt.c) and Quake II's (`quake2:win32gl`, ref_gl.dll from win32/glw_imp.c and qgl_win.c) draw what the Linux builds draw on Mesa -- 1 and 3 of 307,200 pixels, gates `glquake` and `quake2-gl` -- and both are on the page's Windows shelf (72 and 60 fps). On the way: VirtualAlloc gave fresh memory to every commit inside a reservation (Quake II's hunk leaked to exhaustion), the flattening pass renamed a block-scope FUNCTION declaration as a local (Quake II's MainWndProc was never compiled), and the page never bound the Win32 module table. **Hexen II** (`hexen2`, Raven's 2000 GPL source: Winquake.dsp's GL Release configuration, 60 C files, the MASM left to its id386=0 C twins) runs on the same WGL: its menu draws, and on the Windows shelf it holds 60 fps. It needed MSVC's `_inline` and a case-insensitive tree, winmm's MIDI-stream and aux APIs (answering no device), a real FindFirstFile/_findfirst over the stdio layer's opendir, CopyFile/DeleteFile, and the wgl host pumping input at MsgWaitForMultipleObjects too (an inactive window stops drawing, and focus delivered only at SwapBuffers deadlocked it). Its 1.12 code refuses the demo's pak0, so it runs on the retail CD's data1 patched by Raven's own H2_Patch_v111.exe under Wine; no pixel oracle yet (the code is Win32-only). Not yet: a real-WGL oracle (Wine with MinGW), and GLU for reflect. **Quake III Arena 1.32b** (`quake3`, code/unix/Makefile's linuxquake3, 136 C files) runs in the page on the Linux shelf, in q3dm1 at its 85 fps cap (WebGL2, M1 Pro; 37 before a profile found gl.js's front end allocating per vertex and stringifying the state per triangle, 72 before GL_EXT_compiled_vertex_array): the full game's data (the Rerelease CD's pak0-6 and the 1.32b point release's pak7-8; the 1.32 code refuses the 1.11 demo by design), interpreted QVMs, libGL opened by dlopen. On the way: long double as gcc's -mlong-double-64 (`gate-long-double64`), snapvector.nasm's x87 translated (`gate-asm-snapvector`), a variadic function's named parameters laid out below its variadic ones as cdecl does (VM_Call hands &callnum to the interpreter; a `gate-run` case), and glDrawElements, glPolygonOffset, glClipPlane, glColorMask and glGetIntegerv in gl.js. Not yet: a pixel oracle, and the Win32 build (code/win32, for the desktop and its icon). The WebGL path itself is held to a blessed command stream (`gate-webgl-stream`). **Wolfenstein: Enemy Territory** (`et`, the 2010 GPL source, SConscript.core's Linux client: 140 C files plus cgame, qagame and ui as three native modules the engine dlopens) runs in the page on the Linux shelf on the free 2.60b data: its menu at the 85 fps cap, and a game on oasis (`+map oasis`, joined with a bound `team b 1 0`) at about 27 fps at 1024x768 (WebGL2, M1 Pro; 16 before gl.js advertised GL_EXT_compiled_vertex_array, which moves ET and Quake III from one indirect glArrayElement per vertex to glDrawElements). On the way: a module's own `defines` (CGAMEDLL/GAMEDLL/UIDLL) and per-unit module tags in the page (a file built into three modules), access() without the basename guess (it made Sys_LoadDll delete its own module), XLoadQueryFont on a server with no fonts, GCC inline `rdtsc` with a 3 GHz time-stamp counter that counts sleep() (ET picks its graphics preset from it), a gas front end for unix/snd_mixa.spp (`asmTranslate` entries with `syntax: gas`; its C twin is unreachable under __linux__), `[base+index*scale+disp]` operands and C globals as `extern`s, lrintf, a non-variadic function called through a variadic pointer type (vmMain through `int (*)(int, ...)`; a `gate-run` case), the glx and fxMesa hosts reallocating their frame on a size change, and the page resolving `../../` includes. splines/*.cpp is C++: first stood in for by a C shim, now compiled by src/cxx (P14.1). Also: glXMakeCurrent resizes the framebuffer when the window bound has another size (ET's vid_restart to 1024x768 was drawn into the first window's 800x600), and a static's mangled name includes its module (game/bg_sscript.c is in cgame and qagame; cgame's calls reached qagame's copy and its syscall table: "Bad cgame system trap: 581"). **The DGA mouse** (2026-10-04): GLQuake, Quake III and ET read the mouse through XFree86-DGA by default, and this Xlib refused it; their fallback waits for the MotionNotify a real server sends for XWarpPointer, which this one does not send, so ET's menu cursor never left the corner and its first dialog (the player's name) could not be clicked or typed into. XF86DGADirectMouse is now implemented (`gate-dga-mouse`). **And a reversed glDepthRange on WebGL**: the GLQuake family's gl_ztrick draws odd frames into [1, 0.5], WebGL refuses near > far, and Hexen II flickered in game; gl.js orders the range and negates z in the shader (`gate-webgl-stream`, ztrick). Not yet: a pixel oracle; in a map the front end's per-vertex objects (about 16% garbage collection) are what is left. **Tux Racer 0.61 is blocked on C++**: its terrain (quadtree.cpp, quadgeom.cpp, course_quad.cpp, 2,300 lines) uses classes, references, new/delete and operator overloading -- no virtual, no templates -- and PRISM compiles C. | L | [log](LOG.md#p12-4) |
| P12.5 | 🟡 | **OpenGL from the small end: `gears` RUNS, and draws what Mesa draws.** src/env/gl.js is GL 1.1's fixed-function pipeline (matrices, immediate mode, display lists, per-vertex lighting, flat/smooth shading, culling, depth) with a software rasteriser; glut.js the GLUT over it. Against Mesa 22 (llvmpipe) in the oracle, via a surfaceless-EGL GLUT harness (tools/oracle/glut-egl.c): 2-3 of 90,000 pixels differ per frame (`gate-gears`, four defects as red controls); gl.h's 41 constants equal Mesa's (`gate-gl-abi`). In the page it draws through WebGL2 on an OffscreenCanvas (transformation and lighting stay in JS; the GPU rasterises): 1-4 of 90,000 pixels differ from Mesa, by one level. Next: Quake's 63 calls (P12.4). | M | — |

## P15 · OpenGL programs, from the least to the most ambitious

The list the owner was given on 2026-10-03 and that was never written down, re-ranked on 2026-10-04
by what has changed since: Enemy Territory and Tux Racer are done, SDL 1.2 has an OpenGL display
(so "needs an SDL layer" no longer excludes anything), and C++ is no longer a reason to refuse a
program -- only the size of what its C++ asks of src/cxx. Each row says what it would exercise that
nothing here does yet, and what would hold it.

| # | | Task | Effort | |
|---|---|---|---|---|
| P15.1 | ⚪ | **A picture reference for what already runs without one.** Quake III and Enemy Territory against the same build on Mesa (the method of `gate-glquake`: the Linux client built in the oracle, a frame compared); Tux Racer likewise. Hexen II's code is Win32-only, so it waits for P15.7. Nothing new runs, but four programs stop being held to nothing. | M | |
| P15.2 | ⚪ | **GLU held to Mesa's**, and `reflect` with it. src/env/glu.js was written for Tux Racer (gluPerspective, gluSphere, gluBuild2DMipmaps, gluScaleImage) against no reference; Mesa's libGLU is in the oracle. `reflect` is the mesa-demo that needs quadrics. | S | |
| P15.3 | ⚪ | **The other mesa-demos**: isosurf, fire, tunnel, teapot, gloss, ray. No data, each comparable to Mesa pixel for pixel through the harness `gate-mesa-demos` already has. Each one is a small slice of GL 1.1 nothing else here asks for (evaluators for teapot, texgen and multipass for gloss). | S each | |
| P15.4 | ⚪ | **Mark Kilgard's GLUT demos** (atlantis, dinospin, ...): classic GLUT C, no data, the same harness. | S each | |
| P15.5 | ⚪ | **The Red Book's examples** (OpenGL Programming Guide): one small program per GL 1.1 feature. Not games, a COVERAGE instrument -- run as a batch against Mesa they would say which entry points gl.js still lacks, the way c-testsuite does for the compiler. | M | |
| P15.6 | ⚪ | **Quake III's Win32 build** (code/win32) on the WGL layer GLQuake and Hexen II already use: the desktop entry and its icon, and a second program on wgl.js. Data already here. | M | |
| P15.7 | ⚪ | **The NeHe tutorials, Win32 versions**: small programs that are mostly WGL and window handling -- a test bench for opengl32.c, and with Wine and MinGW in the oracle (a package install to ask for) the REAL-WGL reference P12.4 still lacks. | M | |
| P15.8 | ⚪ | **GLQuakeWorld (`glqwcl`) and HexenWorld**, from the trees and the data already here. What they add is not GL but a client that only exists against a server: QuakeWorld's protocol over a loopback inside the page. | M each | |
| P15.9 | ⚪ | **Return to Castle Wolfenstein**: id Tech 3 again, GPL source, playable demos (a download to ask for). After Quake III and Enemy Territory the engine work is mostly done; its single-player game code and its own splines are what is new. | M | |
| P15.10 | ⚪ | **GL through SDL**: PrBoom (Doom in GL, on the Doom data already here), Neverball, D2X (Descent II in GL, an early C version), GLtron (GLUT or SDL, to check). SDL 1.2's OpenGL display exists since Tux Racer's SDL build, so these are ordinary targets now; each brings its own slice of SDL (joysticks, SDL_net, SDL_ttf). | M each | |
| P15.11 | ⚪ | **xscreensaver's GL hacks**: about 200 small C programs on GLX and GLU. Breadth rather than depth -- a batch that says what fraction of real GL 1.x programs this layer runs. Needs P15.2. | L | |
| P15.12 | ⚪ | **Cube** (2002): about 10,000 lines of C++ on SDL 1.2, OpenGL and SDL_mixer, with its own containers and no exceptions or STL. The first GL program that would be chosen FOR its C++: it needs function templates (P14.3). Sauerbraten is the same author's larger engine, after it. | M, after P14.3 | |
| P15.13 | ⚪ | **The large C++ engines**: Aleph One (Marathon), Armagetron, BZFlag, FreeSpace 2, Jedi Outcast and Jedi Academy, Doom 3. Each needs the STL or most of what P14.3 lists; they are here so that the list is complete, not because one is next. | XL | |
| P15.14 | 🔴 | **Star Trek: Elite Force (Holomatch)**: the multiplayer source is C on Quake III's base, but its data is commercial and none is here. | — | |

## P14 · C++

PRISM compiled C. Two programs in the corpus stopped on that: Tux Racer (its terrain is C++) and
Enemy Territory, whose camera splines are a small C++ library the C engine calls through three
`extern "C"` functions. The front end is the cfront plan: `src/cxx` parses C++ (parse.js), resolves
it (sema*.js) and writes C, which the existing compiler takes as any other unit -- so every C gate
stays what holds the back end, and the C++ gates hold only what is new.

| # | | Task | Effort | |
|---|---|---|---|---|
| P14.1 | ✅ | **ET's splines compile as C++ and the shim is gone.** A unit is C++ by its file name (.cpp, .cc, .cxx), in a target and in the page. Done: classes with single and multiple inheritance (a second polymorphic base refused), constructors with initialiser lists in declaration order, destructors at every scope exit, implicit default/copy constructors, operator= and destructors where a member needs them, virtual functions and destructors, static members, friends, operator overloading and conversion functions, references, default arguments, overload resolution by the standard's ranks (an ambiguity is an error), temporaries destroyed at the end of the full expression, new/delete and new[]/delete[] with a count kept in front, class templates instantiated when used with their out-of-line members, objects at file scope constructed before main and destroyed at exit, static locals, the named casts, `extern "C"`. Held to g++ by `gate-cxx` (ten programs) and `gate-cxx-splines` (ET's own string and maths classes, 25 of 25 lines). PRISM's C headers became C++-clean as glibc's and Xlib's are (`c_class`, no `bool` macro). The oracle image gained g++. | L | |
| P14.5 | ✅ | **TUX RACER 0.61 runs in the page**, the first game here whose C++ is part of the game: its course is a quadtree in C++ (quadtree.cpp, quadgeom.cpp, course_quad.cpp) beside 69 C files, and its courses are Tcl scripts run by the real Tcl 8.4.20 library built from source (75 files). On the Linux shelf it races Frozen River at the page's 60 fps cap (WebGL2). What it took, besides src/cxx: **two defects of the C compiler** that Tcl found -- a K&R parameter of array type was not decayed, and a function declared in several units took the type of whichever unit declared it last (`gate-run`, `gate-tcl`); **libc** -- write(1) and write(2) were dropped on i386, lseek left errno stale, some thirty POSIX names (strtoll exact to 64 bits, the re-entrant time functions, sys/wait.h, utime.h, grp.h, sys/utsname.h, termios and ioctl constants, `timezone` and `environ` as their own environments; fork, pipe, sockets fail as they do where there are none); **gcc 2.95's lenient token paste** as a target option (`compile.lenientPaste`); **GL** -- GL_COLOR_MATERIAL (ignored in silence until then: the terrain's snow, ice and rock layers blend by per-vertex alpha through it), glTexGen in GL_OBJECT_LINEAR and GL_SPHERE_MAP, the normal array, glMultMatrix, glRect, GL_UNPACK_ALIGNMENT, each held to Mesa by a new scene of `gate-gl-scenes`; an unimplemented capability is now named when enabled; **GLU** (src/env/glu.js: gluPerspective, gluSphere, gluBuild2DMipmaps, gluScaleImage) and **GLUT's input half** (keys with their releases, the mouse, game mode). **Then its SDL build, for the sound**: the target moved from GLUT to SDL 1.2 with SDL_mixer (HAVE_SDL, HAVE_SDL_MIXER), the build the game has sound in. src/env/sdl12.js gained an OpenGL display (SDL_SetVideoMode with SDL_OPENGL over gl.js, SDL_GL_SwapBuffers), the whole US keyboard, the mouse as SDL events, and SDL_RWFromFile; src/env/sdlmixer.js, silent until then, loads WAV files, converts them as SDL 1.2 does (rates only halved or doubled, in place) and mixes eight channels with chunk and channel volumes and seamless loops, pumped by the clock where the program yields to SDL since there is no audio thread. `gate-sdl-mixer` holds the mixed stream byte for byte to the real SDL 1.2.15 and SDL_mixer 1.2.12 on three devices; the reference settled three things a reading of the API would not: a stereo pair is averaged by a division that rounds toward zero, a volume scales the same way, and an unsigned 8-bit sum saturates at 254. In the page the buffers go to the ring the worklet plays (22050 Hz stereo, 2048 frames a buffer). Not yet: the music (five Impulse Tracker modules; Mix_LoadMUS fails as a build without MikMod does), a time-limited Mix_PlayChannelTimed, fades, ADPCM WAV files; a pixel oracle for the game itself, GLU held to a reference. | L | |
| P14.2 | ✅ | **The option**: `compile.cxx` in a target, `cxx` given to compile(). `false` makes every unit C; `true` or nothing decides by file name as gcc does; an object carries `std` (the dialect a target SAYS it was written in -- c++98, gnu++98, c++03, gnu++03 are one implementation here, and anything newer is refused by name) and `language`, a per-unit override like gcc's -x (`{ "src/foo.c": "c++", "*.inl": "c++", "*": "c" }`: exact path, then `*.ext`, then `*`). et and tuxracer state gnu++98. Live C compiles .cpp files, has a language choice (by file name, C, C++) and a C++ example. Ten checks in `gate-cxx`, each a build that must work beside the same build that must not. | S | |
| P14.3 | ⚪ | **What the splines did not need**, each refused by name today: namespaces and `using`, exceptions, RTTI and dynamic_cast, member templates and function templates, template non-type parameters and specialisations, pointers to members, virtual bases, multiple inheritance from a second polymorphic base, bit-exact Itanium layout (the vptr follows the bases here). Tux Racer needs none of the first group; ScummVM needs namespaces, function templates and specialisations. | L | |
| P14.4 | ✅ | **ET's camera code runs as under g++.** The shipped data has no camera file, so the game never executes idCameraDef; `gate-cxx-camera` does, with a driver standing in for the engine: 63 of 63 lines against g++ on a spline, an interpolated and a fixed camera, and a save. | M | |

## P13 · Artefacts: a static bundle, an IR with objects, a second backend, and Live C

Today PRISM has no artefact at all: the page compiles the source every time (Quake's 430 files in
666 ms), `compileProgram` takes every unit at once and fixes every address at link, and the only
output is the JavaScript it runs. That was the right bet for a compiler whose value was the chain
from unmodified source to a running program. These rows are what comes after it -- in an order
where each one is useful on its own and none closes a door the next needs.

| # | | Task | Effort | |
|---|---|---|---|---|
| P13.1 | 🟡 | **A static bundle of a whole program**, loadable without compiling it (`tools/bundle.mjs`): `dist/<name>.js` -- the emitted JavaScript as a function the engine parses on import, and the link tables (name to address, function to table index, the slice of a function's type the runtime reads) -- and `dist/<name>.bin`, the 64 KB pages of the linked image that hold anything. `snapshotProgram` takes it at the one moment it can be taken (linked, nothing installed or run); `loadSnapshot` rebuilds the program in the order compileProgramInner finishes in, and the environments are installed around it as after a compile. **Held** by gate-bundle on Lua (the bundled interpreter prints what the compiled one prints and what the script must print; a blanked page or shifted table indices do not pass) and on MAME 0.34 by frames (P16.11). Lua: 4.3 s to compile, 0.5 s to load and run. **Open:** (a) the loader still LIVES in src/compile.js, so the page imports the compiler's code although none of it runs -- move loadSnapshot, the runner and the builtin binding into a module of their own; (b) refused by name, not yet carried: paged builds (vgaplanar), translated assembly, TASM modules, shared modules -- so Quake, Keen Dreams and the Quake II family are not bundled yet; (c) the page path is tried on MAME only. | S–M | — |
| P13.2 | ⚪ | **An IR, designed around SEPARATE OBJECTS.** A per-unit "PRISM object" -- IR, symbols, relocations, data -- a linker over them, archives (`.lib`/`.a`) and shared modules (`.so`/`.dll`, whose namespaces and `.def` exports P7.3 already models). It buys incremental builds, a pre-built libc, libraries shipped as objects, and a serialised form for the second load mode of P2.5. And it is where the whole-program optimiser lives (P2.2: escape analysis, mem2reg, alignment, direct calls generalised), which is what P2.3 is really asking for. `src/ir/` and `src/opt/` are empty today. | L | — |
| P13.3 | ⚪ | **A WASM backend, from that IR** -- a second backend, not a replacement. ARCHITECTURE's bet on readable JavaScript stands (it is the first debugging lever, and every gate reads emitted JS); WASM earns a place only by a number: `bench.mjs` against the JS backend on the same IR. Where it should win: 64-bit integers natively instead of BigInt (P0.5c), and memory accesses without a DataView call. What it must keep: the safepoint (a loop that calls nothing still has to be observable), the device windows (EGA at A000h becomes an import), and zero wrong answers. | L | — |
| P13.4 | ⚪ | **Live C as a real sandbox.** `web/live/` exists (P1.6): files, Run, the program's output, the emitted JS beside it, stdin. What it lacks: choosing the ABI model (i386, dos16m), several files and headers, the refusals and unresolved symbols the shell already reports, a program shared by URL -- and later, an IR pane beside the JS one. | S–M | — |

## MIRAGE + PRISM: where the two projects meet

The division of labour, stated as the north star it is: **MIRAGE owns the low level, PRISM owns the
high level, and they meet at the device boundary.** Not at the CPU — PRISM has none and wants none.

That boundary is more precise than it sounds, and it is already implemented on MIRAGE's side. A
MIRAGE device installs itself with `installVGA(machine)` and asks its host for almost nothing:

| What a MIRAGE device needs | Count in `vga.js` / `keyboard.js` |
| `machine.onPortWrite(port, fn)` | 7 / 4 |
| `machine.onPortRead(port, fn)` | 3 / 4 |
| `machine.mem` | 1 |
| fields it hangs itself on (`machine.vga`, `keyQueue`, `pic`) | 3 |

So a **PRISM adapter is a `machine` object of about forty lines**: a port-dispatch table, and `mem`
pointing at PRISM's guest image — whose low megabyte is already reserved, so 0xA0000 and 0xB8000 are
already the addresses the devices expect. What feeds the dispatch is the `inportb`/`outportb`
intrinsic, because **a port write is the universal low-level verb**: MIRAGE reaches it from an
emulated `out dx, al`, PRISM reaches it from a compiled function call, and the device cannot tell.

### The recommended order

| # | Step | Why it is first |
| 1 | **P5.1 — the `inportb`/`outportb` intrinsics** | Everything hinges on this one piece. It IS the seam, and the same two intrinsics separately unlock MAME's own `msdos.c` (P1.7) and Quake's `sys_dos.c`. Nothing else in the roadmap has three payoffs. |
| 2 | **The `machine` adapter** (~40 lines) | Lets any MIRAGE device install into PRISM unchanged. |
| 3 | **First device: the PIT** | Quake's `Sys_FloatTime` needs only channel-0 latch-and-read plus the BIOS tick at 0x46C. Small enough to prove the seam end to end, and real time is what fixes game speed from inside the program. |
| 4 | **Keyboard** | MIRAGE's `keyboard.js` already models scancodes AND the BIOS queue — the same two-question distinction PRISM re-invented in `src/env/webhost.js`. Converging removes a duplicate, it does not add a dependency. |
| 5 | **VGA** | **Free for mode 13h**: a linear framebuffer at an address PRISM already has, so it is only memory. **Not free for planar**: EGA/VGA latches and masks need a write barrier on the 0xA0000 window, and that is exactly the memory-dispatch cliff MIRAGE measured (three strategies built and rejected). Decide it on a number, not before. |
| 6 | **The renderer** | PRISM's shell re-implemented MIRAGE's text mode, down to using its font ROM. Adopting `video.js` deletes that duplication outright. |

### What does NOT converge, and the honest limits

* **The compiler and the recompiler share nothing.** One translates C, the other x86. Do not force it.
  ⚠️ **This line is now load-bearing, and P11.4 is where it bites.** Catacomb 3-D writes x86 into
  memory at run time and calls it; a translator that reads a source file once cannot express that,
  and MIRAGE's whole design can. So the first REAL argument for meeting at the CPU has arrived, and
  it should be answered on purpose rather than by drifting into it: PRISM growing an x86 executor
  and MIRAGE lending one are both defensible, and there are now **two** x86 semantics in the family
  (MIRAGE's recompiler, PRISM's `tasm16.js`) — a third would be a fork, not an economy.
* **The seam is asymmetric.** MIRAGE's devices assume a CPU that traps I/O and memory; PRISM traps
  function calls. Thin for ports, thick for memory — see step 5.
* **A DEVICE is the sanctioned borrow; a CPU is not.** If something is to be taken from MIRAGE, the
  cheap and already-designed case is a device behind the ~40-line `machine` adapter. The first one
  that would pay for itself is an **OPL2** for Keen Dreams' and Catacomb's sound (P11.5) — except
  that neither project has one today, so that particular borrow does not exist yet.
* **This does not rescue MIRAGE's blocked list in general.** MIRAGE cannot run DPMI titles, and PRISM
  can only reach a program whose SOURCE was published. Doom qualifies (the Linux tree). OMF, Jazz and
  Zone 66 never will. The union is "published source **and** hardware needs", not "everything".
* **The 16-bit id titles are now in BOTH projects' reach, which is new.** MIRAGE runs them from the
  binary; PRISM compiles them from source (P11). That makes them the one place where the two can be
  run against each other on the same program — a comparison neither could make before.
* **The dependency needs a decision that has been deferred once already.** PRISM currently vendors
  MIRAGE's 8x16 font rather than importing it. Importing `src/vga.js` for real means committing to a
  sibling checkout or to publishing MIRAGE as a package. Choose before step 5, not during it.

## Hosts — which machine PRISM pretends to be

A program of this era does not have *a* platform layer, it ships several: Quake carries `sys_dos.c`,
`sys_linux.c`, `sys_sun.c` and `sys_win.c`, and picks one in its makefile. PRISM's job is to be one
more entry in that list. So the question is not "how do we port this" but **which host do we choose,
and what does that host cost.**

The cost has a single measure, and it is worth stating as a rule:

> **A host costs what the program reaches for BELOW the library boundary.**
> Implementing an interface is a shim and is cheap. Answering a program that talks to hardware means
> emulating a device — which is MIRAGE's job, and where PRISM stops being the cheap way round.

Descriptors name the host (the `platform` field becomes `host`, layers move under `src/env/hosts/`).
That is naming what already exists — `mame-osd`, `quake` — not a framework. **No host framework is to
be designed before two programs demonstrably need the same host**; the rule against anticipation
applies here more than anywhere, because a host abstraction invented up front would be shaped by
imagination rather than by a linker's complaints.

| Host | Surface, measured | Serves | Verdict |
| **Sun** | `sys_sun.c` is **352 lines** and calls almost nothing but ISO C that PRISM already has. The entire gap is **8 POSIX functions**: `gettimeofday getpagesize mmap mprotect munmap read select mkdir` — and `mmap` is only used to allocate the hunk, `mprotect` is a no-op, `getpagesize` is 4096. | Quake | ✅ **Start here.** The cheapest host by a wide margin, and written for a machine where `id386 = 0` — which is exactly the configuration PRISM already compiles. It brings a real `gettimeofday`-driven `main()`, which fixes game speed *from inside the program* instead of through the `+host_framerate` cvar the descriptor currently passes. |
| **Linux** | `sys_linux.c` is 457 lines: Sun's set plus `sys/ipc`, `sys/shm`, `sys/wait`, `sys/mman`. Video is `vid_x.c`, ~25 Xlib calls including the XShm extension. | Quake **and Doom** | ✅ **The strategic one.** `linuxdoom-1.10` is the only Doom source that exists, so P4 requires this host whatever else happens. Its POSIX half is a superset of Sun's, so building Sun first is building this. |
| **DOS** | `sys_dos.c` is 953 lines. Two asm intrinsics (`inportb`/`outportb` via `pc.h`), a software PIT (Sys_FloatTime latches channel 0 and reads the BIOS tick at 0x46C — no interrupt needed), DPMI shims that are mostly no-ops, and `real2ptr` which already works because the low megabyte is reserved. Video is far heavier: `vid_dos.c`/`vid_vga.c` program VGA registers and use tweaked modes, and `in_dos.c` hooks INT 9. | MAME (its ONLY backend) and Quake | 🟡 **Eventually, and in halves.** The system half is within reach once P5.1 exists — and those same two intrinsics unlock MAME's `msdos.c` (P1.7), so the piece is shared. The video half is a different project: registers and interrupts are device emulation, not shimming. |
| **Windows** | `sys_win.c` is 893 lines and pulls in `winquake.h`, `conproc.h`, `resource.h` — the Win32 surface, DirectDraw/DIB, threads, the registry. | Quake only | ⛔ **No.** The largest surface for zero unique coverage: every program that ships a Windows layer ships a DOS or Unix one too. It would earn its place only for a program whose *only* source is Windows, and this project has none. |

The ordering consequence contradicts the plan as written, so it is recorded here rather than left
implicit: the plan put the DJGPP shim in P3 and POSIX+Xlib in P4, but POSIX is **cheaper and serves
more targets**. Doom needs it regardless, Quake accepts it, and only MAME 0.1 — which has no Unix
backend at all, being DOS-only 1997 code — needs DOS.

One caveat to state before somebody expects otherwise: **an Xlib host shims the library, not the
protocol.** `XOpenDisplay` returns a fake `Display *` and `XPutImage` lands in our framebuffer.
Nothing speaks to a real X server, and nothing should.

## Noted and not taken — decisions that are not mine

| # | What | Why it stopped |

| # | | Task | Effort | |
|---|---|---|---|---|
| N1 | ⚪ | Arithmetic on a bitfield WIDER than 32 bits. | — | [log](LOG.md#n1) |
| N2 | ⚪ | `long double` | — | [log](LOG.md#n2) |
| N3 | ⚪ | A Descent WAD. | — | [log](LOG.md#n3) |
| N4 | ⚪ | A `.rc` resource compiler | — | [log](LOG.md#n4) |
| N5 | ✅ | Open Watcom is in the oracle container. | — | [log](LOG.md#n5) |
| N6 | ⚪ | Quake II on RHAPSODY | — | [log](LOG.md#n6) |
| N7 | ⚪ | 4:3 pixel-aspect correction. | — | [log](LOG.md#n7) |
