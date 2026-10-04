/*
 * ztrick.c -- GLQuake's depth-buffer trick, on its own, for tools/gate-webgl-stream.mjs.
 *
 * With gl_ztrick (its default) the GLQuake family never clears the depth buffer: even frames are
 * drawn into the depth range [0, 0.5] with GL_LEQUAL and odd frames into [1, 0.5] -- NEAR GREATER
 * THAN FAR -- with GL_GEQUAL. GL 1.1 allows the reversed range; WebGL refuses it. This draws four
 * such frames: a far triangle, then a near one that must hide part of it, every frame.
 */
#include <GL/glut.h>

static int frame;

static void display(void) {
  if (frame & 1) { glDepthRange(1.0, 0.5); glDepthFunc(GL_GEQUAL); }
  else { glDepthRange(0.0, 0.5); glDepthFunc(GL_LEQUAL); }
  glClear(GL_COLOR_BUFFER_BIT);                 /* colour only: the depth buffer is never cleared */
  glColor3f(1.0f, 0.0f, 0.0f);
  glBegin(GL_TRIANGLES); glVertex3f(-0.8f, -0.8f, -0.5f); glVertex3f(0.8f, -0.8f, -0.5f); glVertex3f(0.0f, 0.8f, -0.5f); glEnd();
  glColor3f(0.0f, 1.0f, 0.0f);
  glBegin(GL_TRIANGLES); glVertex3f(-0.4f, -0.4f, 0.5f); glVertex3f(0.4f, -0.4f, 0.5f); glVertex3f(0.0f, 0.4f, 0.5f); glEnd();
  glutSwapBuffers();
  frame++;
  glutPostRedisplay();
}

int main(int argc, char **argv) {
  glutInit(&argc, argv);
  glutInitDisplayMode(GLUT_RGB | GLUT_DOUBLE | GLUT_DEPTH);
  glutInitWindowSize(64, 64);
  glutCreateWindow("ztrick");
  glEnable(GL_DEPTH_TEST);
  glMatrixMode(GL_PROJECTION); glLoadIdentity(); glOrtho(-1, 1, -1, 1, -1, 1);
  glMatrixMode(GL_MODELVIEW);
  glutDisplayFunc(display);
  glutMainLoop();
  return 0;
}
