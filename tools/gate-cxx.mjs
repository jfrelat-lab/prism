// gate-cxx.mjs — PRISM's C++ front end (src/cxx) runs a program; g++ runs the same source; they agree.
//
// The method is gate-run.mjs's, for .cpp: everything written to stdout, byte for byte, and the exit
// status, against g++ -std=gnu++98 in the oracle container. Each case is one thing the language
// promises that C has no word for -- when a constructor runs, which overload a call means, what a
// virtual call reaches, when a temporary dies -- written so that getting it wrong prints something
// else. Constructors and destructors PRINT in several cases: the order and the count of those lines
// is the lifetime rule under test.
//
// The subset is the one src/cxx/parse.js states (no exceptions, RTTI, namespaces or member templates).
//
//   node tools/gate-cxx.mjs [--verbose] [filter]
import { sh, SCRATCH, version } from './oracle.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '../src/compile.js';

const VERBOSE = process.argv.includes('--verbose');
const FILTER = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? null;
const cases = [];
const C = (name, src) => cases.push({ name, src });

C('class-methods-operators', `
#include <stdio.h>
class Vec {
public:
    float x, y;
    Vec() : x(0), y(0) {}
    Vec(float a, float b) : x(a), y(b) {}
    Vec operator+(const Vec &o) const { return Vec(x + o.x, y + o.y); }
    Vec &operator+=(const Vec &o) { x += o.x; y += o.y; return *this; }
    Vec operator-() const { return Vec(-x, -y); }
    bool operator==(const Vec &o) const { return x == o.x && y == o.y; }
    float dot(const Vec &o) const { return x * o.x + y * o.y; }
    float &operator[](int i) { return i ? y : x; }
    float operator[](int i) const { return i ? y : x; }
};
static Vec scale(const Vec &v, float s) { return Vec(v.x * s, v.y * s); }
Vec operator*(float s, const Vec &v) { return scale(v, s); }
int main() {
    Vec a(1, 2), b(3, 4);
    Vec c = a + b;
    c += scale(a, 2);
    c[0] = c[0] + 10;
    const Vec d = -(2 * c);
    printf("%g %g %g %g %g %d %d\\n", c.x, c.y, a.dot(b), d[0], d[1], a == b, a == Vec(1, 2));
    return 0;
}
`);

// The order: bases before members before the body; destruction the reverse; a block's objects die
// at its brace, last first; a return runs every destructor on its way out.
C('lifetime-order', `
#include <stdio.h>
struct Noisy {
    int id;
    Noisy(int i) : id(i) { printf("+%d ", id); }
    Noisy(const Noisy &o) : id(o.id + 100) { printf("c%d ", id); }
    ~Noisy() { printf("-%d ", id); }
};
struct Base { Noisy b; Base() : b(1) { printf("B "); } ~Base() { printf("~B "); } };
struct Derived : Base {
    Noisy m2, m1;
    Derived() : m1(3), m2(2) { printf("D "); }       // listed backwards: declaration order rules
    ~Derived() { printf("~D "); }
};
static int early(int n) {
    Noisy a(10);
    if (n) { Noisy b(11); return 1; }
    Noisy c(12);
    return 0;
}
static void loop() {
    for (int i = 0; i < 3; i++) {
        Noisy x(20 + i);
        if (i == 1) continue;
        if (i == 2) break;
        printf("body ");
    }
}
int main() {
    { Derived d; printf("| "); }
    printf("\\n");
    printf("%d ", early(1)); printf("%d\\n", early(0));
    loop();
    printf("\\n");
    return 0;
}
`);

C('virtual-dispatch', `
#include <stdio.h>
class Shape {
public:
    virtual ~Shape() { printf("~Shape "); }
    virtual float area() const { return 0; }
    virtual const char *name() const = 0;
    void describe() const { printf("%s %g\\n", name(), area()); }
};
class Rect : public Shape {
protected:
    float w, h;
public:
    Rect(float a, float b) : w(a), h(b) {}
    ~Rect() { printf("~Rect "); }
    float area() const { return w * h; }
    const char *name() const { return "rect"; }
};
class Square : public Rect {
public:
    Square(float s) : Rect(s, s) {}
    const char *name() const { return "square"; }
};
int main() {
    Shape *s[2];
    s[0] = new Rect(2, 3);
    s[1] = new Square(4);
    for (int i = 0; i < 2; i++) s[i]->describe();
    Rect r(5, 6);
    Shape &ref = r;
    Square *sq = (Square *)s[1];
    printf("%g %g %s\\n", ref.area(), sq->Rect::area(), sq->Rect::name());
    delete s[0]; delete s[1];
    printf("\\n");
    return 0;
}
`);

