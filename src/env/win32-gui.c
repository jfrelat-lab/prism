/*
 * win32-gui.c -- user32 and GDI for a program that has a window but no screen.
 *
 * src/env/win32.c owns the WINDOW: the class, the message queue, the rectangle the page draws a
 * frame around. This is the surface a real GUI program touches on the way to its message loop and
 * inside it -- device contexts, fonts, menus, the caret, the clipboard -- answered honestly rather
 * than faked. Where a value has a right answer it is given; where the answer is "this machine has
 * no such thing", that is what comes back, and the program takes the path it already has for it.
 *
 * THE FONT is the one number here that has to be a real decision. A terminal sizes itself from
 * GetTextMetrics: rows and columns come out of tmHeight and tmAveCharWidth, and a zero would make
 * PuTTY divide by it. 8x16 is the VGA text cell, which is the font a DOS-era terminal was drawn in
 * and a size every caller can work with.
 */

#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

extern int prism_win32_w, prism_win32_h;   /* the window win32.c is keeping */

/*
 * A brush IS its colour: CreateSolidBrush hands back the COLORREF with a tag bit, so FillRect needs
 * no table. PuTTY only ever fills with brushes it made itself or with a system colour.
 *
 * Defined HERE, at the top, because a macro must exist before its first use and this one sat below
 * CreateSolidBrush -- which therefore failed to emit, silently, below the twelfth-most-common cause
 * in the build report.
 */
#define PRISM_BRUSH_TAG 0x40000000

#define PRISM_FONT_W 8
#define PRISM_FONT_H 16

/* A handle that is merely distinct: nothing dereferences these, they are only compared. */
static int prism_handle_seq;
#define NEW_HANDLE(t) ((t)(ULONG_PTR)(0x1000 + (++prism_handle_seq)))

/* ---- device contexts */
HDC WINAPI CreateCompatibleDC(HDC dc) { (void)dc; return NEW_HANDLE(HDC); }
BOOL WINAPI DeleteDC(HDC dc) { (void)dc; return 1; }
HGDIOBJ WINAPI SelectObject(HDC dc, HGDIOBJ obj) { (void)dc; return obj; }
/* GetDeviceCaps lives in win32.c, which already answers for the screen. */
int WINAPI SetMapMode(HDC dc, int mode) { (void)dc; (void)mode; return 1; }
int WINAPI SetBkMode(HDC dc, int mode) { (void)dc; (void)mode; return 1; }
int WINAPI GetBkMode(HDC dc) { (void)dc; return 2; }
UINT WINAPI SetTextAlign(HDC dc, UINT a) { (void)dc; return a; }
int WINAPI ExcludeClipRect(HDC dc, int l, int t, int r, int b)
{ (void)dc; (void)l; (void)t; (void)r; (void)b; return 1; }
int WINAPI IntersectClipRect(HDC dc, int l, int t, int r, int b)
{ (void)dc; (void)l; (void)t; (void)r; (void)b; return 1; }
int WINAPI SelectClipRgn(HDC dc, HRGN rgn) { (void)dc; (void)rgn; return 1; }
BOOL WINAPI UnrealizeObject(HGDIOBJ o) { (void)o; return 1; }
BOOL WINAPI UpdateColors(HDC dc) { (void)dc; return 1; }
UINT WINAPI SetPaletteEntries(HPALETTE p, UINT s, UINT n, const PALETTEENTRY *e)
{ (void)p; (void)s; (void)e; return n; }

/* ---- objects */
HFONT WINAPI CreateFontIndirect(const LOGFONT *lf) { (void)lf; return NEW_HANDLE(HFONT); }
HFONT WINAPI CreateFontIndirectW(const LOGFONTW *lf) { (void)lf; return NEW_HANDLE(HFONT); }
HFONT WINAPI CreateFont(int h, int w, int e, int o, int wt, DWORD it, DWORD un, DWORD st,
                        DWORD cs, DWORD op, DWORD cp, DWORD q, DWORD pf, LPCSTR face)
{
    (void)h; (void)w; (void)e; (void)o; (void)wt; (void)it; (void)un; (void)st;
    (void)cs; (void)op; (void)cp; (void)q; (void)pf; (void)face;
    return NEW_HANDLE(HFONT);
}
HPEN WINAPI CreatePen(int style, int w, COLORREF c) { (void)style; (void)w; (void)c; return NEW_HANDLE(HPEN); }
HBRUSH WINAPI CreateSolidBrush(COLORREF c) { return (HBRUSH)(ULONG_PTR)(PRISM_BRUSH_TAG | (c & 0x00FFFFFF)); }
HBITMAP WINAPI CreateBitmap(int w, int h, UINT pl, UINT bits, const void *d)
{ (void)w; (void)h; (void)pl; (void)bits; (void)d; return NEW_HANDLE(HBITMAP); }
HBITMAP WINAPI CreateCompatibleBitmap(HDC dc, int w, int h)
{ (void)dc; (void)w; (void)h; return NEW_HANDLE(HBITMAP); }
int WINAPI GetObject(HGDIOBJ o, int n, void *out) { (void)o; if (out) memset(out, 0, n); return n; }

