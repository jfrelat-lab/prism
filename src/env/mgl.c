/*
 * mgl.c -- SciTech MGL, in C.
 *
 * An environment shim like src/env/allegro.js, src/env/sdl2.js and src/env/x11.js, and named after
 * the LIBRARY for the same reason they are: it implements somebody else's published API, not one
 * program's needs. WinQuake is simply the program that asks for it first, and what is implemented
 * is what a caller actually calls -- the same rule every other shim here follows.
 *
 * It is the only one written in C rather than JavaScript, and that is deliberate; see below.
 *
 * MGL is the one dependency of WinQuake that is not in the box: `scitech/INCLUDE` ships the headers
 * and `MGLLT.LIB` holds the code, and that library is a binary. It is exactly MAME's relationship
 * with Allegro -- the program compiles, and thirty-four names are left over.
 *
 * WRITTEN IN C, AND THAT IS THE POINT. A JavaScript shim would have to know where `surface` and
 * `mi.bytesPerLine` sit inside `publicDevCtx_t`, and getting an offset wrong there is silent: the
 * xkey.keycode bug in src/env/x11.js sat at byte 36 instead of 52 for as long as it did because
 * nothing about a wrong offset announces itself. That struct is PUBLIC and SHIPPED, so compiling
 * against it makes the layout the compiler's problem, which is where it belongs.
 *
 * What Quake actually needs from MGL, from vid_win.c:
 *
 *     dibdc = MGL_createMemoryDC(DIBWidth, DIBHeight, 8, &pf);
 *     vid.buffer = vid.conbuffer = vid.direct = dibdc->surface;      // line 1351
 *     vid.rowbytes = vid.conrowbytes = dibdc->mi.bytesPerLine;
 *
 * -- a memory surface to render into, and a blit to present it. So this is the same
 * "publish what the program already writes" arrangement as every other PRISM target: the harness
 * reads `vid.buffer`, and `MGL_bitBltCoord` is the frame boundary, the way `XPutImage` is for an X
 * client.
 *
 * Only the WINDOWED path is implemented, and it says so rather than pretending: MGL_availableModes
 * returns an empty list, which is the truthful answer for a machine with no fullscreen driver, and
 * vid_win.c reads `m[0] != 0xFF` and skips its whole mode enumeration. Run with `-window`.
 */

#include <windows.h>
#include <mgraph.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

/* MGL reports the last error through MGL_result(); nothing here fails, so it stays grOK. */
static m_int mgl_lastResult = 0;                 /* grOK */
static MGLDC *mgl_current = NULL;

/*
 * The palette, kept because the harness wants it and Quake never reads it back.
 * palette_t is BGRA -- blue first -- and holds the FULL 0..255 per component: vid_win.c writes
 * `pal[i].red = palette[i*3]` with no shift, whatever the hardware behind a real MGL would do
 * with it. What the program writes is what is here.
 */
palette_t prism_mgl_palette[256];
m_int prism_mgl_frames = 0;

/*
 * The presented surface, as four plain integers.
 *
 * A harness wants the pixels, and it must not have to know where `surface` and `mi.bytesPerLine` sit
 * inside publicDevCtx_t -- that knowledge is why this file is in C at all, and re-deriving it in
 * JavaScript would put it back where it does not belong. So the blit publishes what it just showed,
 * the same move every other PRISM target makes: the program says where its picture is.
 */
void  *prism_mgl_surface = 0;
m_int  prism_mgl_width = 0;
m_int  prism_mgl_height = 0;
m_int  prism_mgl_pitch = 0;

/*
 * A device context plus its surface, allocated together so one free releases both. The public part
 * of the struct is what the game sees; anything after it is ours, which is exactly the contract
 * publicDevCtx_t states ("Remainder of Device Context structure is private and internal").
 */
typedef struct {
    MGLDC   pub;
    void   *owned;          /* the surface this DC allocated, or NULL for a windowed one */
} prism_dc_t;

