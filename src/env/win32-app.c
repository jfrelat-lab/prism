/*
 * win32-app.c -- the non-graphical half of Win32: code pages, time, memory, last-error.
 *
 * src/env/win32.c is the WINDOW: a class, a message queue, a rectangle. This is what an application
 * calls when it is not drawing -- and PuTTY's terminal core needs all of it before it opens anything.
 * Split because a console program should not have to carry a window, and a game should not have to
 * carry a code-page table.
 *
 * Written in C for the reason mgl.c and wide.c are: the contracts here are TYPES and STRING WIDTHS.
 * wchar_t is two bytes under _WIN32 and MultiByteToWideChar produces UTF-16 surrogate pairs; letting
 * the compiler settle that is the difference between correct and plausible.
 *
 * WHAT IS NOT HERE is as deliberate as what is: GetProcAddress returns NULL. PuTTY loads secur32,
 * winspool and half of kernel32 by name and CHECKS the result -- init_winfuncs, got_advapi,
 * tried_usernameex all branch on it -- so returning NULL exercises the program's own fallback path
 * rather than a fake of a function nobody here implements.
 */

#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

static DWORD prism_last_error = 0;

DWORD WINAPI GetLastError(void) { return prism_last_error; }
void WINAPI SetLastError(DWORD e) { prism_last_error = e; }

/*
 * The code pages. ANSI is 1252 and OEM is 437, which is what a Western Windows box reports, and the
 * choice is visible to the program: PuTTY names the ANSI code page in its font dialogue and uses the
 * OEM one for line-drawing characters.
 */
UINT WINAPI GetACP(void) { return 1252; }
UINT WINAPI GetOEMCP(void) { return 437; }

BOOL WINAPI IsDBCSLeadByteEx(UINT cp, BYTE b) { (void)cp; (void)b; return 0; }

BOOL WINAPI GetCPInfo(UINT cp, LPCPINFO info)
{
    int i;
    if (!info) return 0;
    /* Every code page implemented here is single byte, so there are no lead-byte ranges at all. */
    info->MaxCharSize = (cp == 65001) ? 4 : 1;
    info->DefaultChar[0] = '?';
    info->DefaultChar[1] = 0;
    for (i = 0; i < MAX_LEADBYTES; i++) info->LeadByte[i] = 0;
    return 1;
}

/*
 * UTF-8 <-> UTF-16, and single-byte for everything else.
 *
 * "Everything else" means Latin-1, not the real 1252: the two differ only in 0x80-0x9F, where 1252
 * has printable characters and Latin-1 has C1 controls. Said here rather than left implicit, because
 * a terminal is exactly the program that would notice.
 */
static int prism_utf8_decode(const unsigned char *s, int len, int *used)
{
    int c = s[0], n, i, v;
    if (c < 0x80) { *used = 1; return c; }
    if ((c & 0xE0) == 0xC0) { n = 2; v = c & 0x1F; }
    else if ((c & 0xF0) == 0xE0) { n = 3; v = c & 0x0F; }
    else if ((c & 0xF8) == 0xF0) { n = 4; v = c & 0x07; }
    else { *used = 1; return 0xFFFD; }
    if (n > len) { *used = len; return 0xFFFD; }
    for (i = 1; i < n; i++) {
        if ((s[i] & 0xC0) != 0x80) { *used = i; return 0xFFFD; }
        v = (v << 6) | (s[i] & 0x3F);
    }
    *used = n;
    return v;
}

