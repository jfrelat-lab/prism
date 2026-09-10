// mame-golden.mjs — one fingerprint per ROM set, born green and replayed cheaply.
//
// WHAT A GOLDEN IS FOR HERE, and what it is not. `mamediff` answers "does PRISM agree with a native
// build of the same sources", which is the strong question and costs a container, a compiler and a
// run per game. A golden answers the cheap question -- "does PRISM still do what it did" -- for
// every game at once, without the reference.
//
// THE RULE THAT MAKES IT WORTH HAVING: a golden is only ever written for a game whose differential
// was GREEN at the moment of writing. A fingerprint recorded from PRISM alone would freeze whatever
// PRISM happened to do, wrong answers included, and then detect only departures from that -- which
// is the shape of a check that cannot fail (see docs/TESTING.md). So `--write` runs the full
// differential and records nothing for a game that disagreed; it reports it instead.
//
//   node tools/mame-golden.mjs --write --roms=<dir> [--release=05] [--frames=120] [--games=a,b]
//   node tools/mame-golden.mjs --check --roms=<dir>
//
// The golden lives in goldens/mame<release>.json and IS committed: it is a claim about the program,
// not a build artefact. No ROM data enters it -- only each set's own name and the fingerprint of the
// frames it produced.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RELEASE = process.argv.find(a => a.startsWith('--release='))?.slice(10) ?? '05';
const FRAMES = +(process.argv.find(a => a.startsWith('--frames='))?.slice(9) ?? 120);
const romDir = process.argv.find(a => a.startsWith('--roms='))?.slice(7);
const only = process.argv.find(a => a.startsWith('--games='))?.slice(8)?.split(',');
const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check');

if (!romDir || !existsSync(romDir) || (!WRITE && !CHECK)) {
  console.error('usage: node tools/mame-golden.mjs --write|--check --roms=<dir> ' +
    '[--release=05] [--frames=120] [--games=a,b]');
  process.exit(2);
}

const goldenPath = join(ROOT, 'goldens', `mame${RELEASE}.json`);
const SRC = join(ROOT, 'corpus', `mame${RELEASE}`);

/*
 * WHICH GAMES EXIST, from the program's own table rather than from a list kept here.
 *
 * `src/driver.c` holds `struct GameDriver drivers[]`, one row per supported name:
 *
 *     { "pacman",   pacman_rom,   0,   &pacman_driver },
 *
 * so the names come from the release being tested, and a release that adds a game is covered without
 * anything being edited. The alternative -- a list in this file -- is the drift that made
 * tools/mame.mjs ask for a unit MAME 0.3 had deleted.
 */
function supportedGames() {
  const s = readFileSync(join(SRC, 'src', 'driver.c'), 'latin1');
  const rows = [...s.matchAll(/\{\s*"([a-z0-9]+)"\s*,\s*\w+\s*,[^}]*?&\s*\w+_driver\s*\}/g)];
  return rows.map(m => m[1]);
}

/** A set with at least one file that is not its readme. An empty directory is not a ROM set. */
function hasRoms(game) {
  const d = join(romDir, game);
  if (!existsSync(d) || !statSync(d).isDirectory()) return false;
  return readdirSync(d).some(f => !/readme/i.test(f) && statSync(join(d, f)).isFile());
}

const all = supportedGames();
const playable = all.filter(hasRoms);
const games = only ? playable.filter(g => only.includes(g)) : playable;
const noRoms = all.filter(g => !hasRoms(g));

console.log(`MAME 0.${RELEASE.replace(/^0/, '')}: ${all.length} games in its own drivers[] table, ` +
  `${playable.length} with ROMs present`);
if (noRoms.length) {
  console.log(`  no ROMs, skipped (${noRoms.length}): ${noRoms.join(' ')}`);
}
console.log(`${WRITE ? 'writing' : 'checking'} ${games.length} at ${FRAMES} frames\n`);

