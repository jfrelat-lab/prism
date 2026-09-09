# PRISM — Compatibility

What actually runs. The point of this file is that "what runs" is never inferred from "what is
written": a row here means a gate observed it, not that the code looks capable of it.

| Target | Status |
|---|---|
| a hosted C program using the supported subset | ✅ **runs** — 30/30 hand programs, 197/219 c-testsuite, 1259/1556 gcc torture |
| nested functions, compound literals as lvalues, non-empty inline asm, GNU complex, `long double`, labels nested in a block | ⛔ tier-0 gaps, each a clear error not a miscompile (P0.5b, ranked by measurement) |
| a wrong answer anywhere in the corpus | ✅ **none** — every failure is a named refusal, never a silent miscompile |
| **MAME 0.1 — all five drivers** | ✅ **BIT-IDENTICAL TO A NATIVE gcc BUILD** — see the table below. Game ROMs are supplied by the user, never fetched. Now compiled with **MAME's own DOS platform backend**, `src/msdos/msdos.c`: nothing of MAME is written in JavaScript any more, and what PRISM shims is one level down — Allegro, SEAL and DJGPP's memory helpers. Both of msdos.c's display paths render, 224x288 through the tweaked VGA mode and 640x480 with `-vesa`. | Sound works: SEAL is a real four-voice mixer into a shared ring the page reads (only pengo and ladybug have sound in 0.1).
| **Quake** (`WinQuake/`, `id386=0`) | ✅ **RENDERS** — 69 units, 44,570 lines, **every function emits**, 1.72 MB of JavaScript. Loads `id1/pak0.pak`, runs its demos, and draws the game at 320x200 in the browser at **72.0 fps — which is Quake's own ceiling** (`Host_FilterTime`, 1/72 s), not PRISM's: with the shell's speed selector set to *unlimited* the same build reaches **1,725 fps**. (This line read "~26 fps" from 24 August to 9 September, unmeasured in between.) Game data is supplied by the user, never fetched. Sound and networking are Quake's own null drivers. |
| **Quake, four platform layers** | ✅ **DOS · Linux/X11 · SunOS · Win32**, plus **svgalib** as a second Linux display path — five builds of one engine from one tree, each using id's own platform files. `tools/gate-pixels.mjs` asserts `x11 == dos == svgalib == win` on the same demo frame: 64,000 pixels and 768 palette bytes identical, modulo the palette-index-0 remap `vid_win.c:2117` performs on itself. The SunOS build (68 units, 45,820 lines) had never been compiled by anyone. | one engine, five hosts |
| **Quake II** (`id-Software/Quake-2`) | ✅ **RENDERS** — 109 units, 87,098 lines, **2,120 functions**, nothing unemitted. `====== Quake2 Initialized ======`, a client over the loopback, `Player\\male/grunt` spawned, `demos/q2demo1.dm2` playing on Installation. Three modules with separate symbol namespaces; `dlopen`/`dlsym` answered from PRISM's own symbol table. | **Linux/X11 + `ref_soft`** |
| **Quake II, Solaris** | ✅ **RUNS** — and it is not a client: `solaris/Makefile.Solaris` builds **`q2ded`**, a dedicated SERVER. No renderer in the object list, `cl_null.c` and `cd_null.c` in it. 71 units, 52,579 lines, 1,432 functions; pak loaded, `gamei386.so` dlopened, world spawned, 49 entities inhibited, its own frame loop running. UDP fails and says so — a browser has no socket. | **SunOS/Solaris** |
| **MAME 0.4** | ✅ **BIT-IDENTICAL TO A NATIVE BUILD** through attract mode — 135 of 135 lines against a tcc build of the same sources (`tools/mamediff.mjs --release=04`). gcc 12 cannot build this release at all: four `case` labels in `src/machine.c` use a cast pointer constant. Playing diverges and that is open — see ROADMAP P1.10. | **DOS / DJGPP + Allegro** |
| **PuTTY** (`puttytel`) | 🟢 **CONNECTS AND DRAWS** — a real telnet session over the host's sockets, text on a 642x386 black terminal in the VGA ROM font. Win32: a window class, a message queue, GDI, Winsock. 18 functions still unemitted. | **Win32** |
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

## Duff's device, lowered properly

```
c-testsuite single-exec: 204/219 pass          (was 202)
gate-run: 31/31 programs behave identically to a native i386 build
QUAKE (Linux/X11): 1083 functions, nothing unemitted      (was 2)
clangsay: 7 functions unemitted                           (was 8)
```

A `case` label does not have to sit at the top of a switch body. C lets it label any statement
inside, which is what makes Duff's device legal, and Quake's `vid_x.c` writes the textbook form:

```c
switch (count % 8) {
case 0: do {    *dest-- = st2d_8to16table[*src--];
case 7:         *dest-- = st2d_8to16table[*src--];
        ...
        } while (--n > 0);
}
```

`flatten.js` lowers a switch to a dispatch over labels and gotos, and it had **half** of this right.
`collectCases` looked inside loops -- it had to, or there would be no arm to jump to for `case 7` --
but `walkSwitchBody` descended only through blocks, so it handed the `do` to the ordinary walker,
whose case/default branch carried the comment "Reached only through walkSwitchBody, which has already
placed the label". It had not. Every jump was emitted and no label ever was, which the emitter
reported, accurately and unhelpfully, as `goto into a nested block ('_L625_case')`.

The fix is that the ordinary walker places the label itself when nobody else has, at the point the
statement actually occupies -- which is what makes a jump into the middle of a loop body land where C
says it does.

The gate case exercises **every remainder class**, 0 through 20, because a lowering that placed the
labels wrongly would still be right for the multiples of eight; and a second shape puts the labels
under an `if` instead of a loop, the other place C allows one and JavaScript does not. Both match
`gcc -m32` exactly.

It was not one program's problem. The same limitation was costing clangsay a function and two
c-testsuite programs, neither of which had been attributed to it.

## Quake has sound: the other way a program uses /dev/dsp

```
node tools/build.mjs targets/quake.json:x11 --run --data=<dir> --frames=200 --wav=/tmp/q.wav

Sound Initialization
Sound sampling rate: 11025
audio: 8805 frames at 11025 Hz x2 - peak 32768 - rms 10421
```

Doom **writes** its mixed samples to the device. Quake **mmaps** the card's DMA buffer and mixes
straight into it, asking `SNDCTL_DSP_GETOPTR` where the card has got to and filling in ahead of that.
Both are ordinary OSS, and the difference is not a detail: `snd_linux.c` checks
`caps & DSP_CAP_MMAP` and refuses at `SNDDMA_Init` without it, which is why the whole function used
to be skipped.

So `src/env/dsp.js` grew the second path: `GETCAPS` answers `TRIGGER|MMAP`, `mmap` on the descriptor
hands back a real 32 KB buffer in guest memory, `SETTRIGGER` is the start button, and `GETOPTR`
reports the play position -- and is also where the samples leave, because a program on this path
never calls `write()` and asks for the position every frame, which is exactly when new samples are
guaranteed to be there. A real card moves them by DMA in between; the program cannot tell, since the
answer to this ioctl is all it can observe.

Two things that were not free choices:

  * **8 fragments of 4 KB.** Quake computes `shm->samples` from `fragstotal * fragsize` and masks
    ring positions with `samples - 1`, so a total that is not a power of two corrupts every wrap.
  * **`GETOSPACE` describes the DEVICE.** `fragstotal` and `fragsize` are its geometry, not the
    state of the moment -- Quake multiplies them before writing a byte. The old implementation put
    free ring space in those two fields, which answered a question about the queue to a program
    asking about the card.

