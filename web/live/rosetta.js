// rosetta.js — Rosetta Code's C solutions, read from rosettacode.org the way PRISM measured them.
//
// One reading of a task's C section for the two places that need it: tools/rosetta.mjs, which
// fetched and measured every solution, and Live C, which loads one when it is chosen. Block numbers
// are positions in this reading, so the two must agree, and they do by sharing it.
//
// THE LICENCE: Rosetta Code's content, code included, is under the GNU FDL 1.3
// (rosettacode.org/wiki/Rosetta_Code:Copyrights). None of it is in PRISM's tree. web/live/rosetta.json
// lists what was measured -- task, block, revision, environment -- and the code is fetched from
// rosettacode.org at the REVISION that was measured, shown as it is, with its licence and its authors.

export const API = 'https://rosettacode.org/w/api.php';
export const LICENCE = { name: 'GNU Free Documentation License 1.3', url: 'https://www.gnu.org/licenses/fdl-1.3.html' };
export const pageUrl = (task) => `https://rosettacode.org/wiki/${encodeURIComponent(task.replace(/ /g, '_'))}#C`;
export const historyUrl = (task) => `https://rosettacode.org/w/index.php?title=${encodeURIComponent(task.replace(/ /g, '_'))}&action=history`;

/** Each C code block of a section, with the subsection it sits under and the library notes before it. */
export function cBlocks(wikitext) {
  const out = [];
  let sub = '', libs = [];
  const re = /^(={3,})\s*(.*?)\s*\1\s*$|\{\{\s*libheader\s*\|\s*([^}|]+)|<(syntaxhighlight|lang)\b([^>]*)>([\s\S]*?)<\/\4>/gm;
  for (const m of wikitext.matchAll(re)) {
    if (m[1]) { sub = m[2].replace(/\{\{[^}]*\}\}/g, '').trim(); libs = []; continue; }
    if (m[3]) { libs.push(m[3].trim()); continue; }
    const lang = (/lang\s*=\s*"?([\w+#-]+)/.exec(m[5])?.[1] ?? (m[4] === 'lang' ? m[5].trim().split(/\s/)[0] : '')).toLowerCase();
    if (lang !== 'c') continue;   // output listings and other languages' snippets are not programs
    out.push({ sub, libs: [...libs], code: m[6].replace(/^\n/, '') });
  }
  return out;
}

/** The task's C section at one revision, as wikitext: two small requests, from a page (CORS). */
export async function fetchCSection(task, revid, { signal } = {}) {
  const q = (params) => fetch(`${API}?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })}`, { signal })
    .then((r) => { if (!r.ok) throw new Error(`rosettacode.org answered ${r.status}`); return r.json(); });
  const at = revid ? { oldid: String(revid) } : { page: task };
  const s = await q({ action: 'parse', prop: 'sections', ...at });
  const sec = s.parse?.sections?.find((x) => String(x.level) === '2' && x.line.trim() === 'C');
  if (!sec) throw new Error(`no C section in "${task}"${revid ? ` at revision ${revid}` : ''}`);
  const w = await q({ action: 'parse', prop: 'wikitext', section: sec.index, ...at });
  return w.parse?.wikitext ?? '';
}