/** Run mamediff for one game and return {fingerprint, lines, agreed}. */
function runOne(game, withReference) {
  const args = ['tools/mamediff.mjs', `--release=${RELEASE}`, `--game=${game}`,
    `--roms=${romDir}`, `--frames=${FRAMES}`];
  if (!withReference) args.push('--no-reference');
  const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const fp = out.match(/fingerprint ([0-9a-f]+) over (\d+) lines/);
  /*
   * The geometry and the palette size come out of the SAME log the fingerprint hashes -- osdnull.c
   * prints `display WxH` once and a `pen N = rrggbb` line per pen -- so recording them costs nothing
   * and makes the golden readable by a person, not just comparable by a machine. A resolution and a
   * pen count are also the two things that distinguish these drivers from one another, so a table of
   * them is the answer to "are these nineteen runs of the same code?".
   */
  // From the fingerprint line, which is the only place this tool can see them -- see mamediff.
  const meta = out.match(/fingerprint [0-9a-f]+ over \d+ lines · display (\S+) · (\d+) pens/);
  return {
    fingerprint: fp?.[1] ?? null,
    lines: fp ? +fp[2] : 0,
    display: meta?.[1] ?? null,
    pens: meta ? +meta[2] : null,
    // The differential's own verdict, not this tool's opinion of it.
    agreed: /✓ identical over/.test(out),
    why: (out.match(/^✗ .*$/m) ?? out.match(/^(no oracle|.*side failed|PRISM side threw).*$/m) ?? [])[0]
      ?? (fp ? null : 'no fingerprint in the output'),
  };
}

/*
 * A PARTIAL WRITE MERGES; it does not replace.
 *
 * `--write --games=pacman,wow` started from an empty object and silently deleted the other
 * seventeen entries -- a regeneration of two games destroying the golden for the rest is data loss
 * disguised as an update, and it happened on the first partial run.
 */
const existing = existsSync(goldenPath) ? JSON.parse(readFileSync(goldenPath, 'utf8')) : null;
if (CHECK && !existing) {
  console.error(`no golden at ${goldenPath} — create one with --write first`);
  process.exit(2);
}
const golden = CHECK
  ? existing
  : { _doc: [], release: RELEASE, frames: FRAMES, games: { ...(only ? existing?.games ?? {} : {}) } };
if (WRITE && only && existing) {
  console.log(`merging into the existing golden (${Object.keys(existing.games).length} entries)\n`);
}

let ok = 0, bad = 0, skipped = 0;
const problems = [];

for (const game of games) {
  process.stdout.write(`  ${game.padEnd(10)} `);
  if (WRITE) {
    const r = runOne(game, true);
    if (!r.agreed || !r.fingerprint) {
      skipped++;
      problems.push(`${game}: ${r.why ?? 'disagreed with the reference'}`);
      console.log(`SKIPPED — disagrees with the native build, so nothing is recorded`);
      continue;
    }
    golden.games[game] = { fingerprint: r.fingerprint, lines: r.lines,
                           display: r.display, pens: r.pens };
    ok++;
    console.log(`${r.fingerprint}  ${String(r.display).padEnd(8)} ${String(r.pens).padStart(3)} pens  ` +
      `${r.lines} lines, verified against the native build`);
  } else {
    const want = golden.games[game];
    if (!want) { skipped++; console.log('not in the golden'); continue; }
    const r = runOne(game, false);
    if (r.fingerprint === want.fingerprint) { ok++; console.log('ok'); }
    else {
      bad++;
      problems.push(`${game}: golden ${want.fingerprint} (${want.lines} lines), ` +
        `now ${r.fingerprint ?? 'none'} (${r.lines} lines)`);
      console.log(`CHANGED — golden ${want.fingerprint}, now ${r.fingerprint ?? 'none'}`);
    }
  }
}

if (WRITE) {
  golden.frames = FRAMES;
  golden._doc = [
    'One fingerprint per ROM set: a sha256 prefix over the frame log MAME itself prints, which is a',
    'display hash per frame and therefore the whole observable behaviour of the run.',
    '',
    'EVERY ENTRY HERE WAS VERIFIED against a native build of the same sources at the moment it was',
    'written (tools/mamediff.mjs), and a game that disagreed is absent rather than recorded. That is',
    'what separates a golden from a snapshot of whatever the program happened to do.',
    '',
    'Replay with: node tools/mame-golden.mjs --check --roms=<dir>  -- which needs no compiler, no',
    'container and no ROM fetching. Regenerate after a deliberate change with --write.',
  ];
  mkdirSync(dirname(goldenPath), { recursive: true });
  writeFileSync(goldenPath, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`\n${ok} recorded, ${skipped} left out → ${goldenPath.replace(`${ROOT}/`, '')}`);
} else {
  console.log(`\n${ok} match, ${bad} changed, ${skipped} not in the golden`);
}

if (problems.length) {
  console.log('\n' + problems.map(p => `  ${p}`).join('\n'));
}
process.exit(bad || (WRITE && ok === 0) ? 1 : 0);