**How the capture was checked, since a histogram can be talked into anything.** The distribution is
peaked near zero (66.6% of samples in the quietest octile) with ~1100 Hz of dominant content, which
is the shape of audio rather than of noise; but 1.8% of samples sat at exactly -32768, which is
Quake's own clamp value and could equally have meant a misread buffer. The test that settles it is
the `volume` cvar:

```
+volume 1.0    peak 32768   rms 12698
+volume 0.3    peak 32768   rms  4889
+volume 0.05   peak  4416   rms   755
```

The rms tracks the cvar (1.00 : 0.385 : 0.059 against 1.0 : 0.3 : 0.05) and the clipping disappears
when the game stops asking for it. What comes out is Quake's mixer, at the gain Quake chose.

`tools/build.mjs` gained `--wav=<path>`, generic for the same reason `--png` is: the device already
keeps every sample it accepted, whichever path they arrived by, so the option only has to ask.

## Doom is audible in the browser, and which thread owns a process

```
[sound] sound server: 4 units, 21 functions
[sound] sound server running

AUDIO_RATE  11025
frames/second into the ring   10,922        (the rate, within rounding)
peak 2544 - rms 447 - 3.4% exact zeros
```

Doom's own source delegates sound to a separate process -- `sndserver = popen("./sndserver ", "w")`
in `i_sound.c` -- so this was never an audio feature. It is a second address space and a pipe, and
both had existed for a while: `src/env/pipe.js` is a byte pipe in a SharedArrayBuffer, and the audio
ring the server publishes into is the one the page had been reading for MAME all along.

`web/sndworker.js` is the browser counterpart of `tools/sndserv-worker.mjs`, and the only real
difference is where the source comes from: that one reads it off the disk, this one fetches it.

**The mistake worth recording is about which thread starts it.** The obvious home for
`new Worker('./sndworker.js')` is the worker that runs Doom, right beside the `installPopen` that
uses the pipe. It is the wrong home, for exactly the reason the thing is a process at all:
`prog.run()` never returns, so from that moment the parent's event loop is gone. The child compiled,
the child ran, and not one of its messages was ever delivered -- `snd.onmessage` was registered on a
listener that would never run again.

Nothing about the symptom said so. It looked like a worker that had failed to load, and the first two
hypotheses were wrong in an instructive way: the URL was right (`/web/sndworker.js`, 200), and the
payload was not the cause either -- posting an empty file map changed nothing, which is what ruled
out the 156 MB of data being cloned. What settled it was constructing the same worker from the PAGE,
where it worked on the first try.

So the page starts both programs and hands each end of the pipe to its side. That is also the
truthful arrangement: the page is the system, and a program is a thread.

Two smaller things found on the way. `M.write` is called per CHARACTER, so posting each one spelled
one sentence in thirty-three messages; the server's stdout is buffered to a line now. And Stop has to
terminate the second worker too -- it is parked in `Atomics.wait` inside its own `write`, because the
ring is its clock and nobody is draining it any more, so nothing short of terminate brings it back.

## WinQuake: the Windows SDK is the missing header, and how far that got

The measurement that chose this target held up. WinQuake's nine platform files name **120 external
symbols** -- about 92 Win32/GDI/console, 12 DirectSound, 14 SciTech MGL -- and the DirectX and MGL
headers SHIP WITH THE SOURCE (`dxsdk/SDK/INC`, `scitech/INCLUDE`). What no source tree ships, and
what all of them assume underneath, is the Windows SDK: the base types, the calling-convention
macros, and the COM declaration macros `objbase.h` would provide.

`src/env/headers-win32.js` is that, and its size was set by what the shipped headers and the twelve
platform units actually name, one compiler error at a time. It now gets **all four vendor headers to
parse** -- ddraw.h, dsound.h, dinput.h and mgraph.h -- plus `winquake.h`, `sys_win.c`, `conproc.c`,
`snd_win.c` and `cd_win.c`.

Three things it had to get right rather than approximate:

  * **COM in C.** An interface is a struct holding a pointer to a vtable of function pointers, and a
    method call is `p->lpVtbl->Method(p, ...)`. That is not a simplification for PRISM's benefit: it
    is the shape `objbase.h` gives these macros when `__cplusplus` is undefined, and the form Quake
    was written against.
  * **`LARGE_INTEGER` is a union.** `QueryPerformanceFrequency` fills it and `Sys_Init` immediately
    takes `.LowPart` and `.HighPart` apart by hand, so a plain 64-bit typedef would compile the
    declaration and fail on the next line.
  * **`windows.h` used to include `winsock.h` and `mmsystem.h`.** `winquake.h` declares eleven
    Winsock entry points without including anything that names `SOCKET`, and `dsound.h` names
    `LPWAVEFORMATEX` the same way. Those declarations stand whichever `net_*.c` the build links, so
    even a `net_none.c` build needs the types.

**Where it stops, precisely.** `in_win.c:132` builds DirectInput's data-format table with

    { &GUID_XAxis, FIELD_OFFSET(MYDATA, lX), DIDFT_AXIS | DIDFT_ANYINSTANCE, 0 },

and `FIELD_OFFSET` expands to `&((MYDATA *)0)->lX` -- the portable, pre-C89 spelling of `offsetof`.
The EMITTER already folds that shape (`#lvalAddrConst`, written for OpenDUNE's `offset(c, m)` idiom,
which uses a base of 8 rather than 0). The PARSER's own `constEval` does not: it knows
`__builtin_offsetof`, which is what `<stddef.h>` uses here, and nothing about the hand-written form.
So a static initialiser containing one is refused before the emitter ever sees it.

That is the next step, and it is worth more than this one target: `&((T *)0)->m` is how a great deal
of pre-standard C spells an offset.

Nothing regressed on the way: gate-run 31/31, c-testsuite 204/219, and Doom, Quake DOS, Quake X11,
Heretic, Lua and MAME 0.2 all build as before -- the Win32 headers are spread FIRST into `HEADERS`,
so an existing entry of the same name still wins.

### constEval folds `&((T *)0)->m`

```
gate-run: 32/32 programs behave identically to a native i386 build
```

That expression is how C spelled `offsetof` before it had one, and two forms of it are in this
corpus already:

```c
#define FIELD_OFFSET(t, f)  ((long)&(((t *)0)->f))          /* the Windows SDK */
#define offset(c, m)        (((size_t)&((c *)8)->m) - 8)    /* OpenDUNE, saveload.h:29 */
```

The EMITTER had folded the shape for a while -- `#lvalAddrConst`, written for OpenDUNE. The PARSER's
`constEval` had not, and a **static initialiser is evaluated there**, before the emitter sees it. So
WinQuake's DirectInput data-format table, thirteen rows of `FIELD_OFFSET`, was refused with
`unary '&' is not constant` and the emitter's version never got the chance. Two evaluators, one of
them right, and the wrong one ran first.

`addrConst` in the parser now walks the same shapes the emitter does: `p->m` adds the member offset
to the POINTER's value, `b.m` adds it to the address of `b`, `a[i]` adds `i` elements taking its base
the same way round, and anything else falls through to `ce` -- which evaluates a cast of 0 to a
pointer, or refuses by name.

The gate case checks both macro forms, a nested path (`in.deep`), a subscript (`c[3]`), an array
size and a `case` label -- the two places a constant expression is REQUIRED rather than merely
allowed -- all against `gcc -m32`.

## WinQuake compiles whole, and the shim surface is a list

```
QUAKE (Win32, id386=0) -- 74 translation units, 52,884 lines, 1159 functions in 1.2 s
  106 symbols declared and called but NEVER DEFINED (they fail when called)
   91 variables declared and never defined (they read as zero)
   11 functions could not be emitted
  assembly: 21 files export 126 symbols; 0 of them are still undefined here
```

The estimate that chose this target was 120 external symbols; the measurement is 106 functions, and
they fall where the estimate said: **64 Win32/GDI/console, 34 SciTech MGL, 8 multimedia**. That is now
a list to work through rather than a number to trust.

