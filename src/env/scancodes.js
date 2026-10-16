// scancodes.js — browser KeyboardEvent.code -> IBM PC scan-code set 1.
//
// Not a MAME table. Set 1 is what the PC keyboard controller produced, so it is what every DOS-era
// program reads: MAME 0.1's OSD_KEY_* constants are set-1 codes ("courtesy of allegro.h", says its
// own osdepend.h), DJGPP programs read them from the BIOS, and Quake's keyboard handler switches on
// them directly. One table serves every program PRISM will ever host.
//
// `code` rather than `key` on purpose: `code` is the physical key, so W is the same slot on AZERTY as
// on QWERTY. A game asking "is the up-arrow key held" wants the position, not the letter the layout
// prints on it — and MAME's default Pac-Man controls are the arrow keys.

export const SCANCODE = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20,
  KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34,
  KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48,
  KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
  F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  F11: 87, F12: 88,

  // The extended keys. On real hardware these arrive as 0xE0-prefixed pairs, but set 1's software
  // convention — the one Allegro, the BIOS and MAME all use — is the numeric-keypad code without
  // the prefix, which is why the arrows share numbers with Numpad4/8/6/2 above.
  ArrowUp: 72, ArrowLeft: 75, ArrowRight: 77, ArrowDown: 80,
  Home: 71, End: 79, PageUp: 73, PageDown: 81,
  Insert: 82, Delete: 83,
  ControlRight: 29, AltRight: 56, NumpadEnter: 28, NumpadDivide: 53,
};

/** 0 when the browser reports a key set 1 has no code for (media keys, IME keys). */
export function scancodeFor(code) {
  return SCANCODE[code] | 0;
}

/**
 * The keys a real controller sends as an 0xE0-PREFIXED PAIR, by `code`.
 *
 * The numbers above are the SOFTWARE convention and stay that way: Allegro, the BIOS and MAME all
 * read the arrows as the keypad codes, which is why ArrowUp and Numpad8 are both 72. But that makes
 * a scan code alone AMBIGUOUS -- 72 is either key -- and the prefix is how a real keyboard tells
 * them apart. A program that reads port 0x60 itself can care: Jump 'n Bump's vector-9 handler files
 * an extended key at (code + 0x80), so its KEY_PL1_JUMP is 0xc8 and a bare 72 lands in a byte it
 * never reads. Carrying this flag ALONGSIDE the code lets such a host send the pair the hardware
 * would, while every program that wants the software convention keeps reading 72.
 */
export const EXTENDED = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
  'ControlRight', 'AltRight', 'NumpadEnter', 'NumpadDivide',
]);

// `key` values for the keys whose name does not simply map onto a `code`.
const BY_KEY = {
  ' ': 'Space', Escape: 'Escape', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Control: 'ControlLeft', Alt: 'AltLeft', Shift: 'ShiftLeft',
  '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
  ';': 'Semicolon', "'": 'Quote', '`': 'Backquote', '\\': 'Backslash',
  ',': 'Comma', '.': 'Period', '/': 'Slash',
};

/**
 * The scan code for a KeyboardEvent, preferring `code` and falling back to `key`.
 *
 * `code` is the right answer — it is the physical key, so W is the same slot on AZERTY as on QWERTY,
 * and a game asking "is up held" wants the position. But `code` is not always populated: events
 * synthesised by automation, some remote-desktop stacks and on-screen keyboards arrive with `code`
 * empty, and a shell that reads only `code` drops them silently. Found exactly that way — every key
 * sent by the test harness was discarded while the display looked perfect.
 */
export function scancodeForEvent(e) {
  const byCode = SCANCODE[e.code] | 0;
  if (byCode) return byCode;
  const k = e.key;
  if (!k) return 0;
  if (BY_KEY[k]) return SCANCODE[BY_KEY[k]] | 0;
  if (k.length === 1) {
    const c = k.toUpperCase();
    if (c >= 'A' && c <= 'Z') return SCANCODE['Key' + c] | 0;
    if (c >= '0' && c <= '9') return SCANCODE['Digit' + c] | 0;
  }
  if (/^F([1-9]|1[0-2])$/.test(k)) return SCANCODE[k] | 0;
  return 0;
}

/**
 * Whether that same event is an extended key -- resolved the way scancodeForEvent resolves it, by
 * `code` first and `key` second, so a synthesised event with no `code` is not silently reported as
 * a plain key while its scan code comes through.
 */
export function extendedForEvent(e) {
  if (e.code) return EXTENDED.has(e.code);
  return !!(e.key && BY_KEY[e.key] && EXTENDED.has(BY_KEY[e.key]));
}

/*
 * THE VISITOR'S LAYOUT, for a host that names a key by what it says (an X keysym, an SDL symbol).
 * By default a key is its POSITION -- the letter a US keyboard prints there -- because that is what a
 * game's controls are laid out for: on AZERTY the Z key is still "w" and the number row still "1".
 * Asked to (`typed`), a key is the character the visitor's layout produced on it, as a real X server
 * or SDL on a French machine would answer: letters right for typing, and the number row "&" and "é"
 * as French players knew it. The character is the one the page saw on the press; a release keeps it,
 * so a program that pairs presses with releases by symbol still finds them.
 */
export function keyNames(mode = 'positions') {
  const typed = new Uint16Array(128);
  return {
    typed: mode === 'typed',
    // Record what a press produced on that key (printable characters only).
    note(scan, ascii, down) { if (down && ascii >= 0x20 && ascii < 0x7f) typed[scan & 127] = ascii; },
    // The character for that key in `typed` mode, or 0: the caller's own table answers then.
    char(scan) { return mode === 'typed' ? typed[scan & 127] : 0; },
    // The same, unshifted, as a keysym or an SDL symbol is: a letter in lower case.
    sym(scan) { const c = this.char(scan); return c >= 0x41 && c <= 0x5a ? c + 0x20 : c; },
  };
}
