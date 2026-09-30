// headers-gl.js — <GL/gl.h> (OpenGL 1.1, the fixed-function subset PRISM implements), <GL/glut.h>,
// and for GLX programs <GL/glx.h> with the X11 extension headers GLQuake's platform layer names.
//
// Every value here is the one the OpenGL 1.1 specification (or GLX 1.x, or the X.org header)
// assigns, and tools/gate-gl-abi.mjs holds each GL_ and GLX_ #define to Mesa's own headers in the
// oracle container, so a transcription slip is a red gate rather than a wrong picture. The GLUT
// constants are GLUT 3.7's (freeglut keeps them). Only what is implemented is declared: a program
// that calls anything else fails at link time, naming the function, instead of calling a stub.

export const GL_H = `#ifndef _PRISM_GL_H
#define _PRISM_GL_H
typedef unsigned int GLenum;
typedef unsigned char GLboolean;
typedef unsigned int GLbitfield;
typedef void GLvoid;
typedef signed char GLbyte;
typedef short GLshort;
typedef int GLint;
typedef int GLsizei;
typedef unsigned char GLubyte;
typedef unsigned short GLushort;
typedef unsigned int GLuint;
typedef float GLfloat;
typedef float GLclampf;
typedef double GLdouble;
typedef double GLclampd;

#define GL_FALSE 0
#define GL_TRUE 1
#define GL_ZERO 0
#define GL_ONE 1

/* primitives */
#define GL_POINTS 0x0000
#define GL_LINES 0x0001
#define GL_LINE_LOOP 0x0002
#define GL_LINE_STRIP 0x0003
#define GL_TRIANGLES 0x0004
#define GL_TRIANGLE_STRIP 0x0005
#define GL_TRIANGLE_FAN 0x0006
#define GL_QUADS 0x0007
#define GL_QUAD_STRIP 0x0008
#define GL_POLYGON 0x0009

/* buffers */
#define GL_DEPTH_BUFFER_BIT 0x00000100
#define GL_COLOR_BUFFER_BIT 0x00004000

/* capabilities */
#define GL_CULL_FACE 0x0B44
#define GL_LIGHTING 0x0B50
#define GL_FOG 0x0B60
#define GL_DEPTH_TEST 0x0B71
#define GL_NORMALIZE 0x0BA1
#define GL_ALPHA_TEST 0x0BC0
#define GL_BLEND 0x0BE2
#define GL_TEXTURE_2D 0x0DE1

/* comparison functions */
#define GL_NEVER 0x0200
#define GL_LESS 0x0201
#define GL_EQUAL 0x0202
#define GL_LEQUAL 0x0203
#define GL_GREATER 0x0204
#define GL_NOTEQUAL 0x0205
#define GL_GEQUAL 0x0206
#define GL_ALWAYS 0x0207

/* blending */
#define GL_SRC_COLOR 0x0300
#define GL_ONE_MINUS_SRC_COLOR 0x0301
#define GL_SRC_ALPHA 0x0302
#define GL_ONE_MINUS_SRC_ALPHA 0x0303
#define GL_DST_ALPHA 0x0304
#define GL_ONE_MINUS_DST_ALPHA 0x0305
#define GL_DST_COLOR 0x0306
#define GL_ONE_MINUS_DST_COLOR 0x0307

/* faces, shading, polygon mode, hints */
#define GL_FRONT 0x0404
#define GL_BACK 0x0405
#define GL_FRONT_AND_BACK 0x0408
#define GL_CW 0x0900
#define GL_CCW 0x0901
#define GL_FILL 0x1B02
#define GL_FLAT 0x1D00
#define GL_SMOOTH 0x1D01
#define GL_PERSPECTIVE_CORRECTION_HINT 0x0C50
#define GL_FASTEST 0x1101
#define GL_NICEST 0x1102

/* lighting */
#define GL_LIGHT0 0x4000
#define GL_AMBIENT 0x1200
#define GL_DIFFUSE 0x1201
#define GL_SPECULAR 0x1202
#define GL_POSITION 0x1203
#define GL_EMISSION 0x1600
#define GL_SHININESS 0x1601
#define GL_AMBIENT_AND_DIFFUSE 0x1602

/* fog */
#define GL_FOG_DENSITY 0x0B62
#define GL_FOG_START 0x0B63
#define GL_FOG_END 0x0B64
#define GL_FOG_MODE 0x0B65
#define GL_FOG_COLOR 0x0B66
#define GL_EXP 0x0800
#define GL_EXP2 0x0801

/* matrices */
#define GL_MODELVIEW 0x1700
#define GL_PROJECTION 0x1701
#define GL_MODELVIEW_MATRIX 0x0BA6
#define GL_PROJECTION_MATRIX 0x0BA7

/* pixels and textures */
#define GL_UNSIGNED_BYTE 0x1401
#define GL_FLOAT 0x1406
#define GL_COLOR_INDEX 0x1900
#define GL_ALPHA 0x1906
#define GL_RGB 0x1907
#define GL_RGBA 0x1908
#define GL_LUMINANCE 0x1909
#define GL_LUMINANCE_ALPHA 0x190A
#define GL_INTENSITY 0x8049
#define GL_RGBA4 0x8056
#define GL_TEXTURE_ENV 0x2300
#define GL_TEXTURE_ENV_MODE 0x2200
#define GL_MODULATE 0x2100
#define GL_DECAL 0x2101
#define GL_REPLACE 0x1E01
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_WRAP_S 0x2802
#define GL_TEXTURE_WRAP_T 0x2803
#define GL_NEAREST 0x2600
#define GL_LINEAR 0x2601
#define GL_NEAREST_MIPMAP_NEAREST 0x2700
#define GL_LINEAR_MIPMAP_NEAREST 0x2701
#define GL_NEAREST_MIPMAP_LINEAR 0x2702
#define GL_LINEAR_MIPMAP_LINEAR 0x2703
#define GL_CLAMP 0x2900
#define GL_REPEAT 0x2901

/* extension enums a program may name; the extensions are not advertised */
#define GL_COLOR_INDEX8_EXT 0x80E5
#define GL_SHARED_TEXTURE_PALETTE_EXT 0x81FB
#define GL_VERTEX_ARRAY_EXT 0x8074
#define GL_TEXTURE_COORD_ARRAY_EXT 0x8078

/* display lists */
#define GL_COMPILE 0x1300
#define GL_COMPILE_AND_EXECUTE 0x1301

/* strings */
#define GL_VENDOR 0x1F00
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02
#define GL_EXTENSIONS 0x1F03

void glClear(GLbitfield mask);
void glClearColor(GLclampf r, GLclampf g, GLclampf b, GLclampf a);
void glEnable(GLenum cap);
void glDisable(GLenum cap);
void glShadeModel(GLenum mode);
void glCullFace(GLenum mode);
void glFrontFace(GLenum mode);
void glViewport(GLint x, GLint y, GLsizei w, GLsizei h);
void glDepthFunc(GLenum func);
void glDepthMask(GLboolean flag);
void glDepthRange(GLclampd n, GLclampd f);
void glAlphaFunc(GLenum func, GLclampf ref);
void glBlendFunc(GLenum sfactor, GLenum dfactor);
void glMatrixMode(GLenum mode);
void glLoadIdentity(void);
void glLoadMatrixf(const GLfloat *m);
void glPushMatrix(void);
void glPopMatrix(void);
void glTranslatef(GLfloat x, GLfloat y, GLfloat z);
void glRotatef(GLfloat angle, GLfloat x, GLfloat y, GLfloat z);
void glScalef(GLfloat x, GLfloat y, GLfloat z);
void glFrustum(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f);
void glOrtho(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f);
void glGetFloatv(GLenum pname, GLfloat *params);
void glBegin(GLenum mode);
void glEnd(void);
void glVertex3f(GLfloat x, GLfloat y, GLfloat z);
void glVertex3fv(const GLfloat *v);
void glVertex2f(GLfloat x, GLfloat y);
void glNormal3f(GLfloat x, GLfloat y, GLfloat z);
void glColor3f(GLfloat r, GLfloat g, GLfloat b);
void glColor4f(GLfloat r, GLfloat g, GLfloat b, GLfloat a);
void glColor4fv(const GLfloat *v);
void glColor3ubv(const GLubyte *v);
void glTexCoord2f(GLfloat s, GLfloat t);
void glTexCoord2fv(const GLfloat *v);
void glLightfv(GLenum light, GLenum pname, const GLfloat *params);
void glMaterialfv(GLenum face, GLenum pname, const GLfloat *params);
void glFogf(GLenum pname, GLfloat param);
void glFogi(GLenum pname, GLint param);
void glFogfv(GLenum pname, const GLfloat *params);
void glBindTexture(GLenum target, GLuint texture);
void glTexParameterf(GLenum target, GLenum pname, GLfloat param);
void glTexEnvf(GLenum target, GLenum pname, GLfloat param);
void glTexImage2D(GLenum target, GLint level, GLint internalformat, GLsizei w, GLsizei h, GLint border, GLenum format, GLenum type, const GLvoid *pixels);
void glTexSubImage2D(GLenum target, GLint level, GLint x, GLint y, GLsizei w, GLsizei h, GLenum format, GLenum type, const GLvoid *pixels);
void glReadPixels(GLint x, GLint y, GLsizei w, GLsizei h, GLenum format, GLenum type, GLvoid *pixels);
void glPolygonMode(GLenum face, GLenum mode);
void glHint(GLenum target, GLenum mode);
void glDrawBuffer(GLenum mode);
void glReadBuffer(GLenum mode);
GLuint glGenLists(GLsizei range);
void glNewList(GLuint list, GLenum mode);
void glEndList(void);
void glCallList(GLuint list);
void glDeleteLists(GLuint list, GLsizei range);
const GLubyte *glGetString(GLenum name);
void glFinish(void);
void glFlush(void);
#endif
`;

