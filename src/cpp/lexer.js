// lexer.js — translation phases 1 to 3.
//
//   1. physical source characters -> source character set (trigraphs, if enabled)
//   2. backslash-newline splicing
//   3. comments become whitespace; the result is decomposed into pp-tokens
//
// Phases 1 and 2 are done as a text rewrite before tokenizing, because that is the order the
// standard specifies and it is observable: `\` + newline inside an identifier joins it, and a
// trigraph can produce the `\` that then splices. Doing it during tokenization gets those wrong.

import { ID, NUM, STR, CHR, PUNCT, OTHER, EOF, tok, PUNCTUATORS, DIGRAPHS } from './token.js';

const TRIGRAPHS = {
  '=': '#', '(': '[', '/': '\\', ')': ']', "'": '^', '<': '{', '!': '|', '>': '}', '-': '~',
};

/**
 * Phase 1+2. Returns the rewritten text plus a map from rewritten offset -> original line, so
 * diagnostics still point at the line the programmer wrote.
 */
export function splice(text, { trigraphs = false } = {}) {
  /*
   * 0x1A ENDS THE FILE, before anything else looks at it.
   *
   * CP/M counted a file's length in 128-byte records, so the last record needed a byte saying where
   * the text stopped; DOS kept the convention and its compilers stopped reading there. Keen Dreams'
   * ID_US_S.c ends with one on a line of its own, and this lexer turned it into a token with an
   * empty name, which surfaced as "unexpected '' in expression" at line 188 of a file that had, as
   * far as its own compiler was concerned, already ended.
   *
   * Applied to every source and not to DOS targets alone, because 0x1A is not in C's source
   * character set: a file holding one is already outside what the standard describes, and this is
   * what the compilers that read these files did. Measured over the corpus first -- 429 files carry
   * a marker, 430 in all, and not one has a non-whitespace character after it, so there is nothing
   * here for the cut to eat. A 0x1A inside a string literal would be cut too; none exists here.
   */
  const dosEof = text.indexOf('\x1a');
  if (dosEof >= 0) text = text.slice(0, dosEof);

  // Normalize line endings first: a CRLF file must splice on `\` + CRLF too.
  text = text.replace(/\r\n?/g, '\n');

  if (trigraphs) {
    text = text.replace(/\?\?([=(/)'<!>-])/g, (m, c) => TRIGRAPHS[c]);
  }

  let out = '';
  const lineOf = [];          // lineOf[i] = 1-based original line of out[i]
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '\n') { i++; line++; continue; }   // splice
    out += c;
    lineOf.push(line);
    if (c === '\n') line++;
  }
  return { text: out, lineOf };
}

const isIdStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdCont = (c) => isIdStart(c) || (c >= '0' && c <= '9');
const isDigit = (c) => c >= '0' && c <= '9';

/**
 * Phase 3. `text` must already have been through `splice`.
 * Newlines are NOT dropped: the directive layer needs line structure, so each token carries `bol`.
 * @returns {tokens: Token[], errors: string[]}
 */
export function lex(text, { file = '<input>', lineOf = null, keepNewlines = true, spans = false } = {}) {
  const tokens = [];
  const errors = [];
  /*
   * `spans`: each token also says where it is in `text` (at, end), and the comments are listed as
   * [start, end] -- what Live C colours its editor with, so the colours are this lexer's answers and
   * not a second, approximate one's. Off, nothing changes: the preprocessor never asks.
   */
  const comments = spans ? [] : null;
  let i = 0, ws = false, bol = true;
  const N = text.length;
  const lineAt = (off) => (lineOf ? lineOf[Math.min(off, lineOf.length - 1)] : 1);

  const push = (k, v, start, raw = null) => {
    const t = tok(k, v, { ws, bol, loc: { file, line: lineAt(start) } });
    if (raw !== null && raw !== v) t.raw = raw;
    if (spans) { t.at = start; t.end = start + (raw ?? v).length; }
    tokens.push(t);
    ws = false; bol = false;
  };

  while (i < N) {
    const c = text[i];

    // --- whitespace and comments (phase 3 turns both into "there was whitespace here")
    if (c === '\n') {
      i++;
      if (keepNewlines) { bol = true; ws = false; }
      else ws = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') { i++; ws = true; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) { errors.push(`${file}:${lineAt(i)}: unterminated comment`); comments?.push([i, N]); i = N; break; }
      comments?.push([i, end + 2]);
      /*
       * A comment becomes ONE SPACE (5.1.1.2p1 phase 3), and the newlines inside it go with it. So a
       * comment never starts a line and never ends one, however many lines it spans, and `bol` is
       * left exactly as the last real newline set it. Both halves of that matter and cc agrees:
       *
       *   #define M(X) \        a multi-line comment between two continuation lines does NOT end
       *       X(one) \          the directive -- PuTTY's putty.h:130 writes its colour list that
       *       /* ...             way and expands to `F(one) F(two)`.
       *        * ... *\/ \
       *       X(two)
       *
       *   int x; /* c           and `#` after a comment that began mid-line is NOT a directive:
       *   *\/ #define Y 1        cc -E leaves `int x; #define Y 1` as text.
       *
       * Setting `bol` from the comment's own content got the first wrong and the second wrong in the
       * opposite direction. The case that motivated it -- a comment starting at the beginning of a
       * line -- needs nothing: `bol` is already true from the newline before it.
       */
      i = end + 2; ws = true; continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const from = i;
      while (i < N && text[i] !== '\n') i++;
      comments?.push([from, i]);
      ws = true; continue;
    }

    const start = i;

    // --- string and character literals, with their optional L prefix
    if (c === 'L' && (text[i + 1] === '"' || text[i + 1] === "'")) {
      const r = scanQuoted(text, i + 1, text[i + 1], file, lineAt, errors);
      push(text[i + 1] === '"' ? STR : CHR, text.slice(i, r), start);
      i = r; continue;
    }
    if (c === '"' || c === "'") {
      const r = scanQuoted(text, i, c, file, lineAt, errors);
      push(c === '"' ? STR : CHR, text.slice(i, r), start);
      i = r; continue;
    }

    // --- pp-number: digit, or `.` followed by a digit. Then digits/letters/_/. and any of
    // e+ e- E+ E- p+ p- P+ P- as a unit. `0x1p+3` and `1.2.3` are single pp-numbers.
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
      i++;
      while (i < N) {
        const d = text[i];
        if ('eEpP'.includes(d) && (text[i + 1] === '+' || text[i + 1] === '-')) { i += 2; continue; }
        if (isIdCont(d) || d === '.') { i++; continue; }
        break;
      }
      push(NUM, text.slice(start, i), start); continue;
    }

    // --- identifier
    if (isIdStart(c)) {
      while (i < N && isIdCont(text[i])) i++;
      push(ID, text.slice(start, i), start); continue;
    }

    // --- punctuator, longest match; digraphs fold to their primary spelling but keep their raw
    let matched = null;
    for (const p of PUNCTUATORS) {
      if (text.startsWith(p, i)) { matched = p; break; }
    }
    if (matched) {
      i += matched.length;
      const primary = DIGRAPHS[matched] ?? matched;
      push(PUNCT, primary, start, matched);
      continue;
    }

    // --- anything else is its own token and only an error if it reaches phase 7
    i++;
    push(OTHER, c, start);
  }

  tokens.push(tok(EOF, '', { bol: true }));
  return spans ? { tokens, errors, comments } : { tokens, errors };
}

function scanQuoted(text, i, quote, file, lineAt, errors) {
  const open = i;
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') { errors.push(`${file}:${lineAt(open)}: unterminated ${quote === '"' ? 'string' : 'character'} literal`); return i; }
    i++;
    if (c === quote) return i;
  }
  errors.push(`${file}:${lineAt(open)}: unterminated literal at end of file`);
  return i;
}

/** Convenience: phases 1-3 in one call. */
export function tokenize(source, opts = {}) {
  const { text, lineOf } = splice(source, opts);
  return lex(text, { ...opts, lineOf });
}
