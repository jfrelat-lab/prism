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
// the program exits or `stop()` answers true (the page's host).

const GLUT_ELAPSED_TIME = 700, GLUT_WINDOW_WIDTH = 102, GLUT_WINDOW_HEIGHT = 103, GLUT_VISIBLE = 1;

export function installGlut(M, { frames = null, onFrame = null, stepMs = 40, stop = () => false, onSwap = null } = {}) {
  const gl = M.gl;
  if (!gl) throw new Error('glut: needs the gl environment');
  const want = frames ? new Set(frames) : null;
  const last = frames ? Math.max(...frames) : Infinity;
  const s = { w: 300, h: 300, swaps: 0, redisplay: false, cb: {} };
  const call = (p, args = []) => { if (p) M.icall(p, args); };
  Object.assign(M.rt, {
    glutInit: () => {}, glutInitDisplayMode: () => {},
    glutInitWindowSize: (w, h) => { s.w = w; s.h = h; },
    glutInitWindowPosition: () => {},
    glutCreateWindow: () => { gl.resize(s.w, s.h); return 1; },
    glutDestroyWindow: () => {},
    glutDisplayFunc: (p) => { s.cb.display = p; },
    glutReshapeFunc: (p) => { s.cb.reshape = p; },
    glutIdleFunc: (p) => { s.cb.idle = p; },
    glutVisibilityFunc: (p) => { s.cb.visibility = p; },
    glutKeyboardFunc: (p) => { s.cb.keyboard = p; },
    glutSpecialFunc: (p) => { s.cb.special = p; },
    glutPostRedisplay: () => { s.redisplay = true; },
    glutGet: (what) => (what === GLUT_ELAPSED_TIME ? s.swaps * stepMs : what === GLUT_WINDOW_WIDTH ? s.w : what === GLUT_WINDOW_HEIGHT ? s.h : 0),
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
    glutDisplayFunc: f(V, P), glutReshapeFunc: f(V, P), glutIdleFunc: f(V, P), glutVisibilityFunc: f(V, P),
    glutKeyboardFunc: f(V, P), glutSpecialFunc: f(V, P), glutPostRedisplay: f(V), glutGet: f(I, I),
    glutSwapBuffers: f(V), glutMainLoop: f(V),
  };
}
