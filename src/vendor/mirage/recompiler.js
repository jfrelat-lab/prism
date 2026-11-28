// recompiler.js — the dynamic x86→JavaScript compiler.
//
// It decodes one *basic block* (straight-line code up to the first control
// transfer) starting at a linear CS:IP, emits a JavaScript function body that
// mutates CPU state directly, compiles it with `new Function`, and caches it by
// (linear address, ip). The browser's own JIT then optimises the hot blocks —
// a two-tier JIT. Self-modifying code is handled by invalidating cached blocks
// whose page is written (see Memory.onCodeWrite).
//
// Generated code preamble aliases: r = reg file, m = memory, sb = segment bases.
// Every block ends by writing cpu.eip (and, on far transfers, the segments) and
// returning. The machine loop then fetches the next block.

import { CF, PF, AF, ZF, SF, DF, OF, IF, TF, CS, SS, DS, ES, FS, GS } from './cpu.js';
import { SSE, SSE_TABLE, VEX, XMM_SCRATCH } from './sse.js';
import { MMX, MMX_OPS, MM_SCRATCH, MM_ENTER, mmxInline, mmLoadPaged, mmStorePaged } from './mmx.js';

// Cap on basic-block length. Overridable because block boundaries are where IRQs are sampled, so
// moving them is how you measure what depends on that — see docs/notes/timing.md §3, where it showed only
// one golden of 43 is sensitive. Blocks average 2-3 instructions in practice; this cap is rarely hit.
const NOREALCHAIN = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOREALCHAIN);
const MAXOPS = (typeof process !== 'undefined' && process.env && +process.env.MIRAGE_MAXOPS) || 192;
const MM_PLACEHOLDER = '__MM__';  // replaced with the memory mask literal

// Debug kill switch: MIRAGE_NOFPUINLINE=1 falls back to the cpu.fpuMem/fpuReg runtime
// dispatch instead of emitting each x87 op inline. Browser-safe (no `process`).
const NOFPUINLINE = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOFPUINLINE);
// The emitted calls that may load the x87 control word: FLDCW, FLDENV, the memory fallback (FRSTOR,
// and every x87 memory form under MIRAGE_NOFPUINLINE), FNINIT (DB E3: op 219, /4, rm 3).
const PCWRITE = /cpu\.(fldcw|fldenv|fpuMem)\(|cpu\.fpuReg\(219,4,3\)/;
// MIRAGE_NOSTRIP=1 disables the dead-flag elimination (debug / differential gate).
import { resolveMemStrategy, memEmitters, memPrologue } from './mem-strategy.js';
import { describeRegion, recentBlocks, allZero } from './derail.js';
import { PageFault } from './memory.js';

// Which memory-dispatch emission to use; see mem-strategy.js. Default reproduces the previous
// emission character-for-character, so selecting it is provably a no-op.
const MEM_DEFAULT = resolveMemStrategy();

const NOSTRIP = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOSTRIP);
// The tier-2 region compiler fuses a hot block and its statically-reachable successors into one
// function (a switch-in-loop) so inter-block dispatch disappears on hot loops. It's byte-identical
// to tier-1 (golden + conformance + fuzz-region), but on real GAMES it has unresolved issues — a
// fused region can run unbounded work per slice (Cosmo's decompression hangs a single runSlice),
// Wolf3D runs ~5× slower, and Keen once derailed on a far-indirect pattern. So it stays a Node-only
// Wolf3D runs ~5× slower, and Keen once derailed on a far-indirect pattern.
//
// It is therefore OFF everywhere, opt-in via MIRAGE_TIER2=1 for perf work on it. It used to be ON
// by default in Node and off in the browser, which had a consequence worth spelling out: every
// headless perf number — tools/bench.js, the roadmap's targets — measured a configuration nobody
// ever ran. And the "unbounded work per slice" defect is not a corner case: intros/memories.com
// takes >300s for work tier-1 does in 8.5ms, a >30,000× cliff that made bench.js look hung.
// Turn it back on by default once regions carry an instruction budget and the game bugs are fixed.
const TIER2 = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_TIER2);
const NOREALSPEC = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOREALSPEC);
const NOFLATSPEC = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOFLATSPEC);
// MIRAGE_NOSELFLOOP=1: a block that branches back to itself returns to the dispatcher at each turn.
const NOSELFLOOP = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOSELFLOOP);
// MIRAGE_NOSIDEEXIT=1: every conditional branch ends its block, as before side exits.
const LAZYEIP = !(typeof process !== 'undefined' && process.env && process.env.MIRAGE_NOLAZYEIP);
const NOFXCACHE = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOFXCACHE);
const NOFOLLOW = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOFOLLOW);
const NOSIDEEXIT = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOSIDEEXIT);
// MIRAGE_NOSKIP=1: a short forward branch leaves its block as a side exit, as before skips.
const NOSKIP = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOSKIP);
// MIRAGE_NOMEMO=1: no translation memo across reset() (see _memoGet).
const NOMEMO = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOMEMO);
// The memo is bounded by the source it holds, as the code cache is: each entry keeps its compiled
// function, which V8 charges at about eight times the source. Bounded by count (200 000 blocks), it
// held 1.3 GB once paged blocks grew (followed jumps and calls, 2e0bb67): Linux 3.x, TinyCore and
// Windows ME then spent 99 % of their time in the garbage collector and guest time stood still.
const MEMO_BYTES = 32 << 20;
const EMPTY_LINES = [];   // shared placeholder for a block whose source is not retained
const T2_HOT = 64;         // promote a block to a region after this many executions
// The block directory: one slot per 4 KiB page of the 4 GiB linear space, dense from the start. Grown
// on demand, the array went to V8's dictionary elements as soon as a guest's pages were far apart
// (a Win32 program at 400000h, its DLLs at 7C800000h): every dispatch was a hash lookup.
// It is allocated once per bank and keeps the pages it was given (`used`), which reset() empties.
const pageDirectory = () => Object.assign(Array.from({ length: 1 << 20 }), { used: [] });
const clearDirectory = (dir) => { for (const p of dir.used) dir[p] = undefined; dir.used.length = 0; return dir; };
const T2_MAXBLK = 24;      // cap region size in blocks
const T2_MAXINS = 384;     // cap region size in instructions
// Opt-in: end the slice when the guest is found executing empty memory. Off by default because a
// derail is a diagnosis, not necessarily a fatal error, and changing the run loop for every program
// to serve a diagnostic would be the wrong trade.
const DERAIL_STOP = !!(typeof process !== 'undefined' && process.env && process.env.MIRAGE_DERAIL_STOP);
const T2_BLACKLIST = 3;    // stop re-forming a root after this many SMC evictions
// An immediate operand whose bytes have been rewritten this many times, each time evicting the block
// that held them, is read from memory at run time instead of being baked into the emitted code — see
// Recompiler.invalidate and translate's immX.
const SMC_HOT = 2;
// A page of code whose bytes keep being rewritten, opcodes and all — Heretic's R_DrawSpan writes a
// one-byte terminator into its unrolled loop at a different place for every span — is translated in
// short blocks once this many evictions have hit it: a write then throws away a few instructions,
// not the 400-byte block that ran through the whole loop.
const SMC_PAGE_HOT = 64, SMC_SHORT_OPS = 8;

// Abstract flag-liveness bit set (NOT the EFLAGS register layout) for the dead-flag pass:
// which of the 6 arithmetic flags an instruction defines / uses. Full ALU ops def all 6;
// INC/DEC def all-but-carry (they preserve CF).
const lC = 1, lP = 2, lA = 4, lZ = 8, lS = 16, lO = 32, lALL = 63, lNOC = lALL & ~lC;

// Condition code cc (0..15 = O NO B AE Z NZ BE A S NS P NP L GE LE G) as an inline
// boolean bit-test on cpu.flags — replaces the cpu.cond(cc) call. Shared by the block
// emitter (Jcc/SETcc) and the region compiler. sfNeOf = (SF != OF).
const _sfNeOf = `((cpu.flags>>>7^cpu.flags>>>11)&1)`;
function condExpr(cc) {
  switch (cc) {
    case 0x0: return `(cpu.flags&${OF})`;              case 0x1: return `!(cpu.flags&${OF})`;
    case 0x2: return `(cpu.flags&${CF})`;              case 0x3: return `!(cpu.flags&${CF})`;
    case 0x4: return `(cpu.flags&${ZF})`;              case 0x5: return `!(cpu.flags&${ZF})`;
    case 0x6: return `(cpu.flags&${CF | ZF})`;         case 0x7: return `!(cpu.flags&${CF | ZF})`;
    case 0x8: return `(cpu.flags&${SF})`;              case 0x9: return `!(cpu.flags&${SF})`;
    case 0xa: return `(cpu.flags&${PF})`;              case 0xb: return `!(cpu.flags&${PF})`;
    case 0xc: return _sfNeOf;                          case 0xd: return `!${_sfNeOf}`;
    case 0xe: return `((cpu.flags&${ZF})||${_sfNeOf})`; case 0xf: return `(!(cpu.flags&${ZF})&&!${_sfNeOf})`;
  }
}

/**
 * The address is LINEAR, and saying so matters: an address below 0x400 means the guest ran off into
 * the interrupt vector table, so the bytes are a vector pair and not code at all. Turbo Pascal jumps
 * to fffe:0002, runs past the 1 MB wrap and decodes IVT entry 0 (0f53:010c) as "0f 53" — an SSE
 * opcode that nothing in a 1989 program could have contained.
 */
// Current privilege level, as emitted source. In virtual-8086 mode CPL is 3 by definition and CS
// holds an 8086 value whose low two bits are 0, so `seg[CS] & 3` reads ring 0 there and every
// privileged instruction sails through — which is exactly how HLT, CLI and IN survived in V86.
const CPL_EXPR = `((cpu.flags&0x20000)?3:(cpu.seg[${CS}]&3))`;

/**
 * Does the guest own INT 6? An invalid-opcode fault is a real CPU service, and programs USE it: the
 * Windows 3.0 loader hooks INT 6 through DOS (`mov ax,2506h / int 21h`) and then deliberately
 * executes `0f a6` to identify the processor. Throwing there reported "unimplemented opcode 0x0f
 * 0xa6" for an opcode that is invalid on every CPU and is *meant* to fault.
 *
 * So: raise #UD when the guest has installed a handler, and keep throwing when it has not — an
 * unhandled #UD would otherwise re-raise forever and turn a precise diagnostic into "INT 06h looped".
 * Read at translate time, which is free; the guest installing its handler later is not a problem,
 * because when it had none we threw and no block was cached.
 *
 * WHICH TABLE depends on the mode, and reading the IVT while the guest is in protected mode meant
 * the answer was always "no": Windows 3.1's DOSX installs a #UD gate through DPMI (INT 31h AX=0203)
 * and then executes `0f ff` on purpose, and with the IVT still holding the BIOS we threw
 * "unimplemented opcode 0x0f 0xff" at a fault the guest had just asked for.
 */
function guestOwnsUD(mem, cpu) {
  if (cpu && cpu.udToGuest) return true;                   // MIRAGE-LINUX: the kernel makes it SIGILL
  if (!cpu || !(cpu.cr0 & 1)) return mem.r16(6 * 4 + 2) !== 0xf000;
  const idt = cpu.idtr;
  if (6 * 8 + 7 > idt.limit) return false;                 // no entry for vector 6 at all
  const a = ((idt.base >>> 0) + 6 * 8) >>> 0;
  // The processor reads the IDT as an implicit supervisor access (mem.sup), whatever the CPL. Read at
  // ring 3 as a user access, FreeNOS's IDT (a supervisor page) faulted: at TRANSLATE time, for a 0F
  // byte decoded past a side exit that never runs, a #PF the guest killed its process for. And the
  // translator must never fault the guest at all: an IDT it cannot read is a gate it cannot see.
  let access;
  mem.sup++;
  try { access = mem.r8(a + 5); } catch (e) { return false; } finally { mem.sup--; }
  if (!(access & 0x80)) return false;                      // P=0: the gate would fault on its own
  const type = access & 0x1f;                              // task, or 286/386 interrupt or trap gate
  return type === 0x05 || type === 0x06 || type === 0x07 || type === 0x0e || type === 0x0f;
}

function unimplemented(what, lin, mem, rec) {
  let msg = `mirage: unimplemented opcode 0x${what} at linear 0x${lin.toString(16)}`;
  const where = describeRegion(mem, lin, rec && rec.cpu);
  if (where) msg += ` — ${where}. Implementing the opcode would be the wrong fix`;
  const path = recentBlocks(rec);
  if (path) msg += `. Recent block starts (oldest first, the last is this one): ${path}`;
  return msg;
}

export class Recompiler {
  constructor(cpu) {
    this.cpu = cpu;
    // A block translated for flat segments found one no longer flat at its head: it goes, and the
    // dispatch translates the address again for the segments as they are now (see FLATSPEC).
    cpu.unflat = (lin) => {
      const pg = this.blockPages[lin >>> 12], b = pg && (pg[lin & 0xfff] || pg[(lin & 0xfff) | 0x1000]);
      if (b) this._evict(b, lin);
      cpu.smcSelf = 0;
    };
    this.mem = cpu.mem;
    this.MM = this.mem.mask;
    this.memStrategy = MEM_DEFAULT;   // switched to `paged` when the guest enables paging
    // Block lookup: a 2-level page array (blockPages[lin>>>12][lin&0xfff] -> block)
    // rather than a Map — pure integer indexing on the hot dispatch path, no hashing
    // (V8's Map always routes through FindOrderedHashMapEntry even for SMI keys).
    // Indexed by (lin & 0xfff) | (csD << 12): the same bytes decode differently under a 16-bit and a
    // 32-bit code segment, so a block is only valid for the CS.D it was translated with.
    this.curBlk = null;            // the block executing right now, for the self-modification guard
    // Where the last few blocks started, for the derail report. Written once per TRANSLATION — the
    // compile path, not the hot execution path — so a derail can say how the guest got there.
    // True when paging is on (the machine switches the memory strategy then). Linear addresses must
    // NOT be masked in that mode: A20 gates a PHYSICAL address line and the RAM-size wrap is physical
    // too, so applying either BEFORE the page walk truncates the guest's address space. Windows 3.0
    // runs its kernel at linear 0x80201b5e; with A20 closed we masked that to 0x1b5e and decoded
    // whatever sat in low memory — the block that faulted had ip0 0x80201b5e and linStart 0x1b5e.
    this.pagedMode = false;
    this.recentCs = new Int32Array(16).fill(-1);
    this.recentIp = new Int32Array(16);
    this.recentI = 0;
    this.blockPages = pageDirectory();   // page -> Array(8192) of block | undefined
    // The code cache is bounded by the SOURCE IT HAS EMITTED, not by its block count. A block keeps
    // a compiled Function and the text it was built from, and V8 charges roughly eight times the
    // source for the pair — so the cost is proportional to bytes, not to blocks. That distinction
    // is the whole point: a guest that derails into data compiles blocks that run to the MAXOPS cap
    // with no branch in them, ~60 KB of source each and half a megabyte of host heap apiece. Capping
    // the COUNT at 32,768 would still have allowed 16 GiB. Measured on healthy titles, the whole
    // cache holds 4.6 MB of source for Doom and 0.9 MB for Wolf3D, so 32 MB is ample headroom.
    //
    // At the ceiling the cache is dropped whole, which is what real JITs do when a code cache fills.
    // The cost is recompilation, and only for a guest already misbehaving.
    // Retain the emitted source only where it is read: the tier-2 region compiler splices it, and
    // tools/trace.js prints it. Both are off by default.
    this.keepSource = TIER2 || !!(typeof process !== 'undefined' && process.env && process.env.MIRAGE_KEEP_SRC);
    this.blockCount = 0;                  // live blocks, for reporting
    this.codeBytes = 0;                   // emitted source currently held
    // 16 MiB without paging (DOS: Doom holds 4.6 MB); 64 MiB under paging, set by reset() — a paged
    // OS keeps far more live code: Windows 98 held 38 MB at 100 guest seconds, and at 16 MiB it
    // flushed the whole cache 26 times there, 75% of its compiles re-translating identical bytes
    // (525k compiles -> 214k, 58 -> 53 s host, heap 983 -> 607 MB: the flushes left garbage).
    this.codeCapEnv = Number(typeof process !== 'undefined' && process.env && process.env.MIRAGE_CODE_CAP) || 0;
    this.codeCap = this.codeCapEnv || (16 << 20);
    this.pageBlocks = new Map();   // page -> Set(lin) — for SMC invalidation sweeps
    // Per-page block-coverage bounds [lo, hi) — the min linStart / max linEnd of any block
    // touching a page. A write outside a page's bound can overlap no block, so invalidate()
    // skips the whole scan (the hot case for demos that write a data buffer into a page that
    // also holds code, e.g. tube's pixel buffer). Bounds only grow (an eviction leaves them a
    // safe over-approximation), so a stale-wide bound just falls back to the full scan — never
    // a missed invalidation.
    // Two-level and typed, keyed like blockPages: pageBounds[p >>> 8] is an Int32Array(512)
    // holding (lo, hi) for 256 consecutive pages, allocated on demand so a 4 GiB address space
    // stays sparse. hi === 0 means no block has ever covered the page, which the same comparison
    // rejects, so the fast-out needs no separate emptiness test.
    this.pageBounds = [];
    this.pageCov = [];             // per code page, how many blocks cover each 16-byte chunk — see _cover
    this.heat = new Map();         // lin -> exec count (for the JIT heatmap)
    this.profiling = false;        // gate heat tracking off the hot path
    this.realChain = !NOREALCHAIN; // chained blocks without paging (translate): MIRAGE_NOREALCHAIN=1, or false here
    this.stats = { compiles: 0, exec: 0, invalidations: 0, t2compiles: 0, t2evicts: 0, flushes: 0, derailBlocks: 0, memoHits: 0 };
    // The translation memo: blocks kept across reset() under paging, by where they start and in what
    // mode, each with the bytes it was translated from. An exec drops the block cache (another program
    // at the same addresses), but the next exec of the SAME program finds its bytes again: make runs
    // cpp, cc1 and as once per source file, and each run translated gcc's compiler from nothing —
    // a quarter of the host time of building DOOM in MIRAGE-LINUX. A block is reused only where
    // memory holds exactly its bytes, in the mode it was translated for.
    this.memo = new Map();             // key -> [{ snap, tmpl }]
    this.memoBytes = 0; this.memoCap = MEMO_BYTES;   // the source the memo holds, and its bound
    this.epoch = 0;                // bumped by each CR3 load under paging; see _revalidate (ROADMAP D8)
    // Two block caches, paging on and paging off, swapped by switchPaging rather than dropped. A DPMI
    // host that pages (CWSDPMI) returns to real mode for every interrupt and DOS call: FreeDOS running
    // Kraptor or Liquid War toggled paging 2600 times a second, and each reset() made it translate
    // 128 000 blocks a second over again. A restored cache's blocks were not watched while it was put
    // away, so each is checked once against its bytes (snap) before it runs again.
    this.banks = [null, null];
    this.restoreEpoch = 0;         // blocks validated before this epoch must match their bytes again
    this.banksUsed = false;        // snapshots are taken only once a swap has happened
    this.derailReported = false;   // the message is worth saying once, not once per block
    this.t2evict = new Map();      // region root lin -> SMC-eviction count (for the blacklist)
    this.t2blacklist = new Set();  // roots that self-modify too much -> stay tier-1
    this.mem.onCodeWrite = (addr, len) => this.invalidate(addr, len);
    // Bytes that small writes keep rewriting inside translated code, and how often each did evict a
    // block. DOOM's R_DrawColumn takes its texture step as the immediate of `add ebp,imm32` and every
    // column rewrites it: each write evicted the block, and the next column translated it again —
    // 14 000 translations in 8 s of its demo, V8 compiling each one, four frames a second in Chrome.
    this.smcHits = new Map();
    this.smcPages = new Map();     // page -> evictions by writes, for SMC_PAGE_HOT
    this.cpu.invlpg = (lin) => this.invlpg(lin);
  }

  /** INVLPG: refresh the page's software-TLB entry and evict the blocks translated from it. */
  invlpg(lin) {
    const p = (lin >>> 0) >>> 12;
    this.mem.refreshPage(p);
    if (this.mem.codePage[p]) this.invalidate(p << 12 >>> 0, 4096);
  }

  /** The physical frame a linear address is mapped to now (-1: not present), without the
   *  protection check — a block is valid where its bytes are, whoever may run it. */
  _frame(lin) {
    const m = this.mem; m.sup++;
    try { return m.walk(lin >>> 0); } finally { m.sup--; }
  }

  /** A guarded block (guard != 0) that cannot run as the CPU is now: translated for real mode without
   *  limit guards and now in protected mode, or under the other x87 precision. */
  _unfit(blk) {
    const cpu = this.cpu;
    return ((blk.guard & 1) !== 0 && (cpu.cr0 & 1) !== 0 && !(cpu.flags & 0x20000))
      || ((blk.guard & 2) !== 0 && blk.fprec !== ((cpu.fcw & 0x300) === 0 ? 2 : 1));
  }
  /** A block translated before the last CR3 load (ROADMAP D8): still valid if its first and last
   *  pages map to the frames it was translated from. Bytes changed through the same linear pages are
   *  already caught by the SMC path; a REMAP is what a CR3 load can bring, and this is the check. */
  _revalidate(blk, lin) {
    const framesOk = blk.ph0 === -1 || (this._frame(blk.linStart) === blk.ph0 && this._frame(blk.linEnd - 1) === blk.ph1);
    let bytesOk = blk.epoch >= this.restoreEpoch;               // no swap since it was last checked
    if (framesOk && !bytesOk && blk.snap !== null) {
      const now = this._bytes(blk.linStart, blk.linEnd);
      bytesOk = now !== null && now.length === blk.snap.length && now.every((v, i) => v === blk.snap[i]);
    }
    // A block whose arithmetic has single precision folded in or out (fprec 1 or 2, see FPREC24) is
    // kept only under that precision.
    const precOk = blk.fprec === 0 || blk.fprec === ((this.cpu.fcw & 0x300) === 0 ? 2 : 1);
    if (framesOk && bytesOk && precOk) { blk.epoch = this.epoch; return true; }
    this._evict(blk, lin);
    this.stats.remaps = (this.stats.remaps || 0) + 1;
    return false;
  }

  /** Self-modifying-code: invalidate only the cached blocks whose byte range the
   *  write [addr, addr+len) actually overlaps — not the whole 4 KiB page. This is
   *  what keeps demos that stash variables in their code page (tube, darnit) from
   *  recompiling every block on every write. */
  invalidate(addr, len) {
    // `>>>`, not `>>`. A linear address at or above 2 GiB is negative as a signed int32, so a signed
    // shift gave a negative page number and the lookup missed every time — Windows 3.0 pages its
    // kernel in at linear 0x80006000 AFTER we have translated blocks there, and we kept running the
    // stale ones (a block decoded as `CD 20` where the memory now says `FF 15`).
    addr = addr >>> 0;
    const end = addr + len;
    this._smcLo = addr; this._smcHi = end;                   // what a chained block asks of a write into it
    for (let p = addr >>> 12; p <= (end - 1) >>> 12; p++) {
      // Bounds FIRST, and without touching pageBlocks. This is the fast-out and it must not pay
      // for the Map that only the scan below needs: tube calls this barrier 3 030 236 times per
      // 20 ticks and evicts nothing (docs/notes/timing.md §12b), so every one of those was reaching two
      // integer comparisons through a hash lookup.
      const grp = this.pageBounds[p >>> 8];
      if (grp === undefined) continue;                                       // no block on these 256 pages
      const b = (p & 0xff) << 1;
      if (end <= (grp[b] >>> 0) || addr >= (grp[b + 1] >>> 0)) continue;     // write outside all blocks on this page
      const cov = this.pageCov[p];
      if (cov !== undefined) {                                                // chunk-level fast-out
        const base = (p << 12) >>> 0, lo = Math.max(addr, base), hi = Math.min(end, base + 4096);
        let any = 0;
        for (let k = (lo - base) >>> 4, last = (hi - 1 - base) >>> 4; k <= last; k++) any |= cov[k];
        if (!any) continue;
      }
      const set = this.pageBlocks.get(p);
      if (!set) continue;
      for (const lin of set) {
        const pg = this.blockPages[lin >>> 12];
        const blk = pg !== undefined ? (pg[lin & 0xfff] || pg[(lin & 0xfff) | 0x1000]) : undefined;
        if (!blk) { set.delete(lin); continue; }              // stale entry
        if (blk.ranges) { if (blk.ranges.some(([s, e]) => s < end && addr < e)) this._evictRegion(blk, lin); }
        else if (blk.linStart < end && addr < blk.linEnd) {
          // A write that lands entirely in bytes this block reads at run time changes nothing it
          // compiled: keep it. Anything else evicts, and a small write is remembered byte by byte.
          if (blk.vol !== null && blk.vol.some(([s, e]) => addr >= s && end <= e)) continue;
          this._evict(blk, lin);
          // A chained block (translate, without paging) counts as the blocks it is made of: one eviction for
          // each piece the write lands in, as each piece was a block of its own before.
          // A piece counts if it has run (the block of its own would have been made then) and no block of
          // its own is cached at its start (that one counts for itself).
          const n = blk.pieces ? blk.pieces.filter(([s, e], i) => s < end && addr < e && (i === 0 || ((blk.ran >>> Math.min(30, i)) & 1) && !this._blockAt(s))).length : 1;
          if (n === 0) continue;
          this.smcPages.set(p, (this.smcPages.get(p) || 0) + n);
          if (len <= 4) {
            if (this.smcHits.size > 65536) this.smcHits.clear();
            for (let a = addr; a < end; a++) this.smcHits.set(a, (this.smcHits.get(a) || 0) + 1);
          }
        }
      }
      if (set.size === 0) this.mem.clearCodePage(p);            // page no longer holds code
    }
  }

  /** Count blocks covering page `p`'s 16-byte chunks over [s, e) — `delta` +1 on compile, -1 on
   *  eviction (never below 0; a block replaced in the cache without eviction leaves its count, which
   *  only makes the filter more conservative). invalidate() skips a write whose chunks all read 0
   *  before it scans the page's block set. The min/max bounds above are not enough once blocks
   *  survive CR3 loads (ROADMAP D8): spread over a page they cover nearly all of it, and every data
   *  write into a mixed code+data page scanned hundreds of blocks to evict none — 55% of Windows
   *  3.0's host time in its steady state. */
  _cover(p, s, e, delta) {
    const base = (p << 12) >>> 0;
    const lo = Math.max(s >>> 0, base), hi = Math.min(e > 0xffffffff ? 0xffffffff : e, base + 4096);
    if (hi <= lo) return;
    let cov = this.pageCov[p];
    if (cov === undefined) { if (delta < 0) return; cov = this.pageCov[p] = new Int32Array(256); }
    for (let k = (lo - base) >>> 4, last = (hi - 1 - base) >>> 4; k <= last; k++) {
      const v = cov[k] + delta; cov[k] = v < 0 ? 0 : v;
    }
  }

  /** Grow page `p`'s block-coverage bounds to include [s, e). Linear addresses at or above 2 GiB
   *  are negative as signed int32s (Windows 3.0 pages its kernel in at 0x80201b5e), so the stored
   *  bounds are read back unsigned on every comparison. */
  _bound(p, s, e) {
    // hi === 0 is the "page is empty" encoding, and a real block always has linEnd >= 1 — but only
    // once e is clamped, because an Int32Array stores 2**32 as 0 and the page would read back empty.
    if (e > 0xffffffff) e = 0xffffffff;
    let grp = this.pageBounds[p >>> 8];
    if (grp === undefined) grp = this.pageBounds[p >>> 8] = new Int32Array(512);
    const b = (p & 0xff) << 1;
    if ((grp[b + 1] >>> 0) === 0) { grp[b] = s; grp[b + 1] = e; return; }   // first block on this page
    if (s < (grp[b] >>> 0)) grp[b] = s;
    if (e > (grp[b + 1] >>> 0)) grp[b + 1] = e;
  }

  /** Whether a block of its own is cached at linear `lin` (either CS.D form). */
  _blockAt(lin) { const pg = this.blockPages[lin >>> 12]; return pg !== undefined && !!(pg[lin & 0xfff] || pg[(lin & 0xfff) | 0x1000]); }

  _evict(blk, lin) {
    if (blk === this.curBlk) { this.cpu.smcSelf = 1; this.cpu.smcLo = this._smcLo; this.cpu.smcHi = this._smcHi; }   // it is running RIGHT NOW — see the guard in translate
    const pg = this.blockPages[lin >>> 12];
    if (pg !== undefined) { pg[lin & 0xfff] = undefined; pg[(lin & 0xfff) | 0x1000] = undefined; }   // both CS.D variants
    this.heat.delete(lin);
    this.blockCount--;
    this.codeBytes -= blk.bodyLen || 0;
    this.stats.invalidations++;
    for (let p = blk.linStart >>> 12; p <= (blk.linEnd - 1) >>> 12; p++) {
      const s = this.pageBlocks.get(p); if (s) s.delete(lin);
      this._cover(p, blk.linStart, blk.linEnd, -1);
    }
  }

  reset() {
    // Tied to paging being ON, not to the strategy's NAME: the paged emitters can be selected by
    // hand in real mode (MIRAGE_MEM_READ=paged), and real mode still needs the 1 MiB wrap — that
    // wrap is what makes EXEPACK stubs' segment arithmetic work. Every paging transition calls
    // reset(), so this stays in sync.
    this.pagedMode = !!(this.cpu && this.cpu.pagingOn);
    if (!this.codeCapEnv) this.codeCap = this.pagedMode ? (64 << 20) : (16 << 20);
    this.blockPages = clearDirectory(this.blockPages); this.pageBlocks.clear(); this.heat.clear(); this.pageBounds = []; this.pageCov = []; this.t2evict.clear(); this.t2blacklist.clear();
    this.blockCount = 0; this.codeBytes = 0;
    if (this.banks) this.banks = [null, null]; }

