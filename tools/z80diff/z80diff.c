/*
 * z80diff.c — a differential harness for MAME 0.1's Z80 core.
 *
 * The same source is compiled twice, once by a real i386 gcc and once by PRISM, driven from the same
 * ROM image with the same T-state budget, and the register file is printed after every step. The
 * first line that differs is the instruction PRISM gets wrong. This is the same shape as MIRAGE's
 * Unicorn co-simulator: rather than reading 2500 lines of CPU emulation, ask an oracle where the two
 * stop agreeing.
 *
 * No ROM data lives in this file. It reads `z80rom.bin` from the working directory, so the game data
 * stays wherever its owner put it.
 *
 * Z80_IPeriod is 1, so each Z80_Execute() call retires about one instruction.
 */

#include <stdio.h>
#include "Z80.h"

#define STEPS 20000

/*
 * Z80.c fetches opcodes straight out of MAME's `RAM` array (M_RDMEM_OPCODE), not through the
 * Z80_RDMEM callback, so the harness has to BE that array rather than keep its own.
 */
unsigned char RAM[0x20000];
int Z80_IRQ = Z80_IGNORE_INT;

static int IntVector = 0xff;
static int int_countdown = 0;
static int reti_count = 0, retn_count = 0;

/* Flat memory and dead ports: the point here is the CPU, not a machine. */
unsigned Z80_RDMEM(dword A) { return RAM[A & 0xffff]; }
void Z80_WRMEM(dword A, byte V) { RAM[A & 0xffff] = V; }
byte Z80_In(byte Port) { return 0; }
void Z80_Out(byte Port, byte Value) { if (Port == 0) IntVector = Value; }
/*
 * The INTERRUPT path, which the first version of this harness never exercised — it always returned
 * IGNORE, so the 20000 steps it declared identical said nothing about EI/DI, IM 2, vector fetch or
 * RETI. Pac-Man is interrupt-driven and stops without them, so this is where the remaining defect
 * has to be looked for.
 *
 * Modelled on MAME's pacman machine: an OUT to port 0 sets the vector, and an interrupt is offered
 * periodically. Deterministic, so both sides see the same schedule.
 */
int Z80_Interrupt(void)
{
  if (++int_countdown % 64) return Z80_IGNORE_INT;
  return IntVector;
}
void Z80_Reti(void) { reti_count++; }
void Z80_Retn(void) { retn_count++; }
void Z80_Patch(Z80_Regs *Regs) { }

int main(void)
{
  Z80_Regs R;
  FILE *f;
  int i, n;

  f = fopen("z80rom.bin", "rb");
  if (!f) { printf("NOROM\n"); return 1; }
  n = fread(RAM, 1, 0x4000, f);
  fclose(f);
  printf("rom %d bytes, first %02x %02x %02x %02x\n",
         n, RAM[0], RAM[1], RAM[2], RAM[3]);

  Z80_Reset();
  /*
   * Z80_Reset does `R.R = rand()` — the core randomises the refresh register on purpose. glibc's
   * rand() and PRISM's are different generators, so that one field would diverge for a reason that
   * has nothing to do with compilation. Pin it, so the experiment compares the CPU and not the
   * library.
   */
  Z80_GetRegs(&R);
  R.R = 0;
  Z80_SetRegs(&R);

  Z80_IPeriod = 1;

  for (i = 0; i < STEPS; i++)
  {
    Z80_ICount = 1;
    Z80_Execute();
    Z80_GetRegs(&R);
    printf("%d PC=%04x AF=%04x BC=%04x DE=%04x HL=%04x IX=%04x IY=%04x SP=%04x I=%02x IFF1=%u IM=%u H=%u\n",
           i,
           (unsigned)(R.PC.D & 0xffff), (unsigned)(R.AF.D & 0xffff),
           (unsigned)(R.BC.D & 0xffff), (unsigned)(R.DE.D & 0xffff),
           (unsigned)(R.HL.D & 0xffff), (unsigned)(R.IX.D & 0xffff),
           (unsigned)(R.IY.D & 0xffff), (unsigned)(R.SP.D & 0xffff),
           (unsigned)(R.I & 0xff), R.IFF1, R.IM, R.HALT);
    if (i % 4096 == 0)
      printf("  marks: iv=%02x reti=%d retn=%d iff2=%u r=%02x\n",
             IntVector, reti_count, retn_count, R.IFF2, (unsigned)(R.R & 0xff));
  }
  return 0;
}