/* ---- text metrics: the decision documented at the top */
BOOL WINAPI GetTextMetrics(HDC dc, LPTEXTMETRIC tm)
{
    (void)dc;
    if (!tm) return 0;
    memset(tm, 0, sizeof(*tm));
    tm->tmHeight = PRISM_FONT_H;
    tm->tmAscent = PRISM_FONT_H - 4;
    tm->tmDescent = 4;
    tm->tmAveCharWidth = PRISM_FONT_W;
    tm->tmMaxCharWidth = PRISM_FONT_W;
    tm->tmWeight = 400;
    tm->tmFirstChar = 32;
    tm->tmLastChar = 255;
    tm->tmDefaultChar = '?';
    tm->tmBreakChar = ' ';
    tm->tmPitchAndFamily = 0;          /* bit 0 clear means FIXED pitch, which this is */
    tm->tmCharSet = 0;
    return 1;
}
UINT WINAPI GetOutlineTextMetrics(HDC dc, UINT n, LPOUTLINETEXTMETRIC otm)
{ (void)dc; (void)n; (void)otm; return 0; }   /* not a TrueType font, which is a real answer */
BOOL WINAPI GetTextExtentPoint32(HDC dc, LPCSTR s, int n, SIZE *sz)
{ (void)dc; (void)s; if (sz) { sz->cx = n * PRISM_FONT_W; sz->cy = PRISM_FONT_H; } return 1; }
BOOL WINAPI GetTextExtentExPoint(HDC dc, LPCSTR s, int n, int maxext, INT *fit, INT *dx, SIZE *sz)
{
    int i;
    (void)dc; (void)s;
    if (dx) for (i = 0; i < n; i++) dx[i] = (i + 1) * PRISM_FONT_W;
    if (fit) *fit = maxext / PRISM_FONT_W < n ? maxext / PRISM_FONT_W : n;
    if (sz) { sz->cx = n * PRISM_FONT_W; sz->cy = PRISM_FONT_H; }
    return 1;
}
static BOOL widths(UINT first, UINT last, INT *out)
{
    UINT c;
    if (!out) return 0;
    for (c = first; c <= last; c++) out[c - first] = PRISM_FONT_W;
    return 1;
}
BOOL WINAPI GetCharWidth(HDC dc, UINT f, UINT l, INT *o) { (void)dc; return widths(f, l, o); }
BOOL WINAPI GetCharWidthW(HDC dc, UINT f, UINT l, INT *o) { (void)dc; return widths(f, l, o); }
BOOL WINAPI GetCharWidth32(HDC dc, UINT f, UINT l, INT *o) { (void)dc; return widths(f, l, o); }
BOOL WINAPI GetCharWidth32W(HDC dc, UINT f, UINT l, INT *o) { (void)dc; return widths(f, l, o); }
BOOL WINAPI GetCharABCWidthsFloat(HDC dc, UINT f, UINT l, ABCFLOAT *o)
{ (void)dc; (void)f; (void)l; (void)o; return 0; }
DWORD WINAPI GetCharacterPlacementW(HDC dc, LPCWSTR s, int n, int m, GCP_RESULTSW *r, DWORD fl)
{ (void)dc; (void)s; (void)n; (void)m; (void)r; (void)fl; return 0; }

/* ---- drawing, into a real framebuffer with a real font.
 *
 * THE SURFACE is one buffer for the whole window, and every HDC draws into it. Windows would give
 * each DC its own target; this program has one window and paints it through whichever DC it last
 * asked for, so one buffer is the honest simplification and is named as one here rather than hidden.
 *
 * THE FONT is the IBM VGA 8x16 ROM font, put in guest memory by src/env/vgafont.js -- 256 glyphs of
 * 16 rows, one byte per row, most significant bit leftmost. `prism_vga_font` stays null if that
 * environment was not installed, and then text draws as background: blank, not garbage.
 *
 * Pixels are four bytes, R G B A, because that is what a PNG writer and a canvas both want and it
 * spares everyone a palette. COLORREF is 0x00bbggrr, which is why the channels come out of it in
 * that order.
 */
const unsigned char *prism_vga_font = 0;