int WINAPI MultiByteToWideChar(UINT cp, DWORD flags, const char *mb, int mblen,
                               wchar_t *wc, int wclen)
{
    const unsigned char *s = (const unsigned char *)mb;
    int in = 0, out = 0;
    (void)flags;
    if (mblen < 0) mblen = (int)strlen(mb) + 1;   /* -1 means "and the terminator too" */

    while (in < mblen) {
        int used = 1, c;
        if (cp == 65001) c = prism_utf8_decode(s + in, mblen - in, &used);
        else c = s[in];
        in += used;
        if (c >= 0x10000) {                       /* a surrogate PAIR, which is two wchar_t here */
            c -= 0x10000;
            if (wclen) {
                if (out + 2 > wclen) return 0;
                wc[out] = (wchar_t)(0xD800 + (c >> 10));
                wc[out + 1] = (wchar_t)(0xDC00 + (c & 0x3FF));
            }
            out += 2;
        } else {
            if (wclen) {
                if (out + 1 > wclen) return 0;
                wc[out] = (wchar_t)c;
            }
            out++;
        }
    }
    return out;                                   /* with wclen 0, the COUNT the caller must allocate */
}

int WINAPI WideCharToMultiByte(UINT cp, DWORD flags, const wchar_t *wc, int wclen,
                               char *mb, int mblen, const char *dflt, BOOL *useddflt)
{
    int in = 0, out = 0;
    (void)flags;
    if (wclen < 0) { wclen = 0; while (wc[wclen]) wclen++; wclen++; }
    if (useddflt) *useddflt = 0;

    while (in < wclen) {
        unsigned c = wc[in++];
        if (c >= 0xD800 && c < 0xDC00 && in < wclen && wc[in] >= 0xDC00 && wc[in] < 0xE000)
            c = 0x10000 + ((c - 0xD800) << 10) + (wc[in++] - 0xDC00);

        if (cp == 65001) {
            char buf[4];
            int n;
            if (c < 0x80) { buf[0] = (char)c; n = 1; }
            else if (c < 0x800) { buf[0] = (char)(0xC0 | (c >> 6)); buf[1] = (char)(0x80 | (c & 0x3F)); n = 2; }
            else if (c < 0x10000) {
                buf[0] = (char)(0xE0 | (c >> 12));
                buf[1] = (char)(0x80 | ((c >> 6) & 0x3F));
                buf[2] = (char)(0x80 | (c & 0x3F));
                n = 3;
            } else {
                buf[0] = (char)(0xF0 | (c >> 18));
                buf[1] = (char)(0x80 | ((c >> 12) & 0x3F));
                buf[2] = (char)(0x80 | ((c >> 6) & 0x3F));
                buf[3] = (char)(0x80 | (c & 0x3F));
                n = 4;
            }
            if (mblen) { int i; if (out + n > mblen) return 0; for (i = 0; i < n; i++) mb[out + i] = buf[i]; }
            out += n;
        } else {
            char b;
            if (c < 0x100) b = (char)c;
            else { b = dflt ? dflt[0] : '?'; if (useddflt) *useddflt = 1; }
            if (mblen) { if (out + 1 > mblen) return 0; mb[out] = b; }
            out++;
        }
    }
    return out;
}

/* ---- memory. LocalAlloc's LPTR means "zeroed", which is the only flag PuTTY passes. */
HANDLE WINAPI LocalAlloc(UINT flags, SIZE_T bytes)
{
    void *p = malloc(bytes ? bytes : 1);
    if (p && (flags & 0x0040)) memset(p, 0, bytes);
    return (HANDLE)p;
}
HANDLE WINAPI LocalFree(HANDLE h) { free((void *)h); return (HANDLE)0; }

LPVOID WINAPI VirtualAlloc(LPVOID addr, SIZE_T size, DWORD type, DWORD protect)
{
    (void)addr; (void)type; (void)protect;
    return calloc(1, size ? size : 1);
}
BOOL WINAPI VirtualFree(LPVOID addr, SIZE_T size, DWORD type)
{
    (void)size; (void)type;
    free(addr);
    return 1;
}
BOOL WINAPI VirtualLock(LPVOID a, SIZE_T n) { (void)a; (void)n; return 1; }
BOOL WINAPI VirtualUnlock(LPVOID a, SIZE_T n) { (void)a; (void)n; return 1; }

