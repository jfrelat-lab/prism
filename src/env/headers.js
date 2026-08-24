// headers.js — the header set PRISM ships for the hosted-C environment.
//
// gcc compiles the SAME source against its own headers; these exist only so that an unmodified
// `#include <stdio.h>` resolves on PRISM's side. They therefore declare exactly what
// src/runtime/runtime.js implements and nothing more — a declaration with no implementation would
// turn a clean "undeclared function" error into a mysterious runtime failure.
//
// Types are the i386 ones (`size_t` is `unsigned int`, not `unsigned long`), because a mismatch here
// would show up as a wrong argument width in a printf and be blamed on the emitter.

const STDDEF = `
#ifndef _PRISM_STDDEF_H
#define _PRISM_STDDEF_H
typedef unsigned int size_t;
typedef int ptrdiff_t;
#ifndef NULL
#define NULL ((void *)0)
#endif
#define offsetof(t, m) __builtin_offsetof(t, m)
#endif
`;

const STDIO = `
#ifndef _PRISM_STDIO_H
#define _PRISM_STDIO_H
#include <stddef.h>
typedef struct _PRISM_FILE FILE;
extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;
#define EOF (-1)
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
int atoi(const char *s);
long atol(const char *s);
int abs(int v);
long labs(long v);
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#endif
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
void *memcpy(void *d, const void *s, size_t n);
void *memmove(void *d, const void *s, size_t n);
void *memset(void *d, int v, size_t n);
int memcmp(const void *a, const void *b, size_t n);
#endif
`;

const MATH = `
#ifndef _PRISM_MATH_H
#define _PRISM_MATH_H
double sqrt(double x);
double sin(double x);
double cos(double x);
double tan(double x);
double atan(double x);
double atan2(double y, double x);
double exp(double x);
double log(double x);
double log10(double x);
double pow(double x, double y);
double floor(double x);
double ceil(double x);
double fabs(double x);
double fmod(double x, double y);
#endif
`;

// The i386 values, which is the whole reason this file cannot borrow the host's limits.h.
const LIMITS = `
#ifndef _PRISM_LIMITS_H
#define _PRISM_LIMITS_H
#define CHAR_BIT 8
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
void abort(void);
int printf(const char *fmt, ...);
#define assert(e) ((e) ? (void)0 : (printf("assertion failed\\n"), abort()))
#endif
#endif
`;

const STDINT = `
#ifndef _PRISM_STDINT_H
#define _PRISM_STDINT_H
typedef signed char int8_t;
typedef unsigned char uint8_t;
typedef short int16_t;
typedef unsigned short uint16_t;
typedef int int32_t;
typedef unsigned int uint32_t;
typedef int intptr_t;
typedef unsigned int uintptr_t;
#define INT8_MIN (-128)
#define INT8_MAX 127
#define UINT8_MAX 255
#define INT16_MIN (-32768)
#define INT16_MAX 32767
#define UINT16_MAX 65535
#define INT32_MIN (-2147483647 - 1)
#define INT32_MAX 2147483647
#define UINT32_MAX 4294967295U
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
 * jmp_buf is an ARRAY, as every real setjmp.h makes it, so that \`jmp_buf b;\` declares storage and
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
#define ENOENT 2
#define EACCES 13
#define EEXIST 17
#define EINVAL 22
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
int open(const char *name, int flags, ...);
#endif
`;

const UNISTD = `
#ifndef _PRISM_UNISTD_H
#define _PRISM_UNISTD_H
#include <stddef.h>
int close(int fd);
int read(int fd, void *dst, size_t n);
int write(int fd, const void *src, size_t n);
int unlink(const char *name);
#endif
`;

export const HEADERS = {
  'errno.h': ERRNO,
  'fcntl.h': FCNTL,
  'unistd.h': UNISTD,
  'sys/types.h': '',
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
