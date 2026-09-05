// A tiny TCP server for the PuTTY test: greets, then echoes PRINTABLE input in upper case.
// Echoing everything sent back telnet negotiation bytes, which are not UTF-8 and filled PuTTY's
// screen with replacement characters -- the server's fault, not the terminal's.
import net from 'node:net';
const srv = net.createServer((c) => {
  c.write('Hello from PRISM\r\n$ ');
  c.on('data', (b) => {
    const clean = [...b].filter((x) => x >= 32 && x < 127);
    if (clean.length) c.write(Buffer.from(clean).toString().toUpperCase());
  });
});
srv.listen(0, '127.0.0.1', () => { console.log(srv.address().port); });
