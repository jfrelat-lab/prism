# What's new

What changed on [prism-compiler.pages.dev](https://prism-compiler.pages.dev), newest first. The site
is updated continuously, so entries are dated rather than versioned; the source archives a build
comes from are released as [prism-sources](https://github.com/jfrelat-lab/prism-sources/releases).
Every change is in the [commit history](https://github.com/jfrelat-lab/prism/commits/main).

## 2026-10-23

- **Every game has a page of its own**, at an address you can share: [/doom/](https://prism-compiler.pages.dev/doom/),
  [/quake3/](https://prism-compiler.pages.dev/quake3/), [/monkey/](https://prism-compiler.pages.dev/monkey/)... with its
  picture, a Play button, its licences and the source of its build, and a link preview of its own. A
  card's title on the showcase opens it.

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
