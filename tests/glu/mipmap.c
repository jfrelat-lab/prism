/*
 * gluBuild2DMipmaps and gluScaleImage, held to libGLU (tools/gate-glu.mjs). Images of several sizes --
 * powers of two and not, 1, 3 and 4 components -- each built into mipmaps (every level GLU hands
 * glTexImage2D is hashed by the side that receives it: tests/glu/native-gl.c natively, the gate's
 * hook on PRISM) and scaled to other sizes, the output hashed here.
 */
#include <stdio.h>
#include <stdlib.h>
#include <GL/gl.h>
#include <GL/glu.h>

void make_context(void);

static unsigned int seed = 7;
static unsigned char rnd8(void) { seed = seed * 1103515245u + 12345u; return (unsigned char)(seed >> 16); }
static unsigned int fnv(const unsigned char *p, int n) { unsigned int h = 2166136261u; while (n-- > 0) h = (h ^ *p++) * 16777619u; return h; }

/* Rows padded to 4 bytes: GL_UNPACK_ALIGNMENT and GL_PACK_ALIGNMENT are 4 by default. */
static int rowBytes(int w, int c) { return (w * c + 3) / 4 * 4; }

int main(void)
{
    static const int cases[][3] = { { 64, 64, 3 }, { 64, 32, 4 }, { 100, 50, 3 }, { 37, 19, 4 }, { 1, 1, 3 },
                                    { 256, 128, 1 }, { 130, 66, 3 }, { 300, 200, 4 }, { 17, 64, 1 } };
    static const int sizes[][2] = { { 32, 32 }, { 50, 25 }, { 128, 64 }, { 7, 3 } };
    int i, k, y, x;
    make_context();
    for (i = 0; i < (int)(sizeof cases / sizeof cases[0]); i++) {
        int w = cases[i][0], h = cases[i][1], c = cases[i][2], rb = rowBytes(w, c);
        GLenum fmt = c == 1 ? GL_LUMINANCE : c == 3 ? GL_RGB : GL_RGBA;
        unsigned char *data = (unsigned char *)calloc((size_t)rb * h, 1);
        /* Smooth with some noise, as a texture is: a pure random image hides filters. */
        for (y = 0; y < h; y++) for (x = 0; x < w * c; x++) data[y * rb + x] = (unsigned char)((x * 7 + y * 13) % 256 ^ (rnd8() & 15));
        printf("case %d %dx%dx%d\n", i, w, h, c);
        glBindTexture(GL_TEXTURE_2D, i + 1);
        printf("build %d\n", gluBuild2DMipmaps(GL_TEXTURE_2D, c, w, h, fmt, GL_UNSIGNED_BYTE, data));
        fflush(stdout);
        for (k = 0; k < (int)(sizeof sizes / sizeof sizes[0]); k++) {
            int w2 = sizes[k][0], h2 = sizes[k][1], orb = rowBytes(w2, c), r;
            unsigned char *out = (unsigned char *)calloc((size_t)orb * h2, 1);
            unsigned int hh = 2166136261u;
            r = gluScaleImage(fmt, w, h, GL_UNSIGNED_BYTE, data, w2, h2, GL_UNSIGNED_BYTE, out);
            for (y = 0; y < h2; y++) hh = hh ^ fnv(out + y * orb, w2 * c), hh *= 16777619u;
            printf("scale %dx%d %d %08x\n", w2, h2, r, hh);
            free(out);
        }
        free(data);
    }
    return 0;
}
