// gate-cxx.mjs — PRISM's C++ front end (src/cxx) runs a program; g++ runs the same source; they agree.
//
// The method is gate-run.mjs's, for .cpp: everything written to stdout, byte for byte, and the exit
// status, against g++ -std=gnu++98 in the oracle container. Each case is one thing the language
// promises that C has no word for -- when a constructor runs, which overload a call means, what a
// virtual call reaches, when a temporary dies -- written so that getting it wrong prints something
// else. Constructors and destructors PRINT in several cases: the order and the count of those lines
// is the lifetime rule under test.
//
// The subset is the one src/cxx/parse.js states: no exceptions, no typeid, no member templates, no
// virtual bases. Seven cases were written for ScummVM 0.6.1 (namespaces, function templates and their
// value parameters, two polymorphic bases and dynamic_cast, pointers to member functions, conditions
// that declare, file-scope aggregates that read variables, functions used before their definition),
// each on the shape that program has.
//
//   node tools/gate-cxx.mjs [--verbose] [filter]
import { sh, SCRATCH, version } from './oracle.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compile, compileProgram, builtinHeaderResolver } from '../src/compile.js';

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

// Namespaces as ScummVM 0.6.1 uses them: Common, GUI and each engine's own, reopened across headers,
// with using-directives in its .cpp files and operators found through their operands' namespace.
C('namespaces', `
#include <stdio.h>
namespace Common {
int count = 3;
struct Point { int x, y; Point(int a, int b) : x(a), y(b) {} int sum() const; };
Point operator+(const Point &a, const Point &b) { return Point(a.x + b.x, a.y + b.y); }
int twice(int v) { return 2 * v; }
namespace Inner { int depth() { return 2; } }
}
namespace Common {
int Point::sum() const { return x + y + count; }
int twice(double v) { return (int)(v * 4); }
}
namespace Sky {
int twice(int v) { return 20 * v; }
class Logic { public: int run(int v); static int calls; };
int Logic::calls = 0;
}
int Sky::Logic::run(int v) { calls++; return twice(v) + Common::twice(v); }
namespace {
int hidden = 41;
int bump() { return ++hidden; }
}
namespace CI = Common::Inner;
using Common::Point;
int main() {
    Point p(1, 2), q(10, 20);
    Point r = p + q;
    Sky::Logic l;
    printf("%d %d %d %d\\n", r.x, r.y, r.sum(), l.run(1));
    {
        using namespace Common;
        printf("%d %d %d %d\\n", twice(5), twice(1.5), count, CI::depth());
    }
    int b = bump();
    printf("%d %d %d\\n", b, hidden, Sky::Logic::calls);
    return 0;
}
`);

// Function templates, value parameters, an explicit specialisation and a default argument, the way
// ScummVM 0.6.1 writes them: common/util.h's MIN/MAX/SWAP, the scalers' template<int bitFormat>
// over ColorMasks<565> and <555>, and Common::Map's comparator.
C('function-templates', `
#include <stdio.h>
template<typename T> inline T ABS(T x) { return (x >= 0) ? x : -x; }
template<typename T> inline T MIN(T a, T b) { return (a < b) ? a : b; }
template<typename T> inline void SWAP(T &a, T &b) { T tmp = a; a = b; b = tmp; }
int MIN(int a, int b) { return a < b ? a - 1000 : b - 1000; }
template<int bitFormat> struct ColorMasks { };
template<> struct ColorMasks<565> { enum { highBits = 0xF7DEF7DE, greenMask = 0x07E0 }; };
template<> struct ColorMasks<555> { enum { highBits = 0x7BDE7BDE, greenMask = 0x03E0 }; };
template<int bitFormat> static inline unsigned int HALF(unsigned int a) { return (a & ColorMasks<bitFormat>::highBits) >> 1; }
template<int bitFormat, int w1, int w2> static inline int MIX(int p, int q) { return (HALF<bitFormat>(p) * w1 + q * w2) / (w1 + w2); }
template<class T> struct Less { int operator()(const T &x, const T &y) const { return x < y ? -1 : y < x ? 1 : 0; } };
template<class K, class V, class C = Less<K> > struct Pair {
    K k; V v;
    int cmp(const K &o) const { C c; return c(k, o); }
};
template<class T> struct Box { T v; };
int main() {
    double d = -2.5;
    short s1 = 3, s2 = 7;
    printf("%d %g %d %d\\n", ABS(-4), ABS(d), MIN(s1, s2), MIN(3, 9));
    unsigned u1 = 5, u2 = 9;
    SWAP(u1, u2);
    const char *a = "a", *b = "b";
    SWAP(a, b);
    printf("%u %u %s %s %g\\n", u1, u2, a, b, MIN<double>(1, 0.5));
    printf("%x %x %d %d\\n", HALF<565>(0xffffffffu), HALF<555>(0xffffffffu), MIX<565, 1, 3>(64, 8), (int)ColorMasks<555>::greenMask);
    Pair<int, const char *> p; p.k = 4; p.v = "x";
    Box<Box<int> > bb; bb.v.v = 6;
    printf("%d %d %d %s %d\\n", p.cmp(3), p.cmp(4), p.cmp(5), p.v, bb.v.v);
    return 0;
}
`);

// Two polymorphic bases, as ScummVM's GUI has them (ButtonWidget : StaticTextWidget, CommandSender):
// the second base's table, the thunks that adjust `this`, and dynamic_cast down and across.
C('multiple-polymorphic-bases', `
#include <stdio.h>
struct Pad { int pad[3]; };
class CommandSender { public: int sent; CommandSender() : sent(0) {} virtual ~CommandSender() {} virtual int send(int c) { sent += c; return 1; } };
class Widget { public: int id; Widget(int i) : id(i) {} virtual ~Widget() {} virtual int draw() { return id; } virtual const char *kind() { return "widget"; } };
class Static : public Widget { public: Static(int i) : Widget(i) {} virtual int draw() { return 100 + id; } };
class Button : public Static, public CommandSender {
public:
    int pressed;
    Button(int i) : Static(i), pressed(0) {}
    ~Button() { printf("~Button %d\\n", id); }
    virtual int send(int c) { pressed += c; return 2; }
    virtual const char *kind() { return "button"; }
};
class Odd : public Pad, public Widget { public: Odd() : Widget(7) {} virtual int draw() { return pad[0] + id; } };
static int sendThrough(CommandSender *s, int c) { return s->send(c); }
int main() {
    Button *b = new Button(5);
    Widget *w = b;
    CommandSender *cs = b;
    int r = sendThrough(cs, 3);
    printf("%d %s %d %d %d\\n", w->draw(), w->kind(), r, b->pressed, cs->sent);
    Button *back = dynamic_cast<Button *>(cs);
    Static *st = dynamic_cast<Static *>(cs);
    CommandSender *across = dynamic_cast<CommandSender *>(w);
    Widget *plain = new Widget(1);
    printf("%d %d %d %d %d\\n", back == b, st == b, across == cs, dynamic_cast<Button *>(plain) == 0, dynamic_cast<Button *>((Widget *)0) == 0);
    Odd o; o.pad[0] = 30;
    Widget *ow = &o;
    printf("%d %d\\n", ow->draw(), dynamic_cast<Odd *>(ow) == &o);
    delete w;
    delete plain;
    return 0;
}
`);

