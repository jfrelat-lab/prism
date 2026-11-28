// cpu.js — CPU architectural state for a real-mode 8086/186/286 (32-bit register
// file kept so 386 work can grow in without a rewrite).
//
// Registers follow Intel's ModR/M encoding so the recompiler can index them
// straight from decoded instruction fields:
//   reg32:  0=EAX 1=ECX 2=EDX 3=EBX 4=ESP 5=EBP 6=ESI 7=EDI
//   sreg:   0=ES  1=CS  2=SS  3=DS  4=FS  5=GS
//   reg8:   0=AL 1=CL 2=DL 3=BL 4=AH 5=CH 6=DH 7=BH
//
// Flags are computed eagerly into one EFLAGS integer. That is a deliberate v1
// choice: correctness first, with lazy flags as a known performance follow-up.

// EFLAGS bit masks
export const CF = 1 << 0, PF = 1 << 2, AF = 1 << 4, ZF = 1 << 6,
             SF = 1 << 7, TF = 1 << 8, IF = 1 << 9, DF = 1 << 10, OF = 1 << 11,
             NT = 1 << 14, RF = 1 << 16, VM = 1 << 17, IOPL = 3 << 12;

// Segment register indices
export const ES = 0, CS = 1, SS = 2, DS = 3, FS = 4, GS = 5;

const PARITY = (() => { const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { let p = 1, x = i; while (x) { p ^= 1; x &= x - 1; } t[i] = p; }
  return t; })();
const PF4 = PARITY.map((p) => p * 4);   // PF's own bit (4), for the branch-free setters below

export class CPU {
  constructor(mem) {
    this.mem = mem;
    this.reg = new Uint32Array(8);   // general registers
    this.seg = new Uint16Array(6);   // segment selectors
    this.base = new Uint32Array(6);  // cached linear base (selector << 4 in real mode)
    this.eip = 0;
    this.flags = 0x0002 | IF;        // reserved bit 1 = 1, interrupts enabled
    this.halted = false;
    // Code-segment default size (CS descriptor D bit): 0 = 16-bit operands/addresses, 1 = 32-bit.
    // Always 0 in real mode. It selects the DEFAULT that 0x66/0x67 invert, so translated code is
    // only valid for one value of it — the block cache is keyed by it (recompiler.js).
    this.csD = 0;
    this._cpl = 0;                   // stored CPL — see the `cpl` getter
    // Stack-segment B bit: 0 = the stack pointer is SP (16-bit, wraps in 64 KiB), 1 = ESP (32-bit).
    // Independent of the operand size, which decides how MUCH is pushed, not WHERE. Always 0 in
    // real mode. test386 POST 9 exists to catch exactly this confusion.
    this.ssB = 0;
    this.limit = new Uint32Array(6).fill(0xffff);   // cached segment limits (0xFFFF in real mode)
    this.limLo = new Uint32Array(6);                // lowest valid offset: limit+1 for expand-down, else 0
    this.segAccess = new Uint8Array(6);             // cached access byte (P/DPL/S/type)
    // Writes through this segment must fault: a code segment (never writable) or a data segment
    // whose W bit is clear. Precomputed at LOAD time so the emitted store tests one byte instead of
    // decoding the access rights per access — the difference between free and the kind of per-access
    // work that cost tube +6.3% / memories +12.2% when pagingOn was called that way. Real mode leaves
    // it 0: there are no descriptors, and a segment loaded in real mode keeps read/write rights
    // across a switch to protected mode, which is what makes unreal mode work.
    this.segRO = new Uint8Array(6);
    // Descriptor table registers. Real mode never consults them; LGDT/LIDT load them and protected
    // mode resolves every selector through them.
    this.gdtr = { base: 0, limit: 0 };
    this.idtr = { base: 0, limit: 0x3ff };          // the real-mode IVT, expressed as an IDTR
    this.ldtr = { sel: 0, base: 0, limit: 0 };
    this.tr = { sel: 0, base: 0, limit: 0 };        // task register — the TSS holds the inner-ring stacks
    this.cr3 = 0;                    // page-directory physical base (bits 31:12)
    this.cr4 = 0;                    // only PSE (bit 4) is implemented: 4 MiB pages — see setCR4
    this.cr2 = 0;                    // faulting linear address, set on #PF
    this.cr0 = 0x00000010;           // machine status word: PE=0 (real mode), ET=1 (387 present).
    // Set when a write lands inside the block that is CURRENTLY EXECUTING. A block is compiled from
    // the bytes it saw at translation time, so an in-place decryptor that rewrites its own tail runs
    // the stale form: Mystic Towers executed INT 2Fh as INT 00h that way. Declared here rather than
    // assigned on first use so the shape stays monomorphic on the dispatch path.
    this.smcSelf = 0;
                                     // SMSW reads it; LMSW and MOV CR0 write it, and bit 0 (PE) now
                                     // really switches how setSeg resolves a selector.

    // Interrupt plumbing. swInt() is filled in by the Machine: it routes a
    // software interrupt either to a JS handler or to a guest-hooked ISR.
    this.swInt = (n) => { throw new Error('Unhandled INT ' + n.toString(16)); };
    // Overwritten by Machine from the CPU profile; 0x1f (286+) is the default so a bare CPU works.
    this.shiftMask = 0x1f;
    this.idFlagMask = 0;             // EFLAGS.ID is writable only on a part that has CPUID
    this.acFlagMask = 0;             // EFLAGS.AC (486+); both set by Machine from the profile
    this.hiFlags = 0;                // = idFlagMask | acFlagMask: what the 32-bit forms may write
    // The debug registers, as storage only: no breakpoint ever fires from them here. They exist
    // because a value written to one has to read back — software probes the CPU that way.
    this.dr = new Uint32Array(8);
    this.ioRead = () => 0xff;        // (port,size) => value
    this.ioWrite = () => {};         // (port,size,value) => void

    this.cycles = 0;                 // coarse instruction counter (timing/budget)
    this.deadline = Infinity;        // cpu.cycles at which a tier-2 region must bail so the run
                                     // loop can deliver a due PIT tick (set per-slice by rec.run)
  }

  // ---- register accessors (used by handlers/loaders, not the hot path) -----
  get ax() { return this.reg[0] & 0xffff; }  set ax(v) { this.reg[0] = (this.reg[0] & ~0xffff) | (v & 0xffff); }
  get bx() { return this.reg[3] & 0xffff; }  set bx(v) { this.reg[3] = (this.reg[3] & ~0xffff) | (v & 0xffff); }
  get cx() { return this.reg[1] & 0xffff; }  set cx(v) { this.reg[1] = (this.reg[1] & ~0xffff) | (v & 0xffff); }
  get dx() { return this.reg[2] & 0xffff; }  set dx(v) { this.reg[2] = (this.reg[2] & ~0xffff) | (v & 0xffff); }
  get si() { return this.reg[6] & 0xffff; }  set si(v) { this.reg[6] = (this.reg[6] & ~0xffff) | (v & 0xffff); }
  get di() { return this.reg[7] & 0xffff; }  set di(v) { this.reg[7] = (this.reg[7] & ~0xffff) | (v & 0xffff); }
  get bp() { return this.reg[5] & 0xffff; }  set bp(v) { this.reg[5] = (this.reg[5] & ~0xffff) | (v & 0xffff); }
  get sp() { return this.reg[4] & 0xffff; }  set sp(v) { this.reg[4] = (this.reg[4] & ~0xffff) | (v & 0xffff); }
  get al() { return this.reg[0] & 0xff; }    set al(v) { this.reg[0] = (this.reg[0] & ~0xff) | (v & 0xff); }
  get ah() { return (this.reg[0] >> 8) & 0xff; } set ah(v) { this.reg[0] = (this.reg[0] & ~0xff00) | ((v & 0xff) << 8); }

  // ---- segment loading -----------------------------------------------------
  // In real mode a selector IS the base, shifted. In protected mode it is an INDEX into a descriptor
  // table, and base/limit/size come from the 8-byte descriptor found there. Every address the
  // recompiler emits is already `base[seg] + offset` and never `sel << 4`, so making this one method
  // descriptor-aware is what carries the entire emitted corpus into protected mode unchanged.
  //
  // Deliberately NOT here yet, each being its own step gated by test386's POST sequence: privilege
  // and type checks with #GP, call gates, task switching. A selector that would fault on real
  // hardware is loaded here instead of raising — wrong, but wrong in a way that surfaces as a later
  // POST failing rather than as silence.
  /** Virtual-8086 mode: EFLAGS.VM. A V86 task runs 8086 code with protection still on underneath. */
  get v86() { return (this.flags & VM) !== 0; }

  /**
   * Current privilege level. It is STORED, not derived from CS's RPL, because between `mov cr0` (PE
   * on) and the far jump that reloads CS, the selector register still holds the REAL-MODE value —
   * and its low two bits mean nothing. Windows 3.0 runs there with CS = 0x13b, so a derived CPL read
   * 3 and the very next instruction, a far jump to a DPL-0 selector, was rejected with #GP(8).
   * On real hardware CPL lives in the CS descriptor cache, which that transition leaves at 0.
   */
  get cpl() { return this._cpl; }

  /** I/O privilege level. In V86 it gates the whole sensitive-instruction set. */
  get iopl() { return (this.flags >>> 12) & 3; }

  setSeg(i, sel) {
    sel &= 0xffff;
    // Real mode, and virtual-8086 mode: the selector IS the base, shifted. In V86 protection is
    // still on underneath, but a segment register holds an 8086 value and never indexes a table.
    if (!(this.cr0 & 1) || (this.flags & VM)) {
      this.seg[i] = sel;
      this.base[i] = sel << 4;
      this.limit[i] = 0xffff; this.limLo[i] = 0;
      this.segRO[i] = 0;                         // 8086 segments are always writable

      if (i === CS) { this.csD = 0; this._cpl = (this.flags & VM) ? 3 : 0; }
      else if (i === SS) this.ssB = 0;
      return;
    }
    // A load that FAULTS leaves the segment register ALONE — the descriptor is validated first and
    // the selector is committed only on success. Writing it up front left DS holding the selector we
    // had just refused, so the handler's own `mov ax,ds / push ax` saved 0xFFF8 and restored it into
    // DS on the way out, faulting again: test386's POST-B fails its SECOND fault test that way, not
    // its first. It also must not move CPL, for the same reason.
    if (this.loadDescriptor(i, sel) === false) return false;
    this.seg[i] = sel;
    if (i === CS) this._cpl = sel & 3;
  }

