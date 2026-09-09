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
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc tcc libc6-dev make csmith m4 curl ca-certificates xz-utils \
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
