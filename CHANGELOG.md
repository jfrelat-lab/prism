# What's new

What changed on [prism-compiler.pages.dev](https://prism-compiler.pages.dev), newest first. The site
is updated continuously, so entries are dated rather than versioned; the source archives a build
comes from are released as [prism-sources](https://github.com/jfrelat-lab/prism-sources/releases).
Every change is in the [commit history](https://github.com/jfrelat-lab/prism/commits/main).

## 2026-10-31

- **More of OpenGL and GLU**: picking objects with the mouse (selection) and feedback, spotlights and
  the local viewer, and GLU's tessellator, which cuts any outline -- concave, with holes -- into
  triangles (GLU 9's own code). Edges and quads are now rasterised to the pixel as Mesa's software
  renderer does. Of the OpenGL Red Book's 63 examples, 52 now draw what Mesa draws; of GLUT's 54
  examples, 32, among them the dinosaur and puzzle demos.

## 2026-10-30

- **Faster 3D**: OpenGL's vertex work -- moving, lighting and texturing each point -- now runs on the
  graphics card where it pays. Frames a second of JavaScript: Neverball 40 to 142, Enemy Territory
  101 to 192, Quake III 55 to 95, Chromium B.S.U. 143 to 246.
- **More of OpenGL 1.x and GLUT**: GLUT's spheres, cones, tori, polyhedra, teapot and fonts (GLUT
  3.7's own code), curved surfaces (evaluators), bitmaps, wireframe polygons, the attribute stack,
  every immediate-mode spelling and the multitexture coordinates, lines drawn by the GL's own rule,
  dotted and wide lines, patterned polygons, drawn pixels, 1D textures and the accumulation buffer.
  Of the OpenGL Red Book's 63 examples, 45 now draw what Mesa draws, up from 12. GLSL shaders that
  swizzle a scalar (`m.x`) now compile.

## 2026-10-26

- **Neverball plays**: [/neverball/](https://prism-compiler.pages.dev/neverball/), tilt the floor with
  the mouse to roll the ball to the goal. Version 1.6.0 compiled from its source with everything it
  links (SDL2_ttf, FreeType, libvorbis, libpng, libjpeg), and its 235 levels compiled from their
  sources by Neverball's own level compiler, which PRISM compiled too -- each level identical, byte
  for byte, to what gcc's build makes. Its data is fetched as the game opens it: the menu is there
  after 2.4 MB, not 117.
- **OpenGL**: vertex buffers, point sprites and every vertex-array type; 3D programs draw faster
  (Neverball's intro: 38% less JavaScript a frame).
- **SDL 2 programs** draw with OpenGL, take the mouse (a visible pointer in their menus, captured
  for play) and typed text.
- **Neverball's ball shadow**: OpenGL now has three texture units and their combiners (GL_COMBINE),
  which is how Neverball darkens the floor under the ball. Holes along shared triangle edges in the
  software rasteriser are gone too.
- **OpenGL**: 3D textures (in GLSL shaders), float texels, generated mipmaps, every form of glRect;
  and a polygon far outside the screen is no longer lost (it covered nothing on some GPUs).

## 2026-10-24

- **Quake plays without your files**: [/quake-shareware/](https://prism-compiler.pages.dev/quake-shareware/),
  the first episode from id's own 1.06 shareware archive, served as published and unpacked in the
  page. Its installer is an LHA archive, which the page now reads (checked against the pak it
  installs, byte for byte). Its licence forbids showing the game's screens, so Quake's cards show its
  name instead of a picture.
- **A game's page says "Play your copy"** when the local library holds it, as the showcase does.

## 2026-10-23

- **Every game has a page of its own**, at an address you can share: [/doom/](https://prism-compiler.pages.dev/doom/),
  [/quake3/](https://prism-compiler.pages.dev/quake3/), [/monkey/](https://prism-compiler.pages.dev/monkey/)... with its
  picture, its licences, the repository its source comes from (with its stars), and a link preview
  of its own. **Play runs the game right there**, its controls with it. Opened from a link, the page
  stands alone; opened from the showcase, it keeps the showcase's header. The showcase's cards lead
  there, and their Play starts the game with the page.
- **Arguments and PRISM's log on the game's page.** Type `+map q3dm17` and Quake III starts on The
  Longest Yard; the arguments go in the page's address, so the link can be shared. A link's arguments
  no longer replace the ones a build needs (Quake III stopped on *VM_Compile*).
- **An error says where it happened**, with the log to show or copy, instead of sending you to the
  shelf.
- **Quake III no longer stops when several keys are pressed at once** (*Cannot read properties of
  null (reading 'set')*): reading the next X event without removing it handed back an empty one.

## 2026-10-21

- **Tux Racer loads the right course.** `chdir` did nothing and relative paths were looked up from the
  root, so a course's `elev.rgb` and `terrain.rgb` could come from another course: the race then ran
  on the wrong terrain or stopped with *terrain bitmap must have same dimensions as elevation
  bitmap*. Programs now have a real current directory. The course previews show too.
- **Tux Racer finds its home directory** (`getpwuid` answers with the page's user), so it no longer
  prints *getpwuid: No such file or directory*, and a first run's missing settings file is no longer
  reported as an error. It can also create `~/.tuxracer` and write its settings and saved game there
  for the session (they were refused: *couldn't open ... for writing*).
- **A lost WebGL context no longer ends the game.** When the GPU took the context away (a driver
  reset, memory pressure), a 3D program stopped on a black screen while its sound played on; the page
  now builds a new context and the next frame draws again (seen in Tux Racer, mid-race).
- **Data files that fail to download are retried**, then reported by name, instead of reaching the
  game as an error page.
- **Live C opens an example from a link**: `?example=prism/pointers.c&run=1&tab=emitted` loads it,
  runs it and shows the emitted JavaScript.

## 2026-10-20

- **Bring your files works on the live site.** Games whose data you supply (Quake, MAME's arcade
  games...) failed with *Unexpected token '<'* instead of asking for your files.

## 2026-10-18 — public launch

- **The showcase is public**, with the source of every program it ships released as
  [prism-sources v1.0.1](https://github.com/jfrelat-lab/prism-sources/releases/tag/v1.0.1).
- **Live C** runs console programs and **GLUT, SDL, X11 and Win32** windows, with:
  - an example picker with search, filters and tags, including **787 Rosetta Code solutions**
    loaded from rosettacode.org at the revision PRISM was checked on;
  - a terminal for input and output, a Build pane, and the **emitted JavaScript**, coloured, with
    a library's own code (the Win32 shim) folded away;
  - Reset back to the example as it was loaded, and a visible wait while a solution loads.
- **X11 drawing**: lines, rectangles, arcs, polygons, text, colours and pixmaps, in a window you can
  move and close; the mouse stays visible in Live C.
- **MAME sound**: slow music in Final Fight, silence in 1942 and a freeze in Donkey Kong fixed.
- **The compiler**: four defects found by Rosetta Code's programs fixed, each checked against
  `gcc -m32`; C's `pow`, `printf`'s `'` flag and the C99 math functions added.
