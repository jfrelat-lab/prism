// gate-lua.mjs — Lua's own test suite, as an oracle.
//
//   node tools/gate-lua.mjs [--only=strings,math] [--verbose]
//
// Lua ships thirty-three test files built on `assert()`, and every one of them prints "OK" when it
// reaches the end. That makes them a gate of exactly the kind c-testsuite and Csmith already are,
// with one difference worth the trip: they exercise semantics no game in the corpus touches --
// coroutines, garbage collection, metatables, integer/float coercion, the C API's own limits.
//
// A FRESH program per file, deliberately. Lua's tests leave globals, open files and a loaded package
// table behind, and several assert on a clean state; reusing one interpreter would make the result
// depend on the order they ran in. Compiling costs about a second, which is the price of a result
// that means something.
//
// `all.lua` is excluded: it drives the others itself, and running it here would report one verdict
// where thirty-three are available.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget, buildTarget } from '../src/target.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TESTES = join(ROOT, 'corpus/lua/testes');
const argv = process.argv.slice(2);
const opt = (n) => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
const verbose = argv.includes('--verbose');

/*
 * Files this gate does not run, each for a stated reason rather than because it failed.
 *
 * They are the ones whose subject is the HOST rather than the language: how much C stack there is,
 * how a real filesystem behaves, how much memory can be exhausted. A gate that reported those as
 * language failures would be measuring the harness.
 */
const SKIP = {
  'all.lua': 'drives the others; running it hides thirty-three verdicts behind one',
  'cstack.lua': 'measures C-stack depth, which here is the JavaScript stack',
  'heavy.lua': 'deliberately exhausts memory; the point is the limit, not the semantics',
  'verybig.lua': 'needs several gigabytes to say anything',
  'big.lua': 'the same, one size down',
  'main.lua': 'drives the INTERPRETER as an external process -- it takes arg[-1] as a program name\n               and shells out to it, so what it measures is the host shell, not the language',
};

if (!statSync(TESTES, { throwIfNoEntry: false })) {
  console.error(`corpus missing: ${TESTES}\nFetch it with:\n` +
    `  git clone --depth 1 -b v5.4.7 https://github.com/lua/lua.git corpus/lua`);
  process.exit(2);
}

const only = opt('only')?.split(',').map(s => s.trim()).filter(Boolean) ?? null;
const files = readdirSync(TESTES).filter(f => f.endsWith('.lua')).sort()
  .filter(f => !(f in SKIP))
  .filter(f => !only || only.some(o => f === o || f === `${o}.lua`));

/* The whole directory is visible to each run: several tests read and write files beside themselves. */
const data = {};
for (const f of readdirSync(TESTES)) {
  const p = join(TESTES, f);
  if (statSync(p).isFile()) data[f] = new Uint8Array(readFileSync(p));
}

const target = loadTarget(join(ROOT, 'targets/lua.json'));
const results = [];

for (const f of files) {
  const out = [];
  let verdict, detail = '';
  try {
    const { program } = buildTarget(target, { root: ROOT, envExtra: { stdio: { files: { ...data } } } });
    program.M.write = (s) => out.push(s);
    program.run(['lua', f]);
    const text = out.join('');
    /*
     * These tests are built on `assert`, so REACHING THE END is what passing means -- the "OK" some
     * of them print is a courtesy, and several print nothing at all (bwcoercion.lua ends on a
     * function definition; utf8.lua says "ok" in lower case). Judging on the word cost four wrong
     * verdicts in the first run.
     *
     * Two things do mean failure: a Lua traceback in the output, which is what a caught assertion
     * leaves behind even when the process then exits cleanly, and an exception out of run().
     * And a test that says it is skipping -- api.lua and code.lua need Lua's own C test library,
     * which is not compiled here -- has neither passed nor failed.
     */
    if (/stack traceback:/.test(text)) {
      verdict = 'failed';
      const at = text.trimEnd().split('\n').filter(l => /\.lua:\d+/.test(l)).pop();
      detail = (at ?? '').trim().slice(0, 110);
    } else if (/skipping .*tests/i.test(text)) {
      verdict = 'skipped';
      detail = (text.match(/>>>[^<]*<<</) ?? [''])[0].slice(0, 80);
    } else {
      verdict = 'ok';
    }
  } catch (e) {
    verdict = 'failed';
    const text = out.join('');
    // The last thing it printed says more than the JavaScript exception: Lua's own traceback names
    // the file and line its assert was on.
    const lines = text.trimEnd().split('\n').filter(Boolean);
    const at = lines.reverse().find(l => /\.lua:\d+/.test(l));
    detail = (at ?? String(e.message)).trim().slice(0, 110);
  }
  results.push({ f, verdict, detail, out: out.join('') });
  if (verbose) console.log(`${verdict.padEnd(7)} ${f}${detail ? '  ' + detail : ''}`);
}

const ok = results.filter(r => r.verdict === 'ok');
const skipped = results.filter(r => r.verdict === 'skipped');
console.log(`\nLua ${results.length} test files: ${ok.length} pass, ` +
  `${results.filter(r => r.verdict === 'failed').length} fail, ` +
  `${skipped.length} skipped by the test itself`);

for (const r of results.filter(x => x.verdict !== 'ok')) {
  console.log(`  ${r.f.padEnd(16)} ${r.verdict.padEnd(7)} ${r.detail}`);
}
console.log(`\nskipped by name: ${Object.keys(SKIP).join(' ')}`);
if (Object.keys(SKIP).length && verbose) {
  for (const [f, why] of Object.entries(SKIP)) console.log(`  ${f.padEnd(16)} ${why}`);
}

// A gate is red when something that used to pass stops. The count is the number to watch.
process.exit(ok.length + skipped.length === results.length ? 0 : 1);
