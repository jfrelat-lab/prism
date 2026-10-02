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
  /* Just enough of the shell's folder API for PuTTY to find %APPDATA% for its random seed. */
  'shlobj.h': `
#ifndef _PRISM_SHLOBJ_H
#define _PRISM_SHLOBJ_H
#include <windows.h>
#define CSIDL_APPDATA        0x001a
#define CSIDL_LOCAL_APPDATA  0x001c
#define CSIDL_PERSONAL       0x0005
#define SHGFP_TYPE_CURRENT   0
#define SHGFP_TYPE_DEFAULT   1
HRESULT WINAPI SHGetFolderPathA(HWND hwnd, int folder, HANDLE token, DWORD flags, LPSTR path);
#endif
`,

  /*
   * tchar.h: the TCHAR family, which resolves to the narrow one because UNICODE is not defined here.
   * PuTTY uses only a handful and always through these names, which is the point of the header.
   */
  'tchar.h': `
#ifndef _PRISM_TCHAR_H
#define _PRISM_TCHAR_H
#include <string.h>
#define _tcslen   strlen
#define _tcscpy   strcpy
#define _tcscmp   strcmp
#define _tcschr   strchr
#define _tcsrchr  strrchr
#define _tcscat   strcat
#define _T(x)     x
#define TEXT(x)   x
#endif
`,

  /* The shell, at the depth PuTTY uses it: opening its own web page from the About box. */
  'shellapi.h': `
#ifndef _PRISM_SHELLAPI_H
#define _PRISM_SHELLAPI_H
#include <windows.h>
HINSTANCE WINAPI ShellExecute(HWND hwnd, LPCTSTR verb, LPCTSTR file, LPCTSTR params,
                              LPCTSTR dir, INT show);
#endif
`,

  /* HTML Help, which PuTTY opens for its manual and otherwise leaves alone. */
  'htmlhelp.h': `
#ifndef _PRISM_HTMLHELP_H
#define _PRISM_HTMLHELP_H
#include <windows.h>
#define HH_DISPLAY_TOPIC  0x0000
#define HH_HELP_CONTEXT   0x000F
#define HH_CLOSE_ALL      0x0012
HWND WINAPI HtmlHelpA(HWND caller, LPCSTR file, UINT cmd, DWORD_PTR data);
#endif
`,

  /*
   * Winsock, at the depth PuTTY's event loop reaches. Not a network stack -- the point here is the
   * TYPES: a SOCKET is a handle, WSANETWORKEVENTS is what WSAEnumNetworkEvents fills in, and the
   * FD_ bits are the event mask. Anything that actually moves bytes stays an undefined symbol and
   * is listed as one.
   */
  'winsock2.h': `
#ifndef _PRISM_WINSOCK2_H
#define _PRISM_WINSOCK2_H
#include <windows.h>
/*
 * Winsock 2, declared and not implemented. PRISM has no network stack, and PuTTY without one is
 * still PuTTY: it opens its window, draws its terminal and reports that the connection failed --
 * which is a real code path, not a stub, and is why this header exists rather than the target
 * simply not linking network.c.
 *
 * The FAR that appears through this API is the 16-bit memory model's far pointer, meaningless on a
 * flat target and empty here, exactly as it is in the real headers.
 */
#define FAR
#define PASCAL_FAR
typedef unsigned char u_char;
typedef unsigned short u_short;
typedef unsigned int u_int;
typedef unsigned long u_long;
typedef UINT_PTR SOCKET;
#define INVALID_SOCKET  ((SOCKET)~0)
#define SOCKET_ERROR    (-1)

/*
 * NO fd_set HERE, and that is the decision rather than an omission.
 *
 * This header used to declare Winsock's shape (fd_count, fd_array) beside the POSIX one PRISM
 * already has in headers.js (fds_bits), so a Win32 unit saw whichever include came first and my
 * FD_ZERO wrote through the wrong member. What settles it is that net_wins.c NEVER TOUCHES A
 * MEMBER: it calls FD_ZERO and FD_SET and hands the set to select. A program that only ever uses
 * the macros cannot tell the two apart, so there is one fd_set in PRISM and it is the POSIX one.
 *
 * Which this header OBTAINS rather than redefines: select() below takes fd_set *, so the type has to
 * be in scope, and sys/types.h is where PRISM keeps it -- the same place Solaris and Linux do.
 */
#include <sys/types.h>
#ifndef _PRISM_TIMEVAL
#define _PRISM_TIMEVAL
struct timeval { long tv_sec, tv_usec; };
#endif

/* ---- addresses */
#define AF_UNSPEC   0
#define AF_UNIX     1
#define AF_INET     2
#define AF_INET6    23
#define SOCK_STREAM 1
#define SOCK_DGRAM  2
#define IPPROTO_IP  0
#define IPPROTO_TCP 6
#define IPPROTO_UDP 17
#define SOMAXCONN   0x7fffffff
#define INADDR_ANY  ((u_long)0)
#define INADDR_LOOPBACK ((u_long)0x7f000001)
#define INADDR_NONE ((u_long)0xffffffff)
/* The all-zeros address, spelled as the SDK spells it: an initialiser, not an object. */
#define IN6ADDR_ANY_INIT { { { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 } } }
#define IN6ADDR_LOOPBACK_INIT { { { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 } } }
#define INET_ADDRSTRLEN  16
#define INET6_ADDRSTRLEN 46
#define NI_MAXHOST       1025
#define NI_MAXSERV       32
#define NI_NUMERICHOST   0x02
#define NI_NUMERICSERV   0x08
#define AI_PASSIVE       0x01
#define AI_CANONNAME     0x02
#define AI_NUMERICHOST   0x04

struct in_addr { union { struct { u_char s_b1, s_b2, s_b3, s_b4; } S_un_b; u_long S_addr; } S_un; };
#define s_addr S_un.S_addr
struct in6_addr { union { u_char Byte[16]; u_short Word[8]; } u; };
struct sockaddr { u_short sa_family; char sa_data[14]; };
struct sockaddr_in { short sin_family; u_short sin_port; struct in_addr sin_addr; char sin_zero[8]; };
struct sockaddr_in6 { short sin6_family; u_short sin6_port; u_long sin6_flowinfo;
                      struct in6_addr sin6_addr; u_long sin6_scope_id; };
struct sockaddr_un { u_short sun_family; char sun_path[108]; };
struct sockaddr_storage { short ss_family; char __pad[126]; };
typedef struct sockaddr SOCKADDR, *LPSOCKADDR;
typedef struct sockaddr_in SOCKADDR_IN;
typedef struct sockaddr_un SOCKADDR_UN;
typedef struct sockaddr_in6 SOCKADDR_IN6;
typedef struct in_addr IN_ADDR;
typedef struct in6_addr IN6_ADDR;
#define IN6_IS_ADDR_LOOPBACK(a) \\
    ((a)->u.Word[0] == 0 && (a)->u.Word[1] == 0 && (a)->u.Word[2] == 0 && (a)->u.Word[3] == 0 && \\
     (a)->u.Word[4] == 0 && (a)->u.Word[5] == 0 && (a)->u.Word[6] == 0 && (a)->u.Byte[14] == 0 && \\
     (a)->u.Byte[15] == 1)

struct hostent { char *h_name, **h_aliases; short h_addrtype, h_length; char **h_addr_list; };
#define h_addr h_addr_list[0]
struct servent { char *s_name, **s_aliases; short s_port; char *s_proto; };
struct addrinfo {
    int ai_flags, ai_family, ai_socktype, ai_protocol;
    size_t ai_addrlen;
    char *ai_canonname;
    struct sockaddr *ai_addr;
    struct addrinfo *ai_next;
};
typedef struct addrinfo ADDRINFO, *LPADDRINFO;
typedef int socklen_t;
/* SIO_GET_INTERFACE_LIST's element: the local addresses, which network.c uses to spot a local peer. */
typedef struct _INTERFACE_INFO {
    u_long iiFlags;
    union { struct sockaddr Address; struct sockaddr_in AddressIn; } iiAddress, iiBroadcastAddress, iiNetmask;
} INTERFACE_INFO, *LPINTERFACE_INFO;
#define SIO_GET_INTERFACE_LIST 0x4004747F
#define IFF_UP          0x00000001
#define IFF_LOOPBACK    0x00000004
int WINAPI getnameinfo(const struct sockaddr *sa, socklen_t salen, char *host, DWORD hostlen,
                       char *serv, DWORD servlen, int flags);
/* WSAPROTOCOL_INFO is opaque to PuTTY: it only ever passes NULL. */
typedef struct _WSAPROTOCOL_INFOA { BYTE opaque[512]; } WSAPROTOCOL_INFOA, WSAPROTOCOL_INFO, *LPWSAPROTOCOL_INFO;
typedef OVERLAPPED WSAOVERLAPPED, *LPWSAOVERLAPPED;
typedef void (CALLBACK *LPWSAOVERLAPPED_COMPLETION_ROUTINE)(DWORD, DWORD, LPWSAOVERLAPPED, DWORD);

/* ---- options and shutdown */
#define SOL_SOCKET      0xffff
#define SO_REUSEADDR    0x0004
#define SO_BROADCAST            0x0020
#define SO_KEEPALIVE    0x0008
#define SO_OOBINLINE    0x0100
#define SO_EXCLUSIVEADDRUSE ((int)(~0x0004))
#define TCP_NODELAY     0x0001
#define SD_RECEIVE      0
#define SD_SEND         1
#define SD_BOTH         2
#define MSG_OOB         0x1
#define MSG_PEEK        0x2
#define FIONBIO         0x8004667e
#define FIONREAD        0x4004667f
#define SIOCATMARK      0x40047307

/* ---- the calls */
SOCKET WINAPI socket(int af, int type, int protocol);
int WINAPI closesocket(SOCKET s);
int WINAPI bind(SOCKET s, const struct sockaddr *a, int len);
int WINAPI listen(SOCKET s, int backlog);
SOCKET WINAPI accept(SOCKET s, struct sockaddr *a, int *len);
int WINAPI connect(SOCKET s, const struct sockaddr *a, int len);
int WINAPI recv(SOCKET s, char *buf, int len, int flags);
int WINAPI send(SOCKET s, const char *buf, int len, int flags);
int WINAPI shutdown(SOCKET s, int how);
int WINAPI select(int n, fd_set *r, fd_set *w, fd_set *e, const struct timeval *t);
int WINAPI ioctlsocket(SOCKET s, long cmd, u_long *arg);
int WINAPI getsockopt(SOCKET s, int level, int name, char *val, int *len);
int WINAPI setsockopt(SOCKET s, int level, int name, const char *val, int len);
int WINAPI getsockname(SOCKET s, struct sockaddr *a, int *len);
int WINAPI getpeername(SOCKET s, struct sockaddr *a, int *len);
struct hostent *WINAPI gethostbyname(const char *name);
struct servent *WINAPI getservbyname(const char *name, const char *proto);
int WINAPI getaddrinfo(const char *node, const char *service,
                       const struct addrinfo *hints, struct addrinfo **out);
void WINAPI freeaddrinfo(struct addrinfo *ai);
char *WINAPI inet_ntoa(struct in_addr a);
u_long WINAPI inet_addr(const char *s);
u_short WINAPI htons(u_short v);
u_short WINAPI ntohs(u_short v);
u_long WINAPI htonl(u_long v);
u_long WINAPI ntohl(u_long v);

typedef void *WSAEVENT;
#define FD_MAX_EVENTS   10
typedef struct _WSANETWORKEVENTS { long lNetworkEvents; int iErrorCode[FD_MAX_EVENTS]; }
    WSANETWORKEVENTS, *LPWSANETWORKEVENTS;
typedef struct WSAData {
    WORD wVersion, wHighVersion;
    char szDescription[257], szSystemStatus[129];
    unsigned short iMaxSockets, iMaxUdpDg;
    char *lpVendorInfo;
} WSADATA, *LPWSADATA;
#define MAKEWORD(a, b) ((WORD)(((BYTE)(a)) | (((WORD)((BYTE)(b))) << 8)))
int WINAPI WSAStartup(WORD version, LPWSADATA data);
int WINAPI WSACleanup(void);
int WINAPI WSAGetLastError(void);
void WINAPI WSASetLastError(int e);
int WINAPI WSAEnumNetworkEvents(SOCKET s, WSAEVENT h, LPWSANETWORKEVENTS out);
int WINAPI WSAEventSelect(SOCKET s, WSAEVENT h, long events);
int WINAPI WSAAsyncSelect(SOCKET s, HWND hwnd, u_int msg, long events);
int WINAPI WSAIoctl(SOCKET s, DWORD code, LPVOID inb, DWORD incb, LPVOID outb, DWORD outcb,
                    LPDWORD ret, LPVOID overlapped, LPVOID completion);
int WINAPI WSAAddressToStringA(LPSOCKADDR a, DWORD alen, LPVOID info, char *buf, LPDWORD buflen);

#define FD_READ_BIT     0
#define FD_WRITE_BIT    1
#define FD_OOB_BIT      2
#define FD_ACCEPT_BIT   3
#define FD_CONNECT_BIT  4
#define FD_CLOSE_BIT    5
#define FD_READ         (1 << FD_READ_BIT)
#define FD_WRITE        (1 << FD_WRITE_BIT)
#define FD_OOB          (1 << FD_OOB_BIT)
#define FD_ACCEPT       (1 << FD_ACCEPT_BIT)
#define FD_CONNECT      (1 << FD_CONNECT_BIT)
#define FD_CLOSE        (1 << FD_CLOSE_BIT)
#define WSAMAKESELECTREPLY(event, error) ((WPARAM)(((WORD)(event)) | (((DWORD)(error)) << 16)))
#define WSAGETSELECTEVENT(l)  ((int)LOWORD(l))
#define WSAGETSELECTERROR(l)  ((int)HIWORD(l))

/*
 * IPX, which net_wins.c names in a branch it does not take here: NET_OpenIPX is compiled but the
 * engine only opens UDP. Declared so the file parses; a program that asked for an IPX socket would
 * be refused by the shim, which is the honest outcome for a protocol no browser has.
 */
#define AF_IPX                  6
#define PF_IPX                  AF_IPX
#define PF_INET                 AF_INET
#define NSPROTO_IPX             1000
#define INADDR_BROADCAST        0xffffffff
/*
 * sockaddr_ipx by the members net_wins.c reads and writes. Declaring the constants alone was not
 * enough and the compiler said so twice: NetadrToSockadr assigns sa_family and SockadrToNetadr
 * copies sa_netnum, so an incomplete type stops both from being emitted.
 */
struct sockaddr_ipx {
    short         sa_family;
    unsigned char sa_netnum[4];
    unsigned char sa_nodenum[6];
    unsigned short sa_socket;
};
#define WSABASEERR              10000
#define WSAEINTR                (WSABASEERR+4)
#define WSAEACCES               (WSABASEERR+13)
#define WSAEFAULT               (WSABASEERR+14)
#define WSAEINVAL               (WSABASEERR+22)
#define WSAEMFILE               (WSABASEERR+24)
#define WSAEWOULDBLOCK          (WSABASEERR+35)
#define WSAEINPROGRESS          (WSABASEERR+36)
#define WSAEALREADY             (WSABASEERR+37)
#define WSAENOTSOCK             (WSABASEERR+38)
#define WSAEDESTADDRREQ         (WSABASEERR+39)
#define WSAEMSGSIZE             (WSABASEERR+40)
#define WSAEPROTOTYPE           (WSABASEERR+41)
#define WSAENOPROTOOPT          (WSABASEERR+42)
#define WSAEPROTONOSUPPORT      (WSABASEERR+43)
#define WSAESOCKTNOSUPPORT      (WSABASEERR+44)
#define WSAEOPNOTSUPP           (WSABASEERR+45)
#define WSAEPFNOSUPPORT         (WSABASEERR+46)
#define WSAEAFNOSUPPORT         (WSABASEERR+47)
#define WSAEADDRINUSE           (WSABASEERR+48)
#define WSAEADDRNOTAVAIL        (WSABASEERR+49)
#define WSAENETDOWN             (WSABASEERR+50)
#define WSAENETUNREACH          (WSABASEERR+51)
#define WSAENETRESET            (WSABASEERR+52)
#define WSAECONNABORTED         (WSABASEERR+53)
#define WSAECONNRESET           (WSABASEERR+54)
#define WSAENOBUFS              (WSABASEERR+55)
#define WSAEISCONN              (WSABASEERR+56)
#define WSAENOTCONN             (WSABASEERR+57)
#define WSAESHUTDOWN            (WSABASEERR+58)
#define WSAETIMEDOUT            (WSABASEERR+60)
#define WSAECONNREFUSED         (WSABASEERR+61)
#define WSAEHOSTDOWN            (WSABASEERR+64)
/*
 * The seven Quake II's net_wins.c switches on that were absent. Same scheme as every line above --
 * WSABASEERR plus the BSD errno number, which is how Winsock numbered these -- and the last three
 * are its own startup errors rather than a Berkeley code. They must be integer CONSTANTS because
 * NET_ErrorString uses them as case labels; an undeclared one reads as "not a constant expression",
 * which is how these were found.
 */
#define WSAEBADF                (WSABASEERR+9)
#define WSAETOOMANYREFS         (WSABASEERR+59)
#define WSAELOOP                (WSABASEERR+62)
#define WSAENAMETOOLONG         (WSABASEERR+63)
#define WSASYSNOTREADY          (WSABASEERR+91)
#define WSAVERNOTSUPPORTED      (WSABASEERR+92)
#define WSANOTINITIALISED       (WSABASEERR+93)
#define WSAEHOSTUNREACH         (WSABASEERR+65)
#define WSAEPROCLIM             (WSABASEERR+67)
#define WSAEDISCON              (WSABASEERR+101)
#define WSAHOST_NOT_FOUND       (WSABASEERR+1001)
#define WSATRY_AGAIN            (WSABASEERR+1002)
/* The rest of the resolver family, which net_wins.c's NET_ErrorString also switches on. */
#define WSANO_RECOVERY          (WSABASEERR+1003)
#define WSANO_DATA              (WSABASEERR+1004)
#endif
`,
  /*
   * winspool, at the depth PuTTY's printing.c reaches: it enumerates printers at level 4 or 5 and
   * spools raw bytes. Every entry point is loaded from winspool.drv by name, so the header supplies
   * the structures and nothing else.
   */
  'winspool.h': `
#ifndef _PRISM_WINSPOOL_H
#define _PRISM_WINSPOOL_H
#include <windows.h>
typedef struct _PRINTER_INFO_4A {
    LPSTR pPrinterName, pServerName;
    DWORD Attributes;
} PRINTER_INFO_4A, PRINTER_INFO_4, *LPPRINTER_INFO_4;
typedef struct _PRINTER_INFO_5A {
    LPSTR pPrinterName, pPortName;
    DWORD Attributes, DeviceNotSelectedTimeout, TransmissionRetryTimeout;
} PRINTER_INFO_5A, PRINTER_INFO_5, *LPPRINTER_INFO_5;
typedef struct _PRINTER_DEFAULTSA {
    LPSTR pDatatype;
    void *pDevMode;
    DWORD DesiredAccess;   /* ACCESS_MASK, which is a DWORD */
} PRINTER_DEFAULTSA, PRINTER_DEFAULTS, *LPPRINTER_DEFAULTS;
typedef struct _DOC_INFO_1A {
    LPSTR pDocName, pOutputFile, pDatatype;
} DOC_INFO_1A, DOC_INFO_1, *LPDOC_INFO_1;
#define PRINTER_ENUM_LOCAL       0x00000002
#define PRINTER_ENUM_CONNECTIONS 0x00000004
#endif
`,

  /*
   * The common controls, as far as PuTTY's configuration box reaches into them: a tree view for the
   * category list, and the NMHDR every WM_NOTIFY carries. The TreeView_* names are MACROS over
   * SendMessage in the real header, which is why they need no entry points of their own -- and why
   * getting the message numbers right matters more here than anywhere else in this file.
   */
  'commctrl.h': `
#ifndef _PRISM_COMMCTRL_H
#define _PRISM_COMMCTRL_H
#include <windows.h>

void WINAPI InitCommonControls(void);
#define WC_TREEVIEW "SysTreeView32"
#define PROGRESS_CLASS "msctls_progress32"
#define PBM_SETRANGE    (WM_USER + 1)
#define PBM_SETPOS      (WM_USER + 2)
#define PBM_SETRANGE32  (WM_USER + 6)
#define WC_TABCONTROL "SysTabControl32"

typedef struct _TREEITEM *HTREEITEM;

/* The drag list box: a list box that reports drags through a registered message. */
typedef struct tagDRAGLISTINFO { UINT uNotification; HWND hWnd; POINT ptCursor; } DRAGLISTINFO, *LPDRAGLISTINFO;
#define DL_BEGINDRAG    (WM_USER + 133)
#define DL_DRAGGING     (WM_USER + 134)
#define DL_DROPPED      (WM_USER + 135)
#define DL_CANCELDRAG   (WM_USER + 136)
#define DL_CURSORSET    0
#define DL_STOPCURSOR   1
#define DL_COPYCURSOR   2
#define DL_MOVECURSOR   3
#define DRAGLISTMSGSTRING "commctrl_DragListMsg"
BOOL WINAPI MakeDragList(HWND hLB);
void WINAPI DrawInsert(HWND handParent, HWND hLB, int nItem);
int WINAPI LBItemFromPt(HWND hLB, POINT pt, BOOL bAutoScroll);
typedef struct tagNMHDR { HWND hwndFrom; UINT_PTR idFrom; UINT code; } NMHDR, *LPNMHDR;

#define TVIF_TEXT       0x0001
#define TVIF_IMAGE      0x0002
#define TVIF_PARAM      0x0004
#define TVIF_STATE      0x0008
#define TVIF_HANDLE     0x0010
#define TVI_ROOT        ((HTREEITEM)(ULONG_PTR)-0x10000)
#define TVI_FIRST       ((HTREEITEM)(ULONG_PTR)-0x0FFFF)
#define TVI_LAST        ((HTREEITEM)(ULONG_PTR)-0x0FFFE)
#define TVE_COLLAPSE    0x0001
#define TVE_EXPAND      0x0002
#define TVS_HASBUTTONS      0x0001
#define TVS_HASLINES        0x0002
#define TVS_LINESATROOT     0x0004
#define TVS_DISABLEDRAGDROP 0x0010
#define TVS_SHOWSELALWAYS   0x0020

typedef struct tagTVITEMA {
    UINT mask;
    HTREEITEM hItem;
    UINT state, stateMask;
    LPSTR pszText;
    int cchTextMax, iImage, iSelectedImage, cChildren;
    LPARAM lParam;
} TVITEMA, TVITEM, TV_ITEM, *LPTVITEM;
typedef struct tagTVINSERTSTRUCTA {
    HTREEITEM hParent, hInsertAfter;
    TVITEMA item;
} TVINSERTSTRUCTA, TVINSERTSTRUCT, TV_INSERTSTRUCT, *LPTVINSERTSTRUCT;

/* The SDK spells these as SendMessage macros, and so does this: same numbers, same behaviour. */
#define TV_FIRST                0x1100
#define TVM_INSERTITEMA         (TV_FIRST + 0)
#define TVM_EXPAND              (TV_FIRST + 2)
#define TVM_GETITEMA            (TV_FIRST + 12)
#define TVM_SELECTITEM          (TV_FIRST + 11)
#define TVGN_CARET              0x0009
#define TreeView_InsertItem(h, i) \
    ((HTREEITEM)SendMessage((h), TVM_INSERTITEMA, 0, (LPARAM)(const TVINSERTSTRUCT *)(i)))
#define TreeView_Expand(h, it, c) \
    ((BOOL)SendMessage((h), TVM_EXPAND, (WPARAM)(c), (LPARAM)(HTREEITEM)(it)))
#define TreeView_GetItem(h, i) \
    ((BOOL)SendMessage((h), TVM_GETITEMA, 0, (LPARAM)(TVITEM *)(i)))
#define TreeView_SelectItem(h, it) \
    ((BOOL)SendMessage((h), TVM_SELECTITEM, TVGN_CARET, (LPARAM)(HTREEITEM)(it)))
#define TreeView_GetSelection(h) \
    ((HTREEITEM)SendMessage((h), TV_FIRST + 10, TVGN_CARET, 0))
#endif
`,

  /*
   * advapi32's ACL and token types. PuTTY uses these to build the security descriptor for its named
   * pipes, and reaches most of the entry points through GetProcAddress -- so what it needs from here
   * are the TYPES and the constants. The few it calls directly are declared and left undefined, the
   * same arrangement Quake has with MGL: an undefined symbol the linker reports, not a parse error.
   *
   * The struct layouts are the SDK's, field for field. Nothing here implements them, so nothing would
   * currently notice if they were wrong -- which is exactly why they should not be invented.
   */
  'aclapi.h': `
#ifndef _PRISM_ACLAPI_H
#define _PRISM_ACLAPI_H
#include <windows.h>

typedef PVOID PSID;
typedef PVOID PSECURITY_DESCRIPTOR;
typedef DWORD SECURITY_INFORMATION;
typedef struct _ACL { BYTE AclRevision, Sbz1; WORD AclSize; WORD AceCount, Sbz2; } ACL, *PACL;
typedef struct _SID_IDENTIFIER_AUTHORITY { BYTE Value[6]; } SID_IDENTIFIER_AUTHORITY;
typedef struct _SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } SID_AND_ATTRIBUTES;
typedef struct _TOKEN_USER { SID_AND_ATTRIBUTES User; } TOKEN_USER;

typedef enum { SE_UNKNOWN_OBJECT_TYPE = 0, SE_FILE_OBJECT, SE_SERVICE, SE_PRINTER,
               SE_REGISTRY_KEY, SE_LMSHARE, SE_KERNEL_OBJECT, SE_WINDOW_OBJECT,
               SE_DS_OBJECT, SE_DS_OBJECT_ALL, SE_PROVIDER_DEFINED_OBJECT,
               SE_WMIGUID_OBJECT, SE_REGISTRY_WOW64_32KEY } SE_OBJECT_TYPE;

typedef enum { TokenUser = 1, TokenGroups, TokenPrivileges, TokenOwner, TokenPrimaryGroup,
               TokenDefaultDacl, TokenSource, TokenType, TokenImpersonationLevel,
               TokenStatistics, TokenRestrictedSids, TokenSessionId } TOKEN_INFORMATION_CLASS;

typedef enum { NOT_USED_ACCESS = 0, GRANT_ACCESS, SET_ACCESS, DENY_ACCESS, REVOKE_ACCESS,
               SET_AUDIT_SUCCESS, SET_AUDIT_FAILURE } ACCESS_MODE;
typedef enum { TRUSTEE_IS_SID = 0, TRUSTEE_IS_NAME, TRUSTEE_BAD_FORM,
               TRUSTEE_IS_OBJECTS_AND_SID, TRUSTEE_IS_OBJECTS_AND_NAME } TRUSTEE_FORM;
typedef enum { TRUSTEE_IS_UNKNOWN = 0, TRUSTEE_IS_USER, TRUSTEE_IS_GROUP, TRUSTEE_IS_DOMAIN,
               TRUSTEE_IS_ALIAS, TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_IS_DELETED,
               TRUSTEE_IS_INVALID, TRUSTEE_IS_COMPUTER } TRUSTEE_TYPE;
typedef enum { NO_MULTIPLE_TRUSTEE = 0, TRUSTEE_IS_IMPERSONATE } MULTIPLE_TRUSTEE_OPERATION;

typedef struct _TRUSTEE_A {
    struct _TRUSTEE_A *pMultipleTrustee;
    MULTIPLE_TRUSTEE_OPERATION MultipleTrusteeOperation;
    TRUSTEE_FORM TrusteeForm;
    TRUSTEE_TYPE TrusteeType;
    LPSTR ptstrName;
} TRUSTEE_A, TRUSTEE;
typedef struct _EXPLICIT_ACCESS_A {
    DWORD grfAccessPermissions;
    ACCESS_MODE grfAccessMode;
    DWORD grfInheritance;
    TRUSTEE_A Trustee;
} EXPLICIT_ACCESS_A, EXPLICIT_ACCESS, *PEXPLICIT_ACCESS;

#define SECURITY_DESCRIPTOR_REVISION   1
#define SECURITY_DESCRIPTOR_MIN_LENGTH 20
#define OWNER_SECURITY_INFORMATION     0x00000001
#define DACL_SECURITY_INFORMATION      0x00000004
#define NO_INHERITANCE                 0x0
#define SUB_CONTAINERS_AND_OBJECTS_INHERIT 0x3
#define TOKEN_QUERY                    0x0008
#define MAXIMUM_ALLOWED                0x02000000
#define WRITE_DAC                      0x00040000
#define WRITE_OWNER                    0x00080000
#define PROCESS_CREATE_PROCESS         0x0080
#define PROCESS_CREATE_THREAD          0x0002
#define PROCESS_DUP_HANDLE             0x0040
#define PROCESS_SET_INFORMATION        0x0200
#define PROCESS_SET_QUOTA              0x0100
#define PROCESS_SUSPEND_RESUME         0x0800
#define PROCESS_VM_OPERATION           0x0008
#define PROCESS_VM_READ                0x0010
#define PROCESS_VM_WRITE               0x0020
#define SECURITY_NT_AUTHORITY          { 0, 0, 0, 0, 0, 5 }
#define SECURITY_WORLD_SID_AUTHORITY   { 0, 0, 0, 0, 0, 1 }
#define SECURITY_WORLD_RID             0x00000000
#define SECURITY_NETWORK_RID           0x00000002
#define LPTR                           0x0040

/* Called directly rather than through GetProcAddress; undefined until something implements them. */
HANDLE WINAPI LocalAlloc(UINT uFlags, SIZE_T uBytes);
HANDLE WINAPI LocalFree(HANDLE hMem);
HANDLE WINAPI OpenProcess(DWORD access, BOOL inherit, DWORD pid);
DWORD WINAPI GetCurrentProcessId(void);
BOOL WINAPI SetSecurityDescriptorDacl(PSECURITY_DESCRIPTOR sd, BOOL present, PACL dacl, BOOL def);
BOOL WINAPI AllocateAndInitializeSid(SID_IDENTIFIER_AUTHORITY *auth, BYTE count,
                                     DWORD s0, DWORD s1, DWORD s2, DWORD s3,
                                     DWORD s4, DWORD s5, DWORD s6, DWORD s7, PSID *sid);
BOOL WINAPI CopySid(DWORD len, PSID dst, PSID src);
DWORD WINAPI GetLengthSid(PSID sid);
#endif
`,

  /*
   * secur32's name lookups. PuTTY reaches GetUserNameExA through GetProcAddress, so what it needs
   * from this header is the ENUM -- the entry point itself is resolved at run time and never linked.
   */
  'security.h': `
#ifndef _PRISM_SECURITY_H
#define _PRISM_SECURITY_H
#include <windows.h>
typedef enum {
    NameUnknown = 0, NameFullyQualifiedDN = 1, NameSamCompatible = 2, NameDisplay = 3,
    NameUniqueId = 6, NameCanonical = 7, NameUserPrincipal = 8, NameCanonicalEx = 9,
    NameServicePrincipal = 10, NameDnsDomain = 12
} EXTENDED_NAME_FORMAT;
#endif
`,

  'windows.h': `
#ifndef _PRISM_WINDOWS_H
#define _PRISM_WINDOWS_H
/* For wchar_t, which LPWSTR is made of. A program that includes only <windows.h> must still get it. */
#include <stddef.h>

/* ---- calling conventions. On a flat 32-bit target these are all the same call. */
#define WINAPI
#define APIENTRY
#define CALLBACK
#define PASCAL
#define WINAPIV
#define STDMETHODCALLTYPE
#define STDAPICALLTYPE
#define __stdcall
/* The SINGLE-underscore spelling, which MSVC has always accepted alongside the reserved one, and
   which Quake II's conproc.c uses in "unsigned _stdcall RequestProc (void *arg);". */
#define _stdcall
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
/* The wide pair. wchar_t is 2 bytes here because _WIN32 is defined; see src/env/headers.js. */
typedef wchar_t *LPWSTR;
typedef const wchar_t *LPCWSTR;
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
/* The signed/unsigned pointer-width pair. Win32 dialog procedures return INT_PTR. */
typedef int INT_PTR;
typedef unsigned char BOOLEAN;
typedef HANDLE HKL;              /* a keyboard layout handle */
typedef WORD *LPWORD;
typedef float FLOAT;
typedef const unsigned short *PCWSTR;
/* Empty on purpose: an import declaration is a linkage hint, and PRISM has one linkage. */
#define DECLSPEC_IMPORT
typedef unsigned int UINT_PTR;
typedef long SSIZE_T;
typedef unsigned long SIZE_T;
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
} WNDCLASS, WNDCLASSA, *LPWNDCLASS;
/* The wide twin. PuTTY registers BOTH and picks by whether the platform has the W entry points. */
typedef struct tagWNDCLASSW {
    UINT style; WNDPROC lpfnWndProc; int cbClsExtra, cbWndExtra;
    HINSTANCE hInstance; HICON hIcon; HCURSOR hCursor; HBRUSH hbrBackground;
    LPCWSTR lpszMenuName, lpszClassName;
} WNDCLASSW, *LPWNDCLASSW;
ATOM WINAPI RegisterClassA(const WNDCLASSA *c);
ATOM WINAPI RegisterClassW(const WNDCLASSW *c);
LRESULT WINAPI DefWindowProcA(HWND h, UINT m, WPARAM w, LPARAM l);
LRESULT WINAPI DefWindowProcW(HWND h, UINT m, WPARAM w, LPARAM l);
LRESULT WINAPI DispatchMessageA(const MSG *m);
LRESULT WINAPI DispatchMessageW(const MSG *m);
BOOL WINAPI GetMessageW(MSG *m, HWND h, UINT lo, UINT hi);
BOOL WINAPI PeekMessageW(MSG *m, HWND h, UINT lo, UINT hi, UINT remove);
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
#define SW_SHOW 5
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
/*
 * The ...LongPtr names. On Win64 these are separate entry points taking LONG_PTR; on 32-bit Windows
 * the real headers define them as macros onto the plain ...Long forms, because the two are the same
 * width there. PRISM's ABI is 32-bit, so this is what the platform actually does, not a shortcut.
 */
#define GetWindowLongPtr    GetWindowLong
#define SetWindowLongPtr    SetWindowLong
#define GetClassLongPtr     GetClassLong
#define GWLP_USERDATA       GWL_USERDATA
#define GWLP_WNDPROC        GWL_WNDPROC
#define GWLP_HINSTANCE      GWL_HINSTANCE
#define DWLP_MSGRESULT      0
#define CLEARTYPE_QUALITY   5
#define MAXIMUM_WAIT_OBJECTS 64
#define WAIT_OBJECT_0       0
#define WAIT_ABANDONED_0    0x00000080
#define WAIT_TIMEOUT        258
#define WAIT_FAILED         0xFFFFFFFF
#define INFINITE            0xFFFFFFFF
typedef void *WSAEVENT;

typedef struct _FILETIME { DWORD dwLowDateTime, dwHighDateTime; } FILETIME, *LPFILETIME;

/* ---- file attributes, as GetFileAttributesEx reports them. */
typedef enum { GetFileExInfoStandard = 0, GetFileExMaxInfoLevel } GET_FILEEX_INFO_LEVELS;
typedef struct _WIN32_FILE_ATTRIBUTE_DATA {
    DWORD dwFileAttributes;
    FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
    DWORD nFileSizeHigh, nFileSizeLow;
} WIN32_FILE_ATTRIBUTE_DATA;
BOOL WINAPI GetFileAttributesEx(LPCTSTR name, GET_FILEEX_INFO_LEVELS level, void *info);
#define FILE_ATTRIBUTE_READONLY   0x00000001
#define FILE_ATTRIBUTE_DIRECTORY  0x00000010
#define FILE_ATTRIBUTE_NORMAL     0x00000080
#define INVALID_FILE_ATTRIBUTES   0xFFFFFFFF
#define MAX_PATH 260
typedef struct _WIN32_FIND_DATAW {
    DWORD dwFileAttributes;
    FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
    DWORD nFileSizeHigh, nFileSizeLow;
    DWORD dwReserved0, dwReserved1;
    wchar_t cFileName[MAX_PATH];
    wchar_t cAlternateFileName[14];
} WIN32_FIND_DATAW;
typedef struct _WIN32_FIND_DATAA {
    DWORD dwFileAttributes;
    FILETIME ftCreationTime, ftLastAccessTime, ftLastWriteTime;
    DWORD nFileSizeHigh, nFileSizeLow;
    DWORD dwReserved0, dwReserved1;
    char cFileName[MAX_PATH];
    char cAlternateFileName[14];
} WIN32_FIND_DATAA, WIN32_FIND_DATA;
HANDLE WINAPI FindFirstFileW(LPCWSTR name, WIN32_FIND_DATAW *out);
HANDLE WINAPI FindFirstFileA(LPCSTR name, WIN32_FIND_DATAA *out);
BOOL WINAPI FindClose(HANDLE h);

/* Owner draw: what WM_DRAWITEM's lParam points at. */
typedef struct tagDRAWITEMSTRUCT {
    UINT CtlType, CtlID, itemID, itemAction, itemState;
    HWND hwndItem;
    HDC hDC;
    RECT rcItem;
    ULONG_PTR itemData;
} DRAWITEMSTRUCT, *LPDRAWITEMSTRUCT;
#define ODT_BUTTON      4
#define ODT_STATIC      5
#define ODS_SELECTED    0x0001
#define ODS_FOCUS       0x0010
#define MM_TEXT         1
int WINAPI SetMapMode(HDC dc, int mode);
BOOL WINAPI GetTextExtentPoint32(HDC dc, LPCTSTR s, int n, SIZE *sz);
BOOL WINAPI GetTextExtentPoint32W(HDC dc, LPCWSTR s, int n, SIZE *sz);

typedef struct tagWINDOWPLACEMENT {
    UINT length, flags;
    UINT showCmd;
    POINT ptMinPosition, ptMaxPosition;
    RECT rcNormalPosition;
} WINDOWPLACEMENT;
BOOL WINAPI GetWindowPlacement(HWND hwnd, WINDOWPLACEMENT *wp);
BOOL WINAPI SetWindowPlacement(HWND hwnd, const WINDOWPLACEMENT *wp);

#define CBS_HASSTRINGS      0x0200
#define CBS_OWNERDRAWFIXED  0x0010
#define MB_DEFBUTTON1       0x00000000
#define MB_DEFBUTTON2       0x00000100
#define REG_MULTI_SZ        7
#define REG_OPTION_NON_VOLATILE 0
#define REG_OPTION_VOLATILE     1
#define REG_CREATED_NEW_KEY     1
#define REG_OPENED_EXISTING_KEY 2
#define KEY_QUERY_VALUE     0x0001
#define KEY_SET_VALUE       0x0002
#define KEY_CREATE_SUB_KEY  0x0004
LONG WINAPI RegEnumValue(HKEY key, DWORD i, LPTSTR name, DWORD *namelen, DWORD *res,
                         DWORD *type, BYTE *data, DWORD *datalen);
#define REG_EXPAND_SZ       2
#ifndef MAKELONG
#define MAKELONG(lo, hi) ((LONG)(((WORD)(lo)) | (((DWORD)((WORD)(hi))) << 16)))
#endif
#define MAKELPARAM(lo, hi) ((LPARAM)MAKELONG(lo, hi))
#define MAKEWPARAM(lo, hi) ((WPARAM)MAKELONG(lo, hi))
BOOL WINAPI EndDialog(HWND dlg, INT_PTR result);
HWND WINAPI CreateDialog(HINSTANCE inst, LPCTSTR tmpl, HWND parent, void *proc);
LRESULT WINAPI DefDlgProc(HWND h, UINT m, WPARAM w, LPARAM l);
INT_PTR WINAPI DialogBoxParam(HINSTANCE inst, LPCTSTR tmpl, HWND parent, void *proc, LPARAM init);
#define DLGWINDOWEXTRA  30
BOOL WINAPI MessageBeep(UINT type);
UINT WINAPI GetCaretBlinkTime(void);
HWND WINAPI GetCapture(void);
HWND WINAPI GetParent(HWND hwnd);

/* The dialog-item helpers: every one is a thin wrapper over SendMessage/FindWindow in the SDK, and
 * PuTTY's controls.c uses them rather than the messages directly. */
HWND WINAPI GetDlgItem(HWND dlg, int id);
LRESULT WINAPI SendDlgItemMessage(HWND dlg, int id, UINT msg, WPARAM wp, LPARAM lp);
BOOL WINAPI SetDlgItemText(HWND dlg, int id, LPCSTR text);
BOOL WINAPI SetDlgItemTextW(HWND dlg, int id, LPCWSTR text);
UINT WINAPI GetDlgItemText(HWND dlg, int id, LPSTR buf, int n);
UINT WINAPI IsDlgButtonChecked(HWND dlg, int id);
BOOL WINAPI CheckDlgButton(HWND dlg, int id, UINT check);
BOOL WINAPI CheckRadioButton(HWND dlg, int first, int last, int check);
BOOL WINAPI MapDialogRect(HWND dlg, RECT *r);
UINT_PTR WINAPI SetTimer(HWND hwnd, UINT_PTR id, UINT elapse, void *proc);
BOOL WINAPI KillTimer(HWND hwnd, UINT_PTR id);
LPVOID WINAPI VirtualAlloc(LPVOID addr, SIZE_T size, DWORD type, DWORD protect);
BOOL WINAPI VirtualFree(LPVOID addr, SIZE_T size, DWORD type);
BOOL WINAPI VirtualLock(LPVOID addr, SIZE_T size);
BOOL WINAPI VirtualUnlock(LPVOID addr, SIZE_T size);
#define MEM_COMMIT      0x00001000
#define MEM_RESERVE     0x00002000
#define MEM_RELEASE     0x00008000
#define PAGE_READWRITE  0x04
#define PAGE_NOACCESS   0x01

#define CBS_SIMPLE          0x0001
#define CBS_DROPDOWN        0x0002
#define CBS_DROPDOWNLIST    0x0003
#define CBS_AUTOHSCROLL     0x0040
#define MB_ICONWARNING      0x00000030
#define MB_ICONERROR        0x00000010
#define MB_ICONQUESTION     0x00000020
#define MB_ICONINFORMATION  0x00000040
#define ERROR_INSUFFICIENT_BUFFER 122

/* ---- the dialogue surface: messages, notifications and control styles.
 *
 * PuTTY's configuration box is built from raw Win32 controls -- windows/controls.c speaks to buttons,
 * combo boxes, list boxes and edit fields by message -- so even a terminal test that never opens a
 * window links all of it. Values are the SDK's; nothing here implements the messages, and a wrong
 * number would be invisible until something did.
 */
#define WM_NULL             0x0000
#define WM_SETREDRAW        0x000B
#define WM_SETTEXT          0x000C
#define WM_DRAWITEM         0x002B
#define WM_SETFONT          0x0030
#define WM_GETFONT          0x0031
#define WM_COPYDATA         0x004A
#define WM_NOTIFY           0x004E
#define WM_HELP             0x0053
#define WM_NCHITTEST        0x0084
#define WM_CTLCOLORSTATIC   0x0138
#define WM_APP              0x8000

#define BN_CLICKED          0
#define BN_DOUBLECLICKED    5
#define BN_SETFOCUS         6
#define BN_KILLFOCUS        7
#define BS_PUSHBUTTON       0x00000000
#define BS_DEFPUSHBUTTON    0x00000001
#define BS_AUTOCHECKBOX     0x00000003
#define BS_GROUPBOX         0x00000007
#define BS_AUTORADIOBUTTON  0x00000009
#define BS_NOTIFY           0x00004000

#define CBN_SELCHANGE       1
#define CBN_SETFOCUS        3
#define CBN_KILLFOCUS       4
#define CBN_EDITCHANGE      5
#define CB_ADDSTRING        0x0143
#define CB_DELETESTRING     0x0144
#define CB_GETCURSEL        0x0147
#define CB_GETLBTEXT        0x0148
#define CB_GETLBTEXTLEN     0x0149
#define CB_RESETCONTENT     0x014B
#define CB_SETCURSEL        0x014E
#define CB_GETITEMDATA      0x0150
#define CB_SETITEMDATA      0x0151

#define EN_SETFOCUS         0x0100
#define EN_KILLFOCUS        0x0200
#define EN_CHANGE           0x0300
#define EM_SETSEL           0x00B1
#define EM_GETLINECOUNT     0x00BA
#define ES_MULTILINE        0x0004
#define ES_PASSWORD         0x0020
#define ES_AUTOHSCROLL      0x0080

#define LBN_SELCHANGE       1
#define LBN_DBLCLK          2
#define LBN_SETFOCUS        4
#define LBN_KILLFOCUS       5
#define LB_ERR              (-1)
#define LB_ADDSTRING        0x0180
#define LB_INSERTSTRING     0x0181
#define LB_DELETESTRING     0x0182
#define LB_RESETCONTENT     0x0184
#define LB_SETSEL           0x0185
#define LB_SETCURSEL        0x0186
#define LB_GETSEL           0x0187
#define LB_GETCURSEL        0x0188
#define LB_GETTEXT          0x0189
#define LB_GETTEXTLEN       0x018A
#define LB_GETCOUNT         0x018B
#define LB_SETTOPINDEX      0x0197
#define LB_GETITEMDATA      0x0199
#define LB_SETITEMDATA      0x019A
#define LB_GETSELCOUNT      0x0190
#define LB_GETSELITEMS      0x0191
#define LB_SETTABSTOPS      0x0192

#define SS_LEFTNOWORDWRAP   0x0000000C
#define SS_OWNERDRAW        0x0000000D
#define SS_ETCHEDHORZ       0x00000010

#define WS_TABSTOP          0x00010000
#define WS_GROUP            0x00020000
#define WS_VSCROLL          0x00200000
#define WS_CHILD            0x40000000
#define WS_EX_TOOLWINDOW    0x00000080
#define WS_EX_WINDOWEDGE    0x00000100
#define WS_EX_CLIENTEDGE    0x00000200
#define WS_EX_CONTEXTHELP   0x00000400
#define WS_EX_STATICEDGE    0x00020000

#define CS_DBLCLKS          0x0008
#define CS_SAVEBITS         0x0800
#define CS_BYTEALIGNWINDOW  0x2000
#define GCL_HCURSOR         (-12)

#define IDHELP              9
#define IDCONTINUE          11
#define IMAGE_ICON          1
#define IMAGE_BITMAP        0
#define LR_SHARED           0x8000
#define LR_DEFAULTCOLOR     0x0000
#define DWL_MSGRESULT       0
#define COLOR_BACKGROUND    1
#define COLOR_BTNFACE       15
#define COLOR_INFOTEXT      23
#define COLOR_INFOBK        24
#define SM_CXICON           11
#define SM_CYICON           12
#define SPI_GETNONCLIENTMETRICS 0x0029
#define SW_SHOWMAXIMIZED    3
#define SW_SHOWNOACTIVATE   4

/* The tree-view notification, from commctrl: TVN_FIRST is (0U-400U) and this is two below it. */
#define TVN_SELCHANGED      ((UINT)(0U - 400U - 2U))

/* ---- GDI: fonts, pens, regions and the text metrics a terminal sizes its cells from.
 *
 * PuTTY's window.c keeps an array of HFONT per attribute combination and measures with
 * GetTextMetrics, so a terminal that never opens a window still needs the TYPES.
 */
typedef HANDLE HFONT, HPEN, HRGN;
#define LF_FACESIZE 32
#define PRISM_LOGFONT(CH, TAG) \
    struct TAG { \
        LONG lfHeight, lfWidth, lfEscapement, lfOrientation, lfWeight; \
        BYTE lfItalic, lfUnderline, lfStrikeOut, lfCharSet, lfOutPrecision; \
        BYTE lfClipPrecision, lfQuality, lfPitchAndFamily; \
        CH lfFaceName[LF_FACESIZE]; \
    }
typedef PRISM_LOGFONT(char, tagLOGFONTA) LOGFONTA, LOGFONT, *PLOGFONT, *LPLOGFONT;
typedef PRISM_LOGFONT(wchar_t, tagLOGFONTW) LOGFONTW, *PLOGFONTW, *LPLOGFONTW;
#undef PRISM_LOGFONT

#define PRISM_TEXTMETRIC(CH, TAG) \
    struct TAG { \
        LONG tmHeight, tmAscent, tmDescent, tmInternalLeading, tmExternalLeading; \
        LONG tmAveCharWidth, tmMaxCharWidth, tmWeight, tmOverhang; \
        LONG tmDigitizedAspectX, tmDigitizedAspectY; \
        CH tmFirstChar, tmLastChar, tmDefaultChar, tmBreakChar; \
        BYTE tmItalic, tmUnderlined, tmStruckOut, tmPitchAndFamily, tmCharSet; \
    }
typedef PRISM_TEXTMETRIC(char, tagTEXTMETRICA) TEXTMETRICA, TEXTMETRIC, *LPTEXTMETRIC;
typedef PRISM_TEXTMETRIC(wchar_t, tagTEXTMETRICW) TEXTMETRICW, *LPTEXTMETRICW;
#undef PRISM_TEXTMETRIC

/* Font enumeration and quality, as vid_win.c's cousins in PuTTY ask for them. */
#define ANSI_CHARSET        0
#define DEFAULT_CHARSET     1
#define SYMBOL_CHARSET      2
#define OEM_CHARSET         255
#define FW_DONTCARE         0
#define FW_NORMAL           400
#define FW_BOLD             700
#define OUT_DEFAULT_PRECIS  0
#define CLIP_DEFAULT_PRECIS 0
#define DEFAULT_QUALITY     0
#define NONANTIALIASED_QUALITY 3
#define ANTIALIASED_QUALITY 4
#define DEFAULT_PITCH       0
#define FIXED_PITCH         1
#define VARIABLE_PITCH      2
#define FF_DONTCARE         0
#define TRANSPARENT         1
#define OPAQUE              2
#define ETO_OPAQUE          0x0002
#define ETO_CLIPPED         0x0004
#define ETO_GLYPH_INDEX     0x0010

HGDIOBJ WINAPI SelectObject(HDC dc, HGDIOBJ obj);
HFONT WINAPI CreateFontIndirect(const LOGFONT *lf);
HFONT WINAPI CreateFontIndirectW(const LOGFONTW *lf);
BOOL WINAPI GetTextMetrics(HDC dc, LPTEXTMETRIC tm);
BOOL WINAPI GetTextMetricsW(HDC dc, LPTEXTMETRICW tm);
BOOL WINAPI ExtTextOut(HDC dc, int x, int y, UINT opts, const RECT *r,
                       LPCTSTR str, UINT n, const INT *dx);
BOOL WINAPI ExtTextOutW(HDC dc, int x, int y, UINT opts, const RECT *r,
                        LPCWSTR str, UINT n, const INT *dx);
int WINAPI SetBkMode(HDC dc, int mode);
COLORREF WINAPI SetTextColor(HDC dc, COLORREF c);
COLORREF WINAPI SetBkColor(HDC dc, COLORREF c);

/* SystemParametersInfo(SPI_GETNONCLIENTMETRICS) -- how PuTTY's size tip picks the system font. */
typedef struct tagNONCLIENTMETRICSA {
    UINT cbSize;
    int iBorderWidth, iScrollWidth, iScrollHeight;
    int iCaptionWidth, iCaptionHeight;
    LOGFONTA lfCaptionFont;
    int iSmCaptionWidth, iSmCaptionHeight;
    LOGFONTA lfSmCaptionFont;
    int iMenuWidth, iMenuHeight;
    LOGFONTA lfMenuFont, lfStatusFont, lfMessageFont;
} NONCLIENTMETRICSA, NONCLIENTMETRICS, *LPNONCLIENTMETRICS;
COLORREF WINAPI GetSysColor(int index);
HBRUSH WINAPI CreateSolidBrush(COLORREF c);
int WINAPI FillRect(HDC dc, const RECT *r, HBRUSH b);
int WINAPI DrawText(HDC dc, LPCTSTR s, int n, RECT *r, UINT fmt);
#define DT_LEFT         0x0000
#define DT_CENTER       0x0001
#define DT_TOP          0x0000
#define DT_SINGLELINE   0x0020
#define DT_NOPREFIX     0x0800
#define DT_CALCRECT     0x0400

/* Monitors and per-monitor DPI: window.c resolves all of these dynamically, so only the types matter. */
typedef HANDLE HMONITOR;
typedef RECT *LPRECT;
typedef struct tagMONITORINFO { DWORD cbSize; RECT rcMonitor, rcWork; DWORD dwFlags; } MONITORINFO, *LPMONITORINFO;
#define MONITOR_DEFAULTTONULL       0x00000000
#define MONITOR_DEFAULTTOPRIMARY    0x00000001
#define MONITOR_DEFAULTTONEAREST    0x00000002

#define SIF_DISABLENOSCROLL 0x0008
#define TPM_LEFTALIGN   0x0000
#define TPM_TOPALIGN    0x0000
#define SYSTEM_FONT     13
#define WHITE_PEN       6
#define WMSZ_LEFT       1
#define WMSZ_RIGHT      2
#define WMSZ_TOP        3
#define WMSZ_TOPLEFT    4
#define WMSZ_TOPRIGHT   5
#define WMSZ_BOTTOM     6
#define WMSZ_BOTTOMLEFT 7
#define WMSZ_BOTTOMRIGHT 8
#define STM_SETICON     0x0170
#define GWLP_ID         (-12)
typedef struct _OVERLAPPED {
    ULONG_PTR Internal, InternalHigh;
    DWORD Offset, OffsetHigh;
    HANDLE hEvent;
} OVERLAPPED, *LPOVERLAPPED;
/* The SDK spells these as macros over the C library, and so does this. */
#ifndef ZeroMemory
#define ZeroMemory(d, n)    memset((d), 0, (n))
#define CopyMemory(d, s, n) memcpy((d), (s), (n))
#define MoveMemory(d, s, n) memmove((d), (s), (n))
#define FillMemory(d, n, v) memset((d), (v), (n))
#endif
BOOL WINAPI MoveWindow(HWND h, int x, int y, int w, int ht, BOOL repaint);
BOOL WINAPI ValidateRect(HWND h, const RECT *r);
HWND WINAPI CreateWindow(LPCTSTR cls, LPCTSTR name, DWORD style, int x, int y, int w, int h,
                         HWND parent, HMENU menu, HINSTANCE inst, LPVOID param);
UINT WINAPI GetDlgItemTextW(HWND dlg, int id, LPWSTR buf, int n);
BOOL WINAPI GetUserName(LPSTR buf, LPDWORD n);
UINT WINAPI GetWindowsDirectory(LPTSTR buf, UINT n);
#define HTTRANSPARENT   (-1)
#define ERROR_BROKEN_PIPE 109
#define ERROR_HANDLE_EOF  38
#define ERROR_IO_PENDING  997
#define HTCLIENT        1
#define HTCAPTION       2
#define ERROR_FILE_NOT_FOUND 2
#define ERROR_PATH_NOT_FOUND 3
#define ERROR_ACCESS_DENIED  5
HBRUSH WINAPI GetSysColorBrush(int index);
HPALETTE WINAPI CreatePalette(const LOGPALETTE *p);
HPALETTE WINAPI SelectPalette(HDC dc, HPALETTE p, BOOL bg);
UINT WINAPI RealizePalette(HDC dc);
UINT WINAPI GetSystemDirectory(LPTSTR buf, UINT n);
HMODULE WINAPI LoadLibrary(LPCTSTR name);
HMODULE WINAPI LoadLibraryA(LPCSTR name);
UINT WINAPI GetSystemDirectoryA(LPSTR buf, UINT n);
LPWSTR WINAPI GetCommandLineW(void);
LPSTR WINAPI GetCommandLineA(void);
DWORD WINAPI GetEnvironmentVariable(LPCTSTR name, LPTSTR buf, DWORD n);
HANDLE WINAPI GetStdHandle(DWORD which);
BOOL WINAPI AllocConsole(void);
BOOL WINAPI WriteFile(HANDLE h, LPCVOID buf, DWORD n, LPDWORD written, LPOVERLAPPED ov);
BOOL WINAPI ReadFile(HANDLE h, LPVOID buf, DWORD n, LPDWORD got, LPOVERLAPPED ov);
#define STD_INPUT_HANDLE  ((DWORD)-10)
#define STD_OUTPUT_HANDLE ((DWORD)-11)
#define STD_ERROR_HANDLE  ((DWORD)-12)
BOOL WINAPI TextOut(HDC dc, int x, int y, LPCTSTR s, int n);
int WINAPI GetWindowTextLength(HWND hwnd);
int WINAPI GetWindowText(HWND hwnd, LPTSTR buf, int n);
BOOL WINAPI DrawEdge(HDC dc, RECT *r, UINT edge, UINT flags);
#define EDGE_SUNKEN     0x000A
#define EDGE_ETCHED     0x0006
#define BF_RECT         0x000F
#define BF_ADJUST       0x2000
#define GWL_ID          (-12)
#define MB_DEFBUTTON3   0x00000200
#define LBS_MULTIPLESEL 0x0008
#define LBS_EXTENDEDSEL 0x0800
#define LBS_OWNERDRAWFIXED 0x0010
#define LBS_DISABLENOSCROLL 0x1000
#define STM_SETIMAGE    0x0172
#define ERROR_FILE_EXISTS 80
#define ERROR_ALREADY_EXISTS 183
#define BLACK_PEN       7
#define NULL_PEN        8
#define WHITE_BRUSH     0
#define BLACK_BRUSH     4
#define NULL_BRUSH      5
#define CREATE_NEW      1
#define CREATE_NEW_ALWAYS 2
#define TRUNCATE_EXISTING 5
#define ANSI_FIXED_FONT 11
#define HWND_BOTTOM     ((HWND)1)
#define HWND_NOTOPMOST  ((HWND)-2)
HANDLE WINAPI FindResource(HMODULE mod, LPCTSTR name, LPCTSTR type);
HANDLE WINAPI LoadResource(HMODULE mod, HANDLE res);
LPVOID WINAPI LockResource(HANDLE res);
DWORD WINAPI SizeofResource(HMODULE mod, HANDLE res);
#define RT_RCDATA       ((LPCTSTR)10)
#define TPM_BOTTOMALIGN 0x0020
#define FILE_SHARE_READ  0x00000001
#define FILE_SHARE_WRITE 0x00000002
#define SND_ASYNC        0x0001
#define SND_FILENAME     0x00020000
#define SND_ALIAS_ID     0x00110000
BOOL WINAPI PlaySound(LPCTSTR name, HMODULE mod, DWORD flags);
#define TPM_LEFTBUTTON  0x0000
#define TA_CENTER       6
#define TA_RIGHT        2
#define TA_BOTTOM       8
#define CFS_DEFAULT     0x0000
#define CFS_POINT       0x0002
#define CFS_FORCE_POSITION 0x0020
BOOL WINAPI DeleteFile(LPCTSTR name);
DWORD WINAPI GetTempPath(DWORD n, LPTSTR buf);
UINT WINAPI GetTempFileName(LPCTSTR dir, LPCTSTR pre, UINT unique, LPTSTR out);
#define TA_NOUPDATECP   0
#define FLI_MASK        0x103B      /* GetFontLanguageInfo's "any of these apply" mask */
#define LOCALE_IDEFAULTANSICODEPAGE 0x00001004
#define LOCALE_IDEFAULTCODEPAGE     0x0000000B
#define GWL_USERDATA    (-21)
#define GWL_WNDPROC     (-4)
#define GWL_HINSTANCE   (-6)
#define GWL_STYLE       (-16)
#define GWL_EXSTYLE     (-20)
#define FW_THIN         100
#define FW_LIGHT        300
#define FW_SEMIBOLD     600
#define FW_HEAVY        900
#define DEFAULT_PALETTE 15
#define TMPF_FIXED_PITCH 0x01
#define TMPF_VECTOR      0x02
#define TMPF_TRUETYPE    0x04
#define TMPF_DEVICE      0x08
#define LBS_USETABSTOPS  0x0080
HANDLE WINAPI CreateFile(LPCTSTR name, DWORD access, DWORD share, void *sa,
                         DWORD disp, DWORD flags, HANDLE tmpl);
BOOL WINAPI SetHandleInformation(HANDLE h, DWORD mask, DWORD flags);
BOOL WINAPI ClearCommBreak(HANDLE h);
BOOL WINAPI SetCommBreak(HANDLE h);
#define GENERIC_READ    0x80000000
#define GENERIC_WRITE   0x40000000
#define OPEN_EXISTING   3
#define CREATE_ALWAYS   2
#define FILE_ATTRIBUTE_TEMPORARY 0x00000100
#define FILE_FLAG_OVERLAPPED     0x40000000
#define INVALID_HANDLE_VALUE ((HANDLE)(LONG_PTR)-1)
#define HANDLE_FLAG_INHERIT  0x00000001
/* MSVC spells the case-insensitive compares with an underscore; they are strcasecmp's. */
#define _stricmp   strcasecmp
#define _strnicmp  strncasecmp

/* ---- the serial port. PuTTY is a serial terminal as well as a network one. */
typedef struct _DCB {
    DWORD DCBlength, BaudRate;
    DWORD fBinary : 1, fParity : 1, fOutxCtsFlow : 1, fOutxDsrFlow : 1;
    DWORD fDtrControl : 2, fDsrSensitivity : 1, fTXContinueOnXoff : 1;
    DWORD fOutX : 1, fInX : 1, fErrorChar : 1, fNull : 1;
    DWORD fRtsControl : 2, fAbortOnError : 1, fDummy2 : 17;
    WORD wReserved, XonLim, XoffLim;
    BYTE ByteSize, Parity, StopBits;
    char XonChar, XoffChar, ErrorChar, EofChar, EvtChar;
    WORD wReserved1;
} DCB, *LPDCB;
typedef struct _COMMTIMEOUTS {
    DWORD ReadIntervalTimeout, ReadTotalTimeoutMultiplier, ReadTotalTimeoutConstant;
    DWORD WriteTotalTimeoutMultiplier, WriteTotalTimeoutConstant;
} COMMTIMEOUTS, *LPCOMMTIMEOUTS;
BOOL WINAPI GetCommState(HANDLE h, LPDCB dcb);
BOOL WINAPI SetCommState(HANDLE h, LPDCB dcb);
BOOL WINAPI SetCommTimeouts(HANDLE h, LPCOMMTIMEOUTS t);
#define NOPARITY        0
#define ODDPARITY       1
#define EVENPARITY      2
#define MARKPARITY      3
#define SPACEPARITY     4
#define ONESTOPBIT      0
#define ONE5STOPBITS    1
#define TWOSTOPBITS     2
#define DTR_CONTROL_DISABLE   0x00
#define DTR_CONTROL_ENABLE    0x01
#define DTR_CONTROL_HANDSHAKE 0x02
#define RTS_CONTROL_DISABLE   0x00
#define RTS_CONTROL_ENABLE    0x01
#define RTS_CONTROL_HANDSHAKE 0x02

/* ---- the shell's jump list, which is COM.
 *
 * jump-list.c declares every vtable it uses ITSELF -- ICustomDestinationList, IObjectCollection and
 * the rest are written out in that file -- so what it needs from here is the surrounding furniture:
 * the variant type, the class and interface ids, and CoCreateInstance. The ids are declared and left
 * undefined; the program checks CoCreateInstance's HRESULT and gives up quietly when the shell is
 * not there, which is exactly the path a machine with no Windows shell should take.
 */
typedef struct tagPROPVARIANT {
    WORD vt, wReserved1, wReserved2, wReserved3;
    union {
        long lVal;
        unsigned long ulVal;
        wchar_t *pwszVal;
        char *pszVal;
        void *pv;
        double dblVal;
    };
} PROPVARIANT;
#define VT_EMPTY    0
#define VT_LPSTR    30
#define VT_LPWSTR   31
typedef const GUID *REFCLSID;
typedef GUID CLSID;
HRESULT WINAPI CoCreateInstance(REFCLSID cls, void *outer, DWORD ctx, REFIID iid, void **out);
#define CLSCTX_INPROC_SERVER 0x1
#define CLSCTX_INPROC_HANDLER 0x2
#define CLSCTX_LOCAL_SERVER  0x4
#define CLSCTX_REMOTE_SERVER 0x10
#define CLSCTX_ALL (CLSCTX_INPROC_SERVER | CLSCTX_INPROC_HANDLER | CLSCTX_LOCAL_SERVER | CLSCTX_REMOTE_SERVER)
extern const GUID CLSID_DestinationList, CLSID_EnumerableObjectCollection, CLSID_ShellLink;
extern const GUID IID_ICustomDestinationList, IID_IObjectArray, IID_IObjectCollection;
extern const GUID IID_IPropertyStore, IID_IShellLinkA, IID_IShellLinkW, IID_IUnknown;

/* CreateProcess and its two parameter blocks. PuTTY starts a copy of itself for "Duplicate Session". */
typedef struct _STARTUPINFOA {
    DWORD cb;
    LPSTR lpReserved, lpDesktop, lpTitle;
    DWORD dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    WORD wShowWindow, cbReserved2;
    LPBYTE lpReserved2;
    HANDLE hStdInput, hStdOutput, hStdError;
} STARTUPINFOA, STARTUPINFO, *LPSTARTUPINFO;
typedef struct _PROCESS_INFORMATION {
    HANDLE hProcess, hThread;
    DWORD dwProcessId, dwThreadId;
} PROCESS_INFORMATION, *LPPROCESS_INFORMATION;
BOOL WINAPI CreateProcess(LPCSTR app, LPSTR cmd, void *psa, void *tsa, BOOL inherit,
                          DWORD flags, LPVOID env, LPCSTR dir,
                          LPSTARTUPINFO si, LPPROCESS_INFORMATION pi);
HANDLE WINAPI CreateFileMapping(HANDLE file, void *sa, DWORD protect,
                                DWORD hi, DWORD lo, LPCSTR name);
LPVOID WINAPI MapViewOfFile(HANDLE map, DWORD access, DWORD hi, DWORD lo, SIZE_T bytes);
BOOL WINAPI UnmapViewOfFile(LPCVOID addr);
#define FILE_MAP_WRITE  0x0002
#define FILE_MAP_READ   0x0004
#define STARTF_USESHOWWINDOW 0x00000001

/* ---- the rest of the message and virtual-key alphabet a terminal window needs. */
#define WM_DESTROYCLIPBOARD 0x0307
#define WM_VSCROLL          0x0115
#define WM_INITMENUPOPUP    0x0117
#define WM_NCMOUSEMOVE      0x00A0
#define WM_MOUSEHWHEEL      0x020E
#define WM_IME_STARTCOMPOSITION 0x010D
#define WM_IME_COMPOSITION  0x010F
#define WM_IME_CHAR         0x0286
#define WM_DPICHANGED       0x02E0
#define WM_DPICHANGED_BEFOREPARENT 0x02E2
#define WM_DPICHANGED_AFTERPARENT  0x02E3
#define WM_GETDPISCALEDSIZE 0x02E4

#define MK_SHIFT        0x0004
#define MK_CONTROL      0x0008
#define SB_LINEUP       0
#define SB_LINEDOWN     1
#define SB_PAGEUP       2
#define SB_PAGEDOWN     3
#define SB_THUMBPOSITION 4
#define SB_THUMBTRACK   5
#define SB_TOP          6
#define SB_BOTTOM       7
#define SC_VSCROLL      0xF070
#define SC_HSCROLL      0xF080
#define SC_MOUSEMENU    0xF090
#define SM_CXVSCROLL    2
#define SW_MAXIMIZE     3
#define MB_OKCANCEL     0x00000001
#define MB_ICONHAND     0x00000010
#define MB_SYSTEMMODAL  0x00001000
#define IDC_IBEAM       ((LPCTSTR)32513)
#define IDC_WAIT        ((LPCTSTR)32514)
#define IDC_APPSTARTING ((LPCTSTR)32650)
/* The high word of a WM_KEYDOWN lParam. */
#define KF_EXTENDED     0x0100
#define KF_ALTDOWN      0x2000
#define KF_REPEAT       0x4000
#define KF_UP           0x8000

#define VK_CANCEL       0x03
#define VK_CLEAR        0x0C
#define VK_EXECUTE      0x2B
#define VK_NUMPAD0      0x60
#define VK_NUMPAD1      0x61
#define VK_NUMPAD2      0x62
#define VK_NUMPAD3      0x63
#define VK_NUMPAD4      0x64
#define VK_NUMPAD5      0x65
#define VK_NUMPAD6      0x66
#define VK_NUMPAD7      0x67
#define VK_NUMPAD8      0x68
#define VK_NUMPAD9      0x69
#define VK_MULTIPLY     0x6A
#define VK_ADD          0x6B
#define VK_SUBTRACT     0x6D
#define VK_DECIMAL      0x6E
#define VK_DIVIDE       0x6F
#define VK_F2           0x71
#define VK_F3           0x72
#define VK_F4           0x73
#define VK_F5           0x74
#define VK_F6           0x75
#define VK_F7           0x76
#define VK_F8           0x77
#define VK_F9           0x78
#define VK_F10          0x79
#define VK_F11          0x7A
#define VK_F13          0x7C
#define VK_F14          0x7D
#define VK_F15          0x7E
#define VK_F16          0x7F
#define VK_F17          0x80
#define VK_F18          0x81
#define VK_F19          0x82
#define VK_F20          0x83
#define VK_RMENU        0xA5
#define VK_PROCESSKEY   0xE5
#define VK_PACKET       0xE7

/* ---- what a real GUI reaches for: menus, the clipboard, the caret, scrollbars, the IME.
 *
 * PuTTY's window.c is 6,000 lines of Win32 and this is the shape of its surface. Declared, not
 * implemented: the linker reports what the program actually calls, which is a smaller set than what
 * it names, and src/env/win32.c fills that in.
 */
typedef struct _ABC { int abcA; UINT abcB; int abcC; } ABC;
typedef struct _ABCFLOAT { FLOAT abcfA, abcfB, abcfC; } ABCFLOAT;
typedef struct tagSCROLLINFO {
    UINT cbSize, fMask;
    int nMin, nMax;
    UINT nPage;
    int nPos, nTrackPos;
} SCROLLINFO, *LPSCROLLINFO;
typedef struct { UINT cbSize; HWND hwnd; DWORD dwFlags; UINT uCount; DWORD dwTimeout; } FLASHWINFO;
typedef struct tagCOMPOSITIONFORM { DWORD dwStyle; POINT ptCurrentPos; RECT rcArea; } COMPOSITIONFORM;
typedef struct tagCHARSETINFO { UINT ciCharset, ciACP; DWORD fs[4]; } CHARSETINFO, *LPCHARSETINFO;
typedef struct tagGCP_RESULTSW {
    DWORD lStructSize;
    LPWSTR lpOutString;
    UINT *lpOrder;
    INT *lpDx, *lpCaretPos;
    LPSTR lpClass;
    LPWSTR lpGlyphs;
    UINT nGlyphs, nMaxFit;
} GCP_RESULTSW;
typedef struct _OUTLINETEXTMETRICA { UINT otmSize; TEXTMETRICA otmTextMetrics; BYTE otmFiller;
                                     BYTE otmPanoseNumber[10]; UINT otmfsSelection, otmfsType;
                                     int otmsCharSlopeRise, otmsCharSlopeRun, otmItalicAngle;
                                     UINT otmEMSquare; int otmAscent, otmDescent;
                                     UINT otmLineGap, otmsCapEmHeight, otmsXHeight;
                                     RECT otmrcFontBox;
                                     int otmMacAscent, otmMacDescent; UINT otmMacLineGap, otmusMinimumPPEM;
                                     POINT otmptSubscriptSize, otmptSubscriptOffset;
                                     POINT otmptSuperscriptSize, otmptSuperscriptOffset;
                                     UINT otmsStrikeoutSize; int otmsStrikeoutPosition;
                                     int otmsUnderscoreSize, otmsUnderscorePosition;
                                     void *otmpFamilyName, *otmpFaceName, *otmpStyleName, *otmpFullName;
} OUTLINETEXTMETRICA, OUTLINETEXTMETRIC, *LPOUTLINETEXTMETRIC;

HMENU WINAPI CreateMenu(void);
HMENU WINAPI CreatePopupMenu(void);
HMENU WINAPI GetSystemMenu(HWND hwnd, BOOL revert);
BOOL WINAPI AppendMenu(HMENU m, UINT flags, UINT_PTR id, LPCTSTR item);
BOOL WINAPI InsertMenu(HMENU m, UINT pos, UINT flags, UINT_PTR id, LPCTSTR item);
BOOL WINAPI DeleteMenu(HMENU m, UINT pos, UINT flags);
DWORD WINAPI CheckMenuItem(HMENU m, UINT id, UINT check);
BOOL WINAPI EnableMenuItem(HMENU m, UINT id, UINT enable);
BOOL WINAPI TrackPopupMenu(HMENU m, UINT flags, int x, int y, int res, HWND hwnd, const RECT *r);
#define MF_STRING       0x0000
#define MF_ENABLED      0x0000
#define MF_GRAYED       0x0001
#define MF_DISABLED     0x0002
#define MF_BYCOMMAND    0x0000
#define MF_BYPOSITION   0x0400
#define MF_SEPARATOR    0x0800
#define MF_CHECKED      0x0008
#define MF_UNCHECKED    0x0000
#define MF_POPUP        0x0010
#define TPM_RIGHTBUTTON 0x0002

BOOL WINAPI OpenClipboard(HWND hwnd);
BOOL WINAPI CloseClipboard(void);
BOOL WINAPI EmptyClipboard(void);
HANDLE WINAPI GetClipboardData(UINT fmt);
HANDLE WINAPI SetClipboardData(UINT fmt, HANDLE h);
UINT WINAPI RegisterClipboardFormat(LPCTSTR name);
#define CF_TEXT         1
#define CF_BITMAP       2
#define CF_OEMTEXT      7
#define CF_UNICODETEXT  13
#define CF_LOCALE       16
/* Rich text, which PuTTY offers alongside plain text when copying a coloured selection. */
#define CF_RTF          RegisterClipboardFormat("Rich Text Format")
HANDLE WINAPI GlobalAlloc(UINT flags, SIZE_T bytes);
LPVOID WINAPI GlobalLock(HANDLE h);
BOOL WINAPI GlobalUnlock(HANDLE h);
HANDLE WINAPI GlobalFree(HANDLE h);
SIZE_T WINAPI GlobalSize(HANDLE h);
#define GMEM_MOVEABLE   0x0002
#define GMEM_DDESHARE   0x2000
#define GMEM_ZEROINIT   0x0040

BOOL WINAPI CreateCaret(HWND hwnd, HBITMAP bm, int w, int h);
BOOL WINAPI DestroyCaret(void);
BOOL WINAPI ShowCaret(HWND hwnd);
BOOL WINAPI HideCaret(HWND hwnd);
BOOL WINAPI SetCaretPos(int x, int y);

HBITMAP WINAPI CreateBitmap(int w, int h, UINT planes, UINT bits, const void *data);
HBITMAP WINAPI CreateCompatibleBitmap(HDC dc, int w, int h);
HDC WINAPI CreateCompatibleDC(HDC dc);
BOOL WINAPI DeleteDC(HDC dc);
HFONT WINAPI CreateFont(int h, int w, int esc, int orient, int weight, DWORD italic,
                        DWORD underline, DWORD strike, DWORD charset, DWORD outprec,
                        DWORD clipprec, DWORD quality, DWORD pitch, LPCTSTR face);
HPEN WINAPI CreatePen(int style, int width, COLORREF c);
BOOL WINAPI LineTo(HDC dc, int x, int y);
BOOL WINAPI MoveToEx(HDC dc, int x, int y, POINT *old);
BOOL WINAPI Polyline(HDC dc, const POINT *pts, int n);
BOOL WINAPI Rectangle(HDC dc, int l, int t, int r, int b);
COLORREF WINAPI SetPixel(HDC dc, int x, int y, COLORREF c);
COLORREF WINAPI GetPixel(HDC dc, int x, int y);
int WINAPI ExcludeClipRect(HDC dc, int l, int t, int r, int b);
int WINAPI IntersectClipRect(HDC dc, int l, int t, int r, int b);
int WINAPI SelectClipRgn(HDC dc, HRGN rgn);
UINT WINAPI SetTextAlign(HDC dc, UINT align);
int WINAPI GetBkMode(HDC dc);
int WINAPI GetObject(HGDIOBJ obj, int n, void *out);
BOOL WINAPI UnrealizeObject(HGDIOBJ obj);
BOOL WINAPI UpdateColors(HDC dc);
UINT WINAPI SetPaletteEntries(HPALETTE pal, UINT start, UINT n, const PALETTEENTRY *e);
UINT WINAPI GetOutlineTextMetrics(HDC dc, UINT n, LPOUTLINETEXTMETRIC otm);
BOOL WINAPI GetCharWidth(HDC dc, UINT first, UINT last, INT *out);
BOOL WINAPI GetCharWidthW(HDC dc, UINT first, UINT last, INT *out);
BOOL WINAPI GetCharWidth32(HDC dc, UINT first, UINT last, INT *out);
BOOL WINAPI GetCharWidth32W(HDC dc, UINT first, UINT last, INT *out);
BOOL WINAPI GetCharABCWidthsFloat(HDC dc, UINT first, UINT last, ABCFLOAT *out);
DWORD WINAPI GetCharacterPlacementW(HDC dc, LPCWSTR s, int n, int maxext, GCP_RESULTSW *r, DWORD flags);
BOOL WINAPI GetTextExtentExPoint(HDC dc, LPCTSTR s, int n, int maxext, INT *fit, INT *dx, SIZE *sz);
#define TA_TOP          0
#define TA_LEFT         0
#define TA_UPDATECP     1
#define PS_SOLID        0
#define GCP_CLASSIN     0x00080000
#define GCP_DIACRITIC   0x00000100
#define GCPCLASS_NEUTRAL 3
#define PALETTERGB(r, g, b) (0x02000000 | RGB(r, g, b))
#ifndef GetRValue
#define GetRValue(c) ((BYTE)((c) & 0xFF))
#define GetGValue(c) ((BYTE)(((c) >> 8) & 0xFF))
#define GetBValue(c) ((BYTE)(((c) >> 16) & 0xFF))
#endif

HWND WINAPI CreateWindowExA(DWORD ex, LPCSTR cls, LPCSTR name, DWORD style,
                            int x, int y, int w, int h, HWND parent, HMENU menu,
                            HINSTANCE inst, LPVOID param);
HWND WINAPI CreateWindowExW(DWORD ex, LPCWSTR cls, LPCWSTR name, DWORD style,
                            int x, int y, int w, int h, HWND parent, HMENU menu,
                            HINSTANCE inst, LPVOID param);
BOOL WINAPI SetWindowTextA(HWND hwnd, LPCSTR t);
BOOL WINAPI SetWindowTextW(HWND hwnd, LPCWSTR t);
BOOL WINAPI IsIconic(HWND hwnd);
BOOL WINAPI IsZoomed(HWND hwnd);
BOOL WINAPI IsWindow(HWND hwnd);
BOOL WINAPI IsDialogMessage(HWND dlg, MSG *msg);
BOOL WINAPI EnableWindow(HWND hwnd, BOOL enable);
HWND WINAPI GetDesktopWindow(void);
HWND WINAPI GetForegroundWindow(void);
HCURSOR WINAPI SetCursor(HCURSOR c);
HANDLE WINAPI LoadImage(HINSTANCE inst, LPCTSTR name, UINT type, int cx, int cy, UINT load);
BOOL WINAPI DrawIconEx(HDC dc, int x, int y, HICON icon, int cx, int cy,
                       UINT step, HBRUSH flicker, UINT flags);
BOOL WINAPI DestroyIcon(HICON icon);
BOOL WINAPI FlashWindow(HWND hwnd, BOOL invert);
BOOL WINAPI FlashWindowEx(FLASHWINFO *fi);
BOOL WINAPI GetScrollInfo(HWND hwnd, int bar, LPSCROLLINFO si);
int WINAPI SetScrollInfo(HWND hwnd, int bar, LPSCROLLINFO si, BOOL redraw);
BOOL WINAPI OffsetRect(RECT *r, int dx, int dy);
DWORD WINAPI SetClassLongPtr(HWND hwnd, int index, LONG_PTR v);
UINT WINAPI GetDoubleClickTime(void);
LONG WINAPI GetMessageTime(void);
INT_PTR WINAPI DialogBox(HINSTANCE inst, LPCTSTR tmpl, HWND parent, void *proc);
#define DI_NORMAL       0x0003
#define FLASHW_STOP     0
#define FLASHW_CAPTION  1
#define FLASHW_TRAY     2
#define FLASHW_ALL      3
#define FLASHW_TIMER    4
#define SB_VERT         1
#define SIF_RANGE       0x0001
#define SIF_PAGE        0x0002
#define SIF_POS         0x0004
#define SIF_TRACKPOS    0x0010
#define SIF_ALL         (SIF_RANGE | SIF_PAGE | SIF_POS | SIF_TRACKPOS)
#define SWP_NOREDRAW    0x0008
#define DM_SETDEFID     (WM_USER + 1)
#define LBS_NOTIFY      0x0001
#define LBS_HASSTRINGS  0x0040
#define MB_YESNOCANCEL  0x00000003
#define IDI_QUESTION    ((LPCTSTR)32514)
#define IDI_WARNING     ((LPCTSTR)32515)
#define COLOR_WINDOW        5
#define COLOR_WINDOWTEXT    8
#define COLOR_HIGHLIGHT     13
#define COLOR_HIGHLIGHTTEXT 14
#define GCLP_HCURSOR    (-12)
#define ERROR_CALL_NOT_IMPLEMENTED 120

HKL WINAPI GetKeyboardLayout(DWORD thread);
BOOL WINAPI GetKeyboardState(BYTE *state);
BOOL WINAPI SetKeyboardState(BYTE *state);
UINT WINAPI MapVirtualKeyEx(UINT code, UINT type, HKL layout);
int WINAPI ToAsciiEx(UINT vk, UINT scan, const BYTE *state, LPWORD out, UINT flags, HKL layout);
BOOL WINAPI TranslateCharsetInfo(DWORD *src, LPCHARSETINFO out, DWORD flags);
int WINAPI GetLocaleInfo(DWORD locale, DWORD type, LPTSTR buf, int n);
#define TCI_SRCCHARSET  1
#define TCI_SRCCODEPAGE 2
#define LOCALE_USER_DEFAULT 0x0400

typedef HANDLE HIMC;
HIMC WINAPI ImmGetContext(HWND hwnd);
BOOL WINAPI ImmReleaseContext(HWND hwnd, HIMC imc);
LONG WINAPI ImmGetCompositionStringW(HIMC imc, DWORD index, LPVOID buf, DWORD n);
BOOL WINAPI ImmSetCompositionFont(HIMC imc, LPLOGFONT lf);
BOOL WINAPI ImmSetCompositionWindow(HIMC imc, COMPOSITIONFORM *cf);
#define GCS_RESULTSTR   0x0800

BOOL WINAPI Beep(DWORD freq, DWORD dur);
HRESULT WINAPI CoInitialize(LPVOID reserved);
void WINAPI CoUninitialize(void);

/* ---- commdlg's font and colour choosers, which PuTTY's Appearance panel opens. */
typedef struct tagCHOOSEFONTA {
    DWORD lStructSize;
    HWND hwndOwner;
    HDC hDC;
    LPLOGFONT lpLogFont;
    INT iPointSize;
    DWORD Flags, rgbColors;
    LPARAM lCustData;
    void *lpfnHook;
    LPCSTR lpTemplateName;
    HINSTANCE hInstance;
    LPSTR lpszStyle;
    WORD nFontType, ___MISSING_ALIGNMENT__;
    INT nSizeMin, nSizeMax;
} CHOOSEFONTA, CHOOSEFONT, *LPCHOOSEFONT;
BOOL WINAPI ChooseFont(LPCHOOSEFONT cf);
#define CF_SCREENFONTS          0x00000001
#define CF_INITTOLOGFONTSTRUCT  0x00000040
#define CF_FIXEDPITCHONLY       0x00004000
#define CF_FORCEFONTEXIST       0x00010000

typedef struct tagCHOOSECOLORA {
    DWORD lStructSize;
    HWND hwndOwner, hInstance;
    COLORREF rgbResult;
    COLORREF *lpCustColors;
    DWORD Flags;
    LPARAM lCustData;
    void *lpfnHook;
    LPCSTR lpTemplateName;
} CHOOSECOLORA, CHOOSECOLOR, *LPCHOOSECOLOR;
BOOL WINAPI ChooseColor(LPCHOOSECOLOR cc);
#define CC_RGBINIT      0x00000001
#define CC_FULLOPEN     0x00000002

int WINAPI MulDiv(int a, int b, int c);
int WINAPI GetDeviceCaps(HDC dc, int index);
#define LOGPIXELSX      88
#define LOGPIXELSY      90

/* ---- commdlg's file dialogue, in both encodings: PuTTY uses each explicitly. */
#define OFN_ALLOWMULTISELECT 0x00000200
#define OFN_EXPLORER         0x00080000
#define OFN_HIDEREADONLY     0x00000004
#define OFN_OVERWRITEPROMPT  0x00000002
#define OFN_PATHMUSTEXIST    0x00000800
#define OFN_FILEMUSTEXIST    0x00001000
#define OFN_NOCHANGEDIR      0x00000008
#define PRISM_OFN_STRUCT(CH, NAME) \
    struct NAME { \
        DWORD lStructSize; HWND hwndOwner; HINSTANCE hInstance; \
        const CH *lpstrFilter; CH *lpstrCustomFilter; DWORD nMaxCustFilter; \
        DWORD nFilterIndex; CH *lpstrFile; DWORD nMaxFile; \
        CH *lpstrFileTitle; DWORD nMaxFileTitle; const CH *lpstrInitialDir; \
        const CH *lpstrTitle; DWORD Flags; WORD nFileOffset, nFileExtension; \
        const CH *lpstrDefExt; LPARAM lCustData; void *lpfnHook; \
        const CH *lpTemplateName; void *pvReserved; DWORD dwReserved, FlagsEx; \
    }
typedef PRISM_OFN_STRUCT(char, tagOFNA) OPENFILENAMEA, OPENFILENAME;
typedef PRISM_OFN_STRUCT(wchar_t, tagOFNW) OPENFILENAMEW;
#undef PRISM_OFN_STRUCT
BOOL WINAPI GetOpenFileNameA(OPENFILENAMEA *of);
BOOL WINAPI GetSaveFileNameA(OPENFILENAMEA *of);
BOOL WINAPI GetOpenFileNameW(OPENFILENAMEW *of);
BOOL WINAPI GetSaveFileNameW(OPENFILENAMEW *of);

/* ---- the message box's help hook, and MessageBoxIndirect's parameter block. */
typedef struct tagHELPINFO {
    UINT cbSize;
    int iContextType;
    int iCtrlId;
    HANDLE hItemHandle;
    DWORD_PTR dwContextId;
    POINT MousePos;
} HELPINFO, *LPHELPINFO;
typedef void (CALLBACK *MSGBOXCALLBACK)(LPHELPINFO);
/*
 * The A and W pair, spelled out rather than aliased, because PuTTY picks the WIDE one explicitly
 * (message_box.c:35) so that it can pass UTF-8 text it has converted itself.
 */
typedef struct tagMSGBOXPARAMSW {
    UINT cbSize;
    HWND hwndOwner;
    HINSTANCE hInstance;
    LPCWSTR lpszText;
    LPCWSTR lpszCaption;
    DWORD dwStyle;
    LPCWSTR lpszIcon;
    DWORD_PTR dwContextHelpId;
    MSGBOXCALLBACK lpfnMsgBoxCallback;
    DWORD dwLanguageId;
} MSGBOXPARAMSW, *LPMSGBOXPARAMSW;
int WINAPI MessageBoxIndirectW(const MSGBOXPARAMSW *p);
typedef struct tagMSGBOXPARAMS {
    UINT cbSize;
    HWND hwndOwner;
    HINSTANCE hInstance;
    LPCSTR lpszText;
    LPCSTR lpszCaption;
    DWORD dwStyle;
    LPCSTR lpszIcon;
    DWORD_PTR dwContextHelpId;
    MSGBOXCALLBACK lpfnMsgBoxCallback;
    DWORD dwLanguageId;
} MSGBOXPARAMS, *LPMSGBOXPARAMS;
int WINAPI MessageBoxIndirect(const MSGBOXPARAMS *p);
#define MB_USERICON     0x00000080
#define MB_HELP         0x00004000
#define VOID void

/* ---- time, code pages and the registry.
 *
 * Declared, not implemented. PRISM reports an undefined symbol at link time and the survey of what
 * a target actually calls is worth more than a guess at what it might: PuTTY's utils/ touches a wide
 * slice of these headers and calls a narrow one.
 */
typedef struct _SYSTEMTIME {
    WORD wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds;
} SYSTEMTIME, *LPSYSTEMTIME;
void WINAPI GetLocalTime(LPSYSTEMTIME t);
DWORD WINAPI GetTickCount(void);
void WINAPI GetSystemTime(LPSYSTEMTIME t);
BOOL WINAPI SystemTimeToFileTime(const SYSTEMTIME *st, LPFILETIME ft);
BOOL WINAPI IsProcessorFeaturePresent(DWORD feature);

#define MAX_DEFAULTCHAR 2
#define MAX_LEADBYTES   12
typedef struct _cpinfo {
    UINT MaxCharSize;
    BYTE DefaultChar[MAX_DEFAULTCHAR];
    BYTE LeadByte[MAX_LEADBYTES];
} CPINFO, *LPCPINFO;
UINT WINAPI GetACP(void);
UINT WINAPI GetOEMCP(void);
BOOL WINAPI GetCPInfo(UINT cp, LPCPINFO info);
BOOL WINAPI IsDBCSLeadByteEx(UINT cp, BYTE b);
#define CP_OEMCP      1
#define MB_ERR_INVALID_CHARS 0x00000008
#define MB_USEGLYPHCHARS     0x00000004
#define ERROR_INVALID_PARAMETER 87
#define CP_ACP        0
#define CP_UTF8       65001
int WINAPI MultiByteToWideChar(UINT cp, DWORD flags, const char *mb, int mblen,
                               wchar_t *wc, int wclen);
int WINAPI WideCharToMultiByte(UINT cp, DWORD flags, const wchar_t *wc, int wclen,
                               char *mb, int mblen, const char *dflt, BOOL *useddflt);

typedef HKEY *PHKEY;
#define HKEY_CLASSES_ROOT   ((HKEY)0x80000000)
#define HKEY_CURRENT_USER   ((HKEY)0x80000001)
#define HKEY_LOCAL_MACHINE  ((HKEY)0x80000002)
#define KEY_READ            0x20019
#define KEY_WRITE           0x20006
#define KEY_ALL_ACCESS      0xF003F
#define REG_SZ              1
#define REG_BINARY          3
#define REG_DWORD           4
#define ERROR_SUCCESS       0
#define ERROR_MORE_DATA     234
LONG WINAPI RegOpenKeyEx(HKEY key, LPCTSTR sub, DWORD opt, DWORD sam, PHKEY out);
LONG WINAPI RegCreateKeyEx(HKEY key, LPCTSTR sub, DWORD res, LPTSTR cls, DWORD opt,
                           DWORD sam, void *sa, PHKEY out, DWORD *disp);
LONG WINAPI RegQueryValueEx(HKEY key, LPCTSTR name, DWORD *res, DWORD *type,
                            BYTE *data, DWORD *len);
LONG WINAPI RegSetValueEx(HKEY key, LPCTSTR name, DWORD res, DWORD type,
                          const BYTE *data, DWORD len);
LONG WINAPI RegDeleteValue(HKEY key, LPCTSTR name);
LONG WINAPI RegDeleteKey(HKEY key, LPCTSTR sub);
LONG WINAPI RegEnumKey(HKEY key, DWORD i, LPTSTR name, DWORD len);
LONG WINAPI RegCloseKey(HKEY key);

#define FIELD_OFFSET(type, field) ((LONG)(LONG_PTR)&(((type *)0)->field))

/* ---- the functions. Declared here, resolved by src/env/win32.js -- or reported as undefined,
   which is the point of declaring them rather than guessing at an implementation. */
HWND WINAPI CreateWindowEx(DWORD, LPCSTR, LPCSTR, DWORD, int, int, int, int, HWND, HMENU, HINSTANCE, LPVOID);
BOOL WINAPI DestroyWindow(HWND);
ATOM WINAPI RegisterClass(const WNDCLASS *);
LRESULT WINAPI DefWindowProc(HWND, UINT, WPARAM, LPARAM);
BOOL WINAPI ShowWindow(HWND, int);
void prism_win32_activate(int);
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

/*
 * wingdi.h's OpenGL half: pixel formats (GDI) and the wgl context calls (opengl32.dll). The layouts
 * are the SDK's, field for field; src/env/opengl32.c implements them.
 */
typedef struct HGLRC__ *HGLRC;
typedef struct tagPIXELFORMATDESCRIPTOR {
    WORD nSize, nVersion; DWORD dwFlags;
    BYTE iPixelType, cColorBits, cRedBits, cRedShift, cGreenBits, cGreenShift, cBlueBits, cBlueShift,
         cAlphaBits, cAlphaShift, cAccumBits, cAccumRedBits, cAccumGreenBits, cAccumBlueBits,
         cAccumAlphaBits, cDepthBits, cStencilBits, cAuxBuffers, iLayerType, bReserved;
    DWORD dwLayerMask, dwVisibleMask, dwDamageMask;
} PIXELFORMATDESCRIPTOR, *PPIXELFORMATDESCRIPTOR, *LPPIXELFORMATDESCRIPTOR;
typedef struct tagLAYERPLANEDESCRIPTOR {
    WORD nSize, nVersion; DWORD dwFlags;
    BYTE iPixelType, cColorBits, cRedBits, cRedShift, cGreenBits, cGreenShift, cBlueBits, cBlueShift,
         cAlphaBits, cAlphaShift, cAccumBits, cAccumRedBits, cAccumGreenBits, cAccumBlueBits,
         cAccumAlphaBits, cDepthBits, cStencilBits, cAuxBuffers, iLayerPlane, bReserved;
    COLORREF crTransparent;
} LAYERPLANEDESCRIPTOR, *PLAYERPLANEDESCRIPTOR, *LPLAYERPLANEDESCRIPTOR;
typedef struct _POINTFLOAT { FLOAT x, y; } POINTFLOAT, *PPOINTFLOAT;
typedef struct _GLYPHMETRICSFLOAT {
    FLOAT gmfBlackBoxX, gmfBlackBoxY; POINTFLOAT gmfptGlyphOrigin; FLOAT gmfCellIncX, gmfCellIncY;
} GLYPHMETRICSFLOAT, *PGLYPHMETRICSFLOAT, *LPGLYPHMETRICSFLOAT;
#define PFD_TYPE_RGBA 0
#define PFD_TYPE_COLORINDEX 1
#define PFD_MAIN_PLANE 0
#define PFD_OVERLAY_PLANE 1
#define PFD_UNDERLAY_PLANE (-1)
#define PFD_DOUBLEBUFFER 0x00000001
#define PFD_STEREO 0x00000002
#define PFD_DRAW_TO_WINDOW 0x00000004
#define PFD_DRAW_TO_BITMAP 0x00000008
#define PFD_SUPPORT_GDI 0x00000010
#define PFD_SUPPORT_OPENGL 0x00000020
#define PFD_GENERIC_FORMAT 0x00000040
#define PFD_NEED_PALETTE 0x00000080
#define PFD_NEED_SYSTEM_PALETTE 0x00000100
#define PFD_SWAP_EXCHANGE 0x00000200
#define PFD_SWAP_COPY 0x00000400
#define PFD_SWAP_LAYER_BUFFERS 0x00000800
#define PFD_GENERIC_ACCELERATED 0x00001000
#define PFD_DEPTH_DONTCARE 0x20000000
#define PFD_DOUBLEBUFFER_DONTCARE 0x40000000
#define PFD_STEREO_DONTCARE 0x80000000
#define WGL_SWAP_MAIN_PLANE 0x00000001
int WINAPI ChoosePixelFormat(HDC, CONST PIXELFORMATDESCRIPTOR *);
int WINAPI DescribePixelFormat(HDC, int, UINT, LPPIXELFORMATDESCRIPTOR);
int WINAPI GetPixelFormat(HDC);
BOOL WINAPI SetPixelFormat(HDC, int, CONST PIXELFORMATDESCRIPTOR *);
BOOL WINAPI SwapBuffers(HDC);
HGLRC WINAPI wglCreateContext(HDC);
HGLRC WINAPI wglCreateLayerContext(HDC, int);
BOOL WINAPI wglCopyContext(HGLRC, HGLRC, UINT);
BOOL WINAPI wglDeleteContext(HGLRC);
HGLRC WINAPI wglGetCurrentContext(VOID);
HDC WINAPI wglGetCurrentDC(VOID);
PROC WINAPI wglGetProcAddress(LPCSTR);
BOOL WINAPI wglMakeCurrent(HDC, HGLRC);
BOOL WINAPI wglShareLists(HGLRC, HGLRC);
BOOL WINAPI wglUseFontBitmapsA(HDC, DWORD, DWORD, DWORD);
BOOL WINAPI wglUseFontOutlinesA(HDC, DWORD, DWORD, DWORD, FLOAT, FLOAT, int, LPGLYPHMETRICSFLOAT);
BOOL WINAPI wglDescribeLayerPlane(HDC, int, int, UINT, LPLAYERPLANEDESCRIPTOR);
int WINAPI wglSetLayerPaletteEntries(HDC, int, int, int, CONST COLORREF *);
int WINAPI wglGetLayerPaletteEntries(HDC, int, int, int, COLORREF *);
BOOL WINAPI wglRealizeLayerPalette(HDC, int, BOOL);
BOOL WINAPI wglSwapLayerBuffers(HDC, UINT);
#define wglUseFontBitmaps wglUseFontBitmapsA
#define wglUseFontOutlines wglUseFontOutlinesA
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
int WINAPI ShowCursor(BOOL);
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

/*
 * THE DIB SURFACE, measured in one pass over Quake II's Win32 layer rather than discovered one
 * build at a time. Of 828 uppercase names those units use, all but a handful were already declared
 * here or in Quake II's own tree; what follows is the remainder.
 *
 * It matters because the DIB is the path that actually draws: rw_imp.c calls DIB_Init
 * unconditionally, so this is Quake II's software renderer reaching the screen through GDI.
 */
typedef struct tagRGBQUAD {
    BYTE rgbBlue, rgbGreen, rgbRed, rgbReserved;
} RGBQUAD;

typedef struct tagBITMAPINFOHEADER {
    DWORD biSize;
    LONG  biWidth, biHeight;
    WORD  biPlanes, biBitCount;
    DWORD biCompression, biSizeImage;
    LONG  biXPelsPerMeter, biYPelsPerMeter;
    DWORD biClrUsed, biClrImportant;
} BITMAPINFOHEADER, *LPBITMAPINFOHEADER;

typedef struct tagBITMAPINFO {
    BITMAPINFOHEADER bmiHeader;
    RGBQUAD          bmiColors[1];
} BITMAPINFO, *LPBITMAPINFO;

#define BI_RGB               0
#define DIB_RGB_COLORS       0
#define DIB_PAL_COLORS       1
#define SYSPAL_ERROR         0
#define SRCCOPY              0x00CC0020L

HBITMAP WINAPI CreateDIBSection(HDC, LPBITMAPINFO, UINT, void **, HANDLE, DWORD);
UINT    WINAPI SetDIBColorTable(HDC, UINT, UINT, RGBQUAD *);
BOOL    WINAPI UnregisterClass(LPCSTR, HINSTANCE);

/*
 * The system-colour indices rw_dib.c saves and restores around its palette.
 *
 * These are interface numbers in a documented order, so they are written out as such. NUM_SYS_COLORS
 * is the one CHOSEN value: rw_dib.c sizes an array with it and loops, so it only has to cover the
 * indices the program touches -- 21 does, and a desktop PRISM does not have makes the saved values
 * unobservable anyway.
 */
#define COLOR_SCROLLBAR           0
#define COLOR_BACKGROUND          1
#define COLOR_ACTIVECAPTION       2
#define COLOR_INACTIVECAPTION     3
#define COLOR_MENU                4
#define COLOR_WINDOW              5
#define COLOR_WINDOWFRAME         6
#define COLOR_MENUTEXT            7
#define COLOR_WINDOWTEXT          8
#define COLOR_CAPTIONTEXT         9
#define COLOR_ACTIVEBORDER        10
#define COLOR_INACTIVEBORDER      11
#define COLOR_APPWORKSPACE        12
#define COLOR_HIGHLIGHT           13
#define COLOR_HIGHLIGHTTEXT       14
#define COLOR_BTNFACE             15
#define COLOR_BTNSHADOW           16
#define COLOR_GRAYTEXT            17
#define COLOR_BTNTEXT             18
#define COLOR_INACTIVECAPTIONTEXT 19
#define COLOR_BTNHIGHLIGHT        20
#define NUM_SYS_COLORS            21
BOOL WINAPI SetSysColors(int, const int *, const COLORREF *);

/* The rest of what sys_win.c, vid_dll.c and in_win.c name and this header lacked. */
#define FORMAT_MESSAGE_ALLOCATE_BUFFER 0x00000100
#define FORMAT_MESSAGE_FROM_SYSTEM     0x00001000
#define LANG_NEUTRAL                   0x00
#define SUBLANG_DEFAULT                0x01
/* The language-id pair sys_win.c hands FormatMessage, as documented: sublanguage above primary. */
#define MAKELANGID(p, s) ((((WORD)(s)) << 10) | (WORD)(p))
#define SEM_FAILCRITICALERRORS         0x0001
#define DRIVE_CDROM                    5
#define PAGE_READONLY                  0x02
#define WM_MOUSELAST                   0x0209
#define SPI_SCREENSAVERRUNNING         97
#define MOD_ALT                        0x0001

/*
 * THE MSVC LIBC NAMES, and they are here rather than in io.h, direct.h and float.h on purpose.
 *
 * q_shwin.c includes all three and sys_win.c includes float.h, but PRISM already answers those from
 * its general header set with POSIX shapes that every other target shares. Overriding them for
 * Windows would change what Doom and Quake and OpenDUNE see, to declare four names one program
 * wants. windows.h is pulled in by winquake.h regardless, so this reaches the same files and
 * nothing else.
 */
#ifndef _PRISM_MSVC_LIBC
#define _PRISM_MSVC_LIBC

/* MSVC's directory walk, which q_shwin.c uses for Sys_FindFirst/Next/Close. */
struct _finddata_t {
    unsigned attrib;
    long     time_create, time_access, time_write;
    long     size;
    char     name[260];
};
#define _A_NORMAL 0x00
#define _A_RDONLY 0x01
#define _A_HIDDEN 0x02
#define _A_SYSTEM 0x04
#define _A_SUBDIR 0x10
#define _A_ARCH   0x20
long _findfirst(const char *spec, struct _finddata_t *info);
int  _findnext(long handle, struct _finddata_t *info);
int  _findclose(long handle);

/* _getcwd, _stricmp and _strnicmp live in headers.js beside the twins they alias. */

/* The x87 control word. _PC_24 asks for single precision; see the note in src/env/win32.c. */
#define _MCW_PC        0x00030000
#define _PC_24         0x00020000
#define _PC_53         0x00010000
#define _PC_64         0x00000000
#define _MCW_EM        0x0008001F
#define _EM_ZERODIVIDE 0x00000004
#define _EM_INVALID    0x00000010
unsigned int _controlfp(unsigned int newval, unsigned int mask);
void _endthreadex(unsigned int code);
unsigned long _beginthreadex(void *sec, unsigned stack, unsigned (*start)(void *),
                             void *arg, unsigned flags, unsigned *id);
UINT WINAPI GetDriveType(LPCSTR root);

/*
 * Eight entry points src/env/win32.c implements and this header did not declare -- which is not the
 * same thing, and the difference cost a diagnosis: an implemented-but-undeclared function leaves the
 * CALLER unemittable, so sys_win.c:Sys_ScanForCD went on throwing "unimplemented" while
 * SetErrorMode sat there defined. In this design the declaration and the definition are two files;
 * doing one is doing half.
 */
UINT  WINAPI SetErrorMode(UINT mode);
DWORD WINAPI FormatMessage(DWORD flags, const void *src, DWORD id, DWORD lang,
                           LPSTR buf, DWORD size, void *args);
BOOL  WINAPI RegisterHotKey(HWND w, int id, UINT mods, UINT vk);
BOOL  WINAPI UnregisterHotKey(HWND w, int id);
void  WINAPI OutputDebugString(LPCSTR text);
DWORD WINAPI timeBeginPeriod(UINT period);
DWORD WINAPI timeEndPeriod(UINT period);

#endif

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
  /*
   * winsock.h, and there used to be TWO of these keys.
   *
   * One said '#include <winsock2.h>' (written for PuTTY); the other, added later for winquake.h,
   * re-declared thirteen names of its own. In a JavaScript object literal the LAST key silently
   * wins, so the fuller one had been discarded ever since -- and the narrow one does not declare
   * fd_set, which is what Quake II's net_wins.c:717 needs for NET_Sleep. A duplicate key is not a
   * merge; it is a deletion that reads like an addition.
   *
   * Measured before merging: winsock2.h declares 88 names and covers every one of the narrow
   * entry's except a single macro, kept below. So this is now one key.
   */
  'winsock.h': `#include <winsock2.h>
