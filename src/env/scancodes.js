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
