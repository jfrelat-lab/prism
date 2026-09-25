// gate-borland-options.mjs — the Borland compiler options a target declares are the ones its own
// project file records.
//
// A Borland .PRJ is binary. Borland's PRJCFG utility converts one into the command-line options BCC
// would be given (`PRJCFG ProjFile.PRJ ConfigFile.CFG`), writing each option that differs from the
// compiler's default. `--capture` runs PRJCFG (Borland C++ 3.1's, the archive.org `bcpp31` item) in
// DOSBox-X on the UNMODIFIED project files and records its output in goldens/borland-prj.json; a
// replay needs neither Borland nor DOSBox.
//
//   node tools/gate-borland-options.mjs --capture --bc=/path/to/BC31
//   node tools/gate-borland-options.mjs
//
// WHY PRJCFG 3.1 IS BELIEVED ON 2.0 PROJECTS: its output agrees, on three settings, with what
// Hovertank 3-D's own compiler-generated assembly (IDLIBC.ASM) shows Borland did -- no -K and char
// loads sign-extended with cbw; -a and pad bytes after odd-sized globals; no -m, i.e. small, and
// MODEL SMALL in its .ASM. Those three agreements are checked here, against the assembly itself.
//
// Then the target: targets/keendreams.json must compile with the model, char signedness, enum size
// and alignment the options say. BCC's own help (bcc with no arguments) gives the meanings and the
// defaults: -K "default char is unsigned"; -a "generate word alignment"; -b* "treat enums as
// integers", a DEFAULT, so it holds unless -b- is written; -mm the medium model, small by default.
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, 'goldens', 'borland-prj.json');
const PROJECTS = {
  keendreams: 'corpus/KeenDreams/kdreams.prj',
  catacomb3d: 'corpus/Catacomb3D/CAT3D.PRJ',
  hovertank3d: 'corpus/Hovertank3D/HOVER.PRJ',
};

let bad = 0;
const report = (ok, what, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ok ' : ' BAD '} ${what.padEnd(60)} ${detail}`);
};

function capture() {
  const bc = process.argv.find((a) => a.startsWith('--bc='))?.slice(5);
  if (!bc || !existsSync(join(bc, 'BIN', 'PRJCFG.EXE'))) {
    console.log('--capture needs --bc=<Borland C++ 3.1 directory> holding BIN/PRJCFG.EXE');
    process.exit(1);
  }
  const work = mkdtempSync(join(tmpdir(), 'prjcfg-'));
  const names = {};
  for (const [k, rel] of Object.entries(PROJECTS)) {
    const dos = `${k.slice(0, 8).toUpperCase()}`;
    copyFileSync(join(ROOT, rel), join(work, `${dos}.PRJ`));
    names[k] = dos;
  }
  const cmds = Object.values(names).flatMap((n) => ['-c', `c:\\bin\\prjcfg ${n}.PRJ ${n}.CFG`]);
  const r = spawnSync('dosbox-x', ['-silent', '-nogui', '-nomenu', '-c', `mount c ${bc}`, '-c', `mount d ${work}`,
    '-c', 'd:', ...cmds, '-c', 'exit'], { encoding: 'utf8', env: { ...process.env, SDL_VIDEODRIVER: 'dummy' } });
  if (r.status !== 0) throw new Error(`dosbox-x: ${r.stderr}`);
  const out = {
    _doc: 'PRJCFG 2.0 from Borland C++ 3.1 (archive.org bcpp31), run in DOSBox-X on the unmodified project '
      + 'files by tools/gate-borland-options.mjs --capture. Each list is the BCC options PRJCFG wrote.',
  };
  for (const [k, n] of Object.entries(names)) {
    out[k] = readFileSync(join(work, `${n}.CFG`), 'latin1').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`captured the options of ${Object.keys(names).length} projects -> goldens/borland-prj.json`);
}

if (process.argv.includes('--capture')) capture();
if (!existsSync(GOLDEN)) { console.log('no goldens/borland-prj.json: run with --capture first'); process.exit(1); }
const g = JSON.parse(readFileSync(GOLDEN, 'utf8'));
const has = (k, opt) => g[k].includes(opt);
const model = (k) => (g[k].find((o) => /^-m[tsmclh]$/.test(o)) ?? '-ms').slice(2);

// 1. PRJCFG against Borland's own generated code, in Hovertank.
{
  const asm = readFileSync(join(ROOT, 'corpus/Hovertank3D/IDLIBC.ASM'), 'latin1');
  const signExt = /mov\s+al,byte ptr DGROUP:_key\s*\r?\n\s*cbw/.test(asm);
  report(!has('hovertank3d', '-K') && signExt, 'Hovertank: no -K, and its char key[] loads with cbw',
    `-K ${has('hovertank3d', '-K') ? 'present' : 'absent'}, cbw ${signExt ? 'seen' : 'NOT seen'}`);
  const pad = /_ch\s+label\s+byte\s*\r?\n\s*db\s+1 dup \(\?\)\s*\r?\n\s*db\s+1 dup \(\?\)\s*\r?\n\s*_mapwidthextra\s+label\s+word/.test(asm);
  report(has('hovertank3d', '-a') && pad, 'Hovertank: -a, and a pad byte between _ch and a word',
    `-a ${has('hovertank3d', '-a') ? 'present' : 'absent'}, pad ${pad ? 'seen' : 'NOT seen'}`);
  const wordEnum = /action\.dir = northwest;[\s\S]{0,80}mov\s+word ptr \[bp-6\],7/.test(asm);
  report(!has('hovertank3d', '-b-') && wordEnum, 'Hovertank: no -b-, and an enum field written as a word',
    `-b- ${has('hovertank3d', '-b-') ? 'present' : 'absent'}, word store ${wordEnum ? 'seen' : 'NOT seen'}`);
  const small = /MODEL\s+SMALL/i.test(readFileSync(join(ROOT, 'corpus/Hovertank3D/IDASM.ASM'), 'latin1'));
  report(model('hovertank3d') === 's' && small, 'Hovertank: small model, as its .ASM declares', `-m${model('hovertank3d')}`);
}

// 2. The Keen Dreams target declares what its project records.
{
  const t = JSON.parse(readFileSync(join(ROOT, 'targets/keendreams.json'), 'utf8'));
  const c = t.compile ?? {};
  const wantModel = { s: 'dos16', m: 'dos16m', l: 'dos16l' }[model('keendreams')];
  report(c.model === wantModel, `Keen: model -m${model('keendreams')} is ${wantModel}`, `target: ${c.model}`);
  const wantSigned = !has('keendreams', '-K');
  report(c.signedChar === wantSigned, `Keen: char ${wantSigned ? 'signed (no -K)' : 'UNSIGNED (-K)'}`, `target signedChar: ${c.signedChar}`);
  const wantEnums = has('keendreams', '-b-') ? undefined : 'int';
  report(c.enums === wantEnums, `Keen: enums ${wantEnums ? 'int-sized (-b, the default)' : 'by range (-b-)'}`, `target enums: ${c.enums}`);
  const wantPack = has('keendreams', '-a') ? undefined : 1;
  report(c.pack === wantPack, `Keen: ${wantPack ? 'byte alignment (no -a)' : 'word alignment (-a) -- the model\'s 2'}`, `target pack: ${c.pack}`);
}

console.log(bad ? `\n${bad} WRONG` : '\nthe targets compile with the options their own Borland projects record.');
process.exit(bad ? 1 : 0);
