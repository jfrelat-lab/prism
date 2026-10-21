# PRISM — Architecture

PRISM is a **C→JavaScript compiler written in pure JavaScript, that runs in the page**. It compiles
the *unmodified source* of DOS-era games and emulators and runs them in the browser or headless in Node.

Sibling project: MIRAGE recompiles a program's **x86 binary**; PRISM compiles its
**C source**. The real difference is what each one needs: MIRAGE needs a binary and no source, PRISM
needs published source and no binary. Doom qualifies for PRISM because id released the Linux tree;
a program whose source was never published is MIRAGE's alone, and one that ships only source is
PRISM's.

> New here? Read this file, then [TESTING.md](TESTING.md) (the oracles — read before writing any
> code that makes a claim about C), [ROADMAP.md](ROADMAP.md) (the task menu) and
> [COMPAT.md](COMPAT.md) (what runs today). Keep them updated when the design changes.
>
> `COMPILER.md` and `RUNTIME.md` are deliberately absent until the code they would describe exists.
>
> **Where this file stands.** Everything below is either measured or marked as not built. The
> sections that describe a mechanism describe one that exists; the two places where the original
> plan is still a plan — the IR and its optimiser — say so in those words rather than in the present tense.

## The bet

PRISM moves the compatibility boundary from the *game* to the *library*: it supplies libc, the DJGPP
layer, Allegro, Xlib, svgalib, the Win32 SDK and MGL in JavaScript, and the game compiles as it
shipped. Nothing in the game's tree is edited; build-time switches the tree already has (`id386=0`,
Heretic's `#ifndef __WATCOMC__`) are configuration, not modification.

**Do not overstate this against Emscripten.** "You would have to port the game" is the weak form of
the argument and it is partly false: Emscripten ports SDL and X11, and it has two answers to the
synchronous main loop that are not `emscripten_set_main_loop`. An earlier version of this file rested
its whole case on that call, which was a fair description of 2015 and is not one of today.

> ⚠️ **Everything in this comparison is from knowledge, not from measurement.** There is no
> Emscripten on this machine and this project has never built anything with it. Every other number
> in these docs has an oracle behind it; this section has none, and a claim about a toolchain we have
> not run is exactly the kind of thing that should be labelled rather than asserted. Treat it as a
> statement of what would have to be tested, not as a result.

**Asyncify** instruments the compiled code to unwind and rewind the call stack, saving locals to a
side stack — so the loop keeps its shape and is not turned into a callback. But the *instrumentation*
is what is automatic; the **yield point is not**, and where it lands decides whether the game's source
is touched:

* if the loop already calls something the host implements — a blit, an event read, a clock — that
  import can be declared async and the yield lives in the **shim**, leaving the game's source alone.
  That is the same place PRISM yields;
* if it does not, `emscripten_sleep(0)` goes **into the loop**, and that is a source edit.

It also costs: instrumenting every function on a path that might unwind grows the code and slows it,
which is managed by hand-listing functions (`ASYNCIFY_ONLY`) — i.e. by knowing the call graph.

**And the answer that is closer to ours than Asyncify is:** `-pthread` with `PROXY_TO_PTHREAD` runs
the program on a worker, where its loop may block, leaving the main thread free. No source change at
all, and structurally what PRISM does. Any honest comparison has to start there rather than at
`set_main_loop`.

**The symmetric admission, because it is the same dependency:** PRISM also needs a call to hook. A
loop that never re-enters the runtime is invisible to it — see *Waiting* below, where this is stated
in its own right, and note that MAME needed an explicit `--safepoints` for exactly this reason.

So the honest differences are narrower than "no porting", and they are these:

* **The platform layer itself is compiled, not replaced.** PRISM builds id's own `sys_dos.c` +
  `vid_vga.c`, `vid_x.c`, `vid_svgalib.c`, `vid_sunx.c` and `vid_win.c` + MGL — five platform layers
  of one engine, as shipped, including a SunOS one nobody had ever built. The usual port swaps that
  layer for SDL; here it is the thing under test.
* **And the five are asserted to agree.** `tools/gate-pixels.mjs` renders the same demo frame on DOS,
  X11, Win32 and svgalib and requires the pictures to be **identical** — 64,000 pixels and 768
  palette bytes, modulo one documented palette remap that WinQuake performs on itself. No port
  workflow makes or checks that claim.
* **There is no build step.** The compiler is in the page: the browser fetches 430 `.c` files and
  produces 1,052 functions and 1.85 MB of JavaScript in **666 ms**. No toolchain, no artefact, no
  cache to invalidate.
* **Every layer has an external oracle**, and the invariant is *zero wrong answers*: a construct
  PRISM cannot compile is a named refusal, never a silent miscompile. See [TESTING.md](TESTING.md).

**Emitted output is JavaScript, not WASM** — the same design bet MIRAGE makes: readable emitted
code plus the browser's own JIT, and readability as the primary debugging lever. The IR is kept
backend-agnostic anyway, so the decision can be revisited on a measured number rather than an
intuition.

