/*
 * win32.c -- the Win32 API, the part a 1996 game asks for, in C.
 *
 * An environment shim like src/env/mgl.c, and in C for the same reason: almost every call here
 * takes or fills a STRUCT -- MSG, WNDCLASS, RECT, OSVERSIONINFO, MEMORYSTATUS, JOYCAPS -- and a
 * JavaScript implementation would have to know where each field sits. Those layouts are decided by
 * src/env/headers-win32.js, so a wrong offset would be a disagreement between two files I wrote,
 * which is the worst kind: silent, and true of nothing. In C the compiler settles it.
 *
 * The rule this follows is the one every shim here follows -- implement what a caller actually
 * calls, and answer honestly when the answer is "there is nothing here". A machine with no window
 * manager, no sound card, no CD drive and no joystick is a machine a Windows program from 1996 knew
 * how to cope with, because plenty of them were configured that way. So:
 *
 *   - LoadLibrary returns NULL, and snd_win.c's DirectSound path -- which reaches DirectSound only
 *     through GetProcAddress on dsound.dll -- gives up the way it does on a machine without it.
 *   - waveOutOpen returns MMSYSERR_ERROR, so the fallback gives up too and Quake runs silent.
 *   - mciSendCommand fails and CDAudio reports no CD.
 *   - joyGetNumDevs returns 0.
 *
 * None of that is a stub pretending to succeed. A stub that returns success and then does nothing is
 * how a program ends up waiting for something that will never happen.
 *
 * What genuinely works is what the game needs to RUN: the clock, memory, the console, and enough
 * window bookkeeping that VID_SetWindowedMode gets its client rectangle.
 */

#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

/*
 * Handles. A Win32 handle is opaque and only ever compared against NULL or passed back, so a small
 * integer cast to the right pointer type is the whole implementation. They start at 1 because 0 is
 * the failure value for most of these calls.
 */
static int next_handle = 1;
#define HANDLE_OF(type) ((type)(long)(next_handle++))

static int screen_w = 640, screen_h = 480;

/*
 * ---- THE WINDOW.
 *
 * Not bookkeeping that can be thrown away: the program MOVES and RESIZES it, and reads back where it
 * ended up. VID_SetWindowedMode resizes with one SetWindowPos and repositions with a second --
 * failing the first is `Sys_Error("Couldn't resize DIB window")` -- and VID_UpdateWindowStatus calls
 * GetWindowRect to store the position in the `vid_window_x` / `vid_window_y` cvars, which are
 * archived. A shim that swallowed all of that and answered a fixed rectangle made the window
 * unmovable and a resolution change invisible.
 *
 * These are published as plain integers so a host can draw a real window around the picture -- title
 * bar, border, close button -- and, when the person drags it, call prism_win32_move. That is not a
 * decoration: it is what a window manager does, and the program is written to be told.
 */
int prism_win32_x = 0, prism_win32_y = 0;
int prism_win32_w = 640, prism_win32_h = 480;
int prism_win32_visible = 0;
int prism_win32_minimized = 0;
int prism_win32_closed = 0;
char prism_win32_title[128] = "";

/** The host moved the window. GetWindowRect will report it, which is how the game finds out. */
void prism_win32_move(int x, int y)
{
    prism_win32_x = x;
    prism_win32_y = y;
}

/** The host clicked the close button. WM_CLOSE is what a real one posts. */
void prism_win32_close(void);

/* ---------------------------------------------------------------- the clock */

/*
 * QueryPerformanceCounter, over gettimeofday, at a microsecond tick.
 *
 * Sys_FloatTime divides the counter by the frequency, so the two only have to AGREE. A frequency of
 * one million and a counter in microseconds is the simplest pair that does, and it keeps the whole
 * thing inside 32 bits for about an hour and a half -- Quake reads LowPart and HighPart separately
 * and reassembles them, so the high word matters and is filled in.
 */
BOOL WINAPI QueryPerformanceFrequency(LARGE_INTEGER *freq)
{
    if (!freq) return FALSE;
    freq->QuadPart = 1000000;
    return TRUE;
}

BOOL WINAPI QueryPerformanceCounter(LARGE_INTEGER *count)
{
    struct timeval tv;
    if (!count) return FALSE;
    gettimeofday(&tv, 0);
    count->QuadPart = (LONGLONG)tv.tv_sec * 1000000 + tv.tv_usec;
    return TRUE;
}

void WINAPI Sleep(DWORD ms) { (void)ms; }

/* ---------------------------------------------------------------- the machine */

BOOL WINAPI GetVersionEx(LPOSVERSIONINFO v)
{
    if (!v) return FALSE;
    v->dwMajorVersion = 4;
    v->dwMinorVersion = 0;
    v->dwBuildNumber = 1381;
    v->dwPlatformId = VER_PLATFORM_WIN32_NT;
    v->szCSDVersion[0] = 0;
    return TRUE;
}

void WINAPI GlobalMemoryStatus(LPMEMORYSTATUS m)
{
    if (!m) return;
    m->dwLength = sizeof(*m);
    m->dwMemoryLoad = 0;
    /* Quake sizes its heap from this. 64 MB is more than the game asks for and less than a lie. */
    m->dwTotalPhys = m->dwAvailPhys = 64u * 1024 * 1024;
    m->dwTotalPageFile = m->dwAvailPageFile = 64u * 1024 * 1024;
    m->dwTotalVirtual = m->dwAvailVirtual = 64u * 1024 * 1024;
}

int WINAPI GetSystemMetrics(int index)
{
    switch (index) {
    case SM_CXSCREEN: return screen_w;
    case SM_CYSCREEN: return screen_h;
    /* No decorations, so the client area IS the window -- see AdjustWindowRectEx. */
    default: return 0;
    }
}

DWORD WINAPI GetCurrentDirectory(DWORD len, LPSTR buf)
{
    if (!buf || len < 2) return 0;
    buf[0] = '.'; buf[1] = 0;
    return 1;
}


/* ---------------------------------------------------------------- memory */

HGLOBAL WINAPI GlobalAlloc(UINT flags, DWORD bytes)
{
    (void)flags;
    return (HGLOBAL)calloc(bytes ? bytes : 1, 1);
}
LPVOID WINAPI GlobalLock(HGLOBAL h) { return (LPVOID)h; }
BOOL WINAPI GlobalUnlock(HGLOBAL h) { (void)h; return TRUE; }
HGLOBAL WINAPI GlobalFree(HGLOBAL h) { if (h) free((void *)h); return NULL; }

/* Every page is already writable here; there is no protection to change. */
BOOL WINAPI VirtualProtect(LPVOID addr, DWORD size, DWORD prot, LPDWORD old)
{
    (void)addr; (void)size; (void)prot;
    if (old) *old = PAGE_READWRITE;
    return TRUE;
}

LPVOID WINAPI MapViewOfFile(HANDLE h, DWORD access, DWORD hi, DWORD lo, DWORD bytes)
{
    (void)h; (void)access; (void)hi; (void)lo; (void)bytes;
    return NULL;                      /* no shared section: sys_win.c's ConProc path stands down */
}
BOOL WINAPI UnmapViewOfFile(LPCVOID p) { (void)p; return TRUE; }

/* ---------------------------------------------------------------- modules */

/*
 * NULL, deliberately and usefully. snd_win.c reaches DirectSound only through
 * `LoadLibrary("dsound.dll")` + GetProcAddress, so failing here is how a machine without DirectSound
 * answers, and the program's own fallback runs.
 */
HMODULE WINAPI GetModuleHandle(LPCSTR name) { (void)name; return NULL; }

/* ---------------------------------------------------------------- threads and events */

