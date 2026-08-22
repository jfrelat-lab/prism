# PRISM — Compatibility

What actually runs. The point of this file is that "what runs" is never inferred from "what is
written": a row here means a gate observed it, not that the code looks capable of it.

| Target | Status |
|---|---|
| a hosted C program using the supported subset | ✅ **runs** — 29/29 hand programs, 193/219 c-testsuite, 1213/1555 gcc torture |
| nested functions, compound literals as lvalues, non-empty inline asm, GNU complex, `long double`, labels nested in a block | ⛔ tier-0 gaps, each a clear error not a miscompile (P0.5b, ranked by measurement) |
| a wrong answer anywhere in the corpus | ✅ **none** — every failure is a named refusal, never a silent miscompile |
| **MAME 0.1** | 🌅 **COMPILES AND RUNS, emulated CPU misbehaves.** 18 units, 894 functions, 0.55 MB of emitted JS. Prints its banner, creates a 224×288 display (Pac-Man's real resolution), obtains its 16 pens, draws frames, and with real ROMs the reset vector is correct (`DI; LD A,3Fh; LD I,A; JP 230Bh`) and the game clears video RAM to 0x40. But the screen stays black: **`Z80_Running` goes to 0 with one T-state consumed of 51200**, and the game's fill loop sweeps past video RAM into the interrupt latch at 0x5000. A hand-written six-opcode Z80 ROM works exactly as predicted, so this is PRISM miscompiling something in Z80.c that a short loop does not reach. Next: a differential against a gcc-built Z80.c. |
| Quake (`WinQuake/`, `id386=0`) | ⛔ P3 |
| Doom (`linuxdoom-1.10`) | ⛔ P4 |

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
