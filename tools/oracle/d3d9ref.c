/* d3d9ref.c -- the Direct3D 9 reference for src/env/d3d9.js: Wine's d3d9 (wined3d on Mesa llvmpipe),
 * run in the oracle container under Xvfb by tools/gate-hlsl.mjs --capture-wine.
 *
 *   d3d9ref [-dll d3d9.dll] [-dump] [-tex] [-border AARRGGBB] [-first first.asm | -mrt first.asm] [-vs vs.asm] ps.asm out.rgba w h [c0.x ... (ps constants)]
 *
 * Draws what gate-hlsl draws, through the real API: a full-screen quad of pretransformed vertices
 * on a w x h X8R8G8B8 back buffer. -tex binds a 2x2 A8R8G8B8 texture (red, green / blue, white, its
 * first row first) to sampler 0. -first draws first.asm into an A32B32G32R32F render target and binds
 * that to sampler 0 instead. -border sets sampler 0 to D3DTADDRESS_BORDER on U and V with that colour.
 * -mrt draws first.asm TWICE with ONE/ONE blending into two A16B16G16R16F render targets at once
 * (oC0, oC1), cleared to 0, with a third bound that the shader does not write, and binds the second to
 * sampler 0. -vs draws the quad through that vertex shader instead, as XYZ vertices in clip space. Shaders are ps_3_0 ASSEMBLY through D3DXAssembleShader: Wine 8.0's HLSL
 * compiler (vkd3d-shader) rejects VPOS. The back buffer is read with GetRenderTargetData and written
 * row 0 (the top) first, as R, G, B bytes. The constants on the command line go to both stages. */
#include <windows.h>
#include <d3d9.h>
#include <d3dx9shader.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x) do { HRESULT hr_ = (x); if (FAILED(hr_)) { fprintf(stderr, "%s: 0x%08lx\n", #x, (unsigned long)hr_); exit(1); } } while (0)

static IDirect3DDevice9 *dev;
static int dump;                                     /* -dump: each shader's bytecode beside its source, <file>.bin */

static ID3DXBuffer *assemble(const char *path) {
  FILE *f = fopen(path, "rb");
  long n;
  char *s;
  ID3DXBuffer *code = NULL, *errs = NULL;
  if (!f) { fprintf(stderr, "cannot read %s\n", path); exit(1); }
  fseek(f, 0, SEEK_END); n = ftell(f); fseek(f, 0, SEEK_SET);
  s = malloc(n + 1); fread(s, 1, n, f); s[n] = 0; fclose(f);
  if (FAILED(D3DXAssembleShader(s, n, NULL, NULL, 0, &code, &errs))) {
    fprintf(stderr, "%s: %s\n", path, errs ? (char *)ID3DXBuffer_GetBufferPointer(errs) : "?");
    exit(1);
  }
  if (dump) {
    char name[512];
    FILE *o;
    snprintf(name, sizeof name, "%s.bin", path);
    if (!(o = fopen(name, "wb"))) { fprintf(stderr, "cannot write %s\n", name); exit(1); }
    fwrite(ID3DXBuffer_GetBufferPointer(code), 1, ID3DXBuffer_GetBufferSize(code), o);
    fclose(o);
  }
  return code;
}

static IDirect3DPixelShader9 *shader(const char *path) {
  IDirect3DPixelShader9 *ps;
  CHECK(IDirect3DDevice9_CreatePixelShader(dev, ID3DXBuffer_GetBufferPointer(assemble(path)), &ps));
  return ps;
}

static IDirect3DVertexShader9 *vshader(const char *path) {
  IDirect3DVertexShader9 *vs;
  CHECK(IDirect3DDevice9_CreateVertexShader(dev, ID3DXBuffer_GetBufferPointer(assemble(path)), &vs));
  return vs;
}

