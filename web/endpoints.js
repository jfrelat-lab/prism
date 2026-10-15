// endpoints.js — the questions the shelf asks tools/serve.mjs, and where a static export answers them.
//
// Under serve.mjs the page and its worker ask four things of the server: which targets exist, how a
// target resolves (units, defines, its bundle), which data files a root holds, and one data file.
// A static export (tools/site.mjs) has no server: it writes each answer the server WOULD give for the
// programs it ships into files under __static/, and the data under data/<root>/. The page knows which
// it is talking to from web/site.json, which only an export writes, and tells its worker.
//
// Same answers either way, so nothing downstream of these URLs knows the difference.

/** A target name as a file name: `quake2:gl` has a colon, which some hosts refuse in a path. */
export const targetFile = (name) => String(name).replace(/:/g, '~');

/*
 * THE SITE'S ROOT, from where this module sits (web/endpoints.js) rather than the host's root: an
 * export may live under a path (jfrelat-lab.github.io/prism/, a game in its own folder on someone's
 * site), and a path beginning with / would leave it. Every file the page or its workers fetch goes
 * through at(); serve.mjs serves the repository at its root, where the two are the same.
 */
export const BASE = new URL('../', import.meta.url).href;
export const at = (path) => new URL(String(path).replace(/^\//, ''), BASE).href;

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export function endpoints(site, light = null) {
  if (!site) {
    return {
      targets: () => at('__targets'),
      target: (name, subject = '') => at(`__target?name=${encodeURIComponent(name)}&subject=${encodeURIComponent(subject)}`),
      dataList: (root) => at(`__data/?root=${encodeURIComponent(root)}`),
      // Keyed by the path under its root; serve.mjs finds the root that holds it.
      dataFile: (root, f) => at(`__data/${f}`),
    };
  }
  return {
    targets: () => at('__static/targets.json'),
    // A static export ships one build per target, and a light one for each game site.json lists under
    // it (MAME's, tools/site.mjs): another subject gets the whole build.
    target: (name, subject = '') => at(`__static/target/${encodeURIComponent(targetFile(name))}${light?.[name]?.includes(subject) ? `@${encodeURIComponent(subject)}` : ''}.json`),
    dataList: (root) => at(`__static/data/${encodeURIComponent(root)}.json`),
    dataFile: (root, f) => at(`data/${encodeURIComponent(root)}/${enc(f)}`),
  };
}
