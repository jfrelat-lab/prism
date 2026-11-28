/**
 * A page fault in flight. Thrown out of the memory accessors and caught by the recompiler's run
 * loop, which turns it into #PF — the only way to deliver a fault raised from INSIDE an access,
 * short of making every access site able to end its block.
 */
export class PageFault {
  /** `present` distinguishes a PROTECTION violation (page there, access refused) from a
   *  not-present page. It is bit 0 of the error code the handler reads. */
  constructor(lin, write, present) { this.lin = lin >>> 0; this.write = !!write; this.present = !!present; }
}

// memory.js — flat physical RAM with little-endian accessors and self-modifying-code
// (SMC) tracking. The engine is DOM-free so it runs identically in Node and the
// browser; everything visual is layered on top of this.

const PAGE_BITS = 12;            // 4 KiB pages — granularity for SMC invalidation
const PAGE_SIZE = 1 << PAGE_BITS;

export class Memory {
  /** @param {number} size power-of-two byte count (default 16 MiB) */
  constructor(size = 16 * 1024 * 1024) {
    if ((size & (size - 1)) !== 0) throw new Error('Memory size must be a power of two');
    this.size = size;
    this.paged = false;              // cached cpu.pagingOn — see syncPaging()
    this.pfRaise = false;            // Machine turns this on; see xlat()
    this.sup = 0;                    // > 0 while the CPU makes an IMPLICIT supervisor access; see walk()
    // Real-mode addressing wraps at 1 MiB (the 8086's 20-bit bus / the AT's A20 gate disabled at
    // reset). Default to that wrap regardless of how much RAM is installed, so segment:offset
    // arithmetic near FFFF:xxxx behaves like real hardware — DOS EXEPACK stubs and lots of startup
    // code rely on it (a 16 MiB buffer with no wrap makes them print "Packed file is corrupt").
    // A guest that wants the full range enables A20 (port 0x92) → setA20(true).
    this.a20 = false;
    this.mask = Math.min(size - 1, 0xfffff);
    this.buffer = new ArrayBuffer(size);
    this.u8 = new Uint8Array(this.buffer);
    this.dv = new DataView(this.buffer);

    // Pages that currently hold translated code. A write into one of these
    // pages tells the recompiler to throw the affected blocks away (SMC).
    // Indexed by LINEAR page, so it must cover the whole linear space — not just installed RAM.
    // markCodePage on an index past the end is silently dropped by a typed array, and Windows 3.0
    // runs its enhanced-mode kernel at linear 0x80000000: its code pages could not be marked at all,
    // so no write to them was ever reported and the recompiler kept executing stale blocks.
    // 1 MiB of flags for the full 4 GiB at 4 KiB granularity, which is cheap; rdOfs/wrOfs stay sized
    // to RAM, because those are a speed cache and a miss there just takes the (correct) helper.
    this.codePage = new Uint8Array(1 << 20);
    // (linAddr, len) => void — a LINEAR ADDRESS and a length, not a page index; see _dirty() below.
    // Wired up by the recompiler for SMC invalidation, and chainable as a write watchpoint: mark a
    // page with markCodePage() and every store into it arrives here. It fires on the WRITE, so it
    // sees a store of 0 onto a word that was already 0 — which no poll-for-change can.
    this.onCodeWrite = null;
    this.planar = false;     // true in EGA/VGA 16-colour modes → A000 writes go through vga.js
    this.vga = null;         // the VGA planar device (set by installVGA); used on A000 writes
    this.shadowReads = false;   // MIRAGE_MEM_READ=shadow: the A000 window mirrors what a planar read
                                // returns, so emitted code can read it with no test at all

    // Page tables for the `paged` memory-dispatch strategy (src/mem-strategy.js). One entry per
    // 4 KiB page holding a BIASED offset — base - (page<<12) — so emitted code adds the whole
    // address and needs no offset mask (the shape v86's TLB and DOSBox's paging.h both use). A
    // negative entry means "not plain RAM: take the helper".
    //
    // Kept correct at all times rather than lazily, which is cheap because only three rare things
    // dirty them: entering/leaving a planar mode, the A20 line, and a page gaining translated code.
    // The WRITE table folds in what is currently a second probe — a page holding code is simply not
    // plain — so the SMC check leaves the fast path instead of sitting beside the device test.
    //
    // Both cover the WHOLE linear space, not only installed RAM: under paging a linear page is wherever
    // the guest puts it, and a Linux program lives at 0804_8000h (code) and BFFF_F000h (stack), far
    // above 64 MiB. Sized to RAM, every one of its accesses missed the table and took the helper —
    // a quarter of Dhrystone's time, and 1.7x slower than the same program under DOS. The pages
    // above RAM (`nLow` on) are reset one by one from `highPages` rather than filled wholesale, so a
    // CR3 load or a paging transition costs what it did when the tables were RAM-sized.
    this.nLow = size >> PAGE_BITS;
    this.rdOfs = new Int32Array(1 << 20).fill(-1);
    this.wrOfs = new Int32Array(1 << 20).fill(-1);
    this.highPages = [];                  // pages >= nLow whose entries a paged fill set
    this.highMark = new Uint8Array(1 << 20);
    // The tables WITHOUT paging depend only on the A20 mask, the planar window and which pages hold
    // code. A DPMI host that pages (CWSDPMI) leaves paging for every interrupt and DOS call — 2000
    // times a second for Liquid War — and each time the identity table was rebuilt page by page, 16384
    // entries for 64 MiB. It is kept, with `tblGen` bumped by whatever it depends on, and copied back.
    this.tblGen = 0; this._idGen = -1; this._idRd = null; this._idWr = null;
    // Under paging the table is filled ON DEMAND (ROADMAP D8 step 2): a CR3 load marks every entry
    // stale and sends it to the helper, whose first access to a page fills it. Walking every page of
    // RAM on each load — 16384 walks for 64 MiB — was most of the 12% `walk` took in Windows 98's
    // boot, which reloads CR3 thousands of times a minute and touches a few hundred pages in between.
    // `stale` is kept apart from the -1 entries, so a page that IS -1 (device, absent, code for
    // writes) is not walked again on every access. MIRAGE_NOLAZYTLB=1 restores the eager rebuild.
    this.tlbStale = new Uint8Array(1 << 20).fill(1);
    this.tlbTag = new Int32Array(4096); this.tlbFrm = new Int32Array(4096); this.tlbFlg = new Uint8Array(4096);   // see xlat
    this.xtlb = !(typeof process !== 'undefined' && process.env && process.env.MIRAGE_NOXTLB === '1');
    this.lazyTlb = !(typeof process !== 'undefined' && process.env && process.env.MIRAGE_NOLAZYTLB === '1');
    this.rebuildPageTables();
  }

