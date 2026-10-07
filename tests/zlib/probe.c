/*
 * probe.c — what MAME 0.37b5 asks of zlib, asked of whichever zlib this is linked with.
 *
 * Built twice by tools/gate-zlib.mjs: with zlib 1.1.3's own sources, and with PRISM's imitation
 * (the `zlib` environment). It reads streams the gate prepared -- `raw.N` is a bare deflate stream
 * as a zip member holds one, `wrap.N` the same data behind zlib's header -- and prints, for each,
 * what the library returned and a checksum of what it produced. The two builds must print the same.
 *
 * The inflate loop is src/unzip.c's inflate_file to the letter: the input in pieces of a fixed
 * size, refilled without looking at what was left, one dummy byte after the last. The piece size
 * is varied so that pieces end inside codes, inside tables and inside stored runs.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

static unsigned char *slurp(const char *name, unsigned *size)
{
	FILE *f = fopen(name, "rb");
	unsigned char *p;
	if (!f) return 0;
	fseek(f, 0, SEEK_END);
	*size = ftell(f);
	fseek(f, 0, SEEK_SET);
	p = malloc(*size + 1);
	fread(p, 1, *size, f);
	fclose(f);
	return p;
}

/* unzip.c's loop, over memory instead of a FILE. */
static int inflate_pieces(const unsigned char *in, unsigned in_size, unsigned char *out_data, unsigned out_size, unsigned piece, unsigned *written)
{
	int err;
	unsigned char *in_buffer;
	z_stream d_stream;
	d_stream.zalloc = 0;
	d_stream.zfree = 0;
	d_stream.opaque = 0;
	d_stream.next_in = 0;
	d_stream.avail_in = 0;
	d_stream.next_out = out_data;
	d_stream.avail_out = out_size;
	err = inflateInit2(&d_stream, -MAX_WBITS);
	if (err != Z_OK) return err;
	in_buffer = malloc(piece + 1);
	for (;;)
	{
		unsigned take = in_size < piece ? in_size : piece;
		if (in_size <= 0) { free(in_buffer); inflateEnd(&d_stream); return -100; }
		memcpy(in_buffer, in, take);
		in += take;
		d_stream.next_in = in_buffer;
		d_stream.avail_in = take;
		in_size -= take;
		if (in_size == 0) { in_buffer[take] = 0; d_stream.avail_in++; }   /* the dummy byte */
		err = inflate(&d_stream, Z_NO_FLUSH);
		if (err == Z_STREAM_END) break;
		if (err != Z_OK) { free(in_buffer); inflateEnd(&d_stream); return err; }
	}
	*written = d_stream.total_out;
	err = inflateEnd(&d_stream);
	free(in_buffer);
	return err;
}

int main(int argc, char **argv)
{
	static const unsigned pieces[] = { 16384, 1000, 257, 7, 1 };
	int n, count = argc > 1 ? atoi(argv[1]) : 0;
	unsigned k;
	char name[32];

	/* The checksums, on their own: the empty buffer, the null one, one byte, a carried-on sum. */
	{
		static const unsigned char text[] = "The quick brown fox jumps over the lazy dog";
		unsigned long c = crc32(0L, Z_NULL, 0), a = adler32(0L, Z_NULL, 0);
		printf("init crc %08lx adler %08lx\n", c, a);
		printf("fox  crc %08lx adler %08lx\n", crc32(c, text, 43), adler32(a, text, 43));
		c = crc32(c, text, 10); c = crc32(c, text + 10, 33);
		a = adler32(a, text, 10); a = adler32(a, text + 10, 33);
		printf("cont crc %08lx adler %08lx\n", c, a);
		printf("one  crc %08lx adler %08lx\n", crc32(0x12345678L, text, 1), adler32(0xfff0fff0L, text, 1));
	}

	for (n = 0; n < count; n++)
	{
		unsigned raw_size, wrap_size, plain_size, written;
		unsigned char *raw, *wrap, *plain, *out;
		unsigned long len;
		int err;
		sprintf(name, "raw.%d", n);   raw = slurp(name, &raw_size);
		sprintf(name, "wrap.%d", n);  wrap = slurp(name, &wrap_size);
		sprintf(name, "plain.%d", n); plain = slurp(name, &plain_size);
		if (!raw || !wrap || !plain) { printf("%d: missing\n", n); return 1; }
		out = malloc(plain_size + 16);

		for (k = 0; k < sizeof pieces / sizeof *pieces; k++)
		{
			written = 0;
			memset(out, 0x5a, plain_size + 16);
			err = inflate_pieces(raw, raw_size, out, plain_size, pieces[k], &written);
			printf("%d raw/%u: %d wrote %u crc %08lx same %d guard %d\n", n, pieces[k], err, written,
				crc32(0L, out, written), written == plain_size && memcmp(out, plain, plain_size) == 0, out[plain_size] == 0x5a);
		}

		/* uncompress, as png.c calls it: exactly enough room, then one byte too little. */
		len = plain_size;
		err = uncompress(out, &len, wrap, wrap_size);
		printf("%d uncompress: %d len %lu crc %08lx\n", n, err, len, crc32(0L, out, len));
		if (plain_size > 0)
		{
			len = plain_size - 1;
			printf("%d uncompress, a byte short of room: %d\n", n, uncompress(out, &len, wrap, wrap_size));
			len = plain_size;
			printf("%d uncompress, input cut: %d\n", n, uncompress(out, &len, wrap, wrap_size - 5));
			wrap[wrap_size - 1] ^= 1;
			len = plain_size;
			printf("%d uncompress, checksum off by a bit: %d\n", n, uncompress(out, &len, wrap, wrap_size));
			wrap[wrap_size - 1] ^= 1;
		}

		/* A stream that is not one. */
		written = 0;
		raw[raw_size / 2] ^= 0xff;
		err = inflate_pieces(raw, raw_size, out, plain_size, 16384, &written);
		printf("%d raw, a byte flipped: %s\n", n, err == Z_OK && written == plain_size && memcmp(out, plain, plain_size) == 0 ? "unnoticed" : "refused or different");
		raw[raw_size / 2] ^= 0xff;

		/*
		 * compress, as png.c calls it to write a snapshot: the stream is this library's own business
		 * (a stored one is as valid as a squeezed one), so what is printed is only that it fits the
		 * room compress asks for and comes back. The bytes go to a file the gate hands to the OTHER
		 * library to expand.
		 */
		{
			unsigned long room = plain_size + plain_size / 1000 + 12 + 5 * (plain_size / 65535 + 1), back = plain_size;
			unsigned char *packed = malloc(room);
			FILE *f;
			err = compress(packed, &room, plain, plain_size);
			printf("%d compress: %d\n", n, err);
			err = uncompress(out, &back, packed, room);
			printf("%d compress then uncompress: %d len %lu same %d\n", n, err, back, back == plain_size && memcmp(out, plain, plain_size) == 0);
			sprintf(name, "packed.%d", n);
			f = fopen(name, "wb");
			fwrite(packed, 1, room, f);
			fclose(f);
			free(packed);
		}

		/* ...and one the gate left from the other library, when it has: `other.N`. */
		{
			unsigned other_size;
			unsigned char *other;
			sprintf(name, "other.%d", n);
			other = slurp(name, &other_size);
			if (other)
			{
				len = plain_size;
				err = uncompress(out, &len, other, other_size);
				printf("%d the other library's compress: %d same %d\n", n, err, len == plain_size && memcmp(out, plain, plain_size) == 0);
				free(other);
			}
		}
		free(raw); free(wrap); free(plain); free(out);
	}
	return 0;
}
