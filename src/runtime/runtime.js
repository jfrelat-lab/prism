// runtime.js — the machine the emitted code runs on, plus the libc subset it links against.
//
// This is the layer that buys "no source modification": the game's own code is compiled untouched
// and everything it CALLS lives here. Only what a program actually references gets implemented —
// the unresolved-symbol list is the worklist, never anticipation.

import { Module, isFuncPtr, funcIndex } from '../link/module.js';
import { MODELS } from '../sema/abi.js';

export class Trap extends Error {}
export class ExitCalled extends Error {
  // `quick` is _exit: the program leaves without its atexit handlers and without flushing.
  constructor(code, quick = false) { super(`exit(${code})`); this.code = code; this.quick = quick; }
}

/*
 * The wall-clock origin, and it must NOT be zero.
 *
 * A UNIX `struct timeval` counts from 1970, so tv_sec is a large number on the first call a program
 * ever makes. Programs rely on that without saying so. Doom's I_GetTime keeps its origin in a
 * function-scope static and initialises it with
 *
 *     static int basetime = 0;
 *     if (!basetime) basetime = tp.tv_sec;
 *
 * so a clock starting at zero leaves the guard un-taken for the first 35 calls, and then fires —
 * at which point I_GetTime jumps BACKWARDS by 35 tics. Doom's screen wipe computes
 * `tics = nowtime - wipestart` and passes it to `while (ticks--)`, which on a negative value counts
 * down through the whole int range: four billion iterations, and a game that never draws again.
 *
 * A plausible date rather than 0, deterministic and fixed so every gate still gets the same answer.
 * 1997-02-05, the day MAME 0.1 was released.
 */
const EPOCH_US = 855_100_800_000_000;

/*
 * THE RUN LEASH. `M.leashDeadline` is a performance.now() value past which the program is stopped.
 *
 * It is checked from the CLOCK, not from a frame boundary, because a frame boundary assumes the
 * program keeps crossing one -- and the failure this exists for is exactly a program that stops
 * drawing while still running (Quake II's Win32 client leaves the BitBlt path the moment it goes
 * fullscreen). A running program still asks what time it is. Hooking a guest function instead would
 * not work at all: a direct call never passes through a wrapper installed on prog.F.
 *
 * Off unless a tool sets the deadline, so nothing that does not ask for a leash ever pays for one.
 */
export function checkLeash(M) {
  if (M.leashDeadline && performance.now() > M.leashDeadline) throw new Error('__leash');
}

/** struct tm is nine ints strided by four: laid out for i386, refused elsewhere (as stdio's localtime is). */
function tmIsI386(M, what) {
  const m = M.mod.model ?? 'i386';
  if (m !== 'i386') throw new Error(`${what}: its fields are laid out for i386 and this is ${m}`);
}

export function makeMachine(mod = new Module()) {
  const M = {
    mod,
    u8: mod.u8,
    dv: mod.dv,
    sp: mod.stackTop,
    heap: 0,                    // set after linking, when the static area is final
    heapEnd: 0,
    stdout: [],
    randState: 1,            // see rt.rand — deterministic on purpose
    cpu: { if: 1 },          // the interrupt flag, one for the machine (env/pcirq.js delivers against it)
    /*
     * The safepoint budget. Emitted loops decrement it and call sp_ when it runs out; the default
     * handler just refills it, so an uninstrumented run pays a decrement and nothing else. A harness
     * replaces sp_ to sample which loop is running — see tools/doom.mjs.
     */
    spBudget: 1 << 30,
    /*
     * The default handler refills the budget AND enforces the run leash, which is the only place
     * some hangs can be caught. A leash checked at the clock, at safepoints in runtime.js and at the
     * port seam still misses a loop that touches none of the three: Jump 'n Bump spins in
     * `while (key_pressed(1) == 1) dj_mix();` -- a memory read and a silent sound shim, no port, no
     * clock -- and a 40 s leash went unenforced for three minutes. A back edge is the one thing
     * every loop has, so this is the general answer and the others are the cheap ones.
     */
    sp_(_id) {
      // The refill decides how PROMPT the leash is, and the two cases want very different numbers.
      // 1<<30 back edges between checks is right for a run nobody is bounding -- it makes the
      // safepoint cost a decrement and nothing else -- and useless for one that is: a 40 s deadline
      // first came due 54 s in, because a billion back edges take that long to spend. 1<<20 brings
      // it to a few milliseconds and is still far too coarse to be felt.
      M.spBudget = M.leashDeadline ? (1 << 20) : (1 << 30);
      checkLeash(M);
    },

    clockTicks: 0,           // the deterministic clock, see rt.clock
    uclockTicks: 0n,         // ~1/60 s per call at the PIT rate
    funcs: mod.funcTable,
    rt: null,                   // the libc surface, installed below

    zero(addr, n) { M.u8.fill(0, addr, addr + n); },
    copy(dst, src, n) { M.u8.copyWithin(dst, src, src + n); return dst; },

    /**
     * A copy that respects a platform's memory map, for the same reason memset does: the emitted
     * code routes every access through the map, and a runtime block move that did not would walk
     * straight past the device.
     *
     * When BOTH sides are plain memory -- every program without a map, and nearly every range in
     * one that has it -- this is `copy` with one comparison in front. When either side is claimed,
     * it falls to a byte loop through the map's own translations: slow, and only on the ranges a
     * device owns, which is the trade a correct answer is worth here. The destination goes through
     * writeSpans, so a copy into a multi-plane window reaches every masked plane.
     */
    blockCopy(dst, src, n) {
      if (M.winTouches?.(dst, n) || M.winTouches?.(src, n)) return M.winCopy(dst, src, n);
      const map = M.memmap;
      if (!map) return M.copy(dst, src, n);
      const claimed = (a, len) => {
        for (let p = a >>> map.PAGE_SHIFT; p <= (a + len - 1) >>> map.PAGE_SHIFT; p++) {
          if (map.xlatR[p] !== (p << map.PAGE_SHIFT) || map.xlatW[p] !== (p << map.PAGE_SHIFT)) return true;
        }
        return false;
      };
      if (!claimed(dst, n) && !claimed(src, n)) return M.copy(dst, src, n);
      // Read the whole source first, through the READ table: the destination may overlap it once
      // planes are involved, and a copy that read as it wrote would see its own output.
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = M.u8[map.xr(src + i)];
      for (const sp of map.writeSpans(dst, n)) {
        M.u8.set(bytes.subarray(sp.from, sp.from + sp.len), sp.to);
      }
      return dst;
    },

    /** An indirect call through a function pointer. */
    icall(p, args) {
      if (!isFuncPtr(p)) throw new Trap(`call through a non-function pointer 0x${(p >>> 0).toString(16)}`);
      const f = M.funcs[funcIndex(p)];
      if (!f) throw new Trap(`call through an unbound function pointer (index ${funcIndex(p)})`);
      return f(...args);
    },

    cstr(addr) { return mod.cstr(addr); },
    write(s) { M.stdout.push(s); },
    output() { return M.stdout.join(''); },
  };

  /*
   * THE MODEL'S WIDTHS, for every place the runtime reads or writes a C object the program owns: an
   * `int *` it was handed, a `char **` end pointer, argv, a va_list. Under i386 both are four bytes and
   * nothing changes; under a 16-bit model an int is two bytes and a data pointer two (four in the
   * large model, where it is PRISM's linear far address). Writing four there overwrote the neighbour.
   */
  const table = MODELS[mod.model ?? 'i386'];
  M.abi = { int: table.int.size, ptr: table.pointer.size };
  M.loadPtr = (a) => (M.abi.ptr === 2 ? M.mod.dv.getUint16(a, true) : M.mod.dv.getInt32(a, true));
  M.storePtr = (a, v) => { if (M.abi.ptr === 2) M.mod.dv.setUint16(a, v & 0xffff, true); else M.mod.dv.setInt32(a, v | 0, true); };
  M.loadInt = (a) => (M.abi.int === 2 ? M.mod.dv.getInt16(a, true) : M.mod.dv.getInt32(a, true));
  M.storeInt = (a, v) => { if (M.abi.int === 2) M.mod.dv.setInt16(a, v, true); else M.mod.dv.setInt32(a, v | 0, true); };
  /** A reader over a caller-packed variadic buffer, at the model's widths. */
  M.va = (p) => vaReader(M, p);
  /*
   * A DEVICE WINDOW (the EGA's A000h), when an environment installs M.win: a block copy or fill that
   * touches it goes byte by byte through the device, reading the whole source first as blockCopy does.
   */
  M.winTouches = (a, n) => !!M.win && n > 0 && a < 0xb0000 && a + n > 0xa0000;
  M.winCopy = (d, s, n) => {
    const inW = (a) => a >= 0xa0000 && a < 0xb0000;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = inW(s + i) ? M.win.r8(s + i) : M.u8[s + i];
    for (let i = 0; i < n; i++) { if (inW(d + i)) M.win.w8(d + i, bytes[i]); else M.u8[d + i] = bytes[i]; }
    return d;
  };
  M.winFill = (d, v, n) => {
    for (let i = 0; i < n; i++) { const a = d + i; if (a >= 0xa0000 && a < 0xb0000) M.win.w8(a, v & 255); else M.u8[a] = v & 255; }
  };
  M.stackOverflow = (fp) => {
    throw new Trap(`stack overflow: a frame at ${fp} is below the ${M.mod.model} stack's floor at ${M.mod.stackLimit}`);
  };
  M.rt = makeLibc(M);
  return M;
}

/**
 * Start the heap above the last static byte, once every global has been placed -- leaving a gap.
 *
 * The gap is what makes lazy interning safe. `getenv`, `strerror`, `setlocale` and `tmpnam` cannot
 * know in advance which strings a program will ask for, so they intern on demand, which bumps the
 * static pointer after this line has already decided where the heap begins. Without the gap those
 * bytes landed inside memory malloc had handed out.
 */
export function finalizeHeap(M) {
  // Room for every string a shim may intern while running. From the model, because on a 64K
  // address space a 64K gap would BE the address space.
  const GAP = M.mod.layout?.stringGap ?? 64 * 1024;
  M.heap = Math.ceil((M.mod.brk + GAP) / 16) * 16;
  M.mod.staticLimit = M.heap;               // Module.alloc refuses to cross this
  /*
   * THE FRONTIER NEVER MOVES BACKWARDS, and this is not a refinement -- it is the same defect the
   * comment above sbrk describes, in a second place: handing out bytes that have already been given
   * away. This function is called TWICE, once while compiling and again inside run() before main,
   * and everything an ENVIRONMENT allocated in between was silently given back.
   *
   * Jump 'n Bump is what exposed it. src/env/registry.js asks for 320 kB of VGA planes while
   * installing the device; run() then reset the frontier to exactly that address, and the game's own
   * malloc for its background image came back sixteen bytes inside the planes. The background pass
   * then read its source and wrote plane 0 over the top of it -- a loop overwriting what it was
   * reading. It showed up as a banded picture and cost seven refuted hypotheses to reach, because
   * every symptom pointed at the planar mapping and the mapping was correct throughout.
   */
  M.heapEnd = Math.max(M.heapEnd ?? M.heap, M.heap);
  /*
   * The heap stops short of the stack by a margin the MODEL sets. 64K is i386's; under dos16m the
   * stack's own floor is 0xF000, so 64K below it is below the heap's START -- every near malloc
   * failed and coreleft() had nothing to report. A 16-bit layout says heapMargin: 1K.
   */
  M.heapTop = M.mod.stackLimit - (M.mod.layout?.heapMargin ?? 64 * 1024);
}


