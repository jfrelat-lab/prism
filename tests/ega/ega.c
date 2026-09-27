/*
 * The EGA's write and read paths in mode 0Dh, every plane read back through Read Map Select.
 * Each section sets the graphics controller, writes, and prints what the four planes hold.
 */
#include <stdio.h>
#include <dos.h>

#define SC 0x3c4
#define GC 0x3ce

static unsigned char far *vid = (unsigned char far *)MK_FP(0xa000, 0);

static void sc(int i, int v) { outportb(SC, i); outportb(SC + 1, v); }
static void gc(int i, int v) { outportb(GC, i); outportb(GC + 1, v); }

static void reset(void)
{
    sc(2, 15); gc(0, 0); gc(1, 0); gc(2, 0); gc(3, 0); gc(4, 0); gc(5, 0); gc(7, 15); gc(8, 0xff);
}

static void show(const char *what, unsigned off)
{
    int p;
    printf("%-12s", what);
    for (p = 0; p < 4; p++) { gc(4, p); printf(" %02x", vid[off]); }
    gc(4, 0);
    printf("\n");
}

int main(void)
{
    unsigned char t;
    _AX = 0x000d;
    geninterrupt(0x10);
    reset();

    /* Write mode 0, Map Mask: planes 0 and 2 only. */
    sc(2, 0x05); vid[0] = 0xa5; sc(2, 15);
    show("mapmask", 0);

    /* Set/Reset: plane 1 and 3 from the colour, the rest from the CPU byte. */
    gc(0, 0x0a); gc(1, 0x0f); vid[1] = 0x3c; gc(1, 0x05); vid[2] = 0x3c; gc(0, 0); gc(1, 0);
    show("setreset", 1);
    show("enable-sr", 2);

    /* Bit Mask: the latch keeps what the mask clears. */
    vid[3] = 0xff;
    t = vid[3];                         /* load the latches */
    gc(8, 0x0f); vid[3] = 0x00; gc(8, 0xff);
    show("bitmask", 3);

    /* Data rotate and the logical functions, against a latched pattern. */
    vid[4] = 0xf0; t = vid[4];
    gc(3, 0x08 | 1); vid[4] = 0x33;     /* AND, rotate 1 */
    show("and-rot1", 4);
    vid[5] = 0x0f; t = vid[5];
    gc(3, 0x10); vid[5] = 0x55;         /* OR */
    show("or", 5);
    vid[6] = 0xff; t = vid[6];
    gc(3, 0x18 | 4); vid[6] = 0x0f;     /* XOR, rotate 4 */
    show("xor-rot4", 6);
    gc(3, 0);

    /* Write mode 1: the latches of one byte copied to another, on every plane. */
    sc(2, 0x01); vid[7] = 0x11; sc(2, 0x02); vid[7] = 0x22; sc(2, 0x04); vid[7] = 0x44; sc(2, 0x08); vid[7] = 0x88; sc(2, 15);
    gc(5, 1); t = vid[7]; vid[8] = 0; gc(5, 0);
    show("latchcopy", 8);

    /* Write mode 2: the CPU byte is a colour, masked to two pixels. */
    gc(5, 2); gc(8, 0xc0); t = vid[9]; vid[9] = 0x0b; gc(8, 0xff); gc(5, 0);
    show("mode2", 9);

    /* Read mode 1: which pixels of byte 8 are colour 0Fh (every plane set). */
    gc(5, 8); gc(2, 0x0f); gc(7, 0x0f);
    printf("compare     %02x\n", vid[7]);
    gc(7, 0x03); gc(2, 0x01);
    printf("compare-cdc %02x\n", vid[7]);
    gc(5, 0);
    (void)t;

    _AX = 0x0003;
    geninterrupt(0x10);
    return 0;
}
