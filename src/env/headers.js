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
int strcasecmp(const char *a, const char *b);
int strncasecmp(const char *a, const char *b, size_t n);
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

typedef union _XEvent {
    int type;
    XKeyEvent xkey;
    XButtonEvent xbutton;
    XMotionEvent xmotion;
    XExposeEvent xexpose;
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
#define AllocNone 0
#define AllocAll 1
#define DefaultScreen(d) XDefaultScreen(d)
#define RootWindow(d,s) XRootWindow(d,s)
#define DisplayWidth(d,s) 640
#define DisplayHeight(d,s) 480

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
#endif
`;

const XUTIL = `
#ifndef _PRISM_XUTIL_H
#define _PRISM_XUTIL_H
#include <X11/Xlib.h>
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
#define XK_KP_Equal 0xffbd
#endif
`;

export const HEADERS = {
  'X11/Xlib.h': XLIB,
  'X11/Xutil.h': XUTIL,
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
  'linux/soundcard.h': '#define SNDCTL_DSP_SETFMT 0\n#define SNDCTL_DSP_SPEED 0\n#define SNDCTL_DSP_STEREO 0\n#define AFMT_S16_LE 16\n',
  'errnos.h': '#include <errno.h>\n',
  'alloca.h': 'void *alloca(unsigned long n);\n',
  'malloc.h': '#include <stdlib.h>\n',
  'sys/time.h': `
#include <sys/types.h>
struct timeval { long tv_sec; long tv_usec; };
struct timezone { int tz_minuteswest; int tz_dsttime; };
struct itimerval { struct timeval it_interval; struct timeval it_value; };
int gettimeofday(struct timeval *tv, struct timezone *tz);
int setitimer(int which, const struct itimerval *val, struct itimerval *old);
int getitimer(int which, struct itimerval *val);
#define ITIMER_REAL 0
#define ITIMER_VIRTUAL 1
#define ITIMER_PROF 2
`,
  'signal.h': `
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
`,
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
