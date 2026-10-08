// gate-zlib.mjs — zlib three ways, and they agree.
//
// MAME 0.37b5 links zlib and ships no source for it. PRISM has two answers (P17.1): zlib 1.1.3
// itself, compiled from its own sources (targets/zlib.json), and an imitation in JavaScript of the
// six functions MAME calls (src/env/zlib.js, the `zlib` environment). The compiled library is the
// oracle of the imitation, and a native gcc build is the oracle of the compiled library:
//
//   1. zlib's own example program prints the same under PRISM as under gcc;
//   2. tests/zlib/maker.c -- zlib's DEFLATE at several levels and strategies -- writes the same
//      files, byte for byte, compiled by PRISM and by gcc;
//   3. tests/zlib/probe.c -- unzip.c's inflate loop, uncompress, compress, the checksums, over
//      those files, with the input cut into pieces of 16384, 1000, 257, 7 and 1 bytes -- prints
//      the same linked with gcc's zlib, with PRISM's compiled zlib, and with the imitation;
//   4. what each library's `compress` writes, the other's `uncompress` expands to the same bytes
//      (the imitation stores where zlib squeezes: different streams, both valid).
//
// And the imitation can be caught: a checksum polynomial, a checksum modulus, a length base and a
// distance base, each moved by one, each make step 3 fail.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';
import { ZLIB_RULES } from '../src/env/zlib.js';
import { sh, SCRATCH } from './oracle.mjs';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const target = loadTarget(join(ROOT, 'targets', 'zlib.json'));
const SRC = join(ROOT, target.dir);
if (!existsSync(SRC)) skip('zlib 1.1.3 is not in corpus/', target.fetch);

