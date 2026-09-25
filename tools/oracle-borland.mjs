// oracle-borland.mjs — Borland C++ as an oracle: compile a C program with BCC and RUN it, in DOSBox-X.
//
// The Watcom oracle (oracle.mjs watcom16) can only ask the compiler to FOLD constants, because nothing
// here ran a DOS executable -- and Watcom's folder turned out to have faults of its own (gate-int16).
// DOSBox-X does run DOS executables, so this one compiles with Borland's command-line compiler, links
// with Borland's own runtime library, runs the program, and returns what it printed: the program's
// behaviour, not the compiler's opinion of a constant.
//
// WHAT IT NEEDS, and none of it is in this repository: Borland C++ 3.1 (the archive.org `bcpp31`
// item, unpacked somewhere; its BIN/BCC.EXE) and dosbox-x on the PATH. PRISM itself still depends on
// nothing: gates capture answers from here into goldens/ and replay them without Borland or DOSBox.
//
//   import { bccRun } from './oracle-borland.mjs';
//   const outs = bccRun([{ name: 'P1', source }], { bc: '/path/to/BC31', options: ['-mm', '-a', '-K'] });
//   // -> [{ name, compiled, stdout, compileLog }]
//
// Programs are run in one DOSBox-X session per call, in order, so a batch costs one start-up.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const BC_DEFAULT = process.env.PRISM_BC ?? join(process.env.HOME ?? '', 'Projects', 'borland', 'BC31');

/**
 * Compile and run each program. `includes` maps extra directories (host paths) that the programs may
 * #include from; they are mounted as drives and passed to BCC as -I.
 */
export function bccRun(programs, { bc = BC_DEFAULT, options = [], includes = [] } = {}) {
  if (!existsSync(join(bc, 'BIN', 'BCC.EXE'))) throw new Error(`oracle-borland: no BIN/BCC.EXE under ${bc}`);
  const work = mkdtempSync(join(tmpdir(), 'bcc-'));
  const drives = ['E', 'F', 'G', 'H'];
  if (includes.length > drives.length) throw new Error('oracle-borland: too many include directories');
  const inc = ['C:\\INCLUDE', ...includes.map((_, i) => `${drives[i]}:\\`)].join(';');
  const bat = ['@echo off', 'path c:\\bin', 'd:'];
  for (const p of programs) {
    if (!/^[A-Z0-9_]{1,8}$/.test(p.name)) throw new Error(`oracle-borland: '${p.name}' is not an 8.3 name`);
    writeFileSync(join(work, `${p.name}.C`), p.source.replace(/\r?\n/g, '\r\n'));
    bat.push(`c:\\bin\\bcc ${options.join(' ')} -I${inc} -LC:\\LIB -e${p.name}.EXE ${p.name}.C > ${p.name}.CL`);
    bat.push(`if exist ${p.name}.EXE ${p.name}.EXE > ${p.name}.OUT`);
  }
  writeFileSync(join(work, 'RUN.BAT'), `${bat.join('\r\n')}\r\n`);
  const mounts = ['-c', `mount c "${bc}"`, '-c', `mount d "${work}"`];
  includes.forEach((dir, i) => mounts.push('-c', `mount ${drives[i]} "${dir}"`));
  const r = spawnSync('dosbox-x', ['-silent', '-nogui', '-nomenu', '-set', 'cpu cycles=max',
    ...mounts, '-c', 'd:', '-c', 'RUN.BAT', '-c', 'exit'],
  { encoding: 'utf8', env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' }, timeout: 600000 });
  if (r.status !== 0) throw new Error(`oracle-borland: dosbox-x exited ${r.status}: ${(r.stderr ?? '').slice(0, 300)}`);
  const read = (f) => (existsSync(join(work, f)) ? readFileSync(join(work, f), 'latin1').replace(/\r\n/g, '\n') : null);
  return programs.map((p) => ({
    name: p.name,
    compiled: existsSync(join(work, `${p.name}.EXE`)),
    stdout: read(`${p.name}.OUT`),
    compileLog: read(`${p.name}.CL`),
  }));
}

/** Borland's own version line, for a golden's provenance. */
export function bccVersion({ bc = BC_DEFAULT } = {}) {
  const [r] = bccRun([{ name: 'VERSION', source: 'int main(void) { return 0; }\n' }], { bc });
  return (r.compileLog ?? '').split('\n')[0].trim();
}

// Keep mkdirSync referenced for callers that pass a work directory in future; not used yet.
void mkdirSync;
