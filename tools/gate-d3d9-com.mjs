// gate-d3d9-com.mjs — src/env/d3d9.c's vtables against the method orders of <d3d9.h>.
//
// A COM call is a slot index: `dev->lpVtbl->Clear` reads whatever pointer sits at Clear's position
// in the table, whatever its name. A table that lists two functions in the wrong order still
// compiles (every slot is a function pointer, and the initialisers are positional) and calls the
// wrong function at run time. The order is d3d9.h's, kept once in src/env/headers-d3d9.js
// (d3d9Methods); this gate holds every table in d3d9.c to it:
//   - a static table: entry k is `<prefix>_<method k>`, and there are exactly as many entries as
//     methods;
//   - a table built at run time (cube_vtbl_init, ib_vtbl_init) copies N slots of another table, then
//     assigns members by name: every slot must end up filled with its method's function, and a slot
//     kept from the copy must hold a function written for both interfaces (a buf_*, or a tex_* of
//     IDirect3DBaseTexture9) -- vb_GetDesc left in the index buffer's GetDesc slot has the right
//     name and fills the wrong structure.
// A function matches its method by the suffix after its prefix (dev_GetBackBuffer is GetBackBuffer),
// so a function shared between tables (buf_Lock in both buffer tables) is checked by its name too.
//
// The gate first runs on a set of mutated copies of d3d9.c -- two entries swapped, a run-time slot
// assigned the wrong function, a short copy, a missing entry -- and each must come out red, so a
// gate that cannot fail does not pass.
//
//   node tools/gate-d3d9-com.mjs [--verbose]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d3d9Methods, D3D9_INTERFACES } from '../src/env/headers-d3d9.js';

const VERBOSE = process.argv.includes('--verbose');
const SRC = fileURLToPath(new URL('../src/env/d3d9.c', import.meta.url));

const STATIC_TABLES = ['surface_vtbl', 'texture_vtbl', 'volume_vtbl', 'vb_vtbl', 'blob_vtbl', 'swap_vtbl', 'device_vtbl', 'd3d_vtbl'];
// A table built at run time keeps the slots it copies and does not reassign; only these may be kept,
// the rest being written for the source interface alone (vb_GetDesc fills a vertex buffer's desc).
const BASE_TEXTURE = d3d9Methods('IDirect3DBaseTexture9').length;
const RUNTIME_TABLES = {
  cube_vtbl_init: { keeps: (fn, k) => k < BASE_TEXTURE, why: `only IDirect3DBaseTexture9's ${BASE_TEXTURE} tex_* slots serve a cube` },
  ib_vtbl_init: { keeps: (fn) => fn.startsWith('buf_'), why: 'only buf_* serve both buffers' },
};
// A table also handed out, cast, as another interface: it must fit that interface's order as well.
const ALSO_SERVES = { blob_vtbl: ['IDirect3DPixelShader9'] };

const suffix = (fn) => fn.slice(fn.indexOf('_') + 1);

/** Every check d3d9.c's text passes or fails: [{ ok, what, detail }]. */
function check(src) {
  const out = [];
  const t = (ok, what, detail = '') => out.push({ ok, what, detail });

  // the interface of each table, from its declaration `static struct IFooVtbl name`
  const ifaceOf = {};
  for (const m of src.matchAll(/static struct (\w+)Vtbl (\w+)\s*[;=]/g)) ifaceOf[m[2]] = m[1];
  const methodsOf = (iface) => (D3D9_INTERFACES.includes(iface) ? d3d9Methods(iface) : null);

  // positional entries of the static initialisers
  const entries = {};
  for (const m of src.matchAll(/static struct \w+Vtbl (\w+) = \{([\s\S]*?)\};/g))
    entries[m[1]] = m[2].split(',').map((s) => s.trim()).filter(Boolean);

  const order = (table, iface, list) => {
    const methods = methodsOf(iface);
    if (!methods) return t(false, `${table} as ${iface}`, `no interface ${iface} in headers-d3d9.js`);
    const wrong = [];
    for (let k = 0; k < Math.max(methods.length, list.length); k++)
      if (suffix(list[k] ?? '') !== methods[k]) wrong.push(`slot ${k}: ${list[k] ?? '(none)'} where ${methods[k] ?? '(no method)'} is`);
    t(wrong.length === 0, `${table} as ${iface}: ${list.length} entries in the order of its ${methods.length} methods`,
      wrong.slice(0, 6).join('\n        ') + (wrong.length > 6 ? `\n        ... ${wrong.length} slots wrong in all` : ''));
  };

  for (const table of STATIC_TABLES) {
    if (!entries[table]) { t(false, `${table} has a static initialiser`, 'not found in d3d9.c'); continue; }
    order(table, ifaceOf[table], entries[table]);
    for (const other of ALSO_SERVES[table] ?? []) order(table, other, entries[table]);
  }

  for (const [init, { keeps, why }] of Object.entries(RUNTIME_TABLES)) {
    const body = src.match(new RegExp(`static void ${init}\\(void\\)\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
    if (!body) { t(false, `${init} exists`, 'not found in d3d9.c'); continue; }
    const ptrs = body.match(/void \*\*dst = \(void \*\*\)&(\w+), \*\*src = \(void \*\*\)&(\w+);/);
    const copy = body.match(/for \(i = 0; i < (\d+); i\+\+\) dst\[i\] = src\[i\];/);
    if (!ptrs || !copy) { t(false, `${init} copies a prefix of one table into another`, 'the dst/src pointers or the copy loop are not in the expected shape'); continue; }
    const [, dst, from] = ptrs, n = +copy[1];
    const methods = methodsOf(ifaceOf[dst]);
    if (!methods || !entries[from]) { t(false, `${init}: ${dst} has a known interface and ${from} a static initialiser`, `${ifaceOf[dst]}, ${from}`); continue; }

    // what each slot holds once the function has run: the copy, then the named assignments over it
    const assigned = [...body.matchAll(new RegExp(`\\b${dst}\\.(\\w+) = (\\w+);`, 'g'))].map((m) => ({ member: m[1], fn: m[2] }));
    const problems = [];
    for (const { member } of assigned) {
      if (!methods.includes(member)) problems.push(`${member} is not a method of ${ifaceOf[dst]}`);
      else if (assigned.filter((a) => a.member === member).length > 1) problems.push(`${member} is assigned more than once`);
    }
    methods.forEach((m, k) => {
      const set = assigned.find((a) => a.member === m);
      const fn = set ? set.fn : k < n ? entries[from][k] : null;
      if (!fn) problems.push(`slot ${k} (${m}) is never filled`);
      else if (suffix(fn) !== m) problems.push(`slot ${k} (${m}) holds ${fn}`);
      // a function kept from the source table must be one written for both interfaces
      else if (!set && !keeps(fn, k)) problems.push(`slot ${k} (${m}) keeps ${from}'s ${fn}; ${why}`);
    });
    t(problems.length === 0, `${init}: all ${methods.length} slots of ${dst} hold their method, copied from ${from} (${n}) or assigned by name`,
      [...new Set(problems)].join('\n        '));
  }
  return out;
}

