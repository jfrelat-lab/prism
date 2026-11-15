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

#include <math.h>
#include <stddef.h>
#include <stdio.h>
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

/* A brush is a handle whose top byte is the tag: other tagged handles have bit 30 set too (win32.c's
   DIB sections, 0x4449xxxx), and a bit test took them for brushes. */
#define PRISM_IS_BRUSH(h) (((ULONG_PTR)(h) & 0xFF000000u) == PRISM_BRUSH_TAG)

/* ---- TrueType fonts in memory bitmaps
 *
 * What a program does to turn letters into a texture (.kkrieger): a memory DC, a 32-bit bitmap or DIB
 * section selected into it, a TrueType font by name, ExtTextOut, then the bitmap's pixels read back.
 * The fonts are files, where Windows keeps them: c:/windows/fonts/arial.ttf and the like, which the
 * host puts in the program's file store. PRISM ships none (they are Microsoft's); without them a font
 * resolves to nothing and every call below takes the VGA 8x16 path it always had.
 *
 * The rasteriser is MIRAGE's (src/win32/truetype.js and api.js's fillGlyph), transcribed: the outline
 * scaled to pixels and rounded to 1/64, quadratic splines cut into 8 lines each, filled at pixel
 * centres by the nonzero rule -- GDI's aliased text without Windows' hinting. ANTIALIASED_QUALITY
 * samples 4x4 per pixel instead. Advances are the font's hdmx widths where it has them for the size,
 * which is what the hinted advances are; else the scaled advance, rounded.
 */
typedef struct {
    unsigned char *d;
    long n;
    int em, winAsc, winDesc, lineGap, hAsc, hDesc, avgW, bboxW, numGlyphs, numH, longLoca, cmapFmt;
    long glyf, loca, hmtx, cmap, hdmx, vdmx, gasp;
} prism_ttf;

static unsigned tt_u8(const prism_ttf *f, long o) { return o >= 0 && o < f->n ? f->d[o] : 0; }
static unsigned tt_u16(const prism_ttf *f, long o) { return (tt_u8(f, o) << 8) | tt_u8(f, o + 1); }
static int tt_s16(const prism_ttf *f, long o) { return (short)tt_u16(f, o); }
static unsigned long tt_u32(const prism_ttf *f, long o) { return ((unsigned long)tt_u16(f, o) << 16) | tt_u16(f, o + 2); }

static prism_ttf *tt_parse(unsigned char *d, long n)
{
    prism_ttf *f = (prism_ttf *)calloc(1, sizeof(prism_ttf));
    long head = -1, maxp = -1, hhea = -1, os2 = -1, cmap = -1;
    unsigned i, nt;
    f->d = d; f->n = n;
    nt = tt_u16(f, 4);
    for (i = 0; i < nt; i++) {
        long r = 12 + 16 * (long)i, at = (long)tt_u32(f, r + 8);
        if (!memcmp(d + r, "head", 4)) head = at;
        else if (!memcmp(d + r, "maxp", 4)) maxp = at;
        else if (!memcmp(d + r, "hhea", 4)) hhea = at;
        else if (!memcmp(d + r, "OS/2", 4)) os2 = at;
        else if (!memcmp(d + r, "cmap", 4)) cmap = at;
        else if (!memcmp(d + r, "glyf", 4)) f->glyf = at;
        else if (!memcmp(d + r, "loca", 4)) f->loca = at;
        else if (!memcmp(d + r, "hmtx", 4)) f->hmtx = at;
        else if (!memcmp(d + r, "hdmx", 4)) f->hdmx = at;
        else if (!memcmp(d + r, "VDMX", 4)) f->vdmx = at;
        else if (!memcmp(d + r, "gasp", 4)) f->gasp = at;
    }
    if (head < 0 || maxp < 0 || hhea < 0 || cmap < 0 || !f->glyf || !f->loca || !f->hmtx) { free(f); return 0; }
    f->em = (int)tt_u16(f, head + 18);
    f->longLoca = tt_s16(f, head + 50) == 1;
    f->numGlyphs = (int)tt_u16(f, maxp + 4);
    f->hAsc = tt_s16(f, hhea + 4); f->hDesc = tt_s16(f, hhea + 6); f->lineGap = tt_s16(f, hhea + 8);
    f->bboxW = tt_s16(f, head + 40) - tt_s16(f, head + 36); f->numH = (int)tt_u16(f, hhea + 34);
    if (os2 >= 0) { f->avgW = tt_s16(f, os2 + 2); f->winAsc = (int)tt_u16(f, os2 + 74); f->winDesc = (int)tt_u16(f, os2 + 76); }
    else { f->avgW = f->em / 2; f->winAsc = f->hAsc; f->winDesc = -f->hDesc; }
    if (f->em <= 0 || f->numH <= 0) { free(f); return 0; }
    /* cmap: the Unicode subtable, format 4 (the BMP) or 12; Windows' own (3,1) preferred */
    for (i = 0, nt = tt_u16(f, cmap + 2); i < nt; i++) {
        unsigned pid = tt_u16(f, cmap + 4 + 8 * i), eid = tt_u16(f, cmap + 6 + 8 * i);
        long at = cmap + (long)tt_u32(f, cmap + 8 + 8 * i);
        unsigned fmt = tt_u16(f, at);
        if (!(pid == 0 || (pid == 3 && (eid == 1 || eid == 10)))) continue;
        if (fmt == 4 || fmt == 12) { f->cmap = at; f->cmapFmt = (int)fmt; }
        if (fmt == 4 && pid == 3 && eid == 1) break;
    }
    return f;
}

static unsigned tt_map(const prism_ttf *f, unsigned c)
{
    long at = f->cmap;
    if (!at) return 0;
    if (f->cmapFmt == 4) {
        unsigned segs = tt_u16(f, at + 6) / 2, s;
        long ends = at + 14, starts = ends + 2 * segs + 2, deltas = starts + 2 * segs, offs = deltas + 2 * segs;
        for (s = 0; s < segs; s++) {
            unsigned first, ro, g;
            if (tt_u16(f, ends + 2 * s) < c) continue;
            first = tt_u16(f, starts + 2 * s);
            if (c < first) return 0;
            ro = tt_u16(f, offs + 2 * s);
            if (!ro) return (c + tt_u16(f, deltas + 2 * s)) & 0xffff;
            g = tt_u16(f, offs + 2 * s + ro + 2 * (c - first));
            return g ? (g + tt_u16(f, deltas + 2 * s)) & 0xffff : 0;
        }
        return 0;
    } else {
        unsigned long k, groups = tt_u32(f, at + 12);
        for (k = 0; k < groups; k++) {
            long g = at + 16 + 12 * (long)k;
            unsigned long a = tt_u32(f, g), b = tt_u32(f, g + 4);
            if (c >= a && c <= b) return (unsigned)(tt_u32(f, g + 8) + c - a);
        }
        return 0;
    }
}

