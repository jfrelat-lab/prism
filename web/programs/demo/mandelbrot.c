/*
 * mandelbrot.c — the shell's second program, and the point of it.
 *
 * MAME proves PRISM can compile a real 1997 codebase. This proves the SHELL is not shaped like MAME:
 * plain C89, no platform layer, no data files, no display — it prints, so it runs on the text surface
 * and nothing else. It also reads argv, which is the only way to change what it does.
 *
 * Written for this repository, so nothing here is anybody else's code.
 */

#include <stdio.h>
#include <stdlib.h>

/* Darkest to lightest: escape time picks a character, so the set itself comes out solid. */
static const char *SHADES = "@%#*+=-:. ";

int main(int argc, char **argv)
{
    int width = 76;
    int height = 28;
    int maxiter = 180;
    int x, y, i;
    int inside = 0;
    double cr, ci, zr, zi, zr2, zi2;

    if (argc > 1) width = atoi(argv[1]);
    if (argc > 2) height = atoi(argv[2]);
    if (argc > 3) maxiter = atoi(argv[3]);
    if (width < 8 || width > 200) width = 76;
    if (height < 4 || height > 100) height = 28;
    if (maxiter < 2) maxiter = 180;

    printf("Mandelbrot set, %dx%d, %d iterations\n", width, height, maxiter);
    printf("compiled from C to JavaScript by PRISM, running in a browser\n\n");

    for (y = 0; y < height; y++)
    {
        ci = 1.2 - 2.4 * y / (height - 1);
        for (x = 0; x < width; x++)
        {
            cr = -2.1 + 3.0 * x / (width - 1);
            zr = 0.0;
            zi = 0.0;
            for (i = 0; i < maxiter; i++)
            {
                zr2 = zr * zr;
                zi2 = zi * zi;
                if (zr2 + zi2 > 4.0) break;
                zi = 2.0 * zr * zi + ci;
                zr = zr2 - zi2 + cr;
            }
            if (i == maxiter)
            {
                inside++;
                putchar('@');
            }
            else
            {
                /* Fast escape is far outside, so it gets the lightest shade; slow escape hugs
                   the boundary and gets a dense one. Getting this backwards fills the plane with
                   '@' and looks like a bug in the compiler rather than in the arithmetic. */
                putchar(SHADES[9 - (int)((long)i * 9 / maxiter)]);
            }
        }
        putchar('\n');
    }

    printf("\n%d of %d cells are in the set.\n", inside, width * height);
    return 0;
}