const LIB = target.units.list.filter((u) => u !== 'example.c');
const test = (f) => readFileSync(join(ROOT, 'tests', 'zlib', f), 'latin1');
let bad = 0;
const check = (ok, text, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}${!ok && detail ? `\n     ${detail}` : ''}`); if (!ok) bad++; };
const firstDiff = (a, b) => { const x = a.split('\n'), y = b.split('\n'); const i = x.findIndex((l, k) => l !== y[k]); return i < 0 ? `lengths ${x.length} and ${y.length}` : `line ${i + 1}: "${x[i]}" against "${y[i]}"`; };

/** Run a program built from `t` with these files and arguments: { out, files }. */
function run(t, files = {}, argv = []) {
  const { program } = buildTarget(t, { root: ROOT, envExtra: { stdio: { files } } });
  let out;
  try { out = String(program.run([t.name, ...argv])?.stdout ?? ''); }
  catch (e) { out = `THREW ${String(e.message).split('\n')[0]}`; }
  return { out, files: Object.fromEntries([...program.M.files.store].map(([k, v]) => [k, Uint8Array.from(v)])) };
}
// The real library with one test program, and the imitation with the same one.
const withReal = (name, src) => ({ ...target, name, units: { list: LIB }, include: ['.'], inline: { [`${name}.c`]: src } });
const withImitation = (name) => ({ name, dir: 'tests/zlib', units: { list: [`${name}.c`] },
  compile: { memory: 32, collect: true }, env: ['stdio', 'zlib'] });

// ---- gcc's side, in the oracle container: the same sources, the same tests
const work = join(SCRATCH, 'zlib');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
try {
  for (const u of [...target.units.list, 'zlib.h', 'zconf.h', 'deflate.h', 'zutil.h', 'trees.h', 'infblock.h', 'inftrees.h', 'infcodes.h', 'infutil.h', 'inffast.h', 'inffixed.h']) {
    cpSync(join(SRC, u), join(work, u));
  }
  for (const f of ['probe.c', 'maker.c']) writeFileSync(join(work, f), test(f));
  const cc = 'gcc -m32 -O0 -w -std=gnu89 -I.';
  const lib = LIB.join(' ');
  const built = sh(`cd zlib && ${cc} -o example ${lib} example.c && ${cc} -o maker ${lib} maker.c && ${cc} -o probe ${lib} probe.c && echo BUILT`, { timeout: 300000 });
  if (!/BUILT/.test(built.stdout)) { console.log(`FAIL gcc could not build zlib: ${(built.stdout + built.stderr).trim().split('\n').slice(-3).join(' | ')}`); process.exit(1); }

  // 1. zlib's own example
  const exampleGcc = sh('cd zlib && ./example 2>&1').stdout;
  const examplePrism = run(target).out;
  check(examplePrism === exampleGcc && /inflate with dictionary: hello, hello!/.test(exampleGcc),
    `zlib's own example prints the same under PRISM as under gcc (${exampleGcc.trim().split('\n').length} lines)`, firstDiff(examplePrism, exampleGcc));

  // 2. deflate, byte for byte
  const made = run(withReal('maker', test('maker.c')));
  const count = +made.out.trim();
  const madeGcc = sh('cd zlib && ./maker').stdout.trim();
  const kinds = ['plain', 'raw', 'wrap'];
  const same = [], differ = [];
  for (let n = 0; n < count; n++) for (const k of kinds) {
    const a = made.files[`${k}.${n}`], b = existsSync(join(work, `${k}.${n}`)) ? readFileSync(join(work, `${k}.${n}`)) : null;
    (a && b && a.length === b.length && a.every((x, i) => x === b[i]) ? same : differ).push(`${k}.${n}`);
  }
  const bytes = same.reduce((s, f) => s + made.files[f].length, 0);
  check(count >= 9 && String(count) === madeGcc && !differ.length,
    `zlib's deflate writes the same ${same.length} files compiled by PRISM and by gcc (${bytes.toLocaleString('en')} bytes)`, `differ: ${differ.join(' ')}`);
  const streams = Object.fromEntries(Object.entries(made.files).filter(([k]) => /^(plain|raw|wrap)\.\d+$/.test(k)));

  // 3 and 4. the probe, three ways, each expanding what another one compressed
  const first = { real: run(withReal('probe', test('probe.c')), streams, [String(count)]), imitation: run(withImitation('probe', test('probe.c')), streams, [String(count)]) };
  const packed = (r) => Object.fromEntries(Object.entries(r.files).filter(([k]) => /^packed\.\d+$/.test(k)).map(([k, v]) => [k.replace('packed', 'other'), v]));
  const probeReal = run(withReal('probe', test('probe.c')), { ...streams, ...packed(first.imitation) }, [String(count)]).out;
  const imitationOf = () => run(withImitation('probe', test('probe.c')), { ...streams, ...packed(first.real) }, [String(count)]).out;
  const probeImitation = imitationOf();
  for (const [k, v] of Object.entries(packed(first.imitation))) writeFileSync(join(work, k), v);
  const probeGcc = sh(`cd zlib && ./probe ${count} 2>&1`, { timeout: 300000 }).stdout;
  const lines = probeGcc.trim().split('\n');
  check(probeReal === probeGcc && lines.length > 100, `the probe prints the same with PRISM's compiled zlib as with gcc's (${lines.length} lines)`, firstDiff(probeReal, probeGcc));
  check(probeImitation === probeGcc, `...and the same again with the IMITATION in JavaScript`, firstDiff(probeImitation, probeGcc));
  const crossed = lines.filter((l) => /the other library's compress: 0 same 1$/.test(l)).length;
  const refused = lines.filter((l) => /a byte flipped: refused or different$/.test(l)).length;
  check(crossed === count, `each library expands what the other compressed: ${crossed} of ${count}`);
  check(refused >= count - 2, `a stream with a byte flipped is not taken for the data (${refused} of ${count}; a flip in the empty stream has nothing to hit)`);

  /*
   * How much INPUT inflate has taken at each return (tests/zlib/count.c prints total_in, total_out,
   * avail_in and the code after every call). Given all the room at once -- unzip.c's call -- the
   * imitation is zlib call for call, and that is held. Given room 64 bytes at a time it is NOT:
   * zlib reads ahead into a 32 KB window of its own, the imitation stops at the caller's room.
   * Only where the two END is held there, and the size of the difference is printed, not hidden.
   */
  const counted = (t, room) => run(t, streams, [String(count), String(room)]).out.trim().split('\n');
  const countReal = (room) => counted(withReal('count', test('count.c')), room);
  const countImitation = (room) => counted(withImitation('count'), room);
  const allReal = countReal(0), allImitation = countImitation(0);
  // total_out is compared apart: mid-stream the imitation is a few bytes AHEAD, having decoded a
  // symbol zlib is still waiting to see the bits beyond (its table look-ahead). Held where streams end.
  const inputOnly = (ls) => ls.map((l) => l.replace(/ out \d+/, '')).join('\n');
  check(allReal.length > 10000 && inputOnly(allReal) === inputOnly(allImitation),
    `given all the room at once, total_in, avail_in and the return code are zlib's after each of ${allReal.length} inflate calls`,
    firstDiff(inputOnly(allImitation), inputOnly(allReal)));
  {
    const out = (l) => +l.split(' out ')[1].split(' ')[0];
    let off = 0, most = 0;
    allReal.forEach((l, i) => { const d = out(allImitation[i]) - out(l); if (d) off++; most = Math.max(most, Math.abs(d)); });
    console.log(`     (not held, and measured: mid-stream total_out differs after ${off} of those calls, by at most ${most} bytes -- the imitation writes a symbol zlib is still looking ahead of)`);
  }
  const ends = (ls) => { const m = new Map(); for (const l of ls) m.set(l.split(' ')[0], l.replace(/^\S+ #\d+ in \d+ /, '').replace(/ left \d+/, '')); return [...m].join('|'); };
  const fewReal = countReal(64), fewImitation = countImitation(64);
  const keyed = new Map(fewImitation.map((l) => [l.split(' ').slice(0, 2).join(' '), +l.split(' in ')[1].split(' ')[0]]));
  let both = 0, equal = 0, ahead = 0;
  for (const l of fewReal) {
    const k = l.split(' ').slice(0, 2).join(' ');
    if (!keyed.has(k)) continue;
    const d = +l.split(' in ')[1].split(' ')[0] - keyed.get(k);
    both++; if (d === 0) equal++; ahead = Math.max(ahead, d);
  }
  check(ends(fewReal) === ends(fewImitation), 'given room 64 bytes at a time, every stream ends with the same output and the same code');
  console.log(`     (not held, and measured: on the way there total_in is zlib's after ${equal} of ${both} calls; zlib is ahead by up to ${ahead.toLocaleString('en')} bytes)`);

  // ---- the imitation can be caught: each rule moved by one must break the agreement
  const mutate = (what, apply, undo) => {
    apply();
    let out;
    try { out = imitationOf(); } finally { undo(); }
    check(out !== probeGcc, `control: ${what} is seen`);
  };
  mutate('the CRC polynomial with one bit changed', () => { ZLIB_RULES.crcPoly ^= 2; }, () => { ZLIB_RULES.crcPoly ^= 2; });
  mutate('the Adler modulus one short', () => { ZLIB_RULES.adlerBase--; }, () => { ZLIB_RULES.adlerBase++; });
  // The shortest match, which every compressed stream here uses: a base no stream reaches is a
  // control that cannot fire (index 12 was tried first, and was not seen).
  mutate('the shortest length one too long', () => { ZLIB_RULES.lenBase[0]++; }, () => { ZLIB_RULES.lenBase[0]--; });
  mutate('a distance base one too far', () => { ZLIB_RULES.distBase[9]++; }, () => { ZLIB_RULES.distBase[9]--; });
  check(imitationOf() === probeGcc, 'and with the rules put back it agrees again');
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(bad ? `\n${bad} check(s) failed` : '\nzlib compiled by PRISM is gcc\'s zlib, and the imitation in JavaScript answers as both do');
process.exit(bad ? 1 : 0);
