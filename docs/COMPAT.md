# PRISM — Compatibility

What actually runs. The point of this file is that "what runs" is never inferred from "what is
written": a row here means a gate observed it, not that the code looks capable of it.

| Target | Status |
|---|---|
| a hosted C program using the supported subset | ✅ **runs** — 29/29 hand programs, 193/219 c-testsuite, 1214/1556 gcc torture |
| nested functions, compound literals as lvalues, non-empty inline asm, GNU complex, `long double`, labels nested in a block | ⛔ tier-0 gaps, each a clear error not a miscompile (P0.5b, ranked by measurement) |
| a wrong answer anywhere in the corpus | ✅ **none** — every failure is a named refusal, never a silent miscompile |
| **MAME 0.1 — all five drivers** | ✅ **BIT-IDENTICAL TO A NATIVE gcc BUILD** — see the table below. Game ROMs are supplied by the user, never fetched. |
| Quake (`WinQuake/`, `id386=0`) | 🟡 **COMPILES AND RUNS** — 69 units, 44,570 lines, **1030 of 1039 functions**, 1.67 MB of emitted JavaScript. Reaches `Host_Init`, mounts its filesystem, identifies itself as shareware and stops at `W_LoadWadFile: couldn't load gfx.wad`, which is the correct behaviour with no `id1/pak0.pak`. The 9 functions that do not emit are one class: a label nested inside a block (8) and a goto into a nested block (1); they throw if called. Game data is supplied by the user, never fetched. |
| Doom (`linuxdoom-1.10`) | ⛔ P4 |

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
| **MAME 0.1** | [SourceForge `mame/0.1/mame01.zip`](https://sourceforge.net/projects/mame/files/mame/0.1/) — 210 kB, 1997-02-05 | DOS / DJGPP + **Allegro** | Smallest real target: C89, integer-only, ROM-driven and therefore deterministic. Allegro is shimmed, not compiled. |
| **Quake** | [`id-Software/Quake`](https://github.com/id-Software/Quake) → `WinQuake/`: 308 files, **128 `.c`**, 21 `.s` (GAS), 0 `.asm` | **DOS / DJGPP** | The complete DOS port is present: `dos_v2.c dosisms.h sys_dos.c sys_dosa.s in_dos.c snd_dos.c net_dos.c vid_dos.c vid_vga.c vid_ext.c vgamodes.h dosasm.s`. `id386=0` selects the C equivalent of every `.s`, so the first pass needs no assembler. `QW/` additionally carries MASM `.asm` variants and depends on SciTech MGL — `WinQuake/` is the tree to use. |
| **Doom** | [`id-Software/DOOM`](https://github.com/id-Software/DOOM) → `linuxdoom-1.10/`: 138 files, 62 `.c`, 62 `.h`; plus `ipx/` (DOS, Watcom) | **Linux / X11 — not DOS** | ⚠️ **The DOS/Watcom Doom source was never released.** The system layer is `i_main.c i_system.c i_video.c i_sound.c i_net.c`, and `i_video.c` is X11. Compiling the original unmodified therefore means shimming POSIX + Xlib, not DOS. |

The ordering consequence — MAME 0.1 first, Doom last — is the reverse of the obvious one, and it
comes from these three rows.
