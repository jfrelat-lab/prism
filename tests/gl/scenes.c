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
 * And what Tux Racer added (its terrain is textured by position, its ice by reflection):
 *
 *   texgen-object a floor with no texture coordinates, textured by GL_OBJECT_LINEAR planes
 *   texgen-sphere a dome with normals under GL_SPHERE_MAP, the environment map of the ice
 *   arrays-normal the same dome lit, drawn by glDrawElements from vertex and normal arrays
 *   colour-material  the dome lit under GL_COLOR_MATERIAL, its colour and ALPHA per vertex, blended
 *                 over a quad -- how the terrain's snow, ice and rock layers fade into each other
 *   matrix-rect   glMultMatrixd, glRectf and glRecti, and a 2x2 RGB texture whose rows are padded
 *                 to GL_UNPACK_ALIGNMENT (4, then 1)
 *
 * And what Neverball requires (ARB_vertex_buffer_object, ARB_point_parameters, ARB_point_sprite):
 *
 *   vbo           the dome from buffers: positions in one, colours in another (half of them
 *                 replaced by glBufferSubData), indices in an element buffer, offsets not zero
 *   points        points of size 1 to 8, then a receding row whose size falls with distance
 *   point-sprite  textured points under GL_POINT_SPRITE and GL_COORD_REPLACE, blended, receding
 *   array-types   a 2D panel as Neverball's interface draws one: GL_SHORT positions, GL_UNSIGNED_BYTE
 *                 colours (normalized), GL_FLOAT texture coordinates, interleaved, under glOrtho
 *
 * And what the 4K intros of 2004 do (a frame fed back into the next):
 *
 *   copytex       a smooth-shaded triangle copied out of the framebuffer by glCopyTexSubImage2D into
 *                 part of a checker texture, and by glCopyTexImage2D into a texture of its own (RGB),
 *                 then both drawn, GL_NEAREST, on a cleared screen
 *
 * And what Retrospection (2009) does to fill its window:
 *
 *   far           identity matrices, a glRecti 10^7 times the clip volume and a smooth-shaded triangle
 *                 with one vertex 10^7 above it: both clipped to the volume
 *
 * And what a 2009 intro does with its noise:
 *
 *   generate-mipmap  an 8x8 texture given as GL_FLOAT texels (some below 0, some above 1) to a texture
 *                 with GL_GENERATE_MIPMAP, drawn GL_NEAREST_MIPMAP_NEAREST in three bands that read
 *                 levels 1, 2 and 3 -- levels the program never gave
 *
 * Every level of a mip chain is a different colour, so a wrong level choice is a wrong colour.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#define GL_GLEXT_PROTOTYPES
