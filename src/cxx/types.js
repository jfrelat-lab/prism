// types.js — the C++ front end's types, their identity, their mangling, and their spelling in C.
//
// Layout is NOT computed here. The front end lowers C++ to C text and lets the C compiler lay the
// structs out, so a size is always written `sizeof(struct X)` and never a number: one layout engine,
// the one every C gate already holds to gcc.
//
//   { k:'void' }  { k:'prim', name }  { k:'ptr', to }  { k:'ref', to }  { k:'array', of, n }
//   { k:'func', ret, params:[type], variadic, thisConst }  { k:'class', cls }  { k:'enum', en }
//   { k:'memptr', cls, to }  a pointer to a member function of cls: in C, a pointer to a function
//                         that takes the object first (a virtual one is reached through a thunk)
// Any of them may carry `c: true` (const). A reference never does; its referent may.

export const VOID = { k: 'void' };
const prims = new Map();
export const prim = (name) => { let t = prims.get(name); if (!t) prims.set(name, t = { k: 'prim', name }); return t; };
export const INT = prim('int'), UINT = prim('unsigned int'), CHAR = prim('char'), BOOL = prim('bool');
export const LONG = prim('long'), ULONG = prim('unsigned long'), FLOAT = prim('float'), DOUBLE = prim('double');
export const ptr = (to) => ({ k: 'ptr', to });
export const ref = (to) => ({ k: 'ref', to });
export const array = (of, n) => ({ k: 'array', of, n });
export const func = (ret, params, variadic = false, thisConst = false) => ({ k: 'func', ret, params, variadic, thisConst });
export const cst = (t) => (t.c || t.k === 'ref' ? t : { ...t, c: true });
export const uncst = (t) => (t.c ? (({ c, ...rest }) => rest)(t) : t);

const RANK = { bool: 0, char: 1, 'signed char': 1, 'unsigned char': 1, short: 2, 'unsigned short': 2, int: 3,
  'unsigned int': 3, long: 4, 'unsigned long': 4, 'long long': 5, 'unsigned long long': 5 };
const FLOATS = new Set(['float', 'double', 'long double']);
export const isFloat = (t) => t.k === 'prim' && FLOATS.has(t.name);
export const isInteger = (t) => (t.k === 'prim' && !FLOATS.has(t.name)) || t.k === 'enum';
export const isArith = (t) => t.k === 'prim' || t.k === 'enum';
export const isClass = (t) => t.k === 'class';
export const isPtr = (t) => t.k === 'ptr';
export const isScalar = (t) => isArith(t) || isPtr(t);
export const isUnsigned = (t) => t.k === 'prim' && (t.name.startsWith('unsigned') || t.name === 'bool');
export const intRank = (t) => (t.k === 'enum' ? 3 : RANK[t.name] ?? 3);

/** Identity, const included at every level unless `top` is false for the outermost. */
export function same(a, b, { top = true } = {}) {
  if (a === b) return true;
  if (a.k !== b.k) return false;
  if (top && !!a.c !== !!b.c) return false;
  switch (a.k) {
    case 'void': return true;
    case 'prim': return a.name === b.name;
    case 'ptr': case 'ref': return same(a.to, b.to);
    case 'array': return same(a.of, b.of) && (a.n === b.n || a.n == null || b.n == null);
    case 'class': return a.cls === b.cls;
    case 'enum': return a.en === b.en;
    case 'tvalue': return a.value === b.value;
    case 'memptr': return a.cls === b.cls && same(a.to, b.to);
    case 'func':
      return same(a.ret, b.ret) && a.variadic === b.variadic && a.params.length === b.params.length
        && a.params.every((p, i) => same(p, b.params[i], { top: false }));
    default: return false;
  }
}

/** The integral promotion of an arithmetic type, and the usual arithmetic conversions of two. */
export function promote(t) {
  if (t.k === 'enum') return t.en.unsigned ? UINT : INT;
  if (isFloat(t)) return uncst(t);
  return intRank(t) < 3 ? INT : uncst(t);
}
export function usual(a, b) {
  a = promote(a); b = promote(b);
  for (const f of ['long double', 'double', 'float']) if (a.name === f || b.name === f) return prim(f);
  const ra = intRank(a), rb = intRank(b);
  if (ra !== rb) return ra > rb ? a : b;
  return isUnsigned(a) ? a : b;
}

