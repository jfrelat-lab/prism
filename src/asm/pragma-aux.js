// pragma-aux.js — a Watcom `#pragma aux` whose body is ASSEMBLY, compiled.
//
//     #pragma aux FixedMul =                         // Heretic, DOOMDEF.H:731
//         "imul ebx", "shrd eax,edx,16"
//         parm [eax] [ebx] value [eax] modify exact [eax edx]
//
// That is not a calling convention decorating a C function -- PRISM already ignores those -- it is
// the whole routine. Ignoring it leaves a declaration with no definition, which compiles and then
// throws when called.
//
// SCOPE, measured rather than guessed. Across the whole corpus there are exactly eleven `#pragma aux`
// with instruction bodies, and eight of those are in scitech/INCLUDE/MGRAPH.H, a library no build
// here includes. The real clients are three:
//
//     FixedMul, FixedDiv2            Heretic and Hexen, DOOMDEF.H
//     get_bios_keyboard_status       OpenDUNE, video_dos.c:141
//
// So this is not an assembler and does not pretend to be. It knows the instructions those three use,
// and REFUSES anything else by name rather than guessing -- a wrong guess here is a wrong number in
// a renderer, which is the hardest kind of bug to find. Roadmap P5.2 is the general path, and its
// oracle is MIRAGE, which is already an x86-to-JS recompiler.
//
// The three routines are also this file's own oracle: all three were transcribed BY HAND before it
// existed, so what it emits can be checked against code that is known to work.

export class AuxError extends Error {}

