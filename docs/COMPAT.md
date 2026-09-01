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
| **Quake, DOS platform** | 77 units / 51,391 lines with `sys_dos.c vid_dos.c vid_vga.c vid_ext.c vregset.c snd_dos.c snd_dma.c snd_mem.c snd_mix.c cd_audio.c in_dos.c dos_v2.c` | **DOS / DJGPP** | 🟢 **PLAYS.** Console, menu, and a started game at 320x200 in mode 13h — 3D renderer, start map, status bar. Zero functions unemitted. Three devices (0x3DA retrace, the DAC, the keyboard controller), the PIT for the clock, and `src/env/go32.js` for DJGPP's DPMI floor; `dos_v2.c` builds all of dosisms.h on top of that. The default video mode programs no VGA registers at all. |
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
| **Heretic** / **Hexen** (Raven, 1994-95) | 44 units / 43,394 lines and 54 units / 70,000 lines, from each game's OWN makefile | **DOS, 32-bit flat (Watcom / DOS4GW)** | 🟢 **HERETIC PLAYS ITS ATTRACT LOOP** — title, credits and the demo, 320x200 with the 3D renderer, monsters and the status bar; 160 colours off the VGA DAC. Both trees compile completely (761 and 1,215 functions). **Hexen** starts, parses its SNDINFO script and draws its start-up screen (255 colours); it stops at `R_TextureNumForName: SKY1 not found` — and that one is **not PRISM's**. `P_SETUP.C:803` defaults every map's sky to `R_TextureNumForName("SKY1")`, and the retail v1.1 HEXEN.WAD contains no texture, patch or lump of that name: reading the WAD directly gives 148 + 1 textures, SKY2/SKY3/SKY4 and no SKY1. PRISM builds exactly those 149 and its lookup is exact (SKY2 → 72, ABADONE → 0, X_WATER4 → 147, case-insensitively, absent → -1). Raven's released source and the shipped data disagree; Hexen needs a WAD that has SKY1. Three devices and no more: the retrace bit at 0x3DA, the colour DAC at 0x3C8/0x3C9, and delivery of the 35 Hz tic — which comes from DMX's `TSM_NewService`, not from the PC timer, because Heretic's own `IO_StartupTimer()` call is commented out in its source. `R_DRAW.C` alone compiles with `__WATCOMC__` undefined, selecting the C inner loops the file already carries — the same switch as Quake's `id386=0`. |

The ordering consequence — MAME 0.1 first, Doom last — is the reverse of the obvious one, and it
comes from these three rows.

## Candidate targets, surveyed

Surveyed by reading the actual released trees, not from memory. The question that decides each one
is always the same, and it is the question Quake's `id386=0` and Heretic's `#ifndef __WATCOMC__`
already answered: **does the program's own source ship a C equivalent of its assembly?** If it does,
a build selects it and nothing is modified. If it does not, the target waits for P5.2.

