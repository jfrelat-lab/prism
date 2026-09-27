// gate-dosint.mjs — the DOS interrupt surface of a Borland real-mode program (src/env/borland.js).
//
// There is no oracle for this one in the gcc sense: it is a machine interface, and the contract is
// Borland's documented behaviour plus the seam's own promises. What is checked, executed:
//
//   * the vector table is MEMORY at 0..0x3FF: setvect writes vector n at n*4, getvect reads it back,
//     an unset vector reads 0 -- which is how Keen Dreams asks whether a mouse driver is present
//   * `int n` reaches the handler the PROGRAM installed there, as the hardware would
//   * else a service passed in by the harness, which sees the registers the program loaded through
//     the pseudo-registers and hands back registers and CF
//   * else it throws, naming the vector and AH -- nothing is answered by default
//   * peek/peekb/poke/pokeb are plain memory at seg*16+off (the BIOS data area, 0040:0017 is 0x417)
//   * inport/outport are words on the port seam; disable/enable are recorded
//   * _argc/_argv exist, because the environment supplies them as data
//   * dos16 (small), whose data starts at 0x100, refuses the table by name rather than overlap it
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';
import { installBorland, BORLAND_DOS_H, BORLAND_VARS, BORLAND_BUILTINS } from '../src/env/borland.js';

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(56)} ${detail}`);
};

const SRC = `#include <dos.h>
unsigned ticks;
unsigned mode, page;
static void interrupt (*OldVect)(void);
void interrupt MyIsr(void) { ticks++; }

int t_vectors(void) {
  OldVect = getvect(0x60);
  setvect(0x60, MyIsr);
  return OldVect == 0 && getvect(0x60) == MyIsr;
}
int t_self(void) { geninterrupt(0x60); geninterrupt(0x60); return ticks; }
int t_service(void) {
  _AH = 0x0f;
  geninterrupt(0x10);
  mode = _AL;
  page = _BH;
  return mode * 256 + page;
}
int t_carry(void) {
  asm mov ax,0x3d00
  asm int 21h
  asm jc bad
  return 1;
bad:
  return 2;
}
int t_bda(void) {
  poke(0x40, 0x17, 0x1234);
  pokeb(0x40, 0x49, 0x0d);
  return peek(0x40, 0x17) == 0x1234 && peekb(0x40, 0x49) == 0x0d;
}
int t_ports(void) { outport(0x3c4, 0x0f02); return inport(0x3c4); }
int t_irq(void) { disable(); return 0; }
int t_args(void) { return _argc; }
`;

const build = (model) => compileProgram(
  [{ file: 'dosint.c', source: SRC }, { file: 'prism-borland-vars.c', source: BORLAND_VARS }],
  { resolve: builtinHeaderResolver({ 'dos.h': BORLAND_DOS_H }), memory: 8 << 20, collect: true, model,
    extraBuiltins: new Map(Object.entries(BORLAND_BUILTINS)) });

const p = build('dos16m');
const failed = new Map((p.failures ?? []).map((f) => [f.fn, f.message]));
for (const [fn, m] of failed) report(false, `${fn} emits`, m.slice(0, 70));
const calls = [];
const host = installBorland(p.M, {
  services: {
    0x10: (r) => { calls.push(`10:${r.ax.toString(16)}`); if ((r.ax >> 8) === 0x0f) { r.ax = 0x500d; r.bx = 0x0300; } },
    0x21: (r) => { calls.push(`21:${r.ax.toString(16)}`); r.ax = 2; r.cf = 1; },
  },
});
const run = (fn) => { try { return p.F[fn](); } catch (e) { return `threw: ${e.message}`; } };

report(run('t_vectors') === 1, 'setvect/getvect round trip; an unset vector is 0');
const isr = p.mod.dv.getUint32(0x60 * 4, true);
report(isr !== 0 && isr === host.vector(0x60), 'the vector lives in memory at n*4', `0x${isr.toString(16)}`);
const ticks = run('t_self');
report(ticks === 2, 'int n reaches the handler the program installed', `ticks ${ticks}`);
const svc = run('t_service');
report(svc === 0x0d03, 'a service sees _AH, answers in _AL and _BH', `0x${Number(svc).toString(16)}`);
report(run('t_carry') === 2, 'a service sets CF and asm jc reads it');
report(calls.slice(0, 2).join(' ') === '10:f00 21:3d00', 'the services saw the registers the program loaded', calls.slice(0, 2).join(' '));
{
  const q = build('dos16m');
  installBorland(q.M, {});
  let m = '(returned)';
  try { q.F.t_service(); } catch (e) { m = e.message; }
  report(m.includes('int 10h AH=0Fh') && m.includes('no service'), 'no service: throws naming the vector and AH', m.slice(0, 50));
}
report(run('t_bda') === 1 && p.mod.dv.getUint16(0x417, true) === 0x1234, 'peek/poke are memory at seg*16+off (0040:0017 = 0x417)');
{
  const log = [];
  p.M.machine = {
    read: (port, size) => { log.push(`r${port.toString(16)}/${size}`); return 0xbeef; },
    write: (port, size, v) => { log.push(`w${port.toString(16)}/${size}=${v.toString(16)}`); },
  };
  const got = run('t_ports');
  // inport returns int: 0xBEEF read back as a 16-bit int is -16657.
  report(got === -16657 && log.join(' ') === 'w3c4/2=f02 r3c4/2', 'inport/outport are words; the result is a 16-bit int', `${got} ${log.join(' ')}`);
}
run('t_irq');
report(p.M.cpu.if === 0, 'disable() clears the machine IF');
report(run('t_args') === 0 && p.mod.symbols.has('_argc') && p.mod.symbols.has('_argv'), '_argc and _argv exist');
{
  const q = build('dos16');
  installBorland(q.M, {});
  let m = '(returned)';
  try { q.F.t_vectors(); } catch (e) { m = e.message; }
  report(m.includes('would overlap'), 'dos16 (small): the vector table is refused by name', m.slice(0, 60));
}

console.log(bad ? `\n${bad} WRONG` : '\nthe DOS interrupt surface: a vector table in memory, and every int answered or refused by name.');
process.exit(bad ? 1 : 0);
