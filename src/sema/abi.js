// abi.js — i386 System V type layout. Non-negotiably exact.
//
// Game code memcpy's WAD/ROM bytes straight into structs and reads fields by offset, so a single
// wrong pad byte does not produce a clean error: it produces corrupted sprites, and the bug gets
// hunted everywhere except here. Every number below was OBSERVED from a real i386 gcc
// (tools/probe-abi.mjs), never derived from the manuals.
//
// The trap that makes this file necessary: gcc's `__alignof__(double)` and `__alignof__(long long)`
// report 8 on i386, but the ABI aligns both to 4 *inside a struct* —
//     struct { char a; double b; }  =>  b at offset 4, sizeof == 12
// `__alignof__` answers "preferred alignment", which is a different question from the one a struct
// layout asks. Ask offsetof, not alignof.

/** size and ABI (in-struct) alignment of every scalar type on i386 SysV. */
export const SCALARS = {
  'void':                 { size: 1,  align: 1 },   // GNU: sizeof(void)==1
  '_Bool':                { size: 1,  align: 1 },
  'char':                 { size: 1,  align: 1, signed: true },
  'signed char':          { size: 1,  align: 1, signed: true },
  'unsigned char':        { size: 1,  align: 1 },
  'short':                { size: 2,  align: 2, signed: true },
  'unsigned short':       { size: 2,  align: 2 },
  'int':                  { size: 4,  align: 4, signed: true },
  'unsigned int':         { size: 4,  align: 4 },
  'long':                 { size: 4,  align: 4, signed: true },
  'unsigned long':        { size: 4,  align: 4 },
  'long long':            { size: 8,  align: 4, signed: true },   // align 4, NOT 8
  'unsigned long long':   { size: 8,  align: 4 },
  'float':                { size: 4,  align: 4 },
  'double':               { size: 8,  align: 4 },                 // align 4, NOT 8
  'long double':          { size: 12, align: 4 },                 // 12 bytes on i386, not 16
  'pointer':              { size: 4,  align: 4 },
  'enum':                 { size: 4,  align: 4, signed: true },
};

/**
 * The 16-bit DOS model, small memory model, as Open Watcom lays it out (`wcc -bt=dos -0 -ms`).
 * Every number here was OBSERVED, not read from a manual -- `tools/probe-abi16.mjs` asks the
 * compiler and reads the answers out of the object file, because nothing on this machine can run a
 * DOS executable.
 *
 * Two of them are the reason a 16-bit axis cannot be a search-and-replace of the widths:
 *
 *   - ALIGNMENT STOPS AT 2. A `double` after a `char` sits at offset 2, not 8: on an 8086 there is
 *     no wider bus to align to. So `struct { char a; double b; }` is 10 bytes where i386 makes it 12.
 *   - AN ENUM IS ONE BYTE when its constants fit, where i386 gives every enum 4. That is a
 *     different rule, not a narrower one, and it changes the size of any struct holding an enum.
 *
 * A pointer is 2 bytes in the small model only; the compact, large and huge models make it 4, which
 * is the segmentation this project's plan puts out of scope.
 */
export const SCALARS_DOS16 = {
  'void':                 { size: 1,  align: 1 },
  '_Bool':                { size: 1,  align: 1 },
  'char':                 { size: 1,  align: 1, signed: true },
  'signed char':          { size: 1,  align: 1, signed: true },
  'unsigned char':        { size: 1,  align: 1 },
  'short':                { size: 2,  align: 2, signed: true },
  'unsigned short':       { size: 2,  align: 2 },
  'int':                  { size: 2,  align: 2, signed: true },
  'unsigned int':         { size: 2,  align: 2 },
  'long':                 { size: 4,  align: 2, signed: true },
  'unsigned long':        { size: 4,  align: 2 },
  'float':                { size: 4,  align: 2 },
  'double':               { size: 8,  align: 2 },
  'long double':          { size: 8,  align: 2 },   // Watcom's long double IS a double
  'pointer':              { size: 2,  align: 2 },
  'enum':                 { size: 1,  align: 1, signed: true },
};

