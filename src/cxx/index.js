// index.js — the C++ front end's entry: preprocessed C++ tokens in, C text out.
//
// A unit is C++ by its file name, as gcc decides it (.cpp, .cc, .cxx, .C), unless the build's `cxx`
// option says otherwise (below). The C that comes out is compiled by the rest of PRISM exactly as
// a .c file is.
import { parseCxx } from './parse.js';
import { lowerCxx } from './sema.js';

export const isCxxFile = (file) => /\.(cpp|cc|cxx|c\+\+|C)$/.test(file);

/*
 * THE OPTION: `compile.cxx` in a target, or `cxx` given to compile().
 *
 *   cxx: false                      every unit is C, whatever it is called
 *   cxx: true  (or absent)          a unit is C++ by its file name, as gcc decides
 *   cxx: { std, language }          std names the dialect; language overrides the file name, as
 *                                   gcc's -x does:  { "src/foo.c": "c++", "*.inl": "c++", "*": "c" }
 *                                   -- an exact unit path first, then `*.ext`, then `*`.
 *   cxx: { compiler: "msvc" }       the program was written for Visual C++ 7.1 and leans on what it
 *                                   accepts and g++ refuses (MSVC_RULES below). "gcc" is the default.
 *   cxx: { compiler: "gcc2" }       the program was written for the g++ of the 1990s (2.7, 2.8, egcs),
 *                                   which warned where today's refuses (GCC2_RULES below).
 *   cxx: { compiler: "watcom" }     Watcom C++ 10 (1994): the same pre-standard rules as gcc2.
 *
 * ONE dialect exists: the C++98 subset src/cxx/parse.js states. `std` is there so that a target
 * SAYS what it was written in, and so that asking for a newer one is refused by name rather than
 * compiled as something it is not.
 */
const STANDARDS = new Set(['c++98', 'gnu++98', 'c++03', 'gnu++03']);
const LANGUAGES = new Set(['c', 'c++']);
const COMPILERS = new Set(['gcc', 'msvc', 'gcc2', 'gcc3', 'watcom']);
const KEYS = new Set(['std', 'language', 'compiler']);

/*
 * What Visual C++ 7.1 (2003) accepts by default and g++ refuses, as .kkrieger's player uses it
 * (fr_public, werkkzeug3_kkrieger) -- each rule where the front end applies it:
 *
 *   - its keywords: __int64 and the other sized integers, __w64, __forceinline, the calling
 *     conventions with one underscore or two, __declspec(...) -- MSVC_DEFINES, below;
 *   - a for statement's variable outlives the loop (/Zc:forScope-, the default until 2005):
 *     _viruz2.cpp's `for (sU32 pn=0; pn<posnum; pn++) ...  return pn;` -- sema-stmt.js 'for';
 *   - a reference to non-const binds a temporary (warning C4239): mainplayer.cpp passes an sU8 *
 *     to KDoc::Init(const sU8 *&) -- sema-expr.js bindRef;
 *   - a function converts to void * (kkrieger_oplist.cpp's table of handlers) -- sema-expr.js coerce;
 *   - wchar_t is unsigned short (/Zc:wchar_t-, the default until 2005): _start.cpp passes an sU16 string
 *     to ExtTextOutW -- MSVC_DEFINES.
 */
/*
 * What the g++ of the 1990s accepted with a warning and today's g++ refuses, as the programs built
 * with it rely on -- each rule where the front end applies it:
 *
 *   - a pointer to an integer type converts to a pointer to the same-sized type of the other
 *     signedness ("changes signedness"): Abuse 2.00's tcpip.hpp passes an int * to accept()'s
 *     socklen_t *, and Debian 2.0 built it -- sema-expr.js scalarConv;
 *   - a function converts to void *, as with Visual C++: Abuse's ant.c returns its own ant_ai from
 *     a void *(*)() -- sema-expr.js scalarConv;
 *   - a string literal is a char[] (the ARM's rule; the standard made it const): demo.c writes
 *     "DEMO,VERSION:2" through bFILE::write(void *, size_t) -- sema-expr.js scalarConv;
 *   - a declaration with no type is an int ("ANSI C++ forbids declaration with no type", a warning):
 *     Abuse's DOS timing.c has `static chain_on=0,chain_counter=0;` -- sema.js specType.
 *
 * Watcom C++ 10, the compiler of the 1990s DOS games, accepted the same things: compiler "watcom"
 * applies these rules too.
 */
