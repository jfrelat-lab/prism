/*
 * GLU's quadrics held to libGLU (tools/gate-glu.mjs): gluSphere, gluCylinder (a cone among them),
 * gluDisk and gluPartialDisk, each drawn under every combination of draw style, normals, orientation
 * and texture coordinates. What GLU emits is traced by the side that receives it -- every glBegin,
 * glEnd, glNormal3f, glTexCoord2f and glVertex3f, its arguments as float bits: tests/glu/native-gl.c
 * natively, the gate's hooks on PRISM. Left out: FLAT normals with GLU_POINT or GLU_SILHOUETTE on a
 * sphere or a cylinder, where quad.c reads normal caches it never filled (uninitialised stack).
 */
#include <stdio.h>
#include <GL/gl.h>
#include <GL/glu.h>

void make_context(void);

static void shape(GLUquadric *q, int k)
{
    switch (k) {
    case 0: gluSphere(q, 1.5, 12, 8); break;
    case 1: gluSphere(q, 0.75, 7, 3); break;
    case 2: gluCylinder(q, 1.0, 0.5, 2.0, 10, 3); break;
    case 3: gluCylinder(q, 0.8, 0.0, 1.25, 9, 2); break;
    case 4: gluDisk(q, 0.5, 1.0, 9, 3); break;
    case 5: gluDisk(q, 0.0, 2.0, 8, 2); break;
    case 6: gluPartialDisk(q, 0.25, 1.5, 7, 2, 30.0, 135.0); break;
    case 7: gluPartialDisk(q, 0.0, 1.0, 6, 3, 200.0, -90.0); break;
    case 8: gluPartialDisk(q, 1.0, 1.0, 5, 1, 10.0, 360.0); break;
    }
}

int main(void)
{
    static const GLenum styles[] = { GLU_FILL, GLU_LINE, GLU_POINT, GLU_SILHOUETTE };
    static const GLenum normals[] = { GLU_SMOOTH, GLU_FLAT, GLU_NONE };
    static const GLenum orients[] = { GLU_OUTSIDE, GLU_INSIDE };
    int k, s, n, o, t;
    GLUquadric *q;
    make_context();
    q = gluNewQuadric();
    for (k = 0; k < 9; k++)
        for (s = 0; s < 4; s++)
            for (n = 0; n < 3; n++)
                for (o = 0; o < 2; o++)
                    for (t = 0; t < 2; t++) {
                        if (k < 4 && normals[n] == GLU_FLAT && (styles[s] == GLU_POINT || styles[s] == GLU_SILHOUETTE)) continue;
                        printf("shape %d style %d normals %d orientation %d texture %d\n", k, s, n, o, t);
                        fflush(stdout);
                        gluQuadricDrawStyle(q, styles[s]);
                        gluQuadricNormals(q, normals[n]);
                        gluQuadricOrientation(q, orients[o]);
                        gluQuadricTexture(q, (GLboolean)t);
                        shape(q, k);
                        fflush(stdout);
                    }
    gluDeleteQuadric(q);
    return 0;
}
