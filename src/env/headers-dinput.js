// headers-dinput.js — <dinput.h>, DirectInput 8: its two interfaces in the SDK's order, the structures a
// keyboard and a mouse are read through, the DIK_ key codes, the predefined data formats.
//
// .kkrieger builds with sUSE_DIRECTINPUT 0 and never reached past the version macro; Doom 3's win_input.cpp
// reads its keyboard and its mouse through DirectInput 8 in buffered mode (GetDeviceData), with
// c_dfDIKeyboard and c_dfDIMouse2. src/env/dinput.c is the device behind it. The interfaces come in both COM
// shapes (src/env/com.js); the ANSI ones, which DirectInput8Create hands out for IID_IDirectInput8A, are the
// unsuffixed names, as the SDK maps them for a program without UNICODE.
import { methods as M, comDeclarations } from './com.js';

const IFACES = {
  IDirectInputDevice8A: ['IUnknown', M(`
    HRESULT GetCapabilities(LPDIDEVCAPS lpDIDevCaps)
    HRESULT EnumObjects(LPVOID lpCallback, LPVOID pvRef, DWORD dwFlags)
    HRESULT GetProperty(REFGUID rguidProp, LPDIPROPHEADER pdiph)
    HRESULT SetProperty(REFGUID rguidProp, LPCDIPROPHEADER pdiph)
    HRESULT Acquire()
    HRESULT Unacquire()
    HRESULT GetDeviceState(DWORD cbData, LPVOID lpvData)
    HRESULT GetDeviceData(DWORD cbObjectData, LPDIDEVICEOBJECTDATA rgdod, LPDWORD pdwInOut, DWORD dwFlags)
    HRESULT SetDataFormat(LPCDIDATAFORMAT lpdf)
    HRESULT SetEventNotification(HANDLE hEvent)
    HRESULT SetCooperativeLevel(HWND hwnd, DWORD dwFlags)
    HRESULT GetObjectInfo(LPVOID pdidoi, DWORD dwObj, DWORD dwHow)
    HRESULT GetDeviceInfo(LPVOID pdidi)
    HRESULT RunControlPanel(HWND hwndOwner, DWORD dwFlags)
    HRESULT Initialize(HINSTANCE hinst, DWORD dwVersion, REFGUID rguid)
    HRESULT CreateEffect(REFGUID rguid, LPVOID lpeff, LPVOID *ppdeff, LPUNKNOWN punkOuter)
    HRESULT EnumEffects(LPVOID lpCallback, LPVOID pvRef, DWORD dwEffType)
    HRESULT GetEffectInfo(LPVOID pdei, REFGUID rguid)
    HRESULT GetForceFeedbackState(LPDWORD pdwOut)
    HRESULT SendForceFeedbackCommand(DWORD dwFlags)
    HRESULT EnumCreatedEffectObjects(LPVOID lpCallback, LPVOID pvRef, DWORD fl)
    HRESULT Escape(LPVOID pesc)
    HRESULT Poll()
    HRESULT SendDeviceData(DWORD cbObjectData, LPCDIDEVICEOBJECTDATA rgdod, LPDWORD pdwInOut, DWORD fl)
    HRESULT EnumEffectsInFile(LPCSTR lpszFileName, LPVOID pec, LPVOID pvRef, DWORD dwFlags)
    HRESULT WriteEffectToFile(LPCSTR lpszFileName, DWORD dwEntries, LPVOID rgDiFileEft, DWORD dwFlags)
    HRESULT BuildActionMap(LPVOID lpdiaf, LPCSTR lpszUserName, DWORD dwFlags)
    HRESULT SetActionMap(LPVOID lpdiActionFormat, LPCSTR lptszUserName, DWORD dwFlags)
    HRESULT GetImageInfo(LPVOID lpdiDevImageInfoHeader)`)],
  IDirectInput8A: ['IUnknown', M(`
    HRESULT CreateDevice(REFGUID rguid, LPDIRECTINPUTDEVICE8A *lplpDirectInputDevice, LPUNKNOWN pUnkOuter)
    HRESULT EnumDevices(DWORD dwDevType, LPVOID lpCallback, LPVOID pvRef, DWORD dwFlags)
    HRESULT GetDeviceStatus(REFGUID rguidInstance)
    HRESULT RunControlPanel(HWND hwndOwner, DWORD dwFlags)
    HRESULT Initialize(HINSTANCE hinst, DWORD dwVersion)
    HRESULT FindDevice(REFGUID rguidClass, LPCSTR ptszName, LPGUID pguidInstance)
    HRESULT EnumDevicesBySemantics(LPCSTR ptszUserName, LPVOID lpdiActionFormat, LPVOID lpCallback, LPVOID pvRef, DWORD dwFlags)
    HRESULT ConfigureDevices(LPVOID lpdiCallback, LPVOID lpdiCDParams, DWORD dwFlags, LPVOID pvRefData)`)],
};
export const DINPUT_INTERFACES = IFACES;

