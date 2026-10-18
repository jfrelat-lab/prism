// live.js — the page half of Live C.
//
// Files in the browser, a worker that compiles and runs them, and two panes: what the program
// printed, and the JavaScript PRISM emitted for it. Nothing here knows any C; it holds text, starts
// a worker, and shows what comes back.

import { makeControl, controlViews, makeKeyboard, wake, SLOT } from '../../src/env/webhost.js';
import { ENV_TARGET, detectEnv } from './envs.js';
import { cBlocks, fetchCSection, pageUrl, historyUrl, LICENCE } from './rosetta.js';
import { highlight } from './highlight.js';

const $ = (id) => document.getElementById(id);

/*
 * THE EXAMPLES. PRISM's own, under prism/ and under PRISM's licence; Rosetta Code's follow under
 * rosetta/, loaded from rosettacode.org when chosen (see web/live/rosetta.js for why not stored).
 *
 * Not a tour of C. Each console one is a place where a compiler that emits JavaScript has to do
 * something that is not a translation -- and where PRISM either does it or does not, visibly, in
 * under a second. A "hello world" proves the pipeline runs; it proves nothing about the pipeline.
 * The three graphical ones are one per environment Live C runs on a screen: GLUT, SDL, Win32.
 */
const EXAMPLES = {
  'prism/hello.c': `/*
 * The whole chain in one file: preprocess, parse, lay out, emit, link, run.
 * printf is PRISM's own libc -- the format string is parsed at run time, as C's is.
 */
#include <stdio.h>

int main(void)
{
    printf("hello from %s, built at %s %s\\n", "PRISM", __DATE__, __TIME__);
    for (int i = 1; i <= 5; i++) printf("  %d squared is %d\\n", i, i * i);
    return 0;
}
`,

  'prism/layout.c': `/*
 * THE ABI, which is the part that cannot be approximated.
 *
 * A game memcpys a WAD or a ROM header straight into a struct and reads fields by offset, so a
 * single byte of padding in the wrong place is corrupted sprites -- and the bug gets looked for in
 * the renderer. PRISM lays structs out exactly as "gcc -m32" does, bitfields included, and
 * tools/gate-abi.mjs checks it against a native i386 build on every change.
 *
 * What gcc -m32 answers, and what PRISM must answer: 12 (b at 4, c at 8), 5, 4, 4.
 */
#include <stdio.h>
#include <stddef.h>

struct mixed { char a; int b; short c; };          /* padding after a, tail padding after c */
struct packed { char a; int b; } __attribute__((packed));
struct bits { unsigned lo : 3; unsigned hi : 5; unsigned wide : 20; };

int main(void)
{
    printf("sizeof(struct mixed)  = %d   (offsetof b = %d, c = %d)\\n",
           (int)sizeof(struct mixed), (int)offsetof(struct mixed, b),
           (int)offsetof(struct mixed, c));
    printf("sizeof(struct packed) = %d\\n", (int)sizeof(struct packed));
    printf("sizeof(struct bits)   = %d\\n", (int)sizeof(struct bits));
    printf("alignof(double)       = %d\\n", (int)__alignof__(double));
    return 0;
}
`,

  'prism/floats.c': `/*
 * TYPE PUNNING, which every 1990s renderer does and no portable C standard blesses.
 *
 * Quake's inverse square root reads a float's bits as an integer, and its span drawer reads the
 * exponent to divide. PRISM keeps one linear memory, so a float and the int overlapping it are the
 * same bytes -- and 'float' arithmetic is rounded through Math.fround at every step, because JS
 * numbers are doubles and a renderer that leans on 32-bit rounding notices immediately.
 */
#include <stdio.h>

float rsqrt(float x)
{
    union { float f; unsigned i; } u;
    float half = 0.5f * x;
    u.f = x;
    u.i = 0x5f3759df - (u.i >> 1);          /* the famous constant, from Quake's source */
    u.f = u.f * (1.5f - half * u.f * u.f);  /* one Newton step */
    return u.f;
}

int main(void)
{
    union { float f; unsigned i; } u;
    u.f = 1.0f;
    printf("1.0f is 0x%08x as bits\\n", u.i);
    for (float x = 1.0f; x <= 5.0f; x += 1.0f)
        printf("  rsqrt(%.1f) = %.6f\\n", (double)x, (double)rsqrt(x));
    return 0;
}
`,

  'prism/pointers.c': `/*
 * FUNCTION POINTERS as data, which is how a MAME driver's opcode table and a Doom thinker work.
 *
 * A function's address is an integer here, stable and comparable, so it can be stored in a struct,
 * compared, and called back. That is what makes an emulator's dispatch table compile at all.
 */
#include <stdio.h>
#include <string.h>

typedef int (*op)(int, int);

static int add(int a, int b) { return a + b; }
static int sub(int a, int b) { return a - b; }
static int mul(int a, int b) { return a * b; }

struct entry { const char *name; op fn; };

int main(void)
{
    struct entry table[] = { { "add", add }, { "sub", sub }, { "mul", mul } };
    for (unsigned i = 0; i < sizeof table / sizeof *table; i++)
        printf("%s(7, 3) = %d%s\\n", table[i].name, table[i].fn(7, 3),
               table[i].fn == mul ? "   <- found by comparing the pointer" : "");
    return 0;
}
`,

  'prism/stdin.c': `/*
 * STDIN, from the field below the output pane.
 *
 * The program blocks in fgets and the page is still painting, because the two share memory rather
 * than messages: this worker is inside main() and its event loop is gone, so a keystroke posted to
 * it would never be delivered. Type a line, press Enter, and it arrives.
 */
#include <stdio.h>
#include <string.h>

int main(void)
{
    char line[256];
    printf("type something and press Enter (an empty line ends it)\\n");
    while (fgets(line, sizeof line, stdin)) {
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\\n' || line[n - 1] == '\\r')) line[--n] = 0;
        if (!n) break;
        printf("%2d bytes: ", (int)n);
        for (size_t i = 0; i < n; i++) putchar(line[n - 1 - i]);
        putchar('\\n');
    }
    printf("done\\n");
    return 0;
}
`,
  'prism/shapes.cpp': `/*
 * C++, lowered to C and then compiled like the rest: PRISM's front end is the old cfront idea.
 *
 * What is here is what C has no word for -- a constructor that runs, a virtual call that finds its
 * function through the object, an overloaded operator, a destructor at the end of a scope. The
 * subset is C++98 without exceptions, namespaces or function templates, and a use of one of those
 * is refused by name.
 */
#include <stdio.h>

class Shape {
public:
    virtual ~Shape() { printf("  (a shape goes)\\n"); }
    virtual float area() const = 0;
    virtual const char *name() const = 0;
};

class Rect : public Shape {
    float w, h;
public:
    Rect(float w_, float h_) : w(w_), h(h_) {}
    float area() const { return w * h; }
    const char *name() const { return "rectangle"; }
};

class Circle : public Shape {
    float r;
public:
    Circle(float r_) : r(r_) {}
    float area() const { return 3.14159265f * r * r; }
    const char *name() const { return "circle"; }
};

struct Total {
    float sum;
    Total() : sum(0) {}
    Total &operator+=(const Shape &s) { sum += s.area(); return *this; }
};

int main()
{
    Shape *shapes[3] = { new Rect(3, 4), new Circle(1), new Rect(2, 2.5f) };
    Total total;
    for (int i = 0; i < 3; i++) {
        printf("%-10s %6.2f\\n", shapes[i]->name(), shapes[i]->area());
        total += *shapes[i];
    }
    printf("total      %6.2f\\n", total.sum);
    for (int i = 0; i < 3; i++) delete shapes[i];
    return 0;
}
`,
  'prism/glut-cube.c': `/*
 * GLUT and OpenGL 1.x, the fixed pipeline: a lit cube turning, double-buffered.
 *
 * PRISM's GL is a library written in JavaScript (src/env/gl.js) that draws on WebGL: the program
 * calls glRotatef and glutSolidCube as it would on Mesa, and the window is this page.
 * Space pauses; the time comes from glutGet(GLUT_ELAPSED_TIME), as a GLUT animation's should.
 */
#include <GL/glut.h>

static int paused = 0, frozen_at = 0;

static void display(void)
{
    static const GLfloat light[] = { 1, 1, 2, 0 }, gold[] = { 0.9f, 0.7f, 0.2f, 1 };
    int t = paused ? frozen_at : glutGet(GLUT_ELAPSED_TIME);

    glClearColor(0.08f, 0.09f, 0.15f, 1);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    glLoadIdentity();
    glTranslatef(0, 0, -5);
    glRotatef(t * 0.05f, 1, 0, 0);
    glRotatef(t * 0.07f, 0, 1, 0);
    glLightfv(GL_LIGHT0, GL_POSITION, light);
    glMaterialfv(GL_FRONT, GL_AMBIENT_AND_DIFFUSE, gold);
    glutSolidCube(1.6);
    glutSwapBuffers();
}

static void reshape(int w, int h)
{
    glViewport(0, 0, w, h);
    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    gluPerspective(45, (double)w / h, 1, 20);
    glMatrixMode(GL_MODELVIEW);
}

static void key(unsigned char k, int x, int y)
{
    (void)x; (void)y;
    if (k == ' ') { paused = !paused; frozen_at = glutGet(GLUT_ELAPSED_TIME); }
}

static void idle(void) { glutPostRedisplay(); }

int main(int argc, char **argv)
{
    glutInit(&argc, argv);
    glutInitDisplayMode(GLUT_RGB | GLUT_DOUBLE | GLUT_DEPTH);
    glutInitWindowSize(480, 360);
    glutCreateWindow("cube");
    glEnable(GL_DEPTH_TEST);
    glEnable(GL_LIGHTING);
    glEnable(GL_LIGHT0);
    glutDisplayFunc(display);
    glutReshapeFunc(reshape);
    glutKeyboardFunc(key);
    glutIdleFunc(idle);
    glutMainLoop();
    return 0;
}
`,
  'prism/sdl-plasma.c': `/*
 * SDL 1.2: a plasma, in 8 bits, the way a 1990s demo drew one.
 *
 * Integer sine tables, a 256-colour palette set with SDL_SetColors, every pixel written into
 * surface->pixels and the frame handed over with SDL_Flip. The palette is ROTATED each frame
 * rather than the picture redrawn -- the old trick, and it costs 256 colours, not 64,000 pixels.
 * Escape, or closing the window, quits.
 */
#include <SDL/SDL.h>
#include <math.h>

#define W 320
#define H 200

int main(int argc, char **argv)
{
    static unsigned char sine[256];
    SDL_Color pal[256], turned[256];
    SDL_Surface *screen;
    SDL_Event e;
    int x, y, i, frame, running = 1;

    (void)argc; (void)argv;
    for (i = 0; i < 256; i++) {
        sine[i] = (unsigned char)(128 + 127 * sin(i * 3.14159265 / 128));
        pal[i].r = (Uint8)(128 + 127 * sin(i * 3.14159265 / 32));
        pal[i].g = (Uint8)(128 + 127 * sin(i * 3.14159265 / 64 + 2));
        pal[i].b = (Uint8)(128 + 127 * sin(i * 3.14159265 / 128 + 4));
    }
    SDL_Init(SDL_INIT_VIDEO);
    screen = SDL_SetVideoMode(W, H, 8, SDL_SWSURFACE | SDL_HWPALETTE);

    SDL_LockSurface(screen);
    for (y = 0; y < H; y++) {
        Uint8 *row = (Uint8 *)screen->pixels + y * screen->pitch;
        for (x = 0; x < W; x++)
            row[x] = (Uint8)((sine[x & 255] + sine[(y * 2) & 255] + sine[(x + y) & 255]) / 3);
    }
    SDL_UnlockSurface(screen);

    for (frame = 0; running; frame++) {
        for (i = 0; i < 256; i++) turned[i] = pal[(i + frame) & 255];
        SDL_SetColors(screen, turned, 0, 256);
        SDL_Flip(screen);
        while (SDL_PollEvent(&e))
            if (e.type == SDL_QUIT || (e.type == SDL_KEYDOWN && e.key.keysym.sym == SDLK_ESCAPE)) running = 0;
        SDL_Delay(20);
    }
    SDL_Quit();
    return 0;
}
`,
  'prism/win32-bars.c': `/*
 * Win32: a window, its messages, and GDI -- written the way Petzold taught it.
 *
 * RegisterClass, CreateWindow, a GetMessage loop, and a window procedure that paints only when
 * Windows says so (WM_PAINT). A timer (SetTimer, WM_TIMER) moves the bars and invalidates the
 * window, which is what makes the next WM_PAINT come. PRISM's Win32 is C of its own (src/env/win32*.c),
 * compiled with this file; the desktop around the window is this page's.
 */
#include <windows.h>

#define BARS 12

static int tick;

static void paint(HWND hwnd)
{
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(hwnd, &ps);
    RECT r;
    int i;

    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(0, 0, 128));
    TextOut(dc, 16, 12, TEXT("GDI, from C compiled in the page"), 32);
    for (i = 0; i < BARS; i++) {
        int phase = (tick * 3 + i * 21) % 200, h = phase < 100 ? phase : 200 - phase;
        HBRUSH b = CreateSolidBrush(RGB(40 + i * 17, 120, 255 - i * 17));
        r.left = 16 + i * 24; r.right = r.left + 18;
        r.bottom = 170; r.top = r.bottom - 20 - h;
        FillRect(dc, &r, b);
        DeleteObject(b);
    }
    MoveToEx(dc, 10, 172, NULL);
    LineTo(dc, 310, 172);
    EndPaint(hwnd, &ps);
}

static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    switch (msg) {
    case WM_TIMER:   tick++; InvalidateRect(hwnd, NULL, TRUE); return 0;
    case WM_PAINT:   paint(hwnd); return 0;
    case WM_DESTROY: KillTimer(hwnd, 1); PostQuitMessage(0); return 0;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show)
{
    WNDCLASS wc = { 0 };
    MSG msg;
    HWND hwnd;

    (void)prev; (void)cmd;
    wc.lpfnWndProc = proc;
    wc.hInstance = inst;
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    wc.lpszClassName = "prism";
    RegisterClass(&wc);
    hwnd = CreateWindow("prism", "Bars", WS_OVERLAPPEDWINDOW, 40, 40, 340, 230, NULL, NULL, inst, NULL);
    ShowWindow(hwnd, show);
    SetTimer(hwnd, 1, 50, NULL);
    while (GetMessage(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return (int)msg.wParam;
}
`,
};