  /**
   * Recompute both page tables. Without guest paging this is the identity mapping, so a plain page's
   * biased offset is 0. With CR0.PG set it becomes a genuine SOFTWARE TLB: each entry holds
   * physical - linear for that page, so emitted code adds the whole linear address and lands on the
   * right physical byte with no walk. That is the case the biased-offset design was built for and
   * measured as premature — it stops being premature the moment there is translation to do.
   *
   * Refilling the whole table costs one walk per 4 KiB page of installed RAM (4096 for 16 MiB),
   * which is cheap enough to do outright on a CR3 reload or a paging transition rather than
   * maintaining per-entry validity.
   */
  /** Kept in sync by rebuildPageTables, which every paging change already goes through. `pagingOn`
   *  is a getter over two CR0 bits, and calling it per access cost 6-12% on the intro bench once the
   *  multi-byte accessors needed it too — measured against HEAD, back to back, on an idle machine. */
  syncPaging() { this.paged = !!(this.cpu && this.cpu.pagingOn); }

  rebuildPageTables() {
    this.syncPaging();
    if (this.tlbTag) this.tlbTag.fill(0);
    // The pages above RAM go back to "not plain, not yet walked" first, whatever comes next.
    const hp = this.highPages;
    for (let i = 0; i < hp.length; i++) { const q = hp[i]; this.rdOfs[q] = -1; this.wrOfs[q] = -1; this.tlbStale[q] = 1; this.highMark[q] = 0; }
    hp.length = 0;
    const n = this.nLow, paging = !!(this.cpu && this.cpu.pagingOn);
    if (paging && this.lazyTlb) { this.rdOfs.fill(-1, 0, n); this.wrOfs.fill(-1, 0, n); this.tlbStale.fill(1, 0, n); return; }
    if (!paging && this._idGen === this.tblGen) { this.rdOfs.set(this._idRd); this.wrOfs.set(this._idWr); return; }
    for (let p = 0; p < n; p++) this._fillPage(p, paging);
    if (paging) for (let p = n; p < this.rdOfs.length; p++) this._fillPage(p, true);   // MIRAGE_NOLAZYTLB only
    if (!paging) { this._idRd = this.rdOfs.slice(0, n); this._idWr = this.wrOfs.slice(0, n); this._idGen = this.tblGen; }
  }