static long tt_loca(const prism_ttf *f, unsigned g)
{ return f->longLoca ? (long)tt_u32(f, f->loca + 4 * (long)g) : 2 * (long)tt_u16(f, f->loca + 2 * (long)g); }
static int tt_advance_units(const prism_ttf *f, unsigned g)
{ return (int)tt_u16(f, f->hmtx + 4 * (long)((int)g < f->numH ? (int)g : f->numH - 1)); }

/* A glyph's outline as edges, in pixels (y up, origin at the pen), and the bounds of its points. */
typedef struct { float x0, y0, x1, y1; } tt_edge;
static tt_edge *tt_edges;
static int tt_nedges, tt_capedges, tt_npts;
static float tt_minx, tt_maxx, tt_miny, tt_maxy;

static void tt_point(float x, float y)
{
    if (!tt_npts++) { tt_minx = tt_maxx = x; tt_miny = tt_maxy = y; return; }
    if (x < tt_minx) tt_minx = x;
    if (x > tt_maxx) tt_maxx = x;
    if (y < tt_miny) tt_miny = y;
    if (y > tt_maxy) tt_maxy = y;
}
static void tt_line(float x0, float y0, float x1, float y1)
{
    if (y0 == y1) return;
    if (tt_nedges == tt_capedges) {
        tt_capedges = tt_capedges ? 2 * tt_capedges : 256;
        tt_edges = (tt_edge *)realloc(tt_edges, (size_t)tt_capedges * sizeof(tt_edge));
    }
    tt_edges[tt_nedges].x0 = x0; tt_edges[tt_nedges].y0 = y0;
    tt_edges[tt_nedges].x1 = x1; tt_edges[tt_nedges].y1 = y1;
    tt_nedges++;
}
static void tt_quad(float ax, float ay, float cx, float cy, float ex, float ey)
{
    float px = ax, py = ay;
    int k;
    for (k = 1; k <= 8; k++) {
        float t = k / 8.0f, u = 1 - t;
        float qx = u * u * ax + 2 * u * t * cx + t * t * ex, qy = u * u * ay + 2 * u * t * cy + t * t * ey;
        tt_line(px, py, qx, qy);
        px = qx; py = qy;
    }
}
/* to pixels, rounded to 1/64 as GGO_NATIVE has the points */
static float tt_px(double v) { return (float)(floor(v * 64 + 0.5) / 64); }

/* One contour's points, already in pixels: a run of off-curve points has implied on-curve points
   between them; a contour that starts off the curve starts at its last point if that is on it, else
   halfway between the two. A contour of one point is left out. */
static void tt_contour(const float *x, const float *y, const unsigned char *on, int n)
{
    float sx, sy, cx = 0, cy = 0, curx, cury;
    int i, first, pend = 0;
    if (n < 2) return;
    for (i = 0; i < n; i++) tt_point(x[i], y[i]);
    if (on[0]) { sx = x[0]; sy = y[0]; first = 1; }
    else if (on[n - 1]) { sx = x[n - 1]; sy = y[n - 1]; first = 0; n--; }
    else { sx = (x[0] + x[n - 1]) / 2; sy = (y[0] + y[n - 1]) / 2; first = 0; }
    curx = sx; cury = sy;
    for (i = first; i < n; i++) {
        if (on[i]) {
            if (pend) tt_quad(curx, cury, cx, cy, x[i], y[i]); else tt_line(curx, cury, x[i], y[i]);
            curx = x[i]; cury = y[i]; pend = 0;
        } else {
            if (pend) { float mx = (cx + x[i]) / 2, my = (cy + y[i]) / 2; tt_quad(curx, cury, cx, cy, mx, my); curx = mx; cury = my; }
            cx = x[i]; cy = y[i]; pend = 1;
        }
    }
    if (pend) tt_quad(curx, cury, cx, cy, sx, sy); else tt_line(curx, cury, sx, sy);
}

/* Glyph g's contours through the matrix m (font units to font units: x' = m0 x + m2 y + m4,
   y' = m1 x + m3 y + m5), then scaled by sx, sy to pixels; a composite's components placed in turn. */
static void tt_glyph_outline(const prism_ttf *f, unsigned g, const double *m, double sx, double sy, int depth)
{
    long at, p;
    int n, i, count, s;
    unsigned char *fl, *on;
    float *xs, *ys;
    if ((int)g >= f->numGlyphs || depth > 8) return;
    if (tt_loca(f, g + 1) == tt_loca(f, g)) return;
    at = f->glyf + tt_loca(f, g);
    n = tt_s16(f, at);
    if (n < 0) {
        int more = 1;
        p = at + 10;
        while (more) {
            unsigned flags = tt_u16(f, p), comp = tt_u16(f, p + 2);
            double a = 1, b = 0, c = 0, d = 1, e, ff, cm[6];
            p += 4;
            if (flags & 1) { e = tt_s16(f, p); ff = tt_s16(f, p + 2); p += 4; }
            else { e = (signed char)tt_u8(f, p); ff = (signed char)tt_u8(f, p + 1); p += 2; }
            if (flags & 8) { a = d = tt_s16(f, p) / 16384.0; p += 2; }
            else if (flags & 0x40) { a = tt_s16(f, p) / 16384.0; d = tt_s16(f, p + 2) / 16384.0; p += 4; }
            else if (flags & 0x80) { a = tt_s16(f, p) / 16384.0; b = tt_s16(f, p + 2) / 16384.0; c = tt_s16(f, p + 4) / 16384.0; d = tt_s16(f, p + 6) / 16384.0; p += 8; }
            if (!(flags & 2)) e = ff = 0;                       /* matched points: not met in a text font */
            /* this component's matrix, then the parent's */
            cm[0] = m[0] * a + m[2] * b; cm[1] = m[1] * a + m[3] * b;
            cm[2] = m[0] * c + m[2] * d; cm[3] = m[1] * c + m[3] * d;
            cm[4] = m[0] * e + m[2] * ff + m[4]; cm[5] = m[1] * e + m[3] * ff + m[5];
            tt_glyph_outline(f, comp, cm, sx, sy, depth + 1);
            more = (flags & 0x20) != 0;
        }
        return;
    }
    if (!n) return;
    count = (int)tt_u16(f, at + 10 + 2 * (n - 1)) + 1;
    p = at + 10 + 2 * n;
    p += 2 + tt_u16(f, p);                                      /* the instructions */
    fl = (unsigned char *)malloc((size_t)count);
    on = (unsigned char *)malloc((size_t)count);
    xs = (float *)malloc((size_t)count * sizeof(float));
    ys = (float *)malloc((size_t)count * sizeof(float));
    for (i = 0; i < count;) {
        unsigned char fv = (unsigned char)tt_u8(f, p++);
        fl[i++] = fv;
        if (fv & 8) { unsigned r = tt_u8(f, p++); while (r-- && i < count) fl[i++] = fv; }
    }
    {
        int v = 0;
        for (i = 0; i < count; i++) {
            if (fl[i] & 2) { int dd = (int)tt_u8(f, p++); v += (fl[i] & 16) ? dd : -dd; }
            else if (!(fl[i] & 16)) { v += tt_s16(f, p); p += 2; }
            xs[i] = (float)v;
        }
        v = 0;
        for (i = 0; i < count; i++) {
            if (fl[i] & 4) { int dd = (int)tt_u8(f, p++); v += (fl[i] & 32) ? dd : -dd; }
            else if (!(fl[i] & 32)) { v += tt_s16(f, p); p += 2; }
            ys[i] = (float)v;
        }
    }
    for (i = 0; i < count; i++) {
        double x = xs[i], y = ys[i];
        xs[i] = tt_px((m[0] * x + m[2] * y + m[4]) * sx);
        ys[i] = tt_px((m[1] * x + m[3] * y + m[5]) * sy);
        on[i] = fl[i] & 1;
    }
    for (i = 0, s = 0; i < n; i++) {
        int e = (int)tt_u16(f, at + 10 + 2 * i);
        if (e >= count) break;
        tt_contour(xs + s, ys + s, on + s, e + 1 - s);
        s = e + 1;
    }
    free(fl); free(on); free(xs); free(ys);
}
static void tt_outline(const prism_ttf *f, unsigned g, double sx, double sy)
{
    static const double id[6] = { 1, 0, 0, 1, 0, 0 };
    tt_nedges = 0; tt_npts = 0;
    tt_glyph_outline(f, g, id, sx, sy, 0);
}

