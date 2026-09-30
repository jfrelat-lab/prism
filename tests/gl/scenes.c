/*
 * scenes.c -- one fixed-function OpenGL 1.1 scene per argument, drawn by Mesa (tools/oracle/glut-egl.c)
 * and by PRISM (src/env/gl.js) for tools/gate-gl-scenes.mjs. Each scene isolates one part of the
 * pipeline GLQuake leans on, so a difference names that part:
 *
 *   tex-nearest   a 64x64 checker, receding in perspective, GL_NEAREST (no mipmaps)
 *   tex-linear    the same, GL_LINEAR
 *   mip-nn        the same with its own mip chain, GL_NEAREST_MIPMAP_NEAREST
 *   mip-ln        GL_LINEAR_MIPMAP_NEAREST (Quake's default)
 *   mip-ll        GL_LINEAR_MIPMAP_LINEAR
 *   lightmap      a textured floor, then a LUMINANCE lightmap blended on it with
 *                 glBlendFunc(GL_ZERO, GL_ONE_MINUS_SRC_COLOR), as gl_rsurf.c does
 *   alpha         an RGBA texture with holes under glAlphaFunc(GL_GREATER, 0.666)
 *   blend         a half-transparent quad over another, GL_SRC_ALPHA / GL_ONE_MINUS_SRC_ALPHA
 *   fog           linear fog on a receding floor
 *   clip          a floor that passes through the near plane, and a quad partly behind the eye
 *   depth         glDepthRange(0, 0.3) and GL_LEQUAL, as Quake draws its view model
 *
 * Every level of a mip chain is a different colour, so a wrong level choice is a wrong colour.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <GL/glut.h>

static const char *scene = "tex-nearest";
static unsigned char tex[64 * 64 * 4];

static void checker(int size, int level) {
  static const unsigned char tint[7][3] = { {255,255,255}, {255,80,80}, {80,255,80}, {80,80,255}, {255,255,80}, {255,80,255}, {80,255,255} };
  for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) {
    int on = ((x * 8 / size) ^ (y * 8 / size)) & 1;
    unsigned char *p = tex + (y * size + x) * 4;
    for (int k = 0; k < 3; k++) p[k] = on ? tint[level % 7][k] : tint[level % 7][k] / 4;
    p[3] = 255;
  }
}
static void upload(int mip) {
  for (int level = 0, size = 64; size >= 1; level++, size /= 2) {
    checker(size, mip ? level : 0);
    glTexImage2D(GL_TEXTURE_2D, level, 4, size, size, 0, GL_RGBA, GL_UNSIGNED_BYTE, tex);
    if (!mip) break;
  }
}
static void floorQuad(float z0, float z1, float repeat) {
  glBegin(GL_QUADS);
  glTexCoord2f(0, 0); glVertex3f(-4, -1, z0);
  glTexCoord2f(repeat, 0); glVertex3f(4, -1, z0);
  glTexCoord2f(repeat, repeat); glVertex3f(4, -1, z1);
  glTexCoord2f(0, repeat); glVertex3f(-4, -1, z1);
  glEnd();
}
static void display(void) {
  glClearColor(0.1, 0.1, 0.2, 1);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
  glEnable(GL_DEPTH_TEST);
  glColor4f(1, 1, 1, 1);
  glTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
  if (!strncmp(scene, "tex-", 4) || !strncmp(scene, "mip-", 4)) {
    int mip = !strncmp(scene, "mip-", 4);
    GLenum min = !strcmp(scene, "tex-nearest") ? GL_NEAREST : !strcmp(scene, "tex-linear") ? GL_LINEAR
      : !strcmp(scene, "mip-nn") ? GL_NEAREST_MIPMAP_NEAREST : !strcmp(scene, "mip-ln") ? GL_LINEAR_MIPMAP_NEAREST : GL_LINEAR_MIPMAP_LINEAR;
    glBindTexture(GL_TEXTURE_2D, 1);
    upload(mip);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, min);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, min == GL_NEAREST || min == GL_NEAREST_MIPMAP_NEAREST ? GL_NEAREST : GL_LINEAR);
    glEnable(GL_TEXTURE_2D);
    floorQuad(-1.5, -60, 24);
  } else if (!strcmp(scene, "lightmap")) {
    static unsigned char lm[16 * 16];
    for (int i = 0; i < 16 * 16; i++) lm[i] = (unsigned char)((i % 16) * 16);
    glBindTexture(GL_TEXTURE_2D, 1); upload(1);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_NEAREST);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glEnable(GL_TEXTURE_2D);
    floorQuad(-1.5, -30, 12);
    glBindTexture(GL_TEXTURE_2D, 2);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE, 16, 16, 0, GL_LUMINANCE, GL_UNSIGNED_BYTE, lm);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glEnable(GL_BLEND);
    glBlendFunc(GL_ZERO, GL_ONE_MINUS_SRC_COLOR);
    glDepthFunc(GL_LEQUAL);
    floorQuad(-1.5, -30, 1);
    glDisable(GL_BLEND); glDepthFunc(GL_LESS);
  } else if (!strcmp(scene, "alpha")) {
    for (int i = 0; i < 64 * 64; i++) { tex[i * 4] = 200; tex[i * 4 + 1] = 120; tex[i * 4 + 2] = 40; tex[i * 4 + 3] = (unsigned char)(((i % 64) / 8 + (i / 64) / 8) * 16); }
    glBindTexture(GL_TEXTURE_2D, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, 4, 64, 64, 0, GL_RGBA, GL_UNSIGNED_BYTE, tex);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glEnable(GL_TEXTURE_2D);
    glEnable(GL_ALPHA_TEST); glAlphaFunc(GL_GREATER, 0.666);
    floorQuad(-1.5, -20, 2);
    glDisable(GL_ALPHA_TEST);
  } else if (!strcmp(scene, "blend")) {
    glDisable(GL_TEXTURE_2D);
    glColor4f(0.9, 0.2, 0.1, 1); glBegin(GL_QUADS); glVertex3f(-2, -1, -6); glVertex3f(1, -1, -6); glVertex3f(1, 1.5, -6); glVertex3f(-2, 1.5, -6); glEnd();
    glEnable(GL_BLEND); glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glColor4f(0.1, 0.4, 1, 0.4); glBegin(GL_TRIANGLES); glVertex3f(-1, -1.5, -5); glVertex3f(2.5, -1, -5); glVertex3f(0.5, 2, -5); glEnd();
    glDisable(GL_BLEND);
  } else if (!strcmp(scene, "fog")) {
    GLfloat fc[4] = { 0.5, 0.5, 0.6, 1 };
    glBindTexture(GL_TEXTURE_2D, 1); upload(0);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glEnable(GL_TEXTURE_2D);
    glEnable(GL_FOG); glFogi(GL_FOG_MODE, GL_LINEAR); glFogf(GL_FOG_START, 2); glFogf(GL_FOG_END, 30); glFogfv(GL_FOG_COLOR, fc);
    floorQuad(-1.5, -40, 16);
    glDisable(GL_FOG);
  } else if (!strcmp(scene, "clip")) {
    glDisable(GL_TEXTURE_2D);
    glBegin(GL_QUADS);
    glColor3f(1, 0.5, 0); glVertex3f(-4, -1, 3); glColor3f(0, 0.5, 1); glVertex3f(4, -1, 3);
    glColor3f(1, 1, 0); glVertex3f(4, -1, -20); glColor3f(0, 1, 0.5); glVertex3f(-4, -1, -20);
    glEnd();
    glBegin(GL_TRIANGLES);
    glColor3f(1, 0, 1); glVertex3f(-1, 0, -3); glColor3f(1, 1, 1); glVertex3f(1, 0.5, 2); glColor3f(0, 1, 1); glVertex3f(1.5, 1.5, -4);
    glEnd();
  } else if (!strcmp(scene, "depth")) {
    glDisable(GL_TEXTURE_2D);
    glColor3f(0.3, 0.8, 0.3); glBegin(GL_QUADS); glVertex3f(-3, -2, -4); glVertex3f(3, -2, -4); glVertex3f(3, 2, -4); glVertex3f(-3, 2, -4); glEnd();
    glDepthRange(0, 0.3); glDepthFunc(GL_LEQUAL);
    glColor3f(0.9, 0.9, 0.2); glBegin(GL_TRIANGLES); glVertex3f(-1, -1, -8); glVertex3f(1.5, -1, -8); glVertex3f(0, 1.5, -8); glEnd();
    glDepthRange(0, 1); glDepthFunc(GL_LESS);
  }
  glutSwapBuffers();
}
static void reshape(int w, int h) {
  glViewport(0, 0, w, h);
  glMatrixMode(GL_PROJECTION); glLoadIdentity(); glFrustum(-1, 1, -0.75, 0.75, 1, 100);
  glMatrixMode(GL_MODELVIEW); glLoadIdentity();
}
int main(int argc, char **argv) {
  glutInit(&argc, argv);
  if (argc > 1) scene = argv[1];
  glutInitWindowSize(320, 240);
  glutInitDisplayMode(GLUT_RGB | GLUT_DEPTH | GLUT_DOUBLE);
  glutCreateWindow("scenes");
  glutReshapeFunc(reshape);
  glutDisplayFunc(display);
  glutMainLoop();
  return 0;
}
