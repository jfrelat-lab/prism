// gate-keynames.mjs — a key named by its position by default, by what the visitor's layout typed when asked.
//
// The page sends each keystroke as a scan code (where the key is) AND the character the layout made
// of it (src/env/scancodes.js keyNames). On an AZERTY keyboard the key in QWERTY's Q position types
// "a", and the one in the number row's 1 position types "&". This drives src/env/x11.js and
// src/env/sdl12.js with those two presses:
//   - by default (positions) X11's keysym and XLookupString say "q" and "1", SDL's symbol is SDLK_q,
//     as a game's controls expect -- and SDL's `unicode`, which is text, says "a" all the same;
//   - with `typed`, X11 says "a" and "&", SDL's symbol is SDLK_a, and the RELEASE of that key keeps
//     the same keysym, so a program pairing press and release by keysym still finds them.
// The positions run is itself the control: the typed answers must differ from it.
//
//   node tools/gate-keynames.mjs
import { Module } from '../src/link/module.js';
import { makeMachine } from '../src/runtime/runtime.js';
import { installStdio } from '../src/env/stdio.js';
import { installX11 } from '../src/env/x11.js';
import { installSDL12 } from '../src/env/sdl12.js';
import { keyNames } from '../src/env/scancodes.js';

// AZERTY: Q's position types "a", 1's types "&" -- each pressed, then released.
const STROKES = [
  { scan: 0x10, down: true, ascii: 0x61, extended: false }, { scan: 0x10, down: false, ascii: 0, extended: false },
  { scan: 0x02, down: true, ascii: 0x26, extended: false }, { scan: 0x02, down: false, ascii: 0, extended: false },
];

function x11Run(mode) {
  const M = makeMachine(new Module({ memory: 8 * 1024 * 1024 }));
  installStdio(M, {});
  const queue = [...STROKES];
  installX11(M, { keys: keyNames(mode), keyboard: { pending: () => queue.length, next: () => queue.shift() ?? null } });
  const ev = M.rt.malloc(96), buf = M.rt.malloc(8), ks = M.rt.malloc(4), out = [];
  for (let i = 0; i < STROKES.length; i++) {
    M.rt.XNextEvent(0, ev);
    const n = M.rt.XLookupString(ev, buf, 8, ks, 0);
    out.push({ keysym: M.rt.XLookupKeysym(ev, 0), text: n ? String.fromCharCode(M.u8[buf]) : '', lookup: M.mod.dv.getInt32(ks, true) });
  }
  return out;
}

function sdlRun(mode) {
  const M = makeMachine(new Module({ memory: 8 * 1024 * 1024 }));
  installStdio(M, {});
  const sdl = installSDL12(M, {});
  const queue = [...STROKES];
  sdl.state.keys = keyNames(mode);
  sdl.state.keyboard = { next: () => { const e = queue.shift(); return e ? { ...e, ascii: e.down ? e.ascii : 0 } : null; } };
  const ev = M.rt.malloc(64), out = [];
  for (let i = 0; i < STROKES.length; i++) {
    M.rt.SDL_PollEvent(ev);
    out.push({ sym: M.mod.dv.getInt32(ev + 8, true), unicode: M.mod.dv.getUint16(ev + 16, true) });
  }
  return out;
}

let bad = 0;
const check = (ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n     ${JSON.stringify(detail)}`}`); if (!ok) bad++; };
const ch = (c) => c.charCodeAt(0);

const xp = x11Run('positions'), xt = x11Run('typed');
check(xp[0].keysym === ch('q') && xp[0].text === 'q' && xp[2].keysym === ch('1') && xp[2].text === '1',
  'X11, positions: the Q key is "q" and the 1 key is "1", whatever the layout typed', xp);
check(xt[0].keysym === ch('a') && xt[0].text === 'a' && xt[2].keysym === ch('&') && xt[2].text === '&',
  'X11, your layout: the same keys are "a" and "&"', xt);
check(xt[1].keysym === xt[0].keysym && xt[3].keysym === xt[2].keysym, 'X11, your layout: a release keeps its press\'s keysym', xt);

const sp = sdlRun('positions'), st = sdlRun('typed');
check(sp[0].sym === ch('q') && sp[0].unicode === ch('a'), 'SDL, positions: the symbol is SDLK_q, the unicode text "a"', sp);
check(st[0].sym === ch('a') && st[1].sym === ch('a') && st[0].unicode === ch('a'), 'SDL, your layout: the symbol is SDLK_a, press and release', st);

console.log(bad ? `\n${bad} check(s) failed` : '\nkeys are positions by default and the visitor\'s layout when asked');
process.exit(bad ? 1 : 0);
