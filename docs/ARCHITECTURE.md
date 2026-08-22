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
