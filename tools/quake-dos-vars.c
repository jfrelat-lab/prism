/*
 * quake-dos-vars.c -- what the LINKER and the ASSEMBLER provide in a real DJGPP build of Quake.
 *
 * PRISM compiles Quake's DOS platform units but not its .s files, so the C half of the program still
 * needs these to exist. Real C, in a real .c file, for the same reason Allegro's key[] is one: the
 * program takes their address and calls them.
 *
 * Roadmap P5.2 would compile the assembly instead. This file is the argument for why that is not
 * urgent: eleven of the twelve routines are no-ops on a host with no x87 control word, and the
 * twelfth is a memcpy with a stride.
 */

/*
 * extern char start_of_memory __asm__("start");        -- sys_dos.c:67
 *
 * The base of the image, used only to compute a range to lock in physical memory. Nothing here
 * pages, so nothing reads it for anything but its address.
 */
char start_of_memory;

/*
 * The x87 control-word routines from sys_dosa.s. There is no control word here: JavaScript
 * arithmetic is IEEE double throughout, with no trapping mode to enable and no 80-bit precision to
 * step down from.
 *
 * No-ops, and that is the faithful answer rather than a convenient one. What the assembly buys on
 * real hardware is that a division by zero does not raise SIGFPE, and that intermediates round to 64
 * bits instead of 80. Both are already true. Sys_LowFPPrecision is the only one that would change a
 * result if it did anything -- and it would change it AWAY from what PRISM computes.
 */
void MaskExceptions(void) { }
void unmaskexceptions(void) { }
void Sys_LowFPPrecision(void) { }
void Sys_HighFPPrecision(void) { }
void Sys_PushFPCW_SetHigh(void) { }
void Sys_PopFPCW(void) { }
void Sys_SetFPCW(void) { }
void setstackcheck(void) { }
void dostackcheck(void) { }
void StartMSRInterval(void) { }
void EndMSRInterval(void) { }

/*
 * The linear blit, TRANSCRIBED from d_copy.s rather than guessed at from its name:
 *
 *     movl width,%ebx ; movl srcrowbytes,%eax ; subl %ebx,%eax     // src stride - width
 *     movl destrowbytes,%edx ; subl %ebx,%edx                      // dest stride - width
 *     shrl $2,%ebx                                                 // width in DWORDS
 *   LLRowLoop:  rep/movsl ; addl %eax,%esi ; addl %edx,%edi ; decl %ebp ; jnz LLRowLoop
 *
 * One row at a time, width/4 dwords each, advancing each pointer by its own stride. The dword step
 * is why VGA_InitMode rounds the width up to a multiple of 32.
 */
void VGA_UpdateLinearScreen(void *srcptr, void *destptr, int width, int height,
                            int srcrowbytes, int destrowbytes)
{
	unsigned char *src = (unsigned char *)srcptr;
	unsigned char *dest = (unsigned char *)destptr;
	int row, i, dwords = width >> 2;

	for (row = 0; row < height; row++)
	{
		unsigned long *s = (unsigned long *)src;
		unsigned long *d = (unsigned long *)dest;
		for (i = 0; i < dwords; i++)
			d[i] = s[i];
		src += srcrowbytes;
		dest += destrowbytes;
	}
}
