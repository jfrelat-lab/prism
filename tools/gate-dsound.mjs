// gate-dsound.mjs — src/env/dsound.c, the silent DirectSound 8, as a C++ program calls it (.kkrieger's _start.cpp
// does, through dsound.h's virtual methods). There is no external reference to hold it to: the oracle container has
// no sound driver, so Wine's dsound would answer DSERR_NODRIVER. The checks are the SDK's documented rules, each
// with the mutation of dsound.c that must turn it red (run first):
//   - a 3D listener only from a primary buffer created with DSBCAPS_CTRL3D, a 3D buffer only from a CTRL3D buffer;
//   - Lock wraps at the end of the buffer into a second part, DSBLOCK_ENTIREBUFFER takes the whole;
//   - a duplicated buffer shares the bytes and keeps a cursor of its own;
//   - the play cursor stands still while stopped and advances with the clock while playing, wrapping when looping;
//     Stop keeps it where it had got to.
//
//   node tools/gate-dsound.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProgram, builtinHeaderResolver } from '../src/compile.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROGRAM = `
#include <windows.h>
#include <dsound.h>
#include <stdio.h>
extern "C" int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int)
{
  IDirectSound8 *ds = 0; IDirectSoundBuffer *prim = 0, *prim2 = 0, *sb = 0, *dup = 0, *b3 = 0; IDirectSound3DListener *l = 0;
  IDirectSound3DBuffer *x3 = 0; DSBUFFERDESC d; WAVEFORMATEX f; void *p1, *p2; DWORD n1, n2, a, b, s; unsigned char *q;
  printf("create %d\\n", DirectSoundCreate8(0, &ds, 0) == DS_OK);
  memset(&d, 0, sizeof d); d.dwSize = sizeof d; d.dwFlags = DSBCAPS_PRIMARYBUFFER;
  ds->CreateSoundBuffer(&d, &prim, 0);
  printf("listener-plain %d\\n", prim->QueryInterface(IID_IDirectSound3DListener, (void **)&l) == E_NOINTERFACE);
  d.dwFlags = DSBCAPS_PRIMARYBUFFER | DSBCAPS_CTRL3D; ds->CreateSoundBuffer(&d, &prim2, 0);
  printf("listener-3d %d\\n", prim2->QueryInterface(IID_IDirectSound3DListener, (void **)&l) == DS_OK && l && l->CommitDeferredSettings() == DS_OK);
  memset(&f, 0, sizeof f); f.wFormatTag = WAVE_FORMAT_PCM; f.nChannels = 2; f.nSamplesPerSec = 1000; f.nBlockAlign = 4; f.nAvgBytesPerSec = 4000; f.wBitsPerSample = 16;
  d.dwFlags = DSBCAPS_GETCURRENTPOSITION2; d.dwBufferBytes = 4000; d.lpwfxFormat = &f;
  ds->CreateSoundBuffer(&d, &sb, 0);
  printf("buffer3d-plain %d\\n", sb->QueryInterface(IID_IDirectSound3DBuffer, (void **)&x3) == E_NOINTERFACE);
  d.dwFlags = DSBCAPS_CTRL3D; d.dwBufferBytes = 400; ds->CreateSoundBuffer(&d, &b3, 0);
  printf("buffer3d-3d %d\\n", b3->QueryInterface(IID_IDirectSound3DBuffer, (void **)&x3) == DS_OK && x3);
  sb->Lock(3900, 300, &p1, &n1, &p2, &n2, 0);
  printf("lock-wrap %d\\n", n1 == 100 && n2 == 200 && p2 && (unsigned char *)p1 - (unsigned char *)p2 == 3900);
  sb->Lock(123, 0, &p1, &n1, &p2, &n2, DSBLOCK_ENTIREBUFFER);
  q = (unsigned char *)p1; q[7] = 42; sb->Unlock(p1, n1, p2, n2);
  printf("lock-entire %d\\n", n1 == 4000 && n2 == 0);
  ds->DuplicateSoundBuffer(sb, &dup);
  dup->Lock(0, 0, &p1, &n1, &p2, &n2, DSBLOCK_ENTIREBUFFER);
  printf("duplicate-shares %d\\n", ((unsigned char *)p1)[7] == 42);
  sb->GetCurrentPosition(&a, 0); Sleep(30); sb->GetCurrentPosition(&b, 0);
  printf("stopped-still %d\\n", a == b);
  sb->Play(0, 0, DSBPLAY_LOOPING); a = timeGetTime(); while (timeGetTime() - a < 60) ; sb->GetCurrentPosition(&b, 0); sb->GetStatus(&s);
  printf("playing-advances %d\\n", b > 0 && b < 4000 && (s & DSBSTATUS_PLAYING) && (s & DSBSTATUS_LOOPING));
  dup->GetCurrentPosition(&a, 0);
  printf("duplicate-own-cursor %d\\n", a == 0);
  sb->GetCurrentPosition(&n1, 0); sb->Stop(); sb->GetCurrentPosition(&a, 0); Sleep(30); sb->GetCurrentPosition(&b, 0); sb->GetStatus(&s);
  printf("stop-holds %d\\n", a == b && a >= n1 && !(s & DSBSTATUS_PLAYING));
  return 0;
}
`;
const CHECKS = ['create', 'listener-plain', 'listener-3d', 'buffer3d-plain', 'buffer3d-3d', 'lock-wrap', 'lock-entire', 'duplicate-shares',
  'stopped-still', 'playing-advances', 'duplicate-own-cursor', 'stop-holds'];
// each must turn at least one check red
const MUTATIONS = [
  ['a listener from any primary', ' && (b->flags & DSBCAPS_CTRL3D)) { *out = s3d_new(b, &listener_vtbl)', ') { *out = s3d_new(b, &listener_vtbl)'],
  ['a 3D buffer from any buffer', 'if (same(riid, &IID_IDirectSound3DBuffer) && (b->flags & DSBCAPS_CTRL3D)', 'if (same(riid, &IID_IDirectSound3DBuffer)'],
  ['Lock does not wrap', 'if (p2) *p2 = n > *n1 ? b->bits : 0;', 'if (p2) *p2 = 0;'],
  ['a duplicate copies the bytes', '*b = *a;                                 /* the same bytes, a cursor of its own */',
    '*b = *a; b->bits = (unsigned char *)calloc(1, a->size + 1);'],
  ['the cursor never moves', 'if (!b->playing || !b->size) return b->pos;', 'return b->pos;'],
  ['Stop forgets where it was', 'static HRESULT STDMETHODCALLTYPE sb_Stop(IDirectSoundBuffer8 *This) { SBuf *b = SB(This); fix(b);', 'static HRESULT STDMETHODCALLTYPE sb_Stop(IDirectSoundBuffer8 *This) { SBuf *b = SB(This); b->pos = 7;'],
];

const env = (n) => readFileSync(join(ROOT, 'src', 'env', n), 'utf8');
function run(dsound) {
  const units = [{ file: 'probe.cpp', source: PROGRAM }, ...['win32-app.c', 'win32.c'].map((n) => ({ file: `src/env/${n}`, source: env(n) })), { file: 'src/env/dsound.c', source: dsound }];
  const p = compileProgram(units, { resolve: builtinHeaderResolver({}), collect: true, memory: 32 << 20, cxx: { compiler: 'msvc', language: { '*.c': 'c' } } });
  if (p.failures?.length) return { error: p.failures.map((f) => `${f.fn}: ${f.message}`).join('; ') };
  const out = p.run(['probe']).stdout;
  return Object.fromEntries(out.trim().split('\n').map((l) => l.split(' ')).map(([k, v]) => [k, v === '1']));
}

let bad = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${ok || !detail ? '' : `\n        ${detail}`}`); if (!ok) bad++; };
const src = env('dsound.c');
for (const [name, a, b] of MUTATIONS) {
  if (src.split(a).length !== 2) { check(false, `mutation site for "${name}"`, 'not found exactly once in dsound.c'); continue; }
  const r = run(src.replace(a, b));
  check(!!r.error || CHECKS.some((k) => !r[k]), `red under: ${name}`, r.error ?? '');
}
const r = run(src);
if (r.error) check(false, 'dsound.c compiles', r.error);
else for (const k of CHECKS) check(!!r[k], k);
if (bad) { console.log(`\n${bad} failed`); process.exit(1); }
console.log(`\nall ${CHECKS.length + MUTATIONS.length} passed`);