/* winquake.h calls MAKEWORD to build its version word; this is that macro under a name that cannot
   collide with the windows.h one. */
#ifndef MAKEWORD_WSA
#define MAKEWORD_WSA(a,b) ((unsigned short)(((unsigned char)(a))|(((unsigned short)((unsigned char)(b)))<<8)))
#endif
`,
  'dsound.h': `
#ifndef _PRISM_DSOUND_H
#define _PRISM_DSOUND_H
#include <windows.h>

/*
 * dsound.h.
 *
 * THIS HEADER USED TO BE TWO TYPEDEFS, and the comment justifying that said snd_win.c was not in the
 * unit list. That justification is gone, undone by a correction on the other side: this variant took
 * the tree's null sound driver at first, carried over from the Linux one, and S_Activate is defined
 * ONLY in win32/snd_win.c while win32/vid_dll.c calls it on every window activation. So the honest
 * Win32 build compiles snd_win.c, and the moment it did, the two typedefs were not enough. A stale
 * justification is worse than a missing declaration, so it is rewritten rather than left standing.
 *
 * What it declares is the surface snd_win.c reaches, measured: twelve vtable methods across the two
 * interfaces, the three descriptor structs by the fields the program touches, and nineteen
 * constants. NOTHING IMPLEMENTS ANY OF IT -- src/env/win32.c returns NULL from LoadLibrary, so the
 * program's own GetProcAddress on dsound.dll fails and it stands down to waveOut, which also fails.
 * That is the path a 1996 game took on a machine with no sound card, and it is the one taken here.
 *
 * The DSERR_ and DSBCAPS_ values are therefore UNOBSERVABLE, exactly as ddraw.h's DDERR_ ones are:
 * distinct constants so the program's comparisons compile, not measured numbers. If DirectSound is
 * ever implemented they become part of that contract and must be measured then.
 */
