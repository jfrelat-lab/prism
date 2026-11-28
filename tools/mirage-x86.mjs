// mirage-x86.mjs — the Node side of src/asm/x86-mirage.js: the vendored MIRAGE core by default, or a
// MIRAGE checkout under development (--mirage=<dir> in the harnesses, or $PRISM_MIRAGE), so a change
// to MIRAGE can be tried against PRISM before it is vendored (tools/vendor-mirage.mjs).
import { join } from 'node:path';
import { installX86Mirage, installTargetX86 } from '../src/asm/x86-mirage.js';

async function machineFrom(mirage) {
  if (!mirage) return null;
  return (await import(join(mirage, 'src', 'machine.js'))).Machine;
}

export async function installMirageX86(program, { mirage = process.env.PRISM_MIRAGE ?? null, builders = [] } = {}) {
  return installX86Mirage(program, { builders, Machine: await machineFrom(mirage) });
}

export async function installTargetX86Node(program, x86, { mirage = process.env.PRISM_MIRAGE ?? null } = {}) {
  return installTargetX86(program, x86, { Machine: await machineFrom(mirage) });
}