int prism_gdi_w, prism_gdi_h, prism_gdi_pitch;
unsigned char *prism_gdi_surface;
int prism_gdi_draws;                    /* how many glyph cells have been written, for a harness */

static COLORREF prism_fg = 0x00c0c0c0;  /* light grey on black, until the program says otherwise */
static COLORREF prism_bk = 0x00000000;

static void prism_surface_ensure(void)
{
    int w = prism_win32_w > 0 ? prism_win32_w : 640;
    int h = prism_win32_h > 0 ? prism_win32_h : 480;
    if (prism_gdi_surface && prism_gdi_w == w && prism_gdi_h == h) return;
    if (prism_gdi_surface) free(prism_gdi_surface);
    prism_gdi_w = w;
    prism_gdi_h = h;
    prism_gdi_pitch = w * 4;
    prism_gdi_surface = (unsigned char *)calloc((size_t)h, (size_t)prism_gdi_pitch);
}

static void prism_pixel(int x, int y, COLORREF c)
{
    unsigned char *p;
    if (!prism_gdi_surface || x < 0 || y < 0 || x >= prism_gdi_w || y >= prism_gdi_h) return;
    p = prism_gdi_surface + y * prism_gdi_pitch + x * 4;
    p[0] = (unsigned char)(c & 0xFF);            /* COLORREF is 0x00bbggrr */
    p[1] = (unsigned char)((c >> 8) & 0xFF);
    p[2] = (unsigned char)((c >> 16) & 0xFF);
    p[3] = 0xFF;
}

static void prism_fill(int l, int t, int r, int b, COLORREF c)
{
    int x, y;
    prism_surface_ensure();
    for (y = t; y < b; y++)
        for (x = l; x < r; x++) prism_pixel(x, y, c);
}

/* One glyph cell. `code` is already the byte the ROM font is indexed by. */
static void prism_glyph(int x, int y, unsigned code, int opaque)
{
    const unsigned char *g;
    int row, col;
    if (opaque) prism_fill(x, y, x + PRISM_FONT_W, y + PRISM_FONT_H, prism_bk);
    if (!prism_vga_font) return;
    g = prism_vga_font + (code & 0xFF) * PRISM_FONT_H;
    for (row = 0; row < PRISM_FONT_H; row++) {
        unsigned bits = g[row];
        for (col = 0; col < PRISM_FONT_W; col++)
            if (bits & (0x80u >> col)) prism_pixel(x + col, y + row, prism_fg);
    }
    prism_gdi_draws++;
}

/*
 * Unicode down to one ROM byte.
 *
 * The font has 256 glyphs in code page 437, and PuTTY hands over UTF-16. Latin-1 is the part the two
 * agree on and is passed through; the box-drawing characters PuTTY uses for its own frames are
 * mapped by hand, because a terminal drawing lines out of question marks would look broken in a way
 * that has nothing to do with the terminal. Everything else becomes a filled box, which is what a
 * font without the glyph is supposed to show.
 */
static unsigned prism_cp437(unsigned wc)
{
    if (wc < 0x100) return wc;
    switch (wc) {
      case 0x2500: return 0xC4;  case 0x2502: return 0xB3;
      case 0x250C: return 0xDA;  case 0x2510: return 0xBF;
      case 0x2514: return 0xC0;  case 0x2518: return 0xD9;
      case 0x251C: return 0xC3;  case 0x2524: return 0xB4;
      case 0x252C: return 0xC2;  case 0x2534: return 0xC1;
      case 0x253C: return 0xC5;  case 0x2591: return 0xB0;
      case 0x2592: return 0xB1;  case 0x2593: return 0xB2;
      case 0x2588: return 0xDB;  case 0x25A0: return 0xFE;
      case 0x2022: return 0xF9;  case 0x00B7: return 0xFA;
      case 0x2190: return 0x1B;  case 0x2192: return 0x1A;
      case 0x2191: return 0x18;  case 0x2193: return 0x19;
      default: return 0xFE;      /* a filled box: "this font has no such character" */
    }
}

static BOOL prism_textout(int x, int y, UINT opts, const RECT *r,
                          const void *str, UINT n, const INT *dx, int wide)
{
    UINT i;
    int cx = x;
    prism_surface_ensure();
    /* ETO_OPAQUE with a rectangle is how a terminal clears: PuTTY passes n == 0 to do exactly that. */
    if ((opts & ETO_OPAQUE) && r) prism_fill(r->left, r->top, r->right, r->bottom, prism_bk);
    for (i = 0; i < n; i++) {
        unsigned c = wide ? prism_cp437(((const unsigned short *)str)[i])
                          : (unsigned char)((const char *)str)[i];
        prism_glyph(cx, y, c, (opts & ETO_OPAQUE) && !r);
        cx += dx ? dx[i] : PRISM_FONT_W;
    }
    return 1;
}

