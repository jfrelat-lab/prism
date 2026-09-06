// headers.js — the header set PRISM ships for the hosted-C environment.
//
// gcc compiles the SAME source against its own headers; these exist only so that an unmodified
// `#include <stdio.h>` resolves on PRISM's side. They therefore declare exactly what
// src/runtime/runtime.js implements and nothing more — a declaration with no implementation would
// turn a clean "undeclared function" error into a mysterious runtime failure.
//
// Types are the i386 ones (`size_t` is `unsigned int`, not `unsigned long`), because a mismatch here
// would show up as a wrong argument width in a printf and be blamed on the emitter.

import { DJGPP_HEADERS } from './headers-djgpp.js';
import { WATCOM_HEADERS, WATCOM_DOS_H, WATCOM_I86_H } from './headers-watcom.js';
import { SDL2_HEADERS } from './headers-sdl2.js';
import { WIN32_HEADERS } from './headers-win32.js';

const STDDEF = `
#ifndef _PRISM_STDDEF_H
#define _PRISM_STDDEF_H
typedef unsigned int size_t;
typedef int ptrdiff_t;
#ifndef _PRISM_WCHAR_T
#define _PRISM_WCHAR_T
/*
 * Two ABIs disagree about this and both are in use here. i386 SysV makes wchar_t a signed int, which
 * is what DJGPP and Linux targets get; the Microsoft ABI makes it a 16-bit UTF-16 code unit, and a
 * Win32 program that calls the W entry points or walks a wide string depends on that width.
 */
#ifdef _WIN32
typedef unsigned short wchar_t;
typedef unsigned short wint_t;
#else
typedef int wchar_t;
typedef unsigned int wint_t;
#endif
#endif
#ifndef NULL
#define NULL ((void *)0)
#endif
#define offsetof(t, m) __builtin_offsetof(t, m)
#endif
`;

const INTTYPES = `
#ifndef _PRISM_INTTYPES_H
#define _PRISM_INTTYPES_H
#include <stdint.h>
/*
 * The i386 widths: int and long are 32 bits, long long is 64, and intmax_t is the long long. So the
 * 64-bit conversions need the ll modifier and the 32-bit ones need none -- which is the whole reason
 * these macros exist rather than being spelled inline at each call.
 */
#define PRId8    "d"
#define PRIi8    "i"
#define PRIu8    "u"
#define PRIx8    "x"
#define PRIX8    "X"
#define PRId16   "d"
#define PRIi16   "i"
#define PRIu16   "u"
#define PRIx16   "x"
#define PRIX16   "X"
#define PRId32   "d"
#define PRIi32   "i"
#define PRIu32   "u"
#define PRIo32   "o"
#define PRIx32   "x"
#define PRIX32   "X"
#define PRId64   "lld"
#define PRIi64   "lli"
#define PRIu64   "llu"
#define PRIo64   "llo"
#define PRIx64   "llx"
#define PRIX64   "llX"
#define PRIdMAX  PRId64
#define PRIiMAX  PRIi64
#define PRIuMAX  PRIu64
#define PRIxMAX  PRIx64
#define PRIXMAX  PRIX64
#define PRIdPTR  "d"
#define PRIuPTR  "u"
#define PRIxPTR  "x"
#define SCNd32   "d"
#define SCNu32   "u"
#define SCNx32   "x"
#define SCNd64   "lld"
#define SCNu64   "llu"
#define SCNx64   "llx"
intmax_t strtoimax(const char *nptr, char **endptr, int base);
uintmax_t strtoumax(const char *nptr, char **endptr, int base);
#endif
`;

const WCHAR_H = `
#ifndef _PRISM_WCHAR_H
#define _PRISM_WCHAR_H
#include <stddef.h>
/*
 * The conversion state for the multibyte functions. It has to be a complete type because callers
 * declare one as a struct member -- PuTTY's stripctrl.c holds two -- but nothing here inspects it:
 * the C locale converts one byte at a time and carries no state between calls.
 */
typedef struct { int __count; unsigned int __value; } mbstate_t;
#define WEOF ((wint_t)-1)
size_t wcslen(const wchar_t *s);
wchar_t *wcscpy(wchar_t *d, const wchar_t *s);
wchar_t *wcsncpy(wchar_t *d, const wchar_t *s, size_t n);
int wcscmp(const wchar_t *a, const wchar_t *b);
int wcsncmp(const wchar_t *a, const wchar_t *b, size_t n);
size_t mbrtowc(wchar_t *pwc, const char *s, size_t n, mbstate_t *ps);
size_t wcrtomb(char *s, wchar_t wc, mbstate_t *ps);
#endif
`;

const WCTYPE_H = `
#ifndef _PRISM_WCTYPE_H
#define _PRISM_WCTYPE_H
#include <stddef.h>
int iswprint(wint_t c);
#endif
`;

const STDIO = `
#ifndef _PRISM_STDIO_H
#define _PRISM_STDIO_H
#include <stddef.h>
typedef struct _PRISM_FILE FILE;
/*
 * TENTATIVE definitions, not externs — the same reason as errno: these have to EXIST somewhere and no
 * PRISM translation unit defines them. C89's common-symbol rule merges them by name across units, and
 * installStdio fills in the three sentinels once the image is linked.
 */
FILE *stdin;
FILE *stdout;
FILE *stderr;
#define EOF (-1)
#define BUFSIZ 8192
#define FILENAME_MAX 4096
#define FOPEN_MAX 64
#define L_tmpnam 20
#define TMP_MAX 238328
int printf(const char *fmt, ...);
int fprintf(FILE *stream, const char *fmt, ...);
int sprintf(char *dst, const char *fmt, ...);
int snprintf(char *dst, size_t n, const char *fmt, ...);
int puts(const char *s);
int putchar(int c);
int fputs(const char *s, FILE *stream);
int fputc(int c, FILE *stream);
int putc(int c, FILE *stream);
int vprintf(const char *fmt, char *ap);
int vfprintf(FILE *stream, const char *fmt, char *ap);
int vsprintf(char *dst, const char *fmt, char *ap);
int vsnprintf(char *dst, size_t n, const char *fmt, char *ap);
FILE *fopen(const char *name, const char *mode);
FILE *freopen(const char *name, const char *mode, FILE *stream);
int fclose(FILE *stream);
size_t fread(void *dst, size_t size, size_t count, FILE *stream);
size_t fwrite(const void *src, size_t size, size_t count, FILE *stream);
int fseek(FILE *stream, long off, int whence);
long ftell(FILE *stream);
void rewind(FILE *stream);
int fgetc(FILE *stream);
int getc(FILE *stream);
int ungetc(int c, FILE *stream);
char *fgets(char *dst, int n, FILE *stream);
int feof(FILE *stream);
int ferror(FILE *stream);
void clearerr(FILE *stream);
int fflush(FILE *stream);
/* POSIX, and it lives HERE because its argument is a FILE * -- declaring it in <sys/stat.h>
   broke every program that includes that header without <stdio.h>, Doom among them. */
int fileno(FILE *stream);
void perror(const char *s);
void setbuf(FILE *stream, char *buf);
int setvbuf(FILE *stream, char *buf, int mode, size_t size);
FILE *popen(const char *cmd, const char *mode);
int pclose(FILE *stream);
#define _IONBF 2
#define _IOLBF 1
#define _IOFBF 0
int remove(const char *name);
int rename(const char *from, const char *to);
int fscanf(FILE *stream, const char *fmt, ...);
int sscanf(const char *s, const char *fmt, ...);
int scanf(const char *fmt, ...);
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#endif
`;

const STDLIB = `
char *getenv(const char *name);

double atof(const char *s);
long atol(const char *s);

#ifndef _PRISM_STDLIB_H
#define _PRISM_STDLIB_H
#include <stddef.h>
void *malloc(size_t n);
void *calloc(size_t n, size_t sz);
void *realloc(void *p, size_t n);
void free(void *p);
void exit(int code);
void abort(void);
double strtod(const char *s, char **end);
float strtof(const char *s, char **end);
int system(const char *cmd);
char *tmpnam(char *buf);
long random(void);
void srandom(unsigned seed);
int atoi(const char *s);
void qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *));
int putenv(char *s);
long atol(const char *s);
int abs(int v);
long labs(long v);
#define MB_CUR_MAX ((size_t)1)
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#endif
long strtol(const char *s, char **end, int base);
unsigned long strtoul(const char *s, char **end, int base);
`;

