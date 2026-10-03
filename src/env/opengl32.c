/*
 * opengl32.c -- opengl32.dll and the GDI pixel-format calls, for a Win32 program that draws with GL.
 *
 * GL itself is src/env/gl.js, the same layer the Linux builds draw on; what Windows adds is the way a
 * window gets a context. A program does it in four steps -- ChoosePixelFormat/SetPixelFormat on the
 * window's DC, wglCreateContext, wglMakeCurrent -- and presents a frame with SwapBuffers. Here the
 * context is the one gl.js framebuffer, sized to the window's client area when it is first made
 * current, and SwapBuffers hands the frame to the host (src/env/wgl.js).
 *
 * TWO WAYS IN, both of which id's code uses. GLQuake's gl_vidnt.c links opengl32.lib and calls wgl*
 * and gl* by name. Quake II's qgl_win.c does what a driver-selectable program does: LoadLibrary
 * ("opengl32") and GetProcAddress for every entry point, gl* AND wgl* -- so opengl32.dll exports both
 * here too, as the real one does, and the "minidriver" path (wglChoosePixelFormat...) finds them.
 * The lookup is published as prism_system_lookup, which src/env/win32-app.c reads like the module
 * table: a target that does not link this file reads it as null and LoadLibrary stays NULL.
 *
 * WHAT IS REFUSED, HONESTLY: overlay and underlay planes, shared display lists between contexts (there
 * is one), font bitmaps and outlines, and wglGetProcAddress -- gl.js advertises no extensions, so no
 * program has a name to ask for.
 */
#include <windows.h>
#include <GL/gl.h>
#include <string.h>

/* From src/env/wgl.js. */
void prism_wgl_resize(int w, int h);
void prism_wgl_swap(void);
extern int prism_win32_w, prism_win32_h;

/* ---- pixel formats. There is one: double-buffered RGBA8 with a 24-bit depth buffer, no stencil. */
static int pixel_format_set;
static void describe(PIXELFORMATDESCRIPTOR *p)
{
    memset(p, 0, sizeof *p);
    p->nSize = sizeof *p; p->nVersion = 1;
    p->dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER | PFD_SWAP_EXCHANGE;
    p->iPixelType = PFD_TYPE_RGBA; p->cColorBits = 32;
    p->cRedBits = 8; p->cRedShift = 16; p->cGreenBits = 8; p->cGreenShift = 8;
    p->cBlueBits = 8; p->cBlueShift = 0; p->cAlphaBits = 8; p->cAlphaShift = 24;
    p->cDepthBits = 24; p->iLayerType = PFD_MAIN_PLANE;
}
/* The closest format to what is asked for; with one format, it is that one for any RGBA GL request. */
int WINAPI ChoosePixelFormat(HDC dc, CONST PIXELFORMATDESCRIPTOR *want)
{
    (void)dc;
    if (!want || want->iPixelType != PFD_TYPE_RGBA || !(want->dwFlags & PFD_SUPPORT_OPENGL)) return 0;
    return 1;
}
/* Returns the number of formats; fills *p when the index names one. */
int WINAPI DescribePixelFormat(HDC dc, int n, UINT size, LPPIXELFORMATDESCRIPTOR p)
{
    (void)dc;
    if (p && n == 1 && size >= sizeof *p) describe(p);
    return 1;
}
int WINAPI GetPixelFormat(HDC dc) { (void)dc; return pixel_format_set; }
BOOL WINAPI SetPixelFormat(HDC dc, int n, CONST PIXELFORMATDESCRIPTOR *p)
{
    (void)dc; (void)p;
    if (n != 1) return FALSE;
    pixel_format_set = 1;
    return TRUE;
}
BOOL WINAPI SwapBuffers(HDC dc) { (void)dc; prism_wgl_swap(); return TRUE; }