BOOL WINAPI ExtTextOut(HDC dc, int x, int y, UINT o, const RECT *r, LPCSTR s, UINT n, const INT *dx)
{ (void)dc; return prism_textout(x, y, o, r, s, n, dx, 0); }
BOOL WINAPI ExtTextOutW(HDC dc, int x, int y, UINT o, const RECT *r, LPCWSTR s, UINT n, const INT *dx)
{ (void)dc; return prism_textout(x, y, o, r, s, n, dx, 1); }
BOOL WINAPI TextOut(HDC dc, int x, int y, LPCSTR s, int n)
{ (void)dc; return prism_textout(x, y, 0, NULL, s, (UINT)n, NULL, 0); }

COLORREF WINAPI SetTextColor(HDC dc, COLORREF c) { COLORREF o = prism_fg; (void)dc; prism_fg = c; return o; }
COLORREF WINAPI SetBkColor(HDC dc, COLORREF c) { COLORREF o = prism_bk; (void)dc; prism_bk = c; return o; }

BOOL WINAPI LineTo(HDC dc, int x, int y) { (void)dc; (void)x; (void)y; return 1; }
BOOL WINAPI MoveToEx(HDC dc, int x, int y, POINT *old) { (void)dc; (void)x; (void)y; (void)old; return 1; }
BOOL WINAPI Polyline(HDC dc, const POINT *p, int n) { (void)dc; (void)p; (void)n; return 1; }
BOOL WINAPI Rectangle(HDC dc, int l, int t, int r, int b)
{ (void)dc; prism_fill(l, t, r, b, prism_fg); return 1; }
COLORREF WINAPI SetPixel(HDC dc, int x, int y, COLORREF c) { (void)dc; prism_pixel(x, y, c); return c; }
COLORREF WINAPI GetPixel(HDC dc, int x, int y) { (void)dc; (void)x; (void)y; return 0; }

int WINAPI FillRect(HDC dc, const RECT *r, HBRUSH b)
{
    COLORREF c = ((ULONG_PTR)b & PRISM_BRUSH_TAG) ? (COLORREF)((ULONG_PTR)b & 0x00FFFFFF) : prism_bk;
    (void)dc;
    if (r) prism_fill(r->left, r->top, r->right, r->bottom, c);
    return 1;
}
int WINAPI DrawText(HDC dc, LPCSTR s, int n, RECT *r, UINT f)
{
    (void)f;
    if (n < 0) { n = 0; while (s && s[n]) n++; }
    if (r) prism_textout(r->left, r->top, 0, NULL, s, (UINT)n, NULL, 0);
    (void)dc;
    return PRISM_FONT_H;
}
BOOL WINAPI DrawEdge(HDC dc, RECT *r, UINT e, UINT f) { (void)dc; (void)r; (void)e; (void)f; return 1; }
BOOL WINAPI DrawIconEx(HDC dc, int x, int y, HICON i, int cx, int cy, UINT s, HBRUSH b, UINT f)
{ (void)dc; (void)x; (void)y; (void)i; (void)cx; (void)cy; (void)s; (void)b; (void)f; return 1; }
BOOL WINAPI DestroyIcon(HICON i) { (void)i; return 1; }

/* ---- colours */
COLORREF WINAPI GetSysColor(int i) { (void)i; return 0x00C0C0C0; }
HBRUSH WINAPI GetSysColorBrush(int i) { return CreateSolidBrush(GetSysColor(i)); }

/* ---- windows */
HWND WINAPI GetDesktopWindow(void) { return (HWND)0; }
HWND WINAPI GetForegroundWindow(void) { return (HWND)0; }
HWND WINAPI GetParent(HWND h) { (void)h; return (HWND)0; }
BOOL WINAPI IsWindow(HWND h) { return h != (HWND)0; }
BOOL WINAPI IsIconic(HWND h) { (void)h; return 0; }
BOOL WINAPI IsZoomed(HWND h) { (void)h; return 0; }
BOOL WINAPI EnableWindow(HWND h, BOOL e) { (void)h; (void)e; return 1; }
HCURSOR WINAPI SetCursor(HCURSOR c) { return c; }
HANDLE WINAPI LoadImage(HINSTANCE i, LPCSTR n, UINT t, int cx, int cy, UINT l)
{ (void)i; (void)n; (void)t; (void)cx; (void)cy; (void)l; return (HANDLE)0; }
BOOL WINAPI FlashWindow(HWND h, BOOL i) { (void)h; (void)i; return 0; }
BOOL WINAPI FlashWindowEx(FLASHWINFO *f) { (void)f; return 0; }
BOOL WINAPI OffsetRect(RECT *r, int dx, int dy)
{ if (!r) return 0; r->left += dx; r->right += dx; r->top += dy; r->bottom += dy; return 1; }
DWORD WINAPI SetClassLongPtr(HWND h, int i, LONG_PTR v) { (void)h; (void)i; (void)v; return 0; }
UINT WINAPI GetDoubleClickTime(void) { return 500; }
LONG WINAPI GetMessageTime(void) { return 0; }
UINT WINAPI GetCaretBlinkTime(void) { return 530; }
BOOL WINAPI GetWindowPlacement(HWND h, WINDOWPLACEMENT *wp)
{ (void)h; if (wp) { memset(wp, 0, sizeof(*wp)); wp->length = sizeof(*wp); wp->showCmd = 1; } return 1; }
BOOL WINAPI SetWindowPlacement(HWND h, const WINDOWPLACEMENT *wp) { (void)h; (void)wp; return 1; }
int WINAPI GetWindowTextLength(HWND h) { (void)h; return 0; }
int WINAPI GetWindowText(HWND h, LPSTR b, int n) { (void)h; if (b && n) b[0] = 0; return 0; }

