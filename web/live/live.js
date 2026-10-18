// live.js — the page half of Live C.
//
// Files in the browser, a worker that compiles and runs them, and two panes: what the program
// printed, and the JavaScript PRISM emitted for it. Nothing here knows any C; it holds text, starts
// a worker, and shows what comes back.

import { makeControl, controlViews, makeKeyboard, wake, SLOT } from '../../src/env/webhost.js';
import { ENV_TARGET, detectEnv } from './envs.js';

const $ = (id) => document.getElementById(id);

/*
 * THE EXAMPLES, and why these five.
 *
 * Not a tour of C. Each one is a place where a compiler that emits JavaScript has to do something
 * that is not a translation -- and where PRISM either does it or does not, visibly, in under a
 * second. A "hello world" proves the pipeline runs; it proves nothing about the pipeline.
 */
const EXAMPLES = {
  'hello.c': `/*
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

  'layout.c': `/*
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

  'floats.c': `/*
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

  'pointers.c': `/*
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

  'stdin.c': `/*
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
  'shapes.cpp': `/*
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
  return [{ name: 'main.c', source: EXAMPLES['hello.c'] }];
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
const showFile = () => { $('editor').value = files[active]?.source ?? ''; };

$('editor').addEventListener('input', () => { stash(); save(); });
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
  stash(); save();
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
const sel = $('examples');
for (const name of Object.keys(EXAMPLES)) {
  const o = document.createElement('option');
  o.value = name; o.textContent = name;
  sel.append(o);
}
sel.onchange = () => {
  const name = sel.value;
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
    Object.values(EXAMPLES).some(src => src === files[0].source);
  if (!untouched && !confirm('Replace what is open with the example? Your files will be lost.')) {
    sel.selectedIndex = -1;
    return;
  }
  files = [{ name, source: EXAMPLES[name] }];
  active = 0;
  save(); renderTabs(); showFile();
};

$('reset').onclick = () => {
  files = [{ name: 'main.c', source: EXAMPLES['hello.c'] }];
  active = 0;
  save(); renderTabs(); showFile();
};

files = load();
renderTabs();
showFile();
