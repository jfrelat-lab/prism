// popen.js — starting another program, when there is another program to start.
//
// `popen` is normally the one call a single-address-space host cannot answer honestly, so PRISM's
// stubbed it. Doom makes that a problem rather than a footnote:
//
//     sndserver = popen(buffer, "w");                       // i_sound.c, under #ifdef SNDSERV
//     fprintf(sndserver, "p%2.2x%2.2x%2.2x%2.2x\n", …);
//
// The program on the other end is `corpus/DOOM/sndserv/`, it is 2,026 lines of C, and PRISM compiles
// it. What was missing was not the ability to run it but a way for the two to be connected — so this
// does not START anything. The caller has already started the other program (a worker thread, a
// second Worker) and hands over the pipe; `popen` matches a command line to one of them and returns a
// FILE* whose writes go into it.
//
// Matching on the command line rather than on a name is deliberate: what Doom passes is
// `"./sndserver -quiet"` or `"$DOOMWADDIR/./sndserver -quiet"` depending on the environment, and the
// host should recognise the program it was asked for however the program spelled it.

import { pipeWriter } from './pipe.js';

const PIPE_BASE = 0x7400_0001;      // FILE* tokens no file store will ever hand out

/**
 * @param pipes [{ match: RegExp|string, sab }] — a command pattern and the pipe to its stdin.
 */
export function installPopen(M, { pipes = [] } = {}) {
  M.streamSinks ??= new Map();
  const open = new Map();           // FILE* token -> { writer, buffered }
  let next = PIPE_BASE;

  const matches = (pat, cmd) => (pat instanceof RegExp ? pat.test(cmd) : cmd.includes(pat));

  M.rt.popen = (cmdPtr, modePtr) => {
    const cmd = M.mod.cstr(cmdPtr);
    const mode = M.mod.cstr(modePtr);
    const p = pipes.find(x => matches(x.match, cmd));
    /*
     * No match, or a read pipe: FAIL, and let the program's own error path run. Doom's is
     * `fprintf(stderr, "Could not start sound server [%s]\n", buffer)` and then silence -- a correct
     * outcome for a host with no sound server, and far better than a FILE* that swallows.
     */
    if (!p || !mode.includes('w')) return 0;
    const fp = next++;
    const writer = pipeWriter(p.sab);
    const rec = { writer, cmd, bytes: 0 };
    open.set(fp, rec);
    // One byte at a time, because that is the granularity stdio hands over. The pipe's own ring is
    // where batching would belong, and at a few bytes per sound effect it would buy nothing.
    M.streamSinks.set(fp, (b) => { writer.write(Uint8Array.of(b)); rec.bytes++; });
    return fp;
  };

  /*
   * `access(path, X_OK)` on a command this host CAN start answers yes, because it can:
   *
   *     if (!access(buffer, X_OK)) { strcat(buffer, " -quiet"); sndserver = popen(buffer, "w"); }
   *     else fprintf(stderr, "Could not start sound server [%s]\n", buffer);
   *
   * Doom checks before it opens, and without this the check failed, the else branch ran, and the
   * pipe was never created -- a silent, correct-looking "no sound server" for a host that had one
   * running in another thread.
   */
  const prevAccess = M.rt.access;
  M.rt.access = (namePtr, mode) => {
    const name = M.mod.cstr(namePtr);
    if (pipes.some(x => matches(x.match, name))) return 0;
    return prevAccess ? prevAccess(namePtr, mode) : -1;
  };

  M.rt.pclose = (fp) => {
    const f = fp | 0;
    if (!open.has(f)) return -1;
    open.delete(f);
    M.streamSinks.delete(f);
    return 0;
  };

  return { get open() { return [...open.values()]; } };
}
