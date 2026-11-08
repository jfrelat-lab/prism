/*
 * dsound.c -- dsound.dll as a SILENT device: DirectSound 8's objects with their memory, for a program compiled
 * from C or C++ (.kkrieger's _start.cpp calls it through dsound.h's virtual methods, whose table layout is
 * this file's -- src/env/com.js).
 *
 * Why silent and not absent. Some programs take "no sound card" in their stride (Quake's snd_win.c falls
 * back); .kkrieger does not -- sSystem_::InitDS failing is sFatal("could not initialize DirectSound"). So
 * the device exists: buffers hold their bytes, Lock hands them out (wrapping at the end, as a ring), Play
 * and Stop are kept, and the play cursor ADVANCES with the clock (timeGetTime) at the buffer's byte rate,
 * because a streaming program reads GetCurrentPosition to know how much to write. Nothing reaches a
 * loudspeaker yet: that is the page's audio worklet's business, a later step.
 *
 * src/env/d3d9.c's lookup table hands DirectSoundCreate8 and DirectSoundCreate to LoadLibrary("dsound.dll"),
 * so a target that links d3d9.c links this file too.
 */
#include <windows.h>
#include <dsound.h>
#include <stdlib.h>
#include <string.h>

typedef struct SBuf SBuf;
typedef struct S3D { void *vtbl; LONG refs; SBuf *owner; } S3D;   /* the 3D listener or 3D buffer of an SBuf */

struct SBuf {
    IDirectSoundBuffer8 iface;
    LONG refs;
    DWORD flags, size;
    unsigned char *bits;
    int *shared;                 /* the bytes' count of owners: DuplicateSoundBuffer shares them */
    WAVEFORMATEX fmt;
    int playing, looping;
    DWORD pos;                   /* the play cursor when last fixed (Play, Stop, SetCurrentPosition) */
    DWORD since;                 /* timeGetTime() then */
    LONG volume, pan;
    DWORD freq;
};
#define SB(p) ((SBuf *)(p))

