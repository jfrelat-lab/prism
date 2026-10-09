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
