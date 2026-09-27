// gate-skip.mjs — how a gate says it could not run, as distinct from failing.
//
// A gate that needs something the repository does not ship -- a corpus fetched separately, game data
// the user supplies, a package in the oracle container -- and does not find it has NOT failed: it has
// said nothing. Reporting that as red trains everyone to read red as "probably the usual", which is
// how a real failure beside it goes unseen. So it exits 77, automake's code for SKIP, and says what
// is missing and how to supply it. tools/gates.mjs counts 77 as skipped and anything else non-zero
// as failed.
//
// What is NOT a skip: a golden the repository commits and cannot find, or a probe that fails. Those
// mean the tree is broken, and they stay failures.

export const SKIP_CODE = 77;

export function skip(what, remedy) {
  console.log(`SKIP: ${what}${remedy ? `\n      ${remedy}` : ''}`);
  process.exit(SKIP_CODE);
}
