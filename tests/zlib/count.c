/* How far the imitation's input count is from zlib's: total_in after every inflate call. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
static unsigned char *slurp(const char *name, unsigned *size)
{
	FILE *f = fopen(name, "rb"); unsigned char *p;
	if (!f) return 0;
	fseek(f, 0, SEEK_END); *size = ftell(f); fseek(f, 0, SEEK_SET);
	p = malloc(*size + 1); fread(p, 1, *size, f); fclose(f);
	return p;
}
int main(int argc, char **argv)
{
	static const unsigned pieces[] = { 16384, 257, 7 };
	int n, count = atoi(argv[1]);
	unsigned room = argc > 2 ? atoi(argv[2]) : 0;   /* 0: all the room at once */
	unsigned k;
	char name[32];
	for (n = 0; n < count; n++) {
		unsigned raw_size, plain_size;
		unsigned char *raw, *plain, *out;
		sprintf(name, "raw.%d", n); raw = slurp(name, &raw_size);
		sprintf(name, "plain.%d", n); plain = slurp(name, &plain_size);
		out = malloc(plain_size + 16);
		for (k = 0; k < 3; k++) {
			z_stream s; unsigned at = 0; int err = Z_OK, calls = 0;
			s.zalloc = 0; s.zfree = 0; s.opaque = 0; s.next_in = 0; s.avail_in = 0;
			s.next_out = out; s.avail_out = room ? 0 : plain_size;
			inflateInit2(&s, -MAX_WBITS);
			/* A caller that keeps what was not consumed, as zlib's contract asks. */
			while (err == Z_OK && calls < 100000) {
				unsigned take = raw_size - at < pieces[k] ? raw_size - at : pieces[k];
				if (s.avail_in == 0) { s.next_in = raw + at; s.avail_in = take; at += take; }
				if (room && s.avail_out == 0) { unsigned left = plain_size - s.total_out; s.avail_out = left < room ? left : room; }
				err = inflate(&s, Z_NO_FLUSH);
				printf("%d/%u #%d in %lu out %lu left %u err %d\n", n, pieces[k], calls++, s.total_in, s.total_out, s.avail_in, err);
				if (at >= raw_size && s.avail_in == 0 && err == Z_OK) { static unsigned char dummy; s.next_in = &dummy; s.avail_in = 1; }
			}
			inflateEnd(&s);
		}
	}
	return 0;
}
