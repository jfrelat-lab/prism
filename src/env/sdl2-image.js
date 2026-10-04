// sdl2-image.js — SDL_image's PNG loader: a file in, an SDL surface out.
//
// SDL_image is its own library, and what the program sees of it is the KIND of surface it gets back
// for a given file, because the program then treats paletted and RGBA images differently (SDLPoP
// keys the first and blends the second). The rules below are IMG_png.c's, the libpng loader:
//
//   a palette image stays 8-bit indexed whatever its bit depth, one byte a pixel, its palette
//   holding the file's colours -- and if its tRNS chunk marks exactly ONE entry fully transparent
//   and every other one opaque, that entry becomes the surface's colour key;
//   a palette image with any other transparency is expanded to RGBA;
//   greyscale becomes 8-bit indexed with a grey ramp, grey with alpha becomes RGBA;
//   RGB is a 24-bit surface and RGBA a 32-bit one, bytes in the file's order (R first);
//   16-bit samples keep their high byte.
import { decodePng, isPng } from './png.js';
import { PIXELFORMAT } from './sdl2-surface.js';

/** The surface SDL_image would make of these bytes: { format, width, height, pixels, palette, colorKey }. */
export function pngToSurface(bytes) {
  const png = decodePng(bytes);
  const { width, height, depth, colorType, rows, rowBytes } = png;
  const sample = (y, i) => {                          // the i-th sample of row y, as 8 bits or fewer
    if (depth === 8) return rows[y * rowBytes + i];
    if (depth === 16) return rows[y * rowBytes + 2 * i];
    const per = 8 / depth, byte = rows[y * rowBytes + Math.floor(i / per)];
    return (byte >> (8 - depth * (1 + (i % per)))) & ((1 << depth) - 1);
  };
  let colorKey = null, expand = false;
  if (colorType === 3 && png.trns) {
    let t = -1, j = 0;
    for (; j < png.trns.length; j++) {
      if (png.trns[j] === 0) { if (t >= 0) break; t = j; } else if (png.trns[j] !== 255) break;
    }
    if (j === png.trns.length) colorKey = t >= 0 ? t : null; else expand = true;
  }
  if (colorType === 3 && !expand) {
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = sample(y, x);
    return { format: PIXELFORMAT.INDEX8, width, height, bytes: 1, pixels, palette: png.palette ?? new Uint8Array(0), colorKey };
  }
  if (colorType === 0) {
    // Grey, widened to eight bits, with the ramp SDL_image writes into the palette.
    const max = depth === 16 ? 255 : (1 << depth) - 1, pixels = new Uint8Array(width * height), palette = new Uint8Array(768);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = Math.round((sample(y, x) * 255) / max);
    for (let i = 0; i < 256; i++) palette[3 * i] = palette[3 * i + 1] = palette[3 * i + 2] = i;
    if (png.trns && png.trns.length >= 2) colorKey = depth === 16 ? png.trns[0] : Math.round((png.trns[1] * 255) / max);
    return { format: PIXELFORMAT.INDEX8, width, height, bytes: 1, pixels, palette, colorKey };
  }
  const alpha = colorType === 6 || colorType === 4 || expand;
  const bytesPer = alpha ? 4 : 3, pixels = new Uint8Array(width * height * bytesPer);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * bytesPer;
      if (colorType === 3) {
        const i = sample(y, x);
        pixels[at] = png.palette[3 * i]; pixels[at + 1] = png.palette[3 * i + 1]; pixels[at + 2] = png.palette[3 * i + 2];
        pixels[at + 3] = i < png.trns.length ? png.trns[i] : 255;
      } else if (colorType === 4) {
        pixels[at] = pixels[at + 1] = pixels[at + 2] = sample(y, 2 * x); pixels[at + 3] = sample(y, 2 * x + 1);
      } else {
        const n = png.channels;
        for (let c = 0; c < n; c++) pixels[at + c] = sample(y, n * x + c);
      }
    }
  }
  // An RGB file's single transparent colour is a key too, as the mapped pixel value.
  if (colorType === 2 && png.trns && png.trns.length >= 6) {
    const s = depth === 16 ? 0 : 1;
    colorKey = (png.trns[s] | (png.trns[2 + s] << 8) | (png.trns[4 + s] << 16)) >>> 0;
  }
  return { format: alpha ? PIXELFORMAT.ABGR8888 : PIXELFORMAT.RGB24, width, height, bytes: bytesPer, pixels, palette: null, colorKey };
}

/**
 * IMG_Load and IMG_Load_RW over the surface machinery. `readStream` gives the bytes behind an
 * SDL_RWops and `readFile` those of a named file; both are the SDL environment's.
 */
export function imageApi(M, state, { surfaces, setErr, readStream, closeStream, readFile, cstr }) {
  const load = (bytes, what) => {
    if (!bytes) { setErr(`Couldn't open ${what}`); return 0; }
    if (!isPng(bytes)) { setErr('Unsupported image format'); return 0; }
    let img;
    try { img = pngToSurface(bytes); } catch (e) { setErr(e.message); return 0; }
    const p = surfaces.createSurface(img.width, img.height, img.format);
    const s = surfaces.surf(p), d = M.mod.dv;
    for (let y = 0; y < img.height; y++) {
      M.u8.set(img.pixels.subarray(y * img.width * img.bytes, (y + 1) * img.width * img.bytes), s.pixels + y * s.pitch);
    }
    if (img.palette) {
      const n = img.palette.length / 3, colors = d.getUint32(s.fmt.palette + 4, true);
      d.setInt32(s.fmt.palette, n, true);                  // ncolors: the file's count, as SDL_image sets it
      for (let i = 0; i < n; i++) { M.u8[colors + 4 * i] = img.palette[3 * i]; M.u8[colors + 4 * i + 1] = img.palette[3 * i + 1]; M.u8[colors + 4 * i + 2] = img.palette[3 * i + 2]; }
    }
    if (img.colorKey !== null) M.rt.SDL_SetColorKey(p, 1, img.colorKey);
    return p;
  };
  return {
    IMG_Load: (file) => { const name = cstr(file); return load(readFile(name), name); },
    IMG_Load_RW: (rw, freesrc) => {
      const bytes = readStream(rw);
      if (freesrc) closeStream(rw);
      return load(bytes, 'the stream');
    },
    // Writing a PNG needs a deflater, which nothing here has; the call fails and says why.
    IMG_SavePNG: () => setErr('IMG_SavePNG is not supported in this implementation'),
  };
}

export function imageBuiltins(T) {
  const P = T.ptr(T.CHAR), I = T.INT;
  const f = (ret, ...params) => ({ ret, params });
  return { IMG_Load: f(P, P), IMG_Load_RW: f(P, P, I), IMG_SavePNG: f(I, P, P) };
}
