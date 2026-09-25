// types.js — the type system, on top of the exact i386 layout in abi.js.
//
// Types are plain objects, structurally shared where possible. Qualifiers live on the type object
// (`cv`) rather than in a wrapper, because C's qualifiers do not affect layout and a wrapper would
// have to be unwrapped at every use site.

import { MODELS, layoutStruct, layoutUnion } from './abi.js';

export const VOID = { k: 'void', name: 'void', size: 1, align: 1 };

/**
 * One ABI model's type constructors, as a VALUE rather than a module binding.
 *
 * abi.js has held both tables for a long time -- i386, and dos16 measured against Open Watcom and
 * pinned by gate-abi16 -- but this file bound i386 at module scope and fixed a pointer at 4 bytes,
 * so nothing could ask for the other. ARCHITECTURE.md names threading a model through here as what
 * the 16-bit backend IS.
 *
 * This is the first half of that and it changes no behaviour: the module still exports the i386
 * instance under the names everything already uses -- 262 of them across 15 files -- and the second
 * half is teaching those call sites to ask a model instead. Splitting it keeps the mechanical change
 * apart from the one that can be wrong.
 *
 * `long long` is in i386 and NOT in dos16, which is right: Borland's C89 had no such type. It is
 * absent from the object rather than quietly aliased, so asking for it under dos16 raises.
 */
