// glut.js — the GLUT a GLUT program links against, on src/env/gl.js.
//
// The window is gl.js's framebuffer. The schedule is the one tools/oracle/glut-egl.c gives the
// reference build, because frames are compared one for one:
//   glutMainLoop: reshape(w, h); visibility(GLUT_VISIBLE); display; then { idle; if a redisplay was
//   posted: display } until the host says stop.
//   GLUT_ELAPSED_TIME is `stepMs` times the number of glutSwapBuffers so far (40 by default), so a
//   program that animates by elapsed time draws the same scene at the same frame on both sides.
// `frames`, a list of frame numbers (counted at swap, from 0), hands each of those pictures to
// `onFrame(index, rgba, width, height)`; the loop ends after the last one. With none it runs until
// the program exits or `stop()` answers true (the page's host). `now()`, when given, is the elapsed
// time in ms instead of the fixed step -- the page passes real time, so the gears turn at 70 degrees
// a second whatever the frame rate.

import { GLUT_H } from './headers-gl.js';

const GLUT_ELAPSED_TIME = 700, GLUT_WINDOW_WIDTH = 102, GLUT_WINDOW_HEIGHT = 103, GLUT_VISIBLE = 1, GLUT_STENCIL = 0x20, GLUT_DOUBLE = 2;
/*
 * WHAT GLUT ANSWERS ABOUT ITSELF, the same here and in tools/oracle/glut-egl.c (the reference build
 * of the GL gates), so that a program that asks takes the same path on both sides: glutGet,
 * glutDeviceGet, glutLayerGet and glutGameModeGet by their GLUT 3.7 numbers. A window of 8 bits a
 * colour channel with a 24-bit depth buffer, on a 1024x768 screen; a keyboard and a three-button
 * mouse; no overlay, no colour index, no extension claimed (glutExtensionSupported is 0, so a program
 * takes its baseline path on both sides).
 */
const GET = { 100: 0, 101: 0, 104: 32, 106: 24, 107: 8, 108: 8, 109: 8, 110: 8, 116: 1, 200: 1024, 201: 768, 202: 361, 203: 271, 400: 1 };
const DEVICE = { 600: 1, 601: 1, 605: 3 };

