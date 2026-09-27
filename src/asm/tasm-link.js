// tasm-link.js — give a 16-bit program the Turbo Assembler modules its build links, as C functions.
//
// Two halves, because a linker's work happens at two times here. BEFORE the C is emitted,
// tasmExternData says where each module's _DATA and code segment go -- DGROUP for the data, a far
// block for the code -- and names the module's data publics at their offsets, so `extern int px;` in
// the C resolves to the assembly's px (compile.js externData). AFTER, installTasm loads the images
// (src/asm/tasm16.js loadTasm, every address resolved) and binds each public procedure.
//
// THE BINDING IS BORLAND'S CALLING CONVENTION, and nothing else: `MODEL MEDIUM,C` procedures take
// their arguments right to left on SS:SP, a far return address under them, and return in AX or
// DX:AX; the caller pops the arguments. The C side here is PRISM's, where a far pointer is a linear
// address and a `_seg` pointer a paragraph, so each argument is laid down as the 8086 would see it:
// a word, two words for a long, OFFSET then SEGMENT for a far pointer. The machine runs on PRISM's
// own stack (DGROUP at paragraph 0, so SS = DS = 0 and M.sp is an offset in it), below the C frame
// that made the call.
import { assembleTasm } from './tasm.js';
import { layoutTasm, translateTasm, loadTasm } from './tasm16.js';

// The return address pushed for a call from C: a code segment no module is loaded at. RETF to it
// leaves the machine (tasm16.js returns when the popped CS is not its own).
const FROM_C = 0xffff;

/** Assemble each file and lay it out. `read(name)` returns a source file's text, or null. */
export function tasmModules(files, read) {
  return files.map((file) => {
    const mod = assembleTasm(file, { read });
    return { file, mod, lay: layoutTasm(mod) };
  });
}

/** The blocks compile.js must place before the C resolves its externs. */
export function tasmExternData(modules) {
  const out = [];
  for (const { file, mod, lay } of modules) {
    const publics = [];
    for (const name of mod.publics) {
      const l = mod.data.labels.get(name);
      if (l) publics.push({ name, offset: l.offset });
    }
    out.push({ name: `${file}:_DATA`, size: Math.max(mod.data.bytes.length, 2), far: false, align: 16, publics });
    out.push({ name: `${file}:_TEXT`, size: Math.max(lay.size, 2), far: true, align: 16, publics: [] });
  }
  return out;
}

/** The words an argument of type t occupies on the 8086 stack, from PRISM's JS value. */
function argWords(t, v, name) {
  if (!t) throw new Error(`tasm-link: ${name} takes an argument with no prototype in scope`);
  const n = Number(v);
  if (t.k === 'ptr' && t.size === 4 && !t.to?.k?.startsWith?.('func')) {
    // PRISM's far pointer is linear; the assembly reads OFFSET then SEGMENT.
    return [n & 15, (n >>> 4) & 0xffff];
  }
  if (t.size === 4) return [n & 0xffff, (n >>> 16) & 0xffff];
  if (t.size <= 2) return [n & 0xffff];
  throw new Error(`tasm-link: ${name} takes a ${t.size}-byte argument`);
}

/** The C value of AX / DX:AX for a return type. */
function result(t, R) {
  if (!t || t.k === 'void' || t.name === 'void') return undefined;
  if (t.k === 'ptr' && t.size === 4) return ((R.dx << 4) + R.ax) >>> 0;
  if (t.size === 4) return t.signed === false ? (((R.dx << 16) | R.ax) >>> 0) : ((R.dx << 16) | R.ax);
  if (t.size === 1) return t.signed ? ((R.ax << 24) >> 24) : (R.ax & 0xff);
  return t.signed === false || t.k === 'ptr' ? R.ax & 0xffff : ((R.ax << 16) >> 16);
}

/**
 * Load, translate and bind. Returns what was bound. `program` is a compileProgram result built with
 * tasmExternData(modules) in its externData.
 */
export function installTasm(program, modules) {
  const M = program.M;
  const D = M.mod.dv;
  if (M.abi.ptr !== 2 || (M.mod.model !== 'dos16m' && M.mod.model !== 'dos16')) {
    throw new Error(`tasm-link: the modules are bound for DGROUP at 0 with near data; this is ${M.mod.model}`);
  }
  const machine = M.machine;
  const io = {
    // The machine's clock, when interrupts are delivered (src/env/pcirq.js): TASM loops spend it too.
    clock: M.vclock ? M : undefined,
    in: (port, w) => (machine ? machine.read(port, w) : 0xff),
    out: (port, w, v) => { if (machine) machine.write(port, w, v); },
    // M.interrupt speaks Borland's register file (cf/zf/sf flags); the machine a flags word.
    interrupt: (n, R) => {
      if (!M.interrupt) throw new Error(`int ${n.toString(16)}h from assembly, and no interrupt dispatcher is installed`);
      const f = R.flags;
      Object.assign(R, { cf: f & 1, zf: (f >> 6) & 1, sf: (f >> 7) & 1, if: (f >> 9) & 1, df: (f >> 10) & 1 });
      M.interrupt(n, R);
      R.flags = (f & ~0x6c1) | (R.cf & 1) | ((R.zf & 1) << 6) | ((R.sf & 1) << 7) | ((R.if & 1) << 9) | ((R.df & 1) << 10);
    },
  };
  const symbol = (name) => M.mod.symbols.get(name)?.addr;
  const bound = [];
  for (const { file, mod, lay } of modules) {
    const text = program.externPlaced.get(`${file}:_TEXT`), data = program.externPlaced.get(`${file}:_DATA`);
    if (text === undefined || data === undefined) throw new Error(`tasm-link: ${file} was not placed at compile time`);
    if (text & 15) throw new Error(`tasm-link: ${file}'s code is not paragraph-aligned`);
    const place = { cs: text >>> 4, dgroup: 0, dataBase: data, symbol };
    loadTasm(mod, lay, D, place);
    const machineOf = (0, eval)(translateTasm(mod, lay, place))(D, io);
    for (const p of mod.procs) {
      if (!mod.publics.has(p.name)) continue;
      const ft = program.funcTypes.get(p.name);
      if (!ft) continue;                       // public, and no C declares it
      const entry = lay.labels.get(p.name).addr;
      const params = ft.params ?? [];
      const fn = (...args) => {
        const words = [];
        params.forEach((q, i) => words.push(...argWords(q.type, args[i], p.name)));
        let sp = (M.sp & ~1) - 2 * words.length - 4;
        const at = sp;
        D.setUint16(at, 0, true);                          // IP
        D.setUint16(at + 2, FROM_C, true);                 // CS
        words.forEach((w, k) => D.setUint16(at + 4 + 2 * k, w, true));
        const R = { ax: 0, bx: 0, cx: 0, dx: 0, si: 0, di: 0, bp: 0, sp, ds: 0, es: 0, ss: 0, ip: entry,
          flags: 0x2 | (M.cpu.if << 9) };
        machineOf.run(R);
        const was = M.cpu.if;
        M.cpu.if = (R.flags >>> 9) & 1;          // a routine may leave interrupts as it found them, or not
        if (!was && M.cpu.if) M.irqPoll?.();
        return result(ft.ret, R);
      };
      program.F[p.name] = fn;
      program.mod.bindFunc(p.name, fn);
      bound.push({ name: p.name, from: file });
    }
  }
  return bound;
}