  /** A helper access under paging has just SUCCEEDED on page p: if its entries are stale, fill them
   *  now — after the CPU has judged the access and set A (and D for a write), never before, since a
   *  fill walks the tables and a fill ahead of a faulting access set A where test386's page-fault
   *  handler asserts it clear. A write that just dirtied a clean page refreshes a write entry the
   *  fill had to refuse (the fast path cannot set D). */
  _afterAccess(p) {
    if (this.tlbStale[p]) this._lazyFill(p);
    else if (this.wrOfs[p] === -1 && this.rdOfs[p] !== -1 && !this.codePage[p] && this.walkD) this._lazyFill(p);
  }

  /** First helper access to a stale page under paging: fill its entry as the eager rebuild did —
   *  from the supervisor's point of view, the CPL a CR3 load runs at — so protection is unchanged. */
  _lazyFill(p) {
    this.sup++;
    try { this._fillPage(p, true); } finally { this.sup--; }
  }

  /** One entry of both tables — rebuildPageTables' body, for INVLPG. A guest that rewrites a PTE and
   *  invalidates that one page (KolibriOS frees and reallocates heap pages that way) must not keep
   *  running on the old frame: the table used to be refreshed only on a CR3 load, so INVLPG, a
   *  no-op, left the fast path reading and writing a page the kernel had already given away. */
  refreshPage(p) {
    if (this.tlbTag[p & 4095] === p + 1) this.tlbTag[p & 4095] = 0;   // the xlat TLB covers every page
    if (p < this.rdOfs.length) this._fillPage(p, !!(this.cpu && this.cpu.pagingOn));
  }

  _fillPage(p, paging) {
    this.tlbStale[p] = 0;
    if (p >= this.nLow && !this.highMark[p]) { this.highMark[p] = 1; this.highPages.push(p); }
    const device = !paging && this.planar && p >= 0xa0 && p < 0xb0;
    // Past the address mask is past RAM only WITHOUT paging; a paged linear page can map anywhere.
    if (device || (!paging && p >= ((this.mask + 1) >>> PAGE_BITS))) { this.rdOfs[p] = -1; this.wrOfs[p] = -1; return; }
    if (!paging) {
      this.rdOfs[p] = 0;
      this.wrOfs[p] = this.codePage[p] ? -1 : 0;
      return;
    }
    const phys = this.walk((p << PAGE_BITS) >>> 0);
    if (phys < 0 || phys >= this.size) { this.rdOfs[p] = -1; this.wrOfs[p] = -1; return; }   // not present → the helper faults
    // The device window is PHYSICAL A0000-AFFFF, wherever the guest maps it: the linear test above
    // is only right without paging.
    if (this.planar && phys >= 0xa0000 && phys < 0xb0000) { this.rdOfs[p] = -1; this.wrOfs[p] = -1; return; }
    const bias = (phys - (p << PAGE_BITS)) | 0;
    // The table is filled from the supervisor's point of view but read at any CPL, with no check: a
    // page only ring 0 may touch keeps the helper, which faults a ring-3 access as the CPU would.
    // While a negative bias missed the table anyway, almost no kernel page reached the fast path;
    // once it did, test386's user-mode access to a supervisor page stopped faulting.
    if (!this.walkUS) { this.rdOfs[p] = -1; this.wrOfs[p] = -1; return; }
    this.rdOfs[p] = bias;
    // A code page must keep trapping writes, and so must a read-only one (the R/W bit lives in
    // the walk; `walk` reports it via walkRW).
    this.wrOfs[p] = (this.codePage[p] || !this.walkRW || !this.walkD) ? -1 : bias;   // D: see _afterAccess
  }