const STRING = `

#ifndef _PRISM_STRING_H
#define _PRISM_STRING_H
#include <stddef.h>
size_t strlen(const char *s);
char *strcpy(char *d, const char *s);
char *strncpy(char *d, const char *s, size_t n);
char *strcat(char *d, const char *s);
int strcmp(const char *a, const char *b);
int strncmp(const char *a, const char *b, size_t n);
char *strchr(const char *s, int c);
char *strpbrk(const char *s, const char *accept);
char *strrchr(const char *s, int c);
char *strncat(char *d, const char *s, size_t n);
/* strcoll compares in the LOCALE's collating order; there is one locale here and it is C, where
   that order is strcmp's. Saying so is the whole implementation. */
int strcoll(const char *a, const char *b);
char *strdup(const char *s);
char *strtok(char *s, const char *delim);
void *memcpy(void *d, const void *s, size_t n);
void *memmove(void *d, const void *s, size_t n);
void *memset(void *d, int v, size_t n);
int memcmp(const void *a, const void *b, size_t n);
int strcasecmp(const char *a, const char *b);
int strncasecmp(const char *a, const char *b, size_t n);
#endif
`;

const MATH = `
#define INFINITY (1.0e308 * 10.0)
#define NAN (INFINITY - INFINITY)
#define HUGE_VAL INFINITY

/*
 * The M_ constants. Not ISO C -- they are X/Open, and glibc hides them behind _USE_MATH_DEFINES on
 * some targets -- but every DJGPP and Unix math.h of this era defined them unconditionally, and
 * programs of this era use them unconditionally: MAME 0.4's cclimber/PSG.C builds its wave table
 * with \`128*cos(2*M_PI*i/WTS)\` and nothing declares M_PI itself.
 */
#define M_E        2.7182818284590452354
#define M_LOG2E    1.4426950408889634074
#define M_LOG10E   0.43429448190325182765
#define M_LN2      0.69314718055994530942
#define M_LN10     2.30258509299404568402
#define M_PI       3.14159265358979323846
#define M_PI_2     1.57079632679489661923
#define M_PI_4     0.78539816339744830962
#define M_1_PI     0.31830988618379067154
#define M_2_PI     0.63661977236758134308
#define M_2_SQRTPI 1.12837916709551257390
#define M_SQRT2    1.41421356237309504880
#define M_SQRT1_2  0.70710678118654752440

#ifndef _PRISM_MATH_H
#define _PRISM_MATH_H
double sqrt(double x);
double sin(double x);
double cos(double x);
double tan(double x);
double atan(double x);
double asin(double x);
double round(double x);
double trunc(double x);
long lround(double x);
float roundf(float x);
float truncf(float x);
double acos(double x);
double atan2(double y, double x);
double exp(double x);
double log(double x);
double log10(double x);
double pow(double x, double y);
double floor(double x);
double ceil(double x);
double fabs(double x);
double fmod(double x, double y);
/*
 * The float family. Each is the double one rounded to float on the way out, which is what the C
 * library guarantees and what Math.fround expresses exactly. Named because csmith's safe_math.h
 * calls fabsf on every float operation it guards -- nothing hand-written here had ever needed one.
 */
float sqrtf(float x);
float sinf(float x);
float cosf(float x);
float tanf(float x);
float atanf(float x);
float atan2f(float y, float x);
float expf(float x);
float logf(float x);
float log10f(float x);
float powf(float x, float y);
float floorf(float x);
float ceilf(float x);
float fabsf(float x);
float fmodf(float x, float y);
double ldexp(double x, int e);
float ldexpf(float x, int e);
double frexp(double x, int *e);
#endif
`;

// The i386 values, which is the whole reason this file cannot borrow the host's limits.h.
const LIMITS = `
#define PATH_MAX 4096
#define NAME_MAX 255

#ifndef _PRISM_LIMITS_H
#define _PRISM_LIMITS_H
#define CHAR_BIT 8
/*
 * The BIGGEST multibyte character in ANY locale, which is why it is a limits.h constant and not a
 * locale one: callers size a stack buffer with it. MB_CUR_MAX, in stdlib.h, is the current locale's
 * value, and PRISM's only locale is "C" -- one byte.
 */
#define MB_LEN_MAX 16
#define SCHAR_MIN (-128)
#define SCHAR_MAX 127
#define UCHAR_MAX 255
#define CHAR_MIN SCHAR_MIN
#define CHAR_MAX SCHAR_MAX
#define SHRT_MIN (-32768)
#define SHRT_MAX 32767
#define USHRT_MAX 65535
#define INT_MIN (-2147483647 - 1)
#define INT_MAX 2147483647
#define UINT_MAX 4294967295U
#define LONG_MIN (-2147483647L - 1L)
#define LONG_MAX 2147483647L
#define ULONG_MAX 4294967295UL
#endif
`;

const ASSERT = `
#ifndef _PRISM_ASSERT_H
#define _PRISM_ASSERT_H
#ifdef NDEBUG
#define assert(e) ((void)0)
#else
#include <stdio.h>
void abort(void);
/*
 * WHERE, and WHAT. "assertion failed" on its own means bisecting the program by hand to find out
 * which one -- 156 translation units of PuTTY is where that stopped being tolerable. C99 7.2.1.1
 * requires the text of the expression, the file and the line, and requires them on STDERR: writing
 * them to stdout would also put them into anything that diffs a program's output against gcc's.
 */
#define assert(e) \
    ((e) ? (void)0 \
         : (fprintf(stderr, "%s:%d: assertion failed: %s\\n", __FILE__, __LINE__, #e), abort()))
#endif
#endif
`;

const STDINT = `
#define INT64_C(v)  v ## LL
#define UINT64_C(v) v ## ULL
#define INT32_C(v)  v
#define UINT32_C(v) v ## U

#ifndef _PRISM_STDINT_H
#define _PRISM_STDINT_H
typedef signed char int8_t;
typedef unsigned char uint8_t;
typedef short int16_t;
typedef unsigned short uint16_t;
typedef int int32_t;
typedef unsigned int uint32_t;
typedef long long int64_t;
typedef unsigned long long uint64_t;
typedef long long intmax_t;
typedef unsigned long long uintmax_t;
typedef int intptr_t;
typedef unsigned int uintptr_t;
typedef signed char int_fast8_t;
typedef unsigned char uint_fast8_t;
typedef int int_fast16_t;
typedef unsigned int uint_fast16_t;
typedef int int_fast32_t;
typedef unsigned int uint_fast32_t;
typedef long long int_fast64_t;
typedef unsigned long long uint_fast64_t;
typedef signed char int_least8_t;
typedef unsigned char uint_least8_t;
typedef short int_least16_t;
typedef unsigned short uint_least16_t;
typedef int int_least32_t;
typedef unsigned int uint_least32_t;
typedef long long int_least64_t;
typedef unsigned long long uint_least64_t;
#define INT8_MIN (-128)
#define INT8_MAX 127
#define UINT8_MAX 255
#define INT16_MIN (-32768)
#define INT16_MAX 32767
#define UINT16_MAX 65535
#define INT32_MIN (-2147483647 - 1)
#define INT32_MAX 2147483647
#define UINT32_MAX 4294967295U
/*
 * The 64-bit half was missing entirely, which is only visible to a program that NAMES int64_t --
 * every hand-written test and all four game targets use long long directly. csmith names it in the
 * first hundred lines it emits.
 */
#define INT64_MIN  (-9223372036854775807LL - 1)
#define INT64_MAX  9223372036854775807LL
#define UINT64_MAX 18446744073709551615ULL
#define INTMAX_MIN INT64_MIN
#define INTMAX_MAX INT64_MAX
#define UINTMAX_MAX UINT64_MAX
#define INTPTR_MIN INT32_MIN
#define INTPTR_MAX INT32_MAX
#define UINTPTR_MAX UINT32_MAX
#define PTRDIFF_MIN INT32_MIN
#define PTRDIFF_MAX INT32_MAX
#define SIZE_MAX UINT32_MAX
#endif
`;

const STDBOOL = `
#ifndef _PRISM_STDBOOL_H
#define _PRISM_STDBOOL_H
#define bool _Bool
#define true 1
#define false 0
#define __bool_true_false_are_defined 1
#endif
`;

