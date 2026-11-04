#!/usr/bin/env python3
"""unicorn-pm32.py — run 32-bit flat snippets under Unicorn, as the reference for MSVC inline asm.

src/asm/msvc.js translates Visual C++'s __asm blocks: general and MMX instructions, the integer MMX
instructions SSE added among them. tools/gate-msvcasm.mjs generates random snippets, assembles each
with `nasm -f bin` (bits 32), and asks this script for the end state. The CPU is a Pentium III, the
first with every instruction the translator accepts (pmaxsw, pshufw...).

Input, one JSON object on stdin:

  { "cases": [ { "code": "<hex of the flat binary>", "seed": 12345, "fill": true } ... ],
    "layout": { "code": 65536, "buf": 1048576, "size": 4096 } }

Every case starts from the same machine: code at `code`, the `size` bytes at `buf` filled from the
case's seed with the gate's generator (so no memory image crosses the pipe), every register zero.
The snippet points EBX at `buf` itself, sets its registers, and stores its results into the buffer;
it ends by running off the end of its code into a HLT.

Output: { "results": [ { "cf":0, "zf":1, "sf":0, "of":0, "mem": "<sha256 of the buffer>",
                         "out": "<hex of the buffer from out to its end>" } ] }
"""
import hashlib
import json
import sys

from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_PROT_ALL, UcError
from unicorn.x86_const import UC_X86_REG_EIP, UC_X86_REG_EFLAGS, UC_X86_REG_ESP, UC_CPU_X86_PENTIUM3


def fill_bytes(seed, n):
    """The gate's generator: a 32-bit LCG, one byte from the top of each step."""
    s = seed & 0xffffffff
    out = bytearray(n)
    for i in range(n):
        s = (s * 1664525 + 1013904223) & 0xffffffff
        out[i] = s >> 24
    return bytes(out)


def run(case, layout):
    mu = Uc(UC_ARCH_X86, UC_MODE_32)
    mu.ctl_set_cpu_model(UC_CPU_X86_PENTIUM3)
    mu.mem_map(0, 0x400000, UC_PROT_ALL)
    code = bytes.fromhex(case['code']) + b'\xf4'          # HLT after the snippet
    mu.mem_write(layout['code'], code)
    if case.get('fill', True):
        mu.mem_write(layout['buf'], fill_bytes(case['seed'], layout['size']))
    mu.reg_write(UC_X86_REG_ESP, 0x3ff000)
    end = layout['code'] + len(code) - 1
    try:
        mu.emu_start(layout['code'], end, count=2_000_000)
    except UcError as e:
        return {'error': str(e)}
    if mu.reg_read(UC_X86_REG_EIP) != end:
        return {'error': 'did not reach the end'}
    fl = mu.reg_read(UC_X86_REG_EFLAGS)
    mem = bytes(mu.mem_read(layout['buf'], layout['size']))
    return {'cf': fl & 1, 'pf': (fl >> 2) & 1, 'zf': (fl >> 6) & 1, 'sf': (fl >> 7) & 1, 'of': (fl >> 11) & 1,
            'mem': hashlib.sha256(mem).hexdigest(), 'out': mem[layout['out']:].hex()}


def main():
    req = json.load(sys.stdin)
    json.dump({'results': [run(c, req['layout']) for c in req['cases']]}, sys.stdout)


if __name__ == '__main__':
    main()
