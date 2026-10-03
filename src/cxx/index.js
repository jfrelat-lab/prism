// index.js — the C++ front end's entry: preprocessed C++ tokens in, C text out.
//
// A unit is C++ by its file name, as gcc decides it (.cpp, .cc, .cxx, .C). The C that comes out is
// compiled by the rest of PRISM exactly as a .c file is.
import { parseCxx } from './parse.js';
import { lowerCxx } from './sema.js';

export const isCxxFile = (file) => /\.(cpp|cc|cxx|c\+\+|C)$/.test(file);

/** What the preprocessor predefines for a C++ unit, beyond the C set (g++ -std=gnu++98). */
export const CXX_DEFINES = { __cplusplus: '199711L' };

export function cxxToC(tokens, { file = 'unit.cpp' } = {}) {
  // PRISM's own headers are C headers: their declarations have C linkage, as if in extern "C".
  const unit = parseCxx(tokens, { cLinkage: (t) => !!t?.loc?.file?.startsWith('<') });
  return lowerCxx(unit, { tag: file });
}
