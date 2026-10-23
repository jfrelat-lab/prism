// program-page.mjs — one program's own page, for tools/site.mjs: on the showcase (<id>/index.html) and
// as the index of a standalone folder (tools/standalone.mjs).
//
// The page plays the program IN PLACE: Play puts the player (web/?...&player=1&embed=1) in a frame where
// the picture was, its controls with it (Fullscreen among them). Its
// header depends on how the visitor came: from another page of the showcase, the showcase's own header;
// straight from a link (a forum post, a search), only the way to PRISM, so the page stands alone.
// Where its source lives is shown as a repository card; the stars and the description are asked of
// GitHub's or GitLab's API by the visitor's browser, and the card stands without them.

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PRISM_REPO = 'jfrelat-lab/prism';

/** Where a source URL points: a GitHub or GitLab repository (whose API has its stars), or a plain site. */
export function repoOf(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  const path = u.pathname.replace(/\/+$/, '').replace(/\.git$/, '').slice(1);
  if (u.host === 'github.com' && /^[^/]+\/[^/]+$/.test(path)) return { kind: 'github', name: path, href };
  if (/^gitlab\./.test(u.host) && path.split('/').length >= 2) return { kind: 'gitlab', host: u.host, name: path, href };
  return { kind: 'web', host: u.host, name: path ? `${u.host}/${path}` : u.host, href };
}

const BOOK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.71 1.71.75.75 0 0 1-1.07 1.05A2.5 2.5 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.71A2.5 2.5 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.09a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>';

function repoCard(r, role, star = false) {
  const api = r.kind === 'github' ? ` data-github="${esc(r.name)}"` : r.kind === 'gitlab' ? ` data-gitlab="${esc(r.host)}" data-path="${esc(r.name)}"` : '';
  const owner = r.kind === 'web' ? r.host : r.name.split('/').slice(0, -1).join('/');
  const repo = r.kind === 'web' ? r.name.slice(r.host.length + 1) || r.host : r.name.split('/').pop();
  // The name is the link, stretched over the card; a Star button sits above it (a link cannot hold a link).
  return `<div class="repo"${api}>
      <span class="repo-head">${BOOK}<a class="repo-name" href="${esc(r.href)}">${r.kind === 'web' && !r.name.includes('/') ? `<b>${esc(r.host)}</b>` : `${esc(owner)} / <b>${esc(repo)}</b>`}</a><span class="repo-role">${esc(role)}</span></span>
      <span class="repo-desc"></span>
      <span class="repo-foot"><span class="repo-host">${esc(r.kind === 'web' ? 'website' : r.kind === 'github' ? 'GitHub' : r.host)}</span>${star ? `<a class="starbtn" href="${esc(r.href)}" title="on GitHub: a star helps others find it">★ Star</a>` : ''}</span>
    </div>`;
}

/**
 * The page. `run` is the player's address relative to the export's root, `base` the way from the page
 * to that root; with `url` (its address on the showcase, under `origin`) it is a showcase page, with a
 * link preview and the showcase's header for a visitor who came from it.
 */
