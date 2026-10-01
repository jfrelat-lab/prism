// headers-gl.js — <GL/gl.h> (OpenGL 1.1, the fixed-function subset PRISM implements), <GL/glut.h>,
// and for GLX programs <GL/glx.h> with the X11 extension headers GLQuake's platform layer names.
//
// Every value here is the one the OpenGL 1.1 specification (or GLX 1.x, or the X.org header)
// assigns, and tools/gate-gl-abi.mjs holds each GL_ and GLX_ #define to Mesa's own headers in the
// oracle container, so a transcription slip is a red gate rather than a wrong picture. The GLUT
// constants are GLUT 3.7's (freeglut keeps them). gl.h declares all of OpenGL 1.1 (see the prototype
// block); what src/env/gl.js does not implement is unresolved and throws, naming itself, if called.

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

/* what Quake II's ref_gl adds; values printed by Mesa's headers */
#define GL_BACK_LEFT 0x402
#define GL_COLOR_ARRAY 0x8076
#define GL_DISTANCE_ATTENUATION_EXT 0x8129
#define GL_INTENSITY8 0x804B
#define GL_LINE 0x1B01
#define GL_LUMINANCE8 0x8040
#define GL_NO_ERROR 0x0
#define GL_POINT_FADE_THRESHOLD_SIZE_EXT 0x8128
#define GL_POINT_SIZE_MAX_EXT 0x8127
#define GL_POINT_SIZE_MIN_EXT 0x8126
#define GL_POINT_SMOOTH 0xB10
#define GL_R 0x2002
#define GL_R3_G3_B2 0x2A10
#define GL_RGB2_EXT 0x804E
#define GL_RGB4 0x804F
#define GL_RGB5 0x8050
#define GL_RGB5_A1 0x8057
#define GL_RGB8 0x8051
#define GL_RGBA2 0x8055
#define GL_RGBA8 0x8058
#define GL_S 0x2000
#define GL_SCISSOR_TEST 0xC11
#define GL_T 0x2001
#define GL_TEXTURE_COLOR_TABLE_SGI 0x80BC
#define GL_VERTEX_ARRAY 0x8074

/* display lists */
#define GL_COMPILE 0x1300
#define GL_COMPILE_AND_EXECUTE 0x1301

/* strings */
#define GL_VENDOR 0x1F00
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02
#define GL_EXTENSIONS 0x1F03

/*
 * Every OpenGL 1.1 entry point, as Mesa's <GL/gl.h> declares it: Quake II's qgl_linux.c takes the
 * address of all of them at start-up (qgl* = dll* = gl*), so all must be declared even though most
 * are never called. Those src/env/gl.js does not implement stay unresolved at link time and throw,
 * naming themselves, if a program does call one -- the same loud failure as before, one step later.
 */