Two general things had to be fixed to get here, and neither is about Windows.

**`constEval` folds `&((T *)0)->m`** -- see above. WinQuake's DirectInput data-format table is
thirteen rows of `FIELD_OFFSET`, and a static initialiser is evaluated in the parser, before the
emitter (which had folded that shape for years) ever sees it.

**An `extern` variable nobody defines still has an address.** `DEFINE_GUID` declares
`extern const GUID GUID_XAxis;` and the definitions live in `dxguid.lib`, a binary that is not here --
yet the program legally takes its address in a static initialiser without ever reading it. Such a
symbol now gets zeroed storage, which is what an unresolved data symbol reads as, and its name goes
into a report of its own. Refusing would have been stricter than a linker on a program that never
dereferences it.

That report is worth having beyond Windows. Every Quake variant carries some: with `id386=0` the
engine stops referencing the globals its assembly renderer shares -- `bottomclip`, `r_lightptr` --
while the headers still declare them, so they are declared, unused and undefined all at once. 28 in
the X11 build, 30 in the DOS build, both of which run correctly. It was invisible before because
nothing was counting.

Also: `sys_wina.s` exports five routines and `sys_win.c` defines four of them in C, so the win variant
generates `tools/quake-win-vars.c` -- the DOS file minus what WinQuake writes itself. Using the DOS
file whole reported four duplicate definitions, which is the linker saying the same thing.

**One property of the capture, recorded because it misled me.** `--frames=N` is not a deterministic
oracle for Quake: `Sys_FloatTime` reads the real clock, so frame 150 lands wherever 150 rendered
frames get to, and that depends on how fast the machine is going. Three runs back to back agree; a
capture from an hour earlier need not. I spent three A/B tests -- against the extern-data change,
against the Duff's device fix, and against sound -- before recognising that none of them was the
cause and the earlier number was simply a different moment in the demo.

## MGL, and why one environment shim is written in C

```
QUAKE (Win32, id386=0) -- 75 translation units, 53,111 lines, 1196 functions in 1.2 s
  0 functions could not be emitted
  85 symbols declared and called but NEVER DEFINED   (was 106)
  assembly: 126 exported symbols, 0 still undefined
```

All 34 MGL calls are gone from the undefined list, and nothing in the program fails to emit any more.
What is left is Win32 itself: 75 of GDI, the message loop and the console, and 10 of multimedia.

`src/env/mgl.c` is an environment shim like `allegro.js`, `sdl2.js` and `x11.js`, and named after the
LIBRARY for the same reason they are -- it implements somebody else's published API, not one
program's needs. WinQuake is simply the first program to ask.

**It is written in C, and that is the point.** `publicDevCtx_t` is a public struct that ships with the
source, and Quake reads two fields out of it:

```c
vid.buffer = vid.conbuffer = vid.direct = dibdc->surface;      /* vid_win.c:1351 */
vid.rowbytes = vid.conrowbytes = dibdc->mi.bytesPerLine;
```

A JavaScript shim would have to know where `surface` and `mi.bytesPerLine` sit inside that struct, and
a wrong offset there is SILENT -- `xkey.keycode` sat at byte 36 instead of 52 in `src/env/x11.js` for
as long as it did precisely because nothing about a wrong offset announces itself. Compiling against
the shipped header makes the layout the compiler's problem, which is where it belongs. That is a rule
worth keeping: when a library's contract is a public struct, implement the shim in C.

The arrangement that results is the one every other PRISM target already uses. Quake renders into a
memory DC and blits it, so the harness reads `vid.buffer` and treats `MGL_bitBltCoord` as the frame
boundary, exactly as `XPutImage` is for an X client. Nothing new had to be invented to publish it.

Only the WINDOWED path is implemented, and it says so rather than pretending: `MGL_availableModes`
returns an empty list -- the truthful answer for a machine with no fullscreen driver -- and
`vid_win.c:411` reads `m[0] != 0xFF` and skips its entire mode enumeration. Run with `-window`.

## WinQuake runs and renders: the third platform

```
node tools/build.mjs targets/quake.json:win --run --data=<dir with id1/> \
     --args="-window" --frames=150 --png=/tmp/wq.png

QUAKE (Win32, id386=0) -- 76 translation units, 53,634 lines, 1295 functions in 1.2 s
  0 symbols declared and called but never defined
  0 functions could not be emitted
frames 150 - display 320x240
  76694 non-zero pixels of 76800, 136 colours
```

The same game on a third platform, from the same tree: DOS, X11 and now Win32. The demo plays at
320x240 -- the Windows build's own default windowed size, larger than the 320x200 the other two use.

`src/env/win32.c` is 85 functions, in C for the reason `mgl.c` is: nearly every one takes or fills a
struct whose layout `headers-win32.js` decides, so a JavaScript version would be two files of mine
disagreeing silently. It also holds the `main` -> `WinMain` bridge, which is a property of the
platform rather than of any program.

**Where "answer honestly that there is nothing here" is right, and where it is not.**

The rule served well for the hardware. `LoadLibrary` returns NULL and snd_win.c's DirectSound path --
which reaches DirectSound only through `GetProcAddress` on dsound.dll -- gives up exactly as it does
on a machine without it; `waveOutOpen` fails and the fallback gives up too; `mciSendCommand` fails and
CDAudio reports no CD; `joyGetNumDevs` returns 0. Each of those is a fact about the machine, and the
program has a path for it because plenty of 1996 machines were configured that way.

It was wrong twice, in the same way, and both cost a run:

  * **`CreateEvent` returning NULL.** An event object is not a device -- every Windows has them, they
    are pure bookkeeping. WinMain does `tevent = CreateEvent(...); if (!tevent) Sys_Error(...)`, so
    the program stopped before printing its first line.
  * **`MGL_changeDisplayMode` refusing everything.** `grWINDOWED` is not a display mode, it is the
    request to LEAVE one, and VID_SetWindowedMode calls it first thing. Refusing uniformly killed the
    only path this build has.

And one that was worse than either: **`MGL_fatalError` written as `{ }`**. A fatal error exits; a
version that printed nothing and returned let `initFatalError` -- whose entire job is to stop -- fall
through and continue with a half-built device context. That is precisely the failure this shim's own
opening paragraph warns about, arrived at by writing an empty body without asking what the caller
expects to happen next. It prints and exits now.

`build.mjs`'s `--frames`/`--png` cover this target too: the frame boundary is `MGL_bitBltCoord`, and
the surface it presents is published from `mgl.c` as four plain integers. That indirection is the
point -- `surface` and `mi.bytesPerLine` live inside a struct the JavaScript side must not guess at,
which is the whole reason that shim is written in C.

Open on this target: the palette. The picture is a little brighter and yellower than the X11 build's,
which is either the six-bit scaling here or a gamma ramp vid_win.c applies, and I have not measured
which. Input is the other half -- `PeekMessage` returns an empty queue, so nothing reaches the game
yet, and that one function is where keys will arrive.

## WinQuake takes the keyboard, and the colours were a guess

```
node tools/build.mjs targets/quake.json:win --run --data=<dir with id1/> --args="-window" \
     --frames=220 --keys=esc,down,down --keyat=100 --keyevery=30 --png=/tmp/wq.png
```

Escape opens Quake's main menu and two Downs move the cursor to OPTIONS -- and the keystroke travels
the route the program expects rather than being handed to its input code behind its back: it is
posted as a real `WM_KEYDOWN` into the message queue, comes out through `PeekMessage`/`GetMessage`,
and is dispatched into Quake's own `MainWndProc`, which calls its own `MapKey` and `Key_Event`.