  /** Translate a linear page to a physical address, or -1 if not present. Sets walkRW as a side
   *  channel for the writability of the last successful walk. */
  walk(lin, write) {
    const cpu = this.cpu;
    const dir = (cpu.cr3 & 0xfffff000) >>> 0;
    const pdeA = (dir + ((lin >>> 22) * 4)) >>> 0;
    const pde = this.r32phys(pdeA);
    if (!(pde & 1)) { this.walkRW = false; this.walkProt = false; return -1; }
    // A 4 MiB page: CR4.PSE set and PS (bit 7) in the directory entry. The PDE is the leaf — its
    // bits 31:22 are the frame, its U/S and R/W the whole protection, and it takes A and D.
    if ((cpu.cr4 & 0x10) && (pde & 0x80)) {
      this.walkRW = !!(pde & 2);
      const user = cpu.cpl === 3 && this.sup === 0;
      if ((user && !(pde & 4)) || (write && !this.walkRW && (user || (cpu.cr0 & 0x10000) !== 0))) { this.walkProt = true; return -1; }
      this.walkProt = false; this.walkUS = !!(pde & 4); this.walkD = !!write || !!(pde & 0x40);
      const need = write ? 0x60 : 0x20;
      if ((pde & need) !== need) this.dv.setUint32(pdeA & (this.size - 1), (pde | need) >>> 0, true);
      return ((pde & 0xffc00000) | (lin & 0x003ff000)) >>> 0;
    }
    const pt = (pde & 0xfffff000) >>> 0;
    const pteA = (pt + (((lin >>> 12) & 0x3ff) * 4)) >>> 0;
    const pte = this.r32phys(pteA);
    if (!(pte & 1)) { this.walkRW = false; this.walkProt = false; return -1; }
    this.walkRW = !!(pde & 2) && !!(pte & 2);          // both levels must allow writing
    // PAGE-LEVEL PROTECTION. U/S and R/W are ANDed down the two levels, exactly like the write bit
    // above. A user access to a supervisor page is refused outright; a user WRITE also needs R/W on
    // both levels. A supervisor write to a read-only page is allowed on a 386 unless CR0.WP is set —
    // that bit exists so a kernel can be made to honour its own copy-on-write mappings.
    // These faults report `present`, which is bit 0 of the error code: the page is there, the access
    // was refused. Without any of this a ring-3 program wrote through a read-only mapping and
    // test386's POST 0x11 never saw the fault it was waiting for.
    // IMPLICIT SUPERVISOR ACCESSES are exempt from the user check whatever the CPL: the processor
    // reads the GDT, the LDT, the IDT and the TSS on its own behalf, and those live in supervisor
    // pages in any real system. The CPU raises `sup` around each such read. Without it a ring-3
    // interrupt could not read ESP0 out of the TSS — the page was judged at CPL 3 and refused — and
    // delivering THAT #PF read the TSS again: a double fault at the same address, which is how the
    // FreeDOS desktop on v86's xcom144.img took the host process down.
    const user = this.cpu.cpl === 3 && this.sup === 0;
    const us = !!(pde & 4) && !!(pte & 4);
    if ((user && !us) || (write && !this.walkRW && (user || (this.cpu.cr0 & 0x10000) !== 0))) {
      this.walkProt = true; return -1;
    }
    this.walkProt = false; this.walkUS = us; this.walkD = !!write || !!(pte & 0x40);
    // ACCESSED on both levels, DIRTY on the leaf when the access writes — and only now, AFTER the
    // protection checks: an access that FAULTS sets neither. test386's page-fault handler asserts
    // exactly that, reading the PDE and PTE from inside the fault and requiring A and D clear.
    // Written straight to physical memory: a page table is not guest code, and routing the update
    // through w32 would re-enter translation.
    if (!(pde & 0x20)) this.dv.setUint32(pdeA & (this.size - 1), (pde | 0x20) >>> 0, true);
    const need = write ? 0x60 : 0x20;
    if ((pte & need) !== need) this.dv.setUint32(pteA & (this.size - 1), (pte | need) >>> 0, true);
    return (pte & 0xfffff000) >>> 0;
  }

