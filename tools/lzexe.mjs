// lzexe.mjs — unpack the load image of an LZEXE 0.91 executable ("LZ91" at offset 1Ch).
//
// Keen Dreams' shipped KDREAMS.EXE is packed this way, and the resources its build linked in (map
// headers, Huffman dictionaries) are only readable once it is unpacked. The image comes back without
// its relocation table: enough to find data in, not to run.
//
// The bit stream is UNLZEXE's reading of LZ91: 16-bit little-endian control words consumed from the
// low bit; 1 = a literal byte; 0,0,b,b = a copy of 2-5 bytes from a byte-sized negative span; 0,1 = a
// 13-bit span and a length from 3 bits, or from the next byte (0 ends, 1 marks a segment change).

export function unlzexe(exe) {
  if (exe.toString('latin1', 0x1c, 0x20) !== 'LZ91') throw new Error('lzexe: not an LZEXE 0.91 executable');
  let p = exe.readUInt16LE(8) * 16;
  const out = [];
  const byte = () => exe[p++];
  const word = () => { const v = exe.readUInt16LE(p); p += 2; return v; };
  let buf = word(), bits = 16;
  const bit = () => {
    const b = buf & 1;
    buf >>>= 1;
    if (--bits === 0) { buf = word(); bits = 16; }
    return b;
  };
  for (;;) {
    if (bit()) { out.push(byte()); continue; }
    let len, span;
    if (!bit()) {
      len = ((bit() << 1) | bit()) + 2;
      span = byte() - 0x100;
    } else {
      const lo = byte(), hi = byte();
      span = (lo | ((hi & 0xf8) << 5) | 0xe000) - 0x10000;
      len = hi & 7;
      if (len === 0) {
        len = byte();
        if (len === 0) break;
        if (len === 1) continue;
        len += 1;
      } else len += 2;
    }
    for (let k = 0; k < len; k++) out.push(out[out.length + span]);
  }
  return Buffer.from(out);
}
