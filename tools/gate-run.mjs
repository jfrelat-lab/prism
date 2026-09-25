// gate-run.mjs — PRISM EXECUTES a program; gcc executes the same source; the two must agree.
//
// The first gate that observes behaviour rather than shape. Compared: everything the program wrote
// to stdout, byte for byte, and its exit status. Both sides compile the SAME unmodified source —
// gcc against its own headers, PRISM against the ones in src/env/headers.js.
//
//   node tools/gate-run.mjs [--verbose] [filter]

import { sh, SCRATCH, version } from './oracle.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '../src/compile.js';

const VERBOSE = process.argv.includes('--verbose');
const FILTER = process.argv.slice(2).find(a => !a.startsWith('--')) ?? null;

const cases = [];
const C = (name, src) => cases.push({ name, src });

// A flexible array member filled by the initialiser. The object is then LARGER than its type says,
// which is the whole point -- and the case that matters is the global defined right after it, which
// must not land on top of the extra bytes.
/*
 * An enum PROMOTES as its own type does: with no negative constant gcc makes it unsigned int, so
 * `x - 1 < 0` is false and `(x - 1) > 0` true. PRISM promoted every enum to a signed int and printed
 * "1 0" -- a wrong answer no case here asked about until the 16-bit enum work reached promote().
 */
C('enum-promotion', `
#include <stdio.h>
enum e { A, B };
enum n { M = -1, N };
int main(void)
{
    enum e x = A;
    enum n y = N;
    printf("%d %d %d %d\\n", x - 1 < 0, (x - 1) > 0, y - 1 < 0, (int)sizeof(x - 1));
    return 0;
}
`);

C('flexible-array-init', `
#include <stdio.h>
struct str { int n; char s[]; };
struct nums { int n; int v[]; };
static struct str a = { 3, "wx" };
static int between = 0x11223344;
static struct str b = { 4, { 'e', 'b', 'c' } };
static struct nums c = { 2, { 7, 8, 9, 10 } };
static struct nums empty = { .n = 40, .v = {} };
union both { struct str s; char pad[sizeof(struct str) + 8]; };
static union both u = { { 5, "12345678" } };
int main(void)
{
    printf("%d %c%c%d\\n", a.n, a.s[0], a.s[1], a.s[2]);
    printf("%x\\n", between);
    printf("%d %c%c%c\\n", b.n, b.s[0], b.s[1], b.s[2]);
    printf("%d %d %d %d %d\\n", c.n, c.v[0], c.v[1], c.v[2], c.v[3]);
    printf("%d\\n", empty.n);
    printf("%d %s\\n", u.s.n, u.s.s);
    printf("%d %d\\n", (int)sizeof(struct str), (int)sizeof(struct nums));
    return 0;
}
`);

// __builtin_classify_type: a constant naming the class of its argument's TYPE, whose value is never
// computed. The codes are gcc's, and this case is how they were established -- not from a header.
C('classify-type', `
#include <stdio.h>
struct S { int a; }; union U { int a; }; enum E { E1 };
static int calls = 0;
static int bump(void) { return ++calls; }
int fn(void);
int main(void)
{
    int i; char c; unsigned char uc; short sh; long l; long long ll; _Bool b;
    float f; double d; int *p; struct S s; union U u; enum E e; int arr[3]; char str[4];
    printf("%d %d %d %d %d %d %d\\n", __builtin_classify_type(i), __builtin_classify_type(c),
           __builtin_classify_type(uc), __builtin_classify_type(sh), __builtin_classify_type(l),
           __builtin_classify_type(ll), __builtin_classify_type(b));
    printf("%d %d %d\\n", __builtin_classify_type(f), __builtin_classify_type(d),
           __builtin_classify_type(p));
    printf("%d %d %d %d %d %d\\n", __builtin_classify_type(s), __builtin_classify_type(u),
           __builtin_classify_type(e), __builtin_classify_type(arr), __builtin_classify_type(str),
           __builtin_classify_type(fn));
    /* The argument is NOT evaluated. */
    printf("%d calls=%d\\n", __builtin_classify_type(bump()), calls);
    return 0;
}
`);

// __attribute__((alias)): a second NAME for an object that already exists, not a copy of it. The
// test is that a write through one is read back through the other.
C('symbol-alias', `
#include <stdio.h>
int a[4] = { 1, 2, 3, 4 };
extern int b[4] __attribute__((alias("a")));
static int counter = 7;
extern int shadow __attribute__((alias("counter")));
static int twice(int x) { return x * 2; }
int doubled(int x) __attribute__((alias("twice")));
int main(void)
{
    b[1] = 20;
    printf("%d %d %d\\n", a[1], b[1], (int)(&a[1] == &b[1]));
    shadow += 5;
    printf("%d %d\\n", counter, shadow);
    printf("%d %d\\n", doubled(21), twice(21));
    return 0;
}
`);

// Three small things the compiler provides rather than the program: the shift count's own type
// (a shift has no common type), __alignof__ of an expression, and __func__.
C('small-gnu', `
#include <stdio.h>
unsigned long long big = 0x95dd3d896f7422e2ULL;
struct wide { double d; };
int main(void)
{
    struct wide w; long long n = 3; int i = 1;
    /* The count is 64-bit and the value is not: no common type, C99 6.5.7p3. */
    printf("%u\\n", ((unsigned) big) >> n);
    printf("%llu\\n", big >> (unsigned char) 4);
    printf("%d\\n", i << (long long) 5);
    printf("%d %d %d\\n", (int)__alignof__(w), (int)__alignof__(w.d), (int)__alignof__(i));
    printf("%s %s\\n", __func__, __FUNCTION__);
    return 0;
}
`);

// setjmp/longjmp, in both spellings, with the thing that separates a correct resume from a
// plausible one: memory alloca'd BEFORE the setjmp is still alive after the longjmp.
C('setjmp-resume', `
#include <stdio.h>
#include <setjmp.h>
#include <string.h>
static jmp_buf env;
static void deeper(int n) { if (n) deeper(n - 1); else longjmp(env, 7); }
static void *bbuf[8];
static void jump_back(void) { __builtin_longjmp(bbuf, 1); }
int main(void)
{
    char *p = (char *) __builtin_alloca(24);
    strcpy(p, "before");
    int v = setjmp(env);
    if (v == 0) { printf("out %s\\n", p); deeper(3); printf("unreachable\\n"); }
    else printf("back %d %s\\n", v, p);
    {
        char *q = (char *) __builtin_alloca(16);
        strcpy(q, "second");
        if (__builtin_setjmp(bbuf) == 0) jump_back();
        else printf("builtin %s %s\\n", q, p);
    }
    return 0;
}
`);

// A compound literal is a POSTFIX expression, so it can be indexed and its members read straight
// off it -- and an array one states its extent by listing it. Next to it: an aggregate member
// initialised from a single expression, which is a copy and not a store.
C('compound-literal-postfix', `
#include <stdio.h>
typedef struct { short v; } W;
struct node { W a; W b; int t; };
struct pt { int x, y; };
int main(void)
{
    int i = 1;
    int *p = &(int []){10, 20, 30}[i];
    printf("%d %d\\n", *p, (int)sizeof((int []){10, 20, 30}));
    printf("%d %d\\n", (struct pt){4, 5}.y, (int []){7, 8, 9}[2]);
    { struct node m = { .a = (W){5}, .b = (W){6}, .t = 7 };
      W copy = m.a;
      struct node n2 = { .a = copy, .b = m.b, .t = m.t + 1 };
      printf("%d %d %d %d\\n", m.a.v, n2.a.v, n2.b.v, n2.t); }
    { int a = 0; int *q = &(int []){0, 1, 2}[++a]; printf("%d %d\\n", a, *q); }
    return 0;
}
`);

// Brace elision in a LOCAL initialiser: an aggregate member with no braces of its own takes as many
// items as it needs from the enclosing list. The static path had it; the dynamic one handed the
// member a single scalar and asked for a struct-sized store.
C('brace-elision-local', `
#include <stdio.h>
struct s { int f[4]; };
struct pt { int x, y; };
struct mix { char tag; struct pt p; int rest[3]; };
union one { int v; };
static int use(struct s v, int extra) { return v.f[3] + extra; }
int main(void)
{
    struct s a = { 1, 2, 3, 4 };
    struct pt row[2] = { 1, 2, 3, 4 };
    struct mix m = { 'z', 5, 6, 7, 8, 9 };
    struct { int c; union one u; } d = { .u = 3 };
    struct { int c; union one u; } e = { 1, 4 };
    /* A value that IS an aggregate is a copy, not a source of items for the member's first field. */
    struct pt inner = { 11, 12 };
    struct { int tag; struct pt p; } outer = { 3, inner };
    printf("%d %d %d %d\\n", a.f[0], a.f[3], use(a, 700), (int)sizeof a);
    printf("%d %d %d %d\\n", row[0].x, row[0].y, row[1].x, row[1].y);
    printf("%c %d %d %d %d %d\\n", m.tag, m.p.x, m.p.y, m.rest[0], m.rest[1], m.rest[2]);
    printf("%d %d %d %d\\n", d.c, d.u.v, e.c, e.u.v);
    printf("%d %d %d\\n", outer.tag, outer.p.x, outer.p.y);
    return 0;
}
`);

