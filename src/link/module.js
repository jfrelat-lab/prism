// module.js — the linear memory image and the symbol/function tables.
//
// One ArrayBuffer, i386 flat: a pointer IS a 32-bit offset into it. Three regions, laid out low to
// high, because C code compares and casts pointers and expects a single ordered address space:
//
//   0x0000_0000  a reserved null page — a null dereference must fault, not silently read a global
//   0x0000_1000  statics (.data then .bss), address-stable for the life of the module
//   ...          the heap, growing up (malloc)
//   top          the shadow stack, growing DOWN (alloca, address-taken locals, struct returns)

export const NULL_GUARD = 0x1000;

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

    this.brk = NULL_GUARD;              // next free static address
    this.stackTop = memory - 16;        // the shadow stack grows down from here
    this.stackLimit = memory - stack;

    this.symbols = new Map();           // name -> {addr, size, type, kind}
    this.funcs = new Map();             // name -> {addr, fn|null, type}
    this.funcTable = [null];            // index 0 is the null function pointer
    this.strings = new Map();           // literal text -> addr, so identical literals share storage
  }

  /** Reserve `size` bytes of static storage, honouring `align`. */
  alloc(size, align = 4) {
    const a = Math.ceil(this.brk / align) * align;
    this.brk = a + Math.max(size, 0);
    if (this.brk >= this.stackLimit) throw new Error('static storage exhausted');
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
    // slice, not subarray: TextDecoder refuses a view onto a SharedArrayBuffer, and the image IS
    // shared in the browser. slice copies into an unshared buffer, which costs nothing here — C
    // strings passed across this boundary are file names and format strings, not payloads.
    return new TextDecoder().decode(this.u8.slice(addr, end));
  }
}

/** Function pointers live above any plausible data address so the two can never alias. */
export const FUNC_TAG = 0x7000_0000;
export const isFuncPtr = (p) => (p & FUNC_TAG) === FUNC_TAG && p > 0;
export const funcIndex = (p) => p & ~FUNC_TAG;
