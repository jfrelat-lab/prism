// headers-d3d9.js — <d3d9.h> (with d3d9types.h and d3d9caps.h folded in), for C and C++ programs
// written against Direct3D 9.
//
// The interfaces are written ONCE, as a table, and expanded through objbase.h's macros
// (DECLARE_INTERFACE_, STDMETHOD, THIS_), which src/env/headers-win32.js gives both shapes: under
// __cplusplus a struct of pure virtual methods deriving from its base, so `dev->Clear(...)` is a
// virtual call; in C a struct holding a pointer to a table of function pointers, `This` first. The two
// lay out the same -- the table pointer first, the base's methods, then the interface's own in
// declaration order -- which is what lets src/env/d3d9.c, written in C, be called from C++.
//
// The ORDERS are d3d9.h's, as MIRAGE's win32/d3d9.js has them against real binaries; the types,
// structures and constants are the SDK's (June 2010), checked against Wine's include/d3d9*.h where a
// value was in doubt. A structure a program fills or reads (D3DPRESENT_PARAMETERS, D3DCAPS9,
// D3DSURFACE_DESC, D3DVERTEXELEMENT9) has its real layout, so sizeof agrees with the SDK's.

import { methods as P, comDeclarations, methodNames } from './com.js';

/** Each interface: its base, then `ret name(params)` for every method after the base's. */
const IFACES = {
  IDirect3D9: ['IUnknown', P(`
    HRESULT RegisterSoftwareDevice(void *pInitializeFunction)
    UINT GetAdapterCount()
    HRESULT GetAdapterIdentifier(UINT Adapter, DWORD Flags, D3DADAPTER_IDENTIFIER9 *pIdentifier)
    UINT GetAdapterModeCount(UINT Adapter, D3DFORMAT Format)
    HRESULT EnumAdapterModes(UINT Adapter, D3DFORMAT Format, UINT Mode, D3DDISPLAYMODE *pMode)
    HRESULT GetAdapterDisplayMode(UINT Adapter, D3DDISPLAYMODE *pMode)
    HRESULT CheckDeviceType(UINT Adapter, D3DDEVTYPE DevType, D3DFORMAT AdapterFormat, D3DFORMAT BackBufferFormat, BOOL bWindowed)
    HRESULT CheckDeviceFormat(UINT Adapter, D3DDEVTYPE DeviceType, D3DFORMAT AdapterFormat, DWORD Usage, D3DRESOURCETYPE RType, D3DFORMAT CheckFormat)
    HRESULT CheckDeviceMultiSampleType(UINT Adapter, D3DDEVTYPE DeviceType, D3DFORMAT SurfaceFormat, BOOL Windowed, D3DMULTISAMPLE_TYPE MultiSampleType, DWORD *pQualityLevels)
    HRESULT CheckDepthStencilMatch(UINT Adapter, D3DDEVTYPE DeviceType, D3DFORMAT AdapterFormat, D3DFORMAT RenderTargetFormat, D3DFORMAT DepthStencilFormat)
    HRESULT CheckDeviceFormatConversion(UINT Adapter, D3DDEVTYPE DeviceType, D3DFORMAT SourceFormat, D3DFORMAT TargetFormat)
    HRESULT GetDeviceCaps(UINT Adapter, D3DDEVTYPE DeviceType, D3DCAPS9 *pCaps)
    HMONITOR GetAdapterMonitor(UINT Adapter)
    HRESULT CreateDevice(UINT Adapter, D3DDEVTYPE DeviceType, HWND hFocusWindow, DWORD BehaviorFlags, D3DPRESENT_PARAMETERS *pPresentationParameters, IDirect3DDevice9 **ppReturnedDeviceInterface)`)],
  IDirect3DDevice9: ['IUnknown', P(`
    HRESULT TestCooperativeLevel()
    UINT GetAvailableTextureMem()
    HRESULT EvictManagedResources()
    HRESULT GetDirect3D(IDirect3D9 **ppD3D9)
    HRESULT GetDeviceCaps(D3DCAPS9 *pCaps)
    HRESULT GetDisplayMode(UINT iSwapChain, D3DDISPLAYMODE *pMode)
    HRESULT GetCreationParameters(D3DDEVICE_CREATION_PARAMETERS *pParameters)
    HRESULT SetCursorProperties(UINT XHotSpot, UINT YHotSpot, IDirect3DSurface9 *pCursorBitmap)
    void SetCursorPosition(int X, int Y, DWORD Flags)
    BOOL ShowCursor(BOOL bShow)
    HRESULT CreateAdditionalSwapChain(D3DPRESENT_PARAMETERS *pPresentationParameters, IDirect3DSwapChain9 **pSwapChain)
    HRESULT GetSwapChain(UINT iSwapChain, IDirect3DSwapChain9 **pSwapChain)
    UINT GetNumberOfSwapChains()
    HRESULT Reset(D3DPRESENT_PARAMETERS *pPresentationParameters)
    HRESULT Present(const RECT *pSourceRect, const RECT *pDestRect, HWND hDestWindowOverride, const RGNDATA *pDirtyRegion)
    HRESULT GetBackBuffer(UINT iSwapChain, UINT iBackBuffer, D3DBACKBUFFER_TYPE Type, IDirect3DSurface9 **ppBackBuffer)
    HRESULT GetRasterStatus(UINT iSwapChain, D3DRASTER_STATUS *pRasterStatus)
    HRESULT SetDialogBoxMode(BOOL bEnableDialogs)
    void SetGammaRamp(UINT iSwapChain, DWORD Flags, const D3DGAMMARAMP *pRamp)
    void GetGammaRamp(UINT iSwapChain, D3DGAMMARAMP *pRamp)
    HRESULT CreateTexture(UINT Width, UINT Height, UINT Levels, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool, IDirect3DTexture9 **ppTexture, HANDLE *pSharedHandle)
    HRESULT CreateVolumeTexture(UINT Width, UINT Height, UINT Depth, UINT Levels, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool, IDirect3DVolumeTexture9 **ppVolumeTexture, HANDLE *pSharedHandle)
    HRESULT CreateCubeTexture(UINT EdgeLength, UINT Levels, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool, IDirect3DCubeTexture9 **ppCubeTexture, HANDLE *pSharedHandle)
    HRESULT CreateVertexBuffer(UINT Length, DWORD Usage, DWORD FVF, D3DPOOL Pool, IDirect3DVertexBuffer9 **ppVertexBuffer, HANDLE *pSharedHandle)
    HRESULT CreateIndexBuffer(UINT Length, DWORD Usage, D3DFORMAT Format, D3DPOOL Pool, IDirect3DIndexBuffer9 **ppIndexBuffer, HANDLE *pSharedHandle)
    HRESULT CreateRenderTarget(UINT Width, UINT Height, D3DFORMAT Format, D3DMULTISAMPLE_TYPE MultiSample, DWORD MultisampleQuality, BOOL Lockable, IDirect3DSurface9 **ppSurface, HANDLE *pSharedHandle)
    HRESULT CreateDepthStencilSurface(UINT Width, UINT Height, D3DFORMAT Format, D3DMULTISAMPLE_TYPE MultiSample, DWORD MultisampleQuality, BOOL Discard, IDirect3DSurface9 **ppSurface, HANDLE *pSharedHandle)
    HRESULT UpdateSurface(IDirect3DSurface9 *pSourceSurface, const RECT *pSourceRect, IDirect3DSurface9 *pDestinationSurface, const POINT *pDestPoint)
    HRESULT UpdateTexture(IDirect3DBaseTexture9 *pSourceTexture, IDirect3DBaseTexture9 *pDestinationTexture)
    HRESULT GetRenderTargetData(IDirect3DSurface9 *pRenderTarget, IDirect3DSurface9 *pDestSurface)
    HRESULT GetFrontBufferData(UINT iSwapChain, IDirect3DSurface9 *pDestSurface)
    HRESULT StretchRect(IDirect3DSurface9 *pSourceSurface, const RECT *pSourceRect, IDirect3DSurface9 *pDestSurface, const RECT *pDestRect, D3DTEXTUREFILTERTYPE Filter)
    HRESULT ColorFill(IDirect3DSurface9 *pSurface, const RECT *pRect, D3DCOLOR color)
    HRESULT CreateOffscreenPlainSurface(UINT Width, UINT Height, D3DFORMAT Format, D3DPOOL Pool, IDirect3DSurface9 **ppSurface, HANDLE *pSharedHandle)
    HRESULT SetRenderTarget(DWORD RenderTargetIndex, IDirect3DSurface9 *pRenderTarget)
    HRESULT GetRenderTarget(DWORD RenderTargetIndex, IDirect3DSurface9 **ppRenderTarget)
    HRESULT SetDepthStencilSurface(IDirect3DSurface9 *pNewZStencil)
    HRESULT GetDepthStencilSurface(IDirect3DSurface9 **ppZStencilSurface)
    HRESULT BeginScene()
    HRESULT EndScene()
    HRESULT Clear(DWORD Count, const D3DRECT *pRects, DWORD Flags, D3DCOLOR Color, float Z, DWORD Stencil)
    HRESULT SetTransform(D3DTRANSFORMSTATETYPE State, const D3DMATRIX *pMatrix)
    HRESULT GetTransform(D3DTRANSFORMSTATETYPE State, D3DMATRIX *pMatrix)
    HRESULT MultiplyTransform(D3DTRANSFORMSTATETYPE State, const D3DMATRIX *pMatrix)
    HRESULT SetViewport(const D3DVIEWPORT9 *pViewport)
    HRESULT GetViewport(D3DVIEWPORT9 *pViewport)
    HRESULT SetMaterial(const D3DMATERIAL9 *pMaterial)
    HRESULT GetMaterial(D3DMATERIAL9 *pMaterial)
    HRESULT SetLight(DWORD Index, const D3DLIGHT9 *pLight)
    HRESULT GetLight(DWORD Index, D3DLIGHT9 *pLight)
    HRESULT LightEnable(DWORD Index, BOOL Enable)
    HRESULT GetLightEnable(DWORD Index, BOOL *pEnable)
    HRESULT SetClipPlane(DWORD Index, const float *pPlane)
    HRESULT GetClipPlane(DWORD Index, float *pPlane)
    HRESULT SetRenderState(D3DRENDERSTATETYPE State, DWORD Value)
    HRESULT GetRenderState(D3DRENDERSTATETYPE State, DWORD *pValue)
    HRESULT CreateStateBlock(D3DSTATEBLOCKTYPE Type, IDirect3DStateBlock9 **ppSB)
    HRESULT BeginStateBlock()
    HRESULT EndStateBlock(IDirect3DStateBlock9 **ppSB)
    HRESULT SetClipStatus(const D3DCLIPSTATUS9 *pClipStatus)
    HRESULT GetClipStatus(D3DCLIPSTATUS9 *pClipStatus)
    HRESULT GetTexture(DWORD Stage, IDirect3DBaseTexture9 **ppTexture)
    HRESULT SetTexture(DWORD Stage, IDirect3DBaseTexture9 *pTexture)
    HRESULT GetTextureStageState(DWORD Stage, D3DTEXTURESTAGESTATETYPE Type, DWORD *pValue)
    HRESULT SetTextureStageState(DWORD Stage, D3DTEXTURESTAGESTATETYPE Type, DWORD Value)
    HRESULT GetSamplerState(DWORD Sampler, D3DSAMPLERSTATETYPE Type, DWORD *pValue)
    HRESULT SetSamplerState(DWORD Sampler, D3DSAMPLERSTATETYPE Type, DWORD Value)
    HRESULT ValidateDevice(DWORD *pNumPasses)
    HRESULT SetPaletteEntries(UINT PaletteNumber, const PALETTEENTRY *pEntries)
    HRESULT GetPaletteEntries(UINT PaletteNumber, PALETTEENTRY *pEntries)
    HRESULT SetCurrentTexturePalette(UINT PaletteNumber)
    HRESULT GetCurrentTexturePalette(UINT *PaletteNumber)
    HRESULT SetScissorRect(const RECT *pRect)
    HRESULT GetScissorRect(RECT *pRect)
    HRESULT SetSoftwareVertexProcessing(BOOL bSoftware)
    BOOL GetSoftwareVertexProcessing()
    HRESULT SetNPatchMode(float nSegments)
    float GetNPatchMode()
    HRESULT DrawPrimitive(D3DPRIMITIVETYPE PrimitiveType, UINT StartVertex, UINT PrimitiveCount)
    HRESULT DrawIndexedPrimitive(D3DPRIMITIVETYPE PrimitiveType, INT BaseVertexIndex, UINT MinVertexIndex, UINT NumVertices, UINT startIndex, UINT primCount)
    HRESULT DrawPrimitiveUP(D3DPRIMITIVETYPE PrimitiveType, UINT PrimitiveCount, const void *pVertexStreamZeroData, UINT VertexStreamZeroStride)
    HRESULT DrawIndexedPrimitiveUP(D3DPRIMITIVETYPE PrimitiveType, UINT MinVertexIndex, UINT NumVertices, UINT PrimitiveCount, const void *pIndexData, D3DFORMAT IndexDataFormat, const void *pVertexStreamZeroData, UINT VertexStreamZeroStride)
    HRESULT ProcessVertices(UINT SrcStartIndex, UINT DestIndex, UINT VertexCount, IDirect3DVertexBuffer9 *pDestBuffer, IDirect3DVertexDeclaration9 *pVertexDecl, DWORD Flags)
    HRESULT CreateVertexDeclaration(const D3DVERTEXELEMENT9 *pVertexElements, IDirect3DVertexDeclaration9 **ppDecl)
    HRESULT SetVertexDeclaration(IDirect3DVertexDeclaration9 *pDecl)
    HRESULT GetVertexDeclaration(IDirect3DVertexDeclaration9 **ppDecl)
    HRESULT SetFVF(DWORD FVF)
    HRESULT GetFVF(DWORD *pFVF)
    HRESULT CreateVertexShader(const DWORD *pFunction, IDirect3DVertexShader9 **ppShader)
    HRESULT SetVertexShader(IDirect3DVertexShader9 *pShader)
    HRESULT GetVertexShader(IDirect3DVertexShader9 **ppShader)
    HRESULT SetVertexShaderConstantF(UINT StartRegister, const float *pConstantData, UINT Vector4fCount)
    HRESULT GetVertexShaderConstantF(UINT StartRegister, float *pConstantData, UINT Vector4fCount)
    HRESULT SetVertexShaderConstantI(UINT StartRegister, const int *pConstantData, UINT Vector4iCount)
    HRESULT GetVertexShaderConstantI(UINT StartRegister, int *pConstantData, UINT Vector4iCount)
    HRESULT SetVertexShaderConstantB(UINT StartRegister, const BOOL *pConstantData, UINT BoolCount)
    HRESULT GetVertexShaderConstantB(UINT StartRegister, BOOL *pConstantData, UINT BoolCount)
    HRESULT SetStreamSource(UINT StreamNumber, IDirect3DVertexBuffer9 *pStreamData, UINT OffsetInBytes, UINT Stride)
    HRESULT GetStreamSource(UINT StreamNumber, IDirect3DVertexBuffer9 **ppStreamData, UINT *pOffsetInBytes, UINT *pStride)
    HRESULT SetStreamSourceFreq(UINT StreamNumber, UINT Setting)
    HRESULT GetStreamSourceFreq(UINT StreamNumber, UINT *pSetting)
    HRESULT SetIndices(IDirect3DIndexBuffer9 *pIndexData)
    HRESULT GetIndices(IDirect3DIndexBuffer9 **ppIndexData)
    HRESULT CreatePixelShader(const DWORD *pFunction, IDirect3DPixelShader9 **ppShader)
    HRESULT SetPixelShader(IDirect3DPixelShader9 *pShader)
    HRESULT GetPixelShader(IDirect3DPixelShader9 **ppShader)
    HRESULT SetPixelShaderConstantF(UINT StartRegister, const float *pConstantData, UINT Vector4fCount)
    HRESULT GetPixelShaderConstantF(UINT StartRegister, float *pConstantData, UINT Vector4fCount)
    HRESULT SetPixelShaderConstantI(UINT StartRegister, const int *pConstantData, UINT Vector4iCount)
    HRESULT GetPixelShaderConstantI(UINT StartRegister, int *pConstantData, UINT Vector4iCount)
    HRESULT SetPixelShaderConstantB(UINT StartRegister, const BOOL *pConstantData, UINT BoolCount)
    HRESULT GetPixelShaderConstantB(UINT StartRegister, BOOL *pConstantData, UINT BoolCount)
    HRESULT DrawRectPatch(UINT Handle, const float *pNumSegs, const D3DRECTPATCH_INFO *pRectPatchInfo)
    HRESULT DrawTriPatch(UINT Handle, const float *pNumSegs, const D3DTRIPATCH_INFO *pTriPatchInfo)
    HRESULT DeletePatch(UINT Handle)
    HRESULT CreateQuery(D3DQUERYTYPE Type, IDirect3DQuery9 **ppQuery)`)],
  IDirect3DSwapChain9: ['IUnknown', P(`
    HRESULT Present(const RECT *pSourceRect, const RECT *pDestRect, HWND hDestWindowOverride, const RGNDATA *pDirtyRegion, DWORD dwFlags)
    HRESULT GetFrontBufferData(IDirect3DSurface9 *pDestSurface)
    HRESULT GetBackBuffer(UINT iBackBuffer, D3DBACKBUFFER_TYPE Type, IDirect3DSurface9 **ppBackBuffer)
    HRESULT GetRasterStatus(D3DRASTER_STATUS *pRasterStatus)
    HRESULT GetDisplayMode(D3DDISPLAYMODE *pMode)
    HRESULT GetDevice(IDirect3DDevice9 **ppDevice)
    HRESULT GetPresentParameters(D3DPRESENT_PARAMETERS *pPresentationParameters)`)],
  IDirect3DResource9: ['IUnknown', P(`
    HRESULT GetDevice(IDirect3DDevice9 **ppDevice)
    HRESULT SetPrivateData(REFGUID refguid, const void *pData, DWORD SizeOfData, DWORD Flags)
    HRESULT GetPrivateData(REFGUID refguid, void *pData, DWORD *pSizeOfData)
    HRESULT FreePrivateData(REFGUID refguid)
    DWORD SetPriority(DWORD PriorityNew)
    DWORD GetPriority()
    void PreLoad()
    D3DRESOURCETYPE GetType()`)],
  IDirect3DVertexDeclaration9: ['IUnknown', P(`
    HRESULT GetDevice(IDirect3DDevice9 **ppDevice)
    HRESULT GetDeclaration(D3DVERTEXELEMENT9 *pElement, UINT *pNumElements)`)],
  IDirect3DVertexShader9: ['IUnknown', P(`
    HRESULT GetDevice(IDirect3DDevice9 **ppDevice)
    HRESULT GetFunction(void *pData, UINT *pSizeOfData)`)],
  IDirect3DPixelShader9: ['IUnknown', P(`
    HRESULT GetDevice(IDirect3DDevice9 **ppDevice)
    HRESULT GetFunction(void *pData, UINT *pSizeOfData)`)],
  IDirect3DStateBlock9: ['IUnknown', P(`
    HRESULT GetDevice(IDirect3DDevice9 **ppDevice)
    HRESULT Capture()
    HRESULT Apply()`)],
  IDirect3DQuery9: ['IUnknown', P(`
    HRESULT GetDevice(IDirect3DDevice9 **ppDevice)
    D3DQUERYTYPE GetType()
    DWORD GetDataSize()
    HRESULT Issue(DWORD dwIssueFlags)
    HRESULT GetData(void *pData, DWORD dwSize, DWORD dwGetDataFlags)`)],
  IDirect3DBaseTexture9: ['IDirect3DResource9', P(`
    DWORD SetLOD(DWORD LODNew)
    DWORD GetLOD()
    DWORD GetLevelCount()
    HRESULT SetAutoGenFilterType(D3DTEXTUREFILTERTYPE FilterType)
    D3DTEXTUREFILTERTYPE GetAutoGenFilterType()
    void GenerateMipSubLevels()`)],
  IDirect3DTexture9: ['IDirect3DBaseTexture9', P(`
    HRESULT GetLevelDesc(UINT Level, D3DSURFACE_DESC *pDesc)
    HRESULT GetSurfaceLevel(UINT Level, IDirect3DSurface9 **ppSurfaceLevel)
    HRESULT LockRect(UINT Level, D3DLOCKED_RECT *pLockedRect, const RECT *pRect, DWORD Flags)
    HRESULT UnlockRect(UINT Level)
    HRESULT AddDirtyRect(const RECT *pDirtyRect)`)],
  IDirect3DVolumeTexture9: ['IDirect3DBaseTexture9', P(`
    HRESULT GetLevelDesc(UINT Level, D3DVOLUME_DESC *pDesc)
    HRESULT GetVolumeLevel(UINT Level, IDirect3DVolume9 **ppVolumeLevel)
    HRESULT LockBox(UINT Level, D3DLOCKED_BOX *pLockedVolume, const D3DBOX *pBox, DWORD Flags)
    HRESULT UnlockBox(UINT Level)
    HRESULT AddDirtyBox(const D3DBOX *pDirtyBox)`)],
  IDirect3DCubeTexture9: ['IDirect3DBaseTexture9', P(`
    HRESULT GetLevelDesc(UINT Level, D3DSURFACE_DESC *pDesc)
    HRESULT GetCubeMapSurface(D3DCUBEMAP_FACES FaceType, UINT Level, IDirect3DSurface9 **ppCubeMapSurface)
    HRESULT LockRect(D3DCUBEMAP_FACES FaceType, UINT Level, D3DLOCKED_RECT *pLockedRect, const RECT *pRect, DWORD Flags)
    HRESULT UnlockRect(D3DCUBEMAP_FACES FaceType, UINT Level)
    HRESULT AddDirtyRect(D3DCUBEMAP_FACES FaceType, const RECT *pDirtyRect)`)],
  IDirect3DVertexBuffer9: ['IDirect3DResource9', P(`
    HRESULT Lock(UINT OffsetToLock, UINT SizeToLock, void **ppbData, DWORD Flags)
    HRESULT Unlock()
    HRESULT GetDesc(D3DVERTEXBUFFER_DESC *pDesc)`)],
  IDirect3DIndexBuffer9: ['IDirect3DResource9', P(`
    HRESULT Lock(UINT OffsetToLock, UINT SizeToLock, void **ppbData, DWORD Flags)
    HRESULT Unlock()
    HRESULT GetDesc(D3DINDEXBUFFER_DESC *pDesc)`)],
  IDirect3DSurface9: ['IDirect3DResource9', P(`
    HRESULT GetContainer(REFIID riid, void **ppContainer)
    HRESULT GetDesc(D3DSURFACE_DESC *pDesc)
    HRESULT LockRect(D3DLOCKED_RECT *pLockedRect, const RECT *pRect, DWORD Flags)
    HRESULT UnlockRect()
    HRESULT GetDC(HDC *phdc)
    HRESULT ReleaseDC(HDC hdc)`)],
  IDirect3DVolume9: ['IUnknown', P(`
    HRESULT GetDevice(IDirect3DDevice9 **ppDevice)
    HRESULT SetPrivateData(REFGUID refguid, const void *pData, DWORD SizeOfData, DWORD Flags)
    HRESULT GetPrivateData(REFGUID refguid, void *pData, DWORD *pSizeOfData)
    HRESULT FreePrivateData(REFGUID refguid)
    HRESULT GetContainer(REFIID riid, void **ppContainer)
    HRESULT GetDesc(D3DVOLUME_DESC *pDesc)
    HRESULT LockBox(D3DLOCKED_BOX *pLockedVolume, const D3DBOX *pBox, DWORD Flags)
    HRESULT UnlockBox()`)],
};

