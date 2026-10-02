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
#include <stdlib.h>
#include <winsock2.h>

int prism_net_present = 1;          /* win32.c tests this before waiting or pumping */

static int prism_wsa_error = 0;

/* The socket thread's primitives -- src/env/wsock.js. Six calls, and nothing Winsock-shaped. */
extern int prism_net_open(void);
extern int prism_net_connect(int slot, const char *host, int port);
extern int prism_net_events(int slot);
extern int prism_net_state(int slot);
extern int prism_net_error(int slot);
extern int prism_net_recv(int slot, void *dst, int max);
extern int prism_net_send(int slot, const void *src, int len);
extern int prism_net_close(int slot);
extern void prism_win32_post(UINT message, WPARAM wParam, LPARAM lParam);

/*
 * A SOCKET is a slot plus one, so that slot 0 is not INVALID_SOCKET. Nothing outside this file may
 * assume anything about the value, which is exactly what a handle is.
 */
#define SLOT_OF(s)   ((int)(s) - 1)
#define SOCKET_OF(i) ((SOCKET)((i) + 1))

/*
 * WHAT AN ADDRESS IS HERE.
 *
 * The socket thread connects by NAME -- node's connect takes a hostname and does its own lookup --
 * but PuTTY resolves first and then connects to a sockaddr, so something has to carry the name from
 * one call to the other. That something is the address: getaddrinfo and gethostbyname hand back
 * 10.0.0.N, a token whose only meaning is "the Nth name this program asked about", and connect turns
 * it back into the name.
 *
 * It is a token and not a lie: no packet ever carries it, nothing outside this file interprets it,
 * and a program that prints it would print an address that is not the peer's. That last part is the
 * cost, and it is why this is written down rather than left to be discovered.
 */
#define MAX_NAMES 16
static char resolved[MAX_NAMES][256];
static int n_resolved;

static unsigned long token_for(const char *host)
{
    int i;
    for (i = 0; i < n_resolved; i++)
        if (!strcmp(resolved[i], host)) return 0x0A000000UL | (unsigned long)i;
    if (n_resolved >= MAX_NAMES) return 0;
    strncpy(resolved[n_resolved], host, sizeof(resolved[0]) - 1);
    resolved[n_resolved][sizeof(resolved[0]) - 1] = 0;
    return 0x0A000000UL | (unsigned long)(n_resolved++);
}
static const char *name_for(unsigned long token)
{
    unsigned long i = token & 0xFFFFFFUL;
    if ((token & 0xFF000000UL) != 0x0A000000UL || i >= (unsigned long)n_resolved) return 0;
    return resolved[i];
}

/* What WSAAsyncSelect asked for, per socket. */
#define MAX_SEL 8
static struct { HWND hwnd; UINT msg; long events; int used; } selects[MAX_SEL];

/*
 * Called before the message queue is looked at. Every socket that has done something since last
 * time becomes a WM_NETEVENT, which is how PuTTY hears about the network -- its whole client is
 * built on being told rather than on asking.
 */
void prism_net_pump(void)
{
    int i;
    for (i = 0; i < MAX_SEL; i++) {
        long ev;
        if (!selects[i].used) continue;
        ev = prism_net_events(i);
        if (!(ev & selects[i].events)) continue;
        {
            int err = prism_net_state(i) == 4 ? prism_net_error(i) : 0;
            /*
             * One message per EVENT -- WSAGETSELECTEVENT reports a single bit -- and IN THIS ORDER.
             *
             * Not ascending bit order, which is what a `for (bit = 1; bit; bit <<= 1)` gives and
             * which puts FD_WRITE (2) before FD_CONNECT (16): PuTTY then hears "you may write" about
             * a socket it does not yet believe is connected, and closes it. Windows reports the
             * connection first and the close last, and so does this.
             */
            static const long order[] = { FD_CONNECT, FD_ACCEPT, FD_OOB, FD_READ, FD_WRITE, FD_CLOSE };
            unsigned k;
            for (k = 0; k < sizeof(order) / sizeof(order[0]); k++) {
                long bit = order[k];
                if (!(ev & bit & selects[i].events)) continue;
                prism_win32_post(selects[i].msg, (WPARAM)SOCKET_OF(i),
                                 WSAMAKESELECTREPLY(bit, bit == FD_CONNECT ? err : 0));
            }
        }
    }
}

/* ---- the Winsock surface, over the six primitives above. */

int WINAPI WSAGetLastError(void) { return prism_wsa_error; }
void WINAPI WSASetLastError(int e) { prism_wsa_error = e; }

/* Winsock 1.1's blocking hooks. No call here blocks in the 1.1 sense, so there is never one to
   cancel, and the hook in place before any program set one is the default: NULL. */
int WINAPI WSACancelBlockingCall(void) { return 0; }
FARPROC WINAPI WSASetBlockingHook(FARPROC hook) { (void)hook; return (FARPROC)0; }
int WINAPI WSAUnhookBlockingHook(void) { return 0; }

