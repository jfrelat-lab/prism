// cpu-profile.js — which x86 generation MIRAGE claims to be.
//
// Until now it was a hybrid nobody ever shipped: 8088 semantics on some 16-bit corners, 286
// behaviour on others (shift counts masked to 5 bits, PUSH SP pushing the original value), and 386
// decoding for 0x66/0x67/SIB. That seam is not academic: several of these differences are
// exactly how a DOS program DETECTS the CPU, so a program can reach a conclusion about the machine
// that no real machine would support, and then pick a code path on it.
//
// A profile makes the choice explicit and testable. Nearly all of it resolves at TRANSLATION time —
// the recompiler is a code generator, so a profile field becomes a constant in the emitted JS and
// costs nothing on the hot path.
//
// Only fields that are actually consumed live here. The rest of the generation table — `PUSHA`,
// `BOUND`, `ENTER`/`LEAVE` raising #UD below a 186, `0x66`/`0x67`/SIB/`MOVZX`/`SHLD` raising #UD
// below a 386, and the undefined-flag values after MUL/DIV/BCD — is deliberately NOT here yet.
// Declaring fields nothing reads would be fiction. Quantifying the undefined-flag differences needs
// the hardware-generated 286/386 vector suites (SingleStepTests/80286, /80386); those ship in a
// binary MOO container rather than the 8088 set's JSON, so consuming them is its own piece of work.