export const GLU_H = `#ifndef _PRISM_GLU_H
#define _PRISM_GLU_H
#include <GL/gl.h>
#endif
`;

export const GLUT_H = `#ifndef _PRISM_GLUT_H
#define _PRISM_GLUT_H
#include <GL/gl.h>
#include <GL/glu.h>
#define GLUT_RGB 0
#define GLUT_RGBA 0
#define GLUT_DOUBLE 2
#define GLUT_DEPTH 16
#define GLUT_ELAPSED_TIME 700
#define GLUT_WINDOW_WIDTH 102
#define GLUT_WINDOW_HEIGHT 103
#define GLUT_VISIBLE 1
#define GLUT_NOT_VISIBLE 0
#define GLUT_KEY_LEFT 100
#define GLUT_KEY_UP 101
#define GLUT_KEY_RIGHT 102
#define GLUT_KEY_DOWN 103
void glutInit(int *argc, char **argv);
void glutInitDisplayMode(unsigned int mode);
void glutInitWindowSize(int w, int h);
void glutInitWindowPosition(int x, int y);
int glutCreateWindow(const char *title);
void glutDestroyWindow(int win);
void glutDisplayFunc(void (*f)(void));
void glutReshapeFunc(void (*f)(int, int));
void glutIdleFunc(void (*f)(void));
void glutVisibilityFunc(void (*f)(int));
void glutKeyboardFunc(void (*f)(unsigned char, int, int));
void glutSpecialFunc(void (*f)(int, int, int));
void glutPostRedisplay(void);
int glutGet(int what);
void glutSwapBuffers(void);
void glutMainLoop(void);
#endif
`;

