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
 * NULL, on purpose -- see the note at the top. Every caller here checks.
 */
void *WINAPI GetProcAddress(HMODULE mod, const char *name) { (void)mod; (void)name; return NULL; }
HMODULE WINAPI LoadLibraryA(const char *name) { (void)name; return (HMODULE)0; }
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

/* The caret blink, in milliseconds. Windows' own default, which is what PuTTY's cursor uses. */
UINT WINAPI GetCaretBlinkTime(void) { return 530; }
BOOL WINAPI MessageBeep(UINT type) { (void)type; return 1; }
HWND WINAPI GetCapture(void) { return (HWND)0; }
