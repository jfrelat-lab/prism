# The static showcase

How [prism-compiler.pages.dev](https://prism-compiler.pages.dev) is made, and how to put PRISM's
programs on a host of your own. The README's [Quick start](../README.md#quick-start) covers running
PRISM locally.

## Building it

`node tools/site.mjs` writes `site/`, a copy of the shelf that needs no server, and `index.html`
turns into its catalogue. The programs are listed in `tools/site-programs.json`:

- the ones it **ships** have code and data that may be passed on (or, for a few, a stated caution);
- its **gallery** holds the ones whose data is not ours to pass on. The page asks the visitor for
  their copy, a folder or a `.zip`, and reads it where it is.

Each program ships as a precompiled bundle (`tools/bundle.mjs`, kept between runs in
`dist/site-bundles/`), with its licences and the **source it was built from**. Every source tree it
reads is archived as published, beside the build scripts (`sources/`, or a release of
`jfrelat-lab/prism-sources` with `--sources=release` and `tools/publish-sources.mjs`).

- `tools/site-thumbs.mjs` draws the thumbnails.
- `dist/site-media/` holds the README's moving pictures and the link-preview card, served as
  `media/`; `tools/gif.mjs` makes a GIF from captured frames.

## Checking and hosting it

Before putting an export on a host, check it with `tools/site-check.mjs` (file sizes, data that must
not be there, sources and licences present). Any static host serves it, under any path; the
COOP/COEP headers come from `_headers`, or from `web/coi-sw.js` where the host sends none.
`site/` holds game data and is never committed. `tools/deploy.mjs` puts it on Cloudflare Pages.

- `node tools/serve.mjs --site --games=<dir>` serves the export as a **local library**: the gallery
  games found in `<dir>` say *your copy* and play from it.
- `node tools/standalone.mjs <id>` writes **one** program as a folder for anyone's own site, with a
  page of its own and `HOSTING.txt`.

## The visitor's language, calendar and keyboard

In the page, a program that can be told a language gets the browser's (Beneath a Steel Sky's text
in French on a French browser), sees the real date and the browser's time zone, and reads typed
text in the visitor's keyboard layout. Keys stay positions by default, as game controls expect;
*keys: your layout* names them by what the layout types. The gates keep a fixed date, UTC and US
positions. See [ARCHITECTURE.md](ARCHITECTURE.md#the-visitors-language-calendar-and-keyboard).
