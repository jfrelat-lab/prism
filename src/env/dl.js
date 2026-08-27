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
