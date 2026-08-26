// types.js — the type system, on top of the exact i386 layout in abi.js.
//
// Types are plain objects, structurally shared where possible. Qualifiers live on the type object
// (`cv`) rather than in a wrapper, because C's qualifiers do not affect layout and a wrapper would
// have to be unwrapped at every use site.

import { SCALARS, layoutStruct, layoutUnion } from './abi.js';

export const VOID = { k: 'void', name: 'void', size: 1, align: 1 };

const scalarCache = new Map();
export function scalar(name) {
  if (name === 'void') return VOID;
  let t = scalarCache.get(name);
  if (!t) {
    const s = SCALARS[name];
    if (!s) throw new Error(`types: unknown scalar '${name}'`);
    t = { k: 'scalar', name, size: s.size, align: s.align, signed: !!s.signed };
    scalarCache.set(name, t);
  }
  return t;
}

export const INT = scalar('int');
export const CHAR = scalar('char');
export const UINT = scalar('unsigned int');
export const LONG = scalar('long');
export const ULONG = scalar('unsigned long');
export const LLONG = scalar('long long');
export const ULLONG = scalar('unsigned long long');
export const DOUBLE = scalar('double');

export const ptr = (to) => ({ k: 'ptr', to, size: 4, align: 4, signed: false });

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
export const enumType = (tag, consts) =>
  ({ k: 'enum', tag, consts, size: 4, align: 4, signed: (consts ?? []).some(c => BigInt(c.value) < 0n) });

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

/** Integer promotions: anything narrower than int becomes int (unsigned int if it cannot fit). */
export function promote(t) {
  if (t.k === 'enum') return INT;
  if (!isInteger(t)) return t;
  if (rank(t) >= 3) return t;
  // On i386 every sub-int type fits in int, including `unsigned short` (16 bits into 32).
  return INT;
}

/** Usual arithmetic conversions, the i386 instance. */
export function usualArith(a, b) {
  if (isFloat(a) || isFloat(b)) return rank(a) >= rank(b) ? (isFloat(a) ? a : b) : (isFloat(b) ? b : a);
  a = promote(a); b = promote(b);
  if (a.name === b.name) return a;
  if (rank(a) === rank(b)) return isUnsigned(a) ? a : b;
  const [hi, lo] = rank(a) > rank(b) ? [a, b] : [b, a];
  if (isUnsigned(hi)) return hi;
  if (!isUnsigned(lo)) return hi;
  // A signed type wins only if it can represent every value of the smaller unsigned one; on i386
  // `long` and `int` are both 32 bits, so `long` cannot hold all of `unsigned int`.
  if (hi.size > lo.size) return hi;
  return scalar('unsigned ' + hi.name.replace('unsigned ', ''));
}

/** Array-to-pointer and function-to-pointer decay, applied wherever a value is used. */
export function decay(t) {
  if (t.k === 'array') return ptr(t.of);
  if (t.k === 'func') return ptr(t);
  return t;
}

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