/** The method lists, base first, for src/env/d3d9.c's tables and for checking them (tools/gate-d3d9-com.mjs). */
export const d3d9Methods = (name) => methodNames(IFACES, name);
export const D3D9_INTERFACES = Object.keys(IFACES);

const TYPES = `
#define D3D_SDK_VERSION 32
#define D3DADAPTER_DEFAULT 0
#define D3DENUM_WHQL_LEVEL 0x00000002L
#define D3D_OK S_OK
#define MAKE_D3DHRESULT(code) MAKE_HRESULT(1, 0x876, code)
#define D3DERR_WRONGTEXTUREFORMAT       MAKE_D3DHRESULT(2072)
#define D3DERR_UNSUPPORTEDCOLOROPERATION MAKE_D3DHRESULT(2073)
#define D3DERR_TOOMANYOPERATIONS        MAKE_D3DHRESULT(2077)
#define D3DERR_CONFLICTINGRENDERSTATE   MAKE_D3DHRESULT(2081)
#define D3DERR_DRIVERINTERNALERROR      MAKE_D3DHRESULT(2087)
#define D3DERR_NOTFOUND                 MAKE_D3DHRESULT(2150)
#define D3DERR_MOREDATA                 MAKE_D3DHRESULT(2151)
#define D3DERR_DEVICELOST               MAKE_D3DHRESULT(2152)
#define D3DERR_DEVICENOTRESET           MAKE_D3DHRESULT(2153)
#define D3DERR_NOTAVAILABLE             MAKE_D3DHRESULT(2154)
#define D3DERR_OUTOFVIDEOMEMORY         MAKE_D3DHRESULT(380)
#define D3DERR_INVALIDDEVICE            MAKE_D3DHRESULT(2155)
#define D3DERR_INVALIDCALL              MAKE_D3DHRESULT(2156)
#define D3DERR_DRIVERINVALIDCALL        MAKE_D3DHRESULT(2157)
#define D3DERR_WASSTILLDRAWING          MAKE_D3DHRESULT(540)
#define D3DOK_NOAUTOGEN                 ((HRESULT)0x0876086FL)

/* wingdi.h's region data, which Present names. */
#ifndef _PRISM_RGNDATA_DEFINED
#define _PRISM_RGNDATA_DEFINED
typedef struct _RGNDATAHEADER { DWORD dwSize, iType, nCount, nRgnSize; RECT rcBound; } RGNDATAHEADER;
typedef struct _RGNDATA { RGNDATAHEADER rdh; char Buffer[1]; } RGNDATA;
#endif

typedef DWORD D3DCOLOR;
#define D3DCOLOR_ARGB(a,r,g,b) ((D3DCOLOR)((((a)&0xff)<<24)|(((r)&0xff)<<16)|(((g)&0xff)<<8)|((b)&0xff)))
#define D3DCOLOR_RGBA(r,g,b,a) D3DCOLOR_ARGB(a,r,g,b)
#define D3DCOLOR_XRGB(r,g,b)   D3DCOLOR_ARGB(0xff,r,g,b)
#define MAKEFOURCC(c0,c1,c2,c3) ((DWORD)(BYTE)(c0) | ((DWORD)(BYTE)(c1) << 8) | ((DWORD)(BYTE)(c2) << 16) | ((DWORD)(BYTE)(c3) << 24))

#ifndef _PRISM_D3DVECTOR_DEFINED
#define _PRISM_D3DVECTOR_DEFINED
typedef struct _D3DVECTOR { float x, y, z; } D3DVECTOR;
#endif
typedef struct _D3DCOLORVALUE { float r, g, b, a; } D3DCOLORVALUE;
typedef struct _D3DRECT { LONG x1, y1, x2, y2; } D3DRECT;
typedef struct _D3DMATRIX { float m[4][4]; } D3DMATRIX;
typedef struct _D3DVIEWPORT9 { DWORD X, Y, Width, Height; float MinZ, MaxZ; } D3DVIEWPORT9;
typedef struct _D3DCLIPSTATUS9 { DWORD ClipUnion, ClipIntersection; } D3DCLIPSTATUS9;
typedef struct _D3DMATERIAL9 { D3DCOLORVALUE Diffuse, Ambient, Specular, Emissive; float Power; } D3DMATERIAL9;
typedef enum _D3DLIGHTTYPE { D3DLIGHT_POINT = 1, D3DLIGHT_SPOT = 2, D3DLIGHT_DIRECTIONAL = 3, D3DLIGHT_FORCE_DWORD = 0x7fffffff } D3DLIGHTTYPE;
typedef struct _D3DLIGHT9 {
    D3DLIGHTTYPE Type; D3DCOLORVALUE Diffuse, Specular, Ambient; D3DVECTOR Position, Direction;
    float Range, Falloff, Attenuation0, Attenuation1, Attenuation2, Theta, Phi;
} D3DLIGHT9;
typedef struct _D3DGAMMARAMP { WORD red[256], green[256], blue[256]; } D3DGAMMARAMP;
#define D3DSGR_NO_CALIBRATION 0x00000000L
#define D3DSGR_CALIBRATE      0x00000001L

#define D3DCLEAR_TARGET  0x00000001L
#define D3DCLEAR_ZBUFFER 0x00000002L
#define D3DCLEAR_STENCIL 0x00000004L

typedef enum _D3DFORMAT {
    D3DFMT_UNKNOWN = 0,
    D3DFMT_R8G8B8 = 20, D3DFMT_A8R8G8B8 = 21, D3DFMT_X8R8G8B8 = 22, D3DFMT_R5G6B5 = 23, D3DFMT_X1R5G5B5 = 24,
    D3DFMT_A1R5G5B5 = 25, D3DFMT_A4R4G4B4 = 26, D3DFMT_R3G3B2 = 27, D3DFMT_A8 = 28, D3DFMT_A8R3G3B2 = 29,
    D3DFMT_X4R4G4B4 = 30, D3DFMT_A2B10G10R10 = 31, D3DFMT_A8B8G8R8 = 32, D3DFMT_X8B8G8R8 = 33, D3DFMT_G16R16 = 34,
    D3DFMT_A2R10G10B10 = 35, D3DFMT_A16B16G16R16 = 36,
    D3DFMT_A8P8 = 40, D3DFMT_P8 = 41,
    D3DFMT_L8 = 50, D3DFMT_A8L8 = 51, D3DFMT_A4L4 = 52,
    D3DFMT_V8U8 = 60, D3DFMT_L6V5U5 = 61, D3DFMT_X8L8V8U8 = 62, D3DFMT_Q8W8V8U8 = 63, D3DFMT_V16U16 = 64,
    D3DFMT_A2W10V10U10 = 67,
    D3DFMT_UYVY = 0x59565955, D3DFMT_YUY2 = 0x32595559,
    D3DFMT_DXT1 = 0x31545844, D3DFMT_DXT2 = 0x32545844, D3DFMT_DXT3 = 0x33545844, D3DFMT_DXT4 = 0x34545844, D3DFMT_DXT5 = 0x35545844,
    D3DFMT_D16_LOCKABLE = 70, D3DFMT_D32 = 71, D3DFMT_D15S1 = 73, D3DFMT_D24S8 = 75, D3DFMT_D24X8 = 77, D3DFMT_D24X4S4 = 79,
    D3DFMT_D16 = 80, D3DFMT_D32F_LOCKABLE = 82, D3DFMT_D24FS8 = 83,
    D3DFMT_L16 = 81,
    D3DFMT_VERTEXDATA = 100, D3DFMT_INDEX16 = 101, D3DFMT_INDEX32 = 102,
    D3DFMT_Q16W16V16U16 = 110,
    D3DFMT_R16F = 111, D3DFMT_G16R16F = 112, D3DFMT_A16B16G16R16F = 113,
    D3DFMT_R32F = 114, D3DFMT_G32R32F = 115, D3DFMT_A32B32G32R32F = 116,
    D3DFMT_CxV8U8 = 117,
    D3DFMT_FORCE_DWORD = 0x7fffffff
} D3DFORMAT;

typedef enum _D3DDEVTYPE { D3DDEVTYPE_HAL = 1, D3DDEVTYPE_REF = 2, D3DDEVTYPE_SW = 3, D3DDEVTYPE_NULLREF = 4, D3DDEVTYPE_FORCE_DWORD = 0x7fffffff } D3DDEVTYPE;
typedef enum _D3DPOOL { D3DPOOL_DEFAULT = 0, D3DPOOL_MANAGED = 1, D3DPOOL_SYSTEMMEM = 2, D3DPOOL_SCRATCH = 3, D3DPOOL_FORCE_DWORD = 0x7fffffff } D3DPOOL;
typedef enum _D3DRESOURCETYPE {
    D3DRTYPE_SURFACE = 1, D3DRTYPE_VOLUME = 2, D3DRTYPE_TEXTURE = 3, D3DRTYPE_VOLUMETEXTURE = 4,
    D3DRTYPE_CUBETEXTURE = 5, D3DRTYPE_VERTEXBUFFER = 6, D3DRTYPE_INDEXBUFFER = 7, D3DRTYPE_FORCE_DWORD = 0x7fffffff
} D3DRESOURCETYPE;
typedef enum _D3DMULTISAMPLE_TYPE {
    D3DMULTISAMPLE_NONE = 0, D3DMULTISAMPLE_NONMASKABLE = 1, D3DMULTISAMPLE_2_SAMPLES = 2, D3DMULTISAMPLE_4_SAMPLES = 4,
    D3DMULTISAMPLE_FORCE_DWORD = 0x7fffffff
} D3DMULTISAMPLE_TYPE;
typedef enum _D3DSWAPEFFECT { D3DSWAPEFFECT_DISCARD = 1, D3DSWAPEFFECT_FLIP = 2, D3DSWAPEFFECT_COPY = 3, D3DSWAPEFFECT_FORCE_DWORD = 0x7fffffff } D3DSWAPEFFECT;
typedef enum _D3DBACKBUFFER_TYPE { D3DBACKBUFFER_TYPE_MONO = 0, D3DBACKBUFFER_TYPE_LEFT = 1, D3DBACKBUFFER_TYPE_RIGHT = 2, D3DBACKBUFFER_TYPE_FORCE_DWORD = 0x7fffffff } D3DBACKBUFFER_TYPE;
typedef enum _D3DCUBEMAP_FACES {
    D3DCUBEMAP_FACE_POSITIVE_X = 0, D3DCUBEMAP_FACE_NEGATIVE_X = 1, D3DCUBEMAP_FACE_POSITIVE_Y = 2,
    D3DCUBEMAP_FACE_NEGATIVE_Y = 3, D3DCUBEMAP_FACE_POSITIVE_Z = 4, D3DCUBEMAP_FACE_NEGATIVE_Z = 5,
    D3DCUBEMAP_FACE_FORCE_DWORD = 0x7fffffff
} D3DCUBEMAP_FACES;
typedef enum _D3DSTATEBLOCKTYPE { D3DSBT_ALL = 1, D3DSBT_PIXELSTATE = 2, D3DSBT_VERTEXSTATE = 3, D3DSBT_FORCE_DWORD = 0x7fffffff } D3DSTATEBLOCKTYPE;
typedef enum _D3DQUERYTYPE {
    D3DQUERYTYPE_VCACHE = 4, D3DQUERYTYPE_RESOURCEMANAGER = 5, D3DQUERYTYPE_VERTEXSTATS = 6, D3DQUERYTYPE_EVENT = 8,
    D3DQUERYTYPE_OCCLUSION = 9, D3DQUERYTYPE_TIMESTAMP = 10
} D3DQUERYTYPE;
typedef enum _D3DPRIMITIVETYPE {
    D3DPT_POINTLIST = 1, D3DPT_LINELIST = 2, D3DPT_LINESTRIP = 3, D3DPT_TRIANGLELIST = 4, D3DPT_TRIANGLESTRIP = 5,
    D3DPT_TRIANGLEFAN = 6, D3DPT_FORCE_DWORD = 0x7fffffff
} D3DPRIMITIVETYPE;
typedef enum _D3DTRANSFORMSTATETYPE {
    D3DTS_VIEW = 2, D3DTS_PROJECTION = 3, D3DTS_TEXTURE0 = 16, D3DTS_TEXTURE1 = 17, D3DTS_TEXTURE2 = 18, D3DTS_TEXTURE3 = 19,
    D3DTS_TEXTURE4 = 20, D3DTS_TEXTURE5 = 21, D3DTS_TEXTURE6 = 22, D3DTS_TEXTURE7 = 23, D3DTS_FORCE_DWORD = 0x7fffffff
} D3DTRANSFORMSTATETYPE;
#define D3DTS_WORLDMATRIX(index) (D3DTRANSFORMSTATETYPE)((index) + 256)
#define D3DTS_WORLD  D3DTS_WORLDMATRIX(0)
#define D3DTS_WORLD1 D3DTS_WORLDMATRIX(1)
#define D3DTS_WORLD2 D3DTS_WORLDMATRIX(2)
#define D3DTS_WORLD3 D3DTS_WORLDMATRIX(3)

typedef enum _D3DRENDERSTATETYPE {
    D3DRS_ZENABLE = 7, D3DRS_FILLMODE = 8, D3DRS_SHADEMODE = 9, D3DRS_ZWRITEENABLE = 14, D3DRS_ALPHATESTENABLE = 15,
    D3DRS_LASTPIXEL = 16, D3DRS_SRCBLEND = 19, D3DRS_DESTBLEND = 20, D3DRS_CULLMODE = 22, D3DRS_ZFUNC = 23,
    D3DRS_ALPHAREF = 24, D3DRS_ALPHAFUNC = 25, D3DRS_DITHERENABLE = 26, D3DRS_ALPHABLENDENABLE = 27,
    D3DRS_FOGENABLE = 28, D3DRS_SPECULARENABLE = 29, D3DRS_FOGCOLOR = 34, D3DRS_FOGTABLEMODE = 35,
    D3DRS_FOGSTART = 36, D3DRS_FOGEND = 37, D3DRS_FOGDENSITY = 38, D3DRS_RANGEFOGENABLE = 48,
    D3DRS_STENCILENABLE = 52, D3DRS_STENCILFAIL = 53, D3DRS_STENCILZFAIL = 54, D3DRS_STENCILPASS = 55,
    D3DRS_STENCILFUNC = 56, D3DRS_STENCILREF = 57, D3DRS_STENCILMASK = 58, D3DRS_STENCILWRITEMASK = 59,
    D3DRS_TEXTUREFACTOR = 60, D3DRS_WRAP0 = 128, D3DRS_WRAP1 = 129, D3DRS_WRAP2 = 130, D3DRS_WRAP3 = 131,
    D3DRS_WRAP4 = 132, D3DRS_WRAP5 = 133, D3DRS_WRAP6 = 134, D3DRS_WRAP7 = 135, D3DRS_CLIPPING = 136,
    D3DRS_LIGHTING = 137, D3DRS_AMBIENT = 139, D3DRS_FOGVERTEXMODE = 140, D3DRS_COLORVERTEX = 141,
    D3DRS_LOCALVIEWER = 142, D3DRS_NORMALIZENORMALS = 143, D3DRS_DIFFUSEMATERIALSOURCE = 145,
    D3DRS_SPECULARMATERIALSOURCE = 146, D3DRS_AMBIENTMATERIALSOURCE = 147, D3DRS_EMISSIVEMATERIALSOURCE = 148,
    D3DRS_VERTEXBLEND = 151, D3DRS_CLIPPLANEENABLE = 152, D3DRS_POINTSIZE = 154, D3DRS_POINTSIZE_MIN = 155,
    D3DRS_POINTSPRITEENABLE = 156, D3DRS_POINTSCALEENABLE = 157, D3DRS_POINTSCALE_A = 158, D3DRS_POINTSCALE_B = 159,
    D3DRS_POINTSCALE_C = 160, D3DRS_MULTISAMPLEANTIALIAS = 161, D3DRS_MULTISAMPLEMASK = 162,
    D3DRS_PATCHEDGESTYLE = 163, D3DRS_DEBUGMONITORTOKEN = 165, D3DRS_POINTSIZE_MAX = 166,
    D3DRS_INDEXEDVERTEXBLENDENABLE = 167, D3DRS_COLORWRITEENABLE = 168, D3DRS_TWEENFACTOR = 170,
    D3DRS_BLENDOP = 171, D3DRS_POSITIONDEGREE = 172, D3DRS_NORMALDEGREE = 173, D3DRS_SCISSORTESTENABLE = 174,
    D3DRS_SLOPESCALEDEPTHBIAS = 175, D3DRS_ANTIALIASEDLINEENABLE = 176, D3DRS_MINTESSELLATIONLEVEL = 178,
    D3DRS_MAXTESSELLATIONLEVEL = 179, D3DRS_ADAPTIVETESS_X = 180, D3DRS_ADAPTIVETESS_Y = 181,
    D3DRS_ADAPTIVETESS_Z = 182, D3DRS_ADAPTIVETESS_W = 183, D3DRS_ENABLEADAPTIVETESSELLATION = 184,
    D3DRS_TWOSIDEDSTENCILMODE = 185, D3DRS_CCW_STENCILFAIL = 186, D3DRS_CCW_STENCILZFAIL = 187,
    D3DRS_CCW_STENCILPASS = 188, D3DRS_CCW_STENCILFUNC = 189, D3DRS_COLORWRITEENABLE1 = 190,
    D3DRS_COLORWRITEENABLE2 = 191, D3DRS_COLORWRITEENABLE3 = 192, D3DRS_BLENDFACTOR = 193,
    D3DRS_SRGBWRITEENABLE = 194, D3DRS_DEPTHBIAS = 195, D3DRS_WRAP8 = 198, D3DRS_WRAP9 = 199, D3DRS_WRAP10 = 200,
    D3DRS_WRAP11 = 201, D3DRS_WRAP12 = 202, D3DRS_WRAP13 = 203, D3DRS_WRAP14 = 204, D3DRS_WRAP15 = 205,
    D3DRS_SEPARATEALPHABLENDENABLE = 206, D3DRS_SRCBLENDALPHA = 207, D3DRS_DESTBLENDALPHA = 208,
    D3DRS_BLENDOPALPHA = 209, D3DRS_FORCE_DWORD = 0x7fffffff
} D3DRENDERSTATETYPE;

typedef enum _D3DTEXTURESTAGESTATETYPE {
    D3DTSS_COLOROP = 1, D3DTSS_COLORARG1 = 2, D3DTSS_COLORARG2 = 3, D3DTSS_ALPHAOP = 4, D3DTSS_ALPHAARG1 = 5,
    D3DTSS_ALPHAARG2 = 6, D3DTSS_BUMPENVMAT00 = 7, D3DTSS_BUMPENVMAT01 = 8, D3DTSS_BUMPENVMAT10 = 9,
    D3DTSS_BUMPENVMAT11 = 10, D3DTSS_TEXCOORDINDEX = 11, D3DTSS_BUMPENVLSCALE = 22, D3DTSS_BUMPENVLOFFSET = 23,
    D3DTSS_TEXTURETRANSFORMFLAGS = 24, D3DTSS_COLORARG0 = 26, D3DTSS_ALPHAARG0 = 27, D3DTSS_RESULTARG = 28,
    D3DTSS_CONSTANT = 32, D3DTSS_FORCE_DWORD = 0x7fffffff
} D3DTEXTURESTAGESTATETYPE;
typedef enum _D3DTEXTUREOP {
    D3DTOP_DISABLE = 1, D3DTOP_SELECTARG1 = 2, D3DTOP_SELECTARG2 = 3, D3DTOP_MODULATE = 4, D3DTOP_MODULATE2X = 5,
    D3DTOP_MODULATE4X = 6, D3DTOP_ADD = 7, D3DTOP_ADDSIGNED = 8, D3DTOP_ADDSIGNED2X = 9, D3DTOP_SUBTRACT = 10,
    D3DTOP_ADDSMOOTH = 11, D3DTOP_BLENDDIFFUSEALPHA = 12, D3DTOP_BLENDTEXTUREALPHA = 13, D3DTOP_BLENDFACTORALPHA = 14,
    D3DTOP_BLENDTEXTUREALPHAPM = 15, D3DTOP_BLENDCURRENTALPHA = 16, D3DTOP_PREMODULATE = 17,
    D3DTOP_MODULATEALPHA_ADDCOLOR = 18, D3DTOP_MODULATECOLOR_ADDALPHA = 19, D3DTOP_MODULATEINVALPHA_ADDCOLOR = 20,
    D3DTOP_MODULATEINVCOLOR_ADDALPHA = 21, D3DTOP_BUMPENVMAP = 22, D3DTOP_BUMPENVMAPLUMINANCE = 23,
    D3DTOP_DOTPRODUCT3 = 24, D3DTOP_MULTIPLYADD = 25, D3DTOP_LERP = 26, D3DTOP_FORCE_DWORD = 0x7fffffff
} D3DTEXTUREOP;
#define D3DTA_SELECTMASK     0x0000000f
#define D3DTA_DIFFUSE        0x00000000
#define D3DTA_CURRENT        0x00000001
#define D3DTA_TEXTURE        0x00000002
#define D3DTA_TFACTOR        0x00000003
#define D3DTA_SPECULAR       0x00000004
#define D3DTA_TEMP           0x00000005
#define D3DTA_CONSTANT       0x00000006
#define D3DTA_COMPLEMENT     0x00000010
#define D3DTA_ALPHAREPLICATE 0x00000020

typedef enum _D3DSAMPLERSTATETYPE {
    D3DSAMP_ADDRESSU = 1, D3DSAMP_ADDRESSV = 2, D3DSAMP_ADDRESSW = 3, D3DSAMP_BORDERCOLOR = 4, D3DSAMP_MAGFILTER = 5,
    D3DSAMP_MINFILTER = 6, D3DSAMP_MIPFILTER = 7, D3DSAMP_MIPMAPLODBIAS = 8, D3DSAMP_MAXMIPLEVEL = 9,
    D3DSAMP_MAXANISOTROPY = 10, D3DSAMP_SRGBTEXTURE = 11, D3DSAMP_ELEMENTINDEX = 12, D3DSAMP_DMAPOFFSET = 13,
    D3DSAMP_FORCE_DWORD = 0x7fffffff
} D3DSAMPLERSTATETYPE;
#define D3DDMAPSAMPLER 256
#define D3DVERTEXTEXTURESAMPLER0 (D3DDMAPSAMPLER+1)
#define D3DVERTEXTEXTURESAMPLER1 (D3DDMAPSAMPLER+2)
#define D3DVERTEXTEXTURESAMPLER2 (D3DDMAPSAMPLER+3)
#define D3DVERTEXTEXTURESAMPLER3 (D3DDMAPSAMPLER+4)
typedef enum _D3DTEXTUREFILTERTYPE {
    D3DTEXF_NONE = 0, D3DTEXF_POINT = 1, D3DTEXF_LINEAR = 2, D3DTEXF_ANISOTROPIC = 3, D3DTEXF_PYRAMIDALQUAD = 6,
    D3DTEXF_GAUSSIANQUAD = 7, D3DTEXF_FORCE_DWORD = 0x7fffffff
} D3DTEXTUREFILTERTYPE;
typedef enum _D3DTEXTUREADDRESS {
    D3DTADDRESS_WRAP = 1, D3DTADDRESS_MIRROR = 2, D3DTADDRESS_CLAMP = 3, D3DTADDRESS_BORDER = 4,
    D3DTADDRESS_MIRRORONCE = 5, D3DTADDRESS_FORCE_DWORD = 0x7fffffff
} D3DTEXTUREADDRESS;
/* the values the render states take (d3d9types.h) */
typedef enum _D3DFILLMODE { D3DFILL_POINT = 1, D3DFILL_WIREFRAME = 2, D3DFILL_SOLID = 3, D3DFILL_FORCE_DWORD = 0x7fffffff } D3DFILLMODE;
typedef enum _D3DSHADEMODE { D3DSHADE_FLAT = 1, D3DSHADE_GOURAUD = 2, D3DSHADE_PHONG = 3, D3DSHADE_FORCE_DWORD = 0x7fffffff } D3DSHADEMODE;
typedef enum _D3DZBUFFERTYPE { D3DZB_FALSE = 0, D3DZB_TRUE = 1, D3DZB_USEW = 2, D3DZB_FORCE_DWORD = 0x7fffffff } D3DZBUFFERTYPE;
typedef enum _D3DCULL { D3DCULL_NONE = 1, D3DCULL_CW = 2, D3DCULL_CCW = 3, D3DCULL_FORCE_DWORD = 0x7fffffff } D3DCULL;
typedef enum _D3DCMPFUNC {
    D3DCMP_NEVER = 1, D3DCMP_LESS = 2, D3DCMP_EQUAL = 3, D3DCMP_LESSEQUAL = 4, D3DCMP_GREATER = 5, D3DCMP_NOTEQUAL = 6,
    D3DCMP_GREATEREQUAL = 7, D3DCMP_ALWAYS = 8, D3DCMP_FORCE_DWORD = 0x7fffffff
} D3DCMPFUNC;
typedef enum _D3DBLEND {
    D3DBLEND_ZERO = 1, D3DBLEND_ONE = 2, D3DBLEND_SRCCOLOR = 3, D3DBLEND_INVSRCCOLOR = 4, D3DBLEND_SRCALPHA = 5, D3DBLEND_INVSRCALPHA = 6,
    D3DBLEND_DESTALPHA = 7, D3DBLEND_INVDESTALPHA = 8, D3DBLEND_DESTCOLOR = 9, D3DBLEND_INVDESTCOLOR = 10, D3DBLEND_SRCALPHASAT = 11,
    D3DBLEND_BOTHSRCALPHA = 12, D3DBLEND_BOTHINVSRCALPHA = 13, D3DBLEND_BLENDFACTOR = 14, D3DBLEND_INVBLENDFACTOR = 15,
    D3DBLEND_FORCE_DWORD = 0x7fffffff
} D3DBLEND;
typedef enum _D3DBLENDOP {
    D3DBLENDOP_ADD = 1, D3DBLENDOP_SUBTRACT = 2, D3DBLENDOP_REVSUBTRACT = 3, D3DBLENDOP_MIN = 4, D3DBLENDOP_MAX = 5,
    D3DBLENDOP_FORCE_DWORD = 0x7fffffff
} D3DBLENDOP;
typedef enum _D3DSTENCILOP {
    D3DSTENCILOP_KEEP = 1, D3DSTENCILOP_ZERO = 2, D3DSTENCILOP_REPLACE = 3, D3DSTENCILOP_INCRSAT = 4, D3DSTENCILOP_DECRSAT = 5,
    D3DSTENCILOP_INVERT = 6, D3DSTENCILOP_INCR = 7, D3DSTENCILOP_DECR = 8, D3DSTENCILOP_FORCE_DWORD = 0x7fffffff
} D3DSTENCILOP;
typedef enum _D3DFOGMODE { D3DFOG_NONE = 0, D3DFOG_EXP = 1, D3DFOG_EXP2 = 2, D3DFOG_LINEAR = 3, D3DFOG_FORCE_DWORD = 0x7fffffff } D3DFOGMODE;
typedef enum _D3DMATERIALCOLORSOURCE { D3DMCS_MATERIAL = 0, D3DMCS_COLOR1 = 1, D3DMCS_COLOR2 = 2, D3DMCS_FORCE_DWORD = 0x7fffffff } D3DMATERIALCOLORSOURCE;
typedef enum _D3DTEXTURETRANSFORMFLAGS {
    D3DTTFF_DISABLE = 0, D3DTTFF_COUNT1 = 1, D3DTTFF_COUNT2 = 2, D3DTTFF_COUNT3 = 3, D3DTTFF_COUNT4 = 4, D3DTTFF_PROJECTED = 256,
    D3DTTFF_FORCE_DWORD = 0x7fffffff
} D3DTEXTURETRANSFORMFLAGS;
typedef enum _D3DVERTEXBLENDFLAGS {
    D3DVBF_DISABLE = 0, D3DVBF_1WEIGHTS = 1, D3DVBF_2WEIGHTS = 2, D3DVBF_3WEIGHTS = 3, D3DVBF_TWEENING = 255, D3DVBF_0WEIGHTS = 256,
    D3DVBF_FORCE_DWORD = 0x7fffffff
} D3DVERTEXBLENDFLAGS;
#define D3DCOLORWRITEENABLE_RED   (1L<<0)
#define D3DCOLORWRITEENABLE_GREEN (1L<<1)
#define D3DCOLORWRITEENABLE_BLUE  (1L<<2)
#define D3DCOLORWRITEENABLE_ALPHA (1L<<3)

typedef struct _D3DVERTEXELEMENT9 { WORD Stream; WORD Offset; BYTE Type; BYTE Method; BYTE Usage; BYTE UsageIndex; } D3DVERTEXELEMENT9, *LPD3DVERTEXELEMENT9;
typedef enum _D3DDECLTYPE {
    D3DDECLTYPE_FLOAT1 = 0, D3DDECLTYPE_FLOAT2 = 1, D3DDECLTYPE_FLOAT3 = 2, D3DDECLTYPE_FLOAT4 = 3,
    D3DDECLTYPE_D3DCOLOR = 4, D3DDECLTYPE_UBYTE4 = 5, D3DDECLTYPE_SHORT2 = 6, D3DDECLTYPE_SHORT4 = 7,
    D3DDECLTYPE_UBYTE4N = 8, D3DDECLTYPE_SHORT2N = 9, D3DDECLTYPE_SHORT4N = 10, D3DDECLTYPE_USHORT2N = 11,
    D3DDECLTYPE_USHORT4N = 12, D3DDECLTYPE_UDEC3 = 13, D3DDECLTYPE_DEC3N = 14, D3DDECLTYPE_FLOAT16_2 = 15,
    D3DDECLTYPE_FLOAT16_4 = 16, D3DDECLTYPE_UNUSED = 17
} D3DDECLTYPE;
typedef enum _D3DDECLMETHOD {
    D3DDECLMETHOD_DEFAULT = 0, D3DDECLMETHOD_PARTIALU = 1, D3DDECLMETHOD_PARTIALV = 2, D3DDECLMETHOD_CROSSUV = 3,
    D3DDECLMETHOD_UV = 4, D3DDECLMETHOD_LOOKUP = 5, D3DDECLMETHOD_LOOKUPPRESAMPLED = 6
} D3DDECLMETHOD;
typedef enum _D3DDECLUSAGE {
    D3DDECLUSAGE_POSITION = 0, D3DDECLUSAGE_BLENDWEIGHT = 1, D3DDECLUSAGE_BLENDINDICES = 2, D3DDECLUSAGE_NORMAL = 3,
    D3DDECLUSAGE_PSIZE = 4, D3DDECLUSAGE_TEXCOORD = 5, D3DDECLUSAGE_TANGENT = 6, D3DDECLUSAGE_BINORMAL = 7,
    D3DDECLUSAGE_TESSFACTOR = 8, D3DDECLUSAGE_POSITIONT = 9, D3DDECLUSAGE_COLOR = 10, D3DDECLUSAGE_FOG = 11,
    D3DDECLUSAGE_DEPTH = 12, D3DDECLUSAGE_SAMPLE = 13
} D3DDECLUSAGE;
#define D3DDECL_END() {0xFF,0,D3DDECLTYPE_UNUSED,0,0,0}
#define MAXD3DDECLLENGTH 64

#define D3DFVF_XYZ      0x002
#define D3DFVF_XYZRHW   0x004
#define D3DFVF_NORMAL   0x010
#define D3DFVF_PSIZE    0x020
#define D3DFVF_DIFFUSE  0x040
#define D3DFVF_SPECULAR 0x080
#define D3DFVF_TEX0     0x000
#define D3DFVF_TEX1     0x100
#define D3DFVF_TEX2     0x200
#define D3DFVF_TEX3     0x300
#define D3DFVF_TEX4     0x400

#define D3DUSAGE_RENDERTARGET     0x00000001L
#define D3DUSAGE_DEPTHSTENCIL     0x00000002L
#define D3DUSAGE_DYNAMIC          0x00000200L
#define D3DUSAGE_AUTOGENMIPMAP    0x00000400L
#define D3DUSAGE_DMAP             0x00004000L
#define D3DUSAGE_WRITEONLY        0x00000008L
#define D3DUSAGE_SOFTWAREPROCESSING 0x00000010L
#define D3DUSAGE_DONOTCLIP        0x00000020L
#define D3DUSAGE_POINTS           0x00000040L
#define D3DUSAGE_RTPATCHES        0x00000080L
#define D3DUSAGE_NPATCHES         0x00000100L

#define D3DLOCK_READONLY          0x00000010L
#define D3DLOCK_DISCARD           0x00002000L
#define D3DLOCK_NOOVERWRITE       0x00001000L
#define D3DLOCK_NOSYSLOCK         0x00000800L
#define D3DLOCK_DONOTWAIT         0x00004000L
#define D3DLOCK_NO_DIRTY_UPDATE   0x00008000L

#define D3DCREATE_FPU_PRESERVE              0x00000002L
#define D3DCREATE_MULTITHREADED             0x00000004L
#define D3DCREATE_PUREDEVICE                0x00000010L
#define D3DCREATE_SOFTWARE_VERTEXPROCESSING 0x00000020L
#define D3DCREATE_HARDWARE_VERTEXPROCESSING 0x00000040L
#define D3DCREATE_MIXED_VERTEXPROCESSING    0x00000080L
#define D3DCREATE_DISABLE_DRIVER_MANAGEMENT 0x00000100L
#define D3DCREATE_ADAPTERGROUP_DEVICE       0x00000200L

#define D3DPRESENT_INTERVAL_DEFAULT   0x00000000L
#define D3DPRESENT_INTERVAL_ONE       0x00000001L
#define D3DPRESENT_INTERVAL_TWO       0x00000002L
#define D3DPRESENT_INTERVAL_THREE     0x00000004L
#define D3DPRESENT_INTERVAL_FOUR      0x00000008L
#define D3DPRESENT_INTERVAL_IMMEDIATE 0x80000000L
#define D3DPRESENT_RATE_DEFAULT       0x00000000
#define D3DPRESENTFLAG_LOCKABLE_BACKBUFFER  0x00000001
#define D3DPRESENTFLAG_DISCARD_DEPTHSTENCIL 0x00000002
#define D3DPRESENTFLAG_DEVICECLIP           0x00000004
#define D3DPRESENTFLAG_VIDEO                0x00000010
#define D3DPRESENT_BACK_BUFFERS_MAX 3L

typedef struct _D3DPRESENT_PARAMETERS_ {
    UINT BackBufferWidth, BackBufferHeight; D3DFORMAT BackBufferFormat; UINT BackBufferCount;
    D3DMULTISAMPLE_TYPE MultiSampleType; DWORD MultiSampleQuality; D3DSWAPEFFECT SwapEffect;
    HWND hDeviceWindow; BOOL Windowed; BOOL EnableAutoDepthStencil; D3DFORMAT AutoDepthStencilFormat;
    DWORD Flags; UINT FullScreen_RefreshRateInHz; UINT PresentationInterval;
} D3DPRESENT_PARAMETERS;
typedef struct _D3DDISPLAYMODE { UINT Width, Height, RefreshRate; D3DFORMAT Format; } D3DDISPLAYMODE;
typedef struct _D3DDEVICE_CREATION_PARAMETERS { UINT AdapterOrdinal; D3DDEVTYPE DeviceType; HWND hFocusWindow; DWORD BehaviorFlags; } D3DDEVICE_CREATION_PARAMETERS;
typedef struct _D3DRASTER_STATUS { BOOL InVBlank; UINT ScanLine; } D3DRASTER_STATUS;
typedef struct _D3DSURFACE_DESC {
    D3DFORMAT Format; D3DRESOURCETYPE Type; DWORD Usage; D3DPOOL Pool;
    D3DMULTISAMPLE_TYPE MultiSampleType; DWORD MultiSampleQuality; UINT Width, Height;
} D3DSURFACE_DESC;
typedef struct _D3DVOLUME_DESC { D3DFORMAT Format; D3DRESOURCETYPE Type; DWORD Usage; D3DPOOL Pool; UINT Width, Height, Depth; } D3DVOLUME_DESC;
typedef struct _D3DLOCKED_RECT { INT Pitch; void *pBits; } D3DLOCKED_RECT;
typedef struct _D3DBOX { UINT Left, Top, Right, Bottom, Front, Back; } D3DBOX;
typedef struct _D3DLOCKED_BOX { INT RowPitch; INT SlicePitch; void *pBits; } D3DLOCKED_BOX;
typedef struct _D3DVERTEXBUFFER_DESC { D3DFORMAT Format; D3DRESOURCETYPE Type; DWORD Usage; D3DPOOL Pool; UINT Size; DWORD FVF; } D3DVERTEXBUFFER_DESC;
typedef struct _D3DINDEXBUFFER_DESC { D3DFORMAT Format; D3DRESOURCETYPE Type; DWORD Usage; D3DPOOL Pool; UINT Size; } D3DINDEXBUFFER_DESC;
typedef struct _D3DRECTPATCH_INFO { UINT StartVertexOffsetWidth, StartVertexOffsetHeight, Width, Height, Stride; DWORD Basis, Degree; } D3DRECTPATCH_INFO;
typedef struct _D3DTRIPATCH_INFO { UINT StartVertexOffset, NumVertices; DWORD Basis, Degree; } D3DTRIPATCH_INFO;

#define MAX_DEVICE_IDENTIFIER_STRING 512
typedef struct _D3DADAPTER_IDENTIFIER9 {
    char Driver[MAX_DEVICE_IDENTIFIER_STRING]; char Description[MAX_DEVICE_IDENTIFIER_STRING]; char DeviceName[32];
    LARGE_INTEGER DriverVersion; DWORD VendorId, DeviceId, SubSysId, Revision; GUID DeviceIdentifier; DWORD WHQLLevel;
} D3DADAPTER_IDENTIFIER9;

/* d3d9caps.h */
typedef struct _D3DVSHADERCAPS2_0 { DWORD Caps; INT DynamicFlowControlDepth, NumTemps, StaticFlowControlDepth; } D3DVSHADERCAPS2_0;
typedef struct _D3DPSHADERCAPS2_0 { DWORD Caps; INT DynamicFlowControlDepth, NumTemps, StaticFlowControlDepth, NumInstructionSlots; } D3DPSHADERCAPS2_0;
typedef struct _D3DCAPS9 {
    D3DDEVTYPE DeviceType; UINT AdapterOrdinal; DWORD Caps, Caps2, Caps3, PresentationIntervals, CursorCaps, DevCaps;
    DWORD PrimitiveMiscCaps, RasterCaps, ZCmpCaps, SrcBlendCaps, DestBlendCaps, AlphaCmpCaps, ShadeCaps, TextureCaps;
    DWORD TextureFilterCaps, CubeTextureFilterCaps, VolumeTextureFilterCaps, TextureAddressCaps, VolumeTextureAddressCaps;
    DWORD LineCaps, MaxTextureWidth, MaxTextureHeight, MaxVolumeExtent, MaxTextureRepeat, MaxTextureAspectRatio, MaxAnisotropy;
    float MaxVertexW, GuardBandLeft, GuardBandTop, GuardBandRight, GuardBandBottom, ExtentsAdjust;
    DWORD StencilCaps, FVFCaps, TextureOpCaps, MaxTextureBlendStages, MaxSimultaneousTextures, VertexProcessingCaps;
    DWORD MaxActiveLights, MaxUserClipPlanes, MaxVertexBlendMatrices, MaxVertexBlendMatrixIndex;
    float MaxPointSize;
    DWORD MaxPrimitiveCount, MaxVertexIndex, MaxStreams, MaxStreamStride, VertexShaderVersion, MaxVertexShaderConst;
    DWORD PixelShaderVersion;
    float PixelShader1xMaxValue;
    DWORD DevCaps2;
    float MaxNpatchTessellationLevel;
    DWORD Reserved5;
    UINT MasterAdapterOrdinal, AdapterOrdinalInGroup, NumberOfAdaptersInGroup;
    DWORD DeclTypes, NumSimultaneousRTs, StretchRectFilterCaps;
    D3DVSHADERCAPS2_0 VS20Caps;
    D3DPSHADERCAPS2_0 PS20Caps;
    DWORD VertexTextureFilterCaps, MaxVShaderInstructionsExecuted, MaxPShaderInstructionsExecuted;
    DWORD MaxVertexShader30InstructionSlots, MaxPixelShader30InstructionSlots;
} D3DCAPS9;
#define D3DSTENCILCAPS_KEEP     0x00000001L
#define D3DSTENCILCAPS_ZERO     0x00000002L
#define D3DSTENCILCAPS_REPLACE  0x00000004L
#define D3DSTENCILCAPS_INCRSAT  0x00000008L
#define D3DSTENCILCAPS_DECRSAT  0x00000010L
#define D3DSTENCILCAPS_INVERT   0x00000020L
#define D3DSTENCILCAPS_INCR     0x00000040L
#define D3DSTENCILCAPS_DECR     0x00000080L
#define D3DSTENCILCAPS_TWOSIDED 0x00000100L
#define D3DPS_VERSION(major, minor) (0xFFFF0000|((major)<<8)|(minor))
#define D3DVS_VERSION(major, minor) (0xFFFE0000|((major)<<8)|(minor))
#define D3DSHADER_VERSION_MAJOR(version) (((version)>>8)&0xFF)
#define D3DSHADER_VERSION_MINOR(version) (((version)>>0)&0xFF)
`;