/* ---- scrollbars, caret, menus, timers: present, inert. */
BOOL WINAPI GetScrollInfo(HWND h, int bar, LPSCROLLINFO si) { (void)h; (void)bar; (void)si; return 1; }
int WINAPI SetScrollInfo(HWND h, int bar, LPSCROLLINFO si, BOOL rd)
{ (void)h; (void)bar; (void)si; (void)rd; return 0; }
BOOL WINAPI CreateCaret(HWND h, HBITMAP b, int w, int ht) { (void)h; (void)b; (void)w; (void)ht; return 1; }
BOOL WINAPI DestroyCaret(void) { return 1; }
BOOL WINAPI ShowCaret(HWND h) { (void)h; return 1; }
BOOL WINAPI HideCaret(HWND h) { (void)h; return 1; }
BOOL WINAPI SetCaretPos(int x, int y) { (void)x; (void)y; return 1; }
/*
 * MENUS COUNT THEIR ITEMS, and that is not decoration.
 *
 * window.c:1029 empties a submenu by draining it:
 *
 *     while (DeleteMenu(wgs->savedsess_menu, 0, MF_BYPOSITION)) ;
 *
 * On Windows DeleteMenu returns FALSE once there is nothing at that position, and that FALSE is the
 * loop's only exit. A stub returning TRUE unconditionally hangs PuTTYtel forever, right after it has
 * created its window -- which is what it did, and what the safepoint sampler found in one run after
 * hooks on GetMessage and a dozen other candidates had found nothing.
 *
 * The lesson generalises: a stub that answers "success" to a QUESTION is not neutral. Where a
 * caller reads the answer, the shim has to keep enough state to answer it.
 */
#define PRISM_MAX_MENUS 64
static int prism_menu_items[PRISM_MAX_MENUS];
static int prism_menu_count;

static int prism_menu_slot(HMENU m)
{
    int i = (int)(ULONG_PTR)m - 1;
    return (i >= 0 && i < prism_menu_count) ? i : -1;
}
static HMENU prism_new_menu(void)
{
    if (prism_menu_count >= PRISM_MAX_MENUS) return (HMENU)0;
    prism_menu_items[prism_menu_count] = 0;
    return (HMENU)(ULONG_PTR)(++prism_menu_count);
}

HMENU WINAPI CreateMenu(void) { return prism_new_menu(); }
HMENU WINAPI CreatePopupMenu(void) { return prism_new_menu(); }
HMENU WINAPI GetSystemMenu(HWND h, BOOL rev) { (void)h; (void)rev; return prism_new_menu(); }
BOOL WINAPI AppendMenu(HMENU m, UINT f, UINT_PTR id, LPCSTR s)
{
    int i = prism_menu_slot(m);
    (void)f; (void)id; (void)s;
    if (i < 0) return 0;
    prism_menu_items[i]++;
    return 1;
}
BOOL WINAPI InsertMenu(HMENU m, UINT p, UINT f, UINT_PTR id, LPCSTR s)
{ (void)p; return AppendMenu(m, f, id, s); }
BOOL WINAPI DeleteMenu(HMENU m, UINT p, UINT f)
{
    int i = prism_menu_slot(m);
    (void)p; (void)f;
    if (i < 0 || prism_menu_items[i] <= 0) return 0;   /* the FALSE that ends the drain loop */
    prism_menu_items[i]--;
    return 1;
}
DWORD WINAPI CheckMenuItem(HMENU m, UINT id, UINT c) { (void)m; (void)id; (void)c; return 0; }
BOOL WINAPI EnableMenuItem(HMENU m, UINT id, UINT e) { (void)m; (void)id; (void)e; return 1; }
BOOL WINAPI TrackPopupMenu(HMENU m, UINT f, int x, int y, int r, HWND h, const RECT *rc)
{ (void)m; (void)f; (void)x; (void)y; (void)r; (void)h; (void)rc; return 0; }
/* SetTimer and KillTimer live in win32.c: a timer is a message, not a drawing. */
BOOL WINAPI MessageBeep(UINT t) { (void)t; return 1; }
HWND WINAPI GetCapture(void) { return (HWND)0; }
BOOL WINAPI Beep(DWORD f, DWORD d) { (void)f; (void)d; return 1; }
BOOL WINAPI PlaySound(LPCSTR n, HMODULE m, DWORD f) { (void)n; (void)m; (void)f; return 0; }

