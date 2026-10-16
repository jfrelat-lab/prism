// Without a file system, Emscripten's fd_write hands stdout to console.log a line at a time and takes
// every NUL byte for a line end: binary output (mandelbrot's PBM) comes out garbled, at one call per
// "line". This replaces that import with one writing the bytes to the real fd as they are.
Module.instantiateWasm = (info, receive) => {
  const fs = require('fs');
  let memory;
  info.env.fd_write = info.wasi_snapshot_preview1.fd_write = (fd, iov, iovcnt, pnum) => {
    const u32 = new Uint32Array(memory.buffer);
    let num = 0;
    for (let i = 0; i < iovcnt; i++, iov += 8) {
      const ptr = u32[iov >> 2], len = u32[(iov + 4) >> 2];
      for (let off = 0; off < len;) off += fs.writeSync(fd, new Uint8Array(memory.buffer, ptr + off, len - off));
      num += len;
    }
    u32[pnum >> 2] = num;
    return 0;
  };
  WebAssembly.instantiate(fs.readFileSync(__filename.replace(/\.js$/, '.wasm')), info).then(({ instance }) => {
    memory = instance.exports.memory;
    receive(instance);
  });
  return {};
};
