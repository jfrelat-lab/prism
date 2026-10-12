// glu.js — the part of GLU 1.2 that programs of the corpus call, written over GL as the library itself is.
//
// GLU is not part of OpenGL: it is a utility library that only ever calls gl* entry points, and that
// is what this file does (through M.rt, the same functions a program's own calls reach). So a quadric
// goes through glBegin/glNormal/glVertex and is lit, clipped and rasterised like anything else, and a
// mipmap chain is a series of glTexImage2D.
//
//   gluPerspective        the projection matrix of the specification, multiplied onto the current one
//   gluSphere             SGI's tessellation (libutil/quad.c): a triangle fan at each pole and quad
//                         strips between, or strips all the way when texture coordinates are wanted
//   gluBuild2DMipmaps     GLU 9's mipmap.c for GL_UNSIGNED_BYTE: a power-of-two image halved level
//   gluScaleImage         by level, any other size box-filtered to the nearest powers of two first;
//                         gluScaleImage through libGLU's 16-bit box filter. Bit-identical to Debian's
//                         i386 libGLU (tools/gate-glu.mjs); other pixel types are refused by name.
//
// gluUnProject is held to libGLU to 1e-12 (its x87 intermediates move the last bits); gluPerspective
// and gluSphere are not held to a reference yet.

const GLU_SMOOTH = 100000, GLU_FLAT = 100001, GLU_NONE = 100002;
const GLU_POINT = 100010, GLU_LINE = 100011, GLU_FILL = 100012, GLU_SILHOUETTE = 100013;
const GLU_OUTSIDE = 100020, GLU_INSIDE = 100021;
const GLU_INVALID_ENUM = 100900, GLU_INVALID_VALUE = 100901;
const GL = { TRIANGLE_FAN: 6, QUAD_STRIP: 8, LINE_LOOP: 2, LINE_STRIP: 3, POINTS: 0, UNPACK_ALIGNMENT: 0x0cf5, UNSIGNED_BYTE: 0x1401 };
const COMPONENTS = { 0x1908: 4, 0x1907: 3, 0x1909: 1, 0x1906: 1, 0x190a: 2, 0x8049: 1 };
const ERRORS = { 0: 'no error', 0x0500: 'invalid enumerant', 0x0501: 'invalid value', 0x0502: 'invalid operation',
  0x0503: 'stack overflow', 0x0504: 'stack underflow', 0x0505: 'out of memory',
  100900: 'invalid enumerant', 100901: 'invalid value', 100902: 'out of memory' };

