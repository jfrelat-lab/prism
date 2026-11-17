// glarb.js — ARB_vertex_program and ARB_fragment_program in gl.js: the program objects, their parameters, the
// generic vertex attributes, and the draw. A draw with either program enabled goes to the GPU as it stands:
// the arrays' bytes (a buffer object's, or the program's memory) uploaded for the elements it names, the pair
// translated to GLSL ES (arbprog.js) and drawn by WebGL with the raster state gl.js applies to any draw --
// depth, stencil, blending, masks, scissor. The software rasteriser has no programmable stages, so there a
// program draw is refused by name.
//
// Doom 3's ARB2 path (renderer/draw_arb2.cpp) is what this is for: its interaction, shadow and post-process
// programs over vertex.attrib[8..11], seven texture units and cube maps.

import { parseProgram, linkPrograms, ArbError } from './arbprog.js';

const VP = 0x8620, FP = 0x8804;
const MAX_ENV = 256, MAX_LOCAL = 256, ATTRIBS = 16;

/**
 * `ctx` is gl.js's own: { s, M, gpuState, triangleIndices, layout, inBuffer, webgl(), upload(id, t), mul,
 * invert4, MODELVIEW, PROJECTION, TEXTURE_MATRIX, CULL_FACE }.
 */
export function makeArbPrograms(ctx) {
  const { s, M } = ctx;
  const dv = () => M.mod.dv;
  const st = {
    programs: new Map(), next: 1,
    bound: { [VP]: 0, [FP]: 0 },
    env: { [VP]: new Float32Array(4 * MAX_ENV), [FP]: new Float32Array(4 * MAX_ENV) },
    attribs: Array.from({ length: ATTRIBS }, () => ({ on: false, size: 4, type: 0x1406, norm: false, stride: 0, n: 4, step: 16, ptr: 0, buffer: 0, offset: 0, value: [0, 0, 0, 1] })),
    errorPos: -1, errorString: '',
    links: new Map(),
  };
  const object = (target, id = st.bound[target]) => {
    let p = st.programs.get(id);
    if (!p) { p = { target, ir: null, version: 0, local: new Float32Array(4 * MAX_LOCAL) }; st.programs.set(id, p); }
    return p;
  };
  const four = (ptr, dbl = false) => [0, 1, 2, 3].map((k) => (dbl ? dv().getFloat64(ptr + 8 * k, true) : dv().getFloat32(ptr + 4 * k, true)));
  const setEnv = (target, i, v) => { if (i >= 0 && i < MAX_ENV) st.env[target].set(v, 4 * i); };
  const setLocal = (target, i, v) => { if (i >= 0 && i < MAX_LOCAL) object(target).local.set(v, 4 * i); };

  const api = {
    glGenProgramsARB: (n, out) => {
      for (let k = 0; k < n; k++) {
        while (st.programs.has(st.next)) st.next++;
        st.programs.set(st.next, null);
        dv().setUint32(out + 4 * k, st.next++, true);
      }
    },
    glDeleteProgramsARB: (n, ids) => {
      for (let k = 0; k < n; k++) {
        const id = dv().getUint32(ids + 4 * k, true);
        st.programs.delete(id);
        for (const t of [VP, FP]) if (st.bound[t] === id) st.bound[t] = 0;
      }
    },
    glIsProgramARB: (id) => (st.programs.get(id) ? 1 : 0),
    glBindProgramARB: (target, id) => {
      if (target !== VP && target !== FP) throw new Error(`gl: program target 0x${target.toString(16)}`);
      st.bound[target] = id;
      if (!st.programs.get(id)) st.programs.set(id, null);
      object(target, id);
    },
    /*
     * The text compiled now, as a driver does: an error leaves the program as it was and is reported where
     * the specification puts it, GL_PROGRAM_ERROR_POSITION_ARB and GL_PROGRAM_ERROR_STRING_ARB, which Doom 3
     * reads back after each load (draw_arb2.cpp R_LoadARBProgram).
     */
    glProgramStringARB: (target, _format, len, ptr) => {
      const bytes = M.u8.subarray ? M.u8.subarray(ptr, ptr + len) : Uint8Array.from({ length: len }, (_, k) => M.u8[ptr + k]);
      const text = String.fromCharCode(...bytes);
      try {
        const ir = parseProgram(text);
        if (ir.kind !== (target === VP ? 'vertex' : 'fragment')) throw new ArbError(`a ${ir.kind} program given to the ${target === VP ? 'vertex' : 'fragment'} target`, 0);
        const p = object(target);
        p.ir = ir; p.version++;
        st.errorPos = -1; st.errorString = '';
      } catch (e) {
        if (!(e instanceof ArbError)) throw e;
        st.errorPos = e.pos ?? 0; st.errorString = e.message;
        console.warn(`gl: glProgramStringARB: ${e.message} (at ${e.pos})`);
      }
    },
    glProgramEnvParameter4fARB: (target, i, x, y, z, w) => setEnv(target, i, [x, y, z, w]),
    glProgramEnvParameter4dARB: (target, i, x, y, z, w) => setEnv(target, i, [x, y, z, w]),
    glProgramEnvParameter4fvARB: (target, i, p) => setEnv(target, i, four(p)),
    glProgramEnvParameter4dvARB: (target, i, p) => setEnv(target, i, four(p, true)),
    glProgramLocalParameter4fARB: (target, i, x, y, z, w) => setLocal(target, i, [x, y, z, w]),
    glProgramLocalParameter4dARB: (target, i, x, y, z, w) => setLocal(target, i, [x, y, z, w]),
    glProgramLocalParameter4fvARB: (target, i, p) => setLocal(target, i, four(p)),
    glProgramLocalParameter4dvARB: (target, i, p) => setLocal(target, i, four(p, true)),
    glGetProgramEnvParameterfvARB: (target, i, out) => { for (let k = 0; k < 4; k++) dv().setFloat32(out + 4 * k, st.env[target][4 * i + k], true); },
    glGetProgramLocalParameterfvARB: (target, i, out) => { for (let k = 0; k < 4; k++) dv().setFloat32(out + 4 * k, object(target).local[4 * i + k], true); },
    // The limits a GL 2.0-class card answered; under the native limits, always (one translation, no fallback).
    glGetProgramivARB: (target, pname, out) => {
      const p = object(target);
      const v = {
        0x8627: 0, 0x8677: st.bound[target], 0x8876: 0x8875,                      // LENGTH, BINDING, FORMAT (ASCII)
        0x88b6: 1,                                                                  // UNDER_NATIVE_LIMITS
        0x88a0: p.ir?.insts.length ?? 0, 0x88a2: p.ir?.insts.length ?? 0,           // INSTRUCTIONS, NATIVE_INSTRUCTIONS
        0x88a1: 4096, 0x88a3: 4096, 0x88a5: 32, 0x88a7: 32, 0x88ad: 16, 0x88af: 16, // MAX_*: instructions, temporaries, attributes
        0x88b4: MAX_LOCAL, 0x88b5: MAX_ENV, 0x88a9: 96, 0x88ab: 96,                  // MAX_LOCAL/ENV_PARAMETERS, MAX_PARAMETERS
      }[pname] ?? 0;
      dv().setInt32(out, v, true);
    },
    glVertexAttribPointerARB: (i, size, type, norm, stride, ptr) => {
      if (i >= ATTRIBS) throw new Error(`gl: vertex attribute ${i}`);
      Object.assign(st.attribs[i], { size, type, norm: !!norm, stride, ...ctx.layout(type, size, stride), ...ctx.inBuffer(ptr) });
    },
    glEnableVertexAttribArrayARB: (i) => { st.attribs[i].on = true; },
    glDisableVertexAttribArrayARB: (i) => { st.attribs[i].on = false; },
    glVertexAttrib4fARB: (i, x, y, z, w) => { st.attribs[i].value = [x, y, z, w]; },
    glVertexAttrib4fvARB: (i, p) => { st.attribs[i].value = four(p); },
  };
  // the GL 2.0 names of the shared entry points, as a 2.0 driver exports them beside the ARB ones
  api.glVertexAttribPointer = api.glVertexAttribPointerARB;
  api.glEnableVertexAttribArray = api.glEnableVertexAttribArrayARB;
  api.glDisableVertexAttribArray = api.glDisableVertexAttribArrayARB;

  const current = (target) => (s.caps.has(target) ? st.programs.get(st.bound[target])?.ir && object(target) : null) || null;
  /** Whether a draw now is a program draw. */
  const active = () => !!(current(VP) || current(FP));

  // An array's bytes as they stand now: a buffer object's storage moves when it is re-specified.
  const where = (a) => (a.buffer ? (s.buffers.get(a.buffer)?.ptr ?? 0) + a.offset : a.ptr);
  const pad = (v, w = 1) => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? w];
  // What feeds each input the pair reads: an enabled array, or the current value of an array that is off.
  function sourceOf(name) {
    const A = s.arrays;
    if (name === 'pos') return st.attribs[0].on ? { a: st.attribs[0], norm: st.attribs[0].norm } : { a: A.vertex, norm: false };
    if (name === 'col') return A.color.on ? { a: A.color, norm: true } : { c: pad(s.colour) };
    if (name === 'col2') return { c: [0, 0, 0, 1] };
    if (name === 'nrm') return A.normal.on ? { a: A.normal, norm: true } : { c: pad(s.normal, 1) };
    if (name === 'fog') return { c: [0, 0, 0, 1] };
    let m = /^tc(\d+)$/.exec(name);
    if (m) {
      const k = +m[1], a = k === 0 ? A.tex : s.units[k]?.array;
      if (a?.on) return { a, norm: false };
      return { c: pad(k === 0 ? s.tex : (s.units[k]?.coord ?? [0, 0, 0, 1]), 1) };
    }
    m = /^att(\d+)$/.exec(name);
    if (m) { const g = st.attribs[+m[1]]; return g.on ? { a: g, norm: g.norm } : { c: g.value }; }
    throw new Error(`gl: program input ${name}`);
  }

  const f32 = (m) => Float32Array.from(m);
  const transpose = (m) => { const t = new Float64Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t[c * 4 + r] = m[r * 4 + c]; return t; };
  function matrixValue(name) {
    const m = /^(modelview|projection|mvp|texture)(\d*)(?:_(inverse|transpose|invtrans))?$/.exec(name);
    const mv = s.stacks[ctx.MODELVIEW].at(-1), pr = s.stacks[ctx.PROJECTION].at(-1);
    let v = m[1] === 'modelview' ? mv : m[1] === 'projection' ? pr : m[1] === 'mvp' ? ctx.mul(pr, mv)
      : (+m[2] ? s.units[+m[2]].matrix.at(-1) : s.stacks[ctx.TEXTURE_MATRIX].at(-1));
    if (m[3] === 'inverse') v = ctx.invert4(v);
    else if (m[3] === 'transpose') v = transpose(v);
    else if (m[3] === 'invtrans') v = transpose(ctx.invert4(v));
    return f32(v);
  }

  function draw(mode, count, indexAt) {
    const webgl = ctx.webgl();
    if (!webgl) throw new Error('gl: ARB vertex and fragment programs need the WebGL rasteriser (the software one has no programmable stages)');
    const vp = current(VP), fp = current(FP);
    const key = `${vp ? `${st.bound[VP]}.${vp.version}` : '-'}|${fp ? `${st.bound[FP]}.${fp.version}` : '-'}`;
    let link = st.links.get(key);
    if (!link) { link = linkPrograms(vp?.ir ?? null, fp?.ir ?? null); link.key = key; st.links.set(key, link); }
    const el = new Uint32Array(count);
    for (let i = 0; i < count; i++) el[i] = indexAt(i);
    const tri = ctx.triangleIndices(mode, el, false);
    if (!tri) throw new Error(`gl: primitive 0x${mode.toString(16)} under an ARB program is not implemented`);
    if (!tri.length) return;
    let lo = Infinity, hi = -1;
    for (const i of tri) { if (i < lo) lo = i; if (i > hi) hi = i; }
    // Each array's span for those elements; neighbouring spans (interleaved arrays) uploaded once.
    const consts = [], spans = [];
    link.inputs.forEach((name, loc) => {
      const src = sourceOf(name);
      if (src.c) { consts.push({ loc, value: src.c }); return; }
      const a = src.a, base = where(a);
      spans.push({ loc, a, norm: src.norm, start: base + lo * a.step, end: base + hi * a.step + a.size * a.n });
    });
    spans.sort((x, y) => x.start - y.start);
    const ranges = [];
    for (const sp of spans) {
      const r = ranges.at(-1);
      if (r && sp.start <= r.end + 256) { r.end = Math.max(r.end, sp.end); r.spans.push(sp); } else ranges.push({ start: sp.start, end: sp.end, spans: [sp] });
    }
    const uploads = [], attribs = [];
    ranges.forEach((r, i) => {
      const base = r.start & ~3;
      uploads.push(M.u8.slice(base, r.end));
      for (const sp of r.spans) attribs.push({ loc: sp.loc, size: sp.a.size, type: sp.a.type, norm: sp.norm, stride: sp.a.step, range: i, offset: sp.start - base });
    });
    const indices = hi - lo < 65536 ? new Uint16Array(tri.length) : new Uint32Array(tri.length);
    for (let i = 0; i < tri.length; i++) indices[i] = tri[i] - lo;
    // the textures of the fragment program's units, uploaded first if they changed
    const textures = [];
    for (const [u, target] of link.samplers) {
      const cube = target === 'CUBE';
      const id = cube ? (u ? s.units[u].boundCube : s.boundCube) : (u ? s.units[u].bound : s.bound);
      const t = id ? s.textures.get(id) : null;
      if (t && (cube ? !t.cube : t.cube)) throw new Error(`gl: texture ${id} on unit ${u} is not a ${cube ? 'cube map' : '2D texture'}`);
      if (t && t.dirty && !t.gpuOwned) { ctx.upload(id, t); t.dirty = false; }
      textures.push({ unit: u, cube, id: t ? id : 0, params: t ? [t.min, t.mag, t.wrapS, t.wrapT] : null });
    }
    const uniforms = {
      envV: st.env[VP].subarray(0, 4 * link.env.vertex), envF: st.env[FP].subarray(0, 4 * link.env.fragment),
      localV: vp ? vp.local.subarray(0, 4 * link.local.vertex) : null, localF: fp ? fp.local.subarray(0, 4 * link.local.fragment) : null,
      matrices: Object.fromEntries(link.matrices.map((m) => [m, matrixValue(m)])),
    };
    webgl.drawProgram(ctx.gpuState(), link, uploads, attribs, consts, indices, uniforms, textures,
      s.caps.has(ctx.CULL_FACE) ? [s.cullFace, s.frontFace] : null);
    s.stats.triangles += tri.length / 3; s.stats.gpuDraws++;
  }

  return { api, active, draw, state: st,
    errorPosition: () => st.errorPos, errorString: () => st.errorString };
}
