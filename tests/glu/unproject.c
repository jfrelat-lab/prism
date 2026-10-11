/*
 * gluUnProject, held to libGLU (tools/gate-glu.mjs): fixed pseudo-random matrices, each result printed
 * with %a. Beside each, the control: libGLU's unprojection with the projection TRANSPOSED, a wrong
 * matrix, which the gate's tolerance must see as different.
 */
#include <stdio.h>
#include <GL/glu.h>

static unsigned int seed = 12345;
static double rnd(void) { seed = seed * 1103515245u + 12345u; return ((int)(seed >> 8) % 2001 - 1000) / 250.0; }

int main(void) {
    int n, k;
    for (n = 0; n < 40; n++) {
        double model[16], proj[16], projT[16], x = 0, y = 0, z = 0, gx = 0, gy = 0, gz = 0;
        double wx = 100 + 13.5 * n, wy = 50 + 7.25 * n, wz = (n % 10) / 10.0;
        GLint view[4] = { 0, 0, 640, 480 };
        int ok, gok;
        for (k = 0; k < 16; k++) model[k] = rnd();
        for (k = 0; k < 16; k++) proj[k] = rnd();
        if (n == 0) for (k = 0; k < 16; k++) model[k] = proj[k] = (k % 5 == 0);   /* identity */
        if (n == 1) for (k = 0; k < 16; k++) model[k] = 0;                       /* singular */
        ok = gluUnProject(wx, wy, wz, model, proj, view, &x, &y, &z);
        for (k = 0; k < 16; k++) projT[k] = proj[(k % 4) * 4 + k / 4];
        gok = gluUnProject(wx, wy, wz, model, projT, view, &gx, &gy, &gz);
        printf("glu %d %d %a %a %a\n", n, ok, x, y, z);
        printf("wrong %d %d %a %a %a\n", n, gok, gx, gy, gz);
    }
    return 0;
}