/* ---- contexts. One framebuffer; a context is a name for it. */
static HGLRC current_rc;
static HDC current_dc;
static int contexts;
HGLRC WINAPI wglCreateContext(HDC dc)
{
    (void)dc;
    if (!pixel_format_set) return NULL;              /* SetPixelFormat comes first, as on Windows */
    return (HGLRC)(long)++contexts;
}
BOOL WINAPI wglMakeCurrent(HDC dc, HGLRC rc)
{
    if (rc) prism_wgl_resize(prism_win32_w, prism_win32_h);
    current_rc = rc; current_dc = rc ? dc : NULL;
    return TRUE;
}
BOOL WINAPI wglDeleteContext(HGLRC rc)
{
    if (!rc) return FALSE;
    if (rc == current_rc) { current_rc = NULL; current_dc = NULL; }
    return TRUE;
}
HGLRC WINAPI wglGetCurrentContext(VOID) { return current_rc; }
HDC WINAPI wglGetCurrentDC(VOID) { return current_dc; }
/* The extension functions, for the one extension gl.js advertises (GL_EXT_compiled_vertex_array). */
PROC WINAPI wglGetProcAddress(LPCSTR name)
{
    if (!strcmp(name, "glLockArraysEXT")) return (PROC)glLockArraysEXT;
    if (!strcmp(name, "glUnlockArraysEXT")) return (PROC)glUnlockArraysEXT;
    return NULL;
}
BOOL WINAPI wglCopyContext(HGLRC a, HGLRC b, UINT mask) { (void)a; (void)b; (void)mask; return FALSE; }
HGLRC WINAPI wglCreateLayerContext(HDC dc, int layer) { return layer == 0 ? wglCreateContext(dc) : NULL; }
BOOL WINAPI wglShareLists(HGLRC a, HGLRC b) { (void)a; (void)b; return FALSE; }
BOOL WINAPI wglUseFontBitmapsA(HDC dc, DWORD first, DWORD count, DWORD base) { (void)dc; (void)first; (void)count; (void)base; return FALSE; }
BOOL WINAPI wglUseFontOutlinesA(HDC dc, DWORD first, DWORD count, DWORD base, FLOAT dev, FLOAT ext, int fmt, LPGLYPHMETRICSFLOAT gm)
{ (void)dc; (void)first; (void)count; (void)base; (void)dev; (void)ext; (void)fmt; (void)gm; return FALSE; }
BOOL WINAPI wglDescribeLayerPlane(HDC dc, int fmt, int layer, UINT size, LPLAYERPLANEDESCRIPTOR p) { (void)dc; (void)fmt; (void)layer; (void)size; (void)p; return FALSE; }
int WINAPI wglSetLayerPaletteEntries(HDC dc, int layer, int start, int n, CONST COLORREF *c) { (void)dc; (void)layer; (void)start; (void)n; (void)c; return 0; }
int WINAPI wglGetLayerPaletteEntries(HDC dc, int layer, int start, int n, COLORREF *c) { (void)dc; (void)layer; (void)start; (void)n; (void)c; return 0; }
BOOL WINAPI wglRealizeLayerPalette(HDC dc, int layer, BOOL on) { (void)dc; (void)layer; (void)on; return FALSE; }
BOOL WINAPI wglSwapLayerBuffers(HDC dc, UINT planes)
{
    if (!(planes & WGL_SWAP_MAIN_PLANE)) return FALSE;
    return SwapBuffers(dc);
}
/* The minidriver entry points: on a real ICD opengl32.dll forwards these to GDI's. */
int WINAPI wglChoosePixelFormat(HDC dc, CONST PIXELFORMATDESCRIPTOR *p) { return ChoosePixelFormat(dc, p); }
int WINAPI wglDescribePixelFormat(HDC dc, int n, UINT size, LPPIXELFORMATDESCRIPTOR p) { return DescribePixelFormat(dc, n, size, p); }
int WINAPI wglGetPixelFormat(HDC dc) { return GetPixelFormat(dc); }
BOOL WINAPI wglSetPixelFormat(HDC dc, int n, CONST PIXELFORMATDESCRIPTOR *p) { return SetPixelFormat(dc, n, p); }
BOOL WINAPI wglSwapBuffers(HDC dc) { return SwapBuffers(dc); }

/*
 * ---- the DLL's exports. Every OpenGL 1.1 entry point the gl.h here declares (the list is that
 * header's, generated from it), then the wgl ones. Addresses are taken at run time, on the first
 * lookup, because gl.js's functions exist only once the environment is installed.
 */
