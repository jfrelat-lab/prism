// console.js — a DOS text console, in the guest's own memory.
//
// The point is WHERE this writes. `printf` output goes into the guest's text video RAM at 0xB8000, in
// the real format — two bytes per cell, character then attribute — with the cursor in the BIOS data
// area at 0x450/0x451, exactly where a DOS program looks for it.
//
// That is not decoration. It means the host renders the console by reading guest memory and has no
// idea whether the characters arrived through libc or because the program poked video RAM itself, and
// it means a program that DOES poke video RAM (every DJGPP program that cares about speed, through
// `sys/farptr.h` and `_dos_ds`) needs nothing added to work. The alternative — shipping text to the
// host as strings — would have made those two cases different, and only the first would ever work.
//
// It is still not an emulated VGA: there is no CRTC, no attribute controller, no mode setting. It is
// the memory layout and the semantics of writing to it, which is the part programs actually depend on.

import { VRAM_TEXT, BDA, TEXT_COLS, TEXT_ROWS } from '../link/module.js';

const DEFAULT_ATTR = 0x07;        // light grey on black, which is what DOS booted into

/**
 * `readChar` is how the console gets input, injected because blocking is the host's business: in a
 * worker it parks on an atomic, in a headless run it returns -1 immediately. Returning -1 means EOF,
 * which is a real answer — a program reading a closed stdin must not hang.
 */
export function installConsole(M, { readChar = () => -1, echo = true } = {}) {
  const mod = M.mod;
  const u8 = M.u8;

  const cell = (row, col) => VRAM_TEXT + (row * TEXT_COLS + col) * 2;
  const getCol = () => u8[BDA + 0x50];
  const getRow = () => u8[BDA + 0x51];
  const setPos = (col, row) => { u8[BDA + 0x50] = col; u8[BDA + 0x51] = row; };

  function clear() {
    for (let i = 0; i < TEXT_COLS * TEXT_ROWS; i++) {
      u8[VRAM_TEXT + i * 2] = 32;
      u8[VRAM_TEXT + i * 2 + 1] = DEFAULT_ATTR;
    }
    setPos(0, 0);
  }

  function scroll() {
    const rowBytes = TEXT_COLS * 2;
    u8.copyWithin(VRAM_TEXT, VRAM_TEXT + rowBytes, VRAM_TEXT + rowBytes * TEXT_ROWS);
    for (let c = 0; c < TEXT_COLS; c++) {
      u8[cell(TEXT_ROWS - 1, c)] = 32;
      u8[cell(TEXT_ROWS - 1, c) + 1] = DEFAULT_ATTR;
    }
  }

  function newline() {
    let row = getRow();
    if (++row >= TEXT_ROWS) { scroll(); row = TEXT_ROWS - 1; }
    setPos(0, row);
  }

  function putc(code) {
    let col = getCol(), row = getRow();
    switch (code) {
      case 10: newline(); return;                                   // \n
      case 13: setPos(0, row); return;                              // \r
      case 8:  if (col > 0) setPos(col - 1, row); return;            // \b
      case 9: {                                                     // \t — DOS tabs are 8 wide
        const next = Math.min(TEXT_COLS - 1, (col + 8) & ~7);
        for (let c = col; c < next; c++) { u8[cell(row, c)] = 32; u8[cell(row, c) + 1] = DEFAULT_ATTR; }
        setPos(next, row);
        return;
      }
      case 7: return;                                               // bell: nothing to ring
      default: break;
    }
    if (col >= TEXT_COLS) { newline(); col = getCol(); row = getRow(); }
    u8[cell(row, col)] = code & 0xff;
    u8[cell(row, col) + 1] = DEFAULT_ATTR;
    setPos(col + 1, row);
  }

  clear();

  /*
   * stdout keeps being collected as a string as well. The headless gates compare it against a native
   * build byte for byte, and that oracle is worth more than the tidiness of having one sink.
   */
  M.write = (s) => {
    M.stdout.push(s);
    for (let i = 0; i < s.length; i++) putc(s.charCodeAt(i));
  };

  M.console = { clear, putc, cursor: () => ({ col: getCol(), row: getRow() }) };

  /**
   * Line-buffered input, the way DOS's own buffered read works: characters accumulate until Enter,
   * backspace erases, and the terminal echoes. `getchar` hands them out one at a time afterwards.
   *
   * Without this, a program that prints "Press ENTER to continue." and calls getchar() carried on
   * immediately — it asked a question and ignored the answer, which is not the program's behaviour and
   * looked, on screen, like the prompt appearing for no reason.
   */
  let pending = [];
  function getchar() {
    if (pending.length) return pending.shift();
    for (;;) {
      const c = readChar();
      if (c < 0) return -1;                                  // EOF, or the host asked us to stop
      if (c === 13 || c === 10) {                            // Enter ends the line
        if (echo) putc(10);
        pending.push(10);
        return pending.shift();
      }
      if (c === 8 || c === 127) {                            // backspace edits the line
        if (pending.length) {
          pending.pop();
          if (echo) { putc(8); putc(32); putc(8); }
        }
        continue;
      }
      pending.push(c & 0xff);
      if (echo) putc(c & 0xff);
    }
  }

  Object.assign(M.rt, {
    getchar,
    putchar: (c) => { M.write(String.fromCharCode(c & 0xff)); return c & 0xff; },
    /** `gets` is unsafe by design and still in 1990s code; the caller's buffer is its own problem. */
    gets: (buf) => {
      let n = 0;
      for (;;) {
        const c = getchar();
        if (c < 0) return n ? buf : 0;
        if (c === 10) break;
        M.u8[buf + n++] = c;
      }
      M.u8[buf + n] = 0;
      return buf;
    },
  });

  return M.console;
}
