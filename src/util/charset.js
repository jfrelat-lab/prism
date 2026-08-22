// charset.js — the ONE place that knows how a C literal's text becomes values.
//
// It exists because the same logic was needed in three unrelated files — the `#if` evaluator (for a
// character constant), the parser (to size `char s[] = "…"`), and the emitter (to lay the bytes into
// memory) — and three copies disagreed about wide literals, which is exactly how `sizeof(L"Ä")`
// came out as 12 instead of 8.
//
// Source text is handled as BYTES. gcc's default input charset is UTF-8, but a narrow literal copies
// the bytes through untouched and a real source file need not even be valid UTF-8 (gcc's
// 20000227-1.c embeds a raw 0xFF). Callers therefore read files as 'latin1', one char per byte.

/** Is this literal token wide (`L"…"` / `L'x'`)? */
export const isWideLiteral = (text) => text[0] === 'L';

const SIMPLE = {
  n: 10, t: 9, r: 13, f: 12, v: 11, b: 8, a: 7,
  '\\': 92, "'": 39, '"': 34, '?': 63, e: 27,
};

/**
 * The units a literal's contents denote, escapes resolved. For a narrow literal these are BYTES; for
 * a wide one they are wchar_t values, which means the UTF-8 the source carries has to be decoded.
 */
export function literalUnits(text, forceWide = false) {
  const wide = isWideLiteral(text) || forceWide;
  let s = text;
  if (isWideLiteral(text)) s = s.slice(1);      // the prefix goes BEFORE the quotes are stripped
  s = s.slice(1, -1);

  const out = [];
  for (let i = 0; i < s.length;) {
    if (s[i] !== '\\') {
      const cp = s.codePointAt(i);
      // A char below 256 is already one source byte and passes through; only a caller that handed
      // us decoded Unicode (above 255) needs encoding.
      if (cp < 256) { out.push(cp); i += 1; continue; }
      for (const b of new TextEncoder().encode(String.fromCodePoint(cp))) out.push(b);
      i += String.fromCodePoint(cp).length;
      continue;
    }
    i++;
    const c = s[i];
    if (c >= '0' && c <= '7') {
      let o = '';
      while (i < s.length && o.length < 3 && s[i] >= '0' && s[i] <= '7') o += s[i++];
      out.push(parseInt(o, 8) & 0xff);
      continue;
    }
    if (c === 'x') {
      i++;
      let h = '';
      while (i < s.length && /[0-9a-fA-F]/.test(s[i])) h += s[i++];
      out.push(parseInt(h, 16) & 0xff);
      continue;
    }
    if (c in SIMPLE) { out.push(SIMPLE[c]); i++; continue; }
    out.push(s.charCodeAt(i)); i++;             // an unknown escape denotes the character itself
  }

  return wide ? widenUtf8(out) : out;
}

/**
 * Decode bytes to code points when they form valid UTF-8, and leave them alone otherwise. The
 * fallback matters: a caller that already supplied code points has nothing to decode, and an
 * invalid sequence must pass through rather than become U+FFFD.
 */
export function widenUtf8(units) {
  if (units.every(u => u < 0x80)) return units;
  try {
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(Uint8Array.from(units.map(u => u & 0xff)));
    return [...text].map(c => c.codePointAt(0));
  } catch {
    return units;
  }
}

/** The byte image of a literal, with wchar_t widened to four little-endian bytes. */
export function literalBytes(text, forceWide = false) {
  const wide = isWideLiteral(text) || forceWide;
  const units = literalUnits(text, forceWide);
  if (!wide) return { bytes: units, wide, elem: 1, count: units.length };
  const bytes = [];
  for (const u of units) bytes.push(u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff);
  return { bytes, wide, elem: 4, count: units.length };
}

/** The value of a character constant. Narrow chars are signed on i386. */
export function charConstValue(text) {
  const wide = isWideLiteral(text);
  const units = literalUnits(text);
  if (units.length === 0) throw new Error('empty character constant');
  if (wide) return BigInt(units[units.length - 1]);
  if (units.length === 1) {
    const b = units[0] & 0xff;
    return BigInt(b >= 0x80 ? b - 0x100 : b);
  }
  // A multi-character constant packs big-endian into an int, which is what gcc does.
  let v = 0n;
  for (const c of units.slice(-4)) v = (v << 8n) | BigInt(c & 0xff);
  return BigInt.asIntN(32, v);
}
