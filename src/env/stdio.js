// stdio.js — files, for every program rather than for one.
//
// PRISM already had `fopen`/`fread` inside MAME's platform shim, which was the wrong home for them
// twice over: they are ISO C, not MAME's, and Quake needs the other two thirds of the interface —
// seeking, character reads, writes that persist, and `fscanf`. So the file layer lives here and every
// program gets it.
//
// Files come from an injected map of name -> bytes, exactly as ROMs do: nothing is fetched, and a
// program sees only what the host was handed. A file opened for writing lives in memory for the rest
// of the session, so a game can save its configuration and read it back without anything reaching a
// real disk.
//
// There is a small descriptor layer too — `open`/`read`/`write`/`close` — but only because Quake's
// Con_DebugLog uses it, and it rides on the same store so a file written one way reads back the
// other. No `mmap`, no `stat`, no directories: the rule stands, implement what the program actually
// references, ranked by frequency, never by anticipation.

const SEEK_SET = 0, SEEK_CUR = 1, SEEK_END = 2;

// Sentinel handles for the three standard streams, and the base for real files. High enough that a
// FILE* can never be confused with a data pointer in the guest's image.
const STDIN = 0x7000_0001, STDOUT = 0x7000_0002, STDERR = 0x7000_0003;
const FIRST = 0x7100_0000;

