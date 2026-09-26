#!/usr/bin/env python3
"""unicorn-tasm.py — run TASM's own object code under Unicorn, as the reference for src/asm/tasm16.js.

tools/gate-tasm-run.mjs links the real .OBJ files TASM 2.5 wrote (tools/omf.mjs linkOmf) and asks
this script to run one routine per case from a given machine state.

Input, one JSON object on stdin:

  { "cases": [ { "image": [[linear, "<hex>"], ...],       # written after the fill, in order
                 "fill": [[linear, size, seed], ...],     # the gate's generator, below
                 "regs": { "ax": .., "ss": .., "sp": .., "cs": .., "ip": .., ... },
                 "stop": linear,                          # the return address the case pushed
                 "in_seed": n, "int_xor": [ax, bx],
                 "steps": n } ... ] }

Ports and interrupts are answered by a rule both sides implement: the k-th IN from port p returns
port_in(in_seed, k, p) -- or, with "echo", the last value written to p;
INT n XORs AX and BX with int_xor and continues. Every OUT is recorded.

Output: { "results": [ { "regs": {...}, "flags": n, "pages": ["<sha1[:16]>" x 272],
                         "outs": "<sha1 of 'port:width:value;' ...>", "n_out": n, "n_in": n,
                         "ints": [[n, ax], ...] } | { "error": "..." } ] }
"""
import hashlib
import json
import sys

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_PROT_ALL, UcError, UC_HOOK_INSN, UC_HOOK_INTR
from unicorn.x86_const import (UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX, UC_X86_REG_DX,
                               UC_X86_REG_SI, UC_X86_REG_DI, UC_X86_REG_BP, UC_X86_REG_SP,
                               UC_X86_REG_DS, UC_X86_REG_ES, UC_X86_REG_SS, UC_X86_REG_CS,
                               UC_X86_REG_IP, UC_X86_REG_EFLAGS, UC_X86_INS_IN, UC_X86_INS_OUT)

REGS = {'ax': UC_X86_REG_AX, 'bx': UC_X86_REG_BX, 'cx': UC_X86_REG_CX, 'dx': UC_X86_REG_DX,
        'si': UC_X86_REG_SI, 'di': UC_X86_REG_DI, 'bp': UC_X86_REG_BP, 'sp': UC_X86_REG_SP,
        'ds': UC_X86_REG_DS, 'es': UC_X86_REG_ES, 'ss': UC_X86_REG_SS}
MEM = 0x110000
PAGE = 4096


def fill_bytes(seed, n, mod=0, keep=0):
    """The gate's generator: a 32-bit LCG, one byte from the top of each step -- or, with `mod`, one
    little-endian word per step, (s >> 8) % mod, zero where that is not below `keep`."""
    s = seed & 0xffffffff
    out = bytearray(n)
    if mod:
        for i in range(0, n - 1, 2):
            s = (s * 1664525 + 1013904223) & 0xffffffff
            v = (s >> 8) % mod
            if v >= keep:
                v = 0
            out[i] = v & 255
            out[i + 1] = v >> 8
        return bytes(out)
    for i in range(n):
        s = (s * 1664525 + 1013904223) & 0xffffffff
        out[i] = s >> 24
    return bytes(out)


def port_in(seed, k, port):
    s = (seed + k * 0x9E3779B1 + port * 0x85EBCA77) & 0xffffffff
    s = (s * 1103515245 + 12345) & 0xffffffff
    return s >> 16


def run(case):
    mu = Uc(UC_ARCH_X86, UC_MODE_16)
    mu.mem_map(0, MEM, UC_PROT_ALL)
    for f in case['fill']:
        mu.mem_write(f[0], fill_bytes(f[2], f[1], *f[3:]))
    for addr, data in case['image']:
        mu.mem_write(addr, bytes.fromhex(data))
    mu.mem_write(case['stop'], b'\xf4')
    state = {'k': 0, 'outs': hashlib.sha1(), 'n_out': 0, 'ints': [], 'latch': {}}

    def on_in(uc, port, size, user):
        v = port_in(case['in_seed'], state['k'], port)
        state['k'] += 1
        if case.get('echo') and port in state['latch']:
            v = state['latch'][port]
        return v & (0xff if size == 1 else 0xffff)

    def on_out(uc, port, size, value, user):
        state['latch'][port] = value
        state['outs'].update(f'{port}:{size}:{value & (0xff if size == 1 else 0xffff)};'.encode())
        state['n_out'] += 1

    def on_int(uc, n, user):
        ax = uc.reg_read(UC_X86_REG_AX)
        state['ints'].append([n, ax])
        uc.reg_write(UC_X86_REG_AX, ax ^ case['int_xor'][0])
        uc.reg_write(UC_X86_REG_BX, uc.reg_read(UC_X86_REG_BX) ^ case['int_xor'][1])

    mu.hook_add(UC_HOOK_INSN, on_in, None, 1, 0, UC_X86_INS_IN)
    mu.hook_add(UC_HOOK_INSN, on_out, None, 1, 0, UC_X86_INS_OUT)
    mu.hook_add(UC_HOOK_INTR, on_int)
    r = case['regs']
    for k, v in REGS.items():
        mu.reg_write(v, r.get(k, 0))
    mu.reg_write(UC_X86_REG_EFLAGS, r.get('flags', 0x202))
    mu.reg_write(UC_X86_REG_CS, r['cs'])
    mu.reg_write(UC_X86_REG_IP, r['ip'])
    begin = (r['cs'] << 4) + r['ip']
    try:
        mu.emu_start(begin, case['stop'], count=case.get('steps', 50_000_000))
    except UcError as e:
        return {'error': str(e)}
    if (mu.reg_read(UC_X86_REG_CS) << 4) + mu.reg_read(UC_X86_REG_IP) != case['stop']:
        return {'error': 'did not return (step budget)'}
    mem = bytes(mu.mem_read(0, MEM))
    return {'regs': {k: mu.reg_read(v) for k, v in REGS.items()},
            'flags': mu.reg_read(UC_X86_REG_EFLAGS) & 0xffff,
            'pages': [hashlib.sha1(mem[p:p + PAGE]).hexdigest()[:16] for p in range(0, MEM, PAGE)],
            'outs': state['outs'].hexdigest(), 'n_out': state['n_out'], 'n_in': state['k'],
            'ints': state['ints']}


def main():
    req = json.load(sys.stdin)
    json.dump({'results': [run(c) for c in req['cases']]}, sys.stdout)


if __name__ == '__main__':
    main()
