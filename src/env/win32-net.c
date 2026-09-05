/*
 * win32-net.c -- Winsock, present but with nothing behind it.
 *
 * This is the same answer PRISM gives a program that looks for a CD drive or a sound card: the
 * INTERFACE is there and reports honestly that the device is not. WSAStartup succeeds, because the
 * library really is loaded; socket() fails with WSAENETDOWN, because there is no network. A program
 * gets its own error path rather than a fake connection or a crash, and PuTTY's is worth reaching --
 * without this, sk_init calls modalfatalbox("Unable to load any WinSock library") and PuTTYtel exits
 * before it has drawn anything at all.
 *
 * The export table below is how GetProcAddress finds these: PuTTY loads every winsock entry point by
 * name. win32-app.c picks the table up through an `extern` that a target without this file simply
 * never defines -- which PRISM reads as zero, the way a linker would.
 */

#include <stddef.h>
#include <string.h>
#include <windows.h>
#include <winsock2.h>

static int prism_wsa_error = 0;

int WINAPI WSAGetLastError(void) { return prism_wsa_error; }
void WINAPI WSASetLastError(int e) { prism_wsa_error = e; }

int WINAPI WSAStartup(WORD version, LPWSADATA data)
{
    if (!data) return WSAEFAULT;
    memset(data, 0, sizeof(*data));
    /* Report back exactly the version asked for, which is what a real stack does up to 2.2. */
    data->wVersion = version;
    data->wHighVersion = MAKEWORD(2, 2);
    strcpy(data->szDescription, "PRISM Winsock (no network)");
    strcpy(data->szSystemStatus, "No network device");
    data->iMaxSockets = 0;
    data->iMaxUdpDg = 0;
    return 0;
}
int WINAPI WSACleanup(void) { return 0; }

/* Byte order is arithmetic, and this target is little-endian. These are real, not refusals. */
u_short WINAPI htons(u_short v) { return (u_short)((v << 8) | (v >> 8)); }
u_short WINAPI ntohs(u_short v) { return htons(v); }
u_long WINAPI htonl(u_long v)
{
    return ((v & 0xFFUL) << 24) | ((v & 0xFF00UL) << 8) | ((v >> 8) & 0xFF00UL) | ((v >> 24) & 0xFFUL);
}
u_long WINAPI ntohl(u_long v) { return htonl(v); }

/* Everything that would touch a wire. */
static int down(void) { prism_wsa_error = WSAENETDOWN; return SOCKET_ERROR; }

SOCKET WINAPI socket(int af, int type, int proto)
{ (void)af; (void)type; (void)proto; prism_wsa_error = WSAENETDOWN; return INVALID_SOCKET; }
int WINAPI closesocket(SOCKET s) { (void)s; return 0; }
int WINAPI connect(SOCKET s, const struct sockaddr *a, int len) { (void)s; (void)a; (void)len; return down(); }
int WINAPI bind(SOCKET s, const struct sockaddr *a, int len) { (void)s; (void)a; (void)len; return down(); }
int WINAPI listen(SOCKET s, int n) { (void)s; (void)n; return down(); }
int WINAPI recv(SOCKET s, char *b, int n, int f) { (void)s; (void)b; (void)n; (void)f; return down(); }
int WINAPI send(SOCKET s, const char *b, int n, int f) { (void)s; (void)b; (void)n; (void)f; return down(); }
int WINAPI shutdown(SOCKET s, int how) { (void)s; (void)how; return down(); }
int WINAPI select(int n, fd_set *r, fd_set *w, fd_set *e, const struct timeval *t)
{ (void)n; (void)r; (void)w; (void)e; (void)t; return 0; }
int WINAPI ioctlsocket(SOCKET s, long cmd, u_long *arg) { (void)s; (void)cmd; (void)arg; return down(); }
int WINAPI setsockopt(SOCKET s, int l, int o, const char *v, int n)
{ (void)s; (void)l; (void)o; (void)v; (void)n; return down(); }
int WINAPI getsockname(SOCKET s, struct sockaddr *a, int *n) { (void)s; (void)a; (void)n; return down(); }
int WINAPI getpeername(SOCKET s, struct sockaddr *a, int *n) { (void)s; (void)a; (void)n; return down(); }
int WINAPI WSAEnumNetworkEvents(SOCKET s, WSAEVENT h, LPWSANETWORKEVENTS out)
{ (void)s; (void)h; if (out) memset(out, 0, sizeof(*out)); return 0; }
int WINAPI WSAEventSelect(SOCKET s, WSAEVENT h, long ev) { (void)s; (void)h; (void)ev; return down(); }
int WINAPI WSAAsyncSelect(SOCKET s, HWND w, u_int m, long ev)
{ (void)s; (void)w; (void)m; (void)ev; return down(); }

