// mem-strategy.js — pluggable emission for guest memory access, so competing designs can be
// measured against each other on real workloads instead of argued about.
//
// Why this exists. Today every emitted read costs
//   `m.planar && (a>>>16)===10 ? m.vga.readByte(a) : u8[a]`
// — a global property load, a range comparison, and (for writes) a second probe for the
// self-modifying-code page table. Synthetic benchmarks (tools/memdispatch.mjs, memems.mjs) put a
// page table at 91–124% of that in JS, and an unconditional read at 25–43%; but those are tight
// loops, the page table only pays off once there is address TRANSLATION to do (protected mode, EMS
// by redirection), and prior art cannot settle it — v86 compiles to WebAssembly and DOSBox is C, so
// neither says anything about JavaScript's cost model. Hence: implement the candidates, flag them,
// and measure in the engine.
//
//   MIRAGE_MEM_READ=inline|paged|shadow   (default inline)
//   MIRAGE_MEM_WRITE=inline|paged    (default inline)
//
// Read and write are selected INDEPENDENTLY, because the measurements say they are different
// problems: a write has side effects and must branch whatever we do, while a read might not.
//
// EVERY strategy must be observationally identical. golden + conformance are the gate, and they
// must pass for each combination, not just the default.

/** Strategy names, exported so tools can sweep the matrix. */
export const READ_STRATEGIES = ['inline', 'paged', 'shadow'];
export const WRITE_STRATEGIES = ['inline', 'paged'];

const envOr = (name, dflt) =>
  (typeof process !== 'undefined' && process.env && process.env[name]) || dflt;

export function resolveMemStrategy(opts = {}) {
  const read = opts.read || envOr('MIRAGE_MEM_READ', 'inline');
  const write = opts.write || envOr('MIRAGE_MEM_WRITE', 'inline');
  if (!READ_STRATEGIES.includes(read)) throw new Error(`unknown MIRAGE_MEM_READ "${read}" (have: ${READ_STRATEGIES.join(', ')})`);
  if (!WRITE_STRATEGIES.includes(write)) throw new Error(`unknown MIRAGE_MEM_WRITE "${write}" (have: ${WRITE_STRATEGIES.join(', ')})`);
  return { read, write };
}

/**
 * Build the emitters for one block.
 *   MM  — the address mask baked into this block
 *   NT  — the recompiler's temp allocator
 * Returns { prologue, memRead, memW }; `prologue` is appended to the block preamble so a strategy
 * can hoist its tables into locals (a property load per access is measurably worse than an array
 * index, and the paged form needs a scratch var to avoid probing the table twice).
 */
export function memPrologue(strategy) {
  const parts = [];
  parts.push('var _smc=0;');   // set by the inline write marker, tested at the instruction boundary
  if (strategy.read === 'paged' || strategy.write === 'paged') parts.push('var _po=0,_pw=0,_dv=m.dv;');
  if (strategy.read === 'paged') parts.push('var rdo=m.rdOfs;');
  if (strategy.write === 'paged') parts.push('var wro=m.wrOfs;');
  return parts.join('');
}

export function memEmitters(strategy, MM, NT) {
  return { memRead: READ[strategy.read](MM, NT), memW: WRITE[strategy.write](MM, NT) };
}

// ---- read -----------------------------------------------------------------------------------