// Which function a call means: exact over promotion over conversion over user-defined.
C('overload-resolution', `
#include <stdio.h>
static void f(int)           { printf("int "); }
static void f(unsigned)      { printf("unsigned "); }
static void f(char)          { printf("char "); }
static void f(double)        { printf("double "); }
static void f(const char *)  { printf("cstr "); }
static void f(void *)        { printf("ptr "); }
struct S { S(int) {} };
static void g(S)             { printf("S "); }
static void g(double)        { printf("double "); }
static void h(const int &)   { printf("cref "); }
static void h(int &)         { printf("ref "); }
static void k(long)          { printf("long "); }
static void k(float)         { printf("float "); }
int main() {
    short sh = 1; float fl = 1; int i = 0; const int ci = 0; char buf[4];
    f(1); f(1u); f('a'); f(1.5); f(fl); f(sh); f("x"); f(buf); f(&i);
    printf("\\n");
    g(1); g(1.5f); h(i); h(ci); h(3); k(1.0f); k(1L);
    printf("\\n");
    return 0;
}
`);

// A string class with every special member: copies, assignments and temporaries all counted.
C('string-class', `
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static int live;
class Str {
    char *p;
    void set(const char *s) { p = (char *)malloc(strlen(s) + 1); strcpy(p, s); live++; }
public:
    Str() { set(""); }
    Str(const char *s) { set(s); }
    Str(const Str &o) { set(o.p); }
    ~Str() { free(p); live--; }
    Str &operator=(const Str &o) { if (this != &o) { free(p); live--; set(o.p); } return *this; }
    Str &operator+=(const Str &o) { char *n = (char *)malloc(strlen(p) + strlen(o.p) + 1); strcpy(n, p); strcat(n, o.p); free(p); p = n; return *this; }
    friend Str operator+(const Str &a, const Str &b) { Str r(a); r += b; return r; }
    friend bool operator==(const Str &a, const Str &b) { return !strcmp(a.p, b.p); }
    operator const char *() const { return p; }
    int length() const { return (int)strlen(p); }
};
static Str greet(Str who) { return Str("hello ") + who; }
int main() {
    {
        Str a("ab"), b = "cd", c;
        c = a + b + "ef";
        Str d = greet(c);
        printf("%s %s %d %d %d\\n", (const char *)c, (const char *)d, d.length(), c == Str("abcdef"), a == b);
        if (c) printf("live inside %d\\n", live);
        const char *raw = d;
        printf("%s\\n", raw);
    }
    printf("live after %d\\n", live);
    return 0;
}
`);

C('templates', `
#include <stdio.h>
template< class type >
class List {
    int num, size;
    type *list;
public:
    List(int granularity = 4);
    ~List();
    int Append(type const &obj);
    type &operator[](int i);
    int Num() const { return num; }
    typedef int cmp_t(const type &, const type &);
    void Sort(cmp_t *cmp);
};
template< class type > inline List<type>::List(int granularity) { num = 0; size = granularity; list = new type[size]; }
template< class type > inline List<type>::~List() { delete[] list; }
template< class type > inline int List<type>::Append(type const &obj) {
    if (num == size) { type *n = new type[size * 2]; for (int i = 0; i < num; i++) n[i] = list[i]; delete[] list; list = n; size *= 2; }
    list[num] = obj;
    return num++;
}
template< class type > inline type &List<type>::operator[](int i) { return list[i]; }
template< class type > inline void List<type>::Sort(cmp_t *cmp) {
    for (int i = 0; i < num; i++) for (int j = i + 1; j < num; j++) if (cmp(list[j], list[i]) < 0) { type t = list[i]; list[i] = list[j]; list[j] = t; }
}
struct P { int a; P() : a(-1) {} P(int x) : a(x) {} };
static int byInt(const int &a, const int &b) { return a - b; }
static int byP(const P &a, const P &b) { return b.a - a.a; }
int main() {
    List<int> li;
    for (int i = 0; i < 10; i++) li.Append((i * 7) % 10);
    li.Sort(byInt);
    for (int i = 0; i < li.Num(); i++) printf("%d ", li[i]);
    List<P> lp(2);
    lp.Append(P(3)); lp.Append(5); lp.Append(P(4));
    lp.Sort(byP);
    printf("| %d %d %d", lp[0].a, lp[1].a, lp[2].a);
    List<const char *> ls;
    ls.Append("x"); ls.Append("y");
    printf(" | %s%s %d\\n", ls[0], ls[1], ls.Num());
    return 0;
}
`);