export function installGlu(M) {
  if (!M.gl) throw new Error('glu: needs the gl environment');
  const rt = M.rt;
  const dv = () => M.mod.dv;
  const quadrics = new Map();
  const strings = new Map();
  let scratch = 0;
  const doubles = (vals) => {
    if (!scratch) scratch = rt.malloc(16 * 8);
    vals.forEach((v, k) => dv().setFloat64(scratch + 8 * k, v, true));
    return scratch;
  };
  /*
   * Mipmaps and scaling as GLU 9 (Mesa's libGLU, libutil/mipmap.c) does them for GL_UNSIGNED_BYTE,
   * transcribed routine by routine: gluBuild2DMipmaps halves bytes directly (halveImage_ubyte) and
   * box-filters a size that is not a power of two (scale_internal_ubyte); gluScaleImage widens to
   * 16 bits (fill_image), filters with its own box (scale_internal) and narrows back (empty_image).
   * `fr` is the float rounding of libGLU's `float` variables. Other pixel types are refused by name.
   */
  const fr = Math.fround;
  const elementsPerGroup = (format) => (format === 0x1907 || format === 0x80e0 ? 3 : format === 0x190a ? 2 : format === 0x1908 || format === 0x80e1 ? 4 : 1);
  const LEGAL_FORMAT = new Set([0x1900, 0x1901, 0x1902, 0x1903, 0x1904, 0x1905, 0x1906, 0x1907, 0x1908, 0x1909, 0x190a, 0x80e0, 0x80e1]);
  const computeLog = (v) => { if (v === 0) return -1; for (let i = 0; ; i++, v >>>= 1) if (v & 1) return v !== 1 ? -1 : i; };
  const nearestPower = (v) => { if (v === 0) return -1; for (let i = 1; ; i *= 2, v >>>= 1) { if (v === 1) return i; if (v === 3) return i * 4; } };
  const rowBytes = (groups, groupSize, align) => { let r = groups * groupSize; const pad = r % align; if (pad) r += align - pad; return r; };
  const unsupportedType = (fn, type) => { throw new Error(`glu: ${fn} with pixel type 0x${type.toString(16)} (only GL_UNSIGNED_BYTE is implemented)`); };

  const halve1DimageUbyte = (components, width, height, src, si, dst, element_size, ysize, group_size) => {
    let di = 0;
    if (height === 1) {
      for (let jj = 0; jj < (width >> 1); jj++) {
        for (let kk = 0; kk < components; kk++) { dst[di++] = (src[si] + src[si + group_size]) >> 1; si += element_size; }
        si += group_size;
      }
    } else {
      const padBytes = ysize - width * group_size;
      for (let jj = 0; jj < (height >> 1); jj++) {
        for (let kk = 0; kk < components; kk++) { dst[di++] = (src[si] + src[si + ysize]) >> 1; si += element_size; }
        si += padBytes; si += ysize;
      }
    }
  };
  const halveImageUbyte = (components, width, height, src, si, dst, element_size, ysize, group_size) => {
    if (width === 1 || height === 1) return halve1DimageUbyte(components, width, height, src, si, dst, element_size, ysize, group_size);
    const newwidth = width >> 1, newheight = height >> 1, padBytes = ysize - width * group_size;
    let di = 0;
    for (let i = 0; i < newheight; i++) {
      for (let j = 0; j < newwidth; j++) {
        for (let k = 0; k < components; k++) {
          dst[di++] = (src[si] + src[si + group_size] + src[si + ysize] + src[si + ysize + group_size] + 2) >> 2;
          si += element_size;
        }
        si += group_size;
      }
      si += padBytes; si += ysize;
    }
  };
  const scaleInternalUbyte = (components, widthin, heightin, src, si0, widthout, heightout, dst, element_size, ysize, group_size) => {
    if (widthin === widthout * 2 && heightin === heightout * 2) return halveImageUbyte(components, widthin, heightin, src, si0, dst, element_size, ysize, group_size);
    const convy = fr(heightin / heightout), convx = fr(widthin / widthout);
    const convy_int = Math.floor(convy), convy_float = fr(convy - convy_int);
    const convx_int = Math.floor(convx), convx_float = fr(convx - convx_int);
    const area = fr(convx * convy);
    const totals = [0, 0, 0, 0];
    let lowy_int = 0, lowy_float = 0, highy_int = convy_int, highy_float = convy_float;
    const add = (k, v) => { totals[k] = fr(totals[k] + v); };
    for (let i = 0; i < heightout; i++) {
      if (highy_int >= heightin) highy_int = heightin - 1;
      let lowx_int = 0, lowx_float = 0, highx_int = convx_int, highx_float = convx_float;
      for (let j = 0; j < widthout; j++) {
        totals[0] = totals[1] = totals[2] = totals[3] = 0;
        const xindex = lowx_int * group_size;
        let temp, percent, y_percent, x_percent;
        const row = (at, p) => { for (let k = 0; k < components; k++) add(k, fr(src[at + k * element_size] * p)); };
        if (highy_int > lowy_int && highx_int > lowx_int) {
          y_percent = fr(1 - lowy_float);
          temp = si0 + xindex + lowy_int * ysize;
          percent = fr(y_percent * fr(1 - lowx_float));
          row(temp, percent);
          let left = temp;
          for (let l = lowx_int + 1; l < highx_int; l++) { temp += group_size; row(temp, y_percent); }
          temp += group_size;
          let right = temp;
          percent = fr(y_percent * highx_float);
          row(temp, percent);
          y_percent = highy_float;
          percent = fr(y_percent * fr(1 - lowx_float));
          temp = si0 + xindex + highy_int * ysize;
          row(temp, percent);
          for (let l = lowx_int + 1; l < highx_int; l++) { temp += group_size; row(temp, y_percent); }
          temp += group_size;
          percent = fr(y_percent * highx_float);
          row(temp, percent);
          for (let m = lowy_int + 1; m < highy_int; m++) {
            left += ysize; right += ysize;
            for (let k = 0; k < components; k++, left += element_size, right += element_size) {
              add(k, fr(fr(src[left] * fr(1 - lowx_float)) + fr(src[right] * highx_float)));
            }
          }
        } else if (highy_int > lowy_int) {
          x_percent = fr(highx_float - lowx_float);
          percent = fr(fr(1 - lowy_float) * x_percent);
          temp = si0 + xindex + lowy_int * ysize;
          row(temp, percent);
          for (let m = lowy_int + 1; m < highy_int; m++) { temp += ysize; row(temp, x_percent); }
          percent = fr(x_percent * highy_float);
          temp += ysize;
          row(temp, percent);
        } else if (highx_int > lowx_int) {
          y_percent = fr(highy_float - lowy_float);
          percent = fr(fr(1 - lowx_float) * y_percent);
          temp = si0 + xindex + lowy_int * ysize;
          row(temp, percent);
          for (let l = lowx_int + 1; l < highx_int; l++) { temp += group_size; row(temp, y_percent); }
          temp += group_size;
          percent = fr(y_percent * highx_float);
          row(temp, percent);
        } else {
          percent = fr(fr(highy_float - lowy_float) * fr(highx_float - lowx_float));
          row(si0 + xindex + lowy_int * ysize, percent);
        }
        let temp0 = si0 + xindex + group_size + (lowy_int + 1) * ysize;
        for (let m = lowy_int + 1; m < highy_int; m++) {
          temp = temp0;
          for (let l = lowx_int + 1; l < highx_int; l++) {
            for (let k = 0; k < components; k++) add(k, src[temp + k * element_size]);
            temp += group_size;
          }
          temp0 += ysize;
        }
        const outindex = (j + i * widthout) * components;
        for (let k = 0; k < components; k++) dst[outindex + k] = Math.trunc(fr(totals[k] / area));
        lowx_int = highx_int; lowx_float = highx_float;
        highx_int += convx_int; highx_float = fr(highx_float + convx_float);
        if (highx_float > 1) { highx_float = fr(highx_float - 1); highx_int++; }
      }
      lowy_int = highy_int; lowy_float = highy_float;
      highy_int += convy_int; highy_float = fr(highy_float + convy_float);
      if (highy_float > 1) { highy_float = fr(highy_float - 1); highy_int++; }
    }
  };
  /*
   * scale_internal: libGLU's 16-bit box filter, the one gluScaleImage uses. Its `float` variables are
   * NOT all floats in the library as built (Debian's i386 libGLU, x87 code, disassembled): convy is
   * kept at full precision -- only convx is rounded --, the coverage of each source texel (xpercent,
   * ypercent, their product) and the running area never leave the FPU, and each product of a texel by
   * its coverage is added to totals[k] before rounding; the coordinates (x, y, low, high) and totals[k]
   * are rounded to float as they are stored. Reproduced here: the unrounded values are exact in double.
   */
  const scaleInternal = (components, widthin, heightin, datain, widthout, heightout, dataout) => {
    if (widthin === widthout * 2 && heightin === heightout * 2) {
      const delta = widthin * components;
      let si = 0, di = 0;
      for (let i = 0; i < (heightin >> 1); i++) {
        for (let j = 0; j < (widthin >> 1); j++) {
          for (let k = 0; k < components; k++, si++) dataout[di++] = (datain[si] + datain[si + components] + datain[si + delta] + datain[si + delta + components] + 2) >> 2;
          si += components;
        }
        si += delta;
      }
      return;
    }
    const convy = heightin / heightout, convxExact = widthin / widthout, convx = fr(convxExact);
    const halfconvx = fr(convxExact / 2), halfconvy = fr(convy / 2);
    const totals = [0, 0, 0, 0];
    for (let i = 0; i < heightout; i++) {
      let y = fr((i + 0.5) * convy), highy, lowy;
      if (heightin > heightout) { highy = fr(y + halfconvy); lowy = fr(y - halfconvy); } else { highy = fr(y + 0.5); lowy = fr(y - 0.5); }
      for (let j = 0; j < widthout; j++) {
        let x = fr((j + 0.5) * convx), highx, lowx;
        if (widthin > widthout) { highx = fr(x + halfconvx); lowx = fr(x - halfconvx); } else { highx = fr(x + 0.5); lowx = fr(x - 0.5); }
        totals[0] = totals[1] = totals[2] = totals[3] = 0;
        let area = 0;
        y = lowy;
        let yint = Math.floor(y);
        while (y < highy) {
          const yindex = (yint + heightin) % heightin;
          const ypercent = highy < yint + 1 ? highy - y : yint + 1 - y;
          x = lowx;
          let xint = Math.floor(x);
          while (x < highx) {
            const xindex = (xint + widthin) % widthin;
            const xpercent = highx < xint + 1 ? highx - x : xint + 1 - x;
            const percent = xpercent * ypercent;
            area += percent;
            const temp = (xindex + yindex * widthin) * components;
            for (let k = 0; k < components; k++) totals[k] = fr(totals[k] + datain[temp + k] * percent);
            xint++; x = xint;
          }
          yint++; y = yint;
        }
        const temp = (j + i * widthout) * components;
        for (let k = 0; k < components; k++) dataout[temp + k] = Math.trunc((totals[k] + 0.5) / area) & 0xffff;
      }
    }
  };
  /*
   * gluUnProject as GLU 9 (Mesa's libGLU, project.c) computes it, operation for operation: the
   * product of the two matrices, its inverse by cofactors, the window point mapped to [-1, 1] and
   * multiplied through. Double arithmetic in the same order, so the bits are its bits.
   */
  const mat = (p) => Array.from({ length: 16 }, (_, k) => dv().getFloat64(p + 8 * k, true));
  const multMatrices = (a, b) => {
    const r = new Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      r[i * 4 + j] = a[i * 4 + 0] * b[0 * 4 + j] + a[i * 4 + 1] * b[1 * 4 + j] + a[i * 4 + 2] * b[2 * 4 + j] + a[i * 4 + 3] * b[3 * 4 + j];
    }
    return r;
  };
  const invert = (m) => {
    const inv = new Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (det === 0) return null;
    det = 1.0 / det;
    return inv.map((v) => v * det);
  };
  const multVec = (m, v) => [0, 1, 2, 3].map((i) => v[0] * m[0 * 4 + i] + v[1] * m[1 * 4 + i] + v[2] * m[2 * 4 + i] + v[3] * m[3 * 4 + i]);

  Object.assign(rt, {
    gluUnProject: (winx, winy, winz, model, proj, viewport, objx, objy, objz) => {
      const final = invert(multMatrices(mat(model), mat(proj)));
      if (!final) return 0;
      const vp = [0, 1, 2, 3].map((k) => dv().getInt32(viewport + 4 * k, true));
      const v = [winx, winy, winz, 1.0];
      v[0] = (v[0] - vp[0]) / vp[2];
      v[1] = (v[1] - vp[1]) / vp[3];
      v[0] = v[0] * 2 - 1; v[1] = v[1] * 2 - 1; v[2] = v[2] * 2 - 1;
      const out = multVec(final, v);
      if (out[3] === 0.0) return 0;
      out[0] /= out[3]; out[1] /= out[3]; out[2] /= out[3];
      dv().setFloat64(objx, out[0], true); dv().setFloat64(objy, out[1], true); dv().setFloat64(objz, out[2], true);
      return 1;
    },
    gluPerspective: (fovy, aspect, zNear, zFar) => {
      const f = 1 / Math.tan(fovy * Math.PI / 360);
      rt.glMultMatrixd(doubles([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (zFar + zNear) / (zNear - zFar), -1,
        0, 0, 2 * zFar * zNear / (zNear - zFar), 0]));
    },
    gluErrorString: (code) => {
      const text = ERRORS[code];
      if (!text) return 0;
      if (!strings.has(code)) strings.set(code, M.mod.intern([...new TextEncoder().encode(text), 0]));
      return strings.get(code);
    },
    gluNewQuadric: () => {
      const q = rt.malloc(16);
      quadrics.set(q, { normals: GLU_SMOOTH, orientation: GLU_OUTSIDE, style: GLU_FILL, texture: false });
      return q;
    },
    gluDeleteQuadric: (q) => { if (quadrics.delete(q)) rt.free(q); },
    gluQuadricDrawStyle: (q, v) => { quadrics.get(q).style = v; },
    gluQuadricNormals: (q, v) => { quadrics.get(q).normals = v; },
    gluQuadricOrientation: (q, v) => { quadrics.get(q).orientation = v; },
    gluQuadricTexture: (q, v) => { quadrics.get(q).texture = !!v; },
    gluSphere: (q, radius, slices, stacks) => {
      const Q = quadrics.get(q);
      if (!Q) throw new Error('glu: gluSphere on something that is not a quadric');
      if (Q.style !== GLU_FILL) throw new Error('glu: only GLU_FILL spheres are implemented');
      const nsign = Q.orientation === GLU_INSIDE ? -1 : 1;
      const normals = Q.normals !== GLU_NONE;
      const drho = Math.PI / stacks, dtheta = 2 * Math.PI / slices;
      const point = (theta, rho) => [-Math.sin(theta) * Math.sin(rho), Math.cos(theta) * Math.sin(rho), nsign * Math.cos(rho)];
      const emit = ([x, y, z]) => { if (normals) rt.glNormal3f(x * nsign, y * nsign, z * nsign); rt.glVertex3f(x * radius, y * radius, z * radius); };
      if (!Q.texture) {
        rt.glBegin(GL.TRIANGLE_FAN);
        rt.glNormal3f(0, 0, 1);
        rt.glVertex3f(0, 0, nsign * radius);
        for (let j = 0; j <= slices; j++) emit(point(j === slices ? 0 : j * dtheta, drho));
        rt.glEnd();
      }
      const ds = 1 / slices, dt = 1 / stacks;
      let t = 1;
      const imin = Q.texture ? 0 : 1, imax = Q.texture ? stacks : stacks - 1;
      for (let i = imin; i < imax; i++) {
        const rho = i * drho;
        rt.glBegin(GL.QUAD_STRIP);
        let s = 0;
        for (let j = 0; j <= slices; j++) {
          const theta = j === slices ? 0 : j * dtheta;
          if (Q.texture) rt.glTexCoord2f(s, t);
          emit(point(theta, rho));
          if (Q.texture) rt.glTexCoord2f(s, t - dt);
          s += ds;
          emit(point(theta, rho + drho));
        }
        rt.glEnd();
        t -= dt;
      }
      if (!Q.texture) {
        rt.glBegin(GL.TRIANGLE_FAN);
        rt.glNormal3f(0, 0, -1);
        rt.glVertex3f(0, 0, -radius * nsign);
        const rho = Math.PI - drho;
        for (let j = slices; j >= 0; j--) emit(point(j === slices ? 0 : j * dtheta, rho));
        rt.glEnd();
      }
    },
    gluScaleImage: (format, widthin, heightin, typein, datain, widthout, heightout, typeout, dataout) => {
      if (widthin === 0 || heightin === 0 || widthout === 0 || heightout === 0) return 0;
      if (widthin < 0 || heightin < 0 || widthout < 0 || heightout < 0) return GLU_INVALID_VALUE;
      if (!LEGAL_FORMAT.has(format)) return GLU_INVALID_ENUM;
      if (typein !== GL.UNSIGNED_BYTE) unsupportedType('gluScaleImage', typein);
      if (typeout !== GL.UNSIGNED_BYTE) unsupportedType('gluScaleImage', typeout);
      const index = format === 0x1900 || format === 0x1901;
      const c = elementsPerGroup(format), S = M.gl.state;
      const before = new Uint16Array(widthin * heightin * c), after = new Uint16Array(widthout * heightout * c);
      // fill_image: rows as GL_UNPACK_ALIGNMENT lays them out, each byte widened to 16 bits (* 257).
      const inRow = rowBytes(widthin, c, S.unpackAlign);
      for (let i = 0, o = 0; i < heightin; i++) for (let j = 0; j < widthin * c; j++) { const v = M.u8[datain + i * inRow + j]; before[o++] = index ? v : v * 257; }
      scaleInternal(c, widthin, heightin, before, widthout, heightout, after);
      // empty_image: rows as GL_PACK_ALIGNMENT lays them out, each value narrowed (>> 8).
      const outRow = rowBytes(widthout, c, S.packAlign);
      for (let i = 0, o = 0; i < heightout; i++) for (let j = 0; j < widthout * c; j++) { const v = after[o++]; M.u8[dataout + i * outRow + j] = index ? v : v >> 8; }
      return 0;
    },
    gluBuild2DMipmaps: (target, internalFormat, width, height, format, type, data) => {
      if (!LEGAL_FORMAT.has(format) || format === 0x1901) return GLU_INVALID_ENUM;
      if (type !== GL.UNSIGNED_BYTE) unsupportedType('gluBuild2DMipmaps', type);
      if (width < 1 || height < 1) return GLU_INVALID_VALUE;
      // closestFit: Mesa answers the proxy texture for every power of two up to GL_MAX_TEXTURE_SIZE.
      const max = 16384;
      let newwidth = Math.min(nearestPower(width), max), newheight = Math.min(nearestPower(height), max);
      const levels = Math.max(computeLog(newwidth), computeLog(newheight));
      // gluBuild2DMipmapLevelsCore with userLevel 0, baseLevel 0, maxLevel `levels`.
      const S = M.gl.state, align = S.unpackAlign;
      const cmpts = elementsPerGroup(format), element_size = 1, group_size = cmpts;
      let rowsize = rowBytes(width, group_size, align);
      let srcImage, dstImage, level;
      const upload = (lvl, w, h, bytes) => {
        const buf = rt.malloc(Math.max(1, bytes.length));
        M.u8.set(bytes, buf);
        try { rt.glTexImage2D(target, lvl, internalFormat, w, h, 0, format, type, buf); } finally { rt.free(buf); }
      };
      if (width === newwidth && height === newheight) {
        upload(0, width, height, M.u8.subarray(data, data + rowsize * height));
        if (levels === 0) return 0;
        dstImage = new Uint8Array(Math.max(1, newwidth >> 1) * Math.max(1, newheight >> 1) * cmpts);
        halveImageUbyte(cmpts, width, height, M.u8, data, dstImage, element_size, rowsize, group_size);
        newwidth = Math.max(1, width >> 1); newheight = Math.max(1, height >> 1);
        rowsize = newwidth * group_size;
        srcImage = dstImage;
        level = 1;
      } else {
        srcImage = new Uint8Array(newwidth * newheight * cmpts);
        scaleInternalUbyte(cmpts, width, height, M.u8, data, newwidth, newheight, srcImage, element_size, rowsize, group_size);
        rowsize = newwidth * group_size;
        level = 0;
      }
      // Tightly packed from here, but still sent under the caller's GL_UNPACK_ALIGNMENT, as libGLU does.
      upload(level, newwidth, newheight, srcImage.subarray(0, Math.ceil(rowsize / align) * align * (newheight - 1) + rowsize));
      for (level++; level <= levels; level++) {
        dstImage = new Uint8Array(Math.max(1, newwidth >> 1) * Math.max(1, newheight >> 1) * cmpts);
        halveImageUbyte(cmpts, newwidth, newheight, srcImage, 0, dstImage, element_size, rowsize, group_size);
        srcImage = dstImage;
        if (newwidth > 1) { newwidth >>= 1; rowsize = Math.trunc(rowsize / 2); }
        if (newheight > 1) newheight >>= 1;
        const rowPad = rowsize % align;
        if (rowPad === 0) upload(level, newwidth, newheight, srcImage.subarray(0, rowsize * newheight));
        else {
          const newRowLength = rowsize + align - rowPad, padded = new Uint8Array(newRowLength * newheight);
          for (let ii = 0; ii < newheight; ii++) padded.set(srcImage.subarray(ii * rowsize, ii * rowsize + rowsize), ii * newRowLength);
          upload(level, newwidth, newheight, padded);
        }
      }
      return 0;
    },
  });
  void GLU_FLAT; void GLU_POINT; void GLU_LINE; void GLU_SILHOUETTE;
  return {};
}

export function gluBuiltins(T) {
  const I = T.INT, U = T.UINT, V = T.VOID, P = T.ptr(T.CHAR), D = T.DOUBLE;
  const f = (ret, ...params) => ({ ret, params });
  return {
    gluUnProject: f(I, D, D, D, P, P, P, P, P, P),
    gluPerspective: f(V, D, D, D, D), gluErrorString: f(P, U), gluNewQuadric: f(P), gluDeleteQuadric: f(V, P),
    gluQuadricDrawStyle: f(V, P, U), gluQuadricNormals: f(V, P, U), gluQuadricOrientation: f(V, P, U), gluQuadricTexture: f(V, P, I),
    gluSphere: f(V, P, D, I, I), gluScaleImage: f(I, U, I, I, U, P, I, I, U, P), gluBuild2DMipmaps: f(I, U, I, I, I, U, U, P),
  };
}
