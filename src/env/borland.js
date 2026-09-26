// borland.js — the DOS surface a Borland C++ real-mode program reaches through <dos.h>.
//
// Measured on Keen Dreams before a line was written, every use in its C:
//
//   _AX _BX _CX _DX _AH _AL _DL _DI _ES + geninterrupt   the BIOS (int 10h) and the mouse (int 33h)
//   getvect / setvect                                   its keyboard (9), timer (8) and Sound Blaster ISRs
//   peek / peekb / poke / pokeb                         the BIOS data area at 0040:xxxx
//   harderr                                             the critical-error handler
//   _argc / _argv                                       the command line, as globals
//   inport / outport(b)                                 ports, word and byte
//   int 21h in asm                                      opening EMMXXXX0 to detect EMS
//
// THE COMPILER'S HALF lives in src/backend/emit.js and src/asm/borland.js: the pseudo-registers are
// names of the function's register file, and geninterrupt and `int n` both become one call,
// M.interrupt(n, regs). THIS FILE is the machine's half: what answers that call, and the vector
// table the program hooks.
//
// THE VECTOR TABLE IS MEMORY, at linear 0..0x3FF, four bytes per vector, as on the machine. What a
// vector HOLDS is a PRISM code pointer -- the value a C function pointer has here -- rather than a
// seg:off, the same trade the far pointers make: getvect gives back exactly what setvect put, and a
// program that reads the table with peek sees PRISM's representation. That needs the table outside
// the program's data, which dos16m and dos16l guarantee (their statics start at 0x1000 and 0x10000)
// and dos16, whose DGROUP starts at 0x100, does not -- there getvect and setvect throw by name.
//
// WHAT ANSWERS AN INTERRUPT, in order: a handler the PROGRAM installed with setvect (called, as the
// hardware would); else a service the harness passed in `services` ({ 0x10: (regs, M) => ... });
// else a throw naming the vector and AH. Nothing is answered by default: a BIOS is a device model,
// as a VGA is, and pretending one exists would hand the program invented registers. MIRAGE owns
// real BIOS services; this is the seam they plug into, exactly as ports.js is for ports.

import { DOS_DATE_ADD } from './borland-lib.js';

/** Borland's <dos.h>, in the real-mode shape: far pointers are linear (headers-watcom.js says why). */
export const BORLAND_DOS_H = `
#ifndef __PRISM_BORLAND_DOS_H
#define __PRISM_BORLAND_DOS_H

#define FP_SEG(p)    ((unsigned)((unsigned long)(void far *)(p) >> 4))
#define FP_OFF(p)    ((unsigned)((unsigned long)(void far *)(p) & 15))
#define MK_FP(s, o)  ((void far *)(((unsigned long)(unsigned)(s) << 4) + (unsigned)(o)))

/* Borland's own definitions: plain memory at seg:off. */
#define peek(a, b)      (*((int far *)MK_FP((a), (b))))
#define peekb(a, b)     (*((char far *)MK_FP((a), (b))))
#define poke(a, b, c)   (*((int far *)MK_FP((a), (b))) = (int)(c))
#define pokeb(a, b, c)  (*((char far *)MK_FP((a), (b))) = (char)(c))

typedef void interrupt (far *__prism_vector)(void);
__prism_vector getvect(int interruptno);
void setvect(int interruptno, __prism_vector isr);
void geninterrupt(int intr_num);

void harderr(int (far *handler)());
void hardresume(int axret);
void hardretn(int retn);

void disable(void);
void enable(void);

int inport(int portid);
unsigned char inportb(int portid);
void outport(int portid, int value);
void outportb(int portid, unsigned char value);

extern int _argc;
extern char **_argv;
${DOS_DATE_ADD}
#endif
`;

/** What a Borland linker would bring from the startup code: the command line, as globals. */
export const BORLAND_VARS = `
int _argc;
char **_argv;
`;

/** The runtime half of <dos.h>, typed by the prototypes there (emit.js, `proto`). */
const PROTO = Object.freeze({ proto: true });
export const BORLAND_BUILTINS = Object.fromEntries(['getvect', 'setvect', 'harderr', 'hardresume',
  'hardretn', 'disable', 'enable', 'inport', 'outport'].map((n) => [n, PROTO]));

const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

export function installBorland(M, { services = {} } = {}) {
  const dv = () => M.mod.dv;
  const state = { installed: new Set(), harderr: 0, if: 1, calls: [] };
  const tableFits = () => {
    const base = M.mod.layout?.staticBase ?? 0;
    if (base < 0x400) {
      throw new Error(`Borland getvect/setvect: the vector table at 0..0x3FF would overlap this layout's `
        + `data, which starts at 0x${base.toString(16)} (${M.mod.model})`);
    }
  };
  const vector = (n) => { tableFits(); return dv().getUint32((n & 255) * 4, true); };

  const api = {
    getvect: (n) => vector(n),
    setvect: (n, isr) => {
      tableFits();
      dv().setUint32((n & 255) * 4, isr >>> 0, true);
      if (isr) state.installed.add(n & 255); else state.installed.delete(n & 255);
    },
    harderr: (handler) => { state.harderr = handler >>> 0; },
    hardresume: () => { throw new Error('Borland hardresume: no critical error is being handled'); },
    hardretn: () => { throw new Error('Borland hardretn: no critical error is being handled'); },
    disable: () => { state.if = 0; },
    enable: () => { state.if = 1; },
    inport: (p) => (M.machine ? M.machine.read(p, 2) & 0xffff : 0xffff),
    outport: (p, v) => { M.machine?.write(p, 2, v | 0); },
  };

  /** `int n`: the program's own handler, else a harness service, else a refusal by name. */
  M.interrupt = (n, regs) => {
    state.calls.push(n);
    if (state.installed.has(n)) { M.icall(vector(n), []); return; }
    // A harness's service, else the machine's own DOS and BIOS (src/env/dos.js), if installed.
    const svc = services[n] ?? M.pcServices?.[n];
    if (svc) { svc(regs, M); return; }
    throw new Error(`int ${hex(n)}h AH=${hex(regs.ax >>> 8)}h: no service for this interrupt is installed `
      + '(PRISM supplies no BIOS or DOS; pass one in the borland environment\'s `services`)');
  };

  Object.assign(M.rt, api);
  M.borlandHost = { state, vector };
  return M.borlandHost;
}