Three things that had to be right, and two of them only look obvious afterwards:

  * **The scan code goes in bits 16-23 of `lParam`.** `MapKey` is `(lParam >> 16) & 255`, indexing
    vid_win.c's own `scantokey[]`. A virtual-key code in `wParam` would have looked entirely
    reasonable and delivered nothing.
  * **`GetMessage` returning FALSE means WM_QUIT, not "nothing waiting".** Sys_SendKeyEvents peeks
    with PM_NOREMOVE and then calls `if (!GetMessage(...)) Sys_Quit();`, so the stub that answered
    FALSE for an empty queue would have quit the game on the first keystroke. It was harmless only
    while PeekMessage never said there was anything -- a bug that could not fire until the moment
    the feature started working.
  * **`RegisterClass` has to remember `lpfnWndProc`**, because `DispatchMessage` calls it. That also
    makes the pair a real exercise of PRISM's function-pointer table: the callback leaves through a
    struct field and comes back as a call.

### The colour difference

The first WinQuake capture was brighter and yellower than the X11 build's. I had written that MGL's
`palette_t` holds six bits a component, the VGA DAC's range, and scaled it up by four.

vid_win.c says otherwise, in one line:

```c
pal[i].red = palette[i*3];          /* no shift */
```

Quake writes the FULL 0..255 values. Multiplying them by four saturated most of the picture, which is
exactly what it looked like. What a real MGL would then do with those bytes is its business; what is
in the array is what the program put there, and that is the only thing a shim can read. Measured
rather than inferred, one line of the caller, and the picture is Quake's own palette again.

`--keys` in `build.mjs` works through `prism_win32_key`, and on a target without that door it now
SAYS so and names the tool that does have one. A flag that quietly does nothing is worse than a flag
that is missing.

## Choosing the platform, not just the program

Node could always do it -- `node tools/build.mjs targets/quake.json:x11` -- and the page could not,
which made the shell the one place the choice was invisible. It now has a second picker beside the
program, shown only when there IS a choice:

```
quake   [ null | win | x11 | dos ]
doom    (hidden: one build)
```

Everything for it existed already: `/__targets` reported each target's variants, and `/__target`
already parsed `name:variant`. What was missing was one field and one honest dispatch.

**`host` belongs to the VARIANT, not the target.** One engine, four platform layers, and the page has
to know which one it is looking at. Node never needed it, which is exactly why it was absent.

**The shell's branch chain used to end in an `else` that installed Allegro.** That was harmless while
every descriptor named its own platform; the moment the page could pick one, a build with no branch
here would silently get MAME's environment and fail somewhere far away. It now names the platform it
cannot present and points at the tool that can:

```
the shell has no branch for platform 'mgl' yet -- it presents x11, quake, watcom and allegro.
This build runs in Node: node tools/build.mjs targets/<name>.json:<variant> --run
```

**The page's Quake descriptor now names its target instead of restating the build.** It carries what
a descriptor is for -- the title, the arguments, what data it needs, what its keys do -- and the four
platforms come from `targets/quake.json`. Picking `x11` gives the real X11 client in the page, with
its keyboard and its sound, in place of the `vid_null.c` build that was the only one available
before: 1,083 functions, 320x200, 3,441 frames, audio at 11,025 Hz.

**Sound follows the BUILD, not the host.** The x11 branch installs `dsp` when the target's own `env`
list asks for it, which is how Quake's mmap path gets wired without assuming that every X11 program
wants a sound device.

**And changing the picker stops what is running.** Otherwise the selector stops describing what is on
screen: choose `x11` while the `null` build is still going and the two disagree, while the next Run
competes with a worker that never went away. The last frame is cleared with it -- a stale picture
from the previous platform is exactly the kind of evidence that gets read as a result.

## Three platforms of Quake in the page

The picker now offers `win`, `x11` and `dos`, and all three run in the browser. `null` stays in Node
and says why in the target: it is the porting-stub build whose `Sys_FloatTime` returns `t += 0.1`, a
counter rather than a clock, so anything it measures about ITSELF is fiction. A fine compile test and
a poor thing to hand somebody as a playable Quake.

```
win   320x240   76,694 non-zero pixels of 76,800     (matches the Node capture exactly)
dos   320x200   63,089 non-zero pixels at 0xA0000, palette published
x11   320x200   1,083 functions, 3,441 frames, audio at 11,025 Hz
```

The `mgl` branch installs no library at all -- `win32.c` and `mgl.c` are compiled INTO the program --
so it publishes an address and posts keystrokes, and both come through the four integers `mgl.c`
writes on every blit. The `dos` branch is the arrangement `tools/quake.mjs` reached first: three
devices plus DJGPP's DPMI floor, no CRTC emulation, and the framebuffer as ordinary memory at
0xA0000, because Quake's default video mode programs no VGA registers at all.

Three things had to be fixed, and each was invisible until a platform other than x11 was asked for:

  * **A unit outside the target's directory came out as the empty string.** The fold sliced the
    target's directory off every unit path, which is right for the game's own files and wrong for a
    `generated` one -- `src/env/win32.c` is PRISM's, not Quake's. The build failed with
    `missing translation unit ` and nothing after it. Those are now kept whole and fetched from the
    repository root.
  * **A platform may need its own arguments.** Quake's DOS build asks DPMI how much memory there is,
    computes `malloc'd: -95124` from the answer, and refuses with "Only -0.1 megs of memory
    available"; `-mem 16` gives it the heap size outright. And `-nosound`, because `snd_dos.c` drives
    a Gravis Ultrasound through ports nothing here answers, so without it the game reaches `GUS_Init`
    and stops. Both are the program's own switches. The variant carries them and the page fills the
    field in, visibly, so they can be changed.
  * **The branch chain ended in an `else` that installed Allegro** -- fine while every descriptor
    named its own platform, and a silent wrong answer the moment the page could pick one.

And one latent trap of my own: the watcom branch declares `const host = installWatcom(...)`, which
shadowed the new outer `host`. Renamed to `platform` before it could mean two things in one function.

### `-mem 16` was hiding a bug in sbrk

The DOS variant carried `-mem 16` and I wrote that it was "the game's own switch, for the same
situation on real hardware whose DPMI host lied". That was wrong, and the question "do we not have 16
MB by default?" was the right one to ask: the target has **509 MB free**.

`dos_getmaxlockedmem` asks DPMI how much memory there is, gets 32 MB, and then walks DOWN in 64 KB
steps until an allocation succeeds:

```c
do { working_size -= 0x10000; working_memory = sbrk(working_size); }
while (working_memory == (void *)-1);
```

Every call failed, so the loop ran the value negative -- `malloc'd: -95124`, then
`Only -0.1 megs of memory available`. `-mem 16` made the game start by skipping the question
entirely, which is exactly why it looked like a program option instead of a defect here.

**There were two heap frontiers.** `malloc` bumped `heapEnd`; `sbrk` bumped `heap`; both began at the
same address, so a working `sbrk` would have handed out bytes `malloc` had already given away. What
concealed that was the limit check -- `sbrk` compared against `heapEnd`, malloc's frontier, instead of
`heapTop`, the ceiling. It could therefore only extend into ground malloc had ALREADY taken, and
refused everything else. The bug and the thing that made it harmless were the same line.

One frontier now, and the DOS build sizes its own heap:

```
sbrk(33554432) = 1667984          (was -1, at every size)

EXE: 00:00:00 JAN  1 1996
31.9 MEGABYTE HEAP
```

The variant keeps `-nosound` and only that: `snd_dos.c` drives a Gravis Ultrasound or a Sound Blaster
through ports nothing here answers, so without it the game reaches `GUS_Init` and stops. That one is
genuinely the program's own option for a machine with no sound card.

gate-run 32/32, c-testsuite 204/219, gate-abi 1745/1745, Lua 14+8 of 27, and Doom, Heretic, OpenDUNE,
MAME 0.2 and both other Quake variants unchanged.