HANDLE WINAPI CreateThread(LPSECURITY_ATTRIBUTES sa, DWORD stack, LPTHREAD_START_ROUTINE fn,
                           LPVOID arg, DWORD flags, LPDWORD id)
{
    (void)sa; (void)stack; (void)fn; (void)arg; (void)flags;
    if (id) *id = 0;
    return NULL;                      /* one thread here; conproc.c reports it and carries on */
}
DWORD WINAPI ResumeThread(HANDLE t) { (void)t; return 0; }
/*
 * Events are real, and this is where "answer honestly that there is nothing here" stops applying.
 *
 * A missing sound card is a fact about a machine. An event object is not: every Windows has them,
 * they are pure bookkeeping, and WinMain does
 *
 *     tevent = CreateEvent(NULL, FALSE, FALSE, NULL);
 *     if (!tevent) Sys_Error("Couldn't create event");
 *
 * so returning NULL stopped the program before it printed its first line. There is one thread here,
 * so an event nobody can be waiting on is always signalled and the wait returns at once -- which is
 * what Quake uses it for, a sleep it can be woken from.
 */
HANDLE WINAPI CreateEvent(LPSECURITY_ATTRIBUTES sa, BOOL manual, BOOL initial, LPCSTR name)
{
    (void)sa; (void)manual; (void)initial; (void)name;
    return HANDLE_OF(HANDLE);
}
BOOL WINAPI SetEvent(HANDLE h) { (void)h; return TRUE; }
BOOL WINAPI ResetEvent(HANDLE h) { (void)h; return TRUE; }
DWORD WINAPI WaitForSingleObject(HANDLE h, DWORD ms) { (void)h; (void)ms; return WAIT_OBJECT_0; }
DWORD WINAPI WaitForMultipleObjects(DWORD n, HANDLE *h, BOOL all, DWORD ms)
{
    (void)n; (void)h; (void)all; (void)ms;
    return WAIT_OBJECT_0;
}
HANDLE WINAPI GetCurrentThread(void) { return HANDLE_OF(HANDLE); }
BOOL WINAPI SetPriorityClass(HANDLE h, DWORD c) { (void)h; (void)c; return TRUE; }
BOOL WINAPI SetThreadPriority(HANDLE h, int p) { (void)h; (void)p; return TRUE; }

/* ---------------------------------------------------------------- windows */

/*
 * The window procedure, remembered. DispatchMessage has to call it, and this is the only place its
 * address is ever handed over -- which also makes the pair a real test of PRISM's function-pointer
 * table: the callback goes out through a struct field and comes back as a call.
 */
/*
 * ONE WINDOW PROCEDURE PER CLASS, and one class per window.
 *
 * A single global was enough for a game, which registers one class and opens one window. It is not
 * enough for an application: PuTTY registers a class for its terminal and another for a hidden
 * window that exists only to receive WM_TIMER, and the last registration won -- so every timer
 * message was delivered to the terminal's procedure, which ignores it. The terminal then never
 * repainted after data arrived, because PuTTY does not repaint on data: it schedules a timer.
 *
 * The class NAME is the key, because that is what CreateWindowEx is given.
 */
#define MAX_CLASSES 8
#define MAX_WINDOWS 8
static struct { char name[64]; WNDPROC proc; int used; } classes[MAX_CLASSES];
static struct { HWND hwnd; WNDPROC proc; int used; } windows[MAX_WINDOWS];
static WNDPROC wndproc = NULL;          /* the most recent, for messages with no window */

static WNDPROC proc_for_class(const char *name)
{
    int i;
    if (!name) return wndproc;
    for (i = 0; i < MAX_CLASSES; i++)
        if (classes[i].used && !strcmp(classes[i].name, name)) return classes[i].proc;
    return wndproc;
}
static WNDPROC proc_for_window(HWND h)
{
    int i;
    for (i = 0; i < MAX_WINDOWS; i++)
        if (windows[i].used && windows[i].hwnd == h) return windows[i].proc;
    return wndproc;
}
static void remember_window(HWND h, WNDPROC p)
{
    int i;
    for (i = 0; i < MAX_WINDOWS; i++) {
        if (windows[i].used && windows[i].hwnd != h) continue;
        windows[i].hwnd = h; windows[i].proc = p; windows[i].used = 1;
        return;
    }
}

/*
 * Turn whatever the outside world has done into messages, before the queue is examined. Supplied by
 * src/env/win32-net.c when a target links it; undefined -- and therefore null -- when it does not.
 */
/*
 * A FLAG, not a pointer to the function. A function that is declared and never defined still has an
 * address here -- PRISM gives it one and reports it -- so `if (prism_net_pump)` is always true and
 * the call would throw for every target that has no network. An undefined VARIABLE reads as zero,
 * which is the linker's own behaviour and the thing to test.
 */
extern int prism_net_present;
extern void prism_net_pump(void);
static void prism_timers_pump(void);
static void prism_win32_pump(void)
{
    prism_timers_pump();
    if (prism_net_present) prism_net_pump();
}

ATOM WINAPI RegisterClass(const WNDCLASS *wc)
{
    int i;
    if (!wc || !wc->lpfnWndProc) return 0;
    wndproc = wc->lpfnWndProc;
    for (i = 0; i < MAX_CLASSES; i++) {
        if (classes[i].used && strcmp(classes[i].name, wc->lpszClassName ? wc->lpszClassName : ""))
            continue;
        strncpy(classes[i].name, wc->lpszClassName ? wc->lpszClassName : "", sizeof(classes[i].name) - 1);
        classes[i].name[sizeof(classes[i].name) - 1] = 0;
        classes[i].proc = wc->lpfnWndProc;
        classes[i].used = 1;
        break;
    }
    return (ATOM)next_handle++;
}

/*
 * ---- the message queue.
 *
 * Small, and a ring, because it is only ever a few keystrokes deep: the host pushes and the game
 * drains every frame. A full queue drops the oldest, which is what a keyboard buffer does.
 */
#define MSGQ 64
static MSG msgq[MSGQ];
static int msgq_head = 0, msgq_tail = 0;
static HWND msg_window = NULL;

/*
 * Posting is public, because a device outside this file has messages to deliver: src/env/win32-net.c
 * turns a socket's readiness into WM_NETEVENT, which is how PuTTY hears about the network at all.
 */
/*
 * TIMERS, which a program uses to schedule ITSELF.
 *
 * SetTimer and KillTimer used to succeed and do nothing, which looks harmless and is not: PuTTY's
 * terminal does not repaint when data arrives, it schedules an update and repaints when the timer
 * fires (timer_change_notify -> SetTimer -> WM_TIMER -> term_update). With no WM_TIMER the bytes
 * reached the terminal, the terminal recorded them, and the screen stayed blank -- which is a very
 * quiet way to fail.
 *
 * Windows timers REPEAT until killed, so a fired timer is rescheduled rather than removed.
 */
#define MAX_TIMERS 16
static struct { HWND hwnd; UINT_PTR id; unsigned interval; double due; int used; } timers[MAX_TIMERS];

extern double prism_now_ms(void);

UINT_PTR WINAPI SetTimer(HWND hwnd, UINT_PTR id, UINT elapse, void *proc)
{
    int i, free_slot = -1;
    (void)proc;                        /* a callback proc would bypass the queue; PuTTY passes NULL */
    for (i = 0; i < MAX_TIMERS; i++) {
        if (timers[i].used && timers[i].hwnd == hwnd && timers[i].id == id) break;
        if (!timers[i].used && free_slot < 0) free_slot = i;
    }
    if (i == MAX_TIMERS) { i = free_slot; if (i < 0) return 0; }
    timers[i].hwnd = hwnd;
    timers[i].id = id;
    timers[i].interval = elapse;
    timers[i].due = prism_now_ms() + (double)elapse;
    timers[i].used = 1;
    return id ? id : (UINT_PTR)(i + 1);
}

BOOL WINAPI KillTimer(HWND hwnd, UINT_PTR id)
{
    int i;
    for (i = 0; i < MAX_TIMERS; i++)
        if (timers[i].used && timers[i].hwnd == hwnd && timers[i].id == id) timers[i].used = 0;
    return TRUE;
}