// The DIK_ codes are the PC keyboard's set-1 scan codes, an 0xE0-prefixed key's with bit 7 set.
const DIK = {
  ESCAPE: 0x01, 1: 0x02, 2: 0x03, 3: 0x04, 4: 0x05, 5: 0x06, 6: 0x07, 7: 0x08, 8: 0x09, 9: 0x0A, 0: 0x0B, MINUS: 0x0C, EQUALS: 0x0D,
  BACK: 0x0E, TAB: 0x0F, Q: 0x10, W: 0x11, E: 0x12, R: 0x13, T: 0x14, Y: 0x15, U: 0x16, I: 0x17, O: 0x18, P: 0x19, LBRACKET: 0x1A,
  RBRACKET: 0x1B, RETURN: 0x1C, LCONTROL: 0x1D, A: 0x1E, S: 0x1F, D: 0x20, F: 0x21, G: 0x22, H: 0x23, J: 0x24, K: 0x25, L: 0x26,
  SEMICOLON: 0x27, APOSTROPHE: 0x28, GRAVE: 0x29, LSHIFT: 0x2A, BACKSLASH: 0x2B, Z: 0x2C, X: 0x2D, C: 0x2E, V: 0x2F, B: 0x30, N: 0x31,
  M: 0x32, COMMA: 0x33, PERIOD: 0x34, SLASH: 0x35, RSHIFT: 0x36, MULTIPLY: 0x37, LMENU: 0x38, SPACE: 0x39, CAPITAL: 0x3A, F1: 0x3B,
  F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, NUMLOCK: 0x45, SCROLL: 0x46, NUMPAD7: 0x47,
  NUMPAD8: 0x48, NUMPAD9: 0x49, SUBTRACT: 0x4A, NUMPAD4: 0x4B, NUMPAD5: 0x4C, NUMPAD6: 0x4D, ADD: 0x4E, NUMPAD1: 0x4F, NUMPAD2: 0x50,
  NUMPAD3: 0x51, NUMPAD0: 0x52, DECIMAL: 0x53, OEM_102: 0x56, F11: 0x57, F12: 0x58, F13: 0x64, F14: 0x65, F15: 0x66, KANA: 0x70,
  ABNT_C1: 0x73, CONVERT: 0x79, NOCONVERT: 0x7B, YEN: 0x7D, ABNT_C2: 0x7E, NUMPADEQUALS: 0x8D, PREVTRACK: 0x90, AT: 0x91, COLON: 0x92,
  UNDERLINE: 0x93, KANJI: 0x94, STOP: 0x95, AX: 0x96, UNLABELED: 0x97, NEXTTRACK: 0x99, NUMPADENTER: 0x9C, RCONTROL: 0x9D, MUTE: 0xA0,
  CALCULATOR: 0xA1, PLAYPAUSE: 0xA2, MEDIASTOP: 0xA4, VOLUMEDOWN: 0xAE, VOLUMEUP: 0xB0, WEBHOME: 0xB2, NUMPADCOMMA: 0xB3, DIVIDE: 0xB5,
  SYSRQ: 0xB7, RMENU: 0xB8, PAUSE: 0xC5, HOME: 0xC7, UP: 0xC8, PRIOR: 0xC9, LEFT: 0xCB, RIGHT: 0xCD, END: 0xCF, DOWN: 0xD0, NEXT: 0xD1,
  INSERT: 0xD2, DELETE: 0xD3, LWIN: 0xDB, RWIN: 0xDC, APPS: 0xDD, POWER: 0xDE, SLEEP: 0xDF, WAKE: 0xE3, WEBSEARCH: 0xE5,
  WEBFAVORITES: 0xE6, WEBREFRESH: 0xE7, WEBSTOP: 0xE8, WEBFORWARD: 0xE9, WEBBACK: 0xEA, MYCOMPUTER: 0xEB, MAIL: 0xEC, MEDIASELECT: 0xED,
};
// ...and the SDK's other spellings of some of them
const DIK_ALIAS = { BACKSPACE: 'BACK', NUMPADSTAR: 'MULTIPLY', LALT: 'LMENU', CAPSLOCK: 'CAPITAL', NUMPADMINUS: 'SUBTRACT',
  NUMPADPLUS: 'ADD', NUMPADPERIOD: 'DECIMAL', NUMPADSLASH: 'DIVIDE', RALT: 'RMENU', UPARROW: 'UP', PGUP: 'PRIOR', LEFTARROW: 'LEFT',
  RIGHTARROW: 'RIGHT', DOWNARROW: 'DOWN', PGDN: 'NEXT', CIRCUMFLEX: 'PREVTRACK' };
