// registry.js — the environment installers, by name, in ONE place instead of five harnesses.
//
// Before this, a program's environment was whichever `install*()` its tool in tools/ happened to
// import: `installGo32` in quake.mjs, `installWatcom` in raven.mjs, `installAllegro` in mame.mjs and
// gate-sound.mjs. That works while one tool exists per program and stops working the moment a
// program is described by data rather than by code.
//
// Each entry knows two things a JSON file cannot state for itself: what the installer wants passed
// (M, or the port machine, or both) and what has to exist first. `installPIT` takes the machine, so
// the machine has to be there; `installCrtStatus` and `installVgaDac` likewise. That ordering is not
// a convention to remember, it is `needs`, and buildEnv resolves it.
//
// What is deliberately NOT here: a program's own instrumentation. Quake's frame cap and key script,
// Doom's fire trigger, the audio drain -- those wrap the PROGRAM's functions to observe it, and they
// are not environment. Describing the build in JSON does not make them declarative, and pretending
// otherwise would put game logic in a config file.

import { installStdio } from './stdio.js';
import { installPorts } from './ports.js';
import { installPIT } from './pit.js';
import { installCrtStatus } from './crtstatus.js';
import { installVgaDac } from './vgadac.js';
import { installVgaPlanar } from './vgaplanar.js';
import { installKbd8042 } from './kbd8042.js';
import { installGo32 } from './go32.js';
import { installWatcom } from './watcom.js';
import { WATCOM_VARS } from './headers-watcom.js';
import { installAllegro, ALLEGRO_VARS } from './allegro.js';
import { installDj } from './dj.js';
import { installX11 } from './x11.js';
import { installPopen } from './popen.js';
import { installDsp } from './dsp.js';
import { installDl } from './dl.js';
import { installSDL2 } from './sdl2.js';
import { installSvgalib } from './svgalib.js';
import { installConsole } from './console.js';
import { installVgaFont } from './vgafont.js';
import { installWsock } from './wsock.js';

/** The port machine, created once. compileProgram already makes one, so this usually finds it. */
const machineOf = (M) => (M.machine ?? installPorts(M));