/* ---- handles and processes, at the depth a program that opens nothing needs. */
BOOL WINAPI CloseHandle(HANDLE h) { (void)h; return 1; }
HANDLE WINAPI GetCurrentProcess(void) { return (HANDLE)-1; }
DWORD WINAPI GetCurrentProcessId(void) { return 1; }
DWORD WINAPI GetCurrentThreadId(void) { return 1; }

/*
 * Dynamic loading, answered from what PRISM ACTUALLY HAS.
 *
 * A shim file that implements part of the platform publishes a name table, and this finds it through
 * an `extern` that a target without that file never defines -- which PRISM reads as a null pointer,
 * exactly as a linker would leave it. So a console target resolves nothing and a target that links
 * win32-net.c resolves winsock, with no #ifdef anywhere.
 *
 * Everything not in a table still returns NULL, and that remains deliberate: PuTTY checks every one
 * of these and has a path for absent. What it does NOT have a path for is a library that loads and
 * then hands back a null WSAStartup, so "found nothing" and "no such library" have to stay
 * different answers -- which is why LoadLibrary only admits to the modules a table covers.
 */
struct prism_export { const char *module; const char *name; void *fn; };
extern const struct prism_export *prism_extra_exports;
extern const int prism_extra_export_count;

/*
 * The BASENAME of a DLL path. PuTTY's load_system32_dll loads by full path on purpose -- "no attack
 * is possible by placing a substitute DLL earlier on that path", says its own comment -- so what
 * arrives here is C:\WINDOWS\SYSTEM32\ws2_32.dll and never the bare name.
 */
static const char *prism_basename(const char *p)
{
    const char *base = p;
    if (!p) return "";
    for (; *p; p++)
        if (*p == '\\' || *p == '/') base = p + 1;
    return base;
}

/*
 * A module handle IS the module name in the table. That makes it non-null, stable, unique per
 * module and directly comparable, without a registry of handles to keep in step.
 */
HMODULE WINAPI LoadLibraryA(const char *name)
{
    const char *base = prism_basename(name);
    int i;
    for (i = 0; i < prism_extra_export_count; i++)
        if (!strcasecmp(prism_extra_exports[i].module, base))
            return (HMODULE)prism_extra_exports[i].module;
    return (HMODULE)0;
}

void *WINAPI GetProcAddress(HMODULE mod, const char *name)
{
    int i;
    if (!mod || !name || !prism_extra_exports) return NULL;
    for (i = 0; i < prism_extra_export_count; i++)
        if ((const char *)mod == prism_extra_exports[i].module
            && !strcmp(prism_extra_exports[i].name, name))
            return prism_extra_exports[i].fn;
    return NULL;
}

HMODULE WINAPI LoadLibrary(const char *name) { return LoadLibraryA(name); }
HMODULE WINAPI LoadLibraryW(const wchar_t *name) { (void)name; return (HMODULE)0; }
HMODULE WINAPI GetModuleHandleA(const char *name) { (void)name; return (HMODULE)0; }
BOOL WINAPI FreeLibrary(HMODULE mod) { (void)mod; return 1; }
UINT WINAPI GetSystemDirectoryA(char *buf, UINT n)
{
    const char *d = "C:\\WINDOWS\\SYSTEM32";
    UINT len = (UINT)strlen(d);
    if (n > len) { strcpy(buf, d); return len; }
    return len + 1;
}

UINT WINAPI GetSystemDirectory(LPSTR buf, UINT n) { return GetSystemDirectoryA(buf, n); }

/*
 * The command line, as one string: the program name followed by its arguments, which is what
 * GetCommandLine returns and NOT what WinMain is handed. The narrow form is whatever win32.c built
 * from argv; the wide one is that, widened here, because a program is free to ask for either and
 * PuTTY asks for the wide one.
 *
 * `prism_win32_cmdline_full` is an extern that win32.c defines. A target without win32.c never
 * defines it, PRISM reads that as a null pointer, and this reports an empty command line -- which is
 * the linker's own behaviour and needs no conditional here.
 */