const FLOATH = `
#ifndef _PRISM_FLOAT_H
#define _PRISM_FLOAT_H
#define FLT_RADIX 2
#define FLT_MANT_DIG 24
#define DBL_MANT_DIG 53
#define FLT_DIG 6
#define DBL_DIG 15
#define DBL_MAX_10_EXP 308
#define DBL_MIN_10_EXP (-307)
#define DBL_MAX_EXP 1024
#define DBL_MIN_EXP (-1021)
#define FLT_MIN_EXP (-125)
#define DBL_MIN_EXP (-1021)
#define FLT_MAX_EXP 128
#define DBL_MAX_EXP 1024
#define FLT_EPSILON 1.19209290e-07F
#define DBL_EPSILON 2.2204460492503131e-16
#define FLT_MAX 3.40282347e+38F
#define DBL_MAX 1.7976931348623157e+308
#define FLT_MIN 1.17549435e-38F
#define DBL_MIN 2.2250738585072014e-308
#endif
`;

const STDARG = `
#ifndef _PRISM_STDARG_H
#define _PRISM_STDARG_H
/*
 * On i386 System V the variadic arguments sit contiguously in memory and va_list is just a pointer
 * into them, so va_arg needs no compiler magic — only pointer arithmetic. __prism_va_start() hands
 * back the buffer the CALLER packed; __prism_va_next() post-increments the walker by the argument's
 * slot size and returns the old position, which is exactly what a dereference wants.
 */
typedef char *va_list;
char *__prism_va_start(void);
char *__prism_va_next(va_list *ap, unsigned size);
#define va_start(ap, last) ((ap) = __prism_va_start())
/*
 * va_end EVALUATES its argument. It has nothing to clean up here, but discarding the expression
 * discards its side effects too, and gcc's does not: va-arg-21.c writes va_end(**ap_ptr++) and
 * checks that the pointer moved. The bug was latent until vprintf existed — before that the test
 * could not compile, so it counted as a refusal instead of a wrong answer.
 */
#define va_end(ap) ((void)(ap))
#define va_copy(dst, src) ((dst) = (src))
#define va_arg(ap, type) (*(type *)__prism_va_next(&(ap), sizeof(type)))
#endif
`;

const TIMEH = `
struct tm {
    int tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year, tm_wday, tm_yday, tm_isdst;
};
struct timespec { long tv_sec; long tv_nsec; };
struct tm *localtime(const long *t);
struct tm *gmtime(const long *t);
long mktime(struct tm *tm);
double difftime(long a, long b);
size_t strftime(char *s, size_t max, const char *fmt, const struct tm *tm);
int gettimeofday(struct timeval *tv, void *tz);
int nanosleep(const struct timespec *req, struct timespec *rem);
int utimes(const char *path, const struct timeval *times);

#ifndef _PRISM_TIME_H
#define _PRISM_TIME_H
typedef unsigned long clock_t;
typedef long time_t;
#define CLOCKS_PER_SEC 1000000
#define UCLOCKS_PER_SEC 1000000
clock_t clock(void);
time_t time(time_t *t);

/*
 * DJGPP's own high-resolution clock. MAME 0.1 uses uclock() unless UNIX is defined, so a DJGPP
 * target has to supply it — with DJGPP's real values: uclock_t is 64-bit and UCLOCKS_PER_SEC is the
 * PIT rate, 1193180, which is what a program dividing by it expects.
 */
typedef unsigned long long uclock_t;
#define UCLOCKS_PER_SEC 1193180
uclock_t uclock(void);
#endif
`;

const SETJMP = `
#ifndef _PRISM_SETJMP_H
#define _PRISM_SETJMP_H
/*
 * jmp_buf is an ARRAY, as every real setjmp.h makes it, so that \jmp_buf b;\ declares storage and
 * passing it decays to a pointer. PRISM stores two words in it: the shadow-stack frame that called
 * setjmp, and the resume point inside that function.
 */
typedef int jmp_buf[8];
int setjmp(jmp_buf env);
void longjmp(jmp_buf env, int val);
#define setjmp setjmp
#endif
`;

const ERRNO = `
#ifndef _PRISM_ERRNO_H
#define _PRISM_ERRNO_H
/*
 * A TENTATIVE definition, not an extern. errno has to exist somewhere and no PRISM translation unit
 * defines it; C89's common-symbol rule merges tentative definitions across units by name, which is
 * how libcs of this era did it and how PRISM's linker resolves globals.
 *
 * A plain int, not a TLS accessor: there is one thread inside the guest.
 *
 * (No backticks in this comment on purpose. These header strings are JS template literals, and a
 * backtick inside one ends it -- a trap this file has sprung twice now.)
 */
int errno;
/*
 * Linux/i386 numbering, because that is the ABI PRISM targets. Only the values a program is likely to
 * NAME are here -- SQLite switches on EAGAIN and EINTR, and an undefined one reaches the parser as a
 * bare identifier rather than as a number.
 */
#define EPERM   1
#define ENOENT  2
#define ESRCH   3
#define EINTR   4
#define EIO     5
#define ENXIO   6
#define E2BIG   7
#define EBADF   9
#define ECHILD  10
#define EAGAIN  11
#define EWOULDBLOCK EAGAIN
#define ENOMEM  12
#define EACCES  13
#define EFAULT  14
#define EBUSY   16
#define EEXIST  17
#define EXDEV   18
#define ENODEV  19
#define ENOTDIR 20
#define EISDIR  21
#define EINVAL  22
#define ENFILE  23
#define EMFILE  24
#define ENOTTY  25
#define ETXTBSY 26
#define EFBIG   27
#define ENOSPC  28
#define ESPIPE  29
#define EROFS   30
#define EMLINK  31
#define EPIPE   32
#define EDOM    33
#define ERANGE  34
/*
 * The socket errnos, with Linux's i386 numbers -- the ABI PRISM targets, so these are its values and
 * not a plausible set. Quake II's net_udp.c compares errno against ECONNREFUSED and EWOULDBLOCK to
 * decide whether a failed recvfrom is fatal, which is the ordinary way a UDP program of this era
 * tells "no packet" from "the network is broken".
 */
#define EADDRINUSE      98
#define EADDRNOTAVAIL   99
#define ENETDOWN        100
#define ENETUNREACH     101
#define ECONNRESET      104
#define ECONNREFUSED    111
#define EINPROGRESS     115
#define EDEADLK 35
#define ENAMETOOLONG 36
#define ENOLCK  37
#define ENOSYS  38
#define ENOTEMPTY 39
#define ELOOP   40
#define EOVERFLOW 75
#define ETIMEDOUT 110
#endif
`;

const FCNTL = `
#ifndef _PRISM_FCNTL_H
#define _PRISM_FCNTL_H
#define O_RDONLY 0
#define O_WRONLY 1
#define O_RDWR   2
#define O_CREAT  0x40
#define O_TRUNC  0x200
#define O_APPEND 0x400
#define O_BINARY 0
#define O_EXCL   0x80
#define O_NOFOLLOW 0x20000
#define FNDELAY  O_NONBLOCK
#define O_NDELAY O_NONBLOCK
#define O_NONBLOCK 0x800
#define O_ACCMODE 3
int open(const char *name, int flags, ...);
int fcntl(int fd, int cmd, ...);
#define F_GETFD 1
#define F_SETFD 2
#define F_GETFL 3
#define F_SETFL 4
#define F_SETLK 6
#define F_SETLKW 7
#define F_GETLK 5
#define F_RDLCK 0
#define F_WRLCK 1
#define F_UNLCK 2
struct flock { short l_type; short l_whence; long l_start; long l_len; int l_pid; };
#endif
`;


/*
 * dirent.h -- d_name and nothing else.
 *
 * The other members are not omitted for brevity: this host has no inodes and no directory offsets,
 * so d_ino and d_off could only be invented. Every reader in the corpus uses d_name alone.
 */
const DIRENT = `
#ifndef _PRISM_DIRENT_H
#define _PRISM_DIRENT_H
struct dirent { char d_name[256]; };
typedef struct __prism_DIR DIR;
DIR *opendir(const char *path);
struct dirent *readdir(DIR *d);
int closedir(DIR *d);
#endif
`;


/*
 * dlfcn.h. The flags are glibc's values; nothing here acts on them, because nothing is loaded --
 * see src/env/dl.js for why a program can still dlopen part of itself.
 */
const DLFCN = `
#ifndef _PRISM_DLFCN_H
#define _PRISM_DLFCN_H
#define RTLD_LAZY   0x0001
#define RTLD_NOW    0x0002
#define RTLD_GLOBAL 0x0100
#define RTLD_LOCAL  0x0000
void *dlopen(const char *path, int flags);
void *dlsym(void *handle, const char *name);
int   dlclose(void *handle);
char *dlerror(void);
#endif
`;