/* A 32- or 24-bit pixel buffer: a memory bitmap's or a DIB section's. */
typedef struct { unsigned char *bits; int w, h, pitch, bpp, topdown; } prism_target;

/* COLORREF is 0x00bbggrr; a DIB's pixel B, G, R(, X). GDI leaves the fourth byte zero where it draws. */
static void tt_put(const prism_target *t, int x, int y, COLORREF c, int cov)
{
    unsigned char *p;
    int col[3], k;
    if (x < 0 || y < 0 || x >= t->w || y >= t->h || cov <= 0) return;
    p = t->bits + (long)(t->topdown ? y : t->h - 1 - y) * t->pitch + (long)x * (t->bpp / 8);
    col[0] = (int)((c >> 16) & 255); col[1] = (int)((c >> 8) & 255); col[2] = (int)(c & 255);
    for (k = 0; k < 3; k++) p[k] = (unsigned char)(cov >= 16 ? col[k] : p[k] + ((col[k] - p[k]) * cov + 8) / 16);
    if (t->bpp == 32) p[3] = 0;
}
static void tt_rect(const prism_target *t, int l, int tp, int r, int b, COLORREF c)
{
    int x, y;
    for (y = tp; y < b; y++) for (x = l; x < r; x++) tt_put(t, x, y, c, 16);
}

static int tt_cmp_float2(const void *a, const void *b)
{ float d = ((const float *)a)[0] - ((const float *)b)[0]; return d < 0 ? -1 : d > 0; }

/* The edges tt_outline made, at pen (ox, baseline oy), filled: at pixel centres by the nonzero rule,
   or with 4x4 samples a pixel when `aa`. */
static void tt_fill(const prism_target *t, float ox, float oy, COLORREF c, int aa)
{
    static float *xs;
    static int capx;
    static int *cov;
    static int capcov;
    int y, y0, y1, sub = aa ? 4 : 1, k, i;
    if (!tt_nedges) return;
    y0 = (int)floor(oy - tt_maxy); y1 = (int)ceil(oy - tt_miny);
    if (y0 < 0) y0 = 0;
    if (y1 > t->h - 1) y1 = t->h - 1;
    if (capx < 2 * tt_nedges) { capx = 2 * tt_nedges; xs = (float *)realloc(xs, (size_t)capx * sizeof(float)); }
    if (aa && capcov < t->w) { capcov = t->w; cov = (int *)realloc(cov, (size_t)capcov * sizeof(int)); }
    for (y = y0; y <= y1; y++) {
        if (aa) memset(cov, 0, (size_t)t->w * sizeof(int));
        for (k = 0; k < sub; k++) {
            float yc = y + (k + 0.5f) / sub;
            int nx = 0, wind = 0;
            for (i = 0; i < tt_nedges; i++) {
                float ey0 = oy - tt_edges[i].y0, ey1 = oy - tt_edges[i].y1;
                if ((ey0 <= yc && ey1 > yc) || (ey1 <= yc && ey0 > yc)) {
                    float ex0 = ox + tt_edges[i].x0, ex1 = ox + tt_edges[i].x1;
                    xs[2 * nx] = ex0 + (yc - ey0) * (ex1 - ex0) / (ey1 - ey0);
                    xs[2 * nx + 1] = ey1 > ey0 ? 1.0f : -1.0f;
                    nx++;
                }
            }
            qsort(xs, (size_t)nx, 2 * sizeof(float), tt_cmp_float2);
            for (i = 0; i < nx - 1; i++) {
                int a, b, X;
                wind += (int)xs[2 * i + 1];
                if (!wind) continue;
                a = (int)ceil(xs[2 * i] * sub - 0.5f); b = (int)ceil(xs[2 * i + 2] * sub - 0.5f);
                if (a < 0) a = 0;
                if (b > t->w * sub) b = t->w * sub;
                if (aa) for (X = a; X < b; X++) cov[X >> 2]++;
                else for (X = a; X < b; X++) tt_put(t, X, y, c, 16);
            }
        }
        if (aa) for (i = 0; i < t->w; i++) if (cov[i]) tt_put(t, i, y, c, cov[i]);
    }
}

/* ---- GDI objects: bitmaps (memory ones and DIB sections) and fonts, and memory DCs */
#define PRISM_GOBJ_TAG 0x21000000u
#define PRISM_MDC_TAG  0x22000000u
#define PRISM_STOCK_BITMAP ((HGDIOBJ)(ULONG_PTR)(PRISM_GOBJ_TAG | 0xffffu))
#define PRISM_STOCK_FONT   ((HGDIOBJ)(ULONG_PTR)(PRISM_GOBJ_TAG | 0xfffeu))
enum { GOBJ_FREE, GOBJ_BITMAP, GOBJ_FONT };
typedef struct {
    int kind;
    HGDIOBJ h;
    prism_target bm;                /* a bitmap */
    int owned;                      /* its pixels are ours to free (not a DIB section's) */
    int height, width, weight, italic, quality;   /* a font, as its LOGFONT */
    char face[32];
    int resolved;
    prism_ttf *tt;
} prism_gobj;
static prism_gobj prism_gobjs[256];
static int prism_gobj_seq;