export const D3D9_H = `#ifndef _PRISM_D3D9_H
#define _PRISM_D3D9_H
#include <windows.h>
${TYPES}
${comDeclarations(IFACES)}
#ifdef __cplusplus
extern "C" {
#endif
IDirect3D9 *WINAPI Direct3DCreate9(UINT SDKVersion);
#ifdef __cplusplus
}
#endif
#endif
`;

/*
 * <dinput.h>: the version macro and nothing more, said plainly. .kkrieger's player builds with
 * sUSE_DIRECTINPUT 0 -- its keys and mouse come from window messages -- so every DirectInput line in
 * _start.cpp sits under #if sUSE_DIRECTINPUT and needs no declaration; a program that does use
 * DirectInput fails at its first IDirectInput8, by name.
 */
export const DINPUT_H = `#ifndef _PRISM_DINPUT_H
#define _PRISM_DINPUT_H
#include <windows.h>
#ifndef DIRECTINPUT_VERSION
#define DIRECTINPUT_VERSION 0x0800
#endif
#endif
`;

/*
 * <olectl.h>, with the IStream of objidl.h and the IPicture of ocidl.h that OleLoadPicture deals in:
 * what _start.cpp's LoadBitmapCore asks for to decode a GIF or a JPEG. Declared in the SDK's orders;
 * src/env/d3d9.c answers CreateStreamOnHGlobal with E_NOTIMPL, so the program's own "no picture"
 * path runs (it decodes no image format of its own).
 */