/*
 * mntent.h, for the one thing Quake II uses it for: walking /etc/mtab to find a mounted CD-ROM.
 * There are no mounts here, so setmntent reports none and the search finds nothing -- which is the
 * same outcome as a machine with no CD in the drive, and the program handles that.
 */
const MNTENT = `
#ifndef _PRISM_MNTENT_H
#define _PRISM_MNTENT_H
#include <stdio.h>
struct mntent { char *mnt_fsname, *mnt_dir, *mnt_type, *mnt_opts; int mnt_freq, mnt_passno; };
FILE *setmntent(const char *file, const char *mode);
struct mntent *getmntent(FILE *stream);
int endmntent(FILE *stream);
#endif
`;

/*
 * locale.h. There is ONE locale here and it is the C locale, so localeconv answers with the C
 * locale's own values -- a full stop for the decimal point and nothing else set. That is not a
 * placeholder: it is what a program in setlocale(LC_ALL, "C") is entitled to read, and Lua reads
 * exactly one field of it (lconv->decimal_point, to know how to print a number).
 */
const LOCALE_H = `
#ifndef _PRISM_LOCALE_H
#define _PRISM_LOCALE_H
#define LC_ALL      6
#define LC_COLLATE  3
#define LC_CTYPE    0
#define LC_MONETARY 4
#define LC_NUMERIC  1
#define LC_TIME     2
struct lconv {
    char *decimal_point, *thousands_sep, *grouping;
    char *int_curr_symbol, *currency_symbol, *mon_decimal_point, *mon_thousands_sep;
    char *mon_grouping, *positive_sign, *negative_sign;
    char int_frac_digits, frac_digits, p_cs_precedes, p_sep_by_space;
    char n_cs_precedes, n_sep_by_space, p_sign_posn, n_sign_posn;
};
char *setlocale(int category, const char *locale);
struct lconv *localeconv(void);
#endif
`;

const UNISTD = `
#ifndef _PRISM_UNISTD_H
#define _PRISM_UNISTD_H
#include <stddef.h>
#include <sys/types.h>
int close(int fd);
ssize_t read(int fd, void *dst, size_t n);
ssize_t write(int fd, const void *src, size_t n);
ssize_t pread(int fd, void *dst, size_t n, off_t off);
ssize_t pwrite(int fd, const void *src, size_t n, off_t off);
int unlink(const char *name);
void _exit(int code);
int access(const char *path, int mode);
int getuid(void); int geteuid(void); int getgid(void); int getegid(void);
int setuid(int uid); int seteuid(int uid); int setgid(int gid); int setegid(int gid);
int setreuid(int r, int e); int setregid(int r, int e);
char *getcwd(char *buf, size_t size);
int ftruncate(int fd, off_t len);
int fchmod(int fd, mode_t mode);
int fchown(int fd, uid_t owner, gid_t group);
int rmdir(const char *path);
int geteuid(void);
int getuid(void);
int getgid(void);
int getpid(void);
int getpagesize(void);
int readlink(const char *path, char *buf, size_t n);
int usleep(unsigned int usec);
unsigned int sleep(unsigned int seconds);
int isatty(int fd);
int fsync(int fd);
int fdatasync(int fd);
long sysconf(int name);
#define _SC_PAGESIZE 30
#define _SC_PAGE_SIZE 30
#define F_OK 0
#define X_OK 1
#define W_OK 2
#define R_OK 4
#endif
`;

const PCH = `
#ifndef _PRISM_PC_H
#define _PRISM_PC_H
/*
 * DJGPP's own pc.h defines these as GNU inline assembly, because on real hardware they are two
 * instructions. PRISM supplies the header, so it declares them as functions and implements them in
 * src/env/ports.js -- the same move as supplying stdio.h, and it is what keeps inline assembly off
 * the critical path.
 *
 * Measured before deciding: neither MAME's msdos.c nor Quake's sys_dos.c contains one asm statement
 * of its own. Every port access in both goes through this header.
 */
int inportb(int port);
int inportw(int port);
void outportb(int port, int value);
void outportw(int port, int value);
int inp(int port);
int outp(int port, int value);
/*
 * getche and getwd, the two DOS/BSD spellings Quake's sys_dos.c reaches for. getwd is getcwd with no
 * size argument -- the reason it was removed from POSIX -- so the buffer is assumed large enough,
 * which is what the caller assumed too.
 */
int getche(void);
char *getwd(char *buf);
/*
 * enable/disable are DJGPP's sti and cli. There are no interrupts to mask here -- a handler runs
 * only when this host calls it -- so they are declared for the programs that bracket critical
 * sections with them and do nothing, which is the truthful answer rather than a convenient one.
 */
void enable(void);
void disable(void);
#endif
`;

const CTYPE = `
#ifndef _PRISM_CTYPE_H
#define _PRISM_CTYPE_H
/*
 * The C locale, and only the C locale. Every one of these is a pure function of a byte value, so
 * they are declared here and implemented in the runtime rather than as the lookup-table macros a
 * real libc uses -- a table would have to live in guest memory for a program that takes their
 * address, and nothing does.
 */
int isalnum(int c);
int isalpha(int c);
int iscntrl(int c);
int isdigit(int c);
int isgraph(int c);
int islower(int c);
int isprint(int c);
int ispunct(int c);
int isspace(int c);
int isupper(int c);
int isxdigit(int c);
int tolower(int c);
int toupper(int c);
#endif
`;

const SYS_TYPES = `
#ifndef _PRISM_SYS_TYPES_H
#define _PRISM_SYS_TYPES_H
#include <stddef.h>
/*
 * i386 System V widths. off_t is 32-bit here rather than the 64-bit largefile variant, because that
 * is what a 1990s i386 build saw and PRISM targets that ABI; a program wanting large files would
 * define _FILE_OFFSET_BITS and get a different type from a real libc, which is a decision to make
 * when a program actually asks for it.
 */
typedef int pid_t;
typedef long off_t;
typedef long ssize_t;
typedef unsigned int mode_t;
typedef unsigned int uid_t;
typedef unsigned int gid_t;
typedef unsigned long dev_t;
typedef unsigned long ino_t;
typedef unsigned int nlink_t;
typedef long blksize_t;
typedef long blkcnt_t;
typedef long time_t;
typedef unsigned int useconds_t;
#endif
`;

const SYS_STAT = `
#ifndef _PRISM_SYS_STAT_H
#define _PRISM_SYS_STAT_H
#include <sys/types.h>
struct stat {
    dev_t     st_dev;
    ino_t     st_ino;
    mode_t    st_mode;
    nlink_t   st_nlink;
    uid_t     st_uid;
    gid_t     st_gid;
    dev_t     st_rdev;
    off_t     st_size;
    blksize_t st_blksize;
    blkcnt_t  st_blocks;
    time_t    st_atime;
    time_t    st_mtime;
    time_t    st_ctime;
};
#define S_IFMT   0170000
#define S_IFREG  0100000
#define S_IFDIR  0040000
#define S_IFCHR  0020000
#define S_ISREG(m)  (((m) & S_IFMT) == S_IFREG)
#define S_ISDIR(m)  (((m) & S_IFMT) == S_IFDIR)
#define S_ISCHR(m)  (((m) & S_IFMT) == S_IFCHR)
#define S_IFLNK  0120000
#define S_ISLNK(m)  (((m) & S_IFMT) == S_IFLNK)
#define S_IRUSR 0400
#define S_IWUSR 0200
#define S_IXUSR 0100
#define S_IRWXU 0700
int stat(const char *path, struct stat *st);
int fstat(int fd, struct stat *st);
int lstat(const char *path, struct stat *st);
int mkdir(const char *path, mode_t mode);
int chmod(const char *path, mode_t mode);
mode_t umask(mode_t mask);
#endif
`;

const SYS_MMAN = `
#ifndef _PRISM_SYS_MMAN_H
#define _PRISM_SYS_MMAN_H
#include <sys/types.h>
#define PROT_NONE  0
#define PROT_READ  1
#define PROT_WRITE 2
#define PROT_EXEC  4
#define MAP_SHARED  1
#define MAP_PRIVATE 2
#define MAP_ANONYMOUS 0x20
/* MAP_FILE is 0 on Linux -- a mapping is file-backed unless MAP_ANONYMOUS says otherwise. Quake's
   snd_linux.c writes MAP_FILE|MAP_SHARED when it mmaps /dev/dsp, which is how it went missing. */
#define MAP_FILE 0
#define MAP_FAILED ((void *) -1)
void *mmap(void *addr, size_t len, int prot, int flags, int fd, off_t off);
int munmap(void *addr, size_t len);
int mprotect(void *addr, size_t len, int prot);
int msync(void *addr, size_t len, int flags);
#endif
`;