export function makeTypes(model = 'i386', { signedChar } = {}) {
  const base = MODELS[model];
  if (!base) throw new Error(`types: unknown ABI model '${model}'`);
  /*
   * Whether plain char is signed belongs to the COMPILER, not to the model: Watcom's 16-bit char is
   * unsigned, Borland's is signed, and both lay memory out the same way. So the table carries the
   * default its oracle measured, and a program built by another compiler overrides it -- the way
   * gcc's -fsigned-char, Watcom's -j and Borland's -K do.
   */
  const table = signedChar === undefined ? base
    : { ...base, char: { ...base.char, signed: !!signedChar } };
  const cache = new Map();
  const scalar = (name) => {
    if (name === 'void') return VOID;
    let t = cache.get(name);
    if (!t) {
      const s = table[name];
      if (!s) throw new Error(`types: model '${model}' has no scalar '${name}'`);
      t = { k: 'scalar', name, size: s.size, align: s.align, signed: !!s.signed };
      cache.set(name, t);
    }
    return t;
  };
  /*
   * Which pointer: an explicit `far` or `near` first, then a function's default, then data's. i386
   * has none of the three extra entries, so every branch lands on `pointer` there and nothing moves.
   * The qualifier is kept on the type only when the model gives it a size of its own.
   */
  const ptr = (to, qual) => {
    const entry = qual === 'far' ? (table.farPointer ?? table.pointer)
      : qual === 'near' ? (table.nearPointer ?? table.pointer)
      : to && to.k === 'func' ? (table.codePointer ?? table.pointer)
      : table.pointer;
    const p = { k: 'ptr', to, ...entry, signed: false };
    if (qual && table.farPointer) p.qual = qual;
    return p;
  };
  const T = {
    model, VOID, scalar, ptr,
    /*
     * Borland's `_seg`: a pointer that holds only a SEGMENT -- a paragraph number, two bytes -- and
     * names the object at seg*16. Under a 16-bit model that is a real type with a real size, and
     * `real` says so: segModel() no longer reports it, so nothing refuses it for being one. Under i386
     * it still has no meaning and keeps the flat placeholder, refused as before.
     *
     * `huge` needs nothing new in a 16-bit model: a PRISM far pointer is already a LINEAR address
     * whose arithmetic never wraps at 64K, which is exactly what Borland's huge pointer is for --
     * normalised arithmetic across segments, full 32-bit comparison. So it is a far pointer, marked.
     * (The converse is the known limit: a Borland FAR pointer's arithmetic wraps its offset at 64K,
     * and PRISM's does not.)
     */
    segPtr: (to, m) => (m === 'seg' && table.nearPointer
      ? { k: 'ptr', to, size: 2, align: 2, signed: false, model: 'seg', real: true }
      : m === 'huge' && table.farPointer ? { ...ptr(to, 'far'), qual: 'huge' }
        : { ...ptr(to), model: m }),
    enumType: (tag, consts) => {
      const vals = (consts ?? []).map((c) => BigInt(c.value));
      const signed = vals.some((v) => v < 0n);
      if (!table.enum.byRange) return { k: 'enum', tag, consts, ...table.enum, signed };
      /*
       * 16-bit Watcom sizes an enum by its constants: the FIRST of signed char, unsigned char, int,
       * unsigned, long, unsigned long that holds them all, signedness included. Measured with wcc
       * -mm: {1} is a signed byte, {200} an unsigned byte ((enum)300 is 44), {1000} and {-1, 200} are
       * two bytes, {40000} is unsigned, {70000} is four. This used to be one byte for every enum.
       */
      const lo = vals.reduce((m, v) => (v < m ? v : m), 0n), hi = vals.reduce((m, v) => (v > m ? v : m), 0n);
      const fits = [[1, true, -128n, 127n], [1, false, 0n, 255n], [2, true, -32768n, 32767n],
        [2, false, 0n, 65535n], [4, true, -2147483648n, 2147483647n], [4, false, 0n, 4294967295n]]
        .find(([, , min, max]) => lo >= min && hi <= max) ?? [4, true];
      return { k: 'enum', tag, consts, size: fits[0], align: Math.min(fits[0], 2), signed: fits[1] };
    },
    promote: (t) => {
      if (t.k === 'enum') return T.INT;
      if (!isInteger(t)) return t;
      if (rank(t) >= 3) return t;
      /*
       * A sub-int type promotes to `int` when int can hold every one of its values, and to
       * `unsigned int` when it cannot. The old body returned int outright with the note "on i386
       * every sub-int type fits" -- true there, and exactly what dos16 breaks: its int is 2 bytes,
       * so `unsigned short` is 16 bits going into a 16-bit signed int and does not fit.
       */
      return t.size < T.INT.size || t.signed ? T.INT : T.UINT;
    },
    usualArith: (a, b) => {
      if (isFloat(a) || isFloat(b)) return rank(a) >= rank(b) ? (isFloat(a) ? a : b) : (isFloat(b) ? b : a);
      a = T.promote(a); b = T.promote(b);
      if (a.name === b.name) return a;
      if (rank(a) === rank(b)) return isUnsigned(a) ? a : b;
      const [hi, lo] = rank(a) > rank(b) ? [a, b] : [b, a];
      if (isUnsigned(hi)) return hi;
      if (!isUnsigned(lo)) return hi;
      // A signed type wins only if it can represent every value of the smaller unsigned one; on
      // i386 `long` and `int` are both 32 bits, so `long` cannot hold all of `unsigned int`.
      if (hi.size > lo.size) return hi;
      return scalar('unsigned ' + hi.name.replace('unsigned ', ''));
    },
    decay: (t) => {
      if (t.k === 'array') return ptr(t.of);
      if (t.k === 'func') return ptr(t);
      return t;
    },
    INT: scalar('int'), CHAR: scalar('char'), UINT: scalar('unsigned int'),
    LONG: scalar('long'), ULONG: scalar('unsigned long'), DOUBLE: scalar('double'),
    SHORT: scalar('short'), USHORT: scalar('unsigned short'),
    SCHAR: scalar('signed char'), UCHAR: scalar('unsigned char'), FLOAT: scalar('float'),
  };
  if (table['long long']) {
    T.LLONG = scalar('long long');
    T.ULLONG = scalar('unsigned long long');
  }
  return T;
}

/** The one every call site still reaches for, until the second half threads a model to them. */
const I386 = makeTypes('i386');

export const { scalar, INT, CHAR, UINT, LONG, ULONG, LLONG, ULLONG, DOUBLE } = I386;
/*
 * The narrow scalars and float. `scalar()` has always known these spellings; only the named exports
 * were missing -- and a missing export reads as `undefined` rather than raising anything. Two
 * environments were already writing T.SHORT, T.USHORT and T.UCHAR in their builtin tables, nine
 * entries across src/env/sdl2.js and src/env/allegro.js, and every one of them recorded a return
 * type of `undefined`. Nothing complained until a program used such a result inside an expression:
 * `SDL_JoystickGetAxis(joys[3], 0) < -3200` reached decay() with no type to decay.
 */
export const { SHORT, USHORT, SCHAR, UCHAR, FLOAT } = I386;

export const { ptr } = I386;

