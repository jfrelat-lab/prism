// headers-dsound.js — <dsound.h>, DirectSound 3 to 8, its interfaces in the SDK's order.
//
// Two programs read it, written ten years apart. Quake II's snd_win.c (C, DirectSound 3) reaches it
// through LoadLibrary("dsound.dll"), which src/env/win32.c answers NULL for, so it stands down to
// waveOut and then to silence; .kkrieger's _start.cpp (C++, DirectSound 8) calls through it. The
// interfaces are therefore the real ones, in both COM shapes (src/env/com.js), and DSBUFFERDESC has
// guid3DAlgorithm only from DIRECTSOUND_VERSION 0x0700, as the SDK lays it out -- 0x0900 when the
// program does not say, as the SDK's own header defaults.
import { methods as M, comDeclarations } from './com.js';

const IFACES = {
  IDirectSound: ['IUnknown', M(`
    HRESULT CreateSoundBuffer(LPCDSBUFFERDESC pcDSBufferDesc, LPDIRECTSOUNDBUFFER *ppDSBuffer, LPUNKNOWN pUnkOuter)
    HRESULT GetCaps(LPDSCAPS pDSCaps)
    HRESULT DuplicateSoundBuffer(LPDIRECTSOUNDBUFFER pDSBufferOriginal, LPDIRECTSOUNDBUFFER *ppDSBufferDuplicate)
    HRESULT SetCooperativeLevel(HWND hwnd, DWORD dwLevel)
    HRESULT Compact()
    HRESULT GetSpeakerConfig(LPDWORD pdwSpeakerConfig)
    HRESULT SetSpeakerConfig(DWORD dwSpeakerConfig)
    HRESULT Initialize(LPCGUID pcGuidDevice)`)],
  IDirectSound8: ['IDirectSound', M(`
    HRESULT VerifyCertification(LPDWORD pdwCertified)`)],
  IDirectSoundBuffer: ['IUnknown', M(`
    HRESULT GetCaps(LPDSBCAPS pDSBufferCaps)
    HRESULT GetCurrentPosition(LPDWORD pdwCurrentPlayCursor, LPDWORD pdwCurrentWriteCursor)
    HRESULT GetFormat(LPWAVEFORMATEX pwfxFormat, DWORD dwSizeAllocated, LPDWORD pdwSizeWritten)
    HRESULT GetVolume(LPLONG plVolume)
    HRESULT GetPan(LPLONG plPan)
    HRESULT GetFrequency(LPDWORD pdwFrequency)
    HRESULT GetStatus(LPDWORD pdwStatus)
    HRESULT Initialize(LPDIRECTSOUND pDirectSound, LPCDSBUFFERDESC pcDSBufferDesc)
    HRESULT Lock(DWORD dwOffset, DWORD dwBytes, LPVOID *ppvAudioPtr1, LPDWORD pdwAudioBytes1, LPVOID *ppvAudioPtr2, LPDWORD pdwAudioBytes2, DWORD dwFlags)
    HRESULT Play(DWORD dwReserved1, DWORD dwPriority, DWORD dwFlags)
    HRESULT SetCurrentPosition(DWORD dwNewPosition)
    HRESULT SetFormat(LPCWAVEFORMATEX pcfxFormat)
    HRESULT SetVolume(LONG lVolume)
    HRESULT SetPan(LONG lPan)
    HRESULT SetFrequency(DWORD dwFrequency)
    HRESULT Stop()
    HRESULT Unlock(LPVOID pvAudioPtr1, DWORD dwAudioBytes1, LPVOID pvAudioPtr2, DWORD dwAudioBytes2)
    HRESULT Restore()`)],
  IDirectSoundBuffer8: ['IDirectSoundBuffer', M(`
    HRESULT SetFX(DWORD dwEffectsCount, LPVOID pDSFXDesc, LPDWORD pdwResultCodes)
    HRESULT AcquireResources(DWORD dwFlags, DWORD dwEffectsCount, LPDWORD pdwResultCodes)
    HRESULT GetObjectInPath(REFGUID rguidObject, DWORD dwIndex, REFGUID rguidInterface, LPVOID *ppObject)`)],
  IDirectSound3DListener: ['IUnknown', M(`
    HRESULT GetAllParameters(LPDS3DLISTENER pListener)
    HRESULT GetDistanceFactor(D3DVALUE *pflDistanceFactor)
    HRESULT GetDopplerFactor(D3DVALUE *pflDopplerFactor)
    HRESULT GetOrientation(D3DVECTOR *pvOrientFront, D3DVECTOR *pvOrientTop)
    HRESULT GetPosition(D3DVECTOR *pvPosition)
    HRESULT GetRolloffFactor(D3DVALUE *pflRolloffFactor)
    HRESULT GetVelocity(D3DVECTOR *pvVelocity)
    HRESULT SetAllParameters(LPCDS3DLISTENER pcListener, DWORD dwApply)
    HRESULT SetDistanceFactor(D3DVALUE flDistanceFactor, DWORD dwApply)
    HRESULT SetDopplerFactor(D3DVALUE flDopplerFactor, DWORD dwApply)
    HRESULT SetOrientation(D3DVALUE xFront, D3DVALUE yFront, D3DVALUE zFront, D3DVALUE xTop, D3DVALUE yTop, D3DVALUE zTop, DWORD dwApply)
    HRESULT SetPosition(D3DVALUE x, D3DVALUE y, D3DVALUE z, DWORD dwApply)
    HRESULT SetRolloffFactor(D3DVALUE flRolloffFactor, DWORD dwApply)
    HRESULT SetVelocity(D3DVALUE x, D3DVALUE y, D3DVALUE z, DWORD dwApply)
    HRESULT CommitDeferredSettings()`)],
  IDirectSound3DBuffer: ['IUnknown', M(`
    HRESULT GetAllParameters(LPDS3DBUFFER pDs3dBuffer)
    HRESULT GetConeAngles(LPDWORD pdwInsideConeAngle, LPDWORD pdwOutsideConeAngle)
    HRESULT GetConeOrientation(D3DVECTOR *pvOrientation)
    HRESULT GetConeOutsideVolume(LPLONG plConeOutsideVolume)
    HRESULT GetMaxDistance(D3DVALUE *pflMaxDistance)
    HRESULT GetMinDistance(D3DVALUE *pflMinDistance)
    HRESULT GetMode(LPDWORD pdwMode)
    HRESULT GetPosition(D3DVECTOR *pvPosition)
    HRESULT GetVelocity(D3DVECTOR *pvVelocity)
    HRESULT SetAllParameters(LPCDS3DBUFFER pcDs3dBuffer, DWORD dwApply)
    HRESULT SetConeAngles(DWORD dwInsideConeAngle, DWORD dwOutsideConeAngle, DWORD dwApply)
    HRESULT SetConeOrientation(D3DVALUE x, D3DVALUE y, D3DVALUE z, DWORD dwApply)
    HRESULT SetConeOutsideVolume(LONG lConeOutsideVolume, DWORD dwApply)
    HRESULT SetMaxDistance(D3DVALUE flMaxDistance, DWORD dwApply)
    HRESULT SetMinDistance(D3DVALUE flMinDistance, DWORD dwApply)
    HRESULT SetMode(DWORD dwMode, DWORD dwApply)
    HRESULT SetPosition(D3DVALUE x, D3DVALUE y, D3DVALUE z, DWORD dwApply)
    HRESULT SetVelocity(D3DVALUE x, D3DVALUE y, D3DVALUE z, DWORD dwApply)`)],
};
export const DSOUND_INTERFACES = IFACES;