// ---------------------------------------------------------------- the files
//
// Kept in localStorage, because losing what you typed to a reload is the one thing a page like this
// must never do. The example is the seed, not the content: once you have edited it, it is yours.
const STORE = 'prism.live.files';
let files = [];
let active = 0;
let worker = null, views = null, keyboard = null;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (Array.isArray(saved) && saved.length && saved.every(f => f && f.name)) return saved;
  } catch { /* a corrupt entry is not worth a broken page */ }
  return [{ name: 'main.c', source: EXAMPLES['prism/hello.c'] }];
}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(files)); } catch {} };

function renderTabs() {
  const bar = $('tabs');
  bar.innerHTML = '';
  files.forEach((f, i) => {
    const t = document.createElement('div');
    t.className = 'tab';
    t.setAttribute('aria-selected', String(i === active));
    t.append(f.name);
    if (files.length > 1) {
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '✕'; x.title = `remove ${f.name}`;
      x.onclick = (e) => {
        e.stopPropagation();
        files.splice(i, 1);
        active = Math.min(active, files.length - 1);
        save(); renderTabs(); showFile();
      };
      t.append(x);
    }
    t.onclick = () => { stash(); active = i; renderTabs(); showFile(); };
    bar.append(t);
  });
  const add = document.createElement('div');
  add.className = 'tab add';
  add.textContent = '+ file';
  add.onclick = () => {
    const name = prompt('file name (.c and .cpp are compiled, anything else is only included)', 'util.c');
    if (!name) return;
    if (files.some(f => f.name === name)) return;
    stash();
    files.push({ name, source: /\.h$/i.test(name) ? `#pragma once\n` : `#include <stdio.h>\n\n` });
    active = files.length - 1;
    save(); renderTabs(); showFile();
  };
  bar.append(add);
}