const REG32 = new Set(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp']);
const REG8 = { al: ['eax', 0], ah: ['eax', 8], bl: ['ebx', 0], bh: ['ebx', 8],
               cl: ['ecx', 0], ch: ['ecx', 8], dl: ['edx', 0], dh: ['edx', 8] };

/** Watcom writes a hex immediate as `11h`, and a decimal one plainly. */
function imm(text) {
  const t = String(text).trim().toLowerCase();
  let m = /^0x([0-9a-f]+)$/.exec(t) ?? /^([0-9a-f]+)h$/.exec(t);
  if (m) return parseInt(m[1], 16);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  return null;
}

const isReg32 = (t) => REG32.has(String(t).trim().toLowerCase());

/**
 * One instruction to JavaScript, over a register file held in plain locals (`eax`, `ebx`, …) plus
 * `zf`. Everything is kept as a signed 32-bit int except where the instruction is explicitly wide.
 */
function emitInsn(text, ctx) {
  const s = String(text).trim().replace(/\s+/g, ' ');
  if (!s) return '';

  // A label: `ok:`
  let m = /^([A-Za-z_][A-Za-z_0-9]*):$/.exec(s);
  if (m) { ctx.labels.add(m[1]); return `case ${JSON.stringify(m[1])}:`; }

  const sp = s.indexOf(' ');
  const op = (sp < 0 ? s : s.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? '' : s.slice(sp + 1);
  const args = rest ? rest.split(',').map(a => a.trim()) : [];

  switch (op) {
    /*
     * `cdq` sign-extends EAX into EDX:EAX. Written as an arithmetic shift rather than a comparison
     * because that is what it is -- every bit of EDX becomes the sign bit.
     */
    case 'cdq': return 'edx = eax >> 31;';

    case 'mov': {
      const [d, srcTxt] = args;
      const dst = String(d).toLowerCase();
      const v = imm(srcTxt);
      if (isReg32(dst)) {
        if (v !== null) return `${dst} = ${v | 0};`;
        if (isReg32(String(srcTxt).toLowerCase())) return `${dst} = ${String(srcTxt).toLowerCase()};`;
      }
      if (REG8[dst] && v !== null) {
        // A byte move touches ONE byte of the 32-bit register and leaves the rest: `mov ah,11h`
        // sets bits 8..15 and must not clear EAX.
        const [full, shift] = REG8[dst];
        const mask = ~(0xff << shift) >>> 0;
        return `${full} = ((${full} & ${mask | 0}) | ${((v & 0xff) << shift) >>> 0}) | 0;`;
      }
      throw new AuxError(`unsupported operand for mov: '${s}'`);
    }

    /*
     * The one-operand `imul` is a WIDE multiply: EDX:EAX = EAX * r. Done in BigInt because the
     * product does not fit in a double without losing the low bits, which is exactly the half
     * `shrd` then goes after -- FixedMul is a 16.16 fixed-point multiply and its whole result lives
     * across the boundary.
     */
    case 'imul': {
      if (args.length !== 1 || !isReg32(args[0])) throw new AuxError(`unsupported imul: '${s}'`);
      return `{ const _p = BigInt(eax | 0) * BigInt(${args[0].toLowerCase()} | 0); ` +
             `eax = Number(BigInt.asIntN(32, _p)) | 0; ` +
             `edx = Number(BigInt.asIntN(32, _p >> 32n)) | 0; }`;
    }

    /** Signed EDX:EAX / r -> quotient in EAX, remainder in EDX. BigInt for the same reason. */
    case 'idiv': {
      if (args.length !== 1 || !isReg32(args[0])) throw new AuxError(`unsupported idiv: '${s}'`);
      const r = args[0].toLowerCase();
      return `{ const _n = (BigInt(edx | 0) << 32n) | BigInt(eax >>> 0); ` +
             `const _d = BigInt(${r} | 0); ` +
             `if (_d === 0n) throw new Error('idiv by zero in ${ctx.name}'); ` +
             `eax = Number(BigInt.asIntN(32, _n / _d)) | 0; ` +
             `edx = Number(BigInt.asIntN(32, _n % _d)) | 0; }`;
    }

    /** `shrd d,s,n`: d gets its own top bits shifted down with s's low bits shifted in. */
    case 'shrd': {
      const [d, src, n] = args.map(a => String(a).toLowerCase());
      const k = imm(n);
      if (!isReg32(d) || !isReg32(src) || k === null) throw new AuxError(`unsupported shrd: '${s}'`);
      return `${d} = (((${d} >>> ${k}) | (${src} << ${32 - k})) | 0);`;
    }

    /** `shld d,s,n`: the mirror -- d shifts up, s's top bits shift in. */
    case 'shld': {
      const [d, src, n] = args.map(a => String(a).toLowerCase());
      const k = imm(n);
      if (!isReg32(d) || !isReg32(src) || k === null) throw new AuxError(`unsupported shld: '${s}'`);
      return `${d} = (((${d} << ${k}) | (${src} >>> ${32 - k})) | 0);`;
    }

    case 'sal': case 'shl': {
      const [d, n] = args.map(a => String(a).toLowerCase());
      const k = imm(n);
      if (!isReg32(d) || k === null) throw new AuxError(`unsupported ${op}: '${s}'`);
      return `${d} = (${d} << ${k}) | 0;`;
    }

    case 'sar': {
      const [d, n] = args.map(a => String(a).toLowerCase());
      const k = imm(n);
      if (!isReg32(d) || k === null) throw new AuxError(`unsupported sar: '${s}'`);
      return `${d} = ${d} >> ${k};`;
    }

    /*
     * A software interrupt, handed to the same environment that answers int386 -- so a routine
     * written in assembly and one written in C reach the same BIOS. `zf` comes back because that is
     * how the BIOS keyboard answers "is a key waiting", and the next instruction is a `jz`.
     */
    case 'int': {
      const n = imm(args[0]);
      if (n === null) throw new AuxError(`unsupported int: '${s}'`);
      ctx.usesInt = true;
      return `{ const _r = M.rt.__asmInt(${n}, { eax, ebx, ecx, edx, esi, edi }); ` +
             `eax = _r.eax | 0; ebx = _r.ebx | 0; ecx = _r.ecx | 0; edx = _r.edx | 0; ` +
             `esi = _r.esi | 0; edi = _r.edi | 0; zf = !!_r.zf; }`;
    }

    case 'jz': case 'je': { ctx.jumps.add(args[0]); return `if (zf) { _pc = ${JSON.stringify(args[0])}; continue; }`; }
    case 'jnz': case 'jne': { ctx.jumps.add(args[0]); return `if (!zf) { _pc = ${JSON.stringify(args[0])}; continue; }`; }
    case 'jmp': { ctx.jumps.add(args[0]); return `{ _pc = ${JSON.stringify(args[0])}; continue; }`; }
    case 'nop': return '';
  }
  throw new AuxError(`unsupported instruction '${op}' in #pragma aux ${ctx.name}: '${s}'`);
}

/**
 * Compile one pragma into a JavaScript function source.
 *
 * `parm [eax] [ebx]` names where the arguments arrive and `value [eax]` where the result is read,
 * so the C signature never has to be consulted: the pragma states the whole calling convention.
 *
 * Control flow is a labelled dispatch loop rather than straight-line code, because a jump may go
 * BACKWARDS and JavaScript has no goto. For a routine with no jumps at all -- which is two of the
 * three real clients -- the loop is emitted flat instead.
 */
export function compileAux(aux, link) {
  const ctx = { name: aux.name, labels: new Set(), jumps: new Set(), usesInt: false };
  const body = aux.insns.map(i => emitInsn(i, ctx));

  for (const j of ctx.jumps) {
    if (!ctx.labels.has(j)) throw new AuxError(`#pragma aux ${aux.name} jumps to '${j}', which it never defines`);
  }

  const params = (aux.parm ?? []).map((r, i) => `_a${i}`);
  const init = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi']
    .map(r => {
      const at = (aux.parm ?? []).indexOf(r);
      return `let ${r} = ${at >= 0 ? `_a${at} | 0` : '0'};`;
    }).join(' ');
  const ret = aux.value ? `return ${aux.value} | 0;` : 'return 0;';

  if (!ctx.jumps.size) {
    return `function ${link}(${params.join(',')}){\n  ${init} let zf = false;\n  ` +
           body.filter(Boolean).join('\n  ') + `\n  ${ret}\n}`;
  }

  /*
   * With jumps: one switch inside a loop, each label a case, fall-through carrying straight-line
   * flow exactly as the instruction stream does. `_pc` names the next block, and the loop ends when
   * a block runs off the end.
   */
  const parts = [];
  let current = ['case "":'];
  for (const line of body) {
    if (/^case /.test(line)) { parts.push(current); current = [line]; } else if (line) current.push(line);
  }
  parts.push(current);
  const cases = parts.map(p => p.join('\n      ')).join('\n      ');
  return `function ${link}(${params.join(',')}){\n  ${init} let zf = false; let _pc = "";\n` +
         `  _loop: for (;;) {\n    switch (_pc) {\n      ${cases}\n    }\n    break _loop;\n  }\n  ${ret}\n}`;
}