static prism_gobj *gobj_new(int kind)
{
    int i;
    for (i = 0; i < 256; i++) if (prism_gobjs[i].kind == GOBJ_FREE) {
        memset(&prism_gobjs[i], 0, sizeof(prism_gobj));
        prism_gobjs[i].kind = kind;
        prism_gobjs[i].h = (HGDIOBJ)(ULONG_PTR)(PRISM_GOBJ_TAG | ((unsigned)(++prism_gobj_seq & 0xff) << 8) | (unsigned)i);
        return &prism_gobjs[i];
    }
    return 0;
}
static prism_gobj *gobj_of(HGDIOBJ h)
{
    int i;
    if (!h) return 0;
    for (i = 0; i < 256; i++) if (prism_gobjs[i].kind != GOBJ_FREE && prism_gobjs[i].h == h) return &prism_gobjs[i];
    return 0;
}

/* A DIB section, from win32.c's CreateDIBSection: its pixels are the program's own memory. */
void prism_gdi_dib(HBITMAP h, void *bits, int w, int ht, int pitch, int bpp, int topdown)
{
    prism_gobj *o = gobj_new(GOBJ_BITMAP);
    if (!o) return;
    o->h = (HGDIOBJ)h;
    o->bm.bits = (unsigned char *)bits; o->bm.w = w; o->bm.h = ht; o->bm.pitch = pitch; o->bm.bpp = bpp; o->bm.topdown = topdown;
}

typedef struct { HDC h; HGDIOBJ bitmap, font; COLORREF fg, bk; int bkmode; } prism_mdc;
static prism_mdc prism_mdcs[32];
static int prism_mdc_seq;
static prism_mdc *mdc_of(HDC h)
{
    int i;
    if (((ULONG_PTR)h & 0xFF000000u) != PRISM_MDC_TAG) return 0;
    for (i = 0; i < 32; i++) if (prism_mdcs[i].h == h) return &prism_mdcs[i];
    return 0;
}

/* A font's file: Windows' own names for its fonts' files, regular, bold, italic, bold italic. A face
   it does not know is looked for as <face>.ttf, then given Arial, as Windows' mapper substitutes. */
static const char *const prism_font_files[][5] = {
    { "arial", "arial", "arialbd", "ariali", "arialbi" },
    { "times new roman", "times", "timesbd", "timesi", "timesbi" },
    { "courier new", "cour", "courbd", "couri", "courbi" },
    { "tahoma", "tahoma", "tahomabd", "tahoma", "tahomabd" },
    { "verdana", "verdana", "verdanab", "verdanai", "verdanaz" },
    { "georgia", "georgia", "georgiab", "georgiai", "georgiaz" },
    { "trebuchet ms", "trebuc", "trebucbd", "trebucit", "trebucbi" },
    { "comic sans ms", "comic", "comicbd", "comic", "comicbd" },
    { "impact", "impact", "impact", "impact", "impact" },
    { "lucida console", "lucon", "lucon", "lucon", "lucon" },
};
static struct { char name[16]; prism_ttf *tt; int tried; } prism_font_cache[24];

static prism_ttf *font_file(const char *name)
{
    int i;
    char path[64];
    FILE *fp;
    long n;
    unsigned char *d;
    for (i = 0; i < 24 && prism_font_cache[i].tried; i++)
        if (!strcmp(prism_font_cache[i].name, name)) return prism_font_cache[i].tt;
    if (i == 24 || strlen(name) >= sizeof(prism_font_cache[0].name)) return 0;
    strcpy(prism_font_cache[i].name, name);
    prism_font_cache[i].tried = 1;
    strcpy(path, "c:/windows/fonts/");
    strcat(path, name);
    strcat(path, ".ttf");
    fp = fopen(path, "rb");
    if (!fp) return 0;
    fseek(fp, 0, SEEK_END); n = ftell(fp); fseek(fp, 0, SEEK_SET);
    d = n > 12 ? (unsigned char *)malloc((size_t)n) : 0;
    if (d && fread(d, 1, (size_t)n, fp) == (size_t)n) prism_font_cache[i].tt = tt_parse(d, n);
    fclose(fp);
    if (!prism_font_cache[i].tt) free(d);
    return prism_font_cache[i].tt;
}
static prism_ttf *font_resolve(prism_gobj *o)
{
    char face[32];
    int i, style;
    if (o->resolved) return o->tt;
    o->resolved = 1;
    for (i = 0; i < 31 && o->face[i]; i++) face[i] = (char)(o->face[i] >= 'A' && o->face[i] <= 'Z' ? o->face[i] + 32 : o->face[i]);
    face[i] = 0;
    style = (o->weight >= 600 ? 1 : 0) + (o->italic ? 2 : 0);
    for (i = 0; i < (int)(sizeof prism_font_files / sizeof prism_font_files[0]); i++)
        if (!strcmp(face, prism_font_files[i][0])) {
            o->tt = font_file(prism_font_files[i][1 + style]);
            if (!o->tt) o->tt = font_file(prism_font_files[i][1]);
            return o->tt;
        }
    if (face[0] && strlen(face) < 12 && !strchr(face, ' ')) o->tt = font_file(face);
    if (!o->tt) o->tt = font_file(style & 1 ? "arialbd" : "arial");
    if (!o->tt) o->tt = font_file("arial");
    return o->tt;
}

/* A font in pixels: lfHeight < 0 is the character height (the em), > 0 the cell's; lfWidth, when set,
   the average character width, which stretches x. Ascent and descent are the font's win metrics. */
typedef struct { prism_ttf *tt; int ppem, ascent, descent, height, intLead, extLead, avg, max, weight, italic, aa, hdmx; double sx, sy; } prism_tm;
/* The hinted font's real extent at one size, as the VDMX table records it (yMax and -yMin for a ppem):
   Windows takes the ascent and descent from it where it has the size, rather than scaling the win
   metrics -- Arial at -48 is 45 + 10 pixels, not 43 + 10. The ratio group for a 1:1 device is used. */
