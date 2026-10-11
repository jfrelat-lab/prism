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
//   gluBuild2DMipmaps     the image scaled to powers of two if it is not, then halved level by level
//   gluScaleImage         box-filtered when shrinking, bilinear when enlarging
//
// NOT bit-identical to SGI's or Mesa's GLU where filtering is concerned: gluScaleImage's exact
// arithmetic is theirs. No gate holds it to a reference yet; when one does, this is where it bites.

const GLU_SMOOTH = 100000, GLU_FLAT = 100001, GLU_NONE = 100002;
const GLU_POINT = 100010, GLU_LINE = 100011, GLU_FILL = 100012, GLU_SILHOUETTE = 100013;
const GLU_OUTSIDE = 100020, GLU_INSIDE = 100021;
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
  /** A tightly packed copy of a client image (rows as GL_UNPACK_ALIGNMENT lays them out). */
  const readImage = (w, h, n, ptr) => {
    const align = M.gl.state.unpackAlign ?? 4, row = Math.ceil(w * n / align) * align;
    const out = new Uint8Array(w * h * n);
    for (let y = 0; y < h; y++) out.set(M.u8.subarray(ptr + y * row, ptr + y * row + w * n), y * w * n);
    return out;
  };
  /** src (sw x sh, n components) resampled to dw x dh. */
  const scale = (src, sw, sh, n, dw, dh) => {
    const out = new Uint8Array(dw * dh * n);
    const sx = sw / dw, sy = sh / dh;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        for (let c = 0; c < n; c++) {
          let v;
          if (sx >= 1 && sy >= 1) {
            // Shrinking: the mean of the source texels this one covers.
            const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
            const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
            let sum = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[(yy * sw + xx) * n + c];
            v = sum / ((x1 - x0) * (y1 - y0));
          } else {
            const fx = Math.max(0, (x + 0.5) * sx - 0.5), fy = Math.max(0, (y + 0.5) * sy - 0.5);
            const x0 = Math.min(sw - 1, Math.floor(fx)), y0 = Math.min(sh - 1, Math.floor(fy));
            const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
            const at = (xx, yy) => src[(yy * sw + xx) * n + c];
            v = (at(x0, y0) * (1 - ax) + at(x1, y0) * ax) * (1 - ay) + (at(x0, y1) * (1 - ax) + at(x1, y1) * ax) * ay;
          }
          out[(y * dw + x) * n + c] = Math.max(0, Math.min(255, Math.round(v)));
        }
      }
    }
    return out;
  };
  const pow2 = (v) => { let p = 1; while (p * 2 <= v) p *= 2; return v - p > p * 2 - v && p * 2 <= 16384 ? p * 2 : p; };

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
    gluScaleImage: (format, win, hin, typein, datain, wout, hout, typeout, dataout) => {
      const n = COMPONENTS[format];
      if (!n || typein !== GL.UNSIGNED_BYTE || typeout !== GL.UNSIGNED_BYTE) return 100900;
      const out = scale(readImage(win, hin, n, datain), win, hin, n, wout, hout);
      const align = M.gl.state.unpackAlign ?? 4, row = Math.ceil(wout * n / align) * align;
      for (let y = 0; y < hout; y++) M.u8.set(out.subarray(y * wout * n, (y + 1) * wout * n), dataout + y * row);
      return 0;
    },
    gluBuild2DMipmaps: (target, components, width, height, format, type, data) => {
      const n = COMPONENTS[format];
      if (!n || type !== GL.UNSIGNED_BYTE) return 100900;
      if (width < 1 || height < 1) return 100901;
      let img = readImage(width, height, n, data), w = pow2(width), h = pow2(height);
      if (w !== width || h !== height) img = scale(img, width, height, n, w, h);
      // Each level goes up tightly packed, whatever the program's unpack alignment is; restored after.
      const saved = M.gl.state.unpackAlign ?? 4;
      const buf = rt.malloc(w * h * n);
      rt.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
      try {
        for (let level = 0; ; level++) {
          M.u8.set(img, buf);
          rt.glTexImage2D(target, level, components, w, h, 0, format, type, buf);
          if (w === 1 && h === 1) break;
          const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
          img = scale(img, w, h, n, nw, nh);
          w = nw; h = nh;
        }
      } finally { rt.glPixelStorei(GL.UNPACK_ALIGNMENT, saved); rt.free(buf); }
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
