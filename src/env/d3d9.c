/*
 * d3d9.c -- d3d9.dll as a HEADLESS device: Direct3D 9's objects with their memory, for a program
 * compiled from C or C++ (.kkrieger's _start.cpp calls it through d3d9.h's virtual methods, whose
 * table layout is this file's -- src/env/com.js).
 *
 * What it is for, and what it is not. A Direct3D 9 program does a great deal before it draws: it
 * creates its textures and fills them through LockRect, reads render targets back, clears and fills
 * surfaces. All of that is memory, and this file does it for real -- every texture, cube face, volume,
 * surface and buffer holds its bytes, Clear and ColorFill write them, StretchRect and
 * GetRenderTargetData copy them. What it does NOT do is rasterise: Draw* calls succeed and draw
 * nothing, which is what "headless" means here, and why a texture a program renders into (rather than
 * fills) comes out as it was cleared. The drawing device is PRISM's src/env/d3d9.js; joining this file
 * to it is the next step, not a thing to fake here.
 *
 * Every texture level a program unlocks is handed to prism_d3d9_unlocked, which the host binds: the
 * texture gate records the texels there (tools/gate-kkrieger-tex.mjs). The capabilities are the ones
 * MIRAGE's headless device reported when it captured the reference: shader model 3.0, 8192-texel
 * textures, eight stages -- so a program takes the same paths under both.
 *
 * Its two DLLs reach the program through prism_system_lookup (src/env/win32-app.c): d3d9.dll's
 * Direct3DCreate9 and dsound.dll's DirectSoundCreate8, the second of which answers DSERR_NODRIVER --
 * there is no sound device here, and saying so is the program's cue to go silent.
 */
#include <windows.h>
#include <d3d9.h>
#include <dsound.h>
#include <olectl.h>
#include <stdlib.h>
#include <string.h>

/* The host's: called for every texture level unlocked, with its bytes. */
void prism_d3d9_unlocked(int texture, int face, int level, int width, int height, int format, const void *bits, int pitch);

static int next_id = 1;

static int bpp(D3DFORMAT f)
{
    switch (f) {
    case D3DFMT_A8: case D3DFMT_L8: case D3DFMT_P8: return 1;
    case D3DFMT_R5G6B5: case D3DFMT_X1R5G5B5: case D3DFMT_A1R5G5B5: case D3DFMT_A4R4G4B4: case D3DFMT_A8L8:
    case D3DFMT_V8U8: case D3DFMT_L16: case D3DFMT_R16F: case D3DFMT_D16: case D3DFMT_D16_LOCKABLE: case D3DFMT_INDEX16:
        return 2;
    case D3DFMT_R8G8B8: return 3;
    case D3DFMT_A16B16G16R16: case D3DFMT_A16B16G16R16F: case D3DFMT_G32R32F: case D3DFMT_Q16W16V16U16: return 8;
    case D3DFMT_A32B32G32R32F: return 16;
    default: return 4;
    }
}

/* ------------------------------------------------------------------ surfaces */

typedef struct Surface {
    IDirect3DSurface9 iface;
    LONG refs;
    D3DSURFACE_DESC desc;
    int pitch;
    unsigned char *bits;
    int owns_bits;
    int texture, face, level;     /* the texture level this is, or texture 0 */
    IUnknown *container;
} Surface;

static struct IDirect3DSurface9Vtbl surface_vtbl;

static Surface *surface_new(UINT w, UINT h, D3DFORMAT fmt, D3DPOOL pool, DWORD usage, D3DRESOURCETYPE type)
{
    Surface *s = (Surface *)calloc(1, sizeof *s);
    s->iface.lpVtbl = &surface_vtbl;
    s->refs = 1;
    s->desc.Format = fmt; s->desc.Type = type; s->desc.Usage = usage; s->desc.Pool = pool;
    s->desc.MultiSampleType = D3DMULTISAMPLE_NONE; s->desc.Width = w; s->desc.Height = h;
    s->pitch = (int)w * bpp(fmt);
    s->bits = (unsigned char *)calloc(1, (size_t)s->pitch * h + 1);
    s->owns_bits = 1;
    return s;
}
#define SURF(p) ((Surface *)(p))

/* Fill a rectangle of a surface with a D3DCOLOR, in the surface's own format. */
static void surface_fill(Surface *s, const RECT *r, D3DCOLOR c)
{
    int x0 = r ? r->left : 0, y0 = r ? r->top : 0;
    int x1 = r ? r->right : (int)s->desc.Width, y1 = r ? r->bottom : (int)s->desc.Height;
    int b = bpp(s->desc.Format), x, y, k;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > (int)s->desc.Width) x1 = s->desc.Width;
    if (y1 > (int)s->desc.Height) y1 = s->desc.Height;
    for (y = y0; y < y1; y++)
        for (x = x0; x < x1; x++) {
            unsigned char *p = s->bits + y * s->pitch + x * b;
            if (s->desc.Format == D3DFMT_A8) p[0] = (unsigned char)(c >> 24);
            else for (k = 0; k < b && k < 4; k++) p[k] = (unsigned char)(c >> (8 * k));
        }
}