// GNU/C99 complex arithmetic. A complex value is a two-member record here, so what is tested is the
// arithmetic: the halves, the conversions each way, and division, which follows libgcc's Smith
// method rather than the naive formula.
C('complex', `
#include <stdio.h>
static _Complex double twice(_Complex double z) { return z * 2.0; }
static _Complex double gd = 1.0 + 2.0i;
static _Complex float gf = 3.0f + 4.0fi;
static struct { int tag; _Complex double z; } gs = { 7, 1.5 - 2.5i };
int main(void)
{
    _Complex double z = 3.0 + 4.0i, w;
    printf("%d %d %d\\n", (int)sizeof(_Complex float), (int)sizeof(_Complex double),
           (int)sizeof(_Complex int));
    printf("%.2f %.2f\\n", __real__ z, __imag__ z);
    w = z * z;      printf("%.2f %.2f\\n", __real__ w, __imag__ w);
    w = z + 1.0;    printf("%.2f %.2f\\n", __real__ w, __imag__ w);
    w = z - 2.0i;   printf("%.2f %.2f\\n", __real__ w, __imag__ w);
    w = z / (1.0 + 1.0i); printf("%.4f %.4f\\n", __real__ w, __imag__ w);
    w = z / 1e300;  printf("%.4e %.4e\\n", __real__ w, __imag__ w);
    w = -z;         printf("%.2f %.2f\\n", __real__ w, __imag__ w);
    w = ~z;         printf("%.2f %.2f\\n", __real__ w, __imag__ w);
    w = twice(z);   printf("%.2f %.2f\\n", __real__ w, __imag__ w);
    w = z; w += 1.0 + 1.0i; printf("%.2f %.2f\\n", __real__ w, __imag__ w);
    __real__ w = 9.0; __imag__ w = -9.0; printf("%.2f %.2f\\n", __real__ w, __imag__ w);
    printf("%d %d %d\\n", z == 3.0 + 4.0i, z == 3.0, z != 0.0);
    printf("%.2f %.2f\\n", (double) z, (double) __builtin_cimag(z));
    { _Complex double c = 5.0; printf("%.2f %.2f\\n", __real__ c, __imag__ c); }
    { _Complex float f = gf * gf; printf("%.2f %.2f\\n", (double)__real__ f, (double)__imag__ f); }
    { _Complex int n = 3 + 4i; n = n * n; printf("%d %d\\n", (int)__real__ n, (int)__imag__ n); }
    { _Complex double cj = __builtin_conj(z); printf("%.2f %.2f\\n", __real__ cj, __imag__ cj); }
    printf("%.2f %.2f %d %.2f %.2f\\n", __real__ gd, __imag__ gd, gs.tag, __real__ gs.z, __imag__ gs.z);
    printf("%d\\n", z ? 1 : 0);
    return 0;
}
`);

// A `switch` whose discriminant does not fit in 32 bits, and a GNU case RANGE too wide to spell out
// one label at a time.
C('switch-wide', `
#include <stdio.h>
static int f(unsigned long long v)
{
    switch (v) {
    case 0x100000000ULL: return 1;
    case 2: return 2;
    case 1000000000000000000ULL ... 9999999999999999999ULL: return 19;
    default: return 3;
    }
}
static int g(int c)
{
    switch (c) { case 'a' ... 'z': return 1; case '0' ... '9': return 2; default: return 0; }
}
int main(void)
{
    printf("%d %d %d %d\\n", f(0x100000000ULL), f(2), f(1000000000000000001ULL), f(7));
    printf("%d %d %d\\n", g('q'), g('4'), g('!'));
    return 0;
}
`);

// __attribute__((mode(M))): the machine mode gives the WIDTH and the written type gives only the
// signedness, which is the trap -- `unsigned int` with mode(QI) is an unsigned char, not an int.
C('attribute-mode', `
#include <stdio.h>
typedef unsigned int u8 __attribute__((mode(QI)));
typedef signed int s8 __attribute__((mode(QI)));
typedef unsigned int u16 __attribute__((mode(HI)));
typedef int s32 __attribute__((mode(SI)));
typedef int s64 __attribute__((mode(DI)));
typedef int word_t __attribute__((mode(word)));
typedef float f64 __attribute__((mode(DF)));
struct packed { char c; s64 big; };
int main(void)
{
    u8 a = 250; s8 b = -3; u16 c = 70000; s64 d = 1; f64 e = 0.5;
    printf("%d %d %d %d %d %d %d\\n", (int)sizeof(u8), (int)sizeof(s8), (int)sizeof(u16),
           (int)sizeof(s32), (int)sizeof(s64), (int)sizeof(word_t), (int)sizeof(f64));
    a += 10; b -= 200;
    printf("%d %d %u %lld %.2f\\n", (int)a, (int)b, (unsigned)c, (long long)(d << 40), (double)e);
    printf("%d %d\\n", (int)sizeof(struct packed), (int)__builtin_offsetof(struct packed, big));
    { int x __attribute__((mode(QI))) = 300; printf("%d\\n", x); }
    return 0;
}
`);

// A compound literal at FILE SCOPE has static storage duration, so its address is an address
// constant -- and the same literal named twice is one object, not two.
C('static-compound-literal', `
#include <stdio.h>
struct S { int a, b; };
struct S *p = &(struct S){ 1, 2 };
struct S *q = &(struct S){ 3, 4 };
int *r = (int []){ 10, 20, 30 };
struct outer { struct S *s; int tag; };
struct outer o = { &(struct S){ 5, 6 }, 7 };
int main(void)
{
    printf("%d %d %d %d\\n", p->a, p->b, q->a, q->b);
    printf("%d %d %d\\n", r[0], r[1], r[2]);
    printf("%d %d %d\\n", o.s->a, o.s->b, o.tag);
    p->a = 99;
    printf("%d %d\\n", p->a, q->a);
    return 0;
}
`);

// GNU array RANGE designators, `[1 ... 5] = v`, static and local, overlapping and with a
// non-constant value -- each element gets the VALUE, not the expression.
C('range-designator', `
#include <stdio.h>
int a[12] = { [1 ... 5] = 9, [6 ... 10] = 4, [4 ... 7] = 3 };
struct P { int x, y; };
struct P ps[4] = { [0 ... 2] = { 1, 2 } };
char s[6] = { [0 ... 4] = 'x' };
static int calls;
static int next(void) { return ++calls; }
int main(void)
{
    int i, e = 7;
    int b[8] = { [2 ... 5] = e + 1 };
    int c[6] = { [0 ... 3] = next() };
    for (i = 0; i < 12; i++) printf("%d", a[i]); printf("\\n");
    for (i = 0; i < 8; i++) printf("%d", b[i]); printf("\\n");
    for (i = 0; i < 4; i++) printf("%d%d ", ps[i].x, ps[i].y); printf("\\n");
    for (i = 0; i < 6; i++) printf("%d,", c[i]); printf(" calls=%d\\n", calls);
    printf("%s|\\n", s);
    return 0;
}
`);

// The ADDRESS of a library function, called only through the pointer. The variadic case needs an
// adapter: an indirect call packs the tail into the va buffer, where a direct call would have handed
// the runtime a plain list.
C('library-function-address', `
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static int (*gp)(const char *) = &puts;
static int (*gfp)(FILE *, const char *, ...) = &fprintf;
static void *(*gmem)(void *, const void *, size_t) = &memcpy;
int main(void)
{
    char buf[8];
    int (*local)(const char *, ...) = printf;
    size_t (*len)(const char *) = strlen;
    gp("through a pointer");
    gfp(stdout, "%d %s\\n", 42, "args");
    local("%s %d\\n", "direct", 7);
    gmem(buf, "abcdef", 7);
    printf("%s %d\\n", buf, (int)len(buf));
    printf("%d %d\\n", gp == &puts, (int)(gfp != 0));
    return 0;
}
`);