static void prism_timers_pump(void)
{
    double now = prism_now_ms();
    int i;
    for (i = 0; i < MAX_TIMERS; i++) {
        if (!timers[i].used || now < timers[i].due) continue;
        timers[i].due = now + (double)(timers[i].interval ? timers[i].interval : 1);
        post_to(timers[i].hwnd, WM_TIMER, (WPARAM)timers[i].id, 0);
    }
}

void prism_win32_post(UINT message, WPARAM wParam, LPARAM lParam);

/*
 * A MESSAGE BELONGS TO A WINDOW, and `msg_window` -- the last window created -- is not always the
 * right one. A program with more than one window reads its own state back out of the handle the
 * message carries: PuTTY does `GetWindowLongPtr(hwnd, GWLP_USERDATA)` at the top of every WndProc
 * call, so a WM_PAINT delivered under the hidden timing window's handle handed it a null session and
 * a terminal whose every field was zero. The crash came out inside terminal.c, four calls away.
 */
static void post_to(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    MSG *m = &msgq[msgq_head % MSGQ];
    memset(m, 0, sizeof(*m));
    m->hwnd = hwnd ? hwnd : msg_window;
    m->message = message;
    m->wParam = wParam;
    m->lParam = lParam;
    msgq_head++;
    if (msgq_head - msgq_tail > MSGQ) msgq_tail = msgq_head - MSGQ;
}

static void post(UINT message, WPARAM wParam, LPARAM lParam)
{
    post_to(msg_window, message, wParam, lParam);
}

void prism_win32_post(UINT message, WPARAM wParam, LPARAM lParam)
{
    post(message, wParam, lParam);
}

/*
 * THE ONE PLACE THE PROGRAM WAITS.
 *
 * PuTTY's event loop (window.c:837) calls this with INFINITE when it has nothing to do, and that is
 * the only point in the whole program where waiting is the right thing. Answering WAIT_OBJECT_0
 * immediately turns the loop into a spin, which is what it was before anything could arrive.
 *
 * `prism_win32_idle` is supplied by whatever knows how to wait -- src/env/wsock.js waits on the
 * socket thread's ring. A target without one leaves the extern undefined, PRISM reads that as a null
 * pointer, and this falls back to returning at once: the old behaviour, for a program with nothing
 * to wait FOR.
 */
extern int prism_net_wait(int ms);

DWORD WINAPI MsgWaitForMultipleObjects(DWORD n, HANDLE *h, BOOL all, DWORD ms, DWORD mask)
{
    (void)h; (void)all; (void)mask;
    prism_win32_pump();
    if (msgq_head != msgq_tail) return WAIT_OBJECT_0 + n;   /* a message is waiting */
    if (ms != 0 && prism_net_present) {
        prism_net_wait(ms == INFINITE ? 50 : (int)ms);
        prism_win32_pump();
    }
    return msgq_head != msgq_tail ? WAIT_OBJECT_0 + n : WAIT_TIMEOUT;
}


/*
 * The host's way in: one key, pressed or released.
 *
 * `scan` is a set-1 PC scan code, the same currency src/env/scancodes.js and src/env/x11.js already
 * deal in. It goes in bits 16-23 of lParam because that is where the program reads it --
 * vid_win.c's MapKey is `(lParam >> 16) & 255`, indexing its own scantokey[] table. Putting a
 * virtual-key code in wParam instead would have looked right and delivered nothing.
 */
void prism_win32_key(int scan, int down)
{
    post(down ? WM_KEYDOWN : WM_KEYUP, 0, ((LPARAM)(scan & 0xff)) << 16);
}

HWND WINAPI CreateWindowEx(DWORD exStyle, LPCSTR cls, LPCSTR name, DWORD style,
                           int x, int y, int w, int h, HWND parent, HMENU menu,
                           HINSTANCE inst, LPVOID param)
{
    HWND hwnd;
    (void)exStyle; (void)style; (void)parent; (void)menu; (void)inst; (void)param;
    hwnd = HANDLE_OF(HWND);
    remember_window(hwnd, proc_for_class(cls));
    /*
     * The RECTANGLE still belongs to whichever window was made last, because there is one of those
     * and a program may have several. PuTTY's hidden timing window is 100x100 and its terminal is
     * not, so a window with no visible size does not get to claim it: a window created with
     * CW_USEDEFAULT or hidden leaves the record alone.
     */
    if (w > 0 && h > 0 && !(style & WS_CHILD) && w > 100) {
        prism_win32_w = w;
        prism_win32_h = h;
        if (x != CW_USEDEFAULT) prism_win32_x = x;
        if (y != CW_USEDEFAULT) prism_win32_y = y;
        if (name) strncpy(prism_win32_title, name, sizeof(prism_win32_title) - 1);
    }
    msg_window = hwnd;
    return hwnd;
}

BOOL WINAPI DestroyWindow(HWND w) { (void)w; return TRUE; }
/*
 * DefWindowProc VALIDATES on WM_PAINT, and that is not a detail: it is what stops a program that
 * does not paint from being asked for ever. Windows documents it as calling BeginPaint and EndPaint
 * itself, so the region is clean when it returns.
 *
 * Quake is exactly that program. Its MainWndProc ignores WM_PAINT, and Sys_SendKeyEvents pumps with
 *
 *     while (PeekMessage(&msg, NULL, 0, 0, PM_NOREMOVE)) { GetMessage(...); DispatchMessage(...); }
 *
 * so a WM_PAINT nobody validates is an infinite loop, and one that merely returns 0 changes what the
 * game does each frame -- gate-pixels caught the second before anything caught the first.
 */
HDC WINAPI BeginPaint(HWND w, LPPAINTSTRUCT ps);
BOOL WINAPI EndPaint(HWND w, const PAINTSTRUCT *ps);

LRESULT WINAPI DefWindowProc(HWND w, UINT m, WPARAM wp, LPARAM lp)
{
    (void)wp; (void)lp;
    if (m == WM_PAINT) {
        PAINTSTRUCT ps;
        BeginPaint(w, &ps);
        EndPaint(w, &ps);
    }
    return 0;
}
/*
 * WHETHER THIS IS THE ACTIVE APPLICATION, and it is not a formality.
 *
 * WinQuake's IN_Move is `if (ActiveApp && !Minimized) { IN_MouseMove(cmd); ... }` -- in_win.c:741 --
 * and `ActiveApp` comes from one place only: WM_ACTIVATE. With no window manager to send it, it
 * stayed false, so the mouse deltas arrived, were accumulated by IN_Accumulate (measured: mx_accum
 * reached 11,760) and were never once read. Everything below the boundary worked and nothing moved.
 *
 * The page is the desktop here, so a window that has been SHOWN is the active one, and the host says
 * so when the page gains or loses focus -- which is also what makes alt-tabbing away release the
 * mouse, as it should.
 */
void prism_win32_activate(int active)
{
    post(WM_ACTIVATE, active ? WA_ACTIVE : 0, 0);
}

BOOL WINAPI ShowWindow(HWND w, int cmd)
{
    (void)w;
    switch (cmd) {
    case SW_HIDE:            prism_win32_visible = 0; break;
    case SW_MINIMIZE:
    case SW_SHOWMINIMIZED:
    case SW_SHOWMINNOACTIVE: prism_win32_minimized = 1; prism_win32_visible = 1; break;
    default:                 prism_win32_minimized = 0; prism_win32_visible = 1; break;
    }
    /* Shown means activated: there is no other window here to take the focus away. */
    if (prism_win32_visible && !prism_win32_minimized) prism_win32_activate(1);
    return TRUE;
}
int WINAPI SetWindowText(HWND w, LPCSTR text)
{
    (void)w;
    if (text) strncpy(prism_win32_title, text, sizeof(prism_win32_title) - 1);
    return 1;
}
void prism_win32_close(void) { prism_win32_closed = 1; post(WM_CLOSE, 0, 0); }
/* UpdateWindow paints NOW rather than queueing: it calls WM_PAINT directly if anything is invalid. */
BOOL WINAPI UpdateWindow(HWND w)
{
    if (prism_dirty_any && wndproc) wndproc(w, WM_PAINT, 0, 0);
    return TRUE;
}
BOOL WINAPI SetForegroundWindow(HWND w) { (void)w; return TRUE; }
/*
 * The one call a resolution change goes through, so its flags have to be read rather than ignored.
 * VID_SetWindowedMode resizes with SWP_NOCOPYBITS|SWP_NOZORDER|SWP_HIDEWINDOW and then repositions
 * with SWP_NOSIZE|SWP_NOZORDER|SWP_SHOWWINDOW|SWP_DRAWFRAME -- two calls that mean opposite things
 * and were both answered TRUE and forgotten.
 */