static HRESULT STDMETHODCALLTYPE surf_QueryInterface(IDirect3DSurface9 *This, REFIID riid, void **out) { (void)This; (void)riid; *out = 0; return E_NOINTERFACE; }
static ULONG STDMETHODCALLTYPE surf_AddRef(IDirect3DSurface9 *This) { return ++SURF(This)->refs; }
static ULONG STDMETHODCALLTYPE surf_Release(IDirect3DSurface9 *This)
{
    Surface *s = SURF(This);
    LONG n = --s->refs;
    if (n == 0 && !s->texture) { if (s->owns_bits) free(s->bits); free(s); }
    return n < 0 ? 0 : n;
}
static HRESULT STDMETHODCALLTYPE surf_GetDevice(IDirect3DSurface9 *This, IDirect3DDevice9 **d) { (void)This; *d = 0; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE surf_SetPrivateData(IDirect3DSurface9 *This, REFGUID g, const void *p, DWORD n, DWORD f) { (void)This; (void)g; (void)p; (void)n; (void)f; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE surf_GetPrivateData(IDirect3DSurface9 *This, REFGUID g, void *p, DWORD *n) { (void)This; (void)g; (void)p; (void)n; return D3DERR_NOTFOUND; }
static HRESULT STDMETHODCALLTYPE surf_FreePrivateData(IDirect3DSurface9 *This, REFGUID g) { (void)This; (void)g; return D3D_OK; }
static DWORD STDMETHODCALLTYPE surf_SetPriority(IDirect3DSurface9 *This, DWORD p) { (void)This; (void)p; return 0; }
static DWORD STDMETHODCALLTYPE surf_GetPriority(IDirect3DSurface9 *This) { (void)This; return 0; }
static void STDMETHODCALLTYPE surf_PreLoad(IDirect3DSurface9 *This) { (void)This; }
static D3DRESOURCETYPE STDMETHODCALLTYPE surf_GetType(IDirect3DSurface9 *This) { (void)This; return D3DRTYPE_SURFACE; }
static HRESULT STDMETHODCALLTYPE surf_GetContainer(IDirect3DSurface9 *This, REFIID riid, void **c) { (void)riid; *c = SURF(This)->container; return SURF(This)->container ? D3D_OK : E_NOINTERFACE; }
static HRESULT STDMETHODCALLTYPE surf_GetDesc(IDirect3DSurface9 *This, D3DSURFACE_DESC *d) { *d = SURF(This)->desc; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE surf_LockRect(IDirect3DSurface9 *This, D3DLOCKED_RECT *lr, const RECT *r, DWORD f)
{
    Surface *s = SURF(This);
    (void)f;
    lr->Pitch = s->pitch;
    lr->pBits = s->bits + (r ? r->top * s->pitch + r->left * bpp(s->desc.Format) : 0);
    return D3D_OK;
}
static HRESULT STDMETHODCALLTYPE surf_UnlockRect(IDirect3DSurface9 *This)
{
    Surface *s = SURF(This);
    if (s->texture)
        prism_d3d9_unlocked(s->texture, s->face, s->level, s->desc.Width, s->desc.Height, s->desc.Format, s->bits, s->pitch);
    return D3D_OK;
}
static HRESULT STDMETHODCALLTYPE surf_GetDC(IDirect3DSurface9 *This, HDC *dc) { (void)This; *dc = 0; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE surf_ReleaseDC(IDirect3DSurface9 *This, HDC dc) { (void)This; (void)dc; return D3DERR_INVALIDCALL; }

static struct IDirect3DSurface9Vtbl surface_vtbl = {
    surf_QueryInterface, surf_AddRef, surf_Release, surf_GetDevice, surf_SetPrivateData, surf_GetPrivateData,
    surf_FreePrivateData, surf_SetPriority, surf_GetPriority, surf_PreLoad, surf_GetType, surf_GetContainer,
    surf_GetDesc, surf_LockRect, surf_UnlockRect, surf_GetDC, surf_ReleaseDC,
};

/* ------------------------------------------------------------------ textures (2D and cube) */

typedef struct Texture {
    union { IDirect3DTexture9 tex; IDirect3DCubeTexture9 cube; } iface;
    LONG refs;
    int id, faces, levels;
    D3DFORMAT format;
    DWORD usage;
    D3DPOOL pool;
    Surface **surf;          /* faces * levels, face-major */
} Texture;
#define TEX(p) ((Texture *)(p))

static struct IDirect3DTexture9Vtbl texture_vtbl;
static struct IDirect3DCubeTexture9Vtbl cube_vtbl;

static Texture *texture_new(UINT w, UINT h, UINT levels, DWORD usage, D3DFORMAT fmt, D3DPOOL pool, int faces)
{
    Texture *t = (Texture *)calloc(1, sizeof *t);
    UINT n = 0, x = w, y = h, l;
    int f;
    if (levels == 0) { for (; x > 1 || y > 1; n++) { x = x > 1 ? x / 2 : 1; y = y > 1 ? y / 2 : 1; } levels = n + 1; }
    t->refs = 1; t->id = next_id++; t->faces = faces; t->levels = levels; t->format = fmt; t->usage = usage; t->pool = pool;
    t->surf = (Surface **)calloc(faces * levels, sizeof(Surface *));
    for (f = 0; f < faces; f++) {
        x = w; y = h;
        for (l = 0; l < levels; l++) {
            Surface *s = surface_new(x, y, fmt, pool, usage, D3DRTYPE_SURFACE);
            s->texture = t->id; s->face = faces == 6 ? f : -1; s->level = l; s->container = (IUnknown *)t;
            t->surf[f * levels + l] = s;
            x = x > 1 ? x / 2 : 1; y = y > 1 ? y / 2 : 1;
        }
    }
    return t;
}

static HRESULT STDMETHODCALLTYPE tex_QueryInterface(IDirect3DTexture9 *This, REFIID riid, void **out) { (void)riid; *out = This; TEX(This)->refs++; return D3D_OK; }
static ULONG STDMETHODCALLTYPE tex_AddRef(IDirect3DTexture9 *This) { return ++TEX(This)->refs; }
static ULONG STDMETHODCALLTYPE tex_Release(IDirect3DTexture9 *This)
{
    Texture *t = TEX(This);
    LONG n = --t->refs;
    int i;
    if (n == 0) {
        for (i = 0; i < t->faces * t->levels; i++) { free(t->surf[i]->bits); free(t->surf[i]); }
        free(t->surf); free(t);
    }
    return n < 0 ? 0 : n;
}
static HRESULT STDMETHODCALLTYPE tex_GetDevice(IDirect3DTexture9 *This, IDirect3DDevice9 **d) { (void)This; *d = 0; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE tex_SetPrivateData(IDirect3DTexture9 *This, REFGUID g, const void *p, DWORD n, DWORD f) { (void)This; (void)g; (void)p; (void)n; (void)f; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE tex_GetPrivateData(IDirect3DTexture9 *This, REFGUID g, void *p, DWORD *n) { (void)This; (void)g; (void)p; (void)n; return D3DERR_NOTFOUND; }
static HRESULT STDMETHODCALLTYPE tex_FreePrivateData(IDirect3DTexture9 *This, REFGUID g) { (void)This; (void)g; return D3D_OK; }
static DWORD STDMETHODCALLTYPE tex_SetPriority(IDirect3DTexture9 *This, DWORD p) { (void)This; (void)p; return 0; }
static DWORD STDMETHODCALLTYPE tex_GetPriority(IDirect3DTexture9 *This) { (void)This; return 0; }
static void STDMETHODCALLTYPE tex_PreLoad(IDirect3DTexture9 *This) { (void)This; }
static D3DRESOURCETYPE STDMETHODCALLTYPE tex_GetType(IDirect3DTexture9 *This) { return TEX(This)->faces == 6 ? D3DRTYPE_CUBETEXTURE : D3DRTYPE_TEXTURE; }
static DWORD STDMETHODCALLTYPE tex_SetLOD(IDirect3DTexture9 *This, DWORD lod) { (void)This; (void)lod; return 0; }
static DWORD STDMETHODCALLTYPE tex_GetLOD(IDirect3DTexture9 *This) { (void)This; return 0; }
static DWORD STDMETHODCALLTYPE tex_GetLevelCount(IDirect3DTexture9 *This) { return TEX(This)->levels; }
static HRESULT STDMETHODCALLTYPE tex_SetAutoGenFilterType(IDirect3DTexture9 *This, D3DTEXTUREFILTERTYPE f) { (void)This; (void)f; return D3D_OK; }
static D3DTEXTUREFILTERTYPE STDMETHODCALLTYPE tex_GetAutoGenFilterType(IDirect3DTexture9 *This) { (void)This; return D3DTEXF_LINEAR; }
static void STDMETHODCALLTYPE tex_GenerateMipSubLevels(IDirect3DTexture9 *This) { (void)This; }

static Surface *level_of(Texture *t, int face, UINT level) { return level < (UINT)t->levels && face < t->faces ? t->surf[face * t->levels + level] : 0; }

static HRESULT STDMETHODCALLTYPE tex_GetLevelDesc(IDirect3DTexture9 *This, UINT l, D3DSURFACE_DESC *d)
{ Surface *s = level_of(TEX(This), 0, l); if (!s) return D3DERR_INVALIDCALL; *d = s->desc; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE tex_GetSurfaceLevel(IDirect3DTexture9 *This, UINT l, IDirect3DSurface9 **out)
{ Surface *s = level_of(TEX(This), 0, l); if (!s) return D3DERR_INVALIDCALL; s->refs++; TEX(This)->refs++; *out = &s->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE tex_LockRect(IDirect3DTexture9 *This, UINT l, D3DLOCKED_RECT *lr, const RECT *r, DWORD f)
{ Surface *s = level_of(TEX(This), 0, l); return s ? surf_LockRect(&s->iface, lr, r, f) : D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE tex_UnlockRect(IDirect3DTexture9 *This, UINT l)
{ Surface *s = level_of(TEX(This), 0, l); return s ? surf_UnlockRect(&s->iface) : D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE tex_AddDirtyRect(IDirect3DTexture9 *This, const RECT *r) { (void)This; (void)r; return D3D_OK; }

static struct IDirect3DTexture9Vtbl texture_vtbl = {
    tex_QueryInterface, tex_AddRef, tex_Release, tex_GetDevice, tex_SetPrivateData, tex_GetPrivateData, tex_FreePrivateData,
    tex_SetPriority, tex_GetPriority, tex_PreLoad, tex_GetType, tex_SetLOD, tex_GetLOD, tex_GetLevelCount,
    tex_SetAutoGenFilterType, tex_GetAutoGenFilterType, tex_GenerateMipSubLevels,
    tex_GetLevelDesc, tex_GetSurfaceLevel, tex_LockRect, tex_UnlockRect, tex_AddDirtyRect,
};

/* The cube's own five, then its table: the shared methods cast, as one object serves both shapes. */
static HRESULT STDMETHODCALLTYPE cube_GetLevelDesc(IDirect3DCubeTexture9 *This, UINT l, D3DSURFACE_DESC *d)
{ Surface *s = level_of(TEX(This), 0, l); if (!s) return D3DERR_INVALIDCALL; *d = s->desc; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE cube_GetCubeMapSurface(IDirect3DCubeTexture9 *This, D3DCUBEMAP_FACES f, UINT l, IDirect3DSurface9 **out)
{ Surface *s = level_of(TEX(This), f, l); if (!s) return D3DERR_INVALIDCALL; s->refs++; TEX(This)->refs++; *out = &s->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE cube_LockRect(IDirect3DCubeTexture9 *This, D3DCUBEMAP_FACES f, UINT l, D3DLOCKED_RECT *lr, const RECT *r, DWORD fl)
{ Surface *s = level_of(TEX(This), f, l); return s ? surf_LockRect(&s->iface, lr, r, fl) : D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE cube_UnlockRect(IDirect3DCubeTexture9 *This, D3DCUBEMAP_FACES f, UINT l)
{ Surface *s = level_of(TEX(This), f, l); return s ? surf_UnlockRect(&s->iface) : D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE cube_AddDirtyRect(IDirect3DCubeTexture9 *This, D3DCUBEMAP_FACES f, const RECT *r) { (void)This; (void)f; (void)r; return D3D_OK; }

#define CUBE(fn) ((void *)fn)
static struct IDirect3DCubeTexture9Vtbl cube_vtbl;
static void cube_vtbl_init(void)
{
    static int done;
    void **dst = (void **)&cube_vtbl, **src = (void **)&texture_vtbl;
    int i;
    if (done) return;
    done = 1;
    for (i = 0; i < 17; i++) dst[i] = src[i];          /* IUnknown, Resource and BaseTexture: shared */
    cube_vtbl.GetLevelDesc = cube_GetLevelDesc; cube_vtbl.GetCubeMapSurface = cube_GetCubeMapSurface;
    cube_vtbl.LockRect = cube_LockRect; cube_vtbl.UnlockRect = cube_UnlockRect; cube_vtbl.AddDirtyRect = cube_AddDirtyRect;
}

/* ------------------------------------------------------------------ volume textures */

typedef struct Volume {
    IDirect3DVolumeTexture9 iface;
    LONG refs;
    UINT w, h, d, levels;
    D3DFORMAT format;
    unsigned char **bits;
} Volume;
#define VOL(p) ((Volume *)(p))
static UINT vdim(UINT n, UINT l) { n >>= l; return n ? n : 1; }

static HRESULT STDMETHODCALLTYPE vol_QueryInterface(IDirect3DVolumeTexture9 *This, REFIID riid, void **out) { (void)riid; *out = This; VOL(This)->refs++; return D3D_OK; }
static ULONG STDMETHODCALLTYPE vol_AddRef(IDirect3DVolumeTexture9 *This) { return ++VOL(This)->refs; }
static ULONG STDMETHODCALLTYPE vol_Release(IDirect3DVolumeTexture9 *This)
{
    Volume *v = VOL(This);
    LONG n = --v->refs;
    UINT l;
    if (n == 0) { for (l = 0; l < v->levels; l++) free(v->bits[l]); free(v->bits); free(v); }
    return n < 0 ? 0 : n;
}
static HRESULT STDMETHODCALLTYPE vol_GetDevice(IDirect3DVolumeTexture9 *This, IDirect3DDevice9 **d) { (void)This; *d = 0; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE vol_SetPrivateData(IDirect3DVolumeTexture9 *This, REFGUID g, const void *p, DWORD n, DWORD f) { (void)This; (void)g; (void)p; (void)n; (void)f; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE vol_GetPrivateData(IDirect3DVolumeTexture9 *This, REFGUID g, void *p, DWORD *n) { (void)This; (void)g; (void)p; (void)n; return D3DERR_NOTFOUND; }
static HRESULT STDMETHODCALLTYPE vol_FreePrivateData(IDirect3DVolumeTexture9 *This, REFGUID g) { (void)This; (void)g; return D3D_OK; }
static DWORD STDMETHODCALLTYPE vol_SetPriority(IDirect3DVolumeTexture9 *This, DWORD p) { (void)This; (void)p; return 0; }
static DWORD STDMETHODCALLTYPE vol_GetPriority(IDirect3DVolumeTexture9 *This) { (void)This; return 0; }
static void STDMETHODCALLTYPE vol_PreLoad(IDirect3DVolumeTexture9 *This) { (void)This; }
static D3DRESOURCETYPE STDMETHODCALLTYPE vol_GetType(IDirect3DVolumeTexture9 *This) { (void)This; return D3DRTYPE_VOLUMETEXTURE; }
static DWORD STDMETHODCALLTYPE vol_SetLOD(IDirect3DVolumeTexture9 *This, DWORD lod) { (void)This; (void)lod; return 0; }
static DWORD STDMETHODCALLTYPE vol_GetLOD(IDirect3DVolumeTexture9 *This) { (void)This; return 0; }
static DWORD STDMETHODCALLTYPE vol_GetLevelCount(IDirect3DVolumeTexture9 *This) { return VOL(This)->levels; }
static HRESULT STDMETHODCALLTYPE vol_SetAutoGenFilterType(IDirect3DVolumeTexture9 *This, D3DTEXTUREFILTERTYPE f) { (void)This; (void)f; return D3D_OK; }
static D3DTEXTUREFILTERTYPE STDMETHODCALLTYPE vol_GetAutoGenFilterType(IDirect3DVolumeTexture9 *This) { (void)This; return D3DTEXF_LINEAR; }
static void STDMETHODCALLTYPE vol_GenerateMipSubLevels(IDirect3DVolumeTexture9 *This) { (void)This; }
static HRESULT STDMETHODCALLTYPE vol_GetLevelDesc(IDirect3DVolumeTexture9 *This, UINT l, D3DVOLUME_DESC *d)
{
    Volume *v = VOL(This);
    if (l >= v->levels) return D3DERR_INVALIDCALL;
    d->Format = v->format; d->Type = D3DRTYPE_VOLUME; d->Usage = 0; d->Pool = D3DPOOL_MANAGED;
    d->Width = vdim(v->w, l); d->Height = vdim(v->h, l); d->Depth = vdim(v->d, l);
    return D3D_OK;
}
static HRESULT STDMETHODCALLTYPE vol_GetVolumeLevel(IDirect3DVolumeTexture9 *This, UINT l, IDirect3DVolume9 **out) { (void)This; (void)l; *out = 0; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE vol_LockBox(IDirect3DVolumeTexture9 *This, UINT l, D3DLOCKED_BOX *lb, const D3DBOX *box, DWORD f)
{
    Volume *v = VOL(This);
    int b = bpp(v->format);
    (void)f;
    if (l >= v->levels) return D3DERR_INVALIDCALL;
    lb->RowPitch = vdim(v->w, l) * b;
    lb->SlicePitch = lb->RowPitch * vdim(v->h, l);
    lb->pBits = v->bits[l] + (box ? box->Front * lb->SlicePitch + box->Top * lb->RowPitch + box->Left * b : 0);
    return D3D_OK;
}
static HRESULT STDMETHODCALLTYPE vol_UnlockBox(IDirect3DVolumeTexture9 *This, UINT l) { (void)This; (void)l; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE vol_AddDirtyBox(IDirect3DVolumeTexture9 *This, const D3DBOX *b) { (void)This; (void)b; return D3D_OK; }

static struct IDirect3DVolumeTexture9Vtbl volume_vtbl = {
    vol_QueryInterface, vol_AddRef, vol_Release, vol_GetDevice, vol_SetPrivateData, vol_GetPrivateData, vol_FreePrivateData,
    vol_SetPriority, vol_GetPriority, vol_PreLoad, vol_GetType, vol_SetLOD, vol_GetLOD, vol_GetLevelCount,
    vol_SetAutoGenFilterType, vol_GetAutoGenFilterType, vol_GenerateMipSubLevels,
    vol_GetLevelDesc, vol_GetVolumeLevel, vol_LockBox, vol_UnlockBox, vol_AddDirtyBox,
};

/* ------------------------------------------------------------------ vertex and index buffers */

typedef struct Buffer {
    union { IDirect3DVertexBuffer9 vb; IDirect3DIndexBuffer9 ib; } iface;
    LONG refs;
    UINT size;
    DWORD usage, fvf;
    D3DFORMAT format;
    D3DPOOL pool;
    unsigned char *bits;
} Buffer;
#define BUF(p) ((Buffer *)(p))

static HRESULT STDMETHODCALLTYPE buf_QueryInterface(IDirect3DVertexBuffer9 *This, REFIID riid, void **out) { (void)riid; *out = This; BUF(This)->refs++; return D3D_OK; }
static ULONG STDMETHODCALLTYPE buf_AddRef(IDirect3DVertexBuffer9 *This) { return ++BUF(This)->refs; }
static ULONG STDMETHODCALLTYPE buf_Release(IDirect3DVertexBuffer9 *This)
{
    Buffer *b = BUF(This);
    LONG n = --b->refs;
    if (n == 0) { free(b->bits); free(b); }
    return n < 0 ? 0 : n;
}
static HRESULT STDMETHODCALLTYPE buf_GetDevice(IDirect3DVertexBuffer9 *This, IDirect3DDevice9 **d) { (void)This; *d = 0; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE buf_SetPrivateData(IDirect3DVertexBuffer9 *This, REFGUID g, const void *p, DWORD n, DWORD f) { (void)This; (void)g; (void)p; (void)n; (void)f; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE buf_GetPrivateData(IDirect3DVertexBuffer9 *This, REFGUID g, void *p, DWORD *n) { (void)This; (void)g; (void)p; (void)n; return D3DERR_NOTFOUND; }
static HRESULT STDMETHODCALLTYPE buf_FreePrivateData(IDirect3DVertexBuffer9 *This, REFGUID g) { (void)This; (void)g; return D3D_OK; }
static DWORD STDMETHODCALLTYPE buf_SetPriority(IDirect3DVertexBuffer9 *This, DWORD p) { (void)This; (void)p; return 0; }
static DWORD STDMETHODCALLTYPE buf_GetPriority(IDirect3DVertexBuffer9 *This) { (void)This; return 0; }
static void STDMETHODCALLTYPE buf_PreLoad(IDirect3DVertexBuffer9 *This) { (void)This; }
static D3DRESOURCETYPE STDMETHODCALLTYPE vb_GetType(IDirect3DVertexBuffer9 *This) { (void)This; return D3DRTYPE_VERTEXBUFFER; }
static HRESULT STDMETHODCALLTYPE buf_Lock(IDirect3DVertexBuffer9 *This, UINT off, UINT n, void **p, DWORD f)
{ (void)n; (void)f; *p = BUF(This)->bits + off; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE buf_Unlock(IDirect3DVertexBuffer9 *This) { (void)This; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE vb_GetDesc(IDirect3DVertexBuffer9 *This, D3DVERTEXBUFFER_DESC *d)
{
    Buffer *b = BUF(This);
    d->Format = D3DFMT_VERTEXDATA; d->Type = D3DRTYPE_VERTEXBUFFER; d->Usage = b->usage; d->Pool = b->pool; d->Size = b->size; d->FVF = b->fvf;
    return D3D_OK;
}
static struct IDirect3DVertexBuffer9Vtbl vb_vtbl = {
    buf_QueryInterface, buf_AddRef, buf_Release, buf_GetDevice, buf_SetPrivateData, buf_GetPrivateData, buf_FreePrivateData,
    buf_SetPriority, buf_GetPriority, buf_PreLoad, vb_GetType, buf_Lock, buf_Unlock, vb_GetDesc,
};
static D3DRESOURCETYPE STDMETHODCALLTYPE ib_GetType(IDirect3DIndexBuffer9 *This) { (void)This; return D3DRTYPE_INDEXBUFFER; }
static HRESULT STDMETHODCALLTYPE ib_GetDesc(IDirect3DIndexBuffer9 *This, D3DINDEXBUFFER_DESC *d)
{
    Buffer *b = BUF(This);
    d->Format = b->format; d->Type = D3DRTYPE_INDEXBUFFER; d->Usage = b->usage; d->Pool = b->pool; d->Size = b->size;
    return D3D_OK;
}
static struct IDirect3DIndexBuffer9Vtbl ib_vtbl;
static void ib_vtbl_init(void)
{
    static int done;
    void **dst = (void **)&ib_vtbl, **src = (void **)&vb_vtbl;
    int i;
    if (done) return;
    done = 1;
    for (i = 0; i < 14; i++) dst[i] = src[i];          /* the same object behind both buffer interfaces */
    ib_vtbl.GetType = ib_GetType; ib_vtbl.GetDesc = ib_GetDesc;
}

static Buffer *buffer_new(UINT size, DWORD usage, DWORD fvf, D3DFORMAT fmt, D3DPOOL pool, int index)
{
    Buffer *b = (Buffer *)calloc(1, sizeof *b);
    if (index) { ib_vtbl_init(); b->iface.ib.lpVtbl = &ib_vtbl; } else b->iface.vb.lpVtbl = &vb_vtbl;
    b->refs = 1; b->size = size; b->usage = usage; b->fvf = fvf; b->format = fmt; b->pool = pool;
    b->bits = (unsigned char *)calloc(1, size + 1);
    return b;
}

/* ------------------------------------------------------------------ declarations and shaders */

typedef struct Blob {
    IDirect3DVertexShader9 iface;     /* one layout for the three: GetDevice, then their data */
    LONG refs;
    void *data;
    UINT size;
} Blob;
#define BLOB(p) ((Blob *)(p))
static HRESULT STDMETHODCALLTYPE blob_QueryInterface(IDirect3DVertexShader9 *This, REFIID riid, void **out) { (void)riid; *out = This; BLOB(This)->refs++; return D3D_OK; }
static ULONG STDMETHODCALLTYPE blob_AddRef(IDirect3DVertexShader9 *This) { return ++BLOB(This)->refs; }
static ULONG STDMETHODCALLTYPE blob_Release(IDirect3DVertexShader9 *This)
{
    Blob *b = BLOB(This);
    LONG n = --b->refs;
    if (n == 0) { free(b->data); free(b); }
    return n < 0 ? 0 : n;
}
static HRESULT STDMETHODCALLTYPE blob_GetDevice(IDirect3DVertexShader9 *This, IDirect3DDevice9 **d) { (void)This; *d = 0; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE blob_GetFunction(IDirect3DVertexShader9 *This, void *p, UINT *n)
{
    Blob *b = BLOB(This);
    if (p) memcpy(p, b->data, b->size);
    *n = b->size;
    return D3D_OK;
}
static struct IDirect3DVertexShader9Vtbl blob_vtbl = { blob_QueryInterface, blob_AddRef, blob_Release, blob_GetDevice, blob_GetFunction };

/* A shader's length: its tokens up to the end token, 0x0000FFFF. */
static UINT shader_bytes(const DWORD *f) { UINT n = 0; while (f[n] != 0x0000FFFF) n++; return (n + 1) * 4; }
/* A declaration's length: its elements up to D3DDECL_END(). */
static UINT decl_bytes(const D3DVERTEXELEMENT9 *e) { UINT n = 0; while (e[n].Stream != 0xFF) n++; return (n + 1) * sizeof *e; }
static Blob *blob_new(const void *data, UINT size)
{
    Blob *b = (Blob *)calloc(1, sizeof *b);
    b->iface.lpVtbl = &blob_vtbl; b->refs = 1; b->size = size;
    b->data = malloc(size); memcpy(b->data, data, size);
    return b;
}

/* ------------------------------------------------------------------ the device */

typedef struct Device {
    IDirect3DDevice9 iface;
    LONG refs;
    IDirect3D9 *d3d;
    D3DPRESENT_PARAMETERS pp;
    D3DDEVICE_CREATION_PARAMETERS cp;
    Surface *back, *depth, *rt[4], *ds;
    IDirect3DSwapChain9 *swap;
    DWORD rs[256];
    D3DVIEWPORT9 vp;
    int presents;
} Device;
#define DEV(p) ((Device *)(p))

static void fill_caps(D3DCAPS9 *c)
{
    memset(c, 0, sizeof *c);
    c->DeviceType = D3DDEVTYPE_HAL;
    c->MaxTextureWidth = 8192; c->MaxTextureHeight = 8192;
    c->MaxTextureBlendStages = 8; c->MaxSimultaneousTextures = 8;
    c->MaxStreams = 16; c->MaxStreamStride = 255;
    c->VertexShaderVersion = D3DVS_VERSION(3, 0); c->MaxVertexShaderConst = 256;
    c->PixelShaderVersion = D3DPS_VERSION(3, 0);
}

/* The swap chain: the device's one, its back buffer the device's. */
typedef struct Swap { IDirect3DSwapChain9 iface; LONG refs; Device *dev; } Swap;
static HRESULT STDMETHODCALLTYPE sw_QueryInterface(IDirect3DSwapChain9 *This, REFIID riid, void **out) { (void)riid; *out = This; return D3D_OK; }
static ULONG STDMETHODCALLTYPE sw_AddRef(IDirect3DSwapChain9 *This) { return ++((Swap *)This)->refs; }
static ULONG STDMETHODCALLTYPE sw_Release(IDirect3DSwapChain9 *This) { LONG n = --((Swap *)This)->refs; return n < 1 ? 1 : n; }
static HRESULT STDMETHODCALLTYPE sw_Present(IDirect3DSwapChain9 *This, const RECT *s, const RECT *d, HWND w, const RGNDATA *r, DWORD f)
{ (void)s; (void)d; (void)w; (void)r; (void)f; ((Swap *)This)->dev->presents++; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE sw_GetFrontBufferData(IDirect3DSwapChain9 *This, IDirect3DSurface9 *s) { (void)This; (void)s; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE sw_GetBackBuffer(IDirect3DSwapChain9 *This, UINT i, D3DBACKBUFFER_TYPE t, IDirect3DSurface9 **out)
{ Surface *b = ((Swap *)This)->dev->back; (void)i; (void)t; b->refs++; *out = &b->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE sw_GetRasterStatus(IDirect3DSwapChain9 *This, D3DRASTER_STATUS *r) { (void)This; r->InVBlank = TRUE; r->ScanLine = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE sw_GetDisplayMode(IDirect3DSwapChain9 *This, D3DDISPLAYMODE *m)
{ Device *d = ((Swap *)This)->dev; m->Width = d->pp.BackBufferWidth; m->Height = d->pp.BackBufferHeight; m->RefreshRate = 60; m->Format = D3DFMT_X8R8G8B8; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE sw_GetDevice(IDirect3DSwapChain9 *This, IDirect3DDevice9 **out) { *out = &((Swap *)This)->dev->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE sw_GetPresentParameters(IDirect3DSwapChain9 *This, D3DPRESENT_PARAMETERS *p) { *p = ((Swap *)This)->dev->pp; return D3D_OK; }
static struct IDirect3DSwapChain9Vtbl swap_vtbl = {
    sw_QueryInterface, sw_AddRef, sw_Release, sw_Present, sw_GetFrontBufferData, sw_GetBackBuffer, sw_GetRasterStatus,
    sw_GetDisplayMode, sw_GetDevice, sw_GetPresentParameters,
};

/* Copy a rectangle between two surfaces of one format, nearest-sampled when the sizes differ. */
static HRESULT copy_rect(Surface *s, const RECT *sr, Surface *d, const RECT *dr)
{
    int sx0 = sr ? sr->left : 0, sy0 = sr ? sr->top : 0, sw = sr ? sr->right - sr->left : (int)s->desc.Width, sh = sr ? sr->bottom - sr->top : (int)s->desc.Height;
    int dx0 = dr ? dr->left : 0, dy0 = dr ? dr->top : 0, dw = dr ? dr->right - dr->left : (int)d->desc.Width, dh = dr ? dr->bottom - dr->top : (int)d->desc.Height;
    int b = bpp(s->desc.Format), x, y;
    if (bpp(d->desc.Format) != b) return D3DERR_INVALIDCALL;
    for (y = 0; y < dh; y++)
        for (x = 0; x < dw; x++) {
            int sx = sx0 + x * sw / dw, sy = sy0 + y * sh / dh;
            memcpy(d->bits + (dy0 + y) * d->pitch + (dx0 + x) * b, s->bits + sy * s->pitch + sx * b, b);
        }
    return D3D_OK;
}

#define D_ This
static HRESULT STDMETHODCALLTYPE dev_QueryInterface(IDirect3DDevice9 *This, REFIID riid, void **out) { (void)riid; *out = This; DEV(This)->refs++; return D3D_OK; }
static ULONG STDMETHODCALLTYPE dev_AddRef(IDirect3DDevice9 *This) { return ++DEV(This)->refs; }
static ULONG STDMETHODCALLTYPE dev_Release(IDirect3DDevice9 *This) { LONG n = --DEV(This)->refs; return n < 0 ? 0 : n; }
static HRESULT STDMETHODCALLTYPE dev_TestCooperativeLevel(IDirect3DDevice9 *This) { (void)This; return D3D_OK; }
static UINT STDMETHODCALLTYPE dev_GetAvailableTextureMem(IDirect3DDevice9 *This) { (void)This; return 256u << 20; }
static HRESULT STDMETHODCALLTYPE dev_EvictManagedResources(IDirect3DDevice9 *This) { (void)This; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetDirect3D(IDirect3DDevice9 *This, IDirect3D9 **out) { *out = DEV(This)->d3d; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetDeviceCaps(IDirect3DDevice9 *This, D3DCAPS9 *c) { (void)This; fill_caps(c); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetDisplayMode(IDirect3DDevice9 *This, UINT i, D3DDISPLAYMODE *m) { (void)i; return sw_GetDisplayMode(DEV(This)->swap, m); }
static HRESULT STDMETHODCALLTYPE dev_GetCreationParameters(IDirect3DDevice9 *This, D3DDEVICE_CREATION_PARAMETERS *p) { *p = DEV(This)->cp; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetCursorProperties(IDirect3DDevice9 *This, UINT x, UINT y, IDirect3DSurface9 *s) { (void)This; (void)x; (void)y; (void)s; return D3D_OK; }
static void STDMETHODCALLTYPE dev_SetCursorPosition(IDirect3DDevice9 *This, int x, int y, DWORD f) { (void)This; (void)x; (void)y; (void)f; }
static BOOL STDMETHODCALLTYPE dev_ShowCursor(IDirect3DDevice9 *This, BOOL b) { (void)This; (void)b; return FALSE; }
static HRESULT STDMETHODCALLTYPE dev_CreateAdditionalSwapChain(IDirect3DDevice9 *This, D3DPRESENT_PARAMETERS *p, IDirect3DSwapChain9 **out) { (void)This; (void)p; *out = 0; return D3DERR_NOTAVAILABLE; }
static HRESULT STDMETHODCALLTYPE dev_GetSwapChain(IDirect3DDevice9 *This, UINT i, IDirect3DSwapChain9 **out) { if (i) return D3DERR_INVALIDCALL; *out = DEV(This)->swap; return D3D_OK; }
static UINT STDMETHODCALLTYPE dev_GetNumberOfSwapChains(IDirect3DDevice9 *This) { (void)This; return 1; }
static HRESULT STDMETHODCALLTYPE dev_Reset(IDirect3DDevice9 *This, D3DPRESENT_PARAMETERS *p) { DEV(This)->pp = *p; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_Present(IDirect3DDevice9 *This, const RECT *s, const RECT *d, HWND w, const RGNDATA *r) { (void)s; (void)d; (void)w; (void)r; DEV(This)->presents++; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetBackBuffer(IDirect3DDevice9 *This, UINT sc, UINT i, D3DBACKBUFFER_TYPE t, IDirect3DSurface9 **out) { (void)sc; return sw_GetBackBuffer(DEV(This)->swap, i, t, out); }
static HRESULT STDMETHODCALLTYPE dev_GetRasterStatus(IDirect3DDevice9 *This, UINT sc, D3DRASTER_STATUS *r) { (void)sc; return sw_GetRasterStatus(DEV(This)->swap, r); }
static HRESULT STDMETHODCALLTYPE dev_SetDialogBoxMode(IDirect3DDevice9 *This, BOOL b) { (void)This; (void)b; return D3D_OK; }
static void STDMETHODCALLTYPE dev_SetGammaRamp(IDirect3DDevice9 *This, UINT sc, DWORD f, const D3DGAMMARAMP *r) { (void)This; (void)sc; (void)f; (void)r; }
static void STDMETHODCALLTYPE dev_GetGammaRamp(IDirect3DDevice9 *This, UINT sc, D3DGAMMARAMP *r)
{ int i; (void)This; (void)sc; for (i = 0; i < 256; i++) r->red[i] = r->green[i] = r->blue[i] = (WORD)(i * 257); }
static HRESULT STDMETHODCALLTYPE dev_CreateTexture(IDirect3DDevice9 *This, UINT w, UINT h, UINT l, DWORD u, D3DFORMAT f, D3DPOOL p, IDirect3DTexture9 **out, HANDLE *sh)
{
    Texture *t = texture_new(w, h, l, u, f, p, 1);
    (void)This; (void)sh;
    t->iface.tex.lpVtbl = &texture_vtbl;
    *out = &t->iface.tex;
    return D3D_OK;
}
static HRESULT STDMETHODCALLTYPE dev_CreateVolumeTexture(IDirect3DDevice9 *This, UINT w, UINT h, UINT d, UINT l, DWORD u, D3DFORMAT f, D3DPOOL p, IDirect3DVolumeTexture9 **out, HANDLE *sh)
{
    Volume *v = (Volume *)calloc(1, sizeof *v);
    UINT i;
    (void)This; (void)u; (void)p; (void)sh;
    v->iface.lpVtbl = &volume_vtbl; v->refs = 1; v->w = w; v->h = h; v->d = d; v->format = f; v->levels = l ? l : 1;
    v->bits = (unsigned char **)calloc(v->levels, sizeof *v->bits);
    for (i = 0; i < v->levels; i++) v->bits[i] = (unsigned char *)calloc(1, vdim(w, i) * vdim(h, i) * vdim(d, i) * bpp(f) + 1);
    *out = &v->iface;
    return D3D_OK;
}
static HRESULT STDMETHODCALLTYPE dev_CreateCubeTexture(IDirect3DDevice9 *This, UINT e, UINT l, DWORD u, D3DFORMAT f, D3DPOOL p, IDirect3DCubeTexture9 **out, HANDLE *sh)
{
    Texture *t = texture_new(e, e, l, u, f, p, 6);
    (void)This; (void)sh;
    cube_vtbl_init();
    t->iface.cube.lpVtbl = &cube_vtbl;
    *out = &t->iface.cube;
    return D3D_OK;
}
static HRESULT STDMETHODCALLTYPE dev_CreateVertexBuffer(IDirect3DDevice9 *This, UINT n, DWORD u, DWORD fvf, D3DPOOL p, IDirect3DVertexBuffer9 **out, HANDLE *sh)
{ (void)This; (void)sh; *out = &buffer_new(n, u, fvf, D3DFMT_VERTEXDATA, p, 0)->iface.vb; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_CreateIndexBuffer(IDirect3DDevice9 *This, UINT n, DWORD u, D3DFORMAT f, D3DPOOL p, IDirect3DIndexBuffer9 **out, HANDLE *sh)
{ (void)This; (void)sh; *out = &buffer_new(n, u, 0, f, p, 1)->iface.ib; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_CreateRenderTarget(IDirect3DDevice9 *This, UINT w, UINT h, D3DFORMAT f, D3DMULTISAMPLE_TYPE m, DWORD q, BOOL lk, IDirect3DSurface9 **out, HANDLE *sh)
{ (void)This; (void)m; (void)q; (void)lk; (void)sh; *out = &surface_new(w, h, f, D3DPOOL_DEFAULT, D3DUSAGE_RENDERTARGET, D3DRTYPE_SURFACE)->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_CreateDepthStencilSurface(IDirect3DDevice9 *This, UINT w, UINT h, D3DFORMAT f, D3DMULTISAMPLE_TYPE m, DWORD q, BOOL dc, IDirect3DSurface9 **out, HANDLE *sh)
{ (void)This; (void)m; (void)q; (void)dc; (void)sh; *out = &surface_new(w, h, f, D3DPOOL_DEFAULT, D3DUSAGE_DEPTHSTENCIL, D3DRTYPE_SURFACE)->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_UpdateSurface(IDirect3DDevice9 *This, IDirect3DSurface9 *s, const RECT *sr, IDirect3DSurface9 *d, const POINT *dp)
{
    RECT dr;
    (void)This;
    dr.left = dp ? dp->x : 0; dr.top = dp ? dp->y : 0;
    dr.right = dr.left + (sr ? sr->right - sr->left : (LONG)SURF(s)->desc.Width);
    dr.bottom = dr.top + (sr ? sr->bottom - sr->top : (LONG)SURF(s)->desc.Height);
    return copy_rect(SURF(s), sr, SURF(d), &dr);
}
static HRESULT STDMETHODCALLTYPE dev_UpdateTexture(IDirect3DDevice9 *This, IDirect3DBaseTexture9 *s, IDirect3DBaseTexture9 *d)
{
    Texture *a = TEX(s), *b = TEX(d);
    int i, n = a->faces * a->levels;
    (void)This;
    if (b->faces * b->levels < n) n = b->faces * b->levels;
    for (i = 0; i < n; i++) copy_rect(a->surf[i], 0, b->surf[i], 0);
    return D3D_OK;
}
static HRESULT STDMETHODCALLTYPE dev_GetRenderTargetData(IDirect3DDevice9 *This, IDirect3DSurface9 *rt, IDirect3DSurface9 *d) { (void)This; return copy_rect(SURF(rt), 0, SURF(d), 0); }
static HRESULT STDMETHODCALLTYPE dev_GetFrontBufferData(IDirect3DDevice9 *This, UINT sc, IDirect3DSurface9 *d) { (void)sc; return copy_rect(DEV(This)->back, 0, SURF(d), 0); }
static HRESULT STDMETHODCALLTYPE dev_StretchRect(IDirect3DDevice9 *This, IDirect3DSurface9 *s, const RECT *sr, IDirect3DSurface9 *d, const RECT *dr, D3DTEXTUREFILTERTYPE f)
{ (void)This; (void)f; return copy_rect(SURF(s), sr, SURF(d), dr); }
static HRESULT STDMETHODCALLTYPE dev_ColorFill(IDirect3DDevice9 *This, IDirect3DSurface9 *s, const RECT *r, D3DCOLOR c) { (void)This; surface_fill(SURF(s), r, c); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_CreateOffscreenPlainSurface(IDirect3DDevice9 *This, UINT w, UINT h, D3DFORMAT f, D3DPOOL p, IDirect3DSurface9 **out, HANDLE *sh)
{ (void)This; (void)sh; *out = &surface_new(w, h, f, p, 0, D3DRTYPE_SURFACE)->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetRenderTarget(IDirect3DDevice9 *This, DWORD i, IDirect3DSurface9 *s)
{
    Device *d = DEV(This);
    if (i > 3 || (i == 0 && !s)) return D3DERR_INVALIDCALL;
    d->rt[i] = SURF(s);
    if (i == 0) { d->vp.X = d->vp.Y = 0; d->vp.Width = SURF(s)->desc.Width; d->vp.Height = SURF(s)->desc.Height; d->vp.MinZ = 0; d->vp.MaxZ = 1; }
    return D3D_OK;
}
static HRESULT STDMETHODCALLTYPE dev_GetRenderTarget(IDirect3DDevice9 *This, DWORD i, IDirect3DSurface9 **out)
{ Surface *s = i < 4 ? DEV(This)->rt[i] : 0; if (!s) { *out = 0; return D3DERR_NOTFOUND; } s->refs++; *out = &s->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetDepthStencilSurface(IDirect3DDevice9 *This, IDirect3DSurface9 *s) { DEV(This)->ds = SURF(s); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetDepthStencilSurface(IDirect3DDevice9 *This, IDirect3DSurface9 **out)
{ Surface *s = DEV(This)->ds; if (!s) { *out = 0; return D3DERR_NOTFOUND; } s->refs++; *out = &s->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_BeginScene(IDirect3DDevice9 *This) { (void)This; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_EndScene(IDirect3DDevice9 *This) { (void)This; return D3D_OK; }
/* Clear: the viewport's rectangle (or the rectangles given) of the render target, in its format. */
static HRESULT STDMETHODCALLTYPE dev_Clear(IDirect3DDevice9 *This, DWORD n, const D3DRECT *rs, DWORD flags, D3DCOLOR c, float z, DWORD st)
{
    Device *d = DEV(This);
    RECT r;
    DWORD i;
    (void)z; (void)st;
    if (!(flags & D3DCLEAR_TARGET) || !d->rt[0]) return D3D_OK;
    if (!n || !rs) {
        r.left = d->vp.X; r.top = d->vp.Y; r.right = d->vp.X + d->vp.Width; r.bottom = d->vp.Y + d->vp.Height;
        surface_fill(d->rt[0], &r, c);
    } else for (i = 0; i < n; i++) {
        r.left = rs[i].x1; r.top = rs[i].y1; r.right = rs[i].x2; r.bottom = rs[i].y2;
        surface_fill(d->rt[0], &r, c);
    }
    return D3D_OK;
}
static HRESULT STDMETHODCALLTYPE dev_SetTransform(IDirect3DDevice9 *This, D3DTRANSFORMSTATETYPE s, const D3DMATRIX *m) { (void)This; (void)s; (void)m; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetTransform(IDirect3DDevice9 *This, D3DTRANSFORMSTATETYPE s, D3DMATRIX *m) { (void)This; (void)s; memset(m, 0, sizeof *m); m->m[0][0] = m->m[1][1] = m->m[2][2] = m->m[3][3] = 1; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_MultiplyTransform(IDirect3DDevice9 *This, D3DTRANSFORMSTATETYPE s, const D3DMATRIX *m) { (void)This; (void)s; (void)m; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetViewport(IDirect3DDevice9 *This, const D3DVIEWPORT9 *v) { DEV(This)->vp = *v; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetViewport(IDirect3DDevice9 *This, D3DVIEWPORT9 *v) { *v = DEV(This)->vp; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetMaterial(IDirect3DDevice9 *This, const D3DMATERIAL9 *m) { (void)This; (void)m; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetMaterial(IDirect3DDevice9 *This, D3DMATERIAL9 *m) { (void)This; memset(m, 0, sizeof *m); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetLight(IDirect3DDevice9 *This, DWORD i, const D3DLIGHT9 *l) { (void)This; (void)i; (void)l; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetLight(IDirect3DDevice9 *This, DWORD i, D3DLIGHT9 *l) { (void)This; (void)i; memset(l, 0, sizeof *l); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_LightEnable(IDirect3DDevice9 *This, DWORD i, BOOL e) { (void)This; (void)i; (void)e; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetLightEnable(IDirect3DDevice9 *This, DWORD i, BOOL *e) { (void)This; (void)i; *e = FALSE; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetClipPlane(IDirect3DDevice9 *This, DWORD i, const float *p) { (void)This; (void)i; (void)p; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetClipPlane(IDirect3DDevice9 *This, DWORD i, float *p) { (void)This; (void)i; p[0] = p[1] = p[2] = p[3] = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetRenderState(IDirect3DDevice9 *This, D3DRENDERSTATETYPE s, DWORD v) { if ((DWORD)s < 256) DEV(This)->rs[s] = v; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetRenderState(IDirect3DDevice9 *This, D3DRENDERSTATETYPE s, DWORD *v) { *v = (DWORD)s < 256 ? DEV(This)->rs[s] : 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_CreateStateBlock(IDirect3DDevice9 *This, D3DSTATEBLOCKTYPE t, IDirect3DStateBlock9 **out) { (void)This; (void)t; *out = 0; return D3DERR_NOTAVAILABLE; }
static HRESULT STDMETHODCALLTYPE dev_BeginStateBlock(IDirect3DDevice9 *This) { (void)This; return D3DERR_NOTAVAILABLE; }
static HRESULT STDMETHODCALLTYPE dev_EndStateBlock(IDirect3DDevice9 *This, IDirect3DStateBlock9 **out) { (void)This; *out = 0; return D3DERR_NOTAVAILABLE; }
static HRESULT STDMETHODCALLTYPE dev_SetClipStatus(IDirect3DDevice9 *This, const D3DCLIPSTATUS9 *c) { (void)This; (void)c; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetClipStatus(IDirect3DDevice9 *This, D3DCLIPSTATUS9 *c) { (void)This; c->ClipUnion = c->ClipIntersection = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetTexture(IDirect3DDevice9 *This, DWORD s, IDirect3DBaseTexture9 **out) { (void)This; (void)s; *out = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetTexture(IDirect3DDevice9 *This, DWORD s, IDirect3DBaseTexture9 *t) { (void)This; (void)s; (void)t; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetTextureStageState(IDirect3DDevice9 *This, DWORD s, D3DTEXTURESTAGESTATETYPE t, DWORD *v) { (void)This; (void)s; (void)t; *v = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetTextureStageState(IDirect3DDevice9 *This, DWORD s, D3DTEXTURESTAGESTATETYPE t, DWORD v) { (void)This; (void)s; (void)t; (void)v; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetSamplerState(IDirect3DDevice9 *This, DWORD s, D3DSAMPLERSTATETYPE t, DWORD *v) { (void)This; (void)s; (void)t; *v = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetSamplerState(IDirect3DDevice9 *This, DWORD s, D3DSAMPLERSTATETYPE t, DWORD v) { (void)This; (void)s; (void)t; (void)v; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_ValidateDevice(IDirect3DDevice9 *This, DWORD *n) { (void)This; *n = 1; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetPaletteEntries(IDirect3DDevice9 *This, UINT n, const PALETTEENTRY *e) { (void)This; (void)n; (void)e; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetPaletteEntries(IDirect3DDevice9 *This, UINT n, PALETTEENTRY *e) { (void)This; (void)n; (void)e; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE dev_SetCurrentTexturePalette(IDirect3DDevice9 *This, UINT n) { (void)This; (void)n; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetCurrentTexturePalette(IDirect3DDevice9 *This, UINT *n) { (void)This; *n = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetScissorRect(IDirect3DDevice9 *This, const RECT *r) { (void)This; (void)r; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetScissorRect(IDirect3DDevice9 *This, RECT *r) { (void)This; r->left = r->top = r->right = r->bottom = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetSoftwareVertexProcessing(IDirect3DDevice9 *This, BOOL b) { (void)This; (void)b; return D3D_OK; }
static BOOL STDMETHODCALLTYPE dev_GetSoftwareVertexProcessing(IDirect3DDevice9 *This) { (void)This; return FALSE; }
static HRESULT STDMETHODCALLTYPE dev_SetNPatchMode(IDirect3DDevice9 *This, float n) { (void)This; (void)n; return D3D_OK; }
static float STDMETHODCALLTYPE dev_GetNPatchMode(IDirect3DDevice9 *This) { (void)This; return 0; }
/* Drawing: headless, so nothing is rasterised (see the top of this file). */
static HRESULT STDMETHODCALLTYPE dev_DrawPrimitive(IDirect3DDevice9 *This, D3DPRIMITIVETYPE t, UINT s, UINT n) { (void)This; (void)t; (void)s; (void)n; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_DrawIndexedPrimitive(IDirect3DDevice9 *This, D3DPRIMITIVETYPE t, INT b, UINT mi, UINT nv, UINT si, UINT n) { (void)This; (void)t; (void)b; (void)mi; (void)nv; (void)si; (void)n; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_DrawPrimitiveUP(IDirect3DDevice9 *This, D3DPRIMITIVETYPE t, UINT n, const void *v, UINT st) { (void)This; (void)t; (void)n; (void)v; (void)st; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_DrawIndexedPrimitiveUP(IDirect3DDevice9 *This, D3DPRIMITIVETYPE t, UINT mi, UINT nv, UINT n, const void *ix, D3DFORMAT f, const void *v, UINT st)
{ (void)This; (void)t; (void)mi; (void)nv; (void)n; (void)ix; (void)f; (void)v; (void)st; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_ProcessVertices(IDirect3DDevice9 *This, UINT s, UINT d, UINT n, IDirect3DVertexBuffer9 *b, IDirect3DVertexDeclaration9 *dc, DWORD f)
{ (void)This; (void)s; (void)d; (void)n; (void)b; (void)dc; (void)f; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE dev_CreateVertexDeclaration(IDirect3DDevice9 *This, const D3DVERTEXELEMENT9 *e, IDirect3DVertexDeclaration9 **out)
{ (void)This; *out = (IDirect3DVertexDeclaration9 *)&blob_new(e, decl_bytes(e))->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetVertexDeclaration(IDirect3DDevice9 *This, IDirect3DVertexDeclaration9 *d) { (void)This; (void)d; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetVertexDeclaration(IDirect3DDevice9 *This, IDirect3DVertexDeclaration9 **d) { (void)This; *d = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetFVF(IDirect3DDevice9 *This, DWORD f) { (void)This; (void)f; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetFVF(IDirect3DDevice9 *This, DWORD *f) { (void)This; *f = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_CreateVertexShader(IDirect3DDevice9 *This, const DWORD *f, IDirect3DVertexShader9 **out)
{ (void)This; *out = &blob_new(f, shader_bytes(f))->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetVertexShader(IDirect3DDevice9 *This, IDirect3DVertexShader9 *s) { (void)This; (void)s; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetVertexShader(IDirect3DDevice9 *This, IDirect3DVertexShader9 **s) { (void)This; *s = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetVertexShaderConstantF(IDirect3DDevice9 *This, UINT r, const float *d, UINT n) { (void)This; (void)r; (void)d; (void)n; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetVertexShaderConstantF(IDirect3DDevice9 *This, UINT r, float *d, UINT n) { (void)This; (void)r; memset(d, 0, n * 16); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetVertexShaderConstantI(IDirect3DDevice9 *This, UINT r, const int *d, UINT n) { (void)This; (void)r; (void)d; (void)n; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetVertexShaderConstantI(IDirect3DDevice9 *This, UINT r, int *d, UINT n) { (void)This; (void)r; memset(d, 0, n * 16); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetVertexShaderConstantB(IDirect3DDevice9 *This, UINT r, const BOOL *d, UINT n) { (void)This; (void)r; (void)d; (void)n; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetVertexShaderConstantB(IDirect3DDevice9 *This, UINT r, BOOL *d, UINT n) { (void)This; (void)r; memset(d, 0, n * 4); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetStreamSource(IDirect3DDevice9 *This, UINT s, IDirect3DVertexBuffer9 *b, UINT o, UINT st) { (void)This; (void)s; (void)b; (void)o; (void)st; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetStreamSource(IDirect3DDevice9 *This, UINT s, IDirect3DVertexBuffer9 **b, UINT *o, UINT *st) { (void)This; (void)s; *b = 0; *o = *st = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetStreamSourceFreq(IDirect3DDevice9 *This, UINT s, UINT f) { (void)This; (void)s; (void)f; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetStreamSourceFreq(IDirect3DDevice9 *This, UINT s, UINT *f) { (void)This; (void)s; *f = 1; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetIndices(IDirect3DDevice9 *This, IDirect3DIndexBuffer9 *b) { (void)This; (void)b; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetIndices(IDirect3DDevice9 *This, IDirect3DIndexBuffer9 **b) { (void)This; *b = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_CreatePixelShader(IDirect3DDevice9 *This, const DWORD *f, IDirect3DPixelShader9 **out)
{ (void)This; *out = (IDirect3DPixelShader9 *)&blob_new(f, shader_bytes(f))->iface; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetPixelShader(IDirect3DDevice9 *This, IDirect3DPixelShader9 *s) { (void)This; (void)s; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetPixelShader(IDirect3DDevice9 *This, IDirect3DPixelShader9 **s) { (void)This; *s = 0; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetPixelShaderConstantF(IDirect3DDevice9 *This, UINT r, const float *d, UINT n) { (void)This; (void)r; (void)d; (void)n; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetPixelShaderConstantF(IDirect3DDevice9 *This, UINT r, float *d, UINT n) { (void)This; (void)r; memset(d, 0, n * 16); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetPixelShaderConstantI(IDirect3DDevice9 *This, UINT r, const int *d, UINT n) { (void)This; (void)r; (void)d; (void)n; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetPixelShaderConstantI(IDirect3DDevice9 *This, UINT r, int *d, UINT n) { (void)This; (void)r; memset(d, 0, n * 16); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_SetPixelShaderConstantB(IDirect3DDevice9 *This, UINT r, const BOOL *d, UINT n) { (void)This; (void)r; (void)d; (void)n; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_GetPixelShaderConstantB(IDirect3DDevice9 *This, UINT r, BOOL *d, UINT n) { (void)This; (void)r; memset(d, 0, n * 4); return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_DrawRectPatch(IDirect3DDevice9 *This, UINT h, const float *s, const D3DRECTPATCH_INFO *i) { (void)This; (void)h; (void)s; (void)i; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE dev_DrawTriPatch(IDirect3DDevice9 *This, UINT h, const float *s, const D3DTRIPATCH_INFO *i) { (void)This; (void)h; (void)s; (void)i; return D3DERR_INVALIDCALL; }
static HRESULT STDMETHODCALLTYPE dev_DeletePatch(IDirect3DDevice9 *This, UINT h) { (void)This; (void)h; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE dev_CreateQuery(IDirect3DDevice9 *This, D3DQUERYTYPE t, IDirect3DQuery9 **out) { (void)This; (void)t; if (out) *out = 0; return D3DERR_NOTAVAILABLE; }

static struct IDirect3DDevice9Vtbl device_vtbl = {
    dev_QueryInterface, dev_AddRef, dev_Release, dev_TestCooperativeLevel, dev_GetAvailableTextureMem,
    dev_EvictManagedResources, dev_GetDirect3D, dev_GetDeviceCaps, dev_GetDisplayMode, dev_GetCreationParameters,
    dev_SetCursorProperties, dev_SetCursorPosition, dev_ShowCursor, dev_CreateAdditionalSwapChain, dev_GetSwapChain,
    dev_GetNumberOfSwapChains, dev_Reset, dev_Present, dev_GetBackBuffer, dev_GetRasterStatus, dev_SetDialogBoxMode,
    dev_SetGammaRamp, dev_GetGammaRamp, dev_CreateTexture, dev_CreateVolumeTexture, dev_CreateCubeTexture,
    dev_CreateVertexBuffer, dev_CreateIndexBuffer, dev_CreateRenderTarget, dev_CreateDepthStencilSurface,
    dev_UpdateSurface, dev_UpdateTexture, dev_GetRenderTargetData, dev_GetFrontBufferData, dev_StretchRect,
    dev_ColorFill, dev_CreateOffscreenPlainSurface, dev_SetRenderTarget, dev_GetRenderTarget,
    dev_SetDepthStencilSurface, dev_GetDepthStencilSurface, dev_BeginScene, dev_EndScene, dev_Clear,
    dev_SetTransform, dev_GetTransform, dev_MultiplyTransform, dev_SetViewport, dev_GetViewport, dev_SetMaterial,
    dev_GetMaterial, dev_SetLight, dev_GetLight, dev_LightEnable, dev_GetLightEnable, dev_SetClipPlane,
    dev_GetClipPlane, dev_SetRenderState, dev_GetRenderState, dev_CreateStateBlock, dev_BeginStateBlock,
    dev_EndStateBlock, dev_SetClipStatus, dev_GetClipStatus, dev_GetTexture, dev_SetTexture,
    dev_GetTextureStageState, dev_SetTextureStageState, dev_GetSamplerState, dev_SetSamplerState,
    dev_ValidateDevice, dev_SetPaletteEntries, dev_GetPaletteEntries, dev_SetCurrentTexturePalette,
    dev_GetCurrentTexturePalette, dev_SetScissorRect, dev_GetScissorRect, dev_SetSoftwareVertexProcessing,
    dev_GetSoftwareVertexProcessing, dev_SetNPatchMode, dev_GetNPatchMode, dev_DrawPrimitive,
    dev_DrawIndexedPrimitive, dev_DrawPrimitiveUP, dev_DrawIndexedPrimitiveUP, dev_ProcessVertices,
    dev_CreateVertexDeclaration, dev_SetVertexDeclaration, dev_GetVertexDeclaration, dev_SetFVF, dev_GetFVF,
    dev_CreateVertexShader, dev_SetVertexShader, dev_GetVertexShader, dev_SetVertexShaderConstantF,
    dev_GetVertexShaderConstantF, dev_SetVertexShaderConstantI, dev_GetVertexShaderConstantI,
    dev_SetVertexShaderConstantB, dev_GetVertexShaderConstantB, dev_SetStreamSource, dev_GetStreamSource,
    dev_SetStreamSourceFreq, dev_GetStreamSourceFreq, dev_SetIndices, dev_GetIndices, dev_CreatePixelShader,
    dev_SetPixelShader, dev_GetPixelShader, dev_SetPixelShaderConstantF, dev_GetPixelShaderConstantF,
    dev_SetPixelShaderConstantI, dev_GetPixelShaderConstantI, dev_SetPixelShaderConstantB,
    dev_GetPixelShaderConstantB, dev_DrawRectPatch, dev_DrawTriPatch, dev_DeletePatch, dev_CreateQuery,
};

/* ------------------------------------------------------------------ IDirect3D9 */

typedef struct D3D { IDirect3D9 iface; LONG refs; } D3D;
static HRESULT STDMETHODCALLTYPE d3d_QueryInterface(IDirect3D9 *This, REFIID riid, void **out) { (void)riid; *out = This; return D3D_OK; }
static ULONG STDMETHODCALLTYPE d3d_AddRef(IDirect3D9 *This) { return ++((D3D *)This)->refs; }
static ULONG STDMETHODCALLTYPE d3d_Release(IDirect3D9 *This) { LONG n = --((D3D *)This)->refs; return n < 0 ? 0 : n; }
static HRESULT STDMETHODCALLTYPE d3d_RegisterSoftwareDevice(IDirect3D9 *This, void *f) { (void)This; (void)f; return D3DERR_NOTAVAILABLE; }
static UINT STDMETHODCALLTYPE d3d_GetAdapterCount(IDirect3D9 *This) { (void)This; return 1; }
static HRESULT STDMETHODCALLTYPE d3d_GetAdapterIdentifier(IDirect3D9 *This, UINT a, DWORD f, D3DADAPTER_IDENTIFIER9 *id)
{ (void)This; (void)a; (void)f; memset(id, 0, sizeof *id); strcpy(id->Driver, "prism"); strcpy(id->Description, "PRISM headless Direct3D 9"); return D3D_OK; }
static UINT STDMETHODCALLTYPE d3d_GetAdapterModeCount(IDirect3D9 *This, UINT a, D3DFORMAT f) { (void)This; (void)a; return f == D3DFMT_X8R8G8B8 ? 1 : 0; }
static HRESULT STDMETHODCALLTYPE d3d_EnumAdapterModes(IDirect3D9 *This, UINT a, D3DFORMAT f, UINT i, D3DDISPLAYMODE *m)
{ (void)This; (void)a; if (i || f != D3DFMT_X8R8G8B8) return D3DERR_INVALIDCALL; m->Width = 1280; m->Height = 720; m->RefreshRate = 60; m->Format = f; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE d3d_GetAdapterDisplayMode(IDirect3D9 *This, UINT a, D3DDISPLAYMODE *m)
{ (void)This; (void)a; m->Width = 1280; m->Height = 720; m->RefreshRate = 60; m->Format = D3DFMT_X8R8G8B8; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE d3d_CheckDeviceType(IDirect3D9 *This, UINT a, D3DDEVTYPE t, D3DFORMAT af, D3DFORMAT bf, BOOL w) { (void)This; (void)a; (void)t; (void)af; (void)bf; (void)w; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE d3d_CheckDeviceFormat(IDirect3D9 *This, UINT a, D3DDEVTYPE t, D3DFORMAT af, DWORD u, D3DRESOURCETYPE r, D3DFORMAT f) { (void)This; (void)a; (void)t; (void)af; (void)u; (void)r; (void)f; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE d3d_CheckDeviceMultiSampleType(IDirect3D9 *This, UINT a, D3DDEVTYPE t, D3DFORMAT f, BOOL w, D3DMULTISAMPLE_TYPE m, DWORD *q)
{ (void)This; (void)a; (void)t; (void)f; (void)w; if (q) *q = 1; return m == D3DMULTISAMPLE_NONE ? D3D_OK : D3DERR_NOTAVAILABLE; }
static HRESULT STDMETHODCALLTYPE d3d_CheckDepthStencilMatch(IDirect3D9 *This, UINT a, D3DDEVTYPE t, D3DFORMAT af, D3DFORMAT rf, D3DFORMAT df) { (void)This; (void)a; (void)t; (void)af; (void)rf; (void)df; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE d3d_CheckDeviceFormatConversion(IDirect3D9 *This, UINT a, D3DDEVTYPE t, D3DFORMAT s, D3DFORMAT d) { (void)This; (void)a; (void)t; (void)s; (void)d; return D3D_OK; }
static HRESULT STDMETHODCALLTYPE d3d_GetDeviceCaps(IDirect3D9 *This, UINT a, D3DDEVTYPE t, D3DCAPS9 *c) { (void)This; (void)a; (void)t; fill_caps(c); return D3D_OK; }
static HMONITOR STDMETHODCALLTYPE d3d_GetAdapterMonitor(IDirect3D9 *This, UINT a) { (void)This; (void)a; return (HMONITOR)1; }
static HRESULT STDMETHODCALLTYPE d3d_CreateDevice(IDirect3D9 *This, UINT a, D3DDEVTYPE t, HWND w, DWORD f, D3DPRESENT_PARAMETERS *pp, IDirect3DDevice9 **out)
{
    Device *d = (Device *)calloc(1, sizeof *d);
    Swap *sw = (Swap *)calloc(1, sizeof *sw);
    UINT bw = pp->BackBufferWidth ? pp->BackBufferWidth : 1280, bh = pp->BackBufferHeight ? pp->BackBufferHeight : 720;
    d->iface.lpVtbl = &device_vtbl; d->refs = 1; d->d3d = This; d->pp = *pp;
    d->pp.BackBufferWidth = bw; d->pp.BackBufferHeight = bh;
    d->cp.AdapterOrdinal = a; d->cp.DeviceType = t; d->cp.hFocusWindow = w; d->cp.BehaviorFlags = f;
    d->back = surface_new(bw, bh, D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, D3DUSAGE_RENDERTARGET, D3DRTYPE_SURFACE);
    d->back->refs = 1 << 20;                 /* the device's own, never freed by a program's Release */
    if (pp->EnableAutoDepthStencil) {
        d->depth = surface_new(bw, bh, pp->AutoDepthStencilFormat, D3DPOOL_DEFAULT, D3DUSAGE_DEPTHSTENCIL, D3DRTYPE_SURFACE);
        d->depth->refs = 1 << 20;
    }
    sw->iface.lpVtbl = &swap_vtbl; sw->refs = 1; sw->dev = d;
    d->swap = &sw->iface;
    dev_SetRenderTarget(&d->iface, 0, &d->back->iface);
    d->ds = d->depth;
    *out = &d->iface;
    return D3D_OK;
}
static struct IDirect3D9Vtbl d3d_vtbl = {
    d3d_QueryInterface, d3d_AddRef, d3d_Release, d3d_RegisterSoftwareDevice, d3d_GetAdapterCount,
    d3d_GetAdapterIdentifier, d3d_GetAdapterModeCount, d3d_EnumAdapterModes, d3d_GetAdapterDisplayMode,
    d3d_CheckDeviceType, d3d_CheckDeviceFormat, d3d_CheckDeviceMultiSampleType, d3d_CheckDepthStencilMatch,
    d3d_CheckDeviceFormatConversion, d3d_GetDeviceCaps, d3d_GetAdapterMonitor, d3d_CreateDevice,
};

IDirect3D9 *WINAPI Direct3DCreate9(UINT version)
{
    D3D *d;
    if (version != D3D_SDK_VERSION) return 0;
    d = (D3D *)calloc(1, sizeof *d);
    d->iface.lpVtbl = &d3d_vtbl; d->refs = 1;
    return &d->iface;
}

/* ------------------------------------------------------------------ the rest of the two DLLs, and OLE */

HRESULT WINAPI DirectSoundCreate8(LPCGUID guid, LPDIRECTSOUND8 *out, LPUNKNOWN outer) { (void)guid; (void)outer; *out = 0; return DSERR_NODRIVER; }
HRESULT WINAPI DirectSoundCreate(LPCGUID guid, LPDIRECTSOUND *out, LPUNKNOWN outer) { (void)guid; (void)outer; *out = 0; return DSERR_NODRIVER; }
/* No image codec here: LoadBitmapCore's own "no picture" path runs. */
HRESULT WINAPI CreateStreamOnHGlobal(HGLOBAL h, BOOL del, LPSTREAM *out) { (void)h; (void)del; *out = 0; return E_NOTIMPL; }
HRESULT WINAPI OleLoadPicture(LPSTREAM s, LONG n, BOOL run, REFIID riid, LPVOID *out) { (void)s; (void)n; (void)run; (void)riid; *out = 0; return E_NOTIMPL; }

/* The GUIDs dsound.h and olectl.h declare are src/env/win32-app.c's, defined for every Win32 program. */

/* d3d9.dll and dsound.dll, for LoadLibrary and GetProcAddress (src/env/win32-app.c). */
static void *d3d9_lookup(const char *module, const char *name)
{
    if (!_stricmp(module, "d3d9.dll")) {
        if (!name) return (void *)"d3d9.dll";
        if (!strcmp(name, "Direct3DCreate9")) return (void *)Direct3DCreate9;
        return 0;
    }
    if (!_stricmp(module, "dsound.dll")) {
        if (!name) return (void *)"dsound.dll";
        if (!strcmp(name, "DirectSoundCreate8")) return (void *)DirectSoundCreate8;
        if (!strcmp(name, "DirectSoundCreate")) return (void *)DirectSoundCreate;
        return 0;
    }
    return 0;
}
void *(*prism_system_lookup)(const char *module, const char *name) = d3d9_lookup;
