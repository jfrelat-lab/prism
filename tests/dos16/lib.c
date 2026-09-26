/* The library calls whose arguments or results are pointers or ints in memory. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <setjmp.h>
#include <math.h>

static jmp_buf env;
static int depth;

static void dive(int n)
{
    depth = n;
    if (n == 3) longjmp(env, 7);
    dive(n + 1);
}

static int cmp(const void *a, const void *b)
{
    int x = *(const int *)a, y = *(const int *)b;
    return x < y ? -1 : x > y;
}

int main(int argc, char *argv[])
{
    char *end;
    long v;
    int r, k;
    int arr[8];
    int key = 42, *hit;
    char buf[64];
    char *p, *q;
    /* An object the library writes through a pointer, with a sentinel right after it: a store wider
       than the object lands on the sentinel. */
    struct { char *end; int guard; } sp;
    struct { int e; int guard; } se;
    double mant;

    printf("argc %d argv[argc] %s\n", argc, argv[argc] == 0 ? "null" : "set");
    for (k = 0; k < argc; k++) printf("argv[%d] [%s]\n", k, argv[k]);

    v = strtol("  -1234xyz", &end, 10);
    printf("strtol %ld rest [%s]\n", v, end);
    v = strtol("7fff", &end, 16);
    printf("hex %ld rest [%s]\n", v, end);
    printf("strtoul %lu\n", strtoul("4000000000", &end, 10));
    printf("atoi %d atol %ld\n", atoi("-77"), atol("100000"));
    sp.guard = 1234;
    strtol("99z", &sp.end, 10);
    printf("endptr [%s] guard %d\n", sp.end, sp.guard);
    se.guard = 4321;
    mant = frexp(-48.0, &se.e);
    printf("frexp %d %d guard %d\n", (int)(mant * 1000), se.e, se.guard);

    r = setjmp(env);
    if (r == 0) dive(0);
    printf("longjmp %d depth %d\n", r, depth);

    for (k = 0; k < 8; k++) arr[k] = (k * 37 + 11) % 50 - 10;
    arr[5] = 42;
    qsort(arr, 8, sizeof(int), cmp);
    for (k = 0; k < 8; k++) printf("%d ", arr[k]);
    hit = (int *)bsearch(&key, arr, 8, sizeof(int), cmp);
    printf("\nbsearch %d\n", hit ? (int)(hit - arr) : -1);

    p = (char *)malloc(100);
    strcpy(p, "hello");
    strcat(p, ", world");
    q = (char *)realloc(p, 200);
    printf("%s %d %d\n", q, (int)strlen(q), q != 0);
    free(q);
    q = (char *)calloc(10, 2);
    printf("calloc %d\n", q[0] + q[19]);
    free(q);

    sprintf(buf, "%05d|%-4s|%lX", 99, "ab", 0xABCDEFL);
    printf("sprintf [%s] %d\n", buf, (int)strlen(buf));
    printf("strchr %s strrchr %s strstr %s\n", strchr(buf, '|'), strrchr(buf, '|'), strstr(buf, "ab"));
    printf("strcmp %d %d %d\n", strcmp("a", "b") < 0, strcmp("b", "a") > 0, strcmp("x", "x"));
    memset(buf, 'z', 5);
    buf[5] = 0;
    memmove(buf + 1, buf, 3);
    printf("mem %s %d\n", buf, memcmp("abc", "abd", 3) < 0);
    puts("puts");
    putchar('!');
    putchar('\n');
    return 0;
}