export const MSVC_DEFINES = {
  __int64: 'long long', __int32: 'int', __int16: 'short', __int8: 'char', __w64: '', __forceinline: 'inline',
  __cdecl: '', _cdecl: '', __stdcall: '', _stdcall: '', __fastcall: '', _fastcall: '', '__declspec(x)': '',
  wchar_t: 'unsigned short',
  // an optimiser hint, which a compiler may ignore (Doom 3's Simd_Generic.cpp: __assume( count > 0 ))
  '__assume(x)': '((void)0)',
};

/** Which compiler a `cxx` option says the program was written for. */
export const cxxCompiler = (cxx) => (cxx && typeof cxx === 'object' && cxx.compiler) || 'gcc';

/** Check a `cxx` option once, before any unit is read; throws with the reason. */
export function checkCxxOption(cxx) {
  if (cxx === undefined || cxx === null || typeof cxx === 'boolean') return;
  if (typeof cxx !== 'object') throw new Error(`compile.cxx must be true, false or an object, not ${JSON.stringify(cxx)}`);
  for (const k of Object.keys(cxx)) if (!KEYS.has(k) && !k.startsWith('_')) throw new Error(`compile.cxx has no '${k}' (it has ${[...KEYS].join(', ')})`);
  if (cxx.std !== undefined && !STANDARDS.has(cxx.std)) {
    throw new Error(`compile.cxx.std '${cxx.std}' is not available: PRISM's C++ front end implements a C++98 subset (${[...STANDARDS].join(', ')})`);
  }
  if (cxx.compiler !== undefined && !COMPILERS.has(cxx.compiler)) {
    throw new Error(`compile.cxx.compiler '${cxx.compiler}' is not one PRISM knows (${[...COMPILERS].join(', ')})`);
  }
  for (const [pattern, lang] of Object.entries(cxx.language ?? {})) {
    if (!LANGUAGES.has(lang)) throw new Error(`compile.cxx.language['${pattern}'] is '${lang}': a unit is 'c' or 'c++'`);
  }
}

/**
 * The `cxx` option of a CASE-INSENSITIVE target (a DOS tree: src/target.js caseInsensitive). gcc's
 * `.C` is C++ because a Unix name keeps its case; a DOS name has none, and Watcom and Borland compile
 * HERETIC's AM_MAP.C as C. So on such a tree `*.c` is C whatever its case, unless the target's own
 * table says otherwise. Without this, the C++ front end took every unit of Heretic and Hexen.
 */
export function cxxForTarget(cxx, caseInsensitive) {
  if (!caseInsensitive || cxx === false) return cxx;
  const base = cxx && typeof cxx === 'object' ? cxx : {};
  return { ...base, language: { '*.c': 'c', ...(base.language ?? {}) } };
}

/** 'c' or 'c++' for one unit, under a `cxx` option. */
export function unitLanguage(file, cxx) {
  if (cxx === false) return 'c';
  const table = cxx && typeof cxx === 'object' ? cxx.language : null;
  if (table) {
    const path = String(file).replace(/\\/g, '/');
    for (const [pattern, lang] of Object.entries(table)) if (!pattern.startsWith('*') && (path === pattern || path.endsWith(`/${pattern}`))) return lang;
    for (const [pattern, lang] of Object.entries(table)) if (pattern.startsWith('*.') && path.toLowerCase().endsWith(pattern.slice(1).toLowerCase())) return lang;
    if (table['*']) return table['*'];
  }
  return isCxxFile(file) ? 'c++' : 'c';
}

/** What the preprocessor predefines for a C++ unit, beyond the C set (g++ -std=gnu++98). */
export const CXX_DEFINES = { __cplusplus: '199711L' };

export function cxxToC(tokens, { file = 'unit.cpp', builtins = null, compiler = 'gcc' } = {}) {
  // PRISM's own headers are C headers: their declarations have C linkage, as if in extern "C".
  const unit = parseCxx(tokens, { cLinkage: (t) => !!t?.loc?.file?.startsWith('<'), gcc3: compiler === 'gcc3' || compiler === 'gcc2' });
  const c = lowerCxx(unit, { tag: file, builtins, msvc: compiler === 'msvc', gcc2: compiler === 'gcc2' || compiler === 'watcom' });
  // The unit's `#pragma aux` routines, for the C front end: they name the function as the source does,
  // and compile.js finds its C name (the mangled one) when no C function bears it.
  return unit.auxLines.length ? `${c}\n${unit.auxLines.map((l) => `#${l}`).join('\n')}\n` : c;
}
