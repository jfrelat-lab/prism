// omf.mjs — read an Intel OMF object file (src/asm/omf.js), and link one as a linker would, for the
// oracles that run TASM's and BCC's object code.
import { readFileSync } from 'node:fs';
import { readOmf as readOmfBytes } from '../src/asm/omf.js';

export const readOmf = (path) => readOmfBytes(readFileSync(path), path);

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
