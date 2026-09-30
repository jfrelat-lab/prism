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
**C89/C99 + GNU, no C++**. It **translates a program's own assembly from its source** — Borland
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
| 4 | **OpenGL onto WebGL, from the small end**: Brian Paul's `gears` first (a few GL calls, the classic smoke test; `glxgears` adds GLX on the X11 shim), then GLQuake and Quake II's `ref_gl` (63 GL functions, measured). | P12.5, P12.4 | M, then L |

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
| P7.12 | ⚪ | **NetHack.** 133 units in `src/` and its own `sys/msdos` and `sys/unix` ports: pick the platform layer the way Quake's were picked, from the tree's own makefiles. No game data to fetch or license -- the dungeon is the program -- and no graphics: it stresses what the games do not, the libc, the file layer (save files, bones, the high-score file with its locking) and a terminal (tty, termcap/curses or the DOS console). A tty on the page is the text surface the shell already has. | M | — |

## P8 · Semantic oracles: Lua, the MAME releases, and what they found

| # | | Task | Effort | |
|---|---|---|---|---|
| P8.1 | ✅ | Lua 5.4 runs | M | [log](LOG.md#p8-1) |
| P8.2 | ✅ | A C string is BYTES. | S | [log](LOG.md#p8-2) |
| P8.3 | ✅ | `%f` expands in BigInt. | S | [log](LOG.md#p8-3) |
| P8.4 | ✅ | Lua's own test suite as a gate (tools/gate-lua.mjs): 14 passing files to 16, 5 failing to 1 | M | [log](LOG.md#p8-4) |
| P8.5 | ✅ | MAME 0.1 through 0.4, from one harness. | S | [log](LOG.md#p8-5) |
| P8.6 | ✅ | clangsay, the smallest target, and the Duff's device it found on its first build | S | [log](LOG.md#p8-6) |
| P8.7 | ⚪ | Descent: not a candidate until P5.2. | — | [log](LOG.md#p8-7) |
| P8.8 | ✅ | The menus answer the keyboard. | S | [log](LOG.md#p8-8) |
| P8.9 | ✅ | Six printf defects, from Lua's own assertions. | M | [log](LOG.md#p8-9) |
| P8.10 | ✅ | files.lua's i/o tests had been SKIPPED since directories landed, and five stdio defects sat under them: `/tmp` seeded in the wrong namespace, so every temporary file was refused; a reader's bytes snapshotted at open, so it never saw another handle's writes; `mktime` not normalising its struct (a wrong-answer class, now a gate-run case); `tmpfile` answering NULL; `setvbuf` ignored. | S | — |
| P8.11 | ⚪ | Should files be fully buffered by default, as C99 7.19.3p7 says? Today a stream buffers only when `setvbuf` asks, so every target's writes are visible at once; changing the default changes that for all seventeen. A decision, not a fix. | S | — |
| P8.12 | ✅ | `atexit` handlers run: in reverse order of registration, on `exit()` and on a return from `main`, then every stream is flushed; `_exit` does neither (C99 7.20.4.3). They had been recorded and never run. gate-run: `atexit-reverse-order`, `atexit-from-exit`. | S | — |

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
| P12.4 | 🔴 | OPENGL -- `ref_gl` and Quake's sixteen `gl_*.c`. | L | [log](LOG.md#p12-4) |
| P12.5 | 🟡 | **OpenGL from the small end: `gears` RUNS, and draws what Mesa draws.** src/env/gl.js is GL 1.1's fixed-function pipeline (matrices, immediate mode, display lists, per-vertex lighting, flat/smooth shading, culling, depth) with a software rasteriser; glut.js the GLUT over it. Against Mesa 22 (llvmpipe) in the oracle, via a surfaceless-EGL GLUT harness (tools/oracle/glut-egl.c): 2-3 of 90,000 pixels differ per frame (`gate-gears`, four defects as red controls); gl.h's 41 constants equal Mesa's (`gate-gl-abi`). In the page it draws through WebGL2 on an OffscreenCanvas (transformation and lighting stay in JS; the GPU rasterises): 1-4 of 90,000 pixels differ from Mesa, by one level. Next: Quake's 63 calls (P12.4). | M | — |

## P13 · Artefacts: a static bundle, an IR with objects, a second backend, and Live C

Today PRISM has no artefact at all: the page compiles the source every time (Quake's 430 files in
666 ms), `compileProgram` takes every unit at once and fixes every address at link, and the only
output is the JavaScript it runs. That was the right bet for a compiler whose value was the chain
from unmodified source to a running program. These rows are what comes after it -- in an order
where each one is useful on its own and none closes a door the next needs.

| # | | Task | Effort | |
|---|---|---|---|---|
| P13.1 | ⚪ | **A static bundle of a whole program**, loadable without the compiler: the emitted functions, the linked memory image, the environment list and a small loader, as `dist/<target>.js`. Emscripten's deliverable -- a game as one JavaScript file -- without Emscripten's porting, since the libraries are PRISM's and the game is still its own source. NEEDS NO IR: tier-0's output is already complete JavaScript and the image is bytes. Measure the start-up it saves (Quake ~1.8 MB of JS, ~0.7 s of compile), and hold it to the page with the pixel gate: same program, same frames. | S–M | — |
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
