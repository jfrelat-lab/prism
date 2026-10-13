# Contributing to PRISM

Thank you for looking. A few rules keep this compiler honest. They are short.

## Before you send a change

```bash
node tools/gates.mjs <names...>     # the gates that touch what you changed: PASS or SKIP, never FAIL
node tools/gates.mjs                # all of them, for a change to the front end or the runtime
```

A gate that needs something the repository does not ship (a corpus, game data, the gcc container
built by `npm run oracle:build`) reports SKIP. On a fresh clone that is expected. Say in the
pull request which gates ran and which were skipped.

Documentation-only changes (`docs/`, `*.md`) do not need a run.

## What a fix looks like

- **A reference that is not PRISM.** A behaviour is changed when an independent implementation says
  so. That can be gcc or g++, Open Watcom, Borland C++ or Turbo Assembler under DOSBox-X, a native
  build of the same program, Mesa, the real library (libGLU, SDL_mixer, zlib), or the C standard.
  When two references disagree, say so in the comment and pick the one the specification supports.
- **A gate that fails without it.** Every new check carries a control, a mutation it must catch.
  Revert the fix, run the gate, see it fail, then restore the fix. A check that cannot fail
  proves nothing.
- **Never patch the program.** The game's source compiles as it shipped. A difference is fixed
  in PRISM: the compiler, the runtime or the platform layer. Build switches the program already has
  are configuration and are fine.
- **Comments that say why.** Explain the constraint that is not obvious, and which program or
  reference showed it. The debugging story belongs in the commit message.

## Performance changes

Measure, do not argue. Compare the old and the new tree on the same input, alternating, several
times each, and give the numbers in the commit message.

## What not to send

No game, game data, ROM, emulator source or any file whose licence is not yours to give.
`corpus/` is ignored by git for that reason, and so are the usual data file names. A bug report
that names the program, its version and where to obtain it legally is the right way to share a
failure.

## Reporting a program that does not compile or run

Give the target (`targets/*.json`) and its upstream version. Give the command
(`node tools/build.mjs targets/<name>.json ...`) or the page and program you picked. Give what you
saw: the first diagnostic, or the last screen and any message in the browser console.

## Documentation

`docs/` holds reference documents, which describe the project as it is. [docs/LOG.md](docs/LOG.md)
and the commit messages hold the record of how it got there. Keep them apart:

- A fact about the present (what runs, what a layer does, what a gate holds) goes in a reference
  document, with no story.
- An investigation goes in the commit message that closes it: symptom, hypotheses, measurements,
  cause, fix. Wrong turns stay in.
- A result in `COMPAT.md` carries the date it was recorded.
