// Bureau on the web: a Cloudflare Worker named `bureau`, no bindings.
//
//   GET  /, /lib.js, ...   the page, served from the public bureau-releases repo,
//                          where every release publishes web/
//   GET  /app              the latest Android app (a redirect to the APK)
//
// Rates don't come through here: the page calls the rate services itself.
// Deployed by hand (see README).

const RELEASES = 'https://raw.githubusercontent.com/matisseduffield/bureau-releases/main/';
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', woff2: 'font/woff2', png: 'image/png', txt: 'text/plain; charset=utf-8' };
const HEADERS = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: HEADERS });
    const url = new URL(request.url);
    if (url.pathname === '/app') return new Response(null, { status: 302, headers: { Location: `${RELEASES}Bureau.apk`, 'Cache-Control': 'no-store', ...HEADERS } });
    const file = url.pathname.replace(/^\/+/, '').replace(/(^|\/)$/, '$1index.html');
    if (!/^[a-z0-9-]+(\/[a-zA-Z0-9.-]+)*\.(html|js|json|woff2|png|txt)$/.test(file)) return new Response('Not found', { status: 404, headers: HEADERS });
    // A ?v= file never changes, so it can sit in the browser for a week. The
    // version goes upstream too, so the edge keeps a copy per version: an edge
    // copy of the last release's lib.js can't answer for this one's.
    const version = /^\?v=\d+$/.test(url.search) ? url.search : '';
    const res = await fetch(`${RELEASES}web/${file}${version}`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) return new Response('Not found', { status: 404, headers: HEADERS });
    const cache = file.endsWith('.html') ? 'no-cache' : version || file.endsWith('.woff2') ? 'public, max-age=604800' : 'public, max-age=60';
    return new Response(res.body, { headers: { 'Content-Type': TYPES[file.split('.').pop()], 'Cache-Control': cache, ...HEADERS } });
  },
};