int main(int argc, char **argv) {
  int a = 1, tex = 0, w, h, nc = 0, x, y;
  const char *first = NULL, *vsfile = NULL, *dll = NULL;
  unsigned border = 0;
  int useBorder = 0, mrt = 0;
  float consts[256], q[24];
  HWND wnd;
  IDirect3D9 *d3d;
  D3DPRESENT_PARAMETERS pp = {0};
  IDirect3DSurface9 *back, *sys;
  D3DLOCKED_RECT lr;
  FILE *out;

  for (; a < argc && argv[a][0] == '-'; a++) {
    if (!strcmp(argv[a], "-tex")) tex = 1;
    else if (!strcmp(argv[a], "-dump")) dump = 1;
    else if (!strcmp(argv[a], "-dll") && a + 1 < argc) dll = argv[++a];
    else if (!strcmp(argv[a], "-first") && a + 1 < argc) first = argv[++a];
    else if (!strcmp(argv[a], "-mrt") && a + 1 < argc) { first = argv[++a]; mrt = 1; }
    else if (!strcmp(argv[a], "-vs") && a + 1 < argc) vsfile = argv[++a];
    else if (!strcmp(argv[a], "-border") && a + 1 < argc) { useBorder = 1; border = (unsigned)strtoul(argv[++a], NULL, 16); }
  }
  if (argc - a < 4) { fprintf(stderr, "usage: d3d9ref [-tex] [-first first.asm] ps.asm out.rgba w h [consts...]\n"); return 2; }
  w = atoi(argv[a + 2]); h = atoi(argv[a + 3]);
  for (x = a + 4; x < argc && nc < 256; x++) consts[nc++] = (float)atof(argv[x]);
  {
    /* pixel centres at integer coordinates, so the corners at -0.5 and w - 0.5 */
    float v[24] = { -.5f, -.5f, 0, 1, 0, 0,  w - .5f, -.5f, 0, 1, 1, 0,  -.5f, h - .5f, 0, 1, 0, 1,  w - .5f, h - .5f, 0, 1, 1, 1 };
    memcpy(q, v, sizeof q);
  }

  wnd = CreateWindowA("STATIC", "d3d9ref", WS_POPUP, 0, 0, w, h, NULL, NULL, NULL, NULL);
  if (dll) {
    /* another Direct3D 9 (DXVK's, renamed): the loader would otherwise hand this Winelib program Wine's builtin d3d9 */
    HMODULE m = LoadLibraryA(dll);
    IDirect3D9 *(WINAPI *create)(UINT) = m ? (void *)GetProcAddress(m, "Direct3DCreate9") : NULL;
    if (!create) { fprintf(stderr, "%s: no Direct3DCreate9\n", dll); return 1; }
    d3d = create(D3D_SDK_VERSION);
    if (!d3d) { fprintf(stderr, "%s: Direct3DCreate9 failed\n", dll); return 1; }
  } else if (!(d3d = Direct3DCreate9(D3D_SDK_VERSION))) { fprintf(stderr, "Direct3DCreate9 failed (no X server?)\n"); return 1; }
  pp.BackBufferWidth = w; pp.BackBufferHeight = h; pp.BackBufferFormat = D3DFMT_X8R8G8B8;
  pp.BackBufferCount = 1; pp.SwapEffect = D3DSWAPEFFECT_DISCARD; pp.hDeviceWindow = wnd; pp.Windowed = TRUE;
  pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;
  CHECK(IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, wnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &dev));
  CHECK(IDirect3DDevice9_GetBackBuffer(dev, 0, 0, D3DBACKBUFFER_TYPE_MONO, &back));
  CHECK(IDirect3DDevice9_SetFVF(dev, D3DFVF_XYZRHW | D3DFVF_TEX1));
  CHECK(IDirect3DDevice9_BeginScene(dev));
  CHECK(IDirect3DDevice9_Clear(dev, 0, NULL, D3DCLEAR_TARGET, 0xffff00ff, 1, 0));
  if (nc) {                                            /* the constants go to both stages */
    CHECK(IDirect3DDevice9_SetPixelShaderConstantF(dev, 0, consts, (nc + 3) / 4));
    CHECK(IDirect3DDevice9_SetVertexShaderConstantF(dev, 0, consts, (nc + 3) / 4));
  }
  if (tex) {
    /* D3D's bytes, B, G, R, A, first row first: red, green / blue, white */
    static const unsigned char t[16] = { 0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255 };
    IDirect3DTexture9 *tx;
    CHECK(IDirect3DDevice9_CreateTexture(dev, 2, 2, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &tx, NULL));
    CHECK(IDirect3DTexture9_LockRect(tx, 0, &lr, NULL, 0));
    for (y = 0; y < 2; y++) memcpy((unsigned char *)lr.pBits + y * lr.Pitch, t + y * 8, 8);
    CHECK(IDirect3DTexture9_UnlockRect(tx, 0));
    CHECK(IDirect3DDevice9_SetTexture(dev, 0, (IDirect3DBaseTexture9 *)tx));
  }
  if (first && mrt) {
    IDirect3DTexture9 *t0, *t1, *t2;
    IDirect3DSurface9 *s0, *s1, *s2;
    CHECK(IDirect3DDevice9_CreateTexture(dev, w, h, 1, D3DUSAGE_RENDERTARGET, D3DFMT_A16B16G16R16F, D3DPOOL_DEFAULT, &t0, NULL));
    CHECK(IDirect3DDevice9_CreateTexture(dev, w, h, 1, D3DUSAGE_RENDERTARGET, D3DFMT_A16B16G16R16F, D3DPOOL_DEFAULT, &t1, NULL));
    CHECK(IDirect3DTexture9_GetSurfaceLevel(t0, 0, &s0));
    CHECK(IDirect3DTexture9_GetSurfaceLevel(t1, 0, &s1));
    CHECK(IDirect3DDevice9_CreateTexture(dev, w, h, 1, D3DUSAGE_RENDERTARGET, D3DFMT_A16B16G16R16F, D3DPOOL_DEFAULT, &t2, NULL));
    CHECK(IDirect3DTexture9_GetSurfaceLevel(t2, 0, &s2));
    CHECK(IDirect3DDevice9_SetRenderTarget(dev, 0, s0));
    CHECK(IDirect3DDevice9_SetRenderTarget(dev, 1, s1));
    CHECK(IDirect3DDevice9_SetRenderTarget(dev, 2, s2));
    CHECK(IDirect3DDevice9_Clear(dev, 0, NULL, D3DCLEAR_TARGET, 0, 1, 0));
    CHECK(IDirect3DDevice9_SetRenderState(dev, D3DRS_ALPHABLENDENABLE, TRUE));
    CHECK(IDirect3DDevice9_SetRenderState(dev, D3DRS_SRCBLEND, D3DBLEND_ONE));
    CHECK(IDirect3DDevice9_SetRenderState(dev, D3DRS_DESTBLEND, D3DBLEND_ONE));
    CHECK(IDirect3DDevice9_SetPixelShader(dev, shader(first)));
    CHECK(IDirect3DDevice9_DrawPrimitiveUP(dev, D3DPT_TRIANGLESTRIP, 2, q, 24));
    CHECK(IDirect3DDevice9_DrawPrimitiveUP(dev, D3DPT_TRIANGLESTRIP, 2, q, 24));
    CHECK(IDirect3DDevice9_SetRenderState(dev, D3DRS_ALPHABLENDENABLE, FALSE));
    CHECK(IDirect3DDevice9_SetRenderTarget(dev, 2, NULL));
    CHECK(IDirect3DDevice9_SetRenderTarget(dev, 1, NULL));
    CHECK(IDirect3DDevice9_SetRenderTarget(dev, 0, back));
    CHECK(IDirect3DDevice9_SetTexture(dev, 0, (IDirect3DBaseTexture9 *)t1));
  } else if (first) {
    IDirect3DTexture9 *rt;
    IDirect3DSurface9 *s;
    CHECK(IDirect3DDevice9_CreateTexture(dev, w, h, 1, D3DUSAGE_RENDERTARGET, D3DFMT_A32B32G32R32F, D3DPOOL_DEFAULT, &rt, NULL));
    CHECK(IDirect3DTexture9_GetSurfaceLevel(rt, 0, &s));
    CHECK(IDirect3DDevice9_SetRenderTarget(dev, 0, s));
    CHECK(IDirect3DDevice9_SetPixelShader(dev, shader(first)));
    CHECK(IDirect3DDevice9_DrawPrimitiveUP(dev, D3DPT_TRIANGLESTRIP, 2, q, 24));
    CHECK(IDirect3DDevice9_SetRenderTarget(dev, 0, back));
    CHECK(IDirect3DDevice9_SetTexture(dev, 0, (IDirect3DBaseTexture9 *)rt));
  }
  if (useBorder) {
    CHECK(IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_ADDRESSU, D3DTADDRESS_BORDER));
    CHECK(IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_ADDRESSV, D3DTADDRESS_BORDER));
    CHECK(IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_BORDERCOLOR, border));
  }
  CHECK(IDirect3DDevice9_SetPixelShader(dev, shader(argv[a])));
  if (vsfile) {
    /* clip space, clockwise on screen (D3D's default culls counter-clockwise) */
    static const float c[12] = { -1, 1, .5f,  1, 1, .5f,  -1, -1, .5f,  1, -1, .5f };
    CHECK(IDirect3DDevice9_SetVertexShader(dev, vshader(vsfile)));
    CHECK(IDirect3DDevice9_SetFVF(dev, D3DFVF_XYZ));
    CHECK(IDirect3DDevice9_DrawPrimitiveUP(dev, D3DPT_TRIANGLESTRIP, 2, c, 12));
  } else CHECK(IDirect3DDevice9_DrawPrimitiveUP(dev, D3DPT_TRIANGLESTRIP, 2, q, 24));
  CHECK(IDirect3DDevice9_EndScene(dev));

  CHECK(IDirect3DDevice9_CreateOffscreenPlainSurface(dev, w, h, D3DFMT_X8R8G8B8, D3DPOOL_SYSTEMMEM, &sys, NULL));
  CHECK(IDirect3DDevice9_GetRenderTargetData(dev, back, sys));
  CHECK(IDirect3DSurface9_LockRect(sys, &lr, NULL, D3DLOCK_READONLY));
  if (!(out = fopen(argv[a + 1], "wb"))) { fprintf(stderr, "cannot write %s\n", argv[a + 1]); return 1; }
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
    const unsigned char *p = (const unsigned char *)lr.pBits + y * lr.Pitch + x * 4;   /* B, G, R, X */
    fputc(p[2], out); fputc(p[1], out); fputc(p[0], out);
  }
  fclose(out);
  return 0;
}
