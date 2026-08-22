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
| P1.3 | 🟡 **Runs with real ROMs; the emulated Z80 misbehaves.** ROMs load (reset vector verified), the game clears video RAM, but `Z80_Running` drops to 0 after one T-state of 51200 and the fill loop overruns into the 0x5000 interrupt latch. A hand-written six-opcode ROM behaves exactly as predicted, so the defect is in code Z80.c reaches and a short loop does not. | M | |
| P1.4 | **Differential the Z80 core against a gcc build.** Compile Z80.c with the oracle's gcc, drive both with the same ROM and the same T-state budget, and diff the register file after each step — the same shape as MIRAGE's Unicorn co-sim. This is the tool the bug needs; guessing at 2500 lines of CPU emulation is not. | M | Unblocks Pac-Man, and every game after it. |

## P2 · Performance

| # | Task | Effort | Why |
|---|---|---|---|
| P2.1 | **IR + escape analysis / mem2reg.** | L | The single largest lever: locals in JS vars instead of the heap. MIRAGE deliberately deferred its IR (its roadmap D5); here it is mandatory. |
| P2.2 | Alignment inference, GVN on address arithmetic, LICM, inlining. | L | |
| P2.3 | **tier-0 → tier-1 promotion** + inline caches on function pointers. | M | |
| P2.4 | Perf ratio published in one comparable unit vs native `gcc -m32` and vs MIRAGE on the binary. | S | Measure, never justify. |

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