typedef struct IDirectSound       *LPDIRECTSOUND;
typedef struct IDirectSoundBuffer *LPDIRECTSOUNDBUFFER;

typedef struct _DSCAPS {
    DWORD dwSize;
    DWORD dwFlags;
    DWORD dwMinSecondarySampleRate, dwMaxSecondarySampleRate;
    DWORD dwPrimaryBuffers;
} DSCAPS, *LPDSCAPS;

typedef struct _DSBCAPS {
    DWORD dwSize;
    DWORD dwFlags;
    DWORD dwBufferBytes;
    DWORD dwUnlockTransferRate;
    DWORD dwPlayCpuOverhead;
} DSBCAPS, *LPDSBCAPS;

typedef struct _DSBUFFERDESC {
    DWORD dwSize;
    DWORD dwFlags;
    DWORD dwBufferBytes;
    DWORD dwReserved;
    LPWAVEFORMATEX lpwfxFormat;
} DSBUFFERDESC, *LPDSBUFFERDESC;

typedef struct IDirectSoundVtbl {
    HRESULT (WINAPI *QueryInterface)(LPDIRECTSOUND, void *, void **);
    DWORD   (WINAPI *AddRef)(LPDIRECTSOUND);
    DWORD   (WINAPI *Release)(LPDIRECTSOUND);
    HRESULT (WINAPI *CreateSoundBuffer)(LPDIRECTSOUND, LPDSBUFFERDESC,
                                        LPDIRECTSOUNDBUFFER *, void *);
    HRESULT (WINAPI *GetCaps)(LPDIRECTSOUND, LPDSCAPS);
    HRESULT (WINAPI *SetCooperativeLevel)(LPDIRECTSOUND, HWND, DWORD);
} IDirectSoundVtbl;
struct IDirectSound { IDirectSoundVtbl *lpVtbl; };