void glAccum(GLenum op, GLfloat value);
void glAlphaFunc(GLenum func, GLclampf ref);
GLboolean glAreTexturesResident(GLsizei n, const GLuint *textures, GLboolean *residences);
void glArrayElement(GLint i);
void glBegin(GLenum mode);
void glBindTexture(GLenum target, GLuint texture);
void glBitmap(GLsizei width, GLsizei height, GLfloat xorig, GLfloat yorig, GLfloat xmove, GLfloat ymove, const GLubyte *bitmap);
void glBlendFunc(GLenum sfactor, GLenum dfactor);
void glCallList(GLuint list);
void glCallLists(GLsizei n, GLenum type, const GLvoid *lists);
void glClear(GLbitfield mask);
void glClearAccum(GLfloat red, GLfloat green, GLfloat blue, GLfloat alpha);
void glClearColor(GLclampf red, GLclampf green, GLclampf blue, GLclampf alpha);
void glClearDepth(GLclampd depth);
void glClearIndex(GLfloat c);
void glClearStencil(GLint s);
void glClipPlane(GLenum plane, const GLdouble *equation);
void glColor3b(GLbyte red, GLbyte green, GLbyte blue);
void glColor3bv(const GLbyte *v);
void glColor3d(GLdouble red, GLdouble green, GLdouble blue);
void glColor3dv(const GLdouble *v);
void glColor3f(GLfloat red, GLfloat green, GLfloat blue);
void glColor3fv(const GLfloat *v);
void glColor3i(GLint red, GLint green, GLint blue);
void glColor3iv(const GLint *v);
void glColor3s(GLshort red, GLshort green, GLshort blue);
void glColor3sv(const GLshort *v);
void glColor3ub(GLubyte red, GLubyte green, GLubyte blue);
void glColor3ubv(const GLubyte *v);
void glColor3ui(GLuint red, GLuint green, GLuint blue);
void glColor3uiv(const GLuint *v);
void glColor3us(GLushort red, GLushort green, GLushort blue);
void glColor3usv(const GLushort *v);
void glColor4b(GLbyte red, GLbyte green, GLbyte blue, GLbyte alpha);
void glColor4bv(const GLbyte *v);
void glColor4d(GLdouble red, GLdouble green, GLdouble blue, GLdouble alpha);
void glColor4dv(const GLdouble *v);
void glColor4f(GLfloat red, GLfloat green, GLfloat blue, GLfloat alpha);
void glColor4fv(const GLfloat *v);
void glColor4i(GLint red, GLint green, GLint blue, GLint alpha);
void glColor4iv(const GLint *v);
void glColor4s(GLshort red, GLshort green, GLshort blue, GLshort alpha);
void glColor4sv(const GLshort *v);
void glColor4ub(GLubyte red, GLubyte green, GLubyte blue, GLubyte alpha);
void glColor4ubv(const GLubyte *v);
void glColor4ui(GLuint red, GLuint green, GLuint blue, GLuint alpha);
void glColor4uiv(const GLuint *v);
void glColor4us(GLushort red, GLushort green, GLushort blue, GLushort alpha);
void glColor4usv(const GLushort *v);
void glColorMask(GLboolean red, GLboolean green, GLboolean blue, GLboolean alpha);
void glColorMaterial(GLenum face, GLenum mode);
void glColorPointer(GLint size, GLenum type, GLsizei stride, const GLvoid *ptr);
void glCopyPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum type);
void glCopyTexImage1D(GLenum target, GLint level, GLenum internalformat, GLint x, GLint y, GLsizei width, GLint border);
void glCopyTexImage2D(GLenum target, GLint level, GLenum internalformat, GLint x, GLint y, GLsizei width, GLsizei height, GLint border);
void glCopyTexSubImage1D(GLenum target, GLint level, GLint xoffset, GLint x, GLint y, GLsizei width);
void glCopyTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLint x, GLint y, GLsizei width, GLsizei height);
void glCullFace(GLenum mode);
void glDeleteLists(GLuint list, GLsizei range);
void glDeleteTextures(GLsizei n, const GLuint *textures);
void glDepthFunc(GLenum func);
void glDepthMask(GLboolean flag);
void glDepthRange(GLclampd near_val, GLclampd far_val);
void glDisable(GLenum cap);
void glDisableClientState(GLenum cap);
void glDrawArrays(GLenum mode, GLint first, GLsizei count);
void glDrawBuffer(GLenum mode);
void glDrawElements(GLenum mode, GLsizei count, GLenum type, const GLvoid *indices);
void glDrawPixels(GLsizei width, GLsizei height, GLenum format, GLenum type, const GLvoid *pixels);
void glEdgeFlag(GLboolean flag);
void glEdgeFlagPointer(GLsizei stride, const GLvoid *ptr);
void glEdgeFlagv(const GLboolean *flag);
void glEnable(GLenum cap);
void glEnableClientState(GLenum cap);
void glEnd(void);
void glEndList(void);
void glEvalCoord1d(GLdouble u);
void glEvalCoord1dv(const GLdouble *u);
void glEvalCoord1f(GLfloat u);
void glEvalCoord1fv(const GLfloat *u);
void glEvalCoord2d(GLdouble u, GLdouble v);
void glEvalCoord2dv(const GLdouble *u);
void glEvalCoord2f(GLfloat u, GLfloat v);
void glEvalCoord2fv(const GLfloat *u);
void glEvalMesh1(GLenum mode, GLint i1, GLint i2);
void glEvalMesh2(GLenum mode, GLint i1, GLint i2, GLint j1, GLint j2);
void glEvalPoint1(GLint i);
void glEvalPoint2(GLint i, GLint j);
void glFeedbackBuffer(GLsizei size, GLenum type, GLfloat *buffer);
void glFinish(void);
void glFlush(void);
void glFogf(GLenum pname, GLfloat param);
void glFogfv(GLenum pname, const GLfloat *params);
void glFogi(GLenum pname, GLint param);
void glFogiv(GLenum pname, const GLint *params);
void glFrontFace(GLenum mode);
void glFrustum(GLdouble left, GLdouble right, GLdouble bottom, GLdouble top, GLdouble near_val, GLdouble far_val);
GLuint glGenLists(GLsizei range);
void glGenTextures(GLsizei n, GLuint *textures);
void glGetBooleanv(GLenum pname, GLboolean *params);
void glGetClipPlane(GLenum plane, GLdouble *equation);
void glGetDoublev(GLenum pname, GLdouble *params);
GLenum glGetError(void);
void glGetFloatv(GLenum pname, GLfloat *params);
void glGetIntegerv(GLenum pname, GLint *params);
void glGetLightfv(GLenum light, GLenum pname, GLfloat *params);
void glGetLightiv(GLenum light, GLenum pname, GLint *params);
void glGetMapdv(GLenum target, GLenum query, GLdouble *v);
void glGetMapfv(GLenum target, GLenum query, GLfloat *v);
void glGetMapiv(GLenum target, GLenum query, GLint *v);
void glGetMaterialfv(GLenum face, GLenum pname, GLfloat *params);
void glGetMaterialiv(GLenum face, GLenum pname, GLint *params);
void glGetPixelMapfv(GLenum map, GLfloat *values);
void glGetPixelMapuiv(GLenum map, GLuint *values);
void glGetPixelMapusv(GLenum map, GLushort *values);
void glGetPointerv(GLenum pname, GLvoid **params);
void glGetPolygonStipple(GLubyte *mask);
const GLubyte * glGetString(GLenum name);
void glGetTexEnvfv(GLenum target, GLenum pname, GLfloat *params);
void glGetTexEnviv(GLenum target, GLenum pname, GLint *params);
void glGetTexGendv(GLenum coord, GLenum pname, GLdouble *params);
void glGetTexGenfv(GLenum coord, GLenum pname, GLfloat *params);
void glGetTexGeniv(GLenum coord, GLenum pname, GLint *params);
void glGetTexImage(GLenum target, GLint level, GLenum format, GLenum type, GLvoid *pixels);
void glGetTexParameterfv(GLenum target, GLenum pname, GLfloat *params);
void glGetTexParameteriv(GLenum target, GLenum pname, GLint *params);
void glHint(GLenum target, GLenum mode);
void glIndexMask(GLuint mask);
void glIndexPointer(GLenum type, GLsizei stride, const GLvoid *ptr);
void glIndexd(GLdouble c);
void glIndexdv(const GLdouble *c);
void glIndexf(GLfloat c);
void glIndexfv(const GLfloat *c);
void glIndexi(GLint c);
void glIndexiv(const GLint *c);
void glIndexs(GLshort c);
void glIndexsv(const GLshort *c);
void glIndexub(GLubyte c);
void glIndexubv(const GLubyte *c);
void glInitNames(void);
void glInterleavedArrays(GLenum format, GLsizei stride, const GLvoid *pointer);
GLboolean glIsEnabled(GLenum cap);
GLboolean glIsList(GLuint list);
GLboolean glIsTexture(GLuint texture);
void glLightModelf(GLenum pname, GLfloat param);
void glLightModelfv(GLenum pname, const GLfloat *params);
void glLightModeli(GLenum pname, GLint param);
void glLightModeliv(GLenum pname, const GLint *params);
void glLightf(GLenum light, GLenum pname, GLfloat param);
void glLightfv(GLenum light, GLenum pname, const GLfloat *params);
void glLighti(GLenum light, GLenum pname, GLint param);
void glLightiv(GLenum light, GLenum pname, const GLint *params);
void glLineStipple(GLint factor, GLushort pattern);
void glLineWidth(GLfloat width);
void glListBase(GLuint base);
void glLoadIdentity(void);
void glLoadMatrixd(const GLdouble *m);
void glLoadMatrixf(const GLfloat *m);
void glLoadName(GLuint name);
void glLogicOp(GLenum opcode);
void glMap1d(GLenum target, GLdouble u1, GLdouble u2, GLint stride, GLint order, const GLdouble *points);
void glMap1f(GLenum target, GLfloat u1, GLfloat u2, GLint stride, GLint order, const GLfloat *points);
void glMap2d(GLenum target, GLdouble u1, GLdouble u2, GLint ustride, GLint uorder, GLdouble v1, GLdouble v2, GLint vstride, GLint vorder, const GLdouble *points);
void glMap2f(GLenum target, GLfloat u1, GLfloat u2, GLint ustride, GLint uorder, GLfloat v1, GLfloat v2, GLint vstride, GLint vorder, const GLfloat *points);
void glMapGrid1d(GLint un, GLdouble u1, GLdouble u2);
void glMapGrid1f(GLint un, GLfloat u1, GLfloat u2);
void glMapGrid2d(GLint un, GLdouble u1, GLdouble u2, GLint vn, GLdouble v1, GLdouble v2);
void glMapGrid2f(GLint un, GLfloat u1, GLfloat u2, GLint vn, GLfloat v1, GLfloat v2);
void glMaterialf(GLenum face, GLenum pname, GLfloat param);
void glMaterialfv(GLenum face, GLenum pname, const GLfloat *params);
void glMateriali(GLenum face, GLenum pname, GLint param);
void glMaterialiv(GLenum face, GLenum pname, const GLint *params);
void glMatrixMode(GLenum mode);
void glMultMatrixd(const GLdouble *m);
void glMultMatrixf(const GLfloat *m);
void glNewList(GLuint list, GLenum mode);
void glNormal3b(GLbyte nx, GLbyte ny, GLbyte nz);
void glNormal3bv(const GLbyte *v);
void glNormal3d(GLdouble nx, GLdouble ny, GLdouble nz);
void glNormal3dv(const GLdouble *v);
void glNormal3f(GLfloat nx, GLfloat ny, GLfloat nz);
void glNormal3fv(const GLfloat *v);
void glNormal3i(GLint nx, GLint ny, GLint nz);
void glNormal3iv(const GLint *v);
void glNormal3s(GLshort nx, GLshort ny, GLshort nz);
void glNormal3sv(const GLshort *v);
void glNormalPointer(GLenum type, GLsizei stride, const GLvoid *ptr);
void glOrtho(GLdouble left, GLdouble right, GLdouble bottom, GLdouble top, GLdouble near_val, GLdouble far_val);
void glPassThrough(GLfloat token);
void glPixelMapfv(GLenum map, GLsizei mapsize, const GLfloat *values);
void glPixelMapuiv(GLenum map, GLsizei mapsize, const GLuint *values);
void glPixelMapusv(GLenum map, GLsizei mapsize, const GLushort *values);
void glPixelStoref(GLenum pname, GLfloat param);
void glPixelStorei(GLenum pname, GLint param);
void glPixelTransferf(GLenum pname, GLfloat param);
void glPixelTransferi(GLenum pname, GLint param);
void glPixelZoom(GLfloat xfactor, GLfloat yfactor);
void glPointSize(GLfloat size);
void glPolygonMode(GLenum face, GLenum mode);
void glPolygonOffset(GLfloat factor, GLfloat units);
void glPolygonStipple(const GLubyte *mask);
void glPopAttrib(void);
void glPopClientAttrib(void);
void glPopMatrix(void);
void glPopName(void);
void glPrioritizeTextures(GLsizei n, const GLuint *textures, const GLclampf *priorities);
void glPushAttrib(GLbitfield mask);
void glPushClientAttrib(GLbitfield mask);
void glPushMatrix(void);
void glPushName(GLuint name);
void glRasterPos2d(GLdouble x, GLdouble y);
void glRasterPos2dv(const GLdouble *v);
void glRasterPos2f(GLfloat x, GLfloat y);
void glRasterPos2fv(const GLfloat *v);
void glRasterPos2i(GLint x, GLint y);
void glRasterPos2iv(const GLint *v);
void glRasterPos2s(GLshort x, GLshort y);
void glRasterPos2sv(const GLshort *v);
void glRasterPos3d(GLdouble x, GLdouble y, GLdouble z);
void glRasterPos3dv(const GLdouble *v);
void glRasterPos3f(GLfloat x, GLfloat y, GLfloat z);
void glRasterPos3fv(const GLfloat *v);
void glRasterPos3i(GLint x, GLint y, GLint z);
void glRasterPos3iv(const GLint *v);
void glRasterPos3s(GLshort x, GLshort y, GLshort z);
void glRasterPos3sv(const GLshort *v);
void glRasterPos4d(GLdouble x, GLdouble y, GLdouble z, GLdouble w);
void glRasterPos4dv(const GLdouble *v);
void glRasterPos4f(GLfloat x, GLfloat y, GLfloat z, GLfloat w);
void glRasterPos4fv(const GLfloat *v);
void glRasterPos4i(GLint x, GLint y, GLint z, GLint w);
void glRasterPos4iv(const GLint *v);
void glRasterPos4s(GLshort x, GLshort y, GLshort z, GLshort w);
void glRasterPos4sv(const GLshort *v);
void glReadBuffer(GLenum mode);
void glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, GLvoid *pixels);
void glRectd(GLdouble x1, GLdouble y1, GLdouble x2, GLdouble y2);
void glRectdv(const GLdouble *v1, const GLdouble *v2);
void glRectf(GLfloat x1, GLfloat y1, GLfloat x2, GLfloat y2);
void glRectfv(const GLfloat *v1, const GLfloat *v2);
void glRecti(GLint x1, GLint y1, GLint x2, GLint y2);
void glRectiv(const GLint *v1, const GLint *v2);
void glRects(GLshort x1, GLshort y1, GLshort x2, GLshort y2);
void glRectsv(const GLshort *v1, const GLshort *v2);
GLint glRenderMode(GLenum mode);
void glRotated(GLdouble angle, GLdouble x, GLdouble y, GLdouble z);
void glRotatef(GLfloat angle, GLfloat x, GLfloat y, GLfloat z);
void glScaled(GLdouble x, GLdouble y, GLdouble z);
void glScalef(GLfloat x, GLfloat y, GLfloat z);
void glScissor(GLint x, GLint y, GLsizei width, GLsizei height);
void glSelectBuffer(GLsizei size, GLuint *buffer);
void glShadeModel(GLenum mode);
void glStencilFunc(GLenum func, GLint ref, GLuint mask);
void glStencilMask(GLuint mask);
void glStencilOp(GLenum fail, GLenum zfail, GLenum zpass);
void glTexCoord1d(GLdouble s);
void glTexCoord1dv(const GLdouble *v);
void glTexCoord1f(GLfloat s);
void glTexCoord1fv(const GLfloat *v);
void glTexCoord1i(GLint s);
void glTexCoord1iv(const GLint *v);
void glTexCoord1s(GLshort s);
void glTexCoord1sv(const GLshort *v);
void glTexCoord2d(GLdouble s, GLdouble t);
void glTexCoord2dv(const GLdouble *v);
void glTexCoord2f(GLfloat s, GLfloat t);
void glTexCoord2fv(const GLfloat *v);
void glTexCoord2i(GLint s, GLint t);
void glTexCoord2iv(const GLint *v);
void glTexCoord2s(GLshort s, GLshort t);
void glTexCoord2sv(const GLshort *v);
void glTexCoord3d(GLdouble s, GLdouble t, GLdouble r);
void glTexCoord3dv(const GLdouble *v);
void glTexCoord3f(GLfloat s, GLfloat t, GLfloat r);
void glTexCoord3fv(const GLfloat *v);
void glTexCoord3i(GLint s, GLint t, GLint r);
void glTexCoord3iv(const GLint *v);
void glTexCoord3s(GLshort s, GLshort t, GLshort r);
void glTexCoord3sv(const GLshort *v);
void glTexCoord4d(GLdouble s, GLdouble t, GLdouble r, GLdouble q);
void glTexCoord4dv(const GLdouble *v);
void glTexCoord4f(GLfloat s, GLfloat t, GLfloat r, GLfloat q);
void glTexCoord4fv(const GLfloat *v);
void glTexCoord4i(GLint s, GLint t, GLint r, GLint q);
void glTexCoord4iv(const GLint *v);
void glTexCoord4s(GLshort s, GLshort t, GLshort r, GLshort q);
void glTexCoord4sv(const GLshort *v);
void glTexCoordPointer(GLint size, GLenum type, GLsizei stride, const GLvoid *ptr);
void glTexEnvf(GLenum target, GLenum pname, GLfloat param);
void glTexEnvfv(GLenum target, GLenum pname, const GLfloat *params);
void glTexEnvi(GLenum target, GLenum pname, GLint param);
void glTexEnviv(GLenum target, GLenum pname, const GLint *params);
void glTexGend(GLenum coord, GLenum pname, GLdouble param);
void glTexGendv(GLenum coord, GLenum pname, const GLdouble *params);
void glTexGenf(GLenum coord, GLenum pname, GLfloat param);
void glTexGenfv(GLenum coord, GLenum pname, const GLfloat *params);
void glTexGeni(GLenum coord, GLenum pname, GLint param);
void glTexGeniv(GLenum coord, GLenum pname, const GLint *params);
void glTexImage1D(GLenum target, GLint level, GLint internalFormat, GLsizei width, GLint border, GLenum format, GLenum type, const GLvoid *pixels);
void glTexImage2D(GLenum target, GLint level, GLint internalFormat, GLsizei width, GLsizei height, GLint border, GLenum format, GLenum type, const GLvoid *pixels);
void glTexParameterf(GLenum target, GLenum pname, GLfloat param);
void glTexParameterfv(GLenum target, GLenum pname, const GLfloat *params);
void glTexParameteri(GLenum target, GLenum pname, GLint param);
void glTexParameteriv(GLenum target, GLenum pname, const GLint *params);
void glTexSubImage1D(GLenum target, GLint level, GLint xoffset, GLsizei width, GLenum format, GLenum type, const GLvoid *pixels);
void glTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLsizei width, GLsizei height, GLenum format, GLenum type, const GLvoid *pixels);
void glTranslated(GLdouble x, GLdouble y, GLdouble z);
void glTranslatef(GLfloat x, GLfloat y, GLfloat z);
void glVertex2d(GLdouble x, GLdouble y);
void glVertex2dv(const GLdouble *v);
void glVertex2f(GLfloat x, GLfloat y);
void glVertex2fv(const GLfloat *v);
void glVertex2i(GLint x, GLint y);
void glVertex2iv(const GLint *v);
void glVertex2s(GLshort x, GLshort y);
void glVertex2sv(const GLshort *v);
void glVertex3d(GLdouble x, GLdouble y, GLdouble z);
void glVertex3dv(const GLdouble *v);
void glVertex3f(GLfloat x, GLfloat y, GLfloat z);
void glVertex3fv(const GLfloat *v);
void glVertex3i(GLint x, GLint y, GLint z);
void glVertex3iv(const GLint *v);
void glVertex3s(GLshort x, GLshort y, GLshort z);
void glVertex3sv(const GLshort *v);
void glVertex4d(GLdouble x, GLdouble y, GLdouble z, GLdouble w);
void glVertex4dv(const GLdouble *v);
void glVertex4f(GLfloat x, GLfloat y, GLfloat z, GLfloat w);
void glVertex4fv(const GLfloat *v);
void glVertex4i(GLint x, GLint y, GLint z, GLint w);
void glVertex4iv(const GLint *v);
void glVertex4s(GLshort x, GLshort y, GLshort z, GLshort w);
void glVertex4sv(const GLshort *v);
void glVertexPointer(GLint size, GLenum type, GLsizei stride, const GLvoid *ptr);
void glViewport(GLint x, GLint y, GLsizei width, GLsizei height);
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
