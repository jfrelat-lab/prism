/* The language at 16 bits: structs by value, recursion, function pointers, long arithmetic. */
#include <stdio.h>

struct pt { int x, y; char tag; };

static struct pt mid(struct pt a, struct pt b)
{
    struct pt m;
    m.x = (a.x + b.x) / 2;
    m.y = (a.y + b.y) / 2;
    m.tag = a.tag;
    return m;
}

static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
static int twice(int v) { return v * 2; }
static int neg(int v) { return -v; }

static int (*ops[])(int) = { twice, neg };

int grid[4][5];

int main(void)
{
    struct pt a = { 10, -20, 'a' }, b = { 31, 41, 'b' }, m;
    long x = 123456L, y = -789L;
    unsigned long z = 0xFFFFFFFFUL;
    int i, j, k = 0;
    unsigned w = 65535u;
    char ch = (char)200;

    m = mid(a, b);
    printf("mid %d %d %c size %u\n", m.x, m.y, m.tag, (unsigned)sizeof(struct pt));
    printf("fib %d\n", fib(20));
    printf("ops %d %d\n", ops[0](21), ops[1](21));
    printf("long %ld %ld %ld %ld %ld\n", x * y, x / y, x % y, x << 3, -x >> 2);
    printf("ulong %lu %lu\n", z / 3, z >> 16);
    printf("wrap %u %d %d\n", w + 1, (int)(w + 1), 32767 + 1);
    printf("char %d\n", ch);
    for (i = 0; i < 4; i++) for (j = 0; j < 5; j++) grid[i][j] = k++;
    printf("grid %d %d size %u\n", grid[2][3], *(&grid[0][0] + 17), (unsigned)sizeof grid);
    printf("sizes %u %u %u %u\n", (unsigned)sizeof(int), (unsigned)sizeof(long), (unsigned)sizeof(char *), (unsigned)sizeof(void (*)(void)));
    return 0;
}
