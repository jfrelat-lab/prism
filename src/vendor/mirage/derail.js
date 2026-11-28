// derail.js — say WHAT the guest is executing when it is no longer executing code.
//
// Four separate investigations in one day started from a message that named an opcode and nothing
// else, and in all four the opcode was innocent — the guest had left its own code and we were
// decoding whatever it landed in:
//
//   Turbo Pascal   jumped to fffe:0002, ran off the 1 MB wrap into the interrupt vector table, and
//                  vector 0 (0f53:010c) decoded as "0f 53" — an SSE opcode in a 1989 program.
//   MS-DOS 6.22    same table, where "62 07" decodes as BOUND, so an unhandled #BR looped 3 M times.
//   test386        the IDT, whose gate access bytes 8e/ee read as an instruction.
//   Crystal Dream 2  its own error string: "…ception faul…" executed as code.
//
// Each time the first move was to implement or investigate the opcode, and each time that was wrong.
// So the address gets classified rather than merely printed. This runs only on a diagnostic path —
// a fault that is about to be reported — never on the hot path.

/**
 * The byte at LINEAR address `a`, read the way the guest sees it — through its page tables when
 * paging is on — and without the side effects of Memory.walk (which sets Accessed/Dirty: a diagnostic
 * must not change the machine it reports on). An unmapped page reads as -1, which is neither zero
 * nor printable. The detector used to index physical memory with the linear address, so under a
 * DPMI host every block above the host's own mapping looked like "a run of zero bytes": xcom144's
 * "derail" at 00AF:2B915 (linear 13C915h, frame FBF000h) was the real code, read from the wrong place.
 */
function peek(mem, a) {
  a >>>= 0;
  if (!mem.paged || !mem.cpu) return mem.u8[a & (mem.size - 1)];
  const pde = mem.r32phys((((mem.cpu.cr3 & 0xfffff000) >>> 0) + ((a >>> 22) * 4)) >>> 0);
  if (!(pde & 1)) return -1;
  // A 4 MiB page (PS with CR4.PSE): the directory entry maps it whole. KolibriOS maps its kernel so,
  // and its page tables read as zeros: a false "run of zero bytes" once its blocks grew past 64.
  if ((pde & 0x80) && (mem.cpu.cr4 & 0x10)) return mem.u8[(((pde & 0xffc00000) >>> 0) | (a & 0x3fffff)) & (mem.size - 1)];
  const pte = mem.r32phys((((pde & 0xfffff000) >>> 0) + (((a >>> 12) & 0x3ff) * 4)) >>> 0);
  if (!(pte & 1)) return -1;
  return mem.u8[(((pte & 0xfffff000) >>> 0) | (a & 0xfff)) & (mem.size - 1)];
}

/**
 * The printable run CONTAINING `lin` — scanning back as well as forward. A derail lands wherever the
 * jump pointed, which is generally inside the text, not at its start: Crystal Dream 2 stops three
 * words into "Exception fault.", oktaeder three bytes from the end of "C:\\oktaeder.com". Measuring
 * only forward — the first version — missed both.
 */
function runAround(mem, lin, back = 40, fwd = 48) {
  const at = (i) => peek(mem, lin + i);
  const printable = (b) => b >= 0x20 && b < 0x7f;
  if (!printable(at(0))) return { start: lin, len: 0 };
  let s = 0; while (s > -back && printable(at(s - 1))) s--;
  let e = 1; while (e < fwd && printable(at(e))) e++;
  return { start: (lin + s) >>> 0, len: e - s };
}

/**
 * True when the bytes at `lin` are plausibly text: a run of at least eight printable bytes, most of
 * them letters or spaces. Crystal Dream 2's message is "Exception fault.\x12Break", so demanding a
 * whole printable window — the first version — rejected the very case this exists for; the 0x12 is a
 * separator inside the message, not the end of the text.
 */
function looksLikeText(mem, lin) {
  const { start, len } = runAround(mem, lin);
  if (len < 8) return false;
  let wordy = 0;
  for (let i = 0; i < len; i++) {
    const b = peek(mem, start + i);
    if (b === 0x20 || (b | 32) >= 0x61 && (b | 32) <= 0x7a) wordy++;
  }
  return wordy * 5 >= len * 3;                       // 60% letters or spaces
}

/** The printable text around `lin`, quoted from the start of its run so it reads. */
function textAt(mem, lin) {
  const { start, len } = runAround(mem, lin);
  let out = '';
  for (let i = 0; i < len; i++) out += String.fromCharCode(peek(mem, start + i));
  return out;
}

/**
 * True when the bytes AROUND `lin` look like packed data — a bitmap mask, a table — rather than
 * code. Pinball Fantasies executes a sprite mask, `ff fc 00 ff ff c0 ff ff f8 00 7f ff 80 …`, and
 * surfaced as "unimplemented opcode 0x0f 0xff".
 *
 * The window straddles the address because a fault can land a dozen bytes into the run, where the
 * forward bytes alone are unremarkable. The thresholds are measured, not guessed: over 380 583 block
 * starts the recompiler actually translated and ran across the corpus, a zero-density test alone
 * fires on 75 % of REAL code — code is full of zero bytes — while additionally requiring six 0xff
 * bytes drops that to 4 in 380 583 (0.001 %). So the 0xff count is the whole discriminator, and the
 * density is what makes the phrase worth printing.
 */