| candidate | environment | assembly | verdict |
|---|---|---|---|
| **Quake II** (`id-Software/Quake-2`) | C, Win32/Linux — reuses Doom's POSIX side | `ref_soft/` pairs every `.asm` with a `.c` (`r_draw.c`/`r_drawa.asm`, `r_edge.c`/`r_edgea.asm`, `r_scan.c`/`r_scana.asm`, `r_polyse.c`/`r_polysa.asm`): the SAME `id386` switch as Quake 1 | **strongest candidate.** One real obstacle, nameable now: the refresh is a DLL (`ref_soft.def`, `dlopen` on Linux), so the engine loads its renderer instead of linking it. PRISM has a symbol table, so shimming `dlopen` over a statically linked pair is plausible — the same shape as Doom's `popen`. It also ships a `null/` platform, exactly like `sys_null.c`. |
| **Build / Duke Nukem 3D** (`fabiensanglard/vanilla_duke3D`) | Watcom + DOS4GW — the Heretic shim, already built | `SRC/A.ASM` has **`drawing_routines/A.C`, Ken Silverman's own C port, written June 1996 to help the Mac and console port teams** — the id386=0 pattern by another name | **viable, with two caveats stated in his own readme.** A.C is not an exact replacement: `vlineasm4`/`mvlineasm4` are gone and ENGINE.C was simplified alongside it, so this is the author's variant, not the shipped PC build. And `ksqrt`/`krecip` are C replacements of `nsqrtasm`/`krecipasm` that his movement code depends on — recorded demos go out of sync against the original. That matters directly: a pixel diff against the real game would be diffing two different programs. `PRAGMAS.H` is ~100 Watcom `#pragma aux` routines; PRISM already derives `FixedMul`/`FixedDiv2` from that construct for Heretic. |
| **Rise of the Triad** (`videogamepreservation/rott`) | Watcom + DOS4GW — the Heretic shim | 9 `.ASM` files (`RT_DR_A`, `RT_SC_A`, `RT_VH_A`, `RT_FC_A`, `RT_ENG`, `TEXTURE`, `F_SCALE`, `R_SCALE`, `RAND`) and **RT_DRAW.C has no asm-versus-C switch at all** — the assembly is mandatory | **blocked on P5.2.** The environment is free (its `AUDIO_WF.LIB`/`SPBALL.LIB` are prebuilt libraries, the same boundary as DMX), so it becomes cheap the day the assembler exists. Also the 32-bit Wolfenstein lineage, so no 16-bit ABI. |
| **Wolfenstein 3D** | Borland C, 16-bit real mode | 1117 inline `asm` statements in 15 of 26 units, 10 `.ASM` files, 68 uses of `_seg` | **furthest away**, and for three separate reasons. See ROADMAP P7.2: `sizeof(int) == 2` is part of its DATA format, not just its CPU (`maptype` is 38 bytes under Borland, 48 under i386, so every field after `planestart` moves). |

Not yet surveyed, named so the list is a list and not a memory: Descent (Watcom, 32-bit), Shadow
Warrior (same Build engine, so the same answer as Duke3D), later MAME releases while they were still
C (a scaling target, not a new environment), and the non-games — Lua, NetHack — which would stress
the libc and the file layer rather than the video path.

## Doom's demos: why no WAD will ever play them

`g_game.c:1589` rejects a demo whose first byte is not `VERSION`, and `doomdef.h:33` says
`enum { VERSION = 110 }` — the LINUX port's version, 1.10.

The byte tracks the release, which two shareware WADs of IDENTICAL size settle between them:

```
DOOM1.WAD   4,196,020 bytes   shareware   DEMO1-3 first byte = 108      (1.8)
DOOM1.WAD   4,196,020 bytes   shareware   DEMO1-3 first byte = 109      (1.9)
DOOM.WAD   11,159,840 bytes   RETAIL      DEMO1-3 first byte = 109      (registered, E1-E3)
DOOM.WAD   12,408,292 bytes   RETAIL      DEMO1-4 first byte = 109      (Ultimate Doom, E1-E4)
```

Four WADs, and the registered one is worth a note: archive.org dates that item 1993-12, which is the
GAME's release date and not the build's -- the WAD inside is 1.9, with demo lumps byte-for-byte the
same size as Ultimate Doom's. A catalogue date is not a version.

The retail WAD was checked because a deduction is not a measurement, and it carries the same byte as
its shareware sibling of the same release. Running on it closes the loop in the program's own words:

```
DOOM Registered Startup v1.10
W_Init: Init WADfiles.
Demo is from a different game version!
```

The program says 1.10; every WAD says 108 or 109.

1.9 is the last DOS release, and the 1.10 source shipped no WAD of its own, so nothing carries a
110 demo. This is not a shareware-versus-retail question and a different WAD does not fix it. Play
with `-warp 1 1`, which is what tools/doomsnd.mjs does; the attract loop is the only thing lost.

I first stated this as a deduction from Doom's version history. It is now two measurements and a
mechanism, which is a different kind of claim.

### And the answer is not a patch

Two things that look like fixes are not available, and it is worth saying why rather than only that.

`enum { VERSION = 110 }` is an ENUM, not a macro, so no `-DVERSION=109` reaches it: the
preprocessor would substitute the identifier and leave `enum { 109 = 109 };`, which is not C.
Editing that line, or the byte in a WAD, is the one thing this project does not do — the whole claim
is that the ORIGINAL source runs, and a program that only runs after a one-byte edit is a port.

The program already solves it. `g_game.c:1555` writes `*demo_p++ = VERSION` when it RECORDS, so a
demo this build makes carries 110 and this build replays it:

