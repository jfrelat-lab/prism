# PRISM — Testing & Gates

The safety net. Nothing in PRISM validates its own answers: every layer is checked against an
**external** oracle, and the bar for a commit is a green run of the gates that touch what changed.

## The oracle (`tools/oracle.mjs`, `tools/oracle/Dockerfile`)

This host is **arm64 macOS**. Measured before anything was built:

| | Result |
|---|---|
| `gcc` | absent — `gcc` is a symlink to Apple clang 17 (arm64) |
| `clang -m32` | **fails**: `ld: unknown -arch name: armv4t` (clang reads `-m32` as 32-bit ARM) |
| cross-compiler | none (`i686-*`, `djgpp`, `mingw` all absent) |
| `csmith` | absent |
| `docker` | 28.5.2, aarch64 server |

So the entire external-truth layer lives in a container: **`i386/debian:bookworm-slim`, platform
`linux/386`** (`uname -m` → `i686`). `linux/386` rather than amd64 + `-m32` on purpose — the
differential gates need programs that **run**, not just object files, and Rosetta does not execute
32-bit x86.

```bash
npm run oracle:build      # docker build --platform linux/386 -t prism-oracle tools/oracle
npm run oracle:version    # gcc (Debian 12.2.0-14+deb12u1) 12.2.0 / csmith 2.3.0
```

`oracle.mjs` keeps **one long-lived container** and talks to it with `docker exec`, because the
costs are not comparable: `docker run` ≈ **3.8 s**, `docker exec` ≈ **46 ms**, and a gate makes
thousands of calls. Files are exchanged through a bind-mounted `.oracle/` scratch dir, so Node
writes them directly instead of paying for `docker cp`.

**Debian's `csmith` package ships the generator and none of the runtime headers** its output
`#include`s — and three of those headers do not exist in the source tree either, they are `m4`
templates the upstream build expands. The image fetches the pinned `csmith-2.3.0` runtime tree and
runs the same rule upstream's `runtime/Makefile.am` uses (`$(M4) < $< > $@`).

Measured cost of one Csmith differential cycle (generate → `gcc -O0` → run): **~3 s**
(1.3 s generate, 1.8 s compile, 0.05 s run). A 2577-line program compiled at `-O0` *and* `-O2` cost
16.7 s, so the per-program figure tracks program size, not a fixed overhead. 10 000 programs is
therefore ~3 h at 8-way parallelism — and it is a **one-off capture whose result is committed**, the
same pattern as MIRAGE's `golden-baseline.json` and its Unicorn capture. Once captured, the gate
needs neither Docker nor gcc.

## The ABI gate (`tools/gate-abi.mjs`) — the only gate that exists today

`src/sema/abi.js` vs a real i386 gcc: `sizeof`, alignment, member offsets, and **bitfield bit
placement**. Bar: exact, every case.

```bash
npm run gate:abi              # 317 cases (17 hand + 300 generated), ~1700 checks
npm run gate:abi:deep         # 3000 generated cases
node tools/gate-abi.mjs 800 777    # [count] [seed]
```

Three design points, each of which earned itself:

**Bitfields are checked by observation, not by `offsetof`** (which C forbids on a bitfield). The
probe zeroes a struct, writes all-ones into one field, and dumps the bytes; the resulting bit
pattern pins the placement exactly. There is no other ground truth.

**Alignment is measured the way a struct experiences it** — the offset the type forces inside
`struct { char pad; T inner; }` — not with `__alignof__`. See the trap below.

**Generated cases, following MIRAGE's `x86-gen` lesson ("the generator does not think").** Seeded
xorshift32, no `Math.random`, so a seed always yields the same structs. This was not decoration:
the 17 hand-written cases and seed 12345 **passed on the first run**, and four other seeds then
found 13–25 divergences each. Everything below was found that way.

### What the oracle actually said (observed, never derived)

```
int=4 long=4 ptr=4 long long=8 long double=12    char is SIGNED
struct {char a; int b;}         size 8   b@4
struct {char a; long long b;}   size 12  b@4     <- align 4, not 8
struct {char a; double b;}      size 12  b@4     <- align 4, not 8
struct {char a; long double b;} size 16  b@4
```

**The trap that made `abi.js` necessary.** `__alignof__(double)` and `__alignof__(long long)` report
**8** on i386, but the ABI aligns both to **4 inside a struct**. `__alignof__` answers "preferred
alignment", which is a different question from the one a struct layout asks. Had `abi.js` been
written from `__alignof__`, every struct containing a `double` would have been 4 bytes out — and
because game code `memcpy`s WAD/ROM bytes straight into structs, the symptom would have been
corrupted sprites, hunted anywhere but here.

### The three bitfield rules the generator found

1. **A bitfield may span up to `sizeof(T)/alignof(T)` units of `alignof(T)` bits — not one.**
   The naive "never straddle a `sizeof(T)` unit" rule is wrong, and `unsigned long long f3:21` at
   bit 112 proves it: it straddles, and gcc leaves it there. The real System V / PCC test is
   `ceil((bitPos % abits + width) / abits) > sizeof(T)*8 / abits`. `long long` (8 bytes, 4-byte
   aligned) gets two units; `int` gets one.

2. **A packed bitfield is exempt from that rule entirely** — not merely clamped to a byte. gcc
   guards the whole test with `! DECL_PACKED (field)`, so in a packed struct `unsigned int f1:26`
   following a 23-bit field sits at bit **23**, not 24.

3. **A zero-width bitfield** rounds to `alignof(T)*8` (so `long long :0` moves to bit 32, not 64),
   contributes **no** alignment to the struct (`{char; int :0; char}` is size 5, align 1), and is
   **not** exempt under `packed` — a different code path from rule 2, which is why the two disagree.

`double` and `long double` are not legal bitfield types even in GNU C; the generator does not emit
them.

### Sensitivity — why green means something

A gate that passes on its first run may simply be blind. Each rule was perturbed and the gate had to
go red:

| Perturbation | Result |
|---|---|
| `double` align 4 → 8 | **129 divergences**, first case `struct {char a; double b;}` |
| `long double` size 12 → 16 | 137 divergences |
| bitfield span rule disabled | 65 divergences |

⚠️ The first attempt at the `double` perturbation reported *no change* — the `sed` pattern was one
space off and had silently matched nothing. The gate was fine; the measurement was not. Verify that
a perturbation actually applied before concluding the gate is blind.

### Current state

9 seeds × 800 cases (39 848 checks) and 4 fresh seeds × 3000 cases (65 806 checks): **all pass**.

## The preprocessor gate (`tools/gate-cpp.mjs`)

`src/cpp/` vs `gcc -E -P -std=gnu89`. Bar: **identical token stream**. The comparison is on tokens,
not text — gcc's whitespace and line decisions carry no meaning and the compiler downstream consumes
tokens. gcc's output is re-lexed with PRISM's own lexer, which exercises the lexer on a second input.

```bash
npm run gate:cpp                       # 42 hand cases + 60 generated, ~18 s with the ABI gate
CPP_SEED=777 CPP_GEN=250 npm run gate:cpp
```

Cases are self-contained (no system headers) so this gate tests the preprocessor and nothing else;
the `include-*` cases ship their own headers into per-case `d0`/`d1` directories, which is what makes
`#include_next` testable. Generated cases that gcc REJECTS are skipped — but only after checking that
PRISM rejected them too; accepting what gcc rejects is a divergence, not a skip.

State: **7 seeds × (42 hand + 250 generated) all green**, hand cases including the canonical
C99 6.10.3.5 example and Prosser's `f(2)(9)`.

### What the hand cases could not find

The 42 hand cases and the first generated seed passed at 30/32 and then 273/282. Everything below
came from generation or from sensitivity-checking, not from a case anyone wrote on purpose:

1. **Expansion is not line-oriented.** A function-like macro name at the end of a line takes its
   argument list from the next — the standard's own example depends on it (`& mm\n    (ff)`). The
   unit of expansion is a run of tokens delimited by **directives**, not by newlines. The original
   line-by-line loop failed the standard's example and no hand case had caught it.
2. **An empty argument next to `##` is a PLACEMARKER, not nothing.** Deleting it lets the paste reach
   the token *before* the parameter: `zz p0 ## p1` with an empty `p0` produced `zzbb` instead of
   `zz bb`. The hand-written `A3(,y,)` case missed it because `out` was empty there by luck. This one
   bug accounted for 7 of 9 generated failures, including all four "invalid paste" errors.
3. **The GNU comma-paste deletes the comma only when the variadic list is ABSENT.** `VE("a")` drops
   it; `VE("a", )` keeps it. `parseArgs` had padded the missing argument with `[]`, destroying the
   distinction before `subst` could see it.
4. **An unclosed argument list at end of file was accepted silently.** The slice handed to `#expand`
   stops before the EOF token, so `parseArgs` ran off the end of the array rather than seeing EOF.
   gcc errors; PRISM did not.
5. **`#if` does not evaluate dead branches.** `#if (0 ? 1/0 : 5) == 5` and `#if 1 || 1/0` both
   compile under gcc. `||`, `&&` and `?:` therefore parse their dead side but do not diagnose it.

### Sensitivity — and the two bugs it found on its own

| Perturbation | Result |
|---|---|
| hide sets disabled (no blue paint) | 3 failures, 16 s |
| placemarker removed | 3 failures |
| variadic absent/empty conflated | 1 failure |
| `#if` arithmetic narrowed to 32 bits | 1 failure |
| run split at every line instead of at directives | 77 failures (all of them) |

The first and last perturbations each **hung for over ten minutes** before they were fixed, and both
hangs were real defects in the shipped code rather than artifacts:

- The runaway guard was **per-call**, but argument expansion recurses into `#expand`, so each level
  stopped at its own limit while the total work stayed exponential. The budget is now **global to one
  top-level expansion**.
- `#process` had **no progress guarantee**: with `j === start` it looped forever emitting nothing.
  That cannot happen in the shipped code (a run never begins on a directive), but a hang is the worst
  possible way to find out otherwise, so it is now an explicit error.

⚠️ A third hang was pure harness: `timeout` does not exist on macOS, so a whole perturbation sweep
printed nothing at all and looked like five silent passes. Same family as the one-space `sed` in the
ABI gate below — **verify that a perturbation applied before believing what it reports**.

### Known limitation

Expansion rewrites its work list with `splice()`, which is quadratic when a macro grows the list.
It is bounded and reported, never a hang, but it will matter for real headers. Not yet measured on
any — a frame-stack rewrite is roadmap P0.3b, to be justified by a measurement on the corpus rather
than by this note.

## The declaration gate (`tools/gate-decl.mjs`)

`src/parse/` + `src/sema/` vs a real i386 gcc. There is no backend yet, so the parser cannot be
gated by running programs — but everything a *declaration* means is observable without one: sizeof,
alignment, member offsets, enum constant values, and the constant expressions inside array bounds
and bitfield widths. Getting those right needs the declarator grammar, typedef resolution, tag
scoping and the ABI all correct at once.

```bash
npm run gate:decl                          # 12 hand cases + 120 generated
DECL_SEED=777 DECL_GEN=200 npm run gate:decl
```

**Queries are not written by hand.** The gate enumerates whatever tags, typedefs and enum constants
PRISM *ended up with* and asks gcc about each. A declaration PRISM silently misparses into the wrong
shape still gets caught, because the shape is what generates the question.

State: 4 seeds, **8400+ checks, all pass**. Hand cases cover the classic declarator readings
(`int *a[6]` vs `int (*b)[6]` vs `int *(*d)[3]` vs `char (*e)[2][3]`), K&R definitions, implicit
`int`, self-referential structs, anonymous members, packed, `long double`, and enum initializers
using `sizeof` and `?:`.

### The blind spot the sensitivity check found

Reversing the declarator suffix loop in the parser — turning `int m[2][3]` into `int m[3][2]` —
left the gate at **719/719**. Not a bad perturbation: a real blind spot. Layout is *symmetric under
array-dimension permutation*, so sizeof and a member's own offset genuinely cannot tell the two
readings apart.

Closed by asking gcc for one **interior** element of each multi-dimensional array member:
`offsetof(T, m[0][2])` is 8 under one reading and 16 under the other. The same perturbation now
fails 719/720. Without that, a whole class of declarator bugs would have been invisible until the
backend existed.

⚠️ **Not gated yet:** statements and expressions are parsed but nothing observes them. That waits
for the backend (P0.5) — do not read this gate as covering them.

