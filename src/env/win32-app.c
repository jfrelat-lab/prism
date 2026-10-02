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
#include <ctype.h>
#include <dirent.h>
#include <stdio.h>
#include <stdarg.h>

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

/*
 * Reserve, then commit INSIDE the reservation. Quake II's Hunk_Begin reserves the most a model may
 * need and Hunk_Alloc commits from its base again with every allocation, growing; each of those
 * calls must answer the address it was given, not new memory, or the hunk is somewhere else after
 * each one and the reservations leak until malloc runs dry. A region is allocated, zeroed, when it
 * is reserved (or committed with no address); committing inside one is a no-op that names it.
 * Decommitting keeps the memory: nothing here can tell a program that the pages went away.
 */
#define PRISM_MAX_REGIONS 512
static struct { char *base; SIZE_T size; } prism_regions[PRISM_MAX_REGIONS];

LPVOID WINAPI VirtualAlloc(LPVOID addr, SIZE_T size, DWORD type, DWORD protect)
{
    int i, free_slot = -1;
    (void)protect;
    if (addr) {
        char *a = (char *)addr;
        for (i = 0; i < PRISM_MAX_REGIONS; i++)
            if (prism_regions[i].base && a >= prism_regions[i].base
                && a + size <= prism_regions[i].base + prism_regions[i].size)
                return (type & MEM_COMMIT) ? addr : NULL;   /* reserving twice is an error */
        return NULL;                                        /* no address PRISM can place on request */
    }
    for (i = 0; i < PRISM_MAX_REGIONS; i++) if (!prism_regions[i].base) { free_slot = i; break; }
    if (free_slot < 0) return NULL;
    prism_regions[free_slot].base = calloc(1, size ? size : 1);
    prism_regions[free_slot].size = size;
    return prism_regions[free_slot].base;
}
BOOL WINAPI VirtualFree(LPVOID addr, SIZE_T size, DWORD type)
{
    int i;
    (void)size;
    if (!(type & MEM_RELEASE)) return 1;                   /* MEM_DECOMMIT */
    for (i = 0; i < PRISM_MAX_REGIONS; i++)
        if (prism_regions[i].base == (char *)addr) {
            free(addr);
            prism_regions[i].base = NULL;
            return 1;
        }
    return 0;
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
/*
 * SYSTEM DLLs a shim file implements -- opengl32.dll is src/env/opengl32.c -- answer through one
 * function rather than rows in the table: (module, NULL) is the module's handle or NULL, (handle,
 * name) an export. Null when no such file is linked, like the table.
 */
extern void *(*prism_system_lookup)(const char *module, const char *name);

HMODULE WINAPI LoadLibraryA(const char *name)
{
    const char *base = prism_basename(name);
    char withext[260];
    int i;
    /* A name without an extension means NAME.dll -- Quake II asks for "opengl32". */
    if (!strchr(base, '.') && strlen(base) + 5 <= sizeof withext) {
        strcpy(withext, base); strcat(withext, ".dll"); base = withext;
    }
    for (i = 0; i < prism_extra_export_count; i++)
        if (!strcasecmp(prism_extra_exports[i].module, base))
            return (HMODULE)prism_extra_exports[i].module;
    if (prism_system_lookup) return (HMODULE)prism_system_lookup(base, NULL);
    return (HMODULE)0;
}

void *WINAPI GetProcAddress(HMODULE mod, const char *name)
{
    int i;
    if (!mod || !name) return NULL;
    for (i = 0; prism_extra_exports && i < prism_extra_export_count; i++)
        if ((const char *)mod == prism_extra_exports[i].module
            && !strcmp(prism_extra_exports[i].name, name))
            return prism_extra_exports[i].fn;
    if (prism_system_lookup) return prism_system_lookup((const char *)mod, name);
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
/* Files through the stdio layer, which owns PRISM's file table: a Windows path is a stdio path with
   its separators turned. */
static void prism_posix_path(char *out, const char *in, int n)
{
    int i;
    for (i = 0; in && in[i] && i < n - 1; i++) out[i] = in[i] == '\\' ? '/' : in[i];
    out[i] = 0;
}
BOOL WINAPI DeleteFile(LPCSTR name)
{
    char p[MAX_PATH];
    prism_posix_path(p, name, sizeof p);
    if (remove(p) != 0) { SetLastError(2 /* ERROR_FILE_NOT_FOUND */); return 0; }
    return 1;
}
BOOL WINAPI CopyFile(LPCSTR from, LPCSTR to, BOOL failIfExists)
{
    char a[MAX_PATH], b[MAX_PATH], buf[4096];
    FILE *in, *out;
    size_t n;
    prism_posix_path(a, from, sizeof a); prism_posix_path(b, to, sizeof b);
    if (failIfExists && (out = fopen(b, "rb")) != NULL) { fclose(out); SetLastError(80 /* ERROR_FILE_EXISTS */); return 0; }
    if ((in = fopen(a, "rb")) == NULL) { SetLastError(2 /* ERROR_FILE_NOT_FOUND */); return 0; }
    if ((out = fopen(b, "wb")) == NULL) { fclose(in); SetLastError(5 /* ERROR_ACCESS_DENIED */); return 0; }
    while ((n = fread(buf, 1, sizeof buf, in)) > 0) fwrite(buf, 1, n, out);
    fclose(in); fclose(out);
    return 1;
}

/*
 * ---- THE DIRECTORY WALK, over the stdio layer's opendir (src/env/stdio.js), which derives a
 * directory's entries from PRISM's file table. Shared by FindFirstFile and MSVC's _findfirst
 * (src/env/win32.c). The pattern is the last path component, matched the DOS way: case does not
 * matter, '?' is one character, '*' any run, and "*.*" means every name, dotted or not.
 */
struct prism_find { DIR *d; char dir[MAX_PATH]; char pat[MAX_PATH]; };

static int prism_wild(const char *p, const char *s)
{
    for (; *p; p++, s++) {
        if (*p == '*') {
            for (p++; ; s++) { if (prism_wild(p, s)) return 1; if (!*s) return 0; }
        }
        if (!*s) return 0;
        if (*p != '?' && tolower((unsigned char)*p) != tolower((unsigned char)*s)) return 0;
    }
    return !*s;
}

/* Opens a walk for a Windows path spec; NULL if its directory does not exist. */
void *prism_find_open(const char *spec)
{
    struct prism_find *f;
    char path[MAX_PATH], *slash = NULL, *q;
    strncpy(path, spec ? spec : "", sizeof path - 1); path[sizeof path - 1] = 0;
    for (q = path; *q; q++) { if (*q == '\\') *q = '/'; if (*q == '/') slash = q; }
    f = (struct prism_find *)calloc(1, sizeof *f);
    if (!f) return NULL;
    if (slash) { *slash = 0; strcpy(f->dir, path[0] ? path : "/"); strcpy(f->pat, slash + 1); }
    else { strcpy(f->dir, "."); strcpy(f->pat, path); }
    if (!strcmp(f->pat, "*.*")) strcpy(f->pat, "*");
    f->d = opendir(f->dir);
    if (!f->d) { free(f); return NULL; }
    return f;
}
/* The next matching name: 1 and fills name/isdir/size, or 0 at the end. */
int prism_find_next(void *h, char *name, int n, int *isdir, unsigned long *size)
{
    struct prism_find *f = (struct prism_find *)h;
    struct dirent *e;
    while ((e = readdir(f->d)) != NULL) {
        char full[MAX_PATH * 2];
        DIR *sub;
        FILE *fp;
        if (!prism_wild(f->pat, e->d_name)) continue;
        strncpy(name, e->d_name, n - 1); name[n - 1] = 0;
        sprintf(full, "%s/%s", f->dir, e->d_name);
        sub = opendir(full);
        *isdir = sub != NULL;
        if (sub) closedir(sub);
        *size = 0;
        if (!*isdir && (fp = fopen(full, "rb")) != NULL) {
            fseek(fp, 0, SEEK_END); *size = (unsigned long)ftell(fp); fclose(fp);
        }
        return 1;
    }
    return 0;
}
void prism_find_close(void *h)
{
    struct prism_find *f = (struct prism_find *)h;
    if (!f) return;
    closedir(f->d);
    free(f);
}

static BOOL prism_find_fill(void *h, WIN32_FIND_DATAA *out)
{
    int isdir; unsigned long size;
    char name[MAX_PATH];
    if (!prism_find_next(h, name, sizeof name, &isdir, &size)) return FALSE;
    memset(out, 0, sizeof *out);
    out->dwFileAttributes = isdir ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
    out->nFileSizeLow = (DWORD)size;
    strcpy(out->cFileName, name);
    return TRUE;
}
HANDLE WINAPI FindFirstFileA(LPCSTR name, WIN32_FIND_DATAA *out)
{
    void *h = prism_find_open(name);
    if (!h) { SetLastError(3 /* ERROR_PATH_NOT_FOUND */); return INVALID_HANDLE_VALUE; }
    if (!prism_find_fill(h, out)) { prism_find_close(h); SetLastError(2 /* ERROR_FILE_NOT_FOUND */); return INVALID_HANDLE_VALUE; }
    return (HANDLE)h;
}
BOOL WINAPI FindNextFileA(HANDLE h, WIN32_FIND_DATAA *out)
{
    if (!h || h == INVALID_HANDLE_VALUE) return FALSE;
    if (!prism_find_fill((void *)h, out)) { SetLastError(18 /* ERROR_NO_MORE_FILES */); return FALSE; }
    return TRUE;
}
BOOL WINAPI FindClose(HANDLE h)
{
    if (!h || h == INVALID_HANDLE_VALUE) return FALSE;
    prism_find_close((void *)h);
    return TRUE;
}

/* user32's sprintf: its format language is a subset of C's, so C's formats it. */
int WINAPIV wsprintfA(LPSTR buf, LPCSTR fmt, ...)
{
    va_list ap;
    int n;
    va_start(ap, fmt);
    n = vsprintf(buf, fmt, ap);
    va_end(ap);
    return n;
}
/* A breakpoint with no debugger attached: Windows ends the process, and so does this. */
void WINAPI DebugBreak(void) { fprintf(stderr, "DebugBreak: breakpoint with no debugger\n"); abort(); }
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

/* Milliseconds since some fixed point; the runtime's clock, not a C library one. */
extern double prism_now_ms(void);

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

/*
 * The millisecond clock, from the host's. PuTTY schedules everything off it -- the cursor blink, the
 * bell, its timers -- so a frozen one makes every timer fire at once or never.
 */
DWORD WINAPI GetTickCount(void) { return (DWORD)(prism_now_ms() & 0xFFFFFFFFu); }