static void vdmx_lookup(const prism_ttf *f, int ppem, int *asc, int *desc)
{
    unsigned i, nr;
    if (!f->vdmx) return;
    nr = tt_u16(f, f->vdmx + 4);
    for (i = 0; i < nr; i++) {
        long rat = f->vdmx + 6 + 4 * (long)i;
        unsigned x = tt_u8(f, rat + 1), y0 = tt_u8(f, rat + 2), y1 = tt_u8(f, rat + 3);
        long g;
        unsigned recs, k;
        if (x && !(y0 <= x && x <= y1)) continue;
        g = f->vdmx + tt_u16(f, f->vdmx + 6 + 4 * (long)nr + 2 * (long)i);
        recs = tt_u16(f, g);
        if (ppem < (int)tt_u8(f, g + 2) || ppem > (int)tt_u8(f, g + 3)) return;
        for (k = 0; k < recs; k++) {
            long e = g + 4 + 6 * (long)k;
            if ((int)tt_u16(f, e) == ppem) { *asc = tt_s16(f, e + 2); *desc = -tt_s16(f, e + 4); return; }
        }
        return;
    }
}
static int gasp_gray(const prism_ttf *f, int ppem)
{
    unsigned i, n;
    if (!f->gasp) return ppem >= 9;                       /* no table: grey above the smallest sizes */
    for (i = 0, n = tt_u16(f, f->gasp + 2); i < n; i++)
        if (ppem <= (int)tt_u16(f, f->gasp + 4 + 4 * (long)i)) return (tt_u16(f, f->gasp + 6 + 4 * (long)i) & 2) != 0;
    return 0;
}
static int font_metrics(HGDIOBJ h, prism_tm *m)
{
    prism_gobj *o = gobj_of(h);
    prism_ttf *f;
    int hh, k, num, size;
    if (!o || o->kind != GOBJ_FONT || !(f = font_resolve(o))) return 0;
    memset(m, 0, sizeof *m);
    m->tt = f;
    hh = o->height ? o->height : 16;
    m->ppem = hh < 0 ? -hh : (int)floor((double)hh * f->em / (f->winAsc + f->winDesc) + 0.5);
    if (m->ppem < 1) m->ppem = 1;
    m->sy = (double)m->ppem / f->em;
    m->sx = o->width > 0 && f->avgW > 0 ? (double)o->width / f->avgW : m->sy;
    m->ascent = (int)floor(f->winAsc * m->sy + 0.5);
    m->descent = (int)floor(f->winDesc * m->sy + 0.5);
    vdmx_lookup(f, m->ppem, &m->ascent, &m->descent);
    m->height = m->ascent + m->descent;
    m->intLead = m->height - m->ppem;
    k = f->lineGap - ((f->winAsc + f->winDesc) - (f->hAsc - f->hDesc));
    m->extLead = k > 0 ? (int)floor(k * m->sy + 0.5) : 0;
    m->avg = o->width > 0 ? o->width : (int)floor(f->avgW * m->sy + 0.5);
    m->max = (int)floor(f->bboxW * m->sx + 0.5);           /* the font's bounding box, as Wine has it */
    m->weight = o->weight ? o->weight : 400;
    m->italic = o->italic;
    /* grey edges: asked for, or -- unless NONANTIALIASED_QUALITY -- where the font's gasp table asks for
       them at this size, as XP's default font smoothing (Standard) and Wine both do */
    m->aa = o->quality == ANTIALIASED_QUALITY || (o->quality != NONANTIALIASED_QUALITY && gasp_gray(f, m->ppem));
    m->hdmx = 0;
    if (f->hdmx && m->sx == m->sy) {
        num = tt_s16(f, f->hdmx + 2); size = (int)tt_u32(f, f->hdmx + 4);
        for (k = 0; k < num; k++)
            if ((int)tt_u8(f, f->hdmx + 8 + (long)k * size) == m->ppem) { m->hdmx = (int)(f->hdmx + 8 + (long)k * size + 2); break; }
    }
    return 1;
}
static int font_advance(const prism_tm *m, unsigned g)
{
    if (m->hdmx && (int)g < m->tt->numGlyphs) return (int)tt_u8(m->tt, m->hdmx + g);
    return (int)floor(tt_advance_units(m->tt, g) * m->sx + 0.5);
}
/* An ANSI byte as Unicode: Windows-1252, whose letters are Latin-1's but for 80-9F. */
static unsigned ansi_char(unsigned char b)
{
    static const unsigned short w1252[32] = {
        0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
        0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178 };
    return b >= 0x80 && b < 0xA0 ? w1252[b - 0x80] : b;
}
static HGDIOBJ dc_font(HDC dc);
/* The DC's font as TrueType, or 0: then the VGA path answers. */
static int dc_metrics(HDC dc, prism_tm *m) { return font_metrics(dc_font(dc), m); }
static int text_extent(const prism_tm *m, const void *s, int n, int wide)
{
    int i, w = 0;
    for (i = 0; i < n; i++) {
        unsigned c = wide ? ((const unsigned short *)s)[i] : ansi_char(((const unsigned char *)s)[i]);
        w += font_advance(m, tt_map(m->tt, c));
    }
    return w;
}

/* ---- device contexts */
/* A memory DC: its bitmap (a new one has a 1x1 monochrome one, PRISM_STOCK_BITMAP, which nothing is
   drawn into), its font, colours and background mode, Windows' defaults: black on white, OPAQUE. */
HDC WINAPI CreateCompatibleDC(HDC dc)
{
    int i;
    (void)dc;
    for (i = 0; i < 32; i++) if (!prism_mdcs[i].h) {
        prism_mdcs[i].h = (HDC)(ULONG_PTR)(PRISM_MDC_TAG | ((unsigned)(++prism_mdc_seq & 0xff) << 8) | (unsigned)i);
        prism_mdcs[i].bitmap = PRISM_STOCK_BITMAP; prism_mdcs[i].font = PRISM_STOCK_FONT;
        prism_mdcs[i].fg = 0x00000000; prism_mdcs[i].bk = 0x00FFFFFF; prism_mdcs[i].bkmode = OPAQUE;
        return prism_mdcs[i].h;
    }
    return NEW_HANDLE(HDC);
}
BOOL WINAPI DeleteDC(HDC dc) { prism_mdc *m = mdc_of(dc); if (m) memset(m, 0, sizeof *m); return 1; }
/* The font a DC that is not a memory DC (the window's, the screen's) has selected: one for all. */
static HGDIOBJ prism_wdc_font = PRISM_STOCK_FONT;
static HGDIOBJ dc_font(HDC dc) { prism_mdc *m = mdc_of(dc); return m ? m->font : prism_wdc_font; }
/*
 * SelectObject REMEMBERS, at least the brush.
 *
 * Rectangle fills with the SELECTED BRUSH and outlines with the selected pen -- it does not use the
 * text colour, which is what this drew with while SelectObject returned its argument and kept
 * nothing. PuTTY paints the area around its terminal with Rectangle, so the whole window came out in
 * the foreground colour: 187,187,187 where it should have been black.
 *
 * One brush for all device contexts, like the surface: this program has one window.
 */
/* A new DC's brush is WHITE_BRUSH (and its pen BLACK_PEN): an unset one was black, and filled every
   Rectangle solid. */
static HBRUSH prism_brush = (HBRUSH)(ULONG_PTR)(PRISM_BRUSH_TAG | 0x00FFFFFF);
static COLORREF brush_colour(HBRUSH b);

