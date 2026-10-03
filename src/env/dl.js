// dl.js — dlopen/dlsym over PRISM's own symbol table.
//
// A program that loads part of itself at run time is not doing something exotic; it is the ordinary
// shape of a 1997 engine with a replaceable renderer and a replaceable game. Quake II is three such
// pieces, and `linux/sys_linux.c:196` is explicit about it:
//
//     game_library = dlopen (name, RTLD_LAZY);
//     GetGameAPI = (void *)dlsym (game_library, "GetGameAPI");
//
// The refresh had an alternative -- `null/vid_null.c` is titled DIRECT LINK GLUE and calls
// `GetRefAPI` in process -- so per-module namespaces alone were enough for it. The game has no such
// file anywhere in the tree, and `null/sys_null.c:37` simply returns NULL. So this is not a
// convenience: it is the only path the program itself offers.
//
// Nothing is loaded here, because everything is already linked. What `dlopen` does is name a module,
// and what `dlsym` does is look up that module's export by the linkage name PRISM gave it --
// `game$GetGameAPI`, which has had an address since pass 1. The handle is opaque to the guest, which
// only ever hands it back.

/** Handles are small integers well clear of any pointer the guest computes. */
const HANDLE_BASE = 0x5d000000;

export function installDl(M, { modules = {}, verbose = false } = {}) {
  /*
   * soname -> module name, from the target. The names are the program's own: linux/Makefile.i386
   * builds `gamei386.$(SHLIBEXT)` and sys_linux.c asks for exactly that string.
   */
  const bySoname = new Map(Object.entries(modules).map(([so, mod]) => [base(so), mod]));
  const open = [];
  let lastError = 0;

  function base(path) { return String(path).replace(/\\/g, '/').split('/').pop().toLowerCase(); }

  const setError = (msg) => {
    lastError = M.mod.intern([...new TextEncoder().encode(msg), 0]);
  };

  const api = {
    /*
     * The path is a full one -- sys_linux.c builds `<searchpath>/gamei386.so` and tries each search
     * path in turn -- so only the last component can be matched. That is also what makes the failure
     * message honest: a miss here means no module of that name was DECLARED, not that a file is
     * absent from disk.
     */
    dlopen: (pathPtr, _flags) => {
      const path = pathPtr ? M.mod.cstr(pathPtr) : '';
      const name = bySoname.get(base(path));
      /*
       * A SYSTEM library: libGL. Quake III's linux_qgl.c dlopens libGL.so.1 and takes every gl and
       * glX entry point with dlsym, as a driver-selectable program does; the library is the GL and GLX
       * environments' functions, the same ones a direct call reaches. Windows' opengl32.dll is the
       * same thing in C (src/env/opengl32.c).
       */
      if (!name && /^libgl\.so(\.\d+)*$/.test(base(path))) {
        const h = open.length;
        open.push({ system: 'libGL.so', path });
        lastError = 0;
        return HANDLE_BASE + h;
      }
      if (!name) { setError(`no module '${base(path)}' in this program`); return 0; }
      const h = open.length;
      open.push({ module: name, path });
      lastError = 0;
      if (verbose) M.write(`[dl] opened ${path} as module '${name}'\n`);
      return HANDLE_BASE + h;
    },

    dlsym: (handle, namePtr) => {
      const entry = open[(handle | 0) - HANDLE_BASE];
      const name = M.mod.cstr(namePtr);
      if (!entry) { setError('invalid handle'); return 0; }
      if (entry.system) {
        // Exported: all of GL 1.1, as a real libGL exports it, and the glX* the environment implements.
        // A GL 1.1 entry point the environment lacks throws, naming itself, when called -- not a NULL
        // the program would call through without a word (M.glNames is gl.h's list, from gl.js). An
        // extension is absent, as from a libGL without it; none is advertised. Bound under a name of
        // the library's own, so a direct call elsewhere is never rebound by it.
        const has = typeof M.rt[name] === 'function';
        if (/^gl/.test(name) && (has || M.glNames?.has(name))) {
          const link = `${entry.system}$${name}`;
          const impl = has ? M.rt[name] : () => { throw new Error(`gl: ${name} is not implemented`); };
          const f = M.mod.funcs.get(link)?.fn ? M.mod.funcs.get(link) : M.mod.bindFunc(link, impl);
          lastError = 0;
          return f.addr;
        }
        setError(`undefined symbol: ${name}`);
        return 0;
      }
      // The linkage name a non-main module's externals were given. src/compile.js builds it the same
      // way; if that ever changes, this is the other half that has to change with it.
      const f = M.mod.funcs.get(`${entry.module}$${name}`);
      if (f) { lastError = 0; return f.addr; }
      const g = M.mod.symbols.get(`${entry.module}$${name}`);
      if (g) { lastError = 0; return g.addr; }
      setError(`undefined symbol: ${name}`);
      return 0;
    },

    // Nothing was mapped, so nothing is unmapped. The module's code stays reachable, which is also
    // true of a real dlclose whose handle count has not reached zero.
    dlclose: (handle) => { open[(handle | 0) - HANDLE_BASE] = null; return 0; },

    /** The last error, cleared by reading it, as the POSIX one is. */
    dlerror: () => { const e = lastError; lastError = 0; return e; },
  };

  Object.assign(M.rt, api);
  return { open, modules: bySoname };
}

