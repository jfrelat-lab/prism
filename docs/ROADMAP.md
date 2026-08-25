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
| P0.7 | **Csmith differential** — seeded, committed capture, run against `gcc -O0`/`-O2`. | M | The `test386.asm` of C: an oracle that does not think, available in unlimited quantity. Reduces a Quake bug to a 30-line program. Budget measured: ~3 s/program, ~3 h for 10 000 at 8-way, captured once. |

## P1 · MAME 0.1

| # | Task | Effort | Why |
|---|---|---|---|
| P1.1 | ✅ **DONE** — corpus fetched, `tools/mame.mjs` builds and runs it. | — | done |
| P1.2 | ✅ **DONE, and no Allegro shim was needed** — MAME's own `osdepend.h` boundary is eighteen functions, so `src/env/osd.js` replaces `src/msdos/msdos.c` wholesale. The libc extras were measured from MAME's sources, not guessed: `stricmp fopen fclose fread fwrite getchar rand`. | — | done |
| P1.3 | ✅ **DONE** — Pac-Man runs and every frame is bit-identical to a native gcc build over 200 frames (`tools/mamediff.mjs`). Two defects found: a runtime builtin shadowed the program's own function definition (twelve-hour hang), and the platform backend allocated in the static area instead of the guest heap. | — | done |
| P1.4 | ✅ **DONE** — `tools/z80diff.mjs`. Found the defect in seconds: compound assignment evaluated the lvalue before the right-hand side, so `R.PC.W.l += (offset)M_RDMEM_OPCODE()` made every relative jump one byte short. The core is now identical to gcc over 20006 steps including the interrupt path. | — | done |
| P1.5 | ✅ **DONE** — `web/` + `tools/serve.mjs`: a program-agnostic browser shell. Guest in a Web Worker over a SharedArrayBuffer; the page observes guest memory, because a C main loop never yields and rewriting it (Emscripten's `emscripten_set_main_loop`) is the modification this project refuses. One surface, text until the program creates a display; scan codes in; `argv` through to `main`. Pac-Man is playable at a measured 60.0 of 60 fps. Four defects, and one lesson: **every gate was green while the game was unplayable** — nothing headless has a frame rate. See [TESTING.md](TESTING.md). | — | done |

| P1.7 | **Delete `src/env/osd.js`: make MAME compile its own `src/msdos/msdos.c`.** Today PRISM supplies a hand-written backend for MAME's eighteen `osdepend.h` functions. That does not modify MAME — substituting the platform file its own makefile selects per platform is what the abstraction is for — but the boundary is **per program**, which is the cost Emscripten imposes, merely moved from the game into PRISM. Emulating the ENVIRONMENT instead means every DJGPP+Allegro program comes along without a line of PRISM written for it.<br><br>The surface is **measured, not estimated** — `msdos.c` is 498 lines and this is everything it needs: **Allegro** 13 functions (`allegro_init install_keyboard set_gfx_mode set_color get_palette create_bitmap destroy_bitmap save_pcx readkey clear_keybuf poll_joystick initialise_joystick bmp_write_line`) plus `screen`, `key[]`, `BITMAP/PALETTE/RGB`, `GFX_*`; **SEAL** (`audio.h`) 17 `A*` functions, all stubbable; **DJGPP** `inportb`/`outportb` from `pc.h` and `_dosmemputl` from `sys/farptr.h`; and `scanf`.<br><br>Three things that make it far smaller than it looks, each verified by reading the file: (1) **no VGA register emulation is needed.** Both display paths are plain memory writes — the VESA one to an address OUR shim hands out through `bmp_write_line`, the mode-13h one to `0xa0000`, which is already a real address since the low megabyte is reserved. Nothing intercepts them, so MIRAGE's memory-dispatch cliff does not arise. (2) **`TwkUser.c` is included but never called** — its 8 `outportb` on the CRTC must compile, not work. (3) MAME 0.1 depends on **two** third-party libraries, not one: sound is SEAL, not Allegro. | M | The only compiler-level blocker is the `inportb`/`outportb` pair, because `pc.h` defines them as GNU inline asm — two intrinsics recognised by pattern (P5.1's approach), with one live call site. Not blocked behind all of P3.1/P5.1 as previously recorded. |

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
| P2.1 | **IR + escape analysis / mem2reg** — now justified by a measurement: 9.5× off native, with every memory access going through a DataView and every local that is address-taken living on the shadow stack. The single largest lever, and the one MIRAGE deliberately deferred (its roadmap D5). | L | Re-measure with `npm run bench` after each step; do not trust a ratio whose reference side has not been checked for stability. | 
| P2.2 | Alignment inference, GVN on address arithmetic, LICM, inlining. | L | |
| P2.3 | **tier-0 → tier-1 promotion** + inline caches on function pointers. | M | |
| P1.6 | **A live-C mode in the shell** — edit a translation unit in the page, recompile, restart. Cheap *because* `source` mode already compiles in the browser: the compiler is already there, `resolve` already serves from an in-memory tree, and a compile is 700 ms for MAME. What it needs is an editor pane, an overlay over the fetched tree so an edit shadows the served file, and error locations mapped back to a line. It is the mode where PRISM's premise is visible to a person rather than argued: change a line of 1997 C and watch it take effect. Note it is exclusive to `source` mode — a `bundle` (P2.5) has no source to edit. | M | Not on the critical path to Quake or Doom. Do it when the compiler stops being the thing that needs attention. |
| P2.5 | **Two load modes, over one serialised IR.** Today the shell always compiles from source in the page. Once P2.1 gives us an IR, add a second mode: `source` (fetch C, compile in-page, promote to tier-1 at run time — the only mode where editing a `.c` file is visible immediately) and `bundle` (fetch a prebuilt artifact and start instantly). **The bundle's payload is the IR, not the emitted JavaScript** — that is the whole design constraint. Shipping only emitted tier-0 would cap a cached program at tier-0 for ever, which buys start-up at the price of the performance ceiling and turns PRISM into a worse Emscripten. With the IR present, tier-1 re-emits at run time exactly as it does in `source` mode. Artifact = {serialised per-function IR, resolved type/layout table, the static memory image, the symbol and function-table map, the platform layer it requires, **and the compiler's own version hash**}. Invariant, same discipline as tier-0 == tier-1: a `gate-bundle` must show a bundle run and a source run producing identical state frame for frame. | L | Start-up cost only becomes real with Quake: MAME is 6.3k lines → 0.45 MB of JS in ~700 ms, so Quake's 44.6k lines extrapolates to seconds and megabytes — an estimate, flagged as one, to be measured rather than assumed. |
| P2.4 | ✅ **DONE** — `tools/bench.mjs`. **PRISM tier-0 is ~9.5× slower than clang -O2 native** on MAME's Z80 core (24–25 M instr/s vs 228–231), stable across a 4× workload change, same checksum both sides. Better than the 30× the plan feared. The containerised gcc is 15× slower than native and is useless as a speed reference. | — | done |

## P3 · Quake

| # | Task | Effort | Why |
|---|---|---|---|
| P3.1 | **DJGPP shim**: `dpmi.h`, `pc.h`, `sys/farptr.h`, `sys/movedata.h`, `go32.h`. | M | `outportb` in `pc.h` **is** inline asm — first customer of the intrinsic table. |
| P3.2 | Build `WinQuake/` with `id386=0` (the C equivalents of all 21 `.s` files; a build switch, not a source edit). | M | |
| P3.3 | VGA 13h + VESA through MIRAGE's `vga.js`, PIT timer, keyboard; sound stubbed. | M | |
| P3.4 | A timedemo end to end; framebuffer diff against real Quake under DOSBox-X; fps published. | M | |

## P4 · Doom

| # | Task | Effort | Why |
|---|---|---|---|
| P4.1 | **POSIX + Xlib shim** for `linuxdoom-1.10`. | M | ⚠️ The DOS/Watcom Doom source was never released; `id-Software/DOOM` is the Linux/X11 tree. `i_video.c` uses ~15 Xlib calls. A "Doom for DJGPP" tree would be a modified derivative — against the project's whole premise. |
| P4.2 | Title screen + demo loop; pixel diff against `mirage/games/DOOM/DOOM.EXE`. | M | |

## P5 · Native assembly

| # | Task | Effort | Why |
|---|---|---|---|
| P5.1 | Inline `asm()` intrinsic table (pattern-matched), then a general path. | M | DJGPP's own headers need it before any game does. |
| P5.2 | GAS `.s` subset → JS, to recover Quake's `id386=1` inner loops. | L | MIRAGE's x86 recompiler is both the fallback and the oracle. |

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