**PRISM is not a JIT, and "dynamic" is no longer the word for it.** The original plan was: compile a
function at its first call, re-emit it once hot, specialise on observed facts -- the real target of a
function pointer, the real alignment of a pointer, a global written once. That job is already done,
one level down, by the JavaScript engine PRISM emits for: it compiles lazily, re-optimises what is
hot and speculates on what it observes. A PRISM-level tier would do it again with less knowledge of
the machine. What the engine cannot see is C's memory semantics -- aliasing, alignment, a local that
never escapes -- and that is STATIC knowledge, because PRISM always holds the whole program: it
belongs to an optimiser over an IR (ROADMAP P13.2). What exists and is measured today is one
link-time decision of that kind: **direct calls** (P2.1), worth **2–2.5×**. Profile-guided
re-emission stays possible, to be taken only on a measurement the static pass cannot match. The
short description is "a C compiler that runs in the page, with no build step".

## Target ABI

**Two of them, and the model is a value rather than a module-scope constant.**

**i386 System V, flat 32-bit (DJGPP)**: one address space, 32-bit pointers, no segmentation, no far
pointers. `long` is 4 bytes, `char` is signed.

**16-bit real-mode DOS** (`dos16` small, `dos16m` medium, `dos16l` large): `int` and a near pointer
are 2 bytes, alignment stops at 2, there is no `long long` — Borland C89 had none — and
segmentation is real. The size of an enum is the compiler's rule and not the model's, so it is a
target option: Watcom sizes one by its constants, Borland makes it an `int` by default
(`compile.enums`), and each target states which compiler built it. `far`, `_seg` and `huge` are pointer kinds the parser and the
emitter both carry. DGROUP sits at linear 0 so a near pointer IS its linear address; far objects
live above 0x10000; the low megabyte is reserved, so the interrupt vector table at 0 and the EGA at
0xA0000 are the addresses the program expects.

Guest memory is one `ArrayBuffer` either way. The exact layout rules — including the ones that are
not what the manuals suggest — are in [`src/sema/abi.js`](../src/sema/abi.js) and documented in
[TESTING.md](TESTING.md); the i386 rules are pinned against gcc, the 16-bit ones against Open Watcom
in the same container and against Borland C++ 2.0 itself under DOSBox-X.

Language scope: **C89/C99 + the GNU extensions real code uses**. No C++, which puts modern MAME out
of scope and MAME 0.1 (C89) in it.

## Pipeline

```
cpp/       preprocessor — translation phases 1-4, exact
lex/       pp-tokens -> C tokens
parse/     C89 + C99 + GNU -> AST
sema/      types, scopes, layout per ABI model (abi.js), constant folding
ir/        EMPTY — planned: CFG, SSA-lite, explicit load/store against linear memory
opt/       EMPTY — planned: escape analysis, mem2reg, GVN, alignment inference, inlining, LICM
backend/   emit.js (the literal emitter) + flatten.js. No optimiser yet (P13.2).
asm/       the program's OWN assembly, translated from its SOURCE, never emulated:
           borland.js (Borland inline `asm` interleaved with C), tasm.js + tasm16.js + tasm-link.js
           (whole TASM modules), pragma-aux.js (Watcom routine bodies), nasm.js + x86.js, omf.js
           (object files read as data). Anything outside each subset is refused BY NAME.
link/      symbols, static placement of globals, the function-pointer table
runtime/   libc, malloc, setjmp/longjmp, math, printf
env/       djgpp/ (dpmi, pc.h, farptr, movedata) - allegro/ - posix+xlib/
host/      bridge to MIRAGE's devices (vga, bios, dos, vfs, keyboard)
```

## The six hard parts, and the position taken on each

