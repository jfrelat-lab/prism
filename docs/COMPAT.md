# PRISM — Compatibility

What actually runs. The point of this file is that "what runs" is never inferred from "what is
written": a row here means a gate observed it, not that the code looks capable of it.

| Target | Status |
|---|---|
| a hosted C program using the supported subset | ✅ **runs** — 30/30 hand programs, 197/219 c-testsuite, 1259/1556 gcc torture |
| nested functions, compound literals as lvalues, non-empty inline asm, GNU complex, `long double`, labels nested in a block | ⛔ tier-0 gaps, each a clear error not a miscompile (P0.5b, ranked by measurement) |
| a wrong answer anywhere in the corpus | ✅ **none** — every failure is a named refusal, never a silent miscompile |
| **MAME 0.1 — all five drivers** | ✅ **BIT-IDENTICAL TO A NATIVE gcc BUILD** — see the table below. Game ROMs are supplied by the user, never fetched. Now compiled with **MAME's own DOS platform backend**, `src/msdos/msdos.c`: nothing of MAME is written in JavaScript any more, and what PRISM shims is one level down — Allegro, SEAL and DJGPP's memory helpers. Both of msdos.c's display paths render, 224x288 through the tweaked VGA mode and 640x480 with `-vesa`. | Sound works: SEAL is a real four-voice mixer into a shared ring the page reads (only pengo and ladybug have sound in 0.1).
| **Quake** (`WinQuake/`, `id386=0`) | ✅ **RENDERS** — 69 units, 44,570 lines, **every function emits**, 1.72 MB of JavaScript. Loads `id1/pak0.pak`, runs its demos, and draws the game at 320x200 in the browser at ~26 fps. Game data is supplied by the user, never fetched. Sound and networking are Quake's own null drivers. |
| **SQLite 3.53.4** (amalgamation) | ✅ **RUNS, AND AGREES WITH gcc** — 269,650 lines in ONE translation unit, 2542 functions, 5.8 MB of emitted JavaScript in **1.5 s** (~180,000 lines/second). Creates a table, inserts 200 rows and answers eight queries — aggregates, an index, ORDER BY, a self join — **byte-identical to an i386 gcc build of the same sources** (`tools/sqlite.mjs --diff`). No platform layer and no data files: where MAME and Quake test whether PRISM can HOST a program, this tests whether it can COMPILE one. |
| **DOOM** (`linuxdoom-1.10`) | 🟢 **PLAYS A REAL LEVEL** — 62 units, 45,152 lines, 714 of 715 functions, 1.11 MB of JavaScript in 0.8 s. Loads `DOOM1.WAD`, draws its title, credits and order screens, and with `-warp 1 1` runs E1M1: 260 frames at ~1 ms each, 320x200, 156 distinct colours on screen, status bar and all. Compiled **entirely unmodified**, X11 and all. Its shareware demos still do not play, and Doom says why itself: `Demo is from a different game version!` — the WAD's demos predate this source. **Sound is the one thing missing, and not for an audio reason:** doomdef.h defines `SNDSERV`, so Doom delegates sound to a separate program. That program (`corpus/DOOM/sndserv`, 2,026 lines) compiles and mixes correctly on its own — what is missing is a process model. |

### MAME 0.1, driver by driver

`node tools/mamediff.mjs --roms=<dir> --game=<name> --frames=200` builds the identical sources with
i386 gcc and with PRISM and compares a hash of every frame. All five drivers MAME 0.1 ships agree:

| Driver | Display | Pens | Frame hashes vs native gcc | Notes |
|---|---|---|---|---|
| `pacman` | 224x288 | 16 | ✅ identical, 226 lines | |
| `mspacman` | 224x288 | 16 | ✅ identical, 226 lines | a different ROM set through the same driver |
| `pengo` | 224x288 | 32 | ✅ identical, 242 lines | twice the palette |
| `crush` | 224x288 | 16 | ✅ identical, 226 lines | |
| `ladybug` | 256x256 | 20 | ✅ identical, 230 lines | different resolution, and the only one that reaches the SOUND path (6 sample calls) |

They are not five runs of the same code: the resolutions, palettes and sound paths differ, which is
what makes the agreement worth stating.

