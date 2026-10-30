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
 *   multitex-shadow  Neverball's ball shadow on three texture units: unit 0 a shadow texture under
 *                 GL_COMBINE MODULATE (the previous colour by one minus its alpha), unit 1 a 1x2 clip
 *                 texture under INTERPOLATE (previous and primary colours by its alpha), unit 2 a checker
 *                 MODULATE; units 0 and 1 take three-component positions as coordinates, each through
 *                 its own texture matrix, unit 2 its own array; smooth colours, glDrawArrays
 *   combine       one strip per combiner: REPLACE with ONE_MINUS_SRC_COLOR, MODULATE by SRC_ALPHA with
 *                 RGB_SCALE 2, ADD of the constant colour, ADD_SIGNED with ALPHA_SCALE 2, INTERPOLATE of
 *                 texture and constant by the primary alpha, SUBTRACT of the constant; the last strip adds unit 1
 *                 under GL_OBJECT_LINEAR generation, MODULATE, and unit 2 under GL_SPHERE_MAP, DECAL
 *   lights        a rippled sheet turned so both of its sides show, under a directional light and a
 *                 positional one with attenuation, specular, GL_NORMALIZE under a scale, two-sided
 *                 lighting with a back material of its own, and a glMaterial between two vertices of
 *                 one strip; beside it flat shading (a fan, quads, a polygon), a user clip plane, and
 *                 face culling of one triangle of two
 *   fbo           a framebuffer object: two triangles through each other drawn into a 64x64 texture
 *                 with a depth renderbuffer deciding; read back with glReadPixels and copied with
 *                 glCopyTexSubImage2D while it is bound; then in the window the three textures side by
 *                 side, the first mipmapped by glGenerateMipmap and minified, and the framebuffer blitted
 *                 twice its size by glBlitFramebuffer
 *   polygon-mode  glPolygonMode: quads, a polygon and a quad strip as outlines (no diagonals), a
 *                 polygon as its corners in large points, a folded strip with its front in lines and its
 *                 back filled, back faces culled under GL_LINE, flat-shaded outlines, and an outline
 *                 crossing the near plane
 *   push-attrib   glPushAttrib/glPopAttrib: one lit, fogged, culled, scissored, stencilled strip drawn
 *                 between pushes of each group in turn (and of all of them, nested), each push followed
 *                 by changes to its group and each pop by the same strip, which shows any state left over
 *   immediate-forms  the immediate-mode spellings: a row of quads per glColor type (b, s, i, ub, us, ui,
 *                 d, scalar and v, 3 and 4 components, negative and full-scale values), glVertex in s, i,
 *                 d and 4 components with w = 2, glNormal in b, s, i under lighting, glTexCoord in 1, 3
 *                 and 4 components (q = 2), glMultiTexCoord on unit 1, all through glActiveTexture
 *                 (every textured quad planar in its coordinates: Mesa cuts these along 0-2)
 *   glut-shapes   GLUT's shapes, solid and lit on the top rows, wire below: sphere, cone, cube, torus,
 *                 dodecahedron, octahedron, tetrahedron, icosahedron (GLUT 3.7's own glut_shapes.c)
 *   raster-text   the raster position and glBitmap: a bitmap with the default unpack alignment of 4, its
 *                 colour the one current at glRasterPos (not at glBitmap), a raster position through a
 *                 rotation and a perspective, an invalid one (outside the view volume) drawing nothing
 *                 though it still moves; then GLUT's seven bitmap fonts and its two stroke fonts, laid out
 *                 by glutBitmapLength and glutStrokeLength
 *   evaluators    a Bezier curve with its colour map, by glEvalMesh1 (LINE) and as glEvalCoord1 points; a
 *                 bicubic patch lit under AUTO_NORMAL by glEvalMesh2 FILL, its colour and texture
 *                 coordinates mapped; the same patch by glEvalMesh2 LINE and as a rational (VERTEX_4)
 *                 surface of glEvalPoint2; then GLUT's teapot, solid and lit, and wire
 *   rect-forms    glRect in all eight forms (f, i, s, d and their vectors), each its own rectangle
 *                 and colour, under a window-sized glOrtho
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
#define glActiveTextureARB glActiveTexture
#define glClientActiveTextureARB glClientActiveTexture
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
  } else if (!strcmp(scene, "multitex-shadow")) {
    static unsigned char shad[8 * 8 * 2], check[4 * 4 * 3];
    static const unsigned char clip[4] = { 0xff, 0xff, 0x00, 0x00 };
    static GLfloat pos[9 * 7 * 3], uv[9 * 7 * 2], col[9 * 7 * 4];
    static GLushort quads[8 * 6 * 4];
    GLuint tx[3];
    int n = 0;
    for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
      float dx = i - 3.5f, dy = j - 3.5f, a = 255 - 60 * sqrtf(dx * dx + dy * dy);
      shad[(j * 8 + i) * 2] = 255; shad[(j * 8 + i) * 2 + 1] = (unsigned char)(a < 0 ? 0 : a);
    }
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
      unsigned char *c = check + (j * 4 + i) * 3, on = (i + j) & 1;
      c[0] = on ? 240 : 90; c[1] = on ? 200 : 140; c[2] = on ? 120 : 220;
    }
    for (int j = 0; j < 7; j++) for (int i = 0; i < 9; i++) {
      int k = j * 9 + i;
      pos[3 * k] = i * 40; pos[3 * k + 1] = j * 40; pos[3 * k + 2] = -(i + 2 * j) / 20.0f;   /* z: the height the clip reads */
      uv[2 * k] = i * 0.5f; uv[2 * k + 1] = j * 0.5f;
      col[4 * k] = 0.4f + i * 0.07f; col[4 * k + 1] = 0.9f - j * 0.1f; col[4 * k + 2] = 0.5f; col[4 * k + 3] = 1;
    }
    for (int j = 0; j < 6; j++) for (int i = 0; i < 8; i++) {
      quads[n++] = j * 9 + i; quads[n++] = j * 9 + i + 1; quads[n++] = (j + 1) * 9 + i + 1; quads[n++] = (j + 1) * 9 + i;
    }
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glOrtho(0, 320, 0, 240, -1, 1);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glDisable(GL_DEPTH_TEST);
    glGenTextures(3, tx);
    /* Unit 0: the shadow, centred on (160, 120), 100 pixels across. */
    glActiveTextureARB(GL_TEXTURE0); glClientActiveTextureARB(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, tx[0]);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE_ALPHA, 8, 8, 0, GL_LUMINANCE_ALPHA, GL_UNSIGNED_BYTE, shad);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glEnable(GL_TEXTURE_2D);
    glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_COMBINE);
    glTexEnvi(GL_TEXTURE_ENV, GL_COMBINE_RGB, GL_MODULATE);
    glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE0_RGB, GL_PREVIOUS); glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE1_RGB, GL_TEXTURE);
    glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND0_RGB, GL_SRC_COLOR); glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND1_RGB, GL_ONE_MINUS_SRC_ALPHA);
    glTexEnvi(GL_TEXTURE_ENV, GL_COMBINE_ALPHA, GL_REPLACE);
    glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE0_ALPHA, GL_PREVIOUS); glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND0_ALPHA, GL_SRC_ALPHA);
    glMatrixMode(GL_TEXTURE); glLoadIdentity();
    glTranslatef(0.5f, 0.5f, 0); glScalef(0.01f, 0.01f, 1); glTranslatef(-160, -120, 0);
    glMatrixMode(GL_MODELVIEW);
    glEnableClientState(GL_TEXTURE_COORD_ARRAY); glTexCoordPointer(3, GL_FLOAT, 0, pos);
    /* Unit 1: the clip, its t the vertex's height (r) moved by 0.163 -- the row changes across the screen. */
    glActiveTextureARB(GL_TEXTURE1); glClientActiveTextureARB(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, tx[1]);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE_ALPHA, 1, 2, 0, GL_LUMINANCE_ALPHA, GL_UNSIGNED_BYTE, clip);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glEnable(GL_TEXTURE_2D);
    glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_COMBINE);
    glTexEnvi(GL_TEXTURE_ENV, GL_COMBINE_RGB, GL_INTERPOLATE);
    glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE0_RGB, GL_PREVIOUS); glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE1_RGB, GL_PRIMARY_COLOR);
    glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE2_RGB, GL_TEXTURE);
    glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND0_RGB, GL_SRC_COLOR); glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND1_RGB, GL_SRC_COLOR);
    glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND2_RGB, GL_SRC_ALPHA);
    glTexEnvi(GL_TEXTURE_ENV, GL_COMBINE_ALPHA, GL_REPLACE);
    glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE0_ALPHA, GL_PREVIOUS); glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND0_ALPHA, GL_SRC_ALPHA);
    {
      static const GLfloat m[16] = { 0, 0, 0, 0,  0, 0, 0, 0,  0, -1, 0, 0,  0, 0.163f, 0, 1 };   /* t = 0.163 - z, never 0.5 on a vertex */
      glMatrixMode(GL_TEXTURE); glLoadMatrixf(m); glMatrixMode(GL_MODELVIEW);
    }
    glEnableClientState(GL_TEXTURE_COORD_ARRAY); glTexCoordPointer(3, GL_FLOAT, 0, pos);
    /* Unit 2: the surface. */
    glActiveTextureARB(GL_TEXTURE2); glClientActiveTextureARB(GL_TEXTURE2);
    glBindTexture(GL_TEXTURE_2D, tx[2]);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, 4, 4, 0, GL_RGB, GL_UNSIGNED_BYTE, check);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glEnable(GL_TEXTURE_2D);
    glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
    glEnableClientState(GL_TEXTURE_COORD_ARRAY); glTexCoordPointer(2, GL_FLOAT, 0, uv);
    glEnableClientState(GL_VERTEX_ARRAY); glVertexPointer(3, GL_FLOAT, 0, pos);
    glEnableClientState(GL_COLOR_ARRAY); glColorPointer(4, GL_FLOAT, 0, col);
    glShadeModel(GL_SMOOTH);
    glDrawElements(GL_QUADS, n, GL_UNSIGNED_SHORT, quads);
    glDisableClientState(GL_VERTEX_ARRAY); glDisableClientState(GL_COLOR_ARRAY);
    for (int u = 2; u >= 0; u--) {
      glActiveTextureARB(GL_TEXTURE0 + u); glClientActiveTextureARB(GL_TEXTURE0 + u);
      glDisableClientState(GL_TEXTURE_COORD_ARRAY); glDisable(GL_TEXTURE_2D);
      glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
      glMatrixMode(GL_TEXTURE); glLoadIdentity(); glMatrixMode(GL_MODELVIEW);
    }
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "combine")) {
    static const unsigned char rgba[4 * 4] = { 255,40,0,255,  30,200,90,128,  10,60,250,64,  220,220,40,0 };
    static const unsigned char grad[4 * 3] = { 0,0,0, 255,0,0, 0,255,0, 255,255,255 };
    static const unsigned char env[2 * 2 * 4] = { 255,255,255,255, 40,40,40,60, 40,40,40,128, 200,100,0,200 };
    static const GLfloat k[4] = { 0.2f, 0.5f, 0.1f, 0.6f }, plane[4] = { 0.01f, 0.003f, 0, 0 };
    GLuint tx[3];
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glOrtho(0, 320, 0, 240, -1, 1);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glDisable(GL_DEPTH_TEST);
    glGenTextures(3, tx);
    glBindTexture(GL_TEXTURE_2D, tx[0]);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glEnable(GL_TEXTURE_2D);
    glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_COMBINE);
    glTexEnvfv(GL_TEXTURE_ENV, GL_TEXTURE_ENV_COLOR, k);
    for (int strip = 0; strip < 6; strip++) {
      GLenum fn = strip == 0 ? GL_REPLACE : strip == 1 ? GL_MODULATE : strip == 2 ? GL_ADD : strip == 3 ? GL_ADD_SIGNED : strip == 4 ? GL_INTERPOLATE : GL_SUBTRACT;
      glTexEnvi(GL_TEXTURE_ENV, GL_COMBINE_RGB, fn); glTexEnvi(GL_TEXTURE_ENV, GL_COMBINE_ALPHA, fn);
      glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE0_RGB, strip == 5 ? GL_PRIMARY_COLOR : GL_TEXTURE);
      glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE1_RGB, strip == 1 || strip == 3 ? GL_PRIMARY_COLOR : GL_CONSTANT);
      glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE2_RGB, GL_PRIMARY_COLOR);
      glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE0_ALPHA, strip == 5 ? GL_PRIMARY_COLOR : GL_TEXTURE);
      glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE1_ALPHA, strip == 5 ? GL_TEXTURE : GL_CONSTANT);
      glTexEnvi(GL_TEXTURE_ENV, GL_SOURCE2_ALPHA, GL_PRIMARY_COLOR);
      glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND0_RGB, strip == 0 ? GL_ONE_MINUS_SRC_COLOR : GL_SRC_COLOR);
      glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND1_RGB, strip == 1 ? GL_SRC_ALPHA : GL_SRC_COLOR);
      glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND2_RGB, GL_SRC_ALPHA);
      glTexEnvi(GL_TEXTURE_ENV, GL_OPERAND0_ALPHA, strip == 2 ? GL_ONE_MINUS_SRC_ALPHA : GL_SRC_ALPHA);
      glTexEnvf(GL_TEXTURE_ENV, GL_RGB_SCALE, strip == 1 ? 2 : 1);
      glTexEnvf(GL_TEXTURE_ENV, GL_ALPHA_SCALE, strip == 3 ? 2 : 1);
      if (strip == 5) {
        /* Units 1 and 2 as well: generated coordinates, MODULATE and DECAL. Rows of 2 RGB texels are 6
           bytes: the unpack alignment of 4 would read 8. */
        glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
        glActiveTextureARB(GL_TEXTURE1);
        glBindTexture(GL_TEXTURE_2D, tx[1]);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, 2, 2, 0, GL_RGB, GL_UNSIGNED_BYTE, grad);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glEnable(GL_TEXTURE_2D); glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
        glTexGeni(GL_S, GL_TEXTURE_GEN_MODE, GL_OBJECT_LINEAR); glTexGenfv(GL_S, GL_OBJECT_PLANE, plane);
        glEnable(GL_TEXTURE_GEN_S);
        glActiveTextureARB(GL_TEXTURE2);
        glBindTexture(GL_TEXTURE_2D, tx[2]);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, env);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glEnable(GL_TEXTURE_2D); glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_DECAL);
        glTexGeni(GL_S, GL_TEXTURE_GEN_MODE, GL_SPHERE_MAP); glTexGeni(GL_T, GL_TEXTURE_GEN_MODE, GL_SPHERE_MAP);
        glEnable(GL_TEXTURE_GEN_S); glEnable(GL_TEXTURE_GEN_T);
        glActiveTextureARB(GL_TEXTURE0);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
      }
      /* Two triangles, not a quad: which diagonal a quad is cut along is the implementation's choice
         (Mesa's differs between its paths), and the generated coordinates are not affine across it. */
      static const GLfloat corner[4][9] = {
        { 0.6f, 0.3f, 0.6f, 0.25f, -0.5f, -0.3f, 0.8f, 0, 0 }, { 0.1f, 0.8f, 0.4f, 0.75f, 0.5f, -0.3f, 0.8f, 1, 0 },
        { 0.4f, 0.7f, 0.1f, 1.0f, 0.5f, 0.3f, 0.8f, 1, 1 }, { 0.9f, 0.2f, 0.3f, 0.5f, -0.5f, 0.3f, 0.8f, 0, 1 } };
      static const int order[6] = { 0, 1, 2, 0, 2, 3 };
      float y0 = strip * 40;
      glBegin(GL_TRIANGLES);
      for (int i = 0; i < 6; i++) {
        const GLfloat *c = corner[order[i]];
        glColor4f(c[0], c[1], c[2], c[3]); glNormal3f(c[4], c[5], c[6]); glTexCoord2f(c[7], c[8]);
        glVertex2f(c[7] * 320, y0 + c[8] * 40);
      }
      glEnd();
    }
    for (int u = 2; u >= 0; u--) {
      glActiveTextureARB(GL_TEXTURE0 + u);
      glDisable(GL_TEXTURE_GEN_S); glDisable(GL_TEXTURE_GEN_T); glDisable(GL_TEXTURE_2D);
      glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
    }
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "lights")) {
    static const GLfloat dir[4] = { -0.4f, 0.6f, 0.7f, 0 }, at[4] = { 0.6f, -0.3f, -2.5f, 1 };
    static const GLfloat white[4] = { 1, 1, 1, 1 }, warm[4] = { 1, 0.6f, 0.3f, 1 }, dim[4] = { 0.1f, 0.1f, 0.1f, 1 };
    static const GLfloat front[4] = { 0.8f, 0.7f, 0.2f, 1 }, back[4] = { 0.2f, 0.4f, 0.9f, 1 }, other[4] = { 0.9f, 0.2f, 0.3f, 1 };
    static const GLdouble plane[4] = { 1, 1, 0, -0.2 };
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glFrustum(-1.33, 1.33, -1, 1, 1.5, 20);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glLightfv(GL_LIGHT0, GL_POSITION, dir); glLightfv(GL_LIGHT0, GL_DIFFUSE, white); glLightfv(GL_LIGHT0, GL_SPECULAR, white);
    glLightfv(GL_LIGHT1, GL_POSITION, at); glLightfv(GL_LIGHT1, GL_DIFFUSE, warm); glLightfv(GL_LIGHT1, GL_SPECULAR, warm); glLightfv(GL_LIGHT1, GL_AMBIENT, dim);
    glLightf(GL_LIGHT1, GL_CONSTANT_ATTENUATION, 0.5f); glLightf(GL_LIGHT1, GL_LINEAR_ATTENUATION, 0.2f); glLightf(GL_LIGHT1, GL_QUADRATIC_ATTENUATION, 0.05f);
    glEnable(GL_LIGHTING); glEnable(GL_LIGHT0); glEnable(GL_LIGHT1); glEnable(GL_NORMALIZE);
    glLightModeli(GL_LIGHT_MODEL_TWO_SIDE, 1);
    glMaterialfv(GL_FRONT, GL_AMBIENT_AND_DIFFUSE, front); glMaterialfv(GL_BACK, GL_AMBIENT_AND_DIFFUSE, back);
    glMaterialfv(GL_FRONT_AND_BACK, GL_SPECULAR, white); glMaterialf(GL_FRONT_AND_BACK, GL_SHININESS, 24);
    /* The sheet: z = 0.45 sin(3x) cos(2y), scaled by 1.5 (so its normals need GL_NORMALIZE), turned 78
       degrees about y so that some of its ripples face away. */
    for (int copy = 0; copy < 2; copy++) {   /* the second shows mostly its back */
    glPushMatrix();
    glTranslatef(copy ? 0.1f : -1.1f, 0, -4.2f); glRotatef(copy ? 140 : 78, 0, 1, 0); glScalef(copy ? 0.9f : 1.5f, copy ? 0.9f : 1.5f, copy ? 0.9f : 1.5f);
    for (int j = 0; j < 8; j++) {
      glBegin(GL_QUAD_STRIP);
      for (int i = 0; i <= 12; i++) {
        for (int k = 1; k >= 0; k--) {
          float x = -1 + i / 6.0f, y = -1 + (j + k) / 4.0f, z = 0.45f * sinf(3 * x) * cosf(2 * y);
          float dx = 1.35f * cosf(3 * x) * cosf(2 * y), dy = -0.9f * sinf(3 * x) * sinf(2 * y);
          glNormal3f(-dx, -dy, 1); glVertex3f(x, y, z);
        }
        if (!copy && j == 3 && i == 6) glMaterialfv(GL_FRONT, GL_AMBIENT_AND_DIFFUSE, other);   /* inside the strip */
      }
      glEnd();
    }
    glMaterialfv(GL_FRONT, GL_AMBIENT_AND_DIFFUSE, front);
    glPopMatrix();
    }
    glDisable(GL_NORMALIZE); glLightModeli(GL_LIGHT_MODEL_TWO_SIDE, 0);
    /* The rest lit too, its colours through GL_COLOR_MATERIAL: lit, it is what the GPU transforms (gl.js
       leaves unlit immediate primitives to its JavaScript path, which batches them). */
    glEnable(GL_COLOR_MATERIAL); glColorMaterial(GL_FRONT_AND_BACK, GL_AMBIENT_AND_DIFFUSE); glNormal3f(0, 0, 1);
    /* Flat shading: the provoking vertex of a fan, of quads, of a polygon. */
    glShadeModel(GL_FLAT);
    glPushMatrix(); glTranslatef(1.6f, 0.9f, -5);
    glBegin(GL_TRIANGLE_FAN);
    for (int i = 0; i < 6; i++) { glColor3f(i / 5.0f, 1 - i / 5.0f, (i & 1) ? 1 : 0); glVertex2f(i ? 0.6f * cosf(i * 0.9f) : 0, i ? 0.6f * sinf(i * 0.9f) : 0); }
    glEnd();
    glTranslatef(0, -1.1f, 0);
    glBegin(GL_QUADS);
    glColor3f(1, 0, 0); glVertex2f(-0.6f, -0.3f); glColor3f(0, 1, 0); glVertex2f(0, -0.3f); glColor3f(0, 0, 1); glVertex2f(0, 0.3f); glColor3f(1, 1, 0); glVertex2f(-0.6f, 0.3f);
    glEnd();
    glBegin(GL_POLYGON);
    glColor3f(0, 1, 1); glVertex2f(0.1f, -0.3f); glColor3f(1, 0, 1); glVertex2f(0.6f, -0.3f); glColor3f(1, 1, 1); glVertex2f(0.6f, 0.3f); glColor3f(0.5f, 0.5f, 0); glVertex2f(0.1f, 0.3f);
    glEnd();
    glPopMatrix();
    glShadeModel(GL_SMOOTH);
    /* A user clip plane through a smooth quad; culling of the front faces, one triangle of two wound each way. */
    glPushMatrix(); glTranslatef(1.6f, -1.4f, -5);
    glClipPlane(GL_CLIP_PLANE0, plane); glEnable(GL_CLIP_PLANE0);
    glBegin(GL_QUADS);
    glColor3f(1, 0.5f, 0); glVertex2f(-0.6f, -0.4f); glColor3f(0, 0.5f, 1); glVertex2f(0.6f, -0.4f); glColor3f(0.5f, 1, 0.5f); glVertex2f(0.6f, 0.4f); glColor3f(1, 1, 1); glVertex2f(-0.6f, 0.4f);
    glEnd();
    glDisable(GL_CLIP_PLANE0);
    glEnable(GL_CULL_FACE); glCullFace(GL_FRONT);
    glColor3f(0.9f, 0.9f, 0.9f);
    glBegin(GL_TRIANGLES);
    glVertex2f(-1.5f, -0.5f); glVertex2f(-0.9f, -0.5f); glVertex2f(-1.2f, 0.3f);    /* counter-clockwise: culled */
    glVertex2f(-0.8f, -0.5f); glVertex2f(-0.5f, 0.3f); glVertex2f(-0.2f, -0.5f);    /* clockwise: drawn */
    glEnd();
    glDisable(GL_CULL_FACE); glCullFace(GL_BACK);
    glPopMatrix();
    glDisable(GL_COLOR_MATERIAL); glDisable(GL_LIGHTING);
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "fbo")) {
    static unsigned char back[64 * 64 * 4];
    GLuint tex[3], fbo, depth;
    int complete;
    glGenTextures(3, tex);
    for (int i = 0; i < 3; i++) {
      glBindTexture(GL_TEXTURE_2D, tex[i]);
      glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 64, 64, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    }
    glGenRenderbuffers(1, &depth); glBindRenderbuffer(GL_RENDERBUFFER, depth);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, 64, 64);
    glGenFramebuffers(1, &fbo); glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex[0], 0);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);
    complete = glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
    glViewport(0, 0, 64, 64);
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glOrtho(-1, 1, -1, 1, -1, 1);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glClearColor(0.15f, 0.2f, 0.35f, 1); glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    glEnable(GL_DEPTH_TEST);
    glBegin(GL_TRIANGLES);
    glColor3f(1, 0.3f, 0.2f); glVertex3f(-0.9f, -0.8f, -0.5f); glColor3f(1, 0.9f, 0.2f); glVertex3f(0.9f, -0.6f, 0.5f); glColor3f(0.9f, 0.2f, 0.6f); glVertex3f(0, 0.9f, 0);
    glColor3f(0.2f, 0.9f, 0.4f); glVertex3f(-0.8f, 0.5f, 0.4f); glColor3f(0.2f, 0.6f, 1); glVertex3f(0.8f, 0.7f, -0.4f); glColor3f(0.1f, 0.8f, 0.8f); glVertex3f(0.1f, -0.9f, 0);
    glEnd();
    glDisable(GL_DEPTH_TEST);
    /* Read back, and copied into another texture, while it is bound. */
    glReadPixels(0, 0, 64, 64, GL_RGBA, GL_UNSIGNED_BYTE, back);
    glBindTexture(GL_TEXTURE_2D, tex[2]); glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 16, 16, 32, 32);
    glBindTexture(GL_TEXTURE_2D, tex[1]); glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 64, 64, GL_RGBA, GL_UNSIGNED_BYTE, back);
    /* The window again. */
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, 320, 240);
    glMatrixMode(GL_PROJECTION); glLoadIdentity(); glOrtho(0, 320, 0, 240, -1, 1);
    glMatrixMode(GL_MODELVIEW); glLoadIdentity();
    glClearColor(0.1f, 0.1f, 0.2f, 1); glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_TEXTURE_2D); glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE);
    for (int i = 0; i < 3; i++) {
      float x = 8 + i * 104, y = 160;   /* 1:1, so that an edge texel is one pixel */
      glBindTexture(GL_TEXTURE_2D, tex[i]);
      glBegin(GL_QUADS);
      glTexCoord2f(0, 0); glVertex2f(x, y); glTexCoord2f(1, 0); glVertex2f(x + 64, y); glTexCoord2f(1, 1); glVertex2f(x + 64, y + 64); glTexCoord2f(0, 1); glVertex2f(x, y + 64);
      glEnd();
    }
    glBindTexture(GL_TEXTURE_2D, tex[0]);
    glGenerateMipmap(GL_TEXTURE_2D);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST_MIPMAP_NEAREST);
    glBegin(GL_QUADS);
    glTexCoord2f(0, 0); glVertex2f(16, 16); glTexCoord2f(1, 0); glVertex2f(32, 16); glTexCoord2f(1, 1); glVertex2f(32, 32); glTexCoord2f(0, 1); glVertex2f(16, 32);
    glEnd();
    glDisable(GL_TEXTURE_2D); glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
    glBlitFramebuffer(0, 0, 64, 64, 120, 4, 248, 132, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    if (!complete) { glColor3f(1, 0, 0); glRecti(0, 0, 320, 240); }
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "rect-forms")) {
    static const GLfloat fa[2] = { 90, 10 }, fb[2] = { 150, 70 };
    static const GLint ia[2] = { 170, 10 }, ib[2] = { 230, 70 };
    static const GLshort sa[2] = { 250, 10 }, sb[2] = { 310, 70 };
    static const GLdouble da[2] = { 10.25, 90.5 }, db[2] = { 70.75, 150.25 };
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glOrtho(0, 320, 0, 240, -1, 1);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glDisable(GL_DEPTH_TEST);
    glColor3f(1, 0, 0); glRectf(10.5f, 10, 70, 70);
    glColor3f(0, 1, 0); glRecti(90, 90, 150, 150);
    glColor3f(0, 0, 1); glRects(170, 90, 230, 150);
    glColor3f(1, 1, 0); glRectd(250.5, 90.25, 310.75, 150.5);
    glColor3f(0, 1, 1); glRectfv(fa, fb);
    glColor3f(1, 0, 1); glRectiv(ia, ib);
    glColor3f(1, 1, 1); glRectsv(sa, sb);
    glColor3f(1, 0.5f, 0); glRectdv(da, db);
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "polygon-mode")) {
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glFrustum(-1.33, 1.33, -1, 1, 1, 20);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity(); glTranslatef(0, 0, -4);
    glDisable(GL_DEPTH_TEST); glDisable(GL_TEXTURE_2D); glDisable(GL_LIGHTING);
    glShadeModel(GL_SMOOTH);
    glPolygonMode(GL_FRONT_AND_BACK, GL_LINE);
    /* Two quads, smooth colours: outlines without the diagonal. */
    glBegin(GL_QUADS);
    glColor3f(1, 0, 0); glVertex2f(-4.6f, 2.1f); glColor3f(0, 1, 0); glVertex2f(-3.3f, 2.3f);
    glColor3f(0, 0, 1); glVertex2f(-3.1f, 3.2f); glColor3f(1, 1, 0); glVertex2f(-4.4f, 3.1f);
    glColor3f(0, 1, 1); glVertex2f(-2.9f, 2.2f); glColor3f(1, 0, 1); glVertex2f(-1.8f, 2.0f);
    glColor3f(1, 1, 1); glVertex2f(-1.7f, 3.3f); glColor3f(1, 0.5f, 0); glVertex2f(-2.8f, 3.0f);
    glEnd();
    /* A hexagon as a polygon: its outline, none of the fan's inner edges. */
    glBegin(GL_POLYGON);
    for (int i = 0; i < 6; i++) { float a = i * 1.0472f + 0.2f; glColor3f(i & 1, (i >> 1) & 1, 1 - (i & 1)); glVertex2f(-0.4f + 0.8f * cosf(a), 2.6f + 0.7f * sinf(a)); }
    glEnd();
    /* A quad strip: rungs and sides, no diagonals. */
    glBegin(GL_QUAD_STRIP);
    for (int i = 0; i < 4; i++) { glColor3f(1, i / 3.0f, 0); glVertex2f(1.0f + i * 0.6f, 2.0f + 0.15f * i); glColor3f(0, i / 3.0f, 1); glVertex2f(1.1f + i * 0.6f, 3.2f - 0.1f * i); }
    glEnd();
    /* A pentagon as its corners, in 5-pixel points. */
    glPolygonMode(GL_FRONT_AND_BACK, GL_POINT); glPointSize(5);
    glBegin(GL_POLYGON);
    for (int i = 0; i < 5; i++) { float a = i * 1.2566f; glColor3f(1, i / 4.0f, 1 - i / 4.0f); glVertex2f(-3.6f + 0.9f * cosf(a), 0.3f + 0.9f * sinf(a)); }
    glEnd();
    glPointSize(1);
    /* A strip folded so both sides show: its front in lines, its back filled. */
    glPolygonMode(GL_FRONT, GL_LINE); glPolygonMode(GL_BACK, GL_FILL);
    glPushMatrix(); glTranslatef(-0.6f, 0.2f, 0); glRotatef(70, 0, 1, 0);
    glBegin(GL_TRIANGLE_STRIP);
    for (int i = 0; i < 6; i++) { float z = sinf(i * 1.3f) * 0.9f; glColor3f(i / 5.0f, 1 - i / 5.0f, 0.5f); glVertex3f(z, -0.9f + 0.36f * i, -0.6f); glVertex3f(-z, -0.9f + 0.36f * i, 0.6f); }
    glEnd();
    glPopMatrix();
    /* Back faces culled under GL_LINE: of two triangles of opposite windings, one remains. */
    glPolygonMode(GL_FRONT_AND_BACK, GL_LINE);
    glEnable(GL_CULL_FACE); glCullFace(GL_BACK);
    glBegin(GL_TRIANGLES);
    glColor3f(1, 1, 0); glVertex2f(1.0f, -0.4f); glVertex2f(2.0f, -0.3f); glVertex2f(1.4f, 0.8f);
    glColor3f(1, 0, 0); glVertex2f(2.3f, -0.4f); glVertex2f(2.9f, 0.8f); glVertex2f(3.6f, -0.3f);
    glEnd();
    glDisable(GL_CULL_FACE);
    /* Flat-shaded outlines: each quad in its provoking vertex's colour. */
    glShadeModel(GL_FLAT);
    glBegin(GL_QUADS);
    glColor3f(1, 0, 0); glVertex2f(-4.5f, -2.8f); glColor3f(0, 1, 0); glVertex2f(-3.4f, -2.7f);
    glColor3f(0, 0, 1); glVertex2f(-3.3f, -1.6f); glColor3f(1, 0, 1); glVertex2f(-4.4f, -1.7f);
    glColor3f(0, 1, 1); glVertex2f(-3.0f, -2.9f); glColor3f(1, 1, 1); glVertex2f(-1.9f, -2.6f);
    glColor3f(1, 1, 0); glVertex2f(-2.0f, -1.5f); glColor3f(0.5f, 0.5f, 1); glVertex2f(-3.1f, -1.8f);
    glEnd();
    glShadeModel(GL_SMOOTH);
    /* A triangle crossing the near plane: its outline clipped, the cut edge not drawn. */
    glBegin(GL_TRIANGLES);
    glColor3f(1, 0.5f, 0); glVertex3f(0.0f, -2.6f, 0.0f); glColor3f(0, 1, 0.5f); glVertex3f(2.5f, -2.0f, 0.0f);
    glColor3f(0.5f, 0, 1); glVertex3f(1.0f, -1.0f, 4.5f);
    glEnd();
    glPolygonMode(GL_FRONT_AND_BACK, GL_FILL);
    glEnable(GL_DEPTH_TEST);
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "push-attrib")) {
    static const GLfloat amb[4] = { 0.1f, 0.1f, 0.2f, 1 }, dif[4] = { 0.9f, 0.6f, 0.3f, 1 }, pos[4] = { 0.3f, 0.5f, 1, 0 };
    static const GLfloat red[4] = { 1, 0, 0, 1 }, fogc[4] = { 0.2f, 0.3f, 0.6f, 1 }, plane[4] = { 1, 0, 0, 0.6f };
    static const GLubyte tex[4 * 3] = { 255, 255, 255, 40, 40, 200, 40, 200, 40, 200, 40, 40 };
    GLuint t;
    glGenTextures(1, &t); glBindTexture(GL_TEXTURE_2D, t);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, 2, 2, 0, GL_RGB, GL_UNSIGNED_BYTE, tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glBindTexture(GL_TEXTURE_2D, 0);
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glFrustum(-1.33, 1.33, -1, 1, 1, 20);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glDisable(GL_TEXTURE_2D);
    /* The base state every strip is drawn in. */
    glEnable(GL_LIGHTING); glEnable(GL_LIGHT0); glLightfv(GL_LIGHT0, GL_AMBIENT, amb); glLightfv(GL_LIGHT0, GL_DIFFUSE, dif); glLightfv(GL_LIGHT0, GL_POSITION, pos);
    glEnable(GL_FOG); glFogi(GL_FOG_MODE, GL_LINEAR); glFogf(GL_FOG_START, 3); glFogf(GL_FOG_END, 9); glFogfv(GL_FOG_COLOR, fogc);
    glEnable(GL_DEPTH_TEST); glDepthFunc(GL_LESS);
    glShadeModel(GL_SMOOTH); glCullFace(GL_BACK); glEnable(GL_CULL_FACE);
    glClearColor(0.05f, 0.05f, 0.1f, 1);
    for (int k = 0; k < 13; k++) {
      static const GLbitfield groups[13] = { GL_CURRENT_BIT, GL_POLYGON_BIT, GL_LIGHTING_BIT, GL_FOG_BIT, GL_DEPTH_BUFFER_BIT,
        GL_VIEWPORT_BIT, GL_TRANSFORM_BIT, GL_ENABLE_BIT, GL_COLOR_BUFFER_BIT, GL_TEXTURE_BIT, GL_SCISSOR_BIT, GL_POINT_BIT | GL_LINE_BIT,
        GL_ALL_ATTRIB_BITS };
      int col = k % 5, row = k / 5;
      glViewport(col * 64, 240 - (row + 1) * 80, 64, 80);
      glPushAttrib(groups[k]);
      /* Every change, whatever the group: what the group did not save must stay. Not glMaterial:
         Mesa 22 (llvmpipe) draws with the changed material after the pop, which GL_LIGHTING_BIT
         saves (GL 1.1 table 6.9); gl.js restores it. */
      switch (k) {
        case 0: glColor3f(1, 0, 0); glNormal3f(0, 0, -1); break;
        case 1: glPolygonMode(GL_FRONT_AND_BACK, GL_LINE); glFrontFace(GL_CW); glCullFace(GL_FRONT); break;
        case 2: glShadeModel(GL_FLAT); glLightfv(GL_LIGHT0, GL_DIFFUSE, red); glLightModelfv(GL_LIGHT_MODEL_AMBIENT, red); glDisable(GL_LIGHT0); break;
        case 3: glFogfv(GL_FOG_COLOR, red); glFogf(GL_FOG_END, 4); glDisable(GL_FOG); break;
        case 4: glDepthFunc(GL_NEVER); glDepthMask(GL_FALSE); break;
        case 5: glViewport(0, 0, 10, 10); glDepthRange(0.5, 0.6); break;
        case 6: glMatrixMode(GL_PROJECTION); glClipPlane(GL_CLIP_PLANE0, plane); glEnable(GL_CLIP_PLANE0); glEnable(GL_NORMALIZE); break;
        case 7: glDisable(GL_LIGHTING); glDisable(GL_DEPTH_TEST); glDisable(GL_CULL_FACE); glEnable(GL_BLEND); glEnable(GL_TEXTURE_2D); break;
        case 8: glEnable(GL_BLEND); glBlendFunc(GL_ONE, GL_ONE); glColorMask(GL_TRUE, GL_FALSE, GL_TRUE, GL_TRUE); glEnable(GL_ALPHA_TEST); glAlphaFunc(GL_NEVER, 0); break;
        case 9: glEnable(GL_TEXTURE_2D); glBindTexture(GL_TEXTURE_2D, t); glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_REPLACE); break;
        case 10: glEnable(GL_SCISSOR_TEST); glScissor(0, 0, 1, 1); break;
        case 11: glPointSize(4); glLineWidth(3); break;
        case 12:
          glPushAttrib(GL_LIGHTING_BIT | GL_POLYGON_BIT);
          glShadeModel(GL_FLAT); glPolygonMode(GL_FRONT, GL_POINT);
          glPopAttrib();
          glColor3f(0, 1, 0); glPolygonMode(GL_FRONT_AND_BACK, GL_LINE); glDisable(GL_LIGHTING); glEnable(GL_TEXTURE_2D); glBindTexture(GL_TEXTURE_2D, t);
          glMatrixMode(GL_PROJECTION); glDepthFunc(GL_GREATER); glDisable(GL_FOG); glViewport(0, 0, 4, 4);
          break;
      }
      glPopAttrib();
      /* The strip: a ribbon going away from the eye, its colour from lighting, fog in its depth. */
      glLoadIdentity(); glTranslatef(0, 0, -3); glRotatef(-60, 1, 0, 0);
      glBegin(GL_TRIANGLE_STRIP);
      for (int i = 0; i < 6; i++) {
        float y = -1 + 0.8f * i, z = 0.3f * sinf(i * 1.7f);
        glNormal3f(0.3f * cosf(i * 1.7f), 0, 1); glTexCoord2f(0, i / 5.0f); glVertex3f(-0.8f, y, z); glTexCoord2f(1, i / 5.0f); glVertex3f(0.8f, y, z);
      }
      glEnd();
    }
    glViewport(0, 0, 320, 240);
    glDeleteTextures(1, &t);
    glDisable(GL_LIGHTING); glDisable(GL_LIGHT0); glDisable(GL_FOG); glDisable(GL_CULL_FACE);
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "immediate-forms")) {
    static const GLubyte tex[4 * 4 * 3] = { 255,255,255, 0,0,0, 255,0,0, 0,255,0, 0,0,255, 255,255,0, 0,255,255, 255,0,255,
      128,128,128, 255,128,0, 0,128,255, 128,0,255, 64,64,64, 200,200,200, 255,64,64, 64,255,64 };
    static const GLbyte cb[4] = { 127, -64, 40, 100 }; static const GLshort cs[3] = { 10000, 32767, -100 };
    static const GLint ci[4] = { 2147483647, 1000000000, -2147483647 - 1, 2000000000 };
    static const GLubyte cub[3] = { 30, 200, 90 }; static const GLushort cus[4] = { 65535, 20000, 40000, 65535 };
    static const GLuint cui[3] = { 4294967295u, 1000000000u, 3000000000u }; static const GLdouble cd[4] = { 0.25, 0.5, 0.75, 1 };
    static const GLshort vs[2] = { 5, 5 }; static const GLint vi[3] = { 5, 5, 0 }; static const GLdouble vd[3] = { 0, 0, 0 };
    static const GLfloat v4[4] = { 0, 0, 0, 2 }; static const GLbyte nb[3] = { 20, 60, 100 };
    static const GLfloat t1[3] = { 0.9f, 0.1f, 0 }; static const GLshort mt[2] = { 1, 1 };
    GLuint t;
    glGenTextures(1, &t); glBindTexture(GL_TEXTURE_2D, t);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, 4, 4, 0, GL_RGB, GL_UNSIGNED_BYTE, tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glOrtho(0, 320, 0, 240, -1, 1);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glDisable(GL_DEPTH_TEST); glDisable(GL_TEXTURE_2D);
#define Q(x, y) glTranslatef(x, y, 0); glBegin(GL_QUADS); glVertex2f(0, 0); glVertex2f(30, 0); glVertex2f(30, 30); glVertex2f(0, 30); glEnd(); glLoadIdentity()
    /* Colours: one quad per spelling. */
    glColor3b(127, -64, 40); Q(5, 200);           glColor4bv(cb); Q(40, 200);
    glColor3s(10000, 32767, -100); Q(75, 200);    glColor3sv(cs); Q(110, 200);
    glColor4i(2147483647, 1000000000, -2147483647 - 1, 2000000000); Q(145, 200); glColor4iv(ci); Q(180, 200);
    glColor3ubv(cub); Q(215, 200);                glColor4us(65535, 20000, 40000, 65535); Q(250, 200);
    glColor4usv(cus); Q(285, 200);
    glColor3ui(4294967295u, 1000000000u, 3000000000u); Q(5, 160); glColor3uiv(cui); Q(40, 160);
    glColor4d(0.25, 0.5, 0.75, 1); Q(75, 160);    glColor4dv(cd); Q(110, 160);
    glColor3us(0, 65535, 30000); Q(145, 160);     glColor3i(0, 1500000000, -1500000000); Q(180, 160);
    /* Positions. */
    glColor3f(1, 1, 1);
    glTranslatef(215, 160, 0); glBegin(GL_TRIANGLES); glVertex2s(0, 0); glVertex2sv(vs); glVertex3i(30, 0, 0); glVertex3iv(vi); glVertex3d(30, 30, 0); glVertex3dv(vd); glEnd(); glLoadIdentity();
    glColor3f(1, 0.5f, 0);
    glTranslatef(250, 160, 0); glBegin(GL_TRIANGLES); glVertex4f(0, 0, 0, 2); glVertex4i(60, 0, 0, 2); glVertex4d(30, 60, 0, 2); glVertex4fv(v4); glVertex4s(15, 30, 0, 1); glVertex4dv(cd); glEnd(); glLoadIdentity();
    /* Normals under a light. */
    {
      static const GLfloat pos[4] = { 0, 0, 1, 0 };
      glEnable(GL_LIGHTING); glEnable(GL_LIGHT0); glLightfv(GL_LIGHT0, GL_POSITION, pos);
      glNormal3b(40, -80, 100); Q(5, 120); glNormal3bv(nb); Q(40, 120);
      glNormal3s(-12000, 9000, 20000); Q(75, 120); glNormal3i(1000000000, 0, 1500000000); Q(110, 120);
      glNormal3d(0.6, 0.0, 0.8); Q(145, 120);
      glDisable(GL_LIGHTING); glDisable(GL_LIGHT0);
    }
    /* Texture coordinates. */
    glEnable(GL_TEXTURE_2D); glColor3f(1, 1, 1);
    glTranslatef(180, 120, 0); glBegin(GL_QUADS); glTexCoord1i(0); glVertex2f(0, 0); glTexCoord1d(0.9); glVertex2f(30, 0); glTexCoord1f(0.9f); glVertex2f(30, 30); glTexCoord1s(0); glVertex2f(0, 30); glEnd(); glLoadIdentity();
    glTranslatef(215, 120, 0); glBegin(GL_QUADS); glTexCoord3f(0, 0, 0); glVertex2f(0, 0); glTexCoord3fv(t1); glVertex2f(30, 0); glTexCoord3d(0.9, 1.1, 0); glVertex2f(30, 30); glTexCoord3s(0, 1, 0); glVertex2f(0, 30); glEnd(); glLoadIdentity();
    glTranslatef(250, 120, 0); glBegin(GL_QUADS); glTexCoord4f(0, 0, 0, 2); glVertex2f(0, 0); glTexCoord4f(2, 0, 0, 2); glVertex2f(30, 0); glTexCoord4f(2, 2, 0, 2); glVertex2f(30, 30); glTexCoord4f(0, 2, 0, 2); glVertex2f(0, 30); glEnd(); glLoadIdentity();
    /* Unit 1, through the GL 1.3 names: its coordinates from glMultiTexCoord, unit 0's from glMultiTexCoord too. */
    glActiveTexture(GL_TEXTURE1); glEnable(GL_TEXTURE_2D); glBindTexture(GL_TEXTURE_2D, t); glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE);
    glActiveTexture(GL_TEXTURE0);
    glTranslatef(5, 60, 0); glBegin(GL_QUADS);
    glMultiTexCoord1f(GL_TEXTURE0, 0); glMultiTexCoord2d(GL_TEXTURE1, 1, 0); glVertex2f(0, 0);
    glMultiTexCoord2i(GL_TEXTURE0, 1, 0); glMultiTexCoord2sv(GL_TEXTURE1, mt); glVertex2f(60, 0);
    glMultiTexCoord2f(GL_TEXTURE0, 1, 1); glMultiTexCoord3f(GL_TEXTURE1, 0, 1, 0); glVertex2f(60, 50);
    glMultiTexCoord2d(GL_TEXTURE0, 0, 1); glMultiTexCoord4f(GL_TEXTURE1, 0, 0, 0, 1); glVertex2f(0, 50);
    glEnd(); glLoadIdentity();
    glActiveTexture(GL_TEXTURE1); glDisable(GL_TEXTURE_2D); glActiveTexture(GL_TEXTURE0);
    glDisable(GL_TEXTURE_2D);