  /** A physical dword read that never itself translates — used by the walk. */
  r32phys(a) {
    a &= this.size - 1;
    return (this.u8[a] | (this.u8[a + 1] << 8) | (this.u8[a + 2] << 16) | (this.u8[a + 3] << 24)) >>> 0;
  }

  /** Open (A20 on) or close the 1 MiB address wrap. On: the full installed RAM is addressable
   *  (real-mode HMA at FFFF:0010+). Off: segment:offset wraps at 1 MiB like an 8086. */
  setA20(on) {
    this.a20 = !!on; this.tblGen++;
    this.mask = on ? (this.size - 1) : Math.min(this.size - 1, 0xfffff);
    this.rebuildPageTables();
  }

  /** Entering or leaving a planar EGA/VGA mode moves A000-AFFF between plain RAM and the device. */
  setPlanar(on) {
    if (this.planar === !!on) return;
    this.planar = !!on; this.tblGen++;
    // Under paging the window can sit behind any linear page: re-derive every entry from its frame.
    if (this.paged) this.rebuildPageTables();
    else for (let p = 0xa0; p < 0xb0; p++) { this.rdOfs[p] = this.planar ? -1 : 0; this.wrOfs[p] = this.planar || this.codePage[p] ? -1 : 0; }
    // Entering a planar mode makes the window's contents meaningful again — refill the shadow.
    if (this.shadowReads && this.planar && this.vga) this.vga.rebuildShadow();
  }

  /**
   * Linear -> physical for the helper path. The emitted fast path never comes here (its page-table
   * entry already carries the bias); this is for pages the table marks as not-plain: device windows,
   * and under paging the not-present ones.
   *
   * NOT YET a #PF: a non-present page is counted and reads as zero. Raising the fault from inside a
   * memory accessor needs the same block-ending treatment as #DE and #UD, which is its own step —
   * and a silent zero surfaces as a later POST failing rather than as a wrong answer nobody sees.
   */
  xlat(a, write) {
    if (!this.paged) return a & this.mask;
    // A small direct-mapped TLB in front of the walk (ROADMAP D8 step 3). The fast tables above only
    // cover linear pages below the installed RAM size, so every access an NT or 9x kernel makes at
    // 80000000h/C0000000h came here and walked the page tables — for each BYTE, since r32 was four
    // r8. An entry keeps the frame and the rights the walk found: R/W, U/S, and whether the leaf is
    // already dirty — a write to a clean page takes the walk once, which sets D as the CPU would.
    // Cleared with the fast tables (CR3, CR4, A20, paging) and per page by INVLPG.
    const p = a >>> PAGE_BITS, i = p & 4095;
    if (this.tlbTag[i] === p + 1) {
      const f = this.tlbFlg[i], user = this.cpu.cpl === 3 && this.sup === 0;
      if ((!user || (f & 2)) && (!write || ((f & 4) && ((f & 1) || (!user && !(this.cpu.cr0 & 0x10000))))))
        return (this.tlbFrm[i] | (a & 0xfff)) & (this.size - 1);
    }
    const phys = this.walk(a, write);
    if (phys < 0) {
      this.pfCount = (this.pfCount || 0) + 1; this.lastPF = a >>> 0;
      // `pfTrace` attaches a JS stack to the fault. Off by default because building one per fault
      // is expensive and Windows takes millions; on, it names the CALLER — which is how the
      // TSS stack switch was identified as the thing reading past the GDT.
      if (this.pfRaise) { const f = new PageFault(a, write, this.walkProt); if (this.pfTrace) f.stack = new Error().stack; throw f; }
      return -1;                                   // no run loop to catch it: the old silent zero
    }
    if (this.xtlb) { this.tlbTag[i] = p + 1; this.tlbFrm[i] = phys; this.tlbFlg[i] = (this.walkRW ? 1 : 0) | (this.walkUS ? 2 : 0) | (this.walkD ? 4 : 0); }
    return (phys | (a & 0xfff)) & (this.size - 1);
  }

