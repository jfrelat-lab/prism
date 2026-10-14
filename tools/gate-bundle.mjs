// gate-bundle.mjs — a program read back from a static bundle is the program that was compiled.
//
// tools/bundle.mjs writes a compiled target as two files, the emitted JavaScript with its link
// tables and the memory image, and loads it again without compiling anything (P13.1). This holds
// the round trip on Lua 5.4, which needs no data: the interpreter is built, bundled, read back
// from disk, and given a script whose output is known in advance -- arithmetic, string library,
// tables, closures, a coroutine, an error caught with pcall. (Its integers are 32 bits here: the target
// builds Lua with LUA_USE_C89.) Three things must hold:
//
//   1. the bundled interpreter prints exactly what the compiled one prints;
//   2. and that is the output the script must have, written here from what the script computes
//      (so 1 is not two wrong answers agreeing);
//   3. nothing of the compiler ran to load it: the sources are not read.
//
// And it has to be able to fail: an image with one page blanked, and link tables with two function
// indices exchanged, must each stop the bundle from producing that output.
//
// MAME 0.34's bundles are held separately, by gate-mame034 with ROMs (frames against a native gcc
// build). This gate is the one that needs nothing but the corpus.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadTarget, buildTarget, loadTargetBundle } from '../src/target.js';
import { writeBundle, readBundle } from './bundle.mjs';
import { loadSnapshot } from '../src/compile.js';
import { skip } from './gate-skip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const target = loadTarget(join(ROOT, 'targets', 'lua.json'));
if (!existsSync(join(ROOT, target.dir))) skip('Lua is not in corpus/', target.fetch);

const SCRIPT = `
local function fib(n) if n < 2 then return n end return fib(n - 1) + fib(n - 2) end
print(fib(24), 2^30 | 0, 7 // 2, 7 % -3, 1e15 + 0.5)
print(string.format("%5.2f|%-6s|%03d|%x", math.pi, "ab", 7, 255), ("prism"):rep(2, "-"):upper())
local t = {} for i = 1, 10 do t[i] = i * i end
table.sort(t, function(a, b) return a > b end)
print(table.concat(t, ","), #t, select("#", table.unpack(t)))
local function counter() local n = 0 return function() n = n + 1 return n end end
local c = counter() c() c()
print(c(), type(counter), tostring(nil), 10 == 10.0, math.type(3), math.type(3.0))
local co = coroutine.wrap(function(a) local b = coroutine.yield(a * 2) coroutine.yield(a + b) return "done" end)
print(co(21), co(1), co())
print(pcall(function() error({ code = 42 }) end), select(2, pcall(error, "boom", 0)))
print(string.find("the quick brown fox", "(%a+) (%a+)$"), ("x"):byte(), utf8 and utf8.char(233, 8364) or "")
`;
// What that script prints, line by line -- from the language, not from a run of it.
const EXPECTED = [
  '46368\t1073741824\t3\t-2\t1e+15',
  ' 3.14|ab    |007|ff\tPRISM-PRISM',
  '100,81,64,49,36,25,16,9,4,1\t10\t10',
  '3\tfunction\tnil\ttrue\tinteger\tfloat',
  '42\t22\tdone',
  // A call that is not the LAST expression of a list gives one value: pcall's `false` alone, then
  // the message; string.find's start alone, then the byte and the two UTF-8 characters.
  'false\tboom',
  '11\t120\té€',
];

const files = { 'gate.lua': new TextEncoder().encode(SCRIPT) };
const run = (program) => {
  try { return String(program.run(['lua', 'gate.lua'])?.stdout ?? ''); }
  catch (e) { return `THREW ${String(e.message).split('\n')[0]}`; }
};
const same = (out) => {
  const text = out.trimEnd().split('\n');
  return text.length === EXPECTED.length && EXPECTED.every((want, i) => text[i] === want);
};

/** How the controls damage a snapshot. */
const DAMAGE = {
  // The page that holds the most: the interpreter's own static data.
  blank(s) {
    const PAGE = 65536, image = s.image.slice();
    let best = 0, most = -1;
    for (let p = 0; p * PAGE < image.length; p++) {
      const n = image.subarray(p * PAGE, (p + 1) * PAGE).reduce((a, b) => a + (b !== 0), 0);
      if (n > most) { most = n; best = p; }
    }
    image.fill(0, best * PAGE, (best + 1) * PAGE);
    return { ...s, image };
  },
  // Every emitted function takes the next one's table index: each pointer now calls a neighbour.
  rotate(s) {
    const own = new Set(s.meta.emitted);
    const idx = s.meta.funcs.filter((f) => own.has(f[0])).map((f) => f[1]);
    let k = 0;
    const funcs = s.meta.funcs.map((f) => (own.has(f[0]) ? [f[0], idx[(++k) % idx.length], f[2]] : f));
    return { ...s, meta: { ...s.meta, funcs } };
  },
};
if (process.argv[2] === '--child') {
  const { snapshot } = await readBundle(process.argv[3], 'lua');
  const program = loadTargetBundle({ name: 'lua', env: target.env }, DAMAGE[process.argv[4]](snapshot), { envExtra: { stdio: { files } } }).program;
  process.stdout.write(run(program), () => process.exit(0));
  await new Promise(() => {});
}

