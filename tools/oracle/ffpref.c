/* ffpref.c -- the reference for src/env/d3d9.js's fixed function: Direct3D 9's transform and lighting and its
 * default texture stage, with no shader set, drawn by Wine's d3d9 (or another, -dll) in the oracle container
 * under Xvfb, for tools/gate-d3d9-ffp.mjs.
 *
 *   ffpref [-dll d3d9.dll] scene.txt out.rgb w h
 *
 * The scene is a grid of n x n quads over [-1,1]^2 at z = 0, each vertex's normal normalize(0.6x, 0.6y, -1)
 * (towards a viewer looking down +z) and, with D3DFVF_DIFFUSE, the colour (x+1)/2, (y+1)/2, 0.5 -- the same
 * grid the gate builds. scene.txt sets everything else, one statement a line:
 *   fvf <hex>  n <quads>  rs <state> <value>  world|view|proj <16 floats, row-major>
 *   light <i> <type> <diffuse 4> <specular 4> <ambient 4> <position 3> <direction 3> <range> <falloff> <att 3> <theta> <phi>
 *   enable <i>  material <diffuse 4> <ambient 4> <specular 4> <emissive 4> <power>  tex (a 2x2 texture on stage 0)
 * The back buffer (X8R8G8B8, cleared to 0x204060) is written row 0 first as R, G, B bytes. */
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#define CHECK(x) do { HRESULT hr_ = (x); if (FAILED(hr_)) { fprintf(stderr, "%s: 0x%08lx\n", #x, (unsigned long)hr_); exit(1); } } while (0)

static float f(char **p) { return (float)strtod(*p, p); }

