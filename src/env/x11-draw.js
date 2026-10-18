// x11-draw.js — Xlib's core drawing: GCs, windows and pixmaps with pixels, the primitives, text.
//
// src/env/x11.js began as the slice of Xlib Doom's i_video.c uses, where the client draws every
// pixel into an XImage and the "server" only shows it. A textbook X program -- Rosetta Code's Xlib
// solutions, anything written from the Xlib manual -- does the opposite: it asks the SERVER to draw.
// XFillRectangle, XDrawLine, XDrawString on a window, with a GC's colours. This file is that server
// half, rasterised here because there is no server to send the requests to.
//
// The model is the one a TrueColor X server has: a pixel value is 0xRRGGBB (XBlackPixel 0,
// XWhitePixel 0xffffff, XAllocColor packs the colour it is given), and every drawable -- the window,
// each pixmap -- is a 32-bit surface in guest memory, BGRA as the page reads it (PIXFMT 32). A window
// gets its surface on the first request that draws into it, so a program that only ever XPutImages
// an 8-bit frame (Doom, Quake) never has one and is shown exactly as before.
//
// Text is the VGA ROM's 8x16 font (the one the Win32 shim rasterises with), offered as the server's
// only core font: any XLoadQueryFont name gets it, with X's metrics -- y is the BASELINE, 12 pixels
// below the top of a glyph cell. Arcs follow X's angles, 64ths of a degree counter-clockwise from 3
// o'clock; polygons fill by the even-odd rule, X's default.

/* GC function codes (X.h): what a pixel becomes, given the source and what is there. */
const GX = { clear: 0, and: 1, copy: 3, xor: 6, or: 7, set: 15 };

/* The colour names X programs actually ask for, with rgb.txt's values. */
const NAMED = {
  black: 0x000000, white: 0xffffff, red: 0xff0000, green: 0x00ff00, blue: 0x0000ff,
  yellow: 0xffff00, cyan: 0x00ffff, magenta: 0xff00ff, gray: 0xbebebe, grey: 0xbebebe,
  darkgray: 0xa9a9a9, darkgrey: 0xa9a9a9, lightgray: 0xd3d3d3, lightgrey: 0xd3d3d3,
  dimgray: 0x696969, dimgrey: 0x696969, orange: 0xffa500, purple: 0xa020f0, brown: 0xa52a2a,
  pink: 0xffc0cb, navy: 0x000080, navyblue: 0x000080, darkgreen: 0x006400, darkblue: 0x00008b,
  darkred: 0x8b0000, gold: 0xffd700, violet: 0xee82ee, maroon: 0xb03060, forestgreen: 0x228b22,
  skyblue: 0x87ceeb, steelblue: 0x4682b4, firebrick: 0xb22222, wheat: 0xf5deb3, tan: 0xd2b48c,
  salmon: 0xfa8072, coral: 0xff7f50, khaki: 0xf0e68c, orchid: 0xda70d6, turquoise: 0x40e0d0,
  limegreen: 0x32cd32, seagreen: 0x2e8b57, slategray: 0x708090, slategrey: 0x708090,
  midnightblue: 0x191970, royalblue: 0x4169e1, beige: 0xf5f5dc, ivory: 0xfffff0,
};

/*
 * XGCValues and XSetWindowAttributes field offsets, from the layouts PRISM's own <X11/Xlib.h>
 * declares (i386: int and unsigned long are 4 bytes). Changing either side alone is a silent bug.
 */
const GCV = { function: 0, foreground: 8, background: 12, line_width: 16, font: 60 };
const GC_BITS = { function: 1 << 0, foreground: 1 << 2, background: 1 << 3, line_width: 1 << 4, font: 1 << 14 };
const ATTR_BACKGROUND_PIXEL = 4, CW_BACK_PIXEL = 1 << 1;
const FONT_ID = 0x7500_0001;

