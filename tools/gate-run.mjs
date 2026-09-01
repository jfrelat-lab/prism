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