/** What is in the editor belongs to the file that is open. */
const stash = () => { if (files[active]) files[active].source = $('editor').value; };
const showFile = () => { $('editor').value = files[active]?.source ?? ''; paint(); };

/*
 * The colours under the text (web/live/highlight.js): repainted at the next frame after a change,
 * once however fast the typing, and kept at the textarea's scroll position.
 */
let painting = 0;
function paint() {
  if (painting) return;
  painting = requestAnimationFrame(() => {
    painting = 0;
    const ed = $('editor'), hl = $('hl');
    hl.innerHTML = highlight(ed.value, { cxx: /\.(cpp|cc|cxx|hpp)$/i.test(files[active]?.name ?? '') });
    hl.scrollTop = ed.scrollTop; hl.scrollLeft = ed.scrollLeft;
  });
}
$('editor').addEventListener('scroll', () => { const ed = $('editor'), hl = $('hl'); hl.scrollTop = ed.scrollTop; hl.scrollLeft = ed.scrollLeft; });

$('editor').addEventListener('input', () => { stash(); save(); paint(); });
/*
 * Tab indents rather than leaving the field. In a page whose whole subject is C, moving the focus is
 * never what Tab was for -- and the alternative is retyping four spaces by hand for ever.
 */
$('editor').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const el = e.target, at = el.selectionStart;
  el.value = el.value.slice(0, at) + '\t' + el.value.slice(el.selectionEnd);
  el.selectionStart = el.selectionEnd = at + 1;
  stash(); save(); paint();
});