```
node tools/doom... -warp 1 1 -record prism -maxdemo 8
  Demo prism.lmp recorded          8,178 bytes, first byte = 110

              ... -playdemo prism
  200 frames rendered, and no "Demo is from a different game version!"
```

Nothing was modified: the game authored the data, and `-maxdemo 8` fills the buffer so
G_CheckDemoStatus writes the file and quits through the program's own path. What cannot be had is
id's demos; what can be had is demos.

### Does flipping the byte work? Yes — and that is the interesting part

Patching the three DEMO lumps from 109 to 110 in a COPY of the shareware WAD makes id's demos play,
and play CORRECTLY: DEMO1 runs E1M1 and the recorded inputs land where they were recorded --
"YOU GOT THE SHOTGUN!", health 82%, armor 94%.

That is a fact about the FORMAT, not a trick. 1.10's header parse (`g_game.c:1595`) reads thirteen
bytes -- version, skill, episode, map, deathmatch, respawnparm, fastparm, nomonsters, consoleplayer,
playeringame[4] -- which is byte-for-byte the 1.9 header, and its tic record is the same four bytes.
1.10 was the Linux port; it did not change the demo format. So between 109 and 110 the version byte
is a LOCKOUT, not a compatibility guard.

Knowing that does not change what PRISM does. It reads whatever WAD it is handed and never edits
one: the project's claim is that the original source runs on the original data, and a build step
that rewrites the data would end that claim whatever the byte was. But the distinction worth drawing
is WHO edits: a user patching their own copy of their own game is not the compiler patching a
program to make it run. PRISM cannot tell the difference, and should not have to.

## Descent: 62 of its 66 assembly files have no C twin

The question that decided Quake, Duke3D and ROTT decides this one too, and the answer is the
clearest yet. Of 66 `.ASM` files in the 1995 Parallax source, **four** have a `.C` of the same name
beside them. The other 62 include the whole of TEXMAP -- 28 files, which is to say the texture
mapper IS assembly -- the eleven files of the 3D pipeline, the 2D blitter, the BIOS layer and the
fixed-point maths.

So Descent is not a candidate until P5.2, and further from it than ROTT: there is no `id386=0`
here, and no `#ifndef __WATCOMC__`. Measured, not assumed.

## clangsay: the smallest target, and it found a compiler bug on its first build

Said plainly first, because the name invites a wrong assumption: cowsay is a PERL script and a Unix program, so this is a 2016 reimplementation and there is no original C behind it. It proves nothing about running unmodified 1990s source. What it is, is 1,479 lines of C with no graphics, no devices and no data -- argument parsing, a file read, text
wrapping, stdout. It earns its place as a smoke test, and it paid for itself immediately:

```
clangsay: emitted JavaScript did not compile: Unexpected token 'case'
```

libbenly's `file.c:120` writes a case label inside an `if`, which is legal C -- it is what makes
Duff's device work -- and illegal JavaScript, where case clauses must be direct children of the
switch. PRISM emitted it faithfully and the engine refused the result.

The fix was not to refuse it: `flatten.js` already lowers a switch to a dispatch over labels and
gotos, where the nesting stops mattering. A nested case is simply another reason to run that pass.
Refusing it instead cost one c-testsuite program, which is how the wrong fix announced itself.

## The candidate list, with the measurement that ranks it

Every C-language source in videogamepreservation, filtered to things of a size worth the trip:

| candidate | size | why it ranks there |
|---|---|---|
| **Hexen II** (1997) | 2.1 MB C, 183 units | Quake lineage, and `id386` is in its sources — PRISM already runs two members of that family, so the platform work is largely done. **First choice.** |
| **Witchaven, Witchaven II, TekWar** | 13–20 MB C each | Build engine, so Ken Silverman's own `A.C` applies exactly as it does to Duke3D. Large and real. |
| **Micropolis** (SimCity, 2008) | 7.7 MB C | A different KIND of program — a simulation with an X11/Tcl front end. Tests parts of the compiler no shooter touches. |
| **Abuse** (1997), **Star Control 2** | 1.7 MB, 1.0 MB C | Smaller, and both are ports of their own era. |
| **NetHack** | 133 units in src/, and it ships `sys/msdos` | The substantial POSIX answer, and DOS as well. No graphics at all: it would stress the libc and the file layer instead of devices, which nothing in the corpus does. |
| **Lua** | 35 units, **34 files of its own tests** | The highest value per line in the list, and not as a game: its test suite is a SEMANTIC ORACLE, the same role c-testsuite and Csmith play. |

