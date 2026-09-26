/* printf at every width a 16-bit int, a long and a pointer can take. */
#include <stdio.h>

int main(void)
{
    int i = -1, big = 32767, low = -32768;
    unsigned u = 65535u, h = 0x8000u;
    long l = -1L, lbig = 2147483647L, llow = -2147483647L - 1;
    unsigned long ul = 4294967295UL;
    char c = 'A';
    unsigned char uc = 200;
    short s = -2;

    printf("d %d %d %d\n", i, big, low);
    printf("u %u %u %u\n", i, u, h);
    printf("x %x %X %o %#x %#o\n", u, h, u, 255, 8);
    printf("ld %ld %ld %ld\n", l, lbig, llow);
    printf("lu %lu %lx %lX %lo\n", ul, ul, 0x1234ABCDL, 8L);
    printf("hd %hd %hu %hx\n", s, s, s);
    printf("c %c%c %d %u\n", c, uc, uc, c);
    printf("w [%5d] [%-5d] [%05d] [%+d] [% d] [%.3d] [%8.3d]\n", 42, 42, 42, 42, 42, 7, -7);
    printf("s [%s] [%8s] [%-8s] [%.2s]\n", "abc", "abc", "abc", "abc");
    printf("mix %d %ld %d\n", 1, 70000L, 2);
    printf("star [%*d] [%-*d] [%.*d]\n", 6, 12, 6, 12, 4, 12);
    printf("f %f %.2f %10.3f %e %g %g\n", 3.25, -1.5, 2.0 / 3.0, 12345.678, 0.0001, 100000.0);
    printf("%% done\n");
    return 0;
}