// Objects at file scope: built before main in the order written, destroyed after it in reverse.
C('globals-and-statics', `
#include <stdio.h>
#include <math.h>
struct Counter {
    static int made;
    int id;
    Counter() : id(++made) { printf("ctor %d\\n", id); }
    ~Counter() { printf("dtor %d\\n", id); }
    static int count() { return made; }
};
int Counter::made = 0;
Counter one;
static Counter many[2];
static float root = sqrtf(16.0f);
static const int N = 3;
static int table[N] = { 1, 2, 3 };
static Counter &lazy() { static Counter c; return c; }
int main() {
    printf("main %d %g %d\\n", Counter::count(), root, table[N - 1]);
    lazy(); lazy();
    printf("after lazy %d\\n", one.count());
    return 0;
}
`);

C('new-delete-arrays', `
#include <stdio.h>
struct T {
    int v;
    T() : v(7) { printf("T() "); }
    T(int x) : v(x) { printf("T(%d) ", x); }
    ~T() { printf("~T(%d) ", v); }
};
int main() {
    T *one = new T(3);
    T *arr = new T[3];
    arr[1].v = 9;
    int *raw = new int[4];
    raw[3] = one->v + arr[0].v + arr[1].v;
    printf("| %d | ", raw[3]);
    delete one;
    delete[] arr;
    delete[] raw;
    T *none = 0;
    delete none;
    printf("\\n");
    return 0;
}
`);

// Conversions the compiler inserts: a constructor from one argument, a conversion function, a
// derived class where its base is wanted, an enum where an int is.
C('implicit-conversions', `
#include <stdio.h>
class Meters {
    double m;
public:
    Meters(double v) : m(v) {}
    operator double() const { return m; }
    Meters operator+(const Meters &o) const { return Meters(m + o.m); }
};
struct Animal { int legs; Animal(int l) : legs(l) {} int count() const { return legs; } };
struct Dog : Animal { Dog() : Animal(4) {} };
static int legs(const Animal &a) { return a.count(); }
static int legsp(const Animal *a) { return a->count(); }
static double twice(double d) { return d * 2; }
enum Colour { RED, GREEN = 5, BLUE };
int main() {
    Meters a = 1.5, b(2);
    Meters c = a + Meters(3);
    Dog d;
    Colour col = BLUE;
    int n = col + 1;
    printf("%g %g %g %d %d %d %d\\n", twice(c), (double)(a + b), (double)c + 0.5, legs(d), legsp(&d), n, GREEN);
    return 0;
}
`);

C('default-args-statics-refs', `
#include <stdio.h>
struct Acc {
    int total;
    Acc() : total(0) {}
    Acc &add(int a, int b = 10, int c = 100) { total += a + b + c; return *this; }
    static int twice(int v = 21) { return v * 2; }
};
static void swap(int &a, int &b) { int t = a; a = b; b = t; }
static int &pick(int &a, int &b, bool first) { return first ? a : b; }
static const int &clamp(const int &v, const int &lo = 0, const int &hi = 9) { return v < lo ? lo : v > hi ? hi : v; }
int main() {
    Acc acc;
    acc.add(1).add(1, 2).add(1, 2, 3);
    int x = 1, y = 2;
    swap(x, y);
    pick(x, y, false) = 50;
    int &r = x;
    r++;
    printf("%d %d %d %d %d %d %d\\n", acc.total, Acc::twice(), Acc::twice(4), x, y, clamp(12), clamp(-3, -1));
    return 0;
}
`);