export const PROFILES = {
  // The 8086/8088 as the SingleStepTests vectors measure it. Not the default: the corpus is
  // 1990-94 DOS software, and the engine already behaves like a 286 in the places that differ.
  '8088': {
    name: '8088',
    // The count is used in full: `shl ax,255` really shifts 255 times, and everything is shifted
    // out. Implemented, not just plumbed — the helpers in cpu.js handle counts >= the operand size
    // explicitly, because JS's own `<<`/`>>` mask to 5 bits and would render a shift of 32 a no-op.
    // The recompiler's inline shift fast path is guarded to compile-time counts below the operand
    // size, so the large ones route to those helpers rather than to a bare JS shift.
    shiftCountMask: 0xff,
    pushSPOriginal: false,     // PUSH SP pushes SP *after* the decrement
    pushfSetsReserved: true,   // bits 12-15 always read back as 1
    // AAA/AAS adjust AL and AH SEPARATELY here: AL+6 is masked to 8 bits before AH is incremented,
    // so the carry out of AL never reaches AH. Measured — making it AX-wide costs 366 of the 8088
    // vectors. The 386 does the opposite; see below.
    bcdAdjustsAX: false,
    cpuid: false,              // CPUID is 486-and-later; the ID flag must not stick either
  },
  '286': {
    name: '286',
    shiftCountMask: 0x1f,      // 286+ masks the count to 5 bits
    pushSPOriginal: true,      // 286+ pushes the value SP had on entry
    pushfSetsReserved: false,  // cleared in real mode
    // NOT measured on a 286 — no hardware vectors for it here. It follows the 386 because that is the
    // likelier of the two, and saying so is better than implying it was checked.
    bcdAdjustsAX: true,
    cpuid: false,
  },
  // Today's default and what the corpus wants. Identical to 286 in the fields above; the difference
  // is the instruction set, which the decoder already provides unconditionally.
  '386': {
    name: '386',
    shiftCountMask: 0x1f,
    pushSPOriginal: true,
    pushfSetsReserved: false,
    // AAA/AAS adjust AX AS A WHOLE: the carry out of AL+6 reaches AH and the +1 rides on top of it.
    // With AX=1FFFh the 80386EX vectors give AH=21h where the split form gives 20h.
    bcdAdjustsAX: true,
    cpuid: false,
  },
  // A 586-class part, which is the lowest generation that has CPUID. Identical to '386' in every
  // semantic field above — the instruction set the decoder provides is the same — and the ONLY
  // difference is that CPUID answers and the ID flag can be toggled, which is how software detects
  // it. Not the default: a 1990-94 DOS corpus expects a 386, and a program that finds CPUID takes a
  // different path. Select it with `new Machine({ cpu: '586' })` or MIRAGE_CPU=586.
  '586': {
    name: '586',
    shiftCountMask: 0x1f,
    pushSPOriginal: true,
    pushfSetsReserved: false,
    bcdAdjustsAX: true,
    cpuid: true,
  },
  // '586' with an Intel identity, for guests that CLASSIFY by vendor. The default answers "MIRAGE  "
  // on purpose (see cpu.cpuid), and most software copes; NetBSD does not: an unknown vendor falls to
  // the NexGen row of its table, class 386, and its i386 kernel refuses to boot ("no appropriate CPU
  // class available"). This says GenuineIntel, family 5 model 2 (a P54C) — the feature bits stay
  // exactly ours (FPU, TSC). Select it with MIRAGE_CPU=pentium or `new Machine({ cpu: 'pentium' })`.
  pentium: {
    name: 'pentium',
    shiftCountMask: 0x1f,
    pushSPOriginal: true,
    pushfSetsReserved: false,
    bcdAdjustsAX: true,
    cpuid: true,
    vendor: 'GenuineIntel',
    signature: 0x0520,
  },
  // '586' with MMX, which src/mmx.js implements whole: family 5 model 4, a Pentium MMX (P55C), the
  // first part with it. CPUID says so (EDX bit 23); the vendor stays ours, as '586'. Heaven Seven
  // (Exceed, 2000) says "MMX instruction set required!" on anything else. MIRAGE_CPU=pentiummmx.
  pentiummmx: {
    name: 'pentiummmx',
    shiftCountMask: 0x1f,
    pushSPOriginal: true,
    pushfSetsReserved: false,
    bcdAdjustsAX: true,
    cpuid: true,
    mmx: true,
    signature: 0x0543,
  },
  // A P6-class part: '586' plus what a Pentium Pro adds and MIRAGE implements — CMOVcc, FCMOVcc and
  // FCOMI, RDMSR/WRMSR, CPUID leaf 2 — which CPUID then reports (CMOV, MSR), family 6. This is the
  // generation Windows 2000/XP, ReactOS, Haiku and i686 Linux are built for (docs/notes/roadmap-log.md, H14-1).
  // No MMX: the Pentium Pro has none. MIRAGE_CPU=686 or `new Machine({ cpu: '686' })`.
  '686': {
    name: '686',
    shiftCountMask: 0x1f,
    pushSPOriginal: true,
    pushfSetsReserved: false,
    bcdAdjustsAX: true,
    cpuid: true,
    p6: true,
    signature: 0x0619,
  },
  // '686' with MMX and SSE (src/mmx.js, src/sse.js): family 6 model 7, a Pentium III (Katmai). CPUID
  // says MMX (EDX bit 23) and SSE (25); not FXSR, which MIRAGE does not do. The Direct3D 9 intros of
  // 2008-2010 are compiled for SSE (MSVC's /arch:SSE: yes we can's MULSS). MIRAGE_CPU=pentium3.
  pentium3: {
    name: 'pentium3',
    shiftCountMask: 0x1f,
    pushSPOriginal: true,
    pushfSetsReserved: false,
    bcdAdjustsAX: true,
    cpuid: true,
    p6: true,
    mmx: true,
    sse: true,
    signature: 0x0673,
  },
  // 'pentium3' with SSE2 (EDX bit 26): family 15 model 2, a Pentium 4 (Northwood), what /arch:SSE2
  // code wants. MIRAGE_CPU=pentium4.
  pentium4: {
    name: 'pentium4',
    shiftCountMask: 0x1f,
    pushSPOriginal: true,
    pushfSetsReserved: false,
    bcdAdjustsAX: true,
    cpuid: true,
    p6: true,
    mmx: true,
    sse: true,
    sse2: true,
    signature: 0x0f24,
  },
  // '686' with an Intel identity: GenuineIntel, family 6 model 1 stepping 9, a Pentium Pro.
  pentiumpro: {
    name: 'pentiumpro',
    shiftCountMask: 0x1f,
    pushSPOriginal: true,
    pushfSetsReserved: false,
    bcdAdjustsAX: true,
    cpuid: true,
    p6: true,
    vendor: 'GenuineIntel',
    signature: 0x0619,
  },
};

export const DEFAULT_PROFILE = '386';

export function resolveProfile(p) {
  // MIRAGE_CPU was documented above and read nowhere: every headless run that set it got the 386.
  if (!p) p = (typeof process !== 'undefined' && process.env && process.env.MIRAGE_CPU) || null;
  if (!p) return PROFILES[DEFAULT_PROFILE];
  if (typeof p === 'object') return p;
  const found = PROFILES[String(p)];
  if (!found) throw new Error(`unknown CPU profile "${p}" (have: ${Object.keys(PROFILES).join(', ')})`);
  return found;
}
