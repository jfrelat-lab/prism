// headers-gl.js — <GL/gl.h> (OpenGL 1.1, the fixed-function subset PRISM implements) and <GL/glut.h>.
//
// Every value here is the one the OpenGL 1.1 specification assigns, and tools/gate-gl-abi.mjs holds
// each #define to Mesa's own <GL/gl.h> in the oracle container, so a transcription slip is a red
// gate rather than a wrong colour. The GLUT constants are GLUT 3.7's (freeglut keeps them).
// Only what is implemented is declared: a program that calls anything else fails at link time,
// naming the function, instead of calling a stub.

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
#define GL_DEPTH_TEST 0x0B71
#define GL_NORMALIZE 0x0BA1

/* faces, shading */
#define GL_FRONT 0x0404
#define GL_BACK 0x0405
#define GL_FRONT_AND_BACK 0x0408
#define GL_CW 0x0900
#define GL_CCW 0x0901
#define GL_FLAT 0x1D00
#define GL_SMOOTH 0x1D01

/* lighting */
#define GL_LIGHT0 0x4000
#define GL_AMBIENT 0x1200
#define GL_DIFFUSE 0x1201
#define GL_SPECULAR 0x1202
#define GL_POSITION 0x1203
#define GL_EMISSION 0x1600
#define GL_SHININESS 0x1601
#define GL_AMBIENT_AND_DIFFUSE 0x1602

/* matrices */
#define GL_MODELVIEW 0x1700
#define GL_PROJECTION 0x1701

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
void glMatrixMode(GLenum mode);
void glLoadIdentity(void);
void glPushMatrix(void);
void glPopMatrix(void);
void glTranslatef(GLfloat x, GLfloat y, GLfloat z);
void glRotatef(GLfloat angle, GLfloat x, GLfloat y, GLfloat z);
void glScalef(GLfloat x, GLfloat y, GLfloat z);
void glFrustum(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f);
void glOrtho(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f);
void glBegin(GLenum mode);
void glEnd(void);
void glVertex3f(GLfloat x, GLfloat y, GLfloat z);
void glVertex2f(GLfloat x, GLfloat y);
void glNormal3f(GLfloat x, GLfloat y, GLfloat z);
void glColor3f(GLfloat r, GLfloat g, GLfloat b);
void glColor4f(GLfloat r, GLfloat g, GLfloat b, GLfloat a);
void glLightfv(GLenum light, GLenum pname, const GLfloat *params);
void glMaterialfv(GLenum face, GLenum pname, const GLfloat *params);
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