int WINAPI WSAStartup(WORD version, LPWSADATA data)
{
    if (!data) return WSAEFAULT;
    memset(data, 0, sizeof(*data));
    data->wVersion = version;
    data->wHighVersion = MAKEWORD(2, 2);
    strcpy(data->szDescription, "PRISM Winsock over the host");
    strcpy(data->szSystemStatus, "Running");
    data->iMaxSockets = 8;
    return 0;
}
int WINAPI WSACleanup(void) { return 0; }

/* Byte order is arithmetic, and this target is little-endian. */
u_short WINAPI htons(u_short v) { return (u_short)((v << 8) | ((v >> 8) & 0xFF)); }
u_short WINAPI ntohs(u_short v) { return htons(v); }
u_long WINAPI htonl(u_long v)
{
    return ((v & 0xFFUL) << 24) | ((v & 0xFF00UL) << 8) | ((v >> 8) & 0xFF00UL) | ((v >> 24) & 0xFFUL);
}
u_long WINAPI ntohl(u_long v) { return htonl(v); }

static int fail(int err) { prism_wsa_error = err; return SOCKET_ERROR; }

SOCKET WINAPI socket(int af, int type, int proto)
{
    int slot;
    (void)proto;
    if (type != SOCK_STREAM) { prism_wsa_error = WSAESOCKTNOSUPPORT; return INVALID_SOCKET; }
    if (af != AF_INET && af != AF_INET6 && af != AF_UNSPEC) {
        prism_wsa_error = WSAEAFNOSUPPORT;
        return INVALID_SOCKET;
    }
    slot = prism_net_open();
    if (slot < 0) { prism_wsa_error = WSAEMFILE; return INVALID_SOCKET; }
    return SOCKET_OF(slot);
}

int WINAPI closesocket(SOCKET s)
{
    int i = SLOT_OF(s);
    if (i < 0 || i >= MAX_SEL) return fail(WSAENOTSOCK);
    selects[i].used = 0;
    prism_net_close(i);
    return 0;
}

/*
 * connect() reports WSAEWOULDBLOCK and means it: the socket thread does the work and the answer
 * arrives later as FD_CONNECT. That is not a shortcut -- it is what a non-blocking Winsock socket
 * does, and PuTTY's client is written for exactly that, which is why it asked for WSAAsyncSelect.
 */
int WINAPI connect(SOCKET s, const struct sockaddr *a, int len)
{
    int i = SLOT_OF(s);
    const struct sockaddr_in *in = (const struct sockaddr_in *)a;
    const char *host;
    (void)len;
    if (i < 0 || i >= MAX_SEL) return fail(WSAENOTSOCK);
    if (!a || in->sin_family != AF_INET) return fail(WSAEAFNOSUPPORT);
    host = name_for(ntohl(in->sin_addr.s_addr));
    if (!host) return fail(WSAEADDRNOTAVAIL);
    if (prism_net_connect(i, host, ntohs(in->sin_port)) != 0) return fail(WSAENETDOWN);
    prism_wsa_error = WSAEWOULDBLOCK;
    return SOCKET_ERROR;
}

int WINAPI recv(SOCKET s, char *b, int n, int f)
{
    int i = SLOT_OF(s), got;
    if (f & MSG_OOB) return fail(WSAEOPNOTSUPP);
    if (i < 0 || i >= MAX_SEL) return fail(WSAENOTSOCK);
    got = prism_net_recv(i, b, n);
    if (got > 0) return got;
    /* Nothing waiting is not end-of-stream: only a closed connection is. */
    if (prism_net_state(i) == 3 || prism_net_state(i) == 4) return 0;
    return fail(WSAEWOULDBLOCK);
}

int WINAPI send(SOCKET s, const char *b, int n, int f)
{
    int i = SLOT_OF(s);
    (void)f;
    if (i < 0 || i >= MAX_SEL) return fail(WSAENOTSOCK);
    return prism_net_send(i, b, n);
}

int WINAPI shutdown(SOCKET s, int how) { (void)how; return closesocket(s) == 0 ? 0 : SOCKET_ERROR; }

int WINAPI WSAAsyncSelect(SOCKET s, HWND w, u_int m, long ev)
{
    int i = SLOT_OF(s);
    if (i < 0 || i >= MAX_SEL) return fail(WSAENOTSOCK);
    selects[i].hwnd = w;
    selects[i].msg = m;
    selects[i].events = ev;
    selects[i].used = 1;
    return 0;
}

int WINAPI WSAEnumNetworkEvents(SOCKET s, WSAEVENT h, LPWSANETWORKEVENTS out)
{
    int i = SLOT_OF(s);
    (void)h;
    if (!out) return fail(WSAEFAULT);
    memset(out, 0, sizeof(*out));
    if (i < 0 || i >= MAX_SEL) return fail(WSAENOTSOCK);
    out->lNetworkEvents = prism_net_events(i);
    return 0;
}
int WINAPI WSAEventSelect(SOCKET s, WSAEVENT h, long ev) { (void)s; (void)h; (void)ev; return fail(WSAEOPNOTSUPP); }