## The execution gate (`tools/gate-run.mjs`)

The first gate that observes **behaviour** rather than shape: PRISM compiles and runs a program, gcc
compiles and runs the same source, and everything written to stdout is compared byte for byte along
with the exit status. Both sides use the unmodified source — gcc against its own headers, PRISM
against `src/env/headers.js`.

```bash
npm run gate:run            # 22 programs
```

State: **22/22**. Coverage: arithmetic and its signed/unsigned corners, unsigned wraparound,
control flow with switch fallthrough, recursion, pointer arithmetic, 2-D arrays, structs and struct
assignment, static aggregate initialisers with string literals, function pointers in an array,
strings, malloc, static locals, bitfield read/write, narrowing casts, floats, short-circuit
evaluation, compound assignment evaluating its lvalue once, union punning, and 20 printf conversions.

### What running the programs found

Eight of the 22 failed on the first run. Six were real defects:

1. **`slot()` returned the END of an object, not its start.** Every aggregate local was placed one
   object too high. Two very different symptoms — `*p` reading `a[2]`, and a DataView range error
   once a frame reached the top of the buffer — one off-by-its-own-size.
2. **`|` binds looser than `+` in JavaScript.** An address emitted as `_fp+0|0` and then composed
   with `+4|0` became `(_fp+0)|(0+4)|0`, i.e. `_fp|4`. Every emitted address is now parenthesised.
   This one bug produced three separate wrong-output failures.
3. **A switch body's braces must be dropped.** `switch(x){{case 0:…}}` is a JavaScript syntax error;
   cases must be direct children.
4. **Initialising an aggregate from an expression is a copy**, not a scalar store — `struct box c = b;`
   and `char s[8] = "abc";`.
5. **Static initialisers needed string literals**: bytes for a char array, an interned address for a
   pointer.
6. **C's printf rounds a tie to EVEN.** `printf("%.0f", 2.5)` is `2` under glibc and `3` from JS
   `toFixed`. Measured, not assumed.

### ⚠️ And two were defects in the TEST CASES, not in PRISM

- `printf("%d %d %d", tick(), tick(), tick())` — argument evaluation order is **unspecified**, and
  gcc evaluates right to left. The case was testing gcc's choice.
- `printf("%d %d %d %d", i++, i, ++i, i)` — two unsequenced modifications of one object is
  **undefined**, not merely unspecified.

Both were rewritten into sequenced statements. This is the same trap MIRAGE documents for BCD flags
and for Unicorn's AF after a shift: **a differential gate must never compare on behaviour the
standard does not define**, or it reports bugs that do not exist. Any new case here has to be checked
for unspecified order and unsequenced modification before it is trusted.

### Sensitivity

| Perturbation | Result |
|---|---|
| `slot()` back to returning the object's end | 2 failures |
| `Math.fround` removed from `float` | 2 failures |
| one address left unparenthesised | 1 failure |

### Not supported by tier-0 (each throws a clear error, none silently miscompiles)

`long long`, `long double`, `goto`, struct pass/return by value, user-defined variadic functions,
inline assembly, compound literals, statement expressions, `offsetof` in an expression, and a
bitfield straddling a 32-bit unit.

## The external-suite gate (`tools/gate-suite.mjs`)

[c-testsuite](https://github.com/c-testsuite/c-testsuite) `single-exec`: 219 programs written by
other people. The hand gates test what I thought of; this one measures what C compilers are actually
asked to do — and **ranks the gaps by how many programs hit them**, which is the whole point.

```bash
npm run gate:suite           # against the committed capture, seconds
npm run gaps                 # just the ranked gap list
npm run gate:suite:capture   # re-run gcc over the corpus (slow, one-off)
```

The gcc side is captured once into `tools/suite-baseline.json` and committed, so daily runs are pure
JS — the same pattern as MIRAGE's `golden-baseline.json`.

**The gate fails on a WRONG ANSWER, not on a refusal.** A refusal is a known gap with a clear error;
a wrong answer means PRISM claimed success and lied. Current state: **182/219 pass, 37 refused,
0 wrong answers.**

### Four real defects, none of which a hand-written case had reached

1. **The frame was released before the return expression was evaluated.** `return foo(x)` ran `foo`
   on a frame overlapping this one, so `foo`'s own locals overwrote the array whose address had just
   been passed to it. It needs an aggregate local *and* a call inside a `return` to show up
   (`00077.c`); the value is now computed into a temp first.
2. **`long long` was silently miscompiled, not refused.** A non-address-taken local lives in a JS
   `var` and never reaches the load/store accessor, so the type check never fired and 64-bit
   arithmetic quietly ran as 32-bit. The check moved to `coerce()`, which every value passes
   through. **This is why "unsupported things throw a clear error" has to be verified, not asserted:**
   the claim was false for the one type most likely to be silently wrong.
3. **An incomplete array's size ignored designators and strings.** `int a[] = {5, [2]=2, 3}` has
   three items and four elements; `char s[] = "a" B "c"` is sized by its bytes.
4. **`__ILP32__` was missing** from the target macros, so a program probing its data model took the
   wrong `#if` branch.

⚠️ One reported difference was a harness artifact: the capture goes through `$(cmd)`, which strips
**every** trailing newline, while PRISM's side kept them. Strip both sides identically or a program
whose output ends in a blank line looks like a defect. Third time this class of thing has appeared —
see the `sed` and `timeout` notes above.

### The ranked gaps — and why the ranking mattered

My prediction before running it was "`long long` and `goto` are what real code hits first". The
first measurement said otherwise: **non-constant static initialisers were #1 with 8 programs**,
`goto` second with 5, and `long long` appeared in exactly one. Implementing static **address
constants** (`int *p = &x;`, `.p = &x`, `&arr[2]`, `name + 1`) took that from 8 to 4 and moved three
programs into passing.

Current ranking (37 refused programs, 21 distinct causes):

```
  9  long long / unsigned long long
  5  goto
  4  non-constant static initialiser (all four are compound literals now)
  3  missing header
  1× each: struct by value, statement expressions, strrchr, fopen, __builtin_expect,
           and eight one-off parse/emit corners
```

⚠️ A fix that changes nothing is usually not wired up. The address-constant work showed **no
improvement at all** on its first run, because the driver built the static-initialiser emitter with
empty symbol tables — the logic was right and unreachable. Check that a change is reached before
concluding it does not help.

## The torture corpus (`tools/gate-suite.mjs --suite=torture`)

**gcc's own `gcc.c-torture/execute`** — 1592 programs, the hardest widely-available C corpus. Fetched
from the gcc 12.2 release tarball (GitHub serves no subdirectory archive, and the API's 60
requests/hour makes 1400 raw fetches impossible):

```bash
curl -sL https://ftp.gnu.org/gnu/gcc/gcc-12.2.0/gcc-12.2.0.tar.xz -o /tmp/gcc.tar.xz
tar xJf /tmp/gcc.tar.xz -C .oracle/suites --strip-components=4 \
    gcc-12.2.0/gcc/testsuite/gcc.c-torture/execute
npm run gate:torture
npm run gaps:torture
```

These tests are **self-checking**: `abort()` on failure, exit 0 on success, so the exit status alone
is the oracle and no expected output is needed.

### Three harness corrections this corpus forced, each of which first looked like a PRISM result

**1. A gate that runs programs in its own process cannot stop one that loops for ever.** The first
torture run produced *no output at all* for over ten minutes. Every program now runs in its own
process (`tools/run-one.mjs`) under a 5 s wall clock, and a timeout is reported as a timeout.

**2. A self-checking corpus is only an oracle where the REFERENCE build passes.** Ten "wrong
answers" turned out to be tests that plain `gcc -O0` fails too: `memchr-1.c` exits 244, `strlen-2.c`
exits 2 at every optimisation level, and `return-addr.c` prints real return addresses so its exit
code differs per build. gcc drives its torture suite through its own harness over a matrix of
options; run outside that harness, those tests say nothing about PRISM. They are excluded and
**counted in the output**, never silently dropped.

**3. `abort()` is a DEFECT, not a gap.** It was first bucketed among the refusals, where 38
miscompiles sat looking like missing features. In a self-checking corpus `abort()` means the
program's own assertion failed — PRISM compiled it and produced a wrong value. Reclassified with the
wrong answers, which is what makes the gate go red for them.

### The ranking, and what it bought

The measured ranking was again not what I would have written. The largest gap in the first run was
not a language feature at all: **`__builtin_abort` in 124 programs**. Two tables — the `__builtin_*`
aliases (~164 programs) and gcc's predefined TYPE macros (`typedef __SIZE_TYPE__ size_t;` appears
instead of a header, and without the macro it reads as `typedef ;` — 60 programs) — took the corpus
from **696 to 868 passing**, with no compiler work at all; the bitfield-initialiser fix below made it 869.

Current state: **1214/1556 pass, ZERO wrong answers, 342 refused.**

That last number is the property worth having: across 1555 torture programs and 219 c-testsuite
programs, PRISM either compiles a program correctly or refuses it with a named error. It never claims
success and lies. Ranked gaps:

```
  142  long long / unsigned long long     <- now clearly the #1 feature
   78  missing header (66 of them <stdarg.h>, i.e. user-defined variadics)
   64  passing a struct or array by value
   41  parse error near '('
   37  non-constant static initialiser (compound literals)
   28  goto
   19  nested function definitions (a GNU extension)
   15  inline assembly
```

### P0.6c — closing the miscompiles (37 → ~8)

Correctness before coverage: a refusal is honest, a wrong answer is not. Seven distinct causes, in
the order they were found:

1. **`__attribute__((aligned(N)))` was parsed and thrown away.** It changes layout materially:
   `struct { char c; int i __attribute__((aligned(16))); }` puts `i` at 16 and is 32 bytes. A
   typedef carries it too. Also **member-level `packed`**, whose interaction with `aligned` is
   order-dependent and observable — `packed` drops the member to alignment 1 and a following
   `aligned(2)` raises it to 2, so `double d __attribute__((aligned(2),packed))` sits at offset 2,
   not 4.
2. **The address-precedence bug was only half fixed.** The earlier pass parenthesised the *composed*
   address but not the fragments: `((t)|0+2|0)` still parses as `t|2`. It hid for two whole rounds
   because on an aligned base `p|4` happens to equal `p+4` — an ordinary struct cannot expose it,
   and it took a *packed* struct's odd offsets to fail. **This single fix moved 15 programs.** The
   `packed-access-through-pointer` case in `gate-run` now pins it.
