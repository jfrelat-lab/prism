/* The GLUT subset tools/oracle/glut-egl.c answers; the constants are GLUT 3.7's (and freeglut's). */
#ifndef PRISM_ORACLE_GLUT_H
#define PRISM_ORACLE_GLUT_H
#include <GL/gl.h>
#include <GL/glu.h>

#define GLUT_RGB 0
#define GLUT_RGBA 0
#define GLUT_DOUBLE 2
#define GLUT_DEPTH 16
#define GLUT_ALPHA 8
#define GLUT_STENCIL 32
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
int glutGetWindow(void);
void glutSetWindow(int win);
void glutSetWindowTitle(const char *title);
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
