/*
 * GLU's matrix functions held to libGLU (tools/gate-glu.mjs): gluPerspective, gluLookAt, gluOrtho2D
 * and gluPickMatrix, whose effect is the GL calls they make -- traced, arguments as their bits, by
 * the side that receives them (tests/glu/native-gl.c natively, the gate's hooks on PRISM) -- and
 * gluProject, whose window coordinates are printed here. The degenerate cases are among them: a
 * zero depth range, a zero aspect, an eye on its centre, an up along the line of sight.
 */
#include <stdio.h>
#include <string.h>
#include <GL/gl.h>
#include <GL/glu.h>

void make_context(void);

static unsigned int seed = 11;
static double rnd(void) { seed = seed * 1103515245u + 12345u; return ((seed >> 8) & 0xffff) / 32768.0 - 1.0; }
static unsigned long long dbits(double d) { unsigned long long u; memcpy(&u, &d, 8); return u; }

int main(void)
{
    static const double persp[][4] = { { 45, 4.0 / 3, 0.1, 100 }, { 60, 1, 1, 1000 }, { 90, 16.0 / 9, 0.01, 10 },
                                       { 30.5, 0.75, 2, 3 }, { 120, 2.5, 0.5, 0.25 }, { 45, 1, 5, 5 }, { 45, 0, 1, 10 }, { 0, 1, 1, 10 } };
    static const double look[][9] = { { 0, 0, 5, 0, 0, 0, 0, 1, 0 }, { 3, 4, 5, -1, 0.5, 2, 0, 0, 1 }, { -2.5, 1, 7, 0, 0, 0, 0.3, 1, -0.2 },
                                      { 1, 1, 1, 1, 1, 1, 0, 1, 0 }, { 0, 0, 0, 0, 0, -1, 0, 0, 1 }, { 10, -3, 2.25, 4, 4, 4, 1, 1, 1 } };
    static const double ortho[][4] = { { 0, 640, 0, 480 }, { -1, 1, -1, 1 }, { 0, 320, 240, 0 } };
    static const double pick[][4] = { { 320, 240, 5, 5 }, { 10.5, 470.25, 3, 7 }, { 0, 0, 1, 1 }, { 100, 100, 0, 5 } };
    static const GLint vp[][4] = { { 0, 0, 640, 480 }, { 10, 20, 300, 200 } };
    int i, k;
    make_context();
    for (i = 0; i < (int)(sizeof persp / sizeof persp[0]); i++) {
        printf("perspective %d\n", i);
        gluPerspective(persp[i][0], persp[i][1], persp[i][2], persp[i][3]);
    }
    for (i = 0; i < (int)(sizeof look / sizeof look[0]); i++) {
        const double *l = look[i];
        printf("lookat %d\n", i);
        gluLookAt(l[0], l[1], l[2], l[3], l[4], l[5], l[6], l[7], l[8]);
    }
    for (i = 0; i < (int)(sizeof ortho / sizeof ortho[0]); i++) {
        printf("ortho2d %d\n", i);
        gluOrtho2D(ortho[i][0], ortho[i][1], ortho[i][2], ortho[i][3]);
    }
    for (i = 0; i < (int)(sizeof pick / sizeof pick[0]); i++) {
        printf("pick %d\n", i);
        gluPickMatrix(pick[i][0], pick[i][1], pick[i][2], pick[i][3], (GLint *)vp[i & 1]);
    }
    /* gluProject: 40 pseudo-random model/projection pairs, a few points each. */
    for (i = 0; i < 40; i++) {
        GLdouble model[16], proj[16], wx, wy, wz;
        for (k = 0; k < 16; k++) model[k] = rnd() * 3, proj[k] = rnd() * 2;
        if (i == 0) for (k = 0; k < 16; k++) model[k] = proj[k] = (k % 5 == 0);
        if (i == 1) proj[3] = proj[7] = proj[11] = proj[15] = 0;   /* w is always 0: gluProject fails */
        for (k = 0; k < 3; k++) {
            double x = rnd() * 10, y = rnd() * 10, z = rnd() * 10;
            int ok = gluProject(x, y, z, model, proj, vp[k & 1], &wx, &wy, &wz);
            printf("project %d %d %d %016llx %016llx %016llx\n", i, k, ok, ok ? dbits(wx) : 0, ok ? dbits(wy) : 0, ok ? dbits(wz) : 0);
        }
    }
    return 0;
}
