# The external oracle for every PRISM gate.
#
# This host is arm64 macOS: there is no gcc, no -m32, and no csmith. Every claim about C
# semantics, preprocessor output and i386 ABI layout therefore has to be answered by a real
# 32-bit toolchain, and this image IS that toolchain. linux/386 (not amd64 + -m32) so that
# compiled programs also RUN here — the differential gates need output, not just object files.
FROM i386/debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc libc6-dev make csmith m4 curl ca-certificates \
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

WORKDIR /work
