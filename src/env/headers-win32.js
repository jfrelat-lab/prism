// headers-win32.js — <windows.h>, for programs whose original target was Win32.
//
// PRISM does not invent DirectDraw, DirectSound, DirectInput or SciTech MGL: WinQuake SHIPS those
// headers (dxsdk/SDK/INC, scitech/INCLUDE) and the target adds them to the include path. What they
// all assume, and what no source tree ships, is the Windows SDK underneath them -- the base types,
// the calling-convention macros, and the COM declaration macros that `objbase.h` would provide.
// That is what this file is, and its size is set by what those headers and the twelve platform units
// actually name, measured rather than anticipated.
//
// COM in C, not in C++. PRISM compiles C, and the real headers have a C shape for exactly this
// situation: an interface is a struct whose first member points at a vtable of function pointers,
// and a method call is `p->lpVtbl->Method(p, ...)`. Quake's own code is written that way -- it calls
// `IDirectDrawSurface_Lock(...)`, which the SDK defines as that expansion -- so the C form is not a
// simplification, it is the form the program was written against.

export const WIN32_HEADERS = {
  'windows.h': `
#ifndef _PRISM_WINDOWS_H
#define _PRISM_WINDOWS_H

/* ---- calling conventions. On a flat 32-bit target these are all the same call. */
#define WINAPI
#define APIENTRY
#define CALLBACK
#define PASCAL
#define WINAPIV
#define STDMETHODCALLTYPE
#define STDAPICALLTYPE
#define __stdcall
#define __cdecl
#define __declspec(x)
#define _far
#define _near
#define FAR
#define NEAR
#define CONST const
#define VOID void
#define EXTERN_C extern
#define IN
#define OUT
#define OPTIONAL

/* ---- the base types. i386 Windows: long is 32 bits, as it is here. */
typedef unsigned char BYTE, *LPBYTE, *PBYTE;
typedef unsigned short WORD, *LPWORD;
typedef unsigned long DWORD, *LPDWORD, *PDWORD;
typedef int BOOL, *LPBOOL, INT, *LPINT;
typedef unsigned int UINT, *LPUINT;
typedef long LONG, *LPLONG;
typedef unsigned long ULONG, *PULONG;
typedef short SHORT;
typedef unsigned short USHORT;
typedef char CHAR, *PCHAR;
typedef unsigned char UCHAR;
typedef float FLOAT;
typedef char TCHAR, *LPTSTR, *PTSTR, *LPSTR, *PSTR;
typedef unsigned short WCHAR, *LPWSTR;
typedef const char *LPCSTR, *PCSTR, *LPCTSTR;
typedef void *LPVOID, *PVOID, *LPCVOID;
typedef void *HANDLE, *PHANDLE;
typedef long LRESULT, LPARAM;
typedef unsigned int WPARAM;
typedef long HRESULT;
typedef unsigned short ATOM;
typedef unsigned long COLORREF;
typedef unsigned long SIZE_T;
typedef long LONG_PTR;
typedef unsigned long ULONG_PTR, DWORD_PTR;
typedef long long LONGLONG;
typedef unsigned long long ULONGLONG, DWORDLONG;

/*
 * LARGE_INTEGER, as a UNION. Quake reads it both ways in one function -- QueryPerformanceFrequency
 * fills it, then Sys_Init takes PerformanceFreq.LowPart and .HighPart apart by hand -- so a plain
 * 64-bit typedef would compile the declaration and fail on the very next line.
 */
typedef union _LARGE_INTEGER {
    struct { DWORD LowPart; LONG HighPart; };
    struct { DWORD LowPart; LONG HighPart; } u;
    LONGLONG QuadPart;
} LARGE_INTEGER, *PLARGE_INTEGER;
typedef union _ULARGE_INTEGER {
    struct { DWORD LowPart, HighPart; };
    ULONGLONG QuadPart;
} ULARGE_INTEGER;

/*
 * A handle is an opaque pointer, and DECLARE_HANDLE is how the SDK spells that. Keeping them
 * DISTINCT types matters: Quake stores an HWND, an HDC and an HINSTANCE in neighbouring globals, and
 * a typedef that collapsed them to void* would let a wrong one through without a word.
 */
#define DECLARE_HANDLE(name) typedef struct name##__ { int unused; } *name
DECLARE_HANDLE(HWND);
DECLARE_HANDLE(HDC);
DECLARE_HANDLE(HINSTANCE);
DECLARE_HANDLE(HMODULE);
DECLARE_HANDLE(HICON);
DECLARE_HANDLE(HCURSOR);
DECLARE_HANDLE(HBRUSH);
DECLARE_HANDLE(HMENU);
DECLARE_HANDLE(HGDIOBJ);
DECLARE_HANDLE(HPALETTE);
DECLARE_HANDLE(HBITMAP);
DECLARE_HANDLE(HGLOBAL);
DECLARE_HANDLE(HKEY);
DECLARE_HANDLE(HRSRC);
DECLARE_HANDLE(HACCEL);
typedef int (*FARPROC)(void);
typedef int (*PROC)(void);

/* ---- HRESULT, and the two tests every DirectX call is wrapped in. */
#define S_OK          ((HRESULT)0)
#define S_FALSE       ((HRESULT)1)
#define E_FAIL        ((HRESULT)0x80004005L)
#define E_NOINTERFACE ((HRESULT)0x80004002L)
#define E_OUTOFMEMORY ((HRESULT)0x8007000EL)
#define E_INVALIDARG  ((HRESULT)0x80070057L)
#define SUCCEEDED(hr) ((HRESULT)(hr) >= 0)
#define FAILED(hr)    ((HRESULT)(hr) < 0)
#define MAKE_HRESULT(sev,fac,code) \\
    ((HRESULT)(((unsigned long)(sev)<<31)|((unsigned long)(fac)<<16)|((unsigned long)(code))))

/* ---- GUIDs. Without INITGUID a DEFINE_GUID is a DECLARATION, which is all a client needs. */
typedef struct _GUID {
    unsigned long  Data1;
    unsigned short Data2;
    unsigned short Data3;
    unsigned char  Data4[8];
} GUID, IID, CLSID, *LPGUID, *LPCLSID;
typedef const GUID *REFGUID, *REFIID, *REFCLSID;
#define DEFINE_GUID(name, a, b, c, d0,d1,d2,d3,d4,d5,d6,d7) extern const GUID name
#define DEFINE_OLEGUID(name, l, w1, w2) extern const GUID name

/*
 * ---- COM, in its C form.
 *
 * This is the shape objbase.h gives these macros when __cplusplus is not defined, transcribed rather
 * than approximated: an interface is a struct holding a pointer to its vtable, and every method is a
 * function pointer whose first parameter is the interface itself. Quake calls them through the
 * SDK's own IDirectDrawSurface_Lock-style wrappers, which expand to exactly that.
 */
#define interface struct
#define DECLARE_INTERFACE(iface) \\
    typedef struct iface##Vtbl iface##Vtbl; \\
    typedef struct iface { iface##Vtbl *lpVtbl; } iface; \\
    struct iface##Vtbl
#define DECLARE_INTERFACE_(iface, baseiface) DECLARE_INTERFACE(iface)
#define STDMETHOD(method)        HRESULT (STDMETHODCALLTYPE *method)
#define STDMETHOD_(type, method) type (STDMETHODCALLTYPE *method)
#define STDAPI                   HRESULT WINAPI
#define STDAPI_(type)            type WINAPI
#define PURE
#define THIS_                    void *This,
#define THIS                     void *This
typedef struct IUnknown IUnknown;
typedef IUnknown *LPUNKNOWN;

/* ---- the small structs the platform units name. */
typedef struct tagRECT { LONG left, top, right, bottom; } RECT, *LPRECT, *PRECT;
typedef struct tagPOINT { LONG x, y; } POINT, *LPPOINT, *PPOINT;
typedef struct tagSIZE { LONG cx, cy; } SIZE, *LPSIZE;
typedef struct tagMSG {
    HWND hwnd; UINT message; WPARAM wParam; LPARAM lParam; DWORD time; POINT pt;
} MSG, *LPMSG, *PMSG;
typedef struct tagPAINTSTRUCT {
    HDC hdc; BOOL fErase; RECT rcPaint; BOOL fRestore; BOOL fIncUpdate; BYTE rgbReserved[32];
} PAINTSTRUCT, *LPPAINTSTRUCT;
typedef struct tagPALETTEENTRY {
    BYTE peRed, peGreen, peBlue, peFlags;
} PALETTEENTRY, *LPPALETTEENTRY;
typedef struct tagLOGPALETTE {
    WORD palVersion, palNumEntries; PALETTEENTRY palPalEntry[1];
} LOGPALETTE, *LPLOGPALETTE;
typedef LRESULT (CALLBACK *WNDPROC)(HWND, UINT, WPARAM, LPARAM);
typedef struct tagWNDCLASS {
    UINT style; WNDPROC lpfnWndProc; int cbClsExtra, cbWndExtra;
    HINSTANCE hInstance; HICON hIcon; HCURSOR hCursor; HBRUSH hbrBackground;
    LPCSTR lpszMenuName, lpszClassName;
} WNDCLASS, *LPWNDCLASS;
typedef struct _OSVERSIONINFO {
    DWORD dwOSVersionInfoSize, dwMajorVersion, dwMinorVersion, dwBuildNumber, dwPlatformId;
    CHAR szCSDVersion[128];
} OSVERSIONINFO, *LPOSVERSIONINFO;
typedef struct _SYSTEM_INFO {
    DWORD dwOemId; DWORD dwPageSize; LPVOID lpMinimumApplicationAddress, lpMaximumApplicationAddress;
    DWORD dwActiveProcessorMask, dwNumberOfProcessors, dwProcessorType,
          dwAllocationGranularity; WORD wProcessorLevel, wProcessorRevision;
} SYSTEM_INFO, *LPSYSTEM_INFO;
typedef struct _MEMORYSTATUS {
    DWORD dwLength, dwMemoryLoad, dwTotalPhys, dwAvailPhys, dwTotalPageFile,
          dwAvailPageFile, dwTotalVirtual, dwAvailVirtual;
} MEMORYSTATUS, *LPMEMORYSTATUS;
typedef struct _SECURITY_ATTRIBUTES {
    DWORD nLength; LPVOID lpSecurityDescriptor; BOOL bInheritHandle;
} SECURITY_ATTRIBUTES, *LPSECURITY_ATTRIBUTES;
/* The display mode, for the fullscreen switch. Only the fields vid_win.c sets are named. */
typedef struct _DEVMODE {
    char dmDeviceName[32]; WORD dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    DWORD dmFields; short dmOrientation, dmPaperSize, dmPaperLength, dmPaperWidth,
          dmScale, dmCopies, dmDefaultSource, dmPrintQuality, dmColor, dmDuplex,
          dmYResolution, dmTTOption, dmCollate; char dmFormName[32];
    WORD dmLogPixels; DWORD dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
} DEVMODE, *LPDEVMODE, *PDEVMODE;
#define DM_BITSPERPEL 0x00040000
#define DM_PELSWIDTH  0x00080000
#define DM_PELSHEIGHT 0x00100000

typedef struct _COORD { SHORT X, Y; } COORD;
typedef struct _SMALL_RECT { SHORT Left, Top, Right, Bottom; } SMALL_RECT;
typedef struct _CONSOLE_SCREEN_BUFFER_INFO {
    COORD dwSize, dwCursorPosition; WORD wAttributes; SMALL_RECT srWindow; COORD dwMaximumWindowSize;
} CONSOLE_SCREEN_BUFFER_INFO, *PCONSOLE_SCREEN_BUFFER_INFO;
typedef struct _KEY_EVENT_RECORD {
    BOOL bKeyDown; WORD wRepeatCount, wVirtualKeyCode, wVirtualScanCode;
    union { WORD UnicodeChar; CHAR AsciiChar; } uChar; DWORD dwControlKeyState;
} KEY_EVENT_RECORD;
typedef struct _INPUT_RECORD {
    WORD EventType; union { KEY_EVENT_RECORD KeyEvent; } Event;
} INPUT_RECORD, *PINPUT_RECORD;
typedef LONG (*PTOP_LEVEL_EXCEPTION_FILTER)(LPVOID);
typedef DWORD (WINAPI *LPTHREAD_START_ROUTINE)(LPVOID);

/* ---- the constants the platform units name. */
#define TRUE 1
#define FALSE 0
#define NULL_HANDLE ((HANDLE)0)
#define INVALID_HANDLE_VALUE ((HANDLE)-1)
#define MAX_PATH 260
#define INFINITE 0xFFFFFFFF
#define WAIT_OBJECT_0 0
#define GENERIC_READ  0x80000000
#define GENERIC_WRITE 0x40000000
#define STD_INPUT_HANDLE  ((DWORD)-10)
#define STD_OUTPUT_HANDLE ((DWORD)-11)
#define STD_ERROR_HANDLE  ((DWORD)-12)
#define KEY_EVENT 0x0001
#define VER_PLATFORM_WIN32s        0
#define VER_PLATFORM_WIN32_WINDOWS 1
#define VER_PLATFORM_WIN32_NT      2
#define MB_OK 0x0
#define MB_ICONSTOP 0x10
#define MB_SETFOREGROUND 0x10000
#define MB_ICONEXCLAMATION 0x30
#define SW_SHOWDEFAULT 10
#define SW_SHOWNORMAL 1
#define SW_HIDE 0
#define SW_SHOWMINIMIZED 2
#define SW_RESTORE 9
#define SW_SHOWMINNOACTIVE 7
#define WS_OVERLAPPEDWINDOW 0x00CF0000
#define WS_POPUP 0x80000000
#define WS_VISIBLE 0x10000000
#define WS_SYSMENU 0x00080000
#define WS_CAPTION 0x00C00000
#define WS_MINIMIZEBOX 0x00020000
#define WS_CLIPSIBLINGS 0x04000000
#define WS_CLIPCHILDREN 0x02000000
#define CS_HREDRAW 0x0002
#define CS_VREDRAW 0x0001
#define CS_OWNDC   0x0020
#define PM_REMOVE 0x0001
#define PM_NOREMOVE 0x0000
#define SM_CXSCREEN 0
#define SM_CYSCREEN 1
#define SM_CXFIXEDFRAME 7
#define SM_CYFIXEDFRAME 8
#define SM_CYCAPTION 4
#define SM_CYMENU 15
#define HWND_TOP ((HWND)0)
#define SWP_NOSIZE 0x0001
#define SWP_NOMOVE 0x0002
#define SWP_NOZORDER 0x0004
#define SWP_DRAWFRAME 0x0020
#define SWP_NOACTIVATE 0x0010
#define IDOK 1
#define IDI_APPLICATION ((LPCSTR)32512)
#define IDC_ARROW ((LPCSTR)32512)
#define COLOR_GRAYTEXT 17
#define BLACK_BRUSH 4
#define SYSPAL_NOSTATIC 2
#define SYSPAL_STATIC 1
#define RASTERCAPS 38
#define RC_PALETTE 0x0100
#define SIZEPALETTE 104
#define NUMRESERVED 106
#define BITSPIXEL 12
#define PC_NOCOLLAPSE 0x04
#define PC_RESERVED 0x01
#define THREAD_PRIORITY_HIGHEST 2
#define THREAD_PRIORITY_NORMAL 0
#define NORMAL_PRIORITY_CLASS 0x00000020
#define HIGH_PRIORITY_CLASS 0x00000080
#define CREATE_SUSPENDED 0x00000004
#define PAGE_READWRITE 0x04
#define FILE_MAP_WRITE 0x0002
#define FILE_MAP_READ  0x0004
#define ENUM_CURRENT_SETTINGS ((DWORD)-1)
#define CDS_FULLSCREEN 0x00000004
#define DISP_CHANGE_SUCCESSFUL 0

/* Message numbers, only those the window procedure switches on. */
#define WM_CREATE 0x0001
#define WM_DESTROY 0x0002
#define WM_MOVE 0x0003
#define WM_SIZE 0x0005
#define WM_ACTIVATE 0x0006
#define WM_SETFOCUS 0x0007
#define WM_KILLFOCUS 0x0008
#define WM_PAINT 0x000F
#define WM_CLOSE 0x0010
#define WM_QUIT 0x0012
#define WM_ERASEBKGND 0x0014
#define WM_SYSCOLORCHANGE 0x0015
#define WM_ACTIVATEAPP 0x001C
#define WM_SETCURSOR 0x0020
#define WM_GETMINMAXINFO 0x0024
#define WM_KEYDOWN 0x0100
#define WM_KEYUP 0x0101
#define WM_SYSKEYDOWN 0x0104
#define WM_SYSKEYUP 0x0105
#define WM_SYSCOMMAND 0x0112
#define WM_MOUSEMOVE 0x0200
#define WM_LBUTTONDOWN 0x0201
#define WM_LBUTTONUP 0x0202
#define WM_RBUTTONDOWN 0x0204
#define WM_RBUTTONUP 0x0205
#define WM_MBUTTONDOWN 0x0207
#define WM_MBUTTONUP 0x0208
#define WM_MOUSEWHEEL 0x020A
#define WM_DISPLAYCHANGE 0x007E
#define SC_SCREENSAVE 0xF140
#define SC_MONITORPOWER 0xF170
#define MK_LBUTTON 0x0001
#define MK_RBUTTON 0x0002
#define MK_MBUTTON 0x0010
#define WA_INACTIVE 0
#define WM_SETICON 0x0080
#define ICON_SMALL 0
#define ICON_BIG 1
#define SC_MINIMIZE 0xF020
#define SC_MAXIMIZE 0xF030
#define SC_CLOSE 0xF060
#define SC_KEYMENU 0xF100
#define SWP_SHOWWINDOW 0x0040
#define SWP_HIDEWINDOW 0x0080
#define SWP_NOCOPYBITS 0x0100
#define SWP_FRAMECHANGED 0x0020
#define HWND_BROADCAST ((HWND)0xffff)
#define HWND_TOPMOST ((HWND)-1)
#define HWND_NOTOPMOST ((HWND)-2)
#define CDS_TEST 0x00000002
#define CDS_UPDATEREGISTRY 0x00000001
#define DISP_CHANGE_RESTART 1
#define DISP_CHANGE_FAILED (-1)
#define DISP_CHANGE_BADMODE (-2)
#define WM_INITDIALOG 0x0110
#define WM_COMMAND 0x0111
#define WM_NCCREATE 0x0081
#define WM_HOTKEY 0x0312
#define GWL_STYLE (-16)
#define GWL_EXSTYLE (-20)
#define WS_EX_TOPMOST 0x00000008
#define WS_BORDER 0x00800000
#define WS_DLGFRAME 0x00400000
#define WS_THICKFRAME 0x00040000
#define WS_MAXIMIZEBOX 0x00010000
#define WS_OVERLAPPED 0x00000000
#define VK_ESCAPE 0x1B
#define VK_RETURN 0x0D
#define VK_TAB 0x09
#define VK_SPACE 0x20
#define VK_SHIFT 0x10
#define VK_CONTROL 0x11
#define VK_MENU 0x12
#define VK_PAUSE 0x13
#define VK_UP 0x26
#define VK_DOWN 0x28
#define VK_LEFT 0x25
#define VK_RIGHT 0x27
#define VK_INSERT 0x2D
#define VK_DELETE 0x2E
#define VK_HOME 0x24
#define VK_END 0x23
#define VK_PRIOR 0x21
#define VK_NEXT 0x22
#define VK_BACK 0x08
#define VK_F1 0x70
#define VK_F12 0x7B
#define VK_LWIN 0x5B
#define VK_RWIN 0x5C
#define VK_APPS 0x5D
#define VK_NUMLOCK 0x90
#define VK_CAPITAL 0x14
#define VK_SNAPSHOT 0x2C
#define VK_SCROLL 0x91
#define WM_CHAR 0x0102
#define WM_SYSCHAR 0x0106
#define WM_DEADCHAR 0x0103
#define WM_SYSDEADCHAR 0x0107
#define WM_MOUSEACTIVATE 0x0021
#define WM_ENTERMENULOOP 0x0211
#define WM_EXITMENULOOP 0x0212
#define WM_ENTERSIZEMOVE 0x0231
#define WM_EXITSIZEMOVE 0x0232
#define WM_NCLBUTTONDOWN 0x00A1
#define WM_WINDOWPOSCHANGED 0x0047
#define WM_SHOWWINDOW 0x0018
#define WM_TIMER 0x0113
#define MA_ACTIVATE 1
#define MA_NOACTIVATE 3
#define SIZE_MINIMIZED 1
#define SIZE_RESTORED 0
#define SIZE_MAXIMIZED 2
#define WA_ACTIVE 1
#define WA_CLICKACTIVE 2
#define MB_APPLMODAL 0x0
#define MB_ICONINFORMATION 0x40
#define MB_YESNO 0x4
#define IDYES 6
#define IDNO 7
#define ES_READONLY 0x0800
#define CW_USEDEFAULT ((int)0x80000000)
#define WM_PALETTECHANGED 0x0311
#define WM_QUERYNEWPALETTE 0x030F
#define WM_PALETTEISCHANGING 0x0310
#define WM_MOVING 0x0216
#define WM_SIZING 0x0214
#define WM_CANCELMODE 0x001F
#define WM_NCACTIVATE 0x0086
#define WM_GETICON 0x007F
#define WM_INPUTLANGCHANGE 0x0051
#define WM_SETTINGCHANGE 0x001A
#define WM_DEVICECHANGE 0x0219
#define WM_POWERBROADCAST 0x0218
#define WM_USER 0x0400
#define HORZRES 8
#define VERTRES 10
#define SW_MINIMIZE 6
#define SEVERITY_ERROR 1
#define SEVERITY_SUCCESS 0
#define QS_ALLINPUT 0x04FF
#define MB_ICONQUESTION 0x20
#define MB_RETRYCANCEL 0x5
#define IDRETRY 4
#define IDCANCEL 2
#define FACILITY_WIN32 7
#define SPI_SETMOUSE 4
#define SPI_GETMOUSE 3
#define PAGE_EXECUTE_READWRITE 0x40
#define ERROR_READ_FAULT 30
#define ERROR_SUCCESS 0
#define ERROR_INVALID_ACCESS 12
#define GMEM_MOVEABLE 0x0002
#define GMEM_SHARE 0x2000
#define PATCOPY 0x00F00021
#define BLACKNESS 0x00000042
BOOL WINAPI PatBlt(HDC, int, int, int, int, DWORD);
BOOL WINAPI BitBlt(HDC, int, int, int, int, HDC, int, int, DWORD);
LONG WINAPI SetWindowLong(HWND, int, LONG);
LONG WINAPI GetWindowLong(HWND, int);
HWND WINAPI SetCapture(HWND);
BOOL WINAPI ReleaseCapture(void);
BOOL WINAPI VirtualProtect(LPVOID, DWORD, DWORD, LPDWORD);
BOOL WINAPI AdjustWindowRectEx(LPRECT, DWORD, BOOL, DWORD);
BOOL WINAPI SystemParametersInfo(UINT, UINT, LPVOID, UINT);
BOOL WINAPI InvalidateRect(HWND, const RECT *, BOOL);
DWORD WINAPI MsgWaitForMultipleObjects(DWORD, HANDLE *, BOOL, DWORD, DWORD);
DWORD WINAPI WaitForMultipleObjects(DWORD, HANDLE *, BOOL, DWORD);
BOOL WINAPI WriteConsoleInput(HANDLE, const INPUT_RECORD *, DWORD, LPDWORD);
BOOL WINAPI SetConsoleWindowInfo(HANDLE, BOOL, const SMALL_RECT *);

#define LOWORD(l) ((WORD)((DWORD)(l) & 0xffff))
#define HIWORD(l) ((WORD)(((DWORD)(l) >> 16) & 0xffff))
#define LOBYTE(w) ((BYTE)((DWORD)(w) & 0xff))
#define HIBYTE(w) ((BYTE)(((DWORD)(w) >> 8) & 0xff))
#define MAKELONG(a,b) ((LONG)(((WORD)(a))|(((DWORD)((WORD)(b)))<<16)))
#define MAKEWORD(a,b) ((WORD)(((BYTE)(a))|(((WORD)((BYTE)(b)))<<8)))
#define MAKEINTRESOURCE(i) ((LPCSTR)((DWORD)((WORD)(i))))
#define RGB(r,g,b) ((COLORREF)(((BYTE)(r)|((WORD)((BYTE)(g))<<8))|(((DWORD)(BYTE)(b))<<16)))
#define FIELD_OFFSET(type, field) ((LONG)(LONG_PTR)&(((type *)0)->field))

/* ---- the functions. Declared here, resolved by src/env/win32.js -- or reported as undefined,
   which is the point of declaring them rather than guessing at an implementation. */
HWND WINAPI CreateWindowEx(DWORD, LPCSTR, LPCSTR, DWORD, int, int, int, int, HWND, HMENU, HINSTANCE, LPVOID);
BOOL WINAPI DestroyWindow(HWND);
ATOM WINAPI RegisterClass(const WNDCLASS *);
LRESULT WINAPI DefWindowProc(HWND, UINT, WPARAM, LPARAM);
BOOL WINAPI ShowWindow(HWND, int);
BOOL WINAPI UpdateWindow(HWND);
BOOL WINAPI SetForegroundWindow(HWND);
HWND WINAPI SetFocus(HWND);
HWND WINAPI SetActiveWindow(HWND);
BOOL WINAPI SetWindowPos(HWND, HWND, int, int, int, int, UINT);
BOOL WINAPI PeekMessage(LPMSG, HWND, UINT, UINT, UINT);
BOOL WINAPI GetMessage(LPMSG, HWND, UINT, UINT);
BOOL WINAPI TranslateMessage(const MSG *);
LRESULT WINAPI DispatchMessage(const MSG *);
LRESULT WINAPI SendMessage(HWND, UINT, WPARAM, LPARAM);
BOOL WINAPI PostMessage(HWND, UINT, WPARAM, LPARAM);
void WINAPI PostQuitMessage(int);
UINT WINAPI RegisterWindowMessage(LPCSTR);
int WINAPI MessageBox(HWND, LPCSTR, LPCSTR, UINT);
HDC WINAPI GetDC(HWND);
int WINAPI ReleaseDC(HWND, HDC);
HDC WINAPI BeginPaint(HWND, LPPAINTSTRUCT);
BOOL WINAPI EndPaint(HWND, const PAINTSTRUCT *);
int WINAPI GetDeviceCaps(HDC, int);
HICON WINAPI LoadIcon(HINSTANCE, LPCSTR);
HCURSOR WINAPI LoadCursor(HINSTANCE, LPCSTR);
HGDIOBJ WINAPI GetStockObject(int);
BOOL WINAPI AdjustWindowRect(LPRECT, DWORD, BOOL);
int WINAPI GetSystemMetrics(int);
UINT WINAPI GetSystemPaletteUse(HDC);
UINT WINAPI SetSystemPaletteUse(HDC, UINT);
UINT WINAPI GetSystemPaletteEntries(HDC, UINT, UINT, LPPALETTEENTRY);
HPALETTE WINAPI CreatePalette(const LOGPALETTE *);
HPALETTE WINAPI SelectPalette(HDC, HPALETTE, BOOL);
UINT WINAPI RealizePalette(HDC);
BOOL WINAPI DeleteObject(HGDIOBJ);
BOOL WINAPI EnumDisplaySettings(LPCSTR, DWORD, LPVOID);
LONG WINAPI ChangeDisplaySettings(LPVOID, DWORD);
BOOL WINAPI ShowCursor(BOOL);
BOOL WINAPI SetCursorPos(int, int);
BOOL WINAPI GetCursorPos(LPPOINT);
BOOL WINAPI ClientToScreen(HWND, LPPOINT);
BOOL WINAPI ScreenToClient(HWND, LPPOINT);
BOOL WINAPI GetClientRect(HWND, LPRECT);
BOOL WINAPI GetWindowRect(HWND, LPRECT);
BOOL WINAPI ClipCursor(const RECT *);
int WINAPI SetWindowText(HWND, LPCSTR);
short WINAPI GetKeyState(int);
short WINAPI GetAsyncKeyState(int);

HMODULE WINAPI LoadLibrary(LPCSTR);
BOOL WINAPI FreeLibrary(HMODULE);
FARPROC WINAPI GetProcAddress(HMODULE, LPCSTR);
HMODULE WINAPI GetModuleHandle(LPCSTR);
DWORD WINAPI GetModuleFileName(HMODULE, LPSTR, DWORD);
DWORD WINAPI GetLastError(void);
void WINAPI SetLastError(DWORD);
void WINAPI ExitProcess(UINT);
void WINAPI Sleep(DWORD);
DWORD WINAPI GetTickCount(void);
BOOL WINAPI QueryPerformanceCounter(LARGE_INTEGER *);
BOOL WINAPI QueryPerformanceFrequency(LARGE_INTEGER *);
BOOL WINAPI GetVersionEx(LPOSVERSIONINFO);
void WINAPI GetSystemInfo(LPSYSTEM_INFO);
void WINAPI GlobalMemoryStatus(LPMEMORYSTATUS);
DWORD WINAPI GetCurrentDirectory(DWORD, LPSTR);
BOOL WINAPI SetCurrentDirectory(LPCSTR);
HANDLE WINAPI GetCurrentProcess(void);
HANDLE WINAPI GetCurrentThread(void);
BOOL WINAPI SetPriorityClass(HANDLE, DWORD);
BOOL WINAPI SetThreadPriority(HANDLE, int);
HANDLE WINAPI CreateThread(LPSECURITY_ATTRIBUTES, DWORD, LPTHREAD_START_ROUTINE, LPVOID, DWORD, LPDWORD);
DWORD WINAPI ResumeThread(HANDLE);
HANDLE WINAPI CreateEvent(LPSECURITY_ATTRIBUTES, BOOL, BOOL, LPCSTR);
BOOL WINAPI SetEvent(HANDLE);
BOOL WINAPI ResetEvent(HANDLE);
DWORD WINAPI WaitForSingleObject(HANDLE, DWORD);
BOOL WINAPI CloseHandle(HANDLE);
HGLOBAL WINAPI GlobalAlloc(UINT, DWORD);
LPVOID WINAPI GlobalLock(HGLOBAL);
BOOL WINAPI GlobalUnlock(HGLOBAL);
HGLOBAL WINAPI GlobalFree(HGLOBAL);
HANDLE WINAPI CreateFileMapping(HANDLE, LPSECURITY_ATTRIBUTES, DWORD, DWORD, DWORD, LPCSTR);
LPVOID WINAPI MapViewOfFile(HANDLE, DWORD, DWORD, DWORD, DWORD);
BOOL WINAPI UnmapViewOfFile(LPCVOID);

BOOL WINAPI AllocConsole(void);
BOOL WINAPI FreeConsole(void);
HANDLE WINAPI GetStdHandle(DWORD);
BOOL WINAPI WriteFile(HANDLE, LPCVOID, DWORD, LPDWORD, LPVOID);
BOOL WINAPI ReadFile(HANDLE, LPVOID, DWORD, LPDWORD, LPVOID);
BOOL WINAPI GetConsoleScreenBufferInfo(HANDLE, PCONSOLE_SCREEN_BUFFER_INFO);
BOOL WINAPI SetConsoleScreenBufferSize(HANDLE, COORD);
BOOL WINAPI SetConsoleCursorPosition(HANDLE, COORD);
BOOL WINAPI SetConsoleTextAttribute(HANDLE, WORD);
BOOL WINAPI GetNumberOfConsoleInputEvents(HANDLE, LPDWORD);
BOOL WINAPI ReadConsoleInput(HANDLE, PINPUT_RECORD, DWORD, LPDWORD);
BOOL WINAPI WriteConsoleOutputCharacter(HANDLE, LPCSTR, DWORD, COORD, LPDWORD);
BOOL WINAPI ReadConsoleOutputCharacter(HANDLE, LPSTR, DWORD, COORD, LPDWORD);
BOOL WINAPI FlushConsoleInputBuffer(HANDLE);
COORD WINAPI GetLargestConsoleWindowSize(HANDLE);
BOOL WINAPI SetConsoleTitle(LPCSTR);
PTOP_LEVEL_EXCEPTION_FILTER WINAPI SetUnhandledExceptionFilter(PTOP_LEVEL_EXCEPTION_FILTER);
HWND WINAPI CreateDialog(HINSTANCE, LPCSTR, HWND, LPVOID);

/* windows.h has always pulled in the multimedia header, and dsound.h relies on that: it names
   LPWAVEFORMATEX without including anything that declares it. */
#include <mmsystem.h>
#include <winsock.h>

#endif
`,
  /*
   * winsock.h, because windows.h used to include it and winquake.h relies on that: it declares
   * pointers to eleven Winsock entry points -- pWSAStartup, psocket, precvfrom ... -- without
   * including anything that names SOCKET or LPWSADATA. The declarations stand whichever net_*.c the
   * build links, so even a net_none.c build needs the types.
   */
  'winsock.h': `
#ifndef _PRISM_WINSOCK_H
#define _PRISM_WINSOCK_H
typedef unsigned int SOCKET;
typedef unsigned long u_long;
typedef unsigned short u_short;
typedef unsigned char u_char;
typedef unsigned int u_int;
#define INVALID_SOCKET ((SOCKET)~0)
#define SOCKET_ERROR (-1)
typedef struct WSAData {
    unsigned short wVersion, wHighVersion;
    char szDescription[257], szSystemStatus[129];
    unsigned short iMaxSockets, iMaxUdpDg;
    char *lpVendorInfo;
} WSADATA, *LPWSADATA;
struct sockaddr { unsigned short sa_family; char sa_data[14]; };
struct in_addr { unsigned long s_addr; };
struct sockaddr_in {
    short sin_family; unsigned short sin_port; struct in_addr sin_addr; char sin_zero[8];
};
struct hostent {
    char *h_name; char **h_aliases; short h_addrtype, h_length; char **h_addr_list;
};
#define h_addr h_addr_list[0]
#define AF_INET 2
#define SOCK_DGRAM 2
#define SOCK_STREAM 1
#define IPPROTO_UDP 17
#define SOL_SOCKET 0xffff
#define SO_BROADCAST 0x0020
#define FIONBIO 0x8004667e
#define MAKEWORD_WSA(a,b) ((unsigned short)(((unsigned char)(a))|(((unsigned short)((unsigned char)(b)))<<8)))
#endif
`,
  'windowsx.h': '#include <windows.h>\n',
  'objbase.h': '#include <windows.h>\n',
  'mmsystem.h': `
#ifndef _PRISM_MMSYSTEM_H
#define _PRISM_MMSYSTEM_H
#include <windows.h>
typedef struct { WORD wFormatTag, nChannels; DWORD nSamplesPerSec, nAvgBytesPerSec;
                 WORD nBlockAlign, wBitsPerSample, cbSize; } WAVEFORMATEX, *LPWAVEFORMATEX;
#define WAVE_FORMAT_PCM 1
typedef DWORD MMRESULT;
#define MMSYSERR_NOERROR 0
#define MMSYSERR_ALLOCATED 4
#define MMSYSERR_ERROR 1
#define MMSYSERR_BADDEVICEID 2
#define JOYERR_NOERROR 0
#define JOYERR_UNPLUGGED 167
#define JOYCAPS_HASZ 0x0001
#define JOYCAPS_HASPOV 0x0010
#define JOY_RETURNCENTERED 0x00000400
#define JOY_RETURNX 0x00000001
#define JOY_RETURNY 0x00000002
#define JOY_RETURNZ 0x00000004
#define JOY_RETURNBUTTONS 0x00000080
#define JOY_RETURNR 0x00000008
#define JOY_RETURNU 0x00000010
#define JOY_RETURNV 0x00000020
#define JOY_RETURNPOV 0x00000040
#define JOY_RETURNRAWDATA 0x00000100
#define JOY_RETURNPOVCTS 0x00000200
#define JOY_RETURNALL 0x000000ff
#define JOY_POVCENTERED ((WORD)-1)
#define JOY_POVFORWARD 0
#define JOY_POVRIGHT 9000
#define JOY_POVBACKWARD 18000
#define JOY_POVLEFT 27000
#define JOYSTICKID1 0
#define TIME_SAMPLES 0x0002
#define TIME_BYTES 0x0004
#define WAVERR_STILLPLAYING 33
#define WHDR_DONE 0x00000001
#define WHDR_PREPARED 0x00000002
#define CALLBACK_NULL 0x00000000
#define WAVE_MAPPER ((UINT)-1)
#define MM_MCINOTIFY 0x03B9
#define MM_WOM_DONE 0x03BD
#define MCI_NOTIFY_SUCCESSFUL 0x0001
#define MCI_NOTIFY_SUPERSEDED 0x0002
#define MCI_NOTIFY_ABORTED 0x0004
#define MCI_NOTIFY_FAILURE 0x0008
DWORD WINAPI mciSendCommand(DWORD, UINT, DWORD, DWORD);
DWORD WINAPI mciGetErrorString(DWORD, LPSTR, UINT);
typedef char *HPSTR;
DECLARE_HANDLE(HWAVEOUT);
typedef HWAVEOUT *LPHWAVEOUT;
typedef struct wavehdr_tag {
    LPSTR lpData; DWORD dwBufferLength, dwBytesRecorded, dwUser, dwFlags, dwLoops;
    struct wavehdr_tag *lpNext; DWORD reserved;
} WAVEHDR, *LPWAVEHDR;
typedef struct { WORD wMid, wPid; DWORD vDriverVersion; char szPname[32];
                 DWORD dwFormats; WORD wChannels, wReserved1; DWORD dwSupport; } WAVEOUTCAPS, *LPWAVEOUTCAPS;
typedef struct { UINT wType; union { DWORD ms, sample, cb, ticks; } u; } MMTIME, *LPMMTIME;
typedef struct { WORD wMid, wPid; char szPname[32];
                 UINT wXmin, wXmax, wYmin, wYmax, wZmin, wZmax, wNumButtons,
                      wPeriodMin, wPeriodMax,
                      wRmin, wRmax, wUmin, wUmax, wVmin, wVmax,
                      wCaps, wMaxAxes, wNumAxes, wMaxButtons;
                 char szRegKey[32], szOEMVxD[260]; } JOYCAPS, *LPJOYCAPS;

/* MCI, for cd_win.c. Every one of these is a parameter block passed to mciSendCommand. */
typedef struct { DWORD dwCallback; } MCI_GENERIC_PARMS, *LPMCI_GENERIC_PARMS;
typedef struct { DWORD dwCallback, wDeviceID; LPCSTR lpstrDeviceType, lpstrElementName,
                 lpstrAlias; } MCI_OPEN_PARMS, *LPMCI_OPEN_PARMS;
typedef struct { DWORD dwCallback, dwReturn, dwItem, dwTrack; } MCI_STATUS_PARMS, *LPMCI_STATUS_PARMS;
typedef struct { DWORD dwCallback, dwFrom, dwTo; } MCI_PLAY_PARMS, *LPMCI_PLAY_PARMS;
typedef struct { DWORD dwCallback, dwTimeFormat, dwAudio; UINT wInput, wOutput; } MCI_SET_PARMS, *LPMCI_SET_PARMS;
#define MCI_OPEN 0x0803
#define MCI_CLOSE 0x0804
#define MCI_PLAY 0x0806
#define MCI_STOP 0x0808
#define MCI_PAUSE 0x0809
#define MCI_RESUME 0x0855
#define MCI_SEEK 0x0807
#define MCI_STATUS 0x0814
#define MCI_SET 0x080D
#define MCI_SET_DOOR_OPEN 0x0100
#define MCI_SET_DOOR_CLOSED 0x0200
#define MCI_SET_TIME_FORMAT 0x0400
#define MCI_FORMAT_TMSF 10
#define MCI_OPEN_TYPE 0x00002000
#define MCI_OPEN_SHAREABLE 0x00000100
#define MCI_OPEN_ELEMENT 0x00000200
#define MCI_STATUS_ITEM 0x00000100
#define MCI_STATUS_NUMBER_OF_TRACKS 0x00000003
#define MCI_STATUS_LENGTH 0x00000001
#define MCI_STATUS_POSITION 0x00000002
#define MCI_STATUS_MODE 0x00000004
#define MCI_STATUS_READY 0x00000007
#define MCI_TRACK 0x00000010
#define MCI_CDA_STATUS_TYPE_TRACK 0x00004001
#define MCI_CDA_TRACK_AUDIO 1088
#define MCI_MODE_NOT_READY 525
#define MCI_MODE_STOP 526
#define MCI_MODE_PLAY 527
#define MCI_MODE_PAUSE 529
#define MCI_MODE_OPEN 530
#define MCI_NOTIFY 0x00000001
#define MCI_WAIT 0x00000002
#define MCI_FROM 0x00000004
#define MCI_TO 0x00000008
#define MCI_MSF_MINUTE(t) ((BYTE)(((WORD)(t)) >> 8))
#define MCI_MSF_SECOND(t) ((BYTE)(((DWORD)(t)) >> 16))
#define MCI_TMSF_TRACK(t) ((BYTE)((t) & 0xff))
#define MCI_TMSF_MINUTE(t) ((BYTE)(((WORD)(t)) >> 8))
#define MCI_TMSF_SECOND(t) ((BYTE)(((DWORD)(t)) >> 16))
#define MCI_TMSF_FRAME(t) ((BYTE)(((DWORD)(t)) >> 24))

/* The prototypes come last: every one of them names a type declared above. */
typedef struct { UINT wXpos, wYpos, wZpos, wButtons; } JOYINFO, *LPJOYINFO;
typedef struct { DWORD dwSize, dwFlags, dwXpos, dwYpos, dwZpos, dwRpos, dwUpos, dwVpos,
                 dwButtons, dwButtonNumber, dwPOV, dwReserved1, dwReserved2; } JOYINFOEX, *LPJOYINFOEX;
MMRESULT WINAPI joyGetDevCaps(UINT, LPJOYCAPS, UINT);
MMRESULT WINAPI joyGetPosEx(UINT, LPJOYINFOEX);
MMRESULT WINAPI joyGetPos(UINT, LPJOYINFO);
MMRESULT WINAPI waveOutOpen(HWAVEOUT *, UINT, LPWAVEFORMATEX, DWORD, DWORD, DWORD);
MMRESULT WINAPI waveOutClose(HWAVEOUT);
MMRESULT WINAPI waveOutReset(HWAVEOUT);
MMRESULT WINAPI waveOutPrepareHeader(HWAVEOUT, LPWAVEHDR, UINT);
MMRESULT WINAPI waveOutUnprepareHeader(HWAVEOUT, LPWAVEHDR, UINT);
MMRESULT WINAPI waveOutWrite(HWAVEOUT, LPWAVEHDR, UINT);
MMRESULT WINAPI waveOutGetNumDevs(void);
UINT WINAPI joyGetNumDevs(void);
DWORD WINAPI timeGetTime(void);
#define MCI_MAKE_TMSF(t, m, s, f) ((DWORD)(((BYTE)(t)) | ((WORD)(m) << 8) | (((DWORD)(BYTE)(s)) << 16) | (((DWORD)(BYTE)(f)) << 24)))
#endif
`,
};
