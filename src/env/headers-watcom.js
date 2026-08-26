// headers-watcom.js — the headers a Watcom/DOS4GW program includes.
//
// Written for Raven's Heretic and Hexen, whose whole machine dependence is `I_IBM.C`. Every
// declaration here is named by that file; nothing is anticipated.
//
// The one that matters is `union REGS`. Watcom's 32-bit REGS is three views of the SAME sixteen
// bytes — `x.eax`, `w.ax`, `h.al` — and I_IBM.C uses all three on the same variable, sometimes in
// consecutive statements. Declaring it as a union of three structs is not a convenience: it is the
// contract, and src/env/watcom.js reads the same offsets from the other side.

const DOSH_WATCOM = `
#ifndef _PRISM_WATCOM_DOS_H
#define _PRISM_WATCOM_DOS_H
#include <pc.h>

struct DWORDREGS { unsigned eax, ebx, ecx, edx, esi, edi, cflag; };
struct WORDREGS  { unsigned short ax, _1, bx, _2, cx, _3, dx, _4, si, _5, di, _6, cflag, _7; };
struct BYTEREGS  { unsigned char al, ah, _a1, _a2, bl, bh, _b1, _b2,
                                 cl, ch, _c1, _c2, dl, dh, _d1, _d2; };
union REGS { struct DWORDREGS x; struct WORDREGS w; struct BYTEREGS h; };
struct SREGS { unsigned short es, cs, ss, ds, fs, gs; };

int  int386(int inter_no, const union REGS *in, union REGS *out);
int  int386x(int inter_no, const union REGS *in, union REGS *out, struct SREGS *seg);
void segread(struct SREGS *seg);

/*
 * The interrupt vector table. A handler is recorded rather than installed -- and recorded rather
 * than dropped, because a recorded handler can be CALLED, which is how this host delivers an
 * interrupt at all. See deliverKeyboard in src/env/watcom.js.
 */
typedef void (*__prism_isr)(void);
void _dos_setvect(unsigned interrupt_no, __prism_isr handler);
__prism_isr _dos_getvect(unsigned interrupt_no);
void _dos_irqenable(unsigned irq);
void _dos_irqdisable(unsigned irq);
void _enable(void);
void _disable(void);
int  _dpmi_lockregion(void *address, unsigned length);
int  _dpmi_unlockregion(void *address, unsigned length);
void delay(unsigned msec);
/*
 * Far-pointer decomposition in a FLAT model, where there is nothing to decompose: the offset is the
 * whole pointer and the segment is the one selector everything lives in. Heretic passes FP_OFF/
 * FP_SEG straight to a DPMI call that this host answers itself, so the values only have to round
 * trip -- which they do.
 */
#define FP_OFF(p)   ((unsigned)(p))
#define FP_SEG(p)   ((unsigned)0)
#define MK_FP(s, o) ((void *)(o))
#endif
`;

/* Watcom's text-mode console, used only for the start-up banner. */
const GRAPH_H = `
#ifndef _PRISM_GRAPH_H
#define _PRISM_GRAPH_H
#define _TEXTC80 3
#define _GCLEARSCREEN 0
#define _GWINDOW 1
#define _GVIEWPORT 2
void _settextposition(int row, int col);
void _settextwindow(int r1, int c1, int r2, int c2);
int  _setvideomode(int mode);
int  _settextcolor(int color);
long _setbkcolor(long color);
void _clearscreen(int target);
void _outtext(const char *text);
void _settextcursor(int attr);
void _setcursortype(int t);
#endif
`;

const CONIO_H = `
#ifndef _PRISM_CONIO_H
#define _PRISM_CONIO_H
#include <pc.h>
int getch(void);
int kbhit(void);
int putch(int c);
int cprintf(const char *fmt, ...);
#endif
`;

