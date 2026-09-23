#!/usr/bin/env python3
"""unicorn-rm16.py — run 16-bit real-mode snippets under Unicorn, as the reference for Borland asm.

src/asm/borland.js translates Borland C++'s inline assembly. No Borland compiler is available to
diff against, but the INSTRUCTIONS are plain 8086 and Unicorn executes them. tools/gate-borlandasm.mjs
generates random snippets, assembles each with `nasm -f bin`, and asks this script for the end state.

Input, one JSON object on stdin:

  { "cases": [ { "code": "<hex of the flat binary>",
                 "seed": 12345 } ... ],
    "layout": { "code": 65536, "fill": [[131072, 131072]], "ss": 20480, "sp": 65534 } }

Every case starts from the same machine: code at linear `code` (CS:IP = code>>4 : 0), the byte
ranges in `fill` filled from the case's seed with the generator below -- the SAME generator the gate
uses, so no memory image crosses the pipe -- and all registers zero apart from SS:SP. The snippet
sets its own registers; it ends by running off the end of its code into a HLT.

Output: { "results": [ { "regs": {...}, "cf":0, "zf":1, "sf":0, "mem": "<sha256 of the fill ranges>" } ] }
"""
import hashlib
import json
import sys

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_PROT_ALL, UcError
from unicorn.x86_const import (UC_X86_REG_AX, UC_X86_REG_BX, UC_X86_REG_CX, UC_X86_REG_DX,
                               UC_X86_REG_SI, UC_X86_REG_DI, UC_X86_REG_BP, UC_X86_REG_SP,
                               UC_X86_REG_DS, UC_X86_REG_ES, UC_X86_REG_SS, UC_X86_REG_CS,
                               UC_X86_REG_IP, UC_X86_REG_EFLAGS)

REGS = {'ax': UC_X86_REG_AX, 'bx': UC_X86_REG_BX, 'cx': UC_X86_REG_CX, 'dx': UC_X86_REG_DX,
        'si': UC_X86_REG_SI, 'di': UC_X86_REG_DI, 'ds': UC_X86_REG_DS, 'es': UC_X86_REG_ES}


def fill_bytes(seed, n):
    """The gate's generator: a 32-bit LCG, one byte from the top of each step."""
    s = seed & 0xffffffff
    out = bytearray(n)
    for i in range(n):
        s = (s * 1664525 + 1013904223) & 0xffffffff
        out[i] = s >> 24
    return bytes(out)


def run(case, layout):
    mu = Uc(UC_ARCH_X86, UC_MODE_16)
    mu.mem_map(0, 0x110000, UC_PROT_ALL)
    code = bytes.fromhex(case['code']) + b'\xf4'          # HLT after the snippet
    mu.mem_write(layout['code'], code)
    seed = case['seed']
    if case.get('fill', True):
        for k, (addr, size) in enumerate(layout['fill']):
            mu.mem_write(addr, fill_bytes(seed + k, size))
    mu.reg_write(UC_X86_REG_CS, layout['code'] >> 4)
    mu.reg_write(UC_X86_REG_IP, 0)
    mu.reg_write(UC_X86_REG_SS, layout['ss'])
    mu.reg_write(UC_X86_REG_SP, layout['sp'])
    end = layout['code'] + len(code) - 1
    try:
        mu.emu_start(layout['code'], end, count=2_000_000)
    except UcError as e:
        return {'error': str(e)}
    if (mu.reg_read(UC_X86_REG_CS) << 4) + mu.reg_read(UC_X86_REG_IP) != end:
        return {'error': 'did not reach the end'}
    fl = mu.reg_read(UC_X86_REG_EFLAGS)
    h = hashlib.sha256()
    for addr, size in layout['fill']:
        h.update(bytes(mu.mem_read(addr, size)))
    return {'regs': {k: mu.reg_read(v) for k, v in REGS.items()},
            'cf': fl & 1, 'zf': (fl >> 6) & 1, 'sf': (fl >> 7) & 1, 'mem': h.hexdigest()}


def main():
    req = json.load(sys.stdin)
    json.dump({'results': [run(c, req['layout']) for c in req['cases']]}, sys.stdout)


if __name__ == '__main__':
    main()