/* ---- the clipboard, which is empty and stays empty. */
BOOL WINAPI OpenClipboard(HWND h) { (void)h; return 1; }
BOOL WINAPI CloseClipboard(void) { return 1; }
BOOL WINAPI EmptyClipboard(void) { return 1; }
HANDLE WINAPI GetClipboardData(UINT f) { (void)f; return (HANDLE)0; }
HANDLE WINAPI SetClipboardData(UINT f, HANDLE h) { (void)f; return h; }
UINT WINAPI RegisterClipboardFormat(LPCSTR n) { (void)n; return 0xC000; }
/* GlobalAlloc and friends live in win32.c: they are memory, not drawing. */

/* ---- keyboard and the IME: no layout, no composition. */
HKL WINAPI GetKeyboardLayout(DWORD t) { (void)t; return (HKL)0; }
BOOL WINAPI GetKeyboardState(BYTE *s) { if (s) memset(s, 0, 256); return 1; }
BOOL WINAPI SetKeyboardState(BYTE *s) { (void)s; return 1; }
UINT WINAPI MapVirtualKeyEx(UINT c, UINT t, HKL l) { (void)t; (void)l; return c; }
int WINAPI ToAsciiEx(UINT vk, UINT sc, const BYTE *st, LPWORD out, UINT f, HKL l)
{ (void)vk; (void)sc; (void)st; (void)out; (void)f; (void)l; return 0; }
BOOL WINAPI TranslateCharsetInfo(DWORD *src, LPCHARSETINFO out, DWORD f)
{ (void)src; (void)f; if (out) { memset(out, 0, sizeof(*out)); out->ciACP = 1252; } return 1; }
int WINAPI GetLocaleInfo(DWORD loc, DWORD type, LPSTR buf, int n)
{
    const char *v = "1252";
    int len = 5;
    (void)loc; (void)type;
    if (n == 0) return len;
    if (n < len) return 0;
    strcpy(buf, v);
    return len;
}
HIMC WINAPI ImmGetContext(HWND h) { (void)h; return (HIMC)0; }
BOOL WINAPI ImmReleaseContext(HWND h, HIMC c) { (void)h; (void)c; return 1; }
LONG WINAPI ImmGetCompositionStringW(HIMC c, DWORD i, LPVOID b, DWORD n)
{ (void)c; (void)i; (void)b; (void)n; return 0; }
BOOL WINAPI ImmSetCompositionFont(HIMC c, LPLOGFONT lf) { (void)c; (void)lf; return 1; }
BOOL WINAPI ImmSetCompositionWindow(HIMC c, COMPOSITIONFORM *f) { (void)c; (void)f; return 1; }