/**
 * The 16-bit DOS LARGE model, as Open Watcom lays it out (`wcc -bt=dos -0 -ml`). Measured the same
 * way as the small table above, with the same probe.
 *
 * It differs from small in ONE entry -- a pointer is four bytes -- and that one entry is why it
 * exists. Keen Dreams declares 113,967 bytes of statics, about 75,386 of them not marked far, in a
 * model whose whole data segment is 64K: it cannot have been built small or medium, so its default
 * data pointers are far. The four models Watcom builds, measured:
 *
 *   -ms small    data* 2  code* 2      -mc compact  data* 4  code* 2
 *   -mm medium   data* 2  code* 4      -ml large    data* 4  code* 4
 *
 * Large rather than compact because large makes both pointers four bytes, and a single `pointer`
 * entry can then say so; compact would need the type system to tell a code pointer from a data one,
 * which is a change of shape rather than a table.
 *
 * NOTE THE ALIGNMENT: a four-byte pointer aligns to TWO. Alignment stops at 2 in 16-bit DOS, which
 * is the rule the small table's header already calls out as unguessable, and it applies to `long`,
 * `float` and `double` here too -- an eight-byte double on a two-byte boundary.
 *
 * ONE ENTRY DISAGREES WITH THE SMALL TABLE ABOVE, and it is recorded rather than reconciled: the
 * oracle says `(char)-1 < 0` is FALSE under both -ms and -ml, so Watcom's 16-bit char is UNSIGNED,
 * while SCALARS_DOS16 records `signed: true`. Nothing measures that entry -- gate-abi16 checks
 * sizes, offsets and bitfields, never signedness -- so it has never been contradicted. Both can be
 * defended: Watcom's default char is unsigned, BORLAND's is signed, and the corpus program this is
 * for is a Borland one. Which compiler the tables are meant to describe is the question to settle,
 * and settling it by editing one line quietly is how a measured table stops being one.
 */
export const SCALARS_DOS16_LARGE = {
  ...SCALARS_DOS16,
  'pointer':              { size: 4,  align: 2 },
  'char':                 { size: 1,  align: 1 },   // unsigned, as this oracle builds it
};

/** The type tables, by target. `i386` is what the compiler emits for; the dos16 pair is measured. */
export const MODELS = { i386: SCALARS, dos16: SCALARS_DOS16, dos16l: SCALARS_DOS16_LARGE };

/** Scalar/pointer/array constructors bound to one model, for a gate that checks another target. */
export function modelTypes(name) {
  const table = MODELS[name];
  if (!table) throw new Error(`abi: unknown model '${name}'`);
  const sc = (n) => {
    const s = table[n];
    if (!s) throw new Error(`abi: unknown scalar '${n}' in model '${name}'`);
    return { k: 'scalar', name: n, ...s };
  };
  return {
    scalar: sc,
    ptr: (to = null) => ({ k: 'ptr', to, ...table.pointer }),
    array: (of, n) => ({ k: 'array', of, n, size: of.size * n, align: of.align }),
    enumType: () => ({ k: 'scalar', name: 'enum', ...table.enum }),
  };
}

/** `char` is signed on i386 Linux/DJGPP — observed: (int)(char)-1 == -1. */
export const CHAR_SIGNED = true;

export const scalar = (name) => {
  const s = SCALARS[name];
  if (!s) throw new Error(`abi: unknown scalar '${name}'`);
  return { k: 'scalar', name, ...s };
};
export const ptr = (to = null) => ({ k: 'ptr', to, ...SCALARS.pointer });
export const array = (of, n) => ({ k: 'array', of, n, size: of.size * n, align: of.align });

const roundUp = (v, a) => (a <= 1 ? v : Math.ceil(v / a) * a);

/** A declared type without its signedness: what Watcom's bitfield units are keyed on. */
const family = (name) => name.replace(/^(unsigned|signed) /, '');

