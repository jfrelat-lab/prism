# PRISM — Architecture

PRISM is a **dynamic C→JavaScript compiler written in pure JavaScript**. It compiles the
*unmodified source* of DOS-era games and emulators and runs them in the browser or headless in Node.

Sibling project: [MIRAGE](../../mirage) recompiles a program's **x86 binary**; PRISM compiles its
**C source**. MIRAGE is real-mode only and says so — Doom, OMF, Jazz and Zone 66 (DOS/4GW, DPMI) are
out of scope there. PRISM reaches exactly that class of program by never emulating a CPU at all.

> New here? Read this file, then [TESTING.md](TESTING.md) (the oracles — read before writing any
> code that makes a claim about C), [ROADMAP.md](ROADMAP.md) (the task menu) and
> [COMPAT.md](COMPAT.md) (what runs today). Keep them updated when the design changes.
>
> `COMPILER.md` and `RUNTIME.md` are deliberately absent until the code they would describe exists.

## The bet

Emscripten requires **porting** the game: replace the main loop, the video access, the DOS calls.
PRISM moves the compatibility boundary from the *game* to the *library* — it supplies libc, the
DJGPP layer, Allegro and Xlib in JavaScript, and the game compiles as it shipped. Nothing in the
game's tree is edited; build-time switches the tree already has (`id386=0`) are configuration, not
modification.

**Emitted output is JavaScript, not WASM** — the same design bet MIRAGE makes: readable emitted
code plus the browser's own JIT, and readability as the primary debugging lever. The IR is kept
backend-agnostic anyway, so the decision can be revisited on a measured number rather than an
intuition.

**"Dynamic" is load-bearing**, not cosmetic. It is what an AOT compiler cannot do: compile a
function at its first call with compact emission, re-emit it aggressively once hot, and **specialize
on observed facts** — the real target of a function pointer, the real alignment of a pointer, a
global written once at startup.

## Target ABI

**i386 System V, flat 32-bit (DJGPP)**: one address space, 32-bit pointers, no segmentation, no far
pointers. Guest memory is one `ArrayBuffer`. `long` is 4 bytes, `char` is signed. The exact layout
rules — including the ones that are not what the manuals suggest — are in
[`src/sema/abi.js`](../src/sema/abi.js) and documented in [TESTING.md](TESTING.md).

Language scope: **C89/C99 + the GNU extensions real code uses**. No C++, which puts modern MAME out
of scope and MAME 0.1 (C89) in it.

## Pipeline

```
cpp/       preprocessor — translation phases 1-4, exact
lex/       pp-tokens -> C tokens
parse/     C89 + C99 + GNU -> AST
sema/      types, scopes, i386 layout (abi.js), constant folding
ir/        CFG, SSA-lite, explicit load/store against linear memory
opt/       escape analysis, mem2reg, GVN, alignment inference, inlining, LICM
backend/   two-tier JS emitter (string emission + new Function, MIRAGE's style)
link/      symbols, static placement of globals, the function-pointer table
runtime/   libc, malloc, setjmp/longjmp, math, printf
env/       djgpp/ (dpmi, pc.h, farptr, movedata) - allegro/ - posix+xlib/
host/      bridge to MIRAGE's devices (vga, bios, dos, vfs, keyboard)
```

## The six hard parts, and the position taken on each

**1. Memory model — the whole of the performance story.** One `ArrayBuffer`, typed-array views,
pointers are 32-bit offsets. But **not everything lives in the heap**: a scalar local whose address
is never taken lives in a JS `var` and never touches memory. That single distinction is the
difference between ~3× and ~30× off native. A shadow stack serves only what genuinely needs one:
`alloca`, address-taken locals, varargs, `setjmp`, structs passed by value.

**2. ABI layout — non-negotiable.** Game code `memcpy`s WAD/ROM bytes straight into structs and
reads fields by offset. One wrong pad byte does not produce a clean error; it produces corrupted
sprites. Gated from day one — see [TESTING.md](TESTING.md).

**3. Function pointers.** A table mapping stable integer addresses to JS functions, so comparison,
casting to `int` and storage in a struct all work. Doom's `void (*think)()` and MAME's opcode tables
depend on it. The JIT lever is an inline cache at a hot indirect call site — precisely what MIRAGE
cannot do from x86.

**4. Type punning, unaligned access, `volatile`.** `*(int*)p` on a pointer not proven aligned
becomes four byte loads; proven aligned, it becomes one `HEAP32[p>>2]`. The proof comes from `opt/`,
or failing that from hot specialization behind a guard. Writes into `0xA0000-0xBFFFF` route to
MIRAGE's VGA device.

**5. Bit-exact `float`.** `Math.fround` on every `float` store and operation — Quake's float bit
tricks depend on it. `double` is native. `long long` is a pair of i32s, the accepted cost of the
pure-JS choice.

**6. `setjmp`/`longjmp`.** `longjmp` throws a token; `setjmp` turns its caller into a restart loop
with saved state. Applied only to functions that actually call `setjmp` (Quake's `host_error`,
Doom's `I_Error`), never globally.

## Two-tier emission

MIRAGE **measured** that compile cost tracks emitted *source volume*, not function count (Turbo
Pascal: 151 blocks were 96.6% of 10 MB of emitted JS; 54% of one block was the inlined memory path).
A C compiler over Quake's 128 `.c` files hits that wall immediately, so the split exists from the
start rather than being retrofitted:

- **tier-0 (cold)** — compact emission, memory access through short helper calls, no optimization.
- **tier-1 (hot)** — after N calls or iterations, re-emitted with everything inlined, locals
  unboxed, memory access specialized, inline caches installed.

**Invariant, modelled on MIRAGE's `fuzz-region`:** tier-0 and tier-1 must produce identical state.
Every optimization pass gets a `PRISM_NO*` kill-switch, and every gate must pass with each switch
both on and off.

## Determinism

No `Math.random`, no `Date` in the compiler or the runtime's decision-making. The same input must
yield byte-identical emitted code and byte-identical program state — that is what makes fingerprint
gates possible at all. Keep it that way.

## Running in a browser: observing a guest that never yields

A C program's main loop is synchronous. MAME 0.1 spins inside `run_machine` until a key says stop;
Quake spins in `Host_Frame`. There is no moment at which a browser could paint, and Emscripten's
answer — `emscripten_set_main_loop`, i.e. **rewrite the loop** — is exactly the source modification
this project exists to avoid.

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

### Genericity that is structural, not asserted

The page knows nothing about any program: it compiles C, paints an 8-bit indexed framebuffer at
whatever size the guest asked for, through whatever palette the guest built, forwards scan codes, and
passes the argument string to `main` as `argv`. Programs are **data** — `web/programs/*.json`,
discovered at start-up, never listed in the page's code — plus a platform layer under `src/env/` if
one is needed. Two ship: MAME 0.1, and a plain-C89 Mandelbrot with no platform layer and no data
files, which exists precisely so that "the shell is generic" is a claim something can falsify.

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

What this deliberately does not catch: a loop that never calls the runtime, `while (1);` being the
honest example. Nothing here can see it because nothing here is called. The recourse is terminating
the worker; the general fix is a safepoint on loop back-edges in emitted code, which MIRAGE measured
as a real cost on emitted-code speed, so it waits until something needs it.

Known limitation, stated rather than discovered later: a timing-**calibration** loop — one that counts
iterations per tick to measure the machine — gets cut short by damping and reads the machine as slower
than it is. Nothing in MAME calibrates. If something later does, the fix is a per-program exemption,
not a cleverer heuristic.

## Two platform layers, and why they look nothing alike

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