/**
 * A pointer that only has a meaning in a 16-bit SEGMENTED model: Borland's `_seg` (a segment and
 * nothing else) and `huge` (a normalised segment:offset). The parser accepts them so a 16-bit
 * program can be surveyed, and marks the pointer with `model`; it keeps the flat size of 4 only
 * because every existing path expects a pointer to have one.
 *
 * That size is a placeholder and must never reach an answer. It is not left undefined, because
 * struct layout reads an undefined size as a FLEXIBLE member of size 0 (abi.js) and would shift
 * every later field without a word. Instead, anything that would compute with it asks segModel()
 * first and refuses by name.
 */
export const { segPtr } = I386;

/** The first segmented-model pointer reachable from `t`, or null. Follows members and signatures. */
export function segModel(t, seen = new Set()) {
  if (!t || typeof t !== 'object' || seen.has(t)) return null;
  seen.add(t);
  switch (t.k) {
    case 'ptr': return (t.real ? null : t.model) ?? segModel(t.to, seen);
    case 'array': return segModel(t.of, seen);
    case 'func':
      return segModel(t.ret, seen) ?? (t.params ?? []).reduce((m, p) => m ?? segModel(p.type, seen), null);
    case 'struct': case 'union':
      return (t.fields ?? []).reduce((m, f) => m ?? segModel(f.type, seen), null);
    default: return null;
  }
}

export const array = (of, n) => ({
  k: 'array', of, n,
  // An incomplete array (`[]`) has no size. Callers that need one must complete it first.
  size: n === null ? null : of.size * n,
  align: of.align,
});

export const func = (ret, params, { variadic = false, oldStyle = false } = {}) =>
  ({ k: 'func', ret, params, variadic, oldStyle, size: 1, align: 1 });

/**
 * An enum is an `int` that carries its constants — but its SIGNEDNESS follows them. An enum whose
 * enumerators are all non-negative is unsigned, which is only observable through a bitfield:
 * `enum e code : 8` holding 150 must read back as 150, not sign-extend to -106. C leaves the choice
 * to the implementation and gcc chooses unsigned, so a program switching on such a field depends on
 * it (c-testsuite 00218).
 */
export const { enumType } = I386;

/**
 * Build a struct or union type. `members` are {name, type, bits?}; layout comes straight from
 * abi.js so there is exactly one place that knows the i386 rules.
 */
export function record(kind, tag, members, { packed = false, maxAlign = null } = {}) {
  const lay = (kind === 'union' ? layoutUnion : layoutStruct)(members, { packed, maxAlign });
  return { k: kind, tag, ...lay, complete: true };
}

/** A tag referenced before it is defined: `struct foo *p;` with no definition in sight. */
export const incompleteRecord = (kind, tag) =>
  ({ k: kind, tag, size: null, align: null, fields: [], byName: {}, complete: false });

/**
 * Raise a type's alignment, as `__attribute__((aligned(N)))` does. A RECORD's size grows with its
 * alignment; a scalar's does not — `sizeof(int __attribute__((aligned(16))))` is still 4.
 */
export const withAlign = (t, n) => {
  if (!n || n <= (t.align ?? 1)) return t;
  const out = { ...t, align: n };
  if ((t.k === 'struct' || t.k === 'union') && out.size != null) out.size = Math.ceil(out.size / n) * n;
  return out;
};

/**
 * Set a type's alignment EXACTLY, including downwards. Needed because a member-level `packed`
 * lowers alignment to 1 and a following `aligned(N)` then raises it — observed:
 * `double d __attribute__((aligned(2),packed))` sits at offset 2, not 4.
 */
export const withExactAlign = (t, n) => (n && n !== t.align ? { ...t, align: n } : t);

/*
 * Qualifying a RECORD returns the same object, because a record's identity is its tag and completion
 * happens IN PLACE. Cloning it broke every mutually-referential pair that used a qualified pointer:
 *
 *     struct A { const struct B *p; };     // takes a reference to an incomplete B, and CLONES it
 *     struct B { int v; };                 // completes the original -- the clone stays empty
 *
 * so `a->p->v` reported "'struct B' has no member 'v'". SQLite's sqlite3_file holds exactly that
 * (`const struct sqlite3_io_methods *pMethods`), and the same shape is everywhere in real C.
 *
 * This is safe only because `cv` is recorded and never read — nothing in the compiler consults it
 * today. When `volatile` starts to matter (it will, at tier-1), qualification has to move onto the
 * DECLARATION rather than onto the shared type object; doing it there would have avoided this bug in
 * the first place.
 */