// Pointers to member functions, the way ScummVM 0.6.1 has them: Sky::Logic's static table of
// actions called through this->*, and the CRTP Debugger<T> that keeps its commands in a struct.
C('member-pointers', `
#include <stdio.h>
#include <string.h>
namespace Sky {
class Logic {
public:
    int steps;
    Logic() : steps(0) {}
    void nop() { steps += 1; }
    void walk() { steps += 10; }
    virtual void talk() { steps += 100; }
    virtual ~Logic() {}
    void run(int which);
};
class Chatty : public Logic { public: virtual void talk() { steps += 1000; } };
typedef void (Logic::*LogicTable)();
static const LogicTable logicTable[] = { &Logic::nop, &Logic::walk, &Logic::talk };
void Logic::run(int which) { (this->*logicTable[which])(); }
}
template <class T> class Debugger {
public:
    typedef int (T::*DebugProc)(int argc, const char **argv);
    struct DCmd { char name[16]; DebugProc function; };
    DCmd cmds[4]; int n;
    Debugger() : n(0) {}
    void reg(const char *name, DebugProc p) { strcpy(cmds[n].name, name); cmds[n].function = p; n++; }
    int run(const char *name, int argc) {
        for (int i = 0; i < n; i++) if (!strcmp(cmds[i].name, name)) return (((T *)this)->*cmds[i].function)(argc, 0);
        return -1;
    }
};
class SkyDebugger : public Debugger<SkyDebugger> {
public:
    int base;
    SkyDebugger() : base(40) { reg("exit", &SkyDebugger::cmdExit); reg("add", &SkyDebugger::cmdAdd); }
    int cmdExit(int argc, const char **argv) { return 0; }
    int cmdAdd(int argc, const char **argv) { return base + argc; }
};
int main() {
    Sky::Logic l; Sky::Chatty c;
    for (int i = 0; i < 3; i++) { l.run(i); c.run(i); }
    Sky::LogicTable none = 0, some = &Sky::Logic::walk;
    Sky::Logic *p = &c;
    (p->*some)();
    (c.*Sky::logicTable[2])();
    printf("%d %d %d %d\\n", l.steps, c.steps, none == 0, some != 0);
    SkyDebugger d;
    printf("%d %d %d\\n", d.run("add", 2), d.run("exit", 1), d.run("none", 0));
    return 0;
}
`);

// A declaration as a condition, as Sky::Logic::engine walks its list: `while (uint16 id = *logicList++)`.
C('condition-declarations', `
#include <stdio.h>
static unsigned short list[] = { 3, 0xffff, 7, 9, 0 };
int main() {
    unsigned short *p = list;
    int sum = 0, marks = 0;
    while (unsigned short id = *p++) { if (id == 0xffff) { marks++; continue; } sum += id; }
    if (int left = (int)(p - list)) printf("%d %d %d\\n", sum, marks, left);
    for (int i = 0; int sq = (3 - i) * (3 - i); i++) sum += sq;
    switch (int k = sum % 5) { case 0: printf("zero %d\\n", k); break; default: printf("k %d %d\\n", k, sum); }
    return 0;
}
`);

// File-scope aggregates that read other variables -- Sky's compact tables point at uint16 *left_table2,
// which C cannot take as a constant -- and a label followed by a declaration (Sky::Logic::script).
C('dynamic-aggregates', `
#include <stdio.h>
typedef unsigned short uint16;
struct Compact { uint16 logic; uint16 *getToTable; uint16 extra[2]; };
static uint16 junk1[4] = { 11, 22, 33, 44 };
uint16 *left_table2 = (uint16 *)(&junk1);
uint16 base = 5;
Compact left_exit = { 1, left_table2, { 7, 8 } };
Compact *const compacts[] = { &left_exit };
static const Compact table[2] = { { 2, &junk1[1], { 0, 0 } }, { 3, left_table2 + 2, { base, 9 } } };
int main() {
    int n = 0;
again:
    int k = n * 2;
    if (++n < 3) goto again;
    printf("%d %d %d %d\\n", compacts[0]->logic, compacts[0]->getToTable[1], left_exit.extra[1], k);
    printf("%d %d %d\\n", table[0].getToTable[0], table[1].getToTable[0], table[1].extra[0]);
    return 0;
}
`);

// Functions used before their definition is seen: Sky::Logic's table of member pointers above the
// functions, Common::String's virtual destructor defined below the vtable that needs it.
C('used-before-defined', `
#include <stdio.h>
class Str { public: int n; Str() : n(3) {} virtual ~Str(); virtual int len() const; };
class Logic { public: int acc; Logic() : acc(0) {} void a(); void b(); void run(int i); };
typedef void (Logic::*Fn)();
static const Fn table[] = { &Logic::a, &Logic::b };
static int helper(int x);
int twice(int x) { return helper(x) * 2; }
void Logic::run(int i) { (this->*table[i])(); }
void Logic::a() { acc += 1; }
void Logic::b() { acc += twice(5); }
static int helper(int x) { return x + 1; }
Str::~Str() { printf("~Str %d\\n", n); }
int Str::len() const { return n * 10; }
int main() {
    Logic l; l.run(0); l.run(1);
    Str *p = new Str();
    printf("%d %d\\n", l.acc, p->len());
    delete p;
    return 0;
}
`);

// Shapes of ScummVM's SCUMM engine: a ?: whose value is an object (ScummEngine's _gameName), an array
// sized by sizeof (player_v2.h's ChannelInfo), and byte ** to const byte *const * (script.cpp).
C('scumm-shapes', `
#include <stdio.h>
#include <string.h>
static int live = 0;
class Str {
public:
    char buf[32];
    Str(const char *s) { strcpy(buf, s); live++; }
    Str(const Str &o) { strcpy(buf, o.buf); live++; }
    ~Str() { live--; }
    Str &operator=(const Str &o) { strcpy(buf, o.buf); return *this; }
};
static Str get(int i) { return Str(i ? "config" : "other"); }
struct channel_data { unsigned short a, b, c, d; unsigned char e[6]; };
union ChannelInfo { channel_data d; unsigned short array[sizeof(channel_data) / 2]; };
typedef unsigned char byte;
int main() {
    {
        Str name("start");
        const char *base = 0, *fallback = "gamename";
        for (int i = 0; i < 2; i++) {
            name = i ? get(1) : base ? base : fallback;
            printf("%s ", name.buf);
        }
        Str other = (live > 0) ? get(0) : Str("none");
        printf("%s %d\\n", other.buf, (int)sizeof(ChannelInfo));
    }
    byte items[3] = { 7, 8, 9 };
    byte *ptrs[3] = { &items[0], &items[1], &items[2] };
    const byte *const *last = &ptrs[1];
    ChannelInfo ci; ci.d.a = 5;
    printf("%d %d live %d\\n", **last, ci.array[0], live);
    return 0;
}
`);