## A real window, because the program owns one

**Does a resolution change move the window in the real WinQuake?** Yes, and the source says how:
`VID_SetWindowedMode` calls `SetWindowPos` twice -- once to RESIZE to `WindowRect`, with
`Sys_Error("Couldn't resize DIB window")` if it fails, and once to REPOSITION at `vid_window_x` /
`vid_window_y` with `SWP_SHOWWINDOW | SWP_DRAWFRAME`. Then `VID_UpdateWindowStatus` reads
`GetWindowRect` back and writes the position into those two cvars, which are archived.

Our shim swallowed all of it: `SetWindowPos` returned TRUE and forgot, `GetWindowRect` answered a
fixed rectangle at the origin. So the window could not move and a resolution change was invisible.
`src/env/win32.c` now keeps the rectangle, and it is measurably the program's:

```
default            window 320x240 at (0,0)  visible=1  title="WinQuake"
320x200 settable   window 320x200 at (0,0)  visible=1  title="WinQuake"
```

The page draws a window around it -- title bar, border, close button -- and **is the window manager**,
which is not a metaphor. Dragging the frame writes the new position into the control block, the guest
applies it through `prism_win32_move`, and `GetWindowRect` then reports it, so the program learns
where its window is exactly the way it would on Windows. Measured: the guest's rectangle went from
(0,0) to (40,12) after one drag.

It goes through SHARED MEMORY rather than postMessage for the reason the keyboard does: once the
guest is inside `prog.run` its worker never returns to an event loop, so a message posted to it is
never delivered.

Two defects of mine, both found by using it:

  * **The window jumped when dragged.** `paintWindow` set `position: absolute` from JavaScript, so at
    the first positioning the frame left the stage's centred grid flow and snapped to the corner of
    its nearest positioned ancestor -- of which there was none. It is absolute in the CSS now, inside
    a `position: relative` stage. It looked like a drag bug and was a layout one.
  * **The close button did nothing.** It posted WM_CLOSE correctly, and `vid_win.c:3020` answers it
    with `MessageBox(..., MB_YESNO)` and quits only on `IDYES`. The shim returned `IDOK`, which is 1,
    not 6. A person who clicks a window's close box has already answered that question, so a
    `MB_YESNO` box now returns `IDYES` -- and the program quits through its own `Sys_Quit`, which is
    the point of posting the message rather than terminating the worker.

## PuTTY (Win32) — in progress

The first target here that is neither a game nor a 1990s DOS program: modern C99, a real Win32 GUI,
and a build system that is itself data. Different evidence from the rest — Quake shows PRISM runs a
renderer; this would show it runs an application.

**The unit list is computed, not transcribed.** `tools/putty-sources.mjs` reads every CMakeLists.txt
in the tree, resolves `add_library` / `add_sources_from_current_dir` into libraries and each
executable into the libraries it links. PuTTY moves functions between units in `utils/` constantly,
so a hand-copied list would go stale within weeks. It answers CMake's `if()` guards from a small
table and *reports* every guard it had to take on faith, because guessing one silently is how you
link two definitions of `strtoumax` and blame the compiler. Unknown `HAVE_*` guards default to "no",
since they name compiler or CPU features PRISM does not have.

**The first milestone is `test_terminal`, not the GUI.** It is PuTTY's own unit test for the terminal
emulator: it links `guiterminal`, opens no window, and reports its own pass/fail. An oracle, not a
demo — it says whether the emulator runs before a single GDI call has to exist. 158 units.

**Windows was chosen by measurement, not habit.** The resolver also runs `--unix`, and that variant
pulls in GTK (`unix/window.c`, `unix/unifont.c`, `unix/config-gtk.c`): a larger surface than Win32's,
and the opposite of the situation for Quake. What Win32 does drag in even for a windowless test is
`windows/dialog.c`, `controls.c` and `config.c`, because that is how PuTTY's libraries are shaped.

### Where it stops, and what got fixed on the way

It now clears `defs.h`, `putty.h`, `windows/platform.h` and most of `terminal.c`, and stops in the
Win32 GUI headers. Four defects were real and are fixed:

| what | why it mattered |
|---|---|
| a block comment inside a `#define` ended the directive | **a preprocessor bug**, see below |
| `wchar_t` was undeclared | and it is 2 bytes under `_WIN32`, 4 under i386 SysV — the Microsoft ABI makes it a UTF-16 code unit and PuTTY's Unicode handling depends on that width |
| `wint_t` likewise | `(wint_t)0x9F` would not parse as a cast, so `terminal.c:7147` failed |
| `INT_PTR`, `PCWSTR`, `DECLSPEC_IMPORT`, the `...LongPtr` names, the `WAIT_*` constants | ordinary header surface |

The preprocessor one is worth stating in full, because the fix was wrong in **both** directions
before and `cc -E` settled it rather than a reading of the standard. A comment becomes one space
(5.1.1.2p1 phase 3) and the newlines inside it go with it. So:

```c
#define M(X) \
    X(one) \
    /* a comment
     * spanning lines
     */ \
    X(two)
```

does **not** end at the comment — `M(F)` expands to `F(one) F(two)`, and `putty.h:130` writes its
colour list exactly that way. And the converse:

```c
int x; /* comment
*/ #define Y 1
```

is **not** a directive: `cc -E` leaves `int x; #define Y 1` as text. PRISM set `bol` from whether the
comment's own text contained a newline, which got the first case wrong and the second wrong the other
way. A comment now leaves `bol` exactly as the last real newline set it. Both cases are in
`gate-cpp.mjs`.

### The remaining surface, measured

Ranking every identifier the 158 units use against what `headers-win32.js` declares gives the
families rather than a list of names: window styles (`WS_*`, `WS_EX_*`), dialog and control messages
(`BN_*`, `CB_*`, `LB_*`), the registry (`HKEY_*`, `RegOpenKeyEx` and friends), code pages (`CP_ACP`,
`CP_UTF8`), and GDI's handles and structs (`HFONT`, `LOGFONT`, `TEXTMETRIC`). Bounded, and boring in
a way that Quake's platform layer was not.

### End to end: PuTTY's own test passes, 92/92

```
PuTTY split_into_argv (self-checking) — 136 translation units, 15,122 lines, 14421 functions in 3.3 s
running: putty/test-argv
passed 92 failed 0 (mod 2 mode)
```

`test_split_into_argv` is PuTTY's test for the Windows command-line splitter: it re-implements the
quoting rules and asserts against a table of 92 cases. So this is not "it compiled" — it is 136
translation units of somebody else's application exercising the whole chain, checking its own answers.

**The first run said 41 passed, 51 failed, and the failure was not PRISM's.** `split_into_argv.c:158`
picks its behaviour with `#if _MSC_VER < 1400`, so any compiler that is not MSVC at all reads as
older than Visual Studio 7 and gets the historical mod-3 quirk — while the test file, which cannot
see a macro defined inside a `.c`, always expects the modern behaviour. The two halves of PuTTY
disagree with each other, and MinGW would hit the same thing. Saying `_MSC_VER=1400` for that one
unit says "this compiler is not Visual Studio 7", which is true, and the two halves then agree
exactly. It is recorded in the target as a configuration with its reason, not as a patch.

Three further defects were found by building it, and two of them were in code the corpus had been
exercising for months:

**`TEST` belongs to one file.** `target_compile_definitions(... PRIVATE TEST)` puts it on
`test_split_into_argv.c` alone, and half a dozen units in `utils/` carry their own `#ifdef TEST`
`main()`. Defining it program-wide produced eleven duplicate external definitions including six
`main`s — which the build reported rather than silently resolving. `unitDefines` is how PRISM says
"this file compiles differently", and that is how real builds work.

