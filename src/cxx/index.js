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
 *
 * ONE dialect exists: the C++98 subset src/cxx/parse.js states. `std` is there so that a target
 * SAYS what it was written in, and so that asking for a newer one is refused by name rather than
 * compiled as something it is not.
 */
const STANDARDS = new Set(['c++98', 'gnu++98', 'c++03', 'gnu++03']);
const LANGUAGES = new Set(['c', 'c++']);

/** Check a `cxx` option once, before any unit is read; throws with the reason. */
export function checkCxxOption(cxx) {
  if (cxx === undefined || cxx === null || typeof cxx === 'boolean') return;
  if (typeof cxx !== 'object') throw new Error(`compile.cxx must be true, false or an object, not ${JSON.stringify(cxx)}`);
  for (const k of Object.keys(cxx)) if (k !== 'std' && k !== 'language' && !k.startsWith('_')) throw new Error(`compile.cxx has no '${k}' (it has std and language)`);
  if (cxx.std !== undefined && !STANDARDS.has(cxx.std)) {
    throw new Error(`compile.cxx.std '${cxx.std}' is not available: PRISM's C++ front end implements a C++98 subset (${[...STANDARDS].join(', ')})`);
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

export function cxxToC(tokens, { file = 'unit.cpp', builtins = null } = {}) {
  // PRISM's own headers are C headers: their declarations have C linkage, as if in extern "C".
  const unit = parseCxx(tokens, { cLinkage: (t) => !!t?.loc?.file?.startsWith('<') });
  return lowerCxx(unit, { tag: file, builtins });
}