  /** Paging went on or off: put the current block cache away and bring back the other one, instead of
   *  reset(). The restored blocks are revalidated against their bytes on their next dispatch. */
  switchPaging() {
    const now = !!(this.cpu && this.cpu.pagingOn);
    if (!this.banks) { this.reset(); return; }
    // No transition. Without paging (CWSDPMI loads CR3 before it turns paging on, every time) nothing
    // the blocks were built from has changed; under paging (a CR4 change) the mappings may have, which
    // is what a CR3 load does too: new epoch, frames rechecked on dispatch. Both used to reset().
    if (now === this.pagedMode) { if (now) this.epoch++; return; }
    this.banks[this.pagedMode ? 1 : 0] = { blockPages: this.blockPages, pageBlocks: this.pageBlocks, heat: this.heat,
      pageBounds: this.pageBounds, pageCov: this.pageCov, t2evict: this.t2evict, t2blacklist: this.t2blacklist,
      blockCount: this.blockCount, codeBytes: this.codeBytes };
    const b = this.banks[now ? 1 : 0];
    this.banks[now ? 1 : 0] = null;
    this.pagedMode = now;
    if (!this.codeCapEnv) this.codeCap = now ? (64 << 20) : (16 << 20);
    this.banksUsed = true;
    if (b) {
      this.blockPages = b.blockPages; this.pageBlocks = b.pageBlocks; this.heat = b.heat; this.pageBounds = b.pageBounds;
      this.pageCov = b.pageCov; this.t2evict = b.t2evict; this.t2blacklist = b.t2blacklist;
      this.blockCount = b.blockCount; this.codeBytes = b.codeBytes;
      for (const p of this.pageBlocks.keys()) this.mem.markCodePage(p);   // the other cache may have cleared them
      this.epoch++; this.restoreEpoch = this.epoch;
    } else {
      this.blockPages = pageDirectory(); this.pageBlocks = new Map(); this.heat = new Map(); this.pageBounds = []; this.pageCov = [];
      this.t2evict = new Map(); this.t2blacklist = new Set(); this.blockCount = 0; this.codeBytes = 0;
    }
  }

  /** The bytes of [s, e), as the guest sees them now; null if any of them cannot be read. */
  _bytes(s, e) {
    try { const out = new Uint8Array(e - s); for (let i = 0; i < out.length; i++) out[i] = this.mem.r8((s + i) >>> 0); return out; }
    catch { return null; }
  }

  // ===================== tier-2 region compiler =====================

  /** A hot block crossed T2_HOT: form a region rooted at it (the block plus its statically-
   *  reachable successors) and install one fused function in its place. Bails (staying tier-1)
   *  on a blacklisted root or a region too small to be worth it. */
  _promote(rootLin, rootIp0) {
    if (this.t2blacklist.has(rootLin)) return;
    // Derive the segment base from the ROOT's own identity, not the live cpu.base[CS]: the
    // root block may have just done a far transfer (CS changed) before this call, and using
    // the live base would walk successors in the wrong segment — pulling in blocks that merely
    // share the same IP offset (a CS:IP alias), whose fused code then derails the guest.
    const base = this.pagedMode ? ((rootLin - rootIp0) >>> 0) : ((rootLin - rootIp0) & this.MM);
    const byIp = new Map();     // ip -> tier-1 block (or null if unusable)
    const order = [];           // member ips, in discovery order
    const queue = [rootIp0];
    let ins = 0;
    while (queue.length && order.length < T2_MAXBLK && ins < T2_MAXINS) {
      const ip = queue.shift();
      if (byIp.has(ip)) continue;
      const blk = this._blockFor(this.pagedMode ? ((base + ip) >>> 0) : ((base + ip) & this.MM), ip);
      if (!blk || blk.kind !== 0 || blk.canFault) { byIp.set(ip, null); continue; }   // absent/aliased/region/faulting → not a member
      byIp.set(ip, blk); order.push(ip); ins += blk.count;
      const t = blk.term;
      if (t.k === 'jmp') queue.push(t.t);
      else if (t.k === 'jcc' || t.k === 'loop' || t.k === 'jcxz') { queue.push(t.t, t.n); }
    }
    if (order.length < 2) return;   // one block fuses nothing — leave it tier-1
    this._installRegion(this._emitRegion(order, byIp, rootLin, rootIp0), rootLin);
  }

  /** Cached tier-1 block at (lin, ip0), compiling if absent; null if it's a region or the
   *  ip0 doesn't match (a CS:IP alias — can't be a region member). */
  _blockFor(lin, ip0) {
    const pg = this.blockPages[lin >>> 12];
    let blk = pg !== undefined ? pg[(lin & 0xfff) | (this.cpu.csD << 12)] : undefined;
    if (blk === undefined) blk = this._compile(lin, ip0);
    return blk.kind === 0 && blk.ip0 === ip0 ? blk : null;
  }

  /** Emit the fused region function: a `switch(_e)` over the member ips inside a `for(;;)`.
   *  An in-region edge is a local `_e=T;break` (re-dispatches the switch); an out-of-region
   *  edge (or an exit terminator) flushes retired-instruction count into cpu.cycles and
   *  returns. `_n` accumulates retired instructions; cpu.tbudget bounds a runaway loop. */
  _emitRegion(order, byIp, rootLin, rootIp0) {
    const members = new Set(order);
    let usesFPU = false, fprec = 0;
    const ranges = [];
    // Budget: check-then-decrement, matching run()'s tier-1 loop (run B blocks for budget B),
    // so a region and tier-1 stop at exactly the same block boundary — same slice boundary,
    // same interrupt timing. cpu.cycles is bumped once per block AFTER its body (as tier-1's
    // run() does), so an in-block RDTSC reads the same count as tier-1. Byte-identical output.
    // `R.dead` is set by _evictRegion when a write invalidates this region mid-flight (SMC);
    // the guard stops the stale in-flight execution at the next iteration, bounding staleness
    // to one block like tier-1 (whose current block.fn also finishes after an eviction).
    // Safepoint: bail on the slice budget, or when a PIT tick is due AND interrupts are enabled.
    // The `&IF` is essential: run() only delivers the timer (and advances the deadline) with IF
    // set. Bailing on the deadline while IF is clear would return WITHOUT decrementing tbudget and
    // without run() being able to advance the deadline → an infinite no-progress bail loop (a game
    // running a hot loop under CLI past a due tick). With IF clear we keep running, bounded by
    // tbudget; the pending tick is delivered once the guest re-enables interrupts.
    const out = [`var _e=${rootIp0},dl=cpu.deadline;`, 'for(;;){', 'if(R.dead){cpu.eip=_e;return;}',
      `if(cpu.tbudget<=0||(cpu.cycles>=dl&&(cpu.flags&${IF}))){cpu.eip=_e;return;}`, 'cpu.tbudget--;', 'switch(_e){'];
    for (const ip of order) {
      const b = byIp.get(ip);
      if (b.usesFPU) usesFPU = true;
      if (b.fprec) fprec = b.fprec;
      ranges.push([b.linStart, b.linEnd]);
      out.push(`case ${ip}:{`);
      if (b.term.k === 'exit') out.push(`cpu.cycles+=${b.count};`, b.bodyOut.join('\n'), 'return;');
      else out.push(b.bodyOut.join('\n'), `cpu.cycles+=${b.count};`, this._edgeCode(b.term, members));
      out.push('}');
    }
    out.push('default:cpu.eip=_e;return;', '}}');
    const pre = 'var r=cpu.reg,m=cpu.mem,sb=cpu.base,u8=m.u8,cp=m.codePage;' + memPrologue(this.memStrategy) + (usesFPU ? 'var st=cpu.fst,dv=m.dv,oc=cpu.focc;' : '');
    const body = pre + '\n' + out.join('\n');
    return { fn: new Function('cpu', 'R', body), kind: 2, ip0: rootIp0, count: 0, hot: -1, dead: 0, linStart: rootLin, linEnd: rootLin + 1, ranges, body, epoch: 0, ph0: -1, ph1: -1, real: 0, vol: null, snap: null, fprec, guard: fprec ? 2 : 0 };
  }

  /** The region-internal edge for a static terminator: an in-region target is a local jump
   *  (`_e=T;break`); an out-of-region target flushes cycles and returns to the dispatch loop. */
  _edgeCode(term, members) {
    const go = (ip) => members.has(ip) ? `_e=${ip};break;` : `cpu.eip=${ip};return;`;
    if (term.k === 'jmp') return go(term.t);
    const cond = term.k === 'jcc' ? condExpr(term.cc)
      : term.k === 'jcxz' ? (term.a32 ? '((r[1]>>>0)===0)' : '((r[1]&0xffff)===0)')
        : term.v === 0xe0 ? `((${term.a32 ? '(r[1]>>>0)' : '(r[1]&0xffff)'})!==0&&!(cpu.flags&${ZF}))`
          : term.v === 0xe1 ? `((${term.a32 ? '(r[1]>>>0)' : '(r[1]&0xffff)'})!==0&&(cpu.flags&${ZF}))`
            : `((${term.a32 ? '(r[1]>>>0)' : '(r[1]&0xffff)'})!==0)`;
    return `if(${cond}){${go(term.t)}}else{${go(term.n)}}`;
  }

  _installRegion(region, rootLin) {
    const pg = rootLin >>> 12;
    let page = this.blockPages[pg]; if (page === undefined) { page = this.blockPages[pg] = new Array(8192); this.blockPages.used.push(pg); }
    page[(rootLin & 0xfff) | (this.cpu.csD << 12)] = region;    // replace the root's tier-1 block; constituents stay tier-1
    const pages = new Set();
    for (const [s, e] of region.ranges) for (let p = s >>> 12; p <= (e - 1) >>> 12; p++) pages.add(p);
    for (const p of pages) {
      this.mem.markCodePage(p);
      let set = this.pageBlocks.get(p); if (!set) { set = new Set(); this.pageBlocks.set(p, set); }
      set.add(rootLin);
      for (const [s, e] of region.ranges) { this._bound(p, s, e); this._cover(p, s, e, 1); }
    }
    this.stats.t2compiles++;
  }

  _evictRegion(region, rootLin) {
    if (region === this.curBlk) this.cpu.smcSelf = 1;
    region.dead = 1;   // stop any in-flight execution of this region at its next iteration
    const pg = this.blockPages[rootLin >>> 12];
    if (pg !== undefined) { pg[rootLin & 0xfff] = undefined; pg[(rootLin & 0xfff) | 0x1000] = undefined; }
    this.stats.invalidations++; this.stats.t2evicts++;
    const pages = new Set();
    for (const [s, e] of region.ranges) for (let p = s >>> 12; p <= (e - 1) >>> 12; p++) pages.add(p);
    for (const p of pages) { const set = this.pageBlocks.get(p); if (set) set.delete(rootLin); }
    const c = (this.t2evict.get(rootLin) || 0) + 1; this.t2evict.set(rootLin, c);
    if (c >= T2_BLACKLIST) this.t2blacklist.add(rootLin);   // self-modifying loop → give up, stay tier-1
  }

  /** Run exactly one basic block from the current CS:IP. Returns its length. */
  step() {
    const cpu = this.cpu;
    // A 32-bit code segment has a 32-bit EIP. Truncating it to 16 bits unconditionally — as all
    // three dispatch sites did — silently discards the high half: test386 jumps to its paged alias
    // 0xE00F4F6D, we dispatched 0x4F6D, decoded zeroed RAM there and walked memory until the IDT.
    // `ipAdd` inside translate has been width-aware all along; only entry was not.
    const ip0 = cpu.csD ? (cpu.eip >>> 0) : (cpu.eip & 0xffff);
    const lin = this.pagedMode ? ((cpu.base[CS] + ip0) >>> 0) : ((cpu.base[CS] + ip0) & this.MM);
    // O(1) array index, no hashing. blk.ip0 guards the rare case of one linear addr
    // reached via different CS:IP (the emitted jump targets bake in ip0).
    const page = this.blockPages[lin >>> 12];
    let blk = page !== undefined ? page[(lin & 0xfff) | (this.cpu.csD << 12)] : undefined;
    if (blk === undefined || blk.ip0 !== ip0 || (blk.guard !== 0 && this._unfit(blk))) blk = this._compile(lin, ip0);
    if (this.profiling) this.heat.set(lin, (this.heat.get(lin) || 0) + 1);
    this.stats.exec++;
    cpu.tbudget = 1 << 20;   // a region (if one is installed) self-bounds against this
    this.curBlk = blk;
    blk.fn(cpu, blk);
    cpu.cycles += blk.count;
    return blk.count;
  }

  /** The opcode of a software interrupt (INT3 0xCC, INT n 0xCD, INTO 0xCE) at `lin`, past any
   *  prefixes; 0 for any other instruction. Used only on the single-step path. */
  _softIntOp(lin) {
    const mem = this.mem, paged = this.pagedMode, MM = this.MM;
    for (let i = 0; i < 15; i++) {
      const b = mem.r8(paged ? (lin + i) >>> 0 : (lin + i) & MM);
      if (b === 0x26 || b === 0x2e || b === 0x36 || b === 0x3e || b === 0x64 || b === 0x65 ||
          b === 0x66 || b === 0x67 || b === 0xf0 || b === 0xf2 || b === 0xf3) continue;
      return b === 0xcc || b === 0xcd || b === 0xce ? b : 0;
    }
    return 0;
  }

  /** Fused dispatch loop: run up to maxBlocks blocks with the try/catch
   *  hoisted out of the per-block path and stats.exec accumulated once — this is the
   *  hot loop (puls was ~20% here). halted/blocked are still checked every iteration:
   *  an INT handler inside blk.fn can set machine.blocked via machine.block(), and it
   *  must be honoured before the next block dispatches (same order as the old loop).
   *  step() stays for single-block callers (tests, conformance stepOne is separate). */
  run(machine, maxBlocks) {
    this._machine = machine;                             // for _checkDerail's report channel
    const cpu = this.cpu, MM = this.MM, pages = this.blockPages, prof = this.profiling;
    const paged = this.pagedMode;
    // One shared block-execution budget: a tier-1 block costs 1, and a region decrements it
    // once per internal iteration (so a fused loop can't outrun the slice or hang the host).
    cpu.tbudget = maxBlocks;
    // A tier-2 region runs its loop internally without re-entering this dispatch loop, so it must
    // bail when a PIT tick comes due (else a timer-delay loop promoted to a region spins forever,
    // never letting INT 8 advance the counter it waits on). cpu.deadline is that bail threshold.
    cpu.deadline = machine.timerAuto ? machine.nextTimerCycle : Infinity;
    machine.rearm();
    let n = 0;
    try {
      while (cpu.tbudget > 0 && !cpu.halted && !machine.blocked) {
        if (cpu.flags & IF) {                                                    // interrupts unmasked: service pending devices
          if (machine.hwIrqPending) machine.serviceHwInts();                     // queued keyboard IRQ
          // The next PIT tick or device event (the Sound Blaster's end of block), whichever is first:
          // one comparison per block for both, as there was one for the timer alone.
          if (cpu.cycles >= machine.nextEvent) machine.serviceEvents();
        }
        const ip0 = cpu.csD ? (cpu.eip >>> 0) : (cpu.eip & 0xffff);
        const lin = paged ? ((cpu.base[CS] + ip0) >>> 0) : ((cpu.base[CS] + ip0) & MM);
        // Trap Flag (hardware single-step): when TF is set, run exactly ONE instruction and
        // then fire INT 1. Uncached — each trapped instruction is freshly decoded, so a
        // self-modifying tracer (copy-protection decrypting code one step at a time inside
        // its INT-1 handler, e.g. Lemmings) sees the just-written bytes. swInt(1) clears TF
        // for the handler; its IRET restores TF and traps the next instruction in turn.
        // A REP string instruction counts as one instruction here, as DOSBox-X counts it; QEMU traps
        // after every iteration instead (tools/reptrap.asm: 6 traps against 11), so it is left alone.
        // INT n, INT3 and an INTO that interrupts are NOT followed by a trap: they clear TF on the way
        // into the handler, which runs untraced, and its IRET restores TF without trapping either —
        // the next trap comes after the instruction that follows the INT (tools/inttrap.asm, DOSBox-X:
        // TRAPS=09). Trapping anyway entered INT 1 a second time at the handler's first instruction,
        // with TF clear in the frame it pushed. Second Reality's loader is a scheduler driven by INT 1
        // whose threads also execute `int 1` themselves: the extra trap saved one thread with TF off,
        // that thread ran into the loader's anti-debug path, and it wiped the IVT (0000:0000).
        if (cpu.flags & TF) {
          const blk = this.translate(lin, ip0, 1);
          const op = this._softIntOp(lin);           // read before it runs: it may rewrite itself
          this.curBlk = blk;
          blk.fn(cpu, blk);
          cpu.cycles += blk.count;
          cpu.tbudget--; n++;
          if (op === 0 || (op === 0xce && !(cpu.flags & OF))) machine.swInt(1);
          continue;
        }
        const page = pages[lin >>> 12];
        let blk = page !== undefined ? page[(lin & 0xfff) | (cpu.csD << 12)] : undefined;
        // A block translated without limit guards (`real`, see translate) must not run in protected mode.
        // ...nor, translated under one x87 precision, under the other (fprec, see FPREC24): its
        // arithmetic is rounded for it. Only such blocks pay the test; the memo makes the switch cheap.
        // One field (guard) says whether a block has either condition, so the others pay one test.
        if (blk === undefined || blk.ip0 !== ip0 || (blk.guard !== 0 && this._unfit(blk))) blk = this._compile(lin, ip0);
        else if (blk.epoch !== this.epoch && !this._revalidate(blk, lin)) blk = this._compile(lin, ip0);
        if (prof) this.heat.set(lin, (this.heat.get(lin) || 0) + 1);
        this.curBlk = blk;
        blk.fn(cpu, blk);
        cpu.cycles += blk.count;
        if (blk.kind === 0) { cpu.tbudget--; if (TIER2 && ++blk.hot === T2_HOT) this._promote(lin, ip0); }
        n++;
      }
    } catch (e) {
      this.stats.exec += n;
      if (e instanceof PageFault) {
        // CR2 holds the address that faulted; the error code's bit 0 is "page was present", which a
        // not-present fault leaves clear, bit 1 is write, bit 2 is user mode. EIP already points at
        // the faulting instruction — the per-instruction store above put it there.
        cpu.cr2 = e.lin;
        try {
          machine.protInt(14, (e.present ? 1 : 0) | (e.write ? 2 : 0) | (cpu.cpl === 3 ? 4 : 0));
        } catch (e2) {
          // A fault while DELIVERING a fault is a double fault on real hardware. We do not model
          // #DF, but it must not reach the host as a JS exception either: report it, with the two
          // addresses, because the second one is what actually needs explaining.
          if (!(e2 instanceof PageFault)) throw e2;
          const msg = `mirage: #PF at linear 0x${e.lin.toString(16)} could not be delivered — the ` +
            `delivery itself faulted at linear 0x${e2.lin.toString(16)} (a double fault). ` +
            `TR=0x${cpu.tr.sel.toString(16)} GDT=0x${(cpu.gdtr.base >>> 0).toString(16)}/` +
            `0x${cpu.gdtr.limit.toString(16)} IDT=0x${(cpu.idtr.base >>> 0).toString(16)}`;
          if (machine.onError) { machine.onError(new Error(msg)); return n; }
          throw new Error(msg);
        }
        return n;                        // the slice ends here; the next one starts in the handler
      }
      if (machine.onError) { machine.onError(e); return n; }
      throw e;
    }
    this.stats.exec += n;
    return n;
  }

  /** Change the address mask (A20). `run` hoists MM into a local ONCE PER SLICE — it sits on the
   *  dispatch path — so flipping it mid-slice left every remaining block of that slice compiled and
   *  looked up at the OLD wrap. Up to 200,000 blocks in one go: DOS/4GW relocates itself to 13 MiB
   *  right after enabling A20, and DOOM was decoding it from the 1 MiB alias, which is data. Same
   *  hazard, and the same remedy, as onPagingChange: drop the cache AND end the slice.
   */
  setMask(mask) {
    if (this.MM === mask) return;
    this.MM = mask;
    this.reset();
    this.cpu.tbudget = 0;
  }

  /**
   * Say it the moment it happens: the guest is executing empty memory.
   *
   * src/derail.js could already NAME this ("in a run of zero bytes"), but it only ever ran while
   * reporting a fault — and a guest walking through zeros never faults. It just gets slow, which
   * reads as a hang: Windows 3.0's `win /r` crawled for 25 minutes at ~1400 blocks/s and looked
   * blocked. It was not blocked. It was compiling 192-instruction blocks of `add [bx+si],al` into
   * 63 KB of JavaScript each, exhausting the code cap every ~300 blocks and recompiling everything,
   * 1.6 GB of emitted source in 40000 blocks.
   *
   * Reporting only, by default. Stopping the run would change behaviour for every program, and a
   * derail is not always fatal — MIRAGE_DERAIL_STOP=1 ends the slice for tools that want it.
   */
  _checkDerail(lin, blk) {
    if (!allZero(this.mem, lin)) return;                 // long, but real code: nothing to say
    this.stats.derailBlocks++;
    let msgForThrow = 'mirage: DERAILED — the guest is executing empty memory';
    if (!this.derailReported) {
      this.derailReported = true;
      const cpu = this.cpu;
      const where = `${(cpu.seg[CS] >>> 0).toString(16).padStart(4, '0')}:` +
        `${(blk.ip0 >>> 0).toString(16)} (linear ${(lin >>> 0).toString(16)})`;
      const trail = recentBlocks(this) || '(no trail)';
      const msg = `mirage: DERAILED — ${where}: ${describeRegion(this.mem, lin, cpu)}. ` +
        `A ${blk.count}-instruction block, ${blk.bodyLen || 0} bytes of emitted source. ` +
        `How it got here: ${trail}`;
      msgForThrow = msg;
      if (this._machine && this._machine.onDerail) this._machine.onDerail(msg, { lin, blk, cpu });
      else if (typeof console !== 'undefined') console.warn(msg);
    }
    // Opt-in stop. Ending the slice (cpu.tbudget = 0) is NOT enough — every runner loops on
    // runSlice, so it just starts another one; the first version of this flag did nothing at all.
    // Throwing routes the derail through the engine's existing failure channel instead, so `run`
    // hands it to machine.onError and every tool that already stops on a fault stops on this.
    if (DERAIL_STOP) throw new Error(msgForThrow);
  }

  _compile(lin, ip0) {
    // At the ceiling, drop the cache and end the slice. `run` hoists blockPages into a local once
    // per slice, so a flush mid-slice would leave it holding the old array — the same hazard the
    // address mask has, and the same remedy.
    if (this.codeBytes >= this.codeCap) {
      this.reset();
      this.stats.flushes++;
      if (this.cpu) this.cpu.tbudget = 0;
    }
    const memoKey = this.pagedMode && !NOMEMO && !TIER2 ? this._memoKey(lin, ip0) : null;
    let blk = memoKey !== null ? this._memoGet(memoKey) : null;
    if (blk === null) {
      this._udSeen = false;
      blk = this.translate(lin, ip0);
      if (memoKey !== null && !blk.vol && !this._udSeen) this._memoPut(memoKey, blk);
    }
    blk.epoch = this.epoch;
    if (this.pagedMode) { blk.ph0 = this._frame(blk.linStart); blk.ph1 = this._frame(blk.linEnd - 1); }
    if (this.banksUsed) blk.snap = this._bytes(blk.linStart, blk.linEnd);
    // A block this long was produced by bytes that never branch, and the commonest such byte is 0x00
    // (`add [bx+si],al`). That is the shape of a guest walking through empty memory — see the check
    // below, which costs nothing until a block is already abnormally long.
    if (blk.count >= 64) this._checkDerail(lin, blk);
    const pg = lin >>> 12;
    let page = this.blockPages[pg];
    if (page === undefined) { page = this.blockPages[pg] = new Array(8192); this.blockPages.used.push(pg); }
    page[(lin & 0xfff) | (this.cpu.csD << 12)] = blk;
    const first = blk.linStart >>> 12, last = (blk.linEnd - 1) >>> 12;
    for (let p = first; p <= last; p++) {
      this.mem.markCodePage(p);
      let s = this.pageBlocks.get(p);
      if (!s) { s = new Set(); this.pageBlocks.set(p, s); }
      s.add(lin);
      this._bound(p, blk.linStart, blk.linEnd);
      this._cover(p, blk.linStart, blk.linEnd, 1);
    }
    this.blockCount++;
    this.codeBytes += blk.bodyLen || 0;
    this.stats.compiles++;
    return blk;
  }

  /** What a translation depends on besides its bytes: where it starts, the code size, real/V86 or
   *  not, x87 precision, the self-modifying page cap (see translate). */
  _memoKey(lin, ip0) {
    const cpu = this.cpu;
    const real = !TIER2 && !NOREALSPEC && (!(cpu.cr0 & 1) || (cpu.flags & 0x20000) !== 0) ? 1 : 0;
    const smc = (this.smcPages.get(lin >>> 12) || 0) >= SMC_PAGE_HOT ? 1 : 0;
    let flat = 0;                                  // which segments a block may take as flat (FLATSPEC)
    for (let i = 0; i < 6; i++) if (cpu.limit[i] === 0xffffffff && cpu.limLo[i] === 0) flat |= 1 << i;
    return lin + ':' + ip0 + ':' + cpu.csD + ':' + real + ':' + ((cpu.fcw & 0x300) === 0 ? 1 : 0) + ':' + smc + ':' + flat;
  }
  _memoGet(key) {
    const list = this.memo.get(key);
    if (list === undefined) return null;
    for (const { snap, tmpl } of list) {
      const now = this._bytes(tmpl.linStart, tmpl.linEnd);
      if (now === null || now.length !== snap.length) continue;
      let same = true;
      for (let i = 0; i < snap.length; i++) if (now[i] !== snap[i]) { same = false; break; }
      if (!same) continue;
      this.stats.memoHits++;
      return { ...tmpl, hot: 0, epoch: 0, ph0: -1, ph1: -1, snap: null };   // the same shape as translate's
    }
    return null;
  }
  _memoPut(key, blk) {
    const snap = this._bytes(blk.linStart, blk.linEnd);
    if (snap === null) return;
    let list = this.memo.get(key);
    if (list === undefined) { list = []; this.memo.set(key, list); }
    if (list.length >= 4) this.memoBytes -= list.shift().tmpl.bodyLen || 0;   // a few programs at the same address (cpp, cc1, as)
    list.push({ snap, tmpl: { ...blk, hot: 0, epoch: 0, ph0: -1, ph1: -1, snap: null } });
    this.memoBytes += blk.bodyLen || 0;
    for (const [k, l] of this.memo) {               // the oldest keys go first, until the source fits
      if (this.memoBytes <= this.memoCap || k === key) break;
      for (const e of l) this.memoBytes -= e.tmpl.bodyLen || 0;
      this.memo.delete(k);
    }
  }

  /** Execute exactly one instruction, uncached — used by the conformance harness
   *  and the (future) step debugger. Does not pollute the block cache. */
  stepOne() {
    const cpu = this.cpu;
    const ip0 = cpu.csD ? (cpu.eip >>> 0) : (cpu.eip & 0xffff);
    const lin = this.pagedMode ? ((cpu.base[CS] + ip0) >>> 0) : ((cpu.base[CS] + ip0) & this.MM);
    const blk = this.translate(lin, ip0, 1);
    this.curBlk = blk;
    blk.fn(cpu);
    cpu.cycles += blk.count;
    return blk;
  }

