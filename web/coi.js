// coi.js — make this page cross-origin isolated on a host that does not send COOP/COEP (GitHub Pages).
//
// A classic script, run before the page's module (web/app.js, web/live/live.js): it registers
// coi-sw.js and reloads once, after which the worker is in control and adds the headers. Under
// tools/serve.mjs the page is already isolated and this does nothing. If the reload did not help
// (service workers disabled, a private window that refuses them), it stops there rather than
// reloading for ever; the page then says SharedArrayBuffer is missing.
(() => {
  if (window.crossOriginIsolated || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  const KEY = 'prism-coi-reloaded';
  let reloaded = false;
  try { reloaded = sessionStorage.getItem(KEY) === '1'; } catch { /* storage refused: try once anyway */ }
  navigator.serviceWorker.register(new URL('./coi-sw.js', document.currentScript.src)).then(() => {
    if (navigator.serviceWorker.controller || reloaded) return;
    try { sessionStorage.setItem(KEY, '1'); } catch { /* no storage: the controller check still ends it */ }
    navigator.serviceWorker.ready.then(() => location.reload());
  }).catch(() => { /* live.js reports the missing SharedArrayBuffer */ });
})();