export function programPage(p, { run, base = '', url = null, origin = '', argsHint = null }) {
  const at = (h) => (/^[a-z][a-z0-9+.-]*:/i.test(h) ? h : base + h);
  const play = at(`${run}&player=1`);
  const thumb = typeof p.thumb === 'string' ? p.thumb : null;
  const li = (items) => items.map((x) => `<li>${x}</li>`).join('');
  const label = p.avail === 'play' ? 'Play' : 'Play with your files';
  const upstream = repoOf(p.code?.source ?? p.source);
  // A gallery entry ships no data and states no licence of its own: then the section is left out.
  const licences = [p.code?.license && `<p>Code: ${esc(p.code.license)}</p>`, p.data?.license && `<p>Data: ${esc(p.data.license)}</p>`,
    p.licences?.length && `<ul>${li(p.licences.map((l) => `<a href="${esc(at(l.href))}">${esc(l.name)}</a>`))}</ul>`,
    p.credits && `<p class="meta">${esc(p.credits)}</p>`].filter(Boolean).join('\n    ');
  const home = url ? base || './' : 'https://github.com/jfrelat-lab/prism';
  const preview = url ? `
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PRISM">
<meta property="og:title" content="${esc(p.title)}, in your browser">
<meta property="og:description" content="${esc(p.blurb)}">
<meta property="og:url" content="${esc(url)}">
${thumb ? `<meta property="og:image" content="${esc(`${origin}/${thumb}`)}">\n<meta property="og:image:alt" content="${esc(p.title)}, as PRISM draws it">\n` : ''}<meta name="twitter:card" content="${thumb ? 'summary_large_image' : 'summary'}">` : '';
  // The showcase's header, as index.html has it, for a visitor who came from one of its pages.
  const siteHeader = url ? `<header class="site">
  <a class="logo" href="${esc(home)}"><span>◢</span> PRISM</a>
  <nav>
    <a href="${base}#play">Play</a>
    <a href="${base}web/live/">Live C</a>
    <a href="${base}compare.html">Compared</a>
    <a href="${base}changes.html">What's new</a>
    <a href="https://github.com/jfrelat-lab/prism/tree/main/docs">Documentation</a>
    <a href="https://github.com/jfrelat-lab/prism">Source</a>
    <a class="star" href="https://github.com/jfrelat-lab/prism" title="PRISM on GitHub: a star helps others find it">★ Star on GitHub</a>
  </nav>
</header>
` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}${url ? ' in your browser — PRISM' : ''}</title>
<meta name="description" content="${esc(p.blurb)}">${preview}
<script>
  // From another page of the showcase: its header. From anywhere else: the page alone.
  try { if (document.referrer && new URL(document.referrer).origin === location.origin) document.documentElement.classList.add('from-site'); } catch {}