static const char opengl32_dll[] = "opengl32.dll";
static const char *const names[] = {
    "glAccum",
    "glAlphaFunc",
    "glAreTexturesResident",
    "glArrayElement",
    "glBegin",
    "glBindTexture",
    "glBitmap",
    "glBlendFunc",
    "glCallList",
    "glCallLists",
    "glClear",
    "glClearAccum",
    "glClearColor",
    "glClearDepth",
    "glClearIndex",
    "glClearStencil",
    "glClipPlane",
    "glColor3b",
    "glColor3bv",
    "glColor3d",
    "glColor3dv",
    "glColor3f",
    "glColor3fv",
    "glColor3i",
    "glColor3iv",
    "glColor3s",
    "glColor3sv",
    "glColor3ub",
    "glColor3ubv",
    "glColor3ui",
    "glColor3uiv",
    "glColor3us",
    "glColor3usv",
    "glColor4b",
    "glColor4bv",
    "glColor4d",
    "glColor4dv",
    "glColor4f",
    "glColor4fv",
    "glColor4i",
    "glColor4iv",
    "glColor4s",
    "glColor4sv",
    "glColor4ub",
    "glColor4ubv",
    "glColor4ui",
    "glColor4uiv",
    "glColor4us",
    "glColor4usv",
    "glColorMask",
    "glColorMaterial",
    "glColorPointer",
    "glCopyPixels",
    "glCopyTexImage1D",
    "glCopyTexImage2D",
    "glCopyTexSubImage1D",
    "glCopyTexSubImage2D",
    "glCullFace",
    "glDeleteLists",
    "glDeleteTextures",
    "glDepthFunc",
    "glDepthMask",
    "glDepthRange",
    "glDisable",
    "glDisableClientState",
    "glDrawArrays",
    "glDrawBuffer",
    "glDrawElements",
    "glDrawPixels",
    "glEdgeFlag",
    "glEdgeFlagPointer",
    "glEdgeFlagv",
    "glEnable",
    "glEnableClientState",
    "glEnd",
    "glEndList",
    "glEvalCoord1d",
    "glEvalCoord1dv",
    "glEvalCoord1f",
    "glEvalCoord1fv",
    "glEvalCoord2d",
    "glEvalCoord2dv",
    "glEvalCoord2f",
    "glEvalCoord2fv",
    "glEvalMesh1",
    "glEvalMesh2",
    "glEvalPoint1",
    "glEvalPoint2",
    "glFeedbackBuffer",
    "glFinish",
    "glFlush",
    "glFogf",
    "glFogfv",
    "glFogi",
    "glFogiv",
    "glFrontFace",
    "glFrustum",
    "glGenLists",
    "glGenTextures",
    "glGetBooleanv",
    "glGetClipPlane",
    "glGetDoublev",
    "glGetError",
    "glGetFloatv",
    "glGetIntegerv",
    "glGetLightfv",
    "glGetLightiv",
    "glGetMapdv",
    "glGetMapfv",
    "glGetMapiv",
    "glGetMaterialfv",
    "glGetMaterialiv",
    "glGetPixelMapfv",
    "glGetPixelMapuiv",
    "glGetPixelMapusv",
    "glGetPointerv",
    "glGetPolygonStipple",
    "glGetString",
    "glGetTexEnvfv",
    "glGetTexEnviv",
    "glGetTexGendv",
    "glGetTexGenfv",
    "glGetTexGeniv",
    "glGetTexImage",
    "glGetTexParameterfv",
    "glGetTexParameteriv",
    "glHint",
    "glIndexMask",
    "glIndexPointer",
    "glIndexd",
    "glIndexdv",
    "glIndexf",
    "glIndexfv",
    "glIndexi",
    "glIndexiv",
    "glIndexs",
    "glIndexsv",
    "glIndexub",
    "glIndexubv",
    "glInitNames",
    "glInterleavedArrays",
    "glIsEnabled",
    "glIsList",
    "glIsTexture",
    "glLightModelf",
    "glLightModelfv",
    "glLightModeli",
    "glLightModeliv",
    "glLightf",
    "glLightfv",
    "glLighti",
    "glLightiv",
    "glLineStipple",
    "glLineWidth",
    "glListBase",
    "glLoadIdentity",
    "glLoadMatrixd",
    "glLoadMatrixf",
    "glLoadName",
    "glLogicOp",
    "glMap1d",
    "glMap1f",
    "glMap2d",
    "glMap2f",
    "glMapGrid1d",
    "glMapGrid1f",
    "glMapGrid2d",
    "glMapGrid2f",
    "glMaterialf",
    "glMaterialfv",
    "glMateriali",
    "glMaterialiv",
    "glMatrixMode",
    "glMultMatrixd",
    "glMultMatrixf",
    "glNewList",
    "glNormal3b",
    "glNormal3bv",
    "glNormal3d",
    "glNormal3dv",
    "glNormal3f",
    "glNormal3fv",
    "glNormal3i",
    "glNormal3iv",
    "glNormal3s",
    "glNormal3sv",
    "glNormalPointer",
    "glOrtho",
    "glPassThrough",
    "glPixelMapfv",
    "glPixelMapuiv",
    "glPixelMapusv",
    "glPixelStoref",
    "glPixelStorei",
    "glPixelTransferf",
    "glPixelTransferi",
    "glPixelZoom",
    "glPointSize",
    "glPolygonMode",
    "glPolygonOffset",
    "glPolygonStipple",
    "glPopAttrib",
    "glPopClientAttrib",
    "glPopMatrix",
    "glPopName",
    "glPrioritizeTextures",
    "glPushAttrib",
    "glPushClientAttrib",
    "glPushMatrix",
    "glPushName",
    "glRasterPos2d",
    "glRasterPos2dv",
    "glRasterPos2f",
    "glRasterPos2fv",
    "glRasterPos2i",
    "glRasterPos2iv",
    "glRasterPos2s",
    "glRasterPos2sv",
    "glRasterPos3d",
    "glRasterPos3dv",
    "glRasterPos3f",
    "glRasterPos3fv",
    "glRasterPos3i",
    "glRasterPos3iv",
    "glRasterPos3s",
    "glRasterPos3sv",
    "glRasterPos4d",
    "glRasterPos4dv",
    "glRasterPos4f",
    "glRasterPos4fv",
    "glRasterPos4i",
    "glRasterPos4iv",
    "glRasterPos4s",
    "glRasterPos4sv",
    "glReadBuffer",
    "glReadPixels",
    "glRectd",
    "glRectdv",
    "glRectf",
    "glRectfv",
    "glRecti",
    "glRectiv",
    "glRects",
    "glRectsv",
    "glRenderMode",
    "glRotated",
    "glRotatef",
    "glScaled",
    "glScalef",
    "glScissor",
    "glSelectBuffer",
    "glShadeModel",
    "glStencilFunc",
    "glStencilMask",
    "glStencilOp",
    "glTexCoord1d",
    "glTexCoord1dv",
    "glTexCoord1f",
    "glTexCoord1fv",
    "glTexCoord1i",
    "glTexCoord1iv",
    "glTexCoord1s",
    "glTexCoord1sv",
    "glTexCoord2d",
    "glTexCoord2dv",
    "glTexCoord2f",
    "glTexCoord2fv",
    "glTexCoord2i",
    "glTexCoord2iv",
    "glTexCoord2s",
    "glTexCoord2sv",
    "glTexCoord3d",
    "glTexCoord3dv",
    "glTexCoord3f",
    "glTexCoord3fv",
    "glTexCoord3i",
    "glTexCoord3iv",
    "glTexCoord3s",
    "glTexCoord3sv",
    "glTexCoord4d",
    "glTexCoord4dv",
    "glTexCoord4f",
    "glTexCoord4fv",
    "glTexCoord4i",
    "glTexCoord4iv",
    "glTexCoord4s",
    "glTexCoord4sv",
    "glTexCoordPointer",
    "glTexEnvf",
    "glTexEnvfv",
    "glTexEnvi",
    "glTexEnviv",
    "glTexGend",
    "glTexGendv",
    "glTexGenf",
    "glTexGenfv",
    "glTexGeni",
    "glTexGeniv",
    "glTexImage1D",
    "glTexImage2D",
    "glTexParameterf",
    "glTexParameterfv",
    "glTexParameteri",
    "glTexParameteriv",
    "glTexSubImage1D",
    "glTexSubImage2D",
    "glTranslated",
    "glTranslatef",
    "glVertex2d",
    "glVertex2dv",
    "glVertex2f",
    "glVertex2fv",
    "glVertex2i",
    "glVertex2iv",
    "glVertex2s",
    "glVertex2sv",
    "glVertex3d",
    "glVertex3dv",
    "glVertex3f",
    "glVertex3fv",
    "glVertex3i",
    "glVertex3iv",
    "glVertex3s",
    "glVertex3sv",
    "glVertex4d",
    "glVertex4dv",
    "glVertex4f",
    "glVertex4fv",
    "glVertex4i",
    "glVertex4iv",
    "glVertex4s",
    "glVertex4sv",
    "glVertexPointer",
    "glViewport",
    "wglCopyContext",
    "wglCreateContext",
    "wglCreateLayerContext",
    "wglDeleteContext",
    "wglDescribeLayerPlane",
    "wglGetCurrentContext",
    "wglGetCurrentDC",
    "wglGetLayerPaletteEntries",
    "wglGetProcAddress",
    "wglMakeCurrent",
    "wglRealizeLayerPalette",
    "wglSetLayerPaletteEntries",
    "wglShareLists",
    "wglSwapLayerBuffers",
    "wglUseFontBitmapsA",
    "wglUseFontOutlinesA",
    "wglChoosePixelFormat",
    "wglDescribePixelFormat",
    "wglGetPixelFormat",
    "wglSetPixelFormat",
    "wglSwapBuffers",
};
#define NEXPORTS ((int)(sizeof names / sizeof names[0]))
static void *fns[NEXPORTS];
static void fill(void)
{
    int i = 0;
    fns[i++] = (void *)glAccum;
    fns[i++] = (void *)glAlphaFunc;
    fns[i++] = (void *)glAreTexturesResident;
    fns[i++] = (void *)glArrayElement;
    fns[i++] = (void *)glBegin;
    fns[i++] = (void *)glBindTexture;
    fns[i++] = (void *)glBitmap;
    fns[i++] = (void *)glBlendFunc;
    fns[i++] = (void *)glCallList;
    fns[i++] = (void *)glCallLists;
    fns[i++] = (void *)glClear;
    fns[i++] = (void *)glClearAccum;
    fns[i++] = (void *)glClearColor;
    fns[i++] = (void *)glClearDepth;
    fns[i++] = (void *)glClearIndex;
    fns[i++] = (void *)glClearStencil;
    fns[i++] = (void *)glClipPlane;
    fns[i++] = (void *)glColor3b;
    fns[i++] = (void *)glColor3bv;
    fns[i++] = (void *)glColor3d;
    fns[i++] = (void *)glColor3dv;
    fns[i++] = (void *)glColor3f;
    fns[i++] = (void *)glColor3fv;
    fns[i++] = (void *)glColor3i;
    fns[i++] = (void *)glColor3iv;
    fns[i++] = (void *)glColor3s;
    fns[i++] = (void *)glColor3sv;
    fns[i++] = (void *)glColor3ub;
    fns[i++] = (void *)glColor3ubv;
    fns[i++] = (void *)glColor3ui;
    fns[i++] = (void *)glColor3uiv;
    fns[i++] = (void *)glColor3us;
    fns[i++] = (void *)glColor3usv;
    fns[i++] = (void *)glColor4b;
    fns[i++] = (void *)glColor4bv;
    fns[i++] = (void *)glColor4d;
    fns[i++] = (void *)glColor4dv;
    fns[i++] = (void *)glColor4f;
    fns[i++] = (void *)glColor4fv;
    fns[i++] = (void *)glColor4i;
    fns[i++] = (void *)glColor4iv;
    fns[i++] = (void *)glColor4s;
    fns[i++] = (void *)glColor4sv;
    fns[i++] = (void *)glColor4ub;
    fns[i++] = (void *)glColor4ubv;
    fns[i++] = (void *)glColor4ui;
    fns[i++] = (void *)glColor4uiv;
    fns[i++] = (void *)glColor4us;
    fns[i++] = (void *)glColor4usv;
    fns[i++] = (void *)glColorMask;
    fns[i++] = (void *)glColorMaterial;
    fns[i++] = (void *)glColorPointer;
    fns[i++] = (void *)glCopyPixels;
    fns[i++] = (void *)glCopyTexImage1D;
    fns[i++] = (void *)glCopyTexImage2D;
    fns[i++] = (void *)glCopyTexSubImage1D;
    fns[i++] = (void *)glCopyTexSubImage2D;
    fns[i++] = (void *)glCullFace;
    fns[i++] = (void *)glDeleteLists;
    fns[i++] = (void *)glDeleteTextures;
    fns[i++] = (void *)glDepthFunc;
    fns[i++] = (void *)glDepthMask;
    fns[i++] = (void *)glDepthRange;
    fns[i++] = (void *)glDisable;
    fns[i++] = (void *)glDisableClientState;
    fns[i++] = (void *)glDrawArrays;
    fns[i++] = (void *)glDrawBuffer;
    fns[i++] = (void *)glDrawElements;
    fns[i++] = (void *)glDrawPixels;
    fns[i++] = (void *)glEdgeFlag;
    fns[i++] = (void *)glEdgeFlagPointer;
    fns[i++] = (void *)glEdgeFlagv;
    fns[i++] = (void *)glEnable;
    fns[i++] = (void *)glEnableClientState;
    fns[i++] = (void *)glEnd;
    fns[i++] = (void *)glEndList;
    fns[i++] = (void *)glEvalCoord1d;
    fns[i++] = (void *)glEvalCoord1dv;
    fns[i++] = (void *)glEvalCoord1f;
    fns[i++] = (void *)glEvalCoord1fv;
    fns[i++] = (void *)glEvalCoord2d;
    fns[i++] = (void *)glEvalCoord2dv;
    fns[i++] = (void *)glEvalCoord2f;
    fns[i++] = (void *)glEvalCoord2fv;
    fns[i++] = (void *)glEvalMesh1;
    fns[i++] = (void *)glEvalMesh2;
    fns[i++] = (void *)glEvalPoint1;
    fns[i++] = (void *)glEvalPoint2;
    fns[i++] = (void *)glFeedbackBuffer;
    fns[i++] = (void *)glFinish;
    fns[i++] = (void *)glFlush;
    fns[i++] = (void *)glFogf;
    fns[i++] = (void *)glFogfv;
    fns[i++] = (void *)glFogi;
    fns[i++] = (void *)glFogiv;
    fns[i++] = (void *)glFrontFace;
    fns[i++] = (void *)glFrustum;
    fns[i++] = (void *)glGenLists;
    fns[i++] = (void *)glGenTextures;
    fns[i++] = (void *)glGetBooleanv;
    fns[i++] = (void *)glGetClipPlane;
    fns[i++] = (void *)glGetDoublev;
    fns[i++] = (void *)glGetError;
    fns[i++] = (void *)glGetFloatv;
    fns[i++] = (void *)glGetIntegerv;
    fns[i++] = (void *)glGetLightfv;
    fns[i++] = (void *)glGetLightiv;
    fns[i++] = (void *)glGetMapdv;
    fns[i++] = (void *)glGetMapfv;
    fns[i++] = (void *)glGetMapiv;
    fns[i++] = (void *)glGetMaterialfv;
    fns[i++] = (void *)glGetMaterialiv;
    fns[i++] = (void *)glGetPixelMapfv;
    fns[i++] = (void *)glGetPixelMapuiv;
    fns[i++] = (void *)glGetPixelMapusv;
    fns[i++] = (void *)glGetPointerv;
    fns[i++] = (void *)glGetPolygonStipple;
    fns[i++] = (void *)glGetString;
    fns[i++] = (void *)glGetTexEnvfv;
    fns[i++] = (void *)glGetTexEnviv;
    fns[i++] = (void *)glGetTexGendv;
    fns[i++] = (void *)glGetTexGenfv;
    fns[i++] = (void *)glGetTexGeniv;
    fns[i++] = (void *)glGetTexImage;
    fns[i++] = (void *)glGetTexParameterfv;
    fns[i++] = (void *)glGetTexParameteriv;
    fns[i++] = (void *)glHint;
    fns[i++] = (void *)glIndexMask;
    fns[i++] = (void *)glIndexPointer;
    fns[i++] = (void *)glIndexd;
    fns[i++] = (void *)glIndexdv;
    fns[i++] = (void *)glIndexf;
    fns[i++] = (void *)glIndexfv;
    fns[i++] = (void *)glIndexi;
    fns[i++] = (void *)glIndexiv;
    fns[i++] = (void *)glIndexs;
    fns[i++] = (void *)glIndexsv;
    fns[i++] = (void *)glIndexub;
    fns[i++] = (void *)glIndexubv;
    fns[i++] = (void *)glInitNames;
    fns[i++] = (void *)glInterleavedArrays;
    fns[i++] = (void *)glIsEnabled;
    fns[i++] = (void *)glIsList;
    fns[i++] = (void *)glIsTexture;
    fns[i++] = (void *)glLightModelf;
    fns[i++] = (void *)glLightModelfv;
    fns[i++] = (void *)glLightModeli;
    fns[i++] = (void *)glLightModeliv;
    fns[i++] = (void *)glLightf;
    fns[i++] = (void *)glLightfv;
    fns[i++] = (void *)glLighti;
    fns[i++] = (void *)glLightiv;
    fns[i++] = (void *)glLineStipple;
    fns[i++] = (void *)glLineWidth;
    fns[i++] = (void *)glListBase;
    fns[i++] = (void *)glLoadIdentity;
    fns[i++] = (void *)glLoadMatrixd;
    fns[i++] = (void *)glLoadMatrixf;
    fns[i++] = (void *)glLoadName;
    fns[i++] = (void *)glLogicOp;
    fns[i++] = (void *)glMap1d;
    fns[i++] = (void *)glMap1f;
    fns[i++] = (void *)glMap2d;
    fns[i++] = (void *)glMap2f;
    fns[i++] = (void *)glMapGrid1d;
    fns[i++] = (void *)glMapGrid1f;
    fns[i++] = (void *)glMapGrid2d;
    fns[i++] = (void *)glMapGrid2f;
    fns[i++] = (void *)glMaterialf;
    fns[i++] = (void *)glMaterialfv;
    fns[i++] = (void *)glMateriali;
    fns[i++] = (void *)glMaterialiv;
    fns[i++] = (void *)glMatrixMode;
    fns[i++] = (void *)glMultMatrixd;
    fns[i++] = (void *)glMultMatrixf;
    fns[i++] = (void *)glNewList;
    fns[i++] = (void *)glNormal3b;
    fns[i++] = (void *)glNormal3bv;
    fns[i++] = (void *)glNormal3d;
    fns[i++] = (void *)glNormal3dv;
    fns[i++] = (void *)glNormal3f;
    fns[i++] = (void *)glNormal3fv;
    fns[i++] = (void *)glNormal3i;
    fns[i++] = (void *)glNormal3iv;
    fns[i++] = (void *)glNormal3s;
    fns[i++] = (void *)glNormal3sv;
    fns[i++] = (void *)glNormalPointer;
    fns[i++] = (void *)glOrtho;
    fns[i++] = (void *)glPassThrough;
    fns[i++] = (void *)glPixelMapfv;
    fns[i++] = (void *)glPixelMapuiv;
    fns[i++] = (void *)glPixelMapusv;
    fns[i++] = (void *)glPixelStoref;
    fns[i++] = (void *)glPixelStorei;
    fns[i++] = (void *)glPixelTransferf;
    fns[i++] = (void *)glPixelTransferi;
    fns[i++] = (void *)glPixelZoom;
    fns[i++] = (void *)glPointSize;
    fns[i++] = (void *)glPolygonMode;
    fns[i++] = (void *)glPolygonOffset;
    fns[i++] = (void *)glPolygonStipple;
    fns[i++] = (void *)glPopAttrib;
    fns[i++] = (void *)glPopClientAttrib;
    fns[i++] = (void *)glPopMatrix;
    fns[i++] = (void *)glPopName;
    fns[i++] = (void *)glPrioritizeTextures;
    fns[i++] = (void *)glPushAttrib;
    fns[i++] = (void *)glPushClientAttrib;
    fns[i++] = (void *)glPushMatrix;
    fns[i++] = (void *)glPushName;
    fns[i++] = (void *)glRasterPos2d;
    fns[i++] = (void *)glRasterPos2dv;
    fns[i++] = (void *)glRasterPos2f;
    fns[i++] = (void *)glRasterPos2fv;
    fns[i++] = (void *)glRasterPos2i;
    fns[i++] = (void *)glRasterPos2iv;
    fns[i++] = (void *)glRasterPos2s;
    fns[i++] = (void *)glRasterPos2sv;
    fns[i++] = (void *)glRasterPos3d;
    fns[i++] = (void *)glRasterPos3dv;
    fns[i++] = (void *)glRasterPos3f;
    fns[i++] = (void *)glRasterPos3fv;
    fns[i++] = (void *)glRasterPos3i;
    fns[i++] = (void *)glRasterPos3iv;
    fns[i++] = (void *)glRasterPos3s;
    fns[i++] = (void *)glRasterPos3sv;
    fns[i++] = (void *)glRasterPos4d;
    fns[i++] = (void *)glRasterPos4dv;
    fns[i++] = (void *)glRasterPos4f;
    fns[i++] = (void *)glRasterPos4fv;
    fns[i++] = (void *)glRasterPos4i;
    fns[i++] = (void *)glRasterPos4iv;
    fns[i++] = (void *)glRasterPos4s;
    fns[i++] = (void *)glRasterPos4sv;
    fns[i++] = (void *)glReadBuffer;
    fns[i++] = (void *)glReadPixels;
    fns[i++] = (void *)glRectd;
    fns[i++] = (void *)glRectdv;
    fns[i++] = (void *)glRectf;
    fns[i++] = (void *)glRectfv;
    fns[i++] = (void *)glRecti;
    fns[i++] = (void *)glRectiv;
    fns[i++] = (void *)glRects;
    fns[i++] = (void *)glRectsv;
    fns[i++] = (void *)glRenderMode;
    fns[i++] = (void *)glRotated;
    fns[i++] = (void *)glRotatef;
    fns[i++] = (void *)glScaled;
    fns[i++] = (void *)glScalef;
    fns[i++] = (void *)glScissor;
    fns[i++] = (void *)glSelectBuffer;
    fns[i++] = (void *)glShadeModel;
    fns[i++] = (void *)glStencilFunc;
    fns[i++] = (void *)glStencilMask;
    fns[i++] = (void *)glStencilOp;
    fns[i++] = (void *)glTexCoord1d;
    fns[i++] = (void *)glTexCoord1dv;
    fns[i++] = (void *)glTexCoord1f;
    fns[i++] = (void *)glTexCoord1fv;
    fns[i++] = (void *)glTexCoord1i;
    fns[i++] = (void *)glTexCoord1iv;
    fns[i++] = (void *)glTexCoord1s;
    fns[i++] = (void *)glTexCoord1sv;
    fns[i++] = (void *)glTexCoord2d;
    fns[i++] = (void *)glTexCoord2dv;
    fns[i++] = (void *)glTexCoord2f;
    fns[i++] = (void *)glTexCoord2fv;
    fns[i++] = (void *)glTexCoord2i;
    fns[i++] = (void *)glTexCoord2iv;
    fns[i++] = (void *)glTexCoord2s;
    fns[i++] = (void *)glTexCoord2sv;
    fns[i++] = (void *)glTexCoord3d;
    fns[i++] = (void *)glTexCoord3dv;
    fns[i++] = (void *)glTexCoord3f;
    fns[i++] = (void *)glTexCoord3fv;
    fns[i++] = (void *)glTexCoord3i;
    fns[i++] = (void *)glTexCoord3iv;
    fns[i++] = (void *)glTexCoord3s;
    fns[i++] = (void *)glTexCoord3sv;
    fns[i++] = (void *)glTexCoord4d;
    fns[i++] = (void *)glTexCoord4dv;
    fns[i++] = (void *)glTexCoord4f;
    fns[i++] = (void *)glTexCoord4fv;
    fns[i++] = (void *)glTexCoord4i;
    fns[i++] = (void *)glTexCoord4iv;
    fns[i++] = (void *)glTexCoord4s;
    fns[i++] = (void *)glTexCoord4sv;
    fns[i++] = (void *)glTexCoordPointer;
    fns[i++] = (void *)glTexEnvf;
    fns[i++] = (void *)glTexEnvfv;
    fns[i++] = (void *)glTexEnvi;
    fns[i++] = (void *)glTexEnviv;
    fns[i++] = (void *)glTexGend;
    fns[i++] = (void *)glTexGendv;
    fns[i++] = (void *)glTexGenf;
    fns[i++] = (void *)glTexGenfv;
    fns[i++] = (void *)glTexGeni;
    fns[i++] = (void *)glTexGeniv;
    fns[i++] = (void *)glTexImage1D;
    fns[i++] = (void *)glTexImage2D;
    fns[i++] = (void *)glTexParameterf;
    fns[i++] = (void *)glTexParameterfv;
    fns[i++] = (void *)glTexParameteri;
    fns[i++] = (void *)glTexParameteriv;
    fns[i++] = (void *)glTexSubImage1D;
    fns[i++] = (void *)glTexSubImage2D;
    fns[i++] = (void *)glTranslated;
    fns[i++] = (void *)glTranslatef;
    fns[i++] = (void *)glVertex2d;
    fns[i++] = (void *)glVertex2dv;
    fns[i++] = (void *)glVertex2f;
    fns[i++] = (void *)glVertex2fv;
    fns[i++] = (void *)glVertex2i;
    fns[i++] = (void *)glVertex2iv;
    fns[i++] = (void *)glVertex2s;
    fns[i++] = (void *)glVertex2sv;
    fns[i++] = (void *)glVertex3d;
    fns[i++] = (void *)glVertex3dv;
    fns[i++] = (void *)glVertex3f;
    fns[i++] = (void *)glVertex3fv;
    fns[i++] = (void *)glVertex3i;
    fns[i++] = (void *)glVertex3iv;
    fns[i++] = (void *)glVertex3s;
    fns[i++] = (void *)glVertex3sv;
    fns[i++] = (void *)glVertex4d;
    fns[i++] = (void *)glVertex4dv;
    fns[i++] = (void *)glVertex4f;
    fns[i++] = (void *)glVertex4fv;
    fns[i++] = (void *)glVertex4i;
    fns[i++] = (void *)glVertex4iv;
    fns[i++] = (void *)glVertex4s;
    fns[i++] = (void *)glVertex4sv;
    fns[i++] = (void *)glVertexPointer;
    fns[i++] = (void *)glViewport;
    fns[i++] = (void *)wglCopyContext;
    fns[i++] = (void *)wglCreateContext;
    fns[i++] = (void *)wglCreateLayerContext;
    fns[i++] = (void *)wglDeleteContext;
    fns[i++] = (void *)wglDescribeLayerPlane;
    fns[i++] = (void *)wglGetCurrentContext;
    fns[i++] = (void *)wglGetCurrentDC;
    fns[i++] = (void *)wglGetLayerPaletteEntries;
    fns[i++] = (void *)wglGetProcAddress;
    fns[i++] = (void *)wglMakeCurrent;
    fns[i++] = (void *)wglRealizeLayerPalette;
    fns[i++] = (void *)wglSetLayerPaletteEntries;
    fns[i++] = (void *)wglShareLists;
    fns[i++] = (void *)wglSwapLayerBuffers;
    fns[i++] = (void *)wglUseFontBitmapsA;
    fns[i++] = (void *)wglUseFontOutlinesA;
    fns[i++] = (void *)wglChoosePixelFormat;
    fns[i++] = (void *)wglDescribePixelFormat;
    fns[i++] = (void *)wglGetPixelFormat;
    fns[i++] = (void *)wglSetPixelFormat;
    fns[i++] = (void *)wglSwapBuffers;
}

/* module given, name NULL: the module's handle, or NULL if this file does not provide it. */
static void *opengl32_lookup(const char *module, const char *name)
{
    int i;
    if (name == NULL) return module && !strcasecmp(module, opengl32_dll) ? (void *)opengl32_dll : NULL;
    if (module != opengl32_dll) return NULL;
    if (!fns[0]) fill();
    for (i = 0; i < NEXPORTS; i++)
        if (!strcmp(names[i], name)) return fns[i];
    return NULL;
}
void *(*prism_system_lookup)(const char *module, const char *name) = opengl32_lookup;
