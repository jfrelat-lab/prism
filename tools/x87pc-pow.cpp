// tools/gate-x87pc.mjs part C: .kkrieger's sFPow (_types.cpp, sINTRO: Agner Fog's fyl2x / fist / fisub /
// f2xm1 / multiply by 2^n), copied unchanged, under sFloatFix's control word (0x103f: single precision,
// nearest) on float operands as Bitmap_Bump's specular term calls it. One line per call: x, y, the bits.
#include <stdio.h>
typedef double sF64;
typedef float sF32;

sF64 sFPow(sF64 a,sF64 b)
{
  // faster pow based on code by agner fog
  __asm
  {
    fld   qword ptr [b];
    fld   qword ptr [a];

    ftst;
    fstsw ax;
    sahf;
    jz    zero;

    fyl2x;
    fist  dword ptr [a];
    sub   esp, 12;
    mov   dword ptr [esp],0;
    mov   dword ptr [esp+4],0x80000000;
    fisub dword ptr [a];
    mov   eax, dword ptr [a];
    add   eax, 0x3fff;
    mov   [esp+8], eax;
    jle   underflow;
    cmp   eax, 0x8000;
    jge   overflow;
    f2xm1;
    fld1;
    fadd;
    fld   tbyte ptr [esp];
    add   esp, 12;
    fmul;
    jmp   end;

underflow:
    fstp  st;
    fldz;
    add   esp, 12;
    jmp   end;

overflow:
    push  0x7f800000;
    fstp  st;
    fld   dword ptr [esp];
    add   esp, 16;
    jmp   end;

zero:
    fstp  st(1);

end:
  }
}

static void cw(unsigned short w) { __asm fldcw w }

int main()
{
  static const float Y[] = { 4.0f, 16.0f, 2.5f, 0.75f, 1.0f, 64.0f };
  unsigned s = 0x2545f491;
  int i, j;
  for (j = 0; j < 6; j++) {
    for (i = 0; i < 400; i++) {
      volatile float x;
      volatile double r;
      s = s * 1664525 + 1013904223;
      x = (float)((s >> 8) & 0xffffff) / 16777216.0f;            // (0,1), a float
      cw(0x103f);
      r = sFPow(x, Y[j]);
      cw(0x027f);
      {
        unsigned *u = (unsigned *)&r;
        float xx = x;
        printf("%08x %08x %08x%08x\n", *(unsigned *)&xx, *(unsigned *)&Y[j], u[1], u[0]);
      }
    }
  }
  return 0;
}
