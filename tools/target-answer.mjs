// target-answer.mjs — a target resolved for the page: what tools/serve.mjs answers at /__target, and
// what tools/site.mjs writes to __static/target/<name>.json for a static export. One function, so the
// two cannot drift (web/endpoints.js is the page's side of the same seam).
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadTarget, targetUnits, moduleExportsOf } from '../src/target.js';

/**
 * `name` is `file` or `file:variant`; `subject` is the first word of the command line, which a light
 * build (MAME) reads; `bundleFor(name)` says where a static bundle of the resolved build is, or null.
 */
export async function targetAnswer(ROOT, name, { subject = '', bundleFor = () => null } = {}) {
  const [file, variant] = name.split(':');
  const target = loadTarget(join(ROOT, 'targets', `${file}.json`), variant || null);
  let resolved = variant || !target.default
    ? target : loadTarget(join(ROOT, 'targets', `${file}.json`), target.default);
  /*
   * A target whose build depends on WHAT IS ASKED OF IT. MAME links 959 games to play one;
   * its target names a module that knows which of the makefile's archives hold a given game
   * (`light`), and the page says which game its command line starts with (`subject`). The
   * module answers with a smaller target of the same shape, or null -- an unknown name, a
   * switch such as -listcrc -- and then the whole build is what is served.
   */
  if (resolved.light?.module && subject) {
    const light = (await import(join(ROOT, resolved.light.module)))[resolved.light.export ?? 'lightFor'](subject);
    if (light) resolved = { ...light, name: resolved.name };
  }
  const { units, dir, asm } = targetUnits(resolved, ROOT);
  const rel = (f) => f.startsWith(ROOT) ? f.slice(ROOT.length + 1) : f;
  return {
    name: resolved.name,
    title: resolved.title ?? resolved.name,
    dir: rel(dir),
    // A unit is a path to fetch, or -- for the generated and inline ones -- its own source.
    units: units.map(u => (u.source !== undefined && !u.file.startsWith(ROOT)
      ? { file: u.file, source: u.source, defines: u.defines, module: u.module }
      : { file: rel(u.file), defines: u.defines, module: u.module })),
    defines: resolved.defines ?? {},
    include: (resolved.include ?? []).map(d => `${rel(dir)}/${d}`),
    caseInsensitive: !!resolved.caseInsensitive,
    compile: resolved.compile ?? {},
    env: resolved.env ?? ['stdio'],
    /*
     * Files the INSTALLATION provides, as against the ones the player does. Quake II's
     * linux/vid_so.c reads /etc/quake2.conf to find its ref libraries; on a real box the
     * package put it there, and it is neither game data nor a source change.
     */
    files: resolved.files ?? {},
    tree: resolved.tree ?? null,
    // Which shell branch presents it; a variant may set its own.
    host: resolved.host ?? null,
    // What a light build is made of, for the page to say: archives, cores, units of how many.
    lightOf: resolved.lightOf ?? null,
    bundle: bundleFor(resolved.lightOf ? `${resolved.name}-${resolved.lightOf.archives[0]}` : resolved.name),
    args: resolved.args ?? null,
    // A variant's frame-rate cap, when its renderer is not the one the descriptor was paced for.
    fps: resolved.fps ?? null,
    modules: Object.fromEntries(Object.entries(resolved.modules ?? {})
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, m]) => [k, { soname: m.soname ?? null }])),
    /*
     * What each module EXPORTS, resolved here. The list comes from the program's own .def
     * file -- Quake II ships ref_soft.def -- and a browser has no way to read one, so the
     * server answers with the same function Node's build uses rather than the page growing a
     * second reader of the format.
     */
    moduleExports: moduleExportsOf(resolved, dir),
    asm,
    /*
     * The assembly the target asks to be TRANSLATED, as repository paths the page can fetch.
     * `asm` above is a different list -- the assembly stems that had no C twin, which is a
     * report about the build. This one is an instruction, and Jump 'n Bump is why it exists:
     * its tree defines get_block and put_block nowhere but dos/gfx.S, so a browser that cannot
     * reach that file cannot draw anything at all.
     */
    // A gas entry is an object; its file is relative to the tree like a NASM name's.
    asmTranslate: (resolved.asmTranslate ?? []).map(f => (typeof f === 'string'
      ? `${rel(dir)}/${f}` : { ...f, file: `${rel(dir)}/${f.file}`, inTree: f.file })),
    /*
     * Whole Turbo Assembler modules and the object files the project links (Keen Dreams,
     * Catacomb 3-D): the module list as the target names it, every assembler source in the
     * tree -- a module INCLUDEs by name, case-insensitively as DOS did -- and each data
     * object with the repo path the page fetches. src/target.js builds the same blocks.
     */
    tasm: resolved.tasm ?? [],
    tasmFiles: (resolved.tasm?.length ? readdirSync(dir) : [])
      .filter(f => /\.(asm|equ|inc)$/i.test(f)).map(f => `${rel(dir)}/${f}`),
    dataObjects: (resolved.dataObjects ?? []).map((o) => {
      const name = o.object ?? o.file;
      const found = readdirSync(dirname(join(dir, name)))
        .find(f => f.toLowerCase() === name.replace(/^.*\//, '').toLowerCase());
      return { ...o, path: found ? `${rel(dirname(join(dir, name)))}/${found}` : null };
    }),
  };
}
