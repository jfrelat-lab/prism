// token.js — preprocessing tokens.
//
// A pp-token is not a C token: `0x1p+3`, `1.2.3` and `..` are all single pp-numbers or punctuators
// at this stage, and only phase 7 decides whether they mean anything. Keeping the two apart is what
// lets `#define CAT(a,b) a##b` paste `1` and `e+2` into the pp-number `1e+2`.

export const ID = 'id';        // identifier or keyword — indistinguishable before phase 7
export const NUM = 'num';      // pp-number
export const STR = 'str';      // string-literal, including any L prefix
export const CHR = 'chr';      // character-constant
export const PUNCT = 'punct';  // punctuator, digraphs already folded to their primary spelling
export const HDR = 'hdr';      // header-name, only produced in #include context
export const OTHER = 'other';  // a character that is none of the above (`@`, `$`, a stray `'`)
export const EOF = 'eof';

/**
 * @param k    one of the kinds above
 * @param v    the spelling, exactly as it will be re-emitted
 * @param ws   was there whitespace before this token? (needed to re-emit and to stringize)
 * @param bol  is this the first token on a logical line? (drives directive recognition)
 * @param hs   hide set — the macros this token is "painted blue" against (Prosser's algorithm)
 */
export const tok = (k, v, { ws = false, bol = false, hs = null, loc = null } = {}) =>
  ({ k, v, ws, bol, hs, loc });

export const clone = (t, over = {}) => ({ ...t, ...over });

/** Two tokens are the same for redefinition purposes if kind, spelling and spacing agree. */
export const sameToken = (a, b) => a.k === b.k && a.v === b.v;

/** Hide sets are immutable Sets; null means empty (the common case, so avoid allocating). */
export const hsHas = (t, name) => t.hs !== null && t.hs.has(name);
export const hsAdd = (t, name) => {
  const s = new Set(t.hs ?? []);
  s.add(name);
  return clone(t, { hs: s });
};
export const hsUnion = (a, b) => {
  if (!a) return b; if (!b) return a;
  const s = new Set(a); for (const x of b) s.add(x); return s;
};
export const hsIntersect = (a, b) => {
  if (!a || !b) return null;
  const s = new Set(); for (const x of a) if (b.has(x)) s.add(x);
  return s.size ? s : null;
};

/**
 * Render a token stream back to text. Only used for diagnostics and for the gate — the compiler
 * consumes tokens, never text. A single space is inserted wherever tokens would otherwise glue
 * together, which is what `gcc -E` does too.
 */
export function render(tokens) {
  let out = '', prev = null;
  for (const t of tokens) {
    if (t.k === EOF) break;
    if (t.bol && prev) out += '\n';
    else if (t.ws && prev) out += ' ';
    else if (prev && needsSpace(prev, t)) out += ' ';
    out += t.v;
    prev = t;
  }
  return out;
}

/** Would `a` immediately followed by `b` re-lex as something else? */
function needsSpace(a, b) {
  const A = a.v, B = b.v;
  if (a.k === ID || a.k === NUM) if (b.k === ID || b.k === NUM) return true;
  if (a.k === NUM && (B[0] === '+' || B[0] === '-' || B[0] === '.')) return true;
  if (a.k !== PUNCT || b.k !== PUNCT) return false;
  // Two punctuators that would form a longer one.
  const glued = A + B;
  for (const p of PUNCTUATORS) if (p.length > A.length && p.startsWith(glued.slice(0, p.length))) return true;
  return false;
}

/** Longest-match first. Digraphs are included; the lexer folds them to their primary spelling. */
export const PUNCTUATORS = [
  '%:%:', '...', '<<=', '>>=',
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '*=', '/=', '%=', '+=', '-=', '&=', '^=', '|=', '##',
  '<:', ':>', '<%', '%>', '%:',
  '[', ']', '(', ')', '{', '}', '.', '&', '*', '+', '-', '~', '!', '/', '%',
  '<', '>', '^', '|', '?', ':', ';', '=', ',', '#',
];

export const DIGRAPHS = { '<:': '[', ':>': ']', '<%': '{', '%>': '}', '%:': '#', '%:%:': '##' };
