// Network-first app shell cache: updates are picked up immediately when
// online, and the app still boots offline. Model weights are cached by
// transformers.js itself via the browser Cache API.
const VERSION = 'cue-v29';
const SHELL = [
  '.',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'demo-script.md',
  'icons/icon.svg',
  'js/app.js',
  'js/perf.js',
  'js/md.js',
  'js/matcher.js',
  'js/prompter.js',
  'js/audio.js',
  'js/worklet.js',
  'js/asr-worker.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // /hf/ model downloads are cached by transformers.js itself; keep the
  // multi-MB weights out of the app shell cache
  if (
    e.request.method !== 'GET' ||
    url.origin !== location.origin ||
    url.pathname.startsWith('/hf/')
  )
    return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