export function installStdio(M, { files = {}, readChar = () => -1 } = {}) {
  const u8 = () => M.u8;
  const enc = new TextEncoder();

  // name (lower-cased, forward slashes) -> Uint8Array. The store outlives any open handle, which is
  // what makes "write a file, close it, open it again" work.
  const store = new Map();
  for (const [name, bytes] of Object.entries(files)) {
    store.set(norm(name), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  function norm(name) { return String(name).replace(/\\/g, '/').toLowerCase(); }

  /**
   * DOS matched file names case-insensitively and both games rely on it: MAME's ladybug driver asks
   * for `lb1.cpu` while its own readme says `LB1.CPU`, and Quake's pak files mix cases freely. An
   * exact match wins; a basename match is the fallback, so `pacman/pacman.6e` finds a file supplied
   * as `pacman.6e`.
   */
  function find(name) {
    const want = norm(name);
    if (store.has(want)) return want;
    const base = want.replace(/^.*\//, '');
    for (const k of store.keys()) if (k === base || k.replace(/^.*\//, '') === base) return k;
    return null;
  }

  const handles = new Map();
  let next = FIRST;

  const fileOf = (fp) => handles.get(fp | 0) ?? null;

  const api = {
    fopen: (namePtr, modePtr) => {
      const name = M.mod.cstr(namePtr);
      const mode = M.mod.cstr(modePtr);
      const writing = /[wa+]/.test(mode);
      const key = find(name);

      if (!writing) {
        if (key === null) return 0;                       // NULL: not found, which programs check
        handles.set(next, { key, bytes: store.get(key), pos: 0, write: false, eof: false });
        return next++;
      }
      // "w" truncates, "a" appends, "r+" keeps.
      const existing = key !== null ? store.get(key) : null;
      const start = /^a/.test(mode) && existing ? existing : new Uint8Array(0);
      const k = key ?? norm(name);
      store.set(k, start);
      handles.set(next, { key: k, bytes: start, pos: start.length, write: true, eof: false });
      return next++;
    },

    fclose: (fp) => { handles.delete(fp | 0); return 0; },

    fread: (dst, size, count, fp) => {
      const h = fileOf(fp);
      if (!h) return 0;
      const want = (size | 0) * (count | 0);
      const got = Math.max(0, Math.min(want, h.bytes.length - h.pos));
      u8().set(h.bytes.subarray(h.pos, h.pos + got), dst);
      h.pos += got;
      if (got < want) h.eof = true;
      return size ? Math.floor(got / size) : 0;
    },

    fwrite: (src, size, count, fp) => {
      const h = fileOf(fp);
      const n = (size | 0) * (count | 0);
      if (!h) {                                  // stdout/stderr, or a stream we never opened
        if ((fp | 0) === STDOUT || (fp | 0) === STDERR) {
          M.write(new TextDecoder().decode(u8().slice(src, src + n)));
        }
        return count | 0;
      }
      grow(h, h.pos + n);
      h.bytes.set(u8().slice(src, src + n), h.pos);
      h.pos += n;
      return count | 0;
    },

    fseek: (fp, off, whence) => {
      const h = fileOf(fp);
      if (!h) return -1;
      const base = whence === SEEK_CUR ? h.pos : whence === SEEK_END ? h.bytes.length : 0;
      const p = base + (off | 0);
      if (p < 0) return -1;
      h.pos = p; h.eof = false;
      return 0;
    },
    ftell: (fp) => { const h = fileOf(fp); return h ? h.pos : -1; },
    rewind: (fp) => { const h = fileOf(fp); if (h) { h.pos = 0; h.eof = false; } },

    fgetc: (fp) => readByte(fp),
    getc: (fp) => readByte(fp),
    ungetc: (c, fp) => { const h = fileOf(fp); if (h && h.pos > 0) { h.pos--; h.eof = false; } return c | 0; },

    fgets: (dst, n, fp) => {
      let i = 0;
      const limit = (n | 0) - 1;
      for (; i < limit; ) {
        const c = readByte(fp);
        if (c < 0) break;
        u8()[dst + i++] = c;
        if (c === 10) break;
      }
      if (i === 0) return 0;
      u8()[dst + i] = 0;
      return dst;
    },

    fputc: (c, fp) => { writeByte(fp, c & 0xff); return c & 0xff; },
    putc: (c, fp) => { writeByte(fp, c & 0xff); return c & 0xff; },
    fputs: (sPtr, fp) => {
      const bytes = enc.encode(M.mod.cstr(sPtr));
      for (const b of bytes) writeByte(fp, b);
      return bytes.length;
    },

    feof: (fp) => { const h = fileOf(fp); return h && h.eof ? 1 : 0; },
    ferror: () => 0,
    clearerr: (fp) => { const h = fileOf(fp); if (h) h.eof = false; },
    fflush: () => 0,                        // every write is already visible; nothing is buffered

    unlink: (namePtr) => { const k = find(M.mod.cstr(namePtr)); if (k) store.delete(k); return k ? 0 : -1; },
    remove: (namePtr) => api.unlink(namePtr),
    rename: (aPtr, bPtr) => {
      const k = find(M.mod.cstr(aPtr));
      if (!k) return -1;
      store.set(norm(M.mod.cstr(bPtr)), store.get(k));
      store.delete(k);
      return 0;
    },

    /** There is one errno value worth reporting honestly, and it is "no such file". */
    strerror: () => M.mod.intern([...enc.encode('No such file or directory'), 0]),

    /*
     * A small `fscanf`, covering what Quake asks of it: whitespace, `%d`, `%f`, `%s` and literal
     * characters. Quake reads its save games and its `.pts` point files with it. Anything else is
     * refused loudly rather than silently returning garbage — a scanf that quietly matches nothing
     * looks exactly like a corrupt file.
     */
    fscanf: (fp, fmtPtr, args) => scan(() => readByte(fp), (c) => api.ungetc(c, fp), fmtPtr, args ?? []),
    sscanf: (sPtr, fmtPtr, args) => {
      let p = sPtr | 0;
      return scan(() => { const c = u8()[p]; if (!c) return -1; p++; return c; }, () => { p--; }, fmtPtr, args ?? []);
    },
    scanf: (fmtPtr, args) => scan(readChar, () => {}, fmtPtr, args ?? []),
  };

  function grow(h, need) {
    if (h.bytes.length >= need) return;
    const bigger = new Uint8Array(Math.max(need, h.bytes.length * 2, 64));
    bigger.set(h.bytes);
    h.bytes = bigger.subarray(0, need);
    // The store must see the same object the handle grows into, or a re-open reads the old bytes.
    h.bytes = bigger.subarray(0, Math.max(need, h.pos));
    store.set(h.key, h.bytes);
  }

  function readByte(fp) {
    const f = fp | 0;
    if (f === STDIN) return readChar();
    const h = fileOf(fp);
    if (!h) return -1;
    if (h.pos >= h.bytes.length) { h.eof = true; return -1; }
    return h.bytes[h.pos++];
  }

  function writeByte(fp, b) {
    const f = fp | 0;
    if (f === STDOUT || f === STDERR || !fileOf(fp)) { M.write(String.fromCharCode(b)); return; }
    const h = fileOf(fp);
    grow(h, h.pos + 1);
    h.bytes[h.pos++] = b;
  }

  function scan(getc, ungetc, fmtPtr, args) {
    const fmt = M.mod.cstr(fmtPtr);
    const dv = M.mod.dv;
    let ai = 0, assigned = 0;

    const skipSpace = () => {
      for (;;) {
        const c = getc();
        if (c < 0) return -1;
        if (!/\s/.test(String.fromCharCode(c))) { ungetc(c); return c; }
      }
    };

    for (let i = 0; i < fmt.length; i++) {
      const f = fmt[i];
      if (/\s/.test(f)) { if (skipSpace() < 0) return assigned || -1; continue; }
      if (f !== '%') {
        const c = getc();
        if (c < 0) return assigned || -1;
        if (String.fromCharCode(c) !== f) { ungetc(c); return assigned; }
        continue;
      }
      i++;
      let suppress = false;
      if (fmt[i] === '*') { suppress = true; i++; }
      let width = '';
      while (/[0-9]/.test(fmt[i])) width += fmt[i++];
      while ('hlL'.includes(fmt[i])) i++;
      const conv = fmt[i];
      const max = width ? +width : Infinity;

      if (skipSpace() < 0) return assigned || -1;
      let tok = '';
      if (conv === 's') {
        for (;;) {
          const c = getc();
          if (c < 0) break;
          if (/\s/.test(String.fromCharCode(c))) { ungetc(c); break; }
          tok += String.fromCharCode(c);
          if (tok.length >= max) break;
        }
      } else if ('dioux'.includes(conv) || 'efg'.includes(conv)) {
        const numeric = 'efg'.includes(conv) ? /[-+0-9.eE]/ : /[-+0-9a-fA-FxX]/;
        for (;;) {
          const c = getc();
          if (c < 0) break;
          const ch = String.fromCharCode(c);
          if (!numeric.test(ch)) { ungetc(c); break; }
          tok += ch;
          if (tok.length >= max) break;
        }
      } else {
        throw new Error(`scanf: %${conv} is not supported`);
      }
      if (!tok.length) return assigned;
      if (suppress) continue;

      const dst = args[ai++] | 0;
      if (conv === 's') {
        const bytes = enc.encode(tok);
        u8().set(bytes, dst); u8()[dst + bytes.length] = 0;
      } else if ('efg'.includes(conv)) {
        dv.setFloat32(dst, Math.fround(parseFloat(tok)), true);
      } else {
        dv.setInt32(dst, parseInt(tok, conv === 'x' ? 16 : conv === 'o' ? 8 : 10) | 0, true);
      }
      assigned++;
    }
    return assigned;
  }

  /*
   * A descriptor layer over the same store, because Quake's Con_DebugLog opens a log file with
   * POSIX `open`/`write`/`close` while everything else in the program uses stdio. Sharing the store
   * is the point: a file written one way is readable the other way.
   */
  const O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200, O_APPEND = 0x400;
  api.open = (namePtr, flags) => {
    const name = M.mod.cstr(namePtr);
    const f = flags | 0;
    const mode = (f & O_APPEND) ? 'ab' : (f & (O_WRONLY | O_CREAT | O_TRUNC)) ? 'wb' : 'rb';
    const fp = api.fopen(namePtr, M.mod.intern([...enc.encode(mode), 0]));
    return fp ? fp : -1;                       // a descriptor IS a FILE* here; nothing else looks
  };
  api.close = (fd) => api.fclose(fd);
  api.write = (fd, src, n) => { api.fwrite(src, 1, n, fd); return n | 0; };
  api.read = (fd, dst, n) => api.fread(dst, 1, n, fd);

  Object.assign(M.rt, api);
  M.files = { store, find, norm };

  // The three standard streams are ordinary globals a program can take the address of.
  for (const [name, value] of [['stdin', STDIN], ['stdout', STDOUT], ['stderr', STDERR]]) {
    const sym = M.mod.symbols.get(name);
    if (sym) M.mod.dv.setInt32(sym.addr, value, true);
  }

  return M.files;
}

export const STREAMS = { STDIN, STDOUT, STDERR };
