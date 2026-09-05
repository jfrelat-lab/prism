// putty-session.mjs — PuTTY against a real TCP server, and a picture of what it drew.
//
//   node tools/putty-testserver.mjs &        # prints a port
//   node tools/putty-session.mjs <port>
//
// The server is tools/putty-testserver.mjs: it greets and echoes printable input in upper case, and
// it runs in ANOTHER PROCESS because this one blocks inside program.run. Nothing here talks to the
// outside world; the whole exchange is between two local processes.
//
// It prints a timestamped trace of every winsock call PuTTY makes, an ink map of the terminal, and
// /tmp/puttytel.png. The trace is the point: the five defects that stood between "connects" and
// "shows text" were each visible in it and in nothing else.

import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadTarget, buildTarget } from '../src/target.js';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const port = process.argv[2];
const { program } = buildTarget(loadTarget(join(ROOT, 'targets/putty.json'), 'tel'), { root: ROOT });
const M = program.M, dv = program.mod.dv;
const sym = (n) => program.mod.symbols.get(n)?.addr ?? 0;
const i32 = (n) => (sym(n) ? dv.getInt32(sym(n), true) : 0);

/* Stop once the terminal has drawn something, or after a while. */
const deadline = Date.now() + 3000;
let painted = 0;
for (const n of ['MsgWaitForMultipleObjects']) {
  const f = program.F[n];
  if (!f) { console.log(`  (no ${n})`); continue; }
  const g = function (...a) {
    if (Date.now() > deadline) throw new Error('__done');
    const r = f.apply(this, a);
    painted = i32('prism_gdi_draws');
    return r;
  };
  program.F[n] = g; program.mod.bindFunc(n, g);
}
const boxes = [];
const cstr = (a) => { let s = ''; for (let i = 0; a && i < 256; i++) { const c = M.u8[a + i]; if (!c) break; s += String.fromCharCode(c); } return s; };
for (const n of ['MessageBox', 'MessageBoxA']) {
  const f = program.F[n];
  if (!f) continue;
  const g = function (h, t) { boxes.push(cstr(t).replace(/\n/g, ' / ')); return 1; };
  program.F[n] = g; program.mod.bindFunc(n, g);
}

/* Which winsock call does PuTTY make, and what does each answer? */
for (const n of ['socket', 'connect', 'bind', 'listen', 'setsockopt', 'ioctlsocket', 'getsockname',
                 'getpeername', 'WSAAsyncSelect', 'WSAEventSelect', 'getaddrinfo', 'gethostbyname',
                 'recv', 'send', 'closesocket', 'select', 'WSAEnumNetworkEvents']) {
  const f = program.F[n];
  if (!f) continue;
  const g = function (...a) { const r = f.apply(this, a); log(`${n} -> ${r}`); return r; };
  program.F[n] = g; program.mod.bindFunc(n, g);
}

for (const n of ['term_size', 'term_init', 'conf_get_int', 'do_defaults', 'load_open_settings']) {
  const f = program.F[n];
  if (!f) { console.log(`    (no ${n})`); continue; }
  const g = function (...a) {
    const r = f.apply(this, a);
    if (n === 'term_size') console.log(`    term_size(rows=${a[1]}, cols=${a[2]}, save=${a[3]})`);
    if (n === 'do_defaults' || n === 'load_open_settings') console.log(`    ${n}`);
    return r;
  };
  program.F[n] = g; program.mod.bindFunc(n, g);
}

const t0 = Date.now();
const log = (m) => console.log(`  +${String(Date.now() - t0).padStart(5)}ms ${m}`);
for (const n of ['plug_closing_system_error', 'plug_closing_error', 'plug_closing_normal',
                 'plug_closing', 'sk_tcp_close', 'net_select_result', 'try_connect',
                 'close_session', 'connection_fatal', 'winselgui_response', 'select_result',
                 'sk_close', 'telnet_closing', 'backend_free', 'term_free', 'queue_toplevel_callback',
                 'run_toplevel_callbacks', 'prism_net_pump']) {
  const f = program.F[n];
  if (!f) continue;
  const NAME = { 1: 'FD_READ', 2: 'FD_WRITE', 4: 'FD_OOB', 8: 'FD_ACCEPT', 16: 'FD_CONNECT', 32: 'FD_CLOSE' };
  const g = function (...a) {
    if (n === 'winselgui_response') log(`netevent(sock=${a[0]}, ${NAME[a[1] & 0xffff] ?? (a[1] & 0xffff)}, err=${(a[1] >>> 16) & 0xffff})`);
    else if (n !== 'prism_net_pump') log(n);
    return f.apply(this, a);
  };
  program.F[n] = g; program.mod.bindFunc(n, g);
}

