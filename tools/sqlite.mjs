// sqlite.mjs — build SQLite from its amalgamation, and run its own SQL.
//
// A different kind of target from a game, and that is the point. There is no platform layer to write,
// no data to supply and no framebuffer to look at: SQLite is 269,649 lines of the most portable C
// ever written, and it either computes the right answers or it does not. Where MAME and Quake test
// whether PRISM can host a program, this tests whether PRISM can COMPILE one — six times Quake's
// size, in a single translation unit.
//
// The oracle is exact and needs no invention: the same amalgamation, built by i386 gcc in the
// container, running the same SQL. Byte-identical output or a defect.
//
//   node tools/sqlite.mjs              # report what the build is missing, ranked
//   node tools/sqlite.mjs --run        # run it
//   node tools/sqlite.mjs --diff       # and check it against i386 gcc

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, installStdio } from '../src/compile.js';
import { HEADERS } from '../src/env/headers.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'corpus', 'sqlite');

if (!existsSync(join(SRC, 'sqlite3.c'))) {
  console.error(`corpus missing: ${SRC}\nFetch it with:\n` +
    `  curl -sLO https://sqlite.org/2026/sqlite-amalgamation-3530400.zip\n` +
    `  unzip -q sqlite-amalgamation-*.zip -d corpus && mv corpus/sqlite-amalgamation-* corpus/sqlite`);
  process.exit(2);
}

/*
 * The driver is written here rather than taken from SQLite's shell, because the shell is another
 * 1.2 MB of C and a terminal front end — what is being tested is the ENGINE. This exercises the parts
 * that would expose a compiler defect: the query planner, the B-tree, the VDBE, integer and floating
 * point arithmetic, string collation, and an aggregate with an index.
 */
const DRIVER = `
#include <stdio.h>
#include <string.h>
#include "sqlite3.h"

static int fail = 0;

static void check(const char *what, const char *got, const char *want)
{
    if (strcmp(got, want) != 0) { printf("MISMATCH %s: got [%s] want [%s]\\n", what, got, want); fail++; }
    else printf("ok %s = %s\\n", what, got);
}

static char row[256];

static int collect(void *unused, int cols, char **val, char **name)
{
    int i;
    row[0] = 0;
    for (i = 0; i < cols; i++) {
        if (i) strcat(row, "|");
        strcat(row, val[i] ? val[i] : "NULL");
    }
    return 0;
}

int main(void)
{
    sqlite3 *db;
    char *err = 0;
    int rc, i;
    char sql[256];

    printf("SQLite %s\\n", sqlite3_libversion());

    rc = sqlite3_open(":memory:", &db);
    if (rc) { printf("open failed: %s\\n", sqlite3_errmsg(db)); return 1; }

    sqlite3_exec(db, "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, score REAL);", 0, 0, &err);
    if (err) { printf("create failed: %s\\n", err); return 1; }

    for (i = 1; i <= 200; i++) {
        sprintf(sql, "INSERT INTO t VALUES(%d, 'name%03d', %d.5);", i, i, i * 3);
        sqlite3_exec(db, sql, 0, 0, &err);
        if (err) { printf("insert failed: %s\\n", err); return 1; }
    }

    sqlite3_exec(db, "SELECT count(*) FROM t;", collect, 0, &err);
    check("count", row, "200");

    sqlite3_exec(db, "SELECT sum(score) FROM t;", collect, 0, &err);
    check("sum", row, "60400.0");

    sqlite3_exec(db, "SELECT name FROM t WHERE id = 137;", collect, 0, &err);
    check("lookup", row, "name137");

    sqlite3_exec(db, "CREATE INDEX i_name ON t(name);", 0, 0, &err);
    sqlite3_exec(db, "SELECT id FROM t WHERE name = 'name042';", collect, 0, &err);
    check("indexed lookup", row, "42");

    sqlite3_exec(db, "SELECT id,name FROM t ORDER BY name DESC LIMIT 1;", collect, 0, &err);
    check("order by", row, "200|name200");

    sqlite3_exec(db, "SELECT avg(score) FROM t WHERE id % 7 = 0;", collect, 0, &err);
    check("avg with modulo", row, "304.0");

    sqlite3_exec(db, "SELECT group_concat(id) FROM t WHERE id < 6;", collect, 0, &err);
    check("group_concat", row, "1,2,3,4,5");

    sqlite3_exec(db, "SELECT a.id FROM t a JOIN t b ON b.id = a.id + 1 WHERE b.name = 'name100';", collect, 0, &err);
    check("self join", row, "99");

    sqlite3_close(db);
    printf("%s\\n", fail ? "FAILURES" : "all checks passed");
    return fail;
}
`;

