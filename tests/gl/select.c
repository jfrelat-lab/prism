/*
 * Selection and feedback (GL 1.1 5.2, 5.3), printed: tools/gate-gl-select.mjs compares what PRISM
 * prints with what Mesa prints. Counts, names and tokens must be equal; depths and coordinates come
 * from float arithmetic that differs in its last bits, and are compared within a tolerance.
 *
 * Selection: the name stack (glInitNames, glPushName, glPopName, glLoadName); primitives inside,
 * partly inside and wholly outside the view volume, behind the near plane, culled, cut by a user
 * clip plane; points and lines; gluPickMatrix; names compiled into a display list; glRasterPos; an
 * overflowing buffer. Feedback: every vertex type, points, line strips (their reset token), clipped
 * polygons, glPassThrough, glBitmap and glDrawPixels, two-sided colour, and an overflowing buffer.
 */
#include <stdio.h>
#include <GL/glut.h>

static void hits(const char *what, GLint n, const GLuint *buf) {
  printf("select %s: %d\n", what, n);
  for (GLint h = 0, i = 0; h < n; h++) {
    GLuint k = buf[i];
    printf("  hit names %u z %u %u :", k, buf[i + 1], buf[i + 2]);
    for (GLuint j = 0; j < k; j++) printf(" %u", buf[i + 3 + j]);
    printf("\n");
    i += 3 + k;
  }
}
static void feedback(const char *what, GLint n, const GLfloat *buf) {
  printf("feedback %s: %d\n", what, n);
  for (GLint i = 0; i < n; i++) printf("%s%.4f", i % 8 ? " " : "  ", buf[i]), (i % 8 == 7 || i == n - 1) && printf("\n");
}
static void tri(float x, float y, float z, float s) {
  glBegin(GL_TRIANGLES); glVertex3f(x, y, z); glVertex3f(x + s, y, z); glVertex3f(x, y + s, z + 0.25f * s); glEnd();
}