// Temporaries made in only one branch of ?:, && or ||: destroyed only when that branch ran. ScummEngine's
// _gameName = ConfMan.hasKey("basename") ? ConfMan.get("basename") : ... destroyed a String it never built.
C('conditional-temporaries', `
#include <stdio.h>
#include <string.h>
static int made = 0, gone = 0;
struct Str {
    char *p;
    Str(const char *s) { p = new char[strlen(s) + 1]; strcpy(p, s); made++; }
    Str(const Str &o) { p = new char[strlen(o.p) + 1]; strcpy(p, o.p); made++; }
    ~Str() { delete[] p; p = 0; gone++; }
};
static int has(const Str &k) { return k.p[0] == 'b'; }
static int len(const Str &s) { return (int)strlen(s.p); }
int main() {
    int total = 0;
    for (int i = 0; i < 4; i++) {
        total += (i & 1) ? len(Str("basename")) : 0;
        total += (i > 1 && has(Str("b"))) ? 10 : 0;
        total += (i == 0 || len(Str("xyz")) == 3) ? 100 : 0;
        Str name = has(Str(i & 2 ? "b" : "a")) ? Str("yes") : Str("no");
        printf("%s ", name.p);
    }
    printf("\\n%d %d %d\\n", total, made, gone);
    return 0;
}
`);

// Multi-character constants, folded as gcc folds them (each character shifts left by eight): SCUMM
// finds its resources by MKID('SMAP') in case labels, and a C++ front end that kept the first
// character alone matched none of them.
C('multichar-constants', `
#include <stdio.h>
#define MKID(a) (((a) >> 24) & 0xFF) | (((a) >> 8) & 0xFF00) | (((a) << 8) & 0xFF0000) | (((a) << 24) & 0xFF000000)
enum { RMIH = 'RMIH', TWO = 'ab', ONE = 'z', ESC = '\\n', QUOTE = '\\'', OCT = '\\101' };
static int kind(unsigned int tag) {
    switch (tag) {
    case MKID('SMAP'): return 1;
    case MKID('RMIH'): return 2;
    default: return 0;
    }
}
int main() {
    unsigned int smap = MKID('SMAP');
    printf("%x %x %d %d %d %d\\n", (unsigned)RMIH, (unsigned)TWO, ONE, ESC, QUOTE, OCT);
    printf("%d %d %d\\n", kind(smap), kind(MKID('RMIH')), kind(7));
    return 0;
}
`);

// ScummVM 0.10.0's common/util.h and common/func.h: two attributes after a declarator
// (`error(...) GCC_PRINTF(1, 2) NORETURN`), and mem_fun, two function templates that differ only by
// the `const` of the member function they take -- each deduced through `Result (T::*f)()`.
C('mem-fun', `
#include <stdio.h>
#include <stdlib.h>
void quit(const char *s, ...) __attribute__((format(printf, 1, 2))) __attribute__((__noreturn__));
void quit(const char *s, ...) { printf("%s\\n", s); exit(3); }
template<class Result, class T>
class MemFunc0 {
public:
    typedef Result (T::*FuncType)();
    MemFunc0(const FuncType &func) : _func(func) {}
    Result operator()(T *v) const { return (v->*_func)(); }
private:
    FuncType _func;
};
template<class Result, class T>
class ConstMemFunc0 {
public:
    typedef Result (T::*FuncType)() const;
    ConstMemFunc0(const FuncType &func) : _func(func) {}
    Result operator()(const T *v) const { return 100 + (v->*_func)(); }
private:
    FuncType _func;
};
template<class Result, class T>
inline MemFunc0<Result, T> mem_fun(Result (T::*f)()) { return MemFunc0<Result, T>(f); }
template<class Result, class T>
inline ConstMemFunc0<Result, T> mem_fun(Result (T::*f)() const) { return ConstMemFunc0<Result, T>(f); }
struct A {
    int v;
    int get() { return v; }
    int peek() const { return v + 1; }
};
struct B { short s; short twice() const { return (short)(s * 2); } };
int main() {
    A a; a.v = 41;
    B b; b.s = 7;
    printf("%d %d %d\\n", mem_fun(&A::get)(&a), mem_fun(&A::peek)(&a), mem_fun(&B::twice)(&b));
    quit("done");
}
`);

// #pragma pack in C++: ScummVM 0.10.0 packs its file structures between common/pack-start.h and
// pack-end.h. The lowering writes structs in another order than the source's, so each class carries
// the value in force where it is defined, and its struct is written under it.
C('pragma-pack', `
#include <stdio.h>
#define OFF(T, m) ((int)((char *)&((T *)16)->m - (char *)16))
// ScummVM 0.10.0 packs its file structures between common/pack-start.h and pack-end.h.
struct Loose { char c; int i; short s; };
#pragma pack(1)
struct Header { char tag[3]; unsigned int size; unsigned short count; };
struct Entry { unsigned char kind; int offset; Loose inner; };
#pragma pack()
struct After { char c; int i; };
#pragma pack(push, 2)
struct Two { char c; int i; double d; };
#pragma pack(pop)
template<class T> struct Cell { char c; T t; };
#pragma pack(1)
struct Rec : public Header { char more; int last; };
#pragma pack()
int main() {
#pragma mark - an unknown pragma in a function is passed over
    Header h; h.size = 7;
    printf("%d %d %d %d %d\\n", (int)sizeof(Loose), (int)sizeof(Header), (int)sizeof(Entry), (int)sizeof(After), (int)sizeof(Two));
    printf("%d %d %d %d\\n", OFF(Header, size), OFF(Entry, inner), OFF(Two, d), (int)sizeof(Cell<int>));
    printf("%d %d %u\\n", (int)sizeof(Rec), OFF(Rec, last), h.size);
    return 0;
}
`);

// Common::InSaveFile is handled by pointer alone where the engines read saves (thumbnail.cpp): a
// call of ReadStream's member goes through __b0.__vp0[0], which reads InSaveFile's struct, so that
// struct must be written although nothing here makes an InSaveFile.
C('virtual-base-by-pointer', `
#include <stdio.h>
struct Stream { virtual ~Stream() {} int err; Stream() : err(0) {} };
struct ReadStream : virtual Stream { virtual int readByte() = 0; int twice() { return readByte() * 2; } };
struct Tag { int t; Tag() : t(5) {} };
struct SeekableReadStream : virtual ReadStream { };
struct InSaveFile : SeekableReadStream { };
int load(InSaveFile *in);
int use(InSaveFile *in) { return in->twice(); }
int main() {
    printf("%d\\n", (int)sizeof(int));
    return 0;
}
`);