export function installGlut(M, { frames = null, onFrame = null, stepMs = 40, stop = () => false, onSwap = null, now = null, events = null } = {}) {
  const gl = M.gl;
  if (!gl) throw new Error('glut: needs the gl environment');
  const want = frames ? new Set(frames) : null;
  const last = frames ? Math.max(...frames) : Infinity;
  // GLUT's default display mode is GLUT_RGBA | GLUT_SINGLE: single-buffered until the program says.
  const s = { w: 300, h: 300, swaps: 0, redisplay: false, double: false, cb: {}, pointer: [0, 0], mode: 0, cursor: 1, gameMode: 0,
    // glutTimerFunc: { due, fn, value, n } in registration order; menus: id -> entries
    timers: [], timerN: 0, menus: new Map(), menu: 0, nextMenu: 1 };
  const time = () => (now ? Math.floor(now()) : s.swaps * stepMs);
  /*
   * TIMERS fire once each, at the first turn of the loop whose time has reached theirs -- before the
   * idle callback, oldest due first and in registration order among equals -- with the value they were
   * given. Time is GLUT_ELAPSED_TIME's, so a timer-driven program draws the same frame on both sides.
   */
  function fireTimers() {
    if (!s.timers.length) return;
    const t = time(), due = s.timers.filter((x) => x.due <= t).sort((a, b) => a.due - b.due || a.n - b.n);
    if (!due.length) return;
    s.timers = s.timers.filter((x) => x.due > t);
    for (const x of due) call(x.fn, [x.value]);
  }
  const menu = () => s.menus.get(s.menu);
  /*
   * A FRAME ENDS where the picture becomes visible: at glutSwapBuffers when double-buffered, and when
   * the display callback returns when single-buffered -- which draws to the front buffer and ends with
   * glFlush. Counting swaps alone, a single-buffered program had no frames at all.
   */
  function present() {
    // The window's picture, whatever framebuffer object the program has bound.
    if (want?.has(s.swaps) && onFrame) onFrame(s.swaps, gl.readPixels(), gl.state.win.width, gl.state.win.height);
    if (onSwap) onSwap(s.swaps, gl);
    if (s.swaps++ >= last) throw new Error('__glut_done');
  }
  function display() { call(s.cb.display); if (!s.double) present(); }
  const call = (p, args = []) => { if (p) M.icall(p, args); };
  const FACES = [[[-1, 0, 0], [0, 1, 2, 3]], [[0, 1, 0], [3, 2, 6, 7]], [[1, 0, 0], [7, 6, 5, 4]],
    [[0, -1, 0], [4, 5, 1, 0]], [[0, 0, 1], [5, 6, 2, 1]], [[0, 0, -1], [7, 4, 0, 3]]];
  function cube(size, mode) {
    const h = size / 2;
    const v = [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h], [h, -h, -h], [h, -h, h], [h, h, h], [h, h, -h]];
    for (const [n, idx] of FACES) {
      M.rt.glBegin(mode);
      M.rt.glNormal3f(n[0], n[1], n[2]);
      for (const i of idx) M.rt.glVertex3f(Math.fround(v[i][0]), Math.fround(v[i][1]), Math.fround(v[i][2]));
      M.rt.glEnd();
    }
  }
  Object.assign(M.rt, {
    glutInit: () => {},
    // Of the display mode, only the stencil buffer changes what gl.js allocates: 8 bits, as Mesa's.
    glutInitDisplayMode: (mode) => { s.mode = mode; gl.stencilBits = mode & GLUT_STENCIL ? 8 : 0; s.double = (mode & GLUT_DOUBLE) !== 0; },
    // The display string's words that change something here: double and stencil (GLUT 3.7's grammar otherwise ignored).
    glutInitDisplayString: (p) => { const w = M.mod.cstr(p).split(/\s+/).map((x) => x.split(/[=<>~!]/)[0]); M.rt.glutInitDisplayMode((w.includes('double') ? GLUT_DOUBLE : 0) | (w.includes('stencil') ? GLUT_STENCIL : 0)); },
    glutInitWindowSize: (w, h) => { s.w = w; s.h = h; },
    glutInitWindowPosition: () => {},
    glutCreateWindow: () => { gl.resize(s.w, s.h); return 1; },
    glutDestroyWindow: () => {},
    // One window, number 1: the one glutCreateWindow made. Its title is nowhere to be shown.
    glutGetWindow: () => 1, glutSetWindow: () => {}, glutSetWindowTitle: () => {},
    /*
     * glutWireCube / glutSolidCube: six faces about the origin, each with its outward normal, drawn
     * through gl.js's own immediate mode -- as GLUT's library draws them through the GL it links.
     */
    glutWireCube: (size) => cube(size, 0x0002 /* GL_LINE_LOOP */),
    glutSolidCube: (size) => cube(size, 0x0007 /* GL_QUADS */),
    glutDisplayFunc: (p) => { s.cb.display = p; },
    glutReshapeFunc: (p) => { s.cb.reshape = p; },
    glutIdleFunc: (p) => { s.cb.idle = p; },
    glutVisibilityFunc: (p) => { s.cb.visibility = p; },
    glutKeyboardFunc: (p) => { s.cb.keyboard = p; },
    glutSpecialFunc: (p) => { s.cb.special = p; },
    glutKeyboardUpFunc: (p) => { s.cb.keyboardUp = p; },
    glutSpecialUpFunc: (p) => { s.cb.specialUp = p; },
    glutMouseFunc: (p) => { s.cb.mouse = p; },
    glutMotionFunc: (p) => { s.cb.motion = p; },
    glutPassiveMotionFunc: (p) => { s.cb.passive = p; },
    // The host delivers one press per press: there is no auto-repeat to ignore, no cursor, no mode switch.
    glutIgnoreKeyRepeat: () => {}, glutSetCursor: (c) => { s.cursor = c; },
    glutWarpPointer: (x, y) => { s.pointer = [x, y]; },
    // Game mode takes the whole display, whatever window size was asked for: here a 640x480 one.
    glutEnterGameMode: () => { s.w = 640; s.h = 480; s.gameMode = 1; gl.resize(s.w, s.h); return 1; },
    glutLeaveGameMode: () => { s.gameMode = 0; },
    glutPostRedisplay: () => { s.redisplay = true; },
    glutGet: (what) => (what === GLUT_ELAPSED_TIME ? time() : what === GLUT_WINDOW_WIDTH ? s.w : what === GLUT_WINDOW_HEIGHT ? s.h
      : what === 105 ? (s.mode & GLUT_STENCIL ? 8 : 0) : what === 115 ? (s.double ? 1 : 0) : what === 122 ? s.cursor
      : what === 300 ? (menu()?.length ?? 0) : what === 502 ? s.w : what === 503 ? s.h : what === 504 ? s.mode : GET[what] ?? 0),
    glutDeviceGet: (what) => DEVICE[what] ?? 0,
    glutLayerGet: () => 0,
    glutGetModifiers: () => 0,
    glutExtensionSupported: () => 0,
    glutGameModeGet: (what) => (what === 0 ? s.gameMode : what === 1 ? 1 : what === 2 ? 640 : what === 3 ? 480 : what === 4 ? 32 : what === 5 ? 60 : 0),
    glutGameModeString: () => {},
    glutTimerFunc: (ms, fn, value) => { s.timers.push({ due: time() + (ms >>> 0), fn, value, n: s.timerN++ }); },
    glutPostWindowRedisplay: () => { s.redisplay = true; },
    // Menus are kept (glutGet(GLUT_MENU_NUM_ITEMS) counts their entries) and never shown: no click opens one.
    glutCreateMenu: () => { const id = s.nextMenu++; s.menus.set(id, []); s.menu = id; return id; },
    glutDestroyMenu: (id) => { s.menus.delete(id); if (s.menu === id) s.menu = 0; },
    glutGetMenu: () => s.menu,
    glutSetMenu: (id) => { if (s.menus.has(id)) s.menu = id; },
    glutAddMenuEntry: (_label, value) => { menu()?.push(value); },
    glutAddSubMenu: (_label, sub) => { menu()?.push(-sub); },
    glutChangeToMenuEntry: (item, _label, value) => { const m = menu(); if (m && item >= 1 && item <= m.length) m[item - 1] = value; },
    glutChangeToSubMenu: (item, _label, sub) => { const m = menu(); if (m && item >= 1 && item <= m.length) m[item - 1] = -sub; },
    glutRemoveMenuItem: (item) => { const m = menu(); if (m && item >= 1 && item <= m.length) m.splice(item - 1, 1); },
    glutAttachMenu: () => {}, glutDetachMenu: () => {},
    /*
     * WHAT A WINDOW MANAGER WOULD DO, done by nobody: the window keeps its size and place (reshaping
     * would change the picture's size between the two sides), there are no subwindows of its own
     * (a subwindow draws into the one window), no overlay and no colour index.
     */
    glutCreateSubWindow: () => 2,
    glutReshapeWindow: () => {}, glutPositionWindow: () => {}, glutPopWindow: () => {}, glutPushWindow: () => {},
    glutIconifyWindow: () => {}, glutShowWindow: () => {}, glutHideWindow: () => {}, glutFullScreen: () => {}, glutSetIconTitle: () => {},
    glutSetKeyRepeat: () => {}, glutReportErrors: () => {}, glutForceJoystickFunc: () => {},
    glutEstablishOverlay: () => {}, glutRemoveOverlay: () => {}, glutUseLayer: () => {}, glutPostOverlayRedisplay: () => {},
    glutPostWindowOverlayRedisplay: () => {}, glutShowOverlay: () => {}, glutHideOverlay: () => {},
    glutSetColor: () => {}, glutGetColor: () => 0, glutCopyColormap: () => {},
    glutVideoResizeGet: () => 0, glutSetupVideoResizing: () => {}, glutStopVideoResizing: () => {}, glutVideoResize: () => {}, glutVideoPan: () => {},
    // Callbacks for devices and events this host never has: kept, never called.
    ...Object.fromEntries(['Entry', 'MenuStatus', 'MenuState', 'WindowStatus', 'OverlayDisplay', 'SpaceballMotion', 'SpaceballRotate', 'SpaceballButton',
      'ButtonBox', 'Dials', 'TabletMotion', 'TabletButton', 'Joystick'].map((n) => [`glut${n}Func`, (p) => { s.cb[n] = p; }])),
    // "If the layer in use is not double buffered, glutSwapBuffers has no effect" (GLUT 3 spec 4.6).
    glutSwapBuffers: () => { if (s.double) present(); },
    glutMainLoop: () => {
      try {
        call(s.cb.reshape, [s.w, s.h]);
        call(s.cb.visibility, [GLUT_VISIBLE]);
        display();
        while (!stop()) {
          // Input the host has gathered since the last turn: `events()` yields
          //   { kind: 'key', ch, down }  { kind: 'special', key, down }
          //   { kind: 'button', button, down, x, y }  { kind: 'motion', x, y, held }
          let handled = false;
          for (const ev of events ? events() : []) {
            handled = true;
            const [x, y] = ev.x === undefined ? s.pointer : (s.pointer = [ev.x, ev.y]);
            if (ev.kind === 'key') call(ev.down ? s.cb.keyboard : s.cb.keyboardUp, [ev.ch, x, y]);
            else if (ev.kind === 'special') call(ev.down ? s.cb.special : s.cb.specialUp, [ev.key, x, y]);
            else if (ev.kind === 'button') call(s.cb.mouse, [ev.button, ev.down ? 0 : 1, x, y]);
            else if (ev.kind === 'motion') call(ev.held ? s.cb.motion : s.cb.passive, [x, y]);
          }
          fireTimers();
          call(s.cb.idle);
          if (s.redisplay) { s.redisplay = false; display(); }
          // Single-buffered, an idle callback that draws draws on the front buffer, visible as it is:
          // Rosetta Code's pendulum renders from glutIdleFunc and never posts a redisplay.
          else if (!s.double && s.cb.idle) present();
          // ...and so does a key or mouse callback that draws straight away: Rosetta Code's
          // interactive Mandelbrot re-renders from its keyboard handler, with no redisplay posted.
          else if (!s.double && handled) present();
          /*
           * A window with nothing to do still shows its picture. Real GLUT blocks for an event here;
           * a run that asked for frames by number counts the unchanged window as the next one, or a
           * static program (Rosetta Code's OpenGL triangle) never reached frame 2.
           */
          else if (want && !s.cb.idle) present();
        }
      } catch (e) { if (e.message !== '__glut_done') throw e; }
    },
  });
  M.glut = s;
  return s;
}