// GNU statement expressions, `({ ... })`. Emitted as an arrow function called on the spot, so the
// body runs exactly where it is written -- inside a loop condition, inside an untaken branch of a
// `?:` -- rather than being hoisted ahead of the statement.
C('stmt-expressions', `
#include <stdio.h>
#define MAX(a,b) ({ int _a = (a), _b = (b); _a > _b ? _a : _b; })
struct pair { int x, y; };
static int calls = 0;
static int bump(void) { calls++; return calls; }
int main(void)
{
    int i = 3, n = 0;
    printf("%d\\n", MAX(2 + 2, 5));
    /* In a loop condition: once per iteration, not once. */
    while ( ({ i--; }) ) n++;
    printf("%d %d\\n", i, n);
    /* In the untaken arm of a conditional: must not run at all. */
    printf("%d\\n", 1 ? 7 : ({ bump(); 9; }));
    printf("calls=%d\\n", calls);
    /* A struct value, and a member read straight off it. */
    printf("%d\\n", ({ struct pair p; p.x = 4; p.y = 6; p; }).y);
    /* Its own loop and switch inside, whose break belongs to them. */
    printf("%d\\n", ({ int s = 0, k; for (k = 0; k < 4; k++) { if (k == 3) break; s += k; }
                       switch (s) { case 3: s = 30; break; default: s = -1; } s; }));
    /* Void: the last statement is not an expression. */
    ({ int unused = 1; (void)unused; });
    return 0;
}
`);

// GNU nested functions. They become sibling JS functions taking the enclosing FRAME as a hidden
// first parameter -- not JavaScript closures, which would capture the emitted variables when what a
// nested C function needs is the frame. Every name one mentions is therefore pinned to a slot.
C('nested-functions', `
#include <stdio.h>
static int apply(int (*fn)(int), int x) { return fn(x); }
static int outer(int base)
{
    int total = 0;
    int add(int x) { return x + base; }        /* reads the enclosing frame */
    void bump(int by) { total += by; }         /* WRITES it */
    bump(add(5));
    bump(add(1));
    return total;
}
static int counted(void)
{
    int n = 0;
    void tick(void) { n++; }
    int i;
    for (i = 0; i < 4; i++) tick();
    return n;
}
static int recursive(int n)
{
    int depth = 0;
    int go(int k) { depth++; return k <= 1 ? 1 : k * go(k - 1); }
    { int r = go(n); return r * 100 + depth; }
}
int main(void)
{
    printf("%d\\n", outer(10));
    printf("%d\\n", counted());
    printf("%d\\n", recursive(5));
    /* An aligned local, whose address the nested function also takes. */
    { typedef int aligned __attribute__((aligned));
      aligned jj; void set(void) { jj = 7; } set();
      printf("%d %d\\n", jj, (int)(((long)&jj) & 15)); }
    return 0;
}
`);

// An inline asm whose TEMPLATE IS EMPTY emits no instructions, so everything it does is in its
// constraints. A digit constraint on an input names the output it shares a register with, and with
// nothing in between the output ends up holding the input. gcc has twenty of these; they exist to
// defeat the optimiser, and the value carried through the tie is their whole observable effect.
C('empty-asm', `
#include <stdio.h>
static int calls;
static int slot;
static int *bump(void) { calls++; return &slot; }
static int low(long long x) { int i; __asm__("" : "=r"(i) : "0"(x)); return i; }
int main(void)
{
    int a = 7, b = 0;
    asm ("" : "=r"(b) : "0"(a));
    printf("tie: %d\\n", b);
    printf("truncated: %d\\n", low(-2147483647LL));
    printf("wide: %d\\n", low(0x1234567800000009LL));

    /* A read-write output evaluates its lvalue ONCE, side effects and all. */
    slot = 5;
    asm ("" : "+r"(*bump()));
    printf("calls=%d slot=%d\\n", calls, slot);

    /* Two ties at once, and an untied output keeps what it had. */
    { int p = 1, q = 2, r = 30, s = 40;
      asm ("" : "=r"(r), "=r"(s) : "0"(p), "1"(q));
      printf("%d %d\\n", r, s); }

    /* No outputs at all: the inputs are still evaluated. */
    asm ("" : : "r"(bump()));
    printf("calls=%d\\n", calls);
    return 0;
}
`);

// The parts of a stream that say NO. Every one of these was silently permissive, and each is what a
// program checks when it wants to know whether something worked: gcc's suite never asks, and Lua's
// files.lua asks about all of them.
//
// The RETURN VALUES are asserted and the error INDICATOR is not: C leaves it unspecified whether a
// wrong-direction operation sets it, and glibc does not. Reads are one per statement, because
// argument evaluation order is unspecified and three getc calls in one printf come out backwards.
C('stream-refusals', `
#include <stdio.h>
int main(void)
{
    const char *f = "refusals-gate.tmp";
    FILE *w = fopen(f, "w");
    fputs("ab", w);
    printf("read from a write stream: %d\\n", fgetc(w));
    fclose(w);

    FILE *r = fopen(f, "r");
    printf("write to a read stream: %d\\n", (int)fwrite("z", 1, 1, r));
    clearerr(r);
    { int a = fgetc(r); int b = fgetc(r); int c = fgetc(r);
      printf("%d %d %d eof=%d\\n", a, b, c, feof(r) != 0); }
    { int c = fgetc(r); int u = ungetc(c, r); int e = feof(r) != 0; int n = fgetc(r);
      printf("ungetc(EOF)=%d eof still %d, next=%d\\n", u, e, n); }
    fclose(r);

    /* r+ opens for UPDATE and must not truncate. */
    FILE *u = fopen(f, "r+");
    { char b[4] = {0}; fread(b, 1, 2, u); printf("r+ kept [%s]\\n", b); }
    fclose(u);

    /* A file cannot be created in a directory that does not exist. */
    printf("no such dir: %d\\n", fopen("/a/b/c/d", "w") == 0);
    remove(f);
    return 0;
}
`);

// Variable-length arrays, for LOCALS. The storage is alloca'd, which puts it on the same shadow
// stack as the frame and therefore releases it at return -- exactly a VLA's lifetime.
C('vla', `
#include <stdio.h>
static int sum(int n, int *a) { int i, s = 0; for (i = 0; i < n; i++) s += a[i]; return s; }
static int f(int n)
{
    int a[n], i;
    for (i = 0; i < n; i++) a[i] = i * i;
    return sum(n, a) + a[n - 1];
}
static int nested(int n)
{
    int total = 0, k;
    for (k = 1; k <= n; k++) { int row[k]; int i;
        for (i = 0; i < k; i++) row[i] = k;
        total += sum(k, row); }
    return total;
}
int main(void)
{
    int n = 5, i;
    double x[n];
    for (i = 0; i < n; i++) x[i] = i / 2.0;
    printf("%d %d %d\\n", f(3), f(5), f(1));
    printf("%.1f %.1f\\n", x[0], x[4]);
    { char buf[n * 2]; for (i = 0; i < n * 2; i++) buf[i] = 'a' + i; buf[n * 2 - 1] = 0;
      printf("%s\\n", buf); }
    printf("%d\\n", nested(4));
    { int *p; int a[n]; p = a; p[2] = 7; printf("%d\\n", a[2]); }
    /*
     * DEALLOCATION. A VLA whose declaration runs again -- around a loop, or back to a label -- gives
     * its storage back, so a hundred thousand of them occupy the room of one. What is comparable
     * with the reference build is not the address but whether it MOVES.
     */
    { int moved = 0, k; void *first = 0;
      for (k = 0; k < 100000; k++) { int a[k % 500 + 1]; a[0] = k;
        if (!first) first = a; else if ((void *)a != first) moved = 1; }
      printf("loop moved=%d\\n", moved); }
    { int moved = 0, k = 0; void *first = 0;
     again:
      { int a[k % 500 + 1]; a[0] = k;
        if (!first) first = a; else if ((void *)a != first) moved = 1; }
      { int b[7]; b[0] = k; if (b[0] != k) moved = 1; }
      if (++k < 100000) goto again;
      printf("goto moved=%d\\n", moved); }
    return 0;
}
`);

// Three GNU spellings gcc accepts and the corpus uses: an attribute on a PARAMETER, `__asm` and
// `__attribute` without the trailing underscores, and the pre-C99 designator `field: value`.
C('gnu-spellings', `
#include <stdio.h>
struct S { int a, b, c; };
static struct S g = { b: 2, a: 1, c: 3 };
int __attribute ((unused)) unused_marker;
static int f(int x __attribute__((unused)), int y __attribute((unused)), int z)
{
    __asm ("");            /* an empty template is a barrier and emits nothing */
    return z;
}
int main(void)
{
    struct S l = { c: 30, a: 10 };
    printf("%d %d %d\\n", g.a, g.b, g.c);
    printf("%d %d %d\\n", l.a, l.b, l.c);
    printf("%d\\n", f(1, 2, 3));
    { typedef __builtin_va_list my_va; my_va *p = 0; printf("%d\\n", (int)(p == 0)); }
    return 0;
}
`);