Two harness defects had to be fixed before this table meant anything, and both made a broken run look
like a passing one. `tools/mame.mjs` hardcoded `pacman` as argv[1], so a loop over five names ran
Pac-Man five times and printed five identical framebuffers. And `mamediff`'s scratch directory
persisted between runs, so a stale ROM set let the gcc side load a game PRISM could not see at all —
reported as a compiler divergence. **A differential where the two sides get different inputs is not
measuring what it claims to measure.**

## Upstream sources — verified 2026-08-20

Not vendored; `corpus/` is gitignored and fetched. Verified by listing the actual trees, because two
of the three are not what one assumes.

| Target | Source | Environment | Note |
|---|---|---|---|
| **MAME 0.1** | [SourceForge `mame/0.1/mame01.zip`](https://sourceforge.net/projects/mame/files/mame/0.1/) — 210 kB, 1997-02-05 | DOS / DJGPP + **Allegro** | Smallest real target: C89, integer-only, ROM-driven and therefore deterministic. Allegro and SEAL are shimmed, not compiled; msdos.c itself IS compiled. |
| **Quake** | [`id-Software/Quake`](https://github.com/id-Software/Quake) → `WinQuake/`: 308 files, **128 `.c`**, 21 `.s` (GAS), 0 `.asm` | **DOS / DJGPP** | The complete DOS port is present: `dos_v2.c dosisms.h sys_dos.c sys_dosa.s in_dos.c snd_dos.c net_dos.c vid_dos.c vid_vga.c vid_ext.c vgamodes.h dosasm.s`. `id386=0` selects the C equivalent of every `.s`, so the first pass needs no assembler. `QW/` additionally carries MASM `.asm` variants and depends on SciTech MGL — `WinQuake/` is the tree to use. |
| **Doom** | [`id-Software/DOOM`](https://github.com/id-Software/DOOM) → `linuxdoom-1.10/`: 138 files, 62 `.c`, 62 `.h`; plus `ipx/` (DOS, Watcom) | **Linux / X11 — not DOS** | ⚠️ **The DOS/Watcom Doom source was never released.** The system layer is `i_main.c i_system.c i_video.c i_sound.c i_net.c`, and `i_video.c` is X11. Compiling the original unmodified therefore means shimming POSIX + Xlib, not DOS. |
| **Wolfenstein 3D** | [`id-Software/wolf3d`](https://github.com/id-Software/wolf3d) → `WOLFSRC/`: 26 `.c` (33,118 lines), 10 `.asm` (3,551 lines), 18 inline-asm sites in 6 files | **DOS real mode, 16-bit Borland C** | ⛔ **Not reachable by tier-0 as it stands, and not for the reason expected.** It is not the assembly: it is the ABI. 451 uses of `far`, 68 of `_seg`, 25 of `huge`, 18 of `MK_FP`/`FP_SEG`/`FP_OFF`, and `typedef unsigned int word` — `int` is **16 bits** and the code depends on it. PRISM's one arrêté decision is i386 flat 32-bit with no segmentation and no far pointers, so this is a second ABI, not a harder program. And it is real mode, which is **MIRAGE's** domain: PRISM exists for what MIRAGE cannot reach. |
| **Heretic** / **Hexen** (Raven, 1994-95) | 44 units / 43,394 lines and 54 units / 70,000 lines, from each game's OWN makefile; 2 assembly objects skipped each, **no inline assembly at all** | **DOS, 32-bit flat (Watcom / DOS4GW)** | 🟡 **BOTH COMPILE COMPLETELY** — 759 and 1,212 functions, 1.18 and 1.91 MB of JavaScript, zero functions unemitted. Heretic **starts**: V_Init, M_LoadDefaults, Z_Init taking 8 MB of zone through the DPMI shim, then W_Init reporting no WAD and exiting 1, which is exactly right without one. The opposite of Wolf3D: `far` appears 10 and 9 times against 451, `_seg`/`MK_FP`/`huge` never — PRISM's own ABI. `I_IBM.C`, the file that holds every machine dependency, is compiled unmodified; what is shimmed is `src/env/watcom.js` (int386, the vector table, DPMI, DMX). Needs a WAD to go further. |

The ordering consequence — MAME 0.1 first, Doom last — is the reverse of the obvious one, and it
comes from these three rows.
