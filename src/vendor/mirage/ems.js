// ems.js — LIM EMS 4.0: the subset programs actually use.
//
// Two things constrain the design:
//   * Detection reads the INT 67h vector and expects the driver name "EMMXXXX0" at <that
//     segment>:000A. F000 is unusable — offset 000A there is inside the per-vector stub table — so
//     the driver takes its own segment and Machine.swInt recognises it alongside the BIOS one.
//   * Mapping COPIES rather than remaps: MIRAGE has no real-mode remapping layer. Equivalent for any
//     program that follows the spec, which forbids holding a pointer into the frame across a remap.

// AH=4Eh and AH=58h address their arrays through ES:DI and DS:SI, and named the registers without
// importing them — a ReferenceError that only fires when a guest gets as far as the page-map calls.
import { DS, ES } from './cpu.js';

export const EMS_SEG = 0xf100;              // the driver's own segment (see above)
const EMS_ENTRY_OFF = 0x0020;               // where the vector points — clear of the name below
const NAME_OFF = 0x000a;                    // "EMMXXXX0", 8 bytes, fixed by the spec
const FRAME_SEG = 0xe000;                   // the 64 KB page frame
const PAGE_SIZE = 0x4000;                   // 16 KB per page, four per frame
const FRAME_PAGES = 4;