BOOL WINAPI SetWindowPos(HWND w, HWND after, int x, int y, int cx, int cy, UINT flags)
{
    (void)w; (void)after;
    if (!(flags & SWP_NOMOVE)) { prism_win32_x = x; prism_win32_y = y; }
    if (!(flags & SWP_NOSIZE) && cx > 0 && cy > 0) { prism_win32_w = cx; prism_win32_h = cy; }
    if (flags & SWP_SHOWWINDOW) prism_win32_visible = 1;
    if (flags & SWP_HIDEWINDOW) prism_win32_visible = 0;
    return TRUE;
}
/*
 * THE WINDOW WORDS: a program's own storage, hanging off the window handle.
 *
 * This is not bookkeeping that can be skipped. PuTTY puts the pointer to its whole session --
 * WinGuiSeat, the terminal, the configuration, everything -- into GWLP_USERDATA at WM_NCCREATE and
 * reads it back at the top of every WndProc call. Returning 0 and forgetting means WndProc gets a
 * null session on the first message it is ever sent.
 *
 * Keyed by WINDOW as well as by index, because a program has more than one: PuTTY's hidden timing
 * window and its terminal both use slot -21, and sharing them would have crossed the two.
 */
#define PRISM_WORDS 64
static struct { HWND hwnd; int index; LONG value; int used; } prism_words[PRISM_WORDS];

LONG WINAPI SetWindowLong(HWND w, int index, LONG value)
{
    int i, free_slot = -1;
    for (i = 0; i < PRISM_WORDS; i++) {
        if (prism_words[i].used && prism_words[i].hwnd == w && prism_words[i].index == index) {
            LONG old = prism_words[i].value;
            prism_words[i].value = value;
            return old;
        }
        if (!prism_words[i].used && free_slot < 0) free_slot = i;
    }
    if (free_slot < 0) return 0;       /* out of slots: the value is dropped, not silently aliased */
    prism_words[free_slot].hwnd = w;
    prism_words[free_slot].index = index;
    prism_words[free_slot].value = value;
    prism_words[free_slot].used = 1;
    return 0;
}
LONG WINAPI GetWindowLong(HWND w, int index)
{
    int i;
    for (i = 0; i < PRISM_WORDS; i++)
        if (prism_words[i].used && prism_words[i].hwnd == w && prism_words[i].index == index)
            return prism_words[i].value;
    return 0;
}
DWORD WINAPI GetClassLong(HWND w, int index) { (void)w; (void)index; return 0; }
/*
 * THE UPDATE REGION, which is what makes a window repaint.
 *
 * Windows does not hand a program its pixels and forget: it remembers which part of the window is
 * invalid, and for as long as any part is, GetMessage keeps producing WM_PAINT. The program paints,
 * calls BeginPaint -- which VALIDATES the region -- and only then do the WM_PAINTs stop.
 *
 * All three halves of that matter and none of them were here. InvalidateRect returned TRUE and
 * forgot, so nothing was ever dirty; GetMessage never synthesised WM_PAINT, so nothing repainted;
 * and a program that had drawn once never drew again. PuTTY's terminal is redrawn from WM_PAINT, so
 * it would have shown its first frame and then frozen even with a working font behind it.
 *
 * The region is a single rectangle, unioned rather than tracked exactly. Windows keeps a real region
 * and a program may paint less than it is asked to; painting MORE than necessary is always correct,
 * and the difference is speed rather than pixels.
 *
 * WHAT INVALIDATES IS THE PROGRAM, and only the program. Windows also invalidates when a window is
 * shown, resized, or uncovered, and doing that here changed what Quake draws: its MainWndProc
 * answers WM_PAINT with SCR_UpdateWholeScreen (vid_win.c:2919), so inventing paints invented full
 * screen redraws, and gate-pixels went red on 152 rows. Nothing in this host covers or resizes a
 * window behind the program's back, so there is nothing for the platform to report -- and guessing
 * how many times a window manager would have done it is not fidelity, it is noise.
 */
static RECT prism_dirty;
static int prism_dirty_any;
static int prism_dirty_erase;
static HWND prism_dirty_hwnd;          /* whose region it is; the WM_PAINT goes there */

static void prism_invalidate(const RECT *r, int erase)
{
    RECT all;
    if (!r) {
        all.left = 0; all.top = 0;
        all.right = prism_win32_w; all.bottom = prism_win32_h;
        r = &all;
    }
    if (!prism_dirty_any) {
        prism_dirty = *r;
        prism_dirty_any = 1;
    } else {
        if (r->left < prism_dirty.left) prism_dirty.left = r->left;
        if (r->top < prism_dirty.top) prism_dirty.top = r->top;
        if (r->right > prism_dirty.right) prism_dirty.right = r->right;
        if (r->bottom > prism_dirty.bottom) prism_dirty.bottom = r->bottom;
    }
    if (erase) prism_dirty_erase = 1;
}

BOOL WINAPI InvalidateRect(HWND w, const RECT *r, BOOL erase)
{
    if (w) prism_dirty_hwnd = w;
    prism_invalidate(r, erase);
    return TRUE;
}
BOOL WINAPI ValidateRect(HWND w, const RECT *r)
{
    (void)w; (void)r;                  /* partial validation is not tracked; see the note above */
    prism_dirty_any = 0;
    return TRUE;
}
HWND WINAPI CreateDialog(HINSTANCE i, LPCSTR t, HWND p, LPVOID proc)
{
    (void)i; (void)t; (void)p; (void)proc;
    return NULL;
}
/*
 * There is no dialog here, so the answer has to be the one the host already gave.
 *
 * WM_CLOSE in vid_win.c:3020 asks "Are you sure you want to quit?" with MB_YESNO and quits only on
 * IDYES. Returning IDOK -- which is 1, not 6 -- meant the close button posted its message, the game
 * asked its question, and nothing happened. A person who clicks a window's close box has answered
 * that question; anything else is a modal dialog nobody can see.
 */
int WINAPI MessageBox(HWND w, LPCSTR text, LPCSTR caption, UINT type)
{
    (void)w; (void)text; (void)caption;
    return (type & MB_YESNO) ? IDYES : IDOK;
}
UINT WINAPI RegisterWindowMessage(LPCSTR name) { (void)name; return (UINT)(WM_USER + next_handle++); }
LRESULT WINAPI SendMessage(HWND w, UINT m, WPARAM wp, LPARAM lp)
{
    (void)w; (void)m; (void)wp; (void)lp;
    return 0;
}
BOOL WINAPI PostMessage(HWND w, UINT m, WPARAM wp, LPARAM lp)
{
    (void)w; (void)m; (void)wp; (void)lp;
    return TRUE;
}

/*
 * PostQuitMessage, which is how a Windows program ASKS ITS OWN LOOP TO STOP.
 *
 * It is the one message an application posts to itself and then waits to receive: WM_DESTROY calls
 * it, GetMessage answers FALSE when it comes back round, the loop ends and WinMain returns. Without
 * it PuTTY's window.c called a function that did not exist, the call threw, and the program was gone
 * before it had painted once -- which looked from outside like a program that refuses to start.
 *
 * The exit code goes in wParam, where a real Windows puts it and where WinMain reads it back.
 */
