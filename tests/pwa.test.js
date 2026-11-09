// The website as a home screen app: the manifest, icons, service worker and hint.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '../web');
const read = file => fs.readFileSync(path.join(WEB, file));
const NAME = 'Bureau';
const PASS_THROUGH = ['https://api.coinbase.com/v2/exchange-rates?currency=USD', 'https://open.er-api.com/v6/latest/USD', 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json', 'https://api.frankfurter.dev/v1/latest', 'https://bureau.teloone.au/app', 'https://bureau.teloone.au/manifest.json'];
const KEPT = ['lib.js?v=4', 'pwa.js', 'fonts/hanken-grotesk-latin.woff2'];

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1';
const FIREFOX_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15';
const IN_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0]';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
const WEBVIEW = 'Mozilla/5.0 (Linux; Android 15; SM-S938B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.0.0 Mobile Safari/537.36';

function pngInfo(file) {
  const b = read(file);
  assert.equal(b.toString('latin1', 1, 4), 'PNG', file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

// pwa.js as a page would run it, with what it touches faked.
function runPwa({ hostname = 'bureau.teloone.au', ua = SAFARI, standalone = false, seen = false }) {
  const calls = { register: [] };
  const hint = { hidden: true, querySelector: () => ({ addEventListener() {} }) };
  const values = seen ? { 'bureau.installHint': '1' } : {};
  const root = {
    URL,
    location: { hostname },
    navigator: { userAgent: ua, standalone, serviceWorker: { register: url => { calls.register.push(url); return Promise.resolve(); } } },
    document: { currentScript: { src: `https://${hostname}/pwa.js` }, getElementById: () => hint },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: k => values[k] || null, setItem: (k, v) => { values[k] = v; } },
  };
  vm.runInNewContext(read('pwa.js').toString(), root);
  return { calls, hint };
}

// sw.js with its events caught, to see what it would answer. `net` stands in
// for the network, `saved` for what the cache holds; timers run only when told.
function loadSw({ net = async () => new Response(''), saved = {} } = {}) {
  const on = {}, timers = [], kept = [];
  const scope = {
    addEventListener: (type, fn) => { on[type] = fn; }, location: new URL('https://bureau.teloone.au/sw.js'), URL, Response, console, Promise,
    fetch: net, setTimeout: (fn, ms) => timers.push({ fn, ms }),
    caches: { open: async () => ({ put: async key => { kept.push(key); } }), match: async key => saved[key] },
  };
  vm.runInNewContext(read('sw.js').toString(), scope);
  const respond = request => {
    let response = null;
    const waits = [];
    on.fetch({ request: { method: 'GET', mode: 'cors', ...request }, respondWith(p) { response = p; }, waitUntil(p) { waits.push(p); } });
    return { response, waits };
  };
  const answers = request => respond(request).response !== null;
  return Object.assign(answers, { respond, timers, kept });
}

test('the manifest is complete and has no host in it', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.name, NAME);
  assert.equal(m.short_name, NAME);
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.match(m.theme_color, /^#[0-9A-F]{6}$/);
  assert.match(m.background_color, /^#[0-9A-F]{6}$/);
  assert.doesNotMatch(read('manifest.json').toString(), /https?:/);
  for (const size of [192, 512]) for (const purpose of ['any', 'maskable']) {
    const icon = m.icons.find(i => i.sizes === `${size}x${size}` && i.purpose === purpose);
    assert.ok(icon, `${size} ${purpose}`);
    const png = pngInfo(icon.src);
    assert.deepEqual([png.width, png.height], [size, size]);
  }
});

test('the iPhone icon is 180px with no transparency', () => {
  assert.deepEqual(pngInfo('icons/apple-touch-icon.png'), { width: 180, height: 180, colorType: 2 });
});

test('only Safari on an iPhone counts as Safari on an iPhone', () => {
  const { iphoneSafari } = require('../web/pwa.js');
  assert.equal(iphoneSafari(SAFARI), true);
  for (const ua of [CHROME_IOS, FIREFOX_IOS, IN_APP, CHROME_ANDROID, WEBVIEW]) assert.equal(iphoneSafari(ua), false, ua);
});

test('the hint shows once, in Safari on an iPhone', () => {
  assert.equal(runPwa({}).hint.hidden, false);
  assert.equal(runPwa({ seen: true }).hint.hidden, true);
  assert.equal(runPwa({ standalone: true }).hint.hidden, true);
  assert.equal(runPwa({ ua: CHROME_ANDROID }).hint.hidden, true);
  assert.equal(runPwa({ ua: CHROME_IOS }).hint.hidden, true);
});

test('nothing runs in the Android app', () => {
  const { calls, hint } = runPwa({ hostname: 'appassets.androidplatform.net', ua: WEBVIEW });
  assert.equal(calls.register.length, 0);
  assert.equal(hint.hidden, true);
});

test('the website registers its service worker from the top', () => {
  assert.deepEqual(runPwa({ ua: CHROME_ANDROID }).calls.register, ['https://bureau.teloone.au/sw.js']);
});

test('the service worker leaves data alone', () => {
  const answers = loadSw();
  for (const url of PASS_THROUGH) assert.equal(answers({ url }), false, url);
  for (const url of PASS_THROUGH) assert.equal(answers({ url, mode: 'navigate' }), false, url);
  assert.equal(answers({ url: 'https://bureau.teloone.au/index.html', method: 'POST' }), false);
});

test('the service worker answers for the app itself', () => {
  const answers = loadSw();
  assert.equal(answers({ url: 'https://bureau.teloone.au/', mode: 'navigate' }), true);
  for (const url of KEPT) assert.equal(answers({ url: `https://bureau.teloone.au/${url}` }), true, url);
});

const INDEX_URL = 'https://bureau.teloone.au/index.html';
const tick = () => new Promise(r => setImmediate(r));

test('a slow network gets the saved copy after 3 s, and still updates it', async () => {
  let arrive;
  const sw = loadSw({ net: () => new Promise(r => { arrive = r; }), saved: { [INDEX_URL]: new Response('saved') } });
  const { response, waits } = sw.respond({ url: 'https://bureau.teloone.au/', mode: 'navigate' });
  assert.deepEqual(sw.timers.map(t => t.ms), [3000]);
  sw.timers[0].fn();
  assert.equal(await (await response).text(), 'saved');
  arrive(new Response('new'));
  await Promise.all(waits);
  assert.deepEqual(sw.kept, [INDEX_URL]);
});

test('a network that answers in time wins', async () => {
  const sw = loadSw({ net: async () => new Response('new'), saved: { [INDEX_URL]: new Response('saved') } });
  const { response } = sw.respond({ url: INDEX_URL });
  assert.equal(await (await response).text(), 'new');
  sw.timers[0].fn();
  await tick();
});

test('with nothing saved, a slow network is waited for', async () => {
  let arrive;
  const sw = loadSw({ net: () => new Promise(r => { arrive = r; }) });
  const { response } = sw.respond({ url: INDEX_URL });
  let settled = false;
  response.then(() => { settled = true; });
  sw.timers[0].fn();
  await tick();
  assert.equal(settled, false);
  arrive(new Response('new'));
  assert.equal(await (await response).text(), 'new');
});

test('no signal opens the saved copy at once, and nothing at all is an error', async () => {
  const offline = async () => { throw new TypeError('offline'); };
  const sw = loadSw({ net: offline, saved: { [INDEX_URL]: new Response('saved') } });
  assert.equal(await (await sw.respond({ url: INDEX_URL }).response).text(), 'saved');
  const empty = loadSw({ net: offline });
  assert.equal((await empty.respond({ url: INDEX_URL }).response).type, 'error');
});

test('a versioned file answers from its saved copy, unless the page asks afresh', async () => {
  const LIB = 'https://bureau.teloone.au/lib.js?v=4';
  let calls = 0;
  const sw = loadSw({ net: async () => { calls++; return new Response('network lib'); }, saved: { [LIB]: new Response('saved lib') } });
  assert.equal(await (await sw.respond({ url: LIB }).response).text(), 'saved lib');
  assert.equal(calls, 0);
  assert.equal(sw.timers.length, 0);
  // The page found a mismatched lib.js and asks past the saved copy, which the answer replaces.
  const { response, waits } = sw.respond({ url: LIB, cache: 'reload' });
  assert.equal(await (await response).text(), 'network lib');
  await Promise.all(waits);
  assert.deepEqual(sw.kept, [LIB]);
  // A version not saved yet waits for the network, however long.
  const other = loadSw({ net: async () => new Response('v4') });
  assert.equal(await (await other.respond({ url: 'https://bureau.teloone.au/lib.js?v=4' }).response).text(), 'v4');
  assert.equal(other.timers.length, 0);
});

test('lib.js, the page and the service worker name one version', () => {
  const { VERSION } = require('../web/lib.js');
  const page = read('index.html').toString();
  assert.ok(page.includes(`<script src="lib.js?v=${VERSION}"></script>`));
  assert.ok(page.includes(`const LIB = ${VERSION};`));
  assert.ok(read('sw.js').toString().includes(`'lib.js?v=${VERSION}'`));
});

test('every file the service worker keeps exists', () => {
  const listed = read('sw.js').toString().match(/^const (?:FILES|SHELL) = \[(.*)\]/m)[1].match(/'[^']+'/g).map(s => s.slice(1, -1));
  assert.ok(listed.includes('index.html'));
  for (const file of listed) assert.ok(fs.existsSync(path.join(WEB, file.split('?')[0])), file);
  const page = read('index.html').toString();
  for (const [, font] of page.matchAll(/url\("(fonts\/[^"]+)"\)/g)) assert.ok(listed.includes(font), font);
});

test('the page has the home screen tags', () => {
  const page = read('index.html').toString();
  assert.match(page, /<link rel="manifest" href="manifest\.json">/);
  assert.match(page, /<link rel="apple-touch-icon" sizes="180x180" href="icons\/apple-touch-icon\.png">/);
  assert.match(page, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(page, /name="apple-mobile-web-app-status-bar-style" content="default"/);
  assert.match(page, new RegExp(`name="apple-mobile-web-app-title" content="${NAME}"`));
  assert.match(page, /theme-color[^>]*prefers-color-scheme: light/);
  assert.match(page, /theme-color[^>]*prefers-color-scheme: dark/);
  assert.match(page, /viewport-fit=cover/);
  assert.match(page, /<script src="pwa\.js"><\/script>/);
});

const loadWorker = () => import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../worker/worker.js')).toString('base64')).then(m => m.default);

test('the Worker serves the manifest, icons, service worker and scripts', async t => {
  const worker = await loadWorker();
  t.mock.method(globalThis, 'fetch', async url => {
    const file = path.join(WEB, new URL(url).pathname.split('/web/')[1]);
    return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('', { status: 404 });
  });
  const types = {
    'manifest.json': 'application/json', 'sw.js': 'text/javascript; charset=utf-8', 'pwa.js': 'text/javascript; charset=utf-8',
    'icons/icon-192.png': 'image/png', 'icons/icon-512.png': 'image/png', 'icons/maskable-192.png': 'image/png', 'icons/maskable-512.png': 'image/png',
    'icons/apple-touch-icon.png': 'image/png',
  };
  for (const [file, type] of Object.entries(types)) {
    const res = await worker.fetch(new Request(`https://bureau.teloone.au/${file}`), {});
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get('Content-Type'), type, file);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), read(file), file);
  }
});