// ---------------------------------------------------------------- the output
const out = $('out');
function say(text, cls = '') {
  const el = document.createElement('span');
  if (cls) el.className = `note ${cls}`;
  el.textContent = text;
  out.append(el);
  $('panes').scrollTop = $('panes').scrollHeight;
}
/*
 * The program's own bytes, exactly. Not a line at a time: a program that prints without a newline --
 * a prompt, a progress dot -- has printed something, and holding it back until the line ends means
 * the prompt appears only after you have answered it.
 */
const emit = (text) => { out.append(document.createTextNode(text)); $('panes').scrollTop = $('panes').scrollHeight; };

const PANES = { tabOut: 'out', tabEmitted: 'emitted', tabScreen: 'screen' };
const showTab = (id) => {
  for (const [tab, pane] of Object.entries(PANES)) {
    $(tab).setAttribute('aria-selected', String(tab === id));
    $(pane).hidden = tab !== id;
  }
};
for (const id of Object.keys(PANES)) $(id).onclick = () => showTab(id);

/*
 * A PROGRAM THAT NEEDS A DISPLAY. Its includes say which (web/live/envs.js): GLUT, SDL, X11 or Win32.
 * It runs in the shelf's player -- the page that already draws every one of those, takes the keys
 * and plays the sound -- loaded fresh in a frame for each run and handed the files by postMessage.
 * Live C keeps the editor and the console programs; Stop removes the frame, and its worker with it.
 */
