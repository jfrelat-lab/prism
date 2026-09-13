// memmap.js — a per-PLATFORM memory map, as a page-indexed translation table.
//
// WHY A PLATFORM AND NOT A TARGET. The alternative was a compile option per game, and that is a
// favour done to whichever game needed it. "On DOS, the low megabyte has devices in it" is simply
// true -- of Jump 'n Bump, of every VESA program that banks through 0xA0000, of anything that pokes
// the text window at 0xB8000, of an EMS page frame. Declaring the MACHINE rather than the program
// is the same rule this project already applies to libraries: shim at the boundary, never inside
// the game. It also means a DOS target that has never been tried gets the behaviour for free, and
// no target that is not DOS pays anything at all.
//
// WHY A TABLE AND NOT A BRANCH, measured rather than assumed (tools/bench-mapper.mjs):
//
//                      direct     guarded          translated
//     store byte       1.92 ns    3.51 ns (+83%)   3.07 ns (+60%)
//     load  byte       1.01 ns    4.18 ns (+315%)  1.29 ns (+28%)
//
// and the property that settled it: translating costs the same whether anything is redirected or
// not -- 123 ms either way. A branch makes every access pay for the POSSIBILITY of a device; a
// table does not. The emitted form is
//
//     D.setUint8(X[a >>> 12] + (a & 4095), v)
//
// with the entry set to the identity for plain RAM, so the byte written is the byte that would have
// been written anyway.
//
// MAME IS THE MODEL, and its own 0.5 sources are in the corpus: `struct MemoryReadAddress
// { int start, end; handler; base; }` with MRA_RAM and MRA_NOP as sentinels. What 0.5 does NOT have
// is the page index -- machine.c walks those ranges linearly -- and that is the part later releases
// added. Nothing obliges this to repeat the linear scan on the way there.
//
// WHAT A TABLE CANNOT SAY. One address means one place, so a write that must reach FOUR planes at
// once -- VGA Map Mask 0x0f -- has no translation. That case is not silently approximated here: see
// `multiWrite` below, which refuses. A refusal is verifiable; an almost-right picture is not.

const PAGE_SHIFT = 12;                       // 4 kB, so the 0xA0000-0xBFFFF window is exactly 32 pages
const PAGE_SIZE = 1 << PAGE_SHIFT;

/**
 * Build the map for a guest image of `bytes`.
 *
 * Every page starts as itself. A device claims a range with `redirect`, and gives it back with
 * `identity`; both work in whole pages, because a table indexed by page cannot express less and
 * pretending otherwise would be the kind of half-mechanism that produces an almost-right picture.
 */