const hex = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
const DIK_DEFINES = [...Object.entries(DIK).map(([k, v]) => `#define DIK_${k} ${hex(v)}`),
  ...Object.entries(DIK_ALIAS).map(([k, v]) => `#define DIK_${k} DIK_${v}`)].join('\n');

export const DINPUT_H = `#ifndef _PRISM_DINPUT_H
#define _PRISM_DINPUT_H
#include <windows.h>
#ifndef DIRECTINPUT_VERSION
#define DIRECTINPUT_VERSION 0x0800
#endif
typedef GUID *LPGUID;
typedef struct DIDEVICEOBJECTDATA { DWORD dwOfs, dwData, dwTimeStamp, dwSequence; UINT_PTR uAppData; } DIDEVICEOBJECTDATA, *LPDIDEVICEOBJECTDATA;
typedef const DIDEVICEOBJECTDATA *LPCDIDEVICEOBJECTDATA;
typedef struct DIPROPHEADER { DWORD dwSize, dwHeaderSize, dwObj, dwHow; } DIPROPHEADER, *LPDIPROPHEADER;
typedef const DIPROPHEADER *LPCDIPROPHEADER;
typedef struct DIPROPDWORD { DIPROPHEADER diph; DWORD dwData; } DIPROPDWORD, *LPDIPROPDWORD;
typedef const DIPROPDWORD *LPCDIPROPDWORD;
typedef struct _DIOBJECTDATAFORMAT { const GUID *pguid; DWORD dwOfs, dwType, dwFlags; } DIOBJECTDATAFORMAT, *LPDIOBJECTDATAFORMAT;
typedef const DIOBJECTDATAFORMAT *LPCDIOBJECTDATAFORMAT;
typedef struct _DIDATAFORMAT { DWORD dwSize, dwObjSize, dwFlags, dwDataSize, dwNumObjs; LPDIOBJECTDATAFORMAT rgodf; } DIDATAFORMAT, *LPDIDATAFORMAT;
typedef const DIDATAFORMAT *LPCDIDATAFORMAT;
typedef struct DIDEVCAPS { DWORD dwSize, dwFlags, dwDevType, dwAxes, dwButtons, dwPOVs, dwFFSamplePeriod, dwFFMinTimeResolution,
    dwFirmwareRevision, dwHardwareRevision, dwFFDriverVersion; } DIDEVCAPS, *LPDIDEVCAPS;
typedef struct _DIMOUSESTATE { LONG lX, lY, lZ; BYTE rgbButtons[4]; } DIMOUSESTATE, *LPDIMOUSESTATE;
typedef struct _DIMOUSESTATE2 { LONG lX, lY, lZ; BYTE rgbButtons[8]; } DIMOUSESTATE2, *LPDIMOUSESTATE2;

${comDeclarations(IFACES)}

/* A program without UNICODE gets the ANSI interfaces under the plain names */
#define IDirectInput8 IDirectInput8A
#define IDirectInputDevice8 IDirectInputDevice8A
#define LPDIRECTINPUT8 LPDIRECTINPUT8A
#define LPDIRECTINPUTDEVICE8 LPDIRECTINPUTDEVICE8A
#define IID_IDirectInput8 IID_IDirectInput8A
#define IID_IDirectInputDevice8 IID_IDirectInputDevice8A
extern const GUID IID_IDirectInput8A, IID_IDirectInputDevice8A;
extern const GUID GUID_SysMouse, GUID_SysKeyboard, GUID_XAxis, GUID_YAxis, GUID_ZAxis, GUID_Button, GUID_Key;
extern const DIDATAFORMAT c_dfDIKeyboard, c_dfDIMouse, c_dfDIMouse2;

HRESULT WINAPI DirectInput8Create(HINSTANCE hinst, DWORD dwVersion, REFIID riidltf, LPVOID *ppvOut, LPUNKNOWN punkOuter);

#define DI_OK                 S_OK
#define DI_NOTATTACHED        S_FALSE
#define DI_BUFFEROVERFLOW     S_FALSE
#define DI_PROPNOEFFECT       S_FALSE
#define DI_NOEFFECT           S_FALSE
#define DIERR_INVALIDPARAM    E_INVALIDARG
#define DIERR_NOINTERFACE     E_NOINTERFACE
#define DIERR_GENERIC         E_FAIL
#define DIERR_OUTOFMEMORY     E_OUTOFMEMORY
#define DIERR_UNSUPPORTED     E_NOTIMPL
#define DIERR_NOTINITIALIZED  MAKE_HRESULT(1, 7, 21)
#define DIERR_ALREADYINITIALIZED MAKE_HRESULT(1, 7, 1247)
#define DIERR_DEVICENOTREG    REGDB_E_CLASSNOTREG
#define DIERR_INPUTLOST       MAKE_HRESULT(1, 7, 30)
#define DIERR_ACQUIRED        MAKE_HRESULT(1, 7, 170)
#define DIERR_NOTACQUIRED     MAKE_HRESULT(1, 7, 12)
#define DIERR_OTHERAPPHASPRIO MAKE_HRESULT(1, 7, 5)
#define DIERR_HANDLEEXISTS    MAKE_HRESULT(1, 7, 5)
#define DIERR_BADDRIVERVER    MAKE_HRESULT(1, 7, 119)
#ifndef REGDB_E_CLASSNOTREG
#define REGDB_E_CLASSNOTREG   ((HRESULT)0x80040154L)
#endif

#define DISCL_EXCLUSIVE    0x00000001
#define DISCL_NONEXCLUSIVE 0x00000002
#define DISCL_FOREGROUND   0x00000004
#define DISCL_BACKGROUND   0x00000008
#define DISCL_NOWINKEY     0x00000010

#define DIGDD_PEEK 0x00000001
#define DIPH_DEVICE   0
#define DIPH_BYOFFSET 1
#define DIPH_BYID     2
#define DIPH_BYUSAGE  3
/* a predefined property is named by a small number cast to a GUID reference, as the SDK does */
#define MAKEDIPROP(prop) (*(const GUID *)(prop))
#define DIPROP_BUFFERSIZE MAKEDIPROP(1)
#define DIPROP_AXISMODE   MAKEDIPROP(2)
#define DIPROPAXISMODE_ABS 0
#define DIPROPAXISMODE_REL 1
#define DIPROP_GRANULARITY MAKEDIPROP(3)
#define DIPROP_RANGE      MAKEDIPROP(4)

#define DIDFT_ALL        0x00000000
#define DIDFT_RELAXIS    0x00000001
#define DIDFT_ABSAXIS    0x00000002
#define DIDFT_AXIS       0x00000003
#define DIDFT_PSHBUTTON  0x00000004
#define DIDFT_TGLBUTTON  0x00000008
#define DIDFT_BUTTON     0x0000000C
#define DIDFT_POV        0x00000010
#define DIDFT_ANYINSTANCE 0x00FFFF00
#define DIDFT_OPTIONAL   0x80000000
#define DIDFT_MAKEINSTANCE(n) ((WORD)(n) << 8)
#define DIDFT_GETINSTANCE(n) LOWORD((n) >> 8)
#define DIDF_ABSAXIS 0x00000001
#define DIDF_RELAXIS 0x00000002
#define DIDOI_ASPECTPOSITION 0x00000100

#define DIDEVTYPE_DEVICE   1
#define DI8DEVCLASS_ALL      0
#define DI8DEVCLASS_DEVICE   1
#define DI8DEVCLASS_POINTER  2
#define DI8DEVCLASS_KEYBOARD 3
#define DI8DEVCLASS_GAMECTRL 4
#define DIEDFL_ALLDEVICES  0x00000000
#define DIEDFL_ATTACHEDONLY 0x00000001

#define DIMOFS_X       0
#define DIMOFS_Y       4
#define DIMOFS_Z       8
#define DIMOFS_BUTTON0 12
#define DIMOFS_BUTTON1 13
#define DIMOFS_BUTTON2 14
#define DIMOFS_BUTTON3 15
#define DIMOFS_BUTTON4 16
#define DIMOFS_BUTTON5 17
#define DIMOFS_BUTTON6 18
#define DIMOFS_BUTTON7 19

${DIK_DEFINES}
#endif
`;
