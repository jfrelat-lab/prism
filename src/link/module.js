// module.js — the linear memory image and the symbol/function tables.
//
// One ArrayBuffer, i386 flat: a pointer IS a 32-bit offset into it. Four regions, laid out low to
// high, because C code compares and casts pointers and expects a single ordered address space:
//
//   0x0000_0000  a reserved null page — a null dereference must fault, not silently read a global
//   0x0000_0400  the PC's low megabyte: BDA, then the VGA windows at 0xA0000 and 0xB8000
//   0x0010_0000  statics (.data then .bss), address-stable for the life of the module
//   ...          the heap, growing up (malloc)
//   top          the shadow stack, growing DOWN (alloca, address-taken locals, struct returns)
//
// The low megabyte is reserved rather than handed to the program, and that is not decoration. A
// DJGPP program reaches video memory at linear 0xA0000/0xB8000 through `_dos_ds` and `sys/farptr.h`,
// so those have to BE those addresses for such code to compile unmodified. It also means the host can
// render text mode by reading 0xB8000 out of guest memory, with no idea whether the characters got
// there through `printf` or through the program poking video RAM itself — which is the whole point of
// emulating the environment rather than substituting a backend per program.
//
// It costs one megabyte of a 256 MB address space and buys the DJGPP memory model for free.

export const NULL_GUARD = 0x1000;
export const LOW_MEMORY = 0x100000;      // the PC's first megabyte, reserved
export const BDA = 0x400;                // BIOS data area: cursor position lives at 0x450/0x451
export const VRAM_TEXT = 0xb8000;        // 80x25, two bytes per cell: character then attribute
export const VRAM_GFX = 0xa0000;         // mode 13h and the EGA/VGA planar window
export const TEXT_COLS = 80, TEXT_ROWS = 25;

export class Module {
  /**
   * `shared` backs the image with a SharedArrayBuffer instead. The image is then visible to another
   * thread with no copy, which is what lets a browser display a frame while the guest's own main
   * loop — synchronous C that never yields — keeps running in a worker.
   */
  constructor({ memory = 64 * 1024 * 1024, stack = 1 * 1024 * 1024, shared = false } = {}) {
    this.buffer = shared ? new SharedArrayBuffer(memory) : new ArrayBuffer(memory);
    this.u8 = new Uint8Array(this.buffer);
    this.dv = new DataView(this.buffer);
    this.size = memory;

    this.brk = LOW_MEMORY;              // next free static address, above the PC's low megabyte
    this.stackTop = memory - 16;        // the shadow stack grows down from here
    this.stackLimit = memory - stack;

    this.symbols = new Map();           // name -> {addr, size, type, kind}
    this.funcs = new Map();             // name -> {addr, fn|null, type}
    this.funcTable = [null];            // index 0 is the null function pointer
    // One entry per emitted loop back edge, when safepoints are on. Names the loop for a report.
    this.safepoints = [];
    this.strings = new Map();           // literal text -> addr, so identical literals share storage
  }

  /** Reserve `size` bytes of static storage, honouring `align`. */
  /**
   * Static storage, from a bump pointer -- and it must never cross the heap's floor.
   *
   * `finalizeHeap` takes the heap base from `brk` ONCE, when every global has been placed, so
   * anything that called `alloc` afterwards handed out addresses the guest heap had already claimed,
   * and the two sides then wrote over each other. It surfaced as two unrelated-looking failures in
   * one Lua run: an error message reading "No such file or director" with a garbage byte where its
   * last character had been, and an out-of-bounds read in the collector at shutdown. The writer was
   * `strerror`, which interns its message the first time it is asked -- long after the base was
   * frozen. Nothing reported a collision because nothing was checking for one.
   *
   * Lazy interning is legitimate: an environment shim cannot know in advance which strings a program
   * will ask for (`getenv`, `strerror`, `setlocale`, `tmpnam` all intern on demand). So the room is
   * RESERVED -- finalizeHeap leaves a gap below the heap base and sets `staticLimit` to it -- and
   * exhausting the gap is now an error that names itself instead of silent corruption.
   */
  alloc(size, align = 4) {
    const a = Math.ceil(this.brk / align) * align;
    this.brk = a + Math.max(size, 0);
    if (this.brk >= (this.staticLimit ?? this.stackLimit)) {
      throw new Error('static storage exhausted' +
        (this.staticLimit ? ' (the reserved gap below the heap is full)' : ''));
    }
    return a;
  }

  defineGlobal(name, type) {
    const existing = this.symbols.get(name);
    if (existing) return existing;
    const addr = this.alloc(type.size ?? 4, type.align ?? 4);
    const sym = { name, addr, size: type.size ?? 4, type, kind: 'var' };
    this.symbols.set(name, sym);
    return sym;
  }

  /**
   * A function gets an address before it has a body, because a function pointer may be taken
   * before the definition is seen and the integer value must not change afterwards.
   */
  defineFunc(name, type) {
    let f = this.funcs.get(name);
    if (f) { if (type) f.type = type; return f; }
    const index = this.funcTable.length;
    this.funcTable.push(null);
    // A function "address" is its table index tagged into the high region, so it is never confused
    // with a data pointer and an indirect call can recover the index by masking.
    f = { name, index, addr: FUNC_TAG | index, fn: null, type };
    this.funcs.set(name, f);
    return f;
  }

  bindFunc(name, jsFn) {
    const f = this.funcs.get(name) ?? this.defineFunc(name, null);
    f.fn = jsFn;
    this.funcTable[f.index] = jsFn;
    // And the module-scope binding a direct call names, which no table lookup passes through.
    this.rebindEmitted?.(name, jsFn);
    return f;
  }

  /** A string literal: NUL-terminated bytes in static storage, deduplicated. */
  intern(bytes) {
    const key = String.fromCharCode(...bytes);
    const hit = this.strings.get(key);
    if (hit !== undefined) return hit;
    const addr = this.alloc(bytes.length + 1, 1);
    this.u8.set(bytes, addr);
    this.u8[addr + bytes.length] = 0;
    this.strings.set(key, addr);
    return addr;
  }

  read(addr, n) { return this.u8.subarray(addr, addr + n); }
  cstr(addr) {
    let end = addr;
    while (end < this.size && this.u8[end] !== 0) end++;
    /*
     * ONE BYTE, ONE CHARACTER. A C string is a sequence of bytes and nothing more -- it has no
     * encoding of its own -- so decoding it as UTF-8 here was a guess, and the guess was wrong in
     * both directions: `sprintf("%c", 0xE4)` came back out as the two bytes C3 A4, and Lua's own
     * strings.lua caught it at line 204.
     *
     * Mapping each byte to the character of the same code makes the round trip exact for every
     * byte, including the ones no UTF-8 decoder would accept. What the CONSOLE does with those
     * bytes is a separate question, answered where the console is -- see M.write.
     */
    let out = '';
    for (let i = addr; i < end; i += 4096) {
      out += String.fromCharCode(...this.u8.subarray(i, Math.min(i + 4096, end)));
    }
    return out;
  }
}

/** Function pointers live above any plausible data address so the two can never alias. */
export const FUNC_TAG = 0x7000_0000;
export const isFuncPtr = (p) => (p & FUNC_TAG) === FUNC_TAG && p > 0;
export const funcIndex = (p) => p & ~FUNC_TAG;
