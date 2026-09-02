/*
 * quake-win-vars.c -- what the ASSEMBLER provides in a real WinQuake build.
 *
 * `sys_wina.s` exports five routines and `sys_win.c` already defines four of them in C for the
 * Windows target -- MaskExceptions, Sys_PushFPCW_SetHigh, Sys_PopFPCW and Sys_SetFPCW. Only the two
 * precision routines are assembly-only, so this is the DOS build's file minus everything WinQuake
 * writes itself; using that file whole reported four duplicate definitions, which is the linker
 * saying the same thing.
 *
 * They are empty for the reason the DOS ones are: both set the x87 control word, and PRISM computes
 * in doubles with no control word to set. Sys_LowFPPrecision asks for 24-bit mantissas instead of
 * 80; obeying it is neither possible here nor desirable, since it would move results AWAY from what
 * PRISM computes everywhere else.
 */
void Sys_LowFPPrecision(void) { }
void Sys_HighFPPrecision(void) { }