  // -------------------------------------------------------------------------
  translate(linStart, ip0, maxOps = MAXOPS, d = this.cpu.csD, checked = false, noSkip = false) {
    const mem = this.mem, MM = this.MM;
    if ((this.smcPages.get(linStart >>> 12) || 0) >= SMC_PAGE_HOT && maxOps > SMC_SHORT_OPS) maxOps = SMC_SHORT_OPS;
    const rec = this;                    // the decoders below are nested closures, where `this` is not us
    const pfRestart = this.pagedMode;
    // Address masking, in one place. Under paging there is no mask — and `& 0xffffffff` is not one,
    // since JS `&` yields a signed int32 and every address above 2 GiB would come out negative.
    const AM = pfRestart ? ((e) => `((${e})>>>0)`) : ((e) => `((${e})&${MM})`);
    const mask = pfRestart ? ((x) => x >>> 0) : ((x) => x & MM);
    { const k = this.recentI; this.recentCs[k] = this.cpu.seg[CS]; this.recentIp[k] = ip0; this.recentI = (k + 1) % 16; }
    // The CPU generation, read once per block. Every use below is a compile-time constant folded
    // into the emitted JS, so a profile costs nothing at run time — see src/cpu-profile.js.
    const PROF = this.cpu.profile, SHIFT_MASK = PROF.shiftCountMask;
    // MIRAGE_SEGIP=1 makes every segment load record the IP of the instruction doing it, so an
    // exception can NAME the instruction that raised instead of the block it was in. Off by default:
    // this is a store on a hot path, and the point is that the default emission is byte-identical.
    // Diagnostic only — it does not touch cpu.eip, the exception frame, or control flow, unlike the
    // setSegChecked attempt that cost golden 19/22 and drove test386 from POST 0x20 back to 0x09.
    const SEGIP = typeof process !== 'undefined' && process.env && process.env.MIRAGE_SEGIP
      ? (ipStart) => `cpu._segIp=${ipStart};` : () => '';
    const FPREC24 = (this.cpu.fcw & 0x300) === 0;   // x87 precision control = single (see arithE)
    let pcDep = false;                               // the block's arithmetic depends on it (arithE)
    // A block translated in real or virtual-8086 mode carries no segment-limit guards: every one of
    // them is `(...)&&(cpu.cr0&1)&&!(cpu.flags&VM)`, false in both modes, so it was dead code that
    // still computed the offset and loaded two limits on every memory access. The block is marked
    // `real`, and the dispatch loop retranslates it if it is ever reached with PE set and VM clear.
    // A block whose LMSW may set PE part-way through is translated checked instead (see `checked`).
    // Not under tier 2, whose regions run member blocks without passing through that dispatch check.
    // MIRAGE_NOREALSPEC=1 turns it off.
    const REAL = !checked && !TIER2 && !NOREALSPEC && (!(this.cpu.cr0 & 1) || (this.cpu.flags & 0x20000) !== 0);
    let needChecked = false;
    // Shared by LDS/LES/LSS/LFS/LGS: an offset at the effective address, then a 16-bit selector.
    // Its position depends on the operand size — +2 for a word offset, +4 for a dword.
    // In protected mode the selector load can FAULT, and then it has to end the block with EIP at this
    // instruction and the register untouched, as MOV Sreg does — the handler restarts it. Borland
    // RTM (Jazz Jackrabbit) loads its segments on #NP: `les di,[bp+6]` with a not-present selector
    // went to the handler, which was then overwritten by the rest of the block running on, and the
    // client returned through the exception frame. Both halves are read first, so `les bx,[bx]`
    // takes its selector from the address it was given. A real-mode block cannot fault here.
    const loadPtr = (o, segIdx, size) => {
      const a = memAddr(o);
      const off = size === 16 ? `m.r16(${a})` : `m.r32(${a})>>>0`, sel = `m.r16(${AM(`${a}+${size === 16 ? 2 : 4}`)})`;
      if (REAL) return `${rW(o.reg, size, off)}cpu.setSeg(${segIdx},${sel});`;
      canFault = true;
      return `{const _po=${off},_ps=${sel};cpu.eip=${curIpStart};if(cpu.setSeg(${segIdx},_ps)===false)return;${rW(o.reg, size, '_po')}}`;
    };
    // BIOS service entry (f000:00..ff). Reached when a guest calls the ISR *inline* — reads the
    // vector from the IVT and far-JMP/CALLs f000:n instead of executing `INT n` (Secret Agent's
    // video probe does this: LDS BX,[0:40]; …; RETF into f000:10). The stub byte is 0xCF (IRET),
    // so a bare chain still no-ops; but here we run the JS handler first, then IRET, so an inline
    // BIOS call actually performs its service. Single-instruction "block".
    // The DPMI host's far-callable entries. The guard is on the LINEAR address, so one stub serves
    // both modes — which is what a raw mode-switch routine has to be.
    if (linStart >= 0xf0600 && linStart < 0xf0610 && mem.u8[linStart] === 0xcb) {
      // A 0303 callback: one guarded byte each, so the address says which one fired.
      const idx = linStart - 0xf0600;
      const fn = new Function('cpu', `cpu.dpmiCallback(${idx});`);
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: 'dpmi-cb', term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0, epoch: 0, ph0: -1, ph1: -1, real: 0, vol: null, snap: null, fprec: 0, guard: 0 };
    }
    if (linStart === 0xf0250 && mem.u8[linStart] === 0xcb) {
      // Where a client's DPMI exception handler RETFs back to: restore the frame it leaves behind.
      const fn = new Function('cpu', 'cpu.dpmiExcReturn();');
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: 'dpmi-excret', term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0, epoch: 0, ph0: -1, ph1: -1, real: 0, vol: null, snap: null, fprec: 0, guard: 0 };
    }
    if (linStart === 0xf0260 && mem.u8[linStart] === 0xcf) {
      // Where a client's PM hardware-interrupt handler IRETs to: off the host's locked stack.
      const fn = new Function('cpu', 'cpu.dpmiIrqReturn();');
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: 'dpmi-irqret', term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0, epoch: 0, ph0: -1, ph1: -1, real: 0, vol: null, snap: null, fprec: 0, guard: 0 };
    }
    if (linStart === 0xf0240 && mem.u8[linStart] === 0xcb) {
      // Where a 0302 procedure's IRET lands: reaching it means the call is over.
      const fn = new Function('cpu', 'cpu.dpmiRealCallReturn();');
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: 'dpmi-rmret', term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0, epoch: 0, ph0: -1, ph1: -1, real: 0, vol: null, snap: null, fprec: 0, guard: 0 };
    }
    if ((linStart === 0xf0220 || linStart === 0xf0230) && mem.u8[linStart] === 0xcb) {
      const to = linStart === 0xf0220 ? 1 : 0;
      const fn = new Function('cpu', `cpu.dpmiRawSwitch(${to});`);
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: 'dpmi-raw', term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0, epoch: 0, ph0: -1, ph1: -1, real: 0, vol: null, snap: null, fprec: 0, guard: 0 };
    }
    if (linStart === 0xf0200 && mem.u8[0xf0200] === 0xcb) {
      // DPMI mode-switch entry. dpmiSwitch consumes the return address itself: coming back means
      // re-entering through a selector, which a RETF cannot express.
      const fn = new Function('cpu', 'cpu.dpmiSwitch();');
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: 'dpmi', term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0, epoch: 0, ph0: -1, ph1: -1, real: 0, vol: null, snap: null, fprec: 0, guard: 0 };
    }
    if (linStart === 0xf0100 && mem.u8[0xf0100] === 0xcb) {
      // XMS driver entry (f000:0100, marked with a 0xCB=RETF stub byte). A guest FAR-CALLs it with
      // AH=function (it got ES:BX from INT 2Fh AX=4310). Run the JS handler, then RETF (pop IP, pop
      // CS) back to the caller. The byte guard keeps the conformance harness (which overwrites the
      // address with real opcodes) from being hijacked.
      const fn = new Function('cpu', `cpu.xmsCall();cpu.eip=cpu.pop16();cpu.setSeg(${CS},cpu.pop16());`);
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: 'xms', term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0, epoch: 0, ph0: -1, ph1: -1, real: 0, vol: null, snap: null, fprec: 0, guard: 0 };
    }
    if (linStart >= 0xf0000 && linStart < 0xf0100 && mem.u8[linStart] === 0xcf) {
      // Guard on the 0xCF stub byte: a real BIOS entry still holds its IRET stub, whereas the
      // conformance harness overwrites f000:xx with actual test opcodes — those must decode
      // normally, not be hijacked into a callback.
      const n = linStart - 0xf0000;
      const fn = new Function('cpu', `cpu.biosCallback(${n});`);
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: `cpu.biosCallback(${n});`, term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0, epoch: 0, ph0: -1, ph1: -1, real: 0, vol: null, snap: null, fprec: 0, guard: 0 };
    }
    const out = ['var t;'];
    const P = (s) => out.push(s);
    // FLAT SEGMENTS. A protected-mode segment of base-independent limit 4 GiB, expand-up (limit FFFFFFFFh,
    // limLo 0), can never fail a limit check: Linux's, a DOS extender's flat model, Win32's. Its
    // accesses are translated without one, and the block checks once, at its head, that the segments
    // it relied on are still flat — a load since (Windows 9x moves between flat and 16-bit selectors)
    // and the block evicts itself and is translated again (cpu.unflat); the memo keeps both kinds.
    // Not after a segment load inside the block (a `cpu.setSeg(` already emitted), nor under tier 2,
    // whose regions splice member blocks without their heads. MIRAGE_NOFLATSPEC=1 turns it off.
    const cpuNow = this.cpu;
    const FLATSPEC = !checked && !NOFLATSPEC && !TIER2 && (cpuNow.cr0 & 1) && !(cpuNow.flags & 0x20000);
    const flatUsed = new Set();
    let segScan = 0, segLoaded = false;
    const flatSeg = (seg) => {
      if (!FLATSPEC) return false;
      for (; !segLoaded && segScan < out.length; segScan++) if (out[segScan].includes('setSeg(')) segLoaded = true;
      if (segLoaded || cpuNow.limit[seg] !== 0xffffffff || cpuNow.limLo[seg] !== 0) return false;
      flatUsed.add(seg); return true;
    };
    /*
     * A FLAT 32-BIT STACK UNDER PAGING (Linux's, Win32's): push, pop, call and ret move it inline --
     * the paged probe, the store before ESP moves (a fault leaves ESP as it was, as on a 386) --
     * instead of cpu.push32/pop32 and the memory helpers behind them, a seventh of Valleyball's
     * synthesizer (a stack machine). Only while SS is flat (flatSeg) and its B bit set when the block
     * is translated; the head checks B again beside the flat test. The emitters are set further down.
     */
    let ssB32 = false;
    const pagedRW = this.memStrategy.read === 'paged' && this.memStrategy.write === 'paged';
    const inlineStack = (sz) => sz === 32 && pagedRW && cpuNow.ssB && flatSeg(SS) && (ssB32 = true);
    let ip = ip0, ipLast = ip0, ended = false, tmp = 0, count = 0, usesFPU = false, canFault = false, stiShadow = 0, usesM = false;
    const NT = () => '_' + (tmp++);

    // Terminator descriptor. Static, same-CS transfers (JMP rel / Jcc / LOOP / JCXZ) record
    // their target(s) here instead of emitting `cpu.eip=T;return` directly, so the region
    // compiler can follow those edges and rewire in-region ones to a local jump. Everything
    // else (RET/CALL/far/computed/INT/HLT/fall-through) is `exit`: it emits its own return
    // and ends any region. `t`/`n` are numeric target ips.
    let term = { k: 'exit' };

    // ---- dead-flag pass bookkeeping ----
    // One record per decoded instruction: `flagIdx` = out[] index of its strippable
    // flag-setting call (or -1), `def`/`use` = abstract flag masks. `cur` is the record
    // for the instruction being decoded. PFLAG emits a strippable flag call and tags it.
    // Default use=0 (transparent): only flag READERS set `cur.use` (enumerated below);
    // a forgotten reader is the one unsafe case, so the golden A/B gate covers it.
    const instrs = [];
    let cur = { flagIdx: -1, def: 0, use: 0 };
    const starts = new Map(), loops = [];   // inner loops: each instruction's [out index, count before it]
    const PFLAG = (stmt, def) => { cur.flagIdx = out.length; cur.def |= def; out.push(stmt); };

    // EIP is a full 32-bit offset in a 32-bit code segment; only a 16-bit one wraps at 0xFFFF. `d` is
    // the CS D bit, which the block cache is already keyed by.
    const ipAdd = d ? (a, b) => (a + b) >>> 0 : (a, b) => (a + b) & 0xffff;
    // ...but the SEQUENTIAL advance does not truncate: an instruction whose last byte sits at 0xFFFF
    // leaves EIP = 0x10000. Only a near JMP/CALL with a 16-bit operand size zeroes the high half,
    // which is what `ipAdd` above models for the branch targets. `ip` is the wrapped FETCH offset,
    // so recover the untruncated value when the current instruction crossed the top of the segment.
    // Fetch and the block-cache key stay wrapped -- step() re-masks EIP to 16 bits on entry -- so
    // only the observable register changes. Executing AT 0x10000 in real mode should #GP on the
    // segment limit; we still wrap there instead, which no DOS guest exercises deliberately.
    const SEQ = () => (!d && ip < ipLast) ? ip + 0x10000 : ip;

    // ---- byte fetch (decode-time reads from memory) ----
    const f8 = () => { const b = mem.r8(mask(linStart - ip0 + ip)); ip = ipAdd(ip, 1); return b; };
    const f16 = () => { const w = mem.r16(mask(linStart - ip0 + ip)); ip = ipAdd(ip, 2); return w; };
    const fs8 = () => { const b = f8(); return b < 128 ? b : b - 256; };
    const f32 = () => { const lo = f16(), hi = f16(); return (lo | (hi << 16)) >>> 0; };   // disp32 / moffs32 (0x67)
    // An immediate of n bytes, as a JS expression. Normally the constant, formatted by `fmt`. If the
    // code keeps rewriting these bytes (rec.smcHits, see invalidate), the bytes are read from memory
    // when the instruction runs, and the block records the range so those writes no longer evict it.
    const VOL = [];
    const immX = (n, fmt, signed) => {
      const a = mask(linStart - ip0 + ip);
      let hot = false;
      for (let k = 0; k < n && !hot; k++) hot = (rec.smcHits.get(mask(a + k)) || 0) >= SMC_HOT;
      const v = n === 1 ? f8() : n === 2 ? f16() : ((f16() | (f16() << 16)) >>> 0);
      if (!hot) return fmt(v);
      VOL.push([a, a + n]);
      if (n === 1) return signed ? `((m.r8(${a})<<24)>>24)` : `m.r8(${a})`;
      return n === 2 ? `m.r16(${a})` : `(m.r32(${a})>>>0)`;
    };

    // ---- operand-size / segment-override / rep prefixes ----
    let opsize, segOv, rep, addr32;
    const M = (sz) => sz === 8 ? '&0xff' : sz === 16 ? '&0xffff' : '>>>0';

    // ---- register operand source/sink as JS expressions ----
    const rR = (i, sz) => sz === 8 ? (i < 4 ? `(r[${i}]&0xff)` : `((r[${i - 4}]>>>8)&0xff)`)
      : sz === 16 ? `(r[${i}]&0xffff)` : `(r[${i}]>>>0)`;
    let curIpStart = 0;
    const rW = (i, sz, v) => sz === 8
      ? (i < 4 ? `r[${i}]=(r[${i}]&~0xff)|((${v})&0xff);` : `r[${i - 4}]=(r[${i - 4}]&~0xff00)|(((${v})&0xff)<<8);`)
      : sz === 16 ? `r[${i}]=(r[${i}]&~0xffff)|((${v})&0xffff);` : `r[${i}]=(${v})>>>0;`;

    // ---- ModR/M ----
    const lin = (seg, off) => AM(`sb[${seg}]+${off}`);
    // 32-bit effective address (after a 0x67 prefix): the mod/rm grid is the 386 one — rm=100 means a
    // SIB byte follows, rm=101 with mod=0 means a bare disp32, and every other rm is a 32-bit register.
    // The default segment is SS when the BASE register is ESP or EBP, DS otherwise. Decoding this is
    // not optional: a 0x67 instruction is 1-5 bytes longer than its 16-bit lookalike, so skipping the
    // prefix (as v1 did) desynchronises the whole instruction stream — that is what derailed Heaven.
    const modrm32 = (mod, rm) => {
      let seg = DS, disp = 0; const parts = [];
      if (rm === 4) {                                     // SIB: scale(2) index(3) base(3)
        const sib = f8(), scale = sib >> 6, index = (sib >> 3) & 7, base = sib & 7;
        const noIndex = index === 4;                       // 100b in the index field = no index term
        if (!noIndex) parts.push(scale ? `((r[${index}]>>>0)*${1 << scale})` : `(r[${index}]>>>0)`);
        if (base === 5 && mod === 0) disp = f32() | 0;     // no base register: disp32 follows
        else {
          // With no index, the manual calls the scale irrelevant. The SILICON does not: the 80386EX
          // vectors (tools/conformance386.mjs) apply it to the BASE instead, and they are unanimous —
          // every failing SIB case had index=100b with a non-zero scale, every other form passed
          // 960/960, and the ones that "passed" with this shape were the ones whose base held 0, where
          // the two formulas coincide. No compiler emits a scale without an index, so this only ever
          // shows up against hardware vectors — which is the point of having them.
          parts.push(noIndex && scale ? `((r[${base}]>>>0)*${1 << scale})` : `(r[${base}]>>>0)`);
          if (base === 4 || base === 5) seg = SS;
        }
      } else if (rm === 5 && mod === 0) {
        disp = f32() | 0;                                  // bare disp32
      } else {
        parts.push(`(r[${rm}]>>>0)`);
        if (rm === 5) seg = SS;                            // [EBP]
      }
      if (mod === 1) disp += fs8(); else if (mod === 2) disp += f32() | 0;   // SIB is consumed BEFORE the disp
      if (disp) parts.push(`(${disp | 0})`);
      return { seg, off: `((${parts.length ? parts.join('+') : '0'})>>>0)` };
    };
    // MOV to/from CRn and DRn ignore the MOD field entirely: the operand is always a register.
    // Decoding those with modrm() would read a displacement that is not there.
    const modrmReg = () => { const b = f8(); return { isReg: true, reg: (b >> 3) & 7, rm: b & 7 }; };
    const modrm = () => {
      const b = f8(), mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
      if (mod === 3) return { isReg: true, reg, rm };
      if (addr32) { const a = modrm32(mod, rm); return { isReg: false, reg, rm, seg: segOv >= 0 ? segOv : a.seg, off: a.off }; }
      let base, seg = DS;
      switch (rm) {
        case 0: base = '((r[3]&0xffff)+(r[6]&0xffff))'; break;
        case 1: base = '((r[3]&0xffff)+(r[7]&0xffff))'; break;
        case 2: base = '((r[5]&0xffff)+(r[6]&0xffff))'; seg = SS; break;
        case 3: base = '((r[5]&0xffff)+(r[7]&0xffff))'; seg = SS; break;
        case 4: base = '(r[6]&0xffff)'; break;
        case 5: base = '(r[7]&0xffff)'; break;
        case 6: if (mod === 0) { base = '(' + f16() + ')'; } else { base = '(r[5]&0xffff)'; seg = SS; } break;
        case 7: base = '(r[3]&0xffff)'; break;
      }
      let disp = 0;
      if (mod === 1) disp = fs8(); else if (mod === 2) disp = f16();
      const off = disp ? `((${base}+(${disp}))&0xffff)` : `((${base})&0xffff)`;
      if (segOv >= 0) seg = segOv;
      return { isReg: false, reg, rm, seg, off };
    };
    // MIRAGE_SEGLIM=1 emits the segment LIMIT check, on reads as well as writes: test386's POST 0x12
    // tests the read side FIRST (`mov eax,[0x9fffd]`), so a write-only check cannot get past it.
    // The offset goes into a temp before being compared — `o.off` is an expression string, and
    // evaluating it twice would repeat whatever side effects it carries.
    // Expand-down segments invert the rule: cpu.limLo is their lowest valid offset (see loadDescriptor).
    // On by default with SEGWP, same measurement; MIRAGE_SEGLIM=0 turns it off.
    const SEGLIM = !(typeof process !== 'undefined' && process.env && process.env.MIRAGE_SEGLIM === '0');
    // LOCK on an instruction that cannot be locked is #UD. On by default since test386 passes with it
    // (the whole suite, to POST 0xFF); MIRAGE_LOCKUD=0 turns it off. It moved exactly two golden
    // fingerprints, intros/memories.com and intros/oktaeder.com, both of which stop on QEMU too —
    // they were re-blessed on the user's decision, not because the new ending is known to be right.
    const LOCKUD = !(typeof process !== 'undefined' && process.env && process.env.MIRAGE_LOCKUD === '0');
    // ADD/OR/ADC/SBB/AND/SUB/XOR r/m,r; the 80/81/83 immediate group; XCHG; F6/F7 (NOT/NEG);
    // FE/FF (INC/DEC); and 0F for BTS/BTR/BTC/CMPXCHG/XADD, which are let through wholesale.
    const LOCKABLE = new Set([0x00, 0x01, 0x08, 0x09, 0x10, 0x11, 0x18, 0x19, 0x20, 0x21,
      0x28, 0x29, 0x30, 0x31, 0x80, 0x81, 0x83, 0x86, 0x87, 0xf6, 0xf7, 0xfe, 0xff, 0x0f]);
    // The ACCESS SIZE is part of the rule: the last byte touched must be within the limit, not the
    // first. test386 reads a dword at offset 0x9FFFD of a segment whose limit is 0x9FFFF — the offset
    // is inside and the access is not, and a check on the offset alone lets it through. That is
    // exactly what a first version of this did, and it looked like the guard simply never fired.
    // The moffs forms (A0-A3) address memory WITHOUT a modrm, so they never reach memAddr and need
    // both guards spelled out. This caught me twice: the write guard on rmW alone left `mov [0],eax`
    // (A3) unprotected, and then the limit guard on memAddr alone left `mov eax,[0x9fffd]` (A1)
    // unprotected — each time the section under test was the one instruction the guard missed.
    const limGuardOff = (seg, off, bytes) => SEGLIM && !REAL && !flatSeg(seg)
      ? `if((${(off >>> 0) + bytes - 1}>cpu.limit[${seg}]||${off >>> 0}<cpu.limLo[${seg}])&&(cpu.cr0&1)&&!(cpu.flags&0x20000)){` +
        `cpu.eip=${curIpStart};cpu.raise(${seg === SS ? 12 : 13},0);return;}` : '';
    const limGuard = (o, bytes) => {
      if (!SEGLIM || REAL || flatSeg(o.seg)) return '';
      const t = NT();
      return `var ${t}=((${o.off})>>>0)+${bytes - 1};if((${t}>cpu.limit[${o.seg}]||${t}-${bytes - 1}<cpu.limLo[${o.seg}])&&(cpu.cr0&1)&&!(cpu.flags&0x20000)){` +
        `cpu.eip=${curIpStart};cpu.raise(${o.seg === SS ? 12 : 13},0);return;}`;
    };
    // `bytes` defaults to 1 when the caller does not say: under-checking is safe (it only misses a
    // fault), over-checking would invent one.
    const memAddr = (o, sz) => { if (o._t === undefined) { o._t = NT(); P(limGuard(o, sz ? (sz >> 3) : 1) + `var ${o._t}=${lin(o.seg, o.off)};`); } return o._t; };
    // Direct typed-array memory access: u8[]/dv reads and writes inline instead
    // of m.r8/w8 calls. Addresses from memAddr are already &MM-masked; composed lanes mask
    // a+1.. (they escape MM only at the very top of RAM, but that wraps and is reachable).
    // memRead: little-endian compose. memW keeps the SMC dirty check (shared, never open-coded).
    // In EGA/VGA planar modes (m.planar), A000 access must go through the Sequencer/Graphics-
    // Controller plane logic, so route to m.r8/w8 etc. `m.planar` is false for text/mode-13h/
    // demos — a single predicted branch keeps the inline u8[] fast path unchanged there.
    // Route only ACTUAL A000 accesses (>>>16===0xA) through the plane logic — the inline
    // range check keeps every other access (stack/data/code, all of mode-13h) on the fast
    // u8[] path even while planar. `m.planar` is false for text/mode-13h/demos → short-circuit.
    const { memRead, memW } = memEmitters(this.memStrategy, MM, NT);
    const rmR = (o, sz) => o.isReg ? rR(o.rm, sz) : memRead(memAddr(o, sz), sz);
    // The flat stack's push and pop (see inlineStack): a statement, and a statement and its value.
    // "Flat" is a 4 GiB expand-up limit, not a zero base: a DPMI host's ring-0 stack (HDPMI32, under
    // xcom144) has both a base and that limit. The address is SS's base plus ESP; ESP moves alone.
    const pushS = (v) => { const a = NT(), l = NT(), t = NT(); return `var ${t}=(${v})>>>0,${a}=(r[4]-4)>>>0,${l}=(sb[${SS}]+${a})>>>0;${memW(l, 32, t)}r[4]=${a};`; };
    const popS = () => { const a = NT(), l = NT(), t = NT(); return [`var ${a}=r[4]>>>0,${l}=(sb[${SS}]+${a})>>>0,${t}=${memRead(l, 32)};r[4]=(${a}+4)>>>0;`, t]; };
    // The write-protection check: a store through a segment whose W bit is clear (or through a code
    // segment) is #GP(0). `cpu.segRO` is precomputed at segment-load time, so this is one typed-array
    // load and a predictable branch — not a call. ON BY DEFAULT since the bench said what it costs:
    // three alternating passes of tools/bench.js, 0-5% per real-mode workload (2.6% mean), golden
    // unchanged. MIRAGE_SEGWP=0 turns it off, for measuring exactly that again.
    const SEGWP = !(typeof process !== 'undefined' && process.env && process.env.MIRAGE_SEGWP === '0');
    const wrGuard = (seg) => SEGWP
      ? `if(cpu.segRO[${seg}]){cpu.eip=${curIpStart};cpu.raise(13,0);return;}` : '';
    const rmW = (o, sz, v) => o.isReg ? rW(o.rm, sz, v) : (wrGuard(o.seg) + memW(memAddr(o, sz), sz, v));

    // ---- ALU emit (dst read expr, dst write fn|null, src expr, size) ----
    const alu = (op, dRead, dWrite, src, sz) => {
      const a = NT(), b = NT(), rr = NT();
      P(`var ${a}=(${dRead})${M(sz)},${b}=(${src})${M(sz)};`);
      switch (op) {
        // The branch-free setters of the width (cpu.setAdd8/16/32 and kin), the same flags.
        case 'add': P(`var ${rr}=(${a}+${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setAdd${sz}(${a},${b},${rr});`, lALL); break;
        case 'or': P(`var ${rr}=(${a}|${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setLogic${sz}(${rr});`, lALL); break;
        case 'and': P(`var ${rr}=(${a}&${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setLogic${sz}(${rr});`, lALL); break;
        case 'xor': P(`var ${rr}=(${a}^${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setLogic${sz}(${rr});`, lALL); break;
        case 'sub': P(`var ${rr}=(${a}-${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setSub${sz}(${a},${b},${rr});`, lALL); break;
        case 'cmp': P(`var ${rr}=(${a}-${b})${M(sz)};`); PFLAG(`cpu.setSub${sz}(${a},${b},${rr});`, lALL); break;
        case 'test': P(`var ${rr}=(${a}&${b})${M(sz)};`); PFLAG(`cpu.setLogic${sz}(${rr});`, lALL); break;
        case 'adc': { cur.use |= lC; const c = NT(); P(`var ${c}=cpu.flags&1;var ${rr}=(${a}+${b}+${c})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setAdc(${a},${b},${c},${rr},${sz});`, lALL); break; }
        case 'sbb': { cur.use |= lC; const c = NT(); P(`var ${c}=cpu.flags&1;var ${rr}=(${a}-${b}-${c})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setSbb(${a},${b},${c},${rr},${sz});`, lALL); break; }
      }
    };
    const ALUNAMES = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];

    // ---- block terminators ----
    /*
     * A DIRECT JMP OR CALL FOLLOWED. Under paging (as the side exits below), in 32-bit code, a jump
     * or call whose target lies on the head's page and was not decoded already goes on in the same
     * block at its target (a call having pushed its return address): Valleyball's interpreter
     * returns to `add ebp,20h; jmp next` and its dispatch, two blocks that are one. The block's bytes
     * are then the span of what it decoded, lo..hi: a write anywhere in it evicts it, a little more
     * than it reads. At most four, so that a block stays a block.
     */
    let lo = ip0, hi = ip0, follows = 0;
    const calls = [];                                    // the return addresses of the calls followed
    // RET in a call followed: it goes on at the return address when the stack holds it, the usual
    // case; any other leaves as a side exit to where the stack says.
    const retFollowed = (v) => {
      const back = calls.pop();
      P(`if(${v}!==${back}){cpu.eip=${v};cpu.cycles-=/*REM${count}*/0;return;}`);
      if (!follow(back)) { P(`cpu.eip=${back};`); P('return;'); ended = true; }
    };
    const follow = (t) => {
      if (!(pfRestart && !TIER2 && !NOSIDEEXIT && !NOFOLLOW && d) || follows >= 4 || starts.has(t) || skips.length) return false;
      if (((linStart - ip0 + t) >>> 12) !== (linStart >>> 12)) return false;
      follows++; hi = Math.max(hi, ip); lo = Math.min(lo, t); ip = t;
      return true;
    };
    const endJmp = (target) => { if (follow(+target)) return; term = { k: 'jmp', t: +target }; ended = true; };
    /*
     * SIDE EXITS. Under paging a FORWARD conditional branch does not end its block: it leaves when
     * taken (`if(cond){cpu.eip=T;...;return;}`) and the block goes on with the instructions after it,
     * still one contiguous range of bytes, so the self-modification and coverage bookkeeping is the
     * same. An interpreter's dispatch (Valleyball's stack machine: movzx, inc, test, jz, call) was four
     * blocks of two to four instructions, each through the dispatcher. A BACKWARD branch into the block
     * (a loop) still ends it, so a loop stays the block's own (the self-loop above). Taken, the exit
     * takes back the instructions it did not run from the cycles the dispatcher adds, and every flag is
     * live there (the block's successor may read any). MIRAGE_NOSIDEEXIT=1 turns it off.
     */
    /*
     * A backward branch to an instruction INSIDE the block, past its head (Valleyball's synthesizer:
     * `push ecx; xor ecx,ecx; xor eax,eax; mov edx,..` and then its loop), is an inner loop: it turns in
     * a `for(;;)` opened at its target, with the self-loop's accounting, and the block goes on after it
     * (`pop ecx; ret 4`): one dispatch where there were three. A loop may not begin inside an earlier
     * one (the two would cross); a branch to the head is still the self-loop.
     */
    let loopFloor = -1;                                          // an out index: loops follow the code as it runs
    /*
     * CHAINED BLOCKS WITHOUT PAGING (real mode, DOS extenders): side exits and loops as under paging, with
     * one difference -- wherever the block would have ended before, it checks what the dispatcher checks
     * between two blocks (the slice's block budget, a halted or blocked machine, the trap flag, and, with
     * interrupts enabled, a waiting IRQ or the next timer or device event) and leaves there if the
     * dispatcher would have stopped or delivered something. So the instructions run, the slices and the
     * cycle at which every interrupt lands are exactly what they were: the DOS golden runs, timed to the
     * block, do not move. And the budget a block may translate is counted from each of those points, so
     * that the cap of maxOps instructions cuts where it cut. BYTE's Sieve ran 3.0 instructions a dispatch
     * (docs/notes/2026-11-03-sieve-profile.md). MIRAGE_NOREALCHAIN=1 turns it off.
     */
    // Not on a page whose code has been written to: there what a block is made of steers the self-modification heuristics.
    const exact = !pfRestart && !TIER2 && !NOSIDEEXIT && rec.realChain && !checked && !this.smcPages.has(linStart >>> 12);
    let segBase = 0;                                             // the count where the block would have begun
    const HARDCAP = 4 * maxOps;                                  // a chained block ends at a branch past this
    // A chained block counts its own cycles: each piece where the block would have ended is added to
    // cpu.cycles there (so a port read after it sees the cycle it saw when that piece was a block of its
    // own), and the dispatcher adds the last piece, the block's count. `mat` is how much the code at this
    // point has added; an early way out gives back the last piece's count the dispatcher will add, as
    // /*FIN*/ (resolved when the block is done).
    let mat = 0, chained = false, chainStop = false, exited = false;
    // An instruction it cannot decode, past a side exit, has not run yet (it may be data after a branch
    // gcc made: UD2 after a call that does not return): the block ends before it, where it would have
    // ended had the branch ended it, and the instruction is decoded if it is ever reached.
    // Past a branch, or inside a skip that may jump over it, an instruction that cannot be translated may never run.
    const endBefore = () => { if (!(chained || exited || skips.length)) return false; count--; P(`cpu.eip=${curIpStart};`); P('return;'); ended = true; return true; };
    const segEnds = [], segIps = [ip0];                          // the count where each piece ended; the ip where each began
    // A write into the running block: into the piece running now, the block leaves after the writing
    // instruction, as it always did; into another piece (a block of its own before), it leaves at the
    // next place where it would have ended (cpu.smcSelf, below), before running what was written.
    const boundary = (eip, next = true) => { const add = count - mat; mat = count; segBase = count; segEnds.push(count); if (next) segIps.push(eip); chained = true; usesM = true;
      return `cpu.cycles+=${add};if(cpu.tbudget<=1||cpu.halted||cpu.smcSelf||M.blocked||(cpu.flags&${TF})||((cpu.flags&${IF})&&(M.hwIrqPending||cpu.cycles>=M.nextEvent))){cpu.smcSelf=0;cpu.eip=${eip};cpu.cycles-=/*FIN*/0;return;}cpu.tbudget--;${next ? `R.curBlk.ran|=${1 << Math.min(30, segIps.length - 1)};` : ''}`; };
    const sideExits = (pfRestart || exact) && !TIER2 && !NOSIDEEXIT;
    /*
     * SKIPS. A short FORWARD conditional branch, taken, jumps over a few instructions the block then
     * decodes anyway: `if(cond){..}else{` the instructions `}`, closed where the branch lands, and the
     * block goes on. Elevated's synthesizer picks an oscillator's waveform and an operator's x87
     * operation by `dec eax; jnz next` chains: each taken branch was a side exit, then a block of one
     * or two instructions, then the dispatcher again -- six instructions a dispatch. Taken, the skip
     * gives back the instructions it jumps over; where the two paths meet the x87 top is read again
     * (one path may have popped). A skip may nest in another, ending at or before it; a block that
     * ends, or follows a jump, inside one is translated again without skips. MIRAGE_NOSKIP=1.
     */
    const skips = [], skipped = [];                              // open: { t, at (out index), n (count) }; closed: [at, end]
    const skipsOn = sideExits && pfRestart && !NOSKIP && !noSkip && d;
    // A conditional branch -- Jcc, and LOOP/LOOPE/LOOPNE/JCXZ, `cond` their condition as JavaScript,
    // `tm` the terminator they end the block with otherwise.
    const endJcc = (cc, target, next) => branch(condExpr(cc), target, { k: 'jcc', cc, t: +target, n: +next });
    const branch = (cond, target, tm) => {
      const at = starts.get(+target);
      if (exact && (count > HARDCAP || chainStop)) { term = tm; ended = true; return; }   // long enough, or the x87's precision moved: end where the block would have
      if (sideExits && !exact && at !== undefined && +target !== ip0 && at[0] > loopFloor && (!skips.length || at[0] > skips[skips.length - 1].at) && !skipped.some(([a, e]) => at[0] > a && at[0] <= e) && !fReads.some(([ri, di]) => ri >= at[0] && di < at[0])) {
        cur.use |= lALL;
        loops.push([at[0], at[2]]);
        for (const [r, c] of fcache) if (c.def < at[0]) fcache.delete(r);   // F moves at the loop's head
        P(`if(!(${cond}))break;`);
        P(`if((cpu.flags&${IF})||cpu.tbudget<=1){cpu.eip=${+target};cpu.cycles-=/*REM${count}*/0;return;}`);
        P(`cpu.cycles+=${count - at[1]};cpu.tbudget--;}`);
        loopFloor = out.length;
        return;
      }
      if (skipsOn && tm.k === 'jcc' && +target >= ip && +target - ip <= 64 && !starts.has(+target)
          && (!skips.length || +target <= skips[skips.length - 1].t)) {
        cur.use |= lALL;
        skips.push({ t: +target, at: out.length, n: count });
        P(`if(${cond}){cpu.cycles-=/*SKIP*/0;}else{`);
        return;
      }
      if (sideExits && !(+target >= ip0 && +target <= curIpStart)) {
        cur.use |= lALL;
        exited = true;
        if (exact) { P(`if(${cond}){cpu.smcSelf=0;cpu.cycles+=${count - mat}-/*FIN*/0;cpu.eip=${+target};return;}`); P(boundary(tm.n)); return; }
        P(`if(${cond}){cpu.eip=${+target};cpu.cycles-=/*REM${count}*/0;return;}`);
        return;
      }
      term = tm; ended = true;
    };
    // Emit the tier-1 return form of the recorded terminator (byte-identical to the old
    // inline emission). The region compiler emits its own edge form from the same `term`.
    // The condition under which a conditional terminator goes to term.t.
    const termCond = (tm = term) => {
      if (tm.k === 'jcc') return condExpr(tm.cc);
      if (tm.k === 'jcxz') return `(${tm.a32 ? '(r[1]>>>0)' : '(r[1]&0xffff)'}===0)`;
      const cx = tm.a32 ? '(r[1]>>>0)' : '(r[1]&0xffff)';                      // LOOP: ECX under 0x67
      return tm.v === 0xe0 ? `(${cx}!==0&&!(cpu.flags&${ZF}))` : tm.v === 0xe1 ? `(${cx}!==0&&(cpu.flags&${ZF}))` : `(${cx}!==0)`;
    };
    const endLoop = (tm) => { if (tm.v !== 0xe2) cur.use |= lZ; branch(termCond(tm), tm.t, tm); };
    const emitTermReturn = () => {
      // A chained block may end with a write into one of its other pieces still pending (cpu.smcSelf): not the next block's.
      if (chained) P('cpu.smcSelf=0;');
      // term.t is already reduced to the code segment's width at decode time (see ipAdd), so the
      // old runtime `&0xffff` was redundant in 16-bit code and destructive in 32-bit code — it threw
      // away the top half of every branch target above 0xFFFF.
      if (term.k === 'jmp') P(`cpu.eip=${term.t};`);
      else if (term.k === 'jcc' || term.k === 'jcxz' || term.k === 'loop') P(`cpu.eip=${termCond()}?${term.t}:${term.n};`);
      else return;   // 'exit' — the block emitted its own return
      P('return;');
    };
    /*
     * A BLOCK THAT BRANCHES BACK TO ITSELF (a tight loop: Valleyball's synthesizer converts a sample a
     * turn, `lodsb; push; fild; fmul; fstp; pop; inc; cmp; jl` to its own head) turns inside its function
     * instead of returning to the dispatcher at each turn. It keeps the dispatcher's accounting -- the
     * cycles and the slice's block budget, a turn each -- and leaves to it when the loop ends, when the
     * budget is down to its last block, or when interrupts are enabled (the dispatcher delivers them
     * between blocks). A fault, an SMC abort, any `return` in the body leaves as it did. Under paging
     * only: the systems that page (Linux's and Win32's programs, Windows 9x) are where it was measured.
     */
    let selfLoop = false;
    const emitSelfLoop = () => {
      if (exact) {                                               // a turn ends where the block ended: the dispatcher's checks
        if (term.k !== 'jmp') {
          const c = termCond(), stay = term.t === ip0 ? c : `!${c}`, exit = term.t === ip0 ? term.n : term.t;
          P(`if(!(${stay})){cpu.smcSelf=0;cpu.cycles+=${count - mat}-/*FIN*/0;cpu.eip=${exit};return;}`);
        }
        const m0 = mat, s0 = segBase; P(boundary(ip0, false)); mat = m0; segBase = s0; segEnds.pop();   // the next turn starts with nothing added
        return;
      }
      const c = termCond(), stay = term.t === ip0 ? c : `!${c}`, exit = term.t === ip0 ? term.n : term.t;
      P(`if(!(${stay})){cpu.eip=${exit};return;}`);
      P(`if((cpu.flags&${IF})||cpu.tbudget<=1){cpu.eip=${ip0};return;}`);
      P(`cpu.cycles+=${count};cpu.tbudget--;`);
    };

    // ---- x87 stack-expression helpers (used by emitFPUReg/emitFPUMem below) ----
    /*
     * THE x87 STACK IN THE BLOCK. The top's place is F, read from cpu.ftop where the block starts, plus
     * a depth the translation follows (fd): ST(i) is st[(F+k)&7] with k a constant, no cpu.ftop read.
     * And a register's value, once a block has loaded or written it, is kept in a local the next reads
     * take (fcache). Writes go to both (write-through), and pushes and pops still store cpu.ftop, so a
     * fault, a side exit or a helper finds st[] and the top as they are. A helper that moves the
     * stack (the fpu.js fallbacks, FLDENV, FXTRACT) ends what the block knows: F is read again.
     * Each loop opened in the block reads F again at its head; one whose body would read a value kept
     * from before it is not opened (see endJcc). MIRAGE_NOFXCACHE=1: cpu.ftop as before.
     */
    const FXC = !TIER2 && !NOFXCACHE;
    let i64Seen = false;                  // a FILD/FISTP m64 earlier in this block: its FXCHs carry fpu.js's exact integers
    let fd = 0;
    const fcache = new Map(), fReads = [];               // slot -> { v, def }; [read at, defined at]
    const stIdx = (r) => (r === 0 ? 'F' : `(F+${r})&7`);
    const STe = (i) => {
      if (!FXC) return i === 0 ? 'st[cpu.ftop]' : `st[(cpu.ftop+${i})&7]`;
      const r = (fd + i) & 7, c = fcache.get(r);
      if (c) { fReads.push([out.length, c.def]); return c.v; }
      return `st[${stIdx(r)}]`;
    };
    const setSTe = (i, v) => {
      if (!FXC) return i === 0 ? `st[cpu.ftop]=${v};` : `st[(cpu.ftop+${i})&7]=${v};`;
      const r = (fd + i) & 7, t = NT();
      fcache.set(r, { v: t, def: out.length });
      return `var ${t}=${v};st[${stIdx(r)}]=${t};`;
    };
    const fsync = () => { if (FXC) { P('F=cpu.ftop;'); fd = 0; fcache.clear(); } };
    // `cpu.focc` tracks which physical registers hold a value — the tag word FNSTENV publishes is
    // derived from it (see fpu.js). Maintaining it HERE and only here is what makes that possible:
    // stack motion happens in these two emissions, while st[] is written inline all over.
    const fpush = (v) => {
      if (!FXC) { const t = NT(), q = NT(); P(`var ${t}=${v};var ${q}=(cpu.ftop-1)&7;cpu.ftop=${q};st[${q}]=${t};oc[${q}]=1;`); return; }
      const t = NT(); fd = (fd - 1) & 7; fcache.set(fd, { v: t, def: out.length });
      P(`var ${t}=${v};cpu.ftop=${stIdx(fd)};st[${stIdx(fd)}]=${t};oc[${stIdx(fd)}]=1;`);
    };
    const FPOP = () => {
      if (!FXC) return 'var _fp=cpu.ftop;oc[_fp]=0;cpu.ftop=(_fp+1)&7;';
      const s0 = `oc[${stIdx(fd)}]=0;cpu.ftop=${stIdx((fd + 1) & 7)};`; fd = (fd + 1) & 7; return s0;
    };
    // Precision control is a TRANSLATION-time constant: PC=single is rare, and reading the control
    // word per operation would tax every FPU block for it. `cpu.fldcw` resets the cache when the
    // field moves, the same way a paging change does. Division goes through a helper because it
    // also has to raise the zero-divide flag, which `x/y` cannot.
    const arithE = (rg, x, y) => {
      const e = rg === 0 ? `${x}+${y}` : rg === 1 ? `${x}*${y}` : rg === 4 ? `${x}-${y}`
        : rg === 5 ? `${y}-${x}` : rg === 6 ? `cpu.fdiv(${x},${y})` : rg === 7 ? `cpu.fdiv(${y},${x})` : x;
      if (rg !== 2 && rg !== 3) pcDep = true;
      return (FPREC24 && rg !== 2 && rg !== 3) ? `cpu.sig24(${e})` : e;   // 2/3 = compare (returns x)
    };

    // ===================== main decode loop =====================
    // The per-instruction `cpu.eip=` (pfRestart, below) only matters to an instruction that can fault
    // or reads EIP: one that touches memory, calls a helper, or returns. One that only moves registers
    // and sets flags (`mov eax,edi`, `and al,81h`, `shl eax,3`) cannot, and its store is dropped once
    // the instruction is translated: Outline 2021's xorchitecture spent a share of its loop on them.
    // The flag setters and the shift helpers neither fault nor read EIP.
    const EIP_FREE = /cpu\.(?:set(?:Add|Sub|Logic|ShiftResult|Adc|Sbb|Inc|Dec)(?:32)?|shl|shr|sar|rol|ror|rcl|rcr)\(|cpu\.flags\b|cpu\.shiftMask\b/g;
    let eipAt = -1;
    const pruneEip = () => {
      if (eipAt < 0) return;
      const rest = out.slice(eipAt + 1).join('\n').replace(EIP_FREE, '');
      if (!/cpu\.|\bm\.|u8\[|rdo\[|wro\[|\bdv\.|\bst\[|\boc\[|return|throw/.test(rest)) out[eipAt] = '';
      else if (pfRestart && LAZYEIP) lazyEip();
      eipAt = -1;
    };
    /*
     * ...and under paging, one that touches memory only through the paged probes stores EIP on the
     * probe's slow path alone: the fast path reads or writes the page directly and cannot fault, and
     * the helpers (m.r8..w32, the x87's cpu.fRd/fWr) are where a #PF comes from. Each helper call
     * takes the store with it, `(cpu.eip=X,m).r32(a)`. Exits that set EIP before they return (a side
     * exit, the self-modification abort, a loop's budget) do not need it. Anything else that might
     * read EIP keeps the store. MIRAGE_NOLAZYEIP=1 turns it off.
     */
    const lazyEip = () => {
      const m0 = /^cpu\.eip=(\d+);$/.exec(out[eipAt]);
      if (!m0) return;
      const X = m0[1], lines = out.slice(eipAt + 1);
      const moved = lines.map((l) => l.replace(/\bm\.(r8|r16|r32|w8|w16|w32)\(/g, `(cpu.eip=${X},m).$1(`)
        .replace(/cpu\.(fRd32|fRd64|fWr32|fWr64)\(/g, `(cpu.eip=${X},cpu).$1(`));
      const left = moved.join('\n').replace(EIP_FREE, '')
        .replace(/\(cpu\.eip=\d+,(?:m|cpu)\)\.\w+\(/g, '')
        .replace(/\{(?:cpu\.smcSelf=0;|_smc=0;)*cpu\.eip=[^;{}]+;(?:cpu\.cycles-=[^;{}]+;)?return;\}/g, '{}')
        .replace(/\bif\(cpu\.smcSelf\)/g, 'if()').replace(/\bcpu\.ftop\b/g, '');
      if (/cpu\.|\bm\.|return|throw/.test(left)) return;
      for (let i = 0; i < moved.length; i++) out[eipAt + 1 + i] = moved[i];
      out[eipAt] = '';
    };
    while (!ended && count - segBase < maxOps) {
      pruneEip();
      if (follows && starts.has(ip)) break;                // a followed jump ran into code already here
      while (skips.length && skips[skips.length - 1].t <= ip) {
        const k = skips[skips.length - 1];
        if (k.t < ip) break;                                // landed inside an instruction: retranslated below
        skips.pop();
        out[k.at] = out[k.at].replace('/*SKIP*/0', String(count - k.n));
        P('}'); P('/*FSYNC*/');
        if (FXC) { fd = 0; fcache.clear(); }
        skipped.push([k.at, out.length - 1]);                 // a loop may hold the skip, not begin in it
      }
      if (skips.length && skips[skips.length - 1].t < ip) break;
      opsize = d ? 32 : 16; segOv = -1; rep = 0; addr32 = !!d;   // CS.D sets the defaults
      const ipStart = ip; ipLast = ip; curIpStart = ip;    // instruction start ip — fault return address (#BR etc.)
      starts.set(ipStart, [out.length, count, fd]);
      // A #PF is raised from INSIDE a memory access, so the run loop has to know which instruction
      // to restart — and only this store knows. It is emitted per instruction ONLY under the paged
      // strategy, which the machine selects exactly when paging is on, so nothing outside protected
      // mode pays for it. (Instruction restart is approximate: side effects a faulting instruction
      // had already committed are not undone. Demand paging faults on the access itself, which is
      // the case that matters; a REP MOVS straddling a missing page is not.)
      if (pfRestart) { eipAt = out.length; P(`cpu.eip=${ipStart};`); }
      // prefixes. Bounded: x86 caps an instruction at 15 bytes, so a longer prefix run is not
      // real code — it is garbage the tier-2 region walker speculatively reached (a Jcc/JMP
      // successor that lands in data). Without this cap the loop would consume prefix bytes
      // forever (wrapping the 64K segment), since `count` only advances past the prefixes.
      let op = f8(), pfx = 0, lock = false;
      for (; pfx++ < 15;) {
        if (op === 0x66) { opsize = d ? 16 : 32; op = f8(); }        // operand-size: INVERTS the default
        else if (op === 0x67) { addr32 = !d; op = f8(); }           // address-size: inverts likewise
        else if (op === 0x2e) { segOv = CS; op = f8(); }
        else if (op === 0x36) { segOv = SS; op = f8(); }
        else if (op === 0x3e) { segOv = DS; op = f8(); }
        else if (op === 0x26) { segOv = ES; op = f8(); }
        else if (op === 0x64) { segOv = FS; op = f8(); }
        else if (op === 0x65) { segOv = GS; op = f8(); }
        else if (op === 0xf0) { lock = true; op = f8(); }          // LOCK — validated below
        else if (op === 0xf2) { rep = 0xf2; op = f8(); }
        else if (op === 0xf3) { rep = 0xf3; op = f8(); }
        else break;
      }
      // LOCK is legal only on a read-modify-write to MEMORY, and only for a fixed set of opcodes;
      // anywhere else it is #UD. test386's POST 0x12 ends on `lock mov [0],eax`, which is exactly the
      // illegal case. The set below is deliberately GENEROUS — it ignores the reg-field refinements
      // (CMP under 80/81/83 is not lockable) and does not require a memory destination, so it can
      // only MISS a #UD, never invent one. An invented #UD would break real programs; a missed one
      // leaves today's behaviour.
      if (LOCKUD && lock && !LOCKABLE.has(op)) {
        P(`cpu.eip=${ipStart};cpu.raise(6);return;`);
        canFault = true; ended = true; break;
      }
      const sz = opsize;
      count++;
      const outMark = out.length;        // see the self-modification guard at the end of this loop
      cur = { flagIdx: -1, def: 0, use: 0 };   // fresh dead-flag record for this instruction
      instrs.push(cur);

      // ----- ALU 0x00..0x3D regular grid -----
      if (op < 0x40 && (op & 7) < 6 && (op >> 3) < 8 && ALUNAMES[op >> 3] !== undefined && (op & 0xc7) !== 0x06 && (op & 0xc7) !== 0x07) {
        const name = ALUNAMES[op >> 3], form = op & 7;
        if (form === 0) { const o = modrm(); alu(name, rmR(o, 8), v => rmW(o, 8, v), rR(o.reg, 8), 8); }
        else if (form === 1) { const o = modrm(); alu(name, rmR(o, sz), v => rmW(o, sz, v), rR(o.reg, sz), sz); }
        else if (form === 2) { const o = modrm(); alu(name, rR(o.reg, 8), v => rW(o.reg, 8, v), rmR(o, 8), 8); }
        else if (form === 3) { const o = modrm(); alu(name, rR(o.reg, sz), v => rW(o.reg, sz, v), rmR(o, sz), sz); }
        else if (form === 4) { const i = f8(); alu(name, rR(0, 8), v => rW(0, 8, v), '' + i, 8); }
        else { const i = sz === 16 ? f16() : (f16() | (f16() << 16)); alu(name, rR(0, sz), v => rW(0, sz, v), '' + (i >>> 0), sz); }
        continue;
      }

      switch (op) {
        // ---- segment push/pop ----
        case 0x06: P(sz === 16 ? `cpu.push16(cpu.seg[${ES}]);` : `cpu.push32(cpu.seg[${ES}]);`); break;
        case 0x07: {
          // POP ES that FAULTS must look like it never happened. Two things follow, and MOV Sreg —
          // the only segment load converted before this — needs neither, which is why its pattern
          // cannot simply be copied:
          //   1. `cpu.eip = ipStart` then RETURN, so the delivered frame points at this instruction.
          //      Without the return, the block runs on and its own `cpu.eip = <next>` overwrites the
          //      handler entry the fault just set, and the exception silently vanishes.
          //   2. ESP is restored. The pop happens BEFORE setSeg can refuse, so a handler that IRETs
          //      back here would pop a second time and skew the stack by one slot.
          const w = sz === 16 ? 2 : 4, t = NT();
          P(`var ${t}=cpu.pop${sz === 16 ? '16' : '32'}()${sz === 16 ? '' : '&0xffff'};cpu.eip=${ipStart};` +
            `if(cpu.setSeg(${ES},${t})===false){cpu.spAdd(${w});return;}`);
          canFault = true; break;
        }
        // PUSH/POP of a segment register moves ONE STACK SLOT of the current operand size: 4 bytes
        // under a 32-bit operand size (0x66 in real mode, or a 32-bit code segment), 2 otherwise.
        // Only the low 16 bits are the selector; the rest is zero on push and discarded on pop.
        // test386 POST 9 asserts both the stored word AND the resulting ESP, which is what caught
        // this: emitting push16 unconditionally moved the stack by 2 where it owed 4.
        case 0x0e: P(sz === 16 ? `cpu.push16(cpu.seg[${CS}]);` : `cpu.push32(cpu.seg[${CS}]);`); break;
        case 0x16: P(sz === 16 ? `cpu.push16(cpu.seg[${SS}]);` : `cpu.push32(cpu.seg[${SS}]);`); break;
        case 0x17: {                                     // POP SS — same shape as POP ES above.
          // Note what is NOT addressed here: POP SS also inhibits interrupts for the following
          // instruction, so that MOV ESP can complete before an IRQ can land on a half-updated
          // stack. That is unchanged by this conversion, which only makes a REFUSED load restartable.
          const w = sz === 16 ? 2 : 4, t = NT();
          P(`var ${t}=cpu.pop${sz === 16 ? '16' : '32'}()${sz === 16 ? '' : '&0xffff'};cpu.eip=${ipStart};` +
            `if(cpu.setSeg(${SS},${t})===false){cpu.spAdd(${w});return;}`);
          canFault = true; break;
        }
        case 0x1e: P(sz === 16 ? `cpu.push16(cpu.seg[${DS}]);` : `cpu.push32(cpu.seg[${DS}]);`); break;
        case 0x1f: {                                     // POP DS — same shape as POP ES above
          const w = sz === 16 ? 2 : 4, t = NT();
          P(`var ${t}=cpu.pop${sz === 16 ? '16' : '32'}()${sz === 16 ? '' : '&0xffff'};cpu.eip=${ipStart};` +
            `if(cpu.setSeg(${DS},${t})===false){cpu.spAdd(${w});return;}`);
          canFault = true; break;
        }

        // ---- BCD adjust ----
        case 0x27: cur.use |= lC | lA; P('cpu.daa();'); break;
        case 0x2f: cur.use |= lC | lA; P('cpu.das();'); break;
        case 0x37: cur.use |= lC | lA; P('cpu.aaa();'); break;
        case 0x3f: cur.use |= lC | lA; P('cpu.aas();'); break;

        // ---- INC/DEC reg16 ----
        case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47: {
          const i = op & 7, a = NT(), rr = NT();
          P(`var ${a}=${rR(i, sz)};var ${rr}=(${a}+1)${M(sz)};${rW(i, sz, rr)}`); PFLAG(sz === 32 ? `cpu.setInc32(${a},${rr});` : `cpu.setAdd(${a},1,${rr},${sz},false);`, lNOC); break;
        }
        case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f: {
          const i = op & 7, a = NT(), rr = NT();
          P(`var ${a}=${rR(i, sz)};var ${rr}=(${a}-1)${M(sz)};${rW(i, sz, rr)}`); PFLAG(sz === 32 ? `cpu.setDec32(${a},${rr});` : `cpu.setSub(${a},1,${rr},${sz},false);`, lNOC); break;
        }

        // ---- PUSH/POP reg ----
        case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57:
          // PUSH SP is the classic CPU-detection probe: an 8086/88 pushes SP *after* the decrement,
          // a 286+ pushes the value it had on entry. Every other register is unaffected.
          if ((op & 7) === 4 && sz === 16 && !PROF.pushSPOriginal) { P('cpu.push16((cpu.reg[4]-2)&0xffff);'); break; }
          if (inlineStack(sz)) { canFault = true; P(pushS(rR(op & 7, 32))); break; }
          P(sz === 32 ? `cpu.push32(${rR(op & 7, 32)});` : `cpu.push16(${rR(op & 7, 16)});`); break;
        case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f: {
          // Pop into a temp FIRST: a 16-bit write emits `r[n]=(r[n]&~0xffff)|(expr&0xffff)` and JS
          // evaluates the left operand before expr, so `o16 pop sp` would merge into the pre-pop ESP.
          // Sequencing also gives POP its defined behaviour of reading ESP after the increment.
          if (inlineStack(sz)) { canFault = true; const [st, v] = popS(); P(st); P(rW(op & 7, 32, v)); break; }
          const t0 = NT();
          P(`var ${t0}=${sz === 32 ? 'cpu.pop32()' : 'cpu.pop16()'};`);
          P(rW(op & 7, sz, t0)); break;
        }

        case 0x60: { // PUSHA / PUSHAD (66) — pushes the ORIGINAL SP/ESP, not the decremented one
          const slow = (sz === 32
            // The pushed eSP is the ORIGINAL one, at the OPERAND width — SS.B chooses where the
            // pushes go, never what the value is. test386 POST 9 asserts exactly this.
            ? `var _sp=cpu.reg[4]>>>0;${pfRestart ? 'try{' : ''}cpu.push32(r[0]);cpu.push32(r[1]);cpu.push32(r[2]);cpu.push32(r[3]);cpu.push32(_sp);cpu.push32(r[5]);cpu.push32(r[6]);cpu.push32(r[7]);${pfRestart ? '}catch(_e){r[4]=_sp;throw _e;}' : ''}`
            : `var _sp=cpu.sp,_sv=r[4];${pfRestart ? 'try{' : ''}cpu.push16(r[0]);cpu.push16(r[1]);cpu.push16(r[2]);cpu.push16(r[3]);cpu.push16(_sp);cpu.push16(r[5]);cpu.push16(r[6]);cpu.push16(r[7]);${pfRestart ? '}catch(_e){r[4]=_sv;throw _e;}' : ''}`);
          // The flat 32-bit stack (inlineStack): the eight dwords in one go when they lie in one plain
          // page -- Valleyball's synthesizer brackets every opcode of its stack machine with pushad and
          // popad -- else the pushes above, one restart point.
          if (inlineStack(sz)) {
            canFault = true; const a = NT(), q = NT();
            P(`var _sp=r[4]>>>0,${a}=(_sp-32)>>>0;if((${a}&4095)<=4064&&(_pw=wro[${a}>>>12])!==-1){var ${q}=(_pw+${a})>>>0,_v=m.dv;`
              + `_v.setUint32(${q},r[7],true);_v.setUint32(${q}+4,r[6],true);_v.setUint32(${q}+8,r[5],true);_v.setUint32(${q}+12,_sp,true);`
              + `_v.setUint32(${q}+16,r[3],true);_v.setUint32(${q}+20,r[2],true);_v.setUint32(${q}+24,r[1],true);_v.setUint32(${q}+28,r[0],true);r[4]=${a};}else{${slow}}`);
          } else P(slow);
          break;
        }
        case 0x61: {
          // POPAD on the flat 32-bit stack: the eight dwords in one go from one plain page (ESP's slot
          // skipped), else the pops below.
          const fast = inlineStack(sz);
          if (fast) {
            canFault = true; const a = NT(), q = NT();
            P(`var ${a}=r[4]>>>0;if((${a}&4095)<=4064&&(_po=rdo[${a}>>>12])!==-1){var ${q}=(_po+${a})>>>0,_v=m.dv;`
              + `r[7]=_v.getUint32(${q},true);r[6]=_v.getUint32(${q}+4,true);r[5]=_v.getUint32(${q}+8,true);`
              + `r[3]=_v.getUint32(${q}+16,true);r[2]=_v.getUint32(${q}+20,true);r[1]=_v.getUint32(${q}+24,true);r[0]=_v.getUint32(${q}+28,true);`
              + `r[4]=(${a}+32)>>>0;}else{`);
          }
          const pops = (i) => rW(i, sz, `cpu.pop${sz}()`);
          P(`${pops(7)}${pops(6)}${pops(5)}`);
          P(`var _sp=cpu.stackPtr;${rW(4, sz, `cpu.pop${sz}()`)}`);      // ESP is loaded, then restored
          P(`if(cpu.ssB){r[4]=(_sp+${sz / 8})>>>0;}else{r[4]=(r[4]&~0xffff)|((_sp+${sz / 8})&0xffff);}`);
          P(`${pops(3)}${pops(2)}${pops(1)}${pops(0)}`);
          if (fast) P('}');
          break;
        }
        case 0x62: {                                                                   // BOUND Gv,Ma → #BR (INT 5) if index ∉ [lower,upper] (signed)
          canFault = true; const o = modrm(); const a = memAddr(o);
          const rd = sz === 16 ? 'r16' : 'r32', sx = sz === 16 ? '<<16>>16' : '|0', d = sz >> 3;
          const idx = NT(), lo = NT(), hi = NT();
          P(`var ${idx}=(${rR(o.reg, sz)})${sx};var ${lo}=(m.${rd}(${a}))${sx};var ${hi}=(m.${rd}(${AM(`${a}+${d}`)}))${sx};`);
          P(`if(${idx}<${lo}||${idx}>${hi}){cpu.eip=${ipStart};cpu.swInt(5);return;}`); break;
        }

        case 0x68: { const i = sz === 16 ? f16() : ((f16() | (f16() << 16)) >>> 0); if (inlineStack(sz)) { canFault = true; P(pushS(i)); break; } P(sz === 32 ? `cpu.push32(${i});` : `cpu.push16(${i & 0xffff});`); break; } // PUSH Iz
        case 0x6a: { const v = fs8(); if (inlineStack(sz)) { canFault = true; P(pushS(v >>> 0)); break; } P(sz === 32 ? `cpu.push32(${v >>> 0});` : `cpu.push16(${v & 0xffff});`); break; } // PUSH Ib (sign-extended to opsize)
        case 0x69: { const o = modrm(); const s = rmR(o, sz); const i = sz === 16 ? f16() : (f16() | (f16() << 16)); P(`cpu.imul16x(${s},${i},${sz});`); P(rW(o.reg, sz, 'cpu._mr')); break; }
        case 0x6b: { const o = modrm(); const s = rmR(o, sz); const i = fs8(); P(`cpu.imul16x(${s},${i},${sz});`); P(rW(o.reg, sz, 'cpu._mr')); break; }
        case 0x6c: emitStr('ins', 8); break;                                            // INSB
        case 0x6d: emitStr('ins', sz); break;                                           // INSW/D
        case 0x6e: emitStr('outs', 8); break;                                           // OUTSB
        case 0x6f: emitStr('outs', sz); break;                                          // OUTSW/D

        // ---- Jcc rel8 ----
        case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
        case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f: {
          const rel = fs8(); endJcc(op & 0xf, ipAdd(ip, rel), ip); break;
        }

        // ---- group1: ALU Eb/Ev, imm ----
        case 0x80: case 0x82: { const o = modrm(); const i = immX(1, (v) => '' + v); const n = ALUNAMES[o.reg]; alu(n, rmR(o, 8), v => rmW(o, 8, v), i, 8); break; }
        case 0x81: { const o = modrm(); const i = immX(sz >> 3, (v) => '' + (v >>> 0)); const n = ALUNAMES[o.reg]; alu(n, rmR(o, sz), v => rmW(o, sz, v), i, sz); break; }
        case 0x83: { const o = modrm(); const i = immX(1, (v) => '(' + (v < 128 ? v : v - 256) + ')', true); const n = ALUNAMES[o.reg]; alu(n, rmR(o, sz), v => rmW(o, sz, v), i, sz); break; }

        // ---- TEST / XCHG / MOV (reg/rm) ----
        case 0x84: { const o = modrm(); alu('test', rmR(o, 8), null, rR(o.reg, 8), 8); break; }
        case 0x85: { const o = modrm(); alu('test', rmR(o, sz), null, rR(o.reg, sz), sz); break; }
        case 0x86: { const o = modrm(); const tA = NT(); P(`var ${tA}=${rmR(o, 8)};${rmW(o, 8, rR(o.reg, 8))}${rW(o.reg, 8, tA)}`); break; }
        case 0x87: { const o = modrm(); const tA = NT(); P(`var ${tA}=${rmR(o, sz)};${rmW(o, sz, rR(o.reg, sz))}${rW(o.reg, sz, tA)}`); break; }
        case 0x88: { const o = modrm(); P(rmW(o, 8, rR(o.reg, 8))); break; }
        case 0x89: { const o = modrm(); P(rmW(o, sz, rR(o.reg, sz))); break; }
        case 0x8a: { const o = modrm(); P(rW(o.reg, 8, rmR(o, 8))); break; }
        case 0x8b: { const o = modrm(); P(rW(o.reg, sz, rmR(o, sz))); break; }
        // MOV Ew,Sw. A MEMORY destination takes two bytes whatever the operand size — that is the
        // rule this opcode is known for. A REGISTER destination under a 32-bit operand size is the
        // other half of it: the selector is ZERO-EXTENDED into the full register, not merged into
        // its low half. The 80386EX vectors give ebx=0000009F where merging leaves 1934009F.
        case 0x8c: { const o = modrm(); P(rmW(o, o.isReg && sz === 32 ? 32 : 16, `cpu.seg[${o.reg}]`)); break; }
        case 0x8d: { const o = modrm(); P(rW(o.reg, sz, '(' + o.off + ')')); break; }   // LEA
        // ARPL r/m16, r16 — adjust the destination's RPL up to the source's, setting ZF when it had
        // to. Protected mode only: a 386 in real mode raises #UD on 0x63, and a CPU-detection
        // routine probing for it must get that answer, so the mode test is emitted rather than
        // assumed. (This is also the opcode games/TURBOPAS/TURBO.EXE faults on.) VIRTUAL-8086 MODE
        // does not recognise it either, and a V86 monitor is built on that: Windows 95's VMM plants
        // `63 xx` as its V86 breakpoints and gets control back through the #UD. Executed as ARPL,
        // the breakpoint VMM put under a simulated interrupt's return fell through, and the IRET it
        // should have taken over popped a far-call frame as FLAGS — TF set, a single-step walk off
        // into data, and "It's now safe to turn off your computer".
        case 0x63: {
          const o = modrm(), d = NT(), sr = NT();
          canFault = true;
          P(`if(!(cpu.cr0&1)||(cpu.flags&0x20000)){cpu.eip=${ipStart};cpu.swInt(6);return;}`);
          P(`var ${d}=${rmR(o, 16)},${sr}=${rR(o.reg, 16)};`);
          P(`if((${d}&3)<(${sr}&3)){cpu.flags|=${ZF};${rmW(o, 16, `((${d}&~3)|(${sr}&3))`)}}else cpu.flags&=~${ZF};`);
          break;
        }
        case 0x8e: {                                                                    // MOV Sw,Ew
          const o = modrm();
          // reg=001 selects CS, and `MOV CS,r/m` does not exist — a real CPU raises #UD. We used to
          // execute it, which test386.asm catches: its POST-3 fault test expects INT 6 and got a
          // normal retirement. Nothing legitimate does this, but a CPU-detection routine probing an
          // instruction's existence via #UD gets the wrong answer, and the exception has to end the
          // block for the same reason DIV's #DE does — otherwise the terminator overwrites cpu.eip
          // and silently discards the interrupt on a stack that already holds an IRET frame.
          if (o.reg === 1) { canFault = true; P(`cpu.eip=${ipStart};cpu.swInt(6);return;`); ended = true; break; }
          // A selector past the table limit, or a null one in SS, is #GP — and the exception has to
          // END THE BLOCK for the reason the MOV CS case above spells out. test386's POST-B fault
          // test loads DS with 0xFFF8 and expects #GP(0xFFF8); we raised it and then carried on
          // into the next instruction, which is that test's failure path.
          canFault = true;
          P(`cpu.eip=${ipStart};if(cpu.setSeg(${o.reg},${rmR(o, 16)})===false)return;`); break;
        }
        // POP Ev moves one stack slot of the current operand size, like PUSH/POP sreg above.
        // POP Ev — same sequencing: the destination may be SP, and a memory destination based on ESP
        // has its address computed AFTER the increment.
        // POP m: the address is computed with ESP already incremented (Intel), but if the STORE faults
        // ESP must be as it was, or the restart pops a second value. KolibriOS's libini did
        // `push [ebp+0Ch] / pop [ebx]` into a fresh heap page and returned with its saved registers
        // shifted by one slot.
        case 0x8f: { const o = modrm(); const t0 = NT();
          const guard = pfRestart && !o.isReg, sv = guard ? NT() : null;
          if (guard) P(`var ${sv}=r[4];`);
          P(`var ${t0}=${sz === 16 ? 'cpu.pop16()' : 'cpu.pop32()'};`);
          P(guard ? `try{${rmW(o, sz, t0)}}catch(_e){r[4]=${sv};throw _e;}` : rmW(o, sz, t0)); break; }

        case 0x90: break;                                                               // NOP
        case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: {  // XCHG eAX,reg
          const i = op & 7, tA = NT(); P(`var ${tA}=${rR(0, sz)};${rW(0, sz, rR(i, sz))}${rW(i, sz, tA)}`); break;
        }
        // CBW/CWD, or CWDE/CDQ under 0x66. `CDQ; IDIV ECX` is *the* signed 32-bit divide idiom, so
        // decoding these as their 16-bit forms silently produced garbage quotients.
        case 0x98: P(sz === 16 ? `r[0]=(r[0]&~0xffff)|((((r[0]&0xff)<<24>>24))&0xffff);`        // CBW  AL→AX
          : `r[0]=(((r[0]&0xffff)<<16>>16))>>>0;`); break;                                      // CWDE AX→EAX
        case 0x99: P(sz === 16 ? `r[2]=(r[2]&~0xffff)|((r[0]&0x8000)?0xffff:0);`                // CWD  AX→DX:AX
          : `r[2]=((r[0]&0x80000000)?0xffffffff:0)>>>0;`); break;                               // CDQ  EAX→EDX:EAX
        // The far pointer immediate is 4+2 bytes under 0x66, not 2+2 — reading only two would
        // DESYNCHRONISE the instruction stream, which is the same failure shape as the 0x67 bug that
        // derailed Heaven. test386's POST-5 far-call test is what surfaced it.
        // CALLF/JMPF must not assume the descriptor is a code segment: in protected mode it may be
        // a CALL GATE, whose fields are selector:offset rather than base/limit. cpu.farCall/farJmp
        // make that decision; real mode takes the same path and behaves as before.
        case 0x9a: { const o = sz === 16 ? f16() : (f16() | (f16() << 16)); const s = f16();
          P(`cpu.eip=${SEQ()};cpu.farCall(${s},${o >>> 0},${sz === 32 ? 1 : 0},${ipStart});`); P('return;'); ended = true; break; } // CALLF ptr
        case 0x9b: break;                                                               // WAIT
        // PUSHF: an 8086/88 always reads bits 12-15 back as 1; a 286+ clears them in real mode.
        case 0x9c: cur.use |= lALL; canFault = true;
          P(`if((cpu.flags&0x20000)&&((cpu.flags>>>12)&3)<3){cpu.eip=${ipStart};cpu.raise(13,0);return;}`);
          // A 386 has no EFLAGS bit above 17 (VM): the rest are reserved and push as zero. Our
          // flags word can hold more — an IRET frame or a POPFD supplies whatever the guest had —
          // so mask on the way out, which is what the 80386EX vectors show (0xFFFC0493 pushes as
          // 0x00000493).
          P(sz === 32 ? 'cpu.push32(cpu.flags&(0x3ffff|cpu.hiFlags));'   // + AC/ID on a 486+ profile
          : `cpu.push16((cpu.flags${PROF.pushfSetsReserved ? '|0xf000' : ''})&0xffff);`); break;
        // POPF / POPFD. Three fields it may NOT write, all of which the old one-line mask did: VM
        // (only IRETD from ring 0 sets that), IOPL (ring 0 only), and IF when CPL > IOPL. And in V86
        // at IOPL < 3 the instruction itself traps — that is how a monitor virtualises the flags.
        case 0x9d: {
          canFault = true;
          P(`if((cpu.flags&0x20000)&&((cpu.flags>>>12)&3)<3){cpu.eip=${ipStart};cpu.raise(13,0);return;}`);
          const t = NT(), c = NT(), i = NT(), f = NT();
          P(`var ${t}=${sz === 32 ? 'cpu.pop32()' : 'cpu.pop16()'};var ${c}=cpu.cpl,${i}=(cpu.flags>>>12)&3;`);
          // AC and ID (cpu.hiFlags, 486+/CPUID profiles): written by POPFD, KEPT by a 16-bit POPF, which
          // only owns the low word — it used to clear ID, so pushf/popf pairs in 16-bit code lost it.
          P(`var ${f}=(${t}&0x4fd5)|2|(cpu.flags&0x20000)|${sz === 32 ? `(${t}&cpu.hiFlags)` : '(cpu.flags&cpu.hiFlags)'}|(${c}?(cpu.flags&0x3000):(${t}&0x3000));`);
          P(`if(${c}>${i})${f}=(${f}&~${IF})|(cpu.flags&${IF});cpu.flags=${f};`);
          // TF set by POPF traps after the NEXT instruction. The run loop single-steps only between
          // blocks, so the block ends here when TF is on; left running, it executed the traced code
          // and the POPF that clears TF again without a single trap (tools/reptrap.asm).
          P(`if(cpu.flags&${TF}){cpu.eip=${SEQ()};return;}`);
          break;
        }
        case 0x9e: P('cpu.flags=(cpu.flags&~0xff)|(((r[0]>>>8)&0xd5))|2;'); break;       // SAHF
        case 0x9f: cur.use |= lC | lP | lA | lZ | lS; P('r[0]=(r[0]&~0xff00)|((((cpu.flags&0xd5)|2)&0xff)<<8);'); break; // LAHF (reads CPAZS)

        // ---- MOV AL/eAX <-> moffs ----
        // moffs is a bare displacement: 2 bytes normally, 4 after a 0x67 prefix (else the stream desyncs).
        case 0xa0: { const d = addr32 ? f32() : f16(); const sg = segOv >= 0 ? segOv : DS;
          P(limGuardOff(sg, d, 1) + rW(0, 8, `m.r8(${lin(sg, d)})`)); break; }
        case 0xa1: { const d = addr32 ? f32() : f16(); const sg = segOv >= 0 ? segOv : DS;
          P(limGuardOff(sg, d, sz >> 3) + rW(0, sz, sz === 16 ? `m.r16(${lin(sg, d)})` : `m.r32(${lin(sg, d)})`)); break; }
        // MOV moffs,AL / MOV moffs,eAX write through a segment WITHOUT going near rmW, so they need
        // the guard of their own. This is not a corner case: test386's POST 0x12 tests write
        // protection with exactly `mov [0],eax`, which assembles to A3 — the moffs form.
        case 0xa2: { const d = addr32 ? f32() : f16(); const sg = segOv >= 0 ? segOv : DS;
          P(limGuardOff(sg, d, 1) + wrGuard(sg) + `m.w8(${lin(sg, d)},${rR(0, 8)});`); break; }
        case 0xa3: { const d = addr32 ? f32() : f16(); const sg = segOv >= 0 ? segOv : DS;
          P(limGuardOff(sg, d, sz >> 3) + wrGuard(sg) + (sz === 16 ? `m.w16(${lin(sg, d)},${rR(0, 16)});` : `m.w32(${lin(sg, d)},${rR(0, 32)});`)); break; }

        // ---- string ops ----
        case 0xa4: emitStr('movs', 8); break;
        case 0xa5: emitStr('movs', sz); break;
        case 0xa6: emitStr('cmps', 8); break;
        case 0xa7: emitStr('cmps', sz); break;
        case 0xaa: emitStr('stos', 8); break;
        case 0xab: emitStr('stos', sz); break;
        case 0xac: emitStr('lods', 8); break;
        case 0xad: emitStr('lods', sz); break;
        case 0xae: emitStr('scas', 8); break;
        case 0xaf: emitStr('scas', sz); break;

        case 0xa8: { const i = f8(); alu('test', rR(0, 8), null, '' + i, 8); break; }
        case 0xa9: { const i = sz === 16 ? f16() : (f16() | (f16() << 16)); alu('test', rR(0, sz), null, '' + (i >>> 0), sz); break; }

        // ---- MOV reg, imm ----
        case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7:
          P(rW(op & 7, 8, immX(1, (v) => '' + v))); break;
        case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf:
          P(rW(op & 7, sz, immX(sz >> 3, (v) => '' + v))); break;

        // ---- group2 shifts ----
        case 0xc0: { const o = modrm(); const c = f8(); emitShift(o, 8, '' + (c & SHIFT_MASK)); break; }   // the 286+ masks the count to 5 bits; an 8088 uses it in full
        case 0xc1: { const o = modrm(); const c = f8(); emitShift(o, sz, '' + (c & SHIFT_MASK)); break; }
        case 0xd0: { const o = modrm(); emitShift(o, 8, '1'); break; }
        case 0xd1: { const o = modrm(); emitShift(o, sz, '1'); break; }
        case 0xd2: { const o = modrm(); emitShift(o, 8, '(r[1]&0xff)'); break; }
        case 0xd3: { const o = modrm(); emitShift(o, sz, '(r[1]&0xff)'); break; }

        // RET pops what CALL pushed: 4 bytes under a 0x66 prefix, 2 without. The immediate form's
        // SP adjustment stays a 16-bit count either way.
        case 0xc2: { const n = f16();
          if (inlineStack(sz)) { canFault = true; const [st, v] = popS(); P(st);
            if (calls.length) { P(`r[4]=(r[4]+${n})>>>0;`); retFollowed(v); break; }
            P(`cpu.eip=${v};r[4]=(r[4]+${n})>>>0;`); P('return;'); ended = true; break; }
          P(`cpu.eip=${sz === 16 ? 'cpu.pop16()' : 'cpu.pop32()>>>0'};cpu.spAdd(${n});`); P('return;'); ended = true; break; } // RET imm
        case 0xc3:
          if (inlineStack(sz)) { canFault = true; const [st, v] = popS(); P(st); if (calls.length) { retFollowed(v); break; } P(`cpu.eip=${v};`); P('return;'); ended = true; break; }
          P(`cpu.eip=${sz === 16 ? 'cpu.pop16()' : 'cpu.pop32()>>>0'};`); P('return;'); ended = true; break;        // RET
        // LDS/LES/LSS/LFS/LGS all load an offset followed by a 16-bit selector. Under 0x66 the offset
        // is a DWORD, so the selector sits at +4, not +2 — reading it at +2 loaded half the offset as
        // the segment. test386's POST-6 `o32 lss ebx,[es:di]` caught it; last of the T0.3 family.
        // A REGISTER operand (mod=11) is not a far pointer: #UD. Windows NT ends every BIOS call it
        // makes in V86 with exactly that — `C4 C4 FE`, its "BOP", after the INT — and recognises it in
        // its #UD handler; we loaded ES from nowhere and ran on, into whatever the page held.
        // VEX (AVX/AVX2/BMI2): in protected mode, C4/C5 followed by a byte whose top two bits are set
        // is not LES/LDS (whose register form is #UD) but a VEX prefix; real and V86 mode keep LES/LDS.
        case 0xc4: case 0xc5: if (!REAL && (cpuNow.cr0 & 1) && !(cpuNow.flags & 0x20000) && (mem.r8(mask(linStart - ip0 + ip)) & 0xc0) === 0xc0) {
          emitVex(op === 0xc4, ipStart); if (ended) break; break;
        }
        if (op === 0xc5) { const o = modrm(); if (o.isReg) { canFault = true; P(`cpu.eip=${ipStart};cpu.swInt(6);return;`); ended = true; break; } P(SEGIP(ipStart) + loadPtr(o, DS, sz)); break; } // LDS
        { const o = modrm(); if (o.isReg) { canFault = true; P(`cpu.eip=${ipStart};cpu.swInt(6);return;`); ended = true; break; } P(SEGIP(ipStart) + loadPtr(o, ES, sz)); break; } // LES
        case 0xc6: { const o = modrm(); const i = immX(1, (v) => '' + v); P(rmW(o, 8, i)); break; }
        case 0xc7: { const o = modrm(); const i = immX(sz >> 3, (v) => '' + v); P(rmW(o, sz, i)); break; }
        // ENTER size,level. The operand size decides the WIDTH of everything it touches: at 32 bits it
        // pushes EBP, sets EBP (not just BP) and copies nested frame pointers as dwords. This was
        // hard-wired to the 16-bit form, so a 32-bit `enter` pushed two bytes instead of four and
        // left ESP odd — Windows 3.0's enhanced-mode kernel opens a frame with `enter 0xa8,0`, and
        // from there every interrupt frame it read was two bytes off, which is how its exception
        // dispatcher ended up calling through a wild pointer.
        case 0xc8: {
          const szv = f16(), lvl = f8() & 0x1f; const ft = NT();
          // THE FINAL STACK POINTER IS PROBED FIRST. The 386 faults on ENTER "whenever a write using
          // the final value of the stack pointer (within the current stack segment) would" — even
          // when that byte is never written: test386's POST 0x1A enters `enter 1,0` at ring 3 with
          // ESP 1004h, the pushes land in a user page and the final ESP (0FFFh) in a supervisor one,
          // and it must be #PF with nothing changed. Probing before any push keeps it restartable.
          // Only under paging: without it there is no page to refuse the write.
          {
            const pushes = 1 + (lvl > 0 ? lvl : 0), total = pushes * (sz === 32 ? 4 : 2) + szv, fe = NT();
            P(`if(m.paged){var ${fe}=cpu.ssB?(((r[4]>>>0)-${total})>>>0):((r[4]-${total})&0xffff);m.xlat((sb[2]+${fe})>>>0,true);}`);
          }
          if (sz === 32) {
            // FrameTemp is the FULL ESP, not the 16-bit stack pointer. On a 16-bit stack SP wraps
            // while ESP's high half is untouched, and both the dword this pushes for a nested level
            // and the final BP are taken from it — test386 compares the pushed slot against EBP
            // afterwards, so a zero-extended SP puts 0x0000FFFC where 0x0001FFFC belongs.
            P(`cpu.push32(r[5]>>>0);var ${ft}=r[4]>>>0;`);                                     // push EBP; frameTemp = ESP
            // The nested copies walk the frame pointer at the STACK's width and push at the OPERAND's,
            // the same pair LEAVE confuses: on a 16-bit stack BP steps and wraps in 16 bits, and the
            // read is at SS:BP. Using EBP there sent the read wherever its high half pointed, so every
            // copy came back zero.
            for (let i = 1; i < lvl; i++) {
              P('if(cpu.ssB){r[5]=(r[5]-4)>>>0;}else{r[5]=(r[5]&~0xffff)|((r[5]-4)&0xffff);}');
              P(`cpu.push32(m.r32(${AM("sb[2]+(cpu.ssB?(r[5]>>>0):(r[5]&0xffff))")})>>>0);`);
            }
            if (lvl > 0) P(`cpu.push32(${ft});`);
            // The DESTINATION width follows the STACK, not the operand size. Intel's ENTER, operand
            // size 32 with StackSize 16, writes `BP <- FrameTemp` — sixteen bits, EBP's high half
            // preserved. Writing all 32 zeroed it, which is what test386's POST 0x1A rejects: it
            // builds EBP as 0x1fffe and expects the 0x10000 back after the ENTER.
            P(`if(cpu.ssB){r[5]=${ft}>>>0;}else{r[5]=(r[5]&~0xffff)|(${ft}&0xffff);}cpu.spAdd(-${szv});`);
          } else {
            P(`cpu.push16(r[5]);var ${ft}=cpu.stackPtr;`);                                     // push BP; frameTemp = SP
            for (let i = 1; i < lvl; i++) P(`r[5]=(r[5]&~0xffff)|((r[5]-2)&0xffff);cpu.push16(m.r16(${AM("sb[2]+(r[5]&0xffff)")}));`);
            if (lvl > 0) P(`cpu.push16(${ft});`);
            P(`r[5]=(r[5]&~0xffff)|${ft};cpu.spAdd(-${szv});`);                                // BP = frameTemp; SP -= size
          }
          break;
        }
        // LEAVE undoes it, and is width-sensitive for the same reason.
        // LEAVE moves the frame pointer at the STACK's width and pops at the OPERAND's — two different
        // widths, and branching on the operand size for both is wrong wherever they differ. `o32 leave`
        // on a 16-bit stack (every real-mode program) writes SP from BP and then pops 32 bits into EBP;
        // we wrote all of EBP into ESP and carried its high half in. ssB is only known at run time, and
        // LEAVE is not hot enough for that to matter.
        case 0xc9:
          P('if(cpu.ssB){r[4]=r[5]>>>0;}else{r[4]=(r[4]&~0xffff)|(r[5]&0xffff);}');
          P(sz === 32 ? 'r[5]=cpu.pop32()>>>0;' : 'r[5]=(r[5]&~0xffff)|cpu.pop16();');
          break;
        // RETF pops what CALLF pushed — two dwords under 0x66, two words without. The selector is
        // popped as a dword too and its upper half discarded.
        // farRet can now raise #GP on the target's privilege; that is a fault, so it needs the
        // instruction's own address for the saved EIP.
        case 0xca: { const n = f16(); P(`cpu.farRet(${sz === 32 ? 1 : 0},${n},${ipStart});`); P('return;'); ended = true; break; } // RETF imm
        case 0xcb: P(`cpu.farRet(${sz === 32 ? 1 : 0},0,${ipStart});`); P('return;'); ended = true; break; // RETF

        // INT3 / INT n / INTO are SOFTWARE interrupts, privilege-checked against the gate's DPL —
        // unlike the faults that also route through swInt. #GP on that check saves the instruction's
        // own address, hence both IPs.
        case 0xcc: P(`cpu.softInt(3,${SEQ()},${ipStart});`); P('return;'); ended = true; break; // INT3
        // F1 — ICEBP / INT1, undocumented but real on every x86 since the 386: a one-byte trap to
        // vector 1. Copy protections use it precisely because it is undocumented (Pinball Fantasies'
        // SETSOUND runs one inside its decryptor). Vector 1's default handler is a bare IRET, which
        // is the correct behaviour with no debugger present, so this simply resumes.
        case 0xf1: P(`cpu.softInt(1,${SEQ()},${ipStart});`); P('return;'); ended = true; break;
        case 0xcd: { const n = f8(); P(`cpu.softInt(${n},${SEQ()},${ipStart});`); P('return;'); ended = true; break; } // INT n
        case 0xce: P(`if(cpu.flags&${OF}){cpu.softInt(4,${SEQ()},${ipStart});return;}cpu.eip=${SEQ()};`); P('return;'); ended = true; break; // INTO
        // IRET pops the frame at the OPERAND size: iretd (32-bit) pops EIP/CS/EFLAGS as dwords.
        // The frame was pushed at the gate's width, and a 32-bit gate is entered from 32-bit code,
        // so the two agree without needing to know which gate delivered us.
        // IRET is IOPL-sensitive in V86 and can raise #GP, and a fault must save the address OF the
        // IRET. Every other path overwrites EIP from the popped frame, so setting it first is free.
        case 0xcf: canFault = true; P(`cpu.eip=${ipStart};cpu.iret(${sz === 32 ? 1 : 0},${SEQ()});`); P('return;'); ended = true; break;

        case 0xd4: cur.use |= lALL; canFault = true; P(`cpu.eip=${ipStart};if(cpu.aam(${f8()}))return;`); break; // AAM (#DE on base 0 — abort the block)
        case 0xd5: P(`cpu.aad(${f8()});`); break; // AAD
        case 0xd6: cur.use |= lC; P(`r[0]=(r[0]&~0xff)|((cpu.flags&${CF})?0xff:0);`); break; // SALC (reads CF)
        case 0xd7: P(`r[0]=(r[0]&~0xff)|m.r8(${lin(segOv >= 0 ? segOv : DS, addr32 ? '(((r[3]>>>0)+(r[0]&0xff))>>>0)' : '((r[3]+ (r[0]&0xff))&0xffff)')});`); break; // XLAT (EBX under 0x67)

        // ---- x87 FPU (D8-DF): emit the specific op inline ----
        case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf: {
          const o = modrm();
          if (NOFPUINLINE) {                          // A/B fallback: runtime dispatch
            if (o.isReg) P(`cpu.fpuReg(${op},${o.reg},${o.rm});`);
            else P(`cpu.fpuMem(${op},${o.reg},${memAddr(o)});`);
          } else {
            usesFPU = true;
            if (o.isReg) emitFPUReg(op, o.reg, o.rm);
            else emitFPUMem(op, o.reg, o);
          }
          break;
        }

        // ---- LOOP / JCXZ ----
        case 0xe0: { const rel = fs8(); P(addr32 ? 'r[1]=(r[1]-1)>>>0;' : 'r[1]=(r[1]&~0xffff)|((r[1]-1)&0xffff);'); endLoop({ k: 'loop', v: 0xe0, t: ipAdd(ip, rel), n: ip, a32: addr32 }); break; }
        case 0xe1: { const rel = fs8(); P(addr32 ? 'r[1]=(r[1]-1)>>>0;' : 'r[1]=(r[1]&~0xffff)|((r[1]-1)&0xffff);'); endLoop({ k: 'loop', v: 0xe1, t: ipAdd(ip, rel), n: ip, a32: addr32 }); break; }
        case 0xe2: { const rel = fs8(); P(addr32 ? 'r[1]=(r[1]-1)>>>0;' : 'r[1]=(r[1]&~0xffff)|((r[1]-1)&0xffff);'); endLoop({ k: 'loop', v: 0xe2, t: ipAdd(ip, rel), n: ip, a32: addr32 }); break; }
        case 0xe3: { const rel = fs8(); const tm = { k: 'jcxz', t: ipAdd(ip, rel), n: ip, a32: addr32 }; branch(termCond(tm), tm.t, tm); break; }

        // ---- IN / OUT ----
        // IN/OUT are IOPL-sensitive: at CPL > IOPL they raise #GP(0) unless the TSS's I/O permission
        // bitmap allows the port. The bitmap is not modelled yet, so this is the strict reading —
        // which is what test386 asks for here (it clears IOPL, then expects `in al,0x64` to fault).
        case 0xe4: { const p = f8(); P(`if((cpu.cr0&1)&&cpu.ioDenied(${p},1)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(rW(0, 8, `cpu.ioRead(${p},1)`)); break; }
        case 0xe5: { const p = f8(); P(`if((cpu.cr0&1)&&cpu.ioDenied(${p},${sz / 8})){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(rW(0, sz, `cpu.ioRead(${p},${sz / 8})`)); break; }
        case 0xe6: { const p = f8(); P(`if((cpu.cr0&1)&&cpu.ioDenied(${p},1)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(`cpu.ioWrite(${p},1,${rR(0, 8)});`); break; }
        case 0xe7: { const p = f8(); P(`if((cpu.cr0&1)&&cpu.ioDenied(${p},${sz / 8})){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(`cpu.ioWrite(${p},${sz / 8},${rR(0, sz)});`); break; }
        case 0xec: P(`if((cpu.cr0&1)&&cpu.ioDenied(r[2]&0xffff,1)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(rW(0, 8, 'cpu.ioRead(r[2]&0xffff,1)')); break;
        case 0xed: P(`if((cpu.cr0&1)&&cpu.ioDenied(r[2]&0xffff,${sz / 8})){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(rW(0, sz, `cpu.ioRead(r[2]&0xffff,${sz / 8})`)); break;
        case 0xee: P(`if((cpu.cr0&1)&&cpu.ioDenied(r[2]&0xffff,1)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(`cpu.ioWrite(r[2]&0xffff,1,${rR(0, 8)});`); break;
        case 0xef: P(`if((cpu.cr0&1)&&cpu.ioDenied(r[2]&0xffff,${sz / 8})){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(`cpu.ioWrite(r[2]&0xffff,${sz / 8},${rR(0, sz)});`); break;

        // ---- CALL / JMP ----
        // CALL/JMP rel under a 0x66 prefix take a 32-bit displacement AND, for CALL, push a 32-bit
        // return address — SP moves by 4, not 2. We read the 32-bit displacement but then
        // sign-extended it as if it were 16-bit and pushed 16 bits, so the stack was off by two for
        // the rest of the frame. Found by test386.asm's POST-5 `o32 call dword` check. The target
        // still masks to 16 bits: real mode's segment limit is 0xFFFF regardless of operand size.
        case 0xe8: {
          const rel = sz === 16 ? (f16() << 16 >> 16) : (f16() | (f16() << 16));
          const tgt = ipAdd(ip, rel);
          if (inlineStack(sz)) { canFault = true; const back = SEQ(); P(pushS(back)); if (follow(tgt)) { calls.push(back); break; } P(`cpu.eip=${tgt};`); P('return;'); ended = true; break; }
          P(sz === 16 ? `cpu.push16(${SEQ()});` : `cpu.push32(${SEQ()});`);
          P(`cpu.eip=${tgt};`); P('return;'); ended = true; break;
        }
        case 0xe9: { const rel = sz === 16 ? (f16() << 16 >> 16) : (f16() | (f16() << 16)); endJmp('' + ipAdd(ip, rel)); break; } // JMP rel
        // EIP is set to the instruction's own address first: #GP on the target is a fault, and on
        // success farJmp overwrites it anyway.
        case 0xea: { const o = sz === 16 ? f16() : (f16() | (f16() << 16)); const s = f16(); P(`cpu.eip=${ipStart};cpu.farJmp(${s},${o >>> 0},undefined,${SEQ()});`); P('return;'); ended = true; break; } // JMPF ptr
        case 0xeb: { const rel = fs8(); endJmp('' + ipAdd(ip, rel)); break; }    // JMP rel8

        case 0xf4:                                                                      // HLT
          canFault = true;
          P(`if((cpu.cr0&1)&&${CPL_EXPR}){cpu.eip=${ipStart};cpu.raise(13,0);return;}`);
          P('cpu.halted=true;'); P(`cpu.eip=${SEQ()};`); P('return;'); ended = true; break;
        case 0xf5: cur.use |= lC; P(`cpu.flags^=${CF};`); break;                        // CMC (reads CF)
        case 0xf6: emitGroup3(8, ipStart); break;
        case 0xf7: emitGroup3(sz, ipStart); break;
        case 0xf8: P(`cpu.flags&=~${CF};`); break;                                      // CLC
        case 0xf9: P(`cpu.flags|=${CF};`); break;                                       // STC
        case 0xfa:                                                                      // CLI
          canFault = true;
          P(`if((cpu.cr0&1)&&${CPL_EXPR}>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`);
          P(`cpu.flags&=~${IF};`); break;
        case 0xfb:                                                                      // STI
          canFault = true;
          P(`if((cpu.cr0&1)&&${CPL_EXPR}>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`);
          P(`cpu.flags|=${IF};`); stiShadow = 2; break;
        case 0xfc: P(`cpu.flags&=~${DF};`); break;                                      // CLD
        case 0xfd: P(`cpu.flags|=${DF};`); break;                                       // STD
        case 0xfe: { const o = modrm(); const a = NT(), rr = NT(); if (o.reg === 0) { P(`var ${a}=${rmR(o, 8)};var ${rr}=(${a}+1)&0xff;${rmW(o, 8, rr)}`); PFLAG(`cpu.setAdd(${a},1,${rr},8,false);`, lNOC); } else { P(`var ${a}=${rmR(o, 8)};var ${rr}=(${a}-1)&0xff;${rmW(o, 8, rr)}`); PFLAG(`cpu.setSub(${a},1,${rr},8,false);`, lNOC); } break; }
        case 0xff: emitGroup5(sz, ipStart); break;

        case 0x0f: { decode0F(sz); break; }

        default:
          if ((rec._udSeen = true, guestOwnsUD(mem, rec.cpu))) {   // the guest asked for #UD; give it #UD
            P(`cpu.eip=${ipStart};cpu.raise(6);`); P('return;'); ended = true; break;
          }
          if (endBefore()) break;
          throw new Error(unimplemented(op.toString(16).padStart(2, '0'), mask(linStart - ip0 + ip - 1), mem, rec));
      }

      // A chained block stops chaining after an instruction that may change the x87's precision control
      // (FLDCW, FLDENV, FRSTOR, FNINIT -- through these helpers): the next piece was translated for the
      // precision in force when its block began, which the dispatcher checks (blk.fprec).
      if (exact && !chainStop) for (let i = outMark; i < out.length; i++) if (/cpu\.(fldcw|fldenv|fpuMem|fpuReg)\(/.test(out[i])) { chainStop = true; break; }
      // ...and the rest of THIS block was folded for that precision too (FPREC24), as was whatever a
      // followed call or a chained piece adds to it. So the block leaves, at the next instruction,
      // when the instruction actually moved PC across single/not single; otherwise it goes on as before,
      // and the boundaries the DOS golden runs are timed by do not move.
      let pcWrite = false;
      if (!ended && usesFPU) for (let i = outMark; i < out.length && !pcWrite; i++) pcWrite = PCWRITE.test(out[i]);
      if (pcWrite) {
        cur.use |= lALL;
        const giveBack = pfRestart ? `cpu.cycles-=/*REM${count}*/0;` : exact ? `cpu.cycles+=/*SEGEND${segEnds.length}:${mat}*/0;` : '';
        P(`if((cpu.fcw&0x300)${FPREC24 ? '!==' : '==='}0){cpu.eip=${SEQ()};${giveBack}return;}`);
      }

      // Self-modification guard. A block holds the bytes it was translated from, so an instruction
      // that rewrites a LATER byte of its own block leaves the rest of the block running the stale
      // form — Mystic Towers rewrites 00 to 2f and we kept executing INT 00h. The cache is already
      // invalidated by mem.onCodeWrite; what was missing is stopping the block that is running.
      //
      // Emitted only after an instruction that actually writes memory, detected from the code just
      // produced rather than from a list of opcodes — string ops write through m.w8/m.w16 and would
      // have been missed by one. `ip` here is the NEXT instruction, which is where re-dispatch must
      // resume, and that is why the check cannot live inside the write emitter.
      if (!ended) {
        // ...and under paging it gives back the instructions after this one, as a side exit does: the
        // dispatcher adds the whole block's count. (Real and protected mode keep the old count, which
        // two of the DOS golden intros' frames are timed by: crevenge, qblove.)
        // A write into the block itself leaves it after the writing instruction. Unpaged, the dispatcher then
        // adds the whole block's count, as it always did; a chained block adds what its piece would have.
        const giveBack = pfRestart ? `cpu.cycles-=/*REM${count}*/0;` : exact ? `cpu.cycles+=/*SEGEND${segEnds.length}:${mat}*/0;` : '';
        const inPiece = exact ? `&&cpu.smcLo</*SEGHI${segEnds.length}*/0&&cpu.smcHi>/*SEGLO${segEnds.length}*/0` : '';
        const abort = `if(cpu.smcSelf${inPiece}){cpu.smcSelf=0;cpu.eip=${SEQ()};${giveBack}return;}`;
        let helperWrite = false, inlineMark = false;
        for (let i = outMark; i < out.length; i++) {
          // The inline write emitter leaves a marker INSIDE its code-page branch. It must only RECORD
          // that the block has to stop — never return from there, because that is the middle of an
          // instruction. Returning there skipped everything the instruction had left to do: FreeDOS's
          // kernel decompressor does `sub byte [cs:si+0x12],0x10` on its own code, and the abort fired
          // between the store and `cpu.setSub`, so the following `jnc` read a stale carry, looped when
          // it should have fallen through, and the copy that followed wrapped past 1 MiB over the
          // kernel itself. The check moves to the instruction boundary, where the resume address is
          // also the correct one; a local flag keeps it off the path of writes to ordinary pages.
          if (out[i].includes('/*SMCABORT*/')) { out[i] = out[i].split('/*SMCABORT*/').join('if(cpu.smcSelf)_smc=1;'); inlineMark = true; }
          // Helper writes (m.w8/w16/w32) carry no marker: string ops and the paged strategy go that
          // way, and those are exactly a decryptor's instructions, so they get the guard after the
          // instruction. They are rare enough on a hot path not to matter.
          else if (out[i].includes('m.w8(') || out[i].includes('m.w16(') || out[i].includes('m.w32(')) helperWrite = true;
        }
        if (inlineMark) P(`if(_smc${inPiece}){_smc=0;cpu.smcSelf=0;cpu.eip=${SEQ()};${giveBack}return;}`);
        else if (helperWrite) P(abort);
      }
      // STI opens the interrupt window one instruction LATE — and closes nowhere: the block must end
      // right there, because interrupts are taken only between blocks. Windows 95's VMM idles in
      // `sti; nop; nop; cli; jmp`: compiled as one block, IF was never set at a boundary, the timer
      // IRQ the scheduler was waiting for could never land, and the machine spun for ever.
      if (stiShadow && --stiShadow === 0 && !ended) break;
    }

    if (!ended) P(`cpu.eip=${SEQ()};`);

    // ---- dead-flag elimination ----
    // Backward liveness over the block's instructions: strip a flag-setting call whose
    // defined flags are ALL dead at that point. Live-out of the block is ALL 6 flags —
    // the next block (or an external reader between slices) may consume them — so the
    // last flag writer never strips; only intermediate dead ones do (e.g. address-math
    // ADDs feeding nothing before the block-final CMP+Jcc). stepOne compiles a single
    // instruction, so live is always ALL and nothing is ever stripped → the conformance
    // path is byte-identical by construction.
    if (!NOSTRIP) {
      let live = lALL;
      for (let i = instrs.length - 1; i >= 0; i--) {
        const n = instrs[i];
        if (n.flagIdx >= 0 && (n.def & live) === 0) out[n.flagIdx] = '';
        live = (live & ~n.def) | n.use;
      }
    }

    // `bodyOut` is the block body WITHOUT its terminating branch (kept for the region
    // compiler, which re-emits the terminator from `term`); tier-1 then appends the
    // terminator's return form to get the standalone block function.
    pruneEip();
    if (skips.length) return this.translate(linStart, ip0, maxOps, d, checked, true);
    if (needChecked) return this.translate(linStart, ip0, maxOps, d, true, noSkip);
    const bodyOut = out.slice();
    selfLoop = !NOSELFLOOP && !TIER2 && (pfRestart || exact) && (((term.k === 'jcc' || term.k === 'jcxz' || term.k === 'loop')
      && (term.t === ip0) !== (term.n === ip0)) || (exact && term.k === 'jmp' && term.t === ip0));
    if (selfLoop && exact) usesM = true;
    if (selfLoop) emitSelfLoop(); else emitTermReturn();
    let head = '';
    if (flatUsed.size) {
      const sg = [...flatUsed];
      head = `if(((${sg.map((g) => `cpu.limit[${g}]`).join('&')})|0)!==-1||(${sg.map((g) => `cpu.limLo[${g}]`).join('|')})!==0${ssB32 ? '||!cpu.ssB' : ''}){cpu.eip=${ip0};cpu.unflat(${linStart});return;}`;
    }
    const pre = 'var r=cpu.reg,m=cpu.mem,sb=cpu.base,u8=m.u8,cp=m.codePage;' + memPrologue(this.memStrategy) + (usesFPU ? 'var st=cpu.fst,dv=m.dv,oc=cpu.focc;' : '') + (usesM ? 'var M=cpu.mach,R=M.rec;' : '') + head;
    const fx = FXC && usesFPU;
    for (const [at, dt] of loops) out[at] = 'for(;;){\n' + (fx ? `F=(cpu.ftop-${dt}+8)&7;\n` : '') + out[at];
    if (fx) out.unshift('var F=cpu.ftop;');
    const fin = chained ? count - segBase : 0;                    // a chained block's count: its last piece
    const segEnd = (i) => (i < segEnds.length ? segEnds[i] : count);
    const code = out.join('\n').replace(/\/\*REM(\d+)\*\/0/g, (_, k) => String(count - +k)).replace(/\/\*FSYNC\*\//g, fx ? 'F=cpu.ftop;' : '')   // side exits: what they did not run
      .replace(/\/\*FIN\*\/0/g, String(fin)).replace(/\/\*SEGEND(\d+):(\d+)\*\/0/g, (_, i, m0) => String(segEnd(+i) - +m0 - (chained ? fin : count)))
      .replace(/\/\*SEG(LO|HI)(\d+)\*\/0/g, (_, w, i) => String(mask(linStart - ip0 + (w === 'LO' ? segIps[+i] : (+i + 1 < segIps.length ? segIps[+i + 1] : ip)))));
    const body = pre + '\n' + (selfLoop ? `for(;;){\n${code}\n}` : code);
    const fn = new Function('cpu', body);
    // The emitted source is kept ONLY if something will read it: the region compiler splices
    // bodyOut, and tools/trace.js prints body. Tier 2 is opt-in, so by default neither is, and
    // holding both meant the cache retained every block's source TWICE — as a string and as the
    // array of lines it was joined from. bodyLen survives either way, because the cache is bounded
    // by emitted bytes.
    const keep = rec.keepSource;
    hi = Math.max(hi, ip);
    return { fn, linStart: mask(linStart - ip0 + lo), linEnd: mask(linStart - ip0 + hi), ip0, ipEnd: ip, count: chained ? fin : count, ran: 0, pieces: chained ? segIps.map((a, i) => [mask(linStart - ip0 + a), mask(linStart - ip0 + (i + 1 < segIps.length ? segIps[i + 1] : ip))]) : undefined,
             body: keep ? body : '', bodyLen: body.length, term, bodyOut: keep ? bodyOut : EMPTY_LINES,
             // epoch/ph0/ph1 (ROADMAP D8) are set by _compile under paging; declared HERE so every block
             // has one shape — adding them afterwards made the dispatch loop's blk.fn/blk.count polymorphic
             // and Windows 3.0's steady state ran at half speed with not one CR3 load or compile.
             // fprec: 0 when the block's code does not depend on the precision control, else 2 when
             // it was translated under single precision (its arithmetic rounded to float32), 1 otherwise.
             usesFPU, canFault, hot: 0, kind: 0, epoch: 0, ph0: -1, ph1: -1, real: REAL ? 1 : 0, vol: VOL.length ? VOL : null, snap: null, fprec: pcDep ? (FPREC24 ? 2 : 1) : 0,
               guard: (REAL ? 1 : 0) | (pcDep ? 2 : 0) };

    // ===================== nested emit helpers =====================

    // ---- x87 inline emission ---------------------------------------------------
    // Mirrors src/fpu.js exactly, but with op/reg/rm known at compile time we emit the
    // one operation's JS directly instead of the giant runtime switch. Uses the block
    // aliases `st` (cpu.fst) and `dv` (m.dv); cpu.ftop stays on the object (no local
    // mirror) so it is always correct at every block exit with no flush. Anything not
    // explicitly recognised routes to the cpu.fpuMem/fpuReg fallback (= today's code),
    // which is also the safety net for future opcodes. `cpu.fcmp`/`cpu.f2i` are the
    // shared compare / round-to-int helpers exported from fpu.js. (The string helpers
    // STe/setSTe/fpush/FPOP/arithE are defined before the decode loop.)
    function emitFPUMem(op, reg, o) {
      const a = memAddr(o);
      const fb = () => { P(`cpu.fpuMem(${op},${reg},${a});`); fsync(); };
      if (op === 0xdf && (reg === 5 || reg === 7)) i64Seen = true;
      const smc = (len) => `if(cp[${a}>>>12]|cp[(${AM(`${a}+${len - 1}`)})>>>12])m._dirty(${a},${len});`;
      // The inline forms index the physical DataView with the address; under paging it is LINEAR, and
      // the paged forms below translate it as the paged integer accesses do.
      if (pfRestart) return emitFPUMemPaged(op, reg, a, fb);
      switch (op) {
        case 0xd9:                                                   // f32 load/store + control
          if (reg === 0) return fpush(`dv.getFloat32(${a},true)`);           // FLD m32
          if (reg === 2) return P(`dv.setFloat32(${a},${STe(0)},true);${smc(4)}`);        // FST m32
          if (reg === 3) return P(`dv.setFloat32(${a},${STe(0)},true);${smc(4)}${FPOP()}`); // FSTP m32
          if (reg === 4) { P(`cpu.fldenv(${a});`); return fsync(); }                      // FLDENV
          if (reg === 5) return P(`cpu.fldcw(m.r16(${a}));`);                // FLDCW
          if (reg === 6) return P(`cpu.fnstenv(${a});`);                     // FNSTENV
          if (reg === 7) return P(`m.w16(${a},cpu.fcw);`);                   // FNSTCW (w16 does SMC)
          return fb();
        case 0xdd:                                                   // f64 load/store
          if (reg === 0) return fpush(`dv.getFloat64(${a},true)`);           // FLD m64
          if (reg === 2) return P(`dv.setFloat64(${a},${STe(0)},true);${smc(8)}`);        // FST m64
          if (reg === 3) return P(`dv.setFloat64(${a},${STe(0)},true);${smc(8)}${FPOP()}`); // FSTP m64
          if (reg === 7) return P(`m.w16(${a},((cpu.fsw&0x47ff)|((cpu.ftop&7)<<11)));`);      // FNSTSW m16
          return fb();
        case 0xdb:                                                   // i32 load/store
          if (reg === 0) return fpush(`dv.getInt32(${a},true)`);             // FILD m32
          if (reg === 2) return P(`m.w32(${a},cpu.fi32(${STe(0)})>>>0);`);            // FIST m32
          if (reg === 3) return P(`m.w32(${a},cpu.fi32(${STe(0)})>>>0);${FPOP()}`);     // FISTP m32
          return fb();
        case 0xdf:                                                   // i16 load/store
          if (reg === 0) return fpush(`dv.getInt16(${a},true)`);             // FILD m16
          if (reg === 2) return P(`m.w16(${a},cpu.fi16(${STe(0)})&0xffff);`);         // FIST m16
          if (reg === 3) return P(`m.w16(${a},cpu.fi16(${STe(0)})&0xffff);${FPOP()}`);  // FISTP m16
          return fb();
      }
      // arithmetic with a memory source: D8=f32, DC=f64, DA=i32, DE=i16
      const vexpr = op === 0xd8 ? `dv.getFloat32(${a},true)` : op === 0xdc ? `dv.getFloat64(${a},true)`
        : op === 0xda ? `dv.getInt32(${a},true)` : `dv.getInt16(${a},true)`;
      const vt = NT(), xt = NT();
      P(`var ${vt}=${vexpr},${xt}=${STe(0)};`);
      if (reg === 2) return P(`cpu.fcmp(${xt},${vt});`);                     // FCOM
      if (reg === 3) return P(`cpu.fcmp(${xt},${vt});${FPOP()}`);             // FCOMP
      return P(setSTe(0, arithE(reg, xt, vt)));                             // FADD/FMUL/FSUB/FSUBR/FDIV/FDIVR
    }

    /*
     * x87 MEMORY OPERANDS UNDER PAGING, inline: the paged strategy's one probe (rdOfs/wrOfs, a biased
     * physical-minus-linear offset per page, -1 when the page is not plain RAM or holds translated
     * code), then the DataView at the physical address; else src/fpu.js's helpers, which translate,
     * fault and keep the SMC bookkeeping as cpu.fpuMem did. Every load and store of a float went
     * through cpu.fpuMem under paging -- a third of Valleyball's synthesizer (2009, a 4K intro whose
     * music is x87 arithmetic on memory) was that path. The environment and control forms stay there.
     */
    function emitFPUMemPaged(op, reg, a0, fb) {
      const a = NT();
      P(`var ${a}=${a0};`);
      const rf = (len, get, slow) => `(((${a}&4095)<${4097 - len}&&(_po=rdo[${a}>>>12])!==-1)?dv.${get}((_po+${a})>>>0,true):cpu.${slow}(${a}))`;
      const wf = (len, set, slow, v) => `if((${a}&4095)<${4097 - len}&&(_pw=wro[${a}>>>12])!==-1)dv.${set}((_pw+${a})>>>0,${v},true);else cpu.${slow}(${a},${v});`;
      const f32 = rf(4, 'getFloat32', 'fRd32'), f64 = rf(8, 'getFloat64', 'fRd64');
      const i32 = `(${memRead(a, 32)}|0)`, i16 = `(${memRead(a, 16)}<<16>>16)`;
      switch (op) {
        case 0xd9:
          if (reg === 0) return fpush(f32);                                           // FLD m32
          if (reg === 2) return P(wf(4, 'setFloat32', 'fWr32', `${STe(0)}`));       // FST m32
          if (reg === 3) return P(wf(4, 'setFloat32', 'fWr32', `${STe(0)}`) + FPOP());  // FSTP m32
          if (reg === 5) return P(`cpu.fldcw(${memRead(a, 16)});`);                   // FLDCW
          if (reg === 7) return P(memW(a, 16, 'cpu.fcw'));                             // FNSTCW
          return fb();
        case 0xdd:
          if (reg === 0) return fpush(f64);                                           // FLD m64
          if (reg === 2) return P(wf(8, 'setFloat64', 'fWr64', `${STe(0)}`));       // FST m64
          if (reg === 3) return P(wf(8, 'setFloat64', 'fWr64', `${STe(0)}`) + FPOP());  // FSTP m64
          if (reg === 7) return P(memW(a, 16, '((cpu.fsw&0x47ff)|((cpu.ftop&7)<<11))'));   // FNSTSW m16
          return fb();
        case 0xdb:
          if (reg === 0) return fpush(i32);                                           // FILD m32
          if (reg === 2) return P(memW(a, 32, `cpu.fi32(${STe(0)})>>>0`));          // FIST m32
          if (reg === 3) return P(memW(a, 32, `cpu.fi32(${STe(0)})>>>0`) + FPOP());   // FISTP m32
          return fb();
        case 0xdf:
          if (reg === 0) return fpush(i16);                                           // FILD m16
          if (reg === 2) return P(memW(a, 16, `cpu.fi16(${STe(0)})&0xffff`));       // FIST m16
          if (reg === 3) return P(memW(a, 16, `cpu.fi16(${STe(0)})&0xffff`) + FPOP());   // FISTP m16
          return fb();
      }
      const vexpr = op === 0xd8 ? f32 : op === 0xdc ? f64 : op === 0xda ? i32 : i16;
      const vt = NT(), xt = NT();
      P(`var ${vt}=${vexpr},${xt}=${STe(0)};`);
      if (reg === 2) return P(`cpu.fcmp(${xt},${vt});`);                     // FCOM
      if (reg === 3) return P(`cpu.fcmp(${xt},${vt});${FPOP()}`);             // FCOMP
      return P(setSTe(0, arithE(reg, xt, vt)));                             // FADD/FMUL/FSUB/FSUBR/FDIV/FDIVR
    }

    function emitFPUReg(op, reg, rm) {
      const b = 0xc0 | (reg << 3) | rm;
      const fb = () => { P(`cpu.fpuReg(${op},${reg},${rm});`); fsync(); };
      switch (op) {
        case 0xd9:
          if (b < 0xc8) return fpush(STe(rm));                              // FLD ST(i) (pre-push read)
          if (b < 0xd0) {                                                    // FXCH, and the exact 64-bit integers FILD m64 left (fpu.js)
            // Only in a block that loaded or stored one (Jazz Jackrabbit 2's copy loop): elsewhere an FXCH is
            // the plain exchange, with nothing more to read (a check in every FXCH cost lattice 2.5%).
            const t = NT(), p0 = FXC ? stIdx(fd & 7) : 'cpu.ftop', p1 = FXC ? stIdx((fd + rm) & 7) : `(cpu.ftop+${rm})&7`;
            P(`var ${t}=${STe(0)};${setSTe(0, STe(rm))}${setSTe(rm, t)}${i64Seen ? `if(cpu.fx64.n)cpu.fx64.swap(${p0},${p1});` : ''}`); return;
          }
          switch (b) {
            case 0xe0: return P(setSTe(0, `-${STe(0)}`));                // FCHS
            case 0xe1: return P(setSTe(0, `Math.abs(${STe(0)})`));       // FABS
            case 0xe4: return P('cpu.ftst();');                            // FTST
            case 0xe5: return P('cpu.fxam();');                            // FXAM
            case 0xe8: return fpush('1');                                  // FLD1
            case 0xe9: return fpush('Math.log2(10)');                      // FLDL2T
            case 0xea: return fpush('Math.LOG2E');                         // FLDL2E
            case 0xeb: return fpush('Math.PI');                            // FLDPI
            case 0xec: return fpush('Math.log10(2)');                      // FLDLG2
            case 0xed: return fpush('Math.LN2');                           // FLDLN2
            case 0xee: return fpush('0');                                  // FLDZ
            case 0xf0: return P(setSTe(0, `Math.expm1(${STe(0)}*Math.LN2)`));   // F2XM1 (expm1: no cancellation near 0)
            case 0xf1: P(setSTe(1, `${STe(1)}*Math.log2(${STe(0)})`)); return P(FPOP()); // FYL2X
            case 0xf2: P(`cpu.ftrigCC(${STe(0)});`); P(setSTe(0, `Math.tan(${STe(0)})`)); return fpush('1');         // FPTAN (C2: src/fpu.js ftrigCC)
            case 0xf3: P(setSTe(1, `Math.atan2(${STe(1)},${STe(0)})`)); return P(FPOP()); // FPATAN
            case 0xf4: P('cpu.fxtract();'); return fsync();                          // FXTRACT (exponent, then push significand)
            case 0xf5: return P(setSTe(0, `cpu.frem1(${STe(0)},${STe(1)})`));   // FPREM1 (IEEE remainder)
            case 0xf8: return P(setSTe(0, `cpu.fprem(${STe(0)},${STe(1)})`));   // FPREM (truncating quotient, C0-C3)
            case 0xf9: P(setSTe(1, `${STe(1)}*cpu.flog2p1(${STe(0)})`)); return P(FPOP());   // FYL2XP1
            case 0xfa: return P(setSTe(0, `cpu.fprec(Math.sqrt(${STe(0)}))`));      // FSQRT (precision control applies)
            case 0xfb: { const x = NT(); P(`var ${x}=${STe(0)};cpu.ftrigCC(${x});${setSTe(0, `Math.sin(${x})`)}`); return fpush(`Math.cos(${x})`); } // FSINCOS
            case 0xf6: if (FXC) { fd = (fd - 1) & 7; return P(`cpu.ftop=${stIdx(fd)};`); } return P('cpu.ftop=(cpu.ftop-1)&7;');                // FDECSTP (tags untouched)
            case 0xf7: if (FXC) { fd = (fd + 1) & 7; return P(`cpu.ftop=${stIdx(fd)};`); } return P('cpu.ftop=(cpu.ftop+1)&7;');                // FINCSTP
            case 0xfc: return P(setSTe(0, `cpu.f2i(${STe(0)})`));        // FRNDINT
            case 0xfd: return P(setSTe(0, `${STe(0)}*Math.pow(2,Math.trunc(${STe(1)}))`)); // FSCALE
            case 0xfe: P(`cpu.ftrigCC(${STe(0)});`); return P(setSTe(0, `Math.sin(${STe(0)})`));       // FSIN
            case 0xff: P(`cpu.ftrigCC(${STe(0)});`); return P(setSTe(0, `Math.cos(${STe(0)})`));       // FCOS
          }
          return fb();
        case 0xd8: {                                                       // arith with ST(i), result to ST(0)
          const xt = NT(), yt = NT();
          P(`var ${xt}=${STe(0)},${yt}=${STe(rm)};`);
          P(setSTe(0, arithE(reg, xt, yt)));
          if (reg === 2 || reg === 3) P(`cpu.fcmp(${xt},${yt});`);
          if (reg === 3) P(FPOP());
          return;
        }
        case 0xdc:                                                         // arith to ST(i) (reversed quirk)
          if (reg === 2 || reg === 3) { P(`cpu.fcmp(${STe(0)},${STe(rm)});`); if (reg === 3) P(FPOP()); return; }
          return P(setSTe(rm, arithE(reg, `${STe(0)}`, STe(rm))));
        case 0xde:                                                         // arith to ST(i) + pop (faddp etc.)
          if (b === 0xd9) { P(`cpu.fcmp(${STe(0)},${STe(1)});`); P(FPOP()); return P(FPOP()); } // FCOMPP
          P(setSTe(rm, arithE(reg, `${STe(0)}`, STe(rm)))); return P(FPOP());
        case 0xdd:
          if (b < 0xc8) return P(`cpu.ffree(${rm});`);                     // FFREE ST(i)
          if (b < 0xd8) return P(setSTe(rm, `${STe(0)}`));              // FST ST(i)
          if (b < 0xe0) { P(setSTe(rm, `${STe(0)}`)); return P(FPOP()); } // FSTP ST(i)
          P(`cpu.fcmp(${STe(0)},${STe(rm)});`); if (b >= 0xe8) P(FPOP()); return; // FUCOM/FUCOMP
        case 0xdf:
          if (b === 0xe0) return P(`r[0]=(r[0]&~0xffff)|(((cpu.fsw&0x47ff)|((cpu.ftop&7)<<11))&0xffff);`); // FNSTSW AX
          return fb();
        default:
          // DA/DB register forms: rare, so they go to the fpu.js fallback rather than being emitted
          // inline. FCMOVcc lives here and READS EFLAGS, but a fallback call declares no `use`, so
          // dead-flag elimination would happily strip the CMP or FCOMI that set them. Declare it.
          cur.use |= lALL;
          return fb();
      }
    }

    // The VEX-encoded instructions MIRAGE has (src/sse.js VEX): AVX/AVX2 on XMM and YMM, and BMI2's
    // SARX. C5 is the two-byte form (map 0F, W 0); C4 the three-byte one (map, W). VEX.vvvv names a
    // register in ones' complement; R, X and B are the 64-bit extensions, always set in 32-bit code.
    function emitVex(three, ipStart) {
      let map = 1, Wb = 0, b2;
      if (three) { const b1 = f8(); map = b1 & 0x1f; b2 = f8(); Wb = b2 >> 7; } else b2 = f8();
      const vv = (~b2 >> 3) & 7, L = (b2 >> 2) & 1, pp = b2 & 3;
      const opc = f8();
      const ud = () => { canFault = true; P(`cpu.eip=${ipStart};cpu.swInt(6);return;`); ended = true; };
      const src = (o, len) => { if (o.isReg) return o.rm; canFault = true; P(`cpu.vexLoad(${memAddr(o)},${len});`); return XMM_SCRATCH; };
      const op = (code, o, len, imm = 0) => { const s2 = src(o, len); P(`cpu.vex(${code},${L},${o.reg},${vv},${s2},${imm});`); };
      if (map === 1 && pp === 2 && opc === 0x6f) { op(VEX.MOVDQU_LD, modrm(), L ? 32 : 16); return; }          // VMOVDQU x/ymm, m
      if (map === 1 && pp === 1 && opc === 0x6f) { op(VEX.MOVDQU_LD, modrm(), L ? 32 : 16); return; }          // VMOVDQA (alignment not checked)
      if (map === 1 && (pp === 2 || pp === 1) && opc === 0x7f) {                                                // VMOVDQU/A m, x/ymm
        const o = modrm();
        if (o.isReg) { P(`cpu.vex(${VEX.MOVDQU_LD},${L},${o.rm},0,${o.reg},0);`); return; }
        canFault = true; const a = memAddr(o), t = NT(), len = L ? 32 : 16;
        P(`var ${t}=${a};cpu.vexStore(${t},${o.reg},${len});`);
        P(`if(cp[${t}>>>12]|cp[(${AM(`${t}+${len - 1}`)})>>>12])m._dirty(${t},${len});`);
        return;
      }
      if (map === 1 && pp === 1 && opc === 0xdc) { op(VEX.PADDUSB, modrm(), L ? 32 : 16); return; }            // VPADDUSB
      if (map === 1 && pp === 1 && opc === 0x70) { const o = modrm(); const s2 = src(o, L ? 32 : 16); const imm = f8(); P(`cpu.vex(${VEX.PSHUFD},${L},${o.reg},0,${s2},${imm});`); return; }   // VPSHUFD
      if (map === 1 && pp === 1 && opc === 0x6e && !L) { const o = modrm(); P(`cpu.vex(${VEX.MOVD_LD},0,${o.reg},0,0,${rmR(o, 32)});`); return; }   // VMOVD xmm, r/m32
      if (map === 1 && pp === 1 && opc === 0x7e && !L) { const o = modrm(); P(rmW(o, 32, `cpu.xmm.i32[${o.reg * 4}]`)); return; }   // VMOVD r/m32, xmm
      if (map === 2 && pp === 1 && opc === 0x31) { op(VEX.PMOVZXBD, modrm(), L ? 8 : 4); return; }             // VPMOVZXBD
      if (map === 2 && pp === 1 && opc === 0x18 && !Wb) { op(VEX.BROADCASTSS, modrm(), 4); return; }           // VBROADCASTSS
      if (map === 2 && pp === 1 && opc === 0x78 && !Wb) { op(VEX.PBROADCASTB, modrm(), 1); return; }           // VPBROADCASTB
      if (map === 2 && pp === 1 && opc === 0x46 && !Wb) { op(VEX.PSRAVD, modrm(), L ? 32 : 16); return; }      // VPSRAVD
      if (map === 2 && pp === 2 && opc === 0xf7 && !Wb) {                                                       // SARX r32, r/m32, r32
        const o = modrm();
        P(rW(o.reg, 32, `((${rmR(o, 32)})|0)>>(r[${vv}]&31)`)); return;
      }
      ud();
    }

    function emitShift(o, size, cnt) {
      const rot = o.reg;   // 0 rol,1 ror,2 rcl,3 rcr,4/6 shl,5 shr,7 sar
      if (rot === 2 || rot === 3) cur.use |= lC;   // RCL/RCR rotate through carry — read CF
      // Inline the logical/arithmetic shifts with a COMPILE-TIME count (C0/C1/D0/D1) — the hot
      // forms. Mirrors cpu.shl/shr/sar exactly; CF and OF are computed INSIDE the strippable PFLAG
      // with setShiftResult (def CF/OF/PF/ZF/SF, AF preserved), so a shift whose flags the next
      // instruction overwrites is a bare JavaScript shift. 32-bit too: `shl eax,3` in a flat 32-bit
      // program called the helper and computed every flag for an `add` to overwrite (Outline 2021's
      // xorchitecture: 9% of its time). CL counts (runtime c==0 branch) and rotates keep the helper.
      const isShift = rot === 4 || rot === 5 || rot === 6 || rot === 7;
      // The inline fast path assumes the count is smaller than the operand — under the 8088 profile
      // it need not be, and JS's own shift operators mask to 5 bits, so a count of 32 would become 0.
      // Counts at or above the width go to the helper, which handles them explicitly.
      const litC = /^\d+$/.test(cnt) ? (Number(cnt) & SHIFT_MASK) : -1;
      if (isShift && litC >= 0 && litC < size) {
        const C = litC;
        if (C === 0) return;   // shift by 0: value and flags unchanged (byte-exact no-op)
        const msb = size - 1, v = NT(), res = NT();
        let cf, of;
        if (size === 32) {
          if (rot === 5) {                                 // SHR
            P(`var ${v}=(${rmR(o, 32)})>>>0;var ${res}=(${v}>>>${C})>>>0;`);
            cf = `(${v}>>>${C - 1})&1`; of = C === 1 ? `(${v}>>>31)&1` : '0';
          } else if (rot === 7) {                          // SAR
            P(`var ${v}=(${rmR(o, 32)})|0;var ${res}=(${v}>>${C})>>>0;`);
            cf = `(${v}>>${C - 1})&1`; of = '0';
          } else {                                         // SHL (rot 4 or 6)
            P(`var ${v}=(${rmR(o, 32)})>>>0;var ${res}=(${v}<<${C})>>>0;`);
            cf = `(${v}>>>${32 - C})&1`; of = C === 1 ? `((${res}>>>31)&1)^((${v}>>>31)&1)` : '0';
          }
        } else {
          const mask = size === 8 ? 0xff : 0xffff;
          if (rot === 5) {                                 // SHR
            P(`var ${v}=(${rmR(o, size)})&${mask};var ${res}=(${v}>>>${C})&${mask};`);
            cf = `(${v}>>>${C - 1})&1`; of = C === 1 ? `(${v}>>>${msb})&1` : '0';
          } else if (rot === 7) {                          // SAR
            const sv = NT();
            P(`var ${v}=(${rmR(o, size)})&${mask};var ${sv}=((${v}&${1 << msb})?(${v}|${~mask}):${v})|0;var ${res}=(${sv}>>${C})&${mask};`);
            cf = `(${sv}>>${C - 1})&1`; of = '0';
          } else {                                         // SHL (rot 4 or 6)
            P(`var ${v}=(${rmR(o, size)})&${mask};var ${res}=(${v}<<${C})&${mask};`);
            cf = `(${v}>>>${size - C})&1`; of = C === 1 ? `((${res}>>>${msb})&1)^((${v}>>>${size - C})&1)` : '0';
          }
        }
        P(rmW(o, size, res));
        PFLAG(`cpu.setShiftResult(${res},${size},!!(${cf}),!!(${of}));`, lC | lP | lZ | lS | lO);
        return;
      }
      const ops = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'shl', 'sar'];
      P(rmW(o, size, `cpu.${ops[rot]}(${rmR(o, size)},${cnt},${size})`));
    }

    function emitGroup3(size, ipStart) {
      const o = modrm();
      switch (o.reg) {
        case 0: case 1: { const i = size === 8 ? f8() : (size === 16 ? f16() : (f16() | (f16() << 16))); alu('test', rmR(o, size), null, '' + (i >>> 0), size); break; }
        case 2: P(rmW(o, size, `(~${rmR(o, size)})`)); break;                            // NOT
        case 3: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, size)};var ${rr}=(0-${a})${M(size)};${rmW(o, size, rr)}`); PFLAG(`cpu.setSub(0,${a},${rr},${size});`, lALL); break; } // NEG
        case 4:                                                                         // MUL
          if (size === 16) { const s = NT(), p = NT(), hi = NT();
            P(`var ${s}=(${rmR(o, 16)})&0xffff;var ${p}=(r[0]&0xffff)*${s};var ${hi}=(${p}/65536)&0xffff;r[0]=(r[0]&~0xffff)|(${p}&0xffff);r[2]=(r[2]&~0xffff)|${hi};`);
            PFLAG(`cpu.setMul(${p},16,${hi}!==0);`, lALL);
          } else P(`cpu.${size === 8 ? 'mul8' : 'mul32'}(${rmR(o, size)});`);   // 8-bit or 32-bit (66h)
          break;
        case 5:                                                                         // IMUL
          if (size === 16) { const s = NT(), a = NT(), p = NT();
            P(`var ${s}=((${rmR(o, 16)})<<16)>>16;var ${a}=((r[0]&0xffff)<<16)>>16;var ${p}=${a}*${s};r[0]=(r[0]&~0xffff)|(${p}&0xffff);r[2]=(r[2]&~0xffff)|((${p}>>16)&0xffff);`);
            PFLAG(`cpu.setMul(${p},16,(${p}<-32768||${p}>32767));`, lALL);
          } else P(`cpu.${size === 8 ? 'imul8' : 'imul32'}(${rmR(o, size)});`);
          break;
        // DIV/IDIV can raise #DE. The helper vectors the ISR and returns true; we must set eip to the
        // FAULTING instruction first (a #DE is a fault, so that is the pushed return address) and then
        // stop the block — otherwise the rest of it runs and its terminator overwrites cpu.eip, silently
        // discarding the interrupt on a stack that already holds an IRET frame.
        case 6: cur.use |= lALL; canFault = true; P(`cpu.eip=${ipStart};if(cpu.${size === 8 ? 'div8' : size === 16 ? 'div16' : 'div32'}(${rmR(o, size)}))return;`); break;   // DIV
        case 7: cur.use |= lALL; canFault = true; P(`cpu.eip=${ipStart};if(cpu.${size === 8 ? 'idiv8' : size === 16 ? 'idiv16' : 'idiv32'}(${rmR(o, size)}))return;`); break; // IDIV
      }
    }

    // `ipStart` is threaded in rather than read from an enclosing scope: this is a separate
    // function, and referencing an ipStart that is not in scope throws at BLOCK COMPILE time — which
    // took test386 from 20 POST codes to 6 when LSS/LFS/LGS were converted that way.
    function emitGroup5(sz, ipStart) {
      const o = modrm();
      switch (o.reg) {
        case 0: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, sz)};var ${rr}=(${a}+1)${M(sz)};${rmW(o, sz, rr)}`); PFLAG(sz === 32 ? `cpu.setInc32(${a},${rr});` : `cpu.setAdd(${a},1,${rr},${sz},false);`, lNOC); break; }
        case 1: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, sz)};var ${rr}=(${a}-1)${M(sz)};${rmW(o, sz, rr)}`); PFLAG(sz === 32 ? `cpu.setDec32(${a},${rr});` : `cpu.setSub(${a},1,${rr},${sz},false);`, lNOC); break; }
        // Same 0x66 rule as CALL rel: the pushed return address is a dword and the target operand is
        // read at the prefixed size. `o32 call ebx` is test386's POST-5 %%rm32 case.
        case 2: { const tg = NT(); P(`var ${tg}=${rmR(o, sz)};`);
          if (inlineStack(sz)) { canFault = true; P(pushS(SEQ())); P(`cpu.eip=${tg}>>>0;`); P('return;'); ended = true; break; }   // the flat stack: the interpreters' call [table+eax*4]
          P(`${sz === 16 ? `cpu.push16(${SEQ()});` : `cpu.push32(${SEQ()});`}cpu.eip=${sz === 16 ? `${tg}&0xffff` : `${tg}>>>0`};`); P('return;'); ended = true; break; } // CALL Ev
        // CALLF under 0x66 pushes CS and a 32-bit return offset, and reads a 48-bit far pointer.
        // The INDIRECT far forms go through cpu.farCall/farJmp exactly as the direct ones at 0x9a
        // and 0xea do. They used to load CS themselves, which meant a CALL GATE was not honoured
        // here although it was there: a gate descriptor is a SYSTEM descriptor, so loading it as a
        // segment is #GP(selector), and that is what Windows 3.1's DOS extender ran into —
        // `call far [cs:1408]` through selector 00D3, a 286 call gate to 0070:1415, answered with
        // "Standard Mode: Bad Fault in MS-DOS Extender. Fault: 000D ... EC=00D0". The gate support
        // added for 0x9a/0xea simply never reached the FF /3 and FF /5 encodings. farCall also owns
        // the stack discipline this used to open-code: a far CALL that faults pushes nothing and
        // goes nowhere.
        case 3: { const a = memAddr(o); const to = NT(), ts = NT();
          P(sz === 16 ? `var ${to}=m.r16(${a}),${ts}=m.r16(${AM(`${a}+2`)});cpu.eip=${SEQ()};cpu.farCall(${ts},${to},0,${ipStart});`
                      : `var ${to}=m.r32(${a})>>>0,${ts}=m.r16(${AM(`${a}+4`)});cpu.eip=${SEQ()};cpu.farCall(${ts},${to}>>>0,1,${ipStart});`);
          P('return;'); ended = true; break; } // CALLF
        case 4: { const tg = NT(); P(`var ${tg}=${rmR(o, sz)};cpu.eip=${sz === 16 ? `${tg}&0xffff` : `${tg}>>>0`};`); P('return;'); ended = true; break; } // JMP Ev
        // JMPF Ev — the far pointer's layout follows the operand size, as CALLF above: 16-bit is a
        // word offset with the selector at +2, 32-bit a dword offset with the selector at +4.
        case 5: { const a = memAddr(o); const to = NT(), ts = NT();
          // farJmp keeps the rule this used to open-code: a refused selector leaves EIP at THIS
          // instruction, so a delivered fault's entry point is not overwritten on the way out.
          P(sz === 16 ? `var ${to}=m.r16(${a}),${ts}=m.r16(${AM(`${a}+2`)});cpu.eip=${ipStart};cpu.farJmp(${ts},${to},${ipStart},${SEQ()});`
                      : `var ${to}=m.r32(${a})>>>0,${ts}=m.r16(${AM(`${a}+4`)});cpu.eip=${ipStart};cpu.farJmp(${ts},${to}>>>0,${ipStart},${SEQ()});`);
          P('return;'); ended = true; break; } // JMPF
        case 6: if (inlineStack(sz)) { canFault = true; P(pushS(rmR(o, 32))); break; }
          P(sz === 32 ? `cpu.push32(${rmR(o, 32)}>>>0);` : `cpu.push16(${rmR(o, 16)});`); break; // PUSH Ev (honour the operand-size prefix: 66 → push a dword)
      }
    }

    function emitStr(kind, size) {
      const step = size / 8;
      const srcSeg = segOv >= 0 ? segOv : DS;
      // 0x67 switches the string pointers/counter to ESI/EDI/ECX. `67 F3 A4` (REP MOVSB over 32-bit
      // pointers) is a standard 386 fast-copy; without this it silently used SI/DI/CX.
      const iR = (i) => addr32 ? `(r[${i}]>>>0)` : `(r[${i}]&0xffff)`;
      const iAdv = (i) => addr32 ? `r[${i}]=(r[${i}]+_d)>>>0;` : `r[${i}]=(r[${i}]&~0xffff)|((r[${i}]+_d)&0xffff);`;
      const w = size === 8 ? 'r8' : size === 16 ? 'r16' : 'r32';
      const ww = size === 8 ? 'w8' : size === 16 ? 'w16' : 'w32';
      P(`var _d=(cpu.flags&${DF})?-${step}:${step};`);
      const loop = (body, cond) => {
        const wb = addr32 ? 'r[1]=_c>>>0;' : 'r[1]=(r[1]&~0xffff)|_c;';
        if (rep) {
          P(`var _c=${iR(1)};`);
          // Under paging an iteration can #PF, and the instruction restarts from the fault. ESI/EDI
          // are advanced in the registers as the loop goes, the count only in `_c`: without writing
          // it back, the restart ran the FULL count again from the advanced position and overran
          // the destination by everything already copied. KolibriOS's ramdisk read into @ICON's
          // buffer did, faulted on the page after it, and the kernel killed the program.
          if (pfRestart) P('try{');
          P('while(_c>0){');
          P(body);
          P('_c--;');
          if (cond) P(cond);
          P('}');
          if (pfRestart) P(`}catch(_e){${wb}throw _e;}`);
          P(wb);
        } else { P(body); }
      };
      const SI = AM(`sb[${srcSeg}]+${iR(6)}`);
      const DI = AM(`sb[${ES}]+${iR(7)}`);
      const adv = iAdv(6) + iAdv(7);
      const advDI = iAdv(7);
      const advSI = iAdv(6);
      // A single LODS or STOS under paging: the paged probe, as a MOV through ESI or EDI would have it
      // (Valleyball's synthesizer reads its bytecode with lodsb).
      if (!rep && pagedRW && (kind === 'lods' || kind === 'stos')) {
        const a = NT();
        if (kind === 'lods') { P(`var ${a}=${SI};`); P(rW(0, size, memRead(a, size)) + advSI); }
        else { P(`var ${a}=${DI};`); P(memW(a, size, rR(0, size)) + advDI); }
        return;
      }
      /*
       * REP STOS and REP MOVS under paging, 32-bit pointers, forwards: a page at a time. The address is
       * translated once per page (the fast tables, which hold no code page: those stay on the helpers
       * and their self-modification check), and the elements that lie whole within the page, and the
       * source's, are moved there directly, one by one as the CPU moves them (an overlapping MOVS
       * repeats its pattern, as it must). An element across a page, or a page off the tables, goes
       * through the helper, which faults as it did. Valleyball's synthesizer clears its buffers with
       * `rep stosw`: a helper call a word, a sixth of its time.
       */
      const ACC = { 8: ['getUint8', 'setUint8'], 16: ['getUint16', 'setUint16'], 32: ['getUint32', 'setUint32'] }[size];
      const LE = size === 8 ? '' : ',true';
      if (rep && pagedRW && addr32 && kind === 'stos') {
        // A value whose bytes are all one (zero, mostly) is a fill of bytes, whatever the size.
        const v = NT(), same = NT();
        P(`var ${v}=${rR(0, size)},${same}=${size === 8 ? 'true' : size === 16 ? `(${v}&255)===(${v}>>>8)` : `${v}===(Math.imul(${v}&255,0x01010101)>>>0)`};`);
        loop(`var _a=${DI},_o=wro[_a>>>12],_n=_d>0?Math.min(_c,((4096-(_a&4095))/${step})|0):0;` +
          `if(_o===-1||_n<=0){m.${ww}(_a,${v});${advDI}}` +
          `else{var _p=(_o+_a)>>>0;if(${same})u8.fill(${v}&255,_p,_p+${step}*_n);else for(var _i=0;_i<_n;_i++){_dv.${ACC[1]}(_p,${v}${LE});_p+=${step};}r[7]=(r[7]+${step}*_n)>>>0;_c-=_n-1;}`);
        return;
      }
      if (rep && pagedRW && addr32 && kind === 'movs') {
        loop(`var _a=${DI},_s=${SI},_o=wro[_a>>>12],_q=rdo[_s>>>12],_n=_d>0?Math.min(_c,((4096-(_a&4095))/${step})|0,((4096-(_s&4095))/${step})|0):0;` +
          `if(_o===-1||_q===-1||_n<=0){m.${ww}(_a,m.${w}(_s));${adv}}` +
          // Forwards, a copy is memmove's unless the destination starts inside the source past its
          // start: then each element reads one just written, a repeated pattern, element by element.
          `else{var _p=(_o+_a)>>>0,_r=(_q+_s)>>>0,_e=${step}*_n;if(_p<=_r||_p>=_r+_e)u8.copyWithin(_p,_r,_r+_e);else for(var _i=0;_i<_n;_i++){_dv.${ACC[1]}(_p,_dv.${ACC[0]}(_r${LE})${LE});_p+=${step};_r+=${step};}` +
          `r[6]=(r[6]+${step}*_n)>>>0;r[7]=(r[7]+${step}*_n)>>>0;_c-=_n-1;}`);
        return;
      }
      if (kind === 'movs') loop(`m.${ww}(${DI},m.${w}(${SI}));${adv}`);
      else if (kind === 'stos') loop(`m.${ww}(${DI},${rR(0, size)});${advDI}`);
      else if (kind === 'lods') loop(`${rW(0, size, `m.${w}(${SI})`)}${advSI}`);
      else if (kind === 'cmps') loop(`var _x=m.${w}(${SI}),_y=m.${w}(${DI});cpu.setSub(_x,_y,(_x-_y)${M(size)},${size});${adv}`, rep === 0xf3 ? `if(!(cpu.flags&${ZF}))break;` : `if(cpu.flags&${ZF})break;`);
      else if (kind === 'scas') loop(`var _y=m.${w}(${DI});var _x=${rR(0, size)};cpu.setSub(_x,_y,(_x-_y)${M(size)},${size});${advDI}`, rep === 0xf3 ? `if(!(cpu.flags&${ZF}))break;` : `if(cpu.flags&${ZF})break;`);
      else if (kind === 'ins') loop(`m.${ww}(${DI},cpu.ioRead(r[2]&0xffff,${step}));${advDI}`);
      else if (kind === 'outs') loop(`cpu.ioWrite(r[2]&0xffff,${step},m.${w}(${SI}));${advSI}`);
    }

    function decode0F(sz) {
      const op2 = f8();
      // near Jcc rel16/32
      if (op2 >= 0x80 && op2 <= 0x8f) { const rel = sz === 16 ? (f16() << 16 >> 16) : (f16() | (f16() << 16)); endJcc(op2 & 0xf, ipAdd(ip, rel), ip); return; }
      // CMOVcc Gv,Ev (P6+): reg = cond ? Ev : reg
      if (op2 >= 0x40 && op2 <= 0x4f) { cur.use |= lALL; const o = modrm(); const s = NT(); P(`var ${s}=${rmR(o, sz)};if(${condExpr(op2 & 0xf)}){${rW(o.reg, sz, s)}}`); return; }
      // SETcc Eb
      if (op2 >= 0x90 && op2 <= 0x9f) { cur.use |= lALL; const o = modrm(); P(rmW(o, 8, `${condExpr(op2 & 0xf)}?1:0`)); return; }
      // BSWAP r32 (0F C8+r): reverse the byte order of a 32-bit register (486+); flags untouched
      if (op2 >= 0xc8 && op2 <= 0xcf) { const r = op2 - 0xc8, b = NT(); P(`var ${b}=r[${r}]>>>0;r[${r}]=((${b}<<24)|((${b}&0xff00)<<8)|((${b}>>>8)&0xff00)|(${b}>>>24))>>>0;`); return; }
      // ---- MMX (src/mmx.js): the forms with no mandatory prefix ---------------------------------
      // After each, what the block knows of the x87 stack is read again (fsync): MMX moves its top.
      if (!(d ? sz === 16 : sz === 32) && rep === 0 &&
          (MMX_OPS.has(op2) || op2 === 0x6e || op2 === 0x7e || op2 === 0x7f || op2 === 0x77 || (op2 >= 0x70 && op2 <= 0x73) ||
           op2 === 0xc4 || op2 === 0xc5 || op2 === 0xd7 || op2 === 0xe7)) {
        usesFPU = true;
        if (op2 === 0x77) { P('cpu.emms();'); fsync(); return; }                                   // EMMS
        const o = modrm();
        if (op2 === 0x6e) { P(`cpu.mmMovdIn(${o.reg},${rmR(o, 32)});`); fsync(); return; }          // MOVD mm, r/m32
        if (op2 === 0x7e) { if (!o.isReg) canFault = true; P(rmW(o, 32, `cpu.mmMovdOut(${o.reg})`)); fsync(); return; }   // MOVD r/m32, mm
        if (op2 === 0x70) {                                                                          // PSHUFW mm, mm/m64, imm8
          let s2 = o.rm;
          if (!o.isReg) { canFault = true; P(`cpu.mmLoad(${memAddr(o)},8);`); s2 = MM_SCRATCH; }
          P(`cpu.mmShufw(${o.reg},${s2},${f8()});`); fsync(); return;
        }
        if (op2 === 0xc4) { const v = rmR(o, o.isReg ? 32 : 16); P(`cpu.mmInsrw(${o.reg},${v},${f8()});`); fsync(); return; }   // PINSRW mm, r32/m16, imm8
        if (op2 === 0xc5 || op2 === 0xd7) {                                                          // PEXTRW r32, mm, imm8; PMOVMSKB r32, mm
          if (!o.isReg) { P(`cpu.eip=${curIpStart};cpu.raise(6);`); P('return;'); ended = true; return; }
          P(rW(o.reg, 32, op2 === 0xc5 ? `cpu.mmExtrw(${o.rm},${f8()})` : `cpu.mmMovmskb(${o.rm})`)); fsync(); return;
        }
        if (op2 === 0x7f || op2 === 0xe7) {                                                          // MOVQ mm/m64, mm; MOVNTQ m64, mm
          if (op2 === 0xe7 && o.isReg) { P(`cpu.eip=${curIpStart};cpu.raise(6);`); P('return;'); ended = true; return; }
          if (o.isReg) P(`${MM_ENTER}${mmxInline(MMX.MOVQ, o.rm, o.reg, -1)}`);
          else {
            canFault = true; const a = memAddr(o), t = NT();
            P(pfRestart ? `var ${t}=${a};${mmStorePaged(t, o.reg)}` : `var ${t}=${a};cpu.mmStore(${t},${o.reg});`);
            P(`if(cp[${t}>>>12]|cp[(${AM(`${t}+7`)})>>>12])m._dirty(${t},8);`);
          }
          fsync(); return;
        }
        if (op2 >= 0x71 && op2 <= 0x73) {                                                            // shifts by an immediate
          const imm = f8();
          const code = { 0x71: { 2: MMX.PSRLW, 4: MMX.PSRAW, 6: MMX.PSLLW }, 0x72: { 2: MMX.PSRLD, 4: MMX.PSRAD, 6: MMX.PSLLD },
            0x73: { 2: MMX.PSRLQ, 6: MMX.PSLLQ } }[op2][o.reg];
          if (code === undefined || !o.isReg) { P(`cpu.eip=${curIpStart};cpu.raise(6);`); P('return;'); ended = true; return; }
          const js = mmxInline(code, o.rm, 0, imm);
          P(js !== null ? `${MM_ENTER}{${js}}` : `cpu.mmx(${code},${o.rm},0,${imm});`); fsync(); return;
        }
        // mm, mm/m64 -- the low unpacks read only 32 bits of memory
        let s = o.rm;
        if (!o.isReg) {
          canFault = true; const len = op2 >= 0x60 && op2 <= 0x62 ? 4 : 8;
          if (pfRestart) { const t = NT(); P(`var ${t}=${memAddr(o)};${mmLoadPaged(t, len)}`); } else P(`cpu.mmLoad(${memAddr(o)},${len});`);
          s = MM_SCRATCH;
        }
        const js = mmxInline(op2, o.reg, s, -1);
        P(js !== null ? `${MM_ENTER}{${js}}` : `cpu.mmx(${op2},${o.reg},${s},-1);`); fsync(); return;
      }
      // ---- SSE / SSE2 / SSE4.1 on XMM ----------------------------------------------------------
      // The set real DOS software reaches for, not the whole ISA — see src/sse.js. The mandatory
      // prefixes select the instruction here rather than the operand size, so `0x66` is read back off
      // `sz` (the prefix loop already consumed it) and `0xF3` off `rep`.
      {
        const p66 = d ? sz === 16 : sz === 32, pF3 = rep === 0xf3;
        // A memory operand is loaded into the scratch slot first, so every op sees two registers.
        const xmmSrc = (o, len) => {
          if (o.isReg) return o.rm;
          canFault = true;
          P(`cpu.xmmLoad(${memAddr(o)},${len});`);
          return XMM_SCRATCH;
        };
        const xmmStore = (o, reg, len) => {
          canFault = true;
          const a = memAddr(o), t = NT();
          P(`var ${t}=${a};cpu.xmmStore(${t},${reg},${len});`);
          P(`if(cp[${t}>>>12]|cp[(${AM(`${t}+${len - 1}`)})>>>12])m._dirty(${t},${len});`);
        };
        // cpu.sse for the first twenty-one operations (Chrome Revenge's), cpu.xmm.op for the rest.
        const fx = (code) => (code >= SSE.ADDSS ? 'cpu.xmm.op' : 'cpu.sse');
        const simple = (code, len = 16) => { const o = modrm(); P(`${fx(code)}(${code},${o.reg},${xmmSrc(o, len)},0);`); };
        const withImm = (code, len = 16) => {
          const o = modrm(); const src = xmmSrc(o, len); const imm = f8();
          P(`${fx(code)}(${code},${o.reg},${src},${imm});`);
        };
        // The table of src/sse.js's later operations: [prefix, opcode] -> [operation, bytes a memory
        // source has, 'i' when an immediate follows]. Prefixes: '' none, 66, F3, F2.
        const pF2 = rep === 0xf2, pfx = p66 ? '66' : pF3 ? 'F3' : pF2 ? 'F2' : '';
        // 0F AE: LDMXCSR and STMXCSR (MXCSR is kept and read back; the operations here round to
        // nearest whatever it says), LFENCE / MFENCE / SFENCE (nothing to order).
        if (pfx === '' && op2 === 0xae) {
          const o = modrm();
          if (o.isReg && o.reg >= 5) return;
          if (!o.isReg && o.reg === 2) { canFault = true; P(`cpu.xmm.mxcsr=(${rmR(o, 32)})&0xffff;`); return; }
          if (!o.isReg && o.reg === 3) { canFault = true; P(rmW(o, 32, 'cpu.xmm.mxcsr')); return; }
          if (endBefore()) return;
          throw new Error(unimplemented(`0f ae /` + o.reg, mask(linStart - ip0 + ip - 1), mem, rec));
        }
        const T = SSE_TABLE[pfx + op2.toString(16).padStart(2, '0')];
        if (T) { if (T[2]) withImm(T[0], T[1]); else simple(T[0], T[1]); return; }
        // Loads whose register and memory forms differ, stores, and the half-register moves.
        const store = (o, reg, len, hi) => { if (hi) { P(`cpu.xmm.op(${SSE.HI2LO},${XMM_SCRATCH},${reg},0);`); xmmStore(o, XMM_SCRATCH, len); } else xmmStore(o, reg, len); };
        const k = pfx + op2.toString(16).padStart(2, '0');
        if (k === '10' || k === '6610' || k === '6628' || k === '666f' || k === 'F36f') { simple(SSE.MOVAPS_LD); return; }      // MOVUPS, MOVUPD, MOVAPD, MOVDQA, MOVDQU
        if (k === '11' || k === '6611' || k === '6629' || k === '2b' || k === '662b' || k === '667f' || k === 'F37f' || k === '66e7') {
          const o = modrm(); if (o.isReg) P(`cpu.sse(${SSE.MOVAPS_ST},${o.rm},${o.reg},0);`); else store(o, o.reg, 16); return;
        }
        if (k === 'F210') { const o = modrm(); P(`cpu.xmm.op(${o.isReg ? SSE.MOVSD_LD : SSE.MOVSD_LD_M},${o.reg},${xmmSrc(o, 8)},0);`); return; }
        if (k === 'F211') { const o = modrm(); if (o.isReg) P(`cpu.xmm.op(${SSE.MOVSD_LD},${o.rm},${o.reg},0);`); else store(o, o.reg, 8); return; }
        if (k === 'F37e') { const o = modrm(); P(`cpu.xmm.op(${SSE.MOVQ_LD},${o.reg},${xmmSrc(o, 8)},0);`); return; }
        if (k === '66d6') { const o = modrm(); if (o.isReg) P(`cpu.xmm.op(${SSE.MOVQ_LD},${o.rm},${o.reg},0);`); else store(o, o.reg, 8); return; }
        if (k === '12' || k === '6612') { const o = modrm(); P(`cpu.xmm.op(${o.isReg ? SSE.MOVHLPS : SSE.MOVLO},${o.reg},${xmmSrc(o, 8)},0);`); return; }   // MOVLPS / MOVHLPS
        if (k === '16' || k === '6616') { const o = modrm(); P(`cpu.xmm.op(${o.isReg ? SSE.MOVLHPS : SSE.MOVHI},${o.reg},${xmmSrc(o, 8)},0);`); return; }  // MOVHPS / MOVLHPS
        if (k === '13' || k === '6613' || k === '17' || k === '6617') { const o = modrm(); if (o.isReg) { P(`cpu.eip=${curIpStart};cpu.raise(6);`); P('return;'); ended = true; return; } store(o, o.reg, 8, op2 === 0x17); return; }
        // COMISS / UCOMISS / COMISD / UCOMISD: ZF PF CF from the compare, OF SF AF cleared.
        if (k === '2e' || k === '2f' || k === '662e' || k === '662f') {
          const o = modrm(), src = xmmSrc(o, p66 ? 8 : 4);
          P(`cpu.flags=(cpu.flags&~0x8d5)|cpu.xmm.comi(${o.reg},${src},${p66 ? 1 : 0});`); return;
        }
        // CVTSI2SD, CVTTSD2SI, CVTSD2SI: as their single-precision twins below, on the low double.
        if (k === 'F22a') { const o = modrm(); P(`cpu.xmm.d[${o.reg * 2}]=${rmR(o, 32)}|0;`); return; }
        // MOVMSKPS / MOVMSKPD r32, xmm: the lanes' sign bits, the rest of the register zero. GameMaker Studio
        // 2's runner (MSVC's SSE2 pow and exp) tests its arguments so.
        if (k === '50' || k === '6650') {
          const o = modrm(), b = o.rm * 4;
          if (!o.isReg) { P(`cpu.eip=${curIpStart};cpu.raise(6);`); P('return;'); ended = true; return; }
          P(p66 ? `r[${o.reg}]=((cpu.xmm.i32[${b + 1}]>>>31)|((cpu.xmm.i32[${b + 3}]>>>31)<<1))>>>0;`
            : `r[${o.reg}]=((cpu.xmm.i32[${b}]>>>31)|((cpu.xmm.i32[${b + 1}]>>>31)<<1)|((cpu.xmm.i32[${b + 2}]>>>31)<<2)|((cpu.xmm.i32[${b + 3}]>>>31)<<3))>>>0;`);
          return;
        }
        // PEXTRW r32, xmm, imm8 (a word, zero-extended); PINSRW xmm, r32/m16, imm8; PMOVMSKB r32, xmm (the
        // sixteen bytes' sign bits): the SSE2 forms of MMX's.
        if (k === '66c5' || k === '66d7') {
          const o = modrm();
          if (!o.isReg) { P(`cpu.eip=${curIpStart};cpu.raise(6);`); P('return;'); ended = true; return; }
          if (op2 === 0xc5) { const i = f8() & 7; P(`r[${o.reg}]=cpu.xmm.u8[${o.rm * 16 + 2 * i}]|(cpu.xmm.u8[${o.rm * 16 + 2 * i + 1}]<<8);`); return; }
          const t = NT(); P(`var ${t}=0;for(var q=0;q<16;q++)${t}|=(cpu.xmm.u8[${o.rm * 16}+q]>>>7)<<q;r[${o.reg}]=${t};`); return;
        }
        // PSHUFLW / PSHUFHW xmm, xmm/m128, imm8: the low (high) four words shuffled, the other half copied.
        if (k === 'F270' || k === 'F370') {
          const o = modrm(), s = xmmSrc(o, 16), imm = f8(), w = NT(), hi = k === 'F370' ? 8 : 0;
          P(`var ${w}=cpu.xmm.u8.slice(${s * 16},${s * 16 + 16});cpu.xmm.u8.set(${w},${o.reg * 16});`);
          for (let i = 0; i < 4; i++) { const from = hi + 2 * ((imm >> (2 * i)) & 3); P(`cpu.xmm.u8[${o.reg * 16 + hi + 2 * i}]=${w}[${from}];cpu.xmm.u8[${o.reg * 16 + hi + 2 * i + 1}]=${w}[${from + 1}];`); }
          return;
        }
        if (k === '66c4') {
          const o = modrm(), v = NT(); P(`var ${v}=${rmR(o, o.isReg ? 32 : 16)};`);
          const i = f8() & 7; P(`cpu.xmm.u8[${o.reg * 16 + 2 * i}]=${v}&255;cpu.xmm.u8[${o.reg * 16 + 2 * i + 1}]=(${v}>>>8)&255;`); return;
        }
        if (k === 'F22c' || k === 'F22d') {
          const o = modrm(), src = xmmSrc(o, 8), v = NT(), t = NT();
          P(`var ${v}=cpu.xmm.d[${src * 2}];`);
          P(op2 === 0x2c ? `var ${t}=Math.trunc(${v});`
            : `var ${t}=cpu.xmm.round(${v});`);
          P(`r[${o.reg}]=(${t}!==${t}||${t}>2147483647||${t}<-2147483648)?0x80000000:(${t}>>>0);`);
          return;
        }
        // Shifts of XMM by an immediate: 66 0F 71/72/73 /n ib.
        if (p66 && (op2 === 0x71 || op2 === 0x72 || op2 === 0x73)) {
          const o = modrm(), imm = f8();
          const code = { 0x71: { 2: SSE.PSRLW, 4: SSE.PSRAW, 6: SSE.PSLLW }, 0x72: { 2: SSE.PSRLD, 4: SSE.PSRAD, 6: SSE.PSLLD },
            0x73: { 2: SSE.PSRLQ, 3: SSE.PSRLDQ, 6: SSE.PSLLQ, 7: SSE.PSLLDQ } }[op2][o.reg];
          if (code === undefined || !o.isReg) { P(`cpu.eip=${curIpStart};cpu.raise(6);`); P('return;'); ended = true; return; }
          P(`cpu.xmm.op(${code},${o.rm},-1,${imm});`); return;
        }
        if (!p66 && !pF3 && op2 === 0x28) { simple(SSE.MOVAPS_LD); return; }
        if (!p66 && !pF3 && op2 === 0x29) { const o = modrm(); if (o.isReg) P(`cpu.sse(${SSE.MOVAPS_ST},${o.rm},${o.reg},0);`); else xmmStore(o, o.reg, 16); return; }
        if (pF3 && op2 === 0x10) { const o = modrm(); P(`cpu.sse(${o.isReg ? SSE.MOVSS_LD : SSE.MOVSS_LD_M},${o.reg},${xmmSrc(o, 4)},0);`); return; }
        if (pF3 && op2 === 0x11) { const o = modrm(); if (o.isReg) P(`cpu.sse(${SSE.MOVSS_ST},${o.rm},${o.reg},0);`); else xmmStore(o, o.reg, 4); return; }
        // CVTTSS2SI / CVTSS2SI r32, xmm/m32 (truncated; rounded to nearest even, MXCSR's default) and
        // CVTSI2SS xmm, r/m32 (the low float only): Retrospection's Linux port (2010) converts its
        // synthesizer's samples so. Out of range or NaN gives 80000000h, the integer indefinite.
        if (pF3 && (op2 === 0x2c || op2 === 0x2d)) {
          const o = modrm(), src = xmmSrc(o, 4), v = NT(), t = NT();
          P(`var ${v}=cpu.xmm.f[${src * 4}];`);
          P(op2 === 0x2c ? `var ${t}=Math.trunc(${v});`
            : `var ${t}=cpu.xmm.round(${v});`);
          P(`r[${o.reg}]=(${t}!==${t}||${t}>2147483647||${t}<-2147483648)?0x80000000:(${t}>>>0);`);
          return;
        }
        if (pF3 && op2 === 0x2a) { const o = modrm(); P(`cpu.xmm.f[${o.reg * 4}]=Math.fround(${rmR(o, 32)}|0);`); return; }
        // Between MMX and SSE (no prefix): CVTPI2PS xmm, mm/m64 -- two integers to the two low floats, the upper
        // two kept -- and CVTTPS2PI / CVTPS2PI mm, xmm/m64, the two low floats to integers (truncated; rounded to
        // nearest even), 80000000h out of range. Unreal Tournament's Pentium III code (1999) converts its vertices so.
        if (!p66 && !pF3 && !pF2 && op2 === 0x2a) {
          const o = modrm(), src = o.isReg ? -1 : xmmSrc(o, 8);
          const lane = (k) => (o.isReg ? `cpu.mm.i32[${o.rm * 2 + k}]` : `cpu.xmm.i32[${src * 4 + k}]`);
          P(`${MM_ENTER}cpu.xmm.f[${o.reg * 4}]=Math.fround(${lane(0)});cpu.xmm.f[${o.reg * 4 + 1}]=Math.fround(${lane(1)});`);
          return;
        }
        if (!p66 && !pF3 && !pF2 && (op2 === 0x2c || op2 === 0x2d)) {
          const o = modrm(), src = xmmSrc(o, 8);
          P(MM_ENTER);
          for (let k = 0; k < 2; k++) {
            const v = NT(), t = NT();
            P(`var ${v}=cpu.xmm.f[${src * 4 + k}];`);
            P(op2 === 0x2c ? `var ${t}=Math.trunc(${v});`
              : `var ${t}=cpu.xmm.round(${v});`);
            P(`cpu.mm.i32[${o.reg * 2 + k}]=(${t}!==${t}||${t}>2147483647||${t}<-2147483648)?-2147483648:${t};`);
          }
          return;
        }
        if (!p66 && !pF3 && op2 === 0x58) { simple(SSE.ADDPS); return; }
        if (!p66 && !pF3 && op2 === 0x59) { simple(SSE.MULPS); return; }
        if (!p66 && !pF3 && op2 === 0x5c) { simple(SSE.SUBPS); return; }
        if (!p66 && !pF3 && op2 === 0x57) { simple(SSE.XORPS); return; }
        if (!p66 && !pF3 && op2 === 0x52) { simple(SSE.RSQRTPS); return; }
        if (!p66 && !pF3 && op2 === 0x5b) { simple(SSE.CVTDQ2PS); return; }
        if (!p66 && !pF3 && op2 === 0xc6) { withImm(SSE.SHUFPS); return; }
        if (p66 && op2 === 0x5b) { simple(SSE.CVTPS2DQ); return; }
        if (p66 && op2 === 0x76) { simple(SSE.PCMPEQD); return; }
        // MOVD xmm, r/m32 (the rest of the XMM register zeroed, a YMM upper half left alone) and
        // MOVD r/m32, xmm: Outline 2023's The light moves a pixel through XMM0 this way.
        if (p66 && op2 === 0x6e) { const o = modrm(); const v = NT(); P(`var ${v}=(${rmR(o, 32)})|0;cpu.xmm.i32[${o.reg * 4}]=${v};cpu.xmm.i32[${o.reg * 4 + 1}]=0;cpu.xmm.i32[${o.reg * 4 + 2}]=0;cpu.xmm.i32[${o.reg * 4 + 3}]=0;`); return; }
        if (p66 && op2 === 0x7e) { const o = modrm(); if (!o.isReg) canFault = true; P(rmW(o, 32, `cpu.xmm.i32[${o.reg * 4}]`)); return; }
        if (p66 && op2 === 0x67) { simple(SSE.PACKUSWB); return; }
        if (p66 && op2 === 0x6b) { simple(SSE.PACKSSDW); return; }
        if (p66 && op2 === 0xe0) { simple(SSE.PAVGB); return; }
        if (p66 && op2 === 0x38) {                       // three-byte 0F 38 escape
          const op3 = f8();
          if (op3 === 0x23) { simple(SSE.PMOVSXWD, 8); return; }
          if (op3 === 0x31) { simple(SSE.PMOVZXBD, 4); return; }
          if (endBefore()) return;
          throw new Error(unimplemented(`0f 38 ` + op3.toString(16).padStart(2, '0'), mask(linStart - ip0 + ip - 1), mem, rec));
        }
        if (p66 && op2 === 0x3a) {                       // three-byte 0F 3A escape
          const op3 = f8();
          if (op3 === 0x21) { withImm(SSE.INSERTPS, 4); return; }
          if (op3 === 0x40) { withImm(SSE.DPPS); return; }
          if (endBefore()) return;
          throw new Error(unimplemented(`0f 3a ` + op3.toString(16).padStart(2, '0'), mask(linStart - ip0 + ip - 1), mem, rec));
        }
      }

      // BTx Ev,Gv (reg bit offset) and group 0F BA Ev,imm8
      // BT/BTS/BTR/BTC. For a REGISTER destination the bit offset is masked to the operand width.
      // For MEMORY it is a **full signed bit-string index**: the byte accessed is base + (ofs>>3)
      // and the bit is ofs&7, so an offset of 100 reaches the 12th byte and a negative one reaches
      // backwards. Masking it (as this did) folded every access back into the first word — which is
      // exactly wrong for the bitmap scans these instructions exist for (allocators, collision masks).
      const bt = (o, kind, bitExpr) => {
        const b = NT(), v = NT();
        if (o.isReg) {
          P(`var ${b}=(${bitExpr})&${sz - 1};var ${v}=${rmR(o, sz)};`);
          P(`cpu.flags=(cpu.flags&~${CF})|((${v}>>>${b})&1);`);
          if (kind === 'bts') P(rmW(o, sz, `(${v}|(1<<${b}))`));
          else if (kind === 'btr') P(rmW(o, sz, `(${v}&~(1<<${b}))`));
          else if (kind === 'btc') P(rmW(o, sz, `(${v}^(1<<${b}))`));
          return;
        }
        const ofs = NT(), ad = NT();
        P(`var ${ofs}=(${bitExpr})${sz === 16 ? '<<16>>16' : '|0'};`);      // signed bit index
        // The byte displacement belongs to the EFFECTIVE ADDRESS, not the linear one: under 16-bit
        // addressing it wraps inside the segment, and a register bit offset is easily large enough to
        // reach that. Adding it to the linear address instead walked out of the segment entirely —
        // which is every failing `bt [bp+di],edx` in the 80386 vectors.
        P(`var ${ad}=${lin(o.seg, `((${o.off}+(${ofs}>>3))${addr32 ? '>>>0' : '&0xffff'})`)};`);
        P(`var ${b}=${ofs}&7;var ${v}=${memRead(ad, 8)};`);
        P(`cpu.flags=(cpu.flags&~${CF})|((${v}>>>${b})&1);`);
        if (kind === 'bts') P(memW(ad, 8, `(${v}|(1<<${b}))`));
        else if (kind === 'btr') P(memW(ad, 8, `(${v}&~(1<<${b}))`));
        else if (kind === 'btc') P(memW(ad, 8, `(${v}^(1<<${b}))`));
      };
// A privileged instruction outside ring 0 raises #GP(0). Emitted rather than assumed, because the
// same opcode is legal at CPL 0 and the check has to be made at run time. test386 arms an expected
// EX_GP (13) and falls into `jmp error` if the fault never arrives, which is how POST 20 fails.
      switch (op2) {
        case 0x00: {                                                                    // group 6: SLDT/STR/LLDT/LTR/VERR/VERW
          const o = modrm();
          if (o.reg === 0) { P(rmW(o, 16, 'cpu.ldtr.sel')); return; }                    // SLDT
          if (o.reg === 1) { P(rmW(o, 16, 'cpu.tr.sel')); return; }                       // STR
          if (o.reg === 2) { P(`cpu.loadLDT(${rmR(o, 16)});`); return; }                  // LLDT
          // VERR/VERW. See cpu.verifySeg: this was `cpu.flags |= ZF`, a stub that always said yes.
          if (o.reg === 4 || o.reg === 5) { const t = NT();
            P(`var ${t}=cpu.verifySeg(${rmR(o, 16)},${o.reg === 5 ? 1 : 0});`);
            P(`if(${t}){cpu.flags|=${ZF};}else{cpu.flags&=~${ZF};}`); return; }
          if (o.reg === 3) { P(`cpu.loadTR(${rmR(o, 16)});`); return; }                  // LTR
          if (!o.isReg) memAddr(o);
          return;
        }
        // CLTS — clear CR0.TS. We do not model TS, so clearing it is exact.
        case 0x06: P('cpu.cr0&=~8;'); return;
        // INVD / WBINVD (486+) — no cache is modelled, so there is nothing to write back or drop;
        // privileged like HLT. KolibriOS's kernel runs WBINVD while it sets up memory.
        case 0x08: case 0x09:
          canFault = true;
          P(`if((cpu.cr0&1)&&${CPL_EXPR}){cpu.eip=${curIpStart};cpu.raise(13,0);return;}`);
          return;
        // LAR / LSL Gv,Ew. ZF reports accessibility; the helper returns -1 so this tests once.
        case 0x02: case 0x03: {
          const o = modrm(); const t = NT();
          P(`var ${t}=${op2 === 0x02 ? `cpu.larRights(${rmR(o, 16)},${sz === 32 ? 1 : 0})` : `cpu.lslLimit(${rmR(o, 16)})`};`);
          P(`if(${t}<0){cpu.flags&=~${ZF};}else{cpu.flags|=${ZF};${rW(o.reg, sz, t)}}`);
          return;
        }
        case 0x01: {                                                                    // group 7: SGDT/SIDT/SMSW/LGDT/LIDT/LMSW/INVLPG
          const o = modrm();
          // SMSW. To MEMORY it is 16 bits, always. To a REGISTER with a 32-bit operand size it
          // stores the whole of CR0 — kvm-unit-tests sets CR0 bit 30 and checks SMSW gives it back,
          // and masking to 16 bits loses it.
          if (o.reg === 4) { P(rmW(o, o.isReg ? sz : 16, o.isReg && sz === 32 ? `(cpu.cr0>>>0)` : `(cpu.cr0&0xffff)`)); return; }
          // LMSW loads MP/EM/TS and can SET PE, but never CLEAR it (Intel SDM: only MOV CR0 returns to
          // real mode). DOOM's DOS/4GW, under EMM386, runs `smsw cx / ... / and ax,cx / lmsw ax` with PE
          // clear in AX; applying it dropped the CPU into "real mode with paging on" and every block after
          // derailed, while QEMU stayed in protected mode and DOOM started.
          if (o.reg === 6) { needChecked = REAL; const s = NT(); P(`var ${s}=${rmR(o, 16)};cpu.setCR0((cpu.cr0&~0xf)|(${s}&0xf)|(cpu.cr0&1));`); return; }
          // SGDT/SIDT store a 6-byte pseudo-descriptor: 16-bit limit then 32-bit base.
          if (o.reg === 0 || o.reg === 1) {
            const a = memAddr(o), t = o.reg === 0 ? 'gdtr' : 'idtr';
            P(`m.w16(${a},cpu.${t}.limit&0xffff);m.w32(${AM(`${a}+2`)},cpu.${t}.base>>>0);`);
            return;
          }
          // LGDT/LIDT load it. Without a 0x66 prefix the base is truncated to 24 bits on a 386 —
          // that is architectural, not an approximation, and code that loads a table above 16 MiB
          // from a 16-bit segment relies on knowing it.
          if (o.reg === 2 || o.reg === 3) {
            const a = memAddr(o), t = o.reg === 2 ? 'gdtr' : 'idtr';
            P(`cpu.${t}.limit=m.r16(${a});cpu.${t}.base=(m.r32(${AM(`${a}+2`)})&${sz === 32 ? '0xffffffff' : '0xffffff'})>>>0;`);
            return;
          }
          // INVLPG m: drop the software-TLB entry for that linear page and any blocks translated from
          // it — the page may now be another frame, or absent. Privileged, like MOV CR3.
          if (o.reg === 7 && !o.isReg) {
            canFault = true;
            const a = memAddr(o);
            P(`if((cpu.cr0&1)&&${CPL_EXPR}){cpu.eip=${curIpStart};cpu.raise(13,0);return;}`);
            P(`cpu.invlpg(${a});`);
            return;
          }
          if (!o.isReg) memAddr(o);
          return;
        }
        case 0x20: { const o = modrm(); const src = o.reg === 0 ? '(cpu.cr0>>>0)' : o.reg === 2 ? '(cpu.cr2>>>0)' : o.reg === 3 ? '(cpu.cr3>>>0)' : o.reg === 4 ? '(cpu.cr4>>>0)' : '0';
          P(rW(o.rm, 32, src)); return; }                                               // MOV r32, CRn
        // MOV CRn, r32. CR0 bit 0 (PE) now really switches how selectors resolve, so this ends the
        // block: the very next instruction is normally the far jump that reloads CS, and the code
        // after it must be translated under the new CS.D.
        case 0x22: {
          const o = modrm();
          if (o.reg === 0) { P(`cpu.setCR0(${rR(o.rm, 32)});cpu.eip=${SEQ()};`); P('return;'); ended = true; }
          else if (o.reg === 3) { P(`cpu.setCR3(${rR(o.rm, 32)});cpu.eip=${SEQ()};`); P('return;'); ended = true; }
          else if (o.reg === 2) P(`cpu.cr2=${rR(o.rm, 32)}>>>0;`);
          // CR4 ends the block like CR0/CR3: turning PSE on or off changes every later translation.
          else if (o.reg === 4) { P(`cpu.setCR4(${rR(o.rm, 32)});cpu.eip=${SEQ()};`); P('return;'); ended = true; }
          else P(`${rR(o.rm, 32)};`);
          return;
        }
        // MOV to and from the debug registers. Two things the old pair got wrong, both caught by
        // kvm-unit-tests' `mov dr with mod bits`: the MOD FIELD IS IGNORED — `0f 21 00` is
        // MOV EAX, DR0 and not a memory operand, so decoding it as one consumed a displacement and
        // desynchronised the stream — and a value written to a debug register has to be readable
        // again. They are storage here and nothing more: no breakpoints are implemented, which is
        // why DR6/DR7 keep only the bits a write can set.
        case 0x21: { const o = modrmReg(); P(rW(o.rm, 32, `(cpu.dr[${o.reg}]>>>0)`)); return; }   // MOV r32, DRn
        case 0x23: { const o = modrmReg(); P(`cpu.dr[${o.reg}]=${rR(o.rm, 32)};`); return; }      // MOV DRn, r32
        // 0F 1F /0 is NOP; 0F 19-1E are the "reserved-NOP" hints of the SDM's opcode map, which QEMU
        // also executes as NOPs (its 0x119-0x11f) — among them ENDBR32 (F3 0F 1E FB), which gcc's
        // -fcf-protection puts at every function entry: FreeNOS stopped on it. 0F 18 /0-3 are the
        // PREFETCH hints, NOPs too as far as a guest can tell.
        case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e:
        case 0x1f: modrm(); return;                                                     // multi-byte NOP and hints
        case 0x31: P('cpu.reg[0]=(cpu.cycles>>>0);cpu.reg[2]=(Math.floor(cpu.cycles/4294967296))>>>0;'); return; // RDTSC → EDX:EAX
        // RDMSR / WRMSR: ring 0 only, #GP(0) for a register the part does not have (cpu.rdmsr).
        case 0x32: P(`cpu.eip=${curIpStart};if(!cpu.rdmsr())return;`); return;
        case 0x30: P(`cpu.eip=${curIpStart};if(!cpu.wrmsr())return;`); return;
        // CMPXCHG8B m64 (0F C7 /1, Pentium). Only ZF changes, so every other flag is still live.
        // The register form and the other /r values are #UD.
        case 0xc7: {
          const o = modrm();
          if (!o.isReg && o.reg === 1) {
            cur.use |= lALL;
            const a = memAddr(o, 64);
            P(wrGuard(o.seg) + `cpu.cmpxchg8b(${a},${AM(`${a}+4`)});`); return;
          }
          if ((rec._udSeen = true, guestOwnsUD(mem, rec.cpu))) { P(`cpu.eip=${curIpStart};cpu.raise(6);`); P('return;'); ended = true; return; }
          if (endBefore()) return;
          throw new Error(unimplemented('0f 0xc7 /' + o.reg, mask(linStart - ip0 + ip - 2), mem, rec));
        }
        case 0xa0: P(sz === 16 ? `cpu.push16(cpu.seg[${FS}]);` : `cpu.push32(cpu.seg[${FS}]);`); return;   // PUSH FS
        case 0xa1: P(sz === 16 ? `cpu.setSeg(${FS},cpu.pop16());` : `cpu.setSeg(${FS},cpu.pop32()&0xffff);`); return;  // POP FS
        case 0xa8: P(sz === 16 ? `cpu.push16(cpu.seg[${GS}]);` : `cpu.push32(cpu.seg[${GS}]);`); return;   // PUSH GS
        case 0xa9: P(sz === 16 ? `cpu.setSeg(${GS},cpu.pop16());` : `cpu.setSeg(${GS},cpu.pop32()&0xffff);`); return;  // POP GS
        case 0xa3: { const o = modrm(); bt(o, 'bt', rR(o.reg, sz)); return; }            // BT
        case 0xab: { const o = modrm(); bt(o, 'bts', rR(o.reg, sz)); return; }           // BTS
        case 0xb3: { const o = modrm(); bt(o, 'btr', rR(o.reg, sz)); return; }           // BTR
        case 0xbb: { const o = modrm(); bt(o, 'btc', rR(o.reg, sz)); return; }           // BTC
        // BT/BTS/BTR/BTC with an IMMEDIATE offset takes it modulo the operand size even for a memory
        // operand — only the REGISTER-offset form addresses an absolute bit and can leave the operand.
        // Treating the immediate as absolute sent `bt word [bx],0AFh` to bit 175 (byte +21) instead
        // of bit 15 of the addressed word.
        case 0xba: { const o = modrm(); const imm = f8() & (sz - 1); bt(o, ['bt', 'bt', 'bt', 'bt', 'bt', 'bts', 'btr', 'btc'][o.reg], '' + imm); return; }
        case 0xb2: case 0xb4: case 0xb5: {                               // LSS / LFS / LGS
          const o = modrm();
          if (o.isReg) { canFault = true; P(`cpu.eip=${ipStart};cpu.swInt(6);return;`); ended = true; return; }   // mod=11: #UD, as LES/LDS
          P(loadPtr(o, op2 === 0xb2 ? SS : op2 === 0xb4 ? FS : GS, sz)); return;
        }
        case 0xbc: { const o = modrm(); const s = NT(); P(`var ${s}=${rmR(o, sz)}${M(sz)};`); P(`if(${s}===0){cpu.flags|=${ZF};}else{cpu.flags&=~${ZF};${rW(o.reg, sz, `(31-Math.clz32(${s}&-${s}))`)}}`); return; } // BSF
        case 0xbd: { const o = modrm(); const s = NT(); P(`var ${s}=${rmR(o, sz)}${M(sz)};`); P(`if(${s}===0){cpu.flags|=${ZF};}else{cpu.flags&=~${ZF};${rW(o.reg, sz, `(31-Math.clz32(${s}))`)}}`); return; } // BSR
        case 0xa4: { const o = modrm(); const c = f8(); P(rmW(o, sz, `cpu.shld(${rmR(o, sz)},${rR(o.reg, sz)},${c & 31},${sz})`)); return; } // SHLD imm
        case 0xa5: { const o = modrm(); P(rmW(o, sz, `cpu.shld(${rmR(o, sz)},${rR(o.reg, sz)},(r[1]&0xff),${sz})`)); return; }              // SHLD CL
        case 0xac: { const o = modrm(); const c = f8(); P(rmW(o, sz, `cpu.shrd(${rmR(o, sz)},${rR(o.reg, sz)},${c & 31},${sz})`)); return; } // SHRD imm
        case 0xad: { const o = modrm(); P(rmW(o, sz, `cpu.shrd(${rmR(o, sz)},${rR(o.reg, sz)},(r[1]&0xff),${sz})`)); return; }              // SHRD CL
        case 0xaf: { const o = modrm(); P(`cpu.imul16x(${rR(o.reg, sz)},${rmR(o, sz)},${sz});`); P(rW(o.reg, sz, 'cpu._mr')); return; } // IMUL Gv,Ev
        case 0xb0: case 0xb1: { const o = modrm(); const size = op2 === 0xb0 ? 8 : sz; const d = NT(), a = NT(), rr = NT(); P(`var ${d}=${rmR(o, size)},${a}=${rR(0, size)};var ${rr}=(${a}-${d})${M(size)};cpu.setSub(${a},${d},${rr},${size});if(${a}===${d}){${rmW(o, size, rR(o.reg, size))}}else{${rW(0, size, d)}}`); return; } // CMPXCHG
        case 0xb6: { const o = modrm(); P(rW(o.reg, sz, `(${rmR(o, 8)}&0xff)`)); return; } // MOVZX r,Eb
        case 0xb7: { const o = modrm(); P(rW(o.reg, sz, `(${rmR(o, 16)}&0xffff)`)); return; } // MOVZX r,Ew
        case 0xbe: { const o = modrm(); P(rW(o.reg, sz, `((${rmR(o, 8)})<<24>>24)`)); return; } // MOVSX r,Eb
        case 0xbf: { const o = modrm(); P(rW(o.reg, sz, `((${rmR(o, 16)})<<16>>16)`)); return; } // MOVSX r,Ew
        case 0xc0: case 0xc1: { const o = modrm(); const size = op2 === 0xc0 ? 8 : sz; const d = NT(), s = NT(), rr = NT(); P(`var ${d}=${rmR(o, size)},${s}=${rR(o.reg, size)};var ${rr}=(${d}+${s})${M(size)};${rW(o.reg, size, d)}${rmW(o, size, rr)}cpu.setAdd(${d},${s},${rr},${size});`); return; } // XADD
        // CPUID, but only on a part that has one (src/cpu-profile.js). This case sits here, right
        // above `default`, so that a CPU without it FALLS THROUGH to the #UD path below — putting it
        // anywhere else and breaking out of the switch would have made the opcode a silent no-op on
        // a 386, which is worse than the "unimplemented opcode" it used to throw.
        case 0xa2:
          if (rec.cpu.profile && rec.cpu.profile.cpuid) { P('cpu.cpuid();'); return; }
          // No CPUID on this part. #UD if the guest can take one; otherwise say WHY, because
          // "unimplemented opcode" would read as a gap in MIRAGE and this is a deliberate absence.
          if ((rec._udSeen = true, guestOwnsUD(mem, rec.cpu))) {
            P(`cpu.eip=${ip - 2};cpu.raise(6);`); P('return;'); ended = true; return;
          }
          if (endBefore()) return;
          throw new Error(`mirage: CPUID (0f a2) at linear 0x${mask(linStart - ip0 + ip - 2).toString(16)}` +
            ` — the '${rec.cpu.profile.name}' profile has no CPUID, which is correct for it. Use` +
            ` cpu: '586' for a part that has one, or give the guest an INT 6 handler.`);
        default:
          // Same as the one-byte default: `0f a6` is invalid on every CPU and Windows 3.0's loader
          // executes it on purpose, through its own INT 6 handler, to identify the processor.
          if ((rec._udSeen = true, guestOwnsUD(mem, rec.cpu))) {
            P(`cpu.eip=${ip - 2};cpu.raise(6);`); P('return;'); ended = true; return;   // ip-2: the 0F
          }
          if (endBefore()) return;
          throw new Error(unimplemented('0f 0x' + op2.toString(16).padStart(2, '0'), mask(linStart - ip0 + ip - 2), mem, rec));
      }
    }
  }
}