// The member templates of ScummVM 0.10.0: common/list.h's Node<T2> and Iterator<T2> inside List<T>
// and its insert<iterator2>; gui/debugger.h's DelegateDebuglet<T> inside a class template; kyra's
// and wiz's static member function templates with a value parameter, defined out of the class (the
// default from the declaration) and called with explicit arguments, also after '.'; infogrames'
// constructor template.
C('member-templates', `
#include <stdio.h>
template <class T>
class List {
public:
    struct NodeBase { NodeBase *_prev, *_next; };
    template <class T2>
    struct Node : public NodeBase {
        T2 _data;
        Node(const T2 &x) : _data(x) {}
    };
    template <class T2>
    class Iterator {
        friend class List<T>;
        NodeBase *_node;
        explicit Iterator(NodeBase *node) : _node(node) {}
    public:
        Iterator() : _node(0) {}
        Iterator<T2> &operator++() { if (_node) _node = _node->_next; return *this; }
        T2 &operator*() const { return static_cast<Node<T2> *>(_node)->_data; }
        bool operator!=(const Iterator<T2> &x) const { return _node != x._node; }
    };
    typedef Iterator<T> iterator;
    typedef Iterator<const T> const_iterator;
    NodeBase *_anchor;
    List() { _anchor = new NodeBase; _anchor->_prev = _anchor; _anchor->_next = _anchor; }
    ~List() { clear(); delete _anchor; }
    void insert(iterator pos, const T &element) {
        NodeBase *newNode = new Node<T>(element);
        newNode->_next = pos._node;
        newNode->_prev = pos._node->_prev;
        newNode->_prev->_next = newNode;
        newNode->_next->_prev = newNode;
    }
    template <typename iterator2>
    void insert(iterator pos, iterator2 first, iterator2 last) {
        for (; first != last; ++first)
            insert(pos, *first);
    }
    void push_back(const T &element) { insert(end(), element); }
    template <class U>
    T convertFirst(U scale) const { T first = static_cast<Node<T> *>(_anchor->_next)->_data; return (T)(first * scale); }
    void clear() {
        NodeBase *p = _anchor->_next;
        while (p != _anchor) { NodeBase *n = p->_next; delete static_cast<Node<T> *>(p); p = n; }
        _anchor->_prev = _anchor->_next = _anchor;
    }
    iterator begin() { return iterator(_anchor->_next); }
    iterator end() { return iterator(_anchor); }
    const_iterator begin() const { return const_iterator(_anchor->_next); }
    const_iterator end() const { return const_iterator(_anchor); }
};

template <class Owner>
class Debugger {
public:
    class Debuglet {
    public:
        virtual ~Debuglet() {}
        virtual bool operator()(int argc) = 0;
    };
    template <class T>
    class DelegateDebuglet : public Debuglet {
        typedef bool (T::*Method)(int argc);
        T *_delegate;
        const Method _method;
    public:
        DelegateDebuglet(T *delegate, Method method) : _delegate(delegate), _method(method) {}
        virtual bool operator()(int argc) { return (_delegate->*_method)(argc); }
    };
public:
    Debuglet *make(Owner *o, bool (Owner::*m)(int)) { return new DelegateDebuglet<Owner>(o, m); }
};
struct Console {
    int base;
    bool cmdBig(int argc) { return argc + base > 10; }
};

class Screen {
public:
    template<bool noXor> static void decode(unsigned char *dst, const unsigned char *src, int n);
    template<int type> static int pixel(int c, int pal = 3);
    void run(unsigned char *d, const unsigned char *s, bool x) { if (x) decode<true>(d, s, 4); else decode<false>(d, s, 4); }
};
template<bool noXor>
void Screen::decode(unsigned char *dst, const unsigned char *src, int n) {
    for (int i = 0; i < n; i++) dst[i] = noXor ? src[i] : (unsigned char)(dst[i] ^ src[i]);
}
template<int type>
int Screen::pixel(int c, int pal) { return type == 1 ? c + pal : type == 2 ? c * pal : c; }

class Instruments {
    int _sum;
    void init() { _sum = 0; }
    bool load(int n) { _sum += n * 10; return true; }
    bool load(const char *s) { while (*s) _sum += *s++; return true; }
public:
    Instruments() { init(); }
    template<typename T> Instruments(T ins) { init(); load(ins); }
    int sum() const { return _sum; }
};

int main() {
    List<int> l;
    l.push_back(3); l.push_back(4);
    int more[3] = { 7, 8, 9 };
    l.insert(l.end(), more, more + 3);
    int s = 0;
    for (List<int>::iterator it = l.begin(); it != l.end(); ++it) s = s * 10 + *it;
    const List<int> &cl = l;
    int c = 0;
    for (List<int>::const_iterator it = cl.begin(); it != cl.end(); ++it) c += *it;
    printf("list %d %d\\n", s, c);
    printf("convert %d %d\\n", l.convertFirst(2.5), (int)l.convertFirst(3));

    Console con; con.base = 8;
    Debugger<Console> dbg;
    Debugger<Console>::Debuglet *d1 = 0;
    (void)d1;
    printf("debuglet %d %d\\n", (int)(*dbg.make(&con, &Console::cmdBig))(1), (int)(*dbg.make(&con, &Console::cmdBig))(5));

    unsigned char a[4] = { 1, 2, 3, 4 }, b[4] = { 15, 15, 15, 15 };
    Screen sc;
    sc.run(b, a, false);
    printf("decode %d %d", b[0], b[3]);
    sc.run(b, a, true);
    printf(" %d %d\\n", b[0], b[3]);
    printf("pixel %d %d %d %d\\n", Screen::pixel<1>(5), Screen::pixel<2>(5, 4), Screen::pixel<0>(5), sc.pixel<2>(6));

    Instruments i0, i1(4), i2("AB");
    printf("instruments %d %d %d\\n", i0.sum(), i1.sum(), i2.sum());
    return 0;
}
`);

// More of ScummVM 0.10.0: an enumerator sized by sizeof (agos's intern.h, written as C text for the C
// compiler to fold); a nested class declared in its class and defined there or outside it (kyra's
// FilenameTable, scumm's ScummNESFile::Resource); members value-initialised by () (HashMap's _defaultVal).
C('scummvm010-types', `
#include <stdio.h>
struct Child { short type; Child *next; };
struct SubRoom : Child { short roomShort; short exits[6]; };
enum {
    SubRoom_SIZE = sizeof(SubRoom) - sizeof(short),
    SubRoom_NEXT,
    Child_SIZE = sizeof(Child)
};
class Resource {
public:
    struct FilenameTable;
    const FilenameTable *searchFile(int id) const;
    struct FilenameTable { int id; const char *name; };
    const FilenameTable *_table;
};
const Resource::FilenameTable *Resource::searchFile(int id) const { return _table[id].id == id ? &_table[id] : 0; }
class NESFile {
public:
    struct Resource;
    int extract(const Resource *res) const;
};
struct NESFile::Resource { int offset, length; };
int NESFile::extract(const Resource *res) const { return res->offset + res->length; }
template <class Key, class Val>
class Map {
    const Val _defaultVal;
    int _count;
    const char *_names[4];
public:
    Map() : _defaultVal(), _count(), _names() {}
    Val get() const { return _defaultVal; }
    int count() const { return _count + (_names[3] == 0); }
};
int main() {
    static const Resource::FilenameTable files[2] = { { 0, "a" }, { 1, "b" } };
    Resource r; r._table = files;
    NESFile n; NESFile::Resource res = { 10, 5 };
    Map<int, int> m; Map<int, const char *> m2;
    int sizes[SubRoom_NEXT - SubRoom_SIZE + 1];
    printf("%d %d %d %d\\n", (int)SubRoom_SIZE, (int)SubRoom_NEXT, (int)Child_SIZE, (int)sizeof(sizes));
    printf("%s %d %d %d %d\\n", r.searchFile(1)->name, n.extract(&res), m.get(), m.count(), m2.get() == 0);
    return 0;
}
`);