  // ---- reads ---------------------------------------------------------------
  // In a planar EGA/VGA mode, A000 reads go through the plane logic (and load the latches);
  // everything else is a direct typed-array read. `planar` is false for text/mode-13h/demos
  // so the check is a single predicted branch on the common path.
  /*
   * THE FAST TABLES FIRST, under paging: a helper access (a stack push, a string instruction, a
   * library made in JavaScript) to a page the compiled code would reach through rdOfs/wrOfs takes the
   * same entry -- physical minus linear, -1 when the page is not plain RAM, holds translated code, or
   * is not yet dirty for a write -- so the same rule decides, without a walk or a TLB probe. Under
   * MIRAGE-WIN32 a 4K intro's synthesizer thread pushed and popped its stack through xlat: a fifth of
   * its time.
   */
  r8(a)  {
    if (this.paged) { const o = this.rdOfs[a >>> PAGE_BITS]; if (o !== -1) return this.u8[(o + a) >>> 0]; }
    // Under paging the translated address is what decides device or RAM. The planar/VBE window was
    // only routed on the unpaged path, so a DPMI client (xcom144 under HDPMI32, VBE 111h banked)
    // drew into the raw RAM behind A000 and the framebuffer stayed black.
    if (this.paged) { const t = this.xlat(a, false); if (t >= 0) this._afterAccess(a >>> PAGE_BITS); return t < 0 ? 0 : (this.planar && t >= 0xa0000 && t < 0xb0000) ? this.vga.readByte(t) : this.u8[t]; }
    a &= this.mask; return (this.planar && a >= 0xa0000 && a < 0xb0000) ? this.vga.readByte(a) : this.u8[a];
  }
  // Under paging these go byte at a time, because only r8/w8 translate — and a multi-byte access can
  // straddle a page boundary, where the two halves land in unrelated frames. Composing was not just a
  // tidiness point: `a &= this.mask` treats a LINEAR address as physical, so every descriptor load
  // read half-translated (loadDescriptor mixes r16 and r8). Windows 3.0's WIN386 puts its GDT at
  // linear 0x8010011c, and we read the descriptor from physical 0x0010011c.
  // Within one page they now translate ONCE (ROADMAP D8 step 3): the four r8 of an r32 were four
  // walks. A straddling access, a fault (-1) and the device window keep the byte-wise path.
  _px(a, write) {
    const t = this.xlat(a, write);
    if (t >= 0) this._afterAccess(a >>> PAGE_BITS);
    return (t < 0 || (this.planar && t >= 0xa0000 && t < 0xb0000)) ? -1 : t;
  }
  r16(a) { if (this.paged) { if ((a & 0xfff) !== 0xfff) { const o = this.rdOfs[a >>> PAGE_BITS]; if (o !== -1) { const q = (o + a) >>> 0; return this.u8[q] | (this.u8[q + 1] << 8); } const t = this._px(a, false); if (t >= 0) return this.u8[t] | (this.u8[t + 1] << 8); } return this.r8(a) | (this.r8(a + 1) << 8); }
    a &= this.mask; if (this.planar && a >= 0xa0000 && a < 0xb0000) return this.r8(a) | (this.r8((a + 1) & this.mask) << 8);
    return this.u8[a] | (this.u8[(a + 1) & this.mask] << 8); }
  r32(a) { if (this.paged) { if ((a & 0xfff) <= 0xffc) { const o = this.rdOfs[a >>> PAGE_BITS]; if (o !== -1) { const q = (o + a) >>> 0; return (this.u8[q] | (this.u8[q + 1] << 8) | (this.u8[q + 2] << 16) | (this.u8[q + 3] << 24)) >>> 0; } const t = this._px(a, false); if (t >= 0) return (this.u8[t] | (this.u8[t + 1] << 8) | (this.u8[t + 2] << 16) | (this.u8[t + 3] << 24)) >>> 0; } return (this.r8(a) | (this.r8(a + 1) << 8) | (this.r8(a + 2) << 16) | (this.r8(a + 3) << 24)) >>> 0; }
    a &= this.mask; if (this.planar && a >= 0xa0000 && a < 0xb0000) return (this.r8(a) | (this.r8((a + 1) & this.mask) << 8) | (this.r8((a + 2) & this.mask) << 16) | (this.r8((a + 3) & this.mask) << 24)) >>> 0;
    return (this.u8[a] | (this.u8[(a + 1) & this.mask] << 8) | (this.u8[(a + 2) & this.mask] << 16) | (this.u8[(a + 3) & this.mask] << 24)) >>> 0; }

