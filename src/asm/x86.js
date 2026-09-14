// x86.js — translate the parsed NASM subset into JavaScript, with a real EFLAGS.
//
// THE FLAGS ARE EAGER AND COMPLETE, and that is a decision against my own first plan. The five
// conditions this file needs (jge, jl, jle, jnz, jns) all sit immediately after the instruction
// that defines them, so keeping the last comparison's two operands and deducing the answer would
// work -- on this file. It would also be a brand-new model with nothing behind it, while a real
// CF/PF/AF/ZF/SF/OF computed at the operation's width is the model MIRAGE already runs against
// Unicorn over 2,228 committed cases. Borrowing the MODEL and re-deriving it here is cheap;
// inventing a shortcut and hoping is not.
//
// Nothing of MIRAGE's code is imported. It emits against a `cpu` object with a register file
// because it IS a processor; what PRISM needs is a plain function that will be called from compiled
// C. Dragging a CPU into a C compiler is exactly what the roadmap means by "the compiler and the
// recompiler share nothing".
//
// WIDTH IS NOT DECORATION. get_block ends its inner loop with `dec cx` and put_block, the same
// loop, with `dec ecx`. Every operation here carries its width, and the flags are computed at that
// width -- a 16-bit decrement that reaches zero must set ZF even when the upper half is not zero.
//
// The emitted shape is a state machine: JavaScript has no goto, and these routines jump backwards
// into the middle of loops. `for(;;) switch(_pc)` is the same device src/backend/flatten.js uses
// for C gotos, for the same reason.

import { regInfo } from './nasm.js';

const R = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'];
const MASK = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
const SIGN = { 1: 0x80, 2: 0x8000, 4: 0x80000000 };

/** Read a register operand at its own width, as an UNSIGNED value. */
function readReg(name) {
  const r = regInfo(name);
  if (!r) throw new Error(`unknown register ${name}`);
  if (r.size === 4) return `(${r.base}>>>0)`;
  return `((${r.base}>>>${r.shift})&${MASK[r.size]})`;
}

/** Assign to a register operand, leaving the rest of the 32-bit register alone. */
function writeReg(name, valueExpr) {
  const r = regInfo(name);
  if (r.size === 4) return `${r.base}=(${valueExpr})|0;`;
  const keep = ~(MASK[r.size] << r.shift) >>> 0;
  return `${r.base}=((${r.base}&${keep})|(((${valueExpr})&${MASK[r.size]})<<${r.shift}))|0;`;
}

export class EmitError extends Error {}

/**
 * Translate one global routine.
 *
 * Returns JavaScript source for a function `(D, regs, io) => regs`, where D is a DataView over the
 * whole guest image, regs carries the eight registers in and out, and io.out(port, size, value) is
 * called for every `out`. That is deliberately Unicorn's own shape: the differential then compares
 * two things that were asked the same question, rather than two things that had to be adapted first.
 */
