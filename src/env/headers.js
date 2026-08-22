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
#endif
`;

const STDLIB = `
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
#define va_end(ap) ((void)0)
#define va_copy(dst, src) ((dst) = (src))
#define va_arg(ap, type) (*(type *)__prism_va_next(&(ap), sizeof(type)))
#endif
`;

export const HEADERS = {
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