typedef struct IDirectSoundBufferVtbl {
    HRESULT (WINAPI *QueryInterface)(LPDIRECTSOUNDBUFFER, void *, void **);
    DWORD   (WINAPI *AddRef)(LPDIRECTSOUNDBUFFER);
    DWORD   (WINAPI *Release)(LPDIRECTSOUNDBUFFER);
    HRESULT (WINAPI *GetCaps)(LPDIRECTSOUNDBUFFER, LPDSBCAPS);
    HRESULT (WINAPI *GetCurrentPosition)(LPDIRECTSOUNDBUFFER, LPDWORD, LPDWORD);
    HRESULT (WINAPI *GetStatus)(LPDIRECTSOUNDBUFFER, LPDWORD);
    HRESULT (WINAPI *Lock)(LPDIRECTSOUNDBUFFER, DWORD, DWORD, void **, LPDWORD,
                           void **, LPDWORD, DWORD);
    HRESULT (WINAPI *Play)(LPDIRECTSOUNDBUFFER, DWORD, DWORD, DWORD);
    HRESULT (WINAPI *Restore)(LPDIRECTSOUNDBUFFER);
    HRESULT (WINAPI *SetFormat)(LPDIRECTSOUNDBUFFER, LPWAVEFORMATEX);
    HRESULT (WINAPI *Stop)(LPDIRECTSOUNDBUFFER);
    HRESULT (WINAPI *Unlock)(LPDIRECTSOUNDBUFFER, void *, DWORD, void *, DWORD);
} IDirectSoundBufferVtbl;
struct IDirectSoundBuffer { IDirectSoundBufferVtbl *lpVtbl; };