#undef Q
    glDeleteTextures(1, &t);
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "glut-shapes")) {
    static const GLfloat pos[4] = { 1, 1, 2, 0 }, dif[4] = { 0.9f, 0.7f, 0.4f, 1 };
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glOrtho(-4, 4, -3, 3, -10, 10);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glEnable(GL_DEPTH_TEST); glEnable(GL_LIGHTING); glEnable(GL_LIGHT0); glEnable(GL_NORMALIZE);
    glLightfv(GL_LIGHT0, GL_POSITION, pos); glMaterialfv(GL_FRONT_AND_BACK, GL_DIFFUSE, dif);
    for (int k = 0; k < 16; k++) {
      int wire = k >= 8, n = k % 8;
      if (wire) { glDisable(GL_LIGHTING); glColor3f(0.4f + 0.07f * n, 1, 0.6f); } else glEnable(GL_LIGHTING);
      glLoadIdentity();
      glTranslatef(-3.0f + 2.0f * (n % 4), (n < 4 ? 2.1f : 0.7f) - (wire ? 2.8f : 0), 0);
      glRotatef(25, 1, 0, 0); glRotatef(35 + 10 * n, 0, 1, 0);
      switch (n) {
        case 0: wire ? glutWireSphere(0.6, 12, 8) : glutSolidSphere(0.6, 16, 12); break;
        case 1: wire ? glutWireCone(0.5, 0.9, 10, 4) : glutSolidCone(0.5, 0.9, 14, 4); break;
        case 2: wire ? glutWireCube(0.8) : glutSolidCube(0.8); break;
        case 3: wire ? glutWireTorus(0.15, 0.45, 8, 14) : glutSolidTorus(0.15, 0.45, 10, 18); break;
        case 4: glScalef(0.35f, 0.35f, 0.35f); wire ? glutWireDodecahedron() : glutSolidDodecahedron(); break;
        case 5: glScalef(0.6f, 0.6f, 0.6f); wire ? glutWireOctahedron() : glutSolidOctahedron(); break;
        case 6: glScalef(0.5f, 0.5f, 0.5f); wire ? glutWireTetrahedron() : glutSolidTetrahedron(); break;
        case 7: glScalef(0.6f, 0.6f, 0.6f); wire ? glutWireIcosahedron() : glutSolidIcosahedron(); break;
      }
    }
    glDisable(GL_LIGHTING); glDisable(GL_LIGHT0); glDisable(GL_NORMALIZE);
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "raster-text")) {
    static const GLubyte arrow[12 * 4] = {      /* 12 rows of 10 bits, each row padded to 4 bytes */
      0x0c,0x00,0,0, 0x0c,0x00,0,0, 0x0c,0x00,0,0, 0x0c,0x00,0,0, 0x0c,0x00,0,0, 0xff,0xc0,0,0,
      0x7f,0x80,0,0, 0x3f,0x00,0,0, 0x1e,0x00,0,0, 0x0c,0x00,0,0, 0x8c,0x40,0,0, 0xff,0xc0,0,0 };
    static void *const fonts[7] = { GLUT_BITMAP_8_BY_13, GLUT_BITMAP_9_BY_15, GLUT_BITMAP_TIMES_ROMAN_10, GLUT_BITMAP_TIMES_ROMAN_24,
      GLUT_BITMAP_HELVETICA_10, GLUT_BITMAP_HELVETICA_12, GLUT_BITMAP_HELVETICA_18 };
    static const unsigned char text[] = "Glyphs 0123 @&%!";
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glOrtho(0, 320, 0, 240, -1, 1);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glDisable(GL_DEPTH_TEST); glDisable(GL_TEXTURE_2D); glDisable(GL_LIGHTING);
    /* Bitmaps: the colour latched at glRasterPos; xmove/ymove carry the next one along. */
    glColor3f(1, 0.3f, 0.2f); glRasterPos2i(8, 210); glColor3f(0, 0, 1);
    for (int k = 0; k < 4; k++) glBitmap(10, 12, 0, 0, 14, 3, arrow);
    glColor3f(0.3f, 1, 0.3f); glRasterPos2f(80.6f, 208.4f); glBitmap(10, 12, 4.5f, 2.5f, 0, 0, arrow);
    /* Through a rotation and a perspective. */
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glFrustum(-1, 1, -0.75, 0.75, 1, 10);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity(); glTranslatef(0, 0, -3); glRotatef(30, 0, 0, 1);
    glColor3f(1, 1, 0); glRasterPos3f(0.8f, 1.2f, 0.5f); glBitmap(10, 12, 0, 0, 0, 0, arrow);
    /* Outside the view volume: invalid, nothing drawn, though it moves. */
    glColor3f(1, 0, 1); glRasterPos3f(0, 0, 5); glBitmap(10, 12, 0, 0, -200, 0, arrow); glBitmap(10, 12, 0, 0, 0, 0, arrow);
    glPopMatrix(); glMatrixMode(GL_PROJECTION); glPopMatrix(); glMatrixMode(GL_MODELVIEW);
    /* GLUT's bitmap fonts, one line each, and their lengths as bars. */
    for (int k = 0; k < 7; k++) {
      int y = 180 - 22 * k, x = 8, len = glutBitmapLength(fonts[k], text);
      glColor3f(0.6f + 0.05f * k, 0.9f, 1 - 0.1f * k); glRasterPos2i(x, y);
      for (const unsigned char *c = text; *c; c++) glutBitmapCharacter(fonts[k], *c);
      glColor3f(0.3f, 0.3f, 0.5f); glRecti(x, y - 4, x + len, y - 3);
      glColor3f(1, 1, 1); glRecti(x + glutBitmapWidth(fonts[k], 'W'), y - 6, x + glutBitmapWidth(fonts[k], 'W') + 1, y - 5);
    }
    /* The stroke fonts, scaled, and their lengths. */
    for (int k = 0; k < 2; k++) {
      void *font = k ? GLUT_STROKE_MONO_ROMAN : GLUT_STROKE_ROMAN;
      glLoadIdentity(); glTranslatef(170, 200 - 40 * k, 0); glScalef(0.15f, 0.15f, 1);
      glColor3f(1, 0.8f - 0.3f * k, 0.4f);
      for (const unsigned char *c = (const unsigned char *)"Stroke #1"; *c; c++) glutStrokeCharacter(font, *c);
      glLoadIdentity(); glColor3f(0.5f, 0.5f, 0.5f);
      glRecti(170, 195 - 40 * k, 170 + (int)(0.15f * glutStrokeLength(font, (const unsigned char *)"Stroke #1")), 196 - 40 * k);
      glRecti(170, 192 - 40 * k, 170 + (int)(0.15f * glutStrokeWidth(font, 'M')), 193 - 40 * k);
    }
    glMatrixMode(GL_PROJECTION); glPopMatrix();
    glMatrixMode(GL_MODELVIEW); glPopMatrix();
  } else if (!strcmp(scene, "evaluators")) {
    static const GLfloat curve[4][3] = { { -1, -1, 0 }, { -0.4f, 1.2f, 0 }, { 0.5f, -1.1f, 0 }, { 1, 0.9f, 0 } };
    static const GLfloat curveCol[4][4] = { { 1, 0, 0, 1 }, { 1, 1, 0, 1 }, { 0, 1, 1, 1 }, { 0.4f, 0.4f, 1, 1 } };
    static GLfloat patch[4][4][3], patch4[4][4][4];
    static const GLfloat patchCol[2][2][4] = { { { 1, 0.3f, 0.3f, 1 }, { 0.3f, 1, 0.3f, 1 } }, { { 0.3f, 0.3f, 1, 1 }, { 1, 1, 0.3f, 1 } } };
    static const GLfloat patchTex[2][2][2] = { { { 0, 0 }, { 0, 2 } }, { { 2, 0 }, { 2, 2 } } };
    static const GLubyte tex[2 * 2 * 3] = { 255, 255, 255, 120, 120, 160, 120, 120, 160, 255, 255, 255 };
    static const GLfloat pos[4] = { 0.5f, 1, 2, 0 }, dif[4] = { 0.9f, 0.8f, 0.6f, 1 };
    GLuint t;
    for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) {
      patch[i][j][0] = -1 + i * 0.66f; patch[i][j][1] = -1 + j * 0.66f;
      patch[i][j][2] = ((i == 1 || i == 2) && (j == 1 || j == 2)) ? 1.2f : (i + j) % 3 * 0.2f - 0.2f;
      for (int c = 0; c < 3; c++) patch4[i][j][c] = patch[i][j][c] * (1 + (i * j) % 3 * 0.5f);
      patch4[i][j][3] = 1 + (i * j) % 3 * 0.5f;
    }
    glGenTextures(1, &t); glBindTexture(GL_TEXTURE_2D, t); glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, 2, 2, 0, GL_RGB, GL_UNSIGNED_BYTE, tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glMatrixMode(GL_PROJECTION); glPushMatrix(); glLoadIdentity(); glOrtho(-4, 4, -3, 3, -10, 10);
    glMatrixMode(GL_MODELVIEW); glPushMatrix(); glLoadIdentity();
    glEnable(GL_DEPTH_TEST); glDisable(GL_TEXTURE_2D); glDisable(GL_LIGHTING);
    /* The curve: a line strip through the grid, then its points. */
    glMap1f(GL_MAP1_VERTEX_3, 0, 1, 3, 4, &curve[0][0]); glMap1f(GL_MAP1_COLOR_4, 0, 1, 4, 4, &curveCol[0][0]);
    glEnable(GL_MAP1_VERTEX_3); glEnable(GL_MAP1_COLOR_4);
    glTranslatef(-2.8f, 1.8f, 0);
    glMapGrid1f(30, 0, 1); glEvalMesh1(GL_LINE, 0, 30);
    glTranslatef(0, -0.3f, 0); glPointSize(3);
    glBegin(GL_POINTS); for (int i = 0; i <= 8; i++) glEvalCoord1f(i / 8.0f); glEnd();
    glPointSize(1); glDisable(GL_MAP1_COLOR_4); glDisable(GL_MAP1_VERTEX_3);
    /* The patch, filled, lit by its automatic normals, coloured and textured by its maps. */
    glLoadIdentity(); glTranslatef(0, 1.6f, 0); glRotatef(-50, 1, 0, 0); glRotatef(20, 0, 0, 1);
    glMap2f(GL_MAP2_VERTEX_3, 0, 1, 3, 4, 0, 1, 12, 4, &patch[0][0][0]);
    glMap2f(GL_MAP2_COLOR_4, 0, 1, 4, 2, 0, 1, 8, 2, &patchCol[0][0][0]);
    glMap2f(GL_MAP2_TEXTURE_COORD_2, 0, 1, 2, 2, 0, 1, 4, 2, &patchTex[0][0][0]);
    glEnable(GL_MAP2_VERTEX_3); glEnable(GL_MAP2_COLOR_4); glEnable(GL_MAP2_TEXTURE_COORD_2); glEnable(GL_AUTO_NORMAL);
    glEnable(GL_LIGHTING); glEnable(GL_LIGHT0); glLightfv(GL_LIGHT0, GL_POSITION, pos);
    glEnable(GL_COLOR_MATERIAL); glEnable(GL_TEXTURE_2D);
    glMapGrid2f(12, 0, 1, 10, 0, 1); glEvalMesh2(GL_FILL, 0, 12, 0, 10);
    glDisable(GL_TEXTURE_2D); glDisable(GL_COLOR_MATERIAL); glDisable(GL_LIGHTING); glDisable(GL_MAP2_COLOR_4); glDisable(GL_MAP2_TEXTURE_COORD_2);
    /* The same patch as lines, and part of it. */
    glLoadIdentity(); glTranslatef(2.6f, 1.6f, 0); glRotatef(-50, 1, 0, 0); glRotatef(20, 0, 0, 1);
    glColor3f(0.6f, 1, 0.6f); glMapGrid2f(8, 0, 1, 8, 0, 1); glEvalMesh2(GL_LINE, 0, 8, 2, 7);
    /* A rational surface, its points by glEvalPoint2. */
    glMap2f(GL_MAP2_VERTEX_4, 0, 1, 4, 4, 0, 1, 16, 4, &patch4[0][0][0]); glEnable(GL_MAP2_VERTEX_4);
    glLoadIdentity(); glTranslatef(-2.6f, -1.2f, 0); glRotatef(-40, 1, 0, 0);
    glColor3f(1, 0.6f, 1); glMapGrid2f(10, 0, 1, 10, 0, 1); glPointSize(2);
    glBegin(GL_POINTS); for (int j = 0; j <= 10; j++) for (int i = 0; i <= 10; i++) glEvalPoint2(i, j); glEnd();
    glPointSize(1); glDisable(GL_MAP2_VERTEX_4); glDisable(GL_MAP2_VERTEX_3); glDisable(GL_AUTO_NORMAL);
    /* GLUT's teapot. */
    glMaterialfv(GL_FRONT_AND_BACK, GL_DIFFUSE, dif);
    glEnable(GL_LIGHTING); glEnable(GL_LIGHT0);
    glLoadIdentity(); glTranslatef(0, -1.5f, 0); glRotatef(20, 1, 0, 0); glRotatef(30, 0, 1, 0); glutSolidTeapot(0.9);
    glDisable(GL_LIGHTING); glDisable(GL_LIGHT0);
    glLoadIdentity(); glTranslatef(2.6f, -1.5f, 0); glRotatef(20, 1, 0, 0); glRotatef(-30, 0, 1, 0); glColor3f(1, 1, 0.5f); glutWireTeapot(0.8);
    glDeleteTextures(1, &t);
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