// Lookup and conversions ScummVM 0.10.0 needs: argument-dependent lookup of an unqualified call
// (enableSpecialDebugLevel); an ambiguous user conversion that only makes its candidate worse
// (registerDefault("cdrom", 0)); a mutable member written through const; false and -0 as null pointer
// constants; the address of a local const; the address of ++p, an lvalue in C++.
C('scummvm010-lookup', `
#include <stdio.h>
namespace Common {
class String {
    union {
        char _storage[8];
        struct { mutable int *_refCount; unsigned _capacity; } _extern;
    };
    const char *_s;
public:
    String(const char *s) : _s(s) { _extern._refCount = 0; }
    String(char c) : _s("c") { (void)c; _extern._refCount = 0; }
    const char *c_str() const { return _s; }
    void bump() const { static int n = 40; _extern._refCount = &n; }
    int refs() const { return _extern._refCount ? *_extern._refCount : -1; }
};
bool enableLevel(const String &option) { return option.c_str()[0] == 'g'; }
template<class T> int width(const T *) { return (int)sizeof(T); }
}
namespace Scumm {
struct Config {
    int which;
    void registerDefault(const char *, const Common::String &) { which = 1; }
    void registerDefault(const char *, const char *) { which = 2; }
    void registerDefault(const char *, int) { which = 3; }
    void registerDefault(const char *, bool) { which = 4; }
};
static void doOutput(const unsigned char *p, int n) { printf("out %d %d\\n", p[0], n); }
int run() {
    Config c;
    c.registerDefault("cdrom", 0); int a = c.which;
    c.registerDefault("enable_gs", false); int b = c.which;
    c.registerDefault("x", "y"); int d = c.which;
    Common::String s("gfx");
    s.bump();
    void *fd = 0;
    const unsigned char newline_character = 10;
    doOutput(&newline_character, 1);
    printf("%d %d %d adl %d %d refs %d null %d\\n", a, b, d, (int)enableLevel(s), width(&s), s.refs(), (int)(fd == false));
    const char *np = -0;
    const char *str = "-12";
    const char *&pick = (str[0] == '-') ? ++str : str;
    printf("minus-zero %d pre %s %c\\n", (int)(np == 0), pick, *str);
    return 0;
}
}
int main() { return Scumm::run(); }
`);

// Statics in ScummVM 0.10.0: partial ordering of function templates (touche's saveOrLoadCommonArray);
// saga's table of aggregates holding objects built by constructors; kyra's static local table of objects
// and an overloaded member's address picked by its target type; gob's static local whose initialiser
// reads the object, run the first time control passes it.
C('scummvm010-statics', `
#include <stdio.h>
#include <string.h>
// touche: partial ordering of function templates.
struct WriteStream { int n; void put(int v) { n = n * 10 + v; } };
struct ReadStream { int n; };
template <class T> struct Array { T items[2]; };
template <class S, class A> static int saveArray(S &s, A &array);
template <class A> static int saveArray(WriteStream &s, A &array) { s.put(array.items[0]); s.put(array.items[1]); return 1; }
template <class A> static int saveArray(ReadStream &, A &) { return 2; }
template <class S> static int saveOne(S &, int) { return 3; }
template <class S, class T> static int saveOne(S &, T *) { return 4; }

// saga: a static table of aggregates holding objects built by their constructors.
struct Point { short x, y; Point() : x(9), y(9) {} Point(short a, short b) : x(a), y(b) {} };
struct PathDirectionData { int direction; Point coord; };
static const PathDirectionData pathLUT[2][2] = {
    { { 0, Point(0, -1) }, { 7, Point(-1, -1) } },
    { { 1, Point(1, 0) }, { 4, Point(1, -1) } },
};

// kyra: a static local table of objects with constructors; an overloaded member's address chosen by
// the type it is stored as; gob: a static local whose initialiser reads the object.
struct Engine;
struct Opcode {
    typedef int (Engine::*Proc)(int);
    Engine *e; Proc p;
    Opcode(Engine *engine, Proc proc) : e(engine), p(proc) {}
    int call(int a) const;
};
struct Engine {
    char saves[2][12];
    int base;
    int magic(int a) { return a + base; }
    int twice(int a) { return a * 2 + base; }
    int load(int id, int &n) { n = id; return 1; }
    bool load(const char *f, void *&p, int &size) { p = 0; size = (int)strlen(f); return true; }
    typedef bool (Engine::*LoadFunc)(const char *, void *&, int &);
    struct FileType { int type; LoadFunc load; };
    int run(int k) {
        static const Opcode table[] = { Opcode(this, &Engine::magic), Opcode(this, &Engine::twice) };
        return table[k].call(5);
    }
    const char *slot(int s) {
        static char *slotBase = saves[0] + strlen(saves[0]) - 2;
        slotBase[0] = (char)('0' + s);
        return saves[0];
    }
};
int Opcode::call(int a) const { return (e->*p)(a); }
static const Engine::FileType fileTypes[] = { { 1, &Engine::load } };

int main() {
    WriteStream w = { 0 }; ReadStream r = { 0 };
    Array<int> arr = { { 3, 4 } };
    int x = 0;
    int o1 = saveArray(w, arr);
    printf("order %d %d %d %d %d\\n", o1, w.n, saveArray(r, arr), saveOne(w, 1), saveOne(w, &x));
    printf("lut %d %d %d %d\\n", pathLUT[0][1].direction, pathLUT[0][1].coord.x, pathLUT[1][0].coord.x, pathLUT[1][1].coord.y);
    Engine e; e.base = 100;
    strcpy(e.saves[0], "game.s00");
    int a = e.run(0), b = e.run(1);
    e.base = 1000;
    int c = e.run(0);
    void *p; int size;
    bool ok = (e.*fileTypes[0].load)("abcdef", p, size);
    const char *s1 = e.slot(3);
    printf("kyra %d %d %d load %d %d gob %s\\n", a, b, c, (int)ok, size, s1);
    return 0;
}
`);

// scumm's BaseScummFile declares read() pure again over File's, which overrides ReadStream's in a
// virtual base: BaseScummFile's table for that base has an empty slot, not a thunk to a function nobody
// defines (the option checks below hold the program to having no unresolved name).
C('virtual-base-pure', `
#include <stdio.h>
struct ReadStream { virtual ~ReadStream() {} virtual unsigned read(void *, unsigned) = 0; int ok() { char c; return read(&c, 1) == 1; } };
struct SeekableReadStream : virtual ReadStream { virtual unsigned pos() const = 0; };
struct File : SeekableReadStream { unsigned _pos; File() : _pos(0) {} unsigned read(void *, unsigned n) { _pos += n; return n; } unsigned pos() const { return _pos; } };
struct BaseScummFile : File {
    virtual unsigned read(void *dataPtr, unsigned dataSize) = 0;
};
struct ScummFile : BaseScummFile {
    unsigned read(void *d, unsigned n) { return File::read(d, n) * 2; }
};
int main() {
    ScummFile f;
    ReadStream *r = &f;
    char b[4];
    unsigned got = r->read(b, 3);
    unsigned at = f.pos();
    int ok = r->ok();
    printf("%u %u %d\\n", got, at, ok);
    return 0;
}
`);

