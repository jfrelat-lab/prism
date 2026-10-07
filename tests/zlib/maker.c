/*
 * maker.c — the streams tools/gate-zlib.mjs feeds to probe.c, made by zlib itself.
 *
 * Linked with zlib 1.1.3's own sources only. For each of a few kinds of data it writes `plain.N`,
 * `raw.N` (a bare deflate stream, as inside a zip: deflateInit2 with a negative window) and
 * `wrap.N` (compress2: the same behind zlib's header), at a compression level chosen so that the
 * three kinds of block all occur: stored (level 0), fixed codes (short inputs) and dynamic codes.
 * Prints how many it made.
 *
 * The gate also runs it twice -- compiled by PRISM and by gcc -- and wants the files identical,
 * which holds PRISM's build of zlib's DEFLATE to gcc's, byte for byte.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "zlib.h"

static unsigned long seed = 12345;
static unsigned rnd(void) { seed = seed * 1103515245UL + 12345UL; return (unsigned)(seed >> 16) & 0x7fff; }

static void put(const char *kind, int n, const unsigned char *p, unsigned long size)
{
	char name[32];
	FILE *f;
	sprintf(name, "%s.%d", kind, n);
	f = fopen(name, "wb");
	fwrite(p, 1, size, f);
	fclose(f);
}

static void make(int n, const unsigned char *plain, unsigned long size, int level, int strategy)
{
	unsigned long room = size + size / 1000 + 64 + 5 * (size / 16384 + 1), wrapped = room;
	unsigned char *raw = malloc(room), *wrap = malloc(room);
	z_stream c;
	int err;
	c.zalloc = 0; c.zfree = 0; c.opaque = 0;
	err = deflateInit2(&c, level, Z_DEFLATED, -MAX_WBITS, 8, strategy);
	c.next_in = (Bytef *)plain; c.avail_in = size;
	c.next_out = raw; c.avail_out = room;
	if (err == Z_OK) err = deflate(&c, Z_FINISH);
	if (err != Z_STREAM_END) { printf("%d: deflate said %d\n", n, err); exit(1); }
	deflateEnd(&c);
	if (compress2(wrap, &wrapped, plain, size, level) != Z_OK) { printf("%d: compress2 failed\n", n); exit(1); }
	put("plain", n, plain, size);
	put("raw", n, raw, c.total_out);
	put("wrap", n, wrap, wrapped);
	free(raw); free(wrap);
}

int main(void)
{
	static unsigned char big[300000];
	static const char words[] = "MAME is an emulator: it reproduces, more or less faithfully, the behaviour of several arcade machines. ";
	unsigned i;
	int n = 0;

	/* 0: nothing at all.  1: one byte.  2: a sentence -- short enough for fixed codes. */
	make(n++, big, 0, 6, Z_DEFAULT_STRATEGY);
	big[0] = 'x';
	make(n++, big, 1, 6, Z_DEFAULT_STRATEGY);
	make(n++, (const unsigned char *)words, sizeof words - 1, 6, Z_DEFAULT_STRATEGY);

	/* 3, 4: text that repeats, squeezed hard and squeezed fast: long matches, far distances. */
	for (i = 0; i < 200000; i++) big[i] = words[(i + (i >> 9)) % (sizeof words - 1)];
	make(n++, big, 200000, 9, Z_DEFAULT_STRATEGY);
	make(n++, big, 200000, 1, Z_DEFAULT_STRATEGY);

	/* 5: the same, not compressed: stored blocks, more than one of them. */
	make(n++, big, 200000, 0, Z_DEFAULT_STRATEGY);

	/* 6: noise, which deflate gives up on and stores.  7: Huffman codes and no matches. */
	for (i = 0; i < 100000; i++) big[i] = rnd() & 255;
	make(n++, big, 100000, 6, Z_DEFAULT_STRATEGY);
	for (i = 0; i < 100000; i++) big[i] = "aaaabbbccd"[rnd() % 10];
	make(n++, big, 100000, 6, Z_HUFFMAN_ONLY);

	/* 8: a ROM's shape -- runs of one value, tables, code -- over the 32 KB window more than once. */
	for (i = 0; i < 300000; i++) big[i] = i < 40000 ? 0xff : i < 90000 ? (i >> 3) & 255 : i < 200000 ? rnd() & 15 : (i * 7) & 255;
	make(n++, big, 300000, 6, Z_DEFAULT_STRATEGY);

	printf("%d\n", n);
	return 0;
}