// Bitfields whose declared type is 64-bit. The width is what decides the PROMOTION -- int if int
// can hold every value, else unsigned int -- and the declared type is what decides the storage. Six
// torture programs failed on the first with "Cannot mix BigInt and other types", which is what a
// read that returns a BigInt does when the type says int.
C('bitfield-64', `
#include <stdio.h>
struct A { unsigned long long a:8, b:32; };
struct B { unsigned long long l1:24, l2:8; long long s:20; };
int main(void)
{
    struct A x; struct B b;
    /* Every one CAST: a narrow field promotes to int, so passing it bare to %llu misaligns the
       varargs -- which is a property of the promotion working, not a bug. */
    x.a = 12; x.b = 0xcdef1234;
    printf("%llu %llu\\n", (unsigned long long)x.a, (unsigned long long)x.b);
    b.l1 = 0xdeadbe; b.l2 = 0xef; b.s = -12345;
    printf("%llx %llx %lld\\n", (unsigned long long)b.l1, (unsigned long long)b.l2,
           (long long)b.s);
    b.l2 += 1; b.s -= 1; x.b += 1;
    printf("%llx %lld %llu\\n", (unsigned long long)b.l2, (long long)b.s,
           (unsigned long long)x.b);
    /* The promotion: a narrow field is an int, so this arithmetic is int arithmetic. */
    printf("%d %d\\n", (int)(x.a * 2), (int)sizeof(x.a + 0));
    { struct A y = { 200, 4000000000U };
      printf("%llu %llu\\n", (unsigned long long)y.a, (unsigned long long)y.b); }
    return 0;
}
`);

// The overflow builtins, which are TYPE-GENERIC: the width and signedness come from the third
// argument's pointee, not from the call. Both halves are checked -- the return value AND the stored
// result, which is wrapped to the destination type whether or not it overflowed.
//
// The result is taken into a variable BEFORE printing it. Putting the call and the destination in
// one printf reads the destination at an unspecified moment: gcc evaluates its arguments right to
// left and printed the value from before the call.
C('overflow-builtins', `
#include <stdio.h>
#define SHOW(fmt, call, var) do { int r_ = (call); printf("%d " fmt "\\n", r_, var); } while (0)
int main(void)
{
    int i; unsigned u; long long l; unsigned long long ul; unsigned char c; short s;
    SHOW("%d",   __builtin_add_overflow(2147483647, 1, &i), i);
    SHOW("%d",   __builtin_add_overflow(1, 2, &i), i);
    SHOW("%u",   __builtin_sub_overflow(0u, 1u, &u), u);
    SHOW("%d",   __builtin_mul_overflow(65536, 65536, &i), i);
    SHOW("%lld", __builtin_mul_overflow(4000000000LL, 4000000000LL, &l), l);
    SHOW("%llu", __builtin_mul_overflow(4000000000ULL, 4ULL, &ul), ul);
    SHOW("%d",   __builtin_add_overflow(200, 100, &c), c);
    SHOW("%d",   __builtin_sub_overflow(-32768, 1, &s), s);
    SHOW("%lld", __builtin_add_overflow(9223372036854775807LL, 1LL, &l), l);
    SHOW("%d",   __builtin_sadd_overflow(1, 2, &i), i);
    /* The destination is one of the OPERANDS, and each operand keeps its own signedness: gcc's
       pr85095.c is this, and 0xffffffffu read as -1 reports no overflow at all. */
    { unsigned int a = 0xffffffffu; unsigned int r = __builtin_add_overflow(a, 1u, &a);
      printf("%u %u\\n", r, a); }
    { unsigned long a = 0xfffffffful; unsigned long r = __builtin_add_overflow(a, 1ul, &a);
      printf("%lu %lu\\n", r, a); }
    return 0;
}
`);

// freopen on an ORDINARY stream, plus the file round trip underneath it.
//
// The other half -- freopen redirecting STDOUT, and the discovery that printf, puts and putchar
// wrote straight to the host console instead of through the stream -- is checked by gcc's own
// printf-2.c and user-printf.c, which is the better oracle for it anyway. It cannot be checked here:
// this gate compares stdout, and PRISM's stderr lands in the same buffer while gcc's does not, so a
// program that reports its findings on stderr is not comparable.
C('freopen', `
#include <stdio.h>
int main(void)
{
    const char *a = "freopen-gate-a.tmp", *b = "freopen-gate-b.tmp";
    FILE *f = fopen(a, "w");
    if (!f) { perror("fopen a"); return 1; }
    fputs("first\\n", f);

    /* Reopen the SAME FILE* on another file: the old one is closed, the token is reused. */
    f = freopen(b, "w", f);
    if (!f) { perror("freopen b"); return 1; }
    fprintf(f, "second %d\\n", 2);
    fclose(f);

    { char line[64]; FILE *g = fopen(a, "r");
      printf("a: %s", g && fgets(line, sizeof line, g) ? line : "(nothing)\\n");
      if (g) fclose(g); }
    { char line[64]; FILE *g = fopen(b, "r");
      printf("b: %s", g && fgets(line, sizeof line, g) ? line : "(nothing)\\n");
      if (g) fclose(g); }
    remove(a); remove(b);
    printf("gone: %d %d\\n", fopen(a, "r") == 0, fopen(b, "r") == 0);
    return 0;
}
`);

// printf's LENGTH MODIFIERS. `h` and `hh` do not change how the argument arrives -- promotion has
// already made it an int -- they change what the conversion prints (C99 7.19.6.1p7). gcc's
// pr78622.c checks it, and was passing only because __builtin_snprintf was missing: a refusal was
// hiding a wrong answer, which is the transition worth watching for.
C('printf-length-modifiers', `
#include <stdio.h>
int main(void)
{
    printf("[%hhd][%hhd][%hhu][%hd][%hu][%hhx][%hho]\\n",
           4104, -1, 300, 70000, 70000, 300, 300);
    printf("[%ld][%lu][%lld][%llu][%jd]\\n",
           123456789L, 4000000000UL, -1LL, 18446744073709551615ULL, (long long)-7);
    { char b[8]; int n = snprintf(b, sizeof b, "%hhd", 4104); printf("[%s][%d]\\n", b, n); }
    return 0;
}
`);

// The __builtin_ family gcc's torture suite reaches for. Most are aliases; the bit-counting and
// classification ones are real functions, and each has an edge the obvious implementation misses --
// ffs of zero, signbit of NEGATIVE zero, mempcpy returning the END of the copy.
C('builtins', `
#include <stdio.h>
int main(void)
{
    printf("%d %d %d %d %d\\n", __builtin_ffs(0), __builtin_ffs(1), __builtin_ffs(6),
           __builtin_ffs(0x80000000), __builtin_ffs(-1));
    printf("%d %d %d %d\\n", __builtin_clz(1u), __builtin_clz(0xffffffffu),
           __builtin_ctz(8u), __builtin_ctz(0x80000000u));
    printf("%d %d %d\\n", __builtin_popcount(0xf0f0u), __builtin_parity(7u), __builtin_parity(3u));
    printf("%x %x\\n", __builtin_bswap16(0x1234), __builtin_bswap32(0x11223344u));
    printf("%llx\\n", (unsigned long long)__builtin_bswap64(0x0123456789abcdefULL));
    printf("%d %d %d %d\\n", __builtin_signbit(-0.0), __builtin_signbit(1.0),
           __builtin_isinf(1.0/0.0), __builtin_isnan(0.0/0.0));
    printf("%f %f\\n", __builtin_copysign(3.0, -1.0), __builtin_copysign(-3.0, 1.0));
    { char a[8] = "abc", b[8]; char *e = (char *)__builtin_mempcpy(b, a, 4);
      printf("%s %d\\n", b, (int)(e - b)); }
    { char b[8]; char *e = __builtin_stpcpy(b, "hello"); printf("%s %d\\n", b, (int)(e - b)); }
    { char b[8]; __builtin_strncpy(b, "xy", 3); printf("%s %s\\n", b, __builtin_strchr(b, 'y')); }
    return 0;
}
`);