3. **A bitfield read undergoes the integer promotions**, and to a type that is not the declared one:
   `unsigned int u:7` promotes to `int`, because an `int` holds every value of a 7-bit unsigned
   field. Returning `unsigned int` made `bit.u % 61` unsigned (gcc's `bitfld-1.c` exists for this).
4. **Constant folding did integer division on floating operands.** `double d = 1024.0 - 1.0/32768.0`
   folded to exactly 1024.0, so `floor(d)` was 1024 instead of 1023.
5. **Bitfields in brace initialisers** were filtered out by `bits === undefined`, so
   `struct { signed s:3; unsigned u:3; } x = {-1,-1}` wrote *nothing*. Fixed in the dynamic path
   first and **the static path was missed**, so a file-scope `struct s x = {-123,-456}` still wrote
   nothing until a second, identical fix.
6. **`extern` inside a block created a private global** instead of binding to the file-scope object,
   so the inner declaration shadowed the outer definition.
7. **Two silent-wrongness sources turned into refusals**: type-changing attributes
   (`vector_size`, `mode`, `transparent_union`) were ignored like cosmetic ones, and wide literals
   (`L"…"`, `L'x'`) were emitted as bytes when `wchar_t` is 4 bytes on i386. Ignoring an attribute
   that changes a type is not "not supporting" it — it is producing a wrong program.

⚠️ **Refusing wide literals COST 9 passing programs** — a real trade, not a pure win: torture peaked
at 894 before #7 and settled at 885. Those 9 were passing because their wide strings were pure ASCII,
so the byte encoding happened to satisfy the test; they were right by accident, on the same code path
that made `wchar_t-1.c` wrong. A score that goes DOWN after a correctness fix is worth stating
plainly rather than smoothing over.

### P0.6e — the last six, and one property gained

37 → 0 wrong answers. The remaining causes:

- **The value of a bitfield assignment is what was STORED**, not the right-hand side. Assigning 1081
  to a `signed int m:11` yields -967, so `(l.m = j) == j` must be false (`921016-1.c`).
- **Source is a byte stream.** gcc's default input charset is UTF-8, but a narrow literal copies
  bytes through untouched and a real file need not be valid UTF-8 — `20000227-1.c` embeds a raw
  0xFF. Reading with `'utf8'` turned one byte into U+FFFD and then into three. Files are now read
  `'latin1'`, and a wide literal decodes the UTF-8 it carries.
- **Constant folding dropped casts.** `(unsigned short) -4` folded to -4 instead of 65532, so
  `volatile unsigned long l2 = (unsigned short int) -4;` held 0xFFFFFFFC (`pr39240.c`).
- **A flexible array member** contributes nothing to a struct's size but takes the next aligned
  offset; its size was `null`, which made the running bit position NaN. Initialising one is now a
  refusal rather than a plausible wrong object.
- **Two tests were excluded as bad oracles**, by name and with the reason recorded in the gate:
  `20031003-1.c` pins gcc's saturation on an out-of-range float→int (undefined), and `pr58943.c`
  pins gcc's order in `x[0] |= foo()` (an unsequenced read and modify). Same rule as refusing to
  compare on argument evaluation order.

**The duplication that caused the wide-literal mess got removed rather than patched.** Literal
decoding existed in three copies — the `#if` evaluator, the parser (to size an array), the emitter
(to lay bytes into memory) — and they disagreed, which is how `sizeof(L"Ä")` came out as 12. It now
lives once, in `src/util/charset.js`.

### P0.6d — wide literals, and what implementing a feature exposes

Implemented properly (`wchar_t` is 4 bytes on i386, so a wide literal is an array of 32-bit
elements): 885 → 892, miscompiles 8 → 6. Four separate things had to be right, and only the corpus
found the last three:

- The `L` prefix must be dropped **before** the quotes. Folding it into the slice that strips the
  quotes left `"Ä` and produced `x[0] == 34`.
- `L"a" "b"` is ONE wide string: the wideness of a concatenation is decided first and every part
  encoded at that width. Encoding each part at its own width put a 1-byte `'b'` after a 4-byte `'a'`.
- Indexing a wide literal must read a `wchar_t`. `#rval` returned `char *` unconditionally.
- A string literal's type is a **complete** array — `sizeof("ab")` is 3 — so it carries its length.

**A missing macro is not neutral.** `#if __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__` with both macros
undefined compares `0 == 0` and takes the big-endian branch. Defining the endianness macros fixed
`widechar-3.c` — and *revealed* two more failures (`bitfld-6/7`) that had been passing only because
an `#ifdef __BYTE_ORDER__` compiled to nothing and returned 0. A fix that makes the score worse may
simply have stopped hiding something.

**And that pair exposed a whole untested class:** `layoutUnion` recorded no bit placement at all, so
a bitfield in a union read `undefined >> 5`. The ABI generator had never produced one
(`bf = !union && …`), so nothing covered it. Now generated on both, plus two hand cases.

⚠️ **The ABI gate could not have caught #1's parser half.** `gate-abi` builds types by hand and
applies the alignment itself, so it verifies the layout *rules* and not the parser's use of them.
That is what `gate-decl` (which parses real C) is for, and the lesson is general: a gate that
constructs its own input does not test the front end that would normally produce it.

## 64-bit integers (P0.5b)

tier-0 represents `long long` as a **BigInt**. The plan called for i32 pairs and tier-1 will lower
them, but tier-0 is the compact/generic path: BigInt is correct by construction where pairs need a
twenty-function helper library and an out-of-band return convention.

The property that makes it safe is that **JS refuses to mix BigInt with Number**. Every conversion in
or out has to be written, and a missed one throws `Cannot mix BigInt and other types` — a loud error
rather than a quietly wrong number. That is the right failure mode for a 64-bit type on a 32-bit
target, and it is why `coerce()` handles i64 before anything else.

Three defects appeared the moment 131 previously-refused programs started running, and two of them
were in **constant folding rather than emitted code** — a place bugs hide well, because nothing
compares the compile-time and run-time paths against each other:

- A 64-bit literal was masked with `asIntN` regardless of signedness, so `18446744073709551615ULL`
  became `-1n` and `(double)` of it was -1.
- The parser's constant evaluator did not wrap a folded value to its expression's type, so
  `long long b = (0x1234567876543210LL << 32) >> 32;` kept the shifted-out bits while the same
  expression evaluated at run time did not.
- `printf` needed real length modifiers: `nextArg() | 0` on a BigInt throws, which is how `%lld`
  announced itself.

A fourth test was excluded as a bad oracle: `20021127-1.c` defines `llabs`, a name reserved for the
library (C 7.1.3), and pins gcc's builtin folding rather than any required behaviour.

## Struct by value and inline asm (P0.5b, continued)

**Structs by value** (65 programs): a by-value parameter is a pointer to a copy the CALLER made — so
the callee may modify it without the caller seeing it — and a return goes through a caller-supplied
buffer (the sret convention), because the callee's frame is released before the value could be read
out of it. Both the copies and the buffer are allocated in the caller's frame. Torture 1026 → 1096,
and for the first time a feature landed with **no new miscompiles at all**.

**Inline asm** is now genuinely parsed — qualifiers, template, operands, clobbers — instead of being
skipped as an opaque token run. The qualifiers alone were the reason 39 programs failed to *parse*:
`asm volatile ("")` puts `volatile` between the keyword and the paren.

An asm with an **empty template** emits no instructions, so with no output operands it is faithfully
a no-op whose inputs are still evaluated (they are C expressions and may have side effects).

### The rule this session had to learn twice

Generalising that to "empty template = nothing at all, outputs included" was wrong, and the corpus
said so immediately: a **tied constraint carries a value through the shared register even with an
empty template**, so `asm ("" : "=r" (i) : "0" (x))` copies x into i (`20030222-1.c`), and an output
operand's lvalue may itself have side effects — `asm("" : "+r"(*bar()))` must still call `bar()`
(`990130-1.c`). Narrowing back to "no output operands" cost 12 passes (1120 → 1108) and restored
zero wrong answers.

This is the **second** time the same shape appeared — wide literals first, then asm:

> Implementing a feature moves programs from *refused* to *wrong*, and the fix is to narrow the
> claim rather than to add more code.

So: **judge a landing by the miscompile count, not the pass count.** A feature that raises passes
while raising miscompiles has made the compiler worse, because a refusal is honest and a wrong
answer is not.

## The rest of P0.5b: varargs, goto, and a batch of parse errors

**User-defined variadic functions** (49 programs). The caller packs the variadic tail into a buffer on
the shadow stack and passes its address; `va_list` is a plain `char *`, exactly as on i386 SysV. The
pleasant consequence is that **`va_arg` needs no emitter support at all** — two builtins and a macro
suffice:

```c
#define va_arg(ap, type) (*(type *)__prism_va_next(&(ap), sizeof(type)))
```

Two defects, both from the two halves of a convention disagreeing:

- The variadic tail was passed **both** positionally and in the buffer, so the buffer landed in the
  wrong JS parameter.
- Each argument was **evaluated twice** — once to learn its type, once to store it — so
  `f(2, i++, i++)` incremented four times. The type now comes from the parser's annotation instead.
- A **zero-sized** argument advanced the reader by one slot and the packer by none (a `|| 1` fallback
  on one side only), which desynchronised every argument after a `struct { char x[0]; }`
  (`va-arg-22.c` passes 21 structs by value, the first of them empty). **Both halves of a convention
  must share the rule**, or a corner case shifts everything after it.

**`goto`** (16 programs) is a state machine over the function's top-level statements: a labelled
`for(;;) switch(_pc)`, where a jump sets `_pc` and `continue`s. JS switch fallthrough reproduces C
label fallthrough exactly, and `continue _top` from inside a nested loop unwinds it — which is what a
goto out of a loop must do. A label nested inside a block still needs control-flow flattening and is
refused by name.

That translation then made **GNU label addresses free**: in a state machine the "address" of a label
IS its dispatch value, so `&&lab` is an integer and `goto *p` is a dispatch on it — including from a
static table (16 programs).

**A parse-error batch** (~46 programs): `asm ("" : : : "memory")` failed because the clobber section
was identified from a counter that had already been incremented; `++`/`--` on a bitfield now
read-modify-writes and yields the value STORED; and GNU complex types became a named refusal instead
of surfacing as "expected ';'".

⚠️ **A third test case of mine relied on undefined behaviour** — `printf("%u %u", f.a++, f.a)`. The
checklist for a new case in this file is therefore: no unspecified argument order, and no unsequenced
read-and-modify of one object. (A fourth self-inflicted one: backticks inside a C comment terminate
the JS template literal the case lives in.)

## P1 — MAME 0.1 (`tools/mame.mjs`)

MAME 0.1 compiles from its unmodified source and runs: 18 translation units, 894 functions, 0.55 MB
of emitted JavaScript.

```bash
node tools/mame.mjs                       # build only
node tools/mame.mjs --run --test-rom      # run with a hand-written Z80 ROM
node tools/mame.mjs --run --test-rom --args="-nosound -nojoy -vesa"   # the other display path
```

**The platform boundary is MAME's own.** `osdepend.h` declares exactly eighteen functions and the
whole Allegro dependency lives in `src/msdos/msdos.c`, which MAME's makefile already selects per
platform. PRISM supplies a different backend (`src/env/osd.js`) and compiles every other file
untouched — the intended use of the abstraction, not a modification. Built without `-DX86_ASM`, a
build option Z80.c guards its assembly behind.

Everything in the backend is **deterministic**: `clock`/`uclock` are counters, `rand` is the ANSI
LCG, `osd_obtain_pen` hands out indices in order. Reading host time or entropy would destroy the
property that makes a golden frame fingerprint possible.

**Game ROMs are not included and will not be fetched** — they are copyrighted data. Verification
instead uses a **hand-assembled Z80 program** as `pacman.6e`, which proves more than a game ROM
would because the opcodes are known and so is the expected effect: it writes 64 cells of video RAM
at 0x4000 and colour RAM at 0x4400, and the run fills exactly the bottom two rows of the display —
224×16 = 3584 pixels, all one pen. That exercises the Z80 core, the memory-map dispatch and the
tilemap renderer with data authored here.

⚠️ **Open, and deliberately not explained away:** writing 32 cells instead of 64 produces *zero*
pixels anywhere, which no model of "which video RAM indices are visible" accounts for — 32 indices
cannot fill the 56 visible cells that 64 do. The first hypothesis (56 of 64 visible) was refuted by
measurement; a second was not invented. It is a question about Pac-Man's video RAM mapping rather
than about PRISM, resolvable by instrumenting the driver, and it blocks nothing.

### Four defects found by compiling real code, two of them structural

1. **A struct tag was never completed.** `driver.h` includes `machine.h`, which declares
   `struct MachineDriver *drv` *before* `driver.h` defines the body. On the definition PRISM created
   a NEW placeholder and re-declared the tag, leaving every earlier reference pointing at an object
   that was never filled in. Any pair of mutually-referential headers hits this — and 1774
   single-file test programs cannot.
2. **Call sites used the source name, not the linkage name.** A file-scope `static` had its
   definition mangled per unit but its callers did not follow.
3. **An enum whose enumerators are all non-negative is unsigned.** Only observable through a
   bitfield: `enum e code : 8` holding 150 must read back as 150, not sign-extend to -106. Caught by
   applying this file's own rule — judge a landing by the miscompile count — when c-testsuite went
   from 0 wrong answers to 1.
4. DJGPP's `uclock`/`uclock_t` had to be real (64-bit, `UCLOCKS_PER_SEC` = 1193180): MAME uses them
   unless `UNIX` is defined, and a DJGPP target must therefore provide them.

Multi-unit linking itself was new work (`compileProgram`): parse every unit, place every name, then
emit — with internal linkage mangled per unit.

## The Z80 differential (`tools/z80diff.mjs`) — P1.4

The tool the Pac-Man bug needed. It compiles `tools/z80diff/z80diff.c` plus MAME's `Z80.c` twice —
once with the oracle's i386 gcc, once with PRISM — drives both from the same ROM image with the same
T-state budget, and prints the register file after every step. With identical initial state, any
divergence is a compiler bug and nothing else. Same shape as MIRAGE's Unicorn co-simulator.

```bash
node tools/z80diff.mjs --roms=<dir with pacman.6e .6f .6h .6j>
```

No ROM data lives in the repository: the harness reads whatever directory it is pointed at and copies
the image into the gitignored `.oracle/`.

**It found the defect in seconds**, at `PC=0x2313`, instruction `10 fc` = `DJNZ -4`: gcc lands on
0x2311, PRISM landed on 0x2310. The cause is one line of MAME's core —

```c
#define M_JR   R.PC.W.l += (offset)M_RDMEM_OPCODE();
```

`M_RDMEM_OPCODE()` increments PC. In `a += b` the load of `a` and the evaluation of `b` are
**unsequenced**, so gcc evaluates the right-hand side first and reads the already-incremented PC,
while PRISM read PC first. Every relative jump was one byte short, which is why Pac-Man never got
out of its init.

PRISM now evaluates the right-hand side of a compound assignment **before** loading the lvalue. Both
orders conform; only one runs the code this project exists to run. Consequently
**`pr58943.c` is no longer excluded as undefined behaviour** — it passes on its own, and the
exclusion list is one shorter. Worth keeping in mind: the earlier decision to exclude it was correct
as a *gate* decision and wrong as a *design* decision, and real code settled it.

### Two lessons from building the harness itself

**A differential only tests the paths it drives.** The first version always returned
`Z80_IGNORE_INT`, so its "identical over 20000 steps" said nothing about `EI`/`DI`, `IM 2`, vector
fetch or `RETI` — exactly the code an interrupt-driven game depends on. Extending it to offer
interrupts is what exposed the next difference.

**Not every divergence is a bug.** `Z80_Reset` does `R.R = rand()`: the core randomises the refresh
register deliberately, and PRISM's `rand()` is a deterministic LCG rather than glibc's sequence. The
harness pins the initial state instead of excluding the field — control the input rather than mask
the output. (This is a real, documented divergence: any program whose output depends on `rand()` will
differ from a native build.)

State: **identical over 20006 steps including interrupts.** The Z80 core is compiled correctly, so
Pac-Man's remaining failure is in the machine layer, not the CPU.

## The whole-build differential (`tools/mamediff.mjs`) and the first perf number

`z80diff` proved the CPU. `mamediff` covers everything above it: both sides compile the SAME MAME
sources with the SAME headless C backend (`tools/mamediff/osdnull.c`) and print a hash of the display
bitmap every frame, so the first differing line names the frame.

```bash
node tools/mamediff.mjs --roms=<dir> [--frames=200]
node tools/mame.mjs --run --roms=<dir> --frames=200 --png=/tmp/pacman.png
```

**Result: identical over 226 lines at 200 frames** — every frame hash matches gcc, including the 31
frames from 91 onward that actually draw (26 340 lit pixels at frame 92). PRISM's output is
bit-identical to a native i386 gcc build of MAME 0.1, frame by frame.

### Two defects, and one claim of mine that the measurement refuted

**A runtime builtin shadowed a function the program defines.** `#call` consulted the builtin table
before the program's own functions, so MAME's headless `osd_key_pressed` was replaced by PRISM's —
which always returns 0, so the run never ended. It burned **twelve hours** before being noticed. The
general form is worse than the symptom: a program defining its own `memcpy` or `printf` would have
silently got PRISM's. A definition now wins; a mere prototype does not, so `int printf();` still
reaches the runtime.

**The platform backend allocated in the wrong region.** `src/env/osd.js` built its bitmaps with
`mod.alloc`, which grows the STATIC area by advancing `brk` — but the heap start is fixed when the
program begins, so allocating there at run time handed out addresses `malloc` later handed out again.
The framebuffer was quietly overwritten and read as all-zero, while the C backend compiled from the
same source saw 26 340 lit pixels. A platform backend must use the guest's own allocator.

⚠️ **I claimed tier-0 was "pathologically" slow on the strength of that twelve-hour run.** It is not:
121 frames of Pac-Man run in **0.31 s**. The run was a hang, not slowness, and asserting a
performance characteristic from a hang is exactly the mistake MIRAGE's "measure, do not justify" note
warns about.

### The perf number (`tools/bench.mjs`), and three wrong versions of it

One comparable unit: MAME's Z80 core executing Pac-Man's ROM, a fixed instruction budget, with a
**checksum on both sides** so the ratio is meaningless unless both did identical work.

```
                                   10M steps      40M steps
gcc -O2, i386 EMULATED             15.5 M instr/s  15.3 M instr/s
clang -O2, arm64 NATIVE           227.8           231.2
PRISM tier-0                       25.5            24.0
```

**PRISM tier-0 is ~9.5× slower than native.** Stable across a 4× change in workload, which is what
makes it believable. The plan feared 30× for a DataView-based emitter with no optimiser at all, so
9.5× is better than expected — and it is the number P2 (IR, escape analysis, tier-1) now has to
justify itself against.

Note in passing that the containerised gcc runs 15× slower than native clang: the oracle container
is an excellent correctness reference and a useless speed one.

#### The three wrong answers this measurement gave first

1. **"PRISM is 3.5× FASTER than gcc."** True as measured, meaningless as stated: the gcc side is i386
   under emulation while the JavaScript runs natively. A reference has to run on the same silicon.
2. **"PRISM is 2.3× slower than clang."** Wrong: the native side was timed from outside with
   `spawnSync`, so process creation and scheduling were counted as work.
3. **"clang runs at 36, then 79, then 115 M instr/s."** A 3× spread on the same binary — obviously the
   harness, not the machine. Fixed by having the native builds **time themselves** with
   `gettimeofday` and taking the best of three; clang then reported 227.8 and 231.2 on workloads 4×
   apart. PRISM was in-process all along, which is why its figure was stable (23.9–26.8) throughout
   and the native one was not.

The lesson is narrower than "measure carefully": **a ratio is only as good as the weaker of its two
measurements**, and the stable side gives no warning that the other is broken. Three consecutive
conclusions were reported before the numbers stopped moving.

## Gates still to build

In the order the roadmap wants them: preprocessor vs `gcc -E`; c-testsuite; gcc torture `execute/`;
the Csmith differential; tier-0 == tier-1; whole-program pixel diff against MIRAGE running the
original binary; `dbx-oracle` DOS-call sequence; and the perf ratio in one comparable unit.

## Verifying in a browser — four traps, all hit

1. **The tab was `hidden` the whole time.** `requestAnimationFrame` never fired, so the paint loop
   never ran, the acknowledgement never advanced, and the guest sat at frame 2. The display looked
   broken; nothing was broken except the assumption that a page in an automated browser is visible.
   Pacing was moved onto a timer as a result — a real fix, found by a harness artefact.

2. **Every synthesised keypress was silently dropped.** Keys sent by the automation harness arrive
   with `KeyboardEvent.code === ""`, and the shell keyed off `code` alone. The screen looked perfect
   and the input did nothing. Fixed with a fallback to `event.key`, which also covers on-screen
   keyboards and some remote-desktop stacks.

3. **I screenshotted before the guest had drawn — three times.** At 3 fps a coin takes a second of
   wall clock to reach the credit line. Three separate "the coin does not register" conclusions were
   wrong; each time the fix was to read the shared state at the instant of the event (`keys[4]` was 1
   in the handler, the latch counted down over the next 8 frames) rather than to photograph the
   canvas afterwards. *Look at the counter, not at the picture* — and I needed telling three times.

4. **The control table was transcribed from habit, not from the source.** MAME 0.1's coin key is
   `OSD_KEY_3`; 5 is a modern MAME convention and does nothing in 1997 code. The answer was four
   lines into `src/pacman/machine.c`.

### A calibrated constant, not a chosen one

`KEY_HOLD_FRAMES` is 8 because Pac-Man's ROM debounces its coin input: a 1-frame pulse registered
nothing, 4 frames registered nothing, 8 frames registered exactly one coin, and a physical hold
spanning 6 frames registered two. A guess would have been 1.

### The pacing bug the gates could not see

Every gate was green while the game was unplayable. Nothing in the headless suite has a frame rate:
`gate-run` compares stdout, `mamediff` compares frame hashes, and both are indifferent to *when* a
frame happens. The defect — pacing the guest against the page's paint rate instead of against a clock
— was only visible to somebody trying to play, and it was reported that way ("injouable car trop
rapide").

Worth keeping in mind for the tiers: an emitted-code bug shows up in a corpus, but a *timing* bug
needs a human or an explicit measurement of fps against the program's declared rate. The shell now
prints `59.9 of 60 fps`, which is that measurement made visible.

### An exception in a timer is silent

`stats()` referenced a constant I had renamed. It runs on a 250 ms interval, so it threw 32 times
into the console and the only visible symptom was a status line stuck on "idle" — the canvas, the
program and the frame counter were all fine. Reading the browser console is not optional after a
rename: a throw inside a timer or a rAF callback does not stop anything and does not surface.

### Four wrong explanations for 2 fps

The frame rate came out at 57 instead of 60 and I explained it four times before measuring it.

1. "The park granularity overshoots" — plausible, and asking for 0.25 ms instead of 1 ms did move it
   from 43-59 to 55-59. Partly right, and it hid the rest.
2. "The learned deadline will fix it" — the learning was measuring from the start of the wait to the
   *next frame boundary*, which is the frame PERIOD, not the wait. The landing window sat past the
   deadline and did nothing.
3. "The 4096-call spin burst before damping costs 0.6 ms a frame" — a clean arithmetic story that
   matched the residual exactly. Lowering the threshold to 64 changed the rate by nothing at all.
4. Only then did I post the counters out of the worker: `spins: 0`, every `learned: 0`. The landing
   window had **never fired**, because the run counter is clamped to the threshold once damping
   starts and the test was `run > limit` — never true. Three of the four explanations were about a
   mechanism that was not running.

The lesson is not "measure more", it is *where*: all of this state lived in the worker, invisible to
the page, and I kept explaining it from the outside. `postMessage` from a worker queues to the page
without the worker yielding, so even a guest blocked in its own loop can report its counters. That
diagnostic channel should have been the first thing built, not the fifth.

### Open: Quake compiles 10x slower in the browser than in Node

Measured, unexplained, and recorded rather than guessed at.

| | |
|---|---|
| Node, 69 units, 1.67 MB emitted | 0.9 s |
| the same build in a browser worker | 9.4 s |
| MAME in the same browser worker, 0.46 MB emitted | 0.7 s |

Superlinear in emitted size, which is the shape MIRAGE's D6 lesson predicts — but that lesson is about
emitted VOLUME, and Node compiles the same volume in a tenth of the time, so it does not explain the
gap on its own.

**Hypothesis refuted by measurement:** the browser uses a SharedArrayBuffer for the guest image and
the Node tool does not, so shared memory was the obvious suspect. Compiling the same units in Node
both ways: 903 ms unshared, **765 ms shared**. Shared memory is not the cause, and is if anything
marginally faster here.

Candidates not yet tested: `new Function` on a 1.67 MB source string being parsed eagerly in a worker,
a cold JIT tier, or the pane's Chromium build. The next step is to time the phases separately —
preprocess, parse, emit, `new Function` — on both sides, rather than to reason about it further.

### The shadow-stack leak, and the two tools that found it

Quake ran for 1238 frames and then stopped with its own message: `R_RenderView: called without
enough stack`. Quake checks that a local's address has not drifted more than 10000 bytes from the one
it recorded at start-up.

It had drifted. `--trace-sp` on `tools/quake.mjs` wraps `Host_Frame` — reachable because sys_null.c's
main() calls it across a unit boundary, so it goes through the function table — and showed **8 bytes
lost per frame**. 8 x 1250 = 10000, which is exactly where it died.

`--audit-sp` then wrapped all 1030 functions and checked the invariant directly: **M.sp on return
equals M.sp on entry, always**, including for a function that used alloca, because a frame's space
dies with the frame. Four functions violated it, and the smallest violation was the one worth reading:

    function W_GetLumpinfo(name){
      var _fp=M.sp-20|0;        // the frame is 20 bytes
      ...
          M.sp=_fp+16|0;        // an early return gives back 16
          return _t2;

The epilogue was written inline with `this.frameSize` **as it stood at that moment**, and slots are
allocated as emission proceeds — the varargs buffer for a later `Sys_Error` call grew the frame from
16 to 20 after that return had already been emitted. The fix is to emit a marker and resolve it once
the frame is final.

Three things worth keeping from this:

1. **The bug was old, not new.** It predates the flattening pass; every function with an early return
   followed by any later allocation leaked the difference. Nothing in either corpus caught it, because
   a leak is invisible unless something measures the stack — c-testsuite and gcc's torture programs
   run once and exit.
2. **Quake caught it because Quake checks.** A program without that assertion would have run until the
   shadow stack overflowed, and the failure would have looked like anything at all.
3. **An invariant is worth more than a test.** "sp out == sp in" is checkable over every function in a
   real program, and it turned a mystery into a name in one run. `--audit-sp` stays in the tool.

### What SQLite found that two games and 1775 corpus programs did not

SQLite is 269,650 lines in one translation unit, with no platform layer and no data files. It was
picked as a COMPILER test rather than a host test, and it earned that in one session — every item
below is a defect it exposed, ranked by how it was found rather than by size:

| Defect | Why nothing else caught it |
|---|---|
| **`const` on a pointer to an incomplete tag** broke the tag's later completion. `qualify()` cloned the record, so `struct A { const struct B *p; }; struct B { int v; };` left the clone empty for ever and `a->p->v` reported "no member". | MAME's mutually-referential pair had no `const`. The fix from that bug — complete the existing tag rather than replacing it — was correct and insufficient. |
| **Comparisons and `?:` did not fold in static initialisers.** A static initialised with `0 == 1` was refused outright. | Both corpora have such programs, but they were already refused for other reasons; this one was masked. |
| **Pointer arithmetic with a 64-bit index** emitted `Math.imul(x\|0, 1)` on a BigInt. | The BigInt representation is deliberately loud, and it was: "Cannot mix BigInt and other types". Nothing else indexed a buffer with a `long long`. |
| **The address of a library function** had no address to take. SQLite's unix layer builds a table of syscall pointers so it can swap them under test. | Programs call libc; they rarely take its address. |
| **`offsetof` in an ordinary expression** — the constant folder knew it, the emitter did not. | 38 SQLite functions use it; neither game does. |

Two diagnostics were improved because a message named a node kind rather than a thing: `'ident' is not
a constant expression` became `identifier 'EAGAIN' is not…`, and a refused static initialiser now
describes the expression it refused. In a 270,000-line file, a node kind is not a search term.

And one harness bug that had been sitting in four tools: a header resolver that reduced `sys/types.h`
to `types.h` before consulting the table, stubbing a header that was right there. It surfaced as a
parse error inside the stub, twenty lines from its cause.

Net effect on the external corpora, from work that was aimed at SQLite alone:
**c-testsuite 196 → 197, gcc.c-torture 1243 → 1255, still zero wrong answers.**

### Two symptoms in Doom, three different causes

Reported as "no demo plays, and pressing Enter gives a menu with a strange blink". None of the three
causes was where the symptom pointed.

**1. The demos are refused by Doom itself.** Its own message says so: `Demo is from a different game
version!` — the shareware `DOOM1.WAD`'s recorded demos carry a version byte `linuxdoom-1.10` does not
accept. Faithful behaviour of this source with this WAD, not a PRISM defect, and the program printed
the answer all along.

**2. The clock was racing.** The deterministic `gettimeofday` advances one Doom tic per CALL, and
`I_GetTime` is called several times per frame, so game time ran far ahead of frames and the attract
pages flew past. `installRealClock` now supplies `gettimeofday` as well — Doom times itself with that
rather than with `clock()` — and the measured rate is 34.9 fps against Doom's TICRATE of 35.

**3. A block-scope function declaration became a null local.** This one was worth the hunt. Doom's
melt effect contains:

    int wipe_ScreenWipe(int wipeno, ...) {
        static int (*wipes[])(int, int, int) = { ... };
        void V_MarkRect(int, int, int, int);      // <- a declaration, inside a body
        ...
        (*wipes[wipeno*3])(width, height, ticks);
        V_MarkRect(0, 0, width, height);

The crash was `call through a non-function pointer 0x0` inside `wipe_ScreenWipe`, which points
straight at that dispatch table — and the table was **perfectly correct**, six valid pointers, as
reading the linked image showed. The null was `V_MarkRect`: PRISM's handling of a block-scope
declaration was gated on `storage === 'extern'`, and **a function declaration needs no keyword** to be
external. So it created a local variable holding zero, and the next line called through it.

The lesson is about where to look, not about the fix. Three minimal reproductions of the *table* all
passed — function-pointer arrays at file scope, with implied size, as a `static` local — because the
table was never the problem. What settled it was dumping the symbol out of the linked image and then
reading the emitted JavaScript, where `M.icall(_v_V_MarkRect, ...)` sits two lines below
`var _v_V_MarkRect=0`.

Still open: starting a real level (`-warp 1 1`) now gets further and then loops in pure guest C, where
the runtime-call profiler is blind by construction — no runtime calls, nothing to count.

### Safepoints: making a loop in pure guest C observable

Doom started E1M1 for real — `gamestate = GS_LEVEL`, the renderer running — produced frames 5, 10,
15, 20, 25 all inside a tenth of a second, and then stopped. **Stalled, not slow**, which took a
per-frame progress line to establish; a final report cannot tell those apart, and several rounds went
by on an unmeasured "Doom is slow".

Two false trails, both mine, kept because they are the shape of the mistake rather than its detail:

* **"It must be the BigInt fixed-point maths."** `FixedMul` is `((long long)a * (long long)b) >> 16`
  and `long long` is a BigInt in tier-0, so this looked obvious. Measured: the three primitives are
  **45% of a 1 ms frame** — thousands of calls, not millions.
* **A Heisenbug.** Wrapping every function-table entry with a counter made 40 frames complete;
  without it they never arrived. Rebinding the same entries without wrapping changed nothing.

What was missing was not an idea but an **instrument**. Two profilers existed — one counting runtime
services, one counting cross-unit calls — and a program spinning inside one C function is making
neither kind of call, so both see a program doing nothing at all. The only place the host can regain
control is the loop itself, which is what MIRAGE concluded when it studied the same problem: a
safepoint **in** the emitted code, not a re-translation.

`compileProgram(units, { safepoints: true })` emits, on every loop back edge,

    if(--M.spBudget<0)M.sp_(ID);

where ID indexes `mod.safepoints`, a table naming the function and the loop. The default handler just
refills the budget. A harness replaces `M.sp_` to sample. It is off by default and it is not free —
a decrement and a compare per iteration of every loop — and the same mechanism is what would let a
Stop button interrupt a `while (1);` in the browser, which nothing can do today.

It named the culprit on the first run:

          7781820000 iterations  wipe_doMelt#72        <- the `for (i=0;i<width;i++)`
            48640000 iterations  wipe_doMelt#73        <- the `while (ticks--)`
              600000 iterations  R_InitTextureMapping#353

The ratio between the two hot entries is exactly 160, which is `width/2` — one outer tick per 160
inner iterations, and the outer loop running 48 million times for a `ticks` that should be 1. Doom's
melting screen wipe, which is also what the eye had already reported as "un blink bizarre".

### The zero that was not a date

Reading `y[]` out of guest memory from **inside** the stalled loop — via the safepoint handler, so
that nothing hot is wrapped and the Heisenbug is not disturbed — showed all 160 columns at 200, the
screen height. The melt was **finished**. It was `while (ticks--)` on a negative `ticks`, counting
down through the whole `int` range.

`ticks` comes from `tics = nowtime - wipestart` in `D_Display`, off `I_GetTime`:

    static int basetime = 0;
    gettimeofday(&tp, &tzp);
    if (!basetime) basetime = tp.tv_sec;
    newtics = (tp.tv_sec-basetime)*TICRATE + tp.tv_usec*TICRATE/1000000;

PRISM's deterministic `gettimeofday` started at **zero**. So `tv_sec` was 0 for the first 35 calls,
`if (!basetime)` never fired, and on the 36th call `basetime` finally took a value — at which point
`I_GetTime` jumped **backwards** by 35 tics. One negative subtraction later, four billion iterations.

The fix is one constant: a `struct timeval` counts from 1970, so `tv_sec` is large on the very first
call a program ever makes, and programs rely on that without saying so. `EPOCH_US` now sets the
origin to 1997-02-05 for both the deterministic clock and `installRealClock`. Deterministic, so every
gate gets the same answer as before; nonzero, so the guard fires when a real system would fire it.

The general lesson, and the reason this is in TESTING rather than in a commit message: **a plausible
default is not a faithful one.** Zero is the obvious starting value for a counter and the wrong one
for a clock, and nothing short of a program that reads the clock would ever have shown it.

Doom now runs E1M1 at 260 frames of about 1 ms each, `gametic` 1096, status bar and all.

### Looking at the emitted JavaScript

The claim that the emitted code is readable is only worth something if it is easy to check:

```
node tools/dump.mjs file.c                 the whole unit
node tools/dump.mjs file.c --fn=main       one function
node tools/dump.mjs file.c --safepoints    with the loop back-edge checks
node tools/doom.mjs --fn=R_DrawColumn      one function out of a 62-unit program
```

For a real program the per-function view is the usable one: Doom is 1.11 MB of JavaScript.


### P1.7: deleting the hand-written backend, and the loop it exposed

MAME now compiles `src/msdos/msdos.c`, its own DOS platform backend, and `src/env/osd.js` is gone.
The check that this changed nothing is the number `--test-rom` prints: **3584 non-zero pixels**, the
224x16 band the hand-written Z80 program draws, identical through the tweaked VGA mode and through
`-vesa` at 640x480.

Two things went wrong, and both are the same mistake in different clothes — assuming an ending.

* **The VESA path never presented a frame.** `_dosmemputl` writes one scanline at a time, so the
  frame boundary is the LAST one; I looked for a write reaching the bottom of the 640x480
  framebuffer. msdos.c centres a 288-line bitmap in 480 lines, so its last write is to line 383 and
  the bottom is never touched. Counting scanlines against the game's own `bitmap->height` is what
  actually ends a frame. Symptom: `--frames=10` ran for ever, because the cap is counted in frames.
* **`while (osd_key_pressed(k));` cannot be seen from outside.** With osd.js, `osd_key_pressed` was a
  JavaScript function and spin damping parked it. It is now MAME's own C reading `key[]` out of
  memory: no call, no service, nothing to count, and the array would never change because only the
  host writes it. The safepoint from the previous section is what breaks it — and that is not a
  workaround. On a real DOS machine that array is written by a keyboard INTERRUPT, and a safepoint is
  the only place this runtime can be interrupted at all. Enabled per program: the browser descriptor
  carries `"safepoints": true`, Doom's does not.

### Open: the audio-device prompt blocks headless

Without `-nosound`, `osd_init` prints the SEAL device list and calls `scanf("%d",&i)`. Headless, that
never returns an answer and the tool hangs; `tools/mame.mjs` therefore passes `-nosound -nojoy` by
default, which are msdos.c's own switches and not a modification. In the browser it is not a problem
— the console reads a real keystroke — but the headless path should answer rather than hang.


## Sound

Three targets, three different libraries, and the shape of each platform layer was decided by the
program rather than by the host — which is the same finding as pixels, one dimension down.

```
node tools/gate-sound.mjs --wav=/tmp/probe.wav     # MAME's SEAL path, against a known waveform
node tools/mame.mjs --run --test-rom --wav=/tmp/pac.wav
node tools/sndserv.mjs --data=<dir with DOOM1.WAD> --wav=/tmp/sfx.wav
```

### It leaves the guest the way pixels do

An audio ring in the control block (`src/env/webhost.js`), 16384 signed 16-bit samples, with
monotonic write and read cursors. The page's `web/audio-worklet.js` reads it on the audio thread,
where a blocked main thread cannot make it stutter, and publishes back what it has consumed.

The reason is the one that shaped the whole host: a C program's sound library is called from inside a
main loop that never yields, so there is no moment at which the guest could hand a buffer to anybody.
It writes; the page reads.

Two details that are not optional. The worklet **resamples**: a guest picks its rate from its own
source — `#define SAMPLE_RATE 44100` in msdos.c, `#define SAMPLERATE 11025` in Doom — and the device
picks its own, usually 48000. Playing 44100 at 48000 without a step is everything 9% sharp, which is
very easy to mistake for the emulation running fast. And an underrun **decays the last frame** rather
than dropping to zero, because a jump to silence and back is a click.

### MAME: SEAL, where the library owns the mixing

`src/env/allegro.js` implements a four-voice mixer, because SEAL is the mixer — msdos.c only hands it
waveforms, frequencies and volumes. The hard part was not the mixing:

    for(;;) { AGetVoicePosition(hVoice[channel],&pos);
              if (c == 1 && (pos < len || pos > 2*len)) break;
              osd_update_audio(); }

`osd_play_streamed_sample` **blocks** on the play cursor — a triple-buffered stream waiting for the
DAC to leave the third it is about to overwrite. On real hardware that cursor moves because DMA runs
in real time and AUpdateAudio only refills. A shim whose position never moves hangs MAME on its first
streamed sample. So the play cursor advances with TIME here too: the browser's real clock in the
browser, and one frame of sound per call headless.

Headless it is deliberately **not** read from `clock()`. MAME throttles its frames on that counter,
and advancing it from the audio path would change the emulation being measured. An audio clock must
not be the game's clock.

`tools/gate-sound.mjs` checks the whole path — MAME's own `osd_play_sample`, through SEAL, into the
ring — against an expectation computed independently from SEAL's documented contract: 8-bit unsigned
centred on 128, volume 0..64, the cursor advancing freq/rate per output sample. Sample-exact. It has
to be a gate of its own because only two of MAME 0.1's five drivers have sound at all (pengo and
ladybug), so no amount of running Pac-Man would have exercised a line of it.

### Doom: /dev/dsp, where the program owns the mixing

`src/env/dsp.js` is the cheapest audio path in the project, and the contrast with SEAL is the point.
Doom mixes for itself — `I_UpdateSound` fills `signed short mixbuffer[]` at its own volumes and
stereo separation — and then submits it in one line:

    write(audio_fd, mixbuffer, SAMPLECOUNT*BUFMUL);

So there is no mixer to write. The device accepts bytes, answers six ioctls, and publishes. The one
subtlety is that an OSS ioctl takes a POINTER and the driver writes back the value it actually
granted; a program that asked for 44100 on a card that could only do 22050 is expected to notice.

`linux/soundcard.h` had every constant defined as **0** while it was a stub, which meant every ioctl
looked like every other one. They are distinct now, and PRISM supplies both the header and the
driver, so they are one thing in two places.

### Open: Doom's sound needs a second process

`linuxdoom-1.10/doomdef.h` line 84:

    #define SNDSERV  1

The Doom id published does not play sound itself. It starts a separate program —
`popen("./sndserver ", "w")` — and writes it one ASCII line per effect. That program is
`corpus/DOOM/sndserv/`, 2,026 lines, and IT is what opens /dev/dsp, reads the WAD and mixes.

It compiles and it works. `tools/sndserv.mjs` runs it alone, feeding it on stdin the exact bytes
Doom would have sent, and it produces 2.79 s of 16-bit stereo at 11025 Hz, peak 24576 — Doom's own
sound effect, mixed by Doom's own mixer, compiled unmodified.

What is missing is not audio, it is a **process model**: two address spaces and a scheduler. Working
around it would mean either defining away SNDSERV (a source modification) or writing Doom's mixer in
JavaScript (the thing this project exists not to do). Recorded in docs/ROADMAP.md as what it is.

Two compiler gaps fell out of compiling the server, both ordinary C89 that nothing else had needed:

* **`extern int errno;` at block scope, with no `#include <errno.h>` anywhere.** errno is an object
  in libc, not in a header, and a C89 program may declare it itself. It resolved to nothing and took
  out `myioctl`, the one function every ioctl goes through. PRISM's link step now defines it the way
  libc does.
* **`select()` on stdin.** The server's loop is a zero-timeout select on fd 0, which is what makes it
  cooperative rather than blocking. Implemented for fd 0, never blocking, and the timeout is ignored
  rather than honoured — there is one thread inside the guest, so a wait here would be a deadlock and
  not a wait. Every caller so far polls.


## The Csmith differential (P0.7)

```
node tools/csmith-diff.mjs 100            # 100 random programs against gcc -O0/-O2
node tools/csmith-diff.mjs --seed=3 --keep
```

Every other gate here is a corpus somebody wrote, and a corpus somebody wrote is finite in a shape a
person imagined. Csmith generates C at random -- a couple of thousand lines each, full of the integer
promotions, bitfield packing, type punning and struct-by-value passing that real code does by
accident -- and every program ends by printing a CRC over its whole global state. Two compilers that
agree on that number agree about everything the program touched.

**A divergence is not automatically a PRISM bug.** The first thing the tool checks is whether gcc
agrees with ITSELF at -O0 and -O2. A program where it does not is thrown out before PRISM sees it:
that is undefined behaviour csmith let through, or a gcc bug, and neither is evidence about PRISM.

### Reducing a divergence without a reducer

`creduce` is not installed and did not turn out to be needed. Three techniques, in the order they got
used on the first wrong answer:

1. **The per-variable CRC.** Run the program with argv `1` and csmith prints the running checksum
   after *every* global. The CRC is cumulative, so only the FIRST differing line matters -- the other
   332 were downstream. One variable, `g_76`, out of 378.
2. **Inverting the CRC.** The checksum before `g_76` matched, so the state going in was known.
   Brute-forcing all 256 values of an `int8_t` through csmith's own `transparent_crc` -- in the
   container, using csmith's code rather than a reimplementation -- says what each side actually
   held: gcc 0, PRISM 1.
3. **The block-path diff.** Csmith writes `/* block id: N */` on every basic block it emits. Adding
   `printf("B%d\n", N)` at each one, in the SAME modified program given to both compilers, turns
   execution into a comparable trace. First divergence: step 13 of 73, gcc entering block 156 where
   PRISM went to 161.

That is a printf-bisect between two compilers, and it took the search from 1,608 lines to one `if`.

### What it found in the first forty programs

Six defects, none of which 1,775 hand-written corpus programs and four game targets had reached:

* **An integer constant's type ignored its base.** C99 6.4.4.1 gives each constant the first type in
  a list that can represent it, and the list depends on the suffix *and* on whether the constant was
  written in decimal: a hexadecimal constant may become unsigned, a decimal one may not. So
  `0xAD2A1758533D8CC8LL` is larger than LLONG_MAX and is therefore an **unsigned** long long, which
  makes it positive. PRISM read it as a negative long long, `1UL < 0xAD2A1758533D8CC8LL` went the
  wrong way, a branch was skipped and one global ended the run holding 1 instead of 0. **This was the
  wrong answer.** The others below are refusals, which are loud; this one was silent.
* **`#pragma pack` did nothing.** The preprocessor passed pragmas through, as gcc -E does, and the
  parser then met a `#` it had no rule for. Implemented for real rather than skipped, because packing
  changes struct layout, which is the ABI: `pack(1)`, `pack(2)`, `push` and `pop` all match gcc.
* **Bitfields could not straddle a 32-bit unit.** The whole implementation assumed a field lived
  inside one word, which is true of every ordinary struct and false the moment `#pragma pack(1)`
  removes the alignment that guaranteed it. Now byte-wise: at most five bytes for a 32-bit field,
  assembled with multiplication because a JS shift is 32-bit and five bytes is 40.
* **`stdint.h` had no 64-bit half.** No `int64_t`, no `INT64_MAX`. Invisible to every hand-written
  test and all four games, which use `long long` directly; csmith names `int64_t` in its first
  hundred lines.
* **C99 hexadecimal floating constants.** `0x1.0p-100f` is 2^-100 exactly, which is why csmith's
  safe_math.h uses them for float overflow tests. PRISM's lexer had no rule, and the failure mode was
  the bad kind: `parseFloat` returns 0 for one rather than refusing.
* **The float math family.** `fabsf` and its fifteen siblings, declared as taking and returning
  `float` rather than double -- not cosmetic, since PRISM rounds a float store with `Math.fround` and
  a builtin declared in double would keep the extra precision through the call.
* **A record rvalue through a dereference.** `*p` on a struct or union pointer went down the scalar
  load path. The rule that a record rvalue IS its address was already applied at the two sibling
  sites and missing here.


### The refusals csmith left behind, and one that was a trap

Two causes accounted for every remaining PRISM failure in the first forty programs.

**Compound assignment to a bitfield** was refused outright. It is a read, an operation in the
*promoted* type, and a store back, and the promotion is the part that makes a bitfield different:
`unsigned f:3` promotes to `int`, so `f -= 1` on a zero field computes -1 in int and truncates to 7,
never to a three-bit borrow. `bitfieldPromoted` already encoded that rule, so the arithmetic just had
to happen there.

**`'comma' is not an lvalue`** looked like the two GNU extensions `(a, b) = x` and `(a = b) = c`, and
implementing those would have been wrong: gcc removed them years ago and **gcc 12 rejects both**, so
PRISM would have started accepting programs the reference refuses — a divergence in the one direction
no gate looks at. Checking with the oracle before implementing is what caught it.

What csmith actually writes is `(a, s).f` and `(s = t).f` on RECORDS, which is ordinary C. Neither
result is an lvalue; tier-0 simply needs an address for a record, for exactly the reason the
struct-valued `?:` beside it needed one. Restricted to records, it stays a tier-0 implementation
detail rather than a dialect — and the scalar forms are still refused, as gcc refuses them.


### The perf number no longer needs a ROM, and a lead on where the time goes

`tools/bench.mjs --synthetic` runs a Z80 program written in the tool instead of a game ROM. The
headline performance figure used to require copyrighted data, which meant it could not be reproduced
on a fresh clone -- and a gate nobody else can run is a claim, not a measurement. The synthetic
program is chosen to exercise what a real ROM exercises (memory read and write, 8- and 16-bit ALU
with flags, a taken branch, a call and a return), and both sides still print the same checksum, so
they demonstrably did identical work.

It is **not** comparable to the 9.5x measured on Pac-Man, and is published separately rather than
blended: same algorithm, different instruction mix.

```
4 M steps:  clang -O2 115.6 M instr/s · PRISM 5.2 M instr/s   → 22.2x
8 M steps:  ...                                               → 12.5x
```

That spread is itself information: half the gap at 4 M steps is JIT warm-up, not steady-state cost.
Any future claim about tier-1 has to be made at a workload long enough for that to have amortised.

**The V8 profiler is blind here**, and for the same structural reason both earlier profilers were:
the emitted code lives in an `eval`, so 98.3% of ticks are unattributed. What IS visible is
suggestive rather than conclusive, and worth recording as a lead rather than acted on: the largest
accounted entry is `Builtin: LoadIC` at 157 ticks -- more than `Z80_Execute` itself at 73. Every
cross-function call in the emitted code is `F["name"]` on an object with a thousand-odd properties,
which is a dictionary lookup, and there are 1,357 such sites in 516 kB of output.

If that is the cost, it is cheap to remove and needs no IR. But it also collides with something real:
every harness in `tools/` rebinds `prog.F` to instrument a program, and direct calls would make that
rebinding invisible. Measure before choosing -- the lesson of MIRAGE's three rejected memory-dispatch
strategies is that a plausible optimisation built without a number is a plausible optimisation
reverted.

**Measured.** `bench.mjs --synthetic --direct-calls` emits a call to the emitted function's own
identifier instead of `F["name"]`, for callees defined in the program:

```
F["name"]      7.16 · 7.02 · 6.29 M instr/s
direct call   17.36 · 16.98 · 12.79 M instr/s
```

Roughly **2 to 2.5x**, on identical checksums, from a change that touches one line of the emitter.
Against clang -O2 the gap goes from about 10x to about 5x. The lead was right, and the profiler's
one visible entry was worth more than the 98% it could not see.

It is still off by default, because the observability cost is real and there is a design that avoids
paying it: emit a module-scope `let` per function, initialised from the function, and have calls go
through that binding. A module-scope `let` is a monomorphic slot rather than a dictionary property,
so it should keep most of the speed, and a `rebind` on the module can reassign it -- which restores
exactly what the harnesses use `prog.F` for. Not built yet; recorded so the next person does not
re-derive it.


### Three Watcom accommodations, and the one I declined to make

Heretic and Hexen are Watcom C, and three constructs stood between PRISM and 118,000 lines of it.
Each is recorded here because the *restraint* is the interesting part.

**`__far`, `__near`, `__interrupt` as declaration specifiers.** Accepted and ignored, and that is
correct *only* because these games target the 32-bit flat model: with one segment, `__far` describes
nothing. They are emphatically not no-ops in a segmented program — Wolfenstein 3D uses `far` 451
times and means it — so this is a parser allowance, never an ABI claim. `__interrupt` really does
change a calling convention (save every register, return with IRET); ignoring it is safe only while
nothing installs such a function as a real handler, which nothing can, because PRISM has no interrupt
to deliver.

**The same keywords INSIDE a declarator.** Watcom puts them before the star:

    void (__interrupt __far *oldkeyboardisr)();          // Heretic, I_IBM.C:1282

Standard C has no place for a qualifier there. Two changes, and the second was the one that mattered:
skipping them in `#declarator`, and teaching `#parenIsParamList` that a Watcom keyword after `(` does
**not** start a parameter list. Without the second, the paren was read as a parameter list precisely
*because* the first change had made them keywords, and the error moved to the `(` — a fix creating a
worse symptom than the bug.

**Bare `far` / `near` — declined as keywords.** `int (far *function)();` appears once in 47,000
lines. Making `far` and `near` keywords everywhere would break any program with a variable of that
name, for one construct. Recognised only where nothing else can be meant: inside a declarator,
immediately before a star. A dialect is a cost paid by every future program, so it should be bought
one construct at a time.


### Brace elision, and a rewrite that had to be undone

Heretic writes its tables the way most C does:

    struct { mobjtype_t type; int speed[2]; } MonsterMissileInfo[] = {
        { MT_IMPBALL, 10, 20 },        // speed[] takes the 10 and the 20, with no braces of its own

That is brace elision (C89 6.7.8p17), and tier-0 refused it: the bare `10` was handed to `int[2]`.

**The first attempt rewrote `#staticList` as a clean stream** — items consumed by whoever needs
them, no one-to-one matching. It was shorter, it read better, and it broke three things the
one-to-one version had right, all of which the c-testsuite gate caught as **wrong answers where
there had been none**: designators that go backwards (`{ .b = 2, .a = 1 }` lost the `.a`, because the
loop was bounded by the member cursor), array designators with holes, and flattened anonymous unions.

Worse than any single break: two programs went from *refused* to *compiled and wrong*. A loud failure
became a silent one, which is the only direction that actually matters.

So the rewrite was thrown away and elision was grafted onto the proven walk instead — one extra
branch, taken only when an aggregate member meets a non-braced item. The lesson is not "do not
refactor": it is that a rewrite of code whose correctness lives in its edge cases must be measured
against those edge cases before it is believed, and the cheapest way to be wrong is to find the new
version more elegant.

Two further defects fell out of it, both only visible once elision made the programs compile:

* **`sizeof(a->c)` where `a` is an array.** `->` decays its left operand, and PRISM did not — so the
  field was never found and the member's type silently became `int`. `sizeof(cases->c)` answered 4
  instead of 32, and a loop over a four-element array ran once.
* **The array's LENGTH ignored elision.** `initListExtent` counted top-level items, so ten
  seven-field structs written as seventy bare scalars became a 63-element array. The contents were
  byte-identical to gcc and the program still printed 505 lines to gcc's 72. The counter and
  `#elidable` now make the same syntactic decisions and say so in both files: two walkers, one rule.

c-testsuite: 199 → **201 of 219, still zero wrong answers.**


### Heretic and Hexen: reading the makefile, and two options that change the program

```
node tools/raven.mjs --game=heretic
node tools/raven.mjs --game=hexen --run --data=<dir with the WAD>
```

The unit list comes from each game's own **makefile**, not from a directory listing, and that is not
tidiness. Both trees carry dead files — `NETOLD.C`, `OLDD_NET.C`, `G_OLD.C` — that no build has
compiled since 1995 and that do not compile at all. Reading the makefile is the difference between
"the program does not build" and "a backup file does not build", and the first report was the second
thing.

It also has to read the whole file, not just the `LOCOBJS`/`GLOBOBJS` variables, because Heretic's
link rule is

    tic.exe : $(LOCOBJS) $(GLOBOBJS) i_ibm.obj

and `i_ibm.obj` — the one file holding every machine dependency, and `main` — is named nowhere else.
Missing it produced 47 "undeclared identifier" failures that looked like a header problem.

Two options in `CCOPTS` change the program and are honoured:

* **`/zp1`**, pack structures on byte boundaries. Every struct in the program changes size, so
  nothing read out of a WAD lands in the right field without it. `compileProgram` takes a `pack`
  option that seeds the same state `#pragma pack` sets — a compiler option, not a source edit, the
  same standing as MAME's missing `-DX86_ASM`.
* **`/ei`**, enums are int, which is already PRISM's model.

### What a DOS platform actually costs

`I_IBM.C` is 2,204 lines and the roadmap expected it to need VGA register emulation and interrupt
delivery. Measured first, as with Wolf3D, and both expectations were wrong in the same direction:

    int386(0x10, ax=0x13);                       // set mode 13h
    pcscreen = destscreen = (byte *)0xa0000;     // ...and then write to a FLAT pointer

Mode 13h is a linear framebuffer at an address PRISM already has, because the low megabyte is part
of the image. Everything the game draws is an ordinary store. The whole external surface is:
`int386`/`int386x`/`segread` over a `union REGS`, the interrupt vector table, two DPMI calls
(memory info and allocate), the `graph.h` banner, and DMX for sound — plus four ports, of which
0x3DA (retrace) and 0x201 (joystick) are reads and the rest are page-flip plumbing for a mode this
host does not emulate.

`union REGS` is the piece worth care: Watcom's is three views of the SAME sixteen bytes (`x.eax`,
`w.ax`, `h.al`), and I_IBM.C uses all three on one variable in consecutive statements. The header and
the shim read the same offsets from opposite sides.

**And the interrupt is deliverable.** `_dos_setvect(9, isr)` hands over a function pointer, and PRISM
can call it — `I_KeyboardISR` then reads port 0x60 and fills the game's own ring buffer, running its
own code. That is the mechanism, wired but not yet driven.

Four small libc gaps fell out, all found by compiling rather than by guessing: `strtol`/`strtoul`
(with `endptr`, without which a parse loop never advances), `strnicmp`, `strupr`, and `FP_OFF`/
`FP_SEG` as flat-model identities.


### Two libc bugs Hexen found, and why gcc beat the standard

Hexen would not start, and neither cause was in the game.

**`scanf` had no scansets.** `%[^\n]`, `%[a-z]`, `%[]x]` — Hexen's `SC_MAN.C` reads its scripts with
them. Three rules that formats really use and that are easy to get wrong: a leading `^` negates, a
`]` in the FIRST position is a literal rather than the end, and `a-z` is a range unless the `-` is
first or last. `%c` came with it, and both share the property that separates them from every other
conversion: **they do not skip leading whitespace**, because they are the two that can match it.

Fixing them exposed an older one. A single permissive character set served every numeric conversion,
so `%d` accepted hex digits: `sscanf("abc123def", "%[^0-9]%d%[a-z]")` read `123def` as its integer
and the third conversion found nothing left. Each conversion now has its own set.

**`strtol` mis-read a lone zero.** With base 0 it consumed the leading `0` as an octal PREFIX and
then looked for digits, found none, and reported no conversion — leaving `endptr` at the start, which
is exactly the check every caller makes:

    sc_Number = strtol(sc_String, &stopper, 0);
    if (*stopper != 0) I_Error("SC_GetNumber: Bad numeric constant \"%s\"", sc_String);

Hexen refused its own SNDINFO script at the first zero. The zero is never consumed as a prefix now;
base 8 is selected and the digit loop takes it. `"0x"` with no hex digit after it is likewise the
number 0 with `endptr` at the `x`.

**And one place the standard was the wrong reference.** C99 says a `%c` that reads fewer characters
than its field width is a matching failure. glibc assigns what it got: `sscanf("abc", "%2s%2c", a, c)`
returns 2, not 1. PRISM followed the standard and disagreed with the oracle — and the oracle is what
every gate here compares against, so the oracle wins. Ten `strtol` cases and six `sscanf` cases now
match gcc exactly, character for character.


### The third device, and why the keyboard is not a device problem

```
node tools/raven.mjs --game=heretic --run --safepoints --tick=1 --budget=5000 \
     --keys=esc,down,down,enter --data=<dir with the WAD>
```

`src/env/kbd8042.js` is ports 0x60 and 0x64 and about forty lines, because almost nothing about a
DOS keyboard happens in the controller. The game installs an interrupt handler and the handler reads
one byte:

    void __interrupt I_KeyboardISR (void) {                     // Heretic, I_IBM.C
        keyboardque[kbdhead & (KBDQUESIZE-1)] = lastpress = _inbyte(0x60);
        kbdhead++;
        _outbyte(0x20, 0x20);
    }

So the host's job is two halves that must meet: put a code where 0x60 will read it, and CALL the
handler. Either alone is silent — a code with no interrupt is never read, an interrupt with no code
makes the game read the previous one again — which is why `deliverKeyboard` does both and neither is
exposed separately.

Two decisions worth naming. An empty queue returns the LAST code rather than zero, because a real
controller holds its output buffer and 0 is a meaningful set-1 code (overrun) that some handlers act
on: inventing one is worse than repeating the truth. And a keypress is TWO interrupts, the code and
the code with bit 7 set, because that is what the hardware sends and what the game's release
detection needs.

PRISM never touches `keyboardque`. Escape opens the menu, Down/Down/Enter reaches the load/save
submenu, and every one of those transitions happened inside the game's own code.


### A task retracted rather than done: P0.3b

The preprocessor expands macros by rewriting its work list in place with `splice()`, which is
quadratic when a macro grows the list. The roadmap entry said so — and also said **do not start this
before measuring it**, because the premise was an asymptotic argument with no number attached.

Measured, by counting the elements every splice actually moves and timing them:

```
Doom      62 units ·  587k tokens · 721 ms total ·  2 ms in splice (0.3%) ·  14.1M moved,  24x tokens
Hexen     56 units · 1203k tokens · 613 ms total · 49 ms in splice (8.0%) · 133.6M moved, 111x tokens
Heretic   48 units ·  701k tokens · 319 ms total ·  4 ms in splice (1.1%) ·  28.3M moved,  40x tokens
```

The quadratic behaviour is real and it scales exactly as predicted — 111x the token count on the
largest tree. And it does not matter: `splice` on a contiguous array is a memmove, and moving 133
million pointers costs 49 ms. Preprocessing is about 0.6 s of a 2.2 s build, so the whole opportunity
is under 1% of a build.

Retracted. The value here is not the millisecond saved by not doing it; it is that an asymptotic
argument with no constant factor attached is a hypothesis, and this is the second time in this
project one has evaporated on contact with a measurement (the first was MIRAGE's D6). The instinct
to fix a known-quadratic loop is strong enough that the entry had to warn its own author.


## The cpp gate on whole files (P0.3c)

```
node tools/gate-cpp-files.mjs [--limit=N] [--verbose] [filter]
```

**287 of 287 whole translation units from five programs match `gcc -E` token for token.** Doom,
Heretic, Hexen, MAME 0.1 and Quake — real units, real include paths, thousands of macros deep.

`tools/gate-cpp.mjs` compares self-contained snippets on purpose: it tests the preprocessor and
nothing else. This tests it on what it is actually asked to do, and the whole difficulty is making
the comparison mean anything, which comes down to one thing: **gcc must be given PRISM's headers, not
its own.** Otherwise the diff is glibc's `stdio.h` against PRISM's and says nothing. So the headers
are written to disk, gcc runs with `-nostdinc` and `-undef`, and PRISM's TARGET_DEFINES are handed to
it as a prelude header — both sides then start from the same text and the same macro table, and every
difference left is a preprocessing difference.

### What it found on its first run

**`__FILE__` and `__LINE__` inside a macro reported the DEFINITION site, not the expansion site.**

    #define WHERE() __FILE__, __LINE__      // in h.h
    ...
    use(WHERE());                           // in m.c, line 3

gcc says `"m.c", 3`. PRISM said `"h.h", 1`. Every `LOG(...)`, `assert(...)` or `I_Error(...)` macro
that lives in a header — which is all of them — named the wrong place. The fix is one clause: a
macro's replacement tokens take the INVOCATION's location, which is what gcc does and what also makes
an error inside an expansion point at the line the user wrote.

### Three harness bugs, each of which looked like a result

Worth recording because each produced a plausible-looking number that was wrong:

* **`.C` in upper case is C++ to gcc.** Heretic and Hexen name their sources that way, so every one of
  their units was "skipped: gcc refused them" with a puzzling `cannot execute cc1plus`. `-x c` took
  the pass rate from 20/20 with 16 skipped to 36/36 with none.
* **A missing newline swallowed a case.** gcc's output does not always end in one, so the `===RC`
  marker glued itself to the last line, the regex missed it, and the case vanished as "no oracle
  output" — which reads like a missing result rather than a harness bug.
* **A skipped case is not a passing case.** Half the corpus was unusable because gcc refuses a unit
  outright when a header is missing, where PRISM stubs it empty. Writing the same empty file where
  gcc will find it makes both sides read the same nothing; 33 headers are stubbed that way, and they
  are listed on every run rather than counted.

The rule underneath all three: a gate that reports 20/20 while quietly discarding 16 cases is
reporting the harness, not the compiler.


## Two processes (P1.8)

```
node tools/doomsnd.mjs --data=<dir with DOOM1.WAD> --inject=1a,20,7f,80 --wav=/tmp/doom.wav
```

Doom runs in this thread, `corpus/DOOM/sndserv/` runs in a worker, and they are connected by
`src/env/pipe.js`. Neither program is modified and neither is interleaved.

**A worker rather than a coroutine, because neither `main` ever returns.** Doom spins in
`D_DoomLoop`, the server in `while (!done)`. Interleaving them would mean calling their internals
instead of running them — writing the part of the program that decides what to do next — which is the
one thing this project does not do. Two threads and a shared ring cost nothing conceptually and the
programs stay whole.

Two details of the pipe come straight from the two programs. It carries **bytes, not messages**: the
writer is `fprintf(sndserver, "p%2.2x%2.2x%2.2x%2.2x\n", …)` and the reader is `read(0, buf, 1)` then
`read(0, buf, 9)`, and neither knows where the other's writes ended. And `pending` is separate from
`read` because the reader **polls** — a zero-timeout `select` on fd 0 must be able to ask without
consuming.

`popen` does not start anything. The caller has already started the other program; `popen` matches a
command line to it and returns a FILE* whose writes go into the pipe. It also answers the check Doom
makes first:

    if (!access(buffer, X_OK)) { strcat(buffer, " -quiet"); sndserver = popen(buffer, "w"); }
    else fprintf(stderr, "Could not start sound server [%s]\n", buffer);

Without that, the else branch ran and the pipe was never created — a silent, correct-looking "no
sound server" for a host that had one running in another thread.

### The missing piece was a clock

With everything connected the result was still silence, and the counters said why: **400,000 samples
dropped in four hundred submits.** A game has a clock — it throttles itself to its own frame rate —
and a sound server has none. It free-ran at whatever speed the host could manage, filled the ring
instantly, and everything after the first 16k samples was thrown away, the sound effect among it.

So `installDsp` gained `blockWhenFull`, and it is not a workaround: `write()` to a real `/dev/dsp`
blocks until the card has room. **The DAC is what paces a sound server.** Supplying that pacing is
supplying the clock the program was written to run on. Dropping remains the default, because for a
game it is right — a program that cannot keep up should sound rough, not run rough.

With it: peak 24576, nothing dropped, and the effect audible in the WAV.

### Isolating the halves

Getting there needed `--inject`, which writes one command straight into the pipe in Doom's own
format. It separates "the pipe and the second process work" from "Doom asked for a sound", and those
two failures look identical from a silent WAV. They were tested together at first, and the silence
was read as a broken pipe for two rounds.

What is still missing is only the trigger: with `-warp 1 1` and no input Doom stands still, and the
shareware WAD's demos will not play (`Demo is from a different game version!`).


### Quake times itself: 694 fps

```
node tools/quake.mjs --dos --run --data=<dir> --args="-mem 16 +timedemo demo1" \
     --frames=1400 --keys=space --png=/tmp/q.png
```

`969 FRAMES  1.4 SECONDS  694.2 FPS`, printed by Quake on its own console.

The number could not exist before the DOS build. `sys_null.c`'s `Sys_FloatTime` returns `t += 0.1` —
a counter, not a clock — so everything the program measured about itself, timedemo included, was
fiction, and only a wall clock outside it meant anything. `sys_dos.c` reads a real PIT, so this is
Quake's own measurement of Quake.

Two things about getting it, both of which cost a run:

* **Quake waits for a keypress at start-up** (`Press a key.` under the MSCDEX notice), so a
  `+timedemo` on the command line sits behind it. One `space` through the game's own TrapKey moves
  it along.
* **The result is on the CONSOLE, not on stdout.** `Con_Printf` draws to the framebuffer. Grepping
  the log for "fps" found nothing twice while the answer was sitting in the PNG.

It is also the second real workload for P2.1, and the first that is a whole game rather than a CPU
core: optimising against one workload is the surest way to optimise *that workload*.

### Any target, from its JSON alone

```
node tools/build.mjs --list
node tools/build.mjs quake.json:dos
node tools/build.mjs heretic.json --run --data=<dir>
```

The check that made this trustworthy was not that it builds, it is that it builds the SAME thing:

| target | hand-written harness | `tools/build.mjs` |
|---|---|---|
| quake:dos | 77 units, 51,391 lines, 1169 fns, 2 headers stubbed | identical |
| heretic | 44 + 1 units, 43,394 lines, 761 fns | identical |
| mame01 | 19 units, 6,859 lines, 913 fns | identical |
| doom | 715 fns | identical |

A target describes the BUILD and the ENVIRONMENT. It does not describe instrumentation — Quake's
frame cap and key script, Doom's fire trigger, the audio drain wrap the program's own functions to
watch it run, and putting those in JSON would be game logic in a config file.

### Quake II compiles

```
node tools/build.mjs quake2.json
```

61 translation units, 49,653 lines, 1121 functions, **nothing unemitted**. It took six libc
additions and one platform variable, and not one compiler change:

* `strdup`, `strncat`, `strtok`, `qsort`, `asin`/`acos`, `putenv`. `qsort` is the only one with any
  depth — the comparator is the GUEST's, so every comparison is an indirect call back into compiled
  code and the elements are bytes in the heap. Sorting an index array and permuting keeps that
  honest; JS's own sort gives no access to the swap.
* `in_joystick`, which `linux/in_linux.c:6` and `win32/in_win.c:55` both define and id's own null
  platform does not.

`C_ONLY` is id's own switch and a cleaner one than Quake 1's: `q_shared.h:42` reads
`#if (defined _M_IX86 || defined __i386__) && !defined C_ONLY`, so defining it selects the portable
C body of every routine with an assembly twin. A build option, not a source edit.

It does not RUN yet, and the reason is worth reading: see ROADMAP P7.3.

### Quake II reaches its own data check

```
node tools/build.mjs quake2.json
```

62 units, 50,194 lines, 1144 functions, nothing unemitted — and it now RUNS to
`Couldn't load pics/colormap.pcx`, which is the right place for a run with no game data. On the way
it prints `Console initialized.`, initialises the network layer, and crosses into
`ref_soft$GetRefAPI`.

Three things had to be true, and each is the program's own statement rather than a decision made
here:

* **Modules.** Quake II is three shared objects, so it is three modules. Each keeps its own external
  namespace and sees the main module's for what it does not define; only what its `.def` file
  EXPORTS travels the other way. `dlopen` turned out to be unnecessary — `null/vid_null.c` is
  titled DIRECT LINK GLUE and calls `GetRefAPI` in process.
* **`linux/net_udp.c`, not a hand-written null layer.** `null/` has no network stub (Quake 1 shipped
  `net_none.c`; Quake II did not), and single player runs on a loopback that lives INSIDE the
  platform file. The loopback path touches no socket, so the program's own file with the OS calls
  stubbed is both the faithful and the shorter answer.
* Two platform variables id's own null platform omits: `in_joystick` and `stdin_active`.

Nothing here is visible without a hook, because `null/sys_null.c`'s `Sys_ConsoleOutput` is empty.
Wrapping `M.rt.vsprintf` shows every message the program formats — which is how the colormap error
was read at all.

### OpenDUNE compiles

```
node tools/build.mjs opendune.json
```

84 units, 46,169 lines, 834 functions, 11 unemitted. It is a REIMPLEMENTATION, so it proves PRISM
handles a large modern-C DOS program — not that it runs unmodified 1990s source the way Quake,
Heretic and MAME do.

Four PRISM gaps surfaced, each small and each worth the trip:

* **`<sys/types.h>` lost to a basename match.** The resolver's basename fallback exists for DOS trees
  that write `sys\types.h`; running it before the standard table made `<sys/types.h>` find OpenDUNE's
  own `include/types.h`, so `ssize_t` was never declared and PRISM's `unistd.h` failed to parse. A
  tree header may shadow a standard one when the program asks for it BY THAT NAME, never by accident
  of its basename.
* **`_loadds` and a bare `far` before an identifier** — `void _loadds far mouse_handler(...)`. PRISM
  already ignored `__loadds` and accepted `far` before a star.
* **A pragma inside a function body**, which the mouse callback opens with. Only file scope knew to
  skip one.
* **`&((c *)8)->m`** — `saveload.h:29`'s hand-rolled offsetof, base 8 to keep a null-dereference
  warning quiet. Refusing it refused every save/load table in the program.

And one regression, caught by the gate and not by reading: skipping pragmas in a body turned
c-testsuite 00206 from a REFUSAL into a WRONG ANSWER, because `#pragma push_macro`/`pop_macro` were
being silently discarded. They are preprocessor pragmas and now never reach the parser — a stack per
macro name, with the operand read from the raw tokens, which is what that test checks by defining
macros called `push_macro` and `pop_macro` first. 201 → **202/219, still zero wrong answers**.

### Quake II's data, and how far it gets on it

The data is id's own freely distributed demo. It is never fetched by a tool here and never enters
the repository — like every other target, it is read from a directory the user names:

```
curl -o q2-314-demo-x86.exe \
  https://ftp.gwdg.de/pub/misc/ftp.idsoftware.com/idstuff/quake2/q2-314-demo-x86.exe
unzip -qo q2-314-demo-x86.exe 'Install/Data/baseq2/*' && mv Install/Data/baseq2 .
```

39,015,499 bytes, sha1 `5b4dedc59ceee306956a3e48a8bdf6dd33bc91ed`. It is a plain zip, and
`baseq2/pak0.pak` is 49,951,322 bytes holding 1106 files.

With it, Quake II gets a long way:

```
> Added packfile ./baseq2/pak0.pak (1106 files)
> execing default.cfg
> Console initialized.
> 768k surface cache
> ref_soft version: SOFT 0.01
> failed to load game DLL
```

The renderer initialises. What stops it is the THIRD module. `null/sys_null.c:37` has
`Sys_GetGameAPI` return NULL, and the demo's own `default.cfg` starts a demo map immediately, so
`SV_DemoMap_f → SV_Map → SV_InitGame → SV_InitGameProgs` wants the game DLL at start-up rather than
only when a map loads.

Unlike the refresh, the game has no direct-link glue anywhere in the tree: `linux/sys_linux.c:196`
dlopens `gamei386.so` and dlsyms `GetGameAPI`. So the `dlopen` that P7.3 turned out not to need for
`ref_soft` is exactly what `game/` does need — over PRISM's own symbol table, where
`game$GetGameAPI` already has an address.

### Quake II initialises and plays its demo

```
node tools/build.mjs quake2.json          # 109 units, 87,098 lines, 2120 functions
```

With `~/quake2/baseq2` as its data it reaches, in its own words:

```
> Added packfile ./baseq2/pak0.pak (1106 files)
> ref_soft version: SOFT 0.01
> ====== Quake2 Initialized ======
> 0.0.0.0:0: client_connect
> Player\male/grunt
> demos/q2demo1.dm2
> Installation
```

Three modules, each with its own namespace, bridged exactly where the program bridges them: the
refresh through `GetRefAPI` (direct-link glue), the game through `dlopen`/`dlsym`.

`src/env/dl.js` is the piece that made the game reachable, and it loads nothing — everything is
already linked. `dlopen` names a module and `dlsym` returns the address of the linkage name pass 1
gave it, `game$GetGameAPI`. The soname it matches on is `gamei386.so`, which the target takes from
`linux/Makefile.i386` and `sys_linux.c` asks for by that exact string.

**It does not draw, and that was verified rather than assumed:** `vid.buffer` is 0 after 13 frames.
`null/swimp_null.c` is a file of empty bodies whose `SWimp_SetMode` returns nothing at all, so
ref_soft never gets a surface. Every real refresh implementation allocates one — `linux/rw_x11.c`
with `XCreateImage`, over the Xlib PRISM already has for Doom.