// ---------------------------------------------------------------- mutations: each must be red

/** Swap two whole-word identifiers wherever they appear inside the named static table only. */
const swapIn = (table, a, b) => (src) => src.replace(new RegExp(`(static struct \\w+Vtbl ${table} = \\{)([\\s\\S]*?)(\\};)`), (_, h, body, e) =>
  h + body.replace(new RegExp(`\\b(${a}|${b})\\b`, 'g'), (w) => (w === a ? b : a)) + e);
const MUTATIONS = [
  ['device_vtbl: GetBackBuffer and GetRasterStatus swapped', swapIn('device_vtbl', 'dev_GetBackBuffer', 'dev_GetRasterStatus')],
  ['vb_vtbl: the shared buf_Lock and buf_Unlock swapped', swapIn('vb_vtbl', 'buf_Lock', 'buf_Unlock')],
  ['surface_vtbl: GetDC and ReleaseDC swapped', swapIn('surface_vtbl', 'surf_GetDC', 'surf_ReleaseDC')],
  ['d3d_vtbl: CreateDevice dropped', (s) => s.replace(/(d3d_GetAdapterMonitor), d3d_CreateDevice,/, '$1,')],
  ['cube_vtbl_init: LockRect assigned cube_UnlockRect', (s) => s.replace('cube_vtbl.LockRect = cube_LockRect;', 'cube_vtbl.LockRect = cube_UnlockRect;')],
  ['cube_vtbl_init: one slot too few copied, GenerateMipSubLevels left empty', (s) => s.replace('for (i = 0; i < 17; i++) dst[i] = src[i];', 'for (i = 0; i < 16; i++) dst[i] = src[i];')],
  ['cube_vtbl_init: GetLevelDesc never assigned', (s) => s.replace('cube_vtbl.GetLevelDesc = cube_GetLevelDesc; ', '')],
  ['cube_vtbl_init: 18 slots copied and GetLevelDesc not reassigned, the 2D one kept', (s) => s
    .replace('for (i = 0; i < 17; i++) dst[i] = src[i];', 'for (i = 0; i < 18; i++) dst[i] = src[i];')
    .replace('cube_vtbl.GetLevelDesc = cube_GetLevelDesc; ', '')],
  ['ib_vtbl_init: GetDesc not reassigned, the vertex buffer one kept', (s) => s.replace(' ib_vtbl.GetDesc = ib_GetDesc;', '')],
  ['ib_vtbl_init: GetType not reassigned, the vertex buffer one kept', (s) => s.replace('ib_vtbl.GetType = ib_GetType; ', '')],
];

const src = readFileSync(SRC, 'utf8');
let bad = 0;
const line = (ok, what, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${ok || !detail ? '' : `\n        ${detail}`}`); if (!ok) bad++; };

console.log('self-test: each mutation of d3d9.c must be red');
for (const [what, mutate] of MUTATIONS) {
  const copy = mutate(src);
  if (copy === src) { line(false, `mutation applies: ${what}`, 'the text it edits is no longer in d3d9.c'); continue; }
  const failed = check(copy).filter((r) => !r.ok);
  line(failed.length > 0, `red under: ${what}`, 'every check passed');
  if (VERBOSE) for (const f of failed) console.log(`         -> ${f.what}\n            ${f.detail}`);
}

console.log('d3d9.c as it is: green');
const results = check(src);
for (const r of results) line(r.ok, r.what, r.detail);

console.log(bad ? `\n${bad} FAILED` : `\nall ${MUTATIONS.length + results.length} passed`);
process.exit(bad ? 1 : 0);