  /** Cache base/limit (and, for CS, the D bit) from the descriptor `sel` selects. */
  loadDescriptor(i, sel) {
    if ((sel & 0xfffc) === 0) {
      // A null selector is legal to LOAD into a data segment — it faults later, on use. Into CS or
      // SS it is #GP(0) at once. The difference is diagnostic as much as architectural: Heretic's
      // DOS4GW leaves through an IRET whose saved CS:IP reads back 0:0, and accepting that gave CS
      // base 0, so the guest ran from linear 0 for 20000 blocks instead of stopping where it broke.
      if ((i === CS || i === SS) && !this._delivering) { this.raise(13, 0); return false; }
      this.base[i] = 0; this.limit[i] = 0; this.limLo[i] = 0;
      if (i === CS) this.csD = 0; else if (i === SS) this.ssB = 0;
      return;
    }
    const tbl = (sel & 4) ? this.ldtr : this.gdtr;          // TI bit picks GDT or LDT
    // A selector past the table's limit is #GP(selector), not a read past the table. Without this
    // we followed a garbage selector into unmapped memory: delivering Windows' first #PF loads SS
    // from a TSS that has never been LTR'd, and the resulting nonsense selector read 0xff50 bytes
    // beyond a 0x10f-byte GDT.
    if ((sel & 0xfff8) + 7 > tbl.limit) { this.raise(13, sel & 0xfffc); return false; }
    const a = (tbl.base + (sel & 0xfff8)) >>> 0;            // the index is already scaled by 8
    const m = this.mem;
    let lo, b0, b1, access, gran, b2;
    // A descriptor read is an implicit SUPERVISOR access (see Memory.walk); it may still raise a
    // genuine #PF if the table's page is absent, hence the finally.
    m.sup++;
    try { lo = m.r16(a); b0 = m.r16(a + 2); b1 = m.r8(a + 4); access = m.r8(a + 5); gran = m.r8(a + 6); b2 = m.r8(a + 7); }
    finally { m.sup--; }
    // TYPE first, then presence — the order the manual checks them in.
    //   S=0 is a SYSTEM descriptor (LDT, TSS, gate): never loadable into a segment register.
    //   Into a data register, a code segment is only loadable if it is READABLE (bit 1).
    //   Into SS, only a WRITABLE DATA segment will do.
    //   Into CS, only a CODE segment — readable or not (the SDM's far JMP/CALL: "segment type is not
    //   code → #GP"). The data registers' rule was applied to CS too: HelenOS's kernel jumps to its
    //   execute-only code segment (access 98h) and took #GP(8), with no IDT yet — a triple fault.
    //   And a data segment loaded into CS was accepted.
    // Without these, an LDT or TSS descriptor loaded as if it were a segment and addressed whatever
    // its base and limit fields happened to encode — test386's POST-B expects #GP(selector).
    const isSys = !(access & 0x10), isCode = (access & 0x08) !== 0, rw = (access & 0x02) !== 0;
    if (isSys || (i === CS ? !isCode : i === SS ? (isCode || !rw) : (isCode && !rw))) { this.raise(13, sel & 0xfffc); return false; }
    // PRIVILEGE. A data load needs max(CPL, RPL) <= DPL; a CONFORMING code segment is exempt, since
    // its whole point is to be reachable from less privileged code. SS is stricter still: RPL and DPL
    // must both equal CPL. test386 runs the whole fault series a second time from ring 3, and this is
    // what it catches there — a DPL-1 segment loaded happily at CPL 3.
    // ...DATA registers only. SS and CS are loaded by the very transfers that CHANGE CPL — exception
    // delivery through a gate, IRET back to ring 3 — where `_cpl` is still the old value at the moment
    // of the load, so the same rule applied there rejects legitimate transitions and cost test386 its
    // whole V86 section (POST 0x0B back to 0x20). Those need the transfer's own privilege logic, not
    // this one.
    const dpl = (access >> 5) & 3, conforming = isCode && (access & 0x04) !== 0;
    // DATA registers only — and the exclusion of SS is a KNOWN GAP, not caution. The SS rule (RPL and
    // DPL must both equal CPL) is what test386's POST-B needs next, but turning it on rejects
    // test386's OWN ring-switch helper: at `cs=0xab, eip=0x2d46` it loads SS=0x118 (DPL 0) while our
    // `_cpl` says 3. That load is legitimate on real silicon, so the rule is not wrong — our CPL
    // tracking through the ring-switch path is. Fix that first; the rule then costs nothing.
    // CS is excluded for a different reason: it is loaded by the transfers that CHANGE CPL.
    if (i === SS) {
      // SS is stricter: RPL and DPL must BOTH equal CPL. No exemption is needed: both paths that load
      // SS before CS — a call gate and exception delivery — set `_cpl` to the ring they are entering
      // first, because that is the ring the inner stack is actually checked against.
      if ((sel & 3) !== this._cpl || dpl !== this._cpl) {
        this.raise(13, sel & 0xfffc); return false;
      }
    } else if (i !== CS && !conforming && dpl < Math.max(this._cpl, sel & 3)) {
      this.raise(13, sel & 0xfffc); return false;
    }
    // P=0 is a fault, not a usable descriptor: #NP(selector), or #SS(selector) when the load is into
    // the stack segment. Without it a not-present segment loaded silently and addressed whatever base
    // the table happened to hold — test386's POST-B expects EX_NP here and got a normal retirement.
    if (!(access & 0x80)) { this.raise(i === SS ? 12 : 11, sel & 0xfffc); return false; }
    let limit = (lo | ((gran & 0x0f) << 16)) >>> 0;
    if (gran & 0x80) limit = (((limit << 12) >>> 0) | 0xfff) >>> 0;   // G: the limit counts 4 KiB pages
    this.base[i] = (b0 | (b1 << 16) | (b2 << 24)) >>> 0;
    this.limit[i] = limit; this.limLo[i] = 0;
    // An EXPAND-DOWN data segment (type bit 2) is valid ABOVE its limit: limit+1 up to 4 GiB with
    // B set, up to 64 KiB without. Windows 95's KRNL386 reaches KERNEL32 at BFF70000h through such a
    // selector (limit FFFFh, B=1); checked as expand-up, `cmp dword [0BFF71000h],'KEXP'` was #GP(0),
    // and Windows shut down right after "Initializing KERNEL".
    if (!isCode && (access & 0x04)) {
      if (limit === 0xffffffff) { this.limLo[i] = 1; this.limit[i] = 0; }   // limit 4G-1: no valid offset
      else { this.limLo[i] = limit + 1; this.limit[i] = (gran & 0x40) ? 0xffffffff : 0xffff; }
    }
    this.segAccess[i] = access;
    this.segRO[i] = (isCode || !(access & 2)) ? 1 : 0;
    // The same bit is called D on a code segment and B on a stack segment: 32-bit default operand
    // size for CS, 32-bit stack pointer for SS.
    if (i === CS) this.csD = (gran & 0x40) ? 1 : 0;
    else if (i === SS) this.ssB = (gran & 0x40) ? 1 : 0;
  }

  /** Raw descriptor fields for a selector, or null for the null selector. */
  readDesc(sel) {
    sel &= 0xffff;
    if ((sel & 0xfffc) === 0) return null;
    const tbl = (sel & 4) ? this.ldtr : this.gdtr;
    if ((sel & 0xfff8) + 7 > tbl.limit) return null;        // past the table: no descriptor to read
    const a = (tbl.base + (sel & 0xfff8)) >>> 0, m = this.mem;
    m.sup++;                                                  // implicit supervisor access, as in loadDescriptor
    try {
      const access = m.r8(a + 5);
      return {
        w0: m.r16(a), w1: m.r16(a + 2), b4: m.r8(a + 4), access, b6: m.r8(a + 6), b7: m.r8(a + 7),
        sys: (access & 0x10) === 0, type: access & 0x0f, dpl: (access >> 5) & 3, present: (access & 0x80) !== 0,
      };
    } finally { m.sup--; }
  }

  /**
   * LAR / LSL — a descriptor's access rights or limit WITHOUT loading it. Both set ZF on success and
   * leave the destination untouched otherwise, so these return -1 for "not accessible".
   *
   * Accessible: non-null, inside its table, of a valid type, and — except for CONFORMING code,
   * readable from anywhere — DPL >= max(CPL, RPL).
   *
   * PRESENCE IS NOT ONE OF THE CONDITIONS, and that is the whole point of the instruction: LAR is
   * how software asks about a segment that may have been discarded, and it hands back the access
   * byte so the caller can test P for itself. Windows 3.1's KERNEL does precisely that, at
   * 037f:0ede — `lar ax,[ss:bx+2]` / `jnz fail` / `test ah,0x80` — so refusing a not-present
   * descriptor turned "discarded, go and load it" into "not a valid selector", and the segment was
   * never loaded. See tools/larprobe.asm, whose six answers QEMU and v86 give identically.
   */
  _descVisible(sel) {
    sel &= 0xffff;
    if ((sel & 0xfffc) === 0) return null;                     // null selector is never accessible
    const tbl = (sel & 4) ? this.ldtr : this.gdtr;
    if ((sel & 0xfff8) + 7 > tbl.limit) return null;           // beyond the table
    const d = this.readDesc(sel);
    if (!d) return null;
    if (d.sys) {
      // Valid system/gate types for LAR/LSL on a 386: LDT, TSS (avail/busy, 16 and 32 bit), and the
      // three gate kinds. Everything else (0, 8, 0xA, 0xD) is reserved and reads as inaccessible.
      const ok = [1, 2, 3, 4, 5, 9, 0xb, 0xc].includes(d.type);
      if (!ok) return null;
    }
    const conforming = !d.sys && (d.type & 0x0c) === 0x0c;
    if (!conforming) {
      const cpl = this.cpl, rpl = sel & 3;
      if (d.dpl < cpl || d.dpl < rpl) return null;
    }
    return d;
  }

  /** Access-rights dword for LAR: the descriptor's second dword with the base/limit bits masked
   *  out. A 16-bit operand keeps only the low half of that. -1 when inaccessible. */
  larRights(sel, is32) {
    const d = this._descVisible(sel);
    if (!d) return -1;
    const e2 = ((d.access << 8) | (d.b6 << 16) | (d.b7 << 24)) >>> 0;
    return (is32 ? (e2 & 0x00ffff00) : (e2 & 0x0000ff00)) >>> 0;
  }

  /**
   * VERR / VERW — may this selector be READ, or WRITTEN, from here? ZF reports the answer; nothing
   * else changes. Same visibility rules as LAR, plus: EVERY system descriptor is refused (LAR
   * accepts an LDT or a TSS; "read this LDT" is not a question), and then the type bits decide —
   * a code segment is readable only if its readable bit is set and is NEVER writable, a data
   * segment is always readable and writable only if its writable bit is set.
   *
   * PRESENCE IS NOT REQUIRED, which is not what one would guess: "may I read it" sounds like it
   * should need the segment to be in memory. QEMU and v86 both answer ZF=1 for a not-present data
   * segment (tools/pmprobe.asm, cases `verr 28 np` and `verw 28 np`), and the 386 manual's
   * pseudocode lists only the table limit, the type and the privilege. This comment said the
   * opposite until the probe was run.
   *
   * This used to be `cpu.flags |= ZF` — a stub that could not fail, and therefore could not be
   * distinguished from a working implementation until a guest asked about a selector that is not
   * accessible. Six of the thirteen probe cases were wrong.
   */
  verifySeg(sel, write) {
    const d = this._descVisible(sel);
    if (!d || d.sys) return false;
    const isCode = (d.type & 0x08) !== 0, rw = (d.type & 0x02) !== 0;
    return write ? (!isCode && rw) : (!isCode || rw);
  }