A note on how NOT to measure this family. Comparing `.ASM` stems against `.C` stems is the right test
for Raven and Parallax, where `LINEAR.ASM` sits beside `R_DRAW.C`; it is the WRONG test for anything
descended from Quake, which names its assembly `d_polysa.asm` against `d_polyse.c` and never shares a
stem. For those, the measurement is to compile with `id386=0` and read the undefined-symbol report --
which is exactly what that report was built for.

## Lua 5.4, and the printf bug its own tests found

34 units, 25,957 lines, 1,092 functions, nothing unemitted. It runs:

```
fib:    1,1,2,3,5,8,13,21,34,55
string: prism/42/3.142
sort:   1 3 5 9
pcall:  false   t.lua:7: caught
gsub:   hell0 w0rld    2
```

It is here as an ORACLE, not as another target. Lua ships thirty-three files of its own tests, built
on `assert()`, so running one and reaching `OK` is the check -- and three do:

```
sort.lua      50,000 elements, 852,463 comparisons        OK
math.lua      random ranges over 31,800 calls             OK
bitwise.lua                                               OK
```

`strings.lua` did not, and what it found is a real defect rather than a corner:

    string.format("\0%c\0%c%x\0", 0xE4, 'b', 140)

**Every printf-family writer encoded its result as UTF-8.** A C string is a sequence of bytes with no
encoding of its own, so `%c` with 0xE4 came out as the two bytes `C3 A4` and the result was five
bytes where C says four. `cstr` had the same guess in the other direction, which is why nothing had
noticed: the two were consistently wrong and round-tripped. Both now map one byte to one character,
which is exact for every byte including those no UTF-8 decoder would accept.

That moved strings.lua from line 204 to line 272, where a second one waits and is written down
rather than fixed tonight:

    string.format('%.99f', -1e308)

C's `%f` prints all 309 integer digits. JavaScript's `toFixed` switches to exponential notation
above 1e21, so the result comes back as `-1e+308`. Fixing it means expanding the double exactly,
which BigInt can do.

Two smaller things Lua needed, both plain C89 that PRISM simply lacked: `sig_atomic_t` -- llimits.h
defines `l_signalT` as that, and its absence surfaced as a parse error on a struct field three
headers away -- and `strtod` with a working `endptr`, without which Lua's number parser would read
"10 apples" as ten.

And the duplicate-symbol report earned its keep again on the first build: listing `onelua.c`, Lua's
single-file amalgamation, alongside the units it `#include`s defined all 155 public functions twice.

## The menus, by keyboard

Two programs would not respond to Enter or Escape. One was a defect in PRISM; the other was never
one, and telling them apart took an instrument rather than an argument.

**Doom: `xkey.keycode` was at the wrong offset.** `installX11` wrote the scan code at byte 36 of the
XEvent. Doom reads the field through its own `offsetof`, and it is at 52 -- 36 is `xexpose.count`,
one union arm over. So every key arrived as keycode 0, `XKeycodeToKeysym(0)` returned 0, `xlatekey`
translated nothing, and `M_Responder` was handed `data1 = 0` for Escape, Down and Enter alike.

Escape *looked* like it worked, and that is the part worth keeping. During demo playback
`G_Responder` opens the menu on ANY keydown -- so an undecoded key and a correctly decoded Escape
produce the same picture, and I read the menu opening as evidence that the keysym had arrived. Twice.
What settled it was wrapping `M_Responder` and printing its argument: `type=0 data1=0`, three times
in a row, for three different keys.

The offsets are now measured, not counted:

```
$ node tools/run-one.mjs /tmp/xoff.c
sizeof(XEvent)      = 96
xkey.keycode        = 52
xkey.state          = 48
xexpose.count       = 36
```

which is PRISM compiling `offsetof` against the same header the guest sees. A shim's offsets are part
of the ABI, and the ABI has a gate for a reason; this one was outside it because it lived in JS.