// Bitfields in a brace initialiser, which is where a "two fields at one offset means an anonymous
// union" rule quietly eats them: consecutive bitfields all report the offset of their storage unit.
// gcc's bf-sign-1.c and 20000113-1.c are this, and they fail as WRONG ANSWERS rather than refusals.
C('bitfield-init', `
#include <stdio.h>
struct S { signed int s:3; unsigned int u:3; int i:3; };
struct X { unsigned x1:1, x2:2, x3:3; };
struct M { int before; unsigned a:5, b:5, c:5; int after; };
static struct X g = { 1, 2, 3 };
int main(void)
{
    struct S x = { -1, -1, -1 };
    struct X d = { 1, 2, 3 };
    struct M m = { 11, 3, 5, 7, 22 };
    struct X *c = &d;
    printf("%d %u %d\\n", x.s, x.u, x.i);
    printf("%u %u %u | %u %u %u\\n", d.x1, d.x2, d.x3, g.x1, g.x2, g.x3);
    printf("%d %u %u %u %d\\n", m.before, m.a, m.b, m.c, m.after);
    c->x3 += (d.x2 - d.x1) * c->x2;
    printf("%u\\n", c->x3);
    return 0;
}
`);

// Shadowing, and shadowing in a function that has to be FLATTENED.
//
// The emitter keeps one map of locals per function and named its JS variables after the C ones, so
// two `i`s in sibling blocks shared a variable and a struct shadowed by a `char[2]` broke every use
// of the struct after that block. The `goto` is not decoration: it forces the control-flow
// flattening pass, which hoists every declaration to function scope and is where the sharing bites.
C('shadowed-locals', `
#include <stdio.h>
struct W { int n; char *p; };
static int flat(int k)
{
    int total = 0;
    struct W w;
    w.n = 10; w.p = "outer";
    if (k > 2) goto late;
    { int i; for (i = 0; i < 3; i++) total += i; }
    { char i = 'A'; total += i; }
    { static int i = 100; i++; total += i; }
    {
        char w[2];
        w[0] = 'z'; w[1] = 0;
        total += w[0];
    }
late:
    { static int i = 200; i++; total += i; }
    total += w.n + (int)w.p[0];
    { int i; for (i = 0; i < 2; i++) total += i * 1000; }
    return total;
}
int main(void)
{
    /* One call per statement: these have side effects and argument evaluation order is unspecified. */
    int a = flat(0), b = flat(0), c = flat(5), d = flat(5);
    printf("%d %d %d %d\\n", a, b, c, d);
    return 0;
}
`);

// Designated initialisers that go MORE THAN ONE LEVEL DEEP, and bitfields among them. PuTTY's
// conf_key_info writes `.default_value.ival = x` into a struct whose union member is anonymous, and
// c-testsuite has no case of that shape -- which is how a first fix here could write every
// designated bitfield as zero and still pass 205/219.
C('designator-chain', `
#include <stdio.h>
struct S {
    int subkey, vtype;
    union { int i; const char *s; } dv;
    int save_custom : 1;
    int not_saved : 1;
    int arr[3];
    const char *kw;
};
static const struct S t[] = {
    { .vtype = 11, .dv.i = 42, .kw = "a" },
    { .subkey = 3, .dv.i = 5, .not_saved = 1, .kw = "b" },
    { .vtype = 7, .not_saved = 1, .dv.i = -1, .arr[1] = 9 },
    { 9, 8, { .i = 4 }, 1, 0, { 1, 2, 3 }, "d" },
};
int main(void)
{
    int i;
    for (i = 0; i < 4; i++)
        printf("%d %d | %d | %d %d | %d %d %d | %s\\n", t[i].subkey, t[i].vtype, t[i].dv.i,
               t[i].save_custom, t[i].not_saved, t[i].arr[0], t[i].arr[1], t[i].arr[2],
               t[i].kw ? t[i].kw : "-");
    {
        struct S local = { .vtype = 2, .dv.i = 3, .not_saved = 1, .arr[2] = 6, .kw = "local" };
        printf("%d %d | %d | %d %d | %d %d %d | %s\\n", local.subkey, local.vtype, local.dv.i,
               local.save_custom, local.not_saved, local.arr[0], local.arr[1], local.arr[2],
               local.kw);
    }
    return 0;
}
`);

// Zero fill on the integer conversions. Both halves of this were wrong and neither was visible in
// anything the corpus prints: `%04X` of a value with an a-f digit lost its fill because the inf/nan
// check tested EVERY conversion for a letter, and `#` put the zeros before the 0x instead of after.
C('printf-zero-fill', `
#include <stdio.h>
int main(void)
{
    unsigned v[] = { 0x68, 0x6C, 0xA2, 0x24, 0x72, 0xABCDEF, 0 };
    int i;
    for (i = 0; i < 7; i++) printf("%04X|%04x|%#010x|%#012o|%08d\\n", v[i], v[i], v[i], v[i], v[i]);
    printf("%08.2f|%08f|%+#014.0f|%-8.3f|\\n", 1.0/0.0, -1.0/0.0, 100.0, 2.5);
    printf("%.u|%.0d|%#o|%#x|\\n", 0u, 0, 0, 0);
    return 0;
}
`);

C('hello', `
#include <stdio.h>
int main(void) { printf("hello, world\\n"); return 0; }
`);

C('exit-status', `
int main(void) { return 42; }
`);

C('arithmetic', `
#include <stdio.h>
int main(void) {
  int a = 17, b = 5;
  printf("%d %d %d %d %d\\n", a+b, a-b, a*b, a/b, a%b);
  printf("%d %d %d\\n", -a/b, -a%b, a/-b);
  printf("%d %d %d %d\\n", a&b, a|b, a^b, ~a);
  printf("%d %d\\n", a<<3, a>>2);
  printf("%d %d %d\\n", -1>>1, (int)((unsigned)-1>>1), 1<<31);
  return 0;
}
`);

C('unsigned-wrap', `
#include <stdio.h>
int main(void) {
  unsigned u = 0;
  u = u - 1;
  printf("%u %x\\n", u, u);
  printf("%u %u\\n", u/3, u%3);
  printf("%d\\n", (int)u);
  unsigned char c = 250;
  c = c + 10;
  printf("%d\\n", c);
  short s = 32767;
  s = s + 1;
  printf("%d\\n", s);
  return 0;
}
`);

C('control-flow', `
#include <stdio.h>
int main(void) {
  int i, total = 0;
  for (i = 0; i < 10; i++) { if (i % 3 == 0) continue; if (i == 8) break; total += i; }
  printf("%d\\n", total);
  i = 0;
  while (i < 5) { total += i * i; i++; }
  printf("%d\\n", total);
  i = 0;
  do { total -= 1; i++; } while (i < 3);
  printf("%d\\n", total);
  switch (total % 4) {
    case 0: printf("zero\\n"); break;
    case 1: printf("one\\n");
    case 2: printf("two\\n"); break;
    default: printf("other\\n");
  }
  return 0;
}
`);

C('recursion', `
#include <stdio.h>
int fib(int n) { return n < 2 ? n : fib(n-1) + fib(n-2); }
int fact(int n) { if (n <= 1) return 1; return n * fact(n-1); }
int main(void) { printf("%d %d\\n", fib(20), fact(10)); return 0; }
`);

C('pointers', `
#include <stdio.h>
int main(void) {
  int a[5] = {10, 20, 30, 40, 50};
  int *p = a;
  printf("%d %d %d\\n", *p, *(p+2), p[4]);
  p += 3;
  printf("%d %d\\n", *p, (int)(p - a));
  *p = 99;
  printf("%d\\n", a[3]);
  int x = 7, *q = &x;
  *q = *q * 2;
  printf("%d\\n", x);
  int **pp = &q;
  **pp = 5;
  printf("%d\\n", x);
  return 0;
}
`);

C('arrays-2d', `
#include <stdio.h>
int main(void) {
  int m[3][4];
  int i, j, s = 0;
  for (i = 0; i < 3; i++) for (j = 0; j < 4; j++) m[i][j] = i * 10 + j;
  for (i = 0; i < 3; i++) for (j = 0; j < 4; j++) s += m[i][j];
  printf("%d %d %d\\n", s, m[1][2], m[2][3]);
  return 0;
}
`);

C('structs', `
#include <stdio.h>
struct pt { int x, y; };
struct box { struct pt lo, hi; char tag; };
int main(void) {
  struct box b;
  b.lo.x = 1; b.lo.y = 2; b.hi.x = 30; b.hi.y = 40; b.tag = 'Z';
  printf("%d %d %d %d %c\\n", b.lo.x, b.lo.y, b.hi.x, b.hi.y, b.tag);
  struct box c = b;
  c.lo.x = 100;
  printf("%d %d\\n", b.lo.x, c.lo.x);
  struct pt *p = &b.hi;
  p->x = 7;
  printf("%d %d\\n", b.hi.x, p->y);
  printf("%d\\n", (int)sizeof(struct box));
  return 0;
}
`);

