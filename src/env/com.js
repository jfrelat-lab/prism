// com.js — COM interfaces for PRISM's headers, written once and expanded into both shapes.
//
// An interface is a table: its base, then `ret Name(params)` for each method after the base's, in
// the SDK header's order. From it come the C++ shape (a struct of pure virtual methods deriving from
// its base: `p->Method(...)` is a virtual call) and the C shape (a struct holding a pointer to a table
// of function pointers, `This` first, the base's methods included). The two lay out the same -- the
// table pointer first, then the methods in order -- so an object an environment builds in C is called
// from C++ unchanged (src/env/d3d9.c, src/env/dsound.c).

/** A method line split into its return type, name and parameters. */
const parse = (m) => {
  const r = /^(.*?)\s+(\w+)\((.*)\)$/.exec(m);
  if (!r) throw new Error(`com.js: not a method: ${m}`);
  return { ret: r[1], fn: r[2], params: r[3] };
};

/** Lines of a template, trimmed, blank ones dropped. */
export const methods = (s) => s.trim().split('\n').map((l) => l.trim()).filter(Boolean);

const UNKNOWN = ['HRESULT QueryInterface(REFIID riid, void **ppvObj)', 'ULONG AddRef()', 'ULONG Release()'];

/** Every method of `name`, its bases' first, as written. */
function flat(ifaces, name) {
  if (name === 'IUnknown') return UNKNOWN;
  if (!ifaces[name]) throw new Error(`com.js: no interface ${name}`);
  return [...flat(ifaces, ifaces[name][0]), ...ifaces[name][1]];
}

/** The method names of `name`, in table order. */
export const methodNames = (ifaces, name) => flat(ifaces, name).map((m) => parse(m).fn);

/** C declarations of every interface: the typedefs first, so one may name another before its body. */
export function comDeclarations(ifaces) {
  const typedefs = Object.keys(ifaces).map((n) => `typedef struct ${n} ${n}, *LP${n.slice(1).toUpperCase()}, *P${n.slice(1).toUpperCase()};`);
  const bodies = Object.entries(ifaces).map(([name, [base, ms]]) => {
    const cxx = ms.map((m) => { const { ret, fn, params } = parse(m); return `    virtual ${ret} STDMETHODCALLTYPE ${fn}(${params || 'void'}) = 0;`; });
    const c = flat(ifaces, name).map((m) => { const { ret, fn, params } = parse(m); return `    ${ret} (STDMETHODCALLTYPE *${fn})(${name} *This${params ? `, ${params}` : ''});`; });
    // the SDK's C call macros, IDirect3D9_CreateDevice(p, a, ...) for (p)->lpVtbl->CreateDevice(p, a, ...)
    const calls = flat(ifaces, name).map((m) => {
      const { fn, params } = parse(m), args = params ? params.split(',').map((_, k) => `, ${String.fromCharCode(97 + k)}`).join('') : '';
      return `#define ${name}_${fn}(p${args}) (p)->lpVtbl->${fn}(p${args})`;
    });
    return `#ifdef __cplusplus\nstruct ${name} : public ${base}\n{\n${cxx.join('\n')}\n};\n#else\nstruct ${name}Vtbl\n{\n${c.join('\n')}\n};\nstruct ${name} { struct ${name}Vtbl *lpVtbl; };\n${calls.join('\n')}\n#endif`;
  });
  return `${typedefs.join('\n')}\n${bodies.join('\n\n')}`;
}