  /** Segment limit for LSL, granularity applied. -1 when inaccessible. A gate has no limit. */
  lslLimit(sel) {
    const d = this._descVisible(sel);
    if (!d) return -1;
    if (d.sys && (d.type === 4 || d.type === 5 || d.type === 0xc)) return -1;   // gates carry no limit
    let lim = (d.w0 | ((d.b6 & 0x0f) << 16)) >>> 0;
    if (d.b6 & 0x80) lim = (((lim << 12) >>> 0) | 0xfff) >>> 0;                 // G: the limit counts 4 KiB pages
    return lim >>> 0;
  }

  /**
   * CPUID. Only reached when the profile has it (src/cpu-profile.js); elsewhere the opcode is #UD.
   *
   * THE FEATURE BITS ARE OURS, and each one is set only if MIRAGE implements the thing — the same
   * rule as the BIOS configuration table and the CMOS. So, on every part that has CPUID: FPU,
   * because src/fpu.js is a real x87; TSC, because RDTSC (0F 31) answers from the cycle counter;
   * PSE, because CR4.PSE and 4 MiB page-directory entries are followed by Memory.walk; and CX8,
   * because CMPXCHG8B is there (cmpxchg8b below) — a Pentium has all four. The P6 profiles ('686',
   * 'pentiumpro') add what a Pentium Pro adds and MIRAGE has: MSR (RDMSR/WRMSR below) and CMOV
   * (CMOVcc, FCMOVcc, FCOMI). Nothing else. In particular SSE is NOT claimed although src/sse.js
   * exists: it implements the sixteen instructions one 1K intro uses, and a guest that read an SSE
   * bit here would be entitled to the whole extension. MMX (23) on the 'pentiummmx' profile only,
   * whose whole instruction set src/mmx.js has (the Pentium Pro has none). No SEP, no PGE, no MTRR,
   * no APIC.
   *
   * The vendor string is not a copy of anyone's. Claiming GenuineIntel would route a guest down a
   * path chosen for a chip we are not, and an unknown vendor is a truthful answer that software is
   * built to handle — that is what the string is for. The 'pentium' and 'pentiumpro' profiles say
   * GenuineIntel for the guests that classify by it.
   */
  cpuid() {
    const leaf = this.reg[0] >>> 0, P = this.profile || {};
    if (leaf === 0) {
      this.reg[0] = P.p6 ? 2 : 1;                        // highest leaf we answer
      // "MIRAGE  " padded to twelve bytes, in the EBX:EDX:ECX order CPUID uses — or the profile's
      // vendor (the 'pentium' profile, for guests that classify by it).
      const v = P.vendor || 'MIRAGE      ';
      const w = (i) => (v.charCodeAt(i) | (v.charCodeAt(i + 1) << 8) | (v.charCodeAt(i + 2) << 16) | (v.charCodeAt(i + 3) << 24)) >>> 0;
      this.reg[3] = w(0);                                // EBX bytes 0-3
      this.reg[2] = w(4);                                // EDX bytes 4-7
      this.reg[1] = w(8);                                // ECX bytes 8-11
      return;
    }
    if (leaf === 1) {
      this.reg[0] = P.signature || 0x0500;               // family 5, model 0 (or the profile's)
      this.reg[3] = 0;                                   // EBX: no brand index, no CLFLUSH line
      this.reg[1] = 0;                                   // ECX: none of the later extensions
      // EDX: FPU (0), PSE (3), TSC (4), CX8 (8); on a P6 also MSR (5) and CMOV (15); MMX (23), SSE (25),
      // SSE2 (26) as the profile has them.
      this.reg[2] = (1 << 0) | (1 << 3) | (1 << 4) | (1 << 8) | (P.p6 ? (1 << 5) | (1 << 15) : 0) | (P.mmx ? 1 << 23 : 0) | (P.sse ? 1 << 25 : 0) | (P.sse2 ? 1 << 26 : 0);
      return;
    }
    if (leaf === 2 && P.p6) {                            // cache and TLB descriptors, a Pentium Pro's:
      this.reg[0] = 0x03020101; this.reg[3] = 0; this.reg[1] = 0; this.reg[2] = 0x06040a42;   // (256K L2)
      return;
    }
    this.reg[0] = this.reg[3] = this.reg[1] = this.reg[2] = 0;   // an unknown leaf answers zeros
  }

  /**
   * CMPXCHG8B m64 (0F C7 /1): compare EDX:EAX with the quadword; equal, store ECX:EBX and set ZF;
   * different, load it into EDX:EAX and clear ZF. No other flag changes. The destination is written
   * either way (the old value back when the compare fails), as the processor does — so a read-only
   * page faults in both cases, and both halves are probed before either changes.
   */
  cmpxchg8b(a, a4) {
    const m = this.mem, lo = m.r32(a) >>> 0, hi = m.r32(a4) >>> 0;
    m.w32(a, lo); m.w32(a4, hi);
    if (lo === (this.reg[0] >>> 0) && hi === (this.reg[2] >>> 0)) {
      m.w32(a, this.reg[3] >>> 0); m.w32(a4, this.reg[1] >>> 0);
      this.flags |= ZF;
    } else { this.reg[0] = lo; this.reg[2] = hi; this.flags &= ~ZF; }
  }

  /**
   * RDMSR / WRMSR (0F 32 / 0F 30), ECX = the register, EDX:EAX = the value. The model-specific
   * registers a guest reads on a Pentium Pro that advertises nothing optional:
   *   10h  the time-stamp counter, what RDTSC reads (a write is ignored: the counter is the cycle count)
   *   17h  platform ID, 8Bh  microcode revision — zero: none loaded
   *   1Bh  APIC base — zero: no local APIC (CPUID says so too)
   *   2Ah  power-on configuration — zero
   *   79h  BIOS update trigger, write-only: a write is taken and no update is applied, so 8Bh still
   *        reads zero. Windows 2000's update.sys carries a Pentium Pro microcode update for our
   *        signature and loads it here (WRMSR 79h, EAX = the update's address); a #GP stopped the boot
   *        with KMODE_EXCEPTION_NOT_HANDLED. QEMU (TCG) ignores the write the same way.
   * Any other register is #GP(0), as on the part; so is either instruction outside ring 0.
   * Returns false when it raised.
   */
  rdmsr() {
    if (this.cpl !== 0 || (this.flags & 0x20000)) { this.raise(13, 0); return false; }
    const n = this.reg[1] >>> 0;
    if (n === 0x10) { this.reg[0] = this.cycles >>> 0; this.reg[2] = Math.floor(this.cycles / 4294967296) >>> 0; return true; }
    if (n === 0x17 || n === 0x1b || n === 0x2a || n === 0x8b) { this.reg[0] = 0; this.reg[2] = 0; return true; }
    this.raise(13, 0); return false;
  }
  wrmsr() {
    if (this.cpl !== 0 || (this.flags & 0x20000)) { this.raise(13, 0); return false; }
    const n = this.reg[1] >>> 0;
    if (n === 0x10 || n === 0x17 || n === 0x1b || n === 0x2a || n === 0x79 || n === 0x8b) return true;   // writes ignored
    this.raise(13, 0); return false;
  }

  /** LTR — the TSS descriptor lives in the GDT, like the LDT's. */
  loadTR(sel) {
    sel &= 0xffff; this.tr.sel = sel;
    const d = this.readDesc(sel);
    if (!d) { this.tr.base = 0; this.tr.limit = 0; this.tr.is386 = true; return; }
    let limit = (d.w0 | ((d.b6 & 0x0f) << 16)) >>> 0;
    if (d.b6 & 0x80) limit = (((limit << 12) >>> 0) | 0xfff) >>> 0;
    this.tr.base = (d.w1 | (d.b4 << 16) | (d.b7 << 24)) >>> 0;
    this.tr.limit = limit;
    // TYPE 1/3 is a 286 TSS, 9/B a 386 one, and the two lay their inner-ring stacks out differently.
    this.tr.is386 = (d.type & 0x08) !== 0;
  }

