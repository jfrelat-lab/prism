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
#define INFINITY (1.0e308 * 10.0)
#define NAN (INFINITY - INFINITY)
#define HUGE_VAL INFINITY

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
#define PATH_MAX 4096
#define NAME_MAX 255

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
struct tm {
    int tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year, tm_wday, tm_yday, tm_isdst;
};
struct timespec { long tv_sec; long tv_nsec; };
struct timeval  { long tv_sec; long tv_usec; };
struct tm *localtime(const long *t);
struct tm *gmtime(const long *t);
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
int access(const char *path, int mode);
char *getcwd(char *buf, size_t size);
int ftruncate(int fd, off_t len);
int fchmod(int fd, mode_t mode);
int fchown(int fd, uid_t owner, gid_t group);
int rmdir(const char *path);
int geteuid(void);
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

export const HEADERS = {
  'ctype.h': CTYPE,
  'sys/types.h': SYS_TYPES,
  'sys/stat.h': SYS_STAT,
  'sys/mman.h': SYS_MMAN,
  'sys/ioctl.h': SYS_IOCTL,
  'pc.h': PCH,
  'errno.h': ERRNO,
  'fcntl.h': FCNTL,
  'unistd.h': UNISTD,
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