#define DS_OK                    0
#define DSERR_ALLOCATED          0x88780001L
#define DSERR_BUFFERLOST         0x88780002L
#define DSERR_INVALIDCALL        0x88780003L
#define DSERR_INVALIDPARAM       0x88780004L
#define DSERR_PRIOLEVELNEEDED    0x88780005L
#define DSSCL_NORMAL             1
#define DSSCL_PRIORITY           2
#define DSSCL_EXCLUSIVE          3
#define DSSCL_WRITEPRIMARY       4
#define DSBCAPS_PRIMARYBUFFER    0x00000001L
#define DSBCAPS_CTRLFREQUENCY    0x00000020L
#define DSBCAPS_LOCSOFTWARE      0x00000008L
#define DSBPLAY_LOOPING          0x00000001L
#define DSBSTATUS_PLAYING        0x00000001L
#define DSBSTATUS_BUFFERLOST     0x00000002L
#define DSCAPS_EMULDRIVER        0x00000020L

HRESULT WINAPI DirectSoundCreate(void *lpGuid, LPDIRECTSOUND *ppDS, void *pUnkOuter);
#endif
`,
  'ddraw.h': `
#ifndef _PRISM_DDRAW_H
#define _PRISM_DDRAW_H
#include <windows.h>

/*
 * ddraw.h, enough for win32/rw_ddraw.c to COMPILE -- which is the whole requirement, and saying so
 * is the point of this comment.
 *
 * rw_imp.c:147 calls DIB_Init unconditionally in SWimp_InitGraphics: the GDI surface is the path
 * Quake II's software renderer takes on this host, and the DirectDraw branch beside it is never
 * entered. But quake2.mak builds rw_ddraw.obj into ref_soft.dll, so that file is part of the build
 * id shipped and dropping it would be assembling one they did not. It therefore has to parse, and
 * DirectDrawCreate has to LINK -- it is declared here and refused at run time, which nothing
 * reaches.
 *
 * THE DDERR_ VALUES BELOW ARE NOT MEASURED. They are 86 distinct constants because that is what a
 * switch over them needs; nothing in PRISM produces a DirectDraw result, so which number each one
 * carries is unobservable. If a real DirectDraw shim is ever written they stop being arbitrary and
 * become part of its contract -- and they must be measured then, from a real header, exactly as
 * every other number in this file was.
 *
 * The struct members are the ones the program TOUCHES, under the names it uses: ddsd.lPitch,
 * ddsd.lpSurface, ddsd.ddsCaps.dwCaps. Several of those are union members in the real API; that
 * distinction is unobservable to a program that only ever names these.
 */

