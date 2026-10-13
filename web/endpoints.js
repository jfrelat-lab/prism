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

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export function endpoints(site) {
  if (!site) {
    return {
      targets: () => '/__targets',
      target: (name, subject = '') => `/__target?name=${encodeURIComponent(name)}&subject=${encodeURIComponent(subject)}`,
      dataList: (root) => `/__data/?root=${encodeURIComponent(root)}`,
      // Keyed by the path under its root; serve.mjs finds the root that holds it.
      dataFile: (root, f) => `/__data/${f}`,
    };
  }
  return {
    targets: () => '/__static/targets.json',
    // A static export ships one build per target, so the subject (MAME's light build) is not asked.
    target: (name) => `/__static/target/${encodeURIComponent(targetFile(name))}.json`,
    dataList: (root) => `/__static/data/${encodeURIComponent(root)}.json`,
    dataFile: (root, f) => `/data/${encodeURIComponent(root)}/${enc(f)}`,
  };
}
