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
