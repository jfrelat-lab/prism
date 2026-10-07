// mame-compat.mjs — what MAME 0.34 does with each game of a ROM collection, as data for a page.
//
// One row per game the release lists, from four sources that do not depend on one another:
//
//   the driver sources   its name, title, year, maker, parent, the archive of the makefile it is
//                        in, and the release's OWN verdict (GAME_NOT_WORKING, wrong colours)
//   the ROM set          complete, partial or absent, by CRC (tools/mame-audit.mjs)
//   a run                the game's light build over the headless backend: did it reach its
//                        emulation loop, how many frames, and the picture at the last one
//   the reference        whether its frames were held to a native gcc build (goldens/mame034.json)
//
// A run says "starts and draws"; only the reference says "right". The page keeps the two apart.
//
//   node tools/mame-compat.mjs --roms=<dir of zips> [--games=a,b | --archive=capcom] [--frames=900]
//                              [--jobs=6] [--force]
//
// Written to dist/mame-compat/ (index.json, shots/<game>.png), which is not committed: a
// screenshot is a picture of the game. Runs are kept between invocations; --force runs them again.
// web/mame/ reads the result.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { ARCHIVES, archiveOf, lightFor } from './mame-light.mjs';
import { writeIndexedPng } from './png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPUS = join(ROOT, 'corpus', 'mame034');
const OUT = join(ROOT, 'dist', 'mame-compat');
const arg = (k, d = null) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROMS = arg('roms'), FRAMES = +arg('frames', 900), JOBS = +arg('jobs', 6), FORCE = process.argv.includes('--force');
if (!ROMS || !existsSync(ROMS) || !existsSync(CORPUS)) {
  console.error('usage: node tools/mame-compat.mjs --roms=<dir of zips> [--games=a,b | --archive=<name>] [--frames=900] [--jobs=6] [--force]');
  process.exit(2);
}

