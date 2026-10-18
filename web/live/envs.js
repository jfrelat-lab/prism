// envs.js — which environment a C program is built and run in, read from what it includes.
//
// One table for the two places that ask: Live C, which picks the machine a typed program runs on,
// and tools/rosetta.mjs, which builds Rosetta Code's solutions the same way (tools/rosetta-envs.mjs
// re-exports this). Each entry is what a target in targets/*.json would say -- its `env`, its
// `generated` units, its `unitDefines` -- plus the page's host and the machine that shows it.
//
// The code is the witness, not a menu: a program that includes <windows.h> is a Win32 program
// whatever the page was set to. Its includes decide, first match wins.

export const ENV_TARGET = {
  glut: { env: ['stdio', 'tz', 'gl', 'glut', 'glu'], host: 'glut', machine: 'linux' },
  gl: { env: ['stdio', 'tz', 'gl', 'glut', 'glu'], host: 'glut', machine: 'linux' },
  sdl: { env: ['stdio', 'tz', 'sdl12'], host: 'sdl', machine: 'linux' },
  sdl2: { env: ['stdio', 'tz', 'sdl2'], host: 'sdl2', machine: 'linux' },
  x11: { env: ['stdio', 'tz', 'x11'], host: 'x11', machine: 'linux' },
  /*
   * The Win32 shim is C compiled with the program, as PuTTY's windowed build has it: win32.c is the
   * window, win32-gui.c USER and GDI (it rasterises what GDI draws), win32-net.c the pump win32.c
   * expects beside it (targets/putty.json).
   */
  win32: {
    env: ['stdio', 'tz', 'getopt', 'wsock', 'vgafont'], host: 'win32', machine: 'win',
    generated: ['src/env/wide.c', 'src/env/inttypes.c', 'src/env/win32-app.c', 'src/env/win32-net.c', 'src/env/win32-gui.c', 'src/env/win32.c'],
  },
  /*
   * A Win32 program with main() rather than WinMain(): a console program, or one that opens windows
   * from main. win32.c's own main (which calls WinMain) is renamed out of the way, so the program's
   * is the entry and the rest of the shim is still there.
   */
  'win32-main': {
    env: ['stdio', 'tz', 'getopt', 'wsock', 'vgafont'], host: 'win32', machine: 'win',
    generated: ['src/env/wide.c', 'src/env/inttypes.c', 'src/env/win32-app.c', 'src/env/win32-net.c', 'src/env/win32-gui.c', 'src/env/win32.c'],
    unitDefines: { 'src/env/win32.c': { main: 'prism_win32_main' } },
  },
};

/** Includes that name an environment, in the order they are tried. */
const BY_INCLUDE = [
  ['win32', /^\s*#\s*include\s*[<"](windows|winuser|wingdi|commctrl)\.h[>"]/im],
  ['sdl2', /^\s*#\s*include\s*[<"]SDL2\/SDL\.h[>"]/im],
  ['sdl', /^\s*#\s*include\s*[<"](SDL\/)?SDL\.h[>"]/im],
  ['glut', /^\s*#\s*include\s*[<"][Gg][Ll]\/(glut|freeglut)\.h[>"]/im],
  ['gl', /^\s*#\s*include\s*[<"](GL|gl|OpenGL)\/gl\.h[>"]/im],
  ['x11', /^\s*#\s*include\s*[<"]X11\/Xlib\.h[>"]/im],
];

/**
 * The environment for a program given as its sources: a key of ENV_TARGET, or 'console' for a
 * program that needs only the C library. A Win32 program without WinMain is 'win32-main'.
 */
export function detectEnv(sources) {
  const text = sources.join('\n');
  const hit = BY_INCLUDE.find(([, re]) => re.test(text))?.[0] ?? 'console';
  if (hit === 'win32' && !/\bWinMain\s*\(/.test(text)) return 'win32-main';
  return hit;
}

/*
 * __DATE__ and __TIME__ for a program typed into Live C: NOW, in local time, as gcc stamps them. The
 * compiler fixes them (src/compile.js: Jan  1 1996, 00:00:00) so that a build is reproducible, which
 * is what every gate and every precompiled bundle needs -- and what a program compiled here, now, for
 * the person who wrote it, does not: its banner printed 1996.
 */
export function nowDefines(d = new Date()) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const two = (n) => String(n).padStart(2, '0');
  return {
    // "Mmm dd yyyy", the day padded with a SPACE (C11 6.10.8.1), as gcc's "Oct  8 2026".
    __DATE__: `"${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${d.getFullYear()}"`,
    __TIME__: `"${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}"`,
  };
}