static MGLDC *makeDC(m_int xSize, m_int ySize, m_int bits, void *surface)
{
    prism_dc_t *d = (prism_dc_t *)calloc(1, sizeof(prism_dc_t));
    if (!d) return NULL;
    /* xRes and yRes are resolution MINUS ONE -- see gmode_t in mgraph.h, and MGL_sizex below. */
    d->pub.mi.xRes = xSize - 1;
    d->pub.mi.yRes = ySize - 1;
    d->pub.mi.bitsPerPixel = bits;
    d->pub.mi.numberOfPlanes = 1;
    d->pub.mi.maxColor = 255;
    d->pub.mi.maxPage = 0;
    d->pub.mi.bytesPerLine = xSize * ((bits + 7) / 8);
    d->pub.mi.aspectRatio = 1000;
    d->pub.mi.pageSize = (long)d->pub.mi.bytesPerLine * ySize;
    d->pub.surface = surface;
    d->owned = surface;
    return &d->pub;
}

bool MGL_init(m_int *driver, m_int *mode, const char *mglpath)
{
    (void)mglpath;
    if (driver) *driver = 0;
    if (mode) *mode = 0;
    return true;
}

bool MGL_initWindowed(const char *mglpath) { (void)mglpath; return true; }
void MGL_exit(void) { mgl_current = NULL; }

m_int MGL_registerDriver(const char *name, void *driver) { (void)name; (void)driver; return 0; }
void MGL_unregisterAllDrivers(void) { }
void MGL_detectGraph(m_int *driver, m_int *mode) { if (driver) *driver = 0; if (mode) *mode = 0; }

/*
 * No fullscreen modes. The list is terminated by 0xFF and vid_win.c:411 tests `m[0] != 0xFF` before
 * enumerating anything, so an empty list is not a refusal -- it is the answer a machine with no
 * fullscreen driver gives, and the game has a windowed path for exactly that.
 */
static uchar mgl_modes[1] = { 0xFF };
uchar *MGL_availableModes(void) { return mgl_modes; }

m_int MGL_availablePages(m_int mode) { (void)mode; return 1; }

m_int MGL_modeResolution(m_int mode, m_int *xRes, m_int *yRes, m_int *bitsPerPixel)
{
    (void)mode;
    if (xRes) *xRes = 0;
    if (yRes) *yRes = 0;
    if (bitsPerPixel) *bitsPerPixel = 0;
    return 0;
}

const char *MGL_modeDriverName(m_int mode) { (void)mode; return "PRISM"; }
/*
 * grWINDOWED is not a display mode, it is the request to LEAVE one -- vid_win.c calls
 * `MGL_changeDisplayMode(grWINDOWED)` at the top of VID_SetWindowedMode and calls initFatalError if
 * it fails. Refusing everything uniformly therefore killed the windowed path, which is the only one
 * this build has. A real fullscreen mode is still refused, because there is none.
 */
bool MGL_changeDisplayMode(m_int mode) { return mode == grWINDOWED; }

MGLDC *MGL_createDisplayDC(m_int numBuffers) { (void)numBuffers; return NULL; }

MGLDC *MGL_createMemoryDC(m_int xSize, m_int ySize, m_int bitsPerPixel, pixel_format_t *pf)
{
    void *surface;
    MGLDC *dc;
    (void)pf;
    surface = calloc((size_t)xSize * ySize * ((bitsPerPixel + 7) / 8), 1);
    if (!surface) return NULL;
    dc = makeDC(xSize, ySize, bitsPerPixel, surface);
    if (!dc) { free(surface); return NULL; }
    return dc;
}

/*
 * The windowed DC is the PRESENTATION target, not a drawing one: Quake renders into the memory DC
 * and blits here. It gets no surface, and MGL_surfaceAccessType therefore answers MGL_NO_ACCESS,
 * which is what keeps vid_win.c on its blitting path rather than its direct-access one.
 */
MGLDC *MGL_createWindowedDC(MGL_HWND hwnd) { (void)hwnd; return makeDC(1, 1, 8, NULL); }

bool MGL_destroyDC(MGLDC *dc)
{
    prism_dc_t *d = (prism_dc_t *)dc;
    if (!d) return false;
    if (mgl_current == dc) mgl_current = NULL;
    if (d->owned) free(d->owned);
    free(d);
    return true;
}

MGLDC *MGL_makeCurrentDC(MGLDC *dc) { MGLDC *was = mgl_current; mgl_current = dc; return was; }

m_int MGL_surfaceAccessType(MGLDC *dc)
{
    return (dc && dc->surface) ? MGL_LINEAR_ACCESS : MGL_NO_ACCESS;
}

