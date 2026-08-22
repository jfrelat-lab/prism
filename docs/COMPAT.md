# PRISM — Compatibility

What actually runs. The point of this file is that "what runs" is never inferred from "what is
written": a row here means a gate observed it, not that the code looks capable of it.

| Target | Status |
|---|---|
| a hosted C program using the supported subset | ✅ **runs** — 26/26 hand programs, 191/219 c-testsuite, 1108/1555 gcc torture |
| `<stdarg.h>`, `goto`, nested functions, compound literals, non-empty inline asm, `long double` | ⛔ tier-0 gaps, each a clear error not a miscompile (P0.5b, ranked by measurement) |
| a wrong answer anywhere in the corpus | ✅ **none** — every failure is a named refusal, never a silent miscompile |
| MAME 0.1 | ⛔ P1 |
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