/** A readable name, for messages. */
export function show(t) {
  const c = t.c ? 'const ' : '';
  switch (t.k) {
    case 'void': return `${c}void`;
    case 'prim': return c + t.name;
    case 'ptr': return `${show(t.to)} *${t.c ? ' const' : ''}`;
    case 'ref': return `${show(t.to)} &`;
    case 'array': return `${show(t.of)} [${t.n ?? ''}]`;
    case 'class': return c + t.cls.name;
    case 'enum': return c + (t.en.name ?? 'enum');
    case 'func': return `${show(t.ret)} (${t.params.map(show).join(', ')}${t.variadic ? ', ...' : ''})`;
    case 'tvalue': return String(t.value);
    case 'memptr': return `${show(t.to.ret)} (${t.cls.name}::*)(${t.to.params.map(show).join(', ')})`;
    default: return '?';
  }
}

const PRIM_CODE = { bool: 'b', char: 'c', 'signed char': 'a', 'unsigned char': 'h', short: 's', 'unsigned short': 't',
  int: 'i', 'unsigned int': 'j', long: 'l', 'unsigned long': 'm', 'long long': 'x', 'unsigned long long': 'y',
  float: 'f', double: 'd', 'long double': 'e' };
/** A type as part of a C identifier (the Itanium letters, which need no escaping). */
export function mangle(t) {
  const c = t.c ? 'K' : '';
  switch (t.k) {
    case 'void': return `${c}v`;
    case 'prim': return c + PRIM_CODE[t.name];
    case 'ptr': return `${c}P${mangle(t.to)}`;
    case 'ref': return `R${mangle(t.to)}`;
    case 'array': return `A${t.n ?? ''}_${mangle(t.of)}`;
    case 'class': return `${c}${t.cls.cname.length}${t.cls.cname}`;
    case 'enum': return `${c}${t.en.cname.length}${t.en.cname}`;
    case 'func': return `F${mangle(t.ret)}${t.params.map(mangle).join('')}${t.variadic ? 'z' : ''}E`;
    // A template's value argument: Itanium's L<value>E, a minus sign spelt n.
    case 'tvalue': return `Li${t.value < 0 ? `n${-t.value}` : t.value}E`;
    case 'memptr': return `${c}M${t.cls.cname.length}${t.cls.cname}${mangle(t.to)}`;
    default: throw new Error(`mangle: ${t.k}`);
  }
}

const C_PRIM = { bool: '_Bool' };
/**
 * A C declaration of `name` with this type: `int *a[3]`, `void (*f)(int)`. A reference is a pointer;
 * a class is `struct <cname>`; an enum is the integer type gcc gives it.
 */
export function cDecl(t, name = '') {
  const q = t.c && t.k !== 'ref' && t.k !== 'array' && t.k !== 'func' ? 'const ' : '';
  switch (t.k) {
    case 'void': return `${q}void${name ? ` ${name}` : ''}`;
    case 'prim': return `${q}${C_PRIM[t.name] ?? t.name}${name ? ` ${name}` : ''}`;
    case 'enum': return `${q}${t.en.unsigned ? 'unsigned int' : 'int'}${name ? ` ${name}` : ''}`;
    case 'class': return `${q}${t.cls.key === 'union' ? 'union' : 'struct'} ${t.cls.cname}${name ? ` ${name}` : ''}`;
    case 'ptr': case 'ref': {
      const inner = `*${t.c && t.k === 'ptr' ? 'const ' : ''}${name}`;
      return cDecl(t.to, t.to.k === 'array' || t.to.k === 'func' ? `(${inner})` : inner);
    }
    case 'array': return cDecl(t.of, `${name}[${t.n ?? ''}]`);
    case 'memptr': {
      const fn = { k: 'func', ret: t.to.ret, params: [ptr({ k: 'class', cls: t.cls }), ...t.to.params], variadic: t.to.variadic };
      return cDecl(fn, `(*${t.c ? 'const ' : ''}${name})`);
    }
    case 'func': {
      const ps = t.params.map((p) => cDecl(paramType(p)));
      if (t.variadic) ps.push('...');
      return cDecl(t.ret.k === 'ref' ? ptr(t.ret.to) : t.ret, `${name}(${ps.length ? ps.join(', ') : 'void'})`);
    }
    default: throw new Error(`cDecl: ${t.k}`);
  }
}
/** A parameter as C passes it: an array decays, a function becomes a pointer to it. */
export function paramType(p) {
  if (p.k === 'array') return ptr(p.of);
  if (p.k === 'func') return ptr(p);
  return p;
}