  // ---- writes (with SMC tracking) -----------------------------------------
  w8(a, v) {
    // The SMC bookkeeping is LINEAR, not physical: codePage is filled from blk.linStart and the block
    // cache is keyed by linear address, so testing the translated address here checked the wrong page
    // and reported the wrong one — every self-modifying write under paging missed its invalidation,
    // which is exactly what an OS relocating code does.
    if (this.paged) {
      const o = this.wrOfs[a >>> PAGE_BITS];
      if (o !== -1) { this.u8[(o + a) >>> 0] = v; return; }
      const t = this.xlat(a, true);
      if (t >= 0) {
        this._afterAccess(a >>> PAGE_BITS);
        if (this.planar && t >= 0xa0000 && t < 0xb0000) { this.vga.writeByte(t, v & 0xff); return; }
        this.u8[t] = v; if (this.codePage[a >>> PAGE_BITS]) this._dirty(a, 1);
      }
      return;
    }
    a &= this.mask;
    if (this.planar && a >= 0xa0000 && a < 0xb0000) { this.vga.writeByte(a, v & 0xff); return; }
    this.u8[a] = v;
    if (this.codePage[a >>> PAGE_BITS]) this._dirty(a, 1);
  }
  w16(a, v) {
    if (this.paged) {
      if ((a & 0xfff) !== 0xfff) { const o = this.wrOfs[a >>> PAGE_BITS]; if (o !== -1) { const q = (o + a) >>> 0; this.u8[q] = v; this.u8[q + 1] = v >> 8; return; }
        const t = this._px(a, true); if (t >= 0) { this.u8[t] = v; this.u8[t + 1] = v >> 8; if (this.codePage[a >>> PAGE_BITS]) this._dirty(a, 2); return; } }
      this.w8(a, v & 0xff); this.w8(a + 1, (v >> 8) & 0xff); return;
    }
    a &= this.mask;
    if (this.planar && a >= 0xa0000 && a < 0xb0000) { this.w8(a, v & 0xff); this.w8((a + 1) & this.mask, (v >> 8) & 0xff); return; }
    this.u8[a] = v; this.u8[(a + 1) & this.mask] = v >> 8;
    if (this.codePage[a >>> PAGE_BITS] || this.codePage[(a + 1) >>> PAGE_BITS]) this._dirty(a, 2);
  }
  w32(a, v) {
    if (this.paged) {
      if ((a & 0xfff) <= 0xffc) { const o = this.wrOfs[a >>> PAGE_BITS]; if (o !== -1) { const q = (o + a) >>> 0; this.u8[q] = v; this.u8[q + 1] = v >> 8; this.u8[q + 2] = v >> 16; this.u8[q + 3] = v >>> 24; return; }
        const t = this._px(a, true); if (t >= 0) { this.u8[t] = v; this.u8[t + 1] = v >> 8; this.u8[t + 2] = v >> 16; this.u8[t + 3] = v >>> 24; if (this.codePage[a >>> PAGE_BITS]) this._dirty(a, 4); return; } }
      this.w8(a, v & 0xff); this.w8(a + 1, (v >> 8) & 0xff);
      this.w8(a + 2, (v >> 16) & 0xff); this.w8(a + 3, (v >>> 24) & 0xff); return;
    }
    a &= this.mask;
    if (this.planar && a >= 0xa0000 && a < 0xb0000) { this.w8(a, v & 0xff); this.w8((a + 1) & this.mask, (v >> 8) & 0xff); this.w8((a + 2) & this.mask, (v >> 16) & 0xff); this.w8((a + 3) & this.mask, (v >>> 24) & 0xff); return; }
    this.u8[a] = v; this.u8[(a + 1) & this.mask] = v >> 8;
    this.u8[(a + 2) & this.mask] = v >> 16; this.u8[(a + 3) & this.mask] = v >> 24;
    if (this.codePage[a >>> PAGE_BITS] || this.codePage[(a + 3) >>> PAGE_BITS]) this._dirty(a, 4);
  }

