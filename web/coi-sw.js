// coi-sw.js — the COOP/COEP headers a static host does not send, added by a service worker.
// Registered by coi.js from web/index.html and web/live/index.html; its scope is web/, both pages.
//
// Live C needs SharedArrayBuffer (stdin: prog.run() never returns, so a keystroke must reach the
// worker through shared memory), and SharedArrayBuffer needs a cross-origin-isolated page.
// tools/serve.mjs sends the two headers itself; GitHub Pages cannot be told to. This worker sits
// between the page and the network and adds them to every response, which is what makes the page
// isolated on its second load (coi.js reloads it once). Same-origin only: Live C fetches nothing
// from anywhere else, and require-corp would refuse a cross-origin resource that does not opt in.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  /*
   * Only this origin's own answers are given the isolation headers. Another site's -- Live C fetches
   * Rosetta Code's solutions from rosettacode.org -- are left to the browser: rewritten here, a CORS
   * response came back rebuilt by this worker and stamped CORP same-origin, which claims the other
   * site said "only I may read this". It did not, and nothing here is entitled to say it for it.
   */
  if (new URL(req.url).origin !== self.location.origin) return;
  // A request the browser makes against the cache only, from another origin, cannot be re-fetched.
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith(fetch(req).then((res) => {
    if (res.status === 0) return res; // opaque: nothing to add, and nothing readable
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }));
});
