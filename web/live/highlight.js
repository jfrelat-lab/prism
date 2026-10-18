// highlight.js — Live C's colours, from PRISM's own lexer.
//
// The editor stayed a bare textarea for a reason that still holds: a second, approximate C lexer in
// the page that compiles C for a living would colour wrongly where it matters. So this has no lexer.
// It asks src/cpp/lexer.js -- translation phase 3, the one the compiler runs -- for its tokens and
// comments with their places (`spans`), and the parsers for their keywords: an identifier is coloured
// as a keyword exactly when PRISM's parser would read it as one (the C parser's list, or the C++
// front end's for a .cpp file). What the lexer cannot know before the preprocessor, it is not asked:
// a directive is `#` at the start of a line and the name after it, an #include's header is the rest
// of that line. Backslash-newlines are not spliced first, so the offsets are the editor's own.

import { lex } from '../../src/cpp/lexer.js';
import { KEYWORDS } from '../../src/parse/parser.js';
import { KEYWORDS as CXX_KEYWORDS } from '../../src/cxx/parse.js';

const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/** The source as HTML: spans of class `k` (keyword), `s` (string), `c` (char), `n` (number), `m` (comment), `p` (directive). */
export function highlight(text, { cxx = false } = {}) {
  let tokens, comments;
  try { ({ tokens, comments } = lex(text, { spans: true })); } catch { return esc(text); }
  const words = cxx ? CXX_KEYWORDS : KEYWORDS;
  const marks = [];                                   // [start, end, class], in order
  for (const [a, b] of comments) marks.push([a, b, 'm']);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.at === undefined) continue;                  // EOF
    if (t.k === 'punct' && t.v === '#' && t.bol && tokens[i + 1]?.k === 'id' && !tokens[i + 1].bol) {
      const name = tokens[i + 1];
      marks.push([t.at, name.end, 'p']);
      i++;
      // #include <stdio.h> or "x.h": the header name, from `<` to its `>` or the one string token.
      const first = tokens[i + 1];
      if (name.v === 'include' && first && !first.bol && (first.v === '<' || first.k === 'str')) {
        let j = i + 1;
        if (first.v === '<') while (tokens[j + 1]?.at !== undefined && !tokens[j + 1].bol && tokens[j].v !== '>') j++;
        marks.push([first.at, tokens[j].end, 's']);
        i = j;
      }
      continue;
    }
    const cls = t.k === 'str' ? 's' : t.k === 'chr' ? 'c' : t.k === 'num' ? 'n' : t.k === 'id' && words.has(t.v) ? 'k' : null;
    if (cls) marks.push([t.at, t.end, cls]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  let html = '', at = 0;
  for (const [a, b, cls] of marks) {
    if (a < at) continue;                             // inside a comment already marked
    html += esc(text.slice(at, a)) + `<span class="${cls}">${esc(text.slice(a, b))}</span>`;
    at = b;
  }
  // A trailing newline in a <pre> is not a line: one more keeps the last line as tall as the textarea's.
  return html + esc(text.slice(at)) + '\n';
}

/*
 * THE EMITTED JAVASCRIPT. There is no JS lexer in PRISM to ask, and none is needed for this text: it
 * is PRISM's own emitter's output, regular and free of the cases that make JavaScript hard to tokenize
 * by hand (no regular-expression literals, no ASI-dependent forms). Comments, strings, numbers and
 * keywords are told apart in one pass. A large build is megabytes: the first LIMIT characters are
 * coloured and the rest is shown as it is, so the tab opens at once.
 */
const JS_WORDS = new Set(['var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'default', 'break', 'continue', 'new', 'typeof', 'instanceof', 'in', 'of', 'this',
  'throw', 'try', 'catch', 'finally', 'true', 'false', 'null', 'undefined', 'class', 'extends', 'export',
  'import', 'from', 'async', 'await', 'yield', 'delete', 'void']);
const JS_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`)|(\b(?:0x[\da-fA-F]+n?|\d+(?:\.\d+)?(?:e[-+]?\d+)?n?)\b)|([A-Za-z_$][\w$]*)/g;
const LIMIT = 300_000;
export function highlightJS(text) {
  const head = text.length > LIMIT ? text.slice(0, text.lastIndexOf('\n', LIMIT) + 1 || LIMIT) : text;
  let html = '', at = 0;
  for (const m of head.matchAll(JS_TOKEN)) {
    const cls = m[1] ? 'm' : m[2] ? 's' : m[3] ? 'n' : JS_WORDS.has(m[4]) ? 'k' : null;
    if (!cls) continue;
    html += esc(head.slice(at, m.index)) + `<span class="${cls}">${esc(m[0])}</span>`;
    at = m.index + m[0].length;
  }
  return html + esc(head.slice(at)) + esc(text.slice(head.length));
}