function makeLibc(M) {
  const u8 = () => M.mod.u8;
  const dv = () => M.mod.dv;

  // A bump allocator with a free list good enough for programs that malloc and free in patterns.
  // Real code casts pointers to integers and relies on distinct allocations not overlapping, which
  // is the only property promised here.
  const blocks = new Map();     // addr -> size
  /*
   * AND A REAL FREE LIST, which the comment above used to promise and the code did not have: `free`
   * only forgot the block, so M.heapEnd never came down and nothing was ever reused. That is
   * invisible to a program that allocates once at startup and fatal to one that allocates per frame.
   * Jump 'n Bump's SDL 2 port converts a surface every flip and frees it immediately -- 400 KB a
   * frame, correctly returned -- and still ran the 64 MB heap out in about 150 frames. It showed up
   * in the browser and not in Node only because the Node probe stopped at 120.
   *
   * Buckets keyed by the ROUNDED size, and reuse only on an exact match. That is deliberately the
   * simple half of the problem: it serves the pattern that actually occurs -- the same allocation
   * made and released every frame -- and it cannot hand back a block that overlaps another, which
   * is the one property this allocator promises.
   */
  const freeBySize = new Map();   // rounded size -> [addr, ...]
  // 16-bit layouts only: freed blocks by the address they END at, so a heap giving its top back can
  // keep going down through neighbours freed earlier (see free).
  const freedByEnd = new Map();   // end address -> addr

  const malloc = (n) => {
    n = (n | 0) >>> 0;
    if (n === 0) n = 1;
    const size = Math.ceil((n + 8) / 16) * 16;
    const pool = freeBySize.get(size);
    if (pool && pool.length) {
      const addr = pool.pop();
      freedByEnd.delete(addr - 8 + size);
      dv().setUint32(addr - 8, n, true);
      blocks.set(addr, n);
      return addr;
    }
    if (M.heapEnd + size > M.heapTop) throw new Trap('out of memory in malloc');
    const addr = M.heapEnd + 8;
    M.heapEnd += size;
    dv().setUint32(addr - 8, n, true);
    blocks.set(addr, n);
    return addr;
  };

  const free = (p) => {
    if (!p) return;
    const n = blocks.get(p);
    blocks.delete(p);
    // Only a block this allocator handed out goes back on the list; anything else is left alone
    // rather than guessed at, because a wrong size here would hand out overlapping memory later.
    if (n === undefined) return;
    const size = Math.ceil((n + 8) / 16) * 16;
    /*
     * Under a 16-bit layout the TOPMOST block goes back to the frontier, as Borland's heap gives it
     * back: coreleft() reports the space between the heap's top and the stack, and a program that
     * frees its last block and asks again must see it. i386 keeps its buckets exactly as before.
     */
    const sixteen = M.mod.layout?.heapMargin !== undefined;
    if (sixteen && p - 8 + size === M.heapEnd) {
      M.heapEnd -= size;
      // ...and every block freed earlier that now ends at the top comes back with it.
      while (freedByEnd.has(M.heapEnd)) {
        const q = freedByEnd.get(M.heapEnd);
        freedByEnd.delete(M.heapEnd);
        const qs = M.heapEnd - (q - 8);
        const qp = freeBySize.get(qs);
        qp.splice(qp.indexOf(q), 1);
        M.heapEnd = q - 8;
      }
      return;
    }
    const pool = freeBySize.get(size);
    if (pool) pool.push(p); else freeBySize.set(size, [p]);
    if (sixteen) freedByEnd.set(p - 8 + size, p);
  };

  const realloc = (p, n) => {
    if (!p) return malloc(n);
    const old = blocks.get(p) ?? dv().getUint32(p - 8, true);
    if (n <= old) return p;
    const q = malloc(n);
    M.copy(q, p, old);
    free(p);
    return q;
  };

  const strlenAt = (p) => { let n = 0; while (u8()[p + n] !== 0) n++; return n; };

  // strtok's static saved pointer. See strtok below for why it cannot live in a stack frame.
  let strtokSaved = 0;

  /*
   * rand() -- GLIBC'S generator, because for this project "deterministic" is not the same
   * requirement as "the same answer as the reference build".
   *
   * WHY IT WAS CHANGED, since the old ANSI sample LCG was perfectly deterministic. `rand()` is
   * implementation-defined, and PRISM's oracle is a native i386 gcc build, so anywhere a program's
   * output can depend on rand() the two builds must agree or the differential is measuring the C
   * library rather than the compiler. MAME 0.4 is where that stopped being theoretical:
   * `Z80_Reset` does `R.R = rand()` -- the Z80's refresh register, deliberately randomised -- and
   * Wizard of Wor reads it (`LD A,R`) to seed its OWN generator. One implementation-defined value
   * therefore reached the guest and decided, 266 frames later, whether a glyph was erased on frame
   * 267 or 269.
   *
   * The algorithm is glibc's TYPE_3 additive-feedback generator, from its specification: a table of
   * 31 int32 words, taps at 3 and 0, output the sum's top 31 bits.
   *
   *   seeding   r[0] = seed (0 becomes 1); r[i] = 16807 * r[i-1] mod 2^31-1, by Schrage's method so
   *             the product never needs more than 31 bits of precision
   *   warm-up   310 outputs discarded, which is 10 x the degree
   *   output    r[f] += r[r]; return (uint32)r[f] >> 1, then advance both taps cyclically
   *
   * The unseeded default is seed 1, so `rand()` with no `srand()` gives glibc's familiar first
   * value, 1804289383 -- and that number is how this was confirmed rather than assumed: MAME's
   * reported fetch count at frame 1 was 1804294666, i.e. that value plus the 5,283 instructions
   * since reset.
   */
  const RAND_DEG = 31, RAND_SEP = 3;
  let randTable = new Int32Array(RAND_DEG);
  let randF = RAND_SEP, randR = 0;

  function randAdvance() {
    randTable[randF] = (randTable[randF] + randTable[randR]) | 0;
    // The shift is on the UNSIGNED reinterpretation: `>>>` on a negative int32 is what glibc's
    // `(unsigned int)*fptr >> 1` does, and `>>` would sign-extend and halve the range.
    const out = randTable[randF] >>> 1;
    if (++randF >= RAND_DEG) randF = 0;
    if (++randR >= RAND_DEG) randR = 0;
    return out;
  }

  function randSeed(seed) {
    let v = seed | 0;
    if (v === 0) v = 1;                       // glibc maps a zero seed to 1
    randTable = new Int32Array(RAND_DEG);
    randTable[0] = v;
    for (let i = 1; i < RAND_DEG; i++) {
      /*
       * r[i] = 16807 * r[i-1] mod 2147483647, by Schrage: the product is split so that neither half
       * exceeds 31 bits. Written with plain division rather than Math.imul because the intermediate
       * 16807 * lo reaches ~2.1e9, which is exact in a double and would wrap in an int32.
       */
      const prev = randTable[i - 1];
      const hi = Math.trunc(prev / 127773);
      const lo = prev % 127773;
      let word = 16807 * lo - 2836 * hi;
      if (word < 0) word += 2147483647;
      randTable[i] = word;
    }
    randF = RAND_SEP; randR = 0;
    for (let i = 0; i < 10 * RAND_DEG; i++) randAdvance();
  }

  randSeed(1);                                // the unseeded default, as glibc's is

  const lib = {
    // --- stdio
    printf: (fmt, args) => { const s = format(M, fmt, args ?? []); M.write(s); return s.length; },
    puts: (p) => { M.write(M.cstr(p) + '\n'); return 1; },
    putchar: (c) => { M.write(String.fromCharCode(c & 0xff)); return c & 0xff; },
    fputs: (p, _stream) => { M.write(M.cstr(p)); return 1; },
    fputc: (c, _stream) => { M.write(String.fromCharCode(c & 0xff)); return c & 0xff; },
    /*
     * fprintf and vfprintf, for a program with no file layer at all.
     *
     * There is no FILE* to honour here -- nothing has defined one -- so everything goes to the
     * console, which is the only sink that exists. installStdio REPLACES both with versions that
     * route through its own writeByte, and it has to: this pair used to be the only implementation,
     * it discarded its stream argument (the parameter was named `_stream`), and Doom's
     * `fprintf(sndserver, "p%2.2x%2.2x%2.2x%2.2x\n", ...)` therefore printed its sound commands on
     * the console instead of sending them down the pipe. The sound server received nothing and mixed
     * silence, and the log LOOKED right because the commands were visible in it.
     */
    fprintf: (_stream, fmt, args) => { const s = format(M, fmt, args ?? []); M.write(s); return s.length; },

    /*
     * The `v` family: same formatter, arguments read from a va_list instead of a packed array. Quake
     * needs these badly — `Con_Printf`, `Sys_Error`, `Sys_Printf` and `va()` are all built on
     * vsprintf, and eleven of its functions failed to emit without them.
     */
    vprintf: (fmt, ap) => { const s = format(M, fmt, vaReader(M, ap)); M.write(s); return s.length; },
    vfprintf: (_stream, fmt, ap) => { const s = format(M, fmt, vaReader(M, ap)); M.write(s); return s.length; },
    vsprintf: (dst, fmt, ap) => {
      const s = format(M, fmt, vaReader(M, ap));
      const bytes = bytesOf(s);
      u8().set(bytes, dst); u8()[dst + bytes.length] = 0;
      return bytes.length;
    },
    vsnprintf: (dst, n, fmt, ap) => {
      const s = format(M, fmt, vaReader(M, ap));
      const bytes = bytesOf(s);
      const take = Math.max(0, Math.min(bytes.length, (n | 0) - 1));
      if (n | 0) { u8().set(bytes.subarray(0, take), dst); u8()[dst + take] = 0; }
      return bytes.length;
    },
    sprintf: (dst, fmt, args) => {
      const s = format(M, fmt, args ?? []);
      const bytes = bytesOf(s);
      u8().set(bytes, dst); u8()[dst + bytes.length] = 0;
      return bytes.length;
    },
    snprintf: (dst, n, fmt, args) => {
      const s = format(M, fmt, args ?? []);
      const bytes = bytesOf(s).subarray(0, Math.max(0, n - 1));
      u8().set(bytes, dst); u8()[dst + bytes.length] = 0;
      return s.length;
    },

    // --- stdlib
    malloc, free, realloc,
    calloc: (n, sz) => { const p = malloc(Math.imul(n, sz)); M.zero(p, Math.imul(n, sz)); return p; },
    exit: (code) => { throw new ExitCalled(code | 0); },
    // _exit skips the atexit handlers and stdio's flush, which exit and a return from main run
    // (M.leave). Quake II's signal handler calls _exit rather than exit, deliberately.
    _exit: (code) => { throw new ExitCalled(code | 0, true); },
    abort: () => { throw new Trap('abort() called'); },
    /*
     * The DOS string family. Not any one library's -- Watcom, Borland and DJGPP all ship them, and
     * MAME, Heretic and Hexen all call them -- so they belong in the runtime rather than beside the
     * shim that happened to need them first. They lived in src/env/allegro.js until Heretic, which
     * installs no Allegro, died on `stricmp is not a function` while opening its WAD.
     */
    stricmp: (a, b) => {
      const x = M.cstr(a).toLowerCase(), y = M.cstr(b).toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    },
    strnicmp: (a, b, n) => {
      const x = M.cstr(a).slice(0, n | 0).toLowerCase(), y = M.cstr(b).slice(0, n | 0).toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    },
    // In place, over the bytes already there, returning their own argument.
    strupr: (p) => { const s = M.cstr(p).toUpperCase(); for (let i = 0; i < s.length; i++) M.u8[p + i] = s.charCodeAt(i) & 0xff; return p; },
    strlwr: (p) => { const s = M.cstr(p).toLowerCase(); for (let i = 0; i < s.length; i++) M.u8[p + i] = s.charCodeAt(i) & 0xff; return p; },

    /*
     * Watcom `#pragma aux` intrinsics, DERIVED from the instruction sequences Heretic and Hexen
     * declare in DOOMDEF.H rather than guessed at from the names:
     *
     *   FixedMul   imul ebx ; shrd eax,edx,16          edx:eax = a*b signed, then the 64-bit pair
     *                                                  shifted right 16 into eax  ->  (a*b) >> 16
     *   FixedDiv2  cdq ; shld edx,eax,16 ; sal eax,16  edx:eax = a << 16 sign-extended,
     *              ; idiv ebx                          then divided by b  ->  (a << 16) / b
     *
     * These games DECLARE the two functions and never define them in C, so they resolve here. A
     * program that defines its own wins, because a definition beats a builtin -- which is what keeps
     * Doom on its own m_fixed.c versions.
     *
     * BigInt because both intermediates are genuinely 64-bit: `a*b` overflows int32 for any pair
     * whose product exceeds 2^31, which is most of them in a renderer.
     */
    FixedMul: (a, b) => Number(BigInt.asIntN(32, (BigInt(a | 0) * BigInt(b | 0)) >> 16n)),
    FixedDiv2: (a, b) => {
      if ((b | 0) === 0) return (a | 0) < 0 ? -2147483648 : 2147483647;   // idiv would trap; saturate
      return Number(BigInt.asIntN(32, (BigInt(a | 0) << 16n) / BigInt(b | 0)));
    },

    /*
     * atexit RECORDS rather than ignores, and leaving the program runs the list (compile.js leave):
     * a program that cleans up on the way out is entitled to have that happen. Quake's Sys_Shutdown
     * is registered this way.
     */
    atexit: (fn) => { (M.atexitList ??= []).push(fn >>> 0); return 0; },
    /*
     * sbrk, over the same brk the guest malloc uses -- so a program that mixes them (Quake asks
     * sbrk(0) to find the heap top) sees one consistent heap rather than two.
     */
    /*
     * ONE frontier, shared with malloc.
     *
     * There were two: malloc bumped `heapEnd` and this bumped `heap`, both starting at the same
     * address -- so a working sbrk would have handed out bytes malloc had already given away. What
     * hid that was the limit check, which compared against `heapEnd` (malloc's frontier) instead of
     * `heapTop` (the ceiling), so sbrk could only ever extend into ground malloc had ALREADY taken
     * and refused everything else.
     *
     * Quake's DOS build is what exposed it. `dos_getmaxlockedmem` asks DPMI for the free memory, gets
     * 32 MB, and then walks DOWN in 64K steps until sbrk succeeds:
     *
     *     do { working_size -= 0x10000; working_memory = sbrk(working_size); }
     *     while (working_memory == (void *)-1);
     *
     * With sbrk failing at every size the loop ran the value negative, `malloc'd: -95124`, and the
     * game refused to start with "Only -0.1 megs of memory available" -- on a target with 509 MB
     * free. `-mem 16` made it start by skipping the question, which is why this looked like a
     * program option rather than a bug here.
     */
    sbrk: (delta) => {
      const prev = M.heapEnd;
      const d = delta | 0;
      if (d === 0) return prev;
      if (d > 0 && M.heapEnd + d > M.heapTop) return -1;
      M.heapEnd += d;
      if (M.heapEnd < M.heap) M.heapEnd = M.heap;     // never below the heap's base
      return prev;
    },

    atoi: (p) => (parseInt(M.cstr(p), 10) | 0) || 0,

    /*
     * itoa, which is not ISO C but is what DJGPP and MSVC both give a program -- Jump n Bump
     * formats its scores with it.
     *
     * The sign rule is the one that is easy to get wrong: it applies to base 10 ONLY. In every
     * other radix the value is treated as UNSIGNED, so itoa(-1, b, 16) is "ffffffff" and not
     * "-1". Returns the buffer, as the callers expect.
     */
    itoa: (value, buf, radix) => {
      const r = radix | 0;
      const v = r === 10 ? (value | 0) : (value >>> 0);
      const s = v.toString(r >= 2 && r <= 36 ? r : 10);
      for (let i = 0; i < s.length; i++) M.u8[buf + i] = s.charCodeAt(i);
      M.u8[buf + s.length] = 0;
      return buf;
    },

    /*
     * strtol / strtoul, and the part that is not optional is `endptr`: a program parses a list by
     * calling strtol in a loop and advancing over what it consumed, so a version that returns the
     * right number and the wrong end pointer loops for ever.
     *
     * base 0 means "guess from the prefix" -- 0x hex, leading 0 octal, otherwise decimal -- which is
     * why this cannot just be parseInt with a radix.
     */
    strtol: (p, endp, base) => {
      const r = M.rt.__strtoNum(p, endp, base | 0, true);
      return Math.max(-2147483648, Math.min(2147483647, r)) | 0;
    },
    strtoul: (p, endp, base) => M.rt.__strtoNum(p, endp, base | 0, false) >>> 0,
    __strtoNum(p, endp, base, signed) {
      const s = M.cstr(p);
      let i = 0;
      while (i < s.length && /\s/.test(s[i])) i++;
      let sign = 1;
      if (s[i] === '+' || s[i] === '-') { if (s[i] === '-') sign = -1; i++; }
      /*
       * The base prefix, and the trap is that a lone "0" is a COMPLETE octal constant.
       *
       * Consuming the leading zero as a prefix and then looking for digits made strtol("0", &end, 0)
       * report no conversion at all, leaving `end` at the start -- which is exactly the check every
       * caller makes. Hexen's SC_GetNumber does `strtol(s, &stopper, 0); if (*stopper != 0) error`
       * and refused its own SNDINFO script at the first zero.
       *
       * So the zero is never consumed as a prefix: base 8 is selected and the digit loop takes it.
       * "0x" not followed by a hex digit is likewise the number 0 with `end` at the 'x'.
       */
      const isHexDigit = (c) => c !== undefined && /[0-9a-fA-F]/.test(c);
      let b = base;
      if ((b === 0 || b === 16) && s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X')
          && isHexDigit(s[i + 2])) { b = 16; i += 2; }
      else if (b === 0 && s[i] === '0') b = 8;
      else if (b === 0) b = 10;
      const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, b);
      const start = i;
      let v = 0;
      while (i < s.length) {
        const d = digits.indexOf(s[i].toLowerCase());
        if (d < 0) break;
        v = v * b + d;
        i++;
      }
      // No digits at all: the end pointer goes back to the ORIGINAL string, not past the sign.
      if (endp) M.storePtr(endp, p + (i === start ? 0 : i));
      return i === start ? 0 : sign * v;
    },
    atol: (p) => (parseInt(M.cstr(p), 10) | 0) || 0,
    labs: (v) => Math.abs(v | 0) | 0,
    /*
     * qsort, and the reason it is not two lines: the comparator is the GUEST's, so every comparison
     * is an indirect call back into compiled code, and the elements are bytes in the heap rather than
     * JS values.
     *
     * Sorting an index array and then permuting is what keeps this honest -- swapping through a
     * scratch buffer as the C would means moving `size` bytes per swap, and JS's own sort gives no
     * access to the swap. The comparator sees the real addresses either way, which is what a caller
     * that compares pointers-into-the-struct depends on.
     */
    qsort: (base, n, size, cmp) => {
      n = n >>> 0; size = size >>> 0;
      if (n < 2 || size === 0) return;
      const idx = Array.from({ length: n }, (_, i) => i);
      idx.sort((a, b) => M.icall(cmp, [base + a * size, base + b * size]) | 0);
      const tmp = M.u8.slice(base, base + n * size);
      for (let i = 0; i < n; i++) M.u8.set(tmp.subarray(idx[i] * size, (idx[i] + 1) * size), base + i * size);
    },
    /** bsearch: the comparator is called as C's is, (key, element), and the first match found returned. */
    bsearch: (key, base, n, size, cmp) => {
      let lo = 0, hi = (n >>> 0) - 1;
      size >>>= 0;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const at = base + mid * size;
        const c = M.icall(cmp, [key, at]) | 0;
        if (c === 0) return at;
        if (c < 0) hi = mid - 1; else lo = mid + 1;
      }
      return 0;
    },
    abs: (v) => Math.abs(v | 0) | 0,

    // --- string
    strlen: (p) => strlenAt(p) | 0,
    strcpy: (d, s) => { let i = 0; for (; u8()[s + i]; i++) u8()[d + i] = u8()[s + i]; u8()[d + i] = 0; return d; },
    strncpy: (d, s, n) => {
      let i = 0;
      for (; i < n && u8()[s + i]; i++) u8()[d + i] = u8()[s + i];
      for (; i < n; i++) u8()[d + i] = 0;
      return d;
    },
    strcat: (d, s) => { const e = d + strlenAt(d); lib.strcpy(e, s); return d; },
    strcmp: (a, b) => {
      for (let i = 0; ; i++) {
        const x = u8()[a + i], y = u8()[b + i];
        if (x !== y) return x < y ? -1 : 1;
        if (x === 0) return 0;
      }
    },
    strncmp: (a, b, n) => {
      for (let i = 0; i < n; i++) {
        const x = u8()[a + i], y = u8()[b + i];
        if (x !== y) return x < y ? -1 : 1;
        if (x === 0) return 0;
      }
      return 0;
    },
    strchr: (p, c) => {
      c &= 0xff;
      for (let i = 0; ; i++) {
        if (u8()[p + i] === c) return p + i;
        if (u8()[p + i] === 0) return 0;
      }
    },

    strcoll: (a, b) => lib.strcmp(a, b),
    strncat: (d, s, n) => {
      const e = d + strlenAt(d);
      let i = 0;
      for (; i < n && u8()[s + i]; i++) u8()[e + i] = u8()[s + i];
      u8()[e + i] = 0;                        // ALWAYS terminated -- unlike strncpy, which is not
      return d;
    },
    /** The first character of `s` that appears in `accept`, or NULL -- not the first `accept`. */
    /*
     * strtod, with a working endptr -- which is the whole point of it. Lua's number parser calls it
     * and then checks how far it got, so a version that consumed the string silently would turn
     * "10 apples" into the number ten instead of a syntax error.
     *
     * JavaScript's own parseFloat accepts exactly C's decimal syntax minus the hexadecimal form,
     * which C99 added and Lua does use ("0x10" is 16). So the hex case is matched first.
     */
    strtod: (p, endp) => {
      let i = 0;
      // Leading whitespace, which strtod skips: space, \t, \n, \v, \f, \r.
      while ([32, 9, 10, 11, 12, 13].includes(u8()[p + i])) i++;
      const text = M.cstr(p + i);
      let m = /^[+-]?0[xX][0-9a-fA-F]*(\.[0-9a-fA-F]*)?([pP][+-]?\d+)?/.exec(text);
      let value, used;
      if (m && /[0-9a-fA-F]/.test(m[0].replace(/^[+-]?0[xX]/, ''))) {
        value = Number(m[0].includes('p') || m[0].includes('P') ? m[0] : m[0]);
        if (Number.isNaN(value)) value = parseInt(m[0], 16);
        used = m[0].length;
      } else {
        m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text);
        if (!m) { if (endp) M.storePtr(endp, p); return 0; }
        value = parseFloat(m[0]);
        used = m[0].length;
      }
      if (endp) M.storePtr(endp, p + i + used);
      return value;
    },
    strtof: (p, endp) => Math.fround(lib.strtod(p, endp)),

    /** The C locale's own lconv, in guest memory, filled once. */
    localeconv: () => {
      if (!M.__lconv) {
        const SIZE = 10 * M.abi.ptr + 8;
        M.__lconv = M.rt.malloc(SIZE);
        M.u8.fill(0, M.__lconv, M.__lconv + SIZE);
        const dot = M.mod.intern([0x2e, 0]);          // "."
        const empty = M.mod.intern([0]);
        M.storePtr(M.__lconv, dot);                   // decimal_point
        for (let f = 1; f < 10; f++) M.storePtr(M.__lconv + f * M.abi.ptr, empty);
      }
      return M.__lconv;
    },
    /*
     * setlocale, answering only for the locales that exist here.
     *
     * It used to return "C" whatever it was asked for, which is not a simplification but a false
     * claim: a program that asks for pt_BR and is told yes then expects a comma for its decimal
     * point. Lua's literals.lua does exactly that -- `if os.setlocale("pt_BR") then` guards a block
     * asserting `tonumber("3,4") == 3.4` -- and the block ran. A real libc returns NULL for a locale
     * that is not installed, which is both the truth and what makes the guard work.
     *
     * NULL for the query form is deliberate too: a caller asking "what locale am I in" gets "C".
     */
    setlocale: (_cat, namePtr) => {
      const name = namePtr === 0 ? null : M.cstr(namePtr);
      if (name === null || name === '' || name === 'C' || name === 'POSIX') {
        return M.mod.intern([0x43, 0]);                // "C"
      }
      return 0;
    },

    /*
     * mktime and difftime over the same epoch the rest of the clock uses. strftime handles the
     * conversions Lua's os.date asks for and REFUSES the rest by name rather than dropping them,
     * because a silently missing field in a formatted date is the kind of wrong that travels.
     */
    mktime: (tmPtr) => {
      tmIsI386(M, 'mktime');
      const d = M.mod.dv, g = (o) => d.getInt32(tmPtr + o * 4, true);
      const ms = Date.UTC(g(5) + 1900, g(4), g(3), g(2), g(1), g(0));
      /*
       * mktime WRITES the struct as well as reading it (C99 7.23.2.3): out-of-range fields are
       * normalised and tm_wday/tm_yday are filled in, whatever they held. Lua's os.time relies on
       * it -- it copies the normalised struct back into the table it was given -- so returning the
       * time alone left the caller's wday and yday as whatever the stack held before.
       */
      const t = new Date(ms);
      const y = t.getUTCFullYear();
      const yday = (Date.UTC(y, t.getUTCMonth(), t.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000;
      const f = [t.getUTCSeconds(), t.getUTCMinutes(), t.getUTCHours(), t.getUTCDate(), t.getUTCMonth(),
        y - 1900, t.getUTCDay(), yday, 0];
      for (let i = 0; i < 9; i++) d.setInt32(tmPtr + i * 4, f[i] | 0, true);
      return Math.floor(ms / 1000) | 0;
    },
    difftime: (a, b) => (a | 0) - (b | 0),
    strftime: (dst, max, fmt, tmPtr) => {
      tmIsI386(M, 'strftime');
      const d = M.mod.dv, g = (o) => d.getInt32(tmPtr + o * 4, true);
      const date = new Date(Date.UTC(g(5) + 1900, g(4), g(3), g(2), g(1), g(0)));
      const p2 = (n) => String(n).padStart(2, '0');
      const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const MONS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                    'September', 'October', 'November', 'December'];
      const out = M.cstr(fmt).replace(/%(.)/g, (_, c) => {
        switch (c) {
          case 'Y': return String(date.getUTCFullYear());
          case 'y': return p2(date.getUTCFullYear() % 100);
          case 'm': return p2(date.getUTCMonth() + 1);
          case 'd': return p2(date.getUTCDate());
          case 'H': return p2(date.getUTCHours());
          case 'M': return p2(date.getUTCMinutes());
          case 'S': return p2(date.getUTCSeconds());
          case 'j': return String(g(7) + 1).padStart(3, '0');
          /*
           * %w, the weekday as a NUMBER, 0 = Sunday. Missing until Lua's own test suite named it,
           * and missing loudly rather than quietly: files.lua builds a Lua CHUNK out of a formatted
           * date -- `D.wday==%w+1` -- so an unexpanded %w does not read oddly, it makes the chunk a
           * syntax error. load() then returns nil and the failure lands on the call site four lines
           * later with nothing at all to say why.
           */
          case 'w': return String(date.getUTCDay());
          case 'a': return DAYS[date.getUTCDay()].slice(0, 3);
          case 'A': return DAYS[date.getUTCDay()];
          case 'b': return MONS[date.getUTCMonth()].slice(0, 3);
          case 'B': return MONS[date.getUTCMonth()];
          case 'p': return date.getUTCHours() < 12 ? 'AM' : 'PM';
          case 'c': return date.toUTCString();
          case 'x': return `${p2(date.getUTCMonth() + 1)}/${p2(date.getUTCDate())}/` +
            p2(date.getUTCFullYear() % 100);
          case 'X': return `${p2(date.getUTCHours())}:${p2(date.getUTCMinutes())}:` +
            p2(date.getUTCSeconds());
          case 'Z': return 'UTC';
          case '%': return '%';
          default: return '%' + c;      // left as written, which is what a C library may also do
        }
      });
      const bytes = [...new TextEncoder().encode(out)];
      if (bytes.length + 1 > (max >>> 0)) return 0;   // strftime's own failure answer
      M.u8.set(bytes, dst);
      M.u8[dst + bytes.length] = 0;
      return bytes.length;
    },

    strpbrk: (s, accept) => {
      for (let i = 0; u8()[s + i]; i++) {
        for (let j = 0; u8()[accept + j]; j++) if (u8()[s + i] === u8()[accept + j]) return s + i;
      }
      return 0;
    },
    strdup: (s) => {
      const n = strlenAt(s) + 1;
      const p = lib.malloc(n);
      if (p) M.u8.copyWithin(p, s, s + n);
      return p;
    },
    /*
     * strtok, with its state: the standard says the saved pointer is static, and a caller relies on
     * it -- `strtok(s, d)` then `strtok(NULL, d)` until it returns NULL. Quake II's Cmd_TokenizeString
     * and its config parsing both walk a buffer that way, so the state has to persist across calls
     * and cannot live on a JS stack frame.
     */
    strtok: (s, delim) => {
      const isDelim = (ch) => {
        for (let i = 0; u8()[delim + i]; i++) if (u8()[delim + i] === ch) return true;
        return false;
      };
      let p = s ? s : strtokSaved;
      if (!p) return 0;
      while (u8()[p] && isDelim(u8()[p])) p++;   // leading delimiters are not a token
      if (!u8()[p]) { strtokSaved = 0; return 0; }
      const start = p;
      while (u8()[p] && !isDelim(u8()[p])) p++;
      // The separator is OVERWRITTEN with a NUL: strtok modifies its input, which is why a caller
      // must never hand it a string literal.
      if (u8()[p]) { u8()[p] = 0; strtokSaved = p + 1; } else strtokSaved = 0;
      return start;
    },
    /*
     * BLOCK MOVES GO THROUGH THE MAP when a platform has one, and this is not an optimisation
     * detail -- it is the hole a compiler-side translation cannot close. The emitted code routes
     * every load and store through xr/xw, but memcpy and memset are RUNTIME functions: without this
     * they write straight into the flat image and walk past the device entirely. Jump 'n Bump
     * clears its screen with `memset(ptr1, 0, 65535)` right after setting Map Mask to all four
     * planes, which is exactly the case.
     *
     * A block write can also have SEVERAL destinations -- four planes at once -- which no single
     * translated address can express. `writeSpans` is the map's answer, and for a program with no
     * map, or a range nothing claims, it is the range itself and this costs one comparison.
     */
    memcpy: (d, s, n) => { M.blockCopy(d, s, n); return d; },
    memmove: (d, s, n) => { M.blockCopy(d, s, n); return d; },
    memset: (d, v, n) => {
      if (M.winTouches?.(d, n)) { M.winFill(d, v, n); return d; }
      const map = M.memmap;
      if (!map) { u8().fill(v & 0xff, d, d + n); return d; }
      for (const sp of map.writeSpans(d, n)) u8().fill(v & 0xff, sp.to, sp.to + sp.len);
      return d;
    },
    memcmp: (a, b, n) => {
      for (let i = 0; i < n; i++) {
        const x = u8()[a + i], y = u8()[b + i];
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    },

    strrchr: (p, c) => { c &= 0xff; let last = 0; for (let i = 0; ; i++) { const b = u8()[p + i]; if (b === c) last = p + i; if (b === 0) return last; } },
    strstr: (h, n) => {
      const hs = M.cstr(h), ns = M.cstr(n);
      const i = hs.indexOf(ns);
      return i < 0 ? 0 : h + i;
    },
    /*
     * A DETERMINISTIC PRNG, and it is GLIBC'S, not the ANSI sample LCG that used to be here.
     *
     * It must not read host entropy -- the same run has to produce the same frames, which is what
     * makes a golden fingerprint possible -- but "deterministic" was never enough on its own, and
     * MAME 0.4 is what proved it. `rand()` is implementation-defined, PRISM's oracle is a native
     * i386 gcc build, and glibc's answer is therefore the right one wherever a program's output can
     * depend on it. See randSeed/randAdvance above for the algorithm and for the measurement.
     */
    rand: () => randAdvance(),
    /*
     * random/srandom are the SAME generator here, and now that is the truth rather than an
     * approximation: glibc implements rand() by calling random(), so a program that reaches for the
     * longer period gets it.
     */
    random: () => randAdvance(),
    srand: (seed) => randSeed(seed),
    srandom: (seed) => randSeed(seed),

    // ctype, C locale. EOF (-1) must answer false everywhere except tolower/toupper, which pass it
    // through -- a program looping on getchar() relies on exactly that.
    isalnum: (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0,
    isalpha: (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0,
    iscntrl: (c) => (c >= 0 && c < 32) || c === 127 ? 1 : 0,
    isdigit: (c) => (c >= 48 && c <= 57) ? 1 : 0,
    isgraph: (c) => (c > 32 && c < 127) ? 1 : 0,
    islower: (c) => (c >= 97 && c <= 122) ? 1 : 0,
    isprint: (c) => (c >= 32 && c < 127) ? 1 : 0,
    ispunct: (c) => (c > 32 && c < 127 &&
      !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) ? 1 : 0,
    isspace: (c) => c === 32 || (c >= 9 && c <= 13) ? 1 : 0,
    isupper: (c) => (c >= 65 && c <= 90) ? 1 : 0,
    isxdigit: (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) ? 1 : 0,
    tolower: (c) => (c >= 65 && c <= 90) ? c + 32 : c,
    toupper: (c) => (c >= 97 && c <= 122) ? c - 32 : c,

    /*
     * gcc's byte-swap builtins. Real code reaches for them instead of writing the shifts, and SQLite
     * does it in the hot path of every page read.
     */
    // Count leading zeros of a 64-bit value. Undefined for zero in C, and SQLite never passes zero.
    __builtin_clzll: (v) => {
      let x = BigInt.asUintN(64, typeof v === 'bigint' ? v : BigInt(v | 0));
      if (x === 0n) return 64;
      let n = 0;
      while (x < 0x8000000000000000n) { x <<= 1n; n++; }
      return n;
    },
    __builtin_clz: (v) => (v >>> 0) === 0 ? 32 : Math.clz32(v >>> 0),
    __builtin_ctz: (v) => { const u = v >>> 0; if (!u) return 32; let n = 0; let x = u; while (!(x & 1)) { x >>>= 1; n++; } return n; },
    utimes: () => 0,
    gmtime: () => 0,
    nanosleep: () => 0,

    __builtin_bswap16: (v) => ((v & 0xff) << 8 | (v >>> 8) & 0xff) & 0xffff,
    __builtin_bswap32: (v) => (((v & 0xff) << 24) | ((v & 0xff00) << 8) |
                               ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) | 0,

    /*
     * The atomics are PLAIN loads and stores here, and that is not a shortcut: the guest is one
     * thread on one core, so there is nothing to order against. If PRISM ever runs guest code on
     * more than one thread, these become wrong and must be revisited — recorded here rather than
     * discovered then.
     */
    __atomic_load_n: (p, _order) => M.mod.dv.getInt32(p, true),
    __atomic_store_n: (p, v, _order) => { M.mod.dv.setInt32(p, v | 0, true); },
    __atomic_fetch_add: (p, v) => {
      const old = M.mod.dv.getInt32(p, true);
      M.mod.dv.setInt32(p, (old + (v | 0)) | 0, true);
      return old;
    },

    strcasecmp: (a, b) => {
      const x = M.mod.cstr(a).toLowerCase(), y = M.mod.cstr(b).toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    },
    strncasecmp: (a, b, n) => {
      const x = M.mod.cstr(a).toLowerCase().slice(0, n | 0);
      const y = M.mod.cstr(b).toLowerCase().slice(0, n | 0);
      return x < y ? -1 : x > y ? 1 : 0;
    },
    /*
     * MSVC's spellings, aliased to the twins above rather than reimplemented. They live HERE, in the
     * general runtime, for the same reason their declarations live in headers.js: a program built
     * for Windows uses them in files that include no Windows header -- Quake II's q_shared.c is one
     * -- so an implementation in src/env/win32.c would be out of reach of the very callers that ask.
     * That mistake was made in both directions before it was made in neither.
     */
    _stricmp: (a, b) => lib.strcasecmp(a, b),
    _strnicmp: (a, b, n) => lib.strncasecmp(a, b, n),

    perror: (p) => { M.write(`${M.mod.cstr(p)}: No such file or directory\n`); },
    setbuf: () => {},
    setvbuf: () => 0,
    popen: () => 0,          // no subprocesses; Doom's sound server simply never starts
    pclose: () => -1,
    gethostname: (buf, n) => {
      const name = 'prism';
      for (let i = 0; i < Math.min(name.length, (n | 0) - 1); i++) M.u8[buf + i] = name.charCodeAt(i);
      M.u8[buf + Math.min(name.length, (n | 0) - 1)] = 0;
      return 0;
    },
    strspn: (sPtr, acceptPtr) => {
      const accept = new Set([...M.mod.cstr(acceptPtr)].map(c => c.charCodeAt(0)));
      let n = 0;
      while (M.u8[sPtr + n] && accept.has(M.u8[sPtr + n])) n++;
      return n;
    },
    strcspn: (sPtr, rejectPtr) => {
      const reject = new Set([...M.mod.cstr(rejectPtr)].map(c => c.charCodeAt(0)));
      let n = 0;
      while (M.u8[sPtr + n] && !reject.has(M.u8[sPtr + n])) n++;
      return n;
    },

    /*
     * gettimeofday, deterministic by default like clock() and for the same reason. It advances one
     * Doom tic (1/35 s) per call, which is enough for a program that polls it to make progress —
     * Doom's D_DoomLoop spins until I_GetTime reports a new tic, so a frozen clock is an infinite
     * loop. installRealClock replaces it where real time is wanted.
     */
    gettimeofday: (tv, _tz) => {
      checkLeash(M);
      M.wallMicros = (M.wallMicros ?? EPOCH_US) + 28571;
      if (tv) {
        M.mod.dv.setInt32(tv, Math.floor(M.wallMicros / 1e6), true);
        M.mod.dv.setInt32(tv + 4, M.wallMicros % 1e6, true);
      }
      return 0;
    },

    atof: (p) => { const v = parseFloat(M.mod.cstr(p)); return Number.isNaN(v) ? 0 : v; },
    atol: (p) => { const v = parseInt(M.mod.cstr(p), 10); return Number.isNaN(v) ? 0 : v | 0; },

    /*
     * POSIX file descriptors, the three calls Quake's Con_DebugLog uses and nothing more. They ride
     * on the same store as stdio (see src/env/stdio.js), so a file written through a descriptor is
     * readable through `fopen` — which is what a program that mixes the two expects.
     */
    memchr: (p, c, n) => { c &= 0xff; for (let i = 0; i < n; i++) if (u8()[p + i] === c) return p + i; return 0; },

    /**
     * Walk a va_list. Each argument occupies a whole number of 4-byte slots, which is how i386
     * lays varargs on the stack; the OLD position is returned so `*(type *)` reads this argument
     * and the list already points at the next one.
     */
    __prism_va_next: (pp, size) => {
      const cur = M.loadPtr(pp);
      // A zero-sized argument advances by ZERO, not by one slot: the `|| 1` fallback here disagreed
      // with the caller's packing, which desynchronised every argument after a `struct { char x[0]; }`
      // (gcc's va-arg-22.c passes 21 structs by value, the first of them empty). The slot is the
      // model's int: four bytes on i386, one 8086 stack word under a 16-bit model.
      const unit = M.abi.int;
      const step = Math.ceil((size | 0) / unit) * unit;
      M.storePtr(pp, cur + step);
      return cur;
    },

    /**
     * A DETERMINISTIC clock — the default, and what every gate runs against. Reading the host's real
     * time would destroy the property the whole test strategy rests on: the same input must yield
     * byte-identical state, which is what makes a golden fingerprint possible at all (MIRAGE keeps
     * the same rule: no Date, no Math.random).
     *
     * The increments are one frame's worth per call — 16667 µs and 19886 PIT ticks are 1/60 s — which
     * has a consequence worth stating out loud rather than leaving as a happy accident. MAME 0.1
     * throttles itself with
     *
     *     do { curr = uclock(); } while ((curr - prev) < UCLOCKS_PER_SEC/drv->frames_per_second);
     *
     * and against this clock that loop exits after exactly ONE call. The program believes it waited;
     * it did not. Determinism is bought by neutralising the program's own timing, and something else
     * then has to do the pacing. See `installRealClock` for the interactive answer.
     */
    clock: () => { M.clockTicks = (M.clockTicks + 16667) >>> 0; return M.clockTicks; },
    // uclock returns a 64-bit count, so a BigInt — see the i64 note in emit.js.
    uclock: () => { M.uclockTicks += 19886n; return M.uclockTicks; },
    time: (p) => { const t = 852076800; if (p) dv().setInt32(p, t, true); return t; },

    /**
     * setjmp/longjmp. The buffer records the shadow-stack frame that called setjmp and the resume
     * point inside that function; longjmp throws, and the frame's own dispatch loop recognises its
     * own fp and resumes. A longjmp into a frame that has already returned is undefined in C, and
     * here it simply finds no catcher and surfaces as an error rather than corrupting anything.
     */
    __prism_setjmp: (env, fp, pc) => {
      dv().setInt32(env, fp | 0, true);
      dv().setInt32(env + 4, pc | 0, true);
      // The stack pointer AS IT IS HERE, which is not the frame base: anything alloca'd before the
      // setjmp is still alive after the longjmp, and gcc's built-in-setjmp.c reads exactly that.
      dv().setInt32(env + 8, M.sp | 0, true);
      return 0;
    },
    longjmp: (env, val) => {
      const fp = dv().getInt32(env, true);
      const pc = dv().getInt32(env + 4, true);
      const sp = dv().getInt32(env + 8, true);
      // C says longjmp(env, 0) makes setjmp return 1.
      throw { __prismJmp: fp, pc, sp, val: (val | 0) === 0 ? 1 : (val | 0) };
    },

    // --- gcc builtins that are not library calls
    __builtin_expect: (v, _expected) => v,

    /*
     * The host's millisecond clock, for a platform layer that has to schedule -- Win32 timers are
     * the first caller. It belongs here rather than in a device: a clock is not a socket, and a
     * target that has one and not the other should not have to choose.
     */
    prism_now_ms: () => { checkLeash(M); return Date.now(); },

    /*
     * Bitfields of a 64-bit type, byte-wise in BigInt.
     *
     * Bytes are the only unit that always contains the field -- a 64-bit-wide field starting at bit
     * 7 spans nine of them -- and BigInt is the only arithmetic here that holds the result. The
     * width and the DECLARED signedness decide the value that comes back; asIntN is the sign
     * extension, done once rather than in each caller.
     */
    __prism_bf_get64: (addr, bitOffset, width, signed) => {
      const byte = addr + (bitOffset >> 3), bit = BigInt(bitOffset & 7);
      const n = Math.ceil(((bitOffset & 7) + width) / 8);
      let raw = 0n;
      for (let i = n - 1; i >= 0; i--) raw = (raw << 8n) | BigInt(M.u8[byte + i]);
      const v = (raw >> bit) & ((1n << BigInt(width)) - 1n);
      return signed ? BigInt.asIntN(width, v) : BigInt.asUintN(width, v);
    },
    __prism_bf_set64: (addr, bitOffset, width, value) => {
      const byte = addr + (bitOffset >> 3), bit = bitOffset & 7;
      const n = Math.ceil((bit + width) / 8);
      const v = BigInt.asUintN(width, BigInt(value));
      for (let i = 0; i < n; i++) {
        const lo = Math.max(0, bit - 8 * i);              // first bit of this byte inside the field
        const hi = Math.min(8, bit + width - 8 * i);      // one past the last
        const keep = (~(((1 << hi) - (1 << lo)) & 0xff)) & 0xff;
        const from = BigInt(8 * i - bit + lo);
        const bits = Number((v >> from) & 0xffn) << lo;
        M.u8[byte + i] = (M.u8[byte + i] & keep) | (bits & ~keep & 0xff);
      }
    },

    /*
     * The overflow builtins, in BigInt because that is what can tell 2^63 from -2^63.
     *
     * Both halves are required and the second is the one that is easy to get wrong: the result is
     * stored WRAPPED to the destination type whether or not it overflowed, and only the return value
     * says which happened. gcc documents that, and its tests check the stored value in the overflow
     * case.
     */
    __prism_overflow: (op, a, b, dst, size, signed) => {
      const A = BigInt(a), B = BigInt(b);
      const exact = op === 'add' ? A + B : op === 'sub' ? A - B : A * B;
      const bits = BigInt(size * 8);
      const wrapped = signed ? BigInt.asIntN(size * 8, exact) : BigInt.asUintN(size * 8, exact);
      const dv = M.mod.dv;
      if (dst) {
        if (size === 1) dv.setUint8(dst, Number(BigInt.asUintN(8, exact)));
        else if (size === 2) dv.setUint16(dst, Number(BigInt.asUintN(16, exact)), true);
        else if (size === 4) dv.setUint32(dst, Number(BigInt.asUintN(32, exact)), true);
        else if (size === 8) dv.setBigUint64(dst, BigInt.asUintN(64, exact), true);
        else return 1;
      }
      void bits;
      return exact === wrapped ? 0 : 1;
    },

    /*
     * The bit-counting builtins. gcc leaves ffs/clz/ctz UNDEFINED at zero and its own tests never
     * ask, so zero answers zero rather than inventing something a program might come to rely on.
     * Math.clz32 does the work for the 32-bit cases; the 64-bit ones arrive as BigInt.
     */
    __builtin_ffs: (v) => { v |= 0; return v === 0 ? 0 : 32 - Math.clz32(v & -v); },
    __builtin_clz: (v) => Math.clz32(v >>> 0),
    __builtin_ctz: (v) => { v >>>= 0; return v === 0 ? 0 : 31 - Math.clz32(v & -v); },
    __builtin_popcount: (v) => {
      v = (v >>> 0) - ((v >>> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    },
    __builtin_parity: (v) => lib.__builtin_popcount(v) & 1,
    __builtin_bswap16: (v) => ((v & 0xff) << 8) | ((v >>> 8) & 0xff),
    __builtin_bswap32: (v) => (((v & 0xff) << 24) | ((v & 0xff00) << 8) |
                               ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0,
    __builtin_bswap64: (v) => {
      let r = 0n, x = BigInt.asUintN(64, v);
      for (let i = 0; i < 8; i++) { r = (r << 8n) | (x & 0xffn); x >>= 8n; }
      return BigInt.asUintN(64, r);
    },

    /* Classification. signbit is about the SIGN BIT, so it must answer 1 for -0.0. */
    __builtin_signbit: (v) => (v < 0 || Object.is(v, -0) ? 1 : 0),
    __builtin_isinf: (v) => (v === Infinity ? 1 : v === -Infinity ? -1 : 0),
    __builtin_isnan: (v) => (Number.isNaN(v) ? 1 : 0),
    copysign: (x, y) => (lib.__builtin_signbit(y) ? -Math.abs(x) : Math.abs(x)),
    copysignf: (x, y) => Math.fround(lib.copysign(x, y)),

    /* mempcpy and stpcpy return the END rather than the start: the GNU point of both. */
    mempcpy: (d, s, n) => { lib.memcpy(d, s, n); return (d + n) | 0; },
    stpcpy: (d, s) => { const n = strlenAt(s); lib.memcpy(d, s, n + 1); return (d + n) | 0; },
    __builtin_prefetch: () => {},
    // A stub that returns 0 here does not "not support" the builtin, it LIES: the caller compares
    // the result and its own check fails, turning a clean refusal into a miscompile
    // (frame-address.c). Refusing is the honest answer until there is a real call stack to report.
    __builtin_return_address: () => { throw new Trap('__builtin_return_address is not supported'); },
    // A compiler is always allowed to answer 0 here; PRISM has not folded the argument, so it must.
    __builtin_constant_p: () => 0,
    /**
     * alloca: bump the shadow stack DOWN. The caller's epilogue restores M.sp to its frame top,
     * which frees it at function exit — exactly alloca's contract.
     */
    alloca: (n) => {
      const size = Math.ceil(((n | 0) + 15) / 16) * 16;
      M.sp = (M.sp - size) | 0;
      if (M.sp < M.mod.stackLimit) throw new Trap('shadow stack overflow in alloca');
      return M.sp;
    },

    // --- math (double in, double out; the emitter has already coerced)
    sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan,
    asin: Math.asin, acos: Math.acos,
    /*
     * round() goes AWAY FROM ZERO on a tie, which Math.round does not: Math.round(-0.5) is -0 and
     * round(-0.5) is -1. OpenTyrian calls roundf 25 times, in its scaler.
     */
    round: (x) => Math.sign(x) * Math.round(Math.abs(x)),
    trunc: Math.trunc,
    lround: (x) => (Math.sign(x) * Math.round(Math.abs(x))) | 0,
    atan2: Math.atan2, exp: Math.exp, log: Math.log, log10: Math.log10, pow: Math.pow,
    floor: Math.floor, ceil: Math.ceil, fabs: Math.abs,
    /*
     * The float family. Math.fround on the way out is not a nicety: the C library computes in the
     * float type, and keeping double precision through fabsf would make PRISM's answer differ from
     * gcc's in the last bits -- the exact class of bug the csmith differential is for.
     */
    sqrtf: (x) => Math.fround(Math.sqrt(x)), sinf: (x) => Math.fround(Math.sin(x)),
    cosf: (x) => Math.fround(Math.cos(x)), tanf: (x) => Math.fround(Math.tan(x)),
    roundf: (x) => Math.fround(Math.sign(x) * Math.round(Math.abs(x))),
    truncf: (x) => Math.fround(Math.trunc(x)),
    atanf: (x) => Math.fround(Math.atan(x)),
    atan2f: (y, x) => Math.fround(Math.atan2(y, x)),
    expf: (x) => Math.fround(Math.exp(x)), logf: (x) => Math.fround(Math.log(x)),
    log10f: (x) => Math.fround(Math.log10(x)),
    powf: (x, y) => Math.fround(Math.pow(x, y)),
    floorf: (x) => Math.fround(Math.floor(x)), ceilf: (x) => Math.fround(Math.ceil(x)),
    fabsf: (x) => Math.fround(Math.abs(x)),
    fmodf: (x, y) => Math.fround(x % y),
    ldexp: (x, e) => x * Math.pow(2, e | 0),
    ldexpf: (x, e) => Math.fround(x * Math.pow(2, e | 0)),
    frexp: (x, ep) => {
      if (x === 0 || !Number.isFinite(x)) { if (ep) M.storeInt(ep, 0); return x; }
      const e = Math.ceil(Math.log2(Math.abs(x)));
      let m = x / Math.pow(2, e), exp = e;
      // log2 can land a bit off at the boundary; normalise into [0.5, 1).
      while (Math.abs(m) >= 1) { m /= 2; exp++; }
      while (Math.abs(m) < 0.5) { m *= 2; exp--; }
      if (ep) M.storeInt(ep, exp);
      return m;
    },
    fmod: (a, b) => a % b,
  };
  return lib;
}

/**
 * printf. Written out rather than delegated because the format quirks are observable and the gate
 * compares stdout byte for byte against glibc's.
 */
/**
 * Where a formatting call's arguments come from. Two sources, one interface.
 *
 * `printf` is emitted with its extras packed into a JS array, one slot per argument. `vsprintf` is
 * handed a `va_list`, which on i386 is a plain pointer into the caller's packed buffer — so the
 * arguments have to be read out of GUEST MEMORY at their real widths: 4 bytes for an int or a
 * pointer, 8 for a double (varargs promote float) or a `long long`.
 *
 * Splitting the reader is what lets one formatter serve both. The conversion tells us the width, so
 * the reader never has to guess.
 */
/*
 * The readers `format` takes its arguments from. `int`, `long` and `ptr` are the three widths a
 * conversion can ask for; on i386 all three are the same four bytes, which is why a JS array of
 * values (what the emitter passes the printf family there) is enough. Under a 16-bit model the
 * arguments arrive packed as Borland's caller pushes them -- int 2, long 4, near pointer 2, double 8
 * -- and a `%d` given a long reads its low word, as the real machine does.
 */
function arrayReader(args) {
  let i = 0;
  const next = () => args[i++];
  return { i32: next, f64: next, i64: next, int: next, long: next, ptr: next, intBits: 32 };
}

export function vaReader(M, ap) {
  let p = ap | 0;
  const dv = M.mod.dv;
  const { int, ptr } = M.abi ?? { int: 4, ptr: 4 };
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  return {
    i32,
    long: i32,
    int: int === 2 ? () => { const v = dv.getInt16(p, true); p += 2; return v; } : i32,
    ptr: ptr === 2 ? () => { const v = dv.getUint16(p, true); p += 2; return v; } : i32,
    f64: () => { const v = dv.getFloat64(p, true); p += 8; return v; },
    i64: () => { const v = dv.getBigInt64(p, true); p += 8; return v; },
    intBits: int * 8,
  };
}

/**
 * A formatted result, as BYTES.
 *
 * `format` builds a string in which every character is one byte -- that is what %c produces and what
 * cstr returns -- so the encoding back is charCode & 0xFF, not UTF-8. Using TextEncoder here turned
 * every byte above 0x7F into two, which is how `sprintf("%c", 0xE4)` came out five bytes long
 * instead of four.
 */
export const bytesOf = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

export function format(M, fmtPtr, args) {
  const fmt = M.cstr(fmtPtr);
  const src = Array.isArray(args) ? arrayReader(args) : args;
  let out = '';
  // `*` and %c take an int; %s a data pointer. Array readers (i386) have no widths to choose between.
  const nextArg = () => (src.int ?? src.i32)();
  const nextPtr = () => (src.ptr ?? src.i32)();
  const intBits = src.intBits ?? 32;

  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') { out += c; continue; }
    i++;
    if (fmt[i] === '%') { out += '%'; continue; }

    let flags = '';
    while ('-+ #0'.includes(fmt[i])) flags += fmt[i++];
    let width = '';
    if (fmt[i] === '*') { width = String(nextArg() | 0); i++; }
    else while (/[0-9]/.test(fmt[i])) width += fmt[i++];
    let prec = null;
    if (fmt[i] === '.') {
      i++; prec = '';
      if (fmt[i] === '*') { prec = String(nextArg() | 0); i++; }
      else while (/[0-9]/.test(fmt[i])) prec += fmt[i++];
      /*
       * C99 7.19.6.1p4: a '.' with no digits after it means a precision of ZERO. Every call site
       * below used to read the empty string as "no precision given" and substitute its own default,
       * so `printf("%.u", 0)` printed "0" where C prints nothing, and `printf("%.f", 1.5)` printed
       * six decimals instead of none. Settled here so no call site has to remember.
       */
      if (prec === '') prec = '0';
    }
    /*
     * The length modifier does two different jobs and only one of them was being done.
     *
     * WIDENING: `ll` (and q, j) is 64 bits on i386, and the emitter hands a BigInt for those.
     * Everything else is 32 bits, `l` included.
     *
     * NARROWING: `h` and `hh` do not change how the argument ARRIVES -- default promotion has
     * already made it an int -- they change what the conversion prints. C99 7.19.6.1p7 says the
     * value is converted to short or signed char first, so `%hhd` of 4104 is 8, not 4104. gcc's
     * pr78622.c checks exactly that and it was passing only because __builtin_snprintf was missing:
     * a refusal was hiding a wrong answer.
     */
    let len = '';
    while ('hlLqjzt'.includes(fmt[i])) len += fmt[i++];
    const wide64 = len.includes('ll') || len === 'q' || len === 'j';
    // An integer conversion reads an int, or a long with `l` -- which differ under a 16-bit model --
    // and its value is taken at that width.
    const isLong = !wide64 && len.includes('l');
    const intIn = () => (wide64 ? src.i64() : isLong ? (src.long ?? src.i32)() : nextArg());
    const bits = wide64 ? 64 : isLong ? 32 : intBits;
    const narrowBits = len === 'hh' ? 8 : len === 'h' ? 16 : 0;
    const narrow = (v, signed) => {
      if (!narrowBits || typeof v === 'bigint') return v;
      const sh = 32 - narrowBits;
      return signed ? (v << sh) >> sh : (v << sh) >>> sh;
    };

    const conv = fmt[i];
    let body;
    switch (conv) {
      case 'd': case 'i': body = String(intArg(narrow(intIn(), true), bits, true)); break;
      case 'u': body = String(intArg(narrow(intIn(), false), bits, false)); break;
      case 'x': body = intArg(narrow(intIn(), false), bits, false).toString(16); break;
      case 'X': body = intArg(narrow(intIn(), false), bits, false).toString(16).toUpperCase(); break;
      case 'o': body = intArg(narrow(intIn(), false), bits, false).toString(8); break;
      case 'c': body = String.fromCharCode(nextArg() & 0xff); break;
      case 's': {
        const p = nextPtr() | 0;
        body = p === 0 ? '(null)' : M.cstr(p);
        if (prec !== null) body = body.slice(0, +prec);
        break;
      }
      case 'p': {
        // Borland prints a pointer as its segment and offset, which no PRISM address reproduces.
        if (intBits !== 32) throw new Error('printf %p under a 16-bit model: Borland prints SSSS:OOOO, which PRISM does not model');
        const v = (nextPtr() | 0) >>> 0;
        body = v === 0 ? '(nil)' : '0x' + v.toString(16);
        break;
      }
      case 'f': case 'F': body = fixed(src.f64(), prec === null ? 6 : +prec); break;
      case 'e': case 'E': {
        const p = prec === null ? 6 : +prec;
        const v = src.f64();
        const nf = nonFinite(v);
        if (nf !== null) { body = nf; if (conv === 'E') body = body.toUpperCase(); break; }
        body = signOfZero(v) + v.toExponential(p);
        // C writes at least two exponent digits; JS writes one.
        body = body.replace(/e([-+])(\d)$/, 'e$10$2');
        if (conv === 'E') body = body.toUpperCase();
        break;
      }
      case 'g': case 'G': {
        const p = prec === null ? 6 : Math.max(1, +prec);
        const v = src.f64();
        const nf = nonFinite(v);
        if (nf !== null) { body = nf; if (conv === 'G') body = body.toUpperCase(); break; }
        body = gStyle(v, p, flags.includes('#'));
        if (conv === 'G') body = body.toUpperCase();
        break;
      }
      default:
        out += '%' + flags + width + (prec !== null ? '.' + prec : '') + (conv ?? '');
        continue;
    }

    /*
     * Flags, precision and width -- for every numeric conversion, which is the part that was wrong.
     *
     * This block used to run only for `diuxXo`, so a float received width padding and NOTHING else:
     * no `+`, no leading space, no zero fill, no `#`. `printf("%+#014.0f", 100)` produced "          100"
     * where C produces "+000000000100.", and Lua's strings.lua:351 asserts exactly that.
     *
     * Integers and floats differ in two specific ways, and both are in C99 7.19.6.1p6-8 rather than
     * in anybody's intuition:
     *
     *   - the `0` flag is IGNORED for d,i,o,u,x,X when a precision is given, and honoured for the
     *     float conversions regardless;
     *   - `#` means a base prefix for o,x,X and a forced decimal point for e,E,f,F,g,G.
     */
    const isInt = 'diuxXo'.includes(conv);
    const isFloat = 'eEfFgG'.includes(conv);
    if (isInt || isFloat) {
      let neg = body.startsWith('-');
      if (neg) body = body.slice(1);
      /*
       * inf and nan take no padding, no point and no prefix -- and ONLY a float conversion can
       * produce them. Testing every conversion for a letter made `%04X` of 0x6C print "  6C": the
       * hex digits ARE letters, so every value with an a-f digit silently lost its zero fill.
       */
      const special = isFloat && /[a-z]/i.test(body);
      if (isInt) {
        // Precision 0 with a value of 0 converts to NO characters at all (C99 7.19.6.1p8) -- which is
        // why the precision has to be distinguishable from absent, and why `%.u` of 0 is "".
        if (prec !== null && +prec === 0 && body === '0') body = '';
        else if (prec !== null && body.length < +prec) body = '0'.repeat(+prec - body.length) + body;
        if (flags.includes('#') && (conv === 'x' || conv === 'X') && body !== '0') body = (conv === 'x' ? '0x' : '0X') + body;
        // `#` on octal prefixes a 0, and only if there is not one already: `%#o` of 8 is "010", of 0 is
        // "0" and not "00". It was implemented for x and X alone, so `%#12o` of 10 gave "10" not "012".
        if (flags.includes('#') && conv === 'o' && !body.startsWith('0')) body = '0' + body;
      } else if (flags.includes('#') && !special && !body.includes('.')) {
        // The point goes before the exponent, not at the end: `%#.0e` of 1 is "1.e+00".
        const e = body.search(/[eE]/);
        body = e < 0 ? body + '.' : body.slice(0, e) + '.' + body.slice(e);
      }
      if (neg) body = '-' + body;
      else if (flags.includes('+')) body = '+' + body;
      else if (flags.includes(' ')) body = ' ' + body;
      if (width && body.length < +width) {
        if (flags.includes('-')) body = body.padEnd(+width);
        else if (flags.includes('0') && !special && (isFloat || prec === null)) {
          /*
           * The zeros go after ANYTHING that has to stay leftmost -- the sign, and also the `0x`
           * that `#` prefixes. Treating only the sign that way printed `%#010x` of 255 as
           * "0000000xff" where C gives "0x000000ff". Octal's `#` needs no such care: the 0 it
           * prepends is an ordinary digit and belongs with the rest.
           */
          const head = (/^([-+ ]?)(0[xX])?/.exec(body) ?? ['', '', ''])[0];
          const rest = body.slice(head.length);
          body = head + '0'.repeat(+width - body.length) + rest;
        } else body = body.padStart(+width);
      }
    } else if (width) {
      body = flags.includes('-') ? body.padEnd(+width) : body.padStart(+width);
    }
    out += body;
  }
  return out;
}

/**
 * One integer argument, at the width the conversion asks for. Returns a Number for 32-bit and a
 * BigInt for 64-bit, because neither JS type converts to the other implicitly — `nextArg() | 0` on a
 * BigInt throws outright, which is how `%lld` announced itself.
 */
function intArg(v, bits, signed) {
  if (bits === 64) {
    const b = typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v) || 0));
    return signed ? BigInt.asIntN(64, b) : BigInt.asUintN(64, b);
  }
  const n = typeof v === 'bigint' ? Number(BigInt.asIntN(32, v)) : (v | 0);
  if (bits === 16) return signed ? (n << 16) >> 16 : n & 0xffff;
  return signed ? (n | 0) : (n >>> 0);
}

/**
 * `%.*f`, expanded EXACTLY.
 *
 * Two things this has to get right, and the arithmetic of doubles gives neither for free.
 *
 * The tie. C rounds a tie to EVEN (IEEE round-to-nearest-even) and `toFixed` rounds away from zero,
 * so `printf("%.0f", 2.5)` is "2" in C and "3" from toFixed -- measured against glibc, not assumed.
 *
 * The magnitude. `printf("%.99f", -1e308)` prints all 309 integer digits, and no amount of care with
 * doubles will produce them: `1e308 * 1e99` is Infinity, and `String` of anything past 1e21 comes
 * back in exponential notation. Lua's own strings.lua:272 asserts on the length of exactly that.
 *
 * So the expansion runs in BigInt. A double IS an exact binary rational -- m * 2^e for integers m
 * and e -- so `value * 10^p` is an exact ratio, and rounding it is a comparison of two integers
 * rather than a floating-point guess. There is no double rounding left to worry about, which the
 * scaled-multiply version had by construction.
 */
/**
 * The minus sign of a negative zero, which JavaScript drops on the way to text.
 *
 * `String(-0)` is "0" and `(-0).toExponential(2)` is "0.00e+0"; C prints "-0" and "-0.00e+00". The
 * value itself survives -- `1/-0` is -Infinity here as everywhere -- so this is purely a formatting
 * loss, and the only place it can be repaired is at the point of formatting. `fixed()` already had
 * to handle it separately, which is what made it worth naming.
 *
 * Lua found it through `%a`. Its hex-float writer special-cases zero as `l_sprintf(buff, sz,
 * LUA_NUMBER_FMT "x0p+0", x)` -- so the sign of `string.format("%a", -0.0)` comes out of OUR `%g`,
 * three layers away from anything that mentions hexadecimal. The same bug made `tostring(-0.0)`
 * print "0.0" instead of "-0.0", since that is `%.14g` too.
 */
const signOfZero = (v) => (Object.is(v, -0) ? '-' : '');

/**
 * What C prints for a value that is not a number: "nan", "inf", "-inf" -- and the uppercase
 * conversions get "NAN"/"INF" for free, because they upper-case the whole body afterwards.
 *
 * `fixed()` had this right and `%e`/`%g` did not, so `printf("%g", 1.0/0.0)` produced the JavaScript
 * spelling "Infinity". Lua's strings.lua:329 asserts `string.format("%a", 1/0)` starts with "inf",
 * and its hex-float writer delegates the non-finite case to `%g` -- the same three-layer path that
 * exposed the negative zero above. Returning null means "an ordinary number, carry on".
 */
const nonFinite = (v) => (Number.isNaN(v) ? 'nan' : Number.isFinite(v) ? null : (v > 0 ? 'inf' : '-inf'));

/**
 * `%g` / `%G`, by the rule C states rather than by whatever `toPrecision` happens to do.
 *
 * C99 7.19.6.1p8: with precision P (a P of 0 counts as 1) and X the decimal exponent the value would
 * have in style e -- style f is used with precision P-1-X when P > X >= -4, and style e with
 * precision P-1 otherwise. Trailing zeros are then removed from the fractional part unless `#`.
 *
 * The old one-liner, `String(Number(v.toPrecision(P)))`, agrees with that surprisingly often, which
 * is why it survived: it is right for 0.1, for 100, for 1e30. It is wrong exactly where the two
 * disagree about the crossover, and `printf("%.1g", 1024)` is such a place -- X is 3 and P is 1, so
 * C picks style e and prints "1e+03" while `String(1000)` prints "1000". Lua's strings.lua:361
 * asserts that one. It also wrote one-digit exponents, where C writes at least two.
 */
function gStyle(v, P, alt) {
  const p = P < 1 ? 1 : P;
  const X = Number(v.toExponential(p - 1).split('e')[1]);
  // Only one of these two branches loses the sign of a negative zero: `fixed` carries it, and
  // `toExponential` does not. Adding it at the call site instead gave `%g` of -0.0 as "--0".
  let body = (p > X && X >= -4)
    ? fixed(v, Math.max(0, p - 1 - X))
    : signOfZero(v) + v.toExponential(p - 1);
  if (!alt) {
    // Only the mantissa's fractional zeros go, and the point with them if nothing is left after it.
    const e = body.search(/[eE]/);
    let mant = e < 0 ? body : body.slice(0, e);
    const exp = e < 0 ? '' : body.slice(e);
    if (mant.includes('.')) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
    body = mant + exp;
  }
  return body.replace(/e([-+])(\d)$/, 'e$10$2');
}

function fixed(v, p) {
  const nf = nonFinite(v);
  if (nf !== null) return nf;
  const neg = v < 0 || Object.is(v, -0);
  const a = Math.abs(v);

  // m * 2^e, read straight out of the bits: 1 sign, 11 exponent, 52 mantissa.
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, a);
  const bits = buf.getBigUint64(0);
  const rawExp = Number((bits >> 52n) & 0x7ffn);
  const frac52 = bits & 0xfffffffffffffn;
  // A subnormal has no implicit leading 1, and its exponent is fixed at the smallest one.
  const m = rawExp === 0 ? frac52 : (frac52 | 0x10000000000000n);
  const e = rawExp === 0 ? -1074 : rawExp - 1075;

  const pow10 = 10n ** BigInt(p);
  let q;
  if (e >= 0) {
    q = m * (1n << BigInt(e)) * pow10;          // exact; nothing to round
  } else {
    const den = 1n << BigInt(-e);
    const num = m * pow10;
    q = num / den;
    const r2 = (num % den) * 2n;
    // Half to even, which is what C does and what a comparison of integers can decide exactly.
    if (r2 > den || (r2 === den && (q & 1n) === 1n)) q += 1n;
  }

  const digits = q.toString().padStart(p + 1, '0');
  const int = p ? digits.slice(0, -p) : digits;
  const frac = p ? digits.slice(-p) : '';
  return (neg ? '-' : '') + int + (p ? '.' + frac : '');
}