**Nested designators were ignored past the first.** `.default_value.ival = x` names a field of a
field (C99 6.7.8p6 allows any chain, and lets it mix `.a[2].b`). PRISM read only `designators[0]`, so
the value was written at the right offset with the *outer* member's type — a union, for PuTTY's
`ConfKeyInfo`, which is what stopped the build. Fixed in both the static and the dynamic
initialiser paths.

**`printf` lost zero fill on half the hex values.** `%04X` of `0x6C` printed `"  6C"`. The inf/nan
check — `no padding, no point, no prefix` — tested *every* conversion for a letter, and hex digits
are letters. Comparing the fix against the host `printf` then turned up a second, independent bug in
the same block: `%#010x` of 255 gave `0000000xff` where C gives `0x000000ff`, because the zeros went
before the `0x` rather than after it. Both are in `gate-run.mjs` now, diffed against gcc.

That printf bug had been latent since the conversion rewrite and nothing in the corpus printed a
`%0Nx` with an a-f digit. It surfaced because adding `wchar_t` moved c-testsuite 00220 from *refused*
to *running* — and a refusal that becomes a wrong answer is the one transition worth watching for,
which is why the suite counts them separately. c-testsuite is now 205/219 with 0 wrong answers.

Also fixed on the way: `__thread` is accepted as a storage class (PRISM's target has one thread, so
GCC's thread-local storage means an ordinary static object), and a static-initialiser refusal now
names the object and the unit instead of only the shape it could not emit.

### The terminal emulator itself: `Test suite passed`

```
PuTTY terminal core (self-checking) — 157 translation units, 37,475 lines, 17673 functions in 4.4 s
running: putty/test-terminal
Test suite passed
```

`test_terminal` drives PuTTY's VT emulator through its own table of cases and checks the screen it
produced. 157 units, no window opened, and the answer is the program's own.

Getting there needed the Win32 GUI header surface — fonts and text metrics, the window messages, the
button/combo/list/edit control families, commctrl's tree view and drag list, commdlg's three
dialogues, winspool, winsock's types — plus two headers the *build* writes rather than the tree
(`tools/putty-generate.mjs` makes `licence.h` and `version.h` the way `cmake/licence.cmake` and
`Buildscr` do), and `src/env/win32-app.c`, the non-graphical half of Win32: code pages with real
UTF-8/UTF-16 conversion, memory, last-error. `GetProcAddress` there returns NULL **on purpose** —
PuTTY loads secur32, winspool and half of kernel32 by name and checks the result, so NULL exercises
the program's own fallback instead of faking a function nobody implements.

Three defects in PRISM came out of it, and the middle one is the serious one.

**The emitter had no block scoping.** `this.locals` was one flat map per function and JS variables
were named `_v_<name>`, so two C locals of the same name shared both. `terminal.c:clipme` declares
`char buf[2]` inside a block of a function whose outer `buf` is a `clip_workbuf`, and every use of
the struct after that block resolved to `char[2]`. Fifteen lines reproduce it:

```c
struct W w; w.n = 1;
{ char w[2]; w[0] = 'x'; }
printf("%d", w.n);          /* 'char[2]' has no member 'n' */
```

Each declaration now gets a name unique within the function (`w`, `w$1` — `$` cannot appear in a C
identifier), including the private symbol a `static` local gets, and blocks restore what they
shadowed. c-testsuite went 205 → 206.

**That let a refusal be lifted rather than worked around.** `flatten.js` refused a function needing
control-flow flattening when two sibling blocks declared the same name, because hoisting them to
function scope would have shared one variable — exactly the bug above. With storage now distinct per
declaration, and flattened order being program order, the refusal has nothing left to protect and is
gone. `terminal.c:term_out`, the emulator's central routine, is what it was blocking.

**`inttypes.h` was a stub**, so `HAVE_STRTOUMAX` had to be answered "no", and PuTTY's own fallback
declares a `static inline strtoumax` over MSVC's `_strtoui64` in *every* unit that includes
`platform.h` — 105 functions lost to one missing declaration. A real `inttypes.h` plus
`src/env/inttypes.c` (in C, because `intmax_t` is `long long` and PRISM's 64-bit convention is a
BigInt the runtime would have to honour at the boundary) answers it "yes" and the workaround
switches off. Note the shape of that number: **one gap, 105 casualties**, which is why the build
groups its refusals by cause.

Two smaller things paid for themselves immediately: `assert` now says *where* and on *stderr*
(C99 7.2.1.1 — and stdout would leak into anything diffing a program's output against gcc's), and
the build's refusal report names an example site per cause. `'char[2]' has no member 'textbuf'` is
useless without `terminal.c:clipme` beside it.

The resolver also learned **static-library semantics**, in the one shape PuTTY leans on: an
executable listing `no-jump-list.c` among its own sources also links the library holding
`jump-list.c`, and a real link takes only the first. Modelling it properly needs symbol tables; what
is modelled is the `no-X.c` naming convention, and every file it drops is reported.

### PuTTYtel: the real GUI client, compiled, up to the message loop

```
PuTTYtel (Win32 GUI, no crypto) — 188 translation units, 57,049 lines, 22,7xx functions in 6.6 s
start-up: WinMain -> ShowWindow -> ShowWindow -> cmdline_process_param x3
          -> RegisterClassW -> CreateWindowExW
window: "PuTTYtel"
```

`puttytel` is PuTTY's Windows client with the SSH stack left out: `window.c`, the configuration box,
the terminal, telnet/rlogin/raw/serial. It **compiles**, and running it reaches its own window: it
processes the command line, registers the wide window class and creates the terminal window with the
title it chose.

**What is NOT established: it does not get past the message loop.** Given `-telnet localhost` the
program enters its event loop and does not come back, and the harness's hooks on `GetMessage`,
`DispatchMessage`, `MsgWaitForMultipleObjects` and a dozen other candidates never fire — so the loop
is somewhere those wrappers do not reach and the cause is not yet identified. Nothing is drawn: the
GDI layer below accepts text and returns success without a raster behind it. Said plainly because
"compiles and creates its window" is a real milestone and "runs" is not yet true.

**The platform layer split three ways**, and each file's boundary is a claim about what it is:

| file | what it is |
|---|---|
| `win32.c` | the WINDOW: a class, a message queue, a rectangle. Already Quake's. |
| `win32-app.c` | what a Win32 program calls when it is NOT drawing: code pages (real UTF-8/UTF-16), memory, last-error, the registry, dynamic loading |
| `win32-gui.c` | user32 and GDI for a program with a window but no screen |
| `win32-net.c` | Winsock, present, with no network behind it |

Seven functions moved out of `win32.c` into `win32-app.c` when PuTTY needed them without a window;
Quake's `win` variant now links both, which is why that split is stated rather than implied.

**Two of those files answer a question rather than dodging one.** Winsock exists and reports
`WSAENETDOWN` — the same shape of answer PRISM gives for an absent CD drive or sound card — because
without it `sk_init` calls `modalfatalbox("Unable to load any WinSock library")` and PuTTYtel exits
before drawing anything. And the registry reports `ERROR_FILE_NOT_FOUND` for every key, so PuTTY
finds no saved sessions and uses the defaults compiled into it: a path the program has and tests. An
in-memory registry that forgot everything between runs would reach the same place dressed as a
feature.

`GetProcAddress` no longer returns NULL unconditionally. A shim file publishes a table of
`{module, name, function}`, and `win32-app.c` finds it through an `extern` that a target without
that file never defines — which PRISM reads as a null pointer, exactly as a linker would leave it. So
a console target resolves nothing and a target linking `win32-net.c` resolves winsock and comctl32,
with no conditional anywhere. It has to match on the DLL's **basename**: PuTTY's `load_system32_dll`
loads by full path on purpose, and its own comment says why.

**Three more things the build system hides that had to be modelled.** `be_list()` compiles one
shared file per application with the backend list and the program's name — without it `backends[]`
is empty and PuTTY asserts `n_ui_backends > 0` before it can build its configuration box.
`$<TARGET_OBJECTS:logging>` embeds one library's objects in another, which no executable's link line
mentions — dropping it left `log_init` undefined and killed PuTTYtel immediately after it created
its window, the one failure in this target that was not a missing declaration. And `HAVE_*` guards
have to be answered **twice**: once for file selection and once as preprocessor macros, and the two
must agree — `HAVE_GCP_RESULTSW` was the one where "undefined means 0" was the wrong answer.

**A known limitation, stated as one:** PRISM compiles no `.rc` resources, so `CreateDialog` has no
template and returns NULL. PuTTY's configuration box therefore cannot be shown, and `ShinyDialogBox`
spins waiting for a dialogue that will never end. Naming a session on the command line is the
program's own way past it.

### The Win32 shim rasterises text

`win32-gui.c` now has a framebuffer and a font instead of drawing calls that returned success into
nothing. `node tools/gate-vgafont.mjs --png=/tmp/font.png`:

```
the font
  ok    prism_vga_font is bound (1222808)
  ok    4096 bytes in guest memory match the ROM file
the surface
  ok    allocated (320x48, pitch 1280)
  ok    sized from the window rectangle, not guessed
  ok    20 glyph cells drawn for 20 characters
the glyphs, against the ROM bytes
  ok    all 20 glyphs match the ROM exactly
  ok    the six box-drawing characters reach their code page 437 glyphs
```

**The font was already here.** `assets/vga-rom-8x16.bin` is what `web/app.js` draws DOS text mode
with — 256 glyphs of 16 rows, most significant bit leftmost. `src/env/vgafont.js` interns those 4096
bytes in guest memory and points a global at them, so compiled C can read the same file the page
does. Not a C array in the shim, which would be a second copy free to drift; not fetched at run time,
because the font is not the program's data, it is the **platform's** — a Windows box has fonts before
any program starts.

**Unicode reaches the ROM through code page 437.** Latin-1 passes through, the box-drawing characters
PuTTY frames its own UI with are mapped by hand, and everything else becomes the filled box a font
without the glyph is supposed to show. That map is the one part of this that is a decision rather
than a copy, so the gate checks it separately.

**What the gate checks is not "pixels changed".** Each glyph is compared against the ROM bytes it
came from, bit for bit, so a font loaded at the wrong offset, a row drawn upside down, or a leftmost
pixel taken from the low bit all fail here instead of looking plausible.

Two simplifications, named rather than hidden: **one surface for the whole window**, because every
HDC draws into it — Windows would give each DC its own target, and this program has one window; and
**a brush is its colour**, tagged into the handle, because PuTTY only ever fills with brushes it made
or with a system colour.

**PuTTY still cannot show it.** With no network it reports "Host does not exist" and exits before its
message loop, so it never repaints — the surface it leaves behind is the 100x100 hidden timing
window with one glyph in it. Seeing a PuTTY terminal needs a session that starts, and the honest way
to that is a real Winsock over the host's sockets rather than a peer invented here. That is the next
piece, and it is a different piece.

### WM_PAINT: the update region

A window that never repaints is not a window. `win32.c` now keeps the thing that makes one: the
region of the window that is invalid, and the three behaviours that hang off it —

```
the update region
  ok    a clean window has no message waiting
  ok    InvalidateRect makes the next GetMessage a WM_PAINT
  ok    and it KEEPS being one -- removing the message does not validate
  ok    BeginPaint reports fErase and the whole client rect (320x48)
  ok    BeginPaint validates: the WM_PAINTs stop
  ok    the named rectangle comes back (24,32,48,64)
  ok    ShowWindow does NOT invent a paint
```

All three matter and getting two of them right is worse than getting none: a program that never
repaints and a program that repaints for ever look the same from outside — busy — and neither looks
like a bug.

**`DefWindowProc` validates**, which is the half that is easy to leave out. Windows documents it as
calling BeginPaint and EndPaint itself, and Quake is exactly the program that needs it: its
`MainWndProc` handles WM_PAINT (`vid_win.c:2919`) but `Sys_SendKeyEvents` pumps with
`while (PeekMessage(..., PM_NOREMOVE))`, so a WM_PAINT nobody validates is an infinite loop.

**Nothing invalidates on its own, and that is a decision.** Windows also repaints when a window is
shown, resized or uncovered. Doing that here made `gate-pixels` go red on 152 rows, because Quake
answers WM_PAINT with `SCR_UpdateWholeScreen` — inventing paints invented full-screen redraws.
Nothing in this host covers or resizes a window behind the program's back, so there is nothing for
the platform to report, and guessing how many times a window manager would have done it is noise
rather than fidelity. The gate asserts the absence.

**Window words are real storage.** `SetWindowLong`/`GetWindowLong` used to return 0 and forget.
PuTTY puts the pointer to its entire session into `GWLP_USERDATA` at `WM_NCCREATE` and reads it back
at the top of every `WndProc` call, so forgetting means WndProc gets a null session on the first
message it is sent. Keyed by window as well as by index, because PuTTY's hidden timing window and its
terminal both use slot -21.

**PuTTY's own painter is reached.** Standing in for the message loop the program cannot get to —
invalidate, pump, dispatch — runs `WndProc` → `do_paint` → `term_paint`, and it stops there on
`cline==NULL ... w=0 h=0`: the terminal has no lines because the session never started. That is the
network, downstream, and not the window.

### P10.7 — Winsock over the host's sockets: PuTTY connects, and the terminal draws

```
  +   51ms getaddrinfo -> 0
  +   52ms socket -> 1        setsockopt -> 0    bind -> 0    WSAAsyncSelect -> 0
  +   52ms connect -> -1      (WSAEWOULDBLOCK, as a non-blocking socket must)
  +   82ms netevent(sock=1, FD_CONNECT, err=0) / FD_READ / FD_WRITE
  +  114ms recv -> 20         "Hello from PRISM\r\n$ "
  +  140ms recv -> 49
```

A real TCP connection to a real server, and the bytes reach PuTTY's terminal, which draws them
through the VGA ROM font.

**Why a thread.** `program.run` is one long JavaScript call, so node's event loop cannot run while
the guest is executing and an asynchronous socket can never fire. The sockets therefore live on
another thread (`tools/net-worker.mjs`) and share memory with the guest — the same arrangement the
browser build already uses for sound and stdin. `src/env/wsock.js` is the guest's half and hands the
compiled C six primitives; everything Winsock-shaped stays in `src/env/win32-net.c`, because the
shape is a contract the compiler settles better than hand-written offsets.

**The guest never blocks on a socket**, and that is PuTTY's doing rather than a design of ours: its
Windows client asks to be TOLD when a socket is ready (`WSAAsyncSelect` → `WM_NETEVENT`), so `recv`
is only called when bytes are already there. The one place it waits is
`MsgWaitForMultipleObjects`, and that now waits on the socket thread's ring.

**An address here is a TOKEN.** The socket thread connects by name — node's `connect` does its own
lookup — but PuTTY resolves first and connects to a `sockaddr` second, so `getaddrinfo` hands back
`10.0.0.N`, meaning "the Nth name this program asked about", and `connect` turns it back. No packet
carries it and nothing outside that file reads it; the cost is that a program printing the peer's
address would print the wrong one, which is why it is written down.

Five defects in the platform layer came out of making a session actually run, and every one of them
was invisible while nothing arrived:

| what | why it mattered |
|---|---|
| events posted in ASCENDING BIT ORDER | `FD_WRITE` (2) reached PuTTY before `FD_CONNECT` (16), so it heard "you may write" about a socket it did not believe was connected, and closed it. Windows reports the connection first and the close last |
| every message carried ONE global window | a program reads its own state back out of the handle a message carries, and PuTTY does `GetWindowLongPtr(hwnd, GWLP_USERDATA)` at the top of every `WndProc` call. A `WM_PAINT` delivered under the hidden timing window's handle handed it a null session — the crash surfaced four calls away, inside `terminal.c`, as a terminal whose every field was zero |
| ONE window procedure for all classes | PuTTY registers a class for its terminal and another for a window that exists only to receive `WM_TIMER`; the last registration won, so every timer went to the terminal's procedure, which ignores it |
| `SetTimer` and `KillTimer` did nothing | PuTTY does not repaint when data arrives — it schedules a timer and repaints when it fires. The bytes reached the terminal, the terminal recorded them, and the screen stayed blank |
| `PRISM_BRUSH_TAG` defined BELOW its first use | `CreateSolidBrush` therefore never emitted, silently, below the twelfth-most-common cause in the build report. `--failures=40` is why it was found |

**And it draws:**

```
Hello from PRISM
$
```

on a black terminal, 642x386, in the VGA ROM font — `node tools/putty-testserver.mjs &` then
`node tools/putty-session.mjs <port>`, which writes /tmp/puttytel.png.

Two more defects stood between "connects" and "shows text", and both were about COLOUR:

- **`Rectangle` filled with the text colour.** Windows fills it with the *selected brush* and
  outlines with the selected pen; `SelectObject` returned its argument and remembered nothing, so
  PuTTY's paint of the area around its terminal covered the whole window in 187,187,187 — which is
  PuTTY's default foreground, and looked exactly like a background bug.
- **The test server was corrupting the protocol.** Echoing everything back sent telnet negotiation
  bytes to the terminal, which decodes UTF-8 (PuTTY's `decode_codepage` answers 65001), and the
  screen filled with U+FFFD. The server's fault, not the terminal's, and worth recording because the
  symptom pointed squarely at the character-set code.

## The Linux machine gets its second video driver: Quake on svgalib

```
node tools/build.mjs targets/quake.json:svgalib --run --data=<dir with id1/> --frames=60 --png=/tmp/svga.png

QUAKE (Linux svgalib, id386=0) -- 68 translation units, 45,671 lines, 1052 functions
frames 60 · display 320x200
60701 non-zero pixels of 64000, 141 colours
```

`vid_svgalib.c` is the other video driver id shipped for Linux: no X server, no window, just the
framebuffer of a virtual console and the raw keyboard. Like `vid_x.c` and `vid_sunx.c` it is a whole
platform layer in one file — `VID_*`, `Sys_SendKeyEvents` and every `IN_*` — so the choice between
them is a **display path inside one machine**, not another machine. The shelf's Linux row now offers
both, which is what the program itself offered.

**The roadmap said this shared P3.5's blocker, and it does not.** I had written that the driver "is
bank-switched and planar". It has both paths —

```c
VGA_planar = modes[current_mode].bytesperpixel == 0;
...
if (VGA_planar) VGA_UpdatePlanarScreen (vid.buffer);   /* d_copy.s, no C equivalent */
```

— but with no arguments the driver takes `current_mode = G320x200x256`, and on a real svgalib that is
a **linear** eight-bit mode: `bytesperpixel == 1`. So the planar branch is not avoided by a trick, it
is not the mode the program asks for, and `VGA_UpdatePlanarScreen` is the one unresolved symbol in
the build — referenced, never called. A planar svgalib mode would still need what mode X needs.

**The two input surfaces are the cheapest in the corpus.** svgalib delivers a **raw PC scan code** to
a handler the client installs, and **relative** mouse deltas to another. Those are exactly the two
channels the control block already carries, so this layer forwards where the X11 one translates.
Two details are still the host's to get right:

* **One event per `keyboard_update()`.** The client's loop is `while (keyboard_update());`, so a
  function that drained the queue and returned 1 would spin for ever, and one that returned 0 after
  draining would deliver only the first key.
* **svgalib's own button bits**, which are not the channel's: `MOUSE_LEFTBUTTON` is 4 and
  `MOUSE_RIGHTBUTTON` is 1. Quake then indexes them `1 << i` for K_MOUSE1..3, so on real svgalib its
  "button 1" is the right-hand one. That is id's mapping and reproducing it is the point.

**A struct's SIZE is part of this ABI.** The driver does
`Q_memcpy(&modes[i], vga_getmodeinfo(i), sizeof (vga_modeinfo))`, so `vga_modeinfo` is written out in
full — all seventeen i386 words — even though five fields are read: a short declaration would copy
garbage over whatever followed it. Same class of fact as `src/env/x11.js`'s event offsets.

**One header decision was mine and it was wrong first.** I declared `<asm/io.h>` empty on the grounds
that port I/O was svgalib's own business. The **game** does it: `D_BeginDirectRect` and
`D_EndDirectRect` program the VGA sequencer and graphics controller by hand to select a plane before
drawing the little status rectangles. Empty made both unemittable ("call to undeclared function
`outb`"). Declared, they route to PRISM's port machine — with the arguments swapped, because Linux's
`outb` takes the value first and the DOS convention does not.

**The gate is the result.** `tools/gate-pixels.mjs` now asserts a fourth pair:

```
x11 == svgalib   identical, 64000 pixels and 768 palette bytes
all 3 asserted comparisons agree
```

Bit-identical over the whole surface and the whole palette — which is what two drivers over one
renderer and one linear 8-bit buffer should give, and would have caught a palette shifted by the two
bits `VID_SetPalette` drops on the way into `vga_setpalvec`. `gate-run` stays 60/60.

## The fps number was sixteen days old and wrong by a factor of sixty-six

The summary table said Quake ran "at ~26 fps in the browser". That sentence entered on **24 August**
(`git log -S"26 fps"` → e6cabbe) and was never re-measured while direct calls, four more platform
layers and the whole four-machine shell landed on top of it. A peer session reading the docs quoted
it back as PRISM's performance. So it was measured, three ways, and all three are now in
[ARCHITECTURE.md](ARCHITECTURE.md):

| what | number | conditions |
|---|---|---|
| Quake in the browser, paced | **72.0 fps** | 320x200; this is `Host_FilterTime`'s own 1/72 s, i.e. **Quake's ceiling, not PRISM's** |
| Quake in the browser, cap off | **1,725 fps** | the shell's speed selector on *unlimited*, ~19,000 frames in |
| Quake headless in Node | **883 rendered frames/s** | 16,000 frames; 204 / 472 / 721 at 300 / 1,000 / 4,000 |

**The discriminator was the speed selector, not an argument.** At 100% the page paces the guest to
the rate the program asked for, so 72.0 fps could equally have meant "throttled" or "flat out". One
change to *unlimited* settled it: 1,725. The engine has 24x the headroom it needs.

Two things this exercise established that are worth more than the numbers:

* **JIT warm-up dominates any short run.** The same headless run gives 204, 472, 721 and 883 rendered
  frames/s at 300, 1,000, 4,000 and 16,000 frames. A few hundred frames measures V8 warming up.
  `tools/bench.mjs` had already said so; a fresh measurement walked into it anyway.
* **Headless and browser figures are not comparable**, and `build.mjs` now says so in the output it
  prints. Headless keeps the runtime's DETERMINISTIC clock — `gettimeofday` advances a fixed 1/35 s
  per call — so the guest's time races the wall and Quake renders on every iteration of its main
  loop; that is **throughput**, not a frame rate. The browser calls `installRealClock`. The tool
  prints `883 rendered frames/s (deterministic clock, unthrottled)` rather than "fps" for exactly
  this reason. The ~2x gap between the two is **not explained here**, because nothing has measured
  it, and explaining a gap without measuring it is how the 26 fps survived.