const SYS_IOCTL = `
#ifndef _PRISM_SYS_IOCTL_H
#define _PRISM_SYS_IOCTL_H
int ioctl(int fd, unsigned long request, ...);
#endif
`;

const XLIB = `
#ifndef _PRISM_XLIB_H
#define _PRISM_XLIB_H
/*
 * Xlib, declared for a host that implements the LIBRARY and not the protocol -- see src/env/x11.js.
 * Every symbol here appears in Doom's i_video.c; nothing is declared on speculation.
 *
 * The struct layouts here and the offsets in x11.js are one thing written twice. Changing either
 * without the other is a silent bug, which is why both say so.
 */
typedef struct _XDisplay Display;
typedef unsigned long Window;
typedef unsigned long Drawable;
typedef unsigned long Colormap;
typedef unsigned long Pixmap;
typedef unsigned long Cursor;
typedef unsigned long Atom;
typedef unsigned long VisualID;
typedef unsigned long KeySym;
typedef unsigned long Time;
typedef struct _XGC *GC;
struct _XVisual {
    void *ext_data;
    VisualID visualid;
    int class;
    unsigned long red_mask, green_mask, blue_mask;
    int bits_per_rgb;
    int map_entries;
};
typedef struct _XVisual Visual;
typedef int Status;
typedef int Bool;

typedef struct {
    int width, height;
    int xoffset;
    int format;
    char *data;
    int byte_order;
    int bitmap_unit;
    int bitmap_bit_order;
    int bitmap_pad;
    int depth;
    int bytes_per_line;
    int bits_per_pixel;
    unsigned long red_mask, green_mask, blue_mask;
    char *obdata;
    int pad[4];
} XImage;

typedef struct {
    Visual *visual;
    VisualID visualid;
    int screen;
    int depth;
    int class;
    unsigned long red_mask, green_mask, blue_mask;
    int colormap_size;
    int bits_per_rgb;
} XVisualInfo;

typedef struct {
    unsigned long pixel;
    unsigned short red, green, blue;
    char flags;
    char pad;
} XColor;

typedef struct {
    Pixmap background_pixmap;
    unsigned long background_pixel;
    Pixmap border_pixmap;
    unsigned long border_pixel;
    int bit_gravity, win_gravity, backing_store;
    unsigned long backing_planes, backing_pixel;
    Bool save_under;
    long event_mask, do_not_propagate_mask;
    Bool override_redirect;
    Colormap colormap;
    Cursor cursor;
} XSetWindowAttributes;

typedef struct { int function; unsigned long plane_mask, foreground, background;
                 int line_width, line_style, cap_style, join_style, fill_style, fill_rule;
                 int arc_mode; Pixmap tile, stipple; int ts_x_origin, ts_y_origin;
                 unsigned long font; int subwindow_mode; Bool graphics_exposures;
                 int clip_x_origin, clip_y_origin; Pixmap clip_mask;
                 int dash_offset; char dashes; } XGCValues;

typedef struct { int type; unsigned long serial; Bool send_event; Display *display;
                 Window window, root, subwindow; Time time; int x, y, x_root, y_root;
                 unsigned int state, keycode; Bool same_screen; } XKeyEvent;
typedef struct { int type; unsigned long serial; Bool send_event; Display *display;
                 Window window, root, subwindow; Time time; int x, y, x_root, y_root;
                 unsigned int state, button; Bool same_screen; } XButtonEvent;
typedef struct { int type; unsigned long serial; Bool send_event; Display *display;
                 Window window, root, subwindow; Time time; int x, y, x_root, y_root;
                 unsigned int state; char is_hint; Bool same_screen; } XMotionEvent;
typedef struct { int type; unsigned long serial; Bool send_event; Display *display;
                 Window window; int x, y, width, height, count; } XExposeEvent;

typedef struct {
    int type;
    unsigned long serial;
    Bool send_event;
    Display *display;
    Window event, window;
    int x, y, width, height, border_width;
    Window above;
    Bool override_redirect;
} XConfigureEvent;

/*
 * A CLIENT MESSAGE, which is how a window manager tells a client to close itself: the client interns
 * WM_DELETE_WINDOW, asks for it with XSetWMProtocols, and the manager sends it here. Quake's SUN
 * driver answers it with Host_Quit_f -- its Linux driver never asks, so this arrived with the SUN
 * platform layer.
 */
typedef struct {
    int type;
    unsigned long serial;
    Bool send_event;
    Display *display;
    Window window;
    Atom message_type;
    int format;
    union { char b[20]; short s[10]; long l[5]; } data;
} XClientMessageEvent;

typedef union _XEvent {
    int type;
    XKeyEvent xkey;
    XButtonEvent xbutton;
    XMotionEvent xmotion;
    XExposeEvent xexpose;
    XConfigureEvent xconfigure;
    XClientMessageEvent xclient;
    long pad[24];
} XEvent;

#define None 0L
#define True 1
#define False 0
#define GXclear 0x0
#define GXcopy 0x3
#define Button1Mask (1<<8)
#define Button2Mask (1<<9)
#define Button3Mask (1<<10)
#define ShiftMask (1<<0)
#define ControlMask (1<<2)
#define Mod1Mask (1<<3)
#define AnyPropertyType 0L
#define GCFunction (1L<<0)
#define GCForeground (1L<<2)
#define GCBackground (1L<<3)
#define GCGraphicsExposures (1L<<16)
#define Button1 1
#define Button2 2
#define Button3 3
#define CurrentTime 0L
#define InputOutput 1
#define ZPixmap 2
#define PseudoColor 3
#define TrueColor 4
#define GrabModeAsync 1
#define KeyPress 2
#define KeyRelease 3
#define ButtonPress 4
#define ButtonRelease 5
#define MotionNotify 6
#define Expose 12
#define GraphicsExpose 13
#define NoExpose 14
#define VisibilityNotify 15
#define CreateNotify 16
#define DestroyNotify 17
#define UnmapNotify 18
#define MapNotify 19
#define MapRequest 20
#define ReparentNotify 21
#define ConfigureNotify 22
#define ClientMessage 33
#define MappingNotify 34
#define ConfigureRequest 23
#define GravityNotify 24
#define ResizeRequest 25
#define EnterNotify 7
#define LeaveNotify 8
#define FocusIn 9
#define FocusOut 10
#define KeymapNotify 11
#define DoRed 1
#define DoGreen 2
#define DoBlue 4
#define CWBackPixel (1L<<1)
#define CWBorderPixel (1L<<3)
#define CWEventMask (1L<<11)
#define CWColormap (1L<<13)
#define NoEventMask 0L
#define KeyPressMask (1L<<0)
#define KeyReleaseMask (1L<<1)
#define ButtonPressMask (1L<<2)
#define ButtonReleaseMask (1L<<3)
#define PointerMotionMask (1L<<6)
#define ExposureMask (1L<<15)
#define StructureNotifyMask (1L<<17)
/* The rest of the mask, from X.h. A driver that asks for the whole desktop's worth of events --
   Quake's SUN one does -- names all of them, and a missing macro reads as an undeclared identifier
   inside a constant expression, which is a confusing way to say "this header is short". */
#define EnterWindowMask (1L<<4)
#define LeaveWindowMask (1L<<5)
#define PointerMotionHintMask (1L<<7)
#define Button1MotionMask (1L<<8)
#define Button2MotionMask (1L<<9)
#define Button3MotionMask (1L<<10)
#define Button4MotionMask (1L<<11)
#define Button5MotionMask (1L<<12)
#define ButtonMotionMask (1L<<13)
#define KeymapStateMask (1L<<14)
#define VisibilityChangeMask (1L<<16)
#define ResizeRedirectMask (1L<<18)
#define SubstructureNotifyMask (1L<<19)
#define SubstructureRedirectMask (1L<<20)
#define FocusChangeMask (1L<<21)
#define PropertyChangeMask (1L<<22)
#define ColormapChangeMask (1L<<23)
#define OwnerGrabButtonMask (1L<<24)
#define AllocNone 0
#define AllocAll 1
#define DefaultScreen(d) XDefaultScreen(d)
#define RootWindow(d,s) XRootWindow(d,s)
#define DisplayWidth(d,s) 640
#define DisplayHeight(d,s) 480

/*
 * The SCREEN, asked for the same numbers by the other spelling: Quake's Linux driver writes
 * DisplayWidth(dpy, screen) and its SUN driver writes WidthOfScreen(ScreenOfDisplay(dpy, screen)).
 * Both must answer the same thing, so the macros above and these agree on 640x480 -- one fixed
 * display, chosen once, rather than two.
 */
typedef struct _XScreen Screen;
Screen *ScreenOfDisplay(Display *d, int screen);
int WidthOfScreen(Screen *s);
int HeightOfScreen(Screen *s);
#define DefaultScreenOfDisplay(d) ScreenOfDisplay(d, XDefaultScreen(d))

/* XConfigureWindow's stack_mode, from X.h. */
#define Above     0
#define Below     1
#define TopIf     2
#define BottomIf  3
#define Opposite  4

Display *XOpenDisplay(const char *name);
int XCloseDisplay(Display *d);
int XDefaultScreen(Display *d);
Window XRootWindow(Display *d, int screen);
int XSync(Display *d, Bool discard);
int XFlush(Display *d);
int XSynchronize(Display *d, Bool on);
Colormap XCreateColormap(Display *d, Window w, Visual *v, int alloc);
GC XCreateGC(Display *d, Drawable dr, unsigned long mask, XGCValues *values);
int XFreeGC(Display *d, GC gc);
Pixmap XCreatePixmap(Display *d, Drawable dr, unsigned int w, unsigned int h, unsigned int depth);
int XFreePixmap(Display *d, Pixmap p);
Cursor XCreatePixmapCursor(Display *d, Pixmap src, Pixmap mask, XColor *fg, XColor *bg,
                           unsigned int x, unsigned int y);
int XDefineCursor(Display *d, Window w, Cursor c);
int XFillRectangle(Display *d, Drawable dr, GC gc, int x, int y, unsigned int w, unsigned int h);
int XGrabPointer(Display *d, Window grab, Bool owner, unsigned int mask, int pmode, int kmode,
                 Window confine, Cursor cursor, Time t);
int XUngrabPointer(Display *d, Time t);
int XWarpPointer(Display *d, Window src, Window dst, int sx, int sy,
                 unsigned int sw, unsigned int sh, int dx, int dy);
int XSelectInput(Display *d, Window w, long mask);
int XStoreName(Display *d, Window w, const char *name);
int XSetWindowColormap(Display *d, Window w, Colormap c);
int XAutoRepeatOn(Display *d);
int XAutoRepeatOff(Display *d);
int XMapWindow(Display *d, Window w);
VisualID XVisualIDFromVisual(Visual *v);
Status XMatchVisualInfo(Display *d, int screen, int depth, int class, XVisualInfo *info);
XVisualInfo *XGetVisualInfo(Display *d, long mask, XVisualInfo *template, int *nitems);
Visual *XDefaultVisual(Display *d, int screen);
int XDestroyWindow(Display *d, Window w);
int XFreeColormap(Display *d, Colormap c);
#define DefaultVisual(d, s) XDefaultVisual(d, s)
#define VisualIDMask       0x1
#define VisualScreenMask   0x4
#define VisualDepthMask    0x8
#define VisualClassMask    0x10

Window XCreateWindow(Display *d, Window parent, int x, int y, unsigned int w, unsigned int h,
                     unsigned int border, int depth, unsigned int class, Visual *visual,
                     unsigned long mask, XSetWindowAttributes *attrs);
XImage *XCreateImage(Display *d, Visual *v, unsigned int depth, int format, int offset,
                     char *data, unsigned int w, unsigned int h, int pad, int bytes_per_line);
int XPutImage(Display *d, Drawable dr, GC gc, XImage *img, int sx, int sy, int dx, int dy,
              unsigned int w, unsigned int h);
int XStoreColors(Display *d, Colormap c, XColor *colors, int n);
int XPending(Display *d);
int XNextEvent(Display *d, XEvent *ev);
KeySym XKeycodeToKeysym(Display *d, unsigned int keycode, int index);
int XLookupString(XKeyEvent *ev, char *buf, int n, KeySym *ks, void *status);

/*
 * ICCCM: the properties a client sets so that a WINDOW MANAGER knows what to do with it -- a name,
 * an icon name, a size hint, the WM_DELETE_WINDOW protocol. Quake's SUN driver sets all of them
 * where its X11 driver sets none, which is the difference between a program written for a
 * workstation desktop and one written for a Linux box in 1996.
 *
 * There is no window manager here; the PAGE is one, as it already is for Win32. So these carry the
 * window's NAME to the same place XStoreName does and are otherwise no-ops -- see src/env/x11.js.
 */
typedef struct {
    unsigned char *value;
    Atom encoding;
    int format;
    unsigned long nitems;
} XTextProperty;

typedef struct {
    long flags;
    int input;
    int initial_state;
    Pixmap icon_pixmap;
    Window icon_window;
    int icon_x, icon_y;
    Pixmap icon_mask;
    unsigned long window_group;   /* an XID; the header names no such type here */
} XWMHints;

typedef struct {
    char *res_name;
    char *res_class;
} XClassHint;

typedef struct {
    long flags;
    int x, y;
    int width, height;
    int min_width, min_height;
    int max_width, max_height;
    int width_inc, height_inc;
    struct { int x; int y; } min_aspect, max_aspect;
    int base_width, base_height;
    int win_gravity;
} XSizeHints;

typedef struct {
    int x, y;
    int width, height;
    int border_width;
    Window sibling;
    int stack_mode;
} XWindowChanges;

#define InputHint       (1L << 0)
#define StateHint       (1L << 1)
#define NormalState     1
#define PropModeReplace 0
#define CWX             (1<<0)
#define CWY             (1<<1)
#define CWWidth         (1<<2)
#define CWHeight        (1<<3)

Atom XInternAtom(Display *d, const char *name, Bool only_if_exists);
int XChangeProperty(Display *d, Window w, Atom prop, Atom type, int format, int mode,
                    const unsigned char *data, int nelements);
XWMHints *XAllocWMHints(void);
XSizeHints *XAllocSizeHints(void);
XClassHint *XAllocClassHint(void);
void XSetWMProperties(Display *d, Window w, XTextProperty *name, XTextProperty *icon,
                      char **argv, int argc, XSizeHints *normal, XWMHints *wm, XClassHint *cls);
Status XSetWMProtocols(Display *d, Window w, Atom *protocols, int count);
int XConfigureWindow(Display *d, Window w, unsigned int mask, XWindowChanges *changes);
int XUndefineCursor(Display *d, Window w);
int XFree(void *data);
#endif
`;