/*
 * getaddrinfo and gethostbyname do not resolve. They REMEMBER: the socket thread connects by name,
 * so the address they hand back is a token that carries the name to connect(). See the note above.
 */
static struct addrinfo prism_ai;
static struct sockaddr_in prism_sa;

int WINAPI getaddrinfo(const char *node, const char *service,
                       const struct addrinfo *hints, struct addrinfo **out)
{
    unsigned long token;
    (void)hints;
    if (!node || !out) return WSAEFAULT;
    token = token_for(node);
    if (!token) return WSAHOST_NOT_FOUND;
    memset(&prism_sa, 0, sizeof(prism_sa));
    prism_sa.sin_family = AF_INET;
    prism_sa.sin_addr.s_addr = htonl(token);
    prism_sa.sin_port = htons((u_short)(service ? atoi(service) : 0));
    memset(&prism_ai, 0, sizeof(prism_ai));
    prism_ai.ai_family = AF_INET;
    prism_ai.ai_socktype = SOCK_STREAM;
    prism_ai.ai_protocol = IPPROTO_TCP;
    prism_ai.ai_addrlen = sizeof(prism_sa);
    prism_ai.ai_addr = (struct sockaddr *)&prism_sa;
    *out = &prism_ai;
    return 0;
}
void WINAPI freeaddrinfo(struct addrinfo *ai) { (void)ai; }

static unsigned long prism_h_addr;
static char *prism_h_list[2];
static struct hostent prism_he;

struct hostent *WINAPI gethostbyname(const char *name)
{
    unsigned long token = name ? token_for(name) : 0;
    if (!token) { prism_wsa_error = WSAHOST_NOT_FOUND; return 0; }
    prism_h_addr = htonl(token);
    prism_h_list[0] = (char *)&prism_h_addr;
    prism_h_list[1] = 0;
    prism_he.h_name = (char *)name;
    prism_he.h_aliases = 0;
    prism_he.h_addrtype = AF_INET;
    prism_he.h_length = 4;
    prism_he.h_addr_list = prism_h_list;
    return &prism_he;
}

/* The rest: present, and honest about doing nothing. PuTTY's client never needs them to succeed. */
/*
 * PuTTY binds the LOCAL end before connecting -- network.c does it on every outgoing socket, not
 * only when a local port was asked for. Binding to the any-address on port 0 is what the kernel
 * would have done anyway, so accepting it is the truthful answer; a bind to a SPECIFIC local port is
 * refused rather than silently ignored, because a program that asked for one would be misled.
 */
int WINAPI bind(SOCKET s, const struct sockaddr *a, int len)
{
    const struct sockaddr_in *in = (const struct sockaddr_in *)a;
    (void)s; (void)len;
    if (!a) return fail(WSAEFAULT);
    if (in->sin_family == AF_INET && in->sin_port == 0) return 0;
    return fail(WSAEOPNOTSUPP);
}
int WINAPI listen(SOCKET s, int n) { (void)s; (void)n; return fail(WSAEOPNOTSUPP); }
int WINAPI select(int n, fd_set *r, fd_set *w, fd_set *e, const struct timeval *t)
{ (void)n; (void)r; (void)w; (void)e; (void)t; return 0; }
int WINAPI ioctlsocket(SOCKET s, long cmd, u_long *arg)
{
    /* The only ioctl PuTTY issues is FIONBIO, and every socket here is already non-blocking. */
    (void)s; (void)arg;
    return cmd == (long)FIONBIO ? 0 : fail(WSAEOPNOTSUPP);
}
int WINAPI setsockopt(SOCKET s, int l, int o, const char *v, int n)
{ (void)s; (void)l; (void)o; (void)v; (void)n; return 0; }
int WINAPI getsockname(SOCKET s, struct sockaddr *a, int *n) { (void)s; (void)a; (void)n; return fail(WSAEOPNOTSUPP); }
int WINAPI getpeername(SOCKET s, struct sockaddr *a, int *n) { (void)s; (void)a; (void)n; return fail(WSAEOPNOTSUPP); }
struct servent *WINAPI getservbyname(const char *name, const char *proto)
{ (void)name; (void)proto; prism_wsa_error = WSAHOST_NOT_FOUND; return 0; }
u_long WINAPI inet_addr(const char *s) { (void)s; return INADDR_NONE; }
char *WINAPI inet_ntoa(struct in_addr a) { (void)a; return (char *)"0.0.0.0"; }
int WINAPI gethostname(char *buf, int n)
{
    const char *h = "prism";
    if (n <= (int)strlen(h)) return fail(WSAEFAULT);
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