  /**
   * A hardware TASK SWITCH to the 32-bit TSS `sel` (Intel SDM vol. 3, "Task Switching"), for a far
   * JMP or CALL to a TSS descriptor or a task gate, and for IRET with NT set (`kind` = 'jmp' |
   * 'call' | 'iret'). `nextIp` is the EIP the outgoing task resumes at. 386BSD 1.0 switches
   * processes this way — `ljmp *0xc0(%ecx)` onto a TSS selector in cpu_switch — and this used to be
   * a #GP(48h): "trap 9 code 48, panic: trap" right after the device probes.
   *
   * Order: validate; save the outgoing registers into the CURRENT TSS; busy bits (JMP/IRET free the
   * old task, JMP/CALL claim the new one); for CALL the new TSS's link names the old one and NT is
   * set; then TR, CR3, LDTR, EFLAGS, the general registers and the segments are loaded, CS last
   * among the checks' inputs, and CR0.TS is set. 286 TSSes are not handled (no guest has needed one).
   */
  taskSwitch(sel, kind, nextIp, faultIp) {
    sel &= 0xffff;
    const m = this.mem, fail = (n, e) => { if (faultIp !== undefined) this.eip = faultIp >>> 0; this.raise(n, e); };
    if (sel & 4) return fail(13, sel & 0xfffc);                    // a TSS lives in the GDT
    const d = this.readDesc(sel);
    if (!d || !d.sys || (d.type & 0x0d) !== 0x09) return fail(13, sel & 0xfffc);   // 9 or B: a 386 TSS
    const busy = (d.type & 0x02) !== 0;
    if (kind === 'iret' ? !busy : busy) return fail(13, sel & 0xfffc);
    if (!d.present) return fail(11, sel & 0xfffc);
    let limit = (d.w0 | ((d.b6 & 0x0f) << 16)) >>> 0;
    if (d.b6 & 0x80) limit = (((limit << 12) >>> 0) | 0xfff) >>> 0;
    if (limit < 0x67) return fail(10, sel & 0xfffc);
    const nb = (d.w1 | (d.b4 << 16) | (d.b7 << 24)) >>> 0;
    const setBusy = (s, on) => { const a = (this.gdtr.base + (s & 0xfff8) + 5) >>> 0; const v = m.r8(a); m.w8(a, on ? v | 0x02 : v & ~0x02); };
    m.sup++;
    try {
      // 1. The outgoing task's state, into its own TSS. IRET clears NT in the image it leaves.
      const ob = this.tr.base >>> 0, oldSel = this.tr.sel & 0xffff;
      let of = this.flags >>> 0;
      if (kind === 'iret') of &= ~NT;
      m.w32(ob + 0x20, this.csD ? nextIp >>> 0 : nextIp & 0xffff); m.w32(ob + 0x24, of);
      for (let r = 0; r < 8; r++) m.w32(ob + 0x28 + r * 4, this.reg[r] >>> 0);
      for (let i = 0; i < 6; i++) m.w16(ob + 0x48 + i * 4, this.seg[i]);   // ES CS SS DS FS GS: our order too
      // 2. Busy bits and the back link.
      if (kind !== 'call') setBusy(oldSel, false);
      if (kind !== 'iret') setBusy(sel, true);
      if (kind === 'call') m.w16(nb + 0x00, oldSel);
      // 3. The incoming task.
      const cr3 = m.r32(nb + 0x1c) >>> 0, eip = m.r32(nb + 0x20) >>> 0;
      let nf = m.r32(nb + 0x24) >>> 0;
      const regs = []; for (let r = 0; r < 8; r++) regs.push(m.r32(nb + 0x28 + r * 4) >>> 0);
      const segs = []; for (let i = 0; i < 6; i++) segs.push(m.r16(nb + 0x48 + i * 4) & 0xffff);
      const ldt = m.r16(nb + 0x60) & 0xffff;
      if (kind === 'call') nf |= NT;
      this.loadTR(sel);
      if (this.pagingOn && (cr3 >>> 0) !== (this.cr3 >>> 0)) this.setCR3(cr3); else this.cr3 = cr3;
      this.loadLDT(ldt);
      this.flags = ((nf & (0x3f7fd5 | this.hiFlags)) | 2) >>> 0;
      for (let r = 0; r < 8; r++) this.reg[r] = regs[r];
      this.cr0 = (this.cr0 | 0x08) >>> 0;                          // TS: the FPU state belongs to the old task
      // CPL comes from the new CS before any other segment is checked against it; a V86 task's
      // selectors are paragraphs, which setSeg handles once VM is in EFLAGS.
      this._cpl = (this.flags & VM) ? 3 : (segs[CS] & 3);
      if (this.setSeg(CS, segs[CS]) === false) return;
      this.eip = eip;
      this.setSeg(SS, segs[SS]);
      for (const i of [ES, DS, FS, GS]) this.setSeg(i, segs[i]);
    } finally { m.sup--; }
  }

  /** The stack the TSS reserves for privilege level `pl`.
   *
   *  A 386 TSS holds ESP0 at +4 and SS0 at +8, eight bytes per level. A **286 TSS** holds SP0 at +2
   *  and SS0 at +4, FOUR bytes per level — and the difference is not academic: Windows 3.1 in
   *  standard mode (`win -s`) builds a 286 TSS (descriptor type 01, limit 2Bh) and enters its ring-0
   *  kernel through a 286 call gate. Reading it as a 386 TSS took SS0 from +8, which is past the end
   *  of that TSS and reads zero, so the inward stack switch loaded a null SS and raised #GP(0) — and
   *  Windows printed its own "Fault: 000D" panic into a buffer, then faulted again inside the panic
   *  printer, for ever. The same TSS read correctly gives SP0 30A8h, SS0 0068h. */
  tssStack(pl) {
    const m = this.mem, b = this.tr.base >>> 0;
    m.sup++;                        // the TSS is read on the processor's behalf: a supervisor access
    try {
      if (this.tr.is386 === false) return { esp: m.r16(b + 2 + pl * 4) & 0xffff, ss: m.r16(b + 4 + pl * 4) & 0xffff };
      return { esp: m.r32(b + 4 + pl * 8) >>> 0, ss: m.r16(b + 8 + pl * 8) & 0xffff };
    } finally { m.sup--; }
  }

  /**
   * Is this port access denied? Protected mode only. At CPL <= IOPL it is always allowed; above
   * that — and ALWAYS in virtual-8086 mode, where CPL is 3 — the TSS's I/O permission bitmap
   * decides, one bit per port, and a set bit denies.
   *
   * The bitmap's base is a word at TSS offset 0x66, and it runs to the TSS limit. A byte that would
   * lie past the limit denies: that is how a task with no bitmap (limit 0x67, the minimum 386 TSS)
   * gets no I/O at all. Before this, IN/OUT raised #GP for every CPL > IOPL, so a task the bitmap
   * PERMITS was refused as well; test386 tests both halves.
   *
   * @param {number} port  first port
   * @param {number} size  1, 2 or 4 — a word access needs both its bytes permitted
   */
  ioDenied(port, size) {
    if (!(this.cr0 & 1)) return false;
    if (!(this.flags & VM) && this.cpl <= this.iopl) return false;
    const b = this.tr.base >>> 0, lim = this.tr.limit >>> 0;
    if (lim < 0x67) return true;                          // not even a full 386 TSS
    this.mem.sup++;                 // the I/O bitmap is part of the TSS: a supervisor access
    try {
      const mapBase = this.mem.r16(b + 0x66);
      for (let i = 0; i < size; i++) {
        const p = (port + i) & 0xffff, off = mapBase + (p >>> 3);
        if (off > lim) return true;
        if (this.mem.r8((b + off) >>> 0) & (1 << (p & 7))) return true;
      }
      return false;
    } finally { this.mem.sup--; }
  }

  pushW(v, is32) { if (is32) this.push32(v); else this.push16(v); }

  /**
   * After an OUTWARD transfer (a far return or IRET to a less privileged ring), any of DS/ES/FS/GS
   * still holding a segment more privileged than the new CPL is loaded with the NULL selector — the
   * inner ring's data must not stay reachable from the outer one. Conforming code segments are
   * exempt, being readable from anywhere.
   *
   * test386 checks it directly: after returning from a ring-0 call gate it asserts
   * `mov ax,ds / cmp ax,0`. Leaving DS intact is a privilege leak, not just a stale register.
   */
  nullInvalidDataSegs(cpl) {
    for (const i of [ES, DS, FS, GS]) {
      const sel = this.seg[i];
      if ((sel & 0xfffc) === 0) continue;                    // already null
      const d = this.readDesc(sel);
      if (!d) continue;
      const conformingCode = !d.sys && (d.type & 0x0c) === 0x0c;
      if (!conformingCode && d.dpl < cpl) { this.seg[i] = 0; this.base[i] = 0; this.limit[i] = 0; this.limLo[i] = 0; }
    }
  }

  /**
   * Far CALL. In protected mode the destination descriptor decides everything, and it must be
   * examined BEFORE being used as a segment: S=0 marks a SYSTEM descriptor, and type 4 / 0xC are
   * 286 / 386 CALL GATES, whose "base/limit" fields are really selector:offset. Treating a gate as
   * a code segment is what made test386 POST 20 jump to linear 0xd0 and execute the real-mode IVT.
   *
   * A gate to a lower DPL also switches stacks: the inner stack comes from the TSS, the caller's
   * SS:ESP are pushed on it, and the gate's parameter count says how many words to copy across.
   */
  farCall(sel, off, is32, faultIp) {
    const plain = () => {
      // A far CALL that FAULTS pushes nothing and goes nowhere — and the fault is DELIVERED INSIDE
      // setSeg, synchronously: by the time it returns false, CS:EIP and SS:ESP already belong to the
      // handler. So everything the fault frame must record has to be in place BEFORE the load, and
      // nothing may be touched after a refusal. This used to be done the other way round — push,
      // load, then on refusal rewind ESP and set EIP to the faulting instruction — which is right
      // for a deferred fault and wrong three times over for this one: the frame saved the RETURN
      // address instead of the faulting one, the handler's entry EIP was overwritten with the
      // caller's offset, and ESP was "rewound" on the handler's stack. Windows 3.1 demand-loads
      // its segments through exactly this fault (#NP on `call far [bx+48]` at 07ff:091e), and its
      // handler ran from 0070:091e — its own CS, the caller's IP — until it hit #GP(07D0).
      // In real mode setSeg cannot refuse, so the order changes nothing there.
      const retCS = this.seg[CS], retIP = this.eip >>> 0;
      if (faultIp !== undefined) this.eip = faultIp >>> 0;   // the frame names THIS instruction
      if (this.setSeg(CS, sel) === false) return;           // delivered: the handler owns CS:EIP now
      this.pushW(retCS, is32); this.pushW(retIP, is32);
      this.eip = off >>> 0;
    };
    // Real mode, AND virtual-8086 mode: in V86 a far transfer is an 8086 one — the popped or given
    // selector is a paragraph, never an index into a table (see the comment on farRet).
    if (!(this.cr0 & 1) || (this.flags & VM)) return plain();
    const d = this.readDesc(sel);
    // An ordinary code segment: same rule as farJmp. Only a CALL GATE (below) changes rings.
    if (d && !d.sys) {
      const cpl = this.cpl;
      const conforming = (d.type & 0x0c) === 0x0c;
      if (conforming ? d.dpl > cpl : ((sel & 3) > cpl || d.dpl !== cpl)) {
        // EIP holds the return address a successful call would push; a fault must save the CALL's.
        if (faultIp !== undefined) this.eip = faultIp >>> 0;
        return this.raise(13, sel & 0xfffc);
      }
      // A far CALL to a code segment never changes CPL: CS's RPL becomes the CPL. A CONFORMING DPL-0
      // segment called from ring 1 runs at ring 1 — QNX 4 does exactly that (`call far [esp]` onto
      // 00E0h from 10A1h) — and loading the selector as given put us in ring 0, so its RETF looked
      // like an outward return, popped an SS:ESP that was never pushed, and the kernel stack was gone.
      sel = (sel & 0xfffc) | cpl;
    }
    if (!d || !d.sys) return plain();
    // A TSS or a task gate: a task switch, whose outgoing EIP is the return address already in EIP.
    if (d.type === 0x09 || d.type === 0x0b) return this.taskSwitch(sel, 'call', this.eip, faultIp);
    if (d.type === 0x05) return this.taskSwitch(d.w1, 'call', this.eip, faultIp);
    if (d.type !== 0x04 && d.type !== 0x0c) return plain();  // not a call gate
    const g32 = d.type === 0x0c;
    const gSel = d.w1 & 0xffff;
    const gOff = g32 ? ((d.w0 | ((d.b6 | (d.b7 << 8)) << 16)) >>> 0) : d.w0;
    const params = d.b4 & 0x1f;
    const target = this.readDesc(gSel);
    const cpl = this.cpl;
    const tdpl = target ? target.dpl : cpl;
    if (tdpl < cpl) {                                        // inward: switch to the TSS's stack
      const oldSS = this.seg[SS], oldESP = this.reg[4] >>> 0;
      const inner = this.tssStack(tdpl);
      const args = [];
      for (let i = 0; i < params; i++) {
        const a = (this.base[SS] + ((oldESP + i * (g32 ? 4 : 2)) >>> 0)) >>> 0;
        args.push(g32 ? this.mem.r32(a) : this.mem.r16(a));
      }
      // The new CPL applies to the STACK SWITCH, not just to CS: the inner SS is checked against the
      // ring we are entering, and setSeg(CS) below only sets _cpl afterwards. Loading SS while _cpl
      // still read the caller's ring made the SS privilege rule reject the gate's own stack.
      this._cpl = tdpl;
      this.setSeg(SS, inner.ss); this.reg[4] = inner.esp;
      this.pushW(oldSS, g32); this.pushW(oldESP, g32);
      for (let i = params - 1; i >= 0; i--) this.pushW(args[i], g32);
    }
    this.pushW(this.seg[CS], g32); this.pushW(this.eip >>> 0, g32);
    this.setSeg(CS, (gSel & 0xfffc) | tdpl);                 // CS's RPL becomes the new CPL
    this.eip = gOff >>> 0;
  }