const XUTIL = `
#ifndef _PRISM_XUTIL_H
#define _PRISM_XUTIL_H
#include <X11/Xlib.h>
#endif
`;

/*
 * The PREDEFINED ATOMS. X interns most atom names at run time, but the first sixty-eight are fixed
 * by the protocol and a client may use them without asking -- XA_STRING is what an ICCCM text
 * property says its encoding is. This header was stubbed empty, which turned Quake's
 * VID_SetWindowTitle into a function that could not be emitted.
 */
const XATOM = `
#ifndef _PRISM_XATOM_H
#define _PRISM_XATOM_H
#include <X11/Xlib.h>
#define XA_PRIMARY        ((Atom) 1)
#define XA_SECONDARY      ((Atom) 2)
#define XA_ARC            ((Atom) 3)
#define XA_ATOM           ((Atom) 4)
#define XA_BITMAP         ((Atom) 5)
#define XA_CARDINAL       ((Atom) 6)
#define XA_COLORMAP       ((Atom) 7)
#define XA_CURSOR         ((Atom) 8)
#define XA_DRAWABLE       ((Atom) 17)
#define XA_FONT           ((Atom) 18)
#define XA_INTEGER        ((Atom) 19)
#define XA_PIXMAP         ((Atom) 20)
#define XA_POINT          ((Atom) 21)
#define XA_RECTANGLE      ((Atom) 22)
#define XA_STRING         ((Atom) 31)
#define XA_VISUALID       ((Atom) 32)
#define XA_WINDOW         ((Atom) 33)
#define XA_WM_COMMAND     ((Atom) 34)
#define XA_WM_HINTS       ((Atom) 35)
#define XA_WM_CLIENT_MACHINE ((Atom) 36)
#define XA_WM_ICON_NAME   ((Atom) 37)
#define XA_WM_ICON_SIZE   ((Atom) 38)
#define XA_WM_NAME        ((Atom) 39)
#define XA_WM_NORMAL_HINTS ((Atom) 40)
#define XA_WM_SIZE_HINTS  ((Atom) 41)
#define XA_WM_ZOOM_HINTS  ((Atom) 42)
#define XA_WM_CLASS       ((Atom) 67)
#define XA_WM_TRANSIENT_FOR ((Atom) 68)
#endif
`;