struct hostent *WINAPI gethostbyname(const char *name)
{ (void)name; prism_wsa_error = WSAHOST_NOT_FOUND; return NULL; }
struct servent *WINAPI getservbyname(const char *name, const char *proto)
{ (void)name; (void)proto; prism_wsa_error = WSAHOST_NOT_FOUND; return NULL; }
int WINAPI getaddrinfo(const char *node, const char *service,
                       const struct addrinfo *hints, struct addrinfo **out)
{ (void)node; (void)service; (void)hints; if (out) *out = NULL; return WSAHOST_NOT_FOUND; }
void WINAPI freeaddrinfo(struct addrinfo *ai) { (void)ai; }
u_long WINAPI inet_addr(const char *s) { (void)s; return INADDR_NONE; }
char *WINAPI inet_ntoa(struct in_addr a) { (void)a; return (char *)"0.0.0.0"; }
int WINAPI gethostname(char *buf, int n)
{
    const char *h = "prism";
    if (n <= (int)strlen(h)) return down();
    strcpy(buf, h);
    return 0;
}

/*
 * What GetProcAddress can find. PuTTY resolves every one of these by name, and a NULL for the ones
 * it type-checks is fatal, so the table has to cover what sk_init asks for -- not what a full stack
 * would export.
 */
struct prism_export { const char *module; const char *name; void *fn; };
static const struct prism_export prism_all_exports[] = {
    { "ws2_32.dll", "WSAStartup",           (void *)WSAStartup },
    { "ws2_32.dll", "WSACleanup",           (void *)WSACleanup },
    { "ws2_32.dll", "WSAGetLastError",      (void *)WSAGetLastError },
    { "ws2_32.dll", "WSASetLastError",      (void *)WSASetLastError },
    { "ws2_32.dll", "WSAEnumNetworkEvents", (void *)WSAEnumNetworkEvents },
    { "ws2_32.dll", "WSAEventSelect",       (void *)WSAEventSelect },
    { "ws2_32.dll", "WSAAsyncSelect",       (void *)WSAAsyncSelect },
    { "ws2_32.dll", "select",               (void *)select },
    { "ws2_32.dll", "socket",               (void *)socket },
    { "ws2_32.dll", "closesocket",          (void *)closesocket },
    { "ws2_32.dll", "connect",              (void *)connect },
    { "ws2_32.dll", "bind",                 (void *)bind },
    { "ws2_32.dll", "listen",               (void *)listen },
    { "ws2_32.dll", "recv",                 (void *)recv },
    { "ws2_32.dll", "send",                 (void *)send },
    { "ws2_32.dll", "shutdown",             (void *)shutdown },
    { "ws2_32.dll", "ioctlsocket",          (void *)ioctlsocket },
    { "ws2_32.dll", "setsockopt",           (void *)setsockopt },
    { "ws2_32.dll", "getsockname",          (void *)getsockname },
    { "ws2_32.dll", "getpeername",          (void *)getpeername },
    { "ws2_32.dll", "gethostbyname",        (void *)gethostbyname },
    { "ws2_32.dll", "getservbyname",        (void *)getservbyname },
    { "ws2_32.dll", "getaddrinfo",          (void *)getaddrinfo },
    { "ws2_32.dll", "freeaddrinfo",         (void *)freeaddrinfo },
    { "ws2_32.dll", "inet_addr",            (void *)inet_addr },
    { "ws2_32.dll", "inet_ntoa",            (void *)inet_ntoa },
    { "ws2_32.dll", "gethostname",          (void *)gethostname },
    { "ws2_32.dll", "htons",                (void *)htons },
    { "ws2_32.dll", "ntohs",                (void *)ntohs },
    { "ws2_32.dll", "htonl",                (void *)htonl },
    { "ws2_32.dll", "ntohl",                (void *)ntohl },

    { "comctl32.dll", "InitCommonControls", (void *)InitCommonControls },
    { "comctl32.dll", "MakeDragList",       (void *)MakeDragList },
    { "comctl32.dll", "DrawInsert",         (void *)DrawInsert },
    { "comctl32.dll", "LBItemFromPt",       (void *)LBItemFromPt },
};

/*
 * comctl32, which PuTTY also loads by name and then calls UNCONDITIONALLY: controls.c's
 * init_common_controls ends with p_InitCommonControls(), no null check. So these have to be
 * findable, and the drag-list ones are the honest no-answers -- a list box that reports no item
 * under the cursor and draws no insertion mark is what a list box nobody is dragging looks like.
 */
void WINAPI InitCommonControls(void) { }
BOOL WINAPI MakeDragList(HWND lb) { (void)lb; return 1; }
void WINAPI DrawInsert(HWND parent, HWND lb, int item) { (void)parent; (void)lb; (void)item; }
int WINAPI LBItemFromPt(HWND lb, POINT pt, BOOL autoscroll)
{ (void)lb; (void)pt; (void)autoscroll; return -1; }


/*
 * ONE published table, because a static initialiser cannot concatenate two arrays and the extern
 * that win32-app.c reads is a single pointer. Keeping them as separate arrays above and copying
 * here would need a constructor; keeping one array and grouping by module inside it does not.
 */
const struct prism_export *prism_extra_exports = prism_all_exports;
const int prism_extra_export_count = (int)(sizeof(prism_all_exports) / sizeof(prism_all_exports[0]));