  /**
   * Far JMP. A gate is followed the same way, but nothing is pushed and no stack switch happens.
   *
   * `faultIp` matters here for the same reason it does in farCall: without it a refused target
   * reports the fault and then falls through to `this.eip = off`, which overwrites the entry point
   * the delivery just set — the exception is raised and discarded in the same breath.
   */
  farJmp(sel, off, faultIp, nextIp) {
    if ((this.cr0 & 1) && !(this.flags & VM)) {           // V86 jumps as an 8086 does
      const d = this.readDesc(sel);
      if (d && d.sys && (d.type === 0x09 || d.type === 0x0b)) return this.taskSwitch(sel, 'jmp', nextIp ?? this.eip, faultIp);
      if (d && d.sys && d.type === 0x05) return this.taskSwitch(d.w1, 'jmp', nextIp ?? this.eip, faultIp);   // task gate
      if (d && d.sys && (d.type === 0x04 || d.type === 0x0c)) {
        const g32 = d.type === 0x0c;
        this.setSeg(CS, d.w1 & 0xffff);
        this.eip = (g32 ? ((d.w0 | ((d.b6 | (d.b7 << 8)) << 16)) >>> 0) : d.w0) >>> 0;
        return;
      }
      // A far JMP cannot change privilege, only stay at it: a non-conforming target demands
      // CPL == DPL exactly plus RPL <= CPL, a conforming one only DPL <= CPL.
      if (d && !d.sys) {
        const cpl = this.cpl;
        const conforming = (d.type & 0x0c) === 0x0c;
        if (conforming ? d.dpl > cpl : ((sel & 3) > cpl || d.dpl !== cpl)) {
          if (faultIp !== undefined) this.eip = faultIp >>> 0;
          this.raise(13, sel & 0xfffc);
          return;
        }
        sel = (sel & 0xfffc) | cpl;                        // CPL unchanged, as for a far CALL
      }
    }
    // As in farCall: a refusal is delivered inside setSeg, so the faulting EIP goes in first and
    // nothing is written after — setting it afterwards overwrote the handler's entry point.
    if (faultIp !== undefined) this.eip = faultIp >>> 0;
    if (this.setSeg(CS, sel) === false) return;
    this.eip = off >>> 0;
  }

  /** Far RET. Like IRET, an outward return also restores the caller's SS:ESP. */
  farRet(is32, popBytes, faultIp) {
    const pop = is32 ? () => this.pop32() : () => this.pop16();
    const cpl = this.cpl;
    const esp0 = this.reg[4];                       // to restore if the return is not permitted
    const eip = is32 ? (pop() >>> 0) : pop();
    const cs = pop() & 0xffff;
    // A far RET goes outward or stays put, never inward: the target's RPL must be >= CPL, and a
    // non-conforming segment's DPL must equal that RPL. The stack is rewound — a fault consumes
    // nothing.
    // IN VIRTUAL-8086 MODE a far RET is an 8086 one: the popped CS is a paragraph, and none of the
    // rules below apply — they would read it as a SELECTOR. CPL is 3 in V86 and every real-mode
    // segment has RPL 0 in its low bits, so the popped value always looked like a return INWARD
    // and raised #GP(selector). MS-DOS 6.22's EMM386 took that fault at a plain `retf` in V86
    // (029b:0723, CS 0F40 on the stack), reflected it to the BIOS default handler, and came back
    // to the same RETF — 155 000 times a second.
    const pm = (this.cr0 & 1) && !(this.flags & VM);
    if (pm) {
      const rpl = cs & 3;
      const d = this.readDesc(cs);
      const conforming = d && !d.sys && (d.type & 0x0c) === 0x0c;
      if (rpl < cpl || (d && !d.sys && (conforming ? d.dpl > rpl : d.dpl !== rpl))) {
        this.reg[4] = esp0;
        if (faultIp !== undefined) this.eip = faultIp >>> 0;
        return this.raise(13, cs & 0xfffc);
      }
    }
    if (popBytes) this.spAdd(popBytes);
    // Loading CS can FAULT — #NP is how Win16 loads a discarded code segment on demand, and a RETF to
    // one is routine. setSeg delivers the exception itself and returns false. The fault must see the
    // stack as it was before the RETF (so the handler can restart it), and nothing may run after it:
    // assigning EIP anyway sent Windows 95's VMM #NP handler to 0028:<return offset> instead of its
    // entry, a #GP there, and the Win16 kernel never resumed — the desktop stayed empty.
    if (pm && (cs & 3) > cpl) {
      const esp = is32 ? (pop() >>> 0) : pop();
      const ss = pop() & 0xffff;
      const after = this.reg[4];
      this.reg[4] = esp0;
      if (this.setSeg(CS, cs) === false) return;
      this.reg[4] = after; this.eip = eip;
      this.setSeg(SS, ss); this.reg[4] = esp;
      if (popBytes) this.spAdd(popBytes);
      this.nullInvalidDataSegs(cs & 3);
    } else {
      const after = this.reg[4];
      this.reg[4] = esp0;
      if (this.setSeg(CS, cs) === false) return;
      this.reg[4] = after; this.eip = eip;
    }
  }

  /**
   * IRET. In real mode it pops EIP/CS/EFLAGS and nothing else. In protected mode, returning to a
   * LESS privileged ring pops two more items — the caller's ESP and SS — because entering the inner
   * ring had switched stacks. test386's switchToRing3 is exactly this: it builds a five-element
   * frame (EIP, CS, EFLAGS, ESP, SS) and IRETs into ring 3. Getting the frame length wrong is how a
   * bogus CS ends up loaded, which is what made it spin at 9bf0:0004.
   *
   * The width comes from the operand size, so iretd pops dwords.
   */
  iret(is32, nextIp) {
    const pop = is32 ? () => this.pop32() : () => this.pop16();
    if (!(this.cr0 & 1)) {                       // real mode — unchanged
      this.eip = is32 ? (pop() >>> 0) : pop();
      this.setSeg(CS, pop() & 0xffff);
      const f = pop();                           // AC/ID: from an IRETD's frame, kept by a 16-bit IRET
      this.flags = ((f & 0x7fd5) | 2 | (is32 ? (f & this.hiFlags) : (this.flags & this.hiFlags))) >>> 0;
      return;
    }
    // Inside a V86 task, IRET is one of the IOPL-sensitive instructions: at IOPL < 3 it must trap to
    // the monitor instead of returning. At IOPL 3 it behaves as the 8086's, and cannot touch VM/IOPL.
    if (this.flags & VM) {
      if (this.iopl < 3) return this.raise(13, 0);
      const keep = this.flags & (VM | IOPL);
      this.eip = is32 ? (pop() >>> 0) : pop();
      this.setSeg(CS, pop() & 0xffff);
      const f = pop();
      this.flags = ((f & 0x7fd5) | 2 | keep | (is32 ? (f & this.hiFlags) : (this.flags & this.hiFlags))) >>> 0;
      return;
    }
    // NT set: this IRET returns to the task named by the current TSS's back link, not to a frame.
    if (this.flags & NT) {
      this.mem.sup++;
      let link; try { link = this.mem.r16(this.tr.base >>> 0) & 0xffff; } finally { this.mem.sup--; }
      return this.taskSwitch(link, 'iret', nextIp ?? this.eip + 1, this.eip);
    }
    const cpl = this.cpl;
    // A faulting IRET consumes NOTHING. The frame is popped before the target can be refused, so
    // without this the stack keeps whatever the pops took — three items, or five on an outward
    // return — and the handler runs on a skewed stack.
    const esp0 = this.reg[4];
    const eip = is32 ? (pop() >>> 0) : pop();
    const cs = pop() & 0xffff;
    const fl = pop();
    // IRETD from ring 0 with VM set in the popped EFLAGS is the ONLY way into virtual-8086 mode
    // short of a task switch. The frame is nine dwords, not three: the four data segments ride in it
    // because a V86 task's segment registers are 8086 values that no descriptor can describe.
    if (is32 && cpl === 0 && (fl & VM)) return this.enterV86(eip, cs, fl);
    // The return CS obeys the far RET's rules (SDM, IRET: "return code segment selector RPL < CPL",
    // "non-conforming and DPL != RPL", "conforming and DPL > RPL" are each #GP(selector)), and the
    // frame is left as it was. Windows NT 3.51 ENDS every V86 BIOS call on this fault: its
    // Ke386CallBios returns through an IRETD whose CS is the ring-0 code selector with RPL 3 (000Bh),
    // and its #GP handler recognises the faulting IRET and resumes the caller. Accepting the frame
    // ran ring 3 at a kernel address (#PF, U/S), VBEMP's first INT 10h never returned, and the
    // graphical switch never came: QEMU takes #GP(0008) there.
    {
      const d = this.readDesc(cs), rpl = cs & 3;
      const conforming = d && !d.sys && (d.type & 0x0c) === 0x0c;
      if (rpl < cpl || (d && !d.sys && (conforming ? d.dpl > rpl : d.dpl !== rpl))) {
        this.reg[4] = esp0;
        return this.raise(13, cs & 0xfffc);
      }
    }
    // On a refused CS the returns below keep EIP where the emitter left it — at the IRET itself — and
    // skip the EFLAGS write at the end of this function. Loading CS and THEN assigning eip/flags
    // regardless is how a reported fault was overwritten by the very target that had been denied.
    if ((cs & 3) > cpl) {                        // outward transition: the frame carries the stack
      const esp = is32 ? (pop() >>> 0) : pop();
      const ss = pop() & 0xffff;
      if (this.setSeg(CS, cs) === false) { this.reg[4] = esp0; return; }
      this.eip = eip;
      this.setSeg(SS, ss); this.reg[4] = esp;    // SS first: it decides whether ESP is 16 or 32 bits
      this.nullInvalidDataSegs(cs & 3);
    } else {
      if (this.setSeg(CS, cs) === false) { this.reg[4] = esp0; return; }
      this.eip = eip;
    }
    // IOPL and IF are not the returning code's to write. Only CPL 0 may change IOPL, and IF only
    // when CPL <= IOPL — the same rule POPF already followed. Writing the popped EFLAGS wholesale
    // let a ring-3 IRET zero the IOPL a DPMI host had set to 3 for its client, after which the
    // client's next CLI was a #GP: DOOM stopped there, inside DOS/4GW, drawing nothing.
    let nf = ((fl & 0x27fd5) | 2 | (is32 ? (fl & this.hiFlags) : (this.flags & this.hiFlags))) >>> 0;
    if (cpl !== 0) nf = (nf & ~IOPL) | (this.flags & IOPL);
    if (cpl > ((this.flags >>> 12) & 3)) nf = (nf & ~IF) | (this.flags & IF);
    this.flags = nf;
  }

