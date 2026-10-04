// sdl2-surface.js — SDL 2's software surfaces: formats, palettes, blits, conversions.
//
// OpenTyrian and Jump 'n Bump draw every pixel themselves and ask SDL for little more than a
// buffer. SDLPoP does not: it is a 1989 game whose drawing was rewritten as SDL blits -- paletted
// sprites with a colour key onto a 24-bit screen, 32-bit images blended by their alpha, a surface
// converted from one format to another -- so what a blit DOES is the picture. This file is that
// half of SDL: surfaces whose structs live in guest memory where the program reads them (w, h,
// pitch, pixels, format->palette), and the operations between them.
//
// It works on pixels as SDL's generic paths do -- decode to R,G,B,A, apply, encode -- for any
// format made of byte-wide channels, and for 8-bit indexed surfaces through their palette. What
// SDL keeps beside a surface and never shows the program (the colour key, the blend mode, the alpha
// modulation) is kept here beside it too.
//
// tools/gate-sdl2-surface.mjs holds it to the real SDL 2 in the oracle container.

/* SDL_Surface and SDL_PixelFormat, as src/env/headers-sdl2.js declares them. */
const S_FLAGS = 0, S_FORMAT = 4, S_W = 8, S_H = 12, S_PITCH = 16, S_PIXELS = 20, S_CLIP = 36,
      S_REFCOUNT = 56, S_SIZE = 60;
const F_FORMAT = 0, F_PALETTE = 4, F_BITS = 8, F_BYTES = 9, F_RMASK = 12, F_GMASK = 16,
      F_BMASK = 20, F_AMASK = 24, F_LOSS = 28, F_SHIFT = 32, F_REFCOUNT = 36, F_SIZE = 56;
/* SDL_Palette { int ncolors; SDL_Color *colors; Uint32 version; int refcount; } */
const P_NCOLORS = 0, P_COLORS = 4, P_VERSION = 8, P_REFCOUNT = 12, P_SIZE = 16;

export const PIXELFORMAT = {
  INDEX8: 0x13000801, RGB565: 0x15151002, RGB888: 0x16161804, BGR888: 0x16561804,
  ARGB8888: 0x16362004, ABGR8888: 0x16762004, RGB24: 0x17101803, BGR24: 0x17401803,
};
/* bits, bytes, and the four masks, for a little-endian machine. BitsPerPixel is what the real
   library reports in the struct: 32 for the two padded 24-bit formats, not the 24 their names say. */