**The page had a second, independent defect.** `keydown` was dropped whenever the focus sat on one of
the page's own controls -- the arguments field, the program menu, exactly where the focus lands after
choosing a game -- while `keyup` was not guarded at all. The guest therefore received the RELEASE of
a key it had never seen pressed. An asymmetric guard does not drop input, it corrupts it. Both
handlers now ask one `typing()` question, a `<select>` is no longer counted as typing, starting a
program takes the focus off the controls, and clicking into the command line releases what is held.

**MAME was not broken.** It waits on `getchar()`, and its `OSD_KEY_*` are PC scan codes already, so
nothing needed translating. What it was actually waiting for, two prompts down and off the visible
part of the log, was a numbered choice:

```
Press <ENTER> to continue.
Select the audio device:
   0. PRISM shared-memory ring
```

`0` then Enter, and Pac-Man starts: text mode off, display 224x288. The prompt is also the answer to
why its descriptor used `-nosound` -- with sound compiled in, the program stops here and asks.

The check is now an option rather than a browser session, because the menu is the one part of the
program a frame counter cannot see. Doom renders its attract demo whether or not a key ever arrives,
so a working keyboard and a silently dropped one give the same frame count and the same fps:

```
node tools/doom.mjs --run --data=<dir with the WAD> --frames=360 \
     --keys=esc,enter,enter,enter --keyat=120 --keyevery=25 --png=/tmp/dk --at=175,359
```

reaches E1M1 with `demoplayback = 0` and 100% health -- a real game, started from the menu by
keyboard alone.

## Hexen runs, and it was never Mode X

```
node tools/raven.mjs --game=hexen --run --safepoints --tick=1 --budget=6000 \
     --data=<dir with the retail HEXEN.WAD> --png=/tmp/hexen.png

video mode 0x13 - 320x200 - vectors installed: 0x9
framebuffer at 0xa0000: 63868 non-zero pixels of 64000, 131 distinct colours
       907554000 iterations  R_DrawColumn
       305220000 iterations  R_DrawSpan
        28302000 iterations  R_RenderSegLoop
```

54 units from the game's own MAKEFILE, 70,000 lines, 1,217 functions, compiled in 1.1 s. A level with
its status bar, the Fighter's gauntlets, and the attract loop running.

**It was the data, and the diagnosis had the versions backwards.** `P_SETUP.C:803` looks up
`R_TextureNumForName("SKY1")` unconditionally, before MAPINFO is read, and `I_Error`s if it is
missing. The WAD in `mirage/games/HEXEN` is the four-level DEMO (10,644,136 bytes, 2856 lumps, 148
textures) and has no SKY1 -- the string occurs nowhere in the file except as MAPINFO's own `sky1`
keyword. The retail v1.1 WAD (20,083,672 bytes, 4270 lumps, 359 textures) has it at index 228, and
the game starts.

**The mode is 0x13, linear.** Hexen sets mode 13h and writes the framebuffer directly, so the
planar/Mode-X hypothesis was never applicable -- and it had been carried for a while as if it were
the blocker. MIRAGE does implement Mode X and does test it (`src/vga.js`: sequencer index 4, chain-4
cleared in mode 13h, A000 routed through the plane pipeline). What makes it non-transplantable is
stated in `src/env/ports.js` and is unrelated to Hexen: MIRAGE's pipeline needs a CPU that traps
MEMORY writes, and a store into 0xA0000 emitted from C is a plain store into the guest image. Ports
cost nothing to intercept; A000 would need a write barrier in the emitter.

**One harness defect found on the way.** `--safepoints` is the only mode in which a Raven game runs at
all -- its main loop never returns -- and that path called `process.exit(0)` before the frame report.
So `--png` wrote nothing exactly when it was needed, and "it renders" rested on a profile listing
`R_DrawColumn`. The report is now a function, called from both exits.

## What Lua's printf assertions found

```
Lua 28 test files: 14 pass, 8 skipped by the test itself, 6 fail      (was 8 failing)
```

`strings.lua` is the whole story. It stopped at line 326, then 329, 345, 351, 361, and now reaches
its own skip line -- six separate defects, each one stated plainly in C99 and none of which anything
else in the corpus had noticed, because nothing else in the corpus checks its own output.

| where | what C says | what PRISM did |
|---|---|---|
| `-0.0` | `%g` prints `-0` | `String(-0)` is `"0"` |
| `%e`, `%g` of infinity | `inf` | `Infinity` |
| `%.u`, `%.f` | a `.` with no digits is precision **0** | treated as "no precision", default substituted |
| `%#o` | prefixes a `0` | `#` handled for `x`/`X` only |
| `%+#014.0f` | `+000000000100.` | `          100` -- flags ran for integers only |
| `%.1g` of 1024 | `1e+03` | `1000` -- style chosen by accident |