const active = cases.filter((c) => !FILTER || c.name.includes(FILTER));
console.log(version());
console.log(`gate-cxx: ${active.length} cases\n`);
const dir = join(SCRATCH, 'cxx');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const [n, c] of active.entries()) writeFileSync(join(dir, `x${n}.cpp`), c.src);
const script = active.map((c, n) =>
  `echo "===CASE ${n}"; g++ -std=gnu++98 -w -o /tmp/x${n} cxx/x${n}.cpp -lm 2>&1 && /tmp/x${n}; rc=$?; echo; echo "===RC $rc"`).join('; ');
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
  try { got = compile(c.src, { file: `x${n}.cpp` }).run(); } catch (e) { fails.push({ c, why: `PRISM: ${e.message.split('\n')[0]}` }); continue; }
  const ours = got.stdout.replace(/\n$/, ''), theirs = g.out.replace(/\n$/, '');
  if (ours === theirs && got.code === g.rc) { pass++; if (VERBOSE) console.log(`  ok   ${c.name}`); continue; }
  fails.push({ c, why: `stdout differs (exit prism=${got.code} g++=${g.rc})\n    prism: ${JSON.stringify(ours)}\n    g++  : ${JSON.stringify(theirs)}` });
}
console.log(`${pass}/${active.length} C++ programs behave identically to a native i386 g++ build`);

/*
 * THE OPTION (compile.cxx, src/cxx/index.js): which units are C++, and in which dialect. No oracle
 * is needed for these -- each says what the option must make of one small program, and gcc's own
 * `-x c++` is the behaviour copied. A check that could not fail would be worth nothing, so each
 * pair is a build that must work beside the same build that must not.
 */
if (!FILTER) {
  const CLASS = '#include <stdio.h>\nclass A { int v; public: A(int x) : v(x) {} int twice() const { return v * 2; } };\nint main() { A a(21); printf("%d\\n", a.twice()); return 0; }\n';
  const PLAIN = '#include <stdio.h>\nint main(void) { int class = 42; printf("%d\\n", class); return 0; }\n';
  const out = (src, file, cxx) => { try { return compile(src, { file, cxx }).run().stdout.trim(); } catch (e) { return `refused: ${e.message.split('\n')[0]}`; } };
  const option = [
    ['a .c unit named C++ by the option runs as C++', out(CLASS, 'unit.c', { language: { '*': 'c++' } }) === '42'],
    ['...and is refused as C without it', out(CLASS, 'unit.c').startsWith('refused')],
    ['a .cpp unit named C by the option is read as C (`class` is an identifier)', out(PLAIN, 'unit.cpp', { language: { '*.cpp': 'c' } }) === '42'],
    ['...and is refused as C++ without it', out(PLAIN, 'unit.cpp').startsWith('refused')],
    ['cxx: false makes every unit C', out(PLAIN, 'unit.cpp', false) === '42'],
    ['an exact unit path wins over a pattern', out(CLASS, 'src/unit.c', { language: { 'unit.c': 'c++', '*.c': 'c', '*': 'c' } }) === '42'],
    ['std gnu++98 is accepted', out(CLASS, 'unit.cpp', { std: 'gnu++98' }) === '42'],
    ['std c++17 is refused by name', /^refused: .*c\+\+17.*C\+\+98/.test(out(CLASS, 'unit.cpp', { std: 'c++17' }))],
    ['a language that is neither c nor c++ is refused', /^refused: .*'c' or 'c\+\+'/.test(out(CLASS, 'unit.cpp', { language: { '*': 'objc' } }))],
    ['a key the option does not have is refused', /^refused: .*no 'standard'/.test(out(CLASS, 'unit.cpp', { standard: 'c++98' }))],
  ];
  for (const [what, ok] of option) {
    if (ok) { pass++; if (VERBOSE) console.log(`  ok   option: ${what}`); } else fails.push({ c: { name: `option: ${what}` }, why: 'the option did not do that' });
  }
  console.log(`${option.filter(([, ok]) => ok).length}/${option.length} checks of the compile.cxx option`);
}
if (fails.length) {
  console.log(`\n${fails.length} failing:\n`);
  for (const f of fails) console.log(`--- ${f.c.name}\n    ${f.why}\n`);
  process.exit(1);
}