export function translate(parsed, name, { symbols = {}, dataBase = 0, paged = false } = {}) {
  // Where each in-.text data slot lives. They are given addresses in the guest image, because the
  // routine takes no special care with them -- they are just memory it happens to keep near itself.
  const slots = new Map();
  let at = dataBase;
  for (const it of parsed.items) {
    if (it.kind !== 'data') continue;
    slots.set(it.name, at);
    at += it.size * it.values.length;
  }

  const labels = new Map();
  const body = [];
  let pc = 0;

  // Pass 1: every label gets a state number, so a backward jump has somewhere to go.
  let started = false;
  const own = [];
  for (const it of parsed.items) {
    if (it.kind === 'label' && it.global) started = (it.name === name);
    if (!started) continue;
    if (it.kind === 'label' && it.global && it.name !== name) break;
    own.push(it);
  }
  if (!own.length) throw new EmitError(`no routine called ${name}`);
  for (const it of own) if (it.kind === 'label') labels.set(it.name, labels.size);

  const addr = (o) => {
    if (o.k !== 'mem') throw new EmitError('not a memory operand');
    if (o.sym !== undefined) {
      if (slots.has(o.sym)) return String(slots.get(o.sym));
      if (o.sym in symbols) return String(symbols[o.sym]);
      throw new EmitError(`no address for symbol ${o.sym}`);
    }
    return o.disp ? `((${o.base}+${o.disp})|0)` : `(${o.base}|0)`;
  };
  /*
   * THROUGH THE PAGE MAP WHEN THERE IS ONE, and this is the defect that produced a background with
   * one column in four. These two routines exist precisely to move rectangles in and out of PLANAR
   * video memory, and they were emitting D.setUint8 straight at the flat image -- so every byte they
   * wrote landed at 0xA0000 and never reached a plane.
   *
   * It is the same hole as memset and memcpy, closed hours earlier the same day and reopened here by
   * hand. The reason it went unseen is worth more than the fix: the translator was validated against
   * Unicorn on a FLAT image, where the question cannot arise, so 400 green cases said nothing about
   * it either way.
   */
  // The stack too, for uniformity: it is plain memory, so a map translates it to itself -- and a
  // rule with one exception is a rule somebody trips over later.
  const SW = (e) => (paged ? `xw(${e})` : e);
  const SR = (e) => (paged ? `xr(${e})` : e);
  const A = (o) => (paged ? `xw(${addr(o)})` : addr(o));
  const Ar = (o) => (paged ? `xr(${addr(o)})` : addr(o));
  const loadMem = (o) => `D.${{ 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' }[o.size]}(${Ar(o)}${o.size > 1 ? ',1' : ''})`;
  const storeMem = (o, v) => `D.${{ 1: 'setUint8', 2: 'setUint16', 4: 'setUint32' }[o.size]}(${A(o)},${v}${o.size > 1 ? ',1' : ''});`;

  /** An operand's value, unsigned, at `size` bytes. */
  const rd = (o, size) => {
    if (o.k === 'reg') return readReg(o.name);
    if (o.k === 'imm') return String(o.value >>> 0);
    if (o.k === 'mem') return loadMem({ ...o, size: o.size ?? size });
    throw new EmitError(`cannot read operand ${o.k}`);
  };
  const wr = (o, v, size) => {
    if (o.k === 'reg') return writeReg(o.name, v);
    if (o.k === 'mem') return storeMem({ ...o, size: o.size ?? size }, v);
    throw new EmitError(`cannot write operand ${o.k}`);
  };
  const sizeOf = (ops) => {
    for (const o of ops) {
      if (o.k === 'reg') return regInfo(o.name).size;
      if (o.k === 'mem' && o.size) return o.size;
    }
    return 4;
  };

  /* Flags, computed at width w from the two inputs and the result. `_fk` names the kind so that
   * carry and overflow, which differ between add and sub, are not guessed at. */
  const flags = (kind, a, b, r, w) => `_fl(${kind},${a},${b},${r},${w});`;

  for (const it of own) {
    if (it.kind === 'label') { body.push(`case ${labels.get(it.name)}:`); continue; }
    if (it.kind === 'data') continue;
    const { op, operands: ops } = it;
    const w = sizeOf(ops);
    const line = `/* ${it.text} */`;

    const jump = (cond) => {
      const target = labels.get(ops[0].name);
      if (target === undefined) throw new EmitError(`${it.at}: jump to unknown label ${ops[0].name}`);
      body.push(`${line} if(${cond}){_pc=${target};continue;}`);
    };

    switch (op) {
      case 'mov': body.push(line + ' ' + wr(ops[0], rd(ops[1], w), w)); break;

      case 'add': case 'sub': case 'and': case 'or': case 'xor': case 'cmp': {
        const a = `_a=${rd(ops[0], w)}`, b = `_b=${rd(ops[1], w)}`;
        const expr = { add: '(_a+_b)', sub: '(_a-_b)', and: '(_a&_b)', or: '(_a|_b)', xor: '(_a^_b)', cmp: '(_a-_b)' }[op];
        body.push(`${line} ${a};${b};_r=${expr}&${MASK[w]};` + flags(`'${op}'`, '_a', '_b', '_r', w));
        if (op !== 'cmp') body.push(wr(ops[0], '_r', w));
        break;
      }

      case 'inc': case 'dec': {
        // CF is NOT touched by inc/dec, which is the whole reason they exist beside add/sub.
        const a = `_a=${rd(ops[0], w)}`;
        body.push(`${line} ${a};_r=(_a${op === 'inc' ? '+1' : '-1'})&${MASK[w]};` +
          flags(`'${op}'`, '_a', '1', '_r', w));
        body.push(wr(ops[0], '_r', w));
        break;
      }

      case 'neg': {
        body.push(`${line} _a=${rd(ops[0], w)};_r=(0-_a)&${MASK[w]};` + flags(`'neg'`, '0', '_a', '_r', w));
        body.push(wr(ops[0], '_r', w));
        break;
      }

      case 'shl': case 'shr': case 'sar': {
        const count = ops[1].k === 'reg' ? `(${readReg(ops[1].name)}&31)` : `(${ops[1].value}&31)`;
        const a = rd(ops[0], w);
        const expr = op === 'shl' ? `((_a<<_c)&${MASK[w]})`
          : op === 'shr' ? `(_a>>>_c)`
            : `((_a<<${32 - w * 8}>>${32 - w * 8})>>_c)&${MASK[w]}`;   // sar: sign-extend to w first
        body.push(`${line} _a=${a};_c=${count};_r=_c?${expr}:_a;if(_c)` + flags(`'${op}'`, '_a', '_c', '_r', w));
        body.push(wr(ops[0], '_r', w));
        break;
      }

      case 'imul': {
        if (ops.length !== 1) throw new EmitError(`${it.at}: only one-operand imul is in the subset`);
        // EDX:EAX = EAX * src, SIGNED, and the high half is not optional: the routines multiply a
        // row count by a row width and read edx nowhere -- but a translation that dropped edx would
        // differ from the reference the moment anything else did.
        body.push(`${line} { const _p=BigInt(eax|0)*BigInt(${rd(ops[0], 4)}|0);` +
          `eax=Number(_p&0xffffffffn)|0; edx=Number((_p>>32n)&0xffffffffn)|0;` +
          `_fl('imul',0,0,0,4,_p); }`);
        break;
      }

      case 'push': body.push(`${line} esp=(esp-4)|0;D.setUint32(${SW('esp')},${rd(ops[0], 4)},1);`); break;
      case 'pop': body.push(`${line} ` + wr(ops[0], `D.getUint32(${SR('esp')},1)`, 4) + `esp=(esp+4)|0;`); break;

      case 'pusha':
        body.push(`${line} { const _sp=esp; ` +
          ['eax', 'ecx', 'edx', 'ebx', '_sp', 'ebp', 'esi', 'edi']
            .map(r => `esp=(esp-4)|0;D.setUint32(${SW('esp')},${r}>>>0,1);`).join('') + ' }');
        break;
      case 'popa':
        body.push(`${line} ` + ['edi', 'esi', 'ebp', '_skip', 'ebx', 'edx', 'ecx', 'eax']
          .map(r => r === '_skip' ? `esp=(esp+4)|0;`
            : `${r}=D.getUint32(${SR('esp')},1)|0;esp=(esp+4)|0;`).join(''));
        break;

      case 'out':
        // `out dx, ax` and `out dx, al`: the port is DX, the width comes from the source register.
        body.push(`${line} io.out(${readReg('dx')},${regInfo(ops[1].name).size},${rd(ops[1], w)});`);
        break;

      // `ret` POPS. Leaving the return address on the stack would make the final esp differ from
      // the reference by four -- a difference that says nothing about the translation and would
      // have to be explained away on every single comparison.
      case 'ret': body.push(`${line} esp=(esp+4)|0;_pc=-1;continue;`); break;
      case 'nop': body.push(line); break;

      case 'jmp': jump('1'); break;
      case 'jz': case 'je': jump('_ZF'); break;
      case 'jnz': case 'jne': jump('!_ZF'); break;
      case 'js': jump('_SF'); break;
      case 'jns': jump('!_SF'); break;
      case 'jl': jump('(_SF!==_OF)'); break;
      case 'jge': jump('(_SF===_OF)'); break;
      case 'jle': jump('(_ZF||(_SF!==_OF))'); break;
      case 'jg': jump('(!_ZF&&(_SF===_OF))'); break;
      case 'jc': jump('_CF'); break;
      case 'jnc': jump('!_CF'); break;

      default: throw new EmitError(`${it.at}: no translation for ${op} (${it.text})`);
    }
  }

  const entry = labels.get(name);
  // The two translations arrive as parameters only when the platform is paged, so an unpaged target
  // emits exactly the function it emitted before any of this -- which gate-asm runs, flat.
  return `(function ${name.replace(/[^\w]/g, '_')}(D, regs, io${paged ? ', xr, xw' : ''}){
  let ${R.join('=0, ')}=0;
  ${R.map(r => `${r}=regs.${r}|0;`).join(' ')}
  let _a=0,_b=0,_r=0,_c=0;
  let _CF=false,_PF=false,_AF=false,_ZF=false,_SF=false,_OF=false;
  const _fl=(k,a,b,r,w,big)=>{
    const sign=${JSON.stringify(SIGN)}[w], mask=${JSON.stringify(MASK)}[w];
    _ZF=(r&mask)===0; _SF=((r&sign)!==0);
    let p=r&0xff; p^=p>>4; p^=p>>2; p^=p>>1; _PF=!(p&1);
    if(k==='add'){ _CF=((a+b)>>>0)>mask||((a+b)>mask); _AF=(((a^b^r)&0x10)!==0);
      _OF=((~(a^b)&(a^r)&sign)!==0); }
    else if(k==='sub'||k==='cmp'||k==='neg'){ _CF=(a>>>0)<(b>>>0); _AF=(((a^b^r)&0x10)!==0);
      _OF=(((a^b)&(a^r)&sign)!==0); }
    else if(k==='inc'||k==='dec'){ _AF=(((a^b^r)&0x10)!==0);
      _OF=(k==='inc'?(r&mask)===sign:(r&mask)===(sign-1)); }
    else if(k==='and'||k==='or'||k==='xor'){ _CF=false; _OF=false; _AF=false; }
    else if(k==='shl'){ _CF=((a>>>(w*8-b))&1)!==0; _OF=b===1&&(((r&sign)!==0)!==_CF); }
    else if(k==='shr'||k==='sar'){ _CF=((a>>>(b-1))&1)!==0; _OF=b===1&&k==='shr'&&((a&sign)!==0); }
    else if(k==='imul'){ const fits=big>=-2147483648n&&big<=2147483647n; _CF=!fits; _OF=!fits; }
  };
  let _pc=${entry};
  for(;;){
    switch(_pc){
${body.map(l => '      ' + l).join('\n')}
      default: break;
    }
    break;
  }
  return {${R.join(', ')}, flags:{CF:_CF,PF:_PF,AF:_AF,ZF:_ZF,SF:_SF,OF:_OF}};
})`;
}