/*
 * THE SAME ANSWER FOR WIN32, through the table src/env/win32-app.c already walks.
 *
 * A Windows program of this era loads its replaceable parts exactly as a Unix one does, with a
 * different pair of names: vid_dll.c calls LoadLibrary("ref_soft.dll") and then GetProcAddress for
 * "GetRefAPI". So the question is identical to dlopen/dlsym's and deserves the identical answer --
 * nothing is loaded, because everything is already linked; the name selects a module and the symbol
 * is looked up under the linkage name pass 1 gave it.
 *
 * WHAT THIS DOES NOT DO IS REPLACE THE C SIDE, and that is deliberate. win32-app.c already
 * implements LoadLibraryA and GetProcAddress over a table of {module, name, fn}, and its comment
 * explains why the mechanism has to be a table rather than a blanket yes:
 *
 *     "found nothing" and "no such library" have to stay different answers -- which is why
 *     LoadLibrary only admits to the modules a table covers.
 *
 * PuTTY depends on that distinction. The table was simply never filled: `prism_extra_exports` is
 * declared extern and defined nowhere, so it read as zero and every LoadLibrary returned NULL --
 * which is right for dsound.dll and fatal for the renderer. This fills it, and a target that
 * declares no modules still gets an empty table and the old behaviour exactly.
 */
export function bindWin32Exports(program, modules = {}, moduleExports = {}) {
  const M = program.M ?? program;
  const sym = (n) => M.mod.symbols.get(n)?.addr ?? 0;
  const tablePtr = sym('prism_extra_exports');
  const countPtr = sym('prism_extra_export_count');
  if (!tablePtr || !countPtr) return null;          // not a Win32 program; nothing to wire

  const cstr = (text) => M.mod.intern([...new TextEncoder().encode(text), 0]);
  const rows = [];
  for (const [name, exports] of Object.entries(moduleExports)) {
    const soname = modules[name]?.soname ?? `${name}.dll`;
    /*
     * ONE interned string per module, shared by its rows: GetProcAddress matches the handle against
     * the module field by POINTER, not by strcmp, so two copies of the same name would make a handle
     * from LoadLibrary fail to match its own exports.
     */
    const modPtr = cstr(soname);
    for (const fn of exports) {
      const f = M.mod.funcs.get(`${name}$${fn}`) ?? M.mod.funcs.get(fn);
      if (!f) continue;
      rows.push([modPtr, cstr(fn), f.addr]);
    }
  }

  const REC = 12;                                   // { const char *module; const char *name; void *fn; }
  const base = rows.length ? M.rt.malloc(REC * rows.length) : 0;
  rows.forEach(([mod, nm, fn], i) => {
    M.mod.dv.setInt32(base + i * REC + 0, mod, true);
    M.mod.dv.setInt32(base + i * REC + 4, nm, true);
    M.mod.dv.setInt32(base + i * REC + 8, fn, true);
  });
  M.mod.dv.setInt32(tablePtr, base, true);
  M.mod.dv.setInt32(countPtr, rows.length, true);
  return { count: rows.length, modules: Object.keys(moduleExports) };
}

/** The declarations, in the shape src/compile.js's BUILTINS table wants. */
export function dlBuiltins(T) {
  const P = T.ptr(T.CHAR), I = T.INT;
  return {
    dlopen: { ret: P, params: [P, I] },
    dlsym: { ret: P, params: [P, P] },
    dlclose: { ret: I, params: [P] },
    dlerror: { ret: P, params: [] },
  };
}