function looksLikePackedData(mem, lin, back = 24, fwd = 40) {
  let zero = 0, ones = 0, n = 0;
  for (let i = -back; i < fwd; i++) {
    const b = peek(mem, lin + i);
    n++;
    if (b === 0) zero++; else if (b === 0xff) ones++;
  }
  return ones >= 6 && (zero + ones) * 10 >= n * 3 ? { zero, ones, n } : null;
}

/** A run of zero bytes at `lin`. Exported because the recompiler needs to recognise this WHILE it
 *  happens, not only when reporting a fault: a guest walking through empty memory never faults. */
export function allZero(mem, lin, n = 16) {
  for (let i = 0; i < n; i++) if (peek(mem, lin + i)) return false;
  return true;
}

/**
 * A phrase describing what lives at `lin`, or '' when it looks like ordinary code. Never throws:
 * this is called while reporting another failure, and a diagnostic that dies is worse than none.
 *
 * @param {object} mem  the Memory
 * @param {number} lin  LINEAR address of the byte that failed to decode
 * @param {object} [cpu] optional, for the descriptor-table ranges
 */
export function describeRegion(mem, lin, cpu) {
  try {
    lin = lin >>> 0;
    if (lin < 0x400) return `INSIDE THE REAL-MODE IVT (vector ${lin >> 2}) — the guest left its own code`;
    if (lin < 0x500) return 'inside the BIOS data area — the guest left its own code';
    if (cpu) {
      const idt = cpu.idtr, gdt = cpu.gdtr, ldt = cpu.ldtr;
      if (idt && idt.limit && lin >= idt.base && lin <= idt.base + idt.limit) {
        return `INSIDE THE IDT (entry ${((lin - idt.base) / 8) | 0}) — descriptor bytes, not code`;
      }
      if (gdt && gdt.limit && lin >= gdt.base && lin <= gdt.base + gdt.limit) {
        return `INSIDE THE GDT (entry ${((lin - gdt.base) / 8) | 0}) — descriptor bytes, not code`;
      }
      if (ldt && ldt.limit && lin >= ldt.base && lin <= ldt.base + ldt.limit) {
        return `INSIDE THE LDT (entry ${((lin - ldt.base) / 8) | 0}) — descriptor bytes, not code`;
      }
    }
    if (allZero(mem, lin)) return 'in a run of zero bytes — the guest is running through empty memory';
    const packed = looksLikePackedData(mem, lin);
    if (packed) {
      return `INSIDE PACKED DATA — ${packed.zero + packed.ones} of the ${packed.n} bytes around it ` +
        `are 0x00 or 0xff — the guest is executing a bitmap or a table, not code`;
    }
    if (looksLikeText(mem, lin)) return `INSIDE A STRING — "${textAt(mem, lin)}" — the guest is executing text, not code`;
    return '';
  } catch { return ''; }
}

/**
 * Formats the recompiler's recent-block ring as "how it got here", oldest first.
 *
 * A run of identical positive steps gets called out. Real code branches; equal steps mean the
 * decoder is walking straight forward through whatever it finds, one maximum-length block at a time,
 * which says the derail happened BEFORE the address being reported. test386 walked upward in ~0x180
 * steps for a long way before it reached the IDT and surfaced as an opcode, and reading that walk as
 * the symptom rather than the trail cost real time.
 */
export function recentBlocks(rec, n = 6) {
  if (!rec || !rec.recentCs) return '';
  const cs = [], ip = [];
  const N = rec.recentCs.length;
  for (let i = 0; i < N; i++) {
    const k = (rec.recentI + i) % N;
    if (rec.recentCs[k] < 0) continue;
    cs.push(rec.recentCs[k] >>> 0); ip.push(rec.recentIp[k] >>> 0);
  }
  if (!cs.length) return '';
  const shown = cs.map((c, i) => `${c.toString(16).padStart(4, '0')}:${ip[i].toString(16)}`).slice(-n);
  let out = shown.join(' -> ');

  let run = 0, best = 0, step = 0;
  for (let i = 2; i < cs.length; i++) {
    const d1 = ip[i] - ip[i - 1], d0 = ip[i - 1] - ip[i - 2];
    if (d1 > 0 && d1 === d0 && cs[i] === cs[i - 1] && cs[i - 1] === cs[i - 2]) {
      run = run ? run + 1 : 2;
      if (run > best) { best = run; step = d1; }
    } else run = 0;
  }
  if (best >= 3) {
    out += ` — ${best + 1} of those advance by exactly 0x${step.toString(16)}, so the decoder is ` +
      'walking forward through memory rather than branching: the derail is EARLIER than this address';
  }
  return out;
}
