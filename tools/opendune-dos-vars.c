/*
 * opendune-dos-vars.c -- what the WATCOM INLINE ASSEMBLER provides in a real OpenDUNE DOS build.
 *
 * `src/video/video_dos.c:141` declares a function and then gives it a body in assembly:
 *
 *     int get_bios_keyboard_status(void);
 *     #pragma aux get_bios_keyboard_status = \
 *         "mov ah,11h"  "int 16h"  "mov eax,0"  "jz ok"  "mov ah,10h"  "int 16h"  "ok:" \
 *         value [eax];
 *
 * That is not a calling convention, it is the whole routine -- so PRISM, which ignores the pragma,
 * is left with a declaration and no definition, and Video_Tick calls it inside a `for (;;)`.
 * Roadmap P5.2 would compile the assembly; this is the same slot as tools/quake-dos-vars.c, and the
 * same slot as the Watcom FixedMul and FixedDiv2 already transcribed for Heretic.
 *
 * Transcribed from that assembly rather than from its name. What it computes is: ask the BIOS
 * whether an enhanced keystroke is waiting (AH=11h, answered in ZF), return 0 if none, and otherwise
 * read it (AH=10h) and return AX.
 *
 * The one thing that could not be transcribed literally is the ZF test: Watcom's `union REGS`
 * carries `cflag` and no other flag, so a C body cannot see ZF. Since this routine does the AH=10h
 * read ITSELF when the answer is yes, the split between peeking and reading is invisible to every
 * caller -- so src/env/watcom.js answers the whole question in EAX, zero when nothing is waiting.
 * The routine's contract is unchanged; only the line between it and the BIOS moved.
 */

#include <i86.h>

int get_bios_keyboard_status(void)
{
	union REGS r;

	r.x.eax = 0x1100;
	int386(0x16, &r, &r);
	return (int)r.x.eax;
}
