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

DWORD WINAPI GetLastError(void) { return 0; }
void WINAPI SetLastError(DWORD e) { (void)e; }

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
HMODULE WINAPI LoadLibrary(LPCSTR name) { (void)name; return NULL; }
BOOL WINAPI FreeLibrary(HMODULE m) { (void)m; return TRUE; }
FARPROC WINAPI GetProcAddress(HMODULE m, LPCSTR name) { (void)m; (void)name; return NULL; }
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
DWORD WINAPI MsgWaitForMultipleObjects(DWORD n, HANDLE *h, BOOL all, DWORD ms, DWORD mask)
{
    (void)n; (void)h; (void)all; (void)ms; (void)mask;
    return WAIT_OBJECT_0;
}
BOOL WINAPI CloseHandle(HANDLE h) { (void)h; return TRUE; }
HANDLE WINAPI GetCurrentProcess(void) { return HANDLE_OF(HANDLE); }
HANDLE WINAPI GetCurrentThread(void) { return HANDLE_OF(HANDLE); }
BOOL WINAPI SetPriorityClass(HANDLE h, DWORD c) { (void)h; (void)c; return TRUE; }
BOOL WINAPI SetThreadPriority(HANDLE h, int p) { (void)h; (void)p; return TRUE; }

/* ---------------------------------------------------------------- windows */

ATOM WINAPI RegisterClass(const WNDCLASS *wc) { (void)wc; return (ATOM)next_handle++; }

HWND WINAPI CreateWindowEx(DWORD exStyle, LPCSTR cls, LPCSTR name, DWORD style,
                           int x, int y, int w, int h, HWND parent, HMENU menu,
                           HINSTANCE inst, LPVOID param)
{
    (void)exStyle; (void)cls; (void)name; (void)style; (void)x; (void)y;
    (void)parent; (void)menu; (void)inst; (void)param;
    if (w > 0) screen_w = w;
    if (h > 0) screen_h = h;
    return HANDLE_OF(HWND);
}

BOOL WINAPI DestroyWindow(HWND w) { (void)w; return TRUE; }
LRESULT WINAPI DefWindowProc(HWND w, UINT m, WPARAM wp, LPARAM lp)
{
    (void)w; (void)m; (void)wp; (void)lp;
    return 0;
}
BOOL WINAPI ShowWindow(HWND w, int cmd) { (void)w; (void)cmd; return TRUE; }
BOOL WINAPI UpdateWindow(HWND w) { (void)w; return TRUE; }
BOOL WINAPI SetForegroundWindow(HWND w) { (void)w; return TRUE; }
BOOL WINAPI SetWindowPos(HWND w, HWND after, int x, int y, int cx, int cy, UINT flags)
{
    (void)w; (void)after; (void)x; (void)y; (void)cx; (void)cy; (void)flags;
    return TRUE;
}
LONG WINAPI SetWindowLong(HWND w, int index, LONG value) { (void)w; (void)index; (void)value; return 0; }
BOOL WINAPI InvalidateRect(HWND w, const RECT *r, BOOL erase) { (void)w; (void)r; (void)erase; return TRUE; }
HWND WINAPI CreateDialog(HINSTANCE i, LPCSTR t, HWND p, LPVOID proc)
{
    (void)i; (void)t; (void)p; (void)proc;
    return NULL;
}
int WINAPI MessageBox(HWND w, LPCSTR text, LPCSTR caption, UINT type)
{
    (void)w; (void)text; (void)caption; (void)type;
    return IDOK;
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
 * The message queue: empty.
 *
 * PeekMessage returning FALSE is what an application with nothing waiting sees, and Sys_SendKeyEvents
 * loops on exactly that and returns. It is also where keyboard input WOULD arrive, so this is the one
 * function to change when the page starts feeding events -- everything else here is bookkeeping.
 */
BOOL WINAPI PeekMessage(LPMSG msg, HWND w, UINT min, UINT max, UINT flags)
{
    (void)w; (void)min; (void)max; (void)flags;
    if (msg) memset(msg, 0, sizeof(*msg));
    return FALSE;
}
BOOL WINAPI GetMessage(LPMSG msg, HWND w, UINT min, UINT max)
{
    (void)w; (void)min; (void)max;
    if (msg) memset(msg, 0, sizeof(*msg));
    return FALSE;                     /* FALSE means WM_QUIT: a message loop on this exits at once */
}
BOOL WINAPI TranslateMessage(const MSG *m) { (void)m; return FALSE; }
LRESULT WINAPI DispatchMessage(const MSG *m) { (void)m; return 0; }

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
BOOL WINAPI GetClientRect(HWND w, LPRECT r)
{
    (void)w;
    if (!r) return FALSE;
    r->left = r->top = 0; r->right = screen_w; r->bottom = screen_h;
    return TRUE;
}
BOOL WINAPI GetWindowRect(HWND w, LPRECT r) { return GetClientRect(w, r); }

/* ---------------------------------------------------------------- mouse and cursor */

BOOL WINAPI ShowCursor(BOOL show) { (void)show; return TRUE; }
BOOL WINAPI SetCursorPos(int x, int y) { (void)x; (void)y; return TRUE; }
BOOL WINAPI GetCursorPos(LPPOINT p) { if (p) { p->x = screen_w / 2; p->y = screen_h / 2; } return TRUE; }
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
HDC WINAPI BeginPaint(HWND w, LPPAINTSTRUCT ps)
{
    (void)w;
    if (ps) memset(ps, 0, sizeof(*ps));
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

int main(int argc, char **argv)
{
    static char cmdline[1024];
    int i;
    cmdline[0] = 0;
    for (i = 1; i < argc; i++) {
        if (i > 1) strcat(cmdline, " ");
        if (strlen(cmdline) + strlen(argv[i]) + 2 >= sizeof(cmdline)) break;
        strcat(cmdline, argv[i]);
    }
    return WinMain(NULL, NULL, cmdline, SW_SHOWNORMAL);
}