export const qualify = (t, cv) => {
  if (!cv) return t;
  if (t.k === 'struct' || t.k === 'union') return t;
  return { ...t, cv: { ...(t.cv ?? {}), ...cv } };
};
export const unqual = (t) => (t.cv ? { ...t, cv: undefined } : t);

export const isInteger = (t) =>
  t.k === 'enum' || (t.k === 'scalar' && !isFloat(t) && t.name !== 'void');
export const isFloat = (t) =>
  t.k === 'scalar' && (t.name === 'float' || t.name === 'double' || t.name === 'long double');
export const isArith = (t) => isInteger(t) || isFloat(t);
export const isScalarType = (t) => isArith(t) || t.k === 'ptr';
export const isRecord = (t) => t.k === 'struct' || t.k === 'union';

/**
 * A GNU/C99 complex type, `_Complex double`.
 *
 * It IS a two-member struct here -- `{ __real, __imag }` -- so storage, copies, passing by value,
 * returning through the hidden pointer and initialisation all work through the paths records
 * already use, and the layout is right by construction: 16 bytes for a complex double, its parts at
 * 0 and 8. Only the arithmetic is new, and `complexOf` is how the emitter recognises it.
 */
export const complex = (of) => ({
  ...record('struct', `_Complex ${of.name}`, [{ name: '__real', type: of }, { name: '__imag', type: of }]),
  complexOf: of,
});
export const isComplex = (t) => !!t?.complexOf;

/** Rank for the usual arithmetic conversions. */
const RANK = {
  '_Bool': 0, 'char': 1, 'signed char': 1, 'unsigned char': 1,
  'short': 2, 'unsigned short': 2,
  'int': 3, 'unsigned int': 3, 'long': 4, 'unsigned long': 4,
  'long long': 5, 'unsigned long long': 5,
  'float': 6, 'double': 7, 'long double': 8,
};
export const rank = (t) => (t.k === 'enum' ? 3 : RANK[t.name] ?? 3);
export const isUnsigned = (t) => t.k === 'scalar' && !t.signed && !isFloat(t);

/*
 * promote, usualArith and decay live in the factory above: they are the three helpers that READ the
 * model rather than merely passing types around, and a caller holding a dos16 instance has to get
 * dos16 answers from them. These names stay exported as the i386 instance's, which is what every
 * call site outside this file still means.
 */
export const { promote, usualArith, decay } = I386;

export function typeName(t) {
  if (!t) return '<none>';
  switch (t.k) {
    case 'void': return 'void';
    case 'scalar': return t.name;
    case 'enum': return `enum ${t.tag ?? '<anon>'}`;
    case 'struct': case 'union': return `${t.k} ${t.tag ?? '<anon>'}`;
    case 'ptr': return `${typeName(t.to)} *`;
    case 'array': return `${typeName(t.of)}[${t.n ?? ''}]`;
    case 'func': return `${typeName(t.ret)}(${t.params.map(p => typeName(p.type)).join(', ')}${t.variadic ? ', ...' : ''})`;
  }
  return '<?>';
}

/** Lexical scope chain, holding ordinary identifiers and tags in SEPARATE namespaces (C requires it:
 *  `struct stat stat;` is legal). */
export class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.ordinary = new Map();     // name -> {kind:'typedef'|'var'|'func'|'enumconst', type, value?}
    this.tags = new Map();         // name -> type
  }
  lookup(name) {
    for (let s = this; s; s = s.parent) if (s.ordinary.has(name)) return s.ordinary.get(name);
    return null;
  }
  lookupTag(name) {
    for (let s = this; s; s = s.parent) if (s.tags.has(name)) return s.tags.get(name);
    return null;
  }
  /** A tag declared in THIS scope only — `struct S;` re-declares in an inner scope. */
  localTag(name) { return this.tags.get(name) ?? null; }
  declare(name, entry) { this.ordinary.set(name, entry); return entry; }
  declareTag(name, type) { this.tags.set(name, type); return type; }
  isTypedef(name) {
    const e = this.lookup(name);
    return !!e && e.kind === 'typedef';
  }
}