export const ENV = {
  ports: { install: (M, _c, o) => machineOf(M, o) },
  stdio: { install: (M, _c, o) => installStdio(M, o) },
  console: { install: (M, _c, o) => installConsole(M, o) },

  /*
   * The three devices a whole DOS game turns out to need, plus the clock. Mode 13h is absent on
   * purpose: it is a linear framebuffer at 0xA0000, which PRISM already has because the low
   * megabyte is reserved, so there is no register set to emulate.
   */
  pit: { needs: ['ports'], install: (M, c, o) => installPIT(c.machine, M, o) },
  crtstatus: { needs: ['ports'], install: (M, c, o) => installCrtStatus(c.machine, o) },
  // Reachable as M.dac, the way the keyboard controller is M.kbd: a harness that wants to know what
  // colours the program set has nowhere else to ask, and gate-pixels.mjs needs exactly that.
  vgadac: { needs: ['ports'], install: (M, c, o) => (M.dac = installVgaDac(c.machine, o)) },
  // The keyboard controller is reached as M.kbd by everything that pushes a scan code into it.
  kbd8042: { needs: ['ports'], install: (M, c, o) => (M.kbd = installKbd8042(c.machine, o)) },

  /*
   * UNCHAINED PLANAR VGA -- mode X -- and it is OPTIONAL even for a DOS program, which is the whole
   * point of its being an env a target lists rather than something the platform switches on.
   *
   * MAME is the reason. Its tweaked 256x256 modes write the same register file, but leave Chain-4
   * SET, so the window stays linear and it needs nothing from here. Turning this on for every DOS
   * target would make it pay for a mechanism it does not use, and change the JavaScript it emits.
   * A target that does not name this emits, byte for byte, what it emitted before this existed.
   *
   * Naming it has one consequence beyond the device: the image must be PAGED, because a planar
   * window means an address no longer denotes one place. buildTarget turns that on for a target
   * that asks for this, and the check below refuses rather than silently drawing into flat memory.
   */
  vgaplanar: {
    needs: ['ports'],
    install: (M, c, o) => {
      if (!M.memmap) {
        throw new Error("env 'vgaplanar' needs a paged image — it is the page map that makes a " +
          'planar window mean anything. Set compile.paged in the target.');
      }
      // Four planes plus the scratch bank the multi-plane case is contained in, in GUEST memory:
      // a translation target has to be an address the emitted code can reach.
      const planes = M.rt.malloc(5 * 0x10000);
      M.u8.fill(0, planes, planes + 5 * 0x10000);
      return (M.vga = installVgaPlanar(c.machine, { map: M.memmap, planes, ...o }));
    },
  },

  // The three compilers' runtimes.
  go32: { install: (M, _c, o) => installGo32(M, o) },          // DJGPP: Quake
  // `vars` is the DATA half of a platform layer: what the LINKER provides in a real build. It has
  // to be real C with external linkage because the program takes its address -- Allegro's `screen`
  // and `key[]`, Heretic's `joystickx`. Declaring the environment therefore also supplies its
  // globals, which is why no target file has to remember them.
  watcom: { install: (M, _c, o) => installWatcom(M, o), vars: WATCOM_VARS },
  allegro: { install: (M, _c, o) => installAllegro(M, o), vars: ALLEGRO_VARS },
  // dj: Jump n Bump s DOS sound library, source-less and therefore answered rather than built.
  dj: { install: (M, _c, o) => installDj(M, o) },

  // The POSIX side, for the one target that is not a DOS program.
  x11: { install: (M, _c, o) => installX11(M, o) },
  popen: { install: (M, _c, o) => installPopen(M, o) },
  dsp: { install: (M, _c, o) => installDsp(M, o) },
  // dlopen over PRISM's symbol table: the modules are the target's, passed by buildTarget.
  dl: { install: (M, _c, o) => installDl(M, o) },
  /*
   * The VGA ROM font, for a platform layer that has to RASTERISE text rather than hand it to a
   * toolkit. The Win32 shim's ExtTextOut needs one; nothing else does yet.
   */
  vgafont: { install: (M, _c, o) => installVgaFont(M, o) },
  /*
   * Real TCP, on a thread of its own. NODE ONLY: a browser cannot open a socket at all, and the same
   * C would need a WebSocket relay behind it there -- which is a host binding, not a different shim.
   */
  wsock: { install: (M, _c, o) => installWsock(M, o) },

  // SDL2 for the Open* family. See src/env/sdl2.js.
  sdl2: { install: (M, _c, o) => installSDL2(M, o) },

  // svgalib: Quake's OTHER Linux display path, the console framebuffer. See src/env/svgalib.js.
  svgalib: { needs: ['ports'], install: (M, _c, o) => installSvgalib(M, o) },
};

/**
 * Install a named environment, in dependency order, and return every installer's result by name.
 *
 * `spec` is either a list of names or an object of name -> options; a name may also carry options
 * the caller cannot put in JSON (a `micros` clock, a keyboard queue) through `extra`.
 */
export function buildEnv(M, spec, extra = {}) {
  const wanted = Array.isArray(spec) ? Object.fromEntries(spec.map(n => [n, {}])) : { ...spec };
  const out = {}, done = new Set();

  const install = (name, stack = []) => {
    if (done.has(name)) return;
    const entry = ENV[name];
    if (!entry) throw new Error(`unknown environment '${name}' (have: ${Object.keys(ENV).join(' ')})`);
    if (stack.includes(name)) throw new Error(`environment cycle: ${[...stack, name].join(' -> ')}`);
    for (const dep of entry.needs ?? []) install(dep, [...stack, name]);
    const opts = { ...(wanted[name] ?? {}), ...(extra[name] ?? {}) };
    out[name] = entry.install(M, { machine: M.machine, ...out }, opts);
    done.add(name);
  };

  // A dependency pulled in implicitly still lands in `out`, so a caller that asked only for
  // `crtstatus` can still reach the machine it needed.
  for (const name of Object.keys(wanted)) install(name);
  out.machine = M.machine ?? null;
  return out;
}

/** The C an environment supplies, for the units list, in the order the names were given. */
export function envVars(spec) {
  const names = Array.isArray(spec) ? spec : Object.keys(spec ?? {});
  return names.filter(n => ENV[n]?.vars).map(n => ({ name: n, source: ENV[n].vars }));
}