/*
 * THE MOUSE, and Win32 is the third answer to the same question.
 *
 * WinQuake's non-DirectInput path (in_win.c:673) is the warp-to-centre idiom again, one layer up:
 *
 *     GetCursorPos (&current_pos);
 *     mx = current_pos.x - window_center_x + mx_accum;
 *     ...
 *     if (mx || my) SetCursorPos (window_center_x, window_center_y);
 *
 * So the cursor needs a real POSITION that the program can move -- and both of those were stubs, one
 * returning the screen centre for ever and the other doing nothing, which meant `mx` was always
 * exactly zero. Keeping the position here and letting SetCursorPos set it is the whole of it.
 *
 * Buttons are messages, not state: MainWndProc (vid_win.c:2942) takes six of them and rebuilds the
 * button mask from wParam's MK_* bits each time -- with id's own comment that Win32 packs several
 * mouse events into one update, so it never trusts the message type. That is why the mask is sent
 * on every button message and why a plain WM_MOUSEMOVE carries it too.
 */
static int cursor_x = 0, cursor_y = 0;

/**
 * The host's way in for the pointer: how far it moved, and which buttons are down.
 *
 * `buttons` is bit 0 left, bit 1 right, bit 2 middle -- the order INT 33h uses, so the three hosts
 * share one convention and the page has one mask to maintain.
 */
void prism_win32_mouse(int dx, int dy, int buttons)
{
    static int was = 0;
    WPARAM mk = 0;

    cursor_x += dx;
    cursor_y += dy;

    if (buttons & 1) mk |= MK_LBUTTON;
    if (buttons & 2) mk |= MK_RBUTTON;
    if (buttons & 4) mk |= MK_MBUTTON;

    if (dx || dy) post(WM_MOUSEMOVE, mk, ((LPARAM)(cursor_y & 0xffff) << 16) | (cursor_x & 0xffff));

    /*
     * One message per button that CHANGED, because that is what Windows sends -- and the program
     * reads the whole mask out of wParam anyway, so the message type only has to be plausible.
     */
    if ((buttons ^ was) & 1) post((buttons & 1) ? WM_LBUTTONDOWN : WM_LBUTTONUP, mk, 0);
    if ((buttons ^ was) & 2) post((buttons & 2) ? WM_RBUTTONDOWN : WM_RBUTTONUP, mk, 0);
    if ((buttons ^ was) & 4) post((buttons & 4) ? WM_MBUTTONDOWN : WM_MBUTTONUP, mk, 0);
    was = buttons;
}

void WINAPI PostQuitMessage(int code)
{
    MSG *m = &msgq[msgq_head % MSGQ];
    memset(m, 0, sizeof(*m));
    m->message = WM_QUIT;
    m->wParam = (WPARAM)code;
    m->hwnd = 0;
    msgq_head++;
}

/*
 * The message queue: empty.
 *
 * PeekMessage returning FALSE is what an application with nothing waiting sees, and Sys_SendKeyEvents
 * loops on exactly that and returns. It is also where keyboard input WOULD arrive, so this is the one
 * function to change when the page starts feeding events -- everything else here is bookkeeping.
 */
BOOL WINAPI PeekMessage(LPMSG msg, HWND w, UINT min, UINT max, UINT flags)
{
    (void)w; (void)min; (void)max;
    if (msgq_head == msgq_tail) {
        /*
         * WM_PAINT is the LOWEST priority message: Windows produces it only when nothing else is
         * waiting, which is why it is synthesised here rather than posted when the region goes bad.
         * It is not removed by PM_REMOVE either -- BeginPaint is what makes it stop.
         */
        if (prism_dirty_any) {
            if (msg) { memset(msg, 0, sizeof(*msg)); msg->message = WM_PAINT;
                       msg->hwnd = prism_dirty_hwnd ? prism_dirty_hwnd : msg_window; }
            return TRUE;
        }
        if (msg) memset(msg, 0, sizeof(*msg));
        return FALSE;
    }
    if (msg) *msg = msgq[msgq_tail % MSGQ];
    if (flags & PM_REMOVE) msgq_tail++;
    return TRUE;
}

/*
 * GetMessage REMOVES, and its FALSE means WM_QUIT -- not "nothing waiting".
 *
 * That distinction is the whole trap here. Sys_SendKeyEvents peeks with PM_NOREMOVE and then calls
 * `if (!GetMessage(...)) Sys_Quit();`, so a GetMessage that answered FALSE for an empty queue would
 * have quit the game on the first keystroke. It was harmless only for as long as PeekMessage never
 * said there was anything.
 */
BOOL WINAPI GetMessage(LPMSG msg, HWND w, UINT min, UINT max)
{
    (void)w; (void)min; (void)max;
    if (msgq_head == msgq_tail) {
        if (prism_dirty_any) {
            if (msg) { memset(msg, 0, sizeof(*msg)); msg->message = WM_PAINT;
                       msg->hwnd = prism_dirty_hwnd ? prism_dirty_hwnd : msg_window; }
            return TRUE;
        }
        if (msg) memset(msg, 0, sizeof(*msg));
        return TRUE;                  /* nothing waiting is not a reason to stop */
    }
    if (msg) *msg = msgq[msgq_tail % MSGQ];
    msgq_tail++;
    return msg && msg->message == WM_QUIT ? FALSE : TRUE;
}

BOOL WINAPI TranslateMessage(const MSG *m) { (void)m; return FALSE; }

LRESULT WINAPI DispatchMessage(const MSG *m)
{
    WNDPROC p;
    if (!m) return 0;
    p = proc_for_window(m->hwnd);
    if (!p) return 0;
    return p(m->hwnd, m->message, m->wParam, m->lParam);
}

/*
 * No decorations, so the window rectangle equals the client rectangle and this changes nothing.
 * VID_SetWindowedMode calls it to work out how much bigger the window must be than the picture;
 * answering "not at all" is right for a surface the page presents directly.
 */
BOOL WINAPI AdjustWindowRectEx(LPRECT r, DWORD style, BOOL menu, DWORD exStyle)
{
    (void)r; (void)style; (void)menu; (void)exStyle;
    return TRUE;
}
/*
 * The CLIENT rectangle is the picture, at the origin. The WINDOW rectangle is where it sits on the
 * screen -- and the difference matters: VID_UpdateWindowStatus reads GetWindowRect to save the
 * position into `vid_window_x` and `vid_window_y`, so answering the client rectangle for both told
 * the game the window was always at 0,0 and it dutifully wrote that down.
 */
BOOL WINAPI GetClientRect(HWND w, LPRECT r)
{
    (void)w;
    if (!r) return FALSE;
    r->left = r->top = 0; r->right = prism_win32_w; r->bottom = prism_win32_h;
    return TRUE;
}
BOOL WINAPI GetWindowRect(HWND w, LPRECT r)
{
    (void)w;
    if (!r) return FALSE;
    r->left = prism_win32_x; r->top = prism_win32_y;
    r->right = prism_win32_x + prism_win32_w; r->bottom = prism_win32_y + prism_win32_h;
    return TRUE;
}

/* ---------------------------------------------------------------- mouse and cursor */

BOOL WINAPI ShowCursor(BOOL show) { (void)show; return TRUE; }
/* The cursor has a position now -- see prism_win32_mouse. A program that centres it gets centred. */
BOOL WINAPI SetCursorPos(int x, int y) { cursor_x = x; cursor_y = y; return TRUE; }
BOOL WINAPI GetCursorPos(LPPOINT p) { if (p) { p->x = cursor_x; p->y = cursor_y; } return TRUE; }
BOOL WINAPI ClipCursor(const RECT *r) { (void)r; return TRUE; }
HWND WINAPI SetCapture(HWND w) { (void)w; return NULL; }
BOOL WINAPI ReleaseCapture(void) { return TRUE; }
HCURSOR WINAPI LoadCursor(HINSTANCE i, LPCSTR n) { (void)i; (void)n; return HANDLE_OF(HCURSOR); }
HICON WINAPI LoadIcon(HINSTANCE i, LPCSTR n) { (void)i; (void)n; return HANDLE_OF(HICON); }
BOOL WINAPI SystemParametersInfo(UINT action, UINT param, LPVOID data, UINT win)
{
    (void)action; (void)param; (void)data; (void)win;
    return TRUE;
}