static void display(void) {
  static GLuint sel[256];
  static GLfloat fb[1024];
  GLint n;
  glViewport(0, 0, 320, 240);
  glMatrixMode(GL_PROJECTION); glLoadIdentity(); glFrustum(-1.33, 1.33, -1, 1, 1.5, 20);
  glMatrixMode(GL_MODELVIEW); glLoadIdentity(); glTranslatef(0, 0, -5);

  /* Names and primitives. */
  glSelectBuffer(256, sel);
  printf("render mode %d\n", glRenderMode(GL_SELECT));
  glInitNames();
  tri(0, 0, 0, 1);                                     /* hit with an empty stack */
  glPushName(1);
  tri(-1, -1, 0.3f, 0.6f);
  tri(0.5f, 0.2f, -1.7f, 0.5f);                         /* the same record: min and max of both */
  glPushName(2);
  tri(40, 40, 0, 1);                                    /* wholly outside: no hit */
  glLoadName(3);
  tri(-1, 0, 0, 30);                                    /* partly inside: its clipped depths */
  glPopName();
  glLoadName(4);
  glBegin(GL_TRIANGLES); glVertex3f(-1, -1, 4.2f); glVertex3f(1, -1, 4.2f); glVertex3f(0, 1, 1.0f); glEnd();   /* through the near plane */
  glLoadName(5);
  glEnable(GL_CULL_FACE);
  glBegin(GL_TRIANGLES); glVertex3f(0, 0, 0); glVertex3f(0, 1, 0); glVertex3f(1, 0, 0); glEnd();               /* culled */
  glDisable(GL_CULL_FACE);
  glLoadName(6);
  glPointSize(4);
  glBegin(GL_POINTS); glVertex3f(0.2f, 0.1f, 0.5f); glVertex3f(50, 0, 0); glVertex3f(-0.3f, -0.4f, -2); glEnd();
  glLoadName(7);
  glBegin(GL_LINES); glVertex3f(-30, 0.5f, 0); glVertex3f(30, 0.6f, -1); glVertex3f(30, 30, 0); glVertex3f(40, 30, 0); glEnd();
  glLoadName(8);
  {
    static const GLdouble plane[4] = { 1, 0, 0, -0.5 };
    glClipPlane(GL_CLIP_PLANE0, plane); glEnable(GL_CLIP_PLANE0);
    tri(-1, -1, 0, 1);                                  /* x <= 0: removed */
    glPushName(9);
    tri(0, -1, 0, 1);                                   /* cut at x = 0.5 */
    glPopName();
    glDisable(GL_CLIP_PLANE0);
  }
  glLoadName(10);
  glRasterPos3f(0.1f, 0.2f, 0.7f);
  glLoadName(11);
  glRasterPos3f(0.1f, 0.2f, 9);                         /* behind the eye: not valid, no hit */
  glPolygonMode(GL_FRONT_AND_BACK, GL_LINE);
  glLoadName(12);
  glBegin(GL_QUADS); glVertex3f(-0.5f, -0.5f, 0.1f); glVertex3f(0.5f, -0.5f, 0.2f); glVertex3f(0.5f, 0.5f, 0.3f); glVertex3f(-0.5f, 0.5f, 0.4f); glEnd();
  glPolygonMode(GL_FRONT_AND_BACK, GL_FILL);
  glPopName();
  glPopName();
  {
    GLuint list = glGenLists(1);
    glNewList(list, GL_COMPILE);
    glPushName(20); tri(-0.2f, -0.2f, 0.2f, 0.4f); glLoadName(21); tri(0.1f, 0.1f, -0.4f, 0.3f); glPopName();
    glEndList();
    glCallList(list);
    glDeleteLists(list, 1);
  }
  glRectf(-0.1f, -0.1f, 0.1f, 0.1f);
  n = glRenderMode(GL_RENDER);
  hits("names", n, sel);
  printf("render mode after %d\n", glRenderMode(GL_RENDER));

  /* gluPickMatrix: a 10 x 10 region about a point, as a picking program builds it. */
  {
    GLint vp[4];
    glGetIntegerv(GL_VIEWPORT, vp);
    glSelectBuffer(256, sel);
    glRenderMode(GL_SELECT);
    glInitNames(); glPushName(0);
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity();
    gluPickMatrix(200, 130, 10, 10, vp); glFrustum(-1.33, 1.33, -1, 1, 1.5, 20);
    glMatrixMode(GL_MODELVIEW);
    for (int i = 0; i < 6; i++) { glLoadName(100 + i); tri(-1.5f + 0.5f * i, -0.2f + 0.05f * i, -0.3f * i, 0.45f); }
    glMatrixMode(GL_PROJECTION); glPopMatrix(); glMatrixMode(GL_MODELVIEW);
    hits("pick", glRenderMode(GL_RENDER), sel);
  }
  /* A buffer too small for its records. */
  glSelectBuffer(5, sel);
  glRenderMode(GL_SELECT);
  glInitNames(); glPushName(1); tri(0, 0, 0, 1); glPushName(2); tri(0, 0, 0.5f, 1);
  printf("select overflow: %d\n", glRenderMode(GL_RENDER));

  /* Feedback. */
  {
    static const GLenum types[5] = { GL_2D, GL_3D, GL_3D_COLOR, GL_3D_COLOR_TEXTURE, GL_4D_COLOR_TEXTURE };
    static const char *names[5] = { "2d", "3d", "3d-color", "3d-color-texture", "4d-color-texture" };
    for (int t = 0; t < 5; t++) {
      glFeedbackBuffer(1024, types[t], fb);
      glRenderMode(GL_FEEDBACK);
      glColor3f(0.2f, 0.4f, 0.6f); glTexCoord2f(0.25f, 0.75f);
      glBegin(GL_POINTS); glVertex3f(0.2f, 0.1f, 0.5f); glVertex3f(50, 0, 0); glEnd();
      glPassThrough(7.5f);
      glBegin(GL_LINE_STRIP); glColor3f(1, 0, 0); glVertex3f(-0.5f, 0, 0); glColor3f(0, 1, 0); glVertex3f(0, 0.5f, 0.2f); glColor3f(0, 0, 1); glVertex3f(0.5f, 0, -0.3f); glEnd();
      glBegin(GL_TRIANGLES); glColor3f(1, 1, 0); glTexCoord2f(0, 0); glVertex3f(-1, -0.5f, 0); glTexCoord2f(1, 0); glVertex3f(0.6f, -0.5f, 0.1f); glTexCoord2f(0, 1); glVertex3f(-1, 0.7f, -0.2f); glEnd();
      n = glRenderMode(GL_RENDER);
      feedback(names[t], n, fb);
    }
    /* Lines, loops, a polygon clipped by the view volume, a quad, glBitmap and glDrawPixels. */
    glFeedbackBuffer(1024, GL_3D_COLOR, fb);
    glRenderMode(GL_FEEDBACK);
    glColor3f(1, 1, 1);
    glBegin(GL_LINES); glVertex3f(-0.5f, -0.5f, 0); glVertex3f(0.5f, -0.4f, 0); glVertex3f(-0.5f, 0.5f, 0); glVertex3f(0.5f, 0.6f, 0); glEnd();
    glBegin(GL_LINE_LOOP); glVertex3f(-0.2f, -0.2f, 0); glVertex3f(0.2f, -0.2f, 0); glVertex3f(0, 0.3f, 0); glEnd();
    glBegin(GL_POLYGON); glVertex3f(-3, -0.3f, 0); glVertex3f(3, -0.3f, 0); glVertex3f(3, 0.4f, 0); glVertex3f(0, 0.9f, 0); glVertex3f(-3, 0.4f, 0); glEnd();
    glBegin(GL_QUADS); glVertex3f(-0.4f, -0.4f, 0.1f); glVertex3f(0.4f, -0.4f, 0.1f); glVertex3f(0.4f, 0.4f, 0.1f); glVertex3f(-0.4f, 0.4f, 0.1f); glEnd();
    {
      static const GLubyte bits[8] = { 0xff, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xff };
      static const GLubyte pixels[16] = { 0 };
      glColor3f(0.5f, 0.25f, 1);
      glRasterPos3f(0.1f, 0.2f, 0.3f);
      glBitmap(8, 8, 0, 0, 10, 0, bits);
      glDrawPixels(2, 2, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    }
    n = glRenderMode(GL_RENDER);
    feedback("primitives", n, fb);
    /* Two-sided lighting: a back face reports its back colour. */
    {
      static const GLfloat front[4] = { 0.9f, 0.1f, 0.1f, 1 }, back[4] = { 0.1f, 0.1f, 0.9f, 1 };
      glFeedbackBuffer(1024, GL_3D_COLOR, fb);
      glRenderMode(GL_FEEDBACK);
      glEnable(GL_LIGHTING); glEnable(GL_LIGHT0); glLightModeli(GL_LIGHT_MODEL_TWO_SIDE, 1);
      glMaterialfv(GL_FRONT, GL_AMBIENT_AND_DIFFUSE, front); glMaterialfv(GL_BACK, GL_AMBIENT_AND_DIFFUSE, back);
      glNormal3f(0, 0, 1);
      glBegin(GL_TRIANGLES); glVertex3f(0, 0, 0); glVertex3f(0, 0.5f, 0); glVertex3f(0.5f, 0, 0); glEnd();
      glDisable(GL_LIGHTING); glLightModeli(GL_LIGHT_MODEL_TWO_SIDE, 0);
      feedback("two-sided", glRenderMode(GL_RENDER), fb);
    }
    glFeedbackBuffer(10, GL_3D, fb);
    glRenderMode(GL_FEEDBACK);
    tri(0, 0, 0, 1); tri(0, 0, 0.5f, 1);
    printf("feedback overflow: %d\n", glRenderMode(GL_RENDER));
  }
  fflush(stdout);
  glClear(GL_COLOR_BUFFER_BIT);
  glutSwapBuffers();
}

int main(int argc, char **argv) {
  glutInit(&argc, argv);
  glutInitDisplayMode(GLUT_RGB | GLUT_DOUBLE | GLUT_DEPTH);
  glutInitWindowSize(320, 240);
  glutCreateWindow("select");
  glutDisplayFunc(display);
  glutMainLoop();
  return 0;
}