C('struct-array-and-init', `
#include <stdio.h>
struct rec { int id; char name[8]; };
struct rec table[3] = { {1, "one"}, {2, "two"}, {3, "three"} };
int counter = 7;
int main(void) {
  int i;
  for (i = 0; i < 3; i++) printf("%d:%s ", table[i].id, table[i].name);
  printf("\\n%d\\n", counter);
  return 0;
}
`);

// Structs by value. A parameter is a pointer to a copy the CALLER made — so the callee may modify it
// without the caller seeing it — and a return goes through a caller-supplied buffer, because the
// callee's frame is released before the value could be read out of it.
// User-defined variadic functions. The caller packs the tail into a buffer and passes its address;
// va_list is a plain char*, as on i386 SysV. `bump` checks that each argument is evaluated ONCE —
// taking the type from the parser's annotation rather than by emitting the expression.
// goto, as a state machine over the function's top-level statements. Covers the four shapes real
// code uses: a backward loop, a forward exit, a jump out of a for loop, and label fallthrough
// (`fall(0)` must reach BOTH labels, giving 11).
// GNU label addresses and computed goto. In a state-machine translation the "address" of a label IS
// its dispatch value, so `&&lab` and `goto *p` fall out for free — including from a static table.
C('computed-goto', `
#include <stdio.h>
int walk(int n) {
  static const void *tbl[] = { &&one, &&two, &&three };
  int s = 0;
  if (n < 0 || n > 2) return -1;
  goto *tbl[n];
one:
  s += 1;
two:
  s += 20;
three:
  s += 300;
  return s;
}
struct bf { unsigned a : 3; signed b : 11; };
int main(void) {
  printf("%d %d %d %d\\n", walk(0), walk(1), walk(2), walk(9));
  struct bf f; f.a = 6; f.b = 1023;
  /* Sequenced on purpose: printf of f.a++ and f.a in one call reads and modifies one object with
     unsequenced subexpressions, which is UNDEFINED - the third time this trap was written into a
     case in this project. See docs/TESTING.md. */
  unsigned p1 = f.a++; unsigned p2 = f.a;
  printf("%u %u\\n", p1, p2);
  printf("%u\\n", ++f.a);
  int q1 = f.b++; int q2 = f.b;
  printf("%d %d\\n", q1, q2);
  return 0;
}
`);

C('goto', `
#include <stdio.h>
int f(int n) {
  int i = 0, s = 0;
retry:
  i++;
  if (i > n) goto done;
  s += i;
  goto retry;
done:
  return s;
}
int g(int n) {
  int i, s = 0;
  for (i = 0; i < 10; i++) { if (i == n) goto out; s += i; }
  s = -1;
out:
  return s;
}
int h(int x) {
  if (x < 0) goto neg;
  if (x == 0) goto zero;
  return 1;
neg:
  return -1;
zero:
  return 0;
}
int fall(int x) {
  int s = 0;
  if (x) goto b;
a:
  s += 1;
b:
  s += 10;
  return s;
}
int nested(int n) {
  int i, j, s = 0;
  for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) { if (i * j > n) goto stop; s += i * j; }
stop:
  return s;
}
int main(void) {
  printf("%d %d %d\\n", f(5), f(0), f(1));
  printf("%d %d\\n", g(4), g(99));
  printf("%d %d %d\\n", h(-5), h(0), h(7));
  printf("%d %d\\n", fall(0), fall(1));
  printf("%d %d\\n", nested(2), nested(99));
  return 0;
}
`);

C('varargs', `
#include <stdarg.h>
#include <stdio.h>
int sum(int n, ...) {
  va_list ap; int i, s = 0;
  va_start(ap, n);
  for (i = 0; i < n; i++) s += va_arg(ap, int);
  va_end(ap);
  return s;
}
double avg(int n, ...) {
  va_list ap; int i; double s = 0;
  va_start(ap, n);
  for (i = 0; i < n; i++) s += va_arg(ap, double);
  va_end(ap);
  return s / n;
}
void cat(char *out, int n, ...) {
  va_list ap; int i; char *p = out;
  va_start(ap, n);
  for (i = 0; i < n; i++) { char *s = va_arg(ap, char *); while (*s) *p++ = *s++; }
  va_end(ap);
  *p = 0;
}
long long bigsum(int n, ...) {
  va_list ap; int i; long long s = 0;
  va_start(ap, n);
  for (i = 0; i < n; i++) s += va_arg(ap, long long);
  va_end(ap);
  return s;
}
int mixed(int n, ...) {
  va_list ap;
  va_start(ap, n);
  int a = va_arg(ap, int);
  double d = va_arg(ap, double);
  char *s = va_arg(ap, char *);
  va_end(ap);
  return a + (int)d + (int)s[0];
}
int calls = 0;
int bump(void) { return ++calls; }
int main(void) {
  printf("%d %d %d\\n", sum(4, 1, 2, 3, 4), sum(1, 42), sum(0));
  printf("%.3f\\n", avg(3, 1.0, 2.0, 6.0));
  char buf[64]; cat(buf, 3, "ab", "cd", "ef");
  printf("%s\\n", buf);
  printf("%lld\\n", bigsum(3, 4000000000LL, 4000000000LL, 1LL));
  printf("%d\\n", mixed(3, 7, 2.5, "A"));
  int r = sum(2, bump(), bump());
  printf("%d %d\\n", r, calls);
  return 0;
}
`);

C('struct-by-value', `
#include <stdio.h>
struct pt { int x, y; };
struct big { int a[6]; char tag; };
struct pt mk(int x, int y) { struct pt p; p.x = x; p.y = y; return p; }
int sum(struct pt p) { p.x += 100; return p.x + p.y; }
struct pt add(struct pt a, struct pt b) { return mk(a.x + b.x, a.y + b.y); }
struct big mkbig(int seed) { struct big b; int i; for (i=0;i<6;i++) b.a[i]=seed+i; b.tag='B'; return b; }
int bigsum(struct big b) { int i, s = 0; for (i=0;i<6;i++) s += b.a[i]; return s + b.tag; }
int main(void) {
  struct pt p = mk(3, 4);
  printf("%d %d\\n", p.x, p.y);
  printf("%d %d %d\\n", sum(p), p.x, p.y);
  struct pt q = add(p, mk(10, 20));
  printf("%d %d\\n", q.x, q.y);
  printf("%d\\n", add(mk(1,2), mk(3,4)).x);
  struct big b = mkbig(5);
  printf("%d %c %d\\n", b.a[0], b.tag, bigsum(b));
  printf("%d\\n", mk(7,8).y);
  return 0;
}
`);

C('function-pointers', `
#include <stdio.h>
int add(int a, int b) { return a + b; }
int sub(int a, int b) { return a - b; }
int mul(int a, int b) { return a * b; }
int main(void) {
  int (*ops[3])(int, int);
  ops[0] = add; ops[1] = sub; ops[2] = mul;
  int i;
  for (i = 0; i < 3; i++) printf("%d ", ops[i](12, 4));
  printf("\\n");
  int (*f)(int, int) = add;
  printf("%d %d\\n", f(1, 2), f == add);
  printf("%d\\n", f == sub);
  return 0;
}
`);

C('strings', `
#include <stdio.h>
#include <string.h>
int main(void) {
  char buf[32];
  strcpy(buf, "abc");
  strcat(buf, "def");
  printf("%s %d\\n", buf, (int)strlen(buf));
  printf("%d %d\\n", strcmp("a", "b"), strcmp("b", "a"));
  printf("%d\\n", strcmp("same", "same"));
  const char *s = "hello";
  printf("%c%c%c\\n", s[0], s[1], s[4]);
  memset(buf, 'x', 4);
  buf[4] = 0;
  printf("%s\\n", buf);
  return 0;
}
`);

C('malloc', `
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  int *p = (int *)malloc(10 * sizeof(int));
  int i, s = 0;
  for (i = 0; i < 10; i++) p[i] = i * i;
  for (i = 0; i < 10; i++) s += p[i];
  printf("%d\\n", s);
  int *q = (int *)malloc(4);
  *q = 123;
  printf("%d %d\\n", *q, p != q);
  free(q); free(p);
  return 0;
}
`);

// NB: the three calls are sequenced into separate statements ON PURPOSE. Argument evaluation order
// is UNSPECIFIED in C — gcc evaluates printf's arguments right to left — so a single
// printf("%d %d %d", tick(), tick(), tick()) tests the compiler's choice, not its correctness.
C('static-locals', `
#include <stdio.h>
int tick(void) { static int n = 10; return ++n; }
int main(void) {
  int a = tick(); int b = tick(); int c = tick();
  printf("%d %d %d\\n", a, b, c);
  return 0;
}
`);