export function installEMS(machine) {
  const mem = machine.mem, cpu = machine.cpu;

  const ems = {
    frameSeg: FRAME_SEG,
    handles: new Map([[0, { pages: 0, base: 0, name: '' }]]),   // handle -> { pages, base, name }; 0 = system
    nextHandle: 1,
    mapped: new Array(FRAME_PAGES).fill(null),   // slot -> { handle, page } currently in the window
    saved: new Map(),                           // handle -> stack of saved `mapped` snapshots (AH=47/48)
    // Handle 0 is the SYSTEM handle: a real EMM always owns it — the pages the manager itself has
    // mapped — and it is valid even owning none. Registering it here rather than special-casing each
    // service is what makes it valid EVERYWHERE, which is what the probe needs: Windows 3.0's KERNEL
    // walks handle 0 through several calls in a row (4Ch, then 51h, …) and one "invalid handle"
    // anywhere in that chain ends the probe.
    reset() { this.handles = new Map([[0, { pages: 0, base: 0, name: '' }]]); this.nextHandle = 1; this.mapped = new Array(FRAME_PAGES).fill(null); this.saved = new Map(); },
  };

  // Pages come from the same pool as XMS, sharing its top as the bump: XMS and EMS grow up, DPMI
  // grows down, and all three agree on who owns what.
  const poolTop = () => (machine.xms ? machine.xms.top : 0x100000);
  const poolMax = () => (machine.xms ? machine.xms.max : mem.size);
  const takePool = (bytes) => {
    const base = poolTop();
    if (base + bytes > poolMax()) return -1;
    if (machine.xms) machine.xms.top = base + bytes;
    return base;
  };

  const frameLin = (slot) => ((FRAME_SEG << 4) + slot * PAGE_SIZE) >>> 0;
  const pageLin = (h, page) => (h.base + page * PAGE_SIZE) >>> 0;

  /** Write the slot back to its page's storage, so a later remap sees the changes. */
  const flush = (slot) => {
    const cur = ems.mapped[slot];
    if (!cur) return;
    const h = ems.handles.get(cur.handle);
    if (!h) return;
    mem.u8.copyWithin(pageLin(h, cur.page), frameLin(slot), frameLin(slot) + PAGE_SIZE);
  };

  const mapPage = (slot, handle, page) => {
    if (slot < 0 || slot >= FRAME_PAGES) return 0x8b;              // illegal physical page
    flush(slot);
    if (handle === 0xffff || page === 0xffff) { ems.mapped[slot] = null; return 0; }   // unmap
    const h = ems.handles.get(handle);
    if (!h) return 0x83;                                           // invalid handle
    if (page >= h.pages) return 0x8a;                              // logical page out of range
    mem.u8.copyWithin(frameLin(slot), pageLin(h, page), pageLin(h, page) + PAGE_SIZE);
    ems.mapped[slot] = { handle, page };
    return 0;
  };

  const ok = () => { cpu.ah = 0; };
  const fail = (code) => { cpu.ah = code; };

  machine.hookInterrupt(0x67, (c) => {
    switch (c.ah) {
      case 0x40: return ok();                                       // get manager status
      case 0x41: c.bx = FRAME_SEG; return ok();                     // get page frame segment

      case 0x42: {                                                  // get unallocated / total pages
        const total = Math.max(0, (poolMax() - 0x100000)) / PAGE_SIZE | 0;
        const used = [...ems.handles.values()].reduce((a, h) => a + h.pages, 0);
        c.dx = Math.min(total, 0x7fff);
        c.bx = Math.max(0, Math.min(total - used, 0x7fff));
        return ok();
      }

      case 0x43: {                                                  // allocate pages
        const n = c.bx & 0xffff;
        if (n === 0) return fail(0x89);                             // zero pages is an error in 3.2
        const base = takePool(n * PAGE_SIZE);
        if (base < 0) return fail(0x88);                            // not enough pages
        const handle = ems.nextHandle++;
        ems.handles.set(handle, { pages: n, base, name: '' });
        c.dx = handle;
        return ok();
      }

      case 0x44:                                                    // map handle page
        return fail(mapPage(c.al, c.dx & 0xffff, c.bx & 0xffff));

      case 0x45: {                                                  // deallocate handle
        const h = ems.handles.get(c.dx & 0xffff);
        if (!h) return fail(0x83);
        // Bump allocator: pages are not reclaimed. Drop any slot still holding this handle, or a
        // later flush writes through a handle that is gone.
        for (let i = 0; i < FRAME_PAGES; i++) if (ems.mapped[i] && ems.mapped[i].handle === (c.dx & 0xffff)) ems.mapped[i] = null;
        ems.handles.delete(c.dx & 0xffff);
        return ok();
      }

      case 0x46: c.al = 0x40; return ok();                          // version 4.0
      // Save / restore the page map. Returning success while keeping NOTHING is not a harmless stub:
      // the universal idiom is save → remap a page → restore, and without the restore the caller goes
      // on reading through a window that still points at whatever it borrowed. Turbo Pascal 7.1 does
      // this around every library access and died with "Fatal error: Disk or EMS I/O failure." — it
      // renders its whole IDE with `ems: false`, which is how the EMS layer was identified.
      // A stack per handle rather than the spec's single slot (which answers 0x8D/0x8E): nesting then
      // works, and we keep returning success where we used to, so no program can newly fail here.
      case 0x47: {                                                 // save page map
        const key = c.dx & 0xffff;
        if (!ems.saved.has(key)) ems.saved.set(key, []);
        ems.saved.get(key).push(ems.mapped.map((m) => (m ? { handle: m.handle, page: m.page } : null)));
        return ok();
      }
      case 0x48: {                                                  // restore page map
        const stack = ems.saved.get(c.dx & 0xffff);
        if (!stack || !stack.length) return ok();                   // nothing saved — as before, a no-op
        const snap = stack.pop();
        for (let slot = 0; slot < FRAME_PAGES; slot++) {
          const want = snap[slot], cur = ems.mapped[slot];
          const same = (want ? want.handle : -1) === (cur ? cur.handle : -1) &&
                       (want ? want.page : -1) === (cur ? cur.page : -1);
          if (!same) mapPage(slot, want ? want.handle : 0xffff, want ? want.page : 0xffff);
        }
        return ok();
      }
      // AH=4Eh — get/set page map, the EMS 4.0 way to snapshot the frame without a handle. Windows
      // 3.0's KERNEL asks AL=03 (how big is the save array?) before it will use EMS at all; answering
      // "function not supported" made it abandon the EMS path entirely and fall back to probing
      // conventional memory and allocating ALL of it — three AH=48h calls where the reference makes
      // one. Measured against dosbox-x, which answers 4E03 and is then asked EMS 5Bh.
      case 0x4e: {
        const BYTES = FRAME_PAGES * 4;                              // handle+page per frame slot
        switch (c.al) {
          case 0x00:                                                // get: write the map to ES:DI
          case 0x02: {                                              // get AND set
            const d = (c.base[ES] + (c.di & 0xffff)) & 0xfffff;
            for (let slot = 0; slot < FRAME_PAGES; slot++) {
              const m = ems.mapped[slot];
              mem.w16(d + slot * 4, m ? m.handle : 0xffff);
              mem.w16(d + slot * 4 + 2, m ? m.page : 0xffff);
            }
            if (c.al === 0x00) return ok();
          }
          // fall through: AL=02 also restores from DS:SI
          case 0x01: {                                              // set: read the map from DS:SI
            const sAddr = (c.base[DS] + (c.si & 0xffff)) & 0xfffff;
            for (let slot = 0; slot < FRAME_PAGES; slot++) {
              const h = mem.r16(sAddr + slot * 4), pg = mem.r16(sAddr + slot * 4 + 2);
              mapPage(slot, h, pg);
            }
            return ok();
          }
          case 0x03: c.al = BYTES; return ok();                     // size of the save array
          default: return err(0x8f);                                // invalid subfunction
        }
      }
      // AH=58h — the mappable physical address array: which physical segments the manager can map a
      // page into, and their page numbers. EMS 4.0 only. Windows 3.0's KERNEL asks AL=01 (how many?)
      // as the step after 51h in its probe chain, and stops there if the answer is "unsupported".
      // Ours is the plain four-page frame, so the array is the frame's own segments in order.
      case 0x58: {
        if (c.al === 0x01) { c.cx = FRAME_PAGES; return ok(); }     // entry count
        if (c.al !== 0x00) return err(0x8f);
        const d = (c.base[ES] + (c.di & 0xffff)) & 0xfffff;
        for (let i = 0; i < FRAME_PAGES; i++) {
          mem.w16(d + i * 4, FRAME_SEG + i * (PAGE_SIZE >> 4));     // physical segment
          mem.w16(d + i * 4 + 2, i);                                // physical page number
        }
        c.cx = FRAME_PAGES;
        return ok();
      }
      // AH=5Ah — allocate standard (AL=00) or raw (AL=01) pages. Same allocation as AH=43h with one
      // difference that matters: EMS 4.0 lets this one take ZERO pages, where 43h calls that an
      // error. Our pages are all the same size, so raw and standard are the same request.
      case 0x5a: {
        if (c.al > 1) return err(0x8f);
        const n = c.bx & 0xffff;
        const base = n ? takePool(n * PAGE_SIZE) : 0;
        if (base < 0) return fail(0x88);
        const handle = ems.nextHandle++;
        ems.handles.set(handle, { pages: n, base, name: '' });
        c.dx = handle;
        return ok();
      }
      case 0x4b: c.bx = ems.handles.size; return ok();              // handle count
      case 0x4c: {                                                  // pages owned by one handle
        const h = ems.handles.get(c.dx & 0xffff);
        if (!h) return fail(0x83);
        c.bx = h.pages; return ok();
      }
      case 0x4d: {                                                  // pages owned by all handles
        const a = (c.seg[0] << 4) + (c.reg[7] & 0xffff);            // ES:DI = array
        let i = 0;
        for (const [handle, h] of ems.handles) { mem.w16(a + i * 4, handle); mem.w16(a + i * 4 + 2, h.pages); i++; }
        c.bx = i; return ok();
      }

      case 0x51: {                                                  // reallocate pages
        const h = ems.handles.get(c.dx & 0xffff);
        if (!h) return fail(0x83);
        const want = c.bx & 0xffff;
        if (want > h.pages) {                                       // grow into a fresh block
          const base = takePool(want * PAGE_SIZE);
          if (base < 0) return fail(0x88);
          mem.u8.copyWithin(base, h.base, h.base + h.pages * PAGE_SIZE);
          h.base = base;
        }
        h.pages = want;
        return ok();
      }

      default:
        machine.unhandledInts[0x67]++;
        return fail(0x84);                                          // unsupported function
    }
  });

  // The vector must point at our own segment: that is where the name is looked for.
  machine.setVector(0x67, EMS_SEG, EMS_ENTRY_OFF);
  const nameLin = ((EMS_SEG << 4) + NAME_OFF) >>> 0;
  for (let i = 0; i < 8; i++) mem.u8[nameLin + i] = 'EMMXXXX0'.charCodeAt(i);
  mem.u8[((EMS_SEG << 4) + EMS_ENTRY_OFF) >>> 0] = 0xcf;            // a bare IRET, like the BIOS stubs

  machine.ems = ems;
  return ems;
}
