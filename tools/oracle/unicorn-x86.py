#!/usr/bin/env python3
"""unicorn-x86.py — run a 32-bit x86 routine under Unicorn, as the reference PRISM must match.

WHY THIS EXISTS. P5 (the assembly subset) is the one piece of PRISM with no oracle yet. A native
i386 harness cannot serve, because the routine contains an `out`, which faults in user space.
Unicorn runs 32-bit protected mode and hooks I/O instructions, so it can.

AN EARLIER VERSION OF THIS NOTE SAID MIRAGE COULD NOT SERVE BECAUSE IT IS "REAL-MODE ONLY". That
is false: MIRAGE's COMPAT.md records Quake playing as a DJGPP program driving its DPMI host
directly, and its roadmap carries CR0.PE, GDT/LDT/IDT, paging and V86. The claim was read from a
stale line in PRISM's own ARCHITECTURE.md and repeated as measured. The privileged `out` argues
FOR an emulator rather than against one. What is actually missing is a harness: MIRAGE runs whole
programs and exposes no way to call ONE routine with registers and a stack and read the end state
back. Unicorn does, which is the real reason it is used here.

WHAT IT IS NOT: it is not part of PRISM. Like Docker, DOSBox-X and gcc, it is an external reference
this project calls and compares against. PRISM itself still has zero dependencies.

Input is one JSON object on stdin, output is one JSON object on stdout:

  { "object":  "path/to/nasm-produced.o",   ELF32 relocatable, as `nasm -f elf32` writes it
    "entry":   "_get_block",                symbol to call
    "symbols": { "___djgpp_base_address": 0 },   values for undefined externals
    "args":    [0, 16, 8, 4, 4, 1048576],   cdecl, pushed right to left
    "memory":  [ {"addr": 655360, "size": 131072, "fill": 171} ],
    "write":   [ {"addr": 655360, "hex": "0011.."} ],
    "dump":    [ {"addr": 1048576, "size": 64} ],
    "limit":   2000000 }

Relocation handling is the whole of the loader and it is small because nasm's output here is: 60
entries, ALL R_386_32, 58 against the section itself and 2 against the one external symbol.
"""
import hashlib
import json
import struct
import sys

from unicorn import (Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_INSN, UC_PROT_ALL, UcError)
from unicorn.x86_const import (UC_X86_INS_OUT, UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX,
                               UC_X86_REG_EDX, UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_EBP,
                               UC_X86_REG_ESP, UC_X86_REG_EIP, UC_X86_REG_EFLAGS)

PAGE = 0x1000
CODE_BASE = 0x00400000
STACK_TOP = 0x00300000
# A return address that is mapped but never executed: emu_start stops when EIP reaches it, which is
# how a CALLed routine is run to completion without guessing how many instructions it takes.
DONE = 0x00200000


def align_down(a):
    return a & ~(PAGE - 1)


def align_up(a):
    return (a + PAGE - 1) & ~(PAGE - 1)


