/* A program's own variadic functions: va_arg at each width, and vsprintf handed a va_list. */
#include <stdio.h>
#include <stdarg.h>

long sum(int n, ...)
{
    va_list ap;
    long total = 0;
    int k;
    va_start(ap, n);
    for (k = 0; k < n; k++) total += va_arg(ap, int);
    va_end(ap);
    return total;
}

long mixed(int n, ...)
{
    va_list ap;
    long total = 0;
    va_start(ap, n);
    total += va_arg(ap, int);
    total += va_arg(ap, long);
    total += (long)va_arg(ap, double);
    total += va_arg(ap, int);
    va_end(ap);
    return total + n;
}

char *strings(int n, ...)
{
    va_list ap;
    char *last = 0;
    va_start(ap, n);
    while (n--) last = va_arg(ap, char *);
    va_end(ap);
    return last;
}

void say(char *fmt, ...)
{
    char buf[80];
    va_list ap;
    va_start(ap, fmt);
    vsprintf(buf, fmt, ap);
    va_end(ap);
    printf("say: %s\n", buf);
}

int main(void)
{
    printf("%ld\n", sum(4, 1, -2, 30000, 30000));
    printf("%ld\n", mixed(1, 7, 100000L, 2.75, -3));
    printf("%s\n", strings(3, "one", "two", "three"));
    say("%d-%s-%ld-%c", -12, "x", 123456L, 'q');
    say("%u %x", 65535u, 0xBEEF);
    return 0;
}
