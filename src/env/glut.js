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

const GLUT_ELAPSED_TIME = 700, GLUT_WINDOW_WIDTH = 102, GLUT_WINDOW_HEIGHT = 103, GLUT_VISIBLE = 1, GLUT_STENCIL = 0x20;

export function installGlut(M, { frames = null, onFrame = null, stepMs = 40, stop = () => false, onSwap = null, now = null, events = null } = {}) {
  const gl = M.gl;
  if (!gl) throw new Error('glut: needs the gl environment');
  const want = frames ? new Set(frames) : null;
  const last = frames ? Math.max(...frames) : Infinity;
  const s = { w: 300, h: 300, swaps: 0, redisplay: false, cb: {}, pointer: [0, 0] };
  const call = (p, args = []) => { if (p) M.icall(p, args); };
  Object.assign(M.rt, {
    glutInit: () => {},
    // Of the display mode, only the stencil buffer changes what gl.js allocates: 8 bits, as Mesa's.
    glutInitDisplayMode: (mode) => { gl.stencilBits = mode & GLUT_STENCIL ? 8 : 0; },
    glutInitWindowSize: (w, h) => { s.w = w; s.h = h; },
    glutInitWindowPosition: () => {},
    glutCreateWindow: () => { gl.resize(s.w, s.h); return 1; },
    glutDestroyWindow: () => {},
    // One window, number 1: the one glutCreateWindow made. Its title is nowhere to be shown.
    glutGetWindow: () => 1, glutSetWindow: () => {}, glutSetWindowTitle: () => {},
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
    glutIgnoreKeyRepeat: () => {}, glutSetCursor: () => {},
    glutWarpPointer: (x, y) => { s.pointer = [x, y]; },
    // Game mode takes the whole display, whatever window size was asked for: here a 640x480 one.
    glutEnterGameMode: () => { s.w = 640; s.h = 480; gl.resize(s.w, s.h); return 1; },
    glutLeaveGameMode: () => {},
    glutPostRedisplay: () => { s.redisplay = true; },
    glutGet: (what) => (what === GLUT_ELAPSED_TIME ? (now ? Math.floor(now()) : s.swaps * stepMs) : what === GLUT_WINDOW_WIDTH ? s.w : what === GLUT_WINDOW_HEIGHT ? s.h : 0),
    glutSwapBuffers: () => {
      if (want?.has(s.swaps) && onFrame) onFrame(s.swaps, gl.readPixels(), gl.state.width, gl.state.height);
      if (onSwap) onSwap(s.swaps, gl);
      if (s.swaps++ >= last) throw new Error('__glut_done');
    },
    glutMainLoop: () => {
      try {
        call(s.cb.reshape, [s.w, s.h]);
        call(s.cb.visibility, [GLUT_VISIBLE]);
        call(s.cb.display);
        while (!stop()) {
          // Input the host has gathered since the last turn: `events()` yields
          //   { kind: 'key', ch, down }  { kind: 'special', key, down }
          //   { kind: 'button', button, down, x, y }  { kind: 'motion', x, y, held }
          for (const ev of events ? events() : []) {
            const [x, y] = ev.x === undefined ? s.pointer : (s.pointer = [ev.x, ev.y]);
            if (ev.kind === 'key') call(ev.down ? s.cb.keyboard : s.cb.keyboardUp, [ev.ch, x, y]);
            else if (ev.kind === 'special') call(ev.down ? s.cb.special : s.cb.specialUp, [ev.key, x, y]);
            else if (ev.kind === 'button') call(s.cb.mouse, [ev.button, ev.down ? 0 : 1, x, y]);
            else if (ev.kind === 'motion') call(ev.held ? s.cb.motion : s.cb.passive, [x, y]);
          }
          call(s.cb.idle);
          if (s.redisplay) { s.redisplay = false; call(s.cb.display); }
        }
      } catch (e) { if (e.message !== '__glut_done') throw e; }
    },
  });
  M.glut = s;
  return s;
}

export function glutBuiltins(T) {
  const I = T.INT, U = T.UINT, V = T.VOID, P = T.ptr(T.CHAR);
  const f = (ret, ...params) => ({ ret, params });
  return {
    glutInit: f(V, P, P), glutInitDisplayMode: f(V, U), glutInitWindowSize: f(V, I, I),
    glutInitWindowPosition: f(V, I, I), glutCreateWindow: f(I, P), glutDestroyWindow: f(V, I),
    glutGetWindow: f(I), glutSetWindow: f(V, I), glutSetWindowTitle: f(V, P),
    glutDisplayFunc: f(V, P), glutReshapeFunc: f(V, P), glutIdleFunc: f(V, P), glutVisibilityFunc: f(V, P),
    glutKeyboardFunc: f(V, P), glutSpecialFunc: f(V, P), glutPostRedisplay: f(V), glutGet: f(I, I),
    glutKeyboardUpFunc: f(V, P), glutSpecialUpFunc: f(V, P), glutMouseFunc: f(V, P), glutMotionFunc: f(V, P),
    glutPassiveMotionFunc: f(V, P), glutIgnoreKeyRepeat: f(V, I), glutSetCursor: f(V, I), glutWarpPointer: f(V, I, I),
    glutEnterGameMode: f(I), glutLeaveGameMode: f(V),
    glutSwapBuffers: f(V), glutMainLoop: f(V),
  };
}