/* ---- dialogs. PuTTY's configuration box is not shown; the program is told the user cancelled. */
HWND WINAPI GetDlgItem(HWND d, int id) { (void)d; (void)id; return (HWND)0; }
LRESULT WINAPI SendDlgItemMessage(HWND d, int id, UINT m, WPARAM w, LPARAM l)
{ (void)d; (void)id; (void)m; (void)w; (void)l; return 0; }
BOOL WINAPI SetDlgItemText(HWND d, int id, LPCSTR t) { (void)d; (void)id; (void)t; return 1; }
BOOL WINAPI SetDlgItemTextW(HWND d, int id, LPCWSTR t) { (void)d; (void)id; (void)t; return 1; }
UINT WINAPI GetDlgItemText(HWND d, int id, LPSTR b, int n) { (void)d; (void)id; if (b && n) b[0] = 0; return 0; }
UINT WINAPI IsDlgButtonChecked(HWND d, int id) { (void)d; (void)id; return 0; }
BOOL WINAPI CheckDlgButton(HWND d, int id, UINT c) { (void)d; (void)id; (void)c; return 1; }
BOOL WINAPI CheckRadioButton(HWND d, int a, int b, int c) { (void)d; (void)a; (void)b; (void)c; return 1; }
BOOL WINAPI MapDialogRect(HWND d, RECT *r) { (void)d; (void)r; return 1; }
BOOL WINAPI EndDialog(HWND d, INT_PTR r) { (void)d; (void)r; return 1; }
INT_PTR WINAPI DialogBox(HINSTANCE i, LPCSTR t, HWND p, void *proc)
{ (void)i; (void)t; (void)p; (void)proc; return 0; }   /* IDCANCEL is 2; 0 means the box never opened */
BOOL WINAPI ChooseFont(LPCHOOSEFONT cf) { (void)cf; return 0; }
BOOL WINAPI ChooseColor(LPCHOOSECOLOR cc) { (void)cc; return 0; }
BOOL WINAPI GetOpenFileNameA(OPENFILENAMEA *o) { (void)o; return 0; }
BOOL WINAPI GetSaveFileNameA(OPENFILENAMEA *o) { (void)o; return 0; }
BOOL WINAPI GetOpenFileNameW(OPENFILENAMEW *o) { (void)o; return 0; }
BOOL WINAPI GetSaveFileNameW(OPENFILENAMEW *o) { (void)o; return 0; }
HINSTANCE WINAPI ShellExecute(HWND h, LPCSTR v, LPCSTR f, LPCSTR p, LPCSTR d, INT s)
{ (void)h; (void)v; (void)f; (void)p; (void)d; (void)s; return (HINSTANCE)0; }
int WINAPI MulDiv(int a, int b, int c) { return c ? (int)(((long long)a * b) / c) : -1; }

/*
 * The last handful, added one run at a time because the report says what a program DECLARES and only
 * running says what it CALLS. defuse_showwindow is the one that named most of them: PuTTY creates a
 * throwaway window and destroys it, so that the shell's "show state" is spent on that one instead of
 * on the terminal.
 *
 * Anything that MOVES OR DESTROYS a window is win32.c's, not this file's -- that is the whole point
 * of the split, and six of these had to go back there once PuTTY called them.
 */
HWND WINAPI SetActiveWindow(HWND h) { return h; }
HWND WINAPI SetFocus(HWND h) { return h; }
HWND WINAPI GetFocus(void) { return (HWND)0; }
BOOL WINAPI BringWindowToTop(HWND h) { (void)h; return 1; }
BOOL WINAPI ScrollWindow(HWND h, int dx, int dy, const RECT *sc, const RECT *cl)
{ (void)h; (void)dx; (void)dy; (void)sc; (void)cl; return 1; }

BOOL WINAPI MoveWindow(HWND h, int x, int y, int w, int ht, BOOL repaint)
{ (void)h; (void)x; (void)y; (void)w; (void)ht; (void)repaint; return 1; }
UINT WINAPI GetDlgItemTextW(HWND d, int id, LPWSTR b, int n)
{ (void)d; (void)id; if (b && n) b[0] = 0; return 0; }
BOOL WINAPI GetUserName(LPSTR buf, LPDWORD n)
{
    const char *u = "prism";
    DWORD len = 6;
    if (!n) return 0;
    if (*n < len) { *n = len; return 0; }
    strcpy(buf, u);
    *n = len - 1;
    return 1;
}
UINT WINAPI GetWindowsDirectory(LPSTR buf, UINT n)
{
    const char *d = "C:\\WINDOWS";
    UINT len = (UINT)strlen(d);
    if (n > len) { strcpy(buf, d); return len; }
    return len + 1;
}

/*
 * The A/W and no-suffix spellings all reach win32.c's one CreateWindowEx, which is the function that
 * actually records the window. Windows itself layers them the same way -- CreateWindow is a macro
 * over CreateWindowEx with no extended style -- so this is the shape of the real API, not a shim.
 */
HWND WINAPI CreateWindow(LPCSTR cls, LPCSTR name, DWORD style, int x, int y, int w, int h,
                         HWND parent, HMENU menu, HINSTANCE inst, LPVOID param)
{ return CreateWindowEx(0, cls, name, style, x, y, w, h, parent, menu, inst, param); }
HWND WINAPI CreateWindowExA(DWORD ex, LPCSTR cls, LPCSTR name, DWORD style,
                            int x, int y, int w, int h, HWND parent, HMENU menu,
                            HINSTANCE inst, LPVOID param)
{ return CreateWindowEx(ex, cls, name, style, x, y, w, h, parent, menu, inst, param); }

BOOL WINAPI DeleteObject(HGDIOBJ o) { (void)o; return 1; }
HGDIOBJ WINAPI GetStockObject(int i) { return NEW_HANDLE(HGDIOBJ); }