const OLE = {
  ISequentialStream: ['IUnknown', P(`
    HRESULT Read(void *pv, ULONG cb, ULONG *pcbRead)
    HRESULT Write(const void *pv, ULONG cb, ULONG *pcbWritten)`)],
  IStream: ['ISequentialStream', P(`
    HRESULT Seek(LARGE_INTEGER dlibMove, DWORD dwOrigin, ULARGE_INTEGER *plibNewPosition)
    HRESULT SetSize(ULARGE_INTEGER libNewSize)
    HRESULT CopyTo(IStream *pstm, ULARGE_INTEGER cb, ULARGE_INTEGER *pcbRead, ULARGE_INTEGER *pcbWritten)
    HRESULT Commit(DWORD grfCommitFlags)
    HRESULT Revert()
    HRESULT LockRegion(ULARGE_INTEGER libOffset, ULARGE_INTEGER cb, DWORD dwLockType)
    HRESULT UnlockRegion(ULARGE_INTEGER libOffset, ULARGE_INTEGER cb, DWORD dwLockType)
    HRESULT Stat(STATSTG *pstatstg, DWORD grfStatFlag)
    HRESULT Clone(IStream **ppstm)`)],
  IPicture: ['IUnknown', P(`
    HRESULT get_Handle(OLE_HANDLE *pHandle)
    HRESULT get_hPal(OLE_HANDLE *phPal)
    HRESULT get_Type(SHORT *pType)
    HRESULT get_Width(OLE_XSIZE_HIMETRIC *pWidth)
    HRESULT get_Height(OLE_YSIZE_HIMETRIC *pHeight)
    HRESULT Render(HDC hDC, LONG x, LONG y, LONG cx, LONG cy, OLE_XPOS_HIMETRIC xSrc, OLE_YPOS_HIMETRIC ySrc, OLE_XSIZE_HIMETRIC cxSrc, OLE_YSIZE_HIMETRIC cySrc, const RECT *pRcWBounds)
    HRESULT set_hPal(OLE_HANDLE hPal)
    HRESULT get_CurDC(HDC *phDC)
    HRESULT SelectPicture(HDC hDCIn, HDC *phDCOut, OLE_HANDLE *phBmpOut)
    HRESULT get_KeepOriginalFormat(BOOL *pKeep)
    HRESULT put_KeepOriginalFormat(BOOL keep)
    HRESULT PictureChanged()
    HRESULT SaveAsFile(IStream *pStream, BOOL fSaveMemCopy, LONG *pCbSize)
    HRESULT get_Attributes(DWORD *pDwAttr)`)],
};
export const OLECTL_H = `#ifndef _PRISM_OLECTL_H
#define _PRISM_OLECTL_H
#include <windows.h>
typedef UINT OLE_HANDLE;
typedef LONG OLE_XPOS_HIMETRIC, OLE_YPOS_HIMETRIC, OLE_XSIZE_HIMETRIC, OLE_YSIZE_HIMETRIC;
typedef struct tagSTATSTG {
    void *pwcsName; DWORD type; ULARGE_INTEGER cbSize; FILETIME mtime, ctime, atime;
    DWORD grfMode, grfLocksSupported; GUID clsid; DWORD grfStateBits, reserved;
} STATSTG;
#define STREAM_SEEK_SET 0
#define STREAM_SEEK_CUR 1
#define STREAM_SEEK_END 2
#define E_NOTIMPL ((HRESULT)0x80004001L)
${comDeclarations(OLE)}
extern const GUID IID_IPicture, IID_IStream;
#ifdef __cplusplus
extern "C" {
#endif
HRESULT WINAPI CreateStreamOnHGlobal(HGLOBAL hGlobal, BOOL fDeleteOnRelease, LPSTREAM *ppstm);
HRESULT WINAPI OleLoadPicture(LPSTREAM lpstream, LONG lSize, BOOL fRunmode, REFIID riid, LPVOID *lplpvObj);
#ifdef __cplusplus
}
#endif
#endif
`;

/* <crtdbg.h>: the debug heap's switches, which a release build of the CRT accepts and ignores. */
export const CRTDBG_H = `#ifndef _PRISM_CRTDBG_H
#define _PRISM_CRTDBG_H
#define _CRTDBG_ALLOC_MEM_DF        0x01
#define _CRTDBG_DELAY_FREE_MEM_DF   0x02
#define _CRTDBG_CHECK_ALWAYS_DF     0x04
#define _CRTDBG_CHECK_CRT_DF        0x10
#define _CRTDBG_LEAK_CHECK_DF       0x20
#define _CRTDBG_REPORT_FLAG         (-1)
#define _CrtSetDbgFlag(f)           0
#define _CrtCheckMemory()           1
#define _CrtDumpMemoryLeaks()       0
#define _ASSERT(e)                  ((void)0)
#define _ASSERTE(e)                 ((void)0)
#endif
`;