int main(int argc, char **argv) {
  int a = 1, w, h, x, y, n = 8, tex = 0;
  DWORD fvf = D3DFVF_XYZ | D3DFVF_NORMAL;
  const char *dll = NULL;
  IDirect3D9 *d3d;
  IDirect3DDevice9 *dev;
  D3DPRESENT_PARAMETERS pp = {0};
  IDirect3DSurface9 *back, *sys;
  D3DLOCKED_RECT lr;
  HWND wnd;
  FILE *in, *out;
  char line[2048];
  float *vb;
  WORD *ib;
  int stride, nv, ni, k;

  for (; a < argc && argv[a][0] == '-'; a++) if (!strcmp(argv[a], "-dll") && a + 1 < argc) dll = argv[++a];
  if (argc - a < 4) { fprintf(stderr, "usage: ffpref [-dll d3d9.dll] scene.txt out.rgb w h\n"); return 2; }
  w = atoi(argv[a + 2]); h = atoi(argv[a + 3]);
  wnd = CreateWindowA("STATIC", "ffpref", WS_POPUP, 0, 0, w, h, NULL, NULL, NULL, NULL);
  if (dll) {
    HMODULE m = LoadLibraryA(dll);
    IDirect3D9 *(WINAPI *create)(UINT) = m ? (void *)GetProcAddress(m, "Direct3DCreate9") : NULL;
    if (!create || !(d3d = create(D3D_SDK_VERSION))) { fprintf(stderr, "%s: no Direct3D 9\n", dll); return 1; }
  } else if (!(d3d = Direct3DCreate9(D3D_SDK_VERSION))) { fprintf(stderr, "Direct3DCreate9 failed (no X server?)\n"); return 1; }
  pp.BackBufferWidth = w; pp.BackBufferHeight = h; pp.BackBufferFormat = D3DFMT_X8R8G8B8;
  pp.BackBufferCount = 1; pp.SwapEffect = D3DSWAPEFFECT_DISCARD; pp.hDeviceWindow = wnd; pp.Windowed = TRUE;
  pp.EnableAutoDepthStencil = TRUE; pp.AutoDepthStencilFormat = D3DFMT_D24S8;
  pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;
  CHECK(IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, wnd, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &pp, &dev));
  CHECK(IDirect3DDevice9_GetBackBuffer(dev, 0, 0, D3DBACKBUFFER_TYPE_MONO, &back));
  CHECK(IDirect3DDevice9_SetRenderState(dev, D3DRS_CULLMODE, D3DCULL_NONE));

  if (!(in = fopen(argv[a], "r"))) { fprintf(stderr, "cannot read %s\n", argv[a]); return 1; }
  while (fgets(line, sizeof line, in)) {
    char *p = line, word[32];
    int used = 0;
    if (sscanf(p, "%31s%n", word, &used) != 1) continue;
    p += used;
    if (!strcmp(word, "fvf")) fvf = (DWORD)strtoul(p, NULL, 16);
    else if (!strcmp(word, "n")) n = atoi(p);
    else if (!strcmp(word, "tex")) tex = 1;
    else if (!strcmp(word, "rs")) { int s = (int)strtol(p, &p, 10); DWORD v = (DWORD)strtoul(p, &p, 0); CHECK(IDirect3DDevice9_SetRenderState(dev, s, v)); }
    else if (!strcmp(word, "world") || !strcmp(word, "view") || !strcmp(word, "proj")) {
      D3DMATRIX m;
      for (k = 0; k < 16; k++) ((float *)&m)[k] = f(&p);
      CHECK(IDirect3DDevice9_SetTransform(dev, word[0] == 'w' ? D3DTS_WORLD : word[0] == 'v' ? D3DTS_VIEW : D3DTS_PROJECTION, &m));
    } else if (!strcmp(word, "light")) {
      D3DLIGHT9 l;
      int i = (int)strtol(p, &p, 10);
      memset(&l, 0, sizeof l);
      l.Type = (D3DLIGHTTYPE)strtol(p, &p, 10);
      l.Diffuse.r = f(&p); l.Diffuse.g = f(&p); l.Diffuse.b = f(&p); l.Diffuse.a = f(&p);
      l.Specular.r = f(&p); l.Specular.g = f(&p); l.Specular.b = f(&p); l.Specular.a = f(&p);
      l.Ambient.r = f(&p); l.Ambient.g = f(&p); l.Ambient.b = f(&p); l.Ambient.a = f(&p);
      l.Position.x = f(&p); l.Position.y = f(&p); l.Position.z = f(&p);
      l.Direction.x = f(&p); l.Direction.y = f(&p); l.Direction.z = f(&p);
      l.Range = f(&p); l.Falloff = f(&p); l.Attenuation0 = f(&p); l.Attenuation1 = f(&p); l.Attenuation2 = f(&p);
      l.Theta = f(&p); l.Phi = f(&p);
      CHECK(IDirect3DDevice9_SetLight(dev, i, &l));
    } else if (!strcmp(word, "enable")) CHECK(IDirect3DDevice9_LightEnable(dev, atoi(p), TRUE));
    else if (!strcmp(word, "material")) {
      D3DMATERIAL9 m;
      float *v = (float *)&m;
      for (k = 0; k < 17; k++) v[k] = f(&p);
      CHECK(IDirect3DDevice9_SetMaterial(dev, &m));
    }
  }
  fclose(in);

  /* the grid: position, [normal], [diffuse], [texcoord] per vertex */
  stride = 3 + (fvf & D3DFVF_NORMAL ? 3 : 0) + (fvf & D3DFVF_DIFFUSE ? 1 : 0) + (fvf & D3DFVF_TEX1 ? 2 : 0);
  nv = (n + 1) * (n + 1); ni = n * n * 6;
  vb = malloc(nv * stride * 4); ib = malloc(ni * 2);
  for (y = 0, k = 0; y <= n; y++) for (x = 0; x <= n; x++) {
    float px = -1 + 2.0f * x / n, py = -1 + 2.0f * y / n, *v = vb + (y * (n + 1) + x) * stride;
    *v++ = px; *v++ = py; *v++ = 0;
    if (fvf & D3DFVF_NORMAL) { float nx = .6f * px, ny = .6f * py, l = sqrtf(nx * nx + ny * ny + 1); *v++ = nx / l; *v++ = ny / l; *v++ = -1 / l; }
    if (fvf & D3DFVF_DIFFUSE) { DWORD c = 0xff000000 | ((DWORD)((px + 1) / 2 * 255 + .5f) << 16) | ((DWORD)((py + 1) / 2 * 255 + .5f) << 8) | 128; memcpy(v++, &c, 4); }
    if (fvf & D3DFVF_TEX1) { *v++ = (float)x / n; *v++ = (float)y / n; }
  }
  for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
    WORD i0 = (WORD)(y * (n + 1) + x);
    ib[k++] = i0; ib[k++] = i0 + 1; ib[k++] = i0 + n + 1; ib[k++] = i0 + 1; ib[k++] = i0 + n + 2; ib[k++] = i0 + n + 1;
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
    /* linear: with the nearest texel, a pixel whose coordinate falls on a texel boundary is a tie either way */
    CHECK(IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_MAGFILTER, D3DTEXF_LINEAR));
    CHECK(IDirect3DDevice9_SetSamplerState(dev, 0, D3DSAMP_MINFILTER, D3DTEXF_LINEAR));
  }
  CHECK(IDirect3DDevice9_SetFVF(dev, fvf));
  CHECK(IDirect3DDevice9_BeginScene(dev));
  CHECK(IDirect3DDevice9_Clear(dev, 0, NULL, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER, 0x204060, 1, 0));
  CHECK(IDirect3DDevice9_DrawIndexedPrimitiveUP(dev, D3DPT_TRIANGLELIST, 0, nv, ni / 3, ib, D3DFMT_INDEX16, vb, stride * 4));
  CHECK(IDirect3DDevice9_EndScene(dev));

  CHECK(IDirect3DDevice9_CreateOffscreenPlainSurface(dev, w, h, D3DFMT_X8R8G8B8, D3DPOOL_SYSTEMMEM, &sys, NULL));
  CHECK(IDirect3DDevice9_GetRenderTargetData(dev, back, sys));
  CHECK(IDirect3DSurface9_LockRect(sys, &lr, NULL, D3DLOCK_READONLY));
  if (!(out = fopen(argv[a + 1], "wb"))) { fprintf(stderr, "cannot write %s\n", argv[a + 1]); return 1; }
  for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
    const unsigned char *q = (const unsigned char *)lr.pBits + y * lr.Pitch + x * 4;   /* B, G, R, X */
    fputc(q[2], out); fputc(q[1], out); fputc(q[0], out);
  }
  fclose(out);
  return 0;
}