let bad = 0;
const check =(ok, text, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}${!ok && detail ? `\n     ${detail}` : ''}`); if (!ok) bad++; };

const dir = mkdtempSync(join(tmpdir(), 'prism-bundle-'));
try {
  const compiled = run(buildTarget(target, { root: ROOT, envExtra: { stdio: { files } } }).program);
  check(same(compiled), 'the compiled interpreter prints what the script must print', JSON.stringify(compiled.trimEnd().split('\n').filter((l, i) => l !== EXPECTED[i])));

  const sizes = writeBundle(target, dir, 'lua');
  // From here on the sources must not be needed: the loader is handed a target with no directory.
  const bare = { name: 'lua', env: target.env };
  const load = async (edit = (s) => s) => {
    const { snapshot } = await readBundle(dir, 'lua');
    return loadTargetBundle(bare, edit(snapshot), { envExtra: { stdio: { files } } }).program;
  };
  const t0 = Date.now();
  const bundled = run(await load());
  const ms = Date.now() - t0;
  check(bundled === compiled && same(bundled),
    `read back from ${(sizes.js / 1e6).toFixed(2)} MB of JavaScript and ${(sizes.image / 1e6).toFixed(2)} MB of image, it prints the same (${ms} ms to load and run, against ${sizes.seconds.toFixed(1)} s to compile)`,
    bundled.slice(0, 300));

  /*
   * ---- controls: the same bundle, damaged, must not pass. Each runs in a process of its own with
   * a time limit, because a damaged program is as likely to spin for ever as to stop -- the first
   * version of this gate hung on its own control.
   */
  for (const [damage, what] of [['blank', 'with one page of the image blanked'], ['rotate', 'with every function one table index off']]) {
    const r = spawnSync('node', [SELF, '--child', dir, damage], { encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 26 });
    const out = r.error ? `(${r.error.code ?? 'stopped'} after 30 s)` : r.stdout;
    check(!same(out), `control: ${what} the output is not the script's`, out.slice(0, 120));
  }
  /*
   * ---- a program with Turbo Assembler modules. Its PROCs are bound when it loads (tasm-link), at
   * the segments the linker placed and with arguments laid out by their C prototypes; a bundle that
   * lost either could not start Keen Dreams in a static export. Both must read back as compiled, and
   * a snapshot without the prototypes must not.
   */
  const keen = loadTarget(join(ROOT, 'targets', 'keendreams.json'));
  if (existsSync(join(ROOT, keen.dir))) {
    const compiled = buildTarget(keen, { root: ROOT }).program;
    writeBundle(keen, dir, 'keendreams');
    const { snapshot } = await readBundle(dir, 'keendreams');
    const t = (x) => (x ? [x.k, x.name, x.size, x.signed, x.to?.k].join() : '-');
    const sig = (ft) => ft && `${t(ft.ret)}(${(ft.params ?? []).map((p) => t(p.type)).join(';')})`;
    const agree = (loaded) => loaded.funcTypes?.size > 0 && [...loaded.funcTypes].every(([n, ft]) => sig(ft) === sig(compiled.funcTypes.get(n)))
      && compiled.externPlaced.size > 0 && [...compiled.externPlaced].every(([k, v]) => loaded.externPlaced?.get(k) === v);
    const loaded = loadSnapshot(snapshot);
    check(agree(loaded), `Keen Dreams: ${loaded.externPlaced.size} assembly segments and ${loaded.funcTypes.size} prototypes read back as compiled`);
    const { externFuncTypes, ...stripped } = snapshot.meta;
    check(!agree(loadSnapshot({ ...snapshot, meta: stripped })), 'control: without the prototypes the bundle does not agree');
  } else console.log('skip Keen Dreams is not in corpus/');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(bad ? `\n${bad} check(s) failed` : '\na program read back from a static bundle runs as the compiled one does');
process.exit(bad ? 1 : 0);