/**
 * Replace the deterministic clock with a real, scalable one that does not spin.
 *
 * A DOS program of this era paces itself by busy-waiting on a clock, and MAME 0.1 does exactly that
 * (machine.c, `Z80_Interrupt`). Two ways to host that, both wrong on their own:
 *
 *   * a deterministic per-call counter — the wait exits immediately, the program's own timing is
 *     neutralised, and the host has to impose a frame rate from outside. Reproducible, unfaithful.
 *   * a real clock — the wait becomes a genuine spin loop that burns a whole core for the rest of
 *     every frame. Faithful, and exactly what the program did on real hardware, which is precisely
 *     why it is wasteful here.
 *
 * This is the third option: the clock returns real elapsed time, and when it is being polled in a
 * tight loop it SLEEPS before answering. The program sees monotonic real time and its own throttle
 * does the pacing, at the rate the program itself chose; nothing spins. The trick is only possible
 * because the clock is a function call into the runtime — there is no instruction stream to watch.
 *
 * `speed` scales it, which is how a speed control should work: lie about time, the way DOSBox does,
 * rather than fight the program's throttle from outside. At 200% the program's wait is satisfied
 * twice as fast. At 0 (unlimited) time races ahead so no wait is ever satisfied slowly.
 *
 * NOT the default, and never in the gates: this is where reproducibility is traded for faithfulness,
 * and that trade belongs to an interactive host only.
 */
