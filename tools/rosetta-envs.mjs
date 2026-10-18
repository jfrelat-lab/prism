// rosetta-envs.mjs — the environment PRISM builds a Rosetta Code solution with, by what it includes.
// Shared by tools/rosetta.mjs (the build) and tools/rosetta-run.mjs (the run), so both make one build.
export const ENV_TARGET = {
  glut: { env: ['stdio', 'tz', 'gl', 'glut', 'glu'] },
  gl: { env: ['stdio', 'tz', 'gl', 'glut', 'glu'] },
  sdl: { env: ['stdio', 'tz', 'sdl12'] },
  sdl2: { env: ['stdio', 'tz', 'sdl2'] },
  x11: { env: ['stdio', 'tz', 'x11'] },
  // The Win32 shim is C compiled with the program, as PuTTY's windowed build has it: win32.c is the
  // window, win32-gui.c USER's dialogs and odds (Beep, RegisterClassA), win32-net.c the pump win32.c
  // expects beside it (targets/putty.json).
  win32: { env: ['stdio', 'tz', 'getopt', 'wsock', 'vgafont'], generated: ['src/env/wide.c', 'src/env/inttypes.c', 'src/env/win32-app.c', 'src/env/win32-net.c', 'src/env/win32-gui.c', 'src/env/win32.c'] },
  /*
   * A Win32 program with main() rather than WinMain(): a console program, or one that opens windows
   * from main. win32.c's own main (which calls WinMain) is renamed out of the way, so the program's
   * is the entry and the rest of the shim is still there.
   */
  'win32-main': { env: ['stdio', 'tz', 'getopt', 'wsock', 'vgafont'],
    generated: ['src/env/wide.c', 'src/env/inttypes.c', 'src/env/win32-app.c', 'src/env/win32-net.c', 'src/env/win32-gui.c', 'src/env/win32.c'],
    unitDefines: { 'src/env/win32.c': { main: 'prism_win32_main' } } },
};