const XSHM = `
#ifndef _PRISM_XSHM_H
#define _PRISM_XSHM_H
#include <X11/Xlib.h>
/*
 * MIT-SHM is declared so a program compiles, and REFUSED at run time: XShmQueryExtension answers no,
 * which is a supported answer that sends the program down its ordinary XImage path. Pretending to
 * share memory with a server that does not exist would be worse in every way.
 */
#define ShmCompletion 0
#define ShmNumberEvents 1
typedef struct { unsigned long shmseg; int shmid; char *shmaddr; Bool readOnly; } XShmSegmentInfo;
Bool XShmQueryExtension(Display *d);
int XShmGetEventBase(Display *d);
XImage *XShmCreateImage(Display *d, Visual *v, unsigned int depth, int format, char *data,
                        XShmSegmentInfo *info, unsigned int w, unsigned int h);
Bool XShmAttach(Display *d, XShmSegmentInfo *info);
Bool XShmDetach(Display *d, XShmSegmentInfo *info);
Bool XShmPutImage(Display *d, Drawable dr, GC gc, XImage *img, int sx, int sy, int dx, int dy,
                  unsigned int w, unsigned int h, Bool send_event);
#endif
`;

const KEYSYMDEF = `
#ifndef _PRISM_KEYSYM_H
#define _PRISM_KEYSYM_H
#define XK_BackSpace 0xff08
#define XK_Tab 0xff09
#define XK_Return 0xff0d
#define XK_Pause 0xff13
#define XK_Escape 0xff1b
#define XK_Delete 0xffff
#define XK_Left 0xff51
#define XK_Up 0xff52
#define XK_Right 0xff53
#define XK_Down 0xff54
#define XK_F1 0xffbe
#define XK_F2 0xffbf
#define XK_F3 0xffc0
#define XK_F4 0xffc1
#define XK_F5 0xffc2
#define XK_F6 0xffc3
#define XK_F7 0xffc4
#define XK_F8 0xffc5
#define XK_F9 0xffc6
#define XK_F10 0xffc7
#define XK_F11 0xffc8
#define XK_F12 0xffc9
/*
 * F13 to F35, which look like an excess until you see a SUN KEYBOARD: it had no separate
 * navigation cluster, so its Home, Page Up and the rest arrive as these. Quake's Sun driver reads
 * "case XK_F27: key = K_HOME" and "XK_F29: K_PGUP" -- the keys are on the keypad, and the keysyms
 * are what the server sends for them. Values from X11's own keysymdef.h, which numbers them
 * consecutively from F1.
 */
#define XK_F13 0xffca
#define XK_F14 0xffcb
#define XK_F15 0xffcc
#define XK_F16 0xffcd
#define XK_F17 0xffce
#define XK_F18 0xffcf
#define XK_F19 0xffd0
#define XK_F20 0xffd1
#define XK_F21 0xffd2
#define XK_F22 0xffd3
#define XK_F23 0xffd4
#define XK_F24 0xffd5
#define XK_F25 0xffd6
#define XK_F26 0xffd7
#define XK_F27 0xffd8
#define XK_F28 0xffd9
#define XK_F29 0xffda
#define XK_F30 0xffdb
#define XK_F31 0xffdc
#define XK_F32 0xffdd
#define XK_F33 0xffde
#define XK_F34 0xffdf
#define XK_F35 0xffe0
#define XK_Shift_L 0xffe1
#define XK_Shift_R 0xffe2
#define XK_Control_L 0xffe3
#define XK_Control_R 0xffe4
#define XK_Alt_L 0xffe9
#define XK_Alt_R 0xffea
#define XK_Meta_L 0xffe7
#define XK_Meta_R 0xffe8
#define XK_space 0x0020
#define XK_minus 0x002d
#define XK_equal 0x003d
#define XK_asciitilde 0x007e
#define XK_KP_Subtract 0xffad
/*
 * The navigation and keypad block, from keysymdef.h. Doom read the keyboard through a dozen keysyms;
 * Quake II's rw_x11.c binds the whole cluster, keypad included, because it lets you bind them.
 */
#define XK_Home 0xff50
#define XK_Page_Up 0xff55
#define XK_Page_Down 0xff56
#define XK_End 0xff57
#define XK_Execute 0xff62
#define XK_Insert 0xff63
#define XK_KP_Enter 0xff8d
#define XK_KP_Home 0xff95
#define XK_KP_Left 0xff96
#define XK_KP_Up 0xff97
#define XK_KP_Right 0xff98
#define XK_KP_Down 0xff99
#define XK_KP_Page_Up 0xff9a
#define XK_KP_Page_Down 0xff9b
#define XK_KP_End 0xff9c
#define XK_KP_Begin 0xff9d
#define XK_KP_Insert 0xff9e
#define XK_KP_Delete 0xff9f
#define XK_KP_Multiply 0xffaa
#define XK_KP_Add 0xffab
#define XK_KP_Divide 0xffaf
#define XK_KP_Equal 0xffbd
#endif
`;