C('bitfields-run', `
#include <stdio.h>
struct flags { unsigned a : 3; unsigned b : 5; int c : 20; };
int main(void) {
  struct flags f;
  f.a = 5; f.b = 30; f.c = -1000;
  printf("%u %u %d\\n", f.a, f.b, f.c);
  f.a = 9;                       /* overflows 3 bits: keeps the low 3 */
  printf("%u\\n", f.a);
  return 0;
}
`);

C('casts-and-chars', `
#include <stdio.h>
int main(void) {
  int big = 300;
  char c = (char)big;
  unsigned char uc = (unsigned char)big;
  printf("%d %d\\n", c, uc);
  printf("%d\\n", (int)(char)-1);
  double d = 3.99;
  printf("%d %d\\n", (int)d, (int)-3.99);
  printf("%d\\n", (int)(short)70000);
  return 0;
}
`);

C('floats', `
#include <stdio.h>
int main(void) {
  double a = 1.5, b = 0.25;
  printf("%.4f %.4f %.4f %.4f\\n", a+b, a-b, a*b, a/b);
  float f = 1.0f / 3.0f;
  printf("%.6f\\n", (double)f);
  printf("%d\\n", (int)(a * 4));
  printf("%.2f\\n", (double)(int)2.99);
  return 0;
}
`);

C('logic-and-shortcircuit', `
#include <stdio.h>
int calls = 0;
int bump(void) { calls++; return 1; }
int main(void) {
  int r = 0 && bump();
  printf("%d %d\\n", r, calls);
  r = 1 || bump();
  printf("%d %d\\n", r, calls);
  r = 1 && bump();
  printf("%d %d\\n", r, calls);
  printf("%d %d %d\\n", !0, !5, !!5);
  return 0;
}
`);

// `printf("%d %d", i++, ++i)` is UNDEFINED, not merely unspecified: two unsequenced modifications
// of the same object. Sequenced into statements so the case tests ++ and -- instead of luck.
C('incdec', `
#include <stdio.h>
int main(void) {
  int i = 5;
  int p1 = i++; int p2 = i; int p3 = ++i; int p4 = i;
  printf("%d %d %d %d\\n", p1, p2, p3, p4);
  int a[3] = {0,0,0};
  int *p = a;
  *p++ = 1;
  *p++ = 2;
  printf("%d %d %d %d\\n", a[0], a[1], a[2], (int)(p - a));
  int j = 10;
  j += 5; j -= 2; j *= 3; j /= 4; j %= 7;
  printf("%d\\n", j);
  return 0;
}
`);

C('compound-assign-once', `
#include <stdio.h>
int idx = 0;
int next(void) { return idx++; }
int main(void) {
  int a[4] = {10, 20, 30, 40};
  a[next()] += 5;
  printf("%d %d %d %d %d\\n", a[0], a[1], a[2], a[3], idx);
  return 0;
}
`);

// A packed struct puts members at offsets that are NOT multiples of their own size, which is what
// exposes an address expression whose precedence is wrong: `((p)|0+2|0)` parses as `p|2`, and on an
// aligned base `p|4` happens to equal `p+4` — so an ordinary struct hides the bug entirely.
C('packed-access-through-pointer', `
#include <stdio.h>
struct P { char c; short s __attribute__((packed)); int i __attribute__((packed)); double d __attribute__((packed)); };
int readback(struct P *p) { return p->s == 258 && p->i == 70000 && p->d == 2.5; }
int main(void) {
  struct P p;
  p.c = 7; p.s = 258; p.i = 70000; p.d = 2.5;
  printf("%d %d %d %d %.1f %d\\n", (int)sizeof(struct P), p.c, p.s, p.i, p.d, readback(&p));
  return 0;
}
`);

// wchar_t is 4 bytes on i386, so a wide literal is an array of 32-bit elements — and the L prefix
// must be dropped BEFORE the quotes, not folded into the slice that removes them.
C('wide-literals', `
#include <stdio.h>
typedef __WCHAR_TYPE__ wchar_t;
wchar_t ws[] = L"abc";
wchar_t wc = L'Z';
int main(void) {
  printf("%d %d %d %d %d %d\\n", (int)sizeof(ws), (int)(sizeof(ws)/sizeof(wchar_t)),
         (int)ws[0], (int)ws[2], (int)ws[3], (int)wc);
  printf("%d %d\\n", (int)sizeof(L"ab"), (int)sizeof("ab"));
  return 0;
}
`);

C('union-punning', `
#include <stdio.h>
union u { int i; unsigned char b[4]; };
int main(void) {
  union u v;
  v.i = 0x01020304;
  printf("%d %d %d %d\\n", v.b[0], v.b[1], v.b[2], v.b[3]);
  v.b[0] = 0xff;
  printf("%x\\n", (unsigned)v.i);
  return 0;
}
`);

// 64-bit integers. tier-0 represents them as BigInt, so every crossing in and out of that world is
// explicit — a single missed conversion throws "Cannot mix BigInt and other types" rather than
// producing a wrong number, which is the failure mode worth having.
C('long-long', `
#include <stdio.h>
long long gbig = 1234567890123456789LL;
unsigned long long gu = 0xFEDCBA9876543210ULL;
long long twice(long long v) { return v * 2; }
int main(void) {
  long long a = 4000000000LL, b = 3;
  unsigned long long u = 0xFFFFFFFFFFFFFFFFULL;
  printf("%lld %lld %lld %lld\\n", a+b, a*b, a/b, a%b);
  printf("%lld %lld %lld\\n", -a, ~a, a << 8);
  printf("%lld %lld\\n", -a >> 4, (long long)((unsigned long long)-a >> 4));
  printf("%llu %llx %llo\\n", u, u, (unsigned long long)8);
  printf("%lld %llx\\n", gbig, gu);
  printf("%d %d %d %d\\n", a > b, a == 4000000000LL, !a, !(a-a));
  printf("%d %lld\\n", (int)(a & 0xFF), twice(a));
  printf("%d %lld %f\\n", (int)a, (long long)3.9, (double)a);
  printf("%d\\n", (int)sizeof(long long));
  long long acc = 0; int i;
  for (i = 0; i < 5; i++) acc += a;
  printf("%lld\\n", acc);
  return 0;
}
`);

C('printf-formats', `
#include <stdio.h>
int main(void) {
  printf("[%5d][%-5d][%05d]\\n", 42, 42, 42);
  printf("[%x][%X][%#x][%o]\\n", 255, 255, 255, 8);
  printf("[%s][%10s][%-10s]\\n", "ab", "ab", "ab");
  printf("[%c][%%]\\n", 'q');
  printf("[%.3f][%.0f][%8.2f]\\n", 3.14159, 2.5, 1.5);
  printf("[%u][%d]\\n", 4294967295U, -1);
  printf("[%+d][% d]\\n", 5, 5);
  return 0;
}
`);

// ---------------------------------------------------------------- run

C('offsetof-by-hand', `#include <stdio.h>

/*
 * How C spelled offsetof before it had one, in the two forms real code uses: the Windows SDK's
 * FIELD_OFFSET, which dereferences a null pointer, and OpenDUNE's, which uses 8 and subtracts it
 * back out to keep a null-dereference warning quiet. Both have to work in a STATIC INITIALISER,
 * which is where they are actually written.
 */
#define FIELD_OFFSET(t, f) ((long)&(((t *)0)->f))
#define OFFSET_8(t, f)     (((unsigned long)&((t *)8)->f) - 8)

struct inner { char pad; int deep; };
struct outer {
    char  a;
    int   b;
    short c[6];
    struct inner in;
    double d;
};

/* The table shape that made this matter: a static array whose entries are offsets. */
static const long table[] = {
    FIELD_OFFSET(struct outer, a),
    FIELD_OFFSET(struct outer, b),
    FIELD_OFFSET(struct outer, c),
    FIELD_OFFSET(struct outer, c[3]),
    FIELD_OFFSET(struct outer, in),
    FIELD_OFFSET(struct outer, in.deep),
    FIELD_OFFSET(struct outer, d),
};
static const unsigned long table8[] = {
    OFFSET_8(struct outer, a),
    OFFSET_8(struct outer, b),
    OFFSET_8(struct outer, c[3]),
    OFFSET_8(struct outer, in.deep),
    OFFSET_8(struct outer, d),
};

/* And in the places a constant expression is REQUIRED, not merely allowed. */
static char sized[FIELD_OFFSET(struct outer, d) + 1];

int main(void)
{
    int i;
    for (i = 0; i < (int)(sizeof table / sizeof table[0]); i++)
        printf("table[%d] = %ld\\n", i, table[i]);
    for (i = 0; i < (int)(sizeof table8 / sizeof table8[0]); i++)
        printf("table8[%d] = %lu\\n", i, table8[i]);
    printf("sizeof sized = %d\\n", (int)sizeof sized);
    switch ((int)sizeof sized) {
    case FIELD_OFFSET(struct outer, d) + 1: printf("case label folded\\n"); break;
    default: printf("case label WRONG\\n"); break;
    }
    return 0;
}
`);