const missing = new Set();
function resolve(name) {
  const base = name.replace(/^.*\//, '');
  const local = join(SRC, base);
  if (existsSync(local)) return { path: local, text: readFileSync(local, 'latin1') };
  // The FULL name first: `sys/types.h` is its own key, and reducing to the basename looked up
  // `types.h`, found nothing, and stubbed a header that was right there.
  const std = HEADERS[name] ?? HEADERS[base];
  if (std !== undefined) return { path: `<${name}>`, text: std };
  missing.add(name);
  return { path: `<missing:${name}>`, text: '' };
}

const amalgamation = readFileSync(join(SRC, 'sqlite3.c'), 'latin1');
const lines = amalgamation.split('\n').length;
console.log(`SQLite amalgamation — 1 translation unit, ${lines.toLocaleString('en')} lines ` +
  `(${(amalgamation.length / 1048576).toFixed(1)} MB of C)`);

const t0 = performance.now();
let program;
try {
  program = compileProgram([
    { file: join(SRC, 'sqlite3.c'), source: amalgamation },
    { file: 'driver.c', source: DRIVER },
  ], {
    /*
     * Threads and loadable extensions are off, which is a build configuration SQLite documents and
     * every embedded build uses. Nothing else is switched off: the query planner, the B-tree and the
     * VDBE are all compiled as shipped.
     */
    defines: {
      SQLITE_THREADSAFE: '0',
      SQLITE_OMIT_LOAD_EXTENSION: '1',
      SQLITE_DEFAULT_MEMSTATUS: '0',
    },
    resolve,
    memory: 256 * 1024 * 1024,
    collect: true,
  });
} catch (e) {
  if (missing.size) console.log(`headers stubbed (empty): ${[...missing].join(' ')}`);
  console.log(`\n✗ build failed after ${(performance.now() - t0).toFixed(0)} ms:`);
  console.log(`  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`);
  process.exit(1);
}
const compileMs = performance.now() - t0;

if (missing.size) console.log(`headers stubbed (empty): ${[...missing].join(' ')}`);

if (program.failures.length) {
  const buckets = new Map();
  for (const f of program.failures) {
    const key = f.message.replace(/^.*?:\d+: /, '').slice(0, 76);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(f.fn);
  }
  const ranked = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`\n${program.failures.length} of ${Object.keys(program.F).length} functions could not ` +
    `be emitted, ${ranked.length} distinct causes:\n`);
  for (const [msg, where] of ranked.slice(0, 20)) {
    console.log(`  ${String(where.length).padStart(4)}  ${msg}`);
    console.log(`        e.g. ${where.slice(0, 4).join(' ')}`);
  }
}

console.log(`\n✓ compiled in ${(compileMs / 1000).toFixed(1)} s: ${Object.keys(program.F).length} ` +
  `functions, ${(program.src.length / 1048576).toFixed(1)} MB of emitted JavaScript`);

// --line=N: print the emitted JavaScript around a line, which is how a stack trace becomes a defect.
const lineArg = process.argv.find(a => a.startsWith('--line='));
if (lineArg) {
  const n = +lineArg.slice(7);
  const lines = program.src.split('\n');
  for (let i = Math.max(0, n - 3); i < Math.min(lines.length, n + 2); i++) {
    console.log(`${String(i + 1).padStart(7)}  ${lines[i].slice(0, 300)}`);
  }
}

if (process.argv.includes('--run')) {
  installStdio(program.M, { files: {} });
  const t1 = performance.now();
  try {
    const r = program.run(['sqlite']);
    console.log(`\n${r.stdout}`);
    console.log(`exit ${r.code} · ran in ${((performance.now() - t1) / 1000).toFixed(2)} s`);
  } catch (e) {
    console.log(`\n✗ ran and threw: ${e.message}`);
    console.log((e.stack || '').split('\n').slice(1, 9).join('\n'));
  }
}
