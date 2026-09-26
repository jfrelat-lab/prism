/* Far data under the medium model: farmalloc, far pointers into it, _fmemcpy, and a far static. */
#include <stdio.h>
#include <alloc.h>
#include <mem.h>
#include <string.h>

char far table[300];

int main(void)
{
    char far *p;
    char far *q;
    char buf[16];
    unsigned k, sum = 0;

    p = (char far *)farmalloc(1000);
    printf("alloc %d\n", p != 0);
    for (k = 0; k < 1000; k++) p[k] = (char)(k * 7);
    for (k = 0; k < 1000; k++) sum += (unsigned char)p[k];
    printf("sum %u\n", sum);
    q = p + 500;
    printf("diff %d\n", (int)(q - p));
    _fmemcpy(table, p + 10, 300);
    printf("table %d %d\n", (unsigned char)table[0], (unsigned char)table[299]);
    _fmemcpy((char far *)buf, table + 5, 15);
    buf[15] = 0;
    printf("near %d %d\n", (unsigned char)buf[0], (int)strlen(buf) <= 15);
    farfree(p);
    printf("sizes %u %u\n", (unsigned)sizeof p, (unsigned)sizeof(char near *));
    return 0;
}
