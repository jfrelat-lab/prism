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

/**
 * Lay out a struct.
 * @param fields [{name, type, bits?}] — `bits` present (including 0) makes it a bitfield.
 *               An unnamed zero-width bitfield is {name: null, type, bits: 0}.
 * @param packed __attribute__((packed)): every member aligns to 1.
 * @param maxAlign `#pragma pack(n)` in force: every member aligns to min(natural, n). pack(1) is
 *                 then exactly `packed`, but pack(2) and pack(4) are not expressible any other way.
 * @returns {k:'struct', size, align, fields:[{...,offset,bitOffset?}], byName}
 */
export function layoutStruct(fields, { packed = false, maxAlign = null } = {}) {
  const clamp = (a) => (maxAlign ? Math.min(a, maxAlign) : a);
  let bitPos = 0;          // current position, in BITS from the start of the struct
  let align = 1;
  const out = [];

  for (const f of fields) {
    const t = f.type;
    const ta = packed ? 1 : clamp(t.align);

    if (f.bits === undefined) {
      // Plain member: advance to the next byte, then to its alignment.
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