const MACHINE_NAME = { linux: 'the Linux machine', win: 'the Windows desktop' };
function runOnScreen(env) {
  const t = ENV_TARGET[env];
  $('tabScreen').hidden = false;
  showTab('tabScreen');
  const box = $('screen');
  box.replaceChildren();
  const frame = document.createElement('iframe');
  frame.title = 'the program\'s screen';
  frame.src = new URL('../?live=1&player=1', import.meta.url).href;
  const argv = tokenise($('argv').value).slice(1);
  const onReady = (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'prism-live-ready') return;
    window.removeEventListener('message', onReady);
    frame.contentWindow.postMessage({ type: 'prism-live', files, env, argv }, location.origin);
  };
  window.addEventListener('message', onReady);
  box.append(frame);
  say(`${env} program: built and run on ${MACHINE_NAME[t.machine] ?? t.machine}, in the Screen tab ` +
      `(its build log is in the frame's panel)\n`, 'ok');
  $('status').textContent = `running (${env})`;
  $('run').disabled = true; $('stopBtn').disabled = false;
}

// ---------------------------------------------------------------- run
const tokenise = (s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/^["']|["']$/g, ''));

$('run').onclick = () => {
  if (typeof SharedArrayBuffer === 'undefined') {
    say('SharedArrayBuffer is unavailable — serve this page with tools/serve.mjs, which sends the ' +
      'COOP/COEP headers the browser requires.\n', 'err');
    return;
  }
  stash(); save();
  stop(true);
  out.textContent = '';
  if (creditStill()) { showCredit(lastCredit); say('\n'); }
  $('emitted').textContent = '';
  const env = detectEnv(files.filter((f) => /\.(c|cpp|cc|cxx|h|hpp)$/i.test(f.name)).map((f) => f.source));
  if (env !== 'console') { runOnScreen(env); return; }
  $('tabScreen').hidden = true;
  if (!$('screen').hidden) showTab('tabOut');
  $('status').textContent = 'compiling';

  const control = makeControl();
  views = controlViews(control);
  keyboard = makeKeyboard(views);

  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'out') emit(m.text);
    else if (m.type === 'built') {
      $('status').textContent = 'running';
      say(`compiled ${m.units} unit${m.units === 1 ? '' : 's'}, ${m.lines.toLocaleString('en')} ` +
          `lines in ${m.ms.toFixed(0)} ms — ${m.functions} functions, ` +
          `${(m.bytes / 1024).toFixed(1)} kB of JavaScript\n`, 'ok');
      if (m.failures.length) {
        say(`${m.failures.length} function${m.failures.length === 1 ? '' : 's'} could not be ` +
            `emitted; each throws if it is called:\n`, 'warn');
        for (const f of m.failures.slice(0, 8)) say(`  ${f}\n`, 'warn');
      }
      say('\n');
    }
    else if (m.type === 'emitted') $('emitted').textContent = m.source;
    else if (m.type === 'threw') say(`\nthe program threw: ${m.message}\n`, 'err');
    else if (m.type === 'diag') { say(`\n${m.message}\n`, 'err'); $('status').textContent = 'failed'; }
    else if (m.type === 'done') {
      say(`\n[exit ${m.code}${m.ms !== undefined ? ` after ${(m.ms / 1000).toFixed(2)} s` : ''}]\n`,
          m.code ? 'warn' : 'ok');
      $('status').textContent = m.code ? `exit ${m.code}` : 'exited';
      $('run').disabled = false; $('stopBtn').disabled = true;
    }
  };
  worker.onerror = (e) => {
    say(`worker error: ${e.message}\n`, 'err');
    $('status').textContent = 'failed';
    $('run').disabled = false; $('stopBtn').disabled = true;
  };
  worker.postMessage({ type: 'start', files, control, argv: tokenise($('argv').value), language: $('language').value });

  $('run').disabled = true; $('stopBtn').disabled = false;
  $('stdin').focus();
};

