// gen-d3dx-noise.mjs — HLSL's noise() as D3DX has it, for the tx_1_0 texture shaders src/env/hlsl.js
// translates: src/env/d3dx-noise.js, its two tables, read from Microsoft's d3dx9_33.dll -- the gradients regenerated.
//
//   node tools/gen-d3dx-noise.mjs        reads corpus/d3dx9_33/d3dx9_33.dll (D3DX 9.18.904.15)
//
// noise(float3) is only legal in tx_ profiles, which D3DX runs on the CPU (D3DXFillTextureTX); Wine has
// stubs for both, so there is no other reference. The routine, at 0x47f71d in that DLL, is Ken Perlin's
// 1985 noise3 (his reference noise.c) with three differences, read from its code:
//   - the offset added before truncation is 10000.0, not 0x1000: so the lattice index is (x + 10000) & 255,
//     and x + 10000 is stored as a float, which quantises the fraction to 1/1024 near 0;
//   - the result is multiplied by 1.5;
//   - its tables are constants in the DLL, not made by an init(): the permutation p[514] (int32) at file
//     offset 0x27e8 (VA 0x4033e8) and the gradients g3[514] (float32 x3) at 0x2ff0 (VA 0x403bf0), each with
//     its first 256 (+2) entries repeated, as Perlin's. The permutation is not one: p[253] repeats p[0]'s 0
//     and 253 is absent. It is copied as it is.
// The interpolant is Perlin's s-curve t*t*(3 - 2t). tools/oracle/txref.c runs the DLL itself under Wine,
// and tools/gate-d3dx-tx.mjs holds PRISM to it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DLL = join(ROOT, 'corpus/d3dx9_33/d3dx9_33.dll');
const SHA256 = 'c6b7b2ad7742dde5dd8d1a35fdc1c185e586e551ad9c74d3fb21759cd8ca4da8';
if (!existsSync(DLL)) { console.log(`no ${DLL}: Microsoft's d3dx9_33.dll (DirectX April 2007, 9.18.904.15), sha256 ${SHA256}`); process.exit(1); }
const d = readFileSync(DLL);
const sha = createHash('sha256').update(d).digest('hex');
if (sha !== SHA256) throw new Error(`${DLL}: sha256 ${sha}, not the d3dx9_33.dll these offsets were read from`);
// The routine's first table read, `mov eax, [0x4033e8 + ecx*4]`, and its gradient base, `mov eax, 0x403bf0`.
const at = (va) => va - 0x400000 - 0x1000 + 0x400;
if (d.readUInt32LE(at(0x47f7b8) + 3) !== 0x4033e8 || d.readUInt32LE(at(0x47f834) + 1) !== 0x403bf0) throw new Error('the noise routine does not read the tables where expected');
const P = Array.from({ length: 514 }, (_, i) => d.readInt32LE(0x27e8 + 4 * i));
const G = Array.from({ length: 514 * 3 }, (_, i) => d.readFloatLE(0x2ff0 + 4 * i));
for (let i = 0; i < 258; i++) {
  if (P[256 + i] !== P[i] || [0, 1, 2].some((c) => G[3 * (256 + i) + c] !== G[3 * i + c])) throw new Error(`entry ${256 + i} does not repeat entry ${i}: the masks by 255 in hlsl.js would be wrong`);
}
if (P.some((v) => v < 0 || v > 255)) throw new Error('a permutation entry outside 0..255');
// The gradients are not shipped: they are what Perlin's init() makes with MSVC's rand() from its default
// seed, drawn by rejection (three draws, again until the vector falls in the unit ball) and normalised. Made
// so in src/env/d3dx-noise.js, they are checked here against the DLL's: the normalisation is not D3DX's to
// the bit (34 of 768 components equal), at most 5.4e-7 apart, which moves noise() by ~1e-6.
writeFileSync(join(ROOT, 'src/env/d3dx-noise.js'), `// HLSL's noise() as D3DX runs it: Perlin's 1985 noise3 with D3DX's tables, checked against Microsoft's
// d3dx9_33.dll by tools/gen-d3dx-noise.mjs (which writes this file and says what was read where).
/** The permutation, its first 256 entries (D3DX repeats them), as the DLL holds it: p[253] repeats p[0]'s 0. */
export const NOISE_P = [${P.slice(0, 256).join(',')}];
/** The gradients, unit vectors x, y, z: Perlin's init() on MSVC's rand() (seed 1), each drawn by rejection. */
export const NOISE_G = (() => {
  let x = 1;
  const rand = () => ((x = (Math.imul(x, 214013) + 2531011) >>> 0) >>> 16) & 0x7fff;
  const g = [];
  for (let i = 0; i < 256; i++) {
    let v, l;
    do { v = [0, 1, 2].map(() => ((rand() % 512) - 256) / 256); l = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]; } while (!(l > 0 && l <= 1));
    const s = Math.sqrt(l);
    g.push(...v.map((c) => Math.fround(c / s)));
  }
  return g;
})();
`);
const { NOISE_G: G2 } = await import(`../src/env/d3dx-noise.js?${Date.now()}`);
const worst = Math.max(...G2.map((v, i) => Math.abs(v - G[i])));
if (!(worst <= 6e-7)) throw new Error(`the gradients made from rand() are ${worst} from the DLL's`);
console.log(`src/env/d3dx-noise.js: the permutation (256 entries) and the gradients' generator, ${worst.toExponential(1)} from the DLL's at worst`);
