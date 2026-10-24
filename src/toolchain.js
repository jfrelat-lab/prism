// toolchain.js — compile options a program's ORIGINAL toolchain implies, before its target says more.
//
// Some behaviour C leaves unspecified is a property of the compiler a program was built with, not of
// the program: a target naming the Watcom environment was built by Watcom, and its code evaluated a
// call's arguments right to left. A demo recorded by that build replays only if the random numbers
// land where Watcom's code put them (tools/gate-watcom-argorder.mjs holds this to wcc386).
//
// Browser-safe on purpose: src/target.js (Node) and web/worker.js (the page) both read it, so a
// program compiles the same way in either.

const BY_ENV = {
  watcom: { argOrder: 'rtl' },
};

/** The compile options implied by a target's environments; the target's own `compile` wins over them. */
export function toolchainCompile(env = []) {
  return Object.assign({}, ...(Array.isArray(env) ? env : Object.keys(env ?? {})).filter((e) => BY_ENV[e]).map((e) => BY_ENV[e]));
}