const LAYOUT = {
  [PIXELFORMAT.INDEX8]: [8, 1, 0, 0, 0, 0],
  [PIXELFORMAT.RGB565]: [16, 2, 0xf800, 0x07e0, 0x001f, 0],
  [PIXELFORMAT.RGB888]: [32, 4, 0x00ff0000, 0x0000ff00, 0x000000ff, 0],
  [PIXELFORMAT.BGR888]: [32, 4, 0x000000ff, 0x0000ff00, 0x00ff0000, 0],
  [PIXELFORMAT.ARGB8888]: [32, 4, 0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
  [PIXELFORMAT.ABGR8888]: [32, 4, 0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000],
  [PIXELFORMAT.RGB24]: [24, 3, 0x000000ff, 0x0000ff00, 0x00ff0000, 0],
  [PIXELFORMAT.BGR24]: [24, 3, 0x00ff0000, 0x0000ff00, 0x000000ff, 0],
};
const NAME = Object.fromEntries(Object.entries(PIXELFORMAT).map(([k, v]) => [v, `SDL_PIXELFORMAT_${k}`]));

/** SDL_MasksToPixelFormatEnum, for the depths and masks a program here passes. 0 when unknown. */
export function formatFromMasks(depth, r, g, b, a) {
  r >>>= 0; g >>>= 0; b >>>= 0; a >>>= 0;
  if (depth === 8) return PIXELFORMAT.INDEX8;
  if (depth === 16 || depth === 15) return !r || r === 0xf800 ? PIXELFORMAT.RGB565 : 0;
  if (depth === 24) {
    if (!r) return PIXELFORMAT.BGR24;                     // SDL's default on a little-endian machine
    if (r === 0x00ff0000 && b === 0x000000ff) return PIXELFORMAT.BGR24;
    if (r === 0x000000ff && b === 0x00ff0000) return PIXELFORMAT.RGB24;
    return 0;
  }
  if (depth === 32) {
    if (!r) return PIXELFORMAT.RGB888;
    if (r === 0x00ff0000 && b === 0x000000ff) return a ? PIXELFORMAT.ARGB8888 : PIXELFORMAT.RGB888;
    if (r === 0x000000ff && b === 0x00ff0000) return a ? PIXELFORMAT.ABGR8888 : PIXELFORMAT.BGR888;
  }
  return 0;
}

export const BLEND = { NONE: 0, BLEND: 1, ADD: 2, MOD: 4 };

/*
 * The arithmetic of a blended pixel, where a plausible reading and the library can differ by one:
 * SDL's pixel-alpha blit moves the destination toward the source by a division that rounds toward
 * zero. Named and in one place so the gate can swap it for its near miss.
 */
export const SURFACE_RULES = {
  blend: (s, d, a) => (d + Math.trunc(((s - d) * a) / 255)) & 0xff,
  blendAlpha: (sa, da) => (sa + da - Math.trunc((sa * da) / 255)) & 0xff,
};

export function surfaceApi(M, state, { setErr, intern, cstr }) {
  const dv = () => M.mod.dv;
  const side = state.surfaceSide = new Map();        // surface -> { colorKey, blend, alphaMod }
  const shiftOf = (mask) => { let s = 0; if (mask) while (!((mask >>> s) & 1)) s++; return s; };
  const lossOf = (mask) => { let n = 0; for (let m = mask >>> shiftOf(mask); m & 1; m >>>= 1) n++; return mask ? 8 - n : 8; };

  function makePalette(ncolors) {
    const colors = M.rt.malloc(ncolors * 4);
    M.u8.fill(0xff, colors, colors + ncolors * 4);    // SDL_AllocPalette: every entry white, opaque
    const p = M.rt.malloc(P_SIZE), d = dv();
    d.setInt32(p + P_NCOLORS, ncolors, true);
    d.setUint32(p + P_COLORS, colors, true);
    d.setUint32(p + P_VERSION, 1, true);
    d.setInt32(p + P_REFCOUNT, 1, true);
    return p;
  }

  /** A PixelFormat in guest memory, because the program reads its fields. */
  function makeFormat(format) {
    format >>>= 0;
    const lay = LAYOUT[format];
    if (!lay) return 0;
    const p = M.rt.malloc(F_SIZE), d = dv();
    M.u8.fill(0, p, p + F_SIZE);
    d.setUint32(p + F_FORMAT, format, true);
    M.u8[p + F_BITS] = lay[0]; M.u8[p + F_BYTES] = lay[1];
    for (let c = 0; c < 4; c++) {
      d.setUint32(p + F_RMASK + 4 * c, lay[2 + c], true);
      M.u8[p + F_LOSS + c] = lossOf(lay[2 + c]); M.u8[p + F_SHIFT + c] = shiftOf(lay[2 + c]);
    }
    d.setInt32(p + F_REFCOUNT, 1, true);
    state.formats.set(p, { format, bpp: lay[1] });
    return p;
  }

  /* What a format pointer says, read from guest memory: the program may have built its own. */
  function fmtOf(f) {
    const d = dv();
    const r = d.getUint32(f + F_RMASK, true), g = d.getUint32(f + F_GMASK, true),
          b = d.getUint32(f + F_BMASK, true), a = d.getUint32(f + F_AMASK, true);
    return { ptr: f, format: d.getUint32(f + F_FORMAT, true), bytes: M.u8[f + F_BYTES], palette: d.getUint32(f + F_PALETTE, true),
             r, g, b, a, rs: shiftOf(r), gs: shiftOf(g), bs: shiftOf(b), as: shiftOf(a),
             rl: lossOf(r), gl: lossOf(g), bl: lossOf(b), al: lossOf(a) };
  }
  function surf(p) {
    if (!p) return null;
    const d = dv();
    return { ptr: p, w: d.getInt32(p + S_W, true), h: d.getInt32(p + S_H, true), pitch: d.getInt32(p + S_PITCH, true),
             pixels: d.getUint32(p + S_PIXELS, true), fmt: fmtOf(d.getUint32(p + S_FORMAT, true)),
             clip: { x: d.getInt32(p + S_CLIP, true), y: d.getInt32(p + S_CLIP + 4, true), w: d.getInt32(p + S_CLIP + 8, true), h: d.getInt32(p + S_CLIP + 12, true) },
             side: side.get(p) ?? { colorKey: null, blend: BLEND.NONE, alphaMod: 255 } };
  }

  const readPixel = (at, bytes) => {
    const u8 = M.u8;
    return bytes === 1 ? u8[at] : bytes === 2 ? u8[at] | (u8[at + 1] << 8)
      : bytes === 3 ? u8[at] | (u8[at + 1] << 8) | (u8[at + 2] << 16)
      : (u8[at] | (u8[at + 1] << 8) | (u8[at + 2] << 16) | (u8[at + 3] << 24)) >>> 0;
  };
  const writePixel = (at, bytes, v) => {
    const u8 = M.u8;
    u8[at] = v; if (bytes > 1) u8[at + 1] = v >>> 8; if (bytes > 2) u8[at + 2] = v >>> 16; if (bytes > 3) u8[at + 3] = v >>> 24;
  };
  /* A channel narrower than eight bits is widened by repeating its top bits, as SDL does. */
  const widen = (v, loss) => (loss ? ((v << loss) | (v >>> (8 - 2 * loss > 0 ? 8 - 2 * loss : 0))) & 0xff : v);
  const encode = (f, r, g, b, a) => ((((r >>> f.rl) << f.rs) & f.r) | (((g >>> f.gl) << f.gs) & f.g) | (((b >>> f.bl) << f.bs) & f.b) | (f.a ? ((a >>> f.al) << f.as) & f.a : 0)) >>> 0;

  /** SDL_FindColor: the palette entry nearest a colour, alpha included. */
  function nearest(pal, r, g, b, a) {
    const d = dv(), n = d.getInt32(pal + P_NCOLORS, true), colors = d.getUint32(pal + P_COLORS, true), u8 = M.u8;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const at = colors + 4 * i, dr = u8[at] - r, dg = u8[at + 1] - g, db = u8[at + 2] - b, da = u8[at + 3] - a;
      const dist = dr * dr + dg * dg + db * db + da * da;
      if (dist < bestD) { bestD = dist; best = i; if (!dist) break; }
    }
    return best;
  }
  const mapColor = (fmtPtr, r, g, b, a) => {
    const f = fmtOf(fmtPtr);
    r &= 0xff; g &= 0xff; b &= 0xff; a &= 0xff;
    if (f.palette && !f.r) return nearest(f.palette, r, g, b, a);
    return encode(f, r, g, b, a);
  };

  function createSurface(w, h, format) {
    const fmt = makeFormat(format);
    if (!fmt) return 0;
    const lay = LAYOUT[format >>> 0];
    if (lay[1] === 1) dv().setUint32(fmt + F_PALETTE, makePalette(256), true);
    w |= 0; h |= 0;
    const pitch = (w * lay[1] + 3) & ~3;               // SDL pads a surface row to four bytes
    const pixels = M.rt.malloc(Math.max(pitch * h, 1));
    M.u8.fill(0, pixels, pixels + pitch * h);
    const p = M.rt.malloc(S_SIZE), d = dv();
    M.u8.fill(0, p, p + S_SIZE);
    d.setUint32(p + S_FORMAT, fmt, true);
    d.setInt32(p + S_W, w, true); d.setInt32(p + S_H, h, true);
    d.setInt32(p + S_PITCH, pitch, true);
    d.setUint32(p + S_PIXELS, pixels, true);
    d.setInt32(p + S_CLIP + 8, w, true); d.setInt32(p + S_CLIP + 12, h, true);
    d.setInt32(p + S_REFCOUNT, 1, true);
    // A surface with an alpha channel is set up for blending from the start.
    side.set(p, { colorKey: null, blend: lay[5] ? BLEND.BLEND : BLEND.NONE, alphaMod: 255 });
    state.surfaces.set(p, { w, h, pitch, pixels, bpp: lay[1] });
    return p;
  }

  const rectOf = (p) => (p ? { x: dv().getInt32(p, true), y: dv().getInt32(p + 4, true), w: dv().getInt32(p + 8, true), h: dv().getInt32(p + 12, true) } : null);
  const putRect = (p, r) => { if (p) { const d = dv(); d.setInt32(p, r.x, true); d.setInt32(p + 4, r.y, true); d.setInt32(p + 8, r.w, true); d.setInt32(p + 12, r.h, true); } };

  /*
   * One row-by-row copy from a source rectangle to a destination of the same size (or, scaled, of
   * another), with whatever the source carries: a colour key, a blend mode, an alpha modulation.
   */
  function lowerBlit(s, sr, d, dr, opts = {}) {
    const sf = s.fmt, df = d.fmt, u8 = M.u8, view = dv();
    const key = opts.ignoreKey ? null : s.side.colorKey, blend = opts.copy ? BLEND.NONE : s.side.blend, mod = opts.copy ? 255 : s.side.alphaMod;
    const indexedSrc = !!sf.palette && !sf.r, indexedDst = !!df.palette && !df.r;
    if (indexedDst && !indexedSrc) return setErr('Blit combination not supported');
    const colors = indexedSrc ? view.getUint32(sf.palette + P_COLORS, true) : 0;
    const rgbMask = (sf.r | sf.g | sf.b) >>> 0;
    const scaled = dr.w !== sr.w || dr.h !== sr.h;
    for (let y = 0; y < dr.h; y++) {
      const sy = scaled ? Math.floor((y * sr.h) / dr.h) : y;
      let from = s.pixels + (sr.y + sy) * s.pitch + sr.x * sf.bytes;
      let to = d.pixels + (dr.y + y) * d.pitch + dr.x * df.bytes;
      // The common case, and the only one both older programs use: same layout, nothing to apply.
      if (!scaled && key === null && blend === BLEND.NONE && mod === 255 && sf.bytes === df.bytes && !indexedSrc &&
          sf.r === df.r && sf.g === df.g && sf.b === df.b && sf.a === df.a) {
        u8.copyWithin(to, from, from + dr.w * sf.bytes);
        continue;
      }
      for (let x = 0; x < dr.w; x++, to += df.bytes) {
        const at = scaled ? s.pixels + (sr.y + sy) * s.pitch + (sr.x + Math.floor((x * sr.w) / dr.w)) * sf.bytes : from + x * sf.bytes;
        const px = readPixel(at, sf.bytes);
        let r, g, b, a;
        if (indexedSrc) {
          if (key !== null && px === key) continue;
          if (indexedDst) { u8[to] = px; continue; }
          const c = colors + 4 * px;
          r = u8[c]; g = u8[c + 1]; b = u8[c + 2]; a = u8[c + 3];
        } else {
          if (key !== null && ((px & rgbMask) >>> 0) === ((key & rgbMask) >>> 0)) continue;
          r = widen((px & sf.r) >>> sf.rs, sf.rl); g = widen((px & sf.g) >>> sf.gs, sf.gl); b = widen((px & sf.b) >>> sf.bs, sf.bl);
          a = sf.a ? widen((px & sf.a) >>> sf.as, sf.al) : 255;
        }
        if (mod !== 255) a = Math.trunc((a * mod) / 255);
        if (blend === BLEND.NONE) { writePixel(to, df.bytes, encode(df, r, g, b, a)); continue; }
        const dp = readPixel(to, df.bytes);
        const dR = widen((dp & df.r) >>> df.rs, df.rl), dG = widen((dp & df.g) >>> df.gs, df.gl), dB = widen((dp & df.b) >>> df.bs, df.bl);
        const dA = df.a ? widen((dp & df.a) >>> df.as, df.al) : 255;
        let oR, oG, oB, oA = dA;
        if (blend === BLEND.BLEND) {
          oR = SURFACE_RULES.blend(r, dR, a); oG = SURFACE_RULES.blend(g, dG, a); oB = SURFACE_RULES.blend(b, dB, a);
          oA = SURFACE_RULES.blendAlpha(a, dA);
        } else if (blend === BLEND.ADD) {
          oR = Math.min(255, dR + Math.trunc((r * a) / 255)); oG = Math.min(255, dG + Math.trunc((g * a) / 255)); oB = Math.min(255, dB + Math.trunc((b * a) / 255));
        } else {
          oR = Math.trunc((r * dR) / 255); oG = Math.trunc((g * dG) / 255); oB = Math.trunc((b * dB) / 255);
        }
        writePixel(to, df.bytes, encode(df, oR, oG, oB, oA));
      }
    }
    return 0;
  }

  /* SDL_UpperBlit's clipping, transcribed: the source rectangle to the source, the destination to
     its clip rectangle, and the rectangle actually drawn written back for the caller to read. */
  function upperBlit(src, srcrect, dst, dstrect) {
    const s = surf(src), d = surf(dst);
    if (!s || !d) return setErr('SDL_UpperBlit: passed a NULL surface');
    const out = rectOf(dstrect) ?? { x: 0, y: 0, w: 0, h: 0 };
    let sx = 0, sy = 0, w = s.w, h = s.h;
    const sr = rectOf(srcrect);
    if (sr) {
      sx = sr.x; sy = sr.y; w = sr.w; h = sr.h;
      if (sx < 0) { w += sx; out.x -= sx; sx = 0; }
      if (w > s.w - sx) w = s.w - sx;
      if (sy < 0) { h += sy; out.y -= sy; sy = 0; }
      if (h > s.h - sy) h = s.h - sy;
    }
    const c = d.clip;
    let dx = c.x - out.x;
    if (dx > 0) { w -= dx; out.x += dx; sx += dx; }
    dx = out.x + w - c.x - c.w;
    if (dx > 0) w -= dx;
    let dy = c.y - out.y;
    if (dy > 0) { h -= dy; out.y += dy; sy += dy; }
    dy = out.y + h - c.y - c.h;
    if (dy > 0) h -= dy;
    if (w > 0 && h > 0) {
      out.w = w; out.h = h;
      putRect(dstrect, out);
      return lowerBlit(s, { x: sx, y: sy, w, h }, d, out);
    }
    out.w = 0; out.h = 0;
    putRect(dstrect, out);
    return 0;
  }

  /** SDL_ConvertSurface: the same picture in another format, with what SDL carries across. */
  function convert(src, format, palettePtr = 0) {
    const s = surf(src);
    if (!s) return 0;
    const out = createSurface(s.w, s.h, format);
    if (!out) { setErr(`Unknown pixel format 0x${(format >>> 0).toString(16)}`); return 0; }
    const d = surf(out), view = dv();
    const srcIndexed = !!s.fmt.palette && !s.fmt.r, dstIndexed = d.fmt.bytes === 1;
    if (dstIndexed) {
      const from = palettePtr || (srcIndexed ? s.fmt.palette : 0);
      if (!srcIndexed || !from) { setErr('Blit combination not supported'); return 0; }
      const n = Math.min(view.getInt32(from + P_NCOLORS, true), 256), a = view.getUint32(from + P_COLORS, true), b = view.getUint32(d.fmt.palette + P_COLORS, true);
      M.u8.copyWithin(b, a, a + 4 * n);
    }
    /*
     * A paletted source with a colour key, going to a format with an alpha channel: SDL makes the
     * keyed entry transparent for the copy, so the key becomes alpha 0 and nothing is left to key.
     * Going to a format WITHOUT alpha, the key is carried across as the converted pixel value.
     */
    const key = s.side.colorKey;
    lowerBlit(s, { x: 0, y: 0, w: s.w, h: s.h }, d, { x: 0, y: 0, w: s.w, h: s.h }, { copy: true, ignoreKey: true });
    const o = side.get(out);
    o.alphaMod = s.side.alphaMod;
    if (key !== null) {
      if (d.fmt.a && !dstIndexed) {
        const rgbMask = (s.fmt.r | s.fmt.g | s.fmt.b) >>> 0;
        for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
          const px = readPixel(s.pixels + y * s.pitch + x * s.fmt.bytes, s.fmt.bytes);
          if (srcIndexed ? px === key : ((px & rgbMask) >>> 0) === ((key & rgbMask) >>> 0)) {
            const at = d.pixels + y * d.pitch + x * d.fmt.bytes;
            writePixel(at, d.fmt.bytes, (readPixel(at, d.fmt.bytes) & ~d.fmt.a) >>> 0);
          }
        }
        o.blend = BLEND.BLEND;
      } else if (dstIndexed) o.colorKey = key;
      else {
        let r, g, b;
        if (srcIndexed) { const c = view.getUint32(s.fmt.palette + P_COLORS, true) + 4 * key; r = M.u8[c]; g = M.u8[c + 1]; b = M.u8[c + 2]; }
        else { r = widen((key & s.fmt.r) >>> s.fmt.rs, s.fmt.rl); g = widen((key & s.fmt.g) >>> s.fmt.gs, s.fmt.gl); b = widen((key & s.fmt.b) >>> s.fmt.bs, s.fmt.bl); }
        o.colorKey = encode(d.fmt, r, g, b, 0);
      }
    }
    if (!d.fmt.a) o.blend = s.side.blend;
    else if (s.fmt.a || s.side.blend === BLEND.BLEND || key !== null) o.blend = BLEND.BLEND;
    else o.blend = BLEND.NONE;
    return out;
  }

  const api = {
    SDL_CreateRGBSurface: (_flags, w, h, depth, r, g, b, a) => {
      const format = formatFromMasks(depth | 0, r, g, b, a);
      if (!format) { setErr('Unknown pixel format'); return 0; }
      return createSurface(w, h, format);
    },
    SDL_FreeSurface: (p) => {
      if (!state.surfaces.has(p)) return;
      const d = dv(), fmt = d.getUint32(p + S_FORMAT, true);
      M.rt.free(d.getUint32(p + S_PIXELS, true));
      state.formats.delete(fmt);
      M.rt.free(fmt);
      M.rt.free(p);
      state.surfaces.delete(p); side.delete(p);
    },
    SDL_FillRect: (dst, rect, color) => {
      const s = surf(dst);
      if (!s) return setErr('SDL_FillRect(): Passed NULL destination surface');
      // The rectangle, intersected with the surface's clip rectangle.
      const r = rectOf(rect) ?? { x: 0, y: 0, w: s.w, h: s.h }, c = s.clip;
      const x0 = Math.max(r.x, c.x), y0 = Math.max(r.y, c.y), x1 = Math.min(r.x + r.w, c.x + c.w), y1 = Math.min(r.y + r.h, c.y + c.h);
      const bytes = s.fmt.bytes;
      for (let y = y0; y < y1; y++) {
        let at = s.pixels + y * s.pitch + x0 * bytes;
        for (let x = x0; x < x1; x++, at += bytes) writePixel(at, bytes, color);
      }
      return 0;
    },
    SDL_UpperBlit: upperBlit,
    SDL_UpperBlitScaled: (src, srcrect, dst, dstrect) => {
      const s = surf(src), d = surf(dst);
      if (!s || !d) return setErr('SDL_UpperBlitScaled: passed a NULL surface');
      const sr = rectOf(srcrect) ?? { x: 0, y: 0, w: s.w, h: s.h }, dr = rectOf(dstrect) ?? { x: 0, y: 0, w: d.w, h: d.h };
      // Whole rectangles inside both surfaces are what is asked for here; a partial one is refused
      // rather than stretched by a rule nobody checked.
      if (sr.x < 0 || sr.y < 0 || sr.x + sr.w > s.w || sr.y + sr.h > s.h || dr.x < 0 || dr.y < 0 || dr.x + dr.w > d.w || dr.y + dr.h > d.h) {
        return setErr('SDL_BlitScaled: a rectangle that needs clipping is not supported');
      }
      return lowerBlit(s, sr, d, dr);
    },
    SDL_SetClipRect: (p, rect) => {
      const s = surf(p);
      if (!s) return 0;
      const r = rectOf(rect) ?? { x: 0, y: 0, w: s.w, h: s.h };
      const x0 = Math.max(r.x, 0), y0 = Math.max(r.y, 0), x1 = Math.min(r.x + r.w, s.w), y1 = Math.min(r.y + r.h, s.h);
      const ok = x1 > x0 && y1 > y0;
      putRect(p + S_CLIP, ok ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: x0, y: y0, w: 0, h: 0 });
      return ok ? 1 : 0;
    },
    SDL_LockSurface: () => 0,          // software surfaces are always addressable
    SDL_UnlockSurface: () => 0,
    /*
     * The key lives beside the surface and nowhere the program can see: the palette is left as it
     * is (measured -- the keyed entry's alpha stays 255).
     */
    SDL_SetColorKey: (p, flag, key) => {
      const s = surf(p);
      if (!s) return setErr('SDL_SetColorKey: passed a NULL surface');
      const rec = side.get(p) ?? s.side;
      side.set(p, rec);
      if (flag && s.fmt.palette && !s.fmt.r && (key >>> 0) >= dv().getInt32(s.fmt.palette + P_NCOLORS, true)) return setErr('Parameter \'key\' is invalid');
      rec.colorKey = flag ? key >>> 0 : null;
      return 0;
    },
    SDL_SetSurfaceBlendMode: (p, mode) => {
      const rec = side.get(p);
      if (!rec) return setErr('SDL_SetSurfaceBlendMode: passed a NULL surface');
      if (![BLEND.NONE, BLEND.BLEND, BLEND.ADD, BLEND.MOD].includes(mode | 0)) return setErr('That operation is not supported');
      rec.blend = mode | 0;
      return 0;
    },
    SDL_SetSurfaceAlphaMod: (p, alpha) => {
      const rec = side.get(p);
      if (!rec) return setErr('SDL_SetSurfaceAlphaMod: passed a NULL surface');
      rec.alphaMod = alpha & 0xff;
      return 0;
    },
    SDL_SetSurfacePalette: (p, pal) => {
      if (!p || !pal) return setErr('SDL_SetSurfacePalette() passed a NULL parameter');
      dv().setUint32(dv().getUint32(p + S_FORMAT, true) + F_PALETTE, pal, true);
      return 0;
    },
    /*
     * The colours go into the palette the program named. They are ALSO kept on the shim as one
     * 768-byte table, which is what a host showing an 8-bit display reads.
     */
    SDL_SetPaletteColors: (pal, colors, first, n) => {
      first |= 0; n |= 0;
      if (!state.palette) state.palette = new Uint8Array(768);
      const d = dv(), have = pal ? d.getInt32(pal + P_NCOLORS, true) : 0, to = pal ? d.getUint32(pal + P_COLORS, true) : 0;
      for (let i = 0; i < n; i++) {
        const idx = first + i, at = colors + i * 4;
        if (idx < 0 || idx > 255) continue;
        state.palette[idx * 3] = M.u8[at]; state.palette[idx * 3 + 1] = M.u8[at + 1]; state.palette[idx * 3 + 2] = M.u8[at + 2];
        if (pal && idx < have) M.u8.copyWithin(to + 4 * idx, at, at + 4);
      }
      if (pal) d.setUint32(pal + P_VERSION, d.getUint32(pal + P_VERSION, true) + 1, true);
      if (state.onPalette) state.onPalette(state.palette);
      return pal && first + n > have ? -1 : 0;
    },
    SDL_AllocFormat: (format) => {
      const p = makeFormat(format);
      if (!p) setErr(`Unknown pixel format 0x${(format >>> 0).toString(16)}`);
      else if (LAYOUT[format >>> 0][1] === 1) dv().setUint32(p + F_PALETTE, makePalette(256), true);
      return p;
    },
    SDL_FreeFormat: (p) => { if (state.formats.delete(p)) M.rt.free(p); },
    SDL_MapRGB: (fmtPtr, r, g, b) => mapColor(fmtPtr, r, g, b, 255),
    SDL_MapRGBA: (fmtPtr, r, g, b, a) => mapColor(fmtPtr, r, g, b, a),
    SDL_GetPixelFormatName: (f) => intern(NAME[f >>> 0] ?? 'SDL_PIXELFORMAT_UNKNOWN'),
    SDL_ConvertSurfaceFormat: (src, format, _flags) => convert(src, format >>> 0),
    SDL_ConvertSurface: (src, fmt, _flags) => (fmt ? convert(src, dv().getUint32(fmt + F_FORMAT, true), dv().getUint32(fmt + F_PALETTE, true)) : 0),
  };
  void cstr;
  return { api, createSurface, surf, makeFormat, readPixel, writePixel, LAYOUT };
}