// A class whose objects point into themselves, as ScummVM 0.10.0's Common::String does with its
// small-string storage, is never moved by copying its bytes: built where it will live, returned
// through a hidden pointer, passed by value by invisible reference -- every copy g++ makes or elides
// printed, through plain calls, returns (by name too), conversions, new, function pointers, pointers
// to members (virtual ones too) and a second base's thunk.
C('pinned-objects', `
#include <stdio.h>
#include <string.h>
static int made = 0;
struct S {
    static const unsigned CAP = 12;
    char buf[CAP];
    char *p;
    int id;
    S(const char *s) : p(buf), id(++made) { memset(buf, 0, CAP); strcpy(buf, s); printf("ctor %d %s\\n", id, buf); }
    S(const S &o) : p(buf), id(++made) { strcpy(buf, o.p); printf("copy %d<-%d %s\\n", id, o.id, buf); }
    ~S() { printf("dtor %d %s %s\\n", id, buf, p == buf ? "ok" : "MOVED"); }
    S &operator=(const S &o) { strcpy(buf, o.p); printf("assign %d<-%d\\n", id, o.id); return *this; }
    bool ok() const { return p == buf; }
};
static S make(const char *s) { return S(s); }
static S named(const char *s) { S x(s); x.buf[0] = 'N'; return x; }
static S pick(bool first) { S a("a"), b("b"); if (first) return a; return b; }
static S chain() { return make("c"); }
static S fromBuf(int n) { char buf[16]; buf[0] = 'b'; buf[1] = (char)('0' + n); buf[2] = 0; return buf; }
static int take(S s) { return s.ok() ? s.id : -1; }
static S operator+(const S &a, const S &b) { S t(a.p); strcat(t.buf, b.p); return t; }
struct Holder { S s; int n; Holder() : s("h"), n(1) {} S get() const { return s; } };
struct Wrap { S inner; Wrap(const S &x) : inner(x) {} };
struct Base0 { int z; Base0() : z(0) {} virtual ~Base0() {} };
struct Maker { virtual ~Maker() {} virtual S build(S seed) const { S r(seed.p); r.buf[0] = 'B'; return r; } };
struct Both : Base0, Maker { S build(S seed) const { return seed + S("+"); } };
typedef S (*MakeFn)(const char *);
typedef S (Maker::*BuildFn)(S) const;
struct Plugin { const char *name; MakeFn make; };
static const Plugin plugins[] = { { "make", make }, { "named", named } };

int main() {
    S a = make("x");
    S b = named("y");
    S c = pick(true);
    S d = chain();
    printf("take %d\\n", take(a));
    printf("take %d\\n", take(make("z")));
    S e = a + b;
    S f = S("w");
    S g(make("v"));
    a = make("q");
    Holder h;
    S i = h.get();
    Wrap w(make("u"));
    S *heap = new S(make("n"));
    S fb = fromBuf(7);
    printf("buf %s %d\\n", fb.buf, fb.ok());
    MakeFn fp = make;
    S j = fp("fp");
    S k = plugins[1].make("pl");
    Both both; Maker *mk = &both; Maker base;
    BuildFn bf = &Maker::build;
    S l = (base.*bf)(S("m"));
    S m = (mk->*bf)(S("v"));
    S o = mk->build(j);
    printf("ptr %s %s %s %s %s %d\\n", j.buf, k.buf, l.buf, m.buf, o.buf, j.ok() && k.ok() && l.ok() && m.ok() && o.ok());
    printf("ok %d %d %d %d %d %d %d %d %d %d %d\\n", a.ok(), b.ok(), c.ok(), d.ok(), e.ok(), f.ok(), g.ok(), i.ok(), w.inner.ok(), heap->ok(), h.s.ok());
    printf("%s %s %s %s %s %s %s %s\\n", a.buf, b.buf, c.buf, d.buf, e.buf, f.buf, g.buf, heap->buf);
    delete heap;
    return 0;
}
`);

// Virtual bases, on the shape of ScummVM 0.10.0's common/stream.h: Stream virtual under ReadStream and
// WriteStream, a File reaching it by both, a stream two virtual levels down. One Stream however many
// paths; virtual calls through each base; construction and destruction in the order C++ gives them.
C('virtual-bases-streams', `
#include <stdio.h>
static int seq = 0;
class Stream {
public:
    int errs;
    Stream() : errs(0) { printf("%d Stream()\\n", ++seq); }
    Stream(int e) : errs(e) { printf("%d Stream(%d)\\n", ++seq, e); }
    virtual ~Stream() { printf("%d ~Stream %d\\n", ++seq, errs); }
    virtual bool ioFailed() const { return errs != 0; }
    virtual void clearIOFailed() { errs = 0; }
    int count() const { return errs * 10; }
};
class WriteStream : virtual public Stream {
public:
    int written;
    WriteStream() : written(0) { printf("%d WriteStream()\\n", ++seq); }
    ~WriteStream() { printf("%d ~WriteStream %d\\n", ++seq, written); }
    virtual unsigned write(const void *, unsigned n) = 0;
    void writeByte(char c) { write(&c, 1); }
};
class ReadStream : virtual public Stream {
public:
    ReadStream() { printf("%d ReadStream()\\n", ++seq); }
    ~ReadStream() { printf("%d ~ReadStream\\n", ++seq); }
    virtual unsigned read(void *, unsigned n) = 0;
    virtual bool eos() const = 0;
    int readByte() { char c = 0; return read(&c, 1) ? c : -1; }
};
class SeekableReadStream : virtual public ReadStream {
public:
    SeekableReadStream() { printf("%d SeekableReadStream()\\n", ++seq); }
    virtual unsigned pos() const = 0;
    virtual void seek(int off) = 0;
};
class MemoryStream : public SeekableReadStream {
    const char *_p; unsigned _n, _pos;
public:
    MemoryStream(const char *p, unsigned n) : _p(p), _n(n), _pos(0) { printf("%d MemoryStream(%u)\\n", ++seq, n); }
    ~MemoryStream() { printf("%d ~MemoryStream\\n", ++seq); }
    unsigned read(void *d, unsigned n) { unsigned k = 0; while (k < n && _pos < _n) ((char *)d)[k++] = _p[_pos++]; if (k < n) errs = 1; return k; }
    bool eos() const { return _pos >= _n; }
    unsigned pos() const { return _pos; }
    void seek(int off) { _pos = off; }
};
class File : public SeekableReadStream, public WriteStream {
    char _buf[16]; unsigned _len, _pos;
public:
    File() : Stream(7), _len(0), _pos(0) { printf("%d File()\\n", ++seq); }
    ~File() { printf("%d ~File %u\\n", ++seq, _len); }
    unsigned read(void *d, unsigned n) { unsigned k = 0; while (k < n && _pos < _len) ((char *)d)[k++] = _buf[_pos++]; return k; }
    unsigned write(const void *s, unsigned n) { unsigned k = 0; while (k < n && _len < 16) _buf[_len++] = ((const char *)s)[k++]; written += k; return k; }
    bool eos() const { return _pos >= _len; }
    unsigned pos() const { return _pos; }
    void seek(int off) { _pos = off; }
    bool ioFailed() const { return errs > 5; }
};
static int drain(ReadStream &r) { int s = 0, c; while ((c = r.readByte()) >= 0) s += c; return s; }
static bool failed(Stream *s) { return s->ioFailed(); }
int main() {
    {
        MemoryStream m("abc", 3);
        int d = drain(m);
        printf("drain %d eos %d failed %d count %d\\n", d, m.eos(), failed(&m), m.count());
        m.clearIOFailed();
        SeekableReadStream *s = &m;
        s->seek(1);
        int c = s->readByte();
        printf("pos %u read %d\\n", s->pos(), c);
    }
    {
        File f;
        WriteStream *w = &f;
        w->writeByte('x'); w->writeByte('y');
        ReadStream *r = &f;
        Stream *a = w, *b = r;
        printf("same %d failed %d %d errs %d\\n", a == b, failed(&f), failed(w), b->errs);
        int c1 = r->readByte(); int c2 = r->readByte(); int c3 = r->readByte();
        printf("read %d %d %d\\n", c1, c2, c3);
        f.clearIOFailed();
        printf("failed %d written %d\\n", a->ioFailed(), f.written);
    }
    Stream *heap = new File;
    heap->errs = 9;
    printf("heap failed %d\\n", heap->ioFailed());
    delete heap;
    return 0;
}
`);

