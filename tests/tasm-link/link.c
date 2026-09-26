/*
 * C calling Keen Dreams' own assembly: id_us_a.asm and id_vw_a.asm, linked as its build links them.
 * An int result (US_RndT), a far pointer argument (VW_DrawPropString, given a near string the
 * compiler widens), and the modules' data publics read and written from C (px, py, fontcolor,
 * bufferwidth, bufferheight). The externals id_vw_a.asm needs are defined here, as ID_VW.C would.
 */
#include <stdio.h>
#include <alloc.h>
#include <dos.h>

#define STARTFONT 3

unsigned screenseg = 0xa000, drawofs, bufferofs, displayofs, panadjust, linewidth = 64, fontspace;
unsigned ylookup[200];
unsigned grsegs[3016];
unsigned char *updateptr;
unsigned blockstarts[308];

extern int px, py;
extern unsigned char pdrawmode, fontcolor;
extern unsigned bufferwidth, bufferheight;

void US_InitRndT(int randomize);
int US_RndT(void);
void VW_DrawPropString(char far *string);
void VW_MemToScreen(unsigned source, unsigned dest, unsigned width, unsigned height);
void VW_ScreenToMem(unsigned source, unsigned dest, unsigned width, unsigned height);

/* A segment-aligned far block of n bytes, as id_mm.c takes one from farmalloc. */
static unsigned segblock(unsigned long n)
{
    void far *b = farmalloc(n + 16);
    return FP_SEG(b) + (FP_OFF(b) + 15) / 16;
}

int main(void)
{
    int k;
    unsigned seg;
    char far *font;
    char far *text;
    unsigned char far *scr;
    unsigned char far *src;
    unsigned char far *dst;
    unsigned sum;

    US_InitRndT(0);
    for (k = 0; k < 12; k++) printf("%d ", US_RndT());
    printf("\n");

    /* A font, as CA_CacheGrChunk leaves one: height, 256 offsets, 256 widths, then the rows. */
    seg = segblock(0x4400L);
    font = (char far *)MK_FP(seg, 0);
    *(unsigned far *)font = 6;
    for (k = 0; k < 256; k++) {
        *(unsigned far *)(font + 2 + 2 * k) = 0x400 + k * 64;
        font[514 + k] = (char)(1 + (k * 7) % 20);
    }
    for (k = 0; k < 0x4000; k++) font[0x400 + k] = (char)(k * 13);
    grsegs[STARTFONT] = seg;
    for (k = 0; k < 200; k++) ylookup[k] = k * 64;

    px = 13;
    py = 20;
    printf("before px %d py %d drawmode %u color %u\n", px, py, pdrawmode, fontcolor);
    VW_DrawPropString("Hello, Keen");
    printf("after px %d width %u height %u\n", px, bufferwidth, bufferheight);
    fontcolor = 3;
    px = 200;
    VW_DrawPropString("!");
    printf("after px %d width %u height %u color %u\n", px, bufferwidth, bufferheight, fontcolor);

    /* A far string above the first 64K, where a far pointer is not its linear address. */
    text = (char far *)MK_FP(segblock(16), 0);
    text[0] = 'f'; text[1] = 'a'; text[2] = 'r'; text[3] = 0;
    px = 0;
    VW_DrawPropString(text);
    printf("far px %d width %u seg-above-64K %d\n", px, bufferwidth, FP_SEG(text) >= 0x1000);

    /* Four arguments each way, on a "screen" in ordinary memory: screenseg is the C's to set. */
    screenseg = segblock(0x2000L);
    scr = (unsigned char far *)MK_FP(screenseg, 0);
    src = (unsigned char far *)MK_FP(segblock(256), 0);
    dst = (unsigned char far *)MK_FP(segblock(256), 0);
    for (k = 0; k < 0x2000; k++) scr[k] = 0;
    /* MemToScreen walks on through the source plane after plane: 4 x 6 x 3 bytes, all set. */
    for (k = 0; k < 256; k++) src[k] = (unsigned char)(k * 5 + 1);
    VW_MemToScreen(FP_SEG(src), 100, 6, 3);
    for (sum = 0, k = 0; k < 400; k++) sum = sum * 31 + scr[k];
    printf("memtoscreen %u %u %u %u\n", scr[100], scr[105], scr[164], sum);
    VW_ScreenToMem(98, FP_SEG(dst), 5, 4);
    for (sum = 0, k = 0; k < 80; k++) sum = sum * 31 + dst[k];
    printf("screentomem %u %u %u\n", dst[2], dst[7], sum);
    return 0;
}