/**
 * Lay out a struct.
 * @param fields [{name, type, bits?}] — `bits` present (including 0) makes it a bitfield.
 *               An unnamed zero-width bitfield is {name: null, type, bits: 0}.
 * @param packed __attribute__((packed)): every member aligns to 1.
 * @param maxAlign `#pragma pack(n)` in force: every member aligns to min(natural, n). pack(1) is
 *                 then exactly `packed`, but pack(2) and pack(4) are not expressible any other way.
 * @returns {k:'struct', size, align, fields:[{...,offset,bitOffset?}], byName}
 */
export function layoutStruct(fields, { packed = false, maxAlign = null, bitfields = 'gcc' } = {}) {
  const clamp = (a) => (maxAlign ? Math.min(a, maxAlign) : a);
  let bitPos = 0;          // current position, in BITS from the start of the struct
  let align = 1;
  const out = [];
  /*
   * WATCOM PLACES BITFIELDS IN WHOLE UNITS, and that is not a variation on the SysV rule -- it is a
   * different rule. A bitfield of type T takes a unit of sizeof(T) at the next alignof(T) boundary;
   * consecutive bitfields share that unit while they fit, and anything else -- a wider bitfield, a
   * plain member -- starts after the WHOLE unit rather than at the next free bit.
   *
   *   struct { unsigned int f:3; unsigned char c; }   gcc: c at 1    Watcom: c at 2
   *   struct { char a:5; unsigned long b:23; }        gcc: 4 bytes   Watcom: 6
   *
   * Measured, not read: 28 of gate-abi16's 518 checks disagreed until this existed, and every one of
   * them held a bitfield.
   */
  let unitAt = -1, unitSize = 0, unitUsed = 0, unitType = null;   // the open Watcom unit

  for (const f of fields) {
    const t = f.type;
    const ta = packed ? 1 : clamp(t.align);

    if (f.bits === undefined) {
      // Plain member: advance to the next byte, then to its alignment.
      if (bitfields === 'watcom') unitAt = -1;
      const off = roundUp(Math.ceil(bitPos / 8), ta);
      // A FLEXIBLE array member (`char a[];`) takes the next aligned offset but contributes nothing
      // to the size: `struct { char c; char a[]; }` is one byte with `a` at offset 1. Its size is
      // null, which made the running bit position NaN.
      const msize = t.size == null ? 0 : t.size;
      out.push({ ...f, offset: off, flexible: t.size == null });
      bitPos = (off + msize) * 8;
      align = Math.max(align, ta);
      continue;
    }

    // Bitfield. The storage unit is the DECLARED type: a `char a:3` packs into a byte, an
    // `int a:3` into a 4-byte unit — which is why struct BF2 {char a:3; char b:6} is 2 bytes
    // while BF1 {int a:1; int b:1} is 4.
    const unit = t.size * 8;

    if (bitfields === 'watcom' && f.bits === 0) {
      // `int :0;` CLOSES the open unit, so the next bitfield starts a fresh one -- which is the
      // whole of its meaning under a whole-unit rule, and is why BF5 is 4 bytes and not 2.
      if (unitAt >= 0) bitPos = (unitAt + unitSize) * 8;
      bitPos = roundUp(bitPos, ta * 8);
      unitAt = -1;
      out.push({ ...f, offset: bitPos >> 3, bitOffset: bitPos, width: 0 });
      continue;
    }

    if (bitfields === 'watcom' && f.bits > 0) {
      const bytes = t.size;
      /*
       * The unit is shared by bitfields of the same type FAMILY -- the declared type with its
       * signedness stripped. Two measurements pin it, and neither was guessable:
       *
       *   unsigned int f2:3; unsigned short f3:11;   two bytes each, 14 bits together -- and Watcom
       *                                              still opens a second unit (seed 777)
       *   unsigned int f0:1; int f1:8;               different signedness, SAME unit (seed 90210)
       *
       * So it is not the width and it is not the spelling: it is short/int/long/char.
       */
      const fits = unitAt >= 0 && unitType === family(t.name) && unitUsed + f.bits <= bytes * 8;
      if (!fits) {
        unitAt = roundUp(Math.ceil(bitPos / 8), ta);
        unitSize = bytes;
        unitUsed = 0;
        unitType = family(t.name);
      }
      out.push({ ...f, offset: unitAt, bitOffset: unitAt * 8 + unitUsed, width: f.bits });
      unitUsed += f.bits;
      bitPos = (unitAt + bytes) * 8;
      align = Math.max(align, ta);
      continue;
    }

    if (f.bits === 0) {
      // `int :0;` — no storage; it only forces the NEXT field to a boundary. Three observed rules,
      // each of which the generator had to find (tools/gate-abi.mjs seeds 777/90210):
      //   - it rounds to alignof(T)*8, NOT sizeof(T)*8 — `long long :0` moves to bit 32, not 64;
      //   - it contributes NO alignment to the struct (`{char; int:0; char}` has align 1, size 5);
      //   - __attribute__((packed)) does NOT suppress the rounding.
      bitPos = roundUp(bitPos, t.align * 8);
      out.push({ ...f, offset: bitPos >> 3, bitOffset: bitPos, width: 0 });
      continue;
    }

    align = Math.max(align, ta);

    // Placement. The naive rule ("never straddle a sizeof(T) unit") is WRONG and the generator
    // proved it: `unsigned long long f3:21` at bit 112 straddles, yet gcc leaves it there. The real
    // System V / PCC rule is that a bitfield may span up to sizeof(T)/alignof(T) units of
    // alignof(T) bits — two for `long long` (8 bytes, 4-byte aligned), one for `int`:
    //
    //   span = ceil((bitPos % abits + width) / abits)  >  sizeof(T)*8 / abits   =>  advance
    //
    // A packed bitfield is exempt from the rule ENTIRELY — not merely clamped to a byte: gcc
    // guards the whole test with `! DECL_PACKED (field)`, so `unsigned int f1:26` following a
    // 23-bit field sits at bit 23, not 24. (The zero-width rounding above is a different code
    // path and is NOT exempt — which is why the two disagree on packed.)
    if (!packed) {
      const abits = ta * 8;
      const allowedSpan = Math.max(1, Math.floor(unit / abits));
      const span = Math.ceil((bitPos % abits + f.bits) / abits);
      if (span > allowedSpan) bitPos = roundUp(bitPos, abits);
    }
    out.push({ ...f, offset: bitPos >> 3, bitOffset: bitPos, width: f.bits });
    bitPos += f.bits;
  }

  if (packed) align = 1;
  if (maxAlign) align = Math.min(align, maxAlign);
  const size = roundUp(Math.ceil(bitPos / 8), align);
  const byName = {};
  for (const f of out) if (f.name) byName[f.name] = f;
  return { k: 'struct', size, align, fields: out, byName, packed, maxAlign };
}

/** Unions: every member at 0; size is the max member size rounded to the max alignment. */
export function layoutUnion(fields, { packed = false, maxAlign = null } = {}) {
  let size = 0, align = 1;
  const out = [];
  for (const f of fields) {
    const ta = packed ? 1 : (maxAlign ? Math.min(f.type.align, maxAlign) : f.type.align);
    const fs = f.bits !== undefined ? Math.ceil(f.bits / 8) : f.type.size;
    size = Math.max(size, fs);
    align = Math.max(align, ta);
    // A bitfield in a union starts at bit 0 of the union, and it still needs its PLACEMENT
    // recorded: without bitOffset/width a read computed `undefined >> 5` and produced noise
    // (gcc's bitfld-6.c, which only started running once __BYTE_ORDER__ was defined).
    out.push(f.bits !== undefined
      ? { ...f, offset: 0, bitOffset: 0, width: f.bits }
      : { ...f, offset: 0 });
  }
  if (packed) align = 1;
  if (maxAlign) align = Math.min(align, maxAlign);
  const byName = {};
  for (const f of out) if (f.name) byName[f.name] = f;
  return { k: 'union', size: roundUp(size, align), align, fields: out, byName, packed, maxAlign };
}