typedef struct _DDSCAPS { DWORD dwCaps; } DDSCAPS, *LPDDSCAPS;

typedef struct _DDSURFACEDESC {
    DWORD   dwSize;
    DWORD   dwFlags;
    DWORD   dwHeight;
    DWORD   dwWidth;
    LONG    lPitch;
    DWORD   dwBackBufferCount;
    void   *lpSurface;
    DDSCAPS ddsCaps;
} DDSURFACEDESC, *LPDDSURFACEDESC;

typedef struct _DDCAPS { DWORD dwSize; DWORD dwCaps; } DDCAPS, *LPDDCAPS;

/*
 * The three interfaces, as C sees COM: an object whose first member points at a table of function
 * pointers. Only the methods rw_ddraw.c calls through lpVtbl-> are declared, plus Release, which it
 * calls on all three.
 */
struct IDirectDraw;
struct IDirectDrawSurface;
struct IDirectDrawPalette;
typedef struct IDirectDraw        *LPDIRECTDRAW;
typedef struct IDirectDrawSurface *LPDIRECTDRAWSURFACE;
typedef struct IDirectDrawPalette *LPDIRECTDRAWPALETTE;

typedef struct IDirectDrawVtbl {
    HRESULT (WINAPI *QueryInterface)(LPDIRECTDRAW, void *, void **);
    DWORD   (WINAPI *AddRef)(LPDIRECTDRAW);
    DWORD   (WINAPI *Release)(LPDIRECTDRAW);
    HRESULT (WINAPI *CreatePalette)(LPDIRECTDRAW, DWORD, LPPALETTEENTRY,
                                    LPDIRECTDRAWPALETTE *, void *);
    HRESULT (WINAPI *CreateSurface)(LPDIRECTDRAW, LPDDSURFACEDESC,
                                    LPDIRECTDRAWSURFACE *, void *);
    HRESULT (WINAPI *GetCaps)(LPDIRECTDRAW, LPDDCAPS, LPDDCAPS);
    HRESULT (WINAPI *RestoreDisplayMode)(LPDIRECTDRAW);
    HRESULT (WINAPI *SetCooperativeLevel)(LPDIRECTDRAW, HWND, DWORD);
    HRESULT (WINAPI *SetDisplayMode)(LPDIRECTDRAW, DWORD, DWORD, DWORD);
} IDirectDrawVtbl;
struct IDirectDraw { IDirectDrawVtbl *lpVtbl; };