  // SMC: report the written byte range so the recompiler can invalidate only the
  // blocks it actually overlaps (not the whole page).
  _dirty(addr, len) { if (this.onCodeWrite) this.onCodeWrite(addr, len); }

  // A page gaining or losing translated code moves it in and out of the write fast path. wrOfs
  // mirrors rdOfs when the page is clean, so a device page stays a device page either way.
  markCodePage(page) { if (!this.codePage[page]) this.tblGen++; this.codePage[page] = 1; if (page < this.wrOfs.length) this.wrOfs[page] = -1; }
  clearCodePage(page) { if (this.codePage[page]) this.tblGen++; this.codePage[page] = 0; if (page < this.wrOfs.length) this.wrOfs[page] = this.rdOfs[page]; }

  // ---- bulk helpers --------------------------------------------------------
  /** Copy bytes in, marking SMC if they land on code pages. */
  blit(addr, bytes) {
    // `addr` is what the GUEST named — linear. Under paging it goes through the page tables a page
    // at a time, as w8 does: Windows 95's VMM maps a VM's V86 megabyte onto frames of its own, and
    // an INT 13h read the real-mode mapper asked for at 081b:xxxx was written to physical 81bxx —
    // someone else's page. VFAT then looked up VFD.VXD in a directory sector it never received, the
    // open failed with "access denied", and the boot stopped at "VFBACKUP could not load VFD.VXD".
    if (this.paged) {
      for (let i = 0; i < bytes.length;) {
        const a = (addr + i) >>> 0, n = Math.min(bytes.length - i, 0x1000 - (a & 0xfff));
        const t = this.xlat(a, true);
        if (t >= 0) {
          this.u8.set(bytes.subarray(i, i + n), t);
          if (this.codePage[a >>> PAGE_BITS]) this._dirty(a, n);
        }
        i += n;
      }
      return;
    }
    addr &= this.mask;
    this.u8.set(bytes, addr);
    const first = addr >>> PAGE_BITS, last = (addr + bytes.length - 1) >>> PAGE_BITS;
    for (let p = first; p <= last; p++) if (this.codePage[p]) { this._dirty(addr, bytes.length); break; }
  }

  /** Copy `len` bytes within RAM (memmove semantics), marking SMC if the destination lands on code
   *  pages. XMS AH=0Bh is the one bulk path that routinely swaps *code* overlays into conventional
   *  memory, so writing straight into `u8` there left stale compiled blocks live — the destination
   *  has to go through the same dirty check `blit` uses. Addresses are absolute (no A20 mask): XMS
   *  endpoints are already resolved to physical linear addresses above 1 MiB. */
  move(dst, src, len) {
    if (len <= 0) return;
    this.u8.copyWithin(dst, src, src + len);
    const first = dst >>> PAGE_BITS, last = (dst + len - 1) >>> PAGE_BITS;
    for (let p = first; p <= last; p++) if (this.codePage[p]) { this._dirty(dst, len); break; }
  }

  /** Read a CP437/byte string until a terminator (default '$', DOS-style). */
  readStr(addr, term = 0x24, max = 65535) {
    const out = [];
    for (let i = 0; i < max; i++) {
      const b = this.u8[(addr + i) & this.mask];
      if (b === term) break;
      out.push(b);
    }
    return out;
  }

  /** Read a NUL-terminated ASCIIZ string. */
  readCStr(addr, max = 65535) { return this.readStr(addr, 0, max); }
}

export { PAGE_BITS, PAGE_SIZE };
