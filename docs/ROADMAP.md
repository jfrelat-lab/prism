# PRISM — Roadmap (a menu, not a schedule)

North star: **MAME 0.1, then Quake, then Doom**, compiled from unmodified source and running in the
browser. Effort: **S** ≤ half a session, **M** ≈ one focused session, **L** = multi-session.
See [COMPAT.md](COMPAT.md) for what runs and [TESTING.md](TESTING.md) for the gates.

## P0 · Foundation and oracles (no game yet)

| # | Task | Effort | Why / unblocks |
|---|---|---|---|
| P0.1 | ✅ **DONE** — the oracle: `linux/386` gcc 12.2 + csmith 2.3 container, long-lived, `tools/oracle.mjs`. Measured the host has no gcc, no `-m32`, no cross-compiler, no csmith; measured `docker run` 3.8 s vs `docker exec` 46 ms; fixed Debian's csmith shipping no runtime headers (three are `m4` templates). | — | done |
| P0.2 | ✅ **DONE** — `src/sema/abi.js` + `tools/gate-abi.mjs`. Exact i386 layout, gated on 105k checks across 13 seeds, sensitivity-checked. Found three bitfield rules by generation that hand cases missed. | — | done |
| P0.3 | ✅ **DONE** — `src/cpp/` (lexer, `#if` evaluator, directives, Prosser expansion) + `tools/gate-cpp.mjs`. Token-identical to `gcc -E` on 42 hand cases (including the canonical C99 6.10.3.5 example and Prosser's `f(2)(9)`) and 250 generated cases × 7 seeds. Generation found four rules the hand cases missed and sensitivity-checking found two runaway defects. See [TESTING.md](TESTING.md). | — | done |
| P0.3b | **Frame-stack expansion** instead of `splice()`. Today's work list is rewritten in place, which is quadratic when a macro grows it — bounded and reported, never a hang, but it will matter on real headers. **Do not start this before measuring it on the corpus**: the premise is unmeasured, exactly the shape of MIRAGE's retracted D6 diagnosis. | M | Compile speed on glibc/DJGPP-scale headers. |
| P0.3c | **Tier B of the cpp gate**: whole files from `corpus/` with a real include path, not just self-contained snippets. Needs a DJGPP-ish header set, so it lands with P3.1. | M | The gate currently proves the preprocessor on cases I wrote; this proves it on the code that matters. |
| P0.4 | ✅ **DONE** — `src/parse/parser.js` + `src/sema/types.js` + `tools/gate-decl.mjs`. C89 complete (K&R definitions, implicit `int`, nested declarators), the useful C99, GNU (`__attribute__`, `typeof`, `({...})`, statement exprs, case ranges). Gated on 8400+ checks across 4 seeds: sizeof/align/offsets/enum values of every tag and typedef PRISM understands, asked of gcc. ⚠️ **Statements and expressions are parsed but NOT gated** — nothing observes them until the backend exists (P0.5). | — | done |
| P0.5 | ✅ **DONE** — `src/link/module.js`, `src/backend/emit.js`, `src/runtime/runtime.js`, `src/env/headers.js`, `src/compile.js` + `tools/gate-run.mjs`. **22/22 programs behave identically to a native i386 build.** Even tier-0 keeps a non-address-taken scalar local in a JS `var`; everything else goes to a shadow stack. Six real defects found by running, and two of my own test cases turned out to test undefined behaviour — see [TESTING.md](TESTING.md). | — | done |
| P0.5b | 🟡 **`long long` DONE** — tier-0 represents a 64-bit integer as a **BigInt**, not as i32 pairs. The plan called for pairs; tier-0 is the compact/generic path and BigInt is correct by construction (arbitrary precision plus an explicit 64-bit mask) where pairs need ~20 helpers and a return-value convention. Every crossing in or out is explicit, so a missed conversion throws `Cannot mix BigInt and other types` instead of producing a wrong number. **Torture 892 → 1206, c-testsuite 183 → 192.** `long long`, structs by value, asm parsing, `<stdarg.h>` + user variadics, `goto`, GNU label addresses and computed goto, bitfield `++`. Remaining, ranked by measurement: nested functions (24), non-empty inline asm (19), compound literals as lvalues (18), address constants the folder still refuses (17), the remaining headers (17), labels nested in a block (14), `long double` (11). Structs by value and empty-template asm are DONE. | L | `npm run gaps:torture`. |
| P0.5c | **Lower i64 to i32 pairs in tier-1.** BigInt is a correctness choice with a real speed cost; tier-1 must lower it. **Do not start before measuring** — the cost is currently unquantified, which is exactly the shape of MIRAGE's retracted D6 diagnosis. | L | Depends on P2.4 producing a number first. || P0.6 | ✅ **DONE (c-testsuite)** — `tools/gate-suite.mjs`, gcc captured once into `tools/suite-baseline.json`. **182/219 pass, 0 wrong answers.** Found four real defects including a stack-frame lifetime bug and a silent `long long` miscompile. See [TESTING.md](TESTING.md) for the ranked gaps. | — | done |
| P0.6b | ✅ **DONE** — `gcc.c-torture/execute`, 1592 programs, fetched from the gcc 12.2 tarball. **869/1558 pass, 0 unexplained wrong answers.** Two tables (`__builtin_*` aliases and gcc's predefined TYPE macros) moved it from 696 to 868 with no compiler work. Forced three harness corrections — per-program timeouts, excluding tests the gcc reference itself fails, and reclassifying `abort()` as a defect rather than a gap. See [TESTING.md](TESTING.md). | — | done |
| P0.6c | ✅ **LARGELY DONE** — 37 miscompiles down to 6, torture 869 → 892. Seven causes: `aligned`/member-`packed` attributes, a half-fixed address-precedence bug worth 15 programs on its own, bitfield integer promotions, float constant folding, bitfields in brace initialisers (dynamic *and* static), `extern` in a block, plus turning type-changing attributes and wide literals into refusals. See [TESTING.md](TESTING.md). Remaining: ~8, mostly wide chars and a few one-offs. | — | mostly done |
| P0.6d | ✅ **DONE** — wide literals as 4-byte elements, plus the endianness macros and bitfield placement in unions (a class the ABI generator had never produced). Torture 885 → **892**, miscompiles 8 → **6**. | — | done |
| P0.6e | ✅ **DONE** — **zero wrong answers** across 1556 torture + 219 c-testsuite programs. Bitfield assignment value, byte-transparent source reading, cast folding, flexible array members, and two tests excluded as UB. Literal decoding de-duplicated into `src/util/charset.js`. | — | done |
| ~~P0.7~~ | ✅ **DONE** — `tools/csmith-diff.mjs`. Random programs against `gcc -O0`/`-O2`, with gcc-vs-itself as the UB filter so a divergence is evidence about PRISM and not about csmith. Found **six defects in the first forty programs**, one of them a silent wrong answer: an integer constant's type ignored its base, so `0xAD2A1758533D8CC8LL` — above LLONG_MAX and therefore *unsigned* — was read as negative. Also `#pragma pack` (unimplemented), bitfields straddling a 32-bit unit (refused), the 64-bit half of `stdint.h` (absent), C99 hex float constants (silently zero), the `fabsf` family, and a record rvalue through `*p`.<br><br>Reduction needed no reducer: csmith's per-variable CRC narrows 378 globals to one, inverting that CRC recovers the value each side held, and a printf on every `block id` turns execution into a diffable trace — 1,608 lines down to one `if`. See docs/TESTING.md. | M | The `test386.asm` of C, and it earned the comparison in an afternoon. |

## P1 · MAME 0.1

| # | Task | Effort | Why |
|---|---|---|---|
| P1.1 | ✅ **DONE** — corpus fetched, `tools/mame.mjs` builds and runs it. | — | done |
| P1.2 | ✅ **DONE, and no Allegro shim was needed** — MAME's own `osdepend.h` boundary is eighteen functions, so `src/env/osd.js` replaces `src/msdos/msdos.c` wholesale. The libc extras were measured from MAME's sources, not guessed: `stricmp fopen fclose fread fwrite getchar rand`. | — | done |
| P1.3 | ✅ **DONE** — Pac-Man runs and every frame is bit-identical to a native gcc build over 200 frames (`tools/mamediff.mjs`). Two defects found: a runtime builtin shadowed the program's own function definition (twelve-hour hang), and the platform backend allocated in the static area instead of the guest heap. | — | done |
| P1.4 | ✅ **DONE** — `tools/z80diff.mjs`. Found the defect in seconds: compound assignment evaluated the lvalue before the right-hand side, so `R.PC.W.l += (offset)M_RDMEM_OPCODE()` made every relative jump one byte short. The core is now identical to gcc over 20006 steps including the interrupt path. | — | done |
| P1.5 | ✅ **DONE** — `web/` + `tools/serve.mjs`: a program-agnostic browser shell. Guest in a Web Worker over a SharedArrayBuffer; the page observes guest memory, because a C main loop never yields and rewriting it (Emscripten's `emscripten_set_main_loop`) is the modification this project refuses. One surface, text until the program creates a display; scan codes in; `argv` through to `main`. Pac-Man is playable at a measured 60.0 of 60 fps. Four defects, and one lesson: **every gate was green while the game was unplayable** — nothing headless has a frame rate. See [TESTING.md](TESTING.md). | — | done |

| ~~P1.7~~ | ✅ **DONE.** `src/env/osd.js` is deleted and MAME compiles its own `src/msdos/msdos.c`, the file its makefile selects for DOS. What is shimmed is one level down: `src/env/allegro.js` (Allegro's 13 functions, SEAL's 17, DJGPP's memory helpers), `src/env/headers-djgpp.js` (`allegro.h audio.h go32.h sys/farptr.h dos.h io.h`), and a generated unit that DEFINES `screen`, `key[]` and the joystick globals — real C objects, because msdos.c takes their address and indexes them.<br><br>Three predictions from this entry held: no VGA register emulation was needed (both display paths end in `_dosmemputl`, and the geometry comes from the game's own `bitmap` global), SEAL is a second library and not part of Allegro, and P5.1's port intrinsics were the only compiler-level blocker.<br><br>One prediction was **wrong**: `TwkUser.c` is not merely compiled, it is called — `outRegArray` reprograms the CRTC on the mode-13h path. It changes nothing the host reads, which is why it does not matter, but "included but never called" was not true.<br><br>What was NOT predicted, and is the more interesting half: **the keyboard stopped being a function.** `osd_key_pressed` is now the game's own C reading `key[]` out of memory, so `while (osd_key_pressed(k));` calls nothing and spin damping cannot see it. That loop needs the safepoint — which is the honest analogue of what a real Allegro does, an interrupt handler writing key[] asynchronously. | M | Done. |
| P1.8 | **A process model, so Doom can have sound.** `linuxdoom-1.10/doomdef.h` defines `SNDSERV`, so the Doom id published delegates its sound to a separate program it starts with `popen("./sndserver ", "w")` and drives over a pipe. That program is `corpus/DOOM/sndserv/` (2,026 lines) and it already **compiles and mixes correctly** — `tools/sndserv.mjs` runs it alone and it produces Doom's own effects at 11025 Hz stereo through `src/env/dsp.js`. What is missing is two address spaces and a scheduler.<br><br>The two alternatives are both refusals of the project's premise: defining `SNDSERV` away is a source modification, and reimplementing Doom's mixer in JavaScript is exactly what src/env/osd.js was deleted for. A second Worker with its own image and a shared pipe is the shape — the audio ring is already shared memory, so the sound half needs nothing new. | M | Also the general answer for `fork`/`popen`, which Quake's and SQLite's paths have both stubbed so far. |

## MIRAGE + PRISM: where the two projects meet

The division of labour, stated as the north star it is: **MIRAGE owns the low level, PRISM owns the
high level, and they meet at the device boundary.** Not at the CPU — PRISM has none and wants none.

That boundary is more precise than it sounds, and it is already implemented on MIRAGE's side. A
MIRAGE device installs itself with `installVGA(machine)` and asks its host for almost nothing:

| What a MIRAGE device needs | Count in `vga.js` / `keyboard.js` |
|---|---|
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
|---|---|---|
| 1 | **P5.1 — the `inportb`/`outportb` intrinsics** | Everything hinges on this one piece. It IS the seam, and the same two intrinsics separately unlock MAME's own `msdos.c` (P1.7) and Quake's `sys_dos.c`. Nothing else in the roadmap has three payoffs. |
| 2 | **The `machine` adapter** (~40 lines) | Lets any MIRAGE device install into PRISM unchanged. |
| 3 | **First device: the PIT** | Quake's `Sys_FloatTime` needs only channel-0 latch-and-read plus the BIOS tick at 0x46C. Small enough to prove the seam end to end, and real time is what fixes game speed from inside the program. |
| 4 | **Keyboard** | MIRAGE's `keyboard.js` already models scancodes AND the BIOS queue — the same two-question distinction PRISM re-invented in `src/env/webhost.js`. Converging removes a duplicate, it does not add a dependency. |
| 5 | **VGA** | **Free for mode 13h**: a linear framebuffer at an address PRISM already has, so it is only memory. **Not free for planar**: EGA/VGA latches and masks need a write barrier on the 0xA0000 window, and that is exactly the memory-dispatch cliff MIRAGE measured (three strategies built and rejected). Decide it on a number, not before. |
| 6 | **The renderer** | PRISM's shell re-implemented MIRAGE's text mode, down to using its font ROM. Adopting `video.js` deletes that duplication outright. |

### What does NOT converge, and the honest limits

* **The compiler and the recompiler share nothing.** One translates C, the other x86. Do not force it.
* **The seam is asymmetric.** MIRAGE's devices assume a CPU that traps I/O and memory; PRISM traps
  function calls. Thin for ports, thick for memory — see step 5.
* **This does not rescue MIRAGE's blocked list in general.** MIRAGE cannot run DPMI titles, and PRISM
  can only reach a program whose SOURCE was published. Doom qualifies (the Linux tree). OMF, Jazz and
  Zone 66 never will. The union is "published source **and** hardware needs", not "everything".
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
|---|---|---|---|
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

## P2 · Performance

| # | Task | Effort | Why |
|---|---|---|---|
| P2.1 | **IR + escape analysis / mem2reg**, now with a measured head start. `--direct-calls` (emit a call to the function's own identifier instead of `F["name"]` on a thousand-property object) is **2–2.5× on its own**, taking the gap to clang -O2 from ~10× to ~5× — one line of the emitter. It is off by default only because harnesses instrument by rebinding `prog.F`; the fix is a module-scope `let` per function plus a `rebind`. Do that first, then the IR: every remaining memory access goes through a DataView and every address-taken local lives in the heap. | L | Csmith (P0.7) is the net that makes optimising safe: tier-0 == tier-1 is now checkable. |
| P2.2 | Alignment inference, GVN on address arithmetic, LICM, inlining. | L | |
| P2.3 | **tier-0 → tier-1 promotion** + inline caches on function pointers. | M | |
| P1.6 | **A live-C mode in the shell** — edit a translation unit in the page, recompile, restart. Cheap *because* `source` mode already compiles in the browser: the compiler is already there, `resolve` already serves from an in-memory tree, and a compile is 700 ms for MAME. What it needs is an editor pane, an overlay over the fetched tree so an edit shadows the served file, and error locations mapped back to a line. It is the mode where PRISM's premise is visible to a person rather than argued: change a line of 1997 C and watch it take effect. Note it is exclusive to `source` mode — a `bundle` (P2.5) has no source to edit. | M | Not on the critical path to Quake or Doom. Do it when the compiler stops being the thing that needs attention. |
| P2.5 | **Two load modes, over one serialised IR.** Today the shell always compiles from source in the page. Once P2.1 gives us an IR, add a second mode: `source` (fetch C, compile in-page, promote to tier-1 at run time — the only mode where editing a `.c` file is visible immediately) and `bundle` (fetch a prebuilt artifact and start instantly). **The bundle's payload is the IR, not the emitted JavaScript** — that is the whole design constraint. Shipping only emitted tier-0 would cap a cached program at tier-0 for ever, which buys start-up at the price of the performance ceiling and turns PRISM into a worse Emscripten. With the IR present, tier-1 re-emits at run time exactly as it does in `source` mode. Artifact = {serialised per-function IR, resolved type/layout table, the static memory image, the symbol and function-table map, the platform layer it requires, **and the compiler's own version hash**}. Invariant, same discipline as tier-0 == tier-1: a `gate-bundle` must show a bundle run and a source run producing identical state frame for frame. | L | Start-up cost only becomes real with Quake: MAME is 6.3k lines → 0.45 MB of JS in ~700 ms, so Quake's 44.6k lines extrapolates to seconds and megabytes — an estimate, flagged as one, to be measured rather than assumed. |
| ~~P2.4~~ | ✅ **DONE** — `tools/bench.mjs`, and it no longer needs a ROM (`--synthetic`). Two workloads published separately: **~9.5×** slower than clang -O2 on MAME's Z80 core with Pac-Man, **~10×** on the synthetic mix. Half the gap at short workloads is JIT warm-up. | M | And a measured lead: `--direct-calls` is **2–2.5×**, see P2.1. |

## P3 · Quake

| # | Task | Effort | Why |
|---|---|---|---|
| ~~P3.1~~ | ✅ **DONE** — `src/env/headers-djgpp.js`: `go32.h sys/farptr.h sys/movedata.h dpmi.h dos.h io.h`, plus `pc.h` from P5.1. Written for MAME's `msdos.c` (P1.7) rather than for Quake, which is the ordering the roadmap did not predict. | M | The `outportb` premise was wrong — see P5.1. |
| ~~P3.2~~ | ✅ **DONE** — `WinQuake/` compiles and runs: 1030 functions, 1.73 MB of JavaScript in 0.9 s, demo1 at **525 fps**. `id386=0` turned out NOT to be the switch: `TARGET_DEFINES` sets `__i386__`, so the tree had been built in the wrong configuration all along until `mergeDefines` learned that `null` means *undefine*. | M | |
| P3.3 | **The real DOS platform units for QUAKE.** Half of this arrived from an unexpected direction: Heretic and Hexen needed a Watcom/DOS4GW host, so `src/env/watcom.js` (int386, the vector table, DPMI, DMX), `src/env/crtstatus.js` (the 0x3DA retrace bit) and `src/env/vgadac.js` (the colour DAC) now exist, and **interrupt delivery works** — a registered handler is a function pointer PRISM can call, driven from the safepoint. Mode 13h needed no emulation at all: it is a linear framebuffer at an address PRISM already has.<br><br>What is left is Quake-specific: it still builds with id's own `*_null.c` porting stubs, and `vid_dos.c`/`vid_vga.c` use **tweaked** VGA modes — CRTC reprogramming, not mode 13h — which is the one piece none of this covers. | M | Smaller than it looked. The device count for a whole DOS game turned out to be **three**. |
| P3.4 | A timedemo end to end; framebuffer diff against real Quake under DOSBox-X. | M | The timedemo runs and the fps are published (525 on demo1); the pixel diff against DOSBox-X is what is left. |

## P4 · Doom

| # | Task | Effort | Why |
|---|---|---|---|
| ~~P4.1~~ | ✅ **DONE** — `src/env/x11.js`, the Xlib boundary (not the protocol), plus the POSIX half in `src/env/stdio.js`. `linuxdoom-1.10` compiles entirely unmodified: 62 units, 45,152 lines, 714 of 715 functions. | M | ⚠️ The DOS/Watcom Doom source was never released; this is the Linux/X11 tree, which is why the host is Xlib and not DOS. |
| ~~P4.2~~ | ✅ **DONE, and better than the entry asked** — not just the title screen: `-warp 1 1` plays **E1M1**, 260 frames at ~1 ms each. The shareware WAD's demos do not play and Doom says why itself (`Demo is from a different game version!`). Sound needs P1.8. | M | The pixel diff against `DOOM.EXE` is not possible: MIRAGE cannot run Doom (DPMI), which is the whole reason PRISM exists. |

## P6 · Raven (Heretic, Hexen)

Not in the original plan. They arrived because Wolfenstein 3D turned out to be 16-bit segmented — a
second ABI — and the question "what else is DOS but flat?" had an answer.

| # | Task | Size | Notes |
|---|---|---|---|
| ~~P6.1~~ | ✅ **DONE — Heretic plays its attract loop.** Title, credits and the demo, 320x200 with the 3D renderer, monsters and the status bar. Both trees compile completely from their own makefiles (761 and 1,215 functions). `tools/raven.mjs`. | M | The whole DOS platform cost three devices; see P3.3. |
| P6.2 | **Hexen is blocked on its own data, not on PRISM.** `P_SETUP.C:803` defaults every map's sky to `R_TextureNumForName("SKY1")` and the retail v1.1 WAD has no such texture — reading the WAD directly gives 148+1 textures, SKY2/3/4 and no SKY1. PRISM builds exactly those and looks them up exactly. Needs a WAD that has SKY1 (the shareware demo, or v1.0). | S | Recorded rather than worked around: patching the game or the data is the one thing this project does not do. |
| P6.3 | **Input.** `deliverKeyboard` exists and calls the game's own `I_KeyboardISR`, which reads port 0x60 — but nothing queues a scan code yet, so the attract loop cannot be interrupted and the game cannot be played. The port seam needs a keyboard device. | S | The mechanism is proved; only the queue is missing. |
| P6.4 | **Pace it, and put it in the browser.** The tic is delivered per N safepoint hits, which is deterministic but not 35 Hz. A real clock and the existing `web/` shell would make it playable. | M | Same host contract as MAME and Doom; the descriptor is the only new thing. |

## P5 · Native assembly

| # | Task | Effort | Why |
|---|---|---|---|
| P5.1 | ✅ **DONE, and it did not need inline assembly at all.** The premise was wrong twice over, and the measurement that dissolved it took one command: **neither MAME's `msdos.c` nor Quake's `sys_dos.c` contains a single asm statement of its own** — sys_dos.c's only `__asm__` is a symbol label, not an instruction. Every port access in both goes through `pc.h`'s `inportb`/`outportb`, and PRISM SUPPLIES `pc.h`; declaring them as functions is a platform port, exactly like supplying `stdio.h`. Delivered instead: `src/env/ports.js`, the I/O seam using MIRAGE's own device contract (`onPortRead`/`onPortWrite`/`mem`) so its devices install unchanged, and `src/env/pit.js`, counter 0 plus the BIOS tick at 0x46C — the clock Quake's DOS build actually polls. Gated by `tools/gate-ports.mjs`, which has no oracle and says so: there is no PC I/O space on the container's Linux host, so it checks the device's contract instead. | — | done |
| P5.2 | GAS `.s` subset → JS, to recover Quake's `id386=1` inner loops. Also Heretic and Hexen's `LINEAR.ASM`, whose `R_DrawColumn`/`R_DrawSpan` are currently sidestepped by compiling `R_DRAW.C` with `__WATCOMC__` undefined to select the C bodies the file already carries. | L | MIRAGE's x86 recompiler is both the fallback and the oracle. |

## Known risks (tracked, not forgotten)

1. **Pointer-heavy C in pure JS.** Mitigated by P2.1. Revisit the backend only on a measured number.
2. **`long long` as i32 pairs.** Accepted; harmless for MAME 0.1 and Quake.
3. **libc/Allegro/Xlib surface creep.** Bounded by one rule: implement only what the linker actually
   demands, ranked by frequency. Never by anticipation.
4. **Doom is not a DOS program.** Stated now, not discovered at P4.
5. **Emitted source volume** (MIRAGE's D6 lesson). tier-0 exists from the start.
6. **A stale bundle outliving a compiler fix** (P2.5). A cached artifact keeps a miscompile alive
   after the compiler stops producing it, and the failure is invisible: the program simply misbehaves
   the way it used to. The version hash in the artifact is not bookkeeping — a mismatch must be
   *detected and refused*, never silently run.
7. **A timing defect no corpus can see.** `gate-run` compares stdout and `mamediff` compares frame
   hashes; both are indifferent to *when* a frame happens, which is how a pacing bug shipped while
   every gate was green. Anything that touches the frame clock needs an explicit fps measurement
   against the rate the program itself declares.