/* IUnknown's IID, the SDK's value (windows.h declares it; no shim defines it) */
static const GUID iid_unknown = { 0x00000000, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
static const GUID *const IIDS_BUFFER[] = { &iid_unknown, &IID_IDirectSoundBuffer, &IID_IDirectSoundBuffer8 };
static int same(REFIID a, const GUID *b) { return !memcmp(a, b, sizeof(GUID)); }

/* ------------------------------------------------------------------ the 3D interfaces */

static struct IDirectSound3DListenerVtbl listener_vtbl;
static struct IDirectSound3DBufferVtbl buf3d_vtbl;
static HRESULT STDMETHODCALLTYPE s3d_QueryInterface(void *This, REFIID riid, void **out) { (void)riid; *out = This; ((S3D *)This)->refs++; return DS_OK; }
static ULONG STDMETHODCALLTYPE s3d_AddRef(void *This) { return ++((S3D *)This)->refs; }
static ULONG STDMETHODCALLTYPE s3d_Release(void *This) { LONG n = --((S3D *)This)->refs; if (n == 0) free(This); return n < 0 ? 0 : n; }
/* every getter answers zeros and every setter is kept nowhere: positions only matter to a mixer */
static HRESULT STDMETHODCALLTYPE s3d_ok(void) { return DS_OK; }
static S3D *s3d_new(SBuf *owner, void *vtbl) { S3D *s = (S3D *)calloc(1, sizeof *s); s->vtbl = vtbl; s->refs = 1; s->owner = owner; return s; }
static void s3d_tables(void)
{
    static int done;
    void **l = (void **)&listener_vtbl, **b = (void **)&buf3d_vtbl;
    unsigned i;
    if (done) return;
    done = 1;
    for (i = 0; i < sizeof listener_vtbl / sizeof(void *); i++) l[i] = (void *)s3d_ok;
    for (i = 0; i < sizeof buf3d_vtbl / sizeof(void *); i++) b[i] = (void *)s3d_ok;
    l[0] = b[0] = (void *)s3d_QueryInterface; l[1] = b[1] = (void *)s3d_AddRef; l[2] = b[2] = (void *)s3d_Release;
}

/* ------------------------------------------------------------------ buffers */

static DWORD rate(SBuf *b) { return b->fmt.nAvgBytesPerSec ? b->fmt.nAvgBytesPerSec : 176400; }
/* where the play cursor is now: fixed, plus what the clock says has played since, wrapped or stopped at the end */
static DWORD cursor(SBuf *b)
{
    unsigned long long p;
    if (!b->playing || !b->size) return b->pos;
    p = b->pos + (unsigned long long)(timeGetTime() - b->since) * rate(b) / 1000;
    if (b->looping) return (DWORD)(p % b->size);
    if (p >= b->size) { b->playing = 0; b->pos = 0; return 0; }
    return (DWORD)p;
}
static void fix(SBuf *b) { b->pos = cursor(b); b->since = timeGetTime(); }

static HRESULT STDMETHODCALLTYPE sb_QueryInterface(IDirectSoundBuffer8 *This, REFIID riid, void **out)
{
    SBuf *b = SB(This);
    unsigned i;
    for (i = 0; i < sizeof IIDS_BUFFER / sizeof *IIDS_BUFFER; i++)
        if (same(riid, IIDS_BUFFER[i])) { b->refs++; *out = This; return DS_OK; }
    s3d_tables();
    if (same(riid, &IID_IDirectSound3DListener) && (b->flags & DSBCAPS_PRIMARYBUFFER) && (b->flags & DSBCAPS_CTRL3D)) { *out = s3d_new(b, &listener_vtbl); return DS_OK; }
    if (same(riid, &IID_IDirectSound3DBuffer) && (b->flags & DSBCAPS_CTRL3D) && !(b->flags & DSBCAPS_PRIMARYBUFFER)) { *out = s3d_new(b, &buf3d_vtbl); return DS_OK; }
    *out = 0;
    return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE sb_AddRef(IDirectSoundBuffer8 *This) { return ++SB(This)->refs; }
static ULONG STDMETHODCALLTYPE sb_Release(IDirectSoundBuffer8 *This)
{
    SBuf *b = SB(This);
    LONG n = --b->refs;
    if (n == 0) { if (--*b->shared == 0) { free(b->bits); free(b->shared); } free(b); }
    return n < 0 ? 0 : n;
}
static HRESULT STDMETHODCALLTYPE sb_GetCaps(IDirectSoundBuffer8 *This, LPDSBCAPS c)
{ DWORD n = c->dwSize; memset(c, 0, n); c->dwSize = n; c->dwFlags = SB(This)->flags; c->dwBufferBytes = SB(This)->size; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_GetCurrentPosition(IDirectSoundBuffer8 *This, LPDWORD play, LPDWORD write)
{
    SBuf *b = SB(This);
    DWORD p = cursor(b);
    if (play) *play = p;
    /* the write cursor a few milliseconds ahead of the play cursor, as a real device keeps it */
    if (write) *write = b->size ? (p + (b->playing ? rate(b) / 100 & ~3u : 0)) % b->size : 0;
    return DS_OK;
}
static HRESULT STDMETHODCALLTYPE sb_GetFormat(IDirectSoundBuffer8 *This, LPWAVEFORMATEX f, DWORD n, LPDWORD written)
{
    if (f) memcpy(f, &SB(This)->fmt, n < sizeof(WAVEFORMATEX) ? n : sizeof(WAVEFORMATEX));
    if (written) *written = sizeof(WAVEFORMATEX);
    return DS_OK;
}
static HRESULT STDMETHODCALLTYPE sb_GetVolume(IDirectSoundBuffer8 *This, LPLONG v) { *v = SB(This)->volume; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_GetPan(IDirectSoundBuffer8 *This, LPLONG v) { *v = SB(This)->pan; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_GetFrequency(IDirectSoundBuffer8 *This, LPDWORD v) { *v = SB(This)->freq; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_GetStatus(IDirectSoundBuffer8 *This, LPDWORD s)
{ SBuf *b = SB(This); cursor(b); *s = (b->playing ? DSBSTATUS_PLAYING : 0) | (b->playing && b->looping ? DSBSTATUS_LOOPING : 0); return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_Initialize(IDirectSoundBuffer8 *This, LPDIRECTSOUND d, LPCDSBUFFERDESC desc) { (void)This; (void)d; (void)desc; return DSERR_ALREADYINITIALIZED; }
static HRESULT STDMETHODCALLTYPE sb_Lock(IDirectSoundBuffer8 *This, DWORD off, DWORD n, LPVOID *p1, LPDWORD n1, LPVOID *p2, LPDWORD n2, DWORD flags)
{
    SBuf *b = SB(This);
    if (b->flags & DSBCAPS_PRIMARYBUFFER) return DSERR_PRIOLEVELNEEDED;
    if (flags & DSBLOCK_FROMWRITECURSOR) sb_GetCurrentPosition(This, 0, &off);
    if (flags & DSBLOCK_ENTIREBUFFER) { off = 0; n = b->size; }
    if (off >= b->size || n > b->size) return DSERR_INVALIDPARAM;
    *p1 = b->bits + off;
    *n1 = n < b->size - off ? n : b->size - off;
    if (p2) *p2 = n > *n1 ? b->bits : 0;
    if (n2) *n2 = n - *n1;
    return DS_OK;
}
static HRESULT STDMETHODCALLTYPE sb_Play(IDirectSoundBuffer8 *This, DWORD r, DWORD prio, DWORD flags)
{ SBuf *b = SB(This); (void)r; (void)prio; fix(b); b->playing = 1; b->looping = !!(flags & DSBPLAY_LOOPING); b->since = timeGetTime(); return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_SetCurrentPosition(IDirectSoundBuffer8 *This, DWORD p)
{ SBuf *b = SB(This); b->pos = b->size ? p % b->size : 0; b->since = timeGetTime(); return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_SetFormat(IDirectSoundBuffer8 *This, LPCWAVEFORMATEX f)
{ if (!(SB(This)->flags & DSBCAPS_PRIMARYBUFFER)) return DSERR_INVALIDCALL; SB(This)->fmt = *f; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_SetVolume(IDirectSoundBuffer8 *This, LONG v) { SB(This)->volume = v; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_SetPan(IDirectSoundBuffer8 *This, LONG v) { SB(This)->pan = v; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_SetFrequency(IDirectSoundBuffer8 *This, DWORD v) { SB(This)->freq = v; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_Stop(IDirectSoundBuffer8 *This) { SBuf *b = SB(This); fix(b); b->playing = 0; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_Unlock(IDirectSoundBuffer8 *This, LPVOID p1, DWORD n1, LPVOID p2, DWORD n2) { (void)This; (void)p1; (void)n1; (void)p2; (void)n2; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_Restore(IDirectSoundBuffer8 *This) { (void)This; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_SetFX(IDirectSoundBuffer8 *This, DWORD n, LPVOID d, LPDWORD r) { (void)This; (void)d; (void)r; return n ? DSERR_CONTROLUNAVAIL : DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_AcquireResources(IDirectSoundBuffer8 *This, DWORD f, DWORD n, LPDWORD r) { (void)This; (void)f; (void)n; (void)r; return DS_OK; }
static HRESULT STDMETHODCALLTYPE sb_GetObjectInPath(IDirectSoundBuffer8 *This, REFGUID o, DWORD i, REFGUID ri, LPVOID *out) { (void)This; (void)o; (void)i; (void)ri; *out = 0; return DSERR_CONTROLUNAVAIL; }

static struct IDirectSoundBuffer8Vtbl buffer_vtbl = {
    sb_QueryInterface, sb_AddRef, sb_Release, sb_GetCaps, sb_GetCurrentPosition, sb_GetFormat, sb_GetVolume, sb_GetPan,
    sb_GetFrequency, sb_GetStatus, sb_Initialize, sb_Lock, sb_Play, sb_SetCurrentPosition, sb_SetFormat, sb_SetVolume,
    sb_SetPan, sb_SetFrequency, sb_Stop, sb_Unlock, sb_Restore, sb_SetFX, sb_AcquireResources, sb_GetObjectInPath,
};

static SBuf *sbuf_new(DWORD flags, DWORD size, const WAVEFORMATEX *fmt)
{
    SBuf *b = (SBuf *)calloc(1, sizeof *b);
    b->iface.lpVtbl = &buffer_vtbl; b->refs = 1; b->flags = flags; b->size = size;
    b->bits = (unsigned char *)calloc(1, size + 1);
    b->shared = (int *)malloc(sizeof *b->shared); *b->shared = 1;
    if (fmt) b->fmt = *fmt;
    else { b->fmt.wFormatTag = WAVE_FORMAT_PCM; b->fmt.nChannels = 2; b->fmt.nSamplesPerSec = 22050; b->fmt.wBitsPerSample = 8; b->fmt.nBlockAlign = 2; b->fmt.nAvgBytesPerSec = 44100; }
    b->freq = b->fmt.nSamplesPerSec;
    return b;
}

/* ------------------------------------------------------------------ the device */

typedef struct SDev { IDirectSound8 iface; LONG refs; } SDev;
static HRESULT STDMETHODCALLTYPE ds_QueryInterface(IDirectSound8 *This, REFIID riid, void **out)
{
    if (same(riid, &iid_unknown) || same(riid, &IID_IDirectSound) || same(riid, &IID_IDirectSound8)) { ((SDev *)This)->refs++; *out = This; return DS_OK; }
    *out = 0;
    return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE ds_AddRef(IDirectSound8 *This) { return ++((SDev *)This)->refs; }
static ULONG STDMETHODCALLTYPE ds_Release(IDirectSound8 *This) { LONG n = --((SDev *)This)->refs; if (n == 0) free(This); return n < 0 ? 0 : n; }
static HRESULT STDMETHODCALLTYPE ds_CreateSoundBuffer(IDirectSound8 *This, LPCDSBUFFERDESC d, LPDIRECTSOUNDBUFFER *out, LPUNKNOWN outer)
{
    (void)This;
    if (outer) return DSERR_NOAGGREGATION;
    if (d->dwFlags & DSBCAPS_PRIMARYBUFFER) {
        if (d->dwBufferBytes || d->lpwfxFormat) return DSERR_INVALIDPARAM;
        *out = (LPDIRECTSOUNDBUFFER)sbuf_new(d->dwFlags, 4096, 0);
        return DS_OK;
    }
    if (!d->lpwfxFormat || d->dwBufferBytes < 4) return DSERR_INVALIDPARAM;
    *out = (LPDIRECTSOUNDBUFFER)sbuf_new(d->dwFlags, d->dwBufferBytes, d->lpwfxFormat);
    return DS_OK;
}
static HRESULT STDMETHODCALLTYPE ds_GetCaps(IDirectSound8 *This, LPDSCAPS c) { DWORD n = c->dwSize; (void)This; memset(c, 0, n); c->dwSize = n; return DS_OK; }
static HRESULT STDMETHODCALLTYPE ds_DuplicateSoundBuffer(IDirectSound8 *This, LPDIRECTSOUNDBUFFER src, LPDIRECTSOUNDBUFFER *out)
{
    SBuf *a = SB(src), *b = (SBuf *)calloc(1, sizeof *b);
    (void)This;
    if (a->flags & DSBCAPS_PRIMARYBUFFER) { free(b); return DSERR_INVALIDCALL; }
    *b = *a;                                 /* the same bytes, a cursor of its own */
    b->refs = 1; b->playing = 0; b->pos = 0;
    ++*b->shared;
    *out = (LPDIRECTSOUNDBUFFER)b;
    return DS_OK;
}
static HRESULT STDMETHODCALLTYPE ds_SetCooperativeLevel(IDirectSound8 *This, HWND w, DWORD l) { (void)This; (void)w; (void)l; return DS_OK; }
static HRESULT STDMETHODCALLTYPE ds_Compact(IDirectSound8 *This) { (void)This; return DS_OK; }
static HRESULT STDMETHODCALLTYPE ds_GetSpeakerConfig(IDirectSound8 *This, LPDWORD c) { (void)This; *c = DSSPEAKER_STEREO; return DS_OK; }
static HRESULT STDMETHODCALLTYPE ds_SetSpeakerConfig(IDirectSound8 *This, DWORD c) { (void)This; (void)c; return DS_OK; }
static HRESULT STDMETHODCALLTYPE ds_Initialize(IDirectSound8 *This, LPCGUID g) { (void)This; (void)g; return DSERR_ALREADYINITIALIZED; }
static HRESULT STDMETHODCALLTYPE ds_VerifyCertification(IDirectSound8 *This, LPDWORD c) { (void)This; *c = DS_UNCERTIFIED; return DS_OK; }
static struct IDirectSound8Vtbl device_vtbl = {
    ds_QueryInterface, ds_AddRef, ds_Release, ds_CreateSoundBuffer, ds_GetCaps, ds_DuplicateSoundBuffer, ds_SetCooperativeLevel,
    ds_Compact, ds_GetSpeakerConfig, ds_SetSpeakerConfig, ds_Initialize, ds_VerifyCertification,
};

HRESULT WINAPI DirectSoundCreate8(LPCGUID guid, LPDIRECTSOUND8 *out, LPUNKNOWN outer)
{
    SDev *d;
    (void)guid;
    if (outer) { *out = 0; return DSERR_NOAGGREGATION; }
    d = (SDev *)calloc(1, sizeof *d);
    d->iface.lpVtbl = &device_vtbl; d->refs = 1;
    *out = &d->iface;
    return DS_OK;
}
HRESULT WINAPI DirectSoundCreate(LPCGUID guid, LPDIRECTSOUND *out, LPUNKNOWN outer) { return DirectSoundCreate8(guid, (LPDIRECTSOUND8 *)out, outer); }
