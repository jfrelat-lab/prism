// link.js — give the program the assembly routines it is missing, as callable functions.
//
// buildTarget already computes `asmWanted`: the symbols a .S file exports and the compiled C still
// lacks. Until now that list was only REPORTED -- it was the on-ramp, and P5.2 measured that across
// the whole corpus it names exactly one symbol, because every other game ships a C twin its own
// build can select. Jump 'n Bump is the exception, and this is the ramp being used.
//
// THE ABI IS THE WHOLE JOB HERE. src/asm/x86.js translates to a machine-level function -- registers
// in, registers out -- because that is Unicorn's shape and therefore what the differential can
// check. What the compiled C calls is `get_block(page, x, y, width, height, buffer)`. So this file
// builds the frame the routine expects to find: arguments pushed right to left, a return address
// under them, and a stack of its own so nothing it pushes disturbs the C shadow stack.
//
// The leading underscore is the DJGPP convention, not part of the name: the assembly exports
// `_get_block` and the C calls `get_block`.

import { parse } from './nasm.js';
import { translate } from './x86.js';

const STACK_BYTES = 64 * 1024;

/**
 * Translate `sources` and bind every routine the program declares but does not define.
 *
 * Returns what was bound, so a caller can report it rather than claim it: a target that lists an
 * assembly file whose symbols were all already defined in C has learnt something worth printing.
 */
export function installAsm(program, { sources, symbols = {}, machine = null }) {
  const M = program.M;
  const bound = [];

  for (const { file, text } of sources) {
    const parsed = parse(text);

    /*
     * The routine's own `dd` slots and its stack live in the guest image, allocated once. They are
     * ordinary memory as far as the routine is concerned -- it keeps them beside its code only
     * because an assembler lets it.
     */
    const slotBytes = parsed.items
      .filter(i => i.kind === 'data')
      .reduce((n, i) => n + i.size * i.values.length, 0);
    const dataBase = M.rt.malloc(Math.max(slotBytes, 4));
    const stackBase = M.rt.malloc(STACK_BYTES);
    const stackTop = (stackBase + STACK_BYTES) & ~15;

    /*
     * Undefined externals get storage, because that is what a linker does with them. The one this
     * file needs is ___djgpp_base_address, and its VALUE is zero here: PRISM's image is flat, so
     * the conventional-memory base and the linear address are the same number. (Getting this wrong
     * is not subtle -- it is a variable, and reading it as if it were a value sent the routine to
     * address 0 the first time the Unicorn harness ran it.)
     */
    const externs = { ...symbols };
    for (const name of parsed.externs) {
      if (name in externs) continue;
      const at = M.rt.malloc(4);
      M.mod.dv.setUint32(at, 0, true);
      externs[name] = at;
    }

    const io = {
      out: (port, size, value) => { if (machine) machine.write(port, size, value); },
      in: (port, size) => (machine ? machine.read(port, size) : 0xff),
    };

    for (const g of parsed.globals) {
      const cName = g.replace(/^_/, '');
      const declared = program.mod.symbols?.has?.(cName) ?? true;
      if (!declared && !(cName in program.F)) { /* nothing calls it; bind anyway, it is harmless */ }

      /*
       * PAGED WHEN THE IMAGE IS. Without this the routine writes at the flat image and never
       * reaches a plane -- which is what put one column in four on the screen, because these two
       * routines are the ones that move rectangles in and out of planar video memory.
       */
      const map = M.memmap ?? null;
      const src = translate(parsed, g, { symbols: externs, dataBase, paged: !!map });
      // eslint-disable-next-line no-eval
      const routine = (0, eval)(src);

      /*
       * The C entry point. A fresh frame every call, at a fixed top: these routines are not
       * re-entrant in the original either -- their variables are static storage inside .text.
       */
      const fn = (...args) => {
        const D = M.mod.dv;
        let esp = stackTop;
        for (let i = args.length - 1; i >= 0; i--) { esp -= 4; D.setUint32(esp, args[i] >>> 0, true); }
        esp -= 4;
        D.setUint32(esp, 0, true);                    // the return address, which `ret` pops
        const end = map
          ? routine(D, { eax: 0, ebx: 0, ecx: 0, edx: 0, esi: 0, edi: 0, ebp: 0, esp }, io, map.xr, map.xw)
          : routine(D, { eax: 0, ebx: 0, ecx: 0, edx: 0, esi: 0, edi: 0, ebp: 0, esp }, io);
        return end.eax | 0;                           // cdecl: an int result comes back in EAX
      };

      program.F[cName] = fn;
      program.mod.bindFunc(cName, fn);
      bound.push({ name: cName, from: file });
    }
  }
  return bound;
}