def load_elf32(data, base, symbols):
    """Return (text_bytes, {symbol: address}) with every relocation applied for `base`."""
    if data[:4] != b'\x7fELF' or data[4] != 1:
        raise ValueError('not an ELF32 object')
    shoff, = struct.unpack_from('<I', data, 0x20)
    shentsize, shnum, shstrndx = struct.unpack_from('<HHH', data, 0x2e)
    secs = []
    for i in range(shnum):
        o = shoff + i * shentsize
        keys = 'name typ flags addr off size link info align entsize'.split()
        secs.append(dict(zip(keys, struct.unpack_from('<10I', data, o))))

    shstr = secs[shstrndx]

    def secname(s):
        off = shstr['off'] + s['name']
        return data[off:data.index(b'\0', off)].decode()

    text_i = next(i for i, s in enumerate(secs) if secname(s) == '.text')
    text = bytearray(data[secs[text_i]['off']:secs[text_i]['off'] + secs[text_i]['size']])
    # A .data section, when the object has one (Quake III's snapvector.nasm keeps its two control words
    # there), goes right after .text in the same mapping, 16-aligned; its symbols get addresses there.
    data_i = next((i for i, s in enumerate(secs) if secname(s) == '.data'), None)
    data_at = None
    if data_i is not None:
        text += bytes((-len(text)) % 16)
        data_at = base + len(text)
        text += data[secs[data_i]['off']:secs[data_i]['off'] + secs[data_i]['size']]

    symtab = next(s for s in secs if s['typ'] == 2)
    strtab = secs[symtab['link']]

    def symname(off):
        o = strtab['off'] + off
        return data[o:data.index(b'\0', o)].decode()

    # Symbol addresses, and the values supplied for anything the object does not define.
    exported = {}
    syms = []
    for i in range(symtab['size'] // 16):
        n_off, val, size, info, shndx = struct.unpack_from('<IIIBxH', data, symtab['off'] + i * 16)
        name = symname(n_off)
        if shndx == 0:                       # undefined: the caller must supply it
            if name and name not in symbols:
                raise ValueError(f'undefined symbol with no value given: {name}')
            addr = symbols.get(name, 0)
        elif shndx == text_i:
            addr = base + val
        elif data_i is not None and shndx == data_i:
            addr = data_at + val
        else:
            addr = val
        syms.append(addr)
        if name:
            exported[name] = addr

    rel = next((s for s in secs if s['typ'] == 9 and secs[s['info']] is secs[text_i]), None)
    if rel is None:
        rel = next((s for s in secs if s['typ'] == 9), None)
    if rel is not None:
        for i in range(rel['size'] // 8):
            off, info = struct.unpack_from('<II', data, rel['off'] + i * 8)
            rtype, sidx = info & 0xff, info >> 8
            if rtype != 1:                  # R_386_32 is all nasm emits here; anything else is new
                raise ValueError(f'unhandled relocation type {rtype} at .text+{off:#x}')
            addend, = struct.unpack_from('<I', text, off)
            struct.pack_into('<I', text, off, (addend + syms[sidx]) & 0xffffffff)

    return bytes(text), exported


def run(spec):
    data = open(spec['object'], 'rb').read()
    text, syms = load_elf32(data, CODE_BASE, spec.get('symbols', {}))

    uc = Uc(UC_ARCH_X86, UC_MODE_32)
    uc.mem_map(CODE_BASE, align_up(max(len(text), PAGE)), UC_PROT_ALL)
    uc.mem_write(CODE_BASE, text)
    uc.mem_map(align_down(STACK_TOP - 0x10000), 0x11000, UC_PROT_ALL)
    uc.mem_map(align_down(DONE), PAGE, UC_PROT_ALL)

    for m in spec.get('memory', []):
        uc.mem_map(align_down(m['addr']), align_up(m['size']), UC_PROT_ALL)
        if m.get('fill') is not None:
            uc.mem_write(align_down(m['addr']), bytes([m['fill']]) * align_up(m['size']))
    for w in spec.get('write', []):
        uc.mem_write(w['addr'], bytes.fromhex(w['hex']))

    # Every `out` the routine performs, in order. For gfx.S this is the Graphics Controller's Read
    # Map Select, and seeing it is how one knows the run really walked all four planes.
    ports = []

    def on_out(uc_, port, size, value, _user):
        ports.append({'port': port, 'size': size, 'value': value})

    uc.hook_add(UC_HOOK_INSN, on_out, None, 1, 0, UC_X86_INS_OUT)

    # cdecl: arguments pushed right to left, then the return address.
    esp = STACK_TOP
    for a in reversed(spec.get('args', [])):
        esp -= 4
        uc.mem_write(esp, struct.pack('<I', a & 0xffffffff))
    esp -= 4
    uc.mem_write(esp, struct.pack('<I', DONE))
    uc.reg_write(UC_X86_REG_ESP, esp)
    uc.reg_write(UC_X86_REG_EBP, 0)

    entry = syms[spec['entry']]
    err = None
    try:
        uc.emu_start(entry, DONE, 0, spec.get('limit', 5_000_000))
    except UcError as e:
        err = str(e)

    names = dict(eax=UC_X86_REG_EAX, ebx=UC_X86_REG_EBX, ecx=UC_X86_REG_ECX, edx=UC_X86_REG_EDX,
                 esi=UC_X86_REG_ESI, edi=UC_X86_REG_EDI, ebp=UC_X86_REG_EBP, esp=UC_X86_REG_ESP,
                 eip=UC_X86_REG_EIP, eflags=UC_X86_REG_EFLAGS)
    out = {
        'regs': {k: uc.reg_read(v) for k, v in names.items()},
        'ports': ports,
        'dump': {},
        'error': err,
        'finished': uc.reg_read(UC_X86_REG_EIP) == DONE,
    }
    for dmp in spec.get('dump', []):
        blob = bytes(uc.mem_read(dmp['addr'], dmp['size']))
        # `hash` exists so a comparison can cover a WHOLE region instead of its first few hundred
        # bytes. A routine that writes at an offset computed from its arguments will often write
        # nothing near the start, and two empty prefixes compare equal -- a green that means nothing.
        out['dump'][str(dmp['addr'])] = hashlib.sha256(blob).hexdigest() if dmp.get('hash') else blob.hex()
    return out


if __name__ == '__main__':
    json.dump(run(json.load(sys.stdin)), sys.stdout)
    sys.stdout.write('\n')