export function installRealClock(M, { now, speed = () => 100, paused = () => false } = {}) {
  const clockNow = now || (() => performance.now());
  let wall = clockNow();          // host time at the last advance
  let micros = 0;                 // guest time elapsed, in microseconds

  function advance() {
    const t = clockNow();
    const pct = speed();
    if (paused()) { wall = t; return micros; }        // a paused program's clock must not run on
    if (pct <= 0) {
      // Unlimited: hand out a large jump, so any "has enough time passed" test says yes at once and
      // the program's own throttle never waits.
      micros += 1e6;
    } else {
      micros += (t - wall) * 1000 * pct / 100;
    }
    wall = t;
    return micros;
  }

  M.rt.clock = () => (advance() >>> 0);
  /*
   * gettimeofday too, from the same scaled clock. Doom times itself with it rather than with clock(),
   * so leaving it on the deterministic counter meant Doom ran as fast as the host could go — the same
   * "not a game, a blur" that the pacer exists to prevent.
   */
  M.rt.gettimeofday = (tv, _tz) => {
    checkLeash(M);
    // EPOCH_US for the same reason as the deterministic one: tv_sec must never be zero.
    const us = advance() + EPOCH_US;
    if (tv) {
      M.mod.dv.setInt32(tv, Math.floor(us / 1e6), true);
      M.mod.dv.setInt32(tv + 4, Math.floor(us % 1e6), true);
    }
    return 0;
  };
  M.rt.uclock = () => BigInt(Math.round(advance() * 1.19318));   // µs -> PIT ticks at 1193180 Hz
  M.realClock = { micros: () => micros };
}