export const GL_HEADERS = { 'GL/gl.h': GL_H, 'GL/glu.h': GLU_H, 'GL/glut.h': GLUT_H };

/*
 * GLX, for an X client that draws with GL. GLX_ values are GLX 1.x's and are held to Mesa's
 * <GL/glx.h> by gate-gl-abi. The two X extensions GLQuake's platform layer names (the XFree86
 * VidMode and DGA extensions) are declared so it compiles; PRISM's X server answers their
 * QueryVersion with "not present", which is the answer the program is written to accept, and the
 * rest refuse if called anyway. termios.h is included by that file and never used.
 */
export const GLX_H = `#ifndef _PRISM_GLX_H
#define _PRISM_GLX_H
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <GL/gl.h>
typedef struct __GLXcontextRec *GLXContext;
typedef unsigned long GLXDrawable;   /* an XID; PRISM's Xlib.h spells Window and Drawable this way */
#define GLX_RGBA 4
#define GLX_DOUBLEBUFFER 5
#define GLX_RED_SIZE 8
#define GLX_GREEN_SIZE 9
#define GLX_BLUE_SIZE 10
#define GLX_ALPHA_SIZE 11
#define GLX_DEPTH_SIZE 12
XVisualInfo *glXChooseVisual(Display *dpy, int screen, int *attribList);
GLXContext glXCreateContext(Display *dpy, XVisualInfo *vis, GLXContext share, Bool direct);
Bool glXMakeCurrent(Display *dpy, GLXDrawable drawable, GLXContext ctx);
void glXSwapBuffers(Display *dpy, GLXDrawable drawable);
void glXDestroyContext(Display *dpy, GLXContext ctx);
#endif
`;
const XF86VMODE_H = `#ifndef _PRISM_XF86VMODE_H
#define _PRISM_XF86VMODE_H
#include <X11/Xlib.h>
typedef struct {
    unsigned int dotclock;
    unsigned short hdisplay, hsyncstart, hsyncend, htotal, hskew;
    unsigned short vdisplay, vsyncstart, vsyncend, vtotal;
    unsigned int flags;
    int privsize;
    int *private;
} XF86VidModeModeInfo;
Bool XF86VidModeQueryVersion(Display *dpy, int *major, int *minor);
Bool XF86VidModeGetAllModeLines(Display *dpy, int screen, int *count, XF86VidModeModeInfo ***modes);
Bool XF86VidModeSwitchToMode(Display *dpy, int screen, XF86VidModeModeInfo *mode);
Bool XF86VidModeSetViewPort(Display *dpy, int screen, int x, int y);
#endif
`;
const XF86DGA_H = `#ifndef _PRISM_XF86DGA_H
#define _PRISM_XF86DGA_H
#include <X11/Xlib.h>
#define XF86DGADirectGraphics 0x0002
#define XF86DGADirectMouse 0x0004
#define XF86DGADirectKeyb 0x0008
Bool XF86DGAQueryVersion(Display *dpy, int *major, int *minor);
Status XF86DGADirectVideo(Display *dpy, int screen, int enable);
#endif
`;
export const GLX_HEADERS = {
  'GL/glx.h': GLX_H,
  'X11/extensions/xf86vmode.h': XF86VMODE_H,
  'X11/extensions/xf86dga.h': XF86DGA_H,
  'X11/cursorfont.h': '#ifndef _PRISM_CURSORFONT_H\n#define _PRISM_CURSORFONT_H\n#endif\n',
  'termios.h': '#ifndef _PRISM_TERMIOS_H\n#define _PRISM_TERMIOS_H\n#endif\n',
};