const READ = {
  // Today's shape, character-for-character, so selecting it is provably a no-op.
  inline: (MM) => (a, sz) => sz === 8 ? `(m.planar&&(${a}>>>16)===10?m.vga.readByte(${a}):u8[${a}])`
    : sz === 16 ? `(m.planar&&(${a}>>>16)===10?m.r16(${a}):(u8[${a}]|(u8[(${a}+1)&${MM}]<<8)))`
      : `(m.planar&&(${a}>>>16)===10?m.r32(${a}):((u8[${a}]|(u8[(${a}+1)&${MM}]<<8)|(u8[(${a}+2)&${MM}]<<16)|(u8[(${a}+3)&${MM}]<<24))>>>0))`,

  // One probe of a per-page table whose entry is a BIASED offset (base - page<<12), so the whole
  // address is added and no offset mask is needed — the shape v86's TLB and DOSBox's paging.h both
  // use. A negative entry means "not plain RAM": device, or (for writes) a page holding translated
  // code. Multi-byte accesses take the helper whenever they could straddle a page boundary, which
  // the single flat array used to hide.
  //
  // The entry is physical - linear, a multiple of 4096 that is NEGATIVE whenever the page sits below
  // its linear address — every page of a Linux program (0804_8000h onto a few MiB) and Windows 9x's
  // kernel at C000_0000h. "Valid" used to be `>= 0`, so all of those took the helper; and above
  // 2^31 the plain sum overflowed. -1 can never be a page's bias, so it is the sentinel, and the sum
  // wraps modulo 2^32 the way the linear address does.
  paged: (MM) => (a, sz) => sz === 8 ? `((_po=rdo[${a}>>>12])!==-1?u8[(_po+${a})>>>0]:m.r8(${a}))`
    : sz === 16 ? `(((${a}&4095)<4095&&(_po=rdo[${a}>>>12])!==-1)?(_po=(_po+${a})>>>0,u8[_po]|(u8[_po+1]<<8)):m.r16(${a}))`
      : `(((${a}&4095)<4093&&(_po=rdo[${a}>>>12])!==-1)?_dv.getUint32((_po+${a})>>>0,true):m.r32(${a}))`,

  // No test at all. Correct only because vga.js mirrors the planar window into u8[] (see its
  // "linear read shadow" section) — the whole cost moves off the access path and onto planar
  // writes, which already go through a handler. 5 characters instead of 57, and the only shape
  // that won decisively in tools/memdispatch.mjs (25-43%). Its known hole is latch loading, dealt
  // with in vga.js; no emulator does this, so the gates are the only evidence.
  shadow: (MM) => (a, sz) => sz === 8 ? `u8[${a}]`
    : sz === 16 ? `(u8[${a}]|(u8[(${a}+1)&${MM}]<<8))`
      : `((u8[${a}]|(u8[(${a}+1)&${MM}]<<8)|(u8[(${a}+2)&${MM}]<<16)|(u8[(${a}+3)&${MM}]<<24))>>>0)`,
};

// ---- write ----------------------------------------------------------------------------------

// /*SMCABORT*/ marks where the recompiler patches in its self-modification guard: inside the branch
// that already fired m._dirty, so a write to a page holding no code costs nothing. The recompiler
// fills it in after the instruction is fully emitted, because only then is the resume address known.
const WRITE = {
  inline: (MM, NT) => (a, sz, v) => {
    if (sz === 8) return `if(m.planar&&(${a}>>>16)===10)m.vga.writeByte(${a},(${v}));else{u8[${a}]=(${v});if(cp[${a}>>>12]!==0){m._dirty(${a},1);/*SMCABORT*/}}`;
    const t = NT();
    if (sz === 16) return `if(m.planar&&(${a}>>>16)===10)m.w16(${a},(${v}));else{var ${t}=(${v});u8[${a}]=${t};u8[(${a}+1)&${MM}]=${t}>>>8;if(cp[${a}>>>12]|cp[((${a}+1)&${MM})>>>12]){m._dirty(${a},2);/*SMCABORT*/}}`;
    return `if(m.planar&&(${a}>>>16)===10)m.w32(${a},(${v}));else{var ${t}=(${v});u8[${a}]=${t};u8[(${a}+1)&${MM}]=${t}>>>8;u8[(${a}+2)&${MM}]=${t}>>>16;u8[(${a}+3)&${MM}]=${t}>>>24;if(cp[${a}>>>12]|cp[((${a}+3)&${MM})>>>12]){m._dirty(${a},4);/*SMCABORT*/}}`;
  },

  // The write table folds BOTH of today's probes into one: a page is "plain" only if it is neither
  // device-mapped nor holding translated code, so the SMC check disappears from the fast path
  // instead of sitting beside the planar test. That merge is the reason to expect a win here even
  // though the synthetic read benchmark was neutral.
  paged: (MM, NT) => (a, sz, v) => {
    // The same sentinel and wrapping sum as the paged read, in a variable of its own: the VALUE of a
    // read-modify-write (`shl dword [eax],1`) holds the paged read, which sets _po between this probe
    // and the store.
    const t = NT();
    if (sz === 8) return `if((_pw=wro[${a}>>>12])!==-1){var ${t}=(${v});u8[(_pw+${a})>>>0]=${t};}else m.w8(${a},(${v}));`;
    if (sz === 16) return `if((${a}&4095)<4095&&(_pw=wro[${a}>>>12])!==-1){var ${t}=(${v});_pw=(_pw+${a})>>>0;u8[_pw]=${t};u8[_pw+1]=${t}>>>8;}else m.w16(${a},(${v}));`;
    return `if((${a}&4095)<4093&&(_pw=wro[${a}>>>12])!==-1){_dv.setUint32((_pw+${a})>>>0,(${v}),true);}else m.w32(${a},(${v}));`;
  },
};
