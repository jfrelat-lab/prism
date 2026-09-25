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
import { installGo32, GO32_VARS } from './go32.js';
import { installWatcom } from './watcom.js';
import { installBorland, BORLAND_DOS_H, BORLAND_VARS, BORLAND_BUILTINS } from './borland.js';
import { installBorlandLib, BORLAND_LIB_HEADERS, BORLAND_LIB_BUILTINS } from './borland-lib.js';
import { WATCOM_VARS } from './headers-watcom.js';
import { installAllegro, ALLEGRO_VARS } from './allegro.js';
import { installDj } from './dj.js';
import { GETOPT_VARS } from './getopt.js';
import { installX11 } from './x11.js';
import { installPopen } from './popen.js';
import { installDsp } from './dsp.js';
import { installDl } from './dl.js';
import { installSDL2, sdl2Builtins } from './sdl2.js';
import { SDL2_HEADERS } from './headers-sdl2.js';
import { SDL12_HEADERS } from './headers-sdl12.js';
import { installSDL12, sdl12Builtins } from './sdl12.js';
import { MIXER_HEADERS, mixerApi, mixerBuiltins, MIXER_STATE } from './sdlmixer.js';
import * as T from '../sema/types.js';
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
  go32: { install: (M, _c, o) => installGo32(M, o), vars: GO32_VARS },          // DJGPP: Quake
  // `vars` is the DATA half of a platform layer: what the LINKER provides in a real build. It has
  // to be real C with external linkage because the program takes its address -- Allegro's `screen`
  // and `key[]`, Heretic's `joystickx`. Declaring the environment therefore also supplies its
  // globals, which is why no target file has to remember them.
  watcom: { install: (M, _c, o) => installWatcom(M, o), vars: WATCOM_VARS },
  allegro: { install: (M, _c, o) => installAllegro(M, o), vars: ALLEGRO_VARS },
  // Borland C++ real mode: its <dos.h>, the vector table, and the seam `int n` is answered through.
  // ...and the parts of its runtime library a program calls by name (src/env/borland-lib.js).
  borland: {
    install: (M, _c, o) => { installBorlandLib(M); return installBorland(M, o); },
    vars: BORLAND_VARS,
    headers: { ...BORLAND_LIB_HEADERS, 'dos.h': BORLAND_DOS_H },
    builtins: { ...BORLAND_LIB_BUILTINS, ...BORLAND_BUILTINS },
  },
  // dj: Jump n Bump s DOS sound library, source-less and therefore answered rather than built.
  dj: { install: (M, _c, o) => installDj(M, o) },

  /*
   * POSIX getopt, supplied as C because it is pure logic over argv and its state is three globals
   * the program reads directly. Named by a target rather than given to everything: an extra
   * translation unit for every program would change the JavaScript every existing target emits.
   */
  getopt: { install: () => ({}), vars: GETOPT_VARS },

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

  /*
   * SDL2 for the Open* family. See src/env/sdl2.js.
   *
   * The headers AND the builtin signatures travel with the shim rather than in the global tables,
   * and all three must stay one artifact: the guest reads `surface->pixels` and `surface->pitch` at
   * offsets the header decides, the signature says what a call returns, and the shim writes the
   * values. Split them and they drift silently.
   *
   * Registered globally, these answered for SDL 1.2 programs too: corpus/jumpnbump-sdl12 resolved
   * SDL_Init, SDL_PollEvent, SDL_CreateRGBSurface and SDL_MapRGB against SDL2's implementations
   * without ever naming this environment.
   */
  sdl2: {
    /*
     * SDL_mixer rides along, because a program linking -lSDL2 -lSDL2_mixer expects to find it and
     * the library is the same one the SDL 1.2 environment names. Sharing the declarations is what
     * envHeaders() allows on purpose: it refuses two environments that supply one header with
     * DIFFERENT text, and identical text is not a conflict.
     */
    install: (M, _c, o) => {
      const sdl = installSDL2(M, o);
      const mix = { ...MIXER_STATE };
      Object.assign(M.rt, mixerApi(M, mix));
      M.mixer = mix;
      return sdl;
    },
    headers: { ...SDL2_HEADERS, ...MIXER_HEADERS },
    builtins: { ...sdl2Builtins(T), ...mixerBuiltins(T) },
  },

  /*
   * SDL 1.2, for the ports written against it. See src/env/headers-sdl12.js.
   *
   * Headers, signatures and shim as one entry, for the reason sdl2 keeps them together: the guest
   * reads surface->pixels and surface->pitch at offsets the header decides, the signature says what
   * each call returns, and the shim writes the values. tools/gate-sdl12abi.mjs holds the first two
   * to the real SDL 1.2 headers.
   *
   * The shim's work list was read off the program rather than recalled: with the headers in place
   * and no implementation, the build named all 40 symbols it could not resolve, and those are what
   * src/env/sdl12.js implements -- no more.
   */
  sdl12: {
    install: (M, _c, o) => installSDL12(M, o),
    headers: { ...SDL12_HEADERS, ...MIXER_HEADERS },
    builtins: { ...sdl12Builtins(T), ...mixerBuiltins(T) },
  },

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

