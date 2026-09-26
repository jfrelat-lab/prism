/* DOS through int 21h, on a file the C library wrote: open, lseek, read, IOCTL, close, and a miss. */
#include <stdio.h>
#include <dos.h>
#include <alloc.h>

static unsigned char buf[16];

int main(void)
{
    FILE *f;
    int k;
    unsigned h, cf, got, info, pos_lo, pos_hi, fs, fo;
    unsigned char far *fb;

    f = fopen("T.DAT", "wb");
    for (k = 0; k < 100; k++) fputc(k * 3, f);
    fclose(f);

    _DX = (unsigned)"T.DAT";
    _AX = 0x3d00;
    geninterrupt(0x21);
    h = _AX;
    cf = _FLAGS & 1;
    printf("open cf %u handle>4 %d\n", cf, h > 4);

    _BX = h; _CX = 0; _DX = 50; _AX = 0x4200;
    geninterrupt(0x21);
    pos_lo = _AX; pos_hi = _DX;
    printf("lseek %u %u\n", pos_hi, pos_lo);

    _BX = h; _CX = 10; _DX = (unsigned)buf; _AX = 0x3f00;
    geninterrupt(0x21);
    got = _AX;
    printf("read %u:", got);
    for (k = 0; k < 10; k++) printf(" %u", buf[k]);
    printf("\n");

    /* A read into FAR memory, DS:DX set by assembly as CA_FarRead sets it. */
    fb = (unsigned char far *)farmalloc(64);
    fs = FP_SEG(fb);
    fo = FP_OFF(fb);
    _BX = h; _CX = 0; _DX = 20; _AX = 0x4200;
    geninterrupt(0x21);
asm push ds
asm mov bx,h
asm mov cx,8
asm mov dx,fo
asm mov ax,fs
asm mov ds,ax
asm mov ah,0x3f
asm int 0x21
asm pop ds
    printf("far read:");
    for (k = 0; k < 8; k++) printf(" %u", fb[k]);
    printf("\n");

    _BX = h; _AX = 0x4400;
    geninterrupt(0x21);
    info = _DX;
    printf("ioctl file device-bit %u\n", (info >> 7) & 1);
    /* stdin: the console on both sides (stdout is a file when the oracle redirects it). */
    _BX = 0; _AX = 0x4400;
    geninterrupt(0x21);
    info = _DX;
    printf("ioctl stdin device-bit %u\n", (info >> 7) & 1);

    _BX = h; _AX = 0x3e00;
    geninterrupt(0x21);
    printf("close cf %u\n", _FLAGS & 1);

    _DX = (unsigned)"NOPE.XYZ";
    _AX = 0x3d00;
    geninterrupt(0x21);
    got = _AX;                  /* before _FLAGS: Borland reads that through PUSHF / POP AX */
    cf = _FLAGS & 1;
    printf("missing cf %u error %u\n", cf, got);
    return 0;
}
