/*
 * Hardware interrupts as a real-mode program meets them, each property printed as a number the
 * hardware's rules fix (src/env/pcirq.js). Built for dos16m with env stdio+borland+dos+pcirq and
 * safepoints on; the harness queues scancodes 0x1E, 0x9E, 0x30 at 2000, 2010, 2020 ms and 0x10 at 5000.
 */
#include <stdio.h>
#include <dos.h>

static volatile unsigned ticks, noeoi, keys, keylog[4], timerval, done, order[4], norder;

static void interrupt counting(void) { ticks++; outportb(0x20, 0x20); }
static void interrupt ordered0(void) { if (norder < 4) order[norder++] = 0; outportb(0x20, 0x20); }
static void interrupt ordered1(void)
{
    inportb(0x60);
    if (norder < 4) order[norder++] = 1;
    outportb(0x20, 0x20);
}
static void interrupt forgetful(void) { noeoi++; }                 /* never acknowledges */
static void interrupt measuring(void) { timerval = _CX; done = 1; outportb(0x20, 0x20); }
static void interrupt keyboard(void)
{
    unsigned char k = inportb(0x60);
    if (keys < 4) keylog[keys] = k;
    keys++;
    outportb(0x61, inportb(0x61) | 0x80);
    outportb(0x61, inportb(0x61) & 0x7f);
    outportb(0x20, 0x20);
}

static void rate(unsigned hz)
{
    unsigned long div = 1193182L / hz;
    outportb(0x43, 0x36);
    outportb(0x40, (unsigned char)div);
    outportb(0x40, (unsigned char)(div >> 8));
}

static void spin(unsigned long n) { unsigned long k; for (k = 0; k < n; k++) ; }

int main(void)
{
    void interrupt (*old8)(void) = getvect(8);
    unsigned long bda0, bda1;
    unsigned seen, edges, last, k, cx;

    /* The BIOS's own int 8 counts the day's ticks at 0040:006C. */
    bda0 = *(unsigned long far *)MK_FP(0x40, 0x6c);
    spin(200000L);
    bda1 = *(unsigned long far *)MK_FP(0x40, 0x6c);
    printf("bios tick advanced %d\n", bda1 > bda0);

    /* 1000 Hz on a counting handler: delivered while IF is set, held while it is clear. */
    setvect(8, counting);
    rate(1000);
    spin(20000L);
    printf("counting %d\n", ticks > 5);
    disable();
    seen = ticks;
    spin(20000L);
    printf("held while disabled %d\n", ticks == seen);
    enable();
    spin(10L);
    printf("pending one delivered on enable %d\n", ticks > seen);

    /* A handler that never sends EOI is entered once: the PIC holds everything below it. */
    setvect(8, forgetful);
    spin(50000L);
    printf("without EOI %u\n", noeoi);
    outportb(0x20, 0x20);

    /* An interrupt function starts with the interrupted registers: CX is the loop's. */
    setvect(8, measuring);
    done = 0;
    asm mov cx, 0xffff
wait:
    asm test word ptr done, 1
    asm jnz out
    asm loop wait
out:
    cx = _CX;
    printf("interrupted cx matches %d\n", timerval - cx <= 1 && timerval != 0);

    /* The keyboard: scancodes arrive in order through int 9. */
    setvect(9, keyboard);
    setvect(8, counting);
    while (keys < 3) spin(100L);
    printf("keys %u %x %x %x\n", keys, keylog[0], keylog[1], keylog[2]);

    /* Vertical retrace, counted against 1000 Hz ticks: 70 Hz is 70 in a second. */
    seen = ticks;
    edges = 0;
    last = inportb(0x3da) & 8;
    while (ticks - seen < 1000) {
        k = inportb(0x3da) & 8;
        if (k && !last) edges++;
        last = k;
    }
    printf("retraces in a second %u\n", edges);

    /* Two requests pending under CLI -- a tick and a key (queued at 5000 ms) -- go by priority. */
    setvect(8, ordered0);
    setvect(9, ordered1);
    disable();
    spin(3000000L);
    enable();
    spin(10L);
    printf("priority %u %u\n", order[0], order[1]);

    setvect(8, old8);
    rate(18);
    return 0;
}