$('stopBtn').onclick = () => stop(false);
function stop(quiet) {
  // A display program runs in the frame: taking the frame away takes its worker with it.
  $('screen').replaceChildren();
  if (views) { Atomics.store(views.ctrl, SLOT.STOP, 1); wake(views.ctrl); }
  if (worker) { const w = worker; worker = null; setTimeout(() => w.terminate(), 100); }
  if (!quiet) {
    /*
     * Terminate, and say so. A program in an endless loop is the ONE case a page like this must
     * survive: there is no scheduler to preempt the guest, so the thread is taken away from it --
     * which is honest, and different from the program having decided to stop.
     */
    say('\n[stopped — the worker was terminated]\n', 'warn');
    $('status').textContent = 'stopped';
  }
  $('run').disabled = false; $('stopBtn').disabled = true;
}

/*
 * stdin: a line at a time, through the same shared queue a game's keyboard uses. Enter is 13 here,
 * as a PC's BIOS buffer holds it; the worker turns it into the 10 that `fgets` looks for.
 */
$('stdin').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !keyboard) return;
  for (const ch of e.target.value) keyboard.push(0, ch.charCodeAt(0) & 0xff);
  keyboard.push(0x1c, 13);
  wake(views.ctrl);
  e.target.value = '';
});

// ---------------------------------------------------------------- examples
/*
 * THE PICKER: a search, filters and tags, because 749 names in a <select> are not a choice. The tags
 * are what Run will do -- the environment web/live/envs.js reads from the includes, the one that
 * decides whether the program gets a screen -- plus C++ and stdin, so the two groups read the same way.
 */
