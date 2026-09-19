// gate-include-case.mjs — a caseInsensitive target finds PRISM's own headers the way DOS would.
//
// DOS trees write <STDIO.H>. PRISM supplies stdio.h. A target that declares caseInsensitive gets
// the two treated as one name -- as a LAST resort, after every exact spelling has failed -- and a
// target that does not declare it gets nothing of the kind. The cases, each with a reason:
//
//   <STDIO.H>, caseInsensitive        resolves to PRISM's stdio.h, and is REPORTED as case-folded
//   <SYS/STAT.H>, caseInsensitive     the same through a directory component
//   <stdio.h>, caseInsensitive        exact spelling: resolves and is NOT reported as folded
//   <STDIO.H>, case-sensitive target  stays missing -- nothing changes for a target that did not ask
//   <FOO.H> with Foo.h AND FOO.h      two spellings fold to one name: never chosen between, missing
//
// Disable the fold in src/target.js and the first two go red; make it pick the first of several
// spellings and the last one does.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeResolver } from '../src/target.js';

const dir = mkdtempSync(join(tmpdir(), 'prism-case-'));       // an empty tree: only PRISM's headers
const run = (name, { ci, env = {} }) => {
  const missing = new Set(), dos = new Set(), cased = new Set();
  const r = makeResolver(dir, { caseInsensitive: ci }, missing, dos, env, cased);
  const hit = r(name, true, null);
  return { found: !missing.has(name) && hit.text !== '', path: hit.path, folded: cased.has(name) };
};

const cases = [
  ['<STDIO.H>, caseInsensitive', run('STDIO.H', { ci: true }), { found: true, folded: true }],
  ['<SYS/STAT.H>, caseInsensitive', run('SYS/STAT.H', { ci: true }), { found: true, folded: true }],
  ['<stdio.h>, caseInsensitive', run('stdio.h', { ci: true }), { found: true, folded: false }],
  ['<STDIO.H>, case-sensitive target', run('STDIO.H', { ci: false }), { found: false, folded: false }],
  ['<FOO.H>, two spellings fold to it',
    run('FOO.H', { ci: true, env: { 'Foo.h': '/* a */', 'FOO.h': '/* b */' } }), { found: false, folded: false }],
];
rmSync(dir, { recursive: true, force: true });

let bad = 0;
for (const [what, got, want] of cases) {
  const ok = got.found === want.found && got.folded === want.folded;
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(36)} found=${got.found} folded=${got.folded}` +
    (got.found ? `  -> ${got.path}` : ''));
}
console.log(bad ? `\n${bad} of ${cases.length} WRONG`
  : `\nPRISM's headers resolve case-insensitively only where a target asks: ${cases.length}/${cases.length}`);
process.exit(bad ? 1 : 0);