/*
 * A dialogue template lives in a .rc resource, and PRISM compiles no resources -- so there is no
 * dialogue to create and this returns NULL. PuTTY's ShinyDialogBox checks it and returns -1, which
 * is its own "the box could not be shown"; do_config then behaves as if the user cancelled.
 */
INT_PTR WINAPI DialogBoxParam(HINSTANCE inst, LPCSTR tmpl, HWND parent, void *proc, LPARAM init)
{ (void)inst; (void)tmpl; (void)parent; (void)proc; (void)init; return -1; }
LRESULT WINAPI DefDlgProc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProc(h, m, w, l); }
BOOL WINAPI IsDialogMessage(HWND dlg, MSG *msg) { (void)dlg; (void)msg; return 0; }

/*
 * The A and W twins, on top of win32.c's one implementation of each.
 *
 * Windows really does have two entry points here, and the difference is not cosmetic: it decides
 * whether the window's messages carry ANSI or UTF-16 text. PuTTY registers the wide class when it
 * can, so the wide names have to work -- but the only wide thing about them at this depth is the
 * class NAME, which is narrowed here because win32.c keeps one class table.
 */
static char prism_narrow_buf[256];
static const char *prism_narrow(const wchar_t *w)
{
    size_t i;
    if (!w) return NULL;
    for (i = 0; i + 1 < sizeof(prism_narrow_buf) && w[i]; i++)
        prism_narrow_buf[i] = (char)(w[i] < 0x100 ? w[i] : '?');
    prism_narrow_buf[i] = 0;
    return prism_narrow_buf;
}

ATOM WINAPI RegisterClassA(const WNDCLASSA *c) { return RegisterClass(c); }
ATOM WINAPI RegisterClassW(const WNDCLASSW *c)
{
    WNDCLASSA a;
    if (!c) return 0;
    a.style = c->style;
    a.lpfnWndProc = c->lpfnWndProc;
    a.cbClsExtra = c->cbClsExtra;
    a.cbWndExtra = c->cbWndExtra;
    a.hInstance = c->hInstance;
    a.hIcon = c->hIcon;
    a.hCursor = c->hCursor;
    a.hbrBackground = c->hbrBackground;
    a.lpszMenuName = NULL;
    /* The class name must survive the call: win32.c keeps the pointer, so this copy is static. */
    {
        static char names[8][64];
        static int next;
        const char *n = prism_narrow(c->lpszClassName);
        int slot = next++ & 7;
        strncpy(names[slot], n ? n : "", sizeof(names[0]) - 1);
        names[slot][sizeof(names[0]) - 1] = 0;
        a.lpszClassName = names[slot];
    }
    return RegisterClass(&a);
}

HWND WINAPI CreateWindowExW(DWORD ex, LPCWSTR cls, LPCWSTR name, DWORD style,
                            int x, int y, int w, int h, HWND parent, HMENU menu,
                            HINSTANCE inst, LPVOID param)
{
    static char clsbuf[256];
    const char *c = prism_narrow(cls);
    if (c) { strncpy(clsbuf, c, sizeof(clsbuf) - 1); clsbuf[sizeof(clsbuf) - 1] = 0; }
    return CreateWindowEx(ex, c ? clsbuf : NULL, prism_narrow(name), style,
                          x, y, w, h, parent, menu, inst, param);
}

LRESULT WINAPI DefWindowProcA(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProc(h, m, w, l); }
LRESULT WINAPI DefWindowProcW(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProc(h, m, w, l); }
LRESULT WINAPI DispatchMessageA(const MSG *m) { return DispatchMessage(m); }
LRESULT WINAPI DispatchMessageW(const MSG *m) { return DispatchMessage(m); }
BOOL WINAPI GetMessageW(MSG *m, HWND h, UINT lo, UINT hi) { return GetMessage(m, h, lo, hi); }
BOOL WINAPI PeekMessageW(MSG *m, HWND h, UINT lo, UINT hi, UINT r) { return PeekMessage(m, h, lo, hi, r); }
BOOL WINAPI SetWindowTextA(HWND h, LPCSTR t) { return SetWindowText(h, t); }
BOOL WINAPI SetWindowTextW(HWND h, LPCWSTR t) { return SetWindowText(h, prism_narrow(t)); }

/* Palettes. A 32-bit surface has no palette to select, so these succeed and change nothing. */
HPALETTE WINAPI CreatePalette(const LOGPALETTE *p) { (void)p; return NEW_HANDLE(HPALETTE); }
HPALETTE WINAPI SelectPalette(HDC dc, HPALETTE p, BOOL bg) { (void)dc; (void)bg; return p; }
UINT WINAPI RealizePalette(HDC dc) { (void)dc; return 0; }