The negative zero is the one worth keeping. It was found through **`%a`**: Lua's hex-float writer
spells zero as `l_sprintf(buff, sz, LUA_NUMBER_FMT "x0p+0", x)`, so the sign of
`string.format("%a", -0.0)` comes out of our `%g`, three layers from anything hexadecimal. The same
defect made `tostring(-0.0)` print `0.0`. The value was never wrong -- `1/-0` is `-Infinity` here as
everywhere -- so this was purely a loss at the point of formatting, which is the only place it could
be repaired.

`%g` deserves its own note, because the old one-liner was not obviously wrong:
`String(Number(v.toPrecision(P)))` agrees with C for 0.1, for 100, for 1e30. It disagrees exactly at
the crossover the standard defines, and `%.1g` of 1024 is such a point.

### And one that was not printf

`finalizeHeap` takes the heap base from `mod.brk` **once**, when every global has been placed, and
`Module.alloc` kept bumping past it. So a shim that interns a string lazily handed out addresses
`malloc` had already given the guest, and the two sides wrote over each other. It surfaced as two
failures that looked unrelated:

```
after:  false   cannot open file 'non-existent-file' (No such file or director?)
                                                                            ^ clobbered
[threw] Offset is outside the bounds of the DataView
    at ...lgc$whitelist   <- Lua's collector, at shutdown
```

The writer was `strerror`, which interns its message the first time it is asked. Lazy interning is
legitimate -- `getenv`, `strerror`, `setlocale` and `tmpnam` cannot know in advance which strings a
program will want -- so the room is now RESERVED: a 64 KB gap below the heap base, and exhausting it
raises an error that names itself instead of corrupting memory silently.

### The six that remain, and what each is

| file | |
|---|---|
| `calls.lua`, `coroutine.lua`, `errors.lua` | JavaScript call-stack depth. Lua recurses to find its own limit; here the limit is V8's. |
| `constructs.lua` | out of memory in `malloc` -- a real allocator question, not a language one. |
| `files.lua` | line 47, having moved from line 8. The next actual report. |
| `main.lua` | now skipped BY NAME: it takes `arg[-1]` as a program name and shells out to it, so it measures the host shell. |

`literals.lua` and `strings.lua` now take their own skip paths -- `pt_BR` is genuinely unavailable and
`%.3a` (a precision on `%a`) is genuinely unimplemented. A test declaring a feature absent is a
different result from a test failing, and the gate reports them separately.

## Doom has sound, and fprintf was the reason it did not

```
node tools/doomsnd.mjs --data=<dir with the WAD> --frames=400 --wav=/tmp/doom.wav

popen: 1 open - "sndserver -quiet" 3040B          (was 0B)
pipe:  3040 bytes written by Doom, 0 still unread
audio: 2,440,704 frames at 11025 Hz x2 - peak 3435 - rms 243     (was peak 0)
```

The plumbing had been right for a while: Doom in one thread, `corpus/DOOM/sndserv` in another, a byte
pipe between them, the mixed result in the audio ring the page already reads. What was wrong was one
line in the runtime.

    fprintf: (_stream, fmt, args) => { ...; M.write(s); return s.length; }

**It discarded its stream.** The parameter was named `_stream`, which is the tell. So
`fprintf(sndserver, "p%2.2x%2.2x%2.2x%2.2x\n", ...)` printed Doom's sound commands on the console,
the server received nothing, and it mixed 204,800 samples of silence -- correctly, since nothing had
been asked of it. `fprintf(fp, ...)` to an ordinary file went nowhere either.

The log LOOKED right. Doom's commands were visible in it (`p297f01b9`, `p20800880`, ...), which reads
as "the commands are being sent" and is in fact the opposite: they were visible *because* they were
going to stdout. What settled it was the tool's own `--inject`, which writes one command straight into
the pipe:

```
node tools/doomsnd.mjs --data=<dir> --frames=60 --inject=1a,20,7f,80
audio: 40960 frames at 11025 Hz x2 - peak 24576 - rms 5101
popen: 1 open - "sndserver -quiet" 0B        <- Doom had written NOTHING
```