extern char prism_win32_cmdline_full[];
static wchar_t prism_cmdline_w[1152];

LPSTR WINAPI GetCommandLineA(void)
{
    return prism_win32_cmdline_full ? (LPSTR)prism_win32_cmdline_full : (LPSTR)"";
}
LPWSTR WINAPI GetCommandLineW(void)
{
    const char *s = prism_win32_cmdline_full ? prism_win32_cmdline_full : "";
    size_t i;
    for (i = 0; i + 1 < sizeof(prism_cmdline_w) / sizeof(prism_cmdline_w[0]) && s[i]; i++)
        prism_cmdline_w[i] = (unsigned char)s[i];
    prism_cmdline_w[i] = 0;
    return prism_cmdline_w;
}

DWORD WINAPI GetEnvironmentVariable(LPCSTR name, LPSTR buf, DWORD n)
{
    const char *v = getenv(name);
    DWORD len;
    if (!v) { SetLastError(203 /* ERROR_ENVVAR_NOT_FOUND */); return 0; }
    len = (DWORD)strlen(v);
    if (n > len) { strcpy(buf, v); return len; }
    return len + 1;
}

/*
 * COM and the shell, answering "not available" the way a machine without them does.
 *
 * CoCreateInstance failing is the interesting one: PuTTY's jump-list code checks the HRESULT at
 * every step and gives up quietly, so E_NOINTERFACE takes the program down a path it really has
 * rather than a path invented for it here.
 */
#define PRISM_E_FAIL 0x80004005L

HRESULT WINAPI CoInitialize(LPVOID reserved) { (void)reserved; return 0; }
void WINAPI CoUninitialize(void) { }
HRESULT WINAPI CoCreateInstance(REFCLSID cls, void *outer, DWORD ctx, REFIID iid, void **out)
{
    (void)cls; (void)outer; (void)ctx; (void)iid;
    if (out) *out = NULL;
    return PRISM_E_FAIL;
}
HRESULT WINAPI SHGetFolderPathA(HWND hwnd, int folder, HANDLE token, DWORD flags, LPSTR path)
{
    (void)hwnd; (void)folder; (void)token; (void)flags;
    if (path) strcpy(path, "C:\\PUTTY");
    return 0;
}

BOOL WINAPI IsProcessorFeaturePresent(DWORD feature) { (void)feature; return 0; }
BOOL WINAPI SetHandleInformation(HANDLE h, DWORD mask, DWORD flags)
{ (void)h; (void)mask; (void)flags; return 1; }

/* No real files behind these: PuTTY checks and carries on without its random seed or its help file. */
HANDLE WINAPI CreateFile(LPCSTR name, DWORD access, DWORD share, void *sa,
                         DWORD disp, DWORD flags, HANDLE tmpl)
{
    (void)name; (void)access; (void)share; (void)sa; (void)disp; (void)flags; (void)tmpl;
    SetLastError(2 /* ERROR_FILE_NOT_FOUND */);
    return INVALID_HANDLE_VALUE;
}
BOOL WINAPI DeleteFile(LPCSTR name) { (void)name; return 0; }
DWORD WINAPI GetTempPath(DWORD n, LPSTR buf)
{
    const char *d = "C:\\TEMP\\";
    DWORD len = (DWORD)strlen(d);
    if (n > len) { strcpy(buf, d); return len; }
    return len + 1;
}
HANDLE WINAPI FindResource(HMODULE mod, LPCSTR name, LPCSTR type)
{ (void)mod; (void)name; (void)type; return (HANDLE)0; }

/*
 * The registry: there isn't one.
 *
 * Every open and create reports ERROR_FILE_NOT_FOUND, which is what a program sees on a machine
 * where nobody has ever saved anything -- so PuTTY finds no stored sessions and falls back to the
 * defaults compiled into it. That is a path the program has and tests; an in-memory registry that
 * forgot everything between runs would be the same outcome dressed as a feature.
 */