// The rules a virtual base brings: only the most derived class's initialiser builds it, the others'
// are skipped; the final overrider may come from a sibling path (dominance); dynamic_cast down from it and
// across; implicit copy and assignment; a virtual base with no virtual function; a class template, an
// array and a member of such classes.
C('virtual-bases-rules', `
#include <stdio.h>
// Only the most derived class's initialiser builds a virtual base; the others' are skipped.
struct V { int v; V() : v(-1) { printf("V()\\n"); } V(int x) : v(x) { printf("V(%d)\\n", x); } };
struct B : virtual V { B() : V(1) { printf("B v=%d\\n", v); } };
struct D : B { D() : V(2) { printf("D v=%d\\n", v); } };
struct D2 : B { D2() { printf("D2 v=%d\\n", v); } };

// Dominance: B1 overrides f, C1 calls it, and in E the call from C1 reaches B1's.
struct A { int tag; A() : tag(10) {} virtual ~A() {} virtual int f() { return tag; } virtual int h() { return 1; } };
struct B1 : virtual A { int f() { return tag + 100; } };
struct C1 : virtual A { int g() { return f() * 2; } int h() { return 7; } };
struct E : B1, C1 { int k; E() : k(3) {} };

// A virtual base with no virtual function, data only; and one reached through two levels.
struct P { int x, y; P() : x(4), y(5) {} };
struct Q : virtual P { int q; Q() : q(6) {} int sum() const { return x + y + q; } };
struct R : virtual Q { int r; R() : r(7) {} int all() const { return sum() + r + x; } };
struct S : R, virtual P { int s; S() : s(8) {} };

// Copies and assignment, implicit.
struct W : virtual V { int w; W() : V(30), w(31) {} };
struct X : W { int xx; X() : xx(32) {} };

// A class template with a virtual base, and an array and a member of such classes.
template<class T> struct Box : virtual V { T t; Box() : V(50), t(51) {} T get() const { return t + (T)v; } };
struct Holder { X member; X arr[2]; int n; Holder() : n(2) {} };

static int viaC(C1 *c) { return c->g(); }
static int viaA(A *a) { return a->f() + a->h(); }

int main() {
    { D d; D2 d2; printf("%d %d\\n", d.v, d2.v); }
    {
        E e;
        A *a = &e; C1 *c = &e; B1 *b = &e;
        printf("viaC %d viaA %d b->f %d e.f %d\\n", viaC(c), viaA(a), b->f(), e.f());
        E *back = dynamic_cast<E *>(a);
        C1 *cross = dynamic_cast<C1 *>(b);
        B1 *none = dynamic_cast<B1 *>((A *)0);
        printf("dyn %d %d %d %d\\n", back == &e, cross == c, none == 0, dynamic_cast<B1 *>(c) == b);
        A *heap = new E;
        printf("heap %d\\n", heap->f());
        delete heap;
    }
    {
        S s;
        R *r = &s; Q *q = &s; P *p = &s;
        printf("S %d %d %d %d %d\\n", s.all(), r->all(), q->sum(), p->x, (int)((P *)q == p));
        p->x = 40;
        printf("S %d %d\\n", s.all(), q->sum());
    }
    {
        X a; a.v = 33; a.w = 34; a.xx = 35;
        X b(a);
        printf("copy %d %d %d\\n", b.v, b.w, b.xx);
        X c; c = a;
        V *pv = &c;
        printf("assign %d %d %d %d\\n", c.v, c.w, c.xx, pv->v);
        a.v = 1;
        printf("apart %d %d\\n", b.v, c.v);
    }
    {
        Box<int> bi; Box<short> bs;
        printf("box %d %d\\n", bi.get(), (int)bs.get());
        Holder h;
        h.arr[1].v = 77;
        V *pv = &h.arr[1];
        printf("holder %d %d %d %d\\n", h.member.v, h.arr[0].v, pv->v, h.n);
    }
    return 0;
}
`);

// More of ScummVM 0.10.0: common/func.h declares `template <typename T> struct Hash;` and only
// specialises it; Queen declares `class Graphics;` inside namespace Queen while a namespace Graphics
// exists outside; mt32's freeverb.h initialises one const float from another.
C('scummvm010-shapes', `
#include <stdio.h>
namespace Common {
template<class Arg, class Result> struct UnaryFunction { typedef Arg ArgumentType; typedef Result ResultType; };
template <typename T> struct Hash;
template <> struct Hash<char> : public UnaryFunction<char, unsigned> {
    unsigned operator()(char val) const { return (unsigned)val * 3; }
};
template <> struct Hash<int> : public UnaryFunction<int, unsigned> {
    unsigned operator()(int val) const { return (unsigned)val + 1000; }
};
}
namespace Graphics { struct Surface { int w; }; }
namespace Queen {
class Graphics;
class Engine {
public:
    Graphics *graphics() const { return _graphics; }
    Graphics *_graphics;
};
class Graphics { public: int n; };
}
const float scalewet = 3;
const float initialwet = 1 / scalewet;
static float later = initialwet * 2;
const int stereospread = 23;
const int combtuningR1 = 1116 + stereospread;
static int combs[] = { combtuningR1, combtuningR1 * 2 };
int main() {
    Common::Hash<char> h; Common::Hash<int> hi;
    Queen::Graphics g; g.n = 5;
    Queen::Engine e; e._graphics = &g;
    Graphics::Surface s; s.w = 2;
    printf("%u %u %d %d %d %d\\n", h('a'), hi(7), e.graphics()->n, s.w, (int)(initialwet * 300), (int)(later * 300));
    printf("%d %d %d\\n", combtuningR1, combs[0], combs[1]);
    return 0;
}
`);

