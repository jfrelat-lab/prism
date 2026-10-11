// sdl12-image.js — SDL_image 1.2's loader, as C over the program's own libjpeg.
//
// SDL_image is a library over other libraries: a file's first bytes choose the loader, and the JPEG
// one is libjpeg's API driven the way IMG_jpg.c drives it. So it is C here too, linked with the IJG
// library compiled from its source (targets list corpus/jpeg-6b's decompression objects, as
// tools/jpeg6b-configure.mjs prints them), and what the program gets is what libjpeg decodes:
//
//   a colour JPEG becomes a 24-bit surface, bytes R, G, B (masks 0x0000FF, 0x00FF00, 0xFF0000 on a
//   little-endian machine), decoded with libjpeg's defaults -- the slow integer IDCT and fancy
//   upsampling (IMG_jpg.c's FAST_JPEG is not defined in a stock build);
//   a four-component (CMYK) one becomes a 32-bit surface of libjpeg's CMYK samples;
//   a file libjpeg refuses fails with "JPEG loading error", libjpeg's own messages silenced.
//
// PNG goes back to src/env/sdl12.js, which makes the surface IMG_png.c would (prism_IMG_LoadPNG).
// The env is `sdlimage12`: a target that names it links this unit, and with it libjpeg's API.

export const SDL12_IMAGE_C = `
#include <stdio.h>
#include <string.h>
#include <setjmp.h>
#include <SDL.h>
#include <SDL_image.h>
#include <jpeglib.h>

/* From sdl12.js: an RWops' bytes (the handle consumed), and a PNG's surface. */
unsigned char *prism_RW_bytes(SDL_RWops *src, int *len);
SDL_Surface *prism_IMG_LoadPNG(const unsigned char *data, int len);

/* A source manager over bytes in memory; past the end, a fake EOI, as libjpeg's own advise. */
static const JOCTET prism_eoi[2] = { 0xFF, JPEG_EOI };
static void prism_init_source(j_decompress_ptr cinfo) { (void)cinfo; }
static boolean prism_fill_input_buffer(j_decompress_ptr cinfo)
{
    cinfo->src->next_input_byte = prism_eoi;
    cinfo->src->bytes_in_buffer = 2;
    return TRUE;
}
static void prism_skip_input_data(j_decompress_ptr cinfo, long n)
{
    if (n <= 0) return;
    while (n > (long)cinfo->src->bytes_in_buffer) {
        n -= (long)cinfo->src->bytes_in_buffer;
        prism_fill_input_buffer(cinfo);
    }
    cinfo->src->next_input_byte += n;
    cinfo->src->bytes_in_buffer -= n;
}
static void prism_term_source(j_decompress_ptr cinfo) { (void)cinfo; }

struct prism_jpeg_error { struct jpeg_error_mgr pub; jmp_buf escape; };
static void prism_error_exit(j_common_ptr cinfo) { longjmp(((struct prism_jpeg_error *)cinfo->err)->escape, 1); }
static void prism_output_message(j_common_ptr cinfo) { (void)cinfo; }

static SDL_Surface *prism_IMG_LoadJPG(const unsigned char *data, int len)
{
    struct jpeg_decompress_struct cinfo;
    struct prism_jpeg_error jerr;
    struct jpeg_source_mgr src;
    SDL_Surface *volatile surface = NULL;
    JSAMPROW row;

    cinfo.err = jpeg_std_error(&jerr.pub);
    jerr.pub.error_exit = prism_error_exit;
    jerr.pub.output_message = prism_output_message;
    if (setjmp(jerr.escape)) {
        jpeg_destroy_decompress(&cinfo);
        if (surface) SDL_FreeSurface(surface);
        SDL_SetError("JPEG loading error");
        return NULL;
    }
    jpeg_create_decompress(&cinfo);
    src.init_source = prism_init_source;
    src.fill_input_buffer = prism_fill_input_buffer;
    src.skip_input_data = prism_skip_input_data;
    src.resync_to_restart = jpeg_resync_to_restart;
    src.term_source = prism_term_source;
    src.next_input_byte = data;
    src.bytes_in_buffer = len;
    cinfo.src = &src;
    jpeg_read_header(&cinfo, TRUE);
    if (cinfo.num_components == 4) {
        cinfo.out_color_space = JCS_CMYK;
        cinfo.quantize_colors = FALSE;
        jpeg_calc_output_dimensions(&cinfo);
        surface = SDL_CreateRGBSurface(SDL_SWSURFACE, cinfo.output_width, cinfo.output_height, 32,
                                       0x000000FF, 0x0000FF00, 0x00FF0000, 0xFF000000);
    } else {
        cinfo.out_color_space = JCS_RGB;
        cinfo.quantize_colors = FALSE;
        jpeg_calc_output_dimensions(&cinfo);
        surface = SDL_CreateRGBSurface(SDL_SWSURFACE, cinfo.output_width, cinfo.output_height, 24,
                                       0x0000FF, 0x00FF00, 0xFF0000, 0);
    }
    if (!surface) {
        jpeg_destroy_decompress(&cinfo);
        SDL_SetError("Out of memory");
        return NULL;
    }
    jpeg_start_decompress(&cinfo);
    while (cinfo.output_scanline < cinfo.output_height) {
        row = (JSAMPROW)((Uint8 *)surface->pixels + cinfo.output_scanline * surface->pitch);
        jpeg_read_scanlines(&cinfo, &row, 1);
    }
    jpeg_finish_decompress(&cinfo);
    jpeg_destroy_decompress(&cinfo);
    return surface;
}

SDL_Surface *IMG_Load_RW(SDL_RWops *src, int freesrc)
{
    int len = 0;
    unsigned char *data;
    SDL_Surface *s;
    (void)freesrc;
    if (!src) { SDL_SetError("Passed a NULL data source"); return NULL; }
    data = prism_RW_bytes(src, &len);
    if (!data) return NULL;
    if (len >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF) s = prism_IMG_LoadJPG(data, len);
    else s = prism_IMG_LoadPNG(data, len);
    free(data);
    return s;
}

SDL_Surface *IMG_Load(const char *file)
{
    SDL_RWops *src = SDL_RWFromFile(file, "rb");
    if (!src) return NULL;
    return IMG_Load_RW(src, 1);
}
`;
