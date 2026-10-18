// rosetta-index.mjs — the Rosetta Code solutions Live C offers, from what PRISM measured.
//
//   node tools/rosetta-index.mjs        reads dist/rosetta/{index,index-partial,runs}.json,
//                                       writes web/live/rosetta.json
//
// Offered: a console solution whose output was cc's (same-output), and a graphical one that ran on
// its environment -- a frame, its message loop, or a clean exit (tools/rosetta-run.mjs). Each entry
// is the task, the block's place in its C section and the REVISION measured, so Live C loads the
// code that was measured and not whatever the page says today. No Rosetta Code content is written:
// the titles are the tasks' names, the rest is PRISM's own measurement (see web/live/rosetta.js).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (f) => (existsSync(join(ROOT, 'dist', 'rosetta', f)) ? JSON.parse(readFileSync(join(ROOT, 'dist', 'rosetta', f), 'utf8')) : null);
const survey = read('index.json'), partial = read('index-partial.json'), runs = read('runs.json');
if (!survey) { console.error('no dist/rosetta/index.json: run node tools/rosetta.mjs first'); process.exit(1); }

const key = (r) => `${r.task}\0${r.block}`;
const rows = new Map(survey.results.map((r) => [key(r), r]));
for (const r of partial?.results ?? []) rows.set(key(r), r);   // the latest graphical builds

const entries = [];
for (const r of rows.values()) {
  if (r.env === 'console' || r.env === 'posix') {
    if (r.status === 'same-output') entries.push({ task: r.task, block: r.block, sub: r.sub || undefined, env: 'console', revid: r.revid });
  }
}
for (const g of runs?.runs ?? []) {
  if (!['frame', 'message-loop', 'exited'].includes(g.phase)) continue;
  const r = rows.get(key(g));
  if (r) entries.push({ task: r.task, block: r.block, sub: r.sub || undefined, env: g.env, revid: r.revid });
}
entries.sort((a, b) => a.task.localeCompare(b.task, 'en', { sensitivity: 'base' }) || a.block - b.block);

writeFileSync(join(ROOT, 'web', 'live', 'rosetta.json'), JSON.stringify({
  _note: 'Rosetta Code solutions PRISM ran: task, block of its C section, revision measured, environment. The code is fetched from rosettacode.org at that revision; it is under the GNU FDL 1.3 (see web/live/rosetta.js).',
  measured: survey.date, entries,
}, null, 0) + '\n');
const by = entries.reduce((m, e) => (m[e.env] = (m[e.env] ?? 0) + 1, m), {});
console.log(`${entries.length} solutions offered: ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')} -> web/live/rosetta.json`);
