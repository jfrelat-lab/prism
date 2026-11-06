/* d3d9scene.c -- a sequence of Direct3D 9 calls, read from a script and made on Wine's d3d9 (or another, -dll)
 * in the oracle container under Xvfb, its back buffer written out: the reference tools/gate-d3d9-scenes.mjs
 * holds src/env/d3d9.js to, the page playing the same script (tools/d3d9scene.js) on PRISM's device.
 *
 *   d3d9scene [-dll d3d9.dll] scene.txt out.rgb w h
 *
 * One call a line; ids are small numbers naming the objects a script creates. Numbers are C's (0x... hex).
 *   rs <state> <value>            ss <sampler> <type> <value>        tss <stage> <type> <value>
 *   tex2d <id> <w> <h> <levels> <fmt>     texcube <id> <edge> <levels> <fmt>     tex3d <id> <w> <h> <d> <levels> <fmt>
 *                                 every level of every face or slice filled with pattern() below (A8R8G8B8 or X8R8G8B8)
 *   settex <stage> <id>           (id 0: none)
 *   asm <id> <assembly, its lines separated by ';'>   a shader through D3DXAssembleShader; its bytecode is
 *                                 written to scene.txt.<id>.bin for the gate to hand PRISM
 *   setvs <id>  setps <id>        vsc <reg> <x y z w>  psc <reg> <x y z w>
 *   decl <id> <n> {<stream> <offset> <type> <method> <usage> <index>} x n      setdecl <id>      fvf <hex>
 *   vb <id> <dword...>            a token with a '.' is a float, anything else a DWORD
 *   ib <id> <index...>            16-bit indices
 *   stream <n> <vb id> <offset> <stride>      indices <ib id>
 *   clear <flags> <argb> <z> <stencil>
 *   draw <type> <start> <count>   drawi <type> <base vertex> <min index> <vertices> <start index> <count>
 * The back buffer (X8R8G8B8) is written row 0 first as R, G, B bytes; culling starts off. */
#include <windows.h>
#include <d3d9.h>
#include <d3dx9shader.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x) do { HRESULT hr_ = (x); if (FAILED(hr_)) { fprintf(stderr, "line %d: %s: 0x%08lx\n", lineno, #x, (unsigned long)hr_); exit(1); } } while (0)
#define MAXID 64

static int lineno;
static IDirect3DDevice9 *dev;
static IDirect3DBaseTexture9 *tex[MAXID];
static IDirect3DVertexShader9 *vsh[MAXID];
static IDirect3DPixelShader9 *psh[MAXID];
static IDirect3DVertexDeclaration9 *decls[MAXID];
static IDirect3DVertexBuffer9 *vbs[MAXID];
static IDirect3DIndexBuffer9 *ibs[MAXID];

/* a texel's B, G, R, A bytes -- the same function as tools/d3d9scene.js's */
static void pattern(unsigned char *p, int x, int y, int z, int face, int level) {
  p[0] = (unsigned char)(x * 53 + 17); p[1] = (unsigned char)(y * 97 + 41);
  p[2] = (unsigned char)(z * 71 + face * 43 + level * 29 + 11); p[3] = 255;
}
static void fill(unsigned char *bits, int pitch, int slice, int w, int h, int d, int face, int level) {
  int x, y, z;
  for (z = 0; z < d; z++) for (y = 0; y < h; y++) for (x = 0; x < w; x++) pattern(bits + z * slice + y * pitch + x * 4, x, y, z, face, level);
}
static int dim(int n, int l) { n >>= l; return n ? n : 1; }

static long num(char **p) { return (long)strtoul(*p, p, 0); }
static float fnum(char **p) { return (float)strtod(*p, p); }