  /**
   * Enter virtual-8086 mode from an IRETD frame whose EFLAGS has VM set. EIP, CS and EFLAGS are
   * already popped; what remains is ESP, SS, ES, DS, FS and GS — six more dwords, always dwords
   * whatever the segment they hold. VM must be set BEFORE the segments are loaded, since it is what
   * makes setSeg treat them as 8086 values rather than selectors.
   */
  enterV86(eip, cs, fl) {
    const esp = this.pop32() >>> 0, ss = this.pop32() & 0xffff;
    const es = this.pop32() & 0xffff, ds = this.pop32() & 0xffff;
    const fs = this.pop32() & 0xffff, gs = this.pop32() & 0xffff;
    this.flags = ((fl & (0x27fd5 | this.hiFlags)) | 2) >>> 0;   // VM is inside the mask
    this.setSeg(CS, cs); this.eip = eip >>> 0;
    this.setSeg(SS, ss); this.reg[4] = esp;
    this.setSeg(ES, es); this.setSeg(DS, ds); this.setSeg(FS, fs); this.setSeg(GS, gs);
    this.ssB = 0;                                          // an 8086 stack is 16-bit
  }

  /**
   * LLDT: the operand selects a GDT descriptor OF TYPE LDT, whose base and limit become the LDTR.
   * Until this existed, every LDT selector resolved against ldtr.base = 0 and read whatever sat at
   * linear address 0 — which is how test386's 32-bit stack section (its segments live in the LDT)
   * silently got a garbage descriptor rather than a fault.
   */
  loadLDT(sel) {
    sel &= 0xffff;
    this.ldtr.sel = sel;
    if ((sel & 0xfffc) === 0) { this.ldtr.base = 0; this.ldtr.limit = 0; return; }
    const a = (this.gdtr.base + (sel & 0xfff8)) >>> 0;      // an LDT selector always indexes the GDT
    const m = this.mem;
    let lo, b0, b1, gran, b2;
    m.sup++;                                                  // a GDT read: implicit supervisor access
    try { lo = m.r16(a); b0 = m.r16(a + 2); b1 = m.r8(a + 4); gran = m.r8(a + 6); b2 = m.r8(a + 7); }
    finally { m.sup--; }
    let limit = (lo | ((gran & 0x0f) << 16)) >>> 0;
    if (gran & 0x80) limit = (((limit << 12) >>> 0) | 0xfff) >>> 0;
    this.ldtr.base = (b0 | (b1 << 16) | (b2 << 24)) >>> 0;
    this.ldtr.limit = limit;
  }

  /**
   * Write CR0. Switching PE does NOT re-resolve the segment registers: on real hardware the cached
   * descriptors survive the switch untouched and are only replaced when a segment register is
   * explicitly reloaded. That is not a detail — it is what the standard entry sequence depends on
   * (`mov cr0,eax` with PE set, THEN a far jump to load CS), because at that instant DS/ES/SS still
   * hold real-mode paragraph values that are not valid selectors. Re-resolving them here would read
   * whatever the GDT happens to contain at those indices. It is also what makes "unreal mode" work.
   */
  setCR0(v) {
    // Notify on any change to PAGING-IN-EFFECT, which is PG *and* PE: clearing PE with PG still set
    // turns translation off just as clearing PG does, and memory caches that answer.
    const was = this.pagingOn;
    this.cr0 = v >>> 0;
    if (this.pagingOn !== was) this.onPagingChange && this.onPagingChange();
  }

  /** CR4. Of its bits only PSE (bit 4) means anything here — 4 MiB pages, which Memory.walk follows
   *  — and only PSE is kept; the others read back as 0, as on a CPU without those features.
   *  Plan 9 (9legacy) maps its kernel with 4 MiB pages when CPUID says PSE, and without them its
   *  loader panics at "vmap: va=0x81000000" — QEMU with `-cpu pentium,-pse` panics identically. */
  setCR4(v) {
    const was = this.cr4; this.cr4 = (v & 0x10) >>> 0;
    if (was !== this.cr4 && this.pagingOn) this.onPagingChange && this.onPagingChange();
  }

  /** CR3 reload: the whole software TLB is stale. */
  setCR3(v) {
    this.cr3 = v >>> 0;
    // Under paging a CR3 load is a TLB flush, not a paging transition: onCR3 (machine.js) refreshes
    // the software TLB and lets the translated blocks survive (ROADMAP D8). Anything else is.
    if (this.pagingOn && this.onCR3) this.onCR3(); else this.onPagingChange && this.onPagingChange();
  }

  /** Paging enabled? Only meaningful with PE set — PG without PE is illegal. */
  get pagingOn() { return ((this.cr0 >>> 31) & 1) !== 0 && (this.cr0 & 1) !== 0; }

  /** Linear address of CS:IP — where the recompiler fetches the next block. */
  csip() { const a = this.base[CS] + (this.csD ? (this.eip >>> 0) : (this.eip & 0xffff));
    return this.mem.paged ? (a >>> 0) : (a & this.mem.mask); }

  // ---- real-mode stack -----------------------------------------------------
  /** The stack pointer in use: SP or ESP, per the SS descriptor's B bit. */
  get stackPtr() { return this.ssB ? (this.reg[4] >>> 0) : (this.reg[4] & 0xffff); }
  /** Adjust it by n, wrapping in 16 bits and preserving the high half when B=0. */
  spAdd(n) {
    if (this.ssB) this.reg[4] = (this.reg[4] + n) >>> 0;
    else this.reg[4] = (this.reg[4] & ~0xffff) | ((this.reg[4] + n) & 0xffff);
  }

  /**
   * Linear address of the stack top. The RAM/A20 mask belongs to PHYSICAL addresses, so it must not
   * be applied once paging is on — Windows 3.0's kernel stack lives at linear 0x800131e8, and with
   * A20 closed that was masked to 0x131e8: every push landed in low memory and every pop read zeros,
   * so its exception dispatcher read a return address of 0 and called through a wild pointer.
   */
  get stackLin() {
    const a = this.base[SS] + this.stackPtr;
    return this.mem.paged ? (a >>> 0) : (a & this.mem.mask);
  }

  // A push WRITES FIRST and moves the stack pointer after. Decrementing first left ESP moved when the
  // write faulted, and the restarted push moved it again: under demand paging a push onto a fresh
  // stack page shifted the frame by one slot. The 386 commits ESP only once the store has succeeded.
  push16(v) {
    const sp = this.ssB ? (this.reg[4] - 2) >>> 0 : (this.reg[4] - 2) & 0xffff, a = this.base[SS] + sp;
    this.mem.w16(this.mem.paged ? (a >>> 0) : (a & this.mem.mask), v & 0xffff);
    this.reg[4] = this.ssB ? sp : (this.reg[4] & ~0xffff) | sp;
  }
  pop16() {
    const v = this.mem.r16(this.stackLin);
    this.spAdd(2);
    return v;
  }
  push32(v) {
    const sp = this.ssB ? (this.reg[4] - 4) >>> 0 : (this.reg[4] - 4) & 0xffff, a = this.base[SS] + sp;
    this.mem.w32(this.mem.paged ? (a >>> 0) : (a & this.mem.mask), v >>> 0);
    this.reg[4] = this.ssB ? sp : (this.reg[4] & ~0xffff) | sp;
  }
  pop32() {
    const v = this.mem.r32(this.stackLin);
    this.spAdd(4);
    return v >>> 0;
  }

