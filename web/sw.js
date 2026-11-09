// Lets the website open with no signal. Pages and the app's own files come from
// the network first, so a release shows straight away; the copies here are for
// when that fails, or when the page takes over WAIT_MS on a weak signal: then the
// saved page opens, and the network's answer still updates it for next time.
// Anything not named below passes straight through, so rates never land here.
// Registered by pwa.js, never in the Android app.
const CACHE = 'bureau-2';
const WAIT_MS = 3000;
const at = file => new URL(file, location).href;
const INDEX = at('index.html');
const FILES = ['index.html', 'lib.js', 'pwa.js', 'fonts/hanken-grotesk-latin.woff2', 'fonts/hanken-grotesk-latin-ext.woff2'].map(at);

addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => skipWaiting()));
});

addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => clients.claim()));
});

// When the page on screen came from the saved copy (0 if from the network). Its
// files then come from the saved copies too, so a new page never runs an old
// lib.js, nor an old page a new one.
let pageSavedAt = 0;

addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.pathname === '/' ? INDEX : url.href;
  if (!FILES.includes(key)) return;
  const isPage = key === INDEX;
  const network = fetch(request);
  // Kept whichever answer the page gets; cloned at once, before the page reads it.
  e.waitUntil(network.then(res => {
    if (!res.ok) return;
    const copy = res.clone();
    return caches.open(CACHE).then(cache => cache.put(key, copy));
  }).catch(() => {}));
  e.respondWith(new Promise(resolve => {
    let done = false;
    const answer = (res, saved) => {
      if (!res || done) return;
      done = true;
      if (isPage) pageSavedAt = saved ? Date.now() : 0;
      resolve(res);
    };
    const saved = () => caches.match(key).catch(() => undefined);
    const useSaved = () => saved().then(hit => answer(hit, true));
    network.then(res => answer(res, false), () => saved().then(hit => answer(hit || Response.error(), !!hit)));
    if (isPage) setTimeout(useSaved, WAIT_MS);   // with no saved copy, the network gets as long as it needs
    else if (Date.now() - pageSavedAt < 10_000) useSaved();
  }));
});