export function installX11Draw(M, { font = null } = {}) {
  const dv = () => M.mod.dv;
  const gcs = new Map();          // GC id -> { fn, fg, bg, lw }
  const drawables = new Map();    // Window or Pixmap id -> { addr, w, h, bg, window }
  let nextGC = 0x7400_0001, nextPixmap = 0x7300_0001;
  let dirty = false;

  const DEFAULT_GC = 0x7400_0000;
  gcs.set(DEFAULT_GC, { fn: GX.copy, fg: 0x000000, bg: 0xffffff, lw: 0 });

  /** A drawable's pixels, made on first use: the window's background, as a server clears it. */
  function surface(id) {
    const d = drawables.get(id >>> 0);
    if (!d) return null;
    if (!d.addr) {
      d.addr = M.rt.malloc(d.w * d.h * 4);
      if (!d.addr) return null;
      pixels(d).fill(0xff000000 | d.bg);
    }
    return d;
  }
  // The view is rebuilt when the heap's buffer changes (memory growth detaches the old one).
  function pixels(d) {
    if (!d.view || d.view.buffer !== M.u8.buffer) d.view = new Uint32Array(M.u8.buffer, d.addr, d.w * d.h);
    return d.view;
  }
  const gcOf = (gc) => gcs.get(gc >>> 0) ?? gcs.get(DEFAULT_GC);

  /** A plotter for one request: clipped to the drawable, through the GC's function. */
  function plotter(id, gc) {
    const d = surface(id);
    if (!d) return null;
    if (d.window) dirty = true;
    const g = gcOf(gc), px = pixels(d), w = d.w, h = d.h, fg = g.fg & 0xffffff;
    const put = g.fn === GX.xor ? (i) => { px[i] ^= fg; }
      : g.fn === GX.clear ? (i) => { px[i] = 0xff000000; }
      : g.fn === GX.set ? (i) => { px[i] = 0xffffffff; }
      : g.fn === GX.and ? (i) => { px[i] = 0xff000000 | (px[i] & fg); }
      : g.fn === GX.or ? (i) => { px[i] |= fg; }
      : (i) => { px[i] = 0xff000000 | fg; };
    const span = (x0, x1, y) => {      // x0..x1 inclusive
      if (y < 0 || y >= h) return;
      if (x0 < 0) x0 = 0;
      if (x1 >= w) x1 = w - 1;
      for (let x = x0, i = y * w + x0; x <= x1; x++, i++) put(i);
    };
    const point = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) put(y * w + x); };
    return { d, g, px, w, h, put, span, point };
  }

  function line(p, x0, y0, x1, y1) {
    const r = p.g.lw > 1 ? p.g.lw >> 1 : 0;
    const dot = r ? (x, y) => { for (let yy = y - r; yy <= y + r; yy++) p.span(x - r, x + r, yy); } : p.point;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      dot(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** Even-odd scanline fill of a closed polygon, sampled at pixel centres. */
  function fillPolygon(p, pts) {
    if (pts.length < 3) return;
    let ymin = Infinity, ymax = -Infinity;
    for (const [, y] of pts) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    // Whole scanlines: an arc's points are not integers, and a fractional row indexes no pixel.
    for (let y = Math.max(0, Math.floor(ymin)); y <= Math.min(p.h - 1, Math.ceil(ymax)); y++) {
      const yc = y + 0.5, xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= yc) !== (by <= yc)) xs.push(ax + (yc - ay) * (bx - ax) / (by - ay));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) p.span(Math.ceil(xs[i] - 0.5), Math.ceil(xs[i + 1] - 0.5) - 1, y);
    }
  }

  /* An arc's angles: X gives a start and an EXTENT, in 64ths of a degree, counter-clockwise. */
  const arcPoint = (x, y, w, h, deg) => {
    const a = deg * Math.PI / 180;
    return [Math.round(x + w / 2 + (w / 2) * Math.cos(a)), Math.round(y + h / 2 - (h / 2) * Math.sin(a))];
  };
  function drawArc(p, x, y, w, h, a1, a2) {
    const start = a1 / 64, extent = Math.max(-360, Math.min(360, a2 / 64));
    const steps = Math.max(8, Math.ceil(Math.abs(extent) / 360 * Math.PI * (w + h)));
    let prev = arcPoint(x, y, w, h, start);
    for (let i = 1; i <= steps; i++) {
      const next = arcPoint(x, y, w, h, start + extent * i / steps);
      line(p, prev[0], prev[1], next[0], next[1]);
      prev = next;
    }
  }
  function fillArc(p, x, y, w, h, a1, a2) {
    // A pie slice (ArcPieSlice, the default arc_mode): the centre and the arc's points, as a polygon.
    const start = a1 / 64, extent = Math.max(-360, Math.min(360, a2 / 64));
    const steps = Math.max(12, Math.ceil(Math.abs(extent) / 360 * Math.PI * (w + h)));
    const pts = Math.abs(extent) >= 360 ? [] : [[x + w / 2, y + h / 2]];
    for (let i = 0; i <= steps; i++) {
      const a = (start + extent * i / steps) * Math.PI / 180;
      pts.push([x + w / 2 + (w / 2) * Math.cos(a), y + h / 2 - (h / 2) * Math.sin(a)]);
    }
    fillPolygon(p, pts);
  }

  function text(p, x, y, str, image) {
    if (image) {    // XDrawImageString: the cells' background first, in the GC's background colour
      const bg = 0xff000000 | (p.g.bg & 0xffffff);
      for (let yy = y - 12; yy < y + 4; yy++) {
        if (yy < 0 || yy >= p.h) continue;
        for (let xx = Math.max(0, x); xx < Math.min(p.w, x + 8 * str.length); xx++) p.px[yy * p.w + xx] = bg;
      }
    }
    if (!font) return;
    for (let c = 0; c < str.length; c++) {
      const glyph = str.charCodeAt(c) & 0xff;
      for (let row = 0; row < 16; row++) {
        const bits = font[glyph * 16 + row];
        if (!bits) continue;
        for (let col = 0; col < 8; col++) if (bits & (0x80 >> col)) p.point(x + c * 8 + col, y - 12 + row);
      }
    }
  }

  const str = (ptr, n) => { let s = ''; for (let i = 0; i < (n | 0); i++) s += String.fromCharCode(M.u8[ptr + i]); return s; };
  const points = (ptr, n, mode) => {      // XPoint is { short x, y }; CoordModePrevious is 1
    const out = [];
    for (let i = 0; i < (n | 0); i++) {
      let x = dv().getInt16(ptr + i * 4, true), y = dv().getInt16(ptr + i * 4 + 2, true);
      if (mode === 1 && i) { x += out[i - 1][0]; y += out[i - 1][1]; }
      out.push([x, y]);
    }
    return out;
  };
  /** X's colour specs: a name from rgb.txt, or #rgb/#rrggbb/#rrrrggggbbbb, or rgb:r/g/b. */
  function parseColor(spec) {
    const s = spec.trim().toLowerCase();
    if (s.startsWith('#')) {
      const hex = s.slice(1), n = hex.length / 3;
      if (![1, 2, 3, 4].includes(n) || /[^0-9a-f]/.test(hex)) return null;
      const part = (i) => parseInt(hex.slice(i * n, i * n + n), 16) / (16 ** n - 1);
      return [part(0), part(1), part(2)].map((v) => Math.round(v * 65535));
    }
    const m = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/.exec(s);
    if (m) return m.slice(1).map((h) => Math.round(parseInt(h, 16) / (16 ** h.length - 1) * 65535));
    const v = NAMED[s.replace(/\s+/g, '')];
    return v === undefined ? null : [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => c * 257);
  }
  /* XColor is { unsigned long pixel; unsigned short red, green, blue; char flags, pad; }. */
  function fillColor(ptr, [r, g, b]) {
    dv().setUint16(ptr + 4, r, true); dv().setUint16(ptr + 6, g, true); dv().setUint16(ptr + 8, b, true);
    dv().setUint32(ptr, ((r >> 8) << 16) | ((g >> 8) << 8) | (b >> 8), true);
    M.u8[ptr + 10] = 7;                 // DoRed | DoGreen | DoBlue
  }
  function applyGCValues(g, mask, v) {
    if (!v) return;
    if (mask & GC_BITS.function) g.fn = dv().getInt32(v + GCV.function, true);
    if (mask & GC_BITS.foreground) g.fg = dv().getUint32(v + GCV.foreground, true);
    if (mask & GC_BITS.background) g.bg = dv().getUint32(v + GCV.background, true);
    if (mask & GC_BITS.line_width) g.lw = dv().getInt32(v + GCV.line_width, true);
  }

  /* XFontStruct: ascent 12 and descent 4, every glyph 8 wide -- the VGA cell, as X would describe it. */
  let fontStruct = 0;
  function queryFont() {
    if (!font) return 0;
    if (fontStruct) return fontStruct;
    const SIZE = 80, CHARSTRUCT = 12;
    const p = M.rt.calloc(1, SIZE);
    const charStruct = (at) => {
      dv().setInt16(at, 0, true); dv().setInt16(at + 2, 8, true); dv().setInt16(at + 4, 8, true);
      dv().setInt16(at + 6, 12, true); dv().setInt16(at + 8, 4, true);
    };
    dv().setUint32(p + 4, FONT_ID, true);                  // fid
    dv().setUint32(p + 12, 0, true); dv().setUint32(p + 16, 255, true);   // min/max_char_or_byte2
    dv().setInt32(p + 28, 1, true);                         // all_chars_exist
    charStruct(p + 44); charStruct(p + 44 + CHARSTRUCT);    // min_bounds, max_bounds
    dv().setInt32(p + 72, 12, true); dv().setInt32(p + 76, 4, true);       // ascent, descent
    fontStruct = p;
    return p;
  }

  const api = {
    XDefaultGC: () => DEFAULT_GC,
    XCreateGC: (_d, _dr, mask, values) => {
      const id = nextGC++;
      const g = { fn: GX.copy, fg: 0x000000, bg: 0xffffff, lw: 0 };
      applyGCValues(g, mask >>> 0, values);
      gcs.set(id, g);
      return id;
    },
    XChangeGC: (_d, gc, mask, values) => { applyGCValues(gcOf(gc), mask >>> 0, values); return 1; },
    XFreeGC: (_d, gc) => { if ((gc >>> 0) !== DEFAULT_GC) gcs.delete(gc >>> 0); return 1; },
    XSetForeground: (_d, gc, pixel) => { gcOf(gc).fg = pixel >>> 0; return 1; },
    XSetBackground: (_d, gc, pixel) => { gcOf(gc).bg = pixel >>> 0; return 1; },
    XSetFunction: (_d, gc, fn) => { gcOf(gc).fn = fn | 0; return 1; },
    XSetLineAttributes: (_d, gc, width) => { gcOf(gc).lw = width | 0; return 1; },
    XSetFont: () => 1,

    XCreatePixmap: (_d, _dr, w, h) => {
      const id = nextPixmap++;
      drawables.set(id, { addr: 0, w: Math.max(1, w | 0), h: Math.max(1, h | 0), bg: 0, window: false });
      return id;
    },
    XFreePixmap: (_d, id) => {
      const d = drawables.get(id >>> 0);
      if (d?.addr) M.rt.free(d.addr);
      drawables.delete(id >>> 0);
      return 1;
    },

    XDrawPoint: (_d, dr, gc, x, y) => { plotter(dr, gc)?.point(x | 0, y | 0); return 1; },
    XDrawPoints: (_d, dr, gc, pts, n, mode) => {
      const p = plotter(dr, gc);
      if (p) for (const [x, y] of points(pts, n, mode)) p.point(x, y);
      return 1;
    },
    XDrawLine: (_d, dr, gc, x0, y0, x1, y1) => { const p = plotter(dr, gc); if (p) line(p, x0 | 0, y0 | 0, x1 | 0, y1 | 0); return 1; },
    XDrawLines: (_d, dr, gc, pts, n, mode) => {
      const p = plotter(dr, gc), ps = points(pts, n, mode);
      if (p) for (let i = 1; i < ps.length; i++) line(p, ps[i - 1][0], ps[i - 1][1], ps[i][0], ps[i][1]);
      return 1;
    },
    // XSegment is { short x1, y1, x2, y2 }.
    XDrawSegments: (_d, dr, gc, segs, n) => {
      const p = plotter(dr, gc);
      if (p) for (let i = 0; i < (n | 0); i++) {
        const s = segs + i * 8, g = (o) => dv().getInt16(s + o, true);
        line(p, g(0), g(2), g(4), g(6));
      }
      return 1;
    },
    // An outline covers w+1 by h+1 pixels, a fill w by h: the X protocol's own definitions.
    XDrawRectangle: (_d, dr, gc, x, y, w, h) => {
      const p = plotter(dr, gc);
      if (p) {
        x |= 0; y |= 0; w >>>= 0; h >>>= 0;
        line(p, x, y, x + w, y); line(p, x + w, y, x + w, y + h);
        line(p, x + w, y + h, x, y + h); line(p, x, y + h, x, y);
      }
      return 1;
    },
    XFillRectangle: (_d, dr, gc, x, y, w, h) => {
      const p = plotter(dr, gc);
      if (p) for (let yy = y | 0; yy < (y | 0) + (h >>> 0); yy++) p.span(x | 0, (x | 0) + (w >>> 0) - 1, yy);
      return 1;
    },
    // XRectangle is { short x, y; unsigned short width, height; }.
    XFillRectangles: (_d, dr, gc, rects, n) => {
      for (let i = 0; i < (n | 0); i++) {
        const r = rects + i * 8;
        api.XFillRectangle(0, dr, gc, dv().getInt16(r, true), dv().getInt16(r + 2, true), dv().getUint16(r + 4, true), dv().getUint16(r + 6, true));
      }
      return 1;
    },
    XDrawRectangles: (_d, dr, gc, rects, n) => {
      for (let i = 0; i < (n | 0); i++) {
        const r = rects + i * 8;
        api.XDrawRectangle(0, dr, gc, dv().getInt16(r, true), dv().getInt16(r + 2, true), dv().getUint16(r + 4, true), dv().getUint16(r + 6, true));
      }
      return 1;
    },
    XFillPolygon: (_d, dr, gc, pts, n, _shape, mode) => { const p = plotter(dr, gc); if (p) fillPolygon(p, points(pts, n, mode)); return 1; },
    XDrawArc: (_d, dr, gc, x, y, w, h, a1, a2) => { const p = plotter(dr, gc); if (p) drawArc(p, x | 0, y | 0, w >>> 0, h >>> 0, a1 | 0, a2 | 0); return 1; },
    XFillArc: (_d, dr, gc, x, y, w, h, a1, a2) => { const p = plotter(dr, gc); if (p) fillArc(p, x | 0, y | 0, w >>> 0, h >>> 0, a1 | 0, a2 | 0); return 1; },
    XDrawString: (_d, dr, gc, x, y, s, n) => { const p = plotter(dr, gc); if (p) text(p, x | 0, y | 0, str(s, n), false); return 1; },
    XDrawImageString: (_d, dr, gc, x, y, s, n) => { const p = plotter(dr, gc); if (p) text(p, x | 0, y | 0, str(s, n), true); return 1; },

    XClearArea: (_d, w, x, y, cw, ch) => {
      const d = surface(w);
      if (!d) return 1;
      if (d.window) dirty = true;
      x |= 0; y |= 0;
      // A zero width or height means "to the edge of the window" (XClearArea(3)).
      const x1 = (cw >>> 0) ? x + (cw >>> 0) : d.w, y1 = (ch >>> 0) ? y + (ch >>> 0) : d.h;
      const px = pixels(d), bg = 0xff000000 | d.bg;
      for (let yy = Math.max(0, y); yy < Math.min(d.h, y1); yy++) px.fill(bg, yy * d.w + Math.max(0, x), yy * d.w + Math.min(d.w, x1));
      return 1;
    },
    XClearWindow: (d, w) => api.XClearArea(d, w, 0, 0, 0, 0),
    XSetWindowBackground: (_d, w, pixel) => { const d = drawables.get(w >>> 0); if (d) d.bg = pixel & 0xffffff; return 1; },

    XCopyArea: (_d, src, dst, gc, sx, sy, w, h, dx, dy) => {
      const s = surface(src), t = surface(dst);
      if (!s || !t) return 1;
      if (t.window) dirty = true;
      const sp = pixels(s), tp = pixels(t), xor = gcOf(gc).fn === GX.xor;
      for (let y = 0; y < (h >>> 0); y++) {
        const ys = (sy | 0) + y, yt = (dy | 0) + y;
        if (ys < 0 || ys >= s.h || yt < 0 || yt >= t.h) continue;
        for (let x = 0; x < (w >>> 0); x++) {
          const xs = (sx | 0) + x, xt = (dx | 0) + x;
          if (xs < 0 || xs >= s.w || xt < 0 || xt >= t.w) continue;
          const v = sp[ys * s.w + xs];
          tp[yt * t.w + xt] = xor ? tp[yt * t.w + xt] ^ (v & 0xffffff) : v;
        }
      }
      return 1;
    },

    XAllocColor: (_d, _cmap, c) => {
      fillColor(c, [dv().getUint16(c + 4, true), dv().getUint16(c + 6, true), dv().getUint16(c + 8, true)]);
      return 1;
    },
    XParseColor: (_d, _cmap, spec, c) => { const rgb = parseColor(M.mod.cstr(spec)); if (!rgb) return 0; fillColor(c, rgb); return 1; },
    XLookupColor: (_d, _cmap, spec, exact, screen) => {
      const rgb = parseColor(M.mod.cstr(spec));
      if (!rgb) return 0;
      if (exact) fillColor(exact, rgb);
      if (screen) fillColor(screen, rgb);
      return 1;
    },
    XAllocNamedColor: (_d, _cmap, spec, screen, exact) => {
      const rgb = parseColor(M.mod.cstr(spec));
      if (!rgb) return 0;
      if (screen) fillColor(screen, rgb);
      if (exact) fillColor(exact, rgb);
      return 1;
    },

    XLoadQueryFont: () => queryFont(),
    XQueryFont: () => queryFont(),
    XLoadFont: () => (font ? FONT_ID : 0),
    XTextWidth: (_f, _s, n) => 8 * (n | 0),
  };

  return {
    api,
    /** A window, as XCreateWindow describes it: its size and background, no pixels yet. */
    addWindow(id, w, h, bg) { drawables.set(id >>> 0, { addr: 0, w: Math.max(1, w | 0), h: Math.max(1, h | 0), bg: bg & 0xffffff, window: true }); },
    window: (id) => drawables.get(id >>> 0),
    /* Mapping shows the window: its background, before the client has drawn anything (its Expose). */
    map(id) { if (surface(id)?.window) dirty = true; },
    /** An image put into a drawable that has pixels: converted to the surface (8-bit through the palette). */
    putImage(id, data, iw, ih, bpl, bpp, sx, sy, dx, dy, w, h, palette) {
      const t = surface(id);
      if (!t) return false;
      if (t.window) dirty = true;
      const tp = pixels(t);
      for (let y = 0; y < h; y++) {
        const ys = sy + y, yt = dy + y;
        if (ys < 0 || ys >= ih || yt < 0 || yt >= t.h) continue;
        for (let x = 0; x < w; x++) {
          const xs = sx + x, xt = dx + x;
          if (xs < 0 || xs >= iw || xt < 0 || xt >= t.w) continue;
          let v;
          if (bpp === 8) { const k = M.u8[data + ys * bpl + xs] * 3; v = (palette[k] << 16) | (palette[k + 1] << 8) | palette[k + 2]; }
          else v = dv().getUint32(data + ys * bpl + xs * 4, true) & 0xffffff;
          tp[yt * t.w + xt] = 0xff000000 | v;
        }
      }
      return true;
    },
    /** Whether a window has been drawn into since the last call, and so has a frame to show. */
    takeDirty() { const d = dirty; dirty = false; return d; },
  };
}
