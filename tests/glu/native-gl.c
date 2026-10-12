/*
 * The native side of tests/glu/mipmap.c: a GL context for libGLU to query (Mesa on surfaceless EGL),
 * and glTexImage2D exported by the executable (-rdynamic) so that libGLU's calls land here first:
 * each level is hashed as it arrives -- its rows as GL_UNPACK_ALIGNMENT lays them out at that moment,
 * w * components bytes each -- then handed to Mesa. The immediate-mode calls a quadric is made of are
 * exported the same way and only traced (tests/glu/quadric.c): each argument as its float's bits;
 * so are the matrix calls GLU's matrix functions make (tests/glu/matrix.c), doubles as theirs.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GL/gl.h>

void make_context(void)
{
    PFNEGLGETPLATFORMDISPLAYEXTPROC get = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    EGLDisplay d = get(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
    static const EGLint cfg[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_NONE };
    EGLConfig conf; EGLint n;
    if (!eglInitialize(d, NULL, NULL)) { fprintf(stderr, "no EGL\n"); exit(2); }
    eglBindAPI(EGL_OPENGL_API);
    if (!eglChooseConfig(d, cfg, &conf, 1, &n) || n < 1) { fprintf(stderr, "no EGL config\n"); exit(2); }
    if (!eglMakeCurrent(d, EGL_NO_SURFACE, EGL_NO_SURFACE, eglCreateContext(d, conf, EGL_NO_CONTEXT, NULL))) { fprintf(stderr, "no context\n"); exit(2); }
}

static int comps(GLenum f) { return f == GL_RGBA ? 4 : f == GL_RGB ? 3 : f == GL_LUMINANCE_ALPHA ? 2 : 1; }

void glTexImage2D(GLenum target, GLint level, GLint internal, GLsizei w, GLsizei h, GLint border, GLenum format, GLenum type, const void *pixels)
{
    static void (*real)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *);
    if (!real) real = (void (*)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *))dlsym(RTLD_NEXT, "glTexImage2D");
    if (target == GL_TEXTURE_2D) {
        GLint align = 4, rowlen = 0;
        int c = comps(format), y, x, rb;
        unsigned int hh = 2166136261u;
        glGetIntegerv(GL_UNPACK_ALIGNMENT, &align);
        glGetIntegerv(GL_UNPACK_ROW_LENGTH, &rowlen);
        rb = ((rowlen ? rowlen : w) * c + align - 1) / align * align;
        for (y = 0; pixels && y < h; y++) { unsigned int r = 2166136261u; const unsigned char *p = (const unsigned char *)pixels + y * rb; for (x = 0; x < w * c; x++) r = (r ^ p[x]) * 16777619u; hh = (hh ^ r) * 16777619u; }
        printf("level %d %dx%d int %d fmt %x type %x %08x\n", level, w, h, internal, format, type, hh);
    }
    real(target, level, internal, w, h, border, format, type, pixels);
}

static unsigned int bits(GLfloat f) { union { GLfloat f; unsigned int u; } v; v.f = f; return v.u; }
void glBegin(GLenum mode) { printf("b %x\n", mode); }
void glEnd(void) { printf("e\n"); }
void glNormal3f(GLfloat x, GLfloat y, GLfloat z) { printf("n %08x %08x %08x\n", bits(x), bits(y), bits(z)); }
void glTexCoord2f(GLfloat s, GLfloat t) { printf("t %08x %08x\n", bits(s), bits(t)); }
void glVertex3f(GLfloat x, GLfloat y, GLfloat z) { printf("v %08x %08x %08x\n", bits(x), bits(y), bits(z)); }
static unsigned long long dbits(GLdouble d) { unsigned long long u; memcpy(&u, &d, 8); return u; }
void glMultMatrixd(const GLdouble *m) { int k; printf("md"); for (k = 0; k < 16; k++) printf(" %016llx", dbits(m[k])); printf("\n"); }
void glMultMatrixf(const GLfloat *m) { int k; printf("mf"); for (k = 0; k < 16; k++) printf(" %08x", bits(m[k])); printf("\n"); }
void glTranslated(GLdouble x, GLdouble y, GLdouble z) { printf("td %016llx %016llx %016llx\n", dbits(x), dbits(y), dbits(z)); }
void glTranslatef(GLfloat x, GLfloat y, GLfloat z) { printf("tf %08x %08x %08x\n", bits(x), bits(y), bits(z)); }
void glScalef(GLfloat x, GLfloat y, GLfloat z) { printf("sf %08x %08x %08x\n", bits(x), bits(y), bits(z)); }
void glOrtho(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f)
{
    printf("o %016llx %016llx %016llx %016llx %016llx %016llx\n", dbits(l), dbits(r), dbits(b), dbits(t), dbits(n), dbits(f));
}