/**
 * The HEADERS an environment supplies, which is the other half of `vars`: that one is the data a
 * linker would provide, this one is the declarations a compiler would find on the include path.
 *
 * It exists because one global table cannot serve two versions of a library. src/env/headers.js
 * spread SDL2's headers into every build, so a target compiled against SDL 1.2 asked for "SDL.h",
 * received SDL2's, and died on `SDLKey key;` at main.c:1847 -- the parser reads an unknown type
 * name as an expression. Not a missing header: the WRONG one, handed to a target that had named no
 * SDL environment at all.
 *
 * THE CONFLICT IS REFUSED RATHER THAN RESOLVED, and generally rather than by naming the pair. Two
 * environments that claim one header name with different text cannot both be right, and picking the
 * last one is how `SDL_Surface` ends up with fields the shim does not write. Same rule as the page
 * map's multiWrite and vgaplanar's check: refuse, and say which two.
 */
export function envHeaders(spec) {
  const names = Array.isArray(spec) ? spec : Object.keys(spec ?? {});
  const out = {}, from = new Map();
  for (const n of names) {
    for (const [file, text] of Object.entries(ENV[n]?.headers ?? {})) {
      const held = from.get(file);
      if (held !== undefined && out[file] !== text) {
        throw new Error(`environments '${held}' and '${n}' both supply the header '${file}', with ` +
          `different contents. They are two versions of one library and a build compiles against ` +
          `exactly one — name the one this program was written for.`);
      }
      out[file] = text;
      from.set(file, n);
    }
  }
  return out;
}

/**
 * The BUILTIN SIGNATURES an environment supplies -- the third piece that belongs to a library,
 * beside its headers and its `vars`.
 *
 * A signature says what a call takes and what it returns, so it decides the type of the value the
 * emitter hands back. Two versions of one library disagree there as surely as they disagree about a
 * struct: SDL 1.2's SDL_PollEvent fills an event whose `type` is a Uint8, SDL2's one whose `type` is
 * a Uint32, and both are called SDL_PollEvent. Registered in one global table, SDL2's answered for
 * an SDL 1.2 program that had not named it -- which does not crash, it invents keystrokes.
 *
 * Refused on conflict for the same reason envHeaders refuses: two environments claiming one name
 * are two versions of one library, and a build links against exactly one.
 */
export function envBuiltins(spec) {
  const names = Array.isArray(spec) ? spec : Object.keys(spec ?? {});
  const out = new Map(), from = new Map();
  for (const n of names) {
    for (const [sym, sig] of Object.entries(ENV[n]?.builtins ?? {})) {
      const held = from.get(sym);
      if (held !== undefined && out.get(sym) !== sig) {
        throw new Error(`environments '${held}' and '${n}' both define the builtin '${sym}'. They ` +
          `are two versions of one library and a build links against exactly one — name the one ` +
          `this program was written for.`);
      }
      out.set(sym, sig);
      from.set(sym, n);
    }
  }
  return out;
}