test('/app goes to the APK', async () => {
  const worker = await loadWorker();
  const res = await worker.fetch(new Request('https://bureau.teloone.au/app'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://raw.githubusercontent.com/matisseduffield/bureau-releases/main/Bureau.apk');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('the page comes from bureau-releases, and only the page', async t => {
  const worker = await loadWorker();
  const seen = [];
  t.mock.method(globalThis, 'fetch', async url => { seen.push(url); return new Response('<html>'); });
  const page = await worker.fetch(new Request('https://bureau.teloone.au/'));
  assert.equal(page.headers.get('Cache-Control'), 'no-cache');
  assert.equal(page.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal((await worker.fetch(new Request('https://bureau.teloone.au/fonts/hanken-grotesk-latin.woff2'))).headers.get('Cache-Control'), 'public, max-age=604800');
  assert.deepEqual(seen, ['https://raw.githubusercontent.com/matisseduffield/bureau-releases/main/web/index.html', 'https://raw.githubusercontent.com/matisseduffield/bureau-releases/main/web/fonts/hanken-grotesk-latin.woff2']);
  for (const bad of ['/x.apk', '/.env', '/rates']) assert.equal((await worker.fetch(new Request('https://bureau.teloone.au' + bad))).status, 404, bad);
  assert.equal(seen.length, 2);
  assert.equal((await worker.fetch(new Request('https://bureau.teloone.au/', { method: 'POST' }))).status, 405);
});

test('a versioned file is fetched and kept per version', async t => {
  const worker = await loadWorker();
  const seen = [];
  t.mock.method(globalThis, 'fetch', async url => { seen.push(url); return new Response('x'); });
  const lib = await worker.fetch(new Request('https://bureau.teloone.au/lib.js?v=2'));
  assert.equal(lib.headers.get('Cache-Control'), 'public, max-age=604800');
  const plain = await worker.fetch(new Request('https://bureau.teloone.au/lib.js?x=1'));
  assert.equal(plain.headers.get('Cache-Control'), 'public, max-age=60');
  assert.deepEqual(seen, ['https://raw.githubusercontent.com/matisseduffield/bureau-releases/main/web/lib.js?v=2', 'https://raw.githubusercontent.com/matisseduffield/bureau-releases/main/web/lib.js']);
});

test('a release publishes the website', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8'), /cp -r web pub\/web/);
});

test('the app-only controls start hidden, and only the bridge shows them', () => {
  const page = read('index.html').toString();
  assert.match(page, /<button[^>]*id="alertBtn"[^>]*hidden/);
  assert.match(page, /<button[^>]*id="version"[^>]*hidden|id="version"[^>]*hidden/);
  assert.match(page, /id="updateCard"[^>]*hidden/);
  assert.match(page, /href="https:\/\/www\.exchangerate-api\.com"/);
  assert.match(page, /href="https:\/\/teloone\.au\/apps\/bureau\/privacy\/"/);
});