m_int MGL_sizex(MGLDC *dc) { return dc ? dc->mi.xRes : 0; }
m_int MGL_sizey(MGLDC *dc) { return dc ? dc->mi.yRes : 0; }

/* Bank switching, on a linear surface. There is nothing to switch. */
void MGL_beginDirectAccess(void) { }
void MGL_endDirectAccess(void) { }

static void blit(MGLDC *dst, MGLDC *src, m_int left, m_int top, m_int right, m_int bottom,
                 m_int dstLeft, m_int dstTop)
{
    m_int y, w, h;
    if (!dst || !src || !src->surface) return;
    prism_mgl_frames++;
    prism_mgl_surface = src->surface;
    prism_mgl_width = src->mi.xRes + 1;
    prism_mgl_height = src->mi.yRes + 1;
    prism_mgl_pitch = src->mi.bytesPerLine;
    if (!dst->surface) return;                   /* the window: the harness reads vid.buffer */
    w = right - left;
    h = bottom - top;
    for (y = 0; y < h; y++) {
        memcpy((uchar *)dst->surface + (long)(dstTop + y) * dst->mi.bytesPerLine + dstLeft,
               (uchar *)src->surface + (long)(top + y) * src->mi.bytesPerLine + left,
               (size_t)w);
    }
}

void MGL_bitBltCoord(MGLDC *dst, MGLDC *src, m_int left, m_int top, m_int right, m_int bottom,
                     m_int dstLeft, m_int dstTop, m_int op)
{
    (void)op;
    blit(dst, src, left, top, right, bottom, dstLeft, dstTop);
}

/*
 * The stretched blit is the same frame, scaled. Quake uses it for its 2x windowed modes; the source
 * rectangle is what it drew, so counting the frame and copying unscaled where a destination surface
 * exists keeps the semantics that matter here -- the harness reads the SOURCE.
 */
void MGL_stretchBltCoord(MGLDC *dst, MGLDC *src, m_int left, m_int top, m_int right, m_int bottom,
                         m_int dstLeft, m_int dstTop, m_int dstRight, m_int dstBottom)
{
    (void)dstRight; (void)dstBottom;
    blit(dst, src, left, top, right, bottom, dstLeft, dstTop);
}

void MGL_setPalette(MGLDC *dc, palette_t *pal, m_int numColors, m_int startIndex)
{
    m_int i;
    (void)dc;
    if (!pal) return;
    for (i = 0; i < numColors && startIndex + i < 256; i++) {
        prism_mgl_palette[startIndex + i] = pal[i];
    }
}

void MGL_realizePalette(MGLDC *dc, m_int numColors, m_int startIndex, m_int waitVRT)
{
    (void)dc; (void)numColors; (void)startIndex; (void)waitVRT;
}

bool MGL_activatePalette(MGLDC *dc, bool unrealize) { (void)dc; (void)unrealize; return true; }
void MGL_setActivePage(MGLDC *dc, m_int page) { (void)dc; (void)page; }
void MGL_setVisualPage(MGLDC *dc, m_int page, m_int waitVRT) { (void)dc; (void)page; (void)waitVRT; }

m_int MGL_result(void) { return mgl_lastResult; }
const char *MGL_errorMsg(m_int err) { (void)err; return "no error"; }
/*
 * A fatal error EXITS. MGL's does, and a version that printed nothing and returned let vid_win.c's
 * initFatalError -- whose whole job is to stop -- fall through and carry on with a half-built
 * device context. That is the failure mode this file's own opening paragraph warns about, arrived at
 * by writing `{ }` without asking what the caller expects to happen next.
 */
void MGL_fatalError(const char *msg)
{
    fprintf(stderr, "MGL fatal error: %s\n", msg ? msg : "(none)");
    exit(1);
}

void MGL_appActivate(MGLDC *winDC, bool active) { (void)winDC; (void)active; }
void MGL_setAppInstance(MGL_HINSTANCE hInstApp) { (void)hInstApp; }
void MGL_setSuspendAppCallback(MGL_suspend_cb_t saveState) { (void)saveState; }
bool MGL_setWinDC(MGLDC *dc, MGL_HDC hdc) { (void)dc; (void)hdc; return true; }
/* MGLWIN.H's, not MGRAPH.H's: the fullscreen window registration, which this build has none of. */
void MGL_registerFullScreenWindow(MGL_HWND hwnd) { (void)hwnd; }
