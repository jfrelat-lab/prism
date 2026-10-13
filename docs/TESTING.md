# PRISM — Testing & Gates

The safety net. Nothing in PRISM validates its own answers: every layer is checked against an
**external** oracle, and the bar for a commit is a green run of the gates that touch what changed.

## The gates, and what each one asks

**Seventy-seven now, all green** — run them with `node tools/gates.mjs`, which says PASS, SKIP or FAIL
of each (see "Three verdicts" at the end of this file: the two that had been red for weeks were one
missing its data and one sitting on six real defects). `gate-lua` alone takes about eight minutes of
the run. This is the index of the ones that carry an external authority; the smaller seam gates
(`gate-accessor`, `gate-layout`, `gate-memmap`, `gate-typemodel` and the like) are named in their
own sections. The rule that shapes the list: **no gate answers its own question.** Each column names
something outside PRISM that could contradict it.

**Faster runs, the same verdicts** (2026-10-12). `node tools/gates.mjs --jobs=1 <names...>` runs gates
one at a time and shows each one's progress -- `[3/9]`, how long it took last time, how much is left,
and its own `ok` / `FAIL` lines as they come (`--progress` does the same at any `--jobs`). Two caches
under .oracle/ keep a run from redoing what has not changed: the BUILD cache (src/build-cache.js) gives
back a compiled program while PRISM's src/, the target, its units, its options and every header it read
are the same (`gate-build-cache`); the REFERENCE cache (tools/ref-cache.mjs) gives back a native
reference's output -- Cube on Mesa, GLQuake and Quake II on Mesa -- while its binary or sources, data,
configuration, commands and the container's package list are the same. PRISM_BUILD_CACHE=0 and
PRISM_REF_CACHE=0 turn them off.