{
  const f = program.F.closesocket;
  const g = function (...a) {
    const st = new Error().stack.split('\n').slice(1, 12)
      .map(l => l.trim().replace(/^at /, '').replace(/ \(.*/, ''))
      .filter(n => !/^Object\.|^g$|^Module|^async|node:/.test(n));
    console.log(`  who closes: ${st.slice(0, 8).join(' <- ')}`);
    return f.apply(this, a);
  };
  program.F.closesocket = g; program.mod.bindFunc('closesocket', g);
}

const conv = [];
for (const n of ['MultiByteToWideChar', 'decode_codepage', 'init_ucs', 'GetACP', 'GetCPInfo']) {
  const f = program.F[n];
  if (!f) { conv.push(`(no ${n})`); continue; }
  const g = function (...a) {
    const r = f.apply(this, a);
    if (conv.length < 10) conv.push(n === 'MultiByteToWideChar' ? `MB2WC(cp=${a[0]},n=${a[3]})->${r}` : `${n}->${r}`);
    return r;
  };
  program.F[n] = g; program.mod.bindFunc(n, g);
}
process.on('exit', () => console.log(`  conversion: ${conv.join(' ')}`));

const colours = [];
for (const n of ['SetBkColor', 'SetTextColor', 'FillRect', 'Rectangle']) {
  const f = program.F[n];
  if (!f) continue;
  const g = function (...a) {
    if (colours.length < 12) colours.push(`${n}(${(a[1] >>> 0).toString(16)})`);
    return f.apply(this, a);
  };
  program.F[n] = g; program.mod.bindFunc(n, g);
}
process.on('exit', () => console.log(`  colours: ${colours.join(' ')}`));

let text = [];
{
  const f = program.F.ExtTextOutW;
  const g = function (dc, x, y, o, r, sPtr, n, dx) {
    let t = '';
    for (let i = 0; i < n && i < 80; i++) { const c = dv.getUint16(sPtr + i * 2, true); t += (c >= 32 && c < 127) ? String.fromCharCode(c) : '\\u' + c.toString(16); }
    if (n > 20 && text.length < 4) text.push(`(${x},${y}) n=${n} first=0x${dv.getUint16(sPtr, true).toString(16)} ${JSON.stringify(t.slice(0, 30))}`);
    else if (t.trim() && text.length < 8) text.push(`(${x},${y}) ${JSON.stringify(t)}`);
    return f.call(this, dc, x, y, o, r, sPtr, n, dx);
  };
  program.F.ExtTextOutW = g; program.mod.bindFunc('ExtTextOutW', g);
}
for (const n of ['term_update', 'term_data', 'do_paint']) {
  const f = program.F[n];
  if (!f) { console.log(`  (no ${n})`); continue; }
  let c = 0;
  const g = function (...a) { c++; return f.apply(this, a); };
  program.F[n] = g; program.mod.bindFunc(n, g);
  process.on('exit', () => console.log(`  ${n} called ${c} times`));
}
process.on('exit', () => console.log(`  text drawn: ${text.slice(0, 6).join(' | ') || '(none)'}`));

let pumps = 0, evs = [];
{
  const f = program.F.prism_net_pump;
  if (!f) console.log('    (prism_net_pump is not a function)');
  else { const g = function (...a) { pumps++; return f.apply(this, a); };
         program.F.prism_net_pump = g; program.mod.bindFunc('prism_net_pump', g); }
}
{
  const f = program.F.prism_net_events;
  if (f) { const g = function (...a) { const r = f.apply(this, a); if (r) evs.push(r); return r; };
           program.F.prism_net_events = g; program.mod.bindFunc('prism_net_events', g); }
  else console.log('    (prism_net_events not interceptable)');
}
process.on('exit', () => console.log(`pumps=${pumps} events seen=${evs.join(',')} present=${i32('prism_net_present')}`));

let err = null;
try { program.run(['puttytel', '-raw', 'localhost', port]); }
catch (e) { if (e.message !== '__done') err = e; }

console.log(`glyph cells drawn: ${i32('prism_gdi_draws')}`);
if (boxes.length) console.log(`message boxes: ${boxes.join(' | ')}`);
if (err) console.log(`stopped by: ${err.message}`);

const at = i32('prism_gdi_surface'), w = i32('prism_gdi_w'), h = i32('prism_gdi_h'), pitch = i32('prism_gdi_pitch');
console.log(`surface ${w}x${h}`);
if (at) {
  const CW = 8, CH = 16;
  const lines = [];
  for (let row = 0; row * CH + CH <= h && row < 8; row++) {
    let line = '';
    for (let col = 0; col * CW + CW <= w && col < 60; col++) {
      let on = 0;
      for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
        const p = at + (row * CH + y) * pitch + (col * CW + x) * 4;
        if (M.u8[p] || M.u8[p + 1] || M.u8[p + 2]) on++;
      }
      line += on === 0 ? ' ' : on > 60 ? '#' : on > 20 ? '+' : '.';
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  console.log(`ink map:\n${lines.join('\n')}`);
  const px = (x, y) => { const o = at + y * pitch + x * 4; return `${M.u8[o]},${M.u8[o+1]},${M.u8[o+2]}`; };
  console.log(`pixels: (2,2)=${px(2,2)} (2,40)=${px(2,40)} (300,200)=${px(300,200)} (640,384)=${px(640,384)}`);
}
/* A picture, so the terminal can be looked at rather than described. */
if (at) {
  const { deflateSync } = await import('node:zlib');
  const { writeFileSync } = await import('node:fs');
  const H = Math.min(h, 96);
  const raw = Buffer.alloc((w * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = M.u8[at + y * pitch + x];
  }
  const tbl = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = tbl[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync('/tmp/puttytel.png', Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log('wrote /tmp/puttytel.png');
}

process.exit(0);