/* ---------------------------------------------------------------- GDI */

HDC WINAPI GetDC(HWND w) { (void)w; return HANDLE_OF(HDC); }
int WINAPI ReleaseDC(HWND w, HDC dc) { (void)w; (void)dc; return 1; }
/*
 * BeginPaint VALIDATES. That is the half of this that is easy to leave out and impossible to notice
 * afterwards: without it the region stays dirty, GetMessage keeps handing out WM_PAINT, and the
 * program repaints for ever instead of waiting for the next real event.
 */
HDC WINAPI BeginPaint(HWND w, LPPAINTSTRUCT ps)
{
    (void)w;
    if (ps) {
        memset(ps, 0, sizeof(*ps));
        ps->hdc = HANDLE_OF(HDC);
        ps->fErase = prism_dirty_erase ? TRUE : FALSE;
        if (prism_dirty_any) ps->rcPaint = prism_dirty;
        else { ps->rcPaint.left = ps->rcPaint.top = 0;
               ps->rcPaint.right = prism_win32_w; ps->rcPaint.bottom = prism_win32_h; }
    }
    prism_dirty_any = 0;
    prism_dirty_erase = 0;
    return HANDLE_OF(HDC);
}
BOOL WINAPI EndPaint(HWND w, const PAINTSTRUCT *ps) { (void)w; (void)ps; return TRUE; }

/*
 * No hardware palette. vid_win.c asks RASTERCAPS whether the display has one and takes a different
 * path if it does; saying no keeps it on the path that hands its colours to MGL, which is the one
 * this build implements.
 */
int WINAPI GetDeviceCaps(HDC dc, int index)
{
    (void)dc;
    switch (index) {
    case RASTERCAPS: return 0;
    case BITSPIXEL:  return 8;
    case HORZRES:    return screen_w;
    case VERTRES:    return screen_h;
    default:         return 0;
    }
}
UINT WINAPI GetSystemPaletteUse(HDC dc) { (void)dc; return SYSPAL_STATIC; }
UINT WINAPI SetSystemPaletteUse(HDC dc, UINT use) { (void)dc; (void)use; return SYSPAL_STATIC; }
BOOL WINAPI PatBlt(HDC dc, int x, int y, int w, int h, DWORD rop)
{
    (void)dc; (void)x; (void)y; (void)w; (void)h; (void)rop;
    return TRUE;
}
/* ---------------------------------------------------------------- the DIB, which is the picture
 *
 * GDI is how Quake II's software renderer reaches the screen on Windows: rw_imp.c calls DIB_Init
 * unconditionally, so this path -- not the DirectDraw one beside it -- is the one that draws.
 *
 * The shape is the same bargain MGL makes in src/env/mgl.c, and for the same reason: the program
 * asks for a buffer, writes its pixels into it, and hands it back. So CreateDIBSection ALLOCATES and
 * reports where, SetDIBColorTable takes the palette, and BitBlt is the moment a picture is finished.
 * The host reads these globals out of the linked image exactly as it reads prism_mgl_surface.
 *
 * One DIB section is modelled, because rw_dib.c creates one. A second would replace it, which is
 * stated rather than guarded: a program that wanted two off-screen surfaces would need a table, and
 * this one does not.
 */
void *prism_dib_surface = 0;
int   prism_dib_width = 0;
int   prism_dib_height = 0;
int   prism_dib_pitch = 0;
int   prism_dib_topdown = 0;
int   prism_dib_frames = 0;
unsigned char prism_dib_palette[256 * 3];
int   prism_dib_palgen = 0;

/*
 * Handles as TAGGED INTEGERS, distinct per kind so that a program comparing two of them, or testing
 * one for NULL, gets an answer that means something. Nothing dereferences these.
 */
#define PRISM_DC_TAG      0x44430000
#define PRISM_DIB_TAG     0x44490000
#define PRISM_PAL_TAG     0x50410000
static int prism_gdi_serial = 1;

HDC WINAPI CreateCompatibleDC(HDC dc)
{
    (void)dc;
    return (HDC)(PRISM_DC_TAG | (prism_gdi_serial++ & 0xffff));
}
BOOL WINAPI DeleteDC(HDC dc) { (void)dc; return TRUE; }

/*
 * The surface. A DIB's rows are padded to a DWORD -- vid.rowbytes downstream is this pitch, so the
 * renderer strides by it -- and a NEGATIVE biHeight means the rows run top-down, which is what
 * Quake II asks for and what a host wants to read.
 */
HBITMAP WINAPI CreateDIBSection(HDC dc, LPBITMAPINFO bmi, UINT usage,
                                void **bits, HANDLE section, DWORD offset)
{
    int w, h, bpp;
    (void)dc; (void)usage; (void)section; (void)offset;
    if (!bmi) return 0;
    w = (int)bmi->bmiHeader.biWidth;
    h = (int)bmi->bmiHeader.biHeight;
    bpp = (int)bmi->bmiHeader.biBitCount;
    prism_dib_topdown = h < 0;
    if (h < 0) h = -h;
    if (w <= 0 || h <= 0) return 0;
    prism_dib_pitch = ((w * bpp + 31) / 32) * 4;
    prism_dib_surface = malloc((size_t)prism_dib_pitch * (size_t)h);
    if (!prism_dib_surface) return 0;
    memset(prism_dib_surface, 0, (size_t)prism_dib_pitch * (size_t)h);
    prism_dib_width = w;
    prism_dib_height = h;
    if (bits) *bits = prism_dib_surface;
    return (HBITMAP)(PRISM_DIB_TAG | (prism_gdi_serial++ & 0xffff));
}

/* The palette, in the DIB's own currency: BGRA quads, which become the host's r,g,b triples. */
UINT WINAPI SetDIBColorTable(HDC dc, UINT start, UINT n, RGBQUAD *colors)
{
    UINT i;
    (void)dc;
    if (!colors) return 0;
    for (i = 0; i < n && start + i < 256; i++) {
        prism_dib_palette[(start + i) * 3 + 0] = colors[i].rgbRed;
        prism_dib_palette[(start + i) * 3 + 1] = colors[i].rgbGreen;
        prism_dib_palette[(start + i) * 3 + 2] = colors[i].rgbBlue;
    }
    prism_dib_palgen++;
    return n;
}

/*
 * THE FRAME BOUNDARY. rw_imp.c blits the DIB section to the window's DC once a picture is complete,
 * so this is where a host gets its one chance to present and to pace the guest -- the same role
 * MGL_bitBltCoord plays for WinQuake and XPutImage for the X11 client.
 */
BOOL WINAPI BitBlt(HDC dst, int x, int y, int w, int h, HDC src, int sx, int sy, DWORD rop)
{
    (void)dst; (void)x; (void)y; (void)w; (void)h; (void)src; (void)sx; (void)sy; (void)rop;
    prism_dib_frames++;
    return TRUE;
}

/*
 * Objects and palettes as tokens. The DIB path takes its colours through SetDIBColorTable, so the
 * palette calls exist to be called and to return something a null-check accepts; SelectObject must
 * hand back the PREVIOUS object, because a caller restores it.
 */
HGDIOBJ WINAPI SelectObject(HDC dc, HGDIOBJ obj)
{
    static HGDIOBJ previous = 0;
    HGDIOBJ was = previous;
    (void)dc;
    previous = obj;
    return was;
}
BOOL      WINAPI DeleteObject(HGDIOBJ obj) { (void)obj; return TRUE; }
HPALETTE  WINAPI CreatePalette(LOGPALETTE *pal)
{
    (void)pal;
    return (HPALETTE)(PRISM_PAL_TAG | (prism_gdi_serial++ & 0xffff));
}
HPALETTE  WINAPI SelectPalette(HDC dc, HPALETTE pal, BOOL force)
{
    (void)dc; (void)pal; (void)force;
    return 0;
}
UINT      WINAPI RealizePalette(HDC dc) { (void)dc; return 0; }

