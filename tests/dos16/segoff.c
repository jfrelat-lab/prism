/* A far pointer is segment:offset, and Borland's arithmetic on it is the offset's: the semantics
 * Wolfenstein 3-D's compiled scalers rest on. Only offsets and differences are printed -- the
 * segments a program is loaded at are the machine's, not the language's. */
#include <stdio.h>
#include <dos.h>
#include <alloc.h>

typedef struct { unsigned codeofs[4]; unsigned width[4]; unsigned char code[16]; } scaler;

#pragma warn -rvl
long mul(long a, unsigned b)
{
asm	mov	ax,[WORD PTR a]
asm	mov	cx,[WORD PTR a+2]
asm	mov	bx,[b]
asm	mul	bx
asm	mov	di,dx
asm	mov	ax,cx
asm	mul	bx
asm	add	ax,di
asm	adc	dx,0
done:;
}
#pragma warn +rvl

int main(void)
{
	unsigned char far *block = (unsigned char far *)farmalloc(256);
	unsigned seg = FP_SEG(block) + (FP_OFF(block) + 15) / 16;
	scaler _seg *s = (scaler _seg *)seg;
	unsigned char far *code = &s->code[0];
	unsigned char far *p, far *q;
	unsigned char huge *h, huge *g;
	unsigned i;

	/* a pointer formed from a _seg base keeps that segment, and its offset is the field's */
	printf("code %u %d\n", FP_OFF(code), FP_SEG(code) == seg);
	for (i = 0; i < 5; i++) *code++ = (unsigned char)(0x10 + i);
	s->codeofs[0] = FP_OFF(code);
	printf("after %u %u %u\n", FP_OFF(code), s->codeofs[0], s->code[4]);
	printf("fpoff %u %u\n", FP_OFF(&s->width[2]), FP_OFF((unsigned char far *)s + 3));

	/* far arithmetic wraps the offset at 64K; huge carries into the segment, normalised */
	p = (unsigned char far *)MK_FP(seg, 0xfffe);
	p += 4;
	printf("far wrap %u %d\n", FP_OFF(p), FP_SEG(p) == seg);
	h = (unsigned char huge *)MK_FP(seg + 0x123, 0xfffe);
	h += 4;
	printf("huge %u %u\n", FP_OFF(h), FP_SEG(h) - seg);
	g = (unsigned char huge *)MK_FP(seg + 1, 3);
	printf("huge diff %ld\n", (long)(g - (unsigned char huge *)MK_FP(seg, 0)));

	/* far pointers are ordered by their offsets, equal when both words are */
	p = (unsigned char far *)MK_FP(seg, 5);
	q = (unsigned char far *)MK_FP(seg + 1, 3);
	printf("cmp %d %d %d %d\n", p < q, p > q, p == q, p == (unsigned char far *)MK_FP(seg, 5));
	printf("diff %d\n", (int)((unsigned char far *)MK_FP(seg, 10) - (unsigned char far *)MK_FP(seg, 4)));

	/* the low word of a far pointer, set and read as an unsigned */
	p = (unsigned char far *)MK_FP(seg, 0x40);
	(unsigned)p = 0x44;
	printf("cast %u %d\n", FP_OFF(p), FP_SEG(p) == seg);

	/* a function falling off its end after asm, through a label on an empty statement */
	printf("mul %lx %lx\n", mul(0x123456L, 0x8000), mul(0x10000L, 0xabcd));
	farfree(block);
	return 0;
}
