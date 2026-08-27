// go32.js — DJGPP's DPMI floor, which is all Quake's DOS platform actually stands on.
//
// `dos_v2.c` implements the whole of `dosisms.h` — `dos_int86`, `dos_registerintr`, `real2ptr`,
// `dos_getmemory`, the port helpers — on top of two dozen go32/DPMI calls. So PRISM supplies those
// and Quake's own 257 lines supply everything above them. The list here is measured from
// `sys_dos.c vid_dos.c vid_vga.c vid_ext.c in_dos.c snd_dos.c dos_v2.c` and contains nothing else.
//
// Three things this does NOT have to do, each checked in the source before a line was written:
//
//  * **No VGA register programming for the default mode.** `vgavidmodes[0]` is
//    `320x200 … planar = 0 … &extra320x200x256linear`, and that extra is `{ 1, vrsnull }` where
//    `vrsnull` is `{ VRS_END }` — an empty register set. Quake sets mode 13h through INT 10h, takes
//    `real2ptr(0xa0000)` as a flat pointer, programs nothing, and blits. The Mode-X entries exist
//    and are not the default.
//  * **No selector arithmetic.** `__djgpp_conventional_base` is 0 and the image is flat with the low
//    megabyte inside it, so `real2ptr(0xa0000)` is 0xa0000. That is the truth here, not a shortcut.
//  * **No page locking.** `__dpmi_lock_linear_region` exists so a program can stop the extender
//    swapping its sound buffer out. Nothing here pages, so there is nothing to defeat.
//
// What it DOES have to do is remember interrupt handlers, because a remembered handler can be
// called — the same mechanism as src/env/watcom.js, reached from a different runtime.

/*
 * DJGPP's __dpmi_regs, in the layout src/env/headers-djgpp.js declares: a real-mode call frame, not
 * a register file, which is why the 32-bit view runs edi..eax and the segment registers follow.
 */
const D_EDI = 0, D_ESI = 4, D_EBP = 8, D_RES = 12, D_EBX = 16, D_EDX = 20, D_ECX = 24, D_EAX = 28;
const D_FLAGS = 32;

/** _go32_dpmi_seginfo: { size|size_or_mask, pm_offset, pm_selector, rm_offset, rm_segment }. */
const S_SIZE = 0, S_PM_OFFSET = 4, S_PM_SELECTOR = 8, S_RM_OFFSET = 10, S_RM_SEGMENT = 12;

