/*
 * dgamouse.c -- the XFree86-DGA mouse as an X client meets it, for tools/gate-dga-mouse.mjs.
 *
 * GLQuake, Quake III and Enemy Territory all ask for it first (in_dgamouse 1): XF86DGAQueryVersion,
 * then XF86DGADirectVideo with XF86DGADirectMouse, after which a MotionNotify reports how far the
 * pointer MOVED -- GLQuake reads xmotion.x and y, the other two x_root and y_root. This reads the
 * events a host scripts and prints both pairs, with the mode on and then off again.
 */
#include <stdio.h>
#include <X11/Xlib.h>
#include <X11/extensions/xf86dga.h>

static void drain(Display *dpy, const char *mode) {
  while (XPending(dpy)) {
    XEvent e;
    XNextEvent(dpy, &e);
    if (e.type == MotionNotify) printf("%s motion x %d y %d root %d %d\n", mode, e.xmotion.x, e.xmotion.y, e.xmotion.x_root, e.xmotion.y_root);
    else if (e.type == ButtonPress) printf("%s press %u\n", mode, e.xbutton.button);
    else if (e.type == ButtonRelease) printf("%s release %u\n", mode, e.xbutton.button);
  }
}

int main(void) {
  Display *dpy = XOpenDisplay(NULL);
  int major = -1, minor = -1, i;
  if (!XF86DGAQueryVersion(dpy, &major, &minor)) { printf("no DGA\n"); return 1; }
  printf("DGA %d.%d\n", major, minor);
  XWarpPointer(dpy, None, None, 0, 0, 0, 0, 100, 80);
  for (i = 0; i < 3; i++) drain(dpy, "position");
  printf("direct mouse: %d\n", XF86DGADirectVideo(dpy, DefaultScreen(dpy), XF86DGADirectMouse));
  for (i = 0; i < 4; i++) drain(dpy, "dga");
  printf("off: %d\n", XF86DGADirectVideo(dpy, DefaultScreen(dpy), 0));
  for (i = 0; i < 3; i++) drain(dpy, "position");
  return 0;
}
