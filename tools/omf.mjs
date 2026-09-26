// omf.mjs — read an Intel OMF object file (what TASM and BCC write) far enough to use it as an oracle.
//
// Records read: THEADR, LNAMES, SEGDEF, GRPDEF, EXTDEF, PUBDEF, LEDATA, LIDATA (refused), FIXUPP,
// MODEND; COMENT and the debug records are skipped. What comes out: segments with their bytes, the
// public symbols with their segment and offset, the external names, and the fixups by position --
// enough to compare an assembler's view of a module with PRISM's.
import { readFileSync } from 'node:fs';

export function readOmf(path) {
  const b = readFileSync(path);
  let p = 0;
  const lnames = [''];
  const segs = [null];
  const groups = [null];
  const externs = [null];
  const publics = [];
  const fixups = [];
  let lastData = null;
  const idx = (q) => { let v = b[q.p++]; if (v & 0x80) v = ((v & 0x7f) << 8) | b[q.p++]; return v; };
  const str = (q) => { const n = b[q.p++]; const s = b.toString('latin1', q.p, q.p + n); q.p += n; return s; };
  while (p + 3 <= b.length) {
    const type = b[p], len = b.readUInt16LE(p + 1);
    const q = { p: p + 3 };
    const end = p + 3 + len - 1;           // before the checksum
    const t = type & 0xfe, wide = type & 1;
    if (t === 0x96) { while (q.p < end) lnames.push(str(q)); }
    else if (t === 0x98) {
      const attr = b[q.p++];
      if ((attr >> 5) === 0) q.p += 3;
      const size = wide ? b.readUInt32LE(q.p) : b.readUInt16LE(q.p); q.p += wide ? 4 : 2;
      const name = lnames[idx(q)], cls = lnames[idx(q)];
      segs.push({ name, cls, size: (attr & 2) && !size ? 0x10000 : size, bytes: new Uint8Array((attr & 2) && !size ? 0x10000 : size) });
    } else if (t === 0x9a) {
      const name = lnames[idx(q)];
      const members = [];
      while (q.p < end) { q.p++; members.push(segs[idx(q)]?.name); }
      groups.push({ name, members });
    } else if (t === 0x8c) { while (q.p < end) { externs.push(str(q)); idx(q); } }
    else if (t === 0x90) {
      const g = idx(q), s = idx(q);
      if (!s) q.p += 2;
      while (q.p < end) {
        const name = str(q);
        const off = wide ? b.readUInt32LE(q.p) : b.readUInt16LE(q.p); q.p += wide ? 4 : 2;
        idx(q);
        publics.push({ name, seg: segs[s]?.name ?? null, group: groups[g]?.name ?? null, offset: off });
      }
    } else if (t === 0xa0) {
      const s = idx(q);
      const off = wide ? b.readUInt32LE(q.p) : b.readUInt16LE(q.p); q.p += wide ? 4 : 2;
      const data = b.subarray(q.p, end);
      segs[s].bytes.set(data, off);
      lastData = { seg: segs[s], off };
    } else if (t === 0xa2) {
      throw new Error(`omf: LIDATA in ${path} is not read`);
    } else if (t === 0x9c) {
      while (q.p < end) {
        const lo = b[q.p++];
        if (!(lo & 0x80)) { q.p += 0; throw new Error(`omf: FIXUPP THREAD records in ${path} are not read`); }
        const hi = b[q.p++];
        const locat = ((lo << 8) | hi);
        const at = locat & 0x3ff, loc = (lo >> 2) & 0xf, segRel = !!(lo & 0x40);
        const fixdat = b[q.p++];
        const F = !!(fixdat & 0x80), frame = (fixdat >> 4) & 7, T = !!(fixdat & 8), P = !!(fixdat & 4), tgt = fixdat & 3;
        if (F) throw new Error('omf: frame threads are not read');
        let frameDatum = null;
        if (frame < 3) frameDatum = idx(q);
        if (T) throw new Error('omf: target threads are not read');
        const targetDatum = idx(q);
        let disp = 0;
        if (!P) { disp = wide ? b.readUInt32LE(q.p) : b.readUInt16LE(q.p); q.p += wide ? 4 : 2; }
        const target = tgt === 0 ? { seg: segs[targetDatum]?.name } : tgt === 1 ? { group: groups[targetDatum]?.name }
          : tgt === 2 ? { extern: externs[targetDatum] } : { frame: targetDatum };
        fixups.push({ seg: lastData.seg.name, at: lastData.off + at, loc, segRel, frame, frameDatum, target, disp });
      }
    }
    if (type === 0x8a || type === 0x8b) break;
    p += 3 + len;
  }
  return { segments: segs.slice(1), groups: groups.slice(1), externs: externs.slice(1), publics, fixups };
}

/**
 * Relocate an object's segments as a linker would, for the given placement:
 * { segs: { name: linear }, groups: { name: linear }, externs: { name: linear } }. Returns
 * [{ name, base, bytes }] with every fixup applied. A fixup ADDS to the bytes already there, which
 * is where TASM leaves the offset inside the target segment.
 */
export function linkOmf(o, { segs, groups, externs }) {
  const out = new Map(o.segments.map((s) => {
    if (segs[s.name] === undefined) throw new Error(`omf: no place for segment ${s.name}`);
    return [s.name, { name: s.name, base: segs[s.name], bytes: Uint8Array.from(s.bytes) }];
  }));
  const segOf = (name) => o.groups.find((g) => g.members.includes(name))?.name;
  const baseOf = (t) => {
    if (t.seg !== undefined) return segs[t.seg];
    if (t.group !== undefined) return groups[t.group];
    if (t.extern !== undefined) return externs[t.extern];
    return undefined;
  };
  for (const f of o.fixups) {
    const loc = out.get(f.seg);
    const target = baseOf(f.target);
    if (target === undefined) throw new Error(`omf: no address for fixup target ${JSON.stringify(f.target)}`);
    const T = target + f.disp;
    // The frame: 0 a segment, 1 a group, 4 the location's own segment, 5 the target's.
    let F;
    if (f.frame === 0) F = segs[o.segments[f.frameDatum - 1].name];
    else if (f.frame === 1) F = groups[o.groups[f.frameDatum - 1].name];
    else if (f.frame === 4) F = loc.base;
    else if (f.frame === 5) {
      const t = f.target;
      F = t.seg !== undefined ? (segOf(t.seg) ? groups[segOf(t.seg)] : segs[t.seg]) : t.group !== undefined ? groups[t.group] : null;
      if (F === null) throw new Error('omf: frame of an external target');
    } else throw new Error(`omf: frame method ${f.frame}`);
    if (!f.segRel) throw new Error(`omf: a self-relative fixup in ${f.seg} at ${f.at}`);
    const view = new DataView(loc.bytes.buffer);
    if (f.loc === 1) view.setUint16(f.at, (view.getUint16(f.at, true) + T - F) & 0xffff, true);
    else if (f.loc === 2) view.setUint16(f.at, (view.getUint16(f.at, true) + (F >> 4)) & 0xffff, true);
    else if (f.loc === 3) {
      view.setUint16(f.at, (view.getUint16(f.at, true) + T - F) & 0xffff, true);
      view.setUint16(f.at + 2, (view.getUint16(f.at + 2, true) + (F >> 4)) & 0xffff, true);
    } else throw new Error(`omf: fixup location type ${f.loc}`);
  }
  return [...out.values()];
}