/*
 * System colours. There is no desktop, so these are inert -- but rw_dib.c SAVES them, changes them
 * and restores them around its palette, so the pair has to behave like storage or the restore
 * writes back nonsense.
 */
static COLORREF prism_sys_colors[NUM_SYS_COLORS];
DWORD WINAPI GetSysColor(int index)
{
    if (index < 0 || index >= NUM_SYS_COLORS) return 0;
    return prism_sys_colors[index];
}
BOOL WINAPI SetSysColors(int n, const int *indices, const COLORREF *colors)
{
    int i;
    if (!indices || !colors) return FALSE;
    for (i = 0; i < n; i++) {
        if (indices[i] >= 0 && indices[i] < NUM_SYS_COLORS) {
            prism_sys_colors[indices[i]] = colors[i];
        }
    }
    return TRUE;
}

/* The window geometry calls vid_dll.c makes. AdjustWindowRectEx above already does the work. */
BOOL WINAPI AdjustWindowRect(LPRECT r, DWORD style, BOOL menu)
{
    return AdjustWindowRectEx(r, style, menu, 0);
}
BOOL WINAPI MoveWindow(HWND wnd, int x, int y, int w, int h, BOOL repaint)
{
    (void)repaint;
    return SetWindowPos(wnd, 0, x, y, w, h, 0);
}
BOOL WINAPI UnregisterClass(LPCSTR name, HINSTANCE inst) { (void)name; (void)inst; return TRUE; }
HWND WINAPI SetFocus(HWND wnd) { (void)wnd; return 0; }

/* ---------------------------------------------------------------- the MSVC libc names
 *
 * Four names a Win32 program takes from its C library rather than from the API, declared in
 * headers-win32.js and answered here.
 */

/*
 * _controlfp sets the x87 control word, and Quake II asks for single precision:
 *
 *     _controlfp( _PC_24, _MCW_PC );
 *
 * There is no x87 here, and the request cannot be honoured even in spirit -- PRISM computes float
 * in float (Math.fround on every store and operation) and double in double, which is what a program
 * asking for 24-bit precision was trying to approximate on hardware that computed everything in 80.
 * So this reports the mask back, the shape of "nothing changed", and does not pretend to round.
 *
 * WHY IT MATTERED OUT OF ALL PROPORTION: WinMain calls it, so while it was undeclared WinMain could
 * not be emitted and became a stub that threw. The run said "unimplemented: WinMain", which reads
 * like a missing entry point and was a missing libc name.
 */
unsigned int _controlfp(unsigned int newval, unsigned int mask)
{
    (void)newval;
    return mask;
}

char *_getcwd(char *buf, int size) { return getcwd(buf, size); }
/* conproc.c's console thread ends with this; PRISM's threads end by returning. */
void _endthreadex(unsigned int code) { (void)code; }

/*
 * _beginthreadex, refused. conproc.c starts a thread to read a parent process's console pipe -- the
 * dedicated server's remote console -- and there is no parent and no pipe here. Returning 0 is the
 * failure a Windows program is written to handle, and InitConProc gives up quietly.
 */
unsigned long _beginthreadex(void *sec, unsigned stack, unsigned (*start)(void *),
                             void *arg, unsigned flags, unsigned *id)
{
    (void)sec; (void)stack; (void)start; (void)arg; (void)flags;
    if (id) *id = 0;
    return 0;
}

/*
 * GetDriveType, answering that there is no CD. Sys_ScanForCD walks the drive letters looking for
 * one; DRIVE_UNKNOWN on every letter ends the scan with nothing found, which agrees with what
 * mciSendCommand already tells CDAudio. Two shims that disagreed about whether a CD exists would be
 * worse than either answer.
 */
UINT WINAPI GetDriveType(LPCSTR root) { (void)root; return 0; }



/*
 * Five more the Win32 client reaches for, each answered the way this file answers everything: with
 * what is true of a machine that has no desktop shell.
 *
 * timeBeginPeriod and timeEndPeriod ask the multimedia timer for a finer tick; there is one clock
 * here and it does not get finer. RegisterHotKey is how vid_dll.c disables Alt-Tab, which a page
 * cannot intercept and should not pretend to. OutputDebugString goes where a debugger would be.
 */
DWORD WINAPI timeBeginPeriod(UINT period) { (void)period; return 0; }
DWORD WINAPI timeEndPeriod(UINT period) { (void)period; return 0; }
BOOL  WINAPI RegisterHotKey(HWND w, int id, UINT mods, UINT vk)
{
    (void)w; (void)id; (void)mods; (void)vk;
    return FALSE;                      /* no hot key registered, so Alt-Tab keeps working */
}
BOOL  WINAPI UnregisterHotKey(HWND w, int id) { (void)w; (void)id; return TRUE; }
void  WINAPI OutputDebugString(LPCSTR text) { (void)text; }
UINT  WINAPI SetErrorMode(UINT mode) { (void)mode; return 0; }

/*
 * FormatMessage, which sys_win.c uses to turn GetLastError into a sentence for its error box. It
 * gets a short one rather than nothing: an empty buffer would make the box say a number and no
 * words, which is the shape of a bug report nobody can act on.
 */
DWORD WINAPI FormatMessage(DWORD flags, const void *src, DWORD id, DWORD lang,
                           LPSTR buf, DWORD size, void *args)
{
    static char text[64];
    (void)flags; (void)src; (void)lang; (void)args;
    sprintf(text, "error %lu", (unsigned long)id);
    if (flags & FORMAT_MESSAGE_ALLOCATE_BUFFER) {
        if (buf) *(char **)buf = text;
    } else if (buf && size) {
        strncpy(buf, text, size - 1);
        buf[size - 1] = 0;
    }
    return (DWORD)strlen(text);
}

/*
 * The directory walk, and it finds nothing -- which is a state Quake II is written for, not a
 * refusal dressed up.
 *
 * Sys_FindFirst drives the MENU's lists: saved games, demos, the map list. The DATA does not come
 * through here, because qcommon/files.c:535 adds pak files by numbered name in a loop rather than
 * by scanning, so a game whose directory walk returns nothing still loads every pak it has and
 * plays. What is empty is the file list in a menu nobody has opened yet.
 *
 * Making it real would mean enumerating PRISM's virtual filesystem from C, which needs a primitive
 * the stdio layer does not expose today. That is a small piece of work and it is not this one.
 */
long _findfirst(const char *spec, struct _finddata_t *info)
{
    (void)spec; (void)info;
    return -1;
}
int _findnext(long handle, struct _finddata_t *info) { (void)handle; (void)info; return -1; }
int _findclose(long handle) { (void)handle; return 0; }

/*
 * timeGetTime, the multimedia clock Sys_Milliseconds is built on. Milliseconds since the process
 * started, from the same gettimeofday this file already uses for QueryPerformanceCounter -- one
 * clock, so two timers cannot disagree with each other.
 */
DWORD WINAPI timeGetTime(void)
{
    struct timeval tv;
    static long base_sec = 0;
    gettimeofday(&tv, 0);
    if (!base_sec) base_sec = tv.tv_sec;
    return (DWORD)((tv.tv_sec - base_sec) * 1000 + tv.tv_usec / 1000);
}

/*
 * The clipboard, answered honestly: there is none. OpenClipboard failing is what a Windows program
 * from 1996 was written to cope with, and Quake II's console paste simply does nothing -- which is
 * the correct outcome, not a missing feature pretending to work.
 */
BOOL   WINAPI OpenClipboard(HWND wnd) { (void)wnd; return FALSE; }
HANDLE WINAPI GetClipboardData(UINT format) { (void)format; return 0; }
BOOL   WINAPI CloseClipboard(void) { return TRUE; }
DWORD  WINAPI GlobalSize(HANDLE mem) { (void)mem; return 0; }

