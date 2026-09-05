/*
 * inttypes.c -- strtoimax and strtoumax, in C for the same reason wide.c is.
 *
 * These convert to intmax_t, which on this target is `long long`. PRISM represents 64-bit integers
 * as BigInt in the emitted JavaScript, so a runtime.js implementation would have to know and honour
 * that convention at the boundary; written in C, the compiler settles it and the code says only what
 * C99 7.8.2.3 says it should.
 *
 * The behaviour is strtol's (7.20.1.4): optional space, optional sign, an optional 0x for base 16 or
 * a base of 0 that infers 8/10/16, digits, and `end` pointed at the first character not consumed --
 * which for a string with no digits at all is the ORIGINAL pointer, not wherever the scan stopped.
 */

#include <stddef.h>
#include <inttypes.h>

static int prism_digit(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'z') return c - 'a' + 10;
    if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
    return -1;
}

static uintmax_t prism_strtoumax(const char *s, char **end, int base, int *neg)
{
    const char *start = s;
    uintmax_t acc = 0;
    int any = 0, d;

    while (*s == ' ' || (*s >= '\t' && *s <= '\r')) s++;
    *neg = 0;
    if (*s == '+' || *s == '-') { *neg = (*s == '-'); s++; }

    if ((base == 0 || base == 16) && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')
        && prism_digit(s[2]) >= 0 && prism_digit(s[2]) < 16) {
        s += 2;
        base = 16;
    } else if (base == 0) {
        base = (*s == '0') ? 8 : 10;
    }

    while ((d = prism_digit(*s)) >= 0 && d < base) { acc = acc * (uintmax_t)base + (uintmax_t)d; s++; any = 1; }
    if (end) *end = (char *)(any ? s : start);
    return acc;
}

uintmax_t strtoumax(const char *nptr, char **endptr, int base)
{
    int neg;
    uintmax_t v = prism_strtoumax(nptr, endptr, base, &neg);
    return neg ? (uintmax_t)0 - v : v;      /* strtoul negates too; the standard says so */
}

intmax_t strtoimax(const char *nptr, char **endptr, int base)
{
    int neg;
    uintmax_t v = prism_strtoumax(nptr, endptr, base, &neg);
    return neg ? -(intmax_t)v : (intmax_t)v;
}