typedef struct IDirectDrawSurfaceVtbl {
    HRESULT (WINAPI *QueryInterface)(LPDIRECTDRAWSURFACE, void *, void **);
    DWORD   (WINAPI *AddRef)(LPDIRECTDRAWSURFACE);
    DWORD   (WINAPI *Release)(LPDIRECTDRAWSURFACE);
    HRESULT (WINAPI *GetAttachedSurface)(LPDIRECTDRAWSURFACE, LPDDSCAPS,
                                         LPDIRECTDRAWSURFACE *);
    HRESULT (WINAPI *Lock)(LPDIRECTDRAWSURFACE, LPRECT, LPDDSURFACEDESC, DWORD, HANDLE);
    HRESULT (WINAPI *Unlock)(LPDIRECTDRAWSURFACE, void *);
    HRESULT (WINAPI *SetPalette)(LPDIRECTDRAWSURFACE, LPDIRECTDRAWPALETTE);
    /*
     * Two more, and they were in my first measurement of this file's vtable calls -- I read BltFast
     * and GetCaps as ordinary member names and left them out. The compiler found both, which is the
     * right outcome and a reminder that a list of methods is not a list of guesses.
     */
    HRESULT (WINAPI *BltFast)(LPDIRECTDRAWSURFACE, DWORD, DWORD, LPDIRECTDRAWSURFACE,
                              LPRECT, DWORD);
    HRESULT (WINAPI *GetCaps)(LPDIRECTDRAWSURFACE, LPDDSCAPS);
    HRESULT (WINAPI *Flip)(LPDIRECTDRAWSURFACE, LPDIRECTDRAWSURFACE, DWORD);
    HRESULT (WINAPI *Restore)(LPDIRECTDRAWSURFACE);
} IDirectDrawSurfaceVtbl;
struct IDirectDrawSurface { IDirectDrawSurfaceVtbl *lpVtbl; };

