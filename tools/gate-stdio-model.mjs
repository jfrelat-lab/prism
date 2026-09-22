// gate-stdio-model.mjs — stdio refuses the shapes it can only lay out for i386.
//
// Three of its entry points write a STRUCTURE into guest memory at offsets computed for i386:
// struct stat (ST_MODE is 8 and ST_SIZE is 28 because an int is four bytes there), struct tm (nine
// ints, strided by four) and fd_set. Under a 16-bit model those offsets move and the widths shrink,
// so writing anyway puts real bytes in the wrong fields -- a wrong answer, and a silent one.
//
// `time` is the control, and it is the reason this is a refusal rather than a rewrite: it writes a
// time_t, which is a long, which is four bytes in BOTH models. Measured over Keen Dreams, it is also
// the only one of the nine model-sensitive entry points that program calls.
//
// scanf's guard sits at the same helper, on the store that %d makes into an int. It is not exercised
// here because building a varargs frame by hand would be more scaffolding than the check is worth;
// the mutation below removes the helper's body, which is what actually holds all four.
import { Module } from '../src/link/module.js';
import { makeMachine } from '../src/runtime/runtime.js';
import { installStdio } from '../src/env/stdio.js';

const REFUSAL = 'laid out for i386';

const world = (model) => {
  const M = makeMachine(new Module({ memory: 8 * 1024 * 1024, model }));
  installStdio(M, { files: { 'a.txt': new Uint8Array([65, 66, 67]) } });
  return { M, api: M.rt };            // installStdio publishes onto M.rt and returns M.files
};

const call = (fn) => { try { fn(); return 'ran'; } catch (e) { return e.message; } };

let bad = 0;
const check = (what, got, wantRefusal) => {
  // A case that is not refused must have RUN. Accepting "any message but the refusal" is how this
  // gate first went green while every call was failing with `api.localtime is not a function`.
  const ok = wantRefusal ? got.includes(REFUSAL) : got === 'ran';
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(34)} ${got.slice(0, 56)}`);
};

for (const model of ['i386', 'dos16']) {
  const refuse = model !== 'i386';
  const { M, api } = world(model);
  const buf = M.rt.malloc(64);
  const name = M.mod.intern([...new TextEncoder().encode('a.txt'), 0]);

  check(`${model}: struct tm (localtime)`, call(() => api.localtime(0)), refuse);
  check(`${model}: fd_set (select)`, call(() => api.select(1, buf, 0, 0, 0)), refuse);
  check(`${model}: struct stat (stat)`, call(() => api.stat(name, buf)), refuse);
  // The control: a long is four bytes in both models, so this must work either way.
  check(`${model}: time_t (time)`, call(() => api.time(buf)), false);
}

const total = 8;
console.log(bad ? `\n${bad} of ${total} WRONG`
  : `\nstdio refuses the shapes it cannot lay out, and keeps the one it can: ${total}/${total}`);
process.exit(bad ? 1 : 0);