/**
 * Turn the guest's spin-wait loops into sleeping waits, without knowing anything about the loops.
 *
 * A DOS program of this era waits by polling. MAME 0.1 alone has
 *
 *     do { curr = uclock(); } while ((curr - prev) < UCLOCKS_PER_SEC/drv->frames_per_second);
 *     while (osd_key_pressed(OSD_KEY_P));            // wait for key release, three times over
 *
 * The runtime cannot see a loop — but it does see every call into a service, and that is enough. A
 * service called over and over with NO FRAME PRESENTED in between is a program that is waiting, not
 * a program making progress: in normal play `osd_key_pressed` is asked a dozen times per frame and
 * the frame counter moves; inside a release-wait it is asked thousands of times and nothing moves.
 *
 * Past the threshold each call parks for a millisecond, so the loop runs about a thousand times a
 * second instead of millions, and the core goes idle. The program's own logic is untouched — it is
 * still polling, it still decides when to stop.
 *
 * The threshold has to be MEASURED, not chosen. Too low and a timer-calibration loop — the kind that
 * counts iterations per tick — concludes the machine is a thousand times slower than it is, which is
 * the trap MIRAGE hit with Wolf3D. Too high and the core burns for longer than it needs to.
 *
 * What this deliberately does NOT catch: a loop that never calls the runtime at all, `while (1);`
 * being the honest example. Nothing here can see it, because nothing here is called. The only recourse
 * is terminating the worker, and the general fix would be a safepoint on loop back-edges in the
 * emitted code — which MIRAGE measured as a real cost on emitted-code speed, so it waits until
 * something needs it.
 */