export function surfaceBuiltins(T) {
  const P = T.ptr(T.CHAR), I = T.INT, U = T.UINT, V = T.VOID, B = T.UCHAR;
  const f = (ret, ...params) => ({ ret, params });
  return {
    SDL_CreateRGBSurface: f(P, U, I, I, I, U, U, U, U), SDL_FreeSurface: f(V, P),
    SDL_FillRect: f(I, P, P, U), SDL_UpperBlit: f(I, P, P, P, P), SDL_UpperBlitScaled: f(I, P, P, P, P),
    SDL_SetClipRect: f(I, P, P), SDL_LockSurface: f(I, P), SDL_UnlockSurface: f(V, P),
    SDL_SetColorKey: f(I, P, I, U), SDL_SetSurfaceBlendMode: f(I, P, I), SDL_SetSurfaceAlphaMod: f(I, P, B),
    SDL_SetSurfacePalette: f(I, P, P), SDL_SetPaletteColors: f(I, P, P, I, I),
    SDL_AllocFormat: f(P, U), SDL_FreeFormat: f(V, P),
    SDL_MapRGB: f(U, P, B, B, B), SDL_MapRGBA: f(U, P, B, B, B, B),
    SDL_GetPixelFormatName: f(P, U),
    SDL_ConvertSurfaceFormat: f(P, P, U, U), SDL_ConvertSurface: f(P, P, P, U),
  };
}