Peak 24576 from the injected command, 0 bytes from Doom: the two halves separated in one run. That
option existed for exactly this and it had a comment saying so.

`fprintf` and `vfprintf` now live in `src/env/stdio.js`, which is the layer that knows what a FILE* is,
and route through the same `writeByte` as `fputc`/`fwrite` -- so the pipe sink, stdout and a real file
are decided in one place. The runtime keeps a pair for programs with no file layer at all, and says so.

Still to do for the browser: a second worker compiling `corpus/DOOM/sndserv` from fetched sources, the
web counterpart of `tools/sndserv-worker.mjs` (which reads them from disk). The audio ring, the pipe
and the page side already exist -- MAME plays through them today.

## Quake on X11, through the Xlib shim Doom already needed

```
node tools/build.mjs targets/quake.json:x11 --run --data=<dir with id1/> --frames=150 --png=/tmp/q.png

QUAKE (Linux/X11, id386=0) -- 71 translation units, 47,798 lines, 1083 functions in 1.0 s
  2 functions could not be emitted (they throw IF CALLED)
  assembly: 21 files export 126 symbols; 0 of them are still undefined here
frames 150 - display 320x200
  63810 non-zero pixels of 64000, 174 colours
```

The demo plays: an explosion with its particles, the shotgun, 90 health on the status bar, and the
game announcing "You got the Grenade Launcher".

**The number that decided to do this was measured before any code was written.** Quake's Linux client
calls 41 Xlib functions; PRISM's shim, written for Doom, already had all 41. The one apparent gap,
`XLateKey`, is Quake's OWN function (`vid_x.c:718`) -- the counterpart of Doom's `xlatekey` -- and my
first pattern had simply matched it on the `X` prefix. So the cost of a second, larger X11 client was
zero new Xlib.

**The unit list was computed, not chosen.** `Makefile.linuxi386` has an `X11_OBJS` variable; its 89
objects are 71 C files and 18 assembly ones, and the difference between its C files and the engine
list this target already had is exactly the platform set: `net_udp.c net_bsd.c cd_linux.c sys_linux.c
vid_x.c snd_dma.c snd_mem.c snd_mix.c snd_linux.c`. The 18 assembly objects are the `id386=1` build,
which is what the C files already listed replace. Nothing in the engine list was missing, which also
means the existing list agrees with Quake's own Linux build.

Two substitutions, both of files Quake ships for the purpose:

  * `cd_null.c` instead of `cd_linux.c`. That file wants a real `linux/cdrom.h` -- five structs and
    thirteen ioctl numbers -- to build a CD player for a machine with no CD drive. It surfaced as
    three "local of incomplete type" failures and five undeclared ioctls, which is the empty stub
    header telling the truth.
  * `net_none.c` instead of `net_udp.c` + `net_bsd.c`, the same substitution the DOS variant already
    makes. The socket surface is eight functions -- `socket bind recvfrom sendto setsockopt
    getsockname gethostbyname ioctl` -- and is recorded here rather than worked around.

One header constant was genuinely missing: `MAP_FILE`, which is 0 on Linux. `snd_linux.c` mmaps
`/dev/dsp` with `MAP_FILE|MAP_SHARED`, and without the macro the whole of `SNDDMA_Init` failed to
emit, so the run stopped there. With it declared, the function emits, the mmap fails, Quake prints
"Could not mmap /dev/dsp" and runs silent -- which is exactly what it does on a machine whose sound
driver cannot mmap. Sound here needs an mmap-able DSP device and a play pointer; that is a piece of
work, not a constant, and it is the next thing on this target.

The two functions that still do not emit are `st2_fixup` and `st3_fixup` in `vid_x.c`, Quake's 2x and
3x pixel-doubling helpers. `tier-0 does not support goto into a nested block yet`. They are never
called at 320x200, so the running configuration does not touch them -- but the limitation is real and
named.

`tools/build.mjs` gained `--frames=N --png=<path>`, and it is generic: an X11 client presents by
calling `XPutImage`, so that call is the frame boundary and the option needs to know nothing else
about the program. It works for Doom, Quake/X11 and Quake II alike. It earns its place by answering
what a log cannot -- these main loops never return, so an uncapped run hangs, and an interrupted one
proves only that it was still going.