const ENV_TAG = { glut: 'OpenGL', gl: 'OpenGL', sdl: 'SDL', sdl2: 'SDL', x11: 'X11', win32: 'Win32', 'win32-main': 'Win32' };
const ENV_TAGS = new Set(Object.values(ENV_TAG));     // the tags that name an environment
const SCREEN = new Set(['glut', 'gl', 'sdl', 'sdl2', 'x11', 'win32']);   // a window, not a console
const items = [];          // { value, label, group, tags, screen }
for (const [name, src] of Object.entries(EXAMPLES)) {
  const env = detectEnv([src]);
  const tags = [ENV_TAG[env], /\.cpp$/.test(name) && 'C++', /\b(scanf|fgets|getchar)\s*\(/.test(src) && 'stdin'].filter(Boolean);
  items.push({ value: name, label: name, group: 'prism', tags, screen: SCREEN.has(env) });
}

/*
 * ROSETTA CODE'S, listed from web/live/rosetta.json: the solutions PRISM ran right (tools/rosetta.mjs,
 * tools/rosetta-index.mjs). A task with several C solutions shows each, by its subsection when it has
 * one. The source is not here: choosing one fetches it from rosettacode.org, at the measured revision.
 */
let rosetta = [];
fetch(new URL('./rosetta.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d?.entries?.length) return;
  rosetta = d.entries;
  const count = rosetta.reduce((m, e) => m.set(e.task, (m.get(e.task) ?? 0) + 1), new Map());
  rosetta.forEach((e, i) => {
    const which = count.get(e.task) > 1 ? ` (${e.sub || `#${e.block + 1}`})` : '';
    items.push({ value: `rosetta:${i}`, label: `rosetta/${e.task}${which}`, group: 'rosetta',
      tags: [ENV_TAG[e.env]].filter(Boolean), screen: SCREEN.has(e.env) });
  });
  if (!$('picker').hidden) renderPicker();
}).catch(() => { /* no list, no group: the page's own examples still work */ });

const FILTERS = [['all', 'All'], ['screen', 'Graphical'], ['OpenGL', 'OpenGL'], ['SDL', 'SDL'], ['Win32', 'Win32'], ['console', 'Console']];
let filter = 'all', cursor = 0, shown = [];
const matches = (it, words) => (filter === 'all' || (filter === 'screen' ? it.screen : filter === 'console' ? !it.tags.some((t) => ENV_TAGS.has(t)) : it.tags.includes(filter)))
  && words.every((w) => it.label.toLowerCase().includes(w));
const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderPicker() {
  const words = $('pickSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  shown = items.filter((it) => matches(it, words));
  cursor = Math.min(cursor, Math.max(0, shown.length - 1));
  $('pickChips').innerHTML = FILTERS.map(([k, t]) => `<button type="button" data-f="${k}" aria-pressed="${k === filter}">${t}</button>`).join('');
  let html = '', last = null;
  shown.forEach((it, i) => {
    if (it.group !== last) {
      last = it.group;
      const n = shown.filter((x) => x.group === it.group).length;
      html += `<div class="pg">${it.group === 'prism' ? 'prism/ -- PRISM’s own' : 'rosetta/ -- loaded from rosettacode.org, GNU FDL'} <span>${n}</span></div>`;
    }
    html += `<div class="pi" role="option" data-i="${i}" aria-selected="${i === cursor}"><span>${escHtml(it.label)}</span>` +
      `<span class="tags">${it.tags.map((t) => `<span class="tag t-${t.replace(/\W/g, '')}">${t}</span>`).join('')}</span></div>`;
  });
  $('pickList').innerHTML = html || '<div class="pg">nothing matches</div>';
  $('pickFoot').textContent = `${shown.length} of ${items.length} -- Enter opens, Esc closes`;
}
function openPicker() {
  const b = $('pick').getBoundingClientRect(), p = $('picker');
  p.style.top = `${b.bottom + 4}px`;
  p.style.left = `${Math.max(8, Math.min(b.left, innerWidth - 480))}px`;
  p.hidden = false; $('pick').setAttribute('aria-expanded', 'true');
  renderPicker();
  $('pickSearch').focus(); $('pickSearch').select();
}
function closePicker() { $('picker').hidden = true; $('pick').setAttribute('aria-expanded', 'false'); }
$('pick').onclick = () => ($('picker').hidden ? openPicker() : closePicker());
$('pickSearch').addEventListener('input', () => { cursor = 0; renderPicker(); });
$('pickChips').addEventListener('click', (e) => { const f = e.target.closest('[data-f]')?.dataset.f; if (f) { filter = f; cursor = 0; renderPicker(); $('pickSearch').focus(); } });
$('pickList').addEventListener('click', (e) => { const i = e.target.closest('[data-i]')?.dataset.i; if (i !== undefined) choose(shown[+i]); });
$('pickSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePicker(); $('pick').focus(); return; }
  if (e.key === 'Enter') { e.preventDefault(); if (shown[cursor]) choose(shown[cursor]); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  cursor = Math.max(0, Math.min(shown.length - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1)));
  renderPicker();
  $('pickList').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
});
document.addEventListener('mousedown', (e) => { if (!$('picker').hidden && !e.target.closest('#picker, #pick')) closePicker(); });
function choose(it) { closePicker(); loadExample(it.value, it.label); }

let lastLoaded = null;     // the source an example put in the editor, so swapping it again needs no question
async function loadExample(value, label) {
  stash();
  /*
   * An example REPLACES the project rather than joining it, and that is not laziness: every example
   * defines main, and two units defining main is not a bigger program -- it is an ill-formed one.
   * The worker refuses to build it, which is right, but a picker that walks you into it is not.
   *
   * So: if what is open is still one of the examples, swap it silently; if you have written
   * something of your own, ask first. `+ file` is how a project of several files gets made, and
   * nothing here touches that.
   */
  const untouched = files.length === 1 &&
    (Object.values(EXAMPLES).some(src => src === files[0].source) || files[0].source === lastLoaded);
  if (!untouched && !confirm('Replace what is open with the example? Your files will be lost.')) return;
  // The program running is the one being replaced: it stops with its source.
  if (worker || $('screen').firstChild) stop(true);
  let name, source;
  if (value.startsWith('rosetta:')) {
    const e = rosetta[+value.slice(8)];
    out.textContent = '';
    say(`loading "${e.task}" from rosettacode.org (revision ${e.revid})...\n`);
    try {
      const blocks = cBlocks(await fetchCSection(e.task, e.revid));
      const b = blocks[e.block];
      if (!b) throw new Error(`its C section has ${blocks.length} solutions, not ${e.block + 1}`);
      source = b.code;
    } catch (err) {
      /*
       * A blocked request reads as a CORS error in the console whatever blocked it: an extension that
       * filters rosettacode.org, or Cloudflare's bot check answering with a page that carries no CORS
       * header. Neither is the task's fault, and the task is one click away.
       */
      say(`could not load it from rosettacode.org (${err.message}). The site may be blocked for this ` +
          `page (an ad or tracker blocker) or asking for a browser check; the task is at ${pageUrl(e.task)}\n`, 'err');
      return;
    }
    name = 'main.c';
    /*
     * THE CREDIT, every time one is loaded: the code is shown as Rosetta Code has it, and it is theirs,
     * under the GNU FDL 1.3, written by the people its page history names.
     */
    out.textContent = '';
    lastCredit = e;
    showCredit(e);
    say(`\nPRISM ran this solution${e.env === 'console' ? ' and printed what cc prints' : ` on ${e.env.replace(/-main$/, '')}`} when it was measured (${'Run'} to try it).\n`);
  } else {
    lastCredit = null;
    name = value.replace(/^prism\//, '');
    source = EXAMPLES[value];
  }
  lastLoaded = source;
  files = [{ name, source }];
  active = 0;
  $('pickName').textContent = label;
  save(); renderTabs(); showFile();
}

/*
 * THE CREDIT, every time Rosetta Code's code is loaded or run: it is shown as Rosetta Code has it,
 * and it is theirs, under the GNU FDL 1.3, written by the people its page history names.
 */
let lastCredit = null;
function showCredit(e) {
    say(`Rosetta Code, "${e.task}"${e.sub ? ` -- ${e.sub}` : ''}, C solution ${e.block + 1}, revision ${e.revid}\n`, 'ok');
    const credit = document.createElement('div');
    credit.className = 'credit';
    credit.innerHTML = `by its authors (<a target="_blank" rel="noopener" href="${historyUrl(e.task)}">page history</a>), ` +
      `under the <a target="_blank" rel="noopener" href="${LICENCE.url}">${LICENCE.name}</a>; ` +
      `<a target="_blank" rel="noopener" href="${pageUrl(e.task)}">the task on rosettacode.org</a>. ` +
      `Not part of PRISM: loaded from the site, shown unchanged.`;
    out.append(credit);
}
/** At each run, while what is open is still that solution. */
const creditStill = () => lastCredit && files.length === 1 && files[0].source === lastLoaded;

$('reset').onclick = () => {
  files = [{ name: 'main.c', source: EXAMPLES['prism/hello.c'] }];
  active = 0;
  save(); renderTabs(); showFile();
};

files = load();
renderTabs();
showFile();