export const HEADERS = {
  ...WIN32_HEADERS,
  'X11/Xlib.h': XLIB,
  'X11/Xutil.h': XUTIL,
  'X11/Xatom.h': XATOM,
  'X11/keysym.h': KEYSYMDEF,
  'X11/extensions/XShm.h': XSHM,
  'values.h': `
#define MAXINT 2147483647
#define MININT (-2147483647-1)
#define MAXSHORT 32767
#define MINSHORT (-32768)
#define MAXLONG 2147483647
#define MINLONG (-2147483647-1)
#define MAXDOUBLE 1.7976931348623157e308
#define MINDOUBLE 2.2250738585072014e-308
`,
  'sys/ipc.h': `
#include <sys/types.h>
typedef int key_t;
struct ipc_perm { key_t __key; uid_t uid; gid_t gid; uid_t cuid; gid_t cgid; mode_t mode; };
#define IPC_PRIVATE 0
#define IPC_CREAT 01000
#define IPC_EXCL 02000
#define IPC_RMID 0
#define IPC_SET 1
#define IPC_STAT 2
`,
  'sys/shm.h': `
#include <sys/ipc.h>
/*
 * Declared so Doom's shared-memory path COMPILES; it is never taken, because XShmQueryExtension
 * answers no. shmget failing is the ordinary answer on a machine without SysV shared memory.
 */
struct shmid_ds { struct ipc_perm shm_perm; int shm_segsz; long shm_atime, shm_dtime, shm_ctime;
                  int shm_cpid, shm_lpid, shm_nattch; };
int shmget(key_t key, size_t size, int flag);
void *shmat(int id, const void *addr, int flag);
int shmdt(const void *addr);
int shmctl(int id, int cmd, struct shmid_ds *buf);
`,
  'sys/socket.h': `
#include <sys/types.h>
struct sockaddr { unsigned short sa_family; char sa_data[14]; };
int socket(int domain, int type, int protocol);
int bind(int fd, const struct sockaddr *addr, unsigned int len);
int sendto(int fd, const void *buf, size_t n, int flags, const struct sockaddr *to, unsigned int tolen);
int recvfrom(int fd, void *buf, size_t n, int flags, struct sockaddr *from, unsigned int *fromlen);
int setsockopt(int fd, int level, int name, const void *val, unsigned int len);
#define AF_INET 2
#define PF_INET 2
#define FIONBIO 0x5421
#define MSG_DONTWAIT 0x40
#define SOCK_DGRAM 2
#define SOL_SOCKET 1
#define IPPROTO_UDP 17
#define IPPROTO_IP 0
#define SO_BROADCAST 6
`,
  'netinet/in.h': `
struct in_addr { unsigned int s_addr; };
struct sockaddr_in { unsigned short sin_family; unsigned short sin_port; struct in_addr sin_addr; char sin_zero[8]; };
int gethostname(char *name, size_t len);
unsigned short htons(unsigned short v);
unsigned short ntohs(unsigned short v);
unsigned int htonl(unsigned int v);
unsigned int ntohl(unsigned int v);
#define INADDR_ANY 0
#define IPPORT_USERRESERVED 5000
`,
  'arpa/inet.h': `
#include <netinet/in.h>
unsigned int inet_addr(const char *s);
char *inet_ntoa(struct in_addr in);
`,
  'netdb.h': `
struct hostent { char *h_name; char **h_aliases; int h_addrtype; int h_length; char **h_addr_list; };
struct hostent *gethostbyname(const char *name);
`,
  /*
   * OSS, the sound interface a Linux program of this era writes to. The numbers were all 0 while it
   * was a stub, which meant every ioctl looked like every other one; they are distinct now because
   * src/env/dsp.js switches on them. Not the kernel's own _SIOWR-encoded values: PRISM supplies both
   * the header and the driver, so they are one thing in two places, and a made-up encoding that
   * matches is more honest than a real one that is not implemented.
   *
   * The set is what Doom's i_sound.c and Quake's snd_linux.c actually name, and nothing else.
   */
  'linux/soundcard.h': `
#ifndef _PRISM_SOUNDCARD_H
#define _PRISM_SOUNDCARD_H
#define SNDCTL_DSP_RESET       0x5000
#define SNDCTL_DSP_SYNC        0x5001
#define SNDCTL_DSP_SPEED       0x5002
#define SNDCTL_DSP_STEREO      0x5003
#define SNDCTL_DSP_GETBLKSIZE  0x5004
#define SNDCTL_DSP_SETFMT      0x5005
#define SNDCTL_DSP_CHANNELS    0x5006
#define SNDCTL_DSP_POST        0x5009
#define SNDCTL_DSP_SETFRAGMENT 0x500a
#define SNDCTL_DSP_GETFMTS     0x500b
#define SNDCTL_DSP_GETOSPACE   0x500c
#define SNDCTL_DSP_GETISPACE   0x500d
#define SNDCTL_DSP_NONBLOCK    0x500e
#define SNDCTL_DSP_GETCAPS     0x500f
#define SNDCTL_DSP_GETOPTR     0x5012
#define SNDCTL_DSP_SETTRIGGER  0x5010
#define PCM_ENABLE_OUTPUT      0x0002
#define DSP_CAP_TRIGGER        0x1000
#define DSP_CAP_MMAP           0x2000
#define AFMT_U8                0x0008
#define AFMT_S16_LE            0x0010
struct audio_buf_info { int fragments, fragstotal, fragsize, bytes; };
struct count_info { int bytes; int blocks; int ptr; };
#endif
`,
  'errnos.h': '#include <errno.h>\n',
  'alloca.h': 'void *alloca(unsigned long n);\n',
  'malloc.h': '#include <stdlib.h>\n',
  'sys/time.h': `
#include <sys/types.h>
struct timeval { long tv_sec; long tv_usec; };
struct timezone { int tz_minuteswest; int tz_dsttime; };
struct itimerval { struct timeval it_interval; struct timeval it_value; };
/*
 * select(), for a program that polls its own stdin. Doom's sound server does exactly that -- a
 * zero-timeout select on fd 0 -- and it is the one call that makes its loop cooperative rather than
 * blocking. fd_set is a bitmap of FD_SETSIZE bits, and the macros are the usual ones.
 */
#define FD_SETSIZE 1024
typedef struct { unsigned long fds_bits[FD_SETSIZE / 32]; } fd_set;
#define FD_ZERO(s)    do { int __i; for (__i = 0; __i < FD_SETSIZE / 32; __i++) (s)->fds_bits[__i] = 0; } while (0)
#define FD_SET(f, s)   ((s)->fds_bits[(f) / 32] |= (1UL << ((f) % 32)))
#define FD_CLR(f, s)   ((s)->fds_bits[(f) / 32] &= ~(1UL << ((f) % 32)))
#define FD_ISSET(f, s) (((s)->fds_bits[(f) / 32] & (1UL << ((f) % 32))) != 0)
int select(int n, fd_set *rd, fd_set *wr, fd_set *ex, struct timeval *timeout);
int gettimeofday(struct timeval *tv, struct timezone *tz);
int setitimer(int which, const struct itimerval *val, struct itimerval *old);
int getitimer(int which, struct itimerval *val);
#define ITIMER_REAL 0
#define ITIMER_VIRTUAL 1
#define ITIMER_PROF 2
`,
  'signal.h': `
/*
 * sig_atomic_t is C89 (7.7): the type a handler and the interrupted program may share. Lua reaches
 * for it through llimits.h, which defines l_signalT as sig_atomic_t. Its absence surfaced as a parse
 * error on the volatile l_signalT field in lstate.h -- the typedef having quietly vanished.
 */
typedef int sig_atomic_t;
typedef void (*__sighandler_t)(int);
__sighandler_t signal(int sig, __sighandler_t h);
int raise(int sig);
#define SIG_DFL ((__sighandler_t)0)
#define SIG_IGN ((__sighandler_t)1)
#define SIGHUP 1
#define SIGINT 2
#define SIGQUIT 3
#define SIGILL 4
#define SIGABRT 6
#define SIGBUS 7
#define SIGFPE 8
#define SIGKILL 9
#define SIGUSR1 10
#define SIGSEGV 11
#define SIGUSR2 12
#define SIGPIPE 13
#define SIGALRM 14
#define SIGTERM 15
#define SIGCHLD 17
// DJGPP's numeric-coprocessor signal, which Quake installs a handler for.
#define SIGNOFP 20

/*
 * sigaction, in glibc's i386 layout -- a program declares one on its stack and reads back what it
 * saved, so the SIZE and the field ORDER are the contract, not the semantics. Quake II's rw_x11.c
 * does exactly that: sigaction(SIGINT, 0, &sa) to fetch, then sets sa_handler and installs it, so
 * that Ctrl-C turns keyboard auto-repeat back on before the process dies.
 *
 * No signal is ever delivered here, so what is installed is remembered and never called. That is the
 * same honesty as the interrupt vector tables in watcom.js and go32.js -- except that those exist to
 * be CALLED later, and this one has no source of signals behind it at all.
 */
typedef unsigned long sigset_t[32];
struct sigaction {
    __sighandler_t sa_handler;
    sigset_t sa_mask;
    int sa_flags;
    void (*sa_restorer)(void);
};
/* The sa_flags a program sets. Linux i386 values, the ABI PRISM targets. */
#define SA_NOCLDSTOP 0x00000001
#define SA_NOCLDWAIT 0x00000002
#define SA_SIGINFO   0x00000004
#define SA_RESTART   0x10000000
#define SA_NODEFER   0x40000000
#define SA_RESETHAND 0x80000000
#define SA_ONSTACK   0x08000000
int sigaction(int sig, const struct sigaction *act, struct sigaction *old);
int sigemptyset(sigset_t *set);
int sigfillset(sigset_t *set);
int sigaddset(sigset_t *set, int sig);
`,
  'ctype.h': CTYPE,
  'sys/types.h': SYS_TYPES,
  'sys/stat.h': SYS_STAT,
  'sys/mman.h': SYS_MMAN,
  'sys/ioctl.h': SYS_IOCTL,
  'pc.h': PCH,
  // The DOS/DJGPP set, so MAME's own src/msdos/msdos.c compiles as its makefile intends.
  ...DJGPP_HEADERS,
  /*
   * Watcom's set, for Raven's Heretic and Hexen. `dos.h` comes LAST on purpose: DJGPP's is only
   * `pc.h` plus `delay`, and Watcom's is a superset of it -- union REGS, int386, the vector table.
   * One dos.h that satisfies both beats two that cannot coexist under one name.
   */
  ...WATCOM_HEADERS,
  // SDL2, for the Open* family. See src/env/headers-sdl2.js.
  ...SDL2_HEADERS,
  'dos.h': WATCOM_DOS_H,
  'i86.h': WATCOM_I86_H,
  'errno.h': ERRNO,
  'fcntl.h': FCNTL,
  'unistd.h': UNISTD,
  'dirent.h': DIRENT,
  'locale.h': LOCALE_H,
  'inttypes.h': INTTYPES,
  'wchar.h': WCHAR_H,
  'wctype.h': WCTYPE_H,
  'dlfcn.h': DLFCN,
  'mntent.h': MNTENT,
  'sys/dirent.h': DIRENT,
  'setjmp.h': SETJMP,
  'time.h': TIMEH,
  'stdarg.h': STDARG,
  'stdint.h': STDINT,
  'stdbool.h': STDBOOL,
  'float.h': FLOATH,
  'stddef.h': STDDEF,
  'stdio.h': STDIO,
  'stdlib.h': STDLIB,
  'string.h': STRING,
  'math.h': MATH,
  'limits.h': LIMITS,
  'assert.h': ASSERT,
};