/*
 * DMX, the sound library Heretic and Hexen link -- the same kind of boundary as SEAL for MAME, and
 * declared for the same reason: `I_SOUND.C` is the game's own code and must compile.
 *
 * Silence, honestly reported. Every entry point returns a value the caller treats as success,
 * because a library that fails would send I_InitSound down an error path the game has no other
 * answer for.
 */
const DMX_H = `
#ifndef _PRISM_DMX_H
#define _PRISM_DMX_H
#define AHW_AUTO_DETECT   0
#define AHW_PC_SPEAKER    1
#define AHW_ADLIB         2
#define AHW_SOUND_BLASTER 4
#define AHW_PRO_AUDIO     8
#define AHW_ULTRA_SOUND   16
#define AHW_MPU_401       32
#define AHW_MEDIA_VISION  64
#define AHW_AWE32         128
#define SNDSCAPE          0
typedef struct { int a; } dmx_stub_t;
int  DMX_Init(int rate, int songs, int mididev, int sfxdev);
void DMX_DeInit(void);
int  GF1_Detect(void);
void GF1_SetMap(char *data, int len);
void WAV_PlayMode(int channels, int samplerate);
int  SFX_PlayPatch(void *vdata, int pitch, int sep, int vol, int unused, int unused2);
void SFX_StopPatch(int handle);
int  SFX_Playing(int handle);
void SFX_SetOrigin(int handle, int pitch, int sep, int vol);
int  MUS_RegisterSong(void *data);
void MUS_UnregisterSong(int handle);
int  MUS_PlaySong(int handle, int volume);
void MUS_StopSong(int handle);
void MUS_Pause(void);
void MUS_Resume(void);
void MUS_PauseSong(int handle);
void MUS_ResumeSong(int handle);
void MUS_SetMasterVolume(int volume);
int  MUS_QrySongPlaying(int handle);
void MUS_ChainSong(int handle, int next);
int  AL_Detect(int *wait, int *type);
void AL_SetCard(int wait, void *genmidi);
void CODEC_DetectDMA(void);
long DMX_Get(void);
int  SB_Detect(int *base, int *irq, int *dma, int *midi);
int  MPU_Detect(int *base, int *type);
void MPU_SetCard(int base);
void SB_SetCard(int base, int irq, int dma, int midi);
/*
 * TSM, DMX's timer-service manager: a program registers a function to be called at a rate, which is
 * the same interrupt problem as the keyboard. Registration is recorded, so a host that later has a
 * clock to drive it can call the service -- see deliverKeyboard in src/env/watcom.js for the
 * mechanism this would reuse.
 */
int  TSM_Install(int rate);
int  TSM_NewService(void (*service)(void), int rate, int priority, int pause);
void TSM_DelService(int handle);
void TSM_Remove(void);
#endif
`;

export const WATCOM_HEADERS = {
  'graph.h': GRAPH_H,
  'conio.h': CONIO_H,
  'dmx.h': DMX_H,
  'direct.h': '#ifndef _PRISM_DIRECT_H\n#define _PRISM_DIRECT_H\nint chdir(const char *p);\nint mkdir(const char *p);\n#endif\n',
};

/** The Watcom `dos.h`, kept apart because src/env/headers-djgpp.js also defines one. */
export const WATCOM_DOS_H = DOSH_WATCOM;

/**
 * The data the ASSEMBLY provides.
 *
 * `I_IBM_A.ASM` exports `_joystickx`, `_joysticky` and three interrupt helpers; PRISM does not
 * compile the assembly, so the C half of the program still needs them to exist. Real C definitions,
 * for the same reason Allegro's `key[]` is one: the program takes their address and reads them.
 *
 * The joystick reads as centred and untouched, which is what a machine with no joystick reports --
 * and I_JoystickEvents is guarded by `joystickpresent` anyway.
 */
export const WATCOM_VARS = `
unsigned joystickx, joysticky;
int I_ReadJoystick(void) { return 0; }
void I_SetDivException(void) { }
void I_DivException(void) { }
`;