LONG WINAPI RegOpenKeyEx(HKEY key, LPCSTR sub, DWORD opt, DWORD sam, PHKEY out)
{
    (void)key; (void)sub; (void)opt; (void)sam;
    if (out) *out = (HKEY)0;
    return 2;                                   /* ERROR_FILE_NOT_FOUND */
}
LONG WINAPI RegCreateKeyEx(HKEY key, LPCSTR sub, DWORD res, LPSTR cls, DWORD opt,
                           DWORD sam, void *sa, PHKEY out, DWORD *disp)
{
    (void)key; (void)sub; (void)res; (void)cls; (void)opt; (void)sam; (void)sa;
    if (out) *out = (HKEY)0;
    if (disp) *disp = 0;
    return 5;                                   /* ERROR_ACCESS_DENIED: read-only, and honest */
}
LONG WINAPI RegQueryValueEx(HKEY key, LPCSTR name, DWORD *res, DWORD *type, BYTE *data, DWORD *len)
{ (void)key; (void)name; (void)res; (void)type; (void)data; (void)len; return 2; }
LONG WINAPI RegSetValueEx(HKEY key, LPCSTR name, DWORD res, DWORD type, const BYTE *data, DWORD len)
{ (void)key; (void)name; (void)res; (void)type; (void)data; (void)len; return 5; }
LONG WINAPI RegDeleteValue(HKEY key, LPCSTR name) { (void)key; (void)name; return 2; }
LONG WINAPI RegDeleteKey(HKEY key, LPCSTR sub) { (void)key; (void)sub; return 2; }
LONG WINAPI RegEnumKey(HKEY key, DWORD i, LPSTR name, DWORD len)
{ (void)key; (void)i; (void)name; (void)len; return 259; }   /* ERROR_NO_MORE_ITEMS */
LONG WINAPI RegEnumValue(HKEY key, DWORD i, LPSTR name, DWORD *namelen, DWORD *res,
                         DWORD *type, BYTE *data, DWORD *datalen)
{ (void)key; (void)i; (void)name; (void)namelen; (void)res; (void)type; (void)data; (void)datalen; return 259; }
LONG WINAPI RegCloseKey(HKEY key) { (void)key; return 0; }

/*
 * Time. PuTTY stamps its log and its scrollback with the local clock and schedules its timers off
 * the tick count, so both have to move -- a frozen clock would make every timer fire at once or
 * never. These read the host's, which is what a program on a machine with a clock gets.
 */
#include <time.h>

void WINAPI GetLocalTime(LPSYSTEMTIME t)
{
    time_t now = time(NULL);
    struct tm *tm = localtime(&now);
    if (!t) return;
    t->wYear = (WORD)(tm->tm_year + 1900);
    t->wMonth = (WORD)(tm->tm_mon + 1);
    t->wDayOfWeek = (WORD)tm->tm_wday;
    t->wDay = (WORD)tm->tm_mday;
    t->wHour = (WORD)tm->tm_hour;
    t->wMinute = (WORD)tm->tm_min;
    t->wSecond = (WORD)tm->tm_sec;
    t->wMilliseconds = 0;
}
void WINAPI GetSystemTime(LPSYSTEMTIME t)
{
    time_t now = time(NULL);
    struct tm *tm = gmtime(&now);
    if (!t) return;
    t->wYear = (WORD)(tm->tm_year + 1900);
    t->wMonth = (WORD)(tm->tm_mon + 1);
    t->wDayOfWeek = (WORD)tm->tm_wday;
    t->wDay = (WORD)tm->tm_mday;
    t->wHour = (WORD)tm->tm_hour;
    t->wMinute = (WORD)tm->tm_min;
    t->wSecond = (WORD)tm->tm_sec;
    t->wMilliseconds = 0;
}
BOOL WINAPI SystemTimeToFileTime(const SYSTEMTIME *st, LPFILETIME ft)
{ (void)st; if (ft) { ft->dwLowDateTime = 0; ft->dwHighDateTime = 0; } return 1; }