HGDIOBJ WINAPI SelectObject(HDC dc, HGDIOBJ obj)
{
    HGDIOBJ old = obj;
    prism_mdc *m = mdc_of(dc);
    prism_gobj *o = gobj_of(obj);
    if (PRISM_IS_BRUSH(obj)) { old = (HGDIOBJ)prism_brush; prism_brush = (HBRUSH)obj; }
    else if (o && o->kind == GOBJ_FONT) {
        if (m) { old = m->font; m->font = obj; } else { old = prism_wdc_font; prism_wdc_font = obj; }
    } else if (m && ((o && o->kind == GOBJ_BITMAP) || obj == PRISM_STOCK_BITMAP)) { old = m->bitmap; m->bitmap = obj; }
    return old;
}
/* GetDeviceCaps lives in win32.c, which already answers for the screen. */
int WINAPI SetMapMode(HDC dc, int mode) { (void)dc; (void)mode; return 1; }
int WINAPI SetBkMode(HDC dc, int mode) { prism_mdc *m = mdc_of(dc); int o; if (!m) return 1; o = m->bkmode; m->bkmode = mode; return o; }
int WINAPI GetBkMode(HDC dc) { prism_mdc *m = mdc_of(dc); return m ? m->bkmode : 2; }
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
/* A font is its LOGFONT, kept; which file it is gets decided at its first use (font_resolve). */
static HFONT font_new(int h, int w, int wt, int it, int q, const char *face, const unsigned short *wface)
{
    prism_gobj *o = gobj_new(GOBJ_FONT);
    int i;
    if (!o) return NEW_HANDLE(HFONT);
    o->height = h; o->width = w < 0 ? -w : w; o->weight = wt; o->italic = it != 0; o->quality = q;
    for (i = 0; i < 31; i++) {
        unsigned c = face ? (unsigned char)face[i] : wface ? wface[i] : 0;
        if (!c) break;
        o->face[i] = (char)(c < 128 ? c : '?');
    }
    o->face[i] = 0;
    return (HFONT)o->h;
}
HFONT WINAPI CreateFontIndirect(const LOGFONT *lf)
{ return lf ? font_new(lf->lfHeight, lf->lfWidth, lf->lfWeight, lf->lfItalic, lf->lfQuality, lf->lfFaceName, 0) : 0; }
HFONT WINAPI CreateFontIndirectW(const LOGFONTW *lf)
{ return lf ? font_new(lf->lfHeight, lf->lfWidth, lf->lfWeight, lf->lfItalic, lf->lfQuality, 0, (const unsigned short *)lf->lfFaceName) : 0; }
HFONT WINAPI CreateFont(int h, int w, int e, int o, int wt, DWORD it, DWORD un, DWORD st,
                        DWORD cs, DWORD op, DWORD cp, DWORD q, DWORD pf, LPCSTR face)
{
    (void)e; (void)o; (void)un; (void)st; (void)cs; (void)op; (void)cp; (void)pf;
    return font_new(h, w, wt, (int)it, (int)q, face, 0);
}
HPEN WINAPI CreatePen(int style, int w, COLORREF c) { (void)style; (void)w; (void)c; return NEW_HANDLE(HPEN); }
HBRUSH WINAPI CreateSolidBrush(COLORREF c) { return (HBRUSH)(ULONG_PTR)(PRISM_BRUSH_TAG | (c & 0x00FFFFFF)); }
HBITMAP WINAPI CreateBitmap(int w, int h, UINT pl, UINT bits, const void *d)
{ (void)w; (void)h; (void)pl; (void)bits; (void)d; return NEW_HANDLE(HBITMAP); }
/* A memory bitmap: 32 bits a pixel, rows top-down, black. Screen-compatible, as the screen is 32-bit. */
HBITMAP WINAPI CreateCompatibleBitmap(HDC dc, int w, int h)
{
    prism_gobj *o;
    (void)dc;
    if (w <= 0 || h <= 0 || !(o = gobj_new(GOBJ_BITMAP))) return NEW_HANDLE(HBITMAP);
    o->bm.bits = (unsigned char *)calloc((size_t)w * (size_t)h, 4);
    o->bm.w = w; o->bm.h = h; o->bm.pitch = 4 * w; o->bm.bpp = 32; o->bm.topdown = 1;
    o->owned = 1;
    return (HBITMAP)o->h;
}
int WINAPI GetObject(HGDIOBJ h, int n, void *out)
{
    prism_gobj *o = gobj_of(h);
    if (o && o->kind == GOBJ_BITMAP && out && n >= (int)sizeof(BITMAP)) {
        BITMAP *b = (BITMAP *)out;
        memset(b, 0, sizeof *b);
        b->bmWidth = o->bm.w; b->bmHeight = o->bm.h; b->bmWidthBytes = o->bm.pitch;
        b->bmPlanes = 1; b->bmBitsPixel = (WORD)o->bm.bpp; b->bmBits = o->owned ? 0 : o->bm.bits;
        return sizeof(BITMAP);
    }
    if (out) memset(out, 0, n);
    return n;
}
/*
 * A bitmap's pixels to and from a DIB (GetDIBits, SetDIBits): 32- or 24-bit, biHeight < 0 top-down,
 * rows padded to a DWORD. Lines start..start+lines-1 counted from the bottom, as Windows counts them
 * for a bottom-up DIB. Other depths and palettes are not modelled: 0, which is GDI's failure.
 */
static int dib_copy(HBITMAP hb, UINT start, UINT lines, void *bits, const BITMAPINFO *bmi, int toBitmap)
{
    prism_gobj *o = gobj_of(hb);
    int w, h, bpp, pitch, topdown, n, r, x;
    if (!o || o->kind != GOBJ_BITMAP || !bmi) return 0;
    w = (int)bmi->bmiHeader.biWidth; h = (int)bmi->bmiHeader.biHeight; bpp = bmi->bmiHeader.biBitCount;
    topdown = h < 0; if (h < 0) h = -h;
    if (!bits) return h;                          /* GetDIBits asked only for the header */
    if ((bpp != 24 && bpp != 32) || w != o->bm.w || (o->bm.bpp != 24 && o->bm.bpp != 32)) return 0;
    pitch = ((w * bpp + 31) / 32) * 4;
    n = (int)lines; if ((int)start + n > h) n = h - (int)start; if (n > o->bm.h) n = o->bm.h;
    for (r = 0; r < n; r++) {
        int dibRow = topdown ? (int)start + r : h - 1 - ((int)start + r);   /* row in memory order */
        int imgY = topdown ? (int)start + r : o->bm.h - 1 - ((int)start + r); /* the picture's row, top 0 */
        unsigned char *d = (unsigned char *)bits + (long)dibRow * pitch;
        unsigned char *s = o->bm.bits + (long)(o->bm.topdown ? imgY : o->bm.h - 1 - imgY) * o->bm.pitch;
        if (imgY < 0 || imgY >= o->bm.h) continue;
        for (x = 0; x < w; x++) {
            unsigned char *a = s + x * (o->bm.bpp / 8), *b = d + x * (bpp / 8);
            if (toBitmap) { a[0] = b[0]; a[1] = b[1]; a[2] = b[2]; if (o->bm.bpp == 32) a[3] = bpp == 32 ? b[3] : 0; }
            else { b[0] = a[0]; b[1] = a[1]; b[2] = a[2]; if (bpp == 32) b[3] = o->bm.bpp == 32 ? a[3] : 0; }
        }
    }
    return n;
}
int WINAPI GetDIBits(HDC dc, HBITMAP bm, UINT start, UINT lines, LPVOID bits, struct tagBITMAPINFO *bmi, UINT usage)
{ (void)dc; (void)usage; return dib_copy(bm, start, lines, bits, bmi, 0); }
int WINAPI SetDIBits(HDC dc, HBITMAP bm, UINT start, UINT lines, const void *bits, const struct tagBITMAPINFO *bmi, UINT usage)
{ (void)dc; (void)usage; return bits ? dib_copy(bm, start, lines, (void *)bits, bmi, 1) : 0; }

