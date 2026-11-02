/* txref.c -- the reference for D3DX's texture shaders (tx_1_0, D3DXFillTextureTX), which src/env/d3d9.js
 * runs for Windows 4K intros that fill a texture with HLSL's noise(). Wine's d3dx9 has only stubs for
 * both, so this loads Microsoft's own d3dx9_33.dll (corpus/d3dx9_33, D3DX 9.18.904.15) by its path and
 * runs it on Wine's d3d9, in the oracle container under Xvfb.
 *
 *   WINEDLLOVERRIDES=d3dx9_33=n wine txref.exe d3dx9_33.dll src.hlsl entry w h levels fmt out.bin
 *
 * Compiles `entry` of src.hlsl for tx_1_0 with that D3DX, fills a w x h texture of `levels` levels
 * (0: the whole chain) of D3DFORMAT `fmt` (116 A32B32G32R32F, 111 R16F...) in the managed pool, and
 * writes every level's texels as they sit in memory, level 0 first, row 0 first, no padding. */
#include <windows.h>
#include <d3d9.h>
#include <d3dx9.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x) do { HRESULT hr_ = (x); if (FAILED(hr_)) { fprintf(stderr, "%s: 0x%08lx\n", #x, (unsigned long)hr_); exit(1); } } while (0)

typedef HRESULT (WINAPI *compile_fn)(const char *, UINT, const D3DXMACRO *, ID3DXInclude *, const char *, const char *, DWORD,
                                     ID3DXBuffer **, ID3DXBuffer **, ID3DXConstantTable **);
typedef HRESULT (WINAPI *create_fn)(const DWORD *, ID3DXTextureShader **);
typedef HRESULT (WINAPI *fill_fn)(IDirect3DTexture9 *, ID3DXTextureShader *);

static int texel_bytes(D3DFORMAT f) {
  switch (f) {
    case D3DFMT_A32B32G32R32F: return 16;
    case D3DFMT_A16B16G16R16F: case D3DFMT_G32R32F: return 8;
    case D3DFMT_R32F: case D3DFMT_G16R16F: case D3DFMT_A8R8G8B8: case D3DFMT_X8R8G8B8: return 4;
    case D3DFMT_R16F: return 2;
    case D3DFMT_L8: case D3DFMT_A8: return 1;
    default: fprintf(stderr, "format %d: texel size unknown here\n", (int)f); exit(1);
  }
}

int main(int argc, char **argv) {
  HMODULE dx;
  compile_fn compile;
  create_fn create;
  fill_fn fill;
  IDirect3D9 *d3d;
  IDirect3DDevice9 *dev;
  IDirect3DTexture9 *tex;
  ID3DXTextureShader *ts;
  ID3DXBuffer *code = NULL, *errs = NULL;
  D3DPRESENT_PARAMETERS pp;
  HWND wnd;
  FILE *f, *o;
  long n;
  char *src;
  int w, h, levels, bytes;
  D3DFORMAT fmt;
  DWORD l;

  if (argc != 9) { fprintf(stderr, "usage: txref d3dx9.dll src.hlsl entry w h levels fmt out.bin\n"); return 1; }
  w = atoi(argv[4]); h = atoi(argv[5]); levels = atoi(argv[6]); fmt = (D3DFORMAT)atoi(argv[7]);
  bytes = texel_bytes(fmt);
  if (!(dx = LoadLibraryA(argv[1]))) { fprintf(stderr, "cannot load %s: %lu\n", argv[1], GetLastError()); return 1; }
  compile = (compile_fn)GetProcAddress(dx, "D3DXCompileShader");
  create = (create_fn)GetProcAddress(dx, "D3DXCreateTextureShader");
  fill = (fill_fn)GetProcAddress(dx, "D3DXFillTextureTX");
  if (!compile || !create || !fill) { fprintf(stderr, "%s lacks the texture-shader entry points\n", argv[1]); return 1; }

  if (!(f = fopen(argv[2], "rb"))) { fprintf(stderr, "cannot read %s\n", argv[2]); return 1; }
  fseek(f, 0, SEEK_END); n = ftell(f); fseek(f, 0, SEEK_SET);
  src = malloc(n + 1); fread(src, 1, n, f); src[n] = 0; fclose(f);
  if (FAILED(compile(src, n, NULL, NULL, argv[3], "tx_1_0", 0, &code, &errs, NULL))) {
    fprintf(stderr, "%s: %s\n", argv[2], errs ? (char *)ID3DXBuffer_GetBufferPointer(errs) : "?");
    return 1;
  }
  CHECK(create(ID3DXBuffer_GetBufferPointer(code), &ts));

  wnd = CreateWindowA("static", "txref", WS_OVERLAPPEDWINDOW, 0, 0, 64, 64, NULL, NULL, NULL, NULL);
  d3d = Direct3DCreate9(D3D_SDK_VERSION);
  memset(&pp, 0, sizeof pp);
  pp.Windowed = TRUE; pp.SwapEffect = D3DSWAPEFFECT_DISCARD; pp.BackBufferFormat = D3DFMT_X8R8G8B8;
  pp.BackBufferWidth = 64; pp.BackBufferHeight = 64; pp.hDeviceWindow = wnd;
  CHECK(IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, wnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &dev));
  CHECK(IDirect3DDevice9_CreateTexture(dev, w, h, levels, 0, fmt, D3DPOOL_MANAGED, &tex, NULL));
  CHECK(fill(tex, ts));

  if (!(o = fopen(argv[8], "wb"))) { fprintf(stderr, "cannot write %s\n", argv[8]); return 1; }
  for (l = 0; l < IDirect3DTexture9_GetLevelCount(tex); l++) {
    D3DSURFACE_DESC d;
    D3DLOCKED_RECT r;
    UINT y;
    CHECK(IDirect3DTexture9_GetLevelDesc(tex, l, &d));
    CHECK(IDirect3DTexture9_LockRect(tex, l, &r, NULL, D3DLOCK_READONLY));
    for (y = 0; y < d.Height; y++) fwrite((char *)r.pBits + y * r.Pitch, bytes, d.Width, o);
    IDirect3DTexture9_UnlockRect(tex, l);
  }
  fclose(o);
  printf("%s: %u levels\n", argv[8], (unsigned)IDirect3DTexture9_GetLevelCount(tex));
  return 0;
}
