# The external oracle for every PRISM gate.
#
# This host is arm64 macOS: there is no gcc, no -m32, and no csmith. Every claim about C
# semantics, preprocessor output and i386 ABI layout therefore has to be answered by a real
# 32-bit toolchain, and this image IS that toolchain. linux/386 (not amd64 + -m32) so that
# compiled programs also RUN here — the differential gates need output, not just object files.
FROM i386/debian:bookworm-slim

# `tcc` is here for ONE reason, and it is a compatibility one rather than a speed one: gcc 12
# refuses `case MRA_RAM:` -- a cast pointer constant as a case label, which gcc 2.7 on DJGPP
# accepted -- and those four labels in MAME 0.4's src/machine.c are the ONLY thing a modern gcc
# rejects in that whole release. Open Watcom, already below, takes the case labels and then refuses
# `unsigned char *line[0]` in osdepend.h in every mode including -za, so it cannot stand in either.
# tcc accepts both, links, and runs. Without it MAME 0.4 has no native oracle at all.
# `g++` is the oracle for PRISM's C++ (2026-10-03, first for ET's splines/): every C++ case is held to
# the same program built by g++ -m32 here. Added to the existing image with apt-get + docker commit
# rather than a rebuild, which would also fetch a newer Open Watcom snapshot than the gates were run on.
# libsdl1.2-dev and libsdl-mixer1.2-dev are here for their HEADERS and nothing else: no SDL is ever
# linked or run in this image. src/env/headers-sdl12.js declares SDL 1.2 itself, because a guest is
# compiled against PRISM's declarations rather than a copy of SDL's -- which makes every offset
# PRISM's responsibility, and the kind that fails silently. tools/gate-sdl12abi.mjs builds one probe
# twice, here against the genuine headers and in PRISM against ours, and diffs the two. Without
# these packages that gate has nothing to be right about.
# SDL 2 and SDL_image ARE linked and run here (2026-10-04), with SDL's dummy video and audio drivers:
# src/env/sdl2-surface.js and sdl2-image.js are held to the libraries themselves (gate-sdl2-surface,
# gate-sdl2-image), and SDLPoP built against them is the pixel reference for SDLPoP on PRISM
# (gate-sdlpop-pixels, with tools/oracle/sdl2-capture.c preloaded). So is SDL_mixer 1.2, for
# gate-sdl-mixer. libsdl2-image-dev was added to the existing image with apt-get + docker commit.
# OSMesa (Mesa 22.3.6, as the EGL path) gives the GL gates the one thing an EGL framebuffer object
# lacks: an accumulation buffer (tools/oracle/glut-egl.c, GLUT_ACCUM). Added with apt-get + docker commit.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc g++ tcc libc6-dev make csmith m4 curl ca-certificates xz-utils \
      libsdl1.2-dev libsdl-mixer1.2-dev \
      libsdl2-dev libsdl2-image-dev \
      libosmesa6-dev \
 && rm -rf /var/lib/apt/lists/*

# Debian's csmith package ships the GENERATOR but none of the runtime headers its output
# #includes, and three of those headers do not exist in the source tree either — they are m4
# templates the upstream build expands. So fetch the pinned runtime tree and run the same rule
# upstream's runtime/Makefile.am uses ($(M4) < $< > $@).
ARG CSMITH_TAG=csmith-2.3.0
RUN curl -sL "https://github.com/csmith-project/csmith/archive/refs/tags/${CSMITH_TAG}.tar.gz" \
      | tar xz -C /tmp \
 && mkdir -p /usr/include/csmith \
 && cp /tmp/csmith-${CSMITH_TAG}/runtime/*.h /usr/include/csmith/ \
 && for m in safe_math safe_math_macros safe_math_macros_notmp; do \
      m4 < /tmp/csmith-${CSMITH_TAG}/runtime/$m.m4 > /usr/include/csmith/$m.h; \
    done \
 && rm -rf /tmp/csmith-${CSMITH_TAG}

ENV CSMITH_INCLUDE=/usr/include/csmith

# ---------------------------------------------------------------- Open Watcom
#
# A SECOND compiler, and the only one that answers for the toolchain three of the corpus programs
# were actually built with: Heretic, Hexen and OpenDUNE are Watcom/DOS4GW programs, and gcc cannot
# say what Watcom lays out or how a `#pragma aux` routine is called. It also hosts the 16-bit
# compiler (wcc, -0), which is the one thing this container had no answer for at all.
#
# The SNAPSHOT tarball, not the installer: the installer is a self-extracting binary that dies with
# SIGFPE under this platform's qemu-user, while the plain tree runs fine -- `wcc386 -h` prints its
# banner and a compiled Linux binary runs. Only the parts a compiler needs are kept; the full tree is
# 521 MB, most of it Windows and OS/2 hosted tools this image can never run.
ARG WATCOM_URL=https://github.com/open-watcom/open-watcom-v2/releases/download/Last-CI-build/ow-snapshot.tar.xz
RUN curl -sL "${WATCOM_URL}" -o /tmp/ow.tar.xz \
 && mkdir -p /opt/watcom \
 && tar xJf /tmp/ow.tar.xz -C /opt/watcom \
      ./binl ./h ./lh ./lib386 ./lib286 \
 && rm -f /tmp/ow.tar.xz

ENV WATCOM=/opt/watcom
ENV PATH=/opt/watcom/binl:$PATH
ENV INCLUDE=/opt/watcom/lh
ENV EDPATH=/opt/watcom/eddat

WORKDIR /work