export function installMemMap(M, { bytes = null } = {}) {
  const size = bytes ?? M.u8?.length ?? 0;
  if (!size) throw new Error('installMemMap: no guest image to map');
  const pages = Math.ceil(size / PAGE_SIZE);

  /*
   * TWO TABLES, one for loads and one for stores, and that is not symmetry for its own sake: on a
   * planar VGA the same address reads from the plane in Read Map Select and writes to the planes in
   * Map Mask. One table cannot hold both answers. It costs nothing -- an access consults exactly one
   * of them -- and a single table would have been quietly wrong the first time a program read back
   * what it had just drawn.
   */
  const xlatR = new Int32Array(pages);
  const xlatW = new Int32Array(pages);
  for (let p = 0; p < pages; p++) xlatR[p] = xlatW[p] = p << PAGE_SHIFT;

  /** Pages a device has claimed, so a second claim on the same page is an error and not a surprise. */
  const owner = new Map();

  const checkRange = (start, len, who) => {
    if ((start & (PAGE_SIZE - 1)) || (len & (PAGE_SIZE - 1))) {
      throw new Error(`${who}: ${start.toString(16)}+${len.toString(16)} is not page-aligned ` +
        `(pages are ${PAGE_SIZE} bytes, and a page table cannot express less)`);
    }
    if (start < 0 || start + len > size) throw new Error(`${who}: range outside the guest image`);
  };

  /** A device's answer for block writes it cannot express as one translation. See writeSpans. */
  let spanner = null;

  const xr = (a) => xlatR[a >>> PAGE_SHIFT] + (a & (PAGE_SIZE - 1));
  const xw = (a) => xlatW[a >>> PAGE_SHIFT] + (a & (PAGE_SIZE - 1));

  const map = {
    PAGE_SHIFT,
    PAGE_SIZE,
    xlatR,
    xlatW,

    /*
     * THE TWO FUNCTIONS THE EMITTED CODE CALLS. One argument, evaluated once -- which is both what
     * makes them implementable and, measured, what makes them fast: the inline form
     * `X[a >>> 12] + (a & 4095)` names the address twice and costs MORE (stores +58% against +33%),
     * besides needing a temporary at all 26 of the emitter's load/store sites.
     *
     * They are also the public `translate*` API, deliberately the same objects: a test that checks
     * where an address lands must exercise exactly what the program runs.
     */
    xr,
    xw,
    translateRead: xr,
    translateWrite: xw,

    /**
     * Point `len` bytes at `start` somewhere else. `to` is an address in the same image: the planes
     * of a VGA, a VESA bank, whatever the device keeps its bytes in.
     *
     * `how` is 'r', 'w' or 'rw'. A planar VGA uses the first two separately and needs to: a read
     * comes from the plane in Read Map Select while a write goes to the plane in Map Mask, and the
     * two move independently as the program draws.
     */
    redirect(start, len, to, { how = 'rw', who = 'a device' } = {}) {
      checkRange(start, len, 'redirect');
      for (let i = 0; i < len; i += PAGE_SIZE) {
        const p = (start + i) >>> PAGE_SHIFT;
        const held = owner.get(p);
        if (held && held !== who) {
          throw new Error(`redirect: page ${p.toString(16)} is already held by ${held}`);
        }
        owner.set(p, who);
        if (how.includes('r')) xlatR[p] = to + i;
        if (how.includes('w')) xlatW[p] = to + i;
      }
    },

    /** Give the pages back, so the window reads and writes as plain memory again. */
    identity(start, len) {
      checkRange(start, len, 'identity');
      for (let i = 0; i < len; i += PAGE_SIZE) {
        const p = (start + i) >>> PAGE_SHIFT;
        owner.delete(p);
        xlatR[p] = xlatW[p] = p << PAGE_SHIFT;
      }
    },

    /**
     * THE CASE A TABLE CANNOT EXPRESS, and the reason this function exists rather than a silent
     * approximation. A VGA write under a Map Mask with more than one bit set has to land in several
     * planes, and one translated address is one place. The honest answers are to route the write
     * through a device call, or to refuse -- and a program is far better served by a refusal it can
     * see than by a picture that is right in three planes out of four.
     *
     * The common cases do not come here: a fill goes through the runtime's memset, which consults
     * this map and can fan out properly, and sprite drawing selects ONE plane at a time, which the
     * table expresses exactly.
     */
    multiWrite(mask, where) {
      throw new Error(`a byte write under a multi-plane mask (0x${mask.toString(16)}) at ` +
        `0x${where.toString(16)} cannot be expressed by an address translation. ` +
        `This is refused rather than approximated.`);
    },

    /*
     * WHERE A BLOCK WRITE HAS TO LAND, which is the question a translation table cannot answer.
     *
     * One address means one place, so `xw` can never express a VGA write under a Map Mask with
     * several bits set. A block move CAN: memset and memcpy are runtime functions, so they are free
     * to write the same bytes four times. `writeSpans` is how a device says so -- it returns one
     * destination per plane the write must reach, and the runtime loops over them.
     *
     * The fast path is the one every other program takes: when nothing in the range is redirected,
     * the answer is the range itself and the caller does exactly what it did before.
     */
    writeSpans(addr, len) {
      if (spanner) {
        const s = spanner(addr, len);
        if (s) return s;
      }
      const first = addr >>> PAGE_SHIFT, last = (addr + len - 1) >>> PAGE_SHIFT;
      let plain = true;
      for (let p = first; p <= last && plain; p++) if (xlatW[p] !== (p << PAGE_SHIFT)) plain = false;
      if (plain) return [{ to: addr, from: 0, len }];
      /*
       * `from` is which part of the SOURCE block this destination takes, and it exists because
       * "several destinations" means two different things. A page split hands each destination a
       * successive slice; a plane fan-out hands every destination the SAME bytes. Without it a copy
       * would write slice 0 four times, or the same slice to every page -- right in one case and
       * silently wrong in the other.
       */
      const out = [];
      for (let off = 0; off < len;) {
        const a = addr + off;
        const room = Math.min(PAGE_SIZE - (a & (PAGE_SIZE - 1)), len - off);
        out.push({ to: xw(a), from: off, len: room });
        off += room;
      }
      return out;
    },

    /** A device that needs more than a translation installs its answer here. */
    setSpanner(fn) { spanner = fn; },

    /** What is claimed, for a tool that wants to print the map rather than guess at it. */
    claims() {
      return [...owner].map(([p, who]) => ({ page: p, at: p << PAGE_SHIFT, who }))
        .sort((a, b) => a.page - b.page);
    },
  };

  M.memmap = map;
  return map;
}