typedef struct IDirectDrawPaletteVtbl {
    HRESULT (WINAPI *QueryInterface)(LPDIRECTDRAWPALETTE, void *, void **);
    DWORD   (WINAPI *AddRef)(LPDIRECTDRAWPALETTE);
    DWORD   (WINAPI *Release)(LPDIRECTDRAWPALETTE);
    HRESULT (WINAPI *SetEntries)(LPDIRECTDRAWPALETTE, DWORD, DWORD, DWORD, LPPALETTEENTRY);
} IDirectDrawPaletteVtbl;
struct IDirectDrawPalette { IDirectDrawPaletteVtbl *lpVtbl; };

/* The flags rw_ddraw.c passes, and the one result it compares against. */
#define DD_OK                        0
#define DDSD_CAPS                    0x00000001L
#define DDSD_HEIGHT                  0x00000002L
#define DDSD_WIDTH                   0x00000004L
#define DDSD_BACKBUFFERCOUNT         0x00000020L
#define DDSCAPS_PRIMARYSURFACE       0x00000200L
#define DDSCAPS_OFFSCREENPLAIN       0x00000040L
#define DDSCAPS_SYSTEMMEMORY         0x00000800L
#define DDSCAPS_BACKBUFFER           0x00000004L
#define DDSCAPS_COMPLEX              0x00000008L
#define DDSCAPS_FLIP                 0x00000010L
#define DDSCAPS_MODEX                0x00200000L
#define DDSCL_EXCLUSIVE              0x00000010L
#define DDSCL_FULLSCREEN             0x00000001L
#define DDSCL_NORMAL                 0x00000008L
#define DDSCL_ALLOWMODEX             0x00000040L
#define DDSCL_NOWINDOWCHANGES        0x00000004L
#define DDLOCK_WAIT                  0x00000001L
#define DDFLIP_WAIT                  0x00000001L
#define DDBLTFAST_WAIT               0x00000010L
#define DDPCAPS_8BIT                 0x00000004L
#define DDPCAPS_ALLOW256             0x00000040L

/* The 86 result codes rw_ddraw.c's error-to-string switch names. See the warning above. */
/*
 * Four names my extraction MISSED, and the reason is worth keeping: it matched DDERR_[A-Z_]+, a
 * character class with no digits, so every code with a numeral in it was invisible to the tool that
 * was supposed to find them all. Found later by measuring the whole layer instead.
 */
#define DDERR_NO3D                             0x88760101L
#define DDERR_NOT4BITCOLOR                     0x88760102L
#define DDERR_NOT4BITCOLORINDEX                0x88760103L
#define DDERR_NOT8BITCOLOR                     0x88760104L
#define DDERR_ALREADYINITIALIZED               0x88760001L
#define DDERR_BLTFASTCANTCLIP                  0x88760002L
#define DDERR_CANNOTATTACHSURFACE              0x88760003L
#define DDERR_CANNOTDETACHSURFACE              0x88760004L
#define DDERR_CANTCREATEDC                     0x88760005L
#define DDERR_CANTDUPLICATE                    0x88760006L
#define DDERR_CLIPPERISUSINGHWND               0x88760007L
#define DDERR_COLORKEYNOTSET                   0x88760008L
#define DDERR_CURRENTLYNOTAVAIL                0x88760009L
#define DDERR_DIRECTDRAWALREADYCREATED         0x8876000aL
#define DDERR_EXCEPTION                        0x8876000bL
#define DDERR_EXCLUSIVEMODEALREADYSET          0x8876000cL
#define DDERR_GENERIC                          0x8876000dL
#define DDERR_HEIGHTALIGN                      0x8876000eL
#define DDERR_HWNDALREADYSET                   0x8876000fL
#define DDERR_HWNDSUBCLASSED                   0x88760010L
#define DDERR_IMPLICITLYCREATED                0x88760011L
#define DDERR_INCOMPATIBLEPRIMARY              0x88760012L
#define DDERR_INVALIDCAPS                      0x88760013L
#define DDERR_INVALIDCLIPLIST                  0x88760014L
#define DDERR_INVALIDDIRECTDRAWGUID            0x88760015L
#define DDERR_INVALIDMODE                      0x88760016L
#define DDERR_INVALIDOBJECT                    0x88760017L
#define DDERR_INVALIDPARAMS                    0x88760018L
#define DDERR_INVALIDPIXELFORMAT               0x88760019L
#define DDERR_INVALIDPOSITION                  0x8876001aL
#define DDERR_INVALIDRECT                      0x8876001bL
#define DDERR_LOCKEDSURFACES                   0x8876001cL
#define DDERR_NOALPHAHW                        0x8876001dL
#define DDERR_NOBLTHW                          0x8876001eL
#define DDERR_NOCLIPLIST                       0x8876001fL
#define DDERR_NOCLIPPERATTACHED                0x88760020L
#define DDERR_NOCOLORCONVHW                    0x88760021L
#define DDERR_NOCOLORKEY                       0x88760022L
#define DDERR_NOCOLORKEYHW                     0x88760023L
#define DDERR_NOCOOPERATIVELEVELSET            0x88760024L
#define DDERR_NODC                             0x88760025L
#define DDERR_NODDROPSHW                       0x88760026L
#define DDERR_NODIRECTDRAWHW                   0x88760027L
#define DDERR_NOEMULATION                      0x88760028L
#define DDERR_NOEXCLUSIVEMODE                  0x88760029L
#define DDERR_NOFLIPHW                         0x8876002aL
#define DDERR_NOGDI                            0x8876002bL
#define DDERR_NOHWND                           0x8876002cL
#define DDERR_NOMIRRORHW                       0x8876002dL
#define DDERR_NOOVERLAYDEST                    0x8876002eL
#define DDERR_NOOVERLAYHW                      0x8876002fL
#define DDERR_NOPALETTEATTACHED                0x88760030L
#define DDERR_NOPALETTEHW                      0x88760031L
#define DDERR_NORASTEROPHW                     0x88760032L
#define DDERR_NOROTATIONHW                     0x88760033L
#define DDERR_NOSTRETCHHW                      0x88760034L
#define DDERR_NOTAOVERLAYSURFACE               0x88760035L
#define DDERR_NOTEXTUREHW                      0x88760036L
#define DDERR_NOTFLIPPABLE                     0x88760037L
#define DDERR_NOTFOUND                         0x88760038L
#define DDERR_NOTLOCKED                        0x88760039L
#define DDERR_NOTPALETTIZED                    0x8876003aL
#define DDERR_NOVSYNCHW                        0x8876003bL
#define DDERR_NOZBUFFERHW                      0x8876003cL
#define DDERR_NOZOVERLAYHW                     0x8876003dL
#define DDERR_OUTOFCAPS                        0x8876003eL
#define DDERR_OUTOFMEMORY                      0x8876003fL
#define DDERR_OUTOFVIDEOMEMORY                 0x88760040L
#define DDERR_OVERLAYCANTCLIP                  0x88760041L
#define DDERR_OVERLAYCOLORKEYONLYONEACTIVE     0x88760042L
#define DDERR_OVERLAYNOTVISIBLE                0x88760043L
#define DDERR_PALETTEBUSY                      0x88760044L
#define DDERR_PRIMARYSURFACEALREADYEXISTS      0x88760045L
#define DDERR_REGIONTOOSMALL                   0x88760046L
#define DDERR_SURFACEALREADYATTACHED           0x88760047L
#define DDERR_SURFACEALREADYDEPENDENT          0x88760048L
#define DDERR_SURFACEBUSY                      0x88760049L
#define DDERR_SURFACEISOBSCURED                0x8876004aL
#define DDERR_SURFACELOST                      0x8876004bL
#define DDERR_SURFACENOTATTACHED               0x8876004cL
#define DDERR_TOOBIGHEIGHT                     0x8876004dL
#define DDERR_TOOBIGSIZE                       0x8876004eL
#define DDERR_TOOBIGWIDTH                      0x8876004fL
#define DDERR_UNSUPPORTED                      0x88760050L
#define DDERR_UNSUPPORTEDFORMAT                0x88760051L
#define DDERR_UNSUPPORTEDMASK                  0x88760052L
#define DDERR_VERTICALBLANKINPROGRESS          0x88760053L
#define DDERR_WASSTILLDRAWING                  0x88760054L
#define DDERR_WRONGMODE                        0x88760055L
#define DDERR_XALIGN                           0x88760056L

HRESULT WINAPI DirectDrawCreate(void *lpGUID, LPDIRECTDRAW *lplpDD, void *pUnkOuter);
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