</script>
<style>
  :root { --bg: #0b0d11; --panel: #12161c; --line: #1f2630; --ink: #c3cbd6; --dim: #7a8594; --head: #edf1f6; --accent: #6cb6ff; --accent-ink: #061524; --warn: #c9a227;
          --spectrum: linear-gradient(90deg, #ff6b6b, #ffb35c, #ffe066, #7ee2a8, #6cb6ff, #9b8cff, #d38cff); }
  @media (prefers-color-scheme: light) { :root { --bg: #f4f6f9; --panel: #fff; --line: #d9dee6; --ink: #2b3440; --dim: #5f6b7a; --head: #0f1720; --accent: #1f6fd1; --accent-ink: #fff; } }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; padding: 12px 24px;
           background: var(--panel); border-bottom: 1px solid var(--line); position: relative; }
  header::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--spectrum); opacity: .85; }
  header .logo { color: var(--head); font: 700 15px ui-monospace, Menlo, monospace; letter-spacing: .18em; }
  header .logo span { color: var(--accent); }
  header nav { display: flex; flex-wrap: wrap; gap: 16px; margin-left: auto; font-size: 14px; }
  header a.star { font-size: 14px; }
  header nav a.star, header.solo a.star { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; }
  header.site { display: none; }
  .from-site header.site { display: flex; }
  .from-site header.solo { display: none; }
  header.solo .by { margin-left: auto; color: var(--dim); font-size: 13px; }
  main { max-width: 980px; margin: 0 auto; padding: 28px 24px 48px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
  .stage { position: relative; display: block; aspect-ratio: 4 / 3; max-height: 78vh; background: #000; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; cursor: pointer; padding: 0; width: 100%; }
  .stage img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; display: block; }
  .stage .go { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 12px 26px; border-radius: 999px;
               background: color-mix(in srgb, var(--accent) 92%, transparent); color: var(--accent-ink); font: 600 17px system-ui, sans-serif; box-shadow: 0 4px 24px #0008; }
  .stage:hover .go { filter: brightness(1.1); }
  .stage.on { aspect-ratio: auto; height: min(78vh, calc((min(100vw, 980px) - 48px) * .75 + 46px)); max-height: none; cursor: auto; }
  .stage iframe { display: block; width: 100%; height: 100%; border: 0; }
  .title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; }
  h1 { margin: 0; font-size: 28px; color: var(--head); text-wrap: balance; }
  .meta { color: var(--dim); }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
  .play { padding: 9px 22px; border-radius: 6px; border: 0; background: var(--accent); color: var(--accent-ink); font: 600 16px system-ui, sans-serif; cursor: pointer; }
  .play:hover { text-decoration: none; filter: brightness(1.1); }
  .more { display: grid; gap: 8px; }
  details { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; }
  summary { cursor: pointer; color: var(--head); font-weight: 600; font-size: 14px; }
  details[open] summary { margin-bottom: 8px; }
  #argsForm { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
  #argsForm input { flex: 1 1 260px; min-width: 0; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); font: 13px ui-monospace, Menlo, monospace; }
  #argsForm button { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent); background: none; color: var(--accent); font: 600 14px system-ui, sans-serif; cursor: pointer; }
  #log { margin: 0; max-height: 320px; overflow: auto; font: 12px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dim); }
  .nudge { margin: 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .nudge a { font-weight: 600; }
  .lede { margin: 0; max-width: 68ch; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  h2 { margin: 0 0 10px; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  ul { margin: 0; padding-left: 18px; } p { margin: 0 0 6px; }
  .caution { border-color: var(--warn); }
  .repos { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .repo { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); background: var(--bg); }
  .repo:hover, .repo:focus-within { border-color: var(--accent); }
  .repo-name::after { content: ""; position: absolute; inset: 0; border-radius: 6px; }
  .repo-name:hover { text-decoration: none; }
  .starbtn { position: relative; z-index: 1; margin-left: auto; padding: 1px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--head); font-weight: 600; }
  .starbtn:hover { text-decoration: none; border-color: var(--accent); }
  .repo-head { display: flex; align-items: center; gap: 8px; }
  .repo-head svg { width: 16px; height: 16px; fill: var(--dim); flex: none; }
  .repo-name { color: var(--accent); overflow-wrap: anywhere; } .repo-name b { font-weight: 600; }
  .repo-role { margin-left: auto; font-size: 11.5px; color: var(--dim); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; white-space: nowrap; }
  .repo-desc { font-size: 13px; color: var(--dim); }
  .repo-desc:empty { display: none; }
  .repo-foot { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12.5px; color: var(--dim); font-variant-numeric: tabular-nums; }
  .repo-foot .lang::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--dot, var(--dim)); margin-right: 5px; vertical-align: -1px; }
  footer { color: var(--dim); font-size: 13px; }
  @media (max-width: 560px) { header { padding: 10px 16px; } header nav { margin-left: 0; } main { padding: 20px 16px 40px; } }
</style>
</head>
<body>
${siteHeader}<header class="solo">
  <a class="logo" href="${esc(home)}"><span>◢</span> PRISM</a>
  <span class="by">C and C++ compiled to JavaScript, in the page</span>
  <a class="star" href="https://github.com/${PRISM_REPO}" title="PRISM on GitHub: a star helps others find it">★ Star on GitHub</a>
</header>
<main>
  <button class="stage" type="button" id="stage" aria-label="${esc(label)}: ${esc(p.title)}">${thumb ? `<img src="${esc(at(thumb))}" alt="${esc(p.title)}, as PRISM draws it">` : ''}<span class="go">▶ ${esc(label)}</span></button>
  <div class="title">
    <h1>${esc(p.title)}</h1>
    <span class="meta">${esc(p.author)}${p.year ? `, ${esc(p.year)}` : ''} · ${esc(p.kind)}</span>
  </div>
  <p class="lede">${esc(p.blurb)}</p>
  <p class="nudge" id="nudge" hidden>${esc(p.title)} runs on PRISM, a C and C++ compiler written in plain JavaScript. <a href="https://github.com/${PRISM_REPO}">★ Star it on GitHub</a> if you liked seeing it here.</p>
  <div class="actions">
    <button class="play" type="button" id="play">${esc(label)}</button>
  </div>
  <div class="more">
    <details>
      <summary>Arguments</summary>
      <form id="argsForm">
        <input id="args" name="args" type="text" spellcheck="false" autocomplete="off" value="${esc(p.args ?? '')}" aria-label="Arguments passed to the program">
        <button type="submit">Run with these</button>
      </form>
      ${argsHint ? `<p class="meta">${esc(argsHint)}</p>` : ''}
      <p class="meta">They go in this page's address, so a link to it starts the program the same way.</p>
    </details>
    <details id="logbox">
      <summary>PRISM's log</summary>
      <pre id="log">What PRISM says while it runs the program shows here once it is playing.</pre>
    </details>
  </div>
  ${p.avail === 'files' ? `<p class="meta" id="needs">Needs ${esc(p.needs)}${p.get ? ` (from <a href="${esc(p.get.href)}">${esc(p.get.label)}</a>)` : ''}: the page asks for your copy, a folder or a .zip, and reads it where it is; nothing is uploaded.</p>` : ''}
  <p class="meta">It needs a keyboard, and most games take the mouse too.</p>
  ${p.caution ? `<section class="caution"><h2>⚠️ Licence</h2><p>${esc(p.caution)}</p></section>` : ''}
  <section>
    <h2>Source</h2>
    <div class="repos">
      ${upstream ? repoCard(upstream, 'the program') : ''}
      ${repoCard(repoOf(`https://github.com/${PRISM_REPO}`), 'the compiler', true)}
    </div>
    <p class="meta">The archives this build was made from, unmodified:</p>
    <ul>${li((p.sources ?? []).map((a) => `<a href="${esc(at(a.href))}" download>${esc(a.name)}</a> <span class="meta">${(a.bytes / 1048576).toFixed(1)} MB</span>`))}</ul>
    <p class="meta"><a href="${base}sources/README.txt">What these archives are</a> · <a href="${base}sources/SHA256SUMS">checksums</a></p>
  </section>
  ${licences ? `<section>
    <h2>Licences</h2>
    ${licences}
  </section>` : ''}
  <footer>Compiled from its unmodified source to JavaScript by <a href="https://github.com/jfrelat-lab/prism">PRISM</a>, and run in this page.</footer>
</main>
<script>
  // Play here: the player in a frame where the picture was, with its own controls (web/?...&embed=1).
  const PLAYER = ${JSON.stringify(play)};
  const QUERY = new URLSearchParams(location.search);
  const stage = document.getElementById('stage');
  function start() {
    if (stage.classList.contains('on')) return;
    const f = document.createElement('iframe');
    // The arguments: this page's ?args= when it has one, else the program's own (web/app.js adds the
    // build's required flags at Run).
    const u = new URL(PLAYER, location.href);
    if (QUERY.has('args')) u.searchParams.set('args', QUERY.get('args'));
    u.searchParams.set('embed', '1');
    f.src = u.href;
    f.title = ${JSON.stringify(p.title)};
    f.allow = 'cross-origin-isolated; fullscreen; autoplay; gamepad; clipboard-write';
    const box = document.createElement('div');
    box.className = 'stage on'; box.id = 'stage'; box.append(f);
    stage.replaceWith(box);
    document.getElementById('play').hidden = true;
    document.getElementById('nudge').hidden = false;
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    f.addEventListener('load', () => { f.focus(); mirrorLog(f); });
  }
  stage.addEventListener('click', start);
  /*
   * A LOCAL LIBRARY (tools/serve.mjs --site --games=<dir>), as the catalogue reads it: the game is the
   * visitor's when the root the server holds lists the file that shows a copy is there. Then Play is
   * "Play your copy". Elsewhere __library.json does not exist and nothing changes.
   */
  const DATA = ${JSON.stringify(p.avail === 'files' && p.data?.need ? p.data : null)};
  if (DATA) (async () => {
    const lib = await fetch(${JSON.stringify(base)} + '__library.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!lib?.roots?.includes(DATA.root)) return;
    const list = await fetch(${JSON.stringify(base)} + '__static/data/' + encodeURIComponent(DATA.root) + '.json').then((r) => r.json()).catch(() => null);
    if (!list?.files?.map((x) => x.toLowerCase()).includes((DATA.under + DATA.need).toLowerCase())) return;
    for (const el of [document.getElementById('play'), stage.querySelector('.go')]) if (el) el.textContent = (el.classList.contains('go') ? '▶ ' : '') + 'Play your copy';
    stage.setAttribute('aria-label', 'Play your copy: ' + ${JSON.stringify(p.title)});
    const needs = document.getElementById('needs');
    if (needs) needs.textContent = 'Runs on your own copy, from the library folder this server was started with: it is yours, not shipped by this site.';
  })();

  // ?play=1: the catalogue's Play, so the program starts with the page.
  if (QUERY.get('play') === '1') start();

  // Arguments: written into this page's address, which then reloads playing them.
  const argsIn = document.getElementById('args');
  if (QUERY.has('args')) { argsIn.value = QUERY.get('args'); argsIn.closest('details').open = true; }
  document.getElementById('argsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    QUERY.set('args', argsIn.value.trim()); QUERY.set('play', '1');
    location.search = QUERY.toString();
  });

  // PRISM's log: the player's own (#log, same origin), mirrored as it grows.
  function mirrorLog(f) {
    const src = f.contentDocument?.getElementById('log'), out = document.getElementById('log');
    if (!src) return;
    const copy = () => { out.textContent = [...src.querySelectorAll('.line')].map((l) => l.textContent).join('\\n'); out.scrollTop = out.scrollHeight; };
    new MutationObserver(copy).observe(src, { childList: true, subtree: true, characterData: true });
    copy();
  }
  document.getElementById('play').addEventListener('click', start);

  // The repository cards: stars and the rest from the host's API, kept for the visit.
  const LANG = { C: '#555555', 'C++': '#f34b7d', JavaScript: '#f1e05a', Lua: '#000080', Assembly: '#6e4c13', Pascal: '#e3f171' };
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
  async function stats(card) {
    const gh = card.dataset.github, gl = card.dataset.gitlab;
    const api = gh ? 'https://api.github.com/repos/' + gh : 'https://' + gl + '/api/v4/projects/' + encodeURIComponent(card.dataset.path);
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(api)); } catch {}
    if (!s) {
      const r = await fetch(api, { headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const j = await r.json();
      s = gh ? { desc: j.description, stars: j.stargazers_count, forks: j.forks_count, lang: j.language }
             : { desc: j.description, stars: j.star_count, forks: j.forks_count, lang: null };
      try { sessionStorage.setItem(api, JSON.stringify(s)); } catch {}
    }
    if (s.desc) card.querySelector('.repo-desc').textContent = s.desc;
    const foot = card.querySelector('.repo-foot');
    const add = (cls, text, dot) => { const e = document.createElement('span'); e.className = cls; e.textContent = text; if (dot) e.style.setProperty('--dot', dot); foot.prepend(e); };
    if (s.forks != null) add('forks', '⑂ ' + fmt(s.forks));
    if (s.stars != null) add('stars', '★ ' + fmt(s.stars));
    if (s.lang) add('lang', s.lang, LANG[s.lang]);
  }
  for (const c of document.querySelectorAll('.repo[data-github], .repo[data-gitlab]')) stats(c).catch(() => {});
</script>
</body>
</html>
`;
}