  // ---- flag computation (called from generated code) -----------------------
  setAdd(a, b, r, bits, withCarry = true) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    r &= m; a &= m; b &= m;
    let f = this.flags & ~(PF | AF | ZF | SF | OF | (withCarry ? CF : 0));
    if (withCarry && ((a >>> 0) + (b >>> 0)) > m) f |= CF;
    if (r === 0) f |= ZF;
    if (r & msb) f |= SF;
    if ((~(a ^ b) & (a ^ r)) & msb) f |= OF;
    if ((a ^ b ^ r) & 0x10) f |= AF;
    if (PARITY[r & 0xff]) f |= PF;
    this.flags = f;
  }
  setSub(a, b, r, bits, withCarry = true) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    r &= m; a &= m; b &= m;
    let f = this.flags & ~(PF | AF | ZF | SF | OF | (withCarry ? CF : 0));
    if (withCarry && (a >>> 0) < (b >>> 0)) f |= CF;
    if (r === 0) f |= ZF;
    if (r & msb) f |= SF;
    if (((a ^ b) & (a ^ r)) & msb) f |= OF;
    if ((a ^ b ^ r) & 0x10) f |= AF;
    if (PARITY[r & 0xff]) f |= PF;
    this.flags = f;
  }
  /*
   * The 32-bit forms, for the code a recompiled 32-bit program runs most: the same flags as setAdd,
   * setSub and setLogic at 32 bits with the carry, each taken from its bit with no branch but the
   * zero test. Generic, with the width and the carry as arguments, these were an eighth of
   * Valleyball's synthesizer in Chrome, whose V8 inlined them less than Node's.
   * Bits: CF 1, PF 4, AF 10h, ZF 40h, SF 80h, OF 800h (8D5h together).
   */
  setAdd32(a, b, r) {
    a >>>= 0; b >>>= 0; r >>>= 0;
    this.flags = (this.flags & ~0x8d5) | (a + b > 0xffffffff ? 1 : 0) | PF4[r & 0xff] | ((a ^ b ^ r) & 0x10)
      | (r === 0 ? 0x40 : 0) | ((r >>> 24) & 0x80) | (((~(a ^ b) & (a ^ r)) >>> 20) & 0x800);
  }
  setSub32(a, b, r) {
    a >>>= 0; b >>>= 0; r >>>= 0;
    this.flags = (this.flags & ~0x8d5) | (a < b ? 1 : 0) | PF4[r & 0xff] | ((a ^ b ^ r) & 0x10)
      | (r === 0 ? 0x40 : 0) | ((r >>> 24) & 0x80) | ((((a ^ b) & (a ^ r)) >>> 20) & 0x800);
  }
  // INC and DEC: ADD and SUB of 1 with CF left as it was.
  setInc32(a, r) {
    a >>>= 0; r >>>= 0;
    this.flags = (this.flags & ~0x8d4) | PF4[r & 0xff] | ((a ^ 1 ^ r) & 0x10) | (r === 0 ? 0x40 : 0) | ((r >>> 24) & 0x80) | (r === 0x80000000 ? 0x800 : 0);
  }
  setDec32(a, r) {
    a >>>= 0; r >>>= 0;
    this.flags = (this.flags & ~0x8d4) | PF4[r & 0xff] | ((a ^ 1 ^ r) & 0x10) | (r === 0 ? 0x40 : 0) | ((r >>> 24) & 0x80) | (r === 0x7fffffff ? 0x800 : 0);
  }
  setLogic32(r) {
    r >>>= 0;
    this.flags = (this.flags & ~0x8d5) | PF4[r & 0xff] | (r === 0 ? 0x40 : 0) | ((r >>> 24) & 0x80);
  }
  /*
   * The 8- and 16-bit forms, for the byte and word arithmetic of the ALU group (add, sub, cmp, and, or,
   * xor, test): their operands and result come masked to the width. Generic, the width an argument,
   * these were 7 % of CoreMark's time under MIRAGE-LINUX (core_state_transition compares bytes).
   * SF is the width's top bit, OF its bit moved to 800h.
   */
  setAdd8(a, b, r) {
    this.flags = (this.flags & ~0x8d5) | (a + b > 0xff ? 1 : 0) | PF4[r] | ((a ^ b ^ r) & 0x10)
      | (r === 0 ? 0x40 : 0) | (r & 0x80) | (((~(a ^ b) & (a ^ r)) << 4) & 0x800);
  }
  setSub8(a, b, r) {
    this.flags = (this.flags & ~0x8d5) | (a < b ? 1 : 0) | PF4[r] | ((a ^ b ^ r) & 0x10)
      | (r === 0 ? 0x40 : 0) | (r & 0x80) | ((((a ^ b) & (a ^ r)) << 4) & 0x800);
  }
  setLogic8(r) {
    this.flags = (this.flags & ~0x8d5) | PF4[r] | (r === 0 ? 0x40 : 0) | (r & 0x80);
  }
  setAdd16(a, b, r) {
    this.flags = (this.flags & ~0x8d5) | (a + b > 0xffff ? 1 : 0) | PF4[r & 0xff] | ((a ^ b ^ r) & 0x10)
      | (r === 0 ? 0x40 : 0) | ((r >>> 8) & 0x80) | (((~(a ^ b) & (a ^ r)) >>> 4) & 0x800);
  }
  setSub16(a, b, r) {
    this.flags = (this.flags & ~0x8d5) | (a < b ? 1 : 0) | PF4[r & 0xff] | ((a ^ b ^ r) & 0x10)
      | (r === 0 ? 0x40 : 0) | ((r >>> 8) & 0x80) | ((((a ^ b) & (a ^ r)) >>> 4) & 0x800);
  }
  setLogic16(r) {
    this.flags = (this.flags & ~0x8d5) | PF4[r & 0xff] | (r === 0 ? 0x40 : 0) | ((r >>> 8) & 0x80);
  }
  setLogic(r, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    r &= m;
    let f = this.flags & ~(CF | PF | AF | ZF | SF | OF);
    if (r === 0) f |= ZF;
    if (r & msb) f |= SF;
    if (PARITY[r & 0xff]) f |= PF;
    this.flags = f;
  }
  /** Set CF/OF explicitly (shifts, rotates, mul); recompute ZF/SF/PF unless asked not to. */
  setShiftResult(r, bits, cf, of, touchSZP = true) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    r &= m;
    let f = this.flags & ~(CF | OF | (touchSZP ? (PF | ZF | SF) : 0));
    if (cf) f |= CF;
    if (of) f |= OF;
    if (touchSZP) {
      if (r === 0) f |= ZF;
      if (r & msb) f |= SF;
      if (PARITY[r & 0xff]) f |= PF;
    }
    this.flags = f;
  }

  setAdc(a, b, cin, r, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    a &= m; b &= m; r &= m;
    let f = this.flags & ~(CF | PF | AF | ZF | SF | OF);
    if (((a >>> 0) + (b >>> 0) + cin) > m) f |= CF;
    if (r === 0) f |= ZF;
    if (r & msb) f |= SF;
    if ((~(a ^ b) & (a ^ r)) & msb) f |= OF;
    if ((a ^ b ^ r) & 0x10) f |= AF;
    if (PARITY[r & 0xff]) f |= PF;
    this.flags = f;
  }
  setSbb(a, b, cin, r, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    a &= m; b &= m; r &= m;
    let f = this.flags & ~(CF | PF | AF | ZF | SF | OF);
    if ((a >>> 0) < ((b >>> 0) + cin)) f |= CF;
    if (r === 0) f |= ZF;
    if (r & msb) f |= SF;
    if (((a ^ b) & (a ^ r)) & msb) f |= OF;
    if ((a ^ b ^ r) & 0x10) f |= AF;
    if (PARITY[r & 0xff]) f |= PF;
    this.flags = f;
  }

  // ---- shifts & rotates (return result, set CF/OF; shifts also set SZP) ----
  // The count mask comes from the CPU profile (src/cpu-profile.js): a 286+ masks it to 5 bits, an
  // 8086/88 uses CL in full. That is why the shifts below handle counts >= the operand width
  // explicitly instead of leaning on JS's `<<`, which silently masks to 5 bits and would turn a
  // shift of 32 into a shift of 0.
  shl(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = bits - 1;
    v &= m; c &= this.shiftMask; if (!c) return v;
    // Everything is shifted out: the result is 0, and CF is the last bit to leave (the LSB when the
    // count equals the width, nothing at all beyond it).
    if (c >= bits) { const cf = c === bits ? (v & 1) : 0; this.setShiftResult(0, bits, !!cf, false); return 0; }
    const cf = c <= bits ? (v >>> (bits - c)) & 1 : 0;
    const res = (v << c) & m;
    const of = c === 1 ? (((res >>> msb) & 1) ^ cf) : 0;
    this.setShiftResult(res, bits, !!cf, !!of); return res;
  }
  shr(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = bits - 1;
    v &= m; c &= this.shiftMask; if (!c) return v;
    if (c >= bits) { const cf = c === bits ? ((v >>> msb) & 1) : 0; this.setShiftResult(0, bits, !!cf, false); return 0; }
    const cf = (v >>> (c - 1)) & 1, res = (v >>> c) & m;
    const of = c === 1 ? (v >>> msb) & 1 : 0;
    this.setShiftResult(res, bits, !!cf, !!of); return res;
  }
  sar(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    v &= m; c &= this.shiftMask; if (!c) return v;
    // An arithmetic shift saturates to the sign: every bit becomes the sign bit, which is also CF.
    if (c >= bits) { const neg = (v & msb) !== 0, res = neg ? m : 0; this.setShiftResult(res, bits, neg, false); return res; }
    const sv = ((v & msb) ? (v | ~m) : v) | 0;
    const cf = (sv >> (c - 1)) & 1, res = (sv >> c) & m;
    this.setShiftResult(res, bits, !!cf, false); return res;
  }
  // ROL/ROR: count masked to 5 bits (286+); period = bits. When the masked count is a nonzero
  // multiple of the period the value is unchanged but CF is STILL written (= LSB for ROL, MSB for
  // ROR) — a genuine bug in the old `if(!effective) return` path, independent of the count mask.
  rol(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1;
    v &= m; c &= this.shiftMask; if (!c) return v;
    const e = c % bits;
    const res = e ? (((v << e) | (v >>> (bits - e))) & m) : v, cf = res & 1;
    const of = c === 1 ? (((res >>> (bits - 1)) & 1) ^ cf) : 0;
    this.setShiftResult(res, bits, !!cf, !!of, false); return res;
  }
  ror(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = bits - 1;
    v &= m; c &= this.shiftMask; if (!c) return v;
    const e = c % bits;
    const res = e ? (((v >>> e) | (v << (bits - e))) & m) : v, cf = (res >>> msb) & 1;
    const of = c === 1 ? (((res >>> msb) & 1) ^ ((res >>> (msb - 1)) & 1)) : 0;
    this.setShiftResult(res, bits, !!cf, !!of, false); return res;
  }
  // RCL/RCR: through-carry, period = bits+1; count masked to 5 bits (286+). A full period restores
  // both value and CF, so an effective count of 0 returns unchanged with no flag write.
  rcl(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1;
    v &= m; c &= this.shiftMask; c %= (bits + 1); if (!c) return v;
    let cf = (this.flags & CF) ? 1 : 0;
    for (let i = 0; i < c; i++) { const nb = (v >>> (bits - 1)) & 1; v = ((v << 1) | cf) & m; cf = nb; }
    const of = (((v >>> (bits - 1)) & 1) ^ cf);
    this.setShiftResult(v, bits, !!cf, !!of, false); return v;
  }
  rcr(v, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1, msb = 1 << (bits - 1);
    v &= m; c &= this.shiftMask; c %= (bits + 1); if (!c) return v;
    let cf = (this.flags & CF) ? 1 : 0;
    const of = ((v >>> (bits - 1)) & 1) ^ cf;
    for (let i = 0; i < c; i++) { const nb = v & 1; v = (v >>> 1) | (cf ? msb : 0); cf = nb; }
    this.setShiftResult(v, bits, !!cf, !!of, false); return v;
  }

  // ---- multiply / divide (operate on AX/DX:AX directly) -------------------
  // ---- the flags MUL and IMUL leave: CF and OF as defined (the product does not fit the destination's
  // size), and the ones the architecture leaves undefined -- SF, ZF and PF of the result's low part, at the
  // operation's size, AF clear -- as Docker i386 computes them (tools/linux/imulflags.asm). They were left
  // as the instruction before had them: symetrie (a 256-byte intro) branches on SF right after IMUL.
  setMul(low, bits, c) { this.setShiftResult(low, bits, c, c, true); this.flags &= ~AF; }
  mul8(s)  { s &= 0xff;  const p = (this.reg[0] & 0xff) * s; this.ax = p; const c = (p & 0xff00) !== 0; this.setMul(p, 8, c); }
  mul16(s) { s &= 0xffff; const p = (this.reg[0] & 0xffff) * s; this.ax = p & 0xffff; this.dx = (p / 65536) & 0xffff; const c = this.dx !== 0; this.setMul(p, 16, c); }
  imul8(s) { s = (s << 24 >> 24); const p = ((this.reg[0] & 0xff) << 24 >> 24) * s; this.ax = p & 0xffff; const c = (p < -128 || p > 127); this.setMul(p, 8, c); }
  imul16(s){ s = (s << 16 >> 16); const p = ((this.reg[0] & 0xffff) << 16 >> 16) * s; this.ax = p & 0xffff; this.dx = (p >> 16) & 0xffff; const c = (p < -32768 || p > 32767); this.setMul(p, 16, c); }
  div8(s)  { s &= 0xff;  if (!s) { this.swInt(0); return true; } const n = this.ax, q = (n / s) | 0; if (q > 0xff) { this.swInt(0); return true; } this.al = q; this.ah = n % s; }
  div16(s) { s &= 0xffff; if (!s) { this.swInt(0); return true; } const n = (this.dx & 0xffff) * 65536 + (this.ax & 0xffff), q = Math.floor(n / s); if (q > 0xffff) { this.swInt(0); return true; } this.ax = q; this.dx = n % s; }
  idiv8(s) { s = (s << 24 >> 24); if (!s) { this.swInt(0); return true; } const n = (this.ax << 16 >> 16), q = (n / s) | 0; if (q < -128 || q > 127) { this.swInt(0); return true; } this.al = q & 0xff; this.ah = (n % s) & 0xff; }
  idiv16(s){ s = (s << 16 >> 16); if (!s) { this.swInt(0); return true; } const n = (((this.dx & 0xffff) << 16) | (this.ax & 0xffff)) | 0, q = (n / s) | 0; if (q < -32768 || q > 32767) { this.swInt(0); return true; } this.ax = q & 0xffff; this.dx = (n % s) & 0xffff; }
  // 32-bit MUL/IMUL/DIV/IDIV: EDX:EAX is a 64-bit value, beyond float64's exact range, so
  // compute with BigInt. reg[0]=EAX, reg[2]=EDX.
  mul32(s)  { const p = BigInt(this.reg[0] >>> 0) * BigInt(s >>> 0); this.reg[0] = Number(BigInt.asUintN(32, p)); this.reg[2] = Number(BigInt.asUintN(32, p >> 32n)); const c = this.reg[2] !== 0; this.setMul(this.reg[0], 32, c); }
  imul32(s) { const p = BigInt(this.reg[0] | 0) * BigInt(s | 0); this.reg[0] = Number(BigInt.asUintN(32, p)); this.reg[2] = Number(BigInt.asUintN(32, p >> 32n)); const c = p < -2147483648n || p > 2147483647n; this.setMul(this.reg[0], 32, c); }
  div32(s)  { s >>>= 0; if (!s) { this.swInt(0); return true; } const n = (BigInt(this.reg[2] >>> 0) << 32n) | BigInt(this.reg[0] >>> 0), bs = BigInt(s), q = n / bs; if (q > 0xffffffffn) { this.swInt(0); return true; } this.reg[0] = Number(q); this.reg[2] = Number(n % bs); }
  idiv32(s) { s |= 0; if (!s) { this.swInt(0); return true; } const n = BigInt.asIntN(64, (BigInt(this.reg[2] >>> 0) << 32n) | BigInt(this.reg[0] >>> 0)), bs = BigInt(s), q = n / bs; if (q > 2147483647n || q < -2147483648n) { this.swInt(0); return true; } this.reg[0] = Number(BigInt.asUintN(32, q)); this.reg[2] = Number(BigInt.asUintN(32, n % bs)); }

  // three-operand / 0F IMUL: signed multiply, result in this._mr, sets CF/OF
  imul16x(a, b, bits) {
    if (bits === 16) { a = a << 16 >> 16; b = b << 16 >> 16; const p = a * b; this._mr = p & 0xffff; const c = (p < -32768 || p > 32767); this.setMul(p, 16, c); }
    else { a |= 0; b |= 0; this._mr = Math.imul(a, b) >>> 0; const p = a * b; const c = (this._mr | 0) !== p; this.setMul(this._mr, 32, c); }
  }
  aam(base) { if (base === 0) { this.swInt(0); return true; } const al = this.reg[0] & 0xff; this.ah = (al / base) | 0; this.al = al % base; this.setLogic(this.reg[0] & 0xff, 8); }
  aad(base) { const al = this.reg[0] & 0xff, ah = (this.reg[0] >> 8) & 0xff; const r = (al + ah * base) & 0xff; this.reg[0] = (this.reg[0] & ~0xffff) | r; this.setLogic(r, 8); }

  // ---- BCD adjust (DAA/DAS/AAA/AAS); OF (and AAA/AAS SF/ZF/PF) left undefined
  _szp(al) { let f = this.flags & ~(ZF | SF | PF); if (al === 0) f |= ZF; if (al & 0x80) f |= SF; if (PARITY[al & 0xff]) f |= PF; this.flags = f; }
  daa() {
    const oldAL = this.reg[0] & 0xff, oldCF = this.flags & CF ? 1 : 0; let al = oldAL, cf = 0, af = 0;
    if ((al & 0x0f) > 9 || (this.flags & AF)) { const s = al + 6; al = s & 0xff; cf = (oldCF || s > 0xff) ? 1 : 0; af = 1; }
    if (oldAL > (this.profile.bcdAdjustsAX ? 0x99 : ((this.flags & AF) ? 0x9f : 0x99)) || oldCF) { al = (al + 0x60) & 0xff; cf = 1; }
    this.al = al; this._szp(al); this.flags = (this.flags & ~(CF | AF)) | (cf ? CF : 0) | (af ? AF : 0);
  }
  das() {
    const oldAL = this.reg[0] & 0xff, oldCF = this.flags & CF ? 1 : 0; let al = oldAL, cf = 0, af = 0;
    // The borrow out of AL-6 sets CF on a 386; on an 8088 it does not. Same generational split as
    // the AAA/AAS carry and the 0x99 threshold above, and measured the same way.
    if ((al & 0x0f) > 9 || (this.flags & AF)) {
      const borrow = al < 6;
      al = (al - 6) & 0xff; af = 1;
      if (this.profile.bcdAdjustsAX && (oldCF || borrow)) cf = 1;
    }
    if (oldAL > (this.profile.bcdAdjustsAX ? 0x99 : ((this.flags & AF) ? 0x9f : 0x99)) || oldCF) { al = (al - 0x60) & 0xff; cf = 1; }
    this.al = al; this._szp(al); this.flags = (this.flags & ~(CF | AF)) | (cf ? CF : 0) | (af ? AF : 0);
  }
  aaa() {
    // The adjustment is on AX, not on AL and AH separately: AL+6 CARRIES into AH, and the +1 is on
    // top of that carry. Masking AL to 8 bits first swallows it — with AX=1FFFh the 80386EX vectors
    // give AH=21h where the split form gives 20h.
    let ax = this.reg[0] & 0xffff, cf = 0, af = 0;
    if ((ax & 0x0f) > 9 || (this.flags & AF)) {
      ax = this.profile.bcdAdjustsAX ? ((ax + 0x106) & 0xffff)
        : ((ax & 0xff00) | ((ax + 6) & 0xff)) + 0x100 & 0xffff;
      af = 1; cf = 1;
    }
    ax &= 0xff0f; this.reg[0] = (this.reg[0] & ~0xffff) | ax;
    this.flags = (this.flags & ~(CF | AF)) | (cf ? CF : 0) | (af ? AF : 0);
  }
  aas() {
    // Same as aaa: the borrow out of AL-6 reaches AH, so the adjustment is on AX as a whole.
    let ax = this.reg[0] & 0xffff, cf = 0, af = 0;
    if ((ax & 0x0f) > 9 || (this.flags & AF)) {
      ax = this.profile.bcdAdjustsAX ? ((ax - 0x106) & 0xffff)
        : ((ax & 0xff00) | ((ax - 6) & 0xff)) - 0x100 & 0xffff;
      af = 1; cf = 1;
    }
    ax &= 0xff0f; this.reg[0] = (this.reg[0] & ~0xffff) | ax;
    this.flags = (this.flags & ~(CF | AF)) | (cf ? CF : 0) | (af ? AF : 0);
  }

  // ---- double-precision shifts (SHLD/SHRD) --------------------------------
  // A 16-bit SHLD/SHRD with a count of 17 to 31 is undefined in Intel's manual, and processors differ
  // (Bochs's shift16.cc; tools/shd16.asm on the oracles). A P6 and later shift dst:src:dst, so past 16
  // the source moves in from one side and the destination from the other: QEMU does that. A Pentium
  // shifts dst:src:src, which comes to rotating the source by count-16: DOSBox-X does that. The 386
  // and 486 are not measured here; they take the Pentium's way, which is what DOS sizecoders see in
  // DOSBox. kaneda (golden) builds its palette with `shrd ax,cx,18` and `shld si,cx,17`, qblove and
  // crevenge use `shrd cx,si,23`; left alone, as this returned before, kaneda stayed grey.
  shd16(dst, src, c, left) {
    const k = c - 16, other = this.profile && this.profile.p6 ? dst : src;
    const res = (left ? (src << k) | (other >>> (16 - k)) : (src >>> k) | (other << (16 - k))) & 0xffff;
    this.setShiftResult(res, 16, !!(left ? (src >>> (16 - k)) & 1 : (src >>> (k - 1)) & 1), false); return res;
  }
  shld(dst, src, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1; dst &= m; src &= m; c &= 31; if (!c) return dst;
    if (c > bits) return this.shd16(dst, src, c, true);
    const res = ((dst << c) | (src >>> (bits - c))) & m;
    const cf = (dst >>> (bits - c)) & 1, of = c === 1 ? (((res >>> (bits - 1)) & 1) ^ ((dst >>> (bits - 1)) & 1)) : 0;
    this.setShiftResult(res, bits, !!cf, !!of); return res;
  }
  shrd(dst, src, c, bits) {
    const m = bits === 32 ? 0xffffffff : (1 << bits) - 1; dst &= m; src &= m; c &= 31; if (!c) return dst;
    if (c > bits) return this.shd16(dst, src, c, false);
    const res = ((dst >>> c) | (src << (bits - c))) & m;
    const cf = (dst >>> (c - 1)) & 1, of = c === 1 ? (((res >>> (bits - 1)) & 1) ^ ((dst >>> (bits - 1)) & 1)) : 0;
    this.setShiftResult(res, bits, !!cf, !!of); return res;
  }

  // ---- condition evaluation for Jcc/SETcc/CMOVcc (codes 0..15) -------------
  cond(code) {
    const f = this.flags;
    const o = !!(f & OF), c = !!(f & CF), z = !!(f & ZF), s = !!(f & SF), p = !!(f & PF);
    switch (code) {
      case 0x0: return o;             case 0x1: return !o;
      case 0x2: return c;             case 0x3: return !c;
      case 0x4: return z;             case 0x5: return !z;
      case 0x6: return c || z;        case 0x7: return !c && !z;
      case 0x8: return s;             case 0x9: return !s;
      case 0xa: return p;             case 0xb: return !p;
      case 0xc: return s !== o;       case 0xd: return s === o;
      case 0xe: return z || (s !== o); case 0xf: return !z && (s === o);
    }
    return false;
  }
}