**1. Memory model — the whole of the performance story.** One `ArrayBuffer` (a
`SharedArrayBuffer` in the page, so it can watch the program's memory), pointers are 32-bit byte
offsets into it, and every load and store goes through one little-endian `DataView`
(`D.getInt32(p, 1)`), with a `Uint8Array` beside it for bulk copies. But **not everything lives in the heap**: a scalar local whose address
is never taken lives in a JS `var` and never touches memory. That single distinction is the
difference between ~3× and ~30× off native. A shadow stack serves only what genuinely needs one:
`alloca`, address-taken locals, varargs, `setjmp`, structs passed by value.

**2. ABI layout — non-negotiable.** Game code `memcpy`s WAD/ROM bytes straight into structs and
reads fields by offset. One wrong pad byte does not produce a clean error; it produces corrupted
sprites. Gated from day one — see [TESTING.md](TESTING.md).

**3. Function pointers.** A table mapping stable integer addresses to JS functions, so comparison,
casting to `int` and storage in a struct all work. Doom's `void (*think)()` and MAME's opcode tables
depend on it. A function's address is a tagged index into that table (`0x7000_0000 | index`), so it
can never be mistaken for a data pointer. A lever for later: an inline cache at a hot indirect call
site — precisely what MIRAGE cannot do from x86.

**4. Type punning, unaligned access, `volatile`.** Because every access is a `DataView` call at a
byte offset, `*(int*)p` is one `D.getInt32(p, 1)` whatever `p`'s alignment, and reading a `float`'s
bits through a union is the same bytes read with another getter: no special case either way. Not yet
done: proving a pointer aligned (from the IR's optimiser, P13.2, which does not exist yet) so that
the access could become a typed-array index, `HEAP32[p >> 2]`. A platform that maps devices into
memory -- DOS's `0xA0000` window as a planar VGA's four planes, a VESA bank -- compiles with
**paged** memory (src/env/memmap.js): every access then goes through a one-line address translation,
`D.setUint8(xw(a), v)`, and a target that does not ask pays nothing.

**5. Bit-exact `float`.** `Math.fround` on every `float` store and operation — Quake's float bit
tricks depend on it. `double` is native. **`long long` is a `BigInt`, not a pair of i32s** — the plan
called for pairs and tier-0 chose correctness instead: BigInt is right by construction, arbitrary
precision plus an explicit truncation, and lowering it to i32 pairs is P0.5c, deliberately not
started because the cost has never been quantified.

**6. `setjmp`/`longjmp`.** `longjmp` throws a token; `setjmp` turns its caller into a restart loop
with saved state. Applied only to functions that actually call `setjmp` (Quake's `host_error`,
Doom's `I_Error`), never globally.

## One literal emitter, and where optimisation will live

MIRAGE **measured** that compile cost tracks emitted *source volume*, not function count (Turbo
Pascal: 151 blocks were 96.6% of 10 MB of emitted JS; 54% of one block was the inlined memory path).
A C compiler over Quake's 128 `.c` files hits that wall immediately, so the emitter is compact and
LITERAL: memory access through short helper calls, every integer operation in its canonical form,
`long long` a BigInt rather than something clever. It is called tier-0 in the code for history.

Optimisation, when it comes, is a STATIC pass over an IR of the whole program (ROADMAP P13.2) --
unboxed locals, memory access specialised where aliasing and alignment are proven, calls made direct
-- not a runtime re-emission of hot code, for the reason given under *The bet*. The invariant is
MIRAGE's `fuzz-region` one, carried over: optimised and literal output must produce identical state,
every pass gets a `PRISM_NO*` kill-switch, and every gate must pass with each switch on and off.

⚠️ **Status: the literal emitter only**; the IR and the optimiser do not exist. The measured
consequence is in *Numbers* below.

## Determinism

No `Math.random`, no `Date` in the compiler or the runtime's decision-making. The same input must
yield byte-identical emitted code and byte-identical program state — that is what makes fingerprint
gates possible at all. Keep it that way.

## Running in a browser: observing a guest that never yields

A C program's main loop is synchronous. MAME 0.1 spins inside `run_machine` until a key says stop;
Quake spins in `Host_Frame`. There is no moment at which a browser could paint.

Two answers exist and it is worth being precise about both. Emscripten's original one is
`emscripten_set_main_loop` — rewrite the loop, which is the source modification this project exists
to avoid — and its second one, **Asyncify**, does not require rewriting anything: it instruments the
code to unwind and rewind the stack at a yield point. So the problem is solved there too, at the cost
of that instrumentation on every path that might unwind.

PRISM's answer inverts the direction. The guest runs in a **Web Worker** over a
**SharedArrayBuffer**, and the page **observes the guest's memory** while it runs:

```
  page (main thread)                    worker (the guest)
  ─────────────────────                 ──────────────────────────
  rAF: read pixels ──────┐              compileProgram({shared:true})
  keydown: write keys ───┤              installOSD({publish, keys, onPresent})
  timer: bump ACK ───────┤              prog.run()   ← blocks until main() returns
                         │
                    control block (2 KB SAB)
              geometry · palette · frame · keys · ACK/STOP/PAUSE/SPEED
```

- **Display** is a read of guest memory at whatever instant the page paints. Nothing is copied and
  nothing is double-buffered — a double buffer would need the guest to yield, which is the one thing
  it cannot do. A torn frame is possible and accepted: it shows as a tear, never as corruption.
- **Pacing happens inside the guest's own present call** (`osd_update_display`), against the guest's
  **own clock**. Blocking there is indistinguishable, to the program, from running on a slower
  machine, and it is the only place a program tells you it has finished a frame.

  The first design got this wrong in a way worth recording: the guest was allowed to run N frames
  ahead of an acknowledgement the page published once per paint. The game was unplayable, because its
  speed became whatever rate the browser felt like waking a timer at — about 125 fps in a foreground
  tab, 8 fps in a background one, and a hard deadlock at frame 2 when `requestAnimationFrame` stopped
  firing altogether. **A display's refresh rate is not a clock.** The program declares its frame rate
  (MAME's drivers carry `frames_per_second`); the guest sleeps until its next frame is due; the page
  is not involved. Measured after the change: a steady 60.0 of 60 fps, in a hidden tab.

  A guest that falls behind **resyncs instead of catching up**. Repaying a frame debt at full tilt is
  the fast-forward glitch every emulator with a naive frame timer has.
- **Keyboard** is one shared byte per PC set-1 scan code, plus a **latch** so a brief tap survives
  long enough to be sampled. See [TESTING.md](TESTING.md) for what that number was measured against.

### The PC's low megabyte is real

The guest image reserves its first megabyte for the machine, not the program: the BIOS data area at
0x400, the VGA graphics window at 0xA0000, the 80x25 text buffer at 0xB8000. Statics start at 1 MB.

This is how DJGPP itself works — a program reaches video memory at linear 0xA0000/0xB8000 through
`_dos_ds` and `sys/farptr.h` — so those have to *be* those addresses for such code to compile
unmodified. It costs one megabyte of a 256 MB address space.

What it buys is that the host renders by reading guest memory and cannot tell how the bytes got
there. `printf` goes through `src/env/console.js`, which writes characters and attributes into
0xB8000 and keeps the cursor at 0x450/0x451 — the real format, the real place. A program that pokes
video RAM itself lands in the same cells and needs nothing added. Had the console shipped text to the
host as strings instead, those two cases would have been different code paths and only the first
would ever have worked.

Precise about the limit: this is the memory layout and the semantics of writing to it, not an
emulated VGA. There is no CRTC, no attribute controller, no mode setting yet. It is the part programs
actually depend on, and the foundation the rest can be added onto.

### One surface, two modes

A DOS program prints a banner and then goes graphical, on one screen. The shell shows it that way: an
80x25 text mode until the program creates a display, its framebuffer while it has one, and back to
text if it closes it. Text is drawn with the **IBM VGA 8x16 ROM font** (`assets/`, from MIRAGE, where
it was extracted graphically from DOSBox) — one pixel at a time into an ImageData, the same way
MIRAGE's `video.js` does it. Canvas `fillText` was tried first and is not good enough: a proportional
fallback drifts, ASCII drawings stop lining up, and CP437's box-drawing characters — which every DOS
program's UI is made of — do not exist in a web font.

The shell's own reporting — compile timings, stubbed headers, functions it could not emit — stays in a
side pane, because a DOS screen never showed "894 functions in 700 ms".

### Two kinds of keyboard, because programs ask two questions

Which keys are **held** (one byte per scan code, polled every frame by a game) and which characters
were **typed** (an ordered queue, read once each by `getchar`). MIRAGE draws the same line — a
scancode path for INT 9h, a `(scan, ascii)` queue for INT 16h — and for the same reason: answering the
second question with the first reports Enter as pressed for as long as the finger is down.

Until the queue existed, `getchar` returned EOF, so MAME printed "Press <ENTER> to continue." and
carried straight on. The program asked a question and ignored the answer — which on screen looked
like the prompt appearing for no reason. It now blocks in the worker on `Atomics.wait` until a
character arrives, with a timeout so Stop can still reach it.

### The visitor's language, calendar and keyboard

A program in the page meets the visitor's locale in three places. Each is decided once, in one place,
and the Node gates never see it: they stay on a fixed date, UTC and US key positions, so a run is
reproducible.

| What | Default (gates, Node) | In the page | Where |
|---|---|---|---|
| **Language** of a program that can be told one | its own default | the first of the browser's languages the program knows, passed as its switch, unless the arguments name one | a descriptor's `language` (`flag`, `codes`); `web/app.js` `withLanguage` |
| **Date and time zone** | `time()` is 1997-01-01 plus the program's seconds; local time is UTC | the real date and the browser's zone, summer time included: `localtime`, `mktime`, DOS `INT 21h AH=2Ch`, Win32 `GetLocalTime` | `M.wallClock`, `M.utcOffset`, `M.isDst` (`src/runtime/runtime.js`), set by `web/worker.js` |
| **Keyboard** | a key is its position on a US keyboard | the same, unless the visitor picks *keys: your layout* | `src/env/scancodes.js` `keyNames` |

**Language.** Beneath a Steel Sky's CD holds its text in seven languages, and ScummVM 0.6.1 picks one
with `-q`. `web/programs/scummvm.json` maps the browser's languages to those codes, so a French browser
gets `-q fr`. A language the data lacks falls back to English with a warning; a browser language the
program does not know adds nothing. Other demos are one language each: the language of their text is
the language of the archive.

**Text versus position.** Typed text always follows the visitor's layout, as `KEYB` made DOS do: the
BIOS queue `getchar` and `INT 16h` read, and SDL's `unicode`. What a program names a KEY by -- an X
keysym, an SDL symbol -- is the key's position by default, because game controls are laid out by
position: on AZERTY the Z key is still "w" and the number row still "1". With *your layout*
(`?keys=typed`) it is what the layout typed instead, as a real X server or SDL set to that language
answers: letters right in a Quake console, and the number row "&", "é" as French players knew it. A
release keeps its press's name, so press and release still pair. Games that read scan codes
themselves (an INT 9 handler, Allegro's `key[]`) get positions in both modes, as they did under `KEYB`.

Win32's `TranslateMessage` posts no `WM_CHAR` yet, so a Win32 program reads keys and no text. The C
library keeps the "C" locale on purpose: a French one would make `strtod("1.5")` stop at the comma.

### Genericity that is structural, not asserted

The page knows nothing about any program: it compiles C, paints an 8-bit indexed framebuffer at
whatever size the guest asked for, through whatever palette the guest built, forwards scan codes, and
passes the argument string to `main` as `argv`. Programs are **data** — `web/programs/*.json`,
discovered at start-up, never listed in the page's code — plus a platform layer under `src/env/` if
one is needed.

That claim has since been stress-tested rather than asserted: the shelf now carries MAME 0.4, Quake
on four platform layers, Quake II, Doom, Heretic, Hexen, OpenDUNE, Lua and PuTTY, and the page's code
names none of them. A plain-C89 Mandelbrot with no platform layer and no data files is still there
for the same reason it always was — so that "the shell is generic" is a claim something can falsify.

`src/` contains no Node imports, so the browser loads the same modules the gates do — there is no
build step to drift.

## Waiting: the guest blocks, and that is correct

A DOS program of this era waits by polling. MAME 0.1 alone contains

```c
do { curr = uclock(); } while ((curr - prev) < UCLOCKS_PER_SEC/drv->frames_per_second);
while (osd_key_pressed(OSD_KEY_P));            /* wait for key release — three of these */
do { key = osd_read_key(); } while (...);      /* and Allegro's readkey() blocks */
```

**Blocking the worker is not the problem.** The guest is synchronous C; when it waits it has to be
stopped, and it is not the UI thread. The three real problems are spinning (a core at 100% to wait),
being un-interruptible (Stop must reach a waiting guest), and a frozen screen with no explanation.
The last one is answered by the architecture already: the page reads guest memory, so a blocked guest
still shows its last frame — and MAME calls `osd_update_display()` inside `displaytext()` before it
waits, so "PAUSED" is on screen before it stops.

Everything that waits goes through one primitive, `makeParker` in `src/env/webhost.js`: park on an
atomic, wake on a host notify or a timeout, check STOP every time. The timeout is not a convenience —
a guest parked after the page has gone would otherwise wait for ever.

Two shapes of wait, handled differently:

- **Blocking services** — called once, expected to wait: `getchar`, `osd_read_key`. They park until
  the keystroke queue is non-empty. Note that a stub answering *instantly* is not a neutral stub when
  the caller's loop assumes it waits: `osd_read_key` returning 0 made MAME's pause menu spin for ever.
- **Polled services** — called in a loop: `uclock`, `clock`, `osd_key_pressed`. These cannot block on
  the first call, so `installSpinDamping` counts consecutive calls to one service **with no frame
  presented in between**. In normal play `osd_key_pressed` is asked a dozen times a frame and the
  frame counter moves; inside a release-wait it is asked thousands of times and nothing moves. That
  distinction needs no knowledge of the loop.

### Safepoints: making a loop observable when it calls nothing

Spin damping counts calls, so it only works on a loop that makes them. `while (osd_key_pressed(k));`
makes none: `osd_key_pressed` is the game's own C reading Allegro's `key[]` array straight out of
memory. Nothing crosses a boundary, no profiler can see it, and — the part that matters — **no host
code runs at all while it spins**, so the byte it waits for can never change. The loop is not slow,
it is unreachable.

A safepoint is two operations emitted on a loop's **back edge**
([`emit.js`](../src/backend/emit.js), `#safepoint`):

```js
if(--M.spBudget<0)M.sp_(id);
```

* **A budget, not a call.** The common case is a decrement and a compare that never leaves the loop.
  The default handler only refills — `sp_(_id) { M.spBudget = 1<<30; }` — so a build that instruments
  and installs no handler pays the two operations and nothing else.
* **Every safepoint is named.** `mod.safepoints[id]` is `functionName#n`, so the id that fired says
  which loop fired it.
* **Off by default, and chosen per program.** It is a compile option (`--safepoints` in the tools,
  `"safepoints": true` in a `web/programs/*.json` descriptor, next to a `safepointsNote` saying why
  that program needs it). Six programs ask for it today: MAME 0.1, 0.2 and 0.4, Heretic, Hexen and
  OpenDUNE. Doom and both Quakes do not, and their descriptors say so by omission.

**What the handler is for — three uses, each one measured before it was written:**

| use | where | what it does |
|---|---|---|
| deliver an asynchronous event | Heretic, Hexen, OpenDUNE | these games take their time from a **timer interrupt** and then wait for it in a loop of their own. `tools/raven.mjs --safepoints` drives the interrupt from the safepoint, because that is the only place an asynchronous event can reach a program sitting inside its own C |
| refresh state the program reads directly | MAME | `key[]` is written here, which is **what a real Allegro does** — from a keyboard interrupt. The faithful answer, not a workaround |
| name the loop that is spinning | `tools/find-loop.mjs` | samples the id and reports the loop. It is what found the MGL stretched-blit freeze, which looked like a hang while the renderer was running |

**The budget is not a sampling rate.** In the page it is 200,000 iterations, and the worker says why
in those terms: it is *how many loop iterations a program may run before the outside world is allowed
to change under it*. A millisecond of iterations is far below any latency a person can feel.
`raven.mjs` uses 20,000 (`--budget`) because it is also counting.

**What it costs, and what is not built.** A decrement and a compare on **every iteration of every
loop** — precisely the cost MIRAGE measured on emitted-code speed, which is why this is opt-in rather
than always on. And the general form is still only a form: the same mechanism with a different
handler would let Stop interrupt a `while (1);`, and that handler is not written. Today the recourse
for a program with no safepoints is terminating the worker.

> **Against Asyncify, since the comparison is made above.** Asyncify's yield point needs a **call** —
> an import declared async — so it cannot yield on a loop back edge either. A safepoint *manufactures*
> the hook where the program offers none, which is strictly more general. The two honest caveats are
> that it is off by default, and that it is not free.

**The alternatives are a roadmap section of their own** — [P2b](ROADMAP.md), five rows under one
constraint worth restating here: **nothing in JavaScript can preempt.** No signals, no guard page to
unprotect, no way to interrupt a running function; a worker can be killed, not interrupted. So every
answer is cooperative and the only question is where the cooperation is paid. The two most promising
are instrumenting **only the loops that contain no call** — a loop that makes one is already visible
to spin damping, so most of today's per-iteration cost buys nothing — and writing the guest's memory
**from the page**, which is what an interrupt actually does and needs no yield at all, for the cases
where the ISR reduces to writing bytes.

### The clock is real, and the program paces itself

`installRealClock` replaces the deterministic counter in the browser only. The program's own throttle
then runs at the rate the program chose (`drv->frames_per_second`), rather than at a rate declared for
it in a JSON descriptor — and the speed control works by **scaling time**, the way DOSBox does with
cycles, instead of fighting the program's loop from outside.

Proof that it is the program's clock and not the host's: with the host's fallback cap set to 1000 fps,
MAME still ran at ~58. The descriptor's `fps` is now only a bound for a program that does not throttle
itself at all.

This is where reproducibility is traded for faithfulness, so it is the browser only. Every gate keeps
the deterministic clock, and the frame-for-frame differential against a native build stays meaningful
because the clock decides *when*, never *what*.

### Numbers, and what is left

⚠️ **Speed: three numbers, and they measure three different things.** Confusing them is how the
"~26 fps" that sat in COMPAT.md from 24 August until 9 September survived so long — see below.

| | |
|---|---|
| **Quake, in the browser, paced** | **72.0 fps** at 320x200 — and that is Quake's own ceiling (`Host_FilterTime`, 1/72 s), not PRISM's |
| **Quake, in the browser, cap removed** | **1,725 fps** at 320x200 (speed selector set to *unlimited*, after ~19,000 frames of warm-up) |
| **Quake, headless in Node** | **883 rendered frames/s** over 16,000 frames — 204 at 300 frames, 472 at 1,000, 721 at 4,000 |
| **against a native build** | **~9.5x slower than clang -O2** on MAME's Z80 core, ~10x on a synthetic mix (`tools/bench.mjs`) |

Three things that table says out loud:

* **The engine is not the bottleneck in the browser.** At 1,725 fps unthrottled, Quake at 320x200 has
  24x the headroom it needs for its own 72 fps. Whatever "~26 fps" measured in August, it does not
  describe this code.
* **JIT warm-up dominates short runs**, exactly as `bench.mjs` said: 204 → 472 → 721 → 883 rendered
  frames/s as the same run lengthens from 300 to 16,000 frames. Any perf number taken over a few
  hundred frames is measuring V8 warming up, and this project has published one before.
* **The headless and browser figures are NOT comparable and are not presented as one.** Headless
  leaves the runtime's deterministic clock in place — `gettimeofday` advances a fixed 1/35 s per
  call — so the guest's time races the wall and Quake renders every iteration; the browser installs
  the real clock and passes `+host_framerate`. Different work per frame, and the ~2x gap between them
  is **not explained here**, because nothing has measured it.

Measured with `node tools/mame.mjs --probe-polls` and the shell's own diagnostics:

| | |
|---|---|
| longest legitimate run of `osd_key_pressed` in one frame | 21 (400 frames of Pac-Man) |
| thresholds | 256 for the keyboard, 64 for the clock |
| learned wait per frame | 14.6 ms |
| per frame, while running | ~11 parks, ~265 spins |
| resulting rate | 58.8 of 60 fps, stable |

The residual 2% is overshoot at the moment the wait ends. `Atomics.wait` does not honour a
sub-millisecond timeout — asking for 0.25 ms still costs about one — so parking right up to the
deadline overshoots it, and the mechanism instead **learns how long the wait lasted last time** and
spins only the final millisecond. Chasing the last 2% is not worth more machinery than that.

What spin damping deliberately does not catch: a loop that never calls the runtime at all. Nothing
above can see it, because nothing above is called. **That case has its own mechanism — *Safepoints*,
earlier in this section — and it is built and in use**; this paragraph used to say it was waiting for something to
need it, which stopped being true once Heretic did.

Known limitation, stated rather than discovered later: a timing-**calibration** loop — one that counts
iterations per tick to measure the machine — gets cut short by damping and reads the machine as slower
than it is. Nothing in MAME calibrates. If something later does, the fix is a per-program exemption,
not a cleverer heuristic.

## Platform layers, and why they look nothing alike

`src/env/osd.js` implements eighteen functions. `src/env/quake.js` implements none — it looks three
symbols up in the linked image and publishes their addresses.

That is not inconsistency, it is the two programs' boundaries being different in kind. MAME's
`osdepend.h` is a set of CALLBACKS: the host is asked to create a bitmap, obtain a pen, present a
frame. Quake's `vid_null.c` is a BUFFER: it declares `byte vid_buffer[320*200]`, points `vid.buffer`
at it, and the software renderer fills it whether or not anything displays it — and Quake loads its
own palette and counts its own frames besides.

So for Quake the host has nothing to implement. `vid_buffer`, `host_basepal` and `host_framecount`
are ordinary globals with stable addresses, and the page reads pixels, palette and frame number
directly out of guest memory. The control block gained three fields to say where they are
(`PAL_ADDR`, `PAL_INDIRECT` for a palette behind a pointer, `FRAME_ADDR`), which any program that
keeps its own can use.

The general lesson for the next port: look for what the program already writes down before writing a
shim to intercept it.

### Seven of them now, and the shape of the boundary is the whole design

| layer | shim | what the boundary actually is |
|---|---|---|
| MAME 0.1–0.4 | `src/env/osd.js`, Allegro, SEAL | **callbacks**: create a bitmap, obtain a pen, present a frame |
| Quake / DOS | `src/env/go32.js`, `ports.js`, `pit.js`, `kbd8042.js` | **hardware**: the DAC, 0x3DA retrace, the 8042 |
| Quake, Doom, Quake II / X11 | `src/env/x11.js` | **Xlib**, 41 functions, no protocol and no server |
| Quake / SunOS | the same, plus ICCCM and the Sun keyboard's F13–F35 | a workstation client sets properties a Linux one never touches |
| Quake / svgalib | `src/env/svgalib.js` | **the console framebuffer**: 19 calls, raw scan codes, relative mouse |
| WinQuake, PuTTY / Win32 | `src/env/win32.c`, `mgl.c`, `headers-win32.js` | **a message queue and a window**, written in C because the contracts are public structs |
| Keen Dreams, Catacomb 3-D / DOS 16-bit | `src/env/borland.js`, `dos.js`, `pcirq.js`, `ega.js` | **the bare machine**: `int n`, the vector table as memory, the PIT and the 8259, the EGA's planes and latches |

The seventh is the thinnest boundary of the seven, and that is the point of it. A 1991 DOS game has
no library underneath it: it installs its own timer interrupt with `setvect`, reads the keyboard from
its own `int 9` handler, and writes the EGA's registers directly. So the shim is not a library, it is
a **machine** — `M.interrupt(n, regs)` answered by the handler the program itself installed, else by
a DOS or BIOS service, else a throw naming the vector and AH, because no BIOS is invented; a virtual
clock advancing one microsecond per backward branch, driving PIT channel 0 and an 8259 with real
IRQ priority; and the EGA behind 0xA0000 with its write modes, read modes and latches. Nothing here
polls in real time: the guest's own clock is what schedules an interrupt, which is why a headless run
is reproducible.

Two structural facts came out of having six rather than two:

* **A shim is sometimes better written in C.** `win32.c` and `mgl.c` are compiled by PRISM like any
  other translation unit, because their contracts are `struct`s the program reads and writes; a
  JavaScript shim would have had to reimplement the layout that `headers-win32.js` already declares.
* **A program of this era can be several shared objects** (P7.3). Quake II defines `Com_Printf` three
  times, once per module, and they do not see each other's globals. A target declares modules; each
  keeps its own external namespace, sees the main module's for what it does not define — ELF's rule
  for a `.so` against the executable — and exposes only what its own `.def` file EXPORTS.
  `src/env/dl.js` answers `dlopen`/`dlsym` out of PRISM's own symbol table, because nothing needs
  loading: it is all already linked.

### The four machines

The browser shell is not a program picker. `web/machines.json` names four **machines** — DOS, Linux,
SUN, Windows — because `quake:dos|x11|sun|win` are four platform layers over one engine, and nobody
sitting at the machine could tell you which build they were in. Each machine is a real terminal on
the same canvas the game uses (DOS `C:\>` with `DIR`, a `$` shell with `ls -l`, a Windows desktop
with the programs' own `.ico` files, double-click to launch); a program takes the screen, and when it
ends the shell takes it back.

## The 16-bit axis, and what fidelity means when a program can see its own addresses

Keen Dreams plays. It is compiled from id Software's unmodified 1991 C, linked against its own three
TASM modules and its own resource objects, and it reaches the world map: text screen, title, high
scores, control panel, "Loading The Land of Tuberia". Catacomb 3-D builds the same way. Both are
Borland C++ 2.0, `MODEL MEDIUM`, and neither source file was touched.

This section exists because the 16-bit work forced a sharper answer to a question the 32-bit targets
never asked: **what is it that has to be faithful?**

For a flat DJGPP program the answer is "the values". Doom does not care where its functions live;
nothing in it can observe a code address as a number. Keen Dreams can, and does:

* `id_vw_a.asm` keeps **jump tables of code labels** and dispatches through them
  (`jmp [ss:memtoscreentable+di]`).
* It stores a routine's address in a variable — `mov [routinetouse],OFFSET generalmask` — and calls
  through it later.
* It keeps **data inside the code segment**, between instructions.
* It pushes real return addresses onto a real stack, and C and assembly hand control to each other
  across it.

So an address is not an implementation detail here, it is a **value the program computes with**. If
a code label were at anything but the offset Turbo Assembler gave it, every one of those would hold
a number the real program never held, and the program would still appear to run — for a while.

**Hence the shape of `src/asm/tasm16.js`: layout FIRST, translation second.** Every instruction is
given the offset and the length TASM 2.5 gives it — not merely a valid encoding, but the same
choices:

* a forward `jmp` is three bytes, because TASM sizes it in one pass and reserves the near form;
* under `.386C` a forward conditional jump is four, `74 15 90 90`;
* `mov ax,[x]` uses the accumulator's short form;
* a code-segment variable read under `ASSUME DS:DGROUP` costs a `CS:` prefix TASM adds on its own;
* a FARDATA variable's offset is final in its own segment, so TASM writes it with no relocation and
  a small one becomes a one-byte displacement.

**And the oracle is Turbo Assembler itself.** `tools/gate-tasm-front.mjs` runs the real TASM 2.5,
from the Borland C++ 2.0 floppies, under DOSBox-X, and compares its object files and `/la` listings
byte for byte: the public names, the data segment, every position that holds a relocation, the
instruction stream disassembled by ndisasm, and the offset, length and segment register of every
single instruction. `tools/gate-tasm-run.mjs` then **executes TASM's own object code under Unicorn**
and requires the translation to agree on registers, flags, 1,088 KB of memory page by page, and the
sequence of port writes.

That is the claim worth making about this project, and it is narrower and stronger than "it runs":
**the program's own assembly sees the addresses the real binary saw**, and an external reference
says so rather than the project saying so about itself.

### What it costs, and where it stops

The same property is what makes one class of program unreachable, and the boundary is worth stating
plainly because it is not a gap to be closed later — it is structural.

**PRISM reads a source file once and emits JavaScript. It has no way to express code that does not
exist at translation time.** Catacomb 3-D's `C3_SCALE.C` writes x86 instructions into memory at run
time — one compiled scaler per wall height, one compiled drawing routine per shape — and enters them
with a `call far`; `BuildCompShape` even patches a `retf` into a routine and takes it back out
afterwards. No amount of work on the translator reaches that, because the bytes are a product of the
program's execution.

This is exactly the line the sibling project owns: **MIRAGE recompiles x86 as it is executed, and
self-modifying code is its native case.** The division holds — MIRAGE owns the low level, PRISM the
high level — and the meeting point stays the **device** boundary, not the CPU. What Catacomb's
scalers need is a seam with the shape `(memory, registers, io) => registers`, which is deliberately
the shape `translateTasm` already produces and the shape Unicorn already has; whoever fills it is a
dependency decision, not a compiler one.

## Control-flow flattening (`src/backend/flatten.js`)

tier-0 emits `goto` as a state machine over a function's TOP-LEVEL statements, which cannot see a
label nested inside a loop — and 1990s C puts them there. Quake's edge sorter is the canonical shape:
labels inside a `do` body with gotos jumping around them.

Rather than teach the state machine about nesting, a pre-pass makes the nesting go away, lowering
`if`/`while`/`do`/`for`/`switch` into the `if`+`goto` forms they are defined as until the body is one
flat list. It runs ONLY on functions that need it, so everything else keeps its structured emission —
a `while` loop stays a `while` loop in the output, which matters for both speed and readability.

Two deliberate refusals rather than guesses: a name declared twice in sibling blocks (hoisting both to
function scope would silently share one slot), and `break`/`continue` with no enclosing construct.

It moved gcc's torture corpus from 1218 to 1243 and c-testsuite from 193 to 196, and it is what let
Quake's renderer run.

## Being a UNIX host: Doom

Doom's only published source is `linuxdoom-1.10`, so compiling it unmodified means being an X client,
not a DOS program. That is why the POSIX host exists and why `src/env/x11.js` shims **Xlib at the
library boundary** — `XOpenDisplay` returns a token, nothing speaks to a server, and Doom's own
`i_video.c` is the video driver, compiled exactly as id wrote it.

The program cannot tell, and that is what makes it honest rather than a trick: it asks Xlib for an
image buffer, draws into it, and hands it back with `XPutImage`. Where the bytes go afterwards is the
host's business. Same principle as Quake's `vid_buffer` — publish what the program already writes.

Three details are worth keeping, because each cost a diagnosis:

* **A client waits for events the server sends.** Doom maps its window and then blocks in
  `while (!oktodraw) XNextEvent(...)` until an Expose arrives. With nothing delivered it spun — 1.98
  million calls before a runtime-call profiler named it. Mapping the window now enqueues the Expose a
  server would have sent.
* **An unset struct field is a silent feature switch.** `XMatchVisualInfo` filled in visual, screen
  and depth but not `class`, and Doom uploads its palette only under
  `if (X_visualinfo.class == PseudoColor && ...)`. The result was a perfectly correct game rendering
  at 213 fps into a canvas with no colours.
* **A refusal must be one the program knows how to handle.** MIT-SHM is refused
  (`XShmQueryExtension` answers no), which selects the ordinary XImage path; but `XShmDetach` reports
  *success*, because there is nothing attached and failing sent Doom into
  `I_Error -> I_ShutdownGraphics -> I_Error` until the stack ran out.