#include <GL/glut.h>
#include <GL/glext.h>
/* Mesa's libOpenGL exports these by their core (GL 1.4/1.5) names, the same functions; PRISM by the ARB ones. */
#ifndef __PRISM__
#define glGenBuffersARB glGenBuffers
#define glBindBufferARB glBindBuffer
#define glBufferDataARB glBufferData
#define glBufferSubDataARB glBufferSubData
#define glDeleteBuffersARB glDeleteBuffers
#define glPointParameterfARB glPointParameterf
#define glPointParameterfvARB glPointParameterfv
#endif

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
/* A 17x17 dome over [-2,2]x[-2,2]: z = 0.5 - (x*x + y*y) / 16, with its unit normals. */
static GLfloat domeV[17 * 17][3], domeN[17 * 17][3];
static GLuint domeI[16 * 16 * 6];
static void dome(void) {
  int n = 0;
  for (int j = 0; j <= 16; j++) for (int i = 0; i <= 16; i++) {
    float x = -2 + i * 0.25f, y = -2 + j * 0.25f, nx = x / 8, ny = y / 8;
    float l = (float)sqrt(nx * nx + ny * ny + 1);
    GLfloat *v = domeV[j * 17 + i], *nn = domeN[j * 17 + i];
    v[0] = x; v[1] = y; v[2] = 0.5f - (x * x + y * y) / 16;
    nn[0] = nx / l; nn[1] = ny / l; nn[2] = 1 / l;
  }
  for (int j = 0; j < 16; j++) for (int i = 0; i < 16; i++) {
    GLuint a = j * 17 + i, b = a + 1, c = a + 17, d = c + 1;
    domeI[n++] = a; domeI[n++] = b; domeI[n++] = d; domeI[n++] = a; domeI[n++] = d; domeI[n++] = c;
  }
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
  } else if (!strcmp(scene, "texgen-object")) {
    GLfloat sp[4] = { 0.5f, 0, 0, 0.25f }, tp[4] = { 0, 0, 0.125f, 0 };
    glBindTexture(GL_TEXTURE_2D, 1); upload(0);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glEnable(GL_TEXTURE_2D);
    glTexGeni(GL_S, GL_TEXTURE_GEN_MODE, GL_OBJECT_LINEAR); glTexGenfv(GL_S, GL_OBJECT_PLANE, sp);
    glTexGeni(GL_T, GL_TEXTURE_GEN_MODE, GL_OBJECT_LINEAR); glTexGenfv(GL_T, GL_OBJECT_PLANE, tp);
    glEnable(GL_TEXTURE_GEN_S); glEnable(GL_TEXTURE_GEN_T);
    glBegin(GL_QUADS); glVertex3f(-4, -1, -1.5f); glVertex3f(4, -1, -1.5f); glVertex3f(4, -1, -40); glVertex3f(-4, -1, -40); glEnd();
    glDisable(GL_TEXTURE_GEN_S); glDisable(GL_TEXTURE_GEN_T);
  } else if (!strcmp(scene, "texgen-sphere") || !strcmp(scene, "arrays-normal")) {
    dome();
    glPushMatrix();
    glTranslatef(0, 0, -4.5f); glRotatef(-35, 1, 0, 0); glRotatef(20, 0, 0, 1);
    if (!strcmp(scene, "texgen-sphere")) {
      glBindTexture(GL_TEXTURE_2D, 1); upload(0);
      glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
      glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
      glEnable(GL_TEXTURE_2D);
      glTexGeni(GL_S, GL_TEXTURE_GEN_MODE, GL_SPHERE_MAP); glTexGeni(GL_T, GL_TEXTURE_GEN_MODE, GL_SPHERE_MAP);
      glEnable(GL_TEXTURE_GEN_S); glEnable(GL_TEXTURE_GEN_T);
      for (int j = 0; j < 16; j++) {
        glBegin(GL_QUAD_STRIP);
        for (int i = 0; i <= 16; i++) {
          glNormal3fv(domeN[j * 17 + i]); glVertex3fv(domeV[j * 17 + i]);
          glNormal3fv(domeN[(j + 1) * 17 + i]); glVertex3fv(domeV[(j + 1) * 17 + i]);
        }
        glEnd();
      }
      glDisable(GL_TEXTURE_GEN_S); glDisable(GL_TEXTURE_GEN_T);
    } else {
      GLfloat diffuse[4] = { 0.3f, 0.6f, 0.9f, 1 }, dir[4] = { 0.4f, 0.3f, 1, 0 };
      glDisable(GL_TEXTURE_2D);
      glEnable(GL_LIGHTING); glEnable(GL_LIGHT0);
      glLightfv(GL_LIGHT0, GL_POSITION, dir);
      glMaterialfv(GL_FRONT_AND_BACK, GL_AMBIENT_AND_DIFFUSE, diffuse);
      glEnableClientState(GL_VERTEX_ARRAY); glEnableClientState(GL_NORMAL_ARRAY);
      glVertexPointer(3, GL_FLOAT, 0, domeV); glNormalPointer(GL_FLOAT, 0, domeN);
      glDrawElements(GL_TRIANGLES, 16 * 16 * 6, GL_UNSIGNED_INT, domeI);
      glDisableClientState(GL_VERTEX_ARRAY); glDisableClientState(GL_NORMAL_ARRAY);
      glDisable(GL_LIGHTING);
    }
    glPopMatrix();
  } else if (!strcmp(scene, "colour-material")) {
    GLfloat dir[4] = { 0.4f, 0.3f, 1, 0 };
    dome();
    glDisable(GL_TEXTURE_2D);
    glColor4f(0.9f, 0.5f, 0.1f, 1);
    glBegin(GL_QUADS); glVertex3f(-3, -2, -7); glVertex3f(3, -2, -7); glVertex3f(3, 2, -7); glVertex3f(-3, 2, -7); glEnd();
    glPushMatrix();
    glTranslatef(0, 0, -4.5f); glRotatef(-35, 1, 0, 0); glRotatef(20, 0, 0, 1);
    glEnable(GL_LIGHTING); glEnable(GL_LIGHT0);
    glLightfv(GL_LIGHT0, GL_POSITION, dir);
    glEnable(GL_COLOR_MATERIAL);
    glEnable(GL_BLEND); glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    for (int j = 0; j < 16; j++) {
      glBegin(GL_QUAD_STRIP);
      for (int i = 0; i <= 16; i++) {
        for (int k = 0; k < 2; k++) {
          int jj = j + k;
          glColor4f(i / 16.0f, 1 - jj / 16.0f, 0.8f, (i + jj) / 32.0f);
          glNormal3fv(domeN[jj * 17 + i]); glVertex3fv(domeV[jj * 17 + i]);
        }
      }
      glEnd();
    }
    glDisable(GL_BLEND); glDisable(GL_COLOR_MATERIAL); glDisable(GL_LIGHTING);
    glPopMatrix();
  } else if (!strcmp(scene, "matrix-rect")) {
    static const GLdouble m[16] = { 0.8, 0.3, 0, 0, -0.3, 0.8, 0, 0, 0, 0, 1, 0, -1.2, 0.3, -5, 1 };
    /* 2x2 RGB: a row is 6 bytes, padded to 8 under the default alignment of 4. */
    static const unsigned char padded[16] = { 255,0,0, 0,255,0, 99,99,  0,0,255, 255,255,0, 99,99 };
    static const unsigned char tight[12] = { 255,0,255, 0,255,255,  255,255,255, 60,60,60 };
    GLfloat sp[4] = { 0.5f, 0, 0, 0.5f }, tp[4] = { 0, 0.5f, 0, 0.5f };
    glTexGeni(GL_S, GL_TEXTURE_GEN_MODE, GL_OBJECT_LINEAR); glTexGenfv(GL_S, GL_OBJECT_PLANE, sp);
    glTexGeni(GL_T, GL_TEXTURE_GEN_MODE, GL_OBJECT_LINEAR); glTexGenfv(GL_T, GL_OBJECT_PLANE, tp);
    glEnable(GL_TEXTURE_GEN_S); glEnable(GL_TEXTURE_GEN_T); glEnable(GL_TEXTURE_2D);
    glPushMatrix();
    glMultMatrixd(m);
    glBindTexture(GL_TEXTURE_2D, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, 2, 2, 0, GL_RGB, GL_UNSIGNED_BYTE, padded);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glRectf(-1, -1, 1, 1);
    glPopMatrix();
    glPushMatrix();
    glTranslatef(1.6f, -0.4f, -5);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glBindTexture(GL_TEXTURE_2D, 2);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, 2, 2, 0, GL_RGB, GL_UNSIGNED_BYTE, tight);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glRecti(-1, -1, 1, 1);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
    glPopMatrix();
    glDisable(GL_TEXTURE_GEN_S); glDisable(GL_TEXTURE_GEN_T);
  } else if (!strcmp(scene, "far")) {
    /* Identity matrices: a rectangle 10^7 times the clip volume (at 10^8 Mesa's llvmpipe itself
       loses a corner of it), then a triangle with one vertex 10^7
       above it, smooth-shaded -- clipped to the volume, the colours as they are where it crosses. */
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity();
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glDisable(GL_DEPTH_TEST);
    glColor3f(0.5f, 0.5f, 0.5f);
    glRecti(-10000000, -10000000, 10000000, 10000000);
    glBegin(GL_TRIANGLES);
    glColor3f(1, 0, 0); glVertex2f(-0.9f, -0.9f);
    glColor3f(0, 1, 0); glVertex2f(0.9f, -0.9f);
    glColor3f(0, 0, 1); glVertex2f(0, 1e7f);
    glEnd();
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "generate-mipmap")) {
    static GLfloat texels[8 * 8 * 3];
    for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
      GLfloat *t = texels + (j * 8 + i) * 3;
      t[0] = ((i * 37 + j * 91) % 64) / 63.0f; t[1] = (i - 2) / 4.0f; t[2] = (j * j) / 40.0f;
    }
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glOrtho(0, 320, 0, 240, -1, 1);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glDisable(GL_DEPTH_TEST);
    glBindTexture(GL_TEXTURE_2D, 1);
    glTexParameteri(GL_TEXTURE_2D, GL_GENERATE_MIPMAP, GL_TRUE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST_MIPMAP_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, 8, 8, 0, GL_RGB, GL_FLOAT, texels);
    glEnable(GL_TEXTURE_2D);
    glTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);
    /* Band b is 80 pixels high and the whole width; 2^(b+1) texels a pixel each way, so level b + 1. */
    for (int b = 0; b < 3; b++) {
      float r = (float)(2 << b) / 8, y0 = 80 * b, y1 = y0 + 80;
      glBegin(GL_QUADS);
      glTexCoord2f(0, 0); glVertex2f(0, y0);
      glTexCoord2f(320 * r, 0); glVertex2f(320, y0);
      glTexCoord2f(320 * r, 80 * r); glVertex2f(320, y1);
      glTexCoord2f(0, 80 * r); glVertex2f(0, y1);
      glEnd();
    }
    glDisable(GL_TEXTURE_2D);
    glTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "copytex")) {
    glDisable(GL_DEPTH_TEST);
    glBegin(GL_TRIANGLES);
    glColor3f(1, 0.2f, 0.2f); glVertex3f(-2.5f, -1.6f, -3);
    glColor3f(0.2f, 1, 0.2f); glVertex3f(2.5f, -1.4f, -3);
    glColor3f(0.2f, 0.2f, 1); glVertex3f(0.2f, 2, -3);
    glEnd();
    glColor4f(1, 1, 1, 1);
    glBindTexture(GL_TEXTURE_2D, 3);
    upload(0);
    glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 8, 4, 120, 80, 48, 40);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glBindTexture(GL_TEXTURE_2D, 4);
    glCopyTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, 96, 64, 64, 64, 0);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_TEXTURE_2D);
    for (int k = 0; k < 2; k++) {
      float x = k ? 0.2f : -2.6f;
      glBindTexture(GL_TEXTURE_2D, 3 + k);
      glBegin(GL_QUADS);
      glTexCoord2f(0, 0); glVertex3f(x, -1.2f, -3);
      glTexCoord2f(1, 0); glVertex3f(x + 2.4f, -1.2f, -3);
      glTexCoord2f(1, 1); glVertex3f(x + 2.4f, 1.2f, -3);
      glTexCoord2f(0, 1); glVertex3f(x, 1.2f, -3);
      glEnd();
    }
    glDisable(GL_TEXTURE_2D);
  } else if (!strcmp(scene, "vbo")) {
    static GLfloat col[17 * 17][4];
    GLuint b[3];
    dome();
    for (int i = 0; i < 17 * 17; i++) { col[i][0] = (i % 17) / 16.0f; col[i][1] = (i / 17) / 16.0f; col[i][2] = 0.5f; col[i][3] = 1; }
    glGenBuffersARB(3, b);
    /* Positions after 64 bytes of something else, so the array's offset is not zero. */
    glBindBufferARB(GL_ARRAY_BUFFER_ARB, b[0]);
    glBufferDataARB(GL_ARRAY_BUFFER_ARB, 64 + sizeof domeV, NULL, GL_STATIC_DRAW_ARB);
    glBufferSubDataARB(GL_ARRAY_BUFFER_ARB, 64, sizeof domeV, domeV);
    glVertexPointer(3, GL_FLOAT, 0, (const void *)64);
    glBindBufferARB(GL_ARRAY_BUFFER_ARB, b[1]);
    glBufferDataARB(GL_ARRAY_BUFFER_ARB, sizeof col, col, GL_STATIC_DRAW_ARB);
    for (int i = 0; i < 17 * 8; i++) { col[i][0] = 1; col[i][1] = 1; col[i][2] = 1; }
    glBufferSubDataARB(GL_ARRAY_BUFFER_ARB, 0, 17 * 8 * 4 * sizeof (GLfloat), col);
    glColorPointer(4, GL_FLOAT, 0, 0);
    glBindBufferARB(GL_ARRAY_BUFFER_ARB, 0);
    glBindBufferARB(GL_ELEMENT_ARRAY_BUFFER_ARB, b[2]);
    glBufferDataARB(GL_ELEMENT_ARRAY_BUFFER_ARB, sizeof domeI, domeI, GL_STATIC_DRAW_ARB);
    glEnableClientState(GL_VERTEX_ARRAY); glEnableClientState(GL_COLOR_ARRAY);
    glPushMatrix();
    glTranslatef(0, 0, -4); glRotatef(-40, 1, 0, 0);
    /* The second half of the triangles, from an offset into the element buffer. */
    glDrawElements(GL_TRIANGLES, 16 * 16 * 3, GL_UNSIGNED_INT, (const void *)(16 * 16 * 3 * sizeof (GLuint)));
    glTranslatef(0, 0, 0.01f);
    glDrawElements(GL_TRIANGLES, 16 * 16 * 3, GL_UNSIGNED_INT, 0);
    glPopMatrix();
    glDisableClientState(GL_VERTEX_ARRAY); glDisableClientState(GL_COLOR_ARRAY);
    glBindBufferARB(GL_ELEMENT_ARRAY_BUFFER_ARB, 0);
    glDeleteBuffersARB(3, b);
  } else if (!strcmp(scene, "array-types")) {
    struct v { GLubyte c[4]; GLfloat u[2]; GLshort p[2]; } q[8];
    static const GLshort P[8][2] = { {20,20}, {150,20}, {150,110}, {20,110}, {170,130}, {300,130}, {300,220}, {170,220} };
    static const GLubyte K[8][4] = { {255,0,0,255}, {0,255,0,255}, {0,0,255,255}, {255,255,255,255}, {255,128,0,255}, {0,128,255,255}, {128,0,255,255}, {40,40,40,255} };
    for (int i = 0; i < 8; i++) { memcpy(q[i].c, K[i], 4); q[i].u[0] = (i & 1) ^ ((i >> 1) & 1); q[i].u[1] = (i >> 1) & 1; q[i].p[0] = P[i][0]; q[i].p[1] = P[i][1]; }
    checker(16, 0);
    glBindTexture(GL_TEXTURE_2D, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, 4, 16, 16, 0, GL_RGBA, GL_UNSIGNED_BYTE, tex);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glDisable(GL_DEPTH_TEST);
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glOrtho(0, 320, 0, 240, -1, 1);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glEnableClientState(GL_VERTEX_ARRAY); glEnableClientState(GL_COLOR_ARRAY); glEnableClientState(GL_TEXTURE_COORD_ARRAY);
    glColorPointer(4, GL_UNSIGNED_BYTE, sizeof q[0], q[0].c);
    glTexCoordPointer(2, GL_FLOAT, sizeof q[0], q[0].u);
    glVertexPointer(2, GL_SHORT, sizeof q[0], q[0].p);
    glDrawArrays(GL_QUADS, 0, 4);
    glEnable(GL_TEXTURE_2D);
    glDrawArrays(GL_QUADS, 4, 4);
    glDisable(GL_TEXTURE_2D);
    glDisableClientState(GL_VERTEX_ARRAY); glDisableClientState(GL_COLOR_ARRAY); glDisableClientState(GL_TEXTURE_COORD_ARRAY);
    glPopMatrix(); glMatrixMode(GL_PROJECTION); glPopMatrix(); glMatrixMode(GL_MODELVIEW);
  } else if (!strcmp(scene, "points") || !strcmp(scene, "point-sprite")) {
    int sprite = !strcmp(scene, "point-sprite");
    static const GLfloat atten[3] = { 0, 0, 0.02f };
    if (sprite) {
      checker(16, 1);
      glBindTexture(GL_TEXTURE_2D, 1);
      glTexImage2D(GL_TEXTURE_2D, 0, 4, 16, 16, 0, GL_RGBA, GL_UNSIGNED_BYTE, tex);
      glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
      glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
      glEnable(GL_TEXTURE_2D);
      glEnable(GL_POINT_SPRITE_ARB);
      glTexEnvi(GL_POINT_SPRITE_ARB, GL_COORD_REPLACE_ARB, GL_TRUE);
      glEnable(GL_BLEND); glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    } else {
      for (int k = 1; k <= 8; k++) {
        glPointSize((GLfloat)k);
        glBegin(GL_POINTS);
        glColor3f(1, k / 8.0f, 0.2f);
        glVertex3f(-3.5f + k * 0.8f, 1.5f, -5);
        glEnd();
      }
    }
    glPointSize(sprite ? 48 : 24);
    glPointParameterfARB(GL_POINT_SIZE_MIN_ARB, 2);
    glPointParameterfARB(GL_POINT_SIZE_MAX_ARB, 48);
    glPointParameterfvARB(GL_POINT_DISTANCE_ATTENUATION_ARB, atten);
    glBegin(GL_POINTS);
    for (int k = 0; k < 8; k++) {
      glColor4f(0.3f + k * 0.08f, 1, 1, sprite ? 0.8f : 1);
      glVertex3f(-2.5f + k * 0.7f, -0.8f, -3 - k * 3);
    }
    glEnd();
    static const GLfloat one[3] = { 1, 0, 0 };
    glPointParameterfvARB(GL_POINT_DISTANCE_ATTENUATION_ARB, one);
    glPointSize(1);
    glDisable(GL_POINT_SPRITE_ARB); glDisable(GL_TEXTURE_2D); glDisable(GL_BLEND);
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