/* ---- text metrics: a TrueType font's when the DC has one (font_metrics), else the decision
   documented at the top */
BOOL WINAPI GetTextMetrics(HDC dc, LPTEXTMETRIC tm)
{
    prism_tm m;
    if (!tm) return 0;
    if (dc_metrics(dc, &m)) {
        memset(tm, 0, sizeof(*tm));
        tm->tmHeight = m.height; tm->tmAscent = m.ascent; tm->tmDescent = m.descent;
        tm->tmInternalLeading = m.intLead; tm->tmExternalLeading = m.extLead;
        tm->tmAveCharWidth = m.avg; tm->tmMaxCharWidth = m.max; tm->tmWeight = m.weight;
        tm->tmItalic = (BYTE)m.italic;
        tm->tmDigitizedAspectX = tm->tmDigitizedAspectY = 96;
        tm->tmFirstChar = 30; tm->tmLastChar = 255; tm->tmDefaultChar = 31; tm->tmBreakChar = 32;
        tm->tmPitchAndFamily = TMPF_FIXED_PITCH | TMPF_VECTOR | TMPF_TRUETYPE;   /* "fixed" set means variable */
        return 1;
    }
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
{
    prism_tm m;
    if (dc_metrics(dc, &m)) { if (sz) { sz->cx = text_extent(&m, s, n, 0); sz->cy = m.height; } return 1; }
    (void)s; if (sz) { sz->cx = n * PRISM_FONT_W; sz->cy = PRISM_FONT_H; } return 1;
}
BOOL WINAPI GetTextExtentPoint32W(HDC dc, LPCWSTR s, int n, SIZE *sz)
{
    prism_tm m;
    if (dc_metrics(dc, &m)) { if (sz) { sz->cx = text_extent(&m, s, n, 1); sz->cy = m.height; } return 1; }
    (void)s; if (sz) { sz->cx = n * PRISM_FONT_W; sz->cy = PRISM_FONT_H; } return 1;
}
/* ABC widths as GetGlyphOutline's metrics give them: A the black box's left (whole pixels), B its
   width -- at least 1, a blank glyph's too, as Windows has it -- and C the rest of the advance. */
static void char_abc(const prism_tm *m, unsigned c, ABC *abc)
{
    unsigned g = tt_map(m->tt, c);
    int adv = font_advance(m, g), x0, x1;
    tt_outline(m->tt, g, m->sx, m->sy);
    if (tt_npts) { x0 = (int)floor(tt_minx); x1 = (int)ceil(tt_maxx); } else x0 = x1 = 0;
    if (x1 - x0 < 1) x1 = x0 + 1;
    abc->abcA = x0; abc->abcB = (UINT)(x1 - x0); abc->abcC = adv - x1;
}
BOOL WINAPI GetCharABCWidths(HDC dc, UINT first, UINT last, LPABC out)
{
    prism_tm m;
    UINT c;
    if (!out) return 0;
    if (!dc_metrics(dc, &m)) {
        for (c = first; c <= last; c++) { out[c - first].abcA = 0; out[c - first].abcB = PRISM_FONT_W; out[c - first].abcC = 0; }
        return 1;
    }
    for (c = first; c <= last; c++) char_abc(&m, c < 256 ? ansi_char((unsigned char)c) : c, &out[c - first]);
    return 1;
}
BOOL WINAPI GetTextExtentExPoint(HDC dc, LPCSTR s, int n, int maxext, INT *fit, INT *dx, SIZE *sz)
{
    int i;
    (void)dc; (void)s;
    if (dx) for (i = 0; i < n; i++) dx[i] = (i + 1) * PRISM_FONT_W;
    if (fit) *fit = maxext / PRISM_FONT_W < n ? maxext / PRISM_FONT_W : n;
    if (sz) { sz->cx = n * PRISM_FONT_W; sz->cy = PRISM_FONT_H; }
    return 1;
}
static BOOL widths(HDC dc, UINT first, UINT last, INT *out, int wide)
{
    UINT c;
    prism_tm m;
    int tt = dc_metrics(dc, &m);
    if (!out) return 0;
    for (c = first; c <= last; c++)
        out[c - first] = tt ? font_advance(&m, tt_map(m.tt, wide || c > 255 ? c : ansi_char((unsigned char)c))) : PRISM_FONT_W;
    return 1;
}
BOOL WINAPI GetCharWidth(HDC dc, UINT f, UINT l, INT *o) { return widths(dc, f, l, o, 0); }
BOOL WINAPI GetCharWidthW(HDC dc, UINT f, UINT l, INT *o) { return widths(dc, f, l, o, 1); }
BOOL WINAPI GetCharWidth32(HDC dc, UINT f, UINT l, INT *o) { return widths(dc, f, l, o, 0); }
BOOL WINAPI GetCharWidth32W(HDC dc, UINT f, UINT l, INT *o) { return widths(dc, f, l, o, 1); }
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
 * Pixels are four bytes, B G R A -- the page's 32-bit format, as every host publishes -- which spares
 * everyone a palette. COLORREF is 0x00bbggrr, so the channels are taken out of it in reverse.
 */
const unsigned char *prism_vga_font = 0;

int prism_gdi_w, prism_gdi_h, prism_gdi_pitch;
unsigned char *prism_gdi_surface;
int prism_gdi_draws;                    /* how many glyph cells have been written, for a harness */

/* A new DC writes black text on white (SetTextColor, SetBkColor): Windows' defaults. Light grey on
   black was a terminal's, and a program that never set colours wrote grey on its white window. */
static COLORREF prism_fg = 0x00000000;
static COLORREF prism_bk = 0x00FFFFFF;

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
    /* B, G, R, A: the page's 32-bit format (PIXFMT 32), as every host publishes it. COLORREF is
       0x00bbggrr. Written R first, every colour came out with red and blue exchanged. */
    p[0] = (unsigned char)((c >> 16) & 0xFF);
    p[1] = (unsigned char)((c >> 8) & 0xFF);
    p[2] = (unsigned char)(c & 0xFF);
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

/*
 * Text in a TrueType font into the memory DC's bitmap: the pen at (x, y), the cell's top (TA_TOP, the
 * default; SetTextAlign is not kept), each glyph at the baseline. OPAQUE fills the cells with the
 * background colour first, ETO_OPAQUE the rectangle. A DC with no bitmap but the stock one draws
 * nothing, as a 1x1 monochrome bitmap would show nothing.
 */
static BOOL tt_textout(HDC dc, const prism_tm *m, int x, int y, UINT opts, const RECT *r, const void *str, UINT n, const INT *dx, int wide)
{
    prism_mdc *md = mdc_of(dc);
    prism_gobj *o = md ? gobj_of(md->bitmap) : 0;
    UINT i;
    int pen = 0;
    if (!o || o->kind != GOBJ_BITMAP || !o->bm.bits || (o->bm.bpp != 32 && o->bm.bpp != 24)) return 1;
    if ((opts & ETO_OPAQUE) && r) tt_rect(&o->bm, r->left, r->top, r->right, r->bottom, md->bk);
    if (md->bkmode == OPAQUE) tt_rect(&o->bm, x, y, x + (dx ? 0 : text_extent(m, str, (int)n, wide)), y + m->height, md->bk);
    for (i = 0; i < n; i++) {
        unsigned c = wide ? ((const unsigned short *)str)[i] : ansi_char(((const unsigned char *)str)[i]);
        unsigned g = tt_map(m->tt, c);
        tt_outline(m->tt, g, m->sx, m->sy);
        tt_fill(&o->bm, (float)(x + pen), (float)(y + m->ascent), md->fg, m->aa);
        pen += dx ? dx[i] : font_advance(m, g);
    }
    prism_gdi_draws++;
    return 1;
}
BOOL WINAPI ExtTextOut(HDC dc, int x, int y, UINT o, const RECT *r, LPCSTR s, UINT n, const INT *dx)
{ prism_tm m; if (dc_metrics(dc, &m)) return tt_textout(dc, &m, x, y, o, r, s, n, dx, 0); return prism_textout(x, y, o, r, s, n, dx, 0); }
BOOL WINAPI ExtTextOutW(HDC dc, int x, int y, UINT o, const RECT *r, LPCWSTR s, UINT n, const INT *dx)
{ prism_tm m; if (dc_metrics(dc, &m)) return tt_textout(dc, &m, x, y, o, r, s, n, dx, 1); return prism_textout(x, y, o, r, s, n, dx, 1); }
BOOL WINAPI TextOut(HDC dc, int x, int y, LPCSTR s, int n)
{ return ExtTextOut(dc, x, y, 0, NULL, s, (UINT)n, NULL); }

/* A memory DC keeps its own colours; the window's are the surface's, shared by every other DC. */
COLORREF WINAPI SetTextColor(HDC dc, COLORREF c)
{ prism_mdc *m = mdc_of(dc); COLORREF o; if (m) { o = m->fg; m->fg = c; return o; } o = prism_fg; prism_fg = c; return o; }
COLORREF WINAPI SetBkColor(HDC dc, COLORREF c)
{ prism_mdc *m = mdc_of(dc); COLORREF o; if (m) { o = m->bk; m->bk = c; return o; } o = prism_bk; prism_bk = c; return o; }

BOOL WINAPI LineTo(HDC dc, int x, int y) { (void)dc; (void)x; (void)y; return 1; }
BOOL WINAPI MoveToEx(HDC dc, int x, int y, POINT *old) { (void)dc; (void)x; (void)y; (void)old; return 1; }
BOOL WINAPI Polyline(HDC dc, const POINT *p, int n) { (void)dc; (void)p; (void)n; return 1; }
/* The outline in the pen (BLACK_PEN, one pixel: pens are not modelled), the inside in the brush. */
BOOL WINAPI Rectangle(HDC dc, int l, int t, int r, int b)
{
    (void)dc;
    if (r - l < 2 || b - t < 2) { prism_fill(l, t, r, b, 0); return 1; }
    prism_fill(l, t, r, t + 1, 0); prism_fill(l, b - 1, r, b, 0);
    prism_fill(l, t, l + 1, b, 0); prism_fill(r - 1, t, r, b, 0);
    prism_fill(l + 1, t + 1, r - 1, b - 1, brush_colour(prism_brush));
    return 1;
}
COLORREF WINAPI SetPixel(HDC dc, int x, int y, COLORREF c) { (void)dc; prism_pixel(x, y, c); return c; }
COLORREF WINAPI GetPixel(HDC dc, int x, int y) { (void)dc; (void)x; (void)y; return 0; }

/* A brush carries its colour in the handle; anything else is not one, and falls back to the
   background, which is what an unrecognised brush would most nearly be. */
static COLORREF brush_colour(HBRUSH b)
{
    /* A class's hbrBackground is usually a SYSTEM colour, COLOR_x + 1 (what Windows documents). */
    if ((ULONG_PTR)b >= 1 && (ULONG_PTR)b <= 31) return GetSysColor((int)(ULONG_PTR)b - 1);
    return PRISM_IS_BRUSH(b) ? (COLORREF)((ULONG_PTR)b & 0x00FFFFFF) : prism_bk;
}

int WINAPI FillRect(HDC dc, const RECT *r, HBRUSH b)
{
    (void)dc;
    if (r) prism_fill(r->left, r->top, r->right, r->bottom, brush_colour(b));
    return 1;
}
/* BeginPaint's background erase (src/env/win32.c), now that there is a raster to erase. */
void prism_win32_erase(HDC dc, const RECT *r, HBRUSH b) { FillRect(dc, r, b); }
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
/* GetSysColor is win32.c's: the system colours are storage there (rw_dib.c sets and restores them). */
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

/* A deleted bitmap frees the pixels it allocated (a DIB section's are the program's); fonts are
   kept by file, so a font object only gives back its slot. */
BOOL WINAPI DeleteObject(HGDIOBJ h)
{
    prism_gobj *o = gobj_of(h);
    if (o) { if (o->owned) free(o->bm.bits); memset(o, 0, sizeof *o); }
    return 1;
}
/* The stock brushes are colours (WHITE_BRUSH 0 to BLACK_BRUSH 4); the other stock objects, handles. */
HGDIOBJ WINAPI GetStockObject(int i)
{
    static const COLORREF stock[5] = { 0x00FFFFFF, 0x00C0C0C0, 0x00808080, 0x00404040, 0x00000000 };
    if (i >= 0 && i < 5) return (HGDIOBJ)CreateSolidBrush(stock[i]);
    return NEW_HANDLE(HGDIOBJ);
}

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
ATOM WINAPI RegisterClassExA(const WNDCLASSEXA *c)
{
    WNDCLASSA a;
    if (!c) return 0;
    a.style = c->style; a.lpfnWndProc = c->lpfnWndProc;
    a.cbClsExtra = c->cbClsExtra; a.cbWndExtra = c->cbWndExtra;
    a.hInstance = c->hInstance; a.hIcon = c->hIcon; a.hCursor = c->hCursor;
    a.hbrBackground = c->hbrBackground; a.lpszMenuName = c->lpszMenuName; a.lpszClassName = c->lpszClassName;
    return RegisterClass(&a);
}
ATOM WINAPI RegisterClassEx(const WNDCLASSEX *c) { return RegisterClassExA(c); }
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
