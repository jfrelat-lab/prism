/* What SDL 2 answers about a renderer's logical size, and whether SDL_PollEvent(NULL) only looks.
 *
 * For each window and logical size: the scale SDL_RenderGetScale gives (printed exactly, as a float's
 * bits and value) and the viewport SDL_RenderGetViewport gives, in logical units. Abuse scales its
 * mouse by both. Then the event queue: SDL_PollEvent(NULL) must leave the event it found, so a
 * second NULL poll still sees it and a real poll still gets it. And SDL_GetWindowDisplayMode: the
 * closest display mode at least the window's size, or -1 and a zeroed mode. Run against the real SDL 2 in the
 * oracle container (SDL_VIDEODRIVER=dummy) and through PRISM (gate-sdl2-render). */
#include <stdio.h>
#include <string.h>
#include <SDL.h>

static void mode(int ww, int wh)
{
	SDL_Window *win = SDL_CreateWindow("m", 0, 0, ww, wh, 0);
	SDL_DisplayMode m, desk;
	int r;
	/* The display itself (its size, format and rate) is the host's: compared with the desktop's mode. */
	SDL_GetDesktopDisplayMode(0, &desk);
	memset(&m, 0x55, sizeof m);
	r = SDL_GetWindowDisplayMode(win, &m);
	if (r == 0)
		printf("window %dx%d display mode: 0, the desktop's format %d size %d rate %d\n", ww, wh,
		       m.format == desk.format, m.w == desk.w && m.h == desk.h, m.refresh_rate == desk.refresh_rate);
	else
		printf("window %dx%d display mode: %d, zeroed %d\n", ww, wh, r,
		       m.format == 0 && m.w == 0 && m.h == 0 && m.refresh_rate == 0);
	SDL_DestroyWindow(win);
}

static void scene(int ww, int wh, int lw, int lh)
{
	SDL_Window *win;
	SDL_Renderer *r;
	float sx, sy;
	unsigned bits;
	SDL_Rect vp;
	if (SDL_CreateWindowAndRenderer(ww, wh, 0, &win, &r) != 0) { printf("create %s\n", SDL_GetError()); return; }
	SDL_RenderSetLogicalSize(r, lw, lh);
	SDL_RenderGetScale(r, &sx, &sy);
	SDL_RenderGetViewport(r, &vp);
	memcpy(&bits, &sx, 4);
	printf("window %dx%d logical %dx%d: scale %08x %.9g %.9g viewport %d %d %d %d\n",
	       ww, wh, lw, lh, bits, sx, sy, vp.x, vp.y, vp.w, vp.h);
	SDL_DestroyRenderer(r);
	SDL_DestroyWindow(win);
}

int main(void)
{
	SDL_Event e;
	int a, b, c, d;
	if (SDL_Init(SDL_INIT_VIDEO) != 0) { printf("init %s\n", SDL_GetError()); return 1; }
	scene(640, 480, 320, 240);     /* the same aspect, a whole scale */
	scene(1024, 768, 320, 240);    /* the same aspect, 3.2: the viewport truncates */
	scene(800, 480, 320, 240);     /* wider window: side bars */
	scene(640, 600, 320, 240);     /* taller window: letterbox */
	scene(1000, 700, 333, 222);    /* neither divides */
	scene(320, 200, 320, 200);     /* scale 1 */
	mode(640, 480);                /* the display mode a window would be fullscreen in */
	mode(1024, 768);               /* the desktop's own size (PRISM's and the dummy driver's: 1024x768) */
	mode(1280, 1024);              /* larger than the desktop: no mode */

	SDL_PumpEvents();
	SDL_FlushEvents(SDL_FIRSTEVENT, SDL_LASTEVENT);
	memset(&e, 0, sizeof e);
	e.type = SDL_USEREVENT;
	e.user.code = 42;
	SDL_PushEvent(&e);
	a = SDL_PollEvent(NULL);
	b = SDL_PollEvent(NULL);
	memset(&e, 0, sizeof e);
	c = SDL_PollEvent(&e);
	d = SDL_PollEvent(NULL);
	printf("poll NULL %d, NULL again %d, real %d (type %x code %d), then NULL %d\n",
	       a, b, c, e.type, e.user.code, d);
	SDL_Quit();
	return 0;
}