// Grid::_area is `Area (*_area)[MAX_AREAS_NUMBER]`, and Grid was lowered before Area: the C struct
// held a pointer to an array of a struct not yet defined, its rows 0 bytes apart, and every room
// read the last room's walk areas (FOTAQ diverged from frame 606 of a scripted run).
C('member-ptr-to-array', `
#include <stdio.h>
struct Box { short x1, y1, x2, y2; };
struct Area { short mapNeighbours; Box box; short bottomScaleFactor; };
class Grid {
public:
    Grid(int rooms);
    Area *area(int r, int n) const;
    Area (*_area)[11];
};
Grid::Grid(int rooms) { _area = new Area[rooms + 1][11]; }
Area *Grid::area(int r, int n) const { return &_area[r][n]; }
int main() {
    Grid g(3);
    for (int r = 0; r <= 3; r++) for (int n = 0; n < 11; n++) g._area[r][n].box.x1 = (short)(r * 100 + n);
    printf("%d %d %d %d\\n", g._area[1][1].box.x1, g._area[2][1].box.x1, g.area(3, 10)->box.x1, g.area(2, 5)->box.x1);
    printf("%d\\n", (int)((char *)g.area(1, 0) - (char *)g.area(0, 0)));
    return 0;
}
`);

// Shapes of ScummVM's Queen engine: new of arrays of a class with a constructor (Grid's
// new Area[n][MAX_AREAS_NUMBER]), an enumerator promoting to int over bool (registerDefault), and a
// static member defined with an enumerator of its class as its size (Input::_commandKeys).
C('queen-shapes', `
#include <stdio.h>
static int made = 0, gone = 0;
struct Box { short x1, y1; Box() : x1(1), y1(2) { made++; } ~Box() { gone++; } };
struct Area { short n; Box box; int sum() const { return n + box.x1 + box.y1; } };
enum { MAX_AREAS = 3 };
class Logic { public: enum { DEFAULT_TALK_SPEED = 7 * 3, COUNT = 4 }; static const char *keys[COUNT]; };
const char *Logic::keys[COUNT] = { "a", "b", "c", "d" };
static const char *which(int) { return "int"; }
static const char *which(bool) { return "bool"; }
int main() {
    int rooms = 2;
    Area (*area)[MAX_AREAS] = new Area[rooms + 1][MAX_AREAS];
    area[2][1].n = 10;
    printf("%d %d %d\\n", area[0][0].sum(), area[2][1].sum(), made);
    delete[] area;
    printf("%d %s %s %s\\n", gone, which(Logic::DEFAULT_TALK_SPEED), which(false), Logic::keys[3]);
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
  // What the lowering must never emit, the C front end refuses as gcc does ("array type has
  // incomplete element type") rather than giving the rows a stride of 0.
  const AREA = 'struct Area { short a; short b[4]; };\n';
  const ROWS = '#include <stdio.h>\n#include <stdlib.h>\nstruct Grid { struct Area (*rows)[11]; };\n';
  const MAIN = 'int main(void) { struct Grid g; g.rows = malloc(2 * sizeof *g.rows); printf("%d\\n", (int)((char *)g.rows[1] - (char *)g.rows[0])); return 0; }\n';
  option.push(
    ['C: a pointer to an array of a struct not yet defined is refused', /^refused: .*incomplete element type 'struct Area'/.test(out(ROWS + AREA + MAIN, 'unit.c'))],
    ['...and its rows are sizeof(struct Area[11]) apart once it is', out(AREA + ROWS + MAIN, 'unit.c') === '110'],
  );
  // A function template's instance is a weak external symbol, as g++ makes it: scumm's akos.cpp calls
  // Wiz::decompressWizImage<kWizXMap>, whose body only wiz_he.cpp has.
  const WIZ = 'struct Wiz { template<int type> static int decompress(int x); };\n';
  const two = (() => {
    try {
      return compileProgram([
        { file: 'wiz.cpp', source: `${WIZ}template<int type> int Wiz::decompress(int x) { return x * 10 + type; }\nint wizUse() { return Wiz::decompress<1>(2) + Wiz::decompress<2>(0); }\n` },
        { file: 'akos.cpp', source: `#include <stdio.h>\n${WIZ}int wizUse();\nint main() { printf("%d %d\\n", Wiz::decompress<1>(5), wizUse()); return 0; }\n` },
      ], { resolve: builtinHeaderResolver({}), memory: 8 << 20 }).run(['x']).stdout.trim();
    } catch (e) { return `refused: ${e.message.split('\n')[0]}`; }
  })();
  option.push(['a member template instance defined in one unit is called from another', two === '51 23']);
  // Nothing a program never defines is named: a pure virtual function under a virtual base was.
  const pureSrc = cases.find((c) => c.name === 'virtual-base-pure')?.src ?? '';
  const pureUndefined = (() => { try { return compileProgram([{ file: 'pure.cpp', source: pureSrc }], { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true }).undefined ?? []; } catch (e) { return [`refused: ${e.message}`]; } })();
  option.push(['a pure virtual function under a virtual base leaves no name undefined', pureSrc !== '' && pureUndefined.length === 0]);
  // A class's `static const unsigned CAP = 12;` is its value where it is used: no unit defines it, and
  // read as a variable it was storage PRISM made up, holding 0 (String::_builtinCapacity).
  const pinSrc = cases.find((c) => c.name === 'pinned-objects')?.src ?? '';
  const pinLeft = (() => { try { const q = compileProgram([{ file: 'pin.cpp', source: pinSrc }], { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true }); return [...(q.undefined ?? []), ...(q.undefinedVars ?? [])].map((u) => u.name); } catch (e) { return [`refused: ${e.message}`]; } })();
  option.push(['a static const member used for its value names no variable', pinSrc !== '' && pinLeft.length === 0]);
  // DECLARE_SINGLETON: `template<> T *Singleton<T>::_singleton = 0;` defines that instance's member in
  // its unit, used there or not; another unit uses it.
  const SING = 'template <class T> struct Singleton { static T *_singleton; static T &instance() { if (!_singleton) _singleton = new T(); return *_singleton; } };\nstruct PM { int n; PM() : n(42) {} };\n';
  const sing = (() => {
    try {
      const q = compileProgram([
        { file: 'plugins.cpp', source: `${SING}template<> PM *Singleton<PM>::_singleton = 0;\nint defined_here = 1;\n` },
        { file: 'main.cpp', source: `#include <stdio.h>\n${SING}int main() { int a = Singleton<PM>::_singleton == 0; int n = Singleton<PM>::instance().n; printf("%d %d %d\\n", a, n, Singleton<PM>::_singleton != 0); return 0; }\n` },
      ], { resolve: builtinHeaderResolver({}), memory: 8 << 20, collect: true });
      // Left undefined, the member would get storage made up for it, holding 0 -- the same output:
      // the check is that it is defined.
      if (q.undefinedVars?.length) return `undefined: ${q.undefinedVars.map((u) => u.name).join(' ')}`;
      return q.run(['x']).stdout.trim();
    } catch (e) { return `refused: ${e.message.split('\n')[0]}`; }
  })();
  option.push(['an explicit specialisation of a static member is defined in its unit, used from another', sing === '1 42 1']);
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