// ---- the driver sources: every game src/driver.c lists, in its order
const visible = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')
  .replace(/^[ \t]*#[ \t]*if[ \t]+0\b[\s\S]*?^[ \t]*#[ \t]*endif/gm, ' ');
const driverC = visible(readFileSync(join(CORPUS, 'src', 'driver.c'), 'latin1'));
const LISTED = [...driverC.slice(driverC.indexOf('drivers[]')).matchAll(/&\s*(\w+)\s*,/g)].map((m) => m[1]);
const byStruct = new Map();
const dir = readdirSync(join(CORPUS, 'src')).find((d) => d.toLowerCase() === 'drivers');
for (const f of readdirSync(join(CORPUS, 'src', dir)).filter((x) => /\.c$/i.test(x))) {
  const text = visible(readFileSync(join(CORPUS, 'src', dir, f), 'latin1'));
  // { __FILE__, clone_of, "name", "description", "year", "manufacturer", "credits", flags, ...
  // The credits are one string or several, or a macro, and the flags an expression: neither is
  // matched. What follows the maker, up to the first `&` (the machine driver), holds the flags.
  const re = /struct\s+GameDriver\s+(\w+)\s*=\s*\{\s*__FILE__\s*,\s*(?:&\s*(\w+)|0)\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,([^&]*)&/g;
  for (const m of text.matchAll(re)) {
    byStruct.set(m[1], { struct: m[1], parentStruct: m[2] ?? null, name: m[3], title: m[4], year: m[5], maker: m[6],
      flags: [...m[7].replace(/"(?:[^"\\]|\\.)*"/g, " ").matchAll(/GAME_\w+/g)].map((x) => x[0].replace(/^GAME_/, "").toLowerCase()), file: f });
  }
  /*
   * neogeo.c declares its hundred drivers through two macros of its own: NEODRIVER(name, title,
   * year, maker, ...) makes `name_driver` for the game called `name`, NEODRIVERX takes the game's
   * name as a second argument. All are clones of the BIOS set, which is where their system ROMs are.
   */
  for (const m of text.matchAll(/^NEODRIVER(X?)\(\s*(\w+)\s*,(.*)$/gm)) {
    const strings = [...m[3].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    const [name, title, year, maker] = m[1] ? strings : [m[2], ...strings];
    byStruct.set(`${m[2]}_driver`, { struct: `${m[2]}_driver`, parentStruct: 'neogeo_bios', name, title, year, maker, flags: [], file: f });
  }
}
const games = LISTED.map((s) => byStruct.get(s)).filter(Boolean);
// A view that is not the whole says so: the listed drivers whose struct this did not read.
const unread = LISTED.filter((s) => !byStruct.has(s));
for (const g of games) { g.cloneOf = g.parentStruct ? byStruct.get(g.parentStruct)?.name ?? null : null; g.archive = archiveOf(g.name); }

// ---- the ROM sets: the audit's own lines
const audit = new Map();
{
  const r = spawnSync('node', [join(ROOT, 'tools', 'mame-audit.mjs'), `--roms=${ROMS}`, '--all'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  for (const m of r.stdout.matchAll(/^(COMPLETE|partial |absent  ) (\S+)\s+(\d+) of (\d+)/gm)) {
    audit.set(m[2], { roms: m[1].trim().toLowerCase(), have: +m[3], need: +m[4] });
  }
}
const golden = existsSync(join(ROOT, 'goldens', 'mame034.json')) ? JSON.parse(readFileSync(join(ROOT, 'goldens', 'mame034.json'), 'utf8')) : { games: {} };

// ---- the runs
mkdirSync(join(OUT, 'shots'), { recursive: true });
const indexPath = join(OUT, 'index.json');
const previous = existsSync(indexPath) ? new Map(JSON.parse(readFileSync(indexPath, 'utf8')).games.map((g) => [g.name, g])) : new Map();
const only = arg('games')?.split(',') ?? (arg('archive') ? games.filter((g) => g.archive === arg('archive')).map((g) => g.name) : null);

/** One game through its light build and the headless backend. Resolves to the `run` record. */
function runOne(g, N = FRAMES) {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn('node', ['--max-old-space-size=4096', join(ROOT, 'tools', 'mame034diff.mjs'), '--prism', ROMS, g.name,
      String(N), '0', '0', '0', '0', String(N - 1)], { cwd: ROOT, env: { ...process.env, PRISM_MAME_LIGHT: '1' } });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const lines = Buffer.concat(chunks).toString('latin1').split('\n');
      const frames = lines.filter((l) => /^frame \d+ [0-9a-f]{8} [0-9a-f]{8}$/.test(l)).length;
      const threw = lines.find((l) => l.startsWith('PRISM threw: '))?.slice(13) ?? null;
      const said = lines.filter((l) => l && !/^frame |^dump |^pens |^visible |^[0-9a-f]+$|^\s+at |^PRISM threw/.test(l)).slice(-3).join(' | ').slice(0, 300);
      const run = { frames, of: N, asked: FRAMES, seconds: +((Date.now() - t0) / 1000).toFixed(1), threw, said: frames >= N ? '' : said,
        timedOut: signal === 'SIGKILL' };
      // The picture: `dump W H`, H rows of hex pens, a row of 256 hex colours; `visible` crops it.
      const at = lines.findIndex((l) => l.startsWith('dump '));
      if (at >= 0) {
        const [, w, h] = lines[at].split(' ').map(Number);
        const vis = lines.find((l) => l.startsWith('visible '))?.split(' ').slice(1).map(Number) ?? [0, 0, w - 1, h - 1];
        const [x0, y0, x1, y1] = [Math.max(vis[0], 0), Math.max(vis[1], 0), Math.min(vis[2], w - 1), Math.min(vis[3], h - 1)];
        const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
        const pixels = new Uint8Array(cw * ch);
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) pixels[y * cw + x] = parseInt(lines[at + 1 + y0 + y].substr(2 * (x0 + x), 2), 16);
        const palette = Uint8Array.from(lines[at + 1 + h].match(/../g).map((b) => parseInt(b, 16)));
        run.pens = new Set(pixels).size;
        run.width = cw; run.height = ch;
        if (run.pens > 1) { writeIndexedPng(join(OUT, 'shots', `${g.name}.png`), { pixels, width: cw, height: ch, palette }); run.shot = `shots/${g.name}.png`; }
      }
      run.verdict = run.timedOut ? 'timeout' : threw ? 'threw' : frames < N ? 'stopped' : (run.pens ?? 0) > 1 ? 'runs' : 'blank';
      done(run);
    });
  });
}

const todo = games.filter((g) => (!only || only.includes(g.name)) && audit.get(g.name)?.roms === 'complete' && lightFor(g.name)
  && (FORCE || !previous.get(g.name)?.run || (previous.get(g.name).run.asked ?? previous.get(g.name).run.of) !== FRAMES));
if (unread.length) console.log(`${unread.length} of ${LISTED.length} listed drivers were not read from the sources (${unread.slice(0, 6).join(" ")}${unread.length > 6 ? " ..." : ""}): they are not in the index`);
console.log(`MAME 0.34: ${games.length} games read; ${[...audit.values()].filter((a) => a.roms === 'complete').length} complete ROM sets in ${ROMS}; ${todo.length} to run at ${FRAMES} frames, ${JOBS} at a time`);
const results = new Map();
let next = 0, finished = 0;
await Promise.all(Array.from({ length: Math.min(JOBS, todo.length) }, async () => {
  while (next < todo.length) {
    const g = todo[next++];
    /*
     * One black frame is not a blank game: at frame 900 Mercs is between two screens. A blank
     * picture is asked again 400 frames on, and only a game blank at both is called blank.
     */
    let run = await runOne(g);
    if (run.verdict === 'blank') { const again = await runOne(g, FRAMES + 400); if (again.verdict !== 'blank') run = again; }
    results.set(g.name, run);
    finished++;
    if (run.verdict !== 'runs' || finished % 25 === 0) console.log(`  ${String(finished).padStart(4)}/${todo.length}  ${g.name.padEnd(9)} ${run.verdict}${run.threw ? `: ${run.threw.slice(0, 90)}` : run.said ? `: ${run.said.slice(0, 90)}` : ''}`);
  }
}));

// ---- the index the page reads
const rows = games.map((g) => {
  const a = audit.get(g.name) ?? { roms: 'absent', have: 0, need: 0 };
  // A run is kept only for a set that is complete NOW: the audit may have learnt since that one is not.
  const run = a.roms === 'complete' ? results.get(g.name) ?? previous.get(g.name)?.run ?? null : null;
  const light = lightFor(g.name);
  return { name: g.name, title: g.title, year: g.year, maker: g.maker, cloneOf: g.cloneOf, flags: g.flags, source: g.file,
    archive: g.archive, cores: light?.lightOf.cores ?? [], roms: a.roms, have: a.have, need: a.need,
    run, reference: golden.games[g.name] ? { frames: golden.games[g.name].frames } : null };
});
const count = (f) => rows.filter(f).length;
const summary = { listed: LISTED.length, games: rows.length, complete: count((r) => r.roms === 'complete'), ran: count((r) => r.run),
  runs: count((r) => r.run?.verdict === 'runs'), blank: count((r) => r.run?.verdict === 'blank'),
  stopped: count((r) => r.run?.verdict === 'stopped'), threw: count((r) => r.run?.verdict === 'threw'),
  timeout: count((r) => r.run?.verdict === 'timeout'), reference: count((r) => r.reference),
  notWorking: count((r) => r.flags.includes('not_working')) };
writeFileSync(indexPath, JSON.stringify({ release: '0.34', frames: FRAMES, written: new Date().toISOString(), summary,
  archives: Object.fromEntries([...ARCHIVES].map(([a, u]) => [a, u.length])), games: rows }));
console.log(`\n${summary.ran} run of ${summary.complete} complete sets: ${summary.runs} draw a picture, ${summary.blank} blank, ${summary.stopped} stopped, ${summary.threw} threw, ${summary.timeout} timed out`);
console.log(`${indexPath}`);