int main(int argc, char **argv) {
  int a = 1, w, h, x, y, k;
  const char *dll = NULL;
  IDirect3D9 *d3d;
  D3DPRESENT_PARAMETERS pp = {0};
  IDirect3DSurface9 *back, *sys;
  D3DLOCKED_RECT lr;
  HWND wnd;
  FILE *in, *out;
  static char line[1 << 16];

  for (; a < argc && argv[a][0] == '-'; a++) if (!strcmp(argv[a], "-dll") && a + 1 < argc) dll = argv[++a];
  if (argc - a < 4) { fprintf(stderr, "usage: d3d9scene [-dll d3d9.dll] scene.txt out.rgb w h\n"); return 2; }
  w = atoi(argv[a + 2]); h = atoi(argv[a + 3]);
  wnd = CreateWindowA("STATIC", "d3d9scene", WS_POPUP, 0, 0, w, h, NULL, NULL, NULL, NULL);
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
  CHECK(IDirect3DDevice9_BeginScene(dev));

  if (!(in = fopen(argv[a], "r"))) { fprintf(stderr, "cannot read %s\n", argv[a]); return 1; }
  while (fgets(line, sizeof line, in)) {
    char *p = line, word[32];
    int used = 0;
    lineno++;
    if (sscanf(p, "%31s%n", word, &used) != 1) continue;
    p += used;
    if (!strcmp(word, "rs")) { long s = num(&p); CHECK(IDirect3DDevice9_SetRenderState(dev, s, (DWORD)num(&p))); }
    else if (!strcmp(word, "ss")) { long s = num(&p), t = num(&p); CHECK(IDirect3DDevice9_SetSamplerState(dev, s, t, (DWORD)num(&p))); }
    else if (!strcmp(word, "tss")) { long s = num(&p), t = num(&p); CHECK(IDirect3DDevice9_SetTextureStageState(dev, s, t, (DWORD)num(&p))); }
    else if (!strcmp(word, "tex2d")) {
      long id = num(&p), tw = num(&p), th = num(&p), lv = num(&p), fmt = num(&p), n;
      IDirect3DTexture9 *t;
      CHECK(IDirect3DDevice9_CreateTexture(dev, tw, th, lv, 0, fmt, D3DPOOL_MANAGED, &t, NULL));
      n = IDirect3DTexture9_GetLevelCount(t);
      for (k = 0; k < n; k++) {
        CHECK(IDirect3DTexture9_LockRect(t, k, &lr, NULL, 0));
        fill(lr.pBits, lr.Pitch, 0, dim(tw, k), dim(th, k), 1, 0, k);
        CHECK(IDirect3DTexture9_UnlockRect(t, k));
      }
      tex[id] = (IDirect3DBaseTexture9 *)t;
    } else if (!strcmp(word, "texcube")) {
      long id = num(&p), e = num(&p), lv = num(&p), fmt = num(&p), n, f;
      IDirect3DCubeTexture9 *t;
      CHECK(IDirect3DDevice9_CreateCubeTexture(dev, e, lv, 0, fmt, D3DPOOL_MANAGED, &t, NULL));
      n = IDirect3DCubeTexture9_GetLevelCount(t);
      for (f = 0; f < 6; f++) for (k = 0; k < n; k++) {
        CHECK(IDirect3DCubeTexture9_LockRect(t, f, k, &lr, NULL, 0));
        fill(lr.pBits, lr.Pitch, 0, dim(e, k), dim(e, k), 1, f, k);
        CHECK(IDirect3DCubeTexture9_UnlockRect(t, f, k));
      }
      tex[id] = (IDirect3DBaseTexture9 *)t;
    } else if (!strcmp(word, "tex3d")) {
      long id = num(&p), tw = num(&p), th = num(&p), td = num(&p), lv = num(&p), fmt = num(&p), n;
      IDirect3DVolumeTexture9 *t;
      D3DLOCKED_BOX lb;
      CHECK(IDirect3DDevice9_CreateVolumeTexture(dev, tw, th, td, lv, 0, fmt, D3DPOOL_MANAGED, &t, NULL));
      n = IDirect3DVolumeTexture9_GetLevelCount(t);
      for (k = 0; k < n; k++) {
        CHECK(IDirect3DVolumeTexture9_LockBox(t, k, &lb, NULL, 0));
        fill(lb.pBits, lb.RowPitch, lb.SlicePitch, dim(tw, k), dim(th, k), dim(td, k), 0, k);
        CHECK(IDirect3DVolumeTexture9_UnlockBox(t, k));
      }
      tex[id] = (IDirect3DBaseTexture9 *)t;
    } else if (!strcmp(word, "settex")) { long s = num(&p), id = num(&p); CHECK(IDirect3DDevice9_SetTexture(dev, s, id ? tex[id] : NULL)); }
    else if (!strcmp(word, "asm")) {
      long id = num(&p);
      char *s = p, name[512];
      ID3DXBuffer *code = NULL, *errs = NULL;
      FILE *o;
      for (; *s; s++) if (*s == ';') *s = '\n';
      if (FAILED(D3DXAssembleShader(p, (UINT)strlen(p), NULL, NULL, 0, &code, &errs))) {
        fprintf(stderr, "line %d: %s\n", lineno, errs ? (char *)ID3DXBuffer_GetBufferPointer(errs) : "?");
        return 1;
      }
      snprintf(name, sizeof name, "%s.%ld.bin", argv[a], id);
      if (!(o = fopen(name, "wb"))) { fprintf(stderr, "cannot write %s\n", name); return 1; }
      fwrite(ID3DXBuffer_GetBufferPointer(code), 1, ID3DXBuffer_GetBufferSize(code), o);
      fclose(o);
      if ((*(DWORD *)ID3DXBuffer_GetBufferPointer(code) >> 16) == 0xfffe) CHECK(IDirect3DDevice9_CreateVertexShader(dev, ID3DXBuffer_GetBufferPointer(code), &vsh[id]));
      else CHECK(IDirect3DDevice9_CreatePixelShader(dev, ID3DXBuffer_GetBufferPointer(code), &psh[id]));
    }
    else if (!strcmp(word, "setvs")) { long id = num(&p); CHECK(IDirect3DDevice9_SetVertexShader(dev, id ? vsh[id] : NULL)); }
    else if (!strcmp(word, "setps")) { long id = num(&p); CHECK(IDirect3DDevice9_SetPixelShader(dev, id ? psh[id] : NULL)); }
    else if (!strcmp(word, "vsc") || !strcmp(word, "psc")) {
      long r = num(&p);
      float v[4];
      for (k = 0; k < 4; k++) v[k] = fnum(&p);
      if (word[0] == 'v') CHECK(IDirect3DDevice9_SetVertexShaderConstantF(dev, r, v, 1));
      else CHECK(IDirect3DDevice9_SetPixelShaderConstantF(dev, r, v, 1));
    } else if (!strcmp(word, "decl")) {
      long id = num(&p), n = num(&p);
      D3DVERTEXELEMENT9 e[65];
      for (k = 0; k < n && k < 64; k++) {
        e[k].Stream = (WORD)num(&p); e[k].Offset = (WORD)num(&p); e[k].Type = (BYTE)num(&p);
        e[k].Method = (BYTE)num(&p); e[k].Usage = (BYTE)num(&p); e[k].UsageIndex = (BYTE)num(&p);
      }
      e[k].Stream = 0xff; e[k].Offset = 0; e[k].Type = D3DDECLTYPE_UNUSED; e[k].Method = 0; e[k].Usage = 0; e[k].UsageIndex = 0;
      CHECK(IDirect3DDevice9_CreateVertexDeclaration(dev, e, &decls[id]));
    }
    else if (!strcmp(word, "setdecl")) { long id = num(&p); CHECK(IDirect3DDevice9_SetVertexDeclaration(dev, id ? decls[id] : NULL)); }
    else if (!strcmp(word, "fvf")) CHECK(IDirect3DDevice9_SetFVF(dev, (DWORD)strtoul(p, NULL, 16)));
    else if (!strcmp(word, "vb")) {
      long id = num(&p), n = 0;
      DWORD v[8192];
      void *dst;
      char tok[64];
      int u;
      while (n < 8192 && sscanf(p, "%63s%n", tok, &u) == 1) {
        p += u;
        if (strchr(tok, '.')) { float f = (float)strtod(tok, NULL); memcpy(&v[n++], &f, 4); }
        else v[n++] = (DWORD)strtoul(tok, NULL, 0);
      }
      CHECK(IDirect3DDevice9_CreateVertexBuffer(dev, n * 4, 0, 0, D3DPOOL_MANAGED, &vbs[id], NULL));
      CHECK(IDirect3DVertexBuffer9_Lock(vbs[id], 0, 0, &dst, 0));
      memcpy(dst, v, n * 4);
      CHECK(IDirect3DVertexBuffer9_Unlock(vbs[id]));
    } else if (!strcmp(word, "ib")) {
      long id = num(&p), n = 0;
      WORD v[8192];
      void *dst;
      char *q = p;
      while (n < 8192) { long x = strtol(q, &p, 0); if (p == q) break; v[n++] = (WORD)x; q = p; }
      CHECK(IDirect3DDevice9_CreateIndexBuffer(dev, n * 2, 0, D3DFMT_INDEX16, D3DPOOL_MANAGED, &ibs[id], NULL));
      CHECK(IDirect3DIndexBuffer9_Lock(ibs[id], 0, 0, &dst, 0));
      memcpy(dst, v, n * 2);
      CHECK(IDirect3DIndexBuffer9_Unlock(ibs[id]));
    } else if (!strcmp(word, "stream")) {
      long s = num(&p), id = num(&p), off = num(&p), st = num(&p);
      CHECK(IDirect3DDevice9_SetStreamSource(dev, s, vbs[id], off, st));
    }
    else if (!strcmp(word, "indices")) CHECK(IDirect3DDevice9_SetIndices(dev, ibs[num(&p)]));
    else if (!strcmp(word, "clear")) { long f = num(&p); DWORD c = (DWORD)num(&p); float z = fnum(&p); CHECK(IDirect3DDevice9_Clear(dev, 0, NULL, f, c, z, (DWORD)num(&p))); }
    else if (!strcmp(word, "draw")) { long t = num(&p), s = num(&p); CHECK(IDirect3DDevice9_DrawPrimitive(dev, t, s, num(&p))); }
    else if (!strcmp(word, "drawi")) {
      long t = num(&p), bv = num(&p), mi = num(&p), nv = num(&p), si = num(&p);
      CHECK(IDirect3DDevice9_DrawIndexedPrimitive(dev, t, bv, mi, nv, si, num(&p)));
    } else { fprintf(stderr, "line %d: unknown call %s\n", lineno, word); return 1; }
  }
  fclose(in);
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