export function installGo32(M, { onVideoMode = null } = {}) {
  const dv = () => M.mod.dv;
  const state = {
    mode: null,
    vectors: new Map(),      // interrupt number -> the guest handler's pm_offset
    dosBlocks: new Map(),    // rm_segment -> the guest address behind it
    locked: 0,
  };
  M.go32 = state;

  const eax = (p) => dv().getUint32(p + D_EAX, true) >>> 0;
  const setEax = (p, v) => dv().setUint32(p + D_EAX, v >>> 0, true);
  const clearCarry = (p) => dv().setUint16(p + D_FLAGS, dv().getUint16(p + D_FLAGS, true) & ~1, true);

  /**
   * A real-mode interrupt, simulated. Both entry points share it because both are handed the same
   * frame under a different type name.
   */
  function simulate(vector, regs) {
    const ax = eax(regs) & 0xffff;
    switch (vector | 0) {
      case 0x10: {                                   // BIOS video
        if ((ax >> 8) === 0) {                       // AH=0: set mode
          state.mode = ax & 0xff;
          if (onVideoMode) onVideoMode(state.mode);
        }
        clearCarry(regs);
        return 0;
      }
      case 0x33:                                     // mouse driver: absent, and it must say so
        setEax(regs, 0);
        clearCarry(regs);
        return 0;
      case 0x2f:
        /*
         * Multiplex. Quake asks AX=0x160A, "get Windows version", to decide whether it is running
         * under Win95 -- and it wants a NO. Returning AX unchanged is the documented "not
         * supported" answer, and it is true.
         */
        clearCarry(regs);
        return 0;
      default:
        clearCarry(regs);
        return 0;
    }
  }

  const api = {
    __dpmi_int: (vector, regs) => simulate(vector, regs),
    _go32_dpmi_simulate_int: (vector, regs) => simulate(vector, regs),

    /*
     * The interrupt vector table, again. `in_dos.c` installs a keyboard handler here and `snd_dos.c`
     * a DMA one; both are recorded so the host can CALL them, which is the only way an interrupt
     * happens in this runtime.
     */
    _go32_dpmi_set_protected_mode_interrupt_vector: (vector, info) => {
      state.vectors.set(vector | 0, dv().getUint32(info + S_PM_OFFSET, true) >>> 0);
      return 0;
    },
    _go32_dpmi_get_protected_mode_interrupt_vector: (vector, info) => {
      dv().setUint32(info + S_PM_OFFSET, state.vectors.get(vector | 0) ?? 0, true);
      dv().setUint16(info + S_PM_SELECTOR, 0x1f, true);
      return 0;
    },
    // A wrapper that saves registers around a handler. There are no registers to save here: the
    // handler is a JS call, and the caller's state is the JS stack.
    _go32_dpmi_allocate_iret_wrapper: () => 0,
    _go32_dpmi_free_iret_wrapper: () => 0,

    /*
     * DOS memory, from the guest's own heap. `rm_segment` is a paragraph number, so the address is
     * rounded up to 16 and shifted -- and because the image is flat with the low megabyte inside it,
     * the segment a program computes from that address really does address those bytes.
     */
    _go32_dpmi_allocate_dos_memory: (info) => {
      const paras = dv().getUint32(info + S_SIZE, true) >>> 0;
      const bytes = Math.max(paras * 16, 16);
      const p = M.rt.malloc(bytes + 16);
      if (!p) return -1;
      const aligned = (p + 15) & ~15;
      state.dosBlocks.set(aligned >>> 4, p);
      dv().setUint16(info + S_RM_SEGMENT, (aligned >>> 4) & 0xffff, true);
      dv().setUint16(info + S_RM_OFFSET, 0, true);
      return 0;
    },
    _go32_dpmi_free_dos_memory: (info) => {
      const seg = dv().getUint16(info + S_RM_SEGMENT, true);
      const p = state.dosBlocks.get(seg);
      if (p) { M.rt.free(p); state.dosBlocks.delete(seg); }
      return 0;
    },

    // Locking exists to stop an extender paging a buffer out. Nothing here pages.
    __dpmi_lock_linear_region: () => { state.locked++; return 0; },
    __dpmi_unlock_linear_region: () => 0,
    __dpmi_physical_address_mapping: () => 0,

    /** How much memory there is. Large and plausible; Quake divides by it to size its heap. */
    __dpmi_get_free_memory_information: (info) => {
      const MB = 1024 * 1024;
      dv().setUint32(info, 32 * MB, true);                    // largest free block
      for (let i = 1; i < 12; i++) dv().setUint32(info + i * 4, 8192, true);
      return 0;
    },
    _go32_dpmi_remaining_physical_memory: () => 32 * 1024 * 1024,
    _go32_dpmi_remaining_virtual_memory: () => 32 * 1024 * 1024,

    /*
     * Near pointers: yes, and the base is zero. On real DJGPP this asks the extender to drop segment
     * limits so a flat pointer can reach conventional memory; PRISM's image already is that, with
     * the low megabyte in it.
     */
    __djgpp_nearptr_enable: () => 1,
    __djgpp_nearptr_disable: () => 0,

    enable: () => 0,
    disable: () => 0,
  };

  /** Deliver an interrupt to a handler registered through the protected-mode vector table. */
  function deliver(vector) {
    const fn = state.vectors.get(vector | 0);
    if (!fn) return false;
    M.icall(fn, []);
    return true;
  }

  Object.assign(M.rt, api);
  // __djgpp_conventional_base is a tentative definition in the header; zero is already its value,
  // and saying so here would only restate what the flat model already makes true.
  return { state, deliver };
}

/** The declarations, in the shape src/compile.js's BUILTINS table wants. */
export function go32Builtins(T) {
  const P = T.ptr(T.CHAR), I = T.INT, U = T.UINT, V = T.VOID;
  const f = (ret, ...params) => ({ ret, params });
  return {
    __dpmi_int: f(I, I, P),
    _go32_dpmi_simulate_int: f(I, I, P),
    _go32_dpmi_set_protected_mode_interrupt_vector: f(I, I, P),
    _go32_dpmi_get_protected_mode_interrupt_vector: f(I, I, P),
    _go32_dpmi_allocate_iret_wrapper: f(I, P),
    _go32_dpmi_free_iret_wrapper: f(I, P),
    _go32_dpmi_allocate_dos_memory: f(I, P),
    _go32_dpmi_free_dos_memory: f(I, P),
    __dpmi_lock_linear_region: f(I, P),
    __dpmi_unlock_linear_region: f(I, P),
    __dpmi_physical_address_mapping: f(I, P),
    __dpmi_get_free_memory_information: f(I, P),
    _go32_dpmi_remaining_physical_memory: f(T.ULONG),
    _go32_dpmi_remaining_virtual_memory: f(T.ULONG),
    __djgpp_nearptr_enable: f(I),
    __djgpp_nearptr_disable: f(V),
    enable: f(V), disable: f(V),
  };
}