export function installSpinDamping(M, {
  park = () => {}, frame, now = () => performance.now(),
  threshold = 256, sleepMs = 1, landingMs = 1.2, services,
} = {}) {
  /*
   * `services` may be a list (all sharing `threshold`) or a map of name -> threshold. Per-service is
   * not fussiness: the thresholds differ by two orders of magnitude for a measured reason. A frame's
   * legitimate polling of `osd_key_pressed` peaked at 21 over 400 frames of Pac-Man, but a program
   * asks the clock once or twice a frame — so a threshold high enough for the keyboard left 4096
   * clock calls spinning before every single frame's wait, which measured as ~0.6 ms of pure
   * overhead per frame and held the rate to 58 fps.
   */
  const limit = Array.isArray(services)
    ? Object.fromEntries(services.map(n => [n, threshold]))
    : services;
  let lastName = '', run = 0, lastFrame = -1, runStart = 0, lastAt = 0;
  // maxRun per service CALIBRATES the threshold: the longest run of consecutive calls seen inside one
  // frame, so the threshold has to sit above the largest legitimate one.
  const stats = { parks: 0, spins: 0, calls: 0, maxRun: Object.create(null), learned: Object.create(null) };

  for (const name of Object.keys(limit)) {
    const inner = M.rt[name];
    if (typeof inner !== 'function') continue;
    stats.maxRun[name] = 0;
    stats.learned[name] = 0;

    M.rt[name] = function (...args) {
      const f = frame();
      if (name !== lastName || f !== lastFrame) {
        // A run just ended: remember how long it took, because that is the program's own deadline,
        // observed rather than declared. This is the only source for it — the loop's exit condition
        // is invisible from here.
        // `lastAt`, not `now()`: the run ended at its LAST CALL, and we only notice here — which can
        // be a whole frame of emulation later. Measuring to this moment learned the frame PERIOD
        // (~17.5 ms) instead of the wait (~16 ms), so the landing window sat past the deadline and
        // the rate stayed stuck at 57 fps.
        // `>=`, not `>`: the run counter is CLAMPED to the limit once damping starts, so a strict
        // comparison was never true and this never recorded anything. The landing window silently did
        // nothing for three measurements — `spins` stayed at 0 and every `learned` at 0, which is how
        // it was caught.
        if (lastName && run >= limit[lastName]) stats.learned[lastName] = lastAt - runStart;
        lastName = name; lastFrame = f; run = 0; runStart = now();
      }
      run++;
      if (run > stats.maxRun[name]) stats.maxRun[name] = run;

      if (run > limit[name]) {
        run = limit[name];                          // stay damped for as long as it keeps asking
        const elapsed = now() - runStart;
        const target = stats.learned[name];
        /*
         * Park, except in a narrow window around the moment this wait ended LAST time, where we let
         * the calls through and let the loop spin.
         *
         * The reason is measured: Atomics.wait does not honour a sub-millisecond timeout — asking for
         * 0.25 ms still costs about one — so parking right up to the deadline overshoots it and the
         * frame rate came out at 55-59 instead of 60. Sleeping through the bulk of the wait and
         * spinning only the last millisecond lands on it, and costs about 6% of one core rather than
         * a whole one.
         *
         * Outside that window it parks, which is what keeps an UNPREDICTABLE wait — a key release,
         * which lasts as long as a finger does — from spinning at all.
         */
        const landing = target > landingMs && elapsed > target - landingMs && elapsed < target + landingMs;
        if (landing) stats.spins++;
        else { stats.parks++; park(sleepMs); }
      }
      stats.calls++;
      lastAt = now();
      return inner.apply(this, args);
    };
  }

  M.spinDamping = stats;
}