BOOL WINAPI EnumDisplaySettings(LPCSTR device, DWORD mode, LPVOID dm)
{
    (void)device; (void)mode; (void)dm;
    return FALSE;                     /* no modes to enumerate; the fullscreen path stands down */
}
LONG WINAPI ChangeDisplaySettings(LPVOID dm, DWORD flags)
{
    (void)dm; (void)flags;
    return DISP_CHANGE_FAILED;
}

/* ---------------------------------------------------------------- the console */

/*
 * Quake's dedicated-server console. AllocConsole succeeds and WriteFile on the output handle goes to
 * stdout, which is where a PRISM program's output already goes; the rest reports an empty console,
 * so nothing waits for input that will not come.
 */
#define CONSOLE_OUT ((HANDLE)(long)0x7c01)
#define CONSOLE_IN  ((HANDLE)(long)0x7c02)

BOOL WINAPI AllocConsole(void) { return TRUE; }
BOOL WINAPI FreeConsole(void) { return TRUE; }
HANDLE WINAPI GetStdHandle(DWORD which)
{
    return which == STD_INPUT_HANDLE ? CONSOLE_IN : CONSOLE_OUT;
}

extern int write(int fd, const void *buf, unsigned n);

BOOL WINAPI WriteFile(HANDLE h, LPCVOID buf, DWORD n, LPDWORD written, LPVOID ov)
{
    (void)ov;
    if (h == CONSOLE_OUT && buf && n) write(1, buf, n);
    if (written) *written = n;
    return TRUE;
}
BOOL WINAPI ReadFile(HANDLE h, LPVOID buf, DWORD n, LPDWORD got, LPVOID ov)
{
    (void)h; (void)buf; (void)n; (void)ov;
    if (got) *got = 0;
    return FALSE;
}
BOOL WINAPI GetConsoleScreenBufferInfo(HANDLE h, PCONSOLE_SCREEN_BUFFER_INFO info)
{
    (void)h;
    if (!info) return FALSE;
    memset(info, 0, sizeof(*info));
    info->dwSize.X = 80; info->dwSize.Y = 25;
    info->dwMaximumWindowSize.X = 80; info->dwMaximumWindowSize.Y = 25;
    info->srWindow.Right = 79; info->srWindow.Bottom = 24;
    return TRUE;
}
COORD WINAPI GetLargestConsoleWindowSize(HANDLE h)
{
    COORD c;
    (void)h;
    c.X = 80; c.Y = 25;
    return c;
}
BOOL WINAPI SetConsoleScreenBufferSize(HANDLE h, COORD size) { (void)h; (void)size; return TRUE; }
BOOL WINAPI SetConsoleWindowInfo(HANDLE h, BOOL absolute, const SMALL_RECT *r)
{
    (void)h; (void)absolute; (void)r;
    return TRUE;
}
BOOL WINAPI GetNumberOfConsoleInputEvents(HANDLE h, LPDWORD n)
{
    (void)h;
    if (n) *n = 0;
    return TRUE;
}
BOOL WINAPI ReadConsoleInput(HANDLE h, PINPUT_RECORD rec, DWORD n, LPDWORD got)
{
    (void)h; (void)rec; (void)n;
    if (got) *got = 0;
    return FALSE;
}
BOOL WINAPI WriteConsoleInput(HANDLE h, const INPUT_RECORD *rec, DWORD n, LPDWORD put)
{
    (void)h; (void)rec;
    if (put) *put = n;
    return TRUE;
}
BOOL WINAPI ReadConsoleOutputCharacter(HANDLE h, LPSTR buf, DWORD n, COORD at, LPDWORD got)
{
    (void)h; (void)at;
    if (buf && n) memset(buf, ' ', n);
    if (got) *got = n;
    return TRUE;
}

/* ---------------------------------------------------------------- multimedia */

MMRESULT WINAPI waveOutOpen(HWAVEOUT *h, UINT id, LPWAVEFORMATEX fmt, DWORD cb, DWORD inst, DWORD flags)
{
    (void)id; (void)fmt; (void)cb; (void)inst; (void)flags;
    if (h) *h = NULL;
    return MMSYSERR_ERROR;            /* no wave device; snd_win.c reports it and runs silent */
}
MMRESULT WINAPI waveOutClose(HWAVEOUT h) { (void)h; return MMSYSERR_NOERROR; }
MMRESULT WINAPI waveOutReset(HWAVEOUT h) { (void)h; return MMSYSERR_NOERROR; }
MMRESULT WINAPI waveOutPrepareHeader(HWAVEOUT h, LPWAVEHDR hd, UINT n) { (void)h; (void)hd; (void)n; return MMSYSERR_ERROR; }
MMRESULT WINAPI waveOutUnprepareHeader(HWAVEOUT h, LPWAVEHDR hd, UINT n) { (void)h; (void)hd; (void)n; return MMSYSERR_ERROR; }
MMRESULT WINAPI waveOutWrite(HWAVEOUT h, LPWAVEHDR hd, UINT n) { (void)h; (void)hd; (void)n; return MMSYSERR_ERROR; }

UINT WINAPI joyGetNumDevs(void) { return 0; }
MMRESULT WINAPI joyGetDevCaps(UINT id, LPJOYCAPS caps, UINT n) { (void)id; (void)caps; (void)n; return JOYERR_UNPLUGGED; }
MMRESULT WINAPI joyGetPosEx(UINT id, LPJOYINFOEX info) { (void)id; (void)info; return JOYERR_UNPLUGGED; }

DWORD WINAPI mciSendCommand(DWORD id, UINT msg, DWORD flags, DWORD parms)
{
    (void)id; (void)msg; (void)flags; (void)parms;
    return 1;                         /* nonzero is an MCI error: CDAudio reports no CD and stops */
}

/* ---------------------------------------------------------------- the entry point */

/*
 * main -> WinMain.
 *
 * A Windows program's entry point is WinMain, and PRISM runs main, so something has to bridge them.
 * The C runtime did it on Windows and it belongs here for the same reason: it is a property of the
 * platform, not of any one program.
 *
 * WinMain takes the command line as ONE STRING and parses it itself -- Quake's ParseCommandLine does
 * -- so the arguments are joined back up. argv[0] is dropped, which is what Windows passes.
 */
extern int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrev, LPSTR lpCmdLine, int nCmdShow);

/*
 * The command line, published for GetCommandLine as well as passed to WinMain.
 *
 * Both are needed and they are not the same thing: WinMain's lpCmdLine is the ARGUMENTS, while
 * GetCommandLine returns the program name FOLLOWED by them. PuTTY reads the second -- windows/
 * putty.c goes through cmdline_arg_list_from_GetCommandLineW -- so passing only the first left it
 * with no arguments at all and it fell through to its configuration box every time.
 */
char prism_win32_cmdline[1024];
char prism_win32_cmdline_full[1152];

int main(int argc, char **argv)
{
    int i;
    prism_win32_cmdline[0] = 0;
    for (i = 1; i < argc; i++) {
        if (i > 1) strcat(prism_win32_cmdline, " ");
        if (strlen(prism_win32_cmdline) + strlen(argv[i]) + 2 >= sizeof(prism_win32_cmdline)) break;
        strcat(prism_win32_cmdline, argv[i]);
    }
    strcpy(prism_win32_cmdline_full, argc > 0 && argv[0] ? argv[0] : "program");
    if (prism_win32_cmdline[0]) {
        strcat(prism_win32_cmdline_full, " ");
        strcat(prism_win32_cmdline_full, prism_win32_cmdline);
    }
    return WinMain(NULL, NULL, prism_win32_cmdline, SW_SHOWNORMAL);
}

/*
 * SEVEN FUNCTIONS THAT USED TO BE HERE -- GetLastError, SetLastError, LoadLibrary, FreeLibrary,
 * GetProcAddress, CloseHandle, GetCurrentProcess -- now live in win32-app.c.
 *
 * They are not about a window, and PuTTY needs them without one. The split is the point: this file
 * is the WINDOW (a class, a message queue, a rectangle), win32-app.c is what a Win32 program calls
 * when it is not drawing. Every target that includes this one must include that one too.
 */

