/* A far pointer's two halves in inline assembly, the way Keen Dreams' MemDrawChar uses them: the
 * segment loaded once, the offset stepped by a plane's size and read back each time round. Under
 * Borland a far pointer is a segment:offset pair, so the offset read back is the one written. */
#include <stdio.h>
#include <dos.h>
#include <alloc.h>

void planes(unsigned char far *dest, unsigned step)
{
asm	mov	es,[WORD PTR dest+2]
asm	mov	cx,4
asm	mov	al,1
again:
asm	mov	di,[WORD PTR dest]
asm	mov	[es:di],al
asm	inc	al
asm	mov	bx,[step]
asm	add	[WORD PTR dest],bx
asm	loop	again
}

unsigned stepped(unsigned char far *p)
{
	unsigned o;
	unsigned before = FP_OFF(p);
asm	add	[WORD PTR p],0x100
asm	mov	ax,[WORD PTR p]
asm	mov	[o],ax
	return o - before;
}

int main(void)
{
	unsigned char far *buf = (unsigned char far *)farmalloc(64);
	unsigned k;
	for (k = 0; k < 64; k++) buf[k] = 0;
	planes(buf + 3, 10);
	printf("planes %u %u %u %u %u\n", buf[3], buf[13], buf[23], buf[33], buf[4]);
	printf("stepped %u\n", stepped(buf + 5));
	farfree(buf);
	return 0;
}