export const DSOUND_H = `#ifndef _PRISM_DSOUND_H
#define _PRISM_DSOUND_H
#include <windows.h>
#ifndef DIRECTSOUND_VERSION
#define DIRECTSOUND_VERSION 0x0900
#endif
#ifndef _PRISM_D3DVALUE_DEFINED
#define _PRISM_D3DVALUE_DEFINED
typedef float D3DVALUE;
#endif
#ifndef _PRISM_D3DVECTOR_DEFINED
#define _PRISM_D3DVECTOR_DEFINED
typedef struct _D3DVECTOR { float x, y, z; } D3DVECTOR;
#endif
typedef const GUID *LPCGUID;
typedef const WAVEFORMATEX *LPCWAVEFORMATEX;

typedef struct _DSCAPS {
    DWORD dwSize, dwFlags, dwMinSecondarySampleRate, dwMaxSecondarySampleRate, dwPrimaryBuffers;
    DWORD dwMaxHwMixingAllBuffers, dwMaxHwMixingStaticBuffers, dwMaxHwMixingStreamingBuffers;
    DWORD dwFreeHwMixingAllBuffers, dwFreeHwMixingStaticBuffers, dwFreeHwMixingStreamingBuffers;
    DWORD dwMaxHw3DAllBuffers, dwMaxHw3DStaticBuffers, dwMaxHw3DStreamingBuffers;
    DWORD dwFreeHw3DAllBuffers, dwFreeHw3DStaticBuffers, dwFreeHw3DStreamingBuffers;
    DWORD dwTotalHwMemBytes, dwFreeHwMemBytes, dwMaxContigFreeHwMemBytes, dwUnlockTransferRateHwBuffers;
    DWORD dwPlayCpuOverheadSwBuffers, dwReserved1, dwReserved2;
} DSCAPS, *LPDSCAPS;
typedef struct _DSBCAPS { DWORD dwSize, dwFlags, dwBufferBytes, dwUnlockTransferRate, dwPlayCpuOverhead; } DSBCAPS, *LPDSBCAPS;
typedef struct _DSBUFFERDESC {
    DWORD dwSize;
    DWORD dwFlags;
    DWORD dwBufferBytes;
    DWORD dwReserved;
    LPWAVEFORMATEX lpwfxFormat;
#if DIRECTSOUND_VERSION >= 0x0700
    GUID guid3DAlgorithm;
#endif
} DSBUFFERDESC, *LPDSBUFFERDESC;
typedef const DSBUFFERDESC *LPCDSBUFFERDESC;
typedef struct _DS3DBUFFER {
    DWORD dwSize; D3DVECTOR vPosition, vVelocity; DWORD dwInsideConeAngle, dwOutsideConeAngle;
    D3DVECTOR vConeOrientation; LONG lConeOutsideVolume; D3DVALUE flMinDistance, flMaxDistance; DWORD dwMode;
} DS3DBUFFER, *LPDS3DBUFFER;
typedef const DS3DBUFFER *LPCDS3DBUFFER;
typedef struct _DS3DLISTENER {
    DWORD dwSize; D3DVECTOR vPosition, vVelocity, vOrientFront, vOrientTop;
    D3DVALUE flDistanceFactor, flRolloffFactor, flDopplerFactor;
} DS3DLISTENER, *LPDS3DLISTENER;
typedef const DS3DLISTENER *LPCDS3DLISTENER;

${comDeclarations(IFACES)}

#define DS_OK                    0
#define DSERR_ALLOCATED          MAKE_HRESULT(1, 0x878, 10)
#define DSERR_CONTROLUNAVAIL     MAKE_HRESULT(1, 0x878, 30)
#define DSERR_INVALIDPARAM       E_INVALIDARG
#define DSERR_INVALIDCALL        MAKE_HRESULT(1, 0x878, 50)
#define DSERR_GENERIC            E_FAIL
#define DSERR_PRIOLEVELNEEDED    MAKE_HRESULT(1, 0x878, 70)
#define DSERR_OUTOFMEMORY        E_OUTOFMEMORY
#define DSERR_BADFORMAT          MAKE_HRESULT(1, 0x878, 100)
#define DSERR_UNSUPPORTED        ((HRESULT)0x80004001L)
#define DSERR_NODRIVER           MAKE_HRESULT(1, 0x878, 120)
#define DSERR_ALREADYINITIALIZED MAKE_HRESULT(1, 0x878, 130)
#define DSERR_NOAGGREGATION      ((HRESULT)0x80040110L)
#define DSERR_BUFFERLOST         MAKE_HRESULT(1, 0x878, 150)
#define DSERR_OTHERAPPHASPRIO    MAKE_HRESULT(1, 0x878, 160)
#define DSERR_UNINITIALIZED      MAKE_HRESULT(1, 0x878, 170)
#define DSERR_NOINTERFACE        E_NOINTERFACE

#define DSSCL_NORMAL       1
#define DSSCL_PRIORITY     2
#define DSSCL_EXCLUSIVE    3
#define DSSCL_WRITEPRIMARY 4

#define DSBCAPS_PRIMARYBUFFER       0x00000001
#define DSBCAPS_STATIC              0x00000002
#define DSBCAPS_LOCHARDWARE         0x00000004
#define DSBCAPS_LOCSOFTWARE         0x00000008
#define DSBCAPS_CTRL3D              0x00000010
#define DSBCAPS_CTRLFREQUENCY       0x00000020
#define DSBCAPS_CTRLPAN             0x00000040
#define DSBCAPS_CTRLVOLUME          0x00000080
#define DSBCAPS_CTRLPOSITIONNOTIFY  0x00000100
#define DSBCAPS_CTRLFX              0x00000200
#define DSBCAPS_STICKYFOCUS         0x00004000
#define DSBCAPS_GLOBALFOCUS         0x00008000
#define DSBCAPS_GETCURRENTPOSITION2 0x00010000
#define DSBCAPS_MUTE3DATMAXDISTANCE 0x00020000
#define DSBCAPS_LOCDEFER            0x00040000

#define DSBPLAY_LOOPING      0x00000001
#define DSBSTATUS_PLAYING    0x00000001
#define DSBSTATUS_BUFFERLOST 0x00000002
#define DSBSTATUS_LOOPING    0x00000004
#define DSBLOCK_FROMWRITECURSOR 0x00000001
#define DSBLOCK_ENTIREBUFFER    0x00000002
#define DSSPEAKER_STEREO     0x00000004
#define DS_CERTIFIED         0x00000000
#define DS_UNCERTIFIED       0x00000001
#define DSCAPS_PRIMARYMONO     0x00000001
#define DSCAPS_PRIMARYSTEREO   0x00000002
#define DSCAPS_PRIMARY8BIT     0x00000004
#define DSCAPS_PRIMARY16BIT    0x00000008
#define DSCAPS_CONTINUOUSRATE  0x00000010
#define DSCAPS_EMULDRIVER      0x00000020
#define DSCAPS_CERTIFIED       0x00000040
#define DSCAPS_SECONDARYMONO   0x00000100
#define DSCAPS_SECONDARYSTEREO 0x00000200
#define DSCAPS_SECONDARY8BIT   0x00000400
#define DSCAPS_SECONDARY16BIT  0x00000800
#define DSBVOLUME_MIN -10000
#define DSBVOLUME_MAX 0
#define DSBPAN_LEFT   -10000
#define DSBPAN_RIGHT  10000
#define DS3D_IMMEDIATE 0x00000000
#define DS3D_DEFERRED  0x00000001
#define DS3DMODE_NORMAL     0x00000000
#define DS3DMODE_HEADRELATIVE 0x00000001
#define DS3DMODE_DISABLE    0x00000002
#define DS3D_DEFAULTCONEOUTSIDEVOLUME DSBVOLUME_MAX
#define DS3D_DEFAULTMINDISTANCE 1.0f
#define DS3D_DEFAULTMAXDISTANCE 1000000000.0f

extern const GUID IID_IDirectSound, IID_IDirectSound8, IID_IDirectSoundBuffer, IID_IDirectSoundBuffer8,
    IID_IDirectSound3DListener, IID_IDirectSound3DBuffer;

#ifdef __cplusplus
extern "C" {
#endif
HRESULT WINAPI DirectSoundCreate(LPCGUID pcGuidDevice, LPDIRECTSOUND *ppDS, LPUNKNOWN pUnkOuter);
HRESULT WINAPI DirectSoundCreate8(LPCGUID pcGuidDevice, LPDIRECTSOUND8 *ppDS8, LPUNKNOWN pUnkOuter);
#ifdef __cplusplus
}
#endif
#endif
`;