/*
 * The signatures, read from PRISM's glut.h (generated from GLUT 3.7's, tools/gen-glut-h.mjs): every
 * entry point it declares, so a call compiles whether or not this file answers it yet -- one it does
 * not answer is a named error when it is called, not a compile failure of the whole program.
 */
export function glutBuiltins(T) {
  const type = (t) => {
    t = t.replace(/\b(const|struct)\b/g, '').trim();
    if (t.includes('*')) return T.ptr(T.CHAR);
    if (/^(void)$/.test(t)) return T.VOID;
    if (/^(unsigned int|unsigned|GLuint|GLenum|GLbitfield)$/.test(t)) return T.UINT;
    if (/^(double|GLdouble)$/.test(t)) return T.DOUBLE;
    if (/^(float|GLfloat)$/.test(t)) return T.FLOAT;
    if (/^(unsigned char|GLubyte)$/.test(t)) return T.UCHAR;
    return T.INT;
  };
  const out = {};
  for (const m of GLUT_H.matchAll(/^([\w ]+?\**)\s*(glut\w+)\((.*)\);$/gm)) {
    const params = m[3].trim() === 'void' ? [] : m[3].split(/,(?![^(]*\))/).map((p) => {
      p = p.trim();
      if (p.includes('(*')) return T.ptr(T.CHAR);                           // a callback
      const toks = p.replace(/\*/g, ' * ').trim().split(/\s+/);
      if (toks.length > 1 && toks.at(-1) !== '*') toks.pop();                // its name
      return type(toks.join(' '));
    });
    out[m[2]] = { ret: type(m[1]), params };
  }
  return out;
}