C('duffs-device', `#include <stdio.h>

/*
 * The real thing, from Quake's vid_x.c: a case label INSIDE the loop the switch opens. Every
 * remainder class is exercised, because the whole point of the construction is that the entry point
 * depends on count % 8 -- a lowering that placed the labels wrongly would still be right for the
 * multiples of eight and wrong for everything else.
 */
static void copy(unsigned char *dst, const unsigned char *src, int count)
{
    int n;
    if (count <= 0) return;
    n = (count + 7) / 8;
    switch (count % 8) {
    case 0: do { *dst++ = *src++;
    case 7:      *dst++ = *src++;
    case 6:      *dst++ = *src++;
    case 5:      *dst++ = *src++;
    case 4:      *dst++ = *src++;
    case 3:      *dst++ = *src++;
    case 2:      *dst++ = *src++;
    case 1:      *dst++ = *src++;
            } while (--n > 0);
    }
}

/* The same shape with the labels under an if-statement rather than a loop, which is the other
   place C allows one and JavaScript does not. */
static int classify(int x)
{
    int r = 0;
    switch (x) {
    case 1: if (x > 0)
    case 2:     r += 10;
            r += 1;
            break;
    case 3: r = 99; break;
    default: r = -1;
    }
    return r;
}

int main(void)
{
    unsigned char src[32], dst[32];
    int i, k;
    for (i = 0; i < 32; i++) src[i] = (unsigned char)(i * 7 + 1);
    for (k = 0; k <= 20; k++) {
        int sum = 0;
        for (i = 0; i < 32; i++) dst[i] = 0;
        copy(dst, src, k);
        for (i = 0; i < 32; i++) sum += dst[i] * (i + 1);
        printf("copy %2d -> %d\\n", k, sum);
    }
    for (k = 0; k < 5; k++) printf("classify %d = %d\\n", k, classify(k));
    return 0;
}
`);

C('flatten-gotos', `#include <stdio.h>

/* Quake's edge-insert shape: labels inside a do-while, gotos jumping around them. */
static int search(int *a, int n, int want)
{
    int i = 0, hits = 0;
    do {
    again:
        if (i >= n) goto done;
        if (a[i] == want) goto found;
        i++;
        goto again;
    found:
        hits++;
        i++;
        goto again;
    done:
        break;
    } while (1);
    return hits;
}

/* A label inside a switch, jumped to from another arm — Quake's menu key handlers. */
static int keys(int k)
{
    int out = 0;
    switch (k) {
    case 1:
        out = 10;
        goto forward;
    case 2:
        out = 20;
        break;
    case 3:
    forward:
        out += 100;
        break;
    default:
        out = -1;
        break;
    }
    return out;
}

/* break and continue inside loops that get flattened because a label sits in one of them. */
static int loops(int n)
{
    int i, total = 0;
    for (i = 0; i < n; i++) {
        if (i % 3 == 0) continue;
        if (i > 12) break;
        total += i;
        if (total > 30) goto stop;
    }
    while (n > 0) {
        n--;
        total++;
    }
stop:
    return total;
}

/* A goto that lands inside a nested if — D_PolysetRecursiveTriangle's shape. */
static int nested(int x)
{
    int r = 0;
    if (x > 0) {
        if (x > 10) {
        deep:
            r += 1000;
            if (x > 100) r += 7;
            return r;
        }
        r += 1;
    }
    if (x == 5) goto deep;
    return r;
}

int main(void)
{
    int a[8];
    int i;
    for (i = 0; i < 8; i++) a[i] = i % 3;

    printf("search %d %d %d\\n", search(a, 8, 0), search(a, 8, 2), search(a, 8, 9));
    printf("keys %d %d %d %d\\n", keys(1), keys(2), keys(3), keys(9));
    printf("loops %d %d %d\\n", loops(5), loops(20), loops(0));
    printf("nested %d %d %d %d\\n", nested(-1), nested(3), nested(5), nested(200));
    return 0;
}
`);

/*
 * rand() must AGREE WITH THE REFERENCE, not merely be deterministic.
 *
 * `rand()` is implementation-defined, so any two libcs may differ and both be right -- which makes
 * it harmless until a program's OUTPUT depends on it, and then it silently invalidates every
 * comparison downstream. MAME 0.4 is where that happened: its Z80 core does `R.R = rand()` for the
 * refresh register and Wizard of Wor reads it with `LD A,R` to seed its own generator, so one
 * implementation-defined value reached the guest and changed the picture 266 frames later.
 *
 * This case exists so that never regresses silently. It checks the unseeded default and three
 * seeds, including 0 (which glibc maps to 1) -- and note that it can only pass against a glibc
 * reference, which is exactly what the oracle is.
 */
C('rand-matches-the-reference', `#include <stdio.h>
#include <stdlib.h>

static void run(const char *what)
{
    int i;
    printf("%s:", what);
    for (i = 0; i < 8; i++) printf(" %d", rand());
    printf("\\n");
}

int main(void)
{
    long a, b, c;
    run("unseeded");
    srand(1);      run("seed 1");
    srand(0);      run("seed 0");
    srand(12345);  run("seed 12345");
    srand(2147483647); run("seed INT_MAX");
    /*
     * random() is the same generator in glibc; rand() is defined as calling it.
     *
     * One call per statement, and that is not style: passing three random() calls as three printf
     * arguments tests the ORDER THEY ARE EVALUATED IN, which C leaves unspecified. The first draft
     * of this case did exactly that and "failed" -- the same three values, reversed, because gcc
     * evaluates arguments right-to-left and PRISM left-to-right. Both are correct; the test was not.
     */
    srandom(42);
    a = random(); b = random(); c = random();
    printf("random after srandom(42): %ld %ld %ld\\n", a, b, c);
    printf("RAND_MAX %d\\n", RAND_MAX);
    return 0;
}
`);

const active = cases.filter(c => !FILTER || c.name.includes(FILTER));
console.log(version());
console.log(`gate-run: ${active.length} cases\n`);

const dir = join(SCRATCH, 'run');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const [n, c] of active.entries()) writeFileSync(join(dir, `r${n}.c`), c.src);

const script = active.map((c, n) =>
  `echo "===CASE ${n}"; gcc -std=gnu89 -w -o /tmp/r${n} run/r${n}.c -lm 2>&1 && /tmp/r${n}; echo "===RC $?"`).join('; ');
const r = sh(script, { timeout: 900000 });

const ref = new Map();
{
  let cur = null, buf = [];
  for (const line of r.stdout.split('\n')) {
    let m = line.match(/^===CASE (\d+)$/);
    if (m) { cur = +m[1]; buf = []; continue; }
    m = line.match(/^===RC (\d+)$/);
    if (m) { ref.set(cur, { rc: +m[1], out: buf.join('\n') }); cur = null; continue; }
    if (cur !== null) buf.push(line);
  }
}

let pass = 0;
const fails = [];

for (const [n, c] of active.entries()) {
  const g = ref.get(n);
  if (!g) { fails.push({ c, why: 'no oracle output' }); continue; }

  let got;
  try {
    got = compile(c.src, { file: `r${n}.c` }).run();
  } catch (e) {
    fails.push({ c, why: `PRISM: ${e.message.split('\n')[0]}` });
    continue;
  }

  // gcc's stdout arrives split on newlines and rejoined, so compare the same normalisation.
  const ourOut = got.stdout.replace(/\n$/, '');
  const refOut = g.out.replace(/\n$/, '');
  if (ourOut === refOut && got.code === g.rc) {
    pass++;
    if (VERBOSE) console.log(`  ok   ${c.name}`);
    continue;
  }
  fails.push({
    c,
    why: got.code !== g.rc && ourOut === refOut
      ? `exit status: prism=${got.code} gcc=${g.rc}`
      : `stdout differs (exit prism=${got.code} gcc=${g.rc})\n` +
        `    prism: ${JSON.stringify(ourOut)}\n    gcc  : ${JSON.stringify(refOut)}`,
  });
}

console.log(`${pass}/${active.length} programs behave identically to a native i386 build`);
if (fails.length) {
  console.log(`\n${fails.length} failing:\n`);
  for (const f of fails) console.log(`--- ${f.c.name}\n    ${f.why}\n`);
  process.exit(1);
}