| gate | external authority | asserts |
|---|---|---|
| `gate-cpp.mjs` | `gcc -E` | token-identical preprocessing, 42 hand + 250 generated cases x 7 seeds |
| `gate-cpp-files.mjs` | `gcc -E` | the same over **289 whole translation units** from five programs — at `--limit=200`; the DEFAULT is 8 files per program, i.e. 36 |
| `gate-decl.mjs` | gcc 12, i386 | sizeof / align / offsets / enum values of every tag PRISM parses |
| `gate-abi.mjs` | gcc 12, i386 | i386 SysV layout, ~105k checks over 13 seeds |
| `gate-abi16.mjs` | Open Watcom, from the OBJECT FILE | 16-bit DOS layout, ~4,970 checks over six seeds |
| `gate-bits16.mjs` | Open Watcom, run under **DOSBox-X** | the BYTE IMAGE — bitfield allocation order, byte order, padding |
| `gate-abi16m.mjs`, `gate-abi16l.mjs` | Open Watcom `-mm` / `-ml` | medium and large models: near data, far code, and the reverse |
| `gate-borland-layout.mjs`, `gate-borland-int16.mjs` | **Borland C++ 2.0**, compiling and RUNNING under DOSBox-X | Keen's 36 named types laid out as Borland lays them; 600 random integer expressions executed by both |
| `gate-borland-options.mjs` | **PRJCFG** (Borland C++ 3.1) on the unmodified `.PRJ` | every 16-bit target compiles with the options its own project records |
| `gate-dos16-run.mjs` | **Borland C++ 2.0** running the same programs | identical output under a 16-bit model: argv, varargs, printf, DOS services |
| `gate-borlandasm.mjs` | **Unicorn** in 16-bit real mode, on the same snippets assembled by nasm | Borland inline asm, 1,339 cases |
| `gate-tasm-front.mjs` | **Turbo Assembler 2.5** under DOSBox-X, per game | every byte, relocation, public, instruction, offset and length TASM produced — Keen Dreams and Catacomb 3-D |
| `gate-tasm-run.mjs` | **Unicorn executing TASM's own object code** | registers, flags, 1,088 KB page by page, port writes |
| `gate-tasm-link.mjs` | Borland's own link of the same objects | C reaches the assembly as Borland's linker lets it |
| `gate-ega.mjs` | **DOSBox's VGA**, running a Borland program | the EGA's write modes, read modes and latches, eleven paths |
| `gate-ega-rom.mjs` | **SeaVGABIOS** (QEMU's VGA ROM) setting the modes up on MIRAGE's machine | 0Dh, 0Eh, 10h, 12h: the attribute palette a mode set loads, and all 64 attribute values' colours |
| `gate-dune-pixels.mjs` | **Dune II 1.07's `DUNE2.EXE`** under DOSBox-X, recorded by `DX-CAPTURE /V` | every screen OpenDUNE holds in its first 28 s is one the real binary showed, and its scenes come at the real binary's times (slope within 0.08) |
| `gate-jnb-pixels.mjs` | **the game's own `jumpbump.exe`** (DJGPP) under DOSBox-X, DOS clock set to PRISM's | every one of 300 pages PRISM flips is a page the real binary showed |
| `gate-mesa-demos.mjs` | **Mesa 22 (llvmpipe)** drawing mesa-demos 8.0.1's morph3d, texobj and reflect on the same GLUT harness (reflect linked against libGLU natively, glu.js here, and given a stencil buffer on both sides by GLUT_STENCIL); texobj twice, its GL_VERSION set on both sides, because "1.1" sends it to texture objects and anything else to textures compiled into display lists | per frame at most 0.1% of pixels beyond 8 levels (0-7 do); six controls red: two-sided lighting, the scene ambient, the second light, glBindTexture at draw time, NEAREST magnification, glTexImage2D in a list, and for reflect the stencil test dropped and GL_REPLACE read as GL_KEEP; `--case=<target>` runs one |
| `gate-cxx.mjs` | **g++ -std=gnu++98** in the oracle, on seventeen C++ programs (the method is gate-run's, for .cpp) | stdout and exit status the same: namespaces, function templates with value parameters and an explicit specialisation, two polymorphic bases with thunks and dynamic_cast, pointers to member functions, declarations as conditions, file-scope aggregates initialised before main, functions used before their definition (ScummVM 0.6.1's shapes); classes and operators, the order constructors and destructors run in (bases, members, block exit, return, break), virtual dispatch and virtual destructors, overload resolution by rank, a string class with every special member and its temporaries, a class template with out-of-line members, objects at file scope and static locals, new/delete and their [] forms, implicit conversions, default arguments and references; `exceptions` (Chromium B.S.U.'s: a string literal thrown is const char *, which catch (char *) must not take; throws through calls, a return out of a try, a rethrow) and `string-sstream` |
| `gate-scummvm.mjs` | the release's own **configure** (config.h) and module lists; with `PRISM_SCUMMVM_DATA`, Beneath a Steel Sky run on the virtual clock | all 170 units emitted (Sky, SCUMM, Queen), nothing unresolved; **each of 3,000 pictures the one a native g++ build over the real SDL 1.2 presented** (goldens/scummvm.json from `tools/scummvmdiff.mjs`, whose native side wraps only time, timer, audio and input onto the same virtual clock -- tools/scummvmdiff/wrap.c), FOR SEVEN GAMES -- Beneath a Steel Sky, the SCUMM demos of Monkey Island 1 (EGA), Monkey Island 2, Fate of Atlantis, Day of the Tentacle and Sam & Max, and Flight of the Amazon Queen -- WITH A SCRIPTED PLAYER each: keys and mouse at fixed virtual times (Esc, F5 and the control panel, walking, the door with each button, a death, "play again"); **and each audio buffer the callback filled the native build's, sample for sample** (FNV-1a of each, beside the frames in the golden; a game silent on both sides says why); control red: the music at another volume (-m100) keeps Sky's first 200 frames and changes the sound; music the page hears that is not silence; controls red: no frame with the files withheld, and another scaler disagrees at frame 1. Measured by hand: red and blue swapped in the blit differ from frame 2, the two mouse buttons swapped from frame 378, F5 lost from frame 187 |
| `gate-scummvm010.mjs` | the 0.10.0 release's own **configure** and Makefile (config.h, config.mk, the 535 objects); each game present | all 535 units emitted, nothing unresolved -- functions AND variables -- and a main; **each of 3,000 pictures the one a native g++ build of 0.10.0 over the real SDL 1.2 presented** (goldens/scummvm010-*.json, written by `tools/scummvmdiff.mjs --version=0.10.0 --write`), for Beneath a Steel Sky (given sky.cpt, the engine data file 0.10.0 reads, as its release shipped it; ~/games/scummvm-engine-data-0.10.0), the SCUMM demos of Monkey Island 1 (EGA), Monkey Island 2, Fate of Atlantis, Day of the Tentacle and Sam & Max, Flight of the Amazon Queen, with the scripted players of 0.6.1's gate, and the demos of five more engines -- Gobliiins (Gob), The Legend of Kyrandia (Kyra, with the KYRA.DAT 0.10.0's release shipped), Sierra's AGI demo pack 1 (AGI), Broken Sword 2 (Sword2), and Simon the Sorcerer 1 and 2 (AGOS), unplayed (the AGI demo with `--render-mode=ega`: the engine leaves its render mode unset otherwise, and the native build drew CGA from frame 7). Measured by hand: without SDL_SetColorKey the mouse cursor is drawn opaque and the Monkey Island demo differs from frame 74; with the size of a static member array read from its declaration (`gate-cxx` static-member-array-size), Gobliiins differs from frame 1329, Broken Sword 2 from frame 2 and Kyrandia asserts in its first frames. **and each audio buffer the callback filled the native build's, sample for sample** (FNV-1a of each, beside the frames in the golden; a game silent on both sides says why); control red: the music at another volume (-m100) keeps Sky's first 200 frames and changes the sound |
| `gate-cxx-splines.mjs` | **g++** building ET's unmodified splines library (util_str, math_vector, math_matrix, math_quaternion, math_angles) under one driver, `tools/cxx/splines-driver.cpp` | 25 of 25 output lines the same (idStr, idVec3, mat3_t, quat_t, angles_t, idList over int, idStr and a pointer); four controls red: an operator= and a copy constructor that do nothing, operator+(idStr, int) taken for the char overload, Cross with object and argument swapped |
| `gate-cxx-camera.mjs` | **g++** (SSE arithmetic) building all seven of ET's splines sources under `tools/cxx/camera-driver.cpp`, which stands in for the engine: three camera files served from memory, reached through loadCamera/startCamera/getCameraInfo, and one saved back | 63 of 63 lines the same (origin, angles and field of view at each sampled time, a missing file, an out-of-range index, the re-written file); three controls red: a virtual call bound to the base class, splines.cpp's file-scope objects never constructed, an idList::Append that drops elements |
| `gate-tcl.mjs` | **gcc** building Tcl 8.4.20 by its own configure and make in the oracle; both sides are `tclsh` (unix/tclAppInit.c, Tcl_Main) running `tools/tcl/workout.tcl` with Tcl's own library/ scripts | 48 of 48 lines the same (strings, lists, integer, wide and floating arithmetic, procedures, control flow, arrays, regular expressions, namespaces, binary, clock); three controls red: modf, strtod, hypot made wrong |
| `gate-sdl-mixer.mjs` | **The real SDL 1.2.15 and SDL_mixer 1.2.12** in the oracle (`SDL_AUDIODRIVER=dummy`); both sides run `tests/sdl/mixer.c`, which writes three WAV files (44100 Hz stereo 16-bit, 22050 Hz mono 8-bit, 11025 Hz mono 16-bit), plays them together with a chunk volume, a channel volume and a loop, and captures the mixed stream through `Mix_SetPostMix` | every line the same on three devices (22050 Hz 16-bit stereo, 11025 Hz 8-bit mono, 44100 Hz 16-bit mono): the stream's length, a checksum of every byte, twelve frames along it; six controls red: stereo averaged by shift, an 8-bit sum saturating at 255, a volume applied by shift, a halved rate keeping the other frame, a doubled rate interpolating, 8 bits widened without the sign change |
| `gate-sdl2-surface.mjs` | **The real SDL 2** in the oracle (`SDL_VIDEODRIVER=dummy`); both sides run `tests/sdl2/surfaces.c`: what a surface of each depth and mask set is, a paletted sprite onto a 24-bit screen plain and keyed, the keyed sprite converted to ARGB8888 and blended, every alpha blended onto 24 bits, a translucent 32-bit overlay merged, 24 onto 24 with a key, blits and fills hanging off a clip rectangle, a doubling | 28 of 28 lines (the rectangle written back, a checksum of every pixel byte, four pixels); three controls red: a blend rounding down, a blend by a/256, 24 bits with no masks taken as R-first |
| `gate-png.mjs` | **zlib** (node's) for inflate; for the decoder, **PNG files the gate encodes itself** (forward filters and zlib's deflate), every colour type at every legal depth | 80 of 80 deflate streams (four levels, four strategies, five kinds of data) come back byte for byte, a bad checksum is refused; 15 of 15 colour type and depth pairs decode to the rows encoded, each filter on every row, an interlaced file refused by name; two controls red (average rounding up, Paeth's tie order); SDL_image's surface rules applied (not held to SDL_image); with `PRISM_SDLPOP_DATA`, the game's 929 files inflate as zlib inflates them |
| `gate-sdl2-image.mjs` | **The real SDL_image 2.6.3** in the oracle; both sides run `tests/sdl2/images.c` over PNG files the gate encodes (every colour type and depth; palettes with no, one, several and translucent tRNS entries; grey and RGB with a transparent colour) and, with `PRISM_SDLPOP_DATA`, one in twenty of the game's own | 77 of 77 surfaces the same: format, palette size, colour key, blend mode, a checksum of the pixels and one of the palette; one control red (a Paeth filter predicting from the left only) |
| `gate-sdlpop-pixels.mjs` | **SDLPoP itself, built by gcc against the real SDL 2 and SDL_image** in the oracle (dummy video and audio), watched by a preloaded library (`tools/oracle/sdl2-capture.c`) that hashes each distinct 320x200 picture handed to SDL_UpdateTexture and gives keys at counts of distinct pictures; `seed=1234`, and the level-1 tune switched off by the game's own ini on both sides (it holds the prince for as long as it PLAYS). Golden: `goldens/sdlpop-pixels.json`, hashes only; `--capture` remakes it. Needs `PRISM_SDLPOP_DATA` (default ~/games/sdlpop), skips without | all 130 distinct pictures PRISM presents are the reference's, in order (notice, title fade, level 1, the run and the fall); two controls red: another seed (94 of 130 unknown), sprite palettes with red and blue exchanged (123 of 130) |
| `gate-webgl-stream.mjs` | **its own blessed stream**: the WebGL2 calls gl.js issues for gears, morph3d, texobj (both paths) and, with `PRISM_QUAKE3_DATA`, 300 swaps of Quake III in q3dm1 -- every call, argument and uploaded byte, hashed -- through a recording context, since Node has no WebGL and every pixel gate uses the soft rasteriser | the stream is the blessed one; a dropped state call per program changes it; red when the front end's state cache is never invalidated (3 of 5) and when the batch ignores state (2 of 5); plus `tests/gl/ztrick.c`, GLQuake's depth trick on its own: no depth range may reach WebGL with near above far (WebGL refuses one, and Hexen II flickered) and the shader's z-flip switch must follow the frames -- red without the fix, 2 of 4 ranges reversed; re-captured 2026-10-12 when the WebGL path began drawing into a framebuffer of its own (depth as a texture, for glReadPixels of depth), after gears, morph3d, texobj, Quake III and Cube were looked at in the page; and the EFFECTIVE STATE at every draw and clear, the calls replayed through a model of the WebGL state a draw depends on (capabilities, functions, masks, viewport, framebuffer, program and uniforms, bound textures with their parameters and contents, vertex data): what lets the stream change when gl.js sends less and still hold the pictures -- apply()'s state diffing passed it on all five programs with 35-67% fewer calls, and a cache that sends a piece only the first time is red on it (texobj) |
| `gate-dga-mouse.mjs` | **none external**: DGA 1 is gone from every X server one could run today. The contract as XF86DGA(3) states it and as GLQuake, Quake III and Enemy Territory read it, against a scripted host mouse (`tests/x11/dgamouse.c`) | 12 of 12 lines: positions before, deltas in x/y and x_root/y_root while XF86DGADirectMouse is on, positions again after, the pointer not moved by what happened in between; one control red (DirectMouse accepted but not switched on) |
| `gate-long-double64.mjs` | **gcc -m32 -mlong-double-64 -msse2 -mfpmath=sse** on one program in the oracle | struct sizes and offsets, arithmetic, conversions, L constants and varargs print the same; red without the option and with gcc's 12-byte long double |
| `gate-asm-snapvector.mjs` | **Unicorn** running nasm's bytes of Quake III's unmodified unix/snapvector.nasm (golden captured once) | 300 of 300 float32 vectors rounded alike; red with RC forced to truncation and with the routine's control word ignored |
| `gate-gears.mjs` | **Mesa 22 (llvmpipe)** drawing the same gears.c, in the oracle container, on a surfaceless-EGL GLUT harness | frames 0, 25 and 50: at most 0.1% of pixels differ beyond 8 levels (2-3 of 90,000 do) |
| WebGL in the page (browser check, no CLI gate) | **Mesa's frames** from `gate-gears`, fetched by the page from `.oracle/gears/` | `?machine=linux&program=gears&glcheck=0,25,50&run=1` posts frames 0, 25 and 50 to `window.PRISM_DIAG.glframes`; 1-4 of 90,000 pixels differ, by at most one level (frame 25 against Mesa's frame 0: 9,028) |
| `gate-glquake.mjs` | **the same GLQuake source built against Mesa 22** in the oracle, on a GLX-over-EGL harness (tools/oracle/glx-egl.c); the Win32 build (quake:wgl, gl_vidnt.c on src/env/opengl32.c, run with its own -gamma 1 because only it calls Check_Gamma) against the same frame | world frame 40 of the demo: at most 0.2% of pixels off by more than 8 (1 of 307,200 is, for either build) |
| `gate-quake2-gl.mjs` | **Quake II 3.19 built as linux/Makefile.i386 builds its GL client** (quake2, ref_gl.so, gamei386.so) against Mesa 22, on tools/oracle/q2-fxmesa-egl.c; the Win32 build (quake2:win32gl, ref_gl.dll on src/env/opengl32.c) against the same frame, every clock read stepped on both | swap 120 of demo1: at most 0.2% of pixels off by more than 8 (3 of 307,200 are, for either build) |
| `gate-build-cache.mjs` | a toy target built again and again in .oracle | the build cache gives a build back only while nothing it was made of changed: a second build is a hit and runs the same; a header edited, a unit edited, a new header that shadows the old one on the include path are misses and the program follows them; other compile options are another entry; PRISM_BUILD_CACHE=0 compiles. Measured red: with the header replay disabled, the edited and the shadowed header hand back the old program |
| `gate-glu.mjs` | **the container's libGLU** (Mesa's GLU 9), tests/glu/unproject.c, mipmap.c, quadric.c and matrix.c built against it | gluUnProject on 40 pseudo-random model/projection pairs (an identity and a singular one among them): the same success flags and values to 1e-12 relative -- not to the bit, libGLU computing on the x87 (measured: the same arithmetic compiled for the x87 agrees to the bit on 2 of 40). Control red: the projection transposed falls outside the tolerance on every case it applies to; gluBuild2DMipmaps and gluScaleImage on nine GL_UNSIGNED_BYTE images (powers of two and not, 1x1, 1/3/4 components): every level glTexImage2D receives (hashed natively by tests/glu/native-gl.c) and every scaled image TO THE BIT, 62 + 36; control red: the first byte of each image flipped by 128 moves 39 of 62 levels and 33 of 36 images; the quadrics (gluSphere, gluCylinder, gluDisk, gluPartialDisk) in 400 cases of shape, draw style, normals, orientation and texture: every glBegin/glNormal3f/glTexCoord2f/glVertex3f traced on both sides as float bits, 42,278 calls TO THE BIT; control red: radii 2^-20 larger move 19,752 of 20,544 vertices and no normal; the matrices (gluPerspective, gluLookAt, gluOrtho2D, gluPickMatrix traced as their GL calls, gluProject on 120 points): floats to the bit, doubles to 1e-12; control red: every argument 2^-20 larger (gluLookAt's eye moved) moves 143 of 143 |
| `gate-cube.mjs` | Cube's own Makefile (src/Makefile's CLIENT_OBJS, enet/Makefile.am's sources) | targets/cube.json lists exactly those units; all of them, zlib 1.1.3 and libjpeg 6b (its jconfig.h and objects as its own configure writes them) lower and compile: every function emitted, nothing unresolved (functions and variables), a main; with the data, it runs 30 frames with its default map loaded (control red: with the textures withheld it stops before the map); and **against Cube built natively** over the real SDL 1.2, SDL_mixer, SDL_image and Mesa (`tools/cubediff.mjs`), a scripted player on both sides at 320x240: frames 100, 200, 300 within 0.5% of pixels off by more than 8 (measured 0.15%; 0.24% before GLU's mipmaps matched libGLU's), every audio buffer the same. Controls red, native: without the player frame 300 is 52.71% off; at soundvol 128 the sound differs |
| `gate-gl-scenes.mjs` | **Mesa 22**, sixteen scenes of tests/gl/scenes.c | textures and the mipmap filters, lightmap blending, alpha test, blending, fog, near-plane clipping, depth range, and what Tux Racer added -- GL_OBJECT_LINEAR and GL_SPHERE_MAP texture generation, a lit mesh from vertex and normal arrays, GL_COLOR_MATERIAL with per-vertex alpha (20,036 pixels off without it), glMultMatrixd with glRect and padded texel rows: at most 0.5% of pixels off by more than 8 |
| `gate-gl-abi.mjs` | **Mesa's `<GL/gl.h>`** | every constant and type PRISM's `<GL/gl.h>` declares |
| `gate-watcom-clock.mjs` | **Open Watcom's DOS libc**, run under DOSBox-X | `CLOCKS_PER_SEC` and the BIOS-tick steps of `clock()` under the Watcom toolchain |
| `gate-watcom-argorder.mjs` | **Open Watcom `wcc386`**, run in the oracle, plain and with Heretic's CCOPTS | a call's arguments are evaluated right to left under the Watcom toolchain, in eight call shapes |
| `gate-keen-pixels.mjs` | **the shipped `KDREAMS.EXE`** under DOSBox-X, recorded by `DX-CAPTURE /V` | every screen PRISM's Keen Dreams holds for 3 frames is one the real binary showed, pixel for pixel |
| `gate-pcirq.mjs`, `gate-dosint.mjs` | the PC's documented rules; a Borland program doing `int 21h` | PIT, 8259 priority and EOI, IRQ delivery; DOS and BIOS services |
| `gate-run.mjs` | a native i386 gcc build | 65 programs behave identically; `stat-stays-in-its-struct`: a canary after struct stat survives stat() (red when stdio fills 56 bytes of the 52-byte struct, as it did until Chromium B.S.U.) |
| `gate-suite.mjs` | c-testsuite, gcc torture | 213 / 219 and 1,438 of the torture corpus |
| `csmith-diff.mjs` | Csmith + gcc `-O0`/`-O2` | unlimited random programs, zero divergence |
| `gate-pixels.mjs` | PRISM against ITSELF on four platform layers | `x11 == dos == win == svgalib`, pixel for pixel |
| `gate-lua.mjs` | Lua 5.4's own test suite | 27 files of `assert()`s written by someone else |
| `gate-sound.mjs`, `gate-ports.mjs`, `gate-vgafont.mjs` | device contracts, MIRAGE's font | the host seams |
| `mamediff.mjs` | a native **gcc or tcc** build of the same MAME | frame-hash equality, whole build |
| `bench.mjs` | clang -O2, native on this host | the speed ratio, published and never justified without it |

Two of these are asserted differentials with **no external compiler at all** and are called out
because that is unusual: `gate-pixels` compares PRISM to PRISM — four builds of one engine, whose
pictures must match because it is the same C. **The fifth, SunOS, is reported and NOT asserted**: it
differs from X11 by about one colormap row, because the two drivers set the renderer up differently
(a static `surfcache[1024*1024]` against `D_SurfaceCacheForRes`), so a lighting input differs before
anything can go stale. Reported without being asserted is the honest state for a difference that is
understood but not resolved. And `gate-ports` says in its own output that there is
no PC I/O space on a Linux host, so it checks a contract rather than an oracle.

⚠️ **A green gate proves nothing until it has been shown able to fail.** `gate-bits16` ships with its
two positive controls recorded (MSB-first allocation → 18 of 22 cases red; big-endian plain members →
8 red), and the reason is at the bottom of this file: a check bounded by its own assumption cannot
fail, and `gate-abi16` was one for months without anyone noticing.

## The Keen Dreams pixel oracle (`tools/gate-keen-pixels.mjs`, `tools/zmbv.mjs`)

The reference is the real shareware 1.13 binary, started the way its own shell starts it (START.EXE,
option 5 -- KDREAMS.EXE refuses to run otherwise), under DOSBox-X with `machine=ega`. `DX-CAPTURE /V`
records the EMULATED framebuffer as a ZMBV AVI: palette indices before any scaling, so nothing is
asked of the guest, and a game that takes INT 8 unchained cannot stop the capture the way it stops a
resident grabber. `tools/zmbv.mjs` decodes it (one deflate stream per keyframe segment; motion
vectors are dx and dy each shifted left one, the low bit of dx saying XOR data follows; an empty chunk
is a dropped frame). DOSBox-X starts a new file on each mode change.

The golden holds hashes of the 61 distinct 320x200 screens of a 45 s run, each channel reduced to the
EGA's four levels; no game data enters the repository, and the replay SKIPS without the data set
(`PRISM_KEEN_DATA`). The two runs are not synchronised -- virtual microseconds against DOSBox cycles --
so the claim is a set inclusion, not a frame match: every screen PRISM holds for three frames on the
same key path is in the reference, at least 25 of them, one after 20 s (the world map). **35 of 35.**

**What it found on its first run**, each a defect no other gate could see, and each now a mutation
that turns the gate red: a 200-line mode's monitor reads IRGB, where colour 6 is brown (read as
rgbRGB, the title's colours were wrong); the BIOS loads a different palette for 200-line modes; and
Borland inline asm's views of a far pointer re-normalised the offset on every read, while
MemDrawChar loads ES once and steps the offset by a plane's size -- planes 1-3 of every digit landed on
plane 0. That last one is also a `gate-dos16-run` case now (`tests/dos16/farview.c`, Borland C++
2.0's output captured), red without the fix.

**OpenDUNE against the program it was reverse-engineered from (`tools/gate-dune-pixels.mjs`).** The
same claim, on VGA: DUNE2.EXE 1.07 on a `vgaonly` DOSBox-X, whose capture is 32 bpp (B, G, R, unused
-- `tools/zmbv.mjs` reads both formats) at 640x400 with every mode-13h pixel doubled, which the
capture asserts per frame; both sides reduce to six-bit r,g,b, the DAC's width. Over the first 900
Video_Ticks -- the Westwood logo, the credits, Arrakis and its captions -- **123 of 123** stable
screens are the real binary's. Past that the gate REPORTS instead of asserting, because what differs
there is time, not drawing: the planet's fade-in skipped (the copyright line still up when Arrakis
appears), the moon's orbit run at one position per tick and cut seven short, dissolves held at
intermediate states. That is ROADMAP P7.11, now a number (40 of 173). Two DAC mutations (five-bit
components, r and b swapped) turn it red. Two captures of the same run are not bit-identical --
Keen's differ by four or five of ~60 screens -- which is one more reason the claim is an inclusion.

**Jump 'n Bump against its own jumpbump.exe (`tools/gate-jnb-pixels.mjs`), page for page.** Here
the claim can be the strong one -- EVERY page flipped, fade-in, bunnies and flies included, not just
the held ones -- because the program's only source of variety is `srandom(time(0))`, and both clocks
can be made to agree: PRISM's `time()` is a fixed 1997-01-01 00:00:00, and the reference run sets
the DOS date and time to that before the game starts (`date 01/01/1997` -- DOSBox-X ignores the
dashed form without a word). **300 of 300.** Getting there found a real defect: PRISM seeded
`random()` the glibc way (16807, by Schrage) for every program, and DJGPP's libc keeps 4.3BSD's
(`r[i] = 1103515245 r[i-1] + 12345`, zero not remapped); the generator after seeding is the same.
That was read out of the libc linked into jumpbump.exe itself -- the executable is DJP-packed, so
its LZO1X stream was unpacked first -- not assumed from a manual. A DJGPP environment
(`src/env/go32.js`) now says `M.randSeeding = 'bsd43'`; Quake, the other go32 target, never seeds.
With glibc's seeding 1 page of 300 matches; a five-bit DAC, 32. The capture is shared with
`gate-dune-pixels` in `tools/dosref.mjs`, which also sets aside TORN frames -- DOSBox renders line
by line, so a frame caught mid-change can differ between the two lines of a doubled pair.

**A second lineage for the colours (`tools/gate-ega-rom.mjs`).** DOSBox-X's video BIOS and its EGA
model are the same code, so the two colour fixes rested on one source. SeaVGABIOS -- QEMU's
`vgabios-stdvga.bin`, which MIRAGE already runs as its hardware oracle -- is POSTed on MIRAGE's
machine and sets each mode through its own INT 10h, writing the attribute palette and the DAC. A VGA
BIOS loads, per mode, the DAC table that makes a VGA show what an EGA showed, so DAC[value] must be
the colour PRISM gives the same attribute value: for 0Dh, 0Eh, 10h and 12h, the 16 defaults and all
64 values agree. Two controls run with it and must differ (the 64-colour reading on a 200-line mode:
49 of 64; the 350-line palette loaded for one: 9 of 16), and removing brown from `ega200Rgb` turns
it red on 06h, 0Eh, 26h and 2Eh. It SKIPS without MIRAGE (`PRISM_MIRAGE`) or the ROM
(`PRISM_VGA_ROM`). PRISM has no CGA graphics mode, so there is nothing of CGA's to hold yet.

## The oracle (`tools/oracle.mjs`, `tools/oracle/Dockerfile`)

This host is **arm64 macOS**. Measured before anything was built:

| | Result |
|---|---|
| `gcc` | absent — `gcc` is a symlink to Apple clang 17 (arm64) |
| `clang -m32` | **fails**: `ld: unknown -arch name: armv4t` (clang reads `-m32` as 32-bit ARM) |
| cross-compiler | none (`i686-*`, `djgpp`, `mingw` all absent) |
| `csmith` | absent |
| `docker` | 28.5.2, aarch64 server |

So the entire external-truth layer lives in a container: **`i386/debian:bookworm-slim`, platform
`linux/386`** (`uname -m` → `i686`). `linux/386` rather than amd64 + `-m32` on purpose — the
differential gates need programs that **run**, not just object files, and Rosetta does not execute
32-bit x86.

```bash
npm run oracle:build      # docker build --platform linux/386 -t prism-oracle tools/oracle
npm run oracle:version    # gcc (Debian 12.2.0-14+deb12u1) 12.2.0 / csmith 2.3.0
```

`oracle.mjs` keeps **one long-lived container** and talks to it with `docker exec`, because the
costs are not comparable: `docker run` ≈ **3.8 s**, `docker exec` ≈ **46 ms**, and a gate makes
thousands of calls. Files are exchanged through a bind-mounted `.oracle/` scratch dir, so Node
writes them directly instead of paying for `docker cp`.

**Debian's `csmith` package ships the generator and none of the runtime headers** its output
`#include`s — and three of those headers do not exist in the source tree either, they are `m4`
templates the upstream build expands. The image fetches the pinned `csmith-2.3.0` runtime tree and
runs the same rule upstream's `runtime/Makefile.am` uses (`$(M4) < $< > $@`).

Measured cost of one Csmith differential cycle (generate → `gcc -O0` → run): **~3 s**
(1.3 s generate, 1.8 s compile, 0.05 s run). A 2577-line program compiled at `-O0` *and* `-O2` cost
16.7 s, so the per-program figure tracks program size, not a fixed overhead. 10 000 programs is
therefore ~3 h at 8-way parallelism — and it is a **one-off capture whose result is committed**, the
same pattern as MIRAGE's `golden-baseline.json` and its Unicorn capture. Once captured, the gate
needs neither Docker nor gcc.

## The ABI gate (`tools/gate-abi.mjs`) — the only gate that exists today

`src/sema/abi.js` vs a real i386 gcc: `sizeof`, alignment, member offsets, and **bitfield bit
placement**. Bar: exact, every case.

```bash
npm run gate:abi              # 317 cases (17 hand + 300 generated), ~1700 checks
npm run gate:abi:deep         # 3000 generated cases
node tools/gate-abi.mjs 800 777    # [count] [seed]
```

Three design points, each of which earned itself:

**Bitfields are checked by observation, not by `offsetof`** (which C forbids on a bitfield). The
probe zeroes a struct, writes all-ones into one field, and dumps the bytes; the resulting bit
pattern pins the placement exactly. There is no other ground truth.

**Alignment is measured the way a struct experiences it** — the offset the type forces inside
`struct { char pad; T inner; }` — not with `__alignof__`. See the trap below.

**Generated cases, following MIRAGE's `x86-gen` lesson ("the generator does not think").** Seeded
xorshift32, no `Math.random`, so a seed always yields the same structs. This was not decoration:
the 17 hand-written cases and seed 12345 **passed on the first run**, and four other seeds then
found 13–25 divergences each. Everything below was found that way.

### What the oracle actually said (observed, never derived)

```
int=4 long=4 ptr=4 long long=8 long double=12    char is SIGNED
struct {char a; int b;}         size 8   b@4
struct {char a; long long b;}   size 12  b@4     <- align 4, not 8
struct {char a; double b;}      size 12  b@4     <- align 4, not 8
struct {char a; long double b;} size 16  b@4
```

**The trap that made `abi.js` necessary.** `__alignof__(double)` and `__alignof__(long long)` report
**8** on i386, but the ABI aligns both to **4 inside a struct**. `__alignof__` answers "preferred
alignment", which is a different question from the one a struct layout asks. Had `abi.js` been
written from `__alignof__`, every struct containing a `double` would have been 4 bytes out — and
because game code `memcpy`s WAD/ROM bytes straight into structs, the symptom would have been
corrupted sprites, hunted anywhere but here.

### The three bitfield rules the generator found

1. **A bitfield may span up to `sizeof(T)/alignof(T)` units of `alignof(T)` bits — not one.**
   The naive "never straddle a `sizeof(T)` unit" rule is wrong, and `unsigned long long f3:21` at
   bit 112 proves it: it straddles, and gcc leaves it there. The real System V / PCC test is
   `ceil((bitPos % abits + width) / abits) > sizeof(T)*8 / abits`. `long long` (8 bytes, 4-byte
   aligned) gets two units; `int` gets one.

2. **A packed bitfield is exempt from that rule entirely** — not merely clamped to a byte. gcc
   guards the whole test with `! DECL_PACKED (field)`, so in a packed struct `unsigned int f1:26`
   following a 23-bit field sits at bit **23**, not 24.

3. **A zero-width bitfield** rounds to `alignof(T)*8` (so `long long :0` moves to bit 32, not 64),
   contributes **no** alignment to the struct (`{char; int :0; char}` is size 5, align 1), and is
   **not** exempt under `packed` — a different code path from rule 2, which is why the two disagree.

`double` and `long double` are not legal bitfield types even in GNU C; the generator does not emit
them.

### Sensitivity — why green means something

A gate that passes on its first run may simply be blind. Each rule was perturbed and the gate had to
go red:

| Perturbation | Result |
|---|---|
| `double` align 4 → 8 | **129 divergences**, first case `struct {char a; double b;}` |
| `long double` size 12 → 16 | 137 divergences |
| bitfield span rule disabled | 65 divergences |

⚠️ The first attempt at the `double` perturbation reported *no change* — the `sed` pattern was one
space off and had silently matched nothing. The gate was fine; the measurement was not. Verify that
a perturbation actually applied before concluding the gate is blind.

### Current state

9 seeds × 800 cases (39 848 checks) and 4 fresh seeds × 3000 cases (65 806 checks): **all pass**.

## The preprocessor gate (`tools/gate-cpp.mjs`)

`src/cpp/` vs `gcc -E -P -std=gnu89`. Bar: **identical token stream**. The comparison is on tokens,
not text — gcc's whitespace and line decisions carry no meaning and the compiler downstream consumes
tokens. gcc's output is re-lexed with PRISM's own lexer, which exercises the lexer on a second input.

```bash
npm run gate:cpp                       # 42 hand cases + 60 generated, ~18 s with the ABI gate
CPP_SEED=777 CPP_GEN=250 npm run gate:cpp
```

Cases are self-contained (no system headers) so this gate tests the preprocessor and nothing else;
the `include-*` cases ship their own headers into per-case `d0`/`d1` directories, which is what makes
`#include_next` testable. Generated cases that gcc REJECTS are skipped — but only after checking that
PRISM rejected them too; accepting what gcc rejects is a divergence, not a skip.

State: **7 seeds × (42 hand + 250 generated) all green**, hand cases including the canonical
C99 6.10.3.5 example and Prosser's `f(2)(9)`.

### What the hand cases could not find

The 42 hand cases and the first generated seed passed at 30/32 and then 273/282. Everything below
came from generation or from sensitivity-checking, not from a case anyone wrote on purpose:

1. **Expansion is not line-oriented.** A function-like macro name at the end of a line takes its
   argument list from the next — the standard's own example depends on it (`& mm\n    (ff)`). The
   unit of expansion is a run of tokens delimited by **directives**, not by newlines. The original
   line-by-line loop failed the standard's example and no hand case had caught it.
2. **An empty argument next to `##` is a PLACEMARKER, not nothing.** Deleting it lets the paste reach
   the token *before* the parameter: `zz p0 ## p1` with an empty `p0` produced `zzbb` instead of
   `zz bb`. The hand-written `A3(,y,)` case missed it because `out` was empty there by luck. This one
   bug accounted for 7 of 9 generated failures, including all four "invalid paste" errors.
3. **The GNU comma-paste deletes the comma only when the variadic list is ABSENT.** `VE("a")` drops
   it; `VE("a", )` keeps it. `parseArgs` had padded the missing argument with `[]`, destroying the
   distinction before `subst` could see it.
4. **An unclosed argument list at end of file was accepted silently.** The slice handed to `#expand`
   stops before the EOF token, so `parseArgs` ran off the end of the array rather than seeing EOF.
   gcc errors; PRISM did not.
5. **`#if` does not evaluate dead branches.** `#if (0 ? 1/0 : 5) == 5` and `#if 1 || 1/0` both
   compile under gcc. `||`, `&&` and `?:` therefore parse their dead side but do not diagnose it.

### Sensitivity — and the two bugs it found on its own

| Perturbation | Result |
|---|---|
| hide sets disabled (no blue paint) | 3 failures, 16 s |
| placemarker removed | 3 failures |
| variadic absent/empty conflated | 1 failure |
| `#if` arithmetic narrowed to 32 bits | 1 failure |
| run split at every line instead of at directives | 77 failures (all of them) |

The first and last perturbations each **hung for over ten minutes** before they were fixed, and both
hangs were real defects in the shipped code rather than artifacts:

- The runaway guard was **per-call**, but argument expansion recurses into `#expand`, so each level
  stopped at its own limit while the total work stayed exponential. The budget is now **global to one
  top-level expansion**.
- `#process` had **no progress guarantee**: with `j === start` it looped forever emitting nothing.
  That cannot happen in the shipped code (a run never begins on a directive), but a hang is the worst
  possible way to find out otherwise, so it is now an explicit error.

⚠️ A third hang was pure harness: `timeout` does not exist on macOS, so a whole perturbation sweep
printed nothing at all and looked like five silent passes. Same family as the one-space `sed` in the
ABI gate below — **verify that a perturbation applied before believing what it reports**.

### Known limitation

Expansion rewrites its work list with `splice()`, which is quadratic when a macro grows the list.
It is bounded and reported, never a hang, but it will matter for real headers. Not yet measured on
any — a frame-stack rewrite is roadmap P0.3b, to be justified by a measurement on the corpus rather
than by this note.

## The declaration gate (`tools/gate-decl.mjs`)

`src/parse/` + `src/sema/` vs a real i386 gcc. There is no backend yet, so the parser cannot be
gated by running programs — but everything a *declaration* means is observable without one: sizeof,
alignment, member offsets, enum constant values, and the constant expressions inside array bounds
and bitfield widths. Getting those right needs the declarator grammar, typedef resolution, tag
scoping and the ABI all correct at once.

```bash
npm run gate:decl                          # 12 hand cases + 120 generated
DECL_SEED=777 DECL_GEN=200 npm run gate:decl
```

**Queries are not written by hand.** The gate enumerates whatever tags, typedefs and enum constants
PRISM *ended up with* and asks gcc about each. A declaration PRISM silently misparses into the wrong
shape still gets caught, because the shape is what generates the question.

State: 4 seeds, **8400+ checks, all pass**. Hand cases cover the classic declarator readings
(`int *a[6]` vs `int (*b)[6]` vs `int *(*d)[3]` vs `char (*e)[2][3]`), K&R definitions, implicit
`int`, self-referential structs, anonymous members, packed, `long double`, and enum initializers
using `sizeof` and `?:`.

### The blind spot the sensitivity check found

Reversing the declarator suffix loop in the parser — turning `int m[2][3]` into `int m[3][2]` —
left the gate at **719/719**. Not a bad perturbation: a real blind spot. Layout is *symmetric under
array-dimension permutation*, so sizeof and a member's own offset genuinely cannot tell the two
readings apart.

Closed by asking gcc for one **interior** element of each multi-dimensional array member:
`offsetof(T, m[0][2])` is 8 under one reading and 16 under the other. The same perturbation now
fails 719/720. Without that, a whole class of declarator bugs would have been invisible until the
backend existed.

⚠️ **Not gated yet:** statements and expressions are parsed but nothing observes them. That waits
for the backend (P0.5) — do not read this gate as covering them.

## The execution gate (`tools/gate-run.mjs`)

The first gate that observes **behaviour** rather than shape: PRISM compiles and runs a program, gcc
compiles and runs the same source, and everything written to stdout is compared byte for byte along
with the exit status. Both sides use the unmodified source — gcc against its own headers, PRISM
against `src/env/headers.js`.

```bash
npm run gate:run            # 22 programs
```

State: **22/22**. Coverage: arithmetic and its signed/unsigned corners, unsigned wraparound,
control flow with switch fallthrough, recursion, pointer arithmetic, 2-D arrays, structs and struct
assignment, static aggregate initialisers with string literals, function pointers in an array,
strings, malloc, static locals, bitfield read/write, narrowing casts, floats, short-circuit
evaluation, compound assignment evaluating its lvalue once, union punning, and 20 printf conversions.

### What running the programs found

Eight of the 22 failed on the first run. Six were real defects:

1. **`slot()` returned the END of an object, not its start.** Every aggregate local was placed one
   object too high. Two very different symptoms — `*p` reading `a[2]`, and a DataView range error
   once a frame reached the top of the buffer — one off-by-its-own-size.
2. **`|` binds looser than `+` in JavaScript.** An address emitted as `_fp+0|0` and then composed
   with `+4|0` became `(_fp+0)|(0+4)|0`, i.e. `_fp|4`. Every emitted address is now parenthesised.
   This one bug produced three separate wrong-output failures.
3. **A switch body's braces must be dropped.** `switch(x){{case 0:…}}` is a JavaScript syntax error;
   cases must be direct children.
4. **Initialising an aggregate from an expression is a copy**, not a scalar store — `struct box c = b;`
   and `char s[8] = "abc";`.
5. **Static initialisers needed string literals**: bytes for a char array, an interned address for a
   pointer.
6. **C's printf rounds a tie to EVEN.** `printf("%.0f", 2.5)` is `2` under glibc and `3` from JS
   `toFixed`. Measured, not assumed.

### ⚠️ And two were defects in the TEST CASES, not in PRISM

- `printf("%d %d %d", tick(), tick(), tick())` — argument evaluation order is **unspecified**, and
  gcc evaluates right to left. The case was testing gcc's choice.
- `printf("%d %d %d %d", i++, i, ++i, i)` — two unsequenced modifications of one object is
  **undefined**, not merely unspecified.

Both were rewritten into sequenced statements. This is the same trap MIRAGE documents for BCD flags
and for Unicorn's AF after a shift: **a differential gate must never compare on behaviour the
standard does not define**, or it reports bugs that do not exist. Any new case here has to be checked
for unspecified order and unsequenced modification before it is trusted.

### Sensitivity

| Perturbation | Result |
|---|---|
| `slot()` back to returning the object's end | 2 failures |
| `Math.fround` removed from `float` | 2 failures |
| one address left unparenthesised | 1 failure |

### Not supported by tier-0 (each throws a clear error, none silently miscompiles)

`long long`, `long double`, `goto`, struct pass/return by value, user-defined variadic functions,
inline assembly, compound literals, statement expressions, `offsetof` in an expression, and a
bitfield straddling a 32-bit unit.

## The external-suite gate (`tools/gate-suite.mjs`)

[c-testsuite](https://github.com/c-testsuite/c-testsuite) `single-exec`: 219 programs written by
other people. The hand gates test what I thought of; this one measures what C compilers are actually
asked to do — and **ranks the gaps by how many programs hit them**, which is the whole point.

```bash
npm run gate:suite           # against the committed capture, seconds
npm run gaps                 # just the ranked gap list
npm run gate:suite:capture   # re-run gcc over the corpus (slow, one-off)
```

The gcc side is captured once into `tools/suite-baseline.json` and committed, so daily runs are pure
JS — the same pattern as MIRAGE's `golden-baseline.json`.

**The gate fails on a WRONG ANSWER, not on a refusal.** A refusal is a known gap with a clear error;
a wrong answer means PRISM claimed success and lied. Current state: **182/219 pass, 37 refused,
0 wrong answers.**

### Four real defects, none of which a hand-written case had reached

1. **The frame was released before the return expression was evaluated.** `return foo(x)` ran `foo`
   on a frame overlapping this one, so `foo`'s own locals overwrote the array whose address had just
   been passed to it. It needs an aggregate local *and* a call inside a `return` to show up
   (`00077.c`); the value is now computed into a temp first.
2. **`long long` was silently miscompiled, not refused.** A non-address-taken local lives in a JS
   `var` and never reaches the load/store accessor, so the type check never fired and 64-bit
   arithmetic quietly ran as 32-bit. The check moved to `coerce()`, which every value passes
   through. **This is why "unsupported things throw a clear error" has to be verified, not asserted:**
   the claim was false for the one type most likely to be silently wrong.
3. **An incomplete array's size ignored designators and strings.** `int a[] = {5, [2]=2, 3}` has
   three items and four elements; `char s[] = "a" B "c"` is sized by its bytes.
4. **`__ILP32__` was missing** from the target macros, so a program probing its data model took the
   wrong `#if` branch.

⚠️ One reported difference was a harness artifact: the capture goes through `$(cmd)`, which strips
**every** trailing newline, while PRISM's side kept them. Strip both sides identically or a program
whose output ends in a blank line looks like a defect. Third time this class of thing has appeared —
see the `sed` and `timeout` notes above.

### The ranked gaps — and why the ranking mattered

My prediction before running it was "`long long` and `goto` are what real code hits first". The
first measurement said otherwise: **non-constant static initialisers were #1 with 8 programs**,
`goto` second with 5, and `long long` appeared in exactly one. Implementing static **address
constants** (`int *p = &x;`, `.p = &x`, `&arr[2]`, `name + 1`) took that from 8 to 4 and moved three
programs into passing.

Current ranking (37 refused programs, 21 distinct causes):

```
  9  long long / unsigned long long
  5  goto
  4  non-constant static initialiser (all four are compound literals now)
  3  missing header
  1× each: struct by value, statement expressions, strrchr, fopen, __builtin_expect,
           and eight one-off parse/emit corners
```

⚠️ A fix that changes nothing is usually not wired up. The address-constant work showed **no
improvement at all** on its first run, because the driver built the static-initialiser emitter with
empty symbol tables — the logic was right and unreachable. Check that a change is reached before
concluding it does not help.

## The torture corpus (`tools/gate-suite.mjs --suite=torture`)

**gcc's own `gcc.c-torture/execute`** — 1592 programs, the hardest widely-available C corpus. Fetched
from the gcc 12.2 release tarball (GitHub serves no subdirectory archive, and the API's 60
requests/hour makes 1400 raw fetches impossible):

```bash
curl -sL https://ftp.gnu.org/gnu/gcc/gcc-12.2.0/gcc-12.2.0.tar.xz -o /tmp/gcc.tar.xz
tar xJf /tmp/gcc.tar.xz -C .oracle/suites --strip-components=4 \
    gcc-12.2.0/gcc/testsuite/gcc.c-torture/execute
npm run gate:torture
npm run gaps:torture
```

These tests are **self-checking**: `abort()` on failure, exit 0 on success, so the exit status alone
is the oracle and no expected output is needed.

### Three harness corrections this corpus forced, each of which first looked like a PRISM result

**1. A gate that runs programs in its own process cannot stop one that loops for ever.** The first
torture run produced *no output at all* for over ten minutes. Every program now runs in its own
process (`tools/run-one.mjs`) under a 5 s wall clock, and a timeout is reported as a timeout.

**2. A self-checking corpus is only an oracle where the REFERENCE build passes.** Ten "wrong
answers" turned out to be tests that plain `gcc -O0` fails too: `memchr-1.c` exits 244, `strlen-2.c`
exits 2 at every optimisation level, and `return-addr.c` prints real return addresses so its exit
code differs per build. gcc drives its torture suite through its own harness over a matrix of
options; run outside that harness, those tests say nothing about PRISM. They are excluded and
**counted in the output**, never silently dropped.

**3. `abort()` is a DEFECT, not a gap.** It was first bucketed among the refusals, where 38
miscompiles sat looking like missing features. In a self-checking corpus `abort()` means the
program's own assertion failed — PRISM compiled it and produced a wrong value. Reclassified with the
wrong answers, which is what makes the gate go red for them.

### The ranking, and what it bought

The measured ranking was again not what I would have written. The largest gap in the first run was
not a language feature at all: **`__builtin_abort` in 124 programs**. Two tables — the `__builtin_*`
aliases (~164 programs) and gcc's predefined TYPE macros (`typedef __SIZE_TYPE__ size_t;` appears
instead of a header, and without the macro it reads as `typedef ;` — 60 programs) — took the corpus
from **696 to 868 passing**, with no compiler work at all; the bitfield-initialiser fix below made it 869.

Current state: **1214/1556 pass, ZERO wrong answers, 342 refused.**

That last number is the property worth having: across 1555 torture programs and 219 c-testsuite
programs, PRISM either compiles a program correctly or refuses it with a named error. It never claims
success and lies. Ranked gaps:

```
  142  long long / unsigned long long     <- now clearly the #1 feature
   78  missing header (66 of them <stdarg.h>, i.e. user-defined variadics)
   64  passing a struct or array by value
   41  parse error near '('
   37  non-constant static initialiser (compound literals)
   28  goto
   19  nested function definitions (a GNU extension)
   15  inline assembly
```

### P0.6c — closing the miscompiles (37 → ~8)

Correctness before coverage: a refusal is honest, a wrong answer is not. Seven distinct causes, in
the order they were found:

1. **`__attribute__((aligned(N)))` was parsed and thrown away.** It changes layout materially:
   `struct { char c; int i __attribute__((aligned(16))); }` puts `i` at 16 and is 32 bytes. A
   typedef carries it too. Also **member-level `packed`**, whose interaction with `aligned` is
   order-dependent and observable — `packed` drops the member to alignment 1 and a following
   `aligned(2)` raises it to 2, so `double d __attribute__((aligned(2),packed))` sits at offset 2,
   not 4.
2. **The address-precedence bug was only half fixed.** The earlier pass parenthesised the *composed*
   address but not the fragments: `((t)|0+2|0)` still parses as `t|2`. It hid for two whole rounds
   because on an aligned base `p|4` happens to equal `p+4` — an ordinary struct cannot expose it,
   and it took a *packed* struct's odd offsets to fail. **This single fix moved 15 programs.** The
   `packed-access-through-pointer` case in `gate-run` now pins it.
3. **A bitfield read undergoes the integer promotions**, and to a type that is not the declared one:
   `unsigned int u:7` promotes to `int`, because an `int` holds every value of a 7-bit unsigned
   field. Returning `unsigned int` made `bit.u % 61` unsigned (gcc's `bitfld-1.c` exists for this).
4. **Constant folding did integer division on floating operands.** `double d = 1024.0 - 1.0/32768.0`
   folded to exactly 1024.0, so `floor(d)` was 1024 instead of 1023.
5. **Bitfields in brace initialisers** were filtered out by `bits === undefined`, so
   `struct { signed s:3; unsigned u:3; } x = {-1,-1}` wrote *nothing*. Fixed in the dynamic path
   first and **the static path was missed**, so a file-scope `struct s x = {-123,-456}` still wrote
   nothing until a second, identical fix.
6. **`extern` inside a block created a private global** instead of binding to the file-scope object,
   so the inner declaration shadowed the outer definition.
7. **Two silent-wrongness sources turned into refusals**: type-changing attributes
   (`vector_size`, `mode`, `transparent_union`) were ignored like cosmetic ones, and wide literals
   (`L"…"`, `L'x'`) were emitted as bytes when `wchar_t` is 4 bytes on i386. Ignoring an attribute
   that changes a type is not "not supporting" it — it is producing a wrong program.

⚠️ **Refusing wide literals COST 9 passing programs** — a real trade, not a pure win: torture peaked
at 894 before #7 and settled at 885. Those 9 were passing because their wide strings were pure ASCII,
so the byte encoding happened to satisfy the test; they were right by accident, on the same code path
that made `wchar_t-1.c` wrong. A score that goes DOWN after a correctness fix is worth stating
plainly rather than smoothing over.

### P0.6e — the last six, and one property gained

37 → 0 wrong answers. The remaining causes:

- **The value of a bitfield assignment is what was STORED**, not the right-hand side. Assigning 1081
  to a `signed int m:11` yields -967, so `(l.m = j) == j` must be false (`921016-1.c`).
- **Source is a byte stream.** gcc's default input charset is UTF-8, but a narrow literal copies
  bytes through untouched and a real file need not be valid UTF-8 — `20000227-1.c` embeds a raw
  0xFF. Reading with `'utf8'` turned one byte into U+FFFD and then into three. Files are now read
  `'latin1'`, and a wide literal decodes the UTF-8 it carries.
- **Constant folding dropped casts.** `(unsigned short) -4` folded to -4 instead of 65532, so
  `volatile unsigned long l2 = (unsigned short int) -4;` held 0xFFFFFFFC (`pr39240.c`).
- **A flexible array member** contributes nothing to a struct's size but takes the next aligned
  offset; its size was `null`, which made the running bit position NaN. Initialising one is now a
  refusal rather than a plausible wrong object.
- **Two tests were excluded as bad oracles**, by name and with the reason recorded in the gate:
  `20031003-1.c` pins gcc's saturation on an out-of-range float→int (undefined), and `pr58943.c`
  pins gcc's order in `x[0] |= foo()` (an unsequenced read and modify). Same rule as refusing to
  compare on argument evaluation order.

**The duplication that caused the wide-literal mess got removed rather than patched.** Literal
decoding existed in three copies — the `#if` evaluator, the parser (to size an array), the emitter
(to lay bytes into memory) — and they disagreed, which is how `sizeof(L"Ä")` came out as 12. It now
lives once, in `src/util/charset.js`.

### P0.6d — wide literals, and what implementing a feature exposes

Implemented properly (`wchar_t` is 4 bytes on i386, so a wide literal is an array of 32-bit
elements): 885 → 892, miscompiles 8 → 6. Four separate things had to be right, and only the corpus
found the last three:

- The `L` prefix must be dropped **before** the quotes. Folding it into the slice that strips the
  quotes left `"Ä` and produced `x[0] == 34`.
- `L"a" "b"` is ONE wide string: the wideness of a concatenation is decided first and every part
  encoded at that width. Encoding each part at its own width put a 1-byte `'b'` after a 4-byte `'a'`.
- Indexing a wide literal must read a `wchar_t`. `#rval` returned `char *` unconditionally.
- A string literal's type is a **complete** array — `sizeof("ab")` is 3 — so it carries its length.

**A missing macro is not neutral.** `#if __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__` with both macros
undefined compares `0 == 0` and takes the big-endian branch. Defining the endianness macros fixed
`widechar-3.c` — and *revealed* two more failures (`bitfld-6/7`) that had been passing only because
an `#ifdef __BYTE_ORDER__` compiled to nothing and returned 0. A fix that makes the score worse may
simply have stopped hiding something.

**And that pair exposed a whole untested class:** `layoutUnion` recorded no bit placement at all, so
a bitfield in a union read `undefined >> 5`. The ABI generator had never produced one
(`bf = !union && …`), so nothing covered it. Now generated on both, plus two hand cases.

⚠️ **The ABI gate could not have caught #1's parser half.** `gate-abi` builds types by hand and
applies the alignment itself, so it verifies the layout *rules* and not the parser's use of them.
That is what `gate-decl` (which parses real C) is for, and the lesson is general: a gate that
constructs its own input does not test the front end that would normally produce it.

## 64-bit integers (P0.5b)

tier-0 represents `long long` as a **BigInt**. The plan called for i32 pairs and tier-1 will lower
them, but tier-0 is the compact/generic path: BigInt is correct by construction where pairs need a
twenty-function helper library and an out-of-band return convention.

The property that makes it safe is that **JS refuses to mix BigInt with Number**. Every conversion in
or out has to be written, and a missed one throws `Cannot mix BigInt and other types` — a loud error
rather than a quietly wrong number. That is the right failure mode for a 64-bit type on a 32-bit
target, and it is why `coerce()` handles i64 before anything else.

Three defects appeared the moment 131 previously-refused programs started running, and two of them
were in **constant folding rather than emitted code** — a place bugs hide well, because nothing
compares the compile-time and run-time paths against each other:

- A 64-bit literal was masked with `asIntN` regardless of signedness, so `18446744073709551615ULL`
  became `-1n` and `(double)` of it was -1.
- The parser's constant evaluator did not wrap a folded value to its expression's type, so
  `long long b = (0x1234567876543210LL << 32) >> 32;` kept the shifted-out bits while the same
  expression evaluated at run time did not.
- `printf` needed real length modifiers: `nextArg() | 0` on a BigInt throws, which is how `%lld`
  announced itself.

A fourth test was excluded as a bad oracle: `20021127-1.c` defines `llabs`, a name reserved for the
library (C 7.1.3), and pins gcc's builtin folding rather than any required behaviour.

## Struct by value and inline asm (P0.5b, continued)

**Structs by value** (65 programs): a by-value parameter is a pointer to a copy the CALLER made — so
the callee may modify it without the caller seeing it — and a return goes through a caller-supplied
buffer (the sret convention), because the callee's frame is released before the value could be read
out of it. Both the copies and the buffer are allocated in the caller's frame. Torture 1026 → 1096,
and for the first time a feature landed with **no new miscompiles at all**.

**Inline asm** is now genuinely parsed — qualifiers, template, operands, clobbers — instead of being
skipped as an opaque token run. The qualifiers alone were the reason 39 programs failed to *parse*:
`asm volatile ("")` puts `volatile` between the keyword and the paren.

An asm with an **empty template** emits no instructions, so with no output operands it is faithfully
a no-op whose inputs are still evaluated (they are C expressions and may have side effects).

### The rule this session had to learn twice

Generalising that to "empty template = nothing at all, outputs included" was wrong, and the corpus
said so immediately: a **tied constraint carries a value through the shared register even with an
empty template**, so `asm ("" : "=r" (i) : "0" (x))` copies x into i (`20030222-1.c`), and an output
operand's lvalue may itself have side effects — `asm("" : "+r"(*bar()))` must still call `bar()`
(`990130-1.c`). Narrowing back to "no output operands" cost 12 passes (1120 → 1108) and restored
zero wrong answers.

This is the **second** time the same shape appeared — wide literals first, then asm:

> Implementing a feature moves programs from *refused* to *wrong*, and the fix is to narrow the
> claim rather than to add more code.

So: **judge a landing by the miscompile count, not the pass count.** A feature that raises passes
while raising miscompiles has made the compiler worse, because a refusal is honest and a wrong
answer is not.

## The rest of P0.5b: varargs, goto, and a batch of parse errors

**User-defined variadic functions** (49 programs). The caller packs the variadic tail into a buffer on
the shadow stack and passes its address; `va_list` is a plain `char *`, exactly as on i386 SysV. The
pleasant consequence is that **`va_arg` needs no emitter support at all** — two builtins and a macro
suffice:

```c
#define va_arg(ap, type) (*(type *)__prism_va_next(&(ap), sizeof(type)))
```

Two defects, both from the two halves of a convention disagreeing:

- The variadic tail was passed **both** positionally and in the buffer, so the buffer landed in the
  wrong JS parameter.
- Each argument was **evaluated twice** — once to learn its type, once to store it — so
  `f(2, i++, i++)` incremented four times. The type now comes from the parser's annotation instead.
- A **zero-sized** argument advanced the reader by one slot and the packer by none (a `|| 1` fallback
  on one side only), which desynchronised every argument after a `struct { char x[0]; }`
  (`va-arg-22.c` passes 21 structs by value, the first of them empty). **Both halves of a convention
  must share the rule**, or a corner case shifts everything after it.

**`goto`** (16 programs) is a state machine over the function's top-level statements: a labelled
`for(;;) switch(_pc)`, where a jump sets `_pc` and `continue`s. JS switch fallthrough reproduces C
label fallthrough exactly, and `continue _top` from inside a nested loop unwinds it — which is what a
goto out of a loop must do. A label nested inside a block still needs control-flow flattening and is
refused by name.

That translation then made **GNU label addresses free**: in a state machine the "address" of a label
IS its dispatch value, so `&&lab` is an integer and `goto *p` is a dispatch on it — including from a
static table (16 programs).

**A parse-error batch** (~46 programs): `asm ("" : : : "memory")` failed because the clobber section
was identified from a counter that had already been incremented; `++`/`--` on a bitfield now
read-modify-writes and yields the value STORED; and GNU complex types became a named refusal instead
of surfacing as "expected ';'".

⚠️ **A third test case of mine relied on undefined behaviour** — `printf("%u %u", f.a++, f.a)`. The
checklist for a new case in this file is therefore: no unspecified argument order, and no unsequenced
read-and-modify of one object. (A fourth self-inflicted one: backticks inside a C comment terminate
the JS template literal the case lives in.)

## P1 — MAME 0.1 (`tools/mame.mjs`)

MAME 0.1 compiles from its unmodified source and runs: 18 translation units, 894 functions, 0.55 MB
of emitted JavaScript.

```bash
node tools/mame.mjs                       # build only
node tools/mame.mjs --run --test-rom      # run with a hand-written Z80 ROM
node tools/mame.mjs --run --test-rom --args="-nosound -nojoy -vesa"   # the other display path
```

**The platform boundary is MAME's own.** `osdepend.h` declares exactly eighteen functions and the
whole Allegro dependency lives in `src/msdos/msdos.c`, which MAME's makefile already selects per
platform. PRISM supplies a different backend (`src/env/osd.js`) and compiles every other file
untouched — the intended use of the abstraction, not a modification. Built without `-DX86_ASM`, a
build option Z80.c guards its assembly behind.

Everything in the backend is **deterministic**: `clock`/`uclock` are counters, `rand` is the ANSI
LCG, `osd_obtain_pen` hands out indices in order. Reading host time or entropy would destroy the
property that makes a golden frame fingerprint possible.

**Game ROMs are not included and will not be fetched** — they are copyrighted data. Verification
instead uses a **hand-assembled Z80 program** as `pacman.6e`, which proves more than a game ROM
would because the opcodes are known and so is the expected effect: it writes 64 cells of video RAM
at 0x4000 and colour RAM at 0x4400, and the run fills exactly the bottom two rows of the display —
224×16 = 3584 pixels, all one pen. That exercises the Z80 core, the memory-map dispatch and the
tilemap renderer with data authored here.

⚠️ **Open, and deliberately not explained away:** writing 32 cells instead of 64 produces *zero*
pixels anywhere, which no model of "which video RAM indices are visible" accounts for — 32 indices
cannot fill the 56 visible cells that 64 do. The first hypothesis (56 of 64 visible) was refuted by
measurement; a second was not invented. It is a question about Pac-Man's video RAM mapping rather
than about PRISM, resolvable by instrumenting the driver, and it blocks nothing.

### Four defects found by compiling real code, two of them structural

1. **A struct tag was never completed.** `driver.h` includes `machine.h`, which declares
   `struct MachineDriver *drv` *before* `driver.h` defines the body. On the definition PRISM created
   a NEW placeholder and re-declared the tag, leaving every earlier reference pointing at an object
   that was never filled in. Any pair of mutually-referential headers hits this — and 1774
   single-file test programs cannot.
2. **Call sites used the source name, not the linkage name.** A file-scope `static` had its
   definition mangled per unit but its callers did not follow.
3. **An enum whose enumerators are all non-negative is unsigned.** Only observable through a
   bitfield: `enum e code : 8` holding 150 must read back as 150, not sign-extend to -106. Caught by
   applying this file's own rule — judge a landing by the miscompile count — when c-testsuite went
   from 0 wrong answers to 1.
4. DJGPP's `uclock`/`uclock_t` had to be real (64-bit, `UCLOCKS_PER_SEC` = 1193180): MAME uses them
   unless `UNIX` is defined, and a DJGPP target must therefore provide them.

Multi-unit linking itself was new work (`compileProgram`): parse every unit, place every name, then
emit — with internal linkage mangled per unit.

## The Z80 differential (`tools/z80diff.mjs`) — P1.4

The tool the Pac-Man bug needed. It compiles `tools/z80diff/z80diff.c` plus MAME's `Z80.c` twice —
once with the oracle's i386 gcc, once with PRISM — drives both from the same ROM image with the same
T-state budget, and prints the register file after every step. With identical initial state, any
divergence is a compiler bug and nothing else. Same shape as MIRAGE's Unicorn co-simulator.

```bash
node tools/z80diff.mjs --roms=<dir with pacman.6e .6f .6h .6j>
```

No ROM data lives in the repository: the harness reads whatever directory it is pointed at and copies
the image into the gitignored `.oracle/`.

**It found the defect in seconds**, at `PC=0x2313`, instruction `10 fc` = `DJNZ -4`: gcc lands on
0x2311, PRISM landed on 0x2310. The cause is one line of MAME's core —

```c
#define M_JR   R.PC.W.l += (offset)M_RDMEM_OPCODE();
```

`M_RDMEM_OPCODE()` increments PC. In `a += b` the load of `a` and the evaluation of `b` are
**unsequenced**, so gcc evaluates the right-hand side first and reads the already-incremented PC,
while PRISM read PC first. Every relative jump was one byte short, which is why Pac-Man never got
out of its init.

PRISM now evaluates the right-hand side of a compound assignment **before** loading the lvalue. Both
orders conform; only one runs the code this project exists to run. Consequently
**`pr58943.c` is no longer excluded as undefined behaviour** — it passes on its own, and the
exclusion list is one shorter. Worth keeping in mind: the earlier decision to exclude it was correct
as a *gate* decision and wrong as a *design* decision, and real code settled it.

### Two lessons from building the harness itself

**A differential only tests the paths it drives.** The first version always returned
`Z80_IGNORE_INT`, so its "identical over 20000 steps" said nothing about `EI`/`DI`, `IM 2`, vector
fetch or `RETI` — exactly the code an interrupt-driven game depends on. Extending it to offer
interrupts is what exposed the next difference.

**Not every divergence is a bug.** `Z80_Reset` does `R.R = rand()`: the core randomises the refresh
register deliberately, and PRISM's `rand()` is a deterministic LCG rather than glibc's sequence. The
harness pins the initial state instead of excluding the field — control the input rather than mask
the output. (This is a real, documented divergence: any program whose output depends on `rand()` will
differ from a native build.)

State: **identical over 20006 steps including interrupts.** The Z80 core is compiled correctly, so
Pac-Man's remaining failure is in the machine layer, not the CPU.

## When a program runs but its command buffer does not

A discriminator worth keeping, because the two states look identical from outside: a program whose
main loop is alive, and one whose main loop never reached the place where typed commands are
executed. Both draw, both echo what you type, both return you a prompt.

**Type a command that has no guards of its own and see whether it answers.** In Quake, `echo hello`:
`Cmd_Echo_f` takes no arguments it can reject and belongs to no subsystem that can be uninitialised,
so its silence has exactly one meaning -- `Cbuf_Execute()` was never reached. There is a single
`Cbuf_Execute()` in `host.c` (line 657, inside `_Host_Frame`, three lines after `Sys_SendKeyEvents`),
so the fault is upstream of it.

The trap this catches is that the echo proves less than it looks like it proves. Quake has FIVE key
pumps: the main one in `_Host_Frame`, plus `Con_NotifyBox`, `SCR_ModalMessage` and the two in
`WaitJoyButton`. The modal ones set `key_count` negative first -- and `keys.c:609` writes
`key_lastpress = key` BEFORE the `if (key_count <= 0) return`, and `key_count = -1` swallows only the
FIRST event of that drain. So a modal pump echoes everything after the first keystroke and redraws
it on the next line. A live console is therefore not evidence that the main loop is running.

The MIRAGE session found its Quake stuck this way: `Host_Init` had never returned, because
`IN_ReadJoystick` mistook a game port answering 0xF0 for a centred joystick and `WaitJoyButton` was
waiting for a button that could not arrive. Everything downstream -- no demo, no game frame, an empty
`cls.demos[]` reported as `No demos listed with startdemos` -- followed from that one port value.

## The whole-build differential (`tools/mamediff.mjs`) and the first perf number

`z80diff` proved the CPU. `mamediff` covers everything above it: both sides compile the SAME MAME
sources with the SAME headless C backend (`tools/mamediff/osdnull.c`) and print a hash of the display
bitmap every frame, so the first differing line names the frame.

```bash
node tools/mamediff.mjs --roms=<dir> [--frames=200] [--release=01|04] [--game=wow]
node tools/mamediff.mjs --roms=<dir> --frames=1100 --play=120,200,700,1080   # coin, start, fire
node tools/mame.mjs --run --roms=<dir> --frames=200 --png=/tmp/pacman.png
node tools/mame.mjs --run --release=04 --game=wow --roms=<dir> --frames=1100 \
     --keys=120:3,200:1,700-1080:ctrl --args="-log" --save=error.log:/tmp/wow.log
```

**It plays now, and that was a gap rather than a nicety.** Every headless MAME capture until this
point was an ATTRACT MODE: a driver's tilemap and nothing else, never its sprites, its collision code
or the blitter modes a game uses while somebody holds the fire button. So a report of "shooting looks
wrong in Wizard of Wor" could not be reproduced at all, let alone diffed. `--play` compiles the same
three-number schedule into BOTH backends, so the two runs stay identical by construction — this adds
input, not nondeterminism — and `tools/mame.mjs --keys=` is the same schedule for the PRISM-only
harness. `--save=error.log:<path>` recovers a file the PROGRAM wrote: MAME's own `-log` option makes
its drivers report what they are doing, so the emulator can be asked in its own words with no
instrumentation on our side.

**MAME 0.4 has no native oracle, and the reason is worth recording.** `src/machine.c` switches on
`(int)mra->handler` with `case MRA_RAM:`, where `driver.h` defines `MRA_RAM` as `((int(*)())-1)` — a
cast POINTER constant. gcc 2.7 on DJGPP accepted that as a case label; gcc 12 refuses it outright,
and a command-line `-D` cannot help because the header defines the macro itself. Neither the game's
source nor the reference build may be patched, so **0.4 and 0.3 cannot be diffed until the container
has a period compiler** (gcc 2.x, or tcc). 0.1 and 0.2 do build, and still agree exactly. The tool
says this in one sentence rather than printing the compiler's wall of output, because a missing
oracle is a different fact from a broken harness.

**Result: identical over 226 lines at 200 frames** — every frame hash matches gcc, including the 31
frames from 91 onward that actually draw (26 340 lit pixels at frame 92). PRISM's output is
bit-identical to a native i386 gcc build of MAME 0.1, frame by frame.

### Two defects, and one claim of mine that the measurement refuted

**A runtime builtin shadowed a function the program defines.** `#call` consulted the builtin table
before the program's own functions, so MAME's headless `osd_key_pressed` was replaced by PRISM's —
which always returns 0, so the run never ended. It burned **twelve hours** before being noticed. The
general form is worse than the symptom: a program defining its own `memcpy` or `printf` would have
silently got PRISM's. A definition now wins; a mere prototype does not, so `int printf();` still
reaches the runtime.

**The platform backend allocated in the wrong region.** `src/env/osd.js` built its bitmaps with
`mod.alloc`, which grows the STATIC area by advancing `brk` — but the heap start is fixed when the
program begins, so allocating there at run time handed out addresses `malloc` later handed out again.
The framebuffer was quietly overwritten and read as all-zero, while the C backend compiled from the
same source saw 26 340 lit pixels. A platform backend must use the guest's own allocator.

⚠️ **I claimed tier-0 was "pathologically" slow on the strength of that twelve-hour run.** It is not:
121 frames of Pac-Man run in **0.31 s**. The run was a hang, not slowness, and asserting a
performance characteristic from a hang is exactly the mistake MIRAGE's "measure, do not justify" note
warns about.

### The perf number (`tools/bench.mjs`), and three wrong versions of it

One comparable unit: MAME's Z80 core executing Pac-Man's ROM, a fixed instruction budget, with a
**checksum on both sides** so the ratio is meaningless unless both did identical work.

```
                                   10M steps      40M steps
gcc -O2, i386 EMULATED             15.5 M instr/s  15.3 M instr/s
clang -O2, arm64 NATIVE           227.8           231.2
PRISM tier-0                       25.5            24.0
```

**PRISM tier-0 is ~9.5× slower than native.** Stable across a 4× change in workload, which is what
makes it believable. The plan feared 30× for a DataView-based emitter with no optimiser at all, so
9.5× is better than expected — and it is the number P2 (IR, escape analysis, tier-1) now has to
justify itself against.

Note in passing that the containerised gcc runs 15× slower than native clang: the oracle container
is an excellent correctness reference and a useless speed one.

#### The three wrong answers this measurement gave first

1. **"PRISM is 3.5× FASTER than gcc."** True as measured, meaningless as stated: the gcc side is i386
   under emulation while the JavaScript runs natively. A reference has to run on the same silicon.
2. **"PRISM is 2.3× slower than clang."** Wrong: the native side was timed from outside with
   `spawnSync`, so process creation and scheduling were counted as work.
3. **"clang runs at 36, then 79, then 115 M instr/s."** A 3× spread on the same binary — obviously the
   harness, not the machine. Fixed by having the native builds **time themselves** with
   `gettimeofday` and taking the best of three; clang then reported 227.8 and 231.2 on workloads 4×
   apart. PRISM was in-process all along, which is why its figure was stable (23.9–26.8) throughout
   and the native one was not.

The lesson is narrower than "measure carefully": **a ratio is only as good as the weaker of its two
measurements**, and the stable side gives no warning that the other is broken. Three consecutive
conclusions were reported before the numbers stopped moving.

## Gates still to build

In the order the roadmap wants them: preprocessor vs `gcc -E`; c-testsuite; gcc torture `execute/`;
the Csmith differential; tier-0 == tier-1; whole-program pixel diff against MIRAGE running the
original binary; `dbx-oracle` DOS-call sequence; and the perf ratio in one comparable unit.

## Verifying in a browser — four traps, all hit

1. **The tab was `hidden` the whole time.** `requestAnimationFrame` never fired, so the paint loop
   never ran, the acknowledgement never advanced, and the guest sat at frame 2. The display looked
   broken; nothing was broken except the assumption that a page in an automated browser is visible.
   Pacing was moved onto a timer as a result — a real fix, found by a harness artefact.

2. **Every synthesised keypress was silently dropped.** Keys sent by the automation harness arrive
   with `KeyboardEvent.code === ""`, and the shell keyed off `code` alone. The screen looked perfect
   and the input did nothing. Fixed with a fallback to `event.key`, which also covers on-screen
   keyboards and some remote-desktop stacks.

3. **I screenshotted before the guest had drawn — three times.** At 3 fps a coin takes a second of
   wall clock to reach the credit line. Three separate "the coin does not register" conclusions were
   wrong; each time the fix was to read the shared state at the instant of the event (`keys[4]` was 1
   in the handler, the latch counted down over the next 8 frames) rather than to photograph the
   canvas afterwards. *Look at the counter, not at the picture* — and I needed telling three times.

4. **The control table was transcribed from habit, not from the source.** MAME 0.1's coin key is
   `OSD_KEY_3`; 5 is a modern MAME convention and does nothing in 1997 code. The answer was four
   lines into `src/pacman/machine.c`.

### A calibrated constant, not a chosen one

`KEY_HOLD_FRAMES` is 8 because Pac-Man's ROM debounces its coin input: a 1-frame pulse registered
nothing, 4 frames registered nothing, 8 frames registered exactly one coin, and a physical hold
spanning 6 frames registered two. A guess would have been 1.

### The pacing bug the gates could not see

Every gate was green while the game was unplayable. Nothing in the headless suite has a frame rate:
`gate-run` compares stdout, `mamediff` compares frame hashes, and both are indifferent to *when* a
frame happens. The defect — pacing the guest against the page's paint rate instead of against a clock
— was only visible to somebody trying to play, and it was reported that way ("injouable car trop
rapide").

Worth keeping in mind for the tiers: an emitted-code bug shows up in a corpus, but a *timing* bug
needs a human or an explicit measurement of fps against the program's declared rate. The shell now
prints `59.9 of 60 fps`, which is that measurement made visible.

### An exception in a timer is silent

`stats()` referenced a constant I had renamed. It runs on a 250 ms interval, so it threw 32 times
into the console and the only visible symptom was a status line stuck on "idle" — the canvas, the
program and the frame counter were all fine. Reading the browser console is not optional after a
rename: a throw inside a timer or a rAF callback does not stop anything and does not surface.

### Four wrong explanations for 2 fps

The frame rate came out at 57 instead of 60 and I explained it four times before measuring it.

1. "The park granularity overshoots" — plausible, and asking for 0.25 ms instead of 1 ms did move it
   from 43-59 to 55-59. Partly right, and it hid the rest.
2. "The learned deadline will fix it" — the learning was measuring from the start of the wait to the
   *next frame boundary*, which is the frame PERIOD, not the wait. The landing window sat past the
   deadline and did nothing.
3. "The 4096-call spin burst before damping costs 0.6 ms a frame" — a clean arithmetic story that
   matched the residual exactly. Lowering the threshold to 64 changed the rate by nothing at all.
4. Only then did I post the counters out of the worker: `spins: 0`, every `learned: 0`. The landing
   window had **never fired**, because the run counter is clamped to the threshold once damping
   starts and the test was `run > limit` — never true. Three of the four explanations were about a
   mechanism that was not running.

The lesson is not "measure more", it is *where*: all of this state lived in the worker, invisible to
the page, and I kept explaining it from the outside. `postMessage` from a worker queues to the page
without the worker yielding, so even a guest blocked in its own loop can report its counters. That
diagnostic channel should have been the first thing built, not the fifth.

### Open: Quake compiles 10x slower in the browser than in Node

Measured, unexplained, and recorded rather than guessed at.

| | |
|---|---|
| Node, 69 units, 1.67 MB emitted | 0.9 s |
| the same build in a browser worker | 9.4 s |
| MAME in the same browser worker, 0.46 MB emitted | 0.7 s |

Superlinear in emitted size, which is the shape MIRAGE's D6 lesson predicts — but that lesson is about
emitted VOLUME, and Node compiles the same volume in a tenth of the time, so it does not explain the
gap on its own.

**Hypothesis refuted by measurement:** the browser uses a SharedArrayBuffer for the guest image and
the Node tool does not, so shared memory was the obvious suspect. Compiling the same units in Node
both ways: 903 ms unshared, **765 ms shared**. Shared memory is not the cause, and is if anything
marginally faster here.

Candidates not yet tested: `new Function` on a 1.67 MB source string being parsed eagerly in a worker,
a cold JIT tier, or the pane's Chromium build. The next step is to time the phases separately —
preprocess, parse, emit, `new Function` — on both sides, rather than to reason about it further.

### The shadow-stack leak, and the two tools that found it

Quake ran for 1238 frames and then stopped with its own message: `R_RenderView: called without
enough stack`. Quake checks that a local's address has not drifted more than 10000 bytes from the one
it recorded at start-up.

It had drifted. `--trace-sp` on `tools/quake.mjs` wraps `Host_Frame` — reachable because sys_null.c's
main() calls it across a unit boundary, so it goes through the function table — and showed **8 bytes
lost per frame**. 8 x 1250 = 10000, which is exactly where it died.

`--audit-sp` then wrapped all 1030 functions and checked the invariant directly: **M.sp on return
equals M.sp on entry, always**, including for a function that used alloca, because a frame's space
dies with the frame. Four functions violated it, and the smallest violation was the one worth reading:

    function W_GetLumpinfo(name){
      var _fp=M.sp-20|0;        // the frame is 20 bytes
      ...
          M.sp=_fp+16|0;        // an early return gives back 16
          return _t2;

The epilogue was written inline with `this.frameSize` **as it stood at that moment**, and slots are
allocated as emission proceeds — the varargs buffer for a later `Sys_Error` call grew the frame from
16 to 20 after that return had already been emitted. The fix is to emit a marker and resolve it once
the frame is final.

Three things worth keeping from this:

1. **The bug was old, not new.** It predates the flattening pass; every function with an early return
   followed by any later allocation leaked the difference. Nothing in either corpus caught it, because
   a leak is invisible unless something measures the stack — c-testsuite and gcc's torture programs
   run once and exit.
2. **Quake caught it because Quake checks.** A program without that assertion would have run until the
   shadow stack overflowed, and the failure would have looked like anything at all.
3. **An invariant is worth more than a test.** "sp out == sp in" is checkable over every function in a
   real program, and it turned a mystery into a name in one run. `--audit-sp` stays in the tool.

### What SQLite found that two games and 1775 corpus programs did not

SQLite is 269,650 lines in one translation unit, with no platform layer and no data files. It was
picked as a COMPILER test rather than a host test, and it earned that in one session — every item
below is a defect it exposed, ranked by how it was found rather than by size:

| Defect | Why nothing else caught it |
|---|---|
| **`const` on a pointer to an incomplete tag** broke the tag's later completion. `qualify()` cloned the record, so `struct A { const struct B *p; }; struct B { int v; };` left the clone empty for ever and `a->p->v` reported "no member". | MAME's mutually-referential pair had no `const`. The fix from that bug — complete the existing tag rather than replacing it — was correct and insufficient. |
| **Comparisons and `?:` did not fold in static initialisers.** A static initialised with `0 == 1` was refused outright. | Both corpora have such programs, but they were already refused for other reasons; this one was masked. |
| **Pointer arithmetic with a 64-bit index** emitted `Math.imul(x\|0, 1)` on a BigInt. | The BigInt representation is deliberately loud, and it was: "Cannot mix BigInt and other types". Nothing else indexed a buffer with a `long long`. |
| **The address of a library function** had no address to take. SQLite's unix layer builds a table of syscall pointers so it can swap them under test. | Programs call libc; they rarely take its address. |
| **`offsetof` in an ordinary expression** — the constant folder knew it, the emitter did not. | 38 SQLite functions use it; neither game does. |

Two diagnostics were improved because a message named a node kind rather than a thing: `'ident' is not
a constant expression` became `identifier 'EAGAIN' is not…`, and a refused static initialiser now
describes the expression it refused. In a 270,000-line file, a node kind is not a search term.

And one harness bug that had been sitting in four tools: a header resolver that reduced `sys/types.h`
to `types.h` before consulting the table, stubbing a header that was right there. It surfaced as a
parse error inside the stub, twenty lines from its cause.

Net effect on the external corpora, from work that was aimed at SQLite alone:
**c-testsuite 196 → 197, gcc.c-torture 1243 → 1255, still zero wrong answers.**

### Two symptoms in Doom, three different causes

Reported as "no demo plays, and pressing Enter gives a menu with a strange blink". None of the three
causes was where the symptom pointed.

**1. The demos are refused by Doom itself.** Its own message says so: `Demo is from a different game
version!` — the shareware `DOOM1.WAD`'s recorded demos carry a version byte `linuxdoom-1.10` does not
accept. Faithful behaviour of this source with this WAD, not a PRISM defect, and the program printed
the answer all along.

**2. The clock was racing.** The deterministic `gettimeofday` advances one Doom tic per CALL, and
`I_GetTime` is called several times per frame, so game time ran far ahead of frames and the attract
pages flew past. `installRealClock` now supplies `gettimeofday` as well — Doom times itself with that
rather than with `clock()` — and the measured rate is 34.9 fps against Doom's TICRATE of 35.

**3. A block-scope function declaration became a null local.** This one was worth the hunt. Doom's
melt effect contains:

    int wipe_ScreenWipe(int wipeno, ...) {
        static int (*wipes[])(int, int, int) = { ... };
        void V_MarkRect(int, int, int, int);      // <- a declaration, inside a body
        ...
        (*wipes[wipeno*3])(width, height, ticks);
        V_MarkRect(0, 0, width, height);

The crash was `call through a non-function pointer 0x0` inside `wipe_ScreenWipe`, which points
straight at that dispatch table — and the table was **perfectly correct**, six valid pointers, as
reading the linked image showed. The null was `V_MarkRect`: PRISM's handling of a block-scope
declaration was gated on `storage === 'extern'`, and **a function declaration needs no keyword** to be
external. So it created a local variable holding zero, and the next line called through it.

The lesson is about where to look, not about the fix. Three minimal reproductions of the *table* all
passed — function-pointer arrays at file scope, with implied size, as a `static` local — because the
table was never the problem. What settled it was dumping the symbol out of the linked image and then
reading the emitted JavaScript, where `M.icall(_v_V_MarkRect, ...)` sits two lines below
`var _v_V_MarkRect=0`.

Still open: starting a real level (`-warp 1 1`) now gets further and then loops in pure guest C, where
the runtime-call profiler is blind by construction — no runtime calls, nothing to count.

### Safepoints: making a loop in pure guest C observable

Doom started E1M1 for real — `gamestate = GS_LEVEL`, the renderer running — produced frames 5, 10,
15, 20, 25 all inside a tenth of a second, and then stopped. **Stalled, not slow**, which took a
per-frame progress line to establish; a final report cannot tell those apart, and several rounds went
by on an unmeasured "Doom is slow".

Two false trails, both mine, kept because they are the shape of the mistake rather than its detail:

* **"It must be the BigInt fixed-point maths."** `FixedMul` is `((long long)a * (long long)b) >> 16`
  and `long long` is a BigInt in tier-0, so this looked obvious. Measured: the three primitives are
  **45% of a 1 ms frame** — thousands of calls, not millions.
* **A Heisenbug.** Wrapping every function-table entry with a counter made 40 frames complete;
  without it they never arrived. Rebinding the same entries without wrapping changed nothing.

What was missing was not an idea but an **instrument**. Two profilers existed — one counting runtime
services, one counting cross-unit calls — and a program spinning inside one C function is making
neither kind of call, so both see a program doing nothing at all. The only place the host can regain
control is the loop itself, which is what MIRAGE concluded when it studied the same problem: a
safepoint **in** the emitted code, not a re-translation.

`compileProgram(units, { safepoints: true })` emits, on every loop back edge,

    if(--M.spBudget<0)M.sp_(ID);

where ID indexes `mod.safepoints`, a table naming the function and the loop. The default handler just
refills the budget. A harness replaces `M.sp_` to sample. It is off by default and it is not free —
a decrement and a compare per iteration of every loop — and the same mechanism is what would let a
Stop button interrupt a `while (1);` in the browser, which nothing can do today.

It named the culprit on the first run:

          7781820000 iterations  wipe_doMelt#72        <- the `for (i=0;i<width;i++)`
            48640000 iterations  wipe_doMelt#73        <- the `while (ticks--)`
              600000 iterations  R_InitTextureMapping#353

The ratio between the two hot entries is exactly 160, which is `width/2` — one outer tick per 160
inner iterations, and the outer loop running 48 million times for a `ticks` that should be 1. Doom's
melting screen wipe, which is also what the eye had already reported as "un blink bizarre".

### The zero that was not a date

Reading `y[]` out of guest memory from **inside** the stalled loop — via the safepoint handler, so
that nothing hot is wrapped and the Heisenbug is not disturbed — showed all 160 columns at 200, the
screen height. The melt was **finished**. It was `while (ticks--)` on a negative `ticks`, counting
down through the whole `int` range.

`ticks` comes from `tics = nowtime - wipestart` in `D_Display`, off `I_GetTime`:

    static int basetime = 0;
    gettimeofday(&tp, &tzp);
    if (!basetime) basetime = tp.tv_sec;
    newtics = (tp.tv_sec-basetime)*TICRATE + tp.tv_usec*TICRATE/1000000;

PRISM's deterministic `gettimeofday` started at **zero**. So `tv_sec` was 0 for the first 35 calls,
`if (!basetime)` never fired, and on the 36th call `basetime` finally took a value — at which point
`I_GetTime` jumped **backwards** by 35 tics. One negative subtraction later, four billion iterations.

The fix is one constant: a `struct timeval` counts from 1970, so `tv_sec` is large on the very first
call a program ever makes, and programs rely on that without saying so. `EPOCH_US` now sets the
origin to 1997-02-05 for both the deterministic clock and `installRealClock`. Deterministic, so every
gate gets the same answer as before; nonzero, so the guard fires when a real system would fire it.

The general lesson, and the reason this is in TESTING rather than in a commit message: **a plausible
default is not a faithful one.** Zero is the obvious starting value for a counter and the wrong one
for a clock, and nothing short of a program that reads the clock would ever have shown it.

Doom now runs E1M1 at 260 frames of about 1 ms each, `gametic` 1096, status bar and all.

### Looking at the emitted JavaScript

The claim that the emitted code is readable is only worth something if it is easy to check:

```
node tools/dump.mjs file.c                 the whole unit
node tools/dump.mjs file.c --fn=main       one function
node tools/dump.mjs file.c --safepoints    with the loop back-edge checks
node tools/doom.mjs --fn=R_DrawColumn      one function out of a 62-unit program
```

For a real program the per-function view is the usable one: Doom is 1.11 MB of JavaScript.


### P1.7: deleting the hand-written backend, and the loop it exposed

MAME now compiles `src/msdos/msdos.c`, its own DOS platform backend, and `src/env/osd.js` is gone.
The check that this changed nothing is the number `--test-rom` prints: **3584 non-zero pixels**, the
224x16 band the hand-written Z80 program draws, identical through the tweaked VGA mode and through
`-vesa` at 640x480.

Two things went wrong, and both are the same mistake in different clothes — assuming an ending.

* **The VESA path never presented a frame.** `_dosmemputl` writes one scanline at a time, so the
  frame boundary is the LAST one; I looked for a write reaching the bottom of the 640x480
  framebuffer. msdos.c centres a 288-line bitmap in 480 lines, so its last write is to line 383 and
  the bottom is never touched. Counting scanlines against the game's own `bitmap->height` is what
  actually ends a frame. Symptom: `--frames=10` ran for ever, because the cap is counted in frames.
* **`while (osd_key_pressed(k));` cannot be seen from outside.** With osd.js, `osd_key_pressed` was a
  JavaScript function and spin damping parked it. It is now MAME's own C reading `key[]` out of
  memory: no call, no service, nothing to count, and the array would never change because only the
  host writes it. The safepoint from the previous section is what breaks it — and that is not a
  workaround. On a real DOS machine that array is written by a keyboard INTERRUPT, and a safepoint is
  the only place this runtime can be interrupted at all. Enabled per program: the browser descriptor
  carries `"safepoints": true`, Doom's does not.

### Open: the audio-device prompt blocks headless

Without `-nosound`, `osd_init` prints the SEAL device list and calls `scanf("%d",&i)`. Headless, that
never returns an answer and the tool hangs; `tools/mame.mjs` therefore passes `-nosound -nojoy` by
default, which are msdos.c's own switches and not a modification. In the browser it is not a problem
— the console reads a real keystroke — but the headless path should answer rather than hang.


## Sound

Three targets, three different libraries, and the shape of each platform layer was decided by the
program rather than by the host — which is the same finding as pixels, one dimension down.

```
node tools/gate-sound.mjs --wav=/tmp/probe.wav     # MAME's SEAL path, against a known waveform
node tools/mame.mjs --run --test-rom --wav=/tmp/pac.wav
node tools/sndserv.mjs --data=<dir with DOOM1.WAD> --wav=/tmp/sfx.wav
```

### It leaves the guest the way pixels do

An audio ring in the control block (`src/env/webhost.js`), 16384 signed 16-bit samples, with
monotonic write and read cursors. The page's `web/audio-worklet.js` reads it on the audio thread,
where a blocked main thread cannot make it stutter, and publishes back what it has consumed.

The reason is the one that shaped the whole host: a C program's sound library is called from inside a
main loop that never yields, so there is no moment at which the guest could hand a buffer to anybody.
It writes; the page reads.

Two details that are not optional. The worklet **resamples**: a guest picks its rate from its own
source — `#define SAMPLE_RATE 44100` in msdos.c, `#define SAMPLERATE 11025` in Doom — and the device
picks its own, usually 48000. Playing 44100 at 48000 without a step is everything 9% sharp, which is
very easy to mistake for the emulation running fast. And an underrun **decays the last frame** rather
than dropping to zero, because a jump to silence and back is a click.

### MAME: SEAL, where the library owns the mixing

`src/env/allegro.js` implements a four-voice mixer, because SEAL is the mixer — msdos.c only hands it
waveforms, frequencies and volumes. The hard part was not the mixing:

    for(;;) { AGetVoicePosition(hVoice[channel],&pos);
              if (c == 1 && (pos < len || pos > 2*len)) break;
              osd_update_audio(); }

`osd_play_streamed_sample` **blocks** on the play cursor — a triple-buffered stream waiting for the
DAC to leave the third it is about to overwrite. On real hardware that cursor moves because DMA runs
in real time and AUpdateAudio only refills. A shim whose position never moves hangs MAME on its first
streamed sample. So the play cursor advances with TIME here too: the browser's real clock in the
browser, and one frame of sound per call headless.

Headless it is deliberately **not** read from `clock()`. MAME throttles its frames on that counter,
and advancing it from the audio path would change the emulation being measured. An audio clock must
not be the game's clock.

`tools/gate-sound.mjs` checks the whole path — MAME's own `osd_play_sample`, through SEAL, into the
ring — against an expectation computed independently from SEAL's documented contract: 8-bit unsigned
centred on 128, volume 0..64, the cursor advancing freq/rate per output sample. Sample-exact. It has
to be a gate of its own because only two of MAME 0.1's five drivers have sound at all (pengo and
ladybug), so no amount of running Pac-Man would have exercised a line of it.

### Doom: /dev/dsp, where the program owns the mixing

`src/env/dsp.js` is the cheapest audio path in the project, and the contrast with SEAL is the point.
Doom mixes for itself — `I_UpdateSound` fills `signed short mixbuffer[]` at its own volumes and
stereo separation — and then submits it in one line:

    write(audio_fd, mixbuffer, SAMPLECOUNT*BUFMUL);

So there is no mixer to write. The device accepts bytes, answers six ioctls, and publishes. The one
subtlety is that an OSS ioctl takes a POINTER and the driver writes back the value it actually
granted; a program that asked for 44100 on a card that could only do 22050 is expected to notice.

`linux/soundcard.h` had every constant defined as **0** while it was a stub, which meant every ioctl
looked like every other one. They are distinct now, and PRISM supplies both the header and the
driver, so they are one thing in two places.

### Open: Doom's sound needs a second process

`linuxdoom-1.10/doomdef.h` line 84:

    #define SNDSERV  1

The Doom id published does not play sound itself. It starts a separate program —
`popen("./sndserver ", "w")` — and writes it one ASCII line per effect. That program is
`corpus/DOOM/sndserv/`, 2,026 lines, and IT is what opens /dev/dsp, reads the WAD and mixes.

It compiles and it works. `tools/sndserv.mjs` runs it alone, feeding it on stdin the exact bytes
Doom would have sent, and it produces 2.79 s of 16-bit stereo at 11025 Hz, peak 24576 — Doom's own
sound effect, mixed by Doom's own mixer, compiled unmodified.

What is missing is not audio, it is a **process model**: two address spaces and a scheduler. Working
around it would mean either defining away SNDSERV (a source modification) or writing Doom's mixer in
JavaScript (the thing this project exists not to do). Recorded in docs/ROADMAP.md as what it is.

Two compiler gaps fell out of compiling the server, both ordinary C89 that nothing else had needed:

* **`extern int errno;` at block scope, with no `#include <errno.h>` anywhere.** errno is an object
  in libc, not in a header, and a C89 program may declare it itself. It resolved to nothing and took
  out `myioctl`, the one function every ioctl goes through. PRISM's link step now defines it the way
  libc does.
* **`select()` on stdin.** The server's loop is a zero-timeout select on fd 0, which is what makes it
  cooperative rather than blocking. Implemented for fd 0, never blocking, and the timeout is ignored
  rather than honoured — there is one thread inside the guest, so a wait here would be a deadlock and
  not a wait. Every caller so far polls.


## The Csmith differential (P0.7)

```
node tools/csmith-diff.mjs 100            # 100 random programs against gcc -O0/-O2
node tools/csmith-diff.mjs --seed=3 --keep
```

Every other gate here is a corpus somebody wrote, and a corpus somebody wrote is finite in a shape a
person imagined. Csmith generates C at random -- a couple of thousand lines each, full of the integer
promotions, bitfield packing, type punning and struct-by-value passing that real code does by
accident -- and every program ends by printing a CRC over its whole global state. Two compilers that
agree on that number agree about everything the program touched.

**A divergence is not automatically a PRISM bug.** The first thing the tool checks is whether gcc
agrees with ITSELF at -O0 and -O2. A program where it does not is thrown out before PRISM sees it:
that is undefined behaviour csmith let through, or a gcc bug, and neither is evidence about PRISM.

### Reducing a divergence without a reducer

`creduce` is not installed and did not turn out to be needed. Three techniques, in the order they got
used on the first wrong answer:

1. **The per-variable CRC.** Run the program with argv `1` and csmith prints the running checksum
   after *every* global. The CRC is cumulative, so only the FIRST differing line matters -- the other
   332 were downstream. One variable, `g_76`, out of 378.
2. **Inverting the CRC.** The checksum before `g_76` matched, so the state going in was known.
   Brute-forcing all 256 values of an `int8_t` through csmith's own `transparent_crc` -- in the
   container, using csmith's code rather than a reimplementation -- says what each side actually
   held: gcc 0, PRISM 1.
3. **The block-path diff.** Csmith writes `/* block id: N */` on every basic block it emits. Adding
   `printf("B%d\n", N)` at each one, in the SAME modified program given to both compilers, turns
   execution into a comparable trace. First divergence: step 13 of 73, gcc entering block 156 where
   PRISM went to 161.

That is a printf-bisect between two compilers, and it took the search from 1,608 lines to one `if`.

### What it found in the first forty programs

Six defects, none of which 1,775 hand-written corpus programs and four game targets had reached:

* **An integer constant's type ignored its base.** C99 6.4.4.1 gives each constant the first type in
  a list that can represent it, and the list depends on the suffix *and* on whether the constant was
  written in decimal: a hexadecimal constant may become unsigned, a decimal one may not. So
  `0xAD2A1758533D8CC8LL` is larger than LLONG_MAX and is therefore an **unsigned** long long, which
  makes it positive. PRISM read it as a negative long long, `1UL < 0xAD2A1758533D8CC8LL` went the
  wrong way, a branch was skipped and one global ended the run holding 1 instead of 0. **This was the
  wrong answer.** The others below are refusals, which are loud; this one was silent.
* **`#pragma pack` did nothing.** The preprocessor passed pragmas through, as gcc -E does, and the
  parser then met a `#` it had no rule for. Implemented for real rather than skipped, because packing
  changes struct layout, which is the ABI: `pack(1)`, `pack(2)`, `push` and `pop` all match gcc.
* **Bitfields could not straddle a 32-bit unit.** The whole implementation assumed a field lived
  inside one word, which is true of every ordinary struct and false the moment `#pragma pack(1)`
  removes the alignment that guaranteed it. Now byte-wise: at most five bytes for a 32-bit field,
  assembled with multiplication because a JS shift is 32-bit and five bytes is 40.
* **`stdint.h` had no 64-bit half.** No `int64_t`, no `INT64_MAX`. Invisible to every hand-written
  test and all four games, which use `long long` directly; csmith names `int64_t` in its first
  hundred lines.
* **C99 hexadecimal floating constants.** `0x1.0p-100f` is 2^-100 exactly, which is why csmith's
  safe_math.h uses them for float overflow tests. PRISM's lexer had no rule, and the failure mode was
  the bad kind: `parseFloat` returns 0 for one rather than refusing.
* **The float math family.** `fabsf` and its fifteen siblings, declared as taking and returning
  `float` rather than double -- not cosmetic, since PRISM rounds a float store with `Math.fround` and
  a builtin declared in double would keep the extra precision through the call.
* **A record rvalue through a dereference.** `*p` on a struct or union pointer went down the scalar
  load path. The rule that a record rvalue IS its address was already applied at the two sibling
  sites and missing here.


### The refusals csmith left behind, and one that was a trap

Two causes accounted for every remaining PRISM failure in the first forty programs.

**Compound assignment to a bitfield** was refused outright. It is a read, an operation in the
*promoted* type, and a store back, and the promotion is the part that makes a bitfield different:
`unsigned f:3` promotes to `int`, so `f -= 1` on a zero field computes -1 in int and truncates to 7,
never to a three-bit borrow. `bitfieldPromoted` already encoded that rule, so the arithmetic just had
to happen there.

**`'comma' is not an lvalue`** looked like the two GNU extensions `(a, b) = x` and `(a = b) = c`, and
implementing those would have been wrong: gcc removed them years ago and **gcc 12 rejects both**, so
PRISM would have started accepting programs the reference refuses — a divergence in the one direction
no gate looks at. Checking with the oracle before implementing is what caught it.

What csmith actually writes is `(a, s).f` and `(s = t).f` on RECORDS, which is ordinary C. Neither
result is an lvalue; tier-0 simply needs an address for a record, for exactly the reason the
struct-valued `?:` beside it needed one. Restricted to records, it stays a tier-0 implementation
detail rather than a dialect — and the scalar forms are still refused, as gcc refuses them.


### The perf number no longer needs a ROM, and a lead on where the time goes

`tools/bench.mjs --synthetic` runs a Z80 program written in the tool instead of a game ROM. The
headline performance figure used to require copyrighted data, which meant it could not be reproduced
on a fresh clone -- and a gate nobody else can run is a claim, not a measurement. The synthetic
program is chosen to exercise what a real ROM exercises (memory read and write, 8- and 16-bit ALU
with flags, a taken branch, a call and a return), and both sides still print the same checksum, so
they demonstrably did identical work.

It is **not** comparable to the 9.5x measured on Pac-Man, and is published separately rather than
blended: same algorithm, different instruction mix.

```
4 M steps:  clang -O2 115.6 M instr/s · PRISM 5.2 M instr/s   → 22.2x
8 M steps:  ...                                               → 12.5x
```

That spread is itself information: half the gap at 4 M steps is JIT warm-up, not steady-state cost.
Any future claim about tier-1 has to be made at a workload long enough for that to have amortised.

**The V8 profiler is blind here**, and for the same structural reason both earlier profilers were:
the emitted code lives in an `eval`, so 98.3% of ticks are unattributed. What IS visible is
suggestive rather than conclusive, and worth recording as a lead rather than acted on: the largest
accounted entry is `Builtin: LoadIC` at 157 ticks -- more than `Z80_Execute` itself at 73. Every
cross-function call in the emitted code is `F["name"]` on an object with a thousand-odd properties,
which is a dictionary lookup, and there are 1,357 such sites in 516 kB of output.

If that is the cost, it is cheap to remove and needs no IR. But it also collides with something real:
every harness in `tools/` rebinds `prog.F` to instrument a program, and direct calls would make that
rebinding invisible. Measure before choosing -- the lesson of MIRAGE's three rejected memory-dispatch
strategies is that a plausible optimisation built without a number is a plausible optimisation
reverted.

**Measured.** `bench.mjs --synthetic --direct-calls` emits a call to the emitted function's own
identifier instead of `F["name"]`, for callees defined in the program:

```
F["name"]      7.16 · 7.02 · 6.29 M instr/s
direct call   17.36 · 16.98 · 12.79 M instr/s
```

Roughly **2 to 2.5x**, on identical checksums, from a change that touches one line of the emitter.
Against clang -O2 the gap goes from about 10x to about 5x. The lead was right, and the profiler's
one visible entry was worth more than the 98% it could not see.

It is still off by default, because the observability cost is real and there is a design that avoids
paying it: emit a module-scope `let` per function, initialised from the function, and have calls go
through that binding. A module-scope `let` is a monomorphic slot rather than a dictionary property,
so it should keep most of the speed, and a `rebind` on the module can reassign it -- which restores
exactly what the harnesses use `prog.F` for. Not built yet; recorded so the next person does not
re-derive it.


### Three Watcom accommodations, and the one I declined to make

Heretic and Hexen are Watcom C, and three constructs stood between PRISM and 118,000 lines of it.
Each is recorded here because the *restraint* is the interesting part.

**`__far`, `__near`, `__interrupt` as declaration specifiers.** Accepted and ignored, and that is
correct *only* because these games target the 32-bit flat model: with one segment, `__far` describes
nothing. They are emphatically not no-ops in a segmented program — Wolfenstein 3D uses `far` 451
times and means it — so this is a parser allowance, never an ABI claim. `__interrupt` really does
change a calling convention (save every register, return with IRET); ignoring it is safe only while
nothing installs such a function as a real handler, which nothing can, because PRISM has no interrupt
to deliver.

**The same keywords INSIDE a declarator.** Watcom puts them before the star:

    void (__interrupt __far *oldkeyboardisr)();          // Heretic, I_IBM.C:1282

Standard C has no place for a qualifier there. Two changes, and the second was the one that mattered:
skipping them in `#declarator`, and teaching `#parenIsParamList` that a Watcom keyword after `(` does
**not** start a parameter list. Without the second, the paren was read as a parameter list precisely
*because* the first change had made them keywords, and the error moved to the `(` — a fix creating a
worse symptom than the bug.

**Bare `far` / `near` — declined as keywords.** `int (far *function)();` appears once in 47,000
lines. Making `far` and `near` keywords everywhere would break any program with a variable of that
name, for one construct. Recognised only where nothing else can be meant: inside a declarator,
immediately before a star. A dialect is a cost paid by every future program, so it should be bought
one construct at a time.


### Brace elision, and a rewrite that had to be undone

Heretic writes its tables the way most C does:

    struct { mobjtype_t type; int speed[2]; } MonsterMissileInfo[] = {
        { MT_IMPBALL, 10, 20 },        // speed[] takes the 10 and the 20, with no braces of its own

That is brace elision (C89 6.7.8p17), and tier-0 refused it: the bare `10` was handed to `int[2]`.

**The first attempt rewrote `#staticList` as a clean stream** — items consumed by whoever needs
them, no one-to-one matching. It was shorter, it read better, and it broke three things the
one-to-one version had right, all of which the c-testsuite gate caught as **wrong answers where
there had been none**: designators that go backwards (`{ .b = 2, .a = 1 }` lost the `.a`, because the
loop was bounded by the member cursor), array designators with holes, and flattened anonymous unions.

Worse than any single break: two programs went from *refused* to *compiled and wrong*. A loud failure
became a silent one, which is the only direction that actually matters.

So the rewrite was thrown away and elision was grafted onto the proven walk instead — one extra
branch, taken only when an aggregate member meets a non-braced item. The lesson is not "do not
refactor": it is that a rewrite of code whose correctness lives in its edge cases must be measured
against those edge cases before it is believed, and the cheapest way to be wrong is to find the new
version more elegant.

Two further defects fell out of it, both only visible once elision made the programs compile:

* **`sizeof(a->c)` where `a` is an array.** `->` decays its left operand, and PRISM did not — so the
  field was never found and the member's type silently became `int`. `sizeof(cases->c)` answered 4
  instead of 32, and a loop over a four-element array ran once.
* **The array's LENGTH ignored elision.** `initListExtent` counted top-level items, so ten
  seven-field structs written as seventy bare scalars became a 63-element array. The contents were
  byte-identical to gcc and the program still printed 505 lines to gcc's 72. The counter and
  `#elidable` now make the same syntactic decisions and say so in both files: two walkers, one rule.

c-testsuite: 199 → **201 of 219, still zero wrong answers.**


### Heretic and Hexen: reading the makefile, and two options that change the program

```
node tools/raven.mjs --game=heretic
node tools/raven.mjs --game=hexen --run --data=<dir with the WAD>
```

The unit list comes from each game's own **makefile**, not from a directory listing, and that is not
tidiness. Both trees carry dead files — `NETOLD.C`, `OLDD_NET.C`, `G_OLD.C` — that no build has
compiled since 1995 and that do not compile at all. Reading the makefile is the difference between
"the program does not build" and "a backup file does not build", and the first report was the second
thing.

It also has to read the whole file, not just the `LOCOBJS`/`GLOBOBJS` variables, because Heretic's
link rule is

    tic.exe : $(LOCOBJS) $(GLOBOBJS) i_ibm.obj

and `i_ibm.obj` — the one file holding every machine dependency, and `main` — is named nowhere else.
Missing it produced 47 "undeclared identifier" failures that looked like a header problem.

Two options in `CCOPTS` change the program and are honoured:

* **`/zp1`**, pack structures on byte boundaries. Every struct in the program changes size, so
  nothing read out of a WAD lands in the right field without it. `compileProgram` takes a `pack`
  option that seeds the same state `#pragma pack` sets — a compiler option, not a source edit, the
  same standing as MAME's missing `-DX86_ASM`.
* **`/ei`**, enums are int, which is already PRISM's model.

### What a DOS platform actually costs

`I_IBM.C` is 2,204 lines and the roadmap expected it to need VGA register emulation and interrupt
delivery. Measured first, as with Wolf3D, and both expectations were wrong in the same direction:

    int386(0x10, ax=0x13);                       // set mode 13h
    pcscreen = destscreen = (byte *)0xa0000;     // ...and then write to a FLAT pointer

Mode 13h is a linear framebuffer at an address PRISM already has, because the low megabyte is part
of the image. Everything the game draws is an ordinary store. The whole external surface is:
`int386`/`int386x`/`segread` over a `union REGS`, the interrupt vector table, two DPMI calls
(memory info and allocate), the `graph.h` banner, and DMX for sound — plus four ports, of which
0x3DA (retrace) and 0x201 (joystick) are reads and the rest are page-flip plumbing for a mode this
host does not emulate.

`union REGS` is the piece worth care: Watcom's is three views of the SAME sixteen bytes (`x.eax`,
`w.ax`, `h.al`), and I_IBM.C uses all three on one variable in consecutive statements. The header and
the shim read the same offsets from opposite sides.

**And the interrupt is deliverable.** `_dos_setvect(9, isr)` hands over a function pointer, and PRISM
can call it — `I_KeyboardISR` then reads port 0x60 and fills the game's own ring buffer, running its
own code. That is the mechanism, wired but not yet driven.

Four small libc gaps fell out, all found by compiling rather than by guessing: `strtol`/`strtoul`
(with `endptr`, without which a parse loop never advances), `strnicmp`, `strupr`, and `FP_OFF`/
`FP_SEG` as flat-model identities.


### Two libc bugs Hexen found, and why gcc beat the standard

Hexen would not start, and neither cause was in the game.

**`scanf` had no scansets.** `%[^\n]`, `%[a-z]`, `%[]x]` — Hexen's `SC_MAN.C` reads its scripts with
them. Three rules that formats really use and that are easy to get wrong: a leading `^` negates, a
`]` in the FIRST position is a literal rather than the end, and `a-z` is a range unless the `-` is
first or last. `%c` came with it, and both share the property that separates them from every other
conversion: **they do not skip leading whitespace**, because they are the two that can match it.

Fixing them exposed an older one. A single permissive character set served every numeric conversion,
so `%d` accepted hex digits: `sscanf("abc123def", "%[^0-9]%d%[a-z]")` read `123def` as its integer
and the third conversion found nothing left. Each conversion now has its own set.

**`strtol` mis-read a lone zero.** With base 0 it consumed the leading `0` as an octal PREFIX and
then looked for digits, found none, and reported no conversion — leaving `endptr` at the start, which
is exactly the check every caller makes:

    sc_Number = strtol(sc_String, &stopper, 0);
    if (*stopper != 0) I_Error("SC_GetNumber: Bad numeric constant \"%s\"", sc_String);

Hexen refused its own SNDINFO script at the first zero. The zero is never consumed as a prefix now;
base 8 is selected and the digit loop takes it. `"0x"` with no hex digit after it is likewise the
number 0 with `endptr` at the `x`.

**And one place the standard was the wrong reference.** C99 says a `%c` that reads fewer characters
than its field width is a matching failure. glibc assigns what it got: `sscanf("abc", "%2s%2c", a, c)`
returns 2, not 1. PRISM followed the standard and disagreed with the oracle — and the oracle is what
every gate here compares against, so the oracle wins. Ten `strtol` cases and six `sscanf` cases now
match gcc exactly, character for character.


### The third device, and why the keyboard is not a device problem

```
node tools/raven.mjs --game=heretic --run --safepoints --tick=1 --budget=5000 \
     --keys=esc,down,down,enter --data=<dir with the WAD>
```

`src/env/kbd8042.js` is ports 0x60 and 0x64 and about forty lines, because almost nothing about a
DOS keyboard happens in the controller. The game installs an interrupt handler and the handler reads
one byte:

    void __interrupt I_KeyboardISR (void) {                     // Heretic, I_IBM.C
        keyboardque[kbdhead & (KBDQUESIZE-1)] = lastpress = _inbyte(0x60);
        kbdhead++;
        _outbyte(0x20, 0x20);
    }

So the host's job is two halves that must meet: put a code where 0x60 will read it, and CALL the
handler. Either alone is silent — a code with no interrupt is never read, an interrupt with no code
makes the game read the previous one again — which is why `deliverKeyboard` does both and neither is
exposed separately.

Two decisions worth naming. An empty queue returns the LAST code rather than zero, because a real
controller holds its output buffer and 0 is a meaningful set-1 code (overrun) that some handlers act
on: inventing one is worse than repeating the truth. And a keypress is TWO interrupts, the code and
the code with bit 7 set, because that is what the hardware sends and what the game's release
detection needs.

PRISM never touches `keyboardque`. Escape opens the menu, Down/Down/Enter reaches the load/save
submenu, and every one of those transitions happened inside the game's own code.


### A task retracted rather than done: P0.3b

The preprocessor expands macros by rewriting its work list in place with `splice()`, which is
quadratic when a macro grows the list. The roadmap entry said so — and also said **do not start this
before measuring it**, because the premise was an asymptotic argument with no number attached.

Measured, by counting the elements every splice actually moves and timing them:

```
Doom      62 units ·  587k tokens · 721 ms total ·  2 ms in splice (0.3%) ·  14.1M moved,  24x tokens
Hexen     56 units · 1203k tokens · 613 ms total · 49 ms in splice (8.0%) · 133.6M moved, 111x tokens
Heretic   48 units ·  701k tokens · 319 ms total ·  4 ms in splice (1.1%) ·  28.3M moved,  40x tokens
```

The quadratic behaviour is real and it scales exactly as predicted — 111x the token count on the
largest tree. And it does not matter: `splice` on a contiguous array is a memmove, and moving 133
million pointers costs 49 ms. Preprocessing is about 0.6 s of a 2.2 s build, so the whole opportunity
is under 1% of a build.

Retracted. The value here is not the millisecond saved by not doing it; it is that an asymptotic
argument with no constant factor attached is a hypothesis, and this is the second time in this
project one has evaporated on contact with a measurement (the first was MIRAGE's D6). The instinct
to fix a known-quadratic loop is strong enough that the entry had to warn its own author.


## The cpp gate on whole files (P0.3c)

```
node tools/gate-cpp-files.mjs [--limit=N] [--verbose] [filter]
```

**289 of 289 whole translation units from five programs match `gcc -E` token for token** — with
`--limit=200`, because the default caps each program at 8 files and compares 36. Doom,
Heretic, Hexen, MAME 0.5 and Quake — real units, real include paths, thousands of macros deep.

`tools/gate-cpp.mjs` compares self-contained snippets on purpose: it tests the preprocessor and
nothing else. This tests it on what it is actually asked to do, and the whole difficulty is making
the comparison mean anything, which comes down to one thing: **gcc must be given PRISM's headers, not
its own.** Otherwise the diff is glibc's `stdio.h` against PRISM's and says nothing. So the headers
are written to disk, gcc runs with `-nostdinc` and `-undef`, and PRISM's TARGET_DEFINES are handed to
it as a prelude header — both sides then start from the same text and the same macro table, and every
difference left is a preprocessing difference.

### What it found on its first run

**`__FILE__` and `__LINE__` inside a macro reported the DEFINITION site, not the expansion site.**

    #define WHERE() __FILE__, __LINE__      // in h.h
    ...
    use(WHERE());                           // in m.c, line 3

gcc says `"m.c", 3`. PRISM said `"h.h", 1`. Every `LOG(...)`, `assert(...)` or `I_Error(...)` macro
that lives in a header — which is all of them — named the wrong place. The fix is one clause: a
macro's replacement tokens take the INVOCATION's location, which is what gcc does and what also makes
an error inside an expansion point at the line the user wrote.

### Three harness bugs, each of which looked like a result

Worth recording because each produced a plausible-looking number that was wrong:

* **`.C` in upper case is C++ to gcc.** Heretic and Hexen name their sources that way, so every one of
  their units was "skipped: gcc refused them" with a puzzling `cannot execute cc1plus`. `-x c` took
  the pass rate from 20/20 with 16 skipped to 36/36 with none.
* **A missing newline swallowed a case.** gcc's output does not always end in one, so the `===RC`
  marker glued itself to the last line, the regex missed it, and the case vanished as "no oracle
  output" — which reads like a missing result rather than a harness bug.
* **A skipped case is not a passing case.** Half the corpus was unusable because gcc refuses a unit
  outright when a header is missing, where PRISM stubs it empty. Writing the same empty file where
  gcc will find it makes both sides read the same nothing; 33 headers are stubbed that way, and they
  are listed on every run rather than counted.

The rule underneath all three: a gate that reports 20/20 while quietly discarding 16 cases is
reporting the harness, not the compiler.


## Two processes (P1.8)

```
node tools/doomsnd.mjs --data=<dir with DOOM1.WAD> --inject=1a,20,7f,80 --wav=/tmp/doom.wav
```

Doom runs in this thread, `corpus/DOOM/sndserv/` runs in a worker, and they are connected by
`src/env/pipe.js`. Neither program is modified and neither is interleaved.

**A worker rather than a coroutine, because neither `main` ever returns.** Doom spins in
`D_DoomLoop`, the server in `while (!done)`. Interleaving them would mean calling their internals
instead of running them — writing the part of the program that decides what to do next — which is the
one thing this project does not do. Two threads and a shared ring cost nothing conceptually and the
programs stay whole.

Two details of the pipe come straight from the two programs. It carries **bytes, not messages**: the
writer is `fprintf(sndserver, "p%2.2x%2.2x%2.2x%2.2x\n", …)` and the reader is `read(0, buf, 1)` then
`read(0, buf, 9)`, and neither knows where the other's writes ended. And `pending` is separate from
`read` because the reader **polls** — a zero-timeout `select` on fd 0 must be able to ask without
consuming.

`popen` does not start anything. The caller has already started the other program; `popen` matches a
command line to it and returns a FILE* whose writes go into the pipe. It also answers the check Doom
makes first:

    if (!access(buffer, X_OK)) { strcat(buffer, " -quiet"); sndserver = popen(buffer, "w"); }
    else fprintf(stderr, "Could not start sound server [%s]\n", buffer);

Without that, the else branch ran and the pipe was never created — a silent, correct-looking "no
sound server" for a host that had one running in another thread.

### The missing piece was a clock

With everything connected the result was still silence, and the counters said why: **400,000 samples
dropped in four hundred submits.** A game has a clock — it throttles itself to its own frame rate —
and a sound server has none. It free-ran at whatever speed the host could manage, filled the ring
instantly, and everything after the first 16k samples was thrown away, the sound effect among it.

So `installDsp` gained `blockWhenFull`, and it is not a workaround: `write()` to a real `/dev/dsp`
blocks until the card has room. **The DAC is what paces a sound server.** Supplying that pacing is
supplying the clock the program was written to run on. Dropping remains the default, because for a
game it is right — a program that cannot keep up should sound rough, not run rough.

With it: peak 24576, nothing dropped, and the effect audible in the WAV.

### Isolating the halves

Getting there needed `--inject`, which writes one command straight into the pipe in Doom's own
format. It separates "the pipe and the second process work" from "Doom asked for a sound", and those
two failures look identical from a silent WAV. They were tested together at first, and the silence
was read as a broken pipe for two rounds.

What is still missing is only the trigger: with `-warp 1 1` and no input Doom stands still, and the
shareware WAD's demos will not play (`Demo is from a different game version!`).


### Quake times itself: 694 fps

```
node tools/quake.mjs --dos --run --data=<dir> --args="-mem 16 +timedemo demo1" \
     --frames=1400 --keys=space --png=/tmp/q.png
```

`969 FRAMES  1.4 SECONDS  694.2 FPS`, printed by Quake on its own console.

The number could not exist before the DOS build. `sys_null.c`'s `Sys_FloatTime` returns `t += 0.1` —
a counter, not a clock — so everything the program measured about itself, timedemo included, was
fiction, and only a wall clock outside it meant anything. `sys_dos.c` reads a real PIT, so this is
Quake's own measurement of Quake.

Two things about getting it, both of which cost a run:

* **Quake waits for a keypress at start-up** (`Press a key.` under the MSCDEX notice), so a
  `+timedemo` on the command line sits behind it. One `space` through the game's own TrapKey moves
  it along.
* **The result is on the CONSOLE, not on stdout.** `Con_Printf` draws to the framebuffer. Grepping
  the log for "fps" found nothing twice while the answer was sitting in the PNG.

It is also the second real workload for P2.1, and the first that is a whole game rather than a CPU
core: optimising against one workload is the surest way to optimise *that workload*.

### Any target, from its JSON alone

```
node tools/build.mjs --list
node tools/build.mjs quake.json:dos
node tools/build.mjs heretic.json --run --data=<dir>
```

The check that made this trustworthy was not that it builds, it is that it builds the SAME thing:

| target | hand-written harness | `tools/build.mjs` |
|---|---|---|
| quake:dos | 77 units, 51,391 lines, 1169 fns, 2 headers stubbed | identical |
| heretic | 44 + 1 units, 43,394 lines, 761 fns | identical |
| mame01 | 19 units, 6,859 lines, 913 fns | identical |
| doom | 715 fns | identical |

A target describes the BUILD and the ENVIRONMENT. It does not describe instrumentation — Quake's
frame cap and key script, Doom's fire trigger, the audio drain wrap the program's own functions to
watch it run, and putting those in JSON would be game logic in a config file.

### Quake II compiles

```
node tools/build.mjs quake2.json
```

61 translation units, 49,653 lines, 1121 functions, **nothing unemitted**. It took six libc
additions and one platform variable, and not one compiler change:

* `strdup`, `strncat`, `strtok`, `qsort`, `asin`/`acos`, `putenv`. `qsort` is the only one with any
  depth — the comparator is the GUEST's, so every comparison is an indirect call back into compiled
  code and the elements are bytes in the heap. Sorting an index array and permuting keeps that
  honest; JS's own sort gives no access to the swap.
* `in_joystick`, which `linux/in_linux.c:6` and `win32/in_win.c:55` both define and id's own null
  platform does not.

`C_ONLY` is id's own switch and a cleaner one than Quake 1's: `q_shared.h:42` reads
`#if (defined _M_IX86 || defined __i386__) && !defined C_ONLY`, so defining it selects the portable
C body of every routine with an assembly twin. A build option, not a source edit.

It does not RUN yet, and the reason is worth reading: see ROADMAP P7.3.

### Quake II reaches its own data check

```
node tools/build.mjs quake2.json
```

62 units, 50,194 lines, 1144 functions, nothing unemitted — and it now RUNS to
`Couldn't load pics/colormap.pcx`, which is the right place for a run with no game data. On the way
it prints `Console initialized.`, initialises the network layer, and crosses into
`ref_soft$GetRefAPI`.

Three things had to be true, and each is the program's own statement rather than a decision made
here:

* **Modules.** Quake II is three shared objects, so it is three modules. Each keeps its own external
  namespace and sees the main module's for what it does not define; only what its `.def` file
  EXPORTS travels the other way. `dlopen` turned out to be unnecessary — `null/vid_null.c` is
  titled DIRECT LINK GLUE and calls `GetRefAPI` in process.
* **`linux/net_udp.c`, not a hand-written null layer.** `null/` has no network stub (Quake 1 shipped
  `net_none.c`; Quake II did not), and single player runs on a loopback that lives INSIDE the
  platform file. The loopback path touches no socket, so the program's own file with the OS calls
  stubbed is both the faithful and the shorter answer.
* Two platform variables id's own null platform omits: `in_joystick` and `stdin_active`.

Nothing here is visible without a hook, because `null/sys_null.c`'s `Sys_ConsoleOutput` is empty.
Wrapping `M.rt.vsprintf` shows every message the program formats — which is how the colormap error
was read at all.

### OpenDUNE compiles

```
node tools/build.mjs opendune.json
```

84 units, 46,169 lines, 834 functions, 11 unemitted. It is a REIMPLEMENTATION, so it proves PRISM
handles a large modern-C DOS program — not that it runs unmodified 1990s source the way Quake,
Heretic and MAME do.

Four PRISM gaps surfaced, each small and each worth the trip:

* **`<sys/types.h>` lost to a basename match.** The resolver's basename fallback exists for DOS trees
  that write `sys\types.h`; running it before the standard table made `<sys/types.h>` find OpenDUNE's
  own `include/types.h`, so `ssize_t` was never declared and PRISM's `unistd.h` failed to parse. A
  tree header may shadow a standard one when the program asks for it BY THAT NAME, never by accident
  of its basename.
* **`_loadds` and a bare `far` before an identifier** — `void _loadds far mouse_handler(...)`. PRISM
  already ignored `__loadds` and accepted `far` before a star.
* **A pragma inside a function body**, which the mouse callback opens with. Only file scope knew to
  skip one.
* **`&((c *)8)->m`** — `saveload.h:29`'s hand-rolled offsetof, base 8 to keep a null-dereference
  warning quiet. Refusing it refused every save/load table in the program.

And one regression, caught by the gate and not by reading: skipping pragmas in a body turned
c-testsuite 00206 from a REFUSAL into a WRONG ANSWER, because `#pragma push_macro`/`pop_macro` were
being silently discarded. They are preprocessor pragmas and now never reach the parser — a stack per
macro name, with the operand read from the raw tokens, which is what that test checks by defining
macros called `push_macro` and `pop_macro` first. 201 → **202/219, still zero wrong answers**.

### Quake II's data, and how far it gets on it

The data is id's own freely distributed demo. It is never fetched by a tool here and never enters
the repository — like every other target, it is read from a directory the user names:

```
curl -o q2-314-demo-x86.exe \
  https://ftp.gwdg.de/pub/misc/ftp.idsoftware.com/idstuff/quake2/q2-314-demo-x86.exe
unzip -qo q2-314-demo-x86.exe 'Install/Data/baseq2/*' && mv Install/Data/baseq2 .
```

39,015,499 bytes, sha1 `5b4dedc59ceee306956a3e48a8bdf6dd33bc91ed`. It is a plain zip, and
`baseq2/pak0.pak` is 49,951,322 bytes holding 1106 files.

With it, Quake II gets a long way:

```
> Added packfile ./baseq2/pak0.pak (1106 files)
> execing default.cfg
> Console initialized.
> 768k surface cache
> ref_soft version: SOFT 0.01
> failed to load game DLL
```

The renderer initialises. What stops it is the THIRD module. `null/sys_null.c:37` has
`Sys_GetGameAPI` return NULL, and the demo's own `default.cfg` starts a demo map immediately, so
`SV_DemoMap_f → SV_Map → SV_InitGame → SV_InitGameProgs` wants the game DLL at start-up rather than
only when a map loads.

Unlike the refresh, the game has no direct-link glue anywhere in the tree: `linux/sys_linux.c:196`
dlopens `gamei386.so` and dlsyms `GetGameAPI`. So the `dlopen` that P7.3 turned out not to need for
`ref_soft` is exactly what `game/` does need — over PRISM's own symbol table, where
`game$GetGameAPI` already has an address.

### Quake II initialises and plays its demo

```
node tools/build.mjs quake2.json          # 109 units, 87,098 lines, 2120 functions
```

With `~/quake2/baseq2` as its data it reaches, in its own words:

```
> Added packfile ./baseq2/pak0.pak (1106 files)
> ref_soft version: SOFT 0.01
> ====== Quake2 Initialized ======
> 0.0.0.0:0: client_connect
> Player\male/grunt
> demos/q2demo1.dm2
> Installation
```

Three modules, each with its own namespace, bridged exactly where the program bridges them: the
refresh through `GetRefAPI` (direct-link glue), the game through `dlopen`/`dlsym`.

`src/env/dl.js` is the piece that made the game reachable, and it loads nothing — everything is
already linked. `dlopen` names a module and `dlsym` returns the address of the linkage name pass 1
gave it, `game$GetGameAPI`. The soname it matches on is `gamei386.so`, which the target takes from
`linux/Makefile.i386` and `sys_linux.c` asks for by that exact string.

**It does not draw, and that was verified rather than assumed:** `vid.buffer` is 0 after 13 frames.
`null/swimp_null.c` is a file of empty bodies whose `SWimp_SetMode` returns nothing at all, so
ref_soft never gets a surface. Every real refresh implementation allocates one — `linux/rw_x11.c`
with `XCreateImage`, over the Xlib PRISM already has for Doom.

### Quake II renders

```
node tools/quake2.mjs --data=<dir with baseq2/> --frames=120 --png=/tmp/q2.png
```

320x240, 76,800 of 76,800 pixels non-zero, **177 distinct colours**, ~144 frames/s on the demo — the
Installation level with the HUD reading health 92 and ammo 20.

`linux/rw_x11.c` is what gives ref_soft a surface at all: `null/swimp_null.c`'s `SWimp_SetMode`
returns nothing whatsoever, so `vid.buffer` stayed 0 and every draw went to low memory. It cost four
Xlib entry points Doom never used (`XGetVisualInfo`, `XDefaultVisual`, `XDestroyWindow`,
`XFreeColormap`), 21 keysyms, a `Visual` with its colour masks, `XConfigureEvent`, and
`struct sigaction` — which rw_x11.c fetches, edits and installs back so Ctrl-C can restore keyboard
auto-repeat, so a fetch returning garbage would have installed garbage.

But the thing standing between a blank buffer and a picture was none of those. It was **anonymous
`mmap`**, which PRISM returned -1 for on principle:

```
> unable to virtual allocate 16777216 bytes
```

`Hunk_Begin` (`linux/q_shlinux.c:20`) reserves 16 MB with `MAP_PRIVATE|MAP_ANONYMOUS` and calls
`Sys_Error` when it comes back -1. A FILE mapping still fails — the file layer has no address for a
file's contents to live at, and a caller that gets -1 for one has a `read()` path to fall back on,
which is the path SQLite takes. `mremap` returns the same base because `Hunk_End` requires it
(`if (n != membase) Sys_Error`), so the unused tail simply stays allocated.

The picture is the renderer's own output, read from `ref_soft$vid.buffer` before the platform does
anything with it, with the palette from `sw_state.currentpalette`.

### OpenDUNE runs to its data check

```
node tools/opendune.mjs [--data=<dir holding DATA/>] --frames=200 --png=/tmp/od.png
```

```
OpenDUNE — 84 units, 46,169 lines, 834 functions
opendune.ini file not found.
Cannot initialise files. Does DATA\ directory exist ?
```

That is Dune II's own data, which this project does not fetch.

One thing about the harness is worth keeping: `src/os/error.c`'s `Error`/`Warning`/`Debug` go to
stderr through **`vfprintf`**, not through `vsprintf`. Hooking the formatter — which is what showed
every message Quake II printed — showed nothing here, and made a program that had exited *with a
message* look like one that had exited in silence. Hooking `M.write` is what a program using the
FILE layer needs.

Behind the data, two things, both read out of the source rather than guessed:

* `get_bios_keyboard_status` is a `#pragma aux` with an assembly **body** — INT 16h AH=11h, then
  AH=10h — not a calling convention. So it is declared and never defined (`program.F` has no entry
  for it) while `Video_Tick` calls it inside a `for(;;)`. Same slot as the Watcom `FixedMul` and
  `FixedDiv2` already transcribed for Heretic.
* `Video_Init` refuses to start without a mouse: `int386(0x33)` with AX=0 must answer 0xFFFF or it
  `Error`s and returns false, and it then installs a real-mode callback with AX=0x0C. Dune II is
  mouse-driven, so supplying a mouse is supplying a device — the same as the DAC and the 8042.

### What a build now tells you before you run it

```
node tools/build.mjs quake.json:dos
```

Three lines that did not exist, and each was earned by a bug that cost real time:

```
  7 symbols declared and called but NEVER DEFINED (they fail when called):
    getch                            called from vregset.c
    GUS_Init                         called from snd_dos.c
    VGA_UpdatePlanarScreen           called from vid_vga.c
  assembly: 21 files export 126 symbols; 1 of them are still undefined here:
    VGA_UpdatePlanarScreen       d_copy.s
```

* **Undefined symbols.** A linker names them. PRISM used to swallow them, so a call to a declared-
  and-never-defined name compiled and then threw as `F.name is not a function` — which is how
  OpenDUNE's `get_bios_keyboard_status` was found, after the build had reported "nothing unemitted".
* **The assembly cross-reference.** 298 exported symbols across the corpus, exactly one still
  missing. That is the id386=0 thesis — the source ships its own C fallback — measured instead of
  assumed, and it says an assembler would buy nothing for six of seven targets.

### Compiling a `#pragma aux`, checked against a hand transcription

The three routines with assembly bodies were all transcribed by hand before the compiler existed, so
they are its oracle. The same program, with the pragmas and without:

```
FixedMul(65536,65536)=65536   FixedDiv2(65536,131072)=32768   hash=2223268735
```

169 multiplications and 156 divisions over negative operands and INT_MAX, identical either way. And
OpenDUNE's intro renders the same 37,405 pixels in the same 62 colours as it did from the
hand-written C, which is why `tools/opendune-dos-vars.c` no longer exists.

## The cross-platform pixel gate

```
node tools/gate-pixels.mjs --data=<dir with id1/> [--frames=60] [--png=/tmp/gp]

  x11@320x200  320x200, 129 colours, 60 world frames of 70 presented
  dos          320x200, 129 colours, 60 world frames of 70 presented
  x11@320x240  320x240, 130 colours, 60 world frames of 70 presented
  win          320x240, 131 colours, 60 world frames of 186 presented

  x11@320x200 == dos   identical, 64000 pixels and 768 palette bytes
```

Quake's DOS, X11 and Win32 builds share every line of the renderer. What differs is the platform
layer -- how a frame is presented, where the palette goes, which clock the game reads -- and all of
that is PRISM's code, not id's. So the same demo at the same point must produce the same pixels, and
any difference is this project's, somewhere a frame counter and an fps figure cannot see. It cost
nothing to build because the three targets already existed, and it would have caught the WinQuake
palette being four times too bright.

**Four things had to be right before the comparison meant anything**, and the first run got each of
them wrong in a way that produced a confident, useless number.

`+host_framerate` pins the frame time. `Sys_FloatTime` reads the real clock on every platform, so
without it frame N lands wherever N rendered frames get to and depends on how fast the machine is
going -- which is how an earlier capture of mine disagreed with a later one for no reason at all.

**Count frames of the WORLD, not presented frames.** At frame 120 the Win32 build was still showing
its console: it prints more start-up lines than the others and presents every one of them, so the
three were being compared at different moments in the program (186 presented frames to the others'
70, for the same 60 frames of game). `R_RenderView` is engine code, shared by all three, and runs
only when the 3D view is drawn. It also needs no struct offsets, which is the other reason to prefer
it to reading `cls.demoplayback`.

`-nocdaudio`, because the DOS build otherwise stops on "Press a key" when MSCDEX is absent. Waiting
there is correct behaviour and would simply never reach the demo.

**Compare palettes at six bits, and know which side is already scaled.** The DAC holds six bits per
component and `vid_dos.c` shifts Quake's values down by two on the way in -- but `src/env/vgadac.js`
stores `(v & 0x3f) << 2`, putting them back. Scaling again in the gate was a second multiply nobody
asked for, and it left 678 of 768 palette bytes "differing" between two builds that had set identical
colours. (`installVgaDac`'s result is now reachable as `M.dac`, the way the keyboard controller is
`M.kbd`; a harness had nowhere else to ask.)

**What it asserts, and what it only measures.** `x11 == dos` is asserted and holds exactly: 64,000
pixels and 768 palette bytes, identical. `x11 vs win` differs by about 2% of pixels -- a scatter of
one to three per row across 120 rows -- and is printed but NOT asserted, because I have not found out
why and a tolerance invented to make it pass would be a check that cannot fail.

What is known about that 2%: the palettes are byte-identical, both builds consume the PRNG identically
(3 `rand()` calls before the first world frame, 66 by frame 60), and both size their surface cache
through the same `D_SurfaceCacheForRes(320, 240)`. Two hypotheses measured, two refuted. The number is
printed every run, so a change in it is visible.

**Why not all three at one size.** WinQuake's windowed mode list is written into the game's own source
(`vid_win.c:647`): 320x240, 640x480, 800x600. What MGL supplies -- and therefore what
`src/env/mgl.c` controls -- is the FULLSCREEN list, which this build returns empty. So a 320x200
Win32 picture is reachable, but through `MGL_createDisplayDC` and the fullscreen path, not by asking
for a windowed size the game does not offer. X11 is the pivot instead: it honours `-width`/`-height`
(`vid_x.c:501`), so it is run twice and each other platform is compared against the run that matches
it.

### All three at 320x200, and how WinQuake chooses a windowed size

I was wrong to say WinQuake has no 320x200 windowed mode. Its list looks fixed -- 320x240, 640x480,
800x600, written into `vid_win.c:647` -- but `modelist[2]` is **MODE_SETTABLE_WINDOW**, and
`VID_CheckModedescFixup` (`vid_win.c:1031`) rebuilds it from two archived cvars every time it is
selected:

```c
if (vid_config_x.value < (320 << stretch)) vid_config_x.value = 320 << stretch;
if (vid_config_y.value < (200 << stretch)) vid_config_y.value = 200 << stretch;
```

The floor is exactly 320x200. So the game's own way of asking for that size is

```
+vid_stretch_by_2 0 +vid_config_x 320 +vid_config_y 200 +vid_mode 2
```

and no MGL fullscreen mode had to be invented for it. In the real game the player never types that:
`vid_config_x` and `vid_config_y` are archived cvars (`true` in their declaration, so they are saved
to config.cfg), and the video menu's "settable window" entry is what edits them -- Options → Video,
where the width and height are adjusted with the arrow keys and applied by selecting that mode.
`vid_mode` then records the choice.

With all three at one size the gate compares them directly, and the answer changed the question:

```
x11 == dos   identical, 64000 pixels and 768 palette bytes
x11 != win   differ: 1219 of 64000 pixels, 0/768 palette bytes
```

The size was never the cause. What is now known about the 1219: every one is the same change, x11
holding index 0 where win holds 48 and never the reverse; they are inside the 3D view only; 832 of
them were already 48 the frame before, so it is a persistent set that drifts slowly; and since X11 and
DOS agree exactly, **win is the outlier** -- two independent platform layers produce the 0.

Four hypotheses measured and refuted, which is worth recording because each looked plausible:

| hypothesis | measurement |
|---|---|
| a phase offset | frame 60 is thirty times closer than 59 or 61 |
| a PRNG divergence | 3 `rand()` calls before the first world frame, 66 by frame 60, on both |
| a differing surface cache | same `D_SurfaceCacheForRes(320, 200)`, same 284 `R_DrawSurface`, 3046 `D_CacheSurface` |
| `vid.numpages` | `vid_x.c:455` sets 2 and `vid_win.c:1353` sets 1 -- but `vid_vga.c:365` sets 1 for DOS too, and DOS matches X11 exactly |

One method note. An early count said `D_DrawParticle` ran 0 times while `R_DrawParticles` ran 60:
PRISM emits DIRECT calls, so wrapping `program.F[name]` does not intercept a call made from another
compiled function unless the rebinder reaches it. Numbers taken that way have to be checked against a
function that is definitely being intercepted before they mean anything.

### Tracing the three platforms against each other

```
node tools/trace-platforms.mjs --data=<dir> --frames=60 --trace=SCR_UpdateScreen,VID_Update

  x11 vs dos: 47/61 world frames agree, differing at 0-13
  x11 vs win:  0/61 world frames agree, differing at 0-60
      at frame 60: SCR_UpdateScreen  x11=73  win=78
      at frame 60: VID_Update        x11=70  win=74
  dos vs win:  0/61 world frames agree
      at frame 60: VID_Update        dos=70  win=74
```

`gate-pixels.mjs` says WHETHER the pictures agree; this says WHERE they stop, which is the question
you have once they do not. The signature per frame is a checksum of the framebuffer plus the call
counts of whatever was named, matched by WORLD frame rather than by position.

**"First divergence" was the wrong statistic** and the first version reported it. Every pair differed
at world frame 0 -- including x11 and dos, which `gate-pixels` proves identical at frame 60 -- because
the console screens before the demo are drawn at different rates and legitimately disagree. Two
platforms can differ early and CONVERGE. The run of frames where they agree is what says something,
and it says x11 and dos settle down at frame 14 and never disagree again.

**The tool marks its own blind spot.** PRISM emits direct calls, so wrapping `program.F[name]` does
not intercept a call made from another compiled function. `R_DrawSurface`, `D_CacheSurface` and
`R_DrawParticles` all report 0 on every platform, which means "not intercepted", not "not called" --
and an earlier hunt of mine drew a conclusion from exactly that reading. Anything reported as 0 on
every platform is flagged in the output rather than left to be misread.

**What it found.** win runs `VID_Update` 74 times and `SCR_UpdateScreen` 78 times for the same 60
world frames, against 70 and 73 for the other two. Five extra screen updates, each of which repaints
only part of the screen and leaves the rest as it was -- which is a mechanism by which one buffer
accumulates content the others never had. That is the next thing to follow for the 1219 pixels.

### Does a windowed resolution change apply?

At start-up, yes, measured: `+vid_stretch_by_2 0 +vid_config_x 320 +vid_config_y 200 +vid_mode 2`
gives `display 320x200`.

At RUNTIME, not yet. `vid_win.c:2377` polls `if ((int)vid_mode.value != vid_realmode) VID_SetMode(...)`
inside `VID_Update`, every frame, so the video menu should work -- but driving the same change from the
command buffer (forty `+wait`s then `+vid_mode 2`) left the presented size at 320x240 for 260 frames
and `vid_mode` reading 0 at the end. Either the deferred command never ran or the mode set failed and
`vid_win.c:2382` reset the cvar to the mode actually obtained. Not chased further; recorded because a
menu that silently does nothing is worse than one that is missing.

### Instrumenting the write: it is D_DrawSpans8

The surface is ordinary guest memory and PRISM emits direct stores into it, so there is no write
barrier to hook. But the value can be READ after any function the harness can intercept, which makes
the hunt a bracket in two stages: `tools/trace-platforms.mjs` finds the frame,
`tools/bracket-pixel.mjs` finds the function.

```
node tools/bracket-pixel.mjs 60 160 22

-> win: D_DrawSpans8: 16->48        x11: D_DrawSpans8: 16->0
-> win: D_DrawSurfaces: 16->48      x11: D_DrawSurfaces: 16->0
-> win: R_ScanEdges: 16->48         x11: R_ScanEdges: 16->0
...
```

Everything above `D_DrawSpans8` merely propagates what it wrote. **The divergence is born in the
innermost span rasteriser of the software renderer**, and it reads from the SURFACE CACHE: win reads
a texel of 48, x11 reads 0 -- an unfilled block. That is a far more specific answer than "somewhere in
the 3D view", and it re-opens the surface-cache question that call counts had closed: the two builds
size their cache identically (`D_SurfaceCacheForRes(320, 200)`, same 284 `R_DrawSurface`, same 3046
`D_CacheSurface`) but they do not place it in the same memory. `vid_x.c` allocates it INSIDE the X11
buffer block (`X11_buffersize += vid_surfcachesize`); the Win32 build takes it from the hunk.

**Stage zero matters**: nineteen of the twenty-five candidate functions do fire, so the direct-call
blind spot is narrower than the first attempt suggested -- but it is real, and the tool reports which
names never fired rather than letting a zero be read as "never called".

The same run turned up a structural fact worth keeping. At the same world frame and the same
`host_framecount`, the game's clock is different on every platform:

```
x11  realtime=3.500   dos  realtime=0.840   win  realtime=4.845     (world frame 60, host_framecount 59)
```

`realtime` accumulates over ALL Host_Frames, including the ones each platform spends on its own
start-up console, and `+host_framerate` pins the increment per frame but not the COUNT. So anything
time-dependent that is not the demo -- notify lines, `scr_centertime`, the console slide -- is at a
different point on each. An earlier bracket at frame 3 found exactly that: the divergence there was
inside `SCR_DrawConsole`, a notify glyph drawn on one platform and not the other. It is NOT the
explanation for frame 60 (`+con_notifytime 0` leaves the count at exactly 1219), but it is a second,
independent way for two platforms to disagree, and it would have been mistaken for the first.

### The answer: it is Quake's own black remap, and the gate now asserts it

`D_DrawSpans8` was the right place and the wrong conclusion. "x11 reads 0 -- an unfilled block" read
a zero as the absence of a write, which is exactly the mistake this document warns about elsewhere.
Zero was the *value*, not the *state*, and the placement lead written above is wrong on its facts:
both builds take the cache from the high hunk immediately after the z-buffer, and at 320x200
`D_SurfaceCacheForRes` returns `SURFCACHE_SIZE_AT_320X200` on all three.

The renderer is the same C compiled by the same PRISM on every platform, so at equal inputs it must
produce equal output. That turns the hunt into an enumeration, and every input was compared:

| input | how | result |
|---|---|---|
| span geometry | `espan_t` is `{u,v,count,next}` -- no struct offsets needed | identical over 16 spans |
| `cachewidth`, block address | globals | identical, block at +397600 on both |
| block placement over the run | every `cacheblock` seen, relative to `sc_base` | 267 blocks, same offsets, same order |
| a block read but never written | the same set | none, on either platform |
| `r_framecount`, `d_lightstylevalue[0..63]` | globals | identical |
| dynamic lights | `cl_dlights`, `r_dlightframecount` | none alive; counters equal |
| the texture BYTES | `texture_t.offsets[0]`, `width*height` | identical for all four textures drawn |

Which left the one input that is *not* shared engine code. `vid` is a `viddef_t` and each platform
fills it in itself:

```
win  vid.colormap first 16 bytes: 48 2 4 6 8 10 12 14 254 254 ...
x11                              :  0 2 4 6 8 10 12 14 254 254 ...
dos                              :  0 2 4 6 8 10 12 14 254 254 ...
```

`vid_win.c:2117` says why, in id's own words: *"GDI doesn't let us remap palette index 0, so we'll
remap color mappings from that black to another one"*. It then walks the whole colormap and replaces
every zero entry with the index whose colour is nearest palette entry 0 -- 48 in ID1. All 1219
differing pixels are that substitution and only that one:

```
most common index changes: 0->48(1219)
```

So the 2% was never PRISM's. It is WinQuake behaving as written, and the gate now says so instead of
declining to judge:

```
  x11 == dos   identical, 64000 pixels and 768 palette bytes
  (allowing X11's index 0 to be Win32's black remap, index 48)
  x11 == win   identical, 64000 pixels and 768 palette bytes, plus 1219 explained by the remap
```

The allowance is computed from the captured palette by re-running id's own nearest-colour loop, not
hard-coded, and it is narrow: substituting 47 for 48 fails the gate with all 1219 pixels back. A
tolerance that cannot fail would have been worth nothing.

**Two of the measurements on the way there were contaminated, and the shape of the contamination is
the lesson.** `D_CacheSurface` returns early on a cache hit without touching `cacheblock` or
`r_drawsurf`, so reading either of them *after* the call yields the previous fill -- the give-away
was sixteen consecutive surfaces all reporting `16x112 mip=0`. And a checksum of the whole surface
cache "diverges at world frame 0" on two runs that agree perfectly, because it includes the bytes
nobody has written yet. Both channels answered confidently and both answers were noise; the frame-0
comparison, where every call is a real fill, was the one that could be trusted.

## find-loop.mjs: which loop is spinning

`tools/find-loop.mjs <target[:variant]> [samples] [every] [-- args]` turns on the emitter's
safepoints, gives the budget a finite value and replaces `M.sp_` with a sampler. Every loop back-edge
decrements that budget, so when it runs out the id names the FUNCTION whose loop is running.

It exists because the obvious tool is the wrong one. Wrapping `program.F` does not see a loop that
calls nothing the rebinder reached — PRISM emits direct calls — and PuTTYtel hung with hooks on
`GetMessage`, `DispatchMessage`, `MsgWaitForMultipleObjects` and a dozen other candidates all silent.
A safepoint is *inside* the loop, so what the loop calls does not matter:

```
40 samples, one every 2,000,000 loop iterations:
    40  ...corpus_putty_windows_window$update_savedsess_menu#11
```

One run, one name. `window.c:1029` is

```c
while (DeleteMenu(wgs->savedsess_menu, 0, MF_BYPOSITION)) ;
```

and the shim's `DeleteMenu` returned TRUE unconditionally. On Windows it returns FALSE once there is
nothing at that position, and that FALSE is the loop's only exit.

**The lesson is bigger than the bug: a stub that answers "success" to a QUESTION is not neutral.**
Returning TRUE from something a caller only *performs* is harmless; returning it from something a
caller *reads* invents an answer. Where the answer is read, the shim has to keep enough state to give
a real one — so menus now count their items, which is four lines and the difference between a program
that runs and one that hangs after creating its window.

## A refusal that becomes a wrong answer

Three times in one sitting, closing a gap turned a *refused* program into a *wrong* one. That is the
transition the suite counts separately for, and it is worth stating why it keeps happening: a refusal
hides everything downstream of it. The program never ran, so nothing it would have exercised was
ever tested.

- `__builtin_snprintf` was missing, so `pr78622.c` was refused. Supplying it revealed that printf
  ignored the **narrowing** length modifiers entirely: `%hhd` of 4104 printed 4104, where C converts
  to `signed char` first (7.19.6.1p7) and prints 8. The comment in that code claimed the modifier
  mattered "for one case".
- Resolving quoted `#include`s relative to the including file — the standard's own rule, and what
  twelve torture programs need to compile a sibling test twice — revealed that `tmpnam` returned
  NULL. `gcc_tmpnam.h` reads `ret[0]` on the next line, so NULL was a crash rather than a refusal.
- Giving `tmpnam` a name revealed that `freopen` was a stub returning 0, and fixing *that* revealed
  the real defect: **`printf`, `puts` and `putchar` wrote straight to the host console** instead of
  through the stream. Indistinguishable from correct until something redirects stdout, and the same
  shape as the `fprintf` that ignored its stream.

`gcc.c-torture/execute`: **1294 → 1320**, zero wrong answers throughout.

**A known asymmetry in `gate-run`**, found while writing the freopen case and left in place rather
than papered over: PRISM's `stderr` lands in the same buffer as its `stdout`, and gcc's does not. A
case that reports its findings on stderr is therefore not comparable. The stdout-redirect half of
freopen is checked by gcc's own `printf-2.c` and `user-printf.c` instead, which is the better oracle
for it.

## Variable-length arrays, and where a feature must STOP

VLAs for locals took an afternoon. Keeping the suite's "zero wrong answers" while adding them took
longer, and the reason is worth writing down: **a parser change makes a program COMPILE, and a
program that compiles produces an answer.**

Accepting `double x[n]` also accepted, at a stroke:

| where | what goes wrong |
|---|---|
| `struct { char x[size]; }` | the struct's size becomes a run-time value, and every `sizeof`, assignment and `va_arg` of it with it. Laid out with a null extent, five programs went from refused to wrong. |
| `typedef int c[i+2];` | `sizeof(c)` is a run-time value; the constant folder answers with whatever the extent happened to fold to. |
| `void foo(int a, int b[a++])` | the type decays to a pointer and carries nothing, but gcc still EVALUATES the extent -- `a` ends at 2. Dropping it silently is a wrong answer. |

Each is now refused by name. The score went 1342 → 1347 with six wrong answers, then 1344 with none,
and the second number is the one that counts: **five extra passes are not worth one wrong answer**,
because a refusal is a thing you can look up and a wrong answer is a thing you have to find.

The implemented case is deliberately narrow — the outermost extent of a LOCAL — and the storage is
`alloca`, which puts it on the same shadow stack as the frame and therefore releases it at return.
That is exactly a VLA's lifetime, so nothing else had to know about it: the local is recorded as an
address in a variable, which is the shape a by-value struct parameter already uses, and indexing,
decay and `&x` all work without another case.

## P8.4 — Lua's test suite as a gate, and the five stdio defects it named

`node tools/gate-lua.mjs` went from **14 pass / 5 fail** to **16 pass / 1 fail**, and every fix on
the way was a real one. Lua's files are self-checking and they ask stdio questions no game and no
compiler test ever asks: not "does this work" but "does this FAIL when it should".

**Three of the five failures were the harness, not the language.** `calls`, `coroutine` and `errors`
ran out of JavaScript stack. PRISM emits a JS function per C function, so C recursion depth *is* JS
recursion depth, with a frame carrying the emitter's temporaries as well as the program's — and
node's default megabyte is far less than the stack a C program of this era assumes. The gate now
re-executes itself with `--stack-size=30000` rather than expecting to be run with a flag: that is the
host providing a stack, and reporting it as a language failure would have been measuring the
harness. `constructs` wanted more than 256 MB of guest heap and now has 512.

**The other five were stdio being silently permissive**, each found by `files.lua`:

| what | what it did | what it must do |
|---|---|---|
| `fopen(path, "w")` | succeeded for any path at all | fail when the directory does not exist — so the store grew directories, seeded from the files in it |
| `ungetc(EOF, f)` | stepped back a byte and cleared the EOF flag | fail and leave the stream unchanged (7.19.7.11). A program that reads to the end and pushes EOF back re-read its last character |
| writing an `"r"` stream | appended | fail |
| reading a `"w"` stream | returned the bytes | fail |
| `fopen(path, "r+")` | **truncated the file** | keep it — the comment in that code described the rule correctly and the code did not |

`attrib.lua` then failed, and its failure was the useful kind: it writes into `libs/`, and the gate
only ever loaded the files sitting flat in `testes/`. That went unnoticed for exactly as long as the
store accepted any path — once directories existed, a write into one nobody had loaded was correctly
refused. The gate walks the tree now.

**What is left is buffering.** `files.lua:678` checks that a `setvbuf("full")` write is NOT visible
to a separate reader until close, and PRISM's writes reach the store immediately.

**And a third time in one sitting, a gate case of mine read a value at an unspecified moment.**
`printf("%d %d %d", fgetc(r), fgetc(r), fgetc(r))` comes out backwards under gcc. Reads go one per
statement now; so do the overflow builtins and the shadowed-locals case, for the same reason.

## P0.5b, continued: 1294 → 1435, and the two near-misses that cost the most

One long pass over `gcc.c-torture/execute`, ten features, **zero wrong answers at the end of every
one of them**. What follows is not the feature list -- the roadmap has that -- but the two places
where the score went UP and the correctness went DOWN, because those are the ones that say something
about how to work on this.

### Brace elision: four programs gained, two turned into wrong answers

`struct s a = { 1, 2, 3, 4 };` where the member is `int f[4]` hands all four scalars to the array.
The static path had done that for a long time; the dynamic one had not, so the local form refused.

Adding it broke two programs that had been passing. Elision means "this member takes items from the
enclosing list", and the test for it is *an aggregate given a bare expression* -- which is also
exactly what `struct A a = { 2, b };` looks like when `b` is a struct VARIABLE. Spreading `b` across
the member's fields put its address in the first `int` and zero in the rest.

The static path had never met the case, because a struct variable is not a constant initialiser. So
the rule that was missing had never been needed: **a value that is already an aggregate is a copy,
never a source of items.** Torture said 1410 with 2 wrong; it says 1412 with 0 now, and the second
number is the one that counts.

### A 64-bit `switch` was quietly truncating, and only a case RANGE made it visible

`switch (aLL)` was emitted as `switch(disc|0)` with `Number(case)` labels. Both sides truncate to 32
bits, so the two truncations agreed with each other and nothing looked wrong -- until a case value
differed only ABOVE the low 32 bits, where `case 0x100000000ULL` became unreachable and the
discriminant fell to `default`.

What surfaced it was not a test for 64-bit switches. It was gcc's `pr34154.c`, a GNU case range
spanning nine quintillion values, which the emitter expanded one JavaScript `case` at a time until
node ran out of memory. Lowering the range to a single comparison put the discriminant back in a
temporary that keeps its own type, and the truncation went with it.

Two lessons, both already in this file in another form: **a compiler that runs out of memory is a
correctness report**, and a bug that makes two halves of a computation wrong in the same direction
stays invisible until something separates them.

### What complex types cost, and why they were cheap

`_Complex double` was the largest actionable gap after long double -- 20 programs -- and it took one
decision rather than a subsystem: **a complex type IS a two-member record here.** Storage, copies,
by-value arguments, `sret` returns, initialisers, `sizeof` and `offsetof` then come from the paths
records already have, and the layout is right by construction.

What had to be written is the arithmetic. Two parts of it are worth naming:

- **division follows libgcc's Smith method**, not the textbook formula. Dividing by the larger
  denominator half keeps the intermediate products in range; the naive version overflows to infinity
  for perfectly ordinary values, and the reference build would have disagreed.
- **`float` complex is computed in `float`**, so every step is rounded with `Math.fround`. Without
  it the halves are double-precision and the printed result differs in the last digits.

Contrast with `long double`, still refused: it is not representable in 8 bytes, so implementing it
"approximately" would turn refusals into wrong answers, which is the trade this project does not
make.

### The gaps that remain are mostly deliberate

Of 120 refusals left, the two largest are recorded non-goals -- `long double` (21) and arithmetic on
a bitfield wider than 32 bits (9) -- and a third, vector types (9), is refused because the attribute
CHANGES THE TYPE and ignoring it miscompiles silently. `__attribute__((mode))` came out of that same
family and went the other way: its widths are exact and knowable, so it is implemented, and a mode
the mapping does not know is still refused rather than guessed.

## The 16-bit BYTE IMAGE (`tools/gate-bits16.mjs`) — the half `gate-abi16` cannot reach

```
node tools/gate-bits16.mjs [count] [seed]

gate-bits16: 210 cases (10 hand, 200 generated, seed 20250909) — Open Watcom 8086 small model,
             run under DOSBox-X
210/210 cases byte-identical, 14760 bits compared
16-bit DOS bitfield ALLOCATION ORDER, byte order and padding match Open Watcom exactly.
```

`gate-abi16` asks the object file for `sizeof` and for the offset of every plain member, and it says
in its own comment why that is not everything:

> offsetof is illegal on a bitfield, so only plain members are asked — the bitfield PLACEMENT is
> pinned by the size of the struct and by the offsets of the plain members around it.

Pinned by the size tells you **which unit** a bitfield lands in and nothing about **where in it**.
Flip the allocation order inside every unit — first field into the high bits instead of the low —
and all ~4,970 of that gate's checks still pass. `layoutStruct` commits to an order anyway:
`bitOffset = unitAt * 8 + unitUsed`, `unitUsed` growing from zero. That was an assumption wearing a
measurement's clothes, and it is the exact shape of a check that cannot fail.

**The question that can fail** is to hand the compiler an INITIALISED object and read its bytes
back. Nothing infers a byte. `oracle.watcomRun16` builds a real DOS executable in the container and
runs it under headless DOSBox-X; one session covers every case, because the session costs seconds and
a struct costs nothing. PRISM's side writes the same values into a byte image using only what
`layoutStruct` returned — `offset`/`size` for a plain member, `bitOffset`/`width` for a bitfield —
and the two images are compared bit for bit.

The answer arrived in one line before the gate existed: `struct B { int a:3; int b:5; }` with
`{5, 9}` is the single byte **`4D`**, which is `01001_101`. Field `a` in bits 0–2, `b` above it.
**LSB-first, measured.**

Three things beyond the order come with it, none of them checkable from an object file's offsets:

* **A negative bitfield's sign bit** lands in the field's own top bit, not the unit's.
* **Watcom's DOS `double` is IEEE 754 little-endian** — asserted now rather than assumed, along with
  `float` and the byte order of every plain member.
* **Padding is zero** in a static object's emitted image. Covered and uncovered bits are tracked
  separately, so a disagreement in padding is reported as padding and never as a misplaced field.

### The positive control, because a green gate proves nothing on its own

Two deliberate mutations of PRISM's side, each run against the same 22-case corpus:

| mutation | result |
|---|---|
| bitfields allocated MSB-first within the unit | **18 of 22 cases red** |
| plain members written big-endian | **8 of 22 cases red** |

The survivors are the cases the mutation cannot touch — a struct with no bitfields, a 1-bit field, a
struct of nothing but `char`. That is what makes the green run mean something: the gate was shown to
fail on exactly the two facts it claims to pin, before it was believed for passing.

## MAME 0.4 had an oracle all along — it just was not gcc

`mamediff` used to stop on this release with a diagnostic that named the construct honestly and then
drew the wrong conclusion:

> this release needs a period compiler (gcc 2.x, or tcc) before it can be diffed at all

A period compiler had been sitting in the same container since N5. Three measurements, in the order
they were made:

| compiler | `case MRA_RAM:` | `unsigned char *line[0]` | `interrupt` as an identifier |
|---|---|---|---|
| gcc 12 | ✗ *pointers are not permitted as case values* | ✓ | ✓ |
| Open Watcom (any mode, `-za` included) | ✓ | ✗ *E1020: Dimension cannot be 0 or negative* | only with `-za` |
| tcc 0.9.27 | ✓ | ✓ | ✓ |

So the named blocker was never the whole story — **Watcom does take the case labels** — and Watcom is
still not the oracle, because `osdepend.h`'s zero-length array is in all 31 units and no Watcom mode
accepts it. That was worth measuring rather than assuming: `-za` was needed anyway (Watcom reserves
`interrupt`, which MAME uses as a field name), and `-za` is the mode that refuses `[0]` hardest.

**How much was ever at stake, counted rather than feared:** compiling every unit of the release
separately with gcc 12 produces exactly four errors, all of them the same one, all in one file —
`machine.c` lines 392, 393, 430, 433. Thirty-one of thirty-two units are clean. The release was one
file away from having an oracle, and nothing said so.

tcc builds the lot (`-lm` is explicit; unlike gcc it does not link libm on its own, and cclimber's
wave table calls `cos`). `mamediff` now builds with gcc, and falls back to tcc **only** on that one
error, printing which compiler produced the reference. gcc stays the reference wherever it can be.

⚠️ **The error census was wrong the first time, and the reason is reusable.** `.oracle/mamediff` is a
persistent flat directory, and a glob over it picked up `pengo_machine.c` — a unit of MAME 0.1 left
behind by an earlier run, dropped from the unit list in 0.3. It produced seven confident errors about
`osd_joy_*` and a missing `dsw` member that had nothing to do with this release. The census is only
meaningful over the TARGET's unit list, never over what happens to be in the directory. The tool had
already been bitten by the same directory once, over stale ROMs.

### And the differential this unblocks

```
node tools/mamediff.mjs --release=04 --game=wow --roms=<dir> --frames=120
✓ identical over 135 lines — the whole build agrees with the tcc build.
```

PRISM's MAME 0.4 running Wizard of Wor is bit-identical to a native tcc build through attract mode.
Then, with the same harness playing:

| run | result |
|---|---|
| attract only, 120 frames | identical, 135/135 |
| `--play=240,9999,9999,9999` (a coin, nothing else) | **2 of 415 lines differ** — frames 267, 268 — then it re-converges |
| `--play=240,300,700,880` (coin, start, fire) | **402 of 915 lines differ**, first 267, last 913, agreement in between |

Both playing runs first diverge at the same frame, 27 after the coin, so the fire button is not what
starts it. And the builds keep re-converging, which rules out simulation state permanently out of
step. The report now prints the count and the span for exactly that reason: "two frames then
agreement" and "every frame from here on" are different defects, and the old report — first differing
line only — could not tell them apart.

## Three instruments for MAME, and the order they had to be used in

`mamediff` compared display hashes and nothing else, which is enough to say two builds part company
and useless for saying why. Wizard of Wor needed three more, and the order they were applied in is
the reusable part — each one answered a question the previous one raised.

```
node tools/mamediff.mjs --release=04 --game=wow --roms=<dir> \
     --frames=280 --play=240,9999,9999,9999 --dump=267 --vram --ram
```

| flag | what it dumps | the question it settles |
|---|---|---|
| `--dump=N` | frame N, pixel by pixel, from **both** sides | how many pixels, where, and **which pens** — the index-pair census, as `gate-pixels` does for Quake |
| `--vram` | the game's own video RAM on that frame | wrong CONTENT, or a wrong WRITE? |
| `--ram` | a hash of the whole Z80 address space every frame, and the differing **addresses** on the dumped frame | when did the *machine* diverge, as opposed to when did it become visible |

Everything is compiled into both sides from the same `-D`, so the dumps are produced by the same code
on the same frame and the comparison stays a comparison.

**The `--vram` question has a clean answer because of how the driver works**, which is why it was
worth building: `wow_videoram_w` early-outs on an unchanged byte and then writes all four of that
byte's pixels from scratch, so a pixel depends only on the *last accepted write to its byte* — the
picture is a pure function of the video RAM's content. Same bytes and a different picture would mean
the handler was invoked differently; different bytes means the divergence is upstream of the video
hardware entirely.

### What they found, and why the order mattered

1. **The picture**: 116 of 65,280 pixels on frame 267, a 21×10 box at x150,y32, **one** pen pair
   `3→0`. One glyph — not a drift, not a rasteriser.
2. **The video RAM**: identical at 266, different at 267–268, identical again at 269. PRISM **erases
   that glyph two frames early**. It is ahead, not behind — the opposite of the first reading, and
   only the frame-266 dump distinguishes them.
3. **The machine state**: `RAM[0..0xffff]` differs from **frame 1** — one byte, `0xd34a`, in WOW's
   work RAM, `0x85` against `0x52`. The two builds were never in step. The display hash named frame
   267 because that is when something finally *read* that byte.

**A display hash names the frame a difference became visible, which here was 266 frames after the
frame it happened on.** That is the lesson worth keeping: hash the state, not only the picture.

### Two hypotheses killed by measurement rather than argument

* **A global placed on top of `RAM`.** A single differing byte is exactly that shape. Refuted by
  reading PRISM's own symbol table: `RAM` is the sole occupant of that address and no symbol sits
  within 4 KB of it.
* **Nondeterminism in the reference.** The control that should precede any accusation of the compiler
  under test: run the tcc binary twice and diff it against itself. Byte-identical, 483 lines. The
  harness's "deterministic by construction" claim holds, and the byte is genuinely PRISM's.

There is no random source in the driver either — `readport` is `input_port_0_r`..`_3_r` and nothing
else — so the value is derived from something the game computed. The next step is one question: which
Z80 PC writes `0xd34a`.

## Wizard of Wor was `rand()`, and "deterministic" was the wrong requirement

The instruments in the section above narrowed the complaint to one byte, `0xd34a`, differing from
frame 1. Wrapping MAME's memory-write entry point named the writer without touching the game:

```js
wrap('Z80_WRMEM', (orig) => (A, V) => {
  if ((A & 0xffff) === 0xd34a) hits.push({ frame, pc: prog.F['Z80_GetPC'](), v: V });
  return orig(A, V);
});
```

**PC 0x0f61, fifteen times in six frames**, with values that looked random — `bd 58 29 9c f5 00 …`.
Reading the ROM at the other writing site gave the answer in two instructions:

```
ED 5F        LD A,R          ; the Z80's refresh register
32 4A D3     LD (0D34AH),A   ; …becomes the game's random seed
```

and MAME's own Z80 core supplies it:

```c
void Z80_Reset (void)
{
 memset (&R,0,sizeof(Z80_Regs));
 R.SP.D=0xF000;
 R.R=rand();          /* deliberately randomised */
 Z80_ICount=Z80_IPeriod;
}
```

**The arithmetic confirmed it instead of my arguing it.** The reference reported 1804294666 fetches
at frame 1; glibc's first unseeded `rand()` is **1804289383**, and the difference — 5,283 — is the
instructions executed since reset. PRISM's 22121 minus the same 5,283 is **16838**, which is the first
value of the ANSI sample LCG it used to implement. Two correct implementations of an
implementation-defined function, and the guest could see which one it had.

### The fix, and the principle it corrects

PRISM's `rand()` is now **glibc's** TYPE_3 additive-feedback generator — 31 int32 words, taps at 3
and 0, output the sum's top 31 bits, seeded by the 16807 Lehmer recurrence with 310 outputs
discarded. `random()`/`srandom()` are the same generator, which they now genuinely are.

The old comment called the ANSI LCG "deterministic on purpose", and that was true and insufficient.
**PRISM's oracle is a native i386 gcc build, so wherever a program's output can depend on an
implementation-defined value, the requirement is not determinism — it is agreeing with the
reference.** A new `gate-run` case pins it on five seeds and on `RAND_MAX`, and it can only pass
against a glibc reference, which is exactly what the oracle is.

Two things the gate found immediately, both worth keeping:

* **`RAND_MAX` was never declared** in PRISM's `<stdlib.h>`. That absence is the only reason changing
  the generator could not turn a compiling program into a wrong answer: the old LCG returned
  0..32767 and glibc's returns 31 bits, so a program that had read the constant would have been
  silently miscompiled by the change.
* **My own case failed first, on unspecified behaviour.** `printf("%ld %ld %ld", random(), random(),
  random())` tests the order arguments are evaluated in: gcc goes right-to-left, PRISM left-to-right,
  and both are correct. The values were identical and reversed. One call per statement fixes the
  test, not the compiler — the second time this project has written a test of undefined behaviour and
  believed it.

### Result

| | before | after |
|---|---|---|
| WOW, attract mode | 135/135 lines | 295/295 |
| WOW, played (coin, start, fire) | **402 of 915 lines differed** | **915/915 identical** |
| gate-run | 60/60 | 61/61 |
| gate-pixels | 3/3 asserted | 3/3 asserted |

## A golden per ROM set, born green (`tools/mame-golden.mjs`)

`mamediff` answers the strong question — does PRISM agree with a native build of the same sources —
and costs a container, a compiler and a run per game. A golden answers the cheap one, *does PRISM
still do what it did*, for every game at once:

```
node tools/mame-golden.mjs --write --roms=<dir>     # against the reference, once
node tools/mame-golden.mjs --check --roms=<dir>     # 19 games in 12.5 s, no reference
```

**The rule that makes it worth having: an entry is only ever written for a game whose differential
was GREEN at that moment.** A fingerprint recorded from PRISM alone would freeze whatever PRISM
happened to do, wrong answers included, and then detect only departures from that — a check bounded
by its own assumption. `--write` runs the full differential and *omits* a game that disagreed,
reporting it instead.

The fingerprint is a sha256 prefix over the frame log MAME itself prints (a display hash per frame),
so it covers the whole observable behaviour of the run, not a final screenshot.

### MAME 0.5, all nineteen ROM sets present

| game | display | pens | lines | fingerprint |
|---|---|---|---|---|
| pacman, puckman, piranha, mspacman, crush | 224x288 | 16 | 146 | `c6c24c55…` `aedaa8fa…` `9a63b169…` `4f06ef7f…` `d3add663…` |
| pengo | 224x288 | 32 | 162 | `c03abbcc…` |
| ladybug, galapx, pisces, warofbug | 256x256 | 32 | 162 | `5d222405…` `adfbac61…` `236ce124…` `d4d29597…` |
| mrdo | 256x256 | **256** | 386 | `0628643c…` |
| cclimber, ccboot | 256x256 | 96 | 226 | `62022731…` `c8863814…` |
| ckong, bagman | 256x256 | 41 | 171 | `e32ce389…` `1a92031e…` |
| dkong, dkongjr | 256x256 | 12 | 142 | `f0cc68e4…` `60e14049…` |
| theend | 256x256 | 17 | 147 | `3078730d…` |
| wow | 320x204 | 5 | 135 | `6f785550…` |

**19 recorded, 0 left out.** The resolutions run from 224x288 to 320x204 and the palettes from 5 pens
to 256, which is the answer to "are these nineteen runs of the same code?" — they are not.

Of MAME 0.5's 34 games, 15 have no ROMs here and are reported rather than skipped silently: 13
directories hold only a readme (`galaxian` itself, `mooncrst`, `japirem` and ten clones) and `robby`
and `gorf` have no directory. **PRISM never fetches ROM data**, so that list is the user's to close.

### Two defects this built, both mine

* **A partial write destroyed the rest of the golden.** `--write --games=pacman,wow` started from an
  empty object and deleted the other seventeen entries — data loss disguised as an update, on the
  first partial run. A partial write now merges.
* **The geometry came back `null` for every game**, because the tool parsed `display WxH` out of
  `mamediff`'s stdout, which never echoes the frame log. Reading a number from a place that never
  carried it. `mamediff` now prints the geometry and the pen count beside the fingerprint.

### The positive control

Tamper with one entry and the check must go red — otherwise the golden is decoration:

```
pacman     ok
wow        CHANGED — golden 0000000000000000, now 6f785550cf5a3846
1 match, 1 changed
```

## The TASM front end, held to Turbo Assembler itself (`tools/gate-tasm-front.mjs`)

Keen Dreams links against three Turbo Assembler modules: `id_us_a`, `id_rf_a` and `id_vw_a`, where
`id_vw_a` includes `id_vw_ae` (EGA). They supply the 26 symbols the C link lacks. `src/asm/tasm.js`
reads them the way TASM does, handling both IDEAL and MASM syntax: INCLUDE, `=`/EQU (numeric and text),
IF/IFE/IFDEF/ELSE, MACRO with parameters, REPT, `@@` local scopes, PROC with arguments and USES, the
generated prologue and epilogue, DB/DW/DD with DUP and `?`, STRUC and its instances, and LABEL.
Its output is not an encoding. It is the module as a translator needs it: the data segment as bytes
with fixups, the code segment as instruction tokens with the data that sits between them, and the
labels, publics and externs.

**The oracle is TASM 2.5 itself.** It comes from the Borland C++ 2.0 floppies (Keen's own toolchain),
run in DOSBox-X by `--capture` on the unmodified sources with `tasm /mx /zi /la`. The golden
(`goldens/tasm-keen.json`) keeps these, per module:

* from the OBJ: the publics, the `_DATA` bytes with the linker's fields masked, and the fixup positions;
* from the listing: every instruction's mnemonic, in order, and its bytes, which ndisasm decodes into
  operand signatures;
* the near-jump destinations, as the ordinal of the instruction they land on. ndisasm reads the
  instructions without the data between them, so each of its addresses is moved back to the listing's
  offsets before it is looked up;
* what lies between the instructions in the code segment (data and EVEN pads), at its real offset.
  The front end does not know instruction lengths, so it rebuilds each run from its data items. It places
  an EVEN pad from the real offset TASM reports.

Result: all three modules agree on everything. That covers 2001 instructions with their operands,
136 of 140 jump destinations (the other 4 are indirect or far), 13 runs of code-segment data, 6148 data
bytes, 37 data fixups and every public.

### Two faults of ndisasm 3.01, stepped round and named

* It cannot decode the register forms of opcode FF in 16-bit code. `call ax` (FF D0) comes out as
  `db 0xff`, and the next byte starts a bogus instruction. The gate decodes those two-byte forms by
  their ModR/M reg field.
* It prints a shift or rotate by one (D0/D1) as `,0x0`, so `D1 E7` reads as `shl di,0x0`, while `D3 E7`
  correctly reads as `shl di,cl`.

### What TASM does that the front end had to learn

* `x.field` is x plus the field's offset.
* OFFSET inside brackets adds nothing.
* `($-TestSequence)/3` is a constant, because the table sits in CODESEG with only data between its ends.
  A distance across instructions is refused, because their lengths are unknown here.
* `jmp $+2` (the I/O delay) is a jump to the next instruction. Any other `$` in an instruction is
  refused.
* LEA of a plain address is assembled as MOV of its offset.
* A default segment override (`ss:` beside bp) is dropped.
* An operand that is wholly constant, written with MASM's AND/OR/SHL, is folded.
* EVEN outside CODESEG is refused. Keen never aligns data, so TASM's pad byte there has never been
  observed.

### Mutations, all red (15)

| mutation | first red check |
|---|---|
| REPT expands once | id_rf_a instruction order |
| no generated epilogue | id_us_a instruction order |
| IFE taken as IF | id_rf_a instruction order |
| text equates not substituted | id_vw_a operands |
| `?` read as a symbol | id_us_a data fixups |
| EVEN in code forgotten | id_rf_a code-segment data runs |
| DW stored big-endian | id_us_a data bytes |
| macro parameters not substituted | id_vw_a jump destinations (`loop addr`) |
| no frame for arguments | id_us_a instruction order |
| field dot kept, OFFSET in brackets kept, constant operands not folded | the operand parse refuses |
| label distance one entry long | id_vw_a operands |
| `$+2` lands one further | id_vw_a instruction order |
| equate masked to a byte | id_rf_a operands |

The macro-parameter mutation was **green** until jump destinations were compared. `loop addr` is the only
place a parameter is used, and a destination compared as just "a target" cannot tell `mask1E` from
`addr`. The EVEN mutation was green until the code-segment data was compared, because nothing looked at
those bytes, and phase 2 will read them.

## Keen's assembly, translated and executed against TASM's object code (`tools/gate-tasm-run.mjs`)

`src/asm/tasm16.js` turns a module from the front end into JavaScript that runs it as the 8086 runs
TASM's bytes. It does this in two steps.

**Layout first.** Every instruction gets the offset and length TASM gives it. That means TASM's
choices, not just any valid encoding:
* a forward `jmp` is three bytes, because TASM sizes it in one pass;
* `mov ax,[x]` takes the accumulator's short form;
* `lea r,[x]` is assembled as `mov r,OFFSET x`;
* a code-segment variable read under ASSUME DS:DGROUP costs the CS: prefix TASM adds on its own;
* a structure field carries its declared size.

This matters because the program can see code addresses. It keeps jump tables of code labels
(`jmp [ss:memtoscreentable+di]`), stores a routine's address in a variable
(`mov [routinetouse],OFFSET generalmask`), keeps data in its code segment and pushes real return
addresses. gate-tasm-front holds all 2001 offsets, lengths and segment registers to TASM's listing and
bytes.

**Then the machine.** The registers, flags and SS:SP are real, and so are CALL, RET and RETF. A
routine returns to whatever address is on the stack, and a far return that leaves the code segment
hands control back to the caller. The code is split into one function per procedure, dispatched by
real code offset, because a single switch over a whole module is too large for V8 to optimise. The
flags are lazy: an operation records its kind, operands and result, and a flag is computed only when
something reads it. All six arithmetic flags exist, because PUSHF can expose any of them.

**The oracle is TASM's own object code, executed.** `--capture` assembles the three modules with TASM
2.5 in DOSBox-X and relocates the .OBJ files with `tools/omf.mjs` linkOmf, using a fixed placement:
DGROUP at 1000h, the code at 3000h and far data from 4000h. It then runs each case under Unicorn
(`tools/oracle/unicorn-tasm.py`).

Each case sets up a world the routine can be called in:
* EGA memory, with a 64-byte line;
* `ylookup` and `blockstarts` computed the way the C computes them;
* map planes holding tile numbers the graphics can actually index;
* update matrices ending in their UPDATETERMINATE;
* a font whose characters are 1 to 24 pixels wide (width 0 would index `shiftdrawtable`'s 0, a jump
  to offset 0);
* the C arguments, with a far return address under them.

Ports and interrupts answer by one rule on both sides: seeded values, or echo the last write so that
a 6845 can be found, and an XOR on AX/BX for INT.

The replay needs neither DOSBox nor Unicorn, because the golden also carries the linked segments. It
first checks that PRISM's loader produces memory **byte-identical** to the linked object, which proves
that addresses resolve the way the linker resolves them. It then requires the same registers, the same
flags, all 272 pages of memory and the same sequence of port writes.

Result:
* **Part A:** every public routine of the three modules, 182 calls, all identical.
* **Coverage:** 1,994 of 2,001 instructions executed. The report names the 7 never reached; all are
  rare adapter-detection branches in VW_VideoID.
* **Part B** (`flags.asm`, generated, then assembled by TASM): every ALU, shift and rotate form, at 8
  and 16 bits, by 1 and by CL, ending in PUSHF/POP DI so that the whole flags word is compared.
  840 calls, all identical, including a code-segment variable read and written without an override under
  ASSUME DS:DGROUP, with DS elsewhere.

### What it found

* **The EVEN pad is executed.** When control falls into an EVEN-aligned label, it runs through
  the NOP TASM placed there. The translator had treated the pad as the end of the flow. Found in
  `VW_DrawPropString`, whose `shift1wide` falls into `@@loop1`.
* **Three flag rules, found by part B.** NEG's AF is that of `0 - a`, not `a - a`. For SHR by more
  than 1, OF is `msb((a >> (c-1)) ^ (a >> c))`. For RCL/RCR, OF is `msb(old ^ new)`. The 8086 defines
  OF for a count of 1 only, and the translator follows the reference machine beyond that.

### Mutations

27 mutations of the translator and layout were run against both gates, and 25 go red. Two stay
green, and why each does is part of the result:
* **The EVEN pad treated as the end of the flow** is an equivalent mutant. The rule that lets a call
  return onto a pad also makes the pad an entry point, so behaviour is unchanged.
* **A word read at offset FFFFh not wrapped** cannot be settled here. No case reaches that offset, and
  Unicorn cannot answer it anyway: a 386 in real mode faults where the 8086 wraps.

Part B exists because of the mutations. ADD's carry, INC keeping CF, RCL's carry, SAR read as SHR
and CLI all stayed green against the Keen routines alone, because Keen never reads those flags back.
The automatic CS: override stayed green too: no Keen instruction reaches a code-segment variable
without an explicit override while DS is not CS. Part B now does, and gate-tasm-front checks the
segment register of every memory operand against TASM's bytes.

## run() under a 16-bit model, held to Borland C++ running the same programs (`tools/gate-dos16-run.mjs`)

run() used to refuse every model except i386, and the reason was written in its own body: argv was
built from 4-byte pointers by hand. Opening it meant sizing by the model every place where the
runtime reads or writes an object the program owns.
* **argv** holds data pointers: two bytes in dos16m, four (linear far) in dos16l.
* **Variadic arguments** are packed in int-sized slots. On i386 that is four bytes, as before. Under a
  16-bit model it is one 8086 stack word: an int takes 2 bytes, a long 4, a near pointer 2 and a
  double 8, exactly as Borland's caller pushes them.
* **The printf family** under a 16-bit model reads that packed buffer rather than a JS array. Each
  conversion reads its own width: `%d` reads 2 bytes, `%ld` 4, `%s` a data pointer, and `%u` of −1
  is 65535.
* **The runtime's stores** go through `M.storePtr` and `M.storeInt`: strtol/strtod's end pointer,
  frexp's exponent, localeconv, the va_list walk, and the three standard streams.

What still assumes i386 refuses by name where it lives: struct stat, struct tm and fd_set in stdio,
mktime and strftime, and printf's `%p`. The last is refused because Borland prints SSSS:OOOO, which
PRISM's addresses do not model.

**The oracle is Borland C++ 2.0, Keen's compiler, run with Keen's options** (`-mm -a -K`, from its
.PRJ). It compiles each program in `tests/dos16/`, runs it in DOSBox-X and records what it prints.
PRISM builds the same source exactly as it builds Keen (targets/keendreams.json: env stdio+borland,
dos16m), calls run() with the same command line DOS gives (`D:\LIB.EXE one TWO 3`), and must print
the same bytes. There are five programs:
* `fmt.c`: printf at every width, flag and modifier;
* `vararg.c`: the program's own va_arg at int, long, double and pointer, and vsprintf handed a va_list;
* `lib.c`: argv, strtol/strtoul, setjmp/longjmp, qsort and bsearch, the heap, sprintf, strings, and
  the pointer and int the library writes through, each followed by a sentinel;
* `lang.c`: structs by value, recursion, a static table of far function pointers, long arithmetic,
  wrap-around;
* `far.c`: farmalloc, far pointers, _fmemcpy, a far static.

All five agree.

### What it found

* **stderr overwrote the next variable.** stdio stored `stdin`, `stdout` and `stderr` as four-byte
  ints, but they are `FILE *`, two bytes under dos16m. stderr's high half, zero, landed on the first
  two bytes of whatever the linker placed after it. In `lang.c` that was the table
  `ops[] = { twice, neg }`, and the first call through it went to function index 0x7000. Keen would
  have met it the same way, silently, in whatever variable followed stderr.
* **bsearch did not exist.** It was declared nowhere and had no runtime entry. It is added, and its
  prototype in the shared stdlib.h shifts every i386 program's function-table indices by one. Doom,
  Quake and MAME emit the same code with those numbers masked. Their emitted-JS hashes change for
  that reason and no other: doom aaff6733bf6ffbb1, quake 87f7a01061e5030b, mame05 a35490bc1d9ca6f3.

### Mutations, all red (12)

argv strided by four, va_arg stepping by four, varargs packed by four, printf ints at 32 bits,
`%d` reading a long, `%s` reading four bytes, the standard streams stored as int32, strtol's end
pointer stored as int32, the printf family handed a JS array under 16 bits, bsearch searching the
wrong half, `%u` of an int at 32 bits, and an int stored as 32 bits.

Three of these were vacuous at first and needed the tests changed before they could go red:
* **argv strided by four stayed green** while the only argument was argv[0]. With one argument,
  `argv[argc]` falls on the high half of the first pointer, which is zero, so it passed either way.
  The programs now take a command line, and the oracle passes it (`bccRun` programs carry `args`).
* **The end pointer and the int stored at 32 bits stayed green** because what they overwrote was never
  read again. The object is now the first member of a struct whose second member is a sentinel that
  the program prints.

## Keen Dreams linked whole: its assembly and its resources (`tools/gate-tasm-link.mjs`, `tools/gate-link-scope.mjs`)

The build links two kinds of object that are not C:
* **the three TASM modules**;
* **eleven MakeOBJ resources** (`static/*.KDR`). Each is transcribed from `static/make.bat` and
  `makeobj.c`: mode `c` puts the file's bytes in `_DATA` of DGROUP, and mode `f` in a
  paragraph-aligned FAR_DATA segment of its own, with a public name at offset 0.

Both reach PRISM as **extern data** (compile.js `externData`). Each is one block, placed near or far
like the object it stands for, with its publics at their offsets. The blocks are placed *before* the
C resolves its externs, so `extern int px;` names the assembly's px rather than getting zeroed storage
of its own. A module is one block, not one allocation per name, because the assembly walks its own
tables across its labels. After compilation, `src/asm/tasm-link.js` loads each module's images and
binds each public PROC as a C function using Borland's calling convention:
* arguments right to left on PRISM's own stack (DGROUP at 0, so SS = DS = 0);
* a far pointer laid down as offset then segment;
* a far return address to a code segment no module uses;
* the result taken from AX or DX:AX.

**The oracle is Borland's own link.** `tests/tasm-link/link.c` calls Keen's `id_us_a.asm` and
`id_vw_a.asm`. Borland C++ 2.0 builds it: the modules are assembled with `tasm /mx`, as the project
does (bcc's own call to TASM passes `/ml`, under which id_vw_a.asm does not assemble), then linked and
run. PRISM builds the same C with the same modules. The test covers:
* an int result;
* a far string argument above 64K;
* two four-argument routines working on a "screen" in ordinary memory (screenseg is the C's to set);
* the assembly's px, py, fontcolor and bufferwidth, read and written from C.

Seven lines, identical. 5 mutations, all red. Two were green at first, because the test could not see
what they broke:
* a far pointer passed as its linear address is the same address below 64K, so a far string above
  64K was added;
* a reversed argument order is invisible with one-argument routines, so two four-argument routines
  were added.

### Found on the way, each a compiler defect before it was a Keen problem (gate-link-scope)

* **A unit's own function lost to a foreign array.** lzhuf.c has `static void update(int c)`, and
  id_rf.c defines `byte update[2][UPDATESIZE]`, which lzhuf.c never declares. The program-wide globals
  map made `update(c)` in DecodeChar a call through the array. It surfaced as "Cannot read properties
  of undefined (reading 'k')". That error had been listed among Keen's refusals since "Keen Dreams
  builds whole", whose count of five deliberate refusals was therefore wrong: there were six, and one
  was a crash.
* **A block-scope `extern` could not reach an object file's public.** USL_CtlHButtonCustom declares
  `extern char far gametext` inside the block that uses it. It now resolves to the linked symbol.

### What sharing linear 0 costs DGROUP

Under dos16m, DGROUP sits at linear 0, so it also holds real mode's own low memory: the vector table
and the BIOS data area, which Keen reads through `peek(0x40,...)`. Keen's DGROUP is 59,770 bytes of
statics, and it needs 1K of near heap (`SAVENEARHEAP`, below which MM_Startup's length underflows) with
its stack. That fitted Borland's 64K, and did not fit PRISM's layout (statics from 1000h, a 4K stack,
a 2K string gap, a 1K heap margin). The layout is now:
* statics from 500h, just above the BIOS data area;
* a 2K stack;
* a 512-byte string gap;
* a 256-byte margin between heap and stack.

The stack is smaller than Borland's because PRISM keeps most locals in JS variables. A 16-bit frame
now checks its floor, so running out is an error by name rather than a write into the heap.

With it, every Keen unit compiles, and the 17 routines the C calls are bound. The four refusals left
are deliberate. `main` runs until MM_Startup reaches MML_CheckForEMS, whose `mov dx,OFFSET emmname`
names a local. Borland 2.0 was asked what that means, and it runs as **DX = 65526**, the local's
displacement from BP (−10), **not its address (65508)**. So the real game asked DOS to open whatever
name lay at DS:FFF6.

## Hardware interrupts under a 16-bit model (`src/env/pcirq.js`, `tools/gate-pcirq.mjs`)

Keen Dreams calibrates itself against the timer. SDL_InitDelay installs its own int 8 handler, sets
the PIT to 1 ms, and waits in inline assembly for that handler to run. Nothing delivered interrupts,
so the wait never ended. The profiler found it, because assembly jumps crossed no safepoint and the
leash could not reach them.

**Time is counted in back edges.** PRISM executes no instructions it could count, but every loop
decrements `M.spBudget` on its back edge: compiled C, Borland inline assembly (whose backward `goto`s
now carry a safepoint) and translated TASM modules (every taken jump). Each edge is one virtual
microsecond. The budget is set to the number of edges left before the next event, a PIT expiry or a
scancode's arrival, so `M.sp_` runs exactly when an interrupt is due. This is a model, and it is
stated as one: a program that calibrates against it gets a consistent, reproducible answer, not a
1991 PC's.

**What is modelled, and to what rule:**
* **The 8253, counter 0:** reload, latch, and read LSB then MSB. IRQ0 is raised at each expiry.
* **The 8259:** requests are held while one of equal or higher priority is in service, released by a
  non-specific EOI, and masked through port 21h. IRQ0 goes before IRQ1. After each IRET the next
  pending request is delivered at once.
* **IF, one flag for the machine:** `disable()`/`enable()`, inline `cli`/`sti`/`popf`/`_FLAGS` and a
  TASM routine's flags all move `M.cpu.if`. The interrupt gate clears it and IRET restores it. A
  request held under CLI is delivered on STI, not at the next expiry.
* **An `interrupt` function begins with the interrupted code's registers**, as Borland's prologue
  pushes them. So `TimerVal = _CX` in SDL_TimingService reads the CX of the loop it interrupted. That
  was one of Keen's deliberate refusals; now it is simply what the function means.
* **The BIOS's own int 8 and int 9** sit in the vector table until the program replaces them: the tick
  at 0040:006C, and keys for int 16h.
* **The keyboard:** scancodes from the harness, with the virtual time they arrive at, each latched on
  port 60h and announced by IRQ1.
* **The display's timing on port 3DAh:** 70 Hz frames of 449 lines, vertical retrace on bit 3, blanking
  on bit 0.

**The oracle is the hardware's rules, not an emulator.** PRISM's time is its own, so no DOSBox run can
be compared with it cycle for cycle. `tests/pcirq/irq.c` prints one number per property, each with a
value the hardware fixes:
* the BIOS tick advances;
* a counting handler runs while IF is set;
* nothing is delivered under CLI, and the held request is delivered on STI;
* a handler without EOI is entered once;
* an interrupt function's CX is the interrupted loop's;
* scancodes arrive in order;
* vertical retrace comes 70 times a second;
* IRQ0 is served before IRQ1.

Nine checks, all green; 10 mutations, all red. Three of them were not red at first:
* **IRQ1 before IRQ0** stayed green until a section left both pending under CLI.
* **A 60 Hz retrace** stayed green while the window was 100 ms, where 60 Hz and 70 Hz both allow 6;
  the window is now a second.
* **The priority section's first run was a real defect** ("priority 0 0"): after an IRET the pending
  IRQ1 waited for the next safepoint, by which time a new tick was due. The PIC raises INTR at once,
  so delivery now loops until nothing deliverable remains.

**Keen Dreams with it:** SDL_InitDelay completes, the data loads, the startup text screen reads "Ready
- Press a Key", a queued space reaches INL_KeyService on int 9, and the title sequence runs. The
DemoLoop runs its screens and waits by TimeCount, which SDL_t0Service advances at 70 Hz. Two
refusals remain, both deliberate: USL_HardError reads the DI a DOS critical error leaves, and
sys_errlist is Borland's wording.

## The EGA behind A000h (`src/env/ega.js`, `tools/gate-ega.mjs`), and Keen Dreams' first pictures

In the EGA's window, an access does not mean what memory means. A read loads four latches and returns
one plane, or colour-compare bits. A write reaches up to four planes through:
* the Map Mask;
* Set/Reset;
* the data rotate and the logical function against the latch;
* the Bit Mask;
* or, in write mode 1, simply the latches.

An address translation (the `paged` mechanism) can say none of that, so the window is a **device
hook** that every path goes through:
* **compiled C**, with the `window` compile option (on when the target names env `ega`): each integer
  load or store is `_r8u/_r16s/_w16...`, one comparison outside A0000h–AFFFFh and `M.win` inside it.
  Borland inline assembly goes through the same accessors;
* **the TASM modules'** `rb/rw/wb/ww`;
* **the runtime's block copies and fills** (`memcpy`/`memset`, `_fmemcpy`/`_fmemset`/`movedata`), byte
  by byte when a range touches the window.

The device keeps the four planes, the sequencer, the graphics controller, the CRTC's start address
and offset, and the attribute controller: its index/data flip-flop, which a read of 3DAh resets, its
palette and its pel panning. `frame()` renders mode 0Dh from these. int 10h sets modes and palettes
through it.

**The oracle is DOSBox's EGA.** `tests/ega/ega.c` sets mode 0Dh and exercises each path, then reads
every plane back through Read Map Select:
* Map Mask;
* Set/Reset with and without Enable;
* Bit Mask over latched data;
* AND with rotate 1, OR, XOR with rotate 4;
* write mode 1's latch copy;
* write mode 2;
* read mode 1 with and without Colour Don't Care.

Borland C++ 2.0 builds it and DOSBox-X runs it; PRISM prints the same 11 lines. 7 mutations, all red:
OR computed as XOR, rotate to the left, the bit mask ignored, mode 1 writing the CPU byte, the colour
compare inverted, the map mask ignored, and the C window turned off.

**Keen Dreams draws.** `tools/keen.mjs --data=<dir> --keys=2000:57,2100:185` runs it headless. The
data directory holds the game's files, which are not in this repository. The run shows:
1. the startup text screen;
2. a space pressed;
3. the title "Gamer's Edge presents Commander Keen in Keen Dreams", unpacked by gelib.c from
   KDREAMS.CMP to an off-screen page and copied by VW_ScreenToScreen's latches;
4. the high-score window, drawn in the proportional font by VW_DrawPropString. The DemoLoop
   alternates the two on TimeCount.

A picture taken while the leash cut the run showed the title in other colours. Taken right after each
VW_ScreenToScreen, the title is identical every time. The first picture had been caught mid-draw;
nothing is wrong with the colours.

**Not yet referenced:** the pictures are held to DOSBox only through gate-ega's register paths, not
pixel for pixel against the real KDREAMS.EXE. MIRAGE's grabber (a TSR on int 8) cannot reach Keen's
screens, because Keen replaces int 8 without chaining it.

### Keen Dreams plays -- and the data check that was too weak

Pressing Enter at the title opens the control panel, and Enter again starts a game. The game shows
"Loading The Land of Tuberia" and then the world map, with Keen, the flags, the water and the status
bar. `tools/keen.mjs --data=<dir> --static=<dir>/static --keys=2000:57,2100:185,5000:28,5100:156,7000:28,7100:156`
gets there.

On the way it crashed with "call through a non-function pointer 0xc2002800" inside SDL_t0Service. A
watch on the stores into SoundUserHook caught RF_NewMap filling `mapbwidthtable` about 5,000 entries
past its end: map 0's header had been read as 52480x16555. **The shareware data does not match the
1.93 source's map headers.** Its graphics and audio do: EGAHEAD's last offset is KDREAMS.EGA's size,
and six of static/'s files appear byte for byte in the 1.13 executable. But 1.13's KDREAMS.MAP was
saved differently, and its headers are Huffman-coded with a different MAPDICT. The earlier check,
"every MAPHEAD offset falls inside the file", could not have failed on that. A header that decodes
into a map of plausible size with a name made of letters is what can fail, and does.

The source's README names the remedy: link the static data that matches the data set.
`tools/keen-static.mjs` unpacks the data set's own KDREAMS.EXE (`tools/lzexe.mjs`, LZEXE 0.91) and
reports which of static/'s files it contains. It finds that build's MAPHEAD, the RLEW tag followed by
offsets inside the map file, and its MAPDICT, which must decode all 18 headers into sizes and names
("LAND OF TUBERIA" through "CASTLE TUBERIA"). A first version accepted a dictionary that decoded the
names into strings of `:` and `/`, all of them printable; requiring letters and a plausible size
rejects it. The two files are written into the data directory, never into this repository.
1.13's GAMETEXT (the help text) also differs and is not extracted: it is only read by the control
panel's help screen.

## Catacomb 3-D's assembly, and the gate made per game (`tools/gate-tasm-front.mjs --game=cat3d`)

The second 16-bit target is the same engine generation as Keen Dreams, and its four TASM modules
(`C3_ASM`, `ID_US_A`, `ID_VW_A` with `ID_VW_AE`, `JABHACK`) went through the same gate — which now
runs per game, each against its own golden (`goldens/tasm-keen.json`, `goldens/tasm-cat3d.json`).
All four agree with Turbo Assembler 2.5 on every public, every data and FAR_DATA byte and relocation,
and the offset, length and segment register of all 1,601 instructions.

### What TASM does that this corpus had to teach

Each of these was found by the listing, not by reading a manual:

* **EVEN in DATASEG**, at offset 0, pads nothing. What TASM pads DATA with at an odd offset has not
  been observed, so that case is refused by name rather than filled with a guessed byte.
* **FARDATA offsets are final and carry no relocation.** `mov [es:rndindex],dx` is `26 89 16 0000`
  with no fixup marker, so a small FARDATA offset is a BYTE displacement: `mov al,[es:rndtable+bx]`
  is `26 8A 47 02`, four bytes where a relocated operand would take five. `SEG rndtable` is the
  segment's paragraph, a relocation of the other kind (frame 5, target FAR_DATA).
* **Under `.386C` a forward conditional jump reserves the 386's near form**: `jz not386` is
  `74 15 90 90`, four bytes, where the 8086's one-pass rule gives two. A forward `jmp` is still three.
  32-bit operands cost the operand-size prefix, and `shr edx,16` is the `C1` form.
* **The listing changes shape under `.386C`**: the offset column becomes eight wide and the object
  bytes move four columns right. The listing reader first parsed ZERO instructions from JABHACK and
  crashed on `ins.at(-1)`; it now detects the wider field on each line.
* **`MODEL MEDIUM` without `,C` makes no underscores.** JABHACK declares `PROC _CheckIs386` and
  `EXTRN _intaddr`; the object's names are exactly those. The gate derives the object name from the
  model's language rather than always prefixing `_`.

And one thing that looked like a gap and was not: `if NUMFONT+NUMFONTM` in `ID_VW_AE.ASM` failed
with "two addresses in one expression" in the first survey, because the survey assembled that file
alone. It is INCLUDEd by `ID_VW_A.ASM` after the equates are defined, and never assembled on its own.

### A machine that is a 286, and refusals that wait to be executed

`JABHACK.ASM` tests the processor (PUSHF/POPF with FLAGS bits 12-15) and, on a 386, patches Borland's
long-division helper `LDIV@` to an `int 60h` handler that divides with a 32-bit IDIV. PRISM's
translation of PUSHF has always masked bits 12-15 to zero, which is a 286 in real mode — so the
program's OWN test answers "not a 386", and the 386 path is never taken.

Its instructions still have to translate, and some cannot: the 32-bit arithmetic, the `SEG` of an
external no linked object defines (`LDIV@` is Borland's run-time, which PRISM's C never calls), and
two reads of the module's own instruction bytes, which are not encoded. Each becomes a statement
that throws by name **only if executed**, and `installTasm` lists them. Refusing them at translation
time would have refused the whole module, and with it `CheckIs386`, which runs.

### Mutations, all red (8)

| mutation | what turns red |
|---|---|
| 386 forward `jcc` sized as on the 8086 | 43 instruction offsets in JABHACK |
| no operand-size prefix | 9 offsets |
| `C1` shift sized as `D1` | 5 offsets |
| FARDATA offset left to a relocation | 4 offsets in ID_US_A (the byte displacement is lost) |
| FARDATA written into DGROUP | the FAR_DATA segment, and 3 more checks |
| EVEN in data always pads | C3_ASM's data segment, 3,301 bytes against 3,300 |
| publics always underscored | JABHACK's two public names |
| `.386C` ignored | JABHACK's layout refuses `eax`; its operands |

## Three verdicts, and what two permanently red gates were hiding (`tools/gates.mjs`, `tools/gate-skip.mjs`)

For weeks the full run read "50 of 52 green", and the two reds were read as "the usual". That is the
failure mode worth naming: a gate that is always red stops being read, and a real failure next to it
goes unseen. So a gate now has three answers, not two. **PASS** (exit 0), **FAIL** (any other
non-zero), and **SKIP** (exit 77, automake's code): *I could not run, for want of something this
repository does not ship* — a corpus fetched separately, game data the user supplies, a package in
the oracle container — said with what is missing and how to supply it. `tools/gates.mjs` runs every
gate and exits non-zero only on a FAIL. A missing GOLDEN, which the repository does commit, or a
probe that fails, stays a FAIL: those mean the tree is broken.

The positive control: a gate that exits 1 is reported `FAIL` and the runner exits 1; the six
converted sites each print `SKIP:` and exit 77 when their resource is absent.

**On a fresh clone** (CI, `.github/workflows/gates.yml`) most gates find out by throwing, not by
checking. `tools/gates.mjs` starts each gate with `tools/gate-preload.mjs`, which turns exactly two
errors into a SKIP: an error with code `PRISM_MISSING` (a target's source tree, from src/target.js;
the oracle container not built or no Docker, from tools/oracle.mjs) and an `ENOENT` for a path under
`corpus/`. Every other error stays a FAIL. The controls, run directly: a plain `throw` exits 7, and so
does a missing file under `goldens/`; `PRISM_MISSING`, thrown or rejected, and a missing
`corpus/` file exit 77. A fresh clone with no Docker: 33 pass, 54 skip, 0 fail. Gates that catch
their own errors per case check for the corpus first: `gate-tasm-front`, `gate-tasm-link`, and
`gate-pp-sizeof`, which still checks Borland's side without the corpus.

### The two reds, taken apart

**`gate-pixels` was never failing.** It exited 2 for want of `--data`. Given Quake's data
(`PRISM_QUAKE_DATA=<dir with id1/>`) it is green: all three asserted comparisons identical, SunOS
reported and not asserted, as designed. Without the data it now SKIPS.

**`gate-lua` was failing, and on a real defect — which was covering five more.** `files.lua:804`
failed `checkDateTable(os.time())`. Taken apart one field at a time:

1. **`mktime` did not write its argument.** C99 7.23.2.3: out-of-range fields are normalised and
   `tm_wday`/`tm_yday` are filled in. Lua's `os.time` copies the normalised struct back into the
   caller's table, so the weekday it read was whatever the stack held. A wrong answer, not a
   refusal — `gate-run` now carries `mktime-normalises` (January 32nd, 25:61, against gcc), red
   without the fix.

With the dates right the failure moved to line 675, **inside the file tests — which had been
SKIPPED ALL ALONG.** files.lua prints "'os.tmpname' file cannot be open; skipping file tests" and
carries on; the verdict never saw it because the later failure came first. Four defects sat under it:

2. **`/tmp` was seeded in the wrong namespace.** The store strips a path's leading slash, so
   tmpnam's `/tmp/prismN` is looked up as `tmp/...` — and the directory set had been seeded with
   `'/tmp'`. Every temporary file was refused, since the day directories were introduced.
3. **A reader's bytes were a snapshot taken at open.** Two handles on one file are two descriptors
   on one inode; a reader opened before a write never saw it. An open file's bytes are now read
   through the store on every access.
4. **`setvbuf` was ignored.** Buffering is now honoured when the program asks for it — full, line or
   none, flushed on a full buffer, a newline, `fflush`, `fclose`, a seek, and the end of `run()` —
   and the DEFAULT stays unbuffered, because C99's "fully buffered unless interactive" would change
   every target at once (ROADMAP P8.11).
5. **`tmpfile` answered NULL**, as something "this host genuinely cannot provide". Once (2) was
   fixed it could: a unique name opened `w+b`, removed at close.

What is left is pinned, not forgiven. files.lua's `if not _port` blocks assume a Linux host, and the
first of them shells out to `cat`, `ls` and `kill` — the host's shell, which is why `main.lua` is
skipped by name, and which a `LUA_USE_C89` build does not compile `popen` for. So files.lua must stop
EXACTLY at line 732; stopping anywhere else is red, and passing is red too, so that the entry is
deleted rather than left to excuse something later. And what that stop hides is still run: files.lua
a second time with `_port = true`, the suite's own switch for a non-Linux host, reaches its last
line.

Found in passing, not fixed here: `atexit` records its handlers and nothing runs them (ROADMAP P8.12).
