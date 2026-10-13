/*
 * wide.c -- the wide-character corner of the C library, written in C on purpose.
 *
 * These could have gone in runtime.js with the rest of string.h, and that would have been wrong for
 * the same reason mgl.c is C: their contract is a TYPE whose width the compiler settles and the
 * JavaScript cannot see. wchar_t is two bytes under the Microsoft ABI and four under i386 SysV, so a
 * JS implementation would need the build's -D flags plumbed through to it just to know how far to
 * step. Written here, `wchar_t *p; p++` is simply correct on both.
 *
 * The locale is "C" -- the only one PRISM has -- and everything below follows from that rather than
 * being a simplification of it. The multibyte encoding is one byte per character, so mbrtowc and
 * wcrtomb are the identity on 0..255; wcrtomb must REFUSE anything larger instead of truncating it;
 * and mbstate_t carries nothing, because a one-byte encoding never leaves a conversion unfinished.
 */

#include <stddef.h>
#include <wchar.h>
#include <wctype.h>

size_t wcslen(const wchar_t *s)
{
    const wchar_t *p = s;
    while (*p) p++;
    return (size_t)(p - s);
}

wchar_t *wcscpy(wchar_t *d, const wchar_t *s)
{
    wchar_t *r = d;
    while ((*d++ = *s++) != 0) ;
    return r;
}

/* Pads to n and does NOT terminate beyond it, which is str[n]cpy's whole trap and is deliberate. */
wchar_t *wcsncpy(wchar_t *d, const wchar_t *s, size_t n)
{
    size_t i = 0;
    for (; i < n && s[i]; i++) d[i] = s[i];
    for (; i < n; i++) d[i] = 0;
    return d;
}

int wcscmp(const wchar_t *a, const wchar_t *b)
{
    while (*a && *a == *b) { a++; b++; }
    return *a < *b ? -1 : (*a > *b ? 1 : 0);
}

size_t mbrtowc(wchar_t *pwc, const char *s, size_t n, mbstate_t *ps)
{
    unsigned char c;
    (void)ps;
    if (!s) return 0;                    /* "return to the initial state", of which there is none */
    if (n == 0) return (size_t)-2;       /* nothing to look at yet */
    c = (unsigned char)*s;
    if (pwc) *pwc = (wchar_t)c;
    return c ? 1 : 0;                    /* the null character reports 0, not 1 */
}

size_t wcrtomb(char *s, wchar_t wc, mbstate_t *ps)
{
    (void)ps;
    if (!s) return 1;                    /* the length of the null character's sequence */
    if ((unsigned long)wc > 0xFFUL) return (size_t)-1;   /* no C-locale byte means this */
    *s = (char)wc;
    return 1;
}

/*
 * The string forms, on the same one-byte encoding: each byte is its character. A NULL destination
 * asks only for the length (Chromium B.S.U. sizes a message that way); a wide character no byte
 * means stops wcstombs with (size_t)-1.
 */
size_t mbstowcs(wchar_t *dst, const char *src, size_t n)
{
    size_t i = 0;
    if (!dst) { while (src[i]) i++; return i; }
    for (; i < n; i++) {
        dst[i] = (wchar_t)(unsigned char)src[i];
        if (!src[i]) return i;
    }
    return i;
}

size_t wcstombs(char *dst, const wchar_t *src, size_t n)
{
    size_t i = 0;
    for (; !dst || i < n; i++) {
        if ((unsigned long)src[i] > 0xFFUL) return (size_t)-1;
        if (dst) dst[i] = (char)src[i];
        if (!src[i]) return i;
    }
    return i;
}

int iswprint(wint_t c)
{
    return c >= 0x20 && c < 0x7F;
}

/* The C locale's white space: the space and \t \n \v \f \r. */
int iswspace(wint_t c)
{
    return c == 0x20 || (c >= 0x09 && c <= 0x0D);
}

int wcsncmp(const wchar_t *a, const wchar_t *b, size_t n)
{
    while (n && *a && *a == *b) { a++; b++; n--; }
    if (!n) return 0;
    return *a < *b ? -1 : (*a > *b ? 1 : 0);
}
