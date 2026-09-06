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

import { format, vaReader, bytesOf } from '../runtime/runtime.js';

const SEEK_SET = 0, SEEK_CUR = 1, SEEK_END = 2;

// Sentinel handles for the three standard streams, and the base for real files. High enough that a
// FILE* can never be confused with a data pointer in the guest's image.
const STDIN = 0x7000_0001, STDOUT = 0x7000_0002, STDERR = 0x7000_0003;
const FIRST = 0x7100_0000;

export function installStdio(M, {
  files = {}, readChar = () => -1, env = {},
  /*
   * Whether a byte is waiting on stdin, for `select`. A program that POLLS its input needs to ask
   * that question without consuming an answer -- Doom's sound server does exactly this, a
   * zero-timeout select on fd 0, and it is what makes its loop cooperative instead of blocking.
   * Unanswerable by default: with no way to peek, "nothing is waiting" is the truthful reply.
   */
  stdinPending = () => false,
} = {}) {
  const u8 = () => M.u8;
  const enc = new TextEncoder();

  // name (lower-cased, forward slashes) -> Uint8Array. The store outlives any open handle, which is
  // what makes "write a file, close it, open it again" work.
  const store = new Map();
  for (const [name, bytes] of Object.entries(files)) {
    store.set(norm(name), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  /*
   * A path's identity, not its spelling. Backslashes become slashes, case is dropped -- and a
   * leading `./` is removed, because it is not part of the name: Quake II opens `./baseq2/pak0.pak`
   * and a store keyed `baseq2/pak0.pak` must recognise it, or the exact match is missed and the
   * basename fallback below answers with whatever else is called pak0.pak.
   */
  function norm(name) {
    let p = String(name).replace(/\\/g, '/').toLowerCase();
    while (p.startsWith('./')) p = p.slice(2);
    return p.replace(/\/\.\//g, '/');
  }

  // Open directories. The base keeps a DIR handle clear of a file descriptor's range.
  // Installed signal actions, remembered because a caller reads back what it stored.
  const signals = new Map();

  const dirs = [];
  const DIR_BASE = 0x7000;

  /**
   * DOS matched file names case-insensitively and both games rely on it: MAME's ladybug driver asks
   * for `lb1.cpu` while its own readme says `LB1.CPU`, and Quake's pak files mix cases freely. An
   * exact match wins; a basename match is the fallback, so `pacman/pacman.6e` finds a file supplied
   * as `pacman.6e`.
   */
  function find(name) {
    const want = norm(name);
    if (store.has(want)) return want;
    // A key that ends with the whole requested path: a store keyed one directory deeper still
    // identifies the file, and the directory is what tells two files of the same name apart.
    for (const k of store.keys()) if (k.endsWith(`/${want}`)) return k;
    const base = want.replace(/^.*\//, '');
    /*
     * The BASENAME fallback, and only when it is UNAMBIGUOUS. `pacman/pacman.6e` finding a file
     * supplied as `pacman.6e` is what a person who unzipped one ROM set expects; `./baseq2/pak0.pak`
     * finding Quake ONE's `ID1/PAK0.PAK` because both end in pak0.pak is not, and that is what
     * happened the moment the page was given several games' data at once -- Quake II loaded a pack
     * of 339 files instead of 1106 and died on a texture.
     */
    let hit = null;
    for (const k of store.keys()) {
      if (k !== base && k.replace(/^.*\//, '') !== base) continue;
      if (hit) return null;                     // two files answer to this name; neither is meant
      hit = k;
    }
    return hit;
  }

  // PATH is here because Lua's files.lua opens with `assert(type(os.getenv"PATH") == "string")`:
  // a POSIX program may reasonably assume it exists, and an absent one is a stranger answer than a
  // short one.
  const environment = { HOME: '/', USER: 'prism', TMPDIR: '/', PATH: '/bin:/usr/bin', ...env };
  const interned = new Map();

  const handles = new Map();
  let next = FIRST;

  const fileOf = (fp) => handles.get(fp | 0) ?? null;
  let tmpSeq = 0;

  /*
   * DIRECTORIES EXIST, even in a flat store.
   *
   * `fopen(name, "w")` used to succeed for any name at all, which is not what a filesystem does:
   * `io.open('/a/b/c/d', 'w')` must fail, and Lua's files.lua asserts exactly that on line 46. A
   * store with no notion of directories cannot answer, so it gets one -- the set of directories that
   * hold a file, plus the ones a program made.
   *
   * Reading is unaffected: a read of a missing file already failed, whatever its path.
   */
  const dirsOf = (key) => {
    const out = [];
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/') || '/');
    return out;
  };
  const directories = new Set(['', '/', '.', '/tmp']);
  for (const k of store.keys()) for (const d of dirsOf(k)) directories.add(d);
  const dirExists = (key) => {
    const i = key.lastIndexOf('/');
    if (i < 0) return true;                          // no directory component at all
    return directories.has(key.slice(0, i) || '/');
  };
  /*
   * freopen's whole point: a standard stream that now goes somewhere else. Keyed by the SENTINEL,
   * because `stdout` is not a handle in the store -- it is a token every writer checks for.
   */
  const redirected = new Map();

  const api = {
    /*
     * The four modes, each doing what it says. The comment here used to describe them correctly and
     * the code did not: "r+" took the create-and-truncate path, so opening a file for UPDATE emptied
     * it. Lua's files.lua:628 reads back what it wrote through an "r+" handle.
     *
     *   r   must exist. read only.  position 0, content kept.
     *   r+  must exist. read+write. position 0, content kept.
     *   w   created.    write only. truncated.
     *   w+  created.    read+write. truncated.
     *   a   created.    write only. content kept, writes go to the end.
     *   a+  created.    read+write. content kept, writes go to the end.
     */
    fopen: (namePtr, modePtr) => {
      const name = M.mod.cstr(namePtr);
      const mode = M.mod.cstr(modePtr);
      const key = find(name);
      const update = mode.includes('+');
      const kind = mode[0];
      const readable = kind === 'r' || update;
      const writable = kind !== 'r' || update;

      if (kind === 'r') {
        if (key === null) return 0;                     // NULL: not found, which programs check
        handles.set(next, { key, bytes: store.get(key), pos: 0,
                            read: true, write: update, eof: false });
        return next++;
      }
      // A new file can only be created in a directory that exists.
      if (key === null && !dirExists(norm(name))) return 0;
      const existing = key !== null ? store.get(key) : null;
      const start = kind === 'a' && existing ? existing : new Uint8Array(0);
      const k = key ?? norm(name);
      store.set(k, start);
      handles.set(next, { key: k, bytes: start, pos: kind === 'a' ? start.length : 0,
                          read: readable, write: writable, append: kind === 'a', eof: false });
      return next++;
    },

    fclose: (fp) => {
      const f = fp | 0;
      /* Closing a redirected standard stream puts it back where it belongs. */
      if (redirected.has(f)) { handles.delete(redirected.get(f)); redirected.delete(f); return 0; }
      handles.delete(f);
      return 0;
    },

    /*
     * freopen: reopen a STREAM on a new file. For an ordinary FILE* that is a close followed by an
     * open reusing the same token; for stdout or stderr it is the only way a program can send its
     * printf output to a file, which is what gcc's printf-2.c and user-printf.c do to check that
     * printf was not optimised away.
     */
    freopen: (namePtr, modePtr, fp) => {
      const f = fp | 0;
      const fresh = api.fopen(namePtr, modePtr);
      if (!fresh) return 0;
      if (f === STDOUT || f === STDERR || f === STDIN) {
        if (redirected.has(f)) handles.delete(redirected.get(f));
        redirected.set(f, fresh);
        return f;                          /* the STREAM comes back, not a new one */
      }
      handles.delete(f);
      handles.set(f, handles.get(fresh));
      handles.delete(fresh);
      return f;
    },

    fread: (dst, size, count, fp) => {
      const h = fileOf(fp);
      if (!h) return 0;
      if (!h.read) { h.err = true; return 0; }
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
      /*
       * A STREAM OPENED FOR READING REFUSES TO BE WRITTEN. Obvious, and it was not checked anywhere:
       * a write to an "r" handle simply appended. Lua's files.lua:299 does `io.input():write("xuxu")`
       * and asserts it fails with a message and an errno, which is the whole point of the test.
       */
      if (!h.write) { h.err = true; return 0; }
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
    /*
     * C 7.19.7.11: pushing back EOF FAILS, and the stream is unchanged -- the end-of-file indicator
     * included. Accepting it stepped the position back a byte and cleared the flag, so a program
     * that reads to the end, gets EOF and dutifully pushes it back re-read the last character. Lua's
     * files.lua does exactly that (test_eof does getc then ungetc unconditionally) and its
     * `f:read(0)` at end of file then answered "not at the end".
     */
    ungetc: (c, fp) => {
      if ((c | 0) === -1) return -1;
      const h = fileOf(fp);
      if (!h || h.pos <= 0) return -1;
      h.pos--;
      h.eof = false;                 // a SUCCESSFUL push-back clears it, and only that
      return c & 0xff;
    },

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

    /*
     * fprintf and vfprintf BELONG here, not in the runtime: they take a FILE*, and this is the layer
     * that knows what one is. The runtime's pair discarded the stream and wrote to the console, so
     * `fprintf(fp, ...)` never reached a file and `fprintf(pipe, ...)` never reached a pipe -- which
     * is how Doom's sound commands ended up printed on stdout while the sound server, correctly
     * mixing whatever it was sent, produced silence.
     *
     * Byte at a time, through writeByte, so the sink lookup and the STDOUT/STDERR cases stay in one
     * place rather than being re-decided here.
     */
    fprintf: (fp, fmtPtr, args) => putBytes(fp, format(M, fmtPtr, args ?? [])),
    vfprintf: (fp, fmtPtr, ap) => putBytes(fp, format(M, fmtPtr, vaReader(M, ap))),

    fputc: (c, fp) => { writeByte(fp, c & 0xff); return c & 0xff; },
    putc: (c, fp) => { writeByte(fp, c & 0xff); return c & 0xff; },
    /*
     * printf, puts and putchar write to the STREAM stdout, not to the host's console.
     *
     * runtime.js sends all three straight to M.write, which is right until something redirects
     * stdout -- and freopen is exactly that. It is the same shape as the fprintf that ignored its
     * stream: a writer that knows where the bytes go instead of asking. Routing them through
     * writeByte costs nothing and means one place decides.
     */
    printf: (fmtPtr, args) => putBytes(STDOUT, format(M, fmtPtr, args ?? [])),
    vprintf: (fmtPtr, ap) => putBytes(STDOUT, format(M, fmtPtr, vaReader(M, ap))),
    puts: (sPtr) => { putBytes(STDOUT, M.mod.cstr(sPtr)); writeByte(STDOUT, 10); return 1; },
    putchar: (c) => { writeByte(STDOUT, c & 0xff); return c & 0xff; },

    fputs: (sPtr, fp) => {
      const bytes = enc.encode(M.mod.cstr(sPtr));
      for (const b of bytes) writeByte(fp, b);
      return bytes.length;
    },

    feof: (fp) => { const h = fileOf(fp); return h && h.eof ? 1 : 0; },
    ferror: (fp) => { const h = fileOf(fp); return h && h.err ? 1 : 0; },
    clearerr: (fp) => { const h = fileOf(fp); if (h) { h.eof = false; h.err = false; } },
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
    if (!h.read) { h.err = true; return -1; }      // a write-only stream is not readable
    if (h.pos >= h.bytes.length) { h.eof = true; return -1; }
    return h.bytes[h.pos++];
  }

  /** A formatted string to a stream, as bytes -- a C string is bytes, so the count is of those. */
  function putBytes(fp, str) {
    const bytes = bytesOf(str);
    for (const b of bytes) writeByte(fp, b);
    return bytes.length;
  }

  function writeByte(fp, b) {
    const f = fp | 0;
    /*
     * A SINK is a FILE* that is not a file: today that means the write end of a pipe to another
     * PRISM program (src/env/popen.js). It is checked first because a sink's token is deliberately
     * outside the file store, so `fileOf` would miss it and the bytes would go to stdout -- which is
     * precisely what Doom's sound commands did before this existed.
     */
    const sink = M.streamSinks?.get(f);
    if (sink) { sink(b); return; }
    const via = redirected.get(f);         // freopen sent this stream somewhere else
    if (via === undefined && (f === STDOUT || f === STDERR || !fileOf(fp))) {
      M.write(String.fromCharCode(b));
      return;
    }
    const h = fileOf(via ?? fp);
    if (!h) { M.write(String.fromCharCode(b)); return; }
    if (!h.write) { h.err = true; return; }        // see fwrite: an "r" stream is not writable
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

      /*
       * `%[...]` -- a SCANSET. The delimiters are part of the conversion, so the format cursor has
       * to move past them here rather than in the loop's `i++`.
       *
       * Three rules that are easy to get wrong and all of which real formats use: a leading `^`
       * negates, a `]` in the FIRST position is a literal `]` rather than the end, and `a-z` is a
       * range unless the `-` is first or last. Hexen's SC_MAN.C reads its scripts with these.
       */
      let scanset = null;
      if (conv === '[') {
        let j = i + 1;
        const negate = fmt[j] === '^';
        if (negate) j++;
        let body = '';
        if (fmt[j] === ']') { body += ']'; j++; }        // a leading ] is a literal
        while (j < fmt.length && fmt[j] !== ']') body += fmt[j++];
        i = j;                                          // the loop's i++ steps past the ]
        const set = new Set();
        for (let k = 0; k < body.length; k++) {
          if (body[k] === '-' && k > 0 && k < body.length - 1) {
            for (let c = body.charCodeAt(k - 1) + 1; c <= body.charCodeAt(k + 1); c++) {
              set.add(String.fromCharCode(c));
            }
            k++;
          } else set.add(body[k]);
        }
        scanset = { negate, set };
      }

      const max = width ? +width : (conv === 'c' ? 1 : Infinity);

      /*
       * `%c` and `%[` do NOT skip leading whitespace -- they are the two conversions that can match
       * it. Skipping first made `%c` read the character after a space and `%[^\n]` read an empty
       * string at the start of every line.
       */
      if (conv !== 'c' && conv !== '[') {
        if (skipSpace() < 0) return assigned || -1;
      }
      let tok = '';
      if (conv === 'c') {
        for (let k = 0; k < max; k++) {
          const c = getc();
          if (c < 0) break;
          tok += String.fromCharCode(c);
        }
        /*
         * Nothing at all is end of input. A SHORT read is not a failure: C99 calls it a matching
         * failure, but glibc assigns what it got and glibc is the reference here -- `sscanf("abc",
         * "%2s%2c", a, c)` returns 2 with one character in c, and PRISM returned 1 until this was
         * checked against gcc rather than against the standard.
         */
        if (!tok.length) return assigned || -1;
      } else if (scanset) {
        for (;;) {
          const c = getc();
          if (c < 0) break;
          const ch = String.fromCharCode(c);
          if (scanset.set.has(ch) === scanset.negate) { ungetc(c); break; }
          tok += ch;
          if (tok.length >= max) break;
        }
      } else if (conv === 's') {
        for (;;) {
          const c = getc();
          if (c < 0) break;
          if (/\s/.test(String.fromCharCode(c))) { ungetc(c); break; }
          tok += String.fromCharCode(c);
          if (tok.length >= max) break;
        }
      } else if ('diouxX'.includes(conv) || 'efgEG'.includes(conv)) {
        /*
         * The characters each conversion may consume, per conversion rather than one set for all.
         * A single permissive set let `%d` swallow hex digits, so `sscanf("abc123def", "%[^0-9]%d%[a-z]")`
         * read "123def" as its integer and the third conversion found nothing left to match.
         */
        const numeric =
          'efgEG'.includes(conv) ? /[-+0-9.eE]/ :
          'xX'.includes(conv) ? /[-+0-9a-fA-FxX]/ :
          conv === 'o' ? /[-+0-7]/ :
          conv === 'i' ? /[-+0-9a-fA-FxX]/ :          // %i takes a 0x prefix, so it needs the hex set
          /[-+0-9]/;
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
      if (conv === 'c') {
        // Exactly the bytes read, and NO terminator: %c fills a char array, not a string.
        u8().set(enc.encode(tok), dst);
      } else if (conv === 's' || scanset) {
        const bytes = enc.encode(tok);
        u8().set(bytes, dst); u8()[dst + bytes.length] = 0;
      } else if ('efg'.includes(conv)) {
        dv.setFloat32(dst, Math.fround(parseFloat(tok)), true);
      } else {
        const radix = 'xX'.includes(conv) ? 16 : conv === 'o' ? 8 : conv === 'i' ? 0 : 10;
        dv.setInt32(dst, (radix === 0 ? Number(tok) : parseInt(tok, radix)) | 0, true);
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
  // getche is getchar that echoes; getwd is getcwd without the size that made it safe.
  api.getche = () => { const c = readChar(); if (c >= 0) M.write(String.fromCharCode(c)); return c; };
  api.getwd = (buf) => api.getcwd(buf, 4096);

  api.close = (fd) => api.fclose(fd);
  api.write = (fd, src, n) => { api.fwrite(src, 1, n, fd); return n | 0; };
  // fd 0 is stdin. It is a distinct number from the FILE* stdin above, and a program that mixes the
  // two -- soundsrv.c reads fd 0 while printing through stderr -- must find both working.
  api.read = (fd, dst, n) => {
    if ((fd | 0) === 0) {
      let i = 0;
      for (; i < (n | 0); i++) {
        const c = readChar();
        if (c < 0) break;
        M.u8[dst + i] = c & 0xff;
      }
      return i;
    }
    return api.fread(dst, 1, n, fd);
  };

  /*
   * select(), for fd 0 only, and never blocking.
   *
   * The timeout is ignored rather than honoured, and that is a real limitation with a real
   * justification: there is one thread inside the guest, so a wait here would be a deadlock, not a
   * wait. Every caller so far passes a ZERO timeout — it is a poll, and a poll is answerable.
   */
  api.select = (_n, rd, _wr, _ex, _tv) => {
    if (!rd) return 0;
    const ready = stdinPending() ? 1 : 0;
    const dv = M.mod.dv;
    if (!ready) { dv.setUint32(rd, 0, true); return 0; }
    dv.setUint32(rd, 1, true);                       // fd 0 is bit 0 of the first word
    return 1;
  };

  /*
   * The POSIX layer, taken from SQLite's own syscall table rather than from imagination — its unix
   * VFS lists every call it makes so it can swap them out under test, which makes it the best
   * possible specification of what a host must provide. Doom's i_system.c wants a subset of the same.
   *
   * Everything rides on the one store, so a file written through stdio is visible through a
   * descriptor and back.
   */
  const O_CREAT_F = 0x40, O_TRUNC_F = 0x200, O_APPEND_F = 0x400, O_WRONLY_F = 1, O_RDWR_F = 2;

  // struct stat, as declared in PRISM's own sys/stat.h: fourteen 4-byte fields. These offsets and
  // that header are one thing in two places; changing either without the other is a silent bug.
  const ST_MODE = 8, ST_SIZE = 28, ST_BLKSIZE = 32, ST_BLOCKS = 36, ST_SIZE_BYTES = 56;
  const S_IFREG = 0o100000;

  function fillStat(st, bytes) {
    M.u8.fill(0, st, st + ST_SIZE_BYTES);
    const dv = M.mod.dv;
    dv.setUint32(st + ST_MODE, S_IFREG | 0o644, true);
    dv.setInt32(st + ST_SIZE, bytes ? bytes.length : 0, true);
    dv.setInt32(st + ST_BLKSIZE, 4096, true);
    dv.setInt32(st + ST_BLOCKS, bytes ? Math.ceil(bytes.length / 512) : 0, true);
    return 0;
  }

  Object.assign(api, {
    access: (namePtr) => (find(M.mod.cstr(namePtr)) === null ? -1 : 0),
    getcwd: (buf, size) => {
      if ((size | 0) < 2) return 0;
      M.u8[buf] = 47; M.u8[buf + 1] = 0;             // "/"
      return buf;
    },
    stat: (namePtr, st) => {
      const k = find(M.mod.cstr(namePtr));
      return k === null ? -1 : fillStat(st, store.get(k));
    },
    lstat: (namePtr, st) => api.stat(namePtr, st),
    fstat: (fd, st) => { const h = fileOf(fd); return h ? fillStat(st, h.bytes) : -1; },

    ftruncate: (fd, len) => {
      const h = fileOf(fd);
      if (!h) return -1;
      const n = Math.max(0, len | 0);
      const out = new Uint8Array(n);
      out.set(h.bytes.subarray(0, Math.min(n, h.bytes.length)));
      h.bytes = out;
      store.set(h.key, out);
      if (h.pos > n) h.pos = n;
      return 0;
    },

    /*
     * Locking is a no-op and says so. There is exactly one process inside the guest, so every lock
     * succeeds — which is the truth here, not a shortcut: SQLite's locking exists to keep processes
     * apart, and there are none to keep apart.
     */
    fcntl: () => 0,
    fchmod: () => 0,
    fchown: () => 0,
    fallocate: () => 0,
    geteuid: () => 0,
    getuid: () => 0,
    getgid: () => 0,
    mkdir: (p) => { directories.add(norm(M.mod.cstr(p))); return 0; },
    // Watcom and MSVC spell it with the underscore, and OpenDUNE's File_MakeDirectory calls that
    // name under __WATCOMC__. Both succeed: directories here are derived from paths, so there is
    // nothing to create and nothing that can fail.
    _mkdir: (p) => { directories.add(norm(M.mod.cstr(p))); return 0; },
    _rmdir: () => 0,
    rmdir: () => 0,
    chdir: () => 0,
    readlink: () => -1,
    ioctl: () => -1,
    /*
     * SysV shared memory and UDP both FAIL, and say so through their ordinary error returns. Doom
     * falls back to a plain XImage when shmget fails, and single-player never opens a socket. A
     * refusal a program already knows how to handle beats a fake that works differently.
     */
    shmget: () => -1,
    shmat: () => -1,
    shmdt: () => -1,
    shmctl: () => -1,
    socket: () => -1,
    bind: () => -1,
    sendto: () => -1,
    recvfrom: () => -1,
    setsockopt: () => 0,
    gethostbyname: () => 0,
    htons: (v) => ((v & 0xff) << 8 | (v >>> 8) & 0xff) & 0xffff,
    ntohs: (v) => ((v & 0xff) << 8 | (v >>> 8) & 0xff) & 0xffff,
    htonl: (v) => (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) | 0,
    ntohl: (v) => (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) | 0,
    inet_addr: () => 0,
    inet_ntoa: () => 0,
    signal: () => 0,
    raise: () => 0,
    setitimer: () => 0,
    getitimer: () => 0,
    getpagesize: () => 4096,
    isatty: () => 0,
    getpid: () => 1,
    mprotect: () => 0,

    /*
     * /etc/mtab, which Quake II walks looking for a mounted CD-ROM. There are no mounts here, so the
     * table opens as empty and the search finds nothing -- the same outcome as a machine with no CD
     * in the drive, which the program already handles.
     */
    /*
     * Four that this host genuinely cannot provide, answering the way a C library answers when it
     * cannot either -- NULL, or a failure code. Lua checks every one of them, so a lie would be
     * found: io.tmpfile() returning a bad handle would crash inside the test suite rather than
     * report "cannot open".
     */
    tmpfile: () => 0,
    /*
     * A NAME, not NULL. C says tmpnam returns null only when it cannot make a unique name, and a
     * caller is entitled to use the result immediately -- gcc's gcc_tmpnam.h reads ret[0] on the
     * next line, so NULL was a crash rather than a graceful refusal. The file system these names
     * land in is the in-memory one above, which is exactly what a temporary file is for.
     */
    tmpnam: (buf) => {
      const name = `/tmp/prism${String(++tmpSeq).padStart(6, '0')}`;
      const bytes = [...name].map(c => c.charCodeAt(0));
      if (buf) {
        for (let i = 0; i < bytes.length; i++) u8()[buf + i] = bytes[i];
        u8()[buf + bytes.length] = 0;
        return buf;
      }
      return M.mod.intern([...bytes, 0]);
    },
    system: () => -1,          // no shell; -1 is "the command could not be executed"

    setmntent: () => 0,
    getmntent: () => 0,
    endmntent: () => 0,
    msync: () => 0,
    chmod: () => 0,
    umask: () => 0,
    usleep: () => 0,
    sleep: () => 0,

    pread: (fd, dst, n, off) => {
      const h = fileOf(fd);
      if (!h) return -1;
      const start = Math.max(0, off | 0);
      const got = Math.max(0, Math.min(n | 0, h.bytes.length - start));
      M.u8.set(h.bytes.subarray(start, start + got), dst);
      return got;
    },
    pwrite: (fd, src, n, off) => {
      const h = fileOf(fd);
      if (!h) return -1;
      const start = Math.max(0, off | 0);
      grow(h, start + (n | 0));
      h.bytes.set(M.u8.slice(src, src + (n | 0)), start);
      return n | 0;
    },

    /*
     * mmap FAILS, deliberately. SQLite treats memory-mapped I/O as an optimisation and falls back to
     * read/write when the mapping is refused — which is a supported configuration, and far safer than
     * pretending a mapping is coherent with writes that go through a different path.
     */
    lseek: (fd, off, whence) => {
      const h = fileOf(fd);
      if (!h) return -1;
      const base = whence === SEEK_CUR ? h.pos : whence === SEEK_END ? h.bytes.length : 0;
      const p = base + (off | 0);
      if (p < 0) return -1;
      h.pos = p; h.eof = false;
      return p;
    },
    fsync: () => 0,
    fdatasync: () => 0,
    sysconf: () => 4096,          // the only value asked for here is the page size
    /*
     * A small environment. Not every program handles a NULL from getenv: Doom calls
     * `I_Error("Please set $HOME to your home directory")` and stops. HOME is the one variable a
     * UNIX program of this era assumes exists.
     */
    getenv: (namePtr) => {
      const name = M.mod.cstr(namePtr);
      const v = Object.prototype.hasOwnProperty.call(environment, name) ? environment[name] : null;
      if (v === null) return 0;
      if (!interned.has(name)) {
        interned.set(name, M.mod.intern([...enc.encode(v), 0]));
      }
      return interned.get(name);
    },
    setenv: (namePtr, valPtr) => { environment[M.mod.cstr(namePtr)] = M.mod.cstr(valPtr); interned.delete(M.mod.cstr(namePtr)); return 0; },
    /*
     * putenv takes ONE string, "NAME=value", and the POSIX version keeps the caller's storage rather
     * than copying it. Nothing here depends on that aliasing -- Quake II calls it once, on a buffer
     * it never touches again -- so this copies, and says so instead of implying otherwise.
     */
    putenv: (strPtr) => {
      const kv = M.mod.cstr(strPtr);
      const eq = kv.indexOf('=');
      if (eq < 0) { delete environment[kv]; interned.delete(kv); return 0; }
      const name = kv.slice(0, eq);
      environment[name] = kv.slice(eq + 1);
      interned.delete(name);
      return 0;
    },
    /*
     * A real calendar, filled into ONE static struct tm -- which is what localtime returns and why a
     * caller must copy before calling again.
     *
     * It used to return NULL, on the grounds that a caller must handle it and SQLite does. Then
     * OpenTyrian's xmas_time() wrote `localtime(&now)->tm_mon == 11` and dereferenced it, which is
     * ordinary C: localtime only returns NULL when the time cannot be represented. There is no time
     * zone here, so localtime and gmtime are the same function -- said rather than implied.
     */
    localtime: (tp) => {
      const secs = tp ? (M.mod.dv.getInt32(tp, true) >>> 0) : Math.floor(M.rt.time(0));
      if (!M.__tm) { M.__tm = M.rt.malloc(9 * 4); }
      const d = new Date(secs * 1000);
      const f = [d.getUTCSeconds(), d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(),
                 d.getUTCMonth(), d.getUTCFullYear() - 1900, d.getUTCDay(),
                 Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000) - 1, 0];
      for (let i = 0; i < 9; i++) M.mod.dv.setInt32(M.__tm + i * 4, f[i] | 0, true);
      return M.__tm;
    },
    gmtime: (tp) => api.localtime(tp),

    /*
     * User and group ids. There is one user here and it owns everything, so 0 is not a stand-in for
     * root -- it is the only id that exists. Quake II calls setreuid/setegid before dlopening its
     * game library, which on a real system drops the privileges of a setuid binary; there are none
     * to drop.
     */
    /*
     * sigaction. Nothing here raises a signal, so a handler is REMEMBERED and never called -- and
     * remembering it is what the caller checks: rw_x11.c fetches the current action, edits it and
     * installs it back, so a fetch that returned garbage would install garbage.
     */
    sigaction: (sig, act, old) => {
      const SIZE = 4 + 128 + 4 + 4;
      if (old) {
        const prev = signals.get(sig | 0);
        if (prev) M.u8.set(prev, old); else M.u8.fill(0, old, old + SIZE);
      }
      if (act) signals.set(sig | 0, M.u8.slice(act, act + SIZE));
      return 0;
    },
    sigemptyset: (set) => { M.u8.fill(0, set, set + 128); return 0; },
    sigfillset: (set) => { M.u8.fill(0xff, set, set + 128); return 0; },
    sigaddset: () => 0,

    getuid: () => 0, geteuid: () => 0, getgid: () => 0, getegid: () => 0,
    setuid: () => 0, seteuid: () => 0, setgid: () => 0, setegid: () => 0,
    setreuid: () => 0, setregid: () => 0,

    /*
     * ANONYMOUS mmap is memory, and a program of this era asks for memory that way when it wants a
     * lot of it at once. Quake II's Hunk_Begin (linux/q_shlinux.c:20) reserves 16 MB with
     * MAP_PRIVATE|MAP_ANONYMOUS and calls Sys_Error if it comes back -1, which is where a build with
     * this stubbed out stopped: 'unable to virtual allocate 16777216 bytes'.
     *
     * A FILE mapping still fails, and that is not laziness -- the file layer here has no address for
     * a file's contents to live at, and a caller that gets -1 for one has a read() path to fall back
     * on. SQLite takes exactly that path.
     */
    mmap: (_addr, length, _prot, _flags, fd, _off) => {
      if ((fd | 0) !== -1) return -1;                 // a file mapping, which this cannot serve
      const p = M.rt.malloc(length >>> 0);
      if (!p) return -1;
      M.u8.fill(0, p, p + (length >>> 0));            // an anonymous mapping reads as zeroes
      return p;
    },
    /*
     * mremap SHRINKING in place, which is the only use here: Hunk_End hands back everything the hunk
     * did not use and requires the base to be unchanged (`if (n != membase) Sys_Error`). Returning
     * the same pointer is therefore not a shortcut, it is the contract; the tail simply stays
     * allocated, which costs address space this host has and a real one did not.
     */
    mremap: (addr, _oldSize, _newSize, _flags) => addr,
    munmap: (addr) => { if (addr) M.rt.free(addr); return 0; },
    mprotect: () => 0,

    /*
     * Directories, derived rather than stored: the file table is a flat map of paths, so the entries
     * of a directory are the distinct first path components under its prefix. A name with more
     * separators after it contributes its SUBDIRECTORY name once, which is what a reader expects to
     * see and what Quake II's Sys_FindFirst walks to enumerate mods and save games.
     *
     * `struct dirent` here is d_name alone, at offset 0 -- see the dirent.h in src/env/headers.js.
     * The DIR handle is an index into a table on this side; the guest only ever passes it back.
     */
    opendir: (pathPtr) => {
      const want = norm(M.mod.cstr(pathPtr)).replace(/\/+$/, '');
      const prefix = want ? want + '/' : '';
      const names = new Set();
      for (const key of store.keys()) {
        if (prefix && !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        names.add(rest.split('/')[0]);
      }
      // A directory with no entries is still a directory IF something lives under it; a path that
      // matches nothing at all is not, and opendir must say so.
      if (!names.size) return 0;
      const h = dirs.length;
      dirs.push({ names: [...names].sort(), i: 0 });
      return DIR_BASE + h;
    },
    readdir: (handle) => {
      const d = dirs[(handle | 0) - DIR_BASE];
      if (!d || d.i >= d.names.length) return 0;
      const name = d.names[d.i++];
      // One reusable buffer per DIR, as a real readdir returns storage it owns.
      if (!d.buf) d.buf = M.rt.malloc(260);
      const bytes = enc.encode(name.slice(0, 255));
      M.u8.set(bytes, d.buf);
      M.u8[d.buf + bytes.length] = 0;
      return d.buf;
    },
    closedir: (handle) => {
      const d = dirs[(handle | 0) - DIR_BASE];
      if (d) { if (d.buf) M.rt.free(d.buf); dirs[(handle | 0) - DIR_BASE] = null; }
      return 0;
    },
  });

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
